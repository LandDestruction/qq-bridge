// 素材库 Pro 界面：facets 计数（左栏/胶囊）与收藏路由的单测。
//
// 为什么必须测「自洽」：facets 是左栏数字，assets 是列表。两者只要口径不同，
// 用户点「服装 2 件」就会看到 1 件——这类不一致比数字不准更伤信任。
// 所以这里除了纯函数计数，还把 facets 的每个分类/桶拿去和 assets 的同参数筛选结果对齐。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildLibraryFacets, FACETS_RULES_VERSION } from '../src/library-facets.js';
import { applyCategoryToAsset } from '../src/library-category.js';
import { pickAssetsPage } from '../src/library-assets-query.js';
import { handleLibraryFacetsRoute } from '../src/bridge/console/library-facets.js';
import { handleLibraryFavoritesRoute } from '../src/bridge/console/library-favorites.js';
import { annotateLibraryAssets } from '../src/bridge/console/library-annotations.js';
import { normalizeFavorites, isFavoriteKey, setFavorite, favoriteCount, migrateFavorite } from '../src/library-favorites.js';

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-facets-'));
const logs = [];
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
const deps = {
  fs,
  path,
  STATE_DIR: tmp,
  log: (msg) => logs.push(String(msg)),
  atomicWriteJson: (file, value) => writeJson(file, value)
};

// 样本：覆盖「有/无店铺、已购/未购、收藏、重复号、有解压码/RJ、标签、模型数」。
function sampleAssets() {
  return [
    { key: 'g/c/a', title: 'Mew Hair', dir: 'g/c', mainName: 'Mew Hair.zip', boothId: '111111', thumbRel: 'g/c/a.png', archivePassword: 'pass-1', meta: { shop: 'MewStore', category: '衣装' }, tags: ['发饰'] },
    { key: 'g/c/b', title: 'Witch Costume 2アバター', dir: 'g/c', mainName: 'Witch.zip', boothId: '', thumbRel: '', meta: { shop: 'MewStore' }, tags: ['服装'] },
    { key: 'g/d/c', title: 'Astraea', dir: 'g/d', mainName: 'Astraea.zip', boothId: '222222', thumbRel: '', rjCode: 'RJ123456', meta: { shop: 'AstroShop', category: 'アバター' }, tags: ['服装'] },
    { key: 'g/d/d', title: 'plain pack', dir: 'g/d', mainName: 'plain.zip', boothId: '222222', thumbRel: 'g/d/d.png', meta: { shop: '   ' }, tags: [] },
    { key: 'g/d/e', title: 'Endless Comfort', dir: 'g/d', mainName: 'Endless.zip', boothId: '', thumbRel: '', tags: [] },
    { key: 'g/e/f', title: 'Voice Set', dir: 'g/e', mainName: 'Voice.zip', boothId: '333333', thumbRel: 'g/e/f.png', meta: { shop: 'VoiceShop' }, tags: ['语音'] }
  ].map(applyCategoryToAsset);
}

console.log('## buildLibraryFacets（纯函数）');

const empty = buildLibraryFacets([], {});
check('空库 total 0', empty.total === 0);
check('空库 category 为空数组', Array.isArray(empty.facets.category) && empty.facets.category.length === 0);
check('版本号 categoryRules=v1', empty.categoryRules === FACETS_RULES_VERSION && FACETS_RULES_VERSION === 'v1');

const plain = buildLibraryFacets(sampleAssets(), { purchased: 1, free: 0 });
eq('total = 卡片数', plain.total, 6);
eq('category 顺序按固定表：服装 → 模型 → 音声 → 未分类', plain.facets.category.map((item) => item.value), ['服装', '模型', '音声', '未分类']);
eq('category 计数：服装 2 / 模型 1 / 音声 1 / 未分类 2', plain.facets.category.map((item) => item.count), [2, 1, 1, 2]);
eq('店铺按 count 降序且空店铺不列', plain.facets.shop.map((item) => [item.value, item.count]), [['MewStore', 2], ['AstroShop', 1], ['VoiceShop', 1]]);
eq('标签按 count 降序', plain.facets.tag.map((item) => [item.value, item.count]), [['服装', 2], ['发饰', 1], ['语音', 1]]);
eq('modelCount 桶按固定顺序：未标注 → 2-3', plain.facets.modelCount.map((item) => item.value), ['unlabeled', '2-3']);
eq('modelCount 桶标签用中文', plain.facets.modelCount.map((item) => item.label), ['未标注', '2~3']);
eq('purchased/free 数字原样', [plain.facets.purchased, plain.facets.free], [1, 0]);
check('分类项默认 fromManual:false（前端靠它给左栏加「手动」后缀）', plain.facets.category.every((item) => item.fromManual === false));

