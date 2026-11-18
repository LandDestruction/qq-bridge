// 传统 PKWARE 加密（ZipCrypto，非 AES）的纯 JS 实现 —— 只做解密/加密原语 + 加密类型探测。
//
// 为什么自己写：BOOTH 买的素材包很多是加密 zip，`unzip -P` 在目标机器不保证存在，
// 而 AES 那类"强加密"纯 JS 解不了（要 PBKDF2+AES-CTR+HMAC，成本高），所以先做 ZipCrypto。
//
// 算法（APPNOTE 6.1 §6.1）：三个 32 位密钥（k0=0x12345678 k1=0x23456789 k2=0x34567890），
// 逐字节喂密码 → 每条目解密 12 字节随机头，第 12 字节校验 = CRC32 高字节或 DOS 时间高字节；
// 之后每字节：明文 = 密文 XOR decryptByte(keys)，再用明文推进 keys。
//
// 边界：
// - 只认 12 字节头的 ZipCrypto；AES（method 99 / 0x9901 扩展 / 强加密位 bit6）只探测不尝试；
// - 空密码：标准实现用常量密钥；老工具会拿 CRC 当种子，故支持 `crc32` 兜底（仅空密码时）；
// - 解密结果不在这里验 CRC（流式解压边解边写，整包 CRC 校验留给上层），密码对不对靠 12 字节头。
import fs from 'node:fs';
import { Transform } from 'node:stream';

import { ZIP_MAX_ENTRIES, parseCentralDirectory } from './zip-read.js';

/** ZipCrypto 的随机头固定 12 字节（前 11 字节是垃圾，第 12 字节是校验字节）。 */
export const ZIP_CRYPTO_HEADER_BYTES = 12;

const KEY0_INIT = 0x12345678;
const KEY1_INIT = 0x23456789;
const KEY2_INIT = 0x34567890;
const EOCD_SIG = 0x06054b50;
const EOCD_SIZE = 22;
const EOCD_MAX_COMMENT = 0xffff;
const CENTRAL_MAX_BYTES = 64 * 1024 * 1024;

/** 标准 CRC32 表（ZipCrypto 的 key 更新用的就是它，不是普通校验用途）。 */
const CRCTAB = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (0xedb88320 ^ (value >>> 1)) | 0 : (value >>> 1) | 0;
    table[index] = value;
  }
  return table;
})();

function passwordBytes(password) {
  if (Buffer.isBuffer(password)) return password;
  return Buffer.from(String(password == null ? '' : password), 'utf8');
}

function seedKeys() {
  return { k0: KEY0_INIT, k1: KEY1_INIT, k2: KEY2_INIT };
}

