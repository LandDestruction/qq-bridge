// 消息永久归档 + 双轨检索（FTS5 trigram 主检 + LIKE 兜底）。
//
// 为什么需要：`state/social-v2.json` 的 recentMessages 只留最近 100 条、`/reset` 还会清，
// `state/archive/*.jsonl` 是 append-only 但只能整文件读（7 天轮转，且检索是 2 字滑窗打分）。
// 这里用 SQLite 做长期落库：一条消息一次 insert，检索由 FTS5 负责，不受 7 天轮转限制。
//
// 双轨的原因：FTS5 的 trigram 分词器要求查询串 **至少 3 个字符**，
// 而中文双字词（「煎蛋」「电费」）恰恰最常见 —— 所以 <3 字符时退回 LIKE 扫描，
// 宁可慢一点也不能查不到。
//
// 该模块只依赖 node:sqlite（Node 22.5+ 内置，本机 Node 24 无需 flag），零第三方依赖。

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     key TEXT NOT NULL,
     ts INTEGER NOT NULL,
     seq TEXT,
     sender TEXT,
     user_id TEXT,
     is_self INTEGER NOT NULL DEFAULT 0,
     is_owner INTEGER NOT NULL DEFAULT 0,
     text TEXT NOT NULL,
     message_id TEXT
   )`,
  // 同一条消息可能从「实时插入」和「启动回填」两条路各来一次，靠这个唯一索引去重。
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedupe ON messages(key, ts, text)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_key_ts ON messages(key, ts DESC)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(text, tokenize='trigram')`
];

/** 打开（或创建）消息库。传 ':memory:' 可用于测试。 */
export function openMessageDb(file) {
  const db = new DatabaseSync(file);
  // WAL：桥接进程写、检索读，两者互不阻塞；断电最多丢最后几条，可接受。
  try { db.exec('PRAGMA journal_mode = WAL'); } catch {}
  try { db.exec('PRAGMA synchronous = NORMAL'); } catch {}
  for (const sql of SCHEMA) db.exec(sql);
  return db;
}

/**
 * 插入一条消息；重复（同 key+ts+text）自动忽略。
 * @returns {boolean} 是否真的写入了新行
 */
export function insertMessage(db, msg) {
  const text = String(msg?.text ?? '').trim();
  if (!text) return false;
  const key = String(msg?.key ?? '');
  if (!key) return false;
  const ts = Number(msg?.ts ?? Date.now());
  const info = db.prepare(
    `INSERT OR IGNORE INTO messages (key, ts, seq, sender, user_id, is_self, is_owner, text, message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    key,
    ts,
    msg?.seq == null ? null : String(msg.seq),
    String(msg?.sender ?? ''),
    msg?.userId == null ? null : String(msg.userId),
    msg?.isSelf ? 1 : 0,
    msg?.isOwner ? 1 : 0,
    text,
    msg?.messageId == null ? null : String(msg.messageId)
  );
  if (Number(info.changes) === 0) return false;
  const rowid = Number(info.lastInsertRowid);
  // 手动维护 FTS 索引：只有真正的新行才进索引，和 messages 一一对应。
  db.prepare('INSERT INTO msg_fts (rowid, text) VALUES (?, ?)').run(rowid, text);
  return true;
}

function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

function ftsQuery(q) {
  // 用双引号包成短语，内部双引号翻倍转义；这样用户输入里的 AND/OR/*/- 都不会被当成语法。
  return `"${String(q).replace(/"/g, '""')}"`;
}

/**
 * 检索历史消息。
 * @param {{ key?: string, q: string, limit?: number, sinceMs?: number }} opts
 * @returns {{ track: 'fts' | 'like', rows: object[] }}
 */
