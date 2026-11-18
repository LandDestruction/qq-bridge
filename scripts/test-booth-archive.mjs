// BOOTH 元数据 / 分类布局测试（追加到 test-file-archive.mjs 末尾）。
// 说明：该文件被 scripts/test-file-archive.mjs 以注释形态引用，实际内容直接内联，
// 避免测试脚本之间互相 import 造成副作用。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ensureFileLedger,
  storeArchivedFile,
  archiveDirRel,
  boothItemDirName,
  metaJsonFor,
  enrichArchiveItem,
  backfillBoothColumns,
  rowsNeedingEnrichment,
  exportArchiveRows,
  archiveRowsToCsv,
  runArchiveCleanup,
  listArchive,
  setArchiveCategory,
  cleanupDeadline
} from '../src/file-archive.js';

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { failed += 1; console.error(`  FAIL ${name}: ${error?.message ?? error}`); }
}

const T0 = Date.UTC(2026, 0, 15, 4, 0, 0);
const GID = '100000001';

function fresh() {
  const db = new DatabaseSync(':memory:');
  ensureFileLedger(db);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-archive-'));
  return { db, rootDir };
}
const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

console.log('\n## BOOTH 目录布局 / meta.json / 增强');
await check('archiveDirRel：无编号→未分类；有编号→<群>/<分类>/<号> <名>', () => {
  assert.equal(archiveDirRel({ groupId: GID }).split(path.sep).join('/'), `${GID}/未分类`);
  const rel = archiveDirRel({ groupId: GID, category: '衣装', boothId: '9038753', productName: '奥の手 -OkunoTe-' }).split(path.sep).join('/');
  assert.equal(rel, `${GID}/衣装/9038753 奥の手 -OkunoTe-`);
  assert.equal(boothItemDirName('9038753', ''), '9038753 未命名商品');
});
await check('metaJsonFor：tags 用 | 拆分，字段齐全', () => {
  const meta = metaJsonFor({
    boothId: '9038753', boothTitle: '奥の手', boothShop: 'ZigZag', boothPrice: '290-490 JPY',
    boothTags: '衣装|3Dモデル', boothUrl: 'https://booth.pm/zh-cn/items/9038753',
    groupId: GID, fileName: 'a.zip', bytes: 10, sha256: 'x', archivedAt: T0,
    category: '衣装', thumbRel: `${GID}/衣装/x/thumbnail.jpg`, source: 'chat'
  });
  assert.deepEqual(meta.tags, ['衣装', '3Dモデル']);
  assert.equal(meta.title, '奥の手');
  assert.equal(meta.itemUrl, 'https://booth.pm/zh-cn/items/9038753');
  assert.equal(meta.category, '衣装');
});

await check('enrich：成功 → 移到分类目录 + meta.json + 缩略图 + 台账字段', async () => {
  const { db, rootDir } = fresh();
  try {
    const name = '9038753奥の手 -OkunoTe-【愛莉・ミルティナ専用】.zip';
    const stored = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 'f1', fileName: name,
      buffer: Buffer.from('zip-bytes'), archivedAt: T0, source: 'chat',
      baseDirRel: archiveDirRel({ groupId: GID })
    });
    assert.equal(stored.relPath.split(path.sep)[1], '未分类');
    const result = await enrichArchiveItem({
      db, rootDir, id: stored.id, cfg: { booth: { enabled: true, thumbMaxBytes: 1024 * 1024 }, retention: null },
      nowMs: T0 + 1000,
      deps: {
        fetchBoothMeta: async (boothId) => ({
          status: 'ok', title: '奥の手 -OkunoTe-', shop: 'ZigZag', price: '290-490 JPY',
          tags: ['衣装', '3Dモデル'], thumbnailUrl: 'https://booth.pximg.net/t.jpg',
          itemUrl: `https://booth.pm/zh-cn/items/${boothId}`, category: '3D衣装', error: ''
        }),
        downloadThumb: async (url, destAbs) => { fs.writeFileSync(destAbs, Buffer.from('thumb')); return true; }
      }
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.category, '3D衣装');
    const dirRel = result.relPath.slice(0, result.relPath.lastIndexOf(path.sep));
    assert.equal(dirRel.split(path.sep).join('/'), `${GID}/3D衣装/9038753 奥の手 -OkunoTe-`.normalize('NFC'));
    assert.equal(fs.existsSync(path.join(rootDir, result.relPath)), true);
    const meta = JSON.parse(fs.readFileSync(path.join(rootDir, result.metaRel), 'utf8'));
    assert.equal(meta.boothId, '9038753');
    assert.equal(meta.shop, 'ZigZag');
    assert.equal(meta.price, '290-490 JPY');
    assert.equal(meta.thumbPath, result.thumbRel);
    assert.equal(fs.readFileSync(path.join(rootDir, result.thumbRel), 'utf8'), 'thumb');
    const row = listArchive(db, { limit: 10 })[0];
    assert.equal(row.boothId, '9038753');
    assert.equal(row.categorySource, 'booth');
    assert.equal(row.enrichStatus, 'ok');
    assert.match(row.thumbRel, /thumbnail\.jpg$/);
  } finally { cleanup(rootDir); }
});

