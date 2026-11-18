// 本地模型（控制台一等公民）的离线测试：不真起引擎、不真杀桥接。
//
// 两层：
// - scripts/local-model.mjs 的纯函数（参数归一化 / 引擎命令拼装 / config 段落读写 / 状态聚合）；
// - src/bridge/console/local-model.js 的 HTTP 层（假 spawn 喂 JSON，断言：status 永远 200、
//   apply 非法参数 400、agent 令牌 403、restart-bridge 只写脚本 + detached 拉起、绝不真重启）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = await import(pathToFileURL(path.join(ROOT, 'scripts/local-model.mjs')).href);
const { createConsoleLocalModel, lmlParseCliJson, lmlBuildApplyArgs, lmlPendingRestart, lmlRestartScript } =
  await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/local-model.js')).href);

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const header = (title) => console.log(`## ${title}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-model-'));
const stateDir = path.join(tmp, 'state');
fs.mkdirSync(stateDir, { recursive: true });

// ── 假子进程：node 脚本调用喂 stdout；powershell 调用只记录命令 ──
function fakeChild({ stdout = '', code = 0, stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.kill = () => {};
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('close', code);
  });
  return child;
}
function mkSpawn(queue) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const next = queue.shift() || {};
    if (command === 'powershell') { const child = fakeChild({ stdout: '', code: 0 }); return child; }
    return fakeChild(next);
  };
  spawnImpl.calls = calls;
  return spawnImpl;
}

// ── HTTP 夹具 ──
function mkReq({ method = 'GET', headers = {}, body = {}, pathname = '/api/local-model/status' } = {}) {
  const r = {
    req: { method, headers },
    url: new URL('http://127.0.0.1:3100' + pathname),
    res: {},
    body,
    async readBody() { if (body instanceof Error) throw body; return body; },
    sent: null,
    sendJson(payload, status = 200) { r.sent = { payload, status }; }
  };
  return r;
}
async function call(api, opts = {}) {
  const r = mkReq(opts);
  const result = opts.handler === 'restart'
    ? await api.handleConsoleLocalModelRestart(r)
    : await api.handleConsoleLocalModel(r);
  return { handled: result, status: r.sent ? r.sent.status : 0, payload: r.sent ? r.sent.payload : null };
}
function mkApi({ queue = [], cfg = { agent: { type: 'dsh', baseUrl: '', model: '' } }, spawn } = {}) {
  const spawnImpl = spawn || mkSpawn(queue);
  const api = createConsoleLocalModel({
    ROOT: tmp, STATE_DIR: stateDir, cfg, fs, path,
    spawn: spawnImpl, log: () => {},
    setTimeout, clearTimeout
  });
  return { api, spawn: spawnImpl };
}

try {
  header('CLI 纯函数：参数归一化');
  {
    const defaults = cli.lmDefaults();
    check('默认值五个字段齐全', defaults.model === 'UD-Q4_K_XL' && defaults.context === '8k' && defaults.vision === 'cpu' && defaults.port === 8080 && !!defaults.dataDir);
    const ok = cli.lmNormalizeOptions({});
    check('空对象 → 用默认值', ok.ok === true && ok.options.model === 'UD-Q4_K_XL' && ok.options.context === '8k');
    const upper = cli.lmNormalizeOptions({ model: 'q8_0', context: '32K' });
    check('模型/上下文大小写不敏感', upper.ok && upper.options.model === 'Q8_0' && upper.options.context === '32k');
    check('非法模型给中文原因', cli.lmNormalizeOptions({ model: 'nope' }).ok === false && /不认识的模型档位/.test(cli.lmNormalizeOptions({ model: 'nope' }).error));
    check('非法上下文给中文原因', cli.lmNormalizeOptions({ context: '64k' }).ok === false && /上下文/.test(cli.lmNormalizeOptions({ context: '64k' }).error));
    check('非法视觉模式给中文原因', cli.lmNormalizeOptions({ vision: 'gpu' }).ok === false && /视觉/.test(cli.lmNormalizeOptions({ vision: 'gpu' }).error));
    check('端口非数字 → 报错', cli.lmNormalizeOptions({ port: 'abc' }).ok === false && /端口不合法/.test(cli.lmNormalizeOptions({ port: 'abc' }).error));
    check('端口越界 → 报错', cli.lmNormalizeOptions({ port: 70000 }).ok === false);
    check('相对 dataDir → 报错', cli.lmNormalizeOptions({ dataDir: 'models/x' }).ok === false && /绝对路径/.test(cli.lmNormalizeOptions({ dataDir: 'models/x' }).error));
    const custom = cli.lmNormalizeOptions({ port: 8090, dataDir: 'D:/models/strata' });
    check('自定义端口/目录合法', custom.ok && custom.options.port === 8090 && custom.options.dataDir === 'D:/models/strata');
  }

  header('CLI 纯函数：模型文件 / 引擎命令');
  {
    const options = cli.lmNormalizeOptions({ model: 'UD-Q6_K_XL' }).options;
    const file = cli.lmModelFile(options);
    check('gguf 路径含档位目录与文件名', file.includes('/qwen36/Qwen3.6-35B-A3B-UD-Q6_K_XL/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf'), file);
    check('modelId 是 gguf 主名小写', cli.lmModelId(options) === 'qwen3.6-35b-a3b-ud-q6_k_xl', cli.lmModelId(options));
    const args = cli.lmBuildLaunchArgs(options);
    check('launch 参数含 family/model/context/vision/port/data-dir', args.includes('--family') && args.includes('qwen36') && args.includes('UD-Q6_K_XL') && args.includes('--context') && args.includes('8k') && args.includes('--port') && args.includes('--data-dir'));
    check('launch 参数含 kv/parallel/mtp/engine_ready_s/restart', args.includes('q4_0') && args.includes('engine_ready_s=2400') && args.includes('--restart') && args.includes('--vision'));
  }

  header('CLI 纯函数：agent 段落切换');
  {
    const options = cli.lmNormalizeOptions({ model: 'Q8_0', port: 8081 }).options;
    const local = cli.lmAgentForLocal({ type: 'dsh', timeoutMs: 300000, tools: ['qq_status'], extraBody: { a: 1 } }, options);
    check('切本地：type=openai + baseUrl 带端口', local.type === 'openai' && local.baseUrl === 'http://127.0.0.1:8081/v1');
    check('切本地：model=modelId', local.model === 'qwen3.6-35b-a3b-q8_0');
    check('切本地：保留 tools/timeoutMs', JSON.stringify(local.tools) === '["qq_status"]' && local.timeoutMs === 300000);
    check('切本地：关思考且保留 extraBody 其它键', local.extraBody.chat_template_kwargs.enable_thinking === false && local.extraBody.a === 1);
    const dsh = cli.lmAgentForDsh(local);
    check('切回 dsh：type/baseUrl/model 复位', dsh.type === 'dsh' && dsh.baseUrl === '' && dsh.model === '');
    const cfg = { agent: { type: 'dsh' }, other: 1 };
    const enabled = cli.lmApplyToConfig(cfg, 'enable', options);
    check('apply enable：写 localModel 段', enabled.ok && enabled.next.localModel.model === 'Q8_0' && enabled.next.localModel.port === 8081);
    check('apply enable：agent 切到 openai', enabled.next.agent.type === 'openai');
    check('apply enable：不动其它顶层键', enabled.next.other === 1);
    const disabled = cli.lmApplyToConfig(enabled.next, 'disable', options);
    check('apply disable：agent 回 dsh 但保留 localModel 记忆', disabled.ok && disabled.next.agent.type === 'dsh' && disabled.next.localModel.model === 'Q8_0');
    const switched = cli.lmApplyToConfig(cfg, 'switch-dsh', options);
    check('switch-dsh 与 disable 同效', switched.ok && switched.next.agent.type === 'dsh');
  }

  header('CLI 纯函数：config 读写与宽松读回');
  {
    const file = path.join(tmp, 'config.json');
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ agent: { type: 'openai' }, localModel: { model: 'Q8_0', context: '8k', vision: 'off', port: 8090, dataDir: 'D:/m' } }), 'utf8');
    const cfg = cli.lmReadConfig(file);
    check('读 config 兼容 BOM', cfg.agent.type === 'openai');
    cli.lmWriteConfig({ ...cfg, extra: 2 }, file);
    const reread = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('写 config 落盘且保留原字段', reread.extra === 2 && reread.localModel.model === 'Q8_0');
    const applied = cli.lmAppliedFromConfig({ localModel: { model: 'BROKEN', context: '99k', port: -1 } });
    check('localModel 写坏时兜底默认值', applied.model === 'UD-Q4_K_XL' && applied.context === '8k' && applied.port === 8080);
    check('没有 localModel 段 → 全默认', cli.lmAppliedFromConfig({}).model === 'UD-Q4_K_XL');
  }

  header('CLI 纯函数：参数解析与状态聚合');
  {
    const parsed = cli.lmParseArgs(['apply', '--json', '--model', 'Q8_0', '--port', '8090', '--action', 'enable']);
    check('解析命令与 --json', parsed.command === 'apply' && parsed.json === true);
    check('解析带值参数', parsed.flags.model === 'Q8_0' && parsed.flags.port === '8090' && parsed.flags.action === 'enable');
    const cfg = { localModel: { model: 'UD-Q6_K_XL', context: '16k', vision: 'cpu', port: 8080, dataDir: 'E:/models/strata/data' } };
    const fromFlags = cli.lmOptionsFromArgs({ model: 'Q8_0' }, cfg);
    check('flags 覆盖 config.localModel', fromFlags.ok && fromFlags.options.model === 'Q8_0' && fromFlags.options.context === '16k');
    const offline = cli.lmStatusPayload({ cfg, health: { ok: false, error: '连不上' }, probe: { ok: false, latencyMs: 1, detail: 'x' }, strataPids: [], bridgePids: [999], bridgeOk: true });
    check('离线状态：ok 仍为 true 且 online=false', offline.ok === true && offline.engine.online === false && offline.engine.error === '连不上');
    check('离线状态：sizes/contexts/visionModes/ports 齐全', offline.sizes.length === 3 && offline.contexts.length === 3 && offline.visionModes.length === 2 && offline.ports.length >= 1);
    const online = cli.lmStatusPayload({ cfg, health: { ok: true, model: 'qwen3.6-35b-a3b-ud-q6_k_xl', context: 16384 }, probe: { ok: true, latencyMs: 5, detail: 'ok' }, strataPids: [123], bridgePids: [456], bridgeOk: true });
    check('在线状态：engine.model 用引擎回报值', online.engine.online === true && online.engine.model === 'qwen3.6-35b-a3b-ud-q6_k_xl' && online.engine.pid === 123);
    check('状态里 bridge 用 config.agent', online.bridge.agentType === 'dsh');
  }

  header('模块纯函数');
  {
    check('lmlParseCliJson 容忍 BOM 与前后噪音', lmlParseCliJson('\uFEFF[log] x\n{"ok":true}\n').ok === true);
    check('lmlParseCliJson 空/坏 JSON 返回 null', lmlParseCliJson('') === null && lmlParseCliJson('not json') === null);
    const args = lmlBuildApplyArgs({ action: 'enable', model: 'Q8_0', port: 8090 });
    check('apply 参数只带给了的字段', args.includes('--model') && args.includes('Q8_0') && args.includes('--port') && !args.includes('--vision'));
    check('pendingRestart：type 不同 → true', lmlPendingRestart({ type: 'dsh' }, { type: 'openai' }) === true);
    check('pendingRestart：三项一致 → false', lmlPendingRestart({ type: 'openai', baseUrl: 'u', model: 'm' }, { type: 'openai', baseUrl: 'u', model: 'm' }) === false);
    check('pendingRestart：model 不同 → true', lmlPendingRestart({ type: 'openai', model: 'a' }, { type: 'openai', model: 'b' }) === true);
    const script = lmlRestartScript('E:/x y/bridge', 'C:/Program Files/nodejs/node.exe', 4321);
    check('重启脚本按 PID 精确停旧进程（不再依赖 CommandLine 匹配）', script.includes('Stop-Process -Id 4321') && !script.includes('CommandLine'));
    check('重启脚本用绝对 node 路径 + 工作目录拉起', script.includes("Start-Process -FilePath 'C:/Program Files/nodejs/node.exe'") && script.includes("'E:/x y/bridge'"));
    check('重启脚本先 sleep 再杀（让响应先发出）', script.indexOf('Start-Sleep') < script.indexOf('Stop-Process'));
    check('重启脚本失败不再被清空（ErrorActionPreference=Continue）', script.includes('$ErrorActionPreference = "Continue"'));
  }

  header('引擎启停：start 不阻塞、stop 不误杀');
  {
    const options = cli.lmNormalizeOptions({ model: 'Q8_0', context: '8k', port: 8090 }).options;
    const spawnCalls = [];
    const fakeSpawn = (command, args, opts) => { spawnCalls.push({ command, args, opts }); return { pid: 4242, unref() {} }; };
    const noStray = () => '';
    const pid = cli.lmStartEngine(fakeSpawn, options, noStray);
    check('start 立即返回 pid（不等就绪）', pid === 4242);
    check('start detached 拉起 strata launch', spawnCalls[0].command === 'powershell.exe' && spawnCalls[0].opts.detached === true && /Start-Process/.test(spawnCalls[0].args.join(' ')) && /launch/.test(spawnCalls[0].args.join(' ')));
    check('start 参数与档位一致', spawnCalls[0].args.join(' ').includes('Q8_0') && spawnCalls[0].args.join(' ').includes('8090'));
    const stopped = await cli.lmStopEngine({ exec: noStray });
    check('没有 strata 进程时 stop 不杀任何东西', stopped.stopped === false && Array.isArray(stopped.pids) && stopped.pids.length === 0);
  }

  header('HTTP status：脚本 JSON 正常');
  {
    const statusJson = JSON.stringify({
      ok: true,
      engine: { online: true, pid: 4321, port: 8080, model: 'qwen3.6-35b-a3b-ud-q4_k_xl', modelFile: 'E:/m/qwen36/x/y.gguf', context: '16k' },
      bridge: { agentType: 'dsh', baseUrl: '', model: '', running: true, pid: 777 },
      applied: { model: 'UD-Q4_K_XL', context: '16k', vision: 'cpu', port: 8080, dataDir: 'E:/m' },
      defaults: { model: 'UD-Q4_K_XL' }, sizes: ['UD-Q4_K_XL'], contexts: ['16k'], visionModes: ['cpu'], ports: [8080],
      probe: { ok: false, latencyMs: 3, detail: '连不上' }
    });
    const { api, spawn } = mkApi({ queue: [{ stdout: statusJson, code: 0 }] });
    const r = await call(api);
    check('status 200 且 handled', r.handled === true && r.status === 200);
    check('engine.online 透传', r.payload.ok === true && r.payload.engine.online === true && r.payload.engine.model === 'qwen3.6-35b-a3b-ud-q4_k_xl');
    check('options.sizes/contexts/visionModes/ports 齐全', r.payload.options.sizes.length === 3 && r.payload.options.contexts.length === 3 && r.payload.options.visionModes.length === 2);
    check('pendingRestart：config 文件仍是 dsh 而装配是 dsh → false', r.payload.bridge.pendingRestart === false);
    check('probe 透传', r.payload.probe.ok === false && r.payload.probe.detail === '连不上');
    check('spawn 调的是 local-model.mjs status --json', spawn.calls[0].args.some((a) => String(a).endsWith('local-model.mjs')) && spawn.calls[0].args.includes('status') && spawn.calls[0].args.includes('--json'));
    check('bridge.running 透传', r.payload.bridge.running === true && r.payload.bridge.pid === 777);
  }

  header('HTTP status：脚本坏了也不 500');
  {
    const { api } = mkApi({ queue: [{ stdout: '', code: 1, stderr: 'boom' }] });
    const r = await call(api);
    check('脚本失败 → 仍 200 且 ok=true', r.status === 200 && r.payload.ok === true);
    check('脚本失败 → online=false 并带原因', r.payload.engine.online === false && /状态脚本失败/.test(r.payload.engine.error));
    const noSpawn = mkApi({ queue: [] });
    noSpawn.api.handleConsoleLocalModel.toString();
    const apiNoSpawn = createConsoleLocalModel({ ROOT: tmp, STATE_DIR: stateDir, cfg: { agent: { type: 'dsh' } }, fs, path, spawn: null, log: () => {}, setTimeout, clearTimeout });
    const r2 = await call(apiNoSpawn);
    check('spawn 不可用 → 200 兜底（不 500）', r2.status === 200 && r2.payload.ok === true && r2.payload.engine.online === false);
  }

  header('HTTP apply：校验 / 成功 / CLI 报错');
  {
    const { api, spawn } = mkApi({ queue: [] });
    const badAction = await call(api, { method: 'POST', pathname: '/api/local-model/apply', body: { action: 'nuke' } });
    check('非法 action → 400 中文', badAction.status === 400 && /不认识的 action/.test(badAction.payload.error));
    check('非法 action 不 spawn 脚本', spawn.calls.length === 0);
    const agentForbidden = await call(api, { method: 'POST', pathname: '/api/local-model/apply', headers: { 'x-agent-token': 'abc' }, body: { action: 'enable' } });
    check('agent 令牌 → 403', agentForbidden.status === 403);
    const applyJson = JSON.stringify({ ok: true, action: 'enable', applied: { model: 'Q8_0', context: '8k', vision: 'cpu', port: 8080, dataDir: 'E:/m' }, agent: { type: 'openai' }, started: true, pid: 555, restartRequired: true });
    const okApi = mkApi({ queue: [{ stdout: applyJson, code: 0 }] });
    const applied = await call(okApi.api, { method: 'POST', pathname: '/api/local-model/apply', body: { action: 'enable', model: 'Q8_0', context: '8k' } });
    check('apply 成功 → 200 + restartRequired:true', applied.status === 200 && applied.payload.ok === true && applied.payload.restartRequired === true);
    check('apply 把 model/context 传给脚本', okApi.spawn.calls[0].args.includes('--model') && okApi.spawn.calls[0].args.includes('Q8_0') && okApi.spawn.calls[0].args.includes('--context'));
    check('apply 带 --action enable', okApi.spawn.calls[0].args.includes('--action') && okApi.spawn.calls[0].args.includes('enable'));
    const failApi = mkApi({ queue: [{ stdout: JSON.stringify({ ok: false, error: '端口不合法：x（应为 1~65535 的整数）' }), code: 2 }] });
    const rejected = await call(failApi.api, { method: 'POST', pathname: '/api/local-model/apply', body: { action: 'enable', port: 'x' } });
    check('脚本参数错 → 400 透传中文原因', rejected.status === 400 && /端口不合法/.test(rejected.payload.error));
    const badBody = await call(api, { method: 'POST', pathname: '/api/local-model/apply', body: new Error('bad json') });
    check('坏 JSON body → 400', badBody.status === 400);
  }

  header('HTTP restart-bridge：只写脚本 + detached 拉起');
  {
    const { api, spawn } = mkApi({ queue: [] });
    const r = await call(api, { method: 'POST', pathname: '/api/local-model/restart-bridge', handler: 'restart' });
    check('返回 {ok:true,restarting:true}', r.status === 200 && r.payload.ok === true && r.payload.restarting === true);
    const callArgs = spawn.calls.find((c) => c.command === 'powershell');
    check('powershell 以 -File 执行一次性脚本', !!callArgs && callArgs.args.includes('-File') && callArgs.args.some((a) => String(a).endsWith('local-model-restart.ps1')));
    check('detached + windowsHide', !!callArgs && callArgs.options.detached === true && callArgs.options.windowsHide === true);
    const scriptFile = path.join(stateDir, 'local-model-restart.ps1');
    const text = fs.existsSync(scriptFile) ? fs.readFileSync(scriptFile, 'utf8') : '';
    check('脚本已落盘且含杀 bridge.js + 重新拉起', /bridge\\?\.js/.test(text) && text.includes('Start-Process') && text.includes('Stop-Process'));
    const forbidden = await call(api, { method: 'POST', pathname: '/api/local-model/restart-bridge', handler: 'restart', headers: { 'x-agent-call': '1' } });
    check('restart-bridge 带 agent 头 → 403', forbidden.status === 403);
    const wrongMethod = await call(api, { method: 'GET', pathname: '/api/local-model/restart-bridge', handler: 'restart' });
    check('restart-bridge 非 POST → 405', wrongMethod.status === 405);
  }
} catch (error) {
  failures.push('uncaught');
  console.log(`  ✗ 未捕获异常：${error && error.stack ? error.stack : error}`);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清理尽力而为 */ }
}

const total = pass + failures.length;
console.log(`\n========== 通过 ${pass} / 失败 ${failures.length}（共 ${total}） ==========`);
if (failures.length) { console.log('失败项：' + failures.join('、')); process.exitCode = 1; }
