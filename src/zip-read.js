// 纯 JS 读 ZIP（stored / deflate），**只读**：不落盘、不解压整包、不联网。
//
// 用途（见 docs/guides/LIBRARY-PRO-UI-V2.md §5）：
// - 素材库补封面时从 `.unitypackage` / `.zip` 里直接抠 `preview.png`（unitypackage 本身就是一个 zip）；
// - 后续「自动解压」复用同一套中央目录解析（`src/zip-extract.js` 走文件版本，读的也是这里的解析器）。
//
// 边界：
// - ZIP64 不支持（条目数/偏移是 64 位时回 `zip64_unsupported`，不猜）；
// - 加密包只在目录里标类型（`encrypted:true` + `encryption:'zipcrypto'|'aes'`），本文件不负责解密
//   （传统 ZipCrypto 的解密在 `src/zip-crypto.js`，解压时用）；
// - 条目名一律规范化（反斜杠转 `/`、去 `./`、拒绝 `..` 与绝对路径、跳过目录条目）——
//   哪怕只读也不留路径穿越的念头；
// - 解压有上限：声明大小超过 maxBytes 直接拒，inflate 时再带 maxOutputLength 兜底，
//   防「声明 1KB、实际解出 1GB」的压缩炸弹。
import zlib from 'node:zlib';

export const ZIP_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
export const ZIP_MAX_ENTRIES = 20000;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIZE = 22;
const EOCD_MAX_COMMENT = 0xffff;
const PREVIEW_NAMES = ['preview.png', 'thumbnail.png', 'cover.png'];

function fail(error) {
  return { ok: false, entries: [], encrypted: false, encryption: 'none', error };
}

/** DOS 日期时间（ZIP 里没有时区）→ ISO 字符串；字段非法就回空串，不编时间。 */
function dosToIso(date, time) {
  const year = ((date >> 9) & 0x7f) + 1980;
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  const hour = (time >> 11) & 0x1f;
  const minute = (time >> 5) & 0x3f;
  const second = (time & 0x1f) * 2;
  if (year < 1980 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  const parsed = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

/**
 * 条目名规范化：`a\b.txt` → `a/b.txt`；去 `./`；目录条目（以 `/` 结尾）返回空；
 * 绝对路径（`/x`、`C:\x`）与含 `..` 段的路径返回空（直接丢弃，不进目录）。
 */
export function normalizeEntryName(raw) {
  let name = String(raw == null ? '' : raw).replace(/\\/g, '/');
  if (!name || name.endsWith('/')) return '';
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return '';
  const segments = [];
  for (const part of name.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return '';
    segments.push(part);
    if (segments.length > 64) return '';
  }
  return segments.join('/');
}

/** 目录条目名：去掉结尾斜杠后按普通条目名规范化（`..`/绝对路径同样拒绝）。 */
function normalizeDirEntryName(raw) {
  const text = String(raw == null ? '' : raw).replace(/\\/g, '/').replace(/\/+$/, '');
  return text ? normalizeEntryName(text) : '';
}

/** 从尾部往前找 EOCD（ZIP 注释最长 65535 字节，所以最多扫 65557 字节）。 */
function findEocd(buffer) {
  const start = Math.max(0, buffer.length - EOCD_SIZE - EOCD_MAX_COMMENT);
  for (let offset = buffer.length - EOCD_SIZE; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIG) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + EOCD_SIZE + commentLength <= buffer.length) return offset;
  }
  return -1;
}

/**
 * 读中央目录里的扩展字段，只认加密相关的两条：
 * - 0x9901 = AES（WinZip 扩展）：vendor version / vendor id / strength / 真实压缩法；
 * - 其余（时间戳、zip64、unicode 路径…）这里不用，直接跳过。
 * @returns {{aes:boolean, aesStrength:number}}
 */
function readExtraFlags(buffer, start, length) {
  const result = { aes: false, aesStrength: 0 };
  const end = Math.min(buffer.length, start + Math.max(0, length));
  let cursor = start;
  while (cursor + 4 <= end) {
    const id = buffer.readUInt16LE(cursor);
    const size = buffer.readUInt16LE(cursor + 2);
    const dataStart = cursor + 4;
    if (id === 0x9901) {
      result.aes = true;
      // 结构：vendorVersion(2) vendorId(2) strength(1) actualMethod(2)
      if (dataStart + 5 <= end) result.aesStrength = buffer.readUInt8(dataStart + 4);
    }
    cursor = dataStart + size;
  }
  return result;
}

