// 回收站存储统计 + 按保留期手动清理（GET trash/storage、POST trash/cleanup）。
//
// 断言重点（这条路径会真删文件）：
// - storage 的 bytes/files 必须和盘面一致（造 3 个文件、含嵌套目录），空回收站回 0 而不是崩；
// - diskFree/diskTotal 要么是数字、要么是 null（statfs 不可用时前端要能隐藏），不能是 NaN/字符串；
// - cleanup 必须 confirm:true（字符串 "true" / 1 一律拒），缺确认时一个字节都不能删；
// - 保留期内不删、超期才删且回真实字节数、保留期 0 = 永久保留不删；
// - 单条删失败不影响其它条（越界 movedTo 这种损坏记录只记失败数）；
// - 路径穿越：`../x`、`a/b`、绝对路径 id 一律拒；手改状态文件造的越界 movedTo 不可恢复、也不会被清理误删。
// 全部用真 fs 临时档案根 + 假 deps，不碰真库、不发网络。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createLibraryTrash, libtrEntryIdOk, libtrBatchAbs, libtrWalkCount } = await import(
  pathToFileURL(path.join(ROOT, 'src/bridge/console/library-trash.js')).href
);
const { scanLibraryTree, assetsFromFiles } = await import(pathToFileURL(path.join(ROOT, 'src/library-scan.js')).href);
const { safeResolveInside } = await import(pathToFileURL(path.join(ROOT, 'src/file-archive/paths.js')).href);

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-trash-storage-'));
const libDir = path.join(tmp, 'library');
const stateDir = path.join(tmp, 'state');
const trashDir = path.join(libDir, '.trash');
fs.mkdirSync(libDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

const logs = [];
const deps = {
  fs,
  path,
  STATE_DIR: stateDir,
  log: (message) => logs.push(String(message)),
  fileArchiveRootDir: () => libDir,
  safeResolveInside,
  scanLibraryTree,
  assetsFromFiles,
  atomicWriteJson: (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2))
};
const statePath = path.join(stateDir, 'booth-trash.json');
const seedState = (items) => fs.writeFileSync(statePath, JSON.stringify({ v: 1, at: 0, items }, null, 2));
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const DAY = 24 * 60 * 60 * 1000;

function makeInstance() {
  return createLibraryTrash(deps).handleConsoleLibraryTrash;
}
let handler = makeInstance();

async function call(method, pathname, { body = null, headers = {} } = {}) {
  const result = { payload: null, status: 0 };
  const request = {
    req: { method, headers },
    url: new URL(`http://127.0.0.1:3100${pathname}`),
    readBody: async () => {
      if (body === null) throw new Error('没有请求体');
      return body;
    },
    sendJson: (payload, status) => { result.payload = payload; result.status = status || 200; }
  };
  const handled = await handler(request);
  return { ...result, handled };
}

