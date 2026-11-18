// BOOTH 商品页解析层（src/booth-product.js）的契约测试。
//
// 输入是 scripts/fixtures/booth-product/ 下**真实商品页**的 HTML 切片（来源 URL 与抓取日期见同目录 SOURCES.md），
// 断言解析出来的标题/店铺/价格/标签/图片/规格/适配模型数；另外锁住三个边界：
//   1. parseItemUrl 认各种 BOOTH 链接形状，别的站点返回 null；
//   2. 坏 HTML / 非商品页返回 null，不抛错；
//   3. 单价格商品没有「命名规格」时 variations 必须是 []（不能把默认购买档当成选项）；
//   4. 解析层保持纯函数：不 fetch、不 import bridge 任何模块（否则脱离桥接跑不了单测）。
import fs from 'node:fs';
import path from 'node:path';

import {
  parseBoothItemHtml,
  parseItemUrl,
  modelCountOf,
  summarizeModels,
  describePurchaseItem,
} from '../src/booth-product.js';

const FIXTURE_DIR = path.join('scripts', 'fixtures', 'booth-product');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
}

function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- 1. 多规格商品：9 个 variations，价格取 AggregateOffer.lowPrice ----
const many = parseBoothItemHtml(loadFixture('item-8942722-variations.html'));
check('多规格：能解析出商品', Boolean(many), many && many.title);
check('多规格：boothId 来自 canonical/JSON-LD', many?.boothId === '8942722', many?.boothId);
check('多规格：itemUrl 是商品页绝对地址', many?.itemUrl === 'https://booth.pm/ja/items/8942722', many?.itemUrl);
check('多规格：标题', many?.title === '脱ぎかけセータービキニ【8アバター対応】', many?.title);
check('多规格：店铺名', many?.shopName === 'ZigZag', many?.shopName);
check('多规格：店铺地址', many?.shopUrl === 'https://z1gz4g.booth.pm/', many?.shopUrl);
check('多规格：价格取最低价 990', many?.price === 990, many?.price);
check('多规格：币种 JPY', many?.currency === 'JPY', many?.currency);
check('多规格：价格文案 ¥ 990', many?.priceText === '¥ 990', many?.priceText);
check('多规格：标签取 tags[] 链接并解码', same(many?.tags, ['VRChat']), many?.tags);
check('多规格：分类是数组（页面是客户端渲染，允许空）', Array.isArray(many?.categories), many?.categories);
check('多规格：展示图 19 张（原图 png 去重后）', many?.images?.length === 19, many?.images?.length);
check('多规格：coverUrl = images[0]', many?.coverUrl === many?.images?.[0], many?.coverUrl);
check('多规格：coverUrl 是本商品原图', /\/i\/8942722\/[^/]+\.png$/.test(many?.coverUrl || ''), many?.coverUrl);
check('多规格：非免费', many?.isFree === false, many?.isFree);
check('多规格：未售罄', many?.isSoldOut === false, many?.isSoldOut);
check('多规格：9 个规格', many?.variations?.length === 9, many?.variations?.length);
check('多规格：首项名称', many?.variations?.[0]?.name === 'Full-Set_フルセット', many?.variations?.[0]?.name);
check('多规格：首项价格 1800', many?.variations?.[0]?.price === 1800, many?.variations?.[0]?.price);
check('多规格：首项价格文案', many?.variations?.[0]?.priceText === '¥ 1,800', many?.variations?.[0]?.priceText);
check('多规格：规格名没有适配数 → modelCount 全 0', many?.variations?.every((v) => v.modelCount === 0), many?.variations?.map((v) => v.modelCount));
check('多规格：models 全 0', same(many?.models, { max: 0, total: 0, labeled: 0 }), many?.models);
check('多规格：description 取 JSON-LD 正文', (many?.description || '').includes('オリジナル3Dモデル'), (many?.description || '').slice(0, 40));

