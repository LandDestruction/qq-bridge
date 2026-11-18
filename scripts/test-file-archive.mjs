// 群文件转存 / 保留期 / 清理 / 分类的离线单测。
// 全部用内存 SQLite + 注入的假时钟与假文件系统，不依赖真实等待、不碰 state/。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DAY_MS,
  normalizeFileArchiveConfig,
  countArchive,
  ARCHIVE_EXTENSIONS,
  ARCHIVE_IMAGE_EXTENSIONS,
  ARCHIVE_EXCLUDED_KINDS,
  isArchiveGroup,
  sanitizeFileName,
  archiveRelPath,
  allocateStoredName,
  resolveArchiveRoot,
  safeResolveInside,
  ensureFileLedger,
  insertArchiveRecord,
  setArchiveCategory,
  listArchive,
  dueArchiveRecords,
  archiveStats,
  runArchiveCleanup,
  formatCleanupLog,
  retentionDaysFor,
  cleanupDeadline,
  classifyByRules,
  parseClassifyReply,
  formatBytes
} from '../src/file-archive.js';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); }
  catch (error) { failed += 1; console.error(`❌ ${name} — ${error?.message ?? error}`); }
}

const T0 = Date.UTC(2026, 0, 1); // 固定时间基准，绝不读系统时钟

function freshDb() {
  const db = new DatabaseSync(':memory:');
  ensureFileLedger(db);
  return db;
}

function addRecord(db, overrides = {}) {
  const archivedAt = overrides.archivedAt ?? T0;
  const category = overrides.category ?? 'unclassified';
  return insertArchiveRecord(db, {
    groupId: '100000001',
    fileId: overrides.fileId ?? `f-${Math.random().toString(16).slice(2)}`,
    fileName: 'a.txt',
    storedName: 'a.txt',
    relPath: overrides.relPath ?? `100000001/2026-01/a-${Math.random().toString(16).slice(2)}.txt`,
    bytes: 100,
    sha256: 'x',
    archivedAt,
    category,
    categorySource: 'rule',
    retention: overrides.retention,
    cleanupAt: overrides.cleanupAt ?? cleanupDeadline(archivedAt, category, overrides.retention),
    ...overrides
  });
}

// ── 配置规范化 ────────────────────────────────────────────────────────────
check('配置：默认值（关闭 / 空白名单 / 2500MB=2.5GB / 60+120 天）', () => {
  const cfg = normalizeFileArchiveConfig(undefined);
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.groups, []);
  assert.equal(cfg.dir, 'state/files');
  assert.equal(cfg.maxFileMb, 2560, '默认单文件上限 2.5GiB（2560MB）');
  assert.equal(cfg.retention.unclassifiedDays, 60);
  assert.equal(cfg.retention.classifiedDays, 120);
  assert.equal(cfg.cleanupHour, 4);
});

check('配置：非法类型收敛（字符串 groups / 超大 maxFileMb / 越界 cleanupHour）', () => {
  const cfg = normalizeFileArchiveConfig({
    enabled: true,
    groups: ['100000001', 123, 'abc', '100000001'],
    dir: '  ',
    maxFileMb: 99999,
    retention: { unclassifiedDays: 0, classifiedDays: -5 },
    cleanupHour: 99
  });
  assert.deepEqual(cfg.groups, ['100000001', '123'], '非数字项被丢弃，重复项去重');
  assert.equal(cfg.dir, 'state/files');
  assert.equal(cfg.maxFileMb, 2560, '超过 2.5GiB 的配置被夹到 2560MB');
  assert.equal(cfg.retention.unclassifiedDays, 60, '非法值回落默认');
  assert.equal(cfg.retention.classifiedDays, 120);
  assert.equal(cfg.cleanupHour, 4);
});

