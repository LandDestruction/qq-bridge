// BOOTH 素材库批量补封面（P0：素材卡「有 BOOTH 号但没有封面」）。
//
// 为什么要有这个模块：素材卡排序里「没有本地封面」会把封面权重整段抹掉
// （src/booth-search.js 归一化成 wTitle=0.85/wCover=0/wShop=0.15），自动采纳在数学上就不可能；
// 而人工绑定那条路只补「刚绑上的那一件」。这里做的是**存量批量补**：串行、可停、可重跑。
//
// 约束：本文件是 manifest 模块，被 scripts/bridge-source.mjs 用 vm.runInContext 裸执行，
// **不能 import**。纯规则（文件名/落盘计划）来自 deps.libraryFindPure（src/library-find.js），
// 抓取与缓存走 deps.getBoothCover（它自带 30 天缓存、1 秒限速、失败只降级不抛）。
// 文件命名必须和绑定补资料同一套规则（`<主件stem>.thumbnail.jpg`）：library-asset 认件时
// 只有 `isThumb` 的文件才会进 thumbRel —— 详见 src/library-find.js 里 coverFileNameFor 的注释。
// 顶部不要有和 src/bridge.js 同名的 const/let（VM 里共用一个全局词法作用域）。

const LIBCOV_STATE_FILE = 'booth-covers.json';
// 一次点下去要等多久：默认 50 件（v2 之前是 20）。前两档来源是纯本地复制，50 件也就一两秒；
// 只有最后一档要联网，受全局暂停闸和 1.2 秒限速约束，跑久了可以 stop 再续。
const LIBCOV_DEFAULT_LIMIT = 50;
const LIBCOV_MAX_LIMIT = 500;
// BOOTH 展示图有 1 秒/次的软上限：串行 + 这个间隔，跑 20 件也就 20 秒，比被 429 封 IP 划算。
const LIBCOV_RATE_LIMIT_MS = 1200;
const LIBCOV_BOOTH_RE = /^\d{5,9}$/;
const LIBCOV_INTRO = '按「台账封面 → BOOTH 缓存 → 压缩包内预览 → 商品页抓取」顺序找图，只有最后一档联网';
// 补封面的来源统计（v2 §4）：前端/文档要看得出这批图分别从哪一级来，卡住时才知道该修哪一级。
// package = 从普通 .zip 里挑的样图（preview.* 或包里最大的图）；unitypackage = .unitypackage 形状自带的 preview.png。
// 两者分开放，排障时能看出「是 unitypackage 那套规则生效，还是 zip 兜底挑图生效」。
const LIBCOV_SOURCES = ['ledger', 'cache', 'unitypackage', 'package', 'booth'];
const LIBCOV_MODES = ['missing', 'all'];
// 已购台账与它的本地封面目录（与 src/bridge/console/library-purchases.js 同一份约定）。
const LIBCOV_PURCHASES_FILE = 'booth-purchases.json';
const LIBCOV_PURCHASE_COVERS_DIR = 'booth-purchase-covers';

export function createLibraryCovers(deps) {
  // 构造期不许读 deps（VM 边界测试会用「一访问就抛」的 getter 构造工厂）：
  // 状态、纯规则、fs 都推迟到第一次真正处理请求时再取。
  let impl = null;
  const implOf = () => impl || (impl = buildLibraryCovers(deps));
  return { handleConsoleLibraryCovers: (request) => implOf().handleConsoleLibraryCovers(request) };
}

// ── 任务状态（落 state/booth-covers.json：重启后能看到上次跑到哪、为什么断） ─────
function libcovStatePath(deps) {
  return deps.path.join(String(deps.STATE_DIR), LIBCOV_STATE_FILE);
}

function libcovEmptyBySource() {
  return { ledger: 0, cache: 0, unitypackage: 0, package: 0, booth: 0 };
}

function libcovEmptyJob() {
  return { state: 'idle', startedAt: 0, done: 0, failed: 0, lastKey: '', lastError: '', bySource: libcovEmptyBySource(), lastPackage: null, lastArchiveInfo: null };
}

