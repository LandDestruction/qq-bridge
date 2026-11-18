// incoming-runtime: extracted bridge responsibilities; no startup side effects.
// Live dependencies: DIRECTION_HINT, DSH_CONTROL_TIMEOUT_MS, MAX_MEDIA_STORE_PER_KEY, QUEUE_HINT_COOLDOWN_MS, QUEUE_MAX, ROOT, SENSITIVE_RE, SILENT_MARKER, SPACE_SPLIT_HINT, aiBlacklistCheck, allowed, api, appendActivity, appendRecentMessage, appendSocialV2Message, appendSummary, archiveCfgFor, archiveChatFileSegments, archiveMediaAttachment, auditAndSend, buildContextBlock, cancelPendingEntry, cancelSocialTimers, classifyArchivedFile, classifyAttachment, clearSocialV2Timers, clearTimeout, collectors, consumePrivateQuota, convKey, currentMode, currentRoleHint, deliverPrompt, drainPromptQueue, dshReady, enqueueForRetry, enrichVideoFile, ensureChatModel, ensureGroupFolderName, ensureSession, enterActive, evaluateWakeTriggerV2, extractForwardIds, extractMediaFromSegments, feedSlangWindow, fetchOneBotImage, fileArchiveDeps, forgetAgentToken, formatArchiveBytes, formatLeft, fs, getSocialV2State, handleGroupCommand, handlePendingAnswer, isArchiveGroup, isCurrentSession, isDirectAddress, isGroupMember, isQuoteTargetSelf, isSessionAllowedInCurrentMode, isSocialEnabled, log, markReadCalledKeys, mdToPlain, mediaHintFor, messageMediaStore, modelAppliedSessions, muteUntilOf, observeLearnFromGroupMessage, path, peakAgentCfg, peakPauseActive, peakPauseLogged, pending, pendingSendToolCalls, pendingWakeKeys, planObserveLearning, privateQuotaCfg, pushArchiveFacts, queued, queuedHintAt, quotaInfo, raceWithTimeout, readRoleState, recentUserGroup, resolveGroupMemberName, resolveMediaList, resolveReplyInfo, reverse, sanitizeRoleName, saveSocialV2State, saveState, scheduleArchiveEnrichment, scheduleSocialReply, scheduleWakeV2, seenForwardIds, segmentsToText, sendToQQ, sendToolSucceededSessions, sessionEpoch, sessionPromises, shouldAuditKey, slangExtractionCooldowns, slangSubmitTimes, slangWindows, social, socialState, socialV2, state, toolCallNames, triggerActiveDurationExit, turnLeaseNoted, unauthorizedPrivateRepliedAt, v2TurnStartAt, videoFollowUps, wakeConfigMissCount, wakeConfigUpdatedKeys, whitelistedOnly, withArchiveFactsHint, withSlangContext, withTimeout, writeRoleState
// D73：owner 私聊 /aiban 的入口判定与回执。
// 返回 true 表示已处理（调用方必须 return：管理命令不能落进 DSH 回合）；
// 返回 false 表示不是本功能命令，继续走正常聊天流程。
async function tryHandleAiBlacklistCommand(deps, cfg, kind, id, event) {
  if (kind !== 'private' || typeof deps.isAiBlacklistCommand !== 'function') return false;
  let cmdText = '';
  try {
    cmdText = String(await (0, deps.segmentsToText)(event.message ?? [], { includeReply: false }) || '').trim();
  } catch { cmdText = ''; }
  if (!cmdText || !(0, deps.isAiBlacklistCommand)(cmdText)) return false;
  const sender = String(event.user_id ?? id);
  // 只认 ownerQQ；其他人发同一命令一律静默丢弃（不回、不打日志噪音）。
  if (sender !== String(cfg.ownerQQ ?? '')) return true;
  const result = (0, deps.runAiBlacklistCommand)({
    text: cmdText,
    admin: deps.aiBlacklistAdmin,
    stats: () => deps.aiBlacklist?.stats?.() ?? { skippedToday: 0 },
    log: deps.log
  });
  if (result?.handled) {
    await (0, deps.sendToQQ)(`private:${sender}`, String(result.reply ?? '')).catch((error) => {
      (0, deps.log)(`[AI黑名单] 私聊回执发送失败 ${sender}：${error?.message ?? error}`);
    });
  }
  return true;
}

