// 素材库识别规则表（别名表）纯函数：日文原名/作者圈写法（プラム、R-18、ノーマル）认不出，
// 让用户自己维护「显示名 = 别名|别名」。扫描、找号、页面展示都读同一张表，规则只在这里一份。
// 本文件零 fs / 零网络（可 import），读写盘由 console 层负责。
export const ALIAS_RULES_VERSION = 1;
// 一行最多 200 个字符：再长就是整段说明文案了，不是规则，存进来只会让编辑器难用。
export const ALIAS_LINE_MAX = 200;
// 一个显示名最多 20 个别名：再多说明用户想的是「关键词」而不是别名，应该拆成多行。
export const ALIAS_TERMS_MAX = 20;
// 整张表最多 500 条：这个量级足够覆盖常见的社团用语，也保证每次扫描全量匹配仍是毫秒级。
export const ALIAS_ENTRIES_MAX = 500;

/** 全角符号与全角空格归一：用户从聊天窗口复制过来的规则经常是 `＝`/`｜`。 */
function widenToHalf(text) {
  return String(text ?? '')
    .replace(/＝/g, '=')
    .replace(/｜/g, '|')
    .replace(/\u3000/g, ' ')
    .replace(/[“”]/g, '"');
}

/** 比较用的归一化键：NFKC 处理全角字母数字，小写后再比，避免「ＢＯＯＴＨ」和「booth」算两条。 */
function matchKey(text) {
  return widenToHalf(text).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function uniqueTerms(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const term = widenToHalf(raw).trim();
    if (!term) continue;
    const key = matchKey(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= ALIAS_TERMS_MAX) break;
  }
  return out;
}

/**
 * 解析一行 `显示名=别名|别名`（也认全角 `＝`/`｜`）。
 * 空行、`#` 注释、超长、缺显示名或缺别名都返回 null —— 调用方要把原文报给用户，别静默丢。
 */
export function parseAliasLine(line) {
  const text = widenToHalf(line).trim();
  if (!text || text.startsWith('#')) return null;
  if (Array.from(text).length > ALIAS_LINE_MAX) return null;
  const at = text.indexOf('=');
  if (at <= 0) return null;
  const display = text.slice(0, at).trim();
  if (!display) return null;
  const aliases = uniqueTerms(text.slice(at + 1).split('|'));
  if (!aliases.length) return null;
  return { display, aliases };
}

function entryFromRow(row) {
  if (typeof row === 'string') return parseAliasLine(row);
  if (!row || typeof row !== 'object') return null;
  const display = widenToHalf(row.display ?? row.name ?? '').trim();
  if (!display) return null;
  const rawAliases = Array.isArray(row.aliases)
    ? row.aliases
    : String(row.aliases ?? row.terms ?? '').split('|');
  const aliases = uniqueTerms(rawAliases);
  if (!aliases.length) return null;
  return { display, aliases };
}

/**
 * 归一化整张表：接受 `[{display,aliases}]`、`{rules:[...]}`、`{entries:[...]}`，元素也可以是
 * 一行字符串。同显示名（大小写/全半角不敏感）合并，别名并集去重，条数封顶。
 */
export function normalizeAliasTable(raw) {
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.rules)
      ? raw.rules
      : Array.isArray(raw?.entries)
        ? raw.entries
        : [];
  const entries = [];
  const index = new Map();
  for (const row of rows) {
    const entry = entryFromRow(row);
    if (!entry) continue;
    const key = matchKey(entry.display);
    if (!key) continue;
    const existed = index.get(key);
    if (existed) {
      existed.aliases = uniqueTerms(existed.aliases.concat(entry.aliases));
      continue;
    }
    const copy = { display: entry.display, aliases: entry.aliases.slice() };
    index.set(key, copy);
    entries.push(copy);
    if (entries.length >= ALIAS_ENTRIES_MAX) break;
  }
  return { version: ALIAS_RULES_VERSION, entries };
}

/** 找命中的条目：输入里包含显示名（含相等）就算命中，多个命中取显示名最长的那个。 */
function findAliasEntry(name, table) {
  const hay = matchKey(name);
  if (!hay) return null;
  const entries = Array.isArray(table?.entries) ? table.entries : [];
  let hit = null;
  let hitLen = 0;
  for (const entry of entries) {
    const needle = matchKey(entry?.display);
    if (!needle) continue;
    if (!hay.includes(needle)) continue;
    const len = Array.from(needle).length;
    if (len > hitLen) {
      hit = entry;
      hitLen = len;
    }
  }
  return hit;
}

/** 命中最长显示名时返回它的显示名，没命中返回 ''（页面要「有命中才显示别名」）。 */
export function resolveAlias(name, table) {
  const hit = findAliasEntry(name, table);
  return hit ? String(hit.display) : '';
}

/**
 * 搜索词扩展：原搜索词在前，再补显示名与别名（去重、最多 4 条）。
 * 找号时前两条命中率最高，所以扩充的部分总是排在原搜索词后面。
 */
export function expandSearchPhrases(title, table) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const text = widenToHalf(value).trim();
    const key = matchKey(text);
    if (!text || !key || seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };
  push(title);
  const hit = findAliasEntry(title, table);
  if (hit) {
    push(hit.display);
    for (const alias of hit.aliases) push(alias);
  }
  return out.slice(0, 4);
}

/** 给素材卡补别名信息：只加 `aliasTitle`/`aliasTerms`，不改 title 本体（用户看到的标题仍来自磁盘）。 */
export function applyAliasToAsset(asset, table) {
  if (!asset || typeof asset !== 'object') return asset;
  const hit = findAliasEntry(asset.title ?? asset.aliasSource ?? '', table);
  return {
    ...asset,
    aliasTitle: hit ? String(hit.display) : '',
    aliasTerms: hit ? hit.aliases.slice() : []
  };
}
