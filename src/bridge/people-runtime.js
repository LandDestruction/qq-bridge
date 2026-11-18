// people-runtime: extracted bridge responsibilities; no startup side effects.
// Live dependencies: GROUP_MEMBER_NAME_TTL_MS, PEOPLE_FILE, affinityLoad, cfg, groupMemberNameCache, loadPeople, log, noteSighting, peopleInitDone, peopleLogAt, peopleSavedAt, peopleStoreCache, recallPeople, savePeople, socialV2
export function createPeopleRuntime(deps) {
// @bridge-function pruneGroupMemberNameCache:start
function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of deps.groupMemberNameCache) {
      if (now - v.ts > deps.GROUP_MEMBER_NAME_TTL_MS) deps.groupMemberNameCache.delete(k);
    }
    if (deps.groupMemberNameCache.size > 2000) {
      const keys = [...deps.groupMemberNameCache.keys()].slice(0, deps.groupMemberNameCache.size - 2000);
      for (const k of keys) deps.groupMemberNameCache.delete(k);
    }
  }
// @bridge-function pruneGroupMemberNameCache:end

// @bridge-function peopleOptions:start
function peopleOptions() {
    const p = deps.cfg.socialV2?.memory?.people || {};
    return {
      enabled: p.enabled === true,
      maxPeople: Number(p.maxPeople) || 500,
      maxChars: Number(p.maxChars) || 200,
      staleDays: Number(p.staleDays) || 90
    };
  }
// @bridge-function peopleOptions:end

// @bridge-function peopleEnabled:start
function peopleEnabled() { return peopleOptions().enabled; }
// @bridge-function peopleEnabled:end

// @bridge-function peopleLoad:start
function peopleLoad() {
    if (!deps.peopleStoreCache) deps.peopleStoreCache = (0, deps.loadPeople)(deps.PEOPLE_FILE);
    return deps.peopleStoreCache;
  }
// @bridge-function peopleLoad:end

// @bridge-function peopleSaveNow:start
function peopleSaveNow() {
    try {
      (0, deps.savePeople)(deps.PEOPLE_FILE, deps.peopleStoreCache);
      deps.peopleSavedAt = Date.now();
    } catch (error) {
      (0, deps.log)(`[认人] 档案写入失败（不影响聊天）：${error?.message ?? error}`);
    }
  }
// @bridge-function peopleSaveNow:end

// @bridge-function peopleLedgerName:start
function peopleLedgerName(userId) {
    try {
      return String((0, deps.affinityLoad)()?.people?.[String(userId)]?.name || '').trim();
    } catch { return ''; }
  }
// @bridge-function peopleLedgerName:end

// @bridge-function peopleEnsureReady:start
function peopleEnsureReady({ persist = true } = {}) {
    if (deps.peopleInitDone) return;
    deps.peopleInitDone = true;
    try {
      const store = peopleLoad();
      // 首次回填（store 从来没被回填过）才按历史消息累计次数；之后的每次启动只补别名，
      // 否则每重启一次，所有人的发言次数就翻一倍。
      const firstBackfill = !Number(store.backfilledAt);
      for (const [convKey, conv] of deps.socialV2.conversations || []) {
        const msgs = [
          ...(Array.isArray(conv?.unread) ? conv.unread : []),
          ...(Array.isArray(conv?.recentMessages) ? conv.recentMessages : [])
        ];
        // unread 与 recentMessages 有重叠（同一条消息两边都在）：按 seq 去重，否则回填次数会翻倍。
        const seenSeq = new Set();
        for (const m of msgs) {
          if (!m || m.isSelf || !m.userId) continue;
          if (m.seq != null) {
            if (seenSeq.has(m.seq)) continue;
            seenSeq.add(m.seq);
          }
          const known = Boolean(store.people[String(m.userId)]);
          (0, deps.noteSighting)(store, {
            userId: m.userId, name: m.sender, source: 'sender', scope: convKey, at: m.time,
            count: firstBackfill || !known,
            // 回填也归纳话题：否则「刚开启/刚重启」时只能说出名字、说不出聊过什么（用户验收第二条）。
            text: String(m.plain ?? m.text ?? '')
          });
        }
      }
      store.backfilledAt = Date.now();
      try {
        const aff = (0, deps.affinityLoad)();
        for (const [uid, p] of Object.entries(aff?.people || {})) {
          if (!p || !String(p.name || '').trim()) continue;
          (0, deps.noteSighting)(store, { userId: uid, name: p.name, source: 'ledger', scope: null, at: p.counters?.lastSeenAt, count: false });
        }
      } catch {}
      if (persist) peopleSaveNow();
    } catch (error) {
      (0, deps.log)(`[认人] 回填失败（不影响聊天）：${error?.message ?? error}`);
    }
  }
