// mux-runtime: extracted bridge responsibilities; no startup side effects.
// Live dependencies: KNOWN_AGENT_TOKENS, MALFORMED_GIVEUP_TEXT, SENSITIVE_RE, SILENT_MARKER, SILENT_TURN_TIMEOUT_MS, activeModelOverride, activeWaits, api, appendActivity, appendToolLog, armPendingWakeLease, budgetRunnerInstance, budgetTickForTurn, buildWakeReminderPromptV2, cancelPendingEntry, cfg, chatErrorNotice, clearAllPendingWakeLeases, clearTimeout, collectors, createTurnCollector, currentMode, currentTurnBySession, decideMalformedAction, defaultWakeConfigV2, deliverPrompt, describeSensitiveMatch, disarmPendingWakeLease, discoverDshBaseUrl, ensureChatModel, ensureWakeableV2, getSocialV2State, isCurrentSession, isMalformedToolJson, isSendToolName, isSilentMarker, isSocialEnabled, keyHasRecentMedia, lastPromptByKey, lastSendSucceeded, learnerCollectors, learnerSessions, learnerWaiters, log, malformedRetries, malformedToolJsonCount, markReadCalledKeys, mdToPlain, modelSelectionEpoch, noteExternalTurnOk, pendingSendToolCalls, pendingWakeKeys, persistDshBaseUrl, pickUsableModel, planSocialTimeline, probeAvailableModels, recordModelFailure, recordSessionSnapshot, recordSessionUsage, registerPending, replayPendingWakeReasonsV2, retriedAfterEmpty, retriedAfterFallback, reverse, sanitizeToolArgs, saveSocialV2State, sendBurstToQQ, sendToQQ, sendToolSucceededSessions, setTimeout, shouldAuditKey, shouldBlockSilentReply, slangLearnerSessionId, sleep, social, socialState, text, toolCallNames, tryLocalFallback, turnLastEventAt, turnLeaseNoted, turnSeqBySession, v2TurnStartAt, wakeConfigMissCount, wakeConfigUpdatedKeys
import { agentTransportOf, guardTurnSteps, muxCurrentStep, describeToolResult, MUX_ABORT_MARKS } from './mux-helpers.js';

