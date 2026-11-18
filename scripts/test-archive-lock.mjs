// M6-P0 ④：fileOpsMu 一把锁——扫描与移动/删除互斥。
//
// 为什么需要：T4 审计发现过"悬空 meta/thumb"——半搬运状态被索引读到。改名/删文件不是原子的，
// 如果扫描刚好在 rename 之后、台账更新之前读，就会看到"文件在 A、台账在 B"。
// 一把锁让扫描与搬运串行：异步方排队，同步方（人工改分类）忙时立刻失败，绝不半搬运。
//
// 全部在临时目录 + 内存 SQLite 里跑，不碰真实 state/、不联网。
// 用法：node scripts/test-archive-lock.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FileOpsMutex,
  FileOpsBusyError,
  fileOpsMu,
  withFileOpsLock,
  ensureFileLedger,
  storeArchivedFile,
  moveArchiveItemToCategory,
  runArchiveCleanup,
  listArchive,
  clearOwnWrites
} from '../src/file-archive.js';

let failed = 0;
let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`✅ ${name}`); }
  catch (error) { failed += 1; console.error(`❌ ${name} —— ${error?.message ?? error}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed += 1; console.log(`✅ ${name}`); }
  catch (error) { failed += 1; console.error(`❌ ${name} —— ${error?.message ?? error}`); }
}

const T0 = Date.UTC(2026, 0, 1);
const DAY = 86400000;
const dirs = [];
function tmp(prefix = 'archive-lock-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  ensureFileLedger(db);
  return db;
}

// ── 互斥原语 ────────────────────────────────────────────────────────────────
await checkAsync('锁：同一时刻只允许一个持有者，第二个排队，release 后交给它', async () => {
  const mu = new FileOpsMutex('t1');
  assert.equal(mu.locked, false);
  const first = mu.acquire('scan');
  await first;
  assert.equal(mu.locked, true);
  assert.equal(mu.owner, 'scan');
  let secondGot = false;
  const second = mu.acquire('move').then(() => { secondGot = true; });
  assert.equal(mu.waiting, 1);
  assert.equal(secondGot, false, '锁被占时第二个不该拿到');
  mu.release();
  await second;
  assert.equal(secondGot, true);
  assert.equal(mu.owner, 'move');
  mu.release();
  assert.equal(mu.locked, false);
});

await checkAsync('锁：run() 串行执行（第二个要等第一个结束）', async () => {
  const mu = new FileOpsMutex('t2');
  const order = [];
  const slow = mu.run(async () => {
    order.push('a-start');
    await new Promise((r) => setTimeout(r, 20));
    order.push('a-end');
  }, 'a');
  const fast = mu.run(async () => { order.push('b-start'); order.push('b-end'); }, 'b');
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});

await checkAsync('锁：fn 抛错也会释放（不会把锁永久占死）', async () => {
  const mu = new FileOpsMutex('t3');
  await assert.rejects(() => mu.run(async () => { throw new Error('boom'); }, 'bad'));
  assert.equal(mu.locked, false);
  // 释放后可再次获得
  await mu.run(async () => {}, 'ok');
  assert.equal(mu.locked, false);
});

check('锁：runSync 忙时抛 FileOpsBusyError（同步方不能阻塞等待）', () => {
  const mu = new FileOpsMutex('t4');
  mu.acquireSyncForTest?.();
  // 手动占锁（不 await）
  mu.busy = true;
  mu.owner = 'scan';
  assert.throws(() => mu.runSync(() => {}, 'move'), (e) => e instanceof FileOpsBusyError && e.code === 'FILE_OPS_BUSY');
  mu.busy = false;
  mu.owner = '';
  assert.equal(mu.runSync(() => 42, 'move'), 42);
  assert.equal(mu.locked, false);
});

check('锁：runSync 内抛错也释放', () => {
  const mu = new FileOpsMutex('t5');
  assert.throws(() => mu.runSync(() => { throw new Error('x'); }, 'move'));
  assert.equal(mu.locked, false);
});

check('锁：runOrSkipSync 忙时返回 skipped，不抛（后台任务用）', () => {
  const mu = new FileOpsMutex('t6');
  mu.busy = true;
  mu.owner = 'scan';
  const skipped = mu.runOrSkipSync(() => 'never', 'cleanup');
  assert.deepEqual(skipped, { skipped: true, reason: 'busy', owner: 'scan' });
  mu.busy = false;
  assert.equal(mu.runOrSkipSync(() => 'ran', 'cleanup'), 'ran');
});

// ── 与归档操作集成：扫描持锁时，移动/删除必须让路 ──────────────────────────
const root = tmp('archive-lock-int-');
const db = freshDb();
clearOwnWrites();
const item = storeArchivedFile({
  db, rootDir: root, groupId: '4001', fileName: '9038755 素材.zip',
  buffer: Buffer.from('lock-body'), archivedAt: T0
});
const before = listArchive(db, { limit: 10 }).find((r) => r.id === item.id);
const beforeAbs = path.join(root, before.relPath);
// 同一条记录再做一个"已到期"的测删除行（模拟 60 天前归档）
const oldItem = storeArchivedFile({
  db, rootDir: root, groupId: '4001', fileName: '9038756 老素材.zip',
  buffer: Buffer.from('old-body'), archivedAt: T0
});
db.prepare('UPDATE file_archive SET cleanup_at = ? WHERE id = ?').run(T0, oldItem.id);

check('集成前置：锁空闲、文件在盘、老行已到期', () => {
  assert.equal(fileOpsMu.locked, false);
  assert.ok(fs.existsSync(beforeAbs));
  assert.equal(listArchive(db, { limit: 10 }).find((r) => r.id === item.id).relPath, before.relPath);
});

await checkAsync('扫描持锁时：人工改分类立刻失败（FileOpsBusyError），文件与台账都不动', async () => {
  await fileOpsMu.acquire('scan');
  try {
    assert.throws(
      () => moveArchiveItemToCategory({ db, rootDir: root, id: item.id, category: '分类X', nowMs: T0 }),
      (e) => e instanceof FileOpsBusyError
    );
    const row = listArchive(db, { limit: 10 }).find((r) => r.id === item.id);
    assert.equal(row.relPath, before.relPath, '台账不该被改');
    assert.equal(row.category, before.category, '分类不该被改');
    assert.ok(fs.existsSync(beforeAbs), '文件不该被搬走');
  } finally {
    fileOpsMu.release();
  }
});

await checkAsync('扫描持锁时：清理跳过本轮（skipped），一个文件都不删', async () => {
  await fileOpsMu.acquire('scan');
  try {
    const res = runArchiveCleanup({ db, rootDir: root, nowMs: T0 + 200 * DAY });
    assert.equal(res.skipped, true);
    assert.equal(res.deleted, 0);
    assert.equal(listArchive(db, { limit: 10 }).find((r) => r.id === oldItem.id).deletedAt, null);
    assert.ok(fs.existsSync(path.join(root, listArchive(db, { limit: 10 }).find((r) => r.id === oldItem.id).relPath)));
  } finally {
    fileOpsMu.release();
  }
});

check('锁释放后：人工改分类正常生效', () => {
  const moved = moveArchiveItemToCategory({ db, rootDir: root, id: item.id, category: '分类X', nowMs: T0 });
  assert.equal(moved.moved, true);
  const row = listArchive(db, { limit: 10 }).find((r) => r.id === item.id);
  assert.equal(row.category, '分类X');
  assert.ok(fs.existsSync(path.join(root, row.relPath)));
});

check('锁释放后：清理正常删除到期文件并标 deleted_at', () => {
  // 两条都到期（新分类把保留期算成 120 天，nowMs 在 200 天后）
  const res = runArchiveCleanup({ db, rootDir: root, nowMs: T0 + 200 * DAY });
  assert.equal(res.skipped, undefined);
  assert.equal(res.deleted, 2);
  assert.ok(Number(listArchive(db, { limit: 10, includeDeleted: true }).find((r) => r.id === oldItem.id).deletedAt) > 0);
});

await checkAsync('withFileOpsLock：整段持锁，结束后自动释放', async () => {
  let lockedInside = false;
  const out = await withFileOpsLock(async () => {
    lockedInside = fileOpsMu.locked;
    return 'done';
  }, 'scan');
  assert.equal(out, 'done');
  assert.equal(lockedInside, true);
  assert.equal(fileOpsMu.locked, false);
});

await checkAsync('锁：并发 5 个 run 不会互相穿插（串行化）', async () => {
  const mu = new FileOpsMutex('t7');
  let active = 0;
  let peak = 0;
  const jobs = Array.from({ length: 5 }, (_, i) => mu.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return i;
  }, `job${i}`));
  const results = await Promise.all(jobs);
  assert.equal(peak, 1, '同时活跃的临界区必须只有 1 个');
  assert.deepEqual(results, [0, 1, 2, 3, 4], '按提交顺序执行');
});

// ── 收尾 ────────────────────────────────────────────────────────────────────
clearOwnWrites();
for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
const total = passed + failed;
if (failed) { console.error(`\n❌ test-archive-lock 失败 ${failed}/${total}`); process.exit(1); }
console.log(`\n✅ test-archive-lock 全部通过（${passed}/${total}）`);
