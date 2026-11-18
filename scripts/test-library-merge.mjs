// 同号素材合并：纯规则（分组 / 建组拆组 / 应用到卡片）+ 路由（GET merges、POST merge、POST split）。
//
// 为什么要有这一套：合并不动磁盘、不改 contentKey，但它会决定「页面上一张卡代表几条素材」——
// 规则错了用户就会看到文件凭空少掉或重复出现，所以分组/主成员/并集/拆开还原都要逐条钉住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  MERGE_RULES_VERSION, mergeIdOf, normalizeMergeTable, groupOfKey, setMerge,
  removeMerge, mergeTableSummary, proposeMergeGroups, applyMerges
} from '../src/library-merge.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createLibraryView } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-view.js')).href);

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

const card = (patch = {}) => ({
  key: 'g/c/a',
  title: 'A',
  dir: 'g/c/a',
  boothId: '',
  boothSource: '',
  thumbRel: '',
  files: [],
  previews: [],
  bytes: 0,
  ...patch
});

console.log('## mergeIdOf / normalizeMergeTable');
check('常量版本 1', () => assert.equal(MERGE_RULES_VERSION, 1));
check('合法号生成 m-<号>', () => assert.equal(mergeIdOf('8844481'), 'm-8844481'));
check('非法号返回空串', () => {
  for (const bad of ['', '1234', '1234567890', 'abc', null, undefined]) assert.equal(mergeIdOf(bad), '');
});
check('坏数据全部丢弃、不抛', () => {
  const table = normalizeMergeTable({ groups: { x: null, 'm-111111': { boothId: '111111', keys: ['a'] }, 'm-222222': { boothId: 'bad', keys: ['a', 'b'] } } });
  eq('单 key 组与坏号组都丢掉', Object.keys(table.groups), []);
});
check('keys 去重 + primaryKey 回落到第一条', () => {
  const table = normalizeMergeTable({ groups: { 'm-333333': { boothId: '333333', keys: ['b', 'b', 'a'], primaryKey: 'zzz' } } });
  eq('去重后顺序保持首次出现', table.groups['m-333333'].keys, ['b', 'a']);
  eq('primaryKey 不在 keys 里 → 第一条', table.groups['m-333333'].primaryKey, 'b');
});
check('同一个 key 只能属于一个组（先出现的组赢）', () => {
  const table = normalizeMergeTable({ groups: {
    'm-100001': { boothId: '100001', keys: ['a', 'b'] },
    'm-100002': { boothId: '100002', keys: ['b', 'c'] }
  } });
  eq('第一组保留 a/b', table.groups['m-100001'].keys, ['a', 'b']);
  eq('第二组只剩 c → 不足两条被丢掉', Object.keys(table.groups), ['m-100001']);
});
check('groupOfKey 命中与未命中', () => {
  const table = normalizeMergeTable({ groups: { 'm-100001': { boothId: '100001', keys: ['a', 'b'] } } });
  eq('a 属于 m-100001', groupOfKey(table, 'a'), 'm-100001');
  eq('未知 key 返回空串', groupOfKey(table, 'nope'), '');
});

