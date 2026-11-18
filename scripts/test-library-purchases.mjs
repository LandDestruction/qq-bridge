// 已购库（state/booth-purchases.json + /api/library/purchases/*）的行为测试。
// 网络全部假 fetch，但页面解析、搜索排序走真的 src/booth-product.js / src/booth-search.js：
// 这样既验证路由/落盘/暂停闸，也验证真实 BOOTH fixture 能端到端走通。
//
// 跑法：node scripts/test-library-purchases.mjs
// 输出：逐条 ok/FAIL + 「通过 X / 失败 Y」，失败退出码 1。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as boothProductPure from '../src/booth-product.js';
// 截图识别的路由层在 library-ocr 里（本测试只验已购库转发的行为）。
import { createLibraryOcr } from '../src/bridge/console/library-ocr.js';
import * as boothSearchPure from '../src/booth-search.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODULE_PATH = path.join(ROOT, 'src/bridge/console/library-purchases.js');
const FIXTURES = path.join(ROOT, 'scripts/fixtures');
const ITEM_FIXTURE = {
  '8942722': 'booth-product/item-8942722-variations.html',
  '4511536': 'booth-product/item-4511536-free.html',
  '6538026': 'booth-product/item-6538026-single.html'
};
const SEARCH_FIXTURE = 'booth-search-mew.html';
const TINY_PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

