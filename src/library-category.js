// 素材分类与「适配模型数量」的纯规则。
//
// 为什么要有它：素材库左侧分类树/顶部筛选全靠「这件是饰品还是服装」「适配几个模型」，
// 而这两件事在真实文件名和 BOOTH 资料里并不规范——有人写「衣装」、有人写「Outfit」、
// 有人只把分类留在 meta.category 里（而且还带前缀，如「3D衣装」）。所以规则集中在一个
// 零依赖模块里：页面、对账、CLI 都调同一套判定，避免「左栏写服装 2 件、点进去只有 1 件」。
//
// 设计原则与 library-tagging 一致：**宁可归「未分类」，不要硬猜**。猜错分类比空着更糟——
// 用户按分类找不到东西时不会怀疑规则，只会以为文件丢了。
// 但「宁可空」不等于「明明有证据也当没看见」：meta.category=「3D衣装」、tags 里有「エフェクト」
// 都是证据，只是格式不标准，所以先做包含匹配、再扫一遍标签/主件名。

/** 固定分类表（顺序即左栏展示顺序，最后一项是兜底）。 */
export const LIBRARY_CATEGORIES = Object.freeze([
  '饰品', '服装', '发型', '模型', '贴图', '地图', '特效', '工具', '音声', '其它', '未分类'
]);

/** 兜底分类名：规则和 meta 都没命中时用它。 */
export const LIBRARY_UNCLASSIFIED = '未分类';

/** meta.category 的各种写法 → 规范名（BOOTH 分类是日文，人自己填的常是中文）。
 *  这里只负责「整段相等」的情形；「3D衣装」这种带前缀的交给下面 CATEGORY_RULES 包含匹配。 */
const CATEGORY_ALIASES = new Map([
  ['アクセサリー', '饰品'], ['accessory', '饰品'], ['accessories', '饰品'], ['配饰', '饰品'],
  ['jewelry', '饰品'], ['ピアス', '饰品'],
  ['服', '服装'], ['衣装', '服装'], ['コスチューム', '服装'], ['costume', '服装'],
  ['clothes', '服装'], ['clothing', '服装'], ['outfit', '服装'], ['dress', '服装'],
  ['髪', '发型'], ['ヘア', '发型'], ['hair', '发型'],
  ['モデル', '模型'], ['model', '模型'], ['models', '模型'], ['3dmodel', '模型'],
  ['アバター', '模型'], ['avatar', '模型'], ['avatars', '模型'], ['フィギュア', '模型'],
  ['テクスチャ', '贴图'], ['texture', '贴图'], ['textures', '贴图'], ['マテリアル', '贴图'],
  ['material', '贴图'],
  ['ワールド', '地图'], ['world', '地图'], ['worlds', '地图'], ['map', '地图'],
  ['エフェクト', '特效'], ['effect', '特效'], ['effects', '特效'], ['シェーダー', '特效'],
  ['shader', '特效'], ['particle', '特效'],
  ['ツール', '工具'], ['tool', '工具'], ['tools', '工具'], ['unitypackage', '工具'],
  ['ボイス', '音声'], ['voice', '音声'], ['voices', '音声'], ['音声', '音声'],
  ['bgm', '音声'], ['se', '音声'],
  ['その他', '其它'], ['other', '其它'], ['others', '其它'], ['misc', '其它']
]);

/** 名字/标签关键词 → 分类。按数组顺序先命中先算。
 *  词表以前端 `client/10-library-pro.js:7-17` 为基准（分类顺序必须一致，否则同一件东西两边结论不同），
 *  再补几个明显同义的日/英/中词（Costume、unitypackage、发饰…）——后端只可能比前端「多认」，
 *  不会把前端认出的东西吞回未分类；真机实测这一步把「未分类 13」压到 6 件。
 *  真实数据里 `meta.tags` 常常比标题信息量大（标题只有 BOOTH 号时尤其如此）。 */
const CATEGORY_RULES = [
  ['饰品', /アクセサリ|アクセ|饰品|accessor|jewelry|earring|necklace|bracelet|pierce|ピアス|耳环|项链|戒指/i],
  ['服装', /衣装|コスチューム|服装|outfit|cloth|costume|dress|skirt|hoodie|毛衣|裙|外套|制服/i],
  ['发型', /髪型|ヘア|发型|hair|假发|wig/i],
  ['模型', /モデル|model|アバター|avatar|フィギュア|模型|人物|角色/i],
  ['贴图', /テクスチャ|texture|マテリアル|material|材质|贴图/i],
  ['地图', /ワールド|world|map|地图/i],
  ['特效', /エフェクト|effect|シェーダ|shader|粒子|particle/i],
  ['工具', /ツール|tool|スクリプト|script|unitypackage|工具|插件/i],
  ['音声', /ボイス|voice|音声|サウンド|sound|bgm|语音|音频/i]
];

/** 适配模型数量：meta.models 优先，其次从标题/主件名/标签里读「N アバター / N avatars / N 人対応 / N 人」。
 *  分隔符允许空格/下划线/连字符：真实文件名常写 `pack_8_models.zip` 这种；
 *  `人対応` 是日文商品标题的常见写法（前端同一条正则，别只认「アバター」）。 */
const MODEL_COUNT_RE = /(\d{1,3})[\s_\-]*(?:アバター|avatars?|models?|人対応|人|体|キャラ)/i;

/** 适配模型桶（左栏「适配模型」下拉与 facets 共用）。 */
export const MODEL_BUCKETS = Object.freeze([
  { value: 'unlabeled', label: '未标注' },
  { value: '1', label: '1' },
  { value: '2-3', label: '2~3' },
  { value: '4-7', label: '4~7' },
  { value: '8+', label: '8+' }
]);

