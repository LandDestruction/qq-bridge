// src/zip-read.js 的契约测试：纯 JS 读 ZIP（只读、不落盘、不引第三方库）。
//
// 夹具全部在内存里现拼（scripts/fixtures/zip-build.mjs），覆盖：
//   stored / deflate 两种压缩方式、大小写不敏感与 `*/name` 后缀匹配、预览图排序、
//   加密位、超限保护、坏包不抛、路径穿越条目被丢弃、条目数上限。
import {
  ZIP_MAX_ENTRIES,
  ZIP_MAX_ENTRY_BYTES,
  findZipPreviewEntries,
  normalizeEntryName,
  readZipDirectory,
  readZipEntry,
  readZipEntrySafe
} from '../src/zip-read.js';
import { buildZip, findCentralOffset } from './fixtures/zip-build.mjs';

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

const STORED_TEXT = 'hello zip';
const DEFLATE_TEXT = 'deflate 内容：' + 'abc'.repeat(120);
const basicZip = buildZip([
  { name: 'readme.txt', data: STORED_TEXT, mtime: new Date(2026, 0, 2, 3, 4, 6) },
  { name: 'docs/a.txt', data: DEFLATE_TEXT, method: 8 },
  { name: 'images/', data: '' },
  { name: 'bin/blob.dat', data: Buffer.from([0, 1, 2, 3, 255]), method: 8 }
]);

console.log('## 目录解析（stored + deflate）');
{
  const dir = readZipDirectory(basicZip);
  eq('ok:true', dir.ok, true);
  eq('没有错误', dir.error, '');
  eq('文件条目 3 个（目录条目 images/ 被跳过）', dir.entries.length, 3);
  eq('条目名（含子目录）', dir.entries.map((entry) => entry.name), ['readme.txt', 'docs/a.txt', 'bin/blob.dat']);
  const readme = dir.entries[0];
  eq('stored 条目 method 0', readme.method, 0);
  eq('stored 条目解压后大小 = 原始大小', [readme.size, readme.compressedSize], [STORED_TEXT.length, STORED_TEXT.length]);
  eq('deflate 条目 method 8', dir.entries[1].method, 8);
  check('deflate 条目压缩后更小', dir.entries[1].compressedSize < dir.entries[1].size, `${dir.entries[1].compressedSize} < ${dir.entries[1].size}`);
  eq('未加密包里 encrypted 全 false', dir.entries.map((entry) => entry.encrypted), [false, false, false]);
  eq('包级 encrypted false', dir.encrypted, false);
  const mtime = new Date(readme.mtime);
  check('mtime 是可解析的 ISO 字符串', typeof readme.mtime === 'string' && readme.mtime.includes('T'), readme.mtime);
  eq('mtime 年月日时分为写入值', [mtime.getFullYear(), mtime.getMonth() + 1, mtime.getDate(), mtime.getHours(), mtime.getMinutes()], [2026, 1, 2, 3, 4]);
}

console.log('## 读条目内容');
{
  const stored = readZipEntry(basicZip, 'readme.txt');
  eq('stored：ok', stored.ok, true);
  eq('stored：内容正确', stored.bytes.toString('utf8'), STORED_TEXT);
  check('stored：回 Buffer', Buffer.isBuffer(stored.bytes), typeof stored.bytes);
  eq('stored：回带条目名', stored.name, 'readme.txt');
  const deflated = readZipEntry(basicZip, 'docs/a.txt');
  eq('deflate：ok', deflated.ok, true);
  eq('deflate：解压内容正确', deflated.bytes.toString('utf8'), DEFLATE_TEXT);
  const binary = readZipEntry(basicZip, 'bin/blob.dat');
  eq('二进制：字节原样', [...binary.bytes], [0, 1, 2, 3, 255]);
}

console.log('## 名字匹配');
{
  eq('大小写不敏感', readZipEntry(basicZip, 'README.TXT').bytes?.toString('utf8'), STORED_TEXT);
  eq('`*/name` 后缀匹配（找 docs/a.txt）', readZipEntry(basicZip, 'a.txt').name, 'docs/a.txt');
  eq('后缀匹配也大小写不敏感', readZipEntry(basicZip, 'BLOB.DAT').name, 'bin/blob.dat');
  const missing = readZipEntry(basicZip, 'nope.txt');
  eq('找不到的条目 → ok:false', missing.ok, false);
  eq('找不到的条目 → entry_not_found', missing.error, 'entry_not_found');
  eq('空名字不匹配任何条目', readZipEntry(basicZip, '').ok, false);
  eq('越权名字（../readme.txt）不会命中', readZipEntry(basicZip, '../readme.txt').ok, false);
}

