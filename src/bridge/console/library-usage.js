// 工程使用统计：「这件素材有没有被哪个 Unity 工程用过」。
//
// 为什么要有这个模块：素材库越攒越多，删一件之前最怕「某个工程还引用着它」。这里只做
// **只读** 扫描：先找工程（ProjectSettings/ProjectVersion.txt），再在工程的文本资产里
// 找素材名字的引用；不打开 Unity、不写工程目录、不碰素材库。
//
// 匹配口径（宁可漏报也不误报，误报会让人不敢删）：
//   - 素材名 = 主件名去扩展名、去掉开头的 BOOTH 号（`8844481 Mew_Pose.zip` → `Mew_Pose`）；
//   - 目录名也算一条线索（素材常按 `角色/服装` 分目录）；
//   - 只做大小写不敏感的**子串**匹配，名字短于 3 字符直接跳过（`a` 这种会命中一切）；
//   - 只看文本类资产扩展名，>2MB 的文件跳过（Unity 的大二进制/序列化文本扫了也没意义还慢）。
//
// 约束：本文件是 manifest 模块，被 scripts/bridge-source.mjs 用 vm.runInContext 裸执行，
// **不能 import**；扫描根来自 config.json 的 fileArchive.usageRoots（不硬编码任何盘符），
// 没配就返回 rootsConfigured:false，由前端提示用户去设置里加目录。
// 顶部不要有和 src/bridge.js 同名的 const/let（VM 里共用一个全局词法作用域）。

// 状态文件：新版叫 library-usage.json（名字对得上功能），老盘上是 booth-usage.json，
// 读取时两个都试、写入只写新名 —— 升级后老状态照样能看到上次结论，不用重扫。
const LIBUSE_STATE_FILE = 'library-usage.json';
const LIBUSE_LEGACY_STATE_FILE = 'booth-usage.json';
// 素材侧 GUID：一件素材最多留多少个（套装包可能上千，够判「用没用」就行）
const LIBUSE_ASSET_GUID_MAX = 400;
// 单次扫描最多解包多少件素材（解 zip+gzip 是纯 CPU 活，几千件会把后台循环拖死）
const LIBUSE_ASSET_SCAN_MAX = 400;
const LIBUSE_ASSET_MAX_BYTES = 64 * 1024 * 1024;
const LIBUSE_TEXT_EXTENSIONS = ['.prefab', '.unity', '.asset', '.mat', '.controller', '.anim', '.cs'];
// GUID 匹配要连 .meta 一起读：`guid: <32hex>` 就在 .meta 里，少了它工程侧永远没有 GUID。
const LIBUSE_EXT_FOR_GUID = ['.meta', '.prefab', '.unity', '.asset', '.mat', '.controller', '.anim', '.cs'];
const LIBUSE_MAX_FILE_BYTES = 2 * 1024 * 1024;
const LIBUSE_MAX_FILES_PER_PROJECT = 20000;
const LIBUSE_TIMEOUT_MS = 120000;
const LIBUSE_EVIDENCE_MAX = 40;
const LIBUSE_MAX_PROJECTS_PER_ASSET = 20;
const LIBUSE_PROJECT_DEPTH = 6;
// 这些目录是 Unity 生成的缓存/构建产物，扫它们既慢又只会命中「同一个工程」的噪音。
const LIBUSE_SKIP_DIRS = new Set(['node_modules', '.git', 'Library', 'Temp', 'obj', 'Logs', 'Build', 'Builds', '.vs', '.idea', 'UserSettings', 'PackageCache']);

// ── 状态文件（只存「结论」，不存扫描到的文件列表：真库可能几万个文件） ─────────
function libuseStatePath(deps, file = LIBUSE_STATE_FILE) {
  return deps.path.join(String(deps.STATE_DIR), file);
}

