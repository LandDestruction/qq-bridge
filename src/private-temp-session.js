// 私聊临时会话兜底（D67）：临时会话过期后不能凭空建，所以不再遍历白名单群乱试。
//
// 规则：
//   ① 只试「这个 uid 最近发言的那个群」一次；没有记录就不试（凭 no such temp session 硬试 4 个群是噪音）。
//   ② 失败命中 QQ 的临时会话错误 → 按 uid 写 30 分钟冷却（state/private-unreachable.json），冷却期内不再发。
//   ③ 冷却触发那一次，如果对方是白名单群成员，才在群里 @ 他一次兜底提示；陌生人静默。
//
// 这个模块只做纯逻辑（不读 config、不碰网络），bridge/outbound-text 注入 fs 与原子写，测试用临时目录。
export const TEMP_SESSION_COOLDOWN_MS = 30 * 60 * 1000;
// QQ 侧「临时会话不可用」的三种实锤文案（SnowLuma 原样回传）：
//   no such temp session（群会话过期）/ 请先添加对方为好友（陌生人门禁）/ result=16（非好友）
// 兜底再造的字符串可能写成 retcode=16，也一并认（同一含义，不能漏判）。
export const TEMP_SESSION_FAIL_RE = /no such temp session|请先添加对方为好友|result=16|retcode=16/i;

export function isTempSessionFailure(text) {
  return TEMP_SESSION_FAIL_RE.test(String(text ?? ''));
}

/**
 * 按 uid 记「临时会话不可达」的冷却。
 * - file：JSON 路径（state/private-unreachable.json）
 * - fs：node:fs 或等价（测试传临时目录）
 * - writeJson：原子写实现（bridge 传 atomicWriteJson）
 * - now：可注入时钟（测试用推进时间）
 */
export function createPrivateUnreachableStore({ file, fs, writeJson, now = () => Date.now(), cooldownMs = TEMP_SESSION_COOLDOWN_MS, log = () => {} }) {
  let cache = null;
  const skipLogAt = new Map(); // uid -> 上次「冷却中，跳过」日志时间（只在内存里，防刷屏）

  function load() {
    if (cache) return cache;
    cache = {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return cache;
      const t = now();
      for (const [uid, entry] of Object.entries(raw)) {
        const until = Number(entry?.until);
        if (!Number.isFinite(until) || until <= t) continue; // 过期条目直接丢，文件不越滚越大
        cache[String(uid)] = {
          until,
          at: Number(entry.at) || 0,
          reason: String(entry.reason ?? '').slice(0, 200),
          groupId: entry.groupId ? String(entry.groupId) : ''
        };
      }
    } catch { /* 没文件 / 坏文件 → 当作没有冷却，不影响发送 */ }
    return cache;
  }

  function save() {
    try { writeJson(file, cache); } catch (error) { log(`写入私聊临时会话冷却失败：${error?.message ?? error}`); }
  }

  return {
    isTempSessionFailure,
    cooldownMinutes: Math.round(cooldownMs / 60000),
    isCooling(uid) {
      const entry = load()[String(uid)];
      return Boolean(entry && entry.until > now());
    },
    /** 冷却原因/剩余时间，给日志用；不在冷却返回 null。 */
    coolingInfo(uid) {
      const entry = load()[String(uid)];
      if (!entry || entry.until <= now()) return null;
      return { reason: entry.reason, groupId: entry.groupId, leftMs: entry.until - now() };
    },
    /**
     * 记一次「不可达」。newly=这次才是新进入冷却（提示音只在这次发，避免每轮都 @ 人）。
     * 同一 uid 冷却期内重复失败不会延长冷却（until 只在跨窗口后重新计）。
     */
    markUnreachable(uid, info = {}) {
      const key = String(uid);
      const t = now();
      const existing = load()[key];
      const already = Boolean(existing && existing.until > t);
      if (!already) {
        cache[key] = {
          until: t + cooldownMs,
          at: t,
          reason: String(info.reason ?? '').slice(0, 200),
          groupId: info.groupId ? String(info.groupId) : ''
        };
        save();
      }
      return { newly: !already, until: cache[key].until };
    },
    /** 冷却期内每一轮都调用；同 uid 一分钟内只放行一次日志，防刷屏。 */
    shouldLogSkip(uid, windowMs = 60 * 1000) {
      const key = String(uid);
      const t = now();
      if ((skipLogAt.get(key) ?? 0) + windowMs > t) return false;
      skipLogAt.set(key, t);
      return true;
    },
    snapshot() { return { ...load() }; }
  };
}

