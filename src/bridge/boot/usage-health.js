// D62 装配阶段：令牌账本、DSH 就绪探测、模式切换与 prompt 队列。
// 纯搬运：语句顺序与拆分前 main() 一致；无 import，依赖全部由 deps 注入。
export function bootUsageLedger(deps) {
  const { TOKEN_USAGE_FILE, api, cfg, collectors, createTokenLedger, createDshUsageSync, createTurnCollector, deliverPrompt, learnerSessions, modeAllowed, pumpMux, resolvePriceTable, retireSession, reverse, slangLearnerSessionId, log } = deps;
  // ── Token 用量账本（控制台「令牌与花费」） ───────────────────────────────
  // 权威总量取 DSH 的 tokenUsage 投影（整条会话日志累计，含桥接启动前的历史），
  // 逐轮明细由 assistant/message 的 usage 折叠而来；花费在读取时按价目表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const tokenLedger = createTokenLedger({
    file: TOKEN_USAGE_FILE,
    log: (...args) => log(...args),
    priceTable,
    // 会话 → QQ 会话归属：学习会话单独记账，其余未知会话归入「未归属」。
    resolveKey: (sessionId) => reverse.get(sessionId)
      ?? (learnerSessions.has(sessionId) || (slangLearnerSessionId && sessionId === slangLearnerSessionId)
        ? 'internal:黑话学习'
        : undefined)
  });

  // DSH 桌面端自己开的窗口（Lead 窗口、临时对话）不进 agentTransport 事件流，账本自然收不到。
  // 每 5 分钟从 ~/.dsh/storages/session_projcache 补一次基线，否则「用量与花费」只显示机器人烧的钱。
  // 必须在进程内调 ingestBaseline：账本 compact() 会按内存态整文件重写，进程外追加的行会被抹掉。
  if (typeof createDshUsageSync === 'function') {
    try {
      createDshUsageSync({ ledger: tokenLedger, log }).start();
    } catch (e) {
      log(`[用量同步] 启动失败（不影响主流程）：${e && e.message ? e.message : e}`);
    }
  }

  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */
  const sessionModels = new Map();
  const nominalModel = () => cfg.dsh?.model || 'deepseek-flash';

  // @bridge-function rememberModel from usage-runtime

  /** 摄入一条会话事件到 token 账本；任何异常都不能影响 QQ 主链路。 */
  // @bridge-function recordSessionUsage from usage-runtime

  /**
   * 处理会话开场快照：
   * 1. `projections.tokenUsage` 是**整条会话日志**的权威累计桶（含桥接启动前的历史）；
   * 2. `records` 是最近若干条历史事件，用来回填「逐轮花费」。
   * 重连时该帧会重新下发，账本内部按 (turn, step, retry) + seq 做幂等折叠，不会翻倍。
   */
  // @bridge-function recordSessionSnapshot from usage-runtime

  /**
   * 重连后重建「断线时正在跑的那个回合」的 collector。
   *
   * 为什么必须有这一步：`pumpMux` 的 finally 会在断线时清空 `collectors`（否则重连后
   * 旧状态会让回复重复累加）。而重连时 DSH **只**通过开场快照重放历史 —— 快照被刻意
   * 排除在事件通道之外（否则历史回合会被当成新回合重复发送）。于是断线前发出的
   * `turn/start` 再也补不回来：重连后到达的 live `turn/end` 找不到对应回合，
   * `createTurnCollector.push()` 返回 null ⇒ **这一轮的回复被静默丢弃**（QQ 上没消息、
   * 日志里没记录、token 却照付）。
   *
   * 修法：只把「有 turn/start 但没有 turn/end」的回合重放进 collector ——
   * 这些正是断线那一刻仍在进行的回合。已结束的回合一律不喂，所以不会重复回复。
   */
  // @bridge-function rebuildInFlightCollector from usage-runtime

  // 唤醒“防卡死”租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了但一直没回合结束，
  // 30 分钟后强制解除 busy 标记，避免该会话永久无法被唤醒。
  // @bridge-function armPendingWakeLease from usage-runtime
  // @bridge-function disarmPendingWakeLease from usage-runtime
  // @bridge-function clearAllPendingWakeLeases from usage-runtime

  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  let dshReady = false;
  let dshCheckStarted = false;
  let snowlumaWatchStarted = false; // SnowLuma 上游健康探测只启动一次（见 startSnowlumaWatch）
  let currentMode = 'chat'; // chat | closed-agent | reserved（仿真模式，由 DSH settings / state/mode.json 驱动）
  let lastMode = currentMode;
  // closed-agent 模式使用的 DSH agent preset：留空表示「用 DSH 自己声明的默认 preset」。
  // 旧版本这里硬编码 'router-standard'，但 DSH 0.1.5 已移除该 preset，硬编码会导致
  // 创建出的会话挂不上 preset，进而被 DSH 套上 standard（含本地工具）。
  let closedAgentPreset = '';
  // DSH 侧真实的 preset 清单与默认 preset：旧版本这里是硬编码的 'router-standard'，
  // 但 DSH 0.1.5 已不存在该 preset，硬编码会让 closed-agent 模式永远挂不上 preset。
  let dshPresetIds = [];        // 当前 DSH 可用的 preset id 列表（agentPresets/list）
  let dshDefaultPreset = '';    // DSH settings `agent-presets.default`，取不到时用列表里的 isDefault
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）

  // reset 竞态导致 ensureSession 抛「会话创建期间已重置」时，把消息放回队列稍后重试。
  // 已在队列中的相同文本不重复入队。
  const enqueueForRetry = (key, promptText, opts = {}) => {
    const items = queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
    }
    queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { flushQueue(); }, 3000);
  };

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  // @bridge-function refreshMode from session-policy

  /** 拉取 DSH 当前可用的 agent preset 清单（供控制台下拉与 closed-agent 兜底使用）。 */
  // @bridge-function refreshPresetList from session-policy

  /** 当前模式是否允许该会话进入 */
  /** 只查白名单，不含 closed-agent / privateOpen 等放行规则。 */
  // @bridge-function whitelistedOnly from session-policy

  // @bridge-function modeAllowed from session-policy

  /**
   * 解析一个 preset 名。
   *
   * strict=false（closed-agent，仅 owner 私聊）：名字不可用时回退到 DSH 默认 preset ——
   *   那里本来就用完整工具面，回退不构成提权。
   * strict=true（chat / reserved / reserved2，会话可能属于 QQ 群）：名字不可用时返回 ''，
   *   表示「没有可安全使用的 preset」，由调用方拒绝建会话（fail-closed）。
   *   **绝不能回退到 DSH 默认 preset（standard）**：standard 含 bash/文件读写等本地工具，
   *   一旦套在群聊会话上，群友即可驱动一个能操作本机的 agent（见 RULES.md「无本地工具」）。
   */
  // @bridge-function resolvePresetName from session-policy

  /** 当前模式下的会话预设；返回 undefined 表示「该模式下没有可安全使用的 preset」 */
  // @bridge-function modePreset from session-policy

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */
  // @bridge-function isSessionAllowedInCurrentMode from session-policy

  // @bridge-function sessionPolicy from session-policy

  // @bridge-function isCurrentSession from session-policy

  /**
   * 让 DSH 停下一个已经不再属于桥接的会话：先清队列再取消在途 turn，最后归档。
   * 拆出来是因为所有「撤销映射」的路径都必须做同样的事（retireSession / session-reset /
   * workspace-reset / reset，以及控制台的二代状态重置）—— 少一处就会留下
   * 「DSH 还在烧 token、桥接已经收不到也发不出」的静默黑洞。
   */
  // @bridge-function stopRetiredSessionWork from session-policy

  /**
   * 清掉「按会话 key 记账」的内存态。
   *
   * 为什么单独抽出来：这些 Map/Set 分散在文件各处，退役路径（retireSession）、
   * 手动重置（/api/session/reset、/reset、workspace reset）、二代状态重置
   * 各自只清了其中一部分 —— 于是「哪个 key 清哪个不清」完全靠人记。
   * 结果是有界但真实的慢性泄漏：被移出白名单的会话，其 lastSendFailed、
   * 限流时间戳会一直留在内存里。所有撤销会话映射的路径都必须调用这里。
   */
  // @bridge-function forgetConversationCaches from session-policy

  // @bridge-function retireSession from session-policy

  // @bridge-function reconcileSessionPolicies from session-policy

  let flushingQueue = false;
  let flushQueueAgain = false;
  const flushQueue = async () => {
    // 尾沿重跑：单飞锁只是「别并发跑」，不能把后来的请求直接丢掉。
    // 旧写法在 flush 正在 await 时（一次失败可能卡上 60 秒）把重试定时器的调用直接 return，
    // 于是**再也没有人重新排一次 flush**，队列里的消息会一直躺到下次收到新消息为止。
    if (flushingQueue) { flushQueueAgain = true; return; }
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [key, items] of entries) {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!modeAllowed(key, kind, id, cfg, currentMode)) {
              log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);
              continue;
            }
            const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [], wakeReason: item.wakeReason });
            if (!result.ok) {
              log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              const rest = items.slice(i);
              const existing = queued.get(key) ?? [];
              queued.set(key, rest.concat(existing));
              break;
            }
            queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
        }
        log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (queueRetries.get(key) ?? 0) + 1;
          queueRetries.set(key, retries);
          if (retries > 5) {
            log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            setTimeout(() => {
              queueRetries.delete(key);
              flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            setTimeout(() => { flushQueue(); }, delay);
          }
        }
      }
    } finally {
      flushingQueue = false;
      if (flushQueueAgain) {
        flushQueueAgain = false;
        // 队列里还有东西才继续；用 setTimeout 让出一次事件循环，避免同步递归。
        if (queued.size > 0) setTimeout(() => { flushQueue(); }, 200);
      }
    }
  };
  return {
    get priceTable() { return priceTable; },
    get tokenLedger() { return tokenLedger; },
    get sessionModels() { return sessionModels; },
    get nominalModel() { return nominalModel; },
    get dshReady() { return dshReady; }, set dshReady(v) { dshReady = v; },
    get dshCheckStarted() { return dshCheckStarted; }, set dshCheckStarted(v) { dshCheckStarted = v; },
    get snowlumaWatchStarted() { return snowlumaWatchStarted; }, set snowlumaWatchStarted(v) { snowlumaWatchStarted = v; },
    get currentMode() { return currentMode; }, set currentMode(v) { currentMode = v; },
    get lastMode() { return lastMode; }, set lastMode(v) { lastMode = v; },
    get closedAgentPreset() { return closedAgentPreset; }, set closedAgentPreset(v) { closedAgentPreset = v; },
    get dshPresetIds() { return dshPresetIds; }, set dshPresetIds(v) { dshPresetIds = v; },
    get dshDefaultPreset() { return dshDefaultPreset; }, set dshDefaultPreset(v) { dshDefaultPreset = v; },
    get queued() { return queued; },
    get queuedHintAt() { return queuedHintAt; },
    get QUEUE_MAX() { return QUEUE_MAX; },
    get QUEUE_HINT_COOLDOWN_MS() { return QUEUE_HINT_COOLDOWN_MS; },
    get queueRetries() { return queueRetries; },
    get enqueueForRetry() { return enqueueForRetry; },
    get flushingQueue() { return flushingQueue; }, set flushingQueue(v) { flushingQueue = v; },
    get flushQueueAgain() { return flushQueueAgain; }, set flushQueueAgain(v) { flushQueueAgain = v; },
    get flushQueue() { return flushQueue; },
  };
}

