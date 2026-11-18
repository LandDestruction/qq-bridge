// 素材「归位」（POST /api/library/relocate + /api/library/relocate/undo）。
//
// 断言重点：把素材从日期目录挪到独立目录这件事不能做歪 ——
//   只动这一件自己目录里的文件（日期目录里别的件不碰）、目标已存在绝不覆盖（409）、
//   非日期目录拒收、dryRun 真的不碰盘、撤销能把文件放回原位并收掉空目录、
//   撤销前的冲突/缺文件预检、状态文件能支撑撤销（重启后还能撤）、agent 头 403。
// 全部用真 fs 临时档案根 + 假 deps，不碰真库、不发网络。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createLibraryRelocate } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-relocate.js')).href);
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-relocate-'));
const libDir = path.join(tmp, 'library');
const stateDir = path.join(tmp, 'state');
fs.mkdirSync(stateDir, { recursive: true });

// 三个群目录，各有一个日期目录：
//  g1/2026-10 待归位（包 + 缩略图算同一件）
//  g2/2026-10 目标目录已存在（预检 409）
//  g3/2026-10 没有 BOOTH 号的单件（目标名只用标题）
const SRC_A = 'g1/2026-10/8844481 Mew_Pose.zip';
const SRC_A_THUMB = 'g1/2026-10/8844481 Mew_Pose.thumbnail.jpg';
const SRC_B = 'g2/2026-10/9999999 Hat.zip';
const SRC_C = 'g3/2026-10/Mystery.zip';
// 一件已经在独立目录里的素材（不该被归位）
const SRC_D = 'g4/8844481/Alread_Placed.zip';
for (const rel of [SRC_A, SRC_A_THUMB, SRC_B, SRC_C, SRC_D]) {
  const abs = path.join(libDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `bytes:${rel}`);
}
fs.mkdirSync(path.join(libDir, 'g2', '9999999_Hat'), { recursive: true });

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