function libuseEmptyState() {
  return {
    v: 2, at: 0, running: false, startedAt: 0, scannedAt: 0, roots: [], usage: {},
    summary: { withUsage: 0, unused: 0, unknown: 0 }, usageMode: 'name', lastError: ''
  };
}

// 重启后 running 一定是假的（进程没了）→ 标 interrupted，前端提示可以重跑。
function libuseLoadState(deps) {
  const state = libuseEmptyState();
  let raw = null;
  for (const file of [LIBUSE_STATE_FILE, LIBUSE_LEGACY_STATE_FILE]) {
    try { raw = JSON.parse(deps.fs.readFileSync(libuseStatePath(deps, file), 'utf8')); } catch { raw = null; }
    if (raw && typeof raw === 'object') break;
  }
  if (!raw || typeof raw !== 'object') return state;
  state.at = Number(raw.at) || 0;
  state.startedAt = Number(raw.startedAt) || 0;
  state.scannedAt = Number(raw.scannedAt) || 0;
  state.roots = Array.isArray(raw.roots) ? raw.roots : [];
  state.usage = raw.usage && typeof raw.usage === 'object' ? raw.usage : {};
  state.summary = raw.summary && typeof raw.summary === 'object'
    ? {
      withUsage: Number(raw.summary.withUsage) || 0,
      unused: Number(raw.summary.unused) || 0,
      unknown: Number(raw.summary.unknown) || 0
    }
    : libuseEmptyState().summary;
  state.usageMode = raw.usageMode === 'guid' ? 'guid' : 'name';
  state.lastError = String(raw.lastError ?? '');
  if (raw.running === true) {
    state.running = false;
    if (!state.lastError) state.lastError = '上次扫描被桥接重启打断，可以重跑';
  } else {
    state.running = false;
  }
  return state;
}

function libuseSaveState(deps, state) {
  try {
    deps.atomicWriteJson(libuseStatePath(deps), {
      v: 2,
      at: Date.now(),
      running: state.running === true,
      startedAt: state.startedAt,
      scannedAt: state.scannedAt,
      roots: state.roots,
      usage: state.usage,
      summary: state.summary || { withUsage: 0, unused: 0, unknown: 0 },
      usageMode: state.usageMode === 'guid' ? 'guid' : 'name',
      lastError: state.lastError
    });
  } catch { /* 状态写失败不影响扫描结论 */ }
}

// ── 根目录配置 ──────────────────────────────────────────────────────────
function libusePure(deps) {
  const pure = deps.libraryUsagePure;
  return pure && typeof pure === 'object' ? pure : null;
}

function libuseGuidsPure(deps) {
  const pure = deps.libraryUsageGuidsPure;
  return pure && typeof pure === 'object' ? pure : null;
}

function libuseConfiguredRoots(deps) {
  const configured = deps.cfg?.fileArchive?.usageRoots;
  if (!Array.isArray(configured)) return [];
  return libuseNormalizeRoots(deps, configured);
}

// 根目录规整统一走纯函数层（去引号/尾斜杠、反斜杠转 `/`、去重、只留绝对路径）。
// 纯函数层没注入（测试替身）时退回「只 trim」的老行为，别让老调用点直接炸。
function libuseNormalizeRoots(deps, list) {
  const items = (Array.isArray(list) ? list : []).map((item) => String(item ?? '').trim()).filter(Boolean);
  const resolved = items.map((item) => (deps.path.isAbsolute(item) ? item : deps.path.resolve(String(deps.ROOT || ''), item)));
  const pure = libusePure(deps);
  if (pure && typeof pure.normalizeUsageRoots === 'function') {
    const normalized = pure.normalizeUsageRoots(resolved);
    if (normalized.length) return normalized;
  }
  return resolved;
}

// 相对路径按仓库根解释（用户也可能写 `E:/projects` 这种绝对路径）。
function libuseResolveRoots(deps, raw) {
  return libuseNormalizeRoots(deps, Array.isArray(raw) ? raw : libuseConfiguredRoots(deps));
}