const MODEL_BUCKET_VALUES = new Set(MODEL_BUCKETS.map((item) => item.value));

function metaOf(asset) {
  const meta = asset?.meta;
  return meta && typeof meta === 'object' ? meta : null;
}

/** 拿一段文本按词表判类（不含「未分类」兜底，没命中返回 ''）。 */
function ruleCategory(text) {
  const hay = String(text ?? '');
  if (!hay) return '';
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(hay)) return category;
  }
  return '';
}

function canonicalCategory(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  // 「未分类」是兜底名，不是证据：写进 meta 里也不该挡着标签/主件名继续判。
  if (text === LIBRARY_UNCLASSIFIED) return '';
  if (LIBRARY_CATEGORIES.includes(text)) return text;
  // 全角/大小写差异走 alias 表；BOOTH 分类常带后缀（`衣装・小物`），取第一段再试。
  const key = text.toLowerCase();
  if (CATEGORY_ALIASES.has(key)) return CATEGORY_ALIASES.get(key);
  const head = text.split(/[・/／|,，、]/)[0].trim();
  if (head && head !== text) {
    if (LIBRARY_CATEGORIES.includes(head)) return head === LIBRARY_UNCLASSIFIED ? '' : head;
    const headKey = head.toLowerCase();
    if (CATEGORY_ALIASES.has(headKey)) return CATEGORY_ALIASES.get(headKey);
  }
  return '';
}

/**
 * 判定素材分类。
 * @returns {{category: string, from: 'meta'|'rule'|'none'}} from 说明这个结论可信到什么程度，
 *   方便页面/调试区分「BOOTH 明确写了」和「名字里碰巧带了个词」。
 *
 * 判定顺序（真机踩过坑，顺序有讲究）：
 *  1. meta.category 整段相等/规范名 → from:'meta'；
 *  2. meta.category 带前缀（「3D衣装」「3Dモデル」）→ 用词表做包含匹配 → from:'meta'；
 *  3. 标题 + 别名 + 主件名 + 自带标签 + meta 标签 → from:'rule'；
 *  4. 都没有 → 未分类。
 * 为什么要把 meta.tags 也算进去：真机有一半素材标题只有 BOOTH 号（「9014210」），
 * 分类证据全在 meta.tags 里；只扫标题的话这些永远进「未分类」，左栏数字就没意义了。
 */
export function categoryOf(asset) {
  const meta = metaOf(asset);
  const metaCategory = String(meta?.category ?? '').trim();
  const fromMeta = canonicalCategory(metaCategory);
  if (fromMeta) return { category: fromMeta, from: 'meta' };
  if (metaCategory) {
    const fuzzy = ruleCategory(metaCategory);
    if (fuzzy) return { category: fuzzy, from: 'meta' };
  }
  const tags = Array.isArray(asset?.tags) ? asset.tags : [];
  const metaTags = Array.isArray(meta?.tags) ? meta.tags : [];
  // 与前端 `libProLocalCategory` 同一份 hay：标题、别名、主件名、两种标签、meta.category。
  // 故意**不**含 dir——目录名是「群/网盘/转存」这类来源信息，混进来只会把东西判成地图。
  const haystack = [
    String(asset?.title ?? ''),
    String(asset?.aliasTitle ?? ''),
    String(asset?.mainName ?? ''),
    tags.join(' '),
    metaTags.join(' '),
    metaCategory
  ].join(' ');
  const hit = ruleCategory(haystack);
  if (hit) return { category: hit, from: 'rule' };
  return { category: LIBRARY_UNCLASSIFIED, from: 'none' };
}

/** 适配模型数量：拿不到就 null（未知和 0 是两件事，前端「未标注」只该收 null）。 */
export function modelCountOf(asset) {
  const meta = metaOf(asset);
  const raw = meta?.models;
  if (Array.isArray(raw)) {
    const count = raw.length;
    // 空数组等于「没写」，继续退回名字里找；别把「没标注」当成 0。
    if (count > 0) return count;
  } else {
    const num = Number(raw);
    if (raw != null && raw !== '' && Number.isFinite(num) && num > 0) return Math.trunc(num);
  }
  const tags = Array.isArray(asset?.tags) ? asset.tags : [];
  const text = [
    String(asset?.title ?? ''),
    String(asset?.mainName ?? ''),
    tags.join(' ')
  ].join(' ');
  const hit = MODEL_COUNT_RE.exec(text);
  if (!hit) return null;
  const parsed = Number(hit[1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

/** 数量 → 桶（`unlabeled` / `1` / `2-3` / `4-7` / `8+`）。 */
export function modelBucketOf(n) {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return 'unlabeled';
  const num = Math.trunc(Number(n));
  if (num <= 0) return 'unlabeled';
  if (num === 1) return '1';
  if (num <= 3) return '2-3';
  if (num <= 7) return '4-7';
  return '8+';
}

/** 参数里的 model 桶是否合法（不合法的值由调用方回落「全部」）。 */
export function isModelBucket(value) {
  return MODEL_BUCKET_VALUES.has(String(value ?? '').trim());
}

/** 分类参数归一化：`unclassified` 与「未分类」都指向兜底分类。 */
export function categoryFilterOf(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text === 'unclassified' || text === LIBRARY_UNCLASSIFIED) return LIBRARY_UNCLASSIFIED;
  return canonicalCategory(text) || text;
}

/** 给卡片补分类字段（页面/筛选/对账共用同一个结论）。 */
export function applyCategoryToAsset(asset) {
  const { category, from } = categoryOf(asset);
  const count = modelCountOf(asset);
  return { ...asset, category, categoryFrom: from, modelCount: count, modelBucket: modelBucketOf(count) };
}
