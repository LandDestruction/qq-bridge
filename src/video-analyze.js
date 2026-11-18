// 视频理解：抽帧拼图（看图）+ 音轨转写（听声）。
//
// 为什么要它：QQ 视频消息在桥接里只渲染成 "[视频]"，模型既看不到画面也听不到声音。
// 这里把一段视频压成「一张 3×3 拼图 + 一段转写文本」，模型就能“看”和“听”。
//
// 依赖：ffmpeg（config.socialV2.voice.ffmpegPath）+ python faster-whisper（tools/stt_cli.py）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { planFramePlan } from "./stt-quality.js";

export const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
export const VIDEO_MAX_SECONDS = 120;
export const FRAME_COUNT = 9;

function tmpFile(ext) {
  return path.join(os.tmpdir(), `dshvid_${process.pid}_${crypto.randomBytes(4).toString("hex")}${ext}`);
}


/**
 * 异步跑一个子进程（替代 spawnSync）。
 *
 * 为什么必须异步：一条 30 秒视频要跑 ffprobe + 抽帧 + 抽音轨 + whisper 转写，
 * 同步 spawn 会把**整个事件循环**卡住几十秒到几分钟 —— 期间所有 QQ 消息都不处理，
 * 表现为「机器人在线但完全不回」。这里改成 spawn + 超时 + kill。
 *
 * stdio 用 pipe 取 stdout（ffprobe 需要），失败时调用方按 null 处理；
 * 受限沙箱里 pipe 可能 EPERM，所以 spawn 失败也只返回错误、不抛。
 */
