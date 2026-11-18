// observe-runtime: extracted bridge responsibilities; no startup side effects.
// Live dependencies: STATE_DIR, STICKER_CACHE_MAX_BYTES, STICKER_THUMB_MAX_BYTES, applyObserveLearning, cfg, collectSticker, describeObserveStickerSegments, feedSlangWindow, fetchFaceMedia, fetchOneBotImage, findSticker, fs, log, md5Hex, observeLoggedAt, observeShapeLoggedAt, path, persistStickerThumb, planObserveLearning, safeFetchBinary, saveStickerStoreSafe, stickerCacheBytes, stickerCachePath, stickerCacheTotalCache, stickerCacheWarnedAt, stickerEntries
export function createObserveRuntime(deps) {
// @bridge-function noteObserveActivity:start
function noteObserveActivity(groupId, learned) {
    const now = Date.now();
    const last = deps.observeLoggedAt.get(groupId) ?? 0;
    if (now - last < 60 * 60 * 1000) return; // 每个观察群每小时最多一行，避免刷日志
    deps.observeLoggedAt.set(groupId, now);
    (0, deps.log)(`观察群 ${groupId}：只学习不发言（已收集${learned}）`);
  }
// @bridge-function noteObserveActivity:end

// @bridge-function logObserveStickerShapes:start
function logObserveStickerShapes(groupId, event) {
    const shapes = (0, deps.describeObserveStickerSegments)(event);
    if (!shapes.length) return;
    const hour = Math.floor(Date.now() / 3600000);
    if (deps.observeShapeLoggedAt.get(groupId) === hour) return;
    deps.observeShapeLoggedAt.set(groupId, hour);
    (0, deps.log)(`观察群 ${groupId} 表情段形态：${shapes.map((s) => `${s.type}(url=${s.hasUrl ? 'yes' : 'no'},file=${s.hasFile ? s.filePrefix : '-'},face=${s.faceId || '-'})`).join(' | ')}`);
  }
// @bridge-function logObserveStickerShapes:end

// @bridge-function stickerCacheDirPath:start
function stickerCacheDirPath() {
    return deps.path.join(deps.STATE_DIR, 'sticker-files');
  }
// @bridge-function stickerCacheDirPath:end

// @bridge-function stickerCacheLimit:start
function stickerCacheLimit() {
    const mb = Number(deps.cfg.socialV2?.sticker?.cacheMaxMb);
    return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : deps.STICKER_CACHE_MAX_BYTES;
  }
// @bridge-function stickerCacheLimit:end

// @bridge-function stickerCacheTotal:start
function stickerCacheTotal() {
    if (deps.stickerCacheTotalCache == null) deps.stickerCacheTotalCache = (0, deps.stickerCacheBytes)(stickerCacheDirPath());
    return deps.stickerCacheTotalCache;
  }
// @bridge-function stickerCacheTotal:end

// @bridge-function persistEntryThumb:start
async function persistEntryThumb(entry) {
    if (!entry) return null;
    const limit = stickerCacheLimit();
    if (stickerCacheTotal() >= limit) {
      entry.thumbStatus = 'missing';
      entry.thumbError = `本地表情缓存已达上限（${Math.round(limit / 1024 / 1024)}MB），跳过落盘`;
      // 可重试的分类：限速/淘汰类 nextThumbRepairPlan 会挑出来，普通「链接过期」不会。
      entry.thumbErrorKind = 'cache-limit';
      entry.updatedAt = new Date().toISOString();
      if (Date.now() - deps.stickerCacheWarnedAt > 60 * 60 * 1000) {
        deps.stickerCacheWarnedAt = Date.now();
        (0, deps.log)(`⚠️ 表情缓存已达上限 ${Math.round(limit / 1024 / 1024)}MB：新表情只存链接不落盘（可在控制台清理 state/sticker-files）`);
      }
      return { status: 'skipped', error: entry.thumbError };
    }
    const result = await (0, deps.persistStickerThumb)(entry, {
      fetchImpl: (url, maxBytes) => (0, deps.safeFetchBinary)(url, maxBytes),
      cacheDir: stickerCacheDirPath(),
      maxBytes: deps.STICKER_THUMB_MAX_BYTES
    });
    if (result?.status === 'ok') {
      entry.thumbErrorKind = '';
      deps.stickerCacheTotalCache = stickerCacheTotal() + (Number(result.bytes) || 0);
    }
    if (result?.status === 'cached') entry.thumbErrorKind = '';
    if (result?.status === 'missing') {
      const errText = String(result.error || entry.thumbError || '');
      if (thumbUnavailableKind(errText)) {
        // 链接本身失效（HTTP 4xx）：标记 unavailable，不再当 missing 反复重试。
        entry.thumbStatus = 'unavailable';
        entry.thumbErrorKind = 'expired-url';
        entry.thumbError = `链接已失效，不再重试：${errText}`.slice(0, 200);
        entry.updatedAt = new Date().toISOString();
        (0, deps.log)(`[sticker] 缩略图链接失效，标记 unavailable：${entry.id.slice(0, 22)}（${errText.slice(0, 60)}）`);
      } else {
        entry.thumbErrorKind = deps.stickerCachePure.describeThumbError(errText || entry.thumbError);
        (0, deps.log)(`表情图片未落盘：${entry.id.slice(0, 22)}（${result.error || '下载失败'}）—— 已标记 missing`);
      }
    }
    return result;
  }
// @bridge-function persistEntryThumb:end

// @bridge-function thumbUnavailableKind:start
function thumbUnavailableKind(text) {
    // HTTP 4xx（400/403/404/410）= 链接已失效：归 unavailable，别让补图计划永远白跑网络。
    return /(?:HTTP|http)\s*4\d\d|400\s*bad\s*request|bad\s*request|410\s*gone|forbidden/i.test(String(text ?? '')) ? 'expired-url' : '';
  }
// @bridge-function thumbUnavailableKind:end

// @bridge-function stickerCacheFileList:start
function stickerCacheFileList() {
    const dir = stickerCacheDirPath();
    try {
      return deps.fs.readdirSync(dir).map((name) => {
        try {
          const stat = deps.fs.statSync(deps.path.join(dir, name));
          return stat.isFile() ? { name, bytes: stat.size, mtimeMs: stat.mtimeMs } : null;
        } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }
// @bridge-function stickerCacheFileList:end

// @bridge-function stickerCachePlan:start
function stickerCachePlan(now = Date.now()) {
    return deps.stickerCachePure.planStickerCacheCleanup({ entries: deps.stickerEntries, files: stickerCacheFileList(), limitBytes: stickerCacheLimit(), now });
  }
// @bridge-function stickerCachePlan:end

// @bridge-function cleanupStickerCache:start
async function cleanupStickerCache({ dryRun = false, now = Date.now() } = {}) {
    const plan = stickerCachePlan(now);
    const fmt = (bytes) => `${(Number(bytes) / 1024 / 1024).toFixed(1)}MB`;
    const orphanBytes = plan.orphanFiles.reduce((sum, file) => sum + file.bytes, 0);
    const lruBytes = plan.lruFiles.reduce((sum, file) => sum + file.bytes, 0);
    const summary = {
      ok: true,
      dryRun: Boolean(dryRun),
      freedBytes: plan.freedBytes,
      orphanFiles: plan.orphanFiles.length,
      lruFiles: plan.lruFiles.length,
      remainingBytes: plan.keepBytes,
      totalBytes: plan.totalBytes,
      limitBytes: plan.limitBytes,
      overLimit: plan.overLimit
    };
    if (dryRun) return summary;
    const dir = stickerCacheDirPath();
    let deletedBytes = 0;
    for (const file of [...plan.orphanFiles, ...plan.lruFiles]) {
      try {
        deps.fs.unlinkSync(deps.path.join(dir, file.name));
        deletedBytes += file.bytes;
      } catch (error) {
        (0, deps.log)(`[sticker] 删除缓存文件失败：${file.name}（${error?.message ?? error}）`);
      }
    }
    if (plan.orphanFiles.length) (0, deps.log)(`[sticker] 清理缓存孤儿 ${plan.orphanFiles.length} 个 / ${fmt(orphanBytes)}`);
    if (plan.lruFiles.length) {
      // LRU 淘汰：文件删了，但条目要留着并标「可重试」，下次 repair 还能把图补回来。
      const lruMd5 = new Set(plan.lruFiles.map((file) => String(file.md5 || '').toLowerCase()));
      for (const entry of deps.stickerEntries) {
        if (!entry || !lruMd5.has(String(entry.md5 || '').toLowerCase())) continue;
        entry.thumbStatus = 'missing';
        entry.thumbError = '缓存淘汰，可重试';
        entry.thumbErrorKind = 'evicted';
        entry.updatedAt = new Date().toISOString();
      }
      (0, deps.saveStickerStoreSafe)();
      (0, deps.log)(`[sticker] 淘汰 LRU ${plan.lruFiles.length} 个 / ${fmt(lruBytes)}`);
    }
    deps.stickerCacheTotalCache = null;
    return { ...summary, freedBytes: deletedBytes };
  }
// @bridge-function cleanupStickerCache:end

// @bridge-function markExpiredMissingUnavailable:start
function markExpiredMissingUnavailable() {
    // 纯本地判定（不打网络）：历史 missing 里凡是 4xx/过期类的，一次性归到 unavailable。
    let marked = 0;
    for (const entry of deps.stickerEntries) {
      if (!entry || entry.thumbStatus !== 'missing') continue;
      const kind = String(entry.thumbErrorKind || '').trim() || deps.stickerCachePure.describeThumbError(entry.thumbError);
      if (kind !== 'expired-url' && !thumbUnavailableKind(entry.thumbError) && !thumbUnavailableKind(entry.url)) continue;
      entry.thumbStatus = 'unavailable'; entry.thumbErrorKind = 'expired-url';
      entry.thumbError = String(entry.thumbError || '链接已失效，不再重试').slice(0, 200);
      entry.updatedAt = new Date().toISOString(); marked += 1;
    }
    if (marked) (0, deps.saveStickerStoreSafe)();
    if (marked) (0, deps.log)(`[sticker] 过期链接归为 unavailable：${marked} 条（不再重试）`);
    return marked;
  }
// @bridge-function markExpiredMissingUnavailable:end

// @bridge-function persistMissingStickerThumbs:start
async function persistMissingStickerThumbs({ limit = 20 } = {}) {
    // 自愈：先清孤儿/按 LRU 腾空间，否则缓存超限时新表情永远落不了盘。
    await cleanupStickerCache({});
    // 先把「链接已失效（HTTP 4xx）」的 missing 归到 unavailable，再按剩余候选补图。
    const markedUnavailable = markExpiredMissingUnavailable();
    const cap = Math.min(50, Math.max(1, Number(limit) || 20));
    const hasCached = (md5) => {
      const cached = (0, deps.stickerCachePath)(stickerCacheDirPath(), md5);
      return Boolean(cached && deps.fs.existsSync(cached));
    };
    const plan = deps.stickerCachePure.nextThumbRepairPlan({ entries: deps.stickerEntries, limit: cap, hasCached });
    const entryByKey = new Map();
    deps.stickerEntries.forEach((entry, index) => entryByKey.set(String(entry?.key ?? entry?.id ?? index), entry));
    let attempted = 0;
    let fixed = 0;
    let stillMissing = 0;
    for (const item of plan.items) {
      const entry = entryByKey.get(item.key);
      if (!entry) continue;
      attempted += 1;
      const result = await persistEntryThumb(entry);
      if (result?.status === 'ok' || result?.status === 'cached') fixed += 1;
      else if (result?.status === 'missing') stillMissing += 1;
    }
    // 补 dHash（纯本地、不联网）单独给一份预算：有本地图但缺指纹的历史条目就地补算，不必重新下载。
    let dhFilled = 0;
    const DH_CAP = 60;
    for (const entry of deps.stickerEntries) {
      if (dhFilled >= DH_CAP) break;
      if (!entry?.md5 || entry.dhash) continue;
      if (!hasCached(entry.md5)) continue;
      await persistEntryThumb(entry);
      dhFilled += 1;
    }
    if (attempted || dhFilled) (0, deps.saveStickerStoreSafe)();
    if (attempted) (0, deps.log)(`[sticker] 修复缩略图：尝试 ${attempted} 修好 ${fixed} 仍缺 ${stillMissing}`);
    if (dhFilled) (0, deps.log)(`[sticker] 已补齐 ${dhFilled} 条表情的视觉指纹（dHash）`);
    return { attempted, fixed, stillMissing, markedUnavailable, dhash: dhFilled, total: deps.stickerEntries.length };
  }
// @bridge-function persistMissingStickerThumbs:end

// @bridge-function collectObserveSticker:start
async function collectObserveSticker(sticker, plan) {
    const base = {
      source: `观察群 ${plan.groupId}`,
      collectedBy: plan.sender,
      context: String(plan.text || '').slice(0, 120)
    };
    // 1) 已知 md5 / 有 url：先入库（或找到已有条目），再**立即**下字节落盘。
    if (sticker.md5 || sticker.url) {
      const entry = (0, deps.collectSticker)(deps.stickerEntries, { ...base, md5: sticker.md5, url: sticker.url })
        || (0, deps.findSticker)(deps.stickerEntries, sticker.md5 || sticker.url);
      if (entry) {
        const saved = await persistEntryThumb(entry);
        if (saved?.status === 'ok' || saved?.status === 'missing' || entry.thumbStatus === 'unavailable') (0, deps.saveStickerStoreSafe)();
        if (saved?.status === 'ok') (0, deps.log)(`观察群表情已入库并落盘：群 ${plan.groupId} md5=${String(entry.md5).slice(0, 8)}（${Math.round((saved.bytes || 0) / 1024)}KB）`);
        if (saved?.status === 'missing') {
          const why = String(saved.error || entry.thumbError || '下载失败').slice(0, 80);
          (0, deps.log)(`[sticker] 观察表情立刻下载失败：${why}（${entry.thumbStatus === 'unavailable' ? '降级为 unavailable，不再重试' : '已标记 missing，稍后补'}）`);
        }
        return entry;
      }
    }
    // 2) 没有 url/md5（QQ 表情常见：image 段只有 file、face 段只有 id）：走网关拿字节。
    const media = {
      kind: sticker.type === 'face' ? 'face' : (sticker.type === 'mface' ? 'sticker' : 'image'),
      file: sticker.file,
      url: '',
      faceId: sticker.faceId,
      summary: sticker.summary,
      subType: ''
    };
    const fetched = sticker.type === 'face' ? await (0, deps.fetchFaceMedia)(media) : await (0, deps.fetchOneBotImage)(media);
    if (!fetched?.buffer) {
      (0, deps.log)(`观察群表情未捕获：段缺少 url 且 file 不可解析（群 ${plan.groupId}，type=${sticker.type || '-'}，file=${(sticker.file || '-').slice(0, 32)}）`);
      return null;
    }
    const md5 = (0, deps.md5Hex)(fetched.buffer);
    const cacheFile = (0, deps.stickerCachePath)(stickerCacheDirPath(), md5);
    let saved = false;
    if (stickerCacheTotal() < stickerCacheLimit()) {
      try {
        deps.fs.mkdirSync(stickerCacheDirPath(), { recursive: true });
        deps.fs.writeFileSync(cacheFile, fetched.buffer);
        deps.stickerCacheTotalCache = stickerCacheTotal() + fetched.buffer.length;
        saved = true;
      } catch (error) {
        (0, deps.log)(`观察群表情落盘失败：${error?.message ?? error}`);
      }
    }
    const entry = (0, deps.collectSticker)(deps.stickerEntries, { ...base, md5, url: sticker.url });
    if (entry) {
      entry.thumbStatus = saved ? 'ok' : 'missing';
      entry.thumbError = saved ? '' : '没有可下载的链接，网关取到图但落盘失败';
      (0, deps.log)(`观察群表情已入库：群 ${plan.groupId} md5=${md5.slice(0, 8)}（${(fetched.buffer.length / 1024).toFixed(0)}KB，${saved ? '已落盘' : '未落盘'}）`);
    }
    return entry;
  }
// @bridge-function collectObserveSticker:end

// @bridge-function observeLearnFromGroupMessage:start
async function observeLearnFromGroupMessage(event) {
    const plan = (0, deps.planObserveLearning)(event, deps.cfg.observe);
    if (!plan) return false; // 不在观察群：走原来的 handleIncoming
    logObserveStickerShapes(plan.groupId, event);
    // 学习动作全部通过注入的 hooks 执行：观察群**没有**任何发送分支。
    const applied = await (0, deps.applyObserveLearning)(plan, {
      feedSlang: (key, sender, text) => (0, deps.feedSlangWindow)(key, sender, text),
      collectSticker: (sticker, p) => collectObserveSticker(sticker, p),
      onStickersSaved: () => (0, deps.saveStickerStoreSafe)()
    });
    const learned = [];
    if (applied.slang) learned.push('词汇');
    if (applied.stickers > 0) learned.push(`表情 ${applied.stickers} 张`);
    noteObserveActivity(plan.groupId, learned.length ? learned.join('、') : '（本小时无新内容）');
    return true;
  }
// @bridge-function observeLearnFromGroupMessage:end
  return { noteObserveActivity, logObserveStickerShapes, stickerCacheDirPath, stickerCacheLimit, stickerCacheTotal, stickerCacheFileList, stickerCachePlan, cleanupStickerCache, persistEntryThumb, persistMissingStickerThumbs, markExpiredMissingUnavailable, collectObserveSticker, observeLearnFromGroupMessage };
}
