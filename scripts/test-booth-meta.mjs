// BOOTH 元数据抓取单测（fixture + 假 fetch，不联网）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseBoothHtml,
  parseBoothJson,
  parseBoothItem,
  sniffBoothIds,
  boothCacheFresh,
  BOOTH_CACHE_OK_MS,
  BOOTH_CACHE_FAIL_MS,
  fetchBoothMeta
} from '../src/booth-meta.js';

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { fail += 1; console.error(`  FAIL ${name}: ${error?.message ?? error}`); }
}

const fixture = fs.readFileSync(new URL('./fixtures/booth-item-9038753.html', import.meta.url), 'utf8');
const fixtureJson = fs.readFileSync(new URL('./fixtures/booth-item-9038753.json', import.meta.url), 'utf8');
const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cache-'));
// 全局暂停状态文件也写到临时目录：否则 429/403 用例会把暂停写进仓库 state/，
// 后面所有用例都被判定「暂停中」而连锁失败（真踩过）。
const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-pause-'));

console.log('[0] JSON 端点解析（字段比 HTML 全）');
await check('parseBoothJson：title/shop/price/category/tags/thumb/isAdult', () => {
  const meta = parseBoothJson(JSON.parse(fixtureJson), { boothId: '9038753' });
  assert.equal(meta.status, 'ok');
  assert.equal(meta.title, '奥の手 -OkunoTe-【愛莉・ミルティナ専用】');
  assert.equal(meta.shop, 'ZigZag');
  assert.equal(meta.price, '¥ 290~');
  assert.equal(meta.category, '3D衣装');
  assert.ok(meta.tags.includes('VRChat') && meta.tags.length <= 12);
  assert.match(meta.thumbnailUrl, /^https:\/\/booth\.pximg\.net\//);
  assert.equal(meta.raw.isAdult, false);
  assert.equal(meta.raw.parentCategory, '3Dモデル');
});

console.log('[1] 真实页面 fixture 解析（9038753）');
await check('标题 / 店铺 / 价格 / 缩略图 / 链接', () => {
  const meta = parseBoothHtml(fixture, { boothId: '9038753' });
  assert.equal(meta.status, 'ok');
  assert.equal(meta.title, '奥の手 -OkunoTe-【愛莉・ミルティナ専用】');
  assert.equal(meta.shop, 'ZigZag');
  assert.match(meta.price, /^290-490 JPY$/);
  assert.match(meta.thumbnailUrl, /^https:\/\/booth\.pximg\.net\//);
  assert.equal(meta.itemUrl, 'https://booth.pm/zh-cn/items/9038753');
  assert.equal(meta.ok, true);
});

console.log('[2] 最小 HTML（无 ld+json，只能靠 og）');
await check('og:title / og:image 兜底', () => {
  const html = '<html><head><meta property="og:title" content="测试商品 - 店 - BOOTH"><meta property="og:image" content="https://booth.pximg.net/x.jpg"></head></html>';
  const meta = parseBoothHtml(html, { boothId: '12345' });
  assert.equal(meta.status, 'ok');
  assert.equal(meta.title, '测试商品');
  assert.equal(meta.thumbnailUrl, 'https://booth.pximg.net/x.jpg');
});

console.log('[3] 年龄墙：gated，但尽量拿到 og:image');
await check('含年齢確認且无 Product → gated + thumb', () => {
  const html = '<html><head><meta property="og:image" content="https://booth.pximg.net/age.jpg"><title>年齢確認</title></head><body>年齢確認が必要です</body></html>';
  const meta = parseBoothHtml(html, { boothId: '22222' });
  assert.equal(meta.status, 'gated');
  assert.equal(meta.thumbnailUrl, 'https://booth.pximg.net/age.jpg');
});

console.log('[4] fetchBoothMeta：404 / 429 / 超时 / 缓存');
await check('404（JSON 与 HTML 都 404）→ not_found，且写入 7 天缓存', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { status: 404, text: async () => '' }; };
  const meta = await fetchBoothMeta('404001', { fetchImpl, cacheDir: tmpCache, stateDir: tmpState, now: 1000, rateLimitMs: 1 });
  assert.equal(meta.status, 'not_found');
  assert.equal(calls, 3, 'ja.json + zh-cn.json + HTML 各一次');
  const again = await fetchBoothMeta('404001', { fetchImpl, cacheDir: tmpCache, stateDir: tmpState, now: 2000, rateLimitMs: 1 });
  assert.equal(again.status, 'not_found');
  assert.equal(again.cached, true);
  assert.equal(calls, 3, '缓存命中不该再发请求');
});
await check('HTML 429 → status paused，写全局暂停且不再重试（P2 口径）', async () => {
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-pause-429-'));
  try {
    let htmlCalls = 0;
    const fetchImpl = async (url) => {
      if (String(url).endsWith('.json')) return { status: 404, text: async () => '' };
      htmlCalls += 1;
      return { status: 429, headers: { get: () => '120' }, text: async () => '' };
    };
    const meta = await fetchBoothMeta('429001', { fetchImpl, cacheDir: tmpCache, stateDir: st, now: 1000, rateLimitMs: 1, timeoutMs: 1000 });
    assert.equal(meta.status, 'paused', '429 用整全局暂停的 status');
    assert.equal(meta.paused, true);
    assert.match(meta.error, /429|暂停/);
    assert.equal(htmlCalls, 1, '429 之后不再重试第二次 HTML（暂停文件已写）');
    const saved = JSON.parse(fs.readFileSync(path.join(st, 'booth-search-pause.json'), 'utf8'));
    assert.equal(saved.status, 429);
    assert.equal(saved.pausedUntil, 1000 + 120000, 'Retry-After 120 秒优先');
  } finally { fs.rmSync(st, { recursive: true, force: true }); }
});

