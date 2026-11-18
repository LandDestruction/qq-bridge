// 媒体归一化：把「QQ 给我们的原始图片」压成「DSH 与模型真能吃下的形状」。
//
// ── 为什么需要这一层（2026-10-18 审计结论，见 docs/audits/AUDIT_2026-10-18_MEDIA_AND_WATERMARK.md）
//
// ① 体积悬崖：DSH 的 MCP 图片入口会用正则校验 base64
//    （dsh-mcp-client 的 CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:…)?$/）。
//    这条正则在长输入上会压爆 V8 的 regexp 回溯栈，实测：
//        base64 ≥ 4,474,880 字符（原始字节 ≥ 3.20 MiB）→ RangeError: Maximum call stack size exceeded
//    而 DSH 把这个异常原样降级成 `[image unavailable: image/gif; Maximum call stack size exceeded; …]`
//    —— 模型只看到一行错误，图一个字节都没进上下文。
//    桥接侧的抓取上限（socialV2.media.maxBytes，默认 8 MiB）远在这条线之上，
//    于是「3.2–8 MiB 的图」就成了「桥接认为合法、DSH 必然拒绝」的死区。
//
// ② 动图变单帧：DSH 的 canPassThroughNormalization() 显式排除 image/gif，
//    一律交给 sharp 归一化，而 sharp 默认只解 page 0 —— 一张 48 帧、4.8 MB 的动图，
//    模型最终只看到「第 1 帧压成的 12 KB 静态 JPEG」，而且上下文里没有任何「这是动图」的提示。
//    模型于是只能瞎猜（实测会话里它连着两次给出的解释都是错的）。
//
// ── 本模块的取舍
//
// · **只动喂给模型的那一份**。收集表情（add_custom_face）必须用原始字节，
//   所以归一化只接在 fetchMediaData / resolveMediaList / sticker-image 这些「给模型看」的出口，
//   不去改 fetchOneBotImage / fetchFaceMedia 的返回值。
// · **动图抽帧拼图**而不是发多张图：一条消息 5 张图 = 5 次 DSH admission + 5 份 token，
//   而 3×2 拼图信息密度更高、只算一张图（实测 4.83 MB / 200 帧 → 92 KB / 269 ms）。
// · **能不动就不动**：小图（≤ maxModelBytes 且长边够小）原样放行，零延迟。
// · **ffmpeg 缺失也不硬塞**：超线又压不动的，宁可回一句「太大，看不了」，也不发注定被 DSH 丢掉
//   的字节（那样模型只会看到一行看不懂的错误）。
//
// 依赖：只用 node 内置 + voice-core 的 resolveFfmpeg（ffmpeg 定位的唯一实现）。
// 子进程一律 `stdio: 'ignore'` + 写文件：受限沙箱里 pipe 会 EPERM（见 voice-core.js 开头的说明）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveFfmpeg } from './voice-core.js';

/** 默认值集中一处，bridge.js 只做 config 覆盖（见 modelMediaLimits）。 */
export const MEDIA_DEFAULTS = Object.freeze({
  // 交给 DSH 的单张图片原始字节上限。DSH 的炸栈线是 ≈3.20 MiB，
  // 这里取 1 MiB：留 3 倍余量，顺带把 token 成本压一个数量级（1 MiB 图 ≈ 1.33 MB base64）。
  maxModelBytes: 1024 * 1024,
  // 长边上限：手机直出 4000×3000 缩到 1280 后约 150–250 KB，肉眼描述完全够用。
  maxLongEdge: 1280,
  // 动图抽几帧：6 帧正好 3×2，超过 9 帧拼图会小到看不清单帧。
  gifFrames: 6,
  // 每一格的目标宽度（px）：240 一格，3×2 拼图约 736×492，实测 92 KB。
  gifTile: 240,
  // 单张 ffmpeg 调用的硬超时。实测 200 帧 GIF 拼图 269 ms、4K 重编码 < 1 s，25 s 是兜底。
  timeoutMs: 25000,
  // ── 超长截图（聊天长截图 / 网页长图）纵向切片 ──────────────────────────
  // 为什么单独一套：只按「长边≤1280」缩放时，1200×14102 的图会被压成 108×1280，
  // 文字必然糊成一片（真机 2026-10-27 实证）。切片后每片保持原宽、高度≈1.4×宽，文字才读得出。
  // 触发比例：高/宽 ≥ 3 且长边超限才切；普通图（含 2.9 倍的短长图）完全走原路径。
  tallRatio: 3,
  // 最多切几段：8 段×1.4 倍宽≈能看到 11 屏；再多会和单条消息的总字节预算打架。
  maxTiles: 8,
  // 相邻片重叠比例（7%）：切在字中间时上下文还在下一片里；太小会漏行，太大纯浪费 token。
  tallOverlap: 0.07,
  // 每片目标高（相对原宽）：1.4 倍宽≈一屏半，文字行数够多又不至于太高被缩。
  tallTileAspect: 1.4,
  // 太窄的长图不硬切：300px 宽切了也是糊的，不如如实说看不清。
  tallMinWidth: 300,
  // 每片输出宽度下限：文字截图低于 900px 宽基本认不出汉字（放大只是变糊，但不放大更糊）。
  tallTileMinWidth: 900,
  // 每片长边上限：DSH 对单张图的处理上限，超过会被压回去，等于白切。
  tallTileMaxEdge: 2048
});