await check('enrich：同 BOOTH 号再次转存 → 并入同一目录，不新建', async () => {
  const { db, rootDir } = fresh();
  const meta = {
    status: 'ok', title: 'T', shop: 'S', price: '100 JPY', tags: [], thumbnailUrl: '',
    itemUrl: '', category: '衣装', error: ''
  };
  const deps = { fetchBoothMeta: async () => meta, downloadThumb: async () => true };
  try {
    const first = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 'a', fileName: '9038753 商品A.zip',
      buffer: Buffer.from('a'), archivedAt: T0, source: 'chat', baseDirRel: archiveDirRel({ groupId: GID })
    });
    await enrichArchiveItem({ db, rootDir, id: first.id, cfg: { booth: { enabled: true }, retention: null }, deps, nowMs: T0 });
    const second = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 'b', fileName: '9038753 商品B.zip',
      buffer: Buffer.from('b'), archivedAt: T0 + 1, source: 'chat', baseDirRel: archiveDirRel({ groupId: GID })
    });
    const result = await enrichArchiveItem({ db, rootDir, id: second.id, cfg: { booth: { enabled: true }, retention: null }, deps, nowMs: T0 + 1 });
    const dirA = path.dirname(listArchive(db, { limit: 10 }).find((r) => r.id === first.id).relPath);
    const dirB = path.dirname(result.relPath);
    assert.equal(dirB, dirA, '同 BOOTH 号必须并入同一目录');
    assert.equal(fs.readdirSync(path.join(rootDir, dirA)).filter((f) => f.endsWith('.zip')).length, 2);
  } finally { cleanup(rootDir); }
});

await check('人工分类优先：manual 后重跑 enrich 不改分类、不挪文件', async () => {
  const { db, rootDir } = fresh();
  try {
    const stored = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 'm', fileName: '9038753 商品.zip',
      buffer: Buffer.from('m'), archivedAt: T0, source: 'chat', baseDirRel: archiveDirRel({ groupId: GID })
    });
    setArchiveCategory(db, { id: stored.id, category: '手工分类', source: 'manual', retention: null });
    const result = await enrichArchiveItem({
      db, rootDir, id: stored.id,
      cfg: { booth: { enabled: true }, retention: null },
      deps: { fetchBoothMeta: async () => ({ status: 'ok', title: 'T', category: '页面分类', tags: [], thumbnailUrl: '', itemUrl: '', shop: '', price: '', error: '' }) },
      nowMs: T0 + 10
    });
    const row = listArchive(db, { limit: 10 }).find((r) => r.id === stored.id);
    assert.equal(row.category, '手工分类', 'manual 分类不能被 BOOTH 页面分类覆盖');
    assert.equal(row.categorySource, 'manual');
    assert.equal(row.relPath, stored.relPath, 'manual 分类后不能自动挪文件');
    assert.equal(result.category, '手工分类');
    assert.equal(row.boothId, '9038753', 'BOOTH 元数据仍然要补上');
  } finally { cleanup(rootDir); }
});