function keysByTitle() {
  const grouped = assetsFromFiles(scanLibraryTree({ fs, rootDir: libDir }).files);
  const out = {};
  for (const asset of grouped.assets) out[asset.title] = asset.key;
  return out;
}
const keys = keysByTitle();
const statePath = path.join(stateDir, 'booth-relocations.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const absOf = (rel) => path.join(libDir, ...rel.split('/'));

function makeHandler() {
  return createLibraryRelocate(deps).handleConsoleLibraryRelocate;
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

const handler = makeHandler();
eq('盘上认出 4 件素材', Object.keys(keys).sort(), ['Alread_Placed', 'Hat', 'Mew_Pose', 'Mystery']);

console.log('## 路径 / 方法：只接管两个归位路径的 POST');
{
  const other = await call(handler, 'POST', '/api/library/batch', { body: { key: keys.Mew_Pose } });
  eq('别的路径不接管', other.handled, false);
  eq('别的路径不写响应', other.status, 0);
  const get = await call(handler, 'GET', '/api/library/relocate');
  eq('GET 405', get.status, 405);
  eq('405 文案说清', get.payload.error.includes('只支持 POST'), true);
}

console.log('## 智能体令牌：一律 403，且不碰盘');
{
  for (const header of ['x-agent-token', 'x-agent-call']) {
    const res = await call(handler, 'POST', '/api/library/relocate', { headers: { [header]: '1' }, body: { key: keys.Mew_Pose } });
    eq(`${header} → 403`, res.status, 403);
    eq(`${header} 说明是管理端`, res.payload.error.includes('管理端'), true);
  }
  eq('403 没搬文件', fs.existsSync(absOf(SRC_A)), true);
  eq('403 没写状态', fs.existsSync(statePath), false);
}

console.log('## 参数 / 前置条件：400、409 且说清原因');
{
  const noKey = await call(handler, 'POST', '/api/library/relocate', { body: {} });
  eq('缺 key 400', noKey.status, 400);
  eq('缺 key 文案', noKey.payload.error.includes('缺少 key'), true);

  const unknown = await call(handler, 'POST', '/api/library/relocate', { body: { key: 'no-such-key' } });
  eq('库里没有 → 400', unknown.status, 400);
  eq('库里没有 文案', unknown.payload.error.includes('找不到这件素材'), true);

  const placed = await call(handler, 'POST', '/api/library/relocate', { body: { key: keys.Alread_Placed } });
  eq('独立目录里的件 → 400', placed.status, 400);
  eq('独立目录 文案说清不在日期目录', placed.payload.error.includes('不在日期目录'), true);

  const conflict = await call(handler, 'POST', '/api/library/relocate', { body: { key: keys.Hat } });
  eq('目标目录已存在 → 409', conflict.status, 409);
  eq('409 说明拒绝覆盖', conflict.payload.error.includes('拒绝覆盖'), true);
  eq('409 没搬文件', fs.existsSync(absOf(SRC_B)), true);

  const badBody = await call(handler, 'POST', '/api/library/relocate', { bodyThrows: true });
  eq('请求体坏了 → 400', badBody.status, 400);
}

console.log('## dryRun：只算计划、不碰盘');
{
  const res = await call(handler, 'POST', '/api/library/relocate', { body: { key: keys.Mew_Pose, dryRun: true } });
  eq('dryRun 200', res.status, 200);
  eq('dryRun 回显', res.payload.dryRun, true);
  eq('fromDir 是日期目录', res.payload.fromDir, 'g1/2026-10');
  eq('toDir 是独立目录', res.payload.toDir, 'g1/8844481_Mew_Pose');
  eq('文件数 2', res.payload.files, 2);
  eq('dryRun 没搬文件', fs.existsSync(absOf(SRC_A)), true);
  eq('dryRun 没建目标目录', fs.existsSync(path.join(libDir, 'g1', '8844481_Mew_Pose')), false);
  eq('dryRun 没写状态', fs.existsSync(statePath), false);
}

console.log('## 真归位：文件挪到独立目录、原位置消失、写撤销日志');
{
  const res = await call(handler, 'POST', '/api/library/relocate', { body: { key: keys.Mew_Pose } });
  eq('归位 200', res.status, 200);
  eq('归位 ok', res.payload.ok, true);
  eq('归位 dryRun=false', res.payload.dryRun, false);
  eq('回显 toDir', res.payload.toDir, 'g1/8844481_Mew_Pose');
  eq('回显文件数 2', res.payload.files, 2);
  eq('原位置文件消失', fs.existsSync(absOf(SRC_A)), false);
  eq('原缩略图也消失', fs.existsSync(absOf(SRC_A_THUMB)), false);
  eq('目标文件到了', fs.existsSync(path.join(libDir, 'g1', '8844481_Mew_Pose', '8844481 Mew_Pose.zip')), true);
  eq('缩略图一起搬', fs.existsSync(path.join(libDir, 'g1', '8844481_Mew_Pose', '8844481 Mew_Pose.thumbnail.jpg')), true);
  eq('日期目录本身还在（别的件可能在用）', fs.existsSync(path.join(libDir, 'g1', '2026-10')), true);
  eq('状态文件已落盘', fs.existsSync(statePath), true);
  const state = readJson(statePath);
  eq('状态里一条记录', state.items.length, 1);
  eq('记录 key', state.items[0].key, keys.Mew_Pose);
  eq('记录 fromDir', state.items[0].fromDir, 'g1/2026-10');
  eq('记录 toDir', state.items[0].toDir, 'g1/8844481_Mew_Pose');
  eq('记录未撤销', state.items[0].undone, false);
  check('日志留痕', logs.some((line) => line.includes('素材归位：')), logs.join('\n'));
  eq('归位后重扫：件名还在、目录变了', assetsFromFiles(scanLibraryTree({ fs, rootDir: libDir }).files).assets.find((a) => a.title === 'Mew_Pose')?.dir, 'g1/8844481_Mew_Pose');
}

console.log('## 没有 BOOTH 号：目标名只用标题');
{
  const res = await call(handler, 'POST', '/api/library/relocate', { body: { key: keys.Mystery } });
  eq('无号归位 200', res.status, 200);
  eq('无号 toDir=g3/Mystery', res.payload.toDir, 'g3/Mystery');
  eq('无号文件到位', fs.existsSync(path.join(libDir, 'g3', 'Mystery', 'Mystery.zip')), true);
}

console.log('## 撤销：搬回原位、收掉空目录、标记已撤销');
{
  const res = await call(handler, 'POST', '/api/library/relocate/undo', { body: {} });
  eq('撤销最近一条 200', res.status, 200);
  eq('撤销指向 Mystery（最后一条）', res.payload.key, keys.Mystery);
  eq('文件回到日期目录', fs.existsSync(absOf(SRC_C)), true);
  eq('独立目录被收掉', fs.existsSync(path.join(libDir, 'g3', 'Mystery')), false);
  const state = readJson(statePath);
  eq('Mystery 标记已撤销', state.items.find((item) => item.key === keys.Mystery)?.undone, true);
  check('撤销日志留痕', logs.some((line) => line.includes('素材归位已撤销')), logs.join('\n'));

  const again = await call(handler, 'POST', '/api/library/relocate/undo', { body: { id: state.items.find((item) => item.key === keys.Mystery)?.id } });
  eq('已撤销的再撤 → 409', again.status, 409);
  eq('已撤销文案', again.payload.error.includes('已经撤销过'), true);

  const res2 = await call(handler, 'POST', '/api/library/relocate/undo', { body: {} });
  eq('下一条撤销是 Mew_Pose', res2.payload.key, keys.Mew_Pose);
  eq('Mew_Pose 文件回到原位', fs.existsSync(absOf(SRC_A)), true);
  eq('Mew_Pose 缩略图回到原位', fs.existsSync(absOf(SRC_A_THUMB)), true);
  eq('Mew_Pose 独立目录被收掉', fs.existsSync(path.join(libDir, 'g1', '8844481_Mew_Pose')), false);
}

console.log('## 撤销预检：原位置被占用 → 409，不覆盖也不半途');
{
  const relocate = await call(handler, 'POST', '/api/library/relocate', { body: { key: keys.Mystery } });
  eq('再归位一次 200', relocate.status, 200);
  fs.writeFileSync(absOf(SRC_C), '有人又放了一个同名文件');
  const undo = await call(handler, 'POST', '/api/library/relocate/undo', { body: {} });
  eq('原位置被占 → 409', undo.status, 409);
  eq('409 拒绝覆盖文案', undo.payload.error.includes('拒绝覆盖'), true);
  eq('归位后的文件还在（没有被搬走）', fs.existsSync(path.join(libDir, 'g3', 'Mystery', 'Mystery.zip')), true);
  eq('状态仍是未撤销', [...readJson(statePath).items].reverse().find((item) => item.key === keys.Mystery)?.undone, false);
  // 收尾：清掉冲突文件，撤回来，别把 fixture 留给后面的用例。
  fs.rmSync(absOf(SRC_C));
  const undo2 = await call(handler, 'POST', '/api/library/relocate/undo', { body: {} });
  eq('清掉冲突后可撤销', undo2.status, 200);
}

console.log('## 撤销记录：不存在的 id 400 / 没有记录可撤 400');
{
  const missing = await call(handler, 'POST', '/api/library/relocate/undo', { body: { id: 'rel-nope' } });
  eq('未知 id 400', missing.status, 400);
  eq('未知 id 文案', missing.payload.error.includes('找不到这条归位记录'), true);
  const none = await call(handler, 'POST', '/api/library/relocate/undo', { body: {} });
  eq('没有可撤记录 400', none.status, 400);
  eq('没有可撤文案', none.payload.error.includes('没有可撤销'), true);
}

console.log('## 重启后还能撤销：新实例读同一份状态');
{
  const moved = await call(handler, 'POST', '/api/library/relocate', { body: { key: keys.Mew_Pose } });
  eq('再次归位 200', moved.status, 200);
  const fresh = createLibraryRelocate(deps).handleConsoleLibraryRelocate;
  const undo = await call(fresh, 'POST', '/api/library/relocate/undo', { body: {} });
  eq('新实例能撤销 200', undo.status, 200);
  eq('新实例撤的是 Mew_Pose', undo.payload.key, keys.Mew_Pose);
  eq('文件回位', fs.existsSync(absOf(SRC_A)), true);
}

console.log('');
if (failures.length) {
  console.log(`通过 ${pass} / 失败 ${failures.length}`);
  for (const name of failures) console.log(`  ✗ ${name}`);
  process.exit(1);
}
console.log(`通过 ${pass} / 失败 0`);
