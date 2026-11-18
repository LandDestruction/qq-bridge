// config-load: extracted bridge responsibilities; no startup side effects.
// Live dependencies: REASONING_EFFORT_DEFAULT, ROLE_INJECT_MAX_CHARS_DEFAULT, ROOT, applyRoleInjectLimit, discoverDshLaunchToken, log, normalizeFileArchiveConfig, normalizeIdList, normalizeObserveConfig, normalizeOwnerQQ, normalizeReasoningEffort, path, readJsonSafe, roleInjectMaxChars
// D70：AI 黑名单默认值。定义在工厂外，避免把代码规模闸里冻结的 createConfigLoad/loadConfig 撑大。
// socialV2.sticker 的默认值：两处默认块（工厂内默认 + 旧配置补全）共用一份，
// 避免「改了这里忘了那里」，也不把冻结的 createConfigLoad/loadConfig 撑大。
const STICKER_DEFAULTS = Object.freeze({
  enabled: true,             // 表情包体系总开关
  syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
  maxListCount: 100,         // qq_list_stickers 单次最大返回数
  includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
  // 表情策略常驻：以前只在「本轮有图/刚用过」时才铺开千字策略，结果平时几乎不发表情。
  // 常驻只占稳定前缀约 900 token（97% 命中，约 ¥0.02/M），换来「每轮都知道能发表情」。
  alwaysInPrompt: true,
  promptMaxStickers: 14,     // 提示里最多列出的常用表情数（多给几张，少调一次 list）
  perHourMax: 30,            // 每小时最多发表情张数（0=不限）：只防跑飞，不限制正常量
  collect: Object.freeze({
    enabled: true,           // AI 收藏他人表情总开关
    maxPerMinute: 2,         // 每分钟最多收藏次数
    maxPerHour: 10,          // 每小时最多收藏次数
    maxRemarkChars: 20       // 收藏时备注最大长度
  })
});
const DEFAULT_AI_BLACKLIST = Object.freeze({
  enabled: false,
  qq: [],
  mode: 'reduce',            // reduce=降频（非 @ 类唤醒不触发）；silent=连 @ 都不回
  minIntervalMs: 10 * 60 * 1000,
  perHourMax: 3,
  atMeReply: true            // false：即使是 @ 也不回（优先级高于 reduce）
});
// ⑨ Token 三项控制（2026-10-28）：黑话学习限流 / 单轮步数上限 / 聊天模型白名单的默认值。
// 常量与收敛函数都放工厂外，避免把代码规模闸里冻结的 createConfigLoad/loadConfig 撑大。
const SLANG_LEARN_DEFAULTS = Object.freeze({
  enabled: true,             // false = 回退到旧行为：不判空档、不限每日批次、不限单轮步数
  mode: 'daily',             // 'daily'=每天累计到 at 集中跑一次；'live'=旧的实时触发（回退开关）
  at: '04:20',               // daily 模式的本地触发时间 HH:MM（默认避开 09-12 / 14-18 高峰）
  freshSessionPerBatch: true,// 每批开始前重置学习会话：不重置的话上下文会越滚越大，单轮 prompt 能到几十万 token
  dailyRuns: 1,              // daily：每天最多跑几批（保险）；live：每天最多跑几轮。0=不限
  maxStepsPerRun: 12,        // 黑话学习单轮步数上限（0=不限）；与普通聊天 turnMaxSteps 互相独立
  onlyOffPeak: true,         // live 模式：落在 peakPause 窗口内就延后到窗口结束，而不是丢弃
  queueMax: 6                // 待学 key 积压上限：超出时只保留最近 N 个，避免无限排队
});
const SLANG_LEARN_AT_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
/** 'HH:MM' 归一化：非法值回退默认（04:20），避免一个手滑的字符串让整批学习永不触发。 */
export function normalizeSlangLearnAt(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!SLANG_LEARN_AT_RE.test(text)) return SLANG_LEARN_DEFAULTS.at;
  const [hh, mm] = text.split(':');
  return `${String(Number(hh)).padStart(2, '0')}:${mm}`;
}
const TURN_MAX_STEPS_DEFAULT = 8; // 普通聊天单轮步数上限（0=不限）；10-29 由 25 降到 8：长尾长轮吃掉了 61% 的花费
// 聊天模型白名单默认值。2026-10-29 放宽：原来只放 `*/*deepseek*flash*`，但这台机器的
// 降级链里有 deepseek-v4-pro（同属 deepseek 系），flash 限定会把 pro 降级也挡掉，降级时
// 反而没模型可用；放宽到 `*/*deepseek*` 后 pro 可用，glm/mimo 仍挡着，需要的人自己在
// 控制台把具体模型加进来（设置页可编辑这条白名单，见 console/config-admin.js）。
const ALLOWED_CHAT_MODEL_DEFAULT = Object.freeze(['*/*deepseek*']);

