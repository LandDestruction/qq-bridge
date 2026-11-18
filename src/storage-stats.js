// state/ 占用统计（只读）。
//
// 为什么需要：messages.db-wal 已经涨到主库的 3 倍、archive 也在长，但**没有任何地方能看见
// 增长趋势**，等到几十 MB 才发现就晚了。
//
// 严格只读：不做 checkpoint、不 VACUUM、不删任何东西。这一版只负责「看见」。
// 尤其 WAL：不做任何自动 checkpoint —— 那会把回归问题掩盖成「一切正常」，
// 而且 checkpoint 会短暂持有写锁。要优化请单独立项、带基准数据。

import fs from 'node:fs';
import path from 'node:path';

const MAX_TOP_ITEMS = 20;
const MAX_DEPTH = 1; // 只统计顶层 + 一层子目录，避免大目录拖慢请求

/**
 * 目录/文件大小（递归但有深度上限；跳过软链，防无限递归）。
 *
 * 返回 { bytes, truncated }：**超过深度上限的子目录不再递归**，但会把它的**直接子文件**
 * 计入（不是 0），并置 truncated=true —— 否则「state/ 合计」会静默少算，
 * 面板显示的数字看起来精确、其实偏小，还看不出偏小。
 */
export function sizeOfDetailed(target, depth = 0) {
  let bytes = 0;
  let truncated = false;
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) return { bytes: 0, truncated: false };
    if (st.isFile()) return { bytes: st.size, truncated: false };
    if (!st.isDirectory()) return { bytes: 0, truncated: false };
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) {
          const sub = sizeOfDetailed(full, depth + 1);
          bytes += sub.bytes;
          if (sub.truncated) truncated = true;
        } else {
          // 到顶了：不递归，但把这一层的直接文件算进去，并标记「未完全统计」
          truncated = true;
          try {
            for (const inner of fs.readdirSync(full, { withFileTypes: true })) {
              if (inner.isSymbolicLink() || !inner.isFile()) continue;
              try { bytes += fs.statSync(path.join(full, inner.name)).size; } catch {}
            }
          } catch {}
        }
      } else if (entry.isFile()) {
        try { bytes += fs.statSync(full).size; } catch { /* 单项失败不影响整体 */ }
      }
    }
  } catch { return { bytes: 0, truncated: false }; }
  return { bytes, truncated };
}

/** 只要数字的便捷版本（保持老调用方可用）。 */
export function sizeOf(target, depth = 0) {
  return sizeOfDetailed(target, depth).bytes;
}

/** 文件行数（流式读，不整文件装内存）。失败返回 null。 */
export function countLines(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(1 << 16);
      let lines = 0;
      let read = 0;
      while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        for (let i = 0; i < read; i += 1) if (buf[i] === 10) lines += 1;
      }
      return lines;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

/** sqlite 只读统计：page_count / freelist_count / 行数。 */
export function sqliteStats(db, table = 'messages') {
  try {
    const pageCount = Number(db.prepare('PRAGMA page_count').get()?.page_count) || null;
    const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size) || null;
    const freelist = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count) || 0;
    let rows = null;
    try { rows = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n) ?? null; } catch { rows = null; }
    return { pageCount, pageSize, freelistCount: freelist, rows };
  } catch {
    return { pageCount: null, pageSize: null, freelistCount: null, rows: null };
  }
}

/** 磁盘剩余（statfsSync；不支持就 null，不报错）。 */
export function diskFree(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { total: Number(s.bsize) * Number(s.blocks), free: Number(s.bsize) * Number(s.bfree) };
  } catch { return null; }
}

/**
 * 汇总。返回结构固定、每项独立 try/catch，任何一项失败都给 null 而不是让整个请求 500。
 * @param {{ stateDir: string, db?: object, extraDirs?: string[] }} p
 */
export function collectStorageStats({ stateDir, db = null, extraDirs = [] } = {}) {
  const items = [];
  try {
    for (const entry of fs.readdirSync(stateDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(stateDir, entry.name);
      const detail = entry.isDirectory()
        ? sizeOfDetailed(full)
        : (() => { try { return { bytes: fs.statSync(full).size, truncated: false }; } catch { return { bytes: null, truncated: false }; } })();
      items.push({
        name: entry.name,
        kind: entry.isDirectory() ? 'dir' : 'file',
        bytes: detail.bytes,
        // 只有目录可能「未完全统计」：前端要据此标注「≥ X」，别把低估当成精确值。
        ...(detail.truncated ? { depthLimited: true } : {})
      });
    }
  } catch { /* 整体失败就返回空列表 */ }
  items.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));

  const dbPath = path.join(stateDir, 'messages.db');
  const walPath = `${dbPath}-wal`;
  const logNames = ['bridge.log', 'qq-activity.log'];
  const logs = logNames.map((name) => {
    const full = path.join(stateDir, name);
    let bytes = null;
    try { bytes = fs.statSync(full).size; } catch { bytes = null; }
    return { name, bytes, lines: countLines(full) };
  });

  return {
    ok: true,
    generatedAt: Date.now(),
    stateDir,
    top: items.slice(0, MAX_TOP_ITEMS),
    topTotal: items.reduce((n, i) => n + (i.bytes ?? 0), 0),
    // 有任一项受深度上限影响时置 true：此时 topTotal 是**下限**，不是精确值。
    truncated: items.some((i) => i.depthLimited === true),
    messages: {
      db: sqliteStats(db, 'messages'),
      dbBytes: (() => { try { return fs.statSync(dbPath).size; } catch { return null; } })(),
      walBytes: (() => { try { return fs.statSync(walPath).size; } catch { return null; } })()
    },
    logs,
    disks: [stateDir, ...extraDirs].map((dir) => ({ dir, free: diskFree(dir) }))
  };
}
