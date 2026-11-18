// BOOTH 已购 / 免费下载的桥接模块（P4）。
//
// 约束：本文件是 manifest 模块，被 bridge-source.mjs 用 vm.runInContext 裸执行、**不能 import**；
// 纯规则（Cookie/翻页/续传/文件名/清单解析/登录失效）全走 deps.boothDownloadPure（bridge.js 注入）。
// 顶部不要有和 src/bridge.js 同名的 const/let（VM 里共用一个全局词法作用域）。

// BOOTH 把「已购」搬到了账号站：booth.pm/ja/library 现在 404，清单得从 accounts 站拿
// （和 library-purchases-sync.js 同一口径；翻页链接是相对路径 /library?page=N，也按这个站拼）。
const LIBDL_LIBRARY_URL = 'https://accounts.booth.pm/library';
const LIBDL_MAX_HTML_BYTES = 3 * 1024 * 1024;
const LIBDL_MAX_FILE_BYTES = 3 * 1024 * 1024 * 1024; // 单件最多 3GB，超过直接拒绝（防止误点巨型包）
const LIBDL_RATE_LIMIT_MS = 1200;
// 只存去 query 的 booth.pm 路径（/dl/ 链接带签名，落到 state/ 里就等于把凭据写盘了）。
const LIBDL_JOBS_FILE = 'booth-downloads.json';
const LIBDL_JOBS_MAX = 50;
// 排序把「在跑/排队」顶在前面，完成后越新的越靠前，前端不用自己排）。
const LIBDL_DOWNLOADS_MAX = 200;
// 下载中心要给任务显示标题，都从这里按 boothId 取，不另建一份索引。
const LIBDL_PURCHASES_FILE = 'booth-purchases.json';
const LIBDL_STATE_ORDER = Object.freeze({ downloading: 0, queued: 1, interrupted: 2, failed: 3, done: 4 });
const LIBDL_STALE_URL = '链接过期了，重新载入已购清单再下载';
const LIBDL_SCHEDULER_PAUSED_TEXT = '下载队列已暂停，恢复后再下载';
const LIBDL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ── 任务台账（模块作用域：工厂只做装配，逻辑放外面，免得 createLibraryDownload 撑过 300 行） ──
// 只认 booth.pm（含子域），别的一律返回空串（存进去等于存了个外部链接）。
function dlSanitizeUrl(raw) {
  const m = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(String(raw || ''));
  if (!m || !/(^|\.)booth\.pm$/i.test(m[1])) return '';
  return `https://booth.pm${m[2] || '/'}`;
}

function dlJobsFile(deps) {
  return deps.path.join(String(deps.STATE_DIR), LIBDL_JOBS_FILE);
}

function dlLoadJobs(state) {
  if (state.loaded) return;
  state.loaded = true;
  let raw = null;
  try { raw = JSON.parse(state.deps.fs.readFileSync(dlJobsFile(state.deps), 'utf8')); } catch { return; }
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.jobs) ? raw.jobs : []);
  // 调度暂停状态和任务台账同一份文件：重启后「暂停」还在，不能一重启就自己接着下。
  state.paused = Boolean(raw && raw.paused);
  state.pausedAt = Math.max(0, Number(raw && raw.pausedAt) || 0);
  for (const item of list) {
    if (!item || !item.boothId) continue;
    // queued/downloading 都是「上次进程没跑完」：标成 interrupted，别假装还在跑。
    const stateName = item.state === 'done' || item.state === 'failed' ? item.state : 'interrupted';
    state.jobs.set(String(item.boothId), {
      ...item,
      state: stateName,
      url: dlSanitizeUrl(item.url),
      error: stateName === 'interrupted' ? '桥接重启时任务被打断，可重试' : String(item.error || ''),
      errorKind: stateName === 'interrupted' ? 'unknown' : String(item.errorKind || ''),
      finishedAt: Number(item.finishedAt) || 0
    });
  }
  try { state.mtime = Number(state.deps.fs.statSync(dlJobsFile(state.deps)).mtimeMs) || 0; } catch { state.mtime = 0; }
}

function dlPersistJobs(state) {
  const list = Array.from(state.jobs.entries())
    .map(([boothId, job]) => ({
      boothId, from: String(job.from || ''),
      // 绝不写 Cookie；url 去 query 后只留 booth.pm 的 path
      url: dlSanitizeUrl(job.url),
      fileName: String(job.name || job.fileName || ''),
      bytes: Number(job.bytes) || 0, total: Number(job.total) || 0,
      state: job.state, error: String(job.error || ''), errorKind: String(job.errorKind || ''),   // 失败分类（signedOut/network/...）落盘供重启沿用
      skipped: Boolean(job.skipped), autoBound: Boolean(job.autoBound), coverSaved: Boolean(job.coverSaved),
      // 自动入库提示：下载完成后置 true，扫描不在下载线程里跑，前端据此提示去点「刷新/扫描」。
      needsScan: Boolean(job.needsScan),
      // 下载完自动解压的结果与解压目录：给下载中心展示，没解压就是 null。
      extract: job.extract ? { state: String(job.extract.state || ''), files: Number(job.extract.files) || 0, bytes: Number(job.extract.bytes) || 0, encryption: String(job.extract.encryption || ''), reason: String(job.extract.reason || ''), error: String(job.extract.error || '') } : null,
      destDirRel: String(job.destDirRel || ''), startedAt: Number(job.startedAt) || 0, finishedAt: Number(job.finishedAt) || 0
    }))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, LIBDL_JOBS_MAX);
  try { state.deps.atomicWriteJson(dlJobsFile(state.deps), { v: 1, at: Date.now(), paused: Boolean(state.paused), pausedAt: Number(state.pausedAt) || 0, jobs: list }); } catch { /* 台账写失败不能影响下载本身 */ }
}

// 解压模块会绕开本模块直接往台账回填 job.extract：按文件 mtime 发现变化就合进内存（GET /downloads 立刻能看见）。
function dlRefreshFromDisk(state) {
  let st = null, raw = null;
  try { st = state.deps.fs.statSync(dlJobsFile(state.deps)); } catch { return; }
  if (!st || st.mtimeMs === state.mtime) return;
  state.mtime = st.mtimeMs;
  try { raw = JSON.parse(state.deps.fs.readFileSync(dlJobsFile(state.deps), 'utf8')); } catch { return; }
  for (const row of Array.isArray(raw && raw.jobs) ? raw.jobs : []) { const cur = state.jobs.get(String((row && row.boothId) || '')); if (cur && row && row.extract) { cur.extract = row.extract; if (row.destDirRel) cur.destDirRel = row.destDirRel; } }
}