/** 硬上限：不管 config 怎么写，都不允许超过 DSH 的实测炸栈线下沿。 */
const HARD_MAX_MODEL_BYTES = Math.floor(3.0 * 1024 * 1024);

// ── 格式探测（纯函数，可单测） ────────────────────────────────────────────

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** 浮点夹取（比例类配置用）：非法值回落默认。 */
const clampNum = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** GIF 子块链跳过：每个子块首字节是长度，0 结束。返回新游标（越界返回 -1）。 */
function skipGifSubBlocks(buf, pos) {
  let p = pos;
  let guard = 0;
  while (p < buf.length) {
    const size = buf[p];
    p += 1;
    if (size === 0) return p;
    p += size;
    if (++guard > 1_000_000) return -1;
  }
  return -1;
}

/**
 * 解析 GIF 的帧数与总时长（以及是否有透明帧）。
 *
 * 为什么不直接问 ffprobe：a) ffmpeg 可能没装，而「这是动图，N 帧」这句话就算没 ffmpeg
 * 也要能告诉模型；b) 每次看图都 spawn 一次 ffprobe 是白花的时间（这里纯内存解析）。
 * GIF 的块结构很实在：0x2C = 图像描述符（一帧），0x21 0xF9 = 图形控制扩展（带 delay）。
 */
function parseGif(buf) {
  if (buf.length < 13) return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  let pos = 13;
  if (packed & 0x80) pos += 3 * (2 << (packed & 0x07)); // 全局颜色表
  let frames = 0;
  let durationCs = 0;
  let alpha = false;
  let delayCs = 0;
  let guard = 0;
  while (pos >= 0 && pos < buf.length) {
    if (++guard > 5_000_000) break;
    const block = buf[pos];
    pos += 1;
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      if (pos >= buf.length) break;
      const label = buf[pos];
      pos += 1;
      if (label === 0xf9 && pos + 4 <= buf.length) {
        // 块长(1) 打包位(1) delay(2) 透明色索引(1) 终结符(1)
        const size = buf[pos];
        if (size >= 4 && pos + 4 < buf.length) {
          const gcePacked = buf[pos + 1];
          delayCs = buf.readUInt16LE(pos + 2);
          if (gcePacked & 0x01) alpha = true;
        }
      }
      pos = skipGifSubBlocks(buf, pos);
      continue;
    }
    if (block === 0x2c) {
      if (pos + 9 > buf.length) break;
      const descPacked = buf[pos + 8];
      pos += 9;
      if (descPacked & 0x80) pos += 3 * (2 << (descPacked & 0x07)); // 局部颜色表
      pos += 1; // LZW 最小码长
      pos = skipGifSubBlocks(buf, pos);
      frames += 1;
      durationCs += delayCs || 0;
      delayCs = 0;
      continue;
    }
    break; // 解析不了就别硬猜
  }
  return {
    width,
    height,
    frames: Math.max(1, frames),
    durationMs: durationCs > 0 ? durationCs * 10 : 0,
    alpha
  };
}

