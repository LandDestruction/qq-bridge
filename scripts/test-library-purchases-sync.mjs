// 已购库「从 BOOTH 已购清单同步」（/api/library/purchases/sync + /status）的行为测试。
// 网络全部假 fetch（按 URL 的 page 参数返回真 fixture / 构造页），Cookie 槽位、台账、状态都写临时目录。
//
// 跑法：node scripts/test-library-purchases-sync.mjs
// 输出：逐条 ok/FAIL + 「通过 X / 失败 Y」，失败退出码 1。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as boothProductPure from '../src/booth-product.js';
import * as boothDownloadPure from '../src/booth-download.js';
// 全局 BOOTH 暂停的真实实现：同步开跑前必须先看它（429/403 是全局的，不能只有搜索退避）。
import * as boothPausePure from '../src/booth-pause.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODULE_PATH = path.join(ROOT, 'src/bridge/console/library-purchases-sync.js');
const FIXTURES = path.join(ROOT, 'scripts/fixtures');
const PAGE_FIXTURE = fs.readFileSync(path.join(FIXTURES, 'booth-library-page1.html'), 'utf8');

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

const mod = await import(pathToFileURL(MODULE_PATH).href);

// ── 场景脚手架：每个场景一个临时 STATE_DIR + 一个全新的 handler（限速状态互不影响）──
const COOKIE_OK = {
  version: 1,
  current: 'sid-1234abcd',
  accounts: { 'sid-1234abcd': { cookie: '_plaza_session_id=abc123; adult=t', savedAt: 1, note: '测试账号' } }
};

function makeDeps({ cookie = COOKIE_OK, plan = null, dir: givenDir = null, rateMs = undefined } = {}) {
  const dir = givenDir || fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-psync-'));
  if (cookie && !givenDir) fs.writeFileSync(path.join(dir, 'booth-cookies.json'), JSON.stringify(cookie));
  const calls = [];
  const fetchPlan = plan || (() => ({ status: 200, body: PAGE_FIXTURE, headers: {} }));
  const deps = {
    fs,
    path,
    STATE_DIR: dir,
    ...(rateMs === undefined ? {} : { libpsyncRateMs: rateMs }),
    log: () => {},
    atomicWriteJson: (file, value) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value, null, 2));
    },
    AbortSignal,
    Buffer,
    boothProductPure,
    boothDownloadPure,
    boothPausePure,
    fetch: async (url, opts = {}) => {
      calls.push({ url: String(url), at: Date.now(), headers: opts.headers || {}, redirect: opts.redirect });
      const plan = fetchPlan(String(url), calls.length);
      if (plan === 'network-error') throw new Error('fetch failed：ECONNRESET');
      return {
        status: plan.status,
        url: String(url),
        headers: { get: (name) => (plan.headers && plan.headers[name]) || plan.headers?.Location || null },
        async text() { return plan.body || ''; },
        async arrayBuffer() {
          // 注意不能用 Buffer.from(...).buffer：小字符串走 Node 的池子，.buffer 是整个 8KB 池，
          // 会把前一个用例的页面残留一起喂给解析器（购买日期用例就被串过）。按 byteOffset 切片才对。
          const bytes = Buffer.from(plan.body || '');
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        }
      };
    }
  };
  return { deps, dir, calls };
}

function makeRequest({ method = 'POST', pathname = '/api/library/purchases/sync', body = null, headers = {} } = {}) {
  const sent = [];
  const request = {
    req: { method, headers },
    url: { pathname, searchParams: new URLSearchParams() },
    readBody: async () => body,
    sendJson: (payload, status = 200) => sent.push({ status, payload }),
    res: { writeHead: () => {}, end: () => {} }
  };
  return { request, sent };
}

async function run(deps, opts = {}) {
  const handler = mod.createLibraryPurchasesSync(deps).handleConsoleLibraryPurchasesSync;
  const { request, sent } = makeRequest(opts);
  const handled = await handler(request);
  return { handled, sent, top: sent[0] };
}

