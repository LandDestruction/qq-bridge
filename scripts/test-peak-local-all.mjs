import assert from "node:assert/strict";
import { peakLocalCfg, shouldPeakLocal, consumePeakQuota } from "../src/peak-local.js";
let failed = 0;
function check(n, f) { try { f(); console.log("✅ " + n); } catch (e) { failed++; console.error("❌ " + n + " — " + (e?.message ?? e)); } }

check("默认：replyToAll=true、requireMention=false、护栏默认值", () => {
  const c = peakLocalCfg(undefined);
  assert.equal(c.replyToAll, true);
  assert.equal(c.requireMention, false);
  assert.equal(c.minChars, 2);
  assert.equal(c.skipMediaOnly, true);
  assert.equal(c.maxRepliesPerMinute, 6);
  assert.equal(c.maxRepliesPerHour, 60);
});
check("replyToAll=true：任何角色都能接（不看 role/userIds）", () => {
  const on = peakLocalCfg({ enabled: true });
  assert.equal(shouldPeakLocal({ cfg: on, role: "member", mentioned: false, uid: "1", text: "这游戏确实好玩" }).ok, true);
  assert.equal(shouldPeakLocal({ cfg: on, role: "", mentioned: false, uid: "2", text: "真的假的" }).ok, true);
});
check("replyToAll=true：太短/纯标点/纯媒体拒绝", () => {
  const on = peakLocalCfg({ enabled: true });
  assert.equal(shouldPeakLocal({ cfg: on, role: "member", text: "啊" }).ok, false);
  assert.equal(shouldPeakLocal({ cfg: on, role: "member", text: "。。。！" }).ok, false);
  assert.equal(shouldPeakLocal({ cfg: on, role: "member", text: "", hasMedia: true }).ok, false);
  assert.equal(shouldPeakLocal({ cfg: on, role: "member", text: "看图", hasMedia: true }).ok, true);
});
check("replyToAll=false：回旧逻辑（role/userIds + requireMention）", () => {
  const legacy = peakLocalCfg({ enabled: true, replyToAll: false });
  assert.equal(shouldPeakLocal({ cfg: legacy, role: "owner", mentioned: true, text: "你好" }).ok, true);
  assert.equal(shouldPeakLocal({ cfg: legacy, role: "member", mentioned: true, text: "你好" }).ok, false);
  assert.equal(shouldPeakLocal({ cfg: legacy, role: "owner", mentioned: false, text: "你好" }).ok, false);
  const uid = peakLocalCfg({ enabled: true, replyToAll: false, userIds: ["100000006"] });
  assert.equal(shouldPeakLocal({ cfg: uid, role: "member", mentioned: true, uid: "100000006", text: "你好" }).ok, true);
});
check("限频：每分钟 2 次、每小时 5 次，跨分钟/跨小时恢复，按 key 独立", () => {
  const store = new Map();
  const t0 = 1_000_000;
  assert.equal(consumePeakQuota(store, "group:1", { now: t0, perMinute: 2, perHour: 5 }).ok, true);
  assert.equal(consumePeakQuota(store, "group:1", { now: t0 + 1000, perMinute: 2, perHour: 5 }).ok, true);
  assert.equal(consumePeakQuota(store, "group:1", { now: t0 + 2000, perMinute: 2, perHour: 5 }).ok, false);
  assert.equal(consumePeakQuota(store, "group:1", { now: t0 + 61000, perMinute: 2, perHour: 5 }).ok, true, "跨分钟恢复");
  assert.equal(consumePeakQuota(store, "group:1", { now: t0 + 62000, perMinute: 2, perHour: 5 }).ok, true);
  assert.equal(consumePeakQuota(store, "group:1", { now: t0 + 183000, perMinute: 2, perHour: 5 }).ok, true, "第 5 次成功");
  assert.equal(consumePeakQuota(store, "group:1", { now: t0 + 184000, perMinute: 2, perHour: 5 }).ok, false, "第 6 次撞小时上限");
  assert.equal(consumePeakQuota(store, "group:2", { now: t0, perMinute: 2, perHour: 5 }).ok, true, "不同 key 独立");
  assert.equal(consumePeakQuota(store, "group:1", { now: t0 + 3_700_000, perMinute: 2, perHour: 5 }).ok, true, "跨小时恢复");
});
if (failed) process.exit(1);
console.log("\n🎉 replyToAll/限频测试通过");
