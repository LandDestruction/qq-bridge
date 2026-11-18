// ZIP 落盘解压（流式）：素材包常有 300MB~1GB，**绝不整包读进内存**。
//
// 做法（见 docs/guides/LIBRARY-PRO-UI-V2.md §5）：
// - 只读文件尾 64KB 找 EOCD，再按偏移读中央目录那一小段，解析器与 `src/zip-read.js` 共用；
// - 逐条 `fs.createReadStream(zip, {start, end})` → （deflate 时）`zlib.createInflateRaw()` → 写 `.part` 再 rename；
// - 传统 ZipCrypto 加密包：先拿第一条加密条目验密码（12 字节头校验字节），验过才落盘；
//   条目流式解密用 `src/zip-crypto.js` 的 Transform（头照样过一遍密钥、但不写出）；
// - 任何一条坏了只记 skipped 继续，只有硬失败（AES/密码错/ZIP64/超总量/磁盘写不进）才整体回 error。
//
// 安全：
// - 条目名先规范化，再确认 `resolve(destDir, name)` 仍在 destDir 里，否则 `skipped:'unsafe_path'`；
// - 不建符号链接、不恢复权限、不覆盖用户已有文件（同名加 `.1`/`.2` 后缀）；
// - 累计大小超上限就停（`too_large`），已解出的留在盘上并如实回报；
// - `keepZip:false` 时**不在这里删 zip**（交给调用方），只回 `zipKept:true` 说明包还在。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ZIP_MAX_ENTRIES, parseCentralDirectory } from './zip-read.js';
import { ZIP_CRYPTO_HEADER_BYTES, zipCryptoDecrypt, zipCryptoDecryptStream } from './zip-crypto.js';

export const ZIP_EXTRACT_MAX_TOTAL_BYTES = 8 * 1024 ** 3;
export const ZIP_EXTRACT_MAX_ENTRIES = 20000;
/** 一次最多试这么多个密码（密码本可能有几百条，别在大包上逐个试到超时）。 */
export const ZIP_EXTRACT_MAX_PASSWORDS = 10;
export const ZIP_AES_MESSAGE = '这个包是 AES 加密，暂时只能靠 7-Zip 手动解';

const EOCD_SIG = 0x06054b50;
const EOCD_SIZE = 22;
const EOCD_MAX_COMMENT = 0xffff;
const LOCAL_SIG = 0x04034b50;
const CENTRAL_MAX_BYTES = 64 * 1024 * 1024; // 2 万条目也才几 MB，超过这个数只可能是坏包
const WRITE_ERROR_CODES = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EDQUOT', 'EMFILE', 'ENFILE']);
const PROGRESS_INTERVAL_MS = 300;

function failDirectory(error) {
  return { ok: false, entries: [], encrypted: false, error };
}

function findEocdOffset(tail) {
  for (let offset = tail.length - EOCD_SIZE; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIG) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + EOCD_SIZE + commentLength <= tail.length) return offset;
  }
  return -1;
}

async function closeQuietly(fileHandle) {
  if (!fileHandle) return;
  try {
    await fileHandle.close();
  } catch (error) {
    // 关句柄失败不影响结果（文件已经用完）。
  }
}

/**
 * 打开 zip 并读中央目录（只读尾部 + 中央目录段，不整包读）。
 * @returns {{ok:boolean, fileHandle?:object, fileSize?:number, directory?:object, error?:string}}
 */
