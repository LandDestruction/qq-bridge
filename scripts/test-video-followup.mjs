// 视频语音「主动补发」离线测试（不依赖 python / ffmpeg / 真实 QQ）。
//
// 覆盖（对应交接里的测试清单）：
//   · 慢转写（模拟 20s）→ 本轮 prompt 不含转写、话术是「转写中」；转写完成后**恰好补发一次**；
//   · 快转写（模拟 200ms）→ 本轮直接带上、**不补发**；
//   · 重启恢复：已写入「已补发」集合后重建 hub，不重复补发；
//   · 去重/配额：连续两条视频各自补发一次，内容不串；
//   · 同会话补发间隔 minGapMs；空转写/失败不补发；maxChars 截断。
import assert from "node:assert/strict";
import {
  buildFollowUpMessage,
  createFollowUpHub,
  createSentStore,
  normalizeFollowUpConfig,
  videoMediaFactText
} from "../src/video-followup.js";

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("✅ " + name);
  } catch (error) {
    failed += 1;
    console.error("❌ " + name + " — " + (error?.stack ?? error?.message ?? error));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAST = { enabled: true, settleMs: 20, minGapMs: 0, maxChars: 200 };

function setup({ cfg = FAST, sent = [], send } = {}) {
  const sentCalls = [];
  const logs = [];
  const persisted = [];
  const hub = createFollowUpHub({
    config: () => cfg,
    sentStore: createSentStore(sent),
    persist: (entry) => persisted.push(entry),
    unrefTimers: false, // 测试里不能让未到期定时器被 unref 掉
    log: (line) => logs.push(line),
    send: send || (async (key, text) => { sentCalls.push({ key, text, at: Date.now() }); })
  });
  return { hub, sentCalls, logs, persisted };
}

await check("配置归一化：上限/下限/关闭开关", () => {
  const d = normalizeFollowUpConfig({});
  assert.equal(d.enabled, true);
  assert.equal(d.maxChars, 200);
  assert.equal(d.minGapMs, 3000);
  const c = normalizeFollowUpConfig({ enabled: false, maxChars: 0, minGapMs: -1 });
  assert.equal(c.enabled, false);
  assert.equal(c.maxChars, 20);
  assert.equal(c.minGapMs, 0);
});

await check("慢转写：本轮 prompt 话术是「转写中」，完成后恰好补发一次", async () => {
  // 模拟本轮等待 6s 没等到：此时 media 上只有 pending 状态。
  const fact = videoMediaFactText({ sttStatus: "pending" });
  assert.match(fact, /转写中/);
  assert.match(fact, /稍后会把转写补给你/);
  assert.doesNotMatch(fact, /没有可用的人声|我没听到/);

  const { hub, sentCalls, logs, persisted } = setup();
  const job = hub.createJob({ key: "group:1", sig: "group:1:fileA" });
  // 模拟转写又跑了 20s 才完成（期间 prompt 已发出）
  await sleep(40);
  assert.equal(sentCalls.length, 0, "转写完成前不该发任何东西");
  const p = hub.transcriptReady(job, { text: "大家好，这是一段测试语音", status: "ok", durationSec: 16 });
  assert.equal(sentCalls.length, 0, "settle 窗口内先不发");
  const result = await p;
  assert.equal(result.sent, true);
  assert.equal(sentCalls.length, 1, "恰好补发一次");
  assert.match(sentCalls[0].text, /刚才那条视频的语音我听出来了/);
  assert.match(sentCalls[0].text, /大家好，这是一段测试语音/);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].sig, "group:1:fileA");
  assert.ok(logs.some((l) => /补发=是/.test(l)));
  await sleep(80);
  assert.equal(sentCalls.length, 1, "定时器/重复调用都不能再发");
  hub.transcriptReady(job, { text: "大家好，这是一段测试语音" });
  await sleep(50);
  assert.equal(sentCalls.length, 1);
  hub.dispose();
});

await check("快转写（200ms 内赶上）：本轮直接带上，不补发", async () => {
  const cfg = { ...FAST, settleMs: 300 };
  const { hub, sentCalls, logs } = setup({ cfg });
  const job = hub.createJob({ key: "group:1", sig: "group:1:fileB" });
  const p = hub.transcriptReady(job, { text: "快速转写的内容", status: "ok" });
  // 200ms 时 prompt 组装完成并 claim（真实流程：processPromptQueue 在 sttDone 后立刻 claim）
  await sleep(200);
  hub.claim(job, "本轮 prompt 已带上");
  const r = await p;
  assert.equal(r.sent, false);
  assert.match(r.reason, /本轮 prompt 已带上/);
  await sleep(200);
  assert.equal(sentCalls.length, 0, "赶上了就不该补发");
  assert.ok(logs.some((l) => /补发=否 原因=本轮 prompt 已带上/.test(l)));
  // 已带上时给模型的事实应是转写摘要，而不是「转写中」
  const fact = videoMediaFactText({ sttStatus: "ok", summary: "[视频 16 秒｜声音里说了：“快速转写的内容”]", enrichedAt: Date.now() });
  assert.match(fact, /快速转写的内容|已抽帧/);
  hub.dispose();
});

await check("重启恢复：已补发集合持久化后重建 hub，不重复补发", async () => {
  const first = setup();
  const job1 = first.hub.createJob({ key: "group:2", sig: "group:2:fileC" });
  await first.hub.transcriptReady(job1, { text: "第一条的转写", status: "ok" });
  assert.equal(first.sentCalls.length, 1);
  const saved = first.persisted.map((e) => e.sig);
  assert.deepEqual(saved, ["group:2:fileC"]);
  first.hub.dispose();

  // 重建 hub（等价于桥接重启后从 social-v2.json 恢复）
  const second = setup({ sent: saved });
  const job2 = second.hub.createJob({ key: "group:2", sig: "group:2:fileC" });
  const r = await second.hub.transcriptReady(job2, { text: "第一条的转写", status: "ok" });
  assert.equal(r.sent, false);
  assert.match(r.reason, /已经补发过/);
  assert.equal(second.sentCalls.length, 0, "重启后不能重复补发");
  second.hub.dispose();
});

