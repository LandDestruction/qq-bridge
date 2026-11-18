// BOOTH 已购 / 免费下载的纯规则层（P4 第一切片）。
//
// 为什么先做纯规则：真正发请求、写盘、断点续传的那部分必须跑在桥接里（且有网络副作用），
// 而「Cookie 怎么存、清单页怎么翻、断点怎么续、什么情况算失效」这些判断如果混在里面，
// 出问题只能靠肉眼猜。所以规则全部做成无副作用函数，单测先钉死，桥接侧只负责调用。
//
// 注意：这个文件是 ESM，供 src/bridge.js 与 scripts/*.mjs 直接 import；
// 桥接的 vm 模块不能用 import，需要时按既有做法用 deps.boothDownloadPure 注入。

export const DOWNLOAD_RULES_VERSION = 1;

// ── Cookie ────────────────────────────────────────────────────────────
// 只接受 `k=v; k2=v2` 这种形状：粘贴 Cookie 头时经常带着 "Cookie:" 前缀或换行，
// 这里一并清掉；超过 8KB 或出现换行的直接判坏（宁可让人重贴，也不要把脏数据写盘）。
export const COOKIE_MAX_BYTES = 8192;

export function normalizeCookie(raw) {
  let text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: false, reason: 'Cookie 是空的', cookie: '' };
  if (Buffer.byteLength(text, 'utf8') > COOKIE_MAX_BYTES) return { ok: false, reason: 'Cookie 太长（超过 8KB）', cookie: '' };
  text = text.replace(/\r?\n+/g, ' ').trim();
  text = text.replace(/^cookie\s*:\s*/i, '').trim();
  if (/[\r\n]/.test(text)) return { ok: false, reason: 'Cookie 里有换行', cookie: '' };
  const parts = text.split(';').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, reason: 'Cookie 是空的', cookie: '' };
  const seen = new Map();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) return { ok: false, reason: `这段不像 Cookie：${part.slice(0, 24)}`, cookie: '' };
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!/^[\w.-]+$/.test(name)) return { ok: false, reason: `Cookie 名不合法：${name.slice(0, 24)}`, cookie: '' };
    if (/[;\u0000]/.test(value)) return { ok: false, reason: `Cookie 值里有非法字符：${name}`, cookie: '' };
    seen.set(name, value); // 同名后者覆盖：浏览器也是这个行为
  }
  const cookie = Array.from(seen.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  return { ok: true, reason: '', cookie, names: Array.from(seen.keys()) };
}

// 账号标识：Cookie 里最稳定的那个字段。BOOTH 用 _plaza_session_id（老账号可能是
// session_id / _session_id），都没有就用 cookie 的 sha 前缀兜底 —— 这样换账号能分出
// 不同的槽位，又不会把 Cookie 原文写进文件名或日志。
export function accountKeyOf(cookie) {
  const text = String(cookie || '');
  const m = /(?:^|;\s*)(?:_plaza_session_id|_session_id|session_id|_booth_session)=([^;]+)/i.exec(text);
  if (m && m[1].trim()) return 'sid-' + hash32(m[1].trim());
  return 'sha-' + hash32(text);
}

function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Cookie 文件形状：{version, accounts:{<accountKey>:{cookie, savedAt, note}}, current}
export function emptyCookieStore() {
  return { version: DOWNLOAD_RULES_VERSION, current: '', accounts: {} };
}

export function normalizeCookieStore(raw) {
  const out = emptyCookieStore();
  if (!raw || typeof raw !== 'object') return out;
  const accounts = raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {};
  for (const [key, val] of Object.entries(accounts)) {
    if (!/^[a-z]{3}-[0-9a-f]{8}$/.test(String(key))) continue;
    const norm = normalizeCookie(val && val.cookie);
    if (!norm.ok) continue;
    out.accounts[key] = {
      cookie: norm.cookie,
      savedAt: Number(val && val.savedAt) > 0 ? Number(val.savedAt) : 0,
      note: String((val && val.note) || '').slice(0, 60)
    };
  }
  const wanted = String(raw.current || '');
  out.current = out.accounts[wanted] ? wanted : (Object.keys(out.accounts)[0] || '');
  return out;
}