function clampCount(value, fallback, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}
export function normalizeSlangLearnConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: src.enabled !== false,
    mode: src.mode === 'live' ? 'live' : SLANG_LEARN_DEFAULTS.mode, // 只认 live，其余一律 daily（默认）
    at: normalizeSlangLearnAt(src.at),
    freshSessionPerBatch: src.freshSessionPerBatch !== false,
    dailyRuns: clampCount(src.dailyRuns, SLANG_LEARN_DEFAULTS.dailyRuns, 1000),
    maxStepsPerRun: clampCount(src.maxStepsPerRun, SLANG_LEARN_DEFAULTS.maxStepsPerRun, 1000),
    onlyOffPeak: src.onlyOffPeak !== false,
    queueMax: clampCount(src.queueMax, SLANG_LEARN_DEFAULTS.queueMax, 100)
  };
}
// 私聊攒句数加好友提示（2026-10-30）：sentCount 到 afterMessages 就提示一次，之后隔 cooldownMs 才再提示。
// 严格布尔（enabled 只认 false 关闭）+ 数字 clamp：配置是用户可编辑的，别让一个字符串把提示刷屏。
const PRIVATE_HINT_DEFAULTS = Object.freeze({ enabled: true, afterMessages: 15, cooldownMs: 24 * 60 * 60 * 1000 });
function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
export function normalizePrivateHint(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: src.enabled !== false,
    afterMessages: clampInt(src.afterMessages, PRIVATE_HINT_DEFAULTS.afterMessages, 5, 200),
    cooldownMs: clampInt(src.cooldownMs, PRIVATE_HINT_DEFAULTS.cooldownMs, 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000)
  };
}
// 纯净模式（2026-10-30）：打开后 prompt 只留「身份+本轮消息」，记忆/黑话/表情/接力这些段全去掉。
// 严格布尔：只认 true（'true' 不生效，避免配置文件里手写字符串把模式拨开却不知道）。
export function normalizePureMode(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { enabled: src.enabled === true };
}
// 素材库相关开关（2026-10-30）：目前只有「下载完自动解压」这是用户会在设置页拨的。
// 严格布尔：只认 true / 'true'，别用 Boolean()——'' 和 'false' 都会变成 true，等于关不掉。
export function normalizeLibrary(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    autoExtract: src.autoExtract === true,
    // 预留位：将来「解压后把原 zip 归档」用；现在只存值，不产生行为。
    extractKeepZip: src.extractKeepZip === undefined ? true : src.extractKeepZip === true
  };
}

// agent 段（P1，2026-10-31）：让「非 DSH 的 agent」也能按配置跑。默认 dsh = 零行为变化。
// 注意本文件会被审计沙箱直接跑（不能 import src/agent/contract.js），所以这里只做最小归一，
// 口径与 contract.js 的 normalizeAgentConfig 保持一致：type 只认 AGENT_TRANSPORTS，
// 非法回退 dsh；baseUrl/apiKey/model 去空白；timeoutMs 夹 5s~10min；maxToolRounds 夹 1~20。
const AGENT_RUNTIMES = ['dsh', 'openai', 'http'];
const AGENT_TIMEOUT_DEFAULT = 120000;
const AGENT_MAX_TOOL_ROUNDS_DEFAULT = 8;
function agentToolAllowlist(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name || name.length > 80) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length >= 80) break;
  }
  return out;
}

function plainAgentExtraBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  let count = 0;
  for (const [key, val] of Object.entries(value)) {
    if (typeof key !== 'string' || !key || key.length > 64) continue;
    if (typeof val === 'function' || typeof val === 'symbol' || typeof val === 'bigint') continue;
    out[key] = val;
    count += 1;
    if (count >= 32) break;
  }
  try {
    JSON.stringify(out);
  } catch {
    return {};
  }
  return out;
}
export function normalizeAgentRuntime(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let type = typeof src.type === 'string' ? src.type.trim().toLowerCase() : '';
  if (!type) type = 'dsh';
  if (!AGENT_RUNTIMES.includes(type)) type = 'dsh';
  const timeoutMs = Number(src.timeoutMs);
  const maxToolRounds = Number(src.maxToolRounds);
  return {
    type,
    baseUrl: typeof src.baseUrl === 'string' ? src.baseUrl.trim() : '',
    // apiKey 只在运行期用；GET /api/config 永远不回明文（config-admin 里按敏感键处理）。
    apiKey: typeof src.apiKey === 'string' ? src.apiKey : '',
    model: typeof src.model === 'string' ? src.model.trim() : '',
    timeoutMs: Number.isFinite(timeoutMs) ? Math.min(600000, Math.max(5000, Math.floor(timeoutMs))) : AGENT_TIMEOUT_DEFAULT,
    maxToolRounds: Number.isFinite(maxToolRounds) ? Math.min(20, Math.max(1, Math.floor(maxToolRounds))) : AGENT_MAX_TOOL_ROUNDS_DEFAULT,
    // 额外请求体：只做浅归一，非对象一律空；具体内容由后端自己解释（例如 Qwen 的 enable_thinking）。
    extraBody: plainAgentExtraBody(src.extraBody),
    // 暴露给模型的工具白名单（空 = 全部）；本地小模型工具太多会反复调工具。
    tools: agentToolAllowlist(src.tools)
  };
}

export function normalizeAllowedProviderModels(raw) {
  if (!Array.isArray(raw)) return [...ALLOWED_CHAT_MODEL_DEFAULT];
  return raw.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean); // 显式 [] = 不过滤（回退开关）
}
export function normalizeTokenControls(socialV2) {
  const src = socialV2 && typeof socialV2 === 'object' && !Array.isArray(socialV2) ? socialV2 : {};
  const routing = src.modelRouting && typeof src.modelRouting === 'object' && !Array.isArray(src.modelRouting) ? src.modelRouting : {};
  return {
    ...src,
    slangLearn: normalizeSlangLearnConfig(src.slangLearn),
    turnMaxSteps: clampCount(src.turnMaxSteps, TURN_MAX_STEPS_DEFAULT, 1000),
    modelRouting: { ...routing, allowedProviderModels: normalizeAllowedProviderModels(routing.allowedProviderModels) },
    // 新增两段：不在这里收敛的话运行期 cfg.socialV2.private.addFriendHint / pureMode 恒 undefined。
    private: { ...(src.private && typeof src.private === 'object' && !Array.isArray(src.private) ? src.private : {}), addFriendHint: normalizePrivateHint(src.private && src.private.addFriendHint) },
    pureMode: normalizePureMode(src.pureMode)
  };
}

// 视觉路由开关：默认只有「真图片」会切到能看图的模型；表情包只在显式打开时才算。
// describeFirst（默认 true）：图片交给桥接自己转述成文字，不再把会话切到视觉模型。
function normalizeMediaVision(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return { ...raw, stickers: raw.stickers === true, describeFirst: raw.describeFirst !== false };
}

// 本地画面记忆：dhash 查表的阈值与容量（config.json 可写）。
function normalizeImageMemory(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const dist = Number(raw.maxDistance);
  const cap = Number(raw.maxEntries);
  return {
    enabled: raw.enabled !== false,
    maxDistance: Number.isFinite(dist) ? Math.max(0, Math.min(16, Math.round(dist))) : 6,
    maxEntries: Number.isFinite(cap) ? Math.max(100, Math.min(50000, Math.round(cap))) : 5000
  };
}

// 梗库玩梗尺度 0~100：越大越爱接梗（config.json 可写，坏值一律回默认 50）。
function normalizeMemeWiki(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const n = Number(raw.spiciness);
  const level = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 50;
  return { ...raw, spiciness: level };
}