// 手动分类要能被左栏认出来：不能靠当前页卡片推断（换页就漏、筛过更不准），facets 必须自己标。
const manualFacets = buildLibraryFacets([{ key: 'x', category: '衣装', categoryFrom: 'manual', tags: [], tagsAll: [] }], {});
eq('手动分类项标 fromManual:true', manualFacets.facets.category.map((item) => [item.value, item.fromManual, item.count]), [['衣装', true, 1]]);

// 同名分类里只要有一件来自手动，就标 true（左栏按分类名打后缀，不按单件）。
const mixedFacets = buildLibraryFacets([
  { key: 'm1', category: '衣装', categoryFrom: 'manual', tags: [], tagsAll: [] },
  { key: 'm2', category: '衣装', categoryFrom: 'rule', tags: [], tagsAll: [] },
  { key: 'm3', category: '未分类', categoryFrom: 'rule', tags: [], tagsAll: [] }
], {});
eq('同名分类有手动来源即标 true，旧字段（label/count）仍在',
  mixedFacets.facets.category.map((item) => [item.value, item.fromManual, item.count, typeof item.label]),
  // 自定义分类（衣装）不在固定表里，按 toFacetList 的规则补在固定表之后。
  [['未分类', false, 1, 'string'], ['衣装', true, 2, 'string']]);
check('quality 只列 >0：无封面 3、未认号 2、有解压码 1、有 RJ 1、未分类 2',
  JSON.stringify(plain.facets.quality) === JSON.stringify([
    { value: 'noCover', label: '无封面', count: 3 },
    { value: 'noBooth', label: '未认号', count: 2 },
    { value: 'withPassword', label: '有解压码', count: 1 },
    { value: 'rj', label: '有 RJ', count: 1 },
    { value: 'unclassified', label: '未分类', count: 2 }
  ]), JSON.stringify(plain.facets.quality));
check('quality 不含 0 件的 duplicated（这组样本还没标重复号）',
  !plain.facets.quality.some((item) => item.value === 'duplicated'));

const withDup = buildLibraryFacets(sampleAssets().map((asset) => (asset.boothId === '222222' ? { ...asset, duplicated: true } : asset)), {});
eq('duplicated 出现且计 2', withDup.facets.quality.find((item) => item.value === 'duplicated')?.count, 2);

// 前端「质量」下拉还要两档（2026-10-30）：含解压产物的父件、重复素材。
// 重复材料必须用 routing 层传进来的分组 key 集合算，否则和 counts.duplicated / filter=duplicated 对不上。
const qualityExtra = buildLibraryFacets([
  { key: 'p1', extracted: { count: 2 } },
  { key: 'p2', extracted: { count: 0 } },
  { key: 'p3' }
], {});
eq('quality.extracted 只算「有解压产物」的父件', qualityExtra.facets.quality.find((item) => item.value === 'extracted'), {
  value: 'extracted', label: '含解压产物', count: 1
});
const dupByKeys = buildLibraryFacets([{ key: 'd1' }, { key: 'd2' }, { key: 'd3' }, { key: 'solo' }], {
  duplicatedKeys: new Set(['d1', 'd2', 'd3'])
});
eq('quality.duplicated 用分组 key 集合算（一组 3 张卡 → 3）', dupByKeys.facets.quality.find((item) => item.value === 'duplicated')?.count, 3);

const sourceFacet = buildLibraryFacets([
  { key: 'a', source: 'transfer' },
  { key: 'b', source: 'baidu' },
  { key: 'c', source: 'unfiled' },
  { key: 'd', source: 'unknown' },
  { key: 'e', source: '' }
], {});
eq('source 顺序 transfer→baidu→unfiled→unknown，空值不列',
  sourceFacet.facets.source.map((item) => [item.value, item.label]),
  [['transfer', '群转存'], ['baidu', '百度网盘'], ['unfiled', '未分类目录'], ['unknown', '未知']]);

