// src/library-purchase-detail.js — 「商品详情面板」的纯规则（零 I/O，可单测）。
//
// 面板要回答三个问题：这件我买过吗（已购台账）？我下过没（下载台账）？我库里有没有（素材视图）？
// 三份数据来源互不相通，所以这里只做「归一 + 合并 + 兜底」，读盘留给 src/bridge/console/library-purchase-detail.js。
//
// 为什么不在路由里直接拼：这些规则（models 三态、purchasedAt 兜底、搭配建议同店/同标签）
// 都是面板文案的依据，放进纯函数才能拿真数据回归；路由只负责取数。

import { normalizeCollections } from './library-collections.js';

export const PURCHASE_DETAIL_VERSION = 1;
export const PURCHASE_DETAIL_SUGGESTION_LIMIT = 3;
export const PURCHASE_DETAIL_FILES_MAX = 20;
export const PURCHASE_MODEL_BUCKETS = Object.freeze(['unlabeled', '1', '2-3', '4+']);

const BOOTH_ID_RE = /^\d{5,9}$/;
const MODEL_LABEL = Object.freeze({ unlabeled: '未标注', 1: '1 个', '2-3': '2~3 个', '4+': '4 个以上' });

/** BOOTH 号规整：只管数字与长度，别的判定（存不存在）交给台账。 */
export function normalizeBoothId(value) {
  const text = String(value ?? '').trim();
  return BOOTH_ID_RE.test(text) ? text : '';
}

