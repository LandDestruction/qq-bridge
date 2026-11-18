// 手动标签 / 手动分类：让用户能纠正「解析没认出来」的素材。
//
// 为什么单独一张台账：分类和标签现在都是**推断**（BOOTH meta 或文件名关键词），
// 用户看一眼就知道「这其实是衣装」，但我们不能把用户的话写回磁盘名——
// 改名不可逆、还会换 contentKey，而且用户纠正的往往只是"分类"，不是"素材叫什么"。
// 所以按 contentKey 存一张 state/library-manual-meta.json，视图层再叠加：
// 台账没了最多丢手动信息，不会伤到素材本身；改名时按 key 迁移（和绑定/收藏同一套）。
//
// 优先级（用户意图排第一）：手动分类 > meta 分类 > 文件名规则 > 未分类；
// 标签是并集：解析出来的 tags 保留，另给 tagsAll 供搜索/筛选/计数用。

import { LIBRARY_UNCLASSIFIED } from './library-category.js';

export const MANUAL_META_VERSION = 1;
export const MANUAL_META_FILE = 'library-manual-meta.json';
export const MANUAL_TAGS_MAX = 12;
export const MANUAL_TAG_MAX_CHARS = 20;
export const MANUAL_CATEGORY_MAX_CHARS = 20;
export const MANUAL_NOTE_MAX_CHARS = 200;

const KEY_MAX_CHARS = 200;

function cleanText(value, maxChars) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const chars = Array.from(text);
  return chars.length > maxChars ? chars.slice(0, maxChars).join('').trim() : text;
}

/**
 * contentKey 是视图层的唯一标识（通常是一段 hex，测试里也可能是 `g/c/name`）。
 * 非法 key 直接丢：不能让它拼出路径、也不能让 `..` 之类的串混进台账。
 */
export function manualKeyOk(value) {
  const key = String(value ?? '').trim();
  if (!key || Array.from(key).length > KEY_MAX_CHARS) return false;
  if (/[\u0000-\u001f\u007f\s]/.test(key)) return false;
  if (key.includes('..')) return false;
  return true;
}

/** 标签：数组或「逗号/顿号/分号/换行」分隔的字符串 → 去空白、去重（大小写不敏感）、≤12 个、每个 ≤20 字。 */
export function sanitizeManualTags(input) {
  let raw;
  if (Array.isArray(input)) raw = input;
  else if (typeof input === 'string') raw = input.split(/[,，、;；\n]+/);
  else raw = [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const text = cleanText(item, MANUAL_TAG_MAX_CHARS);
    if (!text) continue;
    const dedupe = text.toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(text);
    if (out.length >= MANUAL_TAGS_MAX) break;
  }
  return out;
}

/** 分类允许自定义（如「衣装」「发型」「贴图」），但必须短；空串表示"回退规则"。 */
export function sanitizeManualCategory(value) {
  return cleanText(value, MANUAL_CATEGORY_MAX_CHARS);
}

export function sanitizeManualNote(value) {
  return cleanText(value, MANUAL_NOTE_MAX_CHARS);
}

/**
 * 单条台账：三个字段都可缺；一条什么都没有的条目视为"不存在"（返回 null），
 * 免得台账里堆满空对象，也免得「清空分类」被误当成"手动分类为空"。
 */
export function normalizeManualEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const tags = sanitizeManualTags(raw.tags);
  const category = sanitizeManualCategory(raw.category);
  const note = sanitizeManualNote(raw.note);
  if (!tags.length && !category && !note) return null;
  const at = Number(raw.updatedAt);
  return { tags, category, note, updatedAt: Number.isFinite(at) && at > 0 ? Math.trunc(at) : 0 };
}

export function normalizeManualMeta(raw) {
  const table = { version: MANUAL_META_VERSION, items: {} };
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const items = source.items && typeof source.items === 'object' && !Array.isArray(source.items)
    ? source.items
    : (source.entries && typeof source.entries === 'object' && !Array.isArray(source.entries) ? source.entries : {});
  for (const [rawKey, rawEntry] of Object.entries(items)) {
    if (!manualKeyOk(rawKey)) continue;
    const entry = normalizeManualEntry(rawEntry);
    if (!entry) continue;
    table.items[rawKey] = entry;
  }
  return table;
}

export function manualEntryOf(table, key) {
  const base = normalizeManualMeta(table);
  const clean = String(key ?? '').trim();
  return clean && base.items[clean] ? base.items[clean] : null;
}

/**
 * 写一条（不改入参，便于和缓存/快照安全共存）。
 * patch 里没给的字段保持原值；`clear` 不是这里的事——清空走 clearManualMeta。
 * tags 传空数组表示"清掉手动标签"，所以用 hasOwn 判断"有没有给这个字段"。
 */