console.log('## setMerge / removeMerge / mergeTableSummary');
check('setMerge 不改入参、返回新表', () => {
  const before = normalizeMergeTable(null);
  const snapshot = JSON.stringify(before);
  const next = setMerge(before, { boothId: '8844481', keys: ['a', 'b'], primaryKey: 'a', now: 5 });
  eq('原表没被改', JSON.stringify(before), snapshot);
  eq('新组 keys', next.groups['m-8844481'].keys, ['a', 'b']);
  eq('新组 at 记录', next.groups['m-8844481'].at, 5);
});
check('少于两条抛错', () => assert.throws(() => setMerge(null, { boothId: '8844481', keys: ['a'] }), /至少选两条/));
check('号不合法抛错', () => assert.throws(() => setMerge(null, { boothId: 'abc', keys: ['a', 'b'] }), /BOOTH 号不合法/));
check('同号重建：旧组被新组取代', () => {
  const first = setMerge(null, { boothId: '8844481', keys: ['a', 'b'], now: 1 });
  const second = setMerge(first, { boothId: '8844481', keys: ['a', 'c'], now: 2 });
  eq('只剩一个新组', Object.keys(second.groups), ['m-8844481']);
  eq('keys 换成新的两条', second.groups['m-8844481'].keys, ['a', 'c']);
});
check('抢走别人组的 key：让出后不足两条的组被删', () => {
  const first = setMerge(null, { boothId: '100001', keys: ['a', 'b'] });
  const second = setMerge(first, { boothId: '100002', keys: ['b', 'c'] });
  eq('原组只剩 a → 被删掉', Object.keys(second.groups), ['m-100002']);
  eq('新组拿到 b/c', second.groups['m-100002'].keys, ['b', 'c']);
});
check('primaryKey 不在 keys 里 → 回落第一条', () => {
  const table = setMerge(null, { boothId: '8844481', keys: ['a', 'b'], primaryKey: 'zzz' });
  eq('回落 a', table.groups['m-8844481'].primaryKey, 'a');
});
check('removeMerge 拆组且不改入参', () => {
  const table = setMerge(null, { boothId: '8844481', keys: ['a', 'b'] });
  const snapshot = JSON.stringify(table);
  const next = removeMerge(table, 'm-8844481');
  eq('组没了', Object.keys(next.groups), []);
  eq('原表没被改', JSON.stringify(table), snapshot);
});
check('removeMerge 未知组原样返回', () => {
  const table = setMerge(null, { boothId: '8844481', keys: ['a', 'b'] });
  eq('组数不变', Object.keys(removeMerge(table, 'm-999999').groups), ['m-8844481']);
});
check('mergeTableSummary 给组数/件数/折叠件数', () => {
  const one = setMerge(null, { boothId: '8844481', keys: ['a', 'b', 'c'] });
  const two = setMerge(one, { boothId: '9014210', keys: ['d', 'e'] });
  eq('摘要', mergeTableSummary(two), { version: 1, groups: 2, keys: 5, mergedAway: 3 });
});

console.log('## proposeMergeGroups');
check('同号 ≥2 条才提，非法号不提', () => {
  const proposals = proposeMergeGroups([
    card({ key: 'a', boothId: '8844481' }), card({ key: 'b', boothId: '8844481' }),
    card({ key: 'c', boothId: '1234' }), card({ key: 'd', boothId: '1234' }),
    card({ key: 'e', boothId: '' })
  ]);
  eq('只提 8844481 一组', proposals.map((p) => p.boothId), ['8844481']);
  eq('组内两条 key', proposals[0].keys, ['a', 'b']);
});
check('主成员：有缩略图优先', () => {
  const p = proposeMergeGroups([
    card({ key: 'a', boothId: '8844481', bytes: 900 }),
    card({ key: 'b', boothId: '8844481', bytes: 10, thumbRel: 'b.png' })
  ])[0];
  eq('选有封面的 b', p.primaryKey, 'b');
});
check('主成员：都没封面时字节大的赢', () => {
  const p = proposeMergeGroups([
    card({ key: 'a', boothId: '8844481', bytes: 10 }),
    card({ key: 'b', boothId: '8844481', bytes: 900 })
  ])[0];
  eq('选字节大的 b', p.primaryKey, 'b');
});
check('propose 汇总字节与文件数', () => {
  const p = proposeMergeGroups([
    card({ key: 'a', boothId: '8844481', bytes: 100, files: 1 }),
    card({ key: 'b', boothId: '8844481', bytes: 200, files: 1 })
  ])[0];
  eq('总字节', p.totalBytes, 300);
  eq('文件数', p.fileCount, 2);
});
check('已被合并表接管的号不再提', () => {
  const table = setMerge(null, { boothId: '8844481', keys: ['a', 'b'] });
  const proposals = proposeMergeGroups([
    card({ key: 'a', boothId: '8844481' }), card({ key: 'b', boothId: '8844481' })
  ], table);
  eq('空', proposals, []);
});

