// 相对时间（D48）：把「某条记忆/某句发言是什么时候的」说成人话。
//
// 为什么必须单独一个纯函数：
//   · 跨群记忆以前只有「整块摘要的生成时间」，模型分不清「3 小时前说的」和「昨天说的」，
//     会把没时间的片段当成刚发生（用户真机直报：「记忆是一段段蹦出来的，没有时间线」）。
//   · 时间措辞必须可单测（跨天/缺时间/时钟偏差），不能散落在拼接模板里。
//
// 规则（本地时区，按**日历天**判断跨天，不用「24 小时」近似）：
//   <5 分钟 → 刚刚；<1 小时 → N 分钟前；同一天 → N 小时前；
//   昨天/前天/3~30 天前/上个月/更早。
// 没有时间（0/非法/缺失）→ 返回空串，调用方必须说「记不清」，**不许编一个时间**。
export function relativeTimeLabel(at, now = Date.now()) {
  const t = Number(at);
  const n = Number(now);
  if (!Number.isFinite(t) || t <= 0) return '';
  if (!Number.isFinite(n) || n <= 0) return '';
  // 时钟偏差（未来时间）：不编「负几分钟前」，按刚刚处理。
  const diff = Math.max(0, n - t);
  if (diff < 5 * 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / 60000))} 分钟前`;
  const days = calendarDayDiff(t, n);
  if (days === 0) return `${Math.max(1, Math.floor(diff / 3600000))} 小时前`;
  if (days === 1) return '昨天';
  if (days === 2) return '前天';
  if (days <= 30) return `${days} 天前`;
  if (days <= 60) return '上个月';
  return '更早';
}

/** 本地时区下相隔几个「日历天」（0=同一天，1=昨天）。 */
export function calendarDayDiff(earlier, later) {
  const a = new Date(Number(earlier));
  const b = new Date(Number(later));
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return Infinity;
  const dayA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const dayB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.max(0, Math.round((dayB - dayA) / 86400000));
}

export default { relativeTimeLabel, calendarDayDiff };
