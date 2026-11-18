#!/usr/bin/env node
// console-host：常驻的「面板」进程（默认 127.0.0.1:3101）。
//
// 为什么要有它：3100 上的控制台服务跑在桥接进程里，桥接一停 / 一重启，页面本身
// 也跟着没了 —— 用户看到的是「面板失联」，而不是「机器人下线、面板还在」。
// 这个进程只做两件事：
//   ① 把 public/ 下的静态页面与资源发出去（页面不依赖桥接，永远打得开）；
//   ② 把 /api/* 原样反代到桥接（默认 127.0.0.1:3100）。
// 桥接不在时返回 503 + {offline:true}，前端据此挂「机器人已下线」横幅并每 3 秒重试；
// 桥接回来后这个进程不用重启，下一次请求就通了。
//
// 它自己不做鉴权：令牌校验仍在桥接（x-console-token / x-agent-token 原样转发），
// 静态页面本来就是公开的本地页面。只监听 127.0.0.1，不对外。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

const HOST = process.env.QQ_CONSOLE_HOST || '127.0.0.1';
const PORT = Number(process.env.QQ_CONSOLE_PORT || 3101);
const BRIDGE_HOST = process.env.QQ_BRIDGE_HOST || '127.0.0.1';
const BRIDGE_PORT = Number(process.env.QQ_BRIDGE_PORT || 3100);
const PROXY_TIMEOUT_MS = Number(process.env.QQ_CONSOLE_PROXY_TIMEOUT || 20000);
const PROBE_TIMEOUT_MS = 1200;

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http://gchat.qpic.cn http://*.qpic.cn https://tjc-download.ftn.qq.com; media-src 'self' blob: data:",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

// 页面与资源：和桥接里 static-pages.js 的那张表保持一致（两边都能打开同一批地址）。
const PAGES = new Map([
  ['/', { file: 'client.html', type: 'text/html; charset=utf-8' }],
  ['/client', { file: 'client.html', type: 'text/html; charset=utf-8' }],
  ['/client.html', { file: 'client.html', type: 'text/html; charset=utf-8' }],
  ['/ops', { file: 'ops.html', type: 'text/html; charset=utf-8' }],
  ['/library', { file: 'library.html', type: 'text/html; charset=utf-8' }],
  ['/library.html', { file: 'library.html', type: 'text/html; charset=utf-8' }],
  ['/ui-preview.html', { file: 'ui-preview.html', type: 'text/html; charset=utf-8' }],
  ['/client.css', { file: 'client.css', type: 'text/css; charset=utf-8' }],
  ['/client.js', { file: 'client.js', type: 'application/javascript; charset=utf-8' }],
  ['/changelog.js', { file: 'changelog.js', type: 'application/javascript; charset=utf-8' }],
  ['/bgm/default-tune.mp3', { file: 'bgm/default-tune.mp3', type: 'audio/mpeg' }],
  ['/bgm/haloflux-sw421k.mp3', { file: 'bgm/haloflux-sw421k.mp3', type: 'audio/mpeg', binary: true }],
  ['/bgm/HALOFLUX-LICENSE.txt', { file: 'bgm/HALOFLUX-LICENSE.txt', type: 'text/plain; charset=utf-8' }]
]);

const log = (line) => {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
};

function sendJson(res, status, obj, extra = {}) {
  // 客户端提前断开（刷新/切页）时再写头会抛 ERR_HTTP_HEADERS_SENT，面板进程不该因此挂掉。
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(obj, null, 2));
}

function serveStatic(res, entry) {
  const file = path.join(PUBLIC, entry.file);
  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end(`面板文件缺失：public/${entry.file}（console-host 还在跑，桥接无关）`);
    return;
  }
  res.writeHead(200, { 'content-type': entry.type, ...SECURITY_HEADERS });
  res.end(body);
}

/** 探桥接是否还在：任何 HTTP 响应（包括 401）都算「在」，连不上才算下线。 */
function probeBridge() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: BRIDGE_HOST, port: BRIDGE_PORT, path: '/api/health', method: 'GET', timeout: PROBE_TIMEOUT_MS },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function proxyToBridge(req, res, url) {
  const headers = {};
  for (const key of ['content-type', 'accept', 'x-console-token', 'x-agent-token', 'x-agent-call', 'x-forwarded-for', 'user-agent']) {
    if (req.headers[key]) headers[key] = req.headers[key];
  }
  const upstream = http.request(
    { host: BRIDGE_HOST, port: BRIDGE_PORT, path: url.pathname + url.search, method: req.method, headers, timeout: PROXY_TIMEOUT_MS },
    (up) => {
      const outHeaders = {};
      for (const [key, value] of Object.entries(up.headers)) {
        // 桥接自己发的 CSP / 帧限制保留；两个进程都在本地，不重复加。
        outHeaders[key] = value;
      }
      res.writeHead(up.statusCode || 502, outHeaders);
      up.pipe(res);
    }
  );
  upstream.on('timeout', () => {
    upstream.destroy();
    if (!res.headersSent) {
      sendJson(res, 504, { ok: false, offline: true, error: '桥接响应超时（面板还在，机器人可能卡住了）' }, { 'x-console-offline': '1' });
    }
  });
  upstream.on('error', (error) => {
    if (res.headersSent) { res.end(); return; }
    const refused = error && (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH' || error.code === 'ECONNRESET');
    sendJson(res, 503, {
      ok: false,
      offline: true,
      error: refused ? '机器人没在跑（面板还在，桥接 3100 连不上）' : `转发到桥接失败：${error && error.code ? error.code : '未知错误'}`,
      bridge: `http://${BRIDGE_HOST}:${BRIDGE_PORT}`
    }, { 'x-console-offline': '1' });
  });
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  } catch {
    sendJson(res, 400, { ok: false, error: '请求地址不合法' });
    return;
  }
  const pathname = url.pathname;
  if (pathname === '/console-host/health') {
    const bridgeUp = await probeBridge();
    sendJson(res, 200, {
      ok: true,
      host: 'console-host',
      port: PORT,
      bridge: { port: BRIDGE_PORT, up: bridgeUp },
      at: Date.now()
    });
    return;
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204, SECURITY_HEADERS);
    res.end();
    return;
  }
  if (pathname.startsWith('/api/')) {
    proxyToBridge(req, res, url);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: '静态页面只接受 GET' });
    return;
  }
  const entry = PAGES.get(pathname);
  if (!entry) {
    sendJson(res, 404, { ok: false, error: `没有这个地址：${pathname}` });
    return;
  }
  serveStatic(res, entry);
});

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    log(`端口 ${PORT} 已被占用（可能已有一份 console-host 在跑），本次退出`);
    process.exit(0);
  }
  log(`console-host 出错：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`console-host 已在 http://${HOST}:${PORT} 上跑，/api/* 转发到 http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
});