function applyConfigNormalization(deps, cfg, file) {
// socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
// 不能因为外层 spread 覆盖而丢失默认开关。
cfg.socialV2.tools = {
  getPrompt: true,
  getUnread: true,
  getRecent: true,
  socialState: true,
  sendGroup: true,
  sendPrivate: true,
  reply: true,
  sendBurst: true,
  sendMessage: true,
  waitMessages: true,
  feedback: true,
  getMyRecent: true,
  getMessageDetail: true,
  getActiveMembers: true,
  setWakeConfig: true,
  markRead: true,
  memory: true,
  slangQuery: true,
  slangSubmit: true,
  getImages: true,
  getForwardMsg: true,
  sendPoke: true,
  listStickers: true,
  getStickerImage: true,
  sendSticker: true,
  setStickerRemark: false,
  stickerNote: true,
  collectSticker: true,
  getSelfImage: true,
  sendVoice: false,
  tts: true,
  setPersona: true,
  searchHistory: true,
  memoryEvent: true,
  stickerAutoDescribe: true,
  ...(cfg.socialV2.tools ?? {})
};

// socialV2.voice：语音发送（把准备好的音频文件当 QQ 语音发出去）。
// dir 为相对仓库根目录的语音库路径；AI 的 qq_send_voice 默认只能从这个目录取文件，
// 绝对路径需要显式开 allowAbsolutePath（默认关，避免 prompt injection 读到任意本地文件）。
//
// 默认**关闭**（enabled/sendVoice 均为 false）：语音是"开口说话"的强表达，且需要你先准备好
// 语音库内容。没放音频就让 AI 发语音只会得到一串错误。把音频放进 audio/ 后，
// 在控制台「二代仿真 → 语音库与语音发送」里打开开关即可。
cfg.socialV2.voice = {
  enabled: false,
  dir: 'audio',
  maxSeconds: 300,
  maxBytes: 20 * 1024 * 1024,
  maxPerMinute: 2,
  maxPerHour: 10,
  allowAbsolutePath: false,
  // 音量：默认倍数（1 = 原样）+ 智能音量档位 + ffmpeg 位置（空 = 走 PATH）。
  // SnowLuma 的 record 段没有增益字段，所以音量必须在本地先调好再发。
  defaultVolume: 1,
  loudness: 'normal',
  ffmpegPath: '',
  autoReadback: true,
  ...(cfg.socialV2?.voice ?? {})
};

// socialV2.sticker：旧配置可能缺少 collect 子项，这里按默认值深度合并一份。
cfg.socialV2.sticker = {
  ...STICKER_DEFAULTS,
  ...(cfg.socialV2?.sticker ?? {}),
  collect: { ...STICKER_DEFAULTS.collect, ...((cfg.socialV2?.sticker?.collect) ?? {}) }
};

// socialV2.media：图片/表情的数量与体积上限。旧配置没有这一段，必须深度合并出默认值，
// 否则 `{...defaults, ...file.socialV2}` 里缺失的 media 会取到 undefined（等于无上限判断）。
cfg.socialV2.media = {
  maxBytes: 8 * 1024 * 1024,
  maxPixels: 64_000_000,
  maxCount: 5,
  ...((cfg.socialV2?.media && typeof cfg.socialV2.media === 'object' && !Array.isArray(cfg.socialV2.media)) ? cfg.socialV2.media : {})
};

// socialV2.quiet：静默观战（偶尔才看一眼群）。潜水期只认被点名，关键词 / 提问 / 概率
// 与定时回看全部吞掉；被点名后进入在场态，自己停止说话 engagedMs 后才退回潜水。
// config.json 里可以只写想改的那几项，其余取这里的默认值。
cfg.socialV2.quiet = {
  enabled: true,
  groupsOnly: true,
  engagedMs: 6 * 60 * 1000,
  glanceMinMs: 8 * 60 * 1000,
  glanceMaxMs: 20 * 60 * 1000,
  glanceProbability: 0.5,
  ...((cfg.socialV2?.quiet && typeof cfg.socialV2.quiet === 'object' && !Array.isArray(cfg.socialV2.quiet)) ? cfg.socialV2.quiet : {})
};

// socialV2.style：发言风格（src/bridge/speaking-style.js）。修的是「太人机」：
// 身份从「负责回复的人」改成「可以插话、也可以不说话的群成员」。
// examples=false 只留规则不放例子（省 prompt）；enabled=false 回到旧文案。
cfg.socialV2.style = {
  enabled: true,
  examples: true,
  brevity: true,
  ...((cfg.socialV2?.style && typeof cfg.socialV2.style === 'object' && !Array.isArray(cfg.socialV2.style)) ? cfg.socialV2.style : {})
};

// socialV2.initialPromptMaxChars：会话「初始提示词」的字数上限。config.json 是用户可编辑的，
// 手工写进字符串/负数/超大值时要收敛到安全区间，否则要么保存接口永远报"过长"，要么等于没上限。
{
  const raw = Number(cfg.socialV2?.initialPromptMaxChars);
  cfg.socialV2.initialPromptMaxChars = Number.isFinite(raw) && raw > 0
    ? Math.min(8000, Math.max(100, Math.round(raw)))
    : 2000;
}

// DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，
// 不落盘、不可推导；只有启动器把 `dsh web` 的 stdout 重定向到文件时才能从日志读到。
// 所以这里发现的 token 只是兜底，主路径是客户端用 ~/.dsh 里持久化的签名密钥
// 离线铸造会话 Cookie（见 dsh-client 的 mintBrowserSessionCookie）。
// authTokenExplicit 记录「token 是用户填的还是这里猜的」，客户端据此排优先级。
cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
if (!cfg.dsh.authToken) cfg.dsh.authToken = (0, deps.discoverDshLaunchToken)();

// 思考强度可能被手工改成非法值（config.json 是用户可编辑的）。DeepSeek 适配器对非法值
// 会硬拒绝，若直接透传会让每个会话的 selectModel 每次都失败；这里统一规范化并告警。
try {
  cfg.dsh.reasoningEffort = (0, deps.normalizeReasoningEffort)(cfg.dsh.reasoningEffort ?? deps.REASONING_EFFORT_DEFAULT);
} catch (error) {
  (0, deps.log)(`⚠️ config.json 的 dsh.reasoningEffort「${cfg.dsh.reasoningEffort}」非法，已回退 ${deps.REASONING_EFFORT_DEFAULT}（${error?.message ?? error}）`);
  cfg.dsh.reasoningEffort = deps.REASONING_EFFORT_DEFAULT;
}

// ⚠️ loadConfig 是白名单式逐段构造：新增配置段必须在这里显式搬运，否则运行期恒 undefined（imagegen 漏搬曾导致出图 502）。
// 下面两段的默认值收敛放在工厂外（见文件头常量），不把冻结的 loadConfig 撑大。
cfg.imagegen = { ...(file.imagegen ?? {}) };
cfg.webSearch = { ...(file.webSearch ?? {}) };

// 群文件转存（fileArchive）与观察学习（observe）都必须在这里显式搬运，
// 否则运行期 cfg.fileArchive / cfg.observe 是 undefined，功能静默不生效。
// 两段都做「类型收敛 + 默认值」：config.json 是用户可编辑的，不能被一个字符串搞崩。
cfg.fileArchive = (0, deps.normalizeFileArchiveConfig)(file.fileArchive);
cfg.observe = (0, deps.normalizeObserveConfig)(file.observe);
// 素材库开关：不在这里搬运的话，config.json 写了 library.autoExtract 运行期也恒 undefined。
cfg.library = normalizeLibrary(file.library);
// agent 段同样走白名单式构造：不搬的话运行期 cfg.agent 恒 undefined（P1 的 transport 选择读它）。
cfg.agent = normalizeAgentRuntime(file.agent);
// 身份锁：允许用哪些 QQ 号说话（src/safety/identity-lock.js 做具体判定）。
// 白名单式构造：不在这里搬，运行期 cfg.identity 恒 undefined → 身份锁静默失效。
cfg.identity = { ...(file.identity ?? {}) };
cfg.role = { maxInjectChars: deps.ROLE_INJECT_MAX_CHARS_DEFAULT, ...(file.role ?? {}) };
deps.roleInjectMaxChars = (0, deps.applyRoleInjectLimit)(cfg.role.maxInjectChars);
if (deps.roleInjectMaxChars !== cfg.role.maxInjectChars) {
  (0, deps.log)(`人格注入上限已按范围校正为 ${deps.roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~20000）`);
}

// ⑨ Token 三项控制：slangLearn / turnMaxSteps / allowedProviderModels 的默认值统一收敛。
cfg.socialV2 = normalizeTokenControls(cfg.socialV2);
// 梗库玩梗尺度（0~100）：白名单式搬运，否则运行期恒 undefined。
cfg.socialV2.memeWiki = normalizeMemeWiki(cfg.socialV2.memeWiki);
// 表情包是否触发视觉模型（默认否，见 normalizeMediaVision）。
cfg.socialV2.mediaVision = normalizeMediaVision(cfg.socialV2.mediaVision);
// 本地画面记忆（dhash 查表）的阈值与容量。
cfg.socialV2.imageMemory = normalizeImageMemory(cfg.socialV2.imageMemory);
// 纯净模式：运行时把单轮步数上限压到 6（只改内存 cfg，不改 config.json；
// 热重载会重新计算）。6 与 src/pure-mode.js 的 PURE_MODE_TURN_MAX_STEPS 保持一致；
// 不 import 是因为这个文件会被审计 VM 用 vm.runInContext 直接跑源码，import 会 SyntaxError。
if (cfg.socialV2.pureMode && cfg.socialV2.pureMode.enabled === true) cfg.socialV2.turnMaxSteps = 6;


  return cfg;
}



