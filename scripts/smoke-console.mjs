#!/usr/bin/env node
// 前端真浏览器冒烟：起一个无头 Chromium，把控制台每个页面真点一遍，收集
// ① JS 异常 / console.error ② 4xx·5xx 请求 ③ 页面级错误框 ④ 横向溢出 ⑤ 空页
//
// 为什么需要它：静态断言（700+ 条正则）能挡住「代码里没有这个函数」，挡不住
// 「点了会抛异常 / 接口 500 / 页面空白」——这些只有真跑一遍才知道。
//
// 零依赖：直接用 Node 内置 WebSocket 说 CDP 协议（Chrome/Edge 都支持），
// 不装 puppeteer。找不到浏览器就跳过（exit 0），不阻塞回归。
//
// 用法：
//   node scripts/smoke-console.mjs                  # 全部页面
//   node scripts/smoke-console.mjs --only=logs,memory
//   node scripts/smoke-console.mjs --headed --keep  # 有头 + 保留浏览器窗口（调试用）
//   node scripts/smoke-console.mjs --json           # 机器可读
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3100';
const TOKEN_FILE = path.join(ROOT, 'state', 'console-token');

// 每页给多少毫秒等它把数据拉回来（logs 要拉 8 个会话的最近消息，最慢）
const SETTLE_MS = {
  dashboard: 1200,
  sessions: 2600,
  persona: 1600,
  memory: 2200,
  slang: 1600,
  stickers: 2600,
  library: 1800,
  lists: 1400,
  routing: 1600,
  logs: 4200,
  ops: 1800,
  settings: 1400
};

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* 忽略无权限的路径 */ }
  }
  return '';
}

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

