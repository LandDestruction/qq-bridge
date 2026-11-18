// console/conversation-send: extracted bridge responsibilities; no startup side effects.
// Live dependencies: AbortSignal, MAX_MEDIA_BYTES, MAX_MEDIA_PIXELS, ROOT, SENSITIVE_RE, aiBlacklistGatePure, appendActivity, appendToolLog, assertGroupMember, bot, canonicalV2Key, captureSendGuard, cfg, computeGapsV2, currentMode, fetch, findCjkSpaceWarning, findSplitBoundaryWarning, fs, getImageDimensions, getSocialV2State, getStickerImageData, initialPromptMaxChars, initialPrompts, initialPromptsWritable, log, mimeFromBuffer, mimeFromUrl, modeAllowed, path, recordSentMessagesV2, resolveReplyTargetV2, safeFetchBuffer, saveSocialV2State, scheduleReplyCheckV2, sendMessagesV2, sendVoiceForV2, setInitialPrompt, shouldBlockSilentReply, socialV2, stickerEnabled, synthesizeTts, toModelMedia, ttsCfg, ttsCfgForKey, ttsHelpers, v2ToolEnabled, voiceCfg, voiceDirectiveSend


// 操作者预写的「会话初始提示词」：控制台专用（AI 既读不到也改不了 —— adminOnlyV2Paths）。
// 内容只在该会话**首次唤醒**（bootstrap）时注入一次，见 buildWakePromptV2。
async function routeInitialPrompt(deps, request) {
  if (request.req.method === 'GET') {
    const key = String(request.url.searchParams.get('key') ?? '').trim();
    if (!key) {
      const entries = [...deps.initialPrompts.entries()]
        .map(([entryKey, entry]) => ({
          key: entryKey,
          chars: entry.text.length,
          createdAt: entry.createdAt || 0,
          updatedAt: entry.updatedAt || 0,
          preview: entry.text.replace(/\s+/g, ' ').slice(0, 80)
        }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      request.sendJson({ ok: true, entries, maxChars: (0, deps.initialPromptMaxChars)(), writable: deps.initialPromptsWritable });
      return true; /* @bridge-handled */
    }
    const canonical = (0, deps.canonicalV2Key)(key);
    if (!canonical) { request.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; /* @bridge-handled */ }
    const entry = deps.initialPrompts.get(canonical) ?? null;
    request.sendJson({
      ok: true,
      key: canonical,
      exists: !!entry,
      text: entry?.text ?? '',
      createdAt: entry?.createdAt || 0,
      updatedAt: entry?.updatedAt || 0,
      maxChars: (0, deps.initialPromptMaxChars)(),
      writable: deps.initialPromptsWritable
    });
    return true; /* @bridge-handled */
  }
  const body = await request.readBody();
  const key = String(body.key ?? '').trim();
  const explicitDelete = body.delete === true;
  // 只接受 { key, text: string } 或 { key, delete: true }：
  // 缺 text 时不当作"清空"（否则一次漏字段的调用就把操作者写的内容删了）。
  if (!explicitDelete && typeof body.text !== 'string') {
    request.sendJson({ ok: false, error: 'text 必须是字符串（留空表示删除），或用 delete:true 显式删除' }, 400);
    return true; /* @bridge-handled */
  }
  const result = (0, deps.setInitialPrompt)(key, explicitDelete ? '' : body.text);
  if (!result.ok) { request.sendJson({ ok: false, error: result.error }, result.statusCode ?? 400); return true; /* @bridge-handled */ }
  (0, deps.log)(`控制台：${result.deleted ? '已删除' : '已保存'}会话初始提示词 ${result.key}${result.deleted ? '' : `（${result.chars} 字符，仅首次唤醒注入）`}`);
  request.sendJson({
    ok: true,
    key: result.key,
    deleted: result.deleted,
    chars: result.chars,
    exists: !!result.entry,
    updatedAt: result.entry?.updatedAt || 0,
    maxChars: (0, deps.initialPromptMaxChars)()
  });
  return true; /* @bridge-handled */
}

async function routeSendBurst(deps, request) {
  const body = await request.readBody();
  const key = String(body.key ?? '').trim();
  let rawMessages = body.messages;
  if (typeof rawMessages === 'string') {
    const trimmed = rawMessages.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) rawMessages = parsed.map(String);
      } catch {}
    } else if (trimmed.startsWith('"')) {
      // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'string') rawMessages = parsed;
        else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
      } catch {}
    }
  }
  const messages = Array.isArray(rawMessages)
    ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
    : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
  const replyToMessageId = body.replyToMessageId;
  if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
    request.sendJson({ ok: false, error: '分条发送暂不支持引用，请用 qq_send_message 并传 replyToMessageId' }, 400);
    return true; /* @bridge-handled */
  }
  if (!key || !messages.length) {
    request.sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
    return true; /* @bridge-handled */
  }
  const sendCfgBurst = deps.cfg.socialV2?.send ?? {};
  if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
    request.sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
    return true; /* @bridge-handled */
  }
  if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('sendBurst')) { request.sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return true; /* @bridge-handled */ }
  if (deps.currentMode !== 'reserved2') {
    request.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
    return true; /* @bridge-handled */
  }
  if (!request.req.headers['x-agent-token']) { request.sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; /* @bridge-handled */ }
  const keyMatch = /^(group|private):(\d+)$/.exec(key);
  if (!keyMatch) {
    request.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
    return true; /* @bridge-handled */
  }
  const kind = keyMatch[1];
  const id = Number(keyMatch[2]);
  if (!Number.isFinite(id) || id <= 0 || !(0, deps.modeAllowed)(key, kind, id, deps.cfg, deps.currentMode)) {
    request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
    return true; /* @bridge-handled */
  }
  if ((0, deps.shouldBlockSilentReply)(key)) {
    request.sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
    return true; /* @bridge-handled */
  }
  // 分条发送没有引用/at，但纯文字里仍可能写 @昵称，所以同样过一道 AI 黑名单硬闸。
  if (await aiBlacklistSendGate(deps, request, { key, kind, id, messages, replyToMessageId, atUserId: null, tool: 'qq_send_burst' })) return true;
    if (await sendBurstVoiceParts(deps, request, { key, messages })) return true;
    return sendBurstSend(deps, request, { key, messages });
}

