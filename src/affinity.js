// 好感度（0–100）：按 QQ 号跨群统一、可解释、双向限速的**纯逻辑**模块。
//
// 设计取自重 M7 规格，两句话概括：
//   1. 好感度是「已有记忆的数字视图」，不是新记忆库：score = clamp(round(base + modelDelta), 0, 100)，
//      两边都只走有界增量，任何数字都能用 reasons 里的具体事解释。
//   2. **防当场讨好**：模型想改分要过五道闸（±3 / 10 分钟 / 日累计 / 被问当轮 / 本轮必须有该人入站），
//      启发式那侧则给每项证据设日上限，并让 base 每天只朝目标挪 10%。
//
// 边界：本模块只有 `loadStore/saveStore` 碰磁盘（原子写 + 坏数据自愈），其余全部是纯函数，
// 不改传进来的对象、不发请求、不读配置。桥接里只做接线（见 AFFINITY-API.md）。
//
// 两处口径与规格 §3 的字面值不同，已报 W1（都做成了配置项，可随时改回）：
//   · 「30 天未出现」与「辱骂」实现为**立即扣分**，其余正证据才走每日 10% 拉拽 ——
//     否则 -1 分被 10% 稀释成 -0.1，用户完全无感，惩罚等于没有。
//   · 默认值取 W1 派单里的 -5 / -1（日上限 -3）；规格 §3 写的是 -2 / -3（上限 -4）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 规则版本：改了评分口径就 +1，旧 state 里的 reasons 会清空并按新规则重算。 */
export const AFFINITY_RULES_VER = 1;
const DAY_MS = 86_400_000;

export const DEFAULT_RULES = Object.freeze({
  enabled: true,
  start: 50,
  modelDeltaMax: 3,
  modelDailyMax: 10,
  settleCooldownMs: 600_000,
  ownerCanQueryAll: true,
  showReasons: 2,
  tzOffsetMin: 480, // 东八区：本地时间 = UTC + 480 分钟（dayKey 用它切天）
  queryKeywords: Object.freeze(['好感度', '好感', '几分', '打分', '喜不喜欢我', '对我的印象']),
  insultKeywords: Object.freeze(['傻逼', '滚', '废物', '垃圾']),
  evidence: Object.freeze({
    appear: 1,          // 当天首次出现
    at: 0.5, atMax: 2,  // 被 @ / 被引用
    priv: 0.3, privMax: 2,
    sticker: 0.3, stickerMax: 1, // 发表情 / 拍一拍 / 看图后接话，共用一档
    absent30d: -5,
    insult: -1, insultDayMax: -3,
    basePullRate: 0.10,
    absentDays: 30,
    maxIdleDays: 180
  })
});

// ── 小工具 ──────────────────────────────────────────────────────────────────

export function clampScore(n, { min = 0, max = 100 } = {}) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function num(v, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 非负数收敛：负数/NaN 一律回落默认（负上限在语义上无意义，不能 clamp 成 0 冒充「用户设了 0」）。 */
function nonNeg(v, fallback, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(max, n);
}

function strList(v, fallback) {
  if (!Array.isArray(v)) return [...fallback];
  const out = [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))];
  return out.length ? out : [...fallback];
}

/** 本地日期键（默认东八区）。用 UTC 字段读「偏移后的墙钟」，避开宿主时区影响。 */
export function dayKeyOf(ts = Date.now(), tzOffsetMin = DEFAULT_RULES.tzOffsetMin) {
  const offset = num(tzOffsetMin, DEFAULT_RULES.tzOffsetMin, { min: -840, max: 840 });
  return new Date(Number(ts) + offset * 60_000).toISOString().slice(0, 10);
}

