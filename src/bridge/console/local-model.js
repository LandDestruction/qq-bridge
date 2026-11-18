// 控制台「本地模型」一等公民：GET /api/local-model/status、POST /api/local-model/apply、
// POST /api/local-model/restart-bridge。
//
// 设计：
// - **零 import**（VM 沙箱会剥掉 import，模块自己不能有依赖）；文件/进程/网络能力全从 deps 取。
// - 动作实现只有一份：scripts/local-model.mjs。本模块只做「参数校验 + spawn 脚本 + 解析 JSON」，
//   这样 CLI 与控制台行为永远一致（脚本也支持人直接跑）。
// - 引擎离线不是错误：status 永远 200，engine.online=false；探活失败也只是 probe.ok=false。
// - 重启桥接必须**脱离当前进程**：写一个一次性 PowerShell 脚本，detached 拉起后立即返回
//   {ok:true,restarting:true}；本模块绝不在请求处理里杀自己。
// - pendingRestart 用「装配时的 agent 快照」对比 config 文件里的 agent：桥接启动时才选 transport，
//   之后改 config 必须重启才生效——这就是控制台要显示「待重启」的原因。

const LML_STATUS_PATH = '/api/local-model/status';
const LML_APPLY_PATH = '/api/local-model/apply';
const LML_RESTART_PATH = '/api/local-model/restart-bridge';
const LML_ACTIONS = Object.freeze(['enable', 'disable', 'switch-dsh']);
const LML_SIZES = Object.freeze(['UD-Q4_K_XL', 'UD-Q6_K_XL', 'Q8_0']);
const LML_CONTEXTS = Object.freeze(['8k', '16k', '32k']);
const LML_VISION_MODES = Object.freeze(['cpu', 'off']);
const LML_PORTS = Object.freeze([8080, 8081, 8082, 8090]);
const LML_DEFAULTS = Object.freeze({ model: 'UD-Q4_K_XL', context: '8k', vision: 'cpu', port: 8080, dataDir: 'E:/models/strata/data' });
const LML_SCRIPT_TIMEOUT_MS = 180000;

function lmlModelId(applied) {
  const model = String(applied?.model || LML_DEFAULTS.model);
  return `qwen3.6-35b-a3b-${model.toLowerCase()}`;
}

function lmlModelFile(applied) {
  const dir = String(applied?.dataDir || LML_DEFAULTS.dataDir).replace(/\\/g, '/').replace(/\/+$/, '');
  const model = String(applied?.model || LML_DEFAULTS.model);
  return `${dir}/qwen36/Qwen3.6-35B-A3B-${model}/Qwen3.6-35B-A3B-${model}.gguf`;
}

// 宽松读 config.localModel：历史配置可能缺字段，缺/坏就回默认，绝不抛。
function lmlApplied(cfg) {
  const raw = cfg && typeof cfg === 'object' && cfg.localModel && typeof cfg.localModel === 'object' ? cfg.localModel : {};
  const model = LML_SIZES.includes(String(raw.model || '').toUpperCase()) ? String(raw.model).toUpperCase() : LML_DEFAULTS.model;
  const context = LML_CONTEXTS.includes(String(raw.context || '').toLowerCase()) ? String(raw.context).toLowerCase() : LML_DEFAULTS.context;
  const vision = LML_VISION_MODES.includes(String(raw.vision || '').toLowerCase()) ? String(raw.vision).toLowerCase() : LML_DEFAULTS.vision;
  const port = Number.isInteger(Number(raw.port)) && Number(raw.port) > 0 && Number(raw.port) < 65536 ? Number(raw.port) : LML_DEFAULTS.port;
  const dataDir = typeof raw.dataDir === 'string' && raw.dataDir.trim() ? raw.dataDir.trim() : LML_DEFAULTS.dataDir;
  return { model, context, vision, port, dataDir };
}

// 从脚本 stdout 里抠 JSON（stdout 只应该有一份 JSON，但容错 BOM/调试行）。
export function lmlParseCliJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
}

// 判断 config 文件的 agent 与装配快照是否一致；不一致说明「配置改了但没重启」。
export function lmlPendingRestart(bootAgent, fileAgent) {
  const boot = bootAgent && typeof bootAgent === 'object' ? bootAgent : {};
  const file = fileAgent && typeof fileAgent === 'object' ? fileAgent : {};
  return String(boot.type || 'dsh') !== String(file.type || 'dsh')
    || String(boot.baseUrl || '') !== String(file.baseUrl || '')
    || String(boot.model || '') !== String(file.model || '');
}