/**
 * 解析中央目录（buffer 从 `centralOffset` 起必须包含完整中央目录）。
 * 内存版（readZipDirectory）与文件版（zip-extract 的 readZipDirectoryFromFile）共用这一份实现，
 * 保证两边字段完全一致。
 * @param {Buffer} buffer
 * `keepDirs` 保留目录条目（解压要建目录）；`keepUnsafe` 把被拒掉的穿越/绝对路径条目也列出来
 * （解压时要如实回报 `skipped:'unsafe_path'`，不能假装包里没这条）。
 * @param {{centralOffset?:number, totalEntries?:number, maxEntries?:number, keepDirs?:boolean, keepUnsafe?:boolean}} [options]
 * @returns {{ok:boolean, entries:Array, encrypted:boolean, encryption:string, error:string}}
 *   entry: {name, size, compressedSize, method, mtime, encrypted, encryption, aesStrength, crc32, dosTime, localOffset, isDir?, unsafe?}
 */
export function parseCentralDirectory(buffer, options = {}) {
  const centralOffset = Number.isInteger(options.centralOffset) ? options.centralOffset : 0;
  const totalEntries = Number.isInteger(options.totalEntries) ? options.totalEntries : 0;
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : ZIP_MAX_ENTRIES;
  const keepDirs = options.keepDirs === true;
  const keepUnsafe = options.keepUnsafe === true;
  try {
    const entries = [];
    let cursor = centralOffset;
    for (let index = 0; index < totalEntries; index += 1) {
      if (cursor + 46 > buffer.length) return fail('truncated');
      if (buffer.readUInt32LE(cursor) !== CENTRAL_SIG) return fail('bad_central_directory');
      const flags = buffer.readUInt16LE(cursor + 8);
      const method = buffer.readUInt16LE(cursor + 10);
      const modTime = buffer.readUInt16LE(cursor + 12);
      const modDate = buffer.readUInt16LE(cursor + 14);
      const crc = buffer.readUInt32LE(cursor + 16);
      const compressedSize = buffer.readUInt32LE(cursor + 20);
      const size = buffer.readUInt32LE(cursor + 24);
      const nameLength = buffer.readUInt16LE(cursor + 28);
      const extraLength = buffer.readUInt16LE(cursor + 30);
      const commentLength = buffer.readUInt16LE(cursor + 32);
      const localOffset = buffer.readUInt32LE(cursor + 42);
      const nameEnd = cursor + 46 + nameLength;
      if (nameEnd > buffer.length) return fail('truncated');
      const rawName = buffer.toString('utf8', cursor + 46, nameEnd);
      const extra = readExtraFlags(buffer, nameEnd, extraLength);
      cursor = nameEnd + extraLength + commentLength;
      // 加密法判定：有 0x9901 / 强加密位(bit6) / 压缩法 99 都算 AES；否则 bit0 就是传统 ZipCrypto。
      const isEncrypted = (flags & 0x1) !== 0;
      const encryption = !isEncrypted
        ? 'none'
        : (extra.aes || (flags & 0x40) !== 0 || method === 99)
          ? 'aes'
          : 'zipcrypto';
      const isDir = keepDirs && /[\\/]$/.test(rawName);
      const name = isDir ? normalizeDirEntryName(rawName) : normalizeEntryName(rawName);
      if (!name) {
        // 目录条目（未要求保留时）/ 不安全路径：默认丢弃，不进目录。
        if (keepUnsafe && !isDir) {
          entries.push({
            name: String(rawName || '').slice(0, 300),
            size,
            compressedSize,
            method,
            mtime: dosToIso(modDate, modTime),
            encrypted: isEncrypted,
            encryption,
            aesStrength: extra.aesStrength,
            crc32: crc,
            dosTime: modTime,
            localOffset,
            unsafe: true
          });
          if (entries.length > maxEntries) return fail('too_many_entries');
        }
        continue;
      }
      const entry = {
        name,
        size,
        compressedSize,
        method,
        mtime: dosToIso(modDate, modTime),
        encrypted: isEncrypted,
        encryption,
        aesStrength: extra.aesStrength,
        crc32: crc,
        dosTime: modTime,
        localOffset
      };
      if (isDir) entry.isDir = true;
      entries.push(entry);
      if (entries.length > maxEntries) return fail('too_many_entries');
    }
    const hasAes = entries.some((entry) => entry.encryption === 'aes');
    const hasZipCrypto = entries.some((entry) => entry.encryption === 'zipcrypto');
    return {
      ok: true,
      entries,
      encrypted: hasAes || hasZipCrypto,
      encryption: hasAes ? 'aes' : hasZipCrypto ? 'zipcrypto' : 'none',
      error: ''
    };
  } catch (error) {
    return fail('bad_zip');
  }
}

/**
 * 读中央目录（内存版）。永不抛：坏包统一回 `{ok:false, error}`。
 * @returns {{ok:boolean, entries:Array, encrypted:boolean, error:string}}
 *   entry: {name, size, compressedSize, method, mtime, encrypted, localOffset}
 */