async function openZip(zipPath, options = {}) {
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? Math.min(options.maxEntries, ZIP_MAX_ENTRIES)
    : ZIP_MAX_ENTRIES;
  const keepDirs = options.keepDirs === true;
  const keepUnsafe = options.keepUnsafe === true;
  let fileHandle = null;
  try {
    fileHandle = await fs.promises.open(zipPath, 'r');
    const stat = await fileHandle.stat();
    const fileSize = stat.size;
    if (fileSize < EOCD_SIZE) {
      await closeQuietly(fileHandle);
      return { ok: false, error: 'not_a_zip' };
    }
    const tailLength = Math.min(fileSize, EOCD_SIZE + EOCD_MAX_COMMENT);
    const tail = Buffer.alloc(tailLength);
    await fileHandle.read(tail, 0, tailLength, fileSize - tailLength);
    const eocdIndex = findEocdOffset(tail);
    if (eocdIndex < 0) {
      await closeQuietly(fileHandle);
      return { ok: false, error: 'not_a_zip' };
    }
    const totalEntries = tail.readUInt16LE(eocdIndex + 10);
    const centralSize = tail.readUInt32LE(eocdIndex + 12);
    const centralOffset = tail.readUInt32LE(eocdIndex + 16);
    if (totalEntries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
      await closeQuietly(fileHandle);
      return { ok: false, error: 'zip64_unsupported' };
    }
    if (totalEntries > maxEntries) {
      await closeQuietly(fileHandle);
      return { ok: false, error: 'too_many_entries' };
    }
    if (centralOffset + centralSize > fileSize) {
      await closeQuietly(fileHandle);
      return { ok: false, error: 'truncated' };
    }
    if (centralSize > CENTRAL_MAX_BYTES) {
      await closeQuietly(fileHandle);
      return { ok: false, error: 'bad_central_directory' };
    }
    const central = Buffer.alloc(centralSize);
    if (centralSize > 0) await fileHandle.read(central, 0, centralSize, centralOffset);
    const directory = parseCentralDirectory(central, {
      centralOffset: 0,
      totalEntries,
      maxEntries,
      keepDirs,
      keepUnsafe
    });
    if (!directory.ok) {
      await closeQuietly(fileHandle);
      return { ok: false, error: directory.error };
    }
    return { ok: true, fileHandle, fileSize, directory };
  } catch (error) {
    await closeQuietly(fileHandle);
    if (error && error.code === 'ENOENT') return { ok: false, error: 'not_found' };
    return { ok: false, error: 'read_failed' };
  }
}

/**
 * 从文件读中央目录。返回形状与 `readZipDirectory(buffer)` 完全一致（同一条解析路径）。
 */
export async function readZipDirectoryFromFile(zipPath, options = {}) {
  const opened = await openZip(zipPath, { maxEntries: options.maxEntries, keepDirs: false });
  if (!opened.ok) return failDirectory(opened.error);
  try {
    return opened.directory;
  } finally {
    await closeQuietly(opened.fileHandle);
  }
}

/** 读条目的本地文件头，算出压缩数据起点；头坏了/越界回 -1。 */
async function localDataStartOf(fileHandle, entry, fileSize) {
  const header = Buffer.alloc(30);
  await fileHandle.read(header, 0, 30, entry.localOffset);
  if (header.readUInt32LE(0) !== LOCAL_SIG) return -1;
  const dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (dataStart < 0 || dataStart + entry.compressedSize > fileSize) return -1;
  return dataStart;
}

/**
 * 拿某条加密条目的 12 字节头验一个密码：校验字节对上 CRC 高字节或 DOS 时间高字节就算过。
 * 不落盘、只读 12 字节，所以密码本可以放心一个个试。
 */
async function verifyZipCryptoPassword(fileHandle, entry, fileSize, password) {
  if (entry.encryption === 'aes') return false;
  if (!Number.isFinite(entry.compressedSize) || entry.compressedSize < ZIP_CRYPTO_HEADER_BYTES) return false;
  const dataStart = await localDataStartOf(fileHandle, entry, fileSize);
  if (dataStart < 0) return false;
  const header = Buffer.alloc(ZIP_CRYPTO_HEADER_BYTES);
  await fileHandle.read(header, 0, ZIP_CRYPTO_HEADER_BYTES, dataStart);
  return zipCryptoDecrypt(header, password, { crc32: entry.crc32, dosTime: entry.dosTime }).ok;
}

/**
 * 收集候选密码：`password`（单个，允许空串）+ `passwords`（数组），去重、最多 10 个。
 * 注意空串是**合法密码**（有些包就是空密码），所以用「有没有传」判断，不按真假过滤。
 */
