// wake-state: extracted bridge responsibilities; no startup side effects.
// Live dependencies: EXPLICIT_END_RE, SOCIAL_V2_FILE, WAKE_TRIGGER_KEYS, atomicWriteJson, buildHandoffDigest, canonicalV2Key, cfg, clearTimeout, crypto, digestSnapshot, fs, log, migrateImpressions, normalizeDigests, packSessionResets, personaMaxChars, pruneEvents, readJsonSafe, rememberAgentToken, sanitizeForwardId, scheduleProactiveCheckV2, seenForwardIds, setupSleepTimerV2, socialV2, unpackSessionResets, videoFollowUpSent
// @bridge-function normalizeSpeakerIdsV2:start
function normalizeSpeakerIdsV2(deps, value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }
// @bridge-function normalizeSpeakerIdsV2:end

// @bridge-function pickWakeTriggersV2:start
function pickWakeTriggersV2(deps, source, fallback = {}) {
    const out = {};
    const src = source && typeof source === 'object' ? source : {};
    const fb = fallback && typeof fallback === 'object' ? fallback : {};
    for (const name of deps.WAKE_TRIGGER_KEYS) {
      const value = Object.prototype.hasOwnProperty.call(src, name) ? src[name] : fb[name];
      if (value !== undefined) out[name] = value;
    }
    return out;
  }
// @bridge-function pickWakeTriggersV2:end

// @bridge-function defaultWakeConfigV2:start
function defaultWakeConfigV2(deps) {
    const w = deps.cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }
// @bridge-function defaultWakeConfigV2:end

// @bridge-function refreshDefaultWakeConfigV2:start
function refreshDefaultWakeConfigV2(deps, st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2(deps);
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }
// @bridge-function refreshDefaultWakeConfigV2:end

// @bridge-function refreshAllDefaultWakeConfigsV2:start
function refreshAllDefaultWakeConfigsV2(deps) {
    let changed = false;
    for (const st of deps.socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(deps, st)) changed = true;
    }
    if (changed) saveSocialV2State(deps);
    return changed;
  }
// @bridge-function refreshAllDefaultWakeConfigsV2:end

// @bridge-function hasExplicitEndV2:start
function hasExplicitEndV2(deps, st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return deps.EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }
// @bridge-function hasExplicitEndV2:end

// @bridge-function isSleepingConfigV2:start
function isSleepingConfigV2(deps, wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }
// @bridge-function isSleepingConfigV2:end

// @bridge-function preSleepWaitBlockedV2:start
function preSleepWaitBlockedV2(deps, st) {
    if (!st) return false;
    const w = deps.cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(deps, st)) return false;
    const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
    const now = Date.now();
    // 已经连续安静满观察窗口：可以直接设置潜水。
    if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
    // 已经完整等过观察窗口且之后没有新消息：放行。
    if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
    // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
    if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
    return true;
  }
// @bridge-function preSleepWaitBlockedV2:end

