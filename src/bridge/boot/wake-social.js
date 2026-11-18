// D62 装配阶段：prompt 投递/社交调度、角色提示、跨群认人、唤醒调度。
// 纯搬运：语句顺序与拆分前 main() 一致；无 import，依赖全部由 deps 注入。
export function bootSocialWake(deps) {
  const { TOOL_LOG_FILE, cfg, loadInitialPrompts, loadSocialV2State, startSocialLoop, createCappedLogger } = deps;
  // @bridge-function getInitialPrompt from initial-prompts

  /**
   * 保存/删除一份初始提示词。空内容 = 删除。
   * 写入失败时把内存改动回滚，保证「接口说失败」与「内存里确实没变」一致。
   * @returns {{ok: boolean, statusCode?: number, error?: string, key?: string, deleted?: boolean, chars?: number, entry?: object|null}}
   */
  // @bridge-function setInitialPrompt from initial-prompts

  /**
   * 首次唤醒时插入的环境段；没有配置就返回空串（不影响原有 prompt）。
   * 超长内容按上限截断后注入（文件可能被手工改过），并在截断处留省略号。
   */
  // @bridge-function formatInitialPromptV2 from initial-prompts

  // @bridge-function formatParticipationV2 from memory-prompt

  // @bridge-function suggestQuietMsV2 from memory-prompt

  /** 记忆层注入：跨会话印象 + 近期共同经历（合计受 700 字预算约束）。 */
  // @bridge-function buildSharedMemoryLine from memory-prompt

  // @bridge-function formatMemoryV2 from memory-prompt

  // @bridge-function appendMemoryV2 from memory-prompt

  loadSocialV2State();
  // 操作者预写的会话初始提示词（与控制台入口同样在 main() 里；损坏时只读降级，不阻塞启动）。
  loadInitialPrompts();

  // @bridge-function isSocialEnabled from social-runtime

  // @bridge-function socialState from social-runtime

  // 启动阶段的"明确与 AI 有关"：@ / 提到名字 / 必回关键词 / 管理员私聊
  // @bridge-function isDirectAddress from social-runtime

  // 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促
  // @bridge-function isDirectedAtAi from social-runtime

  // 活跃期批量检测用的"必须回"判断：不依赖 event，只认昵称/关键词/直接针对 AI 的提问
  // @bridge-function isMustReplyText from social-runtime

  // @bridge-function appendRecentMessage from social-runtime

  // @bridge-function appendSummary from social-runtime

  // @bridge-function buildContextBlock from social-runtime

  // 触发进入活跃（启动阶段 → 活跃阶段）
  // @bridge-function enterActive from social-runtime

  // @bridge-function cancelSocialTimers from social-runtime

  // @bridge-function cancelAllSocialTimers from social-runtime

  // 离开仿真模式时清理全部社交运行时状态，避免旧定时器/状态残留。
  // @bridge-function cleanupSocialForModeChange from social-runtime

  // @bridge-function leaveActive from social-runtime

  // 活跃阶段：只贴"没给过 AI 的新消息"（上下文在会话历史里，不重复贴，不贴人格）
  // allowSilent=false 表示这条必须回（被 @/点名/私聊等），不提供 [SILENT] 出口。
  // @bridge-function buildBatchPrompt from social-runtime

  // 冷场试探：让 AI 基于会话自然说一句（只给状态背景，不注入"试探"意图）
  // @bridge-function buildProbePrompt from social-runtime

  // 活跃超时退场：让 AI 自然地说一句收尾/潜水话，说完后安静下来。
  // 只给“该收尾了”的暗示，不暴露桥接的计时机制。
  // @bridge-function buildActiveExitPrompt from social-runtime

  // 活跃超时判定：到达进入活跃时随机出的最长时间后，安排一次“收尾退场”投递，
  // 并把状态切到 exiting（退场中），等待 AI 的退场发言完成后再回到观望。
  // @bridge-function triggerActiveDurationExit from social-runtime

  // 二期：观望阶段主动开话题（第三种触发）
  // @bridge-function buildProactivePrompt from social-runtime

  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  // @bridge-function deliverPromptNow from prompt-delivery

  // 每个 QQ 会话串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记都能准确匹配到自己的 turn。
  // 降级后「本轮重试一次」需要原文重投；按 key 记住最近一次投递的 prompt。
  const lastPromptByKey = new Map();
  const retriedAfterFallback = new Set(); // sessionId：本 turn 已重试过

  // 网关取图缓存：同一张图在同一条消息里可能被解析多次（快照压缩句柄 + /api/images/message），
  // 每次都打一次网关既慢又白烧配额（test-token-economy 实测同一文件被抓 3 次）。
  const imageInfoCache = new Map(); // file -> { at, info }
  const IMAGE_INFO_TTL_MS = 10 * 60 * 1000;
  const IMAGE_INFO_MAX = 50;
  // @bridge-function getImageCached from prompt-delivery

  // @bridge-function deliverPrompt from prompt-delivery

  // @bridge-function processPromptQueue from prompt-delivery

  // @bridge-function scheduleSocialReply from social-scheduler

  // 全局扫描：驱动观望期主动开话题、活跃期检测、冷场处理、试探回退
  // @bridge-function socialLoopTick from social-scheduler

  // @bridge-function startSocialLoop from social-scheduler

  // @bridge-function flushSummaries from social-scheduler

  // 旧写法是 `isSocialEnabled() || cfg.social?.enabled !== false` —— 恒等于右边那一项
  // （isSocialEnabled() 本身就蕴含 cfg.social?.enabled !== false，左侧永远不可能单独为真），
  // 留着只会让人误以为"reserved 模式下才启动循环"。这里启动的只是一个 5 秒心跳，
  // 每跳自己会用 isSocialEnabled() 判断当前模式（见 socialLoopTick 第一行）；
  // 真正决定启不启动的只有配置里的显式关闭开关。
  if (cfg.social?.enabled !== false) {
    startSocialLoop();
  }

  // 当前角色扮演提示：读 state/current-role.json + roles/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // 缓存 key 为两个文件的 mtime，mtime 未变时直接返回，避免每次同步读文件。
  let roleHintCache = { key: '', raw: '' };
  // 原始人格卡（按 mtime 缓存，不截断）。
  // @bridge-function roleRawContent from role-prompts
  // 按仿真模式取用：先用标题里的 〔一代〕/〔二代〕 标记筛掉另一模式的专属小节，
  // **再**按上限截断——这样另一模式的内容不会白白占掉本次的注入预算。
  // @bridge-function roleHintForMode from role-prompts
  // @bridge-function currentRoleHint from role-prompts

  // 二代仿真模式专用角色提示：去掉一代的 [SILENT] / 空格分句等状态机指令，避免与工具协议冲突。
  // 为了不削减原角色卡内容，示例节不整体删除，而是把“用空格分条”的示范改写成“用逗号表示停顿”，
  // 让二代 AI 既保留原有人格示例，又不会照抄单条消息里的中文空格。
  // @bridge-function isCjkLikeChar from role-prompts

  // 仅用于二代角色卡“回复示例”节：把示例里用于分条的中文空格改写成中文逗号。
  // 空格两侧只要有一侧是中文/中文标点，且另一侧不是 / \ ( ) [ ] { } " ' < > | 等符号，就转成逗号。
  // 这样能保留示例内容，同时避免把英文/URL/斜杠周围的空间改坏。
  // @bridge-function convertExampleSpacesToComma from role-prompts

  // 检测二代发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
  // 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
  // @bridge-function findCjkSpaceWarning from role-prompts

  // 检测二代发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
  // 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
  // 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
  // @bridge-function findSplitBoundaryWarning from role-prompts

  // @bridge-function currentRoleHintV2 from role-prompts

  // QQ 群成员名片/昵称缓存：@ 段解析用，避免每条消息都调一次 OneBot API。
  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
  // @bridge-function pruneGroupMemberNameCache from people-runtime
  // ── 跨群认人（D42）：人物档案 + 命中才召回 ────────────────────────────────
  // 开关：socialV2.memory.people.enabled（默认 false）。关着时既不记录也不注入 —— prompt 完全不变。
  // 档案 state/people.json 只在开启后生成；读坏/写失败一律当空档案，不影响聊天。
  let peopleStoreCache = null;
  let peopleInitDone = false;
  let peopleSavedAt = 0;
  let peopleLogAt = 0;
  // @bridge-function peopleOptions from people-runtime
  // @bridge-function peopleEnabled from people-runtime
  // @bridge-function peopleLoad from people-runtime
  // @bridge-function peopleSaveNow from people-runtime
  /** 台账里记过的名字（常常是空字符串；空就不补，别把号码或空名当别名）。 */
  // @bridge-function peopleLedgerName from people-runtime
  /**
   * 首次用到时回填：把现有消息/台账变成档案。
   * 为什么必须回填：真机断片时，人已经在上百条历史消息里了；只从「开启之后的新消息」学，
   * 用户重启后再问一次仍然会答「不认识」。
   * persist=false：只读路径（prompt 召回/调试）不许写盘，等下一次真实入站再落盘。
   */
  // @bridge-function peopleEnsureReady from people-runtime
  /** 每条入站记一笔：sender 名 + 群名片缓存 + 台账名，全都进别名索引。 */
  // @bridge-function peopleNoteInbound from people-runtime
  /** 印象只读 memory_append 的真源（global + 本会话的 memberImpression），不另存一份。 */
  // @bridge-function peopleImpressionsFor from people-runtime
  /** 召回一段「认人」提示；没命中返回 ''（一个字都不注入，prompt 总长不变）。 */
  // @bridge-function peopleRecallLine from people-runtime

  // 群成员集合缓存：用于「拍一拍目标必须是本群成员」的校验。
  // 不校验的话，群友只要让 AI 传一个任意 QQ 号，桥接就会向网关发 group_poke，
  // 等于把机器人账号变成任意 QQ 号的探测/骚扰工具（工具描述里承诺了白名单约束）。
  const groupMemberIdsCache = new Map(); // groupId -> { ids:Set<string>, ts }
  const GROUP_MEMBER_IDS_TTL_MS = 60 * 1000;
  // @bridge-function assertGroupMember from reply-resolution

  // @bridge-function resolveGroupMemberName from reply-resolution

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  // @bridge-function pruneReplyInfoCache from reply-resolution
  // @bridge-function resolveReplyInfo from reply-resolution

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  // @bridge-function resolveReplyTargetV2 from reply-resolution

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  // @bridge-function isQuoteTargetSelf from reply-resolution

  // ── 二代仿真模式（reserved2）唤醒调度 ──────────────────────────────────
  // @bridge-function appendSocialV2Message from message-state

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  // @bridge-function appendSocialV2Poke from message-state

  // @bridge-function recordSentMessagesV2 from message-state

  // @bridge-function readFeedbackEntries from tool-journal

  // @bridge-function appendFeedbackEntry from tool-journal

  // @bridge-function readToolLog from tool-journal

  const appendToolLogFile = createCappedLogger(TOOL_LOG_FILE, 2000);

  // @bridge-function appendToolLog from tool-journal

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  // @bridge-function redactSensitive from tool-journal

  // @bridge-function sanitizeToolArgs from tool-journal

  // @bridge-function evaluateWakeTriggerV2 from wake-admission

  // Only messages actually offered to the model authorize cursor-based acknowledgement.
  // Keep this receipt in memory: after a restart the model must fetch unread again.
  // @bridge-function readThroughSeqV2 from wake-admission

  // @bridge-function noteModelMessagesV2 from wake-admission

  // @bridge-function requestedReadThroughSeqV2 from wake-admission

  // @bridge-function acknowledgeMessagesV2 from wake-admission

  // ── 时间观念（沉睡后醒来最容易犯的错） ────────────────────────────────────
  return {
    get lastPromptByKey() { return lastPromptByKey; },
    get retriedAfterFallback() { return retriedAfterFallback; },
    get imageInfoCache() { return imageInfoCache; },
    get IMAGE_INFO_TTL_MS() { return IMAGE_INFO_TTL_MS; },
    get IMAGE_INFO_MAX() { return IMAGE_INFO_MAX; },
    get roleHintCache() { return roleHintCache; }, set roleHintCache(v) { roleHintCache = v; },
    get groupMemberNameCache() { return groupMemberNameCache; },
    get GROUP_MEMBER_NAME_TTL_MS() { return GROUP_MEMBER_NAME_TTL_MS; },
    get peopleStoreCache() { return peopleStoreCache; }, set peopleStoreCache(v) { peopleStoreCache = v; },
    get peopleInitDone() { return peopleInitDone; }, set peopleInitDone(v) { peopleInitDone = v; },
    get peopleSavedAt() { return peopleSavedAt; }, set peopleSavedAt(v) { peopleSavedAt = v; },
    get peopleLogAt() { return peopleLogAt; }, set peopleLogAt(v) { peopleLogAt = v; },
    get groupMemberIdsCache() { return groupMemberIdsCache; },
    get GROUP_MEMBER_IDS_TTL_MS() { return GROUP_MEMBER_IDS_TTL_MS; },
    get replyInfoCache() { return replyInfoCache; },
    get REPLY_INFO_TTL_MS() { return REPLY_INFO_TTL_MS; },
    get REPLY_NEGATIVE_TTL_MS() { return REPLY_NEGATIVE_TTL_MS; },
    get appendToolLogFile() { return appendToolLogFile; },
    get SENSITIVE_ARG_KEYS() { return SENSITIVE_ARG_KEYS; },
  };
}

