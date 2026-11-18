// src/library-reconcile.js — 「已购库 ↔ 素材库」对账的纯规则（零 import，可单测）。
//
// 回答两个用户最常问的问题：
//   1) 我买了但素材库里没有的是哪些？（missing —— 最想看的，怕漏存/漏转）
//   2) 库里哪些还没登记成已购？（extra —— 可能买了忘了登记，也可能是别人给的）
//
// 口径（写死在这里，路由层不许各算一套）：
//   - 两边都用 boothId 认同一件商品；字符串 trim 后必须 5~9 位数字，空值/非法值不参与匹配
//     （库里很多卡片本来就没号，它们既不算 matched 也不算 extra，只让用户知道「有号的有几件」）。
//   - 已购表按 boothId 去重（台账本身就是以号为键，这里再兜一次读盘的老数据）。
//   - 同一号在库里可能有多张卡（合并前/改名后残留、不同目录各存一份）：inLibrary 按**卡片**列，
//     stats.inLibrary 也是卡片数；matched 按**号**算，这样「买了 3 件、库里对上 2 件」不会被重复卡误导。

const RECONCILE_ID_RE = /^\d{5,9}$/;

/** 号统一口径：trim 后必须 5~9 位数字，否则当没有号。 */
export function reconcileIdOf(value) {
  const text = String(value ?? '').trim();
  return RECONCILE_ID_RE.test(text) ? text : '';
}

/** 台账条目 → 对账用最小字段。title/shop/price 只做展示，截断防止脏数据把响应撑大。 */
export function normalizeReconcilePurchase(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const boothId = reconcileIdOf(raw.boothId);
  if (!boothId) return null;
  const coverRel = String(raw.coverRel ?? '').trim();
  return {
    boothId,
    title: String(raw.title ?? '').slice(0, 300),
    shop: String(raw.shopName ?? raw.shop ?? '').slice(0, 120),
    priceText: String(raw.priceText ?? raw.price ?? '').slice(0, 60),
    coverRel,
    itemUrl: String(raw.itemUrl ?? '').slice(0, 500) || `https://booth.pm/ja/items/${boothId}`,
    updatedAt: Math.max(0, Number(raw.updatedAt) || 0)
  };
}

/** 读盘后的 `{version, items:{id:item}}` → 条目数组（坏条目丢掉，不整份报错）。 */
export function purchasesFromState(state) {
  const items = state && typeof state === 'object' && state.items && typeof state.items === 'object' ? state.items : {};
  const out = [];
  for (const key of Object.keys(items)) {
    const item = normalizeReconcilePurchase(items[key]);
    if (item) out.push(item);
  }
  return out;
}

/**
 * 主函数：已购 × 素材快照。
 * @param {{purchases?: Array, assets?: Array, boothId?: string, now?: number}} input
 * @returns {{stats:object, purchased:Array, missing:Array, inLibrary:Array, extra:Array, generatedAt:number}}
 */
export function reconcilePurchasedAndLibrary(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const wantId = reconcileIdOf(input.boothId);

  // 已购侧：按号去重（同一号只留更新时间新的那条），再按号排序保证输出稳定。
  const purchaseById = new Map();
  for (const raw of Array.isArray(input.purchases) ? input.purchases : []) {
    const item = normalizeReconcilePurchase(raw);
    if (!item) continue;
    if (wantId && item.boothId !== wantId) continue;
    const prev = purchaseById.get(item.boothId);
    if (!prev || item.updatedAt >= prev.updatedAt) purchaseById.set(item.boothId, item);
  }
  const purchases = [...purchaseById.values()].sort((a, b) => a.boothId.localeCompare(b.boothId));

  // 素材侧：只认有号的卡；无号卡根本不参与匹配，也不列进 inLibrary（没号谈不上「已购对应」）。
  const cards = [];
  for (const asset of Array.isArray(input.assets) ? input.assets : []) {
    const boothId = reconcileIdOf(asset?.boothId);
    if (!boothId) continue;
    if (wantId && boothId !== wantId) continue;
    cards.push({
      boothId,
      title: String(asset?.title ?? '').slice(0, 300),
      key: String(asset?.key ?? ''),
      dir: String(asset?.dir ?? '')
    });
  }
  cards.sort((a, b) => a.boothId.localeCompare(b.boothId) || a.key.localeCompare(b.key));

  const libraryIds = new Set(cards.map((card) => card.boothId));
  const purchaseIds = new Set(purchases.map((item) => item.boothId));

  const missing = purchases
    .filter((item) => !libraryIds.has(item.boothId))
    // coverRel 给路由层判断「本地有没有封面」用（纯函数不碰 fs），路由再换成 thumb URL。
    .map((item) => ({ boothId: item.boothId, title: item.title, shop: item.shop, priceText: item.priceText, itemUrl: item.itemUrl, coverRel: item.coverRel, updatedAt: item.updatedAt }));
  const extra = cards
    .filter((card) => !purchaseIds.has(card.boothId))
    .map((card) => ({ ...card, boothId: card.boothId }));

  return {
    stats: {
      purchased: purchases.length,
      inLibrary: cards.length,
      matched: purchases.filter((item) => libraryIds.has(item.boothId)).length,
      missing: missing.length,
      extra: extra.length
    },
    purchased: purchases.map((item) => ({
      boothId: item.boothId,
      title: item.title,
      shop: item.shop,
      priceText: item.priceText,
      itemUrl: item.itemUrl,
      coverRel: item.coverRel,
      updatedAt: item.updatedAt
    })),
    missing,
    inLibrary: cards,
    extra,
    generatedAt: now
  };
}