// apply 的 CLI 参数拼装：只把 body 里真给了的字段传下去，缺省让脚本读 config.localModel。
export function lmlBuildApplyArgs(body) {
  const args = ['apply', '--json', '--action', String(body.action)];
  if (body.model !== undefined) args.push('--model', String(body.model));
  if (body.context !== undefined) args.push('--context', String(body.context));
  if (body.vision !== undefined) args.push('--vision', String(body.vision));
  if (body.port !== undefined) args.push('--port', String(body.port));
  if (body.dataDir !== undefined) args.push('--data-dir', String(body.dataDir));
  return args;
}

// 一次性重启脚本：等 700ms（让 HTTP 响应先发出去）→ 杀 node bridge.js → 重新拉起。
export function lmlRestartScript(ROOT, nodePath, pid) {
  const quote = String(ROOT || '').replace(/'/g, "''");
  const node = String(nodePath || 'node').replace(/'/g, "''");
    const logFile = String(ROOT || '').replace(/'/g, "''") + '/state/local-model-restart.log';
  // 2026-11-01：以前用 Start-Process -FilePath 'node' 且 SilentlyContinue —— 在隐藏窗口里 node
  // 不在 PATH，失败被吞掉，控制台点「重启」其实没重启（进程还是旧的）。现在按 PID 精确停旧进程、
  // 用当前 node 的绝对路径重启，并写一行日志便于排查。
  const target = Number(pid) > 0 ? Math.floor(Number(pid)) : 0;
  return [
    '$ErrorActionPreference = "Continue"',
    'Start-Sleep -Milliseconds 900',
    target ? `Stop-Process -Id ${target} -Force -ErrorAction SilentlyContinue` : '',
    'Start-Sleep -Milliseconds 500',
    `"$(Get-Date -Format o) restart by console pid=${target}" | Out-File -FilePath '${logFile}' -Append -Encoding utf8`,
    `Start-Process -FilePath '${node}' -ArgumentList 'src/bridge.js' -WorkingDirectory '${quote}' -WindowStyle Hidden`,
    ''
  ].filter(Boolean).join(String.fromCharCode(13, 10));
}

function lmlScriptPath(deps) {
  return deps.path.join(deps.ROOT, 'scripts', 'local-model.mjs');
}

function lmlNodePath() {
  if (typeof process === 'object' && process && typeof process.execPath === 'string' && process.execPath) return process.execPath;
  return 'node';
}

// spawn 脚本并收集 stdout：resolve {code,stdout,stderr}；spawn 不可用/超时 reject。
function lmlRunScript(deps, args) {
  return new Promise((resolve, reject) => {
    const spawnImpl = deps.spawn;
    if (typeof spawnImpl !== 'function') { reject(new Error('当前环境没有 spawn，无法调用本地模型脚本')); return; }
    const child = spawnImpl(lmlNodePath(), [lmlScriptPath(deps), ...args], { cwd: deps.ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!child || typeof child.on !== 'function') { reject(new Error('spawn 返回值不是子进程')); return; }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; if (timer) deps.clearTimeout(timer); fn(value); };
    const timer = deps.setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(reject, new Error('本地模型脚本超时（60 秒）'));
    }, LML_SCRIPT_TIMEOUT_MS);
    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', (chunk) => { if (stdout.length < 1024 * 1024) stdout += String(chunk); });
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', (chunk) => { if (stderr.length < 64 * 1024) stderr += String(chunk); });
    child.on('error', (error) => finish(reject, error instanceof Error ? error : new Error(String(error))));
    child.on('close', (code) => finish(resolve, { code: Number(code) || 0, stdout, stderr }));
  });
}

// status 的兜底形状：脚本没跑起来（spawn 不可用/异常）也要给前端一个完整对象，不能 500。
function lmlFallbackStatus(cfg, bootAgent, reason) {
  const applied = lmlApplied(cfg);
  return {
    ok: true,
    engine: { online: false, pid: null, port: applied.port, model: lmlModelId(applied), modelFile: lmlModelFile(applied), context: applied.context, error: reason },
    bridge: {
      agentType: String(cfg?.agent?.type || 'dsh'),
      baseUrl: String(cfg?.agent?.baseUrl || ''),
      model: String(cfg?.agent?.model || ''),
      running: true,
      pid: (typeof process === 'object' && process ? Number(process.pid) || null : null),
      pendingRestart: lmlPendingRestart(bootAgent, cfg?.agent)
    },
    options: {
      applied,
      defaults: { ...LML_DEFAULTS },
      sizes: [...LML_SIZES],
      contexts: [...LML_CONTEXTS],
      visionModes: [...LML_VISION_MODES],
      ports: [...LML_PORTS]
    },
    probe: { ok: false, latencyMs: 0, detail: reason }
  };
}

// 把脚本 status --json 的原始对象整理成前端契约（补 pendingRestart / options 分组）。
function lmlPublicStatus(deps, payload, bootAgent) {
  const cfg = deps.cfg && typeof deps.cfg === 'object' ? deps.cfg : {};
  if (!payload || typeof payload !== 'object') return lmlFallbackStatus(cfg, bootAgent(), '状态脚本没有返回 JSON');
  const applied = payload.applied && typeof payload.applied === 'object' ? payload.applied : lmlApplied(cfg);
  const engine = payload.engine && typeof payload.engine === 'object' ? payload.engine : {};
  const bridge = payload.bridge && typeof payload.bridge === 'object' ? payload.bridge : {};
  const probe = payload.probe && typeof payload.probe === 'object' ? payload.probe : { ok: false, latencyMs: 0, detail: '未探活' };
  return {
    ok: true,
    engine: {
      online: engine.online === true,
      pid: engine.pid ?? null,
      port: engine.port ?? applied.port,
      model: String(engine.model || lmlModelId(applied)),
      modelFile: String(engine.modelFile || lmlModelFile(applied)),
      context: String(engine.context || applied.context),
      ...(engine.online === true ? {} : { error: String(engine.error || '离线') })
    },
    bridge: {
      agentType: String(bridge.agentType || 'dsh'),
      baseUrl: String(bridge.baseUrl || ''),
      model: String(bridge.model || ''),
      running: bridge.running === true || Number(bridge.pid) > 0,
      pid: bridge.pid ?? null,
      pendingRestart: lmlPendingRestart(bootAgent, { type: bridge.agentType, baseUrl: bridge.baseUrl, model: bridge.model })
    },
    options: {
      applied,
      defaults: { ...LML_DEFAULTS },
      sizes: [...LML_SIZES],
      contexts: [...LML_CONTEXTS],
      visionModes: [...LML_VISION_MODES],
      ports: [...LML_PORTS]
    },
    probe: { ok: probe.ok === true, latencyMs: Number(probe.latencyMs) || 0, detail: String(probe.detail || '') }
  };
}

function lmlAgentHeaders(request) {
  const headers = request?.req?.headers || {};
  return headers['x-agent-token'] !== undefined || headers['x-agent-call'] !== undefined;
}

export function createConsoleLocalModel(deps) {
  // 装配期在 VM 沙箱里可能先于 live binding 就绪（审计 harness 会同步构造每个模块），
  // 所以不能在工厂里直接读 deps.cfg；首次请求时才快照，之后固定不变。
  let bootAgentSnapshot = null;
  let bootAgentTaken = false;
  const bootAgent = () => {
    if (bootAgentTaken) return bootAgentSnapshot;
    bootAgentTaken = true;
    try {
      const agent = deps && deps.cfg && typeof deps.cfg === 'object' ? deps.cfg.agent : null;
      bootAgentSnapshot = agent && typeof agent === 'object'
        ? { type: agent.type || 'dsh', baseUrl: agent.baseUrl || '', model: agent.model || '' }
        : { type: 'dsh', baseUrl: '', model: '' };
    } catch {
      bootAgentSnapshot = { type: 'dsh', baseUrl: '', model: '' };
    }
    return bootAgentSnapshot;
  };
  // 同上：deps.log 也是 live binding，首次打印时才取。
  const log = (...parts) => {
    try {
      const fn = deps && deps.log;
      if (typeof fn === 'function') fn(...parts);
    } catch { /* 日志失败不影响接口 */ }
  };

// @bridge-function handleConsoleLocalModel:start
async function handleConsoleLocalModel(request) {
    const { req, url, sendJson, readBody } = request;
    const pathname = url.pathname;
    if (pathname !== LML_STATUS_PATH && pathname !== LML_APPLY_PATH) return false;
    if (lmlAgentHeaders(request)) {
      sendJson({ ok: false, error: '未授权：本地模型管理是管理端操作' }, 403);
      return true;
    }
    if (pathname === LML_STATUS_PATH) {
      if (req.method !== 'GET') { sendJson({ ok: false, error: '该接口只支持 GET' }, 405); return true; }
      const cfg = deps.cfg && typeof deps.cfg === 'object' ? deps.cfg : {};
      try {
        const result = await lmlRunScript(deps, ['status', '--json']);
        const payload = result.code === 0 ? lmlParseCliJson(result.stdout) : null;
        if (payload) { sendJson(lmlPublicStatus(deps, payload, bootAgent()), 200); return true; }
        const stderr = String(result.stderr || '').trim();
        log(`[本地模型] status 脚本返回异常（code=${result.code}）：${stderr || '无输出'}`);
        sendJson(lmlFallbackStatus(cfg, bootAgent(), stderr ? `状态脚本失败：${stderr.slice(0, 200)}` : '状态脚本失败'), 200);
        return true;
      } catch (error) {
        log(`[本地模型] status 失败：${error && error.message ? error.message : error}`);
        sendJson(lmlFallbackStatus(cfg, bootAgent(), `状态脚本失败：${error && error.message ? error.message : error}`), 200);
        return true;
      }
    }
    if (req.method !== 'POST') { sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }
    let body = {};
    try {
      body = (await readBody({ maxBytes: 16 * 1024 })) || {};
    } catch {
      sendJson({ ok: false, error: '请求体不是合法的 JSON' }, 400);
      return true;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    const action = String(body.action || 'enable').toLowerCase();
    if (!LML_ACTIONS.includes(action)) {
      sendJson({ ok: false, error: `不认识的 action：${body.action}（可选：${LML_ACTIONS.join(' / ')}）` }, 400);
      return true;
    }
    const args = lmlBuildApplyArgs({ ...body, action });
    let result;
    try {
      result = await lmlRunScript(deps, args);
    } catch (error) {
      sendJson({ ok: false, error: `本地模型脚本执行失败：${error && error.message ? error.message : error}` }, 500);
      return true;
    }
    const payload = lmlParseCliJson(result.stdout);
    if (!payload) {
      const stderr = String(result.stderr || '').trim().slice(0, 200);
      sendJson({ ok: false, error: stderr || '本地模型脚本没有返回 JSON' }, 500);
      return true;
    }
    if (payload.ok !== true) {
      sendJson({ ok: false, error: String(payload.error || '本地模型操作失败') }, 400);
      return true;
    }
    log(`[本地模型] apply ${action} 完成：${payload.applied?.model || ''} / ${payload.applied?.context || ''}（started=${payload.started === true}）`);
    sendJson({ ...payload, ok: true, restartRequired: true }, 200);
    return true;
  }
// @bridge-function handleConsoleLocalModel:end

// @bridge-function handleConsoleLocalModelRestart:start
async function handleConsoleLocalModelRestart(request) {
    const { req, url, sendJson } = request;
    if (url.pathname !== LML_RESTART_PATH) return false;
    if (lmlAgentHeaders(request)) {
      sendJson({ ok: false, error: '未授权：重启桥接是管理端操作' }, 403);
      return true;
    }
    if (req.method !== 'POST') { sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }
    const spawnImpl = deps.spawn;
    if (typeof spawnImpl !== 'function') {
      sendJson({ ok: false, error: '当前环境没有 spawn，无法重启桥接' }, 500);
      return true;
    }
    const scriptFile = deps.path.join(deps.STATE_DIR, 'local-model-restart.ps1');
    try {
      deps.fs.mkdirSync(deps.STATE_DIR, { recursive: true });
      deps.fs.writeFileSync(scriptFile, lmlRestartScript(deps.ROOT, lmlNodePath(), process.pid), 'utf8');
      const child = spawnImpl('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
        cwd: deps.ROOT, detached: true, stdio: 'ignore', windowsHide: true
      });
      if (child && typeof child.unref === 'function') child.unref();
      log('[本地模型] 已安排桥接重启（detached PowerShell），本进程稍后被替换');
      sendJson({ ok: true, restarting: true }, 200);
      return true;
    } catch (error) {
      log(`[本地模型] 重启桥接失败：${error && error.message ? error.message : error}`);
      sendJson({ ok: false, error: `重启桥接失败：${error && error.message ? error.message : error}` }, 500);
      return true;
    }
  }
// @bridge-function handleConsoleLocalModelRestart:end

  return { handleConsoleLocalModel, handleConsoleLocalModelRestart };
}
