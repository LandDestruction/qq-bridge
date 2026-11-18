// 表情缩略图缓存的清理/修复计划（纯函数，不碰 fs/网络）。
// 背景：state/sticker-files 超过 cacheMaxMb 后，新表情一律落盘失败并标 thumbStatus:'missing'；
// 里面还混着大量「库已删、文件还在」的孤儿，以及一批没有 md5 的条目（旧逻辑永不重试）→ 需要可计算的清理与重试计划。

export const THUMB_RETRYABLE_REASONS = Object.freeze(new Set(['cache-limit', 'evicted']));
export const STICKER_CACHE_KEEP_RATIO = 0.9;
export const STICKER_CACHE_MIN_AGE_MS = 3600000;
export const STICKER_REPAIR_DEFAULT_LIMIT = 20;
export const STICKER_REPAIR_MAX_LIMIT = 200;

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
// limitBytes 为 0 / 非法 = 「没配上上限」，不能当成「上限 0，必须全删」。
const cacheLimitOf = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
};
const md5OfName = (name) => {
  const text = String(name ?? '').trim();
  const dot = text.lastIndexOf('.');
  return (dot > 0 ? text.slice(0, dot) : text).toLowerCase();
};
const entryListOf = (entries) => {
  if (Array.isArray(entries)) return entries.map((entry, index) => ({ key: String(entry?.key ?? entry?.id ?? index), entry }));
  if (entries && typeof entries === 'object') return Object.entries(entries).map(([key, entry]) => ({ key, entry }));
  return [];
};
const md5OfEntry = (entry) => String(entry?.md5 ?? entry?.fileMd5 ?? '').trim().toLowerCase();
const lastUsedOf = (entry) => num(entry?.lastUsedAt) || num(entry?.updatedAt) || 0;

// 文件名里的 md5 就是缓存键；调用方只给了 name 时按去扩展名兜底。
function fileListOf(files) {
  const list = Array.isArray(files) ? files : [];
  return list.map((file) => ({
    name: String(file?.name ?? ''),
    md5: String(file?.md5 ?? '').trim().toLowerCase() || md5OfName(file?.name),
    bytes: Math.max(0, num(file?.bytes)),
    mtimeMs: num(file?.mtimeMs)
  })).filter((file) => file.md5);
}

export function planStickerCacheCleanup({ entries = [], files = [], limitBytes = 0, minAgeMs = STICKER_CACHE_MIN_AGE_MS, now = Date.now() } = {}) {
  const records = entryListOf(entries);
  const entryByMd5 = new Map();
  for (const { key, entry } of records) {
    const md5 = md5OfEntry(entry);
    if (md5) entryByMd5.set(md5, { key: String(entry?.key ?? key), entry });
  }
  const list = fileListOf(files);
  const totalBytes = list.reduce((sum, file) => sum + file.bytes, 0);
  const ageMs = num(minAgeMs) > 0 ? num(minAgeMs) : 0;
  const nowMs = num(now) || Date.now();
  // limitBytes 为 0 / 非法 = 「没配上限」，不当作「上限 0 必须全删」。
  const limit = cacheLimitOf(limitBytes);

  const orphanFiles = [];
  const liveFiles = [];
  for (const file of list) {
    // 刚写入的文件先保护：并发落盘时别被这一轮清理删掉。minAgeMs=0 表示不做这层保护。
    const stale = ageMs === 0 ? true : nowMs - file.mtimeMs > ageMs;
    if (!entryByMd5.has(file.md5) && stale) orphanFiles.push(file);
    else liveFiles.push(file);
  }

  let removedBytes = orphanFiles.reduce((sum, file) => sum + file.bytes, 0);
  let keepBytes = totalBytes - removedBytes;
  const lruFiles = [];
  const reachedTarget = () => keepBytes <= limit * STICKER_CACHE_KEEP_RATIO;
  if (keepBytes > limit && !reachedTarget()) {
    const ranked = liveFiles
      .map((file) => ({ file, used: lastUsedOf(entryByMd5.get(file.md5)?.entry) }))
      .sort((a, b) => (a.used - b.used) || (a.file.mtimeMs - b.file.mtimeMs) || (a.file.md5 < b.file.md5 ? -1 : 1));
    for (const item of ranked) {
      if (reachedTarget()) break;
      // 孤儿已在上一步删掉，这里只动「库里还在」的文件（LRU：最久没用先删）。
      lruFiles.push(item.file);
      removedBytes += item.file.bytes;
      keepBytes -= item.file.bytes;
    }
  }

  const evictedKeys = [
    ...orphanFiles.map((file) => ({ md5: file.md5, key: entryByMd5.get(file.md5)?.key ?? '', reason: 'orphan' })),
    ...lruFiles.map((file) => ({ md5: file.md5, key: entryByMd5.get(file.md5)?.key ?? '', reason: 'lru' }))
  ];
  return {
    orphanFiles,
    lruFiles,
    keepBytes,
    freedBytes: removedBytes,
    evictedKeys,
    totalBytes,
    limitBytes: Number.isFinite(limit) ? limit : 0,
    overLimit: keepBytes > limit
  };
}

