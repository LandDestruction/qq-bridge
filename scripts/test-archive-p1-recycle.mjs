// M6-P1-①：回收站（移动不是删除）——二次确认、.info.json、可恢复、不自动清理。
//
// 为什么需要：M3 的"删除"只是标台账行（deleted_at），盘上文件要么还在、要么真没了；
// 台账与磁盘各说各话。回收站把"删"变成"移进 .回收站/<批次>/"，用户后悔还能恢复，
// 而且路径、体积、sha256、contentKey 全留在 .info.json 里，盘才是唯一真相。
//
// 全程临时目录 + 内存 SQLite，不碰真实 state/、不碰 E:\booth-inbox。
// 用法：node scripts/test-archive-p1-recycle.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ensureFileLedger,
  storeArchivedFile,
  listArchive,
  safeResolveInside,
  moveToRecycleBin,
  listRecycleBin,
  restoreFromRecycleBin,
  purgeRecycleBin,
  RECYCLE_DIR,
  recycleBatchId,
  clearOwnWrites
} from '../src/file-archive.js';

let failed = 0;
let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`✅ ${name}`); }
  catch (error) { failed += 1; console.error(`❌ ${name} —— ${error?.message ?? error}`); }
}

const T0 = Date.UTC(2026, 0, 1);
const dirs = [];
function tmp(prefix = 'archive-p1-recycle-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  ensureFileLedger(db);
  return db;
}

const root = tmp();
const db = freshDb();
clearOwnWrites();
const item = storeArchivedFile({
  db, rootDir: root, groupId: '5001', fileName: '9013048 素材.zip',
  buffer: Buffer.from('recycle-me'), archivedAt: T0
});
const absOriginal = safeResolveInside(root, item.relPath);
const rowOf = (id) => listArchive(db, { limit: 10, includeDeleted: true }).find((r) => r.id === id);

check('前置：文件在盘、台账 active', () => {
  assert.ok(fs.existsSync(absOriginal));
  assert.equal(rowOf(item.id).deletedAt, null);
});

check('二次确认：没给 confirm 时拒绝，文件原地不动', () => {
  const r = moveToRecycleBin({ db, rootDir: root, id: item.id });
  assert.equal(r.ok, false);
  assert.equal(r.needsConfirm, true);
  assert.ok(fs.existsSync(absOriginal), '文件不该被搬走');
  assert.equal(rowOf(item.id).deletedAt, null);
});

let moved;
check('confirm=true：文件移进 .回收站/<批次>/，台账标 deleted 并记 recycle_rel', () => {
  moved = moveToRecycleBin({ db, rootDir: root, id: item.id, reason: '用户要求删除', nowMs: T0 + 1000, confirm: true });
  assert.equal(moved.ok, true);
  assert.ok(moved.batch);
  assert.equal(fs.existsSync(absOriginal), false, '原位置应该已搬空');
  const recycled = safeResolveInside(root, moved.recycleRel);
  assert.ok(fs.existsSync(recycled), '回收站里应该有这个文件');
  assert.equal(fs.readFileSync(recycled, 'utf8'), 'recycle-me', '内容必须原样');
  const row = rowOf(item.id);
  assert.equal(row.deletedAt, T0 + 1000);
  assert.match(row.deleteReason, /^recycle:/);
  assert.equal(row.recycleRel, moved.recycleRel);
});

check('.info.json：记下原路径/体积/sha256/contentKey，且是合法 JSON', () => {
  const infoAbs = safeResolveInside(root, moved.infoRel);
  const info = JSON.parse(fs.readFileSync(infoAbs, 'utf8'));
  assert.equal(info.id, item.id);
  assert.equal(info.originalRelPath, item.relPath);
  assert.equal(info.bytes, Buffer.byteLength('recycle-me'));
  assert.equal(info.sha256, item.sha256);
  assert.equal(info.contentKey, item.contentKey);
  assert.equal(info.batch, moved.batch);
});

check('listRecycleBin：能列出条目（按 deletedAt 倒序）', () => {
  const list = listRecycleBin({ rootDir: root });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, item.id);
  assert.equal(list[0].infoRel, moved.infoRel);
});

check('重复搬同一条：拒绝（不产生第二个回收站条目）', () => {
  const again = moveToRecycleBin({ db, rootDir: root, id: item.id, confirm: true });
  assert.equal(again.ok, false);
  assert.match(String(again.reason), /已在回收站/);
});

