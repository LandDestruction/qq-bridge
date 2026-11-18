// 已购库 ↔ 素材库对账：纯规则（src/library-reconcile.js）+ 只读路由（GET /api/library/reconcile）。
// 为什么要有这一套：用户最怕「买了但库里没有」，也想知道「库里这件是不是忘了登记已购」；
// 之前只能人工对着两个页面数。对账口径必须一处写死（按 boothId 认号、空号不匹配），
// 否则素材页看到的数字和这个接口算出来的数字会各说一套。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pure = await import(pathToFileURL(path.join(ROOT, 'src/library-reconcile.js')).href);
const routes = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-reconcile-routes.js')).href);
const {
  reconcileIdOf, normalizeReconcilePurchase, purchasesFromState, reconcilePurchasedAndLibrary
} = pure;
const { readPurchaseState, handleReconcileRoutes } = routes;

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
const deps = { fs, path, STATE_DIR: tmp, ROOT, log: () => {} };

function makeReq({ method = 'GET', pathname = '/api/library/reconcile', headers = {}, search = '' } = {}) {
  let sent = null;
  return {
    req: { method, headers },
    url: { pathname, searchParams: new URLSearchParams(search) },
    readBody: async () => null,
    sendJson: (payload, code) => { sent = { payload, code: code || 200 }; },
    getSent: () => sent
  };
}

console.log('## 号的口径');
eq('trim 后 5~9 位数字才算号', reconcileIdOf(' 271777 '), '271777');
eq('4 位不算', reconcileIdOf('1234'), '');
eq('10 位不算', reconcileIdOf('1234567890'), '');
eq('非数字不算', reconcileIdOf('abc123'), '');
eq('空值/null/undefined 都是没有号', [reconcileIdOf(''), reconcileIdOf(null), reconcileIdOf(undefined)], ['', '', '']);
eq('数字类型也能认', reconcileIdOf(7850009), '7850009');

console.log('## 台账条目归一化');
eq('坏条目 → null', [normalizeReconcilePurchase(null), normalizeReconcilePurchase({ title: 'x' }), normalizeReconcilePurchase({ boothId: '12' })], [null, null, null]);
check('title/shop/price 截断 + itemUrl 兜底', () => {
  const item = normalizeReconcilePurchase({ boothId: '271777', title: 't'.repeat(400), shopName: 's'.repeat(200), priceText: 'p'.repeat(100) });
  assert.equal(item.title.length, 300);
  assert.equal(item.shop.length, 120);
  assert.equal(item.priceText.length, 60);
  assert.equal(item.itemUrl, 'https://booth.pm/ja/items/271777');
});
check('purchasesFromState 丢掉坏条目，只认 items', () => {
  const list = purchasesFromState({ items: { a: { boothId: '271777' }, b: { title: '坏' }, c: { boothId: '7850009', title: 'Mew' } } });
  assert.deepEqual(list.map((item) => item.boothId), ['271777', '7850009']);
  assert.deepEqual(purchasesFromState(null), []);
});

console.log('## 对账（纯函数）');
const purchases = [
  { boothId: '271777', title: 'Astraea', shopName: 'Studio A', priceText: '¥1,100', updatedAt: 100 },
  { boothId: '7850009', title: 'Mew Hair', shopName: 'B', priceText: '¥550', updatedAt: 200 },
  { boothId: '111111', title: 'Missing One', shopName: 'C', priceText: '¥330', updatedAt: 300 }
];
const assets = [
  { key: 'g/a/astraea', title: 'Astraea', dir: 'R/271777_Astraea', boothId: '271777' },
  { key: 'g/b/mew', title: 'Mew Hair', dir: 'R/7850009_Mew', boothId: ' 7850009 ' },
  { key: 'g/c/extra', title: 'Extra Pack', dir: 'R/999999_Extra', boothId: '999999' },
  { key: 'g/d/plain', title: 'Plain', dir: 'R/plain', boothId: '' }
];
const result = reconcilePurchasedAndLibrary({ purchases, assets, now: 1234567890 });

