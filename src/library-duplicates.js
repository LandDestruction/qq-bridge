// 重复素材检测：纯规则、零 import（可 VM 裸跑），输入就是 `/api/library/assets` 的卡片数组。
// 四类重复按顺序优先，同一个 key 组合只报一次：
//   1. `同号`       —— 不同 key 的卡共用同一个 boothId（人工合并过的卡不算）；
//   2. `同名同大小` —— `mainBytes` 相同且主件名（去扩展名、忽略大小写与复制后缀）相同；
//   3. `封面近似`   —— `dhash` 非空且相同（没 dhash 的卡不参与，不拿别的字段猜）；
//   4. `标题近似`   —— `displayTitle`/`title` 归一化后相同，且 bytes 差距 < 5%。
// 保留谁（keepKey）与素材库「合并」的主成员规则完全一致（src/library-merge.js 的 betterCard）：
// 有封面 > 非日期名的独立目录 > bytes 大 > key 小。别在这里另发明规则。
// 已人工合并过的卡（`mergeId`/`mergedKeys`/`mergedCount>=2`）一律不参与：再报只会诱导整组删掉。
// 只给建议不碰盘：`planDuplicatesCleanup` 产出「该进回收站的 key」，真正删除走 /api/library/trash。

const BOOTH_ID_RE = /^\d{4,10}$/;
const TITLE_BYTES_TOLERANCE = 0.05;
// 复制出来的同名文件常见后缀：`xxx_1`、`xxx (1)`、`xxx（1）`、`xxx - 1`。循环剥，最多 3 层。
const COPY_SUFFIX_RE = /(?:\s*[（(]\s*\d{1,3}\s*[)）]|_+\d{1,3}|\s+-\s*\d{1,3})$/;
const REASON_BOOTH = '同号';
const REASON_BYTES_NAME = '同名同大小';
const REASON_DHASH = '封面近似';
const REASON_TITLE = '标题近似';