check('白名单：空数组 = 谁都不存；enabled=false 时即使在名单里也不存', () => {
  const off = normalizeFileArchiveConfig({ enabled: false, groups: ['100000001'] });
  assert.equal(isArchiveGroup(off, '100000001'), false);
  const on = normalizeFileArchiveConfig({ enabled: true, groups: ['100000001'] });
  assert.equal(isArchiveGroup(on, '100000001'), true);
  assert.equal(isArchiveGroup(on, 100000001), true, '数字群号也要能匹配');
  assert.equal(isArchiveGroup(on, '111'), false);
  assert.equal(isArchiveGroup(off, 100000001), false);
});

// ── 文件名 / 路径 ─────────────────────────────────────────────────────────
check('文件名：路径分隔符/控制字符被替换，空名回退，Windows 保留名加前缀', () => {
  assert.equal(sanitizeFileName('a/b\\c.txt'), 'a_b_c.txt');
  assert.equal(sanitizeFileName('  ..  '), 'unnamed');
  assert.equal(sanitizeFileName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFileName('x'.repeat(200) + '.png').length <= 120, true);
});

check('路径：<群号>/<YYYY-MM>/<文件名>；重名加序号不覆盖', () => {
  const rel = archiveRelPath('100000001', T0, '报告.pdf');
  assert.deepEqual(rel.split(path.sep), ['100000001', '2026-01', '报告.pdf']);
  const taken = new Set(['a.txt', 'a (1).txt']);
  assert.equal(allocateStoredName('a.txt', (c) => taken.has(c)), 'a (2).txt');
  assert.equal(allocateStoredName('b.txt', (c) => taken.has(c)), 'b.txt');
  assert.equal(rel.startsWith(path.join('100000001', '2026-01')), true);
});

check('路径：safeResolveInside 拒绝越界（台账被改坏时也不删目录外的东西）', () => {
  const root = path.resolve('C:/tmp/archive-root');
  assert.equal(safeResolveInside(root, 'g/2026-01/a.txt'), path.join(root, 'g', '2026-01', 'a.txt'));
  assert.throws(() => safeResolveInside(root, '../outside.txt'), /转存目录之外/);
  assert.throws(() => safeResolveInside(root, 'a/../../x.txt'), /转存目录之外/);
});

check('路径：相对 dir 按 ROOT 解析，绝对 dir 原样', () => {
  assert.equal(resolveArchiveRoot('C:/repo', 'state/files'), path.resolve('C:/repo/state/files'));
  const abs = path.resolve('D:/files');
  assert.equal(resolveArchiveRoot('C:/repo', abs), abs);
});

// ── 台账 ─────────────────────────────────────────────────────────────────
check('台账：rel_path 唯一（重复事件不产生重复行）', () => {
  const db = freshDb();
  const r1 = addRecord(db, { relPath: 'g/2026-01/a.txt' });
  const r2 = addRecord(db, { relPath: 'g/2026-01/a.txt' });
  assert.equal(r1.inserted, true);
  assert.equal(r2.inserted, false);
  assert.equal(r2.id, r1.id);
  assert.equal(listArchive(db).length, 1);
});

check('保留期：未分类 60 天 / 已分类 120 天（可用 retention 覆盖）', () => {
  assert.equal(retentionDaysFor(''), 60);
  assert.equal(retentionDaysFor('unclassified'), 60);
  assert.equal(retentionDaysFor('文档'), 120);
  assert.equal(retentionDaysFor('', { unclassifiedDays: 30, classifiedDays: 90 }), 30);
  assert.equal(retentionDaysFor('文档', { unclassifiedDays: 30, classifiedDays: 90 }), 90);
  assert.equal(cleanupDeadline(T0, '文档') - T0, 120 * DAY_MS);
  assert.equal(cleanupDeadline(T0, '') - T0, 60 * DAY_MS);
});

