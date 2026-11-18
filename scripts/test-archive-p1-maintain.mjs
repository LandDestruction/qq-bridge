// M6-P1-③：重复判定（同名同大小）+ 缩略图信号量（并发 2 + 超大跳过）+ mtime 增量刷新。
//
// 为什么需要：归档库变大后，三件事会同时变糟——同一件重复入库（占两倍空间、两个封面）、
// 批量抓缩略图把 CPU/IO 打满（20 个并发解码）、每次全量重扫（几百个目录白跑）。
// 这三件都不该动用户文件：去重只**报告**、信号量只**限流**、增量只**判断要不要扫**。
//
// 全程临时目录 + 内存 SQLite，不碰真实 state/ 与 E:\booth-inbox。
// 用法：node scripts/test-archive-p1-maintain.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ensureFileLedger,
  insertArchiveRecord,
  duplicateKeyFor,
  findDuplicateGroups,
  scanArchiveDuplicates,
  createSemaphore,
  thumbSemaphore,
  withThumbSlot,
  shouldSkipThumb,
  THUMB_CONCURRENCY,
  indexDirMtimes,
  diffDirMtimes,
  shouldRescan,
  readScanIndex,
  writeScanIndex,
  SCAN_INDEX_FILE
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
const dirs = [];
function tmp(prefix = 'archive-p1-maintain-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  ensureFileLedger(db);
  return db;
}

// ── 重复判定 ────────────────────────────────────────────────────────────────
check('重复键：同名同大小 → 同键；大小写不敏感', () => {
  assert.equal(duplicateKeyFor('A.ZIP', 100), duplicateKeyFor('a.zip', 100));
  assert.notEqual(duplicateKeyFor('a.zip', 100), duplicateKeyFor('a.zip', 101));
});

check('findDuplicateGroups：同名同大小成组，单件不成组', () => {
  const rows = [
    { id: 1, fileName: 'x.zip', bytes: 10, relPath: 'g/1/x.zip' },
    { id: 2, fileName: 'X.zip', bytes: 10, relPath: 'g/2/X.zip' },
    { id: 3, fileName: 'y.zip', bytes: 10, relPath: 'g/1/y.zip' }
  ];
  const groups = findDuplicateGroups(rows);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, [1, 2]);
  assert.equal(groups[0].bytes, 10);
});

check('findDuplicateGroups：压缩包与其解压目录各算一件（不合并）', () => {
  const rows = [
    { id: 1, fileName: '9013048.zip', bytes: 500, relPath: 'g/9013048/9013048.zip' },
    // 解压目录里的文件：名字不同 → 不该被判成重复
    { id: 2, fileName: 'readme.txt', bytes: 500, relPath: 'g/9013048/readme.txt' },
    { id: 3, fileName: 'texture.png', bytes: 500, relPath: 'g/9013048/texture.png' }
  ];
  assert.equal(findDuplicateGroups(rows).length, 0);
});

check('findDuplicateGroups：默认忽略已删除行，includeDeleted 才计入', () => {
  const rows = [
    { id: 1, fileName: 'z.zip', bytes: 1, relPath: 'g/z.zip' },
    { id: 2, fileName: 'z.zip', bytes: 1, relPath: 'g/old/z.zip', deletedAt: T0 }
  ];
  assert.equal(findDuplicateGroups(rows).length, 0);
  assert.equal(findDuplicateGroups(rows, { includeDeleted: true }).length, 1);
});

check('scanArchiveDuplicates：从台账扫出重复并可按群过滤（只读）', () => {
  const db = freshDb();
  const mk = (groupId, name, bytes, rel) => insertArchiveRecord(db, {
    groupId, fileName: name, storedName: name, relPath: rel, bytes, archivedAt: T0
  });
  mk('1', 'dup.zip', 42, '1/2026-01/dup.zip');
  mk('1', 'DUP.ZIP', 42, '1/2026-02/DUP.ZIP');
  mk('2', 'dup.zip', 42, '2/2026-01/dup.zip');
  const all = scanArchiveDuplicates(db);
  assert.equal(all.scanned, 3);
  assert.equal(all.groups.length, 1);
  assert.equal(all.groups[0].ids.length, 3);
  assert.equal(all.duplicates, 2);
  const only1 = scanArchiveDuplicates(db, { groupId: '1' });
  assert.equal(only1.groups.length, 1);
  assert.equal(only1.groups[0].ids.length, 2);
  // 只读：台账行数不变
  assert.equal(db.prepare('SELECT COUNT(*) n FROM file_archive').get().n, 3);
});