// @bridge-function trackTurnEvent:start
function trackTurnEvent(deps, sessionId, event) {

  let collector = deps.collectors.get(sessionId); // 一轮制：turn/end 立刻切回普通模型
  if (event?.type === 'turn/end') { try { deps.clearMediaTurnForSession?.(sessionId); } catch {} }
  if (!collector && event?.type === 'turn/start') {
    collector = agentTransportOf(deps).createCollector();
    deps.collectors.set(sessionId, collector);
  }
  const ended = collector ? collector.push(event) : null;
  if (ended) {
    // 回合正常收尾：collector 立刻释放。v2TurnStartAt 留给调用方（无行动判定要用它），
    // 调用方在 `if (ended)` 分支里用完再删。
    deps.collectors.delete(sessionId);
  } else if (event?.type === 'turn/end' && (!collector || collector.size?.() === 0)) {
    deps.collectors.delete(sessionId);
    deps.v2TurnStartAt.delete(sessionId);
    deps.turnLeaseNoted.delete(sessionId);
  }
  return { collector, ended };
}
// @bridge-function trackTurnEvent:end
async function handleTurnEnd(deps, frame, key, ended) {

  // 工具维度 token 归因：一轮结束时按「本轮工具调用次数」均摊入账。
  // 放在最前面、且失败只记日志：统计是旁路，绝不能影响回复/降级/预算这些正事。
  try {
    const tokenTools = deps.tokenTools;
    if (tokenTools && typeof tokenTools.recordTurn === 'function') {
      await tokenTools.recordTurn({
        sessionId: frame.sessionId,
        turn: deps.currentTurnBySession.get(frame.sessionId) ?? null
      });
    }
  } catch (error) {
    (0, deps.log)(`[工具归因] 记录失败（不影响聊天）：${error?.message ?? error}`);
  }
  // D45 上下文预算：每轮结束按 DSH 回报的 contextPressure 判断要不要换会话。
  // D51：映射不一致时**不许静默跳过**（重启后 DSH 恢复的「进行中回合」会整段漏检），
  // 一律打 warn 并交给 10 分钟/每 10 轮的兜底 sweep。
  // fire-and-forget：内部 5 秒 RPC 预算不能拖慢下面的回复发送；异常一律吞掉。
  if (key) {
    const pending = (0, deps.budgetTickForTurn)(key, frame.sessionId);
    if (pending && typeof pending.catch === 'function') {
      void pending.catch((error) => (0, deps.log)('[预算] 检查失败（本轮放行）:', error?.message ?? error));
    }
  } else {
    (0, deps.budgetRunnerInstance)().noteNoKey(frame.sessionId);
  }
  // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
  // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
  const silentQueueNow = deps.social.silentTurns.get(frame.sessionId) ?? [];
  const isSilentTurn = silentQueueNow.length > 0;
  if (deps.currentMode === 'reserved2' && key && !isSilentTurn) {
    const st = (0, deps.getSocialV2State)(key);
    const turnStart = deps.v2TurnStartAt.get(frame.sessionId) ?? 0;
    const sendToolHit = deps.sendToolSucceededSessions.has(frame.sessionId);
    // turn/start 丢了（重连后由快照补发的回合）就无从判断「这一轮有没有行动」：
    // 此时记 miss 会冤枉 AI，连续 3 次就把 AI 自己设的唤醒配置重置成默认值。
    if (turnStart > 0 || sendToolHit) {
      const actionTaken = sendToolHit || (turnStart > 0 && st.lastActionAt >= turnStart);
      if (actionTaken) {
        st.wakeConfig.noActionCount = 0;
      } else {
        st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
        const limit = Number(deps.cfg.socialV2?.wake?.noActionLimit) || 3;
        if (st.wakeConfig.noActionCount >= limit) {
          (0, deps.log)(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
          st.wakeConfig = (0, deps.defaultWakeConfigV2)();
          st.bootstrapSent = true;
          st.wakeConfig.noActionCount = 0;
        }
      }
      (0, deps.saveSocialV2State)();
    } else {
      (0, deps.log)(`[reserved2] ${key} 回合结束但缺少 turn/start（重连补发），跳过无行动计数`);
    }
  }
  deps.v2TurnStartAt.delete(frame.sessionId);
  deps.collectors.delete(frame.sessionId);
  deps.turnLeaseNoted.delete(frame.sessionId);
  const sendToolSucceeded = deps.sendToolSucceededSessions.has(frame.sessionId);
  deps.sendToolSucceededSessions.delete(frame.sessionId);
  deps.pendingSendToolCalls.delete(frame.sessionId);
  deps.toolCallNames.delete(frame.sessionId);
  // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
  const isFarewell = deps.social.exitingSessions.has(frame.sessionId);
  if (isFarewell) deps.social.exitingSessions.delete(frame.sessionId);
  // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
  // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
  const silentQueue = deps.social.silentTurns.get(frame.sessionId) ?? [];
  const silentNow = Date.now();
  while (silentQueue.length && silentNow - silentQueue[0].ts > deps.SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
  if (silentQueue.length > 0) {
    silentQueue.shift();
    if (silentQueue.length > 0) deps.social.silentTurns.set(frame.sessionId, silentQueue);
    else deps.social.silentTurns.delete(frame.sessionId);
    (0, deps.log)(`摘要投喂 turn 结束，静默 (${key})`);
    return;
  }
  // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
  // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
  if (deps.pendingWakeKeys.has(key)) {
    deps.pendingWakeKeys.delete(key);
    (0, deps.disarmPendingWakeLease)(key);
    if (deps.wakeConfigUpdatedKeys.has(key) || deps.markReadCalledKeys.has(key)) {
      (0, deps.ensureWakeableV2)((0, deps.getSocialV2State)(key), { key });
      deps.wakeConfigUpdatedKeys.delete(key);
      deps.markReadCalledKeys.delete(key);
      deps.wakeConfigMissCount.delete(key);
    } else {
      const currentMiss = (deps.wakeConfigMissCount.get(key) ?? 0) + 1;
      const maxReminders = Number(deps.cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
      if (currentMiss < maxReminders) {
        deps.wakeConfigMissCount.set(key, currentMiss);
        deps.pendingWakeKeys.add(key);
        (0, deps.armPendingWakeLease)(key);
        (0, deps.deliverPrompt)(key, (0, deps.buildWakeReminderPromptV2)(key)).then((result) => {
          if (result && result.ok === false) {
            deps.pendingWakeKeys.delete(key);
            (0, deps.disarmPendingWakeLease)(key);
          }
        }).catch((error) => {
          deps.pendingWakeKeys.delete(key);
          (0, deps.disarmPendingWakeLease)(key);
          (0, deps.log)(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
        });
        (0, deps.log)(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
      } else {
        const st = (0, deps.getSocialV2State)(key);
        st.wakeConfig = (0, deps.defaultWakeConfigV2)();
        (0, deps.saveSocialV2State)();
        (0, deps.log)(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
      }
    }
  }
  // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次（定时器类与消息类语义不同，
  // 详见 replayPendingWakeReasonsV2 的注释）。
  (0, deps.replayPendingWakeReasonsV2)(key);
  // 这一轮外部模型正常跑完了：清掉连续失败计数；若之前是本地在接管，切回主链路。
  if (ended.reason.kind === 'completed') (0, deps.noteExternalTurnOk)(key);

  if (ended.reason.kind === 'completed' && ended.text.trim()) {
    await handleCompletedReply(deps, frame, key, isFarewell, sendToolSucceeded, ended);
  } else if (ended.reason.kind === 'error') {
    await handleTurnError(deps, frame, key, isFarewell, ended);
  } else if (ended.reason.kind === 'aborted') {

  MUX_ABORT_MARKS.set(frame.sessionId, Date.now());
  (0, deps.log)(`⏹️ 回合被中止 (${key})`); // 中止只写日志：群里播报「已停止」是系统口吻，真人不会这么说
  if (isFarewell) {
    const st = (0, deps.socialState)(key);
    if (st.phase === 'exiting') {
      st.phase = 'idle';
      st.activeDeadlineAt = 0;
      st.activeExitAt = 0;
      (0, deps.log)(`社交模式：${key} 退场发言中止，回到观望`);
    }
  }

  } else if (!ended.text.trim()) {

  // completed 但没文本（纯工具调用回合，或模型返回空）。
  (0, deps.log)(`回合完成但无文本 (${key})`);
  // 群聊里「被 @ 却没文本」= 用户看到的是彻底没反应。空回复重试一次（换稳定模型），
  // 实测 MiMo flash 偶发空 content（探针也复现过）。
  if (String(key).startsWith('group:') && !deps.retriedAfterEmpty.has(key)) {
    const lastText = deps.lastPromptByKey.get(key) || '';
    if (lastText) {
      deps.retriedAfterEmpty.add(key);
      (0, deps.setTimeout)(() => {
        deps.retriedAfterEmpty.delete(key); // 允许下一轮再兜底，但不是同一条循环
      }, 60000).unref?.();
      deps.activeModelOverride = { provider: 'deepseek-account', model: 'deepseek-flash', since: Date.now(), reason: 'empty reply' };
      deps.modelSelectionEpoch += 1;
      (0, deps.log)(`[空回复] 用 deepseek-account/deepseek-flash 重试一次 (${key})`);
      (0, deps.setTimeout)(() => {
        (0, deps.deliverPrompt)(key, lastText, { wakeReason: 'replyCheck' })
          .then(() => (0, deps.log)(`[空回复] 重试已投递 (${key})`))
          .catch((e) => (0, deps.log)(`[空回复] 重试失败 (${key})：${e?.message ?? e}`));
      }, 0);
    }
  }
  if (isFarewell) {
    const st = (0, deps.socialState)(key);
    if (st.phase === 'exiting') {
      st.phase = 'idle';
      st.activeDeadlineAt = 0;
      st.activeExitAt = 0;
      (0, deps.log)(`社交模式：${key} 退场回合无文本，回到观望`);
    }
  }
  }
}
async function handleCompletedReply(deps, frame, key, isFarewell, sendToolSucceeded, ended) {

  const plain = (0, deps.mdToPlain)(ended.text);
  // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
  if (!plain.trim()) {
    (0, deps.log)(`agent 回复为空（仅格式/空白）(${key})`);
    if (isFarewell) {
      const st = (0, deps.socialState)(key);
      if (st.phase === 'exiting') {
        st.phase = 'idle';
        st.activeDeadlineAt = 0;
        st.activeExitAt = 0;
        (0, deps.log)(`社交模式：${key} 空退场回合，回到观望`);
      }
    }
    return;
  }
  // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
  if ((0, deps.isSilentMarker)(plain)) {
    (0, deps.log)(`社交模式：AI 选择静默（${deps.SILENT_MARKER}）(${key})`);
    if (isFarewell) {
      const st = (0, deps.socialState)(key);
      if (st.phase === 'exiting') {
        st.phase = 'idle';
        st.activeDeadlineAt = 0;
        st.activeExitAt = 0;
        (0, deps.log)(`社交模式：${key} 退场选择静默，回到观望`);
      }
    }
    return;
  }
  // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
  if (sendToolSucceeded) {
    (0, deps.log)(`工具已发送消息，跳过自动转发 (${key})`);
    if (isFarewell) {
      const st = (0, deps.socialState)(key);
      if (st.phase === 'exiting') {
        st.phase = 'idle';
        st.activeDeadlineAt = 0;
        st.activeExitAt = 0;
        (0, deps.log)(`社交模式：${key} 工具发送后退场完成，回到观望`);
      }
    }
    return;
  }
  // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
  const hasKnownToken = [...deps.KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
  if ((0, deps.shouldAuditKey)(key) && (deps.SENSITIVE_RE.test(plain) || hasKnownToken)) {
    const hit = hasKnownToken ? { name: 'known-agent-token', excerpt: '***', length: 0 } : ((0, deps.describeSensitiveMatch)(deps.text) || { name: 'unknown', excerpt: '***', length: 0 });
(0, deps.log)(`⚠️ 回复被安全策略拦截 (${key})：规则=${hit.name} 片段=${hit.excerpt} 长度=${hit.length}${hasKnownToken ? '（命中已知会话令牌名单）' : ''}`);
    (0, deps.appendActivity)(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
    if (deps.cfg.security?.interceptNotify !== false) {
      (0, deps.log)(`[agent] 回复含疑似敏感信息，已拦截不发群（${hasKnownToken ? '会话令牌' : '本机路径/凭据'}）`);
    }
    if (isFarewell) {
      const st = (0, deps.socialState)(key);
      if (st.phase === 'exiting') {
        st.phase = 'idle';
        st.activeDeadlineAt = 0;
        st.activeExitAt = 0;
        (0, deps.log)(`社交模式：${key} 退场发言被拦截，回到观望`);
      }
    }
    return;
  }
  // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
  if ((0, deps.isSocialEnabled)()) {
    if ((0, deps.shouldBlockSilentReply)(key)) {
      (0, deps.log)(`静默模式，拦截在途回复 (${key})`);
      (0, deps.appendActivity)(`${key} 静默模式，拦截在途回复`);
      if (isFarewell) {
        const st = (0, deps.socialState)(key);
        if (st.phase === 'exiting') {
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          (0, deps.log)(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
        }
      }
      return;
    }
    const timeline = (0, deps.planSocialTimeline)(plain, deps.cfg.social);
    const messages = timeline.main;
    (0, deps.log)(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
    (0, deps.appendActivity)(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
    if (messages.length > 1) {
      await (0, deps.sendBurstToQQ)(key, messages, deps.cfg.social);
    } else {
      await (0, deps.sendToQQ)(key, messages[0]);
    }
    // 发言后刷新活跃时间，并调度可能的二次补刀
    const st = (0, deps.socialState)(key);
    if (isFarewell) {
      // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
      st.phase = 'idle';
      st.activeDeadlineAt = 0;
      st.activeExitAt = 0;
      (0, deps.log)(`社交模式：${key} 退场发言完成，进入观望`);
    } else if (st.phase === 'exiting') {
      // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
      (0, deps.log)(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
    } else {
      if ((0, deps.lastSendSucceeded)(key)) {
        st.lastActiveMessageAt = Date.now();
        st.lastAiReplyAt = Date.now();
        (0, deps.log)(`社交模式：发言完成，刷新活跃时间 (${key})`);
      } else {
        // 发送其实失败了（网关报错/超时/被限流）。旧代码照样刷新时间戳，
        // 于是「我说过话了」这个判断被写进状态：主动发言概率被压低、
        // 活跃调度往前走，而群里根本没收到消息。这里不刷新，让下一轮照常补上。
        (0, deps.log)(`社交模式：${key} 本轮发言未送达（QQ 发送失败），不刷新活跃时间`);
      }
    }
  } else if (deps.currentMode === 'reserved2') {
    (0, deps.log)(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
    (0, deps.appendActivity)(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
  } else {
    if ((0, deps.shouldBlockSilentReply)(key)) {
      (0, deps.log)(`静默模式，拦截在途回复 (${key})`);
      (0, deps.appendActivity)(`${key} 静默模式，拦截在途回复`);
      return;
    }
    (0, deps.log)(`agent 回复 (${key}) ${plain.length} 字`);
    (0, deps.appendActivity)(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
    await (0, deps.sendToQQ)(key, plain);
  }

}
async function handleTurnError(deps, frame, key, isFarewell, ended) {

  const msg = ended.reason.error?.message ?? '未知错误';
  const safeMsg = (0, deps.shouldAuditKey)(key) && deps.SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
  // 以前这里只发 QQ、不写日志：出问题时 bridge.log 里什么都没有，排查只能靠猜（PR #24）。
  (0, deps.log)(`⚠️ agent 处理出错 (${key})：${safeMsg}`);
  (0, deps.appendActivity)(`${key} agent 处理出错：${safeMsg.slice(0, 80)}`);
  if ((0, deps.isMalformedToolJson)(msg)) {
    deps.malformedToolJsonCount += 1;
    const mSid = frame.sessionId;
    const mAttempts = deps.malformedRetries.get(mSid) || 0;
    const action = (0, deps.decideMalformedAction)({ attempts: mAttempts });
    const mText = deps.lastPromptByKey.get(key) || "";
    (0, deps.log)(`⚠️ malformed tool-call JSON (${key}, 第 ${mAttempts + 1} 次)：决策=${action}`);
    if (mText && action !== "give-up") {
      deps.malformedRetries.set(mSid, mAttempts + 1);
      if (action === "retry-fallback") {
        try {
          const cur = deps.activeModelOverride || { provider: deps.cfg.dsh?.provider, model: deps.cfg.dsh?.model };
          const available = await (0, deps.probeAvailableModels)().catch(() => []);
          // malformed 专用优先候选：deepseek-account/deepseek-v4-pro（纯文字/工具轮更稳）。
          // **含图轮绝不能切过去**（pro 不支持图片），否则等于把图丢掉。
          const hasMedia = Boolean(key && (0, deps.keyHasRecentMedia)(key));
          const preferMalformed = hasMedia
            ? null
            : available.find((m) => String(m.provider) === "deepseek-account" && String(m.model) === "deepseek-v4-pro");
          const picked = preferMalformed || (0, deps.pickUsableModel)({ provider: cur.provider, model: cur.model, available });
          if (picked) {
            deps.activeModelOverride = { provider: String(picked.provider || cur.provider), model: String(picked.model), since: Date.now(), reason: "malformed tool-call json" };
            deps.modelSelectionEpoch += 1;
            (0, deps.log)(`[malformed] → 切 ${deps.activeModelOverride.provider}/${deps.activeModelOverride.model} 重试（${hasMedia ? "含图轮保持视觉模型" : "纯文字/工具轮优先 pro"}）`);
          } else {
            (0, deps.log)("[malformed] 没有可替换的模型，仍用当前模型重试");
          }
        } catch (e) { (0, deps.log)(`[malformed] 换模型失败：${e?.message ?? e}`); }
      }
      (0, deps.setTimeout)(() => {
        (0, deps.ensureChatModel)(mSid, key)
          .then(() => (0, deps.deliverPrompt)(key, mText, { retryAfterMalformed: true }))
          .then(() => (0, deps.log)(`✅ malformed 重试已投递（${action}） (${key})`))
          .catch((e) => (0, deps.log)(`⚠️ malformed 重试投递失败 (${key})：${e?.message ?? e}`));
      }, 0);
      return;
    }
    if (action === "give-up") {
      (0, deps.log)(`[malformed] ${key} 两次重试仍失败，已发中性提示`);
      await (0, deps.sendToQQ)(key, deps.MALFORMED_GIVEUP_TEXT);
      deps.malformedRetries.delete(mSid);
      return;
    }
    (0, deps.log)(`[malformed] ${key} 无原文可重投，按普通错误处理`);
  }
  // 降级顺序（从高到低）：主模型 → config.dsh.modelFallbacks 里的备用模型 → 本地 8B。
  // 以前是先试本地、再切备用，一次瞬时 503 就会把群里的回复换成 8B 小模型，
  // 配好的 deepseek-v4-pro 备用永远用不上 —— 与「本地是最后一道防线」正好相反。
  // 额度/限流/模型不可用/内容被拒/上下文超长：先切备用模型（recordModelFailure 负责
  // activeModelOverride 与 modelSelectionEpoch），**本轮不回话**，下一轮起用备用模型。
  const failureResult = await (0, deps.recordModelFailure)(key, msg);
  // 三级降级链的第三级是「不可用」：到这儿就明确告诉群友，而不是再说「出了点问题」。
  if (failureResult === 'blocked') {
    const mediaNow = Boolean(key && (0, deps.keyHasRecentMedia)(key));
    (0, deps.log)(`[模型降级] ${key} 已到「不可用」档（${mediaNow ? '视觉' : '文本'}），${mediaNow ? '告知看不了图' : '回中性提示'}`);
    await (0, deps.sendToQQ)(key, mediaNow
      ? '这张图我现在看不了（视觉模型都不可用），你用文字说一下？'
      : (0, deps.chatErrorNotice)(key, msg));
    return;
  }
  if (failureResult) {
    // 切完模型后**本轮重试一次**：否则群友连吃两次沉默（17:12 线上实况：
    // flash 被限流 → 切 pro → 37 秒后 pro 也被限流 → 两条消息全无回复）。
    // 重试必须复用同一个 sessionId（新建会话会丢上下文），且每轮只试一次。
    const retryText = deps.lastPromptByKey.get(key) || '';
    // 这里在 turn/end 的回调里，作用域内没有 sessionId 变量（只有 frame.sessionId）——
    // 之前写的裸 sessionId 是 ReferenceError，实测每轮降级都让事件流断一次再重连
    // （「事件流中断: sessionId is not defined」，19:57:26 一次真实复现）。
    const sid = frame.sessionId;
    if (retryText && !deps.retriedAfterFallback.has(sid)) {
      deps.retriedAfterFallback.add(sid);
      (0, deps.log)(`[模型降级] ${key} 降级后重试本轮（${deps.activeModelOverride?.provider ?? deps.cfg.dsh?.provider}/${deps.activeModelOverride?.model ?? deps.cfg.dsh?.model}）`);
      // 不能在 turn 收尾里 await 重投：prompt 队列此刻可能仍把「本轮」当成 running，
      // await 会把自己卡死。defer 一拍发出去，结果异步记日志（每轮只发一次，不会循环）。
      (0, deps.setTimeout)(() => {
        (0, deps.ensureChatModel)(sid, key)
          .then(() => (0, deps.deliverPrompt)(key, retryText, { retryAfterFallback: true }))
          .then(() => (0, deps.log)(`✅ 降级后重试已投递 (${key})`))
          .catch((retryError) => (0, deps.log)(`⚠️ 降级后重试失败 (${key})：${retryError?.message ?? retryError}`));
      }, 0);
      return;
    }
    (0, deps.log)(`[模型降级] ${key} 本轮不重试（无原文或已试过），下一轮起使用备用模型`);
    return;
  }
  // 备用模型也用尽 / DSH 本身连不上：才让本地 8B 接管，至少能正常说一句话。
  const fallbacksRemaining = deps.activeModelOverride
    ? 0
    : (Array.isArray(deps.cfg.dsh?.modelFallbacks) ? deps.cfg.dsh.modelFallbacks.length : 0);
  if (await (0, deps.tryLocalFallback)(key, msg, { fallbacksRemaining })) return;
  // 发到聊天里的必须是**中性提示**：网关 JSON、内部错误码、供应商名会原样
  // 暴露给群友和陌生人（曾经整段 {"code":"no_healthy_account",...} 出现在群聊里）。
  // 原文只留在 bridge.log / activity 里，排查能力不减。
  await (0, deps.sendToQQ)(key, (0, deps.chatErrorNotice)(key, msg));
  if (isFarewell) {
    const st = (0, deps.socialState)(key);
    if (st.phase === 'exiting') {
      st.phase = 'idle';
      st.activeDeadlineAt = 0;
      st.activeExitAt = 0;
      (0, deps.log)(`社交模式：${key} 退场发言出错，回到观望`);
    }
  }

}
export function createMuxRuntime(deps) {
// @bridge-function pumpMux:start
async function pumpMux() {
    // 事件流重连退避：DSH 侧流被立刻关闭时（如版本不兼容，见 issue #34），固定 3 秒重连会刷屏。
    let retryMs = 3000;
    let failureStreak = 0;
    for (;;) {
      let framesThisStream = 0;
      try {
        (0, deps.log)('连接 DSH 事件流…');
        for await (const envelope of agentTransportOf(deps).events()) {
          framesThisStream += 1;
          const frame = envelope.payload;
          // 会话开场快照：只喂 token 账本。它含**历史** turn/end，绝不能让它们走
          // session/event 通道 —— 否则桥接会把早已结束的回合当成新回合去发 QQ 回复。
          if (frame.type === 'session/snapshot') {
            (0, deps.recordSessionSnapshot)(frame.sessionId, frame.snapshot);
            continue;
          }
          if (frame.type === 'session/event') {
            // Token 记账放在最前面：无论会话是否仍属当前模式/是否学习会话，
            // 花掉的钱都是真的，都必须入账（归属由 resolveKey 决定）。
            (0, deps.recordSessionUsage)(frame.sessionId, frame.event);
            await guardTurnSteps(deps, frame);
            const key = deps.reverse.get(frame.sessionId);
            if (!key) {
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              if (deps.learnerSessions.has(frame.sessionId)) {
                // 与主 collector 同样的道理（issue #26 的补充）：**只有 turn/start 才建** collector。
                // 迟到事件（session/end-seed、session/title、model/selection…）不会有 turn/end，
                // 若在这里顺手建一个，它会永远留在 learnerCollectors 里并吞掉后续 turn 事件，
                // 等待者要么拿不到结果、要么拿到错位的文本。
                let learnerCollector = deps.learnerCollectors.get(frame.sessionId) ?? null;
                if (!learnerCollector && frame.event.type === 'turn/start') {
                  learnerCollector = agentTransportOf(deps).createCollector();
                  deps.learnerCollectors.set(frame.sessionId, learnerCollector);
                }
                const learnerEnded = learnerCollector ? learnerCollector.push(frame.event) : null;
                if (learnerEnded) {
                  deps.learnerCollectors.delete(frame.sessionId);
                  const waiters = deps.learnerWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) deps.learnerWaiters.delete(frame.sessionId);
                  if (waiter) {
                    (0, deps.clearTimeout)(waiter.timer);
                    if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                      waiter.resolve(learnerEnded.text);
                    } else {
                      waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
                    }
                  }
                  // 旧学习会话 turn 结束后从集合移除，避免残留
                  if (frame.sessionId !== deps.slangLearnerSessionId) deps.learnerSessions.delete(frame.sessionId);
                }
              }
              continue;
            }
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            if (!(0, deps.isCurrentSession)(key, frame.sessionId)) continue;
            deps.turnLastEventAt.set(frame.sessionId, Date.now());
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              deps.retriedAfterFallback.delete(frame.sessionId);
              deps.sendToolSucceededSessions.delete(frame.sessionId);
              deps.malformedRetries.delete(frame.sessionId);
              const nextTurn = (deps.turnSeqBySession.get(frame.sessionId) || 0) + 1;
              deps.turnSeqBySession.set(frame.sessionId, nextTurn);
              deps.currentTurnBySession.set(frame.sessionId, Number(frame.event.data?.turn) || nextTurn);
              deps.pendingSendToolCalls.delete(frame.sessionId);
              MUX_ABORT_MARKS.delete(frame.sessionId);
              deps.v2TurnStartAt.set(frame.sessionId, Date.now());
              deps.turnLeaseNoted.delete(frame.sessionId);
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const args = (0, deps.sanitizeToolArgs)(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              (0, deps.appendToolLog)({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, turn: deps.currentTurnBySession.get(frame.sessionId) ?? null, step: muxCurrentStep(frame.sessionId) ?? frame.step ?? null, tool: toolName, args });
              if (callId != null) {
                if ((0, deps.isSendToolName)(toolName)) {
                  let pending = deps.pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    deps.pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                let nameMap = deps.toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  deps.toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (deps.toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = frame.event.data?.message?.content?.[0];
              const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
              const { errorText, cancelled } = describeToolResult({
                resultError,
                rawError: resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error,
                abortAt: MUX_ABORT_MARKS.get(frame.sessionId),
                now: Date.now()
              });
              (0, deps.appendToolLog)({
                type: 'result',
                time: new Date().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                cancelled,
                error: errorText ? (0, deps.sanitizeToolArgs)(errorText) : null
              });
              if (cancelled) {
                (0, deps.log)(`⏹️ 工具调用随回合取消（${toolName || '未知工具'}）：${errorText || '没有错误详情'}`);
              }
              if (callId != null) {
                deps.toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = deps.pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) deps.pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    deps.sendToolSucceededSessions.add(frame.sessionId);
                  }
                }
              }
            }
            // collector 生命周期见 trackTurnEvent()：只为 turn/start 建、空壳 turn/end 即清。
            const { ended } = trackTurnEvent(deps, frame.sessionId, frame.event);
            if (ended) {
              await handleTurnEnd(deps, frame, key, ended);
            }
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && deps.learnerSessions.has(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            try {
              if (frame.type === 'question/requested') {
                await agentTransportOf(deps).respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
                });
              } else {
                await agentTransportOf(deps).respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: 'rejected' }
                });
              }
              (0, deps.log)('黑话学习会话自动跳过提问/审批');
            } catch (error) {
              (0, deps.log)('自动响应学习会话提问/审批失败:', error?.message ?? error);
            }
          } else if (frame.type === 'question/requested') {
            const key = deps.reverse.get(frame.sessionId);
            if (!key) continue;
            if (!(0, deps.isCurrentSession)(key, frame.sessionId)) { await (0, deps.cancelPendingEntry)({ ...frame, kind: 'question' }); continue; }
            const lines = frame.questions.map((q, i) => {
              const qText = String(q.question ?? '');
              const sensitive = (0, deps.shouldAuditKey)(key) && deps.SENSITIVE_RE.test(qText);
              if (sensitive) (0, deps.log)(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
              const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
              let s = `${i + 1}. ${safeQuestion}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => {
                  const label = String(o.label ?? '');
                  const optSensitive = (0, deps.shouldAuditKey)(key) && deps.SENSITIVE_RE.test(label);
                  if (optSensitive) (0, deps.log)(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                  return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                });
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await (0, deps.sendToQQ)(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
            await (0, deps.registerPending)(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, questions: frame.questions });
          } else if (frame.type === 'approval/requested') {
            const key = deps.reverse.get(frame.sessionId);
            if (!key) continue;
            if (!(0, deps.isCurrentSession)(key, frame.sessionId)) { await (0, deps.cancelPendingEntry)({ ...frame, kind: 'approval' }); continue; }
            const rawReason = frame.reason ?? '';
            const sensitiveReason = (0, deps.shouldAuditKey)(key) && deps.SENSITIVE_RE.test(rawReason);
            if (sensitiveReason) (0, deps.log)(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
            const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
            const reason = safeReason ? `\n理由：${safeReason}` : '';
            const rawToolName = frame.toolName ?? '';
            const sensitiveTool = (0, deps.shouldAuditKey)(key) && deps.SENSITIVE_RE.test(rawToolName);
            if (sensitiveTool) (0, deps.log)(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
            const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
            await (0, deps.sendToQQ)(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
            await (0, deps.registerPending)(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, toolName: frame.toolName });
          } else if (frame.type === 'stream/error') {
            (0, deps.log)('事件流错误:', frame.error);
          }
        }
        // 流正常关闭（服务端主动断开）不会抛错。以前这里什么都不打，日志看起来
        // 就像「连上了、然后又连一次」，完全看不出 DSH 把流关了。
        (0, deps.log)(`DSH 事件流已结束（本次收到 ${framesThisStream} 帧）`);
      } catch (error) {
        (0, deps.log)('事件流中断:', error?.message ?? error, error?.stack ?? '');
      } finally {
        // WebSocket 正常关闭和异常中断都会走到这里；必须清掉旧 turn 相关状态，
        // 否则重连后旧 collector/标记残留会导致回复重复累加或误判。
        deps.collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
        deps.social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
        deps.sendToolSucceededSessions.clear();
        deps.pendingSendToolCalls.clear();
        deps.v2TurnStartAt.clear();
        deps.toolCallNames.clear();
        deps.pendingWakeKeys.clear();
        (0, deps.clearAllPendingWakeLeases)();
        deps.social.exitingSessions.clear();
        deps.wakeConfigUpdatedKeys.clear();
        deps.markReadCalledKeys.clear();
        deps.wakeConfigMissCount.clear();
        // 长轮询（qq_wait_for_messages）的租约也要清：它的 req.on('close') 在事件流
        // 断开时不一定触发，残留租约会用 429 卡住该会话最长 15 分钟的等待工具。
        deps.activeWaits.clear();
      }
      if (framesThisStream > 0) {
        failureStreak = 0;
        retryMs = 3000;
      } else {
        failureStreak += 1;
        retryMs = Math.min(30000, retryMs * 2);
        // DSH 可能刚重启并换了端口：连续失败就重新发现一次地址，
        // 否则桥接会永远重连旧端口（进程活着、QQ 也连着，但 AI 永远不回话）。
        if (failureStreak >= 2) {
          try {
            const found = await agentTransportOf(deps).discoverBaseUrl({ current: deps.api.baseUrl, log: deps.log });
            if (found.changed) {
              agentTransportOf(deps).baseUrl = found.baseUrl;
              deps.cfg.dsh.baseUrl = found.baseUrl;
              (0, deps.persistDshBaseUrl)(found.baseUrl);
              agentTransportOf(deps).invalidateAuth();
              retryMs = 3000;
              (0, deps.log)(`DSH 地址已更新（重连）：${found.baseUrl}`);
            }
          } catch (error) {
            (0, deps.log)(`DSH 地址重新发现失败：${error?.message ?? error}`);
          }
        }
        if (failureStreak === 3) {
          (0, deps.log)('⚠️ 连续多次连上 DSH 事件流后一帧都没收到就断开：多半是 DSH 侧事件流协议/版本不匹配'
            + '（可在 DSH 里核对版本，或查看 issue #34）。已改为指数退避重连，不再每 3 秒刷屏。');
        }
      }
      await (0, deps.sleep)(retryMs);
    }
  }
// @bridge-function pumpMux:end
  return { trackTurnEvent: (sessionId, event) => trackTurnEvent(deps, sessionId, event), pumpMux };
}
