// 端到端（离线 fixture）：视频消息 → 抽帧/转写 → 本轮 prompt → 主动补发。
//
// 用真实桥接代码（VM harness）+ 假 STT 服务 + 假 ffmpeg，验证用户实测的两个痛点：
//   1. 慢转写（模拟 20s，超过本轮 6s 上限）→ 本轮 prompt 写「转写中」，
//      转写完成后**恰好补发一次**「刚才那条视频的语音我听出来了：…」；
//   2. 快转写（200ms）→ 本轮 prompt 直接带上转写，**不补发**。
import assert from "node:assert/strict";
import { bridgeHarness } from "./audit-bridge-harness.mjs";
import { createFollowUpHub, videoMediaFactText } from "../src/video-followup.js";

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sttConfig({ inlineWaitMs, settleMs = 40 }) {
  return {
    sendDelayMs: 0, // 测试不睡真人的分条间隔，补发要能立刻观测
    socialV2: {
      enabled: true,
      stt: {
        videoModel: "small",
        lang: "zh",
        maxChars: 600,
        inlineWaitMs,
        service: { enabled: true, port: 8791, model: "small" },
        followUp: { enabled: true, maxChars: 200, minGapMs: 0, settleMs }
      }
    }
  };
}

/** 隔离的桥接 fixture：假网络（返回 mp4 字节）+ 假 ffmpeg + 可控制的转写。 */
async function makeFixture({ inlineWaitMs, transcribe, settleMs = 40, audio = true }) {
  const sttCalls = [];
  const fakeStt = {
    async transcribe(wav, opts) {
      sttCalls.push({ bytes: wav?.length ?? 0, model: opts?.model, lang: opts?.lang });
      return transcribe();
    },
    status: () => ({ enabled: true, running: true, model: "small", loadedAt: 1, lastMs: 2 }),
    refresh: async () => ({}),
    stop: async () => {},
    ensureStarted: async () => true
  };
  const h = await bridgeHarness({
    config: sttConfig({ inlineWaitMs, settleMs }),
    globals: {
      // 真实的补发协调器：它内部的 send 会走桥接的 auditAndSend → FakeBot（记录到 calls.sent）。
      createFollowUpHub,
      videoMediaFactText,
      createSttService: () => fakeStt,
      // 假 ffmpeg：不真跑子进程，16s 视频、9 帧、1KB 音频。
      probeDuration: async () => 16,
      extractFrameGrid: async () => ({ frames: 9, cols: 3, rows: 3, buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }),
      extractAudioWav: async () => (audio ? Buffer.alloc(1024, 1) : null),
      fetch: async (url) => {
        if (String(url).includes("fixture.invalid")) {
          return {
            ok: true,
            status: 200,
            body: (async function* fakeBody() { yield Buffer.from("fake-mp4-bytes"); })()
          };
        }
        return { ok: true, status: 200, json: async () => ({ status: "ok", retcode: 0, data: {} }) };
      }
    }
  });
  return { h, sttCalls };
}

function promptText(prompt) {
  return (Array.isArray(prompt?.content) ? prompt.content : []).map((c) => String(c?.text ?? "")).join("\n");
}

async function runVideo(h, text = "[视频]") {
  const media = { kind: "video-file", url: "https://fixture.invalid/v.mp4", name: "v.mp4" };
  const msg = { text, plain: text, media: [], hasMedia: true };
  const enrich = h.enrichVideoFile("group:456", media, msg);
  return { enrich, media, msg };
}

await check("慢转写：本轮 prompt 写「转写中」，转写完成后恰好补发一次", async () => {
  let resolveStt;
  const stt = new Promise((resolve) => { resolveStt = resolve; });
  const { h, sttCalls } = await makeFixture({ inlineWaitMs: 100, transcribe: () => stt });
  try {
    const { enrich, media, msg } = await runVideo(h);
    // 本轮 prompt：最多等 100ms 转写，等不到就走
    await h.deliverPrompt("group:456", "看看这个视频说了什么", { media: [media] });
    assert.equal(h.calls.prompts.length, 1, "应投递一轮 prompt");
    const text = promptText(h.calls.prompts[0]);
    assert.match(text, /语音转写中/);
    assert.match(text, /稍后会把转写补给你/);
    assert.doesNotMatch(text, /声音里说了/);
    assert.doesNotMatch(text, /没有可用的人声|语音转写失败/);
    assert.equal(sttCalls.length, 1, "应走服务转写");
    assert.equal(h.calls.sent.length, 0, "转写完成前不该补发");

    resolveStt({ ok: true, text: "这是一段真实转写", segments: [], lang: "zh", model: "small", source: "service", ms: 12 });
    await enrich;
    await sleep(150); // settleMs(40) + 余量
    assert.equal(h.calls.sent.length, 1, "转写完成后应恰好补发一次");
    const sentText = String(h.calls.sent[0].text);
    assert.match(sentText, /刚才那条视频的语音我听出来了/);
    assert.match(sentText, /这是一段真实转写/);
    assert.equal(h.videoFollowUps.sentCount(), 1, "已补发集合应记录 1 条");
    // 转写也回填进了消息正文：下一轮上下文/媒体事实里能看到，不再是「转写中」。
    assert.match(String(msg.text), /声音：“这是一段真实转写”/);
    assert.equal(media.sttStatus, "ok");
    const refact = videoMediaFactText(media);
    assert.match(refact, /声音原话转写：“这是一段真实转写”/);
  } finally {
    await h.close();
  }
});

