// src/library-dhash.js — 素材卡封面指纹（dHash）的落盘缓存 + 后台补算
//
// 背景：卡片的 dhash 以前只在「以图搜源」链路按需算，从没进过 /api/library/assets 快照，
// 于是重复检测的「封面近似」永远 0 组。而快照是同步构建的（library-scan.js），算 dhash 要
// 起 ffmpeg、是异步的，所以分工：扫描期只读缓存（lookup，同步）；算力放后台循环
// （startLoop，启动 8s 后第一轮、之后每 5 分钟），失败只记日志，不阻塞桥接。
//
// 缓存落 state/booth-dhash-cache.json：键 `${size}:${mtimeMs}`（文件变了自动失效），值 16 位
// hex；LRU 上限 5000，原子写。只算本地图（缩略图 / 本地缓存的 BOOTH 封面），cloud 卡绝不下载。

import { readFileSync, statSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { dhashFromBufferAsync } from './image-hash.js';

export const DHASH_CACHE_LIMIT = 5000;
export const DHASH_CACHE_FILE = 'booth-dhash-cache.json';
/** 并发 4：ffmpeg 起 4 个已经能吃满一个核，再高只会互相抢。 */
export const DHASH_CONCURRENCY = 4;
/** 单件预算 300ms：缩略图都很小，算不出来基本就是坏图，别拖住整轮。 */
export const DHASH_BUDGET_MS = 300;

/** dHash 是 64 bit（16 位 hex）；放宽下限是为了兼容老实现写过的短串。 */
const HASH_RE = /^[0-9a-f]{8,16}$/;
/** 认得出才读：ffmpeg 能解的图片格式（不含视频/压缩包）。 */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.jfif']);

/** 缓存键：体积 + mtime（取整毫秒）。两者任一变了就重算。 */
export function dhashCacheKey(stat) {
  if (!stat) return '';
  const size = Number(stat.size) || 0;
  let mtime = Number(stat.mtimeMs);
  if (!Number.isFinite(mtime)) mtime = stat.mtime ? new Date(stat.mtime).getTime() : 0;
  const mtimeMs = Math.round(mtime) || 0;
  if (!size && !mtimeMs) return '';
  return `${size}:${mtimeMs}`;
}

/** 是不是一张（ffmpeg 能读的）图片，按扩展名判，绝不打开文件。 */
export function isImageFile(filePath) {
  const name = String(filePath || '');
  const dot = name.lastIndexOf('.');
  return dot >= 0 && IMAGE_EXT.has(name.slice(dot).toLowerCase());
}

/** 算一张本地图片的 dHash：非图片/读不到/算失败/超预算一律回 ''，绝不抛。 */
export async function dhashFromImageFile(filePath, options = {}) {
  const readFile = options.readFile || readFileAsync;
  const dhashBuffer = options.dhashBuffer || dhashFromBufferAsync;
  const budgetMs = Math.max(50, Number(options.budgetMs) || DHASH_BUDGET_MS);
  if (!filePath || !isImageFile(filePath)) return '';
  let buf;
  try {
    buf = await readFile(filePath);
  } catch {
    return '';
  }
  if (!buf || !buf.length) return '';
  let timer = null;
  try {
    // 双保险：实现自身带 ffmpeg 超时，这里再套总预算，防止注入的实现忘了超时拖死整轮。
    const budget = new Promise((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); });
    const hash = await Promise.race([Promise.resolve().then(() => dhashBuffer(buf, { timeoutMs: budgetMs })), budget]);
    return typeof hash === 'string' && HASH_RE.test(hash) ? hash : '';
  } catch {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function trimSlash(dir) {
  return String(dir || '').replace(/[\\/]+$/, '');
}

/**
 * 卡片对应的本地图片绝对路径：缩略图（相对档案根）优先，其次本地缓存的 BOOTH 封面
 * （调用方注入 boothCoverPath，只查本地缓存，不联网）。都没有就 ''。
 */
export function dhashFileOf(card, options = {}) {
  const rootDir = trimSlash(options.rootDir);
  const thumbRel = String(card?.thumbRel || '').replace(/\\/g, '/');
  if (thumbRel && rootDir) return `${rootDir}/${thumbRel}`;
  const boothId = String(card?.boothId || '');
  if (/^\d{5,12}$/.test(boothId) && typeof options.boothCoverPath === 'function') {
    try {
      return trimSlash(options.boothCoverPath(boothId)) || '';
    } catch {
      return '';
    }
  }
  return '';
}

/** 缓存对象：Map 的插入顺序即 LRU 顺序（最近的在后）；构造期不碰盘，第一次用时才读。 */
export function createDhashCache(options = {}) {
  const stateDir = trimSlash(options.stateDir || 'state') || 'state';
  const file = `${stateDir}/${DHASH_CACHE_FILE}`;
  const limit = Math.max(1, Number(options.limit) || DHASH_CACHE_LIMIT);
  const writeJson = options.writeJson;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const fs = options.fs || null;
  const readText = options.readText
    || ((p) => (fs && typeof fs.readFileSync === 'function' ? fs.readFileSync(p, 'utf8') : readFileSync(p, 'utf8')));
  const entries = new Map();
  let loaded = false;
  let dirty = false;

  function trim() {
    while (entries.size > limit) entries.delete(entries.keys().next().value);
  }

  function load() {
    if (loaded) return;
    loaded = true;
    let data = null;
    try {
      data = JSON.parse(String(readText(file) || ''));
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`[素材库] dhash 缓存文件坏了，重建：${file}`);
      return; // 第一次没有缓存文件是最正常的情况
    }
    const map = data && typeof data.entries === 'object' && data.entries ? data.entries : {};
    const order = Array.isArray(data?.order) ? data.order : Object.keys(map);
    for (const key of [...order, ...Object.keys(map)]) {
      const hash = map[key];
      if (!key || entries.has(key) || typeof hash !== 'string' || !HASH_RE.test(hash)) continue;
      entries.set(String(key), hash);
    }
    trim();
  }

  function save() {
    load();
    if (!dirty) return false;
    if (typeof writeJson !== 'function') {
      dirty = false;
      return false;
    }
    try {
      writeJson(file, { version: 1, savedAt: new Date().toISOString(), entries: Object.fromEntries(entries), order: Array.from(entries.keys()) });
      dirty = false;
      return true;
    } catch (error) {
      log(`[素材库] dhash 缓存写入失败：${error?.message || error}`);
      return false;
    }
  }

  return {
    file,
    limit,
    load,
    save,
    size() { load(); return entries.size; },
    has(key) { load(); return entries.has(String(key || '')); },
    get(key) {
      load();
      const k = String(key || '');
      if (!k) return '';
      const hash = entries.get(k);
      if (!hash) return '';
      entries.delete(k); // 摸一下 = 最近用过：挪到队尾，序列化顺序自然就是 LRU 顺序
      entries.set(k, hash);
      return hash;
    },
    set(key, hash) {
      load();
      const k = String(key || '');
      if (!k || typeof hash !== 'string' || !HASH_RE.test(hash)) return false;
      entries.delete(k);
      entries.set(k, hash);
      trim();
      dirty = true;
      return true;
    },
    // 测试用：看内部顺序，验证 LRU 淘汰是不是真的淘汰最老的。
    keys() { load(); return Array.from(entries.keys()); }
  };
}

/** 入库侧：查缓存（同步，快照期用）+ 补算（异步）+ 后台循环。 */
export function createLibraryDhash(options = {}) {
  const cache = options.cache || createDhashCache(options);
  const log = typeof options.log === 'function' ? options.log : () => {};
  const concurrency = Math.max(1, Number(options.concurrency) || DHASH_CONCURRENCY);
  const budgetMs = Math.max(50, Number(options.budgetMs) || DHASH_BUDGET_MS);
  const readFile = options.readFile || readFileAsync;
  const dhashBuffer = options.dhashBuffer || dhashFromBufferAsync;
  const statFile = options.statFile || ((p) => statSync(p));

  function keyOf(file) {
    if (!file) return '';
    try {
      return dhashCacheKey(statFile(file));
    } catch {
      return '';
    }
  }

  function lookup(card, opts = {}) {
    const key = keyOf(dhashFileOf(card, opts));
    return key ? cache.get(key) : '';
  }

  async function fillCards(cards, opts = {}) {
    const list = Array.isArray(cards) ? cards : [];
    const result = { cards: list, targets: 0, cached: 0, computed: 0, failed: 0, withDhash: 0, skipped: 0 };
    const jobs = [];
    for (const card of list) {
      const file = dhashFileOf(card, opts);
      if (!file) continue;
      const key = keyOf(file);
      if (!key) continue;
      result.targets += 1;
      if (cache.get(key)) {
        result.cached += 1;
        continue;
      }
      jobs.push({ file, key });
    }
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= jobs.length) return;
        const job = jobs[index];
        const hash = await dhashFromImageFile(job.file, { readFile, dhashBuffer, budgetMs });
        if (hash) {
          cache.set(job.key, hash);
          result.computed += 1;
        } else {
          result.failed += 1;
        }
        if (typeof opts.onProgress === 'function') {
          try {
            opts.onProgress({ done: result.computed + result.failed, total: jobs.length });
          } catch {}
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
    if (result.computed > 0) cache.save();
    result.withDhash = result.cached + result.computed;
    result.skipped = Math.max(0, list.length - result.targets);
    return result;
  }

  /** 后台补算循环：getRoot()/getCards(root) 每轮现取（用户可能在设置里换档案根）。 */
  function startLoop(loopOptions = {}) {
    const getRoot = typeof loopOptions.getRoot === 'function' ? loopOptions.getRoot : () => '';
    const getCards = typeof loopOptions.getCards === 'function' ? loopOptions.getCards : () => [];
    const startDelayMs = Math.max(1000, Number(loopOptions.startDelayMs) || 8000);
    const intervalMs = Math.max(60000, Number(loopOptions.intervalMs) || 300000);
    const setTimeoutImpl = loopOptions.setTimeoutImpl || setTimeout;
    const setIntervalImpl = loopOptions.setIntervalImpl || setInterval;
    const clearTimeoutImpl = loopOptions.clearTimeoutImpl || clearTimeout;
    const clearIntervalImpl = loopOptions.clearIntervalImpl || clearInterval;
    let running = false;

    async function runOnce() {
      if (running) return { skipped: true, reason: 'running' };
      running = true;
      try {
        const rootDir = trimSlash(getRoot());
        if (!rootDir) return { skipped: true, reason: 'no_root' };
        const stats = await fillCards(getCards(rootDir) || [], { rootDir, boothCoverPath: loopOptions.boothCoverPath });
        if (stats.computed > 0) {
          log(`[素材库] 封面 dhash 补算：新算 ${stats.computed} 件，缓存命中 ${stats.cached} 件，失败 ${stats.failed} 件`);
        }
        return stats;
      } catch (error) {
        log(`[素材库] 封面 dhash 补算失败：${error?.message || error}`);
        return null;
      } finally {
        running = false;
      }
    }

    const first = setTimeoutImpl(() => { runOnce().catch(() => {}); }, startDelayMs);
    const timer = setIntervalImpl(() => { runOnce().catch(() => {}); }, intervalMs);
    for (const handle of [first, timer]) {
      try { handle?.unref?.(); } catch {}
    }
    return {
      runOnce,
      stop() {
        try { clearTimeoutImpl(first); } catch {}
        try { clearIntervalImpl(timer); } catch {}
      }
    };
  }

  return { cache, lookup, fillCards, startLoop };
}
