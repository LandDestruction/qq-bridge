// Agent 接入契约（P0，零行为变化）。
//
// 为什么需要这一层：桥接目前把「机器人 = DSH」写死在 mux 里（deps.api / createTurnCollector /
// discoverDshBaseUrl）。要让任意 agent 接进来，先得有一份**不含任何具体实现**的契约：
//   · 配置形状（cfg.agent）怎么归一；
//   · 每种 transport 声明自己支持什么能力（流式/工具循环/会话/多模态）；
//   · 一轮请求的最小形状怎么校验；
//   · 各 transport 的事件怎么归一到桥接内部认识的那 6 种。
// 本文件是纯函数 + JSDoc 类型，**零 import**：既能在 Node 主进程用，也能在 VM/subagent
// 沙箱里直接跑（沙箱会剥掉 import，但纯函数文件可以整份注入）。

/** 支持的 transport 类型。P0 只真正实现 dsh，openai/http 留给 P1。 */
export const AGENT_TRANSPORTS = ['dsh', 'openai', 'http'];

/** 桥接内部认识的事件类型（projectTurnEvents 只输出这 6 种）。 */
export const AGENT_EVENT_TYPES = ['text_delta', 'tool_call', 'tool_result', 'turn_end', 'usage', 'error'];

/** toolLoop 的两种语义：'agent' = 对方自己跑工具循环；'host' = 桥接（宿主）跑工具循环。 */
export const AGENT_TOOL_LOOP_MODES = ['agent', 'host'];

/** 每种 transport 声明的能力。http 的「由对方声明」由 describeAgentTransport 的第二参数合并。 */
const AGENT_CAPABILITIES = Object.freeze({
  dsh: Object.freeze({ stream: true, toolLoop: 'agent', sessions: true, multimodal: true }),
  openai: Object.freeze({ stream: true, toolLoop: 'host', sessions: true, multimodal: false }),
  // http（P2 自研协议）：SSE 推流 + 工具由桥接执行（toolLoop:true 语义等价 'host'；
  // transport.capabilities() 会显式写 'host'，因为 mux/prompt-delivery 按 === 'host' 分支）。
  http: Object.freeze({ stream: true, toolLoop: true, sessions: false, multimodal: false })
});

/** transport 必须实现的方法（P1 起 startTurn 进契约；dsh 用 events() 原路径，不强制 startTurn）。 */
export const AGENT_TRANSPORT_METHODS = Object.freeze(['events', 'startTurn', 'respond', 'stopSessionWork', 'createCollector']);

/** 一轮请求里 messages 允许的 role。 */
const AGENT_ROLES = ['system', 'user', 'assistant', 'tool'];

/** 事件名别名 → 内部 6 种。外部 transport 可以用自己的叫法，归一就靠这张表。 */
const EVENT_ALIASES = Object.freeze({
  text_delta: 'text_delta',
  text: 'text_delta',
  'text-chunk': 'text_delta',
  text_chunk: 'text_delta',
  delta: 'text_delta',
  tool_call: 'tool_call',
  'tool-call': 'tool_call',
  tool_use: 'tool_call',
  tool_result: 'tool_result',
  'tool-result': 'tool_result',
  tool_output: 'tool_result',
  turn_end: 'turn_end',
  'turn-end': 'turn_end',
  done: 'turn_end',
  end: 'turn_end',
  usage: 'usage',
  error: 'error',
  failure: 'error'
});

function str(value) {
  return typeof value === 'string' ? value : '';
}

