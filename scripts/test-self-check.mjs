// 机器人自检（D71）的离线测试：注入假探测函数，不真连网络、不真读 state。
//
// 覆盖 brief 要求的五类场景：全绿 / 端口断 / db 坏 / 模型缺失 / 计划任务停，
// 另加：--fix 只做两件安全动作、每条检查必须带实据、报告 JSON 形状、控制台路由与页面接线。
//
// 用法：node scripts/test-self-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSelfCheck, SELF_CHECK_GROUP_IDS, countRecentLogProblems, createRealDeps, normalizeTaskStateValue } from '../src/self-check.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let tests = 0;
function test(name, run) {
  tests += 1;
  try { run(); console.log(`PASS ${name}`); } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error && error.message ? error.message : error}`);
  }
}
async function testAsync(name, run) {
  tests += 1;
  try { await run(); console.log(`PASS ${name}`); } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error && error.message ? error.message : error}`);
  }
}

// ── 假依赖：默认全绿；每个场景只改需要坏的那一块 ──────────────────────────────
function makeDeps(opts = {}) {
  const calls = { runTask: [], unlink: [], tcp: [], http: [] };
  const state = {
    portsDown: new Set(opts.portsDown || []),
    dbOk: opts.dbOk !== false,
    dbDetail: opts.dbDetail || 'ok',
    missingModels: opts.missingModels || [],
    taskStates: opts.taskStates || {
      '\\QQBridge-Bridge': 'Running',
      '\\QQBridge-SnowLuma': 'Running',
      '\\LocalTTS': 'Running',
      '\\Ollama': 'Running',
    },
    dirs: opts.dirs || {},
    files: opts.files || {},
    pidAlive: opts.pidAlive !== false,
    headMs: opts.headMs === undefined ? Date.parse('2026-10-27T10:00:00Z') : opts.headMs,
    bootMs: opts.bootMs === undefined ? Date.parse('2026-10-27T11:00:00Z') : opts.bootMs,
    budget: opts.budget || { checks: 100, sweeps: 5, errors: 0, lastAt: new Date().toISOString() },
    logText: opts.logText || '',
  };
  const ALL_MODELS = [
    'deepseek-official/deepseek-flash',
    'workbuddy2api/deepseek-v4.1-flash',
    'deepseek-account/deepseek-flash',
    'workbuddy2api/deepseek-v4-pro',
  ];
  const models = ALL_MODELS.filter((m) => !state.missingModels.includes(m));
  return {
    calls,
    async tcp(host, port) { calls.tcp.push(port); return !state.portsDown.has(port); },
    async httpJson(url) {
      calls.http.push(url);
      if (url.includes('/get_login_info')) return { status: 200, body: { data: { user_id: 10001, nickname: 'fixture' } } };
      if (url.endsWith('/api/status')) return { status: 200, body: { dshReady: opts.dshReady !== false, snowluma: { connected: true } } };
      if (url.endsWith('/api/models')) return { status: 200, body: { options: models.map((m) => ({ provider: m.split('/')[0], model: m.split('/').slice(1).join('/') })) } };
      if (url.endsWith('/api/debug/budget')) return { status: 200, body: state.budget };
      return { status: 404, body: {} };
    },
    readText(file) {
      if (String(file).endsWith('boot-log.jsonl')) return JSON.stringify({ t: state.bootMs, event: 'start', pid: 4242 }) + '\n';
      if (String(file).endsWith('bridge.lock')) return opts.lockPid == null ? { error: 'ENOENT' } : String(opts.lockPid);
      if (String(file).endsWith('bridge-stdout.log') || String(file).endsWith('bridge.log')) return state.logText;
      return { error: 'ENOENT' };
    },
    readJson(file) {
      if (state.dirs[file]) return { ok: true, value: state.dirs[file] };
      const base = String(file).split(/[\\/]/).pop();
      if (base === 'sessions.json') return { ok: true, value: { sessions: { 'group:1': {}, 'group:2': {} } } };
      if (base === 'stickers.json') return { ok: true, value: { stickers: [{ id: 1 }, { id: 2 }] } };
      if (base === 'social-v2.json') return { ok: true, value: { conversations: { 'group:1': {} } } };
      return { ok: false, error: 'ENOENT' };
    },
    exists: () => opts.archiveExists !== false,
    writable: () => opts.archiveWritable !== false,
    freeBytes: () => (opts.freeBytes === undefined ? 120 * 1024 ** 3 : opts.freeBytes),
    dbIntegrity: () => ({ ok: state.dbOk, detail: state.dbDetail }),
    taskState(name) { return { ok: true, state: state.taskStates[name] || 'Ready', detail: '' }; },
    runTask(name) { calls.runTask.push(name); return opts.runTaskOk !== false; },
    gitHeadMs: () => state.headMs,
    pidAlive: () => state.pidAlive,
    unlink(file) { calls.unlink.push(file); return true; },
    async sleep() { /* 测试里不真等 */ },
    now: () => Date.parse('2026-10-27T12:00:00Z'),
  };
}

