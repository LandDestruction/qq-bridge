import { readBridgeSource } from './bridge-source.mjs';
// 静态断言：所有 ttsFileName() 落盘点都必须按 synth.ext 改扩展名。
//
// 为什么用源码断言而不是行为测试：这些调用点在 bridge.js 的 HTTP 路由闭包里，
// 起真进程才能覆盖；而真正容易回退的是「又新加一个落盘点却忘了 replace」。
// 这条断言就是拦这个：grep 到 ttsFileName( 后面没有 .replace(/\.silk$/ 就失败。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const src = readBridgeSource();

// 逐行扫：出现 ttsFileName( 的行，必须在同一行出现 replace(/\.silk$/
const RE = /\.replace\(\/\\.silk\$\//;
const offenders = [];
const lines = src.split('\n');
lines.forEach((line, i) => {
  if (!line.includes('ttsFileName(')) return;
  if (line.trim().startsWith('//')) return;
  if (!RE.test(line)) offenders.push(`${i + 1}: ${line.trim().slice(0, 120)}`);
});

if (offenders.length) {
  console.error('❌ 以下 ttsFileName() 落盘点没有按 synth.ext 改扩展名：');
  for (const o of offenders) console.error('   ' + o);
  process.exit(1);
}
const count = lines.filter((l) => l.includes('ttsFileName(') && !l.trim().startsWith('//')).length;
console.log(`✅ ${count} 处 ttsFileName() 落盘点全部按 synth.ext 取扩展名`);

// ── 静态断言：观察群必须在「未授权会话」闸门之前被接住 ──────────────────────
// 线上症状：不在 allow.groups 的观察群，消息被「忽略未授权会话」直接丢掉，
// 永远到不了学习路径（messages.db 0 条）。所以 observe 分支必须出现在那句 log 之前。
const observeIdx = src.indexOf('observeLearnFromGroupMessage(event)');
const gateIdx = src.indexOf('log(`忽略未授权会话 ${key}');
if (observeIdx < 0) { console.error('❌ bridge.js 里找不到观察群学习调用'); process.exit(1); }
if (gateIdx < 0) { console.error('❌ bridge.js 里找不到「忽略未授权会话」日志'); process.exit(1); }
if (observeIdx > gateIdx) {
  console.error('❌ 观察群学习调用在「忽略未授权会话」之后 —— 观察群消息会被丢掉');
  process.exit(1);
}
console.log('✅ 观察群学习调用在「忽略未授权会话」之前（不会被当未授权丢掉）');

// ── 静态断言：出图在观察群里必须被拦（只看不说）─────────────────────────────
const drawIdx = src.indexOf("url.pathname === '/api/socialV2/draw'");
const obsGuard = src.indexOf('这是观察学习群：只收集词汇/表情，不发图不发言');
if (drawIdx < 0 || obsGuard < 0) { console.error('❌ 找不到 draw 路由或观察群出图守卫'); process.exit(1); }
if (obsGuard < drawIdx) { console.error('❌ 观察群出图守卫不在 draw 路由里'); process.exit(1); }
console.log('✅ 观察群出图守卫位于 /api/socialV2/draw 路由内');

// ── 静态断言：观察配置自查接口必须存在（B/审阅都靠它验收）─────────────────────
if (!src.includes("url.pathname === '/api/observe/config'")) {
  console.error('❌ 缺少 GET /api/observe/config 路由');
  process.exit(1);
}
console.log('✅ GET /api/observe/config 路由存在');

// ── 静态断言：video-file 不得落进图片抓取分支（会把 mp4 当图片 fetch）──────────
if (!src.includes("media.kind === 'video-file'") || !src.includes("videoMediaFactText(media)")) {
  console.error("❌ resolveMediaList 缺少 video-file 分支（mp4 会被当图片抓取）");
  process.exit(1);
}
const loopIdx = src.indexOf("async function resolveMediaList");
const fetchIdx = src.indexOf("const img = await fetchOneBotImage(media);", loopIdx);
const skipIdx = src.indexOf("media.kind === 'video-file'", loopIdx);
if (!(skipIdx > loopIdx && fetchIdx > skipIdx)) {
  console.error("❌ video-file 分支必须出现在 fetchOneBotImage 之前");
  process.exit(1);
}
console.log("✅ video-file 在图片抓取之前被分流");

// ── 静态断言：引用里的视频不得进图片抓取；fetchOneBotImage 有防御 ──
if (!src.includes("引用里的视频未做抽帧/转写")) { console.error("❌ 引用媒体缺少视频分支"); process.exit(1); }
if (!src.includes("拒绝把视频当图片抓取")) { console.error("❌ fetchOneBotImage 缺少视频防御"); process.exit(1); }
if (!src.includes("classifyAttachment({ segType: 'file'")) { console.error("❌ file 段未走 classifyAttachment"); process.exit(1); }
console.log("✅ 引用/文件段/抓取三处都按 classifyAttachment 分流");

// ── 静态断言：视频 enrich 必须在 prompt 组装前被有限等待 ──
if (!src.includes("pendingVideoEnrich")) { console.error("❌ 缺少视频任务登记"); process.exit(1); }
const pq = src.indexOf("async function processPromptQueue");
const framesWait = src.indexOf("raceWithTimeout(stages.map((t) => t.frames), 8000)", pq);
const sttWait = src.indexOf("raceWithTimeout(stages.map((t) => t.stt), inlineWaitMs)", pq);
if (!(framesWait > pq)) { console.error("❌ processPromptQueue 里没有「抽帧 ≤8s」等待"); process.exit(1); }
if (!(sttWait > pq) || !src.includes("function sttInlineWaitMs()")) { console.error("❌ processPromptQueue 里没有「转写 ≤inlineWaitMs」等待"); process.exit(1); }
console.log("✅ 视频两段等待（帧 ≤8s、转写 ≤stt.inlineWaitMs 默认 6s）");
