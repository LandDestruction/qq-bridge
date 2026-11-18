// D62 装配阶段：消息库/归档读接口兜底、语音发送、QQ AI 语音（TTS）状态。
// 纯搬运：语句顺序与拆分前 main() 一致；无 import，依赖全部由 deps 注入。
export async function bootMediaVoice(deps) {
  const { NodeApiClient, captureSendGuard, cfg, discoverDshBaseUrl, http, inspectAudio, resolveAudioSource, resolveVoicePathForOperator, voiceBudgetCommit, log, persistDshBaseUrl } = deps;
  // ── 读接口的 HTTP 兜底：WS 挂了不等于网关挂了 ──────────────────────────────
  //
  // 为什么要有：`fetch_custom_face_detail` 原来只走 SnowLuma 的 WS action，于是
  // 「WS 正在重连」这段时间里表情库同步必然失败。日志实测 33 次同步里 16 次失败（≈48%），
  // 全是 `SnowLuma WebSocket closed before opening`；表现就是操作者说的
  // 「有时读群友的表情包会失败」——库里没有新收藏 ⇒ qq_get_sticker_image 直接报「找不到表情」。
  //
  // 而**同一个网关的 HTTP 口一直是可用的**（onebotSend 发消息、fetch_ptt_text 转写都直接用它）。
  // 读接口没有理由单点依赖 WS。这里只在 WS 失败时兜底，不改变正常路径的延迟。
  // @bridge-function onebotHttpAction from stickers

  // force=true 时忽略 TTL 强制刷新；失败时返回 null（调用方决定是否使用缓存）。
  // @bridge-function syncStickerLibrary from stickers

  // 返回给 AI 的表情列表（带本地认知）。
  // @bridge-function listStickersForV2 from stickers

  // 取单个表情的图片字节（多模态用）。
  // @bridge-function getStickerImageData from stickers

  // ── 语音发送（把准备好的音频当 QQ 语音条发出） ──────────────────────────────
  //
  // 链路：本地音频文件 → SnowLuma 的 record 段 → 网关自带 SILK 编码 → QQ 语音条。
  // 网关侧事实（v1.14.9 源码确认）：record 段的 file 接受本地路径 / file:// / http(s):// / base64://，
  // 非 SILK 的音频由网关的 native ffmpeg addon 自动转成 NT SILK，所以这里不做预转码。
  //
  // 两条通道，闸门不同（与 /api/send/* 的既有分层一致）：
  //   - agent=true ：QQ 群里的 AI 调用。必须带有效 agent token，且只能发它自己那个会话。
  //   - agent=false：操作者（CLI / 控制台，凭 consoleToken）。跳过会话/模式闸门，
  //                  但仍强制白名单 + 语音限流 + 敏感词审计。
  // 语音发送时间戳（scopeKey → number[]）：与文本发送分开计数，语音额度独立。
  const voiceSendTimes = new Map();

  /**
   * 出站语音的内容审计：与文本一致，凡是「疑似敏感信息 / 含会话令牌」的**文件名**
   * 都不允许外发（语音的音频内容本身无法审计，但文件名同样会泄露路径与项目信息）。
   */
  // @bridge-function assertOutboundAuditOk from voice

  // @bridge-function voiceCfg from voice

  // @bridge-function voiceLibrary from voice

  /**
   * 把「AI 给的语音引用」解析成可发送的本地绝对路径。
   *
   * 安全边界：**AI 只能从语音库目录里取文件**（防 prompt injection 拿任意本地文件当语音外发）。
   *
   * 历史坑（已修）：这里曾经在 `socialV2.voice.allowAbsolutePath: true` 时直接把 AI 给的
   * 绝对路径交给 resolveAudioSource 解析，于是「AI 传 %USERPROFILE%\Music\任意.mp3」
   * 就能把本机任意音频（< 20 MB）发到群里 —— 而 inspectAudio 对「没有音频流」或
   * ffprobe 不可用的情况是放行的，等于把开关变成了任意文件外发通道。
   * 现在即使开了这个开关，也要求绝对路径**必须落在语音库目录之内**；
   * 真要从库外发文件请走操作者通道（resolveVoicePathForOperator / CLI）。
   */
  // @bridge-function voicePathInsideLibrary from voice

  // @bridge-function resolveVoicePathForV2 from voice

  /**
   * 操作者通道（CLI）的路径解析：允许绝对路径（操作者本来就能读本机文件），
   * 相对路径先按「语音库」解析，再按当前工作目录解析 —— 这样两种直觉写法都成立。
   * base64/http 来源仍然禁止：语音应来自本地文件，别让 CLI 变成任意 URL 的外发口子。
   */
  // @bridge-function resolveVoicePathForOperator from voice

  /**
   * 语音发送限流：与文本发送分开计数，避免语音吃掉聊天额度（也避免聊天把语音额度耗光）。
   *
   * 只**检查**不占额度：额度在真正发出去之后才由 voiceBudgetCommit 记账 ——
   * 这样参数错、被审计拦截、网关失败都不会白白吃掉配额（否则连失败几次就被假 429 卡住）。
   */
  // @bridge-function voiceBudgetCheck from voice

  /** 语音真正发出后记账（顺带裁掉超过 1 小时的旧时间戳，避免数组无界增长）。 */
  // @bridge-function voiceBudgetCommit from voice

  /**
   * 底层发送：把音频作为 record 段交给 SnowLuma。
   * guard=true（agent 通道）时，发送前必须通过 captureSendGuard —— 会话/模式/白名单任一变
   * 就放弃发送；guard=false（操作者通道）时不套会话闸门（操作者可能不在任何会话里）。
   *
   * audio 可传音量设置 { volume, normalize, loudness }：SnowLuma 的 record 段没有增益字段，
   * 所以音量必须在本地用 ffmpeg 调好再发（临时文件发完即删）。
   */
  // @bridge-function sendVoiceV2 from voice

  /** 把「我发了条语音」写进二代会话的 recentMessages，让 AI 自己知道刚发过什么。 */
  // @bridge-function recordVoiceSentV2 from voice

  /**
   * 发完语音后的**落地验证**：把这条消息从网关读回来，确认它真的带着 record 段。
   *
   * 为什么不用 fetch_ptt_text 做这件事：那个动作依赖 QQ 侧的语音转写结果，
   * 而**自己发出去的**语音根本不会产生转写（实测 retcode=100「消息中不包含语音」）。
   * 想让 AI 确认「语音真的发出去了」，唯一可靠的证据是 get_msg 回读到的 record 段。
   * 返回 { confirmed, file, duration } 或 null（读不回来不影响"已发送"这个事实）。
   */
  // @bridge-function verifyVoiceMessageSent from voice

  /**
   * AI 通道入口：解析引用 → 限流 → 发送 → 记账 → 回读校验。
   * 返回 { messageId, detail, verified, readback }。
   */

  // ── QQ AI 语音（TTS）─────────────────────────────────────────────────────
  // 合成用 SnowLuma 的 get_ai_record（QQ 官方 AI 语音），返回 SILK_V3 裸流；
  // 发送直接复用 sendVoiceForV2 —— 频率限制、审计、回读、格式探测都不用重写。
  // 纯逻辑（文本清洗、音色映射、SILK 判定、合成群选择）在 src/tts.js，可单测。
  // 用动态 import 而不是顶部 import：bridge.js 顶部每一行 import 都落在某个补丁的 hunk 里，
  // 再加一条会把两个组的补丁拧在一起（拆补丁时踩过这个坑）。
  let ttsModulePromise = null;
  let ttsSync = null;
  // 构建 prompt 是同步流程，不能 await；启动时先把 tts.js 的纯函数缓存一份。
  void import('../tts.js').then((m) => { ttsSync = m; }).catch(() => {});
  // @bridge-function ttsHelpers from tts

  /** 语音能力说明：她自己决定发不发；首选原生工具，工具缺席时用 [语音] 前缀兜底。 */
  // @bridge-function ttsPromptHint from tts

  // @bridge-function ttsCfg from tts

  // QQ 官方语音「合成即发送」的标记：key -> { seq, key, at, fingerprint }。
  // 只有「刚合成那条」自己来发送才跳过（见 voice-dedupe.js），别的一律照常发。
  const autoVoiceSentAt = new Map();
  let autoVoiceSeq = 0;

  /** 按会话取 TTS 配置：socialV2.tts.byKey 里配了该 key 就覆盖全局值。 */
  // @bridge-function ttsCfgForKey from tts

  /** 调 SnowLuma 合成一段 AI 语音，返回 SILK_V3 的 Buffer。 */
  /** 本地情感 TTS（ChatTTS 常驻服务）：返回 wav 的 Buffer。失败抛错，由调用方决定是否回落 QQ。 */
  // @bridge-function synthesizeLocalTts from tts

  /** 统一合成入口：provider=local 走本地 ChatTTS，失败或未配置时回落 QQ 官方 AI 语音。 */
  // @bridge-function synthesizeTts from tts

  // @bridge-function synthesizeAiVoice from tts

  /** [语音] 前缀的公共实现：合成 + 落盘 + 发送，返回可直接 sendJson 的对象。 */
  // @bridge-function voiceDirectiveSend from tts

  // @bridge-function sendVoiceForV2 from tts

  // 发送一个收藏表情（按 emoji_id/url/md5 解析，发图片段）。
  // @bridge-function sendStickerV2 from media-send

  // 更新本地 AI 认知（含义/标签/用法）。
  // @bridge-function applyStickerNoteV2 from media-send

  // 发送一张图片（任意 URL 或 base64），镜像 sendStickerV2 的 image 段发送路径。
  // 与收藏表情不同：不经过表情库，直接下载/解码后发 image 段，用于出图 /draw 等场景。
  // @bridge-function sendImageV2 from media-send

  // 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。
  // @bridge-function setStickerRemarkV2 from media-send

  // 收藏聊天里的一张表情（add_custom_face），并按 AI 看到的含义写简短备注（modify_custom_face）。
  // @bridge-function collectStickerV2 from media-send

  // @bridge-function saveSlangStore from slang-runtime

  // @bridge-function queueSlangTask from slang-runtime

  // @bridge-function ensureSlangLearnerSession from slang-runtime

  // @bridge-function invalidateSlangLearnerSession from slang-runtime

  // @bridge-function waitLearnerTurn from slang-runtime

  // @bridge-function runSlangExtraction from slang-runtime

  // 联网考究一轮（web_search + web_fetch 抓正文）实测 70~90 秒，多词多页会更久，
  // 120 秒的默认等 turn 超时会踩线，这里单独放宽。
  const RESEARCH_TURN_TIMEOUT_MS = Math.max(120000, Number(cfg.slang?.researchTimeoutMs) || 300000);

  // @bridge-function runSlangResearch from slang-runtime

  // @bridge-function maybeQueueSlangExtraction from slang-runtime

  // 黑话学习素材入口：群聊普通消息进入滚动窗口（命令/角色控制语不学；
  // 只学当前消息自己的文字，不学引用原文）。一代/二代共用。
  // @bridge-function feedSlangWindow from slang-runtime

  // AI 提交黑话候选的限频：防止单个会话在短时间内刷大量候选。
  // @bridge-function allowSlangSubmit from slang-runtime

  // 返回给 AI 的“公开黑话条目”（只含安全展示字段，不泄露内部字段）。
  //
  // 刻意**不含 evidence**：证据行的形状是 `{ key, sender, text, time }`，
  // 其中 text 是提交该词条的那个会话里的消息片段、key 是那个会话的名字。
  // 黑话库是全群共享的，带上 evidence 就等于让 A 群的 AI 读到 B 群的会话名和原话。
  // 控制台要证据走 `GET /api/slang`（原始条目，含 evidence，仅控制台可达）。
  // @bridge-function publicSlangEntry from slang-runtime

  // 已确认黑话的公开列表（按出现次数排序，最多 injectMax 条）。
  // @bridge-function confirmedSlangListV2 from slang-runtime

  // @bridge-function withSlangContext from slang-runtime

  // 附件转存的**事实**：按会话累积「自上次投递以来」的转存结果，投递时一次拼进 prompt。
  // 为什么不信静态能力提示：只写「会自动转存」时模型会据此编「存好了」（实测就发生了）。
  // 事实块明确列出 ok/dup/skipped/failed 与台账 id，并钉死「没写已转存就不许说存好了」。
  const archiveFactsByKey = new Map(); // key -> [{status,name,bytes,id,reason}]
  // @bridge-function pushArchiveFacts from context-services

  // @bridge-function withArchiveFactsHint from context-services

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 否则这是一个「静默无响应」陷阱：消息全被丢弃，用户只看到 QQ 上毫无反应。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }
  // 未配置管理员 QQ 时，一串功能会「静默失灵」：审批永远无法被回答（agent 一直等到超时）、
  // 管理命令全部被拒、封闭 agent 模式实际不可达。这里在启动日志里说清楚，避免排查时误判。
  if (!cfg.ownerQQ) {
    log('⚠️  未配置 ownerQQ：审批/管理命令/封闭 agent 模式将全部不可用。请在 config.json 或控制台「访问与安全」页填写管理员 QQ');
  }
  if (cfg.socialV2?.voice?.allowAbsolutePath === true) {
    // 该开关曾经允许 AI 发送语音库之外的任意本机音频文件（prompt injection 可用来外发文件）。
    // 现在无论开关如何，AI 通道都只接受语音库内的文件；这里提示它已经不再放宽边界。
    log('ℹ️  socialV2.voice.allowAbsolutePath=true 已不再放宽 AI 通道：AI 发的语音始终只允许来自语音库（库外文件请用语音工具/CLI 发送）');
  }

  // DSH 侧
  // DSH 桌面版每次启动都会换 web 端口（5297 → 13326 → …），config.json 里的 baseUrl
  // 迟早会过期。先探测一次，过期就按 host 进程的监听端口重新发现并写回 config.json。
  try {
    const found = await discoverDshBaseUrl({ current: cfg.dsh.baseUrl, log });
    if (found.changed) {
      cfg.dsh.baseUrl = found.baseUrl;
      persistDshBaseUrl(found.baseUrl);
      log(`DSH 地址已更新：${found.baseUrl}`);
    } else if (found.found) {
      log(`DSH 地址可用：${cfg.dsh.baseUrl}`);
    } else {
      log(`⚠️ DSH 地址不可用（${cfg.dsh.baseUrl || '(未配置)'}）：DSH 启动后桥接会自动重新发现`);
    }
  } catch (error) {
    log(`DSH 地址探测失败：${error?.message ?? error}`);
  }
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    // true=用户在 config.json 里显式填的；false=从日志猜的。猜来的不优先于离线铸造。
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // 默认只允许把 launch token 交给回环地址；远程 DSH 需要显式 opt-in（见 dsh-client.ensureAuth）。
    allowRemote: cfg.dsh.allowRemote === true
  });
  // DSH 的模型目录 RPC：0.1.5 是 `session/modelCatalog`。**不能走基类门面**
  // `api.sessions.modelCatalog` —— 桥接钉住的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
  // 的 sessions 门面里根本没有这个方法（只有 `models` → 已下线的 `session/models`），
  // 调用会抛 “api.sessions.modelCatalog is not a function”，让思考强度档位静默退回内置清单。
  // 这里直接用桥接自己覆写的 callUnary（它本来就是为「不依赖旧版客户端域方法」而存在的），
  // 并保留一次 `session/models` 回落以兼容更老的 DSH。
  const modelCatalogErrorLogged = new Set();
  // @bridge-function fetchModelCatalog from context-services
  return {
    get voiceSendTimes() { return voiceSendTimes; },
    get ttsModulePromise() { return ttsModulePromise; }, set ttsModulePromise(v) { ttsModulePromise = v; },
    get ttsSync() { return ttsSync; }, set ttsSync(v) { ttsSync = v; },
    get autoVoiceSentAt() { return autoVoiceSentAt; },
    get autoVoiceSeq() { return autoVoiceSeq; }, set autoVoiceSeq(v) { autoVoiceSeq = v; },
    get RESEARCH_TURN_TIMEOUT_MS() { return RESEARCH_TURN_TIMEOUT_MS; },
    get archiveFactsByKey() { return archiveFactsByKey; },
    get api() { return api; },
    get modelCatalogErrorLogged() { return modelCatalogErrorLogged; },
  };
}
