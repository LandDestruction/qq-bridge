// D62 装配阶段：控制台服务入口、发送链/分条发送、媒体上限与归一化、本地兜底。
// 纯搬运：语句顺序与拆分前 main() 一致；无 import，依赖全部由 deps 注入。
export function bootConsoleAndSend(deps) {
  const { cfg, modelSelectionEpoch } = deps;
  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。
  // @bridge-function v2ToolEnabled from upstream-health

  // @bridge-function startConsoleServer from console-server

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  let sendChain = Promise.resolve();

  // ── 发送节奏（防 QQ 风控 + 更像人）─────────────────────────────────────────
  // 所有发到 QQ 的消息（文字 / 语音 / 图片 / 表情）发送前都来这里领一个时间片：
  // 两条之间至少 minGapMs，并随上一条字数增长；表情短、语音长。规则在
  // src/send-pacing.js（纯函数、有单测），这里只持有进程内全局状态。
  const pacingState = deps.makePacingState();
  function reserveSendSlotFor(kind, payload) {
    return deps.paceSendSlot({
      state: pacingState,
      cfg: () => deps.cfg,
      sleep: deps.sleep,
      log: deps.log
    }, kind, payload);
  }
  // @bridge-function redactKnownTokensOnly from outbound-text

  // 最近一次发送是否全部成功（按 key）。调用方据此决定要不要刷新「我发过言了」的时间戳 ——
  // 旧实现把发送失败吞成一行日志后**照常 resolve**，于是调用方以为发言成功，
  // 更新 lastAiReplyAt / 活跃调度，实际群里什么都没收到，而且只有一行滚动日志能看出问题。
  const lastSendFailed = new Map(); // key -> true（下一次成功即清除）

  // 每个 QQ 最近在哪个群发过言：私聊发不出去时用它开临时会话（QQ 要求带共同群）。
  const recentUserGroup = new Map();

  /** 用临时会话（带 group_id）发一条私聊文本，成功返回 true。 */
  // @bridge-function sendPrivateViaTempSession from outbound-text

  /** 私聊发送统一入口：QQ 拒绝「非好友」时自动改用临时会话重试。 */
  // @bridge-function sendPrivateSafe from outbound-text

  // @bridge-function sendToQQ from outbound-text

  /** 上一批发往该会话的消息是否全部成功。 */
  // @bridge-function lastSendSucceeded from outbound-text

  // ── 真人式分条发送 ──────────────────────────────────────────────────────
  // @bridge-function singleLineForQQ from outbound-text

  // 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
  // URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
  // @bridge-function splitLongSegment from outbound-text

  // 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
  // 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
  // @bridge-function isCjkChar from outbound-text

  // 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
  // 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
  // 注意：该逻辑只用于一代 reserved 的自动转发文本；二代 reserved2 不走这里，二代必须显式用数组分条。
  // @bridge-function splitByCjkSpaces from outbound-text

  // 新分句逻辑：分句权交给 AI。
  // AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
  // 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
  // @bridge-function planSocialTimeline from outbound-text

  // 分条发送：与 sendToQQ 共用同一 sendChain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  // @bridge-function sendBurstToQQ from outbound-text


  // @bridge-function onebotSend from outbound-text

  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  // @bridge-function mimeFromBuffer from media-input

  // @bridge-function mimeFromUrl from media-input

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  // @bridge-function getImageDimensions from media-input

  // @bridge-function base64FromMaybe from media-input

  // 媒体上限（config.json 可调，但必须收敛到安全区间）：
  //   maxBytes  —— 单条消息里图片/表情的总字节上限。8MB 能覆盖绝大多数动图表情；
  //                太大会让 base64 常驻内存（×1.33）并拖慢 DSH 上传。
  //   maxPixels —— 单张图解码像素上限（防图片炸弹），与 DSH 的 64MP 默认一致。
  //   maxCount  —— 单条消息最多处理几张（防止一次 @ 带 20 张图把模型上下文撑爆）。
  const maxMediaBytesLimit = (() => {
    const n = Number(cfg.socialV2?.media?.maxBytes);
    return Number.isFinite(n) && n > 0 ? Math.min(20 * 1024 * 1024, Math.max(256 * 1024, Math.round(n))) : 8 * 1024 * 1024;
  })();
  const MAX_MEDIA_COUNT = (() => {
    const n = Number(cfg.socialV2?.media?.maxCount);
    return Number.isFinite(n) && n > 0 ? Math.min(8, Math.max(1, Math.round(n))) : 5;
  })();
  const MAX_MEDIA_BYTES = maxMediaBytesLimit; // **送模型前**的图片总字节预算（默认 8MB）
  // 抓取上限：与「送模型预算」是两件事。手机原图 8~15MB 很常见，用 8MB 去抓会在下载阶段
  // 就把大图挡掉，根本轮不到「缩到 1280 / 1MB」那一步 —— 这正是「大一点的图都看不了」的根因。
  const MAX_DOWNLOAD_BYTES = (() => {
    const n = Number(cfg.socialV2?.media?.maxDownloadBytes);
    return Number.isFinite(n) && n > 0 ? Math.min(200 * 1024 * 1024, Math.max(1024 * 1024, Math.round(n))) : 40 * 1024 * 1024;
  })();
  const MAX_MEDIA_PIXELS = (() => {
    const n = Number(cfg.socialV2?.media?.maxPixels);
    return Number.isFinite(n) && n > 0 ? Math.min(64_000_000, Math.max(1_000_000, Math.round(n))) : 64_000_000;
  })(); // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

  // ── 喂给模型的那一份：体积与动图形态归一化 ────────────────────────────────
  //
  // 为什么必须在这里动手（而不是"让 DSH 自己处理"）：
  //   ① DSH 的 MCP 图片入口用正则校验 base64，实测量级 ≥4,474,880 字符（原始字节 ≥3.20 MiB）
  //      必抛 RangeError: Maximum call stack size exceeded，工具结果被降级成
  //      `[image unavailable: image/gif; Maximum call stack size exceeded; …]` —— 模型只看到一行错误。
  //      而下面的 MAX_MEDIA_BYTES 是**抓取**上限（默认 8 MiB），故意留着不动：
  //      得先把大图抓下来，才有机会压小它。
  //   ② DSH 对 image/gif 一律归一化成单帧，模型永远只看第一帧，且不知道那是动图。
  //      动图在桥接侧抽帧拼图后，信息量反而更高（实测 4.83MB/200 帧 → 92KB/269ms）。
  //
  // 上限默认值见 media-normalize.js 的 MEDIA_DEFAULTS；config.json 的 socialV2.media 可覆盖。
  // ⚠️ 只用于**喂模型**的出口。collectStickerV2 走 fetchOneBotImage 的原始字节，不能经过这里，
  //    否则收藏下来的表情会变成拼图/降采样版本。
  const modelMediaLimits = (() => {
    const m = cfg.socialV2?.media ?? {};
    return {
      enabled: m.normalize !== false,
      maxModelBytes: m.maxModelBytes,
      maxLongEdge: m.maxLongEdge,
      gifFrames: m.gifFrames,
      gifTile: m.gifTile,
      // 超长截图切片：阈值与片数可配（默认 3 倍、8 片；见 MEDIA_DEFAULTS）。
      tallRatio: m.tallRatio,
      maxTiles: m.maxTiles,
      tallOverlap: m.tallOverlap,
      timeoutMs: m.normalizeTimeoutMs,
      ffmpegPath: process.env.FFMPEG_PATH || cfg.socialV2?.voice?.ffmpegPath || null
    };
  })();

  /**
   * 把一张已抓到的图片整理成模型可安全消费的形态。
   * @returns {Promise<{ok:boolean, buffer?:Buffer, mimeType?:string, note?:string, error?:string}>}
   *          ok=false 表示"压不到可用体积"——调用方必须把它变成一句可读的失败原因，
   *          绝不发注定被 DSH 丢掉的字节（那样模型只会看到看不懂的英文错误）。
   */
  // @bridge-function toModelMedia from media-input

  // @bridge-function isSafeLocalMediaPath from media-input

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  // @bridge-function isProbablySafeImageFileRef from media-input

  // QQ 表情包 CDN 的地址可以只靠 emoji_id 推出来（实测形态：
  // https://gxh.vip.qq.com/club/item/parcel/item/<id 前两位>/<id>/raw300.gif）。
  // 市场表情不在网关缓存里（get_image 返回 image not found in cache），url 又可能缺失，
  // 这条兜底能救回这一类；只接受纯十六进制 id，绝不把任意字符串拼进 URL。
  // @bridge-function emojiCdnCandidates from media-input

  // 有些网关不带 emoji_id，但 file 名里就嵌着它（实测 "f9-<32 位 hex>.gif"）。
  // @bridge-function emojiIdFromFileName from media-input

  /** 校验一张图片字节：格式、大小（调用方已限）、像素上限；不通过返回 null。 */
  // @bridge-function acceptImageBuffer from media-input

  // @bridge-function fetchOneBotImage from media-input

  // @bridge-function fetchFaceMedia from media-input

  // 媒体（图片/表情）：桥接已经为了「给模型看图」把字节下载下来了，转存直接复用这份 buffer，
  // 不二次下载。只有白名单群落盘；观察群永远不落盘（观察群在 onGroupMessage 最前就 return，
  // 根本走不到这里，这里再挡一道）。
  // 群名称缓存：simpleMode 的目录要「群号_群名/<YYYY-MM>/」。取不到就只用群号。
  const groupNameCache = new Map();
  let groupNamesLoaded = false;
  // @bridge-function groupNameStatePath from attachment-archive
  // @bridge-function loadGroupNamesOnce from attachment-archive
  // @bridge-function saveGroupNames from attachment-archive
  // @bridge-function ensureGroupFolderName from attachment-archive
  // @bridge-function archiveCfgFor from attachment-archive

  // @bridge-function archiveMediaAttachment from attachment-archive

  // 跳过日志折叠：同一会话、同一类别每小时最多一行，避免刷屏但保留可排查性。
  const archiveSkipLoggedAt = new Map(); // `${key}:${tag}` -> 小时戳
  // @bridge-function logArchiveSkip from attachment-archive

  // @bridge-function resolveMediaList from media-resolution

  // @bridge-function fetchMediaData from media-resolution

  // @bridge-function mediaHintFor from media-resolution

  // @bridge-function findMessageMedia from media-resolution

  // @bridge-function clampGapV2 from outbound-policy

  // @bridge-function computeGapsV2 from outbound-policy

  /** D39：出站前补 /persona 用法。只补最后一条；模型已经提到就只清标记，不重复。 */
  // @bridge-function applyPersonaGuideToMessages from outbound-policy

  // @bridge-function sendMessagesV2 from outbound-policy

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  // @bridge-function shouldAuditKey from outbound-policy

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  // @bridge-function captureSendGuard from outbound-policy

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  // @bridge-function shouldBlockSilentReply from outbound-policy

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  // @bridge-function auditAndSend from outbound-policy

  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次；
  // 控制台热切换思考强度时递增 modelSelectionEpoch，使旧记录失效并在下一条消息重新应用。
  // 四种 QQ 模式共用 DSH 会话，统一强制使用多模态模型 DeepSeek-V41-Flash（id: deepseek-flash）；
  // 它同时支持 text/image 输入，取代已下线的 deepseek-v4-flash-vision-exp。
  const modelAppliedSessions = new Map(); // sessionId -> 已应用的 modelSelectionEpoch
  const turnLastEventAt = new Map(); // sessionId -> 最近一次 turn 事件时间（看门狗用）
  // sessionId -> 本轮 selectModel 真正生效的 { provider, model }：含图回合会被切到能看图的模型，
  // 这个选择只用于 selectModel，不回写 activeModelOverride，所以视觉守卫必须读这里。
  const appliedModelBySession = new Map();
  // 返回 'applied' | 'not-found' | 'failed'。
  // 'not-found' 表示 DSH 侧会话已经不存在（DSH 重启、异常退出、归档竞态），
  // 本地映射已失效，调用方必须退役重建，否则每条消息都会对着一个不存在的会话重试。
  // 运行期模型覆盖：主模型额度用光/被限流时，由 recordModelFailure() 切到备用模型。
  let activeModelOverride = null; // { provider, model, since, reason } | null
  const MODEL_FAILURE_NOTIFY_MS = 60 * 60 * 1000;
  let lastModelFailureNotifyAt = 0;
  // 降级次数（只用于日志的「第 N 次」；不用于私聊通知 —— 降级已改为只写日志）。
  let modelFallbackCount = 0;

  // 判定逻辑本身在 src/model-fallback.js（纯函数，可离线单测）。
  // 旧实现在这里内联一条正则，漏掉了「主模型池整体 503」的真实报文
  // （code=no_healthy_account / all accounts are temporarily unavailable），
  // 导致 dsh.modelFallbacks 一次都没生效过。
  // isModelCapacityError 由文件顶部 import 引入。

  /**
   * 出错时能发到聊天里的那句话。
   * 群聊/他人私聊只给中性提示（网关 JSON、内部错误码、供应商名字一律不外泄）；
   * owner 私聊给一句脱敏后的简短原因，方便直接判断是额度、模型配置还是网关挂了。
   */
  // @bridge-function chatErrorNotice from model-selection

  /** 把内部错误原文压成一句能给人看的原因（脱敏、去 JSON、截断）。 */
  // @bridge-function chatSafeReason from model-selection

  /**
   * 主模型失效时切到备用模型：
   *   1) 本进程内所有会话下一轮起用备用模型；
   *   2) 让 modelSelectionEpoch 递增，已应用过的会话会重新 selectModel；
   *   3) **只写日志**（用户明确要求不再私聊管理员）；次数记进日志便于排查。
   * 备用模型来自 config.json 的 dsh.modelFallbacks（数组，元素 { provider, model }）。
   */
  // @bridge-function recordModelFailure from model-selection

  return {
    get sessionEpoch() { return sessionEpoch; }, set sessionEpoch(v) { sessionEpoch = v; },
    get pending() { return pending; },
    get sendChain() { return sendChain; }, set sendChain(v) { sendChain = v; },
    get reserveSendSlot() { return reserveSendSlotFor; },
    get sendPacingOptions() { return deps.readPacingOptions(deps.cfg); },
    get lastSendFailed() { return lastSendFailed; },
    get recentUserGroup() { return recentUserGroup; },
    get maxMediaBytesLimit() { return maxMediaBytesLimit; },
    get MAX_MEDIA_COUNT() { return MAX_MEDIA_COUNT; },
    get MAX_MEDIA_BYTES() { return MAX_MEDIA_BYTES; },
    get MAX_DOWNLOAD_BYTES() { return MAX_DOWNLOAD_BYTES; },
    get MAX_MEDIA_PIXELS() { return MAX_MEDIA_PIXELS; },
    get MAX_MEDIA_STORE_PER_KEY() { return MAX_MEDIA_STORE_PER_KEY; },
    get modelMediaLimits() { return modelMediaLimits; },
    get groupNameCache() { return groupNameCache; },
    get groupNamesLoaded() { return groupNamesLoaded; }, set groupNamesLoaded(v) { groupNamesLoaded = v; },
    get archiveSkipLoggedAt() { return archiveSkipLoggedAt; },
    get modelAppliedSessions() { return modelAppliedSessions; },
    get turnLastEventAt() { return turnLastEventAt; },
    get appliedModelBySession() { return appliedModelBySession; },
    get activeModelOverride() { return activeModelOverride; }, set activeModelOverride(v) { activeModelOverride = v; },
    get MODEL_FAILURE_NOTIFY_MS() { return MODEL_FAILURE_NOTIFY_MS; },
    get lastModelFailureNotifyAt() { return lastModelFailureNotifyAt; }, set lastModelFailureNotifyAt(v) { lastModelFailureNotifyAt = v; },
    get modelFallbackCount() { return modelFallbackCount; }, set modelFallbackCount(v) { modelFallbackCount = v; },
  };
}

