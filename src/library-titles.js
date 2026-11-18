// 手动改名：把「一件素材（contentKey）」显示的名字换成人写的标题。
//
// 为什么要有它：自动标题来自目录名/压缩包名（`Endless Comfort (Ver1_0_2 Win)` 这种），
// 人在文件库里认素材时想看到「魔法使服装 2026-10」这种自己起的名；而改目录名会动到
// 素材本体（还可能破坏 thumbRel / scene 文件的相对路径），所以另存一张「改名表」，
// 扫描之后覆盖到卡片上，跟绑定表（booth-binds.json）是同一套思路。
//
// 存 `state/booth-titles.json`。纯函数放这里，桥接那边只做读写盘与路由。

export const TITLES_VERSION = 1;
/** 标题长度上限：卡片上两行就要截断，超过 120 个字符的标题在界面上已经没法看了。 */
export const TITLE_MAX_CHARS = 120;

/** 统一清洗标题：去换行/连续空白、去首尾空格、截断到上限。 */
function cleanTitle(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.slice(0, TITLE_MAX_CHARS);
}

/** contentKey 合法性：和绑定表一样是「首个压缩包名小写+大小」之类的稳定串，不允许控制字符。 */
function cleanKey(value) {
  const key = String(value ?? '').trim();
  if (!key) return '';
  if (key.length > 200) return '';
  if (/[\u0000-\u001f\u007f]/.test(key)) return '';
  return key;
}

/** 规范化整张表：坏键/坏标题直接丢，版本号补齐；返回新对象，不改入参。 */
export function normalizeTitleTable(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const from = src.entries && typeof src.entries === 'object' && !Array.isArray(src.entries) ? src.entries : {};
  const entries = {};
  for (const [rawKey, value] of Object.entries(from)) {
    const contentKey = cleanKey(rawKey);
    if (!contentKey) continue;
    const title = cleanTitle(value?.title);
    if (!title) continue;
    entries[contentKey] = {
      title,
      at: Number.isFinite(Number(value?.at)) ? Number(value.at) : 0
    };
  }
  return { version: TITLES_VERSION, entries };
}

/** 取一件素材的手动标题；没改过返回空串（调用方据此决定用自动名）。 */
export function titleOf(table, contentKey) {
  const entries = normalizeTitleTable(table).entries;
  const entry = entries[cleanKey(contentKey)];
  return entry ? entry.title : '';
}

/**
 * 写一条手动标题（同一 contentKey 覆盖旧值）。返回新表，不改入参。
 * key 空 / 标题空直接抛错：这是写接口的入参，静默丢弃会让前端以为改成功了。
 * 超长不抛错而是截断——路由层会先拒掉超长（400），这里只是防内部调用漏了校验。
 */
export function setTitle(table, contentKey, title, { now = Date.now() } = {}) {
  const base = normalizeTitleTable(table);
  const key = cleanKey(contentKey);
  if (!key) throw new Error('contentKey 不能为空');
  const next = cleanTitle(title);
  if (!next) throw new Error('标题不能为空');
  base.entries[key] = { title: next, at: Number(now) || Date.now() };
  return base;
}

/** 删掉一条手动标题（恢复自动名）。返回新表。 */
export function removeTitle(table, contentKey) {
  const base = normalizeTitleTable(table);
  const key = cleanKey(contentKey);
  if (key) delete base.entries[key];
  return base;
}

export function titleCount(table) {
  return Object.keys(normalizeTitleTable(table).entries).length;
}

/** 给前端看的摘要（详情弹层里显示「改了 N 件名字」）。 */
export function titleTableSummary(table) {
  const t = normalizeTitleTable(table);
  const entries = Object.values(t.entries);
  return {
    version: t.version,
    count: entries.length,
    lastAt: entries.reduce((max, entry) => Math.max(max, Number(entry.at) || 0), 0)
  };
}

/**
 * 把改名表覆盖到素材卡上。
 * - 命中：`title` 换成手写标题，`manualTitle: true`，自动名留在 `autoTitle`（前端可显示「原名」）；
 * - 没命中：原样返回。
 * 返回新数组，不改入参（与 applyBinds 同一约定）。
 * 注意幂等：已经带 manualTitle 的卡再套一次，autoTitle 保留第一次记下的自动名，不会变成手动名。
 */
export function applyTitles(cards, table) {
  const list = Array.isArray(cards) ? cards : [];
  const entries = normalizeTitleTable(table).entries;
  return list.map((card) => {
    const entry = entries[cleanKey(card?.key)];
    if (!entry) return card;
    return {
      ...card,
      title: entry.title,
      manualTitle: true,
      autoTitle: card?.manualTitle ? String(card?.autoTitle ?? '') : String(card?.title ?? '')
    };
  });
}
