// 找号（P3）：没号/号可疑的素材 → BOOTH 候选列表，人点一下就钉死。
//
// 这一层只做三件事：抓搜索页、算封面指纹、读写 state/booth-binds.json。
// 纯规则在 src/booth-search.js（排序/自动勾选）与 src/library-binds.js（绑定表）、
// src/library-find.js（裁剪/描述）—— 三个都有单测，这里不重复造。
//
// 为什么纯规则不 import、而是走 deps 注入：桥接模块被 vm.runInContext 裸执行，
// **不能出现 import 语句**（否则 audit-bridge-harness / 各回归套件在装配阶段就
// SyntaxError）。所以 booth-search / library-binds / library-find 三个纯模块由
// src/bridge.js 组装成 deps.boothSearchPure / libraryBindsPure / libraryFindPure 传进来，
// 单元测试里也是同一个口径（假 deps 直接塞进来即可）。

const LIBFIND_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const LIBFIND_CACHE_TTL_MS = 10 * 60 * 1000;
const LIBFIND_SEARCH_MAX_BYTES = 3 * 1024 * 1024;
const LIBFIND_SEARCH_TIMEOUT_MS = 12000;
const LIBFIND_COVER_TOP_N = 4;          // 只给前几名算封面指纹：每张都要抓一次 BOOTH 页面（限速 1s）
const LIBFIND_RATE_LIMIT_MS = 900;
const LIBFIND_PAUSE_FILE = 'booth-search-pause.json';   // 全局搜索暂停（429/403）

const LIBFIND_SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

// 批量找号单独成一个工厂：核心逻辑和「单件找号」分开，createLibraryFind 才不会顶过函数行长基线。
// findFor 与 snapshot 由 createLibraryFind 传进来，这里不碰搜索细节。
function createLibraryBatch(deps, pure, findPure, findFor, snapshot, pausedNow) {
  const { normalizeBatchState, batchPending, markBatchEntry, batchProgress, describeBatchProgress } = pure;
  // 失败码规则与单件找号同一份（src/library-find.js），批量和单件不能各猜一套。
  const { failureCodeOf } = findPure;
  const batchStatePath = () => deps.path.join(String(deps.STATE_DIR), 'booth-batchfind.json');
  const job = {
    running: false, startedAt: 0, finishedAt: 0, total: 0, done: 0, keys: [], lastError: '',
    paused: false, pauseReason: '', retryAfterMs: 0
  };

  function readState() {
    try {
      return normalizeBatchState(JSON.parse(deps.fs.readFileSync(batchStatePath(), 'utf8')));
    } catch {
      return normalizeBatchState(null);
    }
  }

  function writeState(state) {
    try {
      deps.atomicWriteJson(batchStatePath(), state);
    } catch (error) {
      deps.log(`批量找号写盘失败：${error?.message ?? error}`);
    }
    return state;
  }

  function summary() {
    const state = readState();
    const progress = batchProgress(state);
    const pause = pausedNow();
    return {
      ok: true,
      running: job.running,
      job: {
        startedAt: job.startedAt, finishedAt: job.finishedAt, total: job.total, done: job.done,
        lastError: job.lastError, paused: job.paused, pauseReason: job.pauseReason
      },
      progress,
      paused: pause.paused,
      pause: { reason: pause.reason || job.pauseReason || '', retryAfterMs: pause.remainingMs || job.retryAfterMs || 0 },
      text: describeBatchProgress(progress, { running: job.running })
    };
  }

  function pickPatch(result) {
    const top = result.candidates && result.candidates[0] ? result.candidates[0] : null;
    const patch = {
      at: Date.now(),
      pick: result.pick || (result.auto && top ? String(top.boothId) : ''),
      auto: Boolean(result.auto),
      score: top ? Number(top.score) || 0 : 0,
      title: top ? String(top.title || '') : '',
      reason: String(result.reason || ''),
      candidates: result.candidates ? result.candidates.length : 0,
      // 失败码给前端「只重试失败」用：限流/超时/无候选/标题不可搜。
      reasonCode: failureCodeOf({
        paused: Boolean(result.paused),
        candidates: result.candidates ? result.candidates.length : 0,
        errors: result.errors || []
      })
    };
    return patch;
  }

  /** 把异常归成失败码：标题不可搜是抛错（没短语），其余靠文本里有没有「超时」。 */
  function failureCodeOfError(error) {
    const text = String(error?.message ?? error ?? '');
    if (/没有可搜/.test(text)) return 'no_phrase';
    return failureCodeOf({ errors: [text] });
  }

  // 批量主流程在模块作用域（libRunBatch）：这里同样只装配 ctx，run 的签名/语义不变。
  const runCtx = {
    deps, job, readState, writeState, snapshot, pausedNow, findFor,
    pickPatch, failureCodeOfError, markBatchEntry
  };

  return {
    summary,
    run: (keys) => libRunBatch(runCtx, keys),
    running: () => job.running,
    stop() { job.running = false; },
    clear() {
      job.running = false;
      writeState(normalizeBatchState(null));
      deps.log('批量找号：清空记录');
    },
    pending(assets, opts) {
      return batchPending(assets || [], readState(), opts);
    }
  };
}

