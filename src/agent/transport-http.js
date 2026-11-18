// 自研 HTTP agent transport（P2）：任何实现了这套简单协议的端点都能当 agent。
//
// 与 openai transport 的区别：协议是我们自己的，服务端按 SSE 帧推 5 类事件
// （text_delta / tool_call / turn_end / usage / error），工具由**桥接**执行——执行完把结果
// POST 回 {baseUrl}/tool-result，服务端在同一条 turn 的流里继续输出。所以这里既有「读流」也有
// 「回填工具结果」两件事。
//
// 不做的事：不碰 DSH 路径、不改默认配置（agent.type 默认仍是 dsh）、不实现跨轮 session
// 管理（sessions:false）、不自己重试（交给上层的回合失败提示）。

import { normalizeAgentConfig, validateTurnRequest } from './contract.js';
import { createLocalToolClient } from './local-tools.js';

const HTTP_DEFAULT_TIMEOUT_MS = 120000;
const HTTP_DEFAULT_IDLE_MS = 60000;
const HTTP_PROBE_TIMEOUT_MS = 8000;

function agentCfg(deps) {
  const raw = deps?.cfg && typeof deps.cfg === 'object' && deps.cfg.agent ? deps.cfg : deps;
  return normalizeAgentConfig(raw ?? {});
}

