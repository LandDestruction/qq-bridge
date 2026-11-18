// 「以图搜源」：拿素材自己的封面当查询，反向去 BOOTH 搜同名/同图商品。
//
// 为什么单独一个模块：这是「素材 → BOOTH 商品号」的第二条发现链路（第一条是标题找号）。
// 和小工具库里那种图搜不同，这里不需要向量库：BOOTH 搜索页仍然按标题召回，封面指纹只在
// 候选里做否决/加分（dHash 汉明距），所以整条链路可以只用既有纯规则 + 一次网络往返。
//
// Live dependencies: AbortSignal, STATE_DIR, atomicWriteJson, boothCacheDir, boothSearchPure, buildLibrarySnapshot, dhashFromBufferAsync, fetch, fileArchiveDb, fileArchiveRootDir, fs, getBoothCover, libraryFindPure, listArchive, log, path, safeResolveInside
//
// VM 里没有 import：纯规则（BOOTH 搜索页解析/标题相似度/候选排序）全走 deps.boothSearchPure，
// 暂停闸规则走 deps.libraryFindPure，指纹算力走 deps.dhashFromBufferAsync。构造期不许碰 deps
// （审计沙箱给每个声明依赖装了「一碰就抛」的 getter），所以工厂函数只捕获 deps，第一次处理
// 请求时才 build。

const FINDBYIMG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
/** 搜索页超时：BOOTH 正常 1~3 秒，12 秒还没给就放弃（别把控制台请求卡死）。 */
const FINDBYIMG_TIMEOUT_MS = 12000;
/** 搜索页体积上限：正常 300~600KB，3MB 以上基本是被塞了跳转墙。 */
const FINDBYIMG_MAX_BYTES = 3 * 1024 * 1024;
/** 两次联网之间至少隔这么久（和找号同一套礼貌值）。 */
const FINDBYIMG_RATE_LIMIT_MS = 900;
/** 只给最像的前几个候选算远端封面指纹：每算一个都要下载一张图，不能全量。 */
const FINDBYIMG_COVER_TOP_N = 6;
/** 回给前端的候选上限。 */
const FINDBYIMG_CANDIDATE_MAX = 12;
/** 一次最多搜几个词（词越多越慢，也越容易撞限速）。 */
const FINDBYIMG_QUERY_MAX = 3;
const FINDBYIMG_PAUSE_FILE = 'booth-search-pause.json';
const FINDBYIMG_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// @bridge-function handleConsoleLibraryFindByImage:start
async function handleFindByImageRoutes(ctx, request) {
  const { deps } = ctx;
  if (request.url.pathname !== '/api/library/find-by-image') return false;
  if (request.req.headers['x-agent-token'] || request.req.headers['x-agent-call']) {
    request.sendJson({ ok: false, error: '以图搜源只允许管理端操作' }, 403);
    return true;
  }
  if (request.req.method !== 'POST') {
    request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405);
    return true;
  }
  let body;
  try {
    body = await request.readBody();
  } catch (error) {
    request.sendJson({ ok: false, error: error?.message ?? '请求体非法' }, Number(error?.statusCode) || 400);
    return true;
  }
  const local = await ctx.localCoverOf(body);
  if (local.error) {
    request.sendJson({ ok: false, error: local.error }, local.status || 400);
    return true;
  }
  const queries = ctx.queriesFor(body, local);
  if (!queries.length) {
    request.sendJson({ ok: false, error: '这件没有标题，也没有给 queries（搜索词）', localHash: local.hash }, 400);
    return true;
  }
  const paused = ctx.pausedNow();
  if (paused.paused) {
    request.sendJson({ ok: false, paused: true, ...ctx.pauseBody(paused, local, queries) });
    deps.log(`以图搜源：BOOTH 搜索被暂停，拒绝联网（${local.key || local.hash.slice(0, 8)}）`);
    return true;
  }
  const found = await ctx.searchByQueries(queries);
  if (found.paused) {
    request.sendJson({ ok: false, paused: true, ...ctx.pauseBody(found.pause, local, queries) });
    return true;
  }
  const ranked = await ctx.rankFor(local, found.items);
  request.sendJson({
    ok: true,
    paused: false,
    key: local.key,
    localHash: local.hash,
    queries,
    searched: found.searched,
    total: found.items.length,
    errors: found.errors,
    candidates: ranked.candidates,
    summary: ranked.summary
  });
  return true;
}
// @bridge-function handleConsoleLibraryFindByImage:end

/**
 * 逐个搜索词抓一页，按 boothId 去重。任何一个词撞上保护闸就整体回 paused
 * （继续搜只会把限速时间越拖越长）。
 */