/** 合并默认值并收敛非法值；不信任调用方传进来的任何字段。 */
export function normalizeRules(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ev = r.evidence && typeof r.evidence === 'object' ? r.evidence : {};
  const d = DEFAULT_RULES;
  return {
    enabled: r.enabled !== false,
    start: num(r.start, d.start, { min: 0, max: 100 }),
    modelDeltaMax: nonNeg(r.modelDeltaMax, d.modelDeltaMax, 100),
    modelDailyMax: nonNeg(r.modelDailyMax, d.modelDailyMax, 100),
    settleCooldownMs: nonNeg(r.settleCooldownMs, d.settleCooldownMs, 7 * DAY_MS),
    ownerCanQueryAll: r.ownerCanQueryAll !== false,
    showReasons: nonNeg(r.showReasons, d.showReasons, 10),
    tzOffsetMin: num(r.tzOffsetMin, d.tzOffsetMin, { min: -840, max: 840 }),
    queryKeywords: strList(r.queryKeywords, d.queryKeywords),
    insultKeywords: strList(r.insultKeywords, d.insultKeywords),
    evidence: {
      appear: num(ev.appear, d.evidence.appear),
      at: num(ev.at, d.evidence.at),
      atMax: nonNeg(ev.atMax, d.evidence.atMax, 100),
      priv: num(ev.priv, d.evidence.priv),
      privMax: nonNeg(ev.privMax, d.evidence.privMax, 100),
      sticker: num(ev.sticker, d.evidence.sticker),
      stickerMax: nonNeg(ev.stickerMax, d.evidence.stickerMax, 100),
      absent30d: num(ev.absent30d, d.evidence.absent30d),
      insult: num(ev.insult, d.evidence.insult),
      insultDayMax: num(ev.insultDayMax, d.evidence.insultDayMax),
      basePullRate: num(ev.basePullRate, d.evidence.basePullRate, { min: 0, max: 1 }),
      absentDays: nonNeg(ev.absentDays, d.evidence.absentDays, 3650) || d.evidence.absentDays,
      maxIdleDays: nonNeg(ev.maxIdleDays, d.evidence.maxIdleDays, 36500) || d.evidence.maxIdleDays
    }
  };
}

export function emptyStore() {
  return { version: 1, rulesVer: AFFINITY_RULES_VER, people: Object.create(null) };
}

function newPerson(userId, now, rules) {
  const start = clampScore(rules.start);
  const day = dayKeyOf(now, rules.tzOffsetMin);
  return {
    userId: String(userId),
    name: '',
    score: start, base: start, modelDelta: 0,
    updatedAt: Number(now) || Date.now(),
    dayKey: day,
    dayBasePoints: 0,
    dayModelDelta: 0,
    dayAppeared: false,
    dayEvidence: { at: 0, priv: 0, sticker: 0, insult: 0 },
    lastSettleAt: 0,
    lastModelAt: 0,
    lastAbsenceAt: 0,
    counters: { msgs: 0, at: 0, priv: 0, sticker: 0, poke: 0, daysSeen: 0, lastSeenAt: 0, firstSeenAt: 0 },
    reasons: []
  };
}