/** 用一个明文字节推进密钥（加密和解密都要，且用的是**明文**）。 */
function updateKeys(state, byte) {
  state.k0 = (CRCTAB[(state.k0 ^ byte) & 0xff] ^ (state.k0 >>> 8)) >>> 0;
  state.k1 = (Math.imul((state.k1 + (state.k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
  state.k2 = (CRCTAB[(state.k2 ^ (state.k1 >>> 24)) & 0xff] ^ (state.k2 >>> 8)) >>> 0;
}

/** 生成下一个密钥流字节（已经 XOR 到明文/密文的那个字节）。 */
function decryptByte(state) {
  const temp = (state.k2 | 2) & 0xffff;
  return ((temp * (temp ^ 1)) >>> 8) & 0xff;
}

/**
 * 密码 → 三个密钥（已把密码字节全部喂进去，可以直接开始处理 12 字节头）。
 * @param {string|Buffer} password
 * @param {{crc32?:number}} [options] crc32 只在密码为空时作为兜底种子（老工具兼容）
 * @returns {{k0:number, k1:number, k2:number}}
 */
export function zipCryptoKeys(password, options = {}) {
  const state = seedKeys();
  const bytes = passwordBytes(password);
  for (const byte of bytes) updateKeys(state, byte);
  if (bytes.length === 0 && Number.isInteger(options.crc32) && options.crc32 >= 0) {
    // 密码为空：标准实现只吃常量密钥（不喂字节），等价于这里直接返回。
    // 个别老工具拿文件 CRC32 当种子，`crc32` 选项就是给它们留的口子 —— 不传就保持标准行为。
    const seed = options.crc32 >>> 0;
    for (let index = 0; index < 4; index += 1) updateKeys(state, (seed >>> (index * 8)) & 0xff);
  }
  return { k0: state.k0 >>> 0, k1: state.k1 >>> 0, k2: state.k2 >>> 0 };
}

/** 从密钥状态 + 密码解一个字节（返回明文），并推进密钥。 */
function decryptOne(state, cipherByte) {
  const plain = decryptByte(state) ^ cipherByte;
  updateKeys(state, plain);
  return plain & 0xff;
}

function encryptOne(state, plainByte) {
  const cipher = decryptByte(state) ^ plainByte;
  updateKeys(state, plainByte & 0xff);
  return cipher & 0xff;
}

/**
 * 校验字节候选：CRC32 高字节、DOS 时间高字节，调用方也可以直接给 `checkByte`。
 * @returns {number[]} 去重后的候选（最多 3 个）
 */
export function zipCryptoCheckCandidates(options = {}) {
  const values = [];
  const push = (value) => {
    if (!Number.isInteger(value)) return;
    const byte = value & 0xff;
    if (!values.includes(byte)) values.push(byte);
  };
  if (Array.isArray(options.checkByte)) for (const value of options.checkByte) push(value);
  else push(options.checkByte);
  if (Number.isInteger(options.crc32)) push((options.crc32 >>> 24) & 0xff);
  if (Number.isInteger(options.dosTime)) push((options.dosTime >>> 8) & 0xff);
  return values;
}

/**
 * 解一条**完整的加密数据**（含 12 字节头）。密码错 → `{ok:false, reason:'bad_password'}`。
 * @param {Buffer} buffer 密文（12 字节头 + 数据）
 * @param {string|Buffer} password
 * @param {{checkByte?:number|number[], crc32?:number, dosTime?:number}} [options]
 * @returns {{ok:true, data:Buffer, checkByte:number}|{ok:false, reason:string}}
 */
export function zipCryptoDecrypt(buffer, password, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < ZIP_CRYPTO_HEADER_BYTES) {
    return { ok: false, reason: 'short_header' };
  }
  const candidates = zipCryptoCheckCandidates(options);
  if (!candidates.length) return { ok: false, reason: 'no_check_byte' };
  const keysList = [zipCryptoKeys(password, {})];
  if (passwordBytes(password).length === 0 && Number.isInteger(options.crc32)) {
    // 空密码：标准实现不吃任何字节。个别老工具拿文件 CRC32 当种子，标准解不通时再试一次。
    keysList.push(zipCryptoKeys(password, { crc32: options.crc32 }));
  }
  for (const keys of keysList) {
    const state = { ...keys };
    const header = Buffer.alloc(ZIP_CRYPTO_HEADER_BYTES);
    for (let index = 0; index < ZIP_CRYPTO_HEADER_BYTES; index += 1) header[index] = decryptOne(state, buffer[index]);
    const last = header[ZIP_CRYPTO_HEADER_BYTES - 1];
    if (!candidates.includes(last)) continue;
    const data = Buffer.allocUnsafe(buffer.length - ZIP_CRYPTO_HEADER_BYTES);
    for (let index = ZIP_CRYPTO_HEADER_BYTES; index < buffer.length; index += 1) {
      data[index - ZIP_CRYPTO_HEADER_BYTES] = decryptOne(state, buffer[index]);
    }
    return { ok: true, data, checkByte: last };
  }
  return { ok: false, reason: 'bad_password' };
}

/**
 * 加密一条数据（生成 12 字节头 + 密文）。给测试夹具/自证用，生产只解密。
 * @param {Buffer} data 明文
 * @param {string|Buffer} password
 * @param {Buffer} [header] 12 字节头（默认确定性填充，测试可复现）
 */
export function zipCryptoEncrypt(data, password, header) {
  const head = Buffer.isBuffer(header) && header.length === ZIP_CRYPTO_HEADER_BYTES ? header : deterministicHeader(data, password);
  const state = { ...zipCryptoKeys(password) };
  const out = Buffer.allocUnsafe(head.length + (Buffer.isBuffer(data) ? data.length : 0));
  let cursor = 0;
  for (const byte of head) out[cursor++] = encryptOne(state, byte);
  if (Buffer.isBuffer(data)) {
    for (const byte of data) out[cursor++] = encryptOne(state, byte);
  }
  return out.subarray(0, cursor);
}

/** 默认头：前 11 字节可复现垃圾 + 第 12 字节是明文 CRC 高字节（真实工具用随机数）。 */
function deterministicHeader(data, password) {
  const header = Buffer.alloc(ZIP_CRYPTO_HEADER_BYTES);
  const seed = Buffer.from(`${passwordBytes(password).toString('hex')}:${Buffer.isBuffer(data) ? data.length : 0}`, 'utf8');
  for (let index = 0; index < ZIP_CRYPTO_HEADER_BYTES; index += 1) header[index] = seed[index % seed.length];
  header[ZIP_CRYPTO_HEADER_BYTES - 1] = 0; // 校验字节由调用方在 CRC 里给，默认 0 只是占位
  return header;
}

/**
 * 流式解密：输入是「12 字节头 + 密文」，输出明文（头被丢掉，但密钥照样推进）。
 * 解压大包时用这个，避免整条读进内存。
 * @param {string|Buffer} password
 */
export function zipCryptoDecryptStream(password) {
  const state = { ...zipCryptoKeys(password) };
  let headerLeft = ZIP_CRYPTO_HEADER_BYTES;
  return new Transform({
    transform(chunk, encoding, callback) {
      const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const out = Buffer.allocUnsafe(input.length);
      let written = 0;
      for (const byte of input) {
        const plain = decryptOne(state, byte);
        if (headerLeft > 0) {
          headerLeft -= 1;
          continue;
        }
        out[written++] = plain;
      }
      callback(null, written ? out.subarray(0, written) : null);
    }
  });
}

/** AES 强度字节（WinZip 定义 1=128 2=192 3=256）→ 位数。 */
export function aesStrengthBits(strength) {
  const value = Number(strength) || 0;
  return value === 1 ? 128 : value === 2 ? 192 : value === 3 ? 256 : 0;
}

function findEocdOffset(tail) {
  for (let offset = tail.length - EOCD_SIZE; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIG) continue;
    if (offset + EOCD_SIZE + tail.readUInt16LE(offset + 20) <= tail.length) return offset;
  }
  return -1;
}

/** 从磁盘上只读尾部 + 中央目录段（不整包读），供 detectZipEncryption 用。 */
function readDirectoryFromFile(zipPath, options) {
  let handle = null;
  try {
    handle = fs.openSync(zipPath, 'r');
    const size = fs.fstatSync(handle).size;
    if (size < EOCD_SIZE) return { ok: false, error: 'not_a_zip' };
    const tailLength = Math.min(size, EOCD_SIZE + EOCD_MAX_COMMENT);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(handle, tail, 0, tailLength, size - tailLength);
    const eocd = findEocdOffset(tail);
    if (eocd < 0) return { ok: false, error: 'not_a_zip' };
    const totalEntries = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (totalEntries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
      return { ok: false, error: 'zip64_unsupported' };
    }
    if (centralSize > CENTRAL_MAX_BYTES || centralOffset + centralSize > size) return { ok: false, error: 'bad_zip' };
    const central = Buffer.alloc(centralSize);
    if (centralSize > 0) fs.readSync(handle, central, 0, centralSize, centralOffset);
    return parseCentralDirectory(central, { centralOffset: 0, totalEntries, maxEntries: options.maxEntries });
  } catch (error) {
    return { ok: false, error: error && error.code === 'ENOENT' ? 'not_found' : 'read_failed' };
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch (error) {
        // 关句柄失败不影响结果。
      }
    }
  }
}

/**
 * 探测一个 zip 的加密类型。传 Buffer 或文件路径；永不抛。
 * @param {Buffer|string} input
 * @param {{maxEntries?:number}} [options]
 * @returns {{encrypted:boolean, method:'none'|'zipcrypto'|'aes', aesStrength?:number, error?:string}}
 */
export function detectZipEncryption(input, options = {}) {
  const settings = { maxEntries: Number.isInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : ZIP_MAX_ENTRIES };
  let directory = null;
  if (Buffer.isBuffer(input)) {
    // 内存版复用 zip-read 的 findEocd：直接调 readZipDirectory 更省事。
    directory = readViaBuffer(input, settings);
  } else if (typeof input === 'string' && input) {
    directory = readDirectoryFromFile(input, settings);
  } else {
    return { encrypted: false, method: 'none', error: 'not_a_zip' };
  }
  if (!directory || !directory.ok) {
    return { encrypted: false, method: 'none', error: (directory && directory.error) || 'not_a_zip' };
  }
  const entries = Array.isArray(directory.entries) ? directory.entries : [];
  const kind = directory.encryption === 'aes'
    ? 'aes'
    : directory.encryption === 'zipcrypto'
      ? 'zipcrypto'
      : 'none';
  const aesStrength = entries.reduce((max, entry) => Math.max(max, Number(entry.aesStrength) || 0), 0);
  return {
    encrypted: kind !== 'none',
    method: kind,
    ...(kind === 'aes' ? { aesStrength: aesStrengthBits(aesStrength) } : {})
  };
}

function readViaBuffer(buffer, settings) {
  // 只读尾部的 EOCD + 中央目录段，避免把大包整块交给解析器。
  const tailLength = Math.min(buffer.length, EOCD_SIZE + EOCD_MAX_COMMENT);
  const tail = buffer.subarray(buffer.length - tailLength);
  const eocd = findEocdOffset(tail);
  if (eocd < 0) return { ok: false, error: 'not_a_zip' };
  const totalEntries = tail.readUInt16LE(eocd + 10);
  const centralSize = tail.readUInt32LE(eocd + 12);
  const centralOffset = tail.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    return { ok: false, error: 'zip64_unsupported' };
  }
  if (centralOffset + centralSize > buffer.length) return { ok: false, error: 'bad_zip' };
  return parseCentralDirectory(buffer.subarray(centralOffset, centralOffset + centralSize), {
    centralOffset: 0,
    totalEntries,
    maxEntries: settings.maxEntries
  });
}
