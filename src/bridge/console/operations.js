// console/operations: extracted bridge responsibilities; no startup side effects.
// Live dependencies: AbortSignal, ROOT, STATE_DIR, api, atomicWriteJson, budgetRunnerInstance, buildWakePromptV2, canonicalV2Key, cfg, clearTimeout, closedAgentPreset, configReloadCount, configWatcher, currentMode, dshReady, fetch, fs, inPeakWindow, lastConfigReloadAt, lastConfigReloadSkipped, log, path, peakCfg, peakPauseActive, peakPauseLogged, peakStatusView, promptPartsSnapshots, readActivityTail, readRoleState, reloadConfigFromDisk, setTimeout, snowlumaHealthSnapshot, socialV2, startConfigWatcher, state, sttService, unwrap, updateConfigFile
// 上游两家的面板地址：点仪表盘卡片就直接开这两个页面看细节（端口是各自安装时的默认值）。
const UPSTREAM_UI = { wb2api: "http://127.0.0.1:7863/panel", snowluma: "http://127.0.0.1:5099/" };
// wb2api 的 /v1/models 要 key：桥接没配 dsh.authToken 时，退回读它自己安装目录里的 config.json
// （和启动 VBS 同一套路径推导）；只用来探测模型清单，不落盘、不进日志。
function readWb2Key(deps) {
  // 两种布局都试：仓库同级（../default-workspace）与上两级（../../default-workspace）。
  const roots = [deps.path.join(deps.ROOT, "..", "default-workspace"), deps.path.join(deps.ROOT, "..", "..", "default-workspace")];
  for (const root of roots) {
    try {
      const key = JSON.parse(deps.fs.readFileSync(deps.path.join(root, "_wb", "wb2api", "config.json"), "utf8"))?.api_key;
      if (typeof key === "string" && key.trim()) return key.trim();
    } catch {}
  }
  return "";
}
function wbAuthOption(deps) {
  const token = String(deps.cfg.dsh?.authToken || "") || readWb2Key(deps);
  return token ? { headers: { authorization: `Bearer ${token}` } } : {};
}
// 从两家探活返回里捞出卡片要显示的东西：SnowLuma 的登录账号、wb2api 的模型清单。
function upstreamExtras(cfg, snowText, wbText, snowUrl) {
  let account = { nickname: null, userId: null };
  let models = [];
  try {
    const login = JSON.parse(snowText)?.data;
    account = { nickname: login?.nickname ?? null, userId: login?.user_id ?? null };
  } catch {}
  try { models = (JSON.parse(wbText)?.data ?? []).map((m) => m.id).filter(Boolean); } catch {}
  return { account, models, ui: UPSTREAM_UI, endpoints: { http: snowUrl, ws: String(cfg.snowluma?.wsUrl || "") } };
}

// 客户端静态资源的构建号（public/client.js 的 mtime + 大小）：只给「页面是不是旧版本」用，
// 不暴露路径。桌面客户端与浏览器标签常年不刷新时，页面里的 JS 会和服务器最新数据口径对不上
// （表情库「用得最多」「可用/不可用」两边不一致就是这么来的）。
function clientBuildOf(deps) {
  try {
    const file = deps.path.join(deps.ROOT, "public", "client.js");
    const st = deps.fs.statSync(file);
    return `${Math.round(st.mtimeMs)}-${st.size}`;
  } catch {
    return "";
  }
}

// 机器人自检（九组）：POST /api/self-check 跑一次只读体检并落 state/self-check-last.json；
// GET /api/self-check/last 取最近一次。放在模块作用域 + 显式传 deps，是为了不撑大
// createConsoleOperations / handleConsoleOperations —— 规模闸对这两个函数只许变小（D56）。
// 会话级主体（x-agent-*）一律 403：结果里有群号与路径，不给模型看。
async function handleConsoleSelfCheck(request, deps) {
  if (request.req.headers['x-agent-token'] || request.req.headers['x-agent-call'] !== undefined) {
    request.sendJson({ ok: false, error: '未授权：自检结果含群号与路径，不对会话级主体开放' }, 403);
    return true;
  }
  const lastFile = deps.path.join(deps.STATE_DIR, 'self-check-last.json');
  if (request.req.method === 'GET') {
    let cached = null;
    try { cached = JSON.parse(deps.fs.readFileSync(lastFile, 'utf8')); } catch { cached = null; }
    if (!cached) {
      request.sendJson({ ok: false, error: '还没有自检记录：先点「自检」或 POST /api/self-check' }, 404);
      return true;
    }
    request.sendJson({ ok: true, cached: true, report: cached });
    return true;
  }
  try {
    const report = await (0, deps.selfCheckRun)({ fix: false });
    (0, deps.atomicWriteJson)(lastFile, report);
    request.sendJson({ ok: true, report });
  } catch (error) {
    request.sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
  }
  return true;
}

