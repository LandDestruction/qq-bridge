// M6-P0 ①：contentKey（稳定内容标识）与 ② 规则版本号的离线单元测试。
//
// 为什么需要：这两项是"盘上文件是唯一真相"的地基——路径会变、规则会改，
// 没有 contentKey 就无法在文件被移动/改名后仍认出同一件；没有规则版本号，
// 改完识别规则后旧结论会永久污染台账，用户还看不见"跳过了多少"。
//
// 全部用内存 SQLite + 临时目录，不碰真实 state/、不联网。
// 用法：node scripts/test-archive-contentkey.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  contentKeyFor,
  ensureFileLedger,
  insertArchiveRecord,
  backfillContentKeys,
  stampRuleVersions,
  countStaleRuleRows,
  reconcileRuleVersions,
  readRuleVersions,
  writeRuleVersions,
  resetRuleVersions,
  formatRulesVersion,
  parseRulesVersion,
  isStaleRulesVersion,
  RULES_VERSIONS,
  RULES_STATE_FILE,
  archiveStats,
  listArchive,
  storeArchivedFile,
  moveArchiveItemToCategory,
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
const tmpDirs = [];
function tmp(prefix = 'archive-ck-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  ensureFileLedger(db);
  return db;
}
/** 插一行"旧库"数据：模拟升级前就存在、没有 content_key / rules_ver 的行。 */
function insertLegacyRow(db, { fileName, bytes, relPath, archivedAt = T0 }) {
  db.prepare(`INSERT INTO file_archive (group_id, file_id, file_name, stored_name, rel_path, bytes, sha256,
    archived_at, category, category_source, cleanup_at) VALUES (?,?,?,?,?,?,'',?,?,'rule',?)`)
    .run('1001', 'f1', fileName, path.basename(relPath), relPath, bytes, archivedAt, '压缩包', archivedAt + 120 * 86400000);
  return Number(db.prepare('SELECT id FROM file_archive WHERE rel_path = ?').get(relPath).id);
}

// ── contentKey ──────────────────────────────────────────────────────────────
check('contentKey：16 位小写十六进制', () => {
  const key = contentKeyFor('9038753 商品.zip', 12345);
  assert.match(key, /^[0-9a-f]{16}$/);
});

check('contentKey：稳定（同名同大小 → 同 key）且大小写不敏感', () => {
  assert.equal(contentKeyFor('A.ZIP', 100), contentKeyFor('a.zip', 100));
  assert.equal(contentKeyFor('a.zip', 100), contentKeyFor('a.zip', 100));
});

check('contentKey：大小不同 → key 不同', () => {
  assert.notEqual(contentKeyFor('a.zip', 100), contentKeyFor('a.zip', 101));
});

check('contentKey：分隔符防止拼接歧义（a.zip+12 ≠ a.zip1+2）', () => {
  assert.notEqual(contentKeyFor('a.zip', 12), contentKeyFor('a.zip1', 2));
});

check('contentKey：非法字节数按 0 处理，不抛', () => {
  assert.match(contentKeyFor('a.zip', NaN), /^[0-9a-f]{16}$/);
  assert.equal(contentKeyFor('a.zip', -5), contentKeyFor('a.zip', 0));
});

// ── 台账列与回填 ────────────────────────────────────────────────────────────
check('ensureFileLedger 建出 content_key / rules_ver 两列', () => {
  const db = freshDb();
  const cols = db.prepare('PRAGMA table_info(file_archive)').all().map((c) => c.name);
  assert.ok(cols.includes('content_key'));
  assert.ok(cols.includes('rules_ver'));
});

check('insertArchiveRecord：新行自动带 contentKey 与当前规则版本', () => {
  const db = freshDb();
  const { id } = insertArchiveRecord(db, {
    groupId: '1001', fileId: 'f1', fileName: '9038753 商品.zip', storedName: '9038753 商品.zip',
    relPath: '1001/2026-01/9038753 商品.zip', bytes: 500, archivedAt: T0
  });
  const row = listArchive(db, { limit: 10 }).find((r) => r.id === id);
  assert.equal(row.contentKey, contentKeyFor('9038753 商品.zip', 500));
  assert.equal(row.rulesVer, formatRulesVersion());
});

check('backfillContentKeys：老行补上 key，且幂等', () => {
  const db = freshDb();
  const id = insertLegacyRow(db, { fileName: 'Old.zip', bytes: 42, relPath: '1001/2026-01/Old.zip' });
  const first = backfillContentKeys(db);
  assert.equal(first.updated, 1);
  const row = listArchive(db, { limit: 10 }).find((r) => r.id === id);
  assert.equal(row.contentKey, contentKeyFor('Old.zip', 42));
  assert.equal(backfillContentKeys(db).updated, 0);
});

check('ensureFileLedger 打开旧库时会自动回填（不抛、纯 UPDATE）', () => {
  const db = new DatabaseSync(':memory:');
  ensureFileLedger(db);
  // 模拟"旧库"：把两列清空再重新 ensure
  insertLegacyRow(db, { fileName: 'X.zip', bytes: 7, relPath: '1001/2026-01/X.zip' });
  db.exec("UPDATE file_archive SET content_key = '', rules_ver = ''");
  ensureFileLedger(db);
  const row = db.prepare('SELECT content_key, rules_ver FROM file_archive').get();
  assert.equal(row.content_key, contentKeyFor('X.zip', 7));
  assert.equal(row.rules_ver, formatRulesVersion());
});

// ── 规则版本号 ──────────────────────────────────────────────────────────────
check('版本串：format/parse 往返一致', () => {
  const text = formatRulesVersion({ identify: 3, category: 2, booth: 5 });
  assert.equal(text, 'identify=3,category=2,booth=5');
  assert.deepEqual(parseRulesVersion(text), { identify: 3, category: 2, booth: 5 });
});

