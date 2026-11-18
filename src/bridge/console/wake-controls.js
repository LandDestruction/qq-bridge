// console/wake-controls: extracted bridge responsibilities; no startup side effects.
// Live dependencies: acknowledgeMessagesV2, cancelReplyCheckV2, cfg, clampPreSleepWait, clearTimeout, computeWakeSafetyV2, currentMode, ensureWakeableV2, getSocialV2State, isSleepingConfigV2, latestMessageOf, log, markReadCalledKeys, modeAllowed, normalizeSpeakerIdsV2, pickWakeTriggersV2, preSleepWaitBlockedV2, readThroughSeqV2, requestedReadThroughSeqV2, saveSocialV2State, searchHistory, sendWakePromptV2, sessionLabel, setupSleepTimerV2, socialV2, v2ToolEnabled, wakeConfigMissCount, wakeConfigUpdatedKeys, warnedPreSleepClamp
// GET /api/socialV2/states 的只读视图：会话标签 + 记忆计数，不写盘、不调 QQ API。
// 放在工厂外：工厂体已接近 300 行红线，这里只按 deps 传参，不持有闭包状态。
// 控制台要的是「你上次翻到哪」，不是机器人眼里的「未读」——消息都会被处理，没有未读这回事。
// 所以这里把每个会话最新的本地 seq 发下去，前端拿它跟操作者的阅读水位相减算出「新到几条」。
function latestMessageSeq(st) {
  let max = 0;
  for (const arr of [st && st.recentMessages, st && st.unread]) {
    if (!Array.isArray(arr)) continue;
    for (const m of arr) {
      const n = Number(m && m.seq);
      if (Number.isSafeInteger(n) && n > max) max = n;
    }
  }
  return max;
}
// 会话卡片/详情要显示「最后一句」：从最近消息里取最新一条，压成一行短预览。
// 占位词（[图片]/[表情]/[视频 …]）对「最近在说什么」没有信息量，直接剥掉；
// 引用前缀也只留被引用者名字，正文留给人看。
const PREVIEW_PLACEHOLDER = /\[(?:图片|表情|动画表情|视频|语音|文件|闪照)[^\]]*\]/g;
// 把一条消息压成「最后一句」预览：占位词 / 引用前缀对「最近在说什么」没有信息量，剥掉。
function previewOfText(rawText) {
  const text = String(rawText || '')
    .replace(/\[引用[^\]]*\]/g, ' ')
    .replace(PREVIEW_PLACEHOLDER, ' ')
    .replace(/^@\S+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
function previewOfDbRow(row) {
  if (!row) return null;
  let text = previewOfText(row.text);
  if (!text) {
    // 最新一条是纯媒体（[图片]/[表情]/[视频…]）：剥完占位词就空了，但「最后一条是张图」本身也是信息，
    // 不能因此退回几天前那句文字。取第一个占位词当预览标签。
    const media = String(row.text || '').match(PREVIEW_PLACEHOLDER);
    text = media ? media[0] : '';
  }
  if (!text) return null;
  // 自己发的气泡前端只显示正文（不写「我：」），和会话语录保持一致。
  return { sender: row.isSelf ? '我' : String(row.sender || ''), text, at: Number(row.ts) || 0 };
}
function lastMessagePreview(st) {
  const list = Array.isArray(st && st.recentMessages) ? st.recentMessages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i] || {};
    const text = String(msg.text || '')
      .replace(/\[引用[^\]]*\]/g, ' ')
      .replace(PREVIEW_PLACEHOLDER, ' ')
      .replace(/^@\S+\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    return {
      sender: String(msg.sender || ''),
      text: text.length > 80 ? `${text.slice(0, 80)}…` : text,
      at: Number(msg.time) || 0
    };
  }
  return null;
}

function buildSocialStates(deps) {
  const list = [];
  const now = Date.now();
  const readLatest = typeof deps.latestMessageOf === 'function' ? deps.latestMessageOf : null;
  const sharedEvents = Array.isArray(deps.socialV2 && deps.socialV2.sharedEvents) ? deps.socialV2.sharedEvents : [];
  let globalEventCount = 0;
  const eventsByScope = new Map();
  for (const event of sharedEvents) {
    if (!event) continue;
    if (event.scope === 'global') globalEventCount += 1;
    else if (event.scope) eventsByScope.set(event.scope, (eventsByScope.get(event.scope) || 0) + 1);
  }
  const conversations = deps.socialV2 && deps.socialV2.conversations;
  if (!conversations || typeof conversations[Symbol.iterator] !== 'function') return list;
  for (const [key, st] of conversations) {
    try {
      const info = (0, deps.sessionLabel)(key);
      const wakeConfig = st && st.wakeConfig ? st.wakeConfig : {};
      // 卡片要「这一句就是最新的」：优先读消息永久库，读不到（库没开 / 还没落库）才退回内存缓存。
      const dbPreview = readLatest ? previewOfDbRow(readLatest(key)) : null;
      list.push({
        key,
        wakeConfig: st && st.wakeConfig,
        unreadCount: Array.isArray(st && st.unread) ? st.unread.length : 0,
        recentCount: Array.isArray(st && st.recentMessages) ? st.recentMessages.length : 0,
        lastSeq: latestMessageSeq(st),
        lastMessage: dbPreview || lastMessagePreview(st),
        lastWakeReason: st && st.lastWakeReason,
        lastAiReplyAt: st && st.lastAiReplyAt,
        noActionCount: wakeConfig.noActionCount || 0,
        kind: info.kind,
        id: info.id,
        name: info.name,
        label: info.label,
        memoryCounts: {
          topics: Array.isArray(st && st.activeTopics) ? st.activeTopics.length : 0,
          thoughts: Array.isArray(st && st.pendingThoughts)
            ? st.pendingThoughts.filter((t) => {
              const expiresAt = t && (t.expiresAtMs ?? t.expiresAt);
              return !expiresAt || Number(expiresAt) > now;
            }).length
            : 0,
          impressions: st && st.memberImpressions && typeof st.memberImpressions === 'object' ? Object.keys(st.memberImpressions).length : 0,
          recent: Array.isArray(st && st.recentMessages) ? st.recentMessages.length : 0,
          events: globalEventCount + (eventsByScope.get(key) || 0)
        }
      });
    } catch { /* 单个会话字段畸形就跳过这条，整个视图照常返回 */ }
  }
  return list;
}