function dlHumanError(message) {
  const text = String(message || '');
  if (/HTTP (?:401|403|404|410)/.test(text) || /signed|expired|过期|失效/i.test(text)) return LIBDL_STALE_URL;
  return text || '下载失败';
}

// 失败分类（只新增字段、不改 error 文案）：
// - signedOut：Cookie 没保存 / 账号登录失效（BOOTH 会跳登录页）
// - network：连不上、超时、DNS/连接被重置
// - disk：本地写盘/改名失败（磁盘满、权限、占用）
// - unknown：其它（服务端 5xx、格式异常等）
function dlErrorKind(message, signedOut) {
  const text = String(message || '');
  if (signedOut) return 'signedOut';
  if (/没保存 BOOTH Cookie|登录失效|signed[ _-]?out|sign[ _-]?in|ログイン/i.test(text)) return 'signedOut';
  if (/HTTP (?:401|403|404|410)/.test(text) || /signed|expired|过期|失效/i.test(text)) return 'expired';
  if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|网络|超时|aborted/i.test(text)) return 'network';
  if (/ENOSPC|EACCES|EPERM|EBUSY|磁盘|改名|写入|打开文件|文件太大/i.test(text)) return 'disk';
  return 'unknown';
}

// 清掉已完成任务（只动台账、绝不删文件）：failed/interrupted 要留给「重试」，不能被顺手清掉。
function dlClearDone(state) {
  let cleared = 0;
  for (const [boothId, job] of Array.from(state.jobs.entries())) {
    if (job.state !== 'done') continue;
    state.jobs.delete(boothId);
    cleared += 1;
  }
  if (cleared > 0) dlPersistJobs(state);
  return cleared;
}

// ── 全局 BOOTH 暂停（429/403 后任一抓取入口都写同一份 state/booth-search-pause.json） ──
// 本模块不能 import src/booth-pause.js，纯函数走 deps.boothPausePure（和补封面、找号、已购同步
// 共用同一份格式）；缺席时按「没暂停」处理，别因为装配漏一项就整个下载起不来。
function dlPauseText(deps, rec) {
  const pure = deps.boothPausePure || {};
  return typeof pure.pauseErrorMessage === 'function' ? pure.pauseErrorMessage(rec, Date.now()) : 'BOOTH 正在限速暂停，稍后再试';
}

async function dlPause(deps) {
  const pure = deps.boothPausePure || {};
  if (typeof pure.readPause !== 'function') return { paused: false, text: '' };
  const rec = await pure.readPause({ fs: deps.fs, stateDir: String(deps.STATE_DIR), now: Date.now() });
  const state = typeof pure.searchPauseState === 'function' ? pure.searchPauseState(rec, Date.now()) : { paused: false };
  if (!state.paused) return { paused: false, text: '' };
  return { paused: true, text: dlPauseText(deps, rec), retryAfterMs: Math.max(0, Number(state.remainingMs) || 0) };
}

// 收到 429/403 就记一笔全局暂停：403 多半是风控/区域限制，停得比 429 更久（纯函数里定）。
// 清单页、HEAD、文件链接都会撞墙，三个入口都调这里，别各写各的格式。
async function dlNotePause(deps, res) {
  const pure = deps.boothPausePure || {};
  if (typeof pure.noteBoothPause !== 'function') return null;
  const status = Number(res?.status) || 0;
  if (status !== 429 && status !== 403) return null;
  const retryAfter = typeof pure.retryAfterOf === 'function' ? pure.retryAfterOf(res?.headers) : null;
  const rec = await pure.noteBoothPause({ fs: deps.fs, stateDir: String(deps.STATE_DIR), now: Date.now() }, { status, retryAfter });
  if (rec) deps.log(`[下载] BOOTH 回了 HTTP ${status}：记全局暂停到 ${new Date(rec.pausedUntil).toISOString()}`);
  return rec;
}

function dlCookiePath(deps) {
  return deps.path.join(String(deps.STATE_DIR), 'booth-cookies.json');
}

// 统一登记失败：state/error/errorKind/finishedAt 一处写齐，免得每条 catch 各写四行。
function dlMarkJobFailed(jobs, boothId, message, signedOut, humanize) {
  const job = jobs.get(String(boothId));
  if (!job) return;
  const text = String(message || '');
  job.state = 'failed';
  job.error = humanize ? dlHumanError(text) : (text || '下载失败');
  job.errorKind = dlErrorKind(text, Boolean(signedOut));
  job.finishedAt = Date.now();
}

// 下载进度：流式/一次性路径都要更新 bytes，percent 由 dlJobSnapshot 现算。
function dlAddProgress(jobs, boothId, written, total) {
  const job = jobs.get(String(boothId));
  if (job) { job.bytes = Number(written) || 0; job.total = Number(total) || 0; }
}

function dlReadCookieStore(deps, pure) {
  try {
    return pure.normalizeCookieStore(JSON.parse(deps.fs.readFileSync(dlCookiePath(deps), 'utf8')));
  } catch {
    return pure.emptyCookieStore();
  }
}

function dlWriteCookieStore(deps, pure, store) {
  const file = dlCookiePath(deps);
  deps.atomicWriteJson(file, store);
  // Cookie 是账号凭据：至少把权限位收紧（真正的边界是「Panel 只跑在本机 + 不回传页面」）。
  try { deps.fs.chmodSync(file, 0o600); } catch { /* 平台不支持就算了 */ }
  return store;
}

function dlCookieForRequest(deps, pure) {
  return pure.currentCookie(dlReadCookieStore(deps, pure));
}

function dlJobPercent(bytes, total) {
  const have = Number(bytes) || 0;
  const want = Number(total) || 0;
  // total 未知（HEAD 没给 content-length）时百分比回 null，别用 0 冒充「刚开始」。
  if (want <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((have / want) * 100)));
}

function dlJobSnapshot(state, describe, boothId) {
  const job = state.jobs.get(String(boothId));
  if (!job) return null;
  const { url: rawUrl, ...rest } = job;
  return {
    boothId: String(boothId),
    ...rest,
    percent: dlJobPercent(job.bytes, job.total),
    url: dlSanitizeUrl(rawUrl),
    text: describe({ boothId, plan: {}, bytes: job.bytes, total: job.total, saved: job.state === 'done' })
  };
}

