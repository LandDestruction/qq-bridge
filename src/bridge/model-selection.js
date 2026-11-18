// model-selection: extracted bridge responsibilities; no startup side effects.
// Live dependencies: AVAILABLE_MODELS_TTL_MS, MODEL_FAILURE_NOTIFY_MS, MODEL_FALLBACK_LOG_MAX, REASONING_EFFORT_DEFAULT, SENSITIVE_RE, activeModelOverride, api, appendActivity, appliedModelBySession, availableModelsCache, buildLocalMessages, cfg, cleanLocalReply, collectCatalogModels, createLocalClient, describeLocalFallback, describeModels, externalFailureStreak, fetchModelCatalog, isFreshMediaAt, isFreshMediaTurn, isModelCapacityError, isModelUnavailableError, knownUnavailableModels, lastModelFailureNotifyAt, localClient, localClientSig, localFallbackCfg, localFallbackState, localKeepAliveUntil, log, modelAppliedSessions, modelAutoFallbackLogged, modelFallbackCount, modelFallbackSkipLogged, modelRouteLogged, modelSeesImages, modelSelectionEpoch, normalizeRouting, noteBounded, orderFallbacksByProvider, peakAgentCfg, peakPauseActive, pickUsableModel, planFallback, recentMediaTurns, rememberModel, resolveModelChoice, selfNickname, sendToQQ, setTimeout, shouldTriggerLocalFallback, sleep, socialState, socialV2, unwrap, withTimeout
// ⑨ 聊天模型白名单（2026-10-28）：socialV2.modelRouting.allowedProviderModels 决定聊天主路径能选哪些模型，
// 默认只放 deepseek 系 flash；显式 [] = 不过滤（回退开关）。纯函数放模块作用域，不占冻结的 createModelSelection。
const CHAT_MODEL_GLOB_CACHE = new Map();
function chatModelGlob(pattern, value) {
  const key = `${pattern}\u0000${value}`;
  if (CHAT_MODEL_GLOB_CACHE.has(key)) return CHAT_MODEL_GLOB_CACHE.get(key);
  let hit = false;
  try {
    const re = new RegExp(`^${String(pattern).split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
    hit = re.test(String(value));
  } catch { hit = String(pattern).toLowerCase() === String(value).toLowerCase(); }
  CHAT_MODEL_GLOB_CACHE.set(key, hit);
  return hit;
}
export function isChatModelAllowed(deps, modelRef) {
  const rules = deps?.cfg?.socialV2?.modelRouting?.allowedProviderModels;
  if (!Array.isArray(rules)) return true; // 配置缺失（旧 config/测试）→ 不过滤
  if (rules.length === 0) return true;    // 显式空数组 = 不过滤（回退开关）
  if (!modelRef || !modelRef.model) return true;
  const provider = String(modelRef.provider || '');
  const model = String(modelRef.model || '');
  for (const rule of rules) {
    if (typeof rule !== 'string' || !rule.trim()) continue;
    const text = rule.trim();
    const slash = text.indexOf('/');
    const providerPattern = slash >= 0 ? text.slice(0, slash) : '*';
    const modelPattern = slash >= 0 ? text.slice(slash + 1) : text;
    if (chatModelGlob(providerPattern, provider) && chatModelGlob(modelPattern, model)) return true;
  }
  return false;
}
export function filterChatModels(deps, list) {
  if (!Array.isArray(list)) return list;
  const rules = deps?.cfg?.socialV2?.modelRouting?.allowedProviderModels;
  if (!Array.isArray(rules)) return list;
  if (rules.length === 0) return list;
  return list.filter((m) => isChatModelAllowed(deps, m));
}
// @bridge-function chatErrorNotice:start
function chatErrorNotice(deps, key, message) {
    const ownerKey = `private:${String(deps.cfg.ownerQQ ?? '')}`;
    const isOwner = Boolean(deps.cfg.ownerQQ) && key === ownerKey;
    if (!isOwner) return '⚠️ 我这轮出了点问题，稍后再试';
    return `⚠️ 我这轮出了点问题：${chatSafeReason(deps, message)}，稍后再试`;
  }
// @bridge-function chatErrorNotice:end

// @bridge-function chatSafeReason:start
function chatSafeReason(deps, message) {
    const raw = String(message ?? '').trim();
    if (!raw) return '未知错误';
    if (deps.SENSITIVE_RE.test(raw)) return '含敏感信息，已隐藏';
    const code = raw.match(/"?code"?\s*[:=]\s*"([^"]{1,40})"/i)?.[1] ?? '';
    // 去掉 JSON 片段后剩下的自然语言才是人话；整段是 JSON 时退回原始前缀。
    const plain = raw.replace(/\{[^{}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
    const brief = (plain || raw).slice(0, 100);
    return code ? `${code}：${brief}` : brief;
  }
// @bridge-function chatSafeReason:end

// @bridge-function recordModelFailure:start
async function recordModelFailure(deps, key, message) {
    // 2026-11-02：内容审核 / 上下文超长 也走「换模型重试」这条路。
    // 现场：智谱返回 {"finish_reason":"sensitive"} 直接拒答；glm-4.6v 128K 之后返回
    // {"code":"1261","message":"Prompt exceeds max length"}。以前这两类只当普通回合失败，
    // 群里只看到「⚠️ 我这轮出了点问题」，不会触发备用模型 —— 用户问过「为什么不自动切换」。
    const rejectText = String(message ?? '').toLowerCase();
    const modelRejected = (rejectText.includes('finish_reason') && rejectText.includes('sensitive'))
      || rejectText.includes('prompt exceeds max length')
      || rejectText.includes('"code":"1261"')
      || rejectText.includes('content policy')
      || rejectText.includes('内容审核');
    if (!(0, deps.isModelCapacityError)(message) && !modelRejected) return false;
    const current = deps.activeModelOverride || { provider: deps.cfg.dsh?.provider, model: deps.cfg.dsh?.model };
    // 2026-11-02：降级链按「这一轮是不是带图」分文本链 / 视觉链（各自三级，第三级默认 none=不可用）。
    let hasMedia = false;
    try { hasMedia = Boolean(key && deps.keyHasRecentMedia(key)); } catch {}
    const route = (0, deps.normalizeRouting)(deps.cfg.socialV2?.modelRouting);
    const routeChain = hasMedia
      ? (Array.isArray(route.visionFallback) && route.visionFallback.length ? route.visionFallback : deps.cfg.dsh?.modelFallbacks)
      : (Array.isArray(route.fallback) && route.fallback.length ? route.fallback : deps.cfg.dsh?.modelFallbacks);
    // 决策本身是纯函数（order 里最后一项固定为「最后兜底」）。
    const plan = (0, deps.planFallback)({ message, current, fallbacks: filterChatModels(deps, routeChain), count: deps.modelFallbackCount });
    if (plan.action !== 'fallback') {
      (0, deps.log)(`⚠️ 模型不可用（${current.provider}/${current.model}），但${hasMedia ? '视觉' : '文本'}降级链没有可用的下一级，无法自动降级`);
      return false;
    }
    // 三级链的第三级是「不可用」：不再拿它去请求，直接告诉调用方「到此为止」。
    if (String(plan.next.provider || '') === 'none') {
      (0, deps.log)(`[模型降级] ${hasMedia ? '视觉' : '文本'}降级链已到「不可用」档（${current.provider}/${current.model}），本轮不再尝试其它模型`);
      return 'blocked';
    }
    deps.modelFallbackCount = plan.count;
    deps.lastModelFailureNotifyAt = Date.now();
    deps.activeModelOverride = {
      provider: plan.next.provider,
      model: plan.next.model,
      since: Date.now(),
      reason: String(message).slice(0, 120)
    };
    deps.modelSelectionEpoch += 1;
    (0, deps.log)(plan.logLine);
    if (!(0, deps.modelSeesImages)(deps.activeModelOverride.provider, deps.activeModelOverride.model)) {
      (0, deps.log)(`⚠️ 降级目标 ${deps.activeModelOverride.provider}/${deps.activeModelOverride.model} 不在可看图清单里：接下来带图的回合只能看到文字说明（可在 config 里配 dsh.visionModels 调整）`);
    }
    void key;
    return true;
  }
// @bridge-function recordModelFailure:end

// @bridge-function localCfgNow:start
function localCfgNow(deps) {
    return (0, deps.localFallbackCfg)(deps.cfg.socialV2?.localFallback);
  }
// @bridge-function localCfgNow:end

// @bridge-function localClientNow:start
function localClientNow(deps) {
    const c = localCfgNow(deps);
    const sig = [c.baseUrl, c.model, c.timeoutMs, c.numCtx, c.keepAlive].join('|');
    if (!deps.localClient || deps.localClientSig !== sig) {
      deps.localClient = (0, deps.createLocalClient)({ cfg: c });
      deps.localClientSig = sig;
    }
    return deps.localClient;
  }
// @bridge-function localClientNow:end

// @bridge-function noteExternalTurnOk:start
function noteExternalTurnOk(deps, key) {
    deps.externalFailureStreak.delete(key);
    if (!deps.localFallbackState.active) return;
    const prev = deps.localFallbackState;
    deps.localFallbackState = { active: false, since: 0, reason: '', ok: prev.ok, fail: prev.fail };
    (0, deps.log)(`[local-fallback] ${key} 主链路已恢复，切回外部模型（降级期间本地成功 ${prev.ok} 次 / 失败 ${prev.fail} 次）`);
    (0, deps.appendActivity)(`${key} [本地兜底] 主链路恢复，切回外部模型`);
    // 恢复通知也只写日志（不再私聊管理员）。
  }
// @bridge-function noteExternalTurnOk:end

// @bridge-function tryLocalFallback:start
async function tryLocalFallback(deps, key, message, { fallbacksRemaining = 0 } = {}) {
    const c = localCfgNow(deps);
    if (!c.enabled) return false;
    const streak = (deps.externalFailureStreak.get(key) || 0) + 1;
    deps.externalFailureStreak.set(key, streak);
    // fallbacksRemaining 由调用方给：容量类错误只有在「备用模型也用尽」时才允许切本地。
    if (!(0, deps.shouldTriggerLocalFallback)({ errorMessage: message, streak, cfg: c, fallbacksRemaining })) return false;
    const client = localClientNow(deps);
    // 探测 2 秒超时 + 30 秒缓存：本地服务没起时绝不能拖慢主链路。
    if (!(await client.probe())) {
      (0, deps.log)(`[local-fallback] ${key} 本地模型没起（${c.baseUrl}），本轮不接管`);
      return false;
    }
    const st = (0, deps.socialState)(key);
    const history = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const incoming = [...history].reverse().find((m) => m && !m.isSelf) || null;
    // 降级时也要用**线上真实昵称**：这个机器人叫「大肥鱼小姐」，自报「小鲸鱼」等于告诉群里换人了。
    // selfNickname 在同一个闭包里（启动时从网关取），这里再兜一层空值，取不到就退回默认名。
    const messages = (0, deps.buildLocalMessages)({ history, incoming, cfg: c, nickname: String(deps.selfNickname || '').trim() });
    const started = Date.now();
    let out;
    try {
      out = await client.chat(messages, { timeoutMs: c.timeoutMs });
      // 兜底真的接管过一次：说明外部确实挂了，短时间内还会再用 → 把本地模型保活到 30 分钟，
      // 避免下一次又要冷加载（6.3GB 显存，平时仍按 keepAlive 3m 自然卸载，不常驻）。
      // 只发一次：用模块级到期时间记账。c.keepAlive 是配置常量（3m/10m），永远不会变成 30m，
      // 拿它做判据就会「每次兜底接管都再打一发」，把一次预热写成持续常驻。
      if (Date.now() >= deps.localKeepAliveUntil) {
        deps.localKeepAliveUntil = Date.now() + 30 * 60 * 1000;
        (0, deps.setTimeout)(() => {
          client.chat([{ role: 'user', content: '（保活，不用回复）' }], { timeoutMs: 20000, keepAlive: '30m' })
            .then(() => (0, deps.log)('[local-fallback] 兜底已启用，本地模型保持 30 分钟（之后按配置自然卸载）'))
            .catch(() => {});
        }, 0);
      }
    } catch (error) {
      deps.localFallbackState.fail += 1;
      (0, deps.log)(`[local-fallback] ${key} 本地生成失败：${error?.message ?? error}`);
      return false;
    }
    const reply = (0, deps.cleanLocalReply)(out.text, {
      maxChars: c.maxReplyChars,
      speakers: [...new Set(history.filter((m) => m && !m.isSelf).map((m) => String(m.sender ?? '').trim()).filter(Boolean))],
      echoOf: incoming ? String(incoming.plain ?? incoming.text ?? '') : ''
    });
    if (!reply) {
      deps.localFallbackState.fail += 1;
      (0, deps.log)(`[local-fallback] ${key} 本地输出为空（prompt ${out.promptTokens} tok / 生成 ${out.outputTokens} tok），本轮不接管`);
      return false;
    }
    const elapsed = Date.now() - started;
    await (0, deps.sendToQQ)(key, reply);
    deps.localFallbackState.ok += 1;
    if (!deps.localFallbackState.active) {
      deps.localFallbackState = { active: true, since: Date.now(), reason: String(message).slice(0, 120), ok: deps.localFallbackState.ok, fail: deps.localFallbackState.fail };
      (0, deps.log)(`[local-fallback] ${key} 外部不可用，本地模型接管：${(0, deps.describeLocalFallback)({ cfg: c, active: true, since: deps.localFallbackState.since })}`);
      (0, deps.appendActivity)(`${key} [本地兜底] 外部不可用，本地模型接管`);
    }
    (0, deps.log)(`[local-fallback] ${key} 本地回复已发送 ${elapsed}ms（prompt ${out.promptTokens} tok / 生成 ${out.outputTokens} tok / 生成耗时 ${out.outputMs}ms）`);
    (0, deps.appendActivity)(`${key} [本地兜底] ${reply.slice(0, 60)}`);
    return true;
  }
// @bridge-function tryLocalFallback:end

// @bridge-function probeAvailableModels:start
async function probeAvailableModels(deps, { force = false } = {}) {
    const fresh = deps.availableModelsCache
      && deps.availableModelsCache.epoch === deps.modelSelectionEpoch
      && Date.now() - deps.availableModelsCache.at < deps.AVAILABLE_MODELS_TTL_MS;
    if (fresh && !force) return deps.availableModelsCache.list;
    try {
      const catalog = (0, deps.unwrap)(await (0, deps.withTimeout)((0, deps.fetchModelCatalog)(), 5000, 'session/modelCatalog'), 'session.modelCatalog');
      const list = (0, deps.collectCatalogModels)(catalog);
      deps.availableModelsCache = { epoch: deps.modelSelectionEpoch, at: Date.now(), list };
      return list;
    } catch (error) {
      (0, deps.log)(`探测可用模型清单失败（沿用上一次结果）：${error?.message ?? error}`);
      return deps.availableModelsCache?.list ?? [];
    }
  }
// @bridge-function probeAvailableModels:end

// @bridge-function notifyModelAutoFallback:start
function notifyModelAutoFallback(deps, from, to, available) {
    if (Date.now() - deps.lastModelFailureNotifyAt <= deps.MODEL_FAILURE_NOTIFY_MS) return;
    deps.lastModelFailureNotifyAt = Date.now();
    (0, deps.log)(`[模型] 已自动兜底：${from} → ${to}（任务 B：允许兜底，按次计费；消耗可见于用量页「模型用量（按 provider）」的官方账号占比）`);
  }
// @bridge-function notifyModelAutoFallback:end

// @bridge-function keyHasRecentMedia:start
function keyHasRecentMedia(deps, key) {
    // ① 优先看「这一轮确实出现过图」的标记（reserved2 的图在工具结果里，状态窗口常常已经滑出）。
    //    没有它就会出现：这一轮提示里明说了「有图，去调 qq_get_message_images」，
    //    可选型还按空闲模型来 —— 工具把图返回给一个不支持图片的模型，
    //    DSH 换成 `[image unavailable: … does not declare image input]`，模型只能说「我看不到」。
    if ((0, deps.isFreshMediaTurn)(deps.recentMediaTurns, key)) return true;
    try {
      const st = deps.socialV2.conversations.get(key);
      if (!st) return false;
      // ② 状态里持久化的「最近一次出现图」：进程重启后内存 Map 会清空，这条不会。
      //    23:39 重启 → 23:42 又读不出图，就是只靠内存标记的漏法。
      if ((0, deps.isFreshMediaAt)(st.lastMediaAt)) return true;
      const pool = [
        ...(Array.isArray(st.unread) ? st.unread.slice(-6) : []),
        ...(Array.isArray(st.recentMessages) ? st.recentMessages.slice(-6) : [])
      ];
      return pool.some((m) => m && (m.hasMedia || (Array.isArray(m.media) && m.media.length)));
    } catch { return false; }
  }
// @bridge-function keyHasRecentMedia:end

// @bridge-function ensureChatModel:start
async function ensureChatModel(deps, sessionId, key = '') {
    // 高峰模型与已应用模型不一致时，必须先让 epoch 失效，否则下面的「已应用」早退会把它挡住
    //（实测：切到 mimo-v2.6-flash 后，账本里仍然是 mimo-v2.6-pro）。
    try {
      const _r = (0, deps.normalizeRouting)(deps.cfg.socialV2?.modelRouting);
      const _peakRef = _r.peak;
      const _wantKey = _peakRef ? `${_peakRef.provider}/${_peakRef.model}` : '';
      const _applied = deps.appliedModelBySession.get(sessionId);
      if ((0, deps.inPeakWindow)() && String(key).startsWith('group:') && _wantKey
        && (!_applied || `${_applied.provider}/${_applied.model}` !== _wantKey)) {
        deps.modelAppliedSessions.delete(sessionId);
      }
    } catch {}
    // 含图轮必须落到能看图的模型上：已应用的模型看不了图 → 作废「本 epoch 已应用」缓存，重新选型。
    // 为什么必须显式作废：下面的「本 epoch 已应用」早退会在「这轮刚才已经对齐过模型」时直接返回 applied，
    // 于是同一会话前一秒被对齐成 deepseek-v4.1-flash 后，图来了也不会再切 —— 2026-10-26 22:15
    // group:100000006 的真机现象就是这条（DSH 回 `[image unavailable: … does not declare image input]`）。
    try {
      if (key && keyHasRecentMedia(deps, key)) {
        const applied = deps.appliedModelBySession.get(sessionId);
        if (!applied || !(0, deps.modelSeesImages)(applied.provider, applied.model)) deps.modelAppliedSessions.delete(sessionId);
      }
    } catch {}
    if (deps.modelAppliedSessions.get(sessionId) === deps.modelSelectionEpoch) return 'applied';
    const byKind = deps.cfg.socialV2?.modelByKind || {};
    const kindEntry = key ? byKind[key.startsWith('private:') ? 'private' : 'group'] : null;
    const kindUse = kindEntry && kindEntry.provider && kindEntry.model ? { provider: kindEntry.provider, model: kindEntry.model } : null;
    // 带媒体的回合：中转模型不支持图片输入，会让她「看不到图」，这里强制用能看图的模型。
    const bad = (m) => m && (deps.knownUnavailableModels.has(`${m.provider}/${m.model}`) || !isChatModelAllowed(deps, m));
    // 模型路由（文本 / 视觉两套，各自 idle/peak + 三级降级链）：优先级 vision|text > peak > idle > fallback。
    const routing = (0, deps.normalizeRouting)(deps.cfg.socialV2?.modelRouting);
    const isPeakNow = (0, deps.inPeakWindow)();
    const visionPreferred = (isPeakNow ? routing.visionPeak : routing.visionIdle) || null;
    // describeFirst（默认 true）：图片先交给桥接转述成文字，不把会话切到视觉模型（见 media-resolution 的转述路径）。
    const describeFirst = deps.cfg?.socialV2?.mediaVision?.describeFirst !== false;
    let mediaUse = key && keyHasRecentMedia(deps, key) && !describeFirst
      ? (visionPreferred || deps.cfg.socialV2?.modelForMedia || null)
      : null;
    // 配了但注册表里没有的 id（典型：合池前的 cn: 前缀）不要再用：新会话第一句带图时会走
    // modelForMedia，否则每个新会话都要先失败一次、再降级 —— 日志每轮一条假告警。
    if (bad(mediaUse)) { (0, deps.log)(`[模型] 视觉模型 ${mediaUse.provider}/${mediaUse.model} 已知不可用，跳过它`); mediaUse = null; }
    let availForRoute = [];
    try { availForRoute = await probeAvailableModels(deps); } catch {}
    const kindChoice = kindUse && !bad(kindUse) ? { provider: kindUse.provider, model: kindUse.model, source: 'kind' } : null;
    const choice = kindChoice || (0, deps.resolveModelChoice)({ routing, media: mediaUse, isPeak: isPeakNow, available: availForRoute, bad });
    let use;
    if (choice) {
      use = { provider: choice.provider, model: choice.model, supportsImages: choice.supportsImages };
      const srcLabel = { kind: '按群/私聊指定', media: '带图强制', peak: '高峰时段', idle: '空闲时段', fallback: '降级候选' }[choice.source] || choice.source;
      if (deps.modelRouteLogged !== `${sessionId}|${choice.source}|${use.provider}/${use.model}`) {
        deps.modelRouteLogged = `${sessionId}|${choice.source}|${use.provider}/${use.model}`;
        (0, deps.log)(`[模型] 选择 source=${choice.source} ${use.provider}/${use.model}（${srcLabel}）`);
      }
    } else {
      use = deps.activeModelOverride || { provider: deps.cfg.dsh?.provider, model: deps.cfg.dsh?.model };
      if (!isChatModelAllowed(deps, use)) use = filterChatModels(deps, deps.cfg.dsh?.modelFallbacks || [])[0] || use;
    }
    // §8：已知不可用/被白名单过滤的模型**不再当首选**：以前每轮先拿坏 id 去 selectModel 失败再纠正，
    // 日志每轮一条「session/model-unavailable」，白付一次 RPC 延迟。
    if (bad(use)) {
      const reasonKey = `${sessionId}|${use.provider}/${use.model}`;
      const available = filterChatModels(deps, await probeAvailableModels(deps).catch(() => []));
      const picked = (0, deps.pickUsableModel)({ provider: use.provider, model: use.model, available });
      if (picked) {
        if ((0, deps.noteBounded)(deps.modelFallbackSkipLogged, reasonKey, 200)) {
          (0, deps.log)(`[模型] 配置的模型 ${use.provider}/${use.model} 已知不可用，直接改用 ${picked.provider}/${picked.model}（不再每轮先失败一次）`);
        }
        use = { provider: picked.provider || use.provider, model: picked.model };
      }
    }
    // 视觉感知：本轮含图而选中的模型看不了图 → 从降级链里挑第一个支持 image 的顶上。
    // 否则 DSH 会抛 UNSUPPORTED_CONTENT 整轮失败，或者模型基于看不见的图编内容。
    // describeFirst=false 时 mediaUse 已优先视觉模型；若它被 bad() 过滤、use 仍看不了图，
    // 再从降级链挑一个能看图的顶上，避免 DSH 抛 UNSUPPORTED_CONTENT。
    if (!describeFirst && key && keyHasRecentMedia(deps, key) && !(0, deps.modelSeesImages)(use.provider, use.model, use)) {
      const chain = filterChatModels(deps, [use, ...(0, deps.orderFallbacksByProvider)(deps.cfg.dsh?.modelFallbacks, use.provider)]);
      const visionPick = chain.find((m) => m && m.model && (0, deps.modelSeesImages)(m.provider, m.model, m));
      if (visionPick && visionPick !== use) {
        (0, deps.log)(`[视觉] 本轮含图，当前模型 ${use.provider}/${use.model} 不支持图片，已切到 ${visionPick.provider}/${visionPick.model}`);
        use = visionPick;
      } else if (!visionPick) {
        (0, deps.log)('[视觉] ⚠️ 本轮含图，但整条降级链都没有能看图的模型：图片将降级为文字说明（配置 dsh.visionModels，或把 deepseek-flash 放进 dsh.modelFallbacks）');
      }
    }
    const provider = String(use.provider || 'deepseek-official');
    const model = String(use.model || 'deepseek-flash');
    // 自报家门要能说「为什么是这个模型」：把本轮真实选型来源随 applied 一起记下来。
    // source 取 resolveModelChoice 的来源；含图轮最终确实落在能看图的模型上时一律记 media
    //（视觉守卫可能把 use 换掉，光看 choice.source 会漏报）。
    let appliedSource = choice ? choice.source : (deps.activeModelOverride ? 'override' : 'main');
    try {
      if (key && keyHasRecentMedia(deps, key) && (0, deps.modelSeesImages)(provider, model)) appliedSource = 'media';
    } catch {}
    const defaultEffort = String(deps.cfg.dsh?.reasoningEffort || deps.REASONING_EFFORT_DEFAULT);
    // 不同 provider 支持的 effort 不一样（workbuddy2api 的模型不接受 high），逐个试。
    const perProvider = deps.cfg.socialV2?.modelEffortByProvider || {};
    const preferred = perProvider[provider] !== undefined ? String(perProvider[provider]) : defaultEffort;
    const effortVariants = [...new Set([preferred, 'low', 'off', null].map((v) => (v === null ? null : String(v))))];
    let lastError = null;
    let effortIdx = 0;
    // 模型 id 不可用（provider 注册表换了模型池）时只自动探测+重试一次，
    // 避免「配置错了 → 每次消息都探测」的抖动。
    let autoFallbackTried = false;
    let usedProvider = provider;
    let usedModel = model;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const effortTry = effortVariants[Math.min(effortIdx, effortVariants.length - 1)];
      try {
        const params = { sessionId, provider: usedProvider, model: usedModel };
        if (effortTry !== null) params.reasoningEffort = effortTry;
        const result = (0, deps.unwrap)(await deps.api.sessions.selectModel(params), 'session.selectModel');
        deps.modelAppliedSessions.set(sessionId, deps.modelSelectionEpoch);
        deps.appliedModelBySession.set(sessionId, {
          provider: String(result.selected?.provider ?? usedProvider),
          model: String(result.selected?.model ?? usedModel),
          // 自报家门（qq_self_model）读这三个字段：思考强度、真实选型来源、本轮是否含图
          effort: String(result.selected?.reasoningEffort ?? effortTry ?? '').trim() || null,
          source: appliedSource,
          media: Boolean(key && keyHasRecentMedia(deps, key)),
          supportsImages: typeof use.supportsImages === 'boolean' ? use.supportsImages : undefined,
          at: Date.now()
        });
        if (!deps.socialV2.sessionResets) deps.socialV2.sessionResets = Object.create(null);
        if (key && !deps.socialV2.sessionResets[key]) deps.socialV2.sessionResets[key] = { at: Date.now(), count: 0 };
        (0, deps.log)(`已设置会话模型 ${sessionId}${key ? ` (${key})` : ''} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})`);
        return 'applied';
      } catch (error) {
        lastError = error;
        const msg = String(error?.message ?? error);
        (0, deps.log)(`设置会话模型失败 ${sessionId}（第 ${attempt}/2 次，effort=${effortTry ?? '省略'}）: ${msg}`);
        if (/reasoning effort/i.test(msg) && effortIdx < effortVariants.length - 1) {
          effortIdx += 1;
          attempt -= 1; // 换 effort 不算失败次数
          continue;
        }
        // 模型 id 不存在 / provider 已下线：拉一次可用清单，挑一个顶上并重试。
        // 2026-10-25 事故：provider 注册表把 cn:deepseek-v4.1-flash 改成 deepseek-v4.1-flash 后，
        // 旧 id 让每个会话的 selectModel 都失败，机器人对群里完全哑掉，只能人工改配置+重启。
        if (!autoFallbackTried && (0, deps.isModelUnavailableError)(msg)) {
          autoFallbackTried = true;
          const available = filterChatModels(deps, await probeAvailableModels(deps, { force: true }));
          const picked = (0, deps.pickUsableModel)({ provider: usedProvider, model: usedModel, available });
          if (picked) {
            // 同一会话同一原因只报一次：自愈之后每轮仍会先失败一次，日志刷屏会把真问题淹掉
            // （只降级「已自愈且重复出现」的这一种，别的错误照常每轮报）。
            const fixKey = `${sessionId}|${usedProvider}/${usedModel}`;
            if ((0, deps.noteBounded)(deps.modelAutoFallbackLogged, fixKey, deps.MODEL_FALLBACK_LOG_MAX)) {
              (0, deps.log)(`⚠️ 配置的模型 ${usedProvider}/${usedModel} 不可用（${msg.slice(0, 160)}），自动改用 ${picked.provider}/${picked.model}（${picked.reason}）重试一次；探测到的可用模型：${(0, deps.describeModels)(available)}`);
            } else {
              (0, deps.log)(`[模型降级] 会话 ${sessionId} 仍持有旧选择 ${usedProvider}/${usedModel}，本轮再次纠正为 ${picked.provider}/${picked.model}（告警已折叠）`);
            }
            // 把纠正后的模型写进**本会话**的缓存：下一轮 ensureChatModel 直接用这个值，
            // 不再先拿旧 id 去 selectModel 失败一次（那是一次白付的 RPC + 延迟）。
            try { (0, deps.rememberModel)(sessionId, { provider: picked.provider, model: picked.model }); } catch {}
            // 登记坏 id：新建会话（第一个消息就带图/命中 kind）不会再去试它。
            try { deps.knownUnavailableModels.add(`${usedProvider}/${usedModel}`); } catch {}
            usedProvider = picked.provider || usedProvider;
            usedModel = picked.model;
            // 记进运行期覆盖：其余会话下一轮直接用这个模型，不必各自再踩一次失败。
            deps.activeModelOverride = { provider: usedProvider, model: usedModel, since: Date.now(), reason: `配置的模型 ${provider}/${model} 不可用` };
            deps.modelSelectionEpoch += 1;
            notifyModelAutoFallback(deps, `${provider}/${model}`, `${usedProvider}/${usedModel}`, available);
            attempt -= 1; // 回退重试不占失败次数
            continue;
          }
          (0, deps.log)(`⚠️ 配置的模型 ${usedProvider}/${usedModel} 不可用，且探测不到可替代的模型（可用清单：${(0, deps.describeModels)(available) || '空'}）`);
        }
        if (attempt < 2) await (0, deps.sleep)(1000);
      }
    }
    const message = String(lastError?.message ?? lastError ?? '');
    if (/not[- ]?found/i.test(message)) {
      // 终态失败：记下 epoch，避免退役前（或退役失败时）被反复重试刷屏。
      deps.modelAppliedSessions.set(sessionId, deps.modelSelectionEpoch);
      return 'not-found';
    }
    return 'failed';
  }
// @bridge-function ensureChatModel:end
export function createModelSelection(deps) {
  return {
    chatErrorNotice: (key, message) => chatErrorNotice(deps, key, message),
    chatSafeReason: (message) => chatSafeReason(deps, message),
    recordModelFailure: (key, message) => recordModelFailure(deps, key, message),
    localCfgNow: () => localCfgNow(deps),
    localClientNow: () => localClientNow(deps),
    noteExternalTurnOk: (key) => noteExternalTurnOk(deps, key),
    tryLocalFallback: (key, message, opts) => tryLocalFallback(deps, key, message, opts),
    probeAvailableModels: (opts) => probeAvailableModels(deps, opts),
    notifyModelAutoFallback: (from, to, available) => notifyModelAutoFallback(deps, from, to, available),
    keyHasRecentMedia: (key) => keyHasRecentMedia(deps, key),
    ensureChatModel: (sessionId, key) => ensureChatModel(deps, sessionId, key)
  };
}
