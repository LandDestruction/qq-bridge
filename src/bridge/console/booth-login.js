// 已购库「登录 BOOTH 自动抓 Cookie」：开一个带远程调试端口的浏览器窗口，用户在里面登录，
// 后台用 CDP 把 Cookie 捞出来 → 先拿它请求一次已购清单页验证真的登录成功了 → 再写进现有 Cookie 库。
//
// 设计取舍：
//  - 用持久 profile（state/booth-login-profile）：下次点登录不用再登一遍。profile 是浏览器数据，
//    这里除了 Cookie 什么都不读，也不往安装包里打包（state/ 已被排除）。
//  - 不在这里跑同步：前端看到 succeeded 后自己调 POST /api/library/purchases/sync，
//    「同步」只有一条入口（Cookie 存进库以后，同步/下载/清单解析全复用已有链路）。
//  - Cookie 明文绝不进响应与日志：响应只给 maskedCookieKey（账号 key 前 8 位）与长度，
//    日志同样只打 key —— 这个窗口是本机管理端专用，凭据不该出现在任何回显里。
//  - 状态机：idle → launching → waiting → succeeded / failed / cancelled。失败一律给人话，
//    超时 5 分钟；用户手动关窗口也算失败（不是静默卡住）。
//
// VM-safe：零 import。浏览器/网络/WebSocket/端口全走 deps 注入，测试用假浏览器即可。
// 拆成模块级 helper + 薄工厂，是因为 code-size 闸门不允许单个函数超过 300 行。

const BLOGIN_PROFILE_DIRNAME = 'booth-login-profile';
const BLOGIN_PROFILE_LABEL = `state/${BLOGIN_PROFILE_DIRNAME}`;
const BLOGIN_COOKIE_FILE = 'booth-cookies.json';
const BLOGIN_LIBRARY_URL = 'https://accounts.booth.pm/library';
const BLOGIN_TIMEOUT_MS = 300000; // 5 分钟没登完就放弃，别让后台循环一直挂着
const BLOGIN_POLL_MS = 1500;
const BLOGIN_CDP_READY_MS = 20000;
const BLOGIN_CDP_CALL_MS = 5000;
const BLOGIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BLOGIN_WAIT_HINT = '请在打开的浏览器窗口里完成 BOOTH 登录（登录成功会自动继续）';
const BLOGIN_SYNC_HINT = 'Cookie 已保存，回去点「同步已购」就能拉清单';
const BLOGIN_TIMEOUT_ERROR = '等了 5 分钟还没登录成功，再试一次';
const BLOGIN_CLOSED_ERROR = '登录窗口被关掉了';
const BLOGIN_EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BLOGIN_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];
const BLOGIN_RUNNING_STATES = ['launching', 'waiting'];

function boothLoginSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

// ── 路径与浏览器发现（全部延迟读 deps：构造工厂时不能碰桩） ─────────
function boothLoginProfileDir(deps) {
  return deps.path.join(String(deps.STATE_DIR), BLOGIN_PROFILE_DIRNAME);
}

function boothLoginCookiePath(deps) {
  return deps.path.join(String(deps.STATE_DIR), BLOGIN_COOKIE_FILE);
}

function boothLoginFindBrowser(deps) {
  const custom = String((deps.cfg && deps.cfg.boothLoginBrowser) || '').trim();
  const exists = (file) => { try { return Boolean(deps.fs.existsSync(file)); } catch { return false; } };
  if (custom && exists(custom)) return { browser: 'custom', exe: custom };
  for (const exe of BLOGIN_EDGE_PATHS) if (exists(exe)) return { browser: 'edge', exe };
  for (const exe of BLOGIN_CHROME_PATHS) if (exists(exe)) return { browser: 'chrome', exe };
  return null;
}

// 让系统分一个空闲端口：先 listen(0) 拿端口再关掉，比在 9222 上撞端口可靠。
async function boothLoginFreePort(deps) {
  const net = deps.net;
  if (!net || typeof net.createServer !== 'function') return 9222;
  return await new Promise((resolve) => {
    const server = net.createServer();
    const done = (port) => { try { server.close(() => resolve(port)); } catch { resolve(port); } };
    server.once('error', () => done(9222));
    server.listen(0, '127.0.0.1', () => {
      let port = 9222;
      try { port = Number(server.address().port) || 9222; } catch { /* 拿不到就用默认 */ }
      done(port);
    });
  });
}

