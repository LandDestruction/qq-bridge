#!/usr/bin/env node
// 表情缩略图修复：给缺少本地缓存/缺 md5 的表情补下载 + 补 md5 回填。
//
// 用法：
//   node scripts/repair-sticker-thumbs.mjs            # 只检查并打印
//   node scripts/repair-sticker-thumbs.mjs --apply    # 实际下载/回填（先备份 stickers.json）
//
// 判断「缺缓存」：state/sticker-files 里既没有 <md5>.img，也没有 id 派生的 md5 .img。
// 处理：按 entry.url 下载（带 UA/referer，8s 超时）→ sha256 不必要，md5 即可 → 写 <md5>.img → 回填 entry.md5。
// 失败：记录原因，不写坏数据（保持原样，面板会显示占位）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const FILE = path.join(ROOT, 'state', 'stickers.json');
const CACHE = path.join(ROOT, 'state', 'sticker-files');
const apply = process.argv.includes('--apply');

const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const list = Array.isArray(raw) ? raw : (raw.entries || raw.stickers || []);
const files = new Set(fs.readdirSync(CACHE).map((f) => f.toLowerCase()));

const need = [];
for (const e of list) {
  const md5 = String(e.md5 || '').toLowerCase();
  const idMd5 = (String(e.id || '').match(/([0-9a-f]{32})/i) || [])[1]?.toLowerCase() || '';
  const hit = [md5, idMd5].filter(Boolean).some((c) => files.has(c + '.img'));
  if (!hit) need.push(e);
}
console.log(`总 ${list.length} 条，缺本地缓存 ${need.length} 条`);
if (!apply) { console.log('(dry run；加 --apply 才下载)'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.copyFileSync(FILE, FILE + '.bak-thumbs-' + stamp);

let ok = 0, fail = 0;
for (const e of need) {
  const url = String(e.url || '').trim();
  const label = String(e.id || '').slice(0, 40);
  if (!/^https?:/.test(url)) { console.log(`  跳过 ${label}：没有可用 url`); fail++; continue; }
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', referer: 'https://qq.com/' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) { console.log(`  失败 ${label}：HTTP ${r.status}`); fail++; continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) { console.log(`  失败 ${label}：空响应`); fail++; continue; }
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    fs.writeFileSync(path.join(CACHE, md5 + '.img'), buf);
    files.add(md5 + '.img');
    e.md5 = md5.toUpperCase();
    ok++;
    console.log(`  修好 ${label}：${buf.length}B → ${md5.slice(0, 12)}…`);
  } catch (error) {
    console.log(`  失败 ${label}：${error?.message ?? error}`);
    fail++;
  }
}

if (ok > 0) {
  const payload = Array.isArray(raw) ? list : { ...raw, entries: list, stickers: Array.isArray(raw.stickers) ? list : raw.stickers };
  fs.writeFileSync(FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`已写盘（备份 .bak-thumbs-${stamp}）`);
}
console.log(`结果：修好 ${ok}，失败 ${fail}，仍缺 ${need.length - ok}`);