// ── 工程发现 ────────────────────────────────────────────────────────────
function libuseReadUnityVersion(fs, file) {
  try {
    const text = String(fs.readFileSync(file, 'utf8')).slice(0, 4096);
    const match = /m_EditorVersion:\s*(\S+)/.exec(text);
    return match ? match[1] : '';
  } catch { return ''; }
}

// 在 root 下找 ProjectSettings/ProjectVersion.txt（root 自身是工程时也算）。深度有限，
// 避免用户在配置里写 `E:/` 把整块盘扫一遍。
function libuseFindProjects(deps, rootDir) {
  const found = [];
  const fs = deps.fs;
  const path = deps.path;
  const visit = (dir, depth) => {
    if (depth > LIBUSE_PROJECT_DEPTH) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const settings = entries.find((entry) => entry.isDirectory() && entry.name === 'ProjectSettings');
    if (settings) {
      const versionFile = path.join(dir, 'ProjectSettings', 'ProjectVersion.txt');
      if (fs.existsSync(versionFile)) {
        found.push({ name: path.basename(dir) || dir, path: dir, unityVersion: libuseReadUnityVersion(fs, versionFile) });
        return; // 工程内部的子目录不用再找工程
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (LIBUSE_SKIP_DIRS.has(entry.name)) continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };
  visit(rootDir, 0);
  return found;
}

// ── 匹配线索 ────────────────────────────────────────────────────────────
function libuseStripExtension(name) {
  const text = String(name || '');
  const index = text.lastIndexOf('.');
  return index > 0 ? text.slice(0, index) : text;
}

// `8844481 Mew_Pose.zip` 这种主件名去掉开头 BOOTH 号（避免只按号命中）。
function libuseAssetName(mainName) {
  return libuseStripExtension(mainName).replace(/^\d{5,9}[\s_-]+/, '').trim();
}

function libuseNeedles(card, pathModule) {
  const needles = [];
  const name = libuseAssetName(card?.mainName).toLowerCase();
  if (name.length >= 3) needles.push(name);
  const dirName = String(pathModule.basename(String(card?.dir || '')) || '').toLowerCase();
  if (dirName.length >= 3 && !needles.includes(dirName)) needles.push(dirName);
  return needles;
}

function libuseEvidence(text, needle) {
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return '';
  const start = Math.max(0, index - 12);
  const snippet = text.slice(start, start + LIBUSE_EVIDENCE_MAX * 2).replace(/\s+/g, ' ').trim();
  return snippet.slice(0, LIBUSE_EVIDENCE_MAX);
}

// ── GUID 精确匹配（有素材 GUID 时优先；拿不到就退回名字匹配）────────────────
function libuseAssetArchivePath(deps, card) {
  const rootDir = String(deps.fileArchiveRootDir?.() ?? '');
  if (!rootDir || !card?.dir || !card?.mainName) return '';
  return deps.path.join(rootDir, String(card.dir), String(card.mainName));
}

// 逐件素材解包抽 GUID（.unitypackage 是 tar.gz，条目名首段就是 GUID）。
// 只对本地压缩包做：文件不存在/太大/不是 zip 都跳过，记在 reasons 里，绝不抛。
function libuseCollectAssetGuids(deps, cards, options = {}) {
  const guidsPure = libuseGuidsPure(deps);
  const pure = libusePure(deps);
  const guidIndex = new Map(); // guid -> keys[]
  const byKey = new Map();     // key -> guids[]
  const reasons = {};
  if (!guidsPure || typeof guidsPure.guidsFromAssetFile !== 'function') {
    return { guidIndex, byKey, reasons: { missing_dep: 1 }, scanned: 0 };
  }
  const deadline = Number(options.deadline) || 0;
  let scanned = 0;
  for (const card of cards) {
    if (scanned >= LIBUSE_ASSET_SCAN_MAX) { reasons.limit = (reasons.limit || 0) + 1; break; }
    if (deadline && Date.now() > deadline) { reasons.timeout = (reasons.timeout || 0) + 1; break; }
    const filePath = libuseAssetArchivePath(deps, card);
    if (!filePath) { reasons.no_path = (reasons.no_path || 0) + 1; continue; }
    const extracted = guidsPure.guidsFromAssetFile({ filePath, fs: deps.fs, maxBytes: LIBUSE_ASSET_MAX_BYTES });
    const guids = Array.isArray(extracted?.guids) ? extracted.guids.slice(0, LIBUSE_ASSET_GUID_MAX) : [];
    if (!guids.length) {
      const reason = String(extracted?.reason || 'no_guid');
      reasons[reason] = (reasons[reason] || 0) + 1;
      continue;
    }
    scanned += 1;
    byKey.set(card.key, guids);
    for (const guid of guids) {
      const bucket = guidIndex.get(guid);
      if (bucket) bucket.push(card.key);
      else guidIndex.set(guid, [card.key]);
    }
  }
  return { guidIndex, byKey, reasons, scanned };
}

// 扫一个工程的 GUID 引用（Assets/ 下 .meta 与文本资产），再和素材 GUID 索引求交。
// fallbackCards：拿不到 GUID 的素材（真库里很多素材包根本没有 .unitypackage），
// 在同一遍读文件里顺手做名字兜底——不然这些素材只能判 unknown，白扫一趟。
function libuseScanProjectByGuid(deps, project, guidIndex, { deadline, isStopped, fallbackCards = [] }) {
  const fs = deps.fs;
  const path = deps.path;
  const pure = libusePure(deps);
  const hits = new Map(); // key -> {refs, evidence}
  const needlesByKey = new Map(fallbackCards.map((card) => [card.key, libuseNeedles(card, path)]));
  const nameMatched = new Set();
  let timedOut = false;
  let files = 0;
  const seenGuids = new Set();
  const visit = (dir) => {
    if (timedOut || isStopped() || files >= LIBUSE_MAX_FILES_PER_PROJECT) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (timedOut || isStopped() || files >= LIBUSE_MAX_FILES_PER_PROJECT) return;
      if (Date.now() > deadline) { timedOut = true; return; }
      if (entry.isDirectory()) {
        if (LIBUSE_SKIP_DIRS.has(entry.name)) continue;
        visit(path.join(dir, entry.name));
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!LIBUSE_EXT_FOR_GUID.includes(ext)) continue;
      const file = path.join(dir, entry.name);
      let stat = null;
      try { stat = fs.statSync(file); } catch { continue; }
      if (!stat || stat.size > LIBUSE_MAX_FILE_BYTES) continue;
      let text = '';
      try { text = String(fs.readFileSync(file, 'utf8')); } catch { continue; }
      files += 1;
      const guids = pure && typeof pure.collectGuidRefs === 'function'
        ? pure.collectGuidRefs(text, 4000)
        : (text.match(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi) || []).map((item) => item.toLowerCase());
      for (const guid of guids) {
        if (seenGuids.has(guid)) continue;
        seenGuids.add(guid);
        const keys = guidIndex.get(guid);
        if (!keys) continue;
        for (const key of keys) {
          const existing = hits.get(key);
          if (existing) existing.refs += 1;
          else hits.set(key, { refs: 1, evidence: libuseEvidence(text, guid) || guid.slice(0, 12) });
        }
      }
      if (!needlesByKey.size || nameMatched.size >= needlesByKey.size) continue;
      const lower = text.toLowerCase();
      for (const [key, needles] of needlesByKey) {
        if (hits.has(key)) continue;
        const needle = (needles || []).find((item) => lower.includes(item));
        if (!needle) continue;
        nameMatched.add(key);
        hits.set(key, { refs: 1, evidence: libuseEvidence(text, needle) || needle, via: 'name' });
      }
    }
  };
  visit(path.join(project.path, 'Assets'));
  return { hits, timedOut, files, nameMatched: nameMatched.size };
}

// ── 扫描 ────────────────────────────────────────────────────────────────
function libuseWalkFiles(deps, projectPath, onFile) {
  const fs = deps.fs;
  const path = deps.path;
  let seen = 0;
  const visit = (dir) => {
    if (seen >= LIBUSE_MAX_FILES_PER_PROJECT) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (seen >= LIBUSE_MAX_FILES_PER_PROJECT) return;
      if (entry.isDirectory()) {
        if (LIBUSE_SKIP_DIRS.has(entry.name)) continue;
        visit(path.join(dir, entry.name));
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!LIBUSE_TEXT_EXTENSIONS.includes(ext)) continue;
      seen += 1;
      onFile(path.join(dir, entry.name), ext);
    }
  };
  visit(projectPath);
  return seen;
}

