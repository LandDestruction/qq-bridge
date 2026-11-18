// 面板常驻进程（scripts/console-host.mjs）的契约测试：
//   ① 静态页/资源仍从 public/ 发；
//   ② 桥接活着时 /api/* 原样转发（含 x-console-token 与 body）；
//   ③ 桥接挂了回 503 + x-console-offline: 1（不是 500、不是空响应）；
//   ④ /console-host/health 能看出桥接在不在；
//   ⑤ 端口被占用时优雅退出（exit 0，不给启动脚本无限重启）；
//   ⑥ 启动脚本、桌面壳、前端横幅都已经接上这个进程。
// 用两个临时端口 + 一个假桥接，不碰真实的 3100/3101。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_SCRIPT = path.join(ROOT, 'scripts', 'console-host.mjs');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const HOST_PORT = 3191;
const BRIDGE_PORT = 3192;
const CLASH_PORT = 3193;

function waitFor(checkFn, timeoutMs = 8000, stepMs = 120) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      Promise.resolve(checkFn()).then((ok) => {
        if (ok) return resolve(true);
        if (Date.now() - started > timeoutMs) return resolve(false);
        setTimeout(tick, stepMs);
      }).catch(() => {
        if (Date.now() - started > timeoutMs) return resolve(false);
        setTimeout(tick, stepMs);
      });
    };
    tick();
  });
}

function request(port, urlPath, options = {}) {
  const method = options.method || 'GET';
  const headers = Object.assign({}, options.headers);
  let body = options.body || null;
  if (body && typeof body === 'string') {
    headers['content-type'] = headers['content-type'] || 'application/json';
    headers['content-length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, timeout: 6000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (error) => resolve({ status: 0, headers: {}, text: '', error }));
    if (body) req.write(body);
    req.end();
  });
}

function startFakeBridge(port) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url.startsWith('/api/health')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, bridge: 'fake' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        method: req.method,
        token: req.headers['x-console-token'] || null,
        bodyLength: Buffer.concat(chunks).length,
      }));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function spawnHost(port, bridgePort) {
  const child = spawn(process.execPath, [HOST_SCRIPT], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      QQ_CONSOLE_PORT: String(port),
      QQ_BRIDGE_PORT: String(bridgePort),
      QQ_CONSOLE_PROXY_TIMEOUT: '4000',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return { child, stdout: () => out };
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* 已退出 */ } resolve(); }, 2500);
  });
}

