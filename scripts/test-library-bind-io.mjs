// 绑定表导出 / 导入单测：假 deps + 临时 state 目录，不碰真库、不碰网络。
//
// 覆盖的是「换机器不丢人工绑定」这条链路的两端：
//   GET  /api/library/binds/export  → 拿得到一张能粘贴的 JSON
//   POST /api/library/binds/import  → 灌回去，**已存在的 contentKey 默认不覆盖**
// 另外钉住三件事：非法号进 invalid 而不是被静默丢掉、智能体令牌一律 403、别的路径不接管。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const { createLibraryBindIo } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-bind-io.js')).href);
// 纯规则按 bridge.js 的口径走 deps 注入（桥接模块被 vm 裸执行，不能 import）。
const libraryBindsPure = await import(pathToFileURL(path.join(ROOT, 'src/library-binds.js')).href);

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-bind-io-'));
const bindFile = path.join(tmp, 'booth-binds.json');
const logs = [];
const deps = {
  fs,
  path,
  STATE_DIR: tmp,
  log: (m) => logs.push(String(m)),
  atomicWriteJson: (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 1)),
  libraryBindsPure
};
const { handleConsoleLibraryBindIo } = createLibraryBindIo(deps);

function makeReq({ method = 'GET', pathname, body = null, headers = {} } = {}) {
  let sent = null;
  return {
    req: { method, headers },
    url: { pathname, searchParams: new URLSearchParams() },
    readBody: async () => body,
    sendJson: (payload, code) => { sent = { payload, code: code || 200 }; },
    getSent: () => sent
  };
}
function readDisk() {
  return JSON.parse(fs.readFileSync(bindFile, 'utf8'));
}
function seed(table) {
  fs.writeFileSync(bindFile, JSON.stringify(table, null, 1));
}

console.log('## 导出');
{
  seed({ version: 1, entries: { 'g/c/mew': { boothId: '7850009', title: 'Mew Hair', source: 'manual', at: 1700000000000 } } });
  const r = makeReq({ pathname: '/api/library/binds/export' });
  const handled = await handleConsoleLibraryBindIo(r);
  const payload = r.getSent().payload;
  check('GET /api/library/binds/export 被本路由处理', handled === true);
  check('导出带 format / version / exportedAt', payload.format === 'qdb-booth-binds' && payload.version === 1 && !Number.isNaN(Date.parse(payload.exportedAt)));
  check('导出 entries 就是绑定表的内容', payload.entries['g/c/mew']?.boothId === '7850009');
  check('导出条目字段齐全（boothId/title/source/at）',
    ['boothId', 'title', 'source', 'at'].every((k) => Object.prototype.hasOwnProperty.call(payload.entries['g/c/mew'], k)));
  check('导出带条数与摘要', payload.count === 1 && payload.summary.count === 1);
}
{
  // 脏文件不该让「备份一下」这件事本身失败：导出回空表 + ok
  seed('{ not json');
  const r = makeReq({ pathname: '/api/library/binds/export' });
  await handleConsoleLibraryBindIo(r);
  const payload = r.getSent().payload;
  check('绑定表损坏时导出回空表而不是 500', payload.ok === true && Object.keys(payload.entries).length === 0);
  seed({ version: 1, entries: { 'g/c/mew': { boothId: '7850009', title: 'Mew Hair', source: 'manual', at: 1700000000000 } } });
}

