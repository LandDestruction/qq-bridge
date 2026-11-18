// file-archive/cleanup.js — 清理与统计（到期清理 / 台账汇总 / 列表查询与排序）
// 纯搬运自 src/file-archive.js（D61 拆分）：函数体/注释逐字保留，只做模块化与 import/export。

import fs from 'node:fs';

import { RULES_VERSIONS, formatBytes, retentionDaysFor } from './common.js';
import { fileOpsMu, safeResolveInside } from './paths.js';
import { countStaleRuleRows, dueArchiveRecords } from './db.js';
import { pruneEmptyDirs } from './storage.js';

// ── 清理 ──────────────────────────────────────────────────────────────────

/**
 * 执行一次清理。**只删台账里我们自己转存的文件**，且路径必须落在 rootDir 内。
 * 文件已不在（被人手工删/盘坏了）也把台账标成 deleted（reason=missing），避免每轮重复处理。
 *
 * dryRun=true 时**一个字节都不写**：不 rm、不 prune 空目录、不 UPDATE 台账，只把「真跑会被删的
 * 条目」算出来返回，供「先预览再执行」复核。用户要的就是这个——预览本身就是防误删的抓手，
 * 如果预览顺手写了盘，用户看到的清单和真正要删的集合就不再是同一时刻的快照。
 *
 * @param {{db:any, rootDir:string, nowMs?:number, dryRun?:boolean,
 *          removeFile?:(abs:string)=>void, exists?:(abs:string)=>boolean, log?:(msg:string)=>void}} opts
 * @returns {{checkedAt:number, deleted:number, bytes:number, missing:number, failed:number}
 *          | {dryRun:true, checkedAt:number, wouldRemove:Array<object>,
 *             wouldRemoveCount:number, wouldRemoveBytes:number, wouldMarkMissing:number, wouldMarkUnsafe:number}}
 */
export function runArchiveCleanup(opts = {}) {
  // 预演分支放在抢锁之前：dryRun 不删不改，没有排他需求；反过来抢锁会撞上扫描被判 busy，
  // 于是「预览」时而拿不到结果（用户会以为没东西可删），这是比多跑一次查询更坏的事。
  if (opts?.dryRun === true) return planArchiveRemovals(opts);
  // 删除与扫描互斥；后台清理撞上扫描时**跳过本轮**（下次定时还会跑），不排长队也不抛。
  const res = fileOpsMu.runOrSkipSync(() => runArchiveCleanupUnlocked(opts), 'archive-cleanup');
  if (res && res.skipped) {
    return { checkedAt: Number(opts?.nowMs) || Date.now(), deleted: 0, bytes: 0, missing: 0, failed: 0, skipped: true, reason: 'busy' };
  }
  return res;
}

/**
 * dryRun 的实现：与 runArchiveCleanupUnlocked 用**同一份到期清单**（dueArchiveRecords）和
 * **同一套路径判定**（safeResolveInside），区别只在最后一步——那边 rm+prune+UPDATE，这边只 push。
 * 因此预览的条目集合与真跑的 deleted 集合同源，不会出现「预览说有、真跑说没有」。
 *
 * 只读的具体含义（安全护栏）：不 unlink / rmSync、不 pruneEmptyDirs、不执行任何
 * UPDATE/DELETE SQL、不写 state/*.json、不打日志（日志也是写盘副作用）。
 */
function planArchiveRemovals({ db, rootDir, nowMs = Date.now(), exists } = {}) {
  const now = Number(nowMs) || Date.now();
  const existsFn = typeof exists === 'function' ? exists : (abs) => fs.existsSync(abs);
  const rows = dueArchiveRecords(db, now);
  const wouldRemove = [];
  let wouldMarkMissing = 0;
  let wouldMarkUnsafe = 0;
  for (const row of rows) {
    let abs;
    try {
      abs = safeResolveInside(rootDir, row.relPath);
    } catch {
      // 真跑会把这条标成 unsafe-path（台账改动，不动文件）——预演只计数，不预演写台账。
      wouldMarkUnsafe += 1;
      continue;
    }
    if (!existsFn(abs)) {
      // 文件已经不在：真跑只会补一个 missing 标记，没有「可删的东西」，不算进 wouldRemove。
      wouldMarkMissing += 1;
      continue;
    }
    wouldRemove.push({
      id: row.id,
      // name 用落盘后的名字（与面板/文件系统一致）；原名另给 fileName，两份都不编造。
      name: row.storedName || row.fileName,
      fileName: row.fileName,
      bytes: row.bytes,
      category: row.category,
      reason: 'expired',
      // createdAt = 入库时间（archived_at），与面板「归档于」同源；0 表示台账没记。
      createdAt: row.archivedAt,
      relPath: row.relPath
    });
  }
  return {
    dryRun: true,
    checkedAt: now,
    wouldRemove,
    wouldRemoveCount: wouldRemove.length,
    wouldRemoveBytes: wouldRemove.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
    wouldMarkMissing,
    wouldMarkUnsafe
  };
}