check('保留期边界：差 1 天两侧（59 天不删 / 60 天删 / 119 天不删 / 120 天删）', () => {
  const db = freshDb();
  const r = addRecord(db, { relPath: 'g/2026-01/u.txt', category: 'unclassified', archivedAt: T0 });
  const c = addRecord(db, { relPath: 'g/2026-01/c.txt', category: '文档', archivedAt: T0 });

  // 未分类：59 天还不到期
  assert.deepEqual(dueArchiveRecords(db, T0 + 59 * DAY_MS).map((x) => x.id), [], '59 天不该被清理');
  // 60 天整到期
  assert.deepEqual(dueArchiveRecords(db, T0 + 60 * DAY_MS).map((x) => x.id), [r.id], '60 天整必须到期');
  // 已分类：119 天还不到期
  assert.deepEqual(dueArchiveRecords(db, T0 + 119 * DAY_MS).map((x) => x.id), [r.id], '已分类 119 天不该被清理');
  // 120 天整到期
  assert.deepEqual(dueArchiveRecords(db, T0 + 120 * DAY_MS).map((x) => x.id).sort(), [r.id, c.id].sort(), '120 天整必须到期');
});

check('人工覆盖分类：cleanup_at 立刻重算（未分类→已分类顺延 60 天）', () => {
  const db = freshDb();
  const row = addRecord(db, { relPath: 'g/2026-01/x.txt', category: 'unclassified', archivedAt: T0 });
  assert.equal(row.inserted, true);
  const before = listArchive(db).find((x) => x.id === row.id).cleanupAt;
  assert.equal(before, T0 + 60 * DAY_MS);
  const rec = setArchiveCategory(db, { id: row.id, category: '文档', source: 'manual', nowMs: T0 + 10 * DAY_MS });
  assert.equal(rec.cleanupAt, T0 + 120 * DAY_MS, '分类后按 120 天重算');
  assert.equal(dueArchiveRecords(db, T0 + 61 * DAY_MS).length, 0, '顺延后 61 天不该到期');
  // 再改回未分类：立刻回到 60 天口径（仍按 archived_at 起算）
  const back = setArchiveCategory(db, { id: row.id, category: '', source: 'manual' });
  assert.equal(back.cleanupAt, T0 + 60 * DAY_MS);
  assert.throws(() => setArchiveCategory(db, { id: 99999, category: 'x' }), /没有 id=99999/);
});

check('台账汇总：active/due/classified 与分组统计', () => {
  const db = freshDb();
  addRecord(db, { relPath: 'g/2026-01/1.txt', category: '文档', bytes: 1000 });
  addRecord(db, { relPath: 'g/2026-01/2.txt', category: 'unclassified', bytes: 500 });
  const s = archiveStats(db, { nowMs: T0 + 61 * DAY_MS });
  assert.equal(s.files.active, 2);
  assert.equal(s.files.activeBytes, 1500);
  assert.equal(s.files.classified, 1);
  assert.equal(s.files.unclassified, 1);
  assert.equal(s.files.due, 1, '只有未分类那条到期');
  assert.equal(s.files.dueBytes, 500);
  assert.equal(s.byGroup[0].files, 2);
  assert.deepEqual(s.retention, { unclassifiedDays: 60, classifiedDays: 120 });
});

// ── 清理 ─────────────────────────────────────────────────────────────────
check('清理：只删到期文件，不删未到期；释放字节与标记正确', () => {
  const db = freshDb();
  const due = addRecord(db, { relPath: 'g/2026-01/due.txt', category: 'unclassified', bytes: 300, archivedAt: T0 });
  const keep = addRecord(db, { relPath: 'g/2026-01/keep.txt', category: '文档', bytes: 900, archivedAt: T0 });
  const removed = [];
  const result = runArchiveCleanup({
    db,
    rootDir: path.resolve('C:/tmp/archive-root'),
    nowMs: T0 + 61 * DAY_MS,
    exists: () => true,
    removeFile: (abs) => removed.push(abs)
  });
  assert.equal(result.deleted, 1);
  assert.equal(result.bytes, 300);
  assert.equal(result.failed, 0);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].endsWith(path.join('g', '2026-01', 'due.txt')), true);
  const rows = listArchive(db, { includeDeleted: true });
  assert.equal(rows.find((r) => r.id === due.id).deleteReason, 'expired');
  assert.equal(rows.find((r) => r.id === keep.id).deletedAt, null, '未到期绝不能被删');
});

