// file-archive/recycle.js — 回收站与恢复（不真删 / 可恢复 / 需二次确认）
// 纯搬运自 src/file-archive.js（D61 拆分）：函数体/注释逐字保留，只做模块化与 import/export。

import fs from 'node:fs';
import path from 'node:path';

import { allocateStoredName, fileOpsMu, parentDirRel, recordOwnWrite, safeResolveInside, toPosixRel, writeFileAtomicSync } from './paths.js';
import { mapArchiveRow } from './db.js';
import { moveFileWithinRoot, pruneEmptyDirs } from './storage.js';

// ── 回收站（删除 = 移进 .回收站，不真删；可恢复；需二次确认） ────────────────
// 规格 §3-P1-6：`.回收站/<批次>/` + `.info.json`；不自动清理；恢复要能回到原路径。
// 硬约束：这是**移动**不是删除——用户文件在回收站里原样躺着，直到有人显式 purge。
export const RECYCLE_DIR = '.回收站';

const RECYCLE_INFO_SUFFIX = '.info.json';

/** 批次号：ISO 时间戳去掉非法字符（同一批操作共用一个批次，方便整批恢复/清理）。 */
export function recycleBatchId(nowMs = Date.now()) {
  return new Date(Number(nowMs) || Date.now()).toISOString().replace(/[:.]/g, '-');
}

/**
 * 把一条台账记录移进回收站（连带 meta/缩略图）。
 * `confirm` 必须显式为 true —— 这是"二次确认"，防止误调用把用户文件搬走。
 * @returns {{ok:boolean, needsConfirm?:boolean, id?:number, batch?:string, recycleRel?:string, infoRel?:string, missing?:boolean, reason?:string}}
 */
export function moveToRecycleBin({ db, rootDir, id, reason = 'manual', nowMs = Date.now(), batchId = '', confirm = false } = {}) {
  if (confirm !== true) return { ok: false, needsConfirm: true, reason: '回收站操作需要二次确认（confirm:true）' };
  return fileOpsMu.runSync(() => {
    const row = mapArchiveRow(db.prepare('SELECT * FROM file_archive WHERE id = ?').get(Number(id)));
    if (!row) throw new Error(`台账里没有 id=${id} 的记录`);
    if (row.deletedAt) return { ok: false, reason: '该文件已在回收站/已清理', id: Number(id) };
    const when = Number(nowMs) || Date.now();
    const batch = String(batchId || '').trim() || recycleBatchId(when);
    const relPosix = toPosixRel(row.relPath);
    const dirRel = path.posix.dirname(relPosix);
    const destDirRel = dirRel && dirRel !== '.' ? path.posix.join(RECYCLE_DIR, batch, dirRel) : path.posix.join(RECYCLE_DIR, batch);
    fs.mkdirSync(safeResolveInside(rootDir, destDirRel), { recursive: true });
    const moveOne = (rel) => {
      if (!rel) return '';
      try {
        const src = safeResolveInside(rootDir, rel);
        if (!fs.existsSync(src)) return '';
        const destRel = path.posix.join(destDirRel, path.posix.basename(toPosixRel(rel)));
        moveFileWithinRoot(rootDir, rel, destRel);
        return destRel;
      } catch { return ''; }
    };
    const recycleRel = moveOne(row.relPath);
    if (!recycleRel) {
      // 盘上已经没有这个文件：只标台账（reason=missing），不伪造一个回收站条目。
      db.prepare('UPDATE file_archive SET deleted_at = ?, delete_reason = ? WHERE id = ?').run(when, `missing:${reason}`, Number(id));
      return { ok: true, missing: true, id: Number(id), batch };
    }
    const metaRel = moveOne(row.metaRel);
    const thumbRel = moveOne(row.thumbRel);
    const base = path.posix.basename(relPosix);
    const info = {
      id: row.id,
      groupId: row.groupId,
      fileName: row.fileName,
      storedName: row.storedName,
      bytes: row.bytes,
      sha256: row.sha256,
      contentKey: row.contentKey,
      category: row.category,
      boothId: row.boothId,
      reason: String(reason),
      batch,
      deletedAt: when,
      originalRelPath: row.relPath,
      recycleRel,
      metaRel,
      thumbRel
    };
    const infoRel = path.posix.join(destDirRel, `${base}${RECYCLE_INFO_SUFFIX}`);
    writeFileAtomicSync(safeResolveInside(rootDir, infoRel), `${JSON.stringify(info, null, 1)}\n`);
    db.prepare('UPDATE file_archive SET deleted_at = ?, delete_reason = ?, recycle_rel = ? WHERE id = ?')
      .run(when, `recycle:${batch}`, recycleRel, Number(id));
    return { ok: true, id: Number(id), batch, recycleRel, infoRel };
  }, 'archive-recycle');
}

/** 列出回收站条目（读 `.info.json`；坏文件跳过，不影响其它条目）。 */
export function listRecycleBin({ rootDir, batchId = '' } = {}) {
  const base = path.join(path.resolve(String(rootDir)), RECYCLE_DIR);
  const out = [];
  if (!fs.existsSync(base)) return out;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.name.endsWith(RECYCLE_INFO_SUFFIX)) continue;
      try {
        const info = JSON.parse(fs.readFileSync(abs, 'utf8'));
        if (batchId && String(info.batch || '') !== String(batchId)) continue;
        out.push({ ...info, infoRel: path.relative(path.resolve(String(rootDir)), abs).split(path.sep).join('/') });
      } catch { /* 坏 info 跳过 */ }
    }
  };
  walk(base);
  out.sort((a, b) => (Number(b.deletedAt) || 0) - (Number(a.deletedAt) || 0));
  return out;
}

