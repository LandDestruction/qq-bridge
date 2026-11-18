import { readBridgeSource } from './bridge-source.mjs';
import fs from 'node:fs';
﻿import assert from "node:assert/strict";
import { isMalformedToolJson, decideMalformedAction, MALFORMED_GIVEUP_TEXT } from "../src/malformed-retry.js";
let failed = 0;
function check(n, f) { try { f(); console.log("✅ " + n); } catch (e) { failed++; console.error("❌ " + n + " — " + (e?.message ?? e)); } }
check("识别 DSH 原文错误", () => {
  assert.equal(isMalformedToolJson("DeepSeek Messages stream: tool input is invalid JSON"), true);
});
check("同族 malformed 也算", () => {
  assert.equal(isMalformedToolJson("malformed tool call"), true);
  assert.equal(isMalformedToolJson("invalid tool call payload"), true);
});
check("其它错误不误判（容量/网络）", () => {
  assert.equal(isMalformedToolJson("503 no_healthy_account"), false);
  assert.equal(isMalformedToolJson("fetch failed: ECONNREFUSED"), false);
  assert.equal(isMalformedToolJson(""), false);
});
check("决策：第1次同 prompt、第2次换模型、第3次放弃", () => {
  assert.equal(decideMalformedAction({ attempts: 0 }), "retry-same");
  assert.equal(decideMalformedAction({ attempts: 1 }), "retry-fallback");
  assert.equal(decideMalformedAction({ attempts: 2 }), "give-up");
  assert.equal(decideMalformedAction({}), "retry-same");
});
check("放弃文案是中性且不暴露内部错误", () => {
  assert.equal(MALFORMED_GIVEUP_TEXT.includes("invalid JSON"), false);
  assert.ok(MALFORMED_GIVEUP_TEXT.length > 5);
});
check("含图轮不得切到不支持视觉的 pro（静态断言 bridge 侧判断）", () => {
  const bridge = readBridgeSource();
  const idx = bridge.indexOf("preferMalformed");
  assert.ok(idx > 0, "应存在 malformed 专用候选逻辑");
  const seg = bridge.slice(idx, idx + 520);
  assert.ok(seg.includes("hasMedia"), "必须按 hasMedia 区分");
  assert.ok(seg.includes("deepseek-v4-pro"), "纯文字轮优先 pro");
});

if (failed) process.exit(1);
console.log("\n🎉 malformed 重试决策测试通过");
