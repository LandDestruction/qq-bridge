// 素材卡片的筛选 / 排序 / 分页（服务端口径）。
//
// 为什么从 library-view.js 拆出来：那个文件贴着 800 行规模闸，而这块是纯函数
// （只吃卡片数组和查询参数），拆出来能单测、能被 Pro 界面与其它模块共用，
// 也让「筛选口径」只有一份——页面统计、facets 计数、列表筛选必须同源，
// 否则会出现「无封面 7 件」筛出 8 件这种自相矛盾（真机上抓到过）。

import { categoryFilterOf, modelBucketOf, isModelBucket, LIBRARY_UNCLASSIFIED } from './library-category.js';

const ASSETS_MAX_LIMIT = 500;
// 默认仍是 500：第 2 批把 120 抬上来过（120 会让页面「共 N 件」只显示一部分，等于悄悄骗人）。
// 无参调用保持原样才算向后兼容；以后想改默认值只改这一处。
const ASSETS_DEFAULT_LIMIT = 500;
export const ASSETS_SORTS = Object.freeze(['recent', 'title', 'booth', 'bytes', 'use', 'lastUsed']);

const ASSET_FILTERS = ['all', 'no-booth', 'no-cover', 'suggested', 'bound', 'with-password', 'rj', 'unclassified', 'duplicated', 'extracted'];
const SOURCE_FILTER_VALUES = ['baidu', 'transfer', 'unfiled'];

/** 固定筛选档 + `source:<来源>`；非法值一律回落 all（读接口不因参数错报错）。 */
export function normalizeAssetFilter(value) {
  const text = String(value ?? '').trim();
  if (ASSET_FILTERS.includes(text)) return text;
  if (text.startsWith('source:')) {
    const source = text.slice('source:'.length).trim();
    if (SOURCE_FILTER_VALUES.includes(source)) return `source:${source}`;
  }
  return 'all';
}

export function hasBoothNumber(asset) {
  return /^\d{5,9}$/.test(String(asset?.boothId ?? ''));
}

// 与 enrichAssetsWithBoothMeta 里的 data.withCover 必须是同一个判据（缩略图或 BOOTH 缓存图），
// 否则「无封面」筛选条数和页面统计对不上。
export function hasCoverImage(asset) {
  return Boolean(asset?.thumbRel) || Boolean(asset?.coverUrl);
}

/** 「仅图片」：主件本身是图片（文档 §2.2 的口径），目录里的预览图不算。 */
export function isImageAsset(asset) {
  return /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(String(asset?.mainName ?? ''));
}

export function compareAssetTitle(a, b) {
  const ta = String(a?.title ?? '').trim() || String(a?.dir ?? '');
  const tb = String(b?.title ?? '').trim() || String(b?.dir ?? '');
  return ta.localeCompare(tb, 'zh-Hans-CN') || String(a?.key ?? '').localeCompare(String(b?.key ?? ''));
}

/**
 * 全库五档计数：筛选胶囊上的数字必须是全库的，不是本页的（否则「全部 7」会写成 24 件的库）。
 * 五档允许重叠（一件素材可以既没号、又没封面、又带批量建议），所以它们之和通常大于 all，
 * 前端不要拿它们相加当总数。Pro 界面的 quality 下拉直接读这里。
 */
export function countAssetBuckets(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const counts = {
    all: list.length, noBooth: 0, noCover: 0, suggested: 0, bound: 0,
    withPassword: 0, rj: 0, duplicated: 0, unclassified: 0
  };
  for (const asset of list) {
    if (!hasBoothNumber(asset)) counts.noBooth += 1;
    if (!hasCoverImage(asset)) counts.noCover += 1;
    if (asset?.suggestion) counts.suggested += 1;
    if (asset?.boothSource === 'bind') counts.bound += 1;
    if (asset?.archivePassword) counts.withPassword += 1;
    if (asset?.rjCode) counts.rj += 1;
    if (asset?.duplicated) counts.duplicated += 1;
    if (asset?.category === LIBRARY_UNCLASSIFIED) counts.unclassified += 1;
  }
  return counts;
}

