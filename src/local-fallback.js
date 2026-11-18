// 本地小模型兜底通道（外部网关/上游全断时，仍能在白名单会话里回一句话）。
//
// 为什么是「纯文本直发」而不是把 DSH 指到本地模型：
//   实测（state/token-usage.jsonl，433 轮）QQ 会话 prompt 中位数 16 万、P90 30 万 token，
//   光是 45 个 MCP 工具 + 预设 + 人格卡的固定开销就有 26,027 token。8B Q4 在 12GB 卡上
//   最多 32K 上下文，连固定开销都快装不下，更别说对话历史。
//   所以这条通道**不复用主会话上下文**：自带一份 900 字精简人格 + 最近几轮消息，
//   只让模型生成「一句要发出去的话」，由桥接直接 sendToQQ。
//
// 能力边界（降级期与主链路的差异，文档要写清）：
//   · 只能发文字：发图 / 语音 / 表情包 / 拍一拍 / 撤回都做不到；
//   · 读不了未读、设不了唤醒、查不了历史 —— 它不调任何工具；
//   · 看不到图片/语音内容（本地模型没有视觉和听觉）。
//
// 实测记录（qwen3:8b / RTX 3080 Ti / Q4_K_M / num_ctx 8192 / think:false）：
//   · 首次 2,975ms（含加载），之后单条 129~162ms，输出 13~26 token；
//   · 我这边 10 条真实群消息：单轮延迟中位 193ms / P90 266ms，生成 128 tok/s；
//   · 显存 6.31GB 全在 VRAM，keep_alive=0 卸载后归零；
//   · 质量：口语自然、能接梗（把「Token 在燃烧」接成「真·烧钱」），会自称人格名。
//   · 限制：单轮、无历史、无工具调用、图片/语音一律不会 —— 别在文档里夸大。
//
// 本文件里除 createLocalClient 之外都是纯函数，`scripts/test-local-fallback.mjs` 可以
// 直接 import 逐条覆盖（判定、裁剪、清洗、请求体、响应解析），不必起桥接或 ollama。

import { isModelCapacityError, isModelUnavailableError } from './model-fallback.js';
import { LOCAL_FALLBACK_DEFAULT_NAME, LOCAL_FALLBACK_PERSONA, renderFallbackPersona } from './local-fallback-persona.js';

export { LOCAL_FALLBACK_DEFAULT_NAME, LOCAL_FALLBACK_PERSONA, renderFallbackPersona };

/** 兜底通道默认参数（config.json 里可用 socialV2.localFallback 覆盖）。 */
export const LOCAL_FALLBACK_DEFAULTS = Object.freeze({
  enabled: true,
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3:8b',
  /** 单轮生成超时：验收要求 15 秒内出话，留 5 秒给排队/发送。 */
  timeoutMs: 10000,
  /** 健康探测超时：本地服务没起时绝不能拖慢主链路。 */
  probeTimeoutMs: 2000,
  /** 探测结果缓存时长：避免每条消息都去连一次不存在的服务。 */
  probeCacheMs: 30000,
  /** 带进 prompt 的历史条数（含当前这条）。8K 窗口下 8 条左右是甜点。 */
  historyMessages: 8,
  /** 单条历史消息的最大字数，超了截断（长文会把窗口吃光）。 */
  historyChars: 160,
  /** 生成上限。群里说话本来就短，200 token 足够，还能防模型啰嗦。 */
  maxTokens: 200,
  temperature: 0.8,
  topP: 0.9,
  /** ollama 空闲卸载：用户要打游戏，默认 10 分钟不活跃就放显存。 */
  keepAlive: '10m',
  /** 上下文窗口。8K 足够（人格 ~700 + 8 条历史 + 生成）。 */
  numCtx: 8192,
  /** 连续失败几次才切本地。1 次太敏感（一次抖动就降级），2 次起。 */
  triggerAfter: 2,
  /** 降级后多久内不再尝试切回主链路（防止主链路半死不活时来回抖）。 */
  recoverProbeMs: 60000,
  /** 本地回复的字数上限，超了按句子边界截断。 */
  maxReplyChars: 300
});

/** 数字型配置的读取：非法值一律回落默认，避免 NaN 传进 fetch。 */
function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 合并并校验配置。传 null/undefined 得到全默认值（= 通道开启、连本机 ollama）。
 * @param {object|null|undefined} raw config.json 里的 socialV2.localFallback
 */
