// scripts/test-library-purchase-detail.mjs — 商品详情面板（m07265）的纯规则 + 路由测试。
//
// 真机面板规则最容易错的三处：purchasedAt 拿 addedAt 兜底必须标来源、本地同号件只认 verified、
// 搭配建议只读台账（同店/同标签）不抓网。这里全部用假台账 + 假视图验证，不联网、不写真实 state。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}`);
  } else {
    failures.push(name);
    console.error(`❌ ${name}${detail === undefined ? '' : `：${JSON.stringify(detail)}`}`);
  }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const {
  normalizeBoothId,
  modelCountOf,
  modelBucketOf,
  purchasedAtOf,
  downloadedFilesOf,
  downloadStateOf,
  localAssetsOf,
  collectionsContaining,
  suggestionsFor,
  buildPurchaseDetail,
  describePurchaseDetail
} = await import(pathToFileURLSafe(`${ROOT}/src/library-purchase-detail.js`));
const { normalizeUsageRoot, normalizeUsageRoots, matchConfiguredUsageRoot, describeUsageRoots } = await import(
  pathToFileURLSafe(`${ROOT}/src/library-usage-roots.js`)
);
const { handlePurchaseDetailRoute } = await import(pathToFileURLSafe(`${ROOT}/src/bridge/console/library-purchase-detail.js`));

function pathToFileURLSafe(p) {
  return new URL(`file://${p.replace(/\\/g, '/')}`).href;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'purdetail-'));
const deps = { fs, path, STATE_DIR: tmp, log: () => {} };

function writeState(name, value) {
  fs.writeFileSync(path.join(tmp, name), JSON.stringify(value), 'utf8');
}

function makeReq({ method = 'GET', search = {}, headers = {} } = {}) {
  const params = new URLSearchParams(Object.entries(search));
  const sent = { payload: null, code: 200 };
  return {
    sent,
    request: {
      req: { method, headers },
      url: { pathname: '/api/library/purchase-detail', searchParams: params },
      sendJson(payload, code = 200) {
        sent.payload = payload;
        sent.code = code;
      }
    }
  };
}

const purchaseA = {
  boothId: '5197537',
  title: 'Astraea Milltina',
  shopName: 'MioVRC',
  shopUrl: 'https://example.booth.pm/',
  priceText: '¥1,200',
  tags: ['VRChat', '衣装'],
  categories: ['3D衣装'],
  models: { max: 3, total: 5, labeled: 2 },
  itemUrl: 'https://booth.pm/ja/items/5197537',
  coverUrl: 'https://cdn.example.com/5197537.jpg',
  addedAt: 1790000000000,
  updatedAt: 1790000500000
};
const purchaseB = {
  boothId: '883145',
  title: 'Mew Hair',
  shopName: 'MioVRC',
  tags: ['VRChat', 'ヘア'],
  models: { max: 0, total: 0, labeled: 0 },
  addedAt: 1791000000000
};
const assets = [
  { key: 'k-verified', boothId: '5197537', boothStatus: 'verified', title: '5197537', displayTitle: 'Astraea Milltina', dir: '5197537', bytes: 1234, thumbRel: 'a.jpg', mergedCount: 2 },
  { key: 'k-guess', boothId: '883145', boothStatus: 'candidate', title: '883145', dir: '883145', bytes: 10 },
  { key: 'k-other', boothId: '999999', boothStatus: 'verified', title: 'other', dir: 'x', bytes: 1 }
];
const collectionsTable = { version: 1, items: { col_1790000000000_abcd: { id: 'col_1790000000000_abcd', name: '常用', keys: ['k-verified'], updatedAt: 1 } } };

// ── 纯规则 ───────────────────────────────────────────────
eq('normalizeBoothId 合法', normalizeBoothId(' 5197537 '), '5197537');
eq('normalizeBoothId 非法', [normalizeBoothId('123'), normalizeBoothId('abc'), normalizeBoothId('1234567890')], ['', '', '']);