await check('暂停中：一个请求都不发，直接 paused（商品页也受全局暂停约束）；过期后恢复', async () => {
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-pause-active-'));
  try {
    fs.writeFileSync(path.join(st, 'booth-search-pause.json'), JSON.stringify({ pausedUntil: 1000 + 5 * 60 * 1000, reason: 'BOOTH 搜索被限速（HTTP 429）', status: 429, at: 1000 }));
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { status: 200, text: async () => fixture }; };
    const meta = await fetchBoothMeta('9038760', { fetchImpl, cacheDir: tmpCache, stateDir: st, now: 60000, rateLimitMs: 1 });
    assert.equal(meta.status, 'paused');
    assert.equal(calls, 0);
    assert.match(meta.error, /剩余 \d+ 分钟/);
    const after = await fetchBoothMeta('9038760', { fetchImpl, cacheDir: tmpCache, stateDir: st, now: 1000 + 5 * 60 * 1000 + 1, rateLimitMs: 1 });
    assert.notEqual(after.status, 'paused');
    assert.ok(calls > 0, '暂停过期应当重新抓取');
  } finally { fs.rmSync(st, { recursive: true, force: true }); }
});

await check('HTML 403 → status paused 并写全局暂停（不再只回 blocked）', async () => {
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-pause-403-'));
  try {
    const fetchImpl = async (url) => {
      if (String(url).endsWith('.json')) return { status: 404, text: async () => '' };
      return { status: 403, text: async () => '' };
    };
    const meta = await fetchBoothMeta('403001', { fetchImpl, cacheDir: tmpCache, stateDir: st, now: 1, rateLimitMs: 1 });
    assert.equal(meta.status, 'blocked', '旧调用方按 blocked 做降级，契约不破');
    assert.equal(meta.blocked, true);
    assert.equal(meta.paused, true);
    const saved = JSON.parse(fs.readFileSync(path.join(st, 'booth-search-pause.json'), 'utf8'));
    assert.equal(saved.status, 403);
    assert.equal(saved.pausedUntil, 1 + 30 * 60 * 1000, '403 默认停 30 分钟');
  } finally { fs.rmSync(st, { recursive: true, force: true }); }
});