check('恢复：移回原路径，台账 deleted_at/recycle_rel 清空', () => {
  const restored = restoreFromRecycleBin({ db, rootDir: root, infoRel: moved.infoRel, nowMs: T0 + 2000 });
  assert.equal(restored.ok, true);
  // 台账里历史行用 Windows 反斜杠、新值统一正斜杠；按归一化后比较
  assert.equal(restored.relPath, item.relPath.split(path.sep).join('/'));
  assert.equal(restored.renamed, false);
  assert.ok(fs.existsSync(absOriginal), '文件应回到原位');
  assert.equal(fs.readFileSync(absOriginal, 'utf8'), 'recycle-me');
  const row = rowOf(item.id);
  assert.equal(row.deletedAt, null);
  assert.equal(row.deleteReason, '');
  assert.equal(row.recycleRel, '');
  assert.equal(listRecycleBin({ rootDir: root }).length, 0, '恢复后回收站应无条目');
});

check('恢复：目标位置被占用时改名恢复（不覆盖）', () => {
  const again = moveToRecycleBin({ db, rootDir: root, id: item.id, nowMs: T0 + 3000, confirm: true });
  assert.equal(again.ok, true);
  // 原位置先放一个占位文件
  fs.writeFileSync(absOriginal, 'someone-else', 'utf8');
  const restored = restoreFromRecycleBin({ db, rootDir: root, infoRel: again.infoRel, nowMs: T0 + 4000 });
  assert.equal(restored.ok, true);
  assert.equal(restored.renamed, true);
  assert.notEqual(restored.relPath, item.relPath);
  assert.equal(fs.readFileSync(safeResolveInside(root, restored.relPath), 'utf8'), 'recycle-me');
  assert.equal(fs.readFileSync(absOriginal, 'utf8'), 'someone-else', '占位文件不能被覆盖');
});

check('恢复：info 里没 originalRelPath 时拒绝（不猜路径）', () => {
  const r = restoreFromRecycleBin({ db, rootDir: root, infoRel: '不存在.info.json' });
  assert.equal(r.ok, false);
});

check('清空：没给 confirm 时拒绝，回收站还在', () => {
  const tmpMove = moveToRecycleBin({ db, rootDir: root, id: item.id, nowMs: T0 + 5000, confirm: true });
  assert.equal(tmpMove.ok, true);
  const r = purgeRecycleBin({ rootDir: root });
  assert.equal(r.ok, false);
  assert.equal(r.needsConfirm, true);
  assert.ok(fs.existsSync(path.join(root, RECYCLE_DIR)), '回收站不该被清掉');
});

check('清空：confirm=true 且限定批次时只删该批次', () => {
  // 用两条全新记录，避免受前面"已恢复/已搬走"的状态影响
  const mk = (name, body) => storeArchivedFile({
    db, rootDir: root, groupId: '5002', fileName: name, buffer: Buffer.from(body), archivedAt: T0
  });
  const itemA = mk('9013048 素材A.zip', 'a');
  const itemB = mk('9013049 素材B.zip', 'b');
  const a = moveToRecycleBin({ db, rootDir: root, id: itemA.id, nowMs: T0 + 6000, batchId: 'batch-A', confirm: true });
  assert.equal(a.ok, true);
  const b = moveToRecycleBin({ db, rootDir: root, id: itemB.id, nowMs: T0 + 6100, batchId: 'batch-B', confirm: true });
  assert.equal(b.ok, true);
  const r = purgeRecycleBin({ rootDir: root, batchId: 'batch-A', confirm: true });
  assert.equal(r.ok, true);
  assert.equal(r.removedDirs, 1);
  assert.equal(fs.existsSync(path.join(root, RECYCLE_DIR, 'batch-A')), false);
  assert.equal(fs.existsSync(path.join(root, RECYCLE_DIR, 'batch-B')), true, '别的批次不该被删');
});

check('recycleBatchId：同一毫秒稳定、格式无非法字符', () => {
  const id = recycleBatchId(T0);
  assert.equal(id, recycleBatchId(T0));
  assert.equal(/[:.]/.test(id), false);
});

// ── 收尾 ────────────────────────────────────────────────────────────────────
clearOwnWrites();
for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
const total = passed + failed;
if (failed) { console.error(`\n❌ test-archive-p1-recycle 失败 ${failed}/${total}`); process.exit(1); }
console.log(`\n✅ test-archive-p1-recycle 全部通过（${passed}/${total}）`);