console.log('## applyMerges');
check('合并成一张卡：字段/并集/求和', () => {
  const cards = [
    card({ key: 'a', boothId: '8844481', dir: '8844481', bytes: 100, thumbRel: 'a.png', mainName: 'cover.png', title: 'Astraea', files: 2, previews: [{ relPath: 'a/x.png' }] }),
    card({ key: 'b', boothId: '8844481', dir: '2026-10', bytes: 900, files: 3, mainName: '8844481.zip', title: 'Astraea zip', previews: [{ relPath: 'b/y.zip' }] })
  ];
  const snapshot = JSON.stringify(cards);
  const table = setMerge(null, { boothId: '8844481', keys: ['a', 'b'], primaryKey: 'a' });
  const applied = applyMerges(cards, table);
  eq('只剩一张卡', applied.cards.length, 1);
  eq('折叠掉 1 张', applied.mergedAway, 1);
  eq('生效 1 组', applied.groups, 1);
  const merged = applied.cards[0];
  eq('保留主成员 key', merged.key, 'a');
  eq('带 mergeId', merged.mergeId, 'm-8844481');
  eq('mergedKeys 两条', merged.mergedKeys, ['a', 'b']);
  eq('mergedCount', merged.mergedCount, 2);
  // 真实 payload 的 files 是数字（文件个数），不是文件数组：合并卡必须继续是数字，且求和。
  eq('files 是数字求和', merged.files, 5);
  eq('mergedMembers 两条（主成员第一）', merged.mergedMembers.map((m) => m.key), ['a', 'b']);
  eq('mergedMembers 带 dir/mainName/files/bytes/title/dhash', merged.mergedMembers, [
    { key: 'a', dir: '8844481', mainName: 'cover.png', files: 2, bytes: 100, title: 'Astraea', dhash: '' },
    { key: 'b', dir: '2026-10', mainName: '8844481.zip', files: 3, bytes: 900, title: 'Astraea zip', dhash: '' }
  ]);
  eq('previews 并集去重', merged.previews.map((p) => p.relPath), ['a/x.png', 'b/y.zip']);
  eq('bytes 求和', merged.bytes, 1000);
  eq('dirs 去重', merged.dirs, ['8844481', '2026-10']);
  eq('不改传入对象', JSON.stringify(cards), snapshot);
});
check('合并卡继承主成员的封面指纹/展示字段', () => {
  const cards = [
    card({ key: 'a', boothId: '8844481', dhash: 'aaaa1111', thumbRel: 'a.png', coverUrl: '/api/library/cover?key=a', hasCover: true, displayTitle: 'A', boothStatus: 'verified' }),
    card({ key: 'b', boothId: '8844481', dhash: 'bbbb2222', thumbRel: 'b.png' })
  ];
  const merged = applyMerges(cards, setMerge(null, { boothId: '8844481', keys: ['a', 'b'], primaryKey: 'a' })).cards[0];
  eq('dhash 取主成员', merged.dhash, 'aaaa1111');
  eq('thumbRel 取主成员', merged.thumbRel, 'a.png');
  eq('coverUrl 取主成员', merged.coverUrl, '/api/library/cover?key=a');
  eq('hasCover 取主成员', merged.hasCover, true);
  eq('boothStatus 取主成员', merged.boothStatus, 'verified');
  eq('displayTitle 取主成员', merged.displayTitle, 'A');
  const byKey = new Map(merged.mergedMembers.map((m) => [m.key, m]));
  eq('mergedMembers 各带自己的 dhash', [byKey.get('a').dhash, byKey.get('b').dhash], ['aaaa1111', 'bbbb2222']);
});

