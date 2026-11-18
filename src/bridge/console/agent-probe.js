// 设置页「测试连通」：只读探活 agent 端点（POST /api/agent/probe）。
//
// 设计约束（都是真机上踩过的）：
// - 探活是**只读**的，不落盘、不改运行时配置，探完只把最近一次结果留在内存里给
//   GET /api/config 的 agent.probeOk 展示（设置页刷新时能看到上次结果）。
// - **永不 500**：设置页点按钮最怕看到红字堆栈，所以任何异常都收成
//   {ok:false,error:中文} + 200；就连请求体坏掉也只是 200 + 人话。
// - 响应里**绝不回 apiKey**：只回 hasApiKey 布尔。
// - baseUrl 只允许 http(s)（防止被当成 open-url 之类的奇怪协议）；
//   openai 的 /models 只是快路径，404 时降级发一次最小 chat/completions——
//   很多兼容端点是 /v1 前缀、/models 未实现，但 chat 能用。

const AGENT_PROBE_PATH = '/api/agent/probe';
const AGENT_PROBE_TIMEOUT_MS = 8000;
const AGENT_PROBE_MAX_TIMEOUT_MS = 15000;
const AGENT_PROBE_MIN_TIMEOUT_MS = 100;
const AGENT_PROBE_TYPES = Object.freeze(['dsh', 'openai', 'http']);
const AGENT_PROBE_TIMEOUT_TEXT = '请求超时（8 秒）';
const AGENT_PROBE_UNREACHABLE_TEXT = '连不上这个地址（检查 baseUrl/网络）';
const AGENT_PROBE_AUTH_TEXT = 'key 不对或没有权限';

// 最近一次探活结果（内存）：GET /api/config 的 agent.probeOk 读这里，不读磁盘。
let agentProbeLast = null;

// 纯展示字段：只挑非敏感字段，apiKey 永远不进这个对象。
function apPublicLast() {
  if (!agentProbeLast) return null;
  return { at: agentProbeLast.at, ok: agentProbeLast.ok, latencyMs: agentProbeLast.latencyMs };
}

function apClampTimeout(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return AGENT_PROBE_TIMEOUT_MS;
  return Math.max(AGENT_PROBE_MIN_TIMEOUT_MS, Math.min(AGENT_PROBE_MAX_TIMEOUT_MS, Math.floor(value)));
}

function apNormalizeBaseUrl(deps, raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, error: '还没配置 baseUrl（设置里填一个 OpenAI 兼容地址，例如 https://api.example.com/v1）' };
  let url = null;
  try { url = new deps.URL(text); } catch { return { ok: false, error: 'baseUrl 不是合法地址' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'baseUrl 只支持 http:// 或 https://' };
  return { ok: true, baseUrl: text.replace(/\/+$/, '') };
}

function apNetworkErrorText(error) {
  const message = String(error && error.message ? error.message : error || '');
  const name = String(error && error.name ? error.name : '');
  if (name === 'AbortError' || /aborted|timeout/i.test(message)) return AGENT_PROBE_TIMEOUT_TEXT;
  return AGENT_PROBE_UNREACHABLE_TEXT;
}

// 一次带超时的 fetch：返回 {status, ok, body}；网络/超时抛错，由调用方翻成人话。
async function apRequest(deps, url, init, timeoutMs) {
  // AbortController 是 Node 22 的全局；deps 里没注入就用全局（VM 沙箱同 realm，可用）。
  const AbortCtor = typeof deps.AbortController === 'function' ? deps.AbortController : (typeof AbortController === 'function' ? AbortController : null);
  const controller = AbortCtor ? new AbortCtor() : null;
  const timerState = { timer: null };
  const timeout = new Promise((_, reject) => {
    timerState.timer = deps.setTimeout(() => {
      try { if (controller) controller.abort(); } catch { /* ignore */ }
      const error = new Error('probe timeout');
      error.name = 'AbortError';
      reject(error);
    }, timeoutMs);
    if (timerState.timer && typeof timerState.timer.unref === 'function') timerState.timer.unref();
  });
  try {
    const response = await Promise.race([
      deps.fetch(url, { ...init, signal: controller ? controller.signal : undefined }),
      timeout
    ]);
    const body = await response.text().catch(() => '');
    return { status: response.status, ok: response.ok === true || (response.status >= 200 && response.status < 300), body };
  } finally {
    if (timerState.timer) deps.clearTimeout(timerState.timer);
  }
}