await check('无 BOOTH 号 → 未分类目录（不抓元数据）', async () => {
  const { db, rootDir } = fresh();
  try {
    const stored = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 'n', fileName: '普通文件.zip',
      buffer: Buffer.from('n'), archivedAt: T0, source: 'chat', baseDirRel: archiveDirRel({ groupId: GID })
    });
    let called = 0;
    const result = await enrichArchiveItem({
      db, rootDir, id: stored.id, cfg: { booth: { enabled: true }, retention: null },
      deps: { fetchBoothMeta: async () => { called += 1; return { status: 'ok' }; } }
    });
    assert.equal(result.skipped, true);
    assert.equal(called, 0, '没有编号就不该发 BOOTH 请求');
    assert.equal(stored.relPath.split(path.sep)[1], '未分类');
  } finally { cleanup(rootDir); }
});

console.log('\n## 迁移 / 回填 / 导出 / 清理');
await check('迁移幂等：老库补列，跑两次数据不丢', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE file_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, file_id TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL, stored_name TEXT NOT NULL, rel_path TEXT NOT NULL UNIQUE,
    bytes INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT '',
    message_id TEXT NOT NULL DEFAULT '', uploader TEXT NOT NULL DEFAULT '',
    uploaded_at INTEGER NOT NULL DEFAULT 0, archived_at INTEGER NOT NULL,
    category TEXT NOT NULL DEFAULT '', category_source TEXT NOT NULL DEFAULT '',
    cleanup_at INTEGER NOT NULL, deleted_at INTEGER, delete_reason TEXT NOT NULL DEFAULT ''
  )`);
  db.prepare(`INSERT INTO file_archive (group_id, file_name, stored_name, rel_path, archived_at, cleanup_at)
    VALUES ('1','9038753 a.zip','9038753 a.zip','1/2026-01/9038753 a.zip', 1, 2)`).run();
  ensureFileLedger(db);
  ensureFileLedger(db);
  const cols = db.prepare('PRAGMA table_info(file_archive)').all().map((c) => c.name);
  for (const name of ['booth_id', 'booth_url', 'booth_title', 'booth_shop', 'booth_price', 'booth_tags', 'thumb_rel', 'meta_rel', 'enrich_status', 'enrich_error', 'enriched_at']) {
    assert.equal(cols.includes(name), true, `应补列 ${name}`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM file_archive').get().c, 1);
});
await check('backfillBoothColumns：按文件名回填，幂等', () => {
  const db = new DatabaseSync(':memory:');
  ensureFileLedger(db);
  db.prepare(`INSERT INTO file_archive (group_id, file_name, stored_name, rel_path, archived_at, cleanup_at)
    VALUES (?,?,?,?,?,?)`).run(GID, '9038753 商品.zip', 'x.zip', `${GID}/未分类/x.zip`, T0, T0 + 1);
  db.prepare(`INSERT INTO file_archive (group_id, file_name, stored_name, rel_path, archived_at, cleanup_at)
    VALUES (?,?,?,?,?,?)`).run(GID, 'R-18.zip', 'y.zip', `${GID}/未分类/y.zip`, T0, T0 + 1);
  const first = backfillBoothColumns(db);
  assert.deepEqual(first, { scanned: 2, updated: 1 });
  const second = backfillBoothColumns(db);
  assert.deepEqual(second, { scanned: 1, updated: 0 }, '已回填的不再处理');
  const row = db.prepare("SELECT booth_id, booth_url FROM file_archive WHERE file_name = '9038753 商品.zip'").get();
  assert.equal(row.booth_id, '9038753');
  assert.match(row.booth_url, /items\/9038753$/);
});
await check('export：JSON 行带 tags 数组；CSV 有表头且转义引号', () => {
  const db = new DatabaseSync(':memory:');
  ensureFileLedger(db);
  db.prepare(`INSERT INTO file_archive (group_id, file_name, stored_name, rel_path, archived_at, cleanup_at, booth_id, booth_title, booth_tags, category)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(GID, '9038753 "带引号".zip', 'x.zip', `${GID}/衣装/x.zip`, T0, T0, '9038753', 'T', '衣装|3D', '衣装');
  const rows = exportArchiveRows(db);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].tags, ['衣装', '3D']);
  const csv = archiveRowsToCsv(rows);
  assert.match(csv.split('\r\n')[0], /boothId/);
  assert.match(csv, /""带引号""/);
});
await check('清理：删文件 + meta/缩略图，并删空目录', () => {
  const { db, rootDir } = fresh();
  try {
    const dirRel = path.join(GID, '衣装', '9038753 商品');
    const absDir = path.join(rootDir, dirRel);
    fs.mkdirSync(absDir, { recursive: true });
    const fileName = 'a.zip';
    // 不预写 a.zip：让 storeArchivedFile 自己落盘（预写会让它改名成 `a (1).zip`）。
    const stored = storeArchivedFile({ db, rootDir, groupId: GID, fileId: 'c', fileName, buffer: Buffer.from('x'), archivedAt: T0, source: 'chat', baseDirRel: dirRel });
    fs.writeFileSync(path.join(absDir, 'meta.json'), '{}');
    fs.writeFileSync(path.join(absDir, 'thumbnail.jpg'), 't');
    db.prepare('UPDATE file_archive SET cleanup_at = ?, meta_rel = ?, thumb_rel = ? WHERE id = ?')
      .run(T0 - 1, path.join(dirRel, 'meta.json'), path.join(dirRel, 'thumbnail.jpg'), stored.id);
    const result = runArchiveCleanup({ db, rootDir, nowMs: T0 });
    assert.equal(result.deleted, 1);
    assert.equal(fs.existsSync(path.join(absDir, fileName)), false);
    assert.equal(fs.existsSync(path.join(absDir, 'meta.json')), false);
    assert.equal(fs.existsSync(absDir), false, '空商品目录也要删掉');
  } finally { cleanup(rootDir); }
});