check('清理：文件已不存在 → 台账标 missing；路径越界 → unsafe-path 且不乱删', () => {
  const db = freshDb();
  addRecord(db, { relPath: 'g/2026-01/gone.txt', category: 'unclassified', archivedAt: T0 });
  const outside = path.resolve('C:/tmp/evil.txt');
  addRecord(db, { relPath: path.relative(path.resolve('C:/tmp/archive-root'), outside), category: 'unclassified', archivedAt: T0 });
  const removed = [];
  const result = runArchiveCleanup({
    db,
    rootDir: path.resolve('C:/tmp/archive-root'),
    nowMs: T0 + 61 * DAY_MS,
    exists: (abs) => !abs.endsWith('gone.txt'),
    removeFile: (abs) => removed.push(abs)
  });
  assert.equal(result.deleted, 0);
  assert.equal(result.missing, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(removed, [], '越界路径必须一条都不删');
  const reasons = listArchive(db, { includeDeleted: true }).map((r) => r.deleteReason).sort();
  assert.deepEqual(reasons, ['missing', 'unsafe-path']);
});

check('清理：重复跑第二遍是幂等的（已标记的不再处理）', () => {
  const db = freshDb();
  addRecord(db, { relPath: 'g/2026-01/once.txt', category: 'unclassified', bytes: 10, archivedAt: T0 });
  const opts = {
    db,
    rootDir: path.resolve('C:/tmp/archive-root'),
    nowMs: T0 + 61 * DAY_MS,
    exists: () => true,
    removeFile: () => {}
  };
  assert.equal(runArchiveCleanup(opts).deleted, 1);
  const second = runArchiveCleanup(opts);
  assert.equal(second.deleted, 0);
  assert.equal(second.missing, 0);
  assert.equal(second.failed, 0);
});

// ── 清理预演（dryRun）────────────────────────────────────────────────────
// 用户要求「先预览再执行」：预览必须**一个字节都不写**，且预览出来的集合要与真删同源。
check('dryRun：只预览——不删文件、不删台账、不写日志', () => {
  const db = freshDb();
  const due = addRecord(db, { relPath: 'g/2026-01/due.txt', category: 'unclassified', bytes: 300, archivedAt: T0 });
  const keep = addRecord(db, { relPath: 'g/2026-01/keep.txt', category: '文档', bytes: 900, archivedAt: T0 });
  const removed = [];
  const logs = [];
  const result = runArchiveCleanup({
    db,
    rootDir: path.resolve('C:/tmp/archive-root'),
    nowMs: T0 + 61 * DAY_MS,
    dryRun: true,
    exists: () => true,
    removeFile: (abs) => removed.push(abs),
    log: (msg) => logs.push(msg)
  });
  assert.equal(result.dryRun, true, '必须自报 dryRun');
  assert.equal(result.wouldRemoveCount, 1);
  assert.equal(result.wouldRemoveBytes, 300);
  assert.deepEqual(removed, [], '预演绝不能 unlink 任何文件');
  assert.deepEqual(logs, [], '预演不打日志（日志也是落盘副作用）');
  const rows = listArchive(db, { includeDeleted: true });
  assert.equal(rows.find((r) => r.id === due.id).deletedAt, null, '预演不能改台账 deleted_at');
  assert.equal(rows.find((r) => r.id === due.id).deleteReason, '', '预演不能写 delete_reason（列默认值就是空串）');
  assert.equal(rows.find((r) => r.id === keep.id).deletedAt, null);
});

check('dryRun：wouldRemove 字段齐全，且与真删的集合/字节数一致', () => {
  const db = freshDb();
  addRecord(db, { relPath: 'g/2026-01/a.txt', category: 'unclassified', bytes: 300, archivedAt: T0 });
  addRecord(db, { relPath: 'g/2026-01/b.txt', category: '文档', bytes: 900, archivedAt: T0 });
  const opts = { db, rootDir: path.resolve('C:/tmp/archive-root'), nowMs: T0 + 61 * DAY_MS, exists: () => true };
  const preview = runArchiveCleanup({ ...opts, dryRun: true, removeFile: () => { throw new Error('预演不该调 removeFile'); } });
  const item = preview.wouldRemove[0];
  assert.deepEqual(Object.keys(item).sort(), ['bytes', 'category', 'createdAt', 'fileName', 'id', 'name', 'reason', 'relPath'].sort());
  assert.equal(item.reason, 'expired');
  assert.equal(item.createdAt, T0);
  assert.equal(item.bytes, 300);
  assert.equal(item.category, 'unclassified');
  assert.equal(item.name.endsWith('a.txt'), true);
  // 同一个库、同一时刻、同一份注入，只把 dryRun 换成真跑：删掉的必须正好是预览列出来的那几条。
  const real = runArchiveCleanup({ ...opts, removeFile: () => {} });
  assert.equal(real.deleted, preview.wouldRemoveCount, '真删条数 = 预览条数');
  assert.equal(real.bytes, preview.wouldRemoveBytes, '真删字节 = 预览字节');
});

check('dryRun：幂等——连跑两次结果相同，台账仍未动', () => {
  const db = freshDb();
  addRecord(db, { relPath: 'g/2026-01/x.txt', category: 'unclassified', bytes: 7, archivedAt: T0 });
  const opts = { db, rootDir: path.resolve('C:/tmp/archive-root'), nowMs: T0 + 61 * DAY_MS, exists: () => true, dryRun: true };
  const first = runArchiveCleanup(opts);
  const second = runArchiveCleanup(opts);
  assert.deepEqual(second, first, '两次预演的结果必须逐字段相同');
  assert.equal(first.wouldRemoveCount, 1, '预演不消费到期条目，第二次仍能看到它');
  assert.equal(listArchive(db, { includeDeleted: true })[0].deletedAt, null);
});

check('dryRun：空库 → wouldRemoveCount=0，不报错', () => {
  const db = freshDb();
  const result = runArchiveCleanup({ db, rootDir: path.resolve('C:/tmp/archive-root'), nowMs: T0 + 61 * DAY_MS, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.wouldRemoveCount, 0);
  assert.equal(result.wouldRemoveBytes, 0);
  assert.deepEqual(result.wouldRemove, []);
});

check('dryRun：只把「文件真在」的算进 wouldRemove，missing/越界只计数', () => {
  const db = freshDb();
  addRecord(db, { relPath: 'g/2026-01/gone.txt', category: 'unclassified', archivedAt: T0 });
  addRecord(db, { relPath: '../../evil.txt', category: 'unclassified', archivedAt: T0 });
  addRecord(db, { relPath: 'g/2026-01/here.txt', category: 'unclassified', bytes: 5, archivedAt: T0 });
  const result = runArchiveCleanup({
    db,
    rootDir: path.resolve('C:/tmp/archive-root'),
    nowMs: T0 + 61 * DAY_MS,
    dryRun: true,
    exists: (abs) => !abs.endsWith('gone.txt')
  });
  assert.equal(result.wouldRemoveCount, 1, '只有真实存在的文件才算「将被删」');
  assert.equal(result.wouldRemove[0].relPath, 'g/2026-01/here.txt');
  assert.equal(result.wouldMarkMissing, 1, '文件已不在的只是补 missing 标记，没有可删的东西');
  assert.equal(result.wouldMarkUnsafe, 1, '越界路径真跑只标 unsafe-path');
  assert.equal(listArchive(db, { includeDeleted: true }).filter((r) => r.deletedAt !== null).length, 0);
});

check('dryRun：真文件真目录——预演后文件还在、台账还在，真跑才消失', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-dryrun-'));
  const relPath = 'g/2026-01/real.txt';
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'payload');
  const db = freshDb();
  const row = addRecord(db, { relPath, category: 'unclassified', bytes: 7, archivedAt: T0 });
  const opts = { db, rootDir: root, nowMs: T0 + 61 * DAY_MS };
  const preview = runArchiveCleanup({ ...opts, dryRun: true });
  assert.equal(preview.wouldRemoveCount, 1);
  assert.equal(fs.existsSync(abs), true, '预演绝不能让磁盘上的文件消失');
  assert.equal(listArchive(db, { includeDeleted: true }).find((r) => r.id === row.id).deletedAt, null);
  const real = runArchiveCleanup(opts);
  assert.equal(real.deleted, 1);
  assert.equal(fs.existsSync(abs), false, '真跑才删文件');
  assert.equal(listArchive(db, { includeDeleted: true }).find((r) => r.id === row.id).deleteReason, 'expired');
  fs.rmSync(root, { recursive: true, force: true });
});

