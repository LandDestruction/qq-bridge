#!/usr/bin/env node
// M6 P2-12（Range 断点续传）+ P2-14（封面 dHash，阈值 10）的负例测试。
// 全部在临时目录，跑完即删；不碰真实归档目录、不发真实网络请求。
// 用法：node scripts/test-archive-p2-transfer.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  downloadFileResumable, parseContentRange, resumeFetchHeaders,
  sameCover, COVER_DHASH_THRESHOLD
} from '../src/archive-p2.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-p2-transfer-'));
let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { fail += 1; console.error(`  FAIL ${name} — ${error?.message ?? error}`); }
}
const bodyOf = (parts) => (async function* () { for (const part of parts) yield Buffer.from(part); })();
const resp = (status, headers, parts) => ({ status, headers, body: bodyOf(parts) });
const read = (file) => fs.readFileSync(file, 'utf8');
function dirOf(tag) {
  const d = fs.mkdtempSync(path.join(root, `${tag}-`));
  return { d, dest: path.join(d, 'out', 'a.bin'), tmp: path.join(d, 'tmp') };
}
const URL_ = 'https://example.invalid/a.bin';

// ① 全新下载：200 全量，收齐才落盘，不留 .part / .part.json
await check('全新下载：200 全量落地，不留分片/状态文件', async () => {
  const { dest, tmp } = dirOf('t1');
  let calls = 0; let first = null;
  const r = await downloadFileResumable({
    url: URL_, destPath: dest, tempDir: tmp,
    fetchRange: async (url, opts) => { calls += 1; first = opts; return resp(200, { 'Content-Length': '6' }, ['abc', 'def']); }
  });
  assert.equal(read(dest), 'abcdef');
  assert.equal(r.bytes, 6);
  assert.equal(r.resumed, false);
  assert.equal(calls, 1);
  assert.deepEqual(first.headers, {}, 'start=0 时不该带 Range');
  assert.equal(fs.existsSync(path.join(tmp, 'a.bin.part')), false);
  assert.equal(fs.existsSync(path.join(tmp, 'a.bin.part.json')), false);
});

// ② 续传：本地 3 字节 + 206 返回后 3 字节 → 拼成 6 字节；带 Range/If-Range
await check('续传：206 + Content-Range 拼接，带 Range/If-Range', async () => {
  const { dest, tmp } = dirOf('t2');
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'a.bin.part'), 'abc');
  fs.writeFileSync(path.join(tmp, 'a.bin.part.json'), JSON.stringify({ url: URL_, bytes: 3, totalBytes: 6, etag: 'v1', lastModified: '' }));
  let seen = null;
  const r = await downloadFileResumable({
    url: URL_, destPath: dest, tempDir: tmp,
    fetchRange: async (url, opts) => {
      seen = opts;
      return resp(206, { 'Content-Range': 'bytes 3-5/6', ETag: 'v1' }, ['def']);
    }
  });
  assert.equal(read(dest), 'abcdef');
  assert.equal(r.bytes, 6);
  assert.equal(r.resumed, true);
  assert.equal(seen.start, 3);
  assert.equal(seen.headers.Range, 'bytes=3-');
  assert.equal(seen.headers['If-Range'], 'v1');
});

// ③ 服务器忽略 Range（200 全量）：必须从头写，不能拼成 abcabcdef
await check('服务器忽略 Range：200 全量从头写，不追加', async () => {
  const { dest, tmp } = dirOf('t3');
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'a.bin.part'), 'abc');
  fs.writeFileSync(path.join(tmp, 'a.bin.part.json'), JSON.stringify({ url: URL_, bytes: 3, totalBytes: 6 }));
  await downloadFileResumable({
    url: URL_, destPath: dest, tempDir: tmp,
    fetchRange: async () => resp(200, { 'Content-Length': '6' }, ['abcdef'])
  });
  assert.equal(read(dest), 'abcdef', '不能把旧分片拼进去');
});

