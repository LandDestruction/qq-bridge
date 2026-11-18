// BOOTH 商品元数据抓取（转存系统「认 BOOTH 号」用）。
//
// 目标：群友发的文件名以 BOOTH 号开头（如 `9038753奥の手 -OkunoTe-…`），转存后自动
// 抓商品页元数据（标题/店铺/价格/标签/缩略图/链接），并据此分类落目录。
//
// 设计原则：
// - **纯函数优先**：HTML → 元数据的解析（parseBoothHtml）与文件名解析（parseBoothName）
//   都是纯函数，单测可以用保存下来的 fixture 复现，不联网。
// - **失败不阻塞转存**：任何异常都收敛成 status，不 throw；调用方只看 status 决定要不要归类。
// - **礼貌抓取**：全局 ≥1 秒/请求、成功缓存 30 天、404 缓存 7 天；429/5xx 只重试 1 次。
// - 不带登录态、不绕年龄墙：年龄墙页面标 gated，只尽量从 og:image 拿缩略图。

import fs from 'node:fs';
import path from 'node:path';
import { normalizeBoothCategory } from './booth-classify.js';
import { readPause, searchPauseState, noteBoothPause, pauseErrorMessage, retryAfterOf } from './booth-pause.js';

export const BOOTH_ITEM_BASE = 'https://booth.pm/zh-cn/items/';
/** 单次抓取响应体上限（页面/JSON 都按它截断，避免异常站点把内存打爆）。 */
export const BOOTH_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

/** 规范化 BOOTH 配置（每个字段都必须有默认值：config.json 是用户可编辑的，不能信任类型）。 */
export function normalizeBoothConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const num = (v, lo, hi, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };
  return {
    enabled: src.enabled !== false,
    cacheDir: typeof src.cacheDir === 'string' && src.cacheDir.trim() ? src.cacheDir.trim() : 'state/booth-cache',
    cacheDays: num(src.cacheDays, 1, 365, 30),
    notFoundCacheDays: num(src.notFoundCacheDays, 1, 30, 7),
    rateLimitMs: num(src.rateLimitMs, 200, 10000, 1000),
    timeoutMs: num(src.timeoutMs, 1000, 60000, 15000),
    thumbMaxBytes: num(src.thumbMaxBytes, 64 * 1024, 16 * 1024 * 1024, 2 * 1024 * 1024)
  };
}

const DATE_LIKE = /^(19|20)\d{6}$/;

/**
 * 从文件名解析 BOOTH 号与商品名。
 *
 * 规则（用户拍板）：
 * - 开头连续 **5~9 位数字** 为 boothId；
 * - 其余部分去掉前导分隔符（空白/`_`/`-`/`【`/`(`）作为 productName；
 * - 解析不到返回 `{ boothId: null, productName: 原文件名（去首尾空白） }`。
 *
 * 反例（必须判成 null，单测已覆盖）：
 * `R-18 版.zip`（不是数字开头）、`v1.2.zip`、`2024.zip`（4 位）、`1234567890.zip`（10 位）、
 * `20240101.zip`（8 位但明显是日期，收成 BOOTH 号会把商品页抓错）、`90387 只有前缀.x`（5 位是合法的，
 * 但 `3.14` 之类小数不会命中）。
 */