// ---- 2. 免费商品：AggregateOffer.lowPrice = 0，规格名里带适配模型数 ----
const free = parseBoothItemHtml(loadFixture('item-4511536-free.html'));
check('免费：能解析出商品', Boolean(free), free && free.title);
check('免费：标题', free?.title === 'つぶせる！押せる！ましゅまろPB(Marshmallow PB)', free?.title);
check('免费：店铺名', free?.shopName === '綿飴屋 Wataameya', free?.shopName);
check('免费：价格 0', free?.price === 0, free?.price);
check('免费：isFree = true', free?.isFree === true, free?.isFree);
check('免费：价格文案 ¥ 0', free?.priceText === '¥ 0', free?.priceText);
check('免费：4 个规格', free?.variations?.length === 4, free?.variations?.length);
check('免费：11Avatars 规格解析出 11', free?.variations?.[1]?.modelCount === 11, free?.variations?.[1]?.modelCount);
check('免费：43Avatar 规格解析出 43', free?.variations?.[2]?.modelCount === 43, free?.variations?.[2]?.modelCount);
check('免费：?Avatars 解析不出 → 0', free?.variations?.[3]?.modelCount === 0, free?.variations?.[3]?.modelCount);
check('免费：models = {43,54,2}', same(free?.models, { max: 43, total: 54, labeled: 2 }), free?.models);
check('免费：展示图 11 张', free?.images?.length === 11, free?.images?.length);

// ---- 3. 单价格商品：只有一个默认购买档 → 没有可选规格 ----
const single = parseBoothItemHtml(loadFixture('item-6538026-single.html'));
check('单价格：能解析出商品', Boolean(single), single && single.title);
check('单价格：标题', single?.title === 'オリジナル3Dモデル『ミルティナ』', single?.title);
check('单价格：店铺名', single?.shopName === 'DOLOS art', single?.shopName);
check('单价格：价格 6000', single?.price === 6000, single?.price);
check('单价格：价格文案 ¥ 6,000', single?.priceText === '¥ 6,000', single?.priceText);
check('单价格：没有命名规格 → variations 为 []', same(single?.variations, []), single?.variations);
check('单价格：models 全 0', same(single?.models, { max: 0, total: 0, labeled: 0 }), single?.models);
check('单价格：展示图 5 张', single?.images?.length === 5, single?.images?.length);

// ---- 4. 返回字段形状（前端/落盘直接消费，别悄悄改名） ----
const EXPECTED_KEYS = [
  'boothId', 'itemUrl', 'title', 'shopName', 'shopUrl', 'price', 'currency', 'priceText',
  'tags', 'categories', 'images', 'coverUrl', 'description', 'isFree', 'isSoldOut', 'variations', 'models',
];
check('字段形状：解析结果字段齐全', EXPECTED_KEYS.every((key) => key in (many || {})), Object.keys(many || {}).join(','));
check('字段形状：variations 项字段齐全', ['name', 'priceText', 'price', 'modelCount', 'soldOut'].every((key) => key in (many?.variations?.[0] || {})), Object.keys(many?.variations?.[0] || {}).join(','));
check('字段形状：图片去重（同一张图的不同尺寸只留一份）', new Set(many?.images || []).size === (many?.images || []).length, many?.images?.length);

// ---- 5. parseItemUrl：认 BOOTH 链接，别的站点不认 ----
const urlCases = [
  ['https://booth.pm/ja/items/123', '123'],
  ['https://booth.pm/en/items/456?from=search', '456'],
  ['https://z1gz4g.booth.pm/items/8942722', '8942722'],
  ['https://booth.pm/zh-cn/items/9038753#variations', '9038753'],
  ['#123', '123'],
  ['8942722', '8942722'],
];
for (const [input, expected] of urlCases) {
  check(`parseItemUrl：${input} → ${expected}`, parseItemUrl(input) === expected, parseItemUrl(input));
}
const nullCases = ['', '   ', 'abc', 'https://example.com/items/1', 'https://booth.pm/ja/items/abc', 'https://booth.pm/ja/shops/1', null, undefined];
for (const input of nullCases) {
  check(`parseItemUrl：${JSON.stringify(input)} → null`, parseItemUrl(input) === null, parseItemUrl(input));
}