const weird = buildLibraryFacets([{ key: 'x', meta: { shop: '新店' }, tags: ['新标签'], modelBucket: '未知桶' }], {});
eq('顺序表之外的新店铺补在后面，不丢', weird.facets.shop.map((item) => item.value), ['新店']);
eq('未知桶也补在后面（不让计数消失）', weird.facets.modelCount.map((item) => item.value), ['未知桶']);

console.log('\n## 收藏纯规则');

eq('normalize 接受 {entries}', favoriteCount(normalizeFavorites({ version: 1, entries: { k1: { at: 5 }, k2: { at: 0 } } })), 2);
eq('normalize 接受 {keys:[]}', favoriteCount(normalizeFavorites({ keys: ['k1', 'k2', 'k2'] })), 2);
eq('normalize 接受数组', favoriteCount(normalizeFavorites(['k1', 'k2'])), 2);
eq('坏值（null/数字/字符串）当空表', favoriteCount(normalizeFavorites(null)) + favoriteCount(normalizeFavorites(42)) + favoriteCount(normalizeFavorites('nope')), 0);
eq('key 非法（含空格/超长/空）被丢', favoriteCount(normalizeFavorites({ entries: { 'a b': { at: 1 }, '': { at: 1 }, ['x'.repeat(201)]: { at: 1 }, ok: { at: 1 } } })), 1);
check('isFavoriteKey 正常 key true', isFavoriteKey(normalizeFavorites({ entries: { k1: { at: 1 } } }), 'k1') === true);
check('isFavoriteKey 未收藏 false', isFavoriteKey(normalizeFavorites({ entries: {} }), 'k1') === false);
const baseTable = normalizeFavorites({ entries: { k1: { at: 1 } } });
const opened = setFavorite(baseTable, 'k2', true, 100);
eq('setFavorite 开 → 计 2', favoriteCount(opened), 2);
eq('setFavorite 不改入参（收敛状态好回滚）', favoriteCount(baseTable), 1);
eq('setFavorite 关 → 计 1', favoriteCount(setFavorite(opened, 'k2', false, 200)), 1);
check('setFavorite 空 key 抛错', (() => { try { setFavorite(baseTable, '', true, 1); return false; } catch { return true; } })());
const migrated = migrateFavorite(baseTable, 'k1', 'k9');
eq('migrate 旧 key → 新 key', favoriteCount(migrated.table) === 1 && Boolean(migrated.table.entries.k9) && !migrated.table.entries.k1, true);
eq('migrate 返回 moved', migrated.moved, true);
eq('migrate 旧 key 没有收藏 → moved false', migrateFavorite(baseTable, 'nope', 'k9').moved, false);

console.log('\n## annotateLibraryAssets：关系字段 + 重复号');

writeJson(path.join(tmp, 'booth-purchases.json'), { version: 1, items: { '111111': { boothId: '111111', title: 'Mew Hair' } } });
writeJson(path.join(tmp, 'booth-favorites.json'), { version: 1, entries: { 'g/c/a': { at: 7 } } });
writeJson(path.join(tmp, 'booth-usage.json'), { usage: { 'g/c/a': { projects: [{ at: 10 }, { at: 20 }], lastScanAt: 15 } } });

const annotated = annotateLibraryAssets(deps, { assets: sampleAssets(), summary: { assets: 6 } });
const cardA = annotated.assets.find((asset) => asset.key === 'g/c/a');
const cardC = annotated.assets.find((asset) => asset.key === 'g/d/c');
const cardD = annotated.assets.find((asset) => asset.key === 'g/d/d');
eq('收藏命中', cardA.favorite, true);
eq('已购命中（purchase=purchased）', cardA.purchase, 'purchased');
eq('使用统计：projects 数 2、最后使用取 max', [cardA.usageCount, cardA.lastUsedAt], [2, 20]);
eq('未购买/未收藏的卡是空值', [cardC.favorite, cardC.purchase], [false, '']);
eq('同一 boothId 两张卡都标 duplicated', [cardC.duplicated, cardD.duplicated], [true, true]);
// duplicated 按「重复的号」计：两张卡共用一个号只算 1 个问题号。
eq('annotationStats 汇总', annotated.annotationStats, { favorites: 1, purchased: 1, free: 0, usageHits: 1, duplicated: 1 });
check('不改入参（缓存安全）', sampleAssets()[0].favorite === undefined);

