// 观察群探针：一条命令看清「消息收进来了吗 / 有没有乱说话 / 学到什么」。
//
// 用法：
//   node scripts/observe-probe.mjs 100000005            # 最近 30 分钟
//   node scripts/observe-probe.mjs 100000005 120        # 最近 120 分钟
//
// 数据源（全部只读）：
//   · <live>/state/bridge.log      当前日志
//   · <live>/state/bridge.log.1    上一次轮转
//   · <live>/state/messages.db     messages 表（readOnly）
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const LIVE = process.env.QQ_BRIDGE_LIVE || 'C:/Users/PC/Documents/deepseek-harness/qq-bridge-src';
const groupId = String(process.argv[2] || '').trim();
const minutes = Math.max(1, Number(process.argv[3]) || 30);
if (!/^\d{5,}$/.test(groupId)) {
  console.error('用法：node scripts/observe-probe.mjs <群号> [最近多少分钟，默认 30]');
  process.exit(2);
}

const since = Date.now() - minutes * 60 * 1000;
const PATTERNS = [
  ['观察群', /观察群/],
  ['只学习不发言', /只学习不发言|不唤醒|不会唤醒/],
  ['未授权会话', /忽略未授权会话/],
  ['黑话', /黑话/],
  ['表情', /表情/],
  ['唤醒', /唤醒/],
  ['发送', /工具统一发送|sendToQQ|qq_send_message/],
  ['模型设置', /已设置会话模型|设置会话模型失败/],
  ['学习落盘', /观察群 .* 已收集|applyObserveLearning/]
];

const hits = [];
for (const name of ['bridge.log', 'bridge.log.1']) {
  const file = path.join(LIVE, 'state', name);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  for (const line of text.split('\n')) {
    if (!line.includes(groupId) && !/观察群/.test(line)) continue;
    const m = /^\[?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/.exec(line.trim());
    let ts = null;
    if (m) ts = Date.parse(m[1].replace(' ', 'T'));
    if (ts !== null && Number.isFinite(ts) && ts < since) continue;
    for (const [label, re] of PATTERNS) if (re.test(line)) hits.push({ label, line: line.trim().slice(0, 200) });
  }
}

console.log(`=== 日志（${minutes} 分钟内，群 ${groupId} 或 observe 相关）===`);
if (!hits.length) console.log('（无命中：可能还没人发消息，或日志已轮转）');
for (const h of hits) console.log(`[${h.label}] ${h.line}`);

let rows = [];
try {
  const db = new DatabaseSync(path.join(LIVE, 'state', 'messages.db'), { readOnly: true });
  rows = db.prepare('SELECT ts, sender, substr(text,1,80) AS t FROM messages WHERE key = ? ORDER BY ts DESC LIMIT 10')
    .all(`group:${groupId}`);
  db.close();
} catch (error) {
  console.log(`\n=== messages.db 读取失败（不影响结论）：${error?.message ?? error} ===`);
}
console.log(`\n=== messages.db 里该群最近 ${rows.length} 条 ===`);
if (!rows.length) console.log('（0 条：消息还没进库 → 观察路径可能没接住，或用户还没发）');
for (const r of rows) console.log(new Date(Number(r.ts)).toISOString(), String(r.sender ?? '').slice(0, 12), String(r.t ?? '').replace(/\s+/g, ' '));

const bad = hits.filter((h) => ['唤醒', '发送', '模型设置'].includes(h.label));
console.log('\n=== 结论判据 ===');
console.log(bad.length
  ? `❌ 发现 ${bad.length} 条「不该有」的日志（唤醒/发送/模型设置）→ 观察群可能被当成正常群处理`
  : '✅ 未出现唤醒/发送/模型设置日志（观察群应只看不说）');
console.log(rows.length ? `✅ 该群已有 ${rows.length} 条入库消息（可见部分）` : '⚠️ 该群还没有入库消息');
