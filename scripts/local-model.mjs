#!/usr/bin/env node
/**
 * 本地模型（Strata + Qwen3.6）一键管理：
 *
 *   node scripts/local-model.mjs status            # 看引擎/后端/桥接三方状态
 *   node scripts/local-model.mjs start             # 起引擎 → 切后端到本地 → 重启桥接 → 探活
 *   node scripts/local-model.mjs stop              # 停引擎 → 切回 DSH → 重启桥接
 *   node scripts/local-model.mjs restart           # = stop + start
 *   node scripts/local-model.mjs apply --action enable|disable|switch-dsh
 *
 * 控制台走的是 `--json`：所有子命令都只往 stdout 打一份 JSON，人话/等待全部关掉，
 * 这样桥接（src/bridge/console/local-model.js）能直接 spawn 本脚本并 JSON.parse 结果。
 *
 * `start --json` **不阻塞到就绪**：起进程后立刻返回 {started,pid}，就绪由 status 轮询。
 * 不带 `--json` 的旧用法保持原样（等就绪、切 agent、重启桥接、探活）。
 *
 * 只看不动的命令（status）是可读的；start/stop/apply 会真的启停进程、改 config.json；
 * 不带 --json 时还会重启桥接（QQ 机器人会短暂离线 10~20 秒）。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'config.json');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'local-model.json');
const BRIDGE = 'http://127.0.0.1:3100';
const BRIDGE_TOKEN_FILE = path.join(STATE_DIR, 'console-token');

// 引擎档位：都是 strata 上实际存在的 gguf。顺序即前端下拉顺序（默认第一档 UD-Q4_K_XL）。
export const LM_SIZES = Object.freeze(['UD-Q4_K_XL', 'UD-Q6_K_XL', 'Q8_0']);
export const LM_CONTEXTS = Object.freeze(['8k', '16k', '32k']);
export const LM_VISION_MODES = Object.freeze(['cpu', 'off']);
export const LM_PORTS = Object.freeze([8080, 8081, 8082, 8090]);
export const LM_DEFAULTS = Object.freeze({
  model: 'UD-Q4_K_XL',
  context: '8k',
  vision: 'cpu',
  port: 8080,
  dataDir: process.env.STRATA_DATA_DIR || 'E:/models/strata/data'
});
const LM_MODEL_FAMILY_DIR = 'qwen36';
const LM_MODEL_FILE_PREFIX = 'Qwen3.6-35B-A3B';

function delay(ms) {
  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); if (timer.unref) timer.unref(); });
}

// ── 配置片段：只读/只写 config.json 里属于本地模型的两段（localModel + agent）──
export function lmDefaults() {
  return { ...LM_DEFAULTS };
}

export function lmModelFile(options) {
  const dir = String(options.dataDir || LM_DEFAULTS.dataDir).replace(/\\/g, '/').replace(/\/+$/, '');
  return `${dir}/${LM_MODEL_FAMILY_DIR}/${LM_MODEL_FILE_PREFIX}-${options.model}/${LM_MODEL_FILE_PREFIX}-${options.model}.gguf`;
}

// 引擎 /v1/models 里的 id 就是 gguf 主名的小写：Qwen3.6-35B-A3B-UD-Q4_K_XL → qwen3.6-35b-a3b-ud-q4_k_xl。
export function lmModelId(options) {
  const base = path.basename(lmModelFile(options)).replace(/\.gguf$/i, '');
  return base.toLowerCase();
}

// 参数归一化：所有入口（CLI 与桥接 HTTP）都先过这里，非法值给中文原因而不是让引擎崩在后面。
export function lmNormalizeOptions(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const pick = (value, fallback) => (value === undefined || value === null || value === '' ? fallback : value);
  const model = String(pick(input.model, LM_DEFAULTS.model)).trim().toUpperCase();
  if (!LM_SIZES.includes(model)) return { ok: false, error: `不认识的模型档位：${model}（可选：${LM_SIZES.join(' / ')}）` };
  const context = String(pick(input.context, LM_DEFAULTS.context)).trim().toLowerCase();
  if (!LM_CONTEXTS.includes(context)) return { ok: false, error: `不认识的上下文长度：${context}（可选：${LM_CONTEXTS.join(' / ')}）` };
  const vision = String(pick(input.vision, LM_DEFAULTS.vision)).trim().toLowerCase();
  if (!LM_VISION_MODES.includes(vision)) return { ok: false, error: `不认识的视觉模式：${vision}（可选：${LM_VISION_MODES.join(' / ')}）` };
  const rawPort = pick(input.port, LM_DEFAULTS.port);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: `端口不合法：${rawPort}（应为 1~65535 的整数）` };
  const dataDir = String(pick(input.dataDir, LM_DEFAULTS.dataDir)).trim();
  if (!dataDir) return { ok: false, error: '数据目录不能为空（--data-dir）' };
  if (!path.isAbsolute(dataDir)) return { ok: false, error: `数据目录必须是绝对路径：${dataDir}` };
  return { ok: true, options: { model, context, vision, port, dataDir } };
}

// 读回 config.json 的 localModel 段：历史配置可能缺字段/写坏，这里只做宽松兜底，绝不抛错。
export function lmAppliedFromConfig(cfg) {
  const raw = cfg && typeof cfg === 'object' && cfg.localModel && typeof cfg.localModel === 'object' ? cfg.localModel : {};
  const merged = {
    model: raw.model ?? LM_DEFAULTS.model,
    context: raw.context ?? LM_DEFAULTS.context,
    vision: raw.vision ?? LM_DEFAULTS.vision,
    port: raw.port ?? LM_DEFAULTS.port,
    dataDir: raw.dataDir ?? LM_DEFAULTS.dataDir
  };
  const normalized = lmNormalizeOptions(merged);
  return normalized.ok ? normalized.options : { ...LM_DEFAULTS };
}

export function lmBuildLaunchArgs(options) {
  return [
    'launch', '--family', 'qwen36', '--model', options.model, '--context', options.context,
    '--kv', 'q4_0', '--parallel', '1', '--vision', options.vision, '--mtp', 'off',
    '--port', String(options.port), '--data-dir', options.dataDir,
    '--set', 'engine_ready_s=2400', '--restart'
  ];
}

// 切到本地模型：保留 agent 段里已有的工具白名单/超时/密钥等，只换后端三件套 + 关思考。
// Qwen3.6 默认会先输出一长段思考链，QQ 聊天要的是直接回答。
export function lmAgentForLocal(agent, options) {
  const base = agent && typeof agent === 'object' ? { ...agent } : {};
  const extraBody = base.extraBody && typeof base.extraBody === 'object' ? { ...base.extraBody } : {};
  const template = extraBody.chat_template_kwargs && typeof extraBody.chat_template_kwargs === 'object' ? { ...extraBody.chat_template_kwargs } : {};
  template.enable_thinking = false;
  extraBody.chat_template_kwargs = template;
  return {
    ...base,
    type: 'openai',
    baseUrl: `http://127.0.0.1:${options.port}/v1`,
    model: lmModelId(options),
    extraBody
  };
}

export function lmAgentForDsh(agent) {
  const base = agent && typeof agent === 'object' ? { ...agent } : {};
  return { ...base, type: 'dsh', baseUrl: '', model: '', extraBody: {} };
}

// 把一次 apply 落成新的 config 对象（纯函数，方便测试；真正写盘由调用方负责）。
export function lmApplyToConfig(cfg, action, options) {
  const next = cfg && typeof cfg === 'object' ? { ...cfg } : {};
  const applied = lmNormalizeOptions(options);
  if (!applied.ok) return { ok: false, error: applied.error };
  next.localModel = { ...applied.options };
  const verb = String(action || '').toLowerCase();
  if (verb === 'disable' || verb === 'switch-dsh') {
    next.agent = lmAgentForDsh(next.agent);
    return { ok: true, action: verb === 'switch-dsh' ? 'disable' : verb, next, applied: applied.options, agent: next.agent };
  }
  next.agent = lmAgentForLocal(next.agent, applied.options);
  return { ok: true, action: 'enable', next, applied: applied.options, agent: next.agent };
}

// ── 配置 / 状态文件读写 ──
export function lmReadConfig(file = CONFIG) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const cfg = JSON.parse(text);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('config.json 顶层不是对象，已拒绝改写');
  return cfg;
}

export function lmWriteConfig(cfg, file = CONFIG) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

export function lmReadState(file = STATE_FILE) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

export function lmWriteState(state, file = STATE_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch { /* 状态文件只是加速展示，写失败不影响主流程 */ }
}

