// src/bridge/console/library-reconcile-routes.js — 已购库 ↔ 素材库对账 / 同步路由。
//
// 为什么单独拆文件：library-view.js 已经贴着 800 行规模闸（对账只是读几张表拼一份报告），
// 而且它要读 `state/booth-purchases.json`——已购库的台账格式属于 purchases 那边的契约，
// 放在一起容易让「素材页」和「已购页」互相长刺。对账规则本体在 src/library-reconcile.js（纯函数）。
//
// 两种模式：
//   1) GET /api/library/reconcile           —— 只读对账（老形状，一个字节都不写）
//   2) GET /api/library/reconcile?deep=1    —— 在老字段之外补分组展示字段 + 可执行 actions
// 写接口（全部 POST、agent 令牌 403、dryRun 严格布尔、dryRun:true 不写盘）：
//   POST /api/library/reconcile/sync      {dryRun, decisions?}
//   POST /api/library/reconcile/bind      {boothId, keys?}
//   POST /api/library/purchases/bind      （bind 的别名：前端走 reconcile，规格书写 purchases）
//   POST /api/library/reconcile/download  {boothId}
//   POST /api/library/reconcile/download-all  {dryRun?, limit?}   —— 对账里 16 件 missing 一键补下（串行，别并发打 BOOTH）
//   POST /api/library/reconcile/forget    {boothIds:[]}
//   POST /api/library/purchases/forget    （forget 的别名）

import { purchasesFromState, reconcilePurchasedAndLibrary, reconcileDeepPlan, reconcileIdOf } from '../../library-reconcile.js';
import { normalizeBindTable, setBind } from '../../library-binds.js';
import { pauseErrorMessage, readPause, searchPauseState } from '../../booth-pause.js';

const RECONCILE_PURCHASE_FILE = 'booth-purchases.json';
const RECONCILE_BINDS_FILE = 'booth-binds.json';

const READ_PATH = '/api/library/reconcile';
const SYNC_PATH = '/api/library/reconcile/sync';
const BIND_PATHS = ['/api/library/reconcile/bind', '/api/library/purchases/bind'];
const DOWNLOAD_PATH = '/api/library/reconcile/download';
const DOWNLOAD_ALL_PATH = '/api/library/reconcile/download-all';
const DOWNLOAD_ALL_LIMIT_DEFAULT = 10;
const DOWNLOAD_ALL_LIMIT_MAX = 20;
const FORGET_PATHS = ['/api/library/reconcile/forget', '/api/library/purchases/forget'];
const KNOWN_PATHS = [READ_PATH, SYNC_PATH, ...BIND_PATHS, DOWNLOAD_PATH, DOWNLOAD_ALL_PATH, ...FORGET_PATHS];

/**
 * dryRun 口径：sync 那边是严格布尔；批量补下还要兼容前端把 URLSearchParams 里的 "true"/"false"
 * 直接塞进 body 的情况（只认这两个词，别的字符串一律 400，不猜）。
 */
function parseDryRunFlag(value) {
  if (value === undefined) return { ok: true, value: false };
  if (value === true || value === 'true') return { ok: true, value: true };
  if (value === false || value === 'false') return { ok: true, value: false };
  return { ok: false, error: 'dryRun 只认 true 或 false（字符串 "true"/"false" 也行）' };
}

/** limit 缺省 10、上限 20：夹取而不是报错（用户填 0/99 都不该让整批打不开）。 */
function downloadAllLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: DOWNLOAD_ALL_LIMIT_DEFAULT };
  const num = Number(raw);
  if (!Number.isFinite(num)) return { ok: false, error: 'limit 必须是数字（默认 10，最多 20）' };
  return { ok: true, value: Math.max(1, Math.min(DOWNLOAD_ALL_LIMIT_MAX, Math.floor(num))) };
}

/** 批量补下前统一看一次全局暂停：暂停中一个号都不入队（入队后也要发请求，等于白建任务）。 */
async function pauseNow(deps) {
  const now = Date.now();
  const record = await readPause({ fs: deps.fs, stateDir: String(deps.STATE_DIR || ''), now });
  const state = searchPauseState(record, now);
  if (!state.paused) return null;
  return { text: pauseErrorMessage(record, now), retryAfterMs: Math.max(0, Number(state.remainingMs) || 0) };
}

