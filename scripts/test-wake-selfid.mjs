import { readBridgeSource } from './bridge-source.mjs';
﻿import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveSelfIds, matchAtMention, matchNameMention } from "../src/wake-selfid.js";
import { resolveModelChoice, normalizeRouting } from "../src/model-routing.js";
let failed = 0;
function check(n, f) { try { f(); console.log("✅ " + n); } catch (e) { failed++; console.error("❌ " + n + " — " + (e?.message ?? e)); } }

const AT_ME = (qq) => ({ type: "at", data: { qq } });
const SEG_TEXT = (t) => ({ type: "text", data: { text: t } });

check("事件不带 self_id：@ 段命中缓存 id", () => {
  const msg = [AT_ME("1000000001"), SEG_TEXT(" 我刚才说的三件事是什么？")];
  assert.equal(matchAtMention(msg, { eventSelfId: "", cachedId: "1000000001" }), true);
});
check("事件自带 self_id：@ 段命中事件 id（老路径不变）", () => {
  assert.equal(matchAtMention([AT_ME("111")], { eventSelfId: "111", cachedId: "1000000001" }), true);
});
check("@ 别人不误判", () => {
  assert.equal(matchAtMention([AT_ME("999")], { eventSelfId: "", cachedId: "1000000001" }), false);
});
check("resolveSelfIds 去空、去重，primary 优先事件值", () => {
  assert.deepEqual(resolveSelfIds({ eventSelfId: "", cachedId: "1000000001", fallbackId: "1000000001" }).ids, ["1000000001"]);
  assert.equal(resolveSelfIds({ eventSelfId: "111", cachedId: "222" }).primary, "111");
});
check("名字唤醒：昵称兜底（selfNickname 为空时用网关昵称）", () => {
  assert.equal(matchNameMention("大肥鱼小姐在吗", ["", "大肥鱼小姐"]), true);
  assert.equal(matchNameMention("@大肥鱼小姐 我刚才说的三件事是什么", ["大肥鱼小姐"]), true);
  assert.equal(matchNameMention("今天天气不错", ["大肥鱼小姐"]), false);
});
check("带图回合：resolveModelChoice 优先 media", () => {
  const routing = normalizeRouting({ idle: { provider: "workbuddy2api", model: "deepseek-v4.1-flash" }, peak: { provider: "xiaomi-mimo", model: "mimo-v2.6-flash" } });
  const picked = resolveModelChoice({ routing, media: { provider: "deepseek-account", model: "deepseek-flash" }, isPeak: true });
  assert.deepEqual(picked, { provider: "deepseek-account", model: "deepseek-flash", source: "media" });
});
check("静态：bridge 唤醒判定用缓存兜底 + 有兜底日志", () => {
  const src = readBridgeSource();
  assert.ok(src.includes("resolveSelfIds({ eventSelfId: event?.self_id, cachedId: botSelfIdCache"), "atMention 应用缓存兜底");
  assert.ok(src.includes("已用缓存 id="), "应有兜底日志");
  assert.ok(src.includes("matchNameMention(plainContent, names)"), "nameMention 应用多昵称兜底");
  assert.ok(src.includes("void warmSelfIdentity();"), "启动应预热 self id");
  assert.ok(src.includes("const resolvedSelf = selfId || botSelfIdCache || '';"), "引用判定应兜底");
});
if (failed) process.exit(1);
console.log("\n🎉 唤醒 self_id 兜底测试通过");
