// console/send-reset: extracted bridge responsibilities; no startup side effects.
// Live dependencies: ACTIVITY_LOG, CONVERSATION_TOKENS, DSH_CONTROL_TIMEOUT_MS, KNOWN_AGENT_TOKENS, SENSITIVE_RE, STATE_DIR, api, appendActivity, cancelAllSocialTimers, cancelPendingEntry, cancelSocialTimers, cfg, clearAllSocialV2Timers, clearSocialV2Timers, clearTimeout, collectors, currentMode, drainAllPromptQueues, drainPromptQueue, fetchMediaData, findMessageMedia, forgetAgentToken, fs, getSocialV2State, log, markMediaTurn, markReadCalledKeys, messageMediaStore, modeAllowed, modelAppliedSessions, path, pending, pendingSendToolCalls, pendingWakeKeys, queued, queuedHintAt, recordSentMessagesV2, releaseLock, resolveReplyTargetV2, reverse, saveHandoffDigest, saveSocialV2State, saveState, scheduleReplyCheckV2, seenForwardIds, sendMessagesV2, sendToolSucceededSessions, sessionEpoch, sessionPromises, setTimeout, shouldBlockSilentReply, slangExtractionCooldowns, slangSubmitTimes, slangWindows, social, socialV2, state, toolCallNames, turnLeaseNoted, unquoteJsonString, unwrap, v2ToolEnabled, v2TurnStartAt, wakeConfigMissCount, wakeConfigUpdatedKeys, withTimeout
async function dispatchReadImagesRoutes(request, deps) {
  if (request.req.method === 'POST' && request.url.pathname === '/api/authorize/read') {
    const body = await request.readBody();
    const key = String(body.key ?? '').trim();
    const token = String(body.token ?? '').trim();
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { request.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; /* @bridge-handled */ }
    if (!token || !request.agentTokenOk(key, token)) {
      // 空 token 一律拒绝：该端点对 agent 流量开放（见 startConsoleServer 里的
      // agent 白名单），而 MCP 的 agentApi 总是带着真实控制台令牌，
      // 所以「不传 token 就跳过校验」等于把它变成免鉴权端点。
      request.sendJson({ ok: false, error: token ? 'agent token 无效' : '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的 v2 读工具' }, 403);
      return true; /* @bridge-handled */
    }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !(0, deps.modeAllowed)(key, kind, id, deps.cfg, deps.currentMode)) {
      request.sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
      return true; /* @bridge-handled */
    }
    request.sendJson({ ok: true, key });
    return true; /* @bridge-handled */
  }
  // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
  if (request.req.method === 'GET' && request.url.pathname === '/api/images/message') {
    const key = String(request.url.searchParams.get('key') ?? '').trim();
    const messageId = String(request.url.searchParams.get('messageId') ?? '').trim();
    const agentToken = String(request.req.headers['x-agent-token'] ?? '').trim();
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { request.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; /* @bridge-handled */ }
    if (!messageId) { request.sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return true; /* @bridge-handled */ }
    if (deps.currentMode === 'reserved2' && !agentToken) {
      request.sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
      return true; /* @bridge-handled */
    }
    if (deps.currentMode === 'chat' || deps.currentMode === 'reserved') {
      request.sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
      return true; /* @bridge-handled */
    }
    if (agentToken && !request.agentTokenOk(key, agentToken)) {
      request.sendJson({ ok: false, error: 'agent token 无效' }, 403);
      return true; /* @bridge-handled */
    }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !(0, deps.modeAllowed)(key, kind, id, deps.cfg, deps.currentMode)) {
      request.sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
      return true; /* @bridge-handled */
    }
    if (agentToken && !(0, deps.v2ToolEnabled)('getImages')) {
      request.sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
      return true; /* @bridge-handled */
    }
    if (!agentToken && deps.currentMode === 'closed-agent' && !(0, deps.v2ToolEnabled)('getImages')) {
      request.sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
      return true; /* @bridge-handled */
    }
    const media = (0, deps.findMessageMedia)(key, messageId);
    if (!media.length) {
      request.sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
      return true; /* @bridge-handled */
    }
    try {
      const images = await (0, deps.fetchMediaData)(media);
      // 取图成功 → 记「这个会话最近出现过图」：本轮就算因为模型选早了读不出来，
      // 下一轮（含模型自己重试）也会用能看图的模型，不会一直「看不见」。
      if (Array.isArray(images) && images.some((img) => img && img.data)) (0, deps.markMediaTurn)(key);
      request.sendJson({ ok: true, messageId, media, images });
    } catch (error) {
      (0, deps.log)(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
      request.sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
    }
    return true; /* @bridge-handled */
  }

  return false;
}