/** 只做「补齐缺字段」，不改已有数值；旧 state / 手改过的条目都能进来。 */
function normalizePerson(raw, userId, now, rules) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const base = num(p.base, clampScore(rules.start), { min: 0, max: 100 });
  const modelDelta = num(p.modelDelta, 0, { min: -100, max: 100 });
  const out = {
    userId: String(userId),
    name: String(p.name ?? ''),
    base: round2(base),
    modelDelta: round2(modelDelta),
    score: clampScore(Math.round(base + modelDelta)),
    updatedAt: num(p.updatedAt, now),
    dayKey: typeof p.dayKey === 'string' ? p.dayKey : dayKeyOf(now, rules.tzOffsetMin),
    dayBasePoints: num(p.dayBasePoints, 0),
    dayModelDelta: num(p.dayModelDelta, 0),
    dayAppeared: p.dayAppeared === true,
    dayEvidence: {
      at: num(p.dayEvidence?.at, 0), priv: num(p.dayEvidence?.priv, 0),
      sticker: num(p.dayEvidence?.sticker, 0), insult: num(p.dayEvidence?.insult, 0)
    },
    lastSettleAt: num(p.lastSettleAt, 0),
    lastModelAt: num(p.lastModelAt, 0),
    lastAbsenceAt: num(p.lastAbsenceAt, 0),
    counters: {
      msgs: num(p.counters?.msgs, 0), at: num(p.counters?.at, 0), priv: num(p.counters?.priv, 0),
      sticker: num(p.counters?.sticker, 0), poke: num(p.counters?.poke, 0),
      daysSeen: num(p.counters?.daysSeen, 0), lastSeenAt: num(p.counters?.lastSeenAt, 0),
      firstSeenAt: num(p.counters?.firstSeenAt, 0)
    },
    reasons: []
  };
  for (const r of (Array.isArray(p.reasons) ? p.reasons : [])) {
    const delta = Number(r?.delta);
    if (!Number.isFinite(delta)) continue;
    out.reasons.push({
      ts: num(r?.ts, now), by: String(r?.by || 'heuristic'), delta: round2(delta),
      why: String(r?.why ?? '').slice(0, 80), scope: String(r?.scope ?? '')
    });
  }
  out.reasons = out.reasons.slice(-20);
  return out;
}

function pushReason(person, { ts, by, delta, why, scope = '' }) {
  person.reasons.push({
    ts: Number(ts) || Date.now(), by: String(by || 'heuristic'),
    delta: round2(delta), why: String(why ?? '').slice(0, 80), scope: String(scope || '')
  });
  if (person.reasons.length > 20) person.reasons.splice(0, person.reasons.length - 20);
}

function recomputeScore(person) {
  person.score = clampScore(Math.round(person.base + person.modelDelta));
  return person.score;
}

export function ensurePerson(store, userId, now = Date.now(), rulesIn) {
  const id = String(userId ?? '').trim();
  if (!id) throw new Error('ensurePerson 需要 userId（QQ 号）');
  if (!store || typeof store !== 'object') throw new Error('ensurePerson 需要一个 store 对象');
  if (!store.people || typeof store.people !== 'object') store.people = Object.create(null);
  if (!store.people[id]) store.people[id] = newPerson(id, now, normalizeRules(rulesIn));
  return store.people[id];
}

/** 跨天：把「昨天攒到的证据分」按 basePullRate 挪进 base，并清空当天计数。 */
export function settleDay(person, now = Date.now(), rulesIn) {
  const rules = normalizeRules(rulesIn);
  const today = dayKeyOf(now, rules.tzOffsetMin);
  const result = { applied: false, points: 0, baseBefore: person.base, baseAfter: person.base, absent: 0 };
  if (person.dayKey !== today) {
    const points = round2(person.dayBasePoints);
    if (points) {
      const target = clampScore(person.base + points);
      person.base = round2(clampScore(person.base + (target - person.base) * rules.evidence.basePullRate));
      person.lastSettleAt = Number(now) || Date.now();
      result.applied = points !== 0;
      result.points = points;
      result.baseAfter = person.base;
    }
    person.dayKey = today;
    person.dayBasePoints = 0;
    person.dayModelDelta = 0;
    person.dayAppeared = false;
    person.dayEvidence = { at: 0, priv: 0, sticker: 0, insult: 0 };
  }
  // 30 天没出现：一次空窗只扣一次（lastAbsenceAt 早于最后一次见到才算新空窗）。
  const seenAt = person.counters.lastSeenAt || 0;
  const idleMs = seenAt ? (Number(now) - seenAt) : 0;
  if (seenAt && idleMs > rules.evidence.absentDays * DAY_MS && person.lastAbsenceAt < seenAt) {
    person.base = round2(clampScore(person.base + rules.evidence.absent30d));
    person.lastAbsenceAt = Number(now) || Date.now();
    pushReason(person, { ts: now, by: 'heuristic', delta: rules.evidence.absent30d, why: `${rules.evidence.absentDays} 天没露面` });
    result.absent = rules.evidence.absent30d;
  }
  recomputeScore(person);
  result.baseAfter = person.base;
  return result;
}

