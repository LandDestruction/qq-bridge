// 记忆层的纯逻辑：跨会话印象合并、共享事件检索与注入、修剪。
//
// 为什么要单独成文件：这些判定全是边界（印象合并去重、事件过期/条数上限、
// 注入预算 700 字怎么截、相关性怎么打分），挂在 bridge 闭包里就没法单测。
//
// 三层设计（对应方案截图）：
//   第一层 印象：per-session memberImpressions → 顶层 globalImpressions（群聊/私聊共享）
//   第二层 事件：sharedEvents（上限 500 条 / 90 天），scope = global | group:xxx
//   第三层 交接：retireSession 前的脉络摘要（这里提供 buildHandoffDigest）

export const IMPRESSION_MAX_NAMES = 200;
export const IMPRESSION_MAX_TRAITS = 20;
export const EVENT_MAX_COUNT = 500;
export const EVENT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const EVENT_MAX_TEXT = 200;
export const INJECT_LIMIT = 6;
export const INJECT_BUDGET_CHARS = 700;

function safeName(name) {
  const n = String(name ?? '').trim().slice(0, 64);
  if (!n) return '';
  if (['__proto__', 'constructor', 'prototype'].includes(n)) return '';
  return n;
}

function splitTraits(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，、;；]/);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const t = String(item ?? '').trim().slice(0, 40);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= IMPRESSION_MAX_TRAITS) break;
  }
  return out;
}

/**
 * 合并一条印象到全局表（就地修改并返回该条目）。
 * 合并规则：traits 取并集、interactionCount 相加、lastSeenAt 取最新。
 */
export function mergeImpression(global, name, patch = {}) {
  const key = safeName(name);
  if (!key) return null;
  const table = global && typeof global === 'object' ? global : {};
  const prev = table[key] && typeof table[key] === 'object' ? table[key] : { traits: [], interactionCount: 0, lastSeenAt: 0 };
  const traits = splitTraits([...(Array.isArray(prev.traits) ? prev.traits : []), ...splitTraits(patch.traits)]);
  const entry = {
    traits,
    interactionCount: Math.max(0, Number(prev.interactionCount) || 0) + Math.max(0, Number(patch.interactionCount) || 0),
    lastSeenAt: Math.max(Number(prev.lastSeenAt) || 0, Number(patch.lastSeenAt) || 0, Number(patch.at) || 0)
  };
  table[key] = entry;
  // 上限：按 lastSeenAt 淘汰最久没见的，防止状态文件无限膨胀
  const names = Object.keys(table);
  if (names.length > IMPRESSION_MAX_NAMES) {
    names.sort((a, b) => (Number(table[a]?.lastSeenAt) || 0) - (Number(table[b]?.lastSeenAt) || 0));
    for (const n of names.slice(0, names.length - IMPRESSION_MAX_NAMES)) delete table[n];
  }
  return entry;
}

/**
 * memory-update 路由的「编辑一条已有印象」逻辑（就地修改并返回结果）。
 *
 * 为什么单独抽出来：原实现把这段写在 bridge.js 的路由闭包里，还误用了另一个路由
 * 才有的 `extra` 变量（ReferenceError → 500 → 内存改了但没落盘，印象表和
 * state/socialV2.json 直接分叉）。抽成纯函数后「改名 / 就地更新 / 拒绝」三条
 * 路径都能离线断言。
 *
 * @param {object} impressions 会话级 memberImpressions（就地修改）
 * @param {object} opts
 * @param {string} opts.oldTarget 要编辑的原群友名字
 * @param {string} [opts.newTarget] 新名字（不传=就地更新；传了且不同=改名）
 * @param {string[]|string} [opts.traits] 新的印象标签（覆盖）
 * @param {number} [opts.interactionCount] 新的互动次数（覆盖）
 * @param {number} [opts.maxNames] 条目上限，超出按 lastSeenAt 淘汰
 * @returns {{ok: true, target: string, renamed: boolean, entry: object} | {ok: false, status: number, error: string}}
 */