export function localFallbackCfg(raw) {
  const d = LOCAL_FALLBACK_DEFAULTS;
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const baseUrl = String(src.baseUrl ?? d.baseUrl).trim().replace(/\/+$/, '');
  return {
    enabled: src.enabled === undefined ? d.enabled : src.enabled === true || src.enabled === 'true',
    baseUrl: /^https?:\/\//i.test(baseUrl) ? baseUrl : d.baseUrl,
    model: String(src.model ?? d.model).trim() || d.model,
    timeoutMs: num(src.timeoutMs, d.timeoutMs, 1000, 120000),
    probeTimeoutMs: num(src.probeTimeoutMs, d.probeTimeoutMs, 200, 10000),
    probeCacheMs: num(src.probeCacheMs, d.probeCacheMs, 1000, 600000),
    historyMessages: num(src.historyMessages, d.historyMessages, 2, 40),
    historyChars: num(src.historyChars, d.historyChars, 20, 2000),
    maxTokens: num(src.maxTokens, d.maxTokens, 16, 2048),
    temperature: Number.isFinite(Number(src.temperature)) ? Math.min(2, Math.max(0, Number(src.temperature))) : d.temperature,
    topP: Number.isFinite(Number(src.topP)) ? Math.min(1, Math.max(0.01, Number(src.topP))) : d.topP,
    keepAlive: String(src.keepAlive ?? d.keepAlive).trim() || d.keepAlive,
    numCtx: num(src.numCtx, d.numCtx, 2048, 131072),
    triggerAfter: num(src.triggerAfter, d.triggerAfter, 1, 20),
    recoverProbeMs: num(src.recoverProbeMs, d.recoverProbeMs, 0, 3600000),
    maxReplyChars: num(src.maxReplyChars, d.maxReplyChars, 20, 2000)
  };
}

/**
 * 这次外部失败要不要切本地兜底。
 * 判定分两类：
 *   ① 明确的「外部不可用」错误（容量 503 / 额度 / 无健康账号 / 模型不可用）——立刻切；
 *   ② 其它错误（网络、超时、5xx）——连续失败到 triggerAfter 次才切，避免一次抖动就降级。
 * @param {{ errorMessage?: string, streak?: number, cfg: object }} p
 */
export function shouldTriggerLocalFallback({ errorMessage = '', streak = 0, cfg, fallbacksRemaining = 0 } = {}) {
  const c = cfg || LOCAL_FALLBACK_DEFAULTS;
  if (!c.enabled) return false;
  const msg = String(errorMessage || '');
  if (!msg) return false;
  // ① DSH 本身连不上 / 上游整体不可用（连不上、DNS 失败、socket 断、超时）：
  //    备用模型救不了这种错（切过去一样连不上），本地 8B 立刻接管。
  if (/(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network|timed?\s?out|aborted)/i.test(msg)) return true;
  // ② 容量类 / 模型不可用（503 no_healthy_account、额度用光、模型被下线）：
  //    **先让 config.dsh.modelFallbacks 里的备用模型顶上**，全部用尽才轮到本地 8B。
  //    否则一次瞬时 503 就会把群里的回复换成 8B —— 群里立刻能看出「说话变笨了」，
  //    跟「本地是最后一道防线」的定位正好相反。
  if (isModelCapacityError(msg) || isModelUnavailableError(msg)) {
    return Math.max(0, Number(fallbacksRemaining) || 0) === 0;
  }
  // ③ 其它错误：连续失败到 triggerAfter 次才切，避免一次抖动就降级。
  return Number(streak) >= c.triggerAfter;
}

/** 把一条历史消息压成一行「名字：内容」，超长截断（长文会把 8K 窗口吃光）。 */
function historyLine(entry, maxChars) {
  if (!entry) return '';
  const who = entry.isSelf ? '我' : String(entry.sender || entry.ownerLabel || '群友').slice(0, 16);
  let text = String(entry.plain ?? entry.text ?? '').replace(/\s+/g, ' ').trim();
  // 媒体类消息没有正文时给个占位，让模型知道「有人发了东西」而不是凭空断句
  if (!text && entry.hasMedia) text = entry.isSelf ? '[我发了一张图]' : '[图片]';
  if (!text) return '';
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
  return `${who}：${text}`;
}

/**
 * 组 prompt。刻意不用 JSON 工具协议，就是最朴素的 system + 对话，
 * 8B 模型在这种格式下最稳，也最省 token。
 * @param {{ persona?: string, history?: Array, incoming?: object|string, cfg?: object }} p
 * @returns {Array<{role: string, content: string}>}
 */