// @bridge-function computeWakeSafetyV2:start
function computeWakeSafetyV2(deps, wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(deps, tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }
// @bridge-function computeWakeSafetyV2:end

// @bridge-function ensureWakeableV2:start
function ensureWakeableV2(deps, st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(deps, tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        (0, deps.clearTimeout)(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2(deps);
      if (!opts.skipSave) saveSocialV2State(deps);
      if (key) (0, deps.setupSleepTimerV2)(key);
      (0, deps.log)(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }
// @bridge-function ensureWakeableV2:end

// @bridge-function getSocialV2State:start
function getSocialV2State(deps, key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = (0, deps.canonicalV2Key)(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = deps.socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(deps),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: deps.crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        rateLimitRetryTimer: null,
        lastIncomingAt: 0,
        // 最近一次「这个会话出现过图/表情」的时刻（ms）。必须持久化：选型要按它切视觉模型，
        // 重启后内存标记会没，光靠它就能让 23:42 那次「重启后仍读不出图」不再复发。
        lastMediaAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        modelSeenSeqs: new Set(),
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {},
        persona: null
      };
      (0, deps.rememberAgentToken)(key, st.agentToken);
      deps.socialV2.conversations.set(key, st);
      (0, deps.scheduleProactiveCheckV2)(key);
      (0, deps.setupSleepTimerV2)(key);
    }
    return st;
  }
// @bridge-function getSocialV2State:end

// @bridge-function saveHandoffDigest:start
function saveHandoffDigest(deps, key) {
    try {
      if (deps.cfg.socialV2?.handoff?.enabled === false) return;
      const st = deps.socialV2.conversations.get(key);
      const msgs = Array.isArray(st?.recentMessages) ? st.recentMessages.slice(-60) : [];
      if (msgs.length < 3) return;
      const text = (0, deps.buildHandoffDigest)(msgs, { maxChars: Number(deps.cfg.socialV2?.handoff?.maxChars) || 1600 });
      if (!text) return;
      deps.socialV2.handoffs[key] = { text, at: Date.now(), count: msgs.length };
      (0, deps.log)(`[交接] ${key} 已保存最近 ${msgs.length} 条的脉络（${text.length} 字）`);
    } catch (error) {
      (0, deps.log)(`[交接] 保存失败 ${key}：${error?.message ?? error}`);
    }
  }
// @bridge-function saveHandoffDigest:end

// @bridge-function takeHandoffDigest:start
function takeHandoffDigest(deps, key) {
    const h = deps.socialV2.handoffs?.[key];
    if (!h || !h.text) return "";
    delete deps.socialV2.handoffs[key];
    return `【上次会话的脉络（你自己记的，不是新消息）】\n${h.text}\n\n`;
  }
// @bridge-function takeHandoffDigest:end

// @bridge-function pruneHeavyMedia:start
function pruneHeavyMedia(deps) {
    let dropped = 0;
    for (const st of deps.socialV2.conversations.values()) {
      for (const arr of ['recentMessages', 'unread']) {
        for (const m of (Array.isArray(st[arr]) ? st[arr] : [])) {
          if (!Array.isArray(m.media)) continue;
          const before = m.media.length;
          m.media = m.media.filter((x) => {
            try {
              if (JSON.stringify(x).length > 51200) { dropped += 1; return false; }
            } catch { return false; }
            return true;
          });
          if (m.media.length !== before) m.hasMedia = m.media.length > 0;
        }
      }
    }
    if (dropped) (0, deps.log)(`已清理历史遗留的超大媒体 ${dropped} 条（省下 state 体积）`);
    return dropped;
  }
// @bridge-function pruneHeavyMedia:end

// @bridge-function loadMemoryLayers:start
function loadMemoryLayers(deps, raw) {
    try {
      deps.socialV2.globalImpressions = raw?.globalImpressions && typeof raw.globalImpressions === "object" ? raw.globalImpressions : Object.create(null);
      deps.socialV2.digests = (0, deps.normalizeDigests)(raw?.digests);
    deps.socialV2.sharedEvents = Array.isArray(raw?.sharedEvents) ? raw.sharedEvents.filter((e) => e && e.text) : [];
      deps.socialV2.handoffs = raw?.handoffs && typeof raw.handoffs === "object" ? raw.handoffs : Object.create(null);
      (0, deps.pruneEvents)(deps.socialV2.sharedEvents);
      const migrated = raw?.impressionsMigrated === true;
      if (!migrated) {
        const before = Object.keys(deps.socialV2.globalImpressions).length;
        (0, deps.migrateImpressions)(deps.socialV2.conversations, deps.socialV2.globalImpressions);
        deps.socialV2.impressionsMigrated = true;
        const after = Object.keys(deps.socialV2.globalImpressions).length;
        if (after > before) (0, deps.log)(`跨会话印象迁移完成：${before} → ${after} 人`);
      }
    } catch (error) {
      (0, deps.log)(`记忆层加载失败（按空处理）：${error?.message ?? error}`);
    }
  }
// @bridge-function loadMemoryLayers:end

// @bridge-function loadSocialV2State:start
function loadSocialV2State(deps) {
    try {
      // 记下读取时刻的文件指纹。加载末尾会统一落盘一次（为了让 ensureWakeableV2
      // 中途的改动不丢），但如果这期间**别的进程**已经写过这个文件，我们手上的
      // 内存态就是旧的 —— 再写回去等于把它那份更新的状态覆盖掉。
      // 这不是假想：日志里出现过两个桥接实例同时启动，第二个实例在加载后立刻回写，
      // 把第一个实例刚更新的读水位/唤醒时间/转发 id 全部退回旧值。
      const fileStamp = (() => {
        try {
          const s = deps.fs.statSync(deps.SOCIAL_V2_FILE);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return null;
        }
      })();
      const raw = (0, deps.readJsonSafe)(deps.SOCIAL_V2_FILE, null);
      deps.socialV2.paused = raw?.paused === true;
      // 停于何时（界面上能显示「已停止 N 分钟」；老状态文件没有这个字段就当 0）
      deps.socialV2.pausedSince = Number(raw?.pausedSince) || 0;
      // P3-7：preset 指纹随状态持久化；不恢复的话每次启动都会被当成“首次”而永不触发重建
      deps.socialV2.presetFingerprint = typeof raw?.presetFingerprint === "string" ? raw.presetFingerprint : null;
      deps.socialV2.pendingPresetRecycle = raw?.pendingPresetRecycle === true;
      // D47：「距上次重建」记帐必须恢复。不恢复的话重启后所有会话都变成「刚开始」，
      // sessionRecycle 的 200 条/8h 实际按「本次进程启动以来」算，D45 的 turns 兜底也失效。
      deps.socialV2.sessionResets = (0, deps.unpackSessionResets)(raw?.sessionResets);
      if (Object.keys(deps.socialV2.sessionResets).length) (0, deps.log)(`[回收] 已恢复 ${Object.keys(deps.socialV2.sessionResets).length} 个会话的重建记帐（重启后不当作刚开始）`);
      // 视频转写「已补发」集合：重启后必须恢复，否则同一段视频会被再发一遍。
      if (Array.isArray(raw?.videoFollowUps?.sent)) {
        for (const item of raw.videoFollowUps.sent) {
          const s = String(item ?? '').trim();
          if (s) deps.videoFollowUpSent.add(s);
        }
        while (deps.videoFollowUpSent.size > 500) deps.videoFollowUpSent.delete(deps.videoFollowUpSent.values().next().value);
        (0, deps.log)(`[stt] 已恢复 ${deps.videoFollowUpSent.size} 条视频补发记录（重启不重复补发）`);
      }
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = defaultWakeConfigV2(deps);
          let agentToken = String(val.agentToken || deps.crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = deps.crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              // 加载时也按已知字段过滤：旧状态文件里可能残留任意键（见 WAKE_TRIGGER_KEYS）。
              triggers: pickWakeTriggersV2(deps, (val.wakeConfig?.triggers) ?? {}, defaultWc.triggers)
            },
            recentMessages: Array.isArray(val.recentMessages) ? (0, deps.normalizeVideoRecordMessages)(val.recentMessages) : [],
            unread: Array.isArray(val.unread) ? (0, deps.normalizeVideoRecordMessages)(val.unread) : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            lastMediaAt: Number(val.lastMediaAt) || 0,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
              ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0) : 0,
            modelSeenSeqs: new Set(),
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            userPersonas: (val.userPersonas && typeof val.userPersonas === 'object') ? val.userPersonas : {},
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })(),
            persona: (val.persona && typeof val.persona === 'object' && typeof val.persona.text === 'string' && val.persona.text.trim())
              ? { text: String(val.persona.text).slice(0, (0, deps.personaMaxChars)()), setAt: Number(val.persona.setAt) || 0 }
              : null
          };
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(deps, st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(deps, st);
          (0, deps.rememberAgentToken)(key, st.agentToken);
          deps.socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = (0, deps.sanitizeForwardId)(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = (0, deps.sanitizeForwardId)(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) deps.seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(deps, st, { skipSave: true, key });
          (0, deps.scheduleProactiveCheckV2)(key);
        }
        loadMemoryLayers(deps, raw);
        pruneHeavyMedia(deps);
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        // 但只有在文件仍是「我们读到的那一份」时才写：否则说明有另一个进程写过它，
        // 我们手里的内存态已经过时，回写会静默吞掉对方的新数据。
        const nowStamp = (() => {
          try {
            const s = deps.fs.statSync(deps.SOCIAL_V2_FILE);
            return `${s.size}:${s.mtimeMs}`;
          } catch {
            return null;
          }
        })();
        if (fileStamp !== null && nowStamp !== null && fileStamp !== nowStamp) {
          (0, deps.log)('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
        } else {
          saveSocialV2State(deps);
        }
      }
    } catch (error) {
      (0, deps.log)('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }
// @bridge-function loadSocialV2State:end

// @bridge-function saveSocialV2State:start
function saveSocialV2State(deps) {
    try {
      const obj = { paused: deps.socialV2.paused, pausedSince: Number(deps.socialV2.pausedSince) || 0, conversations: Object.create(null),
        globalImpressions: deps.socialV2.globalImpressions, sharedEvents: deps.socialV2.sharedEvents.slice(-500), impressionsMigrated: true, handoffs: deps.socialV2.handoffs,
        // 跨会话摘要：这里以前漏了，导致摘要只活在内存、重启即清空（loadMemoryLayers 却会读它）。
        digests: (0, deps.digestSnapshot)(deps.socialV2.digests),
        // D47：「距上次重建」记帐。这里以前也漏了（同一个坑的第三次），
        // 结果重启后 sessionRecycle 的条数/小时阈值全部从零重算。
        sessionResets: (0, deps.packSessionResets)(deps.socialV2.sessionResets) };
      for (const [key, st] of deps.socialV2.conversations) {
        // 防御：内存里出现过「key 在、值被清成 undefined」的脏会话，会让整次保存抛 TypeError。
        if (!st) {
          deps.socialV2.conversations.delete(key);
          (0, deps.log)(`[状态] 会话 ${key} 的状态是空的，已丢弃并在本次保存里跳过`);
          continue;
        }
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          lastActionAt: st.lastActionAt,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          lastIncomingAt: st.lastIncomingAt || 0,
          // 含图标记必须落盘：内存里那份重启就没，选型会退回空闲模型（23:42 真机复现）。
          lastMediaAt: st.lastMediaAt || 0,
          userPersonas: st.userPersonas && typeof st.userPersonas === 'object' ? st.userPersonas : {},
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
          preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
          lastUnreadSeq: st.lastUnreadSeq || 0,
          lastReadThroughSeq: st.lastReadThroughSeq || 0,
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          seenForwardIds: Array.from(deps.seenForwardIds.get(key) || []).slice(-1000),
          persona: st.persona && typeof st.persona === 'object' ? { text: String(st.persona.text ?? ''), setAt: Number(st.persona.setAt) || 0 } : null
        };
      }
      // P3-7：preset 指纹必须持久化，否则每次启动都当“首次”而永不触发重建
      obj.presetFingerprint = deps.socialV2.presetFingerprint || null;
      obj.pendingPresetRecycle = !!deps.socialV2.pendingPresetRecycle;
      // 已补发的视频转写（`${key}:${media.file||media.url}`）：重启后恢复，避免重复补发。
      obj.videoFollowUps = { sent: Array.from(deps.videoFollowUpSent) };
      (0, deps.atomicWriteJson)(deps.SOCIAL_V2_FILE, obj);
    } catch (error) {
      (0, deps.log)('保存 socialV2 状态失败:', error?.message ?? error);
    }
  }
// @bridge-function saveSocialV2State:end
export function createWakeState(deps) {
  return {
    normalizeSpeakerIdsV2: (value) => normalizeSpeakerIdsV2(deps, value),
    pickWakeTriggersV2: (source, fallback) => pickWakeTriggersV2(deps, source, fallback),
    defaultWakeConfigV2: () => defaultWakeConfigV2(deps),
    refreshDefaultWakeConfigV2: (st) => refreshDefaultWakeConfigV2(deps, st),
    refreshAllDefaultWakeConfigsV2: () => refreshAllDefaultWakeConfigsV2(deps),
    hasExplicitEndV2: (st) => hasExplicitEndV2(deps, st),
    isSleepingConfigV2: (wc) => isSleepingConfigV2(deps, wc),
    preSleepWaitBlockedV2: (st) => preSleepWaitBlockedV2(deps, st),
    computeWakeSafetyV2: (wc) => computeWakeSafetyV2(deps, wc),
    ensureWakeableV2: (st, opts) => ensureWakeableV2(deps, st, opts),
    getSocialV2State: (key) => getSocialV2State(deps, key),
    saveHandoffDigest: (key) => saveHandoffDigest(deps, key),
    takeHandoffDigest: (key) => takeHandoffDigest(deps, key),
    pruneHeavyMedia: () => pruneHeavyMedia(deps),
    loadMemoryLayers: (raw) => loadMemoryLayers(deps, raw),
    loadSocialV2State: () => loadSocialV2State(deps),
    saveSocialV2State: () => saveSocialV2State(deps)
  };
}
