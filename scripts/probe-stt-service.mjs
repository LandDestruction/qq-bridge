// 实测：常驻 STT 服务 vs 旧 CLI（16s 中文视频），输出冷/热耗时。
//
// 用法：node scripts/probe-stt-service.mjs [视频路径]
// 默认用主目录里的 speech-video.mp4（16s 中文语音）。
// 只读视频、跑本地 python/ffmpeg；不发 QQ、不需要桥接/DSH。
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractAudioWav, extractFrameGrid, probeDuration, transcribeWav } from "../src/video-analyze.js";
import { createSttService } from "../src/stt-service.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const video = process.argv[2] || "E:\\deepseek-harness\\qq-bridge-src\\state\\speech-video.mp4";
if (!fs.existsSync(video)) {
  console.error(`找不到视频：${video}`);
  process.exit(2);
}
const stateDir = path.join(os.tmpdir(), `stt-probe-${process.pid}`);
fs.mkdirSync(stateDir, { recursive: true });

const tFrames = Date.now();
const dur = await probeDuration(video, "ffprobe");
const grid = await extractFrameGrid(video, { ffmpegPath: "ffmpeg", durationSec: dur });
const framesMs = Date.now() - tFrames;
console.log(`抽帧：${grid ? `${grid.frames} 帧 ${grid.cols}×${grid.rows}` : "失败"}，耗时 ${framesMs}ms（视频 ${dur ? Math.round(dur) : "?"}s）`);

const tExtract = Date.now();
const wav = await extractAudioWav(video, { ffmpegPath: "ffmpeg", maxSeconds: 120 });
const extractMs = Date.now() - tExtract;
if (!wav || !wav.length) {
  console.error("抽音轨失败（检查 ffmpeg / 视频是否有音轨）");
  process.exit(3);
}
console.log(`音频：${(wav.length / 1024).toFixed(0)}KB，抽音轨 ${extractMs}ms`);

const svc = createSttService({
  getConfig: () => ({ enabled: true, port: 8791, model: "small", idleUnloadMs: 1800000 }),
  scriptPath: path.join(ROOT, "tools", "stt_server.py"),
  stateDir,
  log: (line) => console.log(line),
  cliTranscribe: (buf, opts) => transcribeWav(buf, {
    python: "python",
    script: path.join(ROOT, "tools", "stt_cli.py"),
    model: opts.model,
    lang: opts.lang,
    timeoutMs: opts.timeoutMs
  })
});

const tCold = Date.now();
const cold = await svc.transcribe(wav, { model: "small", lang: "zh" });
const coldMs = Date.now() - tCold;
const tHot = Date.now();
const hot = await svc.transcribe(wav, { model: "small", lang: "zh" });
const hotMs = Date.now() - tHot;

const tCli = Date.now();
const cli = await transcribeWav(wav, {
  python: "python",
  script: path.join(ROOT, "tools", "stt_cli.py"),
  model: "small",
  lang: "zh"
});
const cliMs = Date.now() - tCli;

console.log("\n=== 结果 ===");
console.log(`服务冷启动（spawn+加载模型+转写）：${coldMs}ms  ok=${cold.ok} source=${cold.source} 字数=${String(cold.text || "").length}`);
console.log(`服务热转写（同一个进程）：${hotMs}ms  ok=${hot.ok} source=${hot.source} 字数=${String(hot.text || "").length}`);
console.log(`旧 CLI（每次重新加载模型）：${cliMs}ms  ok=${cli.ok}`);
console.log(`端到端冷（抽帧+抽音轨+服务冷转写）：${framesMs + extractMs + coldMs}ms`);
console.log(`端到端热（抽帧+抽音轨+服务热转写）：${framesMs + extractMs + hotMs}ms`);
console.log(`转写前 80 字：${String(hot.text || cold.text || "").slice(0, 80)}`);
console.log(`\nstatus: ${JSON.stringify(svc.status())}`);

await svc.stop();
try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
process.exit(cold.ok && hot.ok ? 0 : 1);