async function sendBurstVoiceParts(deps, request, ctx) {
  const { key, messages } = ctx;
  // [语音] 前缀：带前缀的那几条真的转成语音发，其余按文字走（别把 [语音] 字样漏出去）。
  if ((0, deps.ttsCfg)().enabled) {
    // 只有真的出现语音标记时才去加载 tts 模块。普通分条发送不该为它付一次动态
    // import；而在受限环境（vm / 沙箱）里动态 import 会直接抛
    // 「A dynamic import callback was not specified」，把整条发送连坐成 500，
    // 掩盖掉真正的失败原因（R2 回归就是这么红的）。
    const hasVoiceMark = messages.some((m) => /^\s*(?:\[语音\]|tts:)/i.test(String(m ?? '')));
    let helpersV = null;
    if (hasVoiceMark) {
      try {
        helpersV = await (0, deps.ttsHelpers)();
      } catch (error) {
        (0, deps.log)(`[tts] 语音模块不可用，按纯文本发送：${error?.message ?? error}`);
      }
    }
    const parsedAll = helpersV ? messages.map((m) => helpersV.parseVoiceDirective(m)) : [];
    if (parsedAll.some((p) => p.isVoice)) {
      const voiceParts = parsedAll.filter((p) => p.isVoice).map((p) => p.text.trim()).filter(Boolean);
      const textParts = parsedAll.filter((p) => !p.isVoice).map((p) => p.text.trim()).filter(Boolean);
      if (voiceParts.length === 1 && textParts.length === 0) {
        const r = await (0, deps.voiceDirectiveSend)(key, voiceParts[0]);
        request.sendJson(r.ok ? r : { ok: false, error: r.error }, r.ok ? 200 : (r.status || 500));
        return true; /* @bridge-handled */
      }
      if (voiceParts.length) {
        const results = [];
        for (const t of voiceParts) results.push(await (0, deps.voiceDirectiveSend)(key, t));
        if (!textParts.length) {
          request.sendJson({ ok: results.some((r) => r.ok), via: 'tts', key, parts: results.map((r) => ({ ok: r.ok, error: r.error, file: r.file })) });
          return true; /* @bridge-handled */
        }
        messages.splice(0, messages.length, ...textParts);
      } else {
        messages.splice(0, messages.length, ...textParts);
      }
    }
  }
}