check('主成员没有指纹时回退到第一个有值的成员', () => {
  const cards = [
    card({ key: 'a', boothId: '8844481', dhash: '', thumbRel: '' }),
    card({ key: 'b', boothId: '8844481', dhash: 'bbbb2222', thumbRel: 'b.png', displayTitle: 'B 的标题' })
  ];
  const merged = applyMerges(cards, setMerge(null, { boothId: '8844481', keys: ['a', 'b'], primaryKey: 'a' })).cards[0];
  eq('dhash 回退到 b', merged.dhash, 'bbbb2222');
  eq('thumbRel 回退到 b', merged.thumbRel, 'b.png');
  eq('displayTitle 回退到 b', merged.displayTitle, 'B 的标题');
});

check('拆分后每张卡回到自己的 dhash', () => {
  const cards = [
    card({ key: 'a', boothId: '8844481', dhash: 'aaaa1111' }),
    card({ key: 'b', boothId: '8844481', dhash: 'bbbb2222' })
  ];
  const split = applyMerges(cards, null);
  eq('两张卡各自 dhash', split.cards.map((c) => c.dhash), ['aaaa1111', 'bbbb2222']);
});

check('合并后「带指纹的卡数」与实际一致（withDhash 口径）', () => {
  const cards = [
    card({ key: 'a', boothId: '8844481', dhash: 'aaaa1111' }),
    card({ key: 'b', boothId: '8844481', dhash: 'bbbb2222' }),
    card({ key: 'c', boothId: '', dhash: 'cccc3333' }),
    card({ key: 'd', boothId: '', dhash: '' })
  ];
  const applied = applyMerges(cards, setMerge(null, { boothId: '8844481', keys: ['a', 'b'], primaryKey: 'a' }));
  const withDhash = applied.cards.filter((c) => c.dhash).length;
  eq('带指纹卡数=合并卡 1 + 单卡 1', withDhash, 2);
  eq('卡片总数（32 件里少掉的正是被合并的）', applied.cards.length, 3);
  const memberHashes = applied.cards.flatMap((c) => (c.mergedMembers ? c.mergedMembers.map((m) => m.dhash) : []));
  eq('mergedMembers 保住全部成员指纹', memberHashes, ['aaaa1111', 'bbbb2222']);
});

check('合并卡不保留只对单件有意义的辅助字段', () => {
  const cards = [
    card({ key: 'a', boothId: '8844481', dhashFile: 'state/x/a.bin', coverFile: 'covers/a.jpg' }),
    card({ key: 'b', boothId: '8844481' })
  ];
  const merged = applyMerges(cards, setMerge(null, { boothId: '8844481', keys: ['a', 'b'], primaryKey: 'a' })).cards[0];
  eq('dhashFile 被清掉', merged.dhashFile, undefined);
  eq('coverFile 被清掉', merged.coverFile, undefined);
});

check('拆开后合并字段消失、files 回到单卡数字', () => {
  const cards = [
    card({ key: 'a', boothId: '8844481', bytes: 100, files: 1 }),
    card({ key: 'b', boothId: '8844481', bytes: 900, files: 4 })
  ];
  const split = applyMerges(cards, null);
  eq('空表 → 两张普通卡', split.cards.length, 2);
  eq('没有 mergedKeys', split.cards[0].mergedKeys, undefined);
  eq('没有 mergedMembers', split.cards[0].mergedMembers, undefined);
  eq('files 仍是各自的数字', split.cards.map((c) => c.files), [1, 4]);
});

