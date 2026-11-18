#!/usr/bin/env node
// 记忆检索评测：召回 / 隐私隔离 / 长度上限 / 实体加权。
//
// 为什么不靠人工标注：真实聊天没有 ground truth。这里用「自召回」——
// 拿库里一条真实消息当查询，看检索能不能把它自己找回来，
// 再用「隐私越权」「长度超限」这类硬约束兜住不能出错的部分。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openMessageDb, searchMessages } from '../src/message-db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = path.join(ROOT, 'state/messages.db');
const CTX_FILE = path.join(ROOT, 'src/bridge/context-services.js');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✔ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};

if (!fs.existsSync(DB_FILE)) {
  console.log('跳过：没有 state/messages.db（还没跑过桥接）');
  process.exit(0);
}

const db = openMessageDb(DB_FILE);
const imp = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'state/impressions.json'), 'utf8')); } catch { return { people: {} }; } })();
const social = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'state/social-v2.json'), 'utf8')); } catch { return {}; } })();

// 抽出 withMemoryContext（@bridge-function 块），去掉 deps. 前缀后用 vm 跑
const src = fs.readFileSync(CTX_FILE, 'utf8').replace(/^export /gm, '');
const start = src.indexOf('// @bridge-function withMemoryContext:start');
const block = src.slice(start, src.indexOf('// @bridge-function withMemoryContext:end'));
const fnEnd = block.indexOf('// 实体特征');
const body = block.slice(0, fnEnd).replace('// @bridge-function withMemoryContext:start', '');
const rest = block.slice(fnEnd);
const code = `(function () {\n${body.replace(/\bdeps\./g, '')}\n${rest.replace(/\bdeps\./g, '')}\nreturn { withMemoryContext, entityTokens, entityScore };\n})()`;

function makeCtx(maxItems, maxChars) {
  const convs = new Map();
  for (const [k, v] of Object.entries(social.conversations || {})) convs.set(k, v);
  return vm.createContext({
    cfg: { socialV2: { memory: { recall: { enabled: true, maxItems, maxChars } } } },
    socialV2: { digests: social.digests || {}, conversations: convs },
    impressionsLoad: () => imp,
    messageDb: () => db,
    searchMessages,
    log: () => {}
  });
}

console.log('\n=== 1. 自召回（真实消息当查询，看能否找回自己）===');
{
  const { withMemoryContext } = new vm.Script(code).runInContext(makeCtx(8, 1200));
  const rows = db.prepare(`SELECT key, text FROM messages WHERE length(text) BETWEEN 8 AND 40 AND text NOT LIKE '[图片]%' AND text NOT LIKE '[表情]%' ORDER BY ts DESC LIMIT 300`).all();
  const sample = rows.filter((r, i) => i % 5 === 0).slice(0, 40);
  let hit = 0;
  for (const r of sample) {
    const out = withMemoryContext(r.key, r.text, 'BASE');
    if (out.includes(r.text.slice(0, Math.min(12, r.text.length)))) hit += 1;
  }
  const rate = sample.length ? hit / sample.length : 0;
  ok(`自召回率 ${(rate * 100).toFixed(0)}%（${hit}/${sample.length}）`, rate >= 0.5);
}

console.log('\n=== 2. 隐私隔离（群聊不读私聊）===');
{
  const { withMemoryContext } = new vm.Script(code).runInContext(makeCtx(10, 2000));
  const priv = db.prepare(`SELECT text FROM messages WHERE key LIKE 'private:%' AND length(text) > 10 LIMIT 5`).all();
  let leaked = 0;
  for (const p of priv) {
    const out = withMemoryContext('group:100000003', p.text, 'BASE');
    if (out.includes(p.text.slice(0, 15))) leaked += 1;
  }
  ok(`私聊内容未泄漏到群聊（${priv.length} 条探测）`, leaked === 0, leaked ? `泄漏 ${leaked} 条` : '');
}

console.log('\n=== 3. 长度上限 ===');
{
  const { withMemoryContext } = new vm.Script(code).runInContext(makeCtx(10, 300));
  const out = withMemoryContext('group:100000003', '语音 冰箱 工具 模型', 'BASE');
  const memPart = out.includes('【相关记忆】') ? out.slice(out.indexOf('【相关记忆】')) : '';
  ok(`maxChars=300 时记忆块 ≤ 420 字（实际 ${memPart.length}）`, memPart.length <= 420);
}

console.log('\n=== 4. 实体加权（查询里的人名应把该人的话排前）===');
{
  const { withMemoryContext, entityTokens, entityScore } = new vm.Script(code).runInContext(makeCtx(6, 900));
  ok('entityTokens 抽中文 2-gram', entityTokens('机器人的语音').has('机器') && entityTokens('机器人的语音').has('语音'));
  ok('entityScore 重合度高', entityScore(entityTokens('语音调整'), entityTokens('调整语音')) > 0.4);
  const out = withMemoryContext('group:100000003', '狐雪 工具', 'BASE');
  const firstLines = out.split('【相关记忆】')[1]?.split('\n').filter(Boolean).slice(0, 3).join('\n') || '';
  ok('含人名的查询有结果', out.includes('【相关记忆】'), firstLines.replace(/\n/g, ' | ').slice(0, 80));
}

console.log('\n=== 5. 关闭开关时零注入 ===');
{
  const ctx = makeCtx(6, 900);
  ctx.cfg.socialV2.memory.recall.enabled = false;
  const { withMemoryContext } = new vm.Script(code).runInContext(ctx);
  ok('enabled=false 时原样返回', withMemoryContext('group:100000003', '语音', 'BASE') === 'BASE');
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