function readJson(dir, name) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 第二页：真 fixture 的 3 张卡换成一串新号（保留真实卡片结构），并摘掉 rel="next"。
const PAGE2_FIXTURE = PAGE_FIXTURE
  .replace(/rel="next"/g, 'rel="none"')
  .replace(/9053400/g, '9177771')
  .replace(/9000436/g, '9177772')
  .replace(/9028816/g, '9177773');

function planTwoPages(page1 = PAGE_FIXTURE) {
  return (url) => {
    const m = /[?&]page=(\d+)/.exec(url);
    const page = m ? Number(m[1]) : 1;
    if (page <= 1) return { status: 200, body: page1 };
    return { status: 200, body: PAGE2_FIXTURE };
  };
}

console.log('已购库同步：BOOTH 已购清单');

// ── 1. 真 fixture 解析 ──────────────────────────────────────────────────────
{
  const { deps } = makeDeps({ plan: planTwoPages() });
  const { handled, top } = await run(deps, { body: { dryRun: true } });
  check(handled === true, 'dryRun 请求被处理');
  check(!!top && top.status === 200 && top.payload.ok === true, 'dryRun 返回 200 / ok', top && top.status);
  const items = top?.payload?.items || [];
  const ids = items.map((it) => it.boothId);
  check(ids.includes('9053400') && ids.includes('9000436') && ids.includes('9028816'), '真 fixture 解析出 3 个商品号', ids.slice(0, 3));
  const first = items.find((it) => it.boothId === '9053400');
  check(first && first.title === '🎀SALE🎀【22 avatars】【VRC Hair】SP-008', '解析出真标题', first && first.title);
  check(first && first.shop === 'siropapa', '解析出店铺名', first && first.shop);
  check(first && /^https:\/\/booth\.pximg\.net\//.test(first.coverUrl || ''), '解析出封面图 URL（不下载）', first && first.coverUrl);
  check(first && first.priceText === '', '已购清单没有价格 → priceText 为空');
  check(first && first.isNew === true, '首次都是 isNew:true');
  check(top.payload.pages === 2, '有 rel=next 时翻到第 2 页', top.payload.pages);
  check(top.payload.added === 6 && top.payload.failed === 0, '两页共 6 件全部可解析', { added: top.payload.added, failed: top.payload.failed });
  check(Array.isArray(top.payload.errors) && top.payload.errors.length === 0, '成功时 errors 为空');
  check(top.payload.stopped === undefined, '正常翻完没有 stopped');
}

// ── 2. dryRun 一个字节都不写 ────────────────────────────────────────────────
{
  const { deps, dir } = makeDeps({ plan: planTwoPages() });
  await run(deps, { body: { dryRun: true } });
  check(readJson(dir, 'booth-purchases.json') === null, 'dryRun 不写台帐');
  check(readJson(dir, 'booth-purchases-sync.json') === null, 'dryRun 不写同步状态');
}

// ── 3. 真同步落盘 + 字段 ───────────────────────────────────────────────────
const seeded = makeDeps({ plan: planTwoPages() });
{
  const { deps, dir } = seeded;
  const { top } = await run(deps, { body: { dryRun: false } });
  check(top.payload.added === 6 && top.payload.unchanged === 0, '真同步首次全部 added', { added: top.payload.added });
  const state = readJson(dir, 'booth-purchases.json');
  check(state && state.version === 1 && state.items && Object.keys(state.items).length === 6, '台帐落盘 6 件', state && Object.keys(state.items || {}).length);
  const item = state.items['9000436'];
  check(item && item.title === '[Sale! 11月1日まで] うもれる！AFK', '台帐里存了标题', item && item.title);
  check(item && item.source === 'library-sync', '台帐 source 标成 library-sync', item && item.source);
  check(item && item.coverRel === '' && /^https:\/\/booth\.pximg\.net\//.test(item.coverUrl || ''), '封面只存远程 URL、不产生本地文件');
  check(item && item.lastSyncedAt > 0 && item.addedAt > 0, '有 addedAt / lastSyncedAt');
  check(item && item.itemUrl.includes('/items/9000436'), 'itemUrl 可点回商品页', item && item.itemUrl);
  const status = readJson(dir, 'booth-purchases-sync.json');
  check(status && status.lastSyncAt > 0 && status.lastResult && status.lastResult.added === 6 && status.lastResult.pages === 2, '同步状态落盘（added/pages）', status && status.lastResult);
}

// ── 4. 幂等：第二次 unchanged，且不改 updatedAt ────────────────────────────
{
  const { deps, dir, calls } = seeded;
  const before = readJson(dir, 'booth-purchases.json');
  const { top } = await run(deps, { body: { dryRun: false } });
  check(top.payload.added === 0 && top.payload.unchanged === 6 && top.payload.updated === 0, '第二次同步全部 unchanged', { added: top.payload.added, unchanged: top.payload.unchanged });
  const after = readJson(dir, 'booth-purchases.json');
  check(after.items['9053400'].updatedAt === before.items['9053400'].updatedAt, 'unchanged 不改 updatedAt');
  check(calls.length >= 2, '第二次同步确实发了请求', calls.length);
}

// ── 5. 保留人工补过的非空字段（只补空）────────────────────────────────────
{
  const { deps, dir } = makeDeps({ plan: planTwoPages() });
  fs.writeFileSync(path.join(dir, 'booth-purchases.json'), JSON.stringify({
    version: 1,
    items: {
      '9000436': { boothId: '9000436', title: '人工改过的标题', shopName: '', coverRel: '', addedAt: 1, updatedAt: 1 }
    }
  }));
  await run(deps, { body: { dryRun: false } });
  const state = readJson(dir, 'booth-purchases.json');
  check(state.items['9000436'].title === '人工改过的标题', '已有非空标题不被覆盖');
  check(state.items['9000436'].shopName === 'VRSuya', '空字段被补齐');
  check(Object.keys(state.items).length === 6, '新条目照常加入', Object.keys(state.items).length);
}

// ── 6. 每页请求间隔 ≥900ms（软限速）────────────────────────────────────────
{
  const { deps, calls } = makeDeps({ plan: planTwoPages() });
  await run(deps, { body: { dryRun: true } });
  check(calls.length === 2, '两页两次请求', calls.length);
  const gap = calls.length >= 2 ? calls[1].at - calls[0].at : 0;
  check(gap >= 850, '两页请求间隔 ≥900ms（容差 50ms）', gap);
  check(calls[0].headers.cookie === '_plaza_session_id=abc123; adult=t', '请求带 Cookie');
  check(/Chrome\//.test(calls[0].headers['user-agent'] || ''), '请求带 Chrome UA', calls[0].headers['user-agent']);
  check(calls[0].redirect === 'manual', "fetch 用 redirect:'manual' 判断登录跳转");
}

// ── 7. maxPages 上限：到页数就停 ────────────────────────────────────────────
{
  const { deps } = makeDeps({ plan: planTwoPages() });
  const { top } = await run(deps, { body: { dryRun: true, maxPages: 1 } });
  check(top.payload.stopped === 'max_pages' && top.payload.pages === 1, 'maxPages=1 时停在 max_pages', { stopped: top.payload.stopped, pages: top.payload.pages });
}

// ── 8. 429 限流：停下、保留已抓部分、状态落盘 ──────────────────────────────
{
  const { deps, dir } = makeDeps({
    plan: (url) => (/[?&]page=2/.test(url) ? { status: 429, body: 'too many' } : { status: 200, body: PAGE_FIXTURE })
  });
  const { top } = await run(deps, { body: { dryRun: false } });
  check(top.payload.stopped === 'rate_limited', '429 回 stopped:rate_limited', top.payload.stopped);
  check(top.payload.added === 3 && top.payload.pages === 2, '保留第 1 页已抓的 3 件', { added: top.payload.added });
  check(top.payload.errors.length === 1 && top.payload.errors[0].page === 2, 'errors 记到第 2 页');
  const state = readJson(dir, 'booth-purchases.json');
  check(state && Object.keys(state.items).length === 3, '限流前抓到的条目已落盘', state && Object.keys(state.items || {}).length);
  const status = readJson(dir, 'booth-purchases-sync.json');
  check(status && status.lastResult.stopped === 'rate_limited', '状态里记下 stopped', status && status.lastResult);
}

// ── 9. Cookie 缺失 → 400 且不发请求 ────────────────────────────────────────
{
  const { deps, calls } = makeDeps({ cookie: null });
  const { top } = await run(deps, { body: { dryRun: false } });
  check(top.status === 400 && top.payload.needCookie === true, 'Cookie 缺失回 400 + needCookie', top.status);
  check(/还没登录 BOOTH/.test(top.payload.error || ''), 'Cookie 缺失给的是人话', top.payload.error);
  check(calls.length === 0, 'Cookie 缺失时一次网络请求都不发');
}

// ── 10. 登录失效：3xx 跳登录页 → 401 ───────────────────────────────────────
{
  const { deps } = makeDeps({
    plan: () => ({ status: 302, body: '', headers: { Location: 'https://accounts.booth.pm/users/sign_in' } })
  });
  const { top } = await run(deps, { body: { dryRun: false } });
  check(top.status === 401 && top.payload.needCookie === true, '跳登录页回 401 + needCookie', top.status);
  check(/Cookie 过期了/.test(top.payload.error || ''), '登录失效文案是人话', top.payload.error);
}

// ── 11. 401 直给 → 401 ─────────────────────────────────────────────────────
{
  const { deps } = makeDeps({ plan: () => ({ status: 401, body: 'no' }) });
  const { top } = await run(deps, { body: { dryRun: false } });
  check(top.status === 401 && /401/.test(top.payload.error || ''), 'HTTP 401 也按登录失效处理', top.payload.error);
}

// ── 12. 服务端 500 → stopped:error，不崩 ───────────────────────────────────
{
  const { deps } = makeDeps({ plan: () => ({ status: 500, body: 'boom' }) });
  const { handled, top } = await run(deps, { body: { dryRun: false } });
  check(handled === true && top.status === 200, '500 页不炸、仍回 200 汇总');
  check(top.payload.stopped === 'error' && top.payload.failed === 0, '500 记 stopped:error', { stopped: top.payload.stopped });
  check(top.payload.errors.length === 1 && /HTTP 500/.test(top.payload.errors[0].error || ''), 'errors 里写明 HTTP 500');
}

// ── 13. 状态接口 ───────────────────────────────────────────────────────────
{
  const { deps, dir } = makeDeps({ plan: planTwoPages() });
  const before = await run(deps, { method: 'GET', pathname: '/api/library/purchases/sync/status' });
  check(before.handled === true && before.top.status === 200 && before.top.payload.ok === true, 'status 接口未同步过也回 200');
  check(before.top.payload.lastSyncAt === 0 && before.top.payload.lastResult === null, '未同步过 lastSyncAt=0 / lastResult=null');
  await run(deps, { body: { dryRun: false } });
  const after = await run(deps, { method: 'GET', pathname: '/api/library/purchases/sync/status' });
  check(after.top.payload.lastSyncAt > 0, '同步后 lastSyncAt 有值');
  check(after.top.payload.lastResult.added === 6 && after.top.payload.lastResult.pages === 2, 'lastResult 是最近一次汇总', after.top.payload.lastResult);
  check(readJson(dir, 'booth-purchases-sync.json') !== null, '状态文件确实落盘');
}

// ── 14. 方法/请求体校验 / agent 403 / 未知路径 ─────────────────────────────
{
  const { deps } = makeDeps();
  const get = await run(deps, { method: 'GET', pathname: '/api/library/purchases/sync' });
  check(get.top.status === 405 && /只支持 POST/.test(get.top.payload.error || ''), 'GET /sync → 405 只支持 POST');
  const postStatus = await run(deps, { method: 'POST', pathname: '/api/library/purchases/sync/status', body: {} });
  check(postStatus.top.status === 405 && /只支持 GET/.test(postStatus.top.payload.error || ''), 'POST /status → 405 只支持 GET');
  const agent = await run(deps, { body: {}, headers: { 'x-agent-token': 't' } });
  check(agent.top.status === 403, 'agent 令牌 → 403', agent.top.status);
  const agentStatus = await run(deps, { method: 'GET', pathname: '/api/library/purchases/sync/status', headers: { 'x-agent-token': 't' } });
  check(agentStatus.top.status === 403, 'status 也不许 agent 读', agentStatus.top.status);
  const strDry = await run(deps, { body: { dryRun: 'false' } });
  check(strDry.top.status === 400 && /dryRun 必须是布尔/.test(strDry.top.payload.error || ''), '字符串 dryRun → 400（不当 true）', strDry.top.status);
  const badMax = await run(deps, { body: { maxPages: 0 } });
  check(badMax.top.status === 400 && /maxPages/.test(badMax.top.payload.error || ''), 'maxPages=0 → 400');
  const badBody = await run(deps, { body: ['nope'] });
  check(badBody.top.status === 400 && /JSON 对象/.test(badBody.top.payload.error || ''), '数组请求体 → 400');
  const other = await run(deps, { pathname: '/api/library/trash', body: null });
  check(other.handled === false && other.sent.length === 0, '别的路径不接、不响应');
}

// ── 全局暂停：暂停中开跑直接 409，一个请求都不发 ──────────────────────────
{
  const { deps, dir, calls } = makeDeps();
  fs.writeFileSync(
    path.join(dir, 'booth-search-pause.json'),
    JSON.stringify({ pausedUntil: Date.now() + 5 * 60 * 1000, reason: 'BOOTH 搜索被限速（HTTP 429）', status: 429, at: Date.now() })
  );
  const paused = await run(deps, { body: {} });
  check(paused.top.status === 409 && paused.top.payload.paused === true, '暂停中 POST sync → 409 且 paused:true');
  check(/剩余|分钟|限速/.test(String(paused.top.payload.error)), '回包带暂停原因');
  check(Number(paused.top.payload.retryAfterMs) > 0, 'retryAfterMs 是正数');
  check(calls.length === 0, '暂停中一次 BOOTH 请求都不发');
  fs.rmSync(path.join(dir, 'booth-search-pause.json'), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 429：写全局暂停，暂停文件里能读到 ─────────────────────────────────────
{
  const { deps, dir } = makeDeps({ plan: () => ({ status: 429, body: '', headers: { 'retry-after': '90' } }) });
  const res = await run(deps, { body: {} });
  check(res.top.status === 200 && res.top.payload.stopped === 'rate_limited', '429 → 200 + stopped=rate_limited（旧契约不变）');
  const saved = readJson(dir, 'booth-search-pause.json');
  check(saved && saved.status === 429 && saved.pausedUntil > Date.now(), '429 已写全局暂停（别的 BOOTH 任务也会等）');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 15. 默认拉全量：74 页 / 740 件一次同步完，重跑全 unchanged ───────────────
function bulkPageHtml(page, totalPages) {
  const ids = [];
  for (let i = 0; i < 10; i += 1) ids.push(String(8000000 + page * 100 + i).slice(-7));
  const cards = ids
    .map(
      (id) =>
        `<div class="bg-white p-16"><div class="flex gap-8"><a href="https://booth.pm/zh-cn/items/${id}"><img class="l-library-item-thumbnail" src="https://booth.pximg.net/c/${id}.jpg"></a><div><a href="https://booth.pm/zh-cn/items/${id}"><div class="text-text-default font-bold text-16">Bulk Item ${id}</div></a><a href="https://shop${id.slice(-1)}.booth.pm/"><img alt="shop${id.slice(-1)}"><div class="text-14 text-text-gray600">shop${id.slice(-1)}</div></a></div></div></div>`
    )
    .join('');
  const next = page < totalPages ? `<a rel="next" href="/library?page=${page + 1}">次へ</a>` : '';
  return `<html><body>${cards}${next}</body></html>`;
}
function bulkPlan(totalPages) {
  return (url) => {
    const m = /[?&]page=(\d+)/.exec(url);
    return { status: 200, body: bulkPageHtml(m ? Number(m[1]) : 1, totalPages) };
  };
}

{
  const { deps, dir } = makeDeps({ plan: bulkPlan(74), rateMs: 1 });
  const first = await run(deps, { body: {} });
  check(first.top.status === 200 && first.top.payload.added === 740, '默认不传 maxPages 也能拉全量（74 页 / 740 件）', { added: first.top.payload.added, pages: first.top.payload.pages });
  check(first.top.payload.pages === 74 && first.top.payload.stopped === undefined, '74 页靠 hasNext=false 自然结束，没有 stopped', { pages: first.top.payload.pages, stopped: first.top.payload.stopped });
  const st1 = readJson(dir, 'booth-purchases-sync.json');
  check(st1 && st1.running === false && st1.pages === 74, '结束后 running:false、pages:74 落盘', st1 && { running: st1.running, pages: st1.pages });
  check(st1 && !st1.resumeUrl && st1.resumePage === 0, '正常结束清掉续传断点');
  const { deps: deps2 } = makeDeps({ plan: bulkPlan(74), dir, rateMs: 1 });
  const second = await run(deps2, { body: {} });
  check(second.top.payload.added === 0 && second.top.payload.unchanged === 740, '全量重跑 740 件全 unchanged（幂等）', { added: second.top.payload.added, unchanged: second.top.payload.unchanged });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 16. 300 页保险丝：maxPages 再大也夹到 300，且留续传断点 ─────────────────
{
  const { deps, dir } = makeDeps({ plan: bulkPlan(100000), rateMs: 0 });
  const over = await run(deps, { body: { maxPages: 999 } });
  check(over.top.status === 200 && over.top.payload.pages === 300 && over.top.payload.stopped === 'max_pages', 'maxPages>300 被夹到 300 并在 max_pages 停', { pages: over.top.payload.pages, stopped: over.top.payload.stopped });
  check(/300 页上限/.test(String(over.top.payload.notice || '')), 'max_pages 文案说明「已到 300 页上限，可能还有更多」', over.top.payload.notice);
  const st = readJson(dir, 'booth-purchases-sync.json');
  check(st && /[?&]page=301/.test(st.resumeUrl) && st.resumePage === 301, 'max_pages 断点：resumeUrl=第 301 页', st && { resumePage: st.resumePage });
  check(st && st.lastResult && /300 页上限/.test(String(st.lastResult.notice || '')), '状态里的 lastResult 也带上限文案');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 17. 续传：429 断在第 2 页 → {resume:true} 从第 2 页接着抓，不重抓第 1 页 ──
{
  const { deps, dir } = makeDeps({
    plan: (url) => (/[?&]page=2/.test(url) ? { status: 429, body: '', headers: { 'retry-after': '60' } } : { status: 200, body: PAGE_FIXTURE }),
    rateMs: 0
  });
  const first = await run(deps, { body: {} });
  check(first.top.payload.stopped === 'rate_limited' && first.top.payload.added === 3, '429 停在第 2 页，保留第 1 页 3 件');
  const pausedStatus = readJson(dir, 'booth-purchases-sync.json');
  check(pausedStatus && /[?&]page=2/.test(pausedStatus.resumeUrl) && pausedStatus.resumePage === 2, '429 后 status 存 resumeUrl/resumePage', pausedStatus && { resumePage: pausedStatus.resumePage });
  check(pausedStatus && pausedStatus.running === false, '429 后 running:false（前端可以提示继续）');
  fs.rmSync(path.join(dir, 'booth-search-pause.json'), { force: true });
  const { deps: deps2, calls: calls2 } = makeDeps({ plan: planTwoPages(), dir, rateMs: 0 });
  const second = await run(deps2, { body: { resume: true } });
  check(calls2.length === 1 && /[?&]page=2/.test(calls2[0].url), '{resume:true} 第一个请求就是第 2 页（跳过第 1 页）', calls2.map((c) => c.url));
  check(second.top.payload.resumed === true && second.top.payload.pages === 2, '续传回包 resumed:true、pages 从断点算', { resumed: second.top.payload.resumed, pages: second.top.payload.pages });
  check(second.top.payload.added === 3 && second.top.payload.errors.length === 0, '续传只抓第 2 页，新增 3 件、无错误', { added: second.top.payload.added });
  const merged = readJson(dir, 'booth-purchases.json');
  check(merged && Object.keys(merged.items).length === 6, '续传后台账两页共 6 件（第 1 页没被重抓也没丢）', merged && Object.keys(merged.items).length);
  const resumedStatus = readJson(dir, 'booth-purchases-sync.json');
  check(resumedStatus && !resumedStatus.resumeUrl && resumedStatus.resumePage === 0, '续传成功后清掉断点');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 18. 每页进度可见：抓第 2 页时 status 已经 running:true / pages:1 ─────────
{
  let dirRef = null;
  let mid = null;
  const { deps, dir } = makeDeps({
    rateMs: 0,
    plan: (url) => {
      const m = /[?&]page=(\d+)/.exec(url);
      const page = m ? Number(m[1]) : 1;
      if (page === 2) mid = readJson(dirRef, 'booth-purchases-sync.json');
      return { status: 200, body: page <= 1 ? PAGE_FIXTURE : PAGE2_FIXTURE };
    }
  });
  dirRef = dir;
  const out = await run(deps, { body: {} });
  check(mid && mid.running === true && mid.pages === 1 && mid.startedAt > 0, '每页 flush：抓第 2 页时 status 已 running:true、pages:1', mid && { running: mid.running, pages: mid.pages });
  check(mid && Number(mid.totalPagesHint) >= 2, 'status 带 totalPagesHint（分页器里的页码）', mid && mid.totalPagesHint);
  const after = readJson(dir, 'booth-purchases-sync.json');
  check(after && after.running === false && after.pages === 2 && after.startedAt > 0, '结束后写 running:false / pages:2 / startedAt', after && { running: after.running, pages: after.pages });
  check(out.top.payload.pages === 2 && out.top.payload.stopped === undefined, '正常两页同步完成');
  const statusApi = await run(deps, { method: 'GET', pathname: '/api/library/purchases/sync/status' });
  check(statusApi.top.payload.running === false && statusApi.top.payload.pages === 2 && statusApi.top.payload.resumePage === 0, 'GET /sync/status 带 running/pages/resumePage', { running: statusApi.top.payload.running, pages: statusApi.top.payload.pages });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 19. dryRun 的 items 绝不写进台账（连字节都不改）─────────────────────────
{
  const { deps, dir } = makeDeps({ plan: planTwoPages(), rateMs: 0 });
  const seeded = {
    version: 1,
    items: { '9053400': { boothId: '9053400', title: '人工改过的标题', shopName: 'siropapa', itemUrl: 'https://booth.pm/ja/items/9053400', source: 'manual' } }
  };
  fs.writeFileSync(path.join(dir, 'booth-purchases.json'), JSON.stringify(seeded, null, 2));
  const before = fs.readFileSync(path.join(dir, 'booth-purchases.json'), 'utf8');
  await run(deps, { body: { dryRun: true } });
  const after = fs.readFileSync(path.join(dir, 'booth-purchases.json'), 'utf8');
  check(before === after, 'dryRun 一个字节都不改台账（识别结果不落库）');
  check(readJson(dir, 'booth-purchases-sync.json') === null, 'dryRun 不写同步状态');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 20. 购买日期：能解析就记、解析不到留空、已有不覆盖 ─────────────────────
// 2026-10 真机的已购清单页其实没有「購入日」，所以这一段用构造 HTML 覆盖三种将来格式；
// 真机验收见交付说明（页面无日期 → 字段留空，不编）。
function cardHtml(id, extra = '') {
  return `<div class="bg-white p-16"><div class="flex gap-8"><a href="https://booth.pm/zh-cn/items/${id}"><img class="l-library-item-thumbnail" src="https://booth.pximg.net/c/${id}.jpg"></a><div><a href="https://booth.pm/zh-cn/items/${id}"><div class="text-text-default font-bold text-16">Item ${id}</div></a>${extra}</div></div></div>`;
}
function pageOf(html) {
  return `<html><body>${html}</body></html>`;
}

{
  const cases = [
    { id: '9111001', extra: '<div class="text-12">購入日 2026/09/25</div>', at: Date.UTC(2026, 8, 25), name: '購入日 2026/09/25' },
    { id: '9111002', extra: '<div class="text-12">2026年9月25日</div>', at: Date.UTC(2026, 8, 25), name: '2026年9月25日' },
    { id: '9111003', extra: '<time datetime="2026-09-25T12:00:00+09:00">9/25</time>', at: Date.UTC(2026, 8, 25), name: '<time datetime>' },
    { id: '9111004', extra: '<div>購入日 2026/13/45</div>', at: 0, name: '脏日期 2026/13/45' },
    { id: '9111005', extra: '', at: 0, name: '没有日期字段' }
  ];
  for (const c of cases) {
    const { deps, dir } = makeDeps({ plan: () => ({ status: 200, body: pageOf(cardHtml(c.id, c.extra)) }), rateMs: 0 });
    await run(deps, { body: {} });
    const ledger = readJson(dir, 'booth-purchases.json');
    const item = ledger && ledger.items && ledger.items[c.id];
    check(!!item, `购买日期用例 ${c.name}：条目已入库`);
    check((item && item.purchasedAt) === c.at, `购买日期用例 ${c.name}：purchasedAt=${c.at}`, item && item.purchasedAt);
    if (c.at) check(!!item && typeof item.purchasedAtText === 'string' && item.purchasedAtText.length > 0, `购买日期用例 ${c.name}：purchasedAtText 非空`, item && item.purchasedAtText);
    if (!c.at) check(!item || (!item.purchasedAt && !item.purchasedAtText), `购买日期用例 ${c.name}：不编日期、两个字段都不留`, item && { at: item.purchasedAt, text: item.purchasedAtText });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  // 已有 purchasedAt 不能被后来的页面覆盖（人工/早先同步的真相优先）。
  const { deps, dir } = makeDeps({ plan: () => ({ status: 200, body: pageOf(cardHtml('9111011', '<div>購入日 2026/10/01</div>')) }), rateMs: 0 });
  fs.writeFileSync(path.join(dir, 'booth-purchases.json'), JSON.stringify({
    version: 1,
    items: { '9111011': { boothId: '9111011', title: '旧标题', purchasedAt: 111, purchasedAtText: '老日期', source: 'library-sync' } }
  }, null, 2));
  await run(deps, { body: {} });
  const item = readJson(dir, 'booth-purchases.json').items['9111011'];
  check(item.purchasedAt === 111 && item.purchasedAtText === '老日期', '已有 purchasedAt 不覆盖（幂等）', { at: item.purchasedAt, text: item.purchasedAtText });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n========== 通过 ${passed} / 失败 ${failures.length} ==========`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
