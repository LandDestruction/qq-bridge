// 素材库批量操作（多选后一次做同一件事）：绑定 BOOTH 号 / 合并成一组 / 移入回收站。
//
// 为什么要有这个模块：素材库多选以后，用户最常做的就是「这批都绑同一个号」「这几件是同号合并」
// 「这批不要了丢回收站」；以前只能一件一件点，17 件素材就要点 17 次。
//
// 语义（和单件接口一致，只加「一次多件」）：
// - keys 逐个执行、**失败不中断**：某件找不到 / 被占用只进 failed，不会把整批废掉；
// - 每一步都复用既有规则的唯一入口（merge 走 src/library-merge.js 的 setMerge、
//   trash 走 library-trash.js 的 libtrTrashKeys、bind 走 src/library-binds.js 的 setBind），
//   本文件不复制任何落盘/搬移逻辑；
// - 批量入口本身就是确认动作（trash 额外接受 params.confirm，但不强制——前端弹窗已确认过）。
//
// 约束：本文件是 manifest 模块，被 scripts/bridge-source.mjs 用 vm.runInContext 裸执行，
// **不能 import**；纯规则与文件系统全从 deps 注入，构造期不读 deps。
// 顶部不要有和 src/bridge.js 同名的 const/let（VM 里共用一个全局词法作用域）。

const LIBBATCH_MAX_KEYS = 200;
const LIBBATCH_BOOTH_RE = /^\d{5,9}$/;
const LIBBATCH_MERGE_FILE = 'booth-merges.json';
const LIBBATCH_BINDS_FILE = 'booth-binds.json';
// 支持的 action：alias/tags 不做——见 handler 里「不支持」的说明。
const LIBBATCH_ACTIONS = ['bind', 'merge', 'trash'];

export function createLibraryBatch(deps) {
  let impl = null;
  const implOf = () => impl || (impl = buildLibraryBatch(deps));
  return { handleConsoleLibraryBatch: (request) => implOf().handleConsoleLibraryBatch(request) };
}

// ── 盘面索引：批量 bind 要确认「这个 key 真是库里一件素材」 ───────────────────
function libbatchAssetIndex(deps) {
  const root = String(typeof deps.fileArchiveRootDir === 'function' ? deps.fileArchiveRootDir() : deps.fileArchiveRootDir || '');
  const scan = deps.scanLibraryTree({ fs: deps.fs, rootDir: root });
  const grouped = deps.assetsFromFiles(scan.files || []);
  const byKey = new Map();
  for (const asset of grouped.assets || []) {
    const key = String(asset?.key || '');
    if (key) byKey.set(key, asset);
  }
  return { root, byKey };
}

// ── 绑定表 / 合并表的读写（和 console 层单件接口同一份文件、同一套 normalize） ──
function libbatchStateFile(deps, name) {
  return deps.path.join(String(deps.STATE_DIR), name);
}

function libbatchReadBinds(deps) {
  const pure = deps.libraryBindsPure || {};
  try { return pure.normalizeBindTable(JSON.parse(deps.fs.readFileSync(libbatchStateFile(deps, LIBBATCH_BINDS_FILE), 'utf8'))); }
  catch { return pure.normalizeBindTable(null); }
}

function libbatchWriteBinds(deps, table) {
  deps.atomicWriteJson(libbatchStateFile(deps, LIBBATCH_BINDS_FILE), (deps.libraryBindsPure || {}).normalizeBindTable(table));
}

function libbatchReadMerge(deps) {
  const pure = deps.libraryMergePure || {};
  try { return pure.normalizeMergeTable(JSON.parse(deps.fs.readFileSync(libbatchStateFile(deps, LIBBATCH_MERGE_FILE), 'utf8'))); }
  catch { return pure.normalizeMergeTable(null); }
}

function libbatchWriteMerge(deps, table) {
  deps.atomicWriteJson(libbatchStateFile(deps, LIBBATCH_MERGE_FILE), (deps.libraryMergePure || {}).normalizeMergeTable(table));
}

