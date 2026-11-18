// 素材回收站（GET /api/library/trash、POST trash/restore/purge）。
//
// 这条路径会**真的移动/删除用户的素材文件**，所以断言重点不是「接口通了」，而是：
// 挪走后原位置确实没了、`.trash` 里能按原相对路径找回来、恢复字节一致、同名冲突不覆盖、
// 真删必须 confirm:true、按天清理只删旧的、重复入回收站幂等、越界路径（../、绝对路径）一律拒绝、
// 智能体令牌 403、重启后 items 还在、`.trash` 不参与素材扫描。
// 全部用真 fs 临时档案根 + 假 deps，不碰真库、不发网络。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createLibraryTrash, libtrAutoPurge, libtrNextCleanupAt, libtrRetentionDays } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-trash.js')).href);
const { normalizeFileArchiveConfig } = await import(pathToFileURL(path.join(ROOT, 'src/file-archive/storage.js')).href);
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-trash-'));
const libDir = path.join(tmp, 'library');
const stateDir = path.join(tmp, 'state');
fs.mkdirSync(path.join(libDir, 'g', 'a'), { recursive: true });
fs.mkdirSync(path.join(libDir, 'g', 'b'), { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

// 两件素材：目录名带 BOOTH 号，包 + 预览图算同一件。
const assetA = ['g/a/8844481 Mew_Pose.zip', 'g/a/8844481 Mew_Pose.thumbnail.jpg'];
const assetB = ['g/b/9999999 Hat.zip', 'g/b/9999999 Hat.preview.jpg'];
const writeAsset = (relPaths) => {
  for (const rel of relPaths) fs.writeFileSync(path.join(libDir, ...rel.split('/')), `bytes:${rel}`);
};
writeAsset(assetA);
writeAsset(assetB);

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
const stateOf = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const rootFiles = () => scanLibraryTree({ fs, rootDir: libDir }).files.map((f) => f.relPath);
function keysByTitle() {
  const grouped = assetsFromFiles(scanLibraryTree({ fs, rootDir: libDir }).files);
  const out = {};
  for (const asset of grouped.assets) out[asset.title] = asset.key;
  return out;
}

function makeInstance() {
  const instance = createLibraryTrash(deps);
  return instance.handleConsoleLibraryTrash;
}

async function call(handler, method, pathname, { body = null, headers = {} } = {}) {
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

let handler = makeInstance();
const keys = keysByTitle();
eq('盘上认出 2 件素材', Object.keys(keys).sort(), ['Hat', 'Mew_Pose']);

console.log('## 空回收站：GET 形状');
{
  const res = await call(handler, 'GET', '/api/library/trash');
  eq('GET 200', res.status, 200);
  eq('count 0', res.payload.count, 0);
  eq('items 空数组', res.payload.items, []);
  eq('totalBytes 0', res.payload.totalBytes, 0);
  eq('状态文件不存在也能读（不崩）', fs.existsSync(statePath), false);
}

console.log('## 移入回收站：文件真的挪走、保留原相对结构');
const keyA = keys.Mew_Pose;
{
  const res = await call(handler, 'POST', '/api/library/trash', { body: { keys: [keyA] } });
  eq('POST 200', res.status, 200);
  eq('moved 1 件', res.payload.moved.length, 1);
  eq('moved 标题', res.payload.moved[0].title, 'Mew_Pose');
  eq('moved files=2', res.payload.moved[0].files, 2);
  eq('skipped 空', res.payload.skipped, []);
  eq('failed 空', res.payload.failed, []);
  eq('原位置已消失（zip）', fs.existsSync(path.join(libDir, 'g/a/8844481 Mew_Pose.zip')), false);
  eq('原位置已消失（缩略图）', fs.existsSync(path.join(libDir, 'g/a/8844481 Mew_Pose.thumbnail.jpg')), false);
  const movedTo = res.payload.moved[0].movedTo;
  check('movedTo 在 .trash 下', movedTo.startsWith('.trash/'), movedTo);
  const trashFile = path.join(libDir, ...`${movedTo}/g/a/8844481 Mew_Pose.zip`.split('/'));
  eq('文件在 .trash 里保留原目录结构', fs.existsSync(trashFile), true);
  eq('状态文件已原子写', fs.existsSync(statePath), true);
  eq('状态里记了 relPaths', stateOf().items[0].relPaths.length, 2);
  eq('日志留痕', logs.some((line) => line.includes('[回收站] 移入')), true);
  const view = await call(handler, 'GET', '/api/library/trash');
  eq('GET count 1', view.payload.count, 1);
  eq('GET restorable', view.payload.items[0].restorable, true);
  eq('GET totalBytes 等于两文件之和', view.payload.totalBytes, `bytes:g/a/8844481 Mew_Pose.zip`.length + `bytes:g/a/8844481 Mew_Pose.thumbnail.jpg`.length);
}

console.log('## .trash 不参与素材扫描');
{
  const files = rootFiles();
  check('扫描看不到 .trash 里的文件', files.every((rel) => !rel.startsWith('.trash/')), files.join(','));
  eq('只剩另一件素材', Object.keys(keysByTitle()), ['Hat']);
}

console.log('## 重复入回收站：幂等');
{
  const res = await call(handler, 'POST', '/api/library/trash', { body: { keys: [keyA] } });
  eq('仍然 200', res.status, 200);
  eq('moved 0', res.payload.moved.length, 0);
  eq('skipped 1', res.payload.skipped.length, 1);
  eq('跳过原因', res.payload.skipped[0].reason, '已在回收站里，跳过');
  eq('没有重复搬（count 仍 1）', res.payload.count, 1);
}

console.log('## 恢复：字节一致、原目录重建');
const trashId = stateOf().items[0].id;
{
  const res = await call(handler, 'POST', '/api/library/trash/restore', { body: { id: trashId } });
  eq('restore 200', res.status, 200);
  eq('恢复 2 个文件', res.payload.restored, 2);
  eq('zip 回来了', fs.readFileSync(path.join(libDir, 'g/a/8844481 Mew_Pose.zip'), 'utf8'), 'bytes:g/a/8844481 Mew_Pose.zip');
  eq('缩略图回来了', fs.readFileSync(path.join(libDir, 'g/a/8844481 Mew_Pose.thumbnail.jpg'), 'utf8'), 'bytes:g/a/8844481 Mew_Pose.thumbnail.jpg');
  eq('回收站清空', stateOf().items.length, 0);
  const batchDir = fs.readdirSync(path.join(libDir, '.trash'));
  eq('批次目录已删空壳', batchDir.length, 0);
}

console.log('## 恢复冲突：目标已存在同名 → 400，不覆盖半件');
{
  const again = await call(handler, 'POST', '/api/library/trash', { body: { keys: [keyA] } });
  const id = again.payload.moved[0].id;
  fs.writeFileSync(path.join(libDir, 'g/a/8844481 Mew_Pose.zip'), 'user-new-file');
  const res = await call(handler, 'POST', '/api/library/trash/restore', { body: { id } });
  eq('冲突返回 400', res.status, 400);
  check('错误说明拒绝覆盖', String(res.payload.error).includes('拒绝覆盖'), res.payload.error);
  eq('冲突时原文件没被覆盖', fs.readFileSync(path.join(libDir, 'g/a/8844481 Mew_Pose.zip'), 'utf8'), 'user-new-file');
  eq('回收站里这件还在（可再试）', stateOf().items.length, 1);
  fs.unlinkSync(path.join(libDir, 'g/a/8844481 Mew_Pose.zip'));
  const retry = await call(handler, 'POST', '/api/library/trash/restore', { body: { id } });
  eq('删掉冲突文件后可恢复', retry.status, 200);
}

console.log('## 真删：必须 confirm:true');
{
  const res = await call(handler, 'POST', '/api/library/trash', { body: { keys: [keyA] } });
  const id = res.payload.moved[0].id;
  const noConfirm = await call(handler, 'POST', '/api/library/trash/purge', { body: { id } });
  eq('不带 confirm 400', noConfirm.status, 400);
  eq('不带 confirm 什么都没删', stateOf().items.length, 1);
  const yes = await call(handler, 'POST', '/api/library/trash/purge', { body: { id, confirm: true } });
  eq('purge 200', yes.status, 200);
  eq('purged 1 件', yes.payload.purged, [id]);
  eq('回收站目录真的没了', fs.existsSync(path.join(libDir, '.trash', id)), false);
  eq('状态清空', stateOf().items.length, 0);
  // purge 是真删：把第 1 件素材彻底删掉了，后面的用例重新铺一份（同样内容 → 同一个 key）。
  writeAsset(assetA);
  eq('重新铺回的素材能被重新认件', Boolean(keysByTitle().Mew_Pose), true);
}

console.log('## 按天清理：只删早于 N 天的');
{
  const res = await call(handler, 'POST', '/api/library/trash', { body: { keys: [keyA, keys.Hat] } });
  eq('两件都进回收站', res.payload.count, 2);
  const state = stateOf();
  state.items[0].at = Date.now() - 10 * 24 * 60 * 60 * 1000;
  state.items[1].at = Date.now();
  fs.writeFileSync(statePath, JSON.stringify(state));
  const purge = await call(handler, 'POST', '/api/library/trash/purge', { body: { olderThanDays: 5, confirm: true } });
  eq('purge 200', purge.status, 200);
  eq('只删了 1 件', purge.payload.count, 1);
  eq('剩的是新的那件', stateOf().items.length, 1);
  const rest = await call(handler, 'POST', '/api/library/trash/restore', { body: { id: stateOf().items[0].id } });
  eq('剩下的能恢复', rest.status, 200);
}

console.log('## 越界路径一律拒绝');
{
  const forged = stateOf();
  forged.items = [{
    id: 'evil', key: 'evil', title: 'evil', boothId: '', bytes: 1, files: 1,
    at: Date.now(), movedTo: '../outside', fromDirs: [''], relPaths: ['../outside/evil.txt']
  }];
  fs.writeFileSync(statePath, JSON.stringify(forged));
  const restore = await call(handler, 'POST', '/api/library/trash/restore', { body: { id: 'evil' } });
  eq('restore 越界 400', restore.status, 400);
  const purge = await call(handler, 'POST', '/api/library/trash/purge', { body: { id: 'evil', confirm: true } });
  eq('purge 越界 500（safeResolveInside 拦截）', purge.status, 500);
  check('错误说明拒绝访问', String(purge.payload.error).includes('拒绝访问'), purge.payload.error);
  const badKeys = await call(handler, 'POST', '/api/library/trash', { body: { keys: ['../etc/passwd'] } });
  eq('未知/越界 key 记为 failed', badKeys.payload.failed.length, 1);
  fs.writeFileSync(statePath, JSON.stringify({ v: 1, at: 0, items: [] }));
}

console.log('## 参数校验');
{
  const empty = await call(handler, 'POST', '/api/library/trash', { body: { keys: [] } });
  eq('空 keys 400', empty.status, 400);
  const tooMany = await call(handler, 'POST', '/api/library/trash', { body: { keys: Array.from({ length: 51 }, (_, i) => `k${i}`) } });
  eq('超过 50 件 400', tooMany.status, 400);
  const noId = await call(handler, 'POST', '/api/library/trash/restore', { body: {} });
  eq('restore 缺 id 400', noId.status, 400);
  const purgeNoTarget = await call(handler, 'POST', '/api/library/trash/purge', { body: { confirm: true } });
  eq('purge 缺 id/olderThanDays 400', purgeNoTarget.status, 400);
}

console.log('## 智能体令牌一律 403');
{
  const getAgent = await call(handler, 'GET', '/api/library/trash', { headers: { 'x-agent-token': 'abc' } });
  eq('GET + x-agent-token 403', getAgent.status, 403);
  const postAgent = await call(handler, 'POST', '/api/library/trash', { body: { keys: [keys.Hat] }, headers: { 'x-agent-call': '1' } });
  eq('POST + x-agent-call 403', postAgent.status, 403);
  eq('403 时没有移动任何东西', stateOf().items.length, 0);
}

console.log('## 重启后 items 还在');
{
  const res = await call(handler, 'POST', '/api/library/trash', { body: { keys: [keys.Hat] } });
  eq('先移入 1 件', res.payload.count, 1);
  const fresh = makeInstance();
  const afterRestart = await call(fresh, 'GET', '/api/library/trash');
  eq('新实例仍能看到 1 件', afterRestart.payload.count, 1);
  eq('新实例 restorable', afterRestart.payload.items[0].restorable, true);
  const cleanup = await call(fresh, 'POST', '/api/library/trash/restore', { body: { id: afterRestart.payload.items[0].id } });
  eq('重启后也能恢复', cleanup.status, 200);
}

console.log('## 保留期与自动清理');
{
  // 从干净台账开始：前面的用例可能已经搬过/删过件。
  fs.rmSync(statePath, { force: true });
  writeAsset(assetA);
  writeAsset(assetB);
  const handler = makeInstance();
  const keysNow = keysByTitle();
  const res = await call(handler, 'POST', '/api/library/trash', { body: { keys: [keysNow.Mew_Pose, keysNow.Hat] } });
  eq('预置 2 件', res.payload.count, 2);

  // 手工把一件改成 40 天前入站：接口入站时间永远是「现在」，只能这样造旧件。
  const seeded = stateOf();
  const nowMs = Date.now();
  seeded.items[0].at = nowMs - 40 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(statePath, JSON.stringify(seeded, null, 2));

  eq('配置缺失时保留期默认 30', libtrRetentionDays(deps), 30);
  const view = await call(makeInstance(), 'GET', '/api/library/trash');
  eq('GET 回显 retentionDays', view.payload.retentionDays, 30);
  check('GET 回显 nextCleanupAt 是未来时间点', view.payload.nextCleanupAt > nowMs, String(view.payload.nextCleanupAt));
  eq('nextCleanupAt 落在 cleanupHour（默认 4 点）', new Date(view.payload.nextCleanupAt).getHours(), 4);
  check('nextCleanupAt 就是 libtrNextCleanupAt 的结果', libtrNextCleanupAt(deps, nowMs) === view.payload.nextCleanupAt, String(libtrNextCleanupAt(deps, nowMs)));

  logs.length = 0;
  const auto = await libtrAutoPurge(deps, { nowMs: Date.now() });
  eq('自动清理只删早于保留期的 1 件', auto.purged, 1);
  eq('自动清理回显保留期', auto.days, 30);
  eq('自动清理后只剩 1 件', (await call(makeInstance(), 'GET', '/api/library/trash')).payload.count, 1);
  check('日志一行写清件数与保留期', logs.some((line) => line === '回收站自动清理：删掉 1 件（保留期 30 天）'), logs.join(' | '));

  // 0 = 永久保留：不删任何东西。
  deps.cfg = { fileArchive: { cleanupHour: 6, trashRetentionDays: 0 } };
  logs.length = 0;
  const kept = await libtrAutoPurge(deps, { nowMs: Date.now() });
  eq('保留期 0 时自动清理跳过', kept.skipped, true);
  eq('保留期 0 时一件都不删', (await call(makeInstance(), 'GET', '/api/library/trash')).payload.count, 1);
  const zeroView = await call(makeInstance(), 'GET', '/api/library/trash');
  eq('保留期 0 原样回显', zeroView.payload.retentionDays, 0);
  eq('cleanupHour=6 时 nextCleanupAt 是 6 点', new Date(zeroView.payload.nextCleanupAt).getHours(), 6);
  check('保留期 0 时不打「删掉」日志', !logs.some((line) => line.includes('回收站自动清理：删掉')), logs.join(' | '));

  // 自定义保留期 + 非法值兜底（storage 白名单也要能搬这个字段）。
  eq('storage 白名单搬运 trashRetentionDays', normalizeFileArchiveConfig({ trashRetentionDays: 7, cleanupHour: 9 }).trashRetentionDays, 7);
  eq('storage 对 0 保留为永久', normalizeFileArchiveConfig({ trashRetentionDays: 0 }).trashRetentionDays, 0);
  eq('storage 对非法值回退 30', normalizeFileArchiveConfig({ trashRetentionDays: 'abc' }).trashRetentionDays, 30);
  eq('storage 对负数收敛到 0', normalizeFileArchiveConfig({ trashRetentionDays: -5 }).trashRetentionDays, 0);
  eq('storage 对超大值收敛到 3650', normalizeFileArchiveConfig({ trashRetentionDays: 99999 }).trashRetentionDays, 3650);

  deps.cfg = {};
  eq('清空配置后又回到默认 30', (await call(makeInstance(), 'GET', '/api/library/trash')).payload.retentionDays, 30);
}

console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  console.log('失败项：');
  for (const name of failures) console.log(` - ${name}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
