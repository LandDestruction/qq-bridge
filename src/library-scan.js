// src/library-scan.js — 把档案根目录走一遍，交给 library-asset 认成「一件件素材」（BOOTH 素材库 P1/L2）
//
// library-asset.js 是纯规则（不碰磁盘）；这里负责「读盘 + 按目录分组 + 与台账对账」，
// 再把结果整理成前端能直接画的形状。文件系统从参数注入，单测可以喂假 fs。
//
// 为什么不复用 file-archive 的 indexDirMtimes：那个只记目录 mtime 用来判「要不要重扫」，
// 不做文件级列举，也拿不到体积/预览图，素材卡需要的是每个文件。

import path from 'node:path';
import {
  ASSET_RULES_VERSION,
  buildAssets,
  reconcileWithLedger,
  summarizeAssets
} from './library-asset.js';
import {
  assetsFromFilesCached,
  buildScanCache,
  diffScan,
  normalizeScanCache,
  scanCacheHitRate,
  scanEntryOf
} from './library-scan-cache.js';

/** 扫描跳过的目录名：缩略图缓存、系统垃圾、版本库。 */
export const SCAN_SKIP_DIRS = new Set([
  '.git', 'node_modules', '.thumbnails', 'thumbnails', 'thumbs',
  // 素材回收站（console/library-trash.js）：里面的文件已经不是「在库素材」，
  // 再扫进来会让回收站里的东西以素材卡形式出现，恢复/清理都会变乱。
  '.trash',
  '$RECYCLE.BIN', 'System Volume Information', '@eaDir'
]);

/** 扫描跳过的文件名：资源管理器的垃圾文件，不是素材。 */
export const SCAN_SKIP_FILES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

/**
 * 扫描跳过的文件名后缀：下载/备份留下的中间态。
 * - `.part`/`.tmp`：下载到一半的文件（真机见过 `6985553.zip.part` 835KB），不是素材；
 * - `.s3bak`：人工把原包挪走备份的命名（`xx.zip.s3bak`），扫进来会跟原包组成「同号重复卡」。
 */
export const SCAN_SKIP_SUFFIXES = ['.part', '.tmp', '.s3bak'];

/** 隐藏文件/目录（`.` 开头）一律不参与扫盘：`.s3bak/` 备份目录、编辑器的临时文件都在这里。 */
function isHiddenName(name) {
  return name.startsWith('.');
}

