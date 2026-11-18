// /api/agent/probe（设置页「测试连通」）的离线测试：起本地 http 假端点，不碰真实网络。
//
// 重点：
// - openai 快路径 GET /models；404 时降级 POST /chat/completions（很多兼容端点只实现 chat）；
// - 401/403、连不上、超时都要翻成中文人话，而且**永远不 500**（按钮最怕堆栈）；
// - 响应/日志里绝不出 apiKey（只 hasApiKey）；baseUrl 只允许 http(s)；
// - dsh 走 /api/status；agent 令牌一律 403。
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createAgentProbe } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/agent-probe.js')).href);

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const header = (title) => console.log(`## ${title}`);

// ── 假端点：/models、/chat/completions、/api/status、/slow（永不应答）──
const hits = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  hits.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || '' });
  if (url.pathname === '/v1/models') {
    if (req.headers.authorization === 'Bearer valid-key') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
    } else if (req.headers.authorization === 'Bearer bad-key') {
      res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}');
    } else {
      res.writeHead(404); res.end('not found');
    }
    return;
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    if (req.headers.authorization === 'Bearer bad-key') { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { total_tokens: 2 } }));
    return;
  }
  if (url.pathname === '/dsh/api/status') {
    if (req.headers.authorization === 'Bearer bad-key') { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    return;
  }
  if (url.pathname === '/health') {
    if (req.headers.authorization === 'Bearer bad-key') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    return;
  }
  if (url.pathname === '/slow/models') return; // 留着连接不放，测超时
  res.writeHead(500); res.end('boom');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const logs = [];
function mkApi(cfgAgent = {}) {
  return createAgentProbe({
    cfg: { agent: cfgAgent },
    URL,
    fetch,
    setTimeout,
    clearTimeout,
    log: (message) => logs.push(String(message))
  });
}
function mkReq({ method = 'POST', headers = {}, body = {} } = {}) {
  const r = {
    req: { method, headers },
    url: new URL('http://127.0.0.1:3100/api/agent/probe'),
    res: {},
    body,
    async readBody() { if (r.body instanceof Error) throw r.body; return r.body; },
    sent: null,
    sendJson(payload, status = 200) { r.sent = { payload, status }; }
  };
  return r;
}
async function call(api, opts = {}) {
  const r = mkReq(opts);
  if (opts.path) r.url = new URL('http://127.0.0.1:3100' + opts.path);
  const handled = await api.handleConsoleAgentProbe(r);
  return { handled, status: r.sent ? r.sent.status : 0, payload: r.sent ? r.sent.payload : null };
}

try {
  header('openai 快路径：/models 200');
  {
    const api = mkApi();
    const r = await call(api, { body: { type: 'openai', baseUrl: `${base}/v1`, apiKey: 'valid-key', model: 'mock-model' } });
    check('返回 200 且 ok', r.status === 200 && r.payload.ok === true, JSON.stringify(r.payload));
    check('detail 说明打的是 /models', /\/models/.test(String(r.payload.detail)), String(r.payload.detail));
    check('带 type/model', r.payload.type === 'openai' && r.payload.model === 'mock-model');
    check('latencyMs 是数字且 ≥0', typeof r.payload.latencyMs === 'number' && r.payload.latencyMs >= 0);
    check('hasApiKey=true', r.payload.hasApiKey === true);
    check('响应里没有 apiKey 明文', !JSON.stringify(r.payload).includes('valid-key'), JSON.stringify(r.payload));
    check('没有 error 字段', r.payload.error === undefined);
    check('真的打到了假端点的 /v1/models', hits.some((h) => h.path === '/v1/models' && h.auth === 'Bearer valid-key'));
  }

  header('openai 404 降级 chat/completions');
  {
    const api = mkApi();
    const r = await call(api, { body: { type: 'openai', baseUrl: `${base}/v1`, model: 'mock-model' } });
    check('404 后降级仍 ok', r.status === 200 && r.payload.ok === true, JSON.stringify(r.payload));
    check('detail 里出现降级字样', /降级/.test(String(r.payload.detail)), String(r.payload.detail));
    check('确实发了一次 POST /v1/chat/completions', hits.some((h) => h.path === '/v1/chat/completions' && h.method === 'POST'));
    check('没配 key 时 hasApiKey=false', r.payload.hasApiKey === false);
  }

  header('openai 认证失败 / 连不上 / 超时');
  {
    const api = mkApi();
    const r = await call(api, { body: { type: 'openai', baseUrl: `${base}/v1`, apiKey: 'bad-key' } });
    check('401 → ok:false', r.status === 200 && r.payload.ok === false);
    check('401 中文：key 不对或没有权限', r.payload.error === 'key 不对或没有权限', String(r.payload.error));
    check('401 仍回 hasApiKey=true（但不会回明文）', r.payload.hasApiKey === true && !JSON.stringify(r.payload).includes('bad-key'));
  }
  {
    // 关掉的端口 → ECONNREFUSED
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    const api = mkApi();
    const r = await call(api, { body: { type: 'openai', baseUrl: `http://127.0.0.1:${deadPort}/v1` } });
    check('连不上 → ok:false', r.payload.ok === false);
    check('连不上中文：连不上这个地址', /连不上这个地址/.test(String(r.payload.error)), String(r.payload.error));
  }
  {
    const api = mkApi();
    const started = Date.now();
    const r = await call(api, { body: { type: 'openai', baseUrl: `${base}/slow`, timeoutMs: 200 } });
    const elapsed = Date.now() - started;
    check('永不应答 → ok:false', r.payload.ok === false);
    check('超时中文', r.payload.error === '请求超时（8 秒）', String(r.payload.error));
    check('真的在 timeoutMs 附近返回（<3s）', elapsed < 3000, String(elapsed));
  }

  header('dsh 探活 / http 未实现 / baseUrl 校验');
  {
    const api = mkApi();
    const r = await call(api, { body: { type: 'dsh', baseUrl: `${base}/dsh` } });
    check('dsh /api/status 200 → ok', r.payload.ok === true && /\/api\/status/.test(String(r.payload.detail)), JSON.stringify(r.payload));
  }
  {
    const api = mkApi();
    const r = await call(api, { body: { type: 'dsh', baseUrl: `${base}/dsh`, apiKey: 'bad-key' } });
    check('dsh 401/403 视为可达（DSH 在线但需鉴权）', r.payload.ok === true && /DSH 在线/.test(String(r.payload.detail)), JSON.stringify(r.payload));
  }
  {
    const api = mkApi();
    const r = await call(api, { body: { type: 'dsh' } });
    check('dsh 没配地址 → 人话', r.payload.ok === false && /DSH 地址没配置/.test(String(r.payload.error)), String(r.payload.error));
  }
  {
    // 设置页只填 agent.baseUrl 的话，dsh 后端会一直报「地址没配置」；必须回退到 dsh.baseUrl。
    const api = createAgentProbe({
      cfg: { agent: {}, dsh: { baseUrl: `${base}/dsh` } },
      URL,
      fetch,
      setTimeout,
      clearTimeout,
      log: (message) => logs.push(String(message))
    });
    const r = await call(api, { body: { type: 'dsh' } });
    check('dsh 没填 agent.baseUrl 时回退 dsh.baseUrl → ok', r.payload.ok === true, JSON.stringify(r.payload));
    check('回退时 detail 里是 dsh.baseUrl 的 /api/status', /\/dsh\/api\/status/.test(String(r.payload.detail)), String(r.payload.detail));
  }
  {
    // P2：http transport 的探活是 GET {baseUrl}/health（200 即 ok；401/403 说明需要鉴权）。
    const api = mkApi();
    const ok = await call(api, { body: { type: 'http', baseUrl: base } });
    check('http /health 200 → ok', ok.payload.ok === true && /health/.test(String(ok.payload.detail)), JSON.stringify(ok.payload));
    const bad = await call(api, { body: { type: 'http', baseUrl: base, apiKey: 'bad-key' } });
    check('http /health 401 → 需要鉴权', bad.payload.ok === false && /需要鉴权/.test(String(bad.payload.error)), String(bad.payload.error));
  }
  {
    const api = mkApi();
    const r = await call(api, { body: { type: 'openai', baseUrl: 'ftp://example.com/v1' } });
    check('非法协议 → 中文拒绝', r.payload.ok === false && /只支持 http/.test(String(r.payload.error)), String(r.payload.error));
    const r2 = await call(api, { body: { type: 'openai', baseUrl: '::::' } });
    check('解析不了的 baseUrl → 中文拒绝', r2.payload.ok === false && /不是合法地址/.test(String(r2.payload.error)), String(r2.payload.error));
    const r3 = await call(api, { body: { type: 'openai' } });
    check('没配 baseUrl → 提示去设置里填', r3.payload.ok === false && /还没配置 baseUrl/.test(String(r3.payload.error)));
  }

  header('缺省用运行时配置（设置页不传参数也能测）');
  {
    const api = mkApi({ type: 'openai', baseUrl: `${base}/v1`, model: 'cfg-model', apiKey: 'valid-key' });
    const r = await call(api, { body: {} });
    check('cfg.agent.type/baseUrl/apiKey 生效 → ok', r.payload.ok === true && r.payload.type === 'openai', JSON.stringify(r.payload));
    check('cfg 的 model 回显', r.payload.model === 'cfg-model');
    check('hasApiKey 来自 cfg', r.payload.hasApiKey === true);
  }

  header('安全与容错：agent 403、方法、坏 body、最近一次结果');
  {
    const api = mkApi({ type: 'openai', baseUrl: `${base}/v1`, apiKey: 'valid-key' });
    const r = await call(api, { headers: { 'x-agent-token': 'abc' } });
    check('x-agent-token → 403', r.status === 403 && r.payload.ok === false);
    const r2 = await call(api, { headers: { 'x-agent-call': '1' } });
    check('x-agent-call → 403', r2.status === 403);
    check('403 文案说明管理端', /管理端/.test(String(r.payload.error)));
    const r3 = await call(api, { method: 'GET' });
    check('GET → 405', r3.status === 405);
    const r4 = await call(api, { path: '/api/library/downloads' });
    check('其它路径不接管（返回 false）', r4.handled === false);
    const r5 = await call(api, { body: new Error('bad json') });
    check('坏请求体 → 200 + 人话（不是 500）', r5.status === 200 && r5.payload.ok === false && /算不上|不是合法的 JSON/.test(String(r5.payload.error)), JSON.stringify(r5));
    const last = api.lastProbe();
    check('lastProbe 只暴露 at/ok/latencyMs', r.payload.ok === false && last && Object.keys(last).sort().join(',') === 'at,latencyMs,ok');
    check('lastProbe 里没有 apiKey', !JSON.stringify(last).includes('valid-key'));
  }

  header('意外异常也不 500');
  {
    const api = createAgentProbe({
      cfg: { agent: {} },
      URL,
      fetch: () => { throw new Error('boom'); },
      setTimeout,
      clearTimeout,
      log: (message) => logs.push(String(message))
    });
    const r = await call(api, { body: { type: 'dsh', baseUrl: `${base}/dsh` } });
    check('fetch 同步抛错 → 200 + ok:false', r.status === 200 && r.payload.ok === false, JSON.stringify(r.payload));
    check('同步抛错也翻成人话（连不上）', /连不上这个地址/.test(String(r.payload.error)), String(r.payload.error));
  }
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

console.log(`\n通过 ${passed} / 失败 ${failures.length}`);
if (failures.length) process.exit(1);
