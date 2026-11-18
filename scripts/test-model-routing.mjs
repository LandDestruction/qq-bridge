import assert from "node:assert/strict";
import { normalizeRouting, resolveModelChoice, normalizeModelRef } from "../src/model-routing.js";
let failed = 0;
function check(n, f) { try { f(); console.log("✅ " + n); } catch (e) { failed++; console.error("❌ " + n + " — " + (e?.message ?? e)); } }
const IDLE = { provider: "workbuddy2api", model: "deepseek-v4.1-flash" };
const PEAK = { provider: "xiaomi-mimo", model: "mimo-v2.6-flash" };
const MEDIA = { provider: "deepseek-account", model: "deepseek-flash" };
const FB1 = { provider: "deepseek-account", model: "deepseek-v4-pro" };
const R = normalizeRouting({ idle: IDLE, peak: PEAK, fallback: [FB1], disabled: [{ provider: "scnet", model: "x" }] });

check("高峰 → peak", () => assert.deepEqual(resolveModelChoice({ routing: R, isPeak: true }), { ...PEAK, source: "peak" }));
check("空闲 → idle", () => assert.deepEqual(resolveModelChoice({ routing: R, isPeak: false }), { ...IDLE, source: "idle" }));
check("media 优先于 peak/idle", () => assert.deepEqual(resolveModelChoice({ routing: R, media: MEDIA, isPeak: true }), { ...MEDIA, source: "media" }));
check("高峰模型 disabled → 落到 idle", () => {
  const r2 = normalizeRouting({ idle: IDLE, peak: PEAK, disabled: [PEAK] });
  assert.deepEqual(resolveModelChoice({ routing: r2, isPeak: true }), { ...IDLE, source: "idle" });
});
check("idle 不可用（不在 available）→ fallback 顺序第一个可用", () => {
  const r3 = normalizeRouting({ idle: IDLE, peak: PEAK, fallback: [FB1, { provider: "a", model: "b" }] });
  const picked = resolveModelChoice({ routing: r3, isPeak: false, available: [PEAK, FB1] });
  assert.deepEqual(picked, { ...FB1, source: "fallback" });
});
check("bad() 标记的模型被跳过", () => {
  const r4 = normalizeRouting({ idle: IDLE, peak: PEAK });
  const picked = resolveModelChoice({ routing: r4, isPeak: false, bad: (m) => m.model === IDLE.model });
  assert.equal(picked, null, "idle 与 peak 都不满足时返回 null（调用方回退 cfg 默认）");
});
check("peak 关闭（isPeak=false）且 idle 为空 → fallback", () => {
  const r5 = normalizeRouting({ peak: PEAK, fallback: [FB1] });
  assert.deepEqual(resolveModelChoice({ routing: r5, isPeak: false }), { ...FB1, source: "fallback" });
});
check("全部不可用 → null", () => {
  const r6 = normalizeRouting({ idle: IDLE, peak: PEAK, fallback: [FB1] });
  assert.equal(resolveModelChoice({ routing: r6, isPeak: true, available: [{ provider: "z", model: "z" }] }), null);
});
check("normalizeRouting：去重、最多 5 项、空值归一", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ provider: "p", model: `m${i % 3}` }));
  const r = normalizeRouting({ fallback: many, disabled: null, idle: { provider: "", model: "x" } });
  assert.equal(r.fallback.length, 3, "重复项去重后 3 个");
  assert.equal(r.idle, null);
  assert.deepEqual(r.disabled, []);
});
// 2026-10-26 事故回归：面板 /ops 发的是 "provider/model" 字符串，旧版只认对象 →
// 保存一次就把 config.json 的 modelRouting 写成 {idle:null,peak:null,fallback:[],disabled:[]}。
check("normalizeModelRef：字符串 'provider/model' 与对象等价", () => {
  assert.deepEqual(normalizeModelRef("xai/mimo-v2.6-flash"), { provider: "xai", model: "mimo-v2.6-flash" });
  assert.deepEqual(normalizeModelRef("  workbuddy2api / glm-5.3  "), { provider: "workbuddy2api", model: "glm-5.3" });
  assert.deepEqual(normalizeModelRef({ provider: "p", model: "m" }), { provider: "p", model: "m" });
});
check("normalizeModelRef：\"none\" 是「不调用模型」的哨兵，不能被当成空值回落到默认模型", () => {
  assert.deepEqual(normalizeModelRef("none"), { provider: "none", model: "none" });
  assert.deepEqual(normalizeModelRef("none/none"), { provider: "none", model: "none" });
  const r = normalizeRouting({ idle: "none", peak: { provider: "none", model: "none" } });
  assert.deepEqual(r.idle, { provider: "none", model: "none" });
  assert.deepEqual(r.peak, { provider: "none", model: "none" });
});

check("normalizeModelRef：残缺输入一律 null（不抛）", () => {
  for (const bad of ["", "   ", "noprovider", "/model", "provider/", 123, null, undefined, {}, { provider: "p" }, { model: "m" }, []]) {
    assert.equal(normalizeModelRef(bad), null, JSON.stringify(bad));
  }
});
check("normalizeRouting：面板字符串载荷不再被清空", () => {
  const r = normalizeRouting({
    idle: "workbuddy2api/deepseek-v4.1-flash",
    peak: "xiaomi-mimo/mimo-v2.6-flash",
    fallback: ["deepseek-account/deepseek-flash", { provider: "deepseek-account", model: "deepseek-v4-pro" }],
    disabled: ["scnet/DeepSeek-V4.1-Flash-1017-Event"]
  });
  assert.deepEqual(r.idle, { provider: "workbuddy2api", model: "deepseek-v4.1-flash" });
  assert.deepEqual(r.peak, { provider: "xiaomi-mimo", model: "mimo-v2.6-flash" });
  assert.equal(r.fallback.length, 2, "字符串与对象混发都收");
  assert.deepEqual(r.disabled, [{ provider: "scnet", model: "DeepSeek-V4.1-Flash-1017-Event" }]);
  assert.deepEqual(resolveModelChoice({ routing: r, isPeak: true }), { provider: "xiaomi-mimo", model: "mimo-v2.6-flash", source: "peak" });
});
if (failed) process.exit(1);
console.log("\n🎉 模型路由测试通过");
