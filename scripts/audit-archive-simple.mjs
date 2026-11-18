#!/usr/bin/env node
// simpleMode 归档只读审计：磁盘布局 × src/file-archive.js 规则 × file_archive 台账。
// 全程只读：只 fs.readdir/stat/read，DB 以 readOnly 打开，**不创建/移动/删除任何文件**。
//
// 用法：
//   node scripts/audit-archive-simple.mjs --root E:/booth-inbox --db <messages.db 副本>
//   可选：--json            机器可读输出
//         --sha            逐条重算 sha256 与台账比对（读 239MB，约 1~2 秒）
//         --simple true|false  覆盖 simpleMode 判定（默认 true，与线上 config 一致）
//
// 审计口径（与源码对齐）：
//   simpleBoothId()      src/file-archive.js:174  → /^(\d{7})(?!\d)/
//   simpleArchiveDir()   src/file-archive.js:185  → <群号_群名>/<7位号>/ 或 <群号_群名>/<YYYY-MM>/
//   ARCHIVE_EXTENSIONS   src/file-archive.js:33   → zip rar 7z tar gz tgz bz2 xz zst
//   IMAGE_EXTENSIONS     src/file-archive.js:35   → jpg jpeg png gif webp bmp heic
//   MAX_FILE_MB          src/file-archive.js:26   → 2560
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { simpleBoothId, ARCHIVE_EXTENSIONS, IMAGE_EXTENSIONS, MAX_FILE_MB } from '../src/file-archive.js';