// ── 进程查询（Windows）：strata.exe / node bridge.js ──
export function lmStrataPids(exec = execFileSync) {
  try {
    const out = exec('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='strata.exe'\" | Select-Object -ExpandProperty ProcessId"
    ], { encoding: 'utf8' });
    return String(out || '').split(/\r?\n/).map((v) => Number(v.trim())).filter(Boolean);
  } catch { return []; }
}

export function lmBridgePids(exec = execFileSync) {
  try {
    const out = exec('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'src[/\\\\]bridge\\.js' } | Select-Object -ExpandProperty ProcessId"
    ], { encoding: 'utf8' });
    return String(out || '').split(/\r?\n/).map((v) => Number(v.trim())).filter(Boolean);
  } catch { return []; }
}

export function lmKillPids(pids, exec = execFileSync) {
  for (const pid of Array.isArray(pids) ? pids : []) {
    try { exec('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${Number(pid)} -Force -ErrorAction SilentlyContinue`]); } catch { /* 忽略 */ }
  }
}

// ── 探活：引擎 /v1/models；桥接 /api/agent/probe ──
export async function lmProbeEngine(port, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { try { controller?.abort(); } catch { /* ignore */ } }, timeoutMs);
  const url = `http://127.0.0.1:${port}/v1/models`;
  try {
    const res = await fetchImpl(url, { signal: controller?.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    const model = body?.data?.[0];
    return {
      ok: true,
      model: String(model?.id || ''),
      context: Number(model?.meta?.n_ctx || 0) || null,
      modalities: Array.isArray(model?.architecture?.input_modalities) ? model.architecture.input_modalities : []
    };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? '超时' : String(error?.message || error) };
  } finally { clearTimeout(timer); }
}

export async function lmProbeAgent({ fetchImpl = fetch, token = '', timeoutMs = 8000 } = {}) {
  const startedAt = Date.now();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { try { controller?.abort(); } catch { /* ignore */ } }, timeoutMs);
  try {
    const res = await fetchImpl(`${BRIDGE}/api/agent/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-console-token': token } : {}) },
      body: '{}',
      signal: controller?.signal
    });
    const body = await res.json().catch(() => null);
    return { ok: Boolean(body?.ok), latencyMs: Date.now() - startedAt, detail: String(body?.detail || body?.error || '') };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, detail: error?.name === 'AbortError' ? '超时' : '桥接不可访问' };
  } finally { clearTimeout(timer); }
}

export function lmBridgeToken() {
  try { return fs.readFileSync(BRIDGE_TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}

// ── 状态聚合（纯函数：所有值由调用方给，测试不用起真进程）──
export function lmStatusPayload({ cfg, applied, health, probe, strataPids = [], bridgePids = [], bridgeOk = false, state = null }) {
  const agent = (cfg && cfg.agent && typeof cfg.agent === 'object') ? cfg.agent : {};
  const local = applied || lmAppliedFromConfig(cfg);
  const online = Boolean(health && health.ok);
  return {
    ok: true,
    engine: {
      online,
      pid: Number(strataPids[0] ?? state?.pid ?? 0) || null,
      port: local.port,
      model: online && health.model ? health.model : lmModelId(local),
      modelFile: lmModelFile(local),
      context: local.context,
      ...(online ? {} : { error: String(health?.error || '离线') })
    },
    bridge: {
      agentType: String(agent.type || 'dsh'),
      baseUrl: String(agent.baseUrl || ''),
      model: String(agent.model || ''),
      running: Boolean(bridgeOk || (bridgePids && bridgePids.length)),
      pid: Number(bridgePids?.[0] ?? 0) || null
    },
    applied: local,
    defaults: lmDefaults(),
    sizes: [...LM_SIZES],
    contexts: [...LM_CONTEXTS],
    visionModes: [...LM_VISION_MODES],
    ports: [...LM_PORTS],
    probe: probe || { ok: false, latencyMs: 0, detail: '未探活' }
  };
}

// ── 引擎启停 ──
// `strata` 在 Windows 上只是 terminal\currentin 下的 .ps1/.cmd shim，裸 spawn('strata') 会 ENOENT
// （2026-11-01 控制台开关「点了又弹回去」的真因）。这里统一解析成能真正跑的命令。
export function lmStrataCommand() {
  const envBin = String(process.env.STRATA_BIN || '').trim();
  if (envBin) return { file: envBin, prefix: [] };
  const local = String(process.env.LOCALAPPDATA || '').trim();
  const ps1 = local ? path.join(local, 'Strata', 'terminal', 'current', 'bin', 'strata.ps1') : '';
  if (ps1 && fs.existsSync(ps1)) {
    return { file: 'powershell.exe', prefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1] };
  }
  return { file: 'strata', prefix: [] };
}

export async function lmStopEngine({ exec = execFileSync } = {}) {
  const before = lmStrataPids(exec);
  if (!before.length) return { stopped: false, pids: [] };
  const cmd = lmStrataCommand();
  try { exec(cmd.file, [...cmd.prefix, 'launch', '--stop'], { cwd: ROOT, stdio: 'ignore', timeout: 60000, windowsHide: true }); } catch { /* 没有此命令也继续强杀 */ }
  await delay(3000);
  lmKillPids(before, exec);
  return { stopped: true, pids: before };
}

export function lmStartProcessCommand(file, args) {
  const quote = (v) => "'" + String(v).replace(/'/g, "''") + "'";
  const list = [file, ...(args || [])].map(quote).join(',');
  return `Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(${list})`;
}

export function lmStartEngine(spawnImpl, options, exec = execFileSync) {
  const stray = lmStrataPids(exec);
  if (stray.length) { lmKillPids(stray, exec); }
  const cmd = lmStrataCommand();
  const args = [...cmd.prefix, ...lmBuildLaunchArgs(options)];
  // Windows 上必须再套一层 Start-Process：直接 detached spawn powershell -File 会随父进程退出被回收，
  // 表现为「返回了 pid 但引擎永远不来」（2026-11-01 实测）。
  const child = spawnImpl('powershell.exe', ['-NoProfile', '-Command', lmStartProcessCommand(cmd.file, args)], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
  if (child && typeof child.on === 'function') {
    child.on('error', (err) => { try { console.error(`启动引擎失败（${cmd.file}）：${err && err.message ? err.message : err}`); } catch { /* ignore */ } });
  }
  if (child && typeof child.unref === 'function') child.unref();
  return Number(child?.pid) || null;
}

// 旧用法：重启桥接（杀 node src/bridge.js 再拉起）。控制台走 /api/local-model/restart-bridge，
// 不经过这里（桥接不能在自己进程里杀自己）。
export function lmRestartBridge(spawnImpl = spawn) {
  lmKillPids(lmBridgePids());
  try { fs.rmSync(path.join(STATE_DIR, 'bridge.lock'), { force: true }); } catch { /* 忽略 */ }
  const child = spawnImpl('node', ['src/bridge.js'], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
  if (child && typeof child.unref === 'function') child.unref();
  return Number(child?.pid) || null;
}

export async function lmWaitBridgeReady(ms = 25000) {
  const deadline = Date.now() + ms;
  const token = lmBridgeToken();
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BRIDGE}/api/status`, { headers: token ? { 'x-console-token': token } : {} });
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await delay(1000);
  }
  return false;
}

export async function lmWaitEngineReady(port, ms = 12 * 60 * 1000, onTick) {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    const health = await lmProbeEngine(port, { timeoutMs: 3000 });
    if (health.ok) return health;
    const label = String(health.error || '');
    if (onTick && label !== last) { last = label; onTick(label); }
    await delay(5000);
  }
  return { ok: false, error: '等待超时' };
}