export function buildLocalMessages({ persona = null, history = [], incoming = null, cfg, nickname = '' } = {}) {
  // 人格里的名字必须换成线上真实昵称（别人的 QQ 群昵称），否则降级时会「换人」。
  // nickname 为空时退回默认名，保证离线测试与老调用方行为不变。
  const personaText = persona ? String(persona) : renderFallbackPersona(nickname || LOCAL_FALLBACK_DEFAULT_NAME);
  const c = cfg || LOCAL_FALLBACK_DEFAULTS;
  const lines = [];
  const picked = Array.isArray(history) ? history.slice(-Math.max(1, c.historyMessages - 1)) : [];
  for (const entry of picked) {
    const line = historyLine(entry, c.historyChars);
    if (line) lines.push(line);
  }
  // 当前这条如果已经在 history 末尾（常见：调用方把最新消息也放进了 recentMessages），不要重复。
  const incomingLine = incoming ? historyLine(typeof incoming === 'string' ? { text: incoming } : incoming, c.historyChars) : '';
  if (incomingLine && lines[lines.length - 1] !== incomingLine) lines.push(incomingLine);
  const transcript = lines.length
    ? `下面是群里最近的聊天记录（最后一条是你要回的那句）：\n${lines.join('\n')}\n\n直接给出你要发的那句话。`
    : '群里刚有人叫了你一声，但你没看到具体内容。随便接一句自然的话。';
  return [
    { role: 'system', content: personaText },
    { role: 'user', content: transcript }
  ];
}

/**
 * 清洗本地模型的输出。
 * 8B 模型常见的毛病（都是实测出来的，不是猜的）：
 *   · 套一层「回复：」、加引号、把思考过程也写出来、用 Markdown 列表；
 *   · 把「名字：内容」的对话记录格式接着往下写，甚至替别人编一句回复；
 *   · 原样复读你喂给它的那句话。
 * 这些直接发到群里很难看，所以统一在这里削掉。
 * @param {string} raw 模型原始输出
 * @param {{ maxChars?: number, speakers?: string[], echoOf?: string }} opts
 *   speakers：当前会话里出现过的名字，只有命中才当作「转录标签」剥掉（避免误伤「注意：…」这种正文）
 *   echoOf：喂进去的那句话，输出与它完全相同时判为复读，返回空串让调用方按失败处理
 */
export function cleanLocalReply(raw, { maxChars = 300, speakers = [], echoOf = '' } = {}) {
  let text = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  // 去掉 ``` 代码围栏
  text = text.replace(/```[\s\S]*?```/g, '').trim();
  // 去掉「思考过程」类前缀（qwen3 会输出 思考…/Thinking Process:）
  text = text.replace(/^\s*(思考|分析|thinking process|reasoning)\s*[:：][\s\S]*?\n(?=\S)/i, '').trim();
  // 去掉「回复：」「答：」「我说：」这类标签
  text = text.replace(/^\s*(回复|回答|答|我说|输出)\s*[:：]\s*/i, '').trim();

  // ── 转录格式回声 ──────────────────────────────────────────────────────
  // 模型有时会照着 prompt 里的「名字：内容」格式往下编，甚至替别人写一句。
  const known = new Set(['我', ...speakers.map((s) => String(s ?? '').trim()).filter(Boolean)]);
  const isLabel = (l) => /^[^：:\n]{1,16}[：:]/.test(l);
  let lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // ① 每一行都带「名字：」→ 这是把对话记录续写了，只留第一句（标签下一步再剥）
  if (lines.length > 1 && lines.every(isLabel)) {
    lines = [lines[0]];
    text = lines[0];
  }
  // ② 剥掉开头那个已知说话人的标签
  const labelMatch = /^([^：:\n]{1,16})[：:]\s*/.exec(text);
  if (labelMatch && known.has(labelMatch[1].trim())) text = text.slice(labelMatch[0].length).trim();
  // ③ 首行是「（思索）」这类短括注（抄了上一条消息的格式）→ 丢掉
  lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1 && /^[（(][^）)]{0,12}[）)]$/.test(lines[0])) {
    lines = lines.slice(1);
    text = lines.join('\n');
  }
  // ④ 原样复读了输入 → 当没说话
  const echo = String(echoOf ?? '').trim();
  if (echo && text.trim() === echo) return '';
  // ⑤ 首行就是复读、真正的话在后面（实测常见：模型先把对方那句抄一遍再回答）→ 丢掉首行
  if (echo) {
    lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1 && (lines[0] === echo || lines[0].replace(/^@\S+\s*/, '') === echo.replace(/^@\S+\s*/, ''))) {
      text = lines.slice(1).join('\n');
    }
  }

  // 整段被引号包住 → 去引号（模型很爱把整句话用「」或 "" 包起来）
  const quotePairs = [['「', '」'], ['“', '”'], ['"', '"'], ['『', '』'], ["'", "'"]];
  for (const [open, close] of quotePairs) {
    if (text.length > 2 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length).trim();
      break;
    }
  }
  // 去掉 Markdown 强调与标题符号，但保留换行（群里分条靠换行）
  text = text.replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2');
  text = text.replace(/^\s*[-*+]\s+/gm, '').replace(/^\s*\d+[.、)]\s+/gm, '');
  // 压掉多余空行与行首尾空白
  text = text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n').trim();
  if (!text) return '';
  if (text.length > maxChars) {
    // 按句子边界截断，别把半句话发出去
    const cut = text.slice(0, maxChars);
    const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('\n'));
    text = at > maxChars * 0.5 ? cut.slice(0, at + 1) : `${cut}…`;
  }
  return text;
}