await check("连续两条视频：各自补发一次，内容不串", async () => {
  const { hub, sentCalls } = setup();
  const a = hub.createJob({ key: "group:3", sig: "group:3:fileA" });
  const b = hub.createJob({ key: "group:3", sig: "group:3:fileB" });
  const [ra, rb] = await Promise.all([
    hub.transcriptReady(a, { text: "第 A 条视频说的话", status: "ok" }),
    hub.transcriptReady(b, { text: "第 B 条视频说的话", status: "ok" })
  ]);
  assert.equal(ra.sent, true);
  assert.equal(rb.sent, true);
  assert.equal(sentCalls.length, 2);
  const texts = sentCalls.map((c) => c.text);
  assert.ok(texts.some((t) => /第 A 条视频说的话/.test(t) && !/第 B 条/.test(t)));
  assert.ok(texts.some((t) => /第 B 条视频说的话/.test(t) && !/第 A 条/.test(t)));
  hub.dispose();
});

await check("同会话 minGapMs：两条同时转完也会错开发送", async () => {
  const cfg = { ...FAST, settleMs: 10, minGapMs: 120 };
  const { hub, sentCalls } = setup({ cfg });
  const a = hub.createJob({ key: "group:4", sig: "group:4:a" });
  const b = hub.createJob({ key: "group:4", sig: "group:4:b" });
  const [ra, rb] = await Promise.all([
    hub.transcriptReady(a, { text: "A 内容" }),
    hub.transcriptReady(b, { text: "B 内容" })
  ]);
  assert.equal(ra.sent, true);
  assert.equal(rb.sent, true);
  assert.equal(sentCalls.length, 2);
  const gap = sentCalls[1].at - sentCalls[0].at;
  assert.ok(gap >= 100, `两条补发间隔应 >= minGap（实际 ${gap}ms）`);
  hub.dispose();
});

await check("空转写 / 无音轨 / 转写失败：不补发，原因明确", async () => {
  const { hub, sentCalls, logs } = setup();
  const noAudio = hub.createJob({ key: "group:5", sig: "group:5:noaudio" });
  const r1 = await hub.transcriptReady(noAudio, { text: "", status: "no-audio", error: "" });
  assert.equal(r1.sent, false);
  assert.match(r1.reason, /没有可用的人声/);
  assert.match(videoMediaFactText({ sttStatus: "no-audio" }), /没有可用的人声/);

  const bad = hub.createJob({ key: "group:5", sig: "group:5:bad" });
  const r2 = await hub.transcriptReady(bad, { text: "", status: "failed", error: "解码失败" });
  assert.equal(r2.sent, false);
  assert.match(r2.reason, /转写失败/);
  assert.match(videoMediaFactText({ sttStatus: "failed", sttError: "解码失败" }), /语音转写失败（解码失败）/);

  assert.equal(sentCalls.length, 0);
  assert.ok(logs.some((l) => /补发=否 原因=这条视频没有可用的人声/.test(l)));
  hub.dispose();
});

await check("发送失败不记为已补发（下次还有机会）", async () => {
  const persisted = [];
  let attempts = 0;
  const send = async () => { attempts += 1; throw new Error("QQ 断线"); };
  const hub = createFollowUpHub({
    config: () => FAST,
    sentStore: createSentStore([]),
    persist: (e) => persisted.push(e),
    unrefTimers: false,
    send
  });
  const job = hub.createJob({ key: "group:6", sig: "group:6:x" });
  const r = await hub.transcriptReady(job, { text: "有内容但发送失败" });
  assert.equal(r.sent, false);
  assert.match(r.reason, /发送异常/);
  assert.equal(persisted.length, 0, "发送失败不能写「已补发」");
  assert.equal(attempts, 1);
  hub.dispose();
});

await check("补发关闭：enabled=false 不发但日志给原因", async () => {
  const cfg = { ...FAST, enabled: false };
  const { hub, sentCalls, logs } = setup({ cfg });
  const job = hub.createJob({ key: "group:7", sig: "group:7:x" });
  const r = await hub.transcriptReady(job, { text: "内容" });
  assert.equal(r.sent, false);
  assert.match(r.reason, /补发已关闭/);
  assert.equal(sentCalls.length, 0);
  assert.ok(logs.some((l) => /补发=否/.test(l)));
  hub.dispose();
});

await check("maxChars 截断补发文案（不把整段转写刷进群）", async () => {
  const cfg = { ...FAST, maxChars: 30 };
  const { hub, sentCalls } = setup({ cfg });
  const long = "这是一段很长的转写".repeat(20);
  const job = hub.createJob({ key: "group:8", sig: "group:8:long" });
  await hub.transcriptReady(job, { text: long });
  assert.equal(sentCalls.length, 1);
  const body = sentCalls[0].text.replace(/^刚才那条视频的语音我听出来了：/, "");
  assert.ok(Array.from(body).length <= 31, `补发正文应被截断到 30 字（实际 ${Array.from(body).length}）`);
  assert.match(body, /…$/);
  // 纯函数同样可测
  assert.equal(buildFollowUpMessage({ text: "" }), "");
  hub.dispose();
});

if (failed) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log("\n🎉 视频转写主动补发测试通过");
