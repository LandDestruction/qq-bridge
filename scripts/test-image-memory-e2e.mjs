// 端到端实测：图像记忆 dHash 查表复用链路（真实 ffmpeg + 真实 state 数据）
//
// 与 test-image-memory.mjs（纯逻辑 28 项）不同，这个脚本用**真实的 ffmpeg 进程**和
// **真实的 state/stickers.json + state/image-memory.json** 验证整条链路真的通：
//   ① 反查：重算表情文件的 dHash，对比库存 hash（验证采集/运行时算法一致）；
//   ② remember→find：真实图算 hash 入库 → 同图再查命中（验证运行时闭环）；
//   ③ 变换容忍度：缩放/JPEG 重压后 dHash 距离是否 ≤6（省识图费的命门）。
//
// 前提：本机装了 ffmpeg；state/sticker-files 里有落盘的表情文件。
// 用法：node scripts/test-image-memory-e2e.mjs [--sample N]
// 纯验证、不写任何 state 文件。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dhashFromBufferAsync, hammingDistance } from '../src/image-hash.js';
import { findImageMemory, rememberImage } from '../src/image-memory.js';

const execFileP = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const FILES_DIR = path.join(ROOT, 'state', 'sticker-files');
const argv = process.argv.slice(2);
const N = Number(argv[argv.indexOf('--sample') + 1] || 40);

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
const stickers = readJson(path.join(ROOT, 'state', 'stickers.json'), []);
const mem = readJson(path.join(ROOT, 'state', 'image-memory.json'), { version: 1, entries: [] });

function findFile(md5) {
  const key = String(md5 || '').toUpperCase();
  for (const name of [`${key}.img`, `${key}.jpg`, `${key}.png`, `${key}.gif`, `${key}.webp`]) {
    const p = path.join(FILES_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return '';
}

let failures = 0;
function verdict(ok, label) {
  if (ok) console.log(`  ✅ ${label}`);
  else { failures += 1; console.error(`  ❌ ${label}`); }
}

// ── ① 反查 + 端到端查表 ──────────────────────────────────────────
const candidates = stickers.filter((s) => s && /^[0-9a-f]{8,16}$/.test(String(s.dhash || '').trim()) && findFile(s.md5));
console.log(`[①] 有 dhash 且有落盘文件的表情：${candidates.length} / ${stickers.length}`);
if (candidates.length === 0) { console.error('  没有可测样本（state/sticker-files 为空？）'); process.exit(1); }

const sample = candidates.slice(0, N);
let dist0 = 0, distLE6 = 0, hashNull = 0, lookupHit = 0;
for (const s of sample) {
  const buf = fs.readFileSync(findFile(s.md5));
  const hash = await dhashFromBufferAsync(buf);
  if (!hash) { hashNull += 1; continue; }
  const d = hammingDistance(hash, String(s.dhash).trim().toLowerCase());
  if (d === 0) dist0 += 1;
  if (d <= 6) distLE6 += 1;
  if (findImageMemory(mem, hash)) lookupHit += 1;
}
console.log(`  样本 ${sample.length}：hash 算不出 ${hashNull}，算出 ${sample.length - hashNull}`);
console.log(`  dHash 距离 0：${dist0}；≤6：${distLE6}；查表命中：${lookupHit}/${sample.length - hashNull}`);
verdict(hashNull === 0, '所有样本都能算出 dHash（无 null）');
verdict(distLE6 === sample.length - hashNull, '所有样本 dHash 距离 ≤6');
verdict(lookupHit === sample.length - hashNull, '端到端 findImageMemory(真实库) 全部命中');

// ── ② remember→find 闭环 ────────────────────────────────────────
console.log(`\n[②] remember→find 闭环（内存 store，不碰真实库）`);
let store = { version: 1, entries: [] };
let closed = false;
for (const s of sample) {
  const buf = fs.readFileSync(findFile(s.md5));
  const h = await dhashFromBufferAsync(buf);
  if (!h) continue;
  const r = rememberImage(store, { hash: h, desc: 'e2e-闭环-真实图描述', kind: 'sticker' });
  store = r.store;
  const h2 = await dhashFromBufferAsync(buf);
  const hit = findImageMemory(store, h2);
  closed = !!(hit && hit.distance === 0 && hit.entry.d === 'e2e-闭环-真实图描述');
  break;
}
verdict(closed, 'remember → 同图再查 → 距离 0 命中');

// ── ③ 变换容忍度 ─────────────────────────────────────────────────
console.log(`\n[③] 同一张图做变换后 dHash 距离（≤6 即能复用旧描述省识图）`);
let src = null;
for (const s of candidates) {
  const buf = fs.readFileSync(findFile(s.md5));
  if (await dhashFromBufferAsync(buf)) { src = findFile(s.md5); break; }
}
if (!src) {
  console.error('  找不到可变换的小图');
} else {
  const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'imgmem-e2e-'));
  const variants = {
    '缩放50%': `${tmpDir}/v_scale50.jpg`,
    'JPEG重压q30': `${tmpDir}/v_q30.jpg`,
    '缩放50%+重压q30': `${tmpDir}/v_both.jpg`,
    '灰度化': `${tmpDir}/v_gray.jpg`,
  };
  await execFileP('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', 'scale=iw/2:ih/2', variants['缩放50%']], { timeout: 30000 });
  await execFileP('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', '-q:v', '30', variants['JPEG重压q30']], { timeout: 30000 });
  await execFileP('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', 'scale=iw/2:ih/2', '-q:v', '30', variants['缩放50%+重压q30']], { timeout: 30000 });
  await execFileP('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', 'format=gray', variants['灰度化']], { timeout: 30000 });
  const origHash = await dhashFromBufferAsync(fs.readFileSync(src));
  for (const [label, vpath] of Object.entries(variants)) {
    const vhash = await dhashFromBufferAsync(fs.readFileSync(vpath));
    const d = vhash ? hammingDistance(origHash, vhash) : 64;
    console.log(`  ${label}: 距离=${d} ${d <= 6 ? '✅' : '❌'}`);
    if (d > 6) failures += 1;
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

if (failures) { console.error(`\n❌ 端到端测试失败（${failures} 项）`); process.exit(1); }
console.log('\n🎉 图像记忆 dHash 查表复用链路端到端验证通过');