// @bridge-function peopleEnsureReady:end

// @bridge-function peopleNoteInbound:start
function peopleNoteInbound(key, userId, sender, text = '') {
    if (!peopleEnabled() || !userId) return;
    try {
      peopleEnsureReady({ persist: false });
      const uid = String(userId).trim();
      if (!uid) return;
      const store = peopleLoad();
      const names = [{ name: sender, source: 'sender' }];
      const groupId = /^group:(\d+)/.exec(String(key || ''))?.[1];
      if (groupId) {
        const hit = deps.groupMemberNameCache.get(`${groupId}:${uid}`);
        if (hit?.name) names.push({ name: hit.name, source: 'card' });
      }
      const ledgerName = peopleLedgerName(uid);
      if (ledgerName) names.push({ name: ledgerName, source: 'ledger' });
      let changed = false;
      for (const n of names) {
        // 只有 sender 这一路累加次数/群计数/归纳话题，避免一个人被记三遍。
        const bySender = n.source === 'sender';
        const r = (0, deps.noteSighting)(store, {
          userId: uid, name: n.name, source: n.source, scope: key, at: Date.now(), count: bySender,
          text: bySender ? text : ''
        });
        changed = changed || r.added || r.aliasAdded;
      }
      const now = Date.now();
      if (changed || now - deps.peopleSavedAt > 60000) peopleSaveNow();
    } catch (error) {
      (0, deps.log)(`[认人] 记录失败（不影响聊天）：${error?.message ?? error}`);
    }
  }
// @bridge-function peopleNoteInbound:end

// @bridge-function peopleImpressionsFor:start
function peopleImpressionsFor(names, key) {
    const out = [];
    try {
      const global = deps.socialV2.globalImpressions && typeof deps.socialV2.globalImpressions === 'object' ? deps.socialV2.globalImpressions : {};
      const local = deps.socialV2.conversations.get(key)?.memberImpressions || {};
      for (const name of names || []) {
        const g = global[name];
        if (g && Array.isArray(g.traits)) out.push(...g.traits);
        const l = local[name];
        if (l && Array.isArray(l.traits)) out.push(...l.traits);
      }
    } catch {}
    return out;
  }
// @bridge-function peopleImpressionsFor:end

// @bridge-function peopleRecallLine:start
function peopleRecallLine(key, st) {
    const opt = peopleOptions();
    if (!opt.enabled) return '';
    try {
      peopleEnsureReady({ persist: false });
      const pool = [
        ...(Array.isArray(st?.unread) ? st.unread : []),
        ...(Array.isArray(st?.recentMessages) ? st.recentMessages : [])
      ];
      const last = [...pool].reverse().find((m) => m && !m.isSelf && String(m.text || m.plain || '').trim());
      if (!last) return '';
      const recalled = (0, deps.recallPeople)(peopleLoad(), {
        text: String(last.text || last.plain || ''),
        scope: key,
        now: Date.now(),
        maxChars: opt.maxChars,
        staleDays: opt.staleDays,
        impressionFor: (names) => peopleImpressionsFor(names, key)
      });
      if (!recalled.text) return '';
      if (Date.now() - deps.peopleLogAt > 60000) {
        deps.peopleLogAt = Date.now();
        (0, deps.log)(`[认人] ${key} 命中 ${recalled.mode}（${recalled.hits} 人），注入 ${[...recalled.text].length} 字`);
      }
      return `${recalled.text}\n\n`;
    } catch (error) {
      (0, deps.log)(`[认人] 召回失败（不影响聊天）：${error?.message ?? error}`);
      return '';
    }
  }
// @bridge-function peopleRecallLine:end
  return { pruneGroupMemberNameCache, peopleOptions, peopleEnabled, peopleLoad, peopleSaveNow, peopleLedgerName, peopleEnsureReady, peopleNoteInbound, peopleImpressionsFor, peopleRecallLine };
}
