#!/usr/bin/env node
// 把旧台账里的文件迁移到 simpleMode 的新布局：
//   符合规则（文件名以 7 位数字开头） → <root>/<群号_群名>/<YYYY-MM>/<storedName>
//   不符合                              → <root>/_未分类/<群号_群名>/<storedName>
// 同步更新 file_archive.rel_path / stored_name；迁移后逐个重算 sha256 与台账比对。
//
// 用法：
//   node scripts/migrate-archive-simple-layout.mjs           # 预演，只打印计划
//   node scripts/migrate-archive-simple-layout.mjs --apply   # 真正搬（先备份 messages.db）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const NEW_ROOT = path.isAbsolute(String(CFG.fileArchive?.dir || ''))
  ? path.normalize(String(CFG.fileArchive.dir))
  : path.resolve(ROOT, String(CFG.fileArchive?.dir || 'state/files'));
const OLD_ROOT = path.join(ROOT, 'state', 'files');
const DB_PATH = path.join(ROOT, 'state', 'messages.db');
const apply = process.argv.includes('--apply');

function groupNames() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'group-names.json'), 'utf8')); } catch { return {}; }
}
function safeName(s) {
  return String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'unnamed';
}
function groupFolder(gid, names) {
  const id = String(gid).replace(/\D/g, '') || 'unknown';
  const name = String(names[id] || '').trim();
  return name ? `${id}_${safeName(name)}` : id;
}
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

const db = new DatabaseSync(DB_PATH);
const rows = db.prepare("SELECT id, group_id, file_name, stored_name, rel_path, sha256, archived_at FROM file_archive WHERE deleted_at IS NULL ORDER BY id").all();
const names = groupNames();
console.log(`台账有效条目 ${rows.length}；旧根 ${OLD_ROOT}；新根 ${NEW_ROOT}`);
if (!fs.existsSync(NEW_ROOT)) fs.mkdirSync(NEW_ROOT, { recursive: true });

const plan = [];
for (const r of rows) {
  const gid = String(r.group_id || '');
  const stored = String(r.stored_name || path.basename(String(r.rel_path || '')) || 'file');
  const src = path.join(OLD_ROOT, String(r.rel_path || stored));
  const conforming = /^\d{7}/.test(String(r.file_name || stored));
  const d = new Date(Number(r.archived_at) || Date.now());
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const relNew = conforming
    ? path.join(groupFolder(gid, names), ym, stored)
    : path.join('_未分类', groupFolder(gid, names), stored);
  plan.push({ id: r.id, src, relNew, absNew: path.join(NEW_ROOT, relNew), sha: String(r.sha256 || ''), stored, conforming });
}

for (const p of plan) {
  const exists = fs.existsSync(p.src);
  console.log(`#${p.id} ${p.conforming ? '合规' : '未分类'} ${p.src.replace(OLD_ROOT, '<old>')} -> ${p.relNew}${exists ? '' : '  [源文件缺失!]'}`);
}
if (!apply) { console.log('\n（预演，加 --apply 才真正搬）'); process.exit(0); }

// 备份 DB
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.copyFileSync(DB_PATH, `${DB_PATH}.bak-migrate-${stamp}`);
console.log(`\n已备份 ${path.basename(DB_PATH)}.bak-migrate-${stamp}`);

let moved = 0, skipped = 0, failed = 0;
const upd = db.prepare('UPDATE file_archive SET rel_path = ?, stored_name = ? WHERE id = ?');
for (const p of plan) {
  try {
    if (!fs.existsSync(p.src)) { console.log(`跳过 #${p.id}：源文件不存在`); skipped++; continue; }
    if (path.resolve(p.src) === path.resolve(p.absNew)) { skipped++; continue; }
    fs.mkdirSync(path.dirname(p.absNew), { recursive: true });
    let dest = p.absNew;
    let i = 1;
    while (fs.existsSync(dest)) { dest = p.absNew.replace(/(\.[^.]*)?$/, ` (${i})$1`); i++; }
    try { fs.renameSync(p.src, dest); } catch { fs.copyFileSync(p.src, dest); fs.unlinkSync(p.src); }
    const got = sha256(dest);
    if (p.sha && got !== p.sha) {
      // 校验失败：搬回去，保持原状
      fs.renameSync(dest, p.src);
      console.log(`校验失败 #${p.id}：sha256 不匹配，已回滚`);
      failed++;
      continue;
    }
    upd.run(path.relative(NEW_ROOT, dest), path.basename(dest), p.id);
    moved++;
    console.log(`#${p.id} -> ${path.relative(NEW_ROOT, dest)}（sha256 校验${p.sha ? '通过' : '跳过(无记录)'}）`);
  } catch (e) {
    console.log(`失败 #${p.id}：${e?.message ?? e}`);
    failed++;
  }
}
console.log(`\n完成：搬了 ${moved}，跳过 ${skipped}，失败 ${failed}`);