// 静态页分派（/、/ops、/library、/client）住在 console/static-pages.js，这里只负责拿到它。
// 为什么是**惰性动态 import** 而不是顶层 import：src/bridge/** 的模块会被审计沙箱用
// vm.runInContext 逐段执行（scripts/bridge-source.mjs installBridgeModules），顶层 import 在
// 非模块上下文里是 SyntaxError，会让整个 VM 套件在加载期就炸；动态 import 在真实 ESM 里等价，
// 而沙箱里只在真去请求静态页时才失败 —— 失败也只记一行日志，不假装页面已返回。
let staticPagesModule = null;
let staticPagesLoadFailed = false;
async function loadStaticPages(deps) {
  if (staticPagesModule) return staticPagesModule;
  if (staticPagesLoadFailed) return null;
  try {
    staticPagesModule = await import('./static-pages.js');
    return staticPagesModule;
  } catch (error) {
    staticPagesLoadFailed = true;
    (0, deps.log)(`[console] 静态页模块加载失败（/、/ops、/library、/client 将不可用）：${error?.message ?? error}`);
    return null;
  }
}

// 客户端外壳拆分出的静态资源：public/client.css、public/client.js，
// 外加设置页「更新日志」用的 public/changelog.js（scripts/make-changelog.mjs 从 git log 生成）。
// 只认这张表里的固定文件名 —— 路径绝不拼用户输入，从根上排除目录穿越；
// 文件缺失回可读 404，绝不回 200 空响应（浏览器会把空 CSS/JS 当成功缓存）。
// Cache-Control 用 no-cache（开发期改前端要能立刻生效）；SECURITY_HEADERS 里自带 no-store，
// 用同名键覆盖它，避免同一响应出现两条不同的 Cache-Control。
const STATIC_ASSETS = new Map([
  ['/client.css', { file: 'client.css', type: 'text/css; charset=utf-8' }],
  ['/client.js', { file: 'client.js', type: 'text/javascript; charset=utf-8' }],
  ['/changelog.js', { file: 'changelog.js', type: 'text/javascript; charset=utf-8' }],
  // 默认背景音乐（scripts/make-bgm.mjs 自己合成的那段）。音频是二进制，必须 binary:true ——
  // 下面按 utf8 读会把字节替换成 U+FFFD，浏览器拿到的是坏文件。
  ['/bgm/default-tune.mp3', { file: 'bgm/default-tune.mp3', type: 'audio/mpeg', binary: true }],
  // 第二首内置曲与它的授权原文：HALOFLUX 主题曲（作者 Ryder191，PolyForm Noncommercial 1.0.0，
  // 只允许非商业使用，必须保留声明与署名）。授权原文一起发出去，别人拿到安装包也能看到条款。
  ['/bgm/haloflux-sw421k.mp3', { file: 'bgm/haloflux-sw421k.mp3', type: 'audio/mpeg', binary: true }],
  ['/bgm/HALOFLUX-LICENSE.txt', { file: 'bgm/HALOFLUX-LICENSE.txt', type: 'text/plain; charset=utf-8' }]
]);
function serveStaticAsset(request, deps, asset) {
  const headers = { ...request.SECURITY_HEADERS, 'content-type': asset.type, 'Cache-Control': 'no-cache' };
  let body;
  try {
    const filePath = deps.path.join(deps.ROOT, 'public', asset.file);
    body = asset.binary ? deps.fs.readFileSync(filePath) : deps.fs.readFileSync(filePath, 'utf8');
  } catch {
    request.res.writeHead(404, { ...request.SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
    request.res.end(`静态资源缺失：qq-bridge/public/${asset.file}（client.html 拆分后的 CSS/JS 未随页面一起部署）\n`);
    return true;
  }
  request.res.writeHead(200, headers);
  request.res.end(body);
  return true;
}

// 静态页与拆分资源共用一次 GET 分派。逻辑放模块作用域 + 显式 deps，
// handleConsoleOperations 里只留一行调用（规模闸 D56：那个函数只许变小）。
async function serveStaticPagesOrAssets(request, deps) {
  if (request.req.method !== 'GET') return false;
  const asset = STATIC_ASSETS.get(request.url.pathname);
  if (asset) return serveStaticAsset(request, deps, asset);
  const pages = await loadStaticPages(deps);
  const page = pages ? pages.staticPageFor(request.url.pathname) : null;
  if (page) return pages.serveStaticPage(request, deps, page);
  return false;
}

// 客户端外壳顶栏的版本号：唯一真源是 package.json 的 version，读一次缓存住（不改 /api/status 的返回面）。
let packageVersionCache;
function packageVersion(deps) {
  if (packageVersionCache !== undefined) return packageVersionCache;
  try {
    const raw = JSON.parse(deps.fs.readFileSync(deps.path.join(deps.ROOT, 'package.json'), 'utf8'));
    packageVersionCache = String(raw?.version ?? '').trim() || null;
  } catch {
    packageVersionCache = null; // 读不到就是读不到，前端显示「未知」，绝不编一个版本号
  }
  return packageVersionCache;
}

// 访客版 /api/status：只回「跑没跑」，不含 ownerQQ / 白名单 / activity / 上游诊断。
// 单独放模块级是为了不把 handleConsoleOperations 顶过冻结基线。
function guestStatusView(deps) {
  let connected = false;
  try { connected = (0, deps.snowlumaHealthSnapshot)().connected === true; } catch { connected = false; }
  return {
    guest: true,
    mode: deps.currentMode,
    dshReady: deps.dshReady === true,
    socialV2Paused: deps.socialV2.paused === true,
    snowluma: { connected }
  };
}

async function dispatchDebugRoutes(request, deps) {
  // 调试：上下文预算的计数与最近动作（D51）。只读；带 agent 头一律拒绝（含群号，属管理侧信息）。
  if (request.req.method === 'GET' && request.url.pathname === '/api/debug/budget') {
    if (request.req.headers['x-agent-token'] || request.req.headers['x-agent-call'] !== undefined) {
      request.sendJson({ ok: false, error: '未授权：预算计数含群号，不对会话级主体开放' }, 403);
      return true; /* @bridge-handled */
    }
    request.sendJson({ ok: true, ...(0, deps.budgetRunnerInstance)().snapshot() });
    return true; /* @bridge-handled */
  }
  if (request.url.pathname.startsWith('/api/self-check')) return handleConsoleSelfCheck(request, deps);
  // 调试：上一轮唤醒提示各段落的字符数（用来决定砍哪里）。
  if (request.req.method === 'GET' && request.url.pathname === '/api/debug/prompt-parts') {
    // 按 key **现算**：只构建提示词，不投递、不写 state。
    // 旧实现读 globalThis.__dshPromptParts —— 不认 key（返回"最后一个构建的"）、重启后归零（假红）、
    // 没有时间戳；主窗口据此把好功能判成没上线过（D38）。
    // 鉴权沿用控制台令牌（本服务统一入口），不改成 agent token；**只返回 name+chars**，
    // prompt 正文含会话令牌/跨会话摘要/人设，绝不外带。
    const rawKey = String(request.url.searchParams.get('key') ?? '').trim();
    if (!rawKey) {
      request.sendJson({ ok: false, code: 'bad_key', error: '必须带 ?key=group:群号 或 ?key=private:QQ号：本接口按 key 现算，不猜“最后构建的那个会话”' }, 400);
      return true; /* @bridge-handled */
    }
    const ppKey = (0, deps.canonicalV2Key)(rawKey);
    if (!ppKey) { request.sendJson({ ok: false, code: 'bad_key', error: `无效的会话 key：${rawKey}` }, 400); return true; /* @bridge-handled */ }
    const cached = deps.promptPartsSnapshots.get(ppKey) ?? null;
    const emptyHint = { comparedWith: null, lastBuiltAt: null, lastTotal: null, delta: null, note: '没有任何可对比的真实构建记录' };
    // 没有会话状态就不构建：buildWakePromptV2 里的 getSocialV2State 会顺手造一份，
    // 那是调试接口不该有的隐蔽副作用。
    if (!deps.socialV2.conversations.get(ppKey)) {
      request.sendJson({
        ok: true, key: ppKey, mode: 'none', total: 0, parts: [], builtAt: null,
        reason: '还没有这个会话的状态（key 写错，或这个会话从未收过消息）', hint: emptyHint
      });
      return true; /* @bridge-handled */
    }
    let liveParts = null;
    let liveError = '';
    try {
      const capture = {};
      // reason='debug' + dryRun：跳过 bootstrap 专属段（initialPrompt / handoff 会消费交接摘要）。
      (0, deps.buildWakePromptV2)(ppKey, 'debug', { dryRun: true, capture });
      liveParts = Array.isArray(capture.parts) ? capture.parts : null;
    } catch (error) {
      liveError = String(error?.message ?? error);
    }
    if (liveParts) {
      const total = liveParts.reduce((n, p) => n + (Number(p.chars) || 0), 0);
      const parts = liveParts.filter((p) => p.chars > 0).sort((a, b) => b.chars - a.chars);
      request.sendJson({
        ok: true, key: ppKey, mode: 'live', total, parts, builtAt: Date.now(), reason: 'debug',
        excluded: ['initialPrompt', 'handoff'],
        reasonText: parts.length ? '' : '这次现算出来全是空段：该会话还没有可注入的内容（没消息/没角色/没摘要）',
        hint: {
          comparedWith: cached ? 'last-real-build' : null,
          lastBuiltAt: cached?.builtAt ?? null,
          lastTotal: cached?.total ?? null,
          delta: cached ? total - cached.total : null,
          note: cached ? '与最近一次真实构建（将被投递的那份）相比' : '还没有真实构建记录可对比'
        }
      });
      return true; /* @bridge-handled */
    }
    if (cached) {
      request.sendJson({
        ok: true, key: ppKey, mode: 'cached', total: cached.total, parts: cached.parts,
        builtAt: cached.builtAt, reason: cached.reason,
        reasonText: `现算失败，退回最近一次真实构建的快照：${liveError || '未知原因'}`,
        hint: { comparedWith: null, lastBuiltAt: cached.builtAt, lastTotal: cached.total, delta: 0, note: '这是快照，不是本次现算' }
      });
      return true; /* @bridge-handled */
    }
    request.sendJson({
      ok: true, key: ppKey, mode: 'live', total: 0, parts: [], builtAt: null,
      reason: `现算失败：${liveError || '未知原因'}，且没有可回落的快照`, hint: emptyHint
    });
    return true; /* @bridge-handled */
  }

  return false;
}

async function dispatchOpsRoutes(request, deps) {
  if (request.req.method === 'GET' && request.url.pathname === '/api/ops/services') {
    const probeJson = async (url, opts = {}) => {
      const t0 = Date.now();
      try {
        const r = await (0, deps.fetch)(url, { signal: deps.AbortSignal.timeout(2500), ...opts });
        const text = await r.text().catch(() => "");
        return { ok: r.status < 500, status: r.status, ms: Date.now() - t0, text };
      } catch (error) {
        return { ok: false, ms: Date.now() - t0, error: String(error?.message ?? error).slice(0, 100) };
      }
    };
    const dshUrl = String(deps.cfg.dsh?.baseUrl || "");
    const snowUrl = String(deps.cfg.snowluma?.httpUrl || "").replace(/\/+$/, "");
    const [dsh, snow, wb2, tts] = await Promise.all([
      dshUrl ? probeJson(dshUrl + "/") : { ok: false, error: "未配置 dsh.baseUrl" },
      snowUrl ? probeJson(snowUrl + '/get_login_info', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {}) },
        body: '{}'
      }) : { ok: false, error: "未配置 snowluma.httpUrl" },
      probeJson("http://127.0.0.1:7863/v1/models", wbAuthOption(deps)),
      probeJson("http://127.0.0.1:8765/health")
    ]);
    const up = upstreamExtras(deps.cfg, snow.text, wb2.text, snowUrl);
    const snowNick = up.account.nickname;
    let ttsOk = false;
    try { ttsOk = JSON.parse(tts.text)?.ok === true; } catch {}
    request.sendJson({
      ok: true,
      services: [
        { id: "bridge", name: "bridge", ok: true, detail: `PID ${process.pid} · ${deps.currentMode} · :${request.boundPort}`, supervision: "计划任务 QQBridge-Bridge", actions: ["restart"] },
        { id: "dsh", name: "DSH", ok: dsh.ok, detail: dshUrl || "未配置", supervision: "桌面应用（面板不自动重启）", actions: [] },
        { id: "snowluma", name: "SnowLuma", ok: snow.ok, detail: snowNick ? `已登录 ${snowNick}` : (snow.error || `HTTP ${snow.status}`), supervision: "计划任务 QQBridge-SnowLuma", actions: ["start", "stop", "restart"],
          ui: up.ui.snowluma, uiLabel: "打开 SnowLuma 面板", account: up.account, endpoints: up.endpoints },
        { id: "wb2api", name: "WorkBuddy2API", ok: wb2.ok, detail: "127.0.0.1:7863" + (wb2.ok ? "" : `（${wb2.error || wb2.status}）`), supervision: "VBS 守护（无计划任务）", actions: ["start", "stop", "restart"],
          ui: up.ui.wb2api, uiLabel: "打开 WorkBuddy2API 面板", models: up.models, defaultModel: String(deps.cfg.dsh?.model || ""), provider: String(deps.cfg.dsh?.provider || "") },
        { id: "localtts", name: "LocalTTS", ok: ttsOk, detail: ttsOk ? "127.0.0.1:8765 正常" : (tts.error || `HTTP ${tts.status}`), supervision: "计划任务 LocalTTS", actions: ["start", "stop", "restart"] }
      ]
    });
    return true; /* @bridge-handled */
  }

  // 启停：只允许白名单服务；DSH 不给按钮（桌面应用，硬杀会丢窗口/登录态）。
  if (request.req.method === 'POST' && request.url.pathname === '/api/ops/action') {
    const body = await request.readBody();
    const service = String(body.service ?? "").trim();
    const action = String(body.action ?? "").trim();
    const TASKS = { bridge: "QQBridge-Bridge", snowluma: "QQBridge-SnowLuma", localtts: "LocalTTS" };
    if (service === "dsh") { request.sendJson({ ok: false, error: "DSH 是桌面应用，面板不自动重启；请手动关掉再打开（地址会变，bridge 会自动重连）" }, 400); return true; /* @bridge-handled */ }
    if (!["start", "stop", "restart"].includes(action)) { request.sendJson({ ok: false, error: "action 必须是 start/stop/restart" }, 400); return true; /* @bridge-handled */ }
    const { spawn } = await import("node:child_process");
    // 启停服务改成**异步**：以前 spawnSync 跑 PowerShell（20s 超时）会把整个桥接冻住，
    // 期间 QQ 收发与发送队列全停 —— 点一下控制台按钮，群里就静默半分钟。
    const run = (cmd, args) => new Promise((resolve) => {
      let out = "";
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      let child;
      try {
        child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        done({ ok: false, out: String(error?.message ?? error).slice(0, 200) });
        return;
      }
      const timer = (0, deps.setTimeout)(() => { try { child.kill(); } catch {} done({ ok: false, out: `超时（20s）` }); }, 20000);
      if (child.stdout) child.stdout.on("data", (c) => { out += c.toString("utf8"); });
      if (child.stderr) child.stderr.on("data", (c) => { out += c.toString("utf8"); });
      child.on("error", (error) => { (0, deps.clearTimeout)(timer); done({ ok: false, out: String(error?.message ?? error).slice(0, 200) }); });
      child.on("close", (code) => { (0, deps.clearTimeout)(timer); done({ ok: code === 0, out: out.trim().slice(0, 200) }); });
    });
    const pidsOf = async (name) => {
      const r = await run("powershell", ["-NoProfile", "-Command", `(Get-Process -Name ${name} -ErrorAction SilentlyContinue).Id -join ','`]);
      return String(r.out || "").split(",").map((x) => Number(x.trim())).filter((n) => n > 0);
    };
    const results = [];
    if (service === "wb2api") {
      if (action !== "start") {
        for (const pid of await pidsOf("wb2api")) results.push({ step: `kill ${pid}`, ...(await run("taskkill", ["/F", "/PID", String(pid)])) });
      }
      if (action !== "stop") {
        const vbs = deps.path.join(deps.ROOT, "..", "..", "default-workspace", "_wb", "run-wb2api-hidden.vbs");
        spawn("wscript.exe", [vbs], { detached: true, stdio: "ignore" }).unref();
        results.push({ step: "启动 VBS 守护", ok: true, out: vbs });
      }
    } else {
      const task = TASKS[service];
      if (!task) { request.sendJson({ ok: false, error: "未知服务" }, 400); return true; /* @bridge-handled */ }
      if (action !== "start") results.push({ step: `schtasks /end ${task}`, ...(await run("schtasks", ["/end", "/tn", task])) });
      if (action !== "stop") results.push({ step: `schtasks /run ${task}`, ...(await run("schtasks", ["/run", "/tn", task])) });
    }
    (0, deps.log)(`[ops] ${service} ${action} → ${results.map((r) => `${r.step}:${r.ok ? "ok" : "fail"}`).join(" | ")}`);
    request.sendJson({ ok: results.every((r) => r.ok), service, action, results });
    return true; /* @bridge-handled */
  }

  if (request.req.method === 'GET' && request.url.pathname === '/api/ops/status') {
    const probe = async (url, pathname = '/') => {
      const t0 = Date.now();
      try {
        const r = await (0, deps.fetch)(url.replace(/\/+$/, '') + pathname, { signal: deps.AbortSignal.timeout(3000) });
        return { ok: r.status < 500, status: r.status, ms: Date.now() - t0 };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error).slice(0, 120) };
      }
    };
    const dshUrl = String(deps.cfg.dsh?.baseUrl || '');
    const snowUrl = String(deps.cfg.snowluma?.httpUrl || '');
    const dshProbe = dshUrl ? await probe(dshUrl) : { ok: false, error: '未配置 dsh.baseUrl' };
    let snow = { ok: false, error: '未配置 snowluma.httpUrl', url: snowUrl };
    if (snowUrl) {
      const t0 = Date.now();
      try {
        // 与 bridge 自己调用 OneBot 的方式一致：HTTP + Bearer accessToken
        const r = await (0, deps.fetch)(snowUrl.replace(/\/+$/, '') + '/get_login_info', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {}) },
          body: '{}',
          signal: deps.AbortSignal.timeout(3000)
        });
        const body = await r.json().catch(() => ({}));
        const info = body?.data ?? {};
        snow = {
          ok: r.ok && body?.status === 'ok',
          status: r.status,
          ms: Date.now() - t0,
          nickname: info.nickname ?? null,
          userId: info.user_id ?? null,
          url: snowUrl,
          ...(r.ok && body?.status === 'ok' ? {} : { error: String(body?.wording || `HTTP ${r.status}`).slice(0, 120) })
        };
      } catch (error) {
        snow = { ok: false, url: snowUrl, error: String(error?.message ?? error).slice(0, 120) };
      }
    }
    let logLines = [];
    try {
      const raw = deps.fs.readFileSync(deps.path.join(deps.STATE_DIR, 'bridge.log'), 'utf8');
      logLines = raw.split('\n').filter(Boolean).slice(-60);
    } catch {}
    request.sendJson({
      ok: true,
      bridge: {
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        mode: deps.currentMode,
        port: request.boundPort,
        sessions: Object.keys(deps.state.sessions || {}).length,
        conversations: deps.socialV2.conversations.size
      },
      dsh: { url: dshUrl, ...dshProbe },
      snowluma: snow,
      log: logLines
    });
    return true; /* @bridge-handled */
  }

  return false;
}