console.log('## 预览图排序（根目录 > 深度浅 > 体积大）');
{
  const previewZip = buildZip([
    { name: 'abc-123/preview.png', data: Buffer.alloc(300, 1) },
    { name: 'zzz/thumbnail.png', data: Buffer.alloc(50, 2) },
    { name: 'deep/x/y/cover.png', data: Buffer.alloc(10, 3) },
    { name: 'preview.png', data: Buffer.alloc(100, 4) },
    { name: 'readme.txt', data: 'x' },
    { name: 'abc-123/asset', data: 'y' }
  ]);
  const dir = readZipDirectory(previewZip);
  const previews = findZipPreviewEntries(dir.entries);
  eq('认出 4 张预览候选', previews.length, 4);
  eq('根目录 preview.png 排第一', previews[0].name, 'preview.png');
  eq('其次浅层且体积大的 abc-123/preview.png', previews[1].name, 'abc-123/preview.png');
  eq('再次 zzz/thumbnail.png', previews[2].name, 'zzz/thumbnail.png');
  eq('最深的 cover.png 最后', previews[3].name, 'deep/x/y/cover.png');
  const tie = findZipPreviewEntries(readZipDirectory(buildZip([
    { name: 'b/thumbnail.png', data: Buffer.alloc(10) },
    { name: 'a/preview.png', data: Buffer.alloc(10) }
  ])).entries);
  eq('同深度同体积：preview.png 优先于 thumbnail.png', tie.map((entry) => entry.name), ['a/preview.png', 'b/thumbnail.png']);
  eq('没有预览图的包返回空数组', findZipPreviewEntries(dir.entries.filter((entry) => entry.name.endsWith('.txt'))).length, 0);
  eq('非数组输入不炸', findZipPreviewEntries(null).length, 0);
  eq('preview 内容能直接读出来', readZipEntry(previewZip, previews[1].name).bytes.length, 300);
}

console.log('## 加密 / 不支持的压缩方式 / 大小上限');
{
  const encryptedZip = buildZip([{ name: 'secret.txt', data: 'x', encrypted: true, method: 0 }]);
  const encryptedDir = readZipDirectory(encryptedZip);
  eq('加密条目标 encrypted:true', encryptedDir.entries[0].encrypted, true);
  eq('包级 encrypted:true', encryptedDir.encrypted, true);
  const encryptedRead = readZipEntry(encryptedZip, 'secret.txt');
  eq('读加密条目 → ok:false', encryptedRead.ok, false);
  eq('读加密条目 → encrypted', encryptedRead.error, 'encrypted');

  const methodZip = buildZip([{ name: 'weird.bin', data: 'abc', method: 99 }]);
  eq('不认识的 method → ok:false', readZipEntry(methodZip, 'weird.bin').ok, false);
  eq('不认识的 method → unsupported_method', readZipEntry(methodZip, 'weird.bin').error, 'unsupported_method');

  const bigData = Buffer.alloc(4096, 7);
  const bigZip = buildZip([{ name: 'big.bin', data: bigData, method: 8 }]);
  const tooLarge = readZipEntry(bigZip, 'big.bin', { maxBytes: 100 });
  eq('超过 maxBytes → ok:false', tooLarge.ok, false);
  eq('超过 maxBytes → entry_too_large', tooLarge.error, 'entry_too_large');
  eq('默认上限 8MB 时 4KB 条目照读', readZipEntry(bigZip, 'big.bin').bytes.length, 4096);
  eq('ZIP_MAX_ENTRY_BYTES 就是 8MB', ZIP_MAX_ENTRY_BYTES, 8 * 1024 * 1024);
  eq('maxBytes 非法值回退默认上限（照读）', readZipEntry(bigZip, 'big.bin', { maxBytes: -1 }).ok, true);
}

