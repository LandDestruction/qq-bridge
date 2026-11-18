#!/usr/bin/env node
// 合并 stickers.json 里的重复表情，并打印重复组报告。
//
// 用法：
//   node scripts/dedupe-stickers.mjs --file <stickers.json>            # 只报告
//   node scripts/dedupe-stickers.mjs --file <stickers.json> --apply    # 备份后实际合并
//
// 去重规则与 src/sticker-lib.js 的 dedupeStickerEntries 完全一致（md5 → emojiId → id → url 去 query，
// 再用 dhash 合并「同图不同 md5」的重编码变体），避免脚本和运行时两套规则打架。
import fs from 'node:fs';
import path from 'node:path';
import { dedupeStickerEntries } from '../src/sticker-lib.js';

const args = process.argv.slice(2);
const fileArg = args.find((a) => a.startsWith('--file=')) || (args.includes('--file') ? args[args.indexOf('--file') + 1] : '');
const apply = args.includes('--apply');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const FILE = fileArg ? path.resolve(fileArg) : path.join(ROOT, 'state', 'stickers.json');

if (!fs.existsSync(FILE)) { console.error('找不到文件：' + FILE); process.exit(1); }
const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const list = Array.isArray(raw) ? raw : (raw.entries || raw.stickers || []);
if (!Array.isArray(list)) { console.error('结构不认识（顶层既不是数组也没有 entries/stickers）'); process.exit(1); }

const norm = (u) => {
  const s = String(u || '').trim();
  if (!s) return '';
  try { const x = new URL(s); return (x.host + x.pathname).toLowerCase(); } catch { return s.split('?')[0].toLowerCase(); }
};
function groupStats(pick) {
  const map = new Map();
  for (const e of list) {
    const k = pick(e);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  const dup = [...map.entries()].filter(([, v]) => v.length > 1);
  return { groups: dup.length, extra: dup.reduce((n, [, v]) => n + v.length - 1, 0), dup };
}

const byMd5 = groupStats((e) => String(e?.md5 || '').trim().toLowerCase());
const byEmoji = groupStats((e) => String(e?.emojiId || '').trim());
const byUrl = groupStats((e) => norm(e?.url));
const byDhash = groupStats((e) => String(e?.dhash || '').trim().toLowerCase());

console.log(`文件：${FILE}`);
console.log(`条数：${list.length}`);
console.log(`重复组：md5 ${byMd5.groups} 组（多 ${byMd5.extra} 条）｜emojiId ${byEmoji.groups} 组｜url ${byUrl.groups} 组｜dhash ${byDhash.groups} 组（多 ${byDhash.extra} 条）`);
for (const [k, v] of byMd5.dup.slice(0, 10)) console.log(`  md5 ${k} x${v.length}：${v.map((e) => e.id).join(', ')}`);
for (const [k, v] of byDhash.dup.slice(0, 10)) console.log(`  dhash ${k} x${v.length}：${v.map((e) => `${e.id}(${String(e.md5 || '').slice(0, 8)})`).join(', ')}`);

const before = list.length;
const deduped = dedupeStickerEntries(list);
const after = deduped.length;
const removed = before - after;
console.log(`去重后：${after} 条（合并掉 ${removed} 条）${apply ? '' : '  [演练模式，未写盘]'}`);

const oldMissing = list.filter((e) => e.thumbStatus === 'missing').length;
if (oldMissing) console.log(`thumbStatus=missing：${oldMissing} 条 → 保留 ${deduped.filter((e) => e.thumbStatus === 'missing').length} 条（不可恢复条目不会被删）`);

if (!apply) process.exit(0);
if (!removed) { console.log('没有需要合并的条目，文件未改动。'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${FILE}.bak-dedupe-${stamp}`;
fs.copyFileSync(FILE, backup);
console.log('已备份：' + backup);
const payload = Array.isArray(raw) ? deduped : { ...raw, entries: deduped, stickers: Array.isArray(raw.stickers) ? deduped : raw.stickers };
const tmp = `${FILE}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
fs.renameSync(tmp, FILE);
console.log(`已写回：${FILE}（${before} → ${after}）`);