async function dispatchStatusRoute(request, deps) {
  if (request.req.method === 'GET' && request.url.pathname === '/api/status') {
    const rs = (0, deps.readRoleState)();
    if (request.consoleRole === 'guest') { request.sendJson(guestStatusView(deps)); return true; /* @bridge-handled */ }
    // 带 agent token 的调用来自 QQ 群里的 AI：只能拿到它自己该知道的运行状态。
    // activity 是**全局**收发摘要（含其它群的发言片段与告警），ownerQQ/白名单属于管理信息，
    // 都不能给到会话级主体，否则 A 群的 AI 能读到 B 群的内容。
    // 判定「是不是智能体调用」必须同时看 x-agent-call：无令牌的智能体调用
    // （旧只读工具的模式探测）不带 x-agent-token，但它同样**绝不能**拿到管理端字段
    // —— ownerQQ / 白名单 / activity（含其它群的发言片段）是跨群管理信息。
    // 只认 token 会让这类请求落到下面的完整对象上，等于把 A 群的 AI 变成管理端。
    if (request.req.headers['x-agent-token'] || request.req.headers['x-agent-call'] !== undefined) {
      request.sendJson({
        mode: deps.currentMode,
        role: rs.role ?? null,
        roleMode: rs.mode ?? 'active',
        dshReady: deps.dshReady,
        socialV2Paused: deps.socialV2.paused,
      });
      return true; /* @bridge-handled */
    }
    request.sendJson({
      mode: deps.currentMode,
      closedAgentPreset: deps.closedAgentPreset,
      role: rs.role ?? null,
      roleMode: rs.mode ?? 'active',
      dshReady: deps.dshReady,
      // G：停于何时也一起给出去，卡片上就能写「停于 N 分钟前」而不是干巴巴一个「已停止」。
      socialV2PausedSince: Number(deps.socialV2.pausedSince) || 0,
      ownerQQ: deps.cfg.ownerQQ ?? null,
      allowGroups: deps.cfg.allow?.groups ?? [],
      allowPrivate: deps.cfg.allow?.private ?? [],
      privateOpen: deps.cfg.allow?.privateOpen === true,
      privateQuotaDailyMinutes: deps.cfg.socialV2?.privateQuota?.dailyMinutes ?? 120,
      socialV2Paused: deps.socialV2.paused,
      // 上游健康只给操作者看：它包含网关诊断信息（good/hint），
      // 属于管理侧观测，不该进 QQ 会话里那个受限的智能体视图。
      // 身份锁：当前登录号是否在允许名单里（锁定后一条 QQ 消息都不会发）。
      identityLock: deps.identityLock ?? null,
      snowluma: (0, deps.snowlumaHealthSnapshot)(),
      // 视频语音观测：常驻转写服务是否在跑、用的模型、上次加载/耗时。
      sttService: deps.sttService.status(),
      peakLocal: (() => { try { return (0, deps.peakStatusView)(); } catch (error) { (0, deps.log)(`[峰值] status 视图失败：${error?.message ?? error}`); return null; } })(),
      configReload: { enabled: deps.cfg.socialV2?.hotReload?.enabled === true, watching: Boolean(deps.configWatcher), count: deps.configReloadCount, lastAt: deps.lastConfigReloadAt },
      // D51 上下文预算的可观测计数：checks/recycles/skipsSessionMismatch/lastPct/lastKey/lastAt…
      // 只给操作者视图（带 agent 头的那条分支在更上面 return，拿不到这些）。
      budget: (0, deps.budgetRunnerInstance)().snapshot(),
      activity: (0, deps.readActivityTail)(100)
    });
    return true; /* @bridge-handled */
  }
  return false;
}

