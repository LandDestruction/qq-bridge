// 已购库「从 BOOTH 已购清单同步」：一次把账号里买过的商品抓进本地台账，不用一条条贴。
//
// 约束：本文件是 manifest 模块，被 scripts/bridge-source.mjs 用 vm.runInContext 裸执行，
// **不能 import**。Cookie/翻页/登录失效判定来自 src/booth-download.js（deps.boothDownloadPure），
// 商品号校验来自 src/booth-product.js（deps.boothProductPure）；解析规则（清单卡片）留在本文件。
// 顶部不要有和 src/bridge.js 同名的 const/let（VM 里共用一个全局词法作用域）。
//
// 为什么单独一个模块：library-purchases.js 已经 766 行贴着 800 行文件闸，同步是「抓清单页 +
// 幂等 upsert」的独立流程，拆开以后两边都能单独翻代码。同步只写台账，不碰封面缓存
// （清单卡自带远程图 URL，先存 coverUrl；本地封面仍走已有的 refresh/import 流程）。
//
// 布局：
//   state/booth-purchases.json        台账（和 /api/library/purchases 共用，items 以 boothId 为键）
//   state/booth-purchases-sync.json   上次同步结果（给控制台「上次同步」用）
//   state/booth-cookies.json          BOOTH 登录 Cookie（下载面板里贴过就有）
//
// 路由（管理端，x-agent-token 一律 403）：
//   POST /api/library/purchases/sync         {dryRun?, maxPages?} 抓 https://accounts.booth.pm/library
//   GET  /api/library/purchases/sync/status  上次同步时间与结果（没同步过回 lastSyncAt:0）

const LIBPSYNC_UE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
// 注意：booth.pm/ja/library 现在 404（BOOTH 把「已购」挪到了 accounts 子域），
// 用账号站才对；翻页链接是相对路径 /library?page=N，也按 accounts 站拼。
const LIBPSYNC_LIBRARY_URL = 'https://accounts.booth.pm/library';
const LIBPSYNC_LIBRARY_ORIGIN = 'https://accounts.booth.pm';
const LIBPSYNC_ITEM_BASE = 'https://booth.pm/ja/items/';
const LIBPSYNC_TIMEOUT_MS = 12000;
const LIBPSYNC_MAX_HTML_BYTES = 4 * 1024 * 1024;
const LIBPSYNC_RATE_MS = 900;                     // 与找号/下载同一档软限速
const LIBPSYNC_COOKIE_FILE = 'booth-cookies.json';
const LIBPSYNC_STATE_FILE = 'booth-purchases.json';
const LIBPSYNC_STATUS_FILE = 'booth-purchases-sync.json';
const LIBPSYNC_VERSION = 1;
// 默认拉全量：BOOTH 已购清单一页 10 件、实际能到 74 页左右（700+ 件），
// 之前默认 20 页 = 只同步前 200 件就 stopped:'max_pages'，用户看着「同步完了但库里只有 200 件」。
// 正常结束靠分页器 hasNext=false；300 页是「万一页数爆炸」的保险丝，出现时属异常态。
const LIBPSYNC_DEFAULT_MAX_PAGES = 300;
const LIBPSYNC_MAX_PAGES = 300;
// 单页失败重试一次（只重试网络类错误；429/403/登录失效立刻停，交给全局暂停）。
const LIBPSYNC_PAGE_RETRY_MAX = 2;
const LIBPSYNC_BOOTH_ID_RE = /^\d{5,9}$/;
const LIBPSYNC_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 状态文件 ────────────────────────────────────────────────────────────────
function libpsyncPath(deps, file) {
  return deps.path.join(String(deps.STATE_DIR), file);
}