const mc = modelCountOf({ max: 3, total: 5, labeled: 2 });
eq('modelCountOf labeled 优先', [mc.max, mc.total, mc.labeled, mc.count], [3, 5, 2, 2]);
eq('modelCountOf 没 labeled 退回 max', modelCountOf({ max: 6 }).count, 6);
eq('modelCountOf 全 0 就是 0', modelCountOf({}).count, 0);

eq('modelBucket 未标', modelBucketOf({}).bucket, 'unlabeled');
eq('modelBucket 1', modelBucketOf({ labeled: 1 }).bucket, '1');
eq('modelBucket 3 进 2-3', modelBucketOf({ labeled: 3 }).bucket, '2-3');
eq('modelBucket 4 进 4+', modelBucketOf({ max: 4 }).bucket, '4+');
eq('modelBucket 带中文 label', modelBucketOf({ labeled: 2 }).label, '2~3 个');

const pa = purchasedAtOf({ purchasedAt: 111, addedAt: 222, updatedAt: 333 });
eq('purchasedAt 有真日期就用真日期', [pa.purchasedAt, pa.purchasedAtSource], [111, 'purchasedAt']);
const pa2 = purchasedAtOf({ addedAt: 222, updatedAt: 333 });
eq('purchasedAt 缺就 addedAt 兜底并标来源', [pa2.purchasedAt, pa2.purchasedAtSource], [222, 'addedAt']);
eq('purchasedAt 只有 updatedAt', purchasedAtOf({ updatedAt: 333 }).purchasedAtSource, 'updatedAt');
eq('purchasedAt 全无', purchasedAtOf({}).purchasedAtSource, 'none');

eq('downloadedFilesOf 空 job', downloadedFilesOf(null), []);
const files = downloadedFilesOf({ fileName: '6985553.zip', bytes: 99, state: 'done', skipped: true, extract: { state: 'ok', files: 3, bytes: 7 } });
eq('downloadedFilesOf 取 fileName/bytes/state', [files[0].fileName, files[0].bytes, files[0].state, files[0].skipped], ['6985553.zip', 99, 'done', true]);
eq('downloadedFilesOf 带解压结果', files[0].extracted, { state: 'ok', files: 3, bytes: 7 });

eq('downloadStateOf done 才算已下载', downloadStateOf({ state: 'done', finishedAt: 5 }).downloaded, true);
eq('downloadStateOf queued 不算', [downloadStateOf({ state: 'queued' }).downloaded, downloadStateOf({ state: 'queued' }).downloadState], [false, 'queued']);
eq('downloadStateOf failed 带原因', downloadStateOf({ state: 'failed', error: '链接过期了' }).error, '链接过期了');

const local = localAssetsOf(assets, '5197537');
eq('localAssetsOf 只认 verified 同号', local.map((a) => a.key), ['k-verified']);
eq('localAssetsOf 卡片字段', [local[0].title, local[0].dir, local[0].bytes, local[0].hasCover, local[0].mergedCount], ['Astraea Milltina', '5197537', 1234, true, 2]);
eq('localAssetsOf 忽略猜的号', localAssetsOf(assets, '883145'), []);

eq('collectionsContaining 命中', collectionsContaining(collectionsTable, ['k-verified']).map((c) => c.name), ['常用']);
eq('collectionsContaining 空 key', collectionsContaining(collectionsTable, []), []);

const suggestions = suggestionsFor(purchaseA, [purchaseA, purchaseB, { boothId: '700001', shopName: 'MioVRC', title: 'SameShop', updatedAt: 9 }]);
check('suggestionsFor 排除自己', !suggestions.some((s) => s.boothId === '5197537'));
check('suggestionsFor 同店优先（两家同店，按标签重叠排）', suggestions.slice(0, 2).every((s) => s.sameShop) && suggestions[0].boothId === '883145', suggestions);
eq('suggestionsFor 不抓网（字段只来自台账）', Object.keys(suggestions[0] || {}).includes('itemUrl'), true);
eq('suggestionsFor 无关件不推荐', suggestionsFor(purchaseA, [{ boothId: '800002', shopName: '别的店', tags: ['别'] }]), []);

