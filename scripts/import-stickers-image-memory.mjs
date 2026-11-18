#!/usr/bin/env node
// 把表情库里已有 dHash + 备注/描述的表情导入「本地画面记忆」，
// 这样这些表情第一次出现就能直接查表认出来，不用再花识图调用。
//
// 用法：
//   node scripts/import-stickers-image-memory.mjs [--dry-run] [--json]
// 只读 state/stickers.json，写 state/image-memory.json（写前备份）。
import fs from 'node:fs';
import path from 'node:path';
import { normalizeImageMemory, rememberImage } from '../src/image-memory.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const STICKERS = path.join(ROOT, 'state', 'stickers.json');
const MEMORY = path.join(ROOT, 'state', 'image-memory.json');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const asJson = argv.includes('--json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// state/stickers.json 实际是「裸数组」，也兼容 {entries:[…]} 的旧形状。
const stickerRaw = readJson(STICKERS, []);
const entries = Array.isArray(stickerRaw) ? stickerRaw : (Array.isArray(stickerRaw?.entries) ? stickerRaw.entries : []);
let mem = normalizeImageMemory(readJson(MEMORY, { version: 1, entries: [] }));

let scanned = 0;
let added = 0;
let updated = 0;
let skippedNoHash = 0;
let skippedNoText = 0;

for (const e of entries) {
  if (!e || typeof e !== 'object') continue;
  const hash = String(e.dhash || '').trim().toLowerCase();
  const desc = String(e.localNote || e.desc || '').trim() || (Array.isArray(e.tags) && e.tags.length ? `表情：${e.tags.slice(0, 4).join('、')}` : '');
  scanned += 1;
  if (!/^[0-9a-f]{8,16}$/.test(hash)) { skippedNoHash += 1; continue; }
  if (!desc) { skippedNoText += 1; continue; }
  if (dryRun) { added += 1; continue; }
  const r = rememberImage(mem, { hash, desc: desc.slice(0, 300), kind: 'sticker' }, { maxEntries: 20000 });
  mem = r.store;
  if (r.added) added += 1;
  else if (r.updated) updated += 1;
}

const result = { scanned, imported: added + updated, added, updated, skippedNoHash, skippedNoText, total: mem.entries.length, dryRun };
if (!dryRun) {
  if (fs.existsSync(MEMORY)) fs.copyFileSync(MEMORY, `${MEMORY}.bak-${Date.now()}`);
  fs.mkdirSync(path.dirname(MEMORY), { recursive: true });
  fs.writeFileSync(MEMORY, JSON.stringify(mem));
}

if (asJson) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`扫到表情 ${scanned} 条；导入 ${result.imported}（新增 ${added} / 更新 ${updated}）；跳过 无 hash ${skippedNoHash} / 无文字 ${skippedNoText}；图库现在 ${result.total} 条${dryRun ? '（dry-run，未写盘）' : ''}`);
}
