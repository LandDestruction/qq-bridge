// OpenAI 兼容 transport（P1）：任何 OpenAI 兼容端点都能当 agent，默认关闭，不影响 DSH。
//
// 关键点：openai 的 toolLoop 语义是 **'host'** —— 模型只回 tool_calls，真正执行工具的是桥接
// （走本地 MCP server，见 local-tools.js，与 DSH 同一套工具定义）。所以本 transport 自己维护
// 「模型 → 工具 → 模型」的循环，并向调用方吐桥接内部认识的 6 种事件（text_delta/tool_call/
// tool_result/turn_end/usage/error）。
//
// 不做的事：不改默认配置、不碰 dsh 路径、不实现跨轮 session 管理（P2）；每次 startTurn 都是
// 一次性 messages，上下文由调用方负责。

import { normalizeAgentConfig, validateTurnRequest } from './contract.js';
import { createLocalToolClient } from './local-tools.js';
import { parseXmlToolCalls } from './xml-tool-calls.js';

const OPENAI_DEFAULT_MAX_TOOL_ROUNDS = 8;
const OPENAI_DEFAULT_TIMEOUT_MS = 120000;

function agentCfg(deps) {
  const raw = deps?.cfg && typeof deps.cfg === 'object' && deps.cfg.agent ? deps.cfg : deps;
  return normalizeAgentConfig(raw ?? {});
}

function normalizeToolAllowlist(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
}

function openaiToolsOf(list) {
  return (Array.isArray(list) ? list : [])
    .filter((tool) => tool && typeof tool.name === 'string' && tool.name)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: String(tool.description ?? ''),
        // MCP SDK 的 listTools() 返回的是 inputSchema（不是 parameters）。早先只读 parameters，
        // 于是所有工具都以「无参数」的 schema 发给模型 → qwen4 只能传 {} → 工具回 zod 校验错误
        // → 模型原样重试到 8 轮上限 → 整轮丢弃（QQ 上表现就是「叫了没反应」）。
        parameters: (tool.inputSchema ?? tool.parameters) && typeof (tool.inputSchema ?? tool.parameters) === 'object'
          ? (tool.inputSchema ?? tool.parameters)
          : { type: 'object', properties: {} }
      }
    }));
}

function contentTextOf(result) {
  const items = Array.isArray(result?.content) ? result.content : [];
  const parts = [];
  for (const item of items) if (item && typeof item.text === 'string' && item.text) parts.push(item.text);
  return parts.join('\n');
}

function usageOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  const prompt = num(raw.prompt_tokens ?? raw.promptTokens);
  const completion = num(raw.completion_tokens ?? raw.completionTokens);
  const cached = num(raw.prompt_tokens_details?.cached_tokens ?? raw.cached_tokens ?? raw.cache_read_input_tokens);
  const total = num(raw.total_tokens ?? raw.totalTokens) ?? (prompt != null && completion != null ? prompt + completion : null);
  return { prompt, completion, cached, total };
}

function completionUrl(baseUrl) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('没有配置 agent.baseUrl（OpenAI 兼容端点地址）');
  return `${base}/chat/completions`;
}

/** 每一段 SSE 里累积 tool_calls：按 index 合并（流式增量只带 fragment）。 */
function mergeToolCall(slots, call) {
  if (!call || typeof call !== 'object') return;
  const index = Number.isInteger(call.index) ? call.index : slots.length;
  const slot = slots[index] ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
  if (call.id) slot.id = String(call.id);
  if (call.function?.name) slot.function.name = String(call.function.name);
  if (call.function?.arguments) slot.function.arguments += String(call.function.arguments);
  slots[index] = slot;
}

/**
 * 消费一次 /chat/completions 响应：边流边发 text_delta，返回这段的 tool_calls/usage/finish_reason。
 * 兼容两种端点：SSE 流（stream:true）与直接回 JSON（有些网关会忽略 stream）。
 */
async function consumeCompletion(response, emit) {
  const state = { toolCalls: [], usage: null, finishReason: 'stop' };
  const handleData = (data) => {
    if (!data || typeof data !== 'object') return;
    if (data.usage) { state.usage = data.usage; emit({ type: 'usage', usage: usageOf(data.usage) }); }
    const choice = data?.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? choice.message ?? {};
    if (typeof delta.content === 'string' && delta.content) emit({ type: 'text_delta', text: delta.content });
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) mergeToolCall(state.toolCalls, call);
    if (choice.finish_reason) state.finishReason = String(choice.finish_reason);
  };

  // 有些网关忽略 stream:true 直接回 JSON：按 content-type 判断，别把 JSON 当 SSE 行解析。
  const ctype = String(response.headers?.get?.('content-type') ?? '');
  if (!response.body || (ctype && !ctype.includes('text/event-stream'))) {
    let json;
    try { json = JSON.parse(await response.text()); } catch { throw new Error('端点返回了无法解析的响应体'); }
    handleData(json);
    return state;
  }

  const decoder = new TextDecoder();
  let carry = '';
  const flushLines = (text) => {
    const lines = text.split('\n');
    const rest = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { handleData(JSON.parse(payload)); } catch { /* 非 JSON 的 data 行忽略 */ }
    }
    return rest;
  };
  for await (const chunk of response.body) {
    carry += decoder.decode(chunk, { stream: true });
    carry = flushLines(carry);
  }
  // 流尾最后一行的换行可能缺失：补一次，别吞掉最后一条 data（usage 常常就在最后）。
  if (carry.trim()) flushLines(`${carry}\n`);
  return state;
}

