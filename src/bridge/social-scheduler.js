// social-scheduler: extracted bridge responsibilities; no startup side effects.
// Live dependencies: appendSummary, buildBatchPrompt, buildContextBlock, buildProactivePrompt, buildProbePrompt, cfg, clearInterval, currentRoleHint, deliverPrompt, ensureSession, enterActive, isMustReplyText, isSocialEnabled, leaveActive, log, mediaHintFor, randInt, setInterval, setTimeout, social, socialState, state, triggerActiveDurationExit
export function createSocialScheduler(deps) {
// @bridge-function scheduleSocialReply:start
function scheduleSocialReply(key, promptText, minDelay, maxDelay, label, farewell = false, media = null) {
    if (deps.socialV2?.paused) {
      (0, deps.log)(`社交模式：系统已暂停，丢弃待投递 ${label} ${key}`);
      return;
    }
    const delay = (0, deps.randInt)(minDelay, maxDelay);
    (0, deps.log)(`社交模式：${label} ${key}，延迟 ${Math.round(delay / 1000)}s 后投递`);
    const timer = (0, deps.setTimeout)(() => {
      const timers = deps.social.pendingTimers.get(key);
      if (timers) {
        timers.delete(timer);
        if (timers.size === 0) deps.social.pendingTimers.delete(key);
      }
      (0, deps.deliverPrompt)(key, promptText, { farewell, media: media ?? [] }).catch((error) => (0, deps.log)(`社交投递异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    const timers = deps.social.pendingTimers.get(key) ?? new Set();
    timers.add(timer);
    deps.social.pendingTimers.set(key, timers);
  }
// @bridge-function scheduleSocialReply:end

// @bridge-function socialLoopTick:start
function socialLoopTick() {
    if (!(0, deps.isSocialEnabled)()) return;
    if (deps.socialV2?.paused) return; // 系统总开关：暂停期间不推进社交状态机
    const now = Date.now();
    // 所有"发过消息或已有状态"的群都参与状态机（观望中的群也做主动判定）
    const keys = new Set([...deps.social.states.keys(), ...deps.social.recentMessages.keys()]);
    for (const key of keys) {
      const st = (0, deps.socialState)(key);
      if (st.phase === 'idle') {
        // ── 观望阶段：第三种触发（主动开话题，仅群聊生效） ─────────────────
        if (deps.cfg.social?.proactiveEnabled !== false && key.startsWith('group:')) {
          const arr = deps.social.recentMessages.get(key) ?? [];
          const lastMsgTime = arr.length ? arr[arr.length - 1].time : 0;
          const idleThreshold = Number(deps.cfg.social?.proactiveIdleThresholdMs ?? 1800000);
          if (now - lastMsgTime >= idleThreshold) {
            if (!st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + (0, deps.randInt)(Number(deps.cfg.social?.proactiveCheckMinMs ?? 2700000), Number(deps.cfg.social?.proactiveCheckMaxMs ?? 5400000));
            }
            if (now >= st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + (0, deps.randInt)(Number(deps.cfg.social?.proactiveCheckMinMs ?? 2700000), Number(deps.cfg.social?.proactiveCheckMaxMs ?? 5400000));
              if (Math.random() < Number(deps.cfg.social?.proactiveProbability ?? 0.2)) {
                (0, deps.enterActive)(key);
                const roleHint = (0, deps.currentRoleHint)();
                const promptText = (0, deps.buildProactivePrompt)(key, roleHint);
                scheduleSocialReply(
                  key, promptText,
                  Number(deps.cfg.social?.activeReplyDelayMinMs ?? 2000),
                  Number(deps.cfg.social?.activeReplyDelayMaxMs ?? 8000),
                  '主动开话题'
                );
                (0, deps.log)(`社交模式：${key} 观望期主动开话题，进入活跃`);
              }
            }
          }
        }
      } else if (st.phase === 'active') {
        // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
        if ((0, deps.triggerActiveDurationExit)(key, st, now)) continue;
        if (now >= st.nextCheckAt) {
          const newMsgs = (deps.social.recentMessages.get(key) ?? []).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          st.nextCheckAt = now + (0, deps.randInt)(Number(deps.cfg.social?.activeCheckMinMs ?? 20000), Number(deps.cfg.social?.activeCheckMaxMs ?? 40000));
          if (newMsgs.length) {
            st.lastActiveMessageAt = now;
            const mustReply = key.startsWith('private:') || newMsgs.some((m) => m.quoteTargetIsSelf || (0, deps.isMustReplyText)(m.plain ?? m.text));

            // 选择性沉默：只对非必须回的普通闲聊生效；直接提问/点名永远走正常回复
            if (!mustReply) {
              // 基准沉默概率；刚发过言后有人快速接话时不沉默，避免“活跃到一半突然不接”
              let skipProb = Math.min(1, Math.max(0, Number(deps.cfg.social?.skipProbability ?? 0.3)));
              const sinceAiReply = now - (st.lastAiReplyAt || 0);
              if (sinceAiReply < 60000) skipProb = 0;
              const pressure = Math.min(0.5, newMsgs.length * 0.1);
              skipProb = Math.max(0, skipProb - pressure);
              if (Math.random() < skipProb) {
                (0, deps.log)(`社交模式：活跃期 ${key} 跳过 ${newMsgs.length} 条普通消息（选择性沉默，skip=${skipProb.toFixed(2)}）`);
                // 真人"看到了但没回"：保留到 silentContext，下次投递时一起带给模型
                const silent = deps.social.silentContext.get(key) ?? [];
                silent.push(...newMsgs);
                deps.social.silentContext.set(key, silent.slice(-30));
                for (const m of newMsgs) (0, deps.appendSummary)(key, m.sender, m.text, m.plain ?? m.text, m.isOwner, m.media ?? [], m.messageId ?? '');
                continue;
              }
            }

            // 投递时把之前沉默但"已看到未回应"的消息一并带给模型（真人视角：我看到过，只是当时没接）
            const seenMsgs = deps.social.silentContext.get(key) ?? [];
            const promptMsgs = [...seenMsgs, ...newMsgs];
            deps.social.silentContext.delete(key);
            const promptText = (0, deps.buildBatchPrompt)(key, promptMsgs, !mustReply);
            const batchMedia = promptMsgs.flatMap((m) => Array.isArray(m.media) ? m.media : []);
            scheduleSocialReply(
              key, promptText,
              Number(deps.cfg.social?.activeReplyDelayMinMs ?? 2000),
              Number(deps.cfg.social?.activeReplyDelayMaxMs ?? 8000),
              '活跃期回应',
              false,
              batchMedia
            );
            (0, deps.log)(`社交模式：活跃期 ${key} 检测到 ${newMsgs.length} 条新消息${seenMsgs.length ? `（含 ${seenMsgs.length} 条之前沉默的）` : ''}`);
          } else if (now - st.lastActiveMessageAt >= Number(deps.cfg.social?.idleWindowMs ?? 180000)) {
            // 冷场：大概率回观望；小概率让 AI 说一句（试探群友是否还在）
            if (Math.random() < Number(deps.cfg.social?.idleRetryProbability ?? 0.25)) {
              st.phase = 'probing';
              st.probeDeadline = now + Number(deps.cfg.social?.idleRetryWaitMs ?? 120000);
              const promptText = (0, deps.buildProbePrompt)(key);
              scheduleSocialReply(
                key, promptText,
                Number(deps.cfg.social?.activeReplyDelayMinMs ?? 2000),
                Number(deps.cfg.social?.activeReplyDelayMaxMs ?? 8000),
                '冷场试探'
              );
              (0, deps.log)(`社交模式：${key} 冷场，AI 试探性说一句`);
            } else {
              (0, deps.leaveActive)(key);
              (0, deps.log)(`社交模式：${key} 冷场，回到观望`);
            }
          }
        }
      } else if (st.phase === 'exiting') {
        // 退场中：等待 AI 的收尾发言完成后进入观望。
        // 这里不做任何参与/冷场判定，新消息由 handleIncoming 转入摘要。
        // 极端兜底：超过 60 分钟仍未完成（如 DSH 长时间离线），强制回观望，避免状态卡死。
        if (now - st.activeExitAt > 60 * 60 * 1000) {
          (0, deps.log)(`社交模式：${key} 退场等待超时（60 分钟），强制回到观望`);
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          const sid = deps.state.sessions[key];
          if (sid) deps.social.exitingSessions.delete(sid);
        }
      } else if (st.phase === 'probing' && now > st.probeDeadline) {
        // 试探后仍无人说话 → 100% 回观望
        (0, deps.leaveActive)(key);
        (0, deps.log)(`社交模式：${key} 试探无回应，回到观望`);
      }
    }
  }
// @bridge-function socialLoopTick:end

// @bridge-function startSocialLoop:start
function startSocialLoop() {
    if (deps.social.loopTimer) (0, deps.clearInterval)(deps.social.loopTimer);
    deps.social.loopTimer = (0, deps.setInterval)(socialLoopTick, 5000);
    deps.social.loopTimer.unref?.();
  }
// @bridge-function startSocialLoop:end

// @bridge-function flushSummaries:start
async function flushSummaries(key = null) {
    const targets = key ? (deps.social.pendingSummaries.has(key) ? [[key, deps.social.pendingSummaries.get(key)]] : []) : [...deps.social.pendingSummaries.entries()];
    for (const [k, entry] of targets) {
      if (!entry.items.length) continue;
      const lines = entry.items.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${(0, deps.mediaHintFor)(k, m.messageId, m.media)}`).join('\n');
      const summaryMedia = entry.items.flatMap((m) => Array.isArray(m.media) ? m.media : []);
      let sessionId;
      try {
        sessionId = await (0, deps.ensureSession)(k);
      } catch (error) {
        (0, deps.log)(`摘要投喂创建会话失败 (${k}): ${error?.message ?? error}`);
        continue;
      }
      const roleHint = (0, deps.currentRoleHint)();
      const summaryText = `${roleHint ? roleHint + '\n\n' : ''}【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：\n${lines}\n\n【最近对话】\n${(0, deps.buildContextBlock)(k)}\n\n你不需要回复，只需记住这些内容，后续聊天会更自然。`;
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      deps.social.silentTurns.set(sessionId, [...(deps.social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
      const popSilent = () => {
        const arr = deps.social.silentTurns.get(sessionId) ?? [];
        const next = arr.filter((x) => x.id !== silentId);
        if (next.length > 0) deps.social.silentTurns.set(sessionId, next);
        else deps.social.silentTurns.delete(sessionId);
      };
      try {
        const result = await (0, deps.deliverPrompt)(k, summaryText, { silent: true, media: summaryMedia });
        if (result.ok) {
          (0, deps.log)(`已投喂群聊摘要 (${k}) ${entry.items.length} 条`);
          entry.items = [];
        } else {
          popSilent();
          (0, deps.log)(`摘要投喂被拒 (${k}): ${result.error || '未知错误'}`);
        }
      } catch (error) {
        popSilent();
        (0, deps.log)(`摘要投喂失败 (${k}): ${error?.message ?? error}`);
      }
    }
    for (const k of [...deps.social.pendingSummaries.keys()]) {
      if (deps.social.pendingSummaries.get(k)?.items?.length === 0) deps.social.pendingSummaries.delete(k);
    }
  }
// @bridge-function flushSummaries:end
  return { scheduleSocialReply, socialLoopTick, startSocialLoop, flushSummaries };
}