console.log('\n## facets 与 assets 筛选自洽');

const facetData = buildLibraryFacets(annotated.assets, {
  purchased: annotated.assets.filter((asset) => asset.purchase === 'purchased').length,
  free: annotated.assets.filter((asset) => asset.purchase === 'free').length
});
for (const item of facetData.facets.category) {
  const page = pickAssetsPage(annotated.assets, { category: item.value });
  check(`分类「${item.value}」facets 计数 ${item.count} == 列表 total ${page.total}`, page.total === item.count);
}
for (const item of facetData.facets.modelCount) {
  const page = pickAssetsPage(annotated.assets, { model: item.value });
  check(`模型桶「${item.value}」计数一致（${item.count}）`, page.total === item.count);
}
const purchasedPage = pickAssetsPage(annotated.assets, { purchase: 'purchased' });
eq('purchase=purchased 列表 total == facets.purchased', purchasedPage.total, facetData.facets.purchased);

console.log('\n## 路由：GET /api/library/facets');

function makeReq({ pathname = '/api/library/facets', query = {}, method = 'GET', headers = {}, body = null, role = '' } = {}) {
  const sent = { payload: null, code: 200 };
  return {
    sent,
    request: {
      req: { method, headers },
      url: { pathname, searchParams: new URLSearchParams(query) },
      consoleRole: role,
      readBody: async () => { if (body instanceof Error) throw body; return body; },
      sendJson: (payload, code) => { sent.payload = payload; sent.code = code || 200; }
    }
  };
}

const okReq = makeReq();
const handled = await handleLibraryFacetsRoute(okReq.request, deps, async () => ({ assets: annotated.assets }));
check('facets 路由命中', handled === true);
eq('路由回 200', okReq.sent.code, 200);
eq('路由 total = 卡片数', okReq.sent.payload.total, 6);
check('响应带 categoryRules 与 q', okReq.sent.payload.categoryRules === 'v1' && okReq.sent.payload.q === '');
eq('purchased 按子集统计', okReq.sent.payload.facets.purchased, 1);
check('写了一条 facets 日志', logs.some((line) => line.includes('facets：q=（空）') && line.includes('6 件')));

const qReq = makeReq({ query: { q: 'witch' } });
await handleLibraryFacetsRoute(qReq.request, deps, async () => ({ assets: annotated.assets }));
eq('q=witch 子集 total 1', qReq.sent.payload.total, 1);
eq('q 子集只剩「服装」分类', qReq.sent.payload.facets.category.map((item) => item.value), ['服装']);

const agentReq = makeReq({ headers: { 'x-agent-token': 't' } });
await handleLibraryFacetsRoute(agentReq.request, deps, async () => ({ assets: annotated.assets }));
eq('agent 令牌 403', agentReq.sent.code, 403);

const postReq = makeReq({ method: 'POST' });
await handleLibraryFacetsRoute(postReq.request, deps, async () => ({ assets: [] }));
eq('非 GET 405', postReq.sent.code, 405);

const otherReq = makeReq({ pathname: '/api/library/other' });
eq('别的路径不接管', await handleLibraryFacetsRoute(otherReq.request, deps, async () => ({ assets: [] })), false);

const boomReq = makeReq();
await handleLibraryFacetsRoute(boomReq.request, deps, async () => { throw new Error('扫盘炸了'); });
eq('扫描异常 → 500 且只给结论', [boomReq.sent.code, /统计失败/.test(boomReq.sent.payload.error)], [500, true]);

console.log('\n## 路由：收藏');

const favFile = path.join(tmp, 'booth-favorites.json');
fs.rmSync(favFile, { force: true });

const listReq = makeReq({ pathname: '/api/library/favorites' });
check('空表 GET 命中', (await handleLibraryFavoritesRoute(listReq.request, deps)) === true);
eq('空表 GET keys=[], count=0', [listReq.sent.payload.keys, listReq.sent.payload.count], [[], 0]);

