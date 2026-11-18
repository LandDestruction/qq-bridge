// 素材「归位」：把躺在日期目录（`2026-10`）里的素材挪进它自己的独立目录。
//
// 为什么要有这个模块：同步已购 / 手动导入会按「下载月份」落盘成 `2026-10`，一个月的素材全挤在
// 同一个目录里；而改名、合并主成员选择（src/library-rename.js:108、src/library-merge.js:148）
// 都要求素材在**独立目录**里，否则只能提示「先归位」。以前没有这个入口，日期目录里的素材就永远
// 改不了名。这里补上「移出去」这一步，并留一份可撤销的日志（移完的 key 会变，用户点错了要能退）。
//
// 移动口径：
// - 目标目录 = 日期目录的**父目录**下的 `<boothId>_<标题>`（没有号就用标题）：和既有归档布局
//   `<群目录>/<BOOTH号>/` 同一层，不把素材搬出它所属的群目录；
// - 只搬这件素材自己目录里的文件（asset.files），日期目录里别的素材不动；
// - 走 safeResolveInside，目标已存在 → 409（绝不覆盖）；
// - 源目录末段必须像 `2026-10` 才会动手。
//
// key 语义：普通文件/压缩包的 key 只由「主件名 + 字节数」决定（src/library-asset.js:234），
// 换目录不变，所以绑定表不需要迁移；解压开的 Unity 工程 key 才与目录名有关（同文件 :270），
// 但那种工程的 asset.dir 末段是工程目录名、本来就过不了日期目录判定，此入口不会碰到。
//
// 约束：本文件是 manifest 模块，被 scripts/bridge-source.mjs 用 vm.runInContext 裸执行，
// **不能 import**；构造期不读 deps。顶部不要和 src/bridge.js 同名的 const/let。

const LIBREL_STATE_FILE = 'booth-relocations.json';
const LIBREL_DATE_DIR_RE = /^\d{4}-\d{2}$/;
const LIBREL_MAX_NAME = 80;
const LIBREL_MAX_ITEMS = 200;

export function createLibraryRelocate(deps) {
  let impl = null;
  const implOf = () => impl || (impl = buildLibraryRelocate(deps));
  return { handleConsoleLibraryRelocate: (request) => implOf().handleConsoleLibraryRelocate(request) };
}

// ── 状态（`state/booth-relocations.json`：撤销要靠它，所以写盘必须原子） ─────
function librelStatePath(deps) {
  return deps.path.join(String(deps.STATE_DIR), LIBREL_STATE_FILE);
}

function librelLoadState(deps) {
  const empty = { v: 1, at: 0, items: [] };
  let raw = null;
  try { raw = JSON.parse(deps.fs.readFileSync(librelStatePath(deps), 'utf8')); } catch { return empty; }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return empty;
  const items = raw.items
    .filter((item) => item && typeof item === 'object' && String(item.key || ''))
    .map((item) => ({
      id: String(item.id || ''),
      key: String(item.key || ''),
      title: String(item.title || ''),
      boothId: String(item.boothId || ''),
      fromDir: String(item.fromDir || ''),
      toDir: String(item.toDir || ''),
      relPaths: Array.isArray(item.relPaths) ? item.relPaths.map((rel) => String(rel || '')).filter(Boolean) : [],
      at: Number(item.at) || 0,
      undone: item.undone === true,
      undoneAt: Number(item.undoneAt) || 0
    }))
    .filter((item) => item.id && item.fromDir && item.toDir && item.relPaths.length);
  return { v: 1, at: Number(raw.at) || 0, items };
}

function librelSaveState(deps, state) {
  const items = state.items.slice(-LIBREL_MAX_ITEMS);
  deps.atomicWriteJson(librelStatePath(deps), { v: 1, at: Number(state.at) || Date.now(), items });
}

function librelRoot(deps) {
  const raw = typeof deps.fileArchiveRootDir === 'function' ? deps.fileArchiveRootDir() : deps.fileArchiveRootDir;
  return String(raw || '');
}

// ── 磁盘 → asset 索引（和回收站/批量同一套扫盘口径） ──────────────────────
function librelAssetIndex(deps) {
  const root = librelRoot(deps);
  const scan = deps.scanLibraryTree({ fs: deps.fs, rootDir: root });
  const grouped = deps.assetsFromFiles(scan.files || []);
  const byKey = new Map();
  for (const asset of grouped.assets || []) {
    const key = String(asset?.key || '');
    if (key) byKey.set(key, asset);
  }
  return { root, byKey };
}