// ④ 校验器变了（ETag 不同）：丢掉旧分片重下，不拼旧内容
await check('ETag 变化：丢弃旧分片，从 0 重下', async () => {
  const { dest, tmp } = dirOf('t4');
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'a.bin.part'), 'abc');
  fs.writeFileSync(path.join(tmp, 'a.bin.part.json'), JSON.stringify({ url: URL_, bytes: 3, totalBytes: 6, etag: 'v1' }));
  const starts = [];
  const bodies = ['XYZ'];
  await downloadFileResumable({
    url: URL_, destPath: dest, tempDir: tmp,
    fetchRange: async (url, opts) => {
      starts.push(opts.start);
      if (starts.length === 1) return resp(200, { 'Content-Length': '3', ETag: 'v2' }, bodies);
      return resp(200, { 'Content-Length': '3', ETag: 'v2' }, ['XYZ']);
    }
  });
  assert.deepEqual(starts, [3, 0], '应重来一次');
  assert.equal(read(dest), 'XYZ');
});

// ⑤ 416 且本地已收齐：直接 rename，不再请求 body
await check('416 且分片已完整：直接落盘', async () => {
  const { dest, tmp } = dirOf('t5');
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'a.bin.part'), 'abcdef');
  fs.writeFileSync(path.join(tmp, 'a.bin.part.json'), JSON.stringify({ url: URL_, bytes: 6, totalBytes: 6 }));
  const r = await downloadFileResumable({
    url: URL_, destPath: dest, tempDir: tmp,
    fetchRange: async () => resp(416, { 'Content-Range': 'bytes */6' }, [])
  });
  assert.equal(read(dest), 'abcdef');
  assert.equal(r.resumed, true);
});

// ⑥ 网络错误有限重试：两次失败后成功，第 3 次拿到内容
await check('网络错误重试：失败 2 次后成功，attempts=3', async () => {
  const { dest, tmp } = dirOf('t6');
  let calls = 0;
  const sleeps = [];
  const r = await downloadFileResumable({
    url: URL_, destPath: dest, tempDir: tmp,
    sleep: async (ms) => { sleeps.push(ms); },
    fetchRange: async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNRESET');
      return resp(200, { 'Content-Length': '2' }, ['ok']);
    }
  });
  assert.equal(read(dest), 'ok');
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  assert.equal(r.attempts, 3);
});

// ⑦ 重试用尽：抛错，目标文件不出现
await check('重试用尽：抛错且不产出目标文件', async () => {
  const { dest, tmp } = dirOf('t7');
  let calls = 0;
  await assert.rejects(() => downloadFileResumable({
    url: URL_, destPath: dest, tempDir: tmp, maxRetries: 2,
    sleep: async () => {},
    fetchRange: async () => { calls += 1; throw new Error('ECONNRESET'); }
  }), /ECONNRESET/);
  assert.equal(calls, 3, 'maxRetries=2 → 最多 3 次');
  assert.equal(fs.existsSync(dest), false);
});

// ⑧ 超上限：Content-Length 就超了 → 立刻失败，绝不写文件
await check('超上限：Content-Length > maxBytes → 立即失败', async () => {
  const { dest, tmp } = dirOf('t8');
  await assert.rejects(() => downloadFileResumable({
    url: URL_, destPath: dest, tempDir: tmp, maxBytes: 10,
    fetchRange: async () => resp(200, { 'Content-Length': '99' }, ['x'.repeat(99)])
  }), /超过上限/);
  assert.equal(fs.existsSync(dest), false);
});

// ⑨ 非重试错误（404）：只请求一次，直接抛
await check('404：不重试，直接失败', async () => {
  const { dest, tmp } = dirOf('t9');
  let calls = 0;
  await assert.rejects(() => downloadFileResumable({
    url: URL_, destPath: dest, tempDir: tmp,
    fetchRange: async () => { calls += 1; return resp(404, {}, []); }
  }), /HTTP 404/);
  assert.equal(calls, 1);
});