async function sendBurstSend(deps, request, ctx) {
  const { key, messages } = ctx;
  const sendCfg = deps.cfg.socialV2?.send ?? {};
  const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
  const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
  if (messages.length > maxMsgs) {
    request.sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
    return true; /* @bridge-handled */
  }
  for (const msg of messages) {
    if (msg.length > maxChars) {
      request.sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
      return true; /* @bridge-handled */
    }
    if (deps.SENSITIVE_RE.test(msg)) {
      request.sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
      return true; /* @bridge-handled */
    }
  }
  const st = (0, deps.getSocialV2State)(key);
  const now = Date.now();
  try {
    const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
    const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
    const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
      request.sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
      return true; /* @bridge-handled */
    }
    // 先预占发送额度，避免并发绕过限频
    for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
    if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
    const delays = (0, deps.computeGapsV2)(messages, 'auto', undefined, undefined, sendCfg);
    const sentMessages = await (0, deps.sendMessagesV2)(key, messages, delays);
    (0, deps.recordSentMessagesV2)(key, sentMessages);
    st.lastAiReplyAt = now;
    st.lastActionAt = now;
    st.wakeConfig.noActionCount = 0;
    (0, deps.saveSocialV2State)();
    (0, deps.log)(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
    (0, deps.appendActivity)(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
    if (sentMessages.length > 0) (0, deps.scheduleReplyCheckV2)(key);
    const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
    const spaceWarn = (0, deps.findCjkSpaceWarning)(messages);
    const splitWarn = (0, deps.findSplitBoundaryWarning)(messages);
    request.sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
  } catch (error) {
    if (error?.sent?.length) {
      (0, deps.recordSentMessagesV2)(key, error.sent);
      (0, deps.log)(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
    }
    // 失败/未发出的消息回滚预占的发送额度，避免假 429。
    const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
    const failedCount = Math.max(0, messages.length - sentCount);
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

async function routeSendMessage(deps, request) {
  const body = await request.readBody();
  const key = String(body.key ?? '').trim();
  let rawMessages = body.messages;
  if (typeof rawMessages === 'string') {
    const trimmed = rawMessages.trim();
    // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) rawMessages = parsed.map(String);
      } catch {}
    } else if (trimmed.startsWith('"')) {
      // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'string') rawMessages = parsed;
        else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
      } catch {}
    }
  }
  const isRawString = typeof rawMessages === 'string';
  const messages = Array.isArray(rawMessages)
    ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
    : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
  const replyToMessageId = body.replyToMessageId;
  const atUserId = body.atUserId ?? null;
  // 二代不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
  // 旧写法是 `(isRawString && messages.length > 1) ? 'auto' : ...` —— 上面 messages 的构造
  // 保证 isRawString 为真时 length 恒为 1，这个分支永远不可达，留着只会让人以为
  // "字符串多段时有特殊间隔策略"。
  const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
  const gapMs = Number(body.gapMs);
  const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
  if (!key || !messages.length) {
    request.sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
    return true; /* @bridge-handled */
  }
  const sendCfgBurst = deps.cfg.socialV2?.send ?? {};
  if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
    request.sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
    return true; /* @bridge-handled */
  }
  if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('sendMessage')) { request.sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return true; /* @bridge-handled */ }
  if (deps.currentMode !== 'reserved2') { request.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; /* @bridge-handled */ }
  if (!request.req.headers['x-agent-token']) { request.sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; /* @bridge-handled */ }
  const keyMatch = /^(group|private):(\d+)$/.exec(key);
  if (!keyMatch) { request.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; /* @bridge-handled */ }
  const kind = keyMatch[1];
  const id = Number(keyMatch[2]);
  if (!Number.isFinite(id) || id <= 0 || !(0, deps.modeAllowed)(key, kind, id, deps.cfg, deps.currentMode)) {
    request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
    return true; /* @bridge-handled */
  }
  if (kind === 'private' && atUserId) {
    request.sendJson({ ok: false, error: '私聊不需要 @' }, 400);
    return true; /* @bridge-handled */
  }
  if ((0, deps.shouldBlockSilentReply)(key)) {
    request.sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
    return true; /* @bridge-handled */
  }
  if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
    request.sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
    return true; /* @bridge-handled */
  }
  // ── AI 黑名单发送前硬闸（D70 P3）──
  // 必须放在三种发送路径（自动转语音 / [语音] 指令 / 普通文字）**之前**：
  // 否则「回名单 AI 的那条」会先被转成语音发出去，闸门就成了摆设。
  if (await aiBlacklistSendGate(deps, request, { key, kind, id, messages, replyToMessageId, atUserId, tool: 'qq_send_message' })) return true;
    const ctx = { key, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps, kind, id };
    if (await sendMessageAutoVoice(deps, request, ctx)) return true;
    if (await sendMessageVoiceDirective(deps, request, ctx)) return true;
    const prepared = await sendMessageQuota(deps, request, ctx);
    if (prepared === true) return true;
    // 必须传 prepared：sendMessageFinal 要用 quotas 阶段算好的 delays / st / now / 引用解析结果。
    // 传原始 ctx 会因 delays 缺失在 sendMessagesV2 里抛 TypeError，对外就是一条 500。
    return sendMessageFinal(deps, request, prepared);
}

