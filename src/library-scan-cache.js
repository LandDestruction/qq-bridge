// src/library-scan-cache.js — 素材库「增量扫描」缓存（P2）
//
// 问题：每次打开素材页 / 调 /api/library/assets 都要把 2.5GB 的库整个走一遍：
//   读目录（readdir）→ 逐个文件 stat → 每目录认件（buildAssets 里一堆名字规则/正则）→
//   算标签（library-tagging）→ 查 dhash 缓存。库越大，这段纯 CPU 越浪费。
//
// 思路（与文件系统无关的规则都放这里，落盘由 library-scan.js 注入 fs 完成）：
//   1. 缓存上次扫到的「文件路径 → size + mtime」以及「每个目录认出来的件 + 散件」；
//   2. 本次仍会 walk 一遍目录、仍然 stat 每个文件 —— 这是**正确性代价**：
//      目录 mtime 只在增删/改名时变，原地改内容（比如重新下载覆盖同名包）不会变目录 mtime，
//      不 stat 就会漏掉变化。所以「目录级跳过」的判定不用目录 mtime，而用
//      **目录内每个文件的 name+size+mtime 签名**（比目录 mtime 严格，原地改也能发现）；
//   3. 签名没变的目录直接复用上次认出来的件，省掉 buildAssets/标签解析的 CPU
//      （这部分是纯函数，不需要再碰盘）。
//
// 缓存文件 `state/library-scan-cache.json`：带 version/rules，版本不符整份丢弃（宁可全扫一次，
// 也不要把旧规则的认件结果喂给新版本），坏 JSON 同样当没有缓存。
//
// 这里只做纯规则：不 import node:fs，不做 IO。落盘/读盘在 library-scan.js（fs 由参数注入）。
import { ASSET_RULES_VERSION, buildAssets } from './library-asset.js';

/** 缓存格式版本：改了字段含义/认件规则耦合关系就 +1，旧缓存整份丢弃。 */
export const SCAN_CACHE_VERSION = 1;
export const SCAN_CACHE_FILE = 'library-scan-cache.json';
/** 上限保护：缓存文件不该无限长（几千目录的库也够用）。 */
export const SCAN_CACHE_MAX_DIRS = 5000;

/** 一条文件缓存：绝对路径 → size/mtime。sha 留给将来「内容确实变了但 size+mtime 没变」的极端情况。 */
export function scanEntryOf(file, rootDir, pathImpl) {
  const relPath = String(file?.relPath || '');
  const absPath = rootDir ? (pathImpl ? pathImpl.join(rootDir, relPath) : `${rootDir}/${relPath}`) : relPath;
  return {
    path: absPath,
    relPath,
    size: Math.max(0, Number(file?.bytes ?? file?.size) || 0),
    mtimeMs: Math.round(Number(file?.mtime ?? file?.mtimeMs) || 0)
  };
}

/**
 * 目录签名：目录内每个文件的 name + size + mtime。
 * 为什么不用目录 mtime：目录 mtime 只在「条目增删/改名」时更新，原地覆盖同名文件时不变。
 * 签名排序后拼接，保证同样内容得到同样签名。
 */
export function dirSignatureOf(files) {
  const lines = (Array.isArray(files) ? files : []).map((file) => {
    const name = String(file?.name || '');
    const size = Math.max(0, Number(file?.bytes ?? file?.size) || 0);
    const mtime = Math.round(Number(file?.mtime ?? file?.mtimeMs) || 0);
    return `${name}|${size}|${mtime}`;
  });
  lines.sort();
  return lines.join('\n');
}

/** 是否「看起来像」本模块写出的缓存（结构/版本不对就整份丢掉）。 */
export function normalizeScanCache(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (Number(raw.version) !== SCAN_CACHE_VERSION) return null;
  if (Number(raw.rules) !== ASSET_RULES_VERSION) return null;
  if (!raw.entries || typeof raw.entries !== 'object') return null;
  const entries = {};
  for (const [key, value] of Object.entries(raw.entries)) {
    if (!key || !value || typeof value !== 'object') continue;
    entries[key] = {
      size: Math.max(0, Number(value.size) || 0),
      mtimeMs: Math.round(Number(value.mtimeMs) || 0),
      // 相对路径：无 stat 快速模式按目录分组用（老缓存没有就退化成不快速）。
      relPath: String(value.relPath || '')
    };
  }
  const dirs = {};
  const rawDirs = raw.dirs && typeof raw.dirs === 'object' ? raw.dirs : {};
  let dirCount = 0;
  for (const [dir, value] of Object.entries(rawDirs)) {
    if (dirCount >= SCAN_CACHE_MAX_DIRS) break;
    if (!value || typeof value !== 'object') continue;
    if (typeof value.sig !== 'string') continue;
    if (!Array.isArray(value.assets) || !Array.isArray(value.loose)) continue;
    dirs[dir] = {
      sig: value.sig,
      kind: String(value.kind || ''),
      assets: value.assets.filter((item) => item && typeof item === 'object'),
      loose: value.loose.filter((item) => item && typeof item === 'object')
    };
    // 目录元信息（mtime + 可见名字）只在「无 stat 快速模式」用；老缓存没有就跳过快速复用。
    if (Number.isFinite(Number(value.mtimeMs)) && Array.isArray(value.names)) {
      dirs[dir].mtimeMs = Math.round(Number(value.mtimeMs) || 0);
      dirs[dir].names = value.names.filter((name) => typeof name === 'string');
    }
    dirCount += 1;
  }
  return {
    version: SCAN_CACHE_VERSION,
    rules: ASSET_RULES_VERSION,
    root: String(raw.root || ''),
    savedAt: Number(raw.savedAt) || 0,
    entries,
    dirs
  };
}

