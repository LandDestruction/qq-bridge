// src/library-cover-source.js — 素材库 v2 的两块纯规则：已购台账 → cloud 视图卡片、
// 回收站台账 → trash 视图卡片，以及这两类「远程卡片」的搜索/排序/分页。
//
// 为什么单独一个纯模块：cloud / trash 的卡片要在路由里和素材卡同构地分页，但它们的
// 数据源是 state/ 下的台账文件（不是扫盘结果）。规则放这里可以脱离 fs 单测；
// 路由层只负责读文件、把本地封面地址补成能直接显示的形式。
//
// 和素材卡（src/library-asset.js）的字段对齐：key/title/boothId/shop/files/bytes/tags/
// category/coverUrl/coverSource/coverReady，前端能复用同一套卡片组件。

export const PURCHASES_FILE = 'booth-purchases.json';
export const PURCHASE_COVERS_DIR = 'booth-purchase-covers';
export const PURCHASE_CARD_PREFIX = 'purchase:';
export const TRASH_FILE = 'booth-trash.json';
export const REMOTE_CARDS_DEFAULT_LIMIT = 120;
export const REMOTE_CARDS_MAX_LIMIT = 500;

const BOOTH_ID_RE = /^\d{5,9}$/;

function textOf(value, maxChars) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value ?? '').trim());
}

/** 已购台账里的一条记录 → 归一化条目；号不合法返回 null（坏数据不能变出卡片）。 */
export function normalizePurchaseItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const boothId = String(raw.boothId ?? '').trim();
  if (!BOOTH_ID_RE.test(boothId)) return null;
  const addedAt = Number(raw.addedAt);
  const updatedAt = Number(raw.updatedAt);
  return {
    boothId,
    title: textOf(raw.title, 300),
    shopName: textOf(raw.shopName ?? raw.shop, 120),
    priceText: textOf(raw.priceText, 60),
    coverUrl: isHttpUrl(raw.coverUrl) ? String(raw.coverUrl).trim() : '',
    coverRel: String(raw.coverRel ?? '').trim(),
    itemUrl: String(raw.itemUrl ?? '').trim() || `https://booth.pm/ja/items/${boothId}`,
    addedAt: Number.isFinite(addedAt) && addedAt > 0 ? Math.trunc(addedAt) : 0,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.trunc(updatedAt) : 0
  };
}

/**
 * 台账文件内容（{version,items} 或 {items} 或裸 map）→ 归一化条目数组。
 * 按 addedAt 倒序（新的在前）；addedAt 相同或缺失时保持原顺序（稳定排序）。
 */
export function purchasesFromState(raw) {
  const items = raw && typeof raw === 'object'
    ? (raw.items && typeof raw.items === 'object' ? raw.items : raw)
    : {};
  const out = [];
  for (const [boothId, value] of Object.entries(items)) {
    if (!BOOTH_ID_RE.test(String(boothId))) continue;
    const item = normalizePurchaseItem({ ...(value && typeof value === 'object' ? value : {}), boothId });
    if (item) out.push(item);
  }
  out.sort((a, b) => b.addedAt - a.addedAt);
  return out;
}

/** 'purchase:123456' → '123456'；不是这个形状返回 ''。 */
export function purchaseBoothIdOf(key) {
  const text = String(key ?? '').trim();
  if (!text.startsWith(PURCHASE_CARD_PREFIX)) return '';
  const boothId = text.slice(PURCHASE_CARD_PREFIX.length);
  return BOOTH_ID_RE.test(boothId) ? boothId : '';
}

/**
 * 已购条目 → 和素材卡同构的对象。
 * coverUrl 这里只放台账里的远程地址；本地已缓存时由路由层替换成
 * /api/library/purchases/cover（带版本号，可长缓存），纯模块不碰 fs。
 */
export function cloudCardOf(item) {
  const entry = normalizePurchaseItem(item);
  if (!entry) return null;
  return {
    key: `${PURCHASE_CARD_PREFIX}${entry.boothId}`,
    kind: 'purchase',
    title: entry.title || entry.boothId,
    boothId: entry.boothId,
    boothSource: 'purchase',
    shop: entry.shopName,
    shopName: entry.shopName,
    priceText: entry.priceText,
    coverUrl: entry.coverUrl,
    coverRemote: isHttpUrl(entry.coverUrl),
    coverSource: entry.coverUrl ? 'ledger' : '',
    coverReady: Boolean(entry.coverUrl),
    itemUrl: entry.itemUrl,
    source: 'purchase',
    downloaded: false,
    files: 0,
    bytes: 0,
    tags: [],
    category: '',
    dir: '',
    mainName: '',
    addedAt: entry.addedAt,
    updatedAt: entry.updatedAt
  };
}

