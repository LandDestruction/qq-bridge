// 系统打开链接（POST /api/open-url）：控制台里点 BOOTH 链接时交给系统默认浏览器。
//
// 为什么要有白名单：这个接口等于「让本机执行一次打开动作」。如果放开任意 URL，它就成了
// 钓鱼/SSRF 的跳板（诱导管理员点一下，弹出一个仿冒 BOOTH 的登录页），甚至能借系统默认
// 浏览器去开 file:// / javascript: 之类。所以协议只认 https://、域名只认
// booth.pm / booth.pximg.net 及其子域，其它一律 400。
//
// 本文件是 manifest 模块（被 scripts/bridge-source.mjs 用 vm 裸执行），**不能 import**：
// URL 来自 deps.URL，进程能力来自 deps.spawn（测试注入假 spawn 即可断言传给系统的 URL）。
//
// 日志：state/open-url.log（时间 + host + 脱敏后的路径）。查询串里的 token/session 一类
// 参数值打码，避免把登录令牌写进长期日志。

const OPENURL_MAX_LEN = 1000;
const OPENURL_PATH = '/api/open-url';
// 白名单：条目本身 + 它的所有子域（accounts.booth.pm 自然包含在 *.booth.pm 里）。
const OPENURL_ALLOWED_HOSTS = Object.freeze(['booth.pm', 'booth.pximg.net']);
const OPENURL_LOG_FILE = 'open-url.log';
// 参数名里带这些词的，值一律打码（不区分大小写）。
const OPENURL_SECRET_PARAM_RE = /(?:token|secret|session|auth|sig|signature|key|password|pwd|code|credential)/i;
// 名字不认识、但值长得就像令牌（长串 base64/hex）的也打码。
const OPENURL_TOKENY_VALUE_RE = /^[A-Za-z0-9_\-.]{24,}$/;

/** host 是否命中白名单（含子域）。`booth.pm.evil.com` 不算，`evil-booth.pm` 也不算。 */
function openUrlHostAllowed(host) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  return OPENURL_ALLOWED_HOSTS.some((base) => h === base || h.endsWith(`.${base}`));
}

/** path + query，敏感参数值打码；日志只写这个，不写整条原始链接。 */
function openUrlLogPath(u) {
  const pairs = [];
  try {
    for (const [name, value] of u.searchParams.entries()) {
      const masked = OPENURL_SECRET_PARAM_RE.test(name) || OPENURL_TOKENY_VALUE_RE.test(value) ? '***' : value;
      pairs.push(`${name}=${masked}`);
    }
  } catch { /* 查询串解析失败就只留路径，不把原文塞进日志 */ }
  const search = pairs.length ? `?${pairs.join('&')}` : '';
  return `${u.pathname || '/'}${search}`;
}

/** 追加一行打开记录。写日志失败只记日志，不影响「已经打开了」这个事实。 */
function openUrlLog(deps, urlText) {
  try {
    const u = new deps.URL(urlText);
    const line = `${new Date().toISOString()} ${u.host} ${openUrlLogPath(u)}\n`;
    const dir = String(deps.STATE_DIR || 'state');
    deps.fs.mkdirSync(dir, { recursive: true });
    deps.fs.appendFileSync(deps.path.join(dir, OPENURL_LOG_FILE), line, 'utf8');
  } catch (error) {
    deps.log(`打开链接日志写盘失败：${error?.message ?? error}`);
  }
}