// ── 三个 action 的执行体：都返回 {changed, skipped, failed, results} ─────────
function libbatchRunBind(deps, keys, boothId, index) {
  const pure = deps.libraryBindsPure || {};
  let table = libbatchReadBinds(deps);
  const skipped = [];
  const failed = [];
  const results = [];
  let changed = 0;
  for (const key of keys) {
    const asset = index.byKey.get(key);
    if (!asset) {
      failed.push({ key, error: '库里找不到这件素材（可能刚被移动/改名）' });
      results.push({ key, status: 'failed' });
      continue;
    }
    const bound = pure.bindOf(table, key);
    if (bound && String(bound.boothId) === boothId) {
      skipped.push({ key, reason: '已经绑过这个号，跳过' });
      results.push({ key, status: 'skipped' });
      continue;
    }
    table = pure.setBind(table, key, boothId, { title: String(asset.title || ''), source: 'batch' });
    changed += 1;
    results.push({ key, status: 'bound', boothId, replaced: bound ? String(bound.boothId) : '' });
  }
  // 只有真改过才写盘：全 skipped 时别把文件 mtime 也刷一遍。
  if (changed > 0) libbatchWriteBinds(deps, table);
  deps.log(`素材库批量绑定：${changed} 件绑到 BOOTH ${boothId}（跳过 ${skipped.length}、失败 ${failed.length}）`);
  return { changed, skipped, failed, results };
}

function libbatchRunMerge(deps, keys, boothId, index) {
  const pure = deps.libraryMergePure || {};
  const skipped = [];
  const failed = [];
  const results = [];
  // 先挑出「库里确实有」的 key：合并是整组动作，缺一件就整组不动，不能把不存在的新 key 写进组。
  const merged = [];
  for (const key of keys) {
    if (!index.byKey.get(key)) {
      failed.push({ key, error: '库里找不到这件素材（可能刚被移动/改名）' });
      results.push({ key, status: 'failed' });
      continue;
    }
    merged.push(key);
  }
  if (merged.length < 2) {
    return { changed: 0, skipped, failed, results, error: '至少选两条素材才能合并（合并是可撤销的展示分组）' };
  }
  // 合并组本身的上限是 50（src/library-merge.js 的 MERGE_KEYS_MAX）：超了会被静默截断，
  // 与其让用户以为全进组了，不如明说分批。
  if (merged.length > 50) {
    return { changed: 0, skipped, failed, results, error: '合并一次最多 50 件，请分批选' };
  }
  let table = libbatchReadMerge(deps);
  try {
    table = pure.setMerge(table, { boothId, keys: merged, note: '批量操作合并' });
    libbatchWriteMerge(deps, table);
  } catch (error) {
    // setMerge 抛错（号非法/条数不够）属于整组失败：把这几个 key 都标 failed，让前端知道哪组没成。
    for (const key of merged) {
      failed.push({ key, error: error?.message ?? String(error) });
      results.push({ key, status: 'failed' });
    }
    return { changed: 0, skipped, failed, results };
  }
  const mergeId = `m-${boothId}`;
  for (const key of merged) results.push({ key, status: 'merged', boothId, mergeId });
  deps.log(`素材库批量合并：${merged.length} 件并入 ${mergeId}`);
  return { changed: merged.length, skipped, failed, results };
}

function libbatchRunTrash(deps, keys) {
  const result = deps.libtrTrashKeys(deps, keys);
  if (!result || result.ok === false) {
    return { changed: 0, skipped: [], failed: [], results: [], error: result?.error || '回收站接口不可用' };
  }
  const results = [];
  for (const item of result.moved) results.push({ key: item.key, status: 'trashed', id: item.id });
  for (const item of result.skipped) results.push({ key: item.key, status: 'skipped' });
  for (const item of result.failed) results.push({ key: item.key, status: 'failed' });
  return { changed: result.moved.length, skipped: result.skipped, failed: result.failed, results };
}