// ── AI 黑名单发送前硬闸（D70 P3）────────────────────────────────────────────
// 为什么在「发送路由」里做，而不是只靠唤醒层的判定：
//   唤醒层只能决定「要不要主动参与」，拦不住模型已经在回合里、却决定去引用或 @
//   名单里那个 AI 的情况 —— 那正是用户抱怨的「主动 @ 名单 AI 还接住了」。
// 判定本身全在 src/ai-blacklist-gate.js（纯函数、零 import、不写盘不抛错），
// 这里只负责三件事：① 解析引用目标拿 senderId；② 把输入交给纯函数；
// ③ 拒绝时把消息留在本地（一个字节都不发）、写一条 tool-calls 结果、
//    并把一句人话回给模型（返回 ok:false 而不是 500，模型要能读懂为什么被拦）。
async function aiBlacklistSendGate(deps, request, info) {
  const pure = deps.aiBlacklistGatePure;
  if (!pure || typeof pure.gateAiBlacklistSend !== 'function') return false;
  // 关闭时直接短路，连引用解析都省掉（解析要读 session store，没必要为一次放行付这个成本）。
  if (!(0, pure.normalizeGateConfig)(deps.cfg?.socialV2?.aiBlacklist).enabled) return false;
  let replyToUserId = null;
  const ref = info.replyToMessageId;
  if (ref !== undefined && ref !== null && String(ref).trim() !== '') {
    try {
      const st = (0, deps.getSocialV2State)(info.key);
      const resolved = await (0, deps.resolveReplyTargetV2)(st, info.kind, info.id, String(ref).trim());
      if (resolved && resolved.info) replyToUserId = resolved.info.userId ?? null;
    } catch (error) {
      // 引用解析失败不在闸门这里报 400：交给 sendMessageQuota 统一处理（它还要回滚预占额度）。
      // 闸门只按已知信息判定，解析不出来就不误拦。
      (0, deps.log)(`[AI黑名单] 引用消息解析失败，跳过引用判定：${error?.message ?? error}`);
    }
  }
  const gate = (0, pure.gateAiBlacklistSend)({
    cfg: deps.cfg?.socialV2?.aiBlacklist,
    kind: info.kind,
    replyToUserId,
    atUserIds: info.atUserId !== undefined && info.atUserId !== null ? [info.atUserId] : [],
    texts: info.messages
  });
  if (!gate || gate.allow !== false) return false;
  // 工具调用日志：result 里带 blocked/reason，事后能回答「这条为什么没发出去」。
  try {
    (0, deps.appendToolLog)({
      type: 'result',
      time: new Date().toISOString(),
      key: info.key,
      tool: info.tool,
      ok: false,
      blocked: 'ai-blacklist',
      reason: gate.reason,
      error: gate.text
    });
  } catch (error) {
    (0, deps.log)(`[AI黑名单] 写工具调用日志失败：${error?.message ?? error}`);
  }
  (0, deps.log)(`[AI黑名单] 发送前拦截 ${info.key}（${gate.reason}）`);
  (0, deps.appendActivity)(`${info.key} [AI黑名单] 发送前拦截（${gate.reason}）`);
  request.sendJson({ ok: false, blocked: 'ai-blacklist', reason: gate.reason, error: gate.text }, 403);
  return true; /* @bridge-handled */
}