check('清理日志：一行说明删了多少/释放多少/下次运行', () => {
  const line = formatCleanupLog({ deleted: 3, bytes: 2048, missing: 1, failed: 0 }, T0 + DAY_MS);
  assert.match(line, /删除 3 个（2.0 KB）/);
  assert.match(line, /缺失 1/);
  assert.match(line, /下次运行/);
  assert.equal(formatBytes(1024 * 1024 * 3), '3.0 MB');
});

// ── 分类 ─────────────────────────────────────────────────────────────────
check('规则分类：扩展名识别 / 认不出回 unclassified', () => {
  assert.deepEqual(classifyByRules('报告.pdf'), { category: '文档', source: 'rule' });
  assert.deepEqual(classifyByRules('a.zip'), { category: '压缩包', source: 'rule' });
  assert.deepEqual(classifyByRules('img.PNG'), { category: '图片', source: 'rule' });
  assert.deepEqual(classifyByRules('mystery.bin'), { category: 'unclassified', source: 'none' });
});

check('模型分类输出解析：容忍引号/句号/换行；空与超长判非法', () => {
  assert.equal(parseClassifyReply('文档'), '文档');
  assert.equal(parseClassifyReply('「压缩包」。'), '压缩包');
  assert.equal(parseClassifyReply('  unclassified\n（因为…）'), 'unclassified');
  assert.equal(parseClassifyReply(''), '');
  assert.equal(parseClassifyReply('这是一段很长很长的解释说明文字不是分类'), '');
});