function isTempName(lower) {
  return SCAN_SKIP_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** 扫描默认上限：目录深度与文件总数。超过就标 truncated，页面提示「只列了前 N 个」。 */
export const SCAN_DEFAULTS = Object.freeze({ maxDepth: 6, maxFiles: 20000 });

function relJoin(base, name) {
  return base ? `${base}/${name}` : name;
}

/**
 * 走一遍目录：返回每个文件（带相对路径/体积/mtime）与每个非空目录的汇总。
 * 相对路径一律用 `/` 分隔，前端/URL 都不用再处理反斜杠。
 */
export function scanLibraryTree(options = {}) {
  const fs = options.fs;
  const rootDir = String(options.rootDir || '');
  const maxDepth = Number(options.maxDepth) > 0 ? Number(options.maxDepth) : SCAN_DEFAULTS.maxDepth;
  const maxFiles = Number(options.maxFiles) > 0 ? Number(options.maxFiles) : SCAN_DEFAULTS.maxFiles;
  if (!fs || !rootDir) return { files: [], dirs: [], emptyDirs: [], truncated: false, missing: true };

  const files = [];
  const dirs = [];
  const emptyDirs = [];
  let truncated = false;
  // 无 stat 快速模式（?scan=fast）：只信目录 mtime + 可见名字集合，目录内文件不再逐个 stat。
  // 默认关闭：目录 mtime 不变而文件被原地改写时，这个模式看不出来（见 library-scan-cache.js 注释）。
  const dirCache = options.dirCache && typeof options.dirCache === 'object' ? options.dirCache : null;
  const fastScan = options.fastScan === true && Boolean(dirCache);
  // 收集目录元信息（mtime + 可见名字）供下一次快速模式复用；缓存落盘时才需要。
  const collectDirMeta = options.collectDirMeta === true;
  const dirMeta = collectDirMeta ? {} : null;
  let fastHitFiles = 0;
  let fastHitDirs = 0;

  // 目录的「可见名字集合」：过滤规则与下面 walk 完全一致，只用于判断目录内容有没有变过。
  const visibleNames = (entries) => {
    const names = [];
    for (const entry of entries) {
      const name = String(entry.name || '');
      const lower = name.toLowerCase();
      if (entry.isDirectory()) {
        if (isHiddenName(name) || SCAN_SKIP_DIRS.has(lower)) continue;
        names.push(`d:${name}`);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isHiddenName(name) || SCAN_SKIP_FILES.has(lower) || isTempName(lower)) continue;
      names.push(`f:${name}`);
    }
    names.sort();
    return names;
  };
  const sameNames = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);

  const walk = (relDir, depth) => {
    const dirAbs = relDir ? path.join(rootDir, relDir) : rootDir;
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch (error) {
      // 目录读不动（权限/被占用）不该让整页 500：记一条空目录，继续别的。
      emptyDirs.push({ rel: relDir, name: path.basename(relDir) || relDir, reason: String(error?.code || 'unreadable') });
      return;
    }
    const cached = fastScan && dirCache ? dirCache[relDir] : null;
    if (cached && Array.isArray(cached.files)) {
      let dirMtimeMs = 0;
      try { dirMtimeMs = Math.round(Number(fs.statSync(dirAbs).mtimeMs) || 0); } catch { dirMtimeMs = 0; }
      if (dirMtimeMs && dirMtimeMs === Math.round(Number(cached.mtimeMs) || 0) && sameNames(visibleNames(entries), cached.names)) {
        // mtime 与名字都没变：目录内文件的 stat 全省掉（一次 stat 换 N 次），文件信息直接用缓存。
        let count = 0;
        for (const file of cached.files) {
          if (files.length >= maxFiles) { truncated = true; return; }
          files.push({ name: file.name, relPath: file.relPath, dir: relDir, bytes: Math.max(0, Number(file.bytes) || 0), mtime: Number(file.mtime) || 0 });
          count += 1;
          fastHitFiles += 1;
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const name = String(entry.name || '');
          const lower = name.toLowerCase();
          if (isHiddenName(name) || SCAN_SKIP_DIRS.has(lower)) continue;
          if (depth >= maxDepth) { truncated = true; continue; }
          walk(relJoin(relDir, name), depth + 1);
          count += 1;
        }
        fastHitDirs += 1;
        if (!count) emptyDirs.push({ rel: relDir, name: path.basename(relDir) || relDir, reason: 'empty' });
        else dirs.push({ rel: relDir, name: path.basename(relDir) || relDir });
        if (dirMeta) dirMeta[relDir] = { mtimeMs: dirMtimeMs, names: visibleNames(entries) };
        return;
      }
    }
    let count = 0;
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; return; }
      const name = String(entry.name || '');
      const lower = name.toLowerCase();
      if (entry.isDirectory()) {
        // 隐藏目录（`.s3bak`/`.git`/`.trash`…）不进扫盘：里面的东西不是「在库素材」。
        if (isHiddenName(name) || SCAN_SKIP_DIRS.has(lower)) continue;
        if (depth >= maxDepth) { truncated = true; continue; }
        walk(relJoin(relDir, name), depth + 1);
        count += 1;
        continue;
      }
      if (!entry.isFile()) continue;
      // 隐藏文件与下载/备份中间态（`.part`/`.tmp`/`.s3bak`）都不算素材。
      if (isHiddenName(name) || SCAN_SKIP_FILES.has(lower) || isTempName(lower)) continue;
      const relPath = relJoin(relDir, name);
      let stat;
      try {
        stat = fs.statSync(path.join(rootDir, relPath));
      } catch {
        continue;
      }
      files.push({
        name,
        relPath,
        dir: relDir,
        bytes: Math.max(0, Number(stat.size) || 0),
        mtime: Number(stat.mtimeMs) || 0
      });
      count += 1;
    }
    if (!count) emptyDirs.push({ rel: relDir, name: path.basename(relDir) || relDir, reason: 'empty' });
    else dirs.push({ rel: relDir, name: path.basename(relDir) || relDir });
    if (dirMeta) {
      let dirMtimeMs = 0;
      try { dirMtimeMs = Math.round(Number(fs.statSync(dirAbs).mtimeMs) || 0); } catch { dirMtimeMs = 0; }
      dirMeta[relDir] = { mtimeMs: dirMtimeMs, names: visibleNames(entries) };
    }
  };

  walk('', 0);
  // 目录汇总带上文件数与体积：页面「在电脑上的文件夹」和素材卡都用得上。
  const byDir = new Map();
  for (const file of files) {
    const bucket = byDir.get(file.dir) || { files: 0, bytes: 0 };
    bucket.files += 1;
    bucket.bytes += file.bytes;
    byDir.set(file.dir, bucket);
  }
  const dirStats = dirs.map((d) => {
    const bucket = byDir.get(d.rel) || { files: 0, bytes: 0 };
    return { ...d, files: bucket.files, bytes: bucket.bytes };
  });
  const result = { files, dirs: dirStats, emptyDirs, truncated, missing: false };
  if (dirMeta) result.dirMeta = dirMeta;
  if (fastScan) {
    result.fastHitDirs = fastHitDirs;
    result.fastHitFiles = fastHitFiles;
  }
  return result;
}

