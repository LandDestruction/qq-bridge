// 素材库批量操作（POST /api/library/batch：bind / merge / trash）。
//
// 断言重点：多选后「一次做同一件事」不能把单件规则做歪 ——
//   每个 action 成功/部分失败/全失败都要如实计数、失败不中断其余件、
//   已绑过的号幂等跳过、合并是同一份 state/booth-merges.json、批量 trash 真移动文件
//   （和单件入口走同一段搬移/回滚逻辑）、重复 trash 幂等、非法参数/不支持的 action 一律 400、
//   智能体令牌 403、未知路径不接管。
// 全部用真 fs 临时档案根 + 假 deps，不碰真库、不发网络。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createLibraryBatch } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-batch.js')).href);
const { libtrTrashKeys } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-trash.js')).href);
const { scanLibraryTree, assetsFromFiles } = await import(pathToFileURL(path.join(ROOT, 'src/library-scan.js')).href);
const { safeResolveInside } = await import(pathToFileURL(path.join(ROOT, 'src/file-archive/paths.js')).href);
const libraryBindsPure = await import(pathToFileURL(path.join(ROOT, 'src/library-binds.js')).href);
const libraryMergePure = await import(pathToFileURL(path.join(ROOT, 'src/library-merge.js')).href);

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-batch-'));
const libDir = path.join(tmp, 'library');
const stateDir = path.join(tmp, 'state');
fs.mkdirSync(path.join(libDir, 'g', 'a'), { recursive: true });
fs.mkdirSync(path.join(libDir, 'g', 'b'), { recursive: true });
fs.mkdirSync(path.join(libDir, 'g', 'c'), { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

// 三件素材：包 + 预览图算同一件；第三件留给 trash 幂等用例。
const assetA = ['g/a/8844481 Mew_Pose.zip', 'g/a/8844481 Mew_Pose.thumbnail.jpg'];
const assetB = ['g/b/9999999 Hat.zip'];
const assetC = ['g/c/7777777 Chair.zip'];
for (const rel of [...assetA, ...assetB, ...assetC]) {
  fs.writeFileSync(path.join(libDir, ...rel.split('/')), `bytes:${rel}`);
}

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
  atomicWriteJson: (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2)),
  libraryBindsPure,
  libraryMergePure,
  libtrTrashKeys
};

function keysByTitle() {
  const grouped = assetsFromFiles(scanLibraryTree({ fs, rootDir: libDir }).files);
  const out = {};
  for (const asset of grouped.assets) out[asset.title] = asset.key;
  return out;
}
const keys = keysByTitle();
const boundsPath = path.join(stateDir, 'booth-binds.json');
const mergesPath = path.join(stateDir, 'booth-merges.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function makeHandler() {
  return createLibraryBatch(deps).handleConsoleLibraryBatch;
}

async function call(handler, method, pathname, { body = null, headers = {}, bodyThrows = false } = {}) {
  const result = { payload: null, status: 0 };
  const request = {
    req: { method, headers },
    url: new URL(`http://127.0.0.1:3100${pathname}`),
    readBody: async () => {
      if (bodyThrows) throw new Error('请求体坏了');
      if (body === null) throw new Error('没有请求体');
      return body;
    },
    sendJson: (payload, status) => { result.payload = payload; result.status = status || 200; }
  };
  const handled = await handler(request);
  return { ...result, handled };
}

let handler = makeHandler();
eq('盘上认出 3 件素材', Object.keys(keys).sort(), ['Chair', 'Hat', 'Mew_Pose']);

console.log('## 路径 / 方法：只接管 /api/library/batch 的 POST');
{
  const other = await call(handler, 'POST', '/api/library/trash', { body: { keys: [] } });
  eq('别的路径不接管', other.handled, false);
  eq('别的路径不写响应', other.status, 0);
  const get = await call(handler, 'GET', '/api/library/batch');
  eq('GET 405', get.status, 405);
  eq('405 文案说清', get.payload.error.includes('只支持 POST'), true);
}

console.log('## 智能体令牌：一律 403');
{
  for (const header of ['x-agent-token', 'x-agent-call']) {
    const res = await call(handler, 'POST', '/api/library/batch', { headers: { [header]: '1' }, body: { action: 'bind', keys: [keys.Hat], boothId: '5599001' } });
    eq(`${header} → 403`, res.status, 403);
    eq(`${header} 说明是管理端`, res.payload.error.includes('管理端'), true);
  }
  eq('403 没写绑定表', fs.existsSync(boundsPath), false);
}

