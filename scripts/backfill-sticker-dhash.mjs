#!/usr/bin/env node
// 给表情库补齐 dHash（视觉指纹）—— 默认**只预演，不写任何文件**。
//
// 为什么需要它：面板「表情包注释」里同一张图铺两张卡，根因是同一张图被 QQ 重编码后 md5 变了，
// 只有 dHash 认得出是同一张；而库里 196 条只有 53 条有 dHash（`collectSticker` 历史上从不写它）。
// 补齐之后，`src/sticker-lib.js` 的 dedupe 第二轮（汉明距离 ≤1）会自动把这些卡并掉。
//
// 安全约束：
//   - 只填**空**的 dhash，绝不覆盖已有值、绝不删除任何条目、绝不改备注/标签/使用次数；
//   - 图片一律取自本地缓存 `state/sticker-files/<md5>.img`，不联网；
//   - `--apply` 前强制备份 `state/stickers.json.bak-<时间戳>`，写盘走临时文件 + rename；
//   - 合并（减少卡片数）**默认不发生**：不加 --dedupe 时只补 hash，让桥接下次加载时自己去重。
//
// 用法：
//   node scripts/backfill-sticker-dhash.mjs                 # 预演，打印会补多少、会并掉多少
//   node scripts/backfill-sticker-dhash.mjs --apply         # 只补 dhash（先备份）
//   node scripts/backfill-sticker-dhash.mjs --apply --dedupe # 同时把重复合并后写回（先备份）
//   node scripts/backfill-sticker-dhash.mjs --state <目录>  # 指定 state 目录（默认仓库下 state/）
//
// ⚠️ 桥接运行中时慎用 --apply：process 内存里那份 `stickerEntries` 没有这些 hash，
// 它下一次写盘会把文件覆盖回去。要么停桥接再跑，要么跑完立刻重启（重启由主窗口决定）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dhashFromBuffer } from '../src/image-hash.js';
import { dedupeStickerEntries, dhashDistance } from '../src/sticker-lib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const DEDUPE = argv.includes('--dedupe');
const stateArg = argv.indexOf('--state');
const STATE_DIR = stateArg >= 0 ? path.resolve(argv[stateArg + 1] || '') : path.join(ROOT, 'state');
const STORE = path.join(STATE_DIR, 'stickers.json');
const FILES = path.join(STATE_DIR, 'sticker-files');

if (!fs.existsSync(STORE)) {
  console.error(`找不到表情库：${STORE}`);
  process.exit(1);
}

const entries = JSON.parse(fs.readFileSync(STORE, 'utf8'));
if (!Array.isArray(entries)) {
  console.error(`表情库顶层不是数组：${STORE}`);
  process.exit(1);
}

const before = dedupeStickerEntries(entries);
const missing = entries.filter((e) => !String(e.dhash || '').trim());
const existing = entries.length - missing.length;

console.log(`表情库：${STORE}`);
console.log(`  ${entries.length} 条；已有 dhash ${existing} 条；缺 dhash ${missing.length} 条`);

let filled = 0;
let noFile = 0;
let hashFail = 0;
const filledEntries = [];
for (const e of missing) {
  const md5 = String(e.md5 || '').trim().toUpperCase();
  if (!md5) { noFile += 1; continue; }
  const file = path.join(FILES, `${md5}.img`);
  if (!fs.existsSync(file)) { noFile += 1; continue; }
  let dh = null;
  try { dh = dhashFromBuffer(fs.readFileSync(file)); } catch { dh = null; }
  if (!dh) { hashFail += 1; continue; }
  e.dhash = dh;
  filled += 1;
  filledEntries.push({ id: e.id, md5, dhash: dh });
}

console.log(`  可补 dhash：${filled} 条（缺本地图片 ${noFile} 条、算不出 ${hashFail} 条）`);

const after = dedupeStickerEntries(entries);
console.log(`\n补完后去重预演：${before.length} → ${after.length}（并掉 ${before.length - after.length} 条重复）`);

// 把「哪几张会并成一张」列出来，人工可核对（同 md5 的归一组，dhash 近邻归另一组）
const lost = entries.filter((e) => !after.some((a) => a.id === e.id));
if (lost.length) {
  console.log(`\n会被合并掉的 ${lost.length} 条：`);
  for (const e of lost) {
    // 找它并到了谁身上，并说明**凭什么**判定是同一张
    let to = null;
    let how = '';
    for (const a of after) {
      if (e.md5 && String(a.md5 || '').toUpperCase() === String(e.md5).toUpperCase()) { to = a; how = 'md5 相同'; break; }
      if (e.dhash && a.dhash) {
        const d = dhashDistance(e.dhash, a.dhash);
        if (d <= 1) { to = a; how = `dhash 距离 ${d}`; break; }
      }
    }
    console.log(`  - ${e.id}  md5=${String(e.md5 || '').slice(0, 12)}  ${to ? `${how} → ${to.id}` : '（找不到合并目标，请人工核对）'}`);
  }
  console.log('  （合并只保留一条，备注/标签/使用次数/可发 会并到保留的那条上，不会丢）');
}

if (!APPLY) {
  console.log('\n预演结束：没有写任何文件。要落盘加 --apply（会先备份）。');
  process.exit(0);
}

// ── 落盘 ────────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${STORE}.bak-${stamp}`;
fs.copyFileSync(STORE, backup);
console.log(`\n已备份：${backup}`);

const payload = DEDUPE ? after : entries;
const tmp = `${STORE}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
fs.renameSync(tmp, STORE);
console.log(`已写入：${STORE}（${payload.length} 条${DEDUPE ? '，含合并' : '，仅补 dhash'}）`);
if (!DEDUPE) {
  console.log('未合并：桥接下次加载时会自行去重（前提：这期间桥接没有从旧内存覆盖过这个文件）。');
}
console.log(`回滚：Copy-Item "${backup}" "${STORE}" -Force`);