check('组里成员缺一条 → 原样保留，不硬造', () => {
  const cards = [card({ key: 'a', boothId: '8844481' })];
  const table = setMerge(null, { boothId: '8844481', keys: ['a', 'b'] });
  const applied = applyMerges(cards, table);
  eq('还是一张卡', applied.cards.length, 1);
  eq('没有 mergedKeys', applied.cards[0].mergedKeys, undefined);
});
check('主成员不存在时回落组内第一条', () => {
  const cards = [
    card({ key: 'b', boothId: '8844481' }),
    card({ key: 'c', boothId: '8844481' })
  ];
  const table = setMerge(null, { boothId: '8844481', keys: ['b', 'c'], primaryKey: 'zzz' });
  const applied = applyMerges(cards, table);
  eq('主成员是 b', applied.cards[0].key, 'b');
});
check('空表/坏表不改变卡片顺序', () => {
  const cards = [card({ key: 'a' }), card({ key: 'b' })];
  eq('顺序不变', applyMerges(cards, null).cards.map((c) => c.key), ['a', 'b']);
  eq('非数组输入也不崩', applyMerges(null, null).cards, []);
});

// ── 路由（真 createLibraryView + 假 deps + 临时 STATE_DIR）────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-merge-'));
const libDir = path.join(tmp, 'lib');
fs.mkdirSync(libDir, { recursive: true });
function sampleAssets() {
  return [
    card({ key: 'g/8844481', title: 'Astraea', dir: '8844481', boothId: '8844481', bytes: 100, thumbRel: '8844481/cover.png', files: 1 }),
    card({ key: 'g/2026-10/8844481', title: 'Astraea zip', dir: '2026-10', boothId: '8844481', bytes: 900, files: 1 }),
    card({ key: 'g/9014210a', title: 'B1', dir: 'b1', boothId: '9014210', bytes: 10 }),
    card({ key: 'g/9014210b', title: 'B2', dir: 'b2', boothId: '9014210', bytes: 20 })
  ];
}
const logs = [];
const deps = {
  fs,
  path,
  STATE_DIR: tmp,
  ROOT,
  log: (m) => logs.push(String(m)),
  fileArchiveRootDir: () => libDir,
  boothCacheDir: () => path.join(tmp, 'cache'),
  fileArchiveDb: () => ({}),
  listArchive: () => [],
  buildLibrarySnapshot: () => ({ ok: true, root: libDir, count: 4, bytes: 1030, withBooth: 4, withThumb: 1, assets: sampleAssets() }),
  getBoothCoverPath: () => '',
  safeResolveInside: (root, rel) => path.join(root, rel),
  mimeFromBuffer: () => 'image/png',
  spawn: () => ({ unref() {} }),
  libraryNotes: {},
  getBoothCover: async () => ({ ok: false }),
  fetchBoothMeta: async () => null,
  atomicWriteJson: (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2))
};
const view = createLibraryView(deps);
function makeReq({ method = 'GET', pathname, body, headers = {}, query = {} }) {
  let sent = null;
  return {
    req: { method, headers },
    url: { pathname, searchParams: new URLSearchParams(query) },
    readBody: async () => body ?? {},
    sendJson: (payload, code) => { sent = { payload, code: code || 200 }; },
    getSent: () => sent
  };
}
const mergeFile = path.join(tmp, 'booth-merges.json');

console.log('## 路由：GET /api/library/merges');
{
  const req = makeReq({ pathname: '/api/library/merges' });
  const handled = await view.handleLibraryAssetsRoute(req);
  const payload = req.getSent()?.payload;
  check('被接管且 ok', handled === true && payload?.ok === true, JSON.stringify(payload?.error));
  eq('proposals 给出 2 个可合并的号', payload.proposals.map((p) => p.boothId), ['8844481', '9014210']);
  eq('summary 初始 0 组', payload.summary.groups, 0);
  const agentReq = makeReq({ pathname: '/api/library/merges', headers: { 'x-agent-token': 'x' } });
  await view.handleLibraryAssetsRoute(agentReq);
  eq('智能体令牌 403', agentReq.getSent().code, 403);
}

