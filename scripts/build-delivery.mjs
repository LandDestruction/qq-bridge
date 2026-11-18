#!/usr/bin/env node
// build-delivery.mjs —— 一键构建「完整机器人系统」交付包。
//
// 设计原则：
//   1. 唯一真源：scripts/delivery-manifest.json（include/exclude/redact/optional）。
//      本脚本不硬编码第二份名单。
//   2. 先构建 stage → 跑 verify-delivery 双闸 → 只有全绿才 zip。
//   3. 隐私：先按 exclude 剥目录/文件名，再对文本做 redact；--config 指向的真实 config.json
//      里的 QQ/群号/令牌会被替换成占位符（构建机的真实值不会进包）。
//
// 用法：
//   node scripts/build-delivery.mjs                 # 出完整包（含 zip + sha256）
//   node scripts/build-delivery.mjs -DryRun         # 只建 stage，不 zip（保留给你看）
//   node scripts/build-delivery.mjs -Full           # 额外带 audio/ 与 node_modules/
//   node scripts/build-delivery.mjs --config <真实 config.json 路径>   # 用真实值做动态脱敏
//   node scripts/build-delivery.mjs --stamp 20261027-1300 --out dist/delivery
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'scripts', 'delivery-manifest.json');
const argv = process.argv.slice(2);
const has = (re) => argv.some((a) => re.test(a));
const argOf = (name, def = '') => {
  const i = argv.findIndex((a) => a === name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const DRY = has(/^(-DryRun|--dry-run)$/i);
const FULL = has(/^(-Full|--full)$/i);
const JSON_OUT = has(/^--json$/i);
const OUT_ROOT = path.resolve(ROOT, argOf('--out', path.join('dist', 'delivery')));
const CONFIG_PATH = argOf('--config', '');
const STATE_DIR = path.resolve(ROOT, argOf('--state', process.env.QQ_BRIDGE_STATE || 'state'));
const stamp = argOf('--stamp', (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
})());

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8').replace(/^\uFEFF/, ''));
const log = (msg) => { if (!JSON_OUT) console.log(msg); };
if (DRY) log('  （DryRun：只建 stage，不写 zip）');
if (!CONFIG_PATH && !fs.existsSync(path.join(ROOT, 'config.json'))) {
  log('  ⚠️ 未提供 --config：构建机真实 QQ/群号/令牌不会被动态替换。');
  log('     若隐私闸报 qq-like-number，请加 --config <真实 config.json 路径> 重跑（只读，不会改它）。');
}

// ── 工具 ────────────────────────────────────────────────────────────────────
const toPosix = (p) => p.split(path.sep).join('/');
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = toPosix(path.relative(base, abs));
    if (e.isDirectory()) { out.push({ rel, abs, dir: true }); walk(abs, base, out); }
    else if (e.isFile()) out.push({ rel, abs, dir: false });
  }
  return out;
}
const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
const dirBanned = new Set(manifest.exclude.dirsAnywhere ?? []);
const nameGlobs = (manifest.exclude.nameGlobs ?? []).map(globToRe);
const rootGlobs = (manifest.exclude.rootGlobs ?? []).map(globToRe);
const excludePaths = new Set((manifest.exclude.paths ?? []).map((p) => toPosix(p)));
const textExts = new Set(manifest.redact.extensions ?? []);
const isText = (rel) => textExts.has(path.extname(rel).toLowerCase());

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

// ── 动态脱敏字面量（来自真实 config.json，绝不写盘保存）──────────────────────
const NUMBER_KEYS = new Set(['ownerQQ', 'allow.private', 'allow.groups']);
function collectLiterals() {
  const out = [];
  let seq = 0;
  const push = (literal, placeholder, kind) => {
    const s = String(literal ?? '').trim();
    if (s.length < 4) return;
    if (/^<.*>$/.test(s)) return;
    if (out.some((x) => x.literal === s)) return;
    seq += 1;
    // 代码文件里不能塞 <占位符>（会破坏语法），数字类改成同长度的假数字。
    const fake = kind === 'number' ? ('1' + String(seq).padStart(s.length - 1, '0')).slice(0, s.length) : null;
    out.push({ literal: s, placeholder, kind, fake });
  };
  for (const item of manifest.redact.knownLiterals ?? []) {
    const s = String(item.literal ?? '');
    push(s, item.replace ?? '<已脱敏>', /^\d+$/.test(s) ? 'number' : 'text');
  }
  const cfgPath = CONFIG_PATH || path.join(ROOT, 'config.json');
  if (fs.existsSync(cfgPath)) {
    let cfg = null;
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')); } catch { cfg = null; }
    if (cfg) {
      const spec = manifest.redact.dynamicLiterals ?? {};
      const placeholders = spec.replaceWith ?? {};
      const getPath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
      for (const key of spec.fromConfig ?? []) {
        const value = getPath(cfg, key);
        for (const v of (Array.isArray(value) ? value : [value])) {
          const s = String(v ?? '').trim();
          push(s, placeholders[key] ?? '<已脱敏>', NUMBER_KEYS.has(key) ? 'number' : 'text');
        }
      }
    }
  }
  // 构建机仓库根也当成本机路径脱敏（避免包内出现绝对安装路径）
  out.push({ literal: ROOT, placeholder: '<本机路径>', kind: 'text', fake: null });
  // 长字面量先替换，避免短串先命中导致长串被切碎
  out.sort((a, b) => b.literal.length - a.literal.length);
  return out;
}
const literals = collectLiterals();

