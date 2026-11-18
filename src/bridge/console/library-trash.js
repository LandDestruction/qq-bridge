// 素材回收站（MioVRC 参考里的「一键清理回收站」，安全版）。
//
// 和 file-archive/recycle.js 的区别：那套是按**台账行**把已归档文件挪进 `.回收站`；
// 这里管的是「素材库认出来的件」（一个下载目录里的包+预览图+说明），按 key 整体挪进
// 档案根下的 `.trash/<批次>/<原相对路径>`——保留原目录结构，恢复时能原样放回去。
//
// 硬约束：
// - 只 move、不删原文件（真删只发生在显式 purge + confirm:true）；
// - 每一步路径都过 deps.safeResolveInside，绝不允许 `..` / 绝对路径把内容搬到档案根外；
// - 一件素材跨盘/被占用时**回滚该件已经挪走的文件**，不把半件素材留在回收站；
// - 重复入回收站幂等（同 key 已在回收站就跳过并回报，不重复搬）。
//
// 约束：本文件是 manifest 模块，被 scripts/bridge-source.mjs 用 vm.runInContext 裸执行，
// **不能 import**；纯规则/文件系统都从 deps 注入，构造期不读 deps（VM 边界测试会用
// 「一访问就抛」的 getter 构造工厂）。
// 顶部不要有和 src/bridge.js 同名的 const/let（VM 里共用一个全局词法作用域）。

const LIBTRASH_STATE_FILE = 'booth-trash.json';
// 档案根下的回收站目录名：用点开头，避免和用户自己的目录撞名。
const LIBTRASH_DIR = '.trash';
// 一次最多处理 50 件：再多就会让一次点击等太久，也让失败回滚的窗口过大。
const LIBTRASH_MAX_ITEMS = 50;
// 回收站保留期（天）：0 = 永久保留。默认 30 天，和档案台账的保留期不是一个东西——
// 台账清理删的是**归档文件**，这里清的是**被用户主动丢进回收站的素材**，所以单独配。
const LIBTRASH_RETENTION_DAYS = 30;
const LIBTRASH_MAX_RETENTION_DAYS = 3650;
// 自动清理挂在现有「文件清理」的每日调度点上（fileArchive.cleanupHour，默认凌晨 4 点）。
const LIBTRASH_DEFAULT_CLEANUP_HOUR = 4;

export function createLibraryTrash(deps) {
  let impl = null;
  const implOf = () => impl || (impl = buildLibraryTrash(deps));
  return { handleConsoleLibraryTrash: (request) => implOf().handleConsoleLibraryTrash(request) };
}

// ── 状态（state/booth-trash.json：回收站里有什么、在哪个批次、恢复回哪） ──────
function libtrStatePath(deps) {
  return deps.path.join(String(deps.STATE_DIR), LIBTRASH_STATE_FILE);
}

function libtrLoadState(deps) {
  const empty = { v: 1, at: 0, items: [] };
  let raw = null;
  try { raw = JSON.parse(deps.fs.readFileSync(libtrStatePath(deps), 'utf8')); } catch { return empty; }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return empty;
  const items = raw.items
    .filter((item) => item && typeof item === 'object' && String(item.movedTo || ''))
    .map((item) => ({
      id: String(item.id || ''),
      key: String(item.key || ''),
      title: String(item.title || item.key || ''),
      boothId: String(item.boothId || ''),
      bytes: Math.max(0, Math.trunc(Number(item.bytes) || 0)),
      files: Math.max(0, Math.trunc(Number(item.files) || 0)),
      at: Number(item.at) || 0,
      movedTo: String(item.movedTo || ''),
      fromDirs: Array.isArray(item.fromDirs) ? item.fromDirs.map((dir) => String(dir || '')) : [],
      relPaths: Array.isArray(item.relPaths) ? item.relPaths.map((rel) => String(rel || '')).filter(Boolean) : []
    }))
    .filter((item) => item.id && item.key && item.relPaths.length);
  return { v: 1, at: Number(raw.at) || 0, items };
}

function libtrSaveState(deps, state) {
  deps.atomicWriteJson(libtrStatePath(deps), { v: 1, at: Date.now(), items: state.items });
  state.at = Date.now();
}

// ── 档案根 / 扫描 / 视图 ────────────────────────────────────────────────
function libtrRoot(deps) {
  const raw = typeof deps.fileArchiveRootDir === 'function' ? deps.fileArchiveRootDir() : deps.fileArchiveRootDir;
  return String(raw || '');
}