async function dispatchSendRoute(request, deps) {
  // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
  if (request.req.method === 'POST' && (request.url.pathname === '/api/send/group' || request.url.pathname === '/api/send/private' || request.url.pathname === '/api/send/reply')) {
    const body = await request.readBody();
    const token = String(body.token ?? '').trim();
    const isPrivate = request.url.pathname === '/api/send/private';
    const isReply = request.url.pathname === '/api/send/reply';
    const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
    const message = (0, deps.unquoteJsonString)(String(body.message ?? '').trim());
    // 引用 id 与端点无关：/api/send/reply 与另两个端点都允许带（是否真的引用由下游按 id 判断）。
    // 旧写法 `isReply ? body.replyToMessageId : body.replyToMessageId` 两个分支一模一样，
    // 保留 isReply 变量只是为了下面的端点语义判断，别再让人以为这里有过分支逻辑。
    const replyToMessageId = body.replyToMessageId;
    const atUserId = body.atUserId ?? null;
    const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
    // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用；
    // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
    if (deps.currentMode === 'chat' || deps.currentMode === 'reserved') {
      request.sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
      return true; /* @bridge-handled */
    }
    if (deps.socialV2.paused && token) {
      request.sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
      return true; /* @bridge-handled */
    }
    if (!targetId || !message) { request.sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return true; /* @bridge-handled */ }
    if (isPrivate && atUserId) { request.sendJson({ ok: false, error: '私聊不需要 @' }, 400); return true; /* @bridge-handled */ }
    if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
      request.sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
      return true; /* @bridge-handled */
    }
    if (deps.currentMode === 'reserved2' && !token) { request.sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; /* @bridge-handled */ }
    if (token && !request.agentTokenOk(key, token)) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
    const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
    if (token && !(0, deps.v2ToolEnabled)(flag)) { request.sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return true; /* @bridge-handled */ }
    if ((0, deps.shouldBlockSilentReply)(key)) {
      request.sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
      return true; /* @bridge-handled */
    }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { request.sendJson({ ok: false, error: 'key 格式无效' }, 400); return true; /* @bridge-handled */ }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !(0, deps.modeAllowed)(key, kind, id, deps.cfg, deps.currentMode)) {
      request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true; /* @bridge-handled */
    }
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
      request.sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
      return true; /* @bridge-handled */
    }
    let quotedInfo = null;
    let actualReplyToMessageId = replyToMessageId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const stForReply = (0, deps.getSocialV2State)(key);
      const resolved = await (0, deps.resolveReplyTargetV2)(stForReply, kind, id, String(replyToMessageId).trim());
      if (!resolved) {
        request.sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
        return true; /* @bridge-handled */
      }
      quotedInfo = resolved.info;
      actualReplyToMessageId = resolved.messageId;
    }
    const sendCfg = deps.cfg.socialV2?.send ?? {};
    const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
    if (message.length > maxChars) { request.sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return true; /* @bridge-handled */ }
    if (deps.SENSITIVE_RE.test(message)) { request.sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return true; /* @bridge-handled */ }
    // st/now 必须声明在 try **之外**：下面的 catch 要用它们回滚预占的发送额度。
    // 写在 try 里时 catch 拿到的是块作用域外的名字 ⇒ ReferenceError（send-burst
    // 曾整段踩过同型问题，见体检报告 #1 / R2）。后果不是"少一行日志"，而是
    // 失败响应变成「st is not defined」、额度不回滚（接下来一分钟全是假 429），
    // 且部分成功的已发消息不会被记进 recentMessages。
    const st = (0, deps.getSocialV2State)(key);
    const now = Date.now();
    try {
      const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
      const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
      const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
        request.sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
        return true; /* @bridge-handled */
      }
      st.sendTimes.push(now);
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      const sentMessages = await (0, deps.sendMessagesV2)(key, [message], [], actualReplyToMessageId, atUserId);
      (0, deps.recordSentMessagesV2)(key, sentMessages);
      st.lastAiReplyAt = now;
      st.lastActionAt = now;
      st.wakeConfig.noActionCount = 0;
      (0, deps.saveSocialV2State)();
      (0, deps.log)(`[send] ${request.url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
      (0, deps.appendActivity)(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
      if (sentMessages.length > 0) (0, deps.scheduleReplyCheckV2)(key);
      request.sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
    } catch (error) {
      if (error?.sent?.length) {
        (0, deps.recordSentMessagesV2)(key, error.sent);
        (0, deps.log)(`[send] ${request.url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
      }
      // 失败/未发出的消息回滚预占的发送额度，避免假 429。
      const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
      const failedCount = Math.max(0, 1 - sentCount);
      for (let i = 0; i < failedCount; i++) {
        const idx = st.sendTimes.indexOf(now);
        if (idx >= 0) st.sendTimes.splice(idx, 1);
      }
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      (0, deps.saveSocialV2State)();
      request.sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
    }
    return true; /* @bridge-handled */
  }
  return false;
}

