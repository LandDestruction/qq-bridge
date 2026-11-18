// 「这一轮上下文里出现过图片/表情」的标记（纯函数 + Map 容器，方便单测）。
//
// 为什么需要它：reserved2 模式下图片**不是** prompt part —— 唤醒提示里只放一句
// 「本条消息包含 N 个图片/表情（消息ID=…），需要看就调 qq_get_message_images」，
// 真正的图是模型**调工具之后**才回来的。所以「这一轮要不要用视觉模型」不能靠
// 「图在不在 parts 里」判断，只能靠「这一轮上下文里出现过图」。
//
// 旧实现只看 socialV2 状态里最近 3 条 unread + 最近 2 条 recentMessages：
// 图稍微靠前一点（或 unread 已被 mark_read 清掉）就漏判，模型被选成
// workbuddy2api/deepseek-v4.1-flash —— DSH 会把工具结果里的图换成
// `[image unavailable: image/jpeg; model "deepseek-v4.1-flash" does not declare image input]`，
// 模型只能对群友说「图我看不见」。2026-10-26 22:15 group:100000001 真机就是这条。
//
// 这里只回答一个问题：**这个会话最近（TTL 内）有没有出现过图**。
// 不判断视觉能力（那在 bridge 的 modelSeesImages）、不读写磁盘。

/** 标记有效期：比一轮「唤醒 → 调工具 → 回话」长一个量级，又不会把昨天的图算进来。 */
// K3（2026-10-30）：10 分钟 → 2 分钟。带图窗口太长会让「这个会话之后所有回合」都强制走
// deepseek-account 视觉模型（用户侧看就是 WorkBuddy 用量对不上）。
// K4（2026-11-01）：2 分钟 → 5 分钟。2 分钟太短：用户常常「发图 → 隔一两分钟再追问」，
// 第二轮时窗口已过期、又被选回无视觉模型（私聊 19:18 那次就是这么丢的图）。5 分钟仍能避免整会话被锁在视觉模型上。
// 90 秒：只覆盖「图刚到位 + 紧邻一两轮」。以前 5 分钟会让一个热闹群的后续所有回合都锁在视觉模型上。
export const MEDIA_TURN_TTL_MS = 45 * 1000;
/** 运行期可覆盖的默认 TTL（启动时按 config.socialV2.mediaTurnTtlMs 设置）。 */
let defaultTtlMs = MEDIA_TURN_TTL_MS;
/** 启动时调用一次：把配置里的「带图强制视觉模型的窗口」传给纯函数（坏值忽略、夹 0~1h）。 */
export function setMediaTurnTtlDefault(ms) {
  const n = Number(ms);
  defaultTtlMs = Number.isFinite(n) && n >= 0 ? Math.min(3600000, Math.round(n)) : MEDIA_TURN_TTL_MS;
  return defaultTtlMs;
}
export function getMediaTurnTtlDefault() { return defaultTtlMs; }
/** 键上限：防止长跑进程里 Map 无限增长（超了丢最旧的）。 */
export const MEDIA_TURN_MAX_KEYS = 200;

/** 记一次「这一轮有图」。重复调用只刷新时间戳。 */
export function noteMediaTurn(map, key, atMs = Date.now(), { ttlMs = defaultTtlMs, maxKeys = MEDIA_TURN_MAX_KEYS } = {}) {
  if (!map || !key) return false;
  map.set(String(key), Number(atMs) || Date.now());
  // 顺手清过期：条目很少，O(n) 无所谓，但别无限长。
  for (const [k, t] of map) {
    if (!(Number(t) > 0) || atMs - Number(t) > ttlMs) map.delete(k);
  }
  while (map.size > maxKeys) {
    let oldestKey = null; let oldestAt = Infinity;
    for (const [k, t] of map) if (Number(t) < oldestAt) { oldestAt = Number(t); oldestKey = k; }
    if (oldestKey === null) break;
    map.delete(oldestKey);
  }
  return true;
}

/** 这个会话 TTL 内有没有出现过图（过期条目视为没有）。 */
/** 立刻清掉某个会话的「有图」标记（一轮制：图那一轮结束后马上切回普通模型）。 */
export function clearMediaTurn(map, key) {
  if (!map || !key) return false;
  return map.delete(String(key));
}

export function isFreshMediaTurn(map, key, atMs = Date.now(), { ttlMs = defaultTtlMs } = {}) {
  if (!map || !key) return false;
  const t = Number(map.get(String(key)) || 0);
  if (!(t > 0)) return false;
  const age = Number(atMs) - t;
  if (age < 0 || age > ttlMs) { map.delete(String(key)); return false; }
  return true;
}

/**
 * 单看一个时间戳是否还在有效期内。
 *
 * 为什么要有这个：Map 只在进程内存里，**重启就清空**。2026-10-26 23:39 那次重启后
 * 2 分钟（23:42）就复现了「看不见图」——图片 23:41 到过、内存标记随旧进程没了，
 * 选型退回空闲模型，模型再调取图工具时 DSH 只能回
 * `[image unavailable: … does not declare image input]`。所以「这个群最近出现过图」
 * 必须落进会话状态（`socialV2.conversations[key].lastMediaAt`），重启后照样认。
 */
export function isFreshMediaAt(ts, atMs = Date.now(), { ttlMs = defaultTtlMs } = {}) {
  const t = Number(ts) || 0;
  if (!(t > 0)) return false;
  const age = Number(atMs) - t;
  return age >= 0 && age <= ttlMs;
}