await check("快转写（200ms 内赶上）：本轮直接带上，不补发", async () => {
  const { h, sttCalls } = await makeFixture({
    inlineWaitMs: 2000,
    transcribe: async () => {
      await sleep(150); // 模拟热服务 ~150ms
      return { ok: true, text: "快速语音内容", segments: [], lang: "zh", model: "small", source: "service", ms: 150 };
    }
  });
  try {
    const { enrich, media, msg } = await runVideo(h);
    await h.deliverPrompt("group:456", "看看这个视频说了什么", { media: [media] });
    await enrich;
    await sleep(150);
    assert.equal(sttCalls.length, 1);
    const text = promptText(h.calls.prompts[0]);
    assert.match(text, /声音原话转写：“快速语音内容”/, "赶上了就必须把转写带进本轮 prompt");
    assert.doesNotMatch(text, /语音转写中/);
    assert.equal(h.calls.sent.length, 0, "已经带上就绝不补发");
    assert.equal(h.videoFollowUps.sentCount(), 0);
  } finally {
    await h.close();
  }
});

await check("无音轨视频：本轮 prompt 明确说「没有可用的人声」，不补发", async () => {
  const { h, sttCalls } = await makeFixture({ inlineWaitMs: 100, audio: false, transcribe: async () => ({ ok: true, text: "不该被调用" }) });
  try {
    const { enrich, media, msg } = await runVideo(h);
    await h.deliverPrompt("group:456", "这个视频有声音吗", { media: [media] });
    await enrich;
    await sleep(150);
    const text = promptText(h.calls.prompts[0]);
    assert.match(text, /没有可用的人声/, "没有音轨时必须直说，而不是「听不到」");
    assert.doesNotMatch(text, /语音转写中/);
    assert.equal(sttCalls.length, 0, "没有音轨时不应调用转写");
    assert.equal(h.calls.sent.length, 0, "没有转写内容不补发");
    // 会话语录里只写事实（声音：无），给模型的判断/指令只进 prompt 与日志
    assert.match(String(msg.text), /声音：无/, "会话语录应只标「没有声音」");
    assert.doesNotMatch(String(msg.text), /不要臆测声音内容|别猜、别复述/, "模型指令不该写进消息正文");
    assert.match(text, /不要臆测声音内容/, "prompt 里仍要有「别臆测」的约束");
  } finally {
    await h.close();
  }
});

await check("reserved2 唤醒快照：视频转写中也要给「稍后补给你」的事实", async () => {
  const { h } = await makeFixture({ inlineWaitMs: 100, transcribe: async () => ({ ok: true, text: "x" }) });
  try {
    const st = h.getSocialV2State("group:456");
    st.unread.push({
      seq: 1, sender: "群友", userId: "111", text: "[视频]", plain: "[视频]",
      media: [{ kind: "video-file", file: "f1", sttStatus: "pending" }],
      hasMedia: true, time: Date.now()
    });
    const snapshot = JSON.stringify(h.buildWakeSnapshotV2("group:456"));
    assert.match(snapshot, /语音转写中/);
    assert.match(snapshot, /稍后会把转写补给你/);
    assert.doesNotMatch(snapshot, /没有可用的人声/);
  } finally {
    await h.close();
  }
});

await check("reserved2 唤醒快照：已转完但没声音的视频，也要补一句「别臆测」", async () => {
  const { h } = await makeFixture({ inlineWaitMs: 100, transcribe: async () => ({ ok: true, text: "x" }) });
  try {
    const st = h.getSocialV2State("group:456");
    st.unread.push({
      seq: 2, sender: "群友", userId: "111", text: "[视频 6 秒]\n声音：无", plain: "[视频 6 秒]\n声音：无",
      media: [{ kind: "video-file", file: "f2", sttStatus: "no-audio", enrichedAt: Date.now() }],
      hasMedia: true, time: Date.now()
    });
    const snapshot = JSON.stringify(h.buildWakeSnapshotV2("group:456"));
    assert.match(snapshot, /不要臆测声音内容/, "快照里要有别臆测的约束（正文已经没有这句了）");
    assert.match(snapshot, /声音：无/, "事实仍然在正文里");
  } finally {
    await h.close();
  }
});

if (failed) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log("\n🎉 视频转写端到端（慢/快/无音轨）测试通过");