await check('网络异常 → error，不抛', async () => {
  const fetchImpl = async () => { throw new Error('socket hang up'); };
  const meta = await fetchBoothMeta('500001', { fetchImpl, cacheDir: tmpCache, stateDir: tmpState, now: 1000, rateLimitMs: 1 });
  assert.equal(meta.status, 'error');
  assert.match(meta.error, /socket hang up|抓取失败/);
});
await check('HTML 兜底成功（JSON 404）→ status=ok 并写缓存', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (String(url).endsWith('.json')) return { status: 404, text: async () => '' };
    return { status: 200, text: async () => fixture };
  };
  const first = await fetchBoothMeta('9038754', { fetchImpl, cacheDir: tmpCache, stateDir: tmpState, now: 1000, rateLimitMs: 1 });
  assert.equal(first.status, 'ok');
  assert.equal(first.title, '奥の手 -OkunoTe-【愛莉・ミルティナ専用】');
  const second = await fetchBoothMeta('9038754', { fetchImpl, cacheDir: tmpCache, stateDir: tmpState, now: 2000, rateLimitMs: 1 });
  assert.equal(second.cached, true);
  assert.equal(calls, 3, 'ja.json + zh-cn.json + HTML；第二次走缓存');
});
await check('JSON 端点优先：命中 JSON 就不抓 HTML，缓存也带 category/tags', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (String(url).endsWith('.json')) return { status: 200, text: async () => fixtureJson };
    return { status: 500, text: async () => '' };
  };
  const meta = await fetchBoothMeta('9038755', { fetchImpl, cacheDir: tmpCache, stateDir: tmpState, now: 1000, rateLimitMs: 1 });
  assert.equal(meta.status, 'ok');
  assert.equal(meta.category, '3D衣装');
  assert.equal(meta.price, '¥ 290~');
  assert.equal(calls, 1, 'JSON 命中后不再请求 HTML');
  const cached = await fetchBoothMeta('9038755', { fetchImpl, cacheDir: tmpCache, stateDir: tmpState, now: 2000, rateLimitMs: 1 });
  assert.equal(cached.cached, true);
  assert.equal(cached.category, '3D衣装');
});
await check('非法 BOOTH 号 → error（不请求）', async () => {
  let calls = 0;
  const meta = await fetchBoothMeta('12', { fetchImpl: async () => { calls += 1; }, cacheDir: tmpCache, stateDir: tmpState });
  assert.equal(meta.status, 'error');
  assert.equal(calls, 0);
});

console.log('[7] 与 feat/backend（A 的研究分支）同路径模块的契约兼容');
await check('parseBoothItem：真实 fixture 字段 + 缺字段不抛', () => {
  const it = parseBoothItem(JSON.parse(fixtureJson), { now: 0 });
  assert.equal(it.id, 9038753);
  assert.ok(it.title.includes('奥の手'));
  assert.equal(it.shop, 'ZigZag');
  assert.equal(it.price, '¥ 290~');
  assert.equal(it.category.parent, '3Dモデル');
  assert.ok(it.tags.length >= 20);
  assert.equal(it.thumbUrl, it.images[0]);
  assert.equal(it.source, 'booth-json');
  assert.equal(it.isAdult, false);
  assert.equal(parseBoothItem(null), null);
  assert.equal(parseBoothItem({}), null);
  assert.equal(parseBoothItem({ id: 42 }).shop, null);
});
await check('sniffBoothIds：URL 语言前缀 / 转义链接 / 文件名前缀 / 去重保序', () => {
  assert.deepEqual(sniffBoothIds({ text: 'https://booth.pm/zh-cn/items/9038753' }), [9038753]);
  assert.deepEqual(sniffBoothIds({ text: '见 https:\\/\\/booth.pm\\/ja\\/items\\/6641548' }), [6641548]);
  assert.deepEqual(sniffBoothIds({ filenames: ['9038753奥の手.zip'] }), [9038753]);
  assert.deepEqual(
    sniffBoothIds({ text: 'booth.pm/items/9038753 再次 booth.pm/items/6641548 还有 booth.pm/items/9038753', filenames: ['2026-10-25.zip'] }),
    [9038753, 6641548]
  );
});
await check('boothCacheFresh：成功 7 天 / 失败 10 分钟', () => {
  const now = 1000000;
  assert.equal(boothCacheFresh({ ok: true, at: now }, { now: now + BOOTH_CACHE_OK_MS - 1 }), true);
  assert.equal(boothCacheFresh({ ok: true, at: now }, { now: now + BOOTH_CACHE_OK_MS + 1 }), false);
  assert.equal(boothCacheFresh({ ok: false, at: now }, { now: now + BOOTH_CACHE_FAIL_MS - 1 }), true);
  assert.equal(boothCacheFresh({ ok: false, at: now }, { now: now + BOOTH_CACHE_FAIL_MS + 1 }), false);
  assert.equal(boothCacheFresh(null), false);
});

fs.rmSync(tmpCache, { recursive: true, force: true });
fs.rmSync(tmpState, { recursive: true, force: true });
console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