export function setManualMeta(table, key, patch = {}, { now = Date.now() } = {}) {
  const base = normalizeManualMeta(table);
  const clean = String(key ?? '').trim();
  if (!manualKeyOk(clean)) throw new Error('素材 key 不合法');
  const prev = base.items[clean] || { tags: [], category: '', note: '', updatedAt: 0 };
  const next = normalizeManualEntry({
    tags: Object.prototype.hasOwnProperty.call(patch, 'tags') ? patch.tags : prev.tags,
    category: Object.prototype.hasOwnProperty.call(patch, 'category') ? patch.category : prev.category,
    note: Object.prototype.hasOwnProperty.call(patch, 'note') ? patch.note : prev.note,
    updatedAt: now
  });
  if (next) base.items[clean] = next;
  else delete base.items[clean];
  return base;
}

export function clearManualMeta(table, key) {
  const base = normalizeManualMeta(table);
  const clean = String(key ?? '').trim();
  if (clean) delete base.items[clean];
  return base;
}

export function manualMetaCount(table) {
  return Object.keys(normalizeManualMeta(table).items).length;
}

/**
 * 台账口径统计：GET /api/library/manual-meta 不带 key 时直接回它，
 * assets 响应里的 counts.manual / counts.manualTagged 也从这一份算。
 * 为什么按**条目**数（而不是按卡片数）：磁盘被手删后台账可能留下对不上的条目，
 * 一边按台账、一边按卡片就会「左栏说手动 1、列表里一条都没有」。只留一个口径才不会互相打架。
 */
export function manualMetaStatsOf(table) {
  const items = normalizeManualMeta(table).items;
  let tagged = 0;
  let categorized = 0;
  let noted = 0;
  for (const entry of Object.values(items)) {
    if (entry.tags.length) tagged += 1;
    if (entry.category) categorized += 1;
    if (entry.note) noted += 1;
  }
  return { entries: Object.keys(items).length, tagged, categorized, noted };
}

/**
 * 改名会把 contentKey 换掉：手动标签/分类必须跟着搬家，否则用户刚纠正完又被重置。
 * 两边都有条目时保留 updatedAt 更新的那份（用户的最后一次操作最接近事实）。
 * 返回 {table, moved}，不修改入参。
 */
export function moveManualMeta(table, fromKey, toKey) {
  const base = normalizeManualMeta(table);
  const from = String(fromKey ?? '').trim();
  const to = String(toKey ?? '').trim();
  if (!from || !to || from === to || !base.items[from]) return { table: base, moved: false };
  const entry = base.items[from];
  delete base.items[from];
  const existing = base.items[to];
  if (!existing || (Number(entry.updatedAt) || 0) >= (Number(existing.updatedAt) || 0)) base.items[to] = entry;
  return { table: base, moved: true };
}

/**
 * 叠加到素材卡（不改入参）：手动分类压过规则分类，标签取并集。
 * 始终给 manualTags / manualCategory / manualNote 三个字段，前端不必判 undefined。
 */
export function applyManualMeta(asset, entry) {
  const source = asset && typeof asset === 'object' ? asset : {};
  const manualTags = Array.isArray(entry?.tags) ? entry.tags.slice() : [];
  const manualCategory = String(entry?.category ?? '');
  const manualNote = String(entry?.note ?? '');
  const parsedTags = Array.isArray(source.tags) ? source.tags.map((tag) => String(tag ?? '')).filter(Boolean) : [];
  const tagsAll = [];
  const seen = new Set();
  for (const tag of parsedTags.concat(manualTags)) {
    const dedupe = tag.toLowerCase();
    if (!tag || seen.has(dedupe)) continue;
    seen.add(dedupe);
    tagsAll.push(tag);
  }
  // 手动分类为空 → 保持原分类（规则/meta 的结果）；再没有就是未分类。
  const category = manualCategory || String(source.category ?? '') || LIBRARY_UNCLASSIFIED;
  return {
    ...source,
    manualTags,
    manualCategory,
    manualNote,
    category,
    categoryFrom: manualCategory ? 'manual' : String(source.categoryFrom ?? ''),
    tags: parsedTags,
    tagsAll
  };
}

// ── 台账读写（deps 注入 fs/path/atomicWriteJson，和收藏表同一套） ──────────────

export function manualMetaFilePath(deps) {
  const stateDir = String(deps?.STATE_DIR ?? '').trim();
  if (!stateDir) return '';
  return deps.path.join(stateDir, MANUAL_META_FILE);
}

export function readManualMetaState(deps) {
  const file = manualMetaFilePath(deps);
  if (!file) return normalizeManualMeta(null);
  try {
    let text = deps.fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return normalizeManualMeta(JSON.parse(text));
  } catch {
    // 文件不存在/坏 JSON 一律当空台账：读接口不能因为一张台账坏了整页打不开。
    return normalizeManualMeta(null);
  }
}

export function writeManualMetaState(deps, table) {
  const file = manualMetaFilePath(deps);
  if (!file || typeof deps.atomicWriteJson !== 'function') throw new Error('手动标签台账不可写（STATE_DIR 未配置）');
  deps.atomicWriteJson(file, normalizeManualMeta(table));
}
