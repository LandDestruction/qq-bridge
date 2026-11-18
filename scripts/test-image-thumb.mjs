import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { normalizeThumbWidth, scaleImageBuffer, THUMB_W_DEFAULT } from "../src/image-thumb.js";
let failed = 0;
async function check(n, f) { try { await f(); console.log("✅ " + n); } catch (e) { failed++; console.error("❌ " + n + " — " + (e?.message ?? e)); } }
check("w 参数规范化", async () => {
  assert.equal(normalizeThumbWidth(null), null);
  assert.equal(normalizeThumbWidth(""), null);
  assert.equal(normalizeThumbWidth("480"), 480);
  assert.equal(normalizeThumbWidth("10"), 64);
  assert.equal(normalizeThumbWidth("99999"), 1024);
  assert.equal(normalizeThumbWidth("abc"), THUMB_W_DEFAULT);
});
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
function fakeSpawn({ out = JPEG, code = 0 } = {}) {
  const calls = [];
  const impl = (cmd, args) => {
    calls.push({ cmd, args });
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { end() {} }; c.kill = () => {};
    setTimeout(() => { if (out) c.stdout.emit("data", out); c.emit("close", code); }, 5);
    return c;
  };
  return { impl, calls };
}
await check("缩放成功：返回 JPEG，且 scale 参数带上宽度", async () => {
  const { impl, calls } = fakeSpawn();
  const r = await scaleImageBuffer(Buffer.from("img"), 480, { spawnImpl: impl });
  assert.equal(r[0], 0xff);
  assert.ok(calls[0].args.some((a) => String(a).includes("scale=480:-2")));
});
await check("ffmpeg 失败/超时 → null（调用方回原图）", async () => {
  const bad = fakeSpawn({ out: Buffer.alloc(2), code: 1 });
  assert.equal(await scaleImageBuffer(Buffer.from("x"), 480, { spawnImpl: bad.impl }), null);
  const hang = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stdin = { end() {} }; c.kill = () => {}; return c; };
  assert.equal(await scaleImageBuffer(Buffer.from("x"), 480, { spawnImpl: hang, timeoutMs: 20 }), null);
});
if (failed) process.exit(1);
console.log("\n🎉 缩略图缩放测试通过");