export function readZipDirectory(buffer) {
  try {
    if (!Buffer.isBuffer(buffer)) return fail('not_a_zip');
    if (buffer.length < EOCD_SIZE) return fail('not_a_zip');
    const eocd = findEocd(buffer);
    if (eocd < 0) return fail('not_a_zip');
    const totalEntries = buffer.readUInt16LE(eocd + 10);
    const centralSize = buffer.readUInt32LE(eocd + 12);
    const centralOffset = buffer.readUInt32LE(eocd + 16);
    if (totalEntries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
      return fail('zip64_unsupported');
    }
    if (totalEntries > ZIP_MAX_ENTRIES) return fail('too_many_entries');
    if (centralOffset + centralSize > buffer.length) return fail('truncated');
    return parseCentralDirectory(buffer, { centralOffset, totalEntries });
  } catch (error) {
    return fail('bad_zip');
  }
}

function depthOf(name) {
  return String(name).split('/').length - 1;
}

// 在目录里找条目：先大小写不敏感精确匹配，再退化为「任意目录前缀 + 名字」的后缀匹配（浅的优先）。
function pickEntry(entries, name) {
  const wanted = normalizeEntryName(name);
  if (!wanted) return null;
  const lower = wanted.toLowerCase();
  const exact = entries.filter((entry) => entry.name.toLowerCase() === lower);
  if (exact.length) return exact[0];
  const suffix = entries.filter((entry) => entry.name.toLowerCase().endsWith('/' + lower));
  if (!suffix.length) return null;
  return suffix.sort((left, right) => depthOf(left.name) - depthOf(right.name))[0];
}

/**
 * 读单个条目。method 0 直接切片，method 8 用 inflateRawSync。
 * 永不抛：失败回 `{ok:false, name, bytes:null, error}`。
 */
export function readZipEntry(buffer, name, options = {}) {
  const result = { ok: false, name: String(name == null ? '' : name), bytes: null, error: '' };
  try {
    const directory = readZipDirectory(buffer);
    if (!directory.ok) return { ...result, error: directory.error };
    const entry = pickEntry(directory.entries, name);
    if (!entry) return { ...result, error: 'entry_not_found' };
    result.name = entry.name;
    if (entry.encrypted) return { ...result, error: 'encrypted' };
    const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : ZIP_MAX_ENTRY_BYTES;
    if (entry.size > maxBytes) return { ...result, error: 'entry_too_large' };
    if (entry.size < 0 || entry.compressedSize < 0) return { ...result, error: 'bad_entry' };
    const localOffset = entry.localOffset;
    if (localOffset + 30 > buffer.length) return { ...result, error: 'truncated' };
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) return { ...result, error: 'bad_local_header' };
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart < 0 || dataEnd > buffer.length) return { ...result, error: 'truncated' };
    const raw = buffer.subarray(dataStart, dataEnd);
    if (entry.method === 0) {
      return { ...result, ok: true, bytes: Buffer.from(raw) };
    }
    if (entry.method === 8) {
      // maxOutputLength 兜底：即使目录里的 size 撒谎，也不会把内存解爆。
      const limit = Math.max(1, Math.min(maxBytes, entry.size || maxBytes));
      const inflated = zlib.inflateRawSync(raw, { maxOutputLength: limit });
      return { ...result, ok: true, bytes: Buffer.from(inflated) };
    }
    return { ...result, error: 'unsupported_method' };
  } catch (error) {
    return { ...result, error: 'bad_zip' };
  }
}

/** readZipEntry 的「绝不抛」版本：任何异常都折成 `{ok:false, error}`。 */
export function readZipEntrySafe(buffer, name, options = {}) {
  try {
    return readZipEntry(buffer, name, options);
  } catch (error) {
    return { ok: false, name: String(name == null ? '' : name), bytes: null, error: 'read_failed' };
  }
}

/**
 * 挑出可能的封面条目：`preview.png` > `thumbnail.png` > `cover.png`，按
 * 「根目录优先 > 深度浅优先 > 体积大优先」排序（同级再按名字稳定排序）。
 * 只返回条目元数据，读内容交给 readZipEntry。
 */
export function findZipPreviewEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const ranked = list
    .filter((entry) => entry && PREVIEW_NAMES.includes(baseName(entry.name)))
    .map((entry) => ({ entry, rank: PREVIEW_NAMES.indexOf(baseName(entry.name)) }));
  ranked.sort((left, right) => {
    const depthGap = depthOf(left.entry.name) - depthOf(right.entry.name);
    if (depthGap) return depthGap;
    const sizeGap = (Number(right.entry.size) || 0) - (Number(left.entry.size) || 0);
    if (sizeGap) return sizeGap;
    if (left.rank !== right.rank) return left.rank - right.rank;
    return left.entry.name < right.entry.name ? -1 : left.entry.name > right.entry.name ? 1 : 0;
  });
  return ranked.map((item) => item.entry);
}

function baseName(name) {
  const text = String(name || '');
  const cut = text.lastIndexOf('/');
  return (cut === -1 ? text : text.slice(cut + 1)).toLowerCase();
}
