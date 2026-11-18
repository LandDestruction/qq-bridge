// src/bridge/console/library-tag-views.js — 素材卡的「可识别信息」：解压码 / RJ 号 / 类型标签 / 来源。
//
// 为什么单独一个文件：library-view.js 已经贴着 800 行规模闸，而这套东西是纯函数（读名字、推来源、
// 刷字段），拆出来既不增加路由复杂度，也让假的 deps 能单独测。识别规则本体在 src/library-tagging.js
// （由 retire-console 并行开发），这里只负责「调规则、落字段、算统计、归一化筛选值」。
//
// 为什么用动态 import + try/catch：两个模块并行落地，规则模块还没交时素材页必须照常能用
// （字段给空值）。交了这个文件不用改、重启即生效；测试用 deps.libraryTagging 注入假规则。

let importedDescribeTags = null;
try {
  const taggingModule = await import('../../library-tagging.js');
  importedDescribeTags = typeof taggingModule?.describeAssetTags === 'function'
    ? taggingModule.describeAssetTags
    : null;
} catch {
  // 规则模块还没落地：保持 null，字段给空值（比整页 500 好）。
  importedDescribeTags = null;
}

const ASSET_TAGS_MAX = 8;
const SOURCE_LABELS = { baidu: '网盘', transfer: '转存', unfiled: '未分类', unknown: '未知' };

// dir 的一级目录名 → 来源。顺序有意义：「转存_百度网盘」这种名字两条都沾边时，
// 按更具体的网盘算（用户找「网盘」时想的是那一批，不是所有转存）。
const SOURCE_RULES = [
  { source: 'baidu', pattern: /baidunetdisk|百度网盘/i },
  { source: 'transfer', pattern: /转存|archive/i },
  { source: 'unfiled', pattern: /_未分类/ }
];

/** 只看 dir 的第一段（群目录下面是来源目录，再往下才是素材）。认不出就 unknown，不猜。 */
export function assetSourceOf(dir) {
  const top = String(dir ?? '').split('/').map((seg) => seg.trim()).find(Boolean) ?? '';
  for (const rule of SOURCE_RULES) {
    if (rule.pattern.test(top)) return { source: rule.source, sourceText: SOURCE_LABELS[rule.source] };
  }
  return { source: 'unknown', sourceText: SOURCE_LABELS.unknown };
}

function describeTagsOf(deps, asset) {
  // deps.libraryTagging 优先：测试注入假规则用；真实运行走模块默认导出。
  const describe = typeof deps?.libraryTagging?.describeAssetTags === 'function'
    ? deps.libraryTagging.describeAssetTags
    : importedDescribeTags;
  if (typeof describe !== 'function') return null;
  try {
    return describe({
      title: String(asset?.title ?? ''),
      dir: String(asset?.dir ?? ''),
      mainName: String(asset?.mainName ?? asset?.file ?? '')
    }) || null;
  } catch {
    return null;
  }
}

function applyTagsToAsset(deps, asset) {
  const info = describeTagsOf(deps, asset) ?? {};
  const source = assetSourceOf(asset?.dir);
  return {
    ...asset,
    archivePassword: String(info.archivePassword ?? ''),
    rjCode: String(info.rjCode ?? ''),
    tags: Array.isArray(info.tags)
      ? info.tags.map((tag) => String(tag ?? '')).filter(Boolean).slice(0, ASSET_TAGS_MAX)
      : [],
    sellerItemIds: Array.isArray(info.sellerItemIds) ? info.sellerItemIds.map(String).filter(Boolean) : [],
    source: source.source,
    sourceText: source.sourceText
  };
}

/** 把标签/来源刷到整份快照上（在合并、改名、别名之后调用：合并卡用主成员的名字定标签）。 */
export function applyAssetTags(deps, data) {
  const assets = (Array.isArray(data?.assets) ? data.assets : []).map((asset) => applyTagsToAsset(deps, asset));
  return { ...data, assets, tagStats: countAssetTagStats(assets) };
}

/** 三个统计：有任意识别信息的件数 / 有解压码 / 有 RJ 号。都基于全库快照，不是本页。 */
export function countAssetTagStats(assets) {
  const list = Array.isArray(assets) ? assets : [];
  return {
    withTags: list.filter((asset) => asset?.archivePassword || asset?.rjCode || (Array.isArray(asset?.tags) && asset.tags.length > 0)).length,
    passwords: list.filter((asset) => asset?.archivePassword).length,
    rjCount: list.filter((asset) => asset?.rjCode).length
  };
}

/** filter 归一化：认识的固定档、合法的 source:<值> 原样保留；其余一律回落 all。
 *  实现已搬到 src/library-assets-query.js（筛选/分页同源），这里 re-export 保持旧入口。 */
export { normalizeAssetFilter } from '../../library-assets-query.js';