// ── 参数解析 ──
export function lmParseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const out = { command: String(args[0] || 'status').toLowerCase(), json: false, flags: {} };
  for (let i = 1; i < args.length; i += 1) {
    const token = String(args[i]);
    if (token === '--json') { out.json = true; continue; }
    if (token === '--help' || token === '-h') { out.help = true; continue; }
    if (!token.startsWith('--')) { out.positional = token; continue; }
    const name = token.slice(2);
    const next = args[i + 1];
    const takesValue = ['model', 'context', 'vision', 'port', 'data-dir', 'action'].includes(name);
    if (!takesValue) { out.flags[name] = true; continue; }
    out.flags[name] = next === undefined || String(next).startsWith('--') ? '' : String(next);
    if (out.flags[name] !== '') i += 1;
  }
  return out;
}

// 从 flags 拼出 options 来源：flags 优先，缺省读 config.localModel。
export function lmOptionsFromArgs(flags, cfg) {
  const base = lmAppliedFromConfig(cfg);
  const raw = {
    model: flags.model !== undefined && flags.model !== '' ? flags.model : base.model,
    context: flags.context !== undefined && flags.context !== '' ? flags.context : base.context,
    vision: flags.vision !== undefined && flags.vision !== '' ? flags.vision : base.vision,
    port: flags.port !== undefined && flags.port !== '' ? flags.port : base.port,
    dataDir: flags['data-dir'] !== undefined && flags['data-dir'] !== '' ? flags['data-dir'] : base.dataDir
  };
  return lmNormalizeOptions(raw);
}

