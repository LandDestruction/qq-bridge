// 认号可信度视图：给素材卡补 boothStatus / displayTitle / bindSuggestions，并提供两个只读/确认接口。
//
// 为什么单拆一个模块：library-view.js 已经贴着 800 行规模闸，而这块要读三份台账、还要算标题相似度。
// 这里只依赖 deps（不 import 桥接运行时），照 library-cover.js / library-assets-query.js 的 ESM 模式，
// 由 library-view.js 直接 import。
//
// 规则（2026-10-30 用户反馈「封面和商品名都没对上」后定）：
// - verified = 当前号在已购台账里，或人工绑定表里（用户手点过）——只有 verified 才允许拿去取封面/显示商品名；
// - candidate = 没 verified 但有候选（标题相似 / 素材身上已有号在台账里），显示「? 候选标题」；
// - none = 连候选都没有，显示洗过的文件名，等人工填号。
import {
  boothIdSourceOf,
  boothStatusOf,
  cleanDisplayTitle,
  dirBoothIdOf,
  displayTitleOf,
  resolveBoothId,
  suggestBindings
} from '../../library-bind-match.js';
import { bindOf, normalizeBindTable, setBind } from '../../library-binds.js';
// 解压码自动识别：认号成功时顺手把文件名/标题里的解压码记进密码本（纯规则，零依赖）。
import { pickBestExtractCode } from '../../library-extract-code.js';
import { cloudCardsFromPurchases, purchasesFromState, trashCardsFromState } from '../../library-cover-source.js';

const PURCHASES_FILE = 'booth-purchases.json';
const BINDS_FILE = 'booth-binds.json';
const TRASH_FILE = 'booth-trash.json';
const PURCHASE_COVERS_DIR = 'booth-purchase-covers';
const SUGGEST_LIST_DEFAULT = 50;
const SUGGEST_LIST_MAX = 500;

