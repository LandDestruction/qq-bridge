// file-archive/db.js — SQLite 台账（建表/迁移/增删查/导出/去重）+ 扫描索引
// 纯搬运自 src/file-archive.js（D61 拆分）：函数体/注释逐字保留，只做模块化与 import/export。

import fs from 'node:fs';
import path from 'node:path';
import { parseBoothName } from '../booth-meta.js';

import { RULES_STATE_FILE, RULES_VERSIONS, cleanupDeadline, contentKeyFor, formatRulesVersion, isStaleRulesVersion } from './common.js';
import { allocateStoredName, archiveRelPath, safeResolveInside, writeFileAtomicSync } from './paths.js';

// ── 台账（SQLite） ─────────────────────────────────────────────────────────

const LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS file_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  file_id TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  rel_path TEXT NOT NULL UNIQUE,
  bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  uploader TEXT NOT NULL DEFAULT '',
  uploaded_at INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  category_source TEXT NOT NULL DEFAULT '',
  cleanup_at INTEGER NOT NULL,
  deleted_at INTEGER,
  delete_reason TEXT NOT NULL DEFAULT '',
  -- 转存来源：notice = 群文件上传事件；chat = 聊天消息里的 file 段（两代 QQ 客户端行为不同，
  -- 排查「为什么没存」时第一眼看这一列）。
  source TEXT NOT NULL DEFAULT '',
  -- BOOTH 元数据（konoasset 风格的「每个商品一条记录」）：BOOTH 号从原文件名解析。
  booth_id TEXT NOT NULL DEFAULT '',
  booth_url TEXT NOT NULL DEFAULT '',
  booth_title TEXT NOT NULL DEFAULT '',
  booth_shop TEXT NOT NULL DEFAULT '',
  booth_price TEXT NOT NULL DEFAULT '',
  -- 标签用竖线连接（SQLite 没有数组；导出 JSON 时再 split）。
  booth_tags TEXT NOT NULL DEFAULT '',
  thumb_rel TEXT NOT NULL DEFAULT '',
  meta_rel TEXT NOT NULL DEFAULT '',
  enrich_status TEXT NOT NULL DEFAULT '',
  enrich_error TEXT NOT NULL DEFAULT '',
  enriched_at INTEGER NOT NULL DEFAULT 0,
  -- P0：稳定内容标识（改名/移动后仍认得出同一件）与规则版本（改规则 → 旧结论自动重算）
  content_key TEXT NOT NULL DEFAULT '',
  rules_ver TEXT NOT NULL DEFAULT '',
  -- P1：进回收站后的相对路径（恢复时按它找 info/文件）
  recycle_rel TEXT NOT NULL DEFAULT ''
)`;

const LEDGER_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_file_archive_group ON file_archive(group_id, archived_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_file_archive_due ON file_archive(cleanup_at) WHERE deleted_at IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_file_archive_sha ON file_archive(sha256)',
  "CREATE INDEX IF NOT EXISTS idx_file_archive_ckey ON file_archive(content_key) WHERE content_key <> ''",
  "CREATE INDEX IF NOT EXISTS idx_file_archive_booth ON file_archive(group_id, booth_id) WHERE booth_id <> ''"
];

/** 后加的列：旧库不会自动长出新列，只能在 ensureFileLedger 里逐列 ALTER（幂等、不动数据）。 */
const LEDGER_OPTIONAL_COLUMNS = [
  ['source', "TEXT NOT NULL DEFAULT ''"],
  ['booth_id', "TEXT NOT NULL DEFAULT ''"],
  ['booth_url', "TEXT NOT NULL DEFAULT ''"],
  ['booth_title', "TEXT NOT NULL DEFAULT ''"],
  ['booth_shop', "TEXT NOT NULL DEFAULT ''"],
  ['booth_price', "TEXT NOT NULL DEFAULT ''"],
  ['booth_tags', "TEXT NOT NULL DEFAULT ''"],
  ['thumb_rel', "TEXT NOT NULL DEFAULT ''"],
  ['meta_rel', "TEXT NOT NULL DEFAULT ''"],
  ['enrich_status', "TEXT NOT NULL DEFAULT ''"],
  ['enrich_error', "TEXT NOT NULL DEFAULT ''"],
  ['thumb_status', "TEXT NOT NULL DEFAULT ''"],
  ['enriched_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['content_key', "TEXT NOT NULL DEFAULT ''"],
  ['rules_ver', "TEXT NOT NULL DEFAULT ''"],
  ['recycle_rel', "TEXT NOT NULL DEFAULT ''"]
];

// ── BOOTH 元数据增强（抓商品信息 + 归类落目录 + meta.json/缩略图） ──────────

const ENRICH_COLUMNS = {
  boothId: 'booth_id',
  boothUrl: 'booth_url',
  boothTitle: 'booth_title',
  boothShop: 'booth_shop',
  boothPrice: 'booth_price',
  boothTags: 'booth_tags',
  thumbRel: 'thumb_rel',
  metaRel: 'meta_rel',
  enrichStatus: 'enrich_status',
  enrichError: 'enrich_error',
  thumbStatus: 'thumb_status',
  enrichedAt: 'enriched_at',
  relPath: 'rel_path',
  storedName: 'stored_name',
  category: 'category',
  categorySource: 'category_source',
  cleanupAt: 'cleanup_at'
};

/** 建表（幂等）。db 传 `node:sqlite` 的 DatabaseSync 实例。 */
export function ensureFileLedger(db) {
  if (!db || typeof db.exec !== 'function') throw new Error('ensureFileLedger 需要一个已打开的 SQLite 连接');
  db.exec(LEDGER_SQL);
  try {
    const cols = db.prepare('PRAGMA table_info(file_archive)').all().map((c) => String(c.name));
    for (const [name, ddl] of LEDGER_OPTIONAL_COLUMNS) {
      if (!cols.includes(name)) db.exec(`ALTER TABLE file_archive ADD COLUMN ${name} ${ddl}`);
    }
  } catch {}
  for (const sql of LEDGER_INDEXES) db.exec(sql);
  // 幂等回填：旧库刚长出 content_key / rules_ver 列时补上值（纯 UPDATE，不删不改别的列）。
  // 放在 try 里：回填失败不该让整个台账初始化失败。
  try { backfillContentKeys(db); } catch {}
  try { stampRuleVersions(db); } catch {}
  return true;
}

/** 给还没有 content_key 的行补上（幂等；返回 {scanned, updated}）。 */
export function backfillContentKeys(db, { limit = 10000 } = {}) {
  const cap = Math.min(200000, Math.max(1, Number(limit) || 10000));
  const rows = db.prepare("SELECT id, file_name, bytes FROM file_archive WHERE content_key = '' LIMIT ?").all(cap);
  const update = db.prepare("UPDATE file_archive SET content_key = ? WHERE id = ? AND content_key = ''");
  let updated = 0;
  for (const row of rows) {
    const key = contentKeyFor(row.file_name, row.bytes);
    if (key && update.run(key, Number(row.id)).changes) updated += 1;
  }
  return { scanned: rows.length, updated };
}

/** 给还没有规则版本的行盖上当前版本（幂等；返回更新行数）。
 *  注意：不能写 `UPDATE … LIMIT`——node:sqlite 的 SQLite 没开 UPDATE_DELETE_LIMIT，会语法报错。
 *  所以先 SELECT id 再逐行 UPDATE（行数本来就只有台账规模）。 */
export function stampRuleVersions(db, { versions = RULES_VERSIONS, limit = 200000 } = {}) {
  const cap = Math.min(500000, Math.max(1, Number(limit) || 200000));
  const stamp = formatRulesVersion(versions);
  const rows = db.prepare("SELECT id FROM file_archive WHERE rules_ver = '' LIMIT ?").all(cap);
  const update = db.prepare("UPDATE file_archive SET rules_ver = ? WHERE id = ? AND rules_ver = ''");
  let updated = 0;
  for (const row of rows) {
    if (update.run(stamp, Number(row.id)).changes) updated += 1;
  }
  return updated;
}

/** 有多少行的结论是按旧规则算的（= 版本变了需要重算的量）。 */
export function countStaleRuleRows(db, { versions = RULES_VERSIONS } = {}) {
  const rows = db.prepare('SELECT rules_ver FROM file_archive WHERE deleted_at IS NULL').all();
  return rows.filter((r) => isStaleRulesVersion(r.rules_ver, versions)).length;
}

/**
 * 规则版本对账：把当前版本写进 state/ 并返回"这次要不要重算"。
 * `skippedOldConclusions` 就是控制台那句「本次跳过 N 条旧结论」里的 N。
 * @returns {{versions:object, stored:boolean, changed:boolean, staleRows:number, skippedOldConclusions:number, previous:object}}
 */
export function reconcileRuleVersions(db, { stateDir = '', versions = RULES_VERSIONS, nowMs = Date.now() } = {}) {
  const previous = stateDir ? readRuleVersions(stateDir) : {};
  const changed = ['identify', 'category', 'booth'].some((k) => (Number(previous?.[k]) || 0) !== (Number(versions[k]) || 0));
  let stored = false;
  if (stateDir) stored = writeRuleVersions(stateDir, versions, { nowMs });
  const staleRows = countStaleRuleRows(db, { versions });
  return { versions, previous, changed, stored, staleRows, skippedOldConclusions: staleRows };
}

/** 读 state/ 里的规则版本（没有/坏掉都返回 {}，不抛）。 */
export function readRuleVersions(stateDir) {
  try {
    const file = path.join(path.resolve(String(stateDir)), RULES_STATE_FILE);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { identify: Number(raw?.identify) || 0, category: Number(raw?.category) || 0, booth: Number(raw?.booth) || 0 };
  } catch { return {}; }
}

/** 原子写 state/ 里的规则版本。 */
export function writeRuleVersions(stateDir, versions = RULES_VERSIONS, { nowMs = Date.now() } = {}) {
  const dir = path.resolve(String(stateDir));
  const payload = {
    identify: Number(versions.identify) || 0,
    category: Number(versions.category) || 0,
    booth: Number(versions.booth) || 0,
    updatedAt: new Date(Number(nowMs) || Date.now()).toISOString()
  };
  writeFileAtomicSync(path.join(dir, RULES_STATE_FILE), `${JSON.stringify(payload, null, 1)}\n`);
  return true;
}

/**
 * 「全部重来」按钮的后端动作：清掉所有行的规则版本戳，下一次对账就会把它们全判成旧结论。
 * 只动 rules_ver 一列，不动文件、不动其它列。
 * @returns {{cleared:number}}
 */
export function resetRuleVersions(db) {
  const info = db.prepare("UPDATE file_archive SET rules_ver = '' WHERE rules_ver <> ''").run();
  return { cleared: Number(info?.changes) || 0 };
}

/**
 * 写入一条转存记录。rel_path 唯一：同路径已存在（重复事件/重试）时返回既有 id，不产生重复行。
 * @returns {{id:number, inserted:boolean}}
 */
export function insertArchiveRecord(db, record) {
  const rel = String(record.relPath ?? '');
  if (!rel) throw new Error('insertArchiveRecord 缺少 relPath');
  const existing = db.prepare('SELECT id FROM file_archive WHERE rel_path = ?').get(rel);
  if (existing) return { id: Number(existing.id), inserted: false };
  const archivedAt = Number(record.archivedAt) || Date.now();
  const category = String(record.category ?? '');
  const info = db.prepare(`
    INSERT INTO file_archive (group_id, file_id, file_name, stored_name, rel_path, bytes, sha256,
      message_id, uploader, uploaded_at, archived_at, category, category_source, cleanup_at, source,
      content_key, rules_ver)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(record.groupId ?? ''),
    String(record.fileId ?? ''),
    String(record.fileName ?? ''),
    String(record.storedName ?? ''),
    rel,
    Number(record.bytes) || 0,
    String(record.sha256 ?? ''),
    String(record.messageId ?? ''),
    String(record.uploader ?? ''),
    Number(record.uploadedAt) || 0,
    archivedAt,
    category,
    String(record.categorySource ?? ''),
    Number(record.cleanupAt) || cleanupDeadline(archivedAt, category, record.retention),
    String(record.source ?? ''),
    // contentKey 优先用调用方给的（下载前就知道文件名与大小），否则按台账字段现算；
    // rules_ver 记录这行结论按哪一版规则算出（改规则后靠它找出旧结论）。
    String(record.contentKey ?? '') || contentKeyFor(record.fileName, record.bytes),
    String(record.rulesVer ?? '') || formatRulesVersion()
  );
  return { id: Number(info.lastInsertRowid), inserted: true };
}