function runArchiveCleanupUnlocked({ db, rootDir, nowMs = Date.now(), removeFile, exists, log } = {}) {
  const now = Number(nowMs) || Date.now();
  const rm = typeof removeFile === 'function' ? removeFile : (abs) => fs.rmSync(abs, { force: true });
  const existsFn = typeof exists === 'function' ? exists : (abs) => fs.existsSync(abs);
  const rows = dueArchiveRecords(db, now);
  const result = { checkedAt: now, deleted: 0, bytes: 0, missing: 0, failed: 0 };
  const mark = db.prepare('UPDATE file_archive SET deleted_at = ?, delete_reason = ? WHERE id = ?');
  for (const row of rows) {
    let abs;
    try {
      abs = safeResolveInside(rootDir, row.relPath);
    } catch (error) {
      mark.run(now, 'unsafe-path', row.id);
      result.failed += 1;
      log?.(`清理跳过越界路径 ${row.relPath}：${error?.message ?? error}`);
      continue;
    }
    if (!existsFn(abs)) {
      mark.run(now, 'missing', row.id);
      result.missing += 1;
      log?.(`清理：文件已不存在，台账标记 missing ${row.relPath}`);
      continue;
    }
    try {
      rm(abs);
      // 商品目录里还有 meta.json / thumbnail，必须一起删，否则空目录永远删不掉。
      for (const rel of [row.metaRel, row.thumbRel]) {
        if (!rel) continue;
        try { rm(safeResolveInside(rootDir, rel)); } catch {}
      }
      try { pruneEmptyDirs(rootDir, abs); } catch {}
      mark.run(now, 'expired', row.id);
      result.deleted += 1;
      result.bytes += row.bytes;
    } catch (error) {
      result.failed += 1;
      log?.(`清理失败 ${row.relPath}：${error?.message ?? error}`);
    }
  }
  return result;
}

/** 一行可观测日志（谁删的、删多少、释放多少、下次什么时候跑）。 */
export function formatCleanupLog(result, nextRunAtMs) {
  const next = Number(nextRunAtMs) ? new Date(Number(nextRunAtMs)).toLocaleString('zh-CN', { hour12: false }) : '未安排';
  return `文件清理：删除 ${result?.deleted ?? 0} 个（${formatBytes(result?.bytes ?? 0)}），`
    + `缺失 ${result?.missing ?? 0}，失败 ${result?.failed ?? 0}；下次运行 ${next}`;
}