/**
 * 入站证据累计。**不改 base**：当天先攒 dayBasePoints，跨天再由 settleDay 拉 10% 进 base。
 * 各项都有日上限，所以刷屏刷不出分（自测第 4 条）。
 */
export function applyInbound(person, event = {}, now = Date.now(), rulesIn) {
  const rules = normalizeRules(rulesIn);
  settleDay(person, now, rules); // 先跨天，再记今天
  const ev = rules.evidence;
  const applied = [];
  let points = 0;
  const add = (delta, why) => {
    if (!delta) return;
    person.dayBasePoints = round2(person.dayBasePoints + delta);
    points = round2(points + delta);
    applied.push(why);
    // 每条真正生效的证据都留一条理由：数字要能被解释（规格 §1「任何时候都能说清」）。
    // 有日上限兜着，所以一天最多 4 条，不会把 reasons 刷爆。
    pushReason(person, { ts: now, by: 'heuristic', delta, why: why.replace(/（.*$/, ''), scope: event.scope });
  };

  person.counters.msgs += 1;
  person.counters.lastSeenAt = Number(now) || Date.now();
  if (!person.counters.firstSeenAt) person.counters.firstSeenAt = Number(now) || Date.now();
  if (!person.dayAppeared) {
    person.dayAppeared = true;
    person.counters.daysSeen += 1;
    add(ev.appear, `今天露面（+${ev.appear}）`);
  }

  const kind = String(event.kind || 'group');
  if (kind === 'private') {
    person.counters.priv += 1;
    const room = Math.max(0, ev.privMax - person.dayEvidence.priv);
    const gain = Math.min(ev.priv, room);
    if (gain > 0) { person.dayEvidence.priv = round2(person.dayEvidence.priv + gain); add(gain, `私聊（+${ev.priv}/条，日上限 ${ev.privMax}）`); }
  }
  if (event.at === true) {
    person.counters.at += 1;
    const room = Math.max(0, ev.atMax - person.dayEvidence.at);
    const gain = Math.min(ev.at, room);
    if (gain > 0) { person.dayEvidence.at = round2(person.dayEvidence.at + gain); add(gain, `被@/被引用（+${ev.at}/次，日上限 ${ev.atMax}）`); }
  }
  if (event.sticker === true || event.poke === true || event.media === true) {
    if (event.sticker === true) person.counters.sticker += 1;
    if (event.poke === true) person.counters.poke += 1;
    const room = Math.max(0, ev.stickerMax - person.dayEvidence.sticker);
    const gain = Math.min(ev.sticker, room);
    if (gain > 0) { person.dayEvidence.sticker = round2(person.dayEvidence.sticker + gain); add(gain, `表情/拍一拍/看图接话（+${ev.sticker}，日上限 ${ev.stickerMax}）`); }
  }

  person.updatedAt = Number(now) || Date.now();
  recomputeScore(person);
  return { person, dayPoints: person.dayBasePoints, applied, points };
}

/** 负向事件（辱骂 / 30 天未出现）：立即扣，但有日上限；同一天怎么骂都不超过上限。 */
export function applyPenalty(person, kind, now = Date.now(), rulesIn) {
  const rules = normalizeRules(rulesIn);
  const ev = rules.evidence;
  settleDay(person, now, rules);
  if (kind === 'insult') {
    const used = person.dayEvidence.insult;              // 今天已扣（负数）
    const room = Math.max(0, used - ev.insultDayMax);    // insultDayMax 也是负数，如 -3
    const mag = Math.min(Math.abs(ev.insult), room);
    if (!mag) return { applied: false, delta: 0, reason: '日上限已满' };
    person.dayEvidence.insult = round2(used - mag);
    person.base = round2(clampScore(person.base - mag));
    person.updatedAt = Number(now) || Date.now();
    pushReason(person, { ts: now, by: 'heuristic', delta: -mag, why: '说了难听的话' });
    recomputeScore(person);
    return { applied: true, delta: -mag };
  }
  if (kind === 'absent30d') {
    const seenAt = person.counters.lastSeenAt || 0;
    const idleMs = seenAt ? Number(now) - seenAt : 0;
    if (!seenAt || idleMs <= ev.absentDays * DAY_MS || person.lastAbsenceAt >= seenAt) {
      return { applied: false, delta: 0, reason: '不到 30 天空窗或已扣过' };
    }
    person.lastAbsenceAt = Number(now) || Date.now();
    person.base = round2(clampScore(person.base + ev.absent30d));
    pushReason(person, { ts: now, by: 'heuristic', delta: ev.absent30d, why: `${ev.absentDays} 天没露面` });
    recomputeScore(person);
    return { applied: true, delta: ev.absent30d };
  }
  return { applied: false, delta: 0, reason: `未知惩罚类型 ${kind}` };
}