export function createConfigLoad(deps) {

// @bridge-function loadConfig:start
function loadConfig() {
  const p = deps.path.join(deps.ROOT, 'config.json');
  const file = (0, deps.readJsonSafe)(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      // 是否允许把 DSH launch token 发往非回环地址（默认 false：那是进程启动凭据）
      allowRemote: false,
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: (0, deps.normalizeOwnerQQ)(file.ownerQQ),
    allow: {
      private: (0, deps.normalizeIdList)(file.allow?.private ?? file.allow?.privates ?? []),
      groups: (0, deps.normalizeIdList)(file.allow?.groups ?? file.allow?.group ?? []),
      // 临时通行证：所有人可私聊（额度在 handleIncoming 里扣）
      privateOpen: file.allow?.privateOpen === true
    },
    deny: {
      private: (0, deps.normalizeIdList)(file.deny?.private ?? file.deny?.privates ?? []),
      groups: (0, deps.normalizeIdList)(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    // 价目表覆盖项（可选）。留空即用 src/model-prices.js 的官方默认价。
    pricing: file.pricing ?? null,
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [1, 3, 6],
      injectMax: 8,
      learnerPreset: 'qq-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      // 全局发送节奏（防 QQ 风控 + 更像人）：任何一条发到 QQ 的消息都先排队，
      // 两条之间至少 minGapMs，并随上一条字数增长；表情短、语音长。
      pacing: {
        enabled: true,
        minGapMs: 1400,      // 两条消息之间的最小间隔
        perCharMs: 90,       // 上一条每多一个字的额外间隔
        maxGapMs: 12000,     // 上限（长文不让下一条等太久）
        voiceGapMs: 4000,    // 语音前后至少隔这么久
        stickerGapMs: 500,   // 表情：斗图要跟得上手，间隔短得多
        imageGapMs: 1500,    // 图片
        jitterMs: 300        // 0..jitter 的随机抖动，避免节奏太机械
      },
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat-v2',
      provideRecommendations: true,
      tools: {
        getPrompt: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        setStickerRemark: false,
        stickerNote: true,
        collectSticker: true,
        getSelfImage: true
      },
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
        preSleepWaitMs: 300000,          // 默认沉睡前至少等待/观察 5 分钟（后台可调）
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话就可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 8000,
        maxWakePerMinute: 1,
        maxWakePerHour: 12,
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      sticker: { ...STICKER_DEFAULTS, collect: { ...STICKER_DEFAULTS.collect } },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3
      }, aiBlacklist: DEFAULT_AI_BLACKLIST,
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20,
        inlineWakeMessages: true,
        wakeMessageLimit: 24,
        wakeRecentLimit: 12,
        wakeMaxChars: 9000
      },
      // 操作者在控制台为单个会话预写的「初始提示词」的字数上限（只在首次唤醒时注入一次）。
      // 它不是安全边界，只是防止误粘贴一篇长文把首次唤醒的 prompt 撑爆。
      initialPromptMaxChars: 2000,
      // 图片/表情（含动图）的数量与体积上限。QQ 的动图表情常见 1~4MB，
      // 旧的 4MB 单条总上限会误伤；这里默认 8MB，仍受 DSH 的 20MB/64MP 限制约束。
      media: {
        maxBytes: 8 * 1024 * 1024,
        maxPixels: 64_000_000,
        maxCount: 5
      },
      ...(file.socialV2 ?? {})
    }
  };

  return applyConfigNormalization(deps, cfg, file);
}
// @bridge-function loadConfig:end

  return { loadConfig };
}
