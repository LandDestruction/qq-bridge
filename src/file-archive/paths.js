// file-archive/paths.js — 路径安全 + 命名 + 原子写 + 自写记账 + fileOpsMu 互斥锁
// 纯搬运自 src/file-archive.js（D61 拆分）：函数体/注释逐字保留，只做模块化与 import/export。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { UNCLASSIFIED_DIR } from './common.js';

/**
 * 路径校验：只收**相对路径**。拒绝空串、空段、`.`、`..`、盘符与绝对路径、NUL。
 * 错误文案里对越界一律带「转存目录之外」，与安全测试的历史约定保持一致。
 */
export function validateArchiveRelPath(relPath) {
  const raw = String(relPath ?? '').trim();
  if (!raw) throw new Error('拒绝访问转存目录之外的路径：（空路径）');
  if (raw.includes('\u0000')) throw new Error(`拒绝访问转存目录之外的路径：${raw}`);
  if (/^[A-Za-z]:/.test(raw) || /^[\\/]/.test(raw)) throw new Error(`拒绝访问转存目录之外的路径（绝对路径）：${raw}`);
  // 空段：`a//b` 这种连续分隔符会被正则折叠掉，必须在 split 之前单独判（结尾分隔符同理）。
  if (/[\\/]{2}/.test(raw) || /[\\/]$/.test(raw)) throw new Error(`拒绝访问转存目录之外的路径（空段）：${raw}`);
  const segs = raw.split(/[\\/]+/);
  if (segs.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`拒绝访问转存目录之外的路径：${raw}`);
  }
  return segs.join('/');
}

/** 父目录（相对路径）；根目录返回空串（兼容 `path.dirname('a.txt') === '.'`）。 */
export function parentDirRel(relPath) {
  const rel = validateArchiveRelPath(relPath);
  const dir = path.posix.dirname(rel);
  return dir === '.' ? '' : dir;
}

/** 解析 `dir`：相对路径按 ROOT 解析，绝对路径原样（调用方负责别把它指到系统目录）。 */
export function resolveArchiveRoot(root, dir) {
  const d = String(dir || 'state/files');
  return path.isAbsolute(d) ? path.normalize(d) : path.resolve(root, d);
}

/**
 * 纵深防御：台账里的 rel_path 只可能在 rootDir 之内。
 * （历史数据被手工改过 / 群号带 `..` 时，也绝不删 rootDir 之外的东西。）
 */
export function safeResolveInside(rootDir, relPath) {
  const root = path.resolve(rootDir);
  // P0：先做相对路径校验（空段/`.`/`..`/绝对路径/盘符一律拒），再做包含性兜底。
  const rel = validateArchiveRelPath(relPath);
  const abs = path.resolve(root, rel);
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(withSep)) {
    throw new Error(`拒绝访问转存目录之外的路径：${relPath}`);
  }
  return abs;
}

/**
 * 把任意 rel 路径归一成正斜杠形式。
 * 为什么需要：台账里的历史行是 `path.join` 出来的**反斜杠**（Windows），而回收站/恢复/去重
 * 内部一律用 posix。用 `path.posix.basename` 直接处理反斜杠会把整条路径当成文件名，
 * 造出 `.回收站/<批次>/群/月份/群/月份/文件名` 这种双层目录（踩过）。
 */
export function toPosixRel(relPath) {
  return String(relPath ?? '').split(/[\\/]+/).filter(Boolean).join('/');
}

// ── 原子写 + 自写记账 ──────────────────────────────────────────────────────
/** 最近由**我们自己**写过的绝对路径：扫描时用它过滤"自己的写"，避免自激重扫/重归档。 */
const OWN_WRITES = new Map();

export const OWN_WRITE_TTL_MS = 60_000;

export function recordOwnWrite(absPath, atMs = Date.now()) {
  try { OWN_WRITES.set(path.resolve(String(absPath)), Number(atMs) || Date.now()); } catch {}
}

export function isOwnWrite(absPath, { withinMs = OWN_WRITE_TTL_MS, nowMs = Date.now() } = {}) {
  let abs;
  try { abs = path.resolve(String(absPath)); } catch { return false; }
  const at = OWN_WRITES.get(abs);
  if (!at) return false;
  return Math.abs(Number(nowMs) - at) <= Math.max(0, Number(withinMs) || 0);
}

export function pruneOwnWrites({ nowMs = Date.now(), ttlMs = OWN_WRITE_TTL_MS } = {}) {
  for (const [abs, at] of OWN_WRITES) {
    if (Math.abs(Number(nowMs) - at) > Math.max(0, Number(ttlMs) || 0)) OWN_WRITES.delete(abs);
  }
  return OWN_WRITES.size;
}

export function listOwnWrites() {
  return [...OWN_WRITES.entries()].map(([abs, at]) => ({ path: abs, at }));
}

export function clearOwnWrites() { OWN_WRITES.clear(); }

