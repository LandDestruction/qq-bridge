// D62 装配阶段：模型配置校验、STT/视频补发、视觉清单、好感度 IO、媒体闸门与回合/等待记账。
// 纯搬运：语句顺序与拆分前 main() 一致；无 import，依赖全部由 deps 注入。
export function bootRuntimeState(deps) {
  const { ROOT, STATE_DIR, api, auditAndSend, cfg, collectCatalogModels, createFollowUpHub, createMediaQueue, createSttService, describeForPrompt, fetchModelCatalog, path, pruneVideoFrames, saveSocialV2State, state, transcribeWav, unwrap, validateModelConfig, withTimeout, log, noteBounded, persistCorrectedModel, mediaQueueCfg } = deps;
  // ── 启动时校验模型配置（best-effort，绝不阻止启动）────────────────────────
  // 现象：用户合并模型池后，provider 注册表里的模型 id 变了（cn:xxx → xxx），而 config.json
  // 还是旧 id，于是每个会话的 selectModel 都失败、机器人对群里完全哑掉。
  // 这里在启动后拿一次模型目录对一遍：对不上就大声告警，并把**运行期**主模型换成清单里的可用项
  // （只改内存里的 cfg，不动 config.json —— 写盘是审阅/控制台的事）。
  void (async () => {
    try {
      const catalog = unwrap(await withTimeout(fetchModelCatalog(), 5000, 'session/modelCatalog'), 'session.modelCatalog');
      const available = collectCatalogModels(catalog);
      const report = validateModelConfig({
        provider: cfg.dsh?.provider,
        model: cfg.dsh?.model,
        fallbacks: cfg.dsh?.modelFallbacks,
        available
      });
      for (const warning of report.warnings) log(`⚠️ 模型配置校验：${warning}`);
      if (!report.checked) {
        log('模型配置校验跳过：读不到 DSH 的模型目录（DSH 未就绪或该版本没有 modelCatalog）');
        return;
      }
      if (report.ok) {
        log(`模型配置校验通过：${cfg.dsh?.provider}/${cfg.dsh?.model} 在可用清单里（共 ${available.length} 个模型）`);
        return;
      }
      if (report.effective) {
        const from = `${cfg.dsh?.provider}/${cfg.dsh?.model}`;
        cfg.dsh.provider = report.effective.provider || cfg.dsh.provider;
        cfg.dsh.model = report.effective.model;
        // 让已应用过模型的会话下一条消息重新 selectModel
        deps.modelSelectionEpoch += 1;
        log(`⚠️ 运行期主模型已回退：${from} → ${cfg.dsh.provider}/${cfg.dsh.model}（${report.effective.reason}）`);
        // 顺手写回 config.json（先备份）：否则每一轮都要先拿坏 id 试一次、失败、再降级，
        // 白付一次 RPC 延迟，日志里每轮刷两条。这是 2026-10-25 15:29:22 那条线上日志的成因。
        persistCorrectedModel(cfg.dsh.provider, cfg.dsh.model, from);
      } else {
        log('⚠️ 配置的模型不可用，且没有可回退的模型；selectModel 会失败，请立即检查 provider 注册表与 config.json');
      }
    } catch (error) {
      log(`模型配置校验跳过（读取模型目录失败）：${error?.message ?? error}`);
    }
  })();

  const collectors = new Map(); // sessionId -> turn collector
  let warnedPreSleepClamp = false;
  let localKeepAliveUntil = 0;
  const modelFallbackSkipLogged = new Set();
  // malformed tool-call JSON：按会话记重试次数（turn/start 清零），并累计总数供 /api/status 观测。
  const malformedRetries = new Map();
  // 每会话正在抽帧/转写的视频任务：prompt 组装前有限等待，避免首轮拿不到转写。
  const pendingVideoEnrich = new Map();
  const peakLocalQuota = new Map();
  let modelRouteLogged = '';
  // 跨会话摘要：每 N 条消息刷新一次（启发式、不调模型）；另外**按年龄兜底**——
  // 线上实测「每 20 条」会漏（group:100000008 摘要 8.6h 未刷，期间进了 34 条）：
  // digestCounters 只在真走 appendSocialV2Message 的路径 +1，回填/旁路进去的消息不计。
  // 所以条数到了 **或** 摘要超过 refreshMaxAgeMs（默认 2h）就重建；见 D34 诊断文档。
  const digestCounters = new Map();
  // @bridge-function maybeRefreshDigest from context-services // 「本轮为何选这个模型」的日志去重（每次切换打一次） // key -> {minuteStart,minute,hourStart,hour}（峰值本地回复限频） // key -> Set<stagedTask>（抽帧/转写两段）

  // ── 视频语音：常驻转写服务 + 迟到补发 ─────────────────────────────────────
  //
  // 为什么要有服务：CLI 每次调用都重新加载 whisper 模型（16s 视频冷启动 ~6s），
  // 而转写本身只要 1~2s。服务一次加载、反复使用；启不来/挂了都回退 CLI，功能不丢。
  // 为什么要有补发：本轮 prompt 最多等 6s，迟到 60s 的转写必须主动发回群里，
  // 否则用户得再问一次才能看到（27 号实测）。
  const sttService = createSttService({
    getConfig: () => ({
      ...(cfg.socialV2?.stt?.service || {}),
      python: String(cfg.socialV2?.stt?.python || "python")
    }),
    scriptPath: path.join(ROOT, "tools", "stt_server.py"),
    stateDir: STATE_DIR,
    log,
    cliTranscribe: (wav, opts = {}) => transcribeWav(wav, {
      python: String(cfg.socialV2?.stt?.python || "python"),
      script: path.join(ROOT, "tools", "stt_cli.py"),
      model: opts.model || String(cfg.socialV2?.stt?.videoModel || cfg.socialV2?.stt?.model || "small"),
      lang: opts.lang || String(cfg.socialV2?.stt?.lang || "zh"),
      timeoutMs: opts.timeoutMs
    })
  });
  // 已补发的视频 key（`${key}:${media.file||media.url}`）。持久化在 state/social-v2.json，
  // 重启后从文件恢复：否则桥接重启一次就会把同一段视频的转写再发一遍。
  const videoFollowUpSent = new Set();
  const videoFollowUpStore = {
    has: (sig) => videoFollowUpSent.has(String(sig ?? "")),
    add: (sig) => {
      const s = String(sig ?? "").trim();
      if (!s) return;
      videoFollowUpSent.delete(s); // 重新插入到末尾，淘汰最旧的
      videoFollowUpSent.add(s);
      while (videoFollowUpSent.size > 500) videoFollowUpSent.delete(videoFollowUpSent.values().next().value);
    },
    delete: (sig) => videoFollowUpSent.delete(String(sig ?? "")),
    clear: () => videoFollowUpSent.clear(),
    toArray: () => Array.from(videoFollowUpSent),
    get size() { return videoFollowUpSent.size; }
  };
  const videoFollowUps = createFollowUpHub({
    config: () => cfg.socialV2?.stt?.followUp || {},
    sentStore: videoFollowUpStore,
    persist: () => { try { saveSocialV2State(); } catch {} },
    // 走统一审计出口：转写里若真的出现路径/凭据特征，和模型回复一样被拦下。
    send: (key, text) => auditAndSend(key, text),
    log
  });
  /** 本轮 prompt 愿意等转写多久（默认 6s）：等不到就走「转写中」+ 主动补发。 */
  // @bridge-function sttInlineWaitMs from context-services
  // 退出时带走常驻转写服务子进程（否则桥接重启后留下一个孤儿 python 进程占内存）。
  process.once('exit', () => { try { sttService.stop(); } catch {} });

  let malformedToolJsonCount = 0;
  // 工具调用归因：sessionId -> 当前 turn 序号（turn/start 自增）。
  // tool-calls.jsonl 以前只有 sessionId，事后无法把一次工具调用对到具体某轮，
  // 排查「这轮调了几次工具/是不是重复调」只能靠时间猜。
  const turnSeqBySession = new Map();
  const currentTurnBySession = new Map();
  // 只用来抑制重复日志（不承载状态）：上限 200 条，最老的先出，见 noteBounded()。
  const modelAutoFallbackLogged = new Set();
  const MODEL_FALLBACK_LOG_MAX = 200;
  // 已知不可用的 provider/model（自动回退时登记）：用来跳过 modelForMedia / modelByKind
  // 里那些「配了但注册表里没有」的 id，避免**每个新会话**都先拿它失败一次。
  const knownUnavailableModels = new Set(); // 同一会话同一降级原因只报一次
  // video-frames 保留策略：每视频产一张约 1.1MB 的合成帧，以前**从不清理**（每天 10 条视频
  // 就是 10MB/天、300MB/月）。按年龄 + 总量清理；**只删 1 天以上的**，保护还在发送重试窗口内
  // 的活帧（msg.media.localFile 指向它）。删除失败只记数、不中断。
  // ── 视觉能力 ───────────────────────────────────────────────────────────
  // DSH 的模型目录里没有把 inputModalities 暴露给桥接，这里用一份**可配置的已知清单**兜底：
  // 不在清单里的模型，送图前就不再塞 image part，而是明确告诉模型「你看不到这张图」，
  // 并要求它如实告知用户 —— 降级到不支持视觉的模型时，绝不能让模型假装「我看到了」。
  // 证据（app.asar 里 DSH 自己的模型声明）：只有 deepseek-flash 声明了 inputModalities ["text","image"]；
  // v4.1-flash / v4-pro / glm-5.3 都没有。之前把 v4.1-flash 当"能看图"是错的 —— 会发出 image part，
  // 然后 DSH 抛 LlmError("... requires a vision model and attachment service", "UNSUPPORTED_CONTENT")。
  //
  // **实测复核（2026-10-25 19:4x，`node scripts/probe-vision.mjs`，6 个模型全探）**：
  //   ✅ deepseek-account/deepseek-flash       → 答「红色。」（2.9s）
  //   ❌ deepseek-account/deepseek-v4-pro      → session/attachment-invalid:
  //      Model "deepseek-v4-pro" does not support image input.  （其余 4 个同款拒绝）
  // 也就是**整个 catalog 里只有 deepseek-account/deepseek-flash 能看图**。
  // 探针的价值：DSH 的 session/modelCatalog 不返回 inputModalities，能力只能实发一张图试出来；
  // 且探针必须 unwrap prompt 的 RPC 结果，否则「立刻返回的拒绝」会被误读成「超时没回音」。
  const VISION_MODELS_DEFAULT = ['deepseek-flash'];
  // @bridge-function visionModels from context-services
  // @bridge-function modelSeesImages from context-services
  let warnedNoVision = '';
  // 最近出现过图/表情的会话（TTL 内）：「这一轮是不是含图轮」的权威依据之一。
  // 为什么不能只看 parts：reserved2 的图是模型调 qq_get_message_images 之后才回来的，
  // 选型发生在那之前（见 src/media-turn.js 头部注释）。
  const recentMediaTurns = new Map();
  /**
   * 记一次「这个会话最近出现过图」：内存 Map（快路径）+ 会话状态里的 lastMediaAt（重启后不丢）。
   *
   * 为什么必须持久化：23:39 重启后 2 分钟（23:42）用户又试了一张，机器人仍回「读不出来」——
   * 图片 23:41 到过，但标记只在旧进程的内存里，新进程的选型退回了空闲模型，
   * 模型再调 qq_get_message_images 时 DSH 只能把图换成
   * `[image unavailable: … deepseek-v4.1-flash does not declare image input]`。
   */
  // @bridge-function markMediaTurn from context-services

  // ── 好感度（M7-B 接线）：纯逻辑全在 src/affinity.js，这里只做 IO、限速与提示注入 ──
  // 三处接线：① 入站结算（appendSocialV2Message 末尾调 affinityNoteInbound）
  //          ② 被问时注入（deliverPromptNow 调 affinityPromptBlock）
  //          ③ 改分工具（POST /api/affinity/shift，硬限速由 shiftByModel 拦）
  const AFFINITY_FILE = path.join(STATE_DIR, 'affinity.json');
  let affinityStore = null;
  let affinitySaveTimer = null;
  const affinityAsked = new Map(); // key -> { userId, at }：这一轮被问过好感度
  // @bridge-function affinityRules from affinity-runtime
  // @bridge-function affinityOn from affinity-runtime
  // @bridge-function affinityLoad from affinity-runtime
  // @bridge-function affinityPersist from affinity-runtime
  // 每条消息都写盘会太吵（群里刷屏时每秒几十次）：合并 2 秒一次，进程退出前还有一次 saveState 兜底。
  // @bridge-function affinitySaveSoon from affinity-runtime
  /** ① 入站结算：每条入站消息攒证据（跨天/上限都在 affinity.js 里），不改 base。 */
  // @bridge-function affinityNoteInbound from affinity-runtime
  /**
   * 昵称解析（同步、只用缓存，绝不为了一个名字去发 OneBot 请求）：
   * 群的成员名片缓存 → 台账里记过的名字 → 本条消息的 sender → 同一个人历史消息的 sender。
   * 全部取不到返回 ''，由 describeForPrompt 退回 QQ 号。
   */
  // @bridge-function affinityNickname from affinity-runtime

  /**
   * 从记忆层挑 1~2 件和这个人有关的具体事：共享事件（qq_memory_event）优先，
   * 其次会话/全局印象标签（qq_memory_append 的 memberImpression）。只认 global 与本会话的 scope，
   * 别的群的事件不会外泄。返回空数组时 describeForPrompt 退回计数器描述。
   */
  // @bridge-function affinityMemories from affinity-runtime

  /** ② 被问时注入：命中 queryKeywords 才注入，≤300 字 + 隐私行，并记「本轮被问过」。 */
  // @bridge-function affinityPromptBlock from affinity-runtime
  // @bridge-function affinityAskedFresh from affinity-runtime
  /** ③ 改分：限速四条全在 shiftByModel 里拦，这里只补「本轮有没有这个人说话」。 */
  // @bridge-function affinityShift from affinity-runtime

  const FRAME_DIR = path.join(STATE_DIR, 'video-frames');
  // @bridge-function pruneVideoFrames from usage-runtime
  // 注意：这里**不能**同步调——pruneVideoFrames 会读 runtimeBindings 上指向本阶段自身（stRuntime）的
  // getter，同步调用时 stRuntime 还没赋值（TDZ），历史上真机启动会打一行
  // 「video-frames 清理失败：Cannot access 'stRuntime' before initialization」。延后一个宏任务再跑，
  // 那时 main() 已 attach 完本阶段。
  setTimeout(() => { try { pruneVideoFrames(); } catch {} }, 0);
  const frameTimer = setInterval(() => { try { pruneVideoFrames(); } catch {} }, 6 * 3600 * 1000);
  if (typeof frameTimer.unref === 'function') frameTimer.unref();

  // 媒体并发闸门（进程级单例，不是每会话）：上限与排队超时都可在 socialV2.media 里配。
  const mediaQueue = createMediaQueue({
    ...mediaQueueCfg(cfg.socialV2?.media),
    onLog: (m) => log(m)
  });
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // reserved2 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  const pendingWakeKeys = new Set();
  // key -> 开始等待的时间戳（带租约）：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起。
  // 存时间戳而不是单纯放进 Set，是因为 handler 中间任何异常都会跳过 finishWait ——
  // 那样这个 key 会被永远 429 掉（DSH 的 fetch 不会主动断开连接，req 'close' 也不会触发）。
  const activeWaits = new Map();
  /**
   * 单次等待的租约上限：正常等待最长 = timeout 预算 + 静默窗口 + 5s 余量，
   * 这里给足余量；超过就认为上一次是异常退出留下的残留，允许新的等待接管。
   */
  const ACTIVE_WAIT_LEASE_MS = 15 * 60 * 1000;
  /**
   * 回合判忙租约：只要 `turn/start` 的结束信号（turn/end）丢了，会话就会**永久**判忙，
   * 之后所有唤醒只进 pendingWakeReasons、QQ 上表现为「它不理我了」，只能重启（issue #11/#23/#26/#19）。
   * 正常回合 1~3 分钟，最长工具调用（DSH 的 toolCallTimeoutMs）≈12 分钟，15 分钟足以覆盖任何
   * **还活着**的回合。过期只是不再判忙：collector 本身保留，真回复照常 flush，只是允许新唤醒排队。
   */
  const TURN_BUSY_LEASE_MS = 15 * 60 * 1000;
  const turnLeaseNoted = new Set(); // 租约过期的日志去重（每个 session 只记一次）
  const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  const reverse = new Map(); // sessionId -> conv key
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  // 新版 DSH 事件流需要显式 follow；启动时为已持久化的 QQ 会话补上。
  for (const sessionId of Object.values(state.sessions)) api.events.follow(sessionId);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序

  return {
    get collectors() { return collectors; },
    get warnedPreSleepClamp() { return warnedPreSleepClamp; }, set warnedPreSleepClamp(v) { warnedPreSleepClamp = v; },
    get localKeepAliveUntil() { return localKeepAliveUntil; }, set localKeepAliveUntil(v) { localKeepAliveUntil = v; },
    get modelFallbackSkipLogged() { return modelFallbackSkipLogged; },
    get malformedRetries() { return malformedRetries; },
    get pendingVideoEnrich() { return pendingVideoEnrich; },
    get peakLocalQuota() { return peakLocalQuota; },
    get modelRouteLogged() { return modelRouteLogged; }, set modelRouteLogged(v) { modelRouteLogged = v; },
    get digestCounters() { return digestCounters; },
    get sttService() { return sttService; },
    get videoFollowUpSent() { return videoFollowUpSent; },
    get videoFollowUpStore() { return videoFollowUpStore; },
    get videoFollowUps() { return videoFollowUps; },
    get malformedToolJsonCount() { return malformedToolJsonCount; }, set malformedToolJsonCount(v) { malformedToolJsonCount = v; },
    get turnSeqBySession() { return turnSeqBySession; },
    get currentTurnBySession() { return currentTurnBySession; },
    get modelAutoFallbackLogged() { return modelAutoFallbackLogged; },
    get MODEL_FALLBACK_LOG_MAX() { return MODEL_FALLBACK_LOG_MAX; },
    get knownUnavailableModels() { return knownUnavailableModels; },
    get VISION_MODELS_DEFAULT() { return VISION_MODELS_DEFAULT; },
    get warnedNoVision() { return warnedNoVision; }, set warnedNoVision(v) { warnedNoVision = v; },
    get recentMediaTurns() { return recentMediaTurns; },
    get AFFINITY_FILE() { return AFFINITY_FILE; },
    get affinityStore() { return affinityStore; }, set affinityStore(v) { affinityStore = v; },
    get affinitySaveTimer() { return affinitySaveTimer; }, set affinitySaveTimer(v) { affinitySaveTimer = v; },
    get affinityAsked() { return affinityAsked; },
    get FRAME_DIR() { return FRAME_DIR; },
    get frameTimer() { return frameTimer; },
    get mediaQueue() { return mediaQueue; },
    get sendToolSucceededSessions() { return sendToolSucceededSessions; },
    get v2TurnStartAt() { return v2TurnStartAt; },
    get toolCallNames() { return toolCallNames; },
    get pendingSendToolCalls() { return pendingSendToolCalls; },
    get pendingWakeKeys() { return pendingWakeKeys; },
    get activeWaits() { return activeWaits; },
    get ACTIVE_WAIT_LEASE_MS() { return ACTIVE_WAIT_LEASE_MS; },
    get TURN_BUSY_LEASE_MS() { return TURN_BUSY_LEASE_MS; },
    get turnLeaseNoted() { return turnLeaseNoted; },
    get pendingWakeLeaseTimers() { return pendingWakeLeaseTimers; },
    get wakeConfigUpdatedKeys() { return wakeConfigUpdatedKeys; },
    get markReadCalledKeys() { return markReadCalledKeys; },
    get wakeConfigMissCount() { return wakeConfigMissCount; },
    get reverse() { return reverse; },
    get sessionPromises() { return sessionPromises; },
    get promptQueues() { return promptQueues; },
  };
}
