// 素材库左栏 / 顶部胶囊的计数（GET /api/library/facets）。
//
// 为什么要有它：Pro 界面的左栏每一行都要带「多少件」，顶栏分类胶囊也要带数字。
// 如果前端自己从当前页 assets 里数，筛过一次之后数字就变成「本页条数」，
// 用户会以为库里东西变少了。所以计数必须由服务端用**同一份最终视图**算一次。
//
// 口径：category/shop/source/tag/modelCount 都按「当前 q 命中的子集」算（文档 §2.1）；
// quality 复用 assets 的 counts 口径（noCover/noBooth/withPassword/rj/duplicated/unclassified），
// 只列出 >0 的档——0 件的筛选项点进去是空页，不如不显示。

import { LIBRARY_CATEGORIES, LIBRARY_UNCLASSIFIED, MODEL_BUCKETS } from './library-category.js';
import { hasBoothNumber, hasCoverImage } from './library-assets-query.js';

export const FACETS_RULES_VERSION = 'v1';

const SOURCE_LABELS = Object.freeze({ baidu: '百度网盘', transfer: '群转存', unfiled: '未分类目录', unknown: '未知' });
const SOURCE_ORDER = ['transfer', 'baidu', 'unfiled', 'unknown'];
const QUALITY_LABELS = Object.freeze({
  noCover: '无封面', noBooth: '未认号', withPassword: '有解压码', rj: '有 RJ', duplicated: '重复素材',
  extracted: '含解压产物', unclassified: '未分类'
});

function bump(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function toFacetList(map, order = null, labelOf = null) {
  const values = order ? order.filter((value) => map.has(value)) : [...map.keys()];
  // 自定义顺序之外的键（比如别人写进 meta 的新店铺/新标签）补在后面，别丢。
  for (const value of map.keys()) if (!values.includes(value)) values.push(value);
  return values.map((value) => ({
    value,
    label: labelOf ? labelOf(value) : value,
    count: map.get(value) || 0
  }));
}

/**
 * @param {object[]} assets 最终视图里的卡片（已补 category/modelBucket/favorite/purchase 字段）
 * @returns {{total:number, facets:object, categoryRules:string}}
 */
export function buildLibraryFacets(assets, { purchased = 0, free = 0, duplicatedKeys = null } = {}) {
  const list = Array.isArray(assets) ? assets : [];
  const categoryCounts = new Map();
  const shopCounts = new Map();
  const sourceCounts = new Map();
  const tagCounts = new Map();
  const modelCounts = new Map();
  let withPassword = 0;
  let rj = 0;
  let duplicated = 0;
  for (const asset of list) {
    bump(categoryCounts, asset?.category || LIBRARY_UNCLASSIFIED);
    bump(shopCounts, String(asset?.meta?.shop ?? '').trim());
    bump(sourceCounts, String(asset?.source ?? '').trim());
    // 标签计数含手动标签（tagsAll = 解析标签 ∪ 手动标签），否则用户加完标签左栏还是不显示。
    const tags = Array.isArray(asset?.tagsAll) ? asset.tagsAll : (Array.isArray(asset?.tags) ? asset.tags : []);
    for (const tag of tags) bump(tagCounts, String(tag ?? '').trim());
    bump(modelCounts, asset?.modelBucket || 'unlabeled');
    if (asset?.archivePassword) withPassword += 1;
    if (asset?.rjCode) rj += 1;
    if (asset?.duplicated) duplicated += 1;
  }
  // 哪些分类名来自手动分类：左栏要给这类打「手动」后缀，不能靠当前页卡片推断
  // （换页就漏、筛过之后更不准），所以由服务端一次算清，同时保留原 category 字段形状。
  const manualCategories = new Set();
  for (const asset of list) {
    if (asset?.categoryFrom === 'manual' && asset?.category) manualCategories.add(asset.category);
  }
  const category = toFacetList(categoryCounts, LIBRARY_CATEGORIES).map((item) => ({
    ...item,
    fromManual: manualCategories.has(item.value)
  }));
  const modelCount = toFacetList(
    modelCounts,
    MODEL_BUCKETS.map((item) => item.value),
    (value) => MODEL_BUCKETS.find((item) => item.value === value)?.label || value
  );
  const source = toFacetList(sourceCounts, SOURCE_ORDER, (value) => SOURCE_LABELS[value] || value);
  const quality = [];
  const pushQuality = (value, count) => {
    if (count > 0) quality.push({ value, label: QUALITY_LABELS[value], count });
  };
  pushQuality('noCover', list.filter((asset) => !hasCoverImage(asset)).length);
  pushQuality('noBooth', list.filter((asset) => !hasBoothNumber(asset)).length);
  pushQuality('withPassword', withPassword);
  pushQuality('rj', rj);
  // 重复材料按「属于重复组的卡片数」算，和 counts.duplicated / filter=duplicated 的 total 同一份分组结果；
  // 老调用方没传 key 集合时退回卡片上的 duplicated 标记（口径会窄，但不至于没有数字）。
  pushQuality(
    'duplicated',
    duplicatedKeys instanceof Set
      ? list.filter((asset) => duplicatedKeys.has(String(asset?.key ?? ''))).length
      : duplicated
  );
  // 含解压产物的父件数：和 counts.extracted 同一个判据（父件上有 extracted.count）。
  pushQuality('extracted', list.filter((asset) => Boolean(asset?.extracted && Number(asset.extracted.count) > 0)).length);
  pushQuality('unclassified', list.filter((asset) => asset?.category === LIBRARY_UNCLASSIFIED).length);
  return {
    total: list.length,
    facets: {
      category,
      // 没 meta 的素材归「未填店铺」，不进 facets（左栏没有这一行）；这里已经用 trim 过滤空值。
      shop: toFacetList(shopCounts).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-Hans-CN')),
      source,
      tag: toFacetList(tagCounts).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-Hans-CN')),
      modelCount,
      quality,
      purchased: Number(purchased) || 0,
      free: Number(free) || 0
    },
    categoryRules: FACETS_RULES_VERSION
  };
}