await check('抓取失败（404/年龄墙）不搬家：只记状态，文件留在原处、不产生商品目录', async () => {
  const { db, rootDir } = fresh();
  try {
    const stored = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 'x', fileName: '9013048.zip',
      buffer: Buffer.from('x'), archivedAt: T0, source: 'chat', baseDirRel: archiveDirRel({ groupId: GID })
    });
    const notFound = await enrichArchiveItem({
      db, rootDir, id: stored.id, cfg: { booth: { enabled: true }, retention: null },
      deps: { fetchBoothMeta: async () => ({ status: 'not_found', error: '商品不存在（HTTP 404）' }) },
      nowMs: T0
    });
    assert.equal(notFound.status, 'not_found');
    assert.equal(notFound.relPath, stored.relPath, '404 不能搬文件');
    assert.equal(fs.existsSync(path.join(rootDir, stored.relPath)), true);
    assert.equal(fs.existsSync(path.join(rootDir, path.dirname(stored.relPath), 'meta.json')), false, '404 不写 meta');
    const row = listArchive(db, { limit: 10 })[0];
    assert.equal(row.enrichStatus, 'not_found');
    assert.match(row.enrichError, /404/);

    // 年龄墙：不搬家，但尽量写 og 信息（meta + 缩略图）
    const gated = await enrichArchiveItem({
      db, rootDir, id: stored.id, cfg: { booth: { enabled: true }, retention: null },
      deps: {
        fetchBoothMeta: async () => ({ status: 'gated', title: 'G', thumbnailUrl: 'https://x/t.jpg', tags: [], shop: '', price: '', itemUrl: '', category: '', error: '' }),
        downloadThumb: async (url, destAbs) => { fs.writeFileSync(destAbs, 't'); return true; }
      },
      nowMs: T0 + 1
    });
    assert.equal(gated.status, 'gated');
    assert.equal(gated.relPath, stored.relPath, '年龄墙也不能搬文件');
    assert.equal(fs.existsSync(path.join(rootDir, path.dirname(stored.relPath), 'meta.json')), true);
  } finally { cleanup(rootDir); }
});

console.log(`\n========== 通过 ${passed} / 失败 ${failed} ==========`);
process.exit(failed === 0 ? 0 : 1);