function needsRetryOf(entry) {
  const status = String(entry?.thumbStatus ?? '');
  const md5 = md5OfEntry(entry);
  const url = String(entry?.url ?? entry?.thumbUrl ?? '').trim();
  if (status === 'missing') {
    const kind = String(entry?.thumbErrorKind ?? '').trim() || describeThumbError(entry?.thumbError);
    if (THUMB_RETRYABLE_REASONS.has(kind)) return { priority: 1, reason: kind };
    if (!md5) return { priority: 2, reason: 'no-md5' };
  }
  return null;
}

export function nextThumbRepairPlan({ entries = [], limit = STICKER_REPAIR_DEFAULT_LIMIT, hasCached = null } = {}) {
  // limit 不传/非法才回落默认值；显式 0 表示「这次不修」，不能悄悄放大成 20。
  const rawLimit = limit === null || limit === undefined || limit === '' ? STICKER_REPAIR_DEFAULT_LIMIT : Math.floor(num(limit));
  const max = Math.min(STICKER_REPAIR_MAX_LIMIT, Math.max(0, rawLimit));
  // 这次不修就别扫了（也避免 max=0 时「先塞一条再 break」的 off-by-one）。
  if (max === 0) return { items: [], total: 0, truncated: false, limit: 0 };
  const candidates = [];
  for (const { key, entry } of entryListOf(entries)) {
    const md5 = md5OfEntry(entry);
    const url = String(entry?.url ?? entry?.thumbUrl ?? '').trim();
    // 既没有远程地址、也没有本地指纹：重试也没意义，跳过（旧逻辑就是在这里无限空转）。
    if (!url && !md5) continue;
    const retry = needsRetryOf(entry);
    let priority = retry?.priority ?? 0;
    let reason = retry?.reason ?? '';
    if (!priority) {
      // ③ 标记 ok 但本地文件没了（缓存被手删/迁移/清盘）：也要补，否则面板永远显示 ok 却打不开。
      const status = String(entry?.thumbStatus ?? '');
      if (status === 'ok' && md5 && typeof hasCached === 'function' && !hasCached(md5)) { priority = 3; reason = 'file-gone'; }
    }
    if (!priority) continue;
    candidates.push({ key, md5, url, priority, reason, entry });
  }
  const seen = new Set();
  const picked = [];
  for (const item of candidates.sort((a, b) => (a.priority - b.priority) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    const dedupe = item.md5 || item.key;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    picked.push({ key: item.key, md5: item.md5, url: item.url, priority: item.priority, reason: item.reason });
    if (picked.length >= max) break;
  }
  return { items: picked, total: candidates.length, truncated: candidates.length > picked.length, limit: max };
}

export function describeThumbError(text) {
  const raw = String(text ?? '').trim().toLowerCase();
  if (!raw) return 'other';
  if (/缓存已达上限|达到上限|超出上限|capacity|disk quota|cache limit|no space|enospc/i.test(raw)) return 'cache-limit';
  if (/淘汰|evict|expired-by-lru|rotat|轮换/i.test(raw)) return 'evicted';
  if (/过期|失效|expired|410 gone|403 forbidden|forbidden|signature/i.test(raw)) return 'expired-url';
  if (/网络|超时|连接|timeout|timed out|econn|enotfound|eai_again|e?noent|dns|socket|reset|fetch failed/i.test(raw)) return 'network';
  return 'other';
}

export function normalizeStickerCacheStats({ entries = [], files = [], limitBytes = 0 } = {}) {
  const records = entryListOf(entries);
  const list = fileListOf(files);
  const bytes = list.reduce((sum, file) => sum + file.bytes, 0);
  const limit = cacheLimitOf(limitBytes);
  const md5Set = new Set(list.map((file) => file.md5));
  let withThumb = 0;
  let missing = 0;
  let retryable = 0;
  for (const { entry } of records) {
    const status = String(entry?.thumbStatus ?? '');
    const md5 = md5OfEntry(entry);
    // 「有缩略图」以实际文件为准：条目没 md5 时只能信状态，有 md5 时必须文件在。
    if (status === 'ok' && (!md5 || md5Set.has(md5))) withThumb += 1;
    if (status === 'missing') {
      missing += 1;
      const kind = String(entry?.thumbErrorKind ?? '').trim() || describeThumbError(entry?.thumbError);
      const url = String(entry?.url ?? entry?.thumbUrl ?? '').trim();
      if (!url && !md5) continue;
      if (THUMB_RETRYABLE_REASONS.has(kind) || !md5) retryable += 1;
    }
  }
  const orphanFiles = list.filter((file) => !records.some(({ entry }) => md5OfEntry(entry) === file.md5)).length;
  // limitBytes 没配（0/非法）时 usageRatio 记 Infinity：面板显示「不设上限」，别算成 0%。
  const usageRatio = Number.isFinite(limit) ? Number((bytes / limit).toFixed(4)) : Infinity;
  return {
    entries: records.length,
    withThumb,
    missing,
    retryable,
    orphanFiles,
    bytes,
    limitBytes: Number.isFinite(limit) ? limit : 0,
    usageRatio,
    overLimit: Number.isFinite(limit) ? bytes > limit : false
  };
}