// ── 缩略图信号量 ────────────────────────────────────────────────────────────
await checkAsync('信号量：并发上限 2（峰值不会超过）', async () => {
  const sem = createSemaphore(2);
  let active = 0;
  let peak = 0;
  const jobs = Array.from({ length: 6 }, () => sem.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
  }));
  await Promise.all(jobs);
  assert.equal(peak, 2);
  assert.equal(sem.active, 0);
});

await checkAsync('信号量：任务抛错也会释放槽位（不会饿死后面的）', async () => {
  const sem = createSemaphore(1);
  await assert.rejects(() => sem.run(async () => { throw new Error('boom'); }));
  assert.equal(sem.active, 0);
  assert.equal(await sem.run(async () => 'ok'), 'ok');
});

await checkAsync('全局缩略图信号量：上限是 2', async () => {
  assert.equal(thumbSemaphore.limit, THUMB_CONCURRENCY);
  const out = await withThumbSlot(async () => 'slot');
  assert.equal(out, 'slot');
});

check('超大跳过：超过上限返回 true，未知大小不跳过', () => {
  assert.equal(shouldSkipThumb({ bytes: 9 * 1024 * 1024 }), true);
  assert.equal(shouldSkipThumb({ bytes: 1024 }), false);
  assert.equal(shouldSkipThumb({ bytes: 0 }), false);
  assert.equal(shouldSkipThumb({ bytes: 5, maxBytes: 4 }), true);
});

// ── mtime 增量刷新 ──────────────────────────────────────────────────────────
const root = tmp('archive-p1-mtime-');
fs.mkdirSync(path.join(root, '9001', '2026-01'), { recursive: true });
fs.writeFileSync(path.join(root, '9001', '2026-01', 'a.zip'), 'a');
fs.mkdirSync(path.join(root, '9002'), { recursive: true });

check('索引：记录每个目录的 mtime 与条目数', () => {
  const idx = indexDirMtimes(root);
  assert.ok(idx.dirs[''] !== undefined);
  assert.ok(idx.dirs['9001'] !== undefined);
  assert.ok(idx.dirs['9001/2026-01'] !== undefined);
  assert.equal(typeof idx.dirs['9001'].mtimeMs, 'number');
});

check('增量：完全没变 → hasChanges=false（不重扫）', () => {
  const a = indexDirMtimes(root);
  const b = indexDirMtimes(root);
  const d = diffDirMtimes(a, b);
  assert.equal(d.hasChanges, false);
  assert.equal(shouldRescan(a, b), false);
});

check('增量：新增文件（目录 mtime/条目数变）→ 被判为变化', () => {
  const before = indexDirMtimes(root);
  fs.writeFileSync(path.join(root, '9001', '2026-01', 'b.zip'), 'b');
  // 强制推一下 mtime，避免文件系统时间精度导致"看不出变化"
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, '9001', '2026-01'), future, future);
  const after = indexDirMtimes(root);
  const d = diffDirMtimes(before, after);
  assert.equal(d.hasChanges, true);
  assert.ok(d.changed.includes('9001/2026-01'));
  assert.equal(shouldRescan(before, after), true);
});

check('增量：新增/删除目录 → added/removed 各自列出', () => {
  const before = indexDirMtimes(root);
  fs.mkdirSync(path.join(root, '9003'));
  const afterAdd = indexDirMtimes(root);
  assert.ok(diffDirMtimes(before, afterAdd).added.includes('9003'));
  fs.rmSync(path.join(root, '9003'), { recursive: true, force: true });
  const afterRemove = indexDirMtimes(root);
  assert.ok(diffDirMtimes(afterAdd, afterRemove).removed.includes('9003'));
});

check('索引落盘：原子写 + 读回一致（state/ 下的 JSON）', () => {
  const stateDir = tmp('archive-p1-state-');
  const idx = indexDirMtimes(root);
  writeScanIndex(stateDir, idx);
  assert.ok(fs.existsSync(path.join(stateDir, SCAN_INDEX_FILE)));
  const back = readScanIndex(stateDir);
  assert.deepEqual(Object.keys(back.dirs).sort(), Object.keys(idx.dirs).sort());
  // 没有残留临时文件
  const leftovers = fs.readdirSync(stateDir).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

check('索引读取：没有文件时返回 null（不抛）', () => {
  assert.equal(readScanIndex(tmp('archive-p1-empty-')), null);
});

// ── 收尾 ────────────────────────────────────────────────────────────────────
for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
const total = passed + failed;
if (failed) { console.error(`\n❌ test-archive-p1-maintain 失败 ${failed}/${total}`); process.exit(1); }
console.log(`\n✅ test-archive-p1-maintain 全部通过（${passed}/${total}）`);
