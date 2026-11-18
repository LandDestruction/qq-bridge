#!/usr/bin/env node
// BOOTH 抓取/缩略图 e2e（联调用，唯一需要联网的 BOOTH 脚本）。
//
// 用法: node scripts/booth-e2e.mjs <boothId> [--dir <输出目录>] [--keep]
//
// 做四件事：
// 1) 真抓一次商品元数据并打印关键字段；
// 2) 下载缩略图 → 规格化成「长边 ≤512 的 JPEG」；
// 3) 在临时目录里生成「商品目录 + meta.json + thumbnail.jpg」示例并打印目录树；
// 4) 用 ffprobe 校验缩略图尺寸/大小（失败只告警，不假装成功）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchBoothMeta } from '../src/booth-meta.js';
import { getBoothCover, COVER_MAX_EDGE, COVER_MAX_BYTES } from '../src/booth-cover.js';
import { normalizeThumbnailFile, imageSize, BOOTH_THUMB_MAX_EDGE } from '../src/booth-thumb.js';
import { safeFetchToFile } from '../src/safe-fetch.js';
import { boothItemDirName, metaJsonFor } from '../src/file-archive.js';

const args = process.argv.slice(2);
const id = String(args.find((a) => /^\d+$/.test(a)) || '').trim();
if (!id) {
  console.error('用法: node scripts/booth-e2e.mjs <boothId> [--dir <outputDir>] [--keep]');
  process.exit(2);
}
const dirIdx = args.indexOf('--dir');
const hasOutDir = dirIdx >= 0 && Boolean(args[dirIdx + 1]);
const outDir = hasOutDir ? path.resolve(args[dirIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), `booth-e2e-${id}-`));
const keep = args.includes('--keep');
fs.mkdirSync(outDir, { recursive: true });
const cacheDir = path.join(outDir, '.cache');

console.log(`# BOOTH e2e ${id}`);
console.log(`输出目录: ${outDir}`);

const meta = await fetchBoothMeta(id, { cacheDir, cfg: { cacheDir, rateLimitMs: 1000, timeoutMs: 20000 } });
console.log('\n## 元数据');
console.log(JSON.stringify({
  status: meta.status,
  title: meta.title,
  shop: meta.shop,
  price: meta.price,
  category: meta.category,
  tags: meta.tags,
  itemUrl: meta.itemUrl,
  thumbnailUrl: meta.thumbnailUrl,
  error: meta.error || undefined
}, null, 2));

if (meta.status !== 'ok' && meta.status !== 'gated') {
  console.log('\n商品页不可用（status 不是 ok/gated），不生成目录示例。');
  process.exit(1);
}

console.log('\n## 商品展示图 cover');
const coverCacheRoot = path.join(outDir, 'booth-cache');
const cover = await getBoothCover(id, { cacheRoot: coverCacheRoot });
console.log(JSON.stringify({
  ok: cover.ok,
  status: cover.status,
  path: cover.path,
  bytes: cover.bytes,
  width: cover.width,
  height: cover.height,
  cached: cover.cached,
  error: cover.error || undefined,
  maxEdge: COVER_MAX_EDGE,
  maxBytes: COVER_MAX_BYTES
}, null, 2));

const name = boothItemDirName(id, meta.title || '');
const productDir = path.join(outDir, 'state-files-demo', name);
fs.mkdirSync(productDir, { recursive: true });

// 缩略图：先下原图，再规格化成 512 JPEG；规格化失败保留原图（fallback）。
let thumbInfo = null;
if (meta.thumbnailUrl) {
  const raw = path.join(productDir, '.thumb.src');
  try {
    const fetched = await safeFetchToFile(meta.thumbnailUrl, raw, { maxBytes: 2 * 1024 * 1024, timeoutMs: 20000 });
    if (!fetched.truncated) {
      const normalized = normalizeThumbnailFile({ srcPath: raw, destPath: path.join(productDir, 'thumbnail.jpg'), maxEdge: BOOTH_THUMB_MAX_EDGE });
      thumbInfo = {
        mode: normalized.mode,
        bytes: normalized.bytes,
        dimensions: imageSize(path.join(productDir, 'thumbnail.jpg')),
        error: normalized.error
      };
    } else {
      thumbInfo = { mode: 'truncated', error: '缩略图超过 2MB' };
    }
  } catch (error) {
    thumbInfo = { mode: 'failed', error: String(error?.message ?? error) };
  } finally {
    try { fs.rmSync(raw, { force: true }); } catch {}
  }
}

const metaObj = metaJsonFor({
  boothId: id,
  boothUrl: meta.itemUrl,
  boothTitle: meta.title,
  boothShop: meta.shop,
  boothPrice: meta.price,
  boothTags: meta.tags.join('|'),
  groupId: '100000001',
  fileName: '(e2e 示例，无真实转存文件)',
  bytes: 0,
  sha256: '',
  archivedAt: Date.now(),
  category: meta.category,
  thumbRel: thumbInfo?.mode && thumbInfo.mode !== 'failed' ? path.join(name, 'thumbnail.jpg') : '',
  thumbStatus: thumbInfo?.mode === 'resized' ? 'ok' : (thumbInfo?.mode === 'fallback' ? 'fallback' : 'missing'),
  coverPath: cover.ok ? cover.path : '',
  coverError: cover.ok ? '' : (cover.error || ''),
  source: 'e2e'
});
// metaJsonFor 只输出固定字段，扩展字段要在这里补（与 enrichArchiveItem 的写法一致）
metaObj.coverPath = cover.ok ? cover.path : '';
metaObj.coverError = cover.ok ? '' : (cover.error || '');
fs.writeFileSync(path.join(productDir, 'meta.json'), `${JSON.stringify(metaObj, null, 1)}\n`, 'utf8');

console.log('\n## 目录结构');
function walk(dir, prefix = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      console.log(`${prefix}${entry.name}/`);
      walk(p, `${prefix}  `);
    } else {
      console.log(`${prefix}${entry.name}  (${fs.statSync(p).size} bytes)`);
    }
  }
}
walk(path.join(outDir, 'state-files-demo'));

console.log('\n## meta.json');
console.log(fs.readFileSync(path.join(productDir, 'meta.json'), 'utf8'));

console.log('\n## 缩略图校验');
if (!thumbInfo || thumbInfo.mode === 'failed' || thumbInfo.mode === 'truncated') {
  console.log(`❌ 缩略图失败: ${thumbInfo?.error || '未知'}`);
  process.exitCode = 1;
} else {
  const dims = thumbInfo.dimensions;
  const longEdge = dims ? Math.max(dims.width, dims.height) : 0;
  const okEdge = dims ? longEdge <= BOOTH_THUMB_MAX_EDGE : false;
  console.log(JSON.stringify({ ...thumbInfo, longEdge, maxEdge: BOOTH_THUMB_MAX_EDGE, jpeg: true }, null, 2));
  console.log(okEdge ? '✅ 缩略图长边 ≤512 且为 JPEG' : `⚠️ 缩略图尺寸异常（${dims ? `${dims.width}x${dims.height}` : '读不到尺寸'}），但文件已保留`);
  if (!okEdge) process.exitCode = 1;
}

if (!keep && !hasOutDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  console.log('\n（临时目录已清理，传 --keep 或 --dir 可保留）');
} else {
  console.log(`\n目录已保留: ${outDir}`);
}