const CODE_EXT = /\.(mjs|js|cjs|py)$/i;
function redactText(text, isCodeFile) {
  let out = text;
  for (const rule of manifest.redact.patterns ?? []) {
    try { out = out.replace(new RegExp(rule.regex, 'g'), rule.replace); } catch { /* 规则写错就不生效，verify 会兜底 */ }
  }
  for (const { literal, placeholder, kind, fake } of literals) {
    // 代码里塞 <群号> 会破坏语法（如 isArchiveGroup(on, <群号>)），数字类改同长度假数字。
    out = out.split(literal).join(isCodeFile && kind === 'number' ? fake : placeholder);
  }
  return out;
}

// ── stage 构建 ──────────────────────────────────────────────────────────────
const stageName = `${manifest.packageName}-${stamp}`;
const stage = path.join(OUT_ROOT, stageName);
if (fs.existsSync(stage)) {
  console.error(`❌ 目标已存在，先删掉或换个 stamp：${stage}`);
  process.exit(2);
}
fs.mkdirSync(OUT_ROOT, { recursive: true });
fs.mkdirSync(stage, { recursive: true });

const includeDirs = manifest.include.map((i) => ({ src: path.join(ROOT, i.from), rel: i.to ?? i.from }));
const copied = [];
for (const item of includeDirs) {
  if (!fs.existsSync(item.src)) {
    log(`  · 跳过（源不存在）：${item.rel}`);
    continue;
  }
  fs.cpSync(item.src, path.join(stage, item.rel), { recursive: true });
  copied.push(item.rel);
}
for (const [key, opt] of Object.entries(manifest.optional ?? {})) {
  if (!FULL) continue;
  for (const dir of opt.dirs ?? []) {
    const src = path.join(ROOT, dir);
    if (fs.existsSync(src)) { fs.cpSync(src, path.join(stage, dir), { recursive: true }); log(`  + 可选档：${dir}`); }
  }
}

// 剪枝：目录名 / 文件名 glob / 显式路径 / 根级 glob
let pruned = 0;
function prune() {
  for (const entry of walk(stage)) {
    const rel = entry.rel;
    const parts = rel.split('/');
    if (parts.some((p) => dirBanned.has(p))) { fs.rmSync(entry.abs, { recursive: true, force: true }); pruned += 1; continue; }
    if (!entry.dir) {
      const base = parts[parts.length - 1];
      if (nameGlobs.some((re) => re.test(base))) { fs.rmSync(entry.abs, { force: true }); pruned += 1; continue; }
      if (!rel.includes('/') && rootGlobs.some((re) => re.test(base))) { fs.rmSync(entry.abs, { force: true }); pruned += 1; continue; }
    }
    if (excludePaths.has(rel)) { fs.rmSync(entry.abs, { recursive: true, force: true }); pruned += 1; }
  }
  // 目录删空后可能留下空壳；清掉空目录（保持包干净）
  for (const entry of walk(stage).sort((a, b) => b.rel.length - a.rel.length)) {
    if (!entry.dir) continue;
    try { if (fs.readdirSync(entry.abs).length === 0) fs.rmdirSync(entry.abs); } catch { /* ignore */ }
  }
}
prune();

