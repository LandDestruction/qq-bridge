#!/usr/bin/env node
// 2026-11-02：内容审核 / 上下文超长 也要触发「换模型重试」
// 现场：智谱返回 {"finish_reason":"sensitive"}；glm-4.6v 128K 之后 {"code":"1261","message":"Prompt exceeds max length"}。
// 以前这两类只当普通回合失败（群里只看到「⚠️ 我这轮出了点问题」），不会走备用模型。
// 这里做源码级断言：初始化早期返回必须放行这两类错误，且 mux 仍会在降级后重试本轮。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\n[1] recordModelFailure 认得审核/超长错误');
const sel = fs.readFileSync(path.join(ROOT, 'src/bridge/model-selection.js'), 'utf8');
const start = sel.indexOf('async function recordModelFailure');
const earlyReturn = sel.indexOf('return false;', start);
const head = sel.slice(start, earlyReturn);
ok('函数里有 finish_reason + sensitive 判定', /finish_reason/.test(head) && /sensitive/.test(head));
ok('认得 prompt exceeds max length', /prompt exceeds max length/i.test(head));
ok('认得 code 1261', /1261/.test(head));
ok('认得内容审核', /内容审核/.test(head));
ok('早期返回同时看 capacity 与 rejection', /isModelCapacityError/.test(head) && /modelRejected/.test(head));

console.log('\n[2] 降级后仍会重试本轮（mux）');
const mux = fs.readFileSync(path.join(ROOT, 'src/bridge/mux-runtime.js'), 'utf8');
ok('调 recordModelFailure', /recordModelFailure/.test(mux));
ok('降级后重试本轮', /retriedAfterFallback/.test(mux) && /deliverPrompt/.test(mux));
ok('重试复用同一个 sessionId', /frame\.sessionId/.test(mux));

console.log('\n[3] 视觉守卫仍在（含图轮不会切到看不了图的模型）');
ok('视觉选择逻辑存在', /modelSeesImages/.test(sel) && /visionPick/.test(sel));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