/** WebP：解析尺寸，并识别动图（ANIM 块 / ANMF 帧块）。 */
function parseWebp(buf) {
  if (buf.length < 30) return null;
  const fourcc = buf.toString('ascii', 12, 16);
  let width = 0;
  let height = 0;
  if (fourcc === 'VP8X') {
    width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
    height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
  } else if (fourcc === 'VP8L') {
    const b = [buf[21], buf[22], buf[23], buf[24]];
    width = 1 + (((b[1] & 0x3f) << 8) | b[0]);
    height = 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6));
  } else if (fourcc === 'VP8 ') {
    width = buf.readUInt16LE(26) & 0x3fff;
    height = buf.readUInt16LE(28) & 0x3fff;
  } else {
    return null;
  }
  // 动图：RIFF 里出现 ANIM（动画头）与若干个 ANMF（帧）。只数块头，不解析负载。
  let frames = 0;
  let pos = 12;
  let guard = 0;
  while (pos + 8 <= buf.length && ++guard < 1_000_000) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'ANMF') frames += 1;
    pos += 8 + size + (size & 1);
  }
  const alpha = fourcc === 'VP8X' ? (buf[20] & 0x10) !== 0 : true;
  return { width, height, frames: Math.max(1, frames), durationMs: 0, alpha };
}

function parsePng(buf) {
  if (buf.length < 26) return null;
  const colorType = buf[25];
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    frames: 1,
    durationMs: 0,
    alpha: colorType === 4 || colorType === 6
  };
}

function parseJpeg(buf) {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) { offset += 1; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const len = buf.readUInt16BE(offset + 2);
    if (len < 2) return null;
    // SOF0–SOF15（排除 DHT C4 / JPG C8 / DAC CC）
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5), frames: 1, durationMs: 0, alpha: false };
    }
    offset += 2 + len;
  }
  return null;
}

/**
 * 从字节里认出格式/尺寸/帧数。
 *
 * @returns null（认不出）或
 *   { format:'gif'|'png'|'jpeg'|'webp', width, height, frames, durationMs, animated, alpha }
 */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  let format = null;
  let parsed = null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    format = 'png'; parsed = parsePng(buf);
  } else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    format = 'jpeg'; parsed = parseJpeg(buf);
  } else if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
    format = 'gif'; parsed = parseGif(buf);
  } else if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    format = 'webp'; parsed = parseWebp(buf);
  }
  if (!parsed || !parsed.width || !parsed.height) return null;
  return {
    format,
    width: parsed.width,
    height: parsed.height,
    frames: Math.max(1, parsed.frames || 1),
    durationMs: parsed.durationMs || 0,
    animated: (parsed.frames || 1) > 1,
    alpha: !!parsed.alpha
  };
}

// ── 决策（纯函数，可单测） ────────────────────────────────────────────────

/**
 * 超长截图的纵向切片规划（纯函数，可单测）。
 *
 * 返回三态：
 *   null                               → 不是「极端竖长图」，走原有路径（完全不变）；
 *   { kind:'too-narrow', … }           → 是长图但太窄，切片也看不清，调用方应如实拒绝；
 *   { kind:'tiles', tiles:[{y,h}], … } → 每片在原图里的裁切矩形 + 输出尺寸。
 *
 * 几何口径（为什么不直接均分）：
 *   - 每片目标高 = 原宽 × tallTileAspect(1.4)。按「片数」均分会在窄长图上切出又高又窄的片，
 *     缩放后单字仍然糊；按宽度定片高才能保证每片的字至少和原图一样大。
 *   - 相邻片重叠 tallOverlap(7%)：切在文字中间时，下一片还能看到这一行的下半截，不会整行丢失。
 *   - 片数上限 maxTiles(8)：再多就和单条消息的总字节预算打架（默认 8MB）。
 *   - 输出先放大到宽 ≥900（小宽长图），再用长边 ≤2048 夹住——两个约束同时满足时才切片。
 */
