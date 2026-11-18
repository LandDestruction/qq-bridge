// M6-P0 ③：原子写（临时文件 + rename）与 ownWrites 自写记账的离线测试。
//
// 为什么需要：直接 writeFile 写到一半崩溃/断电，会留下"半个 meta.json / 半个台账附件"，
// 下次扫描会把它当完整文件索引，直接污染"盘上文件是唯一真相"。原子写保证
// 要么旧文件完整、要么新文件完整；ownWrites 则避免我们把自己的写当成外部改动，自激重扫。
//
// 全部在临时目录里跑，不碰真实 state/、不联网。
// 用法：node scripts/test-archive-atomic.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  writeFileAtomicSync,
  recordOwnWrite,
  isOwnWrite,
  pruneOwnWrites,
  listOwnWrites,
  clearOwnWrites,
  OWN_WRITE_TTL_MS,
  ensureFileLedger,
  storeArchivedFile,
  moveArchiveItemToCategory,
  listArchive,
  safeResolveInside
} from '../src/file-archive.js';

let failed = 0;
let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`✅ ${name}`); }
  catch (error) { failed += 1; console.error(`❌ ${name} —— ${error?.message ?? error}`); }
}

const T0 = Date.UTC(2026, 0, 1);
const dirs = [];
function tmp(prefix = 'archive-atomic-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  ensureFileLedger(db);
  return db;
}
/** 目录里有没有残留的临时文件（原子写的关键不变量）。 */
function tmpLeftovers(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.includes('.tmp-')) out.push(abs);
    }
  };
  walk(dir);
  return out;
}

clearOwnWrites();

// ── writeFileAtomicSync 基本语义 ────────────────────────────────────────────
check('原子写：写入内容正确、自动建父目录、无 .tmp 残留', () => {
  const root = tmp();
  const target = path.join(root, 'a', 'b', 'meta.json');
  writeFileAtomicSync(target, '{"x":1}\n');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"x":1}\n');
  assert.deepEqual(tmpLeftovers(root), []);
});

check('原子写：覆盖已有文件（旧内容整体被替换，不是追加）', () => {
  const root = tmp();
  const target = path.join(root, 'n.txt');
  writeFileAtomicSync(target, 'old-and-long-content');
  writeFileAtomicSync(target, 'new');
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  assert.deepEqual(tmpLeftovers(root), []);
});

check('原子写：目标不可写时抛错，且不留下临时文件', () => {
  const root = tmp();
  const blocker = path.join(root, 'blocked');
  fs.mkdirSync(blocker); // 目标是个目录 → rename 必失败
  assert.throws(() => writeFileAtomicSync(blocker, 'x'));
  assert.deepEqual(tmpLeftovers(root), []);
});

check('原子写：成功后记进 ownWrites（扫描据此跳过自己的写）', () => {
  const root = tmp();
  const target = path.join(root, 'c.txt');
  clearOwnWrites();
  writeFileAtomicSync(target, 'c');
  assert.equal(isOwnWrite(target), true);
  assert.equal(isOwnWrite(path.join(root, 'never-written.txt')), false);
});

// ── ownWrites 的过期与清理 ──────────────────────────────────────────────────
check('ownWrites：超过 TTL 就算"外部改动"', () => {
  clearOwnWrites();
  const root = tmp();
  const target = path.join(root, 'd.txt');
  writeFileAtomicSync(target, 'd');
  assert.equal(isOwnWrite(target, { nowMs: Date.now() }), true);
  assert.equal(isOwnWrite(target, { nowMs: Date.now() + OWN_WRITE_TTL_MS + 10 }), false);
});