async function sendMessageAutoVoice(deps, request, ctx) {
  const { key, messages } = ctx;
  // 对方明确要「听声音」时，直接把这条文字回复转成语音（不依赖模型记得 [语音] 前缀）。
  if (messages.length === 1 && (0, deps.ttsCfg)().autoWhenAsked) {
    const stNow = (0, deps.getSocialV2State)(key);
    const lastIn = [...(stNow.recentMessages || [])].reverse().find((m) => !m.isSelf);
    const dirHelpers2 = await (0, deps.ttsHelpers)();
    if (lastIn && dirHelpers2.wantsVoiceReply(lastIn.text)) {
      if ((0, deps.ttsCfg)().enabled && (0, deps.voiceCfg)().enabled) {
        const spoken2 = dirHelpers2.sanitizeTtsText(messages[0], dirHelpers2.clampTtsMaxChars((0, deps.ttsCfg)().maxChars));
        if (spoken2.text) {
          const voiceName2 = dirHelpers2.resolveTtsVoice((0, deps.ttsCfgForKey)(key).voice);
          try {
            const synth2 = await (0, deps.synthesizeTts)(spoken2.text, voiceName2, (0, deps.ttsCfgForKey)(key).style, key);
            deps.fs.mkdirSync((0, deps.ttsCfg)().dir, { recursive: true });
            // 扩展名必须按**实际合成结果**走：Edge 给 mp3、QQ 给 .silk。
            // 写死 .silk 会让 Edge 的 mp3 落成 .silk，发送层按 SILK 处理 → 转码失败/发不出。
            const fname2 = dirHelpers2.ttsFileName(spoken2.text, Date.now()).replace(/\.silk$/, synth2.ext || '.silk');
            const abs2 = deps.path.join((0, deps.ttsCfg)().dir, fname2);
            deps.fs.writeFileSync(abs2, synth2.buf);
            const rel2 = deps.path.relative((0, deps.voiceCfg)().dir, abs2).split(deps.path.sep).join('/');
            const sent2 = await (0, deps.sendVoiceForV2)(key, rel2, { label: '[语音]', autoToken: synth2.autoToken });
            (0, deps.log)(`[tts] ${key} 按需自动转语音 ${fname2}`);
            request.sendJson({ ok: true, via: 'tts-auto', key, voice: voiceName2, text: spoken2.text, file: rel2, sent: sent2 });
            return true; /* @bridge-handled */
          } catch (error) {
            (0, deps.log)(`[tts] ${key} 自动转语音失败，退回文字：${error?.message ?? error}`);
          }
        }
      }
    }
  }
}

