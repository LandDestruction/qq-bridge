// wake-dispatch: extracted bridge responsibilities; no startup side effects.
// Live dependencies: armPendingWakeLease, buildWakePromptV2, busyReasonV2, cancelReplyCheckV2, cfg, clearTimeout, currentMode, deliverPrompt, disarmPendingWakeLease, getSocialV2State, isConversationBusyV2, isSessionAllowedInCurrentMode, isTimerWakeReason, log, pendingWakeKeys, saveSocialV2State, setTimeout, setupSleepTimerV2, socialV2
// 繁忙日志会随每条消息刷一行：群聊里有人连发，日志一分钟能刷十来行同一个原因，
// 真正的异常反而被淹掉。这里按会话节流：20 秒内只写第一行，期间新增的条数并进去
//（事件本身一条不丢——写日志只是记账，pendingWakeReasons 照旧全存）。
const BUSY_LOG_THROTTLE_MS = 20000;
const busyLogState = new Map(); // key -> { at, merged }
function logBusyQueued(deps, key, reason, seq) {
  const now = Date.now();
  const prev = busyLogState.get(key);
  if (prev && now - prev.at < BUSY_LOG_THROTTLE_MS) { prev.merged += 1; return; }
  const merged = prev && prev.merged > 0 ? `，期间另有 ${prev.merged} 条同类已入队` : '';
  const why = (0, deps.busyReasonV2)(key, (0, deps.getSocialV2State)(key));
  (0, deps.log)(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${why}）${merged}`);
  busyLogState.set(key, { at: now, merged: 0 });
}
export function createWakeDispatch(deps) {
// @bridge-function sendWakePromptV2:start
async function sendWakePromptV2(key, reason) {
    if (deps.cfg.socialV2?.enabled === false) return;
    if (deps.currentMode !== 'reserved2' || deps.socialV2.paused) return;
    // 「模型与高峰」里把当前档位选成「无」= 不调用模型、机器人不说话：所有唤醒源
    //（触发/回看/定时/媒体补看）都从这里走，挡在这里最省事也最彻底。
    if (typeof deps.modelRoutingMutedNow === 'function' && deps.modelRoutingMutedNow() === true) {
      (0, deps.log)(`[模型] 当前档位设为「无」，跳过唤醒 ${key}（${reason}）`);
      return;
    }
    // 高峰期只让本地小模型接管群聊：定时唤醒（proactiveCheck/replyCheck/timeout）和
    // 首轮 bootstrap 都不许再打 API —— 否则「高峰期用本地」会被这些定时器偷偷绕过
    //（实测 10:05 还有 group:100000009 的 API 账本条目，就是 replyCheck 打出去的）。
    // 管理员手动唤醒（reason=admin）仍放行，便于运维。
    // 高峰期不再拦唤醒：模型会给峰值切换到便宜模型，但流程必须完整。
    if (!(0, deps.isSessionAllowedInCurrentMode)(key)) {
      (0, deps.log)(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = (0, deps.getSocialV2State)(key);
    // 静默观战兜底：定时回看即使在排队时排上了，也要在真正发送前复核一次潜水态
    //（排队与发送之间可能刚好说完话、或刚被重新配置成潜水）。
    if (reason === 'replyCheck' || reason === 'proactiveCheck') {
      if (typeof deps.quietWatch?.allowsTimerWake === 'function' && !deps.quietWatch.allowsTimerWake(key, st, reason)) return;
    }
    // A 方案：这次唤醒是不是在问梗？在桥接侧先查一次本地梗库，命中就随提示词注入。
    try {
      const memeOn = !(deps.cfg && deps.cfg.socialV2 && deps.cfg.socialV2.memeWiki && deps.cfg.socialV2.memeWiki.prelookup === false);
      if (memeOn && typeof deps.memeWikiPrelookup === 'function') {
        const line = (0, deps.memeWikiPrelookup)(key, st);
        if (line) st.memeWikiLine = line; else delete st.memeWikiLine;
      }
    } catch {}
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if ((0, deps.isConversationBusyV2)(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      logBusyQueued(deps, key, reason, seq);
      return;
    }
    // 唤醒频率硬限制：超限则**延后重试**，不能直接丢弃。直接 return 的后果：
    //   · timeout 唤醒时 setupSleepTimerV2 已经清空 sleepTimer，丢弃后这个会话会停在
    //     「infinite=false、sleepUntil 已过期、没有任何定时器」的静默态，除非重启或
    //     主动机会兜底（默认 30~90 分钟）才可能恢复；
    //   · @/提问被丢弃则要等下一条消息才可能再唤醒。
    // 重试仍然遵守限频（等到窗口腾出位置），只是把「这一枪」补回来。
    const now = Date.now();
    const maxPerMinute = Number(deps.cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = Number(deps.cfg.socialV2?.wake?.maxWakePerHour) || 0;
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour)) {
      let retryAfterMs = 0;
      if (maxPerMinute > 0 && recentMinute >= maxPerMinute) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 60000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 60000 - (now - times[0]) + 500);
      }
      if (maxPerHour > 0 && recentHour >= maxPerHour) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 3600000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 3600000 - (now - times[0]) + 500);
      }
      // 每次只等一小段（最长 60s）：小时级限频不会一次性睡满一小时而错过中途可用的窗口。
      const waitMs = Math.min(60000, Math.max(1000, Math.round(retryAfterMs) || 5000));
      if (!st.rateLimitRetryTimer) {
        st.rateLimitRetryTimer = (0, deps.setTimeout)(() => {
          st.rateLimitRetryTimer = null;
          // 消息类原因在重试前再确认一次：等待窗口里消息可能已被别的回合处理掉，
          // 没必要为一条已经处理过的消息再唤醒一次（定时器类原因与未读无关，不检查）。
          if (!(0, deps.isTimerWakeReason)(reason) && !(Array.isArray(st.unread) && st.unread.length > 0)) {
            (0, deps.log)(`[reserved2] 限频重试前发现未读已清空，跳过 ${key}（${reason}）`);
            return;
          }
          void sendWakePromptV2(key, reason).catch((error) => (0, deps.log)(`[reserved2] 限频重试唤醒异常 ${key}:`, error?.message ?? error));
        }, waitMs);
        st.rateLimitRetryTimer.unref?.();
      }
      (0, deps.log)(`[reserved2] 唤醒频率超限，${Math.round(waitMs / 1000)}s 后重试 ${key}（${reason}）`);
      return;
    }
    // Only a real new wake resets observation; skipped/busy candidates must
    // preserve the current turn's progress through its required wait window.
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    (0, deps.cancelReplyCheckV2)(key); // 本次唤醒已接管，清理仍在排队的回复检查
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      (0, deps.clearTimeout)(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    (0, deps.saveSocialV2State)();
    const promptText = (0, deps.buildWakePromptV2)(key, reason);
    (0, deps.log)(`[reserved2] 唤醒 ${key}（${reason}）`);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      (0, deps.saveSocialV2State)();
    };
    try {
      deps.pendingWakeKeys.add(key);
      (0, deps.armPendingWakeLease)(key);
      const result = await (0, deps.deliverPrompt)(key, promptText, { wakeReason: reason });
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          (0, deps.saveSocialV2State)();
          (0, deps.setupSleepTimerV2)(key);
        }
      };
      if (result && result.ok === false) {
        deps.pendingWakeKeys.delete(key);
        (0, deps.disarmPendingWakeLease)(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        (0, deps.log)(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        (0, deps.log)(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
    } catch (error) {
      deps.pendingWakeKeys.delete(key);
      (0, deps.disarmPendingWakeLease)(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        (0, deps.saveSocialV2State)();
        (0, deps.setupSleepTimerV2)(key);
      }
      (0, deps.log)(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
    }
  }
// @bridge-function sendWakePromptV2:end

// @bridge-function scheduleMediaFollowup:start
// 这一轮有图、却没能在当前模型上看到（图晚到 / 模型无视觉）时排一次补看：
// 8 秒后再唤醒一次，那时 recentMediaTurns 已命中 → ensureChatModel 会换视觉模型。
// 只在 key 有效且当前不在会话里时也不管——sendWakePromptV2 自己会按 busy 逻辑排队。
function scheduleMediaFollowup(key, reason = 'mediaFollowup') {
    if (!key) return false;
    const delayMs = 8000;
    (0, deps.setTimeout)(() => {
      void sendWakePromptV2(key, reason).catch((error) => (0, deps.log)(`[media] 补看唤醒异常 ${key}: ${error?.message ?? error}`));
    }, delayMs);
    (0, deps.log)(`[media] 本轮有图但模型看不了，${Math.round(delayMs / 1000)}s 后补看一次 ${key}（${reason}）`);
    return true;
  }
// @bridge-function scheduleMediaFollowup:end

  return { sendWakePromptV2, scheduleMediaFollowup };
}