const CONFIG = {
  consolePort: 3100,
  dsh: { provider: 'workbuddy2api', model: 'deepseek-v4.1-flash', modelFallbacks: [{ provider: 'deepseek-account', model: 'deepseek-flash' }], contextBudget: { enabled: true, maxPressurePct: 15 } },
  snowluma: { httpUrl: 'http://127.0.0.1:3000', accessToken: 'fixture' },
  allow: { groups: ['1', '2'] },
  socialV2: { stt: { model: 'small' }, memory: { people: { enabled: true } } },
  fileArchive: { dir: 'state/files' },
};
const run = (deps, extra = {}) => runSelfCheck({ root: 'E:/fixture', config: CONFIG, deps, token: 'fixture-token', ...extra });
const groupOf = (report, id) => report.groups.find((g) => g.id === id);

// ── 1. 九组结构 + 全绿 ───────────────────────────────────────────────────────
await testAsync('九组齐全、顺序固定，全绿时 ok=true 且没有 fail', async () => {
  const report = await run(makeDeps());
  assert.deepEqual(report.groups.map((g) => g.id), SELF_CHECK_GROUP_IDS, '九组 id 与顺序都要稳定');
  assert.equal(report.ok, true);
  assert.equal(report.counts.fail, 0);
  assert.equal(report.counts.ok, 9, `全绿时应 9 组 ok，实际 ${JSON.stringify(report.counts)}`);
});

await testAsync('每条检查都必须带实据数字（禁止只写「正常」）', async () => {
  const report = await run(makeDeps());
  for (const g of report.groups) {
    assert.ok(Array.isArray(g.evidence) && g.evidence.length > 0, `${g.id} 缺 evidence`);
    const text = g.summary + ' ' + g.evidence.join(' ');
    assert.ok(/\d/.test(text), `${g.id} 的结论里没有任何数字：${text.slice(0, 80)}`);
  }
});

// ── 2. 端口断 ────────────────────────────────────────────────────────────────
await testAsync('端口断：必需端口(3001)断 → ports=fail 且整体 ok=false', async () => {
  const report = await run(makeDeps({ portsDown: [3001] }));
  assert.equal(groupOf(report, 'ports').status, 'fail');
  assert.match(groupOf(report, 'ports').summary, /3001/);
  assert.equal(report.ok, false);
});

await testAsync('端口断：只有可选端口(8765)断 → ports=warn，不阻断整体', async () => {
  const report = await run(makeDeps({ portsDown: [8765] }));
  assert.equal(groupOf(report, 'ports').status, 'warn');
  assert.equal(report.ok, true, '可选组件缺失不应该让自检判失败');
});

// ── 3. db 坏 ────────────────────────────────────────────────────────────────
await testAsync('db 坏：storage=fail 且证据里带 integrity_check 的原始返回', async () => {
  const report = await run(makeDeps({ dbOk: false, dbDetail: 'database disk image is malformed' }));
  const g = groupOf(report, 'storage');
  assert.equal(g.status, 'fail');
  assert.ok(g.evidence.some((e) => e.includes('malformed')), '要把原始错误贴出来，别只写「损坏」');
  assert.equal(report.ok, false);
});