// 群内兜底提示的固定文案（一次性，冷却触发时发）。
export const TEMP_SESSION_GROUP_HINT = '私聊通道暂时不通（临时会话过期），在群里叫我就行';

/**
 * 私聊临时会话的「试一次」实现。返回 async (uid, message) => boolean。
 *
 * 为什么要抽成模块：outbound-text 的工厂函数已经到了代码规模闸的存量基线（328 行），
 * 把这段分支逻辑塞进去只会把基线顶破；这里做成可注入 fetch/时钟/发群消息的纯服务，
 * 还能用临时目录里的假网关切份测。
 *
 * deps:
 *   cfg（读 snowluma.httpUrl/accessToken 与 allow.groups）、fetch、AbortSignal、log、assertIdentitySendAllowed
 *   recentUserGroup（Map uid->groupId）、store（createPrivateUnreachableStore 的实例）
 *   isGroupMember(uid)（白名单群成员判定）、sendGroupHint(groupId, uid, text)（发群消息，带 @）
 */
export function createTempSessionFallback(deps) {
  return async function sendPrivateViaTempSession(uid, message) {
    const key = String(uid);
    const store = deps.store;
    const cooling = store?.coolingInfo?.(key);
    if (cooling) {
      // 冷却期内不再发；日志一分钟最多一条，避免每来一条消息就刷屏。
      if (store?.shouldLogSkip?.(key) !== false) {
        (0, deps.log)(`私聊临时会话冷却中，跳过 ${key}（群 ${cooling.groupId || '-'}，原因 ${cooling.reason || '临时会话过期'}，剩 ${Math.max(1, Math.ceil(cooling.leftMs / 60000))} 分钟）`);
      }
      return false;
    }
    // D67：只试「这个 uid 最近发言的那个群」一次（以前会遍历全部白名单群硬撞）。
    // 他最近没在群里说过话时，退一步用群成员缓存里记的共同群——否则私聊永远发不出去。
    const seen = deps.recentUserGroup.get(key);
    const cached = seen ? '' : String(deps.memberGroupOf?.(key) || '');
    if (!seen && !cached) {
      (0, deps.log)(`私聊临时会话兜底跳过 ${key}：既没有最近群记录、群成员缓存里也没有共同群`);
      return false;
    }
    const groupId = Number(seen || cached);
    if (!seen) (0, deps.log)(`私聊临时会话用群成员缓存里的共同群 ${key}（群 ${groupId}）`);
    const httpUrl = String(deps.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    let wording = '';
    try {
      await (0, deps.assertFreshHttpIdentitySendAllowed)();
      const res = await (0, deps.fetch)(`${httpUrl}/send_private_msg`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {}) },
        body: JSON.stringify({ user_id: Number(uid), group_id: groupId, message }),
        signal: deps.AbortSignal.timeout(15000)
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.status === 'ok' && body.retcode === 0) {
        (0, deps.log)(`私聊改用临时会话发出 ${uid}（群 ${groupId}）`);
        return true;
      }
      wording = String(body.wording ?? body.message ?? `retcode=${body.retcode ?? res.status}`);
    } catch (error) {
      wording = String(error?.message ?? error);
    }
    // QQ 的「临时会话不可用 / 不是好友」→ 按 uid 写 30 分钟冷却，之后不再空撞。
    if (store?.isTempSessionFailure?.(wording)) {
      const mark = store.markUnreachable(key, { reason: wording, groupId }) ?? { newly: false };
      (0, deps.log)(`私聊临时会话不可达 ${key}（群 ${groupId}）：${wording}；冷却 ${store.cooldownMinutes} 分钟`);
      // 冷却刚触发且对方是白名单群成员：在最近发言的群里 @ 他一次；陌生人静默。
      if (mark.newly && deps.isGroupMember(key)) {
        const groups = (deps.cfg.allow?.groups ?? []).map(String);
        if (groups.includes(String(groupId))) {
          try {
            await deps.sendGroupHint(groupId, key);
            (0, deps.log)(`已在群 ${groupId} @${key} 提示私聊不通`);
          } catch (error) {
            (0, deps.log)(`群内兜底提示发送失败 ${key}（群 ${groupId}）：${error?.message ?? error}`);
          }
        }
      }
      return false;
    }
    (0, deps.log)(`私聊临时会话发送失败 ${key}（群 ${groupId}）：${wording}`);
    return false;
  };
}