// D62 装配阶段：时间观念（沉睡后醒来）、prompt 分段快照。
// 纯搬运：语句顺序与拆分前 main() 一致；无 import，依赖全部由 deps 注入。
export function bootTimeSense(deps) {
  const { takeHandoffDigest, timeSenseCfg } = deps;
  //
  // 现象（操作者报告 + 会话实证）：AI 沉睡很久后被唤醒，看到一小时前的话仍然当成"刚发的"去接，
  // 甚至抢进早已散场的话题。根因有两层：
  //   ① 模型看到的时间是裸 epoch（`time: 1792294529471`），它根本算不出"这是 38 分钟前"
  //      → 已由 qq-model-view.js 换成 `at`/`ago`；
  //   ② 提示词里**没有任何一条规则**告诉它"旧消息不该按实时对话接"。
  // 这里补第二层：把「现在 / 最新一条多旧 / 唤醒原因那条多旧」算好直接写进去，并给分档规则。
  // 阈值可调（config.json 的 socialV2.wake.staleChatMinutes / staleSilentMinutes）。
  const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

  /** 本地 HH:MM（与消息 at 字段同一口径）。 */
  // @bridge-function localClockText from wake-prompts

  // @bridge-function timeSenseCfg from wake-prompts

  /** 唤醒原因里带的本地 seq（形如 `atMention@seq194`），没有就 null。 */
  // @bridge-function wakeReasonSeq from wake-prompts

  // @bridge-function findV2MessageBySeq from wake-prompts

  /**
   * 【时间感】规则块。没有可判断的消息时返回空串（引导/定时唤醒不必背这段）。
   *
   * 注意阈值必须和 §timeSenseCfg 一致，否则模型会看到自相矛盾的两档。
   */
  // @bridge-function buildTimeSenseLine from wake-prompts

  // @bridge-function buildWakeSnapshotV2 from wake-prompts

  // @bridge-function replyTimingV2 from wake-prompts

  // 机器人自己的身份（昵称 + QQ 号）。**必须显式写进 prompt**：
  // agent 能看到的消息里只有 "@樰" 这串文本，没人告诉它"樰"就是它自己，于是它会把
  // @自己 当成 @别人、已读不回（issue #29）。群名片可能与昵称不同，但 at/引用段里
  // 带的是 QQ 号，所以两条都给。
  // @bridge-function selfIdentityTextV2 from wake-prompts

  // D39：入站命中「要我换人设」的会话标记（key -> { at, kind }）。
  // 出站时若模型没提 /persona，桥接自动补一句；同一会话 10 分钟内只补一次。
  const personaGuidePending = new Map();
  const personaGuideCooldown = new Map();  // key -> 上次补句时间
  const personaSeenRequests = new Map();   // 指纹 -> 上次命中时间（同一人重复粘贴去重）
  // @bridge-function personaGuideOnCooldown from wake-prompts
  /** 入站检测命中后调用：会话冷却 / 已有待补 / 同一人重复粘贴，都直接忽略。 */
  // @bridge-function notePersonaRequest from wake-prompts

  // ── prompt 分段快照（/api/debug/prompt-parts 用）────────────────────────────
  // 为什么按 key 存：以前只有一个进程内全局 `__dshPromptParts`，谁最后构建就是谁——
  // 查 A 群返回 B 群的分段，重启后又归零（"假红"），主窗口据此误判过功能没上线（D38）。
  // 表本身在模块级（见 PROMPT_PARTS_SNAPSHOT_MAX 附近），这里只放写入 helper。
  // @bridge-function notePromptPartsSnapshot from wake-prompts

  /**
   * 构建唤醒提示词。
   * @param {string} key
   * @param {string} reason 唤醒原因（bootstrap/timeout/replyCheck/poke/…；调试传 'debug'）
   * @param {{dryRun?: boolean, capture?: object}} [opts]
   *   dryRun=true：只构建、不落任何快照，且**跳过 bootstrap 专属段**（初始提示词 / 交接摘要）。
   *   调试路径必须用它：initialPrompt 只在首次唤醒注入，handoff 会被 takeHandoffDigest 消费掉，
   *   让一次只读调试把真实交接摘要吃掉就是事故。
   *   capture 传一个对象，parts 会写进 capture.parts。
   */
  // @bridge-function buildWakePromptV2 from wake-prompts

  // @bridge-function buildWakeReminderPromptV2 from wake-prompts

  // @bridge-function sendWakePromptV2 from wake-dispatch

  // @bridge-function cancelReplyCheckV2 from wake-scheduler

  // @bridge-function scheduleReplyCheckV2 from wake-scheduler

  /** 会话此刻算忙的具体原因（只用于日志，避免排查时只能反复重启加猜）。 */
  // @bridge-function busyReasonV2 from wake-scheduler

  // @bridge-function isConversationBusyV2 from wake-scheduler

  const WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    anyMessage: 50,
    replyCheck: 40,
    timeout: 30,
    proactiveCheck: 20,
    glance: 10
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  // @bridge-function wakePriorityV2 from wake-scheduler

  // 与「未读消息」无关的唤醒原因（定时器/引导）。这些原因在会话繁忙时被暂存后，
  // 不能用「unread 里还有没有对应 seq」来判断是否还要补发 —— 那一轮很可能已经把
  // 未读全部标读了，结果就是 timeout 定时器被静默丢掉、会话停在无定时器的静默态。
  // glance 是「抬眼」：静默观战自己排的随机机会，同样与未读水位无关，按定时类处理。
  const TIMER_WAKE_REASONS = new Set(['timeout', 'replyCheck', 'proactiveCheck', 'glance', 'bootstrap', 'admin']);
  // @bridge-function isTimerWakeReason from wake-scheduler

  // @bridge-function scheduleWakeV2 from wake-scheduler

  /**
   * 回合结束后补发「繁忙期间暂存」的唤醒原因。
   *
   * 两类原因必须分开处理：
   *   · 消息类（@/关键词/提问/私聊/拍一拍…）只有在那条消息还没被本回合处理掉时才补发
   *     （unread 里还能找到它的 seq）；
   *   · 定时器类（timeout/replyCheck/proactiveCheck/bootstrap/admin）与未读水位无关：
   *     那一轮很可能已经把未读全部标读，用 unread 判断会让「到点唤醒」被静默吞掉 ——
   *     timeout 时 sleepTimer 已被清空，结果是会话停在「sleepUntil 已过期、无任何定时器」。
   */
  // @bridge-function replayPendingWakeReasonsV2 from wake-scheduler

  // @bridge-function setupSleepTimerV2 from wake-scheduler

  // @bridge-function cancelProactiveCheckV2 from wake-scheduler

  // @bridge-function scheduleProactiveCheckV2 from wake-scheduler

  // @bridge-function clearSocialV2Timers from wake-scheduler

  // @bridge-function clearAllSocialV2Timers from wake-scheduler

  // @bridge-function drainPromptQueue from prompt-queues

  // @bridge-function drainAllPromptQueues from prompt-queues

  // QQ 消息 → DSH prompt
  // 陌生人私聊的礼貌回复节流：同一个 QQ 每小时最多回一次，避免刷屏。
  const unauthorizedPrivateRepliedAt = new Map();

  // 白名单群的成员 → 自动获得私聊通行证（每 10 分钟刷新成员表）。
  const groupMemberCache = new Map();
  let groupMemberRefreshedAt = 0;

  // @bridge-function refreshGroupMembers from private-quota-runtime

  // @bridge-function isGroupMember from private-quota-runtime

  /** 私聊临时通行证：allow.privateOpen=true 时所有人可私聊，非白名单受每日额度限制。 */
  // @bridge-function privateQuotaCfg from private-quota-runtime

  // @bridge-function quotaLoad from private-quota-runtime

  // @bridge-function quotaSave from private-quota-runtime

  /**
   * 检查并累计某个陌生人的私聊额度。
   * @returns {{ blocked: boolean, leftMs: number, justWarned: boolean }}
   */
  // @bridge-function consumePrivateQuota from private-quota-runtime

  /** 查某人的今日额度（不累计、只读）。 */
  // @bridge-function quotaInfo from private-quota-runtime

  // ── 高峰期暂停：默认 12:00-14:00、18:00-22:00 暂停群聊（私聊不受影响） ──
  return {
    get pad2() { return pad2; },
    get personaGuidePending() { return personaGuidePending; },
    get personaGuideCooldown() { return personaGuideCooldown; },
    get personaSeenRequests() { return personaSeenRequests; },
    get WAKE_PRIORITY() { return WAKE_PRIORITY; },
    get TIMER_WAKE_REASONS() { return TIMER_WAKE_REASONS; },
    get unauthorizedPrivateRepliedAt() { return unauthorizedPrivateRepliedAt; },
    get groupMemberCache() { return groupMemberCache; },
    get groupMemberRefreshedAt() { return groupMemberRefreshedAt; }, set groupMemberRefreshedAt(v) { groupMemberRefreshedAt = v; },
  };
}