async function main() {
  // ── 静态契约 ──────────────────────────────────────────────────────────────
  const hostSrc = fs.readFileSync(HOST_SCRIPT, 'utf8');
  check('面板进程只发 public/ 下的白名单页面（PAGES 表里有 /client 与 /client.css /client.js）',
    /const PAGES = new Map\(\[/.test(hostSrc) && /\['\/client', \{ file: 'client\.html'/.test(hostSrc) && /\['\/client\.js', \{ file: 'client\.js'/.test(hostSrc),
    hostSrc.slice(0, 120));
  check('桥接挂了回 503 而不是 500，并带 x-console-offline 头',
    /sendJson\(res, 503,/.test(hostSrc) && /'x-console-offline': '1'/.test(hostSrc));
  check('反代失败的错误文案直接说「机器人没在跑（面板还在…）」',
    /机器人没在跑（面板还在/.test(hostSrc));
  check('健康检查路径是 /console-host/health 且带 bridge.up',
    /\/console-host\/health/.test(hostSrc) && /up: bridgeUp|up:.*up/.test(hostSrc));
  check('面板进程写响应前检查 headersSent，客户端提前断开不会把进程写崩',
    /if \(res\.headersSent \|\| res\.writableEnded\) return;/.test(hostSrc));
  const bridgeConsole = read('src/bridge/console-server.js');
  check('桥接的 sendJson 同样有 headersSent 守卫（ERR_HTTP_HEADERS_SENT 曾把桥接带崩）',
    /if \(res\.headersSent \|\| res\.writableEnded\) return;/.test(bridgeConsole));
  check('端口被占用（EADDRINUSE）时退出码 0，启动脚本不会无限重启',
    /EADDRINUSE/.test(hostSrc) && /process\.exit\(0\)/.test(hostSrc));

  const startBat = read('start.bat');
  check('start.bat 会顺手拉起面板进程', /start-console-host\.bat/.test(startBat));
  const hostBat = fs.existsSync(path.join(ROOT, 'start-console-host.bat')) ? read('start-console-host.bat') : '';
  check('start-console-host.bat 存在且退出码 0 时不重启',
    /console-host\.mjs/.test(hostBat) && /if "%code%"=="0"/.test(hostBat));

  const hostCs = read('desktop/Host.cs');
  check('桌面壳优先连 console-host（探不到再退回桥接端口）',
    /ResolveConsoleHostPort/.test(hostCs) && /ConsoleHostProbe\.IsUp\(hostPort\) \? hostPort : paths\.ResolvePort\(\)/.test(hostCs));

  const shellJs = read('client/01-shell.js');
  check('前端读 x-console-offline 并挂横幅', /x-console-offline/.test(shellJs) && /markBridgeDown|paintBridgeBanner/.test(shellJs));
  check('机器人下线时写操作直接被挡（不发出去）', /state\.bridgeDown\) return Promise\.reject/.test(shellJs));
  const clientHtml = read('public/client.html');
  check('页面里有离线横幅 DOM（#bridgeOffline + #bridgeRetry）',
    /id="bridgeOffline"/.test(clientHtml) && /id="bridgeRetry"/.test(clientHtml));

  // ── 真实行为：先用一个假桥接验证「转发」 ────────────────────────────────────
  const fake = await startFakeBridge(BRIDGE_PORT);
  const hostUp = spawnHost(HOST_PORT, BRIDGE_PORT);
  const ready = await waitFor(async () => {
    const res = await request(HOST_PORT, '/console-host/health');
    return res.status === 200;
  });
  check('面板进程能在指定端口起来（/console-host/health 200）', ready, hostUp.stdout().slice(0, 200));

  const health = await request(HOST_PORT, '/console-host/health');
  const healthJson = (() => { try { return JSON.parse(health.text); } catch (e) { return {}; } })();
  check('健康检查报告 host 与桥接端口', healthJson.host === 'console-host' && healthJson.bridge && healthJson.bridge.port === BRIDGE_PORT, health.text.slice(0, 120));
  check('桥接在跑时 bridge.up 为 true', healthJson.bridge && healthJson.bridge.up === true);

  const page = await request(HOST_PORT, '/client');
  check('GET /client 直接从 public/ 发页面（200 且是 html）',
    page.status === 200 && /text\/html/.test(page.headers['content-type'] || '') && page.text.length > 5000);
  const js = await request(HOST_PORT, '/client.js');
  check('GET /client.js 发前端脚本（200 且体积像话）',
    js.status === 200 && js.text.length > 100000);

  const proxied = await request(HOST_PORT, '/api/status', { headers: { 'x-console-token': 'tok-abc' } });
  const proxiedJson = (() => { try { return JSON.parse(proxied.text); } catch (e) { return {}; } })();
  check('桥接在跑时 /api/* 原样转发（令牌也带过去）',
    proxied.status === 200 && proxiedJson.token === 'tok-abc', proxied.text.slice(0, 120));

  const posted = await request(HOST_PORT, '/api/socialV2/activity', { method: 'POST', body: JSON.stringify({ paused: true }) });
  const postedJson = (() => { try { return JSON.parse(posted.text); } catch (e) { return {}; } })();
  check('POST 的请求体也转发给桥接（method + body 原样）',
    posted.status === 200 && postedJson.method === 'POST' && postedJson.bodyLength > 0);

  const missing = await request(HOST_PORT, '/nope');
  check('未知地址回 404 JSON', missing.status === 404 && /application\/json/.test(missing.headers['content-type'] || ''));
  const favicon = await request(HOST_PORT, '/favicon.ico');
  check('/favicon.ico 回 204（不刷错误）', favicon.status === 204);

  // ── 桥接停掉：同一个面板进程应该活下来并报离线 ──────────────────────────────
  await new Promise((resolve) => fake.close(resolve));
  const offline = await request(HOST_PORT, '/api/status', { headers: { 'x-console-token': 'tok-abc' } });
  const offlineJson = (() => { try { return JSON.parse(offline.text); } catch (e) { return {}; } })();
  check('桥接挂掉后 /api/* 回 503', offline.status === 503, `status=${offline.status}`);
  check('离线响应带 x-console-offline: 1（前端据此挂横幅）', offline.headers['x-console-offline'] === '1');
  check('离线响应体带 offline:true 与可读原因',
    offlineJson.ok === false && offlineJson.offline === true && /机器人没在跑/.test(String(offlineJson.error || '')), offline.text.slice(0, 160));
  const stillAlive = await request(HOST_PORT, '/client');
  check('桥接挂了面板照样能打开页面（这是这次改造的核心）', stillAlive.status === 200 && stillAlive.text.length > 5000);
  const healthOffline = await request(HOST_PORT, '/console-host/health');
  const healthOfflineJson = (() => { try { return JSON.parse(healthOffline.text); } catch (e) { return {}; } })();
  check('健康检查此时报 bridge.up=false 但自身仍 ok', healthOffline.status === 200 && healthOfflineJson.ok === true && healthOfflineJson.bridge && healthOfflineJson.bridge.up === false);

  // 桥接回来：同一个进程自动恢复转发
  const fake2 = await startFakeBridge(BRIDGE_PORT);
  const back = await request(HOST_PORT, '/api/status');
  check('桥接回来后面板自己恢复转发（不用重启面板进程）',
    back.status === 200, `status=${back.status}`);
  await new Promise((resolve) => fake2.close(resolve));

  await stopChild(hostUp.child);

  // ── 端口被占用：退出码 0（启动脚本不该无限重启） ────────────────────────────
  const blocker = http.createServer((req, res) => res.end('busy'));
  await new Promise((resolve) => blocker.listen(CLASH_PORT, '127.0.0.1', resolve));
  const clash = spawnHost(CLASH_PORT, BRIDGE_PORT);
  const clashCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 8000);
    clash.child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  check('端口被占用时进程退出码为 0（避免启动脚本循环重启）', clashCode === 0, `code=${clashCode} out=${clash.stdout().slice(0, 160)}`);
  await new Promise((resolve) => blocker.close(resolve));

  const failed = results.filter((item) => !item.ok);
  const total = results.length;
  const passed = total - failed.length;
  console.log(`\nconsole-host: ${passed}/${total} ok`);
  if (failed.length > 0) {
    console.log('失败的检查：');
    for (const item of failed) console.log(`  - ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('console-host 测试崩了：', error);
  process.exitCode = 1;
});