eq('stats 五项（inLibrary 是有号卡数，含 extra 那张）', result.stats, { purchased: 3, inLibrary: 3, matched: 2, missing: 1, extra: 1 });
eq('generatedAt 用传入的 now', result.generatedAt, 1234567890);
eq('missing 是已购有、库里没有的那件', result.missing.map((item) => item.boothId), ['111111']);
eq('missing 带展示字段', { title: result.missing[0].title, shop: result.missing[0].shop, priceText: result.missing[0].priceText }, { title: 'Missing One', shop: 'C', priceText: '¥330' });
eq('extra 是库里有号但没登记已购的那件', result.extra.map((item) => item.key), ['g/c/extra']);
eq('extra 带 key/title/boothId/dir', result.extra[0], { boothId: '999999', title: 'Extra Pack', key: 'g/c/extra', dir: 'R/999999_Extra' });
eq('inLibrary 只列有号的卡（无号卡不参与）', result.inLibrary.map((card) => card.key), ['g/a/astraea', 'g/b/mew', 'g/c/extra']);
eq('卡片 boothId 已 trim', result.inLibrary[1].boothId, '7850009');
eq('purchased 按号排序', result.purchased.map((item) => item.boothId), ['111111', '271777', '7850009']);
check('purchased 带 coverRel/updatedAt 供路由换 thumb', () => {
  const item = result.purchased.find((row) => row.boothId === '271777');
  assert.equal(item.coverRel, '');
  assert.equal(item.updatedAt, 100);
});

check('同号重复登记：按 updatedAt 留新的那条', () => {
  const deduped = reconcilePurchasedAndLibrary({
    purchases: [
      { boothId: '271777', title: '旧名', updatedAt: 1 },
      { boothId: '271777', title: '新名', updatedAt: 9 }
    ],
    assets: [],
    now: 1
  });
  assert.equal(deduped.stats.purchased, 1);
  assert.equal(deduped.purchased[0].title, '新名');
});

eq('两边都空：统计全 0', reconcilePurchasedAndLibrary({ purchases: [], assets: [], now: 5 }), {
  stats: { purchased: 0, inLibrary: 0, matched: 0, missing: 0, extra: 0 },
  purchased: [], missing: [], inLibrary: [], extra: [], generatedAt: 5
});
eq('坏输入（null/字符串）当空', reconcilePurchasedAndLibrary({ purchases: 'x', assets: 42 }).stats, { purchased: 0, inLibrary: 0, matched: 0, missing: 0, extra: 0 });

check('?boothId 过滤：只算这一件', () => {
  const only = reconcilePurchasedAndLibrary({ purchases, assets, boothId: ' 7850009 ', now: 1 });
  assert.deepEqual(only.stats, { purchased: 1, inLibrary: 1, matched: 1, missing: 0, extra: 0 });
  assert.equal(only.purchased[0].title, 'Mew Hair');
});
check('非法 boothId 参数当没传（不 400）', () => {
  const all = reconcilePurchasedAndLibrary({ purchases, assets, boothId: 'abc' });
  assert.equal(all.stats.purchased, 3);
});
check('过滤到一件没买的号：missing 空、extra 有它', () => {
  const only = reconcilePurchasedAndLibrary({ purchases, assets, boothId: '999999' });
  assert.deepEqual(only.stats, { purchased: 0, inLibrary: 1, matched: 0, missing: 0, extra: 1 });
});

console.log('## 路由 GET /api/library/reconcile');
function writePurchases(state) {
  fs.writeFileSync(path.join(tmp, 'booth-purchases.json'), JSON.stringify(state), 'utf8');
}
fs.mkdirSync(path.join(tmp, 'booth-purchase-covers'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'booth-purchase-covers', '271777.jpg'), 'cover-bytes');
writePurchases({
  version: 1,
  items: {
    271777: { boothId: '271777', title: 'Astraea', shopName: 'Studio A', priceText: '¥1,100', coverRel: 'booth-purchase-covers/271777.jpg', updatedAt: 100 },
    7850009: { boothId: '7850009', title: 'Mew Hair', shopName: 'B', priceText: '¥550', updatedAt: 200 },
    111111: { boothId: '111111', title: 'Missing One', shopName: 'C', priceText: '¥330', updatedAt: 300 }
  }
});
const getAssets = async () => ({ ok: true, assets });