function apHeaders(apiKey) {
  const headers = { accept: 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

async function apProbeOpenai(deps, { baseUrl, model, apiKey, timeoutMs }) {
  const url = `${baseUrl}/models`;
  try {
    const models = await apRequest(deps, url, { method: 'GET', headers: apHeaders(apiKey) }, timeoutMs);
    if (models.ok) return { ok: true, detail: `GET ${url} → ${models.status}` };
    if (models.status === 401 || models.status === 403) return { ok: false, error: AGENT_PROBE_AUTH_TEXT, detail: `GET ${url} → ${models.status}` };
    // 快路径 404（或 /models 未实现）→ 降级发一次最小 chat，很多兼容端点只实现了 chat。
    if (models.status === 404) {
      const chatUrl = `${baseUrl}/chat/completions`;
      const payload = { model: model || 'default', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
      const chat = await apRequest(deps, chatUrl, {
        method: 'POST',
        headers: { ...apHeaders(apiKey), 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      }, timeoutMs);
      if (chat.ok) return { ok: true, detail: `GET ${url} → 404，降级 POST ${chatUrl} → ${chat.status}` };
      if (chat.status === 401 || chat.status === 403) return { ok: false, error: AGENT_PROBE_AUTH_TEXT, detail: `POST ${chatUrl} → ${chat.status}` };
      return { ok: false, error: `端点返回 HTTP ${chat.status}（检查 baseUrl 是否指向 OpenAI 兼容端点）`, detail: `POST ${chatUrl} → ${chat.status}` };
    }
    return { ok: false, error: `端点返回 HTTP ${models.status}（检查 baseUrl 是否指向 OpenAI 兼容端点）`, detail: `GET ${url} → ${models.status}` };
  } catch (error) {
    return { ok: false, error: apNetworkErrorText(error), detail: `GET ${url} 失败` };
  }
}

async function apProbeDsh(deps, { baseUrl, apiKey, timeoutMs }) {
  if (!baseUrl) return { ok: false, error: 'DSH 地址没配置（agent.baseUrl 为空）' };
  const url = `${baseUrl}/api/status`;
  try {
    const response = await apRequest(deps, url, { method: 'GET', headers: apHeaders(apiKey) }, timeoutMs);
    if (response.ok) return { ok: true, detail: `GET ${url} → ${response.status}` };
    // DSH 的 /api/status 需要登录令牌：401/403 恰恰证明「进程在、能应答」，按可达处理
    // （本探活只回答「地址通不通」，不负责校验 DSH 的登录态）。
    if (response.status === 401 || response.status === 403) {
      return { ok: true, detail: `GET ${url} → ${response.status}（DSH 在线，需要鉴权）` };
    }
    return { ok: false, error: `DSH 返回 HTTP ${response.status}`, detail: `GET ${url} → ${response.status}` };
  } catch (error) {
    return { ok: false, error: apNetworkErrorText(error), detail: `GET ${url} 失败` };
  }
}

async function apProbeHttp(deps, { baseUrl, apiKey, timeoutMs }) {
  // 自研 HTTP agent 的健康检查：只要 /health 回 200 就认为端点活着；
  // 401/403 说明「进程在、但要鉴权」——和 dsh 一样按可达处理之外，这里明确报需要鉴权。
  const url = `${baseUrl}/health`;
  try {
    const response = await apRequest(deps, url, { method: 'GET', headers: apHeaders(apiKey) }, timeoutMs);
    if (response.ok) return { ok: true, detail: `GET ${url} → ${response.status}` };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: '需要鉴权（检查 agent.apiKey）', detail: `GET ${url} → ${response.status}` };
    }
    return { ok: false, error: `端点返回 HTTP ${response.status}（检查 baseUrl 是否指向自研 HTTP agent）`, detail: `GET ${url} → ${response.status}` };
  } catch (error) {
    return { ok: false, error: apNetworkErrorText(error), detail: `GET ${url} 失败` };
  }
}

async function apProbe(deps, input) {
  const cfg = (deps.cfg && typeof deps.cfg === 'object' ? deps.cfg.agent : null) || {};
  const type = AGENT_PROBE_TYPES.includes(input.type) ? input.type : (AGENT_PROBE_TYPES.includes(cfg.type) ? cfg.type : 'dsh');
  const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : String(cfg.model || '');
  const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : String(cfg.apiKey || '');
  const hasApiKey = apiKey !== '';
  const timeoutMs = apClampTimeout(input.timeoutMs ?? cfg.timeoutMs);
  let rawBase = typeof input.baseUrl === 'string' && input.baseUrl.trim() ? input.baseUrl : String(cfg.baseUrl || '');
  // dsh 后端的地址在 dsh.baseUrl 里（agent.baseUrl 是给 openai/http 用的）：
  // 没显式填 agent.baseUrl 时回退到 dsh.baseUrl，否则设置页的「测试连通」永远报「地址没配置」。
  if (type === 'dsh' && !String(rawBase || '').trim()) {
    const dshCfg = (deps.cfg && typeof deps.cfg === 'object' ? deps.cfg.dsh : null) || {};
    rawBase = String(dshCfg.baseUrl || dshCfg.url || '');
  }
  if (!String(rawBase || '').trim() && type === 'dsh') {
    agentProbeLast = { at: Date.now(), ok: false, latencyMs: 0, type, model };
    return { ok: false, type, model, latencyMs: 0, detail: '没有发请求', error: 'DSH 地址没配置（agent.baseUrl 为空）', hasApiKey };
  }
  const base = apNormalizeBaseUrl(deps, rawBase);
  const startedAt = Date.now();
  const baseResult = base.ok ? null : { ok: false, type, model, latencyMs: 0, detail: '没有发请求', error: base.error, hasApiKey };
  if (baseResult) {
    agentProbeLast = { at: startedAt, ok: false, latencyMs: 0, type, model };
    return baseResult;
  }
  const result = type === 'openai'
    ? await apProbeOpenai(deps, { baseUrl: base.baseUrl, model, apiKey, timeoutMs })
    : type === 'dsh'
      ? await apProbeDsh(deps, { baseUrl: base.baseUrl, apiKey, timeoutMs })
      : await apProbeHttp(deps, { baseUrl: base.baseUrl, apiKey, timeoutMs });
  const latencyMs = Date.now() - startedAt;
  agentProbeLast = { at: startedAt, ok: result.ok === true, latencyMs, type, model };
  return { ok: result.ok === true, type, model, latencyMs, detail: result.detail || '', error: result.ok ? undefined : String(result.error || '探活失败'), hasApiKey };
}

export function createAgentProbe(deps) {
// @bridge-function handleConsoleAgentProbe:start
async function handleConsoleAgentProbe(request) {
    const { req, url, sendJson, readBody } = request;
    if (url.pathname !== AGENT_PROBE_PATH) return false;
    if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
      sendJson({ ok: false, error: '未授权：探活是管理端操作' }, 403);
      return true;
    }
    if (req.method !== 'POST') {
      sendJson({ ok: false, error: '该接口只支持 POST' }, 405);
      return true;
    }
    let body = {};
    try {
      body = (await readBody({ maxBytes: 16 * 1024 })) || {};
    } catch {
      sendJson({ ok: false, error: '请求体不是合法的 JSON' }, 200);
      return true;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    try {
      const result = await apProbe(deps, body);
      sendJson(result, 200);
      return true;
    } catch (error) {
      // 探活是给设置页按钮用的：任何意外都回人话，绝不 500。
      if (typeof deps.log === 'function') deps.log(`[agent 探活] 意外失败：${error && error.message ? error.message : error}`);
      sendJson({ ok: false, type: 'unknown', model: '', latencyMs: 0, detail: '', error: `探活失败：${error && error.message ? error.message : error}` }, 200);
      return true;
    }
  }
// @bridge-function handleConsoleAgentProbe:end
  const service = { handleConsoleAgentProbe };
  // lastProbe 是给 GET /api/config 用的内部只读口：不放进 manifest functions（不可枚举）。
  Object.defineProperty(service, 'lastProbe', { value: apPublicLast, enumerable: false });
  return service;
}
