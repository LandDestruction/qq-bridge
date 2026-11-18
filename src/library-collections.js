/**
 * 素材集（套装）纯规则。
 *
 * 「素材集」是给人用的装配方案：一个名字 + 一串素材 key（可以想成「这套搭配用的衣服/发型/配件」）。
 * 只依赖传入的表和素材列表，不碰文件系统、不 import 任何东西，方便单测，也方便 VM 模块注入。
 *
 * 约定：
 * - 所有函数都返回**新表**，不修改入参（调用方拿旧表给前端或写备份时不会被悄悄改掉）。
 * - 坏数据一律当空处理，不抛异常；只有「调用方明确要做非法操作」才 throw 中文错误。
 * - id 形如 col_<时间戳>_<随机4>，由 createCollection 生成；合法 id 之外的条目在 normalize 时丢弃。
 */

export const COLLECTIONS_VERSION = 1;
export const COLLECTION_NAME_MAX = 40;
export const COLLECTION_NOTE_MAX = 200;
export const COLLECTION_KEYS_MAX = 200;

const COLLECTION_ID_RE = /^col_[0-9]{10,16}_[a-z0-9]{4}$/;

function textOf(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function numberOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

export function isCollectionId(value) {
  return typeof value === 'string' && COLLECTION_ID_RE.test(value);
}

/** 生成一个集合 id：col_<毫秒时间戳>_<4 位 36 进制随机>。 */
export function newCollectionId(now = Date.now(), random = Math.random) {
  const stamp = numberOf(now) || Date.now();
  let tail = '';
  for (let i = 0; i < 4; i += 1) {
    const n = Math.floor((typeof random === 'function' ? random() : 0) * 36);
    tail += n.toString(36);
  }
  return `col_${stamp}_${tail}`;
}

function cleanKeys(keys, limit = COLLECTION_KEYS_MAX) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(keys) ? keys : []) {
    const key = String(raw ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeEntry(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const realId = isCollectionId(id) ? id : isCollectionId(raw.id) ? raw.id : '';
  if (!realId) return null;
  const name = textOf(raw.name, COLLECTION_NAME_MAX);
  if (!name) return null;
  const entry = {
    id: realId,
    name,
    note: textOf(raw.note, COLLECTION_NOTE_MAX),
    coverKey: textOf(raw.coverKey, 400),
    keys: cleanKeys(raw.keys),
    createdAt: numberOf(raw.createdAt),
    updatedAt: numberOf(raw.updatedAt)
  };
  if (!entry.createdAt) entry.createdAt = entry.updatedAt || Date.now();
  if (!entry.updatedAt) entry.updatedAt = entry.createdAt;
  return entry;
}

/** 任意输入 → 合法表；坏数据当空，重复 id 后者覆盖前者。 */
export function normalizeCollections(raw) {
  const table = { version: COLLECTIONS_VERSION, items: {} };
  const source = raw && typeof raw === 'object' && raw.items && typeof raw.items === 'object' ? raw.items : null;
  if (!source) return table;
  for (const key of Object.keys(source)) {
    const entry = normalizeEntry(source[key], key);
    if (entry) table.items[entry.id] = entry;
  }
  return table;
}

function pickName(name) {
  const text = String(name ?? '').trim();
  if (!text) throw new Error('集合名不能为空');
  if ([...text].length > COLLECTION_NAME_MAX) throw new Error(`集合名最多 ${COLLECTION_NAME_MAX} 个字`);
  return text;
}

/**
 * 新建集合。name 必填；note/keys 可选。返回新表。
 * 同一张表里可以重名（不同人可能各建一个「冬日」），前端自己区分。
 */
export function createCollection(table, input = {}, now = Date.now()) {
  const next = normalizeCollections(table);
  const name = pickName(input.name);
  const stamp = numberOf(now) || Date.now();
  let id = newCollectionId(stamp);
  for (let i = 0; i < 20 && next.items[id]; i += 1) id = newCollectionId(stamp + i + 1);
  next.items[id] = {
    id,
    name,
    note: textOf(input.note, COLLECTION_NOTE_MAX),
    coverKey: textOf(input.coverKey, 400),
    keys: cleanKeys(input.keys),
    createdAt: stamp,
    updatedAt: stamp
  };
  return next;
}

function mustHave(table, id) {
  const realId = isCollectionId(id) ? id : '';
  if (!realId) throw new Error('集合 id 不合法');
  const entry = table.items[realId];
  if (!entry) throw new Error('集合不存在');
  return entry;
}

/** 改名字/备注/封面。patch 里没给的字段保持原值；返回新表。 */
export function updateCollection(table, id, patch = {}, now = Date.now()) {
  const next = normalizeCollections(table);
  const entry = mustHave(next, id);
  const updated = { ...entry, updatedAt: numberOf(now) || Date.now() };
  if (Object.prototype.hasOwnProperty.call(patch, 'name')) updated.name = pickName(patch.name);
  if (Object.prototype.hasOwnProperty.call(patch, 'note')) updated.note = textOf(patch.note, COLLECTION_NOTE_MAX);
  if (Object.prototype.hasOwnProperty.call(patch, 'coverKey')) updated.coverKey = textOf(patch.coverKey, 400);
  next.items[updated.id] = updated;
  return next;
}

/** 删集合；不存在时抛「集合不存在」，让 HTTP 层回 404。 */
export function removeCollection(table, id) {
  const next = normalizeCollections(table);
  const entry = mustHave(next, id);
  delete next.items[entry.id];
  return next;
}

/** 往集合里加素材 key（去重、上限 200）。 */
export function addKeys(table, id, keys, now = Date.now()) {
  const next = normalizeCollections(table);
  const entry = mustHave(next, id);
  const added = cleanKeys(keys, COLLECTION_KEYS_MAX);
  if (!added.length) return next;
  const merged = cleanKeys([...entry.keys, ...added]);
  if (merged.length === entry.keys.length) return next;
  next.items[entry.id] = { ...entry, keys: merged, updatedAt: numberOf(now) || Date.now() };
  return next;
}

/** 从集合里拿掉素材 key（不在里面的忽略）。 */
export function removeKeys(table, id, keys, now = Date.now()) {
  const next = normalizeCollections(table);
  const entry = mustHave(next, id);
  const drop = new Set(cleanKeys(keys, COLLECTION_KEYS_MAX));
  if (!drop.size) return next;
  const kept = entry.keys.filter((key) => !drop.has(key));
  if (kept.length === entry.keys.length) return next;
  next.items[entry.id] = { ...entry, keys: kept, updatedAt: numberOf(now) || Date.now() };
  return next;
}

function coverOfAsset(asset) {
  if (!asset) return '';
  return String(asset.coverUrl || asset.thumbUrl || '');
}

/**
 * 给前端列表用的装饰：每集补 count（成员数）、missingKeys（盘上已找不到的 key）、coverUrl。
 * coverUrl 规则：coverKey 指定的那件还在就用它的封面，否则退回第一件的封面。
 */
export function decorateCollections(table, assets = []) {
  const byKey = new Map();
  for (const asset of Array.isArray(assets) ? assets : []) {
    const key = String(asset?.key || '');
    if (key) byKey.set(key, asset);
  }
  const items = [];
  for (const entry of Object.values(normalizeCollections(table).items)) {
    const missingKeys = entry.keys.filter((key) => !byKey.has(key));
    const coverAsset = (entry.coverKey && byKey.get(entry.coverKey)) || byKey.get(entry.keys[0]) || null;
    items.push({ ...entry, count: entry.keys.length, missingKeys, coverUrl: coverOfAsset(coverAsset) });
  }
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.name).localeCompare(String(b.name)));
  return items;
}

/** 某个素材属于哪些集合（前端素材卡显示「属于 2 个集」）。 */
export function collectionsOfAsset(table, key) {
  const target = String(key ?? '').trim();
  if (!target) return [];
  const items = Object.values(normalizeCollections(table).items)
    .filter((entry) => entry.keys.includes(target))
    .map((entry) => ({ id: entry.id, name: entry.name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return items;
}