const writeFileAt = (rel, content) => {
  const abs = path.join(libDir, ...String(rel).split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return Buffer.byteLength(content);
};

console.log('## storage：空回收站');
{
  const res = await call('GET', '/api/library/trash/storage');
  eq('空回收站返回 200 且被本 handler 处理', [res.status, res.handled], [200, true]);
  eq('返回体字段就是约定的 7 个', Object.keys(res.payload).sort(), ['bytes', 'checkedAt', 'diskFree', 'diskTotal', 'files', 'ok', 'root'].sort());
  eq('ok:true', res.payload.ok, true);
  eq('root 是 .trash 的绝对路径', res.payload.root, path.resolve(libDir, '.trash'));
  eq('空回收站 bytes 0', res.payload.bytes, 0);
  eq('空回收站 files 0', res.payload.files, 0);
  check('checkedAt 是合理时间戳', Number.isFinite(res.payload.checkedAt) && res.payload.checkedAt > 0, String(res.payload.checkedAt));
  check('diskFree 是数字或 null（绝不为 NaN/字符串）', res.payload.diskFree === null || (typeof res.payload.diskFree === 'number' && Number.isFinite(res.payload.diskFree)), JSON.stringify(res.payload.diskFree));
  check('diskTotal 是数字或 null', res.payload.diskTotal === null || (typeof res.payload.diskTotal === 'number' && Number.isFinite(res.payload.diskTotal)), JSON.stringify(res.payload.diskTotal));
}

console.log('## storage：3 个文件（含嵌套）数值一致');
{
  const s1 = writeFileAt('.trash/20260101T000000_aaaa/a.zip', '0123456789');
  const s2 = writeFileAt('.trash/20260101T000000_aaaa/sub/b.jpg', '01234567890123456789');
  const s3 = writeFileAt('.trash/20260102T000000_bbbb/c.png', '01234');
  const expectedBytes = s1 + s2 + s3;
  const res = await call('GET', '/api/library/trash/storage');
  eq('files 数等于盘上文件数 3', res.payload.files, 3);
  eq('bytes 等于三文件字节之和', res.payload.bytes, expectedBytes);
  eq('嵌套目录也被统计到', res.payload.bytes >= 35, true);
  if (res.payload.diskFree !== null && res.payload.diskTotal !== null) {
    check('diskTotal ≥ diskFree 且都为正数', res.payload.diskTotal >= res.payload.diskFree && res.payload.diskTotal > 0, `${res.payload.diskFree}/${res.payload.diskTotal}`);
  } else {
    check('statfs 不可用时两个字段同时为 null（前端据此隐藏）', res.payload.diskFree === null && res.payload.diskTotal === null, `${res.payload.diskFree}/${res.payload.diskTotal}`);
  }
  const counts = libtrWalkCount(deps, trashDir);
  eq('统计函数与接口数值一致', counts, { files: 3, bytes: expectedBytes });
}

console.log('## storage：权限与方法');
{
  const agent1 = await call('GET', '/api/library/trash/storage', { headers: { 'x-agent-token': 'abc' } });
  eq('GET + x-agent-token → 403', agent1.status, 403);
  const agent2 = await call('GET', '/api/library/trash/storage', { headers: { 'x-agent-call': '1' } });
  eq('GET + x-agent-call → 403', agent2.status, 403);
  const post = await call('POST', '/api/library/trash/storage', { body: { anything: 1 } });
  eq('POST storage → 405', post.status, 405);
  check('405 文案说明只支持 GET', String(post.payload.error).includes('GET'), post.payload.error);
}

console.log('## cleanup：confirm 校验');
{
  const missing = await call('POST', '/api/library/trash/cleanup', { body: {} });
  eq('缺 confirm → 400', missing.status, 400);
  eq('错误文案正是约定的那句', missing.payload.error, '清理不可恢复，请带 confirm:true');
  const strTrue = await call('POST', '/api/library/trash/cleanup', { body: { confirm: 'true' } });
  eq('confirm 字符串 "true" → 400（只认布尔 true）', strTrue.status, 400);
  const one = await call('POST', '/api/library/trash/cleanup', { body: { confirm: 1 } });
  eq('confirm 1 → 400', one.status, 400);
  const noBody = await call('POST', '/api/library/trash/cleanup', { body: null });
  eq('没有请求体 → 400 不崩', noBody.status, 400);
  eq('三次拒绝都没碰盘面（3 个文件还在）', fs.existsSync(path.join(trashDir, '20260101T000000_aaaa', 'a.zip')), true);
}

console.log('## cleanup：保留期内不删');
{
  fs.rmSync(trashDir, { recursive: true, force: true });
  const bytes = writeFileAt('.trash/20260105T000000_fresh/f.zip', 'fresh-bytes');
  seedState([{
    id: '20260105T000000_fresh', key: 'k-fresh', title: '新件', boothId: '', bytes, files: 1,
    at: Date.now() - 2 * DAY, movedTo: '.trash/20260105T000000_fresh', fromDirs: [''], relPaths: ['f.zip']
  }]);
  const res = await call('POST', '/api/library/trash/cleanup', { body: { confirm: true } });
  eq('保留期内清理 200', res.status, 200);
  eq('purged 0', res.payload.purged, 0);
  eq('bytes 0', res.payload.bytes, 0);
  eq('kept 1', res.payload.kept, 1);
  eq('默认保留期 30 天如实回显', res.payload.retentionDays, 30);
  eq('文件还在', fs.existsSync(path.join(trashDir, '20260105T000000_fresh', 'f.zip')), true);
  eq('状态里也还在', readState().items.length, 1);
  eq('没有失败提示', res.payload.error, undefined);
}

console.log('## cleanup：超期删掉且回字节数；单条失败不影响其它条');
{
  fs.rmSync(trashDir, { recursive: true, force: true });
  fs.rmSync(statePath, { force: true });
  const oldBytes = writeFileAt('.trash/20260101T000000_old/old.zip', 'old-file-bytes!');
  const freshBytes = writeFileAt('.trash/20260110T000000_new/new.zip', 'new');
  // 越界记录：movedTo 指向档案根外，清理必须跳过（不删）并记失败。
  const outsideDir = path.join(tmp, 'outside');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'keep.txt'), 'do-not-delete');
  const oldAt = Date.now() - 40 * DAY;
  seedState([
    { id: '20260101T000000_old', key: 'k-old', title: '旧件', boothId: '', bytes: oldBytes, files: 1, at: oldAt, movedTo: '.trash/20260101T000000_old', fromDirs: [''], relPaths: ['old.zip'] },
    { id: '20260110T000000_new', key: 'k-new', title: '新件', boothId: '', bytes: freshBytes, files: 1, at: Date.now(), movedTo: '.trash/20260110T000000_new', fromDirs: [''], relPaths: ['new.zip'] },
    { id: '20260101T000000_evil', key: 'k-evil', title: '越界件', boothId: '', bytes: 7, files: 1, at: oldAt, movedTo: '../outside', fromDirs: [''], relPaths: ['keep.txt'] }
  ]);
  const res = await call('POST', '/api/library/trash/cleanup', { body: { confirm: true } });
  eq('超期清理 200', res.status, 200);
  eq('只删超期且合法的那 1 件', res.payload.purged, 1);
  eq('bytes 等于旧件字节数', res.payload.bytes, oldBytes);
  eq('kept 剩 2（未超期 + 越界损坏记录）', res.payload.kept, 2);
  check('失败数如实回报', String(res.payload.error).includes('1 件删除失败'), res.payload.error);
  eq('旧件目录真的没了', fs.existsSync(path.join(trashDir, '20260101T000000_old')), false);
  eq('未超期件没被删', fs.existsSync(path.join(trashDir, '20260110T000000_new', 'new.zip')), true);
  eq('越界记录没把档案根外的文件删掉', fs.readFileSync(path.join(outsideDir, 'keep.txt'), 'utf8'), 'do-not-delete');
  eq('状态里删掉 1 条、坏记录保留', readState().items.map((it) => it.id).sort(), ['20260101T000000_evil', '20260110T000000_new']);
  check('日志写明清理件数与保留期', logs.some((line) => line.includes('[回收站] 手动清理：删掉 1 件（保留期 30 天）')), logs.join(' | '));
  const view = await call('GET', '/api/library/trash');
  eq('GET 回收站仍能列出 2 条', view.payload.count, 2);
  eq('越界记录显示不可恢复', view.payload.items.find((it) => it.id === '20260101T000000_evil')?.restorable, false);
  eq('正常记录显示可恢复', view.payload.items.find((it) => it.id === '20260110T000000_new')?.restorable, true);
}