async function dispatchResetRoutes(request, deps) {
  // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
  if (request.req.method === 'POST' && request.url.pathname === '/api/session/reset') {
    const body = await request.readBody();
    const key = String(body.key ?? '');
    if (!key || !deps.state.sessions[key]) { request.sendJson({ ok: false, error: '会话不存在' }, 404); return true; /* @bridge-handled */ }
    // 重置会话前先留一份「最近发生了什么」的脉络（第三层），下次 bootstrap 注入一次。
    (0, deps.saveHandoffDigest)(key);
    deps.sessionEpoch++;
    const oldSessionId = deps.state.sessions[key];
    delete deps.state.sessions[key];
    deps.modelAppliedSessions.delete(oldSessionId);
    // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
    delete deps.state.sessionPolicies[key];
    deps.reverse.delete(oldSessionId);
    deps.collectors.delete(oldSessionId);
    deps.sendToolSucceededSessions.delete(oldSessionId);
    deps.pendingSendToolCalls.delete(oldSessionId);
    deps.v2TurnStartAt.delete(oldSessionId);
    deps.turnLeaseNoted.delete(oldSessionId);
    deps.toolCallNames.delete(oldSessionId);
    const pe = deps.pending.get(key);
    if (pe) {
      (0, deps.clearTimeout)(pe.timer);
      (0, deps.cancelPendingEntry)(pe).catch(() => {});
    }
    deps.pending.delete(key);
    deps.queued.delete(key);
    deps.queuedHintAt.delete(key);
    deps.sessionPromises.delete(key);
    (0, deps.drainPromptQueue)(key, '会话已重置');
    deps.social.recentMessages.delete(key);
    deps.messageMediaStore.delete(key);
    deps.social.pendingSummaries.delete(key);
    deps.social.states.delete(key);
    deps.social.silentContext.delete(key);
    deps.social.silentTurns.delete(oldSessionId);
    deps.social.exitingSessions.delete(oldSessionId);
    deps.slangWindows.delete(key);
    deps.slangExtractionCooldowns.delete(key);
    deps.slangSubmitTimes.delete(key);
    (0, deps.cancelSocialTimers)(key);
    (0, deps.clearSocialV2Timers)(key);
    deps.pendingWakeKeys.delete(key);
    deps.wakeConfigUpdatedKeys.delete(key);
    deps.markReadCalledKeys.delete(key);
    deps.wakeConfigMissCount.delete(key);
    (0, deps.forgetAgentToken)(key);
    deps.socialV2.conversations.delete(key);
    deps.seenForwardIds.delete(key);
    (0, deps.saveSocialV2State)();
    (0, deps.saveState)();
    // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
    try { await (0, deps.withTimeout)(deps.api.stopSessionWork(oldSessionId), deps.DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
    catch (error) { (0, deps.log)(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
    try { await (0, deps.withTimeout)(deps.api.workspace.archiveSession({ sessionId: oldSessionId }), deps.DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
    (0, deps.log)(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
    request.sendJson({ ok: true, key, archived: oldSessionId });
    return true; /* @bridge-handled */
  }
  if (request.req.method === 'POST' && request.url.pathname === '/api/workspace/reset') {
    deps.sessionEpoch++;
    let archivedCount = 0;
    let stoppedCount = 0;
    try {
      // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
      // 只处理 cwd 位于 qq-bridge state/ 下的根会话；子代理会话由父会话管理，不能误归档。
      const list = (0, deps.unwrap)(await (0, deps.withTimeout)(deps.api.sessions.list({}), deps.DSH_CONTROL_TIMEOUT_MS, 'sessions.list'), 'session.list');
      const stateDir = deps.path.resolve(deps.STATE_DIR);
      const statePrefix = deps.path.normalize(stateDir + deps.path.sep);
      const normPath = (p) => deps.path.normalize(String(p ?? '').replace(/\//g, deps.path.sep));
      const isUnderState = (cwd) => process.platform === 'win32'
        ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
        : cwd.startsWith(statePrefix);
      for (const item of list.items ?? []) {
        if (item.origin === 'subagent' || item.parentSessionId) continue;
        const cwd = normPath(item.cwd);
        if (isUnderState(cwd)) {
          // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
          try { await (0, deps.withTimeout)(deps.api.stopSessionWork(item.sessionId), deps.DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); stoppedCount += 1; }
          catch (error) { (0, deps.log)(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await (0, deps.withTimeout)(deps.api.workspace.archiveSession({ sessionId: item.sessionId }), deps.DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); archivedCount += 1; } catch {}
        }
      }
    } catch {}
    for (const entry of deps.pending.values()) {
      (0, deps.clearTimeout)(entry.timer);
      (0, deps.cancelPendingEntry)(entry).catch(() => {});
    }
    deps.pending.clear();
    deps.queued.clear();
    deps.queuedHintAt.clear();
    deps.sessionPromises.clear();
    (0, deps.drainAllPromptQueues)('工作区已清空');
    deps.social.states.clear();
    deps.social.recentMessages.clear();
    deps.messageMediaStore.clear();
    deps.seenForwardIds.clear();
    deps.social.pendingSummaries.clear();
    deps.social.silentContext.clear();
    deps.social.silentTurns.clear();
    deps.social.exitingSessions.clear();
    deps.slangWindows.clear();
    deps.slangExtractionCooldowns.clear();
    deps.slangSubmitTimes.clear();
    (0, deps.cancelAllSocialTimers)();
    (0, deps.clearAllSocialV2Timers)();
    // 清空工作区 = 所有会话连同 token 一起作废，两张表整体清掉（比逐会话摘除更不容易漏）。
    deps.socialV2.conversations.clear();
    deps.CONVERSATION_TOKENS.clear();
    deps.KNOWN_AGENT_TOKENS.clear();
    (0, deps.saveSocialV2State)();
    deps.state.sessions = {};
    deps.state.sessionPolicies = {};
    deps.reverse.clear();
    deps.collectors.clear();
    deps.sendToolSucceededSessions.clear();
    deps.pendingSendToolCalls.clear();
    deps.v2TurnStartAt.clear();
    deps.toolCallNames.clear();
    (0, deps.saveState)();
    try { deps.fs.writeFileSync(deps.ACTIVITY_LOG, ''); } catch {}
    (0, deps.log)(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
    request.sendJson({ ok: true, archivedCount, stoppedCount });
    return true; /* @bridge-handled */
  }
  // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
  if (request.req.method === 'POST' && request.url.pathname === '/api/restart') {
    request.sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
    (0, deps.setTimeout)(() => {
      (0, deps.log)('控制台：重启桥接');
      // 退出前落盘：SIGINT/SIGTERM 的收尾路径会 saveState()/saveSocialV2State()，
      // 而重启这条路径以前直接 process.exit，500ms 窗口内改动的唤醒配置/计数器会丢。
      try { (0, deps.saveState)(); } catch (error) { (0, deps.log)('重启前保存会话映射失败:', error?.message ?? error); }
      try { (0, deps.saveSocialV2State)(); } catch (error) { (0, deps.log)('重启前保存二代会话状态失败:', error?.message ?? error); }
      (0, deps.releaseLock)();
      process.exit(0);
    }, 500);
    return true; /* @bridge-handled */
  }
  return false;
}

export function createConsoleSendReset(deps) {
// @bridge-function handleConsoleSendReset:start
async function handleConsoleSendReset(request) {
        if (await dispatchReadImagesRoutes(request, deps)) return true; /* @bridge-handled */
        if (await dispatchSendRoute(request, deps)) return true; /* @bridge-handled */
        if (await dispatchResetRoutes(request, deps)) return true; /* @bridge-handled */
    return false;
  }
// @bridge-function handleConsoleSendReset:end
  return { handleConsoleSendReset };
}
