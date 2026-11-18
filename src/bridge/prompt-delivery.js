// prompt-delivery: extracted bridge responsibilities; no startup side effects.
// Live dependencies: IMAGE_INFO_MAX, IMAGE_INFO_TTL_MS, QUEUE_MAX, SENSITIVE_RE, affinityPromptBlock, api, auditAndSend, bot, buildWakePromptV2, buildWakeSnapshotV2, canonicalV2Key, cfg, currentMode, disarmPendingWakeLease, dshReady, enqueueForRetry, ensureChatModel, ensureSession, getSocialV2State, imageInfoCache, isCurrentSession, isSessionAllowedInCurrentMode, lastPromptByKey, log, mdToPlain, noteModelMessagesV2, pendingVideoEnrich, pendingWakeKeys, promptQueues, queued, raceWithTimeout, resolveMediaList, sendToQQ, shouldAuditKey, social, socialV2, sttInlineWaitMs, videoFollowUps, withArchiveFactsHint, withSlangContext
export function createPromptDelivery(deps) {
// @bridge-function deliverPromptNow:start
async function deliverPromptNow(key, promptText, opts = {}) {
    if (!(0, deps.isSessionAllowedInCurrentMode)(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // 系统总开关：暂停期间唤醒 / 社交 / 重试 / 队列补投一律丢弃，避免「点了停止还在说话」。
    if (deps.socialV2.paused) {
      (0, deps.log)(`[系统] 已暂停，丢弃投递 ${key}`);
      deps.pendingWakeKeys.delete(key);
      (0, deps.disarmPendingWakeLease)(key);
      return { ok: true, skipped: true };
    }
    // Recheck queued wakes at dispatch time: no model call while paused/disabled
    // and no reserved2 prompt leaking into an ordinary chat after a mode switch.
    const wakeBlocked = () => opts.wakeReason && (deps.currentMode !== 'reserved2' || deps.socialV2.paused || deps.cfg.socialV2?.enabled === false);
    const skipWake = () => {
      deps.pendingWakeKeys.delete(key);
      (0, deps.disarmPendingWakeLease)(key);
      return { ok: true, skipped: true };
    };
    if (wakeBlocked()) return skipWake();
    if (!deps.dshReady) {
      const items = deps.queued.get(key) ?? [];
      if (items.length >= deps.QUEUE_MAX) {
        items.shift();
        (0, deps.log)(`队列满（${deps.QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      deps.queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    try {
      sessionId = await (0, deps.ensureSession)(key);
      await (0, deps.ensureChatModel)(sessionId, key); // 每轮投递前对齐模型（高峰/视觉/降级）
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        (0, deps.enqueueForRetry)(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    let wakeState;
    let wakeToken;
    let wakeSnapshot;
    if (opts.wakeReason) {
      if (wakeBlocked()) return skipWake();
      // Build only after session creation: retries may rotate the token, and an
      // offline queue may have received more messages since this wake was queued.
      wakeState = (0, deps.getSocialV2State)(key);
      wakeToken = wakeState.agentToken;
      promptText = (0, deps.buildWakePromptV2)(key, opts.wakeReason);
      wakeSnapshot = (0, deps.buildWakeSnapshotV2)(key);
      if (wakeSnapshot) {
        promptText += `\n\n【本次消息快照】\n${JSON.stringify(wakeSnapshot)}\n以上消息已提供，无需重复查询；partial=true 时用 qq_get_unread_messages(afterSeq=readThroughSeq) 继续读取。先处理当前消息；回复前如需确认后续补充，用 qq_wait_for_messages(purpose="reply") 补足短静默，已安静够久会立即返回，不要先长等。收尾只确认你已处理的 readThroughSeq（本地 seq，非 QQ messageId），传给 qq_mark_read 或 qq_set_wake_config 的 throughSeq；新到消息留待处理。`;
      }
    }
    let imageParts = [];
    if (Array.isArray(opts.media) && opts.media.length > 0) imageParts = await (0, deps.resolveMediaList)(opts.media, key);
    // ② 好感度：这一轮被问到就注入片段（≤300 字 + 隐私行），并记「本轮被问过」供工具拒绝改分。
    try {
      const hint = (0, deps.affinityPromptBlock)(key);
      if (hint) promptText = hint + promptText;
    } catch {}
    // 记忆检索：唤醒轮没有单一「当前消息」，取快照里最新一条做关键词，其余靠摘要/话题。
    const memQuery = (() => {
        try {
          const arr = wakeSnapshot && Array.isArray(wakeSnapshot.messages) && wakeSnapshot.messages.length ? wakeSnapshot.messages : (wakeSnapshot && Array.isArray(wakeSnapshot.recent) ? wakeSnapshot.recent : []);
          const last = arr.length ? arr[arr.length - 1] : null;
          return last && last.text ? String(last.text) : '';
        } catch { return ''; }
      })();
    // 语义检索预热：默认关闭时 embedQuery 立即返回 false（零开销），开启后才付一次 embedding 费
    try { await deps.memoryVector?.embedQuery?.(memQuery); } catch {}
    const promptBlock = (0, deps.withArchiveFactsHint)(key, (0, deps.withMemoryContext)(key, memQuery, (0, deps.withSlangContext)(promptText)));
    // P1 host 工具循环：openai 这类 transport 的 toolLoop='host' —— 模型只回 tool_calls，
    // 工具由桥接执行（本地 MCP），最终文本仍走同一条发送链路；dsh 永进不到这里。
    if (typeof deps.agentToolLoopModeOf === 'function' && (0, deps.agentToolLoopModeOf)() === 'host') {
      const agentCfg = deps.cfg?.agent || {};
      const hostContent = [{ type: 'text', text: promptBlock }];
      for (const part of imageParts) {
        if (part?.type === 'image' && part.data) hostContent.push({ type: 'image_url', image_url: { url: `data:${part.mediaType || 'image/jpeg'};base64,${part.data}` } });
        else if (part?.type === 'text' && part.text) hostContent.push({ type: 'text', text: String(part.text) });
      }
      const hostMessages = hostContent.length > 1 ? [{ role: 'user', content: hostContent }] : [{ role: 'user', text: promptBlock }];
      const turn = await (0, deps.runHostTurn)({ key, sessionId, messages: hostMessages });
      (0, deps.log)(`[agent] transport=${agentCfg.type || 'openai'} model=${agentCfg.model || ''} events=${turn.events.length} text=${turn.text.length}`);
      if (!turn.ok) {
        // 不回群：本地端点超时/工具循环失败时，以前会往群里发「⚠️ agent 回合失败」，
        // 用户看到的就是「机器人几乎用不了」。失败只进日志与控制台活动，不打扰群。
        (0, deps.log)(`[agent] 回合失败（不回群）：${turn.error}`);
        return { ok: false, error: turn.error };
      }
      // 有的 OpenAI 兼容端点把工具调用写成正文里的 <tool_call>…，发送前剥掉；剥完为空就不发。
      const hostText = typeof deps.stripToolCallMarkup === 'function'
        ? deps.stripToolCallMarkup(turn.text || '')
        : (turn.text || '');
      if (hostText && !opts.silent) await (0, deps.auditAndSend)(key, (0, deps.mdToPlain)(hostText));
      return { ok: true };
    }
    let content = [{ type: 'text', text: promptBlock }, ...imageParts];
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!(0, deps.isCurrentSession)(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) deps.social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await deps.api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      if (opts.farewell) deps.social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) deps.social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = (0, deps.shouldAuditKey)(key) && deps.SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      if (!opts.silent) await (0, deps.sendToQQ)(key, `⚠️ 消息未被接受：${safeErrText}`);
      return { ok: false, error: safeErrText };
    }
    if (wakeSnapshot && (0, deps.isCurrentSession)(key, sessionId)
        && deps.socialV2.conversations.get((0, deps.canonicalV2Key)(key)) === wakeState
        && wakeState.agentToken === wakeToken) {
      // Acceptance grants visibility, never acknowledgement. New arrivals and
      // rejected/stale deliveries must not be cleared by an old cursor.
      (0, deps.noteModelMessagesV2)(wakeState, [...wakeSnapshot.messages, ...wakeSnapshot.recent]);
    }
    if (accepted.result.value.command?.text && !opts.silent && deps.currentMode !== 'reserved2') {
      if (opts.farewell) deps.social.exitingSessions.delete(sessionId);
      await (0, deps.auditAndSend)(key, (0, deps.mdToPlain)(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      deps.social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }
// @bridge-function deliverPromptNow:end

// @bridge-function getImageCached:start
async function getImageCached(file) {
    const hit = deps.imageInfoCache.get(file);
    if (hit && Date.now() - hit.at < deps.IMAGE_INFO_TTL_MS) return hit.info;
    const info = await deps.bot.getImage({ file });
    deps.imageInfoCache.set(file, { at: Date.now(), info });
    while (deps.imageInfoCache.size > deps.IMAGE_INFO_MAX) {
      for (const k of deps.imageInfoCache.keys()) { deps.imageInfoCache.delete(k); break; }
    }
    return info;
  }
// @bridge-function getImageCached:end

// @bridge-function deliverPrompt:start
function deliverPrompt(key, promptText, opts = {}) {
    try { deps.lastPromptByKey.set(key, String(promptText ?? '')); } catch {}
    return new Promise((resolve, reject) => {
      let entry = deps.promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        deps.promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }
// @bridge-function deliverPrompt:end

// @bridge-function processPromptQueue:start
async function processPromptQueue(key) {
    // 本轮有视频在抽帧/转写：抽帧最多等 8s，转写最多等 inlineWaitMs（默认 6s）。
    // 等不到**不再硬等 90s**：prompt 如实写「转写中」，完成后由 followUp 主动补发 ——
    // 用户不必再问第二遍（27 号实测的痛点）。
    {
      // 只认 enrichVideoFile 登记的 stagedTask（有 job）；autoClaim=false 的引用视频
      // 由调用方自己判断本轮事实是否已带上，这里不等也不 claim。
      const stages = [...(deps.pendingVideoEnrich.get(key) ?? [])].filter((t) => t && t.job && t.autoClaim !== false);
      if (stages.length) {
        // 第一段：抽帧很快（秒级），最多等 8s。
        const f = await (0, deps.raceWithTimeout)(stages.map((t) => t.frames), 8000);
        (0, deps.log)(`[video] ${key} 等待抽帧 ${f.waited}ms → ${f.done ? '完成' : '超时（先带时长走）'}`);
        // 第二段：转写只等一小会儿（默认 6s），赶得上就带上，赶不上就补发。
        const inlineWaitMs = (0, deps.sttInlineWaitMs)();
        const st = await (0, deps.raceWithTimeout)(stages.map((t) => t.stt), inlineWaitMs);
        if (!st.done) {
          (0, deps.log)(`[video] ${key} 等待转写 ${st.waited}ms 未完成（本轮上限 ${inlineWaitMs}ms）：prompt 写「转写中」，完成后主动补发`);
        } else {
          (0, deps.log)(`[video] ${key} 等待转写 ${st.waited}ms → 完成，本轮 prompt 直接带上`);
          // 赶上了就不补发：先占位，之后到点的补发定时器看到 claimed 会跳过。
          for (const t of stages) {
            if (t.sttDone) deps.videoFollowUps.claim(t.job, '本轮 prompt 已带上');
          }
        }
      }
    }
    const entry = deps.promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) deps.promptQueues.delete(key);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (deps.promptQueues.get(key) === entry) {
        if (entry.queue.length) processPromptQueue(key);
        else deps.promptQueues.delete(key);
      }
    }
  }
// @bridge-function processPromptQueue:end
  return { deliverPromptNow, getImageCached, deliverPrompt, processPromptQueue };
}