/** 卡片按号分组：deep 视图里 inLibrary/extra 都是一个号一条，带 keys/dirs（前端按号操作）。 */
export function groupCardsByBoothId(cards) {
  const byId = new Map();
  for (const card of Array.isArray(cards) ? cards : []) {
    const boothId = reconcileIdOf(card?.boothId);
    if (!boothId) continue;
    const group = byId.get(boothId) || { boothId, title: '', keys: [], dirs: [] };
    if (!group.title && card.title) group.title = String(card.title).slice(0, 300);
    const key = String(card.key ?? '');
    if (key && !group.keys.includes(key)) group.keys.push(key);
    const dir = String(card.dir ?? '');
    if (dir && !group.dirs.includes(dir)) group.dirs.push(dir);
    byId.set(boothId, group);
  }
  return [...byId.values()].sort((a, b) => a.boothId.localeCompare(b.boothId));
}

/** 标题归一：只用来做「同名但对不上号」的保守提示，判不准宁可不提示。 */
function reconcileTitleKey(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[\s_\-–—·:：,，.。()（）[\]【】「」『』]+/g, '')
    .slice(0, 120);
}

/**
 * deep=1 的完整视图：老字段照旧 + 分组展示字段 + 可执行动作（actions）。
 * 动作 id 稳定（类型:号），sync 执行时前端回传的就是这些 id。
 * @param {{purchases?:Array, assets?:Array, boothId?:string, goneIds?:Array, now?:number}} input
 */
export function reconcileDeepPlan(input = {}) {
  const result = reconcilePurchasedAndLibrary(input);
  const gone = new Set(
    (Array.isArray(input.goneIds) ? input.goneIds : []).map((value) => reconcileIdOf(value)).filter(Boolean)
  );
  const inLibrary = groupCardsByBoothId(result.inLibrary);
  const extra = groupCardsByBoothId(result.extra);
  const missing = result.missing.map((item) => ({ ...item, downloadable: true }));
  const actions = [];

  // bind：一个号在库里有 ≥2 件未被台账关联（keys 给全部候选，前端默认勾上主选第一件）。
  for (const group of extra) {
    if (group.keys.length < 2) continue;
    actions.push({
      id: `bind:${group.boothId}`,
      type: 'bind',
      action: 'bind',
      boothId: group.boothId,
      keys: [...group.keys],
      title: group.title || `#${group.boothId}`,
      reason: `库里有 ${group.keys.length} 件同号素材还没登记已购`
    });
  }

  // download：台账有、库里有 0 件。
  for (const item of missing) {
    actions.push({
      id: `download:${item.boothId}`,
      type: 'download',
      action: 'download',
      boothId: item.boothId,
      title: item.title || `#${item.boothId}`,
      reason: '已购但素材库里没有文件'
    });
  }

  // forget：只在「BOOTH 侧已删除」能判定时才出（刷新时 404 会打 gone 标记），宁缺勿假。
  for (const item of result.purchased) {
    if (!gone.has(item.boothId)) continue;
    actions.push({
      id: `forget:${item.boothId}`,
      type: 'forget',
      action: 'forget',
      boothId: item.boothId,
      title: item.title || `#${item.boothId}`,
      reason: 'BOOTH 侧这件已删除/下架，台账里还留着'
    });
  }

  // review：已购没对上库里的号，但库里有个同名素材号却对不上（人工确认是不是同一件）。
  const libraryByTitle = new Map();
  for (const group of inLibrary) {
    const key = reconcileTitleKey(group.title);
    if (key && !libraryByTitle.has(key)) libraryByTitle.set(key, group);
  }
  for (const item of missing) {
    const key = reconcileTitleKey(item.title);
    const group = key ? libraryByTitle.get(key) : null;
    if (!group || group.boothId === item.boothId) continue;
    if (result.purchased.some((row) => row.boothId === group.boothId)) continue;
    actions.push({
      id: `review:${item.boothId}:${group.boothId}`,
      type: 'review',
      action: 'ambiguous',
      boothId: item.boothId,
      keys: [...group.keys],
      title: item.title || group.title,
      reason: `库里同名素材的号是 #${group.boothId}，和已购 #${item.boothId} 对不上`
    });
  }

  const summary = { bind: 0, download: 0, forget: 0, review: 0 };
  for (const action of actions) summary[action.type] += 1;
  return {
    stats: {
      ...result.stats,
      pending: actions.length,
      forgotten: summary.forget,
      ambiguous: summary.review
    },
    purchased: result.purchased,
    missing,
    inLibrary,
    extra,
    actions,
    summary,
    generatedAt: result.generatedAt
  };
}