// ⑩ Content-Range 起点与本地不符：丢掉分片重来，不能拼错位
await check('Content-Range 起点不符：丢弃分片从 0 重下', async () => {
  const { dest, tmp } = dirOf('t10');
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'a.bin.part'), 'abc');
  fs.writeFileSync(path.join(tmp, 'a.bin.part.json'), JSON.stringify({ url: URL_, bytes: 3, totalBytes: 6 }));
  const starts = [];
  await downloadFileResumable({
    url: URL_, destPath: dest, tempDir: tmp,
    fetchRange: async (url, opts) => {
      starts.push(opts.start);
      if (starts.length === 1) return resp(206, { 'Content-Range': 'bytes 5-5/6' }, ['f']);
      return resp(200, { 'Content-Length': '6' }, ['abcdef']);
    }
  });
  assert.deepEqual(starts, [3, 0]);
  assert.equal(read(dest), 'abcdef');
});

// ⑪ 短包（206 只给了部分）：继续 Range 补齐
await check('短包续传：206 只回 2 字节 → 再按 Range 补齐', async () => {
  const { dest, tmp } = dirOf('t11');
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'a.bin.part'), 'abc');
  fs.writeFileSync(path.join(tmp, 'a.bin.part.json'), JSON.stringify({ url: URL_, bytes: 3, totalBytes: 6 }));
  const starts = [];
  const r = await downloadFileResumable({
    url: URL_, destPath: dest, tempDir: tmp,
    fetchRange: async (url, opts) => {
      starts.push(opts.start);
      if (opts.start === 3) return resp(206, { 'Content-Range': 'bytes 3-4/6' }, ['de']);
      return resp(206, { 'Content-Range': 'bytes 5-5/6' }, ['f']);
    }
  });
  assert.deepEqual(starts, [3, 5]);
  assert.equal(read(dest), 'abcdef');
  assert.equal(r.bytes, 6);
});

// ⑫ 纯函数：Content-Range 解析 / 请求头
await check('parseContentRange / resumeFetchHeaders', () => {
  assert.deepEqual(parseContentRange('bytes 100-299/300'), { start: 100, end: 299, total: 300 });
  assert.deepEqual(parseContentRange('bytes 0-0/*'), { start: 0, end: 0, total: null });
  assert.equal(parseContentRange('garbage'), null);
  assert.equal(parseContentRange(''), null);
  assert.deepEqual(resumeFetchHeaders({ start: 0 }), {});
  assert.deepEqual(resumeFetchHeaders({ start: 5, etag: 'E1' }), { Range: 'bytes=5-', 'If-Range': 'E1' });
  assert.deepEqual(resumeFetchHeaders({ start: 5, lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT' }),
    { Range: 'bytes=5-', 'If-Range': 'Wed, 21 Oct 2015 07:28:00 GMT' });
});

// ⑬ 封面 dHash：阈值 10，与表情的 1 不共用
await check('sameCover：阈值 10 内判同图，11 bit 不同图，无效 hash 一律不同', () => {
  const zero = '0000000000000000';
  assert.equal(COVER_DHASH_THRESHOLD, 10);
  assert.equal(sameCover(zero, zero), true);
  assert.equal(sameCover(zero, '0000000000000001'), true, '1 bit');
  assert.equal(sameCover(zero, '00000000000003ff'), true, '正好 10 bit');
  assert.equal(sameCover(zero, '00000000000007ff'), false, '11 bit 超出默认阈值');
  assert.equal(sameCover(zero, '00000000000003ff', { threshold: 1 }), false, '阈值可参数化（表情用 1）');
  assert.equal(sameCover('ABCDEF0123456789', 'abcdef0123456789'), true, '大小写归一');
  assert.equal(sameCover('', zero), false);
  assert.equal(sameCover('xyz', zero), false);
  assert.equal(sameCover(null, undefined), false);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exitCode = fail === 0 ? 0 : 1;
