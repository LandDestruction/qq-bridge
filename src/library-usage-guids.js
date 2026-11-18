// 素材侧 GUID 抽取：`.unitypackage` 是 tar.gz，条目名 `<guid>/<pathname>`、`<guid>/asset`，
// 首段 32 位 hex 就是素材里每个文件的 GUID；工程里 `.meta` 的 `guid:` 与 `Assets/**` 引用它们。
//
// 为什么单独一层：这一层要 import zlib/zip-read（解 gzip、找外层 zip 里的 .unitypackage），
// 而 `src/bridge/console/library-usage.js` 是 VM 裸执行模块，不能 import —— 所以这些函数
// 由 src/library-usage.js 的纯符号一起注入（manifest 里的 libraryUsagePure 命名空间）。
//
// 安全：只读内存、不写盘；外层 zip 的单条目与 gunzip 输出都有上限（默认 8MB / 64MB），
// 超了返回空数组并带 reason，绝不抛错、绝不整包解压到磁盘。
import zlib from 'node:zlib';
import { parseCentralDirectory, readZipDirectory, readZipEntrySafe } from './zip-read.js';

// 上限：真库里有 100~200MB 的素材包（外层 zip 走范围读，不进内存）；
// 能真正拆开看的是里面的 `.unitypackage`——压缩后 16MB / 解开后 96MB 封顶，
// 再大就跳过（回 entry_too_large，素材算 unknown，不谎报 unused）。
export const GUID_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
export const GUID_MAX_TAR_BYTES = 96 * 1024 * 1024;
export const GUID_MAX_PACKAGE_GUIDS = 2000;

const HEX32_RE = /^[0-9a-f]{32}$/i;
const GZIP_MAGIC = 0x1f;
const ZIP_MAGIC = 0x50;

function isGuid(text) {
  return HEX32_RE.test(String(text || ''));
}

/** tar 头解析（与 library-package-cover.js 同一套手写解析，避免为这点事再引依赖）。 */
export function guidsFromTarGzBuffer(buffer, options = {}) {
  const maxTarBytes = Number(options.maxTarBytes) > 0 ? Number(options.maxTarBytes) : GUID_MAX_TAR_BYTES;
  const limit = Number(options.maxGuids) > 0 ? Number(options.maxGuids) : GUID_MAX_PACKAGE_GUIDS;
  let tar = null;
  try {
    tar = zlib.gunzipSync(buffer, { maxOutputLength: maxTarBytes });
  } catch {
    return { guids: [], reason: 'bad_tar_gz' };
  }
  const guids = [];
  const seen = new Set();
  let offset = 0;
  while (offset + 512 <= tar.length && guids.length < limit) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = header.subarray(0, 100);
    const zero = rawName.indexOf(0);
    const name = rawName.subarray(0, zero === -1 ? rawName.length : zero).toString('utf8').trim();
    if (!name) break;
    const rawSize = header.subarray(124, 136);
    const zeroSize = rawSize.indexOf(0);
    const size = Number.parseInt(rawSize.subarray(0, zeroSize === -1 ? rawSize.length : zeroSize).toString('ascii').trim(), 8) || 0;
    const first = name.split('/')[0];
    if (isGuid(first)) {
      const guid = first.toLowerCase();
      if (!seen.has(guid)) { seen.add(guid); guids.push(guid); }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return { guids, reason: guids.length ? '' : 'no_guid' };
}

/** 只接受 .unitypackage 条目；外层 zip 里可能有多个（套装），逐个解。 */
export function guidsFromZipBuffer(buffer, options = {}) {
  const maxEntryBytes = Number(options.maxEntryBytes) > 0 ? Number(options.maxEntryBytes) : GUID_MAX_ENTRY_BYTES;
  const limit = Number(options.maxGuids) > 0 ? Number(options.maxGuids) : GUID_MAX_PACKAGE_GUIDS;
  const directory = readZipDirectory(buffer, { maxEntries: Number(options.maxEntries) || 20000 });
  if (!directory.ok) return { guids: [], reason: directory.error || 'bad_zip' };
  const packages = directory.entries.filter((entry) => !entry.isDir && /\.unitypackage$/i.test(entry.name));
  if (!packages.length) return { guids: [], reason: 'no_unitypackage' };
  const guids = [];
  const seen = new Set();
  let reason = '';
  for (const entry of packages) {
    if (seen.size >= limit) break;
    const read = readZipEntrySafe(buffer, entry.name, { maxBytes: maxEntryBytes });
    if (!read.ok || !read.bytes?.length) { reason = read.error || 'read_failed'; continue; }
    const inner = guidsFromTarGzBuffer(read.bytes, { maxGuids: limit - seen.size, maxTarBytes: options.maxTarBytes });
    if (!inner.guids.length) { reason = inner.reason || reason; continue; }
    for (const guid of inner.guids) {
      if (seen.has(guid)) continue;
      seen.add(guid); guids.push(guid);
    }
  }
  return { guids, reason: guids.length ? '' : (reason || 'no_guid') };
}

/** 自动识别：gzip（裸 unitypackage）→ tar；zip → 找里面的 unitypackage；其它回 reason。 */
export function guidsFromAssetBuffer(buffer, options = {}) {
  if (!buffer || !buffer.length) return { guids: [], reason: 'empty' };
  if (buffer[0] === GZIP_MAGIC && buffer[1] === 0x8b) return guidsFromTarGzBuffer(buffer, options);
  if (buffer[0] === ZIP_MAGIC && buffer[1] === 0x4b) return guidsFromZipBuffer(buffer, options);
  return { guids: [], reason: 'not_supported' };
}

const EOCD_SIG = 0x06054b50;
const LOCAL_SIG = 0x04034b50;

function readRange(fs, fd, position, length) {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, position);
  return read === length ? buffer : buffer.subarray(0, read);
}