export function planTallTiles(info, limits = {}) {
  if (!info || info.animated) return null;
  const width = Math.max(0, Math.round(Number(info.width) || 0));
  const height = Math.max(0, Math.round(Number(info.height) || 0));
  if (!width || !height) return null;
  const tallRatio = clampNum(limits.tallRatio, 1.5, 20, MEDIA_DEFAULTS.tallRatio);
  if (height / width < tallRatio) return null;

  if (width < MEDIA_DEFAULTS.tallMinWidth) {
    return {
      kind: 'too-narrow',
      width,
      height,
      ratio: Number((height / width).toFixed(2)),
      reason: `长图太窄（宽 ${width}px × 高 ${height}px），切片也看不清`
    };
  }

  const maxTiles = clampInt(limits.maxTiles, 2, 12, MEDIA_DEFAULTS.maxTiles);
  const overlapRatio = clampNum(limits.tallOverlap, 0.02, 0.15, MEDIA_DEFAULTS.tallOverlap);
  const tileAspect = clampNum(limits.tallTileAspect, 1.0, 2.0, MEDIA_DEFAULTS.tallTileAspect);
  const maxEdge = MEDIA_DEFAULTS.tallTileMaxEdge;

  // 片数按「目标片高」推；能触发切片就至少 2 片。
  const wanted = Math.ceil(height / (width * tileAspect));
  const count = Math.min(maxTiles, Math.max(2, wanted));
  // 解 n*H - (n-1)*o*H = height → H = height / (n - (n-1)*o)
  const tileHeight = Math.min(height, Math.max(2, Math.round(height / (count - (count - 1) * overlapRatio))));
  const step = count > 1 ? Math.round((height - tileHeight) / (count - 1)) : 0;
  const tiles = [];
  for (let i = 0; i < count; i += 1) {
    // 最后一片贴底（取整误差不会在底部留缝）。
    const y = i === count - 1 ? height - tileHeight : Math.round(i * step);
    tiles.push({ y: Math.max(0, Math.min(y, height - tileHeight)), h: tileHeight });
  }

  // 输出尺寸：先满足「宽 ≥900」，再用「长边 ≤2048」夹住（冲突时以长边上限为准）。
  let scale = Math.max(1, MEDIA_DEFAULTS.tallTileMinWidth / width);
  if (Math.max(width, tileHeight) * scale > maxEdge) scale = maxEdge / Math.max(width, tileHeight);
  const outWidth = Math.max(2, Math.round(width * scale) & ~1);
  const outHeight = Math.max(2, Math.round(tileHeight * scale) & ~1);

  return {
    kind: 'tiles',
    width,
    height,
    ratio: Number((height / width).toFixed(2)),
    count,
    clamped: wanted > maxTiles,
    wanted,
    tileHeight,
    step,
    overlapRatio,
    overlapPx: Math.max(0, tileHeight - step),
    tiles,
    scale: Number(scale.toFixed(4)),
    outWidth,
    outHeight
  };
}

/**
 * 要不要动这张图？返回 null = 原样放行。
 *
 * @param info sniffImage() 的结果（null 表示认不出 → 一律放行，交给下游）
 * @param bytes 原始字节数
 * @param limits 归一化上限
 */
export function planNormalization(info, bytes, limits = {}) {
  const maxBytes = clampInt(limits.maxModelBytes, 64 * 1024, HARD_MAX_MODEL_BYTES, MEDIA_DEFAULTS.maxModelBytes);
  const maxLongEdge = clampInt(limits.maxLongEdge, 256, 2048, MEDIA_DEFAULTS.maxLongEdge);
  if (!info) {
    // 认不出的格式：能放就放（下游 mimeFromBuffer 会兜底），太大就拒绝——绝不硬塞。
    return bytes > maxBytes ? { action: 'reject', reason: `未知图片格式且 ${bytes} 字节超过上限` } : null;
  }
  if (info.animated) {
    return { action: 'animate', maxBytes, maxLongEdge };
  }
  const longEdge = Math.max(info.width, info.height);
  // 超长截图优先于普通缩放：先判「要不要切」，再判「要不要缩」。
  // 只有长边已经超限的长图才切——400×1200 这种「不算长」的长图原样放行，别为了切片切片。
  const tall = planTallTiles(info, limits);
  if (longEdge > maxLongEdge && tall) {
    if (tall.kind === 'too-narrow') return { action: 'reject', reason: tall.reason };
    return { action: 'tile', maxBytes, maxLongEdge, tall, bytes, longEdge };
  }
  if (bytes <= maxBytes && longEdge <= maxLongEdge) return null;
  return { action: 'shrink', maxBytes, maxLongEdge, bytes, longEdge };
}

