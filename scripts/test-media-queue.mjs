import { readBridgeSource } from './bridge-source.mjs';
// 媒体并发闸门的离线单测（不跑 ffmpeg，用可控的延迟任务模拟）。
import assert from 'node:assert/strict';
import { createMediaQueue, mediaQueueCfg } from '../src/media-queue.js';

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`✅ ${name}`); }
  catch (error) { failed += 1; console.error(`❌ ${name} — ${error?.message ?? error}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await check('配置：上限夹在 1~4，超时夹在 1s~10min', async () => {
  assert.equal(mediaQueueCfg({}).maxConcurrent, 2);
  assert.equal(mediaQueueCfg({ maxConcurrent: 99 }).maxConcurrent, 4);
  assert.equal(mediaQueueCfg({ maxConcurrent: 0 }).maxConcurrent, 2);
  assert.equal(mediaQueueCfg({ queueTimeoutMs: 10 }).queueTimeoutMs, 1000);
  assert.equal(mediaQueueCfg({ queueTimeoutMs: 9e9 }).queueTimeoutMs, 600000);
});

await check('5 个任务并发提交 → 峰值并发 ≤ 2，完成后槽位归零', async () => {
  const q = createMediaQueue({ maxConcurrent: 2, queueTimeoutMs: 5000 });
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => q.run(async () => { await sleep(30); return i; }))
  );
  assert.deepEqual(results, [0, 1, 2, 3, 4], '五个任务都要完成且按提交顺序返回');
  const st = q.stats();
  assert(st.peak <= 2, `峰值并发必须 ≤ 2（实得 ${st.peak}）`);
  assert.equal(st.running, 0, '全部完成后执行中必须归零');
  assert.equal(st.queued, 0, '队列必须清空');
});

await check('任务抛错 → 槽位仍然释放（最易漏的一条）', async () => {
  const q = createMediaQueue({ maxConcurrent: 1, queueTimeoutMs: 5000 });
  await assert.rejects(q.run(async () => { throw new Error('ffmpeg 炸了'); }), /炸了/);
  assert.equal(q.stats().running, 0, '抛错后槽位必须释放');
  // 释放了才排得进下一个
  const ok = await q.run(async () => 'after-failure');
  assert.equal(ok, 'after-failure', '失败之后仍能正常拿到槽位');
});

await check('排队超时 → 明确报错（code=MEDIA_QUEUE_TIMEOUT），不静默丢弃', async () => {
  const q = createMediaQueue({ maxConcurrent: 1, queueTimeoutMs: 120 });
  let release = null;
  const holder = q.run(() => new Promise((r) => { release = r; }));   // 长期占用唯一槽位
  await sleep(10);
  await assert.rejects(q.run(async () => 'never'), (error) => {
    assert.equal(error.code, 'MEDIA_QUEUE_TIMEOUT');
    assert.match(error.message, /排队超时/);
    return true;
  });
  release();
  await holder;
  assert.equal(q.stats().running, 0, '超时那条不得影响槽位计数');
});

await check('FIFO：先提交先执行', async () => {
  const q = createMediaQueue({ maxConcurrent: 1, queueTimeoutMs: 5000 });
  const order = [];
  const jobs = [0, 1, 2].map((i) => q.run(async () => { order.push(i); await sleep(10); }));
  await Promise.all(jobs);
  assert.deepEqual(order, [0, 1, 2]);
});

// ⚠️ 以下是**接线断言，不是行为断言**：它只证明 bridge.js 里确实 import 了闸门、
// 且在 enrichVideoFile 内部用 mediaQueue.run 包住了重活（防止再出现「模块+单测都写了，
// 但全库没有 import」的孤儿模块）。
await check('接线：bridge.js 里 enrichVideoFile 内部真的用了 mediaQueue.run', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readBridgeSource();
  assert.ok(/import \{ createMediaQueue, mediaQueueCfg \} from '\.\/media-queue\.js';/.test(src), '必须 import createMediaQueue');
  assert.ok(/const mediaQueue = createMediaQueue\(/.test(src), '必须有进程级单例');
  const start = src.indexOf('function enrichVideoFile');
  assert.ok(start > 0, '找不到 enrichVideoFile');
  const body = src.slice(start, start + 20000);
  assert.ok(/mediaQueue\.run\(/.test(body), 'enrichVideoFile 内部必须调用 mediaQueue.run');
  assert.ok(/MEDIA_QUEUE_TIMEOUT/.test(body), '排队超时要被显式处理（不能静默）');
});

if (failed) {
  console.error(`\n❌ 媒体并发闸门测试失败（${failed} 项）`);
  process.exit(1);
}
console.log('\n🎉 媒体并发闸门测试通过');