export function parseBoothName(fileName) {
  const raw = String(fileName ?? '').trim();
  const matched = /^(\d{5,9})/.exec(raw);
  if (!matched) return { boothId: null, productName: raw };
  const digits = matched[1];
  // 数字后面还紧跟数字 ⇒ 其实是更长的数字串（如 10 位订单号/时间戳），不是 5~9 位 BOOTH 号。
  if (/\d/.test(raw[digits.length] ?? '')) return { boothId: null, productName: raw };
  // 日期陷阱：8 位且以 19/20 开头（如 20240101）一律不当 BOOTH 号 —— 收到日期当商品号会抓错页面。
  // 真正的 BOOTH 号目前是 7~8 位且很少以 19/20 开头；宁可漏判，也不把日期文件名当商品。
  if (DATE_LIKE.test(digits)) {
    return { boothId: null, productName: raw };
  }
  const rest = raw.slice(digits.length).replace(/^[\s_\-【\[（(]+/, '').trim();
  return { boothId: digits, productName: rest || '' };
}

/**
 * 同号图片归属：图片文件名开头的 BOOTH 号必须**真的在已有商品号集合里**才算命中。
 * 规则与 parseBoothName 完全一致（5~9 位、后面不能紧跟数字、8 位 19/20 开头的日期不算）。
 *
 * @param {string} fileName 图片文件名（如 `9038753 preview.png`）
 * @param {Iterable<string|number>} boothIds 库里已有的商品号（压缩包派生）
 * @returns {string|null} 命中的 boothId；没命中返回 null
 */
export function matchImageBooth(fileName, boothIds) {
  const { boothId } = parseBoothName(fileName);
  if (!boothId) return null;
  const set = new Set([...(boothIds ?? [])].map((v) => String(v).trim()).filter(Boolean));
  return set.has(boothId) ? boothId : null;
}

/**
 * 从商品页 HTML 里选「展示图」：**优先 og:image**，其次 ld+json 的 image。
 * （库的 item.thumbnailUrl 就是这个口径；与商品缩略图规格化分开，便于 cover 单独缓存。）
 */
export function parseBoothCoverSource(html) {
  const ogImage = metaContent(html, 'og:image');
  const product = productFromLdJson(html);
  const ldImage = imageFromLd(product?.image);
  return { ogImage, ldImage, chosen: ogImage || ldImage || '', title: String(product?.name || metaContent(html, 'og:title') || '') };
}

function stripTags(text) {
  return String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** 读取页面里所有 ld+json 块并挑出 Product。 */
function productFromLdJson(html) {
  const blocks = [...String(html ?? '').matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    let data;
    try { data = JSON.parse(decodeEntities(block[1])); } catch { continue; }
    const list = Array.isArray(data) ? data : [data];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      if (String(item['@type'] || '').toLowerCase() === 'product') return item;
      if (Array.isArray(item['@graph'])) {
        const hit = item['@graph'].find((x) => String(x?.['@type'] || '').toLowerCase() === 'product');
        if (hit) return hit;
      }
    }
  }
  return null;
}

function metaContent(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i');
  const m = re.exec(String(html ?? ''));
  return m ? decodeEntities(m[1]).trim() : '';
}

function offersPrice(offers) {
  if (!offers || typeof offers !== 'object') return '';
  const list = Array.isArray(offers) ? offers : [offers];
  const one = list.find((o) => o && (o.price || o.lowPrice));
  if (!one) return '';
  const low = String(one.lowPrice ?? one.price ?? '').trim();
  const high = String(one.highPrice ?? '').trim();
  if (low && high && high !== low) return `${low}-${high} ${String(one.priceCurrency || '').trim()}`.trim();
  return `${low} ${String(one.priceCurrency || '').trim()}`.trim();
}

function imageFromLd(image) {
  if (!image) return '';
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) return String(image[0] || '');
  if (typeof image === 'object') return String(image.url || image.contentUrl || '');
  return '';
}

function tagsFromHtml(html) {
  const tags = [];
  for (const m of String(html ?? '').matchAll(/\/tags\/([a-z0-9%_-]{1,60})/gi)) {
    let t = '';
    try { t = decodeURIComponent(m[1]); } catch { t = m[1]; }
    if (t && !tags.includes(t)) tags.push(t);
    if (tags.length >= 8) break;
  }
  return tags;
}

function looksGated(html) {
  const text = String(html ?? '');
  return /年齢確認|年齢認証|age verification|are you over 18|r-18|成人向け/i.test(text);
}

/**
 * HTML → BOOTH 元数据（纯函数，fixture 单测直接用）。
 * @param {string} html
 * @param {{boothId?:string, itemUrl?:string}} [ctx]
 */
export function parseBoothHtml(html, ctx = {}) {
  const boothId = String(ctx.boothId ?? '').trim();
  const itemUrl = String(ctx.itemUrl || (boothId ? `${BOOTH_ITEM_BASE}${boothId}` : '')).trim();
  const product = productFromLdJson(html);
  const gated = looksGated(html) && !product;
  const title = String(product?.name || metaContent(html, 'og:title') || '').replace(/\s*-\s*[^-]*-\s*BOOTH\s*$/i, '').trim();
  const brand = product?.brand;
  const shop = String((typeof brand === 'object' ? brand?.name : brand) || '').trim()
    || (() => {
      const m = [...String(html ?? '').matchAll(/https:\/\/([a-z0-9-]+)\.booth\.pm\//gi)]
        .map((x) => x[1]).find((h) => !['accounts', 'asset', 'www', 'booth'].includes(h));
      return m || '';
    })();
  const price = offersPrice(product?.offers);
  const thumbnailUrl = imageFromLd(product?.image) || metaContent(html, 'og:image');
  const tags = tagsFromHtml(html);
  const categoryRaw = String(product?.category || '').trim();
  const category = normalizeBoothCategory(categoryRaw);
  const description = String(product?.description || metaContent(html, 'og:description') || '').slice(0, 2000);
  return {
    ok: Boolean(title || thumbnailUrl),
    status: gated ? 'gated' : (title || thumbnailUrl ? 'ok' : 'error'),
    title, shop, price, tags, thumbnailUrl, itemUrl, category,
    description,
    raw: {
      ldType: String(product?.['@type'] || ''),
      brandUrl: String((typeof brand === 'object' ? brand?.url : '') || ''),
      priceCurrency: String(product?.offers?.priceCurrency || ''),
      categoryRaw
    }
  };
}

// ── JSON 端点（更稳定的元数据来源，KonoAsset 也走这条） ──────────────────
/**
 * 解析 BOOTH 的 `/{lang}/items/<id>.json`（字段比 HTML ld+json 全：category/tags/images/is_adult）。
 *
 * 实测 9038753 的 JSON：`name` / `shop`（字符串）/ `price`（字符串 `¥ 290~`）/
 * `category`（字符串 `3D衣装`）/ `category.parent`（`3Dモデル`）/ `tags[]` /
 * `images[].original` / `is_adult` / `url`。部分站点版本 `shop`/`category` 可能是对象，
 * 两种都兼容。
 */
export function parseBoothJson(data, ctx = {}) {
  const boothId = String(ctx.boothId ?? data?.id ?? '').trim();
  const itemUrl = String(ctx.itemUrl || (boothId ? `${BOOTH_ITEM_BASE}${boothId}` : '')).trim();
  if (!data || typeof data !== 'object') {
    return { ok: false, status: 'error', title: '', shop: '', price: '', tags: [], thumbnailUrl: '', itemUrl, category: '', description: '', raw: {}, error: 'JSON 不是对象' };
  }
  const shopRaw = data.shop;
  const shop = typeof shopRaw === 'object' ? String(shopRaw?.name || '') : String(shopRaw || '');
  const shopUrl = typeof shopRaw === 'object' ? String(shopRaw?.url || '') : '';
  const price = typeof data.price === 'string' ? data.price.trim() : (Number.isFinite(Number(data.price)) ? `${Number(data.price)} JPY` : '');
  const catRaw = data.category;
  const categoryRaw = typeof catRaw === 'object' ? String(catRaw?.name || '') : String(catRaw || '');
  const category = normalizeBoothCategory(categoryRaw);
  const parentCategory = typeof catRaw === 'object' ? String(catRaw?.parent?.name || '') : String(data.category_parent || '');
  const tags = (Array.isArray(data.tags) ? data.tags : [])
    .map((t) => String(typeof t === 'object' ? (t?.name ?? '') : t)).filter(Boolean).slice(0, 12);
  const images = (Array.isArray(data.images) ? data.images : [])
    .map((i) => String(typeof i === 'object' ? (i?.original || i?.url || '') : i)).filter(Boolean);
  const isAdult = data.is_adult === true;
  const title = String(data.name || '').trim();
  return {
    ok: Boolean(title),
    // JSON 端点本身没有年龄墙（能拿到完整字段）；is_adult 只作为标记，不降级成 gated，
    // 否则 R-18 商品永远进不了分类目录。
    status: title ? 'ok' : 'error',
    title, shop, price, tags,
    thumbnailUrl: images[0] || '',
    itemUrl,
    category,
    description: String(data.description || '').slice(0, 2000),
    raw: {
      source: 'json',
      shopUrl,
      parentCategory,
      categoryRaw,
      isAdult,
      isSoldOut: data.is_sold_out === true,
      images: images.slice(0, 4),
      shopItemUrl: String(data.url || '')
    },
    error: title ? '' : 'JSON 缺少商品名'
  };
}

// ── 与 feat/backend 的共享契约（A 的研究分支也新增了 src/booth-meta.js） ──
// A 的模块导出 parseBoothItem / sniffBoothIds / boothCacheFresh / BOOTH_CACHE_*；
// 两边同名路径合并时会有文本冲突，这里按**同签名、同语义超集**补齐，保证：
// 1) A 的单测（scripts/test-booth-meta.mjs，他那份）可以直接跑在本模块上；
// 2) 合并时无论保留哪份实现，调用方（bridge / 探针）行为一致。
// 注：A 用 7 天成功缓存 / 10 分钟失败缓存；本模块 fetchBoothMeta 的默认值仍是
// 30 天/7 天（可由 cfg 覆盖），两套常量并存，互不覆盖。

/** 从 BOOTH item JSON 取字段（A 的纯函数契约；缺字段给 null，不抛）。 */
export function parseBoothItem(json, { now = Date.now() } = {}) {
  if (!json || typeof json !== 'object') return null;
  const id = Number(json.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  const imgs = Array.isArray(json.images) ? json.images.map((i) => i?.original).filter(Boolean) : [];
  const shopRaw = json.shop;
  return {
    id,
    title: String(json.name ?? '').slice(0, 300) || null,
    shop: (typeof shopRaw === 'object' && shopRaw?.name) ? String(shopRaw.name) : (typeof shopRaw === 'string' && shopRaw ? shopRaw : null),
    shopUrl: (typeof shopRaw === 'object' && shopRaw?.url) ? String(shopRaw.url) : null,
    price: json.price != null ? String(json.price) : null,
    category: json.category
      ? {
        id: Number(json.category.id) || null,
        name: json.category.name ? String(json.category.name) : null,
        parent: json.category.parent?.name ? String(json.category.parent.name) : null
      }
      : null,
    // 分类的本地目录名（固定映射表；未知 → 未分类），A 的契约里没有，属于本分支扩展。
    categoryName: normalizeBoothCategory(typeof json.category === 'object' ? (json.category?.name || '') : json.category),
    tags: Array.isArray(json.tags)
      ? json.tags.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean).slice(0, 50)
      : [],
    isAdult: json.is_adult === true,
    isSoldOut: json.is_sold_out === true,
    isEndOfSale: json.is_end_of_sale === true,
    publishedAt: json.published_at ? String(json.published_at) : null,
    images: imgs,
    thumbUrl: imgs[0] ?? null,
    wishListsCount: Number.isFinite(Number(json.wish_lists_count)) ? Number(json.wish_lists_count) : null,
    url: json.url ? String(json.url) : null,
    fetchedAt: new Date(now).toISOString(),
    source: 'booth-json'
  };
}

const BOOTH_URL_RE = /booth\.pm\/(?:[a-z-]{2,8}\/)?items\/(\d{4,10})/gi;
// 文件名前缀要求 5 位以上（4 位多半是年份/日期），但 8 位 19/20 开头按日期排除（与本模块 parseBoothName 一致）。
const BOOTH_NAME_RE = /^\s*(\d{5,9})(?!\d)/;

/**
 * 从文本/消息段/文件名里嗅探 BOOTH 商品号（A 的契约）。
 * @param {{text?:string, segments?:any[], filenames?:string[]}} p
 * @returns {number[]} 去重后的 id（保持出现顺序）
 */
export function sniffBoothIds({ text = '', segments = [], filenames = [] } = {}) {
  const out = [];
  const push = (n) => {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0 && !out.includes(v)) out.push(v);
  };
  const scan = (s) => {
    for (const m of String(s ?? '').matchAll(BOOTH_URL_RE)) push(m[1]);
    // 8 位 19/20 开头的日期不当商品号（与 parseBoothName 保持一致）
    if (/^(19|20)\d{6}$/.test(String(s ?? ''))) return;
  };
  scan(String(text ?? ''));
  scan(String(text ?? '').replace(/\\\//g, '/'));
  for (const seg of Array.isArray(segments) ? segments : []) {
    const d = seg?.data ?? seg ?? {};
    scan(d.text ?? d.content ?? '');
    scan(d.url ?? '');
  }
  for (const fn of Array.isArray(filenames) ? filenames : []) {
    const m = String(fn ?? '').match(BOOTH_NAME_RE);
    if (m && !/^(19|20)\d{6}$/.test(m[1])) push(m[1]);
  }
  return out;
}

/** A 的缓存 TTL 常量（他分支的单测按这两个值断言）。 */
export const BOOTH_CACHE_OK_MS = 7 * 24 * 3600 * 1000;
export const BOOTH_CACHE_FAIL_MS = 10 * 60 * 1000;

/** 缓存判活：entry = {ok:boolean, at:number}。 */
export function boothCacheFresh(entry, { now = Date.now() } = {}) {
  if (!entry || !Number.isFinite(Number(entry.at))) return false;
  const ttl = entry.ok ? BOOTH_CACHE_OK_MS : BOOTH_CACHE_FAIL_MS;
  return Number(now) - Number(entry.at) < ttl;
}

// ── 限速（模块级：同一进程内所有 BOOTH 请求共享） ─────────────────────────
let lastRequestAt = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cacheFileFor(cacheDir, boothId) {
  return path.join(cacheDir, `${boothId}.json`);
}

function readCache(cacheDir, boothId, nowMs, cacheDays, notFoundDays) {
  try {
    const data = JSON.parse(fs.readFileSync(cacheFileFor(cacheDir, boothId), 'utf8'));
    const age = nowMs - Number(data.fetchedAt || 0);
    const ttlDays = data.status === 'not_found' ? notFoundDays : cacheDays;
    if (age >= 0 && age < ttlDays * 86400000) return data.meta ?? null;
  } catch {}
  return null;
}

function writeCache(cacheDir, boothId, meta, nowMs) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFileFor(cacheDir, boothId), JSON.stringify({ fetchedAt: nowMs, status: meta.status, meta }, null, 1));
  } catch {}
}

/**
 * 抓取 BOOTH 商品元数据。**永不 throw**（除非参数非法），失败统一 status。
 *
 * @param {string} boothId
 * @param {{fetchImpl?:Function, cacheDir?:string, now?:number, cfg?:object, log?:Function}} [opts]
 * @returns {Promise<{ok:boolean,status:'ok'|'not_found'|'gated'|'blocked'|'error',
 *   title:string,shop:string,price:string,tags:string[],thumbnailUrl:string,itemUrl:string,
 *   category:string,description:string,raw:object,cached:boolean,error:string}>}
 */
export async function fetchBoothMeta(boothId, opts = {}) {
  const id = String(boothId ?? '').trim();
  const cfg = normalizeBoothConfig(opts.cfg ?? opts);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const nowMs = Number(opts.now) || Date.now();
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const stateDir = String(opts.stateDir ?? cfg.stateDir ?? '') || undefined;
  const base = {
    ok: false, status: 'error', title: '', shop: '', price: '', tags: [],
    thumbnailUrl: '', itemUrl: `${BOOTH_ITEM_BASE}${id}`, category: '', description: '',
    raw: {}, cached: false, error: ''
  };
  if (!/^\d{5,9}$/.test(id)) return { ...base, status: 'error', error: 'BOOTH 号必须是 5~9 位数字' };
  if (typeof fetchImpl !== 'function') return { ...base, status: 'error', error: '没有可用的 fetch' };

  const cacheDir = cfg.cacheDir;
  const cached = readCache(cacheDir, id, nowMs, cfg.cacheDays, cfg.notFoundCacheDays);
  if (cached) return { ...base, ...cached, cached: true, ok: cached.status === 'ok' };

  // 全局暂停（429/403 后由任一抓取入口写入）：暂停中直接返回，一个请求都不发。
  // 放在缓存之后：缓存命中是零成本读，没必要因为限速就不给已抓过的资料。
  const pauseRec = await readPause({ stateDir, now: nowMs });
  if (searchPauseState(pauseRec, nowMs).paused) {
    return { ...base, status: 'paused', paused: true, error: pauseErrorMessage(pauseRec, nowMs) };
  }

  const requestUrl = async (url, accept) => {
    const wait = cfg.rateLimitMs - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fetchImpl(url, {
      headers: { 'user-agent': DEFAULT_UA, accept: accept || 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9,ja;q=0.8' },
      signal: AbortSignal.timeout(cfg.timeoutMs)
    });
  };
  // 响应体上限：先看 content-length，再读文本并复核字节数（异常站点/被劫持时不能无限读）。
  const readBoundedText = async (res) => {
    let declared = 0;
    try { declared = Number(res?.headers?.get?.('content-length') || 0) || 0; } catch {}
    if (declared > BOOTH_MAX_RESPONSE_BYTES) {
      throw new Error(`响应体超过 ${Math.round(BOOTH_MAX_RESPONSE_BYTES / 1024)}KB 上限（content-length=${declared}）`);
    }
    const text = await res.text();
    if (Buffer.byteLength(String(text ?? ''), 'utf8') > BOOTH_MAX_RESPONSE_BYTES) {
      throw new Error(`响应体超过 ${Math.round(BOOTH_MAX_RESPONSE_BYTES / 1024)}KB 上限`);
    }
    return text;
  };

  // 1) JSON 端点优先（KonoAsset 同款；字段比 HTML 全：category/tags/images/is_adult）。
  //    单次尝试、不重试；拿不到 JSON 就回落到 HTML 解析（两条路都测过）。
  for (const lang of ['ja', 'zh-cn']) {
    try {
      const res = await requestUrl(`https://booth.pm/${lang}/items/${id}.json`, 'application/json');
      const statusCode = Number(res?.status) || 0;
      // JSON 端点也会先挨 429/403：同样写全局暂停并直接收手，别再去打 HTML 那个入口。
      if (statusCode === 403 || statusCode === 429) {
        const pause = await noteBoothPause({ stateDir, now: nowMs }, { status: statusCode, retryAfter: retryAfterOf(res?.headers) });
        log(`BOOTH JSON 端点 HTTP ${statusCode}：写入全局暂停（${Math.max(1, Math.round((pause?.pauseMs || 0) / 60000))} 分钟）`);
        // 兼容口径：403 继续报 status='blocked'（旧调用方/旧断言还在用），另加 paused/blocked 让新调用方
        // 能识别「这是全局暂停」；只有 429 用 status='paused'（旧语义是 error，本来就要改断言）。
        const blockedStatus = statusCode === 403 ? 'blocked' : 'paused';
        return { ...base, status: blockedStatus, blocked: statusCode === 403, paused: true, error: `BOOTH 回了 HTTP ${statusCode}，已全局暂停抓取，稍后自动恢复` };
      }
      if (statusCode === 200) {
        const text = await res.text();
        if (text.trim().startsWith('{')) {
          let parsedJson;
          try { parsedJson = JSON.parse(text); } catch { parsedJson = null; }
          if (parsedJson) {
            const meta = { ...base, ...parseBoothJson(parsedJson, { boothId: id, itemUrl: base.itemUrl }), cached: false };
            meta.ok = meta.status === 'ok';
            if (meta.status === 'ok') writeCache(cacheDir, id, meta, nowMs);
            return meta;
          }
        }
      }
    } catch { /* JSON 不可用 → HTML 兜底 */ }
  }

  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await requestUrl(`${BOOTH_ITEM_BASE}${id}`, 'text/html,application/xhtml+xml');
      const statusCode = Number(res?.status) || 0;
      if (statusCode === 404) {
        const meta = { ...base, status: 'not_found', error: '商品不存在（HTTP 404）' };
        writeCache(cacheDir, id, meta, nowMs);
        return meta;
      }
      if (statusCode === 403) {
        // 403 与 429 一样是「别再打了」的信号：写全局暂停，所有 BOOTH 任务一起等，
        // 而不是让上层一个个重试把出口 IP 彻底打黑。
        const pause = await noteBoothPause({ stateDir, now: nowMs }, { status: 403 });
        log(`BOOTH 403：写入全局暂停（${Math.round((pause?.pauseMs || 0) / 60000)} 分钟）`);
        return { ...base, status: 'blocked', blocked: true, paused: true, error: '被拒绝访问（HTTP 403）后已暂停抓取，稍后自动恢复' };
      }
      if (statusCode === 429) {
        const pause = await noteBoothPause({ stateDir, now: nowMs }, { status: 429, retryAfter: retryAfterOf(res?.headers) });
        const minutes = Math.max(1, Math.round((pause?.pauseMs || 0) / 60000));
        log(`BOOTH 429：写入全局暂停（${minutes} 分钟）`);
        // 已经知道被限速了就直接收手：再重试一次等于自己往枪口上撞。
        return { ...base, status: 'paused', paused: true, error: `BOOTH 回了 HTTP 429，已全局暂停抓取 ${minutes} 分钟` };
      }
      if (statusCode >= 500) {
        lastError = `HTTP ${statusCode}`;
        if (attempt === 0) await sleep(Math.max(cfg.rateLimitMs, 1500));
        continue;
      }
      if (statusCode < 200 || statusCode >= 300) {
        return { ...base, status: 'error', error: `HTTP ${statusCode}` };
      }
      const html = await readBoundedText(res);
      const parsed = parseBoothHtml(html, { boothId: id, itemUrl: base.itemUrl });
      const meta = {
        ...base,
        ...parsed,
        ok: parsed.status === 'ok',
        itemUrl: parsed.itemUrl || base.itemUrl
      };
      if (meta.status === 'ok' || meta.status === 'gated') writeCache(cacheDir, id, meta, nowMs);
      return meta;
    } catch (error) {
      lastError = String(error?.message ?? error);
      if (attempt === 0) await sleep(Math.max(cfg.rateLimitMs, 1500));
    }
  }
  log(`BOOTH 元数据抓取失败 ${id}：${lastError}`);
  return { ...base, status: 'error', error: lastError || '抓取失败' };
}