/**
 * 比较上次缓存与本次盘面：返回 added / changed / removed / reused。
 * entries：`scanEntryOf` 生成的数组（绝对路径 + size + mtime）。
 */
export function diffScan({ prev, entries } = {}) {
  const prevEntries = prev && typeof prev === 'object' ? prev : {};
  const added = [];
  const changed = [];
  const reused = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = String(entry?.path || '');
    if (!key) continue;
    seen.add(key);
    const old = prevEntries[key];
    if (!old) { added.push(key); continue; }
    if (Number(old.size) !== Number(entry.size) || Math.round(Number(old.mtimeMs) || 0) !== Math.round(Number(entry.mtimeMs) || 0)) changed.push(key);
    else reused.push(key);
  }
  const removed = Object.keys(prevEntries).filter((key) => !seen.has(key));
  return { added, changed, removed, reused };
}

/** 把本次盘面整理成新的缓存对象（纯函数；落盘由调用方写）。 */
export function buildScanCache({ root, entries, dirs, savedAt } = {}) {
  const nextEntries = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = String(entry?.path || '');
    if (!key) continue;
    nextEntries[key] = {
      size: Math.max(0, Number(entry.size) || 0),
      mtimeMs: Math.round(Number(entry.mtimeMs) || 0),
      relPath: String(entry.relPath || '')
    };
  }
  const nextDirs = {};
  let count = 0;
  for (const [dir, value] of Object.entries(dirs && typeof dirs === 'object' ? dirs : {})) {
    if (count >= SCAN_CACHE_MAX_DIRS) break;
    if (!value || typeof value !== 'object') continue;
    if (typeof value.sig !== 'string') continue;
    nextDirs[dir] = {
      sig: value.sig,
      kind: String(value.kind || ''),
      assets: Array.isArray(value.assets) ? value.assets : [],
      loose: Array.isArray(value.loose) ? value.loose : []
    };
    // 快速模式复用所需的目录 mtime + 可见名字（旧结构没有也不报错，只是退化成逐个 stat）。
    if (Number.isFinite(Number(value.mtimeMs)) && Array.isArray(value.names)) {
      nextDirs[dir].mtimeMs = Math.round(Number(value.mtimeMs) || 0);
      nextDirs[dir].names = value.names.filter((name) => typeof name === 'string');
    }
    count += 1;
  }
  return {
    version: SCAN_CACHE_VERSION,
    rules: ASSET_RULES_VERSION,
    root: String(root || ''),
    savedAt: Number(savedAt) || Date.now(),
    entries: nextEntries,
    dirs: nextDirs
  };
}

/**
 * 按目录认件，签名没变的目录直接复用上次结果。
 * 返回 { assets, loose, kinds, dirsCache, reusedDirs, totalDirs, reusedFiles, totalFiles }。
 * 注意复用出来的 asset 对象来自缓存（JSON 反序列化），调用方只读不改；快照层会重新生成卡片。
 */
export function assetsFromFilesCached(files, prevDirs) {
  const groups = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    const dir = String(file?.dir ?? '');
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(file);
  }
  const dirsCache = {};
  const assets = [];
  const loose = [];
  const kinds = {};
  let reusedDirs = 0;
  let reusedFiles = 0;
  let totalFiles = 0;
  const prev = prevDirs && typeof prevDirs === 'object' ? prevDirs : {};
  for (const [dir, list] of groups) {
    totalFiles += list.length;
    const sig = dirSignatureOf(list);
    const cached = Object.prototype.hasOwnProperty.call(prev, dir) ? prev[dir] : null;
    if (cached && cached.sig === sig) {
      for (const asset of cached.assets) assets.push(asset);
      for (const item of cached.loose) loose.push(item);
      const kind = String(cached.kind || '');
      if (kind) kinds[kind] = (kinds[kind] || 0) + 1;
      dirsCache[dir] = cached;
      reusedDirs += 1;
      reusedFiles += list.length;
      continue;
    }
    const out = buildAssets({ files: list, dir: dir.split('/').pop() || dir });
    for (const asset of out.assets) {
      asset.dir = dir;
      assets.push(asset);
    }
    for (const file of out.loose) loose.push({ ...file, dir });
    kinds[out.kind] = (kinds[out.kind] || 0) + 1;
    dirsCache[dir] = { sig, kind: out.kind, assets: out.assets, loose: out.loose.map((file) => ({ ...file, dir })) };
  }
  assets.sort((a, b) => {
    const an = a.boothId ? 0 : 1;
    const bn = b.boothId ? 0 : 1;
    if (an !== bn) return an - bn;
    return String(a.dir).localeCompare(String(b.dir)) || String(a.title).localeCompare(String(b.title));
  });
  return { assets, loose, kinds, dirsCache, reusedDirs, totalDirs: groups.size, reusedFiles, totalFiles };
}

/**
 * 缓存命中率：`reused / total`（0~1）。给日志/响应里的 reused 计数用，纯展示。
 */
export function scanCacheHitRate(reused, total) {
  const all = Math.max(0, Number(total) || 0);
  if (!all) return 0;
  const hit = Math.max(0, Number(reused) || 0);
  return Math.min(1, hit / all);
}
