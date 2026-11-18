// BOOTH 搜索页解析 + 候选排序（P3 找号主链的纯函数）单测。
// fixture：scripts/fixtures/booth-search-mew.html，2026-10-29 从
// https://booth.pm/ja/search/VRChat%20Mew 的真实响应里截的前 4 个 item-card（含总数与 rel=next）。
import fs from 'node:fs';
import path from 'node:path';
import {
  parseBoothSearchHtml, buildBoothSearchUrl, decodeEntities, stripTags,
  normalizeTitle, titleTokens, osaDistance, titleSimilarity,
  coverDistance, coverMatch, searchPhrasesFor, rankBoothCandidates, proposeBinding,
  BOOTH_SEARCH_MAX_PAGES, BOOTH_COVER_HAMMING_MAX
} from '../src/booth-search.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const FIXTURE = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/booth-search-mew.html'), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, name) => { if (cond) { pass += 1; } else { fails.push(name); console.log(`  ✗ ${name}`); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
const near = (a, b, eps, name) => ok(Math.abs(a - b) <= eps, `${name}（期望 ${b}±${eps}，实际 ${a}）`);

// ── 1. 搜索地址 ────────────────────────────────────────────────────────
eq(buildBoothSearchUrl({ query: 'VRChat Mew' }), 'https://booth.pm/ja/search/VRChat%20Mew', '搜索地址：空格编码成 %20');
eq(buildBoothSearchUrl({ query: 'VRChat Mew', page: 2 }), 'https://booth.pm/ja/search/VRChat%20Mew?page=2', '搜索地址：翻页加 ?page=');
eq(buildBoothSearchUrl({ query: 'あ', page: 0 }), 'https://booth.pm/ja/search/%E3%81%82', '页码 0 归到第 1 页');
eq(buildBoothSearchUrl({ query: 'a', page: 999 }), 'https://booth.pm/ja/search/a?page=50', '页码上限 50（防止把站点翻崩）');
let threw = false;
try { buildBoothSearchUrl({ query: '   ' }); } catch { threw = true; }
ok(threw, '空搜索词直接抛错（不能拼出一个搜全站的地址）');
ok(BOOTH_SEARCH_MAX_PAGES >= 1 && BOOTH_SEARCH_MAX_PAGES <= 5, '翻页上限在 1~5 之间');

// ── 2. 实体与标签 ──────────────────────────────────────────────────────
eq(decodeEntities('&amp;&lt;&gt;&quot;&#39;&nbsp;'), '&<>"\' ', 'HTML 实体解码');
eq(decodeEntities('&#x1f496;'), '💖', '数字实体（十六进制）也能解');
eq(decodeEntities('&#128150;'), '💖', '数字实体（十进制）也能解');
eq(decodeEntities('&unknown;'), '&unknown;', '不认识的实体原样保留（不吞字）');
eq(stripTags('<b>标题</b> <i>副</i>'), '标题 副', '去标签并把连续空白压成一个空格');

// ── 3. 解析真实搜索页 ──────────────────────────────────────────────────
const parsed = parseBoothSearchHtml(FIXTURE);
eq(parsed.items.length, 4, 'fixture 里解析出 4 个商品卡');
eq(parsed.total, 77, '总数从「対象商品 77 件」读出来');
ok(parsed.hasNext === true, '有下一页（rel=next）');
eq(parsed.nextUrl, '/ja/search/VRChat%20Mew?page=2', '下一页地址原样带出');

const first = parsed.items[0];
eq(first.boothId, '7850009', '第一个商品号');
eq(first.title, '【18 avatars】💖Night_In🌙', '标题取 title-anchor 文本（不是会被截断的 data-product-name）');
eq(first.shopName, 'FOXYPLAY', '店铺名从头像 alt 取');
eq(first.shopUrl, 'https://foxyplay.booth.pm/', '店铺地址');
eq(first.price, 1190, '价格（日元整数）');
ok(first.thumbUrl.startsWith('https://booth.pximg.net/'), '封面地址是 pximg 的 data-original');
ok(first.thumbUrl.includes('/7850009/'), '封面地址里带商品号（便于人工核对）');
eq(first.itemUrl, 'https://booth.pm/ja/items/7850009', '商品页地址');
eq(first.position, 0, '搜索结果位置');

const third = parsed.items[2];
eq(third.boothId, '8637749', '第三个商品号');
ok(third.title.includes('Neru Hair'), '第三个标题含关键字');
ok(third.shopName.length > 0, '第三个也有店铺名');

const ids = parsed.items.map((it) => it.boothId);
eq(new Set(ids).size, ids.length, '4 个商品号互不重复');

// 空页面 / 非搜索页不能炸
eq(parseBoothSearchHtml('').items.length, 0, '空 HTML → 0 个候选（不抛）');
eq(parseBoothSearchHtml('<html><body>没有结果</body></html>').items.length, 0, '普通页面 → 0 个候选');
eq(parseBoothSearchHtml(undefined).total, null, 'undefined 也不炸');
// data-product-name 被站点截断时，回退到锚文本；锚文本也没有才用截断名
const truncated = parseBoothSearchHtml('<li class="item-card" data-product-id="1234567" data-product-name="【♡Teddy Nap♡】 【22 avatars..."></li>');
eq(truncated.items.length, 1, '只有 data-product-name 的卡片也认');
ok(!truncated.items[0].title.endsWith('...'), '截断名末尾的「...」被去掉了');
eq(parseBoothSearchHtml('<li class="item-card" data-product-id="7654321" data-product-name="原样"></li>').items[0].title, '原样', '没有锚文本时用 data-product-name');

// ── 4. 标题归一 / 相似度 ───────────────────────────────────────────────
eq(normalizeTitle('【18 avatars】Night_In🌙'), '18 avatars night in', '归一：去括号/emoji，下划线变空格，小写');
eq(normalizeTitle('ＶＲＣｈａｔ　Ａｖａｔａｒ'), 'vrchat avatar', '归一并处理全角字母与全角空格');
eq(titleTokens('VRChat Mew 服装'), ['vrchat', 'mew', '服装'], '分词');
eq(titleSimilarity('', 'x'), 0, '空标题相似度为 0');
eq(titleSimilarity('Neru Hair', 'Neru Hair'), 1, '完全一致 → 1');
near(titleSimilarity('Neru Hair', 'Neru Hair 2.0'), 0.63, 0.12, '近似标题（多版本号）仍在 0.5~0.75（不会被当成同一个）');
ok(titleSimilarity('Neru Hair', '完全不同的东西') < 0.4, '不相干的标题低于 0.4');
near(titleSimilarity('Neru Hair', 'Neru Hare'), titleSimilarity('Neru Hare', 'Neru Hair'), 1e-9, '相似度对称');

eq(osaDistance('', ''), 0, 'OSA：空串距离 0');
eq(osaDistance('abc', 'abc'), 0, 'OSA：相同串距离 0');
eq(osaDistance('kitten', 'sitting'), 3, 'OSA：kitten→sitting = 3');
eq(osaDistance('ab', 'ba'), 1, 'OSA：相邻交换算 1 次（普通 Levenshtein 是 2）');
eq(osaDistance('abc', 'abcdef', { max: 2 }), 3, '长度差超过 max 时直接返回 max+1');

// ── 5. 封面指纹 ────────────────────────────────────────────────────────
eq(coverDistance('0000000000000000', '0000000000000000'), 0, '同一个哈希距离 0');
eq(coverDistance('0000000000000000', '00000000000000ff'), 8, '相差 8 位就是 8');
eq(coverDistance('0000000000000000', 'ffffffffffffffff'), 64, '全反距离 64');
eq(coverDistance('', 'abc'), null, '空哈希 → null');
eq(coverDistance('zz', 'zz'), null, '非十六进制 → null');
eq(coverDistance('abcd', 'abcde'), null, '长度不一致 → null');
ok(BOOTH_COVER_HAMMING_MAX === 10, '阈值就是 10（与笔记一致）');
ok(coverMatch('0000000000000000', '00000000000003ff').match === true, '10 位以内算同一张图');
ok(coverMatch('0000000000000000', '000000000000ffff').match === false, '超过 10 位不算');
eq(coverMatch('', '').distance, null, '没有哈希时 match=false / distance=null');

// ── 6. 搜索词生成 ──────────────────────────────────────────────────────
const phrases = searchPhrasesFor({ title: '9038753_【18 avatars】Night_In（VRChat） -OkunoTe-', shop: 'FOXYPLAY' });
ok(phrases.length >= 2 && phrases.length <= 4, '最多 4 个搜索词');
ok(!phrases[0].startsWith('9038753'), '第一个搜索词不以商品号开头（否则会搜到无关商品）');
ok(phrases.some((p) => p.includes('FOXYPLAY')), '有带店铺名的搜索词');
eq(searchPhrasesFor({ title: 'x', shop: 'x' }).length, new Set(searchPhrasesFor({ title: 'x', shop: 'x' })).size, '搜索词去重');
eq(searchPhrasesFor({ title: '' }), [], '空标题 → 没有搜索词');
ok(searchPhrasesFor({ title: 'A'.repeat(200) })[0].length <= 80, '搜索词长度有上限（80）');
eq(searchPhrasesFor({ title: '9038753.zip' })[0], '9038753', '只有商品号的标题保留号（此时它就是唯一线索）');

// ── 7. 候选排序 ────────────────────────────────────────────────────────
const rankInput = { title: '💖Night_In🌙 18 avatars', candidates: parsed.items, coverHash: 'ffffffffffffffff' };
const ranked = rankBoothCandidates(rankInput);
eq(ranked.length, 4, '四个候选都参与排序');
eq(ranked[0].boothId, '7850009', '标题最像的排在第一位');
ok(ranked[0].titleScore > ranked[1].titleScore, '标题分从高到低');
ok(ranked.every((r) => r.score >= 0 && r.score <= 1), '总分落在 0~1');
ok(ranked[0].reasons.length > 0, '每条候选都有可读的理由');

// 封面指纹一致 → 立刻爬到第一位，即使标题不像
const withCover = rankBoothCandidates({
  title: '完全不一样的标题',
  candidates: parsed.items,
  coverHash: '1234567890abcdef',
  coverHashes: { 8637749: '1234567890abcdef' }
});
eq(withCover[0].boothId, '8637749', '封面一致时优先于标题相似度');
ok(withCover[0].coverMatch === true, '封面一致标记出来了');
ok(withCover[0].reasons.some((r) => r.includes('封面')), '理由里说明封面一致');

// 店铺命中加权
const shopRanked = rankBoothCandidates({ title: 'Night_In', shop: 'FOXYPLAY', candidates: parsed.items });
ok(shopRanked[0].shopMatch === true, '店铺命中被识别');
ok(shopRanked[0].score > rankBoothCandidates({ title: 'Night_In', candidates: parsed.items })[0].score, '店铺命中会加分');

// 排除已用的号
const excluded = rankBoothCandidates({ title: 'Night_In', candidates: parsed.items, excludeIds: ['7850009'] });
ok(!excluded.some((r) => r.boothId === '7850009'), '已绑定的号不参与排序');
eq(rankBoothCandidates({ title: 'x', candidates: [] }), [], '没有候选时返回空数组');
eq(rankBoothCandidates({ title: 'x', candidates: [null, {}, { boothId: '' }] }), [], '脏候选被过滤掉');

// ── 8. 自动勾选建议 ────────────────────────────────────────────────────
const autoPick = proposeBinding(withCover);
ok(autoPick.auto === true, '封面一致 → 默认勾选');
eq(autoPick.pick.boothId, '8637749', '自动勾选的号');
ok(autoPick.reason.includes('封面'), '自动勾选的理由提到封面');

const manualPick = proposeBinding(ranked);
ok(manualPick.auto === false, '只有标题相近 → 不自动勾');
ok(manualPick.pick !== null, '仍然给出最高分候选供人挑');
eq(proposeBinding([]).pick, null, '没有候选时不给建议');
ok(proposeBinding([{ boothId: '1', score: 0.95, coverMatch: false, titleScore: 0.95 }, { boothId: '2', score: 0.94, coverMatch: false, titleScore: 0.94 }]).auto === false, '前两名分数接近时不自动勾（防止绑错）');
ok(proposeBinding([{ boothId: '1', score: 0.95, coverMatch: false, titleScore: 0.95 }]).auto === true, '标题高度一致且没有竞争者时可以自动勾');
const farCover = rankBoothCandidates({ title: '完全不一样的标题', candidates: parsed.items, coverHash: '0000000000000000', coverHashes: { 8637749: '0000000000000077' } });
ok(proposeBinding(farCover).auto === false, '封面只是「像」（汉明距 7）而标题完全对不上时不自动勾');

console.log(`\nBOOTH 搜索/排序：通过 ${pass} / 失败 ${fails.length}`);
if (fails.length) process.exitCode = 1;