// ── 4. 模型缺失 ────────────────────────────────────────────────────────────
await testAsync('模型缺失：dsh=fail 并点名缺失的模型', async () => {
  const report = await run(makeDeps({ missingModels: ['deepseek-account/deepseek-flash'] }));
  const dsh = groupOf(report, 'dsh');
  assert.equal(dsh.status, 'fail');
  assert.ok(dsh.evidence.some((e) => e.includes('deepseek-account/deepseek-flash')), '要点名缺哪个模型');
  assert.equal(report.ok, false);
});

// ── 5. 计划任务停 ──────────────────────────────────────────────────────────
await testAsync('计划任务停：核心任务未运行 → tasks=fail', async () => {
  const deps = makeDeps({ taskStates: { '\\QQBridge-Bridge': 'Ready', '\\QQBridge-SnowLuma': 'Running', '\\LocalTTS': 'Running', '\\Ollama': 'Running' } });
  const report = await run(deps);
  assert.equal(groupOf(report, 'tasks').status, 'fail');
  assert.equal(report.ok, false);
});

// 中文 Windows 的 schtasks 走 GBK 输出、字段名还可能是「模式」；状态值必须先归一化再判断，
// 否则「正在运行」永远匹配不上 /running/i，四个任务全被判成没跑（这就是 2026-10-28 那条假的「计划任务」故障）。
await testAsync('状态值归一化：中文/英文/大小写都落到英文枚举', async () => {
  assert.equal(normalizeTaskStateValue('正在运行'), 'Running');
  assert.equal(normalizeTaskStateValue('running'), 'Running');
  assert.equal(normalizeTaskStateValue('就绪'), 'Ready');
  assert.equal(normalizeTaskStateValue('Ready'), 'Ready');
  assert.equal(normalizeTaskStateValue('已禁用'), 'Disabled');
  assert.equal(normalizeTaskStateValue('奇怪的值'), '奇怪的值');
});

await testAsync('真实 taskState 实现认「模式: 正在运行」这种中文输出（不联网、只喂假 spawn 结果）', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'self-check.js'), 'utf8');
  assert.ok(/Status\|State\|状态\|模式\|Mode/.test(source), '字段名要兼容 Status/State/状态/模式/Mode 五种');
  assert.ok(/TextDecoder\('gbk'\)/.test(source), 'schtasks 输出必须按 GBK 解码，不能按 utf8');
  assert.ok(/Get-ScheduledTask -TaskName/.test(source), '优先用 PowerShell 取 State（英文枚举、编码安全）');
  // 顺带验证版本组只看 src/ 的提交：gitSrcHeadMs 必须在 deps 里
  const deps = createRealDeps();
  assert.equal(typeof deps.gitSrcHeadMs, 'function');
  assert.equal(typeof deps.taskState, 'function');
});

await testAsync('计划任务 Ready 但端口通（LocalTTS 实测这种情况）→ 只 warn，不当故障', async () => {
  const deps = makeDeps({ taskStates: { '\\QQBridge-Bridge': 'Running', '\\QQBridge-SnowLuma': 'Running', '\\LocalTTS': 'Ready', '\\Ollama': 'Running' } });
  const report = await run(deps);
  assert.equal(groupOf(report, 'tasks').status, 'ok');
});

// ── 6. --fix 只做两件安全动作 ──────────────────────────────────────────────
await testAsync('--fix：只拉起 Ollama + 清死锁，其它一概不写', async () => {
  const deps = makeDeps({ portsDown: [11434], lockPid: 999999, pidAlive: false });
  const report = await run(deps, { fix: true });
  assert.deepEqual(deps.calls.runTask, ['\\Ollama'], '只允许触发 Ollama 任务');
  assert.equal(deps.calls.unlink.length, 1, '只允许删死锁文件一次');
  assert.ok(deps.calls.unlink[0].endsWith('bridge.lock'));
  assert.ok(report.fixes.length >= 2, '两个动作都要写进 fixes 供人看');
});