/**
 * 大 zip 的关键路径：只按偏移读「尾 64KB → 中央目录 → 需要的本地条目」，不整包进内存。
 * 真库里有 100~200MB 的素材包（`.unitypackage` 本身只有几 MB），整包读会白烧内存。
 */
export function guidsFromZipFile(filePath, fs, options = {}) {
  const maxEntryBytes = Number(options.maxEntryBytes) > 0 ? Number(options.maxEntryBytes) : GUID_MAX_ENTRY_BYTES;
  const limit = Number(options.maxGuids) > 0 ? Number(options.maxGuids) : GUID_MAX_PACKAGE_GUIDS;
  let fd = 0;
  try {
    fd = fs.openSync(filePath, 'r');
    const { size } = fs.fstatSync(fd);
    const tailLength = Math.min(size, 65536 + 22);
    const tail = readRange(fs, fd, size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) return { guids: [], reason: 'bad_zip' };
    const totalEntries = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (!centralSize || centralSize > 8 * 1024 * 1024 || centralOffset + centralSize > size) return { guids: [], reason: 'bad_zip' };
    const central = readRange(fs, fd, centralOffset, centralSize);
    if (central.length !== centralSize) return { guids: [], reason: 'truncated' };
    const directory = parseCentralDirectory(central, { centralOffset: 0, totalEntries, maxEntries: Number(options.maxEntries) || 20000 });
    if (!directory.ok) return { guids: [], reason: directory.error || 'bad_zip' };
    const packages = directory.entries.filter((entry) => !entry.isDir && /\.unitypackage$/i.test(entry.name));
    if (!packages.length) return { guids: [], reason: 'no_unitypackage' };
    const guids = [];
    const seen = new Set();
    let reason = '';
    for (const entry of packages) {
      if (seen.size >= limit) break;
      if (entry.encrypted) { reason = 'encrypted'; continue; }
      if (entry.size > maxEntryBytes || entry.compressedSize > maxEntryBytes) { reason = 'entry_too_large'; continue; }
      if (entry.method !== 0 && entry.method !== 8) { reason = 'unsupported_method'; continue; }
      try {
        const local = readRange(fs, fd, entry.localOffset, 30);
        if (local.length < 30 || local.readUInt32LE(0) !== LOCAL_SIG) { reason = 'bad_local_header'; continue; }
        const dataStart = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        const raw = readRange(fs, fd, dataStart, entry.compressedSize);
        if (raw.length !== entry.compressedSize) { reason = 'truncated'; continue; }
        const bytes = entry.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: maxEntryBytes }) : raw;
        const inner = guidsFromTarGzBuffer(bytes, { maxGuids: limit - seen.size, maxTarBytes: options.maxTarBytes });
        if (!inner.guids.length) { reason = inner.reason || reason; continue; }
        for (const guid of inner.guids) {
          if (seen.has(guid)) continue;
          seen.add(guid);
          guids.push(guid);
        }
      } catch {
        reason = 'read_failed';
      }
    }
    return { guids, reason: guids.length ? '' : (reason || 'no_guid') };
  } catch {
    return { guids: [], reason: 'read_failed' };
  } finally {
    if (fd) { try { fs.closeSync(fd); } catch { /* 关不掉就算了，进程退出会收 */ } }
  }
}

/**
 * 从磁盘上的一件素材抽 GUID。
 * @param {{filePath: string, fs: object, maxBytes?: number}} input
 * maxBytes 是「整件素材最多读多少字节进内存」，默认 64MB；超过的 zip 走范围读（guidsFromZipFile），
 * 超过的裸 `.unitypackage` 直接跳过（tar.gz 必须整体解压才能列表）。
 */
export function guidsFromAssetFile(input = {}) {
  const fs = input.fs;
  const filePath = String(input.filePath || '');
  if (!fs || !filePath) return { guids: [], reason: 'no_input' };
  const maxBytes = Number(input.maxBytes) > 0 ? Number(input.maxBytes) : 64 * 1024 * 1024;
  let stat = null;
  try { stat = fs.statSync(filePath); } catch { return { guids: [], reason: 'missing' }; }
  if (!stat || !stat.isFile()) return { guids: [], reason: 'not_file' };
  if (stat.size > maxBytes) {
    if (/\.zip$/i.test(filePath)) return guidsFromZipFile(filePath, fs, {
      maxEntryBytes: input.maxEntryBytes,
      maxTarBytes: input.maxTarBytes,
      maxGuids: input.maxGuids
    });
    return { guids: [], reason: 'too_large' };
  }
  let buffer = null;
  try { buffer = fs.readFileSync(filePath); } catch { return { guids: [], reason: 'read_failed' }; }
  return guidsFromAssetBuffer(buffer, {
    maxEntryBytes: input.maxEntryBytes,
    maxTarBytes: input.maxTarBytes,
    maxGuids: input.maxGuids
  });
}