/**
 * 原子写：同目录临时文件 → `rename`。写一半崩溃只会留下一个 `.tmp-*`，
 * 不会出现"半个 meta.json 被当成完整文件"。成功后记进 ownWrites。
 */
export function writeFileAtomicSync(filePath, data, { encoding = 'utf8', mode } = {}) {
  const abs = path.resolve(String(filePath));
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, data, { encoding, flag: 'wx', ...(mode ? { mode } : {}) });
    fs.renameSync(tmp, abs);
    recordOwnWrite(abs);
    return abs;
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// ── fileOpsMu：扫描与移动/删除互斥 ─────────────────────────────────────────
export class FileOpsBusyError extends Error {
  constructor(name = 'fileOps') {
    super(`文件操作正忙（${name}）：已有扫描/搬运在进行中`);
    this.name = 'FileOpsBusyError';
    this.code = 'FILE_OPS_BUSY';
  }
}

/**
 * 一把锁：异步方（扫描 / enrich / 清理）用 `run` 排队；同步方（人工改分类）用 `runSync`，
 * 忙时**立刻失败**而不是排队——同步函数没法阻塞等待，硬等只会卡死事件循环。
 * 失败是安全的：调用方拿到 FileOpsBusyError，不会在半搬运状态下继续动文件。
 */
export class FileOpsMutex {
  constructor(name = 'fileOps') {
    this.name = name;
    this.busy = false;
    this.owner = '';
    this.queue = [];
    this.peakWaiters = 0;
  }

  get locked() { return this.busy; }
  get waiting() { return this.queue.length; }

  acquire(owner = '') {
    if (!this.busy) {
      this.busy = true;
      this.owner = owner;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push({ owner, resolve });
      this.peakWaiters = Math.max(this.peakWaiters, this.queue.length);
    });
  }

  release() {
    const next = this.queue.shift();
    if (next) { this.owner = next.owner; next.resolve(); return; }
    this.busy = false;
    this.owner = '';
  }

  async run(fn, owner = '') {
    await this.acquire(owner);
    try { return await fn(); } finally { this.release(); }
  }

  runSync(fn, owner = '') {
    if (this.busy) throw new FileOpsBusyError(`${this.name}:${this.owner || 'busy'}`);
    this.busy = true;
    this.owner = owner;
    try { return fn(); } finally { this.release(); }
  }

  /** 忙时不阻塞也不抛：返回 {skipped:true, reason}（后台任务用，别把一次竞争变成错误日志）。 */
  runOrSkipSync(fn, owner = '') {
    if (this.busy) return { skipped: true, reason: 'busy', owner: this.owner };
    return this.runSync(fn, owner);
  }
}

export const fileOpsMu = new FileOpsMutex('fileOps');

/** 给目录扫描 / P1 的 mtime 增量刷新用：整段持有锁。 */
export function withFileOpsLock(fn, owner = 'scan') {
  return fileOpsMu.run(fn, owner);
}

// ── 文件名 / 路径 ──────────────────────────────────────────────────────────

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 把任意来源的文件名收敛成可落盘的安全名：
 * 去掉目录分隔符与控制字符、Windows 保留名加前缀、去尾部的点与空格、限制长度（保留扩展名）。
 * 空名回退成 `unnamed`。
 */
export function sanitizeFileName(raw) {
  let name = String(raw ?? '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!name) return 'unnamed';
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 20);
    const base = name.slice(0, Math.max(1, 120 - ext.length));
    name = base + ext;
  }
  return name;
}

/** 转存相对路径：`<群号>/<YYYY-MM>/<安全文件名>`。 */

/**
 * simpleMode 的 BOOTH 号：文件名开头的 **7 位数字**（且第 8 位不能还是数字）。
 *
 * 为什么额外要求「第 8 位不是数字」：simpleMode 的入库闸门是 `/^\d{7}/`，`20240101.zip`
 * 这种 8 位日期也能进来；如果目录只截前 7 位（`2024010`）就会造出一个无意义的号目录。
 * 这类文件仍然归档，只是继续走原来的「年月」目录，不按 BOOTH 号归类。
 * @param {string} fileName
 * @returns {string} 7 位号；不匹配返回空串
 */
export function simpleBoothId(fileName) {
  const m = /^(\d{7})(?!\d)/.exec(String(fileName ?? '').trim());
  return m ? m[1] : '';
}

/**
 * simpleMode 的目录布局：
 * - 文件名带 7 位 BOOTH 号 → `<群号_群名>/<7位号>/`（同一商品的文件聚在一个号文件夹里）；
 * - 其余（含 8 位日期这类误判）→ `<群号_群名>/<YYYY-MM>/`（保持原布局）。
 * 群名拿不到就只用群号。
 */
