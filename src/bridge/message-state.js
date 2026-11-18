// message-state: extracted bridge responsibilities; no startup side effects.
// Live dependencies: affinityNoteInbound, archiveAppend, cfg, detectPersonaRequest, enrichVideoFile, getSocialV2State, log, markMediaTurn, maybeCollectSticker, maybeRefreshDigest, modelSelectionEpoch, notePersonaRequest, peopleNoteInbound, redactKnownTokensOnly, sanitizeForwardId, sanitizeMediaSummary, saveSocialV2State, seenForwardIds, truncateText, truncateTextTail
export function createMessageState(deps) {
// @bridge-function appendSocialV2Message:start
function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = [], quoted = null) {
    const st = (0, deps.getSocialV2State)(key);
    // D39：换人设请求在**入站**就判定（不依赖 prompt 窗口），命中后记 pending，出站时兜底补 /persona。
    try {
      const personaDet = (0, deps.detectPersonaRequest)(String(textContent ?? ''));
      if (personaDet.hit) (0, deps.notePersonaRequest)(key, String(userId ?? ''), String(textContent ?? ''), personaDet);
    } catch {}
    const recentLimit = Number(deps.cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(deps.cfg.socialV2?.context?.unreadLimit) || 30;
    // 存储层的归一化**不能只留 kind/file/url/faceId**：reserved2 的图片/表情工具
    // （findMessageMedia → fetchOneBotImage / fetchMediaData）只从这里的产物取字段。
    // 丢了 emojiId/subType，fetchOneBotImage 的 isSticker 判定为假 ⇒ 市场/收藏表情会先走
    // 必然失败的 get_image、且 emoji_id 推出的 CDN 兜底整条失效（见 extractMediaFromSegments
    // 与「部分表情 20 秒超时」的根因）；丢了 summary，模型只看到「[图片1]」而不是「[表情:给你糖吃]」；
    // kind 被拍平还会让 mface（市场表情）被当成普通图片。
    const safeMedia = Array.isArray(media) ? media.map((m) => {
      const kind = m?.kind === 'face' ? 'face' : (m?.kind === 'sticker' ? 'sticker' : (m?.kind === 'video-file' ? 'video-file' : 'image'));
      const item = { kind };
      if (m?.file) item.file = String(m.file);
      if (m?.url) item.url = String(m.url);
      if (m?.faceId) item.faceId = String(m.faceId);
      if (m?.emojiId) item.emojiId = String(m.emojiId);
      if (m?.summary) item.summary = (0, deps.sanitizeMediaSummary)(m.summary);
      if (m?.subType) item.subType = String(m.subType);
      if (m?.name) item.name = String(m.name).slice(0, 120);
      if (m?.size) item.size = Number(m.size) || 0;
      return item;
    }).filter((m) => (m.kind === 'face' ? !!m.faceId : !!(m.file || m.url || m.emojiId))) : [];
    // 引用段的目标消息：控制台要能在「引用」框里看见原文**和它带的图片**，所以除了
    // 已经拼进 text 的「[引用 谁：原文]」，再存一份结构化副本（只留展示需要的字段）。
    let safeQuoted = null;
    if (quoted && typeof quoted === 'object') {
      const qMedia = Array.isArray(quoted.media) ? quoted.media.slice(0, 3).map((m) => {
        const item = { kind: m?.kind === 'sticker' ? 'sticker' : 'image' };
        if (m?.file) item.file = String(m.file);
        if (m?.url) item.url = String(m.url);
        if (m?.summary) item.summary = (0, deps.sanitizeMediaSummary)(m.summary);
        return item;
      }).filter((m) => !!(m.file || m.url)) : [];
      const qText = (0, deps.truncateText)(String(quoted.text ?? ''), 120);
      if (qText || qMedia.length) {
        safeQuoted = {
          messageId: quoted.messageId != null && String(quoted.messageId) ? String(quoted.messageId).slice(0, 40) : null,
          sender: (0, deps.truncateText)(String(quoted.sender ?? ''), 40),
          userId: quoted.userId != null ? String(quoted.userId) : null,
          text: qText,
          media: qMedia
        };
      }
    }
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(deps.sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = deps.seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        deps.seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      text: (0, deps.truncateText)(String(textContent), 200),
      plain: (0, deps.truncateText)(String(plainContent ?? textContent), 200),
      tail: (0, deps.truncateTextTail)(String(plainContent ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${deps.cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      ...(safeQuoted ? { quoted: safeQuoted } : {}),
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    (0, deps.maybeRefreshDigest)(key, st);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    // 新消息带图/表情 → 记「这个群最近出现过图」（内存 + 状态，重启后不丢），
    // 这样下一轮哪怕只是普通文字唤醒，也会选能看图的模型；否则模型中途调取图工具必然读不出画面。
    // 只有真图片/表情包才需要视觉模型：QQ 小黄脸(face) 有文字含义、不需要读画面，别为它把整段会话切到视觉模型。
    if (Array.isArray(safeMedia) && safeMedia.some((m) => m && (m.kind === 'image'
      || (m.kind === 'sticker' && deps.cfg?.socialV2?.mediaVision?.stickers === true)))) (0, deps.markMediaTurn)(key);
    // ① 好感度入站结算：每条入站消息攒证据（跨天/日上限都在 affinity.js 里，不改 base）。
    if (userId) {
      try {
        (0, deps.affinityNoteInbound)(key, userId, String(textContent ?? ''), {
          at: quoteTargetIsSelf === true,
          media: safeMedia.some((m) => m && m.kind !== 'video-file'),
          sticker: safeMedia.some((m) => m && (m.kind === 'sticker' || m.kind === 'face'))
        });
      } catch {}
      // 跨群认人（D42）：记一笔「谁在这个群说过话」，别名从 sender/群名片/台账三处来。
      // 开关默认关；关着时这里什么都不做（不建文件、不加锁、不记日志）。
      try { (0, deps.peopleNoteInbound)(key, userId, sender, String(textContent ?? '')); } catch {}
    }
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    (0, deps.saveSocialV2State)();
    // 归档：把每条收到的消息追加到 7 天滚动归档，供 /recall 关键词检索。
    (0, deps.archiveAppend)(key, msg);
    // 表情收集：看图的同时顺手统计，够次数就入库。
    (0, deps.maybeCollectSticker)(key, safeMedia, sender);
    // 新消息带媒体 → 让下一次回合重新选模型（切到能看图的）。
    if (Array.isArray(safeMedia) && safeMedia.some((m) => m && m.kind !== 'video-file')) { try { deps.modelSelectionEpoch += 1; } catch {} }
    // 文件形式的视频：异步抽帧 + 转写，完成后回填到这条消息。
    // 任务登记（stage）由 enrichVideoFile 自己同步完成；这里只兜住异常日志，
    // 不要再把整个 Promise 塞进 pendingVideoEnrich —— 它不是 stagedTask，
    // 混在一起会让「等帧/等转写」拿到 undefined（旧实现的等待因此时灵时不灵）。
    for (const mv of safeMedia) {
      if (!mv || mv.kind !== 'video-file') continue;
      void Promise.resolve((0, deps.enrichVideoFile)(key, mv, msg))
        .catch((e) => (0, deps.log)(`[video] ${key} 抽帧/转写失败：${e?.message ?? e}`));
    }
  }
// @bridge-function appendSocialV2Message:end

// @bridge-function appendSocialV2Poke:start
function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = (0, deps.getSocialV2State)(key);
    const recentLimit = Number(deps.cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(deps.cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${deps.cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    (0, deps.saveSocialV2State)();
    return msg;
  }
// @bridge-function appendSocialV2Poke:end

// @bridge-function recordSentMessagesV2:start
function recordSentMessagesV2(key, messages) {
    const st = (0, deps.getSocialV2State)(key);
    const now = Date.now();
    const recentLimit = Number(deps.cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const raw = list[i];
      // 支持两种形态：纯文本（老调用），或 { text, media, messageId }（发图/发表情也要进时间线）。
      const entry = raw && typeof raw === 'object' ? raw : { text: raw };
      const text = (0, deps.redactKnownTokensOnly)(String(entry.text ?? '')).slice(0, 200);
      const media = Array.isArray(entry.media) ? entry.media.map((m) => {
        const kind = m?.kind === 'sticker' ? 'sticker' : (m?.kind === 'face' ? 'face' : 'image');
        const item = { kind };
        if (m?.file) item.file = String(m.file);
        if (m?.url) item.url = String(m.url);
        if (m?.emojiId) item.emojiId = String(m.emojiId);
        if (m?.summary) item.summary = (0, deps.sanitizeMediaSummary)(m.summary);
        return item;
      }).filter((m) => !!(m.file || m.url || m.emojiId)) : [];
      st.recentMessages.push({
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        messageId: entry.messageId != null ? String(entry.messageId) : null,
        media,
        hasMedia: media.length > 0,
        time: now + i * 1000
      });
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    (0, deps.saveSocialV2State)();
  }
// @bridge-function recordSentMessagesV2:end
  return { appendSocialV2Message, appendSocialV2Poke, recordSentMessagesV2 };
}