let passed = 0;
const failures = [];
function check(cond, name, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
    return;
  }
  failures.push(name);
  console.log(`  FAIL ${name}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-purchases-'));
const stateFile = path.join(tmp, 'booth-purchases.json');
const coverDir = path.join(tmp, 'booth-purchase-covers');
const pauseFile = path.join(tmp, 'booth-search-pause.json');

function resetState() {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
}
function readState() {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

// ── 假 fetch：按 URL 路由到真 fixture / 计划响应 ─────────────────────────────
const calls = [];
let overrides = new Map(); // url 子串 → {status, body, type} | 'network-error'
function planFor(url) {
  for (const [needle, plan] of overrides) {
    if (url.includes(needle)) return plan;
  }
  if (url.includes('booth.pximg.net')) return { status: 200, body: JPEG, type: 'image' };
  if (url.includes('booth.pm/ja/search/')) return { status: 200, body: fs.readFileSync(path.join(FIXTURES, SEARCH_FIXTURE), 'utf8'), type: 'html' };
  const m = /booth\.pm\/ja\/items\/(\d+)/.exec(url);
  if (m && ITEM_FIXTURE[m[1]]) return { status: 200, body: fs.readFileSync(path.join(FIXTURES, ITEM_FIXTURE[m[1]]), 'utf8'), type: 'html' };
  if (m) return { status: 404, body: 'not found', type: 'text' };
  return { status: 200, body: '<html><body>not a booth page</body></html>', type: 'html' };
}
async function fakeFetch(url, opts = {}) {
  calls.push({ url: String(url), headers: opts.headers || {}, signal: Boolean(opts.signal) });
  const plan = planFor(String(url));
  if (plan === 'network-error') throw new Error('fetch failed：ECONNRESET');
  return {
    status: plan.status,
    async text() { return plan.type === 'image' ? '' : plan.body; },
    async arrayBuffer() {
      if (plan.type === 'image') return plan.body.buffer.slice(plan.body.byteOffset, plan.body.byteOffset + plan.body.byteLength);
      return Buffer.from(plan.body).buffer;
    }
  };
}

const ocrFixture = createLibraryOcr({
  fs,
  path,
  ROOT: tmp,
  STATE_DIR: tmp,
  log: () => {},
  Buffer,
  safeResolveInside: (root, rel) => path.resolve(root, rel),
  runPowerShell: async () => ({ ok: false, error: 'fixture: 这个测试不真跑 PowerShell' })
});

const deps = {
  fs,
  path,
  ROOT: tmp,
  STATE_DIR: tmp,
  log: () => {},
  atomicWriteJson: (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  },
  fetch: fakeFetch,
  AbortSignal,
  Buffer,
  boothProductPure,
  boothSearchPure,
  libraryOcr: ocrFixture
};

// ── 假请求/响应 ──────────────────────────────────────────────────────────────
function makeRequest({ method = 'GET', pathname = '/api/library/purchases', body = null, query = {}, headers = {} } = {}) {
  const sent = [];
  const request = {
    req: { method, headers },
    url: { pathname, searchParams: new URLSearchParams(query) },
    // console-server 的真实 request 一定带 SECURITY_HEADERS；这里照抄一份，验证二进制响应也带头。
    SECURITY_HEADERS: Object.freeze({
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'",
      // console-server 的真实 SECURITY_HEADERS 带这个（大写 C）；照抄才能验出「封面长缓存被 no-store 抹掉」。
      'Cache-Control': 'no-store'
    }),
    readBody: async () => body,
    sendJson: (payload, status = 200) => sent.push({ kind: 'json', status, payload }),
    res: {
      writeHead: (status, responseHeaders = {}) => sent.push({ kind: 'binary', status, headers: responseHeaders }),
      end: (buf) => {
        const last = sent[sent.length - 1];
        if (last && last.kind === 'binary') last.body = buf;
      }
    }
  };
  return { request, sent };
}
const lastJson = (sent) => sent[sent.length - 1];

const { createLibraryPurchases } = await import(pathToFileURL(MODULE_PATH).href);
const service = createLibraryPurchases(deps);
const call = (options) => {
  const { request, sent } = makeRequest(options);
  return Promise.resolve(service.handleConsoleLibraryPurchases(request)).then((handled) => ({ handled, sent, request }));
};

// ── §1 模块形状与边界 ────────────────────────────────────────────────────────
console.log('§1 模块形状');
check(typeof service.handleConsoleLibraryPurchases === 'function', '导出一个 handleConsoleLibraryPurchases');
check(Object.keys(service).length === 1, '工厂只暴露一个键（manifest functions 一致）', Object.keys(service));
const unrelated = await call({ pathname: '/api/library/assets' });
check(unrelated.handled === false, '不归我管的路径返回 false', unrelated.handled);

// ── §2 resolve：链接直解 ─────────────────────────────────────────────────────
console.log('§2 resolve 链接');
resetState();
overrides = new Map();
const r2 = await call({ method: 'POST', pathname: '/api/library/purchases/resolve', body: { url: 'https://booth.pm/ja/items/8942722' } });
check(r2.handled === true, 'resolve 链接被处理');
check(lastJson(r2.sent).status === 200, 'resolve 链接 200', lastJson(r2.sent).status);
const item2 = lastJson(r2.sent).payload;
check(item2.ok === true && item2.mode === 'item', 'resolve 链接回 mode=item');
check(item2.boothId === '8942722', '解析出 boothId=8942722');
check(item2.stored === false, '还没入库时 stored=false');
check(item2.item.title === '脱ぎかけセータービキニ【8アバター対応】', '标题解析正确', item2.item.title);
check(item2.item.shopName === 'ZigZag', '店铺解析正确', item2.item.shopName);
check(item2.item.priceText === '¥ 990', '价格文本解析正确', item2.item.priceText);
check(item2.item.tags.includes('VRChat'), '标签解析正确', item2.item.tags);
check(/^https:\/\/booth\.pximg\.net\//.test(item2.item.coverUrl), '返回远程封面 URL');
check(item2.item.desc.includes('ZigZag') && item2.item.desc.includes('¥ 990'), 'desc 是列表副标题', item2.item.desc);
check(r2.sent[0].payload.item.models && typeof item2.item.models.total === 'number', 'models 形状 {max,total,labeled}');

const r2bad = await call({ method: 'POST', pathname: '/api/library/purchases/resolve', body: { url: 'https://example.com/items/1' } });
check(lastJson(r2bad.sent).status === 400, '非 BOOTH 链接 400', lastJson(r2bad.sent).status);
check(/BOOTH 商品链接/.test(lastJson(r2bad.sent).payload.error), '非 BOOTH 链接回人话', lastJson(r2bad.sent).payload.error);
const r2empty = await call({ method: 'POST', pathname: '/api/library/purchases/resolve', body: {} });
check(lastJson(r2empty.sent).status === 400, 'url/text 都不给 400');

// ── §3 resolve：文字搜候选 ───────────────────────────────────────────────────
console.log('§3 resolve 文字');
const before3 = calls.length;
const r3 = await call({ method: 'POST', pathname: '/api/library/purchases/resolve', body: { text: 'ぬいぐるみ mew' } });
const p3 = lastJson(r3.sent).payload;
check(lastJson(r3.sent).status === 200, '文字 resolve 200', lastJson(r3.sent).status);
check(p3.mode === 'search', '文字 resolve 回 mode=search');
check(p3.query === 'ぬいぐるみ mew', '回显 query');
check(Array.isArray(p3.candidates) && p3.candidates.length > 0, '文字 resolve 有候选', p3.candidates.length);
check(p3.candidates.length <= 8, '候选最多 8 个', p3.candidates.length);
check(p3.candidates.every((c) => /^\d{5,9}$/.test(c.boothId) && c.title && c.itemUrl), '候选带 boothId/title/itemUrl');
check(p3.candidates.some((c) => /^`?¥|^¥/.test(c.priceText)), '候选价格格式化成 ¥ 文本', p3.candidates.map((c) => c.priceText));
check(p3.candidates.some((c) => /^https:\/\/booth\.pximg\.net\//.test(c.coverUrl)), '候选带封面 URL');
check(typeof p3.candidates[0].score === 'number', '候选带匹配分数');
const searchCall = calls.slice(before3).find((c) => c.url.includes('/ja/search/'));
check(Boolean(searchCall) && String(searchCall.headers['user-agent'] || '').includes('Chrome/122'), '搜索请求用 Chrome122 UA', searchCall?.headers['user-agent']);
check(Boolean(searchCall) && searchCall.signal === true, '搜索请求带 AbortSignal');

// ── §4 import：真 fixture 落盘 + 封面 ────────────────────────────────────────
console.log('§4 import');
resetState();
overrides = new Map();
const r4 = await call({
  method: 'POST',
  pathname: '/api/library/purchases/import',
  body: { urls: ['https://booth.pm/ja/items/8942722', 'https://booth.pm/ja/items/4511536'] }
});
const p4 = lastJson(r4.sent).payload;
check(lastJson(r4.sent).status === 200 && p4.ok === true, 'import 200 ok', lastJson(r4.sent).status);
check(p4.added === 2 && p4.updated === 0, '首次导入 added=2/updated=0', { added: p4.added, updated: p4.updated });
check(Array.isArray(p4.failed) && p4.failed.length === 0, '两个链接都成功', p4.failed);
check(p4.total === 2, 'total=2', p4.total);
check(fs.existsSync(stateFile), 'state/booth-purchases.json 已落盘');
const state4 = readState();
check(state4.version === 1, '台账 version=1');
check(Object.keys(state4.items).sort().join(',') === '4511536,8942722', '台账按 boothId 索引', Object.keys(state4.items));
const it4 = state4.items['8942722'];
const expectedKeys = ['addedAt', 'boothId', 'categories', 'coverRel', 'itemUrl', 'models', 'priceText', 'shopName', 'shopUrl', 'source', 'tags', 'title', 'updatedAt'];
check(Object.keys(it4).sort().join(',') === expectedKeys.join(','), '记录字段与约定一致', Object.keys(it4).sort());
check(it4.source === 'import', 'source=import');
check(it4.coverRel === 'booth-purchase-covers/8942722.jpg', 'coverRel 指向固定封面目录', it4.coverRel);
check(fs.existsSync(path.join(coverDir, '8942722.jpg')), '封面已写盘');
check(fs.readFileSync(path.join(coverDir, '8942722.jpg')).equals(JPEG), '封面字节原样落盘');
check(it4.addedAt > 0 && it4.updatedAt >= it4.addedAt, 'addedAt/updatedAt 合理');
check(it4.models && typeof it4.models.max === 'number', 'models 已入库');
const free4 = state4.items['4511536'];
check(free4.priceText === '¥ 0', '免费商品 priceText=¥ 0', free4.priceText);
check(free4.models.max === 43 && free4.models.total === 54 && free4.models.labeled === 2, '免费商品 models 正确', free4.models);

// 已存在的再导入 → updated
const r4b = await call({ method: 'POST', pathname: '/api/library/purchases/import', body: { boothIds: ['8942722'] } });
const p4b = lastJson(r4b.sent).payload;
check(p4b.added === 0 && p4b.updated === 1 && p4b.total === 2, '重复导入走 updated 不新增', { added: p4b.added, updated: p4b.updated });

// 坏链接/坏号/404/解析失败：都要进 failed，不能中断
console.log('§5 import 失败分支');
resetState();
overrides = new Map();
overrides.set('/ja/items/9999999', { status: 404, body: 'nope', type: 'text' });
overrides.set('/ja/items/6538027', { status: 200, body: '<html><body>login required</body></html>', type: 'html' });
const r5 = await call({
  method: 'POST',
  pathname: '/api/library/purchases/import',
  body: { urls: ['https://example.com/items/1', 'https://booth.pm/ja/items/9999999', 'https://booth.pm/ja/items/6538027', 'https://booth.pm/ja/items/6538026'] }
});
const p5 = lastJson(r5.sent).payload;
check(lastJson(r5.sent).status === 200 && p5.ok === true, '部分失败仍 200', lastJson(r5.sent).status);
check(p5.added === 1 && p5.failed.length === 3, '1 成功 3 失败不中断', { added: p5.added, failed: p5.failed.length });
check(p5.failed.some((f) => /不是 BOOTH 商品链接/.test(f.error)), '坏链接有人话');
check(p5.failed.some((f) => /404/.test(f.error)), '404 有人话', p5.failed.map((f) => f.error));
check(p5.failed.some((f) => /解析失败/.test(f.error)), '解析不出商品页按解析失败处理', p5.failed.map((f) => f.error));
const r5b = await call({ method: 'POST', pathname: '/api/library/purchases/import', body: { boothIds: ['123', 'abc'] } });
check(lastJson(r5b.sent).status === 200 && lastJson(r5b.sent).payload.failed.length === 2, '非法 boothIds 进 failed', lastJson(r5b.sent).payload?.failed);
const r5c = await call({ method: 'POST', pathname: '/api/library/purchases/import', body: {} });
check(lastJson(r5c.sent).status === 400, '既没 urls 也没 boothIds → 400');

// ── §6 管理端闸 / 方法 / 暂停闸 ──────────────────────────────────────────────
console.log('§6 安全边界');
resetState();
const r6 = await call({ method: 'POST', pathname: '/api/library/purchases/import', headers: { 'x-agent-token': 'agent-x' }, body: { boothIds: ['8942722'] } });
check(lastJson(r6.sent).status === 403, '带 x-agent-token 一律 403', lastJson(r6.sent).status);
check(/管理端/.test(lastJson(r6.sent).payload.error), '403 文案说明是管理端');
check(!fs.existsSync(stateFile), '403 请求没有写台账');
const r6m = await call({ method: 'GET', pathname: '/api/library/purchases/import' });
check(lastJson(r6m.sent).status === 405, 'GET import → 405', lastJson(r6m.sent).status);
const r6n = await call({ method: 'POST', pathname: '/api/library/purchases' });
check(lastJson(r6n.sent).status === 405, 'POST 列表 → 405', lastJson(r6n.sent).status);

fs.writeFileSync(pauseFile, JSON.stringify({ pausedUntil: Date.now() + 45 * 1000, reason: 'HTTP 429', status: 429 }));
const callsBefore6 = calls.length;
const r6p = await call({ method: 'POST', pathname: '/api/library/purchases/import', body: { boothIds: ['8942722'] } });
const p6p = lastJson(r6p.sent).payload;
check(lastJson(r6p.sent).status === 409 && p6p.paused === true, '暂停闸生效：import 409 paused', { status: lastJson(r6p.sent).status, paused: p6p.paused });
check(/暂停中/.test(p6p.error), '暂停文案带剩余时间', p6p.error);
check(calls.length === callsBefore6, '暂停期间一次网络都不打', calls.length - callsBefore6);
fs.rmSync(pauseFile, { force: true });
const r6pr = await call({ method: 'POST', pathname: '/api/library/purchases/refresh', body: {} });
check(lastJson(r6pr.sent).status === 200, '暂停解除后 refresh 恢复', lastJson(r6pr.sent).status);

// ── §7 列表：分页 / 搜索 / 标签 ──────────────────────────────────────────────
console.log('§7 列表');
resetState();
overrides = new Map();
await call({ method: 'POST', pathname: '/api/library/purchases/import', body: { boothIds: ['8942722', '4511536', '6538026'] } });
const r7 = await call({ pathname: '/api/library/purchases', query: { limit: '2' } });
const p7 = lastJson(r7.sent).payload;
check(lastJson(r7.sent).status === 200 && p7.ok === true, '列列表 200', lastJson(r7.sent).status);
check(p7.total === 3 && p7.items.length === 2 && p7.pages === 2, '分页：total=3/limit=2/pages=2', { total: p7.total, items: p7.items.length, pages: p7.pages });
check(p7.items.every((i) => typeof i.coverUrl === 'string'), '列表项带 coverUrl 字段');
check(p7.items.some((i) => /^\/api\/library\/purchases\/cover\?boothId=\d+/.test(i.coverUrl)), '有封面的项回本地封面地址', p7.items.map((i) => i.coverUrl));
check(Array.isArray(p7.tags) && p7.tags.some((t) => t.tag === 'VRChat' && t.count === 3), 'tags 聚合计数', p7.tags);
check(typeof p7.updatedAt === 'number' && p7.updatedAt > 0, '带 updatedAt');
const r7q = await call({ pathname: '/api/library/purchases', query: { q: 'ミルティナ' } });
check(lastJson(r7q.sent).payload.total === 1, 'q 标题过滤', lastJson(r7q.sent).payload.total);
const r7t = await call({ pathname: '/api/library/purchases', query: { tag: '不存在的标签' } });
check(lastJson(r7t.sent).payload.total === 0, 'tag 过滤（没有就是 0）', lastJson(r7t.sent).payload.total);
const r7p = await call({ pathname: '/api/library/purchases', query: { limit: '2', page: '2' } });
check(lastJson(r7p.sent).payload.items.length === 1, '第二页 1 条', lastJson(r7p.sent).payload.items.length);
const r7o = await call({ pathname: '/api/library/purchases', query: { limit: '100000' } });
check(lastJson(r7o.sent).payload.limit === 100, 'limit 上限 100', lastJson(r7o.sent).payload.limit);

// ── §7b 列表封面降级：本地图 > 远程 coverUrl > 空串 ─────────────────────────
// 真机 bug 回归：清单页同步来的条目只有远程 coverUrl（本地没下载图），旧代码一律回空串，
// 等于把远程封面抹掉了。这里直接手写台账造三种情况，验证 coverUrl / coverRemote 的组合。
console.log('§7b 列表封面降级');
resetState();
fs.mkdirSync(path.join(tmp, 'booth-purchase-covers'), { recursive: true });
fs.writeFileSync(path.join(coverDir, '6538026.jpg'), JPEG);
const REMOTE_COVER = 'https://booth.pximg.net/c/300x300_a2_g5/aaa/i/8942722/bbb.jpg';
fs.writeFileSync(stateFile, JSON.stringify({
  version: 1,
  items: {
    8942722: { boothId: '8942722', title: '远程封面条目', coverRel: '', coverUrl: REMOTE_COVER, addedAt: 1, updatedAt: 3, source: 'library-sync' },
    6538026: { boothId: '6538026', title: '本地封面条目', coverRel: 'booth-purchase-covers/6538026.jpg', coverUrl: REMOTE_COVER, addedAt: 1, updatedAt: 2, source: 'import' },
    4511536: { boothId: '4511536', title: '没封面条目', coverRel: '', coverUrl: '', addedAt: 1, updatedAt: 1, source: 'import' }
  }
}, null, 2));
const r7b = await call({ pathname: '/api/library/purchases', query: { limit: '100' } });
const p7b = lastJson(r7b.sent).payload;
const byId = Object.fromEntries((p7b.items || []).map((i) => [i.boothId, i]));
check(lastJson(r7b.sent).status === 200 && p7b.total === 3, '台账里 3 条都能列出来', p7b.total);
check(byId['8942722'].coverUrl === REMOTE_COVER, '本地无图 → 回台账里的远程封面（不再抹成空串）', byId['8942722'] && byId['8942722'].coverUrl);
check(byId['8942722'].coverRemote === true, '远程封面 coverRemote=true', byId['8942722'] && byId['8942722'].coverRemote);
check(/^\/api\/library\/purchases\/cover\?boothId=6538026/.test(byId['6538026'].coverUrl), '有本地图 → 仍回本地接口', byId['6538026'] && byId['6538026'].coverUrl);
check(byId['6538026'].coverRemote === false, '本地图 coverRemote=false', byId['6538026'] && byId['6538026'].coverRemote);
check(byId['4511536'].coverUrl === '' && byId['4511536'].coverRemote === false, '两样都没有 → 空串 + coverRemote=false', byId['4511536'] && [byId['4511536'].coverUrl, byId['4511536'].coverRemote]);
// 本地图一旦丢了（文件不在），也要退回远程图，而不是空串。
fs.rmSync(path.join(coverDir, '6538026.jpg'), { force: true });
const r7c = await call({ pathname: '/api/library/purchases', query: { q: '本地封面条目' } });
check(lastJson(r7c.sent).payload.items[0].coverUrl === REMOTE_COVER && lastJson(r7c.sent).payload.items[0].coverRemote === true, '本地图文件丢了 → 退回远程封面', lastJson(r7c.sent).payload.items[0]?.coverUrl);

// ── §8 remove / refresh / ocr ───────────────────────────────────────────────
console.log('§8 remove / refresh / ocr');
const r8 = await call({ method: 'POST', pathname: '/api/library/purchases/remove', body: { boothId: '8942722' } });
const p8 = lastJson(r8.sent).payload;
check(p8.ok === true && p8.removed === true && p8.total === 2, 'remove 删掉一条', { removed: p8.removed, total: p8.total });
check(!readState().items['8942722'], '台账里已删');
check(!fs.existsSync(path.join(coverDir, '8942722.jpg')), '封面文件同步删除');
const r8b = await call({ method: 'POST', pathname: '/api/library/purchases/remove', body: { boothId: '8942722' } });
check(lastJson(r8b.sent).payload.removed === false, '重复 remove 返回 removed=false');
const r8c = await call({ method: 'POST', pathname: '/api/library/purchases/remove', body: { boothId: '../etc' } });
check(lastJson(r8c.sent).status === 400, 'remove 非法 boothId 400（防穿越）');

const before8 = readState().items['6538026'];
await new Promise((r) => setTimeout(r, 5));
const r8r = await call({ method: 'POST', pathname: '/api/library/purchases/refresh', body: { boothIds: ['6538026'] } });
const p8r = lastJson(r8r.sent).payload;
check(p8r.ok === true && p8r.refreshed === 1 && p8r.failed.length === 0, 'refresh 重抓一条', { refreshed: p8r.refreshed, failed: p8r.failed });
const after8 = readState().items['6538026'];
check(after8.addedAt === before8.addedAt, 'refresh 保留 addedAt');
check(after8.updatedAt > before8.updatedAt, 'refresh 推进 updatedAt');
check(after8.source === 'refresh', 'refresh 标记 source', after8.source);
const r8r2 = await call({ method: 'POST', pathname: '/api/library/purchases/refresh', body: { boothIds: ['6500000'] } });
check(lastJson(r8r2.sent).payload.refreshed === 0 && lastJson(r8r2.sent).payload.failed.length === 1, 'refresh 不存在的号进 failed');
const r8r3 = await call({ method: 'POST', pathname: '/api/library/purchases/refresh', body: { boothIds: ['abc'] } });
check(lastJson(r8r3.sent).status === 400, 'refresh 非法号 400');

const r8o = await call({ method: 'POST', pathname: '/api/library/purchases/ocr', body: {} });
check(lastJson(r8o.sent).status === 400 && /image/.test(lastJson(r8o.sent).payload.error), 'OCR 缺图 400 说清要什么', lastJson(r8o.sent).payload.error);
const r8os = await call({ pathname: '/api/library/purchases/ocr/status' });
check(lastJson(r8os.sent).status === 200 && lastJson(r8os.sent).payload.available === false, 'OCR 状态：夹具里没有可用引擎', lastJson(r8os.sent).payload);

// 截图识别是「只读预览」：识别出号也只回候选，不写台账、不落封面（导入由 /purchases/import 负责）。
const ocrOk = createLibraryOcr({
  fs,
  path,
  ROOT: tmp,
  STATE_DIR: tmp,
  log: () => {},
  Buffer,
  safeResolveInside: (root, rel) => path.resolve(root, rel),
  runPowerShell: async () => ({
    ok: true,
    stdout: JSON.stringify({
      ok: true,
      engine: 'en-US',
      langs: ['en-US'],
      lines: [{ text: 'Midnight Hug2', x: 10, y: 10 }, { text: '# 8942722', x: 10, y: 40 }]
    })
  })
});
deps.libraryOcr = ocrOk;
const stateTextBefore = fs.readFileSync(stateFile, 'utf8');
const stateMtimeBefore = fs.statSync(stateFile).mtimeMs;
await new Promise((r) => setTimeout(r, 5));
const r8ocr = await call({ method: 'POST', pathname: '/api/library/purchases/ocr', body: { image: TINY_PNG_1PX } });
const p8ocr = lastJson(r8ocr.sent).payload;
check(lastJson(r8ocr.sent).status === 200 && p8ocr.ok === true, 'OCR 预览 200', lastJson(r8ocr.sent).status);
const previewItem = (p8ocr.items || []).find((one) => one.boothId === '8942722');
check(Boolean(previewItem) && previewItem.enriched === true && previewItem.title === '脱ぎかけセータービキニ【8アバター対応】', '预览里带商品页字段（enriched:true）', previewItem && previewItem.title);
check(Boolean(previewItem) && previewItem.coverRemote === true && /^https:\/\/booth\.pximg\.net\//.test(previewItem.coverUrl), '本地没封面时给远程封面', previewItem && previewItem.coverUrl);
check(fs.readFileSync(stateFile, 'utf8') === stateTextBefore, '预览不写台账（内容不变）');
check(fs.statSync(stateFile).mtimeMs === stateMtimeBefore, '预览不写台账（mtime 不变）');
check(!fs.existsSync(path.join(coverDir, '8942722.jpg')), '预览不落封面');

const r8ocrFail = await call({ method: 'POST', pathname: '/api/library/purchases/ocr', body: {} });
check(lastJson(r8ocrFail.sent).status === 400, 'OCR 缺图仍 400（只读改造没丢参数校验）');

// ── §9 封面路由 ─────────────────────────────────────────────────────────────
console.log('§9 封面路由');
resetState();
overrides = new Map();
await call({ method: 'POST', pathname: '/api/library/purchases/import', body: { boothIds: ['8942722'] } });
const r9 = await call({ pathname: '/api/library/purchases/cover', query: { boothId: '8942722' } });
const coverEntry = r9.sent[0];
check(coverEntry.status === 200 && coverEntry.headers['content-type'] === 'image/jpeg', '封面 200 image/jpeg', { status: coverEntry.status, type: coverEntry.headers['content-type'] });
check(coverEntry.headers['x-frame-options'] === 'DENY', '封面带 SECURITY_HEADERS（XFO）', coverEntry.headers['x-frame-options']);
// 封面内容会被 refresh 覆盖、URL 上又带 &v=<updatedAt>，所以要能长缓存。
// 这里必须断言「Cache-Control 单键且是 public」，而不是只看有没有 public 字样：
// 大小写不同的同名头在 Node 里等价，一旦和 SECURITY_HEADERS 里的 no-store 撞车，浏览器就按 no-store 走。
const coverCacheKeys = Object.keys(coverEntry.headers).filter((k) => k.toLowerCase() === 'cache-control');
check(coverCacheKeys.length === 1, '封面响应只有一个 Cache-Control 头', coverCacheKeys);
check(coverEntry.headers['Cache-Control'] === 'public, max-age=86400', '封面是公共长缓存（不被全局 no-store 抹掉）', coverEntry.headers['Cache-Control']);
check(Buffer.isBuffer(coverEntry.body) && coverEntry.body.equals(JPEG), '封面字节原样返回');
const r9b = await call({ pathname: '/api/library/purchases/cover', query: { boothId: '4511536' } });
check(lastJson(r9b.sent).status === 404, '没有封面 404', lastJson(r9b.sent).status);
const r9c = await call({ pathname: '/api/library/purchases/cover', query: { boothId: '../../etc/passwd' } });
check(lastJson(r9c.sent).status === 400, '封面 boothId 非法 400（不拼路径）', lastJson(r9c.sent).status);
check(!fs.existsSync(path.join(tmp, '..', 'passwd')) && fs.readdirSync(tmp).every((n) => n !== 'etc'), '没有发生目录穿越写读');

// ── §10 脏台账不炸 ──────────────────────────────────────────────────────────
console.log('§10 容错');
resetState();
fs.writeFileSync(stateFile, '{ 这不是 JSON');
const r10 = await call({ pathname: '/api/library/purchases', query: {} });
check(lastJson(r10.sent).status === 200 && lastJson(r10.sent).payload.total === 0, '台账坏了按空库返回，不 500', lastJson(r10.sent).status);
fs.writeFileSync(stateFile, JSON.stringify({ version: 1, items: { '8942722': { title: '没有boothId' }, '4511536': { boothId: '4511536', title: 'ok', tags: ['VRChat'], models: 'bad' } } }));
const r10b = await call({ pathname: '/api/library/purchases', query: {} });
const p10b = lastJson(r10b.sent).payload;
check(p10b.total === 1 && p10b.items[0].boothId === '4511536', '坏条目被丢弃、好条目保留', { total: p10b.total });
check(Array.isArray(p10b.items[0].tags) && p10b.items[0].models.max === 0, '坏字段被规整（tags/models）', p10b.items[0].models);

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('');
console.log(`========== 通过 ${passed} / 失败 ${failures.length} ==========`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