// 上一次「补封面失败但包里有文本线索」的摘要：readme 里的 BOOTH 号 / 标题 / 解压码。
// 用户补封面最想知道「这包是哪个商品」，纯函数已经抽好了，这里只做长度截断与去空。
function libcovReadLastArchiveInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ids = Array.isArray(raw.boothIds) ? raw.boothIds.slice(0, 5).map((v) => String(v ?? '').trim()).filter(Boolean) : [];
  const titles = Array.isArray(raw.titleCandidates) ? raw.titleCandidates.slice(0, 3).map((v) => String(v ?? '').trim().slice(0, 120)).filter(Boolean) : [];
  const passwords = Array.isArray(raw.passwordCandidates) ? raw.passwordCandidates.slice(0, 3).map((v) => String(v ?? '').trim().slice(0, 60)).filter(Boolean) : [];
  if (!ids.length && !titles.length && !passwords.length) return null;
  return {
    key: String(raw.key ?? '').slice(0, 200),
    boothIds: ids,
    titleCandidates: titles,
    passwordCandidates: passwords,
    truncated: Boolean(raw.truncated)
  };
}

// 上一次从包里抠出封面的明细：排障时最常问「这张到底是从包里哪一项来的、多大」。
function libcovReadLastPackage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const entryName = String(raw.entryName ?? '').slice(0, 400);
  if (!entryName) return null;
  return {
    key: String(raw.key ?? '').slice(0, 200),
    source: String(raw.source ?? '').slice(0, 40),
    entryName,
    bytes: Math.max(0, Number(raw.bytes) || 0),
    // 包内文本线索跟着同一个摘要走：排障时只看 lastPackage 就能知道「这包是哪个商品、解压码是多少」，
    // 别让它在归一化时被丢掉（丢掉后 GET /covers 上就查不到了）。
    info: libcovReadLastArchiveInfo(raw.info)
  };
}

function libcovReadBySource(raw) {
  const out = libcovEmptyBySource();
  for (const key of LIBCOV_SOURCES) out[key] = Math.max(0, Number(raw?.[key]) || 0);
  return out;
}

// 读回：重启后 running 一定是假的（进程都没了）→ 标 interrupted，提示可以重跑。
function libcovLoadJob(deps) {
  const job = libcovEmptyJob();
  let raw = null;
  try { raw = JSON.parse(deps.fs.readFileSync(libcovStatePath(deps), 'utf8')); } catch { return job; }
  if (!raw || typeof raw !== 'object') return job;
  job.startedAt = Number(raw.startedAt) || 0;
  job.done = Number(raw.done) || 0;
  job.failed = Number(raw.failed) || 0;
  job.lastKey = String(raw.lastKey ?? '');
  job.lastError = String(raw.lastError ?? '');
  job.bySource = libcovReadBySource(raw.bySource);
  job.lastPackage = libcovReadLastPackage(raw.lastPackage);
  job.lastArchiveInfo = libcovReadLastArchiveInfo(raw.lastArchiveInfo);
  job.state = raw.running === true ? 'interrupted' : String(raw.state || 'idle');
  if (job.state === 'interrupted' && !job.lastError) job.lastError = '上次补封面被桥接重启打断，可以重跑';
  return job;
}

function libcovSaveJob(deps, job) {
  try {
    deps.atomicWriteJson(libcovStatePath(deps), {
      v: 1,
      at: Date.now(),
      running: job.state === 'running',
      state: job.state,
      startedAt: job.startedAt,
      done: job.done,
      failed: job.failed,
      lastKey: job.lastKey,
      lastError: job.lastError,
      bySource: libcovReadBySource(job.bySource),
      lastPackage: libcovReadLastPackage(job.lastPackage),
      lastArchiveInfo: libcovReadLastArchiveInfo(job.lastArchiveInfo)
    });
  } catch { /* 状态写失败不影响补封面本身 */ }
}

// ── 库快照与「缺封面」判定 ────────────────────────────────────────────────
function libcovRootDir(deps) {
  const raw = typeof deps.fileArchiveRootDir === 'function' ? deps.fileArchiveRootDir() : deps.fileArchiveRootDir;
  return String(raw || '');
}

function libcovCacheRoot(deps) {
  const raw = typeof deps.boothCacheDir === 'function' ? deps.boothCacheDir() : deps.boothCacheDir;
  return String(raw || 'state/booth-cache');
}