async function archiveIncomingFiles(deps, cfg, kind, id, key, event) {
  // 聊天里「发文件」走的是消息 file 段，**不是** group_upload 事件（实测：线上 messages.db
  // 里就是 `[文件Onyx_Hair_v1.0.zip]` 这类消息，而 group_upload 一条都没有）。所以这里也要转存，
  // 否则用户把文件拖进聊天窗口时机器人什么都没存。
  // 白名单外 archiveChatFileSegments 直接返回 null：不下载、不记账，行为完全不变。
  if (kind === 'group' && cfg.fileArchive?.simpleMode === true) { await (0, deps.ensureGroupFolderName)(id); }
  const chatFileArchive = kind === 'group'
    ? await (0, deps.archiveChatFileSegments)({
      segments: event.message ?? [],
      groupId: id,
      cfg: (0, deps.archiveCfgFor)(id),
      deps: (0, deps.fileArchiveDeps)(id, event)
    }).catch((error) => {
      // 转存失败绝不能拖垮消息投递：文件存没存都不影响这句聊天本身。
      (0, deps.log)(`聊天文件转存失败（不影响消息投递）：${error?.message ?? error}`);
      return null;
    })
    : null;
  for (const item of chatFileArchive?.archived ?? []) {
    (0, deps.log)(`聊天文件已转存：群 ${id}「${item.storedName}」${(0, deps.formatArchiveBytes)(item.bytes)}`
      + ` → ${item.relPath}（分类 ${item.category}/${item.categorySource}，清理时间 ${new Date(item.cleanupAt).toLocaleString('zh-CN', { hour12: false })}）`);
    if (item.categorySource === 'none' && item.inserted) {
      void (0, deps.classifyArchivedFile)(item.id, item.storedName).catch((error) => {
        (0, deps.log)(`文件自动分类失败 #${item.id}：${error?.message ?? error}`);
      });
    }
  }
  (0, deps.scheduleArchiveEnrichment)((chatFileArchive?.archived ?? []).map((item) => item.id));
  (0, deps.pushArchiveFacts)(key, chatFileArchive?.facts);
  // 引用里的附件：用户常说「转存一下这张图片/这个文件」再引用原消息，附件在**被引用那条**里。
  // 只在文件白名单群做；失败只记事实/日志，不影响当前消息投递。
  if (kind === 'group' && (0, deps.isArchiveGroup)(cfg.fileArchive, id)) {
    const replySeg = (event.message ?? []).find((s) => s?.type === 'reply' && s.data?.id != null);
    if (replySeg) {
      const quoted = await (0, deps.resolveReplyInfo)('group', id, String(replySeg.data.id)).catch(() => null);
      if (quoted?.fileSegments?.length) {
        const quotedFiles = await (0, deps.archiveChatFileSegments)({
          segments: quoted.fileSegments,
          groupId: id,
          cfg: (0, deps.archiveCfgFor)(id),
          deps: (0, deps.fileArchiveDeps)(id, event)
        }).catch((error) => {
          (0, deps.log)(`引用里的文件转存失败（不影响消息投递）：${error?.message ?? error}`);
          return null;
        });
        (0, deps.pushArchiveFacts)(key, quotedFiles?.facts);
        for (const item of quotedFiles?.archived ?? []) {
          (0, deps.log)(`引用里的文件已转存：群 ${id}「${item.storedName}」${(0, deps.formatArchiveBytes)(item.bytes)}（台账 #${item.id}）`);
        }
        (0, deps.scheduleArchiveEnrichment)((quotedFiles?.archived ?? []).map((item) => item.id));
      }
      for (let i = 0; i < (quoted?.media?.length ?? 0); i += 1) {
        const media = quoted.media[i];
        const qKind = (0, deps.classifyAttachment)({ segType: media?.kind === 'video-file' ? 'video' : '', name: media?.name, file: media?.file, url: media?.url });
        if (qKind === 'video-file') {
          // 引用里的视频也要抽帧/转写。
          // 之前这里直接 skip 并给模型一句「引用里的视频未做抽帧/转写」，用户引用视频问内容时
          // 就必然得到「我没听到声音」——这是 23:20 那次实测的根因。
          // 现在：挂到一个临时消息对象上跑 enrichVideoFile（它会把结果写进 text/media），
          // 最多等 25s；转写没赶上就把「正在转写」如实写进事实，绝不假装听到。
          const tmpMsg = { text: '', plain: '' };
          let qJob = null;
          try {
            // 引用附件里的 kind 可能是 'video'（不是 'video-file'），enrichVideoFile 只认后者。
            // autoClaim=false：这里由调用方在**确认本轮事实已带上转写**后 claim；
            // 没赶上的话，转写完成后 followUp 会主动补发，不用用户再问一遍。
            const mediaForEnrich = { ...media, kind: 'video-file' };
            await (0, deps.raceWithTimeout)((0, deps.enrichVideoFile)(key, mediaForEnrich, tmpMsg, {
              autoClaim: false,
              onJob: (j) => { qJob = j; }
            }), 25000, 'quoted-video-enrich');
          } catch (error) {
            (0, deps.log)(`引用里的视频处理超时/失败（${i + 1}）：${error?.message ?? error}`);
          }
          const qLine = String(tmpMsg.text || '').trim();
          if (qLine) {
            (0, deps.log)(`引用里的视频已分析（群 ${id} 第 ${i + 1} 个引用附件）：${qLine.slice(0, 120)}`);
            (0, deps.pushArchiveFacts)(key, [{ status: /声音里说了/.test(qLine) ? 'ok' : 'failed', name: `引用视频-${i + 1}`, reason: qLine }]);
            // 本轮 prompt 已带上这条视频的事实（含转写或明确失败原因）→ 不再补发。
            if (qJob) deps.videoFollowUps.claim(qJob, '引用视频的事实已写进本轮 prompt');
          } else {
            (0, deps.log)(`引用里的视频未在 25s 内完成抽帧/转写（群 ${id} 第 ${i + 1} 个引用附件）：转写完成后会主动补发`);
            (0, deps.pushArchiveFacts)(key, [{ status: 'pending', name: `引用视频-${i + 1}`, reason: '引用里的视频正在抽帧/转写，转写完成后会主动补给你' }]);
          }
          continue;
        }
        const fetched = await (0, deps.fetchOneBotImage)(media).catch(() => null);
        if (fetched?.buffer) (0, deps.archiveMediaAttachment)(key, media, fetched.buffer, `引用${i + 1}`, fetched.mimeType);
        else (0, deps.pushArchiveFacts)(key, [{ status: 'failed', name: `引用附件-${i + 1}`, reason: '拿不到图片/表情字节' }]);
      }
    }
  }
  return chatFileArchive;
}