async function findByImageSearch(ctx, queries) {
  const items = [];
  const seen = new Set();
  const errors = [];
  let searched = 0;
  for (const phrase of queries) {
    const got = await ctx.fetchSearchPage(phrase);
    if (got.paused) return { paused: true, pause: got.pause, items, errors, searched };
    if (!got.ok) {
      errors.push(got.error);
      continue;
    }
    searched += 1;
    for (const item of got.page?.items || []) {
      const id = String(item?.boothId || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push(item);
    }
  }
  return { paused: false, items, errors, searched };
}

/** 候选封面指纹：走 getBoothCover（自带缓存 + 限速 + 失败降级），算不出来就当没有。 */
async function findByImageCoverHash(ctx, boothId) {
  const deps = ctx.deps;
  try {
    const cacheRoot = String(deps.boothCacheDir?.() || '');
    const got = await deps.getBoothCover(String(boothId), {
      cacheRoot,
      rateLimitMs: FINDBYIMG_RATE_LIMIT_MS,
      log: (message) => deps.log(message)
    });
    if (!got?.ok || !got.path) return '';
    return await ctx.hashOfFile(got.path);
  } catch {
    return '';
  }
}

/**
 * 排序：先用标题把候选排一遍，只给最像的前 N 个算远端封面指纹（每算一个都要下载一张图），
 * 再交给 booth-search 的 rankBoothCandidates 统一打分（标题/封面/店铺三档权重）。
 */
async function findByImageRank(ctx, local, items) {
  const deps = ctx.deps;
  const pure = deps.boothSearchPure || {};
  const titleScoreOf = (title) => (typeof pure.titleSimilarity === 'function' ? pure.titleSimilarity(local.title, title) : 0);
  const byTitle = items
    .map((item) => ({ item, titleScore: titleScoreOf(item.title) }))
    .sort((a, b) => b.titleScore - a.titleScore);
  const coverHashes = {};
  for (const entry of byTitle.slice(0, FINDBYIMG_COVER_TOP_N)) {
    const hash = await ctx.coverHashOf(entry.item.boothId);
    if (hash) coverHashes[String(entry.item.boothId)] = hash;
  }
  const ranked = typeof pure.rankBoothCandidates === 'function'
    ? pure.rankBoothCandidates({ title: local.title, shop: local.shop || '', candidates: items, coverHash: local.hash, coverHashes })
    : byTitle.map((entry) => ({ ...entry.item, titleScore: entry.titleScore, score: entry.titleScore, coverDistance: null }));
  const candidates = ranked.slice(0, FINDBYIMG_CANDIDATE_MAX).map((item) => ({
    boothId: String(item.boothId || ''),
    title: String(item.title || ''),
    shopName: String(item.shopName || ''),
    price: item.price === null || item.price === undefined ? null : Number(item.price),
    itemUrl: String(item.itemUrl || ''),
    thumbUrl: String(item.thumbUrl || ''),
    coverDistance: item.coverDistance === null || item.coverDistance === undefined ? null : Number(item.coverDistance),
    titleScore: Number(item.titleScore) || 0,
    score: Number(item.score) || 0,
    coverMatch: Boolean(item.coverMatch),
    reasons: Array.isArray(item.reasons) ? item.reasons.map(String) : []
  }));
  const best = candidates[0] || null;
  const summary = !candidates.length
    ? '一个候选都没有（BOOTH 上没搜到同名的）'
    : `共 ${items.length} 个候选，最像的是 ${best.boothId}（封面距 ${best.coverDistance === null ? '未知' : best.coverDistance}，标题相似 ${Math.round(best.titleScore * 100)}%）`;
  return { candidates, summary };
}

/**
 * 工厂：只捕获 deps，第一次处理请求时才装配闭包（VM 依赖 getter 构造期会抛）。
 * @param {object} deps 见文件头 Live dependencies
 */
export function createLibraryFindByImage(deps) {
  let impl = null;
  const implOf = () => impl || (impl = buildFindByImage(deps));
  return { handleConsoleLibraryFindByImage: (request) => implOf().handleConsoleLibraryFindByImage(request) };
}

function buildFindByImage(deps) {
  const booth = deps.boothSearchPure || {};
  const findPure = deps.libraryFindPure || {};
  const {
    buildBoothSearchUrl, parseBoothSearchHtml, searchPhrasesFor, rankBoothCandidates
  } = booth;
  const { normalizeSearchPause, searchPauseState, searchPauseFor, describeSearchPause } = findPure;
  let lastNetworkAt = 0;

  function pausePath() {
    return deps.path.join(deps.STATE_DIR, FINDBYIMG_PAUSE_FILE);
  }

  // 暂停闸是「全站一个」：找号和我共用同一份 state/booth-search-pause.json，
  // 这样被 BOOTH 限速时谁也别再敲（两个功能各自暂停会互相把对方推进墙里）。
  function readPause() {
    try {
      return normalizeSearchPause(JSON.parse(deps.fs.readFileSync(pausePath(), 'utf8')));
    } catch {
      return normalizeSearchPause(null);
    }
  }

  function writePause(pause) {
    try {
      deps.atomicWriteJson(pausePath(), pause);
    } catch (error) {
      deps.log(`以图搜源：暂停状态写盘失败：${error?.message ?? error}`);
    }
    return pause;
  }

  function pausedNow() {
    return searchPauseState(readPause(), Date.now());
  }

  function notePause(status, res) {
    const retryAfter = Number(res?.headers?.get?.('retry-after')) || null;
    const hit = searchPauseFor({ status, retryAfter });
    if (!hit) return null;
    const now = Date.now();
    const pause = { pausedUntil: now + hit.pauseMs, reason: hit.reason, status: hit.status, at: now };
    writePause(pause);
    deps.log(`以图搜源触发保护闸：${describeSearchPause(pause, now)}`);
    return pause;
  }

  function pauseBody(pause, local, queries) {
    const now = Date.now();
    const text = describeSearchPause(pause, now);
    return {
      key: local.key || '',
      localHash: local.hash,
      queries,
      candidates: [],
      retryAfterMs: Math.max(0, Number(pause?.pausedUntil || 0) - now),
      reason: String(pause?.reason || ''),
      error: text,
      summary: text
    };
  }

  function libraryRoot() {
    const raw = typeof deps.fileArchiveRootDir === 'function' ? deps.fileArchiveRootDir() : deps.fileArchiveRootDir;
    const dir = String(raw || '').trim();
    return dir ? deps.path.resolve(dir) : '';
  }

  function currentSnapshot() {
    const rootDir = libraryRoot();
    if (!rootDir) throw new Error('转存目录还没配（config.json 的 fileArchive.dir）');
    let rows = [];
    try {
      const db = deps.fileArchiveDb();
      if (db) rows = deps.listArchive(db, { limit: 5000, offset: 0 });
    } catch (error) {
      deps.log(`以图搜源读台账失败（只按盘面）：${error?.message ?? error}`);
    }
    return deps.buildLibrarySnapshot({ fs: deps.fs, rootDir, rows });
  }

  function cardOf(key) {
    const snapshot = currentSnapshot();
    const list = Array.isArray(snapshot?.assets) ? snapshot.assets : [];
    return list.find((card) => String(card?.key || '') === key) || null;
  }

  async function hashOfFile(abs) {
    try {
      const buf = deps.fs.readFileSync(abs);
      const hash = await deps.dhashFromBufferAsync(buf);
      return String(hash || '');
    } catch (error) {
      deps.log(`以图搜源：封面指纹算不出来：${error?.message ?? error}`);
      return '';
    }
  }

  async function hashOfCard(card) {
    const rel = String(card?.thumbRel || '');
    if (!rel) return '';
    try {
      const abs = deps.safeResolveInside(libraryRoot(), rel);
      if (!deps.fs.existsSync(abs)) return '';
      return await hashOfFile(abs);
    } catch {
      return '';
    }
  }

  /** imageUrl 既支持外部图片地址，也支持本机相对地址（/api/files/raw?rel=…）。 */
  async function hashOfUrl(imageUrl) {
    const url = String(imageUrl || '').trim();
    if (!url) return '';
    if (url.startsWith('/api/')) {
      const rel = relativeFromApiUrl(url);
      if (!rel) return '';
      try {
        const abs = deps.safeResolveInside(libraryRoot(), rel);
        if (!deps.fs.existsSync(abs)) return '';
        return await hashOfFile(abs);
      } catch {
        return '';
      }
    }
    if (!/^https?:\/\//i.test(url)) return '';
    try {
      const res = await deps.fetch(url, {
        headers: { 'user-agent': FINDBYIMG_UA, accept: 'image/*' },
        signal: deps.AbortSignal.timeout(FINDBYIMG_TIMEOUT_MS)
      });
      if (!res.ok) return '';
      // 不用 Buffer（VM 里不一定有）：Uint8Array 能直接喂给 dHash 的 stdin。
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length || bytes.length > FINDBYIMG_MAX_BYTES) return '';
      return await deps.dhashFromBufferAsync(bytes);
    } catch (error) {
      deps.log(`以图搜源：图片下载失败：${error?.message ?? error}`);
      return '';
    }
  }

  async function localCoverOf(body) {
    const key = String(body?.key ?? '').trim();
    const imageUrl = String(body?.imageUrl ?? '').trim();
    if (!key && !imageUrl) return { error: '缺少 key 或 imageUrl（给素材 key，或直接给一张图）', status: 400 };
    if (key) {
      let card = null;
      try {
        card = cardOf(key);
      } catch (error) {
        return { error: error?.message ?? '读素材库失败', status: 500 };
      }
      if (!card) return { error: '素材库里找不到这件（可能刚被移动或改名）', status: 404 };
      const hash = await hashOfCard(card);
      if (!hash) return { error: '这件没有封面，先补封面', status: 400 };
      return { key, title: String(card.title || ''), shop: String(card.shopName || ''), hash, card };
    }
    const hash = await hashOfUrl(imageUrl);
    if (!hash) return { error: '这张图读不出指纹（可能不是图片，或者下载失败）', status: 400 };
    return { key: '', title: String(body?.title || ''), shop: '', hash, card: null };
  }

  function queriesFor(body, local) {
    const out = [];
    const push = (value) => {
      const q = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (q && !out.includes(q)) out.push(q);
    };
    if (local.title) {
      const generated = typeof searchPhrasesFor === 'function'
        ? searchPhrasesFor({ title: local.title, shop: local.shop || '', boothId: String(local.card?.boothId || '') })
        : [];
      for (const phrase of generated) push(phrase);
    }
    const given = Array.isArray(body?.queries) ? body.queries : [];
    for (const phrase of given) push(phrase);
    return out.slice(0, FINDBYIMG_QUERY_MAX);
  }

  async function throttle() {
    const wait = FINDBYIMG_RATE_LIMIT_MS - (Date.now() - lastNetworkAt);
    if (wait > 0) await FINDBYIMG_SLEEP(wait);
    lastNetworkAt = Date.now();
  }

  async function fetchSearchPage(phrase) {
    await throttle();
    let url;
    try {
      url = buildBoothSearchUrl({ query: phrase, page: 1 });
    } catch (error) {
      return { ok: false, phrase, url: '', error: error?.message ?? '搜索词非法' };
    }
    let res;
    try {
      res = await deps.fetch(url, {
        headers: {
          'user-agent': FINDBYIMG_UA,
          'accept-language': 'zh-CN',
          accept: 'text/html,application/xhtml+xml'
        },
        signal: deps.AbortSignal.timeout(FINDBYIMG_TIMEOUT_MS)
      });
    } catch (error) {
      return { ok: false, phrase, url, error: `搜索请求失败：${error?.message ?? error}` };
    }
    const status = Number(res?.status) || 0;
    if (status === 404) return { ok: false, phrase, url, error: '搜索页 404（BOOTH 换了地址）' };
    if (status < 200 || status >= 300) {
      const hit = notePause(status, res);
      if (hit) return { ok: false, phrase, url, paused: true, pause: hit };
      return { ok: false, phrase, url, error: `搜索页 HTTP ${status}` };
    }
    let text = '';
    try {
      text = await res.text();
    } catch (error) {
      return { ok: false, phrase, url, error: `搜索页读取失败：${error?.message ?? error}` };
    }
    if (text.length > FINDBYIMG_MAX_BYTES) return { ok: false, phrase, url, error: '搜索页超过 3MB 上限' };
    let page;
    try {
      page = parseBoothSearchHtml(text);
    } catch (error) {
      return { ok: false, phrase, url, error: `搜索页解析失败：${error?.message ?? error}` };
    }
    return { ok: true, phrase, url, page };
  }

  const routeCtx = {
    deps, readPause, writePause, pausedNow, pauseBody, cardOf, localCoverOf, queriesFor,
    fetchSearchPage, hashOfFile,
    coverHashOf: (boothId) => findByImageCoverHash(routeCtx, boothId)
  };
  // 搜索与打分放模块作用域：工厂函数有 300 行规模闸，而它们只依赖 ctx 上已有的闭包。
  routeCtx.searchByQueries = (queries) => findByImageSearch(routeCtx, queries);
  routeCtx.rankFor = (local, items) => findByImageRank(routeCtx, local, items);
  return { handleConsoleLibraryFindByImage: (request) => handleFindByImageRoutes(routeCtx, request) };
}

/** 从 `/api/files/raw?rel=…` 里取出 rel（换机器/换端口也能读本机封面）。 */
function relativeFromApiUrl(url) {
  const text = String(url || '');
  const index = text.indexOf('rel=');
  if (index < 0) return '';
  try {
    return decodeURIComponent(text.slice(index + 4).split('&')[0]);
  } catch {
    return '';
  }
}