function libpsyncReadJson(deps, file) {
  try {
    return JSON.parse(deps.fs.readFileSync(libpsyncPath(deps, file), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function libpsyncWriteJson(deps, file, payload) {
  deps.atomicWriteJson(libpsyncPath(deps, file), payload);
  return payload;
}

function libpsyncStr(value, max) {
  return String(value ?? '').slice(0, max);
}

function libpsyncStrList(value, maxItems, maxLen) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const raw of list) {
    const text = libpsyncStr(raw, maxLen).trim();
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** 台账单条规整：外来的唯一入口（台账可能被旧版本/手工编辑坏过）。 */
function libpsyncNormalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const boothId = libpsyncStr(raw.boothId, 12).trim();
  if (!LIBPSYNC_BOOTH_ID_RE.test(boothId)) return null;
  const models = raw.models && typeof raw.models === 'object' ? raw.models : {};
  return {
    boothId,
    title: libpsyncStr(raw.title, 300),
    shopName: libpsyncStr(raw.shopName, 120),
    shopUrl: libpsyncStr(raw.shopUrl, 500),
    priceText: libpsyncStr(raw.priceText, 60),
    tags: libpsyncStrList(raw.tags, 30, 60),
    categories: libpsyncStrList(raw.categories, 8, 60),
    models: {
      max: Math.max(0, Math.trunc(Number(models.max) || 0)),
      total: Math.max(0, Math.trunc(Number(models.total) || 0)),
      labeled: Math.max(0, Math.trunc(Number(models.labeled) || 0))
    },
    itemUrl: libpsyncStr(raw.itemUrl, 500) || `${LIBPSYNC_ITEM_BASE}${boothId}`,
    coverRel: libpsyncStr(raw.coverRel, 300),
    coverUrl: libpsyncStr(raw.coverUrl, 600),
    addedAt: Math.max(0, Number(raw.addedAt) || 0),
    updatedAt: Math.max(0, Number(raw.updatedAt) || 0),
    lastSyncedAt: Math.max(0, Number(raw.lastSyncedAt) || 0),
    source: libpsyncStr(raw.source, 40) || 'import',
    // 购买日期：清单页解析得到才有（解析不到就空着，前端自动省略那一行）。
    purchasedAt: Math.max(0, Number(raw.purchasedAt) || 0),
    purchasedAtText: libpsyncStr(raw.purchasedAtText, 40)
  };
}

function libpsyncNormalizeState(raw) {
  const state = { version: LIBPSYNC_VERSION, items: {} };
  if (!raw || typeof raw !== 'object') return state;
  if (Number(raw.version) > 0) state.version = Math.trunc(Number(raw.version)) || LIBPSYNC_VERSION;
  const items = raw.items && typeof raw.items === 'object' ? raw.items : {};
  for (const key of Object.keys(items)) {
    const item = libpsyncNormalizeItem(items[key]);
    if (item) state.items[item.boothId] = item;
  }
  return state;
}

function libpsyncLoadState(deps) {
  // 读坏当空台账：同步是增量操作，绝不能因为一份脏 JSON 把整个已购库清掉。
  return libpsyncNormalizeState(libpsyncReadJson(deps, LIBPSYNC_STATE_FILE));
}

function libpsyncSaveState(deps, state) {
  try {
    libpsyncWriteJson(deps, LIBPSYNC_STATE_FILE, state);
    return true;
  } catch (error) {
    deps.log(`已购库同步写盘失败：${error?.message ?? error}`);
    return false;
  }
}

/**
 * 写同步状态。两种时机都走这里：
 *   - 每抓完一页（running:true，pages 往前推，前端能显示「同步中… 第 12 页」）；
 *   - 结束时（running:false，带 lastResult 与 stopped）。
 * resumeUrl/resumePage 只在「非正常结束」时留下：下次 POST {resume:true} 从这一页接着抓。
 */
function libpsyncSaveStatus(deps, result, now) {
  const prev = libpsyncReadJson(deps, LIBPSYNC_STATUS_FILE);
  const prevLastSyncAt = Math.max(0, Number(prev && prev.lastSyncAt) || 0);
  const finishedAt = Math.max(0, Number(now) || 0);
  const lastResult = {
    added: Math.max(0, Number(result.added) || 0),
    updated: Math.max(0, Number(result.updated) || 0),
    unchanged: Math.max(0, Number(result.unchanged) || 0),
    failed: Math.max(0, Number(result.failed) || 0),
    pages: Math.max(0, Number(result.pages) || 0),
    stopped: libpsyncStr(result.stopped, 40),
    resumePage: Math.max(0, Number(result.resumePage) || 0),
    notice: libpsyncStr(result.notice, 80)
  };
  const payload = {
    version: LIBPSYNC_VERSION,
    running: Boolean(result.running),
    startedAt: Math.max(0, Number(result.startedAt) || 0),
    pages: Math.max(0, Number(result.pages) || 0),
    totalPagesHint: result.totalPagesHint == null ? null : Math.max(0, Number(result.totalPagesHint) || 0),
    resumeUrl: libpsyncStr(result.resumeUrl, 500),
    resumePage: Math.max(0, Number(result.resumePage) || 0),
    stopped: libpsyncStr(result.stopped, 40),
    lastSyncAt: finishedAt > 0 ? finishedAt : prevLastSyncAt,
    lastResult: finishedAt > 0 ? lastResult : (prev && prev.lastResult && typeof prev.lastResult === 'object' ? prev.lastResult : null)
  };
  try {
    libpsyncWriteJson(deps, LIBPSYNC_STATUS_FILE, payload);
  } catch (error) {
    deps.log(`已购库同步状态写盘失败：${error?.message ?? error}`);
  }
  return payload;
}

/** 读上次状态（续传用）：只认 http(s) 的 resumeUrl，防状态文件被手改成别的地址。 */
function libpsyncResumeInfo(deps) {
  const raw = libpsyncReadJson(deps, LIBPSYNC_STATUS_FILE);
  const url = libpsyncStr(raw && raw.resumeUrl, 500).trim();
  const page = Math.max(0, Number(raw && raw.resumePage) || 0);
  if (!/^https:\/\/accounts\.booth\.pm\/library(\/|\?|$)/.test(url) || page < 1) return { url: '', page: 0 };
  return { url, page };
}

/** 分页器里的页码提示（可空）：只取 page=N 的最大值，拿不到就不显示总数。 */
function libpsyncTotalPagesHint(html) {
  const text = String(html || '');
  let max = 0;
  const re = /[?&]page=(\d{1,6})\b/g;
  let match;
  while ((match = re.exec(text)) !== null) max = Math.max(max, Math.trunc(Number(match[1])) || 0);
  return max > 0 ? max : null;
}

// ── Cookie（复用下载面板的 Cookie 槽位）────────────────────────────────────
function libpsyncCookieOf(deps, pure) {
  const raw = libpsyncReadJson(deps, LIBPSYNC_COOKIE_FILE);
  const store = typeof pure.normalizeCookieStore === 'function' ? pure.normalizeCookieStore(raw) : null;
  const cookie = store && typeof pure.currentCookie === 'function' ? pure.currentCookie(store) : '';
  const norm = typeof pure.normalizeCookie === 'function' ? pure.normalizeCookie(cookie) : { ok: Boolean(cookie), cookie };
  if (!norm.ok) return { ok: false, cookie: '' };
  return { ok: true, cookie: norm.cookie };
}

// ── 清单页解析 ─────────────────────────────────────────────────────────────
function libpsyncTextOf(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function libpsyncCardWindow(html, at) {
  return html.slice(Math.max(0, at - 900), at + 2600);
}

/**
 * 解析已购清单页。页面结构（2026-10 真机）：
 *   <div class="bg-white p-16 …"><div class="flex gap-8 …">
 *     <a href="https://booth.pm/zh-cn/items/9053400"><img class="l-library-item-thumbnail" src="…"></a>
 *     <div><a href="…/items/9053400"><div class="text-text-default font-bold …">标题</div></a>
 *          <a href="https://siropapa.booth.pm/"><img alt="siropapa" …><div class="text-14 text-text-gray600 …">siropapa</div></a>
 *     </div></div>…下载按钮…</div>
 * 老版已购页（fixtures/booth-owned-list.html）是 li[data-product-id][data-product-name] + a.item-link，
 * 一并兼容——两边都只认「/items/<5~9 位数字>」，不拼别的选择器。
 */
/**
 * 从清单卡片里抠「购买日期」。BOOTH 已购页 2026-10 的真机版本**没有**購入日字段
 * （只有商品/店铺/下载按钮），所以这里兼容三种将来/其他语言版本可能出现的写法：
 *   「購入日 2026/09/25」「2026年9月25日」「<time datetime="2026-09-25T…">」。
 * 认不出来就返回空对象——**不要编日期**，宁可前端不显示。
 */
function libpsyncParsePurchasedAt(html, text) {
  const labeled = text.match(/(?:購入日|購入|purchased?(?:\s*on)?)[^0-9]{0,20}(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/i)
    // 中文「2026年9月25日」自带年月日，不会和别的数字混淆，不用标签也认。
    || text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const attr = String(html || '').match(/<time[^>]*datetime="(\d{4})-(\d{1,2})-(\d{1,2})/);
  const m = labeled || attr;
  if (!m) return {};
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!(year >= 2000 && year <= 2100) || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return {};
  const at = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(at)) return {};
  return {
    purchasedAt: at,
    purchasedAtText: labeled ? String(labeled[0]).trim().slice(0, 40) : `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  };
}

function libpsyncParseCards(html) {
  const text = String(html || '');
  const positions = [];
  const seen = new Set();
  const idRe = /\/items\/(\d{5,9})/g;
  let match;
  while ((match = idRe.exec(text)) !== null) {
    const boothId = match[1];
    if (seen.has(boothId)) continue;
    seen.add(boothId);
    positions.push({ boothId, at: match.index });
  }
  const cards = [];
  for (const { boothId, at } of positions) {
    const chunk = libpsyncCardWindow(text, at);
    const title =
      libpsyncTextOf((chunk.match(/data-product-name=["']([^"']{1,200})["']/) || [])[1]) ||
      libpsyncTextOf((chunk.match(/<div class="text-text-default font-bold[^"]*"[^>]*>([\s\S]{0,300}?)<\/div>/) || [])[1]) ||
      libpsyncTextOf((chunk.match(/<a[^>]*class="[^"]*item-link[^"]*"[^>]*>([\s\S]{0,300}?)<\/a>/) || [])[1]);
    const thumbTag = (chunk.match(/<img[^>]*class="[^"]*l-library-item-thumbnail[^"]*"[^>]*>/) || [''])[0];
    const coverUrl =
      (thumbTag.match(/src="([^"]+)"/) || [])[1] ||
      (chunk.match(/<img[^>]*src="(https:\/\/booth\.pximg\.net[^"]+)"/) || [])[1] ||
      '';
    const shopMatch = chunk.match(/<a[^>]*href="(https?:\/\/([A-Za-z0-9.-]+)\.booth\.pm\/?)"[^>]*>[\s\S]{0,600}?<div class="text-14 text-text-gray600[^"]*"[^>]*>([\s\S]{0,160}?)<\/div>/);
    let shopUrl = shopMatch ? shopMatch[1] : '';
    let shopName = shopMatch ? libpsyncTextOf(shopMatch[3]) : '';
    if (!shopName) {
      // 图标 img 的 alt 也是店名（文字节点被截断时的兜底）
      const alt = chunk.match(/<img alt="([^"]{1,60})"[^>]*class="[^"]*rounded-\[50%\]/);
      if (alt) shopName = libpsyncTextOf(alt[1]);
    }
    const prices = libpsyncTextOf(chunk).match(/(?:¥|￥)\s?[\d,]+/g) || [];
    const priceText = prices.length ? prices[0] : '';
    cards.push({
      boothId,
      title,
      shopName,
      shopUrl,
      priceText,
      coverUrl,
      itemUrl: `${LIBPSYNC_ITEM_BASE}${boothId}`,
      ...libpsyncParsePurchasedAt(chunk, libpsyncTextOf(chunk))
    });
  }
  return cards;
}

function libpsyncAbsolute(url) {
  const href = libpsyncStr(url, 500).trim();
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('/')) return LIBPSYNC_LIBRARY_ORIGIN + href;
  return '';
}

/** 下一页：只认 rel="next"（BOOTH 的分页条里它一定在；不要凭 page 参数猜）。 */
function libpsyncParsePager(html) {
  const text = String(html || '');
  const next =
    (text.match(/<a[^>]*rel="next"[^>]*href="([^"]+)"/) || [])[1] ||
    (text.match(/<a[^>]*href="([^"]+)"[^>]*rel="next"/) || [])[1] ||
    '';
  const nextPageUrl = libpsyncAbsolute(next);
  return { hasNext: Boolean(nextPageUrl), nextPageUrl };
}

// ── 抓取（限速 + 登录失效/限流判定）──────────────────────────────────────
async function libpsyncThrottle(ctx) {
  // 页间软限速：默认 900ms；测试可注入 deps.libpsyncRateMs 调小，避免 74 页模拟要跑一分多钟。
  const rateMs = Number(ctx.deps && ctx.deps.libpsyncRateMs) >= 0 ? Number(ctx.deps.libpsyncRateMs) : LIBPSYNC_RATE_MS;
  const wait = rateMs - (Date.now() - ctx.lastAt);
  if (wait > 0) await LIBPSYNC_SLEEP(wait);
  ctx.lastAt = Date.now();
}

async function libpsyncFetchPage(ctx, url) {
  const { deps, pure } = ctx;
  await libpsyncThrottle(ctx);
  let res;
  try {
    res = await deps.fetch(url, {
      headers: {
        'user-agent': LIBPSYNC_UE,
        cookie: ctx.cookie,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'ja,en;q=0.8'
      },
      redirect: 'manual',
      signal: deps.AbortSignal.timeout(LIBPSYNC_TIMEOUT_MS)
    });
  } catch (error) {
    return { ok: false, error: `抓取失败：${error?.message ?? error}` };
  }
  const status = Number(res.status) || 0;
  const location = String(res.headers.get('location') || '');
  if (status >= 300 && status < 400) {
    const out = typeof pure.isSignedOut === 'function'
      ? pure.isSignedOut({ status: 0, finalUrl: location, body: '' })
      : { out: /sign_?in|accounts\.booth\.pm/i.test(location), reason: '被重定向到登录页' };
    if (out.out) return { ok: false, signedOut: true, error: 'Cookie 过期了：BOOTH 要求重新登录' };
    return { ok: false, error: `BOOTH 把请求重定向到了 ${location || '未知地址'}` };
  }
  if (status === 401) return { ok: false, signedOut: true, error: 'Cookie 过期了：BOOTH 回了 401' };
  if (status === 429 || status === 403) {
    // 429/403 写进**全局**暂停文件：找号、商品页、封面、同步共用一份，
    // 而不是这里自己回一个 rateLimited 就完事（搜索那边可能还在打）。
    const pause = await libpsyncPauseNote(deps, status, res);
    const minutes = Math.max(1, Math.round((pause?.pauseMs || 0) / 60000));
    return { ok: false, rateLimited: true, error: `BOOTH 回了 HTTP ${status}（已全局暂停抓取 ${minutes} 分钟）` };
  }
  if (status !== 200) return { ok: false, error: `BOOTH 回了 HTTP ${status}` };
  let html = '';
  try {
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > LIBPSYNC_MAX_HTML_BYTES) return { ok: false, error: `清单页太大（${bytes.length} 字节），不敢解析` };
    html = bytes.toString('utf8');
  } catch (error) {
    return { ok: false, error: `读响应失败：${error?.message ?? error}` };
  }
  // 注意：清单页本身就是 accounts.booth.pm/library，不能把「URL 里出现 accounts.booth.pm」
  // 当成登录页；登录态只能靠 redirect:manual 的 3xx Location、401/403 与页面正文判断。
  const out = typeof pure.isSignedOut === 'function'
    ? pure.isSignedOut({ status, finalUrl: '', body: html })
    : { out: false };
  if (out.out) return { ok: false, signedOut: true, error: 'Cookie 过期了：BOOTH 给的是登录页' };
  return { ok: true, html, status };
}

// ── 幂等 upsert ────────────────────────────────────────────────────────────
function libpsyncMaterialize(card, now) {
  return libpsyncNormalizeItem({
    boothId: card.boothId,
    title: card.title,
    shopName: card.shopName,
    shopUrl: card.shopUrl,
    priceText: card.priceText,
    coverUrl: card.coverUrl,
    itemUrl: card.itemUrl,
    tags: [],
    categories: [],
    models: {},
    coverRel: '',
    addedAt: now,
    updatedAt: now,
    lastSyncedAt: now,
    source: 'library-sync',
    purchasedAt: card.purchasedAt || 0,
    purchasedAtText: card.purchasedAtText || ''
  });
}

/**
 * 幂等 upsert：已有条目不覆盖非空旧值（只补字段），返回 added|updated|unchanged|failed。
 * dryRun 时只在内存里算「会不会变」，一个字节都不写。
 */
function libpsyncUpsert(ctx, card, now, dryRun) {
  const prev = ctx.state.items[card.boothId];
  if (!prev) {
    const item = libpsyncMaterialize(card, now);
    if (!item || !item.title) return 'failed';
    if (!dryRun) ctx.state.items[item.boothId] = item;
    return 'added';
  }
  let changed = false;
  const patch = {
    title: libpsyncStr(card.title, 300),
    shopName: libpsyncStr(card.shopName, 120),
    shopUrl: libpsyncStr(card.shopUrl, 500),
    priceText: libpsyncStr(card.priceText, 60),
    coverUrl: libpsyncStr(card.coverUrl, 600),
    itemUrl: libpsyncStr(card.itemUrl, 500)
  };
  for (const key of Object.keys(patch)) {
    const next = patch[key];
    // 保留已有字段：非空旧值一律不覆盖（人工改过的标题/店铺要留着），只补空字段。
    const current = prev[key];
    if (!next || (current !== undefined && current !== null && String(current) !== '')) continue;
    changed = true;
    if (!dryRun) prev[key] = next;
  }
  // 购买日期单独处理：数值字段用「补空」语义（已有 purchasedAt 绝不覆盖，除非原来是 0）。
  if (card.purchasedAt && !prev.purchasedAt) {
    changed = true;
    if (!dryRun) prev.purchasedAt = Number(card.purchasedAt) || 0;
  }
  if (card.purchasedAtText && !prev.purchasedAtText) {
    changed = true;
    if (!dryRun) prev.purchasedAtText = libpsyncStr(card.purchasedAtText, 40);
  }
  if (changed) {
    if (!dryRun) {
      prev.updatedAt = now;
      prev.lastSyncedAt = now;
    }
    return 'updated';
  }
  if (!dryRun) prev.lastSyncedAt = now;
  return 'unchanged';
}

function libpsyncPublicItem(card, kind) {
  return {
    boothId: card.boothId,
    title: card.title,
    shop: card.shopName,
    priceText: card.priceText,
    coverUrl: card.coverUrl,
    isNew: kind === 'added'
  };
}

// ── 全局 BOOTH 暂停（与找号/商品页/封面共用 state/booth-search-pause.json）────
// 本模块不能 import，读/写都走 deps.boothPausePure（src/booth-pause.js 命名空间）。
// 以前这里只有自己的 rateLimited 标记，格式与搜索暂停不通用 → 搜索退避了同步还在翻页。
async function libpsyncPauseRead(deps) {
  const pure = deps.boothPausePure || {};
  if (typeof pure.readPause !== 'function') return { paused: false, text: '', retryAfterMs: 0 };
  const now = Date.now();
  const rec = await pure.readPause({ fs: deps.fs, stateDir: String(deps.STATE_DIR), now });
  const state = typeof pure.searchPauseState === 'function' ? pure.searchPauseState(rec, now) : { paused: false };
  if (!state.paused) return { paused: false, text: '', retryAfterMs: 0 };
  const text = typeof pure.describeSearchPause === 'function' ? pure.describeSearchPause(rec, now) : 'BOOTH 正在限速暂停';
  return { paused: true, text, retryAfterMs: Math.max(0, Number(state.remainingMs) || 0) };
}

/** 页面抓取挨了 429/403 时写全局暂停（只写这一份，不另造格式）。 */
async function libpsyncPauseNote(deps, status, res) {
  const pure = deps.boothPausePure || {};
  if (typeof pure.noteBoothPause !== 'function') return null;
  const retryAfter = typeof pure.retryAfterOf === 'function' ? pure.retryAfterOf(res?.headers) : null;
  return pure.noteBoothPause({ fs: deps.fs, stateDir: String(deps.STATE_DIR), now: Date.now() }, { status, retryAfter });
}

// ── 同步主流程 ─────────────────────────────────────────────────────────────
async function libpsyncRun(ctx, options) {
  const { deps } = ctx;
  const cookie = libpsyncCookieOf(deps, ctx.pure);
  if (!cookie.ok) {
    return {
      status: 400,
      payload: {
        ok: false,
        error: '还没登录 BOOTH（贴一次 Cookie 或走 /api/library/booth-cookie）',
        needCookie: true
      }
    };
  }
  // 开跑前先看全局暂停：暂停中一个清单页都不抓（dryRun 也一样，dryRun 也要打 BOOTH）。
  const pause = await libpsyncPauseRead(deps);
  if (pause.paused) {
    return {
      status: 409,
      payload: { ok: false, paused: true, error: pause.text, retryAfterMs: pause.retryAfterMs }
    };
  }
  ctx.cookie = cookie.cookie;
  ctx.state = libpsyncLoadState(deps);
  const startedAt = Date.now();
  const now = startedAt;
  const counters = { added: 0, updated: 0, unchanged: 0, failed: 0 };
  const items = [];
  const errors = [];
  let pages = 0;
  let stopped = '';
  let notice = '';
  let signedOut = '';
  let totalPagesHint = null;
  let resumeUrl = '';
  let resumePage = 0;

  // 续传：{resume:true} 时从上次停止的那一页接着抓（跳过 1..resumePage-1），不用每次从第 1 页重来。
  const resumeInfo = options.resume ? libpsyncResumeInfo(deps) : { url: '', page: 0 };
  let page = resumeInfo.page > 0 ? resumeInfo.page : 1;
  let url = resumeInfo.url || LIBPSYNC_LIBRARY_URL;

  // 每页进度落盘：前端能显示「同步中… 第 12 页」，也能在中途关页面后靠 status 判断断点。
  const writeProgress = (pageNo) => {
    if (options.dryRun) return;
    if (counters.added || counters.updated || counters.unchanged || counters.failed) libpsyncSaveState(deps, ctx.state);
    libpsyncSaveStatus(deps, {
      ...counters,
      running: true,
      startedAt,
      pages: pageNo,
      totalPagesHint,
      stopped: '',
      resumeUrl: '',
      resumePage: 0,
      notice: ''
    }, 0);
  };

  const finish = () => {
    if (!options.dryRun) {
      libpsyncSaveStatus(deps, { ...counters, running: false, startedAt, pages, totalPagesHint, stopped, resumeUrl, resumePage, notice }, now);
    }
    const payload = {
      ok: true,
      dryRun: Boolean(options.dryRun),
      added: counters.added,
      updated: counters.updated,
      unchanged: counters.unchanged,
      failed: counters.failed,
      pages,
      resumed: resumeInfo.page > 0 && pages > 0,
      resumePage,
      totalPagesHint,
      items,
      errors
    };
    if (stopped) payload.stopped = stopped;
    if (notice) payload.notice = notice;
    if (signedOut) payload.signedOut = signedOut;
    return { status: 200, payload };
  };

  const stopAt = (reason, next, extra = '') => {
    stopped = reason;
    notice = extra;
    resumeUrl = next.url;
    resumePage = next.page;
  };

  // 续传点已经超过本次页数预算（比如手动传了很小的 maxPages）：什么都不抓，保留断点。
  if (page > options.maxPages) {
    pages = page - 1;
    stopAt('max_pages', { url, page }, `已到 ${options.maxPages} 页上限，可能还有更多`);
    return finish();
  }

  for (; page <= options.maxPages; page += 1) {
    let res = await libpsyncFetchPage(ctx, url);
    // 单页失败重试一次：只重试网络类/读响应类错误（fetch 抛错、超时、连接重置），
    // 429/403/登录失效立刻停（写全局暂停，别拿重试去打限速闸）；HTTP 5xx 是服务端问题，记 error 不重试。
    if (!res.ok && !res.signedOut && !res.rateLimited && /抓取失败|读取响应失败|ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed|超时/i.test(res.error || '')) {
      const pure = ctx.pure || {};
      const verdict = typeof pure.shouldRetryDownload === 'function'
        ? pure.shouldRetryDownload({ attempt: 1, maxRetry: LIBPSYNC_PAGE_RETRY_MAX, error: res.error })
        : { retry: true };
      if (verdict.retry) {
        errors.push({ page, error: `${res.error}（重试一次）` });
        res = await libpsyncFetchPage(ctx, url);
      }
    }
    pages = page;
    if (!res.ok) {
      errors.push({ page, error: res.error });
      if (res.signedOut) {
        signedOut = res.error;
        stopAt('signed_out', { url, page });
        const out = finish();
        return { status: 401, payload: { ...out.payload, ok: false, error: res.error, needCookie: true } };
      }
      stopAt(res.rateLimited ? 'rate_limited' : 'error', { url, page });
      break;
    }
    const cards = libpsyncParseCards(res.html);
    if (!cards.length) {
      errors.push({ page, error: '这一页没解析出商品（页面结构可能变了，或账号里确实没有已购商品）' });
      stopAt('no_items', { url, page });
      break;
    }
    const hint = libpsyncTotalPagesHint(res.html);
    if (hint != null) totalPagesHint = hint;
    for (const card of cards) {
      const kind = libpsyncUpsert(ctx, card, now, options.dryRun);
      counters[kind] += 1;
      if (kind !== 'failed') items.push(libpsyncPublicItem(card, kind));
    }
    writeProgress(page);
    const pager = libpsyncParsePager(res.html);
    if (!pager.hasNext) break;
    if (page >= options.maxPages) {
      stopAt('max_pages', { url: pager.nextPageUrl, page: page + 1 }, `已到 ${options.maxPages} 页上限，可能还有更多`);
      break;
    }
    url = pager.nextPageUrl;
  }

  return finish();
}

function libpsyncStatusRoute(ctx, request) {
  const raw = libpsyncReadJson(ctx.deps, LIBPSYNC_STATUS_FILE);
  const lastResult = raw && raw.lastResult && typeof raw.lastResult === 'object' ? raw.lastResult : null;
  const hint = raw && raw.totalPagesHint != null ? Math.max(0, Number(raw.totalPagesHint) || 0) : null;
  request.sendJson({
    ok: true,
    lastSyncAt: Math.max(0, Number(raw && raw.lastSyncAt) || 0),
    // 同步中的实时进度（前端 1.5s 轮询这里显示「同步中… 第 12 页」）：
    running: Boolean(raw && raw.running),
    startedAt: Math.max(0, Number(raw && raw.startedAt) || 0),
    pages: Math.max(0, Number(raw && raw.pages) || 0),
    totalPagesHint: hint,
    resumePage: Math.max(0, Number(raw && raw.resumePage) || 0),
    stopped: libpsyncStr(raw && raw.stopped, 40),
    lastResult: lastResult
      ? {
          added: Math.max(0, Number(lastResult.added) || 0),
          updated: Math.max(0, Number(lastResult.updated) || 0),
          unchanged: Math.max(0, Number(lastResult.unchanged) || 0),
          failed: Math.max(0, Number(lastResult.failed) || 0),
          pages: Math.max(0, Number(lastResult.pages) || 0),
          stopped: libpsyncStr(lastResult.stopped, 40),
          resumePage: Math.max(0, Number(lastResult.resumePage) || 0),
          notice: libpsyncStr(lastResult.notice, 80)
        }
      : null
  });
  return true;
}

async function libpsyncSyncRoute(ctx, request) {
  let body;
  try {
    body = await request.readBody();
  } catch (error) {
    request.sendJson({ ok: false, error: `请求体读不了：${error?.message ?? error}` }, 400);
    return true;
  }
  if (body == null) body = {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    request.sendJson({ ok: false, error: '请求体得是 JSON 对象（{dryRun?, maxPages?}）' }, 400);
    return true;
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
    request.sendJson({ ok: false, error: 'dryRun 必须是布尔（true/false）' }, 400);
    return true;
  }
  if (body.resume !== undefined && typeof body.resume !== 'boolean') {
    request.sendJson({ ok: false, error: 'resume 必须是布尔（true/false）' }, 400);
    return true;
  }
  let maxPages = LIBPSYNC_DEFAULT_MAX_PAGES;
  if (body.maxPages !== undefined) {
    const wanted = Number(body.maxPages);
    if (!Number.isFinite(wanted) || wanted < 1) {
      request.sendJson({ ok: false, error: 'maxPages 必须是 ≥1 的数字' }, 400);
      return true;
    }
    maxPages = Math.min(LIBPSYNC_MAX_PAGES, Math.trunc(wanted));
  }
  const result = await libpsyncRun(ctx, { dryRun: body.dryRun === true, resume: body.resume === true, maxPages });
  request.sendJson(result.payload, result.status);
  return true;
}

// @bridge-function handleConsoleLibraryPurchasesSync:start
async function handleConsoleLibraryPurchasesSync(ctx, request) {
  const { req, url, sendJson } = request;
  const path = String(url.pathname || '');
  const isSync = path === '/api/library/purchases/sync';
  const isStatus = path === '/api/library/purchases/sync/status';
  if (!isSync && !isStatus) return false;
  // 已购库是管理端数据（含买了什么）：智能体令牌一律 403，和 /api/library/purchases 同一口径。
  if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
    sendJson({ ok: false, error: '未授权：已购库只允许管理端操作' }, 403);
    return true;
  }
  if (isStatus) {
    if (req.method !== 'GET') {
      sendJson({ ok: false, error: '该接口只支持 GET' }, 405);
      return true;
    }
    return libpsyncStatusRoute(ctx, request);
  }
  if (req.method !== 'POST') {
    sendJson({ ok: false, error: '该接口只支持 POST' }, 405);
    return true;
  }
  return libpsyncSyncRoute(ctx, request);
}
// @bridge-function handleConsoleLibraryPurchasesSync:end

export function createLibraryPurchasesSync(deps) {
  // 构造期不许读 deps（VM 边界测试会用「一访问就抛」的 getter 构造工厂）：
  // Cookie、fs、STATE_DIR、fetch 都推迟到第一次真正处理请求时再取。
  let impl = null;
  const implOf = () => impl || (impl = buildLibraryPurchasesSync(deps));
  return { handleConsoleLibraryPurchasesSync: (request) => implOf().handleConsoleLibraryPurchasesSync(request) };
}

function buildLibraryPurchasesSync(deps) {
  const ctx = {
    deps,
    pure: deps.boothDownloadPure || {},
    productPure: deps.boothProductPure || {},
    cookie: '',
    state: null,
    lastAt: 0
  };
  return { handleConsoleLibraryPurchasesSync: (request) => handleConsoleLibraryPurchasesSync(ctx, request) };
}