/** 每个目录单独认件（一件素材 = 同一个下载目录里的包 + 预览图 + 说明）。 */
export function assetsFromFiles(files) {
  const groups = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    const dir = String(file?.dir ?? '');
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(file);
  }
  const assets = [];
  const loose = [];
  const kinds = {};
  for (const [dir, list] of groups) {
    const out = buildAssets({ files: list, dir: path.basename(dir) || dir });
    for (const asset of out.assets) {
      // 认件规则只看同目录，但落盘位置要能回指：件里每个文件都带 relPath，这里补一个目录字段。
      asset.dir = dir;
      assets.push(asset);
    }
    for (const file of out.loose) loose.push({ ...file, dir });
    kinds[out.kind] = (kinds[out.kind] || 0) + 1;
  }
  // 带号的排前面（有号才好抓封面/写回资料），同号按路径稳定排序。
  assets.sort((a, b) => {
    const an = a.boothId ? 0 : 1;
    const bn = b.boothId ? 0 : 1;
    if (an !== bn) return an - bn;
    return String(a.dir).localeCompare(String(b.dir)) || String(a.title).localeCompare(String(b.title));
  });
  return { assets, loose, kinds };
}

/** 素材卡上的封面前端要能直接 <img src>：走 /api/files/raw?rel=（只回图片）。 */
export function assetThumbRel(asset) {
  const previews = Array.isArray(asset?.previews) ? asset.previews : [];
  if (previews.length) return String(previews[0].relPath || '');
  const main = asset?.main;
  if (main && /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(String(main.name || ''))) return String(main.relPath || '');
  return '';
}

// 名字里的可识别信息（解压码 / RJ 号 / 类型标签）由 src/library-tagging.js 提供（retire-console 并行开发）。
// 用动态 import + try/catch：规则模块还没交时扫盘照样能跑（字段给空值），交了这个文件不用改。
// 放扫盘层而不是路由层，是为了让每个吃到卡片的地方（素材页、找号、CLI 巡检）看到同一份事实。
let describeAssetTagsImpl = null;
try {
  const taggingModule = await import('./library-tagging.js');
  describeAssetTagsImpl = typeof taggingModule?.describeAssetTags === 'function'
    ? taggingModule.describeAssetTags
    : null;
} catch {
  describeAssetTagsImpl = null;
}

function tagFieldsOf(asset) {
  if (typeof describeAssetTagsImpl !== 'function') return { archivePassword: '', rjCode: '', tags: [] };
  try {
    const info = describeAssetTagsImpl({
      title: String(asset?.title || ''),
      dir: String(asset?.dir || ''),
      mainName: String(asset?.main?.name || asset?.mainName || '')
    }) || {};
    return {
      archivePassword: String(info.archivePassword || ''),
      rjCode: String(info.rjCode || ''),
      tags: Array.isArray(info.tags) ? info.tags.map((tag) => String(tag || '')).filter(Boolean).slice(0, 8) : []
    };
  } catch {
    return { archivePassword: '', rjCode: '', tags: [] };
  }
}

/** 素材卡：体积、文件数、号、有无说明/预览，前端不用再算。 */
export function assetCard(asset) {
  const thumbRel = assetThumbRel(asset);
  return {
    key: String(asset?.key || ''),
    kind: String(asset?.kind || ''),
    title: String(asset?.title || ''),
    dir: String(asset?.dir || ''),
    boothId: String(asset?.boothId || ''),
    boothSource: String(asset?.boothSource || ''),
    boothCandidates: Array.isArray(asset?.boothCandidates)
      ? asset.boothCandidates.map((c) => ({ id: String(c.id || ''), source: String(c.source || '') }))
      : [],
    files: Array.isArray(asset?.files) ? asset.files.length : 0,
    bytes: Number(asset?.bytes) || 0,
    previews: Array.isArray(asset?.previews) ? asset.previews.length : 0,
    docs: Array.isArray(asset?.docs) ? asset.docs.length : 0,
    hasReadme: Array.isArray(asset?.docs) && asset.docs.length > 0,
    thumbRel,
    thumbUrl: thumbRel ? `/api/files/raw?rel=${encodeURIComponent(thumbRel)}` : '',
    // 封面指纹（dHash）：扫描期只读 state/booth-dhash-cache.json，算力在后台补
    // （见 src/library-dhash.js）。默认空串，前端/重复检测都按「没有指纹」处理。
    dhash: '',
    mainName: String(asset?.main?.name || ''),
    mainBytes: Number(asset?.main?.bytes) || 0,
    rules: Number(asset?.rules) || ASSET_RULES_VERSION,
    // 解压码 / RJ 号 / 类型标签：认出来的名字才填，认不出就是空值（不是 undefined，前端不用判空）。
    ...tagFieldsOf(asset)
  };
}

