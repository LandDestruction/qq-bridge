import { readBridgeSource } from './bridge-source.mjs';
// 上下文连续性：快照形状 / 水位线 / 截断 / 纯媒体入库
// 设计前提（不是 bug）：unread 是「最旧优先」— 预算截断时不能悄悄确认没看见的消息，
// 所以 readThroughSeq 只推进到被包含的最后一条；剩余未读留给下一轮。
import assert from "node:assert/strict";
import fs from "node:fs";
import { bridgeHarness } from "./audit-bridge-harness.mjs";

const KEY = "group:100000006";
let failed = 0;
async function check(n, f) { try { await f(); console.log("✅ " + n); } catch (e) { failed++; console.error("❌ " + n + " — " + (e?.message ?? e)); } }

const h = await bridgeHarness({ config: { socialV2: { context: { recentLimit: 100, unreadLimit: 30, wakeMessageLimit: 16, wakeRecentLimit: 4, wakeMaxChars: 6000 } } } });
const st = h.getSocialV2State(KEY);
let n = 0;
function append(text, { media = [] } = {}) {
  n += 1;
  h.appendSocialV2Message(KEY, `群友${n}`, text, text, false, false, `m${n}`, media, String(1000 + n), []);
}
// 20 条历史 + 3 条未读：把前 20 条从 unread 移出（模拟已读）
for (let i = 1; i <= 20; i += 1) append(`历史消息 ${i}`);
append("未读消息 A");
append("未读消息 B");
append("未读消息 C");
st.unread.splice(0, Math.max(0, st.unread.length - 3));

const snap = h.buildWakeSnapshotV2(KEY);
await check("快照：3 条未读按原顺序、每条带 sender/时间", async () => {
  const texts = snap.messages.map((m) => String(m.text ?? "").trim());
  assert.equal(texts.slice(-3).join("|"), "未读消息 A|未读消息 B|未读消息 C", `实得 ${JSON.stringify(texts)}`);
  for (const m of snap.messages) {
    assert.ok(String(m.sender || "").length > 0, "sender 不能为空");
    assert.ok(String(m.at || "").length > 0, "at（时间）不能为空");
    assert.ok(String(m.ago || "").length > 0, "ago（多久以前）不能为空");
  }
});
await check("水位线：readThroughSeq = 最后一条被包含消息的 seq", async () => {
  const maxIncluded = Math.max(...snap.messages.map((m) => Number(m.seq)));
  assert.equal(Number(snap.readThroughSeq), maxIncluded);
  assert.equal(typeof snap.partial, "boolean");
});
await check("积压 > wakeMessageLimit：只给最旧的 N 条，partial=true，剩余留给下一轮", async () => {
  const h2 = await bridgeHarness({ config: { socialV2: { context: { wakeMessageLimit: 3, wakeRecentLimit: 0 } } } });
  const st2 = h2.getSocialV2State("group:1");
  for (let i = 1; i <= 8; i += 1) h2.appendSocialV2Message("group:1", `u${i}`, `m${i}`, `m${i}`, false, false, `x${i}`, [], String(i), []);
  const s2 = h2.buildWakeSnapshotV2("group:1");
  assert.equal(s2.messages.length, 3, "最多 3 条");
  assert.equal(s2.messages.map((m) => m.text).join("|"), "m1|m2|m3", `最旧优先，实得 ${JSON.stringify(s2.messages.map((m) => m.text))}`);
  assert.equal(s2.partial, true, "还有没被包含的未读");
  assert.equal(Number(s2.readThroughSeq), Number(s2.messages[2].seq));
});
await check("wakeMaxChars 截断按条进行（不整段丢弃）", async () => {
  const h3 = await bridgeHarness({ config: { socialV2: { context: { wakeMessageLimit: 50, wakeRecentLimit: 0, wakeMaxChars: 500 } } } });
  for (let i = 1; i <= 12; i += 1) h3.appendSocialV2Message("group:2", `u${i}`, "很长的消息".repeat(20), "很长的消息".repeat(20), false, false, `y${i}`, [], String(i), []);
  const s3 = h3.buildWakeSnapshotV2("group:2");
  assert.ok(s3.messages.length > 0 && s3.messages.length < 12, "应只装下一部分");
  assert.ok(JSON.stringify(s3).length <= 500 + 200, "总量受 wakeMaxChars 约束");
});
await check("wakeRecentLimit=0 不报错", async () => {
  const h4 = await bridgeHarness({ config: { socialV2: { context: { wakeRecentLimit: 0 } } } });
  h4.appendSocialV2Message("group:3", "u", "hi", "hi", false, false, "z1", [], "1", []);
  const s4 = h4.buildWakeSnapshotV2("group:3");
  assert.ok(Array.isArray(s4.messages));
});
await check("静态：纯媒体消息在入库后 return（不再直接丢弃）", async () => {
  const src = readBridgeSource();
  const i = src.indexOf("if (!plainContent && !quoteTargetIsSelf) {");
  assert.ok(i > 0, "该分支应已改造");
  const seg = src.slice(i, i + 900);
  assert.ok(seg.includes("appendSocialV2Message("), "应在分支内入库");
  assert.ok(seg.includes("[媒体]") || seg.includes("placeholder"), "应有占位文本");
});
if (failed) process.exit(1);
console.log("\n🎉 上下文连续性测试通过");