function collectPasswords(options) {
  const candidates = [];
  const push = (value) => {
    if (typeof value !== 'string' && !Buffer.isBuffer(value)) return;
    if (Buffer.isBuffer(value) && value.length === 0) return;
    const key = Buffer.isBuffer(value) ? `b:${value.toString('hex')}` : `s:${value}`;
    if (candidates.some((item) => item.key === key)) return;
    candidates.push({ key, value });
  };
  if (typeof options.password === 'string' || Buffer.isBuffer(options.password)) push(options.password);
  if (Array.isArray(options.passwords)) for (const value of options.passwords) push(value);
  return candidates.slice(0, ZIP_EXTRACT_MAX_PASSWORDS).map((item) => item.value);
}

/**
 * 解压前先看看里面有什么（给前端「解压前确认」用）。
 * @param {string} zipPath
 * @param {{maxEntries?:number}} [options] maxEntries 是**返回条数**上限，不是解析上限
 * @returns {{ok:boolean, entries:Array<{name:string,size:number,depth:number,isDir:boolean}>, error?:string}}
 */
export async function listZipPreview(zipPath, options = {}) {
  const limit = Number.isInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : 200;
  const opened = await openZip(zipPath, { keepDirs: true });
  if (!opened.ok) return { ok: false, entries: [], error: opened.error };
  try {
    const entries = opened.directory.entries.slice(0, limit).map((entry) => ({
      name: entry.name,
      size: entry.size,
      depth: entry.name.split('/').length - 1,
      isDir: entry.isDir === true
    }));
    return { ok: true, entries };
  } finally {
    await closeQuietly(opened.fileHandle);
  }
}

