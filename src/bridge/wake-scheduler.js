// wake-scheduler: extracted bridge responsibilities; no startup side effects.
// Live dependencies: TIMER_WAKE_REASONS, TURN_BUSY_LEASE_MS, WAKE_PRIORITY, aiBlacklistCheck, cfg, clearTimeout, collectors, currentMode, ensureWakeableV2, getSocialV2State, isSessionAllowedInCurrentMode, log, markReadCalledKeys, messageMediaStore, pendingWakeKeys, promptQueues, sendWakePromptV2, setTimeout, socialV2, state, turnLeaseNoted, v2TurnStartAt, wakeConfigMissCount, wakeConfigUpdatedKeys
// D70：主动检查前的黑名单判定（定义在工厂外，避免撑大冻结的 createWakeScheduler 长度）。
// trigger 默认 proactiveCheck；回复回看（replyCheck）也走这里——它同样是「自己凑上去看」的唤醒，
// 对方若是黑名单里的 AI，看一眼就会顺着接话，正是「机器人之间尬聊」的主要入口。
function aiBlacklistProactiveVeto(key, st, check, trigger = 'proactiveCheck') {
  const lastSpeaker = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf && m.userId);
  return check(key, lastSpeaker?.userId ?? null, trigger);
}
// 静默观战闸：潜水期「定时回看/主动检查」一律不排。放在工厂外，避免撑大冻结的 createWakeScheduler 长度。
function quietBlocksTimerWake(deps, key, st, reason) {
  const quiet = deps.quietWatch;
  return typeof quiet?.allowsTimerWake === 'function' && !quiet.allowsTimerWake(key, st, reason);
}
export function createWakeScheduler(deps) {
// @bridge-function cancelReplyCheckV2:start
function cancelReplyCheckV2(key) {
    const st = deps.socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    (0, deps.clearTimeout)(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }
// @bridge-function cancelReplyCheckV2:end

// @bridge-function scheduleReplyCheckV2:start
function scheduleReplyCheckV2(key) {
    if (deps.cfg.socialV2?.enabled === false) return;
    if (deps.socialV2.paused || deps.currentMode !== 'reserved2') return;
    const st = (0, deps.getSocialV2State)(key);
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer || quietBlocksTimerWake(deps, key, st, 'replyCheck')) return;
    let delay = Math.max(1000, Number(deps.cfg.socialV2?.autoReplyCheckMs) || 30000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    st.replyCheckTimer = (0, deps.setTimeout)(() => {
      st.replyCheckTimer = null; if (aiBlacklistProactiveVeto(key, st, deps.aiBlacklistCheck, 'replyCheck')?.skip) return; // 回看也过黑名单
      void (0, deps.sendWakePromptV2)(key, 'replyCheck').catch((error) => (0, deps.log)(`[reserved2] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    (0, deps.log)(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }
// @bridge-function scheduleReplyCheckV2:end

// @bridge-function busyReasonV2:start
function busyReasonV2(key, st) {
    if (st?.pendingWakeTimer) return 'pendingWakeTimer';
    if (deps.pendingWakeKeys.has(key)) return 'pendingWakeKey';
    const q = deps.promptQueues.get(key);
    if (q?.running) return 'promptRunning';
    if (q && q.queue.length > 0) return 'promptQueued';
    const sid = deps.state.sessions[key];
    if (sid) {
      const startedAt = Number(deps.v2TurnStartAt.get(sid));
      if (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < deps.TURN_BUSY_LEASE_MS) return 'turn';
    }
    return 'unknown';
  }
// @bridge-function busyReasonV2:end

// @bridge-function isConversationBusyV2:start
function isConversationBusyV2(key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (deps.pendingWakeKeys.has(key)) return true;
    const q = deps.promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = deps.state.sessions[key];
    if (!sid) return false;
    // 回合只按「起始时间 + 租约」判忙，**不再**只看 Map 里有没有键：
    //   · 有 collector 但没起始时间（杂散事件重建出来的）→ 无法证明还活着，不判忙；
    //   · 起始时间超过租约（turn/end 丢了 / DSH 重启把回合丢了）→ 不判忙；
    // collector 保留，所以万一回合其实还活着，它的回复仍会被 flush，只是允许新唤醒排队。
    const startedAt = Number(deps.v2TurnStartAt.get(sid));
    const hasTurn = Number.isFinite(startedAt) && startedAt > 0;
    const collector = deps.collectors.has(sid);
    if (!hasTurn) return false;
    if (Date.now() - startedAt < deps.TURN_BUSY_LEASE_MS) return true;
    if (collector && !deps.turnLeaseNoted.has(sid)) {
      deps.turnLeaseNoted.add(sid);
      (0, deps.log)(`[reserved2] 回合判忙租约已过期（${sid}，起始 ${Math.round((Date.now() - startedAt) / 60000)} 分钟前），解除忙碌；collector 保留，迟到回复仍会 flush`);
    }
    return false;
  }
// @bridge-function isConversationBusyV2:end

// @bridge-function wakePriorityV2:start
function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return deps.WAKE_PRIORITY[base] ?? 0;
  }
// @bridge-function wakePriorityV2:end

// @bridge-function isTimerWakeReason:start
function isTimerWakeReason(reason) {
    return deps.TIMER_WAKE_REASONS.has(String(reason ?? '').split(':')[0]);
  }
// @bridge-function isTimerWakeReason:end

// @bridge-function scheduleWakeV2:start
function scheduleWakeV2(key, reason) {
    if (deps.cfg.socialV2?.enabled === false) return;
    if (deps.socialV2.paused) return;
    if (!(0, deps.isSessionAllowedInCurrentMode)(key)) {
      (0, deps.log)(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = (0, deps.getSocialV2State)(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        (0, deps.log)(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      (0, deps.log)(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReasonV2(key, st)}）`);
      return;
    }
    cancelReplyCheckV2(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      (0, deps.clearTimeout)(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    const batchMs = Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000);
    st.pendingWakeTimer = (0, deps.setTimeout)(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void (0, deps.sendWakePromptV2)(key, finalReason).catch((error) => (0, deps.log)(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
    }, batchMs);
    // 与其它 per-conversation 定时器保持一致：别让一个待唤醒定时器把进程钉住不退出。
    st.pendingWakeTimer.unref?.();
    (0, deps.log)(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  }
// @bridge-function scheduleWakeV2:end

// @bridge-function replayPendingWakeReasonsV2:start
function replayPendingWakeReasonsV2(key) {
    const st = (0, deps.getSocialV2State)(key);
    if (!Array.isArray(st.pendingWakeReasons) || !st.pendingWakeReasons.length) return null;
    const item = st.pendingWakeReasons.shift();
    if (!item || typeof item !== 'object') return null;
    if (/^ai-blacklist:/.test(String(item.reason ?? ''))) { // D70：拦截记录只供事后查，绝不当积压唤醒重放
      (0, deps.log)(`[reserved2] ${key} 跳过重放：${item.reason}（AI 黑名单拦截记录）`);
      return { reason: item.reason, action: 'skipped' };
    }
    if (isTimerWakeReason(item.reason)) {
      if (item.reason === 'timeout') {
        (0, deps.log)(`[reserved2] ${key} 补收繁忙期间到期的潜水定时器`);
        setupSleepTimerV2(key);
      } else if (item.reason === 'replyCheck') {
        (0, deps.log)(`[reserved2] ${key} 补排繁忙期间的回复检查`);
        scheduleReplyCheckV2(key);
      } else if (item.reason === 'proactiveCheck' || item.reason === 'glance') {
        // 主动机会与抬眼机会都是随机重排的，错过一次可接受（也不该在回合结束时立刻补一刀）。
        (0, deps.log)(`[reserved2] ${key} 繁忙期间的定时机会已过期，跳过补发`);
      } else {
        (0, deps.log)(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}`);
        scheduleWakeV2(key, item.reason);
      }
      return { reason: item.reason, action: 'timer' };
    }
    const stillRelevant = Array.isArray(st.unread) && st.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
    if (stillRelevant) {
      (0, deps.log)(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}`);
      scheduleWakeV2(key, item.reason);
      return { reason: item.reason, action: 'replayed' };
    }
    (0, deps.log)(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 已被当前回合处理，跳过补发`);
    return { reason: item.reason, action: 'skipped' };
  }
// @bridge-function replayPendingWakeReasonsV2:end

// @bridge-function setupSleepTimerV2:start
function setupSleepTimerV2(key) {
    if (deps.cfg.socialV2?.enabled === false) return;
    if (!(0, deps.isSessionAllowedInCurrentMode)(key)) return;
    const st = (0, deps.getSocialV2State)(key);
    cancelReplyCheckV2(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      (0, deps.clearTimeout)(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (deps.socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void (0, deps.sendWakePromptV2)(key, 'timeout').catch((error) => (0, deps.log)(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；这里刻意用 100 秒级小步长续期（不是 24 天上限），
    // 每次续期都用 Date.now() 重算剩余时间，系统时钟被校正/跳变时能很快纠正，也不会提前唤醒。
    const MAX_TIMEOUT_MS = 100009;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = (0, deps.setTimeout)(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      (0, deps.log)(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 1000)} 秒后续期`);
      return;
    }
    st.sleepTimer = (0, deps.setTimeout)(() => {
      st.sleepTimer = null;
      void (0, deps.sendWakePromptV2)(key, 'timeout').catch((error) => (0, deps.log)(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    (0, deps.log)(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }
// @bridge-function setupSleepTimerV2:end

// @bridge-function cancelProactiveCheckV2:start
function cancelProactiveCheckV2(key) {
    const st = deps.socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    (0, deps.clearTimeout)(st.proactiveTimer);
    st.proactiveTimer = null;
  }
// @bridge-function cancelProactiveCheckV2:end

// @bridge-function scheduleProactiveCheckV2:start
function scheduleProactiveCheckV2(key) {
    if (deps.cfg.socialV2?.proactive?.enabled === false) return;
    if (deps.socialV2.paused || deps.currentMode !== 'reserved2') return;
    if (!(0, deps.isSessionAllowedInCurrentMode)(key)) return;
    const st = (0, deps.getSocialV2State)(key);
    if (st.proactiveTimer || quietBlocksTimerWake(deps, key, st, 'proactiveCheck')) return;
    const p = deps.cfg.socialV2?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = (0, deps.setTimeout)(() => {
      st.proactiveTimer = null;
      (0, deps.ensureWakeableV2)(st, { key });
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 8) prob *= 0.3;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      if (idle >= idleThreshold && Math.random() < prob && !isConversationBusyV2(key, st)) {
        // D70：主动检查也过 AI 黑名单闸（用会话里最近一个非自己发言的人判定；没人发言就放行）。
        const veto = aiBlacklistProactiveVeto(key, st, deps.aiBlacklistCheck);
        if (!veto || !veto.skip) void (0, deps.sendWakePromptV2)(key, 'proactiveCheck').catch((error) => (0, deps.log)(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    (0, deps.log)(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }
// @bridge-function scheduleProactiveCheckV2:end

// @bridge-function clearSocialV2Timers:start
function clearSocialV2Timers(key) {
    const st = deps.socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      (0, deps.clearTimeout)(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      (0, deps.clearTimeout)(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      (0, deps.clearTimeout)(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      (0, deps.clearTimeout)(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    if (st.rateLimitRetryTimer) {
      (0, deps.clearTimeout)(st.rateLimitRetryTimer);
      st.rateLimitRetryTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }
// @bridge-function clearSocialV2Timers:end

// @bridge-function clearAllSocialV2Timers:start
function clearAllSocialV2Timers() {
    for (const key of deps.socialV2.conversations.keys()) clearSocialV2Timers(key);
    deps.pendingWakeKeys.clear();
    deps.wakeConfigUpdatedKeys.clear();
    deps.markReadCalledKeys.clear();
    deps.wakeConfigMissCount.clear();
    deps.messageMediaStore.clear();
  }
// @bridge-function clearAllSocialV2Timers:end
  return { cancelReplyCheckV2, scheduleReplyCheckV2, busyReasonV2, isConversationBusyV2, wakePriorityV2, isTimerWakeReason, scheduleWakeV2, replayPendingWakeReasonsV2, setupSleepTimerV2, cancelProactiveCheckV2, scheduleProactiveCheckV2, clearSocialV2Timers, clearAllSocialV2Timers };
}