const argv = process.argv.slice(2);
const argOf = (name, dflt = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(name);
const ROOT = path.resolve(argOf('--root', 'E:/booth-inbox'));
const DB_PATH = argOf('--db', '');
const SIMPLE = argOf('--simple', 'true') !== 'false';
const AS_JSON = has('--json');
const DO_SHA = has('--sha');
const MB = 1024 * 1024;

// 迁移脚本 scripts/migrate-archive-simple-layout.mjs:60-62 的落点规则（与运行时不同，单独核对）
const MIGRATE_UNCLASSIFIED_DIR = '_未分类';
// 台账/扩写产生的旁挂文件（不是用户发来的原件）
const ARTIFACT_RE = /(^meta\.json$|\.meta\.json$|(^|\.)thumbnail\.(jpe?g|png|gif|webp)$)/i;

function walk(dirAbs, relBase = '', out = []) {
  for (const ent of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const abs = path.join(dirAbs, ent.name);
    const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(abs, rel, out);
    else if (ent.isFile()) {
      const st = fs.statSync(abs);
      out.push({ rel, abs, name: ent.name, bytes: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

function toPosix(p) { return String(p).replace(/\\/g, '/'); }

function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(name));
  return m ? m[1].toLowerCase() : '';
}

// ── 磁盘清单 ────────────────────────────────────────────────────────────────
if (!fs.existsSync(ROOT)) {
  console.error(`审计根不存在：${ROOT}`);
  process.exit(2);
}
const files = walk(ROOT).sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
const topDirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const originals = files.filter((f) => !ARTIFACT_RE.test(f.name));
const artifacts = files.filter((f) => ARTIFACT_RE.test(f.name));

// 每个文件的布局判定（以 simpleMode 运行时规则为准）
const layout = files.map((f) => {
  const seg = toPosix(f.rel).split('/');
  const top = seg[0];
  const parent = seg.slice(0, -1).join('/');
  const boothId = simpleBoothId(f.name);
  // 运行时：带 7 位号 → <群号_群名>/<号>/；否则 → <群号_群名>/<YYYY-MM>/
  const ym = (() => { const d = new Date(f.mtime); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
  const expectParentFromName = boothId || 'YYYY-MM';
  const inBoothDir = /^\d{7}$/.test(seg[1] || '');
  const inYmDir = /^\d{4}-\d{2}$/.test(seg[1] || '');
  const underUnclassified = top === MIGRATE_UNCLASSIFIED_DIR;
  const ext = extOf(f.name);
  const isArtifact = ARTIFACT_RE.test(f.name);
  const nameRuleOk = boothId ? (inBoothDir && seg[1] === boothId) : true;
  const ok = isArtifact
    ? true // 旁挂文件不参与归档规则
    : (boothId ? (inBoothDir && seg[1] === boothId) : (inYmDir || underUnclassified));
  return {
    rel: toPosix(f.rel), top, parent, bytes: f.bytes, ext, boothId,
    inBoothDir, inYmDir, underUnclassified, isArtifact,
    expectedParent: expectParentFromName, nameRuleOk, ok
  };
});

const deviations = layout.filter((r) => !r.ok);

// ── 台账 ────────────────────────────────────────────────────────────────────
let db = null;
let rows = [];
let dbError = '';
if (DB_PATH) {
  try {
    const mod = await import('node:sqlite');
    db = new mod.DatabaseSync(path.resolve(DB_PATH), { readOnly: true });
    rows = db.prepare("SELECT id,group_id,file_name,stored_name,rel_path,bytes,category,category_source,booth_id,deleted_at,archived_at,cleanup_at,sha256,meta_rel,thumb_rel,enrich_status FROM file_archive ORDER BY id").all()
      .map((r) => ({ ...r }));
  } catch (error) {
    dbError = String(error?.message ?? error);
  }
}

const activeRows = rows.filter((r) => r.deleted_at === null || r.deleted_at === undefined || Number(r.deleted_at) === 0);
const onDiskRel = new Set(layout.map((r) => r.rel.toLowerCase()));
const rowRel = new Set(activeRows.map((r) => toPosix(r.rel_path).toLowerCase()));

const missingOnDisk = activeRows.filter((r) => !onDiskRel.has(toPosix(r.rel_path).toLowerCase()));
const unledgered = layout.filter((r) => !r.isArtifact && !rowRel.has(r.rel.toLowerCase()));

// sha256 核对（可选）
let shaChecked = 0;
const shaMismatch = [];
if (DO_SHA) {
  for (const r of activeRows) {
    const hit = layout.find((d) => d.rel.toLowerCase() === toPosix(r.rel_path).toLowerCase());
    if (!hit || !r.sha256) continue;
    shaChecked += 1;
    const got = sha256(path.join(ROOT, hit.rel));
    if (got !== String(r.sha256)) shaMismatch.push({ id: r.id, rel: hit.rel });
  }
}

const totalBytes = files.reduce((s, f) => s + f.bytes, 0);
const originalBytes = originals.reduce((s, f) => s + f.bytes, 0);
const artifactBytes = artifacts.reduce((s, f) => s + f.bytes, 0);
const unclassifiedFiles = layout.filter((r) => r.underUnclassified);
const maxBytes = MAX_FILE_MB * MB;
const overLimit = layout.filter((r) => !r.isArtifact && r.bytes > maxBytes);
const extAllowed = new Set([...ARCHIVE_EXTENSIONS, ...IMAGE_EXTENSIONS]);
const extOffWhitelist = layout.filter((r) => !r.isArtifact && !extAllowed.has(r.ext));

// 台账里 meta_rel / thumb_rel 指向已不存在的文件（迁移脚本刻意保留旧值，见 migrate-simple-booth-folders.mjs:125-130）
const danglingSidecar = activeRows
  .flatMap((r) => [['meta_rel', r.meta_rel], ['thumb_rel', r.thumb_rel]]
    .filter(([, rel]) => rel && !fs.existsSync(path.join(ROOT, String(rel))))
    .map(([col, rel]) => ({ id: r.id, col, rel: toPosix(rel) })));

// 保留期口径：已分类 120 天 / 未分类 60 天（src/file-archive.js:329）——核对台账实际算出多少天
const retentionDays = activeRows.map((r) => ({
  id: r.id,
  category: r.category || '',
  days: r.archived_at && r.cleanup_at ? Math.round((Number(r.cleanup_at) - Number(r.archived_at)) / 86400000) : null
}));

// 每个目录的原件数/体积（不含 meta/thumbnail 旁挂）
const byDirMap = new Map();
for (const f of originals) {
  const dir = toPosix(path.dirname(f.rel));
  const cur = byDirMap.get(dir) || { dir, files: 0, bytes: 0 };
  cur.files += 1; cur.bytes += f.bytes;
  byDirMap.set(dir, cur);
}
const byDir = [...byDirMap.values()].sort((a, b) => a.dir.localeCompare(b.dir, 'zh'));

const result = {
  root: ROOT, simpleMode: SIMPLE,
  files: files.length, originals: originals.length, artifacts: artifacts.length,
  totalBytes, originalBytes, artifactBytes,
  topDirCount: topDirs.length, topDirs,
  boothDirs: layout.filter((r) => r.inBoothDir).reduce((s, r) => (s.includes(r.parent) ? s : [...s, r.parent]), []).length,
  unclassifiedFiles: unclassifiedFiles.length,
  unclassifiedBytes: unclassifiedFiles.reduce((s, r) => s + r.bytes, 0),
  unclassifiedGroups: [...new Set(unclassifiedFiles.map((r) => r.parent.split('/')[1]).filter(Boolean))],
  deviations: deviations.map((r) => ({ rel: r.rel, boothId: r.boothId, parent: r.parent })),
  ledger: {
    path: DB_PATH ? path.resolve(DB_PATH) : '', error: dbError,
    rows: rows.length, active: activeRows.length, deleted: rows.length - activeRows.length,
    missingOnDisk: missingOnDisk.map((r) => ({ id: r.id, rel: toPosix(r.rel_path) })),
    unledgered: unledgered.map((r) => ({ rel: r.rel, bytes: r.bytes })),
    shaChecked, shaMismatch
  },
  limits: { maxFileMb: MAX_FILE_MB, overLimit: overLimit.map((r) => ({ rel: r.rel, mb: +(r.bytes / MB).toFixed(2) })) },
  extensions: {
    allowed: [...extAllowed],
    offWhitelist: extOffWhitelist.map((r) => ({ rel: r.rel, ext: r.ext })),
    histogram: Object.entries(layout.filter((r) => !r.isArtifact).reduce((acc, r) => { acc[r.ext] = (acc[r.ext] || 0) + 1; return acc; }, {}))
      .sort((a, b) => b[1] - a[1])
  },
  categories: Object.entries(activeRows.reduce((acc, r) => { const k = r.category || '(空)'; acc[k] = (acc[k] || 0) + 1; return acc; }, {})),
  retentionDays,
  danglingSidecar,
  byDir,
  boothIdsInLedger: activeRows.filter((r) => r.booth_id).length,
  boothIdsEmptyOnSevenDigitName: activeRows.filter((r) => !r.booth_id && simpleBoothId(r.file_name)).map((r) => r.id)
};

if (AS_JSON) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const mb = (n) => (n / MB).toFixed(2);
  console.log(`审计根：${result.root}（simpleMode=${result.simpleMode}）`);
  console.log(`一级目录 ${result.topDirs.length} 个：${result.topDirs.join('、')}`);
  console.log(`文件 ${result.files} 个（原件 ${result.originals} + 旁挂 ${result.artifacts}），合计 ${mb(result.totalBytes)} MB（原件 ${mb(result.originalBytes)} MB，旁挂 ${mb(result.artifactBytes)} MB）`);
  console.log(`BOOTH 号目录 ${result.boothDirs} 个；_未分类 ${result.unclassifiedFiles} 个文件 / ${mb(result.unclassifiedBytes)} MB`);
  console.log('目录 → 原件数 / 体积：');
  for (const d of result.byDir) console.log(`  ${d.dir} | ${d.files} 个 | ${mb(d.bytes)} MB`);
  if (result.categories.length) console.log(`台账分类分布：${result.categories.map(([k, n]) => `${k}×${n}`).join('、')}`);
  if (result.retentionDays.length) {
    const hist = Object.entries(result.retentionDays.reduce((acc, r) => { const k = `${r.days}天`; acc[k] = (acc[k] || 0) + 1; return acc; }, {}));
    console.log(`保留期分布：${hist.map(([k, n]) => `${k}×${n}`).join('、')}`);
  }
  if (result.danglingSidecar.length) {
    for (const d of result.danglingSidecar) console.log(`  台账 ${d.col} 悬空 #${d.id} → ${d.rel}`);
  }
  console.log(`布局偏差 ${result.deviations.length} 条；超 ${MAX_FILE_MB}MB 上限 ${result.limits.overLimit.length} 条；扩展名不在白名单 ${result.extensions.offWhitelist.length} 条`);
  if (result.ledger.path) {
    console.log(`台账：${result.ledger.rows} 行（有效 ${result.ledger.active}、已删 ${result.ledger.deleted}）；磁盘缺文件 ${result.ledger.missingOnDisk.length} 条；无台账文件 ${result.ledger.unledgered.length} 条${DO_SHA ? `；sha256 核对 ${result.ledger.shaChecked} 条，不符 ${result.ledger.shaMismatch.length} 条` : ''}`);
    if (result.ledger.error) console.log(`台账读取失败：${result.ledger.error}`);
  } else {
    console.log('台账：未提供 --db（跳过一致性核对）');
  }
  for (const d of result.deviations) console.log(`  偏差 ${d.rel}（文件名号=${d.boothId || '无'}，父目录=${d.parent}）`);
  for (const u of result.ledger.unledgered) console.log(`  无台账 ${u.rel}（${mb(u.bytes)} MB）`);
  for (const m of result.ledger.missingOnDisk) console.log(`  台账有、磁盘无 #${m.id} ${m.rel}`);
}