// ---- 6. modelCountOf：日文/英文两种写法，抽不出就是 0 ----
const countCases = [
  ['3モデル', 3],
  ['3 モデル対応', 3],
  ['3アバター対応', 3],
  ['11Avatars', 11],
  ['(43Avatar)', 43],
  ['追加プリセット⓪ / Additional Preset Vol.0 (43Avatar)', 43],
  ['All Avatars', 0],
  ['(?Avatars)', 0],
  ['24時間対応', 0],
  ['Full-Set_フルセット', 0],
  ['', 0],
  [null, 0],
];
for (const [input, expected] of countCases) {
  check(`modelCountOf：${JSON.stringify(input)} → ${expected}`, modelCountOf(input) === expected, modelCountOf(input));
}

// ---- 7. summarizeModels：空/纯名字数组也能算 ----
check('summarizeModels：空数组 → 全 0', same(summarizeModels([]), { max: 0, total: 0, labeled: 0 }), summarizeModels([]));
check('summarizeModels：非数组 → 全 0', same(summarizeModels(null), { max: 0, total: 0, labeled: 0 }), summarizeModels(null));
const namedOnly = summarizeModels([{ name: '3モデル' }, { name: '5アバター' }, { name: '通常版' }]);
check('summarizeModels：只给名字时自己算 → {5,8,2}', same(namedOnly, { max: 5, total: 8, labeled: 2 }), namedOnly);

// ---- 8. describePurchaseItem：一句中文、无换行 ----
for (const [label, item] of [['多规格', many], ['免费', free], ['单价格', single]]) {
  const line = describePurchaseItem(item);
  check(`摘要：${label} 非空且无换行`, Boolean(line) && !/[\r\n]/.test(line), line);
  check(`摘要：${label} 含标题`, line.includes(item.title), line);
  check(`摘要：${label} ≤100 字`, line.length <= 100, line.length);
}
const freeLine = describePurchaseItem(free);
check('摘要：免费商品写「免费」而不是 ¥ 0', freeLine.includes('免费') && !freeLine.includes('¥ 0'), freeLine);
check('摘要：免费商品带最多适配数', freeLine.includes('最多 43 个模型'), freeLine);
check('摘要：null → 空串', describePurchaseItem(null) === '', describePurchaseItem(null));
check('摘要：空对象 → 空串', describePurchaseItem({}) === '', describePurchaseItem({}));