function baseUrlOf(deps, input) {
  const cfg = agentCfg(deps);
  const base = String(input?.baseUrl ?? cfg.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('没有配置 agent.baseUrl（自研 HTTP agent 地址）');
  return base;
}

function tokenOf(deps, input) {
  const cfg = agentCfg(deps);
  return String(input?.apiKey ?? cfg.apiKey ?? '');
}

function turnIdOf(input) {
  const provided = String(input?.turnId ?? '').trim();
  if (provided) return provided;
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function authHeaders(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function timeoutOf(deps, input) {
  const cfg = agentCfg(deps);
  const value = Number(input?.timeoutMs ?? cfg.timeoutMs);
  return Number.isFinite(value) && value > 0 ? value : HTTP_DEFAULT_TIMEOUT_MS;
}

function idleOf(deps, input) {
  const value = Number(input?.idleTimeoutMs ?? deps?.httpIdleTimeoutMs);
  return Number.isFinite(value) && value > 0 ? value : HTTP_DEFAULT_IDLE_MS;
}

function fetchOf(deps) {
  const fn = deps?.fetch ?? globalThis.fetch;
  if (typeof fn !== 'function') throw new Error('没有可用的 fetch（HTTP transport 需要 node 18+）');
  return fn;
}

function messageBody(input) {
  const messages = [];
  for (const message of Array.isArray(input.messages) ? input.messages : []) {
    const role = String(message?.role ?? 'user');
    if (role === 'system') continue; // system 单独放 body.system
    const item = { role: role === 'assistant' ? 'assistant' : 'user', text: String(message?.text ?? '') };
    if (Array.isArray(message?.images) && message.images.length) item.images = message.images.map(String);
    messages.push(item);
  }
  return messages;
}

function turnPayload(input, turnId) {
  const body = {
    turnId,
    sessionKey: String(input.key ?? ''),
    system: String(input.system ?? ''),
    messages: messageBody(input)
  };
  if (Array.isArray(input.tools) && input.tools.length) {
    body.tools = input.tools
      .filter((tool) => tool && typeof tool.name === 'string' && tool.name)
      .map((tool) => ({
        name: tool.name,
        description: String(tool.description ?? ''),
        parameters: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} }
      }));
  }
  if (input.persona !== undefined) body.persona = input.persona;
  return body;
}

function asArgs(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  return {};
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** 解析一帧 SSE：返回 {event, data} 或 null（空帧/注释帧）。坏 JSON 由调用方归一成 error。 */
function parseFrame(frame) {
  const lines = String(frame).split(/\r?\n/);
  let event = '';
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
    if (line.startsWith('data:')) { dataLines.push(line.slice(5).replace(/^ /, '')); continue; }
    // 有些服务端不写 event:，直接把 JSON 放 data: 里；其它前缀忽略。
  }
  if (!dataLines.length) return event ? { event, data: null } : null;
  return { event, data: dataLines.join('\n') };
}

/** 把服务端事件帧翻译成桥接内部 6 种事件。 */
function normalizeFrame(event, data) {
  const type = String(event || (data && typeof data === 'object' ? data.type : '') || '').trim();
  let payload = data;
  if (typeof data === 'string') {
    try { payload = JSON.parse(data); } catch { return { event: { type: 'error', error: '服务端推了一帧无法解析的 JSON' }, bad: true }; }
  }
  const obj = payload && typeof payload === 'object' ? payload : {};
  switch (type) {
    case 'text_delta':
      return { event: { type: 'text_delta', text: String(obj.text ?? '') } };
    case 'tool_call':
      return { event: { type: 'tool_call', id: String(obj.id ?? ''), name: String(obj.name ?? ''), arguments: asArgs(obj.args ?? obj.arguments) } };
    case 'usage':
      return {
        event: {
          type: 'usage',
          usage: {
            prompt: Number.isFinite(Number(obj.promptTokens)) ? Number(obj.promptTokens) : null,
            completion: Number.isFinite(Number(obj.completionTokens)) ? Number(obj.completionTokens) : null,
            total: Number.isFinite(Number(obj.promptTokens)) && Number.isFinite(Number(obj.completionTokens))
              ? Number(obj.promptTokens) + Number(obj.completionTokens)
              : null
          }
        }
      };
    case 'turn_end':
      return { event: { type: 'turn_end', stopReason: String(obj.stopReason ?? obj.stop_reason ?? 'stop') } };
    case 'error':
      return { event: { type: 'error', error: String(obj.message ?? obj.error ?? '服务端报告错误') } };
    default:
      return { event: { type: 'error', error: `服务端推了未知事件：${type || '(空)'}` }, bad: true };
  }
}

/**
 * 读 SSE 流：逐帧 yield 内部事件；tool_call 由本函数执行（本地 MCP）并 POST /tool-result 回填，
 * 然后在同一条流里继续等后续帧（服务端会把工具结果并进上下文继续输出）。
 * 所有异常都归一成 {type:'error'}，不抛到调用方。
 */
async function* httpEvents(deps, input) {
  const checked = validateTurnRequest(input ?? {});
  if (!checked.ok) { yield { type: 'error', error: checked.error }; return; }
  let baseUrl;
  try { baseUrl = baseUrlOf(deps, input); } catch (error) { yield { type: 'error', error: error?.message ?? String(error) }; return; }
  const token = tokenOf(deps, input);
  const turnId = turnIdOf(input);
  const timeoutMs = timeoutOf(deps, input);
  const idleMs = idleOf(deps, input);
  const log = (line) => { if (typeof deps?.log === 'function') deps.log(line); };
  const client = deps?.localTools && typeof deps.localTools.callTool === 'function'
    ? deps.localTools
    : createLocalToolClient(deps);

  const controller = new AbortController();
  const outerSignal = input?.signal;
  const state = { done: false, abortReason: '', idleTimer: null, totalTimer: null };

  const abortWith = (reason) => {
    state.abortReason = reason;
    try { controller.abort(new Error(reason)); } catch { /* 忽略 */ }
  };
  const resetIdle = () => {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => abortWith(`空闲超时（${idleMs >= 1000 ? `${Math.round(idleMs / 1000)} 秒` : `${idleMs} 毫秒`}没有事件）`), idleMs);
    if (state.idleTimer && typeof state.idleTimer.unref === 'function') state.idleTimer.unref();
  };
  const onOuterAbort = () => abortWith('回合被取消');
  try {
    state.totalTimer = setTimeout(() => abortWith(`超时（${Math.round(timeoutMs / 1000)} 秒预算用完）`), timeoutMs);
    if (state.totalTimer && typeof state.totalTimer.unref === 'function') state.totalTimer.unref();
    if (outerSignal && typeof outerSignal.addEventListener === 'function') outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    resetIdle();

    const fetchFn = fetchOf(deps);
    let response;
    try {
      response = await fetchFn(`${baseUrl}/turn`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-qdb-turn': turnId,
          ...authHeaders(token)
        },
        body: JSON.stringify(turnPayload(input, turnId)),
        signal: controller.signal
      });
    } catch (error) {
      yield { type: 'error', error: state.abortReason || `请求 agent 端点失败：${error?.message ?? error}` };
      return;
    }
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.text()).slice(0, 200); } catch { /* 忽略 */ }
      yield { type: 'error', error: `agent 端点返回 HTTP ${response.status}${detail ? `：${detail}` : ''}` };
      return;
    }
    const ctype = String(response.headers?.get?.('content-type') ?? '');
    if (!ctype.includes('text/event-stream')) {
      yield { type: 'error', error: `agent 端点没有返回 text/event-stream（收到 ${ctype || '未知类型'}）` };
      return;
    }
    if (!response.body) { yield { type: 'error', error: 'agent 端点没有返回响应体' }; return; }

    const decoder = new TextDecoder();
    let buffer = '';
    let ended = false;
    try {
    for await (const chunk of response.body) {
      resetIdle();
      buffer += decoder.decode(chunk, { stream: true });
      // 帧分隔：一个空行。\r\n 与 \n 都兼容。
      let index = buffer.search(/\r?\n\r?\n/);
      while (index >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer[index] === '\r' ? 4 : 2));
        const parsed = parseFrame(raw);
        if (parsed) {
          const normal = normalizeFrame(parsed.event, parsed.data);
          if (normal.bad) {
            yield normal.event;
            abortWith(normal.event.error);
            ended = true;
            break;
          }
          const event = normal.event;
          yield event;
          if (event.type === 'turn_end') { ended = true; break; }
          if (event.type === 'tool_call') {
            // 工具由桥接执行：回填结果让同一条流继续。
            let text = '';
            let ok = true;
            let toolError = '';
            try {
              text = asText(await client.callTool(event.name, event.arguments)) || '（工具没有返回文本）';
            } catch (error) {
              ok = false;
              toolError = String(error?.message ?? error);
              text = `工具执行失败：${toolError}`;
            }
            yield { type: 'tool_result', id: event.id, name: event.name, ok, text, error: toolError || undefined };
            const submitted = await submitToolResult(deps, { baseUrl, token, turnId, id: event.id, ok, result: text, error: toolError || undefined });
            if (!submitted.ok) {
              yield { type: 'error', error: `回填工具结果失败：${submitted.error}` };
              abortWith('回填工具结果失败');
              ended = true;
              break;
            }
            log(`[agent/http] 工具 ${event.name} 结果已回填（${event.id}）`);
          }
        }
        if (ended) break;
        index = buffer.search(/\r?\n\r?\n/);
      }
      if (ended) break;
    }
    if (buffer.trim() && !ended) {
      const parsed = parseFrame(buffer);
      if (parsed) {
        const normal = normalizeFrame(parsed.event, parsed.data);
        yield normal.event;
      }
    }
    } catch (caught) {
      // 读流被 abort（取消/空闲/总预算）或网络断开：归一成 error，不把异常抛到 mux。
      yield { type: 'error', error: state.abortReason || `读取事件流出错：${caught?.message ?? caught}` };
    }
    if (state.abortReason) yield { type: 'error', error: state.abortReason };
  } finally {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    if (state.totalTimer) clearTimeout(state.totalTimer);
    if (outerSignal && typeof outerSignal.removeEventListener === 'function') outerSignal.removeEventListener('abort', onOuterAbort);
    if (state.abortReason) {
      // 取消时通知服务端（可 404），别让服务端自己跑完一整轮。
      try {
        const fetchFn = fetchOf(deps);
        await fetchFn(`${baseUrl}/turn/${encodeURIComponent(turnId)}`, {
          method: 'DELETE',
          headers: authHeaders(token)
        });
      } catch { /* DELETE 只是尽力而为 */ }
    }
  }
}

