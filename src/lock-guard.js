// 单实例锁的判定逻辑（纯函数）。
//
// 为什么单独成文件：`acquireLock()` 里混着 fs 写入、`process.kill`、netstat 探测和 `process.exit`，
// 没法单测；但真正的判断只有几行，而且每条分支都对应一次真实的「起不来」事故：
//   · PID 已被系统回收 → `kill(pid, 0)` 可能成功（占号的是别的程序），不能据此认定桥接还活着；
//   · PID 活着但僵死（不再监听端口）→ 旧逻辑要求人工删锁文件；
//   · PID 活着、端口也还被占着，但日志早就停了 → 这就是那次「离线事故」的形态（进程僵死仍持有监听套接字）。
// 抽出来之后，`scripts/test-lock-guard.mjs` 可以逐条覆盖，不必真的造一个僵死进程。

export const DEFAULT_STALE_LOG_MINUTES = 10;
export const MIN_STALE_LOG_MINUTES = 1;
export const MAX_STALE_LOG_MINUTES = 1440;

/** 「日志多久没更新算僵死」的窗口（分钟 → 毫秒）。非法值回落默认 10 分钟，夹在 [1, 1440]。 */
export function staleLogMs(configuredMinutes) {
  const n = Number(configuredMinutes);
  const minutes = Number.isFinite(n) && n > 0
    ? Math.min(MAX_STALE_LOG_MINUTES, Math.max(MIN_STALE_LOG_MINUTES, Math.round(n)))
    : DEFAULT_STALE_LOG_MINUTES;
  return minutes * 60 * 1000;
}

/**
 * 解析锁文件内容。
 * 空文件、非数字、非正整数一律视为「过期锁」（只有旧版本/被写坏才会出现）。
 * @returns {number | null} 合法 PID，或 null（= 过期）
 */
export function parseLockPid(content) {
  const text = String(content ?? '').trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) return null;
  const pid = Number(text);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * 锁判定：要不要接管？
 * @param {object} state
 * @param {boolean} state.pidAlive  锁里的 PID 是否有进程活着（kill(pid,0) 未抛 ESRCH）
 * @param {boolean} state.portInUse 控制台端口是否已被占用
 * @param {number} state.logIdleMs   bridge.log 距今多久没更新（文件不存在传 Infinity）
 * @param {number} state.staleLogMs  日志静止多久算僵死
 * @param {boolean | null} [state.responsive] 控制台 HTTP 是否还应答：
 *   true = 活的（哪怕日志静止也只是安静）；false = 不应答；null/undefined = 探测不出来（不确定）。
 * @returns {{ action: 'takeover' | 'suspect-hung' | 'running', reason: string }}
 */
export function decideLock({ pidAlive, portInUse, logIdleMs, staleLogMs: windowMs, responsive }) {
  if (!pidAlive) return { action: 'takeover', reason: 'pid-gone' };
  // 有应答就是活的——这条要排在端口判断**之前**：实测 netstat 会把某些监听套接字报成 CLOSED，
  // 只信端口探测会把一个正在正常服务的实例判成「端口空闲」然后删锁接管。
  if (responsive === true) return { action: 'running', reason: 'responsive' };
  if (!portInUse) return { action: 'takeover', reason: 'port-free' };
  const idle = Number.isFinite(logIdleMs) ? logIdleMs : Number.POSITIVE_INFINITY;
  // 只有「端口被占 + 明确探测到不应答 + 日志静止」三条同时成立，才敢判定僵死。
  if (responsive === false && idle >= windowMs) return { action: 'suspect-hung', reason: 'log-idle' };
  // 探测不出来（curl 缺失，或非超时的执行错误）：保守放行，宁可要求人工处理也不误杀。
  if (responsive === false) return { action: 'running', reason: 'log-fresh' };
  return { action: 'running', reason: 'unverified' };
}
