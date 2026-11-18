// 把 state/tool-calls.jsonl 按「会话 + 轮次」归因，回答「这轮调了几次工具、有没有重复调」。
//
// 用法：
//   node scripts/tool-calls-by-turn.mjs                 # 最近 50 轮（按时间倒序）
//   node scripts/tool-calls-by-turn.mjs --since 30      # 只看最近 30 分钟
//   node scripts/tool-calls-by-turn.mjs --dup           # 只列「同一轮内同名工具重复调用」
//
// 说明：`turn` 字段是 bridge 在 turn/start 时记账写入的（旧日志没有该字段 → 归到 “?” 组）。
// 只读，不写任何文件。
import fs from 'node:fs';
import path from 'node:path';

const LIVE = process.env.QQ_BRIDGE_LIVE || 'C:/Users/PC/Documents/deepseek-harness/qq-bridge-src';
const file = path.join(LIVE, 'state', 'tool-calls.jsonl');
const args = process.argv.slice(2);
const sinceMin = Number(args[args.indexOf('--since') + 1]) || 0;
const onlyDup = args.includes('--dup');
const since = sinceMin > 0 ? Date.now() - sinceMin * 60000 : 0;

let rows = [];
try {
  rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
} catch (error) {
  console.error(`读不到 ${file}：${error?.message ?? error}`);
  process.exit(1);
}

const calls = rows.filter((r) => r.type === 'call' && (!since || Date.parse(r.time || 0) >= since));
const groups = new Map(); // key|turn -> { key, turn, tools: Map }
for (const c of calls) {
  const gk = `${c.key ?? c.sessionId ?? '?'}|${c.turn ?? '?'}`;
  let g = groups.get(gk);
  if (!g) { g = { key: c.key ?? c.sessionId ?? '?', turn: c.turn ?? '?', tools: new Map(), at: c.time }; groups.set(gk, g); }
  g.tools.set(c.tool, (g.tools.get(c.tool) || 0) + 1);
  if (c.time && (!g.at || c.time < g.at)) g.at = c.time;
}

const list = [...groups.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 50);
console.log(`共 ${calls.length} 次工具调用，${groups.size} 个（会话,轮次）分组\n`);
let dupCount = 0;
let unknownTurnGroups = 0;
for (const g of list) {
  const dups = [...g.tools.entries()].filter(([, n]) => n > 1);
  // turn 缺失（旧日志）时，同一 key 的所有轮次会被并成一组，×N **不能**当成「同一轮重复调」。
  if (g.turn === '?' ) { unknownTurnGroups += 1; }
  if (onlyDup && (g.turn === '?' || !dups.length)) continue;
  if (dups.length) dupCount += 1;
  const summary = [...g.tools.entries()].map(([t, n]) => (n > 1 ? `${t}×${n}` : t)).join(', ');
  console.log(`${g.at ?? ''}  ${g.key}  turn=${g.turn}  调用 ${[...g.tools.values()].reduce((a, b) => a + b, 0)} 次: ${summary}`);
}
if (unknownTurnGroups) {
  console.log(`
⚠️ 有 ${unknownTurnGroups} 组没有 turn 字段（旧日志）：这些组的「×N」是**跨轮合计**，不能当重复调用看。`);
}
console.log(`${onlyDup ? `含重复调用的轮次（仅统计有 turn 的组）：${dupCount}` : '提示：加 --dup 只看「同一轮内同名工具被调多次」的轮次'}`);