console.log('## 参数校验：400 且说清原因');
{
  const noAction = await call(handler, 'POST', '/api/library/batch', { body: { keys: [keys.Hat] } });
  eq('缺 action → 400', noAction.status, 400);
  eq('提示三个 action', noAction.payload.error.includes('bind / merge / trash'), true);

  const unknown = await call(handler, 'POST', '/api/library/batch', { body: { action: 'rename-all', keys: [keys.Hat] } });
  eq('未知 action → 400', unknown.status, 400);
  eq('未知 action 回显', unknown.payload.error.includes('rename-all'), true);

  const alias = await call(handler, 'POST', '/api/library/batch', { body: { action: 'alias', keys: [keys.Hat], name: 'x' } });
  eq('alias → 400 不支持', alias.status, 400);
  eq('alias 说明规则表', alias.payload.error.includes('识别规则表'), true);

  const empty = await call(handler, 'POST', '/api/library/batch', { body: { action: 'trash', keys: [] } });
  eq('空 keys → 400', empty.status, 400);
  eq('空 keys 文案', empty.payload.error.includes('不能为空'), true);

  const tooMany = await call(handler, 'POST', '/api/library/batch', { body: { action: 'trash', keys: Array.from({ length: 201 }, (_, i) => `k${i}`) } });
  eq('超 200 件 → 400', tooMany.status, 400);
  eq('超限文案提到 200', tooMany.payload.error.includes('200'), true);

  const badBooth = await call(handler, 'POST', '/api/library/batch', { body: { action: 'bind', keys: [keys.Hat], boothId: 'abc' } });
  eq('非法 boothId → 400', badBooth.status, 400);
  eq('非法 boothId 回显', badBooth.payload.error.includes('abc'), true);

  const noBody = await call(handler, 'POST', '/api/library/batch', { bodyThrows: true });
  eq('请求体异常 → 400', noBody.status, 400);
  eq('请求体异常文案', noBody.payload.error.includes('请求体坏了'), true);
}

console.log('## bind：全部成功 / 已绑过幂等 / 部分失败 / 全失败');
{
  const res = await call(handler, 'POST', '/api/library/batch', { body: { action: 'bind', keys: [keys.Mew_Pose, keys.Hat], boothId: '5599001' } });
  eq('bind 200', res.status, 200);
  eq('action 回显', res.payload.action, 'bind');
  eq('requested 2', res.payload.requested, 2);
  eq('changed 2', res.payload.changed, 2);
  eq('failed 空', res.payload.failed, []);
  eq('results 两条 bound', res.payload.results.map((r) => r.status), ['bound', 'bound']);
  eq('绑定表已落盘', fs.existsSync(boundsPath), true);
  const table = libraryBindsPure.normalizeBindTable(readJson(boundsPath));
  eq('表里两件都绑到 5599001', [libraryBindsPure.bindOf(table, keys.Mew_Pose)?.boothId, libraryBindsPure.bindOf(table, keys.Hat)?.boothId], ['5599001', '5599001']);
  eq('记了 source=batch', libraryBindsPure.bindOf(table, keys.Hat)?.source, 'batch');
  eq('日志留痕', logs.some((line) => line.includes('批量绑定')), true);

  const again = await call(handler, 'POST', '/api/library/batch', { body: { action: 'bind', keys: [keys.Mew_Pose, keys.Hat], boothId: '5599001' } });
  eq('重复绑同号 changed 0', again.payload.changed, 0);
  eq('重复绑同号 skipped 2', again.payload.skipped.length, 2);
  eq('skip 原因', again.payload.skipped[0].reason.includes('已经绑过'), true);

  const partial = await call(handler, 'POST', '/api/library/batch', { body: { action: 'bind', keys: ['no-such-key', keys.Chair], boothId: '5599002' } });
  eq('部分失败仍 200', partial.status, 200);
  eq('部分失败 changed 1', partial.payload.changed, 1);
  eq('部分失败 failed 1', partial.payload.failed.length, 1);
  eq('失败 key 回显', partial.payload.failed[0].key, 'no-such-key');
  eq('失败原因说找不到', partial.payload.failed[0].error.includes('找不到'), true);
  eq('另一件真绑上了', libraryBindsPure.bindOf(libraryBindsPure.normalizeBindTable(readJson(boundsPath)), keys.Chair)?.boothId, '5599002');

  const allFail = await call(handler, 'POST', '/api/library/batch', { body: { action: 'bind', keys: ['x1', 'x2'], boothId: '5599003' } });
  eq('全失败 changed 0', allFail.payload.changed, 0);
  eq('全失败 failed 2', allFail.payload.failed.length, 2);
  eq('全失败不写盘（表还在）', fs.existsSync(boundsPath), true);

  // 前端批量对话框发的是 params:{boothId}（2026-10-30 真机踩到：只读顶层会让「绑定同号」必失败）。
  const viaParams = await call(handler, 'POST', '/api/library/batch', { body: { action: 'bind', keys: [keys.Hat], params: { boothId: '5599010' } } });
  eq('params.boothId 形状 bind 200', viaParams.status, 200);
  eq('params.boothId 形状 changed 1', viaParams.payload.changed, 1);
  eq('params.boothId 真写进绑定表', libraryBindsPure.bindOf(libraryBindsPure.normalizeBindTable(readJson(boundsPath)), keys.Hat)?.boothId, '5599010');
}