console.log('## 导入：合并 / 不覆盖');
{
  const r = makeReq({
    method: 'POST',
    pathname: '/api/library/binds/import',
    body: { entries: { 'g/c/other': { boothId: '3111111', title: 'Other' } } }
  });
  await handleConsoleLibraryBindIo(r);
  const payload = r.getSent().payload;
  check('新 contentKey 计入 added', payload.ok === true && payload.added === 1 && payload.skipped === 0 && payload.invalid === 0);
  const disk = readDisk();
  check('导入的新绑定落盘', disk.entries['g/c/other']?.boothId === '3111111');
  check('导入条目 source 固定 import', disk.entries['g/c/other']?.source === 'import');
  check('已有绑定原样保留', disk.entries['g/c/mew']?.boothId === '7850009' && disk.entries['g/c/mew']?.source === 'manual');
}
{
  // 核心断言：同一 contentKey 已存在时默认不覆盖
  const r = makeReq({
    method: 'POST',
    pathname: '/api/library/binds/import',
    body: { entries: { 'g/c/mew': { boothId: '9999999', title: '覆盖我试试' } } }
  });
  await handleConsoleLibraryBindIo(r);
  const payload = r.getSent().payload;
  const disk = readDisk();
  check('导入时旧绑定不被覆盖（同一 contentKey 默认跳过）',
    payload.added === 0 && payload.skipped === 1 && disk.entries['g/c/mew'].boothId === '7850009',
    JSON.stringify({ added: payload.added, skipped: payload.skipped, boothId: disk.entries['g/c/mew'].boothId }));
  check('被跳过的 key 回给前端（最多 20 个）', Array.isArray(payload.skippedKeys) && payload.skippedKeys.includes('g/c/mew'));
  check('不覆盖时返回 overwrite:false', payload.overwrite === false);
}
{
  const r = makeReq({
    method: 'POST',
    pathname: '/api/library/binds/import',
    body: { entries: { 'g/c/mew': { boothId: '9999999', title: '这次该覆盖' } }, overwrite: true }
  });
  await handleConsoleLibraryBindIo(r);
  const payload = r.getSent().payload;
  const disk = readDisk();
  check('overwrite:true 时才真的覆盖', payload.ok === true && payload.added === 1 && disk.entries['g/c/mew'].boothId === '9999999');
  check('覆盖后 source 变成 import', disk.entries['g/c/mew'].source === 'import');
}

console.log('## 导入：校验与兼容输入');
{
  const r = makeReq({
    method: 'POST',
    pathname: '/api/library/binds/import',
    body: { entries: { 'g/c/bad': { boothId: '12' }, 'g/c/bad2': { boothId: 'abc' }, 'g/c/good': { boothId: '7777777' } } }
  });
  await handleConsoleLibraryBindIo(r);
  const payload = r.getSent().payload;
  check('非法 BOOTH 号计入 invalid、好条目照常进', payload.invalid === 2 && payload.added === 1);
  check('非法条目没有落盘', !readDisk().entries['g/c/bad'] && !readDisk().entries['g/c/bad2']);
}
{
  const r = makeReq({ method: 'POST', pathname: '/api/library/binds/import', body: { entries: [{ key: 'g/c/arr', boothId: '6111111', title: '数组形式' }] } });
  await handleConsoleLibraryBindIo(r);
  const payload = r.getSent().payload;
  check('entries 传数组也能导入', payload.added === 1 && readDisk().entries['g/c/arr']?.boothId === '6111111');
}
{
  const r = makeReq({
    method: 'POST',
    pathname: '/api/library/binds/import',
    body: { table: { version: 1, entries: { 'g/c/tbl': { boothId: '6222222', title: '整张表' } } } }
  });
  await handleConsoleLibraryBindIo(r);
  const payload = r.getSent().payload;
  check('传整张 table 也能导入（导出原样回灌）', payload.added === 1 && readDisk().entries['g/c/tbl']?.boothId === '6222222');
}
{
  const longTitle = 'X'.repeat(260);
  const r = makeReq({ method: 'POST', pathname: '/api/library/binds/import', body: { entries: { 'g/c/long': { boothId: '6333333', title: longTitle } } } });
  await handleConsoleLibraryBindIo(r);
  check('title 截到 200 字', readDisk().entries['g/c/long'].title.length === 200);
}
{
  const r = makeReq({ method: 'POST', pathname: '/api/library/binds/import', body: {} });
  await handleConsoleLibraryBindIo(r);
  check('没有 entries → 400 + 人话', r.getSent().code === 400 && /没有可导入的条目/.test(r.getSent().payload.error));
}
{
  const r = makeReq({ method: 'POST', pathname: '/api/library/binds/import', body: { entries: {} } });
  await handleConsoleLibraryBindIo(r);
  check('空 entries 对象 → 400（不是悄悄 ok:true）', r.getSent().code === 400);
}

