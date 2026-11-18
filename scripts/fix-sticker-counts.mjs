// 修复表情「用过 N 次」被污染的历史数据。
//
// 背景：2026-10-28 以前 src/bridge/incoming-media.js 在「别人在群里发了库里已有的表情」时，
// 错误地给 useCount +1（那是「见过」，不是「用过」）。结果 238 条「不可用（只解读）」的表情里
// 有 31 条显示「用过 N 次」——用户看到的就是这个 bug。
//
// 代码已改成 seenCount（只涨「见过」）。这个脚本负责修历史数据：
//   1. 从 logs/bridge-stdout.log 里数每张表情真实被发出去的次数
//      （`[sticker] 工具发送表情 <key>: <id>`，id 里带 md5）；
//   2. lastContext 是「有人发过这张」的条目：useCount 归为真实发送次数，
//      差额挪进 seenCount；
//   3. 其余条目（发送路径写的 lastContext）保持原样，只把日志里更准确的发送次数补进去。
//
// 用法：node scripts/fix-sticker-counts.mjs          # 只打印计划（dry-run）
//      node scripts/fix-sticker-counts.mjs --apply  # 真写，写前备份 state/stickers.json.bak-<时间>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE = path.join(ROOT, 'state', 'stickers.json');
const LOG = path.join(ROOT, 'logs', 'bridge-stdout.log');
const APPLY = process.argv.includes('--apply');
const SEND_RE = /\[sticker\] 工具发送表情 (\S+): (\S+)/g;

function countSends() {
  const counts = new Map();
  let text = '';
  try {
    text = fs.readFileSync(LOG, 'utf8');
  } catch {
    return counts;
  }
  let m;
  while ((m = SEND_RE.exec(text))) {
    const id = m[2];
    const md5 = (/[0-9A-F]{32}/i.exec(id) || [])[0];
    const key = md5 ? md5.toUpperCase() : id;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function keyOf(entry) {
  const md5 = String(entry.md5 || '').trim().toUpperCase();
  if (md5) return md5;
  const m = /[0-9A-F]{32}/i.exec(String(entry.id || ''));
  return m ? m[0].toUpperCase() : String(entry.id || '');
}

function main() {
  const raw = fs.readFileSync(STORE, 'utf8');
  const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  const entries = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.stickers) ? parsed.stickers : []);
  const sends = countSends();
  const changes = [];
  for (const e of entries) {
    const oldUse = Math.max(0, Number(e.useCount) || 0);
    const oldSeen = Math.max(0, Number(e.seenCount) || 0);
    const sendCount = sends.get(keyOf(e)) || 0;
    const polluted = /有人发过这张/.test(String(e.lastContext || ''));
    let use = oldUse;
    let seen = oldSeen;
    if (polluted) {
      use = Math.min(oldUse, sendCount); // 最多就是日志里真实发出去的那几次
      seen = oldSeen + Math.max(0, oldUse - use);
    } else if (sendCount > oldUse) {
      use = sendCount; // 日志比记录更全：补上漏记的那几次
    }
    if (use === oldUse && seen === oldSeen) continue;
    changes.push({ entry: e, oldUse, oldSeen, use, seen, sendCount, polluted });
  }

  const blocked = changes.filter((c) => c.entry.policy !== 'usable' && c.use > 0);
  console.log(`库内 ${entries.length} 条，日志里能数出 ${sends.size} 张有发送记录`);
  console.log(`需要修 ${changes.length} 条；修完仍有 ${blocked.length} 条「不可用」带用过计数`);
  for (const c of changes.slice(0, 15)) {
    const name = String(c.entry.localNote || c.entry.desc || c.entry.md5 || c.entry.id).slice(0, 16);
    console.log(`  ${name} 用过 ${c.oldUse}→${c.use}  见过 ${c.oldSeen}→${c.seen}` +
      (c.polluted ? '  (旧计数来自「别人发过」)' : '') + `  日志发送 ${c.sendCount}`);
  }
  if (changes.length > 15) console.log(`  … 另有 ${changes.length - 15} 条`);
  for (const c of blocked) {
    const name = String(c.entry.localNote || c.entry.desc || c.entry.md5 || c.entry.id).slice(0, 16);
    console.log(`  仍有计数：${name} 用过 ${c.use} 次（日志里确实发过，属正常）`);
  }

  if (!APPLY) {
    console.log('\ndry-run：加 --apply 才会真写。');
    return;
  }
  if (!changes.length) {
    console.log('\n没有要改的了。');
    return;
  }
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${STORE}.bak-${now}`;
  fs.copyFileSync(STORE, backup);
  for (const c of changes) {
    c.entry.useCount = c.use;
    c.entry.seenCount = c.seen;
    if (c.polluted && !c.entry.lastSeenContext) c.entry.lastSeenContext = String(c.entry.lastContext || '').slice(0, 200);
    c.entry.updatedAt = new Date().toISOString();
  }
  fs.writeFileSync(STORE, `${JSON.stringify(Array.isArray(parsed) ? entries : { ...parsed, stickers: entries }, null, 2)}\n`, 'utf8');
  console.log(`\n已写入，备份在 ${path.basename(backup)}`);
}

main();
