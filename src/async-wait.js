// 有限等待工具（纯逻辑，可离线测）。
// 用途：本轮有视频在抽帧/转写，prompt 组装前等它一小会儿（默认 20s），
// 超时就不等了 —— 既不让模型瞎猜「有没有声音」，也不把回复无限拖住。
export async function raceWithTimeout(promises, timeoutMs = 20000, { now = Date.now } = {}) {
  const list = (Array.isArray(promises) ? promises : []).filter((p) => p && typeof p.then === "function");
  if (!list.length) return { done: true, timedOut: false, waited: 0 };
  const started = now();
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), Math.max(0, Number(timeoutMs) || 0)); });
  try {
    const result = await Promise.race([Promise.allSettled(list).then(() => "done"), timeout]);
    return { done: result === "done", timedOut: result === "timeout", waited: now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 两段式任务：抽帧（快）与转写在时间上分开等待。
 * 调用方先 await frames（≤8s），再 await stt（≤stt.waitMs）。
 */
export function createStagedTask() {
  let resolveFrames; let resolveStt;
  const frames = new Promise((r) => { resolveFrames = r; });
  const stt = new Promise((r) => { resolveStt = r; });
  let framesDone = false; let sttDone = false;
  return {
    frames, stt,
    markFrames() { if (!framesDone) { framesDone = true; resolveFrames(); } },
    markStt() { if (!sttDone) { sttDone = true; resolveStt(); } },
    get framesDone() { return framesDone; },
    get sttDone() { return sttDone; }
  };
}