export function createConsoleOperations(deps) {
// @bridge-function handleConsoleOperations:start
async function handleConsoleOperations(request) {
        // 静态页面（/、/ops、/library、/client）与拆分出的静态资源（/client.css、/client.js）统一分派。
        if (await serveStaticPagesOrAssets(request, deps)) return;
        // 客户端外壳（public/client.html）顶栏要显示的版本与本机 QQ：只读、仅管理端。
        // 带 x-agent-* 一律 403 —— 机器人自己的 QQ 号与构建版本属管理侧信息，不给会话级主体。
        if (request.req.method === 'GET' && request.url.pathname === '/api/version') {
          if (request.req.headers['x-agent-token'] || request.req.headers['x-agent-call'] !== undefined) {
            request.sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
            return true; /* @bridge-handled */
          }
          request.sendJson({
            ok: true,
            version: packageVersion(deps),
            clientBuild: clientBuildOf(deps),
            selfId: deps.botSelfIdCache || null,
            pid: process.pid,
            uptimeSec: Math.round(process.uptime())
          });
          return true; /* @bridge-handled */
        }
        // 运维面板数据：只读、只回本机可控的运行时信息（不含任何消息内容）。
        // 五服务状态：bridge / DSH / SnowLuma / wb2api / LocalTTS。
        // 高峰期暂停：查状态 / 开关。
        // 配置热加载：改完 config.json 不必重启进程（端口/连接类字段仍会提示需要重启）。
        if (request.req.method === 'POST' && request.url.pathname === '/api/config/reload') {
          const result = (0, deps.reloadConfigFromDisk)('api');
          if (result.ok) {
            try { (0, deps.startConfigWatcher)(); } catch {}
            request.sendJson({ ok: true, changed: result.changed, skipped: result.skipped, unchanged: result.unchanged, count: deps.configReloadCount, at: deps.lastConfigReloadAt });
          } else {
            request.sendJson({ ok: false, error: result.error }, 400);
          }
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'GET' && request.url.pathname === '/api/config/reload') {
          request.sendJson({
            ok: true,
            enabled: deps.cfg.socialV2?.hotReload?.enabled === true,
            watching: Boolean(deps.configWatcher),
            count: deps.configReloadCount,
            lastAt: deps.lastConfigReloadAt,
            lastSkipped: deps.lastConfigReloadSkipped
          });
          return true; /* @bridge-handled */
        }

        if (request.url.pathname === '/api/peak/status') {
          const c = (0, deps.peakCfg)();
          const pc = deps.cfg.socialV2?.peakPause || {}; const expired = Number(pc.validYear) > 0 && new Date().getFullYear() > Number(pc.validYear);
          request.sendJson({ ok: true, enabled: c.enabled, schedule: c.schedule, windows: c.windows, inWindow: (0, deps.inPeakWindow)(), active: (0, deps.peakPauseActive)(), validYear: pc.validYear || null, updatedAt: pc.updatedAt || '', expired, serverTime: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/peak/toggle') {
          const body = await request.readBody();
          deps.cfg.socialV2 = deps.cfg.socialV2 || {};
          deps.cfg.socialV2.peakPause = { ...(deps.cfg.socialV2.peakPause || {}), enabled: body.enabled === true };
          try {
            (0, deps.updateConfigFile)(deps.path.join(deps.ROOT, 'config.json'), (raw) => {
              raw.socialV2 = raw.socialV2 || {};
              raw.socialV2.peakPause = { ...(raw.socialV2.peakPause || {}), enabled: body.enabled === true };
            }, { atomicWrite: deps.atomicWriteJson });
          } catch (error) { (0, deps.log)('[峰值] 写配置失败:', error?.message ?? error); }
          deps.peakPauseLogged = false;
          (0, deps.log)(`[峰值] 高峰期暂停 → ${body.enabled === true ? '开启' : '关闭'}`);
          request.sendJson({ ok: true, enabled: body.enabled === true, inWindow: (0, deps.inPeakWindow)(), active: (0, deps.peakPauseActive)() });
          return true; /* @bridge-handled */
        }

        if (await dispatchDebugRoutes(request, deps)) return true; /* @bridge-handled */
        if (await dispatchOpsRoutes(request, deps)) return true; /* @bridge-handled */
        if (await dispatchStatusRoute(request, deps)) return true; /* @bridge-handled */
        if (request.req.method === 'GET' && request.url.pathname === '/api/presets') {
          let presets = [];
          try {
            const { presets: list } = (0, deps.unwrap)(await deps.api.agentPresets.list({}), 'agentPreset.list');
            presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
          } catch {}
          request.sendJson({ presets });
          return true; /* @bridge-handled */
        }
    return false;
  }
// @bridge-function handleConsoleOperations:end
  return { handleConsoleOperations };
}