// D62 装配阶段：高峰期暂停/本地接管、群管理指令、文件转存、配置热加载、BOOTH、观察学习。
// 纯搬运：语句顺序与拆分前 main() 一致；无 import，依赖全部由 deps 注入。
export function bootPeakArchive(deps) {
  const { STATE_DIR, collectors, fs, path, state } = deps;
  let peakPauseLogged = false;
  // @bridge-function peakCfg from peak-runtime
  // @bridge-function minutesOf from peak-runtime
  // @bridge-function localDateStr from peak-runtime
  // 高峰 = 工作日（周一至周五，节假日除外，调休补班算工作日）且落在配置时段内。
  // @bridge-function inPeakWindow from peak-runtime
  // enabled 是总开关：关掉就立刻恢复群聊；schedule 只在 enabled 打开时用来「限定只在时段内暂停」。
  // 旧实现是 `enabled || (schedule && inPeakWindow())`：控制台把开关拨到「关」也没用，
  // 只要 schedule=true 且落在 09:00-12:00/14:00-18:00，群聊就继续被暂停 —— 实测 09:42 群里
  // @机器人没反应、私聊正常，就是这条（/api/peak/status 显示 enabled=false 但 active=true）。
  // @bridge-function peakPauseActive from peak-runtime

  // ── 高峰期本地小模型接管（仅群主/管理员，且必须叫机器人）────────────────
  // 高峰期原本直接 return：管理员 @ 也没人理。现在把这类消息交给 ollama 的 qwen3:8b，
  // 不走 DSH/API；非管理员照旧静默。配置：socialV2.peakPause.localModel。
  const peakLocalStats = { recent: [], lastText: '', lastAt: 0 }; // recent: [{ at, ms }]
  const peakLocalLastAt = new Map();
  const peakLocalRecentTexts = new Map();
  const peakLocalBuckets = new Map();
  // @bridge-function peakLocalBucket from peak-runtime
  // 高峰期改用「agent + 便宜模型」：只有这样才能保留识图/发语音/画画/摸头这些工具，
  // 纯直连 API 的小模型没有任何工具。闸门（@/问句/概率 + 冷却 + 上限）仍然生效。
  // @bridge-function peakAgentCfg from peak-runtime
  const peakAgentLastAt = new Map();
  const peakAgentBuckets = new Map();
  // @bridge-function peakAgentBucket from peak-runtime
  // @bridge-function allowPeakAgent from peak-runtime
  // @bridge-function notePeakAgentReply from peak-runtime

  // @bridge-function peakStatusView from peak-runtime

  const retriedAfterEmpty = new Set();
  const configDebugLogged = new Map();
  const memberRoleCache = new Map(); // `${gid}:${uid}` -> { role, at }
  // @bridge-function groupMemberRole from peak-runtime

  // botSelfIdCache / botNicknameCache 在文件上方（selfUserId 旁）声明：
  // isQuoteTargetSelf 等在启动早期就会用到，声明晚会触发 TDZ。
  // @bridge-function botSelfId from peak-runtime

  // 启动预热：self_id / 昵称尽量早拿到（事件可能不带 self_id）。失败重试一次即可，不阻塞启动。
  // @bridge-function warmSelfIdentity from peak-runtime

  // @bridge-function isAddressedToBot from peak-runtime

  // @bridge-function handlePeakLocalReply from peak-runtime


  // ── 群管理指令：静默状态持久化 + 权限判定 ──────────────────────────
  const groupMuteFile = path.join(STATE_DIR, 'group-mutes.json');
  let groupMutes = {};
  try { groupMutes = JSON.parse(fs.readFileSync(groupMuteFile, 'utf8')) || {}; } catch { groupMutes = {}; }
  // @bridge-function saveGroupMutes from group-commands-runtime
  // @bridge-function muteUntilOf from group-commands-runtime
  // @bridge-function setMute from group-commands-runtime

  const adminCmdLast = new Map(); // key -> 上次管理指令时间
  const groupRoleCache = new Map(); // `${gid}:${uid}` -> { role, at }
  // @bridge-function callerTierOf from group-commands-runtime

  // 按一句描述生成「给某个群友专用」的角色卡；失败返回 null，调用方回退到纯风格提示。
  // @bridge-function generatePersonaCard from group-commands-runtime

  // 摘要会话：借用黑话学习的那套一次性 prompt 通道，串行执行避免互相打断。
  let summaryInFlight = false;
  // @bridge-function summarizeGroupWindow from group-commands-runtime

  /** 返回 true 表示这条消息已被指令消费，不再进入 agent。 */
  // @bridge-function handleGroupCommand from group-commands-runtime

  // @bridge-function handleIncoming from incoming-runtime

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  // @bridge-function cancelPendingEntry from pending-interactions

  // 回答挂起的提问/审批
  // @bridge-function handlePendingAnswer from pending-interactions

  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  // @bridge-function handlePokeNotice from pending-interactions

  // @bridge-function registerPending from pending-interactions

  // DSH 事件流 → QQ

  /**
   * 把一条 session/event 喂给该会话的 turn collector，并维护 collectors 的生命周期。
   *
   * 两条不变量（都曾被真实故障踩过）：
   *   ① 只为 turn/start 建 collector —— 任何事件都建的话，一条重连后补发的
   *      assistant/message 就会留下永不结束的空 collector，而「会话是否繁忙」正是按
   *      collectors.has() 判断的 ⇒ 这个会话从此再也收不到唤醒；
   *   ② turn/end 即使没有匹配的 turn/start（重连快照没带上）也要清掉已成空壳的
   *      collector，否则同样会永久繁忙。
   */
  // @bridge-function trackTurnEvent from mux-runtime

  // @bridge-function pumpMux from mux-runtime

  // ── 群文件转存（fileArchive 白名单） ─────────────────────────────────────
  // 语义：只有 cfg.fileArchive.groups 里的群，`group_upload` 事件才会转存；
  // 不在白名单的群**完全静默**（不下载、不提示、不打日志），普通群行为一点不变。
  // 落盘：state/files/<群号>/<YYYY-MM>/<原文件名>（重名加序号，绝不覆盖）。
  // 台账：state/messages.db 的 file_archive 表（见 src/file-archive.js）。
  const ARCHIVE_CLASSIFY_SESSION_FILE = path.join(STATE_DIR, 'file-archive-agent.json');
  let archiveClassifySessionId = null;
  let archiveCleanupTimer = null;
  let lastArchiveCleanupDay = '';

  // @bridge-function fileArchiveDb from archive-runtime

  // ── 配置热加载（不重启进程）────────────────────────────────────────────
  // 改 config.json 后：/api/config/reload 立即生效；开了 socialV2.hotReload.enabled 还会自动监听文件。
  // 端口/连接类字段必须重启（见 config-reload.js 的 RESTART_REQUIRED_PATHS），其余原地替换。
  let lastConfigReloadAt = 0;
  let configReloadCount = 0;
  let lastConfigReloadSkipped = [];
  let configWatcher = null;
  let configReloadTimer = null;
  // @bridge-function reloadConfigFromDisk from config-watch
  // 回合看门狗：DSH 偶尔会「turn/start 之后再也没有事件」（模型/工具卡死），
  // 这时 v2TurnStartAt 一直占着，会话永远 busy —— 用户看到的就是「@ 了没反应」。
  // 群会话超过 4 分钟无事件就判死：清忙、记日志、补推一次排队唤醒。
  // @bridge-function startTurnWatchdog from config-watch

  // @bridge-function startConfigWatcher from config-watch

  // @bridge-function fileArchiveRootDir from file-archive-runtime

  /** 转存依赖：聊天文件段、引用消息里的文件共用同一套（下载/取直链/时间/发送者/日志）。 */
  // @bridge-function fileArchiveDeps from file-archive-runtime

  // ── BOOTH 元数据（konoasset 风格的分类/索引） ────────────────────────────
  // @bridge-function boothConfig from file-archive-runtime

  // @bridge-function boothCacheDir from file-archive-runtime

  /** enrichArchiveItem 的外部依赖（真实实现：抓页面 + 流式下缩略图）。 */
  // @bridge-function boothDeps from file-archive-runtime

  /** 异步增强（不阻塞消息处理）：拿到 BOOTH 号才动手，失败只记一行日志。 */
  // @bridge-function scheduleArchiveEnrichment from file-archive-runtime

  /** 调 OneBot HTTP 动作（与 refreshGroupMembers 相同的连接/鉴权方式）。 */
  // @bridge-function oneBotAction from file-archive-runtime

  /**
   * 群文件上传 → 转存。
   * 只在白名单群执行；任何异常都只记日志，不影响其它事件处理。
   */
  // ── 转存闸门 ─────────────────────────────────────────────────────────
  // 正常模式：只收图片 + 压缩包（表情包永不），由 shouldArchiveAttachment 判定。
  // simpleMode（用户退而求其次的兜底）：**只收文件名以 7 位 BOOTH 号开头的压缩包/图片**，
  // 其余一律不收；不抓 BOOTH、不自动分类、不自动清理，用户自己整理文件夹。
  const SIMPLE_BOOTH_RE = /^\d{7}/;
  // @bridge-function archiveGate from file-archive-runtime

  // @bridge-function handleGroupFileUpload from file-archive-runtime

  /** 复用桥接已有的「学习会话」机制（learnerSessions + waitLearnerTurn）跑分类，模型即 cfg.dsh.model。 */
  // @bridge-function ensureArchiveClassifySession from file-archive-runtime

  /** 让现有 DSH 会话给文件分类；失败静默返回 null（规则分类已经落库，不影响清理）。 */
  // @bridge-function classifyArchivedFile from file-archive-runtime

  // @bridge-function archiveNextRunAt from file-archive-runtime

  // @bridge-function runArchiveCleanupNow from file-archive-runtime

  // @bridge-function startArchiveCleanupLoop from file-archive-runtime

  // ── 观察学习（observe 白名单） ───────────────────────────────────────────
  // 命中的群：AI **只看不说**。在 onGroupMessage 的最前面分流，不进入 handleIncoming，
  // 因此不会唤醒、不会回复、不扣额度；只把文本喂进黑话滚动窗口、把图片/表情收进本地学习库。
  const observeLoggedAt = new Map();
  // @bridge-function noteObserveActivity from observe-runtime

  // 观察群表情段形态的诊断日志（每群每小时最多一行）：只记 type / 有无 url / file 前 32 字符
  // 与 faceId，**绝不打完整 url**（里面带 rkey/token，落日志就是泄露）。
  const observeShapeLoggedAt = new Map(); // groupId -> 小时戳
  // @bridge-function logObserveStickerShapes from observe-runtime

  /**
   * 观察群收一张表情：优先 md5/url 直接入库；两者都没有时（QQ 表情在网关里常见的形态：
   * image 段只有 file、face 段只有 id）走 get_image 拿字节、自己算 md5，并把原图落到
   * state/sticker-files（QQ 直链会过期）。仍拿不到就**明确记一条日志**，不静默丢。
   */
  // 本地表情缓存上限（默认 200MB）：超过就**不再落盘新图**，只保留 URL 并标记 missing，
  // 避免观察群长期采集把磁盘吃满。每张 ≤2MB（safeFetchBinary 上限）。
  const STICKER_CACHE_MAX_BYTES = 200 * 1024 * 1024;
  // 16MB：QQ 里常见的动图表情常到 8~14MB，2MB 时代它们全被判「图片超过大小限制」
  const STICKER_THUMB_MAX_BYTES = 16 * 1024 * 1024;
  let stickerCacheTotalCache = null;
  let stickerCacheWarnedAt = 0;
  // @bridge-function stickerCacheDirPath from observe-runtime
  // @bridge-function stickerCacheLimit from observe-runtime
  // @bridge-function stickerCacheTotal from observe-runtime

  /**
   * 立刻把一张表情的图片落盘（观察群采集/收藏同步共用）。
   * 有 URL 就趁签名没过期下载：算 md5 → `state/sticker-files/<md5>.img` → 回填条目 md5。
   * 下载失败只把 thumbStatus 标成 missing，**不阻塞**采集/收藏。
   */
  // @bridge-function persistEntryThumb from observe-runtime

  /** 给「有 url、但本地还没有缓存」的表情补一次落盘（同步后/启动时各跑一次，限量）。 */
  // @bridge-function persistMissingStickerThumbs from observe-runtime

  // @bridge-function collectObserveSticker from observe-runtime

  // @bridge-function observeLearnFromGroupMessage from observe-runtime
  return {
    get peakPauseLogged() { return peakPauseLogged; }, set peakPauseLogged(v) { peakPauseLogged = v; },
    get peakLocalStats() { return peakLocalStats; },
    get peakLocalLastAt() { return peakLocalLastAt; },
    get peakLocalRecentTexts() { return peakLocalRecentTexts; },
    get peakLocalBuckets() { return peakLocalBuckets; },
    get peakAgentLastAt() { return peakAgentLastAt; },
    get peakAgentBuckets() { return peakAgentBuckets; },
    get retriedAfterEmpty() { return retriedAfterEmpty; },
    get configDebugLogged() { return configDebugLogged; },
    get memberRoleCache() { return memberRoleCache; },
    get groupMuteFile() { return groupMuteFile; },
    get groupMutes() { return groupMutes; }, set groupMutes(v) { groupMutes = v; },
    get adminCmdLast() { return adminCmdLast; },
    get groupRoleCache() { return groupRoleCache; },
    get summaryInFlight() { return summaryInFlight; }, set summaryInFlight(v) { summaryInFlight = v; },
    get ARCHIVE_CLASSIFY_SESSION_FILE() { return ARCHIVE_CLASSIFY_SESSION_FILE; },
    get archiveClassifySessionId() { return archiveClassifySessionId; }, set archiveClassifySessionId(v) { archiveClassifySessionId = v; },
    get archiveCleanupTimer() { return archiveCleanupTimer; }, set archiveCleanupTimer(v) { archiveCleanupTimer = v; },
    get lastArchiveCleanupDay() { return lastArchiveCleanupDay; }, set lastArchiveCleanupDay(v) { lastArchiveCleanupDay = v; },
    get lastConfigReloadAt() { return lastConfigReloadAt; }, set lastConfigReloadAt(v) { lastConfigReloadAt = v; },
    get configReloadCount() { return configReloadCount; }, set configReloadCount(v) { configReloadCount = v; },
    get lastConfigReloadSkipped() { return lastConfigReloadSkipped; }, set lastConfigReloadSkipped(v) { lastConfigReloadSkipped = v; },
    get configWatcher() { return configWatcher; }, set configWatcher(v) { configWatcher = v; },
    get configReloadTimer() { return configReloadTimer; }, set configReloadTimer(v) { configReloadTimer = v; },
    get SIMPLE_BOOTH_RE() { return SIMPLE_BOOTH_RE; },
    get observeLoggedAt() { return observeLoggedAt; },
    get observeShapeLoggedAt() { return observeShapeLoggedAt; },
    get STICKER_CACHE_MAX_BYTES() { return STICKER_CACHE_MAX_BYTES; },
    get STICKER_THUMB_MAX_BYTES() { return STICKER_THUMB_MAX_BYTES; },
    get stickerCacheTotalCache() { return stickerCacheTotalCache; }, set stickerCacheTotalCache(v) { stickerCacheTotalCache = v; },
    get stickerCacheWarnedAt() { return stickerCacheWarnedAt; }, set stickerCacheWarnedAt(v) { stickerCacheWarnedAt = v; },
  };
}