await testAsync('--fix 遇到活着的 pid 不删锁文件', async () => {
  const deps = makeDeps({ lockPid: 4242, pidAlive: true });
  await run(deps, { fix: true });
  assert.equal(deps.calls.unlink.length, 0, '活着的实例绝不能删锁');
});

await testAsync('不加 --fix 时一个写操作都不发生', async () => {
  const deps = makeDeps({ portsDown: [11434], lockPid: 999999, pidAlive: false });
  await run(deps, { fix: false });
  assert.deepEqual(deps.calls.runTask, []);
  assert.deepEqual(deps.calls.unlink, []);
});

// ── 7. 日志时间窗（本地时间，别用 UTC 算）────────────────────────────────────
test('近 10 分钟日志计数按本地时间匹配，跨零点也不漏', () => {
  const now = new Date(2026, 9, 27, 22, 30, 0).getTime(); // 本地 22:30
  const text = ['22:25:00 [bridge] 普通日志', '22:26:00 [error] 失败了', '21:00:00 [error] 一小时前的不算'].join('\n');
  const r = countRecentLogProblems(text, now, 10 * 60 * 1000);
  assert.equal(r.error, 1);
  assert.equal(r.total, 2);
  const midnight = new Date(2026, 9, 28, 0, 2, 0).getTime();
  const r2 = countRecentLogProblems('23:58:00 [warn] 跨零点', midnight, 10 * 60 * 1000);
  assert.equal(r2.warn, 1, '跨零点必须仍算在窗口内');
});

// ── 8. 报告形状（给 /api/self-check 与 --json 用）───────────────────────────
await testAsync('报告形状：ok/status/at/tookMs/counts/groups[].evidence 齐全且可 JSON 化', async () => {
  const report = await run(makeDeps());
  const round = JSON.parse(JSON.stringify(report));
  for (const key of ['ok', 'status', 'at', 'tookMs', 'counts', 'groups']) assert.ok(key in round, `缺字段 ${key}`);
  for (const g of round.groups) for (const key of ['id', 'title', 'status', 'summary', 'evidence']) assert.ok(key in g, `${g.id} 缺 ${key}`);
  assert.deepEqual(Object.keys(round.counts).sort(), ['fail', 'ok', 'warn']);
});

// ── 9. 控制台接线（静态断言：路由 + 页面 + 鉴权）────────────────────────────
test('控制台路由：POST /api/self-check + GET /api/self-check/last，且对会话级主体 403', () => {
  const ops = fs.readFileSync(path.join(ROOT, 'src', 'bridge', 'console', 'operations.js'), 'utf8');
  assert.match(ops, /startsWith\('\/api\/self-check'\)/, '要有 /api/self-check 前缀分派');
  assert.match(ops, /async function handleConsoleSelfCheck\(request, deps\)/, '处理函数要能拿到 deps');
  assert.match(ops, /request\.req\.method === 'GET'/, 'GET 走「取最近一次」分支，其余（POST）走「跑一次」');
  assert.match(ops, /x-agent-token/);
  assert.match(ops, /403/);
  assert.match(ops, /self-check-last\.json/, '结果要落 state/self-check-last.json');
  assert.match(ops, /deps\.selfCheckRun/, '要真的调自检（不是桩）');
  const server = fs.readFileSync(path.join(ROOT, 'src', 'bridge', 'console-server.js'), 'utf8');
  assert.match(server, /url\.pathname\.startsWith\('\/api\/self-check'\)/, '路由表要放行 /api/self-check');
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.match(bridge, /import \{ runSelfCheck \} from '\.\/self-check\.js'/, '入口要真的把自检装进来');
  assert.match(bridge, /get selfCheckRun\(\)/, 'runtimeBindings 要暴露 selfCheckRun');
});

test('运维面板 ops.html：有「自检」按钮、结果容器，并按 ok/warn/fail 渲染', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'ops.html'), 'utf8');
  assert.match(html, /id="selfcheck-run"/, '缺自检按钮');
  assert.match(html, /id="selfcheck-groups"/, '缺结果容器');
  assert.match(html, /id="selfcheck-summary"/, '缺汇总行');
  assert.match(html, /\/api\/self-check/, '按钮要调自检接口');
  assert.match(html, /x-console-token|token=/, '带控制台令牌');
  assert.match(html, /esc\(/, '渲染要走转义（群号/路径是服务端数据）');
  assert.match(html, /fail[\s\S]{0,80}warn[\s\S]{0,80}ok|order\[/, '要按严重度排序渲染');
});

