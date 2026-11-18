// 媒体处理的全局并发闸门（视频分析这类重活）。
//
// 为什么需要：视频分析已经改成异步 spawn，但**没有并发上限** —— 白名单里几个群同时来
// 视频，就会同时起 N 个 ffmpeg（每个还要各占 Buffer）。轻则 CPU 打满、消息延迟飙升，
// 重则内存峰值把进程顶掉。
//
// 语义：
//   · 全局上限（默认 2，夹在 1~4），不是每会话一个 —— 抢的是同一份 CPU/内存；
//   · 超出排队，FIFO；
//   · **排队有超时**：等到超时就放弃并如实报错，别让人等到天荒地老；
//   · 拿到槽位后无论成功/失败都在 finally 里释放（这条最容易漏）；
//   · stats() 给出「排队中 / 执行中」，便于事后判断是不是卡住了。

export const MEDIA_MAX_CONCURRENT_DEFAULT = 2;
export const MEDIA_QUEUE_TIMEOUT_MS_DEFAULT = 60000;

/** 配置规范化：上限夹在 1~4，排队超时夹在 1s~10min。 */
export function mediaQueueCfg(src = {}) {
  const rawMax = Number(src?.maxConcurrent);
  const max = Number.isFinite(rawMax) && rawMax >= 1 ? Math.min(4, Math.round(rawMax)) : MEDIA_MAX_CONCURRENT_DEFAULT;
  const rawTo = Number(src?.queueTimeoutMs);
  const queueTimeoutMs = Number.isFinite(rawTo) && rawTo > 0
    ? Math.min(600000, Math.max(1000, Math.round(rawTo)))
    : MEDIA_QUEUE_TIMEOUT_MS_DEFAULT;
  return { maxConcurrent: max, queueTimeoutMs };
}

/**
 * 建一个信号量。run(fn) 返回 fn 的结果；排队超时抛错（错误上带 code='MEDIA_QUEUE_TIMEOUT'）。
 * @param {{ maxConcurrent?: number, queueTimeoutMs?: number, onLog?: Function }} opts
 */
export function createMediaQueue({ maxConcurrent, queueTimeoutMs, onLog } = {}) {
  const cfg = mediaQueueCfg({ maxConcurrent, queueTimeoutMs });
  const log = typeof onLog === 'function' ? onLog : () => {};
  let running = 0;
  const waiters = []; // { resolve, reject, timer, enqueuedAt }
  let peak = 0;

  const pump = () => {
    while (running < cfg.maxConcurrent && waiters.length) {
      const w = waiters.shift();
      if (w.timer) clearTimeout(w.timer);
      running += 1;
      peak = Math.max(peak, running);
      w.resolve(() => {           // 释放句柄：重复调用无效
        if (w.released) return;
        w.released = true;
        running = Math.max(0, running - 1);
        log(`[media] 释放槽位（执行中 ${running} / 排队 ${waiters.length}）`);
        pump();
      });
    }
  };

  const acquire = () => {
    if (running < cfg.maxConcurrent) {
      running += 1;
      peak = Math.max(peak, running);
      return Promise.resolve(() => {
        running = Math.max(0, running - 1);
        pump();
      });
    }
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null, enqueuedAt: Date.now(), released: false };
      w.timer = setTimeout(() => {
        const idx = waiters.indexOf(w);
        if (idx >= 0) waiters.splice(idx, 1);
        const err = new Error(`媒体处理排队超时（${Math.round(cfg.queueTimeoutMs / 1000)}s 内没轮上，当前执行中 ${running} 个）`);
        err.code = 'MEDIA_QUEUE_TIMEOUT';
        reject(err);
      }, cfg.queueTimeoutMs);
      waiters.push(w);
      log(`[media] 进入排队（执行中 ${running} / 排队 ${waiters.length}）`);
    });
  };

  /**
   * 排队执行 fn。fn 拿到后无论成功/失败都释放槽位。
   * @returns {Promise<any>}
   */
  async function run(fn) {
    const release = await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  function stats() {
    return { running, queued: waiters.length, peak, ...cfg };
  }

  return { run, stats, cfg };
}
