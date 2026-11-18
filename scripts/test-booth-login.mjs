// BOOTH 登录窗口（开浏览器 → 用户登录 → CDP 抓 Cookie → 验证 → 写进 Cookie 库）的后端测试。
// 不联网、不真起浏览器：spawn / net / CDP / WebSocket / fetch 全是桩，只有 fs 和 Cookie 库是真的。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as boothDownloadPure from '../src/booth-download.js';
import { createBoothLogin } from '../src/bridge/console/booth-login.js';

let pass = 0;
const failures = [];
function ok(value, name) {
  if (value) { pass += 1; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name}`); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, ms = 3000, step = 20) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(step);
  }
  return null;
}

function makeOkResponse(text, extra = {}) {
  return {
    ok: true, status: 200, url: 'https://accounts.booth.pm/library',
    text: async () => text, json: async () => ({}), ...extra
  };
}

// 假浏览器：spawn 的返回值要能挂 exit 监听、pid 可读、kill 可数。
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    FakeWebSocket.lastUrl = url;
    setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
  }
  send(raw) {
    const msg = JSON.parse(raw);
    FakeWebSocket.sent.push(msg);
    const cookies = FakeWebSocket.cookies;
    setTimeout(() => {
      if (this.onmessage) this.onmessage({ data: JSON.stringify({ id: msg.id, result: { cookies } }) });
    }, 0);
  }
  close() { FakeWebSocket.closed += 1; if (this.onclose) this.onclose(); }
}
FakeWebSocket.cookies = [];
FakeWebSocket.sent = [];
FakeWebSocket.closed = 0;
FakeWebSocket.lastUrl = '';

function makeDeps(tmp, overrides = {}) {
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const logs = [];
  const spawnCalls = [];
  const child = { pid: 4242, exitCb: null, killed: false, on(event, cb) { if (event === 'exit') this.exitCb = cb; }, kill() { this.killed = true; } };
  const fetchCalls = [];
  const deps = {
    path, STATE_DIR: stateDir, atomicWriteJson: (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2)),
    boothDownloadPure,
    cfg: {},
    fetch: async (url, init) => { deps._fetchCalls.push({ url: String(url), headers: (init && init.headers) || {} }); return makeOkResponse('<html><body>owned library</body></html>'); },
    fs: {
      existsSync: (p) => fs.existsSync(p),
      readFileSync: (p, enc) => fs.readFileSync(p, enc),
      writeFileSync: (p, data, enc) => fs.writeFileSync(p, data, enc),
      mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
      chmodSync: () => {},
      rmSync: (p, opts) => fs.rmSync(p, opts)
    },
    log: (line) => logs.push(String(line)),
    net: {
      createServer: () => {
        const server = {
          once() {},
          listen(_port, _host, cb) { setTimeout(cb, 0); },
          address: () => ({ port: 9333 }),
          close(cb) { if (cb) cb(); }
        };
        return server;
      }
    },
    spawn: (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return child; },
    WebSocket: FakeWebSocket,
    cdpFetch: async (target) => {
      const u = String(target);
      if (u.endsWith('/json/version')) return { ok: true, status: 200, json: async () => ({ Browser: 'Edge/122' }) };
      if (u.endsWith('/json/list')) {
        return {
          ok: true, status: 200,
          json: async () => [{ type: 'page', url: 'https://accounts.booth.pm/library', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/1' }]
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
    boothLoginTiming: { pollMs: 20, cdpReadyMs: 400, timeoutMs: 5000 },
    ...overrides
  };
  deps._logs = logs;
  deps._fetchCalls = fetchCalls;
  deps._spawnCalls = spawnCalls;
  deps._child = child;
  return deps;
}

function call(handler, pathname, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (payload, status) => { if (!done) { done = true; resolve({ payload, status, handled: payload !== false }); } };
    const request = {
      req: { method, headers },
      url: new URL(`http://127.0.0.1:3100${pathname}`),
      sendJson: (payload, status = 200) => finish(payload, status),
      readBody: async () => body || {}
    };
    Promise.resolve(handler(request)).then((handled) => {
      if (handled === false) finish(false, 0);
    }).catch((error) => finish({ ok: false, error: String(error && error.message) }, 500));
  });
}

