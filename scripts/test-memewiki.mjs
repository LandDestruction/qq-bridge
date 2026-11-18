// 梗百科（dsh-memewiki 词库）集成测试：只读查询、降级、问梗判定、提示词与工具接线。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { lookupMeme, formatMemeEntry, looksLikeMemeQuestion, normalizeMemeQuery, memewikiStatus, prelookupLine } from '../src/memewiki.js';

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('✅', name); } catch (e) { fail++; console.log('❌', name, '—', e.message); } };
const repo = process.cwd();
const dbFile = path.join(repo, 'data', 'memewiki.db');
const hasDb = fs.existsSync(dbFile);

check('词库存在且为 6000+ 条', () => {
  if (!hasDb) return console.log('   （跳过：本机没有 data/memewiki.db）');
  const st = memewikiStatus(dbFile);
  assert.equal(st.ok, true, st.error);
  assert.ok(st.entries > 6000, `entries=${st.entries}`);
});

check('精确标题命中', () => {
  const e = lookupMeme('去码头整点薯条', { file: dbFile });
  assert.ok(e && e.title === '去码头整点薯条');
  assert.ok(String(e.summary || '').length > 10);
});

check('标题包含查询词（短词也能查到长标题）', () => {
  const e = lookupMeme('码头', { file: dbFile });
  assert.ok(e && e.title.includes('码头'));
});

check('查询词包含标题（≥3 字反向匹配）', () => {
  const e = lookupMeme('我想知道心机绿茶的梗', { file: dbFile });
  assert.ok(e && e.title && e.title.length >= 3);
});

check('查不到返回 null（不编）', () => {
  const e = lookupMeme('这个词库里绝对没有的九个字的怪词', { file: dbFile });
  assert.equal(e, null);
});

check('库文件缺失时降级为 null/ok:false，不抛', () => {
  const missing = path.join(repo, 'data', 'no-such-memewiki.db');
  assert.equal(lookupMeme('码头', { file: missing }), null);
});

check('normalizeMemeQuery 洗掉 @ 与问句尾巴', () => {
  assert.equal(normalizeMemeQuery('@大肥鱼 / 这是什么梗'), '/');
  assert.equal(normalizeMemeQuery('去码头整点薯条是什么梗'), '去码头整点薯条');
});

check('looksLikeMemeQuestion：问梗命中，日常闲聊不命中', () => {
  assert.equal(looksLikeMemeQuestion('这是什么梗'), true);
  assert.equal(looksLikeMemeQuestion('六边形战士什么梗'), true);
  assert.equal(looksLikeMemeQuestion('今天吃啥'), false);
  assert.equal(looksLikeMemeQuestion(''), false);
});

check('formatMemeEntry 带标题/释义/怎么用且截断', () => {
  const e = lookupMeme('去码头整点薯条', { file: dbFile });
  const text = formatMemeEntry(e, { maxSummary: 50, maxUsage: 40 });
  assert.ok(text.startsWith('【梗百科】去码头整点薯条'));
  assert.ok(text.includes('释义：') && text.includes('怎么用：'));
  assert.ok(text.split('\n')[1].length <= 60, '释义被截断');
});

check('null 词条格式化返回空串', () => {
  assert.equal(formatMemeEntry(null), '');
});

check('MCP 工具 qq_meme_lookup 已注册且只查本地', () => {
  const src = fs.readFileSync(path.join(repo, 'src', 'mcp-snowluma-safe', 'tools-memory.js'), 'utf8');
  assert.ok(src.includes("'qq_meme_lookup'"));
  assert.ok(src.includes('lookupMeme(query'));
  assert.ok(!/qq_meme_lookup[\s\S]{0,400}agentApi/.test(src), '不该走网络');
});

check('唤醒提示词里有【梗百科】段且只出现一次', () => {
  const src = fs.readFileSync(path.join(repo, 'src', 'bridge', 'wake-prompts.js'), 'utf8');
  assert.ok(src.includes('memeWikiHintLine'));
  assert.ok(src.includes('qq_meme_lookup(query)'));
  assert.equal((src.match(/\['memeWiki'/g) || []).length, 1);
});


check('prelookupLine：问梗命中时给出词条与「别背原文」', () => {
  const line = prelookupLine([{ userId: '1', text: '去码头整点薯条是什么梗', time: 2 }], '9');
  assert.ok(line.includes('【梗百科·命中】'));
  assert.ok(line.includes('词条：去码头整点薯条'));
  assert.ok(line.includes('别把释义原文背出来'));
});

check('prelookupLine：闲聊/自己的消息/空列表都不注入', () => {
  assert.equal(prelookupLine([{ userId: '1', text: '今天吃啥', time: 1 }], '9'), '');
  assert.equal(prelookupLine([{ userId: '9', text: '这是什么梗', time: 1, isSelf: true }], '9'), '');
  assert.equal(prelookupLine([], '9'), '');
});

check('接线：wake-dispatch 写 st.memeWikiLine，提示词拼进去，bridge 提供 prelookup', () => {
  const d = fs.readFileSync(path.join(repo, 'src', 'bridge', 'wake-dispatch.js'), 'utf8');
  assert.ok(d.includes('memeWikiPrelookup'));
  assert.ok(d.includes('st.memeWikiLine = line'));
  const w = fs.readFileSync(path.join(repo, 'src', 'bridge', 'wake-prompts.js'), 'utf8');
  assert.ok(w.includes('st.memeWikiLine'));
  const b = fs.readFileSync(path.join(repo, 'src', 'bridge.js'), 'utf8');
  assert.ok(b.includes('memeWikiPrelookup(key, st)'));
});

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
if (fail) process.exitCode = 1;
