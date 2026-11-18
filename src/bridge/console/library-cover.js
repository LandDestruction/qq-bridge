// src/bridge/console/library-cover.js — 素材库 v2 的封面链路（文档 §4）。
//
// 用户抱怨「补封面不好用」：以前的补封面只有一条路——去 BOOTH 商品页抓 og:image，
// 又要限速又要防封。其实封面有五个来源，越靠前越快越稳：本地缩略图 → 已购台账
// （清单页同步下来的封面地址，本地已缓存时零网络）→ BOOTH 缓存 → 压缩包内 preview
// → 才轮到商品页抓取。所以这里做两件事：
//   1) GET /api/library/cover?key=… 按顺序解析，直接吐图片字节，并用 X-Cover-Source
//      告诉前端这张图是哪一级来的（牌面可观测，出问题能一眼看出卡在哪）。
//   2) annotateCoverState() 给每张卡补 coverSource / coverReady，前端据此显示占位
//      而不是一律说「无预览」。
//
// 边界：这张图是只读资源，访客也能看（相当于看缩略图）；但智能体令牌仍然 403——
// 与素材库其它接口一致，别让 agent 顺着 URL 把整库封面抓走。

import {
  purchasesFromState, cloudCardsFromPurchases, trashCardsFromState, pickRemoteCards, purchaseBoothIdOf,
  PURCHASES_FILE, TRASH_FILE, PURCHASE_COVERS_DIR
} from '../../library-cover-source.js';
import { extractPackageCoverFromBuffer, isPackageCoverCandidate, PACKAGE_COVER_MAX_BYTES } from '../../library-package-cover.js';

const COVER_PATH = '/api/library/cover';
const BOOTH_ID_RE = /^\d{5,9}$/;
const COVER_IMAGE_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
};

function stateDirOf(deps) {
  return String(deps?.STATE_DIR ?? '');
}

function libraryRootOf(deps) {
  const raw = typeof deps?.fileArchiveRootDir === 'function' ? deps.fileArchiveRootDir() : deps?.fileArchiveRootDir;
  const dir = String(raw || '').trim();
  return dir ? deps.path.resolve(dir) : '';
}

function cacheRootOf(deps) {
  try {
    return typeof deps.boothCacheDir === 'function' ? String(deps.boothCacheDir() || '') : String(deps.boothCacheDir || '');
  } catch {
    return '';
  }
}

/** 本地已购封面文件（只认固定文件名 <id>.jpg，和 library-purchases 的落盘一致）。 */
function purchaseCoverFile(deps, boothId) {
  const dir = stateDirOf(deps);
  if (!dir) return '';
  return deps.path.join(dir, PURCHASE_COVERS_DIR, `${boothId}.jpg`);
}

/** 读已购台账（坏文件当空台账：封面功能不能因为一次坏写就整体 500）。 */
export function readPurchaseItems(deps) {
  const dir = stateDirOf(deps);
  if (!dir) return [];
  try {
    const text = deps.fs.readFileSync(deps.path.join(dir, PURCHASES_FILE), 'utf8');
    const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return purchasesFromState(raw);
  } catch {
    return [];
  }
}

function purchaseById(deps, boothId) {
  if (!BOOTH_ID_RE.test(String(boothId ?? ''))) return null;
  return readPurchaseItems(deps).find((item) => item.boothId === boothId) || null;
}

function boothCacheFile(deps, boothId) {
  if (!BOOTH_ID_RE.test(String(boothId ?? ''))) return '';
  try {
    const cacheRoot = cacheRootOf(deps);
    if (!cacheRoot || typeof deps.getBoothCoverPath !== 'function') return '';
    return String(deps.getBoothCoverPath(boothId, { cacheRoot }) || '');
  } catch {
    return '';
  }
}