const detail = buildPurchaseDetail({
  purchase: purchaseA,
  purchases: [purchaseA, purchaseB],
  assets,
  downloadJob: { fileName: '6985553.zip', bytes: 4321, state: 'done', finishedAt: 9 },
  collectionsTable,
  coverUrl: '/api/library/purchases/cover?boothId=5197537&v=1'
});
eq('buildPurchaseDetail 号与标题', [detail.item.boothId, detail.item.title], ['5197537', 'Astraea Milltina']);
eq('buildPurchaseDetail models 三段', detail.item.models, { max: 3, total: 5, labeled: 2 });
eq('buildPurchaseDetail 桶与计数', [detail.item.modelBucket, detail.item.modelCount], ['2-3', 2]);
eq('buildPurchaseDetail purchasedAt 兜底标 addedAt', [detail.item.purchasedAt, detail.item.purchasedAtSource], [1790000000000, 'addedAt']);
eq('buildPurchaseDetail inLibrary/downloaded', [detail.item.inLibrary, detail.item.downloaded], [true, true]);
eq('buildPurchaseDetail 本地件列表', detail.item.localAssets.map((a) => a.key), ['k-verified']);
eq('buildPurchaseDetail files 与 downloadedFiles 同源', detail.files.map((f) => f.fileName), ['6985553.zip']);
eq('buildPurchaseDetail 封面用传入地址', detail.item.coverUrl, '/api/library/purchases/cover?boothId=5197537&v=1');
eq('buildPurchaseDetail 素材集', detail.related.collections.map((c) => c.name), ['常用']);
eq('buildPurchaseDetail 无下载件时 downloaded=false', buildPurchaseDetail({ purchase: purchaseB, assets }).item.downloaded, false);
eq('buildPurchaseDetail 不在库', buildPurchaseDetail({ purchase: purchaseB, assets }).item.inLibrary, false);
check('describePurchaseDetail 有人话', describePurchaseDetail(detail).includes('已下载'), describePurchaseDetail(detail));

// ── usage roots（console-backend 的 import-to-unity 复用） ──────────
eq('normalizeUsageRoot 绝对路径去尾斜杠', normalizeUsageRoot('E:/projects/'), 'E:/projects');
eq('normalizeUsageRoot 反斜杠统一', normalizeUsageRoot('E:\\projects\\demo'), 'E:/projects/demo');
eq('normalizeUsageRoot 去引号', normalizeUsageRoot('"E:/projects"'), 'E:/projects');
eq('normalizeUsageRoot 相对路径保留', normalizeUsageRoot(' projects '), 'projects');
eq('normalizeUsageRoot 空/控制字符/超长', [normalizeUsageRoot(''), normalizeUsageRoot('a\u0001b'), normalizeUsageRoot('x'.repeat(401))], ['', '', '']);
eq('normalizeUsageRoots 去重保序', normalizeUsageRoots(['E:/a/', 'E:\\a', 'E:/b', '']), ['E:/a', 'E:/b']);
eq('matchConfiguredUsageRoot 直接命中', matchConfiguredUsageRoot('E:/a/', ['E:/a']), 'E:/a');
eq('matchConfiguredUsageRoot 相对路径拼 base', matchConfiguredUsageRoot('proj', ['E:/root/proj'], { baseDir: 'E:/root' }), 'E:/root/proj');
eq('matchConfiguredUsageRoot 未配置返回空', matchConfiguredUsageRoot('E:/zzz', ['E:/a']), '');
check('describeUsageRoots 未配置有人话', describeUsageRoots([]).includes('还没配置'), describeUsageRoots([]));