/** 动图拼图布局：帧数 → { cols, rows, fps, sampleFrames }。纯函数。 */
export function planAnimation(info, limits = {}) {
  const wanted = clampInt(limits.gifFrames, 2, 12, MEDIA_DEFAULTS.gifFrames);
  const frames = Math.max(1, info?.frames || 1);
  // 帧比想要的多才有意思抽帧；帧本来就少就全用上（不重复填充没信息量的格子）。
  const sample = Math.min(wanted, frames);
  // 布局偏好：6→3×2、9→3×3、8→4×2（都填满），其余按接近正方形算。
  const layout = { 2: [2, 1], 3: [3, 1], 4: [2, 2], 5: [3, 2], 6: [3, 2], 7: [4, 2], 8: [4, 2], 9: [3, 3], 10: [5, 2], 11: [4, 3], 12: [4, 3] }[sample]
    ?? [Math.ceil(Math.sqrt(sample)), Math.ceil(sample / Math.ceil(Math.sqrt(sample)))];
  const [cols, rows] = layout;
  // fps 必须让 ffmpeg 恰好产出 sample 帧；时长未知时按每帧 100 ms 估（QQ 表情的常见默认）。
  const durationMs = info?.durationMs > 0 ? info.durationMs : frames * 100;
  const seconds = Math.max(0.05, durationMs / 1000);
  const fps = Math.min(30, Math.max(0.05, Number((sample / seconds).toFixed(4))));
  return { cols, rows, fps, sampleFrames: sample, totalFrames: frames, durationMs };
}

/**
 * 动图的说明文字（拼图成功 / 降级两条路径）。纯函数。
 *
 * 为什么单独抽出来：原来 `seconds` 声明在「拼图成功」的 if 块里，降级分支
 * （第 402 行）却在块外引用它 —— const 是块级作用域，动图一旦拼图失败就必抛
 * ReferenceError；而 normalizeImageForModel 只有 try/finally 没有 catch，
 * 异常会冒到 bridge.js 的 toModelMedia，把整条消息的媒体解析一起打断。
 * 抽成纯函数后两条路径都能离线断言。
 */
export function gifNotes({ layout, bytes = 0, runOk = true, runError = '' } = {}) {
  const l = layout && typeof layout === 'object' ? layout : {};
  const frames = Number(l.totalFrames) || 1;
  const durationMs = Number(l.durationMs) > 0 ? Number(l.durationMs) : frames * 100;
  const seconds = (durationMs / 1000).toFixed(1);
  const sizeMb = (Math.max(0, Number(bytes) || 0) / 1024 / 1024).toFixed(2);
  const failure = runOk ? '输出仍超限' : String(runError || '未知原因');
  return {
    composed: `动图 ${frames} 帧/${seconds}s，已抽 ${Number(l.sampleFrames) || 1} 帧拼成 ${Number(l.cols) || 1}×${Number(l.rows) || 1} 网格，行优先 左上→右下；原图 ${sizeMb}MB`,
    degraded: `这是动图，共 ${frames} 帧/${seconds}s；抽帧失败（${failure}），只提供首帧（你只能看到第一帧），其余画面无法得知，不要臆测动作`
  };
}

// ── ffmpeg 调用 ──────────────────────────────────────────────────────────

/**
 * 跑一次 ffmpeg：输入/输出都走文件，stdio 全 ignore。
 *
 * 为什么不用管道：受限沙箱里 `spawn` + stdio:'pipe' 会直接 EPERM（voice-core.js 开头有同样记录）。
 * 代价是拿不到 ffmpeg 的 stderr —— 所以调用方只报「退出码 + 动作名」，不假装能诊断具体原因。
 */
