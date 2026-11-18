// HEIC 识别与转码的离线断言（注入假 spawn，不真跑 ffmpeg）。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sniffHeic, convertHeicToJpeg } from '../src/media-normalize.js';

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`✅ ${name}`); }
  catch (e) { failed += 1; console.error(`❌ ${name} — ${e?.message ?? e}`); }
}

const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(20)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);

function fakeSpawn({ out = JPEG, code = 0, err = '' } = {}) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => {};
    setTimeout(() => { if (err) child.stderr.emit('data', Buffer.from(err)); if (out) child.stdout.emit('data', out); child.emit('close', code); }, 5);
    return child;
  };
  return { impl, calls };
}

await check('按 ftyp 判 HEIC：heic/heix/mif1/msf1 都算，JPEG 不算', () => {
  for (const brand of ['heic', 'heix', 'mif1', 'msf1']) {
    const buf = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`), Buffer.alloc(20)]);
    assert.equal(sniffHeic(buf), true, brand);
  }
  assert.equal(sniffHeic(JPEG), false);
  assert.equal(sniffHeic(Buffer.from('RIFF....WEBP')), false);
});

await check('转码成功：返回 JPEG 字节（0xFFD8 开头）', async () => {
  const { impl, calls } = fakeSpawn();
  const r = await convertHeicToJpeg(HEIC, { spawnImpl: impl });
  assert.equal(r.ok, true);
  assert.equal(r.buffer[0], 0xff);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('-frames:v'), '应只取一帧');
});

await check('转码失败：返回明确 reason（带 exit code 与 stderr 片段），不返回裸 null', async () => {
  const { impl } = fakeSpawn({ out: Buffer.alloc(0), code: 1, err: 'moov atom not found' });
  const r = await convertHeicToJpeg(HEIC, { spawnImpl: impl });
  assert.equal(r.ok, false);
  assert.match(r.reason, /exit=1/);
  assert.match(r.reason, /moov atom not found/);
});

await check('ffmpeg 启动抛错：reason 说明不可用', async () => {
  const impl = () => { throw new Error('ENOENT ffmpeg'); };
  const r = await convertHeicToJpeg(HEIC, { spawnImpl: impl });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ENOENT ffmpeg/);
});

await check('超时：reason 明确（不会永远挂住）', async () => {
  const impl = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { end() {} }; c.kill = () => {}; return c; };
  const r = await convertHeicToJpeg(HEIC, { spawnImpl: impl, timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /超时/);
});

if (failed) { console.error(`\n❌ HEIC 测试失败（${failed} 项）`); process.exit(1); }
console.log('\n🎉 HEIC 测试通过');