/**
 * 模型微调（qq_affinity_shift 的全部规则都在这里，桥接只负责把两个布尔传进来）。
 * 拒绝时**一个字段都不改**，调用方据此决定要不要 saveStore。
 */
export function shiftByModel(store, {
  userId, delta, reason = '', now = Date.now(), rules: rulesIn,
  askedThisTurn = false, hadInboundThisTurn = false, scope = ''
} = {}) {
  const rules = normalizeRules(rulesIn);
  if (!rules.enabled) return { ok: false, code: 'disabled', message: '好感度功能关着（config.socialV2.affinity.enabled=false）' };
  const d = Number(delta);
  if (!Number.isInteger(d)) return { ok: false, code: 'bad_delta', message: 'delta 必须是整数（-3 ~ +3）' };
  if (Math.abs(d) > rules.modelDeltaMax) return { ok: false, code: 'bad_delta', message: `delta 超出范围：|${d}| > ${rules.modelDeltaMax}` };
  if (!String(reason ?? '').trim()) return { ok: false, code: 'bad_reason', message: 'reason 必填（≤40 字），要写清为什么改' };
  if ([...String(reason)].length > 40) return { ok: false, code: 'bad_reason', message: 'reason 太长（≤40 字）' };
  if (askedThisTurn) return { ok: false, code: 'asked_this_turn', message: '这一轮正在被问好感度，不许改分（会被当成当场讨好）' };
  if (!hadInboundThisTurn) return { ok: false, code: 'no_inbound', message: '这一轮这个人没说过话，不能凭印象改分' };

  const person = ensurePerson(store, userId, now, rules);
  settleDay(person, now, rules); // 跨天先结算，否则日累计永远不清零
  if (person.lastModelAt && Number(now) - person.lastModelAt < rules.settleCooldownMs) {
    const waitMin = Math.ceil((rules.settleCooldownMs - (now - person.lastModelAt)) / 60000);
    return { ok: false, code: 'cooldown', message: `10 分钟内只能改一次，还要等约 ${waitMin} 分钟` };
  }
  if (Math.abs(person.dayModelDelta) + Math.abs(d) > rules.modelDailyMax) {
    return { ok: false, code: 'daily_limit', message: `今天的模型调分已用 ${Math.abs(person.dayModelDelta)}/${rules.modelDailyMax}，这次会超` };
  }

  person.modelDelta = round2(clampScore(person.base + person.modelDelta + d) - person.base);
  person.dayModelDelta = round2(person.dayModelDelta + Math.abs(d));
  person.lastModelAt = Number(now) || Date.now();
  person.updatedAt = Number(now) || Date.now();
  pushReason(person, { ts: now, by: 'model', delta: d, why: String(reason).trim().slice(0, 40), scope });
  recomputeScore(person);
  return { ok: true, code: 'ok', score: person.score, base: person.base, modelDelta: person.modelDelta, message: `已调到 ${person.score}/100` };
}

export function progressToScore(person) {
  const base = num(person?.base, 0);
  const modelDelta = num(person?.modelDelta, 0);
  return { score: clampScore(Math.round(base + modelDelta)), base: round2(base), modelDelta: round2(modelDelta) };
}