/** 台账里是否已有该群该文件的**有效**记录（已清理的不算，允许清理后重新转存）。 */
export function findActiveArchive(db, { groupId, fileId }) {
  const fid = String(fileId ?? '').trim();
  if (!db || !fid) return null;
  const row = db.prepare('SELECT id FROM file_archive WHERE group_id = ? AND file_id = ? AND deleted_at IS NULL LIMIT 1')
    .get(String(groupId ?? ''), fid);
  return row ? Number(row.id) : null;
}

/** 按 sha256 找同群已转存的有效记录（图片按内容去重：同一张图连发两次只存一份）。 */
export function findActiveArchiveBySha(db, { groupId, sha256 }) {
  const sha = String(sha256 ?? '').trim().toLowerCase();
  if (!db || !/^[0-9a-f]{64}$/.test(sha)) return null;
  const row = db.prepare('SELECT id FROM file_archive WHERE group_id = ? AND sha256 = ? AND deleted_at IS NULL LIMIT 1')
    .get(String(groupId ?? ''), sha);
  return row ? Number(row.id) : null;
}

/**
 * 先占好目标位置（目录 + 不重复的文件名 + 临时路径），再决定怎么把字节放进去。
 * 大文件转存必须走这条：下载前就要知道临时文件写到哪、最终叫什么（2.5GB 不能读进内存）。
 * @param {string} [baseDirRel] 目标目录（相对转存根）；不传则用老布局 `<群号>/<YYYY-MM>/`
 * @returns {{monthRel:string,monthAbs:string,storedName:string,relPath:string,absPath:string,tmpPath:string}}
 */