console.log('## 路由：POST /api/library/merge');
{
  const req = makeReq({ method: 'POST', pathname: '/api/library/merge', body: { boothId: '8844481' } });
  await view.handleLibraryAssetsRoute(req);
  const payload = req.getSent()?.payload;
  check('合并成功并回 mergeId', payload?.ok === true && payload.mergeId === 'm-8844481', JSON.stringify(payload?.error));
  eq('折叠掉 1 张卡', payload.merged, 1);
  eq('生效 1 组', payload.mergedGroups, 1);
  eq('合并后剩 3 张卡', payload.assets.length, 3);
  const merged = payload.assets.find((a) => a.mergeId === 'm-8844481');
  eq('合并卡 files 数字求和', merged.files, 2);
  eq('mergedMembers 主成员第一', merged.mergedMembers[0].key, 'g/8844481');
  eq('合并卡 bytes 求和', merged.bytes, 1000);
  check('写盘 state/booth-merges.json', fs.existsSync(mergeFile) && fs.readFileSync(mergeFile, 'utf8').includes('m-8844481'));

  const assetsReq = makeReq({ pathname: '/api/library/assets' });
  await view.handleLibraryAssetsRoute(assetsReq);
  const assetsPayload = assetsReq.getSent().payload;
  eq('素材列表也合并（4 → 3）', assetsPayload.allCount, 3);
  eq('响应带 merged / mergedGroups', [assetsPayload.merged, assetsPayload.mergedGroups], [1, 1]);
  const mergedCard = assetsPayload.assets.find((a) => a.mergeId === 'm-8844481');
  eq('列表里的合并卡带 mergedCount', mergedCard.mergedCount, 2);
}

console.log('## 路由：POST /api/library/merge/split');
{
  const bad = makeReq({ method: 'POST', pathname: '/api/library/merge/split', body: {} });
  await view.handleLibraryAssetsRoute(bad);
  eq('缺 mergeId → 400', bad.getSent().code, 400);
  const unknown = makeReq({ method: 'POST', pathname: '/api/library/merge/split', body: { mergeId: 'm-999999' } });
  await view.handleLibraryAssetsRoute(unknown);
  eq('未知组 → 404', unknown.getSent().code, 404);
  const req = makeReq({ method: 'POST', pathname: '/api/library/merge/split', body: { mergeId: 'm-8844481' } });
  await view.handleLibraryAssetsRoute(req);
  check('拆开成功', req.getSent().payload?.ok === true, JSON.stringify(req.getSent().payload?.error));
  eq('表里 0 组', req.getSent().payload.summary.groups, 0);
  const assetsReq = makeReq({ pathname: '/api/library/assets' });
  await view.handleLibraryAssetsRoute(assetsReq);
  eq('拆开后回到 4 张卡', assetsReq.getSent().payload.allCount, 4);
  eq('不再有 merged 标记', assetsReq.getSent().payload.merged, 0);
}

console.log('## 路由：参数校验');
{
  const one = makeReq({ method: 'POST', pathname: '/api/library/merge', body: { keys: ['g/8844481'] } });
  await view.handleLibraryAssetsRoute(one);
  eq('只选一条 → 400', one.getSent().code, 400);
  const ghost = makeReq({ method: 'POST', pathname: '/api/library/merge', body: { keys: ['g/8844481', 'g/nope'] } });
  await view.handleLibraryAssetsRoute(ghost);
  eq('key 不存在 → 400', ghost.getSent().code, 400);
  const mixed = makeReq({ method: 'POST', pathname: '/api/library/merge', body: { keys: ['g/8844481', 'g/9014210a'] } });
  await view.handleLibraryAssetsRoute(mixed);
  check('不同号混着合并 → 400 且说明原因', mixed.getSent().code === 400 && /同一个 BOOTH 号/.test(mixed.getSent().payload.error),
    JSON.stringify(mixed.getSent().payload));
  const getMerge = makeReq({ method: 'GET', pathname: '/api/library/merge' });
  await view.handleLibraryAssetsRoute(getMerge);
  eq('GET merge → 405', getMerge.getSent().code, 405);
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响断言 */ }
console.log(`\n${failures.length ? '❌' : '🎉'} test-library-merge：通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  console.error('失败项：' + failures.join('；'));
  process.exit(1);
}