console.log('## cleanup：保留期 0 = 永久保留');
{
  deps.cfg = { fileArchive: { trashRetentionDays: 0 } };
  logs.length = 0;
  const before = readState().items.length;
  const res = await call('POST', '/api/library/trash/cleanup', { body: { confirm: true } });
  eq('保留期 0 时 200', res.status, 200);
  eq('purged 0', res.payload.purged, 0);
  eq('bytes 0', res.payload.bytes, 0);
  eq('kept 等于现有件数', res.payload.kept, before);
  eq('skipped 标记', res.payload.skipped, true);
  check('note 说明是永久保留', String(res.payload.note).includes('永久保留'), res.payload.note);
  eq('超期件也没被删（目录还在）', fs.existsSync(path.join(trashDir, '20260110T000000_new')), true);
  eq('状态条数没变', readState().items.length, before);
  check('保留期 0 时不打「删掉」日志', !logs.some((line) => line.includes('[回收站] 手动清理：删掉')), logs.join(' | '));
  deps.cfg = {};
}

console.log('## cleanup：权限与方法');
{
  const agent = await call('POST', '/api/library/trash/cleanup', { body: { confirm: true }, headers: { 'x-agent-token': 'abc' } });
  eq('POST + x-agent-token → 403（不执行清理）', agent.status, 403);
  const agent2 = await call('POST', '/api/library/trash/cleanup', { body: { confirm: true }, headers: { 'x-agent-call': '1' } });
  eq('POST + x-agent-call → 403', agent2.status, 403);
  const get = await call('GET', '/api/library/trash/cleanup');
  eq('GET cleanup → 405', get.status, 405);
  check('405 文案说明只支持 POST', String(get.payload.error).includes('POST'), get.payload.error);
}

