#!/usr/bin/env node
// 清理表情库里「根本不是表情」的图（群聊截图 / 聊天记录长图 / 照片 / 二维码…）。
//
// 判定复用 src/sticker-collect-rules.js 的 shouldAutoCollectSticker：收藏表情带协议标记
// （kind/emojiId/subType）那条路不适用这里——库里的条目早就丢了原始媒体段，所以这里
// 一律按「普通图片」判：动图 / 透明 PNG / 小图 / 扁平图形留下，其余清掉。
//
// 用法：
//   node scripts/prune-sticker-nonstickers.mjs             # 只报告，不改库
//   node scripts/prune-sticker-nonstickers.mjs --apply     # 真的清（先备份 stickers.json）
//   node scripts/prune-sticker-nonstickers.mjs --json      # 机器可读
//
// 只删库条目，不动 state/sticker-files 里的缓存文件：万一判错，把备份恢复回去就能继续用
// （缓存后面再跑一次 repair 会回收，不急）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readImageMeta, shouldAutoCollectSticker } from '../src/sticker-collect-rules.js';
import { normalizeStickerEntry } from '../src/sticker-lib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE = path.join(ROOT, 'state/stickers.json');
const CACHE = path.join(ROOT, 'state/sticker-files');

const argv = new Set(process.argv.slice(2));
const APPLY = argv.has('--apply');
const JSON_OUT = argv.has('--json');

function loadStore() {
  const raw = fs.readFileSync(STORE, 'utf8');
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.stickers) ? parsed.stickers : null;
  if (!entries) throw new Error('state/stickers.json 不是数组或 { stickers: [] }');
  return { parsed, entries };
}

function cacheFileOf(entry) {
  const md5 = String(entry?.md5 || '').trim().toUpperCase();
  if (!md5) return '';
  return path.join(CACHE, `${md5}.img`);
}

// "qq" = 用户自己 QQ 收藏的表情，同步进来的。用户收藏它就说明他当表情用，
// 哪怕图是 1200x900 的截图我们也不动——那不是「自动收录错了」，是他的选择。
function fromUserFavorites(entry) {
  return String(entry?.source || '') === 'qq';
}

// 人工/机器人「经营过」的条目也不清：有备注说明她认得这张图（哪怕图大），
// 真用过说明这张确实当表情发出去过。清理只针对「自动收进来以后再没被碰过」的。
function curatedByHand(entry) {
  return String(entry?.localNote || '').trim() !== '' || Number(entry?.useCount) > 0;
}

function decide(entry) {
  if (fromUserFavorites(entry)) return { ok: true, reason: '来自 QQ 收藏（用户自己收的）' };
  if (curatedByHand(entry)) return { ok: true, reason: '有备注或真用过，保留' };
  const file = cacheFileOf(entry);
  if (!file || !fs.existsSync(file)) return { ok: true, reason: '没有本地文件，留给 repair 处理' };
  const buf = fs.readFileSync(file);
  const meta = readImageMeta(buf);
  return shouldAutoCollectSticker({ media: { kind: 'image' }, meta, bytes: buf.length });
}

function main() {
  const { parsed, entries } = loadStore();
  const keep = [];
  const drop = [];
  for (const entry of entries) {
    const v = decide(entry);
    (v.ok ? keep : drop).push({ entry, reason: v.reason, meta: readImageMeta(fs.existsSync(cacheFileOf(entry)) ? fs.readFileSync(cacheFileOf(entry)) : Buffer.alloc(0)) });
  }
  const summary = {
    total: entries.length,
    keep: keep.length,
    drop: drop.length,
    reasons: drop.reduce((acc, r) => { acc[r.reason] = (acc[r.reason] || 0) + 1; return acc; }, {})
  };
  if (JSON_OUT) {
    console.log(JSON.stringify({ ...summary, items: drop.map((r) => ({ id: r.entry.id, md5: r.entry.md5, reason: r.reason })) }, null, 2));
  } else {
    console.log(`库内共 ${summary.total} 条：保留 ${summary.keep}，清掉 ${summary.drop}`);
    for (const [reason, n] of Object.entries(summary.reasons)) console.log(`  - ${reason}: ${n}`);
    console.log('\n前 20 条会被清掉的：');
    for (const r of drop.slice(0, 20)) {
      const m = r.meta || {};
      console.log(`  ${String(r.entry.id).slice(0, 26)} ${m.format || '?'} ${m.width || '?'}x${m.height || '?'} · ${r.reason}`);
    }
  }
  if (!APPLY) {
    if (!JSON_OUT) console.log('\n（只是预演；确认无误后加 --apply 真的清）');
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${STORE}.bak-${stamp}`;
  fs.copyFileSync(STORE, backup);
  const kept = entries.filter((entry) => !drop.some((r) => r.entry === entry));
  const next = Array.isArray(parsed) ? kept.map(normalizeStickerEntry) : { ...parsed, stickers: kept.map(normalizeStickerEntry) };
  fs.writeFileSync(STORE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`已清理 ${drop.length} 条，剩 ${kept.length} 条；备份在 ${path.basename(backup)}`);
}

main();
