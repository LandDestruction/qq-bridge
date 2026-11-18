// 从名字里抽「解压码 / RJ 号 / 类型标签 / BOOTH 商品号」。
//
// 为什么要有它：素材落到磁盘上时，人写的命名习惯里塞满了有用信息——
// `【SOPW】【RPG生肉】xxx [解压码: acg18] RJ0123456.zip` 这种名字，用户真正想知道的是
// 「要不要密码」「是游戏还是模型」「对应哪个商品」。这些都是**纯字符串规则**，
// 不下载、不解压、不联网就能回答，所以单独放一个零依赖模块，桥接那边只做接线。
//
// 设计原则：**宁可空，不要猜**。抽不到就返回空（空串 / 空数组），绝不用「看起来像」的
// 片段冒充密码或 RJ 号；认错的密码会让用户拿着错密码去解压，比没有更糟。
//
// 全角/CRLF 处理：先把全宽 ASCII（：［］ｐｗ１２３ 这类）压成半宽再匹配，
// 因为真实文件名里两种写法混着出现；`【】` 不是全宽 ASCII，正则字符类里显式列出。
//
// 输入统一截到 `TAGGING_MAX_INPUT` 个字符再解析：素材名不该很长，
// 截断既防超长输入拖慢规则，也保证「超长时不会从后半段抽出莫名其妙的东西」。

/** 标签数量上限：卡片上最多展示 8 个，多了会挤爆行，也没人看。 */
export const TAGGING_MAX_TAGS = 8;
/** 单个输入文本参与解析的最大字符数（超出部分不解析）。 */
export const TAGGING_MAX_INPUT = 200;
/** 解压码最大长度：再长基本不是密码（多半是误匹配到一段描述）。 */
export const TAGGING_MAX_PASSWORD = 64;

/** 解压码的「键名」变体：中文全称/简称、日文、英文缩写。 */
const PASSWORD_LABELS = [
  '解压密码', '解压码', '解压碼', '解压', '解凍パスワード', 'パスワード', 'パス',
  'zip密码', '压缩密码', '密码', 'passwort', 'password', 'pass', 'pwd', 'pw'
].join('|');

/**
 * 带括号形态额外接受裸 `码`（`[码: xyz]`）：单独成词时它只可能是解压码键名，
 * 但无括号的「页码: 3」就会误伤，所以只在括号里放行。
 */
const PASSWORD_LABELS_BRACKET = `${PASSWORD_LABELS}|码|コード`;

/** `[解压码: xxx]` / `【パスワード：xxx】` 这类带括号的形态（括号里允许空格）。 */
const PASSWORD_BRACKET = new RegExp(
  `[\\[【［]\\s*(?:${PASSWORD_LABELS_BRACKET})\\s*[:：]\\s*([^\\]】］]{1,${TAGGING_MAX_PASSWORD}}?)\\s*[\\]】］]`,
  'i'
);

/** 无括号的 `解压密码：xxx` 形态：值取到空白/常见分隔符为止。 */
const PASSWORD_PLAIN = new RegExp(
  `(?:${PASSWORD_LABELS})\\s*[:：]\\s*([^\\s,，、;；:：\\]】］)）]{1,${TAGGING_MAX_PASSWORD}})`,
  'i'
);

/** 日文句子形态：`パスワードは xxx です`。 */
const PASSWORD_SENTENCE = /パスワードは\s*([^\s、。,:：]{1,64}?)\s*(?:です|でした|となっております)/i;

/** 这些值等于「没有密码」：库里很多人写 `[解压码: None]` / `パスワード: なし`。 */
const NO_PASSWORD_VALUES = new Set([
  'none', 'null', 'nil', 'n/a', 'na', 'no', 'なし', 'ない', '無し', '無', '无', '無い',
  '空', '空密码', '无密码', '没有', '不要', '不需要', '0'
]);

/** 全宽 ASCII → 半宽（只处理 U+FF01..U+FF5E，另外顺手把全宽空格压成半宽）。 */
function toHalfWidth(text) {
  return String(text ?? '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/** 解析入口的前置清洗：去 CRLF、压连续空白、截断。 */
function prepare(text) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n');
  return toHalfWidth(raw).slice(0, TAGGING_MAX_INPUT);
}

/** 去掉首尾空白和包裹的引号/括号残留。 */
function trimValue(value) {
  return String(value ?? '')
    .trim()
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '')
    .trim();
}

/** 占位值判定（None/なし/无 …… 视为没有密码）。 */
function isPlaceholder(value) {
  return NO_PASSWORD_VALUES.has(trimValue(value).toLowerCase());
}