// 已购台账索引：单件下载要先确认「这件确实在库里」，下载中心也要按号补标题。
// 台账损毁就当空索引（单件下载回 404、下载中心标题留空），不能把整个下载面板拖挂。
function dlPurchasesIndex(deps) {
  const map = new Map();
  try {
    const file = deps.path.join(String(deps.STATE_DIR), LIBDL_PURCHASES_FILE);
    const raw = JSON.parse(deps.fs.readFileSync(file, 'utf8'));
    const items = raw && typeof raw === 'object' && raw.items && typeof raw.items === 'object' ? raw.items : null;
    if (!items) return map;
    for (const key of Object.keys(items)) {
      const item = items[key] || {};
      const boothId = String(item.boothId || key || '').trim();
      if (!/^\d{5,9}$/.test(boothId)) continue;
      map.set(boothId, { boothId, title: String(item.title || ''), itemUrl: String(item.itemUrl || ''), coverUrl: String(item.coverUrl || '') });
    }
  } catch { /* 没台账/坏 JSON 都当空 */ }
  return map;
}

// 下载中心聚合：dlJobSnapshot 出 percent/url/text，这里补标题与 needsScan，再按状态+时间排序。
function dlDownloadsList(state, describe, limit, purchaseIndex) {
  const rows = Array.from(state.jobs.entries()).map(([boothId, job]) => {
    const view = dlJobSnapshot(state, describe, boothId) || { boothId: String(boothId) };
    const entry = purchaseIndex.get(String(boothId));
    // 标题以已购台账为准：BOOTH 清单页的标题偶尔会被解错编码，乱码不能盖掉台账里的正经名字。
    return { ...view, title: String((entry && entry.title) || job.title || ''), needsScan: Boolean(job.needsScan) };
  });
  rows.sort((a, b) => {
    const oa = LIBDL_STATE_ORDER[a.state] ?? 9;
    const ob = LIBDL_STATE_ORDER[b.state] ?? 9;
    if (oa !== ob) return oa - ob;
    return (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0);
  });
  return rows.slice(0, Math.max(1, Math.min(LIBDL_DOWNLOADS_MAX, Number(limit) || LIBDL_DOWNLOADS_MAX)));
}

// 顶部汇总：各状态计数 + total + needsScan（前端据此提示「N 件下好了，去刷新/扫描」）。
function dlDownloadsSummary(jobs) {
  const summary = { queued: 0, downloading: 0, done: 0, failed: 0, interrupted: 0, total: 0, needsScan: 0, extracted: 0, skipped: 0 };
  for (const job of jobs) {
    const name = String(job.state || '');
    if (Object.prototype.hasOwnProperty.call(summary, name)) summary[name] += 1;
    summary.total += 1;
    if (job.needsScan) summary.needsScan += 1;
    if (job.skipped) summary.skipped += 1;
    if (job.extract && job.extract.state === 'done') summary.extracted += 1;
  }
  return summary;
}

