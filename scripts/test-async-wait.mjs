import assert from "node:assert/strict";
import { createStagedTask, raceWithTimeout } from "../src/async-wait.js";
let failed = 0;
async function check(n, f) { try { await f(); console.log("✅ " + n); } catch (e) { failed++; console.error("❌ " + n + " — " + (e?.message ?? e)); } }
await check("没有待处理任务时立即返回（不等待）", async () => {
  const t0 = Date.now();
  const r = await raceWithTimeout([], 5000);
  assert.equal(r.done, true);
  assert.equal(r.timedOut, false);
  assert.ok(Date.now() - t0 < 50);
});
await check("任务很快完成 → done=true 且不等满超时", async () => {
  const r = await raceWithTimeout([Promise.resolve(1)], 5000);
  assert.equal(r.done, true);
  assert.equal(r.timedOut, false);
});
await check("任务慢于超时 → timedOut=true，不抛错", async () => {
  const slow = new Promise((res) => setTimeout(res, 300));
  const r = await raceWithTimeout([slow, Promise.reject(new Error("boom"))], 60);
  assert.equal(r.done, false);
  assert.equal(r.timedOut, true);
});
await check("任务失败也按完成处理（allSettled）", async () => {
  const r = await raceWithTimeout([Promise.reject(new Error("x"))], 1000);
  assert.equal(r.done, true);
});
await check("两段式：帧先放行，转写还在跑时 frames 已完成、stt 未完成", async () => {
  const t = createStagedTask();
  t.markFrames();
  const f = await raceWithTimeout([t.frames], 100);
  assert.equal(f.done, true, "帧应已完成");
  const st = await raceWithTimeout([t.stt], 120);
  assert.equal(st.timedOut, true, "转写应超时（模拟 60s 未完成）");
  t.markStt();
  const st2 = await raceWithTimeout([t.stt], 100);
  assert.equal(st2.done, true, "迟到完成后 stt 仍是已 resolve 的 promise");
});
await check("两段式：帧超时（慢抽帧）时不影响后续 stt 等待逻辑", async () => {
  const t = createStagedTask();
  const f = await raceWithTimeout([t.frames], 50);
  assert.equal(f.timedOut, true);
  t.markFrames(); t.markStt();
  assert.equal(await raceWithTimeout([t.stt], 100).then((r) => r.done), true);
});

if (failed) process.exit(1);
console.log("\n🎉 有限等待测试通过");