/**
 * 控制台名单（规格 §7，P2）：只给**管理端**看的只读快照。
 * 不返回分数字段以外的隐私内容；reasons 只取最近 2 条，且不含 scope 里的群号（避免把别的群带进列表）。
 * 排序按「最近出现」倒序，方便管理员看活跃的人；limit 上限 200 防一次拉全库。
 */
export function listForConsole(store, { limit = 50 } = {}) {
  const cap = Math.min(200, Math.max(1, Number(limit) || 50));
  return Object.values(store?.people && typeof store.people === 'object' ? store.people : {})
    .filter((p) => p && p.userId)
    .map((p) => {
      const { score, base, modelDelta } = progressToScore(p);
      return {
        userId: String(p.userId),
        name: String(p.name || ''),
        score, base, modelDelta,
        lastSeenAt: Number(p.counters?.lastSeenAt) || 0,
        reasons: (Array.isArray(p.reasons) ? p.reasons : []).slice(-2).reverse()
          .map((r) => ({ at: num(r?.ts, 0), by: String(r?.by || ''), delta: round2(r?.delta), why: String(r?.why ?? '') }))
      };
    })
    .sort((a, b) => (b.lastSeenAt - a.lastSeenAt) || (b.score - a.score))
    .slice(0, cap);
}

const REASON_TRIM = 300;

/** 单行化 + 截断 + 去掉结尾标点（后面还要自己补「。」，避免出现「。。」）。 */
function oneLine(v, max) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().replace(/[。．，,；;、\s]+$/u, '').slice(0, max);
}

/**
 * 被问那一轮注入的片段（≤300 字）：分数 + 1~2 条具体理由 + 明确禁令。
 *
 * opts.nickname：群名片/昵称。用户直报「一个 QQ 号没有温度」，所以优先显示名字，
 *   取不到名字才退回号码（不显示成 `小明(100000006)`，号码对群友是噪音）。
 * opts.memories：memory_event / memberImpression 里的一两件具体事（如「一起斗过图」），
 *   有就优先于计数器（「被 @ +0.5」这种描述用户看不懂也不关心）。
 */
export function describeForPrompt(person, rulesIn, opts = {}) {
  const rules = normalizeRules(rulesIn);
  const p = person || { userId: '', name: '', base: rules.start, modelDelta: 0, reasons: [] };
  const nickname = oneLine(opts.nickname ?? p.name, 24);
  const who = nickname || String(p.userId || '对方');
  const { score, base, modelDelta } = progressToScore(p);
  const picks = (Array.isArray(p.reasons) ? p.reasons : []).slice(-Math.max(1, rules.showReasons)).reverse();
  const sign = (n) => (n > 0 ? `+${round2(n)}` : `${round2(n)}`);
  const memories = (Array.isArray(opts.memories) ? opts.memories : [])
    .map((m) => oneLine(m, 36)).filter(Boolean).filter((m, i, arr) => arr.indexOf(m) === i).slice(0, 2);
  const why = memories.length
    ? `印象里：${memories.map((m, i) => `${'①②'[i]} ${m}`).join(' ')}`
    : (picks.length
      ? `最近依据：${picks.map((r, i) => `${'①②③④⑤'[i] || `(${i + 1})`} ${r.why || '（没写原因）'}（${sign(r.delta)}）`).join('')}`
      : '最近依据：（还没有具体依据，老实说刚认识、从 50 分起步）');
  let text = `【好感度】你对 ${who} 当前 ${score}/100（底分 ${base} + 印象 ${modelDelta}）。${why}。`
    + '要求：按角色口吻报这个分数 + 挑 1~2 条具体理由；本轮不得调用 qq_affinity_shift；分数就在上面，不要自己另编一个数字。';
  if ([...text].length > REASON_TRIM) text = `${[...text].slice(0, REASON_TRIM - 1).join('')}…`;
  return text;
}