await checkAsync('GET：ok + stats + 三组清单 + generatedAt 是数字', async () => {
  const req = makeReq();
  const handled = await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(handled, true);
  const { payload, code } = req.getSent();
  assert.equal(code, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.stats, { purchased: 3, inLibrary: 3, matched: 2, missing: 1, extra: 1 });
  assert.equal(typeof payload.generatedAt, 'number');
  assert.deepEqual(payload.missing.map((item) => item.boothId), ['111111']);
  assert.deepEqual(payload.extra.map((item) => item.key), ['g/c/extra']);
  assert.deepEqual(payload.inLibrary.map((card) => card.key), ['g/a/astraea', 'g/b/mew', 'g/c/extra']);
});

await checkAsync('有封面文件的已购条目带 thumb，没有的给空串', async () => {
  const req = makeReq();
  await handleReconcileRoutes(req, deps, getAssets);
  const { payload } = req.getSent();
  const withCover = payload.purchased.find((item) => item.boothId === '271777');
  const withoutCover = payload.purchased.find((item) => item.boothId === '7850009');
  assert.equal(withCover.thumb, '/api/library/purchases/cover?boothId=271777&v=100');
  assert.equal(withoutCover.thumb, '');
  assert.equal(payload.missing[0].thumb, '', 'missing 没有本地封面时不该编一个 URL');
});

await checkAsync('?boothId= 过滤', async () => {
  const req = makeReq({ search: 'boothId=7850009' });
  await handleReconcileRoutes(req, deps, getAssets);
  const { payload } = req.getSent();
  assert.deepEqual(payload.stats, { purchased: 1, inLibrary: 1, matched: 1, missing: 0, extra: 0 });
});

await checkAsync('getAssets 抛错 → 500 且带「对账失败」前缀', async () => {
  const req = makeReq();
  await handleReconcileRoutes(req, deps, async () => { throw new Error('扫描炸了'); });
  const sent = req.getSent();
  assert.equal(sent.code, 500);
  assert.equal(sent.payload.ok, false);
  assert.ok(sent.payload.error.includes('对账失败'), sent.payload.error);
});

await checkAsync('agent 令牌 → 403（不读盘不扫描）', async () => {
  const req = makeReq({ headers: { 'x-agent-token': 'x' } });
  let scanned = false;
  await handleReconcileRoutes(req, deps, async () => { scanned = true; return { assets }; });
  assert.equal(req.getSent().code, 403);
  assert.equal(scanned, false);
});

await checkAsync('非 GET → 405', async () => {
  const req = makeReq({ method: 'POST' });
  await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(req.getSent().code, 405);
});

await checkAsync('别的路径 → false 且不响应', async () => {
  const req = makeReq({ pathname: '/api/library/assets' });
  const handled = await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(handled, false);
  assert.equal(req.getSent(), null);
});

await checkAsync('台账文件不存在 → 统计全 0（不是 500）', async () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-bare-'));
  const emptyDeps = { fs, path, STATE_DIR: bare, ROOT, log: () => {} };
  const req = makeReq();
  await handleReconcileRoutes(req, emptyDeps, getAssets);
  const { payload, code } = req.getSent();
  assert.equal(code, 200);
  assert.deepEqual(payload.stats, { purchased: 0, inLibrary: 3, matched: 0, missing: 0, extra: 3 });
  fs.rmSync(bare, { recursive: true, force: true });
});

await checkAsync('台账坏 JSON → 当空表', async () => {
  fs.writeFileSync(path.join(tmp, 'booth-purchases.json'), '{ 坏 json', 'utf8');
  assert.deepEqual(readPurchaseState(deps), { version: 1, items: {} });
  const req = makeReq();
  await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(req.getSent().code, 200);
  assert.equal(req.getSent().payload.stats.purchased, 0);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
if (failures.length) {
  console.error(`❌ test-library-reconcile：${pass} 通过 / ${failures.length} 失败`);
  console.error('   失败项：' + failures.join('；'));
  process.exit(1);
}
console.log(`🎉 test-library-reconcile 全部通过（${pass} 项）`);