async function sendMessageVoiceDirective(deps, request, ctx) {
  const { key, messages } = ctx;
  // 语音兜底通道：消息以 [语音] 开头就合成语音发出（MCP 工具没刷新时也能用）。
  if (messages.length === 1) {
    const dirHelpers = await (0, deps.ttsHelpers)();
    const directive = dirHelpers.parseVoiceDirective(messages[0]);
    if (directive.isVoice) {
      if (!(0, deps.ttsCfg)().enabled) { request.sendJson({ ok: false, error: 'AI 语音功能已关闭（socialV2.tts.enabled=false）' }, 403); return true; /* @bridge-handled */ }
      if (!(0, deps.voiceCfg)().enabled) { request.sendJson({ ok: false, error: '语音发送已关闭（socialV2.voice.enabled=false）' }, 403); return true; /* @bridge-handled */ }
      const spoken = dirHelpers.sanitizeTtsText(directive.text, dirHelpers.clampTtsMaxChars((0, deps.ttsCfg)().maxChars));
      if (!spoken.text) { request.sendJson({ ok: false, error: '[语音] 后面没有可朗读的内容' }, 400); return true; /* @bridge-handled */ }
      const voiceName = dirHelpers.resolveTtsVoice((0, deps.ttsCfgForKey)(key).voice);
      try {
        const synth = await (0, deps.synthesizeTts)(spoken.text, voiceName, (0, deps.ttsCfgForKey)(key).style, key);
        deps.fs.mkdirSync((0, deps.ttsCfg)().dir, { recursive: true });
        const fname = dirHelpers.ttsFileName(spoken.text, Date.now()).replace(/\.silk$/, synth.ext || '.silk');
        const abs = deps.path.join((0, deps.ttsCfg)().dir, fname);
        deps.fs.writeFileSync(abs, synth.buf);
        const rel = deps.path.relative((0, deps.voiceCfg)().dir, abs).split(deps.path.sep).join('/');
        const sent = await (0, deps.sendVoiceForV2)(key, rel, { label: '[语音]', autoToken: synth.autoToken });
        (0, deps.log)(`[tts] ${key} 已发送语音（[语音] 前缀通道）${fname}`);
        request.sendJson({ ok: true, via: 'tts', key, voice: voiceName, text: spoken.text, file: rel, sent });
      } catch (error) {
        (0, deps.log)(`[tts] ${key} 语音发送失败：${error?.message ?? error}`);
        request.sendJson({ ok: false, error: String(error?.message ?? error) }, 502);
      }
      return true; /* @bridge-handled */
    }
  }
}

async function sendMessageQuota(deps, request, ctx) {
  const { key, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps, kind, id } = ctx;
  const sendCfg = deps.cfg.socialV2?.send ?? {};
  const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
  const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
  if (messages.length > maxMsgs) {
    request.sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
    return true; /* @bridge-handled */
  }
  for (const msg of messages) {
    if (msg.length > maxChars) {
      request.sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
      return true; /* @bridge-handled */
    }
    if (deps.SENSITIVE_RE.test(msg)) {
      request.sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
      return true; /* @bridge-handled */
    }
  }
  const delays = (0, deps.computeGapsV2)(messages, gapMode, gapMs, gaps, sendCfg);
  // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
  const st = (0, deps.getSocialV2State)(key);
  const now = Date.now();
  const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
  const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
  const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
  const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
  if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
    request.sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
    return true; /* @bridge-handled */
  }
  // 先预占发送额度，避免并发绕过限频
  for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
  if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
  let quotedInfo = null;
  let actualReplyToMessageId = replyToMessageId;
  if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
    const resolved = await (0, deps.resolveReplyTargetV2)(st, kind, id, String(replyToMessageId).trim());
    if (!resolved) {
      // 引用解析失败：回滚已预占的发送额度
      for (let i = 0; i < messages.length; i++) {
        const idx = st.sendTimes.indexOf(now);
        if (idx >= 0) st.sendTimes.splice(idx, 1);
      }
      (0, deps.saveSocialV2State)();
      request.sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
      return true; /* @bridge-handled */
    }
    quotedInfo = resolved.info;
    actualReplyToMessageId = resolved.messageId;
  }
    return { key, messages, delays, atUserId, actualReplyToMessageId, quotedInfo, st, now };
}

