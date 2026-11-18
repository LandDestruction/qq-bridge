// BOOTH 商品页纯规则解析（「已购库」用）。
//
// 约束（刻意保持）：只吃 HTML 字符串 —— 不发网络请求、不读 state、不 import bridge 任何东西，
// 所以可以脱离桥接单测（scripts/test-booth-product.mjs）。
//
// 取值优先级：JSON-LD(Product) > og/meta > 页面结构。解析不到就给 '' / [] / null，
// 不靠猜、不留「大概对」的兜底值；坏 HTML / 不是商品页返回 null（不抛错）。
//
// 页面实况（2026-10-29 抓的真实页，fixture 见 scripts/fixtures/booth-product/）：
//   - 商品头部的 JSON-LD 是唯一可靠的整块数据源：name / description / url /
//     offers（Offer 或 AggregateOffer）/ brand（店铺）/ image。
//   - 规格（variations）是服务端渲染的 <li class="variation-item">；单价格商品也会有一个
//     variation-item，但里面没有 variation-name —— 那种默认购买档不算「选项」，不返回到 variations。
//   - 标签（js-item-tag-list）与分类面包屑（js-item-category-breadcrumbs）是客户端渲染的空壳，
//     服务端 HTML 里只有 tags%5B%5D= / /ja/browse/ 链接可抽；抽不到就给空数组。
//   - 展示图在 item 区的 data-origin 属性里（原图 png），og:image / JSON-LD image 只有首页图。