export function setCookieAccount(store, rawCookie, { note = '', now = Date.now() } = {}) {
  const norm = normalizeCookie(rawCookie);
  if (!norm.ok) return { ok: false, reason: norm.reason, store: normalizeCookieStore(store) };
  const next = normalizeCookieStore(store);
  const key = accountKeyOf(norm.cookie);
  next.accounts[key] = { cookie: norm.cookie, savedAt: Number(now) || Date.now(), note: String(note || '').slice(0, 60) };
  next.current = key;
  return { ok: true, reason: '', key, store: next };
}

export function removeCookieAccount(store, key) {
  const next = normalizeCookieStore(store);
  delete next.accounts[String(key || '')];
  if (next.current === String(key || '')) next.current = Object.keys(next.accounts)[0] || '';
  return next;
}

// 回给页面的摘要：**绝不带 cookie 原文**，只给槽位、保存时间、备注、尾号提示。
export function cookieStoreSummary(store) {
  const norm = normalizeCookieStore(store);
  const accounts = Object.entries(norm.accounts).map(([key, val]) => {
    const tail = String(val.cookie).replace(/^.*?=/, '').slice(-4);
    return { key, note: val.note, savedAt: val.savedAt, tail: tail ? `…${tail}` : '', current: key === norm.current };
  }).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  return { version: norm.version, current: norm.current, count: accounts.length, accounts };
}

export function currentCookie(store) {
  const norm = normalizeCookieStore(store);
  const val = norm.accounts[norm.current];
  return val ? val.cookie : '';
}