check('isStaleRulesVersion：任一维度落后就算旧结论', () => {
  assert.equal(isStaleRulesVersion(formatRulesVersion()), false);
  assert.equal(isStaleRulesVersion('identify=0,category=1,booth=1'), true);
  assert.equal(isStaleRulesVersion(''), true);
});

check('reconcileRuleVersions：首次写 state/、无旧结论时 stale=0', () => {
  const db = freshDb();
  insertArchiveRecord(db, { groupId: '1', fileName: 'a.zip', storedName: 'a.zip', relPath: '1/2026-01/a.zip', bytes: 1, archivedAt: T0 });
  const stateDir = tmp();
  const r = reconcileRuleVersions(db, { stateDir, nowMs: T0 });
  assert.equal(r.stored, true);
  assert.equal(r.staleRows, 0);
  assert.equal(r.skippedOldConclusions, 0);
  const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, RULES_STATE_FILE), 'utf8'));
  assert.equal(onDisk.identify, RULES_VERSIONS.identify);
});

check('reconcileRuleVersions：版本号变大 → 旧行被判旧结论，N 就是 staleRows', () => {
  const db = freshDb();
  insertArchiveRecord(db, { groupId: '1', fileName: 'a.zip', storedName: 'a.zip', relPath: '1/2026-01/a.zip', bytes: 1, archivedAt: T0 });
  insertArchiveRecord(db, { groupId: '1', fileName: 'b.zip', storedName: 'b.zip', relPath: '1/2026-01/b.zip', bytes: 2, archivedAt: T0 });
  const stateDir = tmp();
  writeRuleVersions(stateDir, RULES_VERSIONS, { nowMs: T0 });
  const bumped = { ...RULES_VERSIONS, category: RULES_VERSIONS.category + 1 };
  const r = reconcileRuleVersions(db, { stateDir, versions: bumped, nowMs: T0 });
  assert.equal(r.changed, true);
  assert.equal(r.staleRows, 2);
  assert.equal(r.skippedOldConclusions, 2);
  assert.deepEqual(readRuleVersions(stateDir), { identify: bumped.identify, category: bumped.category, booth: bumped.booth });
});

check('stampRuleVersions：只盖空版本，不动已是最新的行', () => {
  const db = freshDb();
  const id = insertLegacyRow(db, { fileName: 'c.zip', bytes: 3, relPath: '1/2026-01/c.zip' });
  db.exec("UPDATE file_archive SET rules_ver = ''");
  assert.equal(countStaleRuleRows(db), 1);
  assert.equal(stampRuleVersions(db), 1);
  assert.equal(countStaleRuleRows(db), 0);
  assert.equal(stampRuleVersions(db), 0);
  assert.ok(id);
});

check('resetRuleVersions：「全部重来」清空版本戳 → 所有行变旧结论', () => {
  const db = freshDb();
  insertArchiveRecord(db, { groupId: '1', fileName: 'd.zip', storedName: 'd.zip', relPath: '1/2026-01/d.zip', bytes: 4, archivedAt: T0 });
  assert.equal(countStaleRuleRows(db), 0);
  const r = resetRuleVersions(db);
  assert.equal(r.cleared, 1);
  assert.equal(countStaleRuleRows(db), 1);
});

check('archiveStats 暴露 rules 段（控制台「跳过 N 条旧结论」的数据源）', () => {
  const db = freshDb();
  insertArchiveRecord(db, { groupId: '1', fileName: 'e.zip', storedName: 'e.zip', relPath: '1/2026-01/e.zip', bytes: 5, archivedAt: T0 });
  const stats = archiveStats(db, { nowMs: T0 });
  assert.equal(stats.rules.versions.category, RULES_VERSIONS.category);
  assert.equal(stats.rules.skippedOldConclusions, 0);
  resetRuleVersions(db);
  assert.equal(archiveStats(db, { nowMs: T0 }).rules.skippedOldConclusions, 1);
});

// ── contentKey 与"文件被移动后仍认得出" ────────────────────────────────────
const moveRoot = tmp('archive-ck-move-');
const moveDb = freshDb();
const stored = storeArchivedFile({
  db: moveDb, rootDir: moveRoot, groupId: '2001', fileName: '9038753 素材.zip',
  buffer: Buffer.from('hello-m6'), archivedAt: T0
});
clearOwnWrites();

await checkAsync('移动文件后 contentKey 不变、relPath 变了', async () => {
  const before = listArchive(moveDb, { limit: 10 }).find((r) => r.id === stored.id);
  const moved = moveArchiveItemToCategory({ db: moveDb, rootDir: moveRoot, id: stored.id, category: '新分类', nowMs: T0 });
  assert.equal(moved.moved, true);
  const after = listArchive(moveDb, { limit: 10 }).find((r) => r.id === stored.id);
  assert.equal(after.contentKey, before.contentKey);
  assert.notEqual(after.relPath, before.relPath);
  assert.ok(fs.existsSync(path.join(moveRoot, after.relPath)));
});

check('contentKey 能按 (文件名, 字节数) 重算出来（盘上重建索引用）', () => {
  const row = listArchive(moveDb, { limit: 10 }).find((r) => r.id === stored.id);
  assert.equal(row.contentKey, contentKeyFor(row.fileName, row.bytes));
});

// ── 收尾 ────────────────────────────────────────────────────────────────────
for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
const total = passed + failed;
if (failed) { console.error(`\n❌ test-archive-contentkey 失败 ${failed}/${total}`); process.exit(1); }
console.log(`\n✅ test-archive-contentkey 全部通过（${passed}/${total}）`);
