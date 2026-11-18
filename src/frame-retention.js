// video-frames 保留策略（纯函数，便于离线断言）。
//
// 背景：每个视频产一张合成帧（约 1.1MB PNG）挂到消息上，全库**没有任何清理** ——
// 每天 10 条视频就是 10MB/天、300MB/月，且永不消失。storage-stats 接口上线第一次调用就看到它。
//
// 安全边界：帧在被发送前是活的（msg.media.localFile 指向它），所以**只按年龄删**，
// 且年龄门槛必须大于发送重试窗口（取「重试窗口 × 2」且不小于 1 天）。
// 总量超限时同样从最老的开始删。

export const FRAME_RETENTION_DAYS_DEFAULT = 7;
export const FRAME_MAX_TOTAL_BYTES_DEFAULT = 100 * 1024 * 1024;
export const FRAME_MIN_AGE_MS = 24 * 3600 * 1000; // 任何情况下不删 1 天内的帧

/** 配置规范化：天数/总量非法值回落默认，年龄门槛夹到 ≥1 天。 */
export function frameRetentionCfg(src = {}) {
  const days = Number(src?.frameRetentionDays);
  const maxBytes = Number(src?.frameMaxTotalBytes);
  return {
    retentionDays: Number.isFinite(days) && days > 0 ? Math.max(1, days) : FRAME_RETENTION_DAYS_DEFAULT,
    maxTotalBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : FRAME_MAX_TOTAL_BYTES_DEFAULT
  };
}

/**
 * 算出该删哪些文件。
 * @param {Array<{name:string, bytes:number, mtimeMs:number}>} files
 * @param {{ now?: number, retentionDays?: number, maxTotalBytes?: number }} opts
 * @returns {{ drop: string[], keepBytes: number }}
 */
export function planFrameDeletions(files, { now = Date.now(), retentionDays, maxTotalBytes } = {}) {
  const cfg = frameRetentionCfg({ frameRetentionDays: retentionDays, frameMaxTotalBytes: maxTotalBytes });
  const cutoff = Number(now) - cfg.retentionDays * 24 * 3600 * 1000;
  const minCutoff = Number(now) - FRAME_MIN_AGE_MS;
  const safeCutoff = Math.min(cutoff, minCutoff); // 至少 1 天，防「重试窗口内被删」
  const list = (Array.isArray(files) ? files : [])
    .filter((f) => f && typeof f.name === 'string')
    .map((f) => ({ name: f.name, bytes: Number(f.bytes) || 0, mtimeMs: Number(f.mtimeMs) || 0 }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  const drop = [];
  const kept = [];
  for (const f of list) {
    if (f.mtimeMs < safeCutoff) drop.push(f.name);   // ① 按年龄
    else kept.push(f);
  }
  // ② 按总量：从最老删到低于阈值
  let total = kept.reduce((n, f) => n + f.bytes, 0);
  for (const f of kept) {
    if (total <= cfg.maxTotalBytes) break;
    drop.push(f.name);
    total -= f.bytes;
  }
  return { drop, keepBytes: total };
}