// ── 登录失效判定 ──────────────────────────────────────────────────────
// 三种信号：被重定向到 sign_in、命中登录表单特征、401/403。
// 注意 SIGN_IN_MARKERS 里的 accounts.booth.pm 只用于「Cookie 是否指向账号站」的旧判定，
// 已购清单现在本身就在 accounts.booth.pm（library-download 的 LIBDL_LIBRARY_URL），不能再当失效信号。
export const SIGN_IN_MARKERS = ['/sign_in', 'signin', 'login'];
export function isSignedOut({ status = 0, finalUrl = '', body = '' } = {}) {
  const url = String(finalUrl || '').toLowerCase();
  // 只认重定向到登录路径（或落到账号站根、还没进清单）：正常的 accounts.booth.pm/library 不算失效。
  if (/\/users\/sign_in|\/sign_in\b|\/signin\b|\/login\b/.test(url) || /^https?:\/\/accounts\.booth\.pm\/?$/.test(url)) return { out: true, reason: '被重定向到登录页（Cookie 可能过期了）' };
  if (status === 401 || status === 403) return { out: true, reason: `接口返回 ${status}（Cookie 无效）` };
  const html = typeof body === 'string' ? body : '';
  if (/name=["']?password["']?/i.test(html) && /<form/i.test(html)) return { out: true, reason: '返回的是登录表单' };
  if (/ログインが必要|请先登录|ログインしてください/.test(html)) return { out: true, reason: '页面提示需要登录' };
  return { out: false, reason: '' };
}

// ── 清单页翻页 ────────────────────────────────────────────────────────
// 防「页码超出后服务器仍回同一页」的死循环：把内容指纹（商品号集合）记住，
// 一页跑下来一个没见过的号都没有就停；同时给页数上限兜底。
export const OWNED_MAX_PAGES = 20;

export function nextPageDecision({ page, maxPages = OWNED_MAX_PAGES, seenIds = [], pageIds = [], hasNext = false } = {}) {
  const pageNo = Number(page) || 1;
  const known = new Set((seenIds || []).map(String));
  const fresh = (pageIds || []).map(String).filter((id) => !known.has(id));
  if (pageNo >= maxPages) return { stop: true, reason: `已翻到第 ${maxPages} 页上限` };
  if (!pageIds || !pageIds.length) return { stop: true, reason: '这一页没有商品' };
  if (!fresh.length) return { stop: true, reason: '这一页全是见过的商品（服务器在重复返回同一页）' };
  if (!hasNext) return { stop: true, reason: '没有下一页了' };
  return { stop: false, reason: '', nextPage: pageNo + 1, fresh };
}

// ── 下载计划 / 断点续传 ───────────────────────────────────────────────
export const DOWNLOAD_STALL_MS = 45000; // 45 秒没有任何字节就判卡住
export const DOWNLOAD_MAX_RETRY = 3;

export function planDownload({ expectedBytes = 0, existingBytes = 0, etag = '', validators = {} } = {}) {
  const total = Number(expectedBytes) > 0 ? Number(expectedBytes) : 0;
  const have = Number(existingBytes) > 0 ? Math.floor(Number(existingBytes)) : 0;
  const sameEtag = Boolean(etag) && String(validators.etag || '') === String(etag);
  // 只有「两边都有 ETag 且不一样」才判远端变了；压根没有 ETag 时不敢下这个结论
  // （否则服务器一旦不给 ETag，所有续传都会被当成「变了」而白白重下整包）。
  const knowsEtag = Boolean(etag) || Boolean(validators.etag);
  if (have > 0 && total > 0 && have === total) return { action: 'reuse', from: have, reason: '文件已经完整' };
  if (have > 0 && total > 0 && have > total) return { action: 'restart', from: 0, reason: '临时文件比目标还大，从头来' };
  if (have > 0 && knowsEtag && !sameEtag) return { action: 'restart', from: 0, reason: '远端文件变了（ETag 不同），从头来' };
  if (have > 0) return { action: 'resume', from: have, reason: `从 ${have} 字节处续传` };
  return { action: 'fresh', from: 0, reason: '新下载' };
}

// 服务器对 Range 的反应：206 续传、200 忽略 Range（整包重下）、416 越界（从头）。
export function interpretRangeResponse({ status, contentRange = '', bytes = 0, expectedBytes = 0 } = {}) {
  const st = Number(status) || 0;
  if (st === 416) return { ok: false, mode: 'restart', reason: '服务器说范围越界，从头下载' };
  if (st === 206) {
    const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(String(contentRange || ''));
    const from = m ? Number(m[1]) : 0;
    return { ok: true, mode: 'resume', from, total: m && m[3] !== '*' ? Number(m[3]) : Number(expectedBytes) || 0, reason: '' };
  }
  if (st === 200) return { ok: true, mode: 'full', from: 0, total: Number(expectedBytes) || Number(bytes) || 0, reason: '服务器忽略了 Range，整包重下' };
  if (st >= 200 && st < 300) return { ok: true, mode: 'full', from: 0, total: Number(expectedBytes) || 0, reason: '' };
  return { ok: false, mode: 'failed', reason: `HTTP ${st}` };
}

export function shouldRetryDownload({ attempt = 1, maxRetry = DOWNLOAD_MAX_RETRY, error = '' } = {}) {
  const n = Number(attempt) || 1;
  if (n >= maxRetry) return { retry: false, reason: '重试次数用完了' };
  if (/404|410/.test(String(error))) return { retry: false, reason: '商品或文件已经不在了' };
  if (/sign_?in|登录/i.test(String(error))) return { retry: false, reason: 'Cookie 失效，先更新 Cookie' };
  return { retry: true, reason: `第 ${n + 1} 次重试` };
}

// 文件名：优先用服务器给的 Content-Disposition 文件名，其次 URL 末段，
// 都取不到就用商品号 + .zip。一律削掉路径分隔符与控制字符（防目录穿越）。
export function safeFileName({ disposition = '', url = '', boothId = '' } = {}) {
  let name = '';
  const cd = String(disposition || '');
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  if (star) {
    try { name = decodeURIComponent(star[1]); } catch { name = star[1]; }
  } else if (plain) {
    name = plain[1];
  }
  if (!name) {
    const path = String(url || '').split('?')[0];
    const tail = path.split('/').filter(Boolean).pop() || '';
    name = tail;
  }
  // 先按路径分段：`../../etc/passwd` 要变成 `etc_passwd`，而不是留下 `.._.._`；
  // 再把 Windows / 控制台不认的字符换掉。
  name = String(name)
    .split(/[\\/]+/)
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('_')
    .replace(/[*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (name.length > 120) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    name = name.slice(0, 120 - ext.length) + ext;
  }
  if (!name) name = `${String(boothId || 'booth').replace(/\D/g, '') || 'booth'}.zip`;
  if (!/\.[A-Za-z0-9]{2,5}$/.test(name)) name += '.zip';
  return name;
}

// ── 清单页解析 ────────────────────────────────────────────────────────
// BOOTH 的已购/免费清单是「下载按钮 + 商品链接」混排。这里只做保守提取：
// 抓 data-product-id / /items/<号> 链接与紧邻的标题文本、下载按钮的 href。
export function parseOwnedListHtml(html) {
  const text = String(html || '');
  const items = new Map();
  const idRe = /(?:data-product-id|data-product_id)=["']?(\d{5,9})|items\/(\d{5,9})/g;
  let m;
  while ((m = idRe.exec(text)) !== null) {
    const id = m[1] || m[2];
    if (id && !items.has(id)) items.set(id, { boothId: id, title: '', downloadUrl: '' });
  }
  for (const [id, item] of items) {
    // 标题：优先 data-product-name（可能被截断），否则取 <a …items/<id>…> 的文本
    const nameRe = new RegExp(`data-product-name=["']([^"']{1,200})["']`, 'i');
    const nameHit = text.match(nameRe);
    if (nameHit && !item.title) item.title = decodeHtml(nameHit[1]);
    const anchorRe = new RegExp(`<a[^>]*href=["']([^"']*items/${id}[^"']*)["'][^>]*>([\\s\\S]{0,300}?)</a>`, 'i');
    const anchor = anchorRe.exec(text);
    if (anchor) {
      if (!item.title) item.title = decodeHtml(stripTags(anchor[2])).trim();
      item.itemUrl = absoluteBoothUrl(anchor[1]);
    }
  }
  // 下载按钮在账号站是 `<div class="js-download-button" data-href="https://booth.pm/downloadables/<id>">`，
  // 链接里不带商品号（downloadables 是另一套 id），只能按 DOM 顺序归属：谁前面最近出现的 items/<号> 就是谁的。
  // 老版清单是 <a href="/dl/<号>/…">，链接自带号，先按号精确配，配不上的再按顺序兜底。
  const dlRe = /items\/(\d{5,9})|(?:href|data-href)=["']([^"']*(?:downloadables|downloads|\/dl\/)[^"']*)["']/gi;
  const downloads = [];
  let lastItemId = '';
  let d;
  while ((d = dlRe.exec(text)) !== null) {
    if (d[1]) { lastItemId = d[1]; continue; }
    const url = absoluteBoothUrl(d[2]);
    if (!url) continue;
    downloads.push(url);
    const byId = Array.from(items.values()).find((it) => !it.downloadUrl && (url.includes('/' + it.boothId + '/') || url.includes('=' + it.boothId) || url.includes('_' + it.boothId)));
    // 精确命中就不动 lastItemId；顺序兜底只认紧跟在某个 items/<号> 之后、中间没再出现别的号的链接。
    if (byId) byId.downloadUrl = url;
    else if (lastItemId && items.has(lastItemId) && !items.get(lastItemId).downloadUrl) {
      items.get(lastItemId).downloadUrl = url;
      lastItemId = '';
    }
  }
  const hasNext = /rel=["']next["']/i.test(text) || /[?&]page=\d+/.test(text);
  const totalHit = /(\d[\d,]*)\s*件/.exec(stripTags(text)) || /(\d+)\s*items?/i.exec(stripTags(text));
  return {
    ids: Array.from(items.keys()),
    items: Array.from(items.values()),
    downloads,
    hasNext,
    total: totalHit ? Number(totalHit[1].replace(/,/g, '')) : 0
  };
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
function decodeHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}
function absoluteBoothUrl(href) {
  const h = String(href || '').trim();
  if (!h) return '';
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith('//')) return 'https:' + h;
  if (h.startsWith('/')) return 'https://booth.pm' + h;
  return '';
}

// 一个总入口：把「计划 + 续传头」拼成一次请求要用的信息，桥接侧照着发就行。
export function buildDownloadRequest({ url, cookie = '', plan = {}, referer = 'https://booth.pm/' } = {}) {
  const headers = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'referer': referer,
    'accept': 'application/octet-stream,application/zip,*/*'
  };
  if (cookie) headers.cookie = cookie;
  if (plan && plan.from > 0) headers.range = `bytes=${plan.from}-`;
  return { url: String(url || ''), headers };
}

export function describeDownloadState({ boothId = '', plan = {}, bytes = 0, total = 0, saved = false } = {}) {
  const have = Number(bytes) || 0;
  const want = Number(total) || 0;
  if (saved) return `已下载 #${boothId} (${formatBytes(have)})`;
  if (want > 0) return `正在下载 #${boothId}: ${formatBytes(have)} / ${formatBytes(want)}`;
  return `正在下载 #${boothId}: ${formatBytes(have)}`;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