// 与 /api/library/assets 的 data.withCover 同一判据：本地缩略图或 BOOTH 缓存封面任一看得见就算有。
// 注意：counts.noCover 用的就是这同一条判据（thumbRel || coverUrl），所以 missing 必须按它算，
// 不能再「只数有号的」——否则页面「缺封面 7 件」和筛选条「无封面 8 件」对不上。
function libcovHasCoverCard(card) {
  return Boolean(card?.thumbRel) || Boolean(card?.coverUrl);
}

function libcovSnapshot(deps) {
  return deps.buildLibrarySnapshot({ fs: deps.fs, rootDir: libcovRootDir(deps) });
}

/**
 * 统计用的卡片列表：优先拿素材页那份最终视图（绑定 → 合并 → 改名 → 别名 → 标签都走完），
 * 与 GET /api/library/assets 的 allCount / counts.noCover 是同一份数据。
 * 装配漏了 libraryAssetsViewOf 就退回扫盘原始视图（口径会不一致，总比整个接口 500 好）。
 */
function libcovCards(deps) {
  const viewOf = deps.libraryAssetsViewOf;
  if (typeof viewOf === 'function') {
    try {
      const view = viewOf({ fresh: false });
      if (view && Array.isArray(view.assets)) return { cards: view.assets, scannedAt: Number(view.scannedAt) || Date.now() };
    } catch (error) {
      deps.log(`[补封面] 取素材页最终视图失败，退回扫盘视图：${error?.message ?? error}`);
    }
  }
  const snap = libcovSnapshot(deps);
  return { cards: Array.isArray(snap?.assets) ? snap.assets : [], scannedAt: Number(snap?.scannedAt) || Date.now() };
}

// 全局 BOOTH 暂停（429/403 后由任一抓取入口写入 state/booth-search-pause.json）。
// 本模块不能 import，所以读暂停走 deps.boothPausePure（src/booth-pause.js 的命名空间）；
// 它缺席时当「没暂停」，别让补封面因为装配漏了一项就整个起不来。
async function libcovPause(deps) {
  const pure = deps.boothPausePure || {};
  if (typeof pure.readPause !== 'function') return { paused: false, text: '', retryAfterMs: 0 };
  const rec = await pure.readPause({ fs: deps.fs, stateDir: String(deps.STATE_DIR), now: Date.now() });
  const state = typeof pure.searchPauseState === 'function' ? pure.searchPauseState(rec, Date.now()) : { paused: false };
  if (!state.paused) return { paused: false, text: '', retryAfterMs: 0 };
  const text = typeof pure.describeSearchPause === 'function' ? pure.describeSearchPause(rec, Date.now()) : 'BOOTH 正在限速暂停';
  return { paused: true, text, retryAfterMs: Math.max(0, Number(state.remainingMs) || 0) };
}

// 概览：total=库内件数；withCover=有封面（thumbRel 或 BOOTH 缓存图）；missing=没有封面的件数。
// 三个数都从素材页最终视图来，且 missing 直接等于「全部 - 有封面」——它对的是
// GET /api/library/assets 的 counts.noCover，不是「有号但没封面」（没号的那件也缺封面，
// 只是补封面救不了它；页面上的筛选条同样把它算进去）。
function libcovSummary(deps, job) {
  const { cards, scannedAt } = libcovCards(deps);
  const withCover = cards.filter((card) => libcovHasCoverCard(card)).length;
  return {
    ok: true,
    total: cards.length,
    withCover,
    missing: cards.length - withCover,
    scannedAt,
    running: job.state === 'running',
    job: {
      state: job.state,
      startedAt: job.startedAt,
      done: job.done,
      failed: job.failed,
      lastKey: job.lastKey,
      bySource: libcovReadBySource(job.bySource),
      lastPackage: libcovReadLastPackage(job.lastPackage),
      lastArchiveInfo: libcovReadLastArchiveInfo(job.lastArchiveInfo)
    },
    bySource: libcovReadBySource(job.bySource),
    lastPackage: libcovReadLastPackage(job.lastPackage),
    lastArchiveInfo: libcovReadLastArchiveInfo(job.lastArchiveInfo),
    lastError: job.lastError
  };
}

