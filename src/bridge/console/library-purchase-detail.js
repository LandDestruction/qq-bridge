// src/bridge/console/library-purchase-detail.js — 「商品详情面板」的取数 + 路由。
//
// 纯规则在 src/library-purchase-detail.js（models 分桶、purchasedAt 兜底、搭配建议、卡片组装），
// 这里只做三件事：读三份台账（已购 / 下载 / 素材集）、拿最终素材视图、拼封面地址。
//
// 为什么用 ESM 而不是 manifest 模块：console-server 的 createConsoleServer 行数在规模闸基线里
// 冻结（668 行，只许变小），加一条 `@bridge-routes` 块要多 3 行；面板只需要读盘，没有
// 需要 bridge.js 注入的运行时能力，所以和 library-duplicates.js 一样走「library-view 单行分派 +
// console-server 现有 /api/library/* 大条件」这条路，能不加行就不加。

import { purchasesFromState } from '../../library-cover-source.js';
import { buildPurchaseDetail, describePurchaseDetail, normalizeBoothId } from '../../library-purchase-detail.js';

const PURCHASE_COVERS_DIR = 'booth-purchase-covers';
const DOWNLOADS_FILE = 'booth-downloads.json';
const COLLECTIONS_FILE = 'library-collections.json';

function readStateJson(deps, fileName) {
  try {
    const file = deps.path.join(String(deps.STATE_DIR), fileName);
    return JSON.parse(deps.fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function downloadJobsOf(raw) {
  const jobs = Array.isArray(raw?.jobs) ? raw.jobs : [];
  const byId = new Map();
  for (const job of jobs) {
    const boothId = String(job?.boothId ?? '').trim();
    if (boothId) byId.set(boothId, job);
  }
  return byId;
}

/** 本地已落图走本地接口（离线可用），没落图退回台账里的远程 coverUrl。 */
function coverUrlOf(deps, boothId, purchase) {
  try {
    const file = deps.path.join(String(deps.STATE_DIR), PURCHASE_COVERS_DIR, `${boothId}.jpg`);
    if (deps.fs.existsSync(file)) {
      return `/api/library/purchases/cover?boothId=${boothId}&v=${Number(purchase?.updatedAt) || 0}`;
    }
  } catch {
    /* 落图目录读不到不算错，退回远程 */
  }
  const remote = String(purchase?.coverUrl ?? '').trim();
  return /^https?:\/\//i.test(remote) ? remote : '';
}

/**
 * GET /api/library/purchase-detail?boothId= → 面板数据（只读，不抓网）。
 * @returns {boolean|Promise<boolean>} 命中本路由返回 true
 */
export async function handlePurchaseDetailRoute(request, deps, getAssets) {
  if (String(request?.url?.pathname ?? '') !== '/api/library/purchase-detail') return false;
  const headers = request?.req?.headers ?? {};
  if (headers['x-agent-token'] || headers['x-agent-call']) {
    request.sendJson({ ok: false, error: '商品详情只允许管理端操作' }, 403);
    return true;
  }
  if (String(request?.req?.method ?? 'GET').toUpperCase() !== 'GET') {
    request.sendJson({ ok: false, error: '只支持 GET' }, 405);
    return true;
  }
  const raw = String(request?.url?.searchParams?.get?.('boothId') ?? '').trim();
  if (!raw) {
    request.sendJson({ ok: false, error: '缺少 boothId（BOOTH 商品号，5~9 位数字）' }, 400);
    return true;
  }
  const boothId = normalizeBoothId(raw);
  if (!boothId) {
    request.sendJson({ ok: false, error: 'boothId 不是合法的 BOOTH 商品号（5~9 位数字）' }, 400);
    return true;
  }
  try {
    const purchases = purchasesFromState(readStateJson(deps, 'booth-purchases.json'));
    const purchase = purchases.find((row) => row.boothId === boothId) || null;
    if (!purchase) {
      request.sendJson({ ok: false, error: '没有这件已购记录（检查一下 BOOTH 号，或先同步已购清单）' }, 404);
      return true;
    }
    const snap = await getAssets();
    const assets = Array.isArray(snap) ? snap : snap?.assets;
    const detail = buildPurchaseDetail({
      purchase,
      // 全量已购里同一条要按当前件口径算（buildPurchaseDetail 内部会排除自己）
      purchases: purchases.map((row) => (row.boothId === boothId ? purchase : row)),
      assets,
      downloadJob: downloadJobsOf(readStateJson(deps, DOWNLOADS_FILE)).get(boothId) || null,
      collectionsTable: readStateJson(deps, COLLECTIONS_FILE),
      coverUrl: coverUrlOf(deps, boothId, purchase)
    });
    if (typeof deps?.log === 'function') {
      deps.log(`[素材库] 商品详情 ${boothId}：${describePurchaseDetail(detail)}`);
    }
    request.sendJson(detail);
  } catch (error) {
    request.sendJson({ ok: false, error: `读取商品详情失败：${error?.message ?? error}` }, 500);
  }
  return true;
}