function boothLoginLaunch(deps, exe, port) {
  if (typeof deps.spawn !== 'function') throw new Error('运行环境没有 spawn，起不了浏览器');
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${boothLoginProfileDir(deps)}`,
    '--no-first-run',
    '--no-default-browser-check',
    BLOGIN_LIBRARY_URL
  ];
  return deps.spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
}

// Windows 上直接 kill 只杀得掉启动器进程，窗口还在：用 taskkill /T 连子进程一起收。
function boothLoginCloseBrowser(deps, proc) {
  if (!proc) return;
  const pid = Number(proc.pid) || 0;
  const isWin = typeof process !== 'undefined' && process.platform === 'win32';
  if (isWin && pid > 0 && typeof deps.spawn === 'function') {
    try { deps.spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); return; } catch { /* 退回普通 kill */ }
  }
  try { if (typeof proc.kill === 'function') proc.kill(); } catch { /* 已经退出了 */ }
}

// ── CDP：拿页面目标、调一次协议方法 ─────────────────────────
async function boothLoginCdpJson(deps, target) {
  const fetchImpl = typeof deps.cdpFetch === 'function' ? deps.cdpFetch : deps.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('运行环境没有 fetch，连不上浏览器调试端口');
  const res = await fetchImpl(target);
  if (!res || !res.ok) throw new Error(`调试端口回了 HTTP ${Number(res && res.status) || 0}`);
  return await res.json();
}

function boothLoginWsClass(deps) {
  const WS = deps.WebSocket || (typeof globalThis !== 'undefined' ? globalThis.WebSocket : null);
  if (typeof WS !== 'function') throw new Error('这个运行环境没有 WebSocket，抓不到浏览器 Cookie');
  return WS;
}

function boothLoginCdpCall(deps, wsUrl, method) {
  const WS = boothLoginWsClass(deps);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let ws = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (ws && typeof ws.close === 'function') ws.close(); } catch { /* 关闭失败不影响结果 */ }
      if (error) reject(error); else resolve(value);
    };
    timer = setTimeout(() => finish(new Error(`浏览器调试接口没回话（${method} 超时）`)), BLOGIN_CDP_CALL_MS);
    try { ws = new WS(wsUrl); } catch (error) { finish(error); return; }
    ws.onopen = () => {
      try { ws.send(JSON.stringify({ id: 1, method, params: {} })); } catch (error) { finish(error); }
    };
    ws.onerror = () => finish(new Error('连不上浏览器的调试通道'));
    ws.onmessage = (event) => {
      const raw = typeof event?.data === 'string' ? event.data : '';
      let data = null;
      try { data = JSON.parse(raw); } catch { return; }
      if (!data || data.id !== 1) return;
      if (data.error) finish(new Error(String(data.error.message || '浏览器调试接口报错')));
      else finish(null, data.result || {});
    };
  });
}

async function boothLoginCdpCookies(deps, port) {
  const targets = await boothLoginCdpJson(deps, `http://127.0.0.1:${port}/json/list`);
  const pages = Array.isArray(targets) ? targets.filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl) : [];
  const target = pages.find((t) => /booth\.pm/i.test(String(t.url))) || pages[0];
  if (!target) return [];
  for (const method of ['Storage.getCookies', 'Network.getAllCookies']) {
    try {
      const result = await boothLoginCdpCall(deps, target.webSocketDebuggerUrl, method);
      if (Array.isArray(result.cookies)) return result.cookies;
    } catch { /* 换个协议方法再试 */ }
  }
  return [];
}

function boothLoginJoinCookies(list) {
  const parts = [];
  for (const item of Array.isArray(list) ? list : []) {
    const domain = String((item && item.domain) || '').replace(/^\./, '').toLowerCase();
    const okDomain = domain === 'booth.pm' || domain.endsWith('.booth.pm')
      || domain === 'booth.pximg.net' || domain.endsWith('.booth.pximg.net');
    const name = String((item && item.name) || '');
    if (!okDomain || !name) continue;
    parts.push(`${name}=${String((item && item.value) || '')}`);
  }
  return parts.join('; ');
}