/** 台账汇总（/api/files/stats 与存储卡用）。 */
export function archiveStats(db, { nowMs = Date.now(), retention = null, rulesVersions = RULES_VERSIONS } = {}) {
  const now = Number(nowMs) || Date.now();
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN bytes ELSE 0 END), 0) AS active_bytes,
      COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS deleted,
      COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN bytes ELSE 0 END), 0) AS deleted_bytes,
      COALESCE(SUM(CASE WHEN deleted_at IS NULL AND cleanup_at <= ? THEN 1 ELSE 0 END), 0) AS due,
      COALESCE(SUM(CASE WHEN deleted_at IS NULL AND cleanup_at <= ? THEN bytes ELSE 0 END), 0) AS due_bytes,
      COALESCE(SUM(CASE WHEN deleted_at IS NULL AND category != '' AND category != 'unclassified' THEN 1 ELSE 0 END), 0) AS classified,
      COALESCE(SUM(CASE WHEN deleted_at IS NULL AND (category = '' OR category = 'unclassified') THEN 1 ELSE 0 END), 0) AS unclassified
    FROM file_archive
  `).get(now, now);
  const byGroup = db.prepare(`
    SELECT group_id, COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes
    FROM file_archive WHERE deleted_at IS NULL GROUP BY group_id ORDER BY bytes DESC
  `).all().map((r) => ({ groupId: String(r.group_id ?? ''), files: Number(r.files) || 0, bytes: Number(r.bytes) || 0 }));
  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    retention: {
      unclassifiedDays: retentionDaysFor('', retention),
      classifiedDays: retentionDaysFor('classified', retention)
    },
    files: {
      active: Number(totals.active) || 0,
      activeBytes: Number(totals.active_bytes) || 0,
      classified: Number(totals.classified) || 0,
      unclassified: Number(totals.unclassified) || 0,
      due: Number(totals.due) || 0,
      dueBytes: Number(totals.due_bytes) || 0,
      deleted: Number(totals.deleted) || 0,
      deletedBytes: Number(totals.deleted_bytes) || 0,
      total: Number(totals.total) || 0
    },
    byGroup,
    // 规则版本对账（控制台显示「本次跳过 N 条旧结论」+「全部重来」按钮的数据源）。
    // staleRows = 结论按旧规则算的行数；没有有效行时不必查库。
    rules: (() => {
      const activeCount = Number(totals.active) || 0;
      const stale = activeCount ? countStaleRuleRows(db, { versions: rulesVersions }) : 0;
      return {
        versions: { identify: Number(rulesVersions.identify) || 0, category: Number(rulesVersions.category) || 0, booth: Number(rulesVersions.booth) || 0 },
        staleRows: stale,
        skippedOldConclusions: stale
      };
    })()
  };
}

/**
 * /api/files 的分页参数规范化（纯函数，路由与测试共用）。
 * - limit：非数字/<=0 → 100；夹到 1..1000；
 * - offset：负数/非数字 → 0；不设上限（offset>total 时由 listArchive 返回空数组，路由回显请求值）。
 */
export function normalizeListParams({ limit, offset } = {}) {
  const rawLimit = Number(limit);
  const safeLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(1000, Math.floor(rawLimit)) : 100;
  const rawOffset = Number(offset);
  const safeOffset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { limit: safeLimit, offset: safeOffset };
}

// ── 库管理器：行级过滤/排序/聚合（纯函数，路由与测试共用）────────────────────
// 为什么不用 SQL：列表接口本来就会读回最近 1000 行（缩略图/元数据回填都要用），
// 在 JS 侧过滤排序既省改 SQL 的风险，也便于离线断言。
const SORT_KEYS = new Set(['newest', 'oldest', 'title', 'booth']);

export function filterArchiveRows(rows, { q = '', category = '', shop = '', status = '', uncategorized = false } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const qq = String(q || '').trim().toLowerCase();
  const cat = String(category || '').trim();
  const shopName = String(shop || '').trim();
  const st = String(status || '').trim();
  return list.filter((r) => {
    if (!r || r.deletedAt) return false;
    if (uncategorized) { if (String(r.category || '')) return false; }
    else if (cat && String(r.category || '') !== cat) return false;
    if (shopName && String(r.boothShop || '') !== shopName) return false;
    if (st === 'enriched' && !(r.boothId && r.enrichStatus === 'ok')) return false;
    if (st === 'pending' && !(r.boothId && r.enrichStatus !== 'ok')) return false;
    if (st === 'unclassified' && r.boothId) return false;
    if (qq) {
      const hay = [r.boothTitle, r.boothShop, r.fileName, r.boothId].map((x) => String(x ?? '').toLowerCase()).join('\n');
      if (!hay.includes(qq)) return false;
    }
    return true;
  });
}

export function sortArchiveRows(rows, sort = 'newest') {
  const list = [...(Array.isArray(rows) ? rows : [])];
  const key = SORT_KEYS.has(String(sort)) ? String(sort) : 'newest';
  const titleOf = (r) => String(r.boothTitle || r.fileName || '');
  list.sort((a, b) => {
    if (key === 'oldest') return (a.archivedAt || 0) - (b.archivedAt || 0);
    if (key === 'title') return titleOf(a).localeCompare(titleOf(b), 'zh-CN');
    if (key === 'booth') {
      const ai = a.boothId ? 1 : 0; const bi = b.boothId ? 1 : 0;
      if (ai !== bi) return bi - ai;
      return String(b.boothId || '').localeCompare(String(a.boothId || ''));
    }
    return (b.archivedAt || 0) - (a.archivedAt || 0);
  });
  return list;
}

/** 左侧 Lists：分类计数 + 未分类。 */
export function fileListsFromRows(rows) {
  const counts = new Map();
  let uncategorized = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.deletedAt) continue;
    const cat = String(r.category || '');
    if (!cat) { uncategorized += 1; continue; }
    counts.set(cat, (counts.get(cat) || 0) + 1);
  }
  const lists = [...counts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
  return { lists, uncategorized: { count: uncategorized } };
}

/** Notify 角标。 */
export function fileNotifyFromRows(rows) {
  let pendingEnrich = 0; let failed = 0; let unclassified = 0; let lastBackfillAt = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.deletedAt) continue;
    if (!r.boothId) { unclassified += 1; continue; }
    if (r.enrichStatus === 'ok') { lastBackfillAt = Math.max(lastBackfillAt, Number(r.enrichedAt) || 0); continue; }
    if (r.enrichStatus === 'failed') failed += 1; else pendingEnrich += 1;
  }
  return { pendingEnrich, failed, unclassified, lastBackfillAt };
}