function readStateJson(deps, fileName) {
  const dir = String(deps?.STATE_DIR ?? '');
  if (!dir) return null;
  try {
    const text = deps.fs.readFileSync(deps.path.join(dir, fileName), 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
}

/**
 * 台账封面地址：本地已缓存就回本站代理地址，否则用台账里的远程图（只认 http）。
 * 为什么在视图层拼：认号核准后必须立刻能显示正确封面，不能等下一轮补封面。
 * @param {object} deps
 * @param {{boothId:string,coverUrl?:string,updatedAt?:number}} [purchase]
 * @returns {string}
 */
function purchaseCoverUrl(deps, purchase) {
  const boothId = String(purchase?.boothId ?? '').trim();
  if (!/^\d{5,9}$/.test(boothId)) return '';
  try {
    const file = deps.path.join(String(deps.STATE_DIR ?? ''), PURCHASE_COVERS_DIR, `${boothId}.jpg`);
    if (String(deps.STATE_DIR ?? '') && deps.fs.existsSync(file)) {
      return `/api/library/purchases/cover?boothId=${boothId}&v=${Number(purchase?.updatedAt) || 0}`;
    }
  } catch {
    // 读不到本地封面就退回远程地址，不影响认号本身。
  }
  const remote = String(purchase?.coverUrl ?? '');
  return /^https?:\/\//i.test(remote) ? remote : '';
}

/** 已购台账（含 title/shop/coverUrl），坏文件当空台账。 */
function purchaseListOf(deps) {
  return purchasesFromState(readStateJson(deps, PURCHASES_FILE));
}

/** 人工绑定表：读不到就当空表（和素材视图的 withBinds 同一口径）。 */
function bindTableOf(deps) {
  return normalizeBindTable(readStateJson(deps, BINDS_FILE));
}

function writeBindTable(deps, table) {
  const dir = String(deps?.STATE_DIR ?? '');
  if (!dir) throw new Error('绑定表不可写（STATE_DIR 未配置）');
  deps.atomicWriteJson(deps.path.join(dir, BINDS_FILE), table);
}

/** verified 号集合：已购台账 ∪ 人工绑定表。 */
function verifiedIdSetOf(purchases, bindTable) {
  const ids = new Set();
  for (const item of purchases) ids.add(String(item.boothId));
  for (const entry of Object.values(bindTable?.entries ?? {})) ids.add(String(entry?.boothId ?? ''));
  ids.delete('');
  return ids;
}

/**
 * 给最终素材视图补认号状态（不改入参；缓存安全）。
 * @returns {{assets:Array, bindStats:{verified:number,candidate:number,none:number}}}
 */
export function annotateBindStatus(deps, data) {
  const assets = Array.isArray(data?.assets) ? data.assets : [];
  if (!assets.length) return { ...data, bindStats: { verified: 0, candidate: 0, none: 0 } };
  const purchases = purchaseListOf(deps);
  const purchaseById = new Map(purchases.map((item) => [String(item.boothId), item]));
  const bindTable = bindTableOf(deps);
  const verifiedIds = verifiedIdSetOf(purchases, bindTable);
  const stats = { verified: 0, candidate: 0, none: 0 };
  const next = assets.map((asset) => {
    const key = String(asset?.key ?? '');
    const bindEntry = bindOf(bindTable, key);
    const dirBoothId = dirBoothIdOf(asset);
    // 号从哪来统一由 resolveBoothId 决定：目录号命中台账 > 人工绑定 > 素材自带号（名字前缀只是下载 id）。
    const resolved = resolveBoothId(asset, verifiedIds, bindEntry?.boothId ?? '');
    const boothId = resolved.boothId || String(asset?.boothId ?? '').trim();
    const current = {
      ...asset,
      boothId,
      boothIdSource: resolved.source,
      // download-id 要单独标出来：它不是商品号，前端要提示「这是文件 id，待人工确认」。
      boothIdKind: resolved.source === 'download-id' ? 'download-id' : 'item-id',
      dirBoothId
    };
    const suggestions = resolved.verified ? [] : suggestBindings(current, purchases, { limit: 2 });
    const status = boothStatusOf(current, verifiedIds, suggestions);
    stats[status] += 1;
    const purchase = purchaseById.get(boothId) || null;
    const verifiedTitle = String(purchase?.title ?? '') || String(bindEntry?.title ?? '') || '';
    // 核准后立刻给对封面：有本地已购封面走本站代理，否则用台账远程图（没有就留空，别显示猜的图）。
    const coverUrl = (status === 'verified' && !asset?.thumbRel)
      ? (purchaseCoverUrl(deps, purchase) || String(asset?.coverUrl ?? ''))
      : asset?.coverUrl;
    return {
      ...current,
      coverUrl,
      boothStatus: status,
      boothVerified: status === 'verified',
      displayTitle: displayTitleOf(current, { status, verifiedTitle, suggestion: suggestions[0] || null }),
      bindSuggestions: status === 'verified' ? [] : suggestions
    };
  });
  return { ...data, assets: next, bindStats: stats };
}

/** cloud 视图条数（已购台账里「库里还没有同号文件」的件数），与 view=cloud 的 total 同源。 */
export function countCloudCards(deps, assets) {
  const purchases = purchaseListOf(deps);
  const libraryBoothIds = (Array.isArray(assets) ? assets : [])
    .map((asset) => String(asset?.boothId ?? '').trim())
    .filter(Boolean);
  return cloudCardsFromPurchases(purchases, { libraryBoothIds }).length;
}

/** 回收站条数，与 view=trash 的 total 同源。 */
export function countTrashCards(deps) {
  return trashCardsFromState(readStateJson(deps, TRASH_FILE)).length;
}

/** 服务端权威计数：每个 view= 的 total 都能在这里找到同名口径。 */
/**
 * 「待确认认号」的唯一判据：candidate 且有候选建议。
 * 与 `view=suggested` 共用，避免服务端 counts 和前端列表各算一套（真机出现过 0 vs 16）。
 */
export function hasSuggestedBind(asset) {
  if (asset?.boothStatus === 'candidate') return Array.isArray(asset?.bindSuggestions) && asset.bindSuggestions.length > 0;
  // 没有认号注释的卡（老调用方/单测）退回旧的批量建议字段，保持向后兼容。
  if (asset?.boothStatus == null) return Boolean(asset?.suggestion);
  return false;
}

export function countAssetViews({ assets, bindStats, annotationStats, cloud = 0, trash = 0 }) {
  const list = Array.isArray(assets) ? assets : [];
  const all = list.length;
  const withBooth = Number(bindStats?.verified) || 0;
  const withCover = list.filter((asset) => Boolean(asset?.thumbRel) || Boolean(asset?.coverUrl)).length;
  // 认号口径：candidate 有候选才叫「待确认」，没候选的 candidate 是「有猜测但算不出相似度」，
  // 前端两侧导航都按 suggested 出数字，所以这里必须和 view=suggested 用同一个谓词。
  const candidate = list.filter((asset) => asset?.boothStatus === 'candidate').length;
  const suggested = list.filter((asset) => hasSuggestedBind(asset)).length;
  return {
    all,
    withBooth,
    noBooth: Math.max(0, all - withBooth),
    withCover,
    noCover: Math.max(0, all - withCover),
    verified: withBooth,
    candidate,
    suggested,
    favorite: Number(annotationStats?.favorites) || 0,
    cloud: Number(cloud) || 0,
    trash: Number(trash) || 0
  };
}

/**
 * GET /api/library/bind-suggestions?limit=&minScore=  → 未 verified 的件 + 各自 top 候选（全库摘要，不是分页素材）。
 * POST /api/library/bind-suggestion/accept {key,boothId} → 写进现有绑定表（不新建表）。
 * @returns {boolean|Promise<boolean>} 命中本路由返回 true
 */
export function handleBindSuggestionRoutes(request, deps, getAssets, invalidate) {
  const path = String(request?.url?.pathname ?? '');
  const isList = path === '/api/library/bind-suggestions';
  const isAccept = path === '/api/library/bind-suggestion/accept';
  if (!isList && !isAccept) return false;
  return run(request, deps, getAssets, invalidate, { isList, isAccept });
}

async function run(request, deps, getAssets, invalidate, { isList, isAccept }) {
  const { req, url, sendJson } = request;
  if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
    sendJson({ ok: false, error: '认号建议只允许管理端操作' }, 403);
    return true;
  }
  let snap = null;
  try {
    snap = await getAssets();
  } catch (error) {
    sendJson({ ok: false, error: `扫描素材库失败：${error?.message ?? error}` }, 500);
    return true;
  }
  const assets = Array.isArray(snap?.assets) ? snap.assets : [];

  if (isList) {
    if (req.method !== 'GET') { sendJson({ ok: false, error: '只支持 GET' }, 405); return true; }
    const limitRaw = Number(url.searchParams?.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(SUGGEST_LIST_MAX, Math.floor(limitRaw)) : SUGGEST_LIST_DEFAULT;
    const minScoreRaw = Number(url.searchParams?.get('minScore'));
    const minScore = Number.isFinite(minScoreRaw) && minScoreRaw > 0 ? Math.min(1, minScoreRaw) : undefined;
    const items = [];
    for (const asset of assets) {
      if (asset?.boothStatus === 'verified') continue;
      const list = minScore === undefined
        ? asset?.bindSuggestions || []
        : (asset?.bindSuggestions || []).filter((item) => Number(item?.score) >= minScore);
      if (!list.length) continue;
      items.push({
        key: String(asset.key ?? ''),
        title: String(asset.displayTitle ?? asset.title ?? ''),
        dir: String(asset.dir ?? ''),
        boothId: String(asset.boothId ?? ''),
        status: String(asset.boothStatus ?? 'none'),
        top: list[0],
        suggestions: list
      });
    }
    sendJson({
      ok: true,
      total: items.length,
      items: items.slice(0, limit),
      limit,
      minScore: minScore ?? 0,
      stats: snap?.bindStats || { verified: 0, candidate: 0, none: 0 }
    });
    return true;
  }

  if (req.method !== 'POST') { sendJson({ ok: false, error: '只支持 POST' }, 405); return true; }
  if (request.consoleRole === 'guest') { sendJson({ ok: false, error: '访客只能查看，不能确认认号' }, 403); return true; }
  let body = null;
  try { body = await request.readBody(); } catch (error) { sendJson({ ok: false, error: error?.message ?? '请求体非法' }, 400); return true; }
  const key = String(body?.key ?? '').trim();
  const boothId = String(body?.boothId ?? '').trim();
  if (!key) { sendJson({ ok: false, error: '缺少 key（素材的 contentKey）' }, 400); return true; }
  if (!/^\d{5,9}$/.test(boothId)) { sendJson({ ok: false, error: 'BOOTH 号必须是 5~9 位数字' }, 400); return true; }
  const card = assets.find((asset) => String(asset?.key) === key) || null;
  if (!card) { sendJson({ ok: false, error: '没有这件素材（刷新一下素材卡列表再试）' }, 404); return true; }
  const purchase = purchaseListOf(deps).find((item) => String(item.boothId) === boothId) || null;
  const title = String(purchase?.title ?? card.displayTitle ?? card.title ?? '').slice(0, 200);
  try {
    const next = setBind(bindTableOf(deps), key, boothId, { title, source: 'manual', now: Date.now() });
    writeBindTable(deps, next);
    if (typeof invalidate === 'function') invalidate();
    deps.log(`素材库：确认认号 ${key} → BOOTH ${boothId}（${title || '无标题'}）`);
    // 认号时顺手识别名词里的解压码：记进密码本（codeSource:'auto'），手填的那条永远优先。
    // 识别失败只记一行日志，绝不影响认号本身。
    try {
      const picked = pickBestExtractCode({
        fileName: String(card.mainName || ''),
        title: String(title || ''),
        dir: String(card.dir || '')
      });
      if (picked && deps.libraryPasswords && typeof deps.libraryPasswords.rememberAutoPassword === 'function') {
        deps.libraryPasswords.rememberAutoPassword({ key, boothId, password: picked.code, title, source: '认号时识别' });
      }
    } catch (error) {
      deps.log(`素材库：认号时识别解压码失败（忽略）：${error?.message ?? error}`);
    }
    sendJson({ ok: true, key, boothId, title, boothStatus: 'verified' });
  } catch (error) {
    sendJson({ ok: false, error: `保存认号失败：${error?.message ?? error}` }, 500);
  }
  return true;
}

/** 给日志/接口用的一句话（别在别处重复拼）。 */
export function describeBindStats(stats) {
  const verified = Number(stats?.verified) || 0;
  const candidate = Number(stats?.candidate) || 0;
  const none = Number(stats?.none) || 0;
  return `已核准 ${verified}、待确认 ${candidate}、无号 ${none}`;
}

export { cleanDisplayTitle };