console.log('## merge：成功成组 / 不足两条 400 / 部分失败');
{
  const res = await call(handler, 'POST', '/api/library/batch', { body: { action: 'merge', keys: [keys.Mew_Pose, keys.Hat], boothId: '5599004' } });
  eq('merge 200', res.status, 200);
  eq('changed 2', res.payload.changed, 2);
  eq('results 两条 merged', res.payload.results.map((r) => r.status), ['merged', 'merged']);
  eq('mergeId 回显', res.payload.results[0].mergeId, 'm-5599004');
  eq('合并表已落盘', fs.existsSync(mergesPath), true);
  const table = libraryMergePure.normalizeMergeTable(readJson(mergesPath));
  const group = libraryMergePure.normalizeMergeTable(readJson(mergesPath)).groups['m-5599004'];
  check('合并组里有这两件', group && [...group.keys].sort().join(',') === [keys.Mew_Pose, keys.Hat].sort().join(','), JSON.stringify(group));
  eq('日志留痕', logs.some((line) => line.includes('批量合并')), true);

  // merge 同样要收 params 形状（前端同一份对话框）。
  const viaParams = await call(handler, 'POST', '/api/library/batch', { body: { action: 'merge', keys: [keys.Mew_Pose, keys.Hat], params: { boothId: '5599011' } } });
  eq('params.boothId 形状 merge 200', viaParams.status, 200);
  eq('params.boothId 形状 merge changed 2', viaParams.payload.changed, 2);
  eq('params 合并的组落盘', Boolean(libraryMergePure.normalizeMergeTable(readJson(mergesPath)).groups['m-5599011']), true);

  const tooFew = await call(handler, 'POST', '/api/library/batch', { body: { action: 'merge', keys: [keys.Mew_Pose, 'no-such'], boothId: '5599005' } });
  eq('有效不足两条 → 400', tooFew.status, 400);
  eq('不足两条文案', tooFew.payload.error.includes('至少选两条'), true);

  const partial = await call(handler, 'POST', '/api/library/batch', { body: { action: 'merge', keys: [keys.Mew_Pose, keys.Chair, 'gone'], boothId: '5599006' } });
  eq('部分失败 changed 2', partial.payload.changed, 2);
  eq('部分失败 failed 1', partial.payload.failed.length, 1);
}

console.log('## trash：批量移入 / 重复幂等 / 全失败');
{
  const res = await call(handler, 'POST', '/api/library/batch', { body: { action: 'trash', keys: [keys.Chair] } });
  eq('trash 200', res.status, 200);
  eq('changed 1', res.payload.changed, 1);
  eq('results trashed', res.payload.results[0].status, 'trashed');
  check('结果带批次 id', typeof res.payload.results[0].id === 'string' && res.payload.results[0].id.length > 0, String(res.payload.results[0].id));
  eq('原位置已消失', fs.existsSync(path.join(libDir, 'g/c/7777777 Chair.zip')), false);
  const trashRoot = path.join(libDir, '.trash');
  eq('.trash 里有文件', fs.existsSync(trashRoot) && fs.readdirSync(trashRoot).length > 0, true);

  const again = await call(handler, 'POST', '/api/library/batch', { body: { action: 'trash', keys: [keys.Chair] } });
  eq('重复 trash 幂等：changed 0', again.payload.changed, 0);
  eq('重复 trash 进 skipped', again.payload.skipped.length, 1);
  eq('skip 原因', again.payload.skipped[0].reason.includes('已在回收站'), true);

  const allFail = await call(handler, 'POST', '/api/library/batch', { body: { action: 'trash', keys: ['nope-1', 'nope-2'] } });
  eq('全失败 changed 0', allFail.payload.changed, 0);
  eq('全失败 failed 2', allFail.payload.failed.length, 2);
  eq('全失败原因', allFail.payload.failed[0].error.includes('找不到'), true);
}

console.log('## 失败不中断：一件抛错不影响后面的件');
{
  // 用坏掉的 atomicWriteJson 模拟「写绑定表失败」：bind 循环里 setBind 不写盘，写盘只在末尾一次，
  // 所以这里断言的是「末尾写盘失败 → 500，而不是把 changed 当成功返回」。
  const brokenDeps = { ...deps, atomicWriteJson: () => { throw new Error('磁盘满了'); } };
  const broken = createLibraryBatch(brokenDeps).handleConsoleLibraryBatch;
  const res = await call(broken, 'POST', '/api/library/batch', { body: { action: 'bind', keys: [keys.Mew_Pose], boothId: '5599007' } });
  eq('写盘失败 → 500', res.status, 500);
  eq('500 文案带原因', res.payload.error.includes('磁盘满了'), true);
}

const result = failures.length ? 1 : 0;
console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) console.log('失败项：\n- ' + failures.join('\n- '));
process.exit(result);