// 待补清单：有号 + 算得出文件名 + （非 force 时）确实没封面。keys 用于只补指定几件。
// cards 来自素材页最终视图（合并后卡片已折叠、改名后目录名已是新的），键也跟着它们走。
function libcovTargets(deps, cards, { keys = null, force = false } = {}) {
  const wanted = Array.isArray(keys) && keys.length ? new Set(keys.map((k) => String(k))) : null;
  return (Array.isArray(cards) ? cards : []).filter((card) => {
    const id = String(card?.boothId || '');
    // 有号走全链路；没号但主件是 zip/unitypackage 的也能补——包内 preview.png 不需要 BOOTH 号。
    // （用户库里正是一堆没号的老包：不给这条路，「全部补齐」永远清不掉 noCover。）
    if (!LIBCOV_BOOTH_RE.test(id)) {
      // 无号件只在「包就在磁盘上」时才进候选：库里可能有已删/已移走的老卡片，
      // 把它们算进候选会让每轮都多出几条「没有包内封面」的失败噪音。
      if (!libcovIsPackageCard(deps, card) || !libcovPackageFileExists(deps, card)) return false;
    }
    if (!String(card?.dir || '')) return false;
    if (wanted && !wanted.has(String(card?.key))) return false;
    return force ? true : !libcovHasCoverCard(card);
  });
}

/** 主件是不是压缩包/unitypackage（包内封面这一档只对它们有意义）。 */
function libcovIsPackageCard(deps, card) {
  const name = String(card?.mainName || card?.file || '');
  if (!name) return false;
  const api = deps.libraryPackageCoverPure;
  if (api && typeof api.isPackageCoverCandidate === 'function') return api.isPackageCoverCandidate(name);
  return /\.(zip|unitypackage)$/i.test(name);
}

/** 无号件判断候选时用：压缩包文件确实在盘上（不读内容，只 stat）。 */
function libcovPackageFileExists(deps, card) {
  const dir = String(card?.dir || '');
  const mainName = String(card?.mainName || card?.file || '');
  if (!dir || !mainName) return false;
  try {
    const file = deps.safeResolveInside(libcovRootDir(deps), `${dir}/${mainName}`);
    return Boolean(deps.fs.statSync(file).isFile());
  } catch {
    return false;
  }
}

function libcovPlan(deps, card) {
  const pure = deps.libraryFindPure || {};
  const boothId = String(card?.boothId || '');
  if (LIBCOV_BOOTH_RE.test(boothId) && typeof pure.coverPlan === 'function') {
    const planned = pure.coverPlan({ boothId, dir: String(card?.dir || ''), exists: false, mainName: String(card?.mainName || '') }) || null;
    if (planned) return planned;
  }
  // 没号（或 coverPlan 算不出）时：主件是压缩包就按「主件名 + .thumbnail.jpg」自己造计划，
  // 和 library-find 的 coverFileNameFor 同一套命名（isThumb 认 `<stem>.thumbnail.*`）。
  if (!libcovIsPackageCard(deps, card)) return null;
  const mainName = String(card?.mainName || card?.file || '');
  const dir = String(card?.dir || '');
  if (!mainName || !dir) return null;
  const stem = mainName.replace(/\.[^.]+$/, '') || mainName;
  const relPath = `${dir}/${stem}.thumbnail.jpg`;
  return { fileName: `${stem}.thumbnail.jpg`, relPath };
}

// ── 多级封面来源（v2 §4）───────────────────────────────────────────────
// 本模块不能 import，所以已购台账/本地封面文件都按既有约定直接读（和 library-purchases.js 同一份）。
// 坏文件一律当空台账：补封面不能因为台账坏了一次就整批失败。

function libcovPurchasesPath(deps) {
  return deps.path.join(String(deps.STATE_DIR), LIBCOV_PURCHASES_FILE);
}