/**
 * 一次完整快照：扫盘 → 认件 → 与台账对账 → 汇总。
 * rows 传台账行（file_archive，含 content_key / booth_id），没有就只做盘面统计。
 */
export function buildLibrarySnapshot(options = {}) {
  const scan = options.scan || scanLibraryTree(options);
  const grouped = options.grouped || assetsFromFiles(scan.files || []);
  const cards = grouped.assets.map(assetCard);
  const reconciled = reconcileWithLedger(grouped.assets, Array.isArray(options.rows) ? options.rows : []);
  const inLedger = new Set();
  for (const item of reconciled.items) {
    if (item.inLedger) inLedger.add(item.key);
  }
  for (const card of cards) card.inLedger = inLedger.has(card.key);
  // 封面指纹：同步查缓存（dhashLookup 由调用方注入，通常来自 src/library-dhash.js）。
  // 没注入就保持空串——测试和离线工具不需要为此准备缓存文件。
  if (typeof options.dhashLookup === 'function') {
    for (const card of cards) {
      try {
        card.dhash = String(options.dhashLookup(card) || '');
      } catch {
        card.dhash = '';
      }
    }
  }
  const totalBytes = cards.reduce((sum, c) => sum + c.bytes, 0);
  const withBooth = cards.filter((c) => c.boothId);
  const data = {
    ok: true,
    root: String(options.rootDir || ''),
    scannedAt: Date.now(),
    rules: ASSET_RULES_VERSION,
    truncated: Boolean(scan.truncated),
    missing: Boolean(scan.missing),
    count: cards.length,
    bytes: totalBytes,
    fileCount: (scan.files || []).length,
    withBooth: withBooth.length,
    withThumb: cards.filter((c) => c.thumbUrl).length,
    withDhash: cards.filter((c) => c.dhash).length,
    assets: cards,
    loose: grouped.loose.map((f) => ({ name: f.name, relPath: f.relPath, dir: f.dir, bytes: f.bytes })),
    emptyDirs: scan.emptyDirs || [],
    kinds: grouped.kinds,
    // 扫盘原始数（未合并/未改名/未套绑定）；对外响应的 summary 由 view 层 recountAssetSummary 覆盖。
    summary: summarizeAssets({ assets: grouped.assets, loose: grouped.loose, kind: 'mixed' }),
    notInLedger: reconciled.notInLedger.map((x) => ({ key: x.key, title: x.title })),
    missingOnDisk: reconciled.missingOnDisk.map((row) => ({
      id: row?.id ?? null,
      fileName: String(row?.file_name ?? row?.fileName ?? ''),
      contentKey: String(row?.content_key ?? row?.contentKey ?? '')
    }))
  };
  // 增量扫描信息（scanMode / reused / 耗时）由 buildLibrarySnapshotWithCache 注入；
  // 直接调本函数（单测/离线工具）时这两个字段不存在，前端按「没给就是全扫」处理。
  if (options.scanInfo && typeof options.scanInfo === 'object') Object.assign(data, options.scanInfo);
  return data;
}

/**
 * 带增量缓存的快照（素材库 P2）：扫盘照旧（目录必须 walk、文件必须 stat，否则原地改内容
 * 发现不了），但「每个目录认件」这一步按目录签名复用上次结果；缓存同时落盘
 * `state/library-scan-cache.json`（原子写），下次冷启动也能省一轮认件。
 *
 * options 额外字段：
 *   - cacheFile：缓存文件绝对路径（空串 = 不读写缓存，等价旧行为）
 *   - full：true 强制全量（不读缓存、重写缓存；?scan=full / fresh=1 走这里）
 *   - pathImpl：注入 path（默认 node:path）
 */