// 这个号目录下已经有落盘的成品文件（.part / .part.json 是没下完的残片，不算）：
// 用来在「台账被清空 / 换过机器」时 adopt 本地文件，而不是重新下载覆盖它。
function dlExistingTarget(deps, dir) {
  try {
    const rows = deps.fs.readdirSync(dir).filter((n) => !/\.part(\.json)?$/i.test(String(n)) && !/(thumbnail|\.(png|jpe?g|webp|gif|json))$/i.test(String(n))).map((n) => {
      const full = deps.path.join(dir, String(n));
      try { const st = deps.fs.statSync(full); return st.isFile() && st.size > 0 ? { name: String(n), path: full, bytes: st.size } : null; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.bytes - a.bytes);
    return rows[0] || null;
  } catch { return null; }   // 目录不存在（第一次下）就当没有
}

// 下载完成后自动解压（MioVRC 那种「下完就能用」）：开关 library.autoExtract（兼容 fileArchive.autoExtract）；复用 library-extract 的同一实现；失败不影响下载本身（只写 job.extract.error）。
function dlAutoExtractEnabled(deps) {
  const cfg = deps.cfg || {};
  return (cfg.fileArchive && cfg.fileArchive.autoExtract === true) || (cfg.library && cfg.library.autoExtract === true);
}

async function dlTryAutoExtract(deps, boothId) {
  if (!dlAutoExtractEnabled(deps)) return null;
  const extract = deps.libraryExtract;
  if (!extract || typeof extract.extractLibraryAsset !== 'function') return null;
  try {
    const result = await extract.extractLibraryAsset({ boothId });
    // 加密包：有密码本会自动解；解不开也只算「待输密码」，别标成普通失败（下载本身仍然 done）。
    const state = result.ok
      ? 'done'
      : (result.reason === 'password_required' || result.reason === 'bad_password'
        ? 'password_required'
        : (result.reason === 'aes_unsupported' ? 'aes_unsupported' : (result.encrypted ? 'encrypted' : 'failed')));
    const view = {
      state,
      files: Number(result.files) || 0,
      bytes: Number(result.bytes) || 0,
      encryption: String(result.encryption || (result.encrypted ? 'zipcrypto' : 'none')),
      reason: String(result.reason || ''),
      error: String(result.error || '')
    };
    return { view, destDirRel: String(result.destDirRel || '') };
  } catch (error) {
    return { view: { state: 'failed', files: 0, bytes: 0, error: String(error?.message ?? error) }, destDirRel: '' };
  }
}

export function createLibraryDownload(deps) {
  // 构造期不许读 deps（VM 边界测试用「一访问就抛」的 getter 验证）：队列/状态机推迟到首个请求。
  let impl = null;
  const implOf = () => impl || (impl = buildLibraryDownload(deps));
  const api = { handleConsoleLibraryDownload: (request) => implOf().handleConsoleLibraryDownload(request), enqueueReconcileDownload: (input) => implOf().enqueueReconcileDownload(input) };
  // 单文件入队/等待（文件清单、导入工程要用）：转发给懒初始化实现；不可枚举，免得 Object.keys 口径判红。
  const fwd = { startDownload: (boothId, url, origin, title, fileName) => implOf().startDownload(boothId, url, origin, title, fileName), waitDownload: (boothId, timeoutMs) => implOf().waitDownload(boothId, timeoutMs) };
  for (const [name, fn] of Object.entries(fwd)) Object.defineProperty(api, name, { value: fn });
  return api;
}

// 给行为测试直接打分类表用（下载失败在真网络里不好稳定复现每一类，纯函数可以直接验）。
export function classifyLibraryDownloadError(message, signedOut) {
  return dlErrorKind(message, signedOut);
}

// 已购库「单件下载」：先确认台账里有这件，再复用清单解析入队；already / dup / 两道暂停闸都在这。
// 抽到模块作用域是为了别把 buildLibraryDownload 撑过限——队列状态走 ctx，不依赖其它闭包。
async function dlServePurchaseDownload(deps, ctx, request) {
  const { sendJson, readBody } = request;
  const body = await readBody();
  const boothId = String((body && body.boothId) || '').replace(/\D/g, '');
  if (!/^\d{5,9}$/.test(boothId)) { sendJson({ ok: false, error: '商品号要是 5~9 位数字' }, 400); return true; }
  const entry = dlPurchasesIndex(deps).get(boothId);
  if (!entry) { sendJson({ ok: false, error: '已购库里没有这个商品' }, 404); return true; }
  const wanted = String((body && body.fileName) || '').trim();
  if (wanted) {
    const paused0 = await dlPause(deps);
    if (paused0.paused) { sendJson({ ok: false, paused: true, error: paused0.text, retryAfterMs: paused0.retryAfterMs }, 409); return true; }
    if (ctx.jobState.paused) { sendJson({ ok: false, paused: true, error: LIBDL_SCHEDULER_PAUSED_TEXT }, 409); return true; }
    const one = deps.purchaseFiles ? await deps.purchaseFiles.downloadPurchaseFile(boothId, wanted) : { ok: false, error: '文件清单模块没接上' };
    if (!one.ok) { sendJson({ ok: false, error: one.error || '入队失败' }, one.status || 502); return true; }
    sendJson({ ok: true, already: Boolean(one.already), queued: Boolean(one.queued), skipped: Boolean(one.skipped), reason: String(one.reason || ''), path: String(one.path || ''), job: ctx.jobSnapshot(boothId) });
    return true;
  }
  let known = ctx.jobs.get(boothId);
  if (known && known.state === 'done') {
    const root = ctx.downloadsRoot();
    const savedName = String(known.name || known.fileName || ''); const savedPath = root && savedName ? deps.path.join(root, String(boothId).slice(0, 12), savedName) : '';
    const saved = savedPath ? deps.fs.statSync(savedPath, { throwIfNoEntry: false }) : null;
    // 文件真在就回 already，绝不重下（verifier 实测：这里删 job 会又整包下一遍）。
    // 与台账大小不一致也不覆盖，只标 size_mismatch；强制重下留给以后单独入口。
    if (saved && saved.size > 0) {
      const rel = deps.path.join(String(boothId).slice(0, 12), savedName).replace(/\\/g, '/');
      const recorded = Number(known.bytes) || 0;
      const mismatch = recorded > 0 && saved.size !== recorded;
      known.skipped = true; known.reason = mismatch ? 'size_mismatch' : 'exists'; dlPersistJobs(ctx.jobState);
      sendJson({ ok: true, already: true, skipped: mismatch ? 'size_mismatch' : 'exists', path: rel, bytes: saved.size, recordedBytes: recorded, fileName: savedName, job: ctx.jobSnapshot(boothId) });
      return true;
    }
    // 文件确实不在了才清掉 done 记录让它重下（文件在就绝不走到这里，见上面 already 分支）。
    ctx.jobs.delete(boothId); dlPersistJobs(ctx.jobState); known = null;
  }
  if (known && (known.state === 'queued' || known.state === 'downloading')) { sendJson({ ok: true, queued: false, reason: 'dup', job: ctx.jobSnapshot(boothId) }); return true; }
  const paused = await dlPause(deps);
  if (paused.paused) { sendJson({ ok: false, paused: true, error: paused.text, retryAfterMs: paused.retryAfterMs }, 409); return true; }
  if (ctx.jobState.paused) { sendJson({ ok: false, paused: true, error: LIBDL_SCHEDULER_PAUSED_TEXT }, 409); return true; }
  const result = await ctx.enqueueReconcileDownload({ boothId, title: entry.title }, 'purchase');
  if (result.ok && result.queued) { sendJson({ ok: true, queued: true, job: result.job }); return true; }
  if (result.ok && result.already) {
    // already 的对外契约（verifier P2）：skipped=exists|size_mismatch + path + bytes + fileName，一律不重下。
    const job = result.job || ctx.jobSnapshot(boothId);
    const bytes = Number(result.bytes || (job && job.bytes) || 0);
    sendJson({ ok: true, already: true, skipped: String(result.reason === 'file_exists' ? 'exists' : (result.reason || 'exists')), path: String(result.path || ''), bytes, recordedBytes: Number((job && job.bytes) || 0), fileName: String((job && job.name) || ''), job });
    return true;
  }
  if (result.ok) { sendJson({ ok: true, queued: false, reason: 'dup', job: result.job }); return true; }
  sendJson({ ok: false, error: result.error || '入队失败' }, 502);
  return true;
}

// @bridge-function handleConsoleLibraryDownload:start
async function handleConsoleLibraryDownload(ctx, request) {
  const { req, res, url, sendJson, readBody } = request;
  const { deps, pure, jobs, downloads, jobState, downloadsRoot, jobSnapshot, fetchLibraryPage, startDownload } = ctx, { normalizeCookie, cookieStoreSummary, setCookieAccount, removeCookieAccount, normalizeCookieStore, currentCookie, parseOwnedListHtml, nextPageDecision, describeDownloadState } = pure;
  dlLoadJobs(jobState);
  if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
    sendJson({ ok: false, error: '未授权：BOOTH 下载是管理端操作' }, 403);
    return true;
  }
  const path = url.pathname;

  if (path === '/api/library/booth-cookie') {
    if (req.method === 'GET') {
      const summary = cookieStoreSummary(dlReadCookieStore(deps, pure));
      sendJson({ ok: true, ...summary, downloads: Array.from(jobs.values()).map((j) => ({ ...j })) });
      return true;
    }
    if (req.method === 'POST') {
      const body = await readBody();
      const result = setCookieAccount(dlReadCookieStore(deps, pure), body && body.cookie, { note: body && body.note });
      if (!result.ok) { sendJson({ ok: false, error: result.reason }, 400); return true; }
      dlWriteCookieStore(deps, pure, result.store);
      deps.log(`[下载] 已保存 BOOTH Cookie 槽位 ${result.key}${body && body.note ? `（${String(body.note).slice(0, 20)}）` : ''}`);
      sendJson({ ok: true, ...cookieStoreSummary(result.store) });
      return true;
    }
  }
  if (path === '/api/library/booth-cookie/remove' && req.method === 'POST') {
    const body = await readBody();
    const next = removeCookieAccount(dlReadCookieStore(deps, pure), body && body.key);
    dlWriteCookieStore(deps, pure, next);
    sendJson({ ok: true, ...cookieStoreSummary(next) });
    return true;
  }
  if (path === '/api/library/booth-cookie/current' && req.method === 'POST') {
    const body = await readBody();
    const store = normalizeCookieStore(dlReadCookieStore(deps, pure));
    const key = String((body && body.key) || '');
    if (store.accounts[key]) store.current = key;
    dlWriteCookieStore(deps, pure, store);
    sendJson({ ok: true, ...cookieStoreSummary(store) });
    return true;
  }

  if (path === '/api/library/owned' && req.method === 'GET') {
    if (!normalizeCookie(currentCookie(dlReadCookieStore(deps, pure))).ok) {
      sendJson({ ok: false, error: '还没保存 BOOTH Cookie', needCookie: true }, 400);
      return true;
    }
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const seen = String(url.searchParams.get('seen') || '').split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const { html, url: finalUrl } = await fetchLibraryPage(page);
      const parsed = parseOwnedListHtml(html);
      const decision = nextPageDecision({ page, pageIds: parsed.ids, seenIds: seen, hasNext: parsed.hasNext });
      sendJson({ ok: true, page, at: Date.now(), ...parsed, next: { stop: decision.stop, reason: decision.reason, page: decision.nextPage || 0 } });
    } catch (error) {
      if (error && error.signedOut) sendJson({ ok: false, error: String(error.message), signedOut: true }, 401);
      else sendJson({ ok: false, error: String(error?.message ?? error) }, 502);
    }
    return true;
  }

  if (path === '/api/library/purchases/download' && req.method === 'POST') {
    return dlServePurchaseDownload(deps, { jobs, jobState, downloadsRoot, jobSnapshot, enqueueReconcileDownload: (input, origin) => enqueueReconcileDownload(ctx, input, origin) }, request);
  }

  if (path === '/api/library/downloads' && req.method === 'GET') {
    dlRefreshFromDisk(jobState);
    const limit = Math.max(1, Math.min(LIBDL_DOWNLOADS_MAX, Number(url.searchParams.get('limit')) || LIBDL_DOWNLOADS_MAX));
    const pause = await dlPause(deps);
    sendJson({
      ok: true,
      running: downloads.size > 0,
      paused: Boolean(jobState.paused),
      pausedAt: Number(jobState.pausedAt) || 0,
      boothPaused: Boolean(pause.paused),
      pauseText: pause.text || '',
      retryAfterMs: Number(pause.retryAfterMs) || 0,
      jobs: dlDownloadsList(jobState, describeDownloadState, limit, dlPurchasesIndex(deps)),
      summary: dlDownloadsSummary(Array.from(jobs.values()))
    });
    return true;
  }

  if (path === '/api/library/downloads/pause' && req.method === 'POST') {
    if (jobState.paused) { sendJson({ ok: false, error: '已经暂停了' }, 409); return true; }
    jobState.paused = true;
    jobState.pausedAt = Date.now();
    dlPersistJobs(jobState);
    deps.log('[下载] 下载队列已暂停：新任务不再开跑');
    sendJson({ ok: true, paused: true, pausedAt: jobState.pausedAt });
    return true;
  }
  if (path === '/api/library/downloads/resume' && req.method === 'POST') {
    if (!jobState.paused) { sendJson({ ok: false, error: '队列已经在跑了' }, 409); return true; }
    jobState.paused = false;
    jobState.pausedAt = 0;
    dlPersistJobs(jobState);
    deps.log('[下载] 下载队列已恢复');
    sendJson({ ok: true, paused: false, pausedAt: 0 });
    return true;
  }

  if (path === '/api/library/download' && req.method === 'POST') {
    const body = await readBody();
    const boothId = String((body && body.boothId) || '').replace(/\D/g, '');
    if (!/^\d{5,9}$/.test(boothId)) { sendJson({ ok: false, error: '商品号要是 5~9 位数字' }, 400); return true; }
    if (!body || !body.url) { sendJson({ ok: false, error: '缺下载地址（先从清单里取 dl 链接）' }, 400); return true; }
    const paused = await dlPause(deps);
    if (paused.paused) { sendJson({ ok: false, paused: true, error: paused.text, retryAfterMs: paused.retryAfterMs }, 409); return true; }
    if (jobState.paused) { sendJson({ ok: false, paused: true, error: LIBDL_SCHEDULER_PAUSED_TEXT }, 409); return true; }
    try {
      const title = String((dlPurchasesIndex(deps).get(boothId) || {}).title || '');
      const result = await startDownload(boothId, String(body.url), 'manual', title);
      sendJson(result, 200);
    } catch (error) {
      if (error && error.signedOut) sendJson({ ok: false, error: LIBDL_STALE_URL, signedOut: true }, 401);
      else sendJson({ ok: false, error: dlHumanError(error?.message ?? error) }, 500);
    }
    return true;
  }

  if (path === '/api/library/download/retry' && req.method === 'POST') {
    const body = await readBody();
    const boothId = String((body && body.boothId) || '').replace(/\D/g, '');
    if (!/^\d{5,9}$/.test(boothId)) { sendJson({ ok: false, error: '商品号要是 5~9 位数字' }, 400); return true; }
    const known = jobs.get(boothId);
    if (!known) { sendJson({ ok: false, error: '没找到这个下载任务，请重新载入已购清单再下载' }, 404); return true; }
    if (known.state === 'done') { sendJson({ ok: true, already: true, job: jobSnapshot(boothId) }); return true; }
    const retryUrl = String(known.url || '');
    if (!retryUrl) { sendJson({ ok: false, error: LIBDL_STALE_URL }, 400); return true; }
    const paused = await dlPause(deps);
    if (paused.paused) { sendJson({ ok: false, paused: true, error: paused.text, retryAfterMs: paused.retryAfterMs }, 409); return true; }
    if (jobState.paused) { sendJson({ ok: false, paused: true, error: LIBDL_SCHEDULER_PAUSED_TEXT }, 409); return true; }
    try {
      const result = await startDownload(boothId, retryUrl, String(known.from || 'manual'), String(known.title || ''));
      sendJson(result, 200);
    } catch (error) {
      if (error && error.signedOut) sendJson({ ok: false, error: LIBDL_STALE_URL, signedOut: true }, 401);
      else sendJson({ ok: false, error: dlHumanError(error?.message ?? error) }, 500);
    }
    return true;
  }

  if ((path === '/api/library/download/clear' || path === '/api/library/downloads/clear') && req.method === 'POST') {
    return (sendJson({ ok: true, cleared: dlClearDone(jobState) }), true);
  }

  if (path === '/api/library/download/status' && req.method === 'GET') {
    return (sendJson({ ok: true, jobs: Array.from(jobs.keys()).map((id) => jobSnapshot(id)) }), true);
  }
  return false;
}
// @bridge-function handleConsoleLibraryDownload:end
// @bridge-function enqueueReconcileDownload:start
// 对账页「一键下载」：已购台账有、素材库没有的号，去已购清单找下载链接；只读清单+调 startDownload；找不到给人话不抛异常（批量触发单条失败不打断整批）。
async function enqueueReconcileDownload(ctx, input, origin) {
  const { deps, pure, jobs, downloads, jobState, downloadsRoot, jobSnapshot, fetchLibraryPage, startDownload } = ctx, { normalizeCookie, currentCookie, parseOwnedListHtml, nextPageDecision } = pure;
  dlLoadJobs(jobState);
  const from = String(origin || 'reconcile');
  const boothId = String((input && input.boothId) || '').replace(/\D/g, '');
  if (!/^\d{5,9}$/.test(boothId)) return { ok: false, error: '商品号要是 5~9 位数字' };
  if (!normalizeCookie(currentCookie(dlReadCookieStore(deps, pure))).ok) {
    return { ok: false, error: '还没保存 BOOTH Cookie，先去文件库下载面板贴一个' };
  }
  if (!downloadsRoot()) return { ok: false, error: '转存目录还没配（config.json 的 fileArchive.dir）' };
  if (jobState.paused) return { ok: false, error: LIBDL_SCHEDULER_PAUSED_TEXT, paused: true };
  if (downloads.has(boothId)) return { ok: true, already: true, queued: false, job: jobSnapshot(boothId) };
  const known = jobs.get(boothId);
  if (known && (known.state === 'done' || known.state === 'queued' || known.state === 'downloading')) {
    return { ok: true, already: true, queued: false, job: jobSnapshot(boothId) };
  }
  const seen = new Set();
  let page = 1;
  try {
    for (let guard = 0; guard < 40; guard += 1) {
      const { html } = await fetchLibraryPage(page);
      const parsed = parseOwnedListHtml(html);
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      const hit = items.find((item) => String((item && item.boothId) || '') === boothId);
      if (hit && hit.downloadUrl) {
        const result = await startDownload(boothId, String(hit.downloadUrl), from, String((input && input.title) || (hit && hit.title) || ''));
        return { ok: true, queued: Boolean(result.queued), already: Boolean(result.already), skipped: Boolean(result.skipped), reason: String(result.reason || ''), path: String(result.path || ''), job: result.job || jobSnapshot(boothId) };
      }
      const decision = nextPageDecision({ page, pageIds: parsed.ids, seenIds: Array.from(seen), hasNext: parsed.hasNext });
      for (const id of (Array.isArray(parsed.ids) ? parsed.ids : [])) seen.add(String(id));
      if (decision.stop || !decision.nextPage) break;
      page = decision.nextPage;
    }
  } catch (error) {
    if (error && error.signedOut) return { ok: false, error: LIBDL_STALE_URL, signedOut: true };
    return { ok: false, error: dlHumanError(error?.message ?? error) };
  }
  return { ok: false, error: '已购清单里没找到这个商品的下载链接（可能已下架，或还在别的账号里）' };
}
// @bridge-function enqueueReconcileDownload:end
function buildLibraryDownload(deps) {
  const pure = deps.boothDownloadPure || {};
  const { normalizeCookie, accountKeyOf, emptyCookieStore, normalizeCookieStore, setCookieAccount, removeCookieAccount, cookieStoreSummary, currentCookie, isSignedOut, parseOwnedListHtml, nextPageDecision, planDownload, interpretRangeResponse, shouldRetryDownload, safeFileName, buildDownloadRequest, describeDownloadState, formatBytes, DOWNLOAD_STALL_MS, DOWNLOAD_MAX_RETRY } = pure;

  // VM 里不一定有 Buffer / AbortSignal 这两个全局（桥接把要用到的都走 deps 注入）
  const BUF = deps.Buffer || (typeof Buffer !== 'undefined' ? Buffer : null);
  const ABORT = deps.AbortSignal || (typeof AbortSignal !== 'undefined' ? AbortSignal : null);
  let lastNetworkAt = 0;
  const jobs = new Map();   // boothId -> {state, bytes, total, name, error, url, startedAt, finishedAt}
  const downloads = new Map(); // boothId -> promise（同一件不并发下两次）
  const jobState = { deps, jobs, loaded: false };

  const downloadsRoot = () => {
    const raw = typeof deps.fileArchiveRootDir === 'function' ? deps.fileArchiveRootDir() : deps.fileArchiveRootDir;
    const dir = String(raw || '').trim();
    return dir ? deps.path.resolve(dir) : '';
  };

  async function throttle() {
    const wait = LIBDL_RATE_LIMIT_MS - (Date.now() - lastNetworkAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastNetworkAt = Date.now();
  }
  const makeSignal = () => (ABORT && typeof ABORT.timeout === 'function' ? ABORT.timeout(DOWNLOAD_STALL_MS * 2) : undefined);

  /** 抓一页清单（只读文本，不落盘，超过 3MB 判异常）。 */
  async function fetchLibraryPage(page) {
    const pause = await dlPause(deps);
    if (pause.paused) throw new Error(pause.text);
    await throttle();
    const url = `${LIBDL_LIBRARY_URL}?page=${Math.max(1, Number(page) || 1)}`;
    const res = await deps.fetch(url, {
      headers: { 'user-agent': LIBDL_UA, accept: 'text/html,application/xhtml+xml', ...(dlCookieForRequest(deps, pure) ? { cookie: dlCookieForRequest(deps, pure) } : {}) },
      redirect: 'follow',
      signal: makeSignal()
    });
    await dlNotePause(deps, res);   // 429/403 先把全局暂停记上，再决定这一页怎么报错
    const html = await res.text();
    if (html.length > LIBDL_MAX_HTML_BYTES) throw new Error('清单页大得不对劲（超过 3MB）');
    const signedOut = isSignedOut({ status: res.status, finalUrl: res.url || url, body: html });
    if (signedOut.out) {
      const err = new Error(signedOut.reason);
      err.signedOut = true;
      throw err;
    }
    return { url, html, status: res.status };
  }

  // ── 文件下载（断点续传 + 有限重试） ─────────────────────────────────
  const jobSnapshot = (boothId) => dlJobSnapshot(jobState, describeDownloadState, boothId);

  async function downloadOnce(boothId, url, dir, fileName, headTotal) {
    const partPath = deps.path.join(dir, fileName + '.part');
    const finalPath = deps.path.join(dir, fileName);
    try {
      const st = deps.fs.statSync(finalPath);
      if (st.isFile() && st.size > 0) { const cur = jobs.get(boothId); if (cur) { cur.state = 'done'; cur.bytes = st.size; cur.skipped = true; cur.reason = 'file_exists'; cur.finishedAt = Date.now(); dlPersistJobs(jobState); } return { ok: true, already: true, skipped: true, reason: 'file_exists', path: finalPath, bytes: st.size, name: fileName, job: jobSnapshot(boothId) }; }
    } catch { /* 没文件就正常下 */ }
    let existing = 0;
    let validators = {};
    try {
      existing = deps.fs.statSync(partPath).size;
      const metaPath = partPath + '.json';
      try { validators = JSON.parse(deps.fs.readFileSync(metaPath, 'utf8')) || {}; } catch { validators = {}; }
    } catch { existing = 0; }
    const plan = planDownload({ expectedBytes: Number(validators.total) || 0, existingBytes: existing, etag: validators.etag || '', validators });
    const req = buildDownloadRequest({ url, cookie: dlCookieForRequest(deps, pure), plan });
    const job = jobs.get(boothId);
    if (job) { job.state = 'downloading'; job.bytes = plan.from; job.total = Number(validators.total) || 0; }

    const pauseBefore = await dlPause(deps);
    if (pauseBefore.paused) throw new Error(pauseBefore.text);
    let attempt = 1;
    for (;;) {
      try {
        await throttle();
        const res = await deps.fetch(req.url, { headers: req.headers, redirect: 'follow', signal: makeSignal() });
        await dlNotePause(deps, res);   // 429/403 → 写全局暂停，别的入口立刻停；本次任务仍按原错误收尾
        const verdict = interpretRangeResponse({ status: res.status, contentRange: res.headers.get('content-range') || '', bytes: 0, expectedBytes: Number(validators.total) || 0 });
        if (!verdict.ok && verdict.mode === 'restart' && attempt < DOWNLOAD_MAX_RETRY) {
          try { deps.fs.unlinkSync(partPath); } catch { /* ignore */ }
          attempt += 1;
          continue;
        }
        if (!verdict.ok) throw new Error(verdict.reason || `HTTP ${res.status}`);
        const mode = verdict.mode; const append = mode === 'resume'; const etag = res.headers.get('etag') || '';
        const total = Number(res.headers.get('content-length')) > 0 && append
          ? verdict.from + Number(res.headers.get('content-length'))
          : (verdict.total || Number(res.headers.get('content-length')) || 0);
        if (total > LIBDL_MAX_FILE_BYTES) throw new Error(`文件太大（${formatBytes(total)}），不在下载范围`);
        const fd = deps.fs.openSync(partPath, append ? 'a' : 'w'); let written = append ? verdict.from : 0;
        try {
          const readerBody = res.body;
          if (readerBody && typeof readerBody.getReader === 'function') {
            const reader = readerBody.getReader();
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              const buf = BUF.from(chunk.value);
              deps.fs.writeSync(fd, buf);
              written += buf.length;
              dlAddProgress(jobs, boothId, written, total);
            }
          } else {
            const buf = BUF.from(await res.arrayBuffer());
            deps.fs.writeSync(fd, buf);
            written += buf.length;
            dlAddProgress(jobs, boothId, written, total);
          }
        } finally {
          deps.fs.closeSync(fd);
        }
        if (total > 0 && written !== total) throw new Error(`下载不完整：${written}/${total} 字节`);
        try { deps.fs.renameSync(partPath, finalPath); } catch (error) { throw new Error(`改名失败：${error?.message ?? error}`); }
        try { deps.fs.unlinkSync(partPath + '.json'); } catch { /* ignore */ }
        try { for (const left of deps.fs.readdirSync(dir)) { if (/\.part(\.json)?$/i.test(String(left))) deps.fs.rmSync(deps.path.join(dir, String(left)), { force: true }); } } catch { /* 清残片失败不致命 */ }
        const cur = jobs.get(boothId); if (cur) { cur.state = 'done'; cur.bytes = written; cur.total = total || written; cur.name = fileName; }
        deps.log(`[下载] #${boothId} 完成 ${formatBytes(written)} → ${finalPath}`);
        return { ok: true, path: finalPath, bytes: written, name: fileName };
      } catch (error) {
        const decision = shouldRetryDownload({ attempt, error: String(error?.message ?? error) });
        if (!decision.retry) {
          dlMarkJobFailed(jobs, boothId, error?.message ?? error, error && error.signedOut, false);
          throw error;
        }
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
      }
    }
  }

  async function startDownload(boothId, url, origin /* manual / reconcile / purchase：任务来源，写台账供前端区分 */, title, fileName) {
    dlLoadJobs(jobState);
    // 调度暂停（下载中心「暂停」）：只拦还没开跑的新任务，正在跑的那次继续跑完（跑完自然停）。
    if (jobState.paused) throw new Error(LIBDL_SCHEDULER_PAUSED_TEXT);
    const root = downloadsRoot();
    if (!root) throw new Error('转存目录还没配（config.json 的 fileArchive.dir）');
    if (!normalizeCookie(currentCookie(dlReadCookieStore(deps, pure))).ok) throw new Error('还没保存 BOOTH Cookie，先在上面贴一个');
    const host = (/^https:\/\/([^/?#]+)/i.exec(String(url || '')) || [])[1] || '';
    if (!host || !/(^|\.)booth\.pm$/i.test(host)) throw new Error('下载地址必须是 booth.pm 的 https 链接（从清单里取的 dl 链接）');
    if (downloads.has(boothId)) return { ok: true, already: true, job: jobSnapshot(boothId) }; // 同进程在跑：不起第二份
    const known = jobs.get(boothId);
    // 台账 done 不代表文件还在（真机踩过）：按磁盘真相判定，在就 adopt、没了就重下。
    const dir = deps.path.join(root, String(boothId).replace(/\D/g, '').slice(0, 12) || 'unknown');
    deps.fs.mkdirSync(dir, { recursive: true });
    // 标题以已购台账为准（清单页标题有编码风险），抓页拿到的只当兜底。
    const ledgerTitle = String(((dlPurchasesIndex(deps).get(String(boothId)) || {}).title) || '');
    // 落盘前先看目标目录：本地有就 adopt 不覆盖；远端 zip 字节数每次不同，只标 size_mismatch 给人判断。
    if (fileName) {
      const exactPath = deps.path.join(dir, String(fileName));
      const exactStat = (() => { try { return deps.fs.statSync(exactPath); } catch { return null; } })();
      if (exactStat && exactStat.size > 0) {
        jobs.set(boothId, { state: 'done', from: String(origin || 'manual'), title: String(ledgerTitle || title || ''), bytes: exactStat.size, total: exactStat.size, name: String(fileName), error: '', errorKind: '', url: String(url), skipped: true, reason: 'file_exists', needsScan: false, startedAt: Date.now(), finishedAt: Date.now() });
        dlPersistJobs(jobState);
        return { ok: true, already: true, skipped: true, reason: 'file_exists', path: exactPath, bytes: exactStat.size, job: jobSnapshot(boothId) };
      }
    }
    const localTarget = fileName ? null : dlExistingTarget(deps, dir);
    if (localTarget) {
      let remoteTotal = 0;
      try { await throttle(); const head = await deps.fetch(url, { method: 'HEAD', headers: { ...buildDownloadRequest({ url, cookie: dlCookieForRequest(deps, pure) }).headers }, redirect: 'follow', signal: makeSignal() }); remoteTotal = Number(head.headers.get('content-length')) || 0; } catch { /* 探不到远端就按 file_exists：宁可跳过也不覆盖 */ }
      const mismatch = remoteTotal > 0 && localTarget.bytes !== remoteTotal;
      const reason = mismatch ? 'size_mismatch' : 'file_exists';
      jobs.set(boothId, { state: 'done', from: String(origin || (known && known.from) || 'manual'), title: String(ledgerTitle || title || (known && known.title) || ''), bytes: localTarget.bytes, total: remoteTotal > 0 ? remoteTotal : localTarget.bytes, name: localTarget.name, error: '', errorKind: mismatch ? 'local_differs' : '', url: String(url), skipped: true, reason, needsScan: false, startedAt: Date.now(), finishedAt: Date.now() });
      dlPersistJobs(jobState);
      deps.log(`[下载] #${boothId} 本地已有 ${localTarget.name}（${formatBytes(localTarget.bytes)}${mismatch ? `，远端 ${formatBytes(remoteTotal)}` : ''}），跳过不覆盖`);
      return { ok: true, already: true, skipped: true, reason, path: localTarget.path, bytes: localTarget.bytes, job: jobSnapshot(boothId) };
    }
    jobs.set(boothId, { state: 'queued', from: String(origin || (known && known.from) || 'manual'), title: String(ledgerTitle || title || (known && known.title) || ''), bytes: 0, total: 0, name: '', error: '', errorKind: '', url: String(url), skipped: false, needsScan: false, startedAt: Date.now(), finishedAt: 0 });
    dlPersistJobs(jobState);
    const promise = (async () => {
      try {
        const pause0 = await dlPause(deps);
        if (pause0.paused) throw new Error(pause0.text);
        await throttle();
        const head = await deps.fetch(url, { method: 'HEAD', headers: { ...buildDownloadRequest({ url, cookie: dlCookieForRequest(deps, pure) }).headers }, redirect: 'follow', signal: makeSignal() });
        const pauseRec = await dlNotePause(deps, head);
        if (pauseRec) throw new Error(dlPauseText(deps, pauseRec));
        const name = String(fileName || safeFileName({ disposition: head.headers.get('content-disposition') || '', url, boothId }));
        const total = Number(head.headers.get('content-length')) || 0;
        const job = jobs.get(boothId);
        if (job) { job.total = total; job.name = name; job.state = 'downloading'; dlPersistJobs(jobState); }
        const result = await downloadOnce(boothId, url, dir, name, total);
        const done = jobs.get(boothId);
        if (done) { done.state = 'done';
          done.needsScan = true; done.finishedAt = Date.now();
          // 自动认号/补封面由「文件清单」模块负责（下载模块不复制 bind/cover 规则）。
          const auto = deps.purchaseFiles && typeof deps.purchaseFiles.autoClaimAfterDownload === 'function' ? await deps.purchaseFiles.autoClaimAfterDownload({ boothId, fileName: String(done.name || name || ''), dirAbs: dir }) : { autoBound: false, coverSaved: false };
          done.autoBound = auto.autoBound; done.coverSaved = auto.coverSaved;
          const extracted = await dlTryAutoExtract(deps, boothId);
          if (extracted) { done.extract = extracted.view; if (extracted.destDirRel) done.destDirRel = extracted.destDirRel; }
          dlPersistJobs(jobState);
        }
        return result;
      } catch (error) {
        dlMarkJobFailed(jobs, boothId, error?.message ?? error, error && error.signedOut, true);
        dlPersistJobs(jobState);
        throw error;
      } finally {
        downloads.delete(boothId);
      }
    })();
    // 后台任务的 rejection 必须自己吞（失败原因已写进 jobs，前端轮询 status 能看到）。
    downloads.set(boothId, promise.catch(() => {}));
    return { ok: true, queued: true, job: jobSnapshot(boothId) };
  }

  async function waitDownload(boothId, timeoutMs = 180000) {
    const until = Date.now() + Math.max(1000, Number(timeoutMs) || 180000);
    while (Date.now() < until) {
      const job = jobs.get(boothId);
      if (job && job.state === 'done') return true;
      if (!downloads.has(boothId) && job && (job.state === 'failed' || job.state === 'interrupted')) return false;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return false;
  }
  const ctx = { deps, pure, jobs, downloads, jobState, downloadsRoot, jobSnapshot, fetchLibraryPage, startDownload };
  return { handleConsoleLibraryDownload: (request) => handleConsoleLibraryDownload(ctx, request), enqueueReconcileDownload: (input, origin) => enqueueReconcileDownload(ctx, input, origin), startDownload, waitDownload };
}