// ── 参数校验（都在进循环之前做完：一批 200 件不该跑到第 100 件才发现号非法） ──
function libbatchParseKeys(body) {
  const raw = Array.isArray(body?.keys) ? body.keys : null;
  if (!raw || !raw.length) return { error: '请先选素材（keys 不能为空）' };
  const keys = [];
  const seen = new Set();
  for (const value of raw) {
    const key = String(value ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    if (keys.length > LIBBATCH_MAX_KEYS) break;
  }
  if (!keys.length) return { error: '请先选素材（keys 不能为空）' };
  if (keys.length > LIBBATCH_MAX_KEYS) return { error: `一次最多处理 ${LIBBATCH_MAX_KEYS} 件，请分批选` };
  return { keys };
}

function buildLibraryBatch(deps) {
// @bridge-function handleConsoleLibraryBatch:start
  async function handleConsoleLibraryBatch(request) {
    const { req, url, sendJson } = request;
    if (url.pathname !== '/api/library/batch') return false;
    // 批量操作会真的改台账/搬文件：只给管理端，智能体一律 403。
    if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
      sendJson({ ok: false, error: '未授权：批量操作是管理端操作' }, 403);
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
    const action = String(body?.action ?? '').trim();
    if (!action) { sendJson({ ok: false, error: '缺少 action（bind / merge / trash）' }, 400); return true; }
    if (action === 'alias') {
      // 别名目前是「识别规则表」（显示名=别名|别名），没有按素材 key 的别名机制：
      // 硬做一个只会和规则表两套真相，所以如实说不支持，让用户去识别规则表页面维护。
      sendJson({ ok: false, error: '不支持批量设别名：素材别名是「识别规则表」（显示名=别名|别名），没有按素材生效的别名机制' }, 400);
      return true;
    }
    if (!LIBBATCH_ACTIONS.includes(action)) {
      sendJson({ ok: false, error: `不支持的批量操作：${action}（只支持 bind / merge / trash）` }, 400);
      return true;
    }
    const parsed = libbatchParseKeys(body);
    if (parsed.error) { sendJson({ ok: false, error: parsed.error }, 400); return true; }
    const keys = parsed.keys;
    // 契约兼容：前端历史上发过顶层 boothId，现在统一发 params:{boothId}（batch 对话框），
    // 两种都收——顶层优先、params 兜底，params.id 再兜一层（别让一次前端改形状就把功能点死）。
    const boothId = String(body?.boothId ?? body?.params?.boothId ?? body?.params?.id ?? '').trim();
    if ((action === 'bind' || action === 'merge') && !LIBBATCH_BOOTH_RE.test(boothId)) {
      sendJson({ ok: false, error: `参数 boothId 不合法：${boothId || '(空)'}（应为 5~9 位数字的 BOOTH 号）` }, 400);
      return true;
    }
    let index = null;
    if (action === 'bind' || action === 'merge') {
      try { index = libbatchAssetIndex(deps); } catch (error) {
        sendJson({ ok: false, error: `扫描素材库失败：${error?.message ?? error}` }, 500);
        return true;
      }
    }
    let out = null;
    try {
      if (action === 'bind') out = libbatchRunBind(deps, keys, boothId, index);
      else if (action === 'merge') out = libbatchRunMerge(deps, keys, boothId, index);
      else out = libbatchRunTrash(deps, keys);
    } catch (error) {
      // 兜底：任何 action 抛出未预料错误都转成 500，不把半截响应当成功。
      deps.log(`素材库批量操作失败（${action}）：${error?.message ?? error}`);
      sendJson({ ok: false, error: `批量操作失败：${error?.message ?? error}` }, 500);
      return true;
    }
    if (out.error) { sendJson({ ok: false, error: out.error }, 400); return true; }
    sendJson({
      ok: true,
      action,
      requested: keys.length,
      changed: out.changed,
      skipped: out.skipped,
      failed: out.failed,
      results: out.results
    });
    return true;

    // 路由展开要求 handler 以 return false 收尾（实际路由只会在 /api/library/batch 上进来）。
    return false;
  }
// @bridge-function handleConsoleLibraryBatch:end

  return { handleConsoleLibraryBatch };
}