const ITEM_PATH_RE = /\/items\/(\d+)(?:[/?#]|$)/;
const BOOTH_HOST_RE = /(^|\.)booth\.pm$/i;

function decodeEntities(input) {
  return String(input || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(input) {
  return String(input || '').replace(/<[^>]*>/g, ' ');
}

/** 标签文本 → 纯文本（去标签、解实体、压空白）。 */
function textOf(input) {
  return decodeEntities(stripTags(input)).replace(/\s+/g, ' ').trim();
}

function firstMatch(source, re) {
  const m = String(source || '').match(re);
  return m ? m[1] : '';
}

/** 读取 <meta property|name="prop" content="...">，容忍 content 在 property 前。 */
function metaContent(html, prop) {
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const direct = firstMatch(html, new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]*content=["']([^"']*)["']`, 'i'));
  if (direct) return decodeEntities(direct).trim();
  const reversed = firstMatch(html, new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${esc}["']`, 'i'));
  return decodeEntities(reversed).trim();
}

function canonicalUrl(html) {
  return firstMatch(html, /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)
    || firstMatch(html, /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
}

/**
 * 从一段文本里抽 BOOTH 商品 id。
 * 接受：https://booth.pm/ja/items/123、https://xx.booth.pm/items/123、
 * 带 query/hash 的链接、#123、纯数字 123。识别不了返回 null（不抛错）。
 */
export function parseItemUrl(text) {
  if (text === null || text === undefined) return null;
  const raw = String(text).trim();
  if (!raw) return null;

  const bare = raw.match(/^#?(\d{1,12})$/);
  if (bare) return bare[1];

  const withScheme = /^https?:\/\//i.test(raw) ? raw : (/^[a-z0-9.-]+\.booth\.pm\//i.test(raw) ? `https://${raw}` : '');
  if (!withScheme) return null;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!BOOTH_HOST_RE.test(url.hostname)) return null;
  const m = url.pathname.match(ITEM_PATH_RE);
  return m ? m[1] : null;
}

/** 从「3モデル」「3 モデル対応」「3アバター対応」「11Avatars」这类文字里抽适配数量；抽不到返回 0。 */
export function modelCountOf(name) {
  if (name === null || name === undefined) return 0;
  const text = String(name);
  const afterUnit = text.match(/(\d+)\s*(?:種類|体|人)?\s*(?:アバター|モデル|avatars?|models?)/i);
  const beforeUnit = text.match(/(?:アバター|モデル|avatars?|models?)\s*(?:数)?\s*[:：]?\s*(\d+)/i);
  const hit = afterUnit || beforeUnit;
  if (!hit) return 0;
  const n = Number(hit[1]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 规格列表 → {max 最大适配数, total 各规格相加, labeled 能解析出数字的规格数}。 */
export function summarizeModels(variations) {
  const list = Array.isArray(variations) ? variations : [];
  let max = 0;
  let total = 0;
  let labeled = 0;
  for (const item of list) {
    const declared = item && Number.isFinite(item.modelCount) ? item.modelCount : modelCountOf(item && item.name);
    const n = Number.isFinite(declared) && declared > 0 ? declared : 0;
    if (n > 0) {
      labeled += 1;
      total += n;
      if (n > max) max = n;
    }
  }
  return { max, total, labeled };
}

function findJsonLdProduct(html) {
  const blocks = [...String(html).matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(block[1].trim());
    } catch {
      continue;
    }
    const found = walkForProduct(parsed);
    if (found) return found;
  }
  return null;
}

function walkForProduct(node, depth = 0) {
  if (!node || depth > 4) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = walkForProduct(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => typeof t === 'string' && t.toLowerCase() === 'product')) return node;
  if (node['@graph']) {
    const found = walkForProduct(node['@graph'], depth + 1);
    if (found) return found;
  }
  return null;
}

/** 商品详情区（从 <div class="market"> 到「本店其他商品」推荐区之前）。推荐区里有别的商品卡片，不能混进来。 */
function itemArea(html) {
  const source = String(html);
  const start = source.indexOf('<div class="market');
  const from = start >= 0 ? start : 0;
  const end = source.indexOf('<div class="shop-items', from);
  return end > from ? source.slice(from, end) : source.slice(from);
}

function readOffers(product) {
  if (!product) return {};
  const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
  return offers && typeof offers === 'object' ? offers : {};
}

function toPriceNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const digits = String(value).replace(/[^\d.]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

const CURRENCY_SYMBOL = { JPY: '¥', USD: '$', EUR: '€', GBP: '£', CNY: '¥' };

/** 统一价格文本：JPY → `¥ 1,800`；未知币种 → `USD 1,800`。 */
function formatPrice(price, currency) {
  if (!Number.isFinite(price)) return '';
  const symbol = CURRENCY_SYMBOL[currency] || `${currency || ''} `;
  const amount = price.toLocaleString('en-US');
  return `${symbol}${symbol.endsWith(' ') ? '' : ' '}${amount}`.replace(/\s+/g, ' ').trim();
}

function brandInfo(product) {
  const brand = Array.isArray(product?.brand) ? product.brand[0] : product?.brand;
  if (!brand) return { shopName: '', shopUrl: '' };
  if (typeof brand === 'string') return { shopName: brand.trim(), shopUrl: '' };
  if (typeof brand === 'object') {
    return {
      shopName: String(brand.name || '').trim(),
      shopUrl: String(brand.url || '').trim(),
    };
  }
  return { shopName: '', shopUrl: '' };
}

/** 页面结构兜底店铺：商品头部的 shop-name 锚点（JSON-LD 缺 brand 时才用）。 */
function shopFromMarkup(area) {
  const name = firstMatch(area, /<div class="shop-name[^"]*"[^>]*>\s*<a[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([^<]+)<\/a>/i);
  const href = firstMatch(area, /<div class="shop-name[^"]*"[^>]*>\s*<a[^>]*href=["'](https?:\/\/[^"']+)["']/i);
  return { shopName: textOf(name), shopUrl: decodeEntities(href).trim() };
}

/** 同一张商品图有原图 png、`_base_resized.jpg`、`c/620x620/…` 三种地址：按图片身份去重。 */
function imageIdentity(url) {
  const m = String(url).match(/\/i\/\d+\/([^/?#]+?)(?:_base_resized)?\.(?:png|jpe?g|gif|webp)$/i);
  return m ? m[1].toLowerCase() : String(url).toLowerCase();
}

function collectImages(product, area, html) {
  const seen = new Set();
  const images = [];
  const push = (value) => {
    if (!value) return;
    const url = decodeEntities(String(value)).trim();
    if (!/^https?:\/\//i.test(url)) return;
    const key = imageIdentity(url);
    if (seen.has(key)) return;
    seen.add(key);
    images.push(url);
  };

  // 1) item 区原图（data-origin）；只取本商品图，排除店铺头像 /users/。
  for (const m of area.matchAll(/data-origin=["']([^"']+)["']/gi)) {
    if (!/\/users\//.test(m[1])) push(m[1]);
  }
  // 2) JSON-LD image（字符串 / 数组 / ImageObject）。
  const ldImage = product?.image;
  const ldImages = Array.isArray(ldImage) ? ldImage : [ldImage];
  for (const entry of ldImages) {
    if (!entry) continue;
    push(typeof entry === 'string' ? entry : entry.url || entry.contentUrl);
  }
  // 3) og:image。
  push(metaContent(html, 'og:image'));
  return images;
}

function collectTags(product, area) {
  const seen = new Set();
  const tags = [];
  const push = (value) => {
    const tag = decodeEntities(String(value || '')).trim();
    if (!tag || seen.has(tag)) return;
    seen.add(tag);
    tags.push(tag);
  };
  for (const m of area.matchAll(/tags%5B%5D=([^"'&]+)/g)) push(m[1]);
  const keywords = product?.keywords;
  const list = Array.isArray(keywords) ? keywords : (typeof keywords === 'string' ? keywords.split(',') : []);
  for (const keyword of list) push(keyword);
  return tags;
}

function collectCategories(product, area) {
  const seen = new Set();
  const categories = [];
  const push = (value) => {
    const name = decodeEntities(String(value || '')).trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    categories.push(name);
  };
  for (const m of area.matchAll(/\/ja\/browse\/([^"'?#]+)/g)) {
    const path = decodeEntities(m[1]).split('/').filter(Boolean);
    if (path.length) push(path[path.length - 1]);
  }
  const category = product?.category;
  const list = Array.isArray(category) ? category : [category];
  for (const entry of list) {
    if (typeof entry === 'string' && !/^\d+$/.test(entry)) push(entry);
  }
  return categories;
}

function collectVariations(area) {
  const start = area.indexOf('id="variations"');
  if (start < 0) return [];
  const region = area.slice(start);
  const variations = [];
  for (const block of region.matchAll(/<li\b[^>]*class=["'][^"']*variation-item[^"']*["'][\s\S]*?<\/li>/gi)) {
    const chunk = block[0];
    const name = textOf(firstMatch(chunk, /class=["'][^"']*variation-name[^"']*["'][^>]*>([\s\S]*?)<\/div>/i));
    // 单价格商品的默认购买档没有 variation-name：那不是「可选规格」，整条跳过。
    if (!name) continue;
    const priceText = textOf(firstMatch(chunk, /class=["'][^"']*variation-price[^"']*["'][^>]*>([\s\S]*?)<\/div>/i));
    variations.push({
      name,
      priceText,
      price: toPriceNumber(priceText),
      modelCount: modelCountOf(name),
      soldOut: /売り切れ|SOLD\s*OUT|Sold\s*Out|在庫切れ/i.test(chunk),
    });
  }
  return variations;
}

/**
 * 解析 BOOTH 商品页 HTML。
 * 不是商品页 / HTML 不可解析 → null（不抛错）。字段缺省：字符串 ''、数组 []、数字 null。
 */
export function parseBoothItemHtml(html) {
  if (typeof html !== 'string' || html.length < 50) return null;
  const product = findJsonLdProduct(html);
  const area = itemArea(html);

  const canonical = canonicalUrl(html);
  const ogUrl = metaContent(html, 'og:url');
  const candidates = [product?.url, ogUrl, canonical, firstMatch(area, /data-product-id=["'](\d+)["']/i)];
  let boothId = '';
  for (const candidate of candidates) {
    if (!candidate) continue;
    const id = parseItemUrl(candidate);
    if (id) {
      boothId = id;
      break;
    }
  }

  // 不是商品页就别返回半个对象：真实商品页一定有 JSON-LD Product，或至少带 og:type=product /
  // data-product-id / items/<id> 链接之一；只有 <title> 的页面（登录墙、404、验证页）一律 null。
  const looksLikeItem = Boolean(product)
    || metaContent(html, 'og:type').toLowerCase() === 'product'
    || Boolean(boothId)
    || /data-product-id=["']\d+["']/i.test(area);
  if (!looksLikeItem) return null;

  const ogTitle = metaContent(html, 'og:title');
  const title = String(product?.name || ogTitle || textOf(firstMatch(html, /<title>([\s\S]*?)<\/title>/i)) || '')
    .replace(/\s+-\s+[^-]{1,80}\s+-\s+BOOTH$/i, '')
    .replace(/\s+-\s+BOOTH$/i, '')
    .trim();
  if (!title) return null;

  const offers = readOffers(product);
  const priceValue = offers.price ?? offers.lowPrice ?? offers.highPrice;
  const price = toPriceNumber(priceValue);
  const currency = String(offers.priceCurrency || '').trim();
  const availability = String(offers.availability || '').trim();

  const brand = brandInfo(product);
  const markupShop = brand.shopName ? { shopName: '', shopUrl: '' } : shopFromMarkup(area);
  const shopName = brand.shopName || markupShop.shopName;
  const shopUrl = brand.shopUrl || markupShop.shopUrl;

  const images = collectImages(product, area, html);
  const variations = collectVariations(area);

  let itemUrl = String(product?.url || ogUrl || canonical || '').trim();
  if (!/^https?:\/\//i.test(itemUrl) && boothId) itemUrl = `https://booth.pm/ja/items/${boothId}`;

  return {
    boothId,
    itemUrl,
    title,
    shopName,
    shopUrl,
    price,
    currency: currency || (price !== null ? 'JPY' : ''),
    priceText: formatPrice(price, currency || 'JPY'),
    tags: collectTags(product, area),
    categories: collectCategories(product, area),
    images,
    coverUrl: images[0] || null,
    description: String(product?.description || metaContent(html, 'og:description') || metaContent(html, 'description') || '').trim(),
    isFree: price === 0,
    isSoldOut: /outofstock|sold\s*out|soldout/i.test(availability),
    variations,
    models: summarizeModels(variations),
  };
}

/** 一行中文摘要（≤100 字，无换行），给「已购库」列表副标题 / 日志用。 */
export function describePurchaseItem(item) {
  if (!item || typeof item !== 'object') return '';
  const parts = [];
  const title = String(item.title || '').trim();
  if (title) parts.push(`「${title}」`);
  const shopName = String(item.shopName || '').trim();
  if (shopName) parts.push(shopName);
  if (item.isFree) parts.push('免费');
  else if (item.priceText) parts.push(String(item.priceText).trim());
  const variations = Array.isArray(item.variations) ? item.variations : [];
  const models = item.models && typeof item.models === 'object' ? item.models : summarizeModels(variations);
  if (variations.length > 1) {
    parts.push(`${variations.length} 个规格${models.max ? `（最多 ${models.max} 个模型）` : ''}`);
  } else if (models.max) {
    parts.push(`适配 ${models.max} 个模型`);
  }
  if (Array.isArray(item.tags) && item.tags.length) parts.push(item.tags.slice(0, 3).join('/'));
  return parts.join(' · ').replace(/\s+/g, ' ').trim().slice(0, 100);
}