export function allocateArchiveTarget({ db, rootDir, groupId, archivedAt = Date.now(), fileName = 'file', baseDirRel = '' } = {}) {
  if (!db) throw new Error('allocateArchiveTarget 需要已打开的台账连接');
  const when = Number(archivedAt) || Date.now();
  const monthRel = baseDirRel
    ? String(baseDirRel)
    : path.dirname(archiveRelPath(groupId, when, fileName || 'file'));
  const monthAbs = safeResolveInside(rootDir, monthRel);
  fs.mkdirSync(monthAbs, { recursive: true });
  const storedName = allocateStoredName(fileName || 'file', (candidate) => {
    const rel = path.join(monthRel, candidate);
    if (fs.existsSync(path.join(monthAbs, candidate))) return true;
    return Boolean(db.prepare('SELECT 1 FROM file_archive WHERE rel_path = ?').get(rel));
  });
  const relPath = path.join(monthRel, storedName);
  const absPath = safeResolveInside(rootDir, relPath);
  return { monthRel, monthAbs, storedName, relPath, absPath, tmpPath: `${absPath}.tmp-${process.pid}-${when}` };
}

/** 更新一行的增强结果（只改传入的字段）。 */
export function updateArchiveEnrichment(db, id, patch = {}) {
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(ENRICH_COLUMNS)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(patch[key]);
  }
  if (!sets.length) return false;
  params.push(Number(id));
  db.prepare(`UPDATE file_archive SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return true;
}

/** 需要（重新）抓元数据的行：有 BOOTH 号、未删除、且还没成功抓过（或失败超过 1 天）。 */
export function rowsNeedingEnrichment(db, { limit = 20, nowMs = Date.now() } = {}) {
  const cap = Math.min(500, Math.max(1, Number(limit) || 20));
  return db.prepare(`
    SELECT * FROM file_archive
    WHERE deleted_at IS NULL AND booth_id <> ''
      AND (enriched_at = 0 OR (enrich_status IN ('error', 'failed', 'blocked') AND enriched_at < ?))
    ORDER BY id ASC LIMIT ?
  `).all(Number(nowMs) - 86400000, cap).map(mapArchiveRow);
}

/** 存量行按文件名反解 BOOTH 号并回填（幂等；不移动文件，避免破坏老的日期目录）。 */
export function backfillBoothColumns(db, { limit = 2000, parse = parseBoothName } = {}) {
  const rows = db.prepare("SELECT id, file_name FROM file_archive WHERE deleted_at IS NULL AND booth_id = '' LIMIT ?")
    .all(Math.min(10000, Math.max(1, Number(limit) || 2000)));
  const update = db.prepare('UPDATE file_archive SET booth_id = ?, booth_url = ? WHERE id = ? AND booth_id = ?');
  let updated = 0;
  for (const row of rows) {
    const parsed = parse(String(row.file_name ?? ''));
    if (!parsed?.boothId) continue;
    const changes = update.run(parsed.boothId, `https://booth.pm/zh-cn/items/${parsed.boothId}`, Number(row.id), '').changes;
    if (changes) updated += 1;
  }
  return { scanned: rows.length, updated };
}