export function createConsoleWakeControls(deps) {
// @bridge-function handleConsoleWakeControls:start
async function handleConsoleWakeControls(request) {

        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/search-history') {
          if (deps.cfg.socialV2?.historySearch === false) { request.sendJson({ ok: false, error: '历史检索功能已关闭' }, 403); return true; /* @bridge-handled */ }
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          const query = String(body.q ?? body.query ?? '').trim();
          const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 50);
          const sinceMs = Number(body.sinceMs) || 0;
          if (!query) { request.sendJson({ ok: false, error: 'q 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (key && request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (key && request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (deps.currentMode !== 'reserved2') { request.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; /* @bridge-handled */ }
          const found = (0, deps.searchHistory)({ key, q: query, limit, sinceMs });
          request.sendJson({ ...found, key: key || null, query });
          return true; /* @bridge-handled */
        }

        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/mark-read') {
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('markRead')) { request.sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return true; /* @bridge-handled */ }
          const st = (0, deps.getSocialV2State)(key);
          // 注意：不带 throughSeq 的调用会清空全部未读，这是**有意保留的兼容语义**
          // （旧 preset 与「没有水位」的收尾调用；见 acknowledgeMessagesV2 的注释与
          // test-token-economy 的 legacy 用例）。当前 preset 会明确要求带上 readThroughSeq 水位。
          const throughSeq = (0, deps.requestedReadThroughSeqV2)(st, body, !!request.req.headers['x-agent-token']);
          // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
          // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
          if ((0, deps.isSleepingConfigV2)(st.wakeConfig) && (0, deps.preSleepWaitBlockedV2)(st)) {
            const preSleepMs = Math.max(0, Number(deps.cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            // 建议的 timeoutMs 必须夹到 wait.maxMs 以内（否则模型照做也够不到观察窗口 → 永远回不了潜水）。
            const preSleepWait = (0, deps.clampPreSleepWait)(preSleepMs, Number(deps.cfg.socialV2?.wait?.maxMs) || 600000);
            if (preSleepWait.clamped && !deps.warnedPreSleepClamp) {
              deps.warnedPreSleepClamp = true;
              (0, deps.log)(`⚠️ 配置 socialV2.wake.preSleepWaitMs=${preSleepMs} 超过 wait.maxMs=${preSleepWait.cap}，建议值已按 ${preSleepWait.ms} 处理（否则沉睡前观察永远凑不满，会卡在「回不去潜水」）`);
            }
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            request.sendJson({
              ok: false,
              error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepWait.ms}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return true; /* @bridge-handled */
          }
          const markedCount = (0, deps.acknowledgeMessagesV2)(st, throughSeq);
          st.lastActionAt = Date.now();
          st.wakeConfig.noActionCount = 0;
          // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
          if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
            st.wakeConfig.infinite = true;
          }
          (0, deps.ensureWakeableV2)(st, { key });
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'mark_read';
          // 只有**模型自己**调用（带 agent token）才算「本轮遵守了 mark_read」。
          // 控制台/运维点一次 mark_read 也会走这个路由；以前无条件 add，于是下一次
          // 模型完全不调工具的唤醒会被判「合规」，不提醒、不计数（审计 P2-4）。
          if (request.req.headers['x-agent-token']) deps.markReadCalledKeys.add(key);
          (0, deps.saveSocialV2State)();
          (0, deps.log)(`[reserved2] ${request.req.headers['x-agent-token'] ? '工具' : '控制台'}标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
          request.sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: (0, deps.readThroughSeqV2)(st), wakeGuaranteed: (0, deps.computeWakeSafetyV2)(st.wakeConfig).guaranteed, wakeSafety: (0, deps.computeWakeSafetyV2)(st.wakeConfig), wakeConfig: st.wakeConfig });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/wake-config') {
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('setWakeConfig')) { request.sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return true; /* @bridge-handled */ }
          const st = (0, deps.getSocialV2State)(key);
          const throughSeq = (0, deps.requestedReadThroughSeqV2)(st, body, !!request.req.headers['x-agent-token']);
          // Preserve the deployed behavior: with markRead disabled, update wake configuration only.
          const acknowledgeOnClose = throughSeq !== null && (0, deps.v2ToolEnabled)('markRead');
          const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              // 只带已知字段（见 WAKE_TRIGGER_KEYS 的说明）；未知键一律丢弃。
              ...(0, deps.pickWakeTriggersV2)(inputTriggers, current.triggers),
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(deps.cfg.socialV2?.wake?.sleepMinMs) || 0);
            const maxMs = Number(deps.cfg.socialV2?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(deps.cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(deps.cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(deps.cfg.socialV2?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(deps.cfg.socialV2?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = (0, deps.normalizeSpeakerIdsV2)(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              request.sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
              return true; /* @bridge-handled */
            }
          }
          // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
          if ((0, deps.isSleepingConfigV2)(next) && (0, deps.preSleepWaitBlockedV2)(st)) {
            const preSleepMs = Math.max(0, Number(deps.cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            // 建议的 timeoutMs 必须夹到 wait.maxMs 以内（否则模型照做也够不到观察窗口 → 永远回不了潜水）。
            const preSleepWait = (0, deps.clampPreSleepWait)(preSleepMs, Number(deps.cfg.socialV2?.wait?.maxMs) || 600000);
            if (preSleepWait.clamped && !deps.warnedPreSleepClamp) {
              deps.warnedPreSleepClamp = true;
              (0, deps.log)(`⚠️ 配置 socialV2.wake.preSleepWaitMs=${preSleepMs} 超过 wait.maxMs=${preSleepWait.cap}，建议值已按 ${preSleepWait.ms} 处理（否则沉睡前观察永远凑不满，会卡在「回不去潜水」）`);
            }
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            request.sendJson({
              ok: false,
              error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepWait.ms}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return true; /* @bridge-handled */
          }
          const markedCount = acknowledgeOnClose ? (0, deps.acknowledgeMessagesV2)(st, throughSeq) : 0;
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          st.lastActionAt = Date.now();
          // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          (0, deps.saveSocialV2State)();
          deps.wakeConfigUpdatedKeys.add(key);
          deps.wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            (0, deps.clearTimeout)(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          (0, deps.cancelReplyCheckV2)(key); // AI 已主动设置新的唤醒配置，取消回复检查
          (0, deps.setupSleepTimerV2)(key);
          (0, deps.log)(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
          request.sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: (0, deps.readThroughSeqV2)(st), wakeConfig: next, wakeSafety: (0, deps.computeWakeSafetyV2)(next) });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'GET' && request.url.pathname === '/api/socialV2/states') {
          request.sendJson({ ok: true, conversations: buildSocialStates(deps) });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/wake') {
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          const reason = String(body.reason ?? 'admin').trim() || 'admin';
          if (!key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (deps.currentMode !== 'reserved2') { request.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; /* @bridge-handled */ }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { request.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; /* @bridge-handled */ }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !(0, deps.modeAllowed)(key, kind, id, deps.cfg, deps.currentMode)) {
            request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return true; /* @bridge-handled */
          }
          const st = (0, deps.getSocialV2State)(key);
          if (st.pendingWakeTimer) {
            (0, deps.clearTimeout)(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          // 第一次唤醒必须走 bootstrap：那条 prompt 里带着「二代协议说明 + 操作者为这个会话
          // 预写的初始提示词（群环境/氛围）」。若用手动唤醒的 admin 文案顶掉它，这个会话就
          // 永远拿不到引导 —— 而 bootstrapSent 一旦置真，后续再也不会补发。
          const firstWake = !st.bootstrapSent;
          if (firstWake) st.bootstrapSent = true;
          const effectiveReason = firstWake ? 'bootstrap' : reason;
          (0, deps.saveSocialV2State)();
          // 和其它唤醒入口保持一致：sendWakePromptV2 是异步的，这里不 await（不能让 HTTP 回复
          // 等一个可能卡几十秒的模型回合），但必须挂 catch。裸调用一旦 reject 就是
          // unhandledRejection：Node 会打警告甚至按配置退出进程，而 HTTP 那边已经回了 {ok:true}，
          // 表面上"唤醒成功"，实际上谁也不知道它失败了。
          void (0, deps.sendWakePromptV2)(key, effectiveReason).catch((error) => (0, deps.log)(`[reserved2] 手动唤醒异常 ${key}:`, error?.message ?? error));
          (0, deps.log)(`控制台：手动唤醒 ${key}（${effectiveReason}${firstWake && reason !== effectiveReason ? `，首次唤醒，请求原因 ${reason} 已升级为 bootstrap` : ''}）`);
          request.sendJson({ ok: true, key, reason: effectiveReason, requestedReason: reason, firstWake });
          return true; /* @bridge-handled */
        }
    return false;
  }
// @bridge-function handleConsoleWakeControls:end
  return { handleConsoleWakeControls };
}