// @bridge-function handleConsoleLibraryFind:start
async function handleFindRoutes(ctx, request) {
  // 路由处理放模块作用域：工厂函数本身有 300 行规模闸，路由分派属于「怎么读请求」，
  // 和刷盘/搜索细节无关，搬出来不改任何行为（ctx 就是工厂里那几个闭包).
  const {
    deps, batchFind, readBinds, writeBinds, findCache, findFor,
    pausedNow, readPause, writePause, enrichAfterBind, currentSnapshot,
    setBind, removeBind, bindOf, bindCount, bindTableSummary,
    normalizeSearchPause, describeSearchPause,
    readRenames, writeRenames, renameApi
  } = ctx;
    const p = request.url.pathname;
    const isFind = p === '/api/library/find';
    const isBinds = p === '/api/library/binds';
    const isBind = p === '/api/library/bind' || p === '/api/library/unbind';
    const isBatch = p === '/api/library/batchfind' || p === '/api/library/batchfind/stop' || p === '/api/library/batchfind/clear';
    const isPause = p === '/api/library/search-pause';
    const isRename = p === '/api/library/rename' || p === '/api/library/rename/preview' || p === '/api/library/rename/undo';
    if (!isFind && !isBinds && !isBind && !isBatch && !isPause && !isRename) return false;
    if (request.req.headers['x-agent-token'] || request.req.headers['x-agent-call']) {
      request.sendJson({ ok: false, error: '找号/绑定/改名只允许管理端操作' }, 403);
      return true;
    }
    // 改名是「真动磁盘」的写操作，连预览都算管理操作（预览会把磁盘上的真实路径回给前端）。
    if (isRename) {
      // 改名路由的实现在 src/library-rename.js（同一份规则 + 动盘逻辑），这里只做分派。
      if (typeof renameApi?.handleRenameRoutesFor !== 'function') {
        request.sendJson({ ok: false, error: '改名规则模块没装配（libraryRenamePure 缺失）' }, 503);
        return true;
      }
      return renameApi.handleRenameRoutesFor(ctx, request);
    }

    if (isPause) {
      if (request.req.method === 'GET') {
        // at = 这次暂停从什么时候开始（毫秒时间戳），前端用它显示「已暂停 N 分钟」；
        // 没暂停时是 0。pausedUntil/remainingMs 只回答「还要等多久」，回答不了「从何时起」。
        const pause = readPause();
        request.sendJson({ ok: true, ...pausedNow(), at: Number(pause?.at) || 0, text: describeSearchPause(pause, Date.now()) });
        return true;
      }
      if (request.req.method !== 'POST') { request.sendJson({ ok: false, error: '该接口只支持 GET/POST' }, 405); return true; }
      writePause(normalizeSearchPause(null));
      deps.log('找号：手动解除 BOOTH 搜索暂停');
      request.sendJson({ ok: true, cleared: true, ...pausedNow() });
      return true;
    }

    if (isBinds) {
      if (request.req.method !== 'GET') { request.sendJson({ ok: false, error: '该接口只支持 GET' }, 405); return true; }
      const table = readBinds();
      request.sendJson({ ok: true, table, summary: bindTableSummary(table), count: bindCount(table) });
      return true;
    }

    if (isBind) {
      if (request.req.method !== 'POST') { request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }
      let body;
      try { body = await request.readBody(); }
      catch (error) { request.sendJson({ ok: false, error: error?.message ?? '请求体非法' }, Number(error?.statusCode) || 400); return true; }
      const key = String(body?.key ?? '').trim();
      if (!key) { request.sendJson({ ok: false, error: '缺少 key（素材的 contentKey）' }, 400); return true; }
      try {
        if (p === '/api/library/unbind') {
          const next = removeBind(readBinds(), key);
          writeBinds(next);
          findCache.delete(key);
          deps.log(`素材库：解绑 ${key}`);
          request.sendJson({ ok: true, key, count: bindCount(next), summary: bindTableSummary(next) });
          return true;
        }
        const boothId = String(body?.boothId ?? '').trim();
        const title = String(body?.title ?? '').slice(0, 200);
        const next = setBind(readBinds(), key, boothId, { title, source: 'manual' });
        writeBinds(next);
        findCache.delete(key);
        deps.log(`素材库：把 ${key} 绑定到 BOOTH ${boothId}`);
        // 绑定后异步补资料 + 本地封面：没有本地封面指纹时排名天花板只有 0.85×titleScore，
        // 自动采纳永远过不了阈值，用户点一次「绑定」就得把这两样补齐，不能等下次手动找号。
        void enrichAfterBind(key, boothId);
        request.sendJson({ ok: true, key, boothId, count: bindCount(next), summary: bindTableSummary(next), enrich: 'queued' });
      } catch (error) {
        request.sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
      }
      return true;
    }

    if (isBatch) {
      if (p === '/api/library/batchfind/clear') {
        if (request.req.method !== 'POST') { request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }
        batchFind.clear();
        request.sendJson({ ok: true, ...batchFind.summary() });
        return true;
      }
      if (p === '/api/library/batchfind/stop') {
        if (request.req.method !== 'POST') { request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }
        batchFind.stop();
        request.sendJson({ ok: true, ...batchFind.summary() });
        return true;
      }
      if (request.req.method === 'GET') {
        request.sendJson(batchFind.summary());
        return true;
      }
      if (request.req.method !== 'POST') { request.sendJson({ ok: false, error: '该接口只支持 GET/POST' }, 405); return true; }
      if (batchFind.running()) { request.sendJson({ ok: false, error: '已经有一轮在跑了', ...batchFind.summary() }, 409); return true; }
      // 暂停中不让开新的一轮：否则用户连点几次，等于又发一批请求；恢复后待找的 key 都还在。
      const pauseNowState = pausedNow();
      if (pauseNowState.paused) {
        request.sendJson({ ...batchFind.summary(), ok: false, paused: true, error: describeSearchPause(readPause(), Date.now()) }, 409);
        return true;
      }
      let body;
      try { body = await request.readBody(); }
      catch (error) { request.sendJson({ ok: false, error: error?.message ?? '请求体非法' }, Number(error?.statusCode) || 400); return true; }
      const force = Boolean(body?.force);
      const limit = Number(body?.limit) > 0 ? Math.min(200, Math.trunc(Number(body.limit))) : 60;
      let keys = Array.isArray(body?.keys) ? body.keys.map((k) => String(k ?? '').trim()).filter(Boolean) : [];
      if (!keys.length) keys = batchFind.pending(currentSnapshot().assets, { force, limit });
      keys = keys.slice(0, 200);
      if (!keys.length) {
        request.sendJson({ ok: true, queued: 0, message: '没有需要找号的素材（要么都有号了，要么都找过了）', ...batchFind.summary() });
        return true;
      }
      void batchFind.run(keys);
      deps.log(`批量找号：开始 ${keys.length} 件`);
      request.sendJson({ ok: true, queued: keys.length, ...batchFind.summary() });
      return true;
    }

    // GET /api/library/find?key=…&fresh=1
    if (request.req.method !== 'GET') { request.sendJson({ ok: false, error: '该接口只支持 GET' }, 405); return true; }
    const key = String(request.url.searchParams.get('key') || '').trim();
    if (!key) { request.sendJson({ ok: false, error: '缺少 key' }, 400); return true; }
    try {
      const fresh = request.url.searchParams.get('fresh') === '1';
      const result = await findFor(key, { fresh });
      request.sendJson(result);
    } catch (error) {
      request.sendJson({ ok: false, error: `找号失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }
// @bridge-function handleConsoleLibraryFind:end

// 改名（L5=A）：把磁盘上的素材目录 + 主包文件改成 BOOTH 商品名。
// 为什么单独一个模块级函数：这是一串「读请求 → 校验 → 逐条 renameSync → 失败回滚 → 记账」的
// 副作用流程，跟找号/绑定的读逻辑没有关系；放进 handleFindRoutes 只会让它顶过 300 行规模闸。
// 安全网有三层：plan 阶段拒绝日期目录/群目录/太短的名字；执行前逐个校验目标不存在；
// 执行中途失败按已完成条目逆序回滚，并把回滚条数写进错误响应（不能假装没发生）。
  // 绑定后补资料 + 本地封面：放在模块作用域，工厂函数才压得回 300 行规模闸以内。
  // 没有本地封面指纹时排名天花板 = 0.85×titleScore，自动采纳数学上过不了阈值，
  // 所以「绑定」这个动作必须顺带把 meta 与封面补齐，不能等下次手动找号。
  async function enrichAfterBindFor(deps, snapshot, key, boothId) {
    const { coverPlan } = deps.libraryFindPure || {};
    const cacheDir = String(deps.boothCacheDir() || '');
    try {
      if (typeof deps.fetchBoothMeta === 'function') {
        const meta = await deps.fetchBoothMeta(boothId, {
          cacheDir, rateLimitMs: LIBFIND_RATE_LIMIT_MS, log: (m) => deps.log(m), fetchImpl: deps.fetch
        });
        if (meta?.status === 'ok') deps.log(`绑号后补资料：BOOTH ${boothId} ${String(meta.title || '').slice(0, 60)}`);
      }
    } catch (error) {
      deps.log(`绑号后补资料失败（${boothId}）：${error?.message ?? error}`);
    }
    try {
      const rawRoot = typeof deps.fileArchiveRootDir === 'function' ? deps.fileArchiveRootDir() : deps.fileArchiveRootDir;
      const rootDir = String(rawRoot || '').trim() ? deps.path.resolve(String(rawRoot)) : '';
      if (!rootDir) return;
      const card = snapshot().assets.find((a) => String(a.key) === String(key));
      if (!card?.dir) return;
      // 文件名要用主件名（card.mainName）算：多包同目录时 <boothId>.jpg 会被当成散图，
      // 永远进不了 thumbRel —— 详见 src/library-find.js 里 coverFileNameFor 的注释。
      const plan = coverPlan({ boothId, dir: card.dir, exists: false, mainName: card.mainName });
      if (!plan) return;
      const target = deps.safeResolveInside(rootDir, plan.relPath);
      if (deps.fs.existsSync(target)) return;
      const got = await deps.getBoothCover(boothId, { cacheRoot: cacheDir, rateLimitMs: LIBFIND_RATE_LIMIT_MS, log: (m) => deps.log(m) });
      if (!got?.ok || !got.path || !deps.fs.existsSync(got.path)) {
        deps.log(`绑号后补封面跳过（${boothId}）：${got?.coverError || got?.error || '没有缓存封面'}`);
        return;
      }
      deps.fs.copyFileSync(got.path, target);
      deps.log(`绑号后补封面：${plan.relPath}（下次扫描 thumbRel 命中）`);
    } catch (error) {
      deps.log(`绑号后补封面失败（${boothId}）：${error?.message ?? error}`);
    }
  }

/**
 * 找号主流程：单件素材找一次（生成搜索短语 → 抓搜索页 → 粗排 → 抓封面指纹 → 重排 → 给绑定建议）。
 * 放模块作用域是为了让 createLibraryFind 只做闭包装配——函数行长闸按函数算，
 * 主流程留在工厂里迟早会被路由/装配挤过 300 行。
 * ctx 里的东西都是工厂闭包（读盘、抓页、指纹、缓存），这里不关心它们怎么来。
 */
async function libFindOnce(ctx, key, { fresh = false, card = null } = {}) {
  const {
    deps, findCache, readPause, pauseResult, currentSnapshot, localCoverHash, remoteCoverHash,
    fetchSearchPage, searchPhrasesFor, pickPool, rankBoothCandidates, proposeBinding,
    toResponseCandidate, describeFindSummary, FIND_MAX_CANDIDATES, searchPauseState, expandPhrases
  } = ctx;
  // 批量模式会把整轮开头的快照传进来（card），省掉每件都全盘重扫；单件接口不传就现扫。
  const found = card || currentSnapshot().assets.find((a) => String(a.key) === String(key));
  const entry = found || null;
  if (!entry) throw new Error('库里找不到这件素材（可能刚被移动/删除）');
  const cached = findCache.get(String(key));
  if (!fresh && cached && Date.now() - cached.at < LIBFIND_CACHE_TTL_MS) return cached.result;

  // 暂停中直接回人话：不发请求、不消耗 IP 信誉，也让人知道不是「这件素材没救了」。
  const pauseAtStart = readPause();
  const pausedState = searchPauseState(pauseAtStart, Date.now());
  if (pausedState.paused) return pauseResult(pauseAtStart, String(key), entry.title);

  // 识别规则表命中时把「显示名/别名」补进搜索词：日文原名（プラム 这类）靠原来的标题搜不到，
  // 用户维护的别名往往才是 BOOTH 上的写法。没命中就与以前完全一样（只有原搜索词）。
  const basePhrases = searchPhrasesFor({ title: entry.title, file: entry.mainName, dir: entry.dir }).slice(0, 2);
  const phrases = expandPhrases(entry, basePhrases);
  if (!phrases.length) throw new Error('这件素材没有可搜的标题/文件名（先在说明里补个名字）');

  const localHash = await localCoverHash(entry);
  const pages = [];
  const errors = [];
  for (const phrase of phrases) {
    try {
      const page = await fetchSearchPage(phrase);
      if (page.ok) pages.push(page);
      else if (page.paused) { errors.push(page.error); return pauseResult(readPause(), String(key), entry.title); }
      else errors.push(page.error);
    } catch (error) {
      errors.push(String(error?.message ?? error));
    }
  }

  const seen = new Map();
  for (const page of pages) {
    for (const item of page.parsed.items) {
      if (!seen.has(item.boothId)) seen.set(item.boothId, item);
    }
  }
  const pool = pickPool([...seen.values()]);
  if (!pool.length) {
    const result = {
      ok: true,
      key: String(key),
      title: entry.title,
      phrases,
      localHash,
      candidates: [],
      pick: null,
      auto: false,
      summary: describeFindSummary({ candidates: 0, phrases }),
      errors
    };
    findCache.set(String(key), { at: Date.now(), result });
    return result;
  }

  // 先按标题/店铺粗排，取前几名去抓封面指纹，再重排一次（封面权重 0.30）。
  const rough = rankBoothCandidates({ title: entry.title, candidates: pool, coverHash: '' });
  const coverHashes = {};
  let coverChecked = 0;
  if (localHash) {
    for (const cand of rough.slice(0, LIBFIND_COVER_TOP_N)) {
      const hash = await remoteCoverHash(cand.boothId);
      if (!hash) continue;
      coverHashes[cand.boothId] = hash;
      coverChecked += 1;
    }
  }
  const ranked = localHash && Object.keys(coverHashes).length
    ? rankBoothCandidates({ title: entry.title, candidates: pool, coverHash: localHash, coverHashes })
    : rough;

  const proposal = proposeBinding(ranked);
  const candidates = ranked.slice(0, FIND_MAX_CANDIDATES).map(toResponseCandidate);
  const result = {
    ok: true,
    key: String(key),
    title: entry.title,
    phrases,
    localHash,
    coverChecked,
    candidates,
    pick: proposal.auto && proposal.pick ? String(proposal.pick.boothId) : '',
    auto: Boolean(proposal.auto),
    reason: String(proposal.reason || ''),
    summary: describeFindSummary({ candidates: candidates.length, phrases, coverChecked, auto: Boolean(proposal.auto) }),
    errors
  };
  findCache.set(String(key), { at: Date.now(), result });
  return result;
}

/**
 * 批量找号主流程：一串 key 顺序跑、每件落一条记账。
 * 遇 BOOTH 限速整轮停下（剩下的 key 保持「没找过」，恢复后点一下接着找），不能记成失败。
 */
async function libRunBatch(ctx, keys) {
  const { deps, job, readState, writeState, snapshot, pausedNow, findFor, pickPatch, failureCodeOfError, markBatchEntry } = ctx;
  if (job.running) return;
  job.running = true;
  job.startedAt = Date.now();
  job.finishedAt = 0;
  job.total = keys.length;
  job.done = 0;
  job.keys = keys.slice();
  job.lastError = '';
  job.paused = false;
  job.pauseReason = '';
  job.retryAfterMs = 0;
  // 整轮只扫一次库：60 件批量原来每件都全盘重扫（还叠加 pending() 一次），大库能慢一个数量级。
  // 代价是跑的过程中新加的文件这一轮看不见，下一轮会补上，可接受。
  const cardByKey = new Map();
  for (const card of snapshot().assets) cardByKey.set(String(card.key), card);
  let state = readState();
  state.startedAt = job.startedAt;
  writeState(state);
  try {
    for (const key of keys) {
      if (!job.running) break;                       // 允许中途停（POST /api/library/batchfind/stop）
      // 搜索被 BOOTH 限速时整轮停下：剩下的 key 保持「没找过」，恢复后点一下会接着找，
      // 不能把它们记成失败（那会让人以为这些素材没救了）。
      const pause = pausedNow();
      if (pause.paused) {
        job.paused = true;
        job.pauseReason = pause.reason;
        job.retryAfterMs = pause.remainingMs;
        deps.log(`批量找号暂停：${pause.reason}（剩 ${keys.length - job.done} 件待找）`);
        break;
      }
      let patch = { at: Date.now(), pick: '', auto: false, score: 0, candidates: 0, reason: '', title: '', reasonCode: '' };
      try {
        patch = pickPatch(await findFor(key, { fresh: true, card: cardByKey.get(String(key)) || null }));
      } catch (error) {
        patch.reason = String(error?.message ?? error);
        patch.reasonCode = failureCodeOfError(error);
        job.lastError = patch.reason;
      }
      state = markBatchEntry(state, key, patch);
      writeState(state);
      job.done += 1;
    }
  } finally {
    job.running = false;
    job.finishedAt = Date.now();
    const finalState = readState();
    finalState.finishedAt = job.finishedAt;
    writeState(finalState);
    deps.log(`批量找号结束：${job.done}/${job.total} 件，${job.lastError ? '有错误（' + job.lastError + '）' : '无错误'}`);
  }
}

export function createLibraryFind(deps) {
  // 构造期不许读 deps（VM 里依赖可能还没注入，VM 边界测试会用「会抛错的 getter」验证）：
  // 整个装配（纯规则解构 / routeCtx / 批量找号实例）推迟到第一次真正处理请求时，
  // 返回形状仍是 manifest 登记的那一个装配面 handler。
  let impl = null;
  const implOf = () => impl || (impl = buildLibraryFind(deps));
  return { handleConsoleLibraryFind: (request) => implOf().handleConsoleLibraryFind(request) };
}

function buildLibraryFind(deps) {
  // 纯规则在 deps 里（见文件头注释）；名字起短一点，下面代码读起来和直接 import 一样。
  const booth = deps.boothSearchPure || {};
  const binds = deps.libraryBindsPure || {};
  const findPure = deps.libraryFindPure || {};
  const { buildBoothSearchUrl, parseBoothSearchHtml, searchPhrasesFor, rankBoothCandidates, proposeBinding, BOOTH_SEARCH_BASE } = booth;
  const { normalizeBindTable, setBind, removeBind, bindOf, bindCount, bindTableSummary } = binds;
  const { pickPool, toResponseCandidate, describeFindSummary, FIND_MAX_CANDIDATES,
    searchPauseFor, normalizeSearchPause, searchPauseState, describeSearchPause,
    coverPlan, failureCodeOf } = findPure;
  const batchPure = deps.libraryBatchPure || {};
  const {
    BATCH_RULES_VERSION, normalizeBatchState, batchPending, markBatchEntry,
    batchProgress, describeBatchProgress
  } = batchPure;
  // 改名规则与日志格式在 src/library-rename.js（纯函数），这里只负责读请求与动磁盘。
  const renamePure = deps.libraryRenamePure || {};
  const {
    buildRenamePlan, renameLogEntry, normalizeRenameLog, lastUndo,
    appendRenameLog, dropLastRenameLog, renameLogSummary
  } = renamePure;
  let lastNetworkAt = 0;
  const findCache = new Map();   // key -> { at, result }

  const statePath = () => deps.path.join(String(deps.STATE_DIR), 'booth-binds.json');
  const pausePath = () => deps.path.join(String(deps.STATE_DIR), LIBFIND_PAUSE_FILE);
  const renamePath = () => deps.path.join(String(deps.STATE_DIR), 'booth-renames.json');

  // ── 全局搜索暂停（429/403）────────────────────────────────────────────────
  // 读盘坏了就当没暂停：宁可多打一次 BOOTH，也不能因为一个脏 JSON 把找号永久锁死。
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
      deps.log(`找号暂停状态写盘失败：${error?.message ?? error}`);
    }
    return pause;
  }

  function pausedNow() {
    return searchPauseState(readPause(), Date.now());
  }

  /** 命中 429/403 → 落一个全局暂停；返回落盘的暂停对象（含 pausedUntil），非限速信号返回 null。 */
  function notePause(status, res) {
    const retryAfter = Number(res?.headers?.get?.('retry-after')) || null;
    const hit = searchPauseFor({ status, retryAfter });
    if (!hit) return null;
    const now = Date.now();
    const pause = { pausedUntil: now + hit.pauseMs, reason: hit.reason, status: hit.status, at: now };
    writePause(pause);
    deps.log(`找号触发保护闸：${describeSearchPause(pause, now)}`);
    return pause;
  }

  /** 暂停期间统一形状：前端能直接显示 error/summary，也不会误以为是「搜不到」。 */
  function pauseResult(pause, key, title) {
    const now = Date.now();
    const text = describeSearchPause(pause, now);
    return {
      ok: false,
      paused: true,
      key,
      title,
      phrases: [],
      candidates: [],
      pick: null,
      auto: false,
      reason: pause.reason || '',
      retryAfterMs: Math.max(0, Number(pause.pausedUntil || 0) - now),
      summary: text,
      error: text,
      errors: [text]
    };
  }

  function readBinds() {
    try {
      return normalizeBindTable(JSON.parse(deps.fs.readFileSync(statePath(), 'utf8')));
    } catch {
      return normalizeBindTable(null);
    }
  }

  function writeBinds(table) {
    deps.atomicWriteJson(statePath(), table);
    return table;
  }

  // 改名日志：撤销与追查都靠它。读坏了当空表（不能因为一个脏 JSON 让「改名」永久不可用）。
  function readRenames() {
    try {
      return normalizeRenameLog(JSON.parse(deps.fs.readFileSync(renamePath(), 'utf8')));
    } catch {
      return normalizeRenameLog(null);
    }
  }

  function writeRenames(log) {
    deps.atomicWriteJson(renamePath(), log);
    return log;
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
      deps.log(`找号读台账失败（只按盘面）：${error?.message ?? error}`);
    }
    return deps.buildLibrarySnapshot({ fs: deps.fs, rootDir, rows });
  }

  async function throttle() {
    const wait = LIBFIND_RATE_LIMIT_MS - (Date.now() - lastNetworkAt);
    if (wait > 0) await LIBFIND_SLEEP(wait);
    lastNetworkAt = Date.now();
  }

  /** 抓一页搜索。只读文本，不落盘；超过 3MB 直接放弃（正常 200~400KB）。 */
  async function fetchSearchPage(phrase) {
    await throttle();
    const url = buildBoothSearchUrl({ query: phrase });
    let res;
    try {
      res = await deps.fetch(url, {
        headers: { 'user-agent': LIBFIND_UA, 'accept-language': 'zh-CN', accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(LIBFIND_SEARCH_TIMEOUT_MS)
      });
    } catch (error) {
      throw new Error(`搜「${phrase}」失败：${error?.message ?? error}`);
    }
    const code = Number(res?.status) || 0;
    if (code === 404) return { ok: false, phrase, url, error: '搜索页 404（BOOTH 换了地址）' };
    if (code < 200 || code >= 300) {
      const hit = notePause(code, res);
      if (hit) return { ok: false, phrase, url, paused: true, error: describeSearchPause(hit, Date.now()) };
      return { ok: false, phrase, url, error: `搜索页 HTTP ${code}` };
    }
    const text = await res.text();
    if (Buffer.byteLength(String(text ?? ''), 'utf8') > LIBFIND_SEARCH_MAX_BYTES) return { ok: false, phrase, url, error: '搜索页超过 3MB 上限' };
    const parsed = parseBoothSearchHtml(text);
    return { ok: true, phrase, url, parsed };
  }

  async function hashOfFile(abs) {
    try {
      const buf = deps.fs.readFileSync(abs);
      const hash = await deps.dhashFromBufferAsync(buf);
      return String(hash || '');
    } catch (error) {
      deps.log(`本地封面指纹算不出来：${error?.message ?? error}`);
      return '';
    }
  }

  async function localCoverHash(card) {
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

  /** 候选封面：走 getBoothCover（它自己带缓存 + 限速 + 失败降级），再算指纹。 */
  async function remoteCoverHash(boothId) {
    try {
      const cacheRoot = String(deps.boothCacheDir() || '');
      const got = await deps.getBoothCover(boothId, { cacheRoot, rateLimitMs: LIBFIND_RATE_LIMIT_MS, log: (m) => deps.log(m) });
      if (!got?.ok || !got.path) return '';
      return await hashOfFile(got.path);
    } catch {
      return '';
    }
  }

  // 识别规则表（`state/library-alias-rules.json`）：读不到/读坏都当空表。
  // 这张表是用户手写的，写坏一次不能让找号整体 500；页面那头也是同一原则。
  function readAliasTable() {
    const normalize = deps.libraryAliasPure?.normalizeAliasTable;
    if (typeof normalize !== 'function') return { version: 1, entries: [] };
    try {
      const file = deps.path.join(String(deps.STATE_DIR || ''), 'library-alias-rules.json');
      return normalize(JSON.parse(deps.fs.readFileSync(file, 'utf8')));
    } catch {
      return normalize(null);
    }
  }

  // 搜索词扩展：原搜索词在前，别名表命中的显示名/别名补在后面，最多 4 条。
  // （每条搜索词都会真打一次 BOOTH 搜索页并有 900ms 限速，所以封顶 4 而不是全量铺开。）
  function expandPhrases(entry, base) {
    const list = Array.isArray(base) ? base.filter(Boolean).slice(0, 4) : [];
    const expand = deps.libraryAliasPure?.expandSearchPhrases;
    if (typeof expand !== 'function') return list;
    const table = readAliasTable();
    if (!table.entries.length) return list;
    const keys = new Set(list.map((phrase) => String(phrase).toLowerCase()));
    for (const phrase of expand(entry?.title ?? '', table)) {
      const text = String(phrase ?? '').trim();
      if (!text || keys.has(text.toLowerCase())) continue;
      keys.add(text.toLowerCase());
      list.push(text);
      if (list.length >= 4) break;
    }
    return list;
  }

  // 主流程在模块作用域（libFindOnce）：这里只把闭包与纯规则装成一个 ctx，调用点形状保持不变。
  const findCtx = {
    deps, findCache, readPause, pauseResult, currentSnapshot, localCoverHash, remoteCoverHash,
    fetchSearchPage, searchPhrasesFor, pickPool, rankBoothCandidates, proposeBinding,
    toResponseCandidate, describeFindSummary, FIND_MAX_CANDIDATES, searchPauseState, expandPhrases
  };
  const findFor = (key, opts = {}) => libFindOnce(findCtx, key, opts);

  const batchFind = createLibraryBatch(deps, batchPure, findPure, findFor, currentSnapshot, pausedNow);
  // 路由层只拿它需要的东西（模块作用域的 handleFindRoutes 从这里读），别把整个工厂闭包当参数传。
  const enrichAfterBind = (key, boothId) => enrichAfterBindFor(deps, currentSnapshot, key, boothId);
  const routeCtx = {
    deps, batchFind, readBinds, writeBinds, findCache, findFor,
    pausedNow, readPause, writePause, enrichAfterBind, currentSnapshot,
    setBind, removeBind, bindOf, bindCount, bindTableSummary,
    normalizeSearchPause, describeSearchPause,
    readRenames, writeRenames,
    renameApi: renamePure
  };


  return { handleConsoleLibraryFind: (request) => handleFindRoutes(routeCtx, request) };
}