export function buildLibrarySnapshotWithCache(options = {}) {
  const started = Date.now();
  const fs = options.fs;
  const rootDir = String(options.rootDir || '');
  const cacheFile = String(options.cacheFile || '');
  const pathImpl = options.pathImpl || path;
  let prev = null;
  if (!options.full && cacheFile && fs && typeof fs.readFileSync === 'function') {
    try {
      const normalized = normalizeScanCache(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
      // 根目录换了就不能复用：缓存里的绝对路径/目录归属都对不上了。
      if (normalized && (!rootDir || !normalized.root || normalized.root === rootDir)) prev = normalized;
    } catch {
      prev = null;
    }
  }
  // 无 stat 快速模式的目录索引：上次缓存里每个目录的 {mtimeMs, names, files}。
  // files 直接从 entries 按目录分组得到，不额外落盘，缓存体积不翻倍。
  const fastScan = options.fastScan === true;
  const dirCache = {};
  if (fastScan && prev) {
    const index = {};
    for (const entry of Object.values(prev.entries || {})) {
      const relPath = String(entry?.relPath || '');
      const slash = relPath.lastIndexOf('/');
      const dir = slash >= 0 ? relPath.slice(0, slash) : '';
      const name = slash >= 0 ? relPath.slice(slash + 1) : relPath;
      if (!name) continue;
      (index[dir] || (index[dir] = [])).push({ name, relPath, bytes: Math.max(0, Number(entry.size) || 0), mtime: Number(entry.mtimeMs) || 0 });
    }
    for (const [dir, meta] of Object.entries(prev.dirs || {})) {
      if (!meta || !Number(meta.mtimeMs) || !Array.isArray(meta.names)) continue;
      dirCache[dir] = { mtimeMs: meta.mtimeMs, names: meta.names, files: (index[dir] || []).slice().sort((a, b) => a.name.localeCompare(b.name)) };
    }
  }
  const cacheWrite = cacheFile && fs && typeof fs.writeFileSync === 'function' && options.cacheWrite !== false;
  const scan = scanLibraryTree({ ...options, dirCache, fastScan: fastScan && Object.keys(dirCache).length > 0, collectDirMeta: Boolean(cacheWrite) });
  const entries = (scan.files || []).map((file) => scanEntryOf(file, rootDir, pathImpl));
  const diff = diffScan({ prev: prev ? prev.entries : null, entries });
  const grouped = assetsFromFilesCached(scan.files || [], prev ? prev.dirs : null);
  // 把本次目录 mtime/名字并进 dirsCache，下一次快速模式才能整目录跳过 stat。
  for (const [dir, meta] of Object.entries(scan.dirMeta || {})) {
    const bucket = grouped.dirsCache[dir];
    if (bucket) { bucket.mtimeMs = meta.mtimeMs; bucket.names = meta.names; }
  }
  // 是否真的走了无 stat 快速路径（有目录命中才算）：顶层 scanFast 方便前端/日志直接区分，
  // scanMode 仍只有 incremental|full 两种，不改变语义。
  const scanFastUsed = fastScan && Number(scan.fastHitDirs) > 0;
  const scanInfo = {
    scanMode: prev ? 'incremental' : 'full',
    scanFast: scanFastUsed,
    scanReused: diff.reused.length,
    scan: {
      ms: Date.now() - started,
      cached: Boolean(prev),
      files: entries.length,
      reused: diff.reused.length,
      added: diff.added.length,
      changed: diff.changed.length,
      removed: diff.removed.length,
      dirsReused: grouped.reusedDirs,
      dirsTotal: grouped.totalDirs,
      hitRate: scanCacheHitRate(diff.reused.length, entries.length),
      fastScan: scanFastUsed,
      statSkipped: Number(scan.fastHitFiles) || 0,
      fastDirs: Number(scan.fastHitDirs) || 0
    }
  };
  const data = buildLibrarySnapshot({ ...options, scan, grouped, scanInfo });
  if (cacheWrite) {
    try {
      const cache = buildScanCache({ root: rootDir, entries, dirs: grouped.dirsCache, savedAt: Date.now() });
      const payload = JSON.stringify(cache);
      const tmp = `${cacheFile}.tmp`;
      fs.writeFileSync(tmp, payload, 'utf8');
      if (typeof fs.renameSync === 'function') fs.renameSync(tmp, cacheFile);
      else fs.writeFileSync(cacheFile, payload, 'utf8');
    } catch {
      // 缓存写不进去不影响本次结果：下次 miss 就再全扫一遍。
    }
  }
  return data;
}