const USAGE = '用法：node scripts/local-model.mjs status|start|stop|restart|apply [--json] [--model X] [--context 8k|16k|32k] [--vision cpu|off] [--port N] [--data-dir DIR] [--action enable|disable|switch-dsh]';

export async function lmMain(argv, io = {}) {
  const log = io.log || ((line) => console.log(line));
  const errorLog = io.error || ((line) => console.error(line));
  const parsed = lmParseArgs(argv);
  if (parsed.command === 'help' || parsed.command === '--help' || parsed.help) { log(USAGE); return 0; }
  const say = parsed.json ? () => {} : log;
  const emit = (payload) => { if (parsed.json) process.stdout.write(JSON.stringify(payload) + '\n'); };

  if (parsed.command === 'status') {
    const cfg = lmReadConfig();
    const applied = lmAppliedFromConfig(cfg);
    const health = await lmProbeEngine(applied.port);
    const bridgePids = lmBridgePids();
    const token = lmBridgeToken();
    let bridgeOk = false;
    try {
      const res = await fetch(`${BRIDGE}/api/status`, { headers: token ? { 'x-console-token': token } : {} });
      bridgeOk = res.ok;
    } catch { /* bridge 没起 */ }
    const probe = await lmProbeAgent({ token });
    const payload = lmStatusPayload({ cfg, applied, health, probe, strataPids: lmStrataPids(), bridgePids, bridgeOk, state: lmReadState() });
    if (parsed.json) { emit(payload); return 0; }
    say('本地模型（Strata）');
    say(`  引擎进程：${payload.engine.pid ? `运行中 pid ${payload.engine.pid}` : '未运行'}`);
    say(`  引擎接口：${payload.engine.online ? `在线（${payload.engine.model}，上下文 ${payload.engine.context}）` : `离线（${payload.engine.error}）`}`);
    say('桥接');
    say(`  进程：${payload.bridge.pid ? `运行中 pid ${payload.bridge.pid}` : '未运行'} ｜ 控制台：${payload.bridge.running ? '可访问' : '不可访问'}`);
    say(`  当前后端：${payload.bridge.agentType}${payload.bridge.model ? ` / ${payload.bridge.model}` : ''}${payload.bridge.baseUrl ? ` @ ${payload.bridge.baseUrl}` : ''}`);
    say(`  探活：${payload.probe.ok ? `✓ ${payload.probe.detail}` : `✗ ${payload.probe.detail || '失败'}`}`);
    const ready = payload.engine.online && payload.bridge.running && payload.bridge.agentType === 'openai';
    say(ready ? '\n结论：本地模型已接管聊天。' : '\n结论：本地模型未接管（apply --action enable 可一键接管）。');
    return ready ? 0 : 1;
  }

  if (parsed.command === 'start') {
    const cfg = lmReadConfig();
    const resolved = lmOptionsFromArgs(parsed.flags, cfg);
    if (!resolved.ok) { errorLog(resolved.error); return 2; }
    const options = resolved.options;
    const health = await lmProbeEngine(options.port);
    let pid = null;
    let already = health.ok;
    if (!health.ok) {
      say('启动引擎：strata ' + lmBuildLaunchArgs(options).join(' '));
      pid = lmStartEngine(spawn, options);
      lmWriteState({ pid, port: options.port, model: options.model, context: options.context, startedAt: Date.now() });
    }
    const fallbackPid = pid ?? (Number(lmReadState()?.pid) || null);
    if (parsed.json) { emit({ ok: true, started: !already, already, pid: fallbackPid, port: options.port, model: lmModelId(options) }); return 0; }
    if (!already) {
      const ready = await lmWaitEngineReady(options.port, 12 * 60 * 1000, (label) => say(`  等待引擎就绪…（${label}）`));
      if (!ready.ok) { errorLog(`引擎没起来：${ready.error}`); return 1; }
      say(`引擎就绪：${ready.model}（上下文 ${ready.context ?? options.context}）`);
    }
    const apply = lmApplyToConfig(cfg, 'enable', options);
    lmWriteConfig(apply.next);
    say('重启桥接…');
    lmRestartBridge();
    const up = await lmWaitBridgeReady();
    if (!up) { errorLog('桥接没有在 25 秒内起来，请看 state/bridge.out'); return 1; }
    say('已切到本地模型后端，桥接在线。');
    return 0;
  }

  if (parsed.command === 'stop') {
    const result = await lmStopEngine();
    const cfg = lmReadConfig();
    const options = lmAppliedFromConfig(cfg);
    const apply = lmApplyToConfig(cfg, 'disable', options);
    lmWriteConfig(apply.next);
    if (parsed.json) { emit({ ok: true, stopped: true, pids: result.pids, agent: apply.agent }); return 0; }
    say(result.stopped ? `已停止引擎（pid ${result.pids.join(',')}）。` : '引擎本来就没在跑。');
    say('重启桥接…');
    lmRestartBridge();
    const up = await lmWaitBridgeReady();
    say(up ? '已切回 DSH 后端，桥接在线。' : '桥接没有起来，请看 state/bridge.out');
    return up ? 0 : 1;
  }

  if (parsed.command === 'restart') {
    await lmMain(['stop', ...(parsed.json ? ['--json'] : [])], io);
    const code = await lmMain(['start', ...(parsed.json ? ['--json'] : [])], io);
    return code;
  }

  if (parsed.command === 'apply') {
    const cfg = lmReadConfig();
    const resolved = lmOptionsFromArgs(parsed.flags, cfg);
    if (!resolved.ok) { errorLog(resolved.error); return 2; }
    const options = resolved.options;
    const action = String(parsed.flags.action || 'enable').toLowerCase();
    if (!['enable', 'disable', 'switch-dsh'].includes(action)) { errorLog(`不认识的 action：${action}（可选：enable / disable / switch-dsh）`); return 2; }
    const apply = lmApplyToConfig(cfg, action, options);
    if (!apply.ok) { errorLog(apply.error); return 2; }
    lmWriteConfig(apply.next);
    let started = false;
    let pid = null;
    let stopped = null;
    if (action === 'enable') {
      const health = await lmProbeEngine(options.port);
      if (!health.ok) {
        pid = lmStartEngine(spawn, options);
        if (!pid) { errorLog('启动引擎失败：找不到可执行的 strata（可设置环境变量 STRATA_BIN）'); return 3; }
        started = true;
        lmWriteState({ pid, port: options.port, model: options.model, context: options.context, startedAt: Date.now() });
      } else {
        pid = Number(lmReadState()?.pid) || null;
      }
    } else {
      stopped = await lmStopEngine();
    }
    const payload = { ok: true, action: apply.action, applied: apply.applied, agent: apply.agent, started, stopped: Boolean(stopped?.stopped), pid, restartRequired: true };
    if (parsed.json) { emit(payload); return 0; }
    say(`已写入 config.json 的 localModel 段（${apply.applied.model} / ${apply.applied.context} / vision ${apply.applied.vision} / 端口 ${apply.applied.port}）。`);
    say(action === 'enable' ? (started ? '引擎已启动（正在加载，稍候即可就绪）。' : '引擎已在线。') : '引擎已停止。');
    say('后端需要重启桥接后才生效：控制台里点「应用并重启」，或运行 node scripts/local-model.mjs start。');
    return 0;
  }

  errorLog(USAGE);
  return 2;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly || process.env.LOCAL_MODEL_FORCE_RUN === '1') {
  process.exitCode = await lmMain(process.argv.slice(2));
}

