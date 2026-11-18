// M6-P1-②：压缩包目录表（只读 ZIP 中央目录；RAR/7z 只认格式；加密与损坏可区分）。
//
// 为什么需要：判断"这个包里有什么、有没有说明文件、是不是重复件"不该解压 2.5GB 的包——
// 读 ZIP 中央目录只要几十 KB；带密码的包连名字都能列出来（名字不加密），所以"加密"和"损坏"
// 必须给出不同的结论，否则用户只会看到一句"打不开"。
//
// 测试自己拼 ZIP（stored，无压缩），不依赖外部工具/网络。
// 用法：node scripts/test-archive-p1-zip.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseZipCentralDirectory,
  readArchiveToc,
  detectArchiveFormat,
  summarizeArchiveToc,
  ARCHIVE_FORMATS
} from '../src/file-archive.js';

let failed = 0;
let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`✅ ${name}`); }
  catch (error) { failed += 1; console.error(`❌ ${name} —— ${error?.message ?? error}`); }
}

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-p1-zip-'));
  dirs.push(d);
  return d;
}

// ── 造 ZIP（stored）────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** entries: [{name, data?:Buffer, encrypted?:boolean, isDir?:boolean}] */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data ?? Buffer.alloc(0);
    const crc = crc32(data);
    const flags = e.encrypted ? 0x1 : 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const zipBuf = makeZip([
  { name: '9013048.zip', data: Buffer.from('outer') },
  { name: '9013048/readme.txt', data: Buffer.from('商品号 9013048 的说明') },
  { name: '9013048/textures/' }
]);

// ── Buffer 版解析 ──────────────────────────────────────────────────────────
check('ZIP：读出中央目录条目与大小（不解压）', () => {
  const toc = parseZipCentralDirectory(zipBuf);
  assert.equal(toc.ok, true);
  assert.equal(toc.format, 'zip');
  assert.equal(toc.count, 3);
  assert.deepEqual(toc.entries.map((e) => e.name), ['9013048.zip', '9013048/readme.txt', '9013048/textures/']);
  assert.equal(toc.entries[1].size, Buffer.byteLength('商品号 9013048 的说明'));
});

check('ZIP：目录条目识别（名字以 / 结尾）', () => {
  const toc = parseZipCentralDirectory(zipBuf);
  assert.equal(toc.entries[2].isDir, true);
  assert.equal(toc.entries[0].isDir, false);
});

check('ZIP：加密标记（flags bit0）能单独识别', () => {
  const enc = makeZip([{ name: 'secret.zip', data: Buffer.from('x'), encrypted: true }]);
  const toc = parseZipCentralDirectory(enc);
  assert.equal(toc.ok, true, '加密的包仍能列名字');
  assert.equal(toc.encrypted, true);
  assert.equal(toc.error, 'encrypted');
  assert.equal(toc.entries[0].encrypted, true);
});

check('ZIP：损坏（不是 zip / 截断）→ error=corrupt', () => {
  assert.equal(parseZipCentralDirectory(Buffer.from('not a zip at all, just text')).error, 'corrupt');
  const truncated = zipBuf.subarray(0, Math.max(0, zipBuf.length - 30));
  assert.equal(parseZipCentralDirectory(truncated).error, 'corrupt');
});

check('ZIP：空包（0 条目）→ ok 且 count=0', () => {
  const empty = makeZip([]);
  const toc = parseZipCentralDirectory(empty);
  assert.equal(toc.ok, true);
  assert.equal(toc.count, 0);
});

check('ZIP：zip64 标记 → 明确报 zip64-unsupported（不是 corrupt）', () => {
  const fake = Buffer.from(zipBuf);
  const eocd = fake.length - 22;
  fake.writeUInt16LE(0xffff, eocd + 10); // entries total
  const toc = parseZipCentralDirectory(fake);
  assert.equal(toc.ok, false);
  assert.equal(toc.error, 'zip64-unsupported');
});

// ── 文件版（大文件只读头尾，不解压） ──────────────────────────────────────
const root = tmp();
const zipPath = path.join(root, '9013048 素材.zip');
fs.writeFileSync(zipPath, zipBuf);

check('文件版：readArchiveToc 与 Buffer 版结论一致', () => {
  const toc = readArchiveToc(zipPath);
  assert.equal(toc.ok, true);
  assert.equal(toc.count, 3);
  assert.equal(toc.entries[1].name, '9013048/readme.txt');
});

check('文件版：不存在的文件 → io-error，不抛', () => {
  const toc = readArchiveToc(path.join(root, 'nope.zip'));
  assert.equal(toc.ok, false);
  assert.equal(toc.error, 'io-error');
});

check('格式识别：RAR / 7z / gzip / 未知', () => {
  assert.equal(detectArchiveFormat(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])), ARCHIVE_FORMATS.rar);
  assert.equal(detectArchiveFormat(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])), ARCHIVE_FORMATS['7z']);
  assert.equal(detectArchiveFormat(Buffer.from([0x1f, 0x8b, 0x08])), ARCHIVE_FORMATS.gzip);
  assert.equal(detectArchiveFormat(Buffer.from('hello world hello world')), ARCHIVE_FORMATS.unknown);
});

check('RAR / 7z：目录表暂不支持 → unsupported-format（不是 corrupt）', () => {
  const rarPath = path.join(root, 'a.rar');
  fs.writeFileSync(rarPath, Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 1, 2, 3]));
  const rarToc = readArchiveToc(rarPath);
  assert.equal(rarToc.ok, false);
  assert.equal(rarToc.error, 'unsupported-format');
  assert.equal(rarToc.format, 'rar');
  const szPath = path.join(root, 'b.7z');
  fs.writeFileSync(szPath, Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00]));
  assert.equal(readArchiveToc(szPath).error, 'unsupported-format');
});

// ── 摘要 ────────────────────────────────────────────────────────────────────
check('摘要：条目数/总字节/说明文件/7 位商品号', () => {
  const s = summarizeArchiveToc(parseZipCentralDirectory(zipBuf));
  assert.equal(s.ok, true);
  assert.equal(s.count, 3);
  assert.equal(s.hasReadme, true);
  assert.equal(s.readmeName, '9013048/readme.txt');
  assert.deepEqual(s.boothIds, ['9013048']);
  assert.ok(s.totalBytes > 0);
});

check('摘要：加密包也能给出摘要（error=encrypted 但不崩）', () => {
  const s = summarizeArchiveToc(parseZipCentralDirectory(makeZip([{ name: '1.zip', data: Buffer.from('a'), encrypted: true }])));
  assert.equal(s.encrypted, true);
  assert.equal(s.error, 'encrypted');
  assert.equal(s.count, 1);
});

// ── 收尾 ────────────────────────────────────────────────────────────────────
for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
const total = passed + failed;
if (failed) { console.error(`\n❌ test-archive-p1-zip 失败 ${failed}/${total}`); process.exit(1); }
console.log(`\n✅ test-archive-p1-zip 全部通过（${passed}/${total}）`);
