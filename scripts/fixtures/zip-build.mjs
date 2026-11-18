// 测试用的最小 ZIP 写入器（只给 test-zip-read / test-zip-extract / test-zip-crypto 造夹具）。
//
// 为什么自己拼：仓库不装第三方 zip 库，`src/zip-read.js` 也必须是纯 JS 只读实现，
// 所以夹具要在测试里现拼真实字节（stored + deflate + 加密位 + 坏包），不引依赖、不落盘。
// 加密夹具（buildEncryptedZip）用的是 `src/zip-crypto.js` 同一套原语做**加密**，
// 这样「加密 → 解密」双向自证；再加一条 Python `zipfile` 独立解出来的已知向量兜底。
import zlib from 'node:zlib';

import { zipCryptoEncrypt } from '../../src/zip-crypto.js';

let crcTable = null;
/** 标准 CRC32（导出给测试/加密夹具算校验字节）。 */
export function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[index] = value;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** JS Date（本地时间）→ DOS date/time 两个 16 位字段。 */
export function dosDateTime(date = new Date(2026, 0, 2, 3, 4, 6)) {
  const year = Math.max(1980, date.getFullYear());
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { date: dosDate, time: dosTime };
}

/**
 * 拼一个 ZIP（内部通用版：body/crc/size 由调用方准备好）。
 * record: {name, body, size, crc, method, flags, extra?, mtime?}
 */
function assembleZip(records, options = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const record of records) {
    const name = Buffer.from(String(record.name), 'utf8');
    const extra = Buffer.isBuffer(record.extra) ? record.extra : Buffer.alloc(0);
    const body = Buffer.isBuffer(record.body) ? record.body : Buffer.from(String(record.body ?? ''), 'utf8');
    const stamp = dosDateTime(record.mtime instanceof Date ? record.mtime : undefined);
    const flags = Number(record.flags) || 0;
    const method = Number(record.method) || 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(record.crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(record.size >>> 0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    locals.push(local, name, extra, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(record.crc >>> 0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(record.size >>> 0, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name, extra);

    offset += local.length + name.length + extra.length + body.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const comment = Buffer.from(String(options.comment || ''), 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([localPart, centralPart, eocd, comment]);
}

/**
 * 拼一个 ZIP（明文）。
 * @param {Array<{name:string, data?:Buffer|string, method?:0|8|number, flags?:number, extra?:Buffer, mtime?:Date}>} entries
 * @param {{comment?:string}} [options]
 * @returns {Buffer}
 */
export function buildZip(entries, options = {}) {
  const records = entries.map((entry) => {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const method = entry.method === 8 ? 8 : entry.method === undefined ? 0 : Number(entry.method) || 0;
    return {
      name: entry.name,
      body: method === 8 ? zlib.deflateRawSync(data) : data,
      size: data.length,
      crc: crc32(data),
      method,
      flags: Number(entry.flags) || (entry.encrypted ? 0x1 : 0),
      extra: entry.extra,
      mtime: entry.mtime
    };
  });
  return assembleZip(records, options);
}

/**
 * 拼一个**传统 ZipCrypto 加密** ZIP（每个条目一个 12 字节头，校验字节 = 明文 CRC 高字节）。
 * @param {Array<{name:string, data?:Buffer|string, method?:0|8, mtime?:Date}>} entries
 * @param {{password:string, method?:string, comment?:string}} options
 * @returns {Buffer}
 */
export function buildEncryptedZip(entries, options = {}) {
  if (options.method && options.method !== 'zipcrypto') {
    throw new Error(`buildEncryptedZip 只支持 zipcrypto，收到 ${options.method}`);
  }
  const password = options.password == null ? '' : String(options.password);
  const records = entries.map((entry, index) => {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const method = entry.method === 8 ? 8 : 0;
    const plainBody = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    // 12 字节头：前 11 字节随便（真实工具用随机数），第 12 字节必须等于 CRC 高字节，
    // 否则标准工具会判密码错。
    const header = Buffer.alloc(12);
    for (let byteIndex = 0; byteIndex < 11; byteIndex += 1) header[byteIndex] = (byteIndex * 31 + index * 17 + 7) & 0xff;
    header[11] = (crc >>> 24) & 0xff;
    return {
      name: entry.name,
      body: zipCryptoEncrypt(plainBody, password, header),
      size: data.length,
      crc,
      method,
      flags: 0x1,
      mtime: entry.mtime
    };
  });
  return assembleZip(records, options);
}

/**
 * 拼一个「看起来像 AES 加密」的 ZIP（不真加密，只造位标记 + 0x9901 扩展，给探测/拒解测试用）。
 * @param {Array<{name:string, data?:Buffer|string}>} entries
 * @param {{strength?:1|2|3}} [options]
 */
export function buildAesZip(entries, options = {}) {
  const strength = Number(options.strength) || 3;
  const extra = Buffer.alloc(11);
  extra.writeUInt16LE(0x9901, 0); // header id
  extra.writeUInt16LE(7, 2); // data size
  extra.writeUInt16LE(2, 4); // vendor version
  extra.write('AE', 6, 'ascii'); // vendor id
  extra.writeUInt8(strength, 8); // AES 强度 1/2/3
  extra.writeUInt16LE(8, 9); // 真实压缩法（deflate）
  const records = entries.map((entry) => {
    const body = Buffer.from(String(entry.data ?? ''), 'utf8');
    return {
      name: entry.name,
      body,
      size: body.length,
      crc: crc32(body),
      method: 99, // AES 条目的压缩法固定写 99
      flags: 0x1 | 0x40, // 加密 + 强加密
      extra
    };
  });
  return assembleZip(records, options);
}

/** 找中央目录起点（测试里改坏 EOCD / 偏移时用）。 */
export function findCentralOffset(zip) {
  for (let index = zip.length - 22; index >= 0; index -= 1) {
    if (zip.readUInt32LE(index) === 0x06054b50) return zip.readUInt32LE(index + 16);
  }
  return -1;
}
