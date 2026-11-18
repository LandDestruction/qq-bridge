// affinity-runtime: extracted bridge responsibilities; no startup side effects.
// Live dependencies: AFFINITY_FILE, GROUP_MEMBER_NAME_TTL_MS, affinityAsked, affinitySaveTimer, affinityStore, applyInbound, applyPenalty, cfg, describeForPrompt, emptyStore, ensurePerson, groupMemberNameCache, loadStore, log, normalizeRules, privacyLine, saveStore, setTimeout, shiftByModel, socialV2
export function createAffinityRuntime(deps) {
// @bridge-function affinityRules:start
function affinityRules() {
    try { return (0, deps.normalizeRules)(deps.cfg.socialV2?.affinity); } catch { return (0, deps.normalizeRules)(null); }
  }
// @bridge-function affinityRules:end

// @bridge-function affinityOn:start
function affinityOn() { return affinityRules().enabled !== false; }
// @bridge-function affinityOn:end

// @bridge-function affinityLoad:start
function affinityLoad() {
    if (!deps.affinityStore) {
      try { deps.affinityStore = (0, deps.loadStore)(deps.AFFINITY_FILE, Date.now(), { rules: affinityRules() }); }
      catch (error) { (0, deps.log)(`[好感度] 读盘失败，先用空库：${error?.message ?? error}`); deps.affinityStore = (0, deps.emptyStore)(); }
    }
    return deps.affinityStore;
  }
// @bridge-function affinityLoad:end

// @bridge-function affinityPersist:start
function affinityPersist() {
    if (!deps.affinityStore) return false;
    try { (0, deps.saveStore)(deps.AFFINITY_FILE, deps.affinityStore); return true; }
    catch (error) { (0, deps.log)(`[好感度] 写盘失败：${error?.message ?? error}`); return false; }
  }
// @bridge-function affinityPersist:end

// @bridge-function affinitySaveSoon:start
function affinitySaveSoon() {
    if (deps.affinitySaveTimer) return;
    deps.affinitySaveTimer = (0, deps.setTimeout)(() => { deps.affinitySaveTimer = null; affinityPersist(); }, 2000);
    if (deps.affinitySaveTimer && typeof deps.affinitySaveTimer.unref === 'function') deps.affinitySaveTimer.unref();
  }
// @bridge-function affinitySaveSoon:end

// @bridge-function affinityNoteInbound:start
function affinityNoteInbound(key, userId, text, flags = {}) {
    if (!affinityOn()) return null;
    const uid = String(userId ?? '').trim();
    if (!uid) return null;
    try {
      const rules = affinityRules();
      const store = affinityLoad();
      const person = (0, deps.ensurePerson)(store, uid, Date.now(), rules);
      const isPrivate = String(key).startsWith('private:');
      const r = (0, deps.applyInbound)(person, {
        kind: isPrivate ? 'private' : 'group',
        at: flags.at === true, sticker: flags.sticker === true,
        poke: flags.poke === true, media: flags.media === true,
        scope: key
      }, Date.now(), rules);
      // 辱骂关键词：配置里可调，命中就立刻扣（有日上限，骂不穿）。
      let penalty = null;
      try {
        const bad = (rules.insultKeywords || []).find((w) => w && String(text ?? '').includes(w));
        if (bad) penalty = (0, deps.applyPenalty)(person, 'insult', Date.now(), rules);
      } catch {}
      if ((r && r.points) || (penalty && penalty.applied)) affinitySaveSoon();
      return { day: r?.points || 0, penalty: penalty?.delta || 0 };
    } catch (error) { (0, deps.log)(`[好感度] 结算失败：${error?.message ?? error}`); return null; }
  }
// @bridge-function affinityNoteInbound:end

// @bridge-function affinityNickname:start
function affinityNickname(key, userId, last, person) {
    const uid = String(userId || '').trim();
    const m = /^group:(\d+)/.exec(String(key || ''));
    if (m && uid) {
      try {
        const hit = deps.groupMemberNameCache.get(`${m[1]}:${uid}`);
        if (hit && hit.name && Date.now() - Number(hit.ts) < deps.GROUP_MEMBER_NAME_TTL_MS) return String(hit.name).slice(0, 24);
      } catch {} // 缓存声明在文件更后面：万一启动早期被调用，宁可退回 sender，也不让注入整块失败
    }
    if (person && person.name) return String(person.name).slice(0, 24);
    if (last && String(last.sender || '').trim()) return String(last.sender).trim().slice(0, 24);
    const st = deps.socialV2.conversations.get(key);
    const msgs = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const x = msgs[i];
      if (x && !x.isSelf && String(x.userId || '') === uid && String(x.sender || '').trim()) return String(x.sender).trim().slice(0, 24);
    }
    return '';
  }
// @bridge-function affinityNickname:end