function statePath(deps, file) {
  return deps.path.join(String(deps.STATE_DIR || ''), file);
}

function readJsonState(deps, file, fallback) {
  try {
    const text = deps.fs.readFileSync(statePath(deps, file), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** 读已购台账：文件不存在/坏 JSON 都当空表（对账页不能因为台账脏了就打不开）。 */
export function readPurchaseState(deps) {
  return readJsonState(deps, RECONCILE_PURCHASE_FILE, { version: 1, items: {} });
}

function readBindTable(deps) {
  return normalizeBindTable(readJsonState(deps, RECONCILE_BINDS_FILE, { entries: {} }));
}

function writeJsonState(deps, file, payload) {
  deps.atomicWriteJson(statePath(deps, file), payload);
}

/** 刷新时 BOOTH 返回 404 才会给条目打 gone 标记；没有标记就不出 forget 动作（宁缺勿假）。 */
function goneIdsOf(state) {
  const items = state && state.items && typeof state.items === 'object' ? state.items : {};
  const out = [];
  for (const key of Object.keys(items)) {
    const item = items[key];
    if (item && (item.gone === true || Number(item.deletedAt) > 0 || Number(item.goneAt) > 0)) out.push(key);
  }
  return out;
}

/** 本地有封面才给 URL（封面文件可能被清理/抓失败，直接给 URL 会让页面挂一堆 404）。 */
function purchaseThumb(deps, item) {
  const rel = String(item?.coverRel ?? '').trim();
  if (!rel) return '';
  try {
    const abs = deps.path.join(String(deps.STATE_DIR || ''), rel);
    if (!deps.fs.existsSync(abs)) return '';
  } catch {
    return '';
  }
  return `/api/library/purchases/cover?boothId=${item.boothId}&v=${Number(item.updatedAt) || 0}`;
}

function withThumb(deps, item) {
  return { ...item, thumb: purchaseThumb(deps, item) };
}

function isAgentRequest(request) {
  return Boolean(request.req.headers['x-agent-token'] || request.req.headers['x-agent-call']);
}

async function snapshotAssets(getAssets) {
  const snapshot = typeof getAssets === 'function' ? await getAssets() : { assets: [] };
  return Array.isArray(snapshot?.assets) ? snapshot.assets : [];
}

/** 把快照里的 key → 卡片建索引：写绑定时只认素材库真实存在的 key（不拼用户输入）。 */
function assetKeyIndex(assets) {
  const index = new Map();
  for (const asset of assets) {
    const key = String(asset?.key ?? '');
    if (key) index.set(key, asset);
  }
  return index;
}

async function buildPlan(deps, getAssets) {
  const state = readPurchaseState(deps);
  const assets = await snapshotAssets(getAssets);
  const plan = reconcileDeepPlan({
    purchases: purchasesFromState(state),
    assets,
    goneIds: goneIdsOf(state),
    now: Date.now()
  });
  return {
    ...plan,
    purchased: plan.purchased.map((item) => withThumb(deps, item)),
    missing: plan.missing.map((item) => withThumb(deps, item)),
    assets
  };
}

function writeBindings(deps, boothId, keys, title) {
  let table = readBindTable(deps);
  for (const key of keys) table = setBind(table, key, boothId, { title, source: 'reconcile' });
  writeJsonState(deps, RECONCILE_BINDS_FILE, table);
  return keys.length;
}

function removePurchases(deps, boothIds) {
  const state = readPurchaseState(deps);
  const items = state.items && typeof state.items === 'object' ? state.items : {};
  const removed = [];
  for (const boothId of boothIds) {
    if (!items[boothId]) continue;
    delete items[boothId];
    removed.push(boothId);
  }
  if (removed.length) {
    state.version = Number(state.version) || 1;
    state.updatedAt = Date.now();
    writeJsonState(deps, RECONCILE_PURCHASE_FILE, state);
  }
  return removed;
}

/** 前端回传的 decisions 可能是「动作对象」也可能只是 {id}，这里统一成 id。 */
function decisionIdOf(raw) {
  if (typeof raw === 'string') return raw.trim();
  if (!raw || typeof raw !== 'object') return '';
  const id = String(raw.id ?? '').trim();
  if (id) return id;
  const boothId = reconcileIdOf(raw.boothId);
  if (!boothId) return '';
  const type = String(raw.type ?? raw.action ?? '').trim();
  if (type === 'bind') return `bind:${boothId}`;
  if (type === 'download') return `download:${boothId}`;
  if (type === 'forget') return `forget:${boothId}`;
  return '';
}

async function applyAction(deps, plan, action) {
  if (action.type === 'bind') {
    const keys = Array.isArray(action.keys) ? action.keys : [];
    return { bound: writeBindings(deps, action.boothId, keys, action.title || '') };
  }
  if (action.type === 'download') {
    if (typeof deps.enqueueReconcileDownload !== 'function') {
      throw new Error('下载入队还没接线（重启桥接后再试）');
    }
    const result = await deps.enqueueReconcileDownload({ boothId: action.boothId });
    if (!result || result.ok !== true) throw new Error(result?.error || '入队失败');
    return { queued: Boolean(result.queued), already: Boolean(result.already), job: result.job || null };
  }
  if (action.type === 'forget') {
    const removed = removePurchases(deps, [action.boothId]);
    if (!removed.length) throw new Error('台账里已经没这件了');
    return { removed: removed[0] };
  }
  if (action.type === 'review') {
    throw new Error('这条要人工确认号对不对，不能自动执行');
  }
  throw new Error(`未知动作：${action.type}`);
}

async function handleRead(deps, request, getAssets) {
  const deep = String(request.url.searchParams.get('deep') || '') === '1';
  try {
    if (deep) {
      const plan = await buildPlan(deps, getAssets);
      request.sendJson({
        ok: true,
        stats: plan.stats,
        purchased: plan.purchased,
        missing: plan.missing,
        inLibrary: plan.inLibrary,
        extra: plan.extra,
        actions: plan.actions,
        decisions: plan.actions,
        summary: plan.summary,
        generatedAt: plan.generatedAt
      });
      return true;
    }
    const boothId = String(request.url.searchParams.get('boothId') || '').trim();
    const purchases = purchasesFromState(readPurchaseState(deps));
    const result = reconcilePurchasedAndLibrary({
      purchases,
      assets: await snapshotAssets(getAssets),
      boothId,
      now: Date.now()
    });
    request.sendJson({
      ok: true,
      ...result,
      purchased: result.purchased.map((item) => withThumb(deps, item)),
      missing: result.missing.map((item) => withThumb(deps, item))
    });
  } catch (error) {
    request.sendJson({ ok: false, error: `对账失败：${error?.message ?? error}` }, 500);
  }
  return true;
}

async function readJsonBody(request) {
  try {
    const body = await request.readBody();
    if (body == null) return { ok: true, body: {} };
    if (typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: '请求体得是 JSON 对象' };
    return { ok: true, body };
  } catch (error) {
    return { ok: false, error: `请求体读不了：${error?.message ?? error}` };
  }
}

async function handleSync(deps, request, getAssets, body) {
  // dryRun 必须是严格布尔：字符串 "false" 既不是 true 也不是 false，直接 400（不猜用户意思）。
  if (typeof body.dryRun !== 'boolean') {
    request.sendJson({ ok: false, error: 'dryRun 必须是严格的 true 或 false（字符串不算）' }, 400);
    return true;
  }
  const plan = await buildPlan(deps, getAssets);
  if (body.dryRun === true) {
    request.sendJson({
      ok: true,
      dryRun: true,
      stats: plan.stats,
      actions: plan.actions,
      decisions: plan.actions,
      summary: plan.summary,
      total: plan.actions.length
    });
    return true;
  }
  const wanted = (Array.isArray(body.decisions) ? body.decisions : [])
    .map((raw) => ({ raw, id: decisionIdOf(raw) }))
    .filter((row) => row.id);
  const byId = new Map(plan.actions.map((action) => [action.id, action]));
  const applied = [];
  const skipped = [];
  for (const row of wanted) {
    const planned = byId.get(row.id) || plan.actions.find((item) => item.id === row.id);
    if (!planned) {
      skipped.push({ id: row.id, reason: '这次对账里没有这个动作（可能已经处理过）' });
      continue;
    }
    // 前端可能只勾了同号里的某几件：回传的 keys 覆盖候选全集（但只认素材库里真实存在的 key）。
    const picked = row.raw && typeof row.raw === 'object' && Array.isArray(row.raw.keys)
      ? row.raw.keys.map((value) => String(value ?? '').trim()).filter(Boolean)
      : null;
    const action = picked && picked.length ? { ...planned, keys: picked } : planned;
    try {
      applied.push({ id: action.id, type: action.type, boothId: action.boothId, result: await applyAction(deps, plan, action) });
    } catch (error) {
      skipped.push({ id: action.id, type: action.type, boothId: action.boothId, error: String(error?.message ?? error) });
    }
  }
  request.sendJson({ ok: true, dryRun: false, applied, skipped, total: wanted.length });
  return true;
}

async function handleBind(deps, request, getAssets, body) {
  const boothId = reconcileIdOf(body.boothId);
  if (!boothId) {
    request.sendJson({ ok: false, error: 'boothId 必须是 5~9 位数字' }, 400);
    return true;
  }
  const assets = await snapshotAssets(getAssets);
  const index = assetKeyIndex(assets);
  const wanted = Array.isArray(body.keys) ? body.keys.map((value) => String(value ?? '').trim()).filter(Boolean) : [];
  let keys = [];
  if (wanted.length) {
    const skipped = [];
    for (const key of wanted) {
      if (index.has(key)) keys.push(key);
      else skipped.push({ key, reason: '素材库里没有这个 key' });
    }
    const bound = keys.length ? writeBindings(deps, boothId, keys, '') : 0;
    request.sendJson({ ok: true, boothId, bound, keys, skipped });
    return true;
  }
  // 不给 keys：把这个号在库里所有候选都绑上（前端「绑定另一件」不传 keys 时的口径）。
  const candidate = assets
    .filter((asset) => reconcileIdOf(asset?.boothId) === boothId)
    .map((asset) => String(asset?.key ?? ''))
    .filter(Boolean);
  const bound = candidate.length ? writeBindings(deps, boothId, candidate, '') : 0;
  request.sendJson({ ok: true, boothId, bound, keys: candidate, skipped: [] });
  return true;
}

async function handleDownload(deps, request, body) {
  const boothId = reconcileIdOf(body.boothId);
  if (!boothId) {
    request.sendJson({ ok: false, error: 'boothId 必须是 5~9 位数字' }, 400);
    return true;
  }
  if (typeof deps.enqueueReconcileDownload !== 'function') {
    request.sendJson({ ok: false, error: '下载入队还没接线（重启桥接后再试）' }, 503);
    return true;
  }
  const result = await deps.enqueueReconcileDownload({ boothId });
  if (!result || result.ok !== true) {
    request.sendJson({ ok: false, error: result?.error || '入队失败' }, 502);
    return true;
  }
  request.sendJson({ ok: true, boothId, queued: Boolean(result.queued), already: Boolean(result.already), job: result.job || null });
  return true;
}

async function handleDownloadAll(deps, request, getAssets, body) {
  if (typeof deps.enqueueReconcileDownload !== 'function') {
    request.sendJson({ ok: false, error: '下载入队还没接线（重启桥接后再试）' }, 503);
    return true;
  }
  const dryRun = parseDryRunFlag(body.dryRun);
  if (!dryRun.ok) {
    request.sendJson({ ok: false, error: dryRun.error }, 400);
    return true;
  }
  const limit = downloadAllLimit(body.limit);
  if (!limit.ok) {
    request.sendJson({ ok: false, error: limit.error }, 400);
    return true;
  }
  const paused = await pauseNow(deps);
  if (paused) {
    request.sendJson({ ok: false, paused: true, error: paused.text, retryAfterMs: paused.retryAfterMs }, 409);
    return true;
  }
  const plan = await buildPlan(deps, getAssets);
  const downloadable = plan.actions.filter((action) => action.type === 'download' && reconcileIdOf(action.boothId));
  const picked = downloadable.slice(0, limit.value);
  const candidates = picked.map((action) => ({ boothId: action.boothId, title: String(action.title || ''), reason: String(action.reason || '') }));
  if (dryRun.value) {
    request.sendJson({ ok: true, dryRun: true, queued: [], skipped: [], candidates, total: downloadable.length });
    return true;
  }
  // 串行入队：同一个下载器、同一条 BOOTH 限速线，批量并发只会换来 429。
  const queued = [];
  const skipped = [];
  for (const candidate of candidates) {
    try {
      const result = await deps.enqueueReconcileDownload({ boothId: candidate.boothId });
      if (!result || result.ok !== true) {
        skipped.push({ boothId: candidate.boothId, reason: String(result?.error || '入队失败') });
        continue;
      }
      if (result.queued) { queued.push(candidate.boothId); continue; }
      const stateName = String(result.job?.state || '');
      const reason = stateName === 'done'
        ? '已经下过（台账里是 done）'
        : stateName === 'downloading' ? '正在下载，跳过' : '已经在下载队列里，跳过';
      skipped.push({ boothId: candidate.boothId, reason });
    } catch (error) {
      skipped.push({ boothId: candidate.boothId, reason: String(error?.message ?? error) });
    }
  }
  request.sendJson({ ok: true, dryRun: false, queued, skipped, candidates, total: downloadable.length });
  return true;
}

function handleForget(deps, request, body) {
  const raw = Array.isArray(body.boothIds) ? body.boothIds : null;
  if (!raw) {
    request.sendJson({ ok: false, error: 'boothIds 必须是数组' }, 400);
    return true;
  }
  const ids = [];
  for (const value of raw) {
    const boothId = reconcileIdOf(value);
    if (!boothId) {
      request.sendJson({ ok: false, error: `boothIds 里有个不是 BOOTH 号：${String(value).slice(0, 20)}` }, 400);
      return true;
    }
    if (!ids.includes(boothId)) ids.push(boothId);
  }
  const removed = removePurchases(deps, ids);
  request.sendJson({ ok: true, removed: removed.length, boothIds: ids, removedIds: removed });
  return true;
}

/**
 * GET /api/library/reconcile[?deep=1&boothId=]
 * getAssets 由 library-view 提供（含合并/改名/别名/标签的最终视图），这里不自己扫盘，
 * 否则「页面上看到的卡片」和「对账算的卡片」会各算一套、数字对不上。
 */
export async function handleReconcileRoutes(request, deps, getAssets) {
  const path = String(request.url?.pathname || '');
  if (!KNOWN_PATHS.includes(path)) return false;
  if (isAgentRequest(request)) {
    request.sendJson({ ok: false, error: path === READ_PATH ? '已购对账只允许管理端操作' : '同步接口只允许管理端操作' }, 403);
    return true;
  }
  const method = String(request.req.method || '').toUpperCase();
  if (path === READ_PATH) {
    if (method !== 'GET') {
      request.sendJson({ ok: false, error: '该接口只支持 GET' }, 405);
      return true;
    }
    return handleRead(deps, request, getAssets);
  }
  if (method !== 'POST') {
    request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405);
    return true;
  }
  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    request.sendJson({ ok: false, error: parsed.error }, 400);
    return true;
  }
  const body = parsed.body;
  try {
    if (path === SYNC_PATH) return await handleSync(deps, request, getAssets, body);
    if (BIND_PATHS.includes(path)) return await handleBind(deps, request, getAssets, body);
    if (path === DOWNLOAD_PATH) return await handleDownload(deps, request, body);
    if (path === DOWNLOAD_ALL_PATH) return await handleDownloadAll(deps, request, getAssets, body);
    if (FORGET_PATHS.includes(path)) return handleForget(deps, request, body);
  } catch (error) {
    request.sendJson({ ok: false, error: `同步失败：${error?.message ?? error}` }, 500);
    return true;
  }
  return false;
}