/** 已购台账里这件商品的封面：{ localFile, remoteUrl }；没有就返回 null。 */
function libcovLedgerCover(deps, boothId) {
  let raw = null;
  try {
    const text = deps.fs.readFileSync(libcovPurchasesPath(deps), 'utf8');
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
  const items = raw && typeof raw === 'object' && raw.items && typeof raw.items === 'object' ? raw.items : null;
  const item = items?.[boothId];
  if (!item || typeof item !== 'object') return null;
  const localFile = deps.path.join(String(deps.STATE_DIR), LIBCOV_PURCHASE_COVERS_DIR, `${boothId}.jpg`);
  const remoteUrl = /^https?:\/\//i.test(String(item.coverUrl ?? '').trim()) ? String(item.coverUrl).trim() : '';
  return { localFile, remoteUrl };
}

function libcovFileExists(deps, file) {
  try {
    return Boolean(file) && deps.fs.existsSync(file) && deps.fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function libcovCacheCoverFile(deps, boothId) {
  try {
    if (typeof deps.getBoothCoverPath !== 'function') return '';
    return String(deps.getBoothCoverPath(boothId, { cacheRoot: libcovCacheRoot(deps) }) || '');
  } catch {
    return '';
  }
}

// 压缩包 / .unitypackage 里的封面（§4 第 3 档，索引从 0 数的话是第三个来源）。
//
// 为什么要这一档：很多素材的 BOOTH 页早就删了/换图了，但作者在压缩包里自带样图；
// 这一档纯本地读（0 网络），比最后去抓商品页稳定得多。
//
// VM 模块不能 import，真正的解包逻辑由 deps.libraryPackageCoverPure 注入
// （src/library-package-cover.js：不再按整包体积判死，只限单张 8MB / 累计探测 40MB，失败回中文原因、绝不抛）。
function libcovPackageCandidate(deps, card) {
  const name = String(card?.mainName || card?.file || '');
  const api = deps.libraryPackageCoverPure;
  if (!api || typeof api.extractPackageCoverFromBuffer !== 'function') return null;
  if (typeof api.isPackageCoverCandidate === 'function' ? !api.isPackageCoverCandidate(name) : !/\.(zip|unitypackage)$/i.test(name)) return null;
  const dir = String(card?.dir || '');
  const rel = dir ? `${dir}/${name}` : name;
  let abs = '';
  try {
    abs = deps.safeResolveInside(libcovRootDir(deps), rel);
  } catch {
    return null;
  }
  return { name, abs };
}

/** 把抽出来的封面字节落到缓存目录（不进素材目录，复制/校验成功后才算数）。 */
function libcovWritePackageCover(deps, card, packed) {
  const mime = String(packed?.mime || 'image/png');
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'png';
  const rawKey = String(card?.key || card?.boothId || 'cover');
  const safeKey = rawKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'cover';
  const dir = deps.path.join(String(deps.STATE_DIR), 'library-covers');
  deps.fs.mkdirSync(dir, { recursive: true });
  const file = deps.path.join(dir, `${safeKey}.${ext}`);
  deps.fs.writeFileSync(file, packed.bytes);
  return { file, ext };
}

async function libcovTryPackageCover(deps, card) {
  const candidate = libcovPackageCandidate(deps, card);
  if (!candidate) return null;
  let stat = null;
  try {
    stat = deps.fs.statSync(candidate.abs);
  } catch {
    return null; // 文件不在（改名/移动过的老卡片），静默跳过，交给下一档
  }
  const api = deps.libraryPackageCoverPure;
  // 包的体积门槛只用来拒 >2GB（防坏包/误传）；真机 55MB 的包里有样图，旧 32MB 门槛把用户判死过。
  const maxPackageBytes = Number(api.PACKAGE_COVER_MAX_BYTES) || 2 * 1024 * 1024 * 1024;
  if (stat.size > maxPackageBytes) {
    return { ok: false, error: '包太大（超过 2GB），不抽里面的封面' };
  }
  let buffer = null;
  try {
    buffer = deps.fs.readFileSync(candidate.abs);
  } catch {
    return { ok: false, error: '读不了压缩包' };
  }
  let packed = null;
  try {
    packed = api.extractPackageCoverFromBuffer(buffer, { name: candidate.name, packageBytes: stat.size });
  } catch (error) {
    return { ok: false, error: `解包失败：${error?.message ?? error}` };
  }
  if (!packed?.ok || !packed.bytes?.length) {
    // 包内没有封面时，纯函数会顺手把 readme 里的号/标题/解压码带回（info），
    // 这里原样透给 job，用户能在「补封面失败」的条目上看到「这包大概是哪个商品」。
    return { ok: false, error: String(packed?.text || packed?.error || '包里没有封面'), info: packed?.info || null };
  }
  try {
    const written = libcovWritePackageCover(deps, card, packed);
    return {
      ok: true,
      path: written.file,
      ext: written.ext,
      entryName: String(packed.entryName || ''),
      bytes: packed.bytes.length,
      packedSource: String(packed.source || '')
    };
  } catch (error) {
    return { ok: false, error: `写包内封面失败：${error?.message ?? error}` };
  }
}

/** 包内封面可能是 png/webp：落盘文件名跟着真实格式走，别把 png 塞进 .jpg。 */
function libcovPlanWithExt(plan, ext) {
  const next = String(ext || '').toLowerCase();
  if (!next || !plan || !/\.[a-z0-9]+$/i.test(plan.relPath)) return plan;
  return { ...plan, relPath: plan.relPath.replace(/\.[a-z0-9]+$/i, `.${next}`) };
}

/** 把来源文件复制成素材目录里的封面文件名（<主件stem>.thumbnail.jpg）。 */
function libcovCopyCover(deps, plan, sourceFile, source) {
  try {
    const target = deps.safeResolveInside(libcovRootDir(deps), plan.relPath);
    deps.fs.mkdirSync(deps.path.dirname(target), { recursive: true });
    deps.fs.copyFileSync(sourceFile, target);
    deps.log(`[补封面] ${plan.relPath}（来源：${source}）`);
    return { ok: true, relPath: plan.relPath, source };
  } catch (error) {
    return { ok: false, error: `写封面失败：${error?.message ?? error}` };
  }
}

// 补一件：按「台账 → BOOTH 缓存 → 压缩包预览 → 商品页抓取」找图，再复制进素材目录。
// 任何失败只返回 {ok:false}，不抛；成功时带上来源，供 bySource 统计。
async function libcovOne(deps, card, { force = false } = {}) {
  const boothId = String(card.boothId);
  const hasBooth = LIBCOV_BOOTH_RE.test(boothId);
  const plan = libcovPlan(deps, card);
  if (!plan) return { ok: false, error: `算不出封面文件名（${hasBooth ? `BOOTH ${boothId}` : '这件'} 的主件名不可用）` };
  // ① 已购台账：清单页同步时就下过封面（本地文件），复制即可 —— 0 网络、最快、不会触发限速。
  //    force 时跳过本地已有图，强制走后面的档位换一张（用户想覆盖旧图时用）。
  const ledger = hasBooth ? libcovLedgerCover(deps, boothId) : null;
  if (!force && ledger && libcovFileExists(deps, ledger.localFile)) {
    return libcovCopyCover(deps, plan, ledger.localFile, 'ledger');
  }
  // ② BOOTH 缓存目录里已经抓过：直接复制，同样 0 网络。
  const cached = hasBooth ? libcovCacheCoverFile(deps, boothId) : '';
  if (!force && libcovFileExists(deps, cached)) {
    return libcovCopyCover(deps, plan, cached, 'cache');
  }
  // ③ 压缩包/unitypackage 内的封面：纯本地读，0 网络；失败原因留着，万一最后一档也失败要一起报。
  let packageNote = '';
  let packageInfo = null;
  if (!force) {
    try {
      const packed = await libcovTryPackageCover(deps, card);
      if (packed?.ok && packed.path && libcovFileExists(deps, packed.path)) {
        // 统计口径：unitypackage 形状记 unitypackage，普通 zip 里挑图记 package（排障能区分规则生效情况）。
        const source = packed.packedSource === 'unitypackage' ? 'unitypackage' : 'package';
        const copied = libcovCopyCover(deps, libcovPlanWithExt(plan, packed.ext), packed.path, source);
        if (copied.ok) {
          copied.lastPackage = {
            key: String(card.key || ''),
            source: packed.packedSource || 'image',
            entryName: packed.entryName || '',
            bytes: Number(packed.bytes) || 0
          };
        }
        return copied;
      }
      if (packed && packed.ok === false) {
        packageNote = String(packed.error || '');
        packageInfo = packed.info || null;
      }
    } catch (error) {
      packageNote = `读压缩包预览失败：${error?.message ?? error}`;
    }
  }
  // 没号的素材到这一步就结束了：前两档都需要 BOOTH 号，没号只剩「包内封面」一条路。
  if (!hasBooth) {
    return { ok: false, error: packageNote ? `没有 BOOTH 号，包内封面：${packageNote}` : '没有 BOOTH 号，也没有包内封面', info: packageInfo };
  }
  // ④ 最后才联网：getBoothCover 内部读全局暂停闸，429/403 会把暂停写进 state/booth-search-pause.json。
  let got = null;
  try {
    got = await deps.getBoothCover(boothId, {
      cacheRoot: libcovCacheRoot(deps),
      rateLimitMs: LIBCOV_RATE_LIMIT_MS,
      force,
      stateDir: String(deps.STATE_DIR),
      log: (message) => deps.log(message)
    });
  } catch (error) {
    return { ok: false, error: `抓封面失败：${error?.message ?? error}` };
  }
  if (!got || !got.ok || !got.path) {
    const boothError = String(got?.coverError || got?.error || 'BOOTH 没有可用的展示图');
    return { ok: false, error: packageNote ? `${boothError}（包内封面：${packageNote}）` : boothError, info: packageInfo };
  }
  return libcovCopyCover(deps, plan, got.path, 'booth');
}

function buildLibraryCovers(deps) {
  const job = libcovLoadJob(deps);
  // 单飞：同一时刻只允许一轮，避免把 BOOTH 限速打满；stop 只是置位，循环在每件之间检查。
  let stopRequested = false;

  // 串行跑一批。limit 用来把「一次点下去要等多久」控制住（默认 20），第二轮再继续。
  async function runBackfill(targets, { force = false, limit = LIBCOV_DEFAULT_LIMIT } = {}) {
    const todo = targets.slice(0, limit);
    job.state = 'running';
    job.startedAt = Date.now();
    job.done = 0;
    job.failed = 0;
    job.lastKey = '';
    job.lastError = '';
    job.bySource = libcovEmptyBySource();
    // 每轮从干净的摘录状态开始：上一轮某件包里读到的号/密码不该混到这一轮。
    job.lastArchiveInfo = null;
    stopRequested = false;
    libcovSaveJob(deps, job);
    deps.log(`[补封面] 开跑：待补 ${targets.length} 件，本轮 ${todo.length} 件（${LIBCOV_INTRO}）`);
    for (const card of todo) {
      if (stopRequested) break;
      // 每件之间查一次全局暂停：中途被 BOOTH 限速（getBoothCover 会把 429/403 写进暂停文件）
      // 就整轮停下，别把剩下十几件挨个撞墙、也把出口 IP 打得更黑。
      const pause = await libcovPause(deps);
      if (pause.paused) {
        job.lastError = pause.text;
        job.state = 'paused';
        libcovSaveJob(deps, job);
        deps.log(`[补封面] 遇全局暂停，先停：${pause.text}`);
        return { done: job.done, failed: job.failed, stopped: true, running: false, paused: true, error: pause.text, retryAfterMs: pause.retryAfterMs, bySource: libcovReadBySource(job.bySource), lastPackage: libcovReadLastPackage(job.lastPackage), lastArchiveInfo: libcovReadLastArchiveInfo(job.lastArchiveInfo) };
      }
      job.lastKey = String(card.key);
      const result = await libcovOne(deps, card, { force });
      if (result.ok) {
        job.done += 1;
        if (result.source && job.bySource[result.source] !== undefined) job.bySource[result.source] += 1;
        // 记下「上一张包内封面是从哪一项抠出来的」，排障时不用再猜。
        if (result.lastPackage) job.lastPackage = libcovReadLastPackage(result.lastPackage);
        // 成功件一般没有 info（读包内文本只在找不到图时才做），有就顺手记下。
        if (result.info) job.lastArchiveInfo = libcovReadLastArchiveInfo(result.info);
        // lastPackage 是前端要看的摘要：把 info 一起挂上去，GET /covers 里就能直接看到
        // 「这张封面是从哪个包、哪个条目抠出来的，包里还写了什么号/密码」。
        if (job.lastArchiveInfo && job.lastPackage) {
          job.lastPackage = { ...libcovReadLastPackage(job.lastPackage), info: job.lastArchiveInfo };
        }
      }
      else {
        job.failed += 1;
        job.lastError = `${String(card.title || card.key)}：${result.error}`;
        // 补不上图时把包内读到的号/密码摘要留下来，用户能据此手动认号/解压。
        job.lastArchiveInfo = libcovReadLastArchiveInfo(result.info);
        if (job.lastArchiveInfo && job.lastPackage) {
          job.lastPackage = { ...libcovReadLastPackage(job.lastPackage), info: job.lastArchiveInfo };
        }
        deps.log(`[补封面] 跳过 ${job.lastKey}：${result.error}`);
      }
      libcovSaveJob(deps, job);
    }
    const stopped = stopRequested;
    job.state = stopped ? 'stopped' : 'done';
    libcovSaveJob(deps, job);
    deps.log(`[补封面] 结束：成功 ${job.done}、失败 ${job.failed}、还有 ${Math.max(0, targets.length - job.done - job.failed)} 件未补${stopped ? '（手动停止）' : ''}`);
    return { done: job.done, failed: job.failed, stopped, running: false, bySource: libcovReadBySource(job.bySource), lastPackage: libcovReadLastPackage(job.lastPackage), lastArchiveInfo: libcovReadLastArchiveInfo(job.lastArchiveInfo) };
  }

// @bridge-function handleConsoleLibraryCovers:start
  async function handleConsoleLibraryCovers(request) {
    const { req, url, sendJson, readBody } = request;
    // 补封面会真的往素材目录写文件：只给管理端，智能体一律 403。
    if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
      sendJson({ ok: false, error: '未授权：补封面是管理端操作' }, 403);
      return true;
    }
    const path = url.pathname;

    if (path === '/api/library/covers' && req.method === 'GET') {
      const pause = await libcovPause(deps);
      sendJson({ ...libcovSummary(deps, job), paused: pause.paused, pauseText: pause.text, retryAfterMs: pause.retryAfterMs });
      return true;
    }

    if (path === '/api/library/covers/backfill' && req.method === 'POST') {
      let body = null;
      try { body = await readBody(); } catch (error) { sendJson({ ok: false, error: error?.message ?? '请求体非法' }, 400); return true; }
      if (job.state === 'running') {
        sendJson({ ok: false, error: '正在补封面：等这轮跑完，或先停止再重来' }, 409);
        return true;
      }
      // 开跑前先看全局暂停：暂停中一个请求都不发（否则「搜索退避了、封面还在敲门」）。
      const pause = await libcovPause(deps);
      if (pause.paused) {
        sendJson({ ok: false, paused: true, error: pause.text, retryAfterMs: pause.retryAfterMs }, 409);
        return true;
      }
      const rawLimit = Number(body?.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(LIBCOV_MAX_LIMIT, Math.floor(rawLimit)) : LIBCOV_DEFAULT_LIMIT;
      const keys = Array.isArray(body?.keys) ? body.keys.map((k) => String(k)).filter(Boolean) : null;
      // mode='all' = 连已经有封面的也重补一遍（换更清晰/修旧图）；默认 missing 只补缺的。
      const modeRaw = String(body?.mode ?? '').trim();
      const mode = LIBCOV_MODES.includes(modeRaw) ? modeRaw : 'missing';
      const force = body?.force === true || mode === 'all';
      let targets = [];
      try {
        targets = libcovTargets(deps, libcovCards(deps).cards, { keys, force });
      } catch (error) {
        sendJson({ ok: false, error: `扫描素材库失败：${error?.message ?? error}` }, 500);
        return true;
      }
      if (!targets.length) {
        sendJson({ ok: true, mode, done: 0, failed: 0, stopped: false, running: false, pending: 0, lastError: '', bySource: libcovEmptyBySource(), lastPackage: null, lastArchiveInfo: null });
        return true;
      }
      const result = await runBackfill(targets, { force, limit });
      sendJson({ ok: true, mode, ...result, pending: Math.max(0, targets.length - result.done - result.failed), lastError: job.lastError });
      return true;
    }

    if (path === '/api/library/covers/stop' && req.method === 'POST') {
      if (job.state !== 'running') { sendJson({ ok: false, error: '现在没有在跑的补封面任务' }, 409); return true; }
      stopRequested = true;
      sendJson({ ok: true, stopping: true });
      return true;
    }

    return false;
  }
// @bridge-function handleConsoleLibraryCovers:end

  return { handleConsoleLibraryCovers };
}