// @bridge-function affinityMemories:start
function affinityMemories(key, name, userId) {
    const nm = String(name || '').trim();
    const uid = String(userId || '').trim();
    const out = [];
    if (!nm && !uid) return out;
    const visible = (scope) => scope === 'global' || scope === String(key || '');
    const events = (Array.isArray(deps.socialV2.sharedEvents) ? deps.socialV2.sharedEvents : [])
      .filter((e) => e && e.text && visible(String(e.scope || 'global')))
      .filter((e) => (nm && String(e.by || '') === nm) || (nm.length > 1 && String(e.text).includes(nm)) || (uid && String(e.text).includes(uid)))
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
    for (const e of events.slice(0, 2)) out.push(e.text);
    if (out.length < 2 && nm) {
      const imGlobal = deps.socialV2.globalImpressions && deps.socialV2.globalImpressions[nm];
      const imLocal = deps.socialV2.conversations.get(key)?.memberImpressions?.[nm];
      const traits = [...(imGlobal?.traits || []), ...(imLocal?.traits || [])];
      for (const t of traits) { if (out.length >= 2) break; out.push(t); }
    }
    return out.slice(0, 2);
  }
// @bridge-function affinityMemories:end

// @bridge-function affinityPromptBlock:start
function affinityPromptBlock(key) {
    if (!affinityOn()) return '';
    try {
      const st = deps.socialV2.conversations.get(key);
      const msgs = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
      const last = [...msgs].reverse().find((m) => m && !m.isSelf && String(m.text || m.plain || '').trim());
      if (!last) return '';
      const text = String(last.text || last.plain || '');
      const rules = affinityRules();
      if (!rules.queryKeywords.some((w) => w && text.includes(w))) return '';
      const askerId = String(last.userId || '').trim();
      const person = askerId ? (0, deps.ensurePerson)(affinityLoad(), askerId, Date.now(), rules) : null;
      // 显示名优先用群名片/昵称：取到就顺手记进台账（下次重启后仍能显示名字）。
      const nickname = affinityNickname(key, askerId, last, person);
      if (person && nickname && person.name !== nickname) { person.name = nickname; affinitySaveSoon(); }
      if (askerId) deps.affinityAsked.set(key, { userId: askerId, at: Date.now() });
      const memories = affinityMemories(key, nickname, askerId);
      const block = `${(0, deps.describeForPrompt)(person, rules, { nickname, memories })}\n${(0, deps.privacyLine)(rules)}\n\n`;
      (0, deps.log)(`[好感度] 本轮被问（${key}，${nickname ? `${nickname}/${askerId || '?'}` : askerId || '?'}），已注入 ${[...block].length} 字，记忆依据 ${memories.length} 条`);
      return block;
    } catch (error) { (0, deps.log)(`[好感度] 注入失败：${error?.message ?? error}`); return ''; }
  }
// @bridge-function affinityPromptBlock:end

// @bridge-function affinityAskedFresh:start
function affinityAskedFresh(key, withinMs = 10 * 60 * 1000) {
    const hit = deps.affinityAsked.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > withinMs) { deps.affinityAsked.delete(key); return null; }
    return hit;
  }
// @bridge-function affinityAskedFresh:end

// @bridge-function affinityShift:start
function affinityShift({ key, userId, delta, reason }) {
    const rules = affinityRules();
    if (!affinityOn()) return { ok: false, code: 'disabled', message: '好感度功能关着' };
    const uid = String(userId ?? '').trim();
    if (!uid) return { ok: false, code: 'bad_user', message: 'userId 必填（要改谁的分）' };
    const asked = affinityAskedFresh(key);
    const st = deps.socialV2.conversations.get(key);
    const msgs = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const recentInbound = msgs.some((m) => m && !m.isSelf && String(m.userId || '') === uid
      && Date.now() - Number(m.time || st?.lastIncomingAt || 0) < 10 * 60 * 1000);
    const store = affinityLoad();
    (0, deps.ensurePerson)(store, uid, Date.now(), rules);
    const r = (0, deps.shiftByModel)(store, {
      userId: uid, delta, reason, now: Date.now(), rules, scope: key,
      askedThisTurn: !!asked && asked.userId === uid,
      hadInboundThisTurn: recentInbound
    });
    if (r.ok) {
      affinityPersist();
      (0, deps.log)(`[好感度] 改分 ${uid} ${delta > 0 ? '+' : ''}${delta}（${String(reason).slice(0, 40)}）→ ${r.score}/100`);
    } else (0, deps.log)(`[好感度] 拒绝改分 ${uid}：${r.code}（${r.message}）`);
    return r;
  }
// @bridge-function affinityShift:end
  return { affinityRules, affinityOn, affinityLoad, affinityPersist, affinitySaveSoon, affinityNoteInbound, affinityNickname, affinityMemories, affinityPromptBlock, affinityAskedFresh, affinityShift };
}
