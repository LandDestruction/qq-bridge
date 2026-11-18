// GET /api/library/assets 的服务端筛选/分页（第 3 批）：q / filter / sort / offset / limit。
//
// 为什么要有这一套：素材上千件后「全量返回给前端筛」既慢又容易口径打架——尤其「有没有封面」，
// 必须以 enrichAssetsWithBoothMeta 的 data.withCover 为同一判据，否则页面写「3 件没封面」却筛出 4 件。
// 这里全部用假 deps（假扫盘、假封面缓存）直接打路由，不碰真库、不发网络请求。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createLibraryView, pickAssetsPage } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-view.js')).href);

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-filter-'));
const libDir = path.join(tmp, 'lib');
const cacheDir = path.join(tmp, 'cache');
fs.mkdirSync(path.join(libDir, 'g', 'c'), { recursive: true });
fs.mkdirSync(path.join(libDir, 'g', 'd'), { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

// BOOTH 封面缓存：只有 5223668 有（用来验证「只靠 coverUrl 也算有封面」这条口径）。
fs.writeFileSync(path.join(cacheDir, '5223668.jpg'), 'cached-cover');
// 侧边状态文件：一条人工绑定、一条批量建议（走真实 normalize/apply 规则，不假造卡片字段）。
fs.writeFileSync(path.join(tmp, 'booth-binds.json'), JSON.stringify({
  version: 1,
  entries: { 'g/d/witch': { boothId: '111111', title: 'Witch Costume', source: 'manual', at: 1 } }
}));
// 认号可信度（2026-10-30）：只有 verified 的号才显示封面/商品名。样本里带号的四件都进已购台账，
// 这样「已认号 = verified」与旧断言（4 件有号）一致；witch 走人工绑定表（另算 verified）。
fs.writeFileSync(path.join(tmp, 'booth-purchases.json'), JSON.stringify({
  version: 1,
  items: {
    '8844481': { boothId: '8844481', title: 'Mew Hair', shopName: 'MewStore' },
    '271777': { boothId: '271777', title: 'Astraea', shopName: 'AstroShop' },
    '5223668': { boothId: '5223668', title: 'Endless Comfort' },
    '222222': { boothId: '222222', title: 'Zeta' }
  }
}));
fs.writeFileSync(path.join(tmp, 'booth-batchfind.json'), JSON.stringify({
  version: 1,
  rulesVersion: 999, // 版本故意写旧，别影响 suggestionFor 之外的东西（它不看版本）
  entries: { 'g/d/zzz': { at: 2, pick: '333333', auto: true, score: 0.9, title: 'Zeta', reason: '封面一致', candidates: 3, skipped: false } }
}));

// 6 件样本科目：有号 4、无号 2；有封面 3（缩略图 2 + 只有 BOOTH 缓存图 1）、无封面 3；
// 有建议 1、已绑定 1。
function sampleAssets() {
  // Pro 界面（文档 §2.2）要的字段：meta.shop/category/models、tags、bytes、mainName 扩展名。
  // 分类结论：Mew Hair→发型、Witch Costume→服装、Astraea(meta アバター)→模型，其余未分类。
  return [
    { key: 'g/c/hair', title: 'Mew Hair', dir: 'g/c', file: 'Mew Hair.zip', mainName: '8844481 Test Rename.zip', boothId: '', boothSource: '', thumbRel: 'g/c/hair.png', bytes: 300, tags: ['发饰'], meta: { shop: 'MewStore' } },
    { key: 'g/c/astro', title: 'Astraea', dir: 'g/c', file: 'Astraea.zip', boothId: '271777', boothSource: '', thumbRel: '', files: 2, bytes: 100, meta: { shop: 'AstroShop', category: 'アバター', models: ['ModelA', 'ModelB'] } },
    { key: 'g/c/endless', title: 'Endless Comfort', dir: 'g/c', file: 'Endless Comfort.zip', boothId: '5223668', boothSource: '', thumbRel: '', bytes: 50 },
    { key: 'g/d/plain', title: 'plain pack', dir: 'g/d', file: 'plain.zip', mainName: 'plain.png', boothId: '', boothSource: '', thumbRel: '', files: 3, bytes: 30 },
    { key: 'g/d/witch', title: 'Witch Costume', dir: 'g/d', file: 'Witch.zip', boothId: '', boothSource: '', thumbRel: '', bytes: 20, meta: { shop: 'WitchShop' } },
    { key: 'g/d/zzz', title: 'Zeta', dir: 'g/d', file: 'Zeta.zip', boothId: '222222', boothSource: '', thumbRel: 'g/d/zzz.png', bytes: 10, meta: { shop: 'ZetaShop', models: '4' } }
  ];
}

// 带解压码 / RJ 号 / 类型标签 / 四种来源的样本科目（m03790）。
// 名字里的信息全部由「假识别规则」给：真规则在 src/library-tagging.js（retire-console 并行开发），
// 这边只验「规则结果有没有正确落到卡片、统计、筛选、搜索上」。
function tagAssets() {
  return [
    { key: 'g/c/hair', title: 'Mew Hair RJ123456', dir: 'BaiduNetdisk/系列1', file: 'RJ123456_Mew Hair.zip', mainName: 'RJ123456_Mew Hair.zip', boothId: '8844481', boothSource: '', thumbRel: 'g/c/hair.png' },
    { key: 'g/c/endless', title: 'Endless Comfort', dir: '转存_2026/服装', file: 'pass-7788 Endless.zip', mainName: 'pass-7788 Endless.zip', boothId: '5223668', boothSource: '', thumbRel: '' },
    { key: 'g/d/plain', title: 'plain pack', dir: '_未分类/杂项', file: 'plain.zip', mainName: 'plain.zip', boothId: '', boothSource: '', thumbRel: '' },
    { key: 'g/d/astro', title: 'Astraea', dir: 'random/系列2', file: 'pass-abcd Astraea.zip', mainName: 'pass-abcd Astraea.zip', boothId: '271777', boothSource: '', thumbRel: '' },
    { key: 'g/d/witch', title: 'Witch Costume', dir: '百度网盘/服装', file: 'RJ999999 Witch.zip', mainName: 'RJ999999 Witch.zip', boothId: '', boothSource: '', thumbRel: '' },
    { key: 'g/d/zzz', title: 'Zeta', dir: '转存/语音', file: 'Zeta 语音.zip', mainName: 'Zeta 语音.zip', boothId: '222222', boothSource: '', thumbRel: 'g/d/zzz.png' }
  ];
}

// 假识别规则：只认 pass-xxxx / RJxxxxxx / 名字里的中文标签，够用来验证接线。
function describeTagsFake({ title, mainName }) {
  const text = `${title} ${mainName}`;
  const tags = [];
  for (const word of ['发饰', '服装', '语音', '版本', 'Hair']) if (text.includes(word)) tags.push(word === 'Hair' ? '发饰' : word);
  return {
    archivePassword: /pass-([a-z0-9]+)/i.exec(text)?.[1] ?? '',
    rjCode: /(RJ\d{6,8})/i.exec(text)?.[1] ?? '',
    tags,
    sellerItemIds: []
  };
}

const logs = [];
let currentAssets = sampleAssets;
const deps = {
  fs,
  path,
  STATE_DIR: tmp,
  ROOT,
  log: (m) => logs.push(String(m)),
  fileArchiveRootDir: () => libDir,
  boothCacheDir: () => cacheDir,
  fileArchiveDb: () => ({}),
  listArchive: () => [],
  // 假扫盘：每次给一份全新数组，避免 enrich 就地改字段影响下一次断言。
  // withBooth 故意写 3（扫盘时的旧值，不含绑定结果）：路由必须先应用绑定再重算，
  // 否则「有号 3」和「no-booth 2」（6-4）会自相矛盾。
  buildLibrarySnapshot: () => ({ ok: true, root: libDir, count: 6, bytes: 600, withBooth: 3, withThumb: 2, assets: currentAssets() }),
  getBoothCoverPath: (id, { cacheRoot }) => {
    const p = path.join(String(cacheRoot), `${id}.jpg`);
    return fs.existsSync(p) ? p : '';
  },
  safeResolveInside: (root, rel) => path.join(root, rel),
  mimeFromBuffer: () => 'image/png',
  spawn: () => ({ unref() {} }),
  libraryNotes: {},
  getBoothCover: async () => ({ ok: false }),
  fetchBoothMeta: async () => null,
  // 注入假识别规则（真模块未落地时也能验接线逻辑，这是 deps 注入的意义）
  libraryTagging: { describeAssetTags: describeTagsFake }
};
const view = createLibraryView(deps);

function makeReq(query = {}) {
  let sent = null;
  return {
    req: { method: 'GET', headers: {} },
    url: { pathname: '/api/library/assets', searchParams: new URLSearchParams(query) },
    sendJson: (payload, code) => { sent = { payload, code: code || 200 }; },
    getSent: () => sent
  };
}

/** 打一次接口，带 fresh=1（不然 20 秒缓存会让后面幾组断言都拿到第一份结果）。 */
async function callAssets(query = {}) {
  const r = makeReq({ fresh: '1', ...query });
  const handled = await view.handleLibraryAssetsRoute(r);
  const sent = r.getSent() || { payload: null, code: 0 };
  return { handled, code: sent.code, payload: sent.payload };
}

function titlesOf(payload) {
  return (payload?.assets || []).map((a) => a.title);
}

console.log('## 无参数：与老行为等价（全量、默认上限、老字段都在）');
{
  const { handled, code, payload } = await callAssets();
  check('路由被本模块处理', handled === true && code === 200);
  eq('无参数返回全部 6 件', titlesOf(payload), ['Mew Hair', 'Astraea', 'Endless Comfort', 'plain pack', 'Witch Costume', 'Zeta']);
  eq('count = 本页条数', payload.count, 6);
  eq('total = 筛选后总数', payload.total, 6);
  eq('allCount = 全库件数', payload.allCount, 6);
  eq('默认 offset=0 / limit=500', [payload.offset, payload.limit], [0, 500]);
  eq('没有截断', payload.truncated, false);
  check('老字段仍在（ok/root/bytes/count 之外的统计）',
    payload.ok === true && typeof payload.root === 'string' && payload.bytes === 600,
    JSON.stringify({ ok: payload.ok, root: payload.root, bytes: payload.bytes }));
  check('withCover 口径 = 缩略图 or BOOTH 缓存图 = 3', payload.withCover === 3, String(payload.withCover));
}

console.log('## q 模糊匹配（title / dir / 号，大小写不敏感）');
{
  eq('q=hair 命中标题（小写也能中 Mew Hair）', titlesOf((await callAssets({ q: 'hair' })).payload), ['Mew Hair']);
  eq('q=MEW 大小写不敏感', titlesOf((await callAssets({ q: 'MEW' })).payload), ['Mew Hair']);
  eq('q=g/d 命中目录', (await callAssets({ q: 'g/d' })).payload.count, 3);
  eq('q=271777 命中 BOOTH 号', titlesOf((await callAssets({ q: '271777' })).payload), ['Astraea']);
  eq('q 命中 0 件时 total=0', [((await callAssets({ q: '不存在的素材' })).payload.count), ((await callAssets({ q: '不存在的素材' })).payload.total)], [0, 0]);
  eq('q 全是空白 → 当作没传', (await callAssets({ q: '   ' })).payload.count, 6);
}

console.log('## filter 五种');
{
  eq('no-booth = 2 件（无号）', titlesOf((await callAssets({ filter: 'no-booth' })).payload), ['Mew Hair', 'plain pack']);
  const noCover = await callAssets({ filter: 'no-cover' });
  eq('no-cover = 3 件', titlesOf(noCover.payload), ['Astraea', 'plain pack', 'Witch Costume']);
  check('no-cover 与 withCover 同一口径（allCount - withCover === no-cover 总数）',
    noCover.payload.allCount - noCover.payload.withCover === noCover.payload.total,
    JSON.stringify({ all: noCover.payload.allCount, withCover: noCover.payload.withCover, noCover: noCover.payload.total }));
  check('只有 coverUrl 的卡算「有封面」（不进 no-cover）',
    !titlesOf(noCover.payload).includes('Endless Comfort'), titlesOf(noCover.payload).join(','));
  eq('suggested = 1 件（批量给过建议）', titlesOf((await callAssets({ filter: 'suggested' })).payload), ['Zeta']);
  check('suggested 卡带上建议号', (await callAssets({ filter: 'suggested' })).payload.assets[0]?.suggestion?.boothId === '333333');
  eq('bound = 1 件（人工绑定）', titlesOf((await callAssets({ filter: 'bound' })).payload), ['Witch Costume']);
  eq('filter=all 等价默认', (await callAssets({ filter: 'all' })).payload.count, 6);
  eq('未知 filter 回落 all（不 500、不空表）', (await callAssets({ filter: 'bogus' })).payload.count, 6);
  const filtered = await callAssets({ filter: 'no-booth' });
  eq('筛选后 total 是筛选后的总数（不是全库）', [filtered.payload.total, filtered.payload.allCount], [2, 6]);
}

console.log('## sort 三种');
{
  const recent = await callAssets({ sort: 'recent' });
  eq('recent 保持扫盘顺序', titlesOf(recent.payload), ['Mew Hair', 'Astraea', 'Endless Comfort', 'plain pack', 'Witch Costume', 'Zeta']);
  const byTitle = titlesOf((await callAssets({ sort: 'title' })).payload);
  check('title 排序第一件是 Astraea', byTitle[0] === 'Astraea', byTitle.join(' | '));
  check('title 排序逐项非降（按 zh-Hans-CN）',
    byTitle.every((t, i) => i === 0 || byTitle[i - 1].localeCompare(t, 'zh-Hans-CN') <= 0), byTitle.join(' | '));
  const byBooth = (await callAssets({ sort: 'booth' })).payload.assets;
  check('booth 排序前 4 件都有号', byBooth.slice(0, 4).every((a) => /^\d{5,9}$/.test(String(a.boothId))), byBooth.map((a) => a.boothId || '-').join(','));
  check('booth 排序后 2 件无号', byBooth.slice(4).every((a) => !a.boothId), byBooth.map((a) => a.boothId || '-').join(','));
  eq('未知 sort 回落 recent', titlesOf((await callAssets({ sort: 'bogus' })).payload), titlesOf(recent.payload));
}

console.log('## offset / limit / truncated');
{
  const p1 = (await callAssets({ limit: '2' })).payload;
  eq('limit=2 返回前两件', titlesOf(p1), ['Mew Hair', 'Astraea']);
  eq('limit=2 时 count=2 / total=6 / truncated=true', [p1.count, p1.total, p1.truncated], [2, 6, true]);
  const p2 = (await callAssets({ offset: '4', limit: '2' })).payload;
  eq('offset=4&limit=2 返回最后两件', titlesOf(p2), ['Witch Costume', 'Zeta']);
  eq('翻到末页不再 truncated', [p2.offset, p2.truncated], [4, false]);
  const p3 = (await callAssets({ offset: '10' })).payload;
  eq('offset 超出总数 → 空表但 total 仍是 6', [p3.count, p3.total], [0, 6]);
  eq('limit 超过上限被夹到 500', (await callAssets({ limit: '9999' })).payload.limit, 500);
  eq('limit 非法回落默认 500', (await callAssets({ limit: 'abc' })).payload.limit, 500);
  eq('offset 负数回落 0', (await callAssets({ offset: '-3' })).payload.offset, 0);
  const combo = (await callAssets({ filter: 'no-cover', sort: 'title', limit: '1', offset: '1' })).payload;
  eq('筛选 + 排序 + 分页可以组合', [combo.count, combo.total, combo.limit, combo.offset], [1, 3, 1, 1]);
}

console.log('## 纯函数边界（pickAssetsPage）');
{
  eq('非数组输入不崩', pickAssetsPage(null).assets, []);
  eq('undefined 参数不崩', pickAssetsPage(undefined, undefined).total, 0);
  eq('空对象参数用默认值', [pickAssetsPage(sampleAssets(), {}).limit, pickAssetsPage(sampleAssets(), {}).offset], [500, 0]);
  eq('q 两边空格会被 trim', pickAssetsPage(sampleAssets(), { q: '  zeta  ' }).total, 1);
  eq('limit=0 也至少给 1 条（不能用 0 骗出空表）', pickAssetsPage(sampleAssets(), { limit: 0 }).assets.length, 1);
  eq('offset=1.9 向下取整', pickAssetsPage(sampleAssets(), { offset: 1.9 }).offset, 1);
  check('truncated 是「还有下一页」而不是「超了上限」',
    pickAssetsPage(sampleAssets(), { limit: 3 }).truncated === true
    && pickAssetsPage(sampleAssets(), { limit: 3, offset: 3 }).truncated === false);
}

console.log('## 分页参数的小数与下限（验收回归：offset=1.9&limit=0.5 不能返回空页）');
{
  const small = (await callAssets({ offset: '1.9', limit: '0.5' })).payload;
  eq('limit=0.5 → 至少 1 条（以前 floor 成 0 返回空页）', [small.limit, small.count], [1, 1]);
  eq('offset=1.9 → 向下取整 1', small.offset, 1);
  eq('limit=0.5 时 total 仍是筛选后总数', small.total, 6);
  const neg = (await callAssets({ offset: '-3', limit: '-2' })).payload;
  eq('offset 负数 → 0', neg.offset, 0);
  eq('limit 负数 → 至少 1 条', [neg.limit, neg.count], [1, 1]);
  eq('limit=abc → 回落默认 500', (await callAssets({ limit: 'abc' })).payload.limit, 500);
  eq('offset=abc → 回落 0', (await callAssets({ offset: 'abc' })).payload.offset, 0);
  eq('limit 超上限仍夹 500', (await callAssets({ limit: '99999' })).payload.limit, 500);
}

console.log('## 回显筛选参数（前端据此确认后端真的筛了，不会退回本地过滤）');
{
  const echoed = (await callAssets({ q: 'MEW', filter: 'no-booth', sort: 'title' })).payload;
  eq('q 原样回显（大小写不动、只 trim）', echoed.q, 'MEW');
  eq('filter 回显归一化后的值', echoed.filter, 'no-booth');
  eq('sort 回显归一化后的值', echoed.sort, 'title');
  const bogus = (await callAssets({ filter: 'nope', sort: 'nope' })).payload;
  eq('非法 filter/sort 回显回落值', [bogus.filter, bogus.sort], ['all', 'recent']);
  const blank = (await callAssets({ q: '   ' })).payload;
  eq('空白 q 回显空串（不是空格）', blank.q, '');
}

console.log('## counts：五档计数基于全库，不基于本页');
{
  const p = (await callAssets({ limit: '1' })).payload;
  check('响应带 counts 五个档位', p.counts && ['all', 'noBooth', 'noCover', 'suggested', 'bound'].every((k) => Number.isInteger(p.counts[k])),
    JSON.stringify(p.counts));
  eq('counts.all === allCount（全库 6 件，不是本页 1 件）', p.counts.all, p.allCount);
  // withBooth 必须先应用绑定再重算：假扫盘给的是扫盘旧值 3，绑一条后应为 4。
  eq('withBooth 已重算（含人工绑定补的号：3 → 4）', p.withBooth, 4);
  eq('counts.noBooth === allCount - withBooth', p.counts.noBooth, p.allCount - p.withBooth);
  eq('counts.noCover === allCount - withCover（与页面统计同口径）', p.counts.noCover, p.allCount - p.withCover);
  // 注意：`filter=suggested` 是老的「批量找号建议」口径（asset.suggestion），
  // 和认号视图的 suggested（candidate + bindSuggestions）不是一回事；
  // counts.suggested 按 lead 2026-10-30 的口径对齐 view=suggested。
  eq('counts.suggested 与 view=suggested 同源',
    (await callAssets({ view: 'suggested' })).payload.total, p.counts.suggested);
  eq('counts.bound 与 filter=bound 一致',
    (await callAssets({ filter: 'bound' })).payload.total, (await callAssets({})).payload.counts.bound);
  check('五档之和可以大于 all（允许重叠，不能相加当总数）', p.counts.noBooth + p.counts.noCover + p.counts.suggested + p.counts.bound >= p.counts.all,
    JSON.stringify(p.counts));
  const filtered = (await callAssets({ filter: 'no-cover', limit: '1' })).payload;
  eq('筛选后 counts 不变（仍是全库口径）', filtered.counts, p.counts);
}

console.log('## 认号可信度：verified 才显示商品名/封面，counts 与 view 同源（2026-10-30）');
{
  const p = (await callAssets()).payload;
  const cards = p.assets || [];
  const verified = cards.filter((a) => a.boothStatus === 'verified');
  check('每件卡带 boothStatus 三态之一',
    cards.every((a) => ['verified', 'candidate', 'none'].includes(a.boothStatus)),
    JSON.stringify(cards.map((a) => [a.key, a.boothStatus])));
  eq('counts.withBooth 等于 verified 件数', p.counts.withBooth, verified.length);
  eq('bindStats 三段之和 = allCount', p.bindStats.verified + p.bindStats.candidate + p.bindStats.none, p.allCount);
  check('verified 件显示台账标题（不是目录名猜的号）',
    (p.assets.find((a) => a.key === 'g/c/endless') || {}).displayTitle === 'Endless Comfort',
    JSON.stringify(p.assets.find((a) => a.key === 'g/c/endless')?.displayTitle));
  const plainLocked = p.assets.find((a) => a.key === 'g/d/plain') || {};
  check('没号的件不会凭空显示商品名（displayTitle 用洗过的文件名）',
    plainLocked.boothStatus === 'none' && plainLocked.displayTitle === 'plain',
    JSON.stringify({ status: plainLocked.boothStatus, title: plainLocked.displayTitle }));
  eq('view=with-booth 与 counts.withBooth 同源',
    (await callAssets({ view: 'with-booth' })).payload.total, p.counts.withBooth);
  eq('view=no-booth 与 counts.noBooth 同源',
    (await callAssets({ view: 'no-booth' })).payload.total, p.counts.noBooth);
  // 2026-10-30 lead 真机：counts.suggested 恒 0，而实际 candidate 带建议的有 16 件。
  // 现在服务端按「candidate 且有 bindSuggestions」算，且必须和 view=suggested 的 total 同源。
  const candidateCards = cards.filter((a) => a.boothStatus === 'candidate' && (a.bindSuggestions || []).length > 0);
  eq('counts.suggested 等于「有候选的 candidate」件数', p.counts.suggested, candidateCards.length);
  eq('view=suggested 与 counts.suggested 同源',
    (await callAssets({ view: 'suggested' })).payload.total, p.counts.suggested);
  eq('counts.candidate 等于 candidate 总数', p.counts.candidate, cards.filter((a) => a.boothStatus === 'candidate').length);
  eq('counts.verified 等于 withBooth', p.counts.verified, p.counts.withBooth);
  eq('withDhash 与列表里真有 dhash 的卡数一致', p.withDhash, cards.filter((a) => Boolean(a.dhash)).length);
}

console.log('## 改过名的素材：renamed 标记 + 标题保住带号前缀');
{
  // 改名会换 contentKey：日志里 key 是旧的、newKey 才是卡片现在的 key。
  // 前端靠 renamed 显示 chip；标题不能把「8844481 」这种前导号剥掉，否则用户认不出是哪件。
  fs.writeFileSync(path.join(tmp, 'booth-renames.json'), JSON.stringify({
    version: 1,
    entries: {
      'g/c/hair-old': [{
        at: 1700000000000,
        key: 'g/c/hair-old',
        newKey: 'g/c/hair',
        from: { dir: 'g/c/hair-old', mainName: 'Mew Hair.zip' },
        to: { dir: 'g/c/8844481 Test Rename', mainName: '8844481 Test Rename.zip' },
        moves: [{ from: 'g/c/hair-old/Mew Hair.zip', to: 'g/c/8844481 Test Rename/8844481 Test Rename.zip' }]
      }]
    }
  }));
  const payload = (await callAssets({})).payload;
  const hair = payload.assets.find((asset) => asset.key === 'g/c/hair');
  check('改名过的素材带 renamed:true', hair?.renamed === true, JSON.stringify(hair));
  eq('标题保住完整名（不剥前导号）', hair?.title, '8844481 Test Rename');
  eq('响应带 renamed 计数', payload.renamed, 1);
  const others = payload.assets.filter((asset) => asset.key !== 'g/c/hair');
  check('没改名的不受影响', others.every((asset) => !asset.renamed));
  fs.rmSync(path.join(tmp, 'booth-renames.json'));
}

try { console.log('## 合并卡的 files 是数字、不影响封面筛选口径');
{
  fs.writeFileSync(path.join(tmp, 'booth-merges.json'), JSON.stringify({
    version: 1,
    groups: { 'm-271777': { boothId: '271777', primaryKey: 'g/c/astro', keys: ['g/c/astro', 'g/d/plain'], at: 1 } }
  }));
  const payload = (await callAssets()).payload;
  const merged = (payload.assets || []).find((a) => a.mergeId === 'm-271777');
  check('合并卡存在', Boolean(merged), JSON.stringify(payload.assets?.map((a) => a.key)));
  eq('合并卡 files 是数字且求和（2+3）', merged?.files, 5);
  eq('合并卡带 mergedMembers（主成员第一）', (merged?.mergedMembers || []).map((m) => m.key), ['g/c/astro', 'g/d/plain']);
  eq('合并后总数少一件', payload.allCount, 5);
  // 两件成员都没封面 → 合成卡也不该算「有封面」：全库 5 件 - 有封面 3 件 = 2 件无封面。
  eq('no-cover 口径不受 files 类型影响（5 - 3 = 2）', (await callAssets({ filter: 'no-cover' })).payload.counts.noCover, 2);
  eq('withCover 仍是 3', payload.withCover, 3);
  check('两口径仍然自洽（allCount - withCover === noCover）',
    payload.allCount - payload.withCover === (await callAssets({ filter: 'no-cover' })).payload.counts.noCover);
  check('合并卡以 thumbRel/coverUrl 判封面（不是 files）',
    Boolean(merged?.thumbRel) === false && Boolean(merged?.coverUrl) === false, JSON.stringify({ thumb: merged?.thumbRel, cover: merged?.coverUrl }));
  // 仪表盘「文件库」卡曾经读 summary.assets（扫盘那一步、合并前的数），合并后写 23 件点进去 17 件。
  check('嵌套 summary.assets 不含合并折叠前的数（有该字段时必须是最终件数）',
    !payload.summary || payload.summary.assets === 5, JSON.stringify(payload.summary || null));
  // 清理，避免影响后续（无）
  fs.rmSync(path.join(tmp, 'booth-merges.json'), { force: true });
}

try { console.log('## 解压码 / RJ 号 / 类型标签 / 来源（m03790）');
{
  currentAssets = tagAssets;
  const payload = (await callAssets()).payload;
  const card = (key) => (payload.assets || []).find((a) => a.key === key);

  check('每件卡都带 archivePassword/rjCode/tags/source/sourceText（不是 undefined）',
    (payload.assets || []).every((a) => typeof a.archivePassword === 'string'
      && typeof a.rjCode === 'string'
      && Array.isArray(a.tags)
      && typeof a.source === 'string'
      && typeof a.sourceText === 'string'),
    JSON.stringify((payload.assets || []).map((a) => ({ key: a.key, tags: a.tags, source: a.source }))));
  eq('解压码落到卡片（pass-7788 → 7788）', card('g/c/endless')?.archivePassword, '7788');
  eq('RJ 号落到卡片', card('g/c/hair')?.rjCode, 'RJ123456');
  eq('类型标签落到卡片（最多 8 个）', card('g/d/zzz')?.tags, ['语音']);
  eq('没信息的卡是空字符串/空数组，不是 undefined', [card('g/d/plain')?.archivePassword, card('g/d/plain')?.tags], ['', []]);

  eq('来源：BaiduNetdisk → baidu/网盘', [card('g/c/hair')?.source, card('g/c/hair')?.sourceText], ['baidu', '网盘']);
  eq('来源：百度网盘 中文目录也算网盘', card('g/d/witch')?.source, 'baidu');
  eq('来源：转存 → transfer/转存', [card('g/c/endless')?.source, card('g/c/endless')?.sourceText], ['transfer', '转存']);
  eq('来源：_未分类 → unfiled/未分类', [card('g/d/plain')?.source, card('g/d/plain')?.sourceText], ['unfiled', '未分类']);
  eq('来源：认不出 → unknown/未知', [card('g/d/astro')?.source, card('g/d/astro')?.sourceText], ['unknown', '未知']);

  eq('统计 withTags = 5 件（有码或 RJ 或标签）', payload.withTags, 5);
  eq('统计 passwords = 2 件', payload.passwords, 2);
  eq('统计 rjCount = 2 件', payload.rjCount, 2);

  eq('filter=with-password 命中 2 件', titlesOf((await callAssets({ filter: 'with-password' })).payload), ['Endless Comfort', 'Astraea']);
  eq('filter=rj 命中 2 件', (await callAssets({ filter: 'rj' })).payload.total, 2);
  eq('filter=source:baidu 命中 2 件', (await callAssets({ filter: 'source:baidu' })).payload.total, 2);
  eq('filter=source:transfer 命中 2 件', (await callAssets({ filter: 'source:transfer' })).payload.total, 2);
  eq('filter=source:unfiled 命中 1 件', titlesOf((await callAssets({ filter: 'source:unfiled' })).payload), ['plain pack']);
  eq('回显 filter 保持原字符串', (await callAssets({ filter: 'source:baidu' })).payload.filter, 'source:baidu');
  eq('非法 source 值回落 all', (await callAssets({ filter: 'source:unknown' })).payload.filter, 'all');
  eq('未知 filter 仍回落 all（新档不破坏旧语义）', (await callAssets({ filter: 'bogus' })).payload.count, 6);

  eq('q 搜解压码能命中（搜 7788，命中带这个码的那件）', titlesOf((await callAssets({ q: '7788' })).payload), ['Endless Comfort']);
  eq('q 搜 RJ 号能命中', titlesOf((await callAssets({ q: 'rj999999' })).payload), ['Witch Costume']);
  eq('q 搜类型标签能命中', titlesOf((await callAssets({ q: '语音' })).payload), ['Zeta']);
  eq('q 大小写不敏感仍成立', (await callAssets({ q: 'RJ123456' })).payload.total, 1);

  currentAssets = sampleAssets;
}

console.log('## Pro 界面新参数：分类 / 店铺 / 标签 / 适配模型 / 仅图片 / 收藏 / 已购 / 新排序');
{
  // BOOTH 资料走真实缓存路径（`<cacheDir>/<id>.json` 里的 meta.status==='ok'）：
  // 卡片的 meta 是 enrichAssetsWithBoothMeta 从缓存填的，直接写在 sampleAssets 里会被覆盖。
  fs.writeFileSync(path.join(cacheDir, '271777.json'), JSON.stringify({ fetchedAt: 1, meta: { status: 'ok', title: 'Astraea', shop: 'AstroShop', category: 'アバター' } }));
  fs.writeFileSync(path.join(cacheDir, '222222.json'), JSON.stringify({ fetchedAt: 1, meta: { status: 'ok', title: 'Zeta', shop: 'ZetaShop' } }));
  // 关系型状态：收藏一条、已购一个号、使用统计一条（都走真实读文件的路径）。
  fs.writeFileSync(path.join(tmp, 'booth-favorites.json'), JSON.stringify({ version: 1, entries: { 'g/c/hair': { at: 1 } } }));
  fs.writeFileSync(path.join(tmp, 'booth-purchases.json'), JSON.stringify({ version: 1, items: { '271777': { boothId: '271777', title: 'Astraea' } } }));
  fs.writeFileSync(path.join(tmp, 'booth-usage.json'), JSON.stringify({ usage: { 'g/d/zzz': { projects: [{ at: 5 }, { at: 9 }], lastScanAt: 0 } } }));

  const all = (await callAssets()).payload;
  const card = (key) => (all.assets || []).find((a) => a.key === key);
  check('每张卡都带 category / categoryFrom / modelCount / modelBucket / favorite / purchase',
    (all.assets || []).every((a) => typeof a.category === 'string' && typeof a.categoryFrom === 'string'
      && (a.modelCount === null || typeof a.modelCount === 'number')
      && typeof a.modelBucket === 'string'
      && typeof a.favorite === 'boolean'
      && typeof a.purchase === 'string'
      && typeof a.usageCount === 'number'
      && typeof a.lastUsedAt === 'number'),
    JSON.stringify((all.assets || []).slice(0, 2).map((a) => ({ k: a.key, c: a.category, m: a.modelCount, f: a.favorite }))));
  eq('category 结论：发型 / 模型 / 未分类', [card('g/c/hair')?.category, card('g/c/astro')?.category, card('g/d/plain')?.category], ['发型', '模型', '未分类']);
  eq('categoryFrom 标明来源：meta 优先', [card('g/c/astro')?.categoryFrom, card('g/c/hair')?.categoryFrom], ['meta', 'rule']);
  // 这批样本科目名字里没有「N アバター」，BOOTH 缓存也不带 models → 全部未标注（规则层别的分支在 test-library-category 里测）。
  eq('没有数量信息 → null + unlabeled', [card('g/c/astro')?.modelCount, card('g/c/astro')?.modelBucket], [null, 'unlabeled']);
  eq('收藏命中：favorite=true', card('g/c/hair')?.favorite, true);
  eq('未收藏 → false', card('g/d/plain')?.favorite, false);
  eq('已购命中：purchase=purchased', card('g/c/astro')?.purchase, 'purchased');
  eq('未买 → 空串', card('g/c/hair')?.purchase, '');
  eq('使用统计：次数与最后使用时间', [card('g/d/zzz')?.usageCount, card('g/d/zzz')?.lastUsedAt], [2, 9]);

  eq('category=发型 命中 1 件', titlesOf((await callAssets({ category: '发型' })).payload), ['Mew Hair']);
  eq('category 名称写法（别名）也认：衣装→服装', titlesOf((await callAssets({ category: '衣装' })).payload), ['Witch Costume']);
  eq('category=unclassified 命中 3 件', (await callAssets({ category: 'unclassified' })).payload.total, 3);
  eq('category=未分类 与 unclassified 等价', (await callAssets({ category: '未分类' })).payload.total, 3);
  eq('category 回显归一化后的值', (await callAssets({ category: 'unclassified' })).payload.category, '未分类');
  eq('shop=AstroShop 精确命中 1 件（资料来自 BOOTH 缓存）', titlesOf((await callAssets({ shop: 'AstroShop' })).payload), ['Astraea']);
  eq('shop 空值不筛选', (await callAssets({ shop: '  ' })).payload.total, 6);
  eq('tag=发饰 命中 1 件', titlesOf((await callAssets({ tag: '发饰' })).payload), ['Mew Hair']);
  eq('tag 大小写不敏感（英文标签也能中）', (await callAssets({ tag: ' 发饰 ' })).payload.total, 1);
  eq('tag 不存在的标签 → 0 件', (await callAssets({ tag: '没有这个标签' })).payload.total, 0);
  eq('model=unlabeled 命中全部 6 件（这批都没标注数量）', (await callAssets({ model: 'unlabeled' })).payload.total, 6);
  eq('model=2-3 命中 0 件（没有标数量的卡）', (await callAssets({ model: '2-3' })).payload.total, 0);
  eq('非法 model 桶回落「全部」', (await callAssets({ model: '9' })).payload.total, 6);
  eq('kind=image 只留主件是图片的卡（plain.png）', titlesOf((await callAssets({ kind: 'image' })).payload), ['plain pack']);
  eq('非法 kind 回落全部', (await callAssets({ kind: 'bogus' })).payload.total, 6);
  const favPage = (await callAssets({ fav: '1' })).payload;
  eq('fav=1 命中收藏的 1 件', titlesOf(favPage), ['Mew Hair']);
  eq('fav 回显 true', favPage.fav, true);
  eq('purchase=purchased 命中已购 1 件', titlesOf((await callAssets({ purchase: 'purchased' })).payload), ['Astraea']);
  eq('purchase 回显归一化值', (await callAssets({ purchase: 'purchased' })).payload.purchase, 'purchased');

  const byBytes = (await callAssets({ sort: 'bytes' })).payload.assets;
  check('bytes 排序按体积降序', byBytes.every((a, i) => i === 0 || (Number(byBytes[i - 1].bytes) || 0) >= (Number(a.bytes) || 0)),
    byBytes.map((a) => a.bytes).join(','));
  eq('use 排序把使用过的排前面', titlesOf((await callAssets({ sort: 'use' })).payload)[0], 'Zeta');
  eq('lastUsed 排序把最近用过的排前面', titlesOf((await callAssets({ sort: 'lastUsed' })).payload)[0], 'Zeta');

  // counts 与 facets 一样要能反映「未分类/重复号」这两档（旧实现没有）。
  eq('counts 含 unclassified=3', all.counts?.unclassified, 3);
  eq('counts 含 duplicated=0（这组样本没有重复号）', all.counts?.duplicated, 0);
  eq('annotationStats：收藏 1 / 已购 1 / 用过 1 / 重复号 0', all.annotationStats, { favorites: 1, purchased: 1, free: 0, usageHits: 1, duplicated: 0 });
  check('favorites 汇总字段随响应下发', all.favorites === 1, String(all.favorites));

  const combo = (await callAssets({ category: 'unclassified', sort: 'title', limit: '2' })).payload;
  eq('分类 + 排序 + 分页组合：total 3 / 本页 2 / truncated', [combo.total, combo.count, combo.truncated], [3, 2, true]);

  // 收尾：把关系型状态文件删掉，别影响后面「访客只读」那段的默认视图。
  fs.rmSync(path.join(tmp, 'booth-purchases.json'), { force: true });
  fs.rmSync(path.join(tmp, 'booth-usage.json'), { force: true });
}

console.log('## 访客只读：扫盘根绝对路径必须被抹掉');
{
  const guestReq = makeReq({ fresh: '1' });
  guestReq.consoleRole = 'guest';
  const handled = await view.handleLibraryAssetsRoute(guestReq);
  const guestPayload = guestReq.getSent()?.payload || {};
  check('路由仍由本模块处理', handled === true);
  check('访客响应 root === null（不泄露扫盘根绝对路径）', guestPayload.root === null, `实际 ${JSON.stringify(guestPayload.root)}`);
  check('访客其余字段照旧（卡片列表给得出来）', guestPayload.ok === true && Array.isArray(guestPayload.assets) && guestPayload.assets.length === 6);
  check('访客卡片只带相对路径', guestPayload.assets.every((a) => !path.isAbsolute(String(a.dir || '')) && !path.isAbsolute(String(a.mainName || ''))));

  const adminReq = makeReq({ fresh: '1' });
  await view.handleLibraryAssetsRoute(adminReq);
  const adminPayload = adminReq.getSent()?.payload || {};
  check('管理员响应 root 仍是扫盘根（功能没被削）', adminPayload.root === libDir, `实际 ${JSON.stringify(adminPayload.root)}`);

  // 读不存在的封面：错误文本不能带本机绝对路径（真机在 /api/files/raw 上泄漏过 stat 'E:\…'）。
  // deps.fs 这里是真 fs，ENOENT 原话里就带 libDir 绝对路径，正好用来验证脱敏是否真的生效。
  const rawReq = (role) => {
    const req = makeReq();
    req.consoleRole = role;
    req.url = { pathname: '/api/files/raw', searchParams: new URLSearchParams({ rel: '__missing_cover__.png' }) };
    req.res = { writeHead() {}, end() {} };
    req.SECURITY_HEADERS = {};
    return req;
  };
  const rawGuest = rawReq('guest');
  await view.handleLibraryAssetsRoute(rawGuest);
  const rawGuestSent = rawGuest.getSent() || {};
  check('访客读不存在的封面：404 且只说「路径不存在」',
    rawGuestSent.code === 404 && rawGuestSent.payload?.error === '路径不存在',
    `HTTP ${rawGuestSent.code} / ${JSON.stringify(rawGuestSent.payload?.error)}`);
  const rawAdmin = rawReq('admin');
  await view.handleLibraryAssetsRoute(rawAdmin);
  const rawAdminErr = String(rawAdmin.getSent()?.payload?.error || '');
  check('管理员读不存在的封面：给相对路径定位，但不含盘符',
    rawAdminErr === '路径不存在：__missing_cover__.png', rawAdminErr);
}
} catch { /* 这里失败只影响断言，不影响临时目录清理 */ }

console.log('\n## v2 视图：view 与 filter 正交（cloud/trash 是台账驱动，其余筛素材数组）');
{
  const all = await callAssets({});
  const allCount = all.payload.allCount;
  const cards = all.payload.assets;
  // 「已认号」= verified（已购台账/人工绑定），不是「卡片上有号」：名字里猜出来的号不算（2026-10-30 起）。
  const expectedWithBooth = cards.filter((a) => (a.boothStatus ? a.boothStatus === 'verified' : /^\d{5,9}$/.test(String(a.boothId || '')))).length;
  const expectedWithCover = cards.filter((a) => Boolean(a.thumbRel) || Boolean(a.coverUrl)).length;

  const withBooth = await callAssets({ view: 'with-booth' });
  const noBooth = await callAssets({ view: 'no-booth' });
  eq('with-booth + no-booth = allCount', withBooth.payload.total + noBooth.payload.total, allCount);
  eq('with-booth 命中数', withBooth.payload.total, expectedWithBooth);
  eq('no-booth 命中数', noBooth.payload.total, allCount - expectedWithBooth);

  const withCover = await callAssets({ view: 'with-cover' });
  const noCover = await callAssets({ view: 'no-cover' });
  eq('with-cover + no-cover = allCount', withCover.payload.total + noCover.payload.total, allCount);
  eq('with-cover 命中数', withCover.payload.total, expectedWithCover);

  const favView = await callAssets({ view: 'favorite' });
  const suggView = await callAssets({ view: 'suggested' });
  eq('favorite 视图条数 = annotationStats.favorites', favView.payload.total, all.payload.annotationStats.favorites);
  // 「待确认认号」视图现在按 candidate + bindSuggestions 算（与 counts.suggested 同一谓词）；
  // 老夹具里那条批量找号建议（asset.suggestion）不再计入这个视图。
  const expectedSuggested = cards.filter((a) => a.boothStatus === 'candidate' && (a.bindSuggestions || []).length > 0).length;
  eq('suggested 视图条数 = 有候选的 candidate 卡片数', suggView.payload.total, expectedSuggested);

  eq('视图回显', [withBooth.payload.view, favView.payload.view], ['with-booth', 'favorite']);
  const bogus = await callAssets({ view: 'banana' });
  eq('非法 view 回落 all', [bogus.payload.view, bogus.payload.total], ['all', allCount]);
  const ortho = await callAssets({ view: 'with-cover', filter: 'no-cover' });
  eq('view 与 filter 正交：with-cover ∩ no-cover = 0', ortho.payload.total, 0);
  const combo = await callAssets({ view: 'no-booth', q: '' });
  eq('view 可与分页组合：limit=1 时 count=1', (await callAssets({ view: 'with-booth', limit: '1' })).payload.count, 1);
  eq('view 不改变 allCount（全库件数）', [combo.payload.allCount, withBooth.payload.allCount], [allCount, allCount]);
}

console.log('\n## v2 cloud 视图：已购台账里没下载的条目（条数口径 = 台账剩余）');
{
  // 271777 已在库（要排掉）；999999 / 888888 没下载过（cloud 里应该都在）。
  fs.writeFileSync(path.join(tmp, 'booth-purchases.json'), JSON.stringify({
    version: 1,
    items: {
      271777: { boothId: '271777', title: 'Astro (already in library)', shopName: 'AstroShop', coverUrl: 'https://img.example/271777.jpg', addedAt: 3 },
      999999: { boothId: '999999', title: 'Cloud Only', shopName: 'CloudShop', priceText: '¥500', coverUrl: 'https://img.example/999999.jpg', itemUrl: 'https://booth.pm/ja/items/999999', addedAt: 2 },
      888888: { boothId: '888888', title: 'Another Cloud', shopName: 'OtherShop', addedAt: 1 }
    }
  }));
  const cloud = await callAssets({ view: 'cloud' });
  eq('cloud 排除已在库的号', cloud.payload.items.map((c) => c.boothId).sort(), ['888888', '999999']);
  eq('cloud item key 用 purchase: 前缀', cloud.payload.items.some((c) => c.key === 'purchase:999999'), true);
  eq('cloud 响应键与素材页对齐', ['ok', 'view', 'items', 'count', 'total', 'allCount', 'offset', 'limit', 'truncated'].every((k) => k in cloud.payload), true);
  eq('cloud 回显 view', cloud.payload.view, 'cloud');
  eq('cloud 卡片字段（source/downloaded/files）', (() => {
    const card = cloud.payload.items.find((c) => c.boothId === '999999');
    return [card.source, card.downloaded, card.files, card.bytes];
  })(), ['purchase', false, 0, 0]);
  const cloudQ = await callAssets({ view: 'cloud', q: 'cloudshop' });
  eq('cloud 支持 q（店铺名）', cloudQ.payload.items.map((c) => c.boothId), ['999999']);
  const cloudPage = await callAssets({ view: 'cloud', limit: '1' });
  eq('cloud 支持分页与 truncated', [cloudPage.payload.count, cloudPage.payload.total, cloudPage.payload.truncated], [1, 2, true]);
  const cloudSort = await callAssets({ view: 'cloud', sort: 'title' });
  eq('cloud 支持 title 排序', cloudSort.payload.items.map((c) => c.title), ['Another Cloud', 'Cloud Only']);
}

console.log('\n## v2 trash 视图：回收站台账 → 同构卡片');
{
  fs.writeFileSync(path.join(tmp, 'booth-trash.json'), JSON.stringify({
    v: 1,
    items: [
      { id: 'tr-9', key: 'g/c/gone', title: 'Gone Thing', boothId: '123456', bytes: 4096, files: 3, at: 9, movedTo: 'state/trash/tr-9', fromDirs: ['g/c'] }
    ]
  }));
  const trash = await callAssets({ view: 'trash' });
  eq('trash 列出回收站条目（key = 记录 id）', trash.payload.items.map((t) => t.key), ['tr-9']);
  eq('trash 回显 view 与 total', [trash.payload.view, trash.payload.total], ['trash', 1]);
  eq('trash 卡片标记 inTrash', trash.payload.items[0].inTrash, true);
  fs.rmSync(path.join(tmp, 'booth-purchases.json'), { force: true });
  fs.rmSync(path.join(tmp, 'booth-trash.json'), { force: true });
}

console.log('\n## filter=extracted / filter=duplicated 与 counts 同源');
{
  // extracted：只留「有解压产物」的父件（extracted.count>0），total 随 filter 收窄。
  currentAssets = () => [
    { key: 'g/e/parent', title: 'Ext Pack', dir: 'g/e', mainName: 'Ext.zip', boothId: '', boothSource: '', thumbRel: '', bytes: 100 },
    { key: 'g/e/parent/x.png', title: 'x.png', dir: 'g/e/Ext', mainName: 'x.png', boothId: '', boothSource: '', thumbRel: '', bytes: 10 },
    { key: 'g/f/other', title: 'Other', dir: 'g/f', mainName: 'Other.zip', boothId: '', boothSource: '', thumbRel: '', bytes: 20 }
  ];
  const extracted = await callAssets({ filter: 'extracted' });
  eq('filter=extracted 只留父件', extracted.payload.assets.map((a) => a.key), ['g/e/parent']);
  eq('filter=extracted 的 total 与 counts.extracted 一致', [extracted.payload.total, extracted.payload.counts.extracted], [1, 1]);
  eq('filter=extracted 回显 filter', extracted.payload.filter, 'extracted');

  // duplicated：同一份分组结果既算 counts.duplicated 也筛 filter，一组 3 张卡两个数都必须是 3。
  currentAssets = () => [
    { key: 'g/h/dup1', title: 'Dup A', dir: 'g/h', mainName: 'Same.zip', mainBytes: 400, boothId: '', boothSource: '', thumbRel: '', bytes: 400 },
    { key: 'g/h/dup2', title: 'Dup B', dir: 'g/h', mainName: 'Same.zip', mainBytes: 400, boothId: '', boothSource: '', thumbRel: '', bytes: 400 },
    { key: 'g/h/dup3', title: 'Dup C', dir: 'g/h', mainName: 'Same (1).zip', mainBytes: 400, boothId: '', boothSource: '', thumbRel: '', bytes: 400 },
    { key: 'g/h/solo', title: 'Solo', dir: 'g/h', mainName: 'Solo.zip', mainBytes: 77, boothId: '', boothSource: '', thumbRel: '', bytes: 77 }
  ];
  const dup = await callAssets({ filter: 'duplicated' });
  eq('filter=duplicated 筛出组内 3 张卡', dup.payload.assets.map((a) => a.key).sort(), ['g/h/dup1', 'g/h/dup2', 'g/h/dup3']);
  eq('filter=duplicated 的 total 与 counts.duplicated 一致', [dup.payload.total, dup.payload.counts.duplicated], [3, 3]);
  currentAssets = sampleAssets;
}

fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响断言 */ }
console.log(`\n${failures.length ? '❌' : '🎉'} test-library-assets-filter：通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  console.error('失败项：' + failures.join('；'));
  process.exit(1);
}