/** 在一条规则下逐个找：万一第一个括号里写的是 `None`，后面还有一条真密码，也能捞到。 */
function findPasswordMatch(text, pattern) {
  if (!text) return null;
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const match of text.matchAll(global)) {
    const value = trimValue(match[1]);
    if (!value || isPlaceholder(value)) continue;
    if (value.length > TAGGING_MAX_PASSWORD) continue;
    return { password: value, matched: trimValue(match[0]) };
  }
  return null;
}

/**
 * 从名字里抽解压码。
 *
 * 返回：命中时 `{ password, matched }`（`matched` 是命中的原文片段，便于前端高亮）；
 * 认不出时返回空串 `''`——**不要猜**，调用方用 `||` 兜底即可。
 */
export function parseArchivePassword(text) {
  const source = prepare(text);
  if (!source) return '';
  for (const pattern of [PASSWORD_BRACKET, PASSWORD_PLAIN, PASSWORD_SENTENCE]) {
    const found = findPasswordMatch(source, pattern);
    if (found) return found;
  }
  return '';
}

/** RJ 号：`RJ0123456` / `rj 0123456` / `RJ-0123456` → 统一返回大写无分隔的 `RJ0123456`。 */
export function parseRjCode(text) {
  const source = prepare(text);
  if (!source) return '';
  const match = source.match(/RJ[\s._-]*(\d{5,10})(?!\d)/i);
  return match ? `RJ${match[1]}` : '';
}

/** 名字里出现的 BOOTH 商品链接编号（`booth.pm/items/<号>`，含子域名与语言前缀），去重保序。 */
export function parseBoothSellerItemIds(text) {
  const source = prepare(text);
  if (!source) return [];
  const ids = [];
  const pattern = /(?:https?:\/\/)?(?:[\w-]+\.)*booth\.pm\/(?:[a-z-]{2,5}\/)?items\/(\d{1,12})(?!\d)/gi;
  for (const match of source.matchAll(pattern)) {
    const id = match[1];
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 方括号/【】里的短标签是否该丢：RJ 号、纯数字、解压码键值、过长/空。 */
function isDroppedTag(tag) {
  if (!tag) return true;
  if ([...tag].length > 12) return true;
  if (/^RJ[\s._-]*\d{5,10}$/i.test(tag)) return true;
  if (/^RJ$/i.test(tag)) return true; // 裸 RJ 只是分类标记，不值得占一个标签位
  if (/^\d{1,6}$/.test(tag)) return true;
  if (/^[\s\-—–_·.]+$/.test(tag)) return true;
  if (/[:：]/.test(tag)) return true; // `解压码: xxx` 这种已经由密码解析处理
  if (new RegExp(`^(?:${PASSWORD_LABELS})$`, 'i').test(tag)) return true;
  return false;
}

/** `【SOPW】【RPG生肉】` → `['SOPW', 'RPG生肉']`；最多 8 个、去重、丢无用项。 */
export function parseNameTags(text) {
  const source = prepare(text);
  if (!source) return [];
  const tags = [];
  const pattern = /[\[【［]([^\]】］\[【［]{1,40}?)[\]】］]/g;
  for (const match of source.matchAll(pattern)) {
    const tag = trimValue(match[1]).replace(/\s+/g, ' ');
    if (isDroppedTag(tag)) continue;
    const key = tag.toLowerCase();
    if (tags.some((existing) => existing.toLowerCase() === key)) continue;
    tags.push(tag);
    if (tags.length >= TAGGING_MAX_TAGS) break;
  }
  return tags;
}

/**
 * 把一件素材的三处文本（标题 / 目录 / 主文件名）合成一组展示用标签。
 *
 * 优先顺序：`title` → `mainName` → `dir`（同一个码/密码只取第一个命中的）。
 * 返回 `{ archivePassword, rjCode, tags, sellerItemIds }`，抽不到的字段是空串/空数组。
 */
export function describeAssetTags({ title = '', dir = '', mainName = '' } = {}) {
  const texts = [title, mainName, dir]
    .map((value) => String(value ?? '').slice(0, TAGGING_MAX_INPUT))
    .filter((value) => value.trim() !== '');

  let archivePassword = '';
  let rjCode = '';
  const tags = [];
  const sellerItemIds = [];

  for (const text of texts) {
    if (!archivePassword) {
      const parsed = parseArchivePassword(text);
      if (parsed) archivePassword = parsed.password;
    }
    if (!rjCode) rjCode = parseRjCode(text);
    for (const tag of parseNameTags(text)) {
      if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) continue;
      if (tags.length < TAGGING_MAX_TAGS) tags.push(tag);
    }
    for (const id of parseBoothSellerItemIds(text)) {
      if (!sellerItemIds.includes(id) && sellerItemIds.length < TAGGING_MAX_TAGS) sellerItemIds.push(id);
    }
  }

  return { archivePassword, rjCode, tags, sellerItemIds };
}