export function applyImpressionEdit(impressions, { oldTarget, newTarget, traits, interactionCount, maxNames = IMPRESSION_MAX_NAMES } = {}) {
  const table = impressions && typeof impressions === 'object' ? impressions : null;
  if (!table) return { ok: false, status: 400, error: '印象表不可用' };
  const from = safeName(oldTarget);
  if (!from) return { ok: false, status: 400, error: '非法的群友名字' };
  const to = newTarget === undefined || newTarget === null || String(newTarget).trim() === '' ? from : safeName(newTarget);
  if (!to) return { ok: false, status: 400, error: '非法的群友名字' };
  // 必须命中**已有**条目（own property）：否则任意名字都能凭空建一条，
  // 而 'toString'/'valueOf' 这类名字会从 Object.prototype 上取到继承来的函数，
  // 往函数对象上写 traits —— JSON.stringify 又会把它整个丢掉（静默数据丢失）。
  if (!Object.prototype.hasOwnProperty.call(table, from)) {
    return { ok: false, status: 404, error: '找不到要编辑的群友印象（新印象请用 qq_memory_append 添加）' };
  }
  const prev = table[from] && typeof table[from] === 'object' ? table[from] : {};
  const entry = { ...prev };
  if (traits !== undefined && traits !== null) entry.traits = splitTraits(traits);
  if (interactionCount !== undefined && interactionCount !== null) entry.interactionCount = Math.max(0, Number(interactionCount) || 0);
  const renamed = to !== from;
  if (renamed) delete table[from];
  table[to] = entry;
  // 与控制台/AI 的 append 路径保持一致：条目数上限，超了按 lastSeenAt 淘汰最旧，
  // 否则 memory-update 能无限塞名字（状态文件与每轮 prompt 一起膨胀）。
  const names = Object.keys(table);
  const cap = Math.max(1, Number(maxNames) || IMPRESSION_MAX_NAMES);
  if (names.length > cap) {
    names.sort((a, b) => (Number(table[a]?.lastSeenAt) || 0) - (Number(table[b]?.lastSeenAt) || 0));
    for (const n of names.slice(0, names.length - cap)) delete table[n];
  }
  return { ok: true, target: to, renamed, entry };
}

/** 从「每会话一份」的印象表迁移到全局表（幂等，重复跑结果一样）。 */
export function migrateImpressions(conversations, global) {
  const table = global && typeof global === 'object' ? global : {};
  let moved = 0;
  const iter = conversations instanceof Map ? conversations.entries() : Object.entries(conversations || {});
  for (const [, st] of iter) {
    const impressions = st?.memberImpressions;
    if (!impressions || typeof impressions !== 'object') continue;
    for (const [name, im] of Object.entries(impressions)) {
      if (!im || typeof im !== 'object') continue;
      const before = table[name]?.interactionCount ?? 0;
      mergeImpression(table, name, {
        traits: im.traits,
        interactionCount: Number(im.interactionCount) || 0,
        lastSeenAt: Number(im.lastSeenAt) || 0
      });
      if ((table[name]?.interactionCount ?? 0) !== before) moved += 1;
    }
  }
  return { global: table, moved };
}

/**
 * 新增一条共享事件。
 * scope: 'global' 表示所有会话可见；'group:123' 只在该群（及该群发起的私聊）可见。
 */
export function addSharedEvent(events, { text, scope = 'global', by = '', key = '', at = Date.now(), id = '' } = {}) {
  const body = String(text ?? '').trim().slice(0, EVENT_MAX_TEXT);
  if (!body) return null;
  const list = Array.isArray(events) ? events : [];
  const event = {
    id: String(id || `e${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`),
    at: Number(at) || Date.now(),
    text: body,
    scope: String(scope || 'global') === 'global' ? 'global' : String(scope),
    by: String(by ?? '').slice(0, 64),
    key: String(key ?? '').slice(0, 64)
  };
  list.push(event);
  pruneEvents(list);
  return event;
}