/**
 * 已购台账 → cloud 视图卡片。
 * 已经在素材库里出现过的 BOOTH 号要排掉：那件已经下载了，再列一遍只会让人以为缺文件
 * （验收口径：view=cloud 的条数要和 reconcile.missing 对得上）。
 */
export function cloudCardsFromPurchases(purchases, { libraryBoothIds = [] } = {}) {
  const listed = new Set((Array.isArray(libraryBoothIds) ? libraryBoothIds : []).map((id) => String(id ?? '').trim()));
  const out = [];
  for (const item of Array.isArray(purchases) ? purchases : []) {
    const card = cloudCardOf(item);
    if (!card) continue;
    if (listed.has(card.boothId)) continue;
    out.push(card);
  }
  return out;
}

/** 回收站记录 → 素材卡同构对象（key 用回收站记录 id，主键在回收站里唯一）。 */
export function trashCardOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? raw.key ?? '').trim();
  if (!id) return null;
  const boothId = String(raw.boothId ?? '').trim();
  return {
    key: id,
    kind: 'trash',
    title: textOf(raw.title, 300) || String(raw.key ?? id),
    boothId: BOOTH_ID_RE.test(boothId) ? boothId : '',
    coverUrl: '',
    coverSource: '',
    coverReady: false,
    source: 'trash',
    inTrash: true,
    trashId: id,
    originalKey: String(raw.key ?? '').trim(),
    files: numberOrZero(raw.files),
    bytes: numberOrZero(raw.bytes),
    dirs: Array.isArray(raw.fromDirs) ? raw.fromDirs.map((d) => String(d ?? '')).filter(Boolean) : [],
    movedTo: String(raw.movedTo ?? ''),
    deletedAt: numberOrZero(raw.at),
    tags: [],
    category: ''
  };
}

/** 回收站台账内容 → trash 卡片数组（按删除时间倒序，坏的记录直接丢）。 */
export function trashCardsFromState(raw) {
  const items = raw && typeof raw === 'object' && Array.isArray(raw.items) ? raw.items : [];
  const out = items.map((item) => trashCardOf(item)).filter(Boolean);
  out.sort((a, b) => b.deletedAt - a.deletedAt);
  return out;
}

function matchesQuery(card, q) {
  const needle = String(q ?? '').trim().toLowerCase();
  if (!needle) return true;
  const hay = [card.title, card.shopName, card.shop, card.boothId].map((v) => String(v ?? '').toLowerCase()).join('\n');
  return hay.includes(needle);
}

function compareTitle(a, b) {
  const left = String(a.title ?? '').trim();
  const right = String(b.title ?? '').trim();
  if (!left && !right) return String(a.key).localeCompare(String(b.key));
  if (!left) return 1;
  if (!right) return -1;
  const byTitle = left.localeCompare(right, 'zh-Hans-CN');
  return byTitle !== 0 ? byTitle : String(a.key).localeCompare(String(b.key));
}

function compareBooth(a, b) {
  const left = BOOTH_ID_RE.test(String(a.boothId ?? '')) ? 1 : 0;
  const right = BOOTH_ID_RE.test(String(b.boothId ?? '')) ? 1 : 0;
  if (left !== right) return right - left;
  return compareTitle(a, b);
}

/**
 * 远程卡片（cloud/trash）的搜索 + 排序 + 分页。
 * 排序口径和素材页一致（recent/title/booth），分页参数也复用同一套默认值：默认 120、最多 500。
 */
export function pickRemoteCards(cards, { q = '', sort = 'recent', offset = 0, limit = REMOTE_CARDS_DEFAULT_LIMIT } = {}) {
  const list = (Array.isArray(cards) ? cards : []).filter((card) => matchesQuery(card, q));
  const mode = ['recent', 'title', 'booth'].includes(String(sort ?? '')) ? String(sort) : 'recent';
  if (mode === 'title') list.sort(compareTitle);
  else if (mode === 'booth') list.sort(compareBooth);
  // recent：调用方已按时间倒序排好（云卡片按 addedAt、回收站按删除时间），这里保持原序。
  const startRaw = Number(offset);
  const start = Number.isFinite(startRaw) && startRaw > 0 ? Math.floor(startRaw) : 0;
  const limitRaw = Number(limit);
  const size = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(REMOTE_CARDS_MAX_LIMIT, Math.floor(limitRaw))
    : REMOTE_CARDS_DEFAULT_LIMIT;
  const page = list.slice(start, start + size);
  return {
    items: page,
    count: page.length,
    total: list.length,
    allCount: Array.isArray(cards) ? cards.length : 0,
    offset: start,
    limit: size,
    truncated: start + page.length < list.length,
    q: String(q ?? '').trim(),
    sort: mode
  };
}
