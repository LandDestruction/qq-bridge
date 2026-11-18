// ffprobe 路径解析的离线断言（不需要真的装 ffmpeg / ffprobe）。
//
// 为什么单独一条：旧实现是 `ffmpegPath.replace(/ffmpeg\.exe$/i, 'ffprobe.exe')`，
// 只有把配置写成 `...\ffmpeg.exe` 时才成立；写成 `ffmpeg`（走 PATH）或 `/usr/bin/ffmpeg`
// 时，ffprobe 拿到的是 **ffmpeg 自己的路径** —— probeDuration 返回 null 且不留日志，
// 表现为「视频时长、声音转写整个静默消失」。这条测试把三种配置形态钉住。
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { resolveFfprobePath, probeDuration, runCommandAsync } from '../src/video-analyze.js';

let failed = 0;
async function checkAsync(name, fn) {
  try { await fn(); console.log(`✅ ${name}`); }
  catch (error) { failed += 1; console.error(`❌ ${name} — ${error?.message ?? error}`); }
}
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); }
  catch (error) { failed += 1; console.error(`❌ ${name} — ${error.message}`); }
}

const win = (f) => f.endsWith('.exe') && path.basename(f).toLowerCase() === 'ffprobe.exe';
const nothing = () => false;

check('配置成绝对路径 ffmpeg.exe → 同目录 ffprobe.exe', () => {
  const got = resolveFfprobePath('C:\\tools\\ffmpeg.exe', { env: {}, exists: win });
  assert.equal(got, 'C:\\tools\\ffprobe.exe');
});

check('配置成不带扩展名的 ffmpeg → 同目录找到 ffprobe.exe', () => {
  const got = resolveFfprobePath('C:\\tools\\ffmpeg', { env: {}, exists: win });
  assert.equal(got, 'C:\\tools\\ffprobe.exe');
});

check('同目录没有 ffprobe → 回落到 PATH 上的 ffprobe', () => {
  const got = resolveFfprobePath('C:\\tools\\ffmpeg.exe', { env: {}, exists: nothing });
  assert.match(got, /^ffprobe(\.exe)?$/);
});

check('裸 ffmpeg（走 PATH）→ 不再拼出 "ffmpeg" 自己', () => {
  const got = resolveFfprobePath('ffmpeg', { env: {}, exists: nothing });
  assert.match(got, /^ffprobe(\.exe)?$/);
  assert.notEqual(got, 'ffmpeg');
});

check('FFPROBE_PATH 环境变量最优先', () => {
  const got = resolveFfprobePath('C:\\tools\\ffmpeg.exe', { env: { FFPROBE_PATH: 'D:\\bin\\pp.exe' }, exists: win });
  assert.equal(got, 'D:\\bin\\pp.exe');
});

check('已经配成 ffprobe 时不重复改写', () => {
  assert.equal(resolveFfprobePath('C:\\tools\\ffprobe.exe', { env: {}, exists: win }), 'C:\\tools\\ffprobe.exe');
});

check('空值/undefined 不抛错', () => {
  const got = resolveFfprobePath(undefined, { env: {}, exists: nothing });
  assert.match(got, /^ffprobe(\.exe)?$/);
});

// ── 视频分析必须异步：同步 spawn 会卡住整个事件循环（一条视频几十秒到几分钟）───
await checkAsync('probeDuration 返回 Promise（不是同步阻塞）', async () => {
  const p = probeDuration('nonexistent.mp4', 'definitely-not-a-real-ffprobe');
  assert.ok(p && typeof p.then === 'function', 'probeDuration 必须返回 Promise');
  assert.equal(await p, null, '探测失败应返回 null，不抛错');
});

await checkAsync('runCommandAsync 不阻塞事件循环：慢命令期间定时器仍能按时触发', async () => {
  const started = Date.now();
  let timerFiredAt = 0;
  const timer = setTimeout(() => { timerFiredAt = Date.now() - started; }, 80);
  // 用 node 自己当「子进程」跑 400ms，模拟 ffmpeg 这种慢命令
  const r = await runCommandAsync(process.execPath, ['-e', 'setTimeout(()=>{},400)'], { timeoutMs: 5000 });
  clearTimeout(timer);
  assert.equal(r.ok, true, '子进程应正常结束');
  assert.ok(timerFiredAt > 0 && timerFiredAt < 350, `定时器应在子进程结束前触发（实得 ${timerFiredAt}ms），否则说明被阻塞了`);
});

await checkAsync('runCommandAsync 超时会主动 kill 并返回错误', async () => {
  const r = await runCommandAsync(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 200 });
  assert.equal(r.ok, false);
  assert.match(r.error, /超时/);
});

await checkAsync('runCommandAsync 找不到可执行文件不抛错', async () => {
  const r = await runCommandAsync('definitely-not-a-real-binary-xyz', [], { timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

check('extractAudioWav 必须带 -t 时长上限（否则长视频生成几百 MB wav）', () => {
  const src = fs.readFileSync(new URL('../src/video-analyze.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function extractAudioWav'));
  const body = fn.slice(0, fn.indexOf('/** 调 tools/stt_cli.py'));
  assert.ok(/"-t", String\(cap\)/.test(body), 'extractAudioWav 的参数里必须出现 -t 与截断秒数');
  assert.ok(/maxSeconds = 300/.test(fn), 'maxSeconds 必须有默认上限');
});

if (failed) {
  console.error(`\n❌ ffprobe 路径解析测试失败（${failed} 项）`);
  process.exit(1);
}
console.log('\n🎉 ffprobe 路径解析测试通过');
