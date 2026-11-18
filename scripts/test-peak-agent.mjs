import { readBridgeSource } from './bridge-source.mjs';
﻿import assert from "node:assert/strict";
import fs from "node:fs";
import { chooseTurnModel } from "../src/model-fallback.js";
let failed = 0;
function check(n, f) { try { f(); console.log("✅ " + n); } catch (e) { failed++; console.error("❌ " + n + " — " + (e?.message ?? e)); } }
const PEAK = { provider: "xiaomi-mimo", model: "mimo-v2.6-pro" };
const MEDIA = { provider: "deepseek-account", model: "deepseek-flash" };
const CFG = { provider: "workbuddy2api", model: "deepseek-v4.1-flash" };

check("高峰启用 → 选 MiMo（没有 override/media/kind 时）", () => {
  const r = chooseTurnModel({ peakUse: PEAK, cfgProvider: CFG.provider, cfgModel: CFG.model });
  assert.deepEqual(r, PEAK);
});
check("带图回合 → media 压过 peak（图片必须走视觉模型）", () => {
  const r = chooseTurnModel({ mediaUse: MEDIA, peakUse: PEAK, cfgProvider: CFG.provider, cfgModel: CFG.model });
  assert.deepEqual(r, MEDIA);
});
check("非高峰 → 用配置默认（peakUse=null）", () => {
  const r = chooseTurnModel({ peakUse: null, cfgProvider: CFG.provider, cfgModel: CFG.model });
  assert.deepEqual(r, CFG);
});
check("kindUse 低于 peak；override 最高（降级中不抢回高峰模型）", () => {
  const kind = { provider: "workbuddy2api", model: "deepseek-v4-pro" };
  assert.deepEqual(chooseTurnModel({ peakUse: PEAK, kindUse: kind, cfgProvider: CFG.provider, cfgModel: CFG.model }), PEAK);
  const override = { provider: "p", model: "m" };
  assert.deepEqual(chooseTurnModel({ override, mediaUse: MEDIA, peakUse: PEAK, cfgProvider: CFG.provider, cfgModel: CFG.model }), override);
});
check("静态：bridge 用 resolveModelChoice 且参数含 media/isPeak", () => {
  const src = readBridgeSource();
  assert.ok(src.includes("resolveModelChoice({ routing, media: mediaUse, isPeak: isPeakNow"), "选择逻辑应走 resolveModelChoice");
  assert.ok(src.includes("[模型] 选择 source="), "选择结果要有日志（带 source）");
});
check("静态：高峰分支不裁剪工具清单", () => {
  const src = readBridgeSource();
  const toolBlocks = (src.match(/socialV2\?\.tools/g) || []).length;
  assert.ok(toolBlocks > 0, "工具开关来自配置");
  assert.ok(!/peakPause[\s\S]{0,200}socialV2\?\.tools/.test(src), "高峰配置不得改写工具开关");
});
check("静态：识图路径仍把 image part 送进 prompt（未被 peak 分支短路）", () => {
  const src = readBridgeSource();
  assert.ok(src.includes("parts.push({ type: 'image'"), "仍有 image part 注入");
  const idxResolve = src.indexOf("async function resolveMediaList");
  assert.ok(idxResolve > 0 && !/resolveMediaList[\s\S]{0,4000}peakPause/.test(src.slice(idxResolve, idxResolve + 4000)), "resolveMediaList 不应读 peakPause");
});
if (failed) process.exit(1);
console.log("\n🎉 高峰 agent 模型选择测试通过");
