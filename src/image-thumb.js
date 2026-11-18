// 缩略图服务端缩放（ffmpeg 单帧；失败回原图）。纯逻辑 + 可注入 spawn，便于离线测。
import { spawn } from "node:child_process";

export const THUMB_W_DEFAULT = 480;
export const THUMB_W_MIN = 64;
export const THUMB_W_MAX = 1024;

/** w 参数规范化：非数字/越界 → 默认 480；<=0 → null（表示不缩放）。 */
export function normalizeThumbWidth(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return THUMB_W_DEFAULT;
  return Math.min(THUMB_W_MAX, Math.max(THUMB_W_MIN, Math.round(n)));
}

/**
 * 缩放图片。成功返回 JPEG Buffer；ffmpeg 不可用/失败/超时返回 null（调用方回原图）。
 */
export function scaleImageBuffer(buf, width, { timeoutMs = 5000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    if (!buf || !buf.length || !width) return resolve(null);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = spawnImpl("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", `scale=${width}:-2`, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch { return done(null); }
    const chunks = [];
    const timer = setTimeout(() => { try { child.kill(); } catch {} done(null); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); done(null); });
    child.stdout?.on("data", (c) => chunks.push(c));
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      done(code === 0 && out.length > 3 && out[0] === 0xff && out[1] === 0xd8 ? out : null);
    });
    try { child.stdin?.end(buf); } catch { done(null); }
  });
}