// ---- 9. 坏 HTML / 非商品页：返回 null，不抛错 ----
function parseSafely(html) {
  try {
    return { ok: true, value: parseBoothItemHtml(html) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
const badCases = [['空串', ''], ['空 html', '<html></html>'], ['null', null], ['undefined', undefined], ['数字', 1234]];
for (const [label, input] of badCases) {
  const result = parseSafely(input);
  check(`坏输入：${label} 不抛错且返回 null`, result.ok && result.value === null, result.ok ? result.value : result.error);
}
const notItem = parseSafely('<html><head><title>BOOTH</title></head><body><div class="market"><h1>x</h1></div></body></html>');
check('坏输入：只有标题的非商品页返回 null', notItem.ok && notItem.value === null, notItem.ok ? notItem.value : notItem.error);

// ---- 10. 最小商品页：JSON-LD 缺字段时给默认值，不编 ----
const minimalHtml = [
  '<html><head>',
  '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"ミニマル商品","url":"https://booth.pm/ja/items/777","offers":{"@type":"Offer","price":"500","priceCurrency":"JPY","availability":"https://schema.org/OutOfStock"}}</script>',
  '</head><body><div class="market"><h2>ミニマル商品</h2></div></body></html>',
].join('');
const minimal = parseBoothItemHtml(minimalHtml);
check('最小页：能解析', Boolean(minimal), minimal && minimal.title);
check('最小页：无店铺 → shopName 空串', minimal?.shopName === '', minimal?.shopName);
check('最小页：无规格 → variations []', same(minimal?.variations, []), minimal?.variations);
check('最小页：无标签 → []', same(minimal?.tags, []), minimal?.tags);
check('最小页：无图片 → [] 且 coverUrl null', same(minimal?.images, []) && minimal?.coverUrl === null, minimal?.coverUrl);
check('最小页：售罄（availability=OutOfStock）', minimal?.isSoldOut === true, minimal?.isSoldOut);
check('最小页：非免费', minimal?.isFree === false, minimal?.isFree);
check('最小页：价格 500 / ¥ 500', minimal?.price === 500 && minimal?.priceText === '¥ 500', `${minimal?.price} ${minimal?.priceText}`);

// ---- 10b. JSON-LD 包在 @graph 里 / 只有 og 标签（没有 JSON-LD）的页面 ----
const graphHtml = [
  '<html><head><link rel="canonical" href="https://booth.pm/ja/items/888" />',
  '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","name":"x"},{"@type":"Product","name":"グラフ商品","url":"https://booth.pm/ja/items/888","offers":{"@type":"Offer","price":"1200","priceCurrency":"JPY","availability":"https://schema.org/InStock"}}]}</script>',
  '</head><body><div class="market"><h2>グラフ商品</h2></div></body></html>',
].join('');
const graphItem = parseBoothItemHtml(graphHtml);
check('@graph：能从 @graph 里找到 Product', graphItem?.title === 'グラフ商品', graphItem?.title);
check('@graph：价格 1200', graphItem?.price === 1200, graphItem?.price);
check('@graph：boothId 从 canonical 抽', graphItem?.boothId === '888', graphItem?.boothId);

const ogOnlyHtml = [
  '<html><head><meta property="og:type" content="product" />',
  '<meta property="og:title" content="テスト商品 - テスト屋 - BOOTH" />',
  '<meta property="og:url" content="https://booth.pm/ja/items/999" />',
  '<meta property="og:image" content="https://booth.pximg.net/x/i/999/aaa.png" />',
  '</head><body><div class="market"><h2>テスト商品</h2></div></body></html>',
].join('');
const ogItem = parseBoothItemHtml(ogOnlyHtml);
check('og 兜底：没有 JSON-LD 也能解析（og:type=product）', Boolean(ogItem), ogItem && ogItem.title);
check('og 兜底：标题去掉「 - 店铺 - BOOTH」尾巴', ogItem?.title === 'テスト商品', ogItem?.title);
check('og 兜底：价格缺失 → null / 空文案', ogItem?.price === null && ogItem?.priceText === '', `${ogItem?.price} ${ogItem?.priceText}`);
check('og 兜底：boothId 从 og:url 抽', ogItem?.boothId === '999', ogItem?.boothId);
check('og 兜底：图片取 og:image', ogItem?.images?.[0] === 'https://booth.pximg.net/x/i/999/aaa.png', ogItem?.images?.[0]);

// ---- 11. 解析层保持纯函数：不联网、不依赖 bridge ----
const moduleSource = fs.readFileSync(path.join('src', 'booth-product.js'), 'utf8');
check('纯函数：模块里没有 fetch( 调用', !/\bfetch\s*\(/.test(moduleSource), moduleSource.match(/\bfetch\s*\(/)?.[0]);
check('纯函数：模块里没有 import bridge 模块', !/from\s+['"][^'"]*bridge[^'"]*['"]/.test(moduleSource), moduleSource.match(/from\s+['"][^'"]+['"]/g)?.join(','));

// ---- 12. fixture 现状：存在、≤120KB、是真实页（带 JSON-LD） ----
for (const [file, label] of [
  ['item-8942722-variations.html', '多规格'],
  ['item-4511536-free.html', '免费'],
  ['item-6538026-single.html', '单价格'],
]) {
  const full = path.join(FIXTURE_DIR, file);
  const size = fs.statSync(full).size;
  const html = fs.readFileSync(full, 'utf8');
  check(`fixture：${label} 存在且 ≤120KB`, size > 0 && size <= 120 * 1024, size);
  check(`fixture：${label} 带 application/ld+json`, html.includes('application/ld+json'), file);
}

// ---- 汇总 ----
const failed = results.filter((item) => !item.ok);
for (const item of results) {
  if (item.ok) continue;
  console.log(`FAIL ${item.name}${item.detail === undefined ? '' : `（实际：${JSON.stringify(item.detail)}）`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} ok`);
if (failed.length) {
  console.log(`❌ test-booth-product：${failed.length} 条失败`);
  process.exitCode = 1;
} else {
  console.log('✅ test-booth-product：全部通过');
}