const onReq = makeReq({ pathname: '/api/library/favorite', method: 'POST', body: { key: 'g/c/a', on: true } });
await handleLibraryFavoritesRoute(onReq.request, deps);
eq('收藏 1 件', [onReq.sent.payload.ok, onReq.sent.payload.favorite, onReq.sent.payload.count], [true, true, 1]);
const diskAfterOn = JSON.parse(fs.readFileSync(favFile, 'utf8'));
check('收藏立刻落盘（atomically 写的条目带 at）', Boolean(diskAfterOn.entries['g/c/a']?.at));

const listReq2 = makeReq({ pathname: '/api/library/favorites' });
await handleLibraryFavoritesRoute(listReq2.request, deps);
eq('GET 能读到刚收藏的 key', listReq2.sent.payload.keys, ['g/c/a']);

const toggleReq = makeReq({ pathname: '/api/library/favorite', method: 'POST', body: { key: 'g/c/a' } });
await handleLibraryFavoritesRoute(toggleReq.request, deps);
eq('不传 on 时按切换处理 → 取消', [toggleReq.sent.payload.favorite, toggleReq.sent.payload.count], [false, 0]);

const onAgain = makeReq({ pathname: '/api/library/favorite', method: 'POST', body: { key: 'g/c/a', on: true } });
await handleLibraryFavoritesRoute(onAgain.request, deps);
const offReq = makeReq({ pathname: '/api/library/favorite', method: 'POST', body: { key: 'g/c/a', on: false } });
await handleLibraryFavoritesRoute(offReq.request, deps);
eq('on:false 显式取消', [offReq.sent.payload.favorite, offReq.sent.payload.count], [false, 0]);

const badKeyReq = makeReq({ pathname: '/api/library/favorite', method: 'POST', body: {} });
await handleLibraryFavoritesRoute(badKeyReq.request, deps);
eq('缺 key → 400', [badKeyReq.sent.code, /缺少 key/.test(badKeyReq.sent.payload.error)], [400, true]);

const badBodyReq = makeReq({ pathname: '/api/library/favorite', method: 'POST', body: Object.assign(new Error('请求体不是 JSON'), { statusCode: 413 }) });
await handleLibraryFavoritesRoute(badBodyReq.request, deps);
eq('readBody 异常按其状态码回（413）', badBodyReq.sent.code, 413);

const guestReq = makeReq({ pathname: '/api/library/favorite', method: 'POST', body: { key: 'g/c/a', on: true }, role: 'guest' });
await handleLibraryFavoritesRoute(guestReq.request, deps);
eq('访客 POST 403', [guestReq.sent.code, /访客只能查看/.test(guestReq.sent.payload.error)], [403, true]);

const guestGetReq = makeReq({ pathname: '/api/library/favorites', role: 'guest' });
await handleLibraryFavoritesRoute(guestGetReq.request, deps);
eq('访客 GET 允许', guestGetReq.sent.code, 200);

const listPostReq = makeReq({ pathname: '/api/library/favorites', method: 'POST' });
await handleLibraryFavoritesRoute(listPostReq.request, deps);
eq('favorites 只支持 GET（POST 405）', listPostReq.sent.code, 405);

const toggleGetReq = makeReq({ pathname: '/api/library/favorite', method: 'GET' });
await handleLibraryFavoritesRoute(toggleGetReq.request, deps);
eq('favorite 只支持 POST（GET 405）', toggleGetReq.sent.code, 405);

const otherFavReq = makeReq({ pathname: '/api/library/x' });
eq('其它路径不接管', await handleLibraryFavoritesRoute(otherFavReq.request, deps), false);

fs.writeFileSync(favFile, '{ 这不是 JSON');
const brokenReq = makeReq({ pathname: '/api/library/favorites' });
await handleLibraryFavoritesRoute(brokenReq.request, deps);
eq('坏收藏文件当空表（不让素材页炸）', brokenReq.sent.payload.count, 0);

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
if (failures.length) {
  console.error(`facets / 收藏：通过 ${pass} / 失败 ${failures.length}`);
  process.exit(1);
}
console.log(`🎉 facets 与收藏全部通过（${pass} 项）`);