function text(value) {
  return String(value == null ? '' : value).trim();
}
function bytesOf(asset) {
  const value = Number(asset?.bytes);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
function keyOf(asset) {
  return text(asset?.key);
}
function hasCover(asset) {
  return Boolean(asset?.thumbRel || asset?.thumbUrl || asset?.coverUrl || asset?.coverReady);
}
function isMerged(asset) {
  if (text(asset?.mergeId)) return true;
  if (Array.isArray(asset?.mergedKeys) && asset.mergedKeys.length >= 2) return true;
  const count = Number(asset?.mergedCount);
  return Number.isFinite(count) && count >= 2;
}
function lastDirName(dir) {
  const segments = String(dir == null ? '' : dir).split(/[\\/]+/).filter(Boolean);
  return segments.length ? segments[segments.length - 1] : '';
}
function isDateDirName(name) {
  return /^\d{4}([-_.]?\d{2})?([-_.]?\d{2})?$/.test(text(name));
}

/** 与 library-merge 的 betterCard 同序：正数表示 a 更适合留下。 */
function compareKeep(a, b) {
  const cover = (hasCover(a) ? 1 : 0) - (hasCover(b) ? 1 : 0);
  if (cover !== 0) return cover;
  const indep = (isDateDirName(lastDirName(a?.dir)) ? 0 : 1) - (isDateDirName(lastDirName(b?.dir)) ? 0 : 1);
  if (indep !== 0) return indep;
  const gap = bytesOf(a) - bytesOf(b);
  if (gap !== 0) return gap;
  return keyOf(a) < keyOf(b) ? 1 : keyOf(a) > keyOf(b) ? -1 : 0;
}

function pickKeep(members) {
  let best = members[0];
  for (const member of members.slice(1)) if (compareKeep(member, best) > 0) best = member;
  return best;
}

/** 主件名去扩展名 + 去复制后缀 + 小写（只用于「同名同大小」比较，不用于展示）。 */
export function normalizeMainName(name) {
  let stem = String(name == null ? '' : name).split(/[\\/]/).pop();
  stem = stem.normalize('NFKC').trim();
  const dot = stem.lastIndexOf('.');
  if (dot > 0) stem = stem.slice(0, dot);
  let guard = 0;
  while (COPY_SUFFIX_RE.test(stem) && guard < 3) {
    stem = stem.replace(COPY_SUFFIX_RE, '');
    guard += 1;
  }
  return stem.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 标题归一化：优先 displayTitle（没有就 title），剥号前缀，小写，清分隔符与复制后缀。 */
export function normalizeTitle(asset) {
  const raw = text(asset?.displayTitle) || text(asset?.title);
  if (!raw) return '';
  let title = raw.normalize('NFKC').trim();
  title = title.replace(/^(?:booth[-_\s]*)?\d{5,8}[\s_\-—–·.、，,]*/i, '');
  title = title.replace(/[（(]\s*\d{1,3}\s*[)）]/g, ' ');
  return title.toLowerCase().replace(/[_\-\s·.、，,]+/g, ' ').trim();
}

function dhashOf(asset) {
  return text(asset?.dhash).toLowerCase();
}

function gapRatio(a, b) {
  const high = Math.max(a, b);
  return high <= 0 ? 0 : (high - Math.min(a, b)) / high;
}

function bucketize(members, bucketKeyOf) {
  const buckets = new Map();
  for (const member of members) {
    const bucket = bucketKeyOf(member);
    if (!bucket) continue;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(member);
  }
  return [...buckets.values()].filter((group) => group.length >= 2);
}

/** 同标题的成员再按 bytes 5% 就近聚类（否则「同名不同体积」会被硬凑成一组）。 */
function clusterByBytes(members) {
  const sorted = members.slice().sort((a, b) => bytesOf(a) - bytesOf(b) || (keyOf(a) < keyOf(b) ? -1 : 1));
  const clusters = [];
  let current = [];
  for (const member of sorted) {
    if (!current.length) {
      current = [member];
      continue;
    }
    const reference = Math.max(...current.map(bytesOf));
    if (gapRatio(bytesOf(member), reference) < TITLE_BYTES_TOLERANCE) current.push(member);
    else {
      clusters.push(current);
      current = [member];
    }
  }
  if (current.length) clusters.push(current);
  return clusters.filter((cluster) => cluster.length >= 2);
}

function makeGroup(reason, members) {
  const keep = pickKeep(members);
  const bytes = members.reduce((sum, member) => sum + bytesOf(member), 0);
  const keepBytes = bytesOf(keep);
  return {
    reason,
    keys: members.map(keyOf),
    count: members.length,
    bytes,
    keepKey: keyOf(keep),
    keepBytes,
    extraBytes: Math.max(0, bytes - keepBytes),
    title: text(keep?.displayTitle) || text(keep?.title) || text(keep?.mainName),
    members: members.map((member) => ({
      key: keyOf(member),
      bytes: bytesOf(member),
      mtime: Number(member?.mtime) > 0 ? Number(member.mtime) : 0,
      hasCover: hasCover(member),
      dir: text(member?.dir)
    }))
  };
}

/**
 * 找重复。
 * @param {Array<object>} assets `/api/library/assets` 的卡片（合并后视图；合并卡会被跳过）
 * @returns {{groups:Array, totalExtra:number, totalExtraBytes:number}}
 */
export function groupDuplicates(assets) {
  const usable = [];
  const seenKeys = new Set();
  for (const asset of Array.isArray(assets) ? assets : []) {
    if (!asset || typeof asset !== 'object') continue;
    const key = keyOf(asset);
    if (!key || seenKeys.has(key) || isMerged(asset)) continue;
    seenKeys.add(key);
    usable.push(asset);
  }

  const candidates = [];
  // 1) 同号：只认像 BOOTH 号的 boothId
  candidates.push(...bucketize(usable, (asset) => {
    const boothId = text(asset?.boothId);
    return BOOTH_ID_RE.test(boothId) ? boothId : '';
  }).map((members) => [REASON_BOOTH, members]));
  // 2) 同名同大小：主件名 + mainBytes 都相同
  candidates.push(...bucketize(usable, (asset) => {
    const mainBytes = Number(asset?.mainBytes);
    if (!Number.isFinite(mainBytes) || mainBytes <= 0) return '';
    const stem = normalizeMainName(asset?.mainName);
    return stem ? `${mainBytes}|${stem}` : '';
  }).map((members) => [REASON_BYTES_NAME, members]));
  // 3) 封面近似：dhash 非空且相等
  candidates.push(...bucketize(usable, dhashOf).map((members) => [REASON_DHASH, members]));
  // 4) 标题近似：归一化标题相同 + bytes 差距 < 5%
  for (const bucket of bucketize(usable, normalizeTitle)) {
    for (const cluster of clusterByBytes(bucket)) candidates.push([REASON_TITLE, cluster]);
  }

  const emitted = new Set();
  const groups = [];
  for (const [reason, members] of candidates) {
    const signature = members.map(keyOf).sort().join(',');
    if (!signature || emitted.has(signature)) continue;
    emitted.add(signature);
    groups.push(makeGroup(reason, members));
  }
  const order = { [REASON_BOOTH]: 0, [REASON_BYTES_NAME]: 1, [REASON_DHASH]: 2, [REASON_TITLE]: 3 };
  groups.sort((a, b) => {
    if (order[a.reason] !== order[b.reason]) return order[a.reason] - order[b.reason];
    if (b.extraBytes !== a.extraBytes) return b.extraBytes - a.extraBytes;
    return a.keepKey < b.keepKey ? -1 : a.keepKey > b.keepKey ? 1 : 0;
  });

  const totalExtra = groups.reduce((sum, group) => sum + Math.max(0, group.count - 1), 0);
  const totalExtraBytes = groups.reduce((sum, group) => sum + group.extraBytes, 0);
  return { groups, totalExtra, totalExtraBytes };
}

function groupListOf(input) {
  if (Array.isArray(input)) return input;
  return input && Array.isArray(input.groups) ? input.groups : [];
}

function membersOf(group) {
  if (Array.isArray(group?.members) && group.members.length) return group.members;
  return Array.isArray(group?.keys) ? group.keys.map((key) => ({ key })) : [];
}

/** 给人看的摘要：几组、几个多余、能省多少字节（savedBytes 与 extraBytes 同值，命名更直白）。 */
export function summarizeDuplicates(groups) {
  let groupCount = 0;
  let extraCount = 0;
  let extraBytes = 0;
  for (const group of groupListOf(groups)) {
    const count = Array.isArray(group?.keys) ? group.keys.length : Number(group?.count) || 0;
    if (count < 2) continue;
    groupCount += 1;
    extraCount += count - 1;
    const extra = Number(group?.extraBytes);
    extraBytes += Number.isFinite(extra) && extra > 0 ? extra : 0;
  }
  return { groupCount, extraCount, extraBytes, savedBytes: extraBytes };
}

function pickBy(members, valueOf) {
  let best = members[0];
  for (const member of members.slice(1)) {
    const next = valueOf(member);
    const current = valueOf(best);
    if (next > current || (next === current && keyOf(member) < keyOf(best))) best = member;
  }
  return best;
}

/**
 * 出「清理计划」：只列非 keep 成员；keepKey 永不进 trashKeys。
 * @param {Array|{groups:Array}} groups groupDuplicates 的结果（或 groups 数组）
 * @param {{keep?:'newest'|'largest', keys?:string[]}} [options]
 *   keep：'largest' 留体积最大的；'newest' 留 mtime 最新的（有 mtime 的成员不足 2 个时回落 keepKey 规则）；
 *   keys：UI 勾选的 key，给了就只处理这些（其余不动）。
 */
export function planDuplicatesCleanup(groups, options = {}) {
  const list = groupListOf(groups);
  const keepMode = options?.keep === 'largest' || options?.keep === 'newest' ? options.keep : '';
  const only = Array.isArray(options?.keys) ? new Set(options.keys.map(text).filter(Boolean)) : null;
  const trashKeys = [];
  const keepKeys = [];
  const skipped = [];
  const seenTrash = new Set();
  const seenSkip = new Set();
  const recordSkip = (key, reason) => {
    const signature = `${key}|${reason}`;
    if (!key || seenSkip.has(signature)) return;
    seenSkip.add(signature);
    skipped.push({ key, reason });
  };

  for (const group of list) {
    const members = membersOf(group);
    if (members.length < 2) continue;
    let keepMember = members.find((member) => keyOf(member) === text(group?.keepKey)) || null;
    if (!keepMember) keepMember = pickKeep(members);
    if (keepMode === 'largest') keepMember = pickBy(members, bytesOf);
    else if (keepMode === 'newest') {
      const timed = members.filter((member) => Number(member?.mtime) > 0);
      if (timed.length >= 2) keepMember = pickBy(members, (member) => (Number(member?.mtime) > 0 ? Number(member.mtime) : -1));
    }
    const keepKey = keyOf(keepMember);
    if (keepKey && !keepKeys.includes(keepKey)) keepKeys.push(keepKey);
    for (const member of members) {
      const key = keyOf(member);
      if (!key || key === keepKey) continue;
      if (only && !only.has(key)) continue;
      if (seenTrash.has(key)) continue;
      seenTrash.add(key);
      trashKeys.push(key);
    }
  }

  if (only) {
    const inGroup = new Set();
    for (const group of list) for (const member of membersOf(group)) inGroup.add(keyOf(member));
    for (const key of only) {
      if (!inGroup.has(key)) recordSkip(key, '不在重复组里');
      else if (keepKeys.includes(key)) recordSkip(key, '保留项不能删（keepKey）');
    }
  }
  return { trashKeys, keepKeys, skipped };
}