function toolAllowlist(value) {
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

function plainExtraBody(value) {
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

function num(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/**
 * 归一 `cfg.agent`（P0 只读不写回，缺省 type='dsh'）。
 * @param {object} cfg 完整 config 或 `{agent}` 片段
 * @returns {{type:string,baseUrl:string,apiKey:string,model:string,timeoutMs:number,warns:string[]}}
 */
export function normalizeAgentConfig(cfg) {
  const raw = cfg && typeof cfg === 'object' ? (cfg.agent ?? cfg) : {};
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const warns = [];
  let type = str(src.type).trim().toLowerCase();
  if (!type) type = 'dsh';
  if (!AGENT_TRANSPORTS.includes(type)) {
    warns.push(`未知的 agent.type "${type}"，已回退 dsh`);
    type = 'dsh';
  }
  return {
    type,
    baseUrl: str(src.baseUrl).trim(),
    apiKey: str(src.apiKey),
    model: str(src.model).trim(),
    // 超时给一个宽松上限：agent 一轮可能跑很久，但别让配置写出几天。
    timeoutMs: num(src.timeoutMs, 120000, 5000, 600000),
    // host 模式自己跑工具循环时的上限（openai transport 用；dsh 不读它）。
    maxToolRounds: num(src.maxToolRounds, 8, 1, 20),
    // 额外请求体（本地推理端点常见的开关走这里，比如 chat_template_kwargs）。
    extraBody: plainExtraBody(src.extraBody),
    // 暴露给模型看的工具名白名单（空 = 全部）。本地小模型工具太多会一直调工具不肯回话。
    tools: toolAllowlist(src.tools),
    warns
  };
}

/**
 * 某种 transport 的能力表。declared 用于 http 这类「由对方声明」的 transport：
 * 只认布尔字段，未声明的保持默认 false。
 * @param {string} type
 * @param {object} [declared]
 */
export function describeAgentTransport(type, declared) {
  const base = AGENT_CAPABILITIES[type] ?? AGENT_CAPABILITIES.dsh;
  const out = { stream: base.stream, toolLoop: base.toolLoop, sessions: base.sessions, multimodal: base.multimodal };
  if (declared && typeof declared === 'object') {
    for (const name of ['stream', 'sessions', 'multimodal']) {
      if (typeof declared[name] === 'boolean') out[name] = declared[name];
    }
    // toolLoop 接受布尔（true → 'host'，false → false）或 'agent'/'host'；其它值忽略。
    if (typeof declared.toolLoop === 'boolean') out.toolLoop = declared.toolLoop ? 'host' : false;
    else if (AGENT_TOOL_LOOP_MODES.includes(declared.toolLoop)) out.toolLoop = declared.toolLoop;
  }
  return out;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 校验一轮请求的最小形状。非法返回 `{ok:false,error}`（中文一句，给人看）。
 * @param {object} req
 */
export function validateTurnRequest(req) {
  if (!isPlainObject(req)) return { ok: false, error: '请求必须是对象' };
  if (!str(req.key).trim()) return { ok: false, error: '缺少 key（会话 key）' };
  if (!str(req.sessionId).trim()) return { ok: false, error: '缺少 sessionId（agent 侧会话）' };
  if (!Array.isArray(req.messages) || req.messages.length === 0) return { ok: false, error: 'messages 必须是非空数组' };
  for (const [index, message] of req.messages.entries()) {
    if (!isPlainObject(message)) return { ok: false, error: `messages[${index}] 必须是对象` };
    if (!AGENT_ROLES.includes(str(message.role))) return { ok: false, error: `messages[${index}].role 非法：${str(message.role) || '(空)'}` };
    // 纯文本走 text；带图的消息用 OpenAI 风格的 content 数组（本地视觉模型要 image_url）。
    if (typeof message.text !== 'string' && !Array.isArray(message.content)) {
      return { ok: false, error: `messages[${index}] 需要 text（字符串）或 content（数组）` };
    }
    if (Array.isArray(message.content) && message.content.some((part) => !isPlainObject(part) || !str(part.type).trim())) {
      return { ok: false, error: `messages[${index}].content 的每一项都要是带 type 的对象` };
    }
  }
  if (req.system !== undefined && typeof req.system !== 'string') return { ok: false, error: 'system 必须是字符串' };
  if (req.tools !== undefined) {
    if (!Array.isArray(req.tools)) return { ok: false, error: 'tools 必须是数组' };
    for (const [index, tool] of req.tools.entries()) {
      if (!isPlainObject(tool)) return { ok: false, error: `tools[${index}] 必须是对象` };
      if (!str(tool.name).trim()) return { ok: false, error: `tools[${index}].name 不能为空` };
      if (tool.description !== undefined && typeof tool.description !== 'string') return { ok: false, error: `tools[${index}].description 必须是字符串` };
      if (tool.parameters !== undefined && !isPlainObject(tool.parameters)) return { ok: false, error: `tools[${index}].parameters 必须是对象` };
    }
  }
  if (req.persona !== undefined && typeof req.persona !== 'string' && !isPlainObject(req.persona)) {
    return { ok: false, error: 'persona 必须是字符串或对象' };
  }
  return { ok: true, value: req };
}

function eventTypeOf(event) {
  if (!isPlainObject(event)) return '';
  const raw = str(event.type ?? event.event ?? event.kind).trim().toLowerCase();
  return EVENT_ALIASES[raw] ?? '';
}

/**
 * 把任意 transport 的事件序列归一成内部 6 种。未知事件丢弃并计数（不抛错：
 * 上游多送一种事件不该让整轮失败）。
 * @param {Iterable<any>|any[]} events
 * @returns {{events:object[],dropped:number,unknownTypes:string[]}}
 */
export function projectTurnEvents(events) {
  const out = { events: [], dropped: 0, unknownTypes: [] };
  const list = Array.isArray(events) ? events : events && typeof events[Symbol.iterator] === 'function' ? Array.from(events) : [];
  for (const event of list) {
    const type = eventTypeOf(event);
    if (!type) {
      out.dropped += 1;
      const unknown = isPlainObject(event) ? str(event.type ?? event.event ?? event.kind) : '';
      if (unknown && !out.unknownTypes.includes(unknown)) out.unknownTypes.push(unknown);
      continue;
    }
    out.events.push({ ...event, type });
  }
  return out;
}
