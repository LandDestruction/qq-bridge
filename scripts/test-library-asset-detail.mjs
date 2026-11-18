// 单件素材详情（GET /api/library/asset?key=）：真读一件素材目录里的事实，不再让前端靠数字猜。
//
// 为什么要有这一套：列表卡片上 files 是「件数」、previews 是「封面」，点开详情才知道目录里
// 到底有哪些文件、多大、哪个是主包、绑定/资料/工程使用/回收站是什么状态。这里既测纯路由
// （假卡片，能精确控制字段），也测一次真链路（真扫盘 + library-view 分派，防止接线断了）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { handleAssetDetailRoute, detailKeyOk } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-asset-detail.js')).href);
const { createLibraryView } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-view.js')).href);
const { buildLibrarySnapshot } = await import(pathToFileURL(path.join(ROOT, 'src/library-scan.js')).href);
const { safeResolveInside } = await import(pathToFileURL(path.join(ROOT, 'src/file-archive/paths.js')).href);

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name} — ${error?.message ?? error}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name} — ${error?.message ?? error}`);
  }
}
function eq(name, actual, expected) {
  check(name, () => assert.deepEqual(actual, expected));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-detail-'));
const libDir = path.join(tmp, 'lib');
const stateDir = path.join(tmp, 'state');
fs.mkdirSync(stateDir, { recursive: true });

function writeFile(rel, content) {
  const abs = path.join(libDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
writeFile('g/c/normal/Mew Hair.zip', 'z'.repeat(100));
writeFile('g/c/normal/preview.jpg', 'p'.repeat(50));
writeFile('g/c/normal/docs/readme.txt', 'r'.repeat(10));
// 深度 4 的文件：详情最多列到深度 3，它不该出现（防止一次点开把整棵大目录扫穿）。
writeFile('g/c/normal/a/b/c/d/deep.txt', 'd'.repeat(5));
writeFile('g/c/mergedA/A.zip', 'a'.repeat(200));
writeFile('g/c/mergedA/A.thumbnail.jpg', 't'.repeat(20));
writeFile('g/c/mergedB/B.zip', 'b'.repeat(300));
writeFile('g/c/mergedB/sub/extra.bin', 'e'.repeat(40));
for (let i = 0; i < 60; i += 1) writeFile(`g/c/many/f${String(i).padStart(2, '0')}.bin`, 'x');

function depsOf() {
  return { fs, path, STATE_DIR: stateDir, ROOT, log: () => {}, fileArchiveRootDir: () => libDir, safeResolveInside };
}

function makeReq({ method = 'GET', key = '', pathname = '/api/library/asset', search = '', headers = {}, consoleRole = '' } = {}) {
  const params = new URLSearchParams(search);
  if (key) params.set('key', key);
  let sent = null;
  return {
    consoleRole,
    req: { method, headers },
    url: { pathname, searchParams: params },
    readBody: async () => null,
    sendJson: (payload, code) => { sent = { payload, code: code || 200 }; },
    getSent: () => sent
  };
}

// ── 纯路由：假卡片，精确控制每个字段与磁盘布局 ──────────────────────────────
const cards = [
  {
    key: 'g/c/normal', title: 'Mew Hair', aliasTitle: 'メウ', dir: 'g/c/normal', mainName: 'Mew Hair.zip',
    boothId: '271777', renamed: false, mergedCount: 0, mergedMembers: [],
    previews: [{ relPath: 'g/c/normal/preview.jpg', bytes: 50 }], thumbRel: 'g/c/normal/preview.jpg', coverUrl: '',
    meta: { title: 'Mew Hair', shop: 'Studio', price: '¥1,100', tags: ['髪'], itemUrl: 'https://booth.pm/ja/items/271777', category: '3Dモデル' },
    archivePassword: '7788', rjCode: 'RJ123456', tags: ['发饰'], source: 'baidu', sourceText: '网盘', bytes: 160
  },
  {
    key: 'g/c/merged', title: 'Merged Set', aliasTitle: '', dir: 'g/c/mergedA', mainName: 'A.zip',
    boothId: '271777', renamed: false, mergedCount: 2,
    mergedMembers: [
      { key: 'g/c/mergedA', dir: 'g/c/mergedA', mainName: 'A.zip', files: 2, bytes: 220, title: 'A' },
      { key: 'g/c/mergedB', dir: 'g/c/mergedB', mainName: 'B.zip', files: 2, bytes: 340, title: 'B' }
    ],
    previews: [], thumbRel: '', coverUrl: '', meta: null, bytes: 560
  },
  { key: 'g/c/many', title: 'Many', dir: 'g/c/many', mainName: 'f00.bin', boothId: '', meta: null },
  { key: 'g/c/escape', title: 'Escape', dir: '../outside', mainName: '', boothId: '', meta: null }
];
const deps = depsOf();
const getAssets = async () => ({ assets: cards });

fs.writeFileSync(path.join(stateDir, 'booth-binds.json'), JSON.stringify({
  version: 1,
  entries: { 'g/c/normal': { boothId: '271777', title: 'Mew Hair', source: 'manual', at: 123 } }
}));
fs.writeFileSync(path.join(stateDir, 'booth-usage.json'), JSON.stringify({
  usage: {
    'g/c/mergedA': { projects: [{ name: 'Proj A', path: 'D:/projA', evidence: 'Mew Hair.zip', at: 1 }] },
    'g/c/mergedB': { projects: [{ name: 'Proj A', path: 'D:/projA', evidence: 'B.zip', at: 2 }, { name: 'Proj B', path: 'D:/projB', evidence: 'B.zip', at: 3 }] }
  }
}));
fs.writeFileSync(path.join(stateDir, 'booth-trash.json'), JSON.stringify({
  items: [{ id: 't1', key: 'g/c/merged', title: 'Merged Set', movedTo: '.trash/b1/g/c/mergedA', relPaths: ['g/c/mergedA/A.zip'], at: 5 }]
}));

console.log('## key 校验');
check('detailKeyOk 认普通 contentKey', () => assert.equal(detailKeyOk('3c4197786e43ff94'), true));
check('detailKeyOk 拒空/空白/控制字符/..', () => {
  assert.equal(detailKeyOk(''), false);
  assert.equal(detailKeyOk('a b'), false);
  assert.equal(detailKeyOk('a\tb'), false);
  assert.equal(detailKeyOk('a..b'), false);
  assert.equal(detailKeyOk('x'.repeat(201)), false);
});

console.log('## 参数与状态码');
await checkAsync('缺 key → 400', async () => {
  const req = makeReq();
  await handleAssetDetailRoute(req, deps, getAssets);
  assert.equal(req.getSent().code, 400);
  assert.ok(req.getSent().payload.error.includes('缺少 key'));
});
await checkAsync('key 不合法 → 400', async () => {
  const req = makeReq({ key: 'a b' });
  await handleAssetDetailRoute(req, deps, getAssets);
  assert.equal(req.getSent().code, 400);
});
await checkAsync('找不到 → 404 且带「可能刚被移动/改名」', async () => {
  const req = makeReq({ key: 'nope' });
  await handleAssetDetailRoute(req, deps, getAssets);
  assert.equal(req.getSent().code, 404);
  assert.ok(req.getSent().payload.error.includes('可能刚被移动/改名'), req.getSent().payload.error);
});
await checkAsync('agent 令牌 → 403，非 GET → 405，别的路径 → false', async () => {
  const agent = makeReq({ key: 'g/c/normal', headers: { 'x-agent-token': 'x' } });
  await handleAssetDetailRoute(agent, deps, getAssets);
  assert.equal(agent.getSent().code, 403);
  const post = makeReq({ key: 'g/c/normal', method: 'POST' });
  await handleAssetDetailRoute(post, deps, getAssets);
  assert.equal(post.getSent().code, 405);
  const other = makeReq({ key: 'g/c/normal', pathname: '/api/library/assets' });
  assert.equal(await handleAssetDetailRoute(other, deps, getAssets), false);
  assert.equal(other.getSent(), null);
});

console.log('## 普通素材');
const normalReq = makeReq({ key: 'g/c/normal' });
await handleAssetDetailRoute(normalReq, deps, getAssets);
const normal = normalReq.getSent().payload;

check('顶层形状：ok + asset + paths + generatedAt', () => {
  assert.equal(normalReq.getSent().code, 200);
  assert.equal(normal.ok, true);
  assert.equal(typeof normal.generatedAt, 'number');
  assert.ok(normal.asset && normal.paths);
});
eq('files 列出 3 个文件（深度 4 那个不列）', normal.asset.files.map((f) => f.name).sort(), ['Mew Hair.zip', 'preview.jpg', 'readme.txt']);
eq('isMain 只标主包', normal.asset.files.filter((f) => f.isMain).map((f) => f.name), ['Mew Hair.zip']);
check('每个文件都有 rel/size/ext', () => {
  const main = normal.asset.files.find((f) => f.isMain);
  assert.deepEqual({ rel: main.rel, size: main.size, ext: main.ext }, { rel: 'g/c/normal/Mew Hair.zip', size: 100, ext: '.zip' });
});
check('totalBytes = 实际文件大小之和', () => assert.equal(normal.asset.totalBytes, 160));
check('paths.dirAbs / mainAbs 是档案根内绝对路径', () => {
  assert.equal(normal.paths.dirAbs, path.join(libDir, 'g/c/normal'));
  assert.equal(normal.paths.mainAbs, path.join(libDir, 'g/c/normal/Mew Hair.zip'));
});
check('meta 归一化（priceText 与 price 同值）', () => {
  assert.deepEqual(normal.asset.meta, { title: 'Mew Hair', shop: 'Studio', price: '¥1,100', priceText: '¥1,100', tags: ['髪'], itemUrl: 'https://booth.pm/ja/items/271777', category: '3Dモデル' });
});
check('识别字段/来源原样带出', () => {
  assert.equal(normal.asset.archivePassword, '7788');
  assert.equal(normal.asset.rjCode, 'RJ123456');
  assert.deepEqual(normal.asset.tags, ['发饰']);
  assert.equal(normal.asset.source, 'baidu');
  assert.equal(normal.asset.sourceText, '网盘');
});
eq('binds 从 booth-binds.json 读出来', normal.asset.binds, { boothId: '271777', title: 'Mew Hair', source: 'manual', at: 123 });
check('usage 缺省为 null（这件没被工程引用）', () => assert.equal(normal.asset.usage, null));
check('trashed=false', () => assert.equal(normal.asset.trashed, false));
check('previews/thumbRel 原样带出', () => {
  assert.equal(normal.asset.previews.length, 1);
  assert.equal(normal.asset.thumbRel, 'g/c/normal/preview.jpg');
});

console.log('## 合并卡');
const mergedReq = makeReq({ key: 'g/c/merged' });
await handleAssetDetailRoute(mergedReq, deps, getAssets);
const merged = mergedReq.getSent().payload;

check('files = 主成员 + 各成员目录（成员文件带 fromDir）', () => {
  const names = merged.asset.files.map((f) => f.name).sort();
  assert.deepEqual(names, ['A.thumbnail.jpg', 'A.zip', 'B.zip', 'extra.bin']);
  const member = merged.asset.files.find((f) => f.name === 'B.zip');
  assert.equal(member.fromDir, 'g/c/mergedB');
  const primary = merged.asset.files.find((f) => f.name === 'A.zip');
  assert.equal(primary.fromDir, undefined);
});
check('合并卡 isMain 只在主成员主包上，成员主包单标 isMemberMain', () => {
  assert.deepEqual(merged.asset.files.filter((f) => f.isMain).map((f) => f.name), ['A.zip']);
  assert.deepEqual(merged.asset.files.filter((f) => f.isMemberMain).map((f) => f.name), ['B.zip']);
});
check('totalBytes 跨成员求和', () => assert.equal(merged.asset.totalBytes, 560));
check('mergedMembers 原样带出 + mergedCount', () => {
  assert.equal(merged.asset.mergedCount, 2);
  assert.equal(merged.asset.mergedMembers.length, 2);
  assert.equal(merged.asset.mergedMembers[1].dir, 'g/c/mergedB');
});
check('usage 合并成员并按 path 去重', () => {
  assert.deepEqual(merged.asset.usage.projects.map((p) => p.path), ['D:/projA', 'D:/projB']);
});
check('不写绑定的合并卡 binds=null', () => assert.equal(merged.asset.binds, null));
check('trashed=true（回收站里有这个 key）', () => assert.equal(merged.asset.trashed, true));

console.log('## 只读访客：绝对路径剥离、相对字段保留');
const guestReq = makeReq({ key: 'g/c/merged', consoleRole: 'guest' });
await handleAssetDetailRoute(guestReq, deps, getAssets);
const guestView = guestReq.getSent().payload;
check('访客详情 200，但 paths=null、asset.usage=null', () => {
  assert.equal(guestReq.getSent().code, 200);
  assert.equal(guestView.ok, true);
  assert.equal(guestView.paths, null);
  assert.equal(guestView.asset.usage, null);
});
check('访客详情整段 JSON 不含本机绝对路径（盘符/家目录/AppData）', () => {
  const raw = JSON.stringify(guestView);
  // JSON 里 Windows 绝对路径会被转义成「盘符 + 两个反斜杠」，用字符码拼正则免得源码转义绕晕。
  const driveAbs = new RegExp('[A-Za-z]:' + String.fromCharCode(92, 92));
  assert.ok(!driveAbs.test(raw), raw.slice(0, 200));
  assert.ok(raw.indexOf('/home/') === -1 && raw.indexOf('AppData') === -1);
  assert.ok(raw.indexOf('"dirAbs"') === -1 && raw.indexOf('"mainAbs"') === -1);
});
check('访客详情仍保留相对字段（dir/mainName/files[].rel/mergedMembers）', () => {
  assert.equal(guestView.asset.dir, 'g/c/mergedA');
  assert.equal(guestView.asset.mainName, 'A.zip');
  assert.ok(guestView.asset.files.every((file) => !path.isAbsolute(file.rel)));
  assert.equal(guestView.asset.mergedMembers[0].dir, 'g/c/mergedA');
});
check('同一张卡管理员仍有绝对路径与 usage（没削掉管理端）', () => {
  assert.equal(path.isAbsolute(merged.paths.dirAbs), true);
  assert.deepEqual(merged.asset.usage.projects.map((p) => p.path), ['D:/projA', 'D:/projB']);
});

console.log('## 边界');
const manyReq = makeReq({ key: 'g/c/many' });
await handleAssetDetailRoute(manyReq, deps, getAssets);
check('一次最多列 50 个文件', () => assert.equal(manyReq.getSent().payload.asset.files.length, 50));

const escapeReq = makeReq({ key: 'g/c/escape' });
await handleAssetDetailRoute(escapeReq, deps, getAssets);
check('目录越界（dir=../outside）不抛错、不列文件、paths 为空', () => {
  const payload = escapeReq.getSent().payload;
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.asset.files, []);
  assert.equal(payload.paths.dirAbs, '');
  assert.equal(payload.paths.mainAbs, '');
});

console.log('## 真链路：library-view 分派 + 扫盘快照 + fresh 绕过缓存');
const snapshotDeps = {
  fs, path, STATE_DIR: stateDir, ROOT, log: () => {},
  fileArchiveRootDir: () => libDir,
  boothCacheDir: () => path.join(stateDir, 'booth-cache'),
  fileArchiveDb: () => ({}),
  listArchive: () => [],
  buildLibrarySnapshot: (options) => buildLibrarySnapshot({ ...options, rootDir: libDir }),
  getBoothCoverPath: () => '',
  safeResolveInside,
  mimeFromBuffer: () => 'image/png',
  spawn: () => ({ unref() {} }),
  libraryNotes: {},
  getBoothCover: async () => ({ ok: false }),
  fetchBoothMeta: async () => null
};
const view = createLibraryView(snapshotDeps);

function callView(pathname, query = {}) {
  let sent = null;
  return {
    req: { method: 'GET', headers: {} },
    url: { pathname, searchParams: new URLSearchParams(query) },
    readBody: async () => null,
    sendJson: (payload, code) => { sent = { payload, code: code || 200 }; },
    getSent: () => sent
  };
}

await checkAsync('列表里拿到 key，再用同一个 key 打详情能拿到同一件', async () => {
  const listReq = callView('/api/library/assets', { fresh: '1' });
  await view.handleLibraryAssetsRoute(listReq);
  const assets = listReq.getSent().payload.assets;
  assert.ok(assets.length >= 1, '临时库里应该有素材');
  const target = assets.find((asset) => asset.mainName === 'Mew Hair.zip') || assets[0];
  const detailReq = callView('/api/library/asset', { key: target.key, fresh: '1' });
  await view.handleLibraryAssetsRoute(detailReq);
  const sent = detailReq.getSent();
  assert.equal(sent.code, 200);
  assert.equal(sent.payload.asset.key, target.key);
  assert.ok(sent.payload.asset.files.some((f) => f.isMain), '真链路也要标出主包');
  assert.ok(sent.payload.asset.files.length >= 1);
});

await checkAsync('fresh=1 绕过 20 秒快照缓存（没传 fresh 时走缓存不重扫）', async () => {
  let scans = 0;
  const countingDeps = { ...snapshotDeps, buildLibrarySnapshot: (options) => { scans += 1; return buildLibrarySnapshot({ ...options, rootDir: libDir }); } };
  const countingView = createLibraryView(countingDeps);
  const first = callView('/api/library/assets', { fresh: '1' });
  await countingView.handleLibraryAssetsRoute(first);
  const key = first.getSent().payload.assets[0].key;
  const scanAfterList = scans;
  const cached = callView('/api/library/asset', { key });
  await countingView.handleLibraryAssetsRoute(cached);
  assert.equal(cached.getSent().code, 200);
  assert.equal(scans, scanAfterList, '没传 fresh 应该命中 20 秒缓存，不再重扫');
  const fresh = callView('/api/library/asset', { key, fresh: '1' });
  await countingView.handleLibraryAssetsRoute(fresh);
  assert.equal(fresh.getSent().code, 200);
  assert.equal(scans, scanAfterList + 1, 'fresh=1 必须重扫');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
if (failures.length) {
  console.error(`❌ test-library-asset-detail：${pass} 通过 / ${failures.length} 失败`);
  console.error('   失败项：' + failures.join('；'));
  process.exit(1);
}
console.log(`🎉 test-library-asset-detail 全部通过（${pass} 项）`);