// 扫一个工程：每个素材在这个工程里只要第一条证据。
function libuseScanProject(deps, project, cards, { deadline, isStopped, hooks }) {
  const fs = deps.fs;
  const path = deps.path;
  const hits = new Map(); // key -> evidence
  const needlesByKey = new Map(cards.map((card) => [card.key, libuseNeedles(card, path)]));
  let timedOut = false;
  libuseWalkFiles(deps, project.path, (file) => {
    if (timedOut || isStopped() || hits.size >= cards.length) return;
    if (Date.now() > deadline) { timedOut = true; return; }
    if (hooks && typeof hooks.onFile === 'function') hooks.onFile(file);
    let stat = null;
    try { stat = fs.statSync(file); } catch { return; }
    if (!stat || stat.size > LIBUSE_MAX_FILE_BYTES) return;
    let text = '';
    try { text = String(fs.readFileSync(file, 'utf8')); } catch { return; }
    const lower = text.toLowerCase();
    for (const card of cards) {
      if (hits.has(card.key)) continue;
      const needles = needlesByKey.get(card.key) || [];
      const needle = needles.find((item) => lower.includes(item));
      if (!needle) continue;
      hits.set(card.key, libuseEvidence(text, needle) || needle);
      if (hits.size >= cards.length) return;
    }
  });
  return { hits, timedOut };
}

