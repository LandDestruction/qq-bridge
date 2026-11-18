#!/usr/bin/env node
// 把 DSH 本机会话（非机器人开的窗口）的用量补进 token 账本。
//
// 为什么需要：桥接的账本只吃自己 agent transport 的 `session/follow` 事件流，
// 用户在 DSH 桌面端手动开的会话（包括 Lead 窗口、临时对话）完全不在流里，
// 于是「用量与花费」看不到 DeepSeek 官方账号每天的真实消耗。
//
// 数据源：`~/.dsh/storages/session_projcache/sessions/<sessionId>.json`
// 里的 `record.rows.tokenUsage.val.totals`（权威累计桶，与桥接收到的
// session/follow snapshot 是同一份投影）。这个目录**包含所有会话**。
//
// 用法：
//   node scripts/import-dsh-usage.mjs            # 干跑，只打印
//   node scripts/import-dsh-usage.mjs --apply    # 追加进 state/token-usage.jsonl

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { priceUsage } from '../src/model-prices.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const STATE_DIR = path.join(REPO, 'state');
const LEDGER = path.join(STATE_DIR, 'token-usage.jsonl');
const PROJ = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

// 账本里已经记过的 sessionId（base / turn / evict 任一出现即算已覆盖）。
function knownSessions(file) {
  const set = new Set();
  if (!fs.existsSync(file)) return set;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r && r.sid) set.add(String(r.sid));
  }
  return set;
}

// 投影里的桶名 → 账本桶名。
function toBuckets(totals) {
  const n = (v) => Number(v) || 0;
  return {
    cacheMiss: n(totals?.uncachedInputTokens),
    cacheHit: n(totals?.cacheReadTokens),
    cacheWrite: n(totals?.cacheWriteTokens),
    output: n(totals?.outputTokens),
    reasoning: 0
  };
}

function wsName(cwd) {
  const s = String(cwd || '').replace(/[\\/]+$/, '');
  if (!s) return 'unknown';
  const base = s.split(/[\\/]/).pop() || 'unknown';
  return base;
}

const known = knownSessions(LEDGER);
const files = fs.existsSync(PROJ) ? fs.readdirSync(PROJ).filter((f) => f.endsWith('.json')) : [];
const rows = [];
let skippedKnown = 0, skippedEmpty = 0, broken = 0;

for (const f of files) {
  const sid = f.replace(/\.json$/, '');
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(PROJ, f), 'utf8')); } catch { broken++; continue; }
  const rec = j?.record || {};
  const proj = rec.rows || {};
  const tu = proj.tokenUsage?.val;
  const totals = tu?.totals;
  if (!totals) { skippedEmpty++; continue; }
  const b = toBuckets(totals);
  const tokenSum = b.cacheMiss + b.cacheHit + b.cacheWrite + b.output;
  if (tokenSum <= 0) { skippedEmpty++; continue; }
  if (known.has(sid)) { skippedKnown++; continue; }

  const cwd = rec.identity?.cwd || '';
  const ms = proj.modelSelection?.val;
  const sel = ms?.lastUsed || ms?.pending || null;
  const model = String(sel?.model || '').trim();
  const provider = String(sel?.provider || '').trim();
  const at = fs.statSync(path.join(PROJ, f)).mtimeMs;

  rows.push({
    k: 'base',
    t: Math.round(at),
    sid,
    key: 'external:' + wsName(cwd),
    seq: Number(tu?.seq) || 0,
    model: model || 'unknown',
    provider: provider || 'unknown',
    b
  });
}

// 估算这些外部会话一共多少钱（只为汇报，不改账本口径）。
let costTotal = 0;
const byKey = new Map();
const byProvModel = new Map();
for (const r of rows) {
  let cost = 0;
  try {
    const p = priceUsage(r.b, { model: r.model, at: r.t });
    cost = Number(p?.cost?.total) || 0;
  } catch { cost = 0; }
  costTotal += cost;
  byKey.set(r.key, (byKey.get(r.key) || 0) + cost);
  const pm = `${r.provider}/${r.model}`;
  byProvModel.set(pm, (byProvModel.get(pm) || 0) + cost);
}

const fmt = (v) => '¥' + Number(v).toFixed(4);
console.log(`投影缓存会话总数: ${files.length}`);
console.log(`账本已覆盖(跳过): ${skippedKnown}  |  无用量(跳过): ${skippedEmpty}  |  解析失败: ${broken}`);
console.log(`待补录: ${rows.length} 个会话  |  估算花费: ${fmt(costTotal)}`);
console.log('');
if (byKey.size) {
  console.log('按 workspace:');
  for (const [k, v] of [...byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log('  ' + k.padEnd(52) + fmt(v));
  }
  console.log('');
}
console.log('按 provider/model:');
for (const [k, v] of [...byProvModel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log('  ' + k.padEnd(46) + fmt(v));
}

if (VERBOSE) {
  console.log('\n明细:');
  for (const r of rows.slice(0, 40)) {
    console.log('  ', new Date(r.t).toLocaleString('zh-CN'), r.key, r.model, JSON.stringify(r.b));
  }
}

if (!APPLY) {
  console.log('\n（干跑。加 --apply 写入账本）');
  process.exit(0);
}
if (!rows.length) {
  console.log('\n没有需要补录的会话。');
  process.exit(0);
}

// 追加到账本（只加 base 行；账本启动时会把它当成投影基线读进来）。
const backup = LEDGER + '.bak-external-' + Date.now();
if (fs.existsSync(LEDGER)) fs.copyFileSync(LEDGER, backup);
const payload = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
fs.appendFileSync(LEDGER, payload, 'utf8');
console.log(`\n已追加 ${rows.length} 条 base 记录 → ${LEDGER}`);
console.log(`备份: ${backup}`);