// ── 路由 ─────────────────────────────────────────────────
writeState('booth-purchases.json', { version: 1, items: { 5197537: purchaseA, 883145: purchaseB } });
writeState('booth-downloads.json', { v: 1, jobs: [{ boothId: '5197537', fileName: '6985553.zip', bytes: 4321, state: 'done', finishedAt: 9 }] });
writeState('library-collections.json', collectionsTable);
fs.mkdirSync(path.join(tmp, 'booth-purchase-covers'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'booth-purchase-covers', '5197537.jpg'), 'x');

const getAssets = async () => ({ assets });

const hit = makeReq({ search: { boothId: '5197537' } });
eq('路由命中返回 true', await handlePurchaseDetailRoute(hit.request, deps, getAssets), true);
eq('路由 200', hit.sent.code, 200);
eq('路由 item.boothId', hit.sent.payload?.item?.boothId, '5197537');
eq('路由本地封面走 purchases/cover', hit.sent.payload?.item?.coverUrl, '/api/library/purchases/cover?boothId=5197537&v=1790000500000');
eq('路由下载信息', [hit.sent.payload?.item?.downloaded, hit.sent.payload?.files?.[0]?.fileName], [true, '6985553.zip']);
eq('路由素材集', hit.sent.payload?.related?.collections?.map((c) => c.name), ['常用']);

const missCover = makeReq({ search: { boothId: '883145' } });
await handlePurchaseDetailRoute(missCover.request, deps, getAssets);
eq('没本地图退回远程/空串', missCover.sent.payload?.item?.coverUrl, '');
eq('未下载件 downloaded=false', missCover.sent.payload?.item?.downloaded, false);

const missing = makeReq({ search: { boothId: '777777' } });
await handlePurchaseDetailRoute(missing.request, deps, getAssets);
eq('未知号 404', missing.sent.code, 404);
check('未知号有人话', String(missing.sent.payload?.error).includes('没有这件已购记录'), missing.sent.payload);

const noId = makeReq({});
await handlePurchaseDetailRoute(noId.request, deps, getAssets);
eq('缺 boothId 400', noId.sent.code, 400);
const badId = makeReq({ search: { boothId: 'abc' } });
await handlePurchaseDetailRoute(badId.request, deps, getAssets);
eq('非法 boothId 400', badId.sent.code, 400);

const agent = makeReq({ search: { boothId: '5197537' }, headers: { 'x-agent-token': 't' } });
await handlePurchaseDetailRoute(agent.request, deps, getAssets);
eq('agent 令牌 403', agent.sent.code, 403);

const post = makeReq({ method: 'POST', search: { boothId: '5197537' } });
await handlePurchaseDetailRoute(post.request, deps, getAssets);
eq('POST 405', post.sent.code, 405);

const otherPath = {
  req: { method: 'GET', headers: {} },
  url: { pathname: '/api/library/purchases', searchParams: new URLSearchParams() },
  sendJson() {}
};
eq('别的路径返回 false', await handlePurchaseDetailRoute(otherPath, deps, getAssets), false);

const broken = makeReq({ search: { boothId: '5197537' } });
await handlePurchaseDetailRoute(broken.request, deps, async () => {
  throw new Error('扫描炸了');
});
eq('视图抛错 500', broken.sent.code, 500);
check('500 带原因', String(broken.sent.payload?.error).includes('扫描炸了'), broken.sent.payload);

// 坏台账不能崩：写成非 JSON
fs.writeFileSync(path.join(tmp, 'booth-purchases.json'), '{oops', 'utf8');
const dirty = makeReq({ search: { boothId: '5197537' } });
await handlePurchaseDetailRoute(dirty.request, deps, getAssets);
eq('坏台账不崩且判未购 404', dirty.sent.code, 404);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n商品详情面板：通过 ${passed} / 失败 ${failures.length}`);
if (failures.length) {
  console.error(`失败项：${failures.join('、')}`);
  process.exit(1);
}