function librelRelPathsOf(asset) {
  const seen = new Set();
  const out = [];
  for (const file of Array.isArray(asset?.files) ? asset.files : []) {
    const rel = String(file?.relPath || '');
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

/** 目录名清洗：Windows 非法字符换掉、去末尾点/空格、限长；空了用兜底名。 */
function librelSafeName(raw, fallback) {
  let name = String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (name.length > LIBREL_MAX_NAME) name = name.slice(0, LIBREL_MAX_NAME).trim();
  return name || fallback;
}

/** 目标目录名：有 BOOTH 号用 `<号>_<标题>`，没有就只用标题。 */
function librelTargetName(asset) {
  const title = librelSafeName(asset?.title, '素材');
  const boothId = String(asset?.boothId || '').trim();
  return boothId ? librelSafeName(`${boothId}_${title}`, title) : title;
}

/**
 * 算计划：不碰盘。返回 {ok:true, root, key, asset, fromDir, parentDir, toDir, targetName, relPaths}
 * 或 {ok:false, status, error}。
 */
function librelPlan(deps, index, key) {
  const asset = index.byKey.get(key);
  if (!asset) return { ok: false, status: 400, error: '库里找不到这件素材（可能刚被移动/改名）' };
  const fromDir = String(asset.dir || '').replace(/\\/g, '/');
  const relPaths = librelRelPathsOf(asset);
  if (!fromDir) return { ok: false, status: 400, error: '这件素材没有目录信息，没法归位' };
  if (!relPaths.length) return { ok: false, status: 409, error: '这件素材在盘上找不到文件（可能刚被移动过）' };
  const segments = fromDir.split('/').filter(Boolean);
  const last = segments[segments.length - 1] || '';
  if (!LIBREL_DATE_DIR_RE.test(last)) {
    return { ok: false, status: 400, error: `这件素材不在日期目录里（当前目录：${fromDir}），不用归位` };
  }
  const parentDir = segments.slice(0, -1).join('/');
  const targetName = librelTargetName(asset);
  if (targetName === last) return { ok: false, status: 400, error: '目标目录名和原目录一样，没法归位' };
  const toDir = parentDir ? `${parentDir}/${targetName}` : targetName;
  const targetAbs = deps.safeResolveInside(index.root, toDir);
  if (deps.fs.existsSync(targetAbs)) {
    return { ok: false, status: 409, error: `目标目录已存在，拒绝覆盖：${toDir}` };
  }
  return { ok: true, root: index.root, key, asset, fromDir, parentDir, toDir, targetName, relPaths };
}

function librelDoMove(deps, plan) {
  const pairs = plan.relPaths.map((rel) => ({
    fromRel: rel,
    toRel: `${plan.toDir}/${rel.slice(rel.lastIndexOf('/') + 1)}`
  }));
  const done = [];
  try {
    for (const pair of pairs) {
      const fromAbs = deps.safeResolveInside(plan.root, pair.fromRel);
      const toAbs = deps.safeResolveInside(plan.root, pair.toRel);
      deps.fs.mkdirSync(deps.path.dirname(toAbs), { recursive: true });
      deps.fs.renameSync(fromAbs, toAbs);
      done.push(pair);
    }
  } catch (error) {
    // 半截失败要退回原样：只回滚已经搬动的文件，然后报错（回调方回 500）。
    for (let i = done.length - 1; i >= 0; i -= 1) {
      try {
        const fromAbs = deps.safeResolveInside(plan.root, done[i].fromRel);
        const toAbs = deps.safeResolveInside(plan.root, done[i].toRel);
        deps.fs.mkdirSync(deps.path.dirname(fromAbs), { recursive: true });
        deps.fs.renameSync(toAbs, fromAbs);
      } catch { /* 回滚失败只能留日志，下面统一报 */ }
    }
    throw error;
  }
  return pairs;
}

function librelDoUndo(deps, index, item) {
  // 逆着搬回去：先全量预检（目标占位、源缺失）再动文件，避免撤一半。
  for (const toRel of item.relPaths) {
    const base = toRel.slice(toRel.lastIndexOf('/') + 1);
    const backRel = `${item.fromDir}/${base}`;
    const backAbs = deps.safeResolveInside(index.root, backRel);
    if (deps.fs.existsSync(backAbs)) {
      const error = `原位置已有同名文件，拒绝覆盖：${backRel}`;
      return { ok: false, status: 409, error };
    }
    const nowAbs = deps.safeResolveInside(index.root, toRel);
    if (!deps.fs.existsSync(nowAbs)) {
      const error = `归位后的文件不在了，没法撤销：${toRel}`;
      return { ok: false, status: 409, error };
    }
  }
  for (const toRel of item.relPaths) {
    const base = toRel.slice(toRel.lastIndexOf('/') + 1);
    const backRel = `${item.fromDir}/${base}`;
    const fromAbs = deps.safeResolveInside(index.root, toRel);
    const backAbs = deps.safeResolveInside(index.root, backRel);
    deps.fs.mkdirSync(deps.path.dirname(backAbs), { recursive: true });
    deps.fs.renameSync(fromAbs, backAbs);
  }
  // 归位时新建的目录空了就收掉（非空说明用户往里放了东西，留着）。
  try {
    const toAbs = deps.safeResolveInside(index.root, item.toDir);
    deps.fs.rmdirSync(toAbs);
  } catch { /* 非空/不存在都正常，不影响撤销结果 */ }
  return { ok: true };
}

function librelId(key, nowMs) {
  return `rel-${nowMs}-${String(key).slice(0, 8)}`;
}

function buildLibraryRelocate(deps) {
// @bridge-function handleConsoleLibraryRelocate:start
  async function handleConsoleLibraryRelocate(request) {
    const { req, url, sendJson } = request;
    const isRelocate = url.pathname === '/api/library/relocate';
    const isUndo = url.pathname === '/api/library/relocate/undo';
    if (!isRelocate && !isUndo) return false;
    // 会真的搬文件：只给管理端，智能体一律 403（和 trash / batch 一致）。
    if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
      sendJson({ ok: false, error: '未授权：归位是管理端操作' }, 403);
      return true;
    }
    if (req.method !== 'POST') {
      sendJson({ ok: false, error: '该接口只支持 POST' }, 405);
      return true;
    }
    let body = null;
    try { body = await request.readBody(); } catch (error) {
      sendJson({ ok: false, error: error?.message ?? '请求体非法' }, 400);
      return true;
    }
    let index = null;
    try { index = librelAssetIndex(deps); } catch (error) {
      sendJson({ ok: false, error: `扫描素材库失败：${error?.message ?? error}` }, 500);
      return true;
    }
    if (isUndo) {
      const state = librelLoadState(deps);
      const wantedId = String(body?.id ?? '').trim();
      const item = wantedId
        ? state.items.find((it) => it.id === wantedId)
        : [...state.items].reverse().find((it) => !it.undone);
      if (!item) { sendJson({ ok: false, error: wantedId ? `找不到这条归位记录：${wantedId}` : '没有可撤销的归位记录' }, 400); return true; }
      if (item.undone) { sendJson({ ok: false, error: '这条归位已经撤销过了' }, 409); return true; }
      const undone = librelDoUndo(deps, index, item);
      if (!undone.ok) { sendJson({ ok: false, error: undone.error }, undone.status || 409); return true; }
      item.undone = true;
      item.undoneAt = Date.now();
      librelSaveState(deps, state);
      deps.log(`素材归位已撤销：${item.title || item.key} → ${item.fromDir}`);
      sendJson({ ok: true, undone: true, key: item.key, title: item.title, fromDir: item.fromDir, toDir: item.toDir, files: item.relPaths.length });
      return true;
    }
    const key = String(body?.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: '缺少 key（要归位哪件素材）' }, 400); return true; }
    let plan = null;
    try { plan = librelPlan(deps, index, key); } catch (error) {
      sendJson({ ok: false, error: `归位计划失败：${error?.message ?? error}` }, 500);
      return true;
    }
    if (!plan.ok) { sendJson({ ok: false, error: plan.error }, plan.status || 400); return true; }
    const payload = {
      ok: true,
      dryRun: body?.dryRun === true,
      key,
      title: String(plan.asset.title || ''),
      boothId: String(plan.asset.boothId || ''),
      fromDir: plan.fromDir,
      toDir: plan.toDir,
      files: plan.relPaths.length,
      relPaths: plan.relPaths.slice(0, 20)
    };
    if (body?.dryRun === true) { sendJson(payload); return true; }
    let pairs = null;
    try { pairs = librelDoMove(deps, plan); } catch (error) {
      deps.log(`素材归位失败：${key}：${error?.message ?? error}`);
      sendJson({ ok: false, error: `归位失败（已回滚）：${error?.message ?? error}` }, 500);
      return true;
    }
    const nowMs = Date.now();
    const state = librelLoadState(deps);
    const item = {
      id: librelId(key, nowMs),
      key,
      title: String(plan.asset.title || ''),
      boothId: String(plan.asset.boothId || ''),
      fromDir: plan.fromDir,
      toDir: plan.toDir,
      relPaths: pairs.map((pair) => pair.toRel),
      at: nowMs,
      undone: false,
      undoneAt: 0
    };
    state.items.push(item);
    state.at = nowMs;
    librelSaveState(deps, state);
    deps.log(`素材归位：${item.title || key} 从 ${plan.fromDir} 移到 ${plan.toDir}（${pairs.length} 个文件）`);
    sendJson({ ...payload, dryRun: false, id: item.id });
    return true;
  }
// @bridge-function handleConsoleLibraryRelocate:end
  return { handleConsoleLibraryRelocate };
}