/** 隐私边界：只能报对方自己的分；第三人婉拒；管理员 private 询问是唯一例外。 */
export function privacyLine(rulesIn) {
  const rules = normalizeRules(rulesIn);
  const owner = rules.ownerCanQueryAll
    ? '只有管理员在私聊里问「所有人的分数」时可以答。'
    : '任何人都不能替别人查分（管理员也不行）。';
  return `【好感度隐私】你只能报对方自己的分数。被问第三人（「你对 XX 多少分」）时用角色口吻婉拒，可以给态度不给数字（例如「这是我和她之间的事」）。${owner}`;
}

/** 清理长期无互动的人（默认 180 天）。返回 { removed: [userId...] }。 */
export function prunePeople(store, now = Date.now(), { maxIdleDays } = {}) {
  const days = num(maxIdleDays, DEFAULT_RULES.evidence.maxIdleDays, { min: 1 });
  const removed = [];
  for (const [id, p] of Object.entries(store.people || {})) {
    const last = Math.max(Number(p?.counters?.lastSeenAt) || 0, Number(p?.updatedAt) || 0);
    if (!last || Number(now) - last > days * DAY_MS) { delete store.people[id]; removed.push(id); }
  }
  return { removed };
}

// ── 序列化 / 持久化（唯一碰磁盘的部分） ──────────────────────────────────────

export function serialize(store) {
  const people = {};
  for (const id of Object.keys(store.people || {}).sort()) people[id] = store.people[id];
  return JSON.stringify({ version: 1, rulesVer: Number(store.rulesVer) || AFFINITY_RULES_VER, people }, null, 2);
}

/** 坏 JSON / 坏条目容错：永远返回合法 store，好的条目一个不丢。 */
export function parseStore(text) {
  const store = emptyStore();
  let raw;
  try {
    raw = JSON.parse(String(text ?? '').replace(/^\uFEFF/, ''));
  } catch {
    return { ...store, corrupted: true };
  }
  if (!raw || typeof raw !== 'object' || !raw.people || typeof raw.people !== 'object' || Array.isArray(raw.people)) {
    return { ...store, corrupted: true };
  }
  const now = Date.now();
  const rules = normalizeRules(raw.rules);
  for (const [id, p] of Object.entries(raw.people)) {
    if (!id || !p || typeof p !== 'object' || Array.isArray(p)) continue;
    if (!Number.isFinite(Number(p.base)) && !Number.isFinite(Number(p.score))) continue; // 两条主字段都没有 → 丢掉
    store.people[id] = normalizePerson(p, id, now, rules);
  }
  store.rulesVer = num(raw.rulesVer, 0);
  return store;
}

/**
 * 读库：不存在 → 空库；rulesVer 不一致 → 按新规则重算并把旧 reasons 清空
 * （旧理由可能引用了已废弃的规则，留着会自相矛盾）；顺带清理 180 天没动静的人。
 */
export function loadStore(file, now = Date.now(), { rules } = {}) {
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return { ...emptyStore(), missing: true };
    throw new Error(`好感度库读不了（${file}）：${error?.message ?? error}`);
  }
  const store = parseStore(text);
  const r = normalizeRules(rules);
  if (Number(store.rulesVer) !== AFFINITY_RULES_VER) {
    for (const p of Object.values(store.people)) {
      p.reasons = [];
      p.score = clampScore(Math.round(p.base + p.modelDelta));
    }
    store.rulesVer = AFFINITY_RULES_VER;
    store.migratedAt = Number(now) || Date.now();
  }
  prunePeople(store, now, { maxIdleDays: r.evidence.maxIdleDays });
  return store;
}

/** 原子写：同目录 tmp + fsync + rename；失败清掉自己的 tmp，绝不留下半截文件。 */
export function saveStore(file, store) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const body = serialize(store);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeFileSync(fd, body, 'utf8');
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    return Buffer.byteLength(body, 'utf8');
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error(`好感度库写入失败（${file}）：${error?.message ?? error}`);
  }
}
