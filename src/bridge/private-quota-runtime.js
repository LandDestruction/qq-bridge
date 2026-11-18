// private-quota-runtime: extracted bridge responsibilities; no startup side effects.
// Live dependencies: AbortSignal, PRIVATE_QUOTA_FILE, accrueUsage, atomicWriteJson, cfg, dayKey, fetch, formatLeft, fs, groupMemberCache, groupMemberRefreshedAt, log, quotaState
export function createPrivateQuotaRuntime(deps) {
// @bridge-function refreshGroupMembers:start
async function refreshGroupMembers() {
    const groups = Array.isArray(deps.cfg.allow?.groups) ? deps.cfg.allow.groups : [];
    if (!groups.length) return 0;
    const httpUrl = String(deps.cfg.snowluma?.httpUrl || "http://127.0.0.1:3000").replace(/\/+$/, "");
    const auth = deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {};
    let added = 0;
    for (const gid of groups) {
      try {
        const res = await (0, deps.fetch)(`${httpUrl}/get_group_member_list`, {
          method: "POST",
          headers: { "content-type": "application/json", ...auth },
          body: JSON.stringify({ group_id: Number(gid) }),
          signal: deps.AbortSignal.timeout(10000)
        });
        const body = await res.json().catch(() => ({}));
        if (body?.status !== "ok" || !Array.isArray(body.data)) continue;
        for (const m of body.data) {
          const uid = String(m?.user_id ?? "");
          if (!uid) continue;
          const cur = deps.groupMemberCache.get(uid);
          if (!cur) {
            added += 1;
            deps.groupMemberCache.set(uid, { name: m?.card || m?.nickname || uid, groupId: String(gid), groups: [String(gid)], at: Date.now() });
          } else {
            // 同一个人可能在多个白名单群里：把每个群都记下来，私聊临时会话要用它挑共同群。
            if (!Array.isArray(cur.groups)) cur.groups = cur.groupId ? [cur.groupId] : [];
            if (!cur.groups.includes(String(gid))) cur.groups.push(String(gid));
            cur.at = Date.now();
          }
        }
      } catch {}
    }
    deps.groupMemberRefreshedAt = Date.now();
    (0, deps.log)(`群成员通行证已刷新：${deps.groupMemberCache.size} 人（${groups.length} 个白名单群，新增 ${added}）`);
    return deps.groupMemberCache.size;
  }
// @bridge-function refreshGroupMembers:end

// @bridge-function isGroupMember:start
function isGroupMember(uid) {
    return deps.groupMemberCache.has(String(uid));
  }
// @bridge-function isGroupMember:end

// @bridge-function memberGroupOf:start
// 私聊临时会话要用「共同群」：优先他最近发言的群，没有就退到群成员缓存里记的群。
function memberGroupOf(uid) {
    const hit = deps.groupMemberCache.get(String(uid));
    if (!hit) return '';
    if (Array.isArray(hit.groups) && hit.groups.length) return String(hit.groups[0]);
    return hit.groupId ? String(hit.groupId) : '';
  }
// @bridge-function memberGroupOf:end

// @bridge-function privateQuotaCfg:start
function privateQuotaCfg() {
    const q = deps.cfg.socialV2?.privateQuota ?? {};
    return {
      open: deps.cfg.allow?.privateOpen === true,
      dailyMinutes: Number(q.dailyMinutes) > 0 ? Number(q.dailyMinutes) : 120,
      idleCapMinutes: Number(q.idleCapMinutes) > 0 ? Number(q.idleCapMinutes) : 10
    };
  }
// @bridge-function privateQuotaCfg:end

// @bridge-function quotaLoad:start
function quotaLoad() {
    try { return JSON.parse(deps.fs.readFileSync(deps.PRIVATE_QUOTA_FILE, 'utf8')) || {}; } catch { return {}; }
  }
// @bridge-function quotaLoad:end

// @bridge-function quotaSave:start
function quotaSave(all) {
    try { (0, deps.atomicWriteJson)(deps.PRIVATE_QUOTA_FILE, all); } catch (error) { (0, deps.log)(`写入私聊额度失败：${error?.message ?? error}`); }
  }
// @bridge-function quotaSave:end

// @bridge-function consumePrivateQuota:start
function consumePrivateQuota(uid) {
    const q = privateQuotaCfg();
    const all = quotaLoad();
    const entry = all[uid] ?? {};
    const next = (0, deps.accrueUsage)(entry, Date.now(), { idleCapMs: q.idleCapMinutes * 60 * 1000 });
    const state = (0, deps.quotaState)(next.usedMs, q.dailyMinutes);
    // 跨天时 warned 要跟着重置（entry.date 与今天不同即为新的一天）。
    const sameDay = entry.date === next.date;
    const warnedBefore = sameDay && entry.warned === true;
    const crossedNow = state.exceeded && !warnedBefore;
    all[uid] = { date: next.date, usedMs: next.usedMs, lastAt: next.lastAt, warned: warnedBefore || state.exceeded };
    quotaSave(all);
    return { blocked: state.exceeded, leftMs: state.leftMs, crossedNow };
  }
// @bridge-function consumePrivateQuota:end

// @bridge-function quotaInfo:start
function quotaInfo(uid) {
    const q = privateQuotaCfg();
    const entry = quotaLoad()[String(uid)] ?? {};
    const today = (0, deps.dayKey)(new Date());
    const usedMs = entry.date === today ? Number(entry.usedMs) || 0 : 0;
    const state = (0, deps.quotaState)(usedMs, q.dailyMinutes);
    return {
      date: today,
      usedMs,
      usedMinutes: Math.round((usedMs / 60000) * 10) / 10,
      leftMs: state.leftMs,
      leftText: (0, deps.formatLeft)(state.leftMs),
      percent: state.percent,
      exceeded: state.exceeded,
      dailyMinutes: q.dailyMinutes
    };
  }
// @bridge-function quotaInfo:end
  return { refreshGroupMembers, isGroupMember, memberGroupOf, privateQuotaCfg, quotaLoad, quotaSave, consumePrivateQuota, quotaInfo };
}