// ── state/ 白名单例外：表情库（用户 2026-10-27 12:59 拍板：默认带）─────────────
// 除这两个路径外，state/ 仍然整体剥离。字段级脱敏在这里做，因为 url/fileid 里的数字
// 是发消息必需的，不能让通用脱敏或隐私闸动它。
const stickerStats = { shape: 'none', records: 0, changed: 0, files: 0, bytes: 0, missing: [] };
function sanitizeStickerJson(srcAbs, dstAbs) {
  const raw = fs.readFileSync(srcAbs, 'utf8');
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  let list;
  let shape;
  if (Array.isArray(parsed)) { list = parsed; shape = 'array'; }
  else {
    const key = Object.keys(parsed).find((k) => Array.isArray(parsed[k]));
    list = key ? parsed[key] : [];
    shape = `object${key ? `(${key})` : '(no-array)'}`;
  }
  // 按要求先打印顶层键，不假设形状
  log(`  表情库：顶层 ${Array.isArray(parsed) ? '数组' : '对象[' + Object.keys(parsed).join(',') + ']'}；形状=${shape}；记录=${list.length}`);
  const f = manifest.redact.stickerFields ?? {};
  const numRe = /\b[1-9]\d{5,12}\b/g;
  let changed = 0;
  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    for (const k of f.clear ?? []) if (k in rec) { if (rec[k] !== '') { rec[k] = ''; changed += 1; } }
    for (const k of f.nickname ?? []) if (k in rec) { if (rec[k] !== '<群友>') { rec[k] = '<群友>'; changed += 1; } }
    for (const k of f.groupNumber ?? []) {
      if (typeof rec[k] === 'string') { const v = rec[k].replace(numRe, '<群号>'); if (v !== rec[k]) { rec[k] = v; changed += 1; } }
      else if (Array.isArray(rec[k])) rec[k] = rec[k].map((v) => (typeof v === 'string' ? v.replace(numRe, '<群号>') : v));
    }
    for (const k of f.textRedact ?? []) {
      const fix = (v) => (typeof v === 'string' ? redactText(v, false).replace(numRe, '<群号>') : v);
      if (typeof rec[k] === 'string') rec[k] = fix(rec[k]);
      else if (Array.isArray(rec[k])) rec[k] = rec[k].map(fix);
    }
  }
  fs.writeFileSync(dstAbs, JSON.stringify(parsed), 'utf8');
  stickerStats.shape = shape;
  stickerStats.records = list.length;
  stickerStats.changed = changed;
}
for (const rel of manifest.stateWhitelist?.paths ?? []) {
  const src = path.join(STATE_DIR, rel.replace(/^state[\\/]/, ''));
  const dst = path.join(stage, rel);
  if (!fs.existsSync(src)) { stickerStats.missing.push(rel); log(`  · 表情库缺失（跳过）：${rel}`); continue; }
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.cpSync(src, dst, { recursive: true });
    for (const e of walk(dst)) if (!e.dir) { stickerStats.files += 1; stickerStats.bytes += fs.statSync(e.abs).size; }
  } else if (st.isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (/stickers\.json$/i.test(rel)) sanitizeStickerJson(src, dst);
    else fs.copyFileSync(src, dst);
  }
}
if (stickerStats.records || stickerStats.files) {
  log(`  表情库：${stickerStats.records} 条记录 / ${stickerStats.files} 个图片 / ${(stickerStats.bytes / 1024 / 1024).toFixed(2)} MB（字段级脱敏 ${stickerStats.changed} 处）`);
}
if (stickerStats.missing.length) {
  log(`  ⚠️ 表情库未随包（state 目录找不到）：${stickerStats.missing.join(', ')}；用 --state <真实 state 目录> 指定`);
}

// 文本脱敏（原地）
let redacted = 0;
for (const entry of walk(stage)) {
  if (entry.dir || !isText(entry.rel)) continue;
  const text = fs.readFileSync(entry.abs, 'utf8');
  const out = redactText(text, CODE_EXT.test(entry.rel));
  if (out !== text) { fs.writeFileSync(entry.abs, out, 'utf8'); redacted += 1; }
}