// D62 装配阶段：模型选择/回退、会话 workspace 守卫、社交引擎与二代唤醒状态、初始提示词。
// 纯搬运：语句顺序与拆分前 main() 一致；无 import，依赖全部由 deps 注入。
export function bootModelSession(deps) {
  const { MODEL_FAILURE_NOTIFY_MS, state } = deps;
  // ── 本地兜底通道 ────────────────────────────────────────────────────────
  // 外部网关/上游全断时，本机 8B 模型接管「回一句话」。它**不调用任何工具**：
  // 生成文本后由这里直接 sendToQQ。
  // 为什么必须直发：reserved2 模式下 agent 的文本输出只是「思考」，真正发消息靠工具调用；
  // 而本地小模型在 8K 窗口里塞不下 45 个工具的 schema（实测固定开销 26K token），
  // 所以这条通道刻意绕开工具协议，只做「收到消息 → 说一句话」。
  //
  // 判定/裁剪/清洗都在 src/local-fallback.js（纯函数，scripts/test-local-fallback.mjs 覆盖）。
  const externalFailureStreak = new Map(); // key -> 连续失败次数
  let localFallbackState = { active: false, since: 0, reason: '', ok: 0, fail: 0 };
  let localClient = null;
  let localClientSig = '';
  const localRecoverNotifyAt = new Map(); // ownerKey -> 上次「已切回」通知时间

  // @bridge-function localCfgNow from model-selection

  /** 配置变了就重建客户端（baseUrl/model/超时都会影响请求形状）。 */
  // @bridge-function localClientNow from model-selection

  /**
   * 主链路这一轮成功了：清掉连续失败计数；如果之前是本地在接管，切回并通知 owner。
   * 通知节流一小时（沿用 MODEL_FAILURE_NOTIFY_MS），避免主链路半死不活时来回刷屏。
   */
  // @bridge-function noteExternalTurnOk from model-selection

  /**
   * 试着用本地模型回一句话。
   * @returns {Promise<boolean>} true = 已经发到 QQ（调用方 continue），false = 没接管
   */
  // @bridge-function tryLocalFallback from model-selection

  // ── 可用模型清单探测 ─────────────────────────────────────────────────────
  // 只在 selectModel 失败时才拉（DSH 的 session.modelCatalog 是 RPC，不能每条消息都问）。
  // 缓存跟着 modelSelectionEpoch 走：切模型/改配置会递增 epoch，缓存自动失效。
  let availableModelsCache = null; // { epoch, at, list }
  const AVAILABLE_MODELS_TTL_MS = 10 * 60 * 1000;

  // @bridge-function probeAvailableModels from model-selection

  /** 自动回退只写日志、不私聊管理员（用户明确要求）；同一小时内去重，避免日志刷屏。 */
  // @bridge-function notifyModelAutoFallback from model-selection

  // 最近几条里有没有图/表情/视频：有就必须用能看图的模型。
  // @bridge-function keyHasRecentMedia from model-selection

  // @bridge-function ensureChatModel from model-selection

  // ── 会话 workspace 存活守卫 ────────────────────────────────────────────────
  // 为什么需要：ensureSession 复用 state.sessions[key] 时只校验代际与 selectModel 结果，
  // 从不确认该会话在 DSH 侧挂的 workspace 目录**还在盘上**。2026-10-27 00:35 仓库迁移
  // （E:\qq-bot-worktrees → <本机路径>\qq-bot-worktrees）之后，5 个线上会话的 cwd 全指向
  // 已不存在的旧目录：DSH 每轮打开 workspace 都抛 workspace/invalid-path（ENOENT realpath），
  // 桥接把它当普通 agent 错误记一行就丢，映射永远不清 → 群里每条消息都石沉大海。
  // 现在复用前查一次 sessions.list（TTL 缓存 + 单飞，避免每条消息打整表 RPC），目录不存在
  // 就退役重建；清单里查不到或查询失败一律放行（fail-open），绝不误杀健康会话。
  const SESSION_CWD_CHECK_TTL_MS = 60 * 1000;
  const SESSION_CWD_CHECK_TIMEOUT_MS = 5000;
  let sessionCwdIndex = { at: 0, bySession: null, errorAt: 0 };
  let sessionCwdIndexPromise = null;
  // @bridge-function refreshSessionCwdIndex from session-runtime
  /**
   * 仅当「DSH 清单里明确有该会话，且它记录的 cwd 在盘上不存在」返回 true。
   * 清单里没有（可能已归档）或清单查询失败都返回 false —— 那属于 selectModel 的 not-found
   * 与降级路径，不在这里替它们做决定；查询失败后 60 秒内不再重试，避免 DSH 半死时每条
   * 消息白等 5 秒（超时预算）。
   */
  // @bridge-function sessionWorkspaceGone from session-runtime

  // @bridge-function ensureSession from session-runtime

  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek'; // 机器人昵称（小写；启动时从网关获取，识别"被提到"用）
  // 给 agent 看的身份（保留原始大小写）与机器人自己的 QQ 号。
  // 为什么必须单独存：消息里只有 "@樰" 这一串文本，agent 没有任何途径知道"樰"就是它自己，
  // 于是会把 @自己 当成 @别人、已读不回（issue #29）。昵称与 QQ 号要显式写进 prompt。
  let selfDisplayName = '';
  let selfUserId = '';
  // 唤醒兜底：SnowLuma 部分事件不带 self_id，用 get_login_info 的缓存补。
  // 用 var（而不是 let）：isQuoteTargetSelf / warmSelfIdentity 在启动早期就会读它，
  // let 会命中 TDZ（Cannot access before initialization）。
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  const social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const socialV2 = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
    // 记忆层：跨会话共享的印象与事件（第一层/第二层），与 conversations 平级
    globalImpressions: Object.create(null), // 名字 -> { traits[], interactionCount, lastSeenAt }
    sharedEvents: [], // { id, at, text, scope: global | group:xxx, by, key }
    digests: {}, // key -> { key, at, summary, topics, people }（跨会话摘要）
    impressionsMigrated: false,
    handoffs: Object.create(null) // key -> { text, at, count }（会话交接脉络，注入一次后清掉）
  };

  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  // @bridge-function normalizeSpeakerIdsV2 from wake-state

  // triggers 的**唯一**合法字段集合。写入与加载都按它过滤：
  // 旧写法 `{...current.triggers, ...inputTriggers}` 会把模型传来的任意键原样并入、
  // 持久化、再由 qq_get_prompt 原样回给模型（每次请求都带着），等于给了一个
  // 「用 1MB 垃圾键把状态文件与每轮 prompt 撑大」的入口。
  const WAKE_TRIGGER_KEYS = Object.freeze(['atMention', 'nameMention', 'speakerIds', 'keywords', 'question', 'poke', 'anyMessage', 'probability']);
  // @bridge-function pickWakeTriggersV2 from wake-state

  // @bridge-function defaultWakeConfigV2 from wake-state

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  // @bridge-function refreshDefaultWakeConfigV2 from wake-state

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  // @bridge-function refreshAllDefaultWakeConfigsV2 from wake-state

  // 沉睡前强制观察窗口：防止 AI 聊两句就立刻潜水。
  // 新规则：每次设置潜水/下一次唤醒前，AI 必须先进入一次“沉睡前观察”（qq_wait_for_messages(timeoutMs=preSleepWaitMs)）。
  // - 观察期间没人说话 → 可以设置唤醒并沉睡（preSleepWaitSatisfiedAt）。
  // - 观察期间有人发了新消息 → 等待工具会把新消息带回给 AI（preSleepWaitObservedAt）；
  //   AI 看过新消息后若判断没必要参与，可以直接沉睡；若参与了（发送/拍一拍），则下次想睡需重新观察。
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

  // @bridge-function hasExplicitEndV2 from wake-state

  // @bridge-function isSleepingConfigV2 from wake-state

  // @bridge-function preSleepWaitBlockedV2 from wake-state

  // @bridge-function computeWakeSafetyV2 from wake-state

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  // @bridge-function ensureWakeableV2 from wake-state

  // @bridge-function getSocialV2State from wake-state

  /** 恢复记忆层字段；首次启动时把 per-session 印象迁移到全局（只跑一次）。 */
  /** 会话退役/重置前，把最近消息压成脉络存起来（第三层）。 */
  // @bridge-function saveHandoffDigest from wake-state

  /** 取走该会话的交接脉络（注入一次后删除，避免每轮都塞）。 */
  // @bridge-function takeHandoffDigest from wake-state

  /** 丢掉消息里超大的 media（老的视频拼图是直接把 Buffer 塞进消息的，state 会被撑到几十 MB）。 */
  // @bridge-function pruneHeavyMedia from wake-state

  // @bridge-function loadMemoryLayers from wake-state

  // @bridge-function loadSocialV2State from wake-state

  // @bridge-function saveSocialV2State from wake-state

  // ── 二代仿真：操作者预写的「初始提示词」（每个会话一份，只在首次唤醒时注入） ──────
  //
  // 用途：让操作者在控制台提前告诉 AI「这个群是什么圈子、什么氛围、有什么忌讳」。
  // 为什么单独一个文件、而不是塞进 social-v2.json 的会话状态：
  //   · 会话状态会被 /api/session/reset 与 /api/socialV2/reset 整体删除，而这份是操作者
  //     手写的配置 —— 重置一次 AI 上下文不该把它一起清掉；
  //   · 控制台需要能在群还没说过话（连会话状态都还不存在）时就写好。
  // 为什么只在首次唤醒（bootstrap）注入：这是一份「接入这个群时的背景介绍」，每轮都塞
  // 既白烧 token，又会让 AI 把它当成新指令；首次唤醒后它已在 DSH 会话上下文里。
  const initialPrompts = new Map(); // key -> { text, createdAt, updatedAt }
  let initialPromptsWritable = true;

  // @bridge-function initialPromptMaxChars from initial-prompts

  // 私聊自定义人设（per-session persona）的字数上限（判定逻辑见 src/persona.js）。
  // @bridge-function personaMaxChars from initial-prompts

  /** 归一化操作者输入：统一行尾、去掉 BOM 与控制字符，只裁首尾空白（保留段落换行）。 */
  // @bridge-function normalizeInitialPromptText from initial-prompts

  /**
   * 读取 state/initial-prompts.json。
   * 读不动/读坏时降级为「只读不写」（与 sessions.json、表情库、黑话库同一口径）：
   * 否则内存里的空映射会在下一次保存时把原文件覆盖掉，操作者写的内容永久丢失。
   */
  // @bridge-function loadInitialPrompts from initial-prompts

  // @bridge-function saveInitialPrompts from initial-prompts

  return {
    get externalFailureStreak() { return externalFailureStreak; },
    get localFallbackState() { return localFallbackState; }, set localFallbackState(v) { localFallbackState = v; },
    get localClient() { return localClient; }, set localClient(v) { localClient = v; },
    get localClientSig() { return localClientSig; }, set localClientSig(v) { localClientSig = v; },
    get localRecoverNotifyAt() { return localRecoverNotifyAt; },
    get availableModelsCache() { return availableModelsCache; }, set availableModelsCache(v) { availableModelsCache = v; },
    get AVAILABLE_MODELS_TTL_MS() { return AVAILABLE_MODELS_TTL_MS; },
    get SESSION_CWD_CHECK_TTL_MS() { return SESSION_CWD_CHECK_TTL_MS; },
    get SESSION_CWD_CHECK_TIMEOUT_MS() { return SESSION_CWD_CHECK_TIMEOUT_MS; },
    get sessionCwdIndex() { return sessionCwdIndex; }, set sessionCwdIndex(v) { sessionCwdIndex = v; },
    get sessionCwdIndexPromise() { return sessionCwdIndexPromise; }, set sessionCwdIndexPromise(v) { sessionCwdIndexPromise = v; },
    get randInt() { return randInt; },
    get selfNickname() { return selfNickname; }, set selfNickname(v) { selfNickname = v; },
    get selfDisplayName() { return selfDisplayName; }, set selfDisplayName(v) { selfDisplayName = v; },
    get selfUserId() { return selfUserId; }, set selfUserId(v) { selfUserId = v; },
    get SILENT_TURN_TIMEOUT_MS() { return SILENT_TURN_TIMEOUT_MS; },
    get social() { return social; },
    get socialV2() { return socialV2; },
    get messageMediaStore() { return messageMediaStore; },
    get seenForwardIds() { return seenForwardIds; },
    get WAKE_TRIGGER_KEYS() { return WAKE_TRIGGER_KEYS; },
    get EXPLICIT_END_RE() { return EXPLICIT_END_RE; },
    get initialPrompts() { return initialPrompts; },
    get initialPromptsWritable() { return initialPromptsWritable; }, set initialPromptsWritable(v) { initialPromptsWritable = v; },
  };
}