export function runCommandAsync(cmd, args, { timeoutMs = 20000, capture = false, env = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore", env: env || process.env });
    } catch (error) {
      resolve({ ok: false, stdout: "", error: `启动失败：${error?.message ?? error}` });
      return;
    }
    let out = "";
    let settled = false;
    const settle = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      settle({ ok: false, stdout: out, error: `超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    if (capture && child.stdout) child.stdout.on("data", (c) => { out += c.toString("utf8"); });
    child.on("error", (error) => settle({ ok: false, stdout: out, error: error?.code === "ENOENT" ? "找不到可执行文件" : `不可用：${error?.message ?? error}` }));
    child.on("close", (code) => settle(code === 0 ? { ok: true, stdout: out, error: "" } : { ok: false, stdout: out, error: `退出码 ${code}` }));
  });
}

/** 用 ffprobe 读时长（秒）；失败返回 null。 */
export async function probeDuration(file, ffprobePath = "ffprobe") {
  const r = await runCommandAsync(ffprobePath, [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file
  ], { timeoutMs: 20000, capture: true });
  const n = Number(String(r.stdout || "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 解析 ffprobe 可执行文件路径。
 *
 * 旧写法是 `ffmpegPath.replace(/ffmpeg\.exe$/i, "ffprobe.exe")` —— 只有把配置写成
 * `...\ffmpeg.exe` 时才成立。写成 `ffmpeg`（走 PATH）或 `/usr/bin/ffmpeg` 时，ffprobe
 * 拿到的是 **ffmpeg 自己的路径**：probeDuration 返回 null、还不留任何日志，
 * 表现为「视频时长/声音转写整个静默消失」，无从排查。
 *
 * 优先级：FFPROBE_PATH → 与 ffmpeg 同目录的 ffprobe(.exe) → 裸 ffprobe（交给 PATH）。
 */
export function resolveFfprobePath(ffmpegPath = "ffmpeg", { env = process.env, exists = fs.existsSync } = {}) {
  const fromEnv = String(env?.FFPROBE_PATH ?? "").trim();
  if (fromEnv) return fromEnv;
  const ff = String(ffmpegPath || "ffmpeg");
  if (/ffprobe(\.exe)?$/i.test(ff)) return ff;
  // 带目录分隔符才去同目录找（Windows 反斜杠 + POSIX 正斜杠都算；用 includes 而不是
  // 正则字符类，避免 `[\\/]` 在多层字符串转义里被吃成一个斜杠）。
  if (ff.includes('\\') || ff.includes('/')) {
    const dir = path.dirname(ff);
    for (const name of ["ffprobe.exe", "ffprobe"]) {
      const candidate = path.join(dir, name);
      try { if (exists(candidate)) return candidate; } catch {}
    }
  }
  return process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
}

/** 抽帧拼图（返回 png buffer；失败 null）。默认按「最长约 1 秒一帧、上限 12 帧」抽。 */
export async function extractFrameGrid(file, { ffmpegPath = "ffmpeg", durationSec = null, count = null, maxFrames = 12 } = {}) {
  const dur = durationSec || await probeDuration(file, resolveFfprobePath(ffmpegPath));
  const plan = planFramePlan(dur, { maxFrames: count || maxFrames });
  const out = tmpFile(".png");
  try {
    const r = await runCommandAsync(ffmpegPath, [
      "-v", "error", "-i", file,
      "-vf", `fps=1/${plan.everySec.toFixed(2)},scale=320:-1,tile=${plan.cols}x${plan.rows}`,
      "-frames:v", "1", out
    ], { timeoutMs: 90000 });
    if (!r.ok || !fs.existsSync(out)) return null;
    const buf = fs.readFileSync(out);
    if (!buf.length) return null;
    return { buffer: buf, cols: plan.cols, rows: plan.rows, frames: plan.count, everySec: plan.everySec };
  } finally {
    try { fs.unlinkSync(out); } catch {}
  }
}

/** 抽 16k 单声道 wav（给 STT 用）；默认做去静音/响度归一化，滤镜失败自动退回裸抽。 */
export async function extractAudioWav(file, { ffmpegPath = "ffmpeg", maxSeconds = 300, startSec = 0 } = {}) {
  const out = tmpFile(".wav");
  const cap = Math.max(1, Number(maxSeconds) || 300);
  const start = Math.max(0, Number(startSec) || 0);
  const baseArgs = ["-v", "error", "-i", file, "-vn"]
    .concat(start > 0 ? ["-ss", String(start)] : [])
    .concat(["-t", String(cap), "-ac", "1", "-ar", "16000"]);
  const af = "highpass=f=80,silenceremove=start_periods=1:start_duration=0.3:start_threshold=-45dB,loudnorm=I=-16:TP=-1.5:LRA=11";
  try {
    // 先试带前处理的；某些老 ffmpeg 缺 loudnorm → 退回裸抽，别让「音频处理失败」把转写整个弄没。
    let r = await runCommandAsync(ffmpegPath, [...baseArgs, "-af", af, "-f", "wav", out], { timeoutMs: 90000 });
    if (!r.ok || !fs.existsSync(out)) {
      r = await runCommandAsync(ffmpegPath, [...baseArgs, "-f", "wav", out], { timeoutMs: 90000 });
    }
    if (!r.ok || !fs.existsSync(out)) return null;
    const buf = fs.readFileSync(out);
    return buf.length ? buf : null;
  } finally {
    try { fs.unlinkSync(out); } catch {}
  }
}

/** 调 tools/stt_cli.py 转写 wav；返回 { ok, text, segments }。 */
export async function transcribeWav(wavBuf, { python = "python", script, model = "small", lang = "zh", timeoutMs = 180000 } = {}) {
  if (!wavBuf || !script) return { ok: false, error: "缺少音频或脚本路径" };
  const file = tmpFile(".wav");
  try {
    fs.writeFileSync(file, wavBuf);
    const r = await runCommandAsync(python, [script, file, "--model", model, "--lang", lang], {
      timeoutMs,
      capture: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    });
    const text = String(r.stdout || "").trim();
    const line = text.split("\n").filter(Boolean).pop() || "";
    try { return JSON.parse(line); } catch { return { ok: false, error: line.slice(0, 200) || "无输出" }; }
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

/** 把转写文本里像人名/地址的片段做遮蔽（用户要求：识别到姓名和住址就打乱码）。 */
export function redactPii(text) {
  let out = String(text || "");
  // 姓名：我是X / 我叫X / 我的名字叫X（2~4 个汉字），排除常见口语词。
  out = out.replace(/(?:我是|我叫|我的名字叫)([\u4e00-\u9fa5]{2,4})(?=[，。！？\s]|$)/g, (all, name) => {
    const stop = ["真的", "不知", "觉得", "说的", "在这", "一个", "你的", "他的", "她的"];
    if (stop.includes(name)) return all;
    return all.replace(name, "【姓名】");
  });
  // 手机号
  out = out.replace(/\b1[3-9]\d{9}\b/g, "【手机号】");
  // 身份证
  out = out.replace(/\b\d{17}[\dXx]\b/g, "【身份证】");
  // 门牌号/街道：xx路xx号、xx街xx号、xx小区xx栋
  out = out.replace(/[\u4e00-\u9fa5]{2,10}(?:路|街|道)\d{1,5}号/g, "【地址】");
  out = out.replace(/[\u4e00-\u9fa5]{2,10}(?:小区|花园|公寓)\d{1,5}(?:栋|号楼|单元)/g, "【地址】");
  return out;
}