function exists(deps, file) {
  if (!file) return false;
  try {
    return deps.fs.existsSync(file) && deps.fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function mimeOfBuffer(deps, buf, file) {
  try {
    if (typeof deps.mimeFromBuffer === 'function') {
      const mime = deps.mimeFromBuffer(buf);
      if (mime) return mime;
    }
  } catch {}
  const ext = String(file || '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  return COVER_IMAGE_MIME[ext] || 'image/jpeg';
}

function sendImage(request, deps, buf, file, source) {
  const mime = mimeOfBuffer(deps, buf, file);
  // 必须先展开 SECURITY_HEADERS 再覆盖 Cache-Control：它带着 'Cache-Control': 'no-store'，
  // 如果先写小写 cache-control 再展开，同一响应会出现两个键（Node 头名不分大小写），no-store 胜出。
  request.res.writeHead(200, {
    ...request.SECURITY_HEADERS,
    'content-type': mime,
    'Cache-Control': 'public, max-age=86400',
    'X-Cover-Source': source || ''
  });
  request.res.end(buf);
  return true;
}

function sendRemoteRedirect(request, url, source) {
  request.res.writeHead(302, {
    ...request.SECURITY_HEADERS,
    location: url,
    'Cache-Control': 'public, max-age=3600',
    'X-Cover-Source': source || ''
  });
  request.res.end();
  return true;
}

/**
 * 给素材卡补 coverSource / coverReady（不改入参，缓存安全）。
 * 逐卡查一次已购台账 + 两次存在性判断：24 件量级可忽略；比让前端每张图都猜一遍便宜。
 */
export function annotateCoverState(deps, data) {
  const assets = Array.isArray(data?.assets) ? data.assets : [];
  if (!assets.length) return data;
  const purchases = new Map(readPurchaseItems(deps).map((item) => [item.boothId, item]));
  const next = assets.map((asset) => {
    const state = cardCoverStateWith(deps, asset, purchases);
    // verified-only（2026-10-30 起）：文件名里猜出来的号（name-prefix/folder）不许拿来展示封面，
    // 否则会显示成别的商品。未 verified 且没有本地缩略图时一律给空串，让前端显示「补封面」。
    const coverUrl = (!asset?.boothVerified && !asset?.thumbRel) ? '' : asset?.coverUrl;
    return { ...asset, coverUrl, coverSource: state.coverSource, coverReady: state.coverReady };
  });
  return { ...data, assets: next };
}

function cardCoverStateWith(deps, asset, purchases) {
  if (!asset) return { coverSource: '', coverReady: false };
  if (asset.thumbRel) return { coverSource: 'local', coverReady: true };
  const boothId = String(asset.boothId ?? '').trim();
  const hasBooth = BOOTH_ID_RE.test(boothId);
  // 只有 verified 的号才配去台账/缓存里找图：未核准的号是「猜的」，拿它找图就是在赌同名商品。
  if (hasBooth && asset.boothVerified) {
    if (exists(deps, purchaseCoverFile(deps, boothId))) return { coverSource: 'ledger', coverReady: true };
    const purchase = purchases.get(boothId);
    if (purchase && purchase.coverUrl) return { coverSource: 'ledger', coverReady: true };
    if (exists(deps, boothCacheFile(deps, boothId))) return { coverSource: 'cache', coverReady: true };
  }
  // 补封面从包里抠出来的图会落在 state/library-covers/<key>.<ext>：还没复制进素材目录前，
  // 卡片也该显示「有图可看」，否则前端一直显示占位、用户以为没救活。
  if (exists(deps, packageCoverCacheFile(deps, asset))) return { coverSource: 'unitypackage', coverReady: true };
  return { coverSource: '', coverReady: false };
}

/** 包内封面缓存路径（与 resolvePackageCover 的命名规则一致：key 过滤成安全字符）。 */
function packageCoverCacheFile(deps, asset) {
  const safeKey = String(asset?.key || asset?.boothId || 'cover').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'cover';
  const base = deps.path.join(stateDirOf(deps), 'library-covers', safeKey);
  for (const ext of ['png', 'jpg', 'webp', 'gif']) {
    const file = `${base}.${ext}`;
    if (exists(deps, file)) return file;
  }
  return `${base}.png`;
}

/**
 * 解析一张封面并直接吐图。
 * 顺序（文档 §4）：本地 thumbRel → 已购台账本地文件 → 台账远程地址（302）→ BOOTH 缓存 → 商品页抓取。
 * 台账远程地址用 302 而不是服务端下载：GET 封面不该卡几秒，也不该替用户的图床做代理。
 */
/**
 * 从素材自己的压缩包/unitypackage 里抠封面，成功时把字节落到 state/library-covers/ 并返回文件路径。
 * 失败一律返回 null（封面接口的规矩是「拿不到就说没有」，不因为包里没图给 500）。
 */
function resolvePackageCover(deps, card) {
  const mainName = String(card?.mainName || card?.file || '');
  if (!mainName || !isPackageCoverCandidate(mainName)) return null;
  const root = libraryRootOf(deps);
  if (!root) return null;
  const dir = String(card?.dir || '').replace(/\\/g, '/');
  let file = '';
  try {
    file = deps.safeResolveInside(root, dir ? `${dir}/${mainName}` : mainName);
  } catch {
    return null;
  }
  let stat = null;
  try {
    stat = deps.fs.statSync(file);
  } catch {
    return null;
  }
  // 只拒 >2GB 的坏包/误传；旧 32MB 门槛曾把 55MB 的真素材判死（里面确实有样图）。
  if (stat.size > PACKAGE_COVER_MAX_BYTES) return null;
  let buffer = null;
  try {
    buffer = deps.fs.readFileSync(file);
  } catch {
    return null;
  }
  let packed = null;
  try {
    packed = extractPackageCoverFromBuffer(buffer, { name: mainName, packageBytes: stat.size });
  } catch {
    return null;
  }
  if (!packed?.ok || !packed.bytes?.length) return null;
  const ext = packed.mime === 'image/jpeg' ? 'jpg' : packed.mime === 'image/webp' ? 'webp' : packed.mime === 'image/gif' ? 'gif' : 'png';
  const safeKey = String(card?.key || card?.boothId || 'cover').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'cover';
  const cacheDir = deps.path.join(stateDirOf(deps), 'library-covers');
  try {
    deps.fs.mkdirSync(cacheDir, { recursive: true });
    const out = deps.path.join(cacheDir, `${safeKey}.${ext}`);
    deps.fs.writeFileSync(out, packed.bytes);
    // 头的取值仍是 unitypackage（前端/文档约定的枚举），具体是 unitypackage 形状还是 zip 挑图由日志区分。
    return { kind: 'buffer', file: out, source: 'unitypackage' };
  } catch {
    return null;
  }
}

async function resolveCover(deps, getAssets, key) {
  const purchaseId = purchaseBoothIdOf(key);
  let card = null;
  if (!purchaseId) {
    const snap = await getAssets();
    card = (snap.assets || []).find((asset) => String(asset.key) === String(key)) || null;
    if (!card) return null;
    if (card.thumbRel) {
      const root = libraryRootOf(deps);
      if (root) {
        try {
          const file = deps.safeResolveInside(root, String(card.thumbRel).replace(/\\/g, '/'));
          if (exists(deps, file)) return { kind: 'buffer', file, source: 'local' };
        } catch {}
      }
    }
    // 包内预览不依赖 BOOTH 号：没号的素材也该能从自己的压缩包里取封面，
    // 所以放在「卡存在」之后就试，而不是等下面 boothId 校验（真机验证踩过：无号件永远 404）。
    const packedLocal = resolvePackageCover(deps, card);
    if (packedLocal) return packedLocal;
  }
  // verified-only：未核准的号（文件名猜的）不许拿去 BOOTH 抓商品页封面——
  // 6985553 这种猜错的号会抓回完全另一个商品的图，用户看到的就是「封面全错」。
  if (!purchaseId && !card.boothVerified) return null;
  const boothId = purchaseId || String(card?.boothId ?? '').trim();
  if (!BOOTH_ID_RE.test(boothId)) return null;
  const local = purchaseCoverFile(deps, boothId);
  if (exists(deps, local)) return { kind: 'buffer', file: local, source: 'ledger' };
  const purchase = purchaseById(deps, boothId);
  if (purchase && purchase.coverUrl) return { kind: 'redirect', url: purchase.coverUrl, source: 'ledger' };
  const cached = boothCacheFile(deps, boothId);
  if (exists(deps, cached)) return { kind: 'buffer', file: cached, source: 'cache' };
  // 最后一档才联网：getBoothCover 内部会读全局暂停闸，暂停中直接返回 paused，不会打请求。
  try {
    const got = await deps.getBoothCover(boothId, {
      cacheRoot: cacheRootOf(deps),
      rateLimitMs: 1200,
      stateDir: stateDirOf(deps),
      log: deps.log
    });
    if (got?.ok && got.path && exists(deps, got.path)) return { kind: 'buffer', file: got.path, source: 'booth' };
  } catch {}
  return null;
}

// @bridge-function handleConsoleLibraryCover:start
export async function handleLibraryCoverRoute(request, deps, getAssets) {
  if (request.url.pathname !== COVER_PATH) return false;
  if (request.req.headers['x-agent-token'] || request.req.headers['x-agent-call']) {
    request.sendJson({ ok: false, error: '封面只允许人看，智能体令牌不行' }, 403);
    return true;
  }
  if (request.req.method !== 'GET') {
    request.sendJson({ ok: false, error: '该接口只支持 GET' }, 405);
    return true;
  }
  const key = String(request.url.searchParams.get('key') || '').trim();
  if (!key) {
    request.sendJson({ ok: false, error: '缺少 key（用素材卡或 cloud 卡的 key）' }, 400);
    return true;
  }
  // getAssets 由 library-view 传入，保证和列表同一条最终视图链（含改名/合并/绑定/手动分类）。
  try {
    const hit = await resolveCover(deps, getAssets, key);
    if (!hit) {
      request.sendJson({ ok: false, error: '这件素材没有可用的封面（本地、台账、缓存都没有）' }, 404);
      return true;
    }
    if (hit.kind === 'redirect') return sendRemoteRedirect(request, hit.url, hit.source);
    const buf = deps.fs.readFileSync(hit.file);
    return sendImage(request, deps, buf, hit.file, hit.source);
  } catch (error) {
    deps.log(`素材库：解析封面失败 ${key}：${error?.message ?? error}`);
    request.sendJson({ ok: false, error: `解析封面失败：${error?.message ?? error}` }, 500);
    return true;
  }
}
// @bridge-function handleConsoleLibraryCover:end

// ── v2 视图：cloud（已购未下载）与 trash（回收站）的远程卡片 ──────────────────
// 为什么单拆出来：这两类卡片的数据源是 state/ 下的台账，不是扫盘结果；读取与分页放这里，
// library-view 只负责把结果发出去（那个文件贴着 800 行规模闸）。
// 返回的键名与素材页对齐：{ok,view,items,count,total,allCount,offset,limit,truncated,q,sort}。

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

/** cloud 卡的封面统一指向 /api/library/cover：本地有图零网络直出，只有远程地址时 302。 */
function withCloudCover(deps, card) {
  const id = String(card?.boothId ?? '');
  const dir = String(deps?.STATE_DIR ?? '');
  let hasLocal = false;
  if (id && dir) {
    const local = deps.path.join(dir, PURCHASE_COVERS_DIR, `${id}.jpg`);
    try { hasLocal = deps.fs.existsSync(local) && deps.fs.statSync(local).isFile(); } catch {}
  }
  if (!hasLocal && !card.coverRemote) return card;
  return { ...card, coverUrl: `/api/library/cover?key=${encodeURIComponent(card.key)}`, coverSource: 'ledger', coverReady: true };
}

export function buildRemoteAssetView({ deps, snap, view, searchParams, root, allCount = 0 }) {
  const cards = view === 'cloud'
    ? cloudCardsFromPurchases(
      purchasesFromState(readStateJson(deps, PURCHASES_FILE)),
      { libraryBoothIds: (snap?.assets || []).map((asset) => String(asset?.boothId ?? '')).filter(Boolean) }
    ).map((card) => withCloudCover(deps, card))
    : trashCardsFromState(readStateJson(deps, TRASH_FILE));
  const page = pickRemoteCards(cards, {
    q: searchParams.get('q'),
    sort: searchParams.get('sort'),
    offset: searchParams.get('offset'),
    limit: searchParams.get('limit')
  });
  return {
    ok: true,
    view,
    items: page.items,
    count: page.count,
    total: page.total,
    // cloud 的 allCount 是「还没下载的已购件数」，trash 是库内件数（前端拿它显示「全部」胶囊）。
    allCount: view === 'cloud' ? page.allCount : allCount,
    offset: page.offset,
    limit: page.limit,
    truncated: page.truncated,
    q: page.q,
    sort: page.sort,
    root: root ?? '',
    scannedAt: Number(snap?.scannedAt) || Date.now()
  };
}