// ── 验证与落盘 ──────────────────────────────────────────────
async function boothLoginValidateCookie(deps, cookie) {
  const fetchImpl = typeof deps.fetch === 'function' ? deps.fetch : null;
  if (!fetchImpl) return { ok: false, reason: '运行环境没有 fetch，验证不了登录状态' };
  let res = null;
  try {
    res = await fetchImpl(BLOGIN_LIBRARY_URL, { headers: { cookie, 'user-agent': BLOGIN_UA, referer: 'https://booth.pm/' } });
  } catch (error) {
    return { ok: false, reason: `验证请求没发出去：${String(error?.message ?? error)}` };
  }
  const httpStatus = Number(res && res.status) || 0;
  if (!res || !res.ok) return { ok: false, reason: `验证请求回了 HTTP ${httpStatus || '网络错误'}` };
  const finalUrl = String((res && res.url) || BLOGIN_LIBRARY_URL);
  const body = typeof res?.text === 'function' ? await res.text() : '';
  const pure = deps.boothDownloadPure || {};
  if (typeof pure.isSignedOut === 'function') {
    const verdict = pure.isSignedOut({ status: httpStatus, finalUrl, body });
    if (verdict && verdict.out) return { ok: false, reason: String(verdict.reason || 'Cookie 像没登录') };
  }
  if (/name=["']?password["']?/i.test(body) && /<form/i.test(body)) return { ok: false, reason: '取回的页面还是登录表单' };
  return { ok: true, reason: '' };
}

function boothLoginSaveCookie(deps, cookie) {
  const pure = deps.boothDownloadPure || {};
  if (typeof pure.setCookieAccount !== 'function') return { ok: false, reason: 'Cookie 库没接上（boothDownloadPure 没注入）' };
  let store = {};
  try { store = JSON.parse(deps.fs.readFileSync(boothLoginCookiePath(deps), 'utf8')); } catch { store = {}; }
  const result = pure.setCookieAccount(store, cookie, { note: 'BOOTH 登录窗口自动抓取', now: Date.now() });
  if (!result || result.ok !== true) return { ok: false, reason: String((result && result.reason) || 'Cookie 格式不对') };
  deps.atomicWriteJson(boothLoginCookiePath(deps), result.store);
  try { deps.fs.chmodSync(boothLoginCookiePath(deps), 0o600); } catch { /* Windows 上没意义 */ }
  return { ok: true, key: String(result.key || '') };
}

export function createBoothLogin(deps) {
  const status = {
    state: 'idle', startedAt: 0, browser: '', port: 0, error: '', hint: '',
    maskedCookieKey: '', cookieSaved: false, syncHint: ''
  };
  let runId = 0;
  let child = null;

  // 时序参数延迟读：测试注入 boothLoginTiming 把 5 分钟/1.5s 压到毫秒级。
  function timing() {
    const raw = { ...(deps.boothLoginTiming || {}) };
    return {
      timeoutMs: Number(raw.timeoutMs) > 0 ? Number(raw.timeoutMs) : BLOGIN_TIMEOUT_MS,
      pollMs: Number(raw.pollMs) > 0 ? Number(raw.pollMs) : BLOGIN_POLL_MS,
      cdpReadyMs: Number(raw.cdpReadyMs) > 0 ? Number(raw.cdpReadyMs) : BLOGIN_CDP_READY_MS
    };
  }

  function running() {
    return BLOGIN_RUNNING_STATES.indexOf(status.state) >= 0;
  }

  function log(line) {
    if (typeof deps.log === 'function') deps.log(`[BOOTH登录] ${line}`);
  }

  function statusJson() {
    const view = {
      ok: true,
      state: status.state,
      startedAt: status.startedAt,
      elapsedMs: status.startedAt > 0 ? Math.max(0, Date.now() - status.startedAt) : 0,
      browser: status.browser,
      profileDir: BLOGIN_PROFILE_LABEL,
      maskedCookieKey: status.maskedCookieKey,
      cookieSaved: status.cookieSaved,
      syncHint: status.syncHint,
      error: status.error
    };
    if (status.state === 'waiting') view.hint = BLOGIN_WAIT_HINT;
    return view;
  }

  function closeBrowser() {
    const proc = child;
    child = null;
    boothLoginCloseBrowser(deps, proc);
  }

  function failWith(message) {
    status.state = 'failed';
    status.error = String(message || '登录失败');
    status.hint = '';
    closeBrowser();
    log(`失败：${status.error}`);
  }

  async function loginLoop(rid, port) {
    try {
      // 1) 等调试端口可用（浏览器冷启动要一两秒，最多 20s）。
      const readyDeadline = Date.now() + timing().cdpReadyMs;
      let ready = false;
      while (Date.now() < readyDeadline) {
        if (rid !== runId) return; // 被 stop/重启取代
        try { await boothLoginCdpJson(deps, `http://127.0.0.1:${port}/json/version`); ready = true; break; } catch { await boothLoginSleep(300); }
      }
      if (!ready) { failWith('浏览器没起来（调试端口连不上），可能被杀毒软件拦了，换个浏览器或重试'); return; }
      if (rid !== runId) return;
      status.state = 'waiting';
      status.hint = BLOGIN_WAIT_HINT;
      log(`等待登录（调试端口 ${port}，profile ${BLOGIN_PROFILE_LABEL}）`);

      // 2) 每 1.5s 捞一次 Cookie，捞到就验证；验证不过继续等（用户可能还没点完登录）。
      const deadline = status.startedAt + timing().timeoutMs;
      while (rid === runId && status.state === 'waiting') {
        if (Date.now() > deadline) { failWith(BLOGIN_TIMEOUT_ERROR); return; }
        let cookies = [];
        try { cookies = await boothLoginCdpCookies(deps, port); } catch { cookies = []; } // 浏览器启动瞬间连不上属正常
        const cookie = boothLoginJoinCookies(cookies);
        if (cookie) {
          const verdict = await boothLoginValidateCookie(deps, cookie);
          if (rid !== runId) return;
          if (verdict.ok) {
            const saved = boothLoginSaveCookie(deps, cookie);
            if (!saved.ok) { failWith(`Cookie 没能保存：${saved.reason}`); return; }
            status.maskedCookieKey = saved.key.slice(0, 8);
            status.cookieSaved = true;
            status.syncHint = BLOGIN_SYNC_HINT;
            status.state = 'succeeded';
            status.hint = '';
            closeBrowser();
            log(`成功：Cookie 已写入 ${saved.key.slice(0, 8)}…（${cookie.length} 字节）`);
            return;
          }
          log(`捞到 Cookie 但验证没过：${verdict.reason}`);
        }
        await boothLoginSleep(timing().pollMs);
      }
    } catch (error) {
      if (rid !== runId) return;
      failWith(String(error?.message ?? error) || '登录过程出错');
    }
  }
// @bridge-function handleConsoleBoothLogin:start
  async function handleConsoleBoothLogin(request) {
    const { req, url, sendJson, readBody } = request;
    if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
      sendJson({ ok: false, error: '未授权：登录 BOOTH 是管理端操作' }, 403);
      return true;
    }
    const p = url.pathname;

    if (p === '/api/library/purchases/login/status' && req.method === 'GET') {
      sendJson(statusJson());
      return true;
    }

    if (p === '/api/library/purchases/login/stop' && req.method === 'POST') {
      if (!running()) { sendJson({ ok: false, error: '现在没有在等登录' }, 409); return true; }
      runId += 1;
      status.state = 'cancelled';
      status.hint = '';
      status.error = '';
      closeBrowser();
      log('已取消登录');
      sendJson({ ok: true, state: 'cancelled' });
      return true;
    }

    if (p === '/api/library/purchases/login/start' && req.method === 'POST') {
      if (running()) { sendJson({ ok: false, error: '正在等登录：先在那个浏览器窗口里完成登录，或者先点取消' }, 409); return true; }
      try { await readBody(); } catch { /* 这个接口不需要参数，空体/坏体都无妨 */ }
      const found = boothLoginFindBrowser(deps);
      if (!found) { sendJson({ ok: false, error: '没找到能用的浏览器（Edge 或 Chrome）' }, 400); return true; }
      try { deps.fs.mkdirSync(boothLoginProfileDir(deps), { recursive: true }); } catch { /* 已存在 */ }
      let port = 9222;
      try { port = await boothLoginFreePort(deps); } catch { port = 9222; }
      let proc = null;
      try { proc = boothLoginLaunch(deps, found.exe, port); } catch (error) {
        status.state = 'failed';
        status.error = `浏览器起不来：${String(error?.message ?? error)}`;
        sendJson({ ok: false, error: status.error }, 500);
        return true;
      }
      runId += 1;
      const rid = runId;
      child = proc;
      status.state = 'launching';
      status.startedAt = Date.now();
      status.browser = found.browser;
      status.port = port;
      status.error = '';
      status.hint = '';
      status.maskedCookieKey = '';
      status.cookieSaved = false;
      status.syncHint = '';
      log(`启动 ${found.browser}（端口 ${port}）`);
      if (proc && typeof proc.on === 'function') {
        proc.on('exit', () => {
          if (rid !== runId) return;
          if (status.state === 'launching' || status.state === 'waiting') failWith(BLOGIN_CLOSED_ERROR);
        });
      }
      loginLoop(rid, port).catch(() => {});
      sendJson({ ok: true, state: 'launching', browser: found.browser, profileDir: BLOGIN_PROFILE_LABEL });
      return true;
    }

    return false;
  }
// @bridge-function handleConsoleBoothLogin:end
// @bridge-function boothLoginStatus:start
  function boothLoginStatus() {
    return statusJson();
  }
// @bridge-function boothLoginStatus:end

  return { handleConsoleBoothLogin, boothLoginStatus };
}