// D62 装配阶段：SnowLuma 上游健康视图（连上了 ≠ 收得到）。
// 纯搬运：语句顺序与拆分前 main() 一致；无 import，依赖全部由 deps 注入。
export function bootUpstreamHealth(deps) {
  // 注意：dshReady / currentMode / lastMode / dshPresetIds 是**跨阶段共享可变状态**，
  // 必须经 deps 读写（getter/setter 才是活绑，解构成 const 会 ①赋值 TypeError ②读到陈旧快照）。
  const { slangWindows, api, cfg, cleanupSocialForModeChange, clearAllSocialV2Timers, drainAllPromptQueues, flushQueue, maybeQueueSlangExtraction, reconcileSessionPolicies, refreshMode, refreshPresetList, scheduleProactiveCheckV2, setupSleepTimerV2, log } = deps;
  const checkDsh = async () => {
    let ok = false;
    try {
      await api.settings.describe({});
      ok = true;
    } catch {}
    if (ok) {
      await refreshMode();
      // DSH 起来后拉一次 preset 清单；DSH 重启（dshReady 由 false 变 true）时再拉一次。
      if (!deps.dshReady || deps.dshPresetIds.length === 0) {
        try { await refreshPresetList(); } catch {}
      }
      reconcileSessionPolicies();
      if (!deps.dshReady) {
        deps.dshReady = true;
        deps.lastMode = deps.currentMode;
        log(`DSH 已就绪（模式: ${deps.currentMode}）`);
        if (deps.currentMode === 'reserved2') {
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of deps.socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
        }
        try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        for (const key of [...slangWindows.keys()]) maybeQueueSlangExtraction(key);
      } else if (deps.currentMode !== deps.lastMode) {
        if (deps.lastMode === 'reserved' && deps.currentMode !== 'reserved') {
          cleanupSocialForModeChange();
          log('桥接模式已离开一代仿真模式，清理社交状态');
        }
        if (deps.lastMode === 'reserved2' && deps.currentMode !== 'reserved2') {
          clearAllSocialV2Timers();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (deps.currentMode === 'reserved2' && deps.lastMode !== 'reserved2') {
          for (const key of deps.socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
        }
        log(`桥接模式已切换为: ${deps.currentMode}`);
        deps.lastMode = deps.currentMode;
      }
    } else if (deps.dshReady) {
      deps.dshReady = false;
      log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
    }
  };
  // @bridge-function startDshWatch from upstream-health

  // ── SnowLuma 上游健康：**连上了 ≠ 收得到** ──────────────────────────────────
  //
  // 为什么必须有这一段（这是一个真实存在的、被误诊过的失败形态）：
  // SnowLuma 用原生组件（`native/snowluma-win32-x64.{dll,node}`）挂进 QQ 客户端进程
  // 才能拿到消息，它自己的日志里管这层叫 `[Hook]`。这层会退化：
  //     WARN [Hook] receive path stale: ... silentFor=136193ms; reporting good=false
  // 而 **SnowLuma 进程与它的 OneBot WebSocket 都还活着**。于是桥接这边一切正常：
  // WebSocket 是通的、`bot.on('open')` 打过「SnowLuma 已连接」，控制台没有任何异常，
  // 但群里一条消息都不来 —— 运维看到的现象是「接了但没反应」，而**没有任何证据指向
  // SnowLuma 的 hook**，于是被报成「qq-bridge 注入失败」。
  //
  // 桥接本身**不可能**造成这种失败：它没有任何原生/注入面（依赖全纯 JS，源码里
  // 没有 .dll/.node/FFI/进程注入），也不启动、不控制 SnowLuma 与 QQ。它能做、也应该做的
  // 是**把这个失败变得可诊断**。
  //
  // 信号从哪来（**两处都实测核对过 SnowLuma 1.14.9 的运行时源码，别凭直觉改**）：
  //
  //   ① **心跳载荷里的 `status.good`** —— 权威信号，且是免费的。
  //      SnowLuma 每 30s 由**自己的定时器无条件**发一个 heartbeat
  //      （`index.mjs` 的 `HEARTBEAT_INTERVAL = 3e4` / `startHeartbeat()`），
  //      载荷里带 `status: { online, good: online && bridge.receiveHealthy }`。
  //      `receiveHealthy` 是它**对「QQ → hook → 我」这条接收链路**的自评，
  //      静默约 105s 就翻 false。所以：读心跳里的 good 就等于拿到了 hook 的健康度。
  //      ⚠️ 注意它**不经过** QQ 事件流水线 —— 心跳是本地生成的，所以"没有事件包"
  //      **不能**用来判断 hook 死活（见下方 ② 的措辞）。
  //
  //   ② `get_status` 的 `good`/`online` —— 与 ① 同源，用于①长期收不到时的兜底轮询。
  //      ⚠️ **不要用 `get_login_info` 取 good**：它只返回 `{ user_id, nickname }`。
  //      取错字段不会报错（SDK 只校验 status/retcode 信封，不校验 data 载荷），
  //      good 会永远停在 null —— 本文件第一版就是这么写的，等于权威信号整条是死代码。
  //      `src/mcp-snowluma-safe.js` 的 snowluma_status 工具是对的取法（get_login_info
  //      拿昵称 + get_status 拿 online/good），可对照。
  //
  //   ③ `bot_status`（账号会话上下线）—— SnowLuma 1.14.17 起才有，老运行时永不触发，
  //      所以只是加分项，不能作为唯一依据。
  //
  //   ④ 「距最近一个事件包的时长」—— 只能证明**SnowLuma 进程与 WS 链路还活着**，
  //      **不能**证明 hook 收得到 QQ 数据（心跳会一直来）。所以它只作为兜底提示，
  //      阈值取很宽，措辞必须留余地。
  const SNOWLUMA_STATUS_POLL_MS = 60_000;
  const SNOWLUMA_SILENCE_WARN_MS = Math.max(60_000, Number(cfg.snowluma?.silenceWarnMs) || 10 * 60_000);
  const snowlumaHealth = {
    lastPacketAt: 0,      // 最近一个来自 SnowLuma 的事件包（含 meta/心跳）
    lastPacketKind: '',
    accountOnline: null,  // bot_status 的 online/offline（需要较新的 SnowLuma 运行时）
    good: null,           // 接收链路健康度：来自心跳 status.good / get_status.good
    goodSource: '',       // 'heartbeat' | 'get_status' —— 便于诊断"这条判断从哪来"
    goodError: '',
    goodCheckedAt: 0,
    degraded: false,      // 当前是否处于"已告警"状态（边沿触发，避免刷屏）
    reason: '',
  };

  /** 记录一次"上游还活着"的证据。任何来自 SnowLuma 的事件包都算（含心跳）。 */
  // @bridge-function noteUpstreamPacket from upstream-health

  /** 记下一次接收链路健康度。@param good - boolean；非布尔值忽略。 */
  // @bridge-function noteReceiveHealth from upstream-health

  /** 供 /api/status 与控制台使用的只读快照。 */
  // @bridge-function snowlumaHealthSnapshot from upstream-health

  /** 边沿触发地告警/恢复，避免每轮探测都刷一行日志。 */
  // @bridge-function reportSnowlumaHealth from upstream-health

  /**
   * 问一次 SnowLuma 的 `get_status`：账号在不在线、它自评的接收链路是否健康。
   *
   * ⚠️ 必须用 `get_status` —— `get_login_info` 只返回 `{ user_id, nickname }`，
   *    从它身上取 good 会永远拿到 undefined（而且不会报错，见上方长注释）。
   *    这里只是**兜底轮询**：主路径是每 30 秒一次的心跳（免费，见 onEvent）。
   */
  // @bridge-function pollSnowlumaStatus from upstream-health

  // @bridge-function startSnowlumaWatch from upstream-health

  return {
    get checkDsh() { return checkDsh; },
    get SNOWLUMA_STATUS_POLL_MS() { return SNOWLUMA_STATUS_POLL_MS; },
    get SNOWLUMA_SILENCE_WARN_MS() { return SNOWLUMA_SILENCE_WARN_MS; },
    get snowlumaHealth() { return snowlumaHealth; },
  };
}