/**
 * 从回收站恢复一条记录（移回原路径；原位置被占用时改名加 `(n)`）。
 * @returns {{ok:boolean, id?:number, relPath?:string, renamed?:boolean, reason?:string}}
 */
export function restoreFromRecycleBin({ db, rootDir, infoRel = '', id = 0, nowMs = Date.now() } = {}) {
  return fileOpsMu.runSync(() => {
    let info = null;
    let infoAbs = '';
    if (infoRel) {
      try {
        infoAbs = safeResolveInside(rootDir, infoRel);
        info = JSON.parse(fs.readFileSync(infoAbs, 'utf8'));
      } catch { info = null; infoAbs = ''; }
    }
    if (!info && id) {
      // 没给 infoRel：按台账里的 recycle_rel 反查
      const row = mapArchiveRow(db.prepare('SELECT * FROM file_archive WHERE id = ?').get(Number(id)));
      const target = row?.recycleRel ? path.posix.join(path.posix.dirname(toPosixRel(row.recycleRel)), `${path.posix.basename(toPosixRel(row.recycleRel))}${RECYCLE_INFO_SUFFIX}`) : '';
      if (target) {
        try {
          infoAbs = safeResolveInside(rootDir, target);
          info = JSON.parse(fs.readFileSync(infoAbs, 'utf8'));
        } catch { info = null; infoAbs = ''; }
      }
    }
    if (!info) return { ok: false, reason: '回收站里找不到这条记录（info 缺失或已损坏）' };
    const rowId = Number(info.id);
    const originalRel = toPosixRel(info.originalRelPath || '');
    if (!originalRel) return { ok: false, reason: 'info 里没有 originalRelPath，无法恢复' };
    const recycleRel = String(info.recycleRel || '');
    const srcAbs = safeResolveInside(rootDir, recycleRel);
    if (!fs.existsSync(srcAbs)) return { ok: false, reason: '回收站里的文件已经不在盘上' };
    const targetDirRel = parentDirRel(originalRel);
    const desiredName = path.posix.basename(originalRel);
    const exists = (candidate) => fs.existsSync(path.join(safeResolveInside(rootDir, targetDirRel), candidate));
    const finalName = allocateStoredName(desiredName, exists);
    const relPath = targetDirRel ? path.posix.join(targetDirRel, finalName) : finalName;
    fs.mkdirSync(safeResolveInside(rootDir, targetDirRel), { recursive: true });
    moveFileWithinRoot(rootDir, recycleRel, relPath);
    // meta/缩略图能恢复就一起搬回（找不到不阻塞主文件）
    const restoreSide = (rel) => {
      if (!rel) return '';
      try {
        const abs = safeResolveInside(rootDir, rel);
        if (!fs.existsSync(abs)) return '';
        const destRel = path.posix.join(targetDirRel, path.posix.basename(rel));
        moveFileWithinRoot(rootDir, rel, destRel);
        return destRel;
      } catch { return ''; }
    };
    const metaRel = restoreSide(info.metaRel);
    const thumbRel = restoreSide(info.thumbRel);
    const when = Number(nowMs) || Date.now();
    db.prepare(`UPDATE file_archive SET deleted_at = NULL, delete_reason = '', recycle_rel = '',
      rel_path = ?, stored_name = ?, meta_rel = ?, thumb_rel = ? WHERE id = ?`)
      .run(relPath, finalName, metaRel, thumbRel, rowId);
    // 自己的写：扫描别把恢复当成外部改动
    recordOwnWrite(safeResolveInside(rootDir, relPath), when);
    // 恢复成功：把 .info.json（我们自己的记账，不是用户文件）删掉，并清掉空目录，
    // 否则"已恢复"的记录会一直挂在回收站列表里（测试抓到过）。
    if (infoAbs) {
      try { fs.unlinkSync(infoAbs); } catch {}
      try { pruneEmptyDirs(rootDir, path.dirname(infoAbs)); } catch {}
    }
    return { ok: true, id: rowId, relPath, renamed: finalName !== desiredName };
  }, 'archive-restore');
}

/**
 * 清空回收站（**只在 confirm:true 时**执行；可按批次或时间筛选）。
 * 默认不自动调用——规格要求"不自动清理、人工二次确认"。
 * @returns {{ok:boolean, removedDirs:number, needsConfirm?:boolean}}
 */
export function purgeRecycleBin({ rootDir, batchId = '', olderThanMs = 0, confirm = false } = {}) {
  if (confirm !== true) return { ok: false, needsConfirm: true, reason: '清空回收站需要二次确认（confirm:true）' };
  const base = path.join(path.resolve(String(rootDir)), RECYCLE_DIR);
  if (!fs.existsSync(base)) return { ok: true, removedDirs: 0 };
  let removed = 0;
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    if (batchId && entry.name !== String(batchId)) continue;
    if (olderThanMs > 0) {
      let st;
      try { st = fs.statSync(dir); } catch { continue; }
      if (st.mtimeMs > Number(olderThanMs)) continue;
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); removed += 1; } catch {}
  }
  return { ok: true, removedDirs: removed };
}
