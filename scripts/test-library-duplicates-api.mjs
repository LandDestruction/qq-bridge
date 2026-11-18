// 「清理重复」接口：真规则由 src/library-duplicates.js（retire-console 的契约测试在
// test-library-duplicates.mjs）提供；这里只验「最终视图 → 报告形状 → counts 口径」这条链路。

import assert from 'node:assert/strict';
import { buildDuplicateReport, duplicateCounts, handleLibraryDuplicatesRoute } from '../src/bridge/console/library-duplicates.js';

let failed = 0;
let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ✓ ' + name); }
  catch (error) { failed += 1; console.error('  ✗ ' + name); console.error('    ' + (error?.message ?? error)); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed += 1; console.log('  ✓ ' + name); }
  catch (error) { failed += 1; console.error('  ✗ ' + name); console.error('    ' + (error?.message ?? error)); }
}
function eq(name, actual, expected) {
  check(name, () => assert.deepEqual(actual, expected));
}

// ── 样本科目：三组重复（同号 / 同名同大小 / 封面近似）+ 一件无关卡 ───────────
function sampleAssets() {
  return [
    { key: 'g/a/pack-a', title: 'Astraea pack', displayTitle: 'Astraea pack', dir: 'g/a/pack-a', mainName: 'Astraea.zip', mainBytes: 1000, bytes: 1000, boothId: '8844481', boothStatus: 'verified', dhash: 'aaaa', thumbRel: 'g/a/a.png' },
    { key: 'g/b/pack-b', title: 'Astraea (1)', displayTitle: 'Astraea (1)', dir: 'g/b/pack-b', mainName: 'Astraea (1).zip', mainBytes: 1001, bytes: 1001, boothId: '8844481', boothStatus: 'verified', dhash: 'bbbb' },
    { key: 'g/c/same-1', title: 'Mew Hair', dir: 'g/c/same-1', mainName: 'Mew Hair.zip', mainBytes: 5000, bytes: 5000, boothId: '', boothStatus: 'none', dhash: '' },
    { key: 'g/c/same-2', title: 'Mew Hair copy', dir: 'g/c/same-2', mainName: 'Mew Hair_1.zip', mainBytes: 5000, bytes: 5000, boothId: '', boothStatus: 'none', dhash: '' },
    { key: 'g/d/cover-1', title: 'Witch', dir: 'g/d/cover-1', mainName: 'Witch.zip', mainBytes: 11, bytes: 11, boothId: '111111', boothStatus: 'none', dhash: '1234567890abcdef', thumbRel: 'g/d/cover-1.png' },
    { key: 'g/d/cover-2', title: 'Witch alt', dir: 'g/d/cover-2', mainName: 'WitchAlt.zip', mainBytes: 22, bytes: 22, boothId: '222222', boothStatus: 'none', dhash: '1234567890abcdef' },
    { key: 'g/e/only', title: 'Only', dir: 'g/e/only', mainName: 'Only.zip', mainBytes: 7, bytes: 7, boothId: '', boothStatus: 'none', dhash: 'zzzz' }
  ];
}

console.log('## 报告形状');
const report = buildDuplicateReport(sampleAssets());
check('三组都分出来了（同号/同名同大小/封面近似）', () => {
  const reasons = report.groups.map((group) => group.reason);
  assert.ok(reasons.includes('同号'), reasons.join(','));
  assert.ok(reasons.includes('同名同大小'), reasons.join(','));
  assert.ok(reasons.includes('封面近似'), reasons.join(','));
});
check('每组都有 reason/keys/keepKey/members', () => {
  for (const group of report.groups) {
    assert.ok(group.reason);
    assert.ok(group.keys.length >= 2);
    assert.ok(group.keys.includes(group.keepKey));
    assert.equal(group.members.length, group.keys.length);
  }
});
check('成员带 title/dir/bytes/hasCover/dhash', () => {
  const member = report.groups[0].members[0];
  for (const field of ['key', 'title', 'dir', 'bytes', 'hasCover', 'dhash']) assert.ok(field in member, field);
});
eq('同号组带 verified 的 boothId', report.groups.find((group) => group.reason === '同号').boothId, '8844481');
eq('没有 verified 号的组 boothId 空串', report.groups.filter((group) => group.reason !== '同号').every((group) => group.boothId === ''), true);
eq('keepKey 不跨组重复', new Set(report.groups.map((group) => group.keepKey)).size, report.groups.length);
check('summary 与组自洽', () => {
  assert.equal(report.summary.groupCount, report.groups.length);
  assert.equal(report.summary.extraCount, report.groups.reduce((sum, group) => sum + group.keys.length - 1, 0));
  assert.equal(report.summary.extraBytes, report.groups.reduce((sum, group) => sum + group.extraBytes, 0));
});
check('封面近似组保留有封面的那张（keepKey 规则来自纯模块）', () => {
  const group = report.groups.find((item) => item.reason === '封面近似');
  assert.ok(group, '缺封面近似组');
  assert.equal(group.keepKey, 'g/d/cover-1');
});