/** 修剪：超 90 天或超 500 条就丢最旧的（就地）。 */
export function pruneEvents(events, { now = Date.now(), maxAgeMs = EVENT_MAX_AGE_MS, maxCount = EVENT_MAX_COUNT } = {}) {
  const list = Array.isArray(events) ? events : [];
  const cutoff = now - maxAgeMs;
  let i = 0;
  while (i < list.length && (Number(list[i]?.at) || 0) < cutoff) i += 1;
  if (i > 0) list.splice(0, i);
  if (list.length > maxCount) list.splice(0, list.length - maxCount);
  return list;
}

/**
 * 相关性打分：本场事件 +3、同群发起的 +2、global +1；越新越高；同一条最多 4 分。
 * 这里只管排序用的相对分，不是归一化概率。
 */
export function scoreEvent(event, { key = '', now = Date.now() } = {}) {
  if (!event || !event.text) return 0;
  const scope = String(event.scope || 'global');
  let score = 1;
  if (scope === 'global') score = 1;
  else if (scope === key) score = 3;
  else if (key.startsWith('private:') && scope.startsWith('group:')) score = 2;
  else if (scope.startsWith('group:') && key.startsWith('group:') && scope !== key) score = 0; // 别的群的事件不外泄
  else score = 0;
  if (score === 0) return 0;
  const ageMin = Math.max(0, (now - (Number(event.at) || now)) / 60000);
  if (ageMin <= 60) score += 2;
  else if (ageMin <= 24 * 60) score += 1;
  return score;
}

/**
 * 选出要注入的事件并拼成文本。
 * @returns {{ text: string, picked: object[] }}
 */
export function selectEventsForInjection(events, { key = '', now = Date.now(), limit = INJECT_LIMIT, budgetChars = INJECT_BUDGET_CHARS } = {}) {
  const scored = (Array.isArray(events) ? events : [])
    .map((e) => ({ e, score: scoreEvent(e, { key, now }) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => (b.score - a.score) || ((Number(b.e.at) || 0) - (Number(a.e.at) || 0)))
    .slice(0, limit);
  const picked = [];
  const lines = [];
  let used = 0;
  for (const { e } of scored) {
    const when = new Date(Number(e.at) || now).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const who = e.by ? `${e.by}：` : '';
    const line = `- ${when} ${who}${e.text}`;
    if (used + line.length > budgetChars) break;
    picked.push(e);
    lines.push(line);
    used += line.length;
  }
  return { text: lines.length ? `【近期共同经历】\n${lines.join('\n')}\n\n` : '', picked };
}

/** 全局印象段（注入用，和事件共用预算时由调用方自己截）。 */
export function formatGlobalImpressions(global, { limit = 15, now = Date.now() } = {}) {
  const table = global && typeof global === 'object' ? global : {};
  const names = Object.keys(table)
    .sort((a, b) => (Number(table[b]?.lastSeenAt) || 0) - (Number(table[a]?.lastSeenAt) || 0))
    .slice(0, limit);
  if (!names.length) return '';
  const lines = names.map((name) => {
    const im = table[name] || {};
    const traits = Array.isArray(im.traits) && im.traits.length ? im.traits.join('、') : '暂无记录';
    const days = im.lastSeenAt ? Math.max(0, Math.round((now - Number(im.lastSeenAt)) / 86400000)) : null;
    return `- ${name}：${traits}（互动 ${Number(im.interactionCount) || 0} 次${days == null ? '' : `，${days} 天前`}）`;
  });
  return `【跨会话印象】\n${lines.join('\n')}\n`;
}

/**
 * 第三层：把最近若干条消息压成「带时间戳的脉络」，供 retireSession / reset 前保存。
 * 只保留「谁说了什么」的骨架，去掉空行与超长内容。
 */
export function buildHandoffDigest(messages, { maxChars = 1600, now = Date.now() } = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && String(m.text || m.plain || '').trim());
  const lines = [];
  let used = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    const t = String(m.text || m.plain || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const when = new Date(Number(m.time) || now).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const who = m.isSelf ? '我' : (m.sender || '群友');
    const line = `${when} ${who}：${t}`;
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}
