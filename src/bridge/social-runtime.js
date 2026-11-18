// social-runtime: extracted bridge responsibilities; no startup side effects.
// Live dependencies: DIRECTION_HINT, SILENT_MARKER, SPACE_SPLIT_HINT, cfg, clearTimeout, currentMode, currentRoleHint, log, mediaHintFor, messageMediaStore, promptQueues, randInt, scheduleSocialReply, selfNickname, social, truncateText
export function createSocialRuntime(deps) {
// @bridge-function isSocialEnabled:start
function isSocialEnabled() {
    return deps.currentMode === 'reserved' && deps.cfg.social?.enabled !== false;
  }
// @bridge-function isSocialEnabled:end

// @bridge-function socialState:start
function socialState(key) {
    if (!deps.social.states.has(key)) {
      deps.social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return deps.social.states.get(key);
  }
// @bridge-function socialState:end

// @bridge-function isDirectAddress:start
function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (deps.selfNickname && (lower.includes('@' + deps.selfNickname) || lower.includes(deps.selfNickname))) return true;
    for (const kw of (deps.cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }
// @bridge-function isDirectAddress:end

// @bridge-function isDirectedAtAi:start
function isDirectedAtAi(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
    const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
    const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
    if (aiMention && (question || challenge)) return true;
    // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
    if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
    if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
    // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
    if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
    // 追问/催促：AI 没回时的真人式催促
    if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
    return false;
  }
// @bridge-function isDirectedAtAi:end

// @bridge-function isMustReplyText:start
function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (deps.selfNickname && (lower.includes('@' + deps.selfNickname) || lower.includes(deps.selfNickname))) return true;
    for (const kw of (deps.cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }
// @bridge-function isMustReplyText:end

// @bridge-function appendRecentMessage:start
function appendRecentMessage(key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '') {
    if (!deps.social.recentMessages.has(key)) deps.social.recentMessages.set(key, []);
    const arr = deps.social.recentMessages.get(key);
    arr.push({
      sender,
      text: (0, deps.truncateText)(String(textContent), 200),
      plain: (0, deps.truncateText)(String(plainText ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      time: Date.now()
    });
    const cap = Math.max(50, Number(deps.cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }
// @bridge-function appendRecentMessage:end

// @bridge-function appendSummary:start
function appendSummary(key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!deps.social.pendingSummaries.has(key)) {
      deps.social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = deps.social.pendingSummaries.get(key);
    entry.items.push({ sender, text: (0, deps.truncateText)(String(textContent), 200), plain: (0, deps.truncateText)(String(plainText ?? textContent), 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }
// @bridge-function appendSummary:end

// @bridge-function buildContextBlock:start
function buildContextBlock(key) {
    const ctx = (deps.social.recentMessages.get(key) ?? []).slice(-Number(deps.cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${(0, deps.mediaHintFor)(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }
// @bridge-function buildContextBlock:end

// @bridge-function enterActive:start
function enterActive(key) {
    const now = Date.now();
    const st = socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + (0, deps.randInt)(Number(deps.cfg.social?.activeCheckMinMs ?? 20000), Number(deps.cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 从进入活跃那一刻起，随机一个“最长活跃持续时间”；到点后主动收尾退场（当前仅群聊启用）
    if (key.startsWith('group:') && deps.cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + (0, deps.randInt)(
        Number(deps.cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(deps.cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }
// @bridge-function enterActive:end

// @bridge-function cancelSocialTimers:start
function cancelSocialTimers(key) {
    const timers = deps.social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) (0, deps.clearTimeout)(t);
    deps.social.pendingTimers.delete(key);
  }
// @bridge-function cancelSocialTimers:end

// @bridge-function cancelAllSocialTimers:start
function cancelAllSocialTimers() {
    for (const timers of deps.social.pendingTimers.values()) {
      for (const t of timers) (0, deps.clearTimeout)(t);
    }
    deps.social.pendingTimers.clear();
  }
// @bridge-function cancelAllSocialTimers:end

// @bridge-function cleanupSocialForModeChange:start
function cleanupSocialForModeChange() {
    cancelAllSocialTimers();
    deps.social.states.clear();
    deps.social.recentMessages.clear();
    deps.messageMediaStore.clear();
    deps.social.pendingSummaries.clear();
    deps.social.silentContext.clear();
    deps.social.silentTurns.clear();
    deps.social.exitingSessions.clear();
    // 拒绝仍在排队中的 prompt，避免调用方 await 永远挂起
    for (const [, entry] of deps.promptQueues) {
      for (const item of entry.queue) item.reject(new Error('模式切换，已取消排队中的投递'));
    }
    deps.promptQueues.clear();
  }
// @bridge-function cleanupSocialForModeChange:end

// @bridge-function leaveActive:start
function leaveActive(key) {
    cancelSocialTimers(key);
    deps.social.states.delete(key);
    deps.social.silentContext.delete(key);
  }
// @bridge-function leaveActive:end

// @bridge-function buildBatchPrompt:start
function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    const lines = newMsgs.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${(0, deps.mediaHintFor)(key, m.messageId, m.media)}`).join('\n');
    const directionHint = lines.includes('[引用') ? `${deps.DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `【新消息】\n${lines}\n\n${directionHint}请回复消息。\n${deps.SPACE_SPLIT_HINT}`;
    }
    return `【新消息】\n${lines}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${deps.SILENT_MARKER}；否则正常回复。\n${deps.SPACE_SPLIT_HINT}`;
  }
// @bridge-function buildBatchPrompt:end

// @bridge-function buildProbePrompt:start
function buildProbePrompt(key) {
    return `【群聊上下文】\n${buildContextBlock(key)}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${deps.SILENT_MARKER}。\n${deps.SPACE_SPLIT_HINT}`;
  }
// @bridge-function buildProbePrompt:end

// @bridge-function buildActiveExitPrompt:start
function buildActiveExitPrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }
// @bridge-function buildActiveExitPrompt:end

// @bridge-function triggerActiveDurationExit:start
function triggerActiveDurationExit(key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊启用，私聊不自动退场
    if (deps.cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消尚未触发的旧回复/补刀定时器，避免退场期间再冒出旧发言
    cancelSocialTimers(key);
    const roleHint = (0, deps.currentRoleHint)();
    const promptText = buildActiveExitPrompt(key, roleHint);
    (0, deps.scheduleSocialReply)(
      key, promptText,
      Number(deps.cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(deps.cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    (0, deps.log)(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }
// @bridge-function triggerActiveDurationExit:end

// @bridge-function buildProactivePrompt:start
function buildProactivePrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${deps.SILENT_MARKER}。\n${deps.SPACE_SPLIT_HINT}`;
    return p;
  }
// @bridge-function buildProactivePrompt:end
  return { isSocialEnabled, socialState, isDirectAddress, isDirectedAtAi, isMustReplyText, appendRecentMessage, appendSummary, buildContextBlock, enterActive, cancelSocialTimers, cancelAllSocialTimers, cleanupSocialForModeChange, leaveActive, buildBatchPrompt, buildProbePrompt, buildActiveExitPrompt, triggerActiveDurationExit, buildProactivePrompt };
}