export function simpleArchiveDir(cfg, groupId, whenMs, fileName = '') {
  const gid = String(groupId ?? '').replace(/\D/g, '') || 'unknown';
  const raw = String(cfg?.groupFolderName || '').trim();
  const rawName = raw ? sanitizeFileName(raw).slice(0, 40) : '';
  const folder = rawName ? `${gid}_${rawName}` : gid;
  const boothId = simpleBoothId(fileName);
  if (boothId) return path.join(folder, boothId);
  const d = new Date(Number(whenMs) || Date.now());
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return path.join(folder, ym);
}

export function archiveRelPath(groupId, whenMs, fileName) {
  const gid = String(groupId ?? '').replace(/\D/g, '') || 'unknown';
  const d = new Date(Number(whenMs) || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return path.join(gid, `${y}-${m}`, sanitizeFileName(fileName));
}

/**
 * 重名不覆盖：已存在同名时依次尝试 `名字 (1).ext`、`名字 (2).ext`…
 * @param {(candidate:string)=>boolean} exists 相对文件名是否已占用
 */
export function allocateStoredName(fileName, exists) {
  const safe = sanitizeFileName(fileName);
  if (!exists(safe)) return safe;
  const ext = path.extname(safe);
  const base = ext ? safe.slice(0, -ext.length) : safe;
  for (let i = 1; i < 10000; i += 1) {
    const candidate = `${base} (${i})${ext}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`同名文件过多，无法分配新文件名：${safe}`);
}

/** 商品目录名：`<boothId> <商品名>`（商品名做文件系统清洗；文件名里的扩展名不进目录名）。 */
export function boothItemDirName(boothId, productName, fallbackName = '') {
  const id = String(boothId ?? '').trim();
  let name = sanitizeFileName(String(productName || fallbackName || '未命名商品')).slice(0, 100);
  // 文件名解析出来的 productName 可能还带着扩展名（`9038753 商品.zip` → `商品.zip`）；
  // 目录名里去掉它，避免每个商品目录都叫「xxx.zip」。
  if (id) name = name.replace(/\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|jpe?g|png|gif|webp|bmp|heic)$/i, '') || name;
  return id ? `${id} ${name}` : name;
}

/**
 * 归类目录（相对转存根）：
 * - 有 BOOTH 号：`<群号>/<分类>/<boothId> <商品名>/`
 * - 没有 BOOTH 号：`<群号>/未分类/`
 */
export function archiveDirRel({ groupId, category = '', boothId = '', productName = '', fallbackName = '' } = {}) {
  const gid = String(groupId ?? '').replace(/\D/g, '') || 'unknown';
  const cat = sanitizeFileName(String(category || UNCLASSIFIED_DIR));
  if (!String(boothId ?? '').trim()) return path.join(gid, UNCLASSIFIED_DIR);
  return path.join(gid, cat, boothItemDirName(boothId, productName, fallbackName));
}

// ── 人工分类（未分类工作流）：移动文件到分类目录 ─────────────────────────
/**
 * 人工分类的目标目录（相对转存根）：
 * - 有 BOOTH 号：`<群号>/<分类>/<boothId> <商品名>/`（保留商品目录）
 * - 无 BOOTH 号：`<群号>/<分类>/`（文件直接放分类目录）
 * 与自动归类的区别：这里**分类来自人工**，不受「未知分类→未分类」映射限制。
 */
export function archiveManualDirRel({ groupId, category = '', boothId = '', productName = '', fallbackName = '' } = {}) {
  const gid = String(groupId ?? '').replace(/\D/g, '') || 'unknown';
  const cat = sanitizeFileName(String(category || UNCLASSIFIED_DIR));
  const bid = String(boothId ?? '').trim();
  if (!bid) return path.join(gid, cat);
  return path.join(gid, cat, boothItemDirName(bid, productName, fallbackName));
}

/** meta.json 的内容（与导出格式对齐；纯函数便于单测）。 */
export function metaJsonFor(row) {
  const tags = String(row.boothTags ?? row.booth_tags ?? '')
    .split('|').map((t) => t.trim()).filter(Boolean);
  return {
    boothId: String(row.boothId ?? row.booth_id ?? ''),
    title: String(row.boothTitle ?? row.booth_title ?? ''),
    shop: String(row.boothShop ?? row.booth_shop ?? ''),
    price: String(row.boothPrice ?? row.booth_price ?? ''),
    tags,
    boothUrl: String(row.boothUrl ?? row.booth_url ?? ''),
    itemUrl: String(row.boothUrl ?? row.booth_url ?? ''),
    groupId: String(row.groupId ?? row.group_id ?? ''),
    fileName: String(row.fileName ?? row.file_name ?? ''),
    bytes: Number(row.bytes) || 0,
    sha256: String(row.sha256 ?? ''),
    archivedAt: Number(row.archivedAt ?? row.archived_at) || 0,
    category: String(row.category ?? ''),
    thumbPath: String(row.thumbRel ?? row.thumb_rel ?? ''),
    thumbStatus: String(row.thumbStatus ?? row.thumb_status ?? ''),
    source: String(row.source ?? '')
  };
}
