// 已购商品的「文件清单」：一个 BOOTH 商品可能带多个文件（正片 + 补丁 + 密码本…），
// 下载中心要按文件逐条下，所以先从已购清单页把该商品的所有下载链接抓出来。
//
// 约束：本文件是 manifest 模块，被 scripts/bridge-source.mjs 用 vm.runInContext 裸执行，
// **不能 import**。Cookie 读写、清单解析、翻页判定、文件名清洗等纯规则全部来自
// deps.boothDownloadPure（和 library-download.js 同一口径），暂停闸来自 deps.boothPausePure。
// 顶部不要有和 src/bridge.js 同名的 const/let（VM 里共用一个全局词法作用域）。

const LIBPF_CACHE_FILE = 'booth-purchase-files.json';
const LIBPF_CACHE_TTL_MS = 10 * 60 * 1000;
const LIBPF_LIBRARY_URL = 'https://accounts.booth.pm/library';
const LIBPF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const LIBPF_MAX_LINKS = 20;
const LIBPF_MAX_PAGES = 40;
// 陌生号（已购清单里没有）会一路翻页翻到 40 页，前端 3s 就超时了，所以这里自己封顶：
// 整件事 6s、单请求 3s；失败负缓存 60s，避免用户连点把 BOOTH 打限速。
const LIBPF_TOTAL_TIMEOUT_MS = 6000;
const LIBPF_REQ_TIMEOUT_MS = 3000;
const LIBPF_NEGATIVE_TTL_MS = 60 * 1000;
// 真机实测：/downloadables 的 range 探针本身就要 6.1s（HEAD 直接挂死），3s 单请求 + 6s 总预算必然失败。
// 「已购台账里有的号」放宽到单请求 8s / 总共 30s；陌生号仍守 6s 护栏（那条是防翻页翻到 40 页）。
const LIBPF_KNOWN_REQ_TIMEOUT_MS = 8000;
const LIBPF_KNOWN_TOTAL_TIMEOUT_MS = 30000;
const LIBPF_TIMEOUT_TEXT = '取文件清单超时/失败（BOOTH 可能限速）';
const LIBPF_LINK_RE = /(?:href|data-href)="([^"]*(?:\/downloadables\/|\/downloads\/|\/dl\/)[^"]*)"/g;

// 缓存：同一件商品 10 分钟内只抓一次清单（页面 HEAD 每文件一次，抓太勤会被限速）。
function libpfCachePath(deps) {
  return deps.path.join(deps.STATE_DIR, LIBPF_CACHE_FILE);
}

function libpfLoadCache(deps) {
  try {
    const raw = JSON.parse(deps.fs.readFileSync(libpfCachePath(deps), 'utf8'));
    const items = raw && typeof raw.items === 'object' && raw.items ? raw.items : {};
    return { version: 1, items };
  } catch {
    return { version: 1, items: {} };
  }
}

function libpfSaveCache(deps, cache) {
  try {
    deps.atomicWriteJson(libpfCachePath(deps), { version: 1, at: Date.now(), items: cache.items });
  } catch (error) {
    deps.log('[已购文件] 缓存写入失败：' + (error && error.message ? error.message : error));
  }
}

// 取当前 Cookie 槽的 cookie 串（和下载模块同格式：booth-cookies.json 的 current/accounts）。
// 直接读盘再交给 boothDownloadPure.currentCookie 归一，不依赖下载模块的内部函数（它没导出）。
function libpfCookie(deps) {
  const pure = deps.boothDownloadPure || {};
  try {
    const store = JSON.parse(deps.fs.readFileSync(deps.path.join(deps.STATE_DIR, 'booth-cookies.json'), 'utf8'));
    return typeof pure.currentCookie === 'function' ? String(pure.currentCookie(store) || '') : '';
  } catch {
    return '';
  }
}

// 已购清单页里每个商品卡片的下载链接：先按 /items/<号> 的 DOM 顺序切段，再在段内收下载链接。
function libpfCardLinks(html) {
  const text = String(html || '');
  const marks = [];
  const re = /\/items\/(\d{5,9})/g;
  let m;
  while ((m = re.exec(text))) marks.push({ boothId: m[1], at: m.index });
  const out = new Map();
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].at;
    const end = i + 1 < marks.length ? marks[i + 1].at : Math.min(text.length, start + 8000);
    const seg = text.slice(start, end);
    const links = [];
    let lm;
    const linkRe = new RegExp(LIBPF_LINK_RE.source, 'g');
    while ((lm = linkRe.exec(seg))) links.push(lm[1]);
    if (links.length) out.set(marks[i].boothId, Array.from(new Set(links)));
  }
  return out;
}