function runFfmpeg(ffmpeg, args, { timeoutMs = MEDIA_DEFAULTS.timeoutMs } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ ok: false, error: `ffmpeg 启动失败：${error?.message ?? error}` });
      return;
    }
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      settle({ ok: false, error: `ffmpeg 超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.on('error', (error) => settle({
      ok: false,
      error: error?.code === 'ENOENT'
        ? '找不到 ffmpeg（设置 FFMPEG_PATH 或 config.json 的 socialV2.voice.ffmpegPath）'
        : `ffmpeg 不可用：${error?.message ?? error}`
    }));
    child.on('close', (code) => settle(code === 0 ? { ok: true } : { ok: false, error: `ffmpeg 退出码 ${code}` }));
  });
}

function makeTempWorkspace(tmpDir) {
  const base = tmpDir ? path.resolve(tmpDir) : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'qqb-media-'));
}

function cleanupWorkspace(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** 按扩展名挑输出容器：有 alpha 用 PNG（保透明），否则 JPEG（体积小得多）。 */
function pickOutputExt(info) {
  return info?.alpha ? '.png' : '.jpg';
}

function readIfExists(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return null;
    return fs.readFileSync(file);
  } catch { return null; }
}

// ── 主入口 ──────────────────────────────────────────────────────────────

/**
 * 把一张图整理成「可以安全交给 DSH / 模型」的形态。
 *
 * @param buf       原始字节
 * @param mimeType  调用方已知的 MIME（可能与实际不符，以字节探测为准）
 * @param opts      { maxModelBytes, maxLongEdge, gifFrames, gifTile, enabled, ffmpegPath, tmpDir, label, timeoutMs }
 * @returns {Promise<{ok:boolean, buffer?:Buffer, mimeType?:string, note?:string, error?:string, skipped?:boolean}>}
 *   ok=false 只在「超大且压不动」时出现；调用方应把它变成一句可读的失败原因，而不是发空图。
 */
export async function normalizeImageForModel(buf, mimeType, opts = {}) {
  const bytes = Buffer.isBuffer(buf) ? buf.length : 0;
  if (!bytes) return { ok: false, error: '图片字节为空' };
  if (opts.enabled === false) return { ok: true, buffer: buf, mimeType, note: '' };

  const info = sniffImage(buf);
  const plan = planNormalization(info, bytes, opts);
  if (!plan) {
    // 原样放行：这是绝大多数情况（小图），零额外延迟。
    return { ok: true, buffer: buf, mimeType: mimeType || (info ? `image/${info.format === 'jpeg' ? 'jpeg' : info.format}` : 'image/jpeg'), note: '' };
  }
  if (plan.action === 'reject') {
    return { ok: false, error: plan.reason, skipped: true };
  }

  const ffmpeg = resolveFfmpeg({ ffmpegPath: opts.ffmpegPath ?? null });
  const maxBytes = plan.maxBytes;
  const maxLongEdge = plan.maxLongEdge;

  const dir = makeTempWorkspace(opts.tmpDir);
  try {
    const inExt = info.format === 'jpeg' ? '.jpg' : `.${info.format}`;
    const inFile = path.join(dir, `in${inExt}`);
    fs.writeFileSync(inFile, buf);

    if (plan.action === 'animate') {
      const layout = planAnimation(info, opts);
      const tileWidth = clampInt(opts.gifTile, 64, 400, MEDIA_DEFAULTS.gifTile);
      const outFile = path.join(dir, 'strip.jpg');
      const vf = `fps=${layout.fps},scale=${tileWidth}:-1:flags=lanczos,` +
        `tile=${layout.cols}x${layout.rows}:padding=4:margin=4:color=white`;
      const run = await runFfmpeg(ffmpeg, [
        '-v', 'error', '-y', '-i', inFile,
        '-filter_complex', `[0:v]${vf}[out]`, '-map', '[out]',
        '-frames:v', '1', '-q:v', '4', outFile
      ], { timeoutMs: opts.timeoutMs });
      const out = run.ok ? readIfExists(outFile) : null;
      // 说明文字在纯函数里算（两条分支共用同一个 seconds，避免块级作用域再踩一次）。
      const notes = gifNotes({ layout, bytes, runOk: run.ok, runError: run.error });
      if (out && out.length <= maxBytes) {
        return {
          ok: true,
          buffer: out,
          mimeType: 'image/jpeg',
          // 这段文字会原样出现在工具结果里（外面还会再包一层括号），所以**不要用嵌套括号**。
          note: notes.composed
        };
      }
      // 拼图失败（没 ffmpeg / 超时 / 还是太大）：退化到「能看多少算多少」。
      if (bytes <= maxBytes) {
        return {
          ok: true,
          buffer: buf,
          mimeType: mimeType || 'image/gif',
          // 明确告诉模型：这是动图、共多少帧、你只看到第一帧——否则它会把动图当静图理解，甚至编造动作。
          note: notes.degraded
        };
      }
      return { ok: false, error: `动图 ${(bytes / 1024 / 1024).toFixed(2)}MB 无法压缩（${run.ok ? '输出仍超限' : run.error}）` };
    }

    // action === 'tile'：超长截图纵向切片，每片单独成一张图。
    // 为什么不能退回「整图缩一张」：1200×14102 缩到长边 1280 后宽只剩 108px，文字必然糊；
    // 切片后每片保持原宽、高≈1.4×宽，字才读得出来。
    if (plan.action === 'tile') {
      const tiled = await tileTallImage({ ffmpeg, info, inFile, dir, plan, opts });
      if (tiled.ok) return tiled.result;
      // 切片失败不装死：退回整图缩放，并在说明里写清楚「可能看不清」。
      const fallback = await shrinkStaticImage({ ffmpeg, info, inFile, dir, bytes, maxBytes, maxLongEdge, opts, raw: buf, mimeType });
      if (fallback.ok) {
        return { ...fallback, note: `${fallback.note || ''}；长图切片失败（${tiled.error}），已退回整图缩放（文字可能看不清）` };
      }
      return fallback;
    }

    // action === 'shrink'：静态图降采样 + 重编码，最多试三轮（逐步缩小尺寸/降质量）。
    return await shrinkStaticImage({ ffmpeg, info, inFile, dir, bytes, maxBytes, maxLongEdge, opts, raw: buf, mimeType });
  } finally {
    cleanupWorkspace(dir);
  }
}

/**
 * 静态图整图缩放（原 shrink 分支，逐字搬出以便 tile 失败时复用）。
 * 最多试三轮（尺寸逐步缩小、JPEG 质量逐步降低）。
 */
async function shrinkStaticImage({ ffmpeg, info, inFile, dir, bytes, maxBytes, maxLongEdge, opts = {}, raw, mimeType }) {
  const outExt = pickOutputExt(info);
  let edge = maxLongEdge;
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const scale = Math.min(1, edge / Math.max(info.width, info.height));
    const width = Math.max(2, Math.round(info.width * scale) & ~1);
    const height = Math.max(2, Math.round(info.height * scale) & ~1);
    const outFile = path.join(dir, `out-${attempt}${outExt}`);
    const args = ['-v', 'error', '-y', '-i', inFile, '-vf', `scale=${width}:${height}:flags=lanczos`];
    if (outExt === '.jpg') args.push('-q:v', String(3 + attempt * 3));
    args.push(outFile);
    const run = await runFfmpeg(ffmpeg, args, { timeoutMs: opts.timeoutMs });
    if (!run.ok) { lastError = run.error; }
    else {
      const out = readIfExists(outFile);
      if (out && out.length <= maxBytes) {
        return {
          ok: true,
          buffer: out,
          mimeType: outExt === '.jpg' ? 'image/jpeg' : 'image/png',
          note: `原图 ${info.width}×${info.height} ${(bytes / 1024).toFixed(0)}KB → ${width}×${height} ${(out.length / 1024).toFixed(0)}KB`
        };
      }
      lastError = '压缩后仍超限';
    }
    edge = Math.max(320, Math.round(edge * 0.7));
  }
  // 压不动：小图照发，大图明确拒绝（绝不发注定被 DSH 丢掉的东西）。
  if (bytes <= maxBytes) return { ok: true, buffer: raw, mimeType, note: `压缩失败（${lastError}），按原图提供` };
  return { ok: false, error: `${(bytes / 1024 / 1024).toFixed(2)}MB 压不到 ${(maxBytes / 1024).toFixed(0)}KB 以内（${lastError}）` };
}

/**
 * 超长截图切片（每片一次 ffmpeg crop+scale）。
 *
 * 失败语义：任何一片切不出来/单片超预算 → 三轮质量递减都失败后返回 { ok:false, error }，
 * 由调用方退回整图缩放（并注明可能看不清），绝不抛异常打断整条消息的媒体解析。
 */
async function tileTallImage({ ffmpeg, info, inFile, dir, plan, opts = {} }) {
  const tall = plan.tall;
  const maxBytes = plan.maxBytes;
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const quality = 3 + attempt * 3;
    const outputs = [];
    let failed = '';
    for (let i = 0; i < tall.tiles.length; i += 1) {
      const { y, h } = tall.tiles[i];
      const outFile = path.join(dir, `tile-${attempt}-${i}.jpg`);
      const vf = `crop=${info.width}:${h}:0:${y},scale=${tall.outWidth}:${tall.outHeight}:flags=lanczos`;
      const run = await runFfmpeg(ffmpeg, [
        '-v', 'error', '-y', '-i', inFile,
        '-vf', vf, '-frames:v', '1', '-q:v', String(quality), outFile
      ], { timeoutMs: opts.timeoutMs });
      if (!run.ok) { failed = run.error; break; }
      const out = readIfExists(outFile);
      if (!out) { failed = '切片输出为空'; break; }
      if (out.length > maxBytes) { failed = `第 ${i + 1}/${tall.tiles.length} 段 ${(out.length / 1024).toFixed(0)}KB 超过单图上限`; break; }
      outputs.push(out);
    }
    if (!failed && outputs.length === tall.tiles.length) {
      const overlapPct = Math.round(tall.overlapRatio * 100);
      return {
        ok: true,
        result: {
          ok: true,
          buffer: outputs[0],
          mimeType: 'image/jpeg',
          tall: true,
          tiles: outputs.map((buffer) => ({ buffer, mimeType: 'image/jpeg' })),
          note: `原图 ${info.width}×${info.height} 是超长截图，已纵向切成 ${tall.tiles.length} 段（每段 ${tall.outWidth}×${tall.outHeight}，段间重叠约 ${overlapPct}%），按顺序看；段与段有重叠，不要重复计数，也不要当成 ${tall.tiles.length} 张不同的截图`
        }
      };
    }
    lastError = failed || '切片失败';
  }
  return { ok: false, error: lastError };
}

/** 供日志/提示用的一句话摘要（不含 base64）。 */
export function describeImage(buf) {
  const info = sniffImage(buf);
  if (!info) return `未知格式 ${buf?.length ?? 0}B`;
  const parts = [`${info.format} ${info.width}×${info.height}`, `${(buf.length / 1024).toFixed(0)}KB`];
  if (info.animated) parts.push(`动图 ${info.frames} 帧${info.durationMs ? `/${(info.durationMs / 1000).toFixed(1)}s` : ''}`);
  return parts.join(' ');
}

// ── HEIC/HEIF（iPhone 默认格式）──────────────────────────────────────────────
// sniffImage 只认 PNG/JPEG/GIF/WebP，HEIC 会被判「不是有效图片」。这里单独识别，
// 再由桥接调 ffmpeg 转成 JPEG 后重走原有链路。

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis']);

/** 按 ISO-BMFF 的 ftyp box 判 HEIC/HEIF。 */
export function sniffHeic(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buf.toString('ascii', 8, 12).toLowerCase();
  return HEIC_BRANDS.has(brand);
}

/**
 * HEIC → JPEG（ffmpeg）。失败返回明确原因，不返回裸 null —— 上一层要能把它写进给模型的说明。
 * @param {{ ffmpegPath?: string, timeoutMs?: number, spawnImpl?: Function }} opts
 * @returns {Promise<{ ok: true, buffer: Buffer } | { ok: false, reason: string }>}
 */
export function convertHeicToJpeg(buf, { ffmpegPath = 'ffmpeg', timeoutMs = 20000, spawnImpl = null } = {}) {
  const spawn = spawnImpl ?? require_spawn();
  if (!spawn) return Promise.resolve({ ok: false, reason: '内部错误：拿不到 child_process' });
  if (!Buffer.isBuffer(buf) || !buf.length) return Promise.resolve({ ok: false, reason: '空字节' });
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = spawn(ffmpegPath, ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-q:v', '2', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      done({ ok: false, reason: `ffmpeg 启动失败：${error?.message ?? error}` });
      return;
    }
    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} done({ ok: false, reason: `HEIC 转码超时（${timeoutMs}ms）` }); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); done({ ok: false, reason: `ffmpeg 不可用：${error?.message ?? error}` }); });
    child.stdout?.on('data', (c) => chunks.push(c));
    child.stderr?.on('data', (c) => { if (stderr.length < 400) stderr += c.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      if (code === 0 && out.length > 3 && out[0] === 0xff && out[1] === 0xd8) return done({ ok: true, buffer: out });
      done({ ok: false, reason: `HEIC 转码失败（exit=${code}）：${stderr.trim().slice(0, 160) || '无输出'}` });
    });
    try { child.stdin?.end(buf); } catch { done({ ok: false, reason: '写入 ffmpeg stdin 失败' }); }
  });
}

function require_spawn() {
  try {
    // 延迟取，避免把 ESM 顶层 import 绑死在测试环境
    return globalThis.__MEDIA_NORMALIZE_SPAWN__ ?? null;
  } catch { return null; }
}

/** 测试/调用方注入 spawn 用。 */
export function setMediaNormalizeSpawn(fn) { globalThis.__MEDIA_NORMALIZE_SPAWN__ = fn; }
