// 已购库（BOOTH 商品资料库）：把用户买过/看上的 BOOTH 商品抓成一份本地台账，
// 控制台可以搜索、按标签筛、看封面，不用每次回 BOOTH 翻订单。
//
// 约束：本文件是 manifest 模块，被 scripts/bridge-source.mjs 用 vm.runInContext 裸执行，
// **不能 import**。页面解析规则来自 src/booth-product.js（parseItemUrl / parseBoothItemHtml /
// summarizeModels / describePurchaseItem），搜索规则来自 src/booth-search.js；两者都由
// src/bridge.js 组装成 deps.boothProductPure / deps.boothSearchPure 传进来，测试里塞假实现即可。
// 顶部不要有和 src/bridge.js 同名的 const/let（VM 里共用一个全局词法作用域）。
//
// 布局：
//   state/booth-purchases.json           台账（items 以 boothId 为键）
//   state/booth-purchase-covers/<id>.jpg 展示图（抓不到就留空 coverRel）
//   列表封面降级：本地图 > 台账里的远程 coverUrl（清单页同步来的）> 空串，前端用 coverRemote 区分。
//
// 路由（全部管理端，x-agent-token 一律 403）：
//   POST /api/library/purchases/resolve  {url} 或 {text}  链接→已解析商品；文字→搜索候选（最多 8 个）
//   POST /api/library/purchases/import   {urls?, boothIds?} 抓商品页 + 封面 → 落盘
//   GET  /api/library/purchases?q=&tag=&page=&limit=       分页列表 + tags 聚合 + total
//   POST /api/library/purchases/refresh  {boothIds?}       重抓已有条目（不给号就全部）
//   POST /api/library/purchases/remove   {boothId}         删条目 + 删本地封面
//   POST /api/library/purchases/ocr      {}                占位：本地没有 OCR 引擎，别假装能识别
//   GET  /api/library/purchases/cover?boothId=             读本地封面（前端 <img> 直接用）

const LIBPUR_UE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const LIBPUR_ITEM_BASE = 'https://booth.pm/ja/items/';
const LIBPUR_TIMEOUT_MS = 8000;                 // 商品页/封面单次抓取上限
const LIBPUR_MAX_HTML_BYTES = 3 * 1024 * 1024;  // 商品页正常 100~300KB，3MB 已经很宽
const LIBPUR_MAX_COVER_BYTES = 5 * 1024 * 1024;
const LIBPUR_RATE_LIMIT_MS = 900;               // 与找号同档：BOOTH 有 1 秒/次的软限制
const LIBPUR_STATE_FILE = 'booth-purchases.json';
const LIBPUR_COVER_DIR = 'booth-purchase-covers';
const LIBPUR_PAUSE_FILE = 'booth-search-pause.json'; // 与找号/以图搜源共用同一个暂停闸
const LIBPUR_VERSION = 1;
const LIBPUR_DEFAULT_LIMIT = 30;
const LIBPUR_MAX_LIMIT = 100;
const LIBPUR_MAX_IMPORT = 30;
const LIBPUR_SEARCH_LIMIT = 8;                  // resolve 文字模式最多回几个候选
const LIBPUR_TAG_LIMIT = 60;
const LIBPUR_BOOTH_ID_RE = /^\d{5,9}$/;
const LIBPUR_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 路径与台账读写 ──────────────────────────────────────────────────────────
function libpurStatePath(deps) {
  return deps.path.join(String(deps.STATE_DIR), LIBPUR_STATE_FILE);
}

function libpurCoverDirAbs(deps) {
  return deps.path.join(String(deps.STATE_DIR), LIBPUR_COVER_DIR);
}

function libpurCoverAbs(deps, boothId) {
  // 只拼固定目录 + 已校验过的纯数字号：不做任何用户输入路径拼接（防目录穿越）。
  return deps.path.join(libpurCoverDirAbs(deps), `${boothId}.jpg`);
}

function libpurCoverRel(boothId) {
  return `${LIBPUR_COVER_DIR}/${boothId}.jpg`;
}

function libpurPausePath(deps) {
  return deps.path.join(String(deps.STATE_DIR), LIBPUR_PAUSE_FILE);
}

function libpurEmptyState() {
  return { version: LIBPUR_VERSION, items: {} };
}

function libpurStr(value, max) {
  return String(value ?? '').slice(0, max);
}

