// safe-fetch.readBodyBounded 的单测：按字节上限流式读取，超限即停。
//
// 回归背景（2026-10-25 审计 P0）：enrichVideoFile 里 `if (media.size && media.size > sizeCap)`
// 用 OneBot 的 file_size 做闸门，而网关经常给 0 → 短路 → `fetch().arrayBuffer()` 全量读入。
// 几百 MB 视频直接进 Node 堆 → OOM → 守护进程重启。
//
// 现在的契约：任何情况下都只读到上限为止，超限返回 truncated=true 并主动断开。
import assert from 'node:assert/strict';
import { readBodyBounded } from '../src/safe-fetch.js';

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}: ${e.message}`); }
}

/** 可控的假响应体：记录被取走了多少个 chunk，用来证明「没有整段读入」。 */
function fakeBody(chunks) {
  const state = { pulled: 0, returned: false };
  const body = {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= chunks.length) return { done: true, value: undefined };
          const value = chunks[i];
          i += 1;
          state.pulled += 1;
          return { done: false, value };
        },
        async return() { state.returned = true; return { done: true, value: undefined }; }
      };
    }
  };
  return { body, state };
}

console.log('\n[1] 未超限：完整读回');
await check('三段小 chunk 全读、truncated=false', async () => {
  const { body } = fakeBody([Buffer.from('abc'), Buffer.from('de'), Buffer.from('f')]);
  const out = await readBodyBounded(body, 100);
  assert.equal(out.buffer.toString(), 'abcdef');
  assert.equal(out.truncated, false);
  assert.equal(out.bytesRead, 6);
});

console.log('\n[2] 超限：按字节截断且不整段读入（事故核心）');
await check('10MB 响应、上限 1MB ⇒ 只读 1MB 且提前断开', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 0x41); // 1MB
  const chunks = Array.from({ length: 10 }, () => chunk);
  const { body, state } = fakeBody(chunks);
  const out = await readBodyBounded(body, 1024 * 1024);
  assert.equal(out.truncated, true, '必须标记为已截断');
  assert.equal(out.buffer.length, 1024 * 1024, '只保留上限内的字节');
  assert.equal(out.bytesRead, 1024 * 1024);
  assert.ok(state.pulled <= 2, `只该取 1~2 个 chunk，实际取了 ${state.pulled} 个`);
  assert.equal(state.returned, true, '截断后必须主动断开（否则剩余正文继续流）');
});
await check('单个超大 chunk 也能截断（不需要恰好对齐）', async () => {
  const { body } = fakeBody([Buffer.alloc(5 * 1024 * 1024, 0x42)]);
  const out = await readBodyBounded(body, 1024);
  assert.equal(out.truncated, true);
  assert.equal(out.buffer.length, 1024);
});
await check('正好等于上限 ⇒ 不算截断', async () => {
  const { body } = fakeBody([Buffer.alloc(512, 1), Buffer.alloc(512, 2)]);
  const out = await readBodyBounded(body, 1024);
  assert.equal(out.truncated, false);
  assert.equal(out.buffer.length, 1024);
});

console.log('\n[3] 边界');
await check('body 为空 ⇒ 空 buffer，不抛错', async () => {
  const out = await readBodyBounded(null, 1024);
  assert.equal(out.buffer.length, 0);
  assert.equal(out.truncated, false);
});
await check('非法上限 ⇒ 抛错（配置写错要早报）', async () => {
  await assert.rejects(() => readBodyBounded(fakeBody([Buffer.from('x')]).body, 0));
});
await check('getReader 风格（web ReadableStream）也能读', async () => {
  const chunks = [Buffer.from('hello '), Buffer.from('world')];
  let i = 0;
  const body = {
    getReader() {
      return {
        async read() {
          if (i >= chunks.length) return { done: true, value: undefined };
          const value = chunks[i];
          i += 1;
          return { done: false, value };
        },
        async cancel() {}
      };
    }
  };
  const out = await readBodyBounded(body, 1024);
  assert.equal(out.buffer.toString(), 'hello world');
});
await check('真正的 ReadableStream 也能读（Node 22 fetch 的 body 类型）', async () => {
  const rs = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array([104, 105])); c.close(); }
  });
  const out = await readBodyBounded(rs, 1024);
  assert.equal(out.buffer.toString(), 'hi');
});

// ── safeFetchToFile：2.5G 级文件流式落盘的入口守卫 ────────────────────────
// 真实网络下载无法离线测（SSRF 校验会拒绝 127.0.0.1），这里钉住入口：
// 非法协议 / 内网地址必须在发请求前拒绝，且不得留下目标文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeFetchToFile } from '../src/safe-fetch.js';

console.log('\n[9] safeFetchToFile 入口守卫');
await check('拒绝非 http(s) 协议（file://）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-fetch-tofile-'));
  const dest = path.join(dir, 'x.bin');
  let message = '';
  try { await safeFetchToFile('file:///etc/passwd', dest, 1024); } catch (e) { message = e.message; }
  assert.match(message, /协议|http/i);
  assert.equal(fs.existsSync(dest), false, '被拒绝时不能创建目标文件');
  fs.rmSync(dir, { recursive: true, force: true });
});
await check('拒绝环回/内网地址（127.0.0.1）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-fetch-tofile-'));
  const dest = path.join(dir, 'y.bin');
  let message = '';
  try { await safeFetchToFile('http://127.0.0.1:9/a.bin', dest, 1024); } catch (e) { message = e.message; }
  assert.match(message, /内网|私有|环回|地址/i);
  assert.equal(fs.existsSync(dest), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