console.log('## 坏包：一律回错，绝不抛');
{
  const notBuffer = readZipDirectory('not a buffer');
  eq('字符串输入 → not_a_zip', [notBuffer.ok, notBuffer.error], [false, 'not_a_zip']);
  eq('null 输入 → not_a_zip', readZipDirectory(null).error, 'not_a_zip');
  eq('短 buffer → not_a_zip', readZipDirectory(Buffer.alloc(10)).error, 'not_a_zip');
  eq('随机字节 → not_a_zip', readZipDirectory(Buffer.from(Array.from({ length: 100 }, (_, index) => index))).error, 'not_a_zip');
  eq('去掉 EOCD → not_a_zip', readZipDirectory(basicZip.subarray(0, basicZip.length - 22)).error, 'not_a_zip');
  eq('空 buffer 读条目 → ok:false 且不抛', readZipEntry(Buffer.alloc(0), 'a').ok, false);
  eq('readZipEntrySafe(null) 返回结构完整', readZipEntrySafe(null, 'x'), { ok: false, name: 'x', bytes: null, error: 'not_a_zip' });
  eq('readZipEntrySafe 坏包不抛', readZipEntrySafe(Buffer.from('garbage'), 'x').ok, false);

  const truncated = Buffer.from(basicZip);
  const eocdOffset = truncated.length - 22;
  truncated.writeUInt32LE(truncated.length - 4, eocdOffset + 16); // 中央目录偏移指到 EOF 附近
  eq('中央目录越界 → truncated', readZipDirectory(truncated).error, 'truncated');
  const brokenSig = Buffer.from(basicZip);
  brokenSig.writeUInt32LE(0, findCentralOffset(brokenSig));
  eq('中央目录签名坏 → bad_central_directory', readZipDirectory(brokenSig).error, 'bad_central_directory');
}

console.log('## 路径穿越与条目名规范化');
{
  eq('normalizeEntryName：反斜杠转正斜杠', normalizeEntryName('a\\b\\c.txt'), 'a/b/c.txt');
  eq('normalizeEntryName：去 ./', normalizeEntryName('./a/b.txt'), 'a/b.txt');
  eq('normalizeEntryName：拒绝 ..', normalizeEntryName('../evil.txt'), '');
  eq('normalizeEntryName：拒绝中间 ..', normalizeEntryName('a/../../b.txt'), '');
  eq('normalizeEntryName：拒绝绝对路径', normalizeEntryName('/etc/passwd'), '');
  eq('normalizeEntryName：拒绝盘符', normalizeEntryName('C:\\Windows\\win.ini'), '');
  eq('normalizeEntryName：目录条目为空', normalizeEntryName('abc-123/'), '');

  const evilZip = buildZip([
    { name: '../evil.txt', data: 'escape' },
    { name: '/abs.txt', data: 'abs' },
    { name: 'a/../../b.txt', data: 'dotdot' },
    { name: 'a\\b\\ok.txt', data: 'windows-name' },
    { name: 'safe.txt', data: 'safe' }
  ]);
  const dir = readZipDirectory(evilZip);
  eq('穿越/绝对路径条目被丢弃，只剩安全的', dir.entries.map((entry) => entry.name), ['a/b/ok.txt', 'safe.txt']);
  eq('被丢弃的条目也读不到', readZipEntry(evilZip, 'evil.txt').ok, false);
  eq('反斜杠名字规范化后可读', readZipEntry(evilZip, 'a/b/ok.txt').bytes.toString('utf8'), 'windows-name');
}

console.log('## 条目数上限');
{
  const many = buildZip(Array.from({ length: 40 }, (_, index) => ({ name: `f${index}.txt`, data: '' })));
  eq('40 条目正常解析', readZipDirectory(many).entries.length, 40);
  const tooMany = buildZip(Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, index) => ({ name: `f${index}.txt`, data: '' })));
  eq('超过 20000 条目 → too_many_entries', readZipDirectory(tooMany).error, 'too_many_entries');
  eq('条目数常量就是 20000', ZIP_MAX_ENTRIES, 20000);
}

console.log('## 坏时间戳不编时间');
{
  const zip = Buffer.from(basicZip);
  const central = findCentralOffset(zip);
  zip.writeUInt16LE(0, central + 14); // 中央目录 modDate = 0
  const dir = readZipDirectory(zip);
  eq('DOS 时间为 0 时 mtime 为空串', dir.entries[0].mtime, '');
}

console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  console.log('失败项：');
  for (const name of failures) console.log(` - ${name}`);
}
process.exit(failures.length ? 1 : 0);