function libuseMergeUsage(deps, state, cards, project, hits) {
  const now = Date.now();
  for (const [key, rawValue] of hits) {
    const value = rawValue && typeof rawValue === 'object' ? rawValue : { evidence: rawValue, refs: 1 };
    const entry = state.usage[key] || { projects: [], lastScanAt: 0 };
    // 同一工程重复扫（用户重跑）时替换旧结论，不堆重复项。
    entry.projects = (Array.isArray(entry.projects) ? entry.projects : []).filter((item) => item && item.path !== project.path);
    const card = cards.find((item) => item.key === key);
    entry.projects.push({
      name: String(project.name || ''), path: String(project.path || ''),
      evidence: String(value.evidence || '').slice(0, LIBUSE_EVIDENCE_MAX),
      refs: Number(value.refs) || 1,
      at: now, title: String(card?.title || '')
    });
    entry.projects = entry.projects.slice(-LIBUSE_MAX_PROJECTS_PER_ASSET);
    entry.usage = 'used';
    entry.lastScanAt = now;
    state.usage[key] = entry;
  }
}

// 扫完之后给每件素材落一个结论：used / unused / unknown（拿不到 GUID 判不了，就不能谎报没用过）。
function libuseApplyOutcome(deps, state, cards, byKey) {
  const pure = libusePure(deps);
  const usageCount = {};
  for (const card of cards) {
    const entry = state.usage[card.key] || { projects: [], lastScanAt: 0 };
    const projects = Array.isArray(entry.projects) ? entry.projects : [];
    if (projects.length) entry.usage = 'used';
    else if (byKey && byKey.has(card.key)) entry.usage = 'unused';
    else entry.usage = 'unknown';
    state.usage[card.key] = entry;
    usageCount[card.key] = entry.usage;
  }
  state.summary = pure && typeof pure.summarizeUsage === 'function'
    ? pure.summarizeUsage(usageCount)
    : {
      withUsage: Object.values(usageCount).filter((item) => item === 'used').length,
      unused: Object.values(usageCount).filter((item) => item === 'unused').length,
      unknown: Object.values(usageCount).filter((item) => item === 'unknown').length
    };
}

