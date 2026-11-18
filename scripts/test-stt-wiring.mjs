import { readBridgeSource } from './bridge-source.mjs';
// 桥接接线静态断言：常驻 STT 服务 + 迟到补发 + 诚实话术真的接上了。
//
// 为什么不跑桥接本体：bridge.js 是 16000+ 行单体，离线起不来（需要 SnowLuma/DSH）。
// 行为逻辑已在 test-stt-service / test-video-followup 里用假服务测过；这里只防
// 「模块写好了但桥接忘了接」或「旧代码又被合并回来」这类回归。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = readBridgeSource();
const serverPy = fs.readFileSync(path.join(ROOT, "tools", "stt_server.py"), "utf8");

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("✅ " + name);
  } catch (error) {
    failed += 1;
    console.error("❌ " + name + " — " + (error?.message ?? error));
  }
}

check("桥接导入并实例化常驻 STT 服务（CLI 作为回退）", () => {
  assert.match(bridge, /import \{ createSttService \} from '\.\/stt-service\.js'/);
  assert.match(bridge, /createSttService\(\{/);
  assert.match(bridge, /cliTranscribe:[\s\S]{0,400}transcribeWav\(/);
  assert.match(bridge, /scriptPath: path\.join\(ROOT, "tools", "stt_server\.py"\)/);
});

check("视频转写走 sttService.transcribe，不再直接调 CLI", () => {
  assert.match(bridge, /await sttService\.transcribe\(w,/);
  // 视频流程里不应再出现旧的直接 transcribeWav 调用（回退路径在 createSttService 的 cliTranscribe 里）
  const videoBlock = bridge.slice(bridge.indexOf("async function enrichVideoFile"), bridge.indexOf("function maybeCollectSticker"));
  assert.doesNotMatch(videoBlock, /transcribeWav\(w,/);
  assert.match(videoBlock, /metrics\.sttSource/);
});

check("本轮只等 inlineWaitMs（默认 6s），不再硬等 90s", () => {
  assert.match(bridge, /function sttInlineWaitMs\(\)/);
  assert.match(bridge, /const inlineWaitMs = sttInlineWaitMs\(\);/);
  assert.match(bridge, /raceWithTimeout\(stages\.map\(\(t\) => t\.stt\), inlineWaitMs\)/);
  assert.doesNotMatch(bridge, /stt\?\.waitMs/);
});

check("迟到补发接上：transcriptReady + claim（赶上了不补发）", () => {
  assert.match(bridge, /videoFollowUps\.transcriptReady\(job,/);
  assert.match(bridge, /videoFollowUps\.claim\(t\.job, '本轮 prompt 已带上'\)/);
  assert.match(bridge, /videoFollowUps\.claim\(qJob,/);
  assert.match(bridge, /createFollowUpHub\(\{/);
  // 旧的 onLate / 不存在的 LongText 必须消失
  assert.doesNotMatch(bridge, /\bLongText\(/);
  assert.doesNotMatch(bridge, /t\.onLate/);
});

check("补发去重状态持久化到 social-v2.json，并在启动时恢复", () => {
  assert.match(bridge, /obj\.videoFollowUps = \{ sent: Array\.from\(videoFollowUpSent\) \}/);
  assert.match(bridge, /raw\?\.videoFollowUps\?\.sent/);
  assert.match(bridge, /videoFollowUpSent\.add\(s\)/);
});

check("话术诚实：转写中不说「听不到」，失败/无音轨给原因", () => {
  assert.match(bridge, /videoMediaFactText\(media\)/);
  // reserved2 唤醒 snapshot 不走 resolveMediaList，也要补同一句话术
  assert.match(bridge, /needHint\.map\(\(m\) => videoMediaFactText\(m\)\)/);
  // 会话语录只写事实，模型指令（别猜/别臆测）不许出现在消息正文里
  assert.doesNotMatch(bridge, /别猜、别复述/);
  assert.match(bridge, /声音：无/);
  assert.doesNotMatch(bridge, /本轮的抽帧\/语音转写还没完成/);
  // 事实话术在 src/video-followup.js（不在 src/bridge 里），单独读那份
  const factSrc = fs.readFileSync(path.join(ROOT, 'src', 'video-followup.js'), 'utf8');
  assert.match(factSrc, /这条视频没有可用的人声/);
  assert.match(factSrc, /语音转写失败/);
});

check("/api/status 暴露 sttService {running, model, loadedAt, lastMs}", () => {
  assert.match(bridge, /sttService: sttService\.status\(\)/);
});

check("引用视频不参与本轮等待，转写没赶上会补发", () => {
  assert.match(bridge, /autoClaim: false/);
  assert.match(bridge, /autoClaim !== false/);
  assert.match(bridge, /转写完成后会主动补发/);
});

check("stt_server.py 暴露 /health 与 /transcribe，支持空闲卸载与路径白名单", () => {
  assert.match(serverPy, /\/health/);
  assert.match(serverPy, /\/transcribe/);
  assert.match(serverPy, /idle-unload-ms/);
  assert.match(serverPy, /--allow-dir/);
  assert.match(serverPy, /def maybe_unload/);
  assert.match(serverPy, /ThreadingHTTPServer/);
});

check("JS/Python 语法检查通过", () => {
  for (const file of ["src/bridge.js", "src/stt-service.js", "src/video-followup.js"]) {
    const r = spawnSync(process.execPath, ["--check", path.join(ROOT, file)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${file} 语法错误：${r.stderr}`);
  }
  // 用 ast.parse 而不是 py_compile：后者会写 tools/__pycache__（不该进仓库）。
  const py = spawnSync("python", ["-c", "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read())", path.join(ROOT, "tools", "stt_server.py")], { encoding: "utf8" });
  if (py.error?.code === "ENOENT") {
    console.log("   （没有 python，跳过语法检查）");
    return;
  }
  assert.equal(py.status, 0, `stt_server.py 语法错误：${py.stderr}`);
});

if (failed) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log("\n🎉 STT 服务/补发接线静态断言通过");