function libpurStrList(value, maxItems, maxLen) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const raw of list) {
    const text = libpurStr(raw, maxLen).trim();
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** 单条记录规整：读盘/外部输入都走这里，坏字段不扔整份台账。 */
function libpurNormalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const boothId = String(raw.boothId ?? '').trim();
  if (!LIBPUR_BOOTH_ID_RE.test(boothId)) return null;
  const models = raw.models && typeof raw.models === 'object' ? raw.models : {};
  const item = {
    boothId,
    title: libpurStr(raw.title, 300),
    shopName: libpurStr(raw.shopName, 120),
    shopUrl: libpurStr(raw.shopUrl, 500),
    priceText: libpurStr(raw.priceText, 60),
    tags: libpurStrList(raw.tags, 30, 60),
    categories: libpurStrList(raw.categories, 8, 60),
    models: {
      max: Math.max(0, Math.trunc(Number(models.max) || 0)),
      total: Math.max(0, Math.trunc(Number(models.total) || 0)),
      labeled: Math.max(0, Math.trunc(Number(models.labeled) || 0))
    },
    itemUrl: libpurStr(raw.itemUrl, 500) || `${LIBPUR_ITEM_BASE}${boothId}`,
    coverRel: libpurStr(raw.coverRel, 300),
    addedAt: Math.max(0, Number(raw.addedAt) || 0),
    updatedAt: Math.max(0, Number(raw.updatedAt) || 0),
    source: libpurStr(raw.source, 40) || 'import'
  };
  // coverUrl 是「清单页同步」带进来的远程封面（import/refresh 抓到的图已经落成本地 coverRel）。
  // 只有台账里真有才保留：老条目/手工导入的字段集合不变，列表侧再决定用本地图还是它兜底。
  const remoteCover = libpurStr(raw.coverUrl, 1000);
  if (remoteCover) item.coverUrl = remoteCover;
  const purchasedAt = Math.max(0, Number(raw.purchasedAt) || 0); if (purchasedAt) item.purchasedAt = purchasedAt; // 购买日期（清单同步）：有才保留
  const purchasedText = libpurStr(raw.purchasedAtText, 40).trim(); if (purchasedText) item.purchasedAtText = purchasedText;
  return item;
}
function libpurNormalizeState(raw) {
  const state = libpurEmptyState();
  const items = raw && typeof raw === 'object' && raw.items && typeof raw.items === 'object' ? raw.items : null;
  if (raw && typeof raw === 'object' && Number(raw.version) > 0) state.version = Math.trunc(Number(raw.version)) || LIBPUR_VERSION;
  if (!items) return state;
  for (const key of Object.keys(items)) {
    const item = libpurNormalizeItem(items[key]);
    if (item) state.items[item.boothId] = item;
  }
  return state;
}

function libpurLoadState(deps) {
  try {
    return libpurNormalizeState(JSON.parse(deps.fs.readFileSync(libpurStatePath(deps), 'utf8')));
  } catch {
    // 读坏了当空台账：不能因为一个脏 JSON 让「已购库」永久打不开。
    return libpurEmptyState();
  }
}

function libpurSaveState(deps, state) {
  try {
    deps.atomicWriteJson(libpurStatePath(deps), state);
  } catch (error) {
    deps.log(`已购库写盘失败：${error?.message ?? error}`);
  }
  return state;
}