// ── 路由实现 ────────────────────────────────────────────────────────────
// 访客视图：本机绝对路径一律剥离。roots[].dir 是扫描根，projects[].path 是工程目录，
// usage 里的 projects 还带证据片段——访客只需要「哪个工程用过这件素材」的名字。
function libuseGuestRoots(roots) {
  return (Array.isArray(roots) ? roots : []).map((root) => ({
    exists: root?.exists === true,
    projects: (Array.isArray(root?.projects) ? root.projects : []).map((project) => ({ name: String(project?.name || '') }))
  }));
}

function libuseGuestUsage(usage) {
  if (!usage || typeof usage !== 'object') return {};
  const out = {};
  for (const [key, entry] of Object.entries(usage)) {
    const projects = Array.isArray(entry?.projects) ? entry.projects : [];
    out[key] = { projects: projects.map((project) => ({ name: String(project?.name || '') })) };
  }
  return out;
}

// 保存扫描根：写回 config.json 的 fileArchive.usageRoots（沿用现有 library 配置段的约定；
// 没另开 library.usageRoots 是因为 config-load 对未知段是白名单裁剪，新段还得改一处公共代码）。
function libusePersistRoots(deps, roots) {
  if (typeof deps.updateConfigFile !== 'function' || typeof deps.atomicWriteJson !== 'function') {
    throw new Error('当前版本没接线配置写盘（updateConfigFile），请用 /api/config 保存 fileArchive.usageRoots');
  }
  const configFile = deps.path.join(String(deps.ROOT), 'config.json');
  deps.updateConfigFile(configFile, (disk) => {
    const next = disk && typeof disk === 'object' ? { ...disk } : {};
    const fileArchive = next.fileArchive && typeof next.fileArchive === 'object' ? { ...next.fileArchive } : {};
    fileArchive.usageRoots = roots.slice();
    next.fileArchive = fileArchive;
    return next;
  }, { atomicWrite: deps.atomicWriteJson });
  if (typeof deps.reloadConfigFromDisk === 'function') {
    try { deps.reloadConfigFromDisk(); } catch { /* 热更失败不改结论：下次重启照样生效 */ }
  }
}

function libuseView(deps, state, options = {}) {
  const rootsConfigured = libuseConfiguredRoots(deps).length > 0;
  const guest = options.guest === true;
  const summary = state.summary && typeof state.summary === 'object'
    ? {
      withUsage: Number(state.summary.withUsage) || 0,
      unused: Number(state.summary.unused) || 0,
      unknown: Number(state.summary.unknown) || 0
    }
    : { withUsage: 0, unused: 0, unknown: 0 };
  return {
    ok: state.lastError && !state.scannedAt ? false : true,
    scannedAt: Number(state.scannedAt) || 0,
    rootsConfigured,
    roots: guest ? libuseGuestRoots(state.roots) : (Array.isArray(state.roots) ? state.roots : []),
    usage: guest ? libuseGuestUsage(state.usage) : (state.usage && typeof state.usage === 'object' ? state.usage : {}),
    summary,
    usageMode: state.usageMode === 'guid' ? 'guid' : 'name',
    running: state.running === true,
    error: String(state.lastError || '')
  };
}