if (failed) {
  console.error(`\n❌ ${failed} 项失败`);
  process.exit(1);
}

// ── 分页：offset 切片 + total 正确（用假 db，只验切片语义，不建真库）──────
{
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `n${i}.zip`, archived_at: 1000 + i }));
  const fakeDb = {
    prepare(sql) {
      return {
        all: (...args) => {
          const limit = Number(args[args.length - 2]);
          const offset = Number(args[args.length - 1]);
          assert(sql.includes('LIMIT ? OFFSET ?'), 'SQL 必须带 OFFSET');
          return rows.slice(offset, offset + limit);
        },
        get: () => ({ n: rows.length })
      };
    }
  };
  assert.equal(countArchive(fakeDb, { groupId: '100' }), 12, 'total 应为 12');
  const p1 = listArchive(fakeDb, { groupId: '100', limit: 5, offset: 0 });
  const p2 = listArchive(fakeDb, { groupId: '100', limit: 5, offset: 5 });
  assert.equal(p1.length, 5);
  assert.equal(p2.length, 5);
  assert.equal(p1.filter((a) => p2.some((b) => b.id === a.id)).length, 0, '两页不得重叠');
  assert.deepEqual(listArchive(fakeDb, { groupId: '100', limit: 3 }), listArchive(fakeDb, { groupId: '100', limit: 3, offset: 0 }), '不传 offset 与 offset=0 等价');
}

// ── 转存口径常量同源（路由读这些，不在路由里写死）────────────────────────────
{
  assert(ARCHIVE_EXTENSIONS.includes('zip') && ARCHIVE_EXTENSIONS.includes('rar'), '压缩包白名单');
  assert(ARCHIVE_IMAGE_EXTENSIONS.includes('jpg') && ARCHIVE_IMAGE_EXTENSIONS.includes('png'), '图片白名单');
  assert.deepEqual(ARCHIVE_EXCLUDED_KINDS, ['face', 'mface', 'sticker'], '表情包不转');
}

console.log('\n🎉 test-file-archive 全部通过');