/** 台账查询（控制台列表用）。 */
export function listArchive(db, { groupId = '', limit = 100, offset = 0, includeDeleted = false } = {}) {
  const cap = Math.min(1000, Math.max(1, Number(limit) || 100));
  const skip = Math.max(0, Number(offset) || 0);
  const where = [];
  const params = [];
  if (groupId) { where.push('group_id = ?'); params.push(String(groupId)); }
  if (!includeDeleted) where.push('deleted_at IS NULL');
  const sql = `SELECT * FROM file_archive ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY archived_at DESC LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...params, cap, skip).map(mapArchiveRow);
}

/** 台账总条数（与 listArchive 同口径的过滤条件），供控制台显示「共 N 条」。 */
export function countArchive(db, { groupId = '', includeDeleted = false } = {}) {
  const where = [];
  const params = [];
  if (groupId) { where.push('group_id = ?'); params.push(String(groupId)); }
  if (!includeDeleted) where.push('deleted_at IS NULL');
  const sql = `SELECT COUNT(*) AS n FROM file_archive ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  return Number(db.prepare(sql).get(...params)?.n || 0);
}

/** 到期未删的记录（清理任务的输入）。 */
export function dueArchiveRecords(db, nowMs = Date.now()) {
  return db.prepare('SELECT * FROM file_archive WHERE deleted_at IS NULL AND cleanup_at <= ? ORDER BY cleanup_at ASC')
    .all(Number(nowMs) || Date.now())
    .map(mapArchiveRow);
}