async function handleSlashCommands(deps, cfg, key, plainContent, isOwner, roleState) {
  // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
  if (plainContent.startsWith('/')) {
    if (!isOwner) {
      await (0, deps.sendToQQ)(key, '管理命令仅管理员可用。');
      return true;
    }
    if (plainContent === '/reset' || plainContent === '/new') {
      const old = deps.state.sessions[key];
      if (old) {
        deps.sessionEpoch++;
        delete deps.state.sessions[key];
        deps.modelAppliedSessions.delete(old);
        delete deps.state.sessionPolicies[key];
        deps.reverse.delete(old);
        deps.collectors.delete(old);
        deps.sendToolSucceededSessions.delete(old);
        deps.pendingSendToolCalls.delete(old);
        deps.v2TurnStartAt.delete(old);
        deps.turnLeaseNoted.delete(old);
        deps.toolCallNames.delete(old);
        deps.social.silentTurns.delete(old);
        deps.social.exitingSessions.delete(old);
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
        // 与 retireSession 一致：先终止 DSH 侧排队的工作，再归档（归档只隐藏会话）。
        try { await (0, deps.withTimeout)(deps.api.stopSessionWork(old), deps.DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
        catch (error) { (0, deps.log)(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
        try { await (0, deps.withTimeout)(deps.api.workspace.archiveSession({ sessionId: old }), deps.DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
        await (0, deps.sendToQQ)(key, '已重置会话，下次消息将开新上下文');
      }
      return true;
    }
    if (plainContent === '/status') {
      const rs = (0, deps.readRoleState)();
      await (0, deps.sendToQQ)(key, `会话 ${deps.state.sessions[key] ?? '未创建'}；白名单 ${(0, deps.allowed)(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
      return true;
    }
    if (plainContent === '/role' || plainContent.startsWith('/role ')) {
      const name = (0, deps.sanitizeRoleName)(plainContent.slice(5).trim());
      if (!name || name === 'off' || name === 'clear') {
        (0, deps.writeRoleState)(null, roleState.mode);
        await (0, deps.sendToQQ)(key, '已清除角色，恢复正常人格。');
      } else {
        const roleFile = deps.path.join(deps.ROOT, 'roles', name + '.md');
        if (!deps.fs.existsSync(roleFile)) {
          await (0, deps.sendToQQ)(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
        } else {
          (0, deps.writeRoleState)(name, roleState.mode);
          await (0, deps.sendToQQ)(key, `已切换角色：${name}。`);
        }
      }
      return true;
    }
    if (plainContent === '/silent' || plainContent === '/quiet') {
      (0, deps.writeRoleState)(roleState.role, 'silent');
      await (0, deps.sendToQQ)(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
      return true;
    }
    if (plainContent === '/active' || plainContent === '/speak') {
      (0, deps.writeRoleState)(roleState.role, 'active');
      await (0, deps.sendToQQ)(key, '已退出静默模式，恢复正常回复。');
      return true;
    }
    // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
  }
  return false;
}

async function handleReserved2Wake(deps, cfg, key, kind, event, textContent, plainContent, mediaList, quoteTargetIsSelf, isOwner, quotedInfo) {
  // 二代仿真模式（reserved2）：唤醒调度
  if (deps.currentMode === 'reserved2') {
    const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
    (0, deps.appendSocialV2Message)(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, (0, deps.extractForwardIds)(event.message ?? []), quotedInfo);
    // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
    if (kind === 'group') (0, deps.feedSlangWindow)(key, sender, plainContent);
    if (deps.socialV2.paused) {
      (0, deps.appendActivity)(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
      return true;
    }
    const st = (0, deps.getSocialV2State)(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      (0, deps.saveSocialV2State)();
      // 首条消息一律走 bootstrap（需要那条引导 prompt），但**不判断触发条件**：
      // 以前日志只写「（bootstrap）」，看起来像机器人无缘无故说话（08:33 群 100000007 即此）。
      // 这里把这条消息本来会命中的触发源一并打出来，便于区分「被 @」还是「纯首条消息」。
      let firstTrigger = '';
      try { firstTrigger = (0, deps.evaluateWakeTriggerV2)(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) || ''; } catch {}
      // 首条消息只做引导唤醒，但也要把「抬眼」定时器排上——否则新群会无限期一次都不看。
      if (typeof deps.admitWakeV2 === 'function') { try { (0, deps.admitWakeV2)(key, st, null); } catch {} }
      (0, deps.log)(`[reserved2] 新会话首条消息 → bootstrap 引导（该消息本身触发源=${firstTrigger || 'none'}；bootstrap 不等同于被 @/提问）`);
      (0, deps.scheduleWakeV2)(key, 'bootstrap');
    } else {
      const rawReason = (0, deps.evaluateWakeTriggerV2)(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
      // 静默观战：潜水期只认「被点名」（@ / 引用自己 / 叫名字 / 指定成员 / 拍一拍），
      // 关键词、提问、概率一律吞掉；被点名后进入在场态，自己停止说话 engagedMs 后才退回潜水。
      const reason = typeof deps.admitWakeV2 === 'function' ? (0, deps.admitWakeV2)(key, st, rawReason) : rawReason;
      // D70：AI 黑名单闸。命中时 aiBlacklistCheck 只打日志 + 记 pendingWakeReasons，不排唤醒（消息仍在 unread 里）。
      if (reason && !(0, deps.aiBlacklistCheck)(key, event.user_id ?? event.sender?.user_id ?? null, reason)?.skip) (0, deps.scheduleWakeV2)(key, reason);
    }
    (0, deps.appendActivity)(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
    return true;
  }
  return false;
}

async function handleSocialMode(deps, cfg, key, kind, event, textContent, plainContent, mediaList, messageRef, quoteTargetIsSelf, isOwner, roleHintOuter) {
  // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
  if ((0, deps.isSocialEnabled)()) {
    const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
    (0, deps.appendRecentMessage)(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef); // AI 始终感知
    if (deps.socialV2.paused) { pausedInbound(deps, key, textContent, true); return; } // 系统总开关
    const st = (0, deps.socialState)(key);

    // 退场中：收尾发言发出前不再接话，新消息进入摘要
    if (st.phase === 'exiting') {
      (0, deps.appendSummary)(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
      (0, deps.log)(`社交模式：${key} 退场中，新消息转入摘要`);
      return true;
    }

    // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
    if (st.phase === 'active' && (0, deps.triggerActiveDurationExit)(key, st, Date.now())) {
      (0, deps.appendSummary)(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
      (0, deps.log)(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
      return true;
    }

    // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
    if (st.phase === 'active' || st.phase === 'probing') {
      st.phase = 'active';
      st.lastActiveMessageAt = Date.now();
      st.probeDeadline = 0;
      // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
      if (kind === 'private') {
        const promptText = `${roleHintOuter ? roleHintOuter + '\n\n' : ''}${isOwner ? '【管理员】' : ''}${textContent}${(0, deps.mediaHintFor)(key, messageRef, mediaList)}`;
        (0, deps.scheduleSocialReply)(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '私聊即时回应',
          false,
          mediaList
        );
        (0, deps.log)(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
        return true;
      }
      (0, deps.log)(`社交模式：${key} 活跃中收到消息，等待批量检测`);
      return true;
    }

    // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
    // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
    const direct = (0, deps.isDirectAddress)(plainContent, event, kind) || quoteTargetIsSelf;
    const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
    if (!direct && !randomTrigger) {
      (0, deps.appendSummary)(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
      (0, deps.log)(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
      return true;
    }

    // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
    (0, deps.enterActive)(key);
    const roleHint = (0, deps.currentRoleHint)();
    const currentLine = (isOwner && kind === 'private') ? `【管理员】${sender}：${textContent}` : `${sender}：${textContent}`;
    const directionHint = textContent.includes('[引用') ? deps.DIRECTION_HINT + '\n' : '';
    const replyInstruction = direct
      ? `请回复消息。\n${directionHint}${deps.SPACE_SPLIT_HINT}`
      : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${deps.SILENT_MARKER}；否则正常回复。\n${directionHint}${deps.SPACE_SPLIT_HINT}`;
    const promptText = `${roleHint ? roleHint + '\n\n' : ''}【群聊上下文】\n${(0, deps.buildContextBlock)(key)}\n【当前消息】${currentLine}${(0, deps.mediaHintFor)(key, messageRef, mediaList)}\n\n${replyInstruction}`;
    if (isOwner && kind === 'private') {
      (0, deps.log)(`社交模式：管理员私聊触发，立即投递 ${key}`);
      await (0, deps.deliverPrompt)(key, promptText, { media: mediaList });
    } else {
      (0, deps.scheduleSocialReply)(
        key, promptText,
        Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
        Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
        '触发进入活跃',
        false,
        mediaList
      );
    }
    return true;
  }
  return false;
}

export function createIncomingRuntime(deps) {
// 系统总开关（socialV2.paused）命中时的入站收口：只留活动记录，必要时留一条日志，
// 不建会话、不投递、不调模型。recorded=true 表示消息已进上下文（社交模式），只是不接话。
function pausedInbound(deps, key, text, recorded) {
  (0, deps.appendActivity)(`${key}（系统已暂停）${recorded ? '仅记录不回复' : '忽略入站'}：${String(text || '').slice(0, 60)}`);
  if (!recorded) (0, deps.log)(`[系统] 已暂停，忽略入站消息 ${key}`);
}

// @bridge-function handleIncoming:start
async function handleIncoming(kind, id, event, cfg) {
    const key = (0, deps.convKey)(kind, id);
    // 排查用：确认某个群的消息到底有没有到达 handleIncoming（config.socialV2.debugInbound）。
    if (cfg.socialV2?.debugInbound === true && kind === 'group') {
      let dbgText = '';
      try { dbgText = await (0, deps.segmentsToText)(event.message ?? [], { includeReply: false }); } catch {}
      (0, deps.log)(`[入站] ${key} uid=${event?.user_id ?? '?'} text=${String(dbgText || '').slice(0, 60)}`);
    }
    if (kind === 'group' && event.user_id) deps.recentUserGroup.set(String(event.user_id), String(id));
    // ③ @我 /persona 命令：入站第一步转交（在唤醒评估之前）。
    // 纯规则在 src/mention-command.js：必须 at 到我、且 at 之后第一个 token 就是 /persona；
    // 正文里提到不算（否则用户随口一提就被改人设）。解析失败不影响正常消息。
    try {
      const selfIds = [String(event?.self_id ?? ''), String(deps.selfUserId ?? '')].filter(Boolean);
      const selfNames = [String(deps.selfDisplayName ?? '')].filter(Boolean);
      const mention = typeof deps.parseMentionCommand === 'function'
        ? (0, deps.parseMentionCommand)(event?.message ?? '', { selfIds, selfNames })
        : null;
      if (mention && mention.found) {
        if (!mention.arg) {
          (0, deps.sendToQQ)(key, (0, deps.personaUsageHint)()).catch((error) => (0, deps.log)(`[命令] 回复 /persona 用法失败：${error?.message ?? error}`));
          return;
        }
        // 用去掉 at 的正文替换原消息：后面 DSH 才会把它当 /persona 命令处理。
        event = { ...event, message: [{ type: 'text', data: { text: mention.strippedText } }] };
        (0, deps.log)(`[命令] ${kind === 'group' ? '群' : '私聊'} @ 触发的 persona 命令已转交：arg=${mention.arg}`);
      }
    } catch (error) { (0, deps.log)(`[命令] 解析 @persona 失败（不影响正常消息）：${error?.message ?? error}`); }
    // 群管理指令：优先处理，且不受静默影响（否则喊停后叫不回来）。
    try { if (await (0, deps.handleGroupCommand)(kind, id, key, event)) return; } catch {}
    // 静默期间忽略普通消息。
    if (kind === 'group' && (0, deps.muteUntilOf)(key) > 0) return;
    // 高峰时段：消息**照常进入正常流程**（工具、识图、语音、画画都靠它），
    // 模型按高峰路由切换（见 ensureChatModel 的 isPeakNow → modelRouting.peak/visionPeak）。
    // 这里不拦消息、也不再直连 peakPause.agent（那套早废弃），只记一次日志。
    if (kind === 'group' && (0, deps.inPeakWindow)() && !deps.peakPauseLogged) {
      deps.peakPauseLogged = true;
      (0, deps.log)(`[峰值] 高峰时段：模型按高峰路由切换（工具/识图/语音/画画照旧）`);
    }
    // 临时通行证：非白名单私聊也放行，但受每日额度限制。
    const q = (0, deps.privateQuotaCfg)();
    const isPrivate = kind === 'private'; if (await tryHandleAiBlacklistCommand(deps, cfg, kind, id, event)) return; // D73：owner 私聊 /aiban，先于额度/白名单闸
    const whitelisted = (0, deps.whitelistedOnly)(kind, id, cfg);
    // 临时私聊白名单：① privateOpen=true → 所有人 ② 白名单群成员自动获得（每天额度、跨天重置）；显式白名单不扣额度。
    const passPrivate = isPrivate && (q.open || (0, deps.isGroupMember)(String(id)));
    if (passPrivate && !(cfg.allow?.private ?? []).map(String).includes(String(id))) {
      const uid = String(event.user_id ?? id);
      const gate = (0, deps.consumePrivateQuota)(uid);
      if (gate.blocked) {
        if (gate.crossedNow) {
          const text = String(cfg.socialV2?.privateQuota?.exceededText
            || `今天 ${q.dailyMinutes} 分钟的聊天额度用完啦，明天再来找我吧～`);
          void (0, deps.sendToQQ)(`private:${uid}`, text).catch(() => {});
        }
        (0, deps.log)(`私聊额度已用完 private:${uid}（今日 ${q.dailyMinutes} 分钟），不再回复`);
        return;
      }
      (0, deps.log)(`私聊临时通行证 private:${uid}：${(0, deps.formatLeft)(gate.leftMs)}`);
    }
    if (!whitelisted && !passPrivate) {
      // 观察群：不在 allow.groups 里，但**必须在「未授权」闸门之前接住**，
      // 否则消息会被这里丢掉、永远到不了学习路径（线上日志就是一堆
      // 「忽略未授权会话 group:100000002」且 messages.db 0 条）。
      // 观察群只学习不发言：这里没有任何发送分支。
      if (kind === 'group') {
        let observePlan = null;
        try { observePlan = (0, deps.planObserveLearning)(event, cfg.observe); } catch {}
        if (observePlan) {
          try { (0, deps.observeLearnFromGroupMessage)(event); } catch (error) { (0, deps.log)(`观察群学习失败 ${key}：${error?.message ?? error}`); }
          (0, deps.log)(`观察群 ${key}：只学习不发言（在未授权闸门之前接住，不回复不唤醒）`);
          return;
        }
      }
      (0, deps.log)(`忽略未授权会话 ${key}（当前模式 ${deps.currentMode}，来自 ${event.user_id}）`);
      // 群里不回复（避免在公共场合刷屏）；私聊回一句说明，否则对方只会觉得机器人坏了。
      if (kind === 'private' && cfg.socialV2?.unauthorizedPrivateReply !== false) {
        const uid = String(event.user_id ?? id);
        const last = deps.unauthorizedPrivateRepliedAt.get(uid) ?? 0;
        if (Date.now() - last > 60 * 60 * 1000) {
          deps.unauthorizedPrivateRepliedAt.set(uid, Date.now());
          const text = String(cfg.socialV2?.unauthorizedPrivateReplyText
            || '抱歉呀，我现在只接被允许的人私聊～想找我聊天的话，去群里喊我就好啦。');
          void (0, deps.sendToQQ)(`private:${uid}`, text).catch((error) => {
            (0, deps.log)(`回复未授权私聊失败 ${uid}：${error?.message ?? error}`);
          });
        }
      }
      return;
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return (0, deps.resolveGroupMemberName)(event.group_id, qq);
    };
    let quotedInfo = null;
    const resolveReply = async (messageId) => (quotedInfo = await (0, deps.resolveReplyInfo)(kind, id, messageId, event.self_id));
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    // 私聊里直接问额度：不唤醒 agent，省一次模型调用。
    const QUOTA_QUERY_RE = /^(?:\/)?(?:额度|配额|还能聊多久|还能聊多长时间|剩多久|quota|余量)\s*[?？]?$/i;
    if (kind === 'private') {
      const quick = await (0, deps.segmentsToText)(event.message ?? [], { resolveAtName, includeReply: false });
      if (QUOTA_QUERY_RE.test(String(quick || '').trim())) {
        const uid = String(event.user_id ?? id);
        const info = (0, deps.quotaInfo)(uid);
        const reply = info.exceeded
          ? `今天 ${info.dailyMinutes} 分钟的额度已经用完啦，明天再来吧～`
          : `${info.leftText}（今天已聊 ${info.usedMinutes} 分钟，总额度 ${info.dailyMinutes} 分钟）。`;
        void (0, deps.sendToQQ)(`private:${uid}`, reply).catch((error) => {
          (0, deps.log)(`回复额度查询失败 ${uid}：${error?.message ?? error}`);
        });
        return;
      }
    }

    const chatFileArchive = await archiveIncomingFiles(deps, cfg, kind, id, key, event);
    const fileNotices = chatFileArchive?.annotations ?? null;
    const textContent = await (0, deps.segmentsToText)(event.message ?? [], { resolveAtName, resolveReply, fileNotices });
    const plainContent = await (0, deps.segmentsToText)(event.message ?? [], { resolveAtName, includeReply: false, fileNotices });
    const mediaList = (0, deps.extractMediaFromSegments)(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = deps.messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        deps.messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > deps.MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await (0, deps.isQuoteTargetSelf)(event.message ?? [], kind, id, event.self_id);
    if (!(0, deps.isSessionAllowedInCurrentMode)(key)) return;
    // 纯媒体（无文字、也不是引用我）以前直接 return：消息不进 unread，
    // 下一轮上下文里就断了（「有人发过图」这件事模型永远看不到）。
    // 允许聊天的群必须入库（占位文本），再决定不回复。
    if (!plainContent && !quoteTargetIsSelf) {
      const inAllowGroup = kind === 'group' && (cfg.allow?.groups ?? []).map(String).includes(String(id));
      if (inAllowGroup) {
        try {
          const senderName = String(event?.sender?.card || event?.sender?.nickname || event?.user_id || '群友');
          const placeholder = mediaList.length ? (mediaList.some((m) => m.kind === 'video-file') ? '[视频]' : '[媒体]') : '[空消息]';
          (0, deps.appendSocialV2Message)(key, senderName, placeholder, placeholder, false, false, event.message_id ?? event.msg_id ?? null, mediaList, String(event.user_id ?? ''), []);
        } catch (error) { (0, deps.log)(`[上下文] 纯媒体消息入库失败：${error?.message ?? error}`); }
      }
      return;
    }
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    const roleState = (0, deps.readRoleState)();

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    const p = deps.pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await (0, deps.handlePendingAnswer)(p, plainContent, key, isOwner);
      return;
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      (0, deps.appendActivity)(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      (0, deps.log)(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await (0, deps.sendToQQ)(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    if (await handleSlashCommands(deps, cfg, key, plainContent, isOwner, roleState)) return;

    if (await handleReserved2Wake(deps, cfg, key, kind, event, textContent, plainContent, mediaList, quoteTargetIsSelf, isOwner, quotedInfo)) return;

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      (0, deps.feedSlangWindow)(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
    }

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = (0, deps.currentRoleHint)();

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + (isOwner ? '【管理员】' : '')
      + (kind === 'group'
        ? `${event.sender?.card || event.sender?.nickname || String(event.user_id)}：${textContent}`
        : textContent)
      + (0, deps.mediaHintFor)(key, messageRef, mediaList);

    (0, deps.appendActivity)(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    if (await handleSocialMode(deps, cfg, key, kind, event, textContent, plainContent, mediaList, messageRef, quoteTargetIsSelf, isOwner, roleHint)) return;

    if (deps.socialV2.paused) { pausedInbound(deps, key, textContent, false); return; } // 系统总开关

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!deps.dshReady) {
      const items = deps.queued.get(key) ?? [];
      if (items.length >= deps.QUEUE_MAX) {
        items.shift();
        (0, deps.log)(`队列满（${deps.QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      deps.queued.set(key, items);
      const now = Date.now();
      if ((deps.queuedHintAt.get(key) ?? 0) + deps.QUEUE_HINT_COOLDOWN_MS < now) {
        deps.queuedHintAt.set(key, now);
        await (0, deps.sendToQQ)(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
      }
      (0, deps.log)(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await (0, deps.ensureSession)(key);
      await (0, deps.ensureChatModel)(sessionId, key); // 每轮投递前对齐模型（高峰/视觉/降级）
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        (0, deps.enqueueForRetry)(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    let imageParts = [];
    if (Array.isArray(mediaList) && mediaList.length > 0) imageParts = await (0, deps.resolveMediaList)(mediaList, key);
    // 语义检索预热：默认关闭时 embedQuery 立即返回 false（零开销）
    try { await (0, deps.memoryVector?.embedQuery?.(textContent)); } catch {}
    const promptBlock = (0, deps.withArchiveFactsHint)(key, (0, deps.withMemoryContext)(key, textContent, (0, deps.withSlangContext)(promptText)));
    let content = [{ type: 'text', text: promptBlock }, ...imageParts];
    if (!(0, deps.isCurrentSession)(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    const accepted = await deps.api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = (0, deps.shouldAuditKey)(key) && deps.SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      await (0, deps.sendToQQ)(key, `⚠️ 消息未被接受：${safeErrText}`);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await (0, deps.auditAndSend)(key, (0, deps.mdToPlain)(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && deps.currentMode !== 'reserved2') await (0, deps.sendToQQ)(key, cfg.ackMessage);
    (0, deps.log)(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }
// @bridge-function handleIncoming:end
  return { handleIncoming };
}
