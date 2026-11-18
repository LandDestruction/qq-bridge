// D66：超长截图纵向切片的离线回归。
//
// 背景（2026-10-27 真机，group:100000001）：1200×14102 的聊天长截图按旧策略（长边≤1280 等比缩）
// 被压成 108×1280，文字全糊，模型只能说「看不到」。修法是按高度切段、每段保持原宽再分别喂给视觉模型。
//
// 本文件验证：
//   1. 纯函数 planTallTiles / planNormalization 的判定与几何（片数、重叠、覆盖、输出尺寸、拒窄）；
//   2. 普通图（800×600）与原动图路径完全不变；
//   3. 有 ffmpeg 时真跑两张长图的切片（尺寸/片数/单片体积），没有 ffmpeg 明确 SKIP。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planNormalization, planTallTiles, normalizeImageForModel, sniffImage } from '../src/media-normalize.js';

let failures = 0;
let skipped = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) {
    if (error?.skip) { skipped++; console.log('SKIP', name, '—', error.skip); return; }
    failures++; console.error('FAIL', name, '—', error?.stack ?? error);
  }
}
const skip = (why) => Object.assign(new Error(why), { skip: why });

const hasFfmpeg = (() => {
  try { return spawnSync('ffmpeg', ['-v', 'error', '-version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
})();

const infoOf = (width, height, extra = {}) => ({ width, height, format: 'png', animated: false, ...extra });

// ── 1. 几何：切片规划 ─────────────────────────────────────────────────────

await test('1200×14102：切成 8 片，保持原宽 1200，段间重叠 7%', () => {
  const tall = planTallTiles(infoOf(1200, 14102));
  assert.equal(tall.kind, 'tiles');
  assert.equal(tall.count, 8);
  assert.equal(tall.tiles.length, 8);
  assert.equal(tall.outWidth, 1200);
  assert.ok(tall.outHeight > 0 && tall.outHeight <= 2048, `单片长边 ${tall.outHeight} 应 ≤2048`);
  // 覆盖全图：第一片从 0 开始、最后一片贴底
  assert.equal(tall.tiles[0].y, 0);
  assert.equal(tall.tiles[tall.tiles.length - 1].y + tall.tiles[tall.tiles.length - 1].h, 14102);
  // 每片等高，且相邻片确实重叠 5%~8%
  for (const tile of tall.tiles) assert.equal(tile.h, tall.tileHeight);
  for (let i = 1; i < tall.tiles.length; i += 1) {
    const overlap = tall.tiles[i - 1].y + tall.tiles[i - 1].h - tall.tiles[i].y;
    const ratio = overlap / tall.tileHeight;
    assert.ok(ratio >= 0.05 && ratio <= 0.08, `第 ${i} 片重叠 ${(ratio * 100).toFixed(1)}% 不在 5%~8%`);
  }
});

await test('800×6000：切成 6 片，输出宽放大到 900', () => {
  const tall = planTallTiles(infoOf(800, 6000));
  assert.equal(tall.kind, 'tiles');
  assert.equal(tall.count, 6);
  assert.equal(tall.outWidth, 900);
  assert.ok(tall.outHeight <= 2048);
  assert.equal(tall.tiles[tall.tiles.length - 1].y + tall.tiles[tall.tiles.length - 1].h, 6000);
});

await test('片数上限：长图再长也不超过 maxTiles（默认 8 / 可配 4）', () => {
  const tall = planTallTiles(infoOf(1200, 40000));
  assert.equal(tall.count, 8);
  assert.equal(tall.clamped, true);
  assert.ok(tall.wanted > 8);
  assert.equal(planTallTiles(infoOf(1200, 40000), { maxTiles: 4 }).count, 4);
});

await test('长边约束：超宽长图每片长边也不超过 2048', () => {
  const tall = planTallTiles(infoOf(4000, 30000));
  assert.equal(tall.kind, 'tiles');
  assert.ok(Math.max(tall.outWidth, tall.outHeight) <= 2048);
});

// ── 2. 判定：切 vs 不切 vs 拒 ─────────────────────────────────────────────

await test('planNormalization：1200×14102 → action=tile（不是 shrink）', () => {
  const plan = planNormalization(infoOf(1200, 14102), 1147 * 1024, {});
  assert.equal(plan.action, 'tile');
  assert.equal(plan.tall.count, 8);
});

await test('2.9 倍的长图不切（仍走原来的 shrink 路径）', () => {
  const plan = planNormalization(infoOf(1200, 3480), 900 * 1024, {});
  assert.equal(plan.action, 'shrink');
  assert.equal(plan.tall, undefined);
});

await test('阈值可配：同一个 3 倍图，tallRatio=3.5 时退回 shrink', () => {
  assert.equal(planNormalization(infoOf(1200, 3600), 600 * 1024, {}).action, 'tile');
  assert.equal(planNormalization(infoOf(1200, 3600), 600 * 1024, { tallRatio: 3.5 }).action, 'shrink');
});

await test('极窄长图（宽 200）不硬切，返回可读的拒绝原因', () => {
  const plan = planNormalization(infoOf(200, 3000), 300 * 1024, {});
  assert.equal(plan.action, 'reject');
  assert.match(plan.reason, /太窄/);
  assert.match(plan.reason, /200/);
});

await test('普通图（800×600）与动图行为完全不变', () => {
  assert.equal(planNormalization(infoOf(800, 600), 120 * 1024, {}), null);
  const animated = planNormalization(infoOf(1200, 14102, { animated: true, frames: 6 }), 900 * 1024, {});
  assert.equal(animated.action, 'animate');
  assert.equal(planTallTiles(infoOf(1200, 14102, { animated: true })), null);
});

// ── 3. 真 ffmpeg：实际切片 ────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd66-tiling-'));
const makePng = (width, height, file) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x336699:s=${width}x${height}`, '-frames:v', '1', file], { stdio: 'ignore' });
  if (r.status !== 0) return null;
  return fs.readFileSync(file);
};

await test('真机尺寸 1200×14102：端到端切成 8 片 JPEG，每片 1200×1878 且 ≤1MB', async () => {
  if (!hasFfmpeg) throw skip('本机没有 ffmpeg');
  const buf = makePng(1200, 14102, path.join(tmpRoot, 'tall.png'));
  if (!buf) throw skip('ffmpeg 生成夹具失败');
  const out = await normalizeImageForModel(buf, 'image/png', { maxLongEdge: 1280, maxModelBytes: 1024 * 1024, tmpDir: tmpRoot });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.tall, true);
  assert.equal(out.tiles.length, 8);
  assert.equal(out.mimeType, 'image/jpeg');
  assert.match(out.note, /切成 8 段/);
  for (const [i, tile] of out.tiles.entries()) {
    assert.equal(tile.mimeType, 'image/jpeg');
    assert.ok(tile.buffer.length <= 1024 * 1024, `第 ${i + 1} 片 ${tile.buffer.length}B 超过 1MB`);
    const sn = sniffImage(tile.buffer);
    assert.equal(sn.width, 1200, `第 ${i + 1} 片宽`);
    assert.equal(sn.height, 1878, `第 ${i + 1} 片高`);
    assert.equal(sn.format, 'jpeg');
  }
});

await test('800×6000：端到端切成 6 片，每片 900×1194', async () => {
  if (!hasFfmpeg) throw skip('本机没有 ffmpeg');
  const buf = makePng(800, 6000, path.join(tmpRoot, 'mid.png'));
  if (!buf) throw skip('ffmpeg 生成夹具失败');
  const out = await normalizeImageForModel(buf, 'image/png', { maxLongEdge: 1280, maxModelBytes: 1024 * 1024, tmpDir: tmpRoot });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.tiles.length, 6);
  const sn = sniffImage(out.tiles[0].buffer);
  assert.equal(sn.width, 900);
  assert.equal(sn.height, 1194);
});

await test('普通图 800×600：端到端原样通过，不产生 tiles', async () => {
  if (!hasFfmpeg) throw skip('本机没有 ffmpeg');
  const buf = makePng(800, 600, path.join(tmpRoot, 'normal.png'));
  if (!buf) throw skip('ffmpeg 生成夹具失败');
  const out = await normalizeImageForModel(buf, 'image/png', { maxLongEdge: 1280, maxModelBytes: 1024 * 1024, tmpDir: tmpRoot });
  assert.equal(out.ok, true);
  assert.equal(out.tiles, undefined);
  assert.equal(out.note, '');
  assert.equal(out.buffer.length, buf.length, '小图必须逐字节原样返回');
});

await test('极窄长图（200×3000）：端到端明确拒绝，不返回图片', async () => {
  if (!hasFfmpeg) throw skip('本机没有 ffmpeg');
  const buf = makePng(200, 3000, path.join(tmpRoot, 'narrow.png'));
  if (!buf) throw skip('ffmpeg 生成夹具失败');
  const out = await normalizeImageForModel(buf, 'image/png', { maxLongEdge: 1280, maxModelBytes: 1024 * 1024, tmpDir: tmpRoot });
  assert.equal(out.ok, false);
  assert.match(out.error, /太窄/);
});

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

console.log(`\n========== 通过 ${failures === 0 ? '全部' : '部分'} / 失败 ${failures} / 跳过 ${skipped} ==========`);
process.exit(failures ? 1 : 0);