export function mapArchiveRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    groupId: String(row.group_id ?? ''),
    fileId: String(row.file_id ?? ''),
    fileName: String(row.file_name ?? ''),
    storedName: String(row.stored_name ?? ''),
    relPath: String(row.rel_path ?? ''),
    bytes: Number(row.bytes) || 0,
    sha256: String(row.sha256 ?? ''),
    messageId: String(row.message_id ?? ''),
    uploader: String(row.uploader ?? ''),
    uploadedAt: Number(row.uploaded_at) || 0,
    archivedAt: Number(row.archived_at) || 0,
    category: String(row.category ?? ''),
    categorySource: String(row.category_source ?? ''),
    cleanupAt: Number(row.cleanup_at) || 0,
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
    deleteReason: String(row.delete_reason ?? ''),
    source: String(row.source ?? ''),
    boothId: String(row.booth_id ?? ''),
    boothUrl: String(row.booth_url ?? ''),
    boothTitle: String(row.booth_title ?? ''),
    boothShop: String(row.booth_shop ?? ''),
    boothPrice: String(row.booth_price ?? ''),
    boothTags: String(row.booth_tags ?? ''),
    thumbRel: String(row.thumb_rel ?? ''),
    metaRel: String(row.meta_rel ?? ''),
    enrichStatus: String(row.enrich_status ?? ''),
    thumbStatus: String(row.thumb_status ?? ''),
    enrichError: String(row.enrich_error ?? ''),
    enrichedAt: Number(row.enriched_at) || 0,
    contentKey: String(row.content_key ?? ''),
    rulesVer: String(row.rules_ver ?? ''),
    recycleRel: String(row.recycle_rel ?? '')
  };
}

