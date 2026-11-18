// 感知哈希（dHash）：对重编码/缩放不敏感，用来判断「是不是同一张表情」。
// 依赖已装的 ffmpeg：缩成 9x8 灰度原始帧 → 相邻像素比较 → 64 bit。
import { spawnSync, spawn } from "node:child_process";

function ffmpegPathFallback() {
  return "ffmpeg";
}

/** 用 ffmpeg 把任意图片/动图转成 9x8 灰度原始数据，算 dHash。 */
export function dhashFromBuffer(buf, { ffmpegPath = ffmpegPathFallback(), timeoutMs = 15000 } = {}) {
  if (!buf || !buf.length) return null;
  const r = spawnSync(ffmpegPath, [
    "-v", "error",
    "-i", "pipe:0",
    "-vf", "scale=9:8,format=gray",
    "-frames:v", "1",
    "-f", "rawvideo",
    "-"
  ], { input: buf, timeout: timeoutMs, maxBuffer: 1 << 20 });
  if (r.status !== 0 || !r.stdout || r.stdout.length < 72) return null;
  const px = r.stdout;
  let bits = "";
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const a = px[y * 9 + x];
      const b = px[y * 9 + x + 1];
      bits += a > b ? "1" : "0";
    }
  }
  return BigInt("0b" + bits).toString(16).padStart(16, "0");
}

/**
 * 异步版 dHash：群里每来一张图都会算一次，spawnSync 会把事件循环按住最多 15s
 * （期间所有群消息全卡）。这里用 spawn + 收集 stdout，失败/超时一律返回 null，
 * 调用方本来就能接受 null（拿不到 hash 只是降级去重，不影响发消息）。
 */
export function dhashFromBufferAsync(buf, { ffmpegPath = ffmpegPathFallback(), timeoutMs = 15000, spawnImpl = spawn } = {}) {
  if (!buf || !buf.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = null;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = spawnImpl(ffmpegPath, [
        "-v", "error", "-i", "pipe:0", "-vf", "scale=9:8,format=gray",
        "-frames:v", "1", "-f", "rawvideo", "-"
      ], { stdio: ["pipe", "pipe", "ignore"] });
    } catch { done(null); return; }
    const chunks = [];
    const timer = setTimeout(() => { try { child.kill(); } catch {} done(null); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); done(null); });
    child.stdout?.on("data", (c) => chunks.push(c));
    child.on("close", (code) => {
      clearTimeout(timer);
      const px = Buffer.concat(chunks);
      if (code !== 0 || px.length < 72) return done(null);
      let bits = "";
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          bits += px[y * 9 + x] > px[y * 9 + x + 1] ? "1" : "0";
        }
      }
      out = BigInt("0b" + bits).toString(16).padStart(16, "0");
      done(out);
    });
    // 大文件（如 5MB+ 动图）写 stdin 时，ffmpeg 读完第一帧就可能停止读入、提前收尾，
    // 未写完的写入会触发异步 'error'（write EOF）——不监听会导致整个进程 unhandled crash。
    // 关键：此时 ffmpeg 往往已经算好并写到了 stdout，所以这里只吞掉 error、不判失败，
    // 结果交给下面的 close 事件按 exit code + stdout 长度判定，大动图也能正常出 hash。
    try { child.stdin?.on?.("error", () => {}); } catch { /* 注入的假 stdin 可能没有 on */ }
    try { child.stdin?.end(buf); } catch { done(null); }
  });
}

/** 汉明距离：两个 16 位 hex 字符串之间不同的 bit 数。 */
export function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let n = 0;
  while (x > 0n) { n += Number(x & 1n); x >>= 1n; }
  return n;
}
