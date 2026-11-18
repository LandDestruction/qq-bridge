// dhashFromBufferAsync 的离线断言：不真跑 ffmpeg，注入假的 spawn。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { dhashFromBufferAsync } from '../src/image-hash.js';

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`✅ ${name}`); }
  catch (e) { failed += 1; console.error(`❌ ${name} — ${e?.message ?? e}`); }
}

function fakeSpawn({ px = null, code = 0, emitError = false, delayMs = 0 } = {}) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts, sync: opts?.input !== undefined });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => {};
    setTimeout(() => {
      if (emitError) { child.emit('error', new Error('boom')); return; }
      if (px) child.stdout.emit('data', px);
      child.emit('close', code);
    }, delayMs);
    return child;
  };
  return { impl, calls };
}

// 9x8 灰度：左亮右暗 → 每行前 8 个比较里 x<8 的位决定结果
const PX = Buffer.alloc(72, 0);
for (let y = 0; y < 8; y += 1) for (let x = 0; x < 9; x += 1) PX[y * 9 + x] = x < 4 ? 255 : 0;

await check('正常路径：返回 16 位 hex，且不阻塞（Promise 而非同步返回）', async () => {
  const { impl, calls } = fakeSpawn({ px: PX });
  const p = dhashFromBufferAsync(Buffer.from('img'), { spawnImpl: impl });
  assert.ok(p instanceof Promise, '必须是 Promise（同步版会直接返回字符串）');
  const hash = await p;
  assert.match(String(hash), /^[0-9a-f]{16}$/);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].sync, '不得走 spawnSync 的 input 选项');
});

await check('ffmpeg 报错 / 输出过短 → null（调用方已能接受）', async () => {
  const a = fakeSpawn({ px: Buffer.alloc(10), code: 0 });
  assert.equal(await dhashFromBufferAsync(Buffer.from('x'), { spawnImpl: a.impl }), null);
  const b = fakeSpawn({ code: 1 });
  assert.equal(await dhashFromBufferAsync(Buffer.from('x'), { spawnImpl: b.impl }), null);
});

await check('spawn 抛错 → null，不抛给调用方', async () => {
  const impl = () => { throw new Error('ENOENT ffmpeg'); };
  assert.equal(await dhashFromBufferAsync(Buffer.from('x'), { spawnImpl: impl }), null);
});

await check('超时 → 主动 kill 并返回 null', async () => {
  const impl = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stdin = { end() {} }; c.killed = false; c.kill = () => { c.killed = true; }; return c; };
  const r = await dhashFromBufferAsync(Buffer.from('x'), { spawnImpl: impl, timeoutMs: 30 });
  assert.equal(r, null);
});

await check('空 buffer → 直接 null，不起进程', async () => {
  const { impl, calls } = fakeSpawn({ px: PX });
  assert.equal(await dhashFromBufferAsync(Buffer.alloc(0), { spawnImpl: impl }), null);
  assert.equal(calls.length, 0);
});

if (failed) { console.error(`\n❌ 异步 dHash 测试失败（${failed} 项）`); process.exit(1); }
console.log('\n🎉 异步 dHash 测试通过');