/** ollama 原生 /api/chat 的请求体（比 OpenAI 兼容端点少一层包装，也少一次协议转换）。 */
export function buildLocalChatBody({ cfg, messages, keepAlive }) {
  const c = cfg || LOCAL_FALLBACK_DEFAULTS;
  return {
    model: c.model,
    messages,
    stream: false,
    keep_alive: keepAlive || c.keepAlive,
    // 关掉「思考」。实测（qwen3:8b）：开思考时 200 token 预算全被 reasoning 吃掉，
    // message.content 是空串，群里什么也发不出去；关掉后同样的 prompt 1.6 秒就能出话。
    // 对 ollama 0.40 是 think 字段；对不认识的模型是无害的多余字段。
    think: false,
    options: {
      temperature: c.temperature,
      top_p: c.topP,
      num_predict: c.maxTokens,
      num_ctx: c.numCtx
    }
  };
}

/** 解析 ollama /api/chat 的响应；形状不对就返回空文本（调用方按失败处理）。 */
export function parseLocalChatResponse(json) {
  const msg = json && json.message;
  const text = msg && typeof msg.content === 'string' ? msg.content : '';
  return {
    text,
    done: json?.done === true,
    promptTokens: Number(json?.prompt_eval_count) || 0,
    outputTokens: Number(json?.eval_count) || 0,
    // ollama 给的是纳秒
    promptMs: Math.round((Number(json?.prompt_eval_duration) || 0) / 1e6),
    outputMs: Math.round((Number(json?.eval_duration) || 0) / 1e6)
  };
}

/** 兜底通道当前状态的可读描述（写进日志和 /api/model，方便一眼看出是不是在降级）。 */
export function describeLocalFallback({ cfg, active, since, reason } = {}) {
  const c = cfg || LOCAL_FALLBACK_DEFAULTS;
  if (!c.enabled) return '本地兜底通道：已关闭（socialV2.localFallback.enabled=false）';
  const head = active ? '本地兜底通道：已接管' : '本地兜底通道：待命';
  const tail = active && since ? `，自 ${new Date(since).toLocaleTimeString('zh-CN')} 起${reason ? `（${reason}）` : ''}` : '';
  return `${head}（${c.baseUrl} ${c.model}${tail}）`;
}

/**
 * 薄 HTTP 客户端：探测 + 单轮生成。fetch 可注入，测试里不用起 ollama。
 * @param {{ fetchImpl?: Function, cfg?: object, now?: () => number }} p
 */
export function createLocalClient({ fetchImpl, cfg, now = () => Date.now() } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const c = cfg || LOCAL_FALLBACK_DEFAULTS;
  let probeCache = { at: 0, ok: false };

  /** 服务在不在。2 秒超时 + 30 秒缓存：本地没起时绝不能拖慢主链路。 */
  async function probe({ force = false } = {}) {
    if (!c.enabled) return false;
    if (!force && probeCache.at && now() - probeCache.at < c.probeCacheMs) return probeCache.ok;
    let ok = false;
    try {
      const res = await doFetch(`${c.baseUrl}/api/tags`, { signal: AbortSignal.timeout(c.probeTimeoutMs) });
      ok = !!res && res.ok;
    } catch {
      ok = false;
    }
    probeCache = { at: now(), ok };
    return ok;
  }

  /**
   * 单轮生成。失败一律抛错（调用方决定是否退回「中性提示」）。
   * @returns {Promise<{ text: string, promptTokens: number, outputTokens: number, promptMs: number, outputMs: number, totalMs: number }>}
   */
  async function chat(messages, { timeoutMs = c.timeoutMs, keepAlive } = {}) {
    const started = now();
    const res = await doFetch(`${c.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildLocalChatBody({ cfg: c, messages, keepAlive })),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res || !res.ok) throw new Error(`本地模型返回 HTTP ${res ? res.status : '??'}`);
    const json = await res.json().catch(() => null);
    const parsed = parseLocalChatResponse(json);
    return { ...parsed, totalMs: now() - started };
  }

  return { probe, chat, cfg: c, resetProbe() { probeCache = { at: 0, ok: false }; } };
}