check('ownWrites：prune 只清过期的，list 能看到记录', () => {
  clearOwnWrites();
  const root = tmp();
  const a = path.join(root, 'a.txt');
  const b = path.join(root, 'b.txt');
  recordOwnWrite(a, T0);
  recordOwnWrite(b, T0 + 500);
  assert.equal(listOwnWrites().length, 2);
  // 在 T0+1200、TTL=1000 时看：a 已过期（差 1200），b 还有效（差 700）
  const left = pruneOwnWrites({ nowMs: T0 + 1200, ttlMs: 1000 });
  assert.equal(left, 1);
  assert.equal(isOwnWrite(a, { nowMs: T0 + 1200, withinMs: 1000 }), false);
  assert.equal(isOwnWrite(b, { nowMs: T0 + 1200, withinMs: 1000 }), true);
});

// ── 归档落盘走原子路径 ──────────────────────────────────────────────────────
const root1 = tmp('archive-atomic-store-');
const db1 = freshDb();
clearOwnWrites();
const stored = storeArchivedFile({
  db: db1, rootDir: root1, groupId: '3001', fileName: '9038753 素材.zip',
  buffer: Buffer.from('atomic-body'), archivedAt: T0
});

check('storeArchivedFile：落盘内容完整、目录里没有 .tmp 残留', () => {
  const abs = safeResolveInside(root1, stored.relPath);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'atomic-body');
  assert.deepEqual(tmpLeftovers(root1), []);
});

check('storeArchivedFile：最终路径记进 ownWrites', () => {
  const abs = safeResolveInside(root1, stored.relPath);
  assert.equal(isOwnWrite(abs), true);
});

// ── meta.json 更新走原子写（人工改分类会把 meta 一起改） ────────────────────
const root2 = tmp('archive-atomic-meta-');
const db2 = freshDb();
const item = storeArchivedFile({
  db: db2, rootDir: root2, groupId: '3002', fileName: '9038754 商品.zip',
  buffer: Buffer.from('body-2'), archivedAt: T0
});
const metaAbs = path.join(root2, path.dirname(item.relPath), 'meta.json');
fs.writeFileSync(metaAbs, `${JSON.stringify({ category: '旧分类', title: '商品' }, null, 1)}\n`, 'utf8');
// 台账要认得这个 meta（真实流程里由 enrichArchiveItem 写 meta_rel；这里直接补上）
db2.prepare('UPDATE file_archive SET meta_rel = ? WHERE id = ?').run(path.relative(root2, metaAbs).split(path.sep).join('/'), item.id);

check('改分类：meta.json 跟着搬走并被原子替换成新分类，且不残留临时文件', () => {
  const moved = moveArchiveItemToCategory({ db: db2, rootDir: root2, id: item.id, category: '新分类', nowMs: T0 });
  assert.equal(moved.moved, true);
  const row = listArchive(db2, { limit: 10 }).find((r) => r.id === item.id);
  assert.notEqual(row.metaRel, '');
  const absNew = safeResolveInside(root2, row.metaRel);
  const meta = JSON.parse(fs.readFileSync(absNew, 'utf8'));
  assert.equal(meta.category, '新分类');
  assert.equal(fs.existsSync(metaAbs), false, '旧位置的 meta.json 应该已经搬走');
  assert.deepEqual(tmpLeftovers(root2), []);
  assert.equal(row.category, '新分类');
});

check('改分类后：新位置的 meta.json 仍可被 JSON.parse（没有半个文件）', () => {
  const row = listArchive(db2, { limit: 10 }).find((r) => r.id === item.id);
  const abs = safeResolveInside(root2, row.metaRel);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(abs, 'utf8')));
});

check('改分类：新路径也记进 ownWrites', () => {
  const row = listArchive(db2, { limit: 10 }).find((r) => r.id === item.id);
  assert.equal(isOwnWrite(safeResolveInside(root2, row.relPath)), true);
});

// ── 收尾 ────────────────────────────────────────────────────────────────────
clearOwnWrites();
for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
const total = passed + failed;
if (failed) { console.error(`\n❌ test-archive-atomic 失败 ${failed}/${total}`); process.exit(1); }
console.log(`\n✅ test-archive-atomic 全部通过（${passed}/${total}）`);