function buildLibraryUsage(deps) {
  const state = libuseLoadState(deps);
  let stopRequested = false;

  async function runScan(roots) {
    const hooks = deps.usageScanHooks || null;
    const timeoutMs = Number(deps.usageScanTimeoutMs) > 0 ? Number(deps.usageScanTimeoutMs) : LIBUSE_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    state.running = true;
    state.startedAt = Date.now();
    state.scannedAt = 0;
    state.lastError = '';
    state.roots = [];
    state.usage = {};
    stopRequested = false;
    libuseSaveState(deps, state);

    let cards = [];
    try {
      const snap = deps.buildLibrarySnapshot({ fs: deps.fs, rootDir: String(deps.fileArchiveRootDir?.() ?? '') });
      cards = (Array.isArray(snap?.assets) ? snap.assets : []).filter((card) => card && card.key && card.dir && card.mainName);
    } catch (error) {
      state.running = false;
      state.lastError = `读取素材库失败：${error?.message ?? error}`;
      libuseSaveState(deps, state);
      return { ok: false, error: state.lastError };
    }

    // 素材侧 GUID 先抽（有 GUID 才能精确判「这个工程引用了这件素材」）。
    // 抽不到（云端卡/没下载完/包损坏）的素材算 unknown，后续退回名字匹配兜底。
    const guidData = libuseCollectAssetGuids(deps, cards, { deadline });
    state.usageMode = guidData.byKey.size > 0 ? 'guid' : 'name';
    // 拿不到 GUID 的素材在同一个工程扫描里做名字兜底（真库很多素材包没有 .unitypackage）。
    const fallbackCards = guidData.byKey.size > 0 ? cards.filter((card) => !guidData.byKey.has(card.key)) : [];
    let nameFallbackHits = 0;
    if (guidData.byKey.size > 0) {
      deps.log?.(`[工程使用统计] 素材 GUID：${guidData.byKey.size} 件可判，索引 ${guidData.guidIndex.size} 个 GUID${guidData.reasons && Object.keys(guidData.reasons).length ? `（跳过：${Object.entries(guidData.reasons).map(([key, value]) => `${key}×${value}`).join('、')}）` : ''}`);
    }

    for (const rootDir of roots) {
      const exists = (() => { try { return deps.fs.existsSync(rootDir) && deps.fs.statSync(rootDir).isDirectory(); } catch { return false; } })();
      const projects = exists ? libuseFindProjects(deps, rootDir) : [];
      state.roots.push({ dir: rootDir, exists, projects });
      libuseSaveState(deps, state);
      if (!exists) continue;
      for (const project of projects) {
        if (stopRequested) break;
        if (Date.now() > deadline) { state.lastError = 'timeout'; break; }
        const scanned = guidData.guidIndex.size > 0
          ? libuseScanProjectByGuid(deps, project, guidData.guidIndex, { deadline, isStopped: () => stopRequested, fallbackCards })
          : libuseScanProject(deps, project, cards, { deadline, isStopped: () => stopRequested, hooks });
        const { hits, timedOut } = scanned;
        nameFallbackHits += Number(scanned.nameMatched) || 0;
        libuseMergeUsage(deps, state, cards, project, hits);
        if (timedOut) { state.lastError = 'timeout'; break; }
        // 每扫完一个工程落一次盘：中途重启也能看到已扫到哪。
        libuseSaveState(deps, state);
        if (hooks && typeof hooks.onProject === 'function') hooks.onProject(project);
        await Promise.resolve();
      }
      if (stopRequested || state.lastError) break;
    }

    // 每件素材一个结论：用了 / 没用过 / 判不了（拿不到 GUID）。汇总行也在这里算。
    libuseApplyOutcome(deps, state, cards, guidData.byKey);
    state.running = false;
    state.scannedAt = Date.now();
    if (!stopRequested && !state.lastError) state.lastError = '';
    deps.log?.(`[工程使用统计] 扫描${stopRequested ? '已停止' : '完成'}：${state.roots.length} 个根、${state.roots.reduce((sum, root) => sum + (root.projects?.length || 0), 0)} 个工程，命中 ${Object.keys(state.usage).length} 件素材${nameFallbackHits ? `（其中 ${nameFallbackHits} 件靠名字兜底）` : ''}${state.lastError ? `（${state.lastError}）` : ''}`);
    libuseSaveState(deps, state);
    return { ok: true, stopped: stopRequested };
  }

// @bridge-function handleConsoleLibraryUsage:start
  async function handleConsoleLibraryUsage(request) {
    const { req, url, sendJson, readBody } = request;
    // 只读访客也能看统计，但只给「工程名」，不给任何本机路径（见 libuseGuestRoots）。
    const guest = String(request.consoleRole || '') === 'guest';
    // 只读扫描不写工程，但会读用户整块目录：仍归管理端，智能体一律 403。
    if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
      sendJson({ ok: false, error: '未授权：工程统计是管理端操作' }, 403);
      return true;
    }
    const pathname = url.pathname;

    if (pathname === '/api/library/usage' && req.method === 'GET') {
      sendJson(libuseView(deps, state, { guest }));
      return true;
    }

    if (pathname === '/api/library/usage' && req.method === 'POST') {
      // 保存扫描根属于改配置：访客只读，一律拒绝。
      if (guest) { sendJson({ ok: false, error: '未授权：访客不能修改扫描根' }, 403); return true; }
      if (state.running) { sendJson({ ok: false, error: '正在扫描：等这轮跑完或先停止' }, 409); return true; }
      let body = null;
      try { body = await readBody(); } catch (error) { sendJson({ ok: false, error: error?.message ?? '请求体非法' }, 400); return true; }
      const roots = libuseNormalizeRoots(deps, Array.isArray(body?.roots) ? body.roots : []);
      try {
        libusePersistRoots(deps, roots);
      } catch (error) {
        sendJson({ ok: false, error: `保存扫描根失败：${error?.message ?? error}` }, 500);
        return true;
      }
      deps.log?.(`[工程使用统计] 扫描根已保存：${roots.length} 个`);
      // 保存后立刻让内存态跟上，否则 POST 的响应里 roots 还是保存前那份（前端会以为没生效）。
      try { state.roots = libuseResolveRoots(deps, roots); } catch { /* 解析失败就保留旧内存态，GET 会按新配置重读 */ }
      sendJson({ ...libuseView(deps, state, { guest }), ok: true, rootsConfigured: roots.length > 0, saved: true, requested: roots.length });
      return true;
    }

    if (pathname === '/api/library/usage/scan' && req.method === 'POST') {
      if (state.running) { sendJson({ ok: false, error: '正在扫描：等这轮跑完或先停止' }, 409); return true; }
      let body = null;
      try { body = await readBody(); } catch (error) { sendJson({ ok: false, error: error?.message ?? '请求体非法' }, 400); return true; }
      const roots = libuseResolveRoots(deps, body?.roots);
      if (!roots.length) {
        sendJson({ ...libuseView(deps, state), ok: true, scannedAt: 0, error: '没有配置扫描根：请先在设置里填 fileArchive.usageRoots' });
        return true;
      }
      const result = await runScan(roots);
      if (!result.ok) { sendJson({ ok: false, error: result.error }, 500); return true; }
      // stopped 只在 scan 响应里给（GET 保持契约形状），前端据此提示「已停止」。
      sendJson({ ...libuseView(deps, state), stopped: result.stopped === true });
      return true;
    }

    if (pathname === '/api/library/usage/stop' && req.method === 'POST') {
      if (!state.running) { sendJson({ ok: false, error: '现在没有在跑的扫描' }, 409); return true; }
      stopRequested = true;
      sendJson({ ok: true, stopping: true });
      return true;
    }

    return false;
  }
// @bridge-function handleConsoleLibraryUsage:end

  return { handleConsoleLibraryUsage };
}

export function createLibraryUsage(deps) {
  let impl = null;
  const implOf = () => impl || (impl = buildLibraryUsage(deps));
  return { handleConsoleLibraryUsage: (request) => implOf().handleConsoleLibraryUsage(request) };
}
