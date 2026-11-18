// 批量找号的纯规则（不碰网络、不碰文件系统）：批量任务的状态表 + 卡片上的「建议号」。
//
// 为什么要单独一层：桥接模块被 vm.runInContext 裸执行、不能 import（见 src/bridge/console/library-find.js
// 文件头），所以这些规则必须是纯函数，由 deps 注入。也让它们能被单测直接覆盖。
//
// 状态文件 state/booth-batchfind.json 的形状：
//   { version: 1, rulesVersion: 1, startedAt, finishedAt, entries: { [contentKey]: entry } }
// entry = { at, pick, auto, score, title, reason, reasonCode, candidates, skipped }
// `skipped` 记为 true 的条目表示「找过但没找到可信候选」，下次批量默认跳过（除非 force）。
// `reasonCode` 是机器码（前端「只重试失败」按它筛），`reason` 仍是给人看的一句话。

export const BATCH_RULES_VERSION = 1;
export const BATCH_MAX_KEYS = 60;
// 与 src/library-find.js 的 FIND_FAILURE_CODES 同值：两个纯规则文件各自独立（避免 ESM 循环依赖），
// 新增失败码时两边一起改，并在对应测试里断言两份白名单一致。
export const BATCH_FAILURE_CODES = Object.freeze(['rate_limit', 'timeout', 'no_candidates', 'no_phrase', 'error']);

function failureCode(value) {
  const code = str(value, 20);
  return BATCH_FAILURE_CODES.includes(code) ? code : '';
}

function numOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function str(value, max = 200) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

/** 把磁盘上的状态表规整成可用形状（坏值一律丢掉，不抛错）。 */
export function normalizeBatchState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const entries = {};
  const rawEntries = src.entries && typeof src.entries === 'object' ? src.entries : {};
  for (const [key, entry] of Object.entries(rawEntries)) {
    const k = str(key, 120);
    if (!k || !entry || typeof entry !== 'object') continue;
    const pick = str(entry.pick, 12);
    const validPick = /^\d{5,9}$/.test(pick) ? pick : '';
    entries[k] = {
      at: numOrZero(entry.at),
      pick: validPick,
      auto: Boolean(entry.auto) && Boolean(validPick),
      score: Number.isFinite(Number(entry.score)) ? Math.round(Number(entry.score) * 100) / 100 : 0,
      title: str(entry.title, 200),
      reason: str(entry.reason, 120),
      // 旧文件没有这个字段 → 空字符串（既不丢条目，也不假装知道失败原因）。
      reasonCode: failureCode(entry.reasonCode),
      candidates: Math.max(0, Math.trunc(numOrZero(entry.candidates))),
      skipped: Boolean(entry.skipped)
    };
  }
  return {
    version: 1,
    // 缺字段 = 当前版本（新表）；显式写了 0/旧值 = 需要重找，不能把它「升级」成本版本
    rulesVersion: src.rulesVersion == null ? BATCH_RULES_VERSION : Math.trunc(numOrZero(src.rulesVersion)),
    startedAt: numOrZero(src.startedAt),
    finishedAt: numOrZero(src.finishedAt),
    entries
  };
}

/** 规则版本变了，旧结果就不可信：返回 true 表示需要重找。 */
export function batchStale(state, rulesVersion = BATCH_RULES_VERSION) {
  const normalized = normalizeBatchState(state);
  return normalized.rulesVersion !== rulesVersion;
}

/**
 * 这一轮该找哪些 key。
 * - 没找过的：一定要找；
 * - 找过但 skipped 的：默认跳过（force 才重找）；但**限流/超时**属于「环境没给机会」，
 *   不是「这件素材没救了」——暂停解除后必须自动捡回来重试，不让人手动点「只重试」；
 * - 规则版本变了：全部重找；
 * - 已经有号（boothId 非空）或已绑定的：不找（人已经定了）。
 */
export function batchPending(cards, state, { force = false, limit = BATCH_MAX_KEYS } = {}) {
  const normalized = normalizeBatchState(state);
  const stale = batchStale(normalized);
  const list = Array.isArray(cards) ? cards : [];
  const out = [];
  const seen = new Set();
  for (const card of list) {
    if (!card || typeof card !== 'object') continue;
    const key = str(card.key, 120);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (str(card.boothId, 12)) continue;                 // 已经有号（含手动绑定）
    const entry = normalized.entries[key];
    // 限流/超时留下的是「没搜成」，不是「搜了没有」：不算放弃，下一轮自动重试。
    const transient = Boolean(entry) && (entry.reasonCode === 'rate_limit' || entry.reasonCode === 'timeout');
    // 找过就不再重复劳动（包括「找过但没找到」的）；规则版本变了或 force 才重来。
    if (entry && !force && !stale && !transient) continue;
    out.push(key);
  }
  return out.slice(0, Math.max(1, Math.trunc(Number(limit) || BATCH_MAX_KEYS)));
}

/** 记一条结果（返回新对象，不改入参）。 */
export function markBatchEntry(state, key, patch = {}) {
  const normalized = normalizeBatchState(state);
  const k = str(key, 120);
  if (!k) return normalized;
  const pick = str(patch.pick, 12);
  const validPick = /^\d{5,9}$/.test(pick) ? pick : '';
  const score = Number.isFinite(Number(patch.score)) ? Math.round(Number(patch.score) * 100) / 100 : 0;
  normalized.entries[k] = {
    at: numOrZero(patch.at) || Date.now(),
    pick: validPick,
    auto: Boolean(patch.auto) && Boolean(validPick),
    score,
    title: str(patch.title, 200),
    reason: str(patch.reason, 120),
    reasonCode: failureCode(patch.reasonCode),
    candidates: Math.max(0, Math.trunc(numOrZero(patch.candidates))),
    skipped: !validPick
  };
  normalized.rulesVersion = BATCH_RULES_VERSION;
  return normalized;
}

/** 进度条要的数字：总数 / 已找 / 有建议 / 没找到。 */
export function batchProgress(state) {
  const normalized = normalizeBatchState(state);
  const entries = Object.values(normalized.entries);
  const withPick = entries.filter((entry) => entry.pick).length;
  return {
    total: entries.length,
    withPick,
    skipped: entries.filter((entry) => entry.skipped).length,
    startedAt: normalized.startedAt,
    finishedAt: normalized.finishedAt,
    rulesVersion: normalized.rulesVersion
  };
}

/** 给素材卡挂上「建议号」：只在没号、且建议可信时不覆盖任何已有信息。 */
export function suggestionFor(card, state) {
  const normalized = normalizeBatchState(state);
  const key = str(card && card.key, 120);
  const entry = key ? normalized.entries[key] : null;
  if (!entry || !entry.pick) return null;
  const current = str(card.boothId, 12);
  if (current === entry.pick) return null;               // 已经绑上了，不用再建议
  return {
    boothId: entry.pick,
    title: entry.title,
    score: entry.score,
    auto: entry.auto,
    at: entry.at,
    reason: entry.reason
  };
}

/** 一句话进度（给按钮旁边的灰字）。 */
export function describeBatchProgress(progress, { running = false } = {}) {
  const total = Math.max(0, Math.trunc(Number(progress && progress.total) || 0));
  const withPick = Math.max(0, Math.trunc(Number(progress && progress.withPick) || 0));
  if (running) return `正在找号…（已经有 ${withPick} 件找到候选）`;
  if (!total) return '还没批量找过';
  return `找过 ${total} 件，其中 ${withPick} 件有候选${total > withPick ? `，${total - withPick} 件没找到` : ''}`;
}