// ── 全局暂停闸（与找号共用 state/booth-search-pause.json）───────────────────
function libpurReadPause(deps) {
  try {
    const raw = JSON.parse(deps.fs.readFileSync(libpurPausePath(deps), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function libpurPauseText(pause, now) {
  const remain = Math.max(0, Number(pause?.pausedUntil || 0) - now);
  const seconds = Math.max(1, Math.ceil(remain / 1000));
  return `BOOTH 限流暂停中（${pause?.reason || 'HTTP 429'}）：还要等约 ${seconds} 秒，之后再试`;
}

function libpurPausedNow(deps) {
  const pause = libpurReadPause(deps);
  const until = Number(pause?.pausedUntil || 0);
  const now = Date.now();
  if (until > now) return { paused: true, until, reason: String(pause?.reason || ''), text: libpurPauseText(pause, now) };
  return { paused: false, until: 0, reason: '', text: '' };
}

/** 只对 429（明确的限流信号）落暂停；403 通常是单件被拒（年龄/区域），停了只会误伤整库。 */
function libpurNoteThrottle(deps, statusCode) {
  if (Number(statusCode) !== 429) return null;
  try {
    const now = Date.now();
    const pause = { pausedUntil: now + 60 * 1000, reason: 'HTTP 429', status: 429, at: now };
    deps.atomicWriteJson(libpurPausePath(deps), pause);
    deps.log(`已购库触发保护闸：${libpurPauseText(pause, now)}`);
    return pause;
  } catch (error) {
    deps.log(`已购库暂停状态写盘失败：${error?.message ?? error}`);
    return null;
  }
}

// ── 网络：商品页与封面（串行 + 限速 + 超时 + 体积上限）────────────────────
async function libpurThrottle(ctx) {
  const wait = LIBPUR_RATE_LIMIT_MS - (Date.now() - ctx.lastNetworkAt);
  if (wait > 0) await LIBPUR_SLEEP(wait);
  ctx.lastNetworkAt = Date.now();
}

async function libpurFetchText(ctx, url, accept) {
  const paused = libpurPausedNow(ctx.deps);
  if (paused.paused) return { ok: false, paused: true, error: paused.text };
  await libpurThrottle(ctx);
  let res;
  try {
    res = await ctx.deps.fetch(url, {
      headers: { 'user-agent': LIBPUR_UE, accept: accept || 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9,ja;q=0.8' },
      signal: ctx.deps.AbortSignal.timeout(LIBPUR_TIMEOUT_MS)
    });
  } catch (error) {
    return { ok: false, error: `抓取失败：${error?.message ?? error}` };
  }
  const code = Number(res?.status) || 0;
  if (code === 404) return { ok: false, status: 404, error: '商品不存在（HTTP 404）' };
  if (code === 403) return { ok: false, status: 403, error: '被拒绝访问（HTTP 403，可能需要登录/区域限制）' };
  if (code === 429) {
    const pause = libpurNoteThrottle(ctx.deps, code);
    return { ok: false, paused: Boolean(pause), status: 429, error: pause ? libpurPauseText(pause, Date.now()) : 'BOOTH 限流（HTTP 429），稍后再试' };
  }
  if (code < 200 || code >= 300) return { ok: false, status: code, error: `商品页 HTTP ${code}` };
  let text = '';
  try {
    text = String(await res.text()).replace(/^\uFEFF/, '');
  } catch (error) {
    return { ok: false, error: `读取响应失败：${error?.message ?? error}` };
  }
  const bytes = typeof ctx.BUF?.byteLength === 'function' ? ctx.BUF.byteLength(text, 'utf8') : text.length;
  if (bytes > LIBPUR_MAX_HTML_BYTES) return { ok: false, error: '商品页超过 3MB 上限' };
  return { ok: true, text };
}

async function libpurFetchImage(ctx, url) {
  await libpurThrottle(ctx);
  let res;
  try {
    res = await ctx.deps.fetch(url, {
      headers: { 'user-agent': LIBPUR_UE, accept: 'image/avif,image/webp,image/jpeg,image/*' },
      signal: ctx.deps.AbortSignal.timeout(LIBPUR_TIMEOUT_MS)
    });
  } catch (error) {
    return { ok: false, error: `封面抓取失败：${error?.message ?? error}` };
  }
  const code = Number(res?.status) || 0;
  if (code < 200 || code >= 300) return { ok: false, error: `封面 HTTP ${code}` };
  let buf = null;
  try {
    const raw = await res.arrayBuffer();
    if (!raw || !Number(raw.byteLength)) return { ok: false, error: '封面是空的' };
    if (raw.byteLength > LIBPUR_MAX_COVER_BYTES) return { ok: false, error: '封面超过 5MB 上限' };
    buf = ctx.BUF.from(raw);
  } catch (error) {
    return { ok: false, error: `封面读取失败：${error?.message ?? error}` };
  }
  return { ok: true, buffer: buf };
}

/** 抓商品页 → 解析。解析规则来自 src/booth-product.js（纯函数，测试可替换）。 */
async function libpurFetchItem(ctx, boothId) {
  const page = await libpurFetchText(ctx, `${LIBPUR_ITEM_BASE}${boothId}`);
  if (!page.ok) return { ok: false, paused: Boolean(page.paused), error: page.error };
  return libpurParseItem(ctx, page.text, boothId);
}

function libpurParseItem(ctx, html, boothId) {
  const pure = ctx.productPure || {};
  if (typeof pure.parseBoothItemHtml !== 'function') {
    return { ok: false, error: '解析模块没装配（deps.boothProductPure 缺失），没法解析商品页' };
  }
  let parsed = null;
  try {
    parsed = pure.parseBoothItemHtml(html);
  } catch (error) {
    return { ok: false, error: `解析失败：${error?.message ?? error}` };
  }
  if (!parsed || typeof parsed !== 'object' || !String(parsed.title ?? '').trim()) {
    return { ok: false, error: '页面解析失败（可能不是商品页，或 BOOTH 改版了）' };
  }
  const item = libpurRecordFromParsed(parsed, boothId);
  const coverUrl = String(parsed.coverUrl || (Array.isArray(parsed.images) ? parsed.images[0] : '') || '').trim();
  return { ok: true, item, coverUrl };
}

/** 解析结果 → 台账记录（存储字段按约定；抓到的封面图当场下载成 coverRel，远程 URL 只给当场下载用）。 */
function libpurRecordFromParsed(parsed, fallbackId) {
  const boothId = String(parsed.boothId || fallbackId || '').trim();
  const models = parsed.models && typeof parsed.models === 'object' ? parsed.models : {};
  return {
    boothId,
    title: libpurStr(parsed.title, 300),
    shopName: libpurStr(parsed.shopName, 120),
    shopUrl: libpurStr(parsed.shopUrl, 500),
    priceText: libpurStr(parsed.priceText, 60),
    tags: libpurStrList(parsed.tags, 30, 60),
    categories: libpurStrList(parsed.categories, 8, 60),
    models: {
      max: Math.max(0, Math.trunc(Number(models.max) || 0)),
      total: Math.max(0, Math.trunc(Number(models.total) || 0)),
      labeled: Math.max(0, Math.trunc(Number(models.labeled) || 0))
    },
    itemUrl: libpurStr(parsed.itemUrl, 500) || `${LIBPUR_ITEM_BASE}${boothId}`,
    coverRel: '',
    addedAt: 0,
    updatedAt: 0,
    source: 'import'
  };
}

// ── 封面落盘 ────────────────────────────────────────────────────────────────
async function libpurSaveCover(ctx, boothId, coverUrl) {
  const url = String(coverUrl || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return '';
  const got = await libpurFetchImage(ctx, url);
  if (!got.ok) {
    ctx.deps.log(`已购库封面跳过（${boothId}）：${got.error}`);
    return '';
  }
  try {
    ctx.deps.fs.mkdirSync(libpurCoverDirAbs(ctx.deps), { recursive: true });
    ctx.deps.fs.writeFileSync(libpurCoverAbs(ctx.deps, boothId), got.buffer);
    return libpurCoverRel(boothId);
  } catch (error) {
    ctx.deps.log(`已购库封面写盘失败（${boothId}）：${error?.message ?? error}`);
    return '';
  }
}

function libpurRemoveCover(deps, boothId) {
  try {
    const abs = libpurCoverAbs(deps, boothId);
    if (deps.fs.existsSync(abs)) deps.fs.unlinkSync(abs);
  } catch (error) {
    deps.log(`已购库删封面失败（${boothId}）：${error?.message ?? error}`);
  }
}

// ── 单条 upsert（import / refresh 共用）────────────────────────────────────
async function libpurUpsertOne(ctx, state, boothId, opts = {}) {
  const fetched = await libpurFetchItem(ctx, boothId);
  if (!fetched.ok) return { ok: false, paused: Boolean(fetched.paused), error: fetched.error };
  const prev = state.items[boothId] || null;
  const record = {
    ...fetched.item,
    boothId,
    addedAt: prev?.addedAt || Number(opts.now) || Date.now(),
    updatedAt: Number(opts.now) || Date.now(),
    source: libpurStr(opts.source || prev?.source, 40) || 'import'
  };
  // 封面是「锦上添花」：抓不到就沿用旧封面（没有就留空），不能因为图挂了把整条资料判失败。
  const coverRel = await libpurSaveCover(ctx, boothId, fetched.coverUrl);
  record.coverRel = coverRel || libpurStr(prev?.coverRel, 300);
  // 清单页同步来的远程封面照旧留着：本地图没下载成功时列表要用它兜底。
  record.coverUrl = libpurStr(prev?.coverUrl, 1000);
  state.items[boothId] = libpurNormalizeItem(record);
  libpurSaveState(ctx.deps, state);
  return { ok: true, added: !prev, item: state.items[boothId], state };
}

// ── 展示层（列表/详情共用的派生字段）────────────────────────────────────────
function libpurDescribe(ctx, item) {
  const pure = ctx.productPure || {};
  if (typeof pure.describePurchaseItem !== 'function') return '';
  try {
    return libpurStr(pure.describePurchaseItem(item), 140);
  } catch {
    return '';
  }
}

function libpurPublicItem(ctx, item) {
  const hasCover = Boolean(item.coverRel) && libpurCoverExists(ctx.deps, item.boothId);
  // 封面降级：本地有图走本地接口（快、离线可用）；没下载到本地就退回台账里的远程图
  // （清单页同步来的 coverUrl）。以前这里一律回空串，把远程封面抹掉了。
  const remote = libpurStr(item.coverUrl, 1000);
  const remoteOk = /^https?:\/\//i.test(remote);
  return {
    ...item,
    coverUrl: hasCover ? `/api/library/purchases/cover?boothId=${item.boothId}&v=${item.updatedAt}` : (remoteOk ? remote : ''),
    // 前端要知道这张是远程图还是本地图：远程图可能在离线/防盗链时挂掉，可以显示占位图兜底。
    coverRemote: !hasCover && remoteOk,
    desc: libpurDescribe(ctx, item)
  };
}

function libpurCoverExists(deps, boothId) {
  try {
    return deps.fs.existsSync(libpurCoverAbs(deps, boothId));
  } catch {
    return false;
  }
}

function libpurAllItems(state) {
  return Object.keys(state.items).map((key) => state.items[key]).filter(Boolean);
}

function libpurTagsOf(items) {
  const counts = new Map();
  for (const item of items) {
    for (const tag of item.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, LIBPUR_TAG_LIMIT);
}

function libpurFilterItems(items, { q = '', tag = '' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  const tagNeedle = String(tag || '').trim();
  return items.filter((item) => {
    if (tagNeedle && !(item.tags || []).includes(tagNeedle)) return false;
    if (!needle) return true;
    return String(item.title || '').toLowerCase().includes(needle)
      || String(item.shopName || '').toLowerCase().includes(needle)
      || String(item.boothId || '').includes(needle)
      || String(item.priceText || '').toLowerCase().includes(needle);
  });
}

function libpurSortItems(items) {
  return items.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
    || (b.addedAt || 0) - (a.addedAt || 0)
    || String(a.boothId).localeCompare(String(b.boothId)));
}

// ── 请求小工具 ──────────────────────────────────────────────────────────────
async function libpurReadJsonBody(readBody) {
  let body = null;
  try {
    body = await readBody();
  } catch (error) {
    return { ok: false, error: error?.message ?? '请求体非法' };
  }
  if (body === null || body === undefined || typeof body !== 'object') return { ok: true, body: {} };
  return { ok: true, body };
}

function libpurUrlParser(ctx) {
  const pure = ctx.productPure || {};
  if (typeof pure.parseItemUrl === 'function') {
    return (raw) => {
      try {
        return String(pure.parseItemUrl(raw) ?? '') || '';
      } catch {
        return '';
      }
    };
  }
  // 解析模块没装配时的保守回退：只认 /items/<id>、#<id>、纯数字三种写法。
  return (raw) => {
    const text = String(raw ?? '').trim();
    if (LIBPUR_BOOTH_ID_RE.test(text)) return text;
    const m = /(?:items|i)\/(\d{5,9})(?:[/?#]|$)/i.exec(text) || /#(\d{5,9})\b/.exec(text);
    return m ? m[1] : '';
  };
}

/** 搜索页 → 候选列表（resolve 纯文字模式用）。 */
async function libpurSearchCandidates(ctx, request) {
  const booth = ctx.boothPure || {};
  const { buildBoothSearchUrl, parseBoothSearchHtml, searchPhrasesFor, rankBoothCandidates } = booth;
  if (typeof buildBoothSearchUrl !== 'function' || typeof parseBoothSearchHtml !== 'function' || typeof searchPhrasesFor !== 'function') {
    return { ok: false, error: '搜索模块没装配（deps.boothSearchPure 缺失）' };
  }
  const query = libpurStr(request, 120).trim();
  let phrases = [];
  try {
    phrases = (searchPhrasesFor({ title: query }) || []).map((p) => libpurStr(p, 120).trim()).filter(Boolean).slice(0, 2);
  } catch {
    phrases = [];
  }
  if (!phrases.length) phrases = [query];
  const errors = [];
  const seen = new Map();
  for (const phrase of phrases) {
    let url = '';
    try {
      url = buildBoothSearchUrl({ query: phrase });
    } catch (error) {
      errors.push(String(error?.message ?? error));
      continue;
    }
    const page = await libpurFetchText(ctx, url);
    if (!page.ok) {
      errors.push(page.error);
      if (page.paused) return { ok: false, paused: true, error: page.error, phrases, candidates: [], errors };
      continue;
    }
    let parsed = null;
    try {
      parsed = parseBoothSearchHtml(page.text);
    } catch (error) {
      errors.push(`搜索页解析失败：${error?.message ?? error}`);
      continue;
    }
    for (const item of parsed.items || []) {
      if (item && item.boothId && !seen.has(String(item.boothId))) seen.set(String(item.boothId), item);
    }
  }
  const pool = [...seen.values()];
  let ranked = pool;
  if (typeof rankBoothCandidates === 'function' && pool.length) {
    try {
      ranked = rankBoothCandidates({ title: query, candidates: pool });
    } catch {
      ranked = pool;
    }
  }
  const candidates = ranked.slice(0, LIBPUR_SEARCH_LIMIT).map((cand) => ({
    boothId: String(cand.boothId || ''),
    title: libpurStr(cand.title, 300),
    shopName: libpurStr(cand.shopName, 120),
    shopUrl: libpurStr(cand.shopUrl, 500),
    priceText: Number.isFinite(Number(cand.price)) ? `¥ ${Number(cand.price)}` : '',
    coverUrl: libpurStr(cand.thumbUrl, 1000),
    itemUrl: libpurStr(cand.itemUrl, 500) || `${LIBPUR_ITEM_BASE}${cand.boothId}`,
    score: Math.round((Number(cand.score) || 0) * 1000) / 1000,
    reasons: Array.isArray(cand.reasons) ? cand.reasons.slice(0, 4).map((r) => libpurStr(r, 120)) : []
  }));
  return { ok: true, phrases, candidates, total: pool.length, errors };
}

// ── 路由实现（不在 @bridge-function 标记里：分派只做读请求，逻辑按动作分文件内函数）──
async function libpurResolveRoute(ctx, request) {
  const bodyResult = await libpurReadJsonBody(request.readBody);
  if (!bodyResult.ok) { request.sendJson({ ok: false, error: bodyResult.error }, 400); return true; }
  const body = bodyResult.body || {};
  const rawUrl = libpurStr(body.url, 1000).trim();
  const rawText = libpurStr(body.text, 300).trim();
  if (!rawUrl && !rawText) {
    request.sendJson({ ok: false, error: '要给出 BOOTH 商品链接（url）或商品名（text）' }, 400);
    return true;
  }
  if (rawUrl) {
    const boothId = libpurUrlParser(ctx)(rawUrl);
    if (!boothId || !LIBPUR_BOOTH_ID_RE.test(boothId)) {
      request.sendJson({ ok: false, error: '这不是 BOOTH 商品链接（应形如 https://booth.pm/ja/items/1234567）；只有名字就用 text 字段' }, 400);
      return true;
    }
    const fetched = await libpurFetchItem(ctx, boothId);
    if (!fetched.ok) {
      request.sendJson({ ok: false, paused: Boolean(fetched.paused), error: fetched.error }, fetched.paused ? 409 : 502);
      return true;
    }
    const state = libpurLoadState(ctx.deps);
    const stored = state.items[boothId] || null;
    request.sendJson({
      ok: true,
      mode: 'item',
      boothId,
      stored: Boolean(stored),
      item: {
        ...fetched.item,
        addedAt: stored?.addedAt || 0,
        updatedAt: stored?.updatedAt || 0,
        coverRel: stored?.coverRel || '',
        coverUrl: fetched.coverUrl,
        desc: libpurDescribe(ctx, fetched.item)
      }
    });
    return true;
  }
  const found = await libpurSearchCandidates(ctx, rawText);
  if (!found.ok) {
    request.sendJson({ ok: false, paused: Boolean(found.paused), error: found.error, candidates: found.candidates || [], errors: found.errors || [] }, found.paused ? 409 : 502);
    return true;
  }
  request.sendJson({ ok: true, mode: 'search', query: rawText, phrases: found.phrases, candidates: found.candidates, total: found.total, errors: found.errors });
  return true;
}

async function libpurImportRoute(ctx, request) {
  const bodyResult = await libpurReadJsonBody(request.readBody);
  if (!bodyResult.ok) { request.sendJson({ ok: false, error: bodyResult.error }, 400); return true; }
  const body = bodyResult.body || {};
  const parseUrl = libpurUrlParser(ctx);
  const failed = [];
  const targets = [];
  const rawUrls = Array.isArray(body.urls) ? body.urls : (typeof body.url === 'string' ? [body.url] : []);
  for (const raw of rawUrls) {
    const text = libpurStr(raw, 1000).trim();
    if (!text) continue;
    const id = parseUrl(text);
    if (!id || !LIBPUR_BOOTH_ID_RE.test(id)) {
      failed.push({ url: text, error: '不是 BOOTH 商品链接（应形如 https://booth.pm/ja/items/1234567）' });
      continue;
    }
    targets.push(id);
  }
  const rawIds = Array.isArray(body.boothIds) ? body.boothIds : (body.boothId !== undefined ? [body.boothId] : []);
  for (const raw of rawIds) {
    const id = String(raw ?? '').trim();
    if (!LIBPUR_BOOTH_ID_RE.test(id)) {
      failed.push({ url: id, error: 'BOOTH 号必须是 5~9 位数字' });
      continue;
    }
    targets.push(id);
  }
  const unique = [...new Set(targets)].slice(0, LIBPUR_MAX_IMPORT);
  if (!unique.length && !failed.length) {
    request.sendJson({ ok: false, error: '没有要导入的（给 urls 链接或 boothIds 号）' }, 400);
    return true;
  }
  const pause = libpurPausedNow(ctx.deps);
  if (pause.paused) {
    request.sendJson({ ok: false, paused: true, error: pause.text, added: 0, updated: 0, failed, total: Object.keys(libpurLoadState(ctx.deps).items).length }, 409);
    return true;
  }
  let state = libpurLoadState(ctx.deps);
  let added = 0;
  let updated = 0;
  let stopped = '';
  for (const boothId of unique) {
    const now = libpurPausedNow(ctx.deps);
    if (now.paused) { stopped = now.text; break; }
    const got = await libpurUpsertOne(ctx, state, boothId, { source: 'import' });
    if (!got.ok) { failed.push({ url: `${LIBPUR_ITEM_BASE}${boothId}`, error: got.error }); continue; }
    state = got.state;
    if (got.added) added += 1;
    else updated += 1;
  }
  const total = Object.keys(state.items).length;
  const payload = { ok: true, added, updated, failed, total };
  if (stopped) payload.paused = true;
  if (stopped) payload.error = stopped;
  request.sendJson(payload);
  return true;
}

function libpurListRoute(ctx, request) {
  const state = libpurLoadState(ctx.deps);
  const params = request.url.searchParams;
  const q = libpurStr(params.get('q'), 120).trim();
  const tag = libpurStr(params.get('tag'), 60).trim();
  const pageRaw = Math.trunc(Number(params.get('page')) || 1);
  const limitRaw = Math.trunc(Number(params.get('limit')) || LIBPUR_DEFAULT_LIMIT);
  const page = pageRaw > 0 ? pageRaw : 1;
  const limit = Math.min(LIBPUR_MAX_LIMIT, limitRaw > 0 ? limitRaw : LIBPUR_DEFAULT_LIMIT);
  const all = libpurAllItems(state);
  const filtered = libpurSortItems(libpurFilterItems(all, { q, tag }));
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const start = (page - 1) * limit;
  const items = filtered.slice(start, start + limit).map((item) => libpurPublicItem(ctx, item));
  const updatedAt = all.reduce((max, item) => Math.max(max, item.updatedAt || 0), 0);
  request.sendJson({ ok: true, items, total, page, limit, pages, tags: libpurTagsOf(all), updatedAt });
  return true;
}

async function libpurRefreshRoute(ctx, request) {
  const bodyResult = await libpurReadJsonBody(request.readBody);
  if (!bodyResult.ok) { request.sendJson({ ok: false, error: bodyResult.error }, 400); return true; }
  const body = bodyResult.body || {};
  let state = libpurLoadState(ctx.deps);
  const existed = libpurAllItems(state);
  const wanted = Array.isArray(body.boothIds) ? body.boothIds.map((v) => String(v ?? '').trim()).filter(Boolean) : [];
  const targets = wanted.length ? wanted.filter((id) => LIBPUR_BOOTH_ID_RE.test(id)) : existed.map((item) => item.boothId);
  if (wanted.length && targets.length !== wanted.length) {
    request.sendJson({ ok: false, error: '有 BOOTH 号不合法（必须 5~9 位数字）' }, 400);
    return true;
  }
  if (!targets.length) {
    request.sendJson({ ok: true, refreshed: 0, failed: [], total: existed.length, message: '已购库还是空的，先导入商品' });
    return true;
  }
  const pause = libpurPausedNow(ctx.deps);
  if (pause.paused) {
    request.sendJson({ ok: false, paused: true, error: pause.text, refreshed: 0, failed: [], total: existed.length }, 409);
    return true;
  }
  const failed = [];
  let refreshed = 0;
  let stopped = '';
  for (const boothId of targets) {
    const now = libpurPausedNow(ctx.deps);
    if (now.paused) { stopped = now.text; break; }
    const got = await libpurUpsertOne(ctx, state, boothId, { source: 'refresh' });
    if (!got.ok) { failed.push({ url: `${LIBPUR_ITEM_BASE}${boothId}`, error: got.error }); continue; }
    state = got.state;
    refreshed += 1;
  }
  const payload = { ok: true, refreshed, failed, total: Object.keys(state.items).length };
  if (stopped) { payload.paused = true; payload.error = stopped; }
  request.sendJson(payload);
  return true;
}

async function libpurRemoveRoute(ctx, request) {
  const bodyResult = await libpurReadJsonBody(request.readBody);
  if (!bodyResult.ok) { request.sendJson({ ok: false, error: bodyResult.error }, 400); return true; }
  const body = bodyResult.body || {};
  const boothId = String(body.boothId ?? '').trim();
  if (!LIBPUR_BOOTH_ID_RE.test(boothId)) { request.sendJson({ ok: false, error: 'boothId 非法（必须 5~9 位数字）' }, 400); return true; }
  const state = libpurLoadState(ctx.deps);
  const existed = Boolean(state.items[boothId]);
  if (existed) delete state.items[boothId];
  libpurSaveState(ctx.deps, state);
  libpurRemoveCover(ctx.deps, boothId);
  if (existed) ctx.deps.log(`已购库：删除 ${boothId}`);
  request.sendJson({ ok: true, removed: existed, boothId, total: Object.keys(state.items).length });
  return true;
}

// ── 截图识别：OCR 引擎与图片处理都在 library-ocr 模块里，这里只做转发 ──────────
// 路由文件不能 import（manifest 模块裸执行），所以把台账读写/解析这些内部函数打包传过去。
// 截图识别只做只读预览：抓商品页 → 解析 → 回候选，导入仍由 /purchases/import 负责。
// 以前这里接了 upsertOne，预览即入库（还顺手下了封面），用户点「导入这件」又白跑一遍。
function libpurOcrApi(ctx) {
  return {
    // 抓商品页并解析成台账记录形状（不落盘）。
    fetchItem: (boothId) => libpurFetchItem(ctx, boothId),
    // 封面给「能直接显示的地址」：本地已缓存就走本地接口，否则用商品页上的远程图。
    coverInfo: (boothId, remoteUrl) => {
      if (libpurCoverExists(ctx.deps, boothId)) {
        return { coverUrl: `/api/library/purchases/cover?boothId=${boothId}`, coverRemote: false };
      }
      const remote = String(remoteUrl || '').trim();
      if (/^https?:\/\//i.test(remote)) return { coverUrl: remote, coverRemote: true };
      return { coverUrl: '', coverRemote: false };
    },
    pausedNow: () => libpurPausedNow(ctx.deps)
  };
}

function libpurCoverRoute(ctx, request) {
  const boothId = String(request.url.searchParams.get('boothId') || '').trim();
  if (!LIBPUR_BOOTH_ID_RE.test(boothId)) { request.sendJson({ ok: false, error: 'boothId 非法（必须 5~9 位数字）' }, 400); return true; }
  let buf = null;
  try {
    buf = ctx.deps.fs.readFileSync(libpurCoverAbs(ctx.deps, boothId));
  } catch {
    request.sendJson({ ok: false, error: '这件商品没有本地封面（抓取失败或还没导入）' }, 404);
    return true;
  }
  // 文件名固定、内容会被 refresh 覆盖：URL 上带 &v=<updatedAt> 做版本区分，这里可以放心长缓存。
  // 必须先展开 SECURITY_HEADERS 再覆盖 Cache-Control：SecurityHeaders 里带 'Cache-Control': 'no-store'，
  // 之前写成小写 'cache-control' 放在展开前，同一响应里出现两个大小写不同的同名头（Node 头名不分大小写），
  // no-store 最终生效，封面每次都重新下载。
  request.res.writeHead(200, { ...request.SECURITY_HEADERS, 'content-type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
  request.res.end(buf);
  return true;
}

// @bridge-function handleConsoleLibraryPurchases:start
async function handleConsoleLibraryPurchases(ctx, request) {
  const { req, url, sendJson } = request;
  const path = String(url.pathname || '');
  if (path !== '/api/library/purchases' && !path.startsWith('/api/library/purchases/')) return false;
  // 已购库是管理端数据（含买了什么）：智能体令牌一律 403，和找号/绑定同一口径。
  if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
    sendJson({ ok: false, error: '未授权：已购库只允许管理端操作' }, 403);
    return true;
  }
  if (path === '/api/library/purchases/resolve') {
    if (req.method !== 'POST') { sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }
    return libpurResolveRoute(ctx, request);
  }
  if (path === '/api/library/purchases/import') {
    if (req.method !== 'POST') { sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }
    return libpurImportRoute(ctx, request);
  }
  if (path === '/api/library/purchases') {
    if (req.method !== 'GET') { sendJson({ ok: false, error: '该接口只支持 GET' }, 405); return true; }
    return libpurListRoute(ctx, request);
  }
  if (path === '/api/library/purchases/refresh') {
    if (req.method !== 'POST') { sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }
    return libpurRefreshRoute(ctx, request);
  }
  if (path === '/api/library/purchases/remove') {
    if (req.method !== 'POST') { sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }
    return libpurRemoveRoute(ctx, request);
  }
  if (path === '/api/library/purchases/ocr/status') {
    if (req.method !== 'GET') { sendJson({ ok: false, error: '该接口只支持 GET' }, 405); return true; }
    return ctx.deps.libraryOcr.handlePurchasesOcrStatus(request);
  }
  if (path === '/api/library/purchases/ocr') {
    if (req.method !== 'POST') { sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }
    return ctx.deps.libraryOcr.handlePurchasesOcr(request, libpurOcrApi(ctx));
  }
  if (path === '/api/library/purchases/cover') {
    if (req.method !== 'GET') { sendJson({ ok: false, error: '该接口只支持 GET' }, 405); return true; }
    return libpurCoverRoute(ctx, request);
  }
  return false;
}
// @bridge-function handleConsoleLibraryPurchases:end

export function createLibraryPurchases(deps) {
  // 构造期不许读 deps（VM 边界测试会用「一访问就抛」的 getter 构造工厂）：
  // 解析/搜索纯规则、fs、STATE_DIR 都推迟到第一次真正处理请求时再取。
  let impl = null;
  const implOf = () => impl || (impl = buildLibraryPurchases(deps));
  return { handleConsoleLibraryPurchases: (request) => implOf().handleConsoleLibraryPurchases(request) };
}

function buildLibraryPurchases(deps) {
  const BUF = deps.Buffer || (typeof Buffer !== 'undefined' ? Buffer : null);
  const ctx = {
    deps,
    BUF,
    productPure: deps.boothProductPure || {},
    boothPure: deps.boothSearchPure || {},
    lastNetworkAt: 0
  };
  return { handleConsoleLibraryPurchases: (request) => handleConsoleLibraryPurchases(ctx, request) };
}