// 生成包内元数据
const sourceCommit = (() => {
  const r = sh('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']);
  return r.status === 0 ? r.stdout.trim() : '';
})();
const files = walk(stage).filter((e) => !e.dir);
const totalBytes = files.reduce((n, e) => n + fs.statSync(e.abs).size, 0);
const tsv = files.map((e) => {
  const size = fs.statSync(e.abs).size;
  const sha = crypto.createHash('sha256').update(fs.readFileSync(e.abs)).digest('hex');
  return `${e.rel}\t${size}\t${sha}`;
});
fs.writeFileSync(path.join(stage, 'MANIFEST.tsv'), 'path\tsize\tsha256\n' + tsv.join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(stage, 'SHA256SUMS.txt'), tsv.map((l) => { const [p, , h] = l.split('\t'); return `${h}  ${p}`; }).join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(stage, 'DELIVERY-MANIFEST.json'), JSON.stringify({
  package: manifest.packageName,
  stamp,
  mode: FULL ? 'full' : 'normal',
  builtAt: new Date().toISOString(),
  sourceCommit,
  node: process.version,
  fileCount: files.length + 2,
  bytesHuman: `${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
  pending: Object.keys(manifest.pending ?? {}),
  stickers: {
    shape: stickerStats.shape,
    records: stickerStats.records,
    files: stickerStats.files,
    mb: Number((stickerStats.bytes / 1024 / 1024).toFixed(2)),
    note: '表情库是 state/ 的唯一白名单例外；collectedBy→<群友>，collectedContext/lastContext 清空，source/collectedFrom 群号→<群号>；id/url/fileid 等原样保留。'
  },
  note: '本包由 scripts/build-delivery.mjs 按 scripts/delivery-manifest.json 生成；真实 token/QQ/群号已替换为占位符。'
}, null, 2) + '\n', 'utf8');

log(`  复制 ${copied.length} 项，剪枝 ${pruned} 项，脱敏 ${redacted} 个文件，共 ${files.length + 2} 个文件 / ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

// ── 双闸 ────────────────────────────────────────────────────────────────────
const verify = sh(process.execPath, [path.join(ROOT, 'scripts', 'verify-delivery.mjs'), '--dir', stage, '--json']);
let report = null;
try { report = JSON.parse(verify.stdout || '{}'); } catch { /* 下面按失败处理 */ }
const verifyOk = verify.status === 0 && report && report.ok;
log('');
log(`  完整性闸：${report?.integrity?.ok ? '✅' : '❌'}  ${report?.integrity?.summary ?? '(无输出)'}`);
log(`  隐私闸  ：${report?.privacy?.ok ? '✅' : '❌'}  ${report?.privacy?.summary ?? '(无输出)'}`);
if (!verifyOk) {
  log('');
  log('❌ 双闸未通过，保留 stage 供排查：' + stage);
  for (const item of [...(report?.integrity?.failures ?? []), ...(report?.privacy?.violations ?? [])].slice(0, 20)) {
    log('   - ' + (typeof item === 'string' ? item : `${item.file}:${item.line ?? 0} [${item.kind}] ${item.excerpt ?? item.detail ?? ''}`));
  }
  if (!JSON_OUT) console.log(verify.stdout?.slice(-1500) ?? '');
  process.exit(1);
}

// ── 打包 ────────────────────────────────────────────────────────────────────
let zipPath = '';
let zipSha = '';
if (!DRY) {
  zipPath = path.join(OUT_ROOT, `${stageName}.zip`);
  if (fs.existsSync(zipPath)) { console.error(`❌ zip 已存在：${zipPath}`); process.exit(2); }
  const r = sh('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${stage.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -CompressionLevel Optimal`]);
  if (r.status !== 0) {
    console.error('❌ Compress-Archive 失败：' + (r.stderr || r.stdout));
    process.exit(1);
  }
  const h = sh('powershell', ['-NoProfile', '-Command', `(Get-FileHash -Algorithm SHA256 '${zipPath.replace(/'/g, "''")}').Hash`]);
  zipSha = (h.stdout || '').trim().toLowerCase();
  fs.writeFileSync(`${zipPath}.sha256`, `${zipSha} *${path.basename(zipPath)}\n`, 'utf8');
}

const summary = {
  ok: true,
  stage,
  zip: zipPath || null,
  sha256: zipSha || null,
  mode: FULL ? 'full' : 'normal',
  files: files.length + 2,
  bytes: totalBytes,
  integrity: report.integrity,
  privacy: report.privacy,
  pending: Object.keys(manifest.pending ?? {})
};
if (JSON_OUT) console.log(JSON.stringify(summary, null, 2));
else {
  log('');
  log(`✅ 完成${DRY ? '（DryRun：未打 zip）' : ''}`);
  log(`  目录：${stage}`);
  if (zipPath) { log(`  zip ：${zipPath}  (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(2)} MB)`); log(`  sha ：${zipSha}`); }
  log(`  文件：${summary.files}；凭据/群号已脱敏；细节见包内 DELIVERY-README.md`);
}