// ── 极简 CDP 客户端：一个 WebSocket、一个 id 计数器、一条事件回调 ──────────
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.onEvent = () => {};
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (event) => reject(new Error(`CDP 连接失败：${event?.message || 'unknown'}`)));
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ' · ' + msg.error.data : ''}`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) this.onEvent(msg);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }

  close() {
    try { this.ws.close(); } catch { /* 已经关了 */ }
  }
}

async function waitForDevtools(proc) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('浏览器 10 秒内没打开调试端口')), 10000);
    proc.stderr.on('data', (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`浏览器提前退出（code=${code}）：${buffer.slice(-400)}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const asJson = args.has('--json');
  const headed = args.has('--headed');
  const only = [...args].find((a) => a.startsWith('--only='));
  const onlyViews = only ? only.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean) : null;

  const browserPath = findBrowser();
  if (!browserPath) {
    console.log('ℹ 没找到 Chrome/Edge，跳过浏览器冒烟（可用 CHROME_PATH 指定）');
    return 0;
  }

  const token = readToken();
  const base = BASE.replace(/\/$/, '');
  // 探活：桥接没起就直接跳过，避免把「服务没开」算成前端问题。
  // 静态页本身也要控制台令牌（不带 token 会 401），所以带上；没有 token 就探 401 也算「桥接活着」。
  try {
    const probeUrl = token ? `${base}/client?token=${encodeURIComponent(token)}` : `${base}/client`;
    const probe = await fetch(probeUrl, { redirect: 'manual' });
    if (!probe.ok) throw new Error(String(probe.status));
  } catch (error) {
    console.log(`ℹ 桥接没在 ${base} 上跑（${error?.message || error}），跳过浏览器冒烟`);
    return 0;
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-smoke-'));
  const chromeArgs = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-gpu',
    '--window-size=1440,900',
    'about:blank'
  ];
  if (!headed) chromeArgs.unshift('--headless=new');

  const proc = spawn(browserPath, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  const results = [];
  let cdp = null;
  let sessionId = null;

  try {
    const wsUrl = await waitForDevtools(proc);
    cdp = new Cdp(wsUrl);
    await cdp.ready;

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = attached.sessionId;

    // 收集诊断信息：异常 / console.error / 4xx·5xx / 加载失败
    let bucket = null;
    cdp.onEvent = (msg) => {
      const p = msg.params || {};
      if (msg.method === 'Runtime.exceptionThrown') {
        const detail = p.exceptionDetails || {};
        const text = detail.exception?.description || detail.text || '未知异常';
        if (bucket) bucket.errors.push(`异常：${String(text).split('\n')[0]}`);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
        const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        if (bucket) bucket.errors.push(`console.error：${text}`.slice(0, 300));
        return;
      }
      if (msg.method === 'Log.entryAdded' && p.entry && p.entry.level === 'error') {
        const text = p.entry.text || p.entry.url || '';
        if (bucket) bucket.errors.push(`日志错误：${text}`.slice(0, 300));
        return;
      }
      if (msg.method === 'Network.responseReceived' && p.response) {
        const status = Number(p.response.status) || 0;
        const url = String(p.response.url || '');
        if (status >= 400 && bucket && url.startsWith(base)) bucket.badResponses.push(`${status} ${url.replace(base, '')}`);
        return;
      }
      if (msg.method === 'Network.loadingFailed' && p.errorText && bucket) {
        if (p.errorText.includes('ERR_ABORTED') || p.canceled) return;
        bucket.errors.push(`请求失败：${p.errorText} ${String(p.type || '')}`);
      }
    };

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);

    const evaluate = async (expression) => {
      const out = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      }, sessionId);
      if (out.exceptionDetails) {
        throw new Error(`页面求值失败：${out.exceptionDetails.text} ${out.exceptionDetails.exception?.description || ''}`);
      }
      return out.result?.value;
    };

    // 打开带令牌的首页：页面会把 token 存进 localStorage，后续同源导航不用再带
    const landing = token
      ? `${base}/client?token=${encodeURIComponent(token)}`
      : `${base}/client`;
    await cdp.send('Page.navigate', { url: landing }, sessionId);
    // 等导航真正渲染出来（client.js 用 defer，慢机器上固定 sleep 会误判「页面空白」）
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      const ok = await evaluate("!!document.querySelector('.qdb-nav-item[data-view]')").catch(() => false);
      if (ok) break;
    }
    await sleep(500);

    const tokenStored = await evaluate("(localStorage.getItem('consoleToken') || '').length > 0");
    if (token && !tokenStored) throw new Error('页面没能把控制台令牌存进 localStorage');

    const navViews = await evaluate(
      "Array.from(document.querySelectorAll('.qdb-nav-item[data-view]')).map(b => b.getAttribute('data-view'))"
    );
    const views = (onlyViews || navViews || []).filter(() => true);
    const missing = (onlyViews || []).filter((v) => !(navViews || []).includes(v));
    if (missing.length) throw new Error(`导航里没有这些页面：${missing.join(', ')}`);

    for (const view of views) {
      let shape = null;
      let failures = [];
      // 桥接刚重启的冷启动窗口里，首屏接口还在排队，固定 settle 会误判「内容块 0」：
      // 首轮失败就重点一次并补等 4s 再看（最多两次），别把冷启动抖动报成页面坏掉。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        bucket = { errors: [], badResponses: [] };
        await evaluate(`document.querySelector('.qdb-nav-item[data-view="${view}"]')?.click()`);
        await sleep(attempt === 0 ? (SETTLE_MS[view] || 1500) : 4000);
        shape = await evaluate(`(() => {
          const sec = document.querySelector('section[data-page="${view}"]');
          const visible = !!sec && !sec.hidden;
          const errs = sec ? Array.from(sec.querySelectorAll('.qdb-error')).length : 0;
          const errText = sec ? Array.from(sec.querySelectorAll('.qdb-error-title')).map(n => n.textContent.trim()).slice(0, 3) : [];
          const overflow = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
          const textLen = sec ? (sec.innerText || '').trim().length : 0;
          const rows = sec ? sec.querySelectorAll('.qdb-panel, .qdb-card, .qdb-stat, table, .qdb-msg').length : 0;
          return { visible, errs, errText, overflow, textLen, rows };
        })()`);
        failures = [];
        if (!shape.visible) failures.push('页面没显示');
        if (shape.errs) failures.push(`错误框 ${shape.errs} 个：${shape.errText.join(' / ')}`);
        if (shape.overflow > 2) failures.push(`横向溢出 ${shape.overflow}px`);
        if (shape.textLen < 20) failures.push('页面几乎空白');
        if (shape.rows === 0) failures.push('没有任何内容块');
        if (bucket.errors.length) failures.push(...bucket.errors.slice(0, 4));
        if (bucket.badResponses.length) failures.push(...bucket.badResponses.slice(0, 4));
        if (!failures.length) break;
      }
      results.push({ view, ok: !failures.length, failures, rows: shape.rows, textLen: shape.textLen });
    }

    // 拆出来的静态资源必须免令牌且真能取到（<link>/<script> 带不上 x-console-token）
    for (const asset of ['/client.css', '/client.js']) {
      bucket = { errors: [], badResponses: [] };
      let status = 0;
      let contentType = '';
      try {
        const res = await fetch(`${base}${asset}`);
        status = res.status;
        contentType = String(res.headers.get('content-type') || '');
      } catch (error) {
        bucket.errors.push(`请求失败：${error?.message || error}`);
      }
      const failures = [];
      if (status !== 200) failures.push(`HTTP ${status}（应为 200，且不应要求令牌）`);
      const wants = asset.endsWith('.css') ? 'text/css' : 'javascript';
      if (contentType && !contentType.includes(wants)) failures.push(`content-type=${contentType}（应含 ${wants}）`);
      if (bucket.badResponses.length) failures.push(...bucket.badResponses.slice(0, 2));
      results.push({ view: asset, ok: !failures.length, failures, rows: 0, textLen: status });
    }

    // 另外两个独立页面：/ops 与 / （/ 在新版里也是客户端页）
    for (const route of ['/ops', '/']) {
      bucket = { errors: [], badResponses: [] };
      const routeUrl = token
        ? `${base}${route}${route.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
        : `${base}${route}`;
      await cdp.send('Page.navigate', { url: routeUrl }, sessionId);
      await sleep(2200);
      const shape = await evaluate(`(() => ({
        title: document.title || '',
        textLen: (document.body?.innerText || '').trim().length,
        errs: document.querySelectorAll('.qdb-error, .err, .error').length,
        overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth)
      }))()`);
      const failures = [];
      if (shape.textLen < 20) failures.push('页面几乎空白');
      if (shape.overflow > 2) failures.push(`横向溢出 ${shape.overflow}px`);
      if (bucket.errors.length) failures.push(...bucket.errors.slice(0, 4));
      if (bucket.badResponses.length) failures.push(...bucket.badResponses.slice(0, 4));
      results.push({ view: route, ok: !failures.length, failures, rows: 0, textLen: shape.textLen });
    }
  } finally {
    try { cdp?.close(); } catch { /* 忽略 */ }
    try { proc.kill(); } catch { /* 忽略 */ }
    if (!args.has('--keep')) {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (asJson) {
    console.log(JSON.stringify({ base, browser: path.basename(browserPath), results, failed: failed.length }, null, 2));
  } else {
    for (const row of results) {
      const label = row.ok ? 'ok  ' : 'FAIL';
      console.log(`  ${label} ${row.view.padEnd(10)} 内容块 ${String(row.rows).padStart(3)} ｜ 文本 ${String(row.textLen).padStart(5)} 字${row.ok ? '' : '  ⟵ ' + row.failures.join(' ; ')}`);
    }
    console.log(`\n========== 通过 ${results.length - failed.length} / 失败 ${failed.length} ==========`);
  }
  return failed.length ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`浏览器冒烟失败：${error?.message || error}`);
    process.exitCode = 1;
  });