/** 导出（konoasset 风格外部索引）：JSON 或 CSV。 */
export function exportArchiveRows(db, { groupId = '', includeDeleted = false } = {}) {
  const where = [];
  const params = [];
  if (groupId) { where.push('group_id = ?'); params.push(String(groupId)); }
  if (!includeDeleted) where.push('deleted_at IS NULL');
  const sql = `SELECT * FROM file_archive ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY archived_at DESC`;
  return db.prepare(sql).all(...params).map(mapArchiveRow).map((row) => ({
    id: row.id,
    boothId: row.boothId,
    title: row.boothTitle,
    shop: row.boothShop,
    price: row.boothPrice,
    tags: row.boothTags ? row.boothTags.split('|').filter(Boolean) : [],
    boothUrl: row.boothUrl,
    fileName: row.fileName,
    relPath: row.relPath,
    bytes: row.bytes,
    groupId: row.groupId,
    category: row.category,
    archivedAt: row.archivedAt,
    cleanupAt: row.cleanupAt,
    thumbRel: row.thumbRel,
    source: row.source
  }));
}

export function archiveRowsToCsv(rows) {
  const header = ['id', 'boothId', 'title', 'shop', 'price', 'tags', 'boothUrl', 'fileName', 'relPath', 'bytes', 'groupId', 'category', 'archivedAt', 'cleanupAt', 'thumbRel'];
  const esc = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map((key) => {
      if (key === 'tags') return esc(Array.isArray(row.tags) ? row.tags.join('|') : row.tags);
      return esc(row[key]);
    }).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ── 重复判定 / 缩略图信号量 / mtime 增量刷新（P1 的维护三件套） ──────────────
// 规格 §3-P1-8/9/10：同名同大小算重复（压缩包与其解压目录各算一件，不互相合并）；
// 缩略图并发上限 2 + 超大跳过；靠目录 mtime 判断有没有变化，没变化不重扫。

/** 同名同大小的稳定分组键（小写名 + 字节数；与 contentKey 不同：这个只用于"看起来一样"）。 */
export function duplicateKeyFor(fileName, bytes) {
  return `${String(fileName ?? '').trim().toLowerCase()}\u0000${Math.max(0, Math.trunc(Number(bytes) || 0))}`;
}

/**
 * 找出重复组（同一 key 有 ≥2 条有效记录）。
 * 注意：`9013048.zip` 与解压目录 `9013048/` 里的文件**名字不同**，不会被合并——规格要求各算一件。
 * @param {Array} rows mapArchiveRow 形状的行
 * @returns {Array<{key:string,fileName:string,bytes:number,ids:number[],relPaths:string[]}>}
 */
export function findDuplicateGroups(rows, { includeDeleted = false } = {}) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    if (!includeDeleted && row.deletedAt) continue;
    const key = duplicateKeyFor(row.fileName, row.bytes);
    if (!groups.has(key)) groups.set(key, { key, fileName: row.fileName, bytes: row.bytes, ids: [], relPaths: [] });
    const g = groups.get(key);
    g.ids.push(Number(row.id));
    g.relPaths.push(String(row.relPath || ''));
  }
  return [...groups.values()].filter((g) => g.ids.length > 1).sort((a, b) => b.ids.length - a.ids.length);
}

