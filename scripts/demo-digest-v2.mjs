#!/usr/bin/env node
/**
 * D36 前后对比 demo（只读，不写 state/config）：
 *   「改前」= 线上现在那套：state 里的旧摘要 + strict 表头（= 旧禁令）
 *   「改后」= 用线上真实 recentMessages 重新生成摘要（新 buildDigest）+ open 表头 + 「N 小时前」
 *
 * 为什么不用 render-cross-session.mjs 直接对比：那个脚本跑的是**线上那份代码**，
 * 改动还没重启生效，它只能给出「改前」。改后必须在这边用新代码现算。
 *
 * 用法：
 *   node scripts/demo-digest-v2.mjs
 *   node scripts/demo-digest-v2.mjs --state <dir> --config <file>
 *   node scripts/demo-digest-v2.mjs --json
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildDigest, renderDigestBlock, pickDigests, DIGEST_DEFAULTS } from '../src/cross-session-memory.js';
import { freshnessLabel } from '../src/cross-session-digest-v2.js';
import { analyzeDigest } from './analyze-digest-density.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const loadJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const stateDir = argOf('--state', path.join(ROOT, 'state'));
const configPath = argOf('--config', path.join(ROOT, 'config.json'));
const asJson = args.includes('--json');

const stateFile = path.join(stateDir, 'social-v2.json');
const before = [stateFile, configPath].map(sha);
const state = loadJson(stateFile) || {};
const cfg = loadJson(configPath) || {};
const convs = state.conversations && typeof state.conversations === 'object' ? state.conversations : {};
const liveDigests = state.digests && typeof state.digests === 'object' ? state.digests : {};
const allowKeys = [
  ...(cfg.allow?.groups ?? []).map((g) => `group:${String(g)}`),
  ...(cfg.allow?.private ?? []).map((u) => `private:${String(u)}`)
];
const fresh = cfg.socialV2?.memory?.crossSession ?? {};
const opts = {
  maxSessions: Number(fresh.maxSessions) || DIGEST_DEFAULTS.maxSessions,
  maxCharsEach: Number(fresh.maxCharsEach) || DIGEST_DEFAULTS.maxCharsEach,
  maxAgeMs: Number(fresh.maxAgeMs) || DIGEST_DEFAULTS.maxAgeMs,
  maxBlockChars: Number(fresh.maxBlockChars) || DIGEST_DEFAULTS.maxBlockChars
};
const now = Date.now();

// 改后：拿真实消息流重新生成摘要（新 buildDigest）
const rebuilt = {};
const rows = [];
for (const key of Object.keys(convs)) {
  if (!allowKeys.includes(key)) continue;
  const msgs = Array.isArray(convs[key]?.recentMessages) ? convs[key].recentMessages : [];
  if (msgs.length < 5) continue;
  const d = buildDigest({ key, messages: msgs, now, maxChars: Number(fresh.maxChars) || DIGEST_DEFAULTS.maxChars });
  if (!d) continue;
  rebuilt[key] = d;
  const oldRow = liveDigests[key] ? { ...liveDigests[key], key } : null;
  rows.push({
    key,
    msgs: msgs.length,
    live: oldRow ? analyzeDigest(oldRow, { now }) : null,
    neu: analyzeDigest(d, { now })
  });
}

const blockStats = (block) => {
  const body = block.replace(/【其它会话的近况】[^\n]*\n/, '');
  const lines = body.split('\n').filter((l) => l.trim());
  const summaries = lines.map((l) => l.replace(/^· (群 \d+|私聊)：/, ''));
  const halfTail = summaries.filter((s) => s.endsWith('：') || /：.{0,1}$/.test(s)).length;
  const placeholders = (body.match(/\[(?:图片|表情包[^\]]*|视频[^\]]*|文件[^\]]*|语音[^\]]*)\]/g) || []).length;
  return { chars: block.length, sessions: lines.length, halfTail, placeholders, bodyChars: body.replace(/\n/g, '').length };
};

const pick = (digests, currentKey, extra) => {
  const items = pickDigests({ digests, currentKey, allowKeys, now, opts });
  return extra ? items.map((it) => ({ ...it, summary: `${it.summary}（${freshnessLabel(it.at, now)}）` })) : items;
};

// 为了「改前 vs 改后」可比，注入块两边都只用**同一批会话**（state 里已有摘要的那些）：
// 否则改后多出一条新摘要，块变长会被误读成「措辞变长」。
const commonKeys = Object.keys(liveDigests).filter((k) => allowKeys.includes(k) && rebuilt[k]);
const onlyCommon = (digests) => Object.fromEntries(Object.entries(digests).filter(([k]) => commonKeys.includes(k)));

const panels = allowKeys.map((currentKey) => {
  const oldBlock = renderDigestBlock(pick(onlyCommon(liveDigests), currentKey), { maxBlockChars: opts.maxBlockChars, disclosure: 'strict' });
  const newBlock = renderDigestBlock(pick(onlyCommon(rebuilt), currentKey, true), { maxBlockChars: opts.maxBlockChars, disclosure: 'open' });
  return { currentKey, old: blockStats(oldBlock), neu: blockStats(newBlock), oldBlock, newBlock };
});

if (asJson) {
  console.log(JSON.stringify({ now, opts, disclosureCfg: fresh.disclosure ?? '(未配置 → open)', rows, panels }, null, 2));
  process.exit(0);
}

const pct = (x) => `${Math.round((Number(x) || 0) * 1000) / 10}%`;
const W = (s, n) => String(s).padEnd(n);

console.log(`D36 改前/改后对比（只读）  现在 ${new Date(now).toLocaleString('zh-CN')}`);
console.log(`state: ${stateFile}`);
console.log(`config socialV2.memory.crossSession = ${JSON.stringify(fresh)}  disclosure=${fresh.disclosure ?? '(未配置→open)'}\n`);

console.log('一、单条摘要（改前 = state 里现存的；改后 = 用同一批 recentMessages 重新生成）');
console.log(`${W('会话', 20)}${W('版', 5)}${W('字数', 5)}${W('段数', 5)}${W('占位段', 7)}${W('截断尾', 7)}${W('有效对', 6)}${W('字/对', 7)}${W('假话题', 7)}`);
for (const r of rows) {
  for (const [tag, m] of [['前', r.live], ['后', r.neu]]) {
    if (!m) { console.log(`${W(tag === '前' ? r.key : '', 20)}${W(tag, 5)}（state 里没有这条摘要）`); continue; }
    console.log(`${W(tag === '前' ? r.key : '', 20)}${W(tag, 5)}${W(m.totalChars, 5)}${W(m.segments, 5)}${W(`${m.placeholderSegs}/${m.segments}`, 7)}${W(m.truncatedTail, 7)}${W(m.meaningfulPairs, 6)}${W(m.charsPerPair ?? '-', 7)}${W(`${m.junkTopics}/${m.topics}`, 7)}`);
  }
}
const sum = (f) => rows.reduce((a, r) => a + (r.live ? f(r.live) : 0), 0);
const sumN = (f) => rows.reduce((a, r) => a + f(r.neu), 0);
console.log(`\n合计（只统计 state 里有摘要的 ${rows.filter((r) => r.live).length} 个会话）`);
console.log(`  改前：字数 ${sum((m) => m.totalChars)} / 占位段 ${sum((m) => m.placeholderSegs)} / 截断尾 ${sum((m) => m.truncatedTail)} / 有效对 ${sum((m) => m.meaningfulPairs)} / 假话题 ${sum((m) => m.junkTopics)}`);
console.log(`  改后：字数 ${sumN((m) => m.totalChars)} / 占位段 ${sumN((m) => m.placeholderSegs)} / 截断尾 ${sumN((m) => m.truncatedTail)} / 有效对 ${sumN((m) => m.meaningfulPairs)} / 假话题 ${sumN((m) => m.junkTopics)}`);

console.log('\n二、注入块（模型真正看到的那段）');
console.log(`${W('当前会话', 20)}${W('版', 5)}${W('条数', 5)}${W('字符', 6)}${W('占位符', 7)}${W('半截条', 7)}`);
for (const p of panels) {
  for (const [tag, b] of [['前', p.old], ['后', p.neu]]) {
    if (!b.sessions) { console.log(`${W(tag === '前' ? p.currentKey : '', 20)}${W(tag, 5)}（没有可注入的摘要）`); continue; }
    console.log(`${W(tag === '前' ? p.currentKey : '', 20)}${W(tag, 5)}${W(b.sessions, 5)}${W(b.chars, 6)}${W(b.placeholders, 7)}${W(b.halfTail, 7)}`);
  }
}

const sample = panels.find((p) => p.neu.sessions) || panels[0];
if (sample) {
  console.log(`\n${'='.repeat(70)}\n表头 + 内容对比（以 ${sample.currentKey} 为例）`);
  console.log(`--- 改前（strict 表头，${sample.old.chars} 字符）---\n${sample.oldBlock.trim()}`);
  console.log(`\n--- 改后（open 表头 + 新鲜度，${sample.neu.chars} 字符）---\n${sample.newBlock.trim()}`);
}

const after = [stateFile, configPath].map(sha);
console.log(`\n只读自证：state/config sha256 ${before.every((h, i) => h === after[i]) ? '未变 ✅' : '变了 ❌'}`);
