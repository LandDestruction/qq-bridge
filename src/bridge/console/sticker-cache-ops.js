// 表情缩略图缓存的管理接口（VM-safe：零 import，纯函数与文件系统都从 deps 取）。
//
// 三件事：看统计、清缓存（孤儿 + LRU）、补缩略图。真正的清理/修复计划在 src/sticker-cache.js，
// 落盘/删除动作在 observe-runtime；这里只做参数校验、调用与响应，方便控制台和测试共用。
export function createStickerCacheOps(deps) {
  function stats() {
    const files = typeof deps.stickerCacheFileList === 'function' ? deps.stickerCacheFileList() : [];
    const entries = Array.isArray(deps.stickerEntries) ? deps.stickerEntries : [];
    const limitBytes = typeof deps.stickerCacheLimit === 'function' ? deps.stickerCacheLimit() : 0;
    const base = deps.stickerCachePure.normalizeStickerCacheStats({ entries, files, limitBytes });
    // 纯函数那边只统计 missing；unavailable（链接已失效、永不再试）在本层补一个计数。
    const unavailable = entries.filter((entry) => String(entry?.thumbStatus ?? '') === 'unavailable').length;
    return { ...base, unavailable };
  }

  function agentBlocked(request) {
    const headers = request?.req?.headers ?? {};
    if (headers['x-agent-token'] || headers['x-agent-call']) {
      request.sendJson({ ok: false, error: '未授权：表情缓存是管理端操作' }, 403);
      return true;
    }
    return false;
  }

// @bridge-function handleStickerCacheStatus:start
  async function handleStickerCacheStatus(request) {
    if (!deps.stickerCachePure) return false;
    const pathname = request.url.pathname;
    if (pathname !== '/api/stickers/cache') return false;
    if (agentBlocked(request)) return true;
    if (request.method !== 'GET') {
      request.sendJson({ ok: false, error: '该接口只支持 GET' }, 405);
      return true;
    }
    request.sendJson({ ok: true, ...stats() });
    return false;
  }
// @bridge-function handleStickerCacheStatus:end

// @bridge-function handleStickerCacheCleanup:start
  async function handleStickerCacheCleanup(request) {
    if (!deps.stickerCachePure) return false;
    if (request.url.pathname !== '/api/stickers/cache/cleanup') return false;
    if (agentBlocked(request)) return true;
    if (request.method !== 'POST') {
      request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405);
      return true;
    }
    let body = null;
    try {
      body = await request.readBody({ maxBytes: 64 * 1024 });
    } catch {
      request.sendJson({ ok: false, error: '请求体不是合法 JSON' }, 400);
      return false;
    }
    // 只有显式 dryRun:true / "true" 才不删；缺省就是真删（接口本身就是「清理」）。
    const raw = body?.dryRun;
    const dryRun = raw === true || raw === 'true';
    if (raw !== undefined && raw !== null && typeof raw !== 'boolean' && raw !== 'true' && raw !== 'false') {
      request.sendJson({ ok: false, error: 'dryRun 只认 true 或 false' }, 400);
      return false;
    }
    try {
      const result = await deps.cleanupStickerCache({ dryRun });
      request.sendJson({ ok: true, dryRun, ...result, stats: stats() });
    } catch (error) {
      (0, deps.log)(`[sticker] 清理缓存失败：${error?.message ?? error}`);
      request.sendJson({ ok: false, error: `清理失败：${error?.message ?? error}` }, 500);
    }
    return false;
  }
// @bridge-function handleStickerCacheCleanup:end

// @bridge-function handleStickerThumbsRepair:start
  async function handleStickerThumbsRepair(request) {
    if (!deps.stickerCachePure) return false;
    if (request.url.pathname !== '/api/stickers/thumbs/repair') return false;
    if (agentBlocked(request)) return true;
    if (request.method !== 'POST') {
      request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405);
      return true;
    }
    let body = null;
    try {
      body = await request.readBody({ maxBytes: 64 * 1024 });
    } catch {
      request.sendJson({ ok: false, error: '请求体不是合法 JSON' }, 400);
      return false;
    }
    const rawLimit = body?.limit;
    let limit = 20;
    if (rawLimit !== undefined && rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (!Number.isFinite(parsed)) {
        request.sendJson({ ok: false, error: 'limit 必须是数字（默认 20，最多 50）' }, 400);
        return false;
      }
      limit = Math.min(50, Math.max(1, Math.floor(parsed)));
    }
    try {
      // 先做一次纯本地归类：过期链接的 missing → unavailable，别再打网络。
      let markedUnavailable = 0;
      if (typeof deps.markExpiredMissingUnavailable === 'function') {
        markedUnavailable = Number(await deps.markExpiredMissingUnavailable()) || 0;
      }
      const result = await deps.persistMissingStickerThumbs({ limit });
      request.sendJson({
        ok: true,
        limit,
        ...result,
        markedUnavailable: markedUnavailable + (Number(result?.markedUnavailable) || 0),
        stats: stats()
      });
    } catch (error) {
      (0, deps.log)(`[sticker] 修复缩略图失败：${error?.message ?? error}`);
      request.sendJson({ ok: false, error: `修复失败：${error?.message ?? error}` }, 500);
    }
    return false;
  }
// @bridge-function handleStickerThumbsRepair:end

// @bridge-function handleStickerUnavailableRemove:start
  async function handleStickerUnavailableRemove(request) {
    if (!deps.stickerCachePure) return false;
    if (request.url.pathname !== '/api/stickers/unavailable/remove') return false;
    if (agentBlocked(request)) return true;
    if (request.method !== 'POST') {
      request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405);
      return true;
    }
    let body = null;
    try {
      body = await request.readBody({ maxBytes: 64 * 1024 });
    } catch {
      request.sendJson({ ok: false, error: '请求体不是合法 JSON' }, 400);
      return false;
    }
    const raw = body?.dryRun;
    const dryRun = raw === true || raw === 'true';
    if (raw !== undefined && raw !== null && typeof raw !== 'boolean' && raw !== 'true' && raw !== 'false') {
      request.sendJson({ ok: false, error: 'dryRun 只认 true 或 false' }, 400);
      return false;
    }
    const entries = Array.isArray(deps.stickerEntries) ? deps.stickerEntries : [];
    const doomed = entries.filter((entry) => String(entry?.thumbStatus ?? '') === 'unavailable');
    const keys = doomed.map((entry, index) => String(entry?.key ?? entry?.id ?? index)).slice(0, 20);
    if (!dryRun && doomed.length) {
      const dead = new Set(doomed);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (dead.has(entries[i])) entries.splice(i, 1);
      }
      if (typeof deps.saveStickerStoreSafe === 'function') (0, deps.saveStickerStoreSafe)();
      (0, deps.log)(`[sticker] 删除不可用表情 ${doomed.length} 条（链接已失效，永不再试）`);
    }
    request.sendJson({ ok: true, dryRun, removed: dryRun ? 0 : doomed.length, matched: doomed.length, keys, stats: stats() });
    return false;
  }
// @bridge-function handleStickerUnavailableRemove:end

  return { handleStickerCacheStatus, handleStickerCacheCleanup, handleStickerThumbsRepair, handleStickerUnavailableRemove };
}