{
  const before = JSON.stringify(readDisk());
  const r = makeReq({
    method: 'POST',
    pathname: '/api/library/binds/import',
    body: { entries: { 'g/c/a': { boothId: 'abc' }, 'g/c/b': { boothId: '12' }, 'g/c/c': { boothId: '' } } }
  });
  await handleConsoleLibraryBindIo(r);
  const sent = r.getSent();
  // 「全非法」不是「成功导入 0 条」：用户拿错文件时必须 400 说清楚，且一个字节都不写盘。
  check('全是非法号 → 400 + 说清几条不合法', sent.code === 400 && /没有一条能导入：3 条商品号不合法/.test(sent.payload.error), JSON.stringify(sent.payload));
  check('全非法导入不写盘', JSON.stringify(readDisk()) === before);
}
{
  const r = makeReq({ method: 'POST', pathname: '/api/library/binds/import', body: { entries: { 'g/c/mew': { boothId: '9999999' } } } });
  await handleConsoleLibraryBindIo(r);
  // 全是「已存在、默认不覆盖」时是正常幂等导入（added=0、invalid=0），必须仍是 200，
  // 别把「重复导入」也判成错误。
  check('全是被跳过的已存在条目 → 仍 200（幂等导入）', r.getSent().code === 200 && r.getSent().payload.added === 0 && r.getSent().payload.skipped >= 1, JSON.stringify(r.getSent().payload));
}

console.log('## 鉴权与方法');
{
  const r = makeReq({ pathname: '/api/library/binds/export', headers: { 'x-agent-token': 'abc' } });
  const handled = await handleConsoleLibraryBindIo(r);
  check('导出带智能体令牌 → 403 且被本路由处理', handled === true && r.getSent().code === 403);
}
{
  const r = makeReq({ method: 'POST', pathname: '/api/library/binds/import', body: { entries: { 'g/c/mew': { boothId: '8888888' } } }, headers: { 'x-agent-call': '1' } });
  const handled = await handleConsoleLibraryBindIo(r);
  check('导入带智能体调用头 → 403', handled === true && r.getSent().code === 403);
  check('被拒的导入没有改动绑定表', readDisk().entries['g/c/mew'].boothId === '9999999');
}
{
  const r = makeReq({ method: 'POST', pathname: '/api/library/binds/export' });
  await handleConsoleLibraryBindIo(r);
  check('导出只收 GET（POST → 405）', r.getSent().code === 405);
}
{
  const r = makeReq({ pathname: '/api/library/binds/import' });
  await handleConsoleLibraryBindIo(r);
  check('导入只收 POST（GET → 405）', r.getSent().code === 405);
}
{
  const r = makeReq({ pathname: '/api/library/binds' });
  const handled = await handleConsoleLibraryBindIo(r);
  check('别的绑定路径不接管（留给 library-find）', handled === false && r.getSent() === null);
}
{
  const r = makeReq({ pathname: '/api/library/whatever' });
  const handled = await handleConsoleLibraryBindIo(r);
  check('不认识的路径不接管', handled === false && r.getSent() === null);
}
{
  check('每次导入/导出都留了日志（真机排障靠它）', logs.some((m) => /导入绑定/.test(m)));
}

