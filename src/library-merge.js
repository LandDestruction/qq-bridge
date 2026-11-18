// src/library-merge.js — 同一个 BOOTH 号的多份素材合并成一件（纯规则，不碰磁盘/网络）。
//
// 为什么需要：真实素材库里同一个商品常被转存成两三条（图片目录一条、压缩包一条），
// 页面上就成了三张卡；用户想「合并成一件」只是改展示，不能动磁盘、不能改 contentKey，
// 否则绑定表与下载台账都会跟着失效——所以合并状态单独存 state/booth-merges.json。
//
// 这里只做四件事：分组（propose）、建组/拆组（setMerge/removeMerge）、把组应用到卡片
// （applyMerges）、读写表（normalize/tableSummary）。路由在 console/library-view.js。

export const MERGE_RULES_VERSION = 1;
const BOOTH_ID_RE = /^\d{5,9}$/;
const MERGE_NOTE_MAX = 200;
const MERGE_KEYS_MAX = 50;

/** 组 id 由 BOOTH 号决定：同一商品只能有一个组，天然防重复建组。 */
export function mergeIdOf(boothId) {
  const id = String(boothId ?? '').trim();
  return BOOTH_ID_RE.test(id) ? `m-${id}` : '';
}

function cleanKey(value) {
  return String(value ?? '').trim().slice(0, 200);
}

function cleanKeys(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const key = cleanKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= MERGE_KEYS_MAX) break;
  }
  return out;
}

function cleanNote(value) {
  return String(value ?? '').trim().slice(0, MERGE_NOTE_MAX);
}