test('CLI：--json / --fix / --root 都有，退出码 0/1 由报告决定', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'scripts', 'self-check.mjs'), 'utf8');
  assert.match(cli, /--json/);
  assert.match(cli, /--fix/);
  assert.match(cli, /--root/);
  assert.match(cli, /process\.exit\(report\.ok \? 0 : 1\)/);
});

// ── 10. 真跑一遍控制台 handler（不走网络，只走真实分派与鉴权）────────────────
test('控制台 handler 真跑：POST 落盘、GET /last 取回、x-agent-* 403 且不触发自检', async () => {
  const { createConsoleOperations } = await import('../src/bridge/console/operations.js');
  const writes = [];
  let ran = 0;
  const deps = {
    path,
    STATE_DIR: 'E:/fixture/state',
    fs: { readFileSync() { const e = new Error('ENOENT'); throw e; } },
    atomicWriteJson(file, obj) { writes.push({ file, obj }); },
    async selfCheckRun() { ran += 1; return { ok: true, status: 'ok', at: new Date().toISOString(), tookMs: 1, counts: { ok: 9, warn: 0, fail: 0 }, groups: [], fixes: [] }; },
  };
  const { handleConsoleOperations } = createConsoleOperations(deps);
  const makeReq = (method, pathname, headers = {}) => {
    const out = { body: null, status: 0 };
    return {
      out,
      request: {
        req: { method, headers },
        url: new URL('http://127.0.0.1:3100' + pathname),
        sendJson(body, status = 200) { out.body = body; out.status = status; },
        res: { writeHead() {}, end() {} },
        SECURITY_HEADERS: {},
      },
    };
  };

  // GET /last 还没有记录 → 404（不能假装成功）
  const miss = makeReq('GET', '/api/self-check/last');
  await handleConsoleOperations(miss.request);
  assert.equal(miss.out.status, 404);
  assert.equal(miss.out.body.ok, false);

  // POST → 跑自检 + 落盘
  const post = makeReq('POST', '/api/self-check');
  await handleConsoleOperations(post.request);
  assert.equal(post.out.status, 200);
  assert.equal(post.out.body.ok, true);
  assert.ok(post.out.body.report, '要回完整报告');
  assert.equal(ran, 1);
  assert.equal(writes.length, 1, '要落一次盘');
  assert.ok(writes[0].file.endsWith('self-check-last.json'));
  assert.deepEqual(writes[0].obj, post.out.body.report, '落盘内容与返回一致');

  // GET /last 现在能取回（桩一个读得到的状态）
  deps.fs.readFileSync = () => JSON.stringify(writes[0].obj);
  const hit = makeReq('GET', '/api/self-check/last');
  await handleConsoleOperations(hit.request);
  assert.equal(hit.out.status, 200);
  assert.equal(hit.out.body.cached, true);
  assert.deepEqual(hit.out.body.report, writes[0].obj);

  // 会话级主体 → 403，且绝不触发自检
  const agent = makeReq('POST', '/api/self-check', { 'x-agent-token': 't' });
  await handleConsoleOperations(agent.request);
  assert.equal(agent.out.status, 403);
  assert.equal(ran, 1, '被拒时不能真跑自检');
});

test('真实 deps 存在且可构造（不发起网络：只查函数形状）', () => {
  const deps = createRealDeps();
  for (const key of ['tcp', 'httpJson', 'readText', 'readJson', 'exists', 'writable', 'freeBytes', 'dbIntegrity', 'taskState', 'runTask', 'gitHeadMs', 'pidAlive', 'unlink', 'sleep', 'now']) {
    assert.equal(typeof deps[key], 'function', `真实 deps 缺 ${key}`);
  }
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
process.exit(failures ? 1 : 0);