/**
 * @param {object} deps
 * @param {object} [deps.cfg] 完整配置（读 deps.cfg.agent）或直接给 agent 段
 * @param {Function} [deps.fetch]
 * @param {object} [deps.localTools] 已构造的本地工具客户端
 * @param {Function} [deps.log]
 * @returns {{type:string,name:string,capabilities:Function,startTurn:Function,close:Function}}
 */
export function createOpenAiTransport(deps) {
  let toolsClient = deps?.localTools ?? null;
  const client = () => {
    if (!toolsClient) toolsClient = createLocalToolClient(deps);
    return toolsClient;
  };
  const fetchImpl = () => deps?.fetch ?? globalThis.fetch;
  const log = (line) => { if (typeof deps?.log === 'function') deps.log(line); };

  async function requestCompletion({ baseUrl, apiKey, model, messages, tools, extraBody, timeoutMs, signal }) {
    const fetchFn = fetchImpl();
    if (typeof fetchFn !== 'function') throw new Error('没有可用的 fetch（OpenAI transport 需要 node 18+）');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    const onAbort = () => { try { controller.abort(signal.reason); } catch { /* 忽略 */ } };
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await fetchFn(completionUrl(baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, messages, ...(tools.length ? { tools } : {}), ...extraBody, stream: true, stream_options: { include_usage: true } }),
        signal: controller.signal
      });
    } finally {
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
    }
  }

  /**
   * 二代社交工具（qq_*）的 schema 里 key/token 是必填，但非 DSH 的模型（如 qwen4）经常
   * 只传业务参数、漏掉这两个会话字段；MCP 于是回 zod 校验错误，模型看到错误后原样重试，
   * 直到 maxToolRounds 用完 → 整轮被丢弃（QQ 上就是「叫了没反应」）。
   * 这里按工具 schema 判断：声明了 key/token 就补上本轮会话的值（模型自己传了就不动）。
   */
  function withSessionArgs(name, args, request, toolProps) {
    const props = toolProps.get(name);
    if (!props || !args || typeof args !== 'object' || Array.isArray(args)) return args;
    const out = { ...args };
    const key = String(request?.key ?? '').trim();
    if (props.includes('key') && !String(out.key ?? '').trim() && key) out.key = key;
    if (props.includes('token') && !String(out.token ?? '').trim() && key) {
      try {
        const st = deps?.getSocialV2State?.(key);
        if (st?.agentToken) out.token = st.agentToken;
      } catch { /* 取不到就交给工具自己报错 */ }
    }
    return out;
  }

  /** @param {object} request 见 contract.validateTurnRequest */
  async function* startTurn(request) {
    const checked = validateTurnRequest(request ?? {});
    if (!checked.ok) { yield { type: 'error', error: checked.error }; return; }
    const cfg = agentCfg(deps);
    const model = String(request.model ?? cfg.model ?? '').trim();
    if (!model) { yield { type: 'error', error: '没有配置 agent.model（OpenAI 兼容端点的模型名）' }; return; }
    const baseUrl = String(request.baseUrl ?? cfg.baseUrl ?? '').trim();
    const apiKey = String(request.apiKey ?? cfg.apiKey ?? '');
    const timeoutMs = Number(request.timeoutMs ?? cfg.timeoutMs) > 0 ? Number(request.timeoutMs ?? cfg.timeoutMs) : OPENAI_DEFAULT_TIMEOUT_MS;
    // 端点专属开关（本地推理端常用来关思考链等）；非对象一律忽略，避免把请求体写坏。
    const rawExtra = request.extraBody ?? cfg.extraBody;
    const extraBody = rawExtra && typeof rawExtra === 'object' && !Array.isArray(rawExtra) ? rawExtra : {};
    const maxRounds = Number(request.maxToolRounds ?? cfg.maxToolRounds) > 0
      ? Math.max(1, Math.floor(Number(request.maxToolRounds ?? cfg.maxToolRounds)))
      : OPENAI_DEFAULT_MAX_TOOL_ROUNDS;

    const messages = [];
    if (request.system) messages.push({ role: 'system', content: String(request.system) });
    for (const message of request.messages) {
      // 内容既可以是纯文本，也可以是 OpenAI 的 content 数组（本地视觉模型要带 image_url）。
      messages.push({ role: message.role, content: Array.isArray(message.content) ? message.content : message.text });
    }

    let tools = [];
    try {
      tools = openaiToolsOf(await client().listTools());
      const allow = normalizeToolAllowlist(request.tools ?? cfg.tools);
      if (allow.length) {
        const allowed = new Set(allow);
        tools = tools.filter((tool) => allowed.has(tool?.function?.name));
        log(`[OpenAI] 只暴露 ${tools.length} 个工具（agent.tools 白名单）`);
      }
    } catch (error) {
      log(`[OpenAI] 工具清单获取失败，这轮按纯文本对话跑：${error?.message ?? error}`);
      tools = [];
    }
    const toolProps = new Map((Array.isArray(tools) ? tools : []).map((tool) => [
      tool?.function?.name,
      Object.keys(tool?.function?.parameters?.properties ?? {})
    ]));

    for (let round = 1; round <= maxRounds; round += 1) {
      let response;
      try {
        response = await requestCompletion({ baseUrl, apiKey, model, messages, tools, extraBody, timeoutMs, signal: request.signal });
      } catch (error) {
        const reason = String(error?.message ?? error);
        const hint = /fetch failed|ECONNREFUSED|ENOTFOUND|timed out|aborted/i.test(reason)
          ? `（连不上 ${baseUrl}：本地模型引擎可能没在跑。去「设置 → 本地模型」看状态并重启，或直接切回 DSH）`
          : '';
        yield { type: 'error', error: `请求 OpenAI 兼容端点失败：${reason}${hint}` };
        return;
      }
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.text()).slice(0, 300); } catch { /* 忽略 */ }
        yield { type: 'error', error: `OpenAI 兼容端点返回 HTTP ${response.status}${detail ? `：${detail}` : ''}` };
        return;
      }

      const pending = [];
      let result;
      try {
        result = await consumeCompletion(response, (event) => pending.push(event));
      } catch (error) {
        yield { type: 'error', error: `读取事件流出错：${error?.message ?? error}` };
        return;
      }
      for (const event of pending) yield event;

      const textSoFar = pending.filter((event) => event.type === 'text_delta').map((event) => event.text).join('');
      let calls = result.toolCalls.filter((call) => call && call.function && call.function.name);
      if (!calls.length) {
        // 兜底：本地端点把调用写进正文（XML）——解析出来当结构化调用执行，别让它原样发出去。
        const parsed = parseXmlToolCalls(textSoFar);
        if (parsed.length) {
          calls = parsed.slice(0, 4).map((item, index) => ({
            id: `xml_${round}_${index}`,
            function: { name: item.name, arguments: JSON.stringify(item.args || {}) }
          }));
          log(`[OpenAI] 正文里解析出 ${calls.length} 个工具调用（XML 兜底）`);
        }
      }
      if (!calls.length) {
        yield { type: 'turn_end', finishReason: result.finishReason || 'stop', usage: usageOf(result.usage) };
        return;
      }

      // 有工具调用：先把 assistant 的 tool_calls 回填，再逐个执行（并行多条也按序跑，QQ 场景足够）。
      const assistantCalls = calls.map((call, index) => ({
        id: call.id || `call_${round}_${index}`,
        type: 'function',
        function: { name: call.function.name, arguments: call.function.arguments || '{}' }
      }));
      messages.push({ role: 'assistant', content: textSoFar || null, tool_calls: assistantCalls });
      for (const call of assistantCalls) {
        yield { type: 'tool_call', name: call.function.name, toolCallId: call.id, arguments: call.function.arguments };
        let text = '';
        try {
          const rawArgs = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          const args = withSessionArgs(call.function.name, rawArgs, request, toolProps);
          text = contentTextOf(await client().callTool(call.function.name, args)) || '（工具没有返回文本）';
        } catch (error) {
          text = `工具执行失败：${error?.message ?? error}`;
        }
        yield { type: 'tool_result', name: call.function.name, toolCallId: call.id, text };
        messages.push({ role: 'tool', tool_call_id: call.id, content: text });
      }
      if (round === maxRounds) { yield { type: 'error', error: `工具循环超过 ${maxRounds} 轮，已停止` }; return; }
    }
  }

  return {
    type: 'openai',
    name: 'openai',
    capabilities() { return { stream: true, sessions: false, multimodal: false, toolLoop: 'host' }; },
    startTurn,
    close() { if (toolsClient && typeof toolsClient.close === 'function') toolsClient.close(); }
  };
}
