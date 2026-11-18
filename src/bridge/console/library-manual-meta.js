// src/bridge/console/library-manual-meta.js — 手动标签 / 手动分类的路由与视图叠加。
//
// 为什么单独一个 VM 模块：这个文件在 console 模块 VM 里裸执行（不能 import），
// 纯规则由调用方把 `src/library-manual-meta.js` 的命名空间（deps.libraryManualMetaPure）递进来；
// 而 library-view.js 是本模块的唯一调用方，它顺手把同一份命名空间传参，口径只有一份。
//
// 边界：只写 state/library-manual-meta.json（原子写），不动磁盘文件名、不动 contentKey、
// 不动绑定表/收藏表；改名时由 library-rename.js 按 key 迁移（和绑定、收藏同一调用点）。

export const LIBMANMETA_PATH = '/api/library/manual-meta';

function entryView(entry) {
  if (!entry) return null;
  return {
    tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
    category: String(entry.category ?? ''),
    note: String(entry.note ?? ''),
    updatedAt: Number(entry.updatedAt) || 0
  };
}

/**
 * 把台账叠加到最终视图（不改入参，缓存安全）。
 * 为什么在视图链的最后一步：手动分类要压过 meta/规则分类，手动标签要和解析标签取并集，
 * 而 facets / counts / 筛选全都读最终视图——放前面会被后面的规则覆盖，左右栏数字又会和列表不符。
 */
export function withManualMeta(deps, data, pure) {
  const api = pure || {};
  if (typeof api.applyManualMeta !== 'function' || typeof api.readManualMetaState !== 'function') return data;
  const table = api.readManualMetaState(deps);
  const items = (table && table.items) || {};
  const list = Array.isArray(data?.assets) ? data.assets : [];
  // 统计只从台账算一次：GET manual-meta、assets.counts.manual、facets 手动分类都用这份，
  // 别各自遍历（否则同一屏三个数字互相对不上）。
  const stats = typeof api.manualMetaStatsOf === 'function'
    ? api.manualMetaStatsOf(table)
    : { entries: Object.keys(items).length, tagged: 0, categorized: 0, noted: 0 };
  const assets = list.map((asset) => api.applyManualMeta(asset, items[String(asset?.key ?? '')] || null));
  return { ...data, assets, manualMetaStats: stats };
}

/**
 * GET  /api/library/manual-meta?key=… → 读一条（不存在也 200，entry:null，前端好判）；
 * POST /api/library/manual-meta {key, tags?, category?, note?, clear?} → 写一条/清空。
 *
 * key 必须在当前快照里能找到才允许写：前端拿着旧卡片来写，台账会留下一条永远对不上的孤儿记录。
 * agent 令牌与访客一律 403——手动标签是"人给库下判断"，不能让模型或只读访客改。
 */
export async function handleLibraryManualMetaRoute(request, deps, getAssets, pure) {
  const pathname = request.url.pathname;
  if (pathname !== LIBMANMETA_PATH) return false;
  const headers = request.req.headers || {};
  if (headers['x-agent-token'] || headers['x-agent-call']) {
    request.sendJson({ ok: false, error: '手动标签只允许管理端操作' }, 403);
    return true;
  }
  if (String(request.consoleRole || '') === 'guest') {
    request.sendJson({ ok: false, error: '访客只能查看，不能改手动标签' }, 403);
    return true;
  }
  const method = String(request.req.method || '').toUpperCase();
  const api = pure || {};

  if (method === 'GET') {
    const key = String(request.url.searchParams.get('key') ?? '').trim();
    try {
      const table = api.readManualMetaState(deps);
      // 不带 key = 台账统计（左栏/顶部汇总用）；带 key = 单条（不存在也 200，entry:null，
      // 前端不用把「没写过」当错误处理；404 只留给 POST 不存在的素材）。
      if (!key) {
        const stats = typeof api.manualMetaStatsOf === 'function'
          ? api.manualMetaStatsOf(table)
          : { entries: 0, tagged: 0, categorized: 0, noted: 0 };
        request.sendJson({ ok: true, stats });
        return true;
      }
      const entry = api.manualEntryOf(table, key);
      request.sendJson({ ok: true, key, entry: entryView(entry) });
    } catch (error) {
      request.sendJson({ ok: false, error: `读取手动标签失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  if (method !== 'POST') {
    request.sendJson({ ok: false, error: '该接口只支持 GET / POST' }, 405);
    return true;
  }
  let body;
  try { body = await request.readBody(); }
  catch (error) { request.sendJson({ ok: false, error: error?.message ?? '请求体非法' }, Number(error?.statusCode) || 400); return true; }
  const key = String(body?.key ?? '').trim();
  if (!key) { request.sendJson({ ok: false, error: '缺少 key（素材的 contentKey）' }, 400); return true; }

  // 先确认这件素材真的在库里：写台账不能靠前端一张过期卡片。
  let exists = false;
  try {
    const data = await getAssets();
    exists = Array.isArray(data?.assets) && data.assets.some((asset) => String(asset?.key ?? '') === key);
  } catch (error) {
    request.sendJson({ ok: false, error: `素材扫描失败：${error?.message ?? error}` }, 500);
    return true;
  }
  if (!exists) { request.sendJson({ ok: false, error: '没有这件素材（刷新一下素材卡列表再试）' }, 404); return true; }

  try {
    const table = api.readManualMetaState(deps);
    const cleared = body?.clear === true;
    let next;
    if (cleared) {
      next = api.clearManualMeta(table, key);
    } else {
      // 只把真正给了的字段写进去：没给的字段保持原值（否则「只改分类」会把标签清空）。
      const patch = {};
      for (const field of ['tags', 'category', 'note']) {
        if (Object.prototype.hasOwnProperty.call(body || {}, field)) patch[field] = body[field];
      }
      next = api.setManualMeta(table, key, patch, { now: Date.now() });
    }
    api.writeManualMetaState(deps, next);
    const entry = api.manualEntryOf(next, key);
    const summary = entry
      ? `标签${entry.tags.length}个/分类${entry.category || '默认'}/备注${entry.note ? '有' : '无'}`
      : '空';
    deps.log(`素材库：手动标签 ${key}（${cleared ? '清空' : summary}）`);
    request.sendJson({ ok: true, key, cleared, entry: entryView(entry) });
  } catch (error) {
    request.sendJson({ ok: false, error: `保存手动标签失败：${error?.message ?? error}` }, 500);
  }
  return true;
}
