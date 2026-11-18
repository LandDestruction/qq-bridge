// stickers: extracted bridge responsibilities; no startup side effects.
// Live dependencies: AbortSignal, STICKER_FILE, bot, cfg, fetch, findSticker, formatStickerList, log, mergeStickerLibrary, persistMissingStickerThumbs, saveStickerStore, stickerEntries, stickerStoreWritable, stickerSyncedAt
export function createStickers(deps) {
// @bridge-function stickerEnabled:start
function stickerEnabled() {
    return deps.cfg.socialV2?.sticker?.enabled !== false;
  }
// @bridge-function stickerEnabled:end

// @bridge-function saveStickerStoreSafe:start
function saveStickerStoreSafe() {
    if (!deps.stickerStoreWritable) return; // 读失败时绝不回写，避免把「损坏」当成「空库」落盘
    try { (0, deps.saveStickerStore)(deps.STICKER_FILE, deps.stickerEntries); } catch (error) { (0, deps.log)('保存表情库失败:', error?.message ?? error); }
  }
// @bridge-function saveStickerStoreSafe:end

// @bridge-function onebotHttpAction:start
async function onebotHttpAction(action, params = {}, { timeoutMs = 15000 } = {}) {
    const httpUrl = String(deps.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await (0, deps.fetch)(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params ?? {}),
      signal: deps.AbortSignal.timeout(timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
      throw new Error(`OneBot HTTP ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body;
  }
// @bridge-function onebotHttpAction:end

// @bridge-function syncStickerLibrary:start
async function syncStickerLibrary(force = false) {
    if (deps.cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(deps.cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && deps.stickerSyncedAt && now - deps.stickerSyncedAt < ttl) {
      return { entries: deps.stickerEntries, syncedAt: deps.stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(deps.cfg.socialV2?.sticker?.maxListCount) || 100));
      let response;
      let via = 'ws';
      try {
        response = await deps.bot.request('fetch_custom_face_detail', { count });
        if (!response || response.status !== 'ok' || response.retcode !== 0) {
          throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
        }
      } catch (wsError) {
        // WS 失败 ⇒ 立刻用 HTTP 再问一次同一个 action（语义相同，token 可能不同但同一账号）。
        (0, deps.log)(`[sticker] WS 同步不可用（${wsError?.message ?? wsError}），改走 OneBot HTTP 兜底`);
        response = await onebotHttpAction('fetch_custom_face_detail', { count });
        via = 'http';
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      deps.stickerEntries = (0, deps.mergeStickerLibrary)(deps.stickerEntries, fetched, { complete: fetched.length < count });
      deps.stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      (0, deps.log)(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${deps.stickerEntries.length} 条，via ${via}）`);
      // 收藏/同步进来的表情：有 url 的立刻补一次落盘（后台跑，不阻塞同步返回）。
      // 只补前 20 条（新的/还没缓存的），失败会标 missing，不会无限重试。
      void (0, deps.persistMissingStickerThumbs)({ limit: 20 }).catch((error) => {
        (0, deps.log)(`[sticker] 同步后补落盘失败（不影响收藏）：${error?.message ?? error}`);
      });
      return { entries: deps.stickerEntries, syncedAt: deps.stickerSyncedAt, fromCache: false, via };
    } catch (error) {
      (0, deps.log)(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }
// @bridge-function syncStickerLibrary:end

// @bridge-function listStickersForV2:start
async function listStickersForV2(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? deps.stickerEntries;
    return (0, deps.formatStickerList)(entries, query, count);
  }
// @bridge-function listStickersForV2:end

// @bridge-function getStickerImageData:start
async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const entry = (0, deps.findSticker)(synced?.entries ?? deps.stickerEntries, stickerId);
    if (!entry) {
      // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
      const forced = await syncStickerLibrary(true);
      const entry2 = (0, deps.findSticker)(forced?.entries ?? deps.stickerEntries, stickerId);
      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
      return entry2;
    }
    return entry;
  }
// @bridge-function getStickerImageData:end
  return { stickerEnabled, saveStickerStoreSafe, onebotHttpAction, syncStickerLibrary, listStickersForV2, getStickerImageData };
}