function cookieFile(stateDir) { return path.join(stateDir, 'booth-cookies.json'); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-login-'));
const tmpA = path.join(tmpRoot, 'a');
fs.mkdirSync(tmpA, { recursive: true });
const SECRET = 'sid-value-should-never-leak';

console.log('## 启动：状态机 idle → launching → waiting → succeeded');
{
  FakeWebSocket.cookies = [
    { domain: '.booth.pm', name: '_plaza_session_id', value: SECRET, httpOnly: true },
    { domain: 'accounts.booth.pm', name: 'session_id', value: 'accounts-cookie' },
    { domain: '.example.com', name: 'tracker', value: 'should-not-be-sent' }
  ];
  const deps = makeDeps(tmpA, {
    fetch: async (url, init) => { deps._fetchCalls.push({ url: String(url), headers: (init && init.headers) || {} }); await sleep(150); return makeOkResponse('<html><body>owned library</body></html>'); }
  });
  const svc = createBoothLogin(deps);
  const idle = await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/status');
  ok(idle.payload.state === 'idle', '初始状态 idle');
  ok(idle.payload.profileDir === 'state/booth-login-profile', '状态里带持久 profile 目录名');
  ok(idle.payload.cookieSaved === false, '初始没保存 Cookie');

  const started = await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/start', { method: 'POST', body: {} });
  ok(started.status === 200 && started.payload.ok === true, 'start 立刻回 200');
  ok(started.payload.state === 'launching', 'start 回 launching（后台接着跑）');
  ok(started.payload.browser === 'edge', '优先用 Edge');
  ok(started.payload.profileDir === 'state/booth-login-profile', 'profile 固定 state/booth-login-profile');

  const spawn1 = deps._spawnCalls[0];
  ok(Boolean(spawn1) && /msedge\.exe$/i.test(String(spawn1.cmd)), 'spawn 的是 Edge 可执行文件');
  ok(spawn1.args.some((a) => a === '--remote-debugging-port=9333'), '启动参数带空闲调试端口');
  ok(spawn1.args.some((a) => a.startsWith('--user-data-dir=') && a.includes('booth-login-profile')), '启动参数带持久 profile 目录');
  ok(spawn1.args.includes('--no-first-run') && spawn1.args.includes('--no-default-browser-check'), '启动参数带 no-first-run / no-default-browser-check');
  ok(spawn1.args.includes('https://accounts.booth.pm/library'), '打开的地址是已购清单页（未登录会跳登录）');

  const waiting = await waitFor(async () => {
    const st = await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/status');
    return st.payload.state === 'waiting' ? st : null;
  }, 3000);
  ok(Boolean(waiting), '调试端口就绪后进入 waiting');
  if (waiting) ok(/请在打开的浏览器窗口里完成 BOOTH 登录/.test(String(waiting.payload.hint)), 'waiting 给人话提示');

  const settled = await waitFor(async () => {
    const st = await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/status');
    return st.payload.state === 'succeeded' ? st : null;
  }, 3000);
  ok(Boolean(settled), '验证通过后进入 succeeded');
  if (settled) {
    ok(settled.payload.cookieSaved === true, 'succeeded 标记 cookieSaved');
    ok(String(settled.payload.maskedCookieKey || '').length === 8, '只回 maskedCookieKey（8 位）');
    ok(settled.payload.syncHint === 'Cookie 已保存，回去点「同步已购」就能拉清单', 'succeeded 给同步提示');
    ok(JSON.stringify(settled.payload).indexOf(SECRET) < 0, '响应里没有 Cookie 明文');
  }
  const sentCookie = String((FakeWebSocket.sent.length ? FakeWebSocket.sent[0] : {}).method || '');
  ok(sentCookie === 'Storage.getCookies', 'CDP 用 Storage.getCookies 取 Cookie');

  // 验证请求用的是拼好的 Cookie：只带 booth 域。
  const validateCall = deps._fetchCalls[0];
  const sentCookieHeader = String((validateCall && validateCall.headers && validateCall.headers.cookie) || '');
  ok(sentCookieHeader.includes(SECRET), '验证请求带上了捞到的会话 Cookie');
  ok(sentCookieHeader.includes('accounts-cookie'), '账号站 Cookie 也拼进去了');
  ok(sentCookieHeader.indexOf('should-not-be-sent') < 0, '验证请求不带非 booth 域的 Cookie');
  const store = JSON.parse(fs.readFileSync(cookieFile(deps.STATE_DIR), 'utf8'));
  const accountKey = store.current;
  ok(Boolean(store.accounts && store.accounts[accountKey]), 'Cookie 写进了现有 Cookie 库');
  ok(String(store.accounts[accountKey].cookie).includes(SECRET), '落盘的是真 Cookie');
  ok(store.accounts[accountKey].note === 'BOOTH 登录窗口自动抓取', '落盘带来源备注');
  const fileText = fs.readFileSync(cookieFile(deps.STATE_DIR), 'utf8');
  ok(fileText.indexOf('should-not-be-sent') < 0, '非 booth 域的 Cookie 不落盘');

  await sleep(50);
  const killCall = deps._spawnCalls.find((c) => /taskkill/i.test(String(c.cmd)));
  ok(Boolean(killCall) || deps._child.killed, '成功后自动关掉浏览器');
  if (killCall) ok(killCall.args.includes('/T') && killCall.args.includes('/F'), 'taskkill 连子进程一起收');

  const logsText = deps._logs.join('\n');
  ok(logsText.indexOf(SECRET) < 0, '日志里没有 Cookie 明文');
  ok(/\[BOOTH登录\]/.test(logsText), '日志有统一前缀');
}

console.log('## 已经在等登录时再点 start：409');
{
  const deps = makeDeps(path.join(tmpRoot, 'a2'));
  const svc = createBoothLogin(deps);
  await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/start', { method: 'POST', body: {} });
  const again = await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/start', { method: 'POST', body: {} });
  ok(again.status === 409 && again.payload.ok === false, '重复 start 回 409');
  ok(/正在等登录/.test(String(again.payload.error)), '409 说明在等登录');
  await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/stop', { method: 'POST', body: {} });
}

console.log('## stop：cancelled + 关窗口；没在跑时 409');
{
  const deps = makeDeps(path.join(tmpRoot, 'b'));
  FakeWebSocket.cookies = []; // 停在 waiting，别让前面的成功 Cookie 把这次登录立刻推成 succeeded
  const svc = createBoothLogin(deps);
  await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/start', { method: 'POST', body: {} });
  await waitFor(async () => (await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/status')).payload.state === 'waiting', 3000);
  const stopped = await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/stop', { method: 'POST', body: {} });
  ok(stopped.payload.ok === true && stopped.payload.state === 'cancelled', 'stop 回 cancelled');
  const after = await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/status');
  ok(after.payload.state === 'cancelled', 'stop 之后状态保持 cancelled');
  const killCall = deps._spawnCalls.find((c) => /taskkill/i.test(String(c.cmd)));
  ok(Boolean(killCall) || deps._child.killed, 'stop 会关掉浏览器');
  const stopAgain = await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/stop', { method: 'POST', body: {} });
  ok(stopAgain.status === 409, '没在跑时 stop 回 409');
  ok(/现在没有在等登录/.test(String(stopAgain.payload.error)), '409 文案人话');
}

console.log('## 找不到浏览器：400 人话');
{
  const deps = makeDeps(path.join(tmpRoot, 'c'), {
    fs: {
      existsSync: () => false,
      readFileSync: (p, enc) => fs.readFileSync(p, enc),
      writeFileSync: (p, d, e) => fs.writeFileSync(p, d, e),
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      chmodSync: () => {}
    }
  });
  const svc = createBoothLogin(deps);
  const r = await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/start', { method: 'POST', body: {} });
  ok(r.status === 400, '没有 Edge/Chrome 时 400');
  ok(/没找到能用的浏览器（Edge 或 Chrome）/.test(String(r.payload.error)), '400 说清缺浏览器');
  ok(deps._spawnCalls.length === 0, '没浏览器时不 spawn');
}

console.log('## 超时：failed + 人话');
{
  const deps = makeDeps(path.join(tmpRoot, 'd'), {
    boothLoginTiming: { pollMs: 20, cdpReadyMs: 400, timeoutMs: 120 },
    cdpFetch: async (target) => {
      const u = String(target);
      if (u.endsWith('/json/version')) return { ok: true, status: 200, json: async () => ({}) };
      if (u.endsWith('/json/list')) {
        return { ok: true, status: 200, json: async () => [{ type: 'page', url: 'https://accounts.booth.pm/', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/1' }] };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }
  });
  FakeWebSocket.cookies = [];
  const svc = createBoothLogin(deps);
  await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/start', { method: 'POST', body: {} });
  const failed = await waitFor(async () => (await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/status')).payload.state === 'failed', 2000);
  ok(failed, '超时后状态 failed');
  const st = await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/status');
  ok(st.payload.error === '等了 5 分钟还没登录成功，再试一次', '超时错误是人话');
  ok(!fs.existsSync(cookieFile(deps.STATE_DIR)), '没登成功不写 Cookie 文件');
  ok(Boolean(deps._spawnCalls.find((c) => /taskkill/i.test(String(c.cmd)))) || deps._child.killed, '超时后也把浏览器关掉');
}

console.log('## 用户手动关窗口：failed「登录窗口被关掉了」');
{
  const deps = makeDeps(path.join(tmpRoot, 'e'), {
    boothLoginTiming: { pollMs: 50, cdpReadyMs: 400, timeoutMs: 5000 }
  });
  FakeWebSocket.cookies = [];
  const svc = createBoothLogin(deps);
  await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/start', { method: 'POST', body: {} });
  await waitFor(async () => (await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/status')).payload.state === 'waiting', 3000);
  if (deps._child.exitCb) deps._child.exitCb(0);
  const st = await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/status');
  ok(st.payload.state === 'failed', '窗口被关 → failed');
  ok(st.payload.error === '登录窗口被关掉了', '错误文案是「登录窗口被关掉了」');
}

console.log('## 验证不过（清单页还是登录表单）不写盘');
{
  const deps = makeDeps(path.join(tmpRoot, 'f'), {
    boothLoginTiming: { pollMs: 20, cdpReadyMs: 400, timeoutMs: 150 },
    fetch: async () => makeOkResponse('<form><input name="password"></form>')
  });
  FakeWebSocket.cookies = [{ domain: '.booth.pm', name: '_plaza_session_id', value: 'half-login' }];
  const svc = createBoothLogin(deps);
  await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/start', { method: 'POST', body: {} });
  const done = await waitFor(async () => (await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/status')).payload.state === 'failed', 2500);
  ok(done, '半登录态最终 failed');
  ok(!fs.existsSync(cookieFile(deps.STATE_DIR)), '验证不过不写 Cookie（防半登录态）');
  ok(deps._logs.some((line) => /验证没过/.test(line)), '日志记录验证没过');
}

console.log('## CDP 返回空 Cookie：不写盘');
{
  const deps = makeDeps(path.join(tmpRoot, 'g'), { boothLoginTiming: { pollMs: 20, cdpReadyMs: 400, timeoutMs: 120 } });
  FakeWebSocket.cookies = [];
  const svc = createBoothLogin(deps);
  await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/start', { method: 'POST', body: {} });
  await waitFor(async () => (await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/status')).payload.state === 'failed', 2500);
  ok(!fs.existsSync(cookieFile(deps.STATE_DIR)), '空 Cookie 不落盘');
}

console.log('## spawn 抛错：500 + 人话');
{
  const deps = makeDeps(path.join(tmpRoot, 'h'), { spawn: () => { throw new Error('EACCES 权限不够'); } });
  const svc = createBoothLogin(deps);
  const r = await call(svc.handleConsoleBoothLogin, '/api/library/purchases/login/start', { method: 'POST', body: {} });
  ok(r.status === 500, '浏览器起不来回 500');
  ok(/浏览器起不来/.test(String(r.payload.error)), '500 说清是浏览器起不来');
}

console.log('## 智能体令牌：一律 403');
{
  const deps = makeDeps(path.join(tmpRoot, 'i'));
  const svc = createBoothLogin(deps);
  for (const [pathname, method] of [
    ['/api/library/purchases/login/start', 'POST'],
    ['/api/library/purchases/login/status', 'GET'],
    ['/api/library/purchases/login/stop', 'POST']
  ]) {
    const r = await call(svc.handleConsoleBoothLogin, pathname, { method, headers: { 'x-agent-token': 'abc123' } });
    ok(r.status === 403, `${method} ${pathname} agent 头 403`);
  }
  ok(deps._spawnCalls.length === 0, 'agent 请求没有起浏览器');
}

console.log('## 其它路径与状态接口');
{
  const deps = makeDeps(path.join(tmpRoot, 'j'));
  const svc = createBoothLogin(deps);
  const other = await call(svc.handleConsoleBoothLogin, '/api/library/assets');
  ok(other.handled === false, '别的路径返回 false');
  const status = svc.boothLoginStatus();
  ok(status.state === 'idle' && status.ok === true, 'boothLoginStatus() 可直接读（供启动自检）');
  ok(status.elapsedMs === 0, '没启动过时 elapsedMs 是 0');
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('');
console.log(`BOOTH 登录：通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