// 超时赛跑：不用 AbortController 也能保证「整件事」不被 40 页翻页拖死（fetch 自身还有单请求 signal）。
function libpfRaceTimeout(promise, ms, text) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    // 故意不 unref：测试里如果只剩这个定时器，unref 会让 Node 直接退出、断言永远悬着。
    timer = setTimeout(() => reject(Object.assign(new Error(text), { timeout: true })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 「完整」才允许落缓存：文件名要有（真机见过 fileName:'6985553' 没扩展名）、大小要 > 0。
// 不完整就别把坏形状写进 10 分钟缓存，否则下一个用户看到的是「phantom 文件」。
function libpfFilesComplete(files) {
  return Array.isArray(files) && files.length > 0 && files.every((one) => one && String(one.fileName || '').trim() && Number(one.bytes) > 0);
}

function libpfAbsUrl(base, href) {
  try {
    return new URL(String(href), base).href;
  } catch {
    return String(href);
  }
}

// 文件名兜底：跟着重定向后的最终 URL 取末段（S3 链接里带着真实文件名），再交给 safeFileName 清洗。
function libpfNameFromUrl(finalUrl, fallbackUrl, pure) {
  const pick = (raw) => {
    try {
      const seg = String(new URL(String(raw || '')).pathname.split('/').pop() || '');
      return seg ? decodeURIComponent(seg) : '';
    } catch {
      return '';
    }
  };
  const name = pick(finalUrl) || pick(fallbackUrl);
  if (!name) return '';
  try {
    return pure.safeFileName({ fileName: name, url: String(finalUrl || fallbackUrl || ''), boothId: '' });
  } catch {
    return name;
  }
}

// HEAD 在 BOOTH 的 /downloadables 上会跟到登录页（实测 200 sign_in、没有 content-length），
// 所以拿不到大小时再用 range: bytes=0-0 探一次：206 + content-range 里带真实总字节。
function libpfRangeBytes(headers) {
  const range = headers && typeof headers.get === 'function' ? String(headers.get('content-range') || '') : '';
  const total = /bytes\s+\d+-\d+\/(\d+)/i.exec(range);
  return total ? Number(total[1]) : 0;
}

// 文件名：优先 Content-Disposition，其次 URL 末段；都拿不到就让调用方兜底。
function libpfFileNameOf(headers, url, pure) {
  const disposition = headers && typeof headers.get === 'function' ? String(headers.get('content-disposition') || '') : '';
  const fromHeader = disposition ? String(disposition).match(/filename\*?=(?:UTF-8'')?"?([^\";]+)"?/i) : null;
  if (fromHeader && fromHeader[1]) {
    try {
      return pure.safeFileName({ fileName: decodeURIComponent(fromHeader[1]), url, boothId: '' });
    } catch {
      return '';
    }
  }
  try {
    return pure.safeFileName({ url, boothId: '' });
  } catch {
    return '';
  }
}

// ── 下载成功后自动认号 + 补封面 ─────────────────────────────────────────────
// 用户点「下载」往往就是想要这件素材进库；商品名/封面不该再等人工「用这个」。
// 规则：只认已购台账里有的号；已有人工绑定优先（绝不覆盖）；封面失败不影响下载本身。
function libpfLedgerItem(deps, boothId) {
  try {
    const parsed = JSON.parse(deps.fs.readFileSync(deps.path.join(deps.STATE_DIR, 'booth-purchases.json'), 'utf8'));
    const raw = parsed && parsed.items;
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
    return list.find((item) => String(item && item.boothId) === String(boothId)) || null;
  } catch {
    return null;
  }
}

// @bridge-function autoClaimAfterDownload:start
async function libpfAutoClaim(deps, input) {
  const out = { autoBound: false, coverSaved: false };
  const boothId = String((input && input.boothId) || '');
  const fileName = String((input && input.fileName) || '');
  try {
    const item = libpfLedgerItem(deps, boothId);
    // 台账里没有这个号：说明是用户自己的文件，别乱认。
    if (!item) return out;
    // key 必须和素材库同一算法：contentKeyFor(主件名, 主件字节数)。
    let key = '';
    try {
      const stat = deps.fs.statSync(deps.path.join(String(input.dirAbs || ''), fileName), { throwIfNoEntry: false });
      if (stat && stat.size > 0 && typeof deps.contentKeyFor === 'function') key = deps.contentKeyFor(fileName, stat.size);
    } catch {
      key = '';
    }
    const bindsPath = deps.path.join(deps.STATE_DIR, 'booth-binds.json');
    let binds;
    try {
      binds = deps.libraryBindsPure.normalizeBindTable(JSON.parse(deps.fs.readFileSync(bindsPath, 'utf8')));
    } catch {
      binds = deps.libraryBindsPure.normalizeBindTable({});
    }
    if (key && !deps.libraryBindsPure.bindOf(binds, key)) {
      deps.atomicWriteJson(bindsPath, deps.libraryBindsPure.setBind(binds, key, boothId, { title: String(item.title || ''), source: 'download-auto' }));
      out.autoBound = true;
    }
    // 封面：台账远程 coverUrl → 本地 `<主件stem>.thumbnail.jpg`（与批量补封面同一命名规则）。
    const coverUrl = String(item.coverUrl || '');
    if (/^https?:\/\//i.test(coverUrl) && deps.libraryFindPure && typeof deps.libraryFindPure.coverPlan === 'function') {
      const plan = deps.libraryFindPure.coverPlan({ boothId, dir: boothId, mainName: fileName });
      const target = plan && plan.relPath ? deps.path.join(deps.fileArchiveRootDir(), plan.relPath) : '';
      if (target && !deps.fs.existsSync(target)) {
        const res = await deps.fetch(coverUrl, {
          headers: { 'user-agent': 'Mozilla/5.0' },
          redirect: 'follow',
          signal: typeof deps.AbortSignal?.timeout === 'function' ? deps.AbortSignal.timeout(8000) : undefined
        });
        if (res && res.ok) {
          const buf = deps.Buffer.from(await res.arrayBuffer());
          if (buf.length > 0) {
            deps.fs.mkdirSync(deps.path.dirname(target), { recursive: true });
            deps.fs.writeFileSync(target, buf);
            out.coverSaved = true;
          }
        }
      }
    }
    deps.log('[下载] #' + boothId + ' 自动认号=' + (out.autoBound ? '是' : '否') + ' 封面=' + (out.coverSaved ? '已落盘' : '未落'));
  } catch (error) {
    deps.log('[下载] 自动认号/补封面失败（不影响下载）：' + (error && error.message ? error.message : error));
  }
  return out;
}
// @bridge-function autoClaimAfterDownload:end

function createLibraryPurchaseFiles(deps) {
  let buildLibraryPurchaseFiles = null;

  // 懒初始化：构造期不读 deps（test-bridge-modules 会拿「一访问就抛」的 deps 试构造）。
  const filesApi = () => {
    if (!buildLibraryPurchaseFiles) buildLibraryPurchaseFiles = buildPurchaseFiles(deps);
    return buildLibraryPurchaseFiles;
  };

  return {
    handleConsoleLibraryPurchaseFiles: (request) => {
      const api = filesApi();
      return api.handle(request);
    },
    listPurchaseFiles: (boothId, options) => filesApi().list(boothId, options),
    downloadPurchaseFile: (boothId, fileName) => filesApi().downloadPurchaseFile(boothId, fileName),
    autoClaimAfterDownload: (input) => libpfAutoClaim(deps, input),
  };
}

function buildPurchaseFiles(deps) {
  const pure = deps.boothDownloadPure || {};
  const pausePure = deps.boothPausePure || {};
  let lastFetchAt = 0;

  const throttle = async () => {
    const wait = 1200 - (Date.now() - lastFetchAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastFetchAt = Date.now();
  };

  const readPause = async () => {
    if (!pausePure.readPause || !pausePure.searchPauseState) return { paused: false };
    try {
      const rec = await pausePure.readPause({ fs: deps.fs, stateDir: deps.STATE_DIR, now: Date.now() });
      const state = pausePure.searchPauseState(rec, Date.now());
      if (!state || !state.paused) return { paused: false };
      return { paused: true, text: pausePure.pauseErrorMessage(rec, Date.now()), retryAfterMs: state.remainingMs };
    } catch {
      return { paused: false };
    }
  };

  const localNames = (boothId) => {
    const dir = deps.path.join(deps.fileArchiveRootDir(), String(boothId));
    try {
      return new Map(deps.fs.readdirSync(dir).map((name) => [String(name), (() => {
        try {
          return deps.fs.statSync(deps.path.join(dir, String(name))).size;
        } catch {
          return 0;
        }
      })()]));
    } catch {
      return new Map();
    }
  };

  const jobsIndexOf = () => {
    try {
      const raw = JSON.parse(deps.fs.readFileSync(deps.path.join(deps.STATE_DIR, 'booth-downloads.json'), 'utf8'));
      const map = new Map();
      for (const job of Array.isArray(raw && raw.jobs) ? raw.jobs : []) map.set(String(job.boothId), job);
      return map;
    } catch {
      return new Map();
    }
  };

  // 已购台账的标题兜底：清单页的卡片标题不一定解析得出来，但台账里一定有（items 是键→条目对象）。
  const ledgerTitle = (boothId) => {
    try {
      const parsed = JSON.parse(deps.fs.readFileSync(deps.path.join(deps.STATE_DIR, 'booth-purchases.json'), 'utf8'));
      const raw = parsed && parsed.items;
      const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
      const hit = list.find((item) => String(item && item.boothId) === String(boothId));
      return hit ? String(hit.title || '') : '';
    } catch {
      return '';
    }
  };

  const writeNegative = (cache, id, error) => {
    cache.items[id] = { boothId: id, negative: true, error: String(error || LIBPF_TIMEOUT_TEXT), fetchedAt: Date.now() };
    libpfSaveCache(deps, cache);
  };

  const readNegative = (cache, id, refresh) => {
    const row = cache.items[id];
    if (refresh || !row || row.negative !== true) return null;
    if (Date.now() - Number(row.fetchedAt || 0) >= LIBPF_NEGATIVE_TTL_MS) return null;
    return { ok: false, error: String(row.error || LIBPF_TIMEOUT_TEXT), cached: false, retryAfterMs: Math.max(0, LIBPF_NEGATIVE_TTL_MS - (Date.now() - Number(row.fetchedAt || 0))) };
  };

  const fetchPage = async (cookie, page, reqMs = LIBPF_REQ_TIMEOUT_MS) => {
    await throttle();
    const url = page <= 1 ? LIBPF_LIBRARY_URL : LIBPF_LIBRARY_URL + '?page=' + page;
    const res = await deps.fetch(url, {
      headers: { cookie, 'user-agent': LIBPF_UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: typeof deps.AbortSignal?.timeout === 'function' ? deps.AbortSignal.timeout(reqMs) : undefined,
    });
    if (res.status === 429 || res.status === 403) {
      const error = new Error('HTTP ' + res.status);
      error.status = res.status;
      throw error;
    }
    if (!res.ok) return { ok: false, status: res.status, html: '' };
    return { ok: true, html: deps.Buffer.from(await res.arrayBuffer()).toString('utf8') };
  };

  const findLinks = async (cookie, boothId, reqMs = LIBPF_REQ_TIMEOUT_MS) => {
    const seen = new Set();
    for (let page = 1; page <= LIBPF_MAX_PAGES; page += 1) {
      const got = await fetchPage(cookie, page, reqMs);
      if (!got.ok) break;
      const parsed = pure.parseOwnedListHtml(got.html);
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      const hit = items.find((item) => String(item.boothId) === boothId);
      if (hit) {
        const links = libpfCardLinks(got.html).get(boothId) || [];
        const fallback = hit.downloadUrl ? [String(hit.downloadUrl)] : [];
        return { title: String(hit.title || '') || ledgerTitle(boothId), links: links.length ? links.map((href) => libpfAbsUrl(LIBPF_LIBRARY_URL, href)) : fallback };
      }
      const decision = pure.nextPageDecision({ page, pageIds: parsed.ids, seenIds: Array.from(seen), hasNext: Boolean(parsed.hasNext) });
      for (const id of Array.isArray(parsed.ids) ? parsed.ids : []) seen.add(String(id));
      if (!decision || decision.stop || !decision.nextPage) break;
    }
    return null;
  };

  const itemPageLinks = async (cookie, boothId, reqMs = LIBPF_REQ_TIMEOUT_MS) => {
    await throttle();
    try {
      const res = await deps.fetch('https://booth.pm/ja/items/' + boothId, {
        headers: { cookie, 'user-agent': LIBPF_UA, accept: 'text/html' },
        redirect: 'follow',
        signal: typeof deps.AbortSignal?.timeout === 'function' ? deps.AbortSignal.timeout(reqMs) : undefined,
      });
      if (!res.ok) return [];
      const html = deps.Buffer.from(await res.arrayBuffer()).toString('utf8');
      const out = new Set();
      const re = new RegExp(LIBPF_LINK_RE.source, 'g');
      let m;
      while ((m = re.exec(html))) out.add(libpfAbsUrl('https://booth.pm/ja/items/' + boothId, m[1]));
      return Array.from(out);
    } catch {
      return [];
    }
  };

  // 真机实测：BOOTH 对 /downloadables 的 HEAD 会挂住（3s 超时）或跟到登录页且没有 content-length；
  // 而 `Range: bytes=0-0` 的 GET 会 206 回来、带 content-range 总字节 + S3 最终 URL（里面有真实文件名）。
  // 所以先走 range 探针，HEAD 只当兜底。
  const probeOne = async (cookie, url, reqMs = LIBPF_REQ_TIMEOUT_MS) => {
    await throttle();
    const signal = () => (typeof deps.AbortSignal?.timeout === 'function' ? deps.AbortSignal.timeout(reqMs) : undefined);
    try {
      const probe = await deps.fetch(url, { headers: { cookie, 'user-agent': LIBPF_UA, range: 'bytes=0-0' }, redirect: 'follow', signal: signal() });
      const fileName = libpfFileNameOf(probe.headers, probe.url || url, pure) || libpfNameFromUrl(probe.url, url, pure);
      const bytes = libpfRangeBytes(probe.headers) || (probe.status === 206 ? Number(probe.headers.get('content-length') || 0) + 1 : 0);
      if (fileName && bytes > 0) return { fileName, bytes };
      // 兜底：个别链接不吃 range，再试 HEAD（慢，但至少有机会拿到 content-length）。
      const head = await deps.fetch(url, { method: 'HEAD', headers: { cookie, 'user-agent': LIBPF_UA }, redirect: 'follow', signal: signal() });
      const length = Number(head.headers.get('content-length') || 0);
      return { fileName: fileName || libpfFileNameOf(head.headers, head.url || url, pure), bytes: bytes || (Number.isFinite(length) ? length : 0) };
    } catch {
      return { fileName: '', bytes: 0 };
    }
  };

// @bridge-function listPurchaseFiles:start
  const list = async (boothId, options = {}) => {
    const id = String(boothId || '').trim();
    if (!/^\d{5,9}$/.test(id)) return { ok: false, error: '商品号要是 5~9 位数字（收到的是「' + id + '」）' };
    const pause = await readPause();
    if (pause.paused) return { ok: false, paused: true, error: pause.text, retryAfterMs: pause.retryAfterMs };
    const cookie = libpfCookie(deps);
    if (!cookie) return { ok: false, error: '还没保存 BOOTH Cookie：先去「账号」里登录或粘贴 Cookie' };
    const cache = libpfLoadCache(deps);
    const negative = readNegative(cache, id, options.refresh);
    if (negative) return negative;
    const hit = cache.items[id];
    if (!options.refresh && hit && !hit.negative && Number(hit.fetchedAt) && Date.now() - Number(hit.fetchedAt) < LIBPF_CACHE_TTL_MS) {
      return { ok: true, boothId: id, title: String(hit.title || '') || ledgerTitle(id), files: hit.files || [], dir: deps.path.join(deps.fileArchiveRootDir(), id), fetchedAt: Number(hit.fetchedAt), cached: true };
    }
    let listed = null;
    let links = [];
    // 台账里有的号是「用户真的买过」，值得多等一会儿（BOOTH 的下载链接探测本身要 6s）；
    // 陌生号大概率根本不在已购里，守 6s 护栏别让前端一直转圈。
    const isKnown = Boolean(libpfLedgerItem(deps, id));
    const reqMs = isKnown ? LIBPF_KNOWN_REQ_TIMEOUT_MS : LIBPF_REQ_TIMEOUT_MS;
    const totalMs = isKnown ? LIBPF_KNOWN_TOTAL_TIMEOUT_MS : LIBPF_TOTAL_TIMEOUT_MS;
    try {
      await libpfRaceTimeout((async () => {
        listed = await findLinks(cookie, id, reqMs);
        links = listed && Array.isArray(listed.links) ? listed.links : [];
        if (!links.length) links = await itemPageLinks(cookie, id, reqMs);
      })(), totalMs, LIBPF_TIMEOUT_TEXT);
    } catch (error) {
      if (error && (error.status === 429 || error.status === 403)) {
        return { ok: false, paused: true, error: 'BOOTH 正在限速暂停，稍后再试', retryAfterMs: 60000 };
      }
      // BOOTH 打不动时，宁可给「上次抓到的清单」也不要把已购件搞成打不开：
      // 6s 超时是给陌生号的护栏，不该把已知商品的功能一起牺牲掉。
      const stale = cache.items[id];
      if (stale && !stale.negative && Array.isArray(stale.files) && stale.files.length) {
        deps.log('[已购文件] #' + id + ' 抓取失败，用上次清单兜底（fetchedAt=' + Number(stale.fetchedAt || 0) + '）');
        // 兜底也刷一下时间戳：否则每次进来都要再等 6s 才超时，用户会以为「下载中心卡了」。
        cache.items[id] = { ...stale, fetchedAt: Date.now() };
        libpfSaveCache(deps, cache);
        return { ok: true, boothId: id, title: String(stale.title || '') || ledgerTitle(id), files: stale.files, dir: deps.path.join(deps.fileArchiveRootDir(), id), fetchedAt: Date.now(), cached: true, stale: true };
      }
      // 超时/网络失败：返回统一人话并写 60s 负缓存，同一号 60s 内不再打网。
      writeNegative(cache, id, LIBPF_TIMEOUT_TEXT);
      deps.log('[已购文件] #' + id + ' ' + LIBPF_TIMEOUT_TEXT + '：' + (error && error.message ? error.message : error));
      return { ok: false, error: LIBPF_TIMEOUT_TEXT, cached: false };
    }
    const title = (listed && listed.title) || '';
    if (!links.length) return { ok: false, error: '没在已购页找到下载链接（可能已下架，或还在别的账号里）' };
    const locals = localNames(id);
    const jobs = jobsIndexOf();
    const job = jobs.get(id);
    const files = [];
    for (const url of links.slice(0, LIBPF_MAX_LINKS)) {
      const head = await probeOne(cookie, url, reqMs);
      const fileName = head.fileName || String(url).split('/').pop() || 'download';
      // 本地文件名不一定等于 BOOTH 的 S3 名（老下载按 downloadables id 命名过），字节一样也算已下。
      const localBytes = locals.get(fileName) || (function () {
        if (!(head.bytes > 0)) return 0;
        for (const size of locals.values()) if (size === head.bytes) return size;
        return 0;
      })();
      const jobDone = Boolean(job && job.state === 'done' && String(job.fileName || job.name || '') === fileName && Number(job.bytes) > 0);
      files.push({ fileName, url: String(url), bytes: head.bytes || localBytes || 0, state: localBytes > 0 || jobDone ? 'downloaded' : 'pending' });
    }
    const fetchedAt = Date.now();
    if (!libpfFilesComplete(files)) {
      writeNegative(cache, id, 'BOOTH 返回的文件信息不完整（缺文件名或大小），稍后再试');
      deps.log('[已购文件] #' + id + ' 清单不完整，不写缓存：' + JSON.stringify(files.slice(0, 3)));
      return { ok: false, error: 'BOOTH 返回的文件信息不完整（缺文件名或大小），稍后再试', cached: false };
    }
    cache.items[id] = { boothId: id, title, files, fetchedAt };
    libpfSaveCache(deps, cache);
    return { ok: true, boothId: id, title, files, dir: deps.path.join(deps.fileArchiveRootDir(), id), fetchedAt, cached: false };
  };

// @bridge-function listPurchaseFiles:end

  // 单件下载（指定文件名）：本地已有同大小文件就不覆盖；否则按清单里的链接入队。
// @bridge-function downloadPurchaseFile:start
  const downloadPurchaseFile = async (boothId, fileName) => {
    const name = String(fileName || '').trim();
    if (!name || /[\\/:*?"<>|]/.test(name)) return { ok: false, status: 400, error: '文件名不合法' };
    const dir = deps.path.join(deps.fileArchiveRootDir(), String(boothId));
    const target = deps.path.join(dir, name);
    const stat = deps.fs.statSync(target, { throwIfNoEntry: false });
    if (stat && stat.size > 0) return { ok: true, already: true, skipped: true, reason: 'file_exists', path: target, bytes: stat.size };
    const listed = await list(boothId, { refresh: false });
    if (!listed.ok) return { ok: false, status: listed.paused ? 409 : 400, error: listed.error };
    const file = (listed.files || []).find((one) => one.fileName === name);
    if (!file) return { ok: false, status: 404, error: '没在已购页找到这个文件（先刷新文件清单试试）' };
    const started = await deps.downloadStart(boothId, file.url, 'purchase', listed.title, name);
    if (!started || started.ok === false) return { ok: false, status: 502, error: String((started && started.error) || '入队失败') };
    return { ok: true, queued: Boolean(started.queued), already: Boolean(started.already), skipped: Boolean(started.skipped), reason: String(started.reason || ''), path: String(started.path || '') };
  };

// @bridge-function downloadPurchaseFile:end

// @bridge-function handleConsoleLibraryPurchaseFiles:start
  async function handleConsoleLibraryPurchaseFiles(request) {
    const url = new URL(String(request && request.url ? request.url : ''), 'http://127.0.0.1');
    if (url.pathname !== '/api/library/purchase-files') return false;
    const headers = request && request.headers ? request.headers : {};
    if (headers['x-agent-token'] || headers['x-agent-call']) {
      request.sendJson({ ok: false, error: '未授权：文件清单是管理端操作' }, 403);
      return true;
    }
    if (request.method !== 'GET') {
      request.sendJson({ ok: false, error: '该接口只支持 GET' }, 405);
      return true;
    }
    const boothId = url.searchParams.get('boothId') || '';
    const refresh = url.searchParams.get('refresh') === '1';
    let result;
    try {
      result = await list(boothId, { refresh });
    } catch (error) {
      request.sendJson({ ok: false, error: '抓文件清单失败：' + (error && error.message ? error.message : error) }, 500);
      return true;
    }
    const status = result.paused ? 409 : result.ok ? 200 : 400;
    request.sendJson(result, status);
    return true;
  }
// @bridge-function handleConsoleLibraryPurchaseFiles:end

  return { list, handle: handleConsoleLibraryPurchaseFiles, downloadPurchaseFile };
}

export { createLibraryPurchaseFiles };