console.log('\n## 规则边界（只确认传给纯函数的输入正确，不重写规则）');
check('合并卡不参与分组', () => {
  const merged = sampleAssets().map((asset) => (asset.key === 'g/b/pack-b' ? { ...asset, mergedCount: 2, mergedKeys: ['x', 'y'] } : asset));
  assert.equal(buildDuplicateReport(merged).groups.some((group) => group.keys.includes('g/b/pack-b')), false);
});
check('解压产物不在传入数组里就不参与（视图层已摘掉）', () => {
  const assets = sampleAssets().filter((asset) => asset.key !== 'g/b/pack-b');
  assert.equal(buildDuplicateReport(assets).groups.some((group) => group.keys.includes('g/b/pack-b')), false);
});
check('空输入 0 组', () => {
  const empty = buildDuplicateReport([]);
  assert.equal(empty.groups.length, 0);
  assert.deepEqual(empty.summary, { groupCount: 0, extraCount: 0, extraBytes: 0 });
});
check('非数组输入不崩', () => assert.equal(buildDuplicateReport(null).groups.length, 0));

console.log('\n## counts 口径');
check('duplicated = 属于重复组的卡片数（不是组数）', () => {
  const counts = duplicateCounts(sampleAssets());
  const expect = buildDuplicateReport(sampleAssets()).groups.reduce((sum, group) => sum + group.keys.length, 0);
  assert.equal(counts.cards, expect);
  assert.ok(counts.cards > counts.groups, '卡片数应大于组数');
});
check('duplicateGroups = 组数', () => {
  assert.equal(duplicateCounts(sampleAssets()).groups, buildDuplicateReport(sampleAssets()).summary.groupCount);
});
check('没有重复时 counts 全 0', () => {
  assert.deepEqual(duplicateCounts([sampleAssets()[6]]), { cards: 0, groups: 0 });
});

console.log('\n## 路由');
function makeRequest({ method = 'GET', query = {}, headers = {} } = {}) {
  const captured = { status: 0, payload: null };
  return {
    req: { method, headers },
    url: { pathname: '/api/library/duplicates', searchParams: new URLSearchParams(query) },
    sendJson: (payload, status = 200) => { captured.payload = payload; captured.status = status; },
    captured
  };
}
const deps = { log: () => {} };

await checkAsync('200 返回报告并调用 getAssets', async () => {
  const request = makeRequest({ query: { fresh: '1' } });
  let calls = 0;
  const handled = await handleLibraryDuplicatesRoute(request, deps, async () => { calls += 1; return { assets: sampleAssets() }; });
  assert.equal(handled, true);
  assert.equal(request.captured.status, 200);
  assert.equal(calls, 1);
  assert.equal(request.captured.payload.ok, true);
  assert.ok(request.captured.payload.groups.length >= 3);
});
await checkAsync('getAssets 直接返回数组也能处理', async () => {
  const request = makeRequest();
  await handleLibraryDuplicatesRoute(request, deps, async () => sampleAssets());
  assert.equal(request.captured.status, 200);
  assert.ok(request.captured.payload.groups.length >= 3);
});
await checkAsync('agent 令牌 403', async () => {
  const request = makeRequest({ headers: { 'x-agent-token': 'a' } });
  await handleLibraryDuplicatesRoute(request, deps, async () => ({ assets: [] }));
  assert.equal(request.captured.status, 403);
  assert.match(request.captured.payload.error, /只允许管理端/);
});
await checkAsync('POST 405', async () => {
  const request = makeRequest({ method: 'POST' });
  await handleLibraryDuplicatesRoute(request, deps, async () => ({ assets: [] }));
  assert.equal(request.captured.status, 405);
});
await checkAsync('非本路径返回 false', async () => {
  const request = makeRequest();
  request.url.pathname = '/api/library/assets';
  assert.equal(await handleLibraryDuplicatesRoute(request, deps, async () => ({ assets: [] })), false);
});
await checkAsync('快照抛错 → 500 人话', async () => {
  const request = makeRequest();
  await handleLibraryDuplicatesRoute(request, deps, async () => { throw new Error('boom'); });
  assert.equal(request.captured.status, 500);
  assert.match(request.captured.payload.error, /统计重复素材失败：boom/);
});

console.log('');
if (failed) {
  console.error(`❌ ${failed} 项失败（通过 ${passed}）`);
  process.exit(1);
}
console.log(`🎉 test-library-duplicates-api 全部通过（${passed} 项）`);
