#!/usr/bin/env node
// 给「本地画面记忆」补详细描述：不是拿备注凑数，而是让视觉模型先认真看一遍图，
// 输出一段 120~300 字的画面描述，再把这段描述存进 state/image-memory.json。
//
// 为什么需要：表情/图片的备注往往只有两三个字（甚至没有），
// 拿它当「画面记忆」等于没记住；dHash 命中的前提是「描述足够具体」。
//
// 用法：
//   node scripts/backfill-image-memory.mjs [--limit N] [--dry-run] [--json] [--force] [--delay 1200] [--min-chars 80]
// 说明：
//   --limit N     只处理 N 条（默认 20，避免一口气烧钱）
//   --force       已有较长描述的也重做
//   --min-chars   已有描述长度 ≥ 这个值就跳过（默认 80）
// 只读 state/stickers.json 与 state/sticker-files/，写 state/image-memory.json（写前备份）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describeImageWithZhipu } from '../src/zhipu-vision.js';
import { normalizeImageMemory, rememberImage } from '../src/image-memory.js';

const execFileP = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const STICKERS = path.join(ROOT, 'state', 'stickers.json');
const FILES_DIR = path.join(ROOT, 'state', 'sticker-files');
const MEMORY = path.join(ROOT, 'state', 'image-memory.json');
const CONFIG = path.join(ROOT, 'config.json');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const limit = Math.max(1, Math.min(500, arg('--limit', 20)));
const delayMs = Math.max(0, Math.min(10000, arg('--delay', 1200)));
const minChars = Math.max(0, Math.min(2000, arg('--min-chars', 80)));
const dryRun = argv.includes('--dry-run');
const asJson = argv.includes('--json');
const force = argv.includes('--force');

const DETAIL_PROMPT = [
  '你在帮一个聊天机器人建立「画面记忆」。只输出描述，不要寒暄。',
  '要求：用中文写 120~300 字，具体到能让人凭这段文字认出同一张图：',
  '①主体是谁/是什么（外貌、发型、服装、颜色）；②动作与表情；③画面里的文字（原样抄下来）；',
  '④构图与背景；⑤如果是表情包，说明它在表达什么情绪或梗。',
  '看不清的不要编；涉黄涉暴只做中性描述。',
].join('');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function sniffMime(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return '';
}

async function toJpeg(buffer, mime) {
  if (mime === 'image/jpeg') return { buffer, mimeType: 'image/jpeg' };
  const tmpIn = path.join(os.tmpdir(), `imgmem-${process.pid}-${Date.now()}.bin`);
  const tmpOut = `${tmpIn}.jpg`;
  fs.writeFileSync(tmpIn, buffer);
  try {
    await execFileP('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', tmpIn, '-frames:v', '1',
      '-vf', 'scale=640:-2', '-q:v', '3', tmpOut], { timeout: 30000 });
    const out = fs.readFileSync(tmpOut);
    if (!out.length) throw new Error('ffmpeg 产出为空');
    return { buffer: out, mimeType: 'image/jpeg' };
  } finally {
    for (const f of [tmpIn, tmpOut]) { try { fs.unlinkSync(f); } catch {} }
  }
}

function findFile(md5) {
  const key = String(md5 || '').trim().toUpperCase();
  if (!/^[0-9A-F]{16,64}$/.test(key)) return '';
  for (const name of [`${key}.img`, `${key}.jpg`, `${key}.png`, `${key}.gif`, `${key}.webp`]) {
    const p = path.join(FILES_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return '';
}

const cfg = readJson(CONFIG, {});
const raw = readJson(STICKERS, []);
const stickers = Array.isArray(raw) ? raw : (Array.isArray(raw?.entries) ? raw.entries : []);
let mem = normalizeImageMemory(readJson(MEMORY, { version: 1, entries: [] }));
const byHash = new Map(mem.entries.map((e) => [e.h, e]));

let scanned = 0;
let candidates = 0;
let done = 0;
let ok = 0;
let failed = 0;
let skippedStrong = 0;
let skippedNoFile = 0;

for (const s of stickers) {
  if (!s || typeof s !== 'object') continue;
  scanned += 1;
  const hash = String(s.dhash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8,16}$/.test(hash)) continue;
  const cur = byHash.get(hash);
  const curLen = cur && cur.d ? String(cur.d).length : 0;
  if (!force && curLen >= minChars) { skippedStrong += 1; continue; }
  const file = findFile(s.md5);
  if (!file) { skippedNoFile += 1; continue; }
  candidates += 1;
}

for (const s of stickers) {
  if (done >= limit) break;
  if (!s || typeof s !== 'object') continue;
  const hash = String(s.dhash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8,16}$/.test(hash)) continue;
  const cur = byHash.get(hash);
  const curLen = cur && cur.d ? String(cur.d).length : 0;
  if (!force && curLen >= minChars) continue;
  const file = findFile(s.md5);
  if (!file) continue;
  done += 1;
  const note = [s.localNote, s.desc, Array.isArray(s.tags) ? s.tags.join('/') : ''].filter(Boolean).join(' · ');
  if (dryRun) { ok += 1; continue; }
  try {
    const rawBuf = fs.readFileSync(file);
    const mime = sniffMime(rawBuf);
    if (!mime) { failed += 1; continue; }
    const img = await toJpeg(rawBuf, mime);
    const r = await describeImageWithZhipu({ buffer: img.buffer, mimeType: img.mimeType, cfg, prompt: DETAIL_PROMPT });
    if (!r || !r.ok || !r.text) { failed += 1; continue; }
    const desc = String(r.text).replace(/\s+/g, ' ').trim().slice(0, 400);
    const rec = rememberImage(mem, { hash, desc, kind: 'sticker', note }, { maxEntries: 20000 });
    mem = rec.store;
    byHash.set(hash, mem.entries.find((e) => e.h === hash));
    ok += 1;
  } catch {
    failed += 1;
  }
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
}

const result = { scanned, candidates, processed: done, ok, failed, skippedStrong, skippedNoFile, total: mem.entries.length, dryRun, limit };
if (!dryRun && ok > 0) {
  if (fs.existsSync(MEMORY)) fs.copyFileSync(MEMORY, `${MEMORY}.bak-${Date.now()}`);
  fs.writeFileSync(MEMORY, JSON.stringify(mem));
}
if (asJson) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`表情 ${scanned} 条；可补 ${candidates} 条；本次处理 ${done}（成功 ${ok} / 失败 ${failed}）`);
  console.log(`跳过：已有长描述 ${skippedStrong} / 没有本地文件 ${skippedNoFile}；图库现在 ${mem.entries.length} 条${dryRun ? '（dry-run，未写盘）' : ''}`);
}