console.log('## 导入：试运行（dryRun）');
{
  // 试运行是「先看会怎样再决定要不要按」：规则必须与真导入同一段代码，但 state 一个字节都不许动。
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const bom = { version: 1, entries: { 'g/c/mew': { boothId: '7850009', title: 'Mew Hair', source: 'manual', at: 1700000000000 } } };
  seed(bom);
  const before = sha(fs.readFileSync(bindFile, 'utf8'));
  const r = makeReq({
    method: 'POST',
    pathname: '/api/library/binds/import',
    body: {
      dryRun: true,
      entries: {
        'g/c/mew': { boothId: '9999999', title: '同 key 默认跳过' },
        'g/c/new': { boothId: '3123456', title: '新增的' },
        'g/c/bad': { boothId: '12', title: '非法号' }
      }
    }
  });
  await handleConsoleLibraryBindIo(r);
  const payload = r.getSent().payload;
  check('dryRun 被识别（ok + dryRun:true + 200）', payload.ok === true && payload.dryRun === true && r.getSent().code === 200);
  check('dryRun 计数正确：新增 1 / 覆盖 0 / 跳过 1 / 非法 1',
    payload.added === 1 && payload.overwritten === 0 && payload.skipped === 1 && payload.invalid === 1,
    JSON.stringify({ added: payload.added, overwritten: payload.overwritten, skipped: payload.skipped, invalid: payload.invalid }));
  const keysOf = (action) => payload.preview.filter((p) => p.action === action).map((p) => p.contentKey).join(',');
  check('preview 里 add / skip / invalid 分类正确',
    keysOf('add') === 'g/c/new' && keysOf('skip') === 'g/c/mew' && keysOf('invalid') === 'g/c/bad',
    JSON.stringify({ add: keysOf('add'), skip: keysOf('skip'), invalid: keysOf('invalid') }));
  check('preview 每条都带 contentKey / boothId / title / action',
    payload.preview.every((p) => ['contentKey', 'boothId', 'title', 'action'].every((k) => Object.prototype.hasOwnProperty.call(p, k))));
  check('dryRun 后 state/booth-binds.json 内容一字未变（sha 相同）', sha(fs.readFileSync(bindFile, 'utf8')) === before);
  check('dryRun 后旧绑定仍是原号（没被「试运行」偷偷改掉）', readDisk().entries['g/c/mew'].boothId === '7850009');

  const r2 = makeReq({
    method: 'POST',
    pathname: '/api/library/binds/import',
    body: { dryRun: true, overwrite: true, entries: { 'g/c/mew': { boothId: '9999999' }, 'g/c/new2': { boothId: '3234567' } } }
  });
  await handleConsoleLibraryBindIo(r2);
  const payload2 = r2.getSent().payload;
  const actions2 = payload2.preview.map((p) => `${p.action}:${p.contentKey}`).join(',');
  check('dryRun + overwrite 时同 key 分类变 overwrite（overwritten 计数生效）',
    payload2.overwritten === 1 && payload2.added === 1 && payload2.skipped === 0 && actions2 === 'overwrite:g/c/mew,add:g/c/new2',
    actions2);
  check('dryRun + overwrite 同样没写盘', sha(fs.readFileSync(bindFile, 'utf8')) === before && readDisk().entries['g/c/mew'].boothId === '7850009');

  const many = {};
  for (let i = 0; i < 60; i += 1) many[`g/c/many${i}`] = { boothId: String(4100000 + i) };
  const r3 = makeReq({ method: 'POST', pathname: '/api/library/binds/import', body: { dryRun: true, entries: many } });
  await handleConsoleLibraryBindIo(r3);
  const payload3 = r3.getSent().payload;
  check('preview 上限 50 条（60 条也只回 50，但计数照实 60）',
    payload3.preview.length === 50 && payload3.added === 60, JSON.stringify({ preview: payload3.preview.length, added: payload3.added }));

  // 文件不存在时试运行也不该把文件建出来（这就是「完全不动盘」最硬的证据）。
  fs.rmSync(bindFile, { force: true });
  const r4 = makeReq({ method: 'POST', pathname: '/api/library/binds/import', body: { dryRun: true, entries: { 'g/c/fresh': { boothId: '5444444' } } } });
  await handleConsoleLibraryBindIo(r4);
  check('表文件不存在时 dryRun 不会把它创建出来', r4.getSent().payload.added === 1 && !fs.existsSync(bindFile));
  const r5 = makeReq({ method: 'POST', pathname: '/api/library/binds/import', body: { entries: { 'g/c/fresh': { boothId: '5444444' } } } });
  await handleConsoleLibraryBindIo(r5);
  check('dryRun 不写盘，但正常 import 仍写盘', r5.getSent().payload.added === 1 && fs.existsSync(bindFile) && readDisk().entries['g/c/fresh'].boothId === '5444444');
  const r6 = makeReq({
    method: 'POST',
    pathname: '/api/library/binds/import',
    body: { dryRun: true, entries: { 'g/c/agent': { boothId: '5555555' } } },
    headers: { 'x-agent-token': 'abc' }
  });
  await handleConsoleLibraryBindIo(r6);
  check('dryRun 也挡智能体令牌（403，且不回 preview）', r6.getSent().code === 403 && !r6.getSent().payload.preview);

  // 命令行/表单常把开关传成字符串：'true' 要当试运行，'false' 必须当真实导入（否则「确认没动盘」反而真写了）。
  const r7 = makeReq({
    method: 'POST',
    pathname: '/api/library/binds/import',
    body: { dryRun: 'true', entries: { 'g/c/strtrue': { boothId: '5666666' } } }
  });
  const before7 = sha(fs.readFileSync(bindFile, 'utf8'));
  await handleConsoleLibraryBindIo(r7);
  check("dryRun 传字符串 'true' 时只试运行（不写盘）",
    r7.getSent().payload.dryRun === true && sha(fs.readFileSync(bindFile, 'utf8')) === before7 && !readDisk().entries['g/c/strtrue']);

  const r8 = makeReq({
    method: 'POST',
    pathname: '/api/library/binds/import',
    body: { dryRun: 'false', entries: { 'g/c/strfalse': { boothId: '5777777' } } }
  });
  await handleConsoleLibraryBindIo(r8);
  const payload8 = r8.getSent().payload;
  check("dryRun 传字符串 'false' 时走真实导入（会写盘，且不回 dryRun:true）",
    payload8.dryRun !== true && payload8.added === 1 && fs.existsSync(bindFile) && readDisk().entries['g/c/strfalse'].boothId === '5777777',
    JSON.stringify({ dryRun: payload8.dryRun, added: payload8.added, exists: fs.existsSync(bindFile) }));

  const r9 = makeReq({
    method: 'POST',
    pathname: '/api/library/binds/import',
    body: { dryRun: 1, entries: { 'g/c/numone': { boothId: '5888888' } } }
  });
  await handleConsoleLibraryBindIo(r9);
  check('dryRun 传数字 1 不算试运行（严格判定只认 true / "true"）',
    r9.getSent().payload.dryRun !== true && readDisk().entries['g/c/numone'].boothId === '5888888');
}

/**
 * 端到端还愿：先导出 → 清空临时 state → 再导入 → 表一模一样。
 * 这条比逐字段断言更接近真实用途（换机器就是「导出带走 → 新机器导入」）。
 */
{
  const backup = makeReq({ pathname: '/api/library/binds/export' });
  await handleConsoleLibraryBindIo(backup);
  const exported = backup.getSent().payload.entries;
  fs.rmSync(bindFile, { force: true });
  const restore = makeReq({ method: 'POST', pathname: '/api/library/binds/import', body: { entries: exported } });
  await handleConsoleLibraryBindIo(restore);
  const disk = readDisk();
  const same = Object.keys(exported).every((k) => disk.entries[k]?.boothId === exported[k].boothId);
  check('导出 → 删盘 → 导入 = 原表还原', restore.getSent().payload.added === Object.keys(exported).length && same,
    JSON.stringify({ added: restore.getSent().payload.added, expected: Object.keys(exported).length }));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log(`绑定表导入导出：通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