function nowOf(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/**
 * 规范化合并表：坏组丢掉、keys 去重、primaryKey 必须落在 keys 里。
 * 同一个 key 只能属于一个组——先出现的组赢（按组 id 排序保证结果稳定）。
 */
export function normalizeMergeTable(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const from = src.groups && typeof src.groups === 'object' && !Array.isArray(src.groups) ? src.groups : {};
  const groups = {};
  const claimed = new Set();
  const ids = Object.keys(from).sort();
  for (const rawId of ids) {
    const entry = from[rawId];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const boothId = String(entry.boothId ?? '').trim();
    const mergeId = mergeIdOf(boothId);
    if (!mergeId) continue;
    // 组 id 一律由 BOOTH 号重算：手改坏的键名不该把「组挂错号」传下去。
    const id = mergeId;
    const keys = cleanKeys(entry.keys).filter((key) => !claimed.has(key));
    if (keys.length < 2) continue;
    const primaryKey = keys.includes(cleanKey(entry.primaryKey)) ? cleanKey(entry.primaryKey) : keys[0];
    for (const key of keys) claimed.add(key);
    groups[id] = {
      boothId,
      primaryKey,
      keys,
      at: nowOf(entry.at, 0),
      note: cleanNote(entry.note)
    };
  }
  return { version: MERGE_RULES_VERSION, groups };
}

/** 某个 contentKey 属于哪个组（不属于返回 ''）。 */
export function groupOfKey(table, key) {
  const clean = cleanKey(key);
  if (!clean) return '';
  const groups = normalizeMergeTable(table).groups;
  for (const [mergeId, group] of Object.entries(groups)) {
    if (group.keys.includes(clean)) return mergeId;
  }
  return '';
}

/**
 * 建组（返回新表，不改入参）。
 * keys 至少两条、同一个 key 只能在一个组里：撞上的组会让出这些 key，
 * 让出后不足两条的组直接删掉（否则会留下一个只剩一条的假组）。
 */
export function setMerge(table, { boothId, keys, primaryKey, note = '', now = Date.now() } = {}) {
  const base = normalizeMergeTable(table);
  const bid = String(boothId ?? '').trim();
  if (!BOOTH_ID_RE.test(bid)) throw new Error('BOOTH 号不合法（5~9 位数字）');
  const list = cleanKeys(keys);
  if (list.length < 2) throw new Error('至少选两条素材才能合并');
  const mergeId = mergeIdOf(bid);
  if (!mergeId) throw new Error('BOOTH 号不合法（5~9 位数字）');

  const groups = {};
  for (const [id, group] of Object.entries(base.groups)) {
    if (id === mergeId) continue;   // 同号重建：旧组直接被新组取代
    const remain = group.keys.filter((key) => !list.includes(key));
    if (remain.length < 2) continue;
    groups[id] = {
      ...group,
      keys: remain,
      primaryKey: remain.includes(group.primaryKey) ? group.primaryKey : remain[0]
    };
  }
  const primary = list.includes(cleanKey(primaryKey)) ? cleanKey(primaryKey) : list[0];
  groups[mergeId] = { boothId: bid, primaryKey: primary, keys: list, at: nowOf(now, Date.now()), note: cleanNote(note) };
  return { version: MERGE_RULES_VERSION, groups };
}

/** 拆组（返回新表）。不存在的组原样返回。 */
export function removeMerge(table, mergeId) {
  const base = normalizeMergeTable(table);
  const id = cleanKey(mergeId);
  const groups = { ...base.groups };
  delete groups[id];
  return { version: MERGE_RULES_VERSION, groups };
}

/** 给页面看的摘要：几组、占了几件素材。 */
export function mergeTableSummary(table) {
  const base = normalizeMergeTable(table);
  const ids = Object.keys(base.groups);
  let keys = 0;
  for (const id of ids) keys += base.groups[id].keys.length;
  return { version: base.version, groups: ids.length, keys, mergedAway: Math.max(0, keys - ids.length) };
}

function cardBytes(card) {
  const n = Number(card?.bytes);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isDateDirName(name) {
  return /^\d{4}([-_.]?\d{2})?([-_.]?\d{2})?$/.test(String(name ?? '').trim());
}

/** 主成员怎么选：能当封面的 > 独立目录（不是日期目录）> 字节大 > key 靠前。 */
function betterCard(a, b) {
  const coverA = Boolean(a?.thumbRel) ? 1 : 0;
  const coverB = Boolean(b?.thumbRel) ? 1 : 0;
  if (coverA !== coverB) return coverA > coverB ? a : b;
  const lastA = String(a?.dir || '').split('/').filter(Boolean).pop() || '';
  const lastB = String(b?.dir || '').split('/').filter(Boolean).pop() || '';
  const indepA = isDateDirName(lastA) ? 0 : 1;
  const indepB = isDateDirName(lastB) ? 0 : 1;
  if (indepA !== indepB) return indepA > indepB ? a : b;
  const bytesA = cardBytes(a);
  const bytesB = cardBytes(b);
  if (bytesA !== bytesB) return bytesA > bytesB ? a : b;
  return String(a?.key ?? '') <= String(b?.key ?? '') ? a : b;
}

function uniqueBy(list, idOf) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const id = String(idOf(item) ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

// 卡片上的 `files` 在**真实 payload 里是数字**（这一件有几个文件），不是文件数组。
// 之前按数组并集处理，合并后 `files` 变成 []，页面上「合并进来的那一件」就彻底看不见了。
// 老测试/老调用如果传数组，这里仍按数组长度兜一下，别让两条形状互斥。
function fileCountOf(card) {
  const files = card?.files;
  if (Array.isArray(files)) return files.length;
  const n = Number(files);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function previewIdOf(item) {
  if (typeof item === 'string') return item;
  return String(item?.relPath ?? item?.name ?? item?.url ?? '');
}

/**
 * 按 BOOTH 号提出「这 N 条可以合并」，供页面提示。
 * 只提合法号、且同一号下至少两条；已被合并表接管的那几条不再提（免得页面上重复喊）。
 */
export function proposeMergeGroups(cards, table = null) {
  const list = Array.isArray(cards) ? cards : [];
  const taken = normalizeMergeTable(table);
  const byBooth = new Map();
  for (const card of list) {
    const boothId = String(card?.boothId ?? '').trim();
    if (!BOOTH_ID_RE.test(boothId)) continue;
    if (!byBooth.has(boothId)) byBooth.set(boothId, []);
    byBooth.get(boothId).push(card);
  }
  const out = [];
  for (const [boothId, group] of byBooth.entries()) {
    if (group.length < 2) continue;
    if (taken.groups[mergeIdOf(boothId)]) continue;
    let primary = group[0];
    for (const card of group.slice(1)) primary = betterCard(primary, card);
    out.push({
      boothId,
      mergeId: mergeIdOf(boothId),
      keys: group.map((card) => String(card?.key ?? '')),
      primaryKey: String(primary?.key ?? ''),
      totalBytes: group.reduce((sum, card) => sum + cardBytes(card), 0),
      fileCount: group.reduce((sum, card) => sum + fileCountOf(card), 0)
    });
  }
  return out.sort((a, b) => Number(a.boothId) - Number(b.boothId));
}

/**
 * 把合并组应用到卡片列表：主成员留一张卡（带 mergeId/mergedKeys/mergedCount，
 * files 求和 / bytes 求和 / previews 并集、并附 mergedMembers），其余成员从列表里去掉。**不改传入对象**。
 * 返回 {cards, mergedAway, groups}：mergedAway = 被折叠掉（从列表移除）的卡片数。
 */
/** 合并卡继承哪些「指纹/展示」字段：主成员有就取主成员，没有就取第一个有值的成员。 */
const MERGED_CARRY_FIELDS = ['dhash', 'thumbRel', 'coverUrl', 'hasCover', 'displayTitle', 'boothStatus', 'bindSuggestions'];

/** 字段算不算「有值」（false/0/空串要区分：hasCover=false 也是有效值，但主成员 false 而别的成员 true 时应取 true）。 */
function carryValueOf(card, field) {
  const value = card?.[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.length ? value : undefined;
  if (field === 'hasCover') return value === true ? true : undefined;
  return value;
}

/**
 * 把成员里的指纹/展示字段并到合并卡上。
 * 为什么需要：合并卡以前只并 files/bytes，dhash/thumbRel 全丢——`withDhash` 统计按扫盘卡算 29，
 * 页面上真正带指纹的只有 27（差的 2 张正是合并卡），重复检测/以图搜源也看不到它们。
 * 主成员优先（它代表「打开哪一件」），主成员缺值时回退到第一个有值的成员。
 */
function carryFieldsFromMembers(merged, members) {
  for (const field of MERGED_CARRY_FIELDS) {
    if (carryValueOf(merged, field) !== undefined) continue;   // ...primary 已经带上
    const donor = members.find((card) => carryValueOf(card, field) !== undefined);
    if (!donor) continue;
    merged[field] = donor[field];
  }
  // 这些是「单件」的辅助字段（按 key 缓存/临时路径之类），合并卡上留着会指向主成员之外的文件。
  delete merged.dhashFile;
  delete merged.coverFile;
  return merged;
}

export function applyMerges(cards, table) {
  const list = Array.isArray(cards) ? cards : [];
  const base = normalizeMergeTable(table);
  const byKey = new Map();
  for (const card of list) byKey.set(String(card?.key ?? ''), card);
  const consumed = new Set();
  const replacements = new Map();   // primaryKey -> 合并后的卡
  let groupsApplied = 0;
  for (const group of Object.values(base.groups)) {
    const members = group.keys.map((key) => byKey.get(key)).filter(Boolean);
    if (members.length < 2) continue;   // 磁盘上缺了成员就按普通卡处理，不硬造空字段
    const primary = members.find((card) => String(card.key) === group.primaryKey) || members[0];
    // files 保持与普通卡同一类型：数字（求和）。合并 3 件各 1 个文件，合并卡就该显示 3。
    const files = members.reduce((sum, card) => sum + fileCountOf(card), 0);
    const previews = uniqueBy(members.flatMap((card) => (Array.isArray(card?.previews) ? card.previews : [])), previewIdOf);
    const dirs = [];
    for (const card of members) {
      const dir = String(card?.dir ?? '').trim();
      if (dir && !dirs.includes(dir)) dirs.push(dir);
    }
    const merged = {
      ...primary,
      mergeId: mergeIdOf(group.boothId),
      mergedKeys: group.keys.slice(),
      mergedCount: members.length,
      // 主卡自己可能没有号（合并的几条都靠人工绑定），组的号才是这张卡认的号。
      boothId: String(primary.boothId ?? '').trim() || group.boothId,
      files,
      previews,
      dirs,
      // 「打开」只会打开主成员的目录，被并进来的那几件得让用户看得见：
      // 每件给 key/dir/mainName/files/bytes/title，主成员排第一，前端可以逐条列出/单独打开。
      mergedMembers: [
        primary,
        ...members.filter((card) => card !== primary)
      ].map((card) => ({
        key: String(card?.key ?? ''),
        dir: String(card?.dir ?? ''),
        mainName: String(card?.mainName ?? card?.file ?? ''),
        files: fileCountOf(card),
        bytes: cardBytes(card),
        title: String(card?.title ?? ''),
        // 每个成员的指纹单独留着：重复检测/以图搜源要按成员比较，不能只看合并卡那一个。
        dhash: String(card?.dhash ?? '')
      })),
      bytes: members.reduce((sum, card) => sum + cardBytes(card), 0)
    };
    if (!merged.title) merged.title = String(primary?.title ?? '');
    carryFieldsFromMembers(merged, [primary, ...members.filter((card) => card !== primary)]);
    replacements.set(String(primary.key), merged);
    for (const card of members) consumed.add(String(card.key));
    groupsApplied += 1;
  }
  const out = [];
  let mergedAway = 0;
  for (const card of list) {
    const key = String(card?.key ?? '');
    const replacement = replacements.get(key);
    if (replacement) { out.push(replacement); continue; }
    if (consumed.has(key)) { mergedAway += 1; continue; }
    out.push(card);
  }
  return { cards: out, mergedAway, groups: groupsApplied };
}