async function submitToolResult(deps, { baseUrl, token, turnId, id, ok, result, error }) {
  try {
    const fetchFn = fetchOf(deps);
    const response = await fetchFn(`${baseUrl}/tool-result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify({ turnId, id, ok, result, ...(error ? { error } : {}) })
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true };
  } catch (caught) {
    return { ok: false, error: String(caught?.message ?? caught) };
  }
}

/**
 * @param {object} deps
 * @param {object} [deps.cfg] 完整配置（读 deps.cfg.agent）或直接给 agent 段
 * @param {Function} [deps.fetch]
 * @param {object} [deps.localTools] 工具客户端（测试可注入假实现）
 * @param {Function} [deps.log]
 */
export function createHttpTransport(deps) {
  async function probe() {
    const cfg = agentCfg(deps);
    const base = String(cfg.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!base) return { ok: false, error: 'HTTP agent 地址没配置（agent.baseUrl 为空）' };
    const timeoutMs = Number(deps?.httpProbeTimeoutMs) > 0 ? Number(deps.httpProbeTimeoutMs) : HTTP_PROBE_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* 忽略 */ } }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetchOf(deps)(`${base}/health`, { method: 'GET', headers: authHeaders(cfg.apiKey), signal: controller.signal });
      if (response.ok) return { ok: true, detail: `GET ${base}/health → ${response.status}` };
      if (response.status === 401 || response.status === 403) return { ok: false, error: '需要鉴权', detail: `GET ${base}/health → ${response.status}` };
      return { ok: false, error: `端点返回 HTTP ${response.status}`, detail: `GET ${base}/health → ${response.status}` };
    } catch (error) {
      const message = String(error?.message ?? error);
      return { ok: false, error: /abort|timeout/i.test(message) ? '请求超时（8 秒）' : '连不上这个地址（检查 baseUrl/网络）', detail: `GET ${base}/health 失败` };
    } finally {
      clearTimeout(timer);
    }
  }

  function startTurn(input) {
    return httpEvents(deps, input ?? {});
  }

  async function runTurn(input, handlers = {}) {
    const out = { ok: true, turnId: turnIdOf(input ?? {}), text: '', stopReason: '', usage: null, error: '', events: [] };
    for await (const event of httpEvents(deps, input ?? {})) {
      out.events.push(event);
      if (event.type === 'text_delta') {
        out.text += String(event.text ?? '');
        if (typeof handlers.onText === 'function') handlers.onText(String(event.text ?? ''));
      } else if (event.type === 'tool_call') {
        if (typeof handlers.onToolCall === 'function') handlers.onToolCall({ id: event.id, name: event.name, args: event.arguments });
      } else if (event.type === 'usage') {
        out.usage = event.usage;
        if (typeof handlers.onUsage === 'function') handlers.onUsage(event.usage);
      } else if (event.type === 'turn_end') {
        out.stopReason = event.stopReason;
        if (typeof handlers.onEnd === 'function') handlers.onEnd({ stopReason: event.stopReason });
      } else if (event.type === 'error') {
        out.ok = false;
        out.error = String(event.error ?? '未知错误');
        if (typeof handlers.onError === 'function') handlers.onError(out.error);
      }
    }
    return out;
  }

  async function submitToolResultFor(turnId, id, result, options = {}) {
    const base = baseUrlOf(deps, {});
    return submitToolResult(deps, { baseUrl: base, token: agentCfg(deps).apiKey, turnId, id, ok: options.ok !== false, result, error: options.error });
  }

  async function cancel(turnId) {
    if (!turnId) return false;
    try {
      const base = baseUrlOf(deps, {});
      await fetchOf(deps)(`${base}/turn/${encodeURIComponent(turnId)}`, { method: 'DELETE', headers: authHeaders(agentCfg(deps).apiKey) });
      return true;
    } catch { return false; }
  }

  return {
    type: 'http',
    name: 'http',
    capabilities() { return { stream: true, sessions: false, multimodal: false, toolLoop: 'host' }; },
    startTurn,
    runTurn,
    submitToolResult: submitToolResultFor,
    cancel,
    probe
  };
}