/** 校验：类型/长度/空白/协议/域名。返回 {ok:true,url}（用 new URL 归一化后）或 {ok:false,error}。 */
function openUrlCheck(deps, raw) {
  if (typeof raw !== 'string') return { ok: false, error: '请传 url（字符串）' };
  const text = raw.trim();
  if (!text) return { ok: false, error: 'url 不能为空' };
  if (raw.length > OPENURL_MAX_LEN) return { ok: false, error: `链接太长（最多 ${OPENURL_MAX_LEN} 字符）` };
  if (/[\u0000-\u001f\u007f]/.test(raw) || /\s/.test(text)) {
    return { ok: false, error: '链接里不能有空白或控制字符' };
  }
  let u = null;
  try {
    u = new deps.URL(text);
  } catch {
    return { ok: false, error: '链接格式不对，解析失败' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: `只允许打开 https:// 链接（收到的是 ${u.protocol}）` };
  // 端口收紧：只放默认端口（:443 会被 URL 归一成空串）。放任意端口等于允许拿这个接口去探内网服务。
  if (u.port !== '' && u.port !== '443') {
    return { ok: false, error: `只允许默认端口打开链接（收到的是 ${u.port} 端口）` };
  }
  if (!openUrlHostAllowed(u.hostname)) {
    return { ok: false, error: `不在允许打开的站点白名单里：${u.hostname}（只允许 booth.pm / booth.pximg.net 及其子域）` };
  }
  // 末尾点（`booth.pm.`）与 `booth.pm` DNS 等价：允许打开，但把 host 归一化掉再返回，
  // 免得日志/回显里带着一个看起来像另一个域名的写法。
  if (u.hostname.endsWith('.')) u.hostname = u.hostname.replace(/\.+$/, '');
  return { ok: true, url: u.href };
}

/** 交给系统默认浏览器。spawn 不可用就抛错（调用方回 500），不要静默假装打开了。 */
function openUrlLaunch(deps, url) {
  if (typeof deps.spawn !== 'function') throw new Error('这台机器上打不开浏览器（spawn 不可用）');
  const platform = typeof process !== 'undefined' && process.platform ? process.platform : 'win32';
  if (platform === 'win32') {
    // cmd /c start "" "url"：第一个空参数是窗口标题；带 & 的 URL 必须整体加引号并原样交给 cmd。
    const child = deps.spawn('cmd.exe', ['/c', 'start', '""', `"${url}"`], {
      detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true
    });
    if (child && typeof child.unref === 'function') child.unref();
    return;
  }
  const cmd = platform === 'darwin' ? 'open' : 'xdg-open';
  const child = deps.spawn(cmd, [url], { detached: true, stdio: 'ignore' });
  if (child && typeof child.unref === 'function') child.unref();
}

function buildOpenUrl(deps) {
// @bridge-function handleConsoleOpenUrl:start
  async function handleConsoleOpenUrl(request) {
    const { req, url, sendJson } = request;
    // 只处理自己那条路径：console-server 的 POST 兜底链会依次问多个 handler，
    // 不判路径就会把 /api/open-folder 的请求当成「缺 url」先答掉（真机踩过）。
    if (url.pathname !== OPENURL_PATH) return false;
    // 打开 URL 属于「能让本机产生动作」的管理端操作：智能体一律 403。
    if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
      sendJson({ ok: false, error: '未授权：打开链接是管理端操作' }, 403);
      return true;
    }
    if (req.method !== 'POST') { sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }

    let body = null;
    try {
      body = await request.readBody();
    } catch (error) {
      sendJson({ ok: false, error: error?.message ?? '请求体非法' }, 400);
      return true;
    }

    const checked = openUrlCheck(deps, body && body.url);
    if (!checked.ok) { sendJson({ ok: false, error: checked.error }, 400); return true; }

    try {
      openUrlLaunch(deps, checked.url);
    } catch (error) {
      deps.log(`打开链接失败：${error?.message ?? error}`);
      sendJson({ ok: false, error: `打开失败：${error?.message ?? error}` }, 500);
      return true;
    }
    openUrlLog(deps, checked.url);
    sendJson({ ok: true, url: checked.url });
    return true;
  }
// @bridge-function handleConsoleOpenUrl:end
  return { handleConsoleOpenUrl };
}

export function createOpenUrl(deps) {
  return buildOpenUrl(deps);
}
