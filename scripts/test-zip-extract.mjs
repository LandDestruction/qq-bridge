// src/zip-extract.js 的契约测试：流式落盘解压（不整包读内存）。
//
// 夹具用 scripts/fixtures/zip-build.mjs 现拼，落 os.tmpdir() 下的临时目录，跑完删掉：
//   stored / deflate 字节一致、嵌套目录、目录条目、穿越与绝对路径条目被 skipped、
//   坏包不炸、加密包拒绝、累计上限、同名加后缀不覆盖、preview 顺序与 depth、
//   文件版中央目录与内存版完全一致、keepZip=false 时不删包、缺文件回 not_found。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ZIP_EXTRACT_MAX_ENTRIES,
  ZIP_EXTRACT_MAX_PASSWORDS,
  ZIP_EXTRACT_MAX_TOTAL_BYTES,
  extractZipToDir,
  listZipPreview,
  readZipDirectoryFromFile
} from '../src/zip-extract.js';
import { readZipDirectory } from '../src/zip-read.js';
import { buildAesZip, buildEncryptedZip, buildZip } from './fixtures/zip-build.mjs';

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

const STORED_TEXT = 'hello zip extract';
const DEFLATE_TEXT = '流式解压：' + 'xyz'.repeat(400);
const mixedZip = buildZip([
  { name: 'readme.txt', data: STORED_TEXT },
  { name: 'docs/a.txt', data: DEFLATE_TEXT, method: 8 },
  { name: 'docs/deep/b.txt', data: '嵌套两层', method: 8 },
  { name: 'dir/', data: '' },
  { name: 'dir/inner.txt', data: '目录条目自动建', method: 8 }
]);

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-extract-test-'));
let caseIndex = 0;
function tmpDir(label) {
  caseIndex += 1;
  const dir = path.join(base, `${caseIndex}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function writeZip(dir, label, buffer) {
  const file = path.join(dir, `${label}.zip`);
  fs.writeFileSync(file, buffer);
  return file;
}

function findEocdOffset(zip) {
  for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

console.log('## 文件版中央目录与内存版一致');
{
  const dir = tmpDir('dir-consistency');
  const zipPath = writeZip(dir, 'mixed', mixedZip);
  const fromFile = await readZipDirectoryFromFile(zipPath);
  const fromMemory = readZipDirectory(mixedZip);
  eq('ok 一致', fromFile.ok, fromMemory.ok);
  eq('error 一致', fromFile.error, '');
  eq('entries 完全一致（含 localOffset/mtime）', fromFile.entries, fromMemory.entries);
  eq('加密标记一致', fromFile.encrypted, false);
  eq('目录条目默认不出现（4 个文件）', fromFile.entries.length, 4);
}

console.log('## 解压：stored + deflate 字节一致、嵌套目录与目录条目');
{
  const dir = tmpDir('extract-mixed');
  const zipPath = writeZip(dir, 'mixed', mixedZip);
  const destDir = path.join(dir, 'out', 'nested'); // 不预先创建，验证自己建
  const result = await extractZipToDir(zipPath, destDir);
  eq('ok:true', result.ok, true);
  eq('error 为空', result.error, '');
  eq('解出 4 个文件', result.files, 4);
  eq('skipped 为空', result.skipped, []);
  eq('destDir 是绝对路径', result.destDir, path.resolve(destDir));
  eq('stored 内容一致', fs.readFileSync(path.join(destDir, 'readme.txt'), 'utf8'), STORED_TEXT);
  eq('deflate 内容一致', fs.readFileSync(path.join(destDir, 'docs/a.txt'), 'utf8'), DEFLATE_TEXT);
  eq('嵌套两层内容一致', fs.readFileSync(path.join(destDir, 'docs/deep/b.txt'), 'utf8'), '嵌套两层');
  eq('目录条目自动建：dir/ 存在', fs.statSync(path.join(destDir, 'dir')).isDirectory(), true);
  eq('目录条目下的文件写进去了', fs.readFileSync(path.join(destDir, 'dir/inner.txt'), 'utf8'), '目录条目自动建');
  eq('bytes 等于各文件大小之和', result.bytes, Buffer.byteLength(STORED_TEXT) + Buffer.byteLength(DEFLATE_TEXT) + Buffer.byteLength('嵌套两层') + Buffer.byteLength('目录条目自动建'));
  eq('没有留下 .part 半成品', fs.readdirSync(destDir).some((name) => name.endsWith('.part')), false);
  eq('zipKept:true（默认保留原包）', result.zipKept, true);
  check('zip 还在', fs.existsSync(zipPath));
}

console.log('## 安全：穿越条目与绝对路径条目被 skipped，且没写出目录');
{
  const dir = tmpDir('unsafe');
  const zip = buildZip([
    { name: 'ok.txt', data: 'fine' },
    { name: '../evil.txt', data: 'evil' },
    { name: '/abs.txt', data: 'evil' },
    { name: 'C:\\windows\\win.ini', data: 'evil' }
  ]);
  const zipPath = writeZip(dir, 'unsafe', zip);
  const destDir = path.join(dir, 'out');
  const result = await extractZipToDir(zipPath, destDir);
  eq('ok:true（坏条目只跳过不炸）', result.ok, true);
  eq('只解出 1 个文件', result.files, 1);
  eq('skipped 3 条', result.skipped.length, 3);
  eq('跳过原因都是 unsafe_path', result.skipped.map((item) => item.reason), ['unsafe_path', 'unsafe_path', 'unsafe_path']);
  eq('保留了原始条目名便于排查', result.skipped.map((item) => item.name), ['../evil.txt', '/abs.txt', 'C:\\windows\\win.ini']);
  eq('ok.txt 正常写出', fs.readFileSync(path.join(destDir, 'ok.txt'), 'utf8'), 'fine');
  check('evil.txt 没写到上级目录', fs.existsSync(path.join(dir, 'evil.txt')) === false);
  check('父目录里只有 out 一个条目', fs.readdirSync(dir).sort().join(',') === ['out', 'unsafe.zip'].join(','));
}

console.log('## 坏包与不支持：不炸、回明确错误');
{
  const dir = tmpDir('bad');
  // 缺 EOCD：砍掉尾部 22 字节
  const noEocd = mixedZip.subarray(0, mixedZip.length - 22);
  const noEocdPath = writeZip(dir, 'no-eocd', noEocd);
  const noEocdOut = await extractZipToDir(noEocdPath, path.join(dir, 'out1'));
  eq('缺 EOCD → not_a_zip', noEocdOut.error, 'not_a_zip');
  eq('not_a_zip 时 ok:false', noEocdOut.ok, false);
  eq('没有解出任何文件', noEocdOut.files, 0);

  // ZIP64 标记：把 EOCD 里的 totalEntries 写成 0xffff
  const zip64 = Buffer.from(mixedZip);
  zip64.writeUInt16LE(0xffff, findEocdOffset(zip64) + 10);
  const zip64Out = await extractZipToDir(writeZip(dir, 'zip64', zip64), path.join(dir, 'out2'));
  eq('ZIP64 → zip64_unsupported', zip64Out.error, 'zip64_unsupported');

  // 加密标记但没给密码：现在会明确要密码（不再是笼统的 error:'encrypted'）
  const flaggedEncrypted = buildZip([{ name: 'secret.txt', data: 'x', encrypted: true }]);
  const flaggedOut = await extractZipToDir(writeZip(dir, 'flagged', flaggedEncrypted), path.join(dir, 'out3'));
  eq('标了加密但没给密码 → password_required', [flaggedOut.ok, flaggedOut.reason], [false, 'password_required']);
  eq('加密标记如实回报', [flaggedOut.encrypted, flaggedOut.encryption], [true, 'zipcrypto']);
  eq('无密码时一个文件都不解', flaggedOut.files, 0);

  // 缺文件
  const missingOut = await extractZipToDir(path.join(dir, 'nope.zip'), path.join(dir, 'out4'));
  eq('文件不存在 → not_found', missingOut.error, 'not_found');
  eq('文件不存在时 ok:false', missingOut.ok, false);

  // 解压方式不支持（method 3）
  const weird = buildZip([{ name: 'weird.bin', data: 'abc', method: 3 }, { name: 'ok.txt', data: 'ok' }]);
  const weirdOut = await extractZipToDir(writeZip(dir, 'weird', weird), path.join(dir, 'out5'));
  eq('method 3 被跳过', weirdOut.skipped.map((item) => [item.name, item.reason]), [['weird.bin', 'unsupported_method']]);
  eq('同包里正常条目照解', fs.readFileSync(path.join(dir, 'out5', 'ok.txt'), 'utf8'), 'ok');
}

console.log('## 累计上限：超了停下并如实回报');
{
  const dir = tmpDir('limit');
  const zip = buildZip([
    { name: 'a.txt', data: 'aaaaa' },
    { name: 'b.txt', data: 'bbbbb' }
  ]);
  const zipPath = writeZip(dir, 'limit', zip);
  const destDir = path.join(dir, 'out');
  const result = await extractZipToDir(zipPath, destDir, { maxTotalBytes: 5 });
  eq('ok:false', result.ok, false);
  eq('error:too_large', result.error, 'too_large');
  eq('一个都没写', result.files, 0);
  eq('skipped 列出被挡下的条目', result.skipped.map((item) => item.reason), ['too_large', 'too_large']);
  eq('常量是 8GB', ZIP_EXTRACT_MAX_TOTAL_BYTES, 8 * 1024 ** 3);
  eq('条目上限常量 20000', ZIP_EXTRACT_MAX_ENTRIES, 20000);
}

console.log('## 同名冲突加后缀，不覆盖用户已有文件');
{
  const dir = tmpDir('conflict');
  const zipPath = writeZip(dir, 'conflict', buildZip([{ name: 'readme.txt', data: '新内容' }]));
  const destDir = path.join(dir, 'out');
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'readme.txt'), '旧内容');
  const result = await extractZipToDir(zipPath, destDir);
  eq('ok:true', result.ok, true);
  eq('原文件没被覆盖', fs.readFileSync(path.join(destDir, 'readme.txt'), 'utf8'), '旧内容');
  eq('新文件落到 readme.1.txt', fs.readFileSync(path.join(destDir, 'readme.1.txt'), 'utf8'), '新内容');
  eq('目标是 .1 后缀', result.files, 1);
  // 再解一次 → .2
  await extractZipToDir(zipPath, destDir);
  eq('第二次冲突 → .2', fs.existsSync(path.join(destDir, 'readme.2.txt')), true);
  eq('原有无关文件不被动', fs.readdirSync(destDir).sort().join(','), 'readme.1.txt,readme.2.txt,readme.txt');
}

console.log('## 进度回调与保留原包');
{
  const dir = tmpDir('progress');
  const zipPath = writeZip(dir, 'progress', mixedZip);
  const events = [];
  const destDir = path.join(dir, 'out');
  const result = await extractZipToDir(zipPath, destDir, {
    keepZip: false, // 只是意图：这里不删包，交给调用方
    onProgress: (event) => events.push(event)
  });
  eq('ok:true', result.ok, true);
  check('进度至少回调一次', events.length >= 1, events.length);
  const last = events[events.length - 1];
  eq('最后一次进度 bytes = 解压总量', last.bytes, result.bytes);
  eq('最后一次进度 files = 文件数', last.files, result.files);
  eq('最后一次 percent 封顶 99（收尾由调用方补 100）', last.percent, 99);
  eq('keepZip:false 时仍回 zipKept:true', result.zipKept, true);
  check('keepZip:false 不会删 zip', fs.existsSync(zipPath));
  // 进度回调抛异常不能拖垮解压
  const throwingDir = path.join(dir, 'out-throw');
  const throwingResult = await extractZipToDir(zipPath, throwingDir, { onProgress: () => { throw new Error('boom'); } });
  eq('进度回调抛错不影响结果', throwingResult.ok, true);
}

console.log('## 解压前预览：顺序与 depth');
{
  const dir = tmpDir('preview');
  const zipPath = writeZip(dir, 'mixed', mixedZip);
  const preview = await listZipPreview(zipPath);
  eq('ok:true', preview.ok, true);
  eq('默认列出全部 5 条（含目录条目）', preview.entries.length, 5);
  eq('顺序 = 中央目录顺序', preview.entries.map((entry) => entry.name), ['readme.txt', 'docs/a.txt', 'docs/deep/b.txt', 'dir', 'dir/inner.txt']);
  eq('depth 计算', preview.entries.map((entry) => entry.depth), [0, 1, 2, 0, 1]);
  eq('目录条目 isDir:true', preview.entries.filter((entry) => entry.isDir).map((entry) => entry.name), ['dir']);
  eq('文件条目 isDir:false', preview.entries.filter((entry) => !entry.isDir).length, 4);
  const limited = await listZipPreview(zipPath, { maxEntries: 2 });
  eq('maxEntries 限制返回条数', limited.entries.map((entry) => entry.name), ['readme.txt', 'docs/a.txt']);
  const missingPreview = await listZipPreview(path.join(dir, 'nope.zip'));
  eq('坏路径 → ok:false + not_found', [missingPreview.ok, missingPreview.error], [false, 'not_found']);
}

console.log('## 破坏性边角：目标目录已存在且非空时保留内容');
{
  const dir = tmpDir('existing');
  const zipPath = writeZip(dir, 'mixed', mixedZip);
  const destDir = path.join(dir, 'out');
  fs.mkdirSync(path.join(destDir, 'keepme'), { recursive: true });
  fs.writeFileSync(path.join(destDir, 'keepme', 'note.txt'), '别删我');
  const result = await extractZipToDir(zipPath, destDir);
  eq('ok:true', result.ok, true);
  eq('已有文件还在', fs.readFileSync(path.join(destDir, 'keepme', 'note.txt'), 'utf8'), '别删我');
  eq('新文件也解出来了', fs.readFileSync(path.join(destDir, 'readme.txt'), 'utf8'), STORED_TEXT);
}

console.log('## 加密包：密码本逐个试，验过才落盘');
{
  const dir = tmpDir('encrypted');
  const password = 'acg18';
  const encryptedZip = buildEncryptedZip([
    { name: 'readme.txt', data: STORED_TEXT },
    { name: 'docs/a.txt', data: DEFLATE_TEXT, method: 8 },
    { name: 'nested/deep/b.txt', data: '加密+嵌套', method: 8 }
  ], { password });
  const zipPath = writeZip(dir, 'encrypted', encryptedZip);

  const good = await extractZipToDir(zipPath, path.join(dir, 'good'), { password });
  eq('正确密码 → ok:true', good.ok, true);
  eq('正确密码解出 stored 内容', fs.readFileSync(path.join(dir, 'good', 'readme.txt'), 'utf8'), STORED_TEXT);
  eq('正确密码解出 deflate 内容', fs.readFileSync(path.join(dir, 'good', 'docs/a.txt'), 'utf8'), DEFLATE_TEXT);
  eq('加密包里嵌套目录自动建好', fs.readFileSync(path.join(dir, 'good', 'nested/deep/b.txt'), 'utf8'), '加密+嵌套');
  eq('结果标出加密类型与命中的密码', [good.encrypted, good.encryption, good.usedPassword, good.triedPasswords], [true, 'zipcrypto', password, 1]);
  eq('三个文件全解出', good.files, 3);

  // 密码错：一条都不落盘，也不建目标目录
  const badDest = path.join(dir, 'bad');
  const bad = await extractZipToDir(zipPath, badDest, { password: 'wrong' });
  eq('错误密码 → ok:false + bad_password', [bad.ok, bad.reason], [false, 'bad_password']);
  eq('错误密码试了 1 个', bad.triedPasswords, 1);
  check('错误密码不落盘（目标目录都没建）', !fs.existsSync(badDest), fs.existsSync(badDest) ? fs.readdirSync(badDest) : '');
  eq('错误密码 files/bytes 都是 0', [bad.files, bad.bytes], [0, 0]);

  // 密码本：前两个不对，第三个命中
  const list = await extractZipToDir(zipPath, path.join(dir, 'list'), { passwords: ['nope1', 'nope2', password] });
  eq('密码本命中第 3 个', [list.ok, list.usedPassword, list.triedPasswords], [true, password, 3]);
  eq('密码本命中后内容正确', fs.readFileSync(path.join(dir, 'list', 'readme.txt'), 'utf8'), STORED_TEXT);

  const allWrong = await extractZipToDir(zipPath, path.join(dir, 'allwrong'), { passwords: ['a', 'b', 'c'] });
  eq('密码全错 → bad_password + triedPasswords=3', [allWrong.ok, allWrong.reason, allWrong.triedPasswords], [false, 'bad_password', 3]);
  check('密码全错同样不落盘', !fs.existsSync(path.join(dir, 'allwrong')));

  const more = await extractZipToDir(zipPath, path.join(dir, 'more'), {
    passwords: ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9', 'x10', password]
  });
  eq('密码本最多试 10 个，第 11 个不试', [more.ok, more.reason, more.triedPasswords], [false, 'bad_password', ZIP_EXTRACT_MAX_PASSWORDS]);

  const noPassword = await extractZipToDir(zipPath, path.join(dir, 'nopass'));
  eq('没给密码 → password_required', [noPassword.ok, noPassword.reason], [false, 'password_required']);
  eq('没给密码的报错是中文人话', noPassword.error.includes('没给密码'), true);

  // 未加密的包即使带了密码也照旧解，不受影响
  const plainWithPassword = await extractZipToDir(writeZip(dir, 'plain', mixedZip), path.join(dir, 'plain'), { password });
  eq('未加密包带 password 照常解', [plainWithPassword.ok, plainWithPassword.encryption, plainWithPassword.usedPassword], [true, 'none', '']);
}

console.log('## AES 加密包：明确拒绝，不假装密码错、不落盘');
{
  const dir = tmpDir('aes');
  const aesPath = writeZip(dir, 'aes', buildAesZip([{ name: 'secret.txt', data: 'aes content' }]));
  const destDir = path.join(dir, 'out');
  const result = await extractZipToDir(aesPath, destDir, { password: 'whatever' });
  eq('AES → ok:false + aes_unsupported', [result.ok, result.reason], [false, 'aes_unsupported']);
  eq('AES 报错文案指向 7-Zip', result.error.includes('7-Zip'), true);
  eq('AES 结果里标了 aes', result.encryption, 'aes');
  check('AES 包不落盘', !fs.existsSync(destDir));
  eq('AES 不尝试密码（triedPasswords=0）', result.triedPasswords, 0);
}

console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  console.log('失败项：');
  for (const name of failures) console.log(` - ${name}`);
}
try {
  fs.rmSync(base, { recursive: true, force: true });
} catch (error) {
  console.log(`（临时目录清理失败：${error.message}）`);
}
process.exit(failures.length ? 1 : 0);
