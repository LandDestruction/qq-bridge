// console/social-config: extracted bridge responsibilities; no startup side effects.
// Live dependencies: ROOT, SOCIAL_V2_FILE, api, atomicWriteJson, cfg, clearAllPendingWakeLeases, clearAllSocialV2Timers, collectors, dayKey, drainAllPromptQueues, forgetAgentToken, log, markReadCalledKeys, modelAppliedSessions, path, pendingSendToolCalls, pendingWakeKeys, privateQuotaCfg, quotaInfo, quotaLoad, readConfigObject, refreshAllDefaultWakeConfigsV2, reverse, saveHandoffDigest, saveSocialV2State, saveState, scheduleProactiveCheckV2, seenForwardIds, sendToolSucceededSessions, sessionEpoch, sessionModels, sessionPromises, setupSleepTimerV2, socialV2, state, stopRetiredSessionWork, toolCallNames, turnLeaseNoted, updateConfigFile, v2TurnStartAt, wakeConfigMissCount, wakeConfigUpdatedKeys
export function createConsoleSocialConfig(deps) {
// @bridge-function handleConsoleSocialConfig:start
async function handleConsoleSocialConfig(request) {
        // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
        if (request.req.method === 'GET' && request.url.pathname === '/api/socialV2/config') {
          request.sendJson({ ok: true, config: deps.cfg.socialV2 ?? {} });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/config') {
          const body = await request.readBody();
          const configFile = deps.path.join(deps.ROOT, 'config.json');
          const file = (0, deps.readConfigObject)(configFile);
          // current 必须是「当前**生效**的 socialV2」，而不是文件里恰好写着的那一份。
          //
          // config.json 里没有 socialV2 段（或该段不是普通对象）时，旧写法 current={} 会让下面所有
          // `current.xxx ?? 默认` 的兜底全部落空，并把只剩本次提交字段的段落盘。最危险的一处是工具开关
          // 归一化：`typeof merged.tools[k] !== 'boolean'` 时写的是 `current.tools?.[k] !== false` ——
          // current 为空 → undefined !== false → true，于是**一次控制台保存就把默认关闭的
          // setStickerRemark / sendVoice 静默打开**（它们默认 false 是有意的：一个是风险操作，
          // 一个是需要先准备语音库的强表达）。cfg.socialV2 是「文件 + 默认值」深度合并后的运行时配置，
          // 用它兜底才和真正生效的设置一致（也就不会再出现"文件里没有 → 保存一次就变了"）。
          const fileV2 = (file.socialV2 && typeof file.socialV2 === 'object' && !Array.isArray(file.socialV2))
            ? file.socialV2
            : null;
          const current = fileV2 ?? ((deps.cfg.socialV2 && typeof deps.cfg.socialV2 === 'object') ? deps.cfg.socialV2 : {});
          const merged = { ...current, ...body };
          // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
          for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context']) {
            if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
              merged[sub] = current[sub] ?? {};
            }
          }
          if (merged.autoReplyCheckMs !== undefined) {
            const n = Number(merged.autoReplyCheckMs);
            merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
          }
          // tools：只接受布尔开关
          const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'setWakeConfig', 'markRead', 'memory', 'slangQuery', 'slangSubmit', 'getImages', 'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'getSelfImage', 'sendVoice'];
          if (body.tools && typeof body.tools === 'object') {
            merged.tools = { ...(current.tools ?? {}), ...body.tools };
            for (const k of toolFlags) {
              if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
            }
          }
          // wake：数值与字符串数组归一化
          if (body.wake && typeof body.wake === 'object') {
            merged.wake = { ...(current.wake ?? {}), ...body.wake };
            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
              if (merged.wake[k] !== undefined) {
                const n = Number(merged.wake[k]);
                merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
                // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
              }
            }
            if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
            if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
            if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
            if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
            if (merged.wake.recommendedKeywords !== undefined) {
              merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
            }
            if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
            if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
          }
          // send：数值归一化
          if (body.send && typeof body.send === 'object') {
            merged.send = { ...(current.send ?? {}), ...body.send };
            for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
              if (merged.send[k] !== undefined) {
                const n = Number(merged.send[k]);
                merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
              }
            }
            if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
            if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
            if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
          }
          // wait：数值归一化
          if (body.wait && typeof body.wait === 'object') {
            merged.wait = { ...(current.wait ?? {}), ...body.wait };
            for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
              if (merged.wait[k] !== undefined) {
                const n = Number(merged.wait[k]);
                merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
              }
            }
          }
          // proactive：主动机会参数
          if (body.proactive && typeof body.proactive === 'object') {
            merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
            for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
              if (merged.proactive[k] !== undefined) {
                const n = Number(merged.proactive[k]);
                merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
                // 毫秒类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
              }
            }
            if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
            if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
          }
          // sticker：表情包体系参数归一化
          if (body.sticker && typeof body.sticker === 'object') {
            merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
            if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
            for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
              if (merged.sticker[k] !== undefined) {
                const n = Number(merged.sticker[k]);
                merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
              }
            }
            if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
            if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
            if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
            // 表情策略常驻 + 每小时发送上限（0 = 不限，最大 120，防止写错值把号刷爆）
            if (merged.sticker.alwaysInPrompt !== undefined) merged.sticker.alwaysInPrompt = merged.sticker.alwaysInPrompt === true;
            if (merged.sticker.perHourMax !== undefined) {
              const n = Number(merged.sticker.perHourMax);
              merged.sticker.perHourMax = Number.isFinite(n) ? Math.min(120, Math.max(0, Math.round(n))) : 20;
            }
            if (body.sticker.collect && typeof body.sticker.collect === 'object') {
              merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
              if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
              for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
                if (merged.sticker.collect[k] !== undefined) {
                  const n = Number(merged.sticker.collect[k]);
                  merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
                }
              }
            }
          }
          // feedback：数值/布尔归一化
          if (body.feedback && typeof body.feedback === 'object') {
            merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
            if (merged.feedback.maxLength !== undefined) {
              const n = Number(merged.feedback.maxLength);
              merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
            }
            if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
          }
          // context：数值归一化
          if (body.context && typeof body.context === 'object') {
            merged.context = { ...(current.context ?? {}), ...body.context };
            for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
              if (merged.context[k] !== undefined) {
                const n = Number(merged.context[k]);
                merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
              }
            }
            for (const [name, fallback, min, max] of [['wakeMessageLimit', 24, 1, 100], ['wakeRecentLimit', 12, 0, 20], ['wakeMaxChars', 9000, 500, 20000]]) {
              const n = Number(merged.context[name] ?? fallback);
              merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
            }
            if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
          }
          if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
          if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
          // 读盘-合并-写（不是「快照整份重写」）：normalize 必须基于快照，但落盘要落在**磁盘最新内容**上，
          // 否则这个请求读盘之后别的端点写进来的段（allow / consolePort / 其它配置）会被快照整份回滚。
          (0, deps.updateConfigFile)(configFile, (disk) => { disk.socialV2 = merged; }, { atomicWrite: deps.atomicWriteJson });
          deps.cfg.socialV2 = { ...(deps.cfg.socialV2 ?? {}), ...merged };
          // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
          // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
          const WAKE_DEFAULT_KEYS = [
            'defaultMode', 'recommendedDefaultInfinite',
            'recommendedSleepMinMs', 'recommendedSleepMaxMs',
            'recommendedProbability', 'recommendedKeywords',
            'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
            'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
          ];
          const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
            WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
          if (wakeDefaultChanged) (0, deps.refreshAllDefaultWakeConfigsV2)();
          (0, deps.log)('控制台：二代仿真配置已更新');
          request.sendJson({ ok: true, config: deps.cfg.socialV2 });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'GET' && request.url.pathname === '/api/socialV2/activity') {
          request.sendJson({ ok: true, paused: deps.socialV2.paused });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/activity') {
          const body = await request.readBody();
          const paused = body.paused === true;
          deps.socialV2.paused = paused;
          deps.socialV2.pausedSince = paused ? Date.now() : 0;
          if (paused) {
            // 一键停止：定时器、待投递队列、在跑的等待全部收掉；入站/投递/发送/学习四处还有闸门兜底，
            // 所以即使有人从别的入口（MCP 工具、排队回复）试图说话也发不出去。
            (0, deps.clearAllSocialV2Timers)();
            (0, deps.drainAllPromptQueues)('机器人系统已暂停');
            (0, deps.log)('控制台：机器人系统已停止（唤醒/投递/发送/学习全部停，控制台照常运行）');
          } else {
            (0, deps.log)('控制台：机器人系统已启动');
            for (const key of deps.socialV2.conversations.keys()) {
            (0, deps.setupSleepTimerV2)(key);
            (0, deps.scheduleProactiveCheckV2)(key);
          }
          }
          (0, deps.saveSocialV2State)();
          request.sendJson({ ok: true, paused: deps.socialV2.paused });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/reset') {
          deps.sessionEpoch++;
          deps.sessionPromises.clear();
          (0, deps.clearAllSocialV2Timers)();
          (0, deps.drainAllPromptQueues)('二代状态已重置');
          for (const key of [...deps.socialV2.conversations.keys()]) {
            // 重置前把「最近发生了什么」留成脉络（第三层），下次 bootstrap 注入一次。
            (0, deps.saveHandoffDigest)(key);
            const sid = deps.state.sessions[key];
            if (sid) {
              delete deps.state.sessions[key];
              // 与 retireSession / session-reset / workspace-reset 一致：先让 DSH 停下这个会话的活。
              // 少了这一步，DSH 会继续跑完在途/排队的 turn（token 照烧、副作用照做），
              // 而桥接这边已经把所有映射删掉 —— 输出被静默丢弃，agentToken 也已轮换（它的 MCP 发送全部 403）。
              (0, deps.stopRetiredSessionWork)(sid, key);
              deps.sessionModels.delete(sid);
              deps.modelAppliedSessions.delete(sid);
              deps.reverse.delete(sid);
              deps.collectors.delete(sid);
              deps.v2TurnStartAt.delete(sid);
              deps.turnLeaseNoted.delete(sid);
              deps.toolCallNames.delete(sid);
              deps.pendingSendToolCalls.delete(sid);
              deps.sendToolSucceededSessions.delete(sid);
              // 订阅也要退掉，否则它会在每次重连时被重新 follow 并重发整份快照。
              deps.api.events.forget?.(sid);
            }
            delete deps.state.sessionPolicies[key];
            (0, deps.forgetAgentToken)(key);
            deps.socialV2.conversations.delete(key);
            deps.seenForwardIds.delete(key);
          }
          (0, deps.saveState)();
          deps.pendingWakeKeys.clear();
          (0, deps.clearAllPendingWakeLeases)();
          deps.wakeConfigUpdatedKeys.clear();
          deps.markReadCalledKeys.clear();
          deps.wakeConfigMissCount.clear();
          deps.socialV2.paused = false;
          try { (0, deps.atomicWriteJson)(deps.SOCIAL_V2_FILE, { conversations: {} }); } catch (error) { (0, deps.log)('重置二代状态：写空状态文件失败:', error?.message ?? error); }
          (0, deps.log)('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
          request.sendJson({ ok: true });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'GET' && request.url.pathname === '/api/socialV2/private-quota') {
          const uidParam = request.url.searchParams.get('uid') || '';
          if (uidParam) { request.sendJson({ ok: true, uid: uidParam, ...(0, deps.quotaInfo)(uidParam) }); return true; /* @bridge-handled */ }
          const all = (0, deps.quotaLoad)();
          const today = (0, deps.dayKey)(new Date());
          const items = Object.entries(all).map(([uid, v]) => ({
            uid, usedMinutes: v.date === today ? Math.round(((Number(v.usedMs) || 0) / 60000) * 10) / 10 : 0,
            warned: v.warned === true, date: v.date
          }));
          request.sendJson({ ok: true, date: today, dailyMinutes: (0, deps.privateQuotaCfg)().dailyMinutes, items });
          return true; /* @bridge-handled */
        }
    return false;
  }
// @bridge-function handleConsoleSocialConfig:end
  return { handleConsoleSocialConfig };
}