function textOf(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function countOf(value) {
  const n = Math.trunc(Number(value) || 0);
  return n > 0 ? n : 0;
}

/**
 * 「支持几个模型」的原始数值。
 * 台账里 models.max 是商品页标的「N 模型对应」，models.labeled 是我们真识别出来的件数；
 * 有 labeled 用 labeled（更可信），否则退回 max；0/缺数据一律当没标注。
 */
export function modelCountOf(models) {
  const raw = models && typeof models === 'object' ? models : {};
  const labeled = countOf(raw.labeled);
  const max = countOf(raw.max);
  const total = countOf(raw.total);
  return { max, total, labeled, count: labeled > 0 ? labeled : max };
}

/** 粗粒度分桶（0 未标 / 1 / 2-3 / 4+）：文案由前端拼「（支持 N 模型）」，后端不再生成句子。 */
export function modelBucketOf(models) {
  const { count } = modelCountOf(models);
  const bucket = count <= 0 ? 'unlabeled' : count === 1 ? '1' : count <= 3 ? '2-3' : '4+';
  return { bucket, label: MODEL_LABEL[bucket], count };
}

/**
 * 购买时间：台账目前没有 purchasedAt（清单页只给「已购买」不给人购买日期），
 * 所以按 addedAt 兜底，并标出来源，前端可以显示「（记录于）」，等同步模块补了真日期再切回 purchasedAt。
 */
export function purchasedAtOf(item) {
  const purchase = item && typeof item === 'object' ? item : {};
  const purchasedAt = countOf(purchase.purchasedAt);
  if (purchasedAt > 0) return { purchasedAt, purchasedAtSource: 'purchasedAt' };
  const addedAt = countOf(purchase.addedAt);
  if (addedAt > 0) return { purchasedAt: addedAt, purchasedAtSource: 'addedAt' };
  const updatedAt = countOf(purchase.updatedAt);
  if (updatedAt > 0) return { purchasedAt: updatedAt, purchasedAtSource: 'updatedAt' };
  return { purchasedAt: 0, purchasedAtSource: 'none' };
}

/** 下载台账里这件的文件清单（只回展示字段；url 带签名不进响应）。 */
export function downloadedFilesOf(job) {
  if (!job || typeof job !== 'object') return [];
  const fileName = textOf(job.fileName || job.name, 300);
  if (!fileName) return [];
  return [{
    fileName,
    bytes: countOf(job.bytes),
    state: textOf(job.state, 20) || 'unknown',
    skipped: job.skipped === true,
    extracted: job.extract
      ? { state: textOf(job.extract.state, 20), files: countOf(job.extract.files), bytes: countOf(job.extract.bytes) }
      : null
  }].slice(0, PURCHASE_DETAIL_FILES_MAX);
}

/** 下载状态：只有 done 才算「已下载」，其余状态原样透出给前端显示进度/失败原因。 */
export function downloadStateOf(job) {
  const state = textOf(job?.state, 20);
  return {
    downloaded: state === 'done',
    downloadState: state,
    downloadedAt: countOf(job?.finishedAt),
    error: textOf(job?.error, 200)
  };
}

/**
 * 本地同号素材：只认 verified（已购台账/人工绑定）的号——猜出来的号指向别的商品，
 * 面板上让它「看起来像已入库」比不显示更糟（真机上 6985553 就是靠目录名瞎猜的）。
 */
export function localAssetsOf(assets, boothId) {
  const target = normalizeBoothId(boothId);
  if (!target) return [];
  const list = Array.isArray(assets) ? assets : [];
  return list
    .filter((asset) => asset && String(asset.boothId ?? '').trim() === target)
    .filter((asset) => asset.boothStatus === 'verified')
    .map((asset) => ({
      key: String(asset.key ?? ''),
      title: String(asset.displayTitle || asset.title || '').slice(0, 200),
      dir: String(asset.dir ?? ''),
      bytes: countOf(asset.bytes),
      hasCover: Boolean(asset.hasCover ?? (asset.thumbRel || asset.coverUrl)),
      extracted: Boolean(asset.extracted),
      mergedCount: countOf(asset.mergedCount)
    }));
}

/** 某个素材 key 集合参与了哪些素材集（面板「所属素材集」）。 */
export function collectionsContaining(table, keys) {
  const want = new Set((Array.isArray(keys) ? keys : []).map((key) => String(key ?? '').trim()).filter(Boolean));
  if (want.size === 0) return [];
  const items = Object.values(normalizeCollections(table).items);
  return items
    .filter((entry) => (entry.keys || []).some((key) => want.has(key)))
    .map((entry) => ({ id: entry.id, name: entry.name, count: (entry.keys || []).length }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * 搭配建议：同店铺或标签重叠的**已购**件 top N（只读台账，不抓网）。
 * 排序：同店优先 > 标签重叠多 > 更新时间新；自己排除。
 */
export function suggestionsFor(item, purchases, { limit = PURCHASE_DETAIL_SUGGESTION_LIMIT } = {}) {
  const self = normalizeBoothId(item?.boothId);
  const shop = textOf(item?.shopName, 120);
  const tags = new Set((Array.isArray(item?.tags) ? item.tags : []).map((tag) => textOf(tag, 60)).filter(Boolean));
  const rows = [];
  for (const other of Array.isArray(purchases) ? purchases : []) {
    const boothId = normalizeBoothId(other?.boothId);
    if (!boothId || boothId === self) continue;
    const sameShop = Boolean(shop) && textOf(other?.shopName, 120) === shop;
    const otherTags = (Array.isArray(other?.tags) ? other.tags : []).map((tag) => textOf(tag, 60)).filter(Boolean);
    const shared = otherTags.filter((tag) => tags.has(tag));
    if (!sameShop && shared.length === 0) continue;
    rows.push({
      boothId,
      title: textOf(other?.title, 200),
      shopName: textOf(other?.shopName, 120),
      priceText: textOf(other?.priceText, 60),
      itemUrl: textOf(other?.itemUrl, 500) || `https://booth.pm/ja/items/${boothId}`,
      coverUrl: textOf(other?.coverUrl, 1000),
      tags: otherTags.slice(0, 8),
      sameShop,
      sharedTags: shared.slice(0, 8),
      updatedAt: countOf(other?.updatedAt)
    });
  }
  rows.sort(
    (a, b) =>
      (b.sameShop ? 1 : 0) - (a.sameShop ? 1 : 0) ||
      b.sharedTags.length - a.sharedTags.length ||
      b.updatedAt - a.updatedAt ||
      a.boothId.localeCompare(b.boothId)
  );
  return rows.slice(0, Math.max(1, Math.min(10, countOf(limit) || PURCHASE_DETAIL_SUGGESTION_LIMIT)));
}

/**
 * 组装面板返回体。
 * @param {object} input
 * @param {object|null} input.purchase 台账条目（已归一）
 * @param {Array<object>} input.assets 最终素材视图卡片
 * @param {object|null} input.downloadJob 下载台账 job
 * @param {object} input.collectionsTable 素材集台账（state/library-collections.json）
 * @param {Array<object>} input.purchases 全量已购（搭配建议）
 * @param {string} input.coverUrl 封面地址（本地已落图优先，由路由决定）
 */
export function buildPurchaseDetail(input = {}) {
  const purchase = input.purchase && typeof input.purchase === 'object' ? input.purchase : {};
  const boothId = normalizeBoothId(purchase.boothId);
  const modelInfo = modelCountOf(purchase.models);
  const { bucket, label } = modelBucketOf(purchase.models);
  const purchased = purchasedAtOf(purchase);
  const download = downloadStateOf(input.downloadJob);
  const localAssets = localAssetsOf(input.assets, boothId);
  const downloadedFiles = downloadedFilesOf(input.downloadJob);
  const collections = collectionsContaining(input.collectionsTable, localAssets.map((asset) => asset.key));
  const suggestions = suggestionsFor(purchase, input.purchases, { limit: input.suggestionLimit });
  return {
    ok: true,
    item: {
      boothId,
      title: textOf(purchase.title, 300),
      shopName: textOf(purchase.shopName, 120),
      shopUrl: textOf(purchase.shopUrl, 500),
      priceText: textOf(purchase.priceText, 60),
      purchasedAt: purchased.purchasedAt,
      // 真日期同步模块还没落地：先标来源，前端据此显示「（记录于 10-28）」，别假装是购买时间。
      purchasedAtSource: purchased.purchasedAtSource,
      itemUrl: textOf(purchase.itemUrl, 500) || `https://booth.pm/ja/items/${boothId}`,
      coverUrl: textOf(input.coverUrl ?? purchase.coverUrl, 1000),
      tags: (Array.isArray(purchase.tags) ? purchase.tags : []).map((tag) => textOf(tag, 60)).filter(Boolean).slice(0, 30),
      categories: (Array.isArray(purchase.categories) ? purchase.categories : [])
        .map((cat) => textOf(cat, 60))
        .filter(Boolean)
        .slice(0, 8),
      models: { max: modelInfo.max, total: modelInfo.total, labeled: modelInfo.labeled },
      modelBucket: bucket,
      modelBucketLabel: label,
      modelCount: modelInfo.count,
      inLibrary: localAssets.length > 0,
      downloaded: download.downloaded,
      downloadState: download.downloadState,
      downloadedAt: download.downloadedAt,
      downloadError: download.error,
      downloadedFiles,
      localAssets
    },
    files: downloadedFiles,
    related: { collections, suggestions }
  };
}

/** 面板返回的一句话摘要（日志/接口自带说明用）。 */
export function describePurchaseDetail(detail) {
  const item = detail?.item || {};
  if (!item.boothId) return '没有这件已购记录';
  const parts = [item.title || `BOOTH ${item.boothId}`];
  if (item.inLibrary) parts.push(`本地 ${item.localAssets.length} 件`);
  if (item.downloaded) parts.push('已下载');
  else if (item.downloadState) parts.push(`下载 ${item.downloadState}`);
  if (item.modelCount > 0) parts.push(`${item.modelCount} 模型`);
  return parts.join('，');
}
