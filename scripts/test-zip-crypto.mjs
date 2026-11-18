// src/zip-crypto.js 的契约测试：传统 ZipCrypto（PKWARE）解密原语 + 加密类型探测。
//
// 为什么值得测：BOOTH 付费素材很多是加密 zip，以前只能回「有密码，解不了」；
// 自己实现解密就必须保证**和真实工具互通**，所以除了自证（同一套 keys 加密→解密），
// 还有一条独立交叉验证：把我们造的加密包交给 Python `zipfile`（独立实现）用同一密码解出来。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  ZIP_CRYPTO_HEADER_BYTES,
  aesStrengthBits,
  detectZipEncryption,
  zipCryptoCheckCandidates,
  zipCryptoDecrypt,
  zipCryptoDecryptStream,
  zipCryptoEncrypt,
  zipCryptoKeys
} from '../src/zip-crypto.js';
import { readZipDirectory } from '../src/zip-read.js';
import { buildAesZip, buildEncryptedZip, buildZip, crc32, dosDateTime } from './fixtures/zip-build.mjs';

const failures = [];
let pass = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail === undefined ? '' : ' — ' + String(detail)}`);
  }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

const PASSWORD = 'acg18';
const PLAIN = Buffer.from('加密包内容 hello zipcrypto', 'utf8');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-crypto-test-'));
let caseIndex = 0;
function tmpFile(label, buffer) {
  caseIndex += 1;
  const file = path.join(base, `${caseIndex}-${label}.zip`);
  fs.writeFileSync(file, buffer);
  return file;
}
function entryDataStart(zip) {
  const directory = readZipDirectory(zip);
  const entry = directory.entries[0];
  const nameLength = zip.readUInt16LE(entry.localOffset + 26);
  const extraLength = zip.readUInt16LE(entry.localOffset + 28);
  return { directory, entry, start: entry.localOffset + 30 + nameLength + extraLength };
}

console.log('## keys：确定性、32 位、密码/CRC 种子都参与');
{
  const keys = zipCryptoKeys(PASSWORD, {});
  check('keys 三个都是 32 位无符号整数', [keys.k0, keys.k1, keys.k2].every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff), keys);
  eq('同密码同种子可复现', zipCryptoKeys(PASSWORD, { crc32: 12345 }), zipCryptoKeys(PASSWORD, { crc32: 12345 }));
  check('不同密码 → 不同 keys', zipCryptoKeys('a', {}).k0 !== zipCryptoKeys('b', {}).k0);
  check('空密码 + crc32 种子与纯空密码不同', zipCryptoKeys('', { crc32: 0x0a0b0c0d }).k0 !== zipCryptoKeys('', {}).k0);
  check('密码按字节喂（多字节 UTF-8 不炸）', Number.isInteger(zipCryptoKeys('密码密码', {}).k2));
}

console.log('## 解密：正确/错误密码、空密码、头太短、缺校验字节');
const encrypted = buildEncryptedZip([{ name: 'a.txt', data: PLAIN }], { password: PASSWORD });
{
  const { entry, start } = entryDataStart(encrypted);
  const body = encrypted.subarray(start, start + entry.compressedSize);
  const good = zipCryptoDecrypt(body, PASSWORD, { crc32: entry.crc32, dosTime: entry.dosTime });
  check('正确密码解出原文', good.ok && good.data.equals(PLAIN), good);
  eq('解出长度 = 密文长度 - 12', good.data.length, body.length - ZIP_CRYPTO_HEADER_BYTES);
  eq('错误密码回 bad_password', zipCryptoDecrypt(body, 'wrong', { crc32: entry.crc32, dosTime: entry.dosTime }).reason, 'bad_password');
  eq('头太短回 short_header', zipCryptoDecrypt(body.subarray(0, 5), PASSWORD, { crc32: entry.crc32 }).reason, 'short_header');
  eq('没给任何校验线索回 no_check_byte', zipCryptoDecrypt(body, PASSWORD, {}).reason, 'no_check_byte');
  // 第 12 字节 = CRC 高字节；再用 DOS 时间高字节这条路径验一次（真实工具两种都写）。
  const stamp = dosDateTime(new Date(2026, 2, 4, 5, 6, 8));
  const dosHeader = Buffer.from(zipCryptoEncrypt(PLAIN, PASSWORD, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, (stamp.time >>> 8) & 0xff])));
  const viaTime = zipCryptoDecrypt(dosHeader, PASSWORD, { dosTime: stamp.time });
  check('校验字节走 DOS 时间高字节也能过', viaTime.ok && viaTime.data.equals(PLAIN), viaTime);
  check('两个候选去重后是 CRC 高字节 + 时间高字节', (() => {
    const candidates = zipCryptoCheckCandidates({ crc32: 0x11223344, dosTime: 0x55667 });
    return candidates.includes(0x11) && candidates.includes((0x55667 >>> 8) & 0xff) && new Set(candidates).size === candidates.length;
  })());
}

console.log('## 空密码也是合法密码');
{
  const zip = buildEncryptedZip([{ name: 'empty.txt', data: '空密码' }], { password: '' });
  const { entry, start } = entryDataStart(zip);
  const body = zip.subarray(start, start + entry.compressedSize);
  const attempt = zipCryptoDecrypt(body, '', { crc32: entry.crc32 });
  check('空密码可解出', attempt.ok && attempt.data.toString('utf8') === '空密码', attempt.reason);
}

console.log('## 流式解密与整块解密一致');
{
  const { entry, start } = entryDataStart(encrypted);
  const body = encrypted.subarray(start, start + entry.compressedSize);
  const chunks = [];
  await pipeline(Readable.from([body.subarray(0, 1), body.subarray(1, 7), body.subarray(7)]), zipCryptoDecryptStream(PASSWORD), async function* (source) {
    for await (const chunk of source) chunks.push(chunk);
  });
  check('分块喂入解出同样明文', Buffer.concat(chunks).equals(PLAIN), Buffer.concat(chunks).toString('utf8'));
}

console.log('## 探测加密类型');
{
  eq('明文 zip → none', detectZipEncryption(buildZip([{ name: 'x.txt', data: 'x' }])), { encrypted: false, method: 'none' });
  eq('加密 zip（Buffer）→ zipcrypto', detectZipEncryption(encrypted), { encrypted: true, method: 'zipcrypto' });
  eq('加密 zip（路径）→ zipcrypto', detectZipEncryption(tmpFile('enc', encrypted)), { encrypted: true, method: 'zipcrypto' });
  eq('明文 zip（路径）→ none', detectZipEncryption(tmpFile('plain', buildZip([{ name: 'x.txt', data: 'x' }]))), { encrypted: false, method: 'none' });
  eq('AES-256 → aes/256', detectZipEncryption(buildAesZip([{ name: 'a.txt', data: 'x' }], { strength: 3 })), { encrypted: true, method: 'aes', aesStrength: 256 });
  eq('AES-192 → aes/192', detectZipEncryption(buildAesZip([{ name: 'a.txt', data: 'x' }], { strength: 2 })), { encrypted: true, method: 'aes', aesStrength: 192 });
  eq('AES-128 → aes/128', detectZipEncryption(buildAesZip([{ name: 'a.txt', data: 'x' }], { strength: 1 })), { encrypted: true, method: 'aes', aesStrength: 128 });
  eq('aesStrength 位值映射', [aesStrengthBits(1), aesStrengthBits(2), aesStrengthBits(3)], [128, 192, 256]);
  check('非 zip 输入不抛：回 none + error', (() => {
    const info = detectZipEncryption(Buffer.from('这不是 zip'));
    return info.encrypted === false && info.method === 'none' && typeof info.error === 'string' && info.error.length > 0;
  })());
  check('空 Buffer 不抛', detectZipEncryption(Buffer.alloc(0)).encrypted === false);
  check('不存在的路径不抛', detectZipEncryption(path.join(base, 'nope.zip')).encrypted === false);
}

console.log('## 独立交叉验证：Python zipfile 能解我们造的加密包');
{
  const zipPath = tmpFile('python-check', buildEncryptedZip([
    { name: 'hello.txt', data: '交叉验证 OK' },
    { name: 'data/blob.txt', data: 'deflate 也行', method: 8 }
  ], { password: PASSWORD }));
  const script = [
    'import sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1])',
    'print(z.read(sys.argv[2], pwd=sys.argv[3].encode()).decode("utf-8"))'
  ].join('\n');
  const run = spawnSync('python', ['-X', 'utf8', '-c', script, zipPath, 'hello.txt', PASSWORD], { encoding: 'utf8' });
  if (run.error || run.status === null) {
    console.log('  - 跳过：本机没有 python，独立交叉验证未执行');
  } else {
    check('Python 用同一密码读出明文', run.status === 0 && run.stdout.trim() === '交叉验证 OK', `status=${run.status} stderr=${(run.stderr || '').slice(0, 200)}`);
    const run2 = spawnSync('python', ['-X', 'utf8', '-c', script, zipPath, 'data/blob.txt', PASSWORD], { encoding: 'utf8' });
    check('Python 解 deflate 条目也一致', run2.status === 0 && run2.stdout.trim() === 'deflate 也行', `status=${run2.status}`);
    const bad = spawnSync('python', ['-X', 'utf8', '-c', script, zipPath, 'hello.txt', 'wrong'], { encoding: 'utf8' });
    check('Python 用错密码解不出（对齐我们的 bad_password 语义）', bad.status !== 0);
  }
}

fs.rmSync(base, { recursive: true, force: true });
console.log('');
if (failures.length > 0) {
  console.log(`✗ ${failures.length} 项失败：${failures.join('、')}`);
  process.exitCode = 1;
} else {
  console.log(`全部通过：${pass}/${pass} ok`);
}
