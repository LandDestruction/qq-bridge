// 素材收藏（星标）：纯规则 + 表归一化。
//
// 为什么单独一个纯模块：收藏只是「一个 contentKey 集合」，但 key 会因改名而变
// （改名会改主件名 → contentKeyFor 重算出新 key）。如果收藏表只认旧 key，
// 用户改名后星标就凭空消失；所以 key 迁移规则必须与绑定表在同一处、同一次执行里完成，
// 才有机会写测试证明「改名后收藏还在」。纯函数放这里，I/O 由调用方给。

export const FAVORITES_FILE = 'booth-favorites.json';
export const FAVORITES_VERSION = 1;
/** key 是 contentKey（主件名+字节数算出的短哈希），不该出现空白或超长值。 */
const KEY_MAX_CHARS = 200;

function cleanKey(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > KEY_MAX_CHARS) return '';
  if (/[\s\u0000-\u001f]/.test(text)) return '';
  return text;
}

function cleanTime(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : 0;
}

/**
 * 归一化收藏表：坏条目一律丢弃而不是修，读不懂的状态当成「没收藏」最安全。
 * 接受 `{entries}` / `{keys:[...]}` / 数组三种历史形状，便于老文件/手工改过的文件照读。
 */
export function normalizeFavorites(raw) {
  const table = { version: FAVORITES_VERSION, entries: {} };
  if (!raw || typeof raw !== 'object') return table;
  const source = Array.isArray(raw)
    ? raw
    : raw.entries && typeof raw.entries === 'object'
      ? raw.entries
      : Array.isArray(raw.keys)
        ? raw.keys
        : null;
  if (!source) return table;
  if (Array.isArray(source)) {
    for (const item of source) {
      const key = cleanKey(typeof item === 'string' ? item : item?.key);
      if (key) table.entries[key] = { at: cleanTime(item?.at) };
    }
    return table;
  }
  for (const [key, value] of Object.entries(source)) {
    const cleaned = cleanKey(key);
    if (!cleaned) continue;
    table.entries[cleaned] = { at: cleanTime(value?.at) };
  }
  return table;
}

/** 收藏的 key 集合（页面给卡片补 `favorite` 字段时用）。 */
export function favoriteKeySet(table) {
  const normalized = normalizeFavorites(table);
  return new Set(Object.keys(normalized.entries));
}

export function isFavoriteKey(table, key) {
  const cleaned = cleanKey(key);
  return Boolean(cleaned) && Boolean(normalizeFavorites(table).entries[cleaned]);
}

/**
 * 开/关收藏，返回新表（不改入参：调用方可能正拿着旧表算页面）。
 * `on=false` 时删条目；重复开收藏刷新时间，否则前端「最近收藏」排序会永远停在第一次。
 */
export function setFavorite(table, key, on, now = Date.now()) {
  const cleaned = cleanKey(key);
  if (!cleaned) throw new Error('缺少素材 key');
  const next = normalizeFavorites(table);
  if (on === false) {
    delete next.entries[cleaned];
  } else {
    next.entries[cleaned] = { at: Math.trunc(Number(now) || Date.now()) };
  }
  return next;
}

export function favoriteCount(table) {
  return Object.keys(normalizeFavorites(table).entries).length;
}

export function favoriteKeysOf(table) {
  const normalized = normalizeFavorites(table);
  return Object.entries(normalized.entries)
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .map(([key]) => key);
}

/**
 * 改名迁移：把收藏从旧 key 搬到新 key。
 * 旧 key 没收藏就不动（返回 moved:false）；新 key 已经有收藏时沿用新 key 原来的时间戳
 * （那是用户更早/更明确的动作，改名不该覆盖它）。
 */
export function migrateFavorite(table, fromKey, toKey) {
  const from = cleanKey(fromKey);
  const to = cleanKey(toKey);
  const next = normalizeFavorites(table);
  if (!from || !to || from === to) return { table: next, moved: false };
  const entry = next.entries[from];
  if (!entry) return { table: next, moved: false };
  delete next.entries[from];
  const existing = next.entries[to];
  next.entries[to] = { at: existing?.at || entry.at || 0 };
  return { table: next, moved: true };
}

// ── 状态文件读写（给 src 侧与 console 路由共用；deps 只需 fs/path/STATE_DIR/atomicWriteJson） ──
// 放在纯模块里而不是两个调用方各写一遍：收藏表格式一旦变，读取入口只有一个。
export function favoritesFilePath(deps) {
  return deps.path.join(String(deps.STATE_DIR), FAVORITES_FILE);
}

/** 读收藏表：文件缺失/坏 JSON 一律当空表（收藏丢了也不能让素材页 500）。 */
export function readFavoritesState(deps) {
  try {
    return normalizeFavorites(JSON.parse(deps.fs.readFileSync(favoritesFilePath(deps), 'utf8')));
  } catch {
    return normalizeFavorites(null);
  }
}

/** 原子写收藏表：用户手动点的状态，写到一半断电不能变成空表。 */
export function writeFavoritesState(deps, table) {
  deps.atomicWriteJson(favoritesFilePath(deps), normalizeFavorites(table));
}