// 扫描一次盘面并建 key→asset 索引：回收站按「件」搬，必须拿到这件到底有哪些文件。
// 导出给批量操作模块复用：同一个 key→asset 口径，免得两处各扫一遍还算不一致。
export function libtrAssetIndex(deps) {
  const root = libtrRoot(deps);
  const scan = deps.scanLibraryTree({ fs: deps.fs, rootDir: root });
  const grouped = deps.assetsFromFiles(scan.files || []);
  const byKey = new Map();
  for (const asset of grouped.assets || []) {
    const key = String(asset?.key || '');
    if (key) byKey.set(key, asset);
  }
  return { root, byKey, scan };
}

function libtrRelPathsOf(asset) {
  const seen = new Set();
  const out = [];
  for (const file of Array.isArray(asset?.files) ? asset.files : []) {
    const rel = String(file?.relPath || file?.name || '');
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

// 批次号：本地时间 `YYYYMMDDTHHMMSS`（例 20261030T012233），拼上 key 前 8 位字母数字。
function libtrStamp(nowMs) {
  const d = new Date(Number(nowMs) || Date.now());
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function libtrSlug(key) {
  const slug = String(key || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  return slug || 'item';
}

// 批次目录不撞车：同 key 同秒重入（先恢复再回收）时补 -2、-3。
function libtrBatchRel(deps, root, key, nowMs) {
  const base = `${LIBTRASH_DIR}/${libtrStamp(nowMs)}_${libtrSlug(key)}`;
  const state = libtrLoadState(deps);
  let rel = base;
  let n = 1;
  while (state.items.some((item) => item.movedTo === rel) || deps.fs.existsSync(deps.path.join(root, rel))) {
    n += 1;
    rel = `${base}-${n}`;
  }
  return rel;
}

function libtrView(deps, state) {
  const root = libtrRoot(deps);
  const items = state.items.map((item) => {
    let restorable = false;
    // 只有「合法 id + 指向 .trash 直接子项」的记录才可能恢复；手改状态文件造的越界记录一律显示不可恢复。
    if (libtrEntryIdOk(item.id) && libtrBatchAbs(deps, root, item.movedTo)) {
      try { restorable = deps.fs.existsSync(deps.path.resolve(root || '.', item.movedTo)); } catch { restorable = false; }
    }
    return {
      id: item.id,
      key: item.key,
      title: item.title,
      boothId: item.boothId,
      bytes: item.bytes,
      files: item.files,
      at: item.at,
      movedTo: item.movedTo,
      restorable
    };
  });
  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0);
  return {
    ok: true,
    items,
    totalBytes,
    count: items.length,
    // 前端要能直接说清「多久会自动清一次、下次什么时候」——不必再拉设置。
    retentionDays: libtrRetentionDays(deps),
    nextCleanupAt: libtrNextCleanupAt(deps)
  };
}

// ── 移动 / 回滚（回收站全部动作都建立在「先算好计划、再逐步执行、失败就回滚」上） ──
function libtrMoveOne(deps, root, fromRel, toRel) {
  const fromAbs = deps.safeResolveInside(root, fromRel);
  const toAbs = deps.safeResolveInside(root, toRel);
  deps.fs.mkdirSync(deps.path.dirname(toAbs), { recursive: true });
  deps.fs.renameSync(fromAbs, toAbs);
}

function libtrRollback(deps, root, moved) {
  for (let i = moved.length - 1; i >= 0; i -= 1) {
    const pair = moved[i];
    try { libtrMoveOne(deps, root, pair.toRel, pair.fromRel); } catch { /* 回滚失败只能留日志，下面统一报 */ }
  }
}

// 移动一件素材：成功返回 {ok:true,item}；任何失败都回滚该件并返回 {ok:false,error}。
function libtrMoveAsset(deps, state, asset, key, nowMs) {
  const root = libtrRoot(deps);
  const relPaths = libtrRelPathsOf(asset);
  if (!relPaths.length) return { ok: false, error: '这件素材在盘上找不到文件（可能刚被移动过）' };
  let batchRel = '';
  try {
    batchRel = libtrBatchRel(deps, root, key, nowMs);
  } catch (error) {
    return { ok: false, error: `算回收站目录失败：${error?.message ?? error}` };
  }
  const moved = [];
  for (const rel of relPaths) {
    const toRel = `${batchRel}/${rel}`;
    try {
      libtrMoveOne(deps, root, rel, toRel);
      moved.push({ fromRel: rel, toRel });
    } catch (error) {
      libtrRollback(deps, root, moved);
      return { ok: false, error: `移动失败（已回滚）：${error?.message ?? error}` };
    }
  }
  const at = Number(nowMs) || Date.now();
  const item = {
    id: batchRel.split('/').pop(),
    key,
    title: String(asset?.title || key),
    boothId: String(asset?.boothId || ''),
    bytes: relPaths.reduce((sum, rel) => {
      const file = (asset.files || []).find((f) => String(f?.relPath || f?.name) === rel);
      return sum + Math.max(0, Math.trunc(Number(file?.bytes) || 0));
    }, 0),
    files: relPaths.length,
    at,
    movedTo: batchRel,
    fromDirs: [...new Set(relPaths.map((rel) => {
      const dir = deps.path.posix.dirname(rel);
      return dir === '.' ? '' : dir;
    }))],
    relPaths
  };
  state.items.push(item);
  libtrSaveState(deps, state);
  deps.log(`[回收站] 移入 ${item.id}：${item.title}（${item.files} 个文件，${item.bytes} 字节）`);
  return { ok: true, item };
}

/**
 * 批量把 keys 移进回收站（POST /api/library/trash 与批量操作共用的唯一入口）。
 * 逐个执行、失败不中断；同一件已在回收站里 → skipped；库里找不到 → failed。
 * 返回 {ok, moved, skipped, failed, state}；扫描失败时 ok:false + error（由调用方转 HTTP 状态）。
 */
export function libtrTrashKeys(deps, keys, options = {}) {
  const state = libtrLoadState(deps);
  let index = null;
  try { index = libtrAssetIndex(deps); } catch (error) {
    return { ok: false, moved: [], skipped: [], failed: [], state, error: `扫描素材库失败：${error?.message ?? error}` };
  }
  const moved = [];
  const skipped = [];
  const failed = [];
  const nowMs = Number(options?.nowMs) || Date.now();
  const seen = new Set();
  for (const raw of Array.isArray(keys) ? keys : []) {
    const key = String(raw ?? '').trim();
    if (!key) { failed.push({ key: '', error: 'key 为空' }); continue; }
    const existing = state.items.find((item) => item.key === key);
    if (existing) { skipped.push({ key, id: existing.id, reason: '已在回收站里，跳过' }); continue; }
    const asset = index.byKey.get(key);
    if (!asset) { failed.push({ key, error: '库里找不到这件素材（可能刚被移动/改名）' }); continue; }
    // 同一批里重复的 key 只搬一次（前端多选时不该出现，但别把同一件挪两次）。
    if (seen.has(key)) { skipped.push({ key, reason: '这一批里重复的 key，跳过' }); continue; }
    seen.add(key);
    const result = libtrMoveAsset(deps, state, asset, key, nowMs);
    if (result.ok) moved.push(result.item);
    else failed.push({ key, error: result.error });
  }
  return { ok: true, moved, skipped, failed, state };
}

// 恢复一件：先全量预检（目标已存在同名 → 冲突 400，不允许覆盖半途而废），再逐步移回。
function libtrRestoreItem(deps, state, item) {
  const root = libtrRoot(deps);
  const conflicts = [];
  const missing = [];
  for (const rel of item.relPaths) {
    let toAbs = '';
    let fromAbs = '';
    try {
      toAbs = deps.safeResolveInside(root, rel);
      fromAbs = deps.safeResolveInside(root, `${item.movedTo}/${rel}`);
    } catch {
      conflicts.push(rel);
      continue;
    }
    if (deps.fs.existsSync(toAbs)) conflicts.push(rel);
    else if (!deps.fs.existsSync(fromAbs)) missing.push(rel);
  }
  if (conflicts.length) {
    return { ok: false, code: 400, error: `原位置已有同名文件，拒绝覆盖：${conflicts.slice(0, 3).join('、')}` };
  }
  if (missing.length) {
    return { ok: false, code: 409, error: `回收站里缺少文件，无法完整恢复：${missing.slice(0, 3).join('、')}` };
  }
  const moved = [];
  for (const rel of item.relPaths) {
    const fromRel = `${item.movedTo}/${rel}`;
    try {
      libtrMoveOne(deps, root, fromRel, rel);
      moved.push({ fromRel, toRel: rel });
    } catch (error) {
      libtrRollback(deps, root, moved);
      return { ok: false, code: 500, error: `恢复失败（已回滚）：${error?.message ?? error}` };
    }
  }
  state.items = state.items.filter((it) => it.id !== item.id);
  libtrSaveState(deps, state);
  // 批次目录此刻应该空了：删掉空壳，避免 .trash 里积一堆空目录（删不掉也不影响恢复）。
  try {
    const batchAbs = deps.safeResolveInside(root, item.movedTo);
    deps.fs.rmSync(batchAbs, { recursive: true, force: true });
  } catch { /* 目录里还有别的东西就留着 */ }
  deps.log(`[回收站] 恢复 ${item.id}：${item.title}（${moved.length} 个文件）`);
  return { ok: true, restored: moved.length, item };
}

function libtrPurgeItem(deps, root, item) {
  const abs = deps.safeResolveInside(root, item.movedTo);
  deps.fs.rmSync(abs, { recursive: true, force: true });
  deps.log(`[回收站] 真删 ${item.id}：${item.title}`);
  return item;
}

// ── 自动清理（保留期 + 每天 cleanupHour 跑一次） ─────────────────────────
// 为什么不是随便起个 setInterval：档案清理已经有「每小时轮询命中 cleanupHour + lastDay 去重 +
// 启动补跑」这套调度（file-archive-runtime.js:startArchiveCleanupLoop），回收站挂在同一个点上，
// 用户看到的「清理时间」才是同一个概念；自建定时器会在重启时丢、也容易和档案清理撞在同一秒。
// 注：导出这些函数只是给测试直接调（模块在 VM 里被裸执行，export 会被剥掉，不影响运行时）。
export function libtrRetentionDays(deps) {
  const raw = deps.cfg?.fileArchive?.trashRetentionDays;
  const days = Number(raw);
  if (!Number.isFinite(days)) return LIBTRASH_RETENTION_DAYS;
  // 0 是合法值（永久保留），不能被 `||` 兜成默认值。
  return Math.min(LIBTRASH_MAX_RETENTION_DAYS, Math.max(0, Math.round(days)));
}

export function libtrCleanupHour(deps) {
  const raw = Number(deps.cfg?.fileArchive?.cleanupHour);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : LIBTRASH_DEFAULT_CLEANUP_HOUR;
}

// 下次自动清理时间：今天的 cleanupHour:00 已过就顺延到明天（可近似，差几秒无所谓）。
export function libtrNextCleanupAt(deps, nowMs = Date.now()) {
  const d = new Date(Number(nowMs) || Date.now());
  d.setHours(libtrCleanupHour(deps), 0, 0, 0);
  if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// 自动清理：只删 at 早于保留期的条目；保留期 0 = 永久保留，直接跳过。
// 单条删失败不影响其它条（回收站目录可能被别的进程占着），失败数如实回报。
export async function libtrAutoPurge(deps, options = {}) {
  const days = libtrRetentionDays(deps);
  const nowMs = Number(options?.nowMs) || Date.now();
  const nextCleanupAt = libtrNextCleanupAt(deps, nowMs);
  if (days <= 0) return { ok: true, skipped: true, days, purged: 0, bytes: 0, failed: 0, nextCleanupAt };
  const state = libtrLoadState(deps);
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  const victims = state.items.filter((item) => item.at > 0 && item.at < cutoff);
  if (!victims.length) return { ok: true, days, purged: 0, bytes: 0, failed: 0, nextCleanupAt };
  const root = libtrRoot(deps);
  let purgedBytes = 0;
  let failed = 0;
  const purgedIds = [];
  for (const item of victims) {
    try {
      libtrPurgeItem(deps, root, item);
      purgedIds.push(item.id);
      purgedBytes += item.bytes;
    } catch { failed += 1; }
  }
  if (purgedIds.length > 0) {
    const gone = new Set(purgedIds);
    state.items = state.items.filter((item) => !gone.has(item.id));
    libtrSaveState(deps, state);
    deps.log(`回收站自动清理：删掉 ${purgedIds.length} 件（保留期 ${days} 天）`);
    return { ok: true, days, purged: purgedIds.length, bytes: purgedBytes, failed, nextCleanupAt };
  }
  if (failed > 0) deps.log(`回收站自动清理：${failed} 件删不掉（可能被占用），下个清理点再试`);
  return { ok: true, days, purged: 0, bytes: 0, failed, nextCleanupAt };
}

function libtrReadBody(request) {
  return request.readBody();
}

// ── 存储统计 / 手动清理（前端「回收站占用多少、清理掉多少」用） ─────────────
// 路径穿越防线（三道）：
// ① 请求里来的 entry id 必须是「批次目录名」这一层：不含 / \ ..、不是绝对路径、不是盘符；
// ② 状态文件里的 movedTo 必须解析到 `.trash` 的**直接子项**，否则一律不认（状态文件是可被手改的）；
// ③ 真正删之前仍然过 safeResolveInside（既有防线，不替代 ①②）。
const LIBTRASH_ENTRY_ID_MAX = 200;

/** 入口 id 合法性：只允许 `.trash` 下的直接子项名（批次目录）。非法返回空串。 */
export function libtrEntryIdOk(raw) {
  const id = String(raw ?? '').trim();
  if (!id || id.length > LIBTRASH_ENTRY_ID_MAX) return '';
  if (id === '.' || id === '..') return '';
  if (/[\\/]/.test(id)) return ''; // ../x、a/b、C:\x 全在这里挡掉
  if (/^[A-Za-z]:/.test(id) || id.startsWith('~')) return '';
  if (/[\u0000-\u001f\u007f]/.test(id)) return '';
  return id;
}

/** `.trash` 的绝对路径（没建过目录也返回预期路径，前端要显示「会占多少」）。 */
export function libtrTrashDir(deps) {
  return deps.path.resolve(libtrRoot(deps) || '.', LIBTRASH_DIR);
}

/** movedTo 是否指向 `.trash` 的直接子项（批次目录）；是则返回绝对路径，否则空串。 */
export function libtrBatchAbs(deps, root, movedTo) {
  const trashAbs = deps.path.resolve(root || '.', LIBTRASH_DIR);
  const abs = deps.path.resolve(root || '.', String(movedTo || ''));
  if (!abs || abs === trashAbs) return '';
  const rel = deps.path.relative(trashAbs, abs);
  if (!rel || rel.startsWith('..') || deps.path.isAbsolute(rel)) return '';
  if (rel.split(deps.path.sep).filter(Boolean).length !== 1) return ''; // 只能是直接子项
  return abs;
}

/** 递归统计目录里的文件数与字节数：跳过符号链接，读不动的目录/文件直接跳过（不 500）。 */
export function libtrWalkCount(deps, dir) {
  let files = 0;
  let bytes = 0;
  const visit = (abs) => {
    let entries = null;
    try { entries = deps.fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of Array.isArray(entries) ? entries : []) {
      const name = String(entry?.name ?? entry ?? '');
      if (!name) continue;
      if (typeof entry?.isSymbolicLink === 'function' && entry.isSymbolicLink()) continue;
      const child = deps.path.join(abs, name);
      if (typeof entry?.isDirectory === 'function' && entry.isDirectory()) { visit(child); continue; }
      try {
        const stat = deps.fs.statSync(child);
        if (!stat.isFile()) continue;
        files += 1;
        bytes += Math.max(0, Math.trunc(Number(stat.size) || 0));
      } catch { /* 读不动的文件跳过，统计照常返回 */ }
    }
  };
  visit(dir);
  return { files, bytes };
}

/** `.trash` 所在卷的剩余/总字节；`fs.statfs` 不可用或失败返回 null（前端隐藏这一栏）。 */
export async function libtrDiskSpace(deps, dir) {
  try {
    const promises = deps.fs?.promises;
    const statfs = promises && typeof promises.statfs === 'function' ? promises.statfs.bind(promises) : null;
    if (!statfs) return { diskFree: null, diskTotal: null };
    const stats = await statfs(dir);
    const bsize = Number(stats?.bsize ?? stats?.frsize) || 0;
    const total = bsize > 0 ? Number(stats?.blocks) * bsize : NaN;
    const avail = Number(stats?.bavail ?? stats?.bfree);
    const free = bsize > 0 && Number.isFinite(avail) ? avail * bsize : NaN;
    return {
      diskFree: Number.isFinite(free) ? free : null,
      diskTotal: Number.isFinite(total) ? total : null
    };
  } catch {
    return { diskFree: null, diskTotal: null };
  }
}

/** GET /api/library/trash/storage 的返回体：只读盘面，不改任何东西。 */
export async function libtrStorageSnapshot(deps) {
  const root = libtrRoot(deps);
  const trashAbs = deps.path.resolve(root || '.', LIBTRASH_DIR);
  const counts = libtrWalkCount(deps, trashAbs);
  const disk = await libtrDiskSpace(deps, trashAbs);
  return {
    ok: true,
    root: trashAbs,
    bytes: counts.bytes,
    files: counts.files,
    diskFree: disk.diskFree,
    diskTotal: disk.diskTotal,
    checkedAt: Date.now()
  };
}

/**
 * POST /api/library/trash/cleanup：按保留期清理**已过期**的条目。
 * - 保留期 0 = 永久保留 → 一件不删，回 purged:0 并说明；
 * - 逐条删，某件删失败只记数、不影响其它件（错误在 error 字段里如实说）。
 */
export async function libtrCleanupExpired(deps, options = {}) {
  const days = libtrRetentionDays(deps);
  const nowMs = Number(options?.nowMs) || Date.now();
  const state = libtrLoadState(deps);
  const base = { ok: true, purged: 0, bytes: 0, kept: state.items.length, retentionDays: days };
  if (days <= 0) {
    return { ...base, skipped: true, note: `保留期为 0（永久保留），不做清理（${state.items.length} 件全部保留）` };
  }
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  const victims = state.items.filter((item) => Number(item.at) > 0 && Number(item.at) < cutoff);
  if (!victims.length) return base;
  const root = libtrRoot(deps);
  const removed = [];
  let purgedBytes = 0;
  let failed = 0;
  for (const item of victims) {
    const abs = libtrBatchAbs(deps, root, item.movedTo);
    if (!abs) { failed += 1; continue; } // 越界/损坏记录：不删，留给人工看
    try {
      deps.fs.rmSync(abs, { recursive: true, force: true });
    } catch {
      failed += 1;
      continue;
    }
    removed.push(item.id);
    purgedBytes += Math.max(0, Math.trunc(Number(item.bytes) || 0));
  }
  if (removed.length) {
    const gone = new Set(removed);
    state.items = state.items.filter((item) => !gone.has(item.id));
    libtrSaveState(deps, state);
    deps.log(`[回收站] 手动清理：删掉 ${removed.length} 件（保留期 ${days} 天）`);
  }
  const result = { ...base, purged: removed.length, bytes: purgedBytes, kept: state.items.length };
  if (failed) result.error = `${failed} 件删除失败（可能被占用），其余已清理`;
  return result;
}

function buildLibraryTrash(deps) {
  // @bridge-function handleConsoleLibraryTrash:start
  async function handleConsoleLibraryTrash(request) {
  const { req, url, sendJson } = request;
  // 回收站会真的移动/删除用户素材：只给管理端，智能体一律 403。
  if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
    sendJson({ ok: false, error: '未授权：素材回收站是管理端操作' }, 403);
    return true;
  }
  const pathname = url.pathname;
  const state = libtrLoadState(deps);

  if (pathname === '/api/library/trash' && req.method === 'GET') {
    sendJson(libtrView(deps, state));
    return true;
  }

  if (pathname === '/api/library/trash' && req.method === 'POST') {
    let body = null;
    try { body = await libtrReadBody(request); } catch (error) {
      sendJson({ ok: false, error: error?.message ?? '请求体非法' }, 400);
      return true;
    }
    const rawKeys = Array.isArray(body?.keys) ? body.keys : null;
    if (!rawKeys || !rawKeys.length) {
      sendJson({ ok: false, error: '请先选要移入回收站的素材（keys 不能为空）' }, 400);
      return true;
    }
    if (rawKeys.length > LIBTRASH_MAX_ITEMS) {
      sendJson({ ok: false, error: `一次最多移入 ${LIBTRASH_MAX_ITEMS} 件，请分几次选` }, 400);
      return true;
    }
    // 搬移逻辑在模块作用域的 libtrTrashKeys（批量操作接口也调它，两处不能各写一套）。
    const result = libtrTrashKeys(deps, rawKeys);
    if (!result.ok) {
      sendJson({ ok: false, error: result.error }, 500);
      return true;
    }
    sendJson({ ok: true, moved: result.moved, skipped: result.skipped, failed: result.failed, ...libtrView(deps, result.state) });
    return true;
  }

  if (pathname === '/api/library/trash/restore' && req.method === 'POST') {
    let body = null;
    try { body = await libtrReadBody(request); } catch (error) {
      sendJson({ ok: false, error: error?.message ?? '请求体非法' }, 400);
      return true;
    }
    const id = libtrEntryIdOk(body?.id);
    if (!id) { sendJson({ ok: false, error: 'id 非法：只接受回收站里的条目名（不含路径）' }, 400); return true; }
    const item = state.items.find((it) => it.id === id);
    if (!item) { sendJson({ ok: false, error: '回收站里没有这条记录' }, 400); return true; }
    const result = libtrRestoreItem(deps, state, item);
    if (!result.ok) { sendJson({ ok: false, error: result.error }, result.code || 500); return true; }
    sendJson({ ok: true, id, restored: result.restored, ...libtrView(deps, state) });
    return true;
  }

  if (pathname === '/api/library/trash/purge' && req.method === 'POST') {
    let body = null;
    try { body = await libtrReadBody(request); } catch (error) {
      sendJson({ ok: false, error: error?.message ?? '请求体非法' }, 400);
      return true;
    }
    if (body?.confirm !== true) {
      sendJson({ ok: false, error: '真删需要二次确认（confirm:true）' }, 400);
      return true;
    }
    const root = libtrRoot(deps);
    const id = libtrEntryIdOk(body?.id);
    if (String(body?.id ?? '').trim() && !id) {
      sendJson({ ok: false, error: 'id 非法：只接受回收站里的条目名（不含路径）' }, 400);
      return true;
    }
    const olderThanDays = Number(body?.olderThanDays);
    const purged = [];
    let purgedBytes = 0;
    if (id) {
      const item = state.items.find((it) => it.id === id);
      if (!item) { sendJson({ ok: false, error: '回收站里没有这条记录' }, 400); return true; }
      try {
        libtrPurgeItem(deps, root, item);
      } catch (error) {
        sendJson({ ok: false, error: `删除失败：${error?.message ?? error}` }, 500);
        return true;
      }
      purged.push(id);
      purgedBytes += item.bytes;
      state.items = state.items.filter((it) => it.id !== id);
      libtrSaveState(deps, state);
    } else if (Number.isFinite(olderThanDays) && olderThanDays >= 0) {
      const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
      const victims = state.items.filter((it) => it.at > 0 && it.at < cutoff);
      if (!victims.length) {
        sendJson({ ok: true, purged: [], count: 0, bytes: 0, ...libtrView(deps, state) });
        return true;
      }
      for (const item of victims) {
        try { libtrPurgeItem(deps, root, item); } catch (error) {
          sendJson({ ok: false, error: `删除 ${item.id} 失败：${error?.message ?? error}` }, 500);
          return true;
        }
        purged.push(item.id);
        purgedBytes += item.bytes;
      }
      state.items = state.items.filter((it) => !purged.includes(it.id));
      libtrSaveState(deps, state);
    } else {
      sendJson({ ok: false, error: '请传 id 或 olderThanDays（早于 N 天）' }, 400);
      return true;
    }
    sendJson({ ok: true, purged, count: purged.length, bytes: purgedBytes, ...libtrView(deps, state) });
    return true;
  }

  // GET /api/library/trash/storage：只读统计（回收站占用 + 所在卷剩余）。前端存储卡片用。
  if (pathname === '/api/library/trash/storage') {
    if (req.method !== 'GET') {
      sendJson({ ok: false, error: '该接口只支持 GET' }, 405);
      return true;
    }
    sendJson(await libtrStorageSnapshot(deps));
    return true;
  }

  // POST /api/library/trash/cleanup：按保留期清理过期条目（必须 confirm:true，不可恢复）。
  if (pathname === '/api/library/trash/cleanup') {
    if (req.method !== 'POST') {
      sendJson({ ok: false, error: '该接口只支持 POST' }, 405);
      return true;
    }
    let body = null;
    try { body = await libtrReadBody(request); } catch (error) {
      sendJson({ ok: false, error: error?.message ?? '请求体非法' }, 400);
      return true;
    }
    if (!body || body.confirm !== true) {
      sendJson({ ok: false, error: '清理不可恢复，请带 confirm:true' }, 400);
      return true;
    }
    sendJson(await libtrCleanupExpired(deps, { nowMs: Date.now() }));
    return true;
  }

  return false;
}
// @bridge-function handleConsoleLibraryTrash:end

  return { handleConsoleLibraryTrash };
}