/**
 * 读分页数字参数：没传 / 空白 / 非数字（含 NaN）一律当 null → 调用方用默认值。
 * 注意 Number(null) 和 Number('') 都是 0，直接 Number() 会把「没传 limit」当成 0。
 */
export function readPageNumber(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

/** q 的搜索面：标题/目录/号/解压码/RJ/标签（店铺也算，Pro 界面搜索框要能搜店名）。 */
export function assetSearchHaystack(asset) {
  // 搜索面用 tagsAll（解析标签 ∪ 手动标签）：用户刚手动打的标签必须立刻能搜到。
  const tags = Array.isArray(asset?.tagsAll)
    ? asset.tagsAll.join(' ')
    : (Array.isArray(asset?.tags) ? asset.tags.join(' ') : '');
  return [
    String(asset?.title ?? ''),
    String(asset?.aliasTitle ?? ''),
    String(asset?.dir ?? ''),
    String(asset?.boothId ?? ''),
    String(asset?.archivePassword ?? ''),
    String(asset?.rjCode ?? ''),
    String(asset?.meta?.shop ?? ''),
    tags
  ].join('\n').toLowerCase();
}

function matchesQuery(asset, q) {
  return !q || assetSearchHaystack(asset).includes(q);
}

/**
 * filter=duplicated 必须和 `counts.duplicated` 同源：后者是「属于重复组的卡片数」（由 groupDuplicates 分组），
 * 不是「卡片上打了个 duplicated 标记」——同一组 3 张卡两个数都要是 3，否则左栏说 3、点进去 2 张。
 * 所以路由层把分组结果的 key 集合传进来；没有传时退回旧标记，保证老调用方不炸。
 */
function matchesFilter(asset, filter, ctx = {}) {
  if (filter === 'no-booth') return !hasBoothNumber(asset);
  if (filter === 'no-cover') return !hasCoverImage(asset);
  if (filter === 'suggested') return Boolean(asset?.suggestion);
  if (filter === 'bound') return asset?.boothSource === 'bind';
  if (filter === 'with-password') return Boolean(asset?.archivePassword);
  if (filter === 'rj') return Boolean(asset?.rjCode);
  if (filter === 'unclassified') return asset?.category === LIBRARY_UNCLASSIFIED;
  if (filter === 'duplicated') {
    const keys = ctx.duplicatedKeys;
    if (keys instanceof Set) return keys.has(String(asset?.key ?? ''));
    return Boolean(asset?.duplicated);
  }
  // 解压产物默认隐藏，父件才带 extracted 汇总；这里只留「有解压产物」的父件。
  if (filter === 'extracted') return Boolean(asset?.extracted && Number(asset.extracted.count) > 0);
  if (filter.startsWith('source:')) return asset?.source === filter.slice('source:'.length);
  return true;
}

function matchesCategory(asset, category) {
  if (!category) return true;
  return String(asset?.category ?? '') === category;
}

function matchesShop(asset, shop) {
  if (!shop) return true;
  return String(asset?.meta?.shop ?? '').trim() === shop;
}

function matchesTag(asset, tag) {
  if (!tag) return true;
  const source = Array.isArray(asset?.tagsAll)
    ? asset.tagsAll
    : (Array.isArray(asset?.tags) ? asset.tags : []);
  const tags = source.map((item) => String(item).toLowerCase());
  return tags.includes(tag.toLowerCase());
}

/**
 * 从全量卡片里选出这一页。参数一律宽容解析（坏值回默认、不抛错）：这是读接口，
 * 前端拼错一个参数就 500 等于让人整页什么都看不见。
 * 返回 { assets, total, offset, limit, truncated, q, filter, sort, category, shop, tag, model, kind, fav, purchase }：
 * total 是**筛选后**的总数，不是全库数；筛选参数要原样回显（归一化后），
 * 前端拿它确认「后端真的按这个条件筛了」，否则会退回本地过滤把胶囊数字算成本页计数。
 */
export function pickAssetsPage(assets, params = {}) {
  const list = Array.isArray(assets) ? assets : [];
  const qRaw = String(params.q ?? '').trim();
  const q = qRaw.toLowerCase();
  const filter = normalizeAssetFilter(params.filter);
  // 分类参数先按**原样精确**匹配：手动分类允许自定义名（衣装/贴图…），
  // 别名表一上来就把「衣装」折成「服装」，用户点自己建的分类会空页、还会混进标准分类。
  // 只有原样值在库里一件都不存在时，才退回别名规范化（这样手输「衣装=服装」的老用法也不坏）。
  const categoryRaw = String(params.category ?? '').trim();
  let categoryEcho = categoryRaw === 'unclassified' ? LIBRARY_UNCLASSIFIED : categoryRaw;
  if (categoryEcho && !list.some((asset) => String(asset?.category ?? '') === categoryEcho)) {
    const canonical = categoryFilterOf(categoryEcho);
    if (canonical && canonical !== categoryEcho) categoryEcho = canonical;
  }
  const shop = String(params.shop ?? '').trim();
  const tag = String(params.tag ?? '').trim();
  const wantModel = String(params.model ?? '').trim();
  const model = isModelBucket(wantModel) ? wantModel : '';
  const kind = ['image', 'archive', 'unity'].includes(String(params.kind ?? '').trim())
    ? String(params.kind).trim()
    : '';
  const fav = String(params.fav ?? '').trim() === '1';
  const purchase = ['purchased', 'free'].includes(String(params.purchase ?? '').trim())
    ? String(params.purchase).trim()
    : '';
  const wantSort = String(params.sort ?? '').trim();
  const sort = ASSETS_SORTS.includes(wantSort) ? wantSort : 'recent';
  const matched = list.filter((asset) => {
    if (!matchesQuery(asset, q)) return false;
    if (!matchesFilter(asset, filter, { duplicatedKeys: params.duplicatedKeys })) return false;
    if (!matchesCategory(asset, categoryEcho)) return false;
    if (!matchesShop(asset, shop)) return false;
    if (!matchesTag(asset, tag)) return false;
    if (model && (asset?.modelBucket ?? modelBucketOf(asset?.modelCount)) !== model) return false;
    if (kind === 'image' && !isImageAsset(asset)) return false;
    if ((kind === 'archive' || kind === 'unity') && String(asset?.kind ?? '') !== kind) return false;
    if (fav && asset?.favorite !== true) return false;
    if (purchase && asset?.purchase !== purchase) return false;
    return true;
  });
  const sorted = sort === 'recent' ? matched : matched.slice().sort((a, b) => {
    if (sort === 'booth') {
      const byBooth = Number(hasBoothNumber(b)) - Number(hasBoothNumber(a));
      if (byBooth) return byBooth;
      return compareAssetTitle(a, b);
    }
    if (sort === 'bytes') {
      const diff = (Number(b?.bytes) || 0) - (Number(a?.bytes) || 0);
      return diff || compareAssetTitle(a, b);
    }
    if (sort === 'use') {
      const diff = (Number(b?.usageCount) || 0) - (Number(a?.usageCount) || 0);
      return diff || compareAssetTitle(a, b);
    }
    if (sort === 'lastUsed') {
      const diff = (Number(b?.lastUsedAt) || 0) - (Number(a?.lastUsedAt) || 0);
      return diff || compareAssetTitle(a, b);
    }
    return compareAssetTitle(a, b);
  });
  // 分页参数两个坑（验收时踩到）：offset=1.9 以前原样 floor 没问题，但 limit=0.5 会被 floor 成 0
  // → 返回空页，看起来像接口坏了。所以 offset 只保证 ≥0，limit 至少给 1 条（上限 500）。
  const rawOffset = readPageNumber(params.offset);
  const offset = rawOffset == null ? 0 : Math.max(0, Math.floor(rawOffset));
  const rawLimit = readPageNumber(params.limit);
  const limit = rawLimit == null
    ? ASSETS_DEFAULT_LIMIT
    : Math.min(ASSETS_MAX_LIMIT, Math.max(1, Math.floor(rawLimit)));
  const page = sorted.slice(offset, offset + limit);
  return {
    assets: page,
    total: sorted.length,
    offset,
    limit,
    truncated: offset + page.length < sorted.length,
    q: qRaw,
    filter,
    sort,
    category: categoryEcho,
    shop,
    tag,
    model,
    kind,
    fav,
    purchase
  };
}

// ── v2 视图（文档 §1）：view 与 filter/q/sort/offset/limit 正交 ────────────────
// view 先筛（「我要看没有封面的」），再套现有过滤（「其中搜 hair」）。cloud / trash 的
// 数据源不是扫盘结果，由路由层单独出卡（同构对象），这里只声明名字、负责素材类视图。
export const ASSET_VIEWS = Object.freeze([
  'all', 'with-booth', 'no-booth', 'with-cover', 'no-cover', 'suggested', 'favorite', 'cloud', 'trash', 'extracted'
]);

/** 非法/缺省一律回落 all：读接口不因参数错报错。 */
export function normalizeAssetView(value) {
  const text = String(value ?? '').trim();
  return ASSET_VIEWS.includes(text) ? text : 'all';
}

/** 素材类视图筛选（cloud / trash 不是素材数组，原样返回，由调用方走远程卡片分页）。 */
export function applyAssetView(assets, view) {
  const list = Array.isArray(assets) ? assets : [];
  // 「已认号」视图只认 verified（台账/人工绑定过）——扫盘名字里猜出来的号不算，
  // 否则用户点「已认号」会看到一堆抓错封面的条目。没有认号层的旧调用退回 hasBoothNumber。
  const hasVerifiedBooth = (asset) => (asset?.boothStatus ? asset.boothStatus === 'verified' : hasBoothNumber(asset));
  switch (normalizeAssetView(view)) {
    case 'with-booth': return list.filter(hasVerifiedBooth);
    case 'no-booth': return list.filter((asset) => !hasVerifiedBooth(asset));
    // 判据与 hasCoverImage 一致：thumbRel（本地/补进来的封面）或 coverUrl（台账远程图）。
    case 'with-cover': return list.filter((asset) => hasCoverImage(asset));
    case 'no-cover': return list.filter((asset) => !hasCoverImage(asset));
    // 「待确认认号」与 counts.suggested 必须同一谓词：candidate 且有候选建议；
    // 没有认号层的旧调用退回批量建议字段（asset.suggestion），避免老数据整块消失。
    case 'suggested': return list.filter((asset) => (
      asset?.boothStatus === 'candidate'
        ? Array.isArray(asset.bindSuggestions) && asset.bindSuggestions.length > 0
        : (asset?.boothStatus == null ? Boolean(asset?.suggestion) : false)
    ));
    case 'favorite': return list.filter((asset) => Boolean(asset?.favorite));
    // extracted 的数据源是「被隐藏的解压产物」，由路由层先换数组，这里原样返回即可。
    default: return list.slice();
  }
}

// ── 解压产物识别（视图层解决，不改扫盘）────────────────────────────────────
// 用户点「解压」后，扫盘会把 `5197537/6985553/` 这个解压目录也扫成一件素材：
// 于是素材库从 32 变 33 件，还会拿目录名当商品号进「候选号」，很脏。
// 这里只在视图层认「父子关系」：子目录名 = 父件主包名去扩展名，且父件就在同层目录里，
// 判为解压产物、默认隐藏（`view=extracted` 可以显式看）。不动磁盘、不动 key。
const EXTRACT_ARCHIVE_RE = /\.(?:zip|7z|rar|tar\.gz|tgz|tar\.bz2|tar\.xz|tar|gz|bz2|xz|zst)$/i;

function normalizeRelDir(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * 父件「可能的主包名」（去扩展名后的小写基名），用来跟解压子目录名对。
 *
 * 正常情况用主件（`6985553.zip` → `6985553`）；但原包被移走/备份走后，父卡的主件会留空，
 * 只剩一张缩略图（`6985553.thumbnail.png`）。这时退一步用封面文件名兜底，
 * 否则同层的 `6985553/` 解压目录就永远认不出「已解压」（verifier 真机 P2②）。
 */
function parentStemCandidates(parent) {
  const out = [];
  const main = String(parent?.mainName ?? '');
  const archiveMatch = EXTRACT_ARCHIVE_RE.exec(main);
  if (archiveMatch) out.push(main.slice(0, archiveMatch.index));
  const thumb = String(parent?.thumbRel ?? '').replace(/\\/g, '/').split('/').pop() || '';
  if (thumb) {
    const noExt = thumb.replace(/\.[a-z0-9]{1,6}$/i, '');
    const cleaned = noExt.replace(/(^|[._-])(thumbnail|thumb|cover|预览|封面)$/i, '');
    if (cleaned) out.push(cleaned);
  }
  const seen = new Set();
  return out
    .map((name) => name.trim().toLowerCase())
    .filter((name) => {
      if (!name || seen.has(name)) return false;
      seen.add(name);
      return true;
    });
}

/**
 * 把「解压出来的目录」从素材列表里摘出来。
 * @param {Array<object>} assets 最终视图的卡片（已有 dir/mainName/key 字段）
 * @returns {{assets:Array<object>, extracted:Array<object>}}
 *   assets：可见卡片（父件补 `extracted:{dirRel,dirs,files,bytes,count}`）；
 *   extracted：被隐藏的解压产物（带 `extractedFrom`=父件 key，便于前端「打开来源包」）。
 */
export function markExtractedDirs(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const byDir = new Map();
  for (const asset of list) {
    const dir = normalizeRelDir(asset?.dir);
    if (dir && !byDir.has(dir)) byDir.set(dir, asset);
  }
  const extracted = [];
  const visible = [];
  const stats = new Map(); // 父件 key → {dirs:Set, files, bytes, count}
  for (const asset of list) {
    const dir = normalizeRelDir(asset?.dir);
    const slash = dir.lastIndexOf('/');
    const parentDir = slash > 0 ? dir.slice(0, slash) : '';
    const stem = slash >= 0 ? dir.slice(slash + 1) : dir;
    const parent = parentDir ? byDir.get(parentDir) : null;
    // 父件主包名（压缩包名或兜底的封面名）必须跟子目录名完全对上（如 6985553.zip ↔ 目录 6985553）。
    const isExtract = Boolean(parent) && Boolean(stem) && parent !== asset
      && parentStemCandidates(parent).includes(stem.toLowerCase());
    if (!isExtract) { visible.push(asset); continue; }
    const child = { ...asset, extractedFrom: parent.key };
    extracted.push(child);
    const slot = stats.get(parent.key) || { dirs: [], files: 0, bytes: 0, count: 0 };
    if (!slot.dirs.includes(dir)) slot.dirs.push(dir);
    slot.files += Number(asset?.files) || 0;
    slot.bytes += Number(asset?.bytes) || 0;
    slot.count += 1;
    stats.set(parent.key, slot);
  }
  const annotated = visible.map((asset) => {
    const slot = stats.get(asset.key);
    if (!slot) return asset;
    return {
      ...asset,
      // 父件补「已解压」摘要：前端可以在卡片上显示「已解压 · N 个文件」而不是装作没这回事。
      extracted: { dirRel: slot.dirs[0] || '', dirs: slot.dirs, files: slot.files, bytes: slot.bytes, count: slot.count }
    };
  });
  return { assets: annotated, extracted };
}