/** 冲突时加 `.1`/`.2` 后缀，绝不覆盖用户已有文件；999 次都占满就返回空串。 */
function uniqueTargetPath(root, relativeName) {
  const first = path.join(root, relativeName);
  if (!fs.existsSync(first)) return first;
  const extension = path.extname(relativeName);
  const stem = relativeName.slice(0, relativeName.length - extension.length);
  for (let index = 1; index <= 999; index += 1) {
    const candidate = path.join(root, `${stem}.${index}${extension}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function skipReasonOf(error) {
  const code = error && error.code;
  if (code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'EDQUOT') return 'write_failed';
  if (error && error.zlibError) return 'bad_deflate';
  return 'read_failed';
}

/**
 * 把 zip 解压到 destDir（流式、逐条容错）。
 * @param {string} zipPath
 * @param {string} destDir 目标目录（允许已存在，但不会被整体删除/清空）
 * @param {{keepZip?:boolean, onProgress?:Function, maxTotalBytes?:number, maxEntries?:number,
 *   password?:string|Buffer, passwords?:Array<string|Buffer>}} [options]
 *   `password` / `passwords` 是内置密码本的候选（最多试 10 个，先单个再列表）；
 *   只有传统 ZipCrypto 会用它们，AES 直接回 `aes_unsupported`。
 * @returns {Promise<{ok:boolean, destDir:string, files:number, bytes:number, skipped:Array,
 *   encrypted:boolean, encryption:'none'|'zipcrypto'|'aes', usedPassword:string, triedPasswords:number,
 *   reason:string, error:string, detail?:string, zipKept:boolean}>}
 *   `reason` 是机器可读的失败原因（bad_password / aes_unsupported / password_required / …），
 *   `error` 是给人看的中文说明。
 */
export async function extractZipToDir(zipPath, destDir, options = {}) {
  const keepZip = options.keepZip !== false;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const maxTotalBytes = Number.isFinite(options.maxTotalBytes) && options.maxTotalBytes > 0
    ? options.maxTotalBytes
    : ZIP_EXTRACT_MAX_TOTAL_BYTES;
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : ZIP_EXTRACT_MAX_ENTRIES;

  const result = {
    ok: false,
    destDir: path.resolve(String(destDir)),
    files: 0,
    bytes: 0,
    skipped: [],
    encrypted: false,
    encryption: 'none',
    usedPassword: '',
    triedPasswords: 0,
    reason: '',
    error: '',
    // keepZip 只是调用方的意图：这里永远不删 zip，避免误删下载好的原包。
    zipKept: true
  };
  void keepZip;

  const opened = await openZip(zipPath, { maxEntries, keepDirs: true, keepUnsafe: true });
  if (!opened.ok) return { ...result, error: opened.error };
  const directory = opened.directory;
  result.encrypted = directory.encrypted;
  result.encryption = directory.encryption || (directory.encrypted ? 'zipcrypto' : 'none');
  const state = { files: 0, bytes: 0, lastProgressAt: 0, totalBytes: 0, fileSize: opened.fileSize };

  try {
    if (result.encryption === 'aes') {
      // AES（WinZip 扩展 / 压缩法 99 / 强加密位）要 PBKDF2+AES-CTR+HMAC，纯 JS 做不划算，
      // 如实告诉用户走 7-Zip，别假装「密码不对」。
      return { ...result, reason: 'aes_unsupported', error: ZIP_AES_MESSAGE };
    }

    // 密码：只有 ZipCrypto 有得试。先拿第一条加密条目验（只读 12 字节），验过才落盘。
    const encryptedEntries = directory.entries.filter((entry) => !entry.isDir && entry.encrypted);
    if (encryptedEntries.length > 0) {
      const candidates = collectPasswords(options);
      if (candidates.length === 0) {
        return { ...result, reason: 'password_required', error: '这个包有密码，但没给密码' };
      }
      const probe = encryptedEntries[0];
      let used = null;
      let tried = 0;
      for (const candidate of candidates) {
        tried += 1;
        // eslint-disable-next-line no-await-in-loop
        if (await verifyZipCryptoPassword(opened.fileHandle, probe, opened.fileSize, candidate)) {
          used = candidate;
          break;
        }
      }
      result.triedPasswords = tried;
      if (used === null) {
        return { ...result, reason: 'bad_password', error: `密码不对（试了 ${tried} 个密码）` };
      }
      result.usedPassword = Buffer.isBuffer(used) ? used.toString('utf8') : String(used);
      state.password = used;
    }

    const fileEntries = directory.entries.filter((entry) => !entry.isDir);
    let declaredBytes = 0;
    for (const entry of fileEntries) declaredBytes += entry.size;
    if (declaredBytes > maxTotalBytes) {
      const skipped = fileEntries.map((entry) => ({ name: entry.name, reason: 'too_large' }));
      return { ...result, skipped, error: 'too_large' };
    }
    state.totalBytes = declaredBytes;

    try {
      await fs.promises.mkdir(result.destDir, { recursive: true });
    } catch (error) {
      return { ...result, error: 'write_failed', detail: String(error && error.message) };
    }
    const root = await fs.promises.realpath(result.destDir);

    const reportProgress = (name, force = false) => {
      if (!onProgress) return;
      const now = Date.now();
      if (!force && now - state.lastProgressAt < PROGRESS_INTERVAL_MS) return;
      state.lastProgressAt = now;
      const percent = state.totalBytes > 0 ? Math.min(99, Math.floor((state.bytes / state.totalBytes) * 100)) : 0;
      try {
        onProgress({ name, files: state.files, bytes: state.bytes, totalBytes: state.totalBytes, percent });
      } catch (error) {
        // 进度回调自己的异常不能拖垮解压。
      }
    };

    for (const entry of directory.entries) {
      if (entry.unsafe) {
        result.skipped.push({ name: entry.name, reason: 'unsafe_path' });
        continue;
      }
      const targetPath = path.resolve(root, entry.name);
      const inside = targetPath === root || targetPath.startsWith(root + path.sep);
      if (!inside) {
        result.skipped.push({ name: entry.name, reason: 'unsafe_path' });
        continue;
      }
      if (entry.isDir) {
        try {
          await fs.promises.mkdir(targetPath, { recursive: true });
        } catch (error) {
          result.skipped.push({ name: entry.name, reason: skipReasonOf(error) });
        }
        continue;
      }
      if (entry.encrypted) {
        // 前面已经用第一条加密条目验过密码了；这里逐条再验一次是为了「不同条目不同密码」的怪包
        // 不会静默写出乱码（stored 条目解错密码是能写出一堆垃圾字节的）。
        if (!state.password) {
          result.skipped.push({ name: entry.name, reason: 'password_required' });
          continue;
        }
        let verified = false;
        try {
          verified = await verifyZipCryptoPassword(opened.fileHandle, entry, opened.fileSize, state.password);
        } catch (error) {
          verified = false;
        }
        if (!verified) {
          result.skipped.push({ name: entry.name, reason: 'bad_password' });
          continue;
        }
      }
      if (entry.method !== 0 && entry.method !== 8) {
        result.skipped.push({ name: entry.name, reason: 'unsupported_method' });
        continue;
      }
      if (state.bytes + entry.size > maxTotalBytes) {
        result.skipped.push({ name: entry.name, reason: 'too_large' });
        return { ...result, files: state.files, bytes: state.bytes, error: 'too_large' };
      }

      let writeFailed = null;
      try {
        await writeOneEntry(opened.fileHandle, zipPath, entry, root, state, (chunkBytes) => {
          state.bytes += chunkBytes;
          reportProgress(entry.name);
        });
      } catch (error) {
        writeFailed = error;
      }
      if (writeFailed) {
        const code = writeFailed && writeFailed.code;
        if (code && WRITE_ERROR_CODES.has(code)) {
          return {
            ...result,
            files: state.files,
            bytes: state.bytes,
            error: 'write_failed',
            detail: String(writeFailed.message || code)
          };
        }
        result.skipped.push({ name: entry.name, reason: writeFailed.reason || skipReasonOf(writeFailed) });
        continue;
      }
      state.files += 1;
      reportProgress(entry.name, true);
    }

    return {
      ...result,
      ok: true,
      files: state.files,
      bytes: state.bytes,
      error: '',
      zipKept: true
    };
  } finally {
    await closeQuietly(opened.fileHandle);
  }
}

/**
 * 写单条：stored 直接拷，deflate 经 inflateRaw，加密条目先过 ZipCrypto 解密流；
 * 先写 `.part` 再 rename，失败清理半成品。
 */
async function writeOneEntry(fileHandle, zipPath, entry, root, state, onChunk) {
  const header = Buffer.alloc(30);
  await fileHandle.read(header, 0, 30, entry.localOffset);
  if (header.readUInt32LE(0) !== LOCAL_SIG) {
    const error = new Error('bad_local_header');
    error.reason = 'bad_local_header';
    throw error;
  }
  const localNameLength = header.readUInt16LE(26);
  const localExtraLength = header.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
  if (dataStart < 0 || dataStart + entry.compressedSize > state.fileSize) {
    const error = new Error('truncated');
    error.reason = 'truncated';
    throw error;
  }
  const target = uniqueTargetPath(root, entry.name);
  if (!target) {
    const error = new Error('target_busy');
    error.reason = 'target_busy';
    throw error;
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const partPath = `${target}.part`;
  try {
    if (entry.compressedSize === 0) {
      await fs.promises.writeFile(partPath, Buffer.alloc(0));
    } else {
      const source = fs.createReadStream(zipPath, {
        start: dataStart,
        end: dataStart + entry.compressedSize - 1
      });
      const counter = new Transform({
        transform(chunk, encoding, callback) {
          onChunk(chunk.length);
          callback(null, chunk);
        }
      });
      const streams = [source];
      // ZipCrypto 的 12 字节加密头也在数据段里，解密流会先吃掉它、不往下游吐字节。
      if (entry.encrypted && state.password) streams.push(zipCryptoDecryptStream(state.password));
      if (entry.method === 8) streams.push(zlib.createInflateRaw());
      streams.push(counter, fs.createWriteStream(partPath));
      await pipeline(streams);
    }
    await fs.promises.rename(partPath, target);
  } catch (error) {
    try {
      await fs.promises.unlink(partPath);
    } catch (cleanupError) {
      // 半成品删不掉也别让整包失败。
    }
    if (error && error.reason) error.code = error.reason;
    if (error && error.code === 'Z_DATA_ERROR') error.code = 'bad_deflate';
    throw error;
  }
}
