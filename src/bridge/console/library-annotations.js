// 素材卡的「关系型字段」：收藏 / 已购 / 工程使用 / 重复号 / 分类。
//
// 为什么单独一个文件：这些字段都要读 state/ 里的台账（收藏表、已购表、使用统计），
// 而 library-view.js 已贴着 800 行规模闸。拆出来后：
//   - 素材页、facets 计数、详情页可以共用同一份「补字段」逻辑；
//   - 每个 state 文件只有一个读取入口，格式变更不用改三处；
//   - 纯函数（分类/桶）仍在 src/library-*.js，可单独单测。
//
// 约束：本文件由 library-view.js（ESM）直接 import，不走 manifest。

import { applyCategoryToAsset } from '../../library-category.js';
import { normalizeFavorites, FAVORITES_FILE } from '../../library-favorites.js';

const PURCHASES_FILE = 'booth-purchases.json';
const FREE_FILE = 'booth-free.json';
const USAGE_FILE = 'booth-usage.json';

/** 读一个 state JSON；读不到/坏了都返回 null（读接口不能因为一个坏文件整页 500）。 */
function readStateJson(deps, fileName) {
  try {
    const file = deps.path.join(String(deps.STATE_DIR), fileName);
    return JSON.parse(deps.fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function favoriteTableOf(deps) {
  return normalizeFavorites(readStateJson(deps, FAVORITES_FILE));
}

/** 已购台账的商品号集合（与「已购库」页面同一份 state/booth-purchases.json）。 */
export function purchasedIdSetOf(deps) {
  const state = readStateJson(deps, PURCHASES_FILE);
  const ids = new Set();
  for (const key of Object.keys(state?.items && typeof state.items === 'object' ? state.items : {})) {
    const id = String(key ?? '').trim();
    if (/^\d{5,9}$/.test(id)) ids.add(id);
  }
  return ids;
}

/**
 * 免费台账：目前仓库里还没有「免费下载清单」的落盘文件，所以 free 恒为 0（文档 §2.1 允许）。
 * 一旦有 `state/booth-free.json`（`{items:{<boothId>:{}}}` 或 `{ids:[...]}`），这里自动接上，
 * 免得页面/筛选/facets 各写一套解析。
 */
export function freeIdSetOf(deps) {
  const state = readStateJson(deps, FREE_FILE);
  const ids = new Set();
  if (!state || typeof state !== 'object') return ids;
  const source = state.items && typeof state.items === 'object' ? Object.keys(state.items) : Array.isArray(state.ids) ? state.ids : [];
  for (const value of source) {
    const id = String(value ?? '').trim();
    if (/^\d{5,9}$/.test(id)) ids.add(id);
  }
  return ids;
}

/** 工程使用统计：{ key: { usageCount, lastUsedAt } }（使用统计文件不存在时全空）。 */
export function usageStatsOf(deps) {
  const state = readStateJson(deps, USAGE_FILE);
  const stats = new Map();
  const usage = state?.usage && typeof state.usage === 'object' ? state.usage : {};
  for (const [key, entry] of Object.entries(usage)) {
    const projects = Array.isArray(entry?.projects) ? entry.projects : [];
    let lastUsedAt = Number(entry?.lastScanAt) || 0;
    for (const project of projects) lastUsedAt = Math.max(lastUsedAt, Number(project?.at) || 0);
    stats.set(String(key), { usageCount: projects.length, lastUsedAt });
  }
  return stats;
}

function duplicatedIdSet(assets) {
  const seen = new Map();
  for (const asset of assets) {
    const id = String(asset?.boothId ?? '').trim();
    if (!/^\d{5,9}$/.test(id)) continue;
    seen.set(id, (seen.get(id) || 0) + 1);
  }
  const dup = new Set();
  for (const [id, count] of seen) if (count > 1) dup.add(id);
  return dup;
}

/**
 * 给最终视图的每张卡补字段（分类、适配模型、收藏、已购/免费、使用次数、重复号）。
 * 返回新对象、不改入参：缓存里的快照还被上一次请求引用着，原地改会串数据。
 */
export function annotateLibraryAssets(deps, data) {
  const favorites = favoriteTableOf(deps);
  const purchased = purchasedIdSetOf(deps);
  const free = freeIdSetOf(deps);
  const usage = usageStatsOf(deps);
  const assets = (Array.isArray(data?.assets) ? data.assets : []).map((asset) => {
    const key = String(asset?.key ?? '');
    const boothId = String(asset?.boothId ?? '').trim();
    const use = usage.get(key) || null;
    return applyCategoryToAsset({
      ...asset,
      favorite: Boolean(favorites.entries[key]),
      purchase: purchased.has(boothId) ? 'purchased' : free.has(boothId) ? 'free' : '',
      usageCount: use?.usageCount || 0,
      lastUsedAt: use?.lastUsedAt || 0
    });
  });
  const duplicated = duplicatedIdSet(assets);
  const annotated = assets.map((asset) => (
    duplicated.has(String(asset?.boothId ?? '').trim()) ? { ...asset, duplicated: true } : asset
  ));
  const inLibraryPurchased = annotated.filter((asset) => asset.purchase === 'purchased').length;
  const inLibraryFree = annotated.filter((asset) => asset.purchase === 'free').length;
  return {
    ...data,
    assets: annotated,
    annotationStats: {
      favorites: annotated.filter((asset) => asset.favorite).length,
      purchased: inLibraryPurchased,
      free: inLibraryFree,
      usageHits: annotated.filter((asset) => asset.usageCount > 0).length,
      duplicated: duplicated.size
    }
  };
}
