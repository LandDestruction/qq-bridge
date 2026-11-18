// 私聊临时通行证：所有人可私聊，但每人每天有累计时长额度（默认 120 分钟）。
//
// 计时口径（可配置）：只统计「连续对话」里的真实时长——
//   · 两条消息间隔超过 idleCapMinutes（默认 10 分钟）视为离开，这段不计；
//   · 间隔内按实际时长累加。
// 这样「聊两小时」是实际对话两小时，而不是挂机两小时。
//
// 状态：state/private-quota.json
//   { "<uid>": { "date": "2026-10-24", "usedMs": 123456, "warned": false } }

export const DEFAULT_DAILY_MINUTES = 120;
export const DEFAULT_IDLE_CAP_MINUTES = 10;

/** 本地日期键（按机器时区），用于跨天重置。 */
export function dayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 累计一段对话时长。
 * @param {{ date?: string, usedMs?: number, lastAt?: number }} prev 昨天的/上次的状态
 * @param {number} now 本次消息时间戳（ms）
 * @param {{ idleCapMs: number }} opts
 * @returns {{ date: string, usedMs: number, lastAt: number, addedMs: number }}
 */
export function accrueUsage(prev, now, { idleCapMs }) {
  const today = dayKey(new Date(now));
  const sameDay = prev?.date === today;
  const usedMs = sameDay ? Number(prev?.usedMs) || 0 : 0;
  const lastAt = sameDay ? Number(prev?.lastAt) || 0 : 0;
  // 首次说话、或跨天、或隔了太久：这段间隔都不计入
  const gap = lastAt > 0 ? Math.max(0, now - lastAt) : 0;
  const addedMs = Math.min(gap, idleCapMs);
  return { date: today, usedMs: usedMs + addedMs, lastAt: now, addedMs };
}

/** 额度判定。 */
export function quotaState(usedMs, dailyMinutes = DEFAULT_DAILY_MINUTES) {
  const budgetMs = dailyMinutes * 60 * 1000;
  const leftMs = Math.max(0, budgetMs - usedMs);
  return { budgetMs, leftMs, exceeded: usedMs >= budgetMs, percent: Math.min(100, Math.round((usedMs / budgetMs) * 100)) };
}

/** 剩余时间的人类可读说法。 */
export function formatLeft(leftMs) {
  const min = Math.ceil(leftMs / 60000);
  if (min <= 0) return '今天没有额度了';
  if (min >= 60) return `今天还能聊 ${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
  return `今天还能聊 ${min} 分钟`;
}