console.log('## 路径穿越：entry id 一律拒绝');
{
  eq('id 校验：普通批次名可用', libtrEntryIdOk('20260101T000000_abcd'), '20260101T000000_abcd');
  eq('id 校验：../x 拒绝', libtrEntryIdOk('../x'), '');
  eq('id 校验：a/b 拒绝', libtrEntryIdOk('a/b'), '');
  eq('id 校验：绝对路径拒绝', libtrEntryIdOk('C:\\Windows\\x'), '');
  eq('id 校验：.. 拒绝', libtrEntryIdOk('..'), '');
  eq('movedTo 校验：直接子项可用', libtrBatchAbs(deps, libDir, '.trash/20260101T000000_abcd') !== '', true);
  eq('movedTo 校验：越界为空', libtrBatchAbs(deps, libDir, '../outside'), '');
  eq('movedTo 校验：多层嵌套不算直接子项', libtrBatchAbs(deps, libDir, '.trash/batch/sub'), '');
  const before = fs.existsSync(path.join(trashDir, '20260110T000000_new'));
  const traversal = ['../evil', 'a/b', 'C:\\Windows\\win.ini', '..\\evil', '/etc/passwd'];
  let rejected = 0;
  for (const id of traversal) {
    const restore = await call('POST', '/api/library/trash/restore', { body: { id } });
    if (restore.status === 400) rejected += 1;
    const purge = await call('POST', '/api/library/trash/purge', { body: { id, confirm: true } });
    if (purge.status === 400) rejected += 1;
  }
  eq('5 种穿越 id × restore/purge 全部 400', rejected, traversal.length * 2);
  eq('被拒后盘面没变', fs.existsSync(path.join(trashDir, '20260110T000000_new')), before);
}

console.log('## storage：盘面变化后统计跟着变（只读，不改文件）');
{
  const before = fs.readdirSync(trashDir).sort();
  const res = await call('GET', '/api/library/trash/storage');
  eq('files 与当前盘面一致', res.payload.files, 1);
  check('bytes 为正数', res.payload.bytes > 0, String(res.payload.bytes));
  eq('storage 没有改动 .trash 目录内容', fs.readdirSync(trashDir).sort(), before);
}

console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  console.log('失败项：');
  for (const name of failures) console.log(` - ${name}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
