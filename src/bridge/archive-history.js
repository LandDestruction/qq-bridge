// archive-history: extracted bridge responsibilities; no startup side effects.
// Live dependencies: ARCHIVE_DIR, MESSAGE_DB_FILE, archiveWritable, cfg, fs, insertMessage, log, messageDbBroken, messageDbHandle, messageStats, openMessageDb, parseArchiveLines, path, searchMessages, socialV2
export function createArchiveHistory(deps) {
  let appendSincePrune = 0; // 低频清理计数：每 200 次归档检查一次上限，避免频繁 DELETE
// @bridge-function archiveFileFor:start
function archiveFileFor(key) {
    const safe = String(key).replace(/[^A-Za-z0-9_.-]/g, '_');
    return deps.path.join(deps.ARCHIVE_DIR, `${safe}.jsonl`);
  }
// @bridge-function archiveFileFor:end

// @bridge-function archiveAppend:start
function archiveAppend(key, msg) {
    if (!deps.archiveWritable || deps.cfg.archive?.enabled === false) return;
    if (!msg || (msg.kind === 'poke')) return; // 拍一拍不归档
    try {
      const text = String(msg.text || msg.plain || '').trim();
      if (!text) return;
      const line = JSON.stringify({
        t: msg.time || Date.now(),
        seq: msg.seq ?? null,
        sender: msg.sender ?? '未知',
        userId: msg.userId ?? null,
        isSelf: !!msg.isSelf,
        isOwner: !!msg.isOwner,
        text
      });
      deps.fs.appendFileSync(archiveFileFor(key), line + '\n', 'utf8');
    } catch {}
    // 同一份数据再落一条到 SQLite（jsonl 只保留 7 天，库里不设上限）。
    try {
      const db = messageDb();
      if (db) (0, deps.insertMessage)(db, { key, ts: msg.time || Date.now(), seq: msg.seq, sender: msg.sender, userId: msg.userId, isSelf: msg.isSelf, isOwner: msg.isOwner, text: String(msg.text || msg.plain || '').trim(), messageId: msg.messageId });
      // 长期归档不无限增长：按 dbRetentionDays（默认 90 天）低频清理旧行 + 孤儿 FTS 索引。
      appendSincePrune += 1;
      if (appendSincePrune >= 200) {
        appendSincePrune = 0;
        const db2 = messageDb();
        if (db2) {
          const retentionDays = Number(deps.cfg.archive?.dbRetentionDays ?? 90);
          const removed = (0, deps.pruneMessages)(db2, { maxAgeMs: retentionDays * 86400000 });
          if (removed > 0) (0, deps.log)(`消息库按 ${retentionDays} 天上限清理 ${removed} 条`);
        }
      }
    } catch {}
  }
// @bridge-function archiveAppend:end

// @bridge-function messageDb:start
function messageDb() {
    if (deps.messageDbBroken) return null;
    if (deps.messageDbHandle) return deps.messageDbHandle;
    try {
      deps.messageDbHandle = (0, deps.openMessageDb)(deps.MESSAGE_DB_FILE);
      return deps.messageDbHandle;
    } catch (error) {
      deps.messageDbBroken = true;
      (0, deps.log)(`⚠️ 消息库初始化失败，归档检索降级为关闭：${error?.message ?? error}`);
      return null;
    }
  }
// @bridge-function messageDb:end

// @bridge-function backfillMessageDb:start
function backfillMessageDb() {
    const db = messageDb();
    if (!db) return 0;
    let added = 0;
    // a) jsonl 归档（append-only，7 天轮转，但内容是真的）
    try {
      for (const f of deps.fs.readdirSync(deps.ARCHIVE_DIR)) {
        if (!f.endsWith(".jsonl")) continue;
        // 文件名把 key 里的冒号换成了下划线（group_123.jsonl），这里还原成 group:123。
        const base = f.slice(0, -6);
        const key = base.startsWith('group_') ? 'group:' + base.slice(6) : base.startsWith('private_') ? 'private:' + base.slice(8) : base;
        const raw = deps.fs.readFileSync(deps.path.join(deps.ARCHIVE_DIR, f), "utf8");
        for (const row of (0, deps.parseArchiveLines)(raw)) {
          if ((0, deps.insertMessage)(db, { key, ts: row.t, seq: row.seq, sender: row.sender, userId: row.userId, isSelf: row.isSelf, isOwner: row.isOwner, text: row.text })) added += 1;
        }
      }
    } catch {}
    // b) social-v2 里还留着的最近消息（jsonl 可能已经被轮转删掉）
    try {
      for (const [key, c] of deps.socialV2.conversations) {
        for (const m of c.recentMessages || []) {
          if ((0, deps.insertMessage)(db, { key, ts: m.time, seq: m.seq, sender: m.sender, userId: m.userId, isSelf: m.isSelf, isOwner: m.isOwner, text: String(m.plain || m.text || "") })) added += 1;
        }
      }
    } catch {}
    // 迁移早期写成下划线的 key，并清掉因唯一索引冲突而无法迁移的残留行。
    const fixed = fixLegacyMessageKeys(db);
    if (fixed > 0) {
      try {
        db.prepare("DELETE FROM messages WHERE key LIKE 'group!_%' ESCAPE '!' OR key LIKE 'private!_%' ESCAPE '!'").run();
        db.prepare('DELETE FROM msg_fts WHERE rowid NOT IN (SELECT id FROM messages)').run();
      } catch {}
      (0, deps.log)(`历史消息会话 key 已修正 ${fixed} 条`);
    }
    if (added > 0) {
      const st = (0, deps.messageStats)(db);
      (0, deps.log)(`消息库回填 ${added} 条（现有 ${st.count} 条 / ${st.conversations} 个会话）`);
    }
    return added;
  }
// @bridge-function backfillMessageDb:end

// @bridge-function fixLegacyMessageKeys:start
function fixLegacyMessageKeys(db) {
    try {
      const rows = db.prepare("SELECT id, key FROM messages WHERE key LIKE 'group!_%' ESCAPE '!' OR key LIKE 'private!_%' ESCAPE '!'").all();
      if (!rows.length) return 0;
      const upd = db.prepare('UPDATE OR IGNORE messages SET key = ? WHERE id = ?');
      const fix = (k) => (k.startsWith('group_') ? 'group:' + k.slice(6) : k.startsWith('private_') ? 'private:' + k.slice(8) : k);
      let n = 0;
      for (const r of rows) { try { upd.run(fix(String(r.key)), r.id); n += 1; } catch {} }
      return n;
    } catch {
      return 0;
    }
  }
// @bridge-function fixLegacyMessageKeys:end

// @bridge-function searchHistory:start
function searchHistory({ key = "", q = "", limit = 20, sinceMs = 0 } = {}) {
    const db = messageDb();
    if (!db) return { ok: false, error: "消息库不可用" };
    const found = (0, deps.searchMessages)(db, { key, q, limit, sinceMs });
    return {
      ok: true,
      track: found.track,
      count: found.rows.length,
      items: found.rows.map((r) => ({
        key: r.key,
        time: new Date(Number(r.ts)).toISOString(),
        sender: r.sender,
        userId: r.user_id,
        isSelf: !!r.is_self,
        text: r.text
      }))
    };
  }
// @bridge-function searchHistory:end
  return { archiveFileFor, archiveAppend, messageDb, backfillMessageDb, fixLegacyMessageKeys, searchHistory };
}