/** 从台账直接扫重复（只读；不移动不删除，处置由人工决定）。 */
export function scanArchiveDuplicates(db, { groupId = '', limit = 5000 } = {}) {
  const cap = Math.min(20000, Math.max(1, Number(limit) || 5000));
  const sql = `SELECT * FROM file_archive WHERE deleted_at IS NULL ${groupId ? 'AND group_id = ?' : ''} ORDER BY id LIMIT ?`;
  const rows = (groupId ? db.prepare(sql).all(String(groupId), cap) : db.prepare(sql).all(cap)).map(mapArchiveRow);
  const groups = findDuplicateGroups(rows);
  return { scanned: rows.length, groups, duplicates: groups.reduce((n, g) => n + g.ids.length - 1, 0) };
}

// ── mtime 增量刷新：目录没变就不重扫 ────────────────────────────────────────
export const SCAN_INDEX_FILE = 'file-archive-scan.json';

/**
 * 给转存根下的目录建 mtime 索引（只读目录元数据，不读文件内容）。
 * @returns {{version:number, generatedAt:number, dirs:Object<string,{mtimeMs:number,count:number}>}}
 */
export function indexDirMtimes(rootDir, { maxDepth = 6, maxDirs = 5000 } = {}) {
  const root = path.resolve(String(rootDir));
  const dirs = {};
  let visited = 0;
  const walk = (abs, rel, depth) => {
    if (depth > maxDepth || visited >= maxDirs) return;
    let st;
    try { st = fs.statSync(abs); } catch { return; }
    if (!st.isDirectory()) return;
    visited += 1;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    dirs[rel] = { mtimeMs: Math.round(Number(st.mtimeMs) || 0), count: entries.length };
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      walk(path.join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  walk(root, '', 0);
  return { version: 1, generatedAt: Date.now(), dirs };
}

/** 比较两次索引：新增/消失/变化的目录（只比 mtime 与条目数，不比内容）。 */
export function diffDirMtimes(prev, next) {
  const a = prev?.dirs && typeof prev.dirs === 'object' ? prev.dirs : {};
  const b = next?.dirs && typeof next.dirs === 'object' ? next.dirs : {};
  const added = [];
  const removed = [];
  const changed = [];
  for (const rel of Object.keys(b)) {
    if (!(rel in a)) { added.push(rel); continue; }
    if (Number(a[rel].mtimeMs) !== Number(b[rel].mtimeMs) || Number(a[rel].count) !== Number(b[rel].count)) changed.push(rel);
  }
  for (const rel of Object.keys(a)) if (!(rel in b)) removed.push(rel);
  return { added, removed, changed, hasChanges: added.length + removed.length + changed.length > 0 };
}

/** 需不需要重扫（没有变化就是 false —— 省掉整库遍历）。 */
export function shouldRescan(prev, next) {
  return diffDirMtimes(prev, next).hasChanges;
}

/** 读 state/ 里的扫描索引（没有/坏掉返回 null）。 */
export function readScanIndex(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(path.resolve(String(stateDir)), SCAN_INDEX_FILE), 'utf8'));
    return raw && typeof raw === 'object' && raw.dirs ? raw : null;
  } catch { return null; }
}

/** 原子写扫描索引。 */
export function writeScanIndex(stateDir, index) {
  const dir = path.resolve(String(stateDir));
  writeFileAtomicSync(path.join(dir, SCAN_INDEX_FILE), `${JSON.stringify(index, null, 1)}\n`);
  return true;
}