async function sendMessageFinal(deps, request, ctx) {
  const { key, messages, delays, atUserId, actualReplyToMessageId, quotedInfo, st, now } = ctx;
  try {
    const sentMessages = await (0, deps.sendMessagesV2)(key, messages, delays, actualReplyToMessageId, atUserId);
    (0, deps.recordSentMessagesV2)(key, sentMessages);
    st.lastAiReplyAt = now;
    st.lastActionAt = now;
    st.wakeConfig.noActionCount = 0;
    (0, deps.saveSocialV2State)();
    (0, deps.log)(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
    (0, deps.appendActivity)(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
    if (sentMessages.length > 0) (0, deps.scheduleReplyCheckV2)(key);
    const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
    const spaceWarn = (0, deps.findCjkSpaceWarning)(messages);
    const splitWarn = (0, deps.findSplitBoundaryWarning)(messages);
    request.sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
  } catch (error) {
    if (error?.sent?.length) {
      (0, deps.recordSentMessagesV2)(key, error.sent);
      (0, deps.log)(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
    }
    // 失败/未发出的消息回滚预占的发送额度，避免假 429。
    const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
    const failedCount = Math.max(0, messages.length - sentCount);
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

async function routeSendPoke(deps, request) {
  const body = await request.readBody();
  const key = String(body.key ?? '').trim();
  const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
  if (!key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
  if (deps.currentMode !== 'reserved2') { request.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; /* @bridge-handled */ }
  if (!request.req.headers['x-agent-token']) { request.sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return true; /* @bridge-handled */ }
  if (!request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
  if (!request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
  if (!(0, deps.v2ToolEnabled)('sendPoke')) { request.sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return true; /* @bridge-handled */ }
  if (deps.socialV2.paused) { request.sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return true; /* @bridge-handled */ }
  const keyMatch = /^(group|private):(\d+)$/.exec(key);
  if (!keyMatch) { request.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; /* @bridge-handled */ }
  const kind = keyMatch[1];
  const id = Number(keyMatch[2]);
  if (!Number.isFinite(id) || id <= 0 || !(0, deps.modeAllowed)(key, kind, id, deps.cfg, deps.currentMode)) {
    request.sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
    return true; /* @bridge-handled */
  }
  if ((0, deps.shouldBlockSilentReply)(key)) { request.sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return true; /* @bridge-handled */ }
  if (kind === 'group' && !targetUserId) {
    request.sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
    return true; /* @bridge-handled */
  }
  if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
    request.sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
    return true; /* @bridge-handled */
  }
  // 群聊必须确认目标确实是本群成员（私聊天然只有双方，无需校验）。
  if (kind === 'group') {
    const memberError = await (0, deps.assertGroupMember)(id, targetUserId);
    if (memberError) { request.sendJson({ ok: false, error: memberError }, 403); return true; /* @bridge-handled */ }
  }
  const st = (0, deps.getSocialV2State)(key);
  const sendCfg = deps.cfg.socialV2?.send ?? {};
  const now = Date.now();
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
  // 成员校验是异步的（要问 OneBot）；期间操作者可能切模式/改白名单/开静默。
  // 拍一拍此前完全没有发送守卫，这里补上：真正发之前再确认一次。
  const sendGuard = (0, deps.captureSendGuard)(key);
    return sendPokeSend(deps, request, { key, kind, id, targetUserId, st, now, sendGuard });
}

async function sendPokeSend(deps, request, ctx) {
  const { key, kind, id, targetUserId, st, now, sendGuard } = ctx;
  try {
    sendGuard();
    if ((0, deps.shouldBlockSilentReply)(key)) {
      const blocked = new Error('静默模式已开启，当前不允许拍一拍');
      blocked.statusCode = 403;
      throw blocked;
    }
    if (kind === 'group') {
      await deps.bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
    } else {
      // 私聊拍一拍：send_poke 自动路由到当前私聊对象
      await deps.bot.raw('send_poke', { user_id: id });
    }
    st.lastActionAt = now;
    st.lastAiReplyAt = now;
    st.wakeConfig.noActionCount = 0;
    const pokeText = kind === 'group'
      ? `[拍一拍] 我拍了拍 ${targetUserId}`
      : '[拍一拍] 我拍了拍你';
    st.recentMessages.push({
      messageId: null,
      sender: '我',
      text: pokeText,
      plain: pokeText,
      tail: pokeText,
      kind: 'poke',
      quoteTargetIsSelf: false,
      isOwner: true,
      ownerLabel: '我',
      isSelf: true,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
      time: Date.now()
    });
    const recentLimit = Number(deps.cfg.socialV2?.context?.recentLimit) || 100;
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    (0, deps.saveSocialV2State)();
    (0, deps.log)(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
    (0, deps.appendActivity)(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
    request.sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
  } catch (error) {
    const idx = st.sendTimes.indexOf(now);
    if (idx >= 0) st.sendTimes.splice(idx, 1);
    if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
    (0, deps.log)(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
    request.sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, error?.statusCode ?? 500);
  }
  return true; /* @bridge-handled */
}

async function routeStickerImage(deps, request) {
  // ── 表情包体系（reserved2） ──────────────────────────────────────
  if (!(0, deps.stickerEnabled)()) { request.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; /* @bridge-handled */ }
  const key = String(request.url.searchParams.get('key') ?? '').trim();
  const stickerId = String(request.url.searchParams.get('stickerId') ?? '').trim();
  if (!key || !stickerId) { request.sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('getStickerImage')) { request.sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return true; /* @bridge-handled */ }
  try {
    const entry = await (0, deps.getStickerImageData)(stickerId);
    const fetched = await (0, deps.safeFetchBuffer)(entry.url, deps.MAX_MEDIA_BYTES);
    const dims = (0, deps.getImageDimensions)(fetched.buffer);
    if (dims && dims.width * dims.height > deps.MAX_MEDIA_PIXELS) {
      request.sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
      return true; /* @bridge-handled */
    }
    const mimeType = (0, deps.mimeFromBuffer)(fetched.buffer) || (0, deps.mimeFromUrl)(entry.url);
    const prep = await (0, deps.toModelMedia)(fetched.buffer, mimeType, `收藏表情 ${entry.id}`);
    if (!prep.ok) {
      request.sendJson({ ok: false, error: `表情图片无法提供给模型：${prep.error}` }, 413);
      return true; /* @bridge-handled */
    }
    request.sendJson({
      ok: true,
      key,
      sticker: {
        id: entry.id,
        desc: entry.desc || '',
        localNote: entry.localNote || '',
        tags: entry.tags || [],
        url: entry.url,
        md5: entry.md5
      },
      image: { mimeType: prep.mimeType, data: prep.buffer.toString('base64') },
      ...(prep.note ? { note: prep.note } : {})
    });
  } catch (error) {
    request.sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
  }
  return true; /* @bridge-handled */
}

async function routeSelfImage(deps, request) {
  const key = String(request.url.searchParams.get('key') ?? '').trim();
  if (!key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('getSelfImage')) { request.sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return true; /* @bridge-handled */ }
  const selfPath = deps.path.join(deps.ROOT, 'assets', 'deepseek娘.png');
  try {
    if (!deps.fs.existsSync(selfPath)) { request.sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return true; /* @bridge-handled */ }
    const buf = deps.fs.readFileSync(selfPath);
    const mimeType = (0, deps.mimeFromBuffer)(buf) || 'image/png';
    request.sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
  } catch (error) {
    request.sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
  }
  return true; /* @bridge-handled */
}

// 路由表：key = "METHOD /path"。以前这些分支是一长串 if 守卫，加一条路由要翻 600 行；
// 现在注册表 + 每个路由一个小函数，新增/删除路由只动表和对应函数。
const CONVERSATION_SEND_ROUTES = new Map([
  ['GET /api/socialV2/initial-prompt', routeInitialPrompt],
  ['POST /api/socialV2/initial-prompt', routeInitialPrompt],
  ['POST /api/socialV2/send-burst', routeSendBurst],
  ['POST /api/socialV2/send-message', routeSendMessage],
  ['POST /api/socialV2/send-poke', routeSendPoke],
  ['GET /api/socialV2/sticker-image', routeStickerImage],
  ['GET /api/socialV2/self-image', routeSelfImage]
]);

export function createConsoleConversationSend(deps) {
// @bridge-function handleConsoleConversationSend:start
async function handleConsoleConversationSend(request) {
  const route = CONVERSATION_SEND_ROUTES.get(`${request.req.method} ${request.url.pathname}`);
  if (route) return route(deps, request);
  // 表情包升权：只有人工（控制台）能把表情从「只看不发」升到「可以发」。
  // 表情缩略图：服务端转发（浏览器直连 QQ 图床会被防盗链拦成 403/空白）。
  //
  // 历史坑（线上「四张图片已失效」的直接原因）：不同表情的 id 可能撞车
  // （旧版按 url 尾部 24 字符生成 id，多媒体链接尾部相同），而这里原先只 find 第一条。
  // 第一条链接过期 ⇒ 同一个 id 下四张卡片全显示「图片已失效」。
  // 现在：同 id 的条目逐个候选尝试，谁有缓存/谁能取到就给谁。
  return false;
}
// @bridge-function handleConsoleConversationSend:end

  return { handleConsoleConversationSend };
}