export function searchMessages(db, { key = '', q = '', limit = 20, sinceMs = 0 } = {}) {
  const query = String(q ?? '').trim();
  const max = Math.min(500, Math.max(1, Number(limit) || 20));
  if (!query) return { track: 'like', rows: [] };

  const scope = key ? ' AND m.key = ?' : '';
  const scopeArgs = key ? [key] : [];
  const since = Number(sinceMs) > 0 ? ' AND m.ts >= ?' : '';
  const sinceArgs = Number(sinceMs) > 0 ? [Number(sinceMs)] : [];

  const cols = 'm.key, m.ts, m.sender, m.user_id, m.is_self, m.text';

  // trigram 至少要 3 个字符，否则 MATCH 会直接报语法错误 —— 此时走 LIKE 兜底。
  if ([...query].length >= 3) {
    try {
      const rows = db.prepare(
        `SELECT ${cols} FROM msg_fts JOIN messages m ON m.id = msg_fts.rowid
          WHERE msg_fts MATCH ?${scope}${since}
          ORDER BY m.ts DESC LIMIT ?`
      ).all(ftsQuery(query), ...scopeArgs, ...sinceArgs, max);
      return { track: 'fts', rows };
    } catch {
      // FTS 索引损坏或其他意外：不让检索整个挂掉，继续走 LIKE。
    }
  }

  const rows = db.prepare(
    `SELECT ${cols} FROM messages m
      WHERE m.text LIKE ? ESCAPE '\\'${scope}${since}
      ORDER BY m.ts DESC LIMIT ?`
  ).all(`%${likeEscape(query)}%`, ...scopeArgs, ...sinceArgs, max);
  return { track: 'like', rows };
}

/**
 * 某个会话最新的一条消息（控制台「会话卡片」的最后一句用）。
 * 为什么要查库而不是用内存里的 recentMessages：那份缓存会被裁剪、观察群/新私聊也可能压根没写进去，
 * 结果卡片上一直显示几天前那句（用户报过「群里有新消息，卡片还是老内容」）。
 * @returns {{key:string, ts:number, sender:string, isSelf:boolean, text:string}|null}
 */
export function latestMessageOfKey(db, key) {
  if (!db || !key) return null;
  try {
    const row = db.prepare(
      `SELECT key, ts, sender, is_self, text FROM messages WHERE key = ? ORDER BY ts DESC LIMIT 1`
    ).get(String(key));
    if (!row) return null;
    return {
      key: String(row.key || ''),
      ts: Number(row.ts) || 0,
      sender: String(row.sender || ''),
      isSelf: Number(row.is_self) === 1,
      text: String(row.text || '')
    };
  } catch {
    return null; // 库损坏/表缺失都不该拖垮控制台视图
  }
}

/**
 * 按时间上限清理历史消息（长期归档不是无限增长）。
 * 删除 ts 早于 `now - maxAgeMs` 的行，并同步清掉对应的 FTS 索引行。
 * @returns {number} 删除的行数
 */
export function pruneMessages(db, { maxAgeMs = 0, now = Date.now() } = {}) {
  const cutoff = Number(maxAgeMs) > 0 ? Number(now) - Number(maxAgeMs) : 0;
  if (cutoff <= 0) return 0;
  try {
    const removed = db.prepare('DELETE FROM messages WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM msg_fts WHERE rowid NOT IN (SELECT id FROM messages)').run();
    return Number(removed.changes) || 0;
  } catch {
    return 0;
  }
}

/** 库里有多少条、覆盖哪个时间段、涉及几个会话。 */
export function messageStats(db) {
  const row = db.prepare('SELECT COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last FROM messages').get();
  const keys = db.prepare('SELECT COUNT(DISTINCT key) AS k FROM messages').get();
  return {
    count: Number(row?.n ?? 0),
    conversations: Number(keys?.k ?? 0),
    firstTs: row?.first == null ? null : Number(row.first),
    lastTs: row?.last == null ? null : Number(row.last)
  };
}

export function closeMessageDb(db) {
  try { db.close(); } catch {}
}
