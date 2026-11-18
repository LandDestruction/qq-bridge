// console/file-library: extracted bridge responsibilities; no startup side effects.
// Live dependencies: ARCHIVE_EXCLUDED_KINDS, ARCHIVE_EXTENSIONS, ARCHIVE_IMAGE_EXTENSIONS, ARCHIVE_RULE_EXTENSIONS, DISK_RESERVE_BYTES, ROOT, STATE_DIR, activeModelOverride, archiveNextRunAt, archiveRowsToCsv, archiveStats, atomicWriteJson, boothCacheDir, boothConfig, boothDeps, buildLibraryItemDetail, buildLibraryItems, buildLibraryUnclassified, cfg, collectStorageStats, describeArchiveRules, describeObserveConfig, enrichArchiveItem, exportArchiveRows, fileArchiveDb, fileArchiveRootDir, fileListsFromRows, fileNotifyFromRows, filterArchiveRows, fs, getBoothCover, getBoothCoverPath, isArchiveFileName, listArchive, listAvailableModels, log, messageDb, mimeFromBuffer, modelSeesImages, modelSelectionEpoch, moveArchiveItemToCategory, normalizeArchiveRules, normalizeFileArchiveConfig, normalizeListParams, normalizeObserveConfig, normalizeReasoningEffort, normalizeThumbWidth, observeApiView, path, planCategoryMove, probeAvailableModels, readConfigObject, reloadConfigFromDisk, rowsNeedingEnrichment, runArchiveCleanupNow, safeResolveInside, scaleImageBuffer, setArchiveCategory, sortArchiveRows, visionModels
// 访客只读视图：`dir` 来自 config.json 的 fileArchive.dir，用户常配成绝对路径（如
// E:/qq-project/booth-inbox）——拿到访客链接的人不该看到本机目录结构。管理员照旧（面板要显示转存位置）。
// 放模块作用域是刻意的：handleConsoleFileLibrary 已到存量基线，不能再往里加行。
function guestStatsDir(dir, role) {
  return String(role || '') === 'guest' ? null : dir;
}

// 读盘失败的对外文本：规则与 src/library-fs-error.js 完全一致，但本模块是 vm 注入的 manifest
// 模块（不能静态 import），只能留一份本地实现。改这里要同步改那边——test-console-guest 有断言。
// 为什么不在 catch 里直接回 error.message：Node 的 ENOENT 会把本机绝对路径写进 API 响应
// （真机泄漏过 stat '<本机路径>\booth-inbox\…'），访客链接一分享就等于给了目录结构。
function fileLibScrubPaths(text) {
  return String(text ?? '')
    .replace(/[A-Za-z]:[\\/][^\s"'<>|]*/g, '<本机路径>')
    .replace(/\/(?:home|Users)\/[^\s"'<>|]*/g, '<本机路径>')
    .replace(/\bAppData\b[^\s"'<>|]*/gi, '<本机路径>');
}

function fileLibFsError(error, rel, role) {
  const code = String(error?.code ?? '').trim().toUpperCase();
  if (String(role || '') === 'guest') return code === 'ENOENT' ? '路径不存在' : '读取失败';
  const safeRel = String(rel ?? '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
  if (code === 'ENOENT') return safeRel ? `路径不存在：${safeRel}` : '路径不存在';
  const detail = fileLibScrubPaths(String(error?.message ?? error ?? '')).slice(0, 200);
  return detail ? `${code || '读取失败'}：${detail}` : '读取失败';
}

async function dispatchDshRoutes(deps, request) {
  if (request.req.method === 'GET' && request.url.pathname === '/api/dsh/models') {
    let models = [];
    let source = 'cache';
    try {
      models = await (0, deps.probeAvailableModels)();
      if (!models.length) { models = await (0, deps.probeAvailableModels)({ force: true }); source = 'probe'; }
    } catch (error) {
      (0, deps.log)(`读取可用模型清单失败（控制台下拉降级为空）：${error?.message ?? error}`);
      source = 'error';
    }
    const current = deps.activeModelOverride
      ? { provider: String(deps.activeModelOverride.provider || ''), model: String(deps.activeModelOverride.model || '') }
      : { provider: String(deps.cfg.dsh?.provider || ''), model: String(deps.cfg.dsh?.model || '') };
    request.sendJson({
      current,
      configured: { provider: String(deps.cfg.dsh?.provider || ''), model: String(deps.cfg.dsh?.model || '') },
      degraded: Boolean(deps.activeModelOverride),
      degradedSince: deps.activeModelOverride?.since ?? null,
      // 视觉能力用**探针实测出来的白名单**（scripts/probe-vision.mjs）判定，不猜 inputModalities：
      // DSH 的 catalog 根本不带能力字段，唯一能看图的是 deepseek-account/deepseek-flash。
      visionModels: (0, deps.visionModels)(),
      models: (0, deps.listAvailableModels)(models, 60).map((m) => ({
        ...m,
        seesImages: (0, deps.modelSeesImages)(m.provider, m.model, m)
      })),
      total: models.length,
      source
    });
    return true; /* @bridge-handled */
  }
  if (request.req.method === 'POST' && request.url.pathname === '/api/dsh/effort') {
    const body = await request.readBody();
    let effort;
    try { effort = (0, deps.normalizeReasoningEffort)(body.reasoningEffort); }
    catch (error) { request.sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return true; /* @bridge-handled */ }
    const configFile = deps.path.join(deps.ROOT, 'config.json');
    // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
    const file = (0, deps.readConfigObject)(configFile);
    file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
    (0, deps.atomicWriteJson)(configFile, file);
    deps.cfg.dsh = { ...(deps.cfg.dsh ?? {}), reasoningEffort: effort };
    // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
    deps.modelSelectionEpoch += 1;
    (0, deps.log)(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
    request.sendJson({ ok: true, reasoningEffort: effort });
    return true; /* @bridge-handled */
  }

  // 观察学习白名单（只读）：控制台/运维自查用。
  // 返回的是**归一化后**的值，与日志里 describeObserveConfig() 的口径一致。
  if (request.req.method === 'GET' && request.url.pathname === '/api/observe/config') {
    request.sendJson((0, deps.observeApiView)(deps.cfg.observe, { source: 'config.json' }));
    return true; /* @bridge-handled */
  }

  // 存储占用（只读）：state/ 各顶层项、messages.db 与 WAL、日志行数、磁盘剩余。
  // **严格只读**：不做 checkpoint、不 VACUUM、不删除。尤其 WAL 不做自动 checkpoint ——
  // 那会把「WAL 已经涨到主库 3 倍」这种信号掩盖掉，还要短暂持有写锁。
  if (request.req.method === 'GET' && request.url.pathname === '/api/storage/stats') {
    try {
      const stats = (0, deps.collectStorageStats)({
        stateDir: deps.STATE_DIR,
        db: (0, deps.messageDb)(),   // 打不开就返回 null，统计里相应字段给 null，不抛
        extraDirs: [deps.path.resolve(deps.ROOT)]
      });
      request.sendJson(stats);
    } catch (error) {
      (0, deps.log)(`存储统计失败（只读接口，不影响运行）：${error?.message ?? error}`);
      request.sendJson({ ok: false, error: request.consoleRole === 'guest' ? '存储统计失败' : `存储统计失败：${fileLibScrubPaths(error?.message ?? error)}` }, 500);
    }
    return true; /* @bridge-handled */
  }

  // ── 群文件转存台账（fileArchive） ───────────────────────────────────
  // 只读列表/汇总 + 两个显式动作（手动清理、人工覆盖分类）。前端（施工 B）只读这里的字段。
  return false;
}

async function dispatchFileArchiveListRoutes(deps, request) {
  if (request.req.method === 'GET' && request.url.pathname === '/api/files') {
    const db = (0, deps.fileArchiveDb)();
    if (!db) { request.sendJson({ ok: false, error: '消息库不可用，文件台账读不了' }, 503); return true; /* @bridge-handled */ }
    // limit 夹到 1..1000 且回显**实际**用的值；offset 负数/非数字按 0，越界返回空数组但回显请求值（前端据此判断越界）。
    const { limit, offset } = (0, deps.normalizeListParams)({
      limit: request.url.searchParams.get('limit'),
      offset: request.url.searchParams.get('offset')
    });
    const groupId = request.url.searchParams.get('group') || '';
    const includeDeleted = request.url.searchParams.get('deleted') === '1';
    // 前端不直连 BOOTH CDN（会过期/防盗链）：缩略图统一走桥接本地路由。
    const decorate = (row) => ({
      ...row,
      tags: row.boothTags ? String(row.boothTags).split('|').filter(Boolean) : [],
      thumbUrl: (row.thumbRel || /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(row.relPath || ''))) ? `/api/files/thumb?id=${row.id}` : '',
      metaUrl: row.metaRel ? `/api/files/meta?id=${row.id}` : '',
      // 商品展示图（BOOTH cover）：只有压缩包条目才有；图片条目不建商品条目（只带 boothId 供归属）。
      coverUrl: row.boothId && (0, deps.isArchiveFileName)(row.fileName) ? `/api/files/cover/${encodeURIComponent(row.boothId)}` : '',
      // 同号图片归属：图片条目带 boothId 时，库页面可把它挂到对应商品下。
      isArchive: (0, deps.isArchiveFileName)(row.fileName)
    });
    // 库管理器筛选：q/category/shop/status/uncategorized/sort（行级过滤，见 filterArchiveRows）。
    // 列表最多读 1000 行（缩略图/meta 也在这批行上做），避免为每个筛选组合写 SQL。
    const q = request.url.searchParams.get('q') || '';
    const category = request.url.searchParams.get('category') || '';
    const shop = request.url.searchParams.get('shop') || '';
    const status = request.url.searchParams.get('status') || '';
    const uncategorized = request.url.searchParams.get('uncategorized') === '1';
    const sort = request.url.searchParams.get('sort') || 'newest';
    const allRows = (0, deps.listArchive)(db, { groupId, limit: 1000, offset: 0, includeDeleted });
    const matched = (0, deps.sortArchiveRows)((0, deps.filterArchiveRows)(allRows, { q, category, shop, status, uncategorized }), sort);
    request.sendJson({
      ok: true,
      files: matched.slice(offset, offset + limit).map(decorate),
      total: matched.length,
      offset,
      limit
    });
    return true; /* @bridge-handled */
  }
  // ── Library（以 BOOTH 商品为单位的卡片库）────────────────────────────
  if (request.req.method === 'GET' && request.url.pathname === '/api/library/items') {
    const db = (0, deps.fileArchiveDb)();
    if (!db) { request.sendJson({ ok: false, error: '消息库不可用' }, 503); return true; /* @bridge-handled */ }
    const items = (0, deps.buildLibraryItems)((0, deps.listArchive)(db, { limit: 1000 }));
    request.sendJson({ ok: true, total: items.length, items });
    return true; /* @bridge-handled */
  }
  if (request.req.method === 'GET' && request.url.pathname.startsWith('/api/library/item/')) {
    const db = (0, deps.fileArchiveDb)();
    if (!db) { request.sendJson({ ok: false, error: '消息库不可用' }, 503); return true; /* @bridge-handled */ }
    const boothId = decodeURIComponent(request.url.pathname.slice('/api/library/item/'.length));
    if (!/^\d{4,12}$/.test(boothId)) { request.sendJson({ ok: false, error: 'boothId 非法' }, 400); return true; /* @bridge-handled */ }
    const rows = (0, deps.listArchive)(db, { limit: 1000 });
    const detail = (0, deps.buildLibraryItemDetail)(rows, boothId);
    if (!detail) { request.sendJson({ ok: false, error: '未找到该商品' }, 404); return true; /* @bridge-handled */ }
    let meta = null;
    const anyRow = rows.find((r) => String(r.boothId) === boothId && r.metaRel);
    try { if (anyRow) meta = JSON.parse(deps.fs.readFileSync((0, deps.safeResolveInside)((0, deps.fileArchiveRootDir)(), anyRow.metaRel), 'utf8')); } catch {}
    request.sendJson({ ok: true, item: { ...detail, meta } });
    return true; /* @bridge-handled */
  }
  if (request.req.method === 'GET' && request.url.pathname === '/api/library/unclassified') {
    const db = (0, deps.fileArchiveDb)();
    if (!db) { request.sendJson({ ok: false, error: '消息库不可用' }, 503); return true; /* @bridge-handled */ }
    request.sendJson({ ok: true, ...(0, deps.buildLibraryUnclassified)((0, deps.listArchive)(db, { limit: 1000 })) });
    return true; /* @bridge-handled */
  }
  if (request.req.method === 'GET' && request.url.pathname === '/api/library/item-thumb') {
    const boothId = String(request.url.searchParams.get('boothId') || '').trim();
    if (!/^\d{4,12}$/.test(boothId)) { request.sendJson({ ok: false, error: 'boothId 非法' }, 400); return true; /* @bridge-handled */ }
    const cacheRoot = deps.path.join(deps.ROOT, String(deps.cfg.socialV2?.archive?.cacheDir || 'state/booth-cache'));
    const file = (0, deps.safeResolveInside)(cacheRoot, deps.path.join(boothId, 'cover.jpg'));
    try {
      const buf = deps.fs.readFileSync(file);
      request.res.writeHead(200, { ...request.SECURITY_HEADERS, 'content-type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }); // 先在展开之后覆盖 Cache-Control：SECURITY_HEADERS 带 no-store，小写键写在展开前会被顶掉
      request.res.end(buf);
      return true; /* @bridge-handled */
    } catch { request.sendJson({ ok: false, error: '没有商品封面（待抓取或抓取失败）' }, 404); return true; /* @bridge-handled */ }
  }
  if (request.req.method === 'GET' && request.url.pathname === '/api/files/lists') {
    const db = (0, deps.fileArchiveDb)();
    if (!db) { request.sendJson({ ok: false, error: '消息库不可用' }, 503); return true; /* @bridge-handled */ }
    request.sendJson({ ok: true, ...(0, deps.fileListsFromRows)((0, deps.listArchive)(db, { limit: 1000 })) });
    return true; /* @bridge-handled */
  }
  if (request.req.method === 'GET' && request.url.pathname === '/api/files/notify') {
    const db = (0, deps.fileArchiveDb)();
    if (!db) { request.sendJson({ ok: false, error: '消息库不可用' }, 503); return true; /* @bridge-handled */ }
    request.sendJson({ ok: true, ...(0, deps.fileNotifyFromRows)((0, deps.listArchive)(db, { limit: 1000 })) });
    return true; /* @bridge-handled */
  }
  if (request.req.method === 'GET' && request.url.pathname === '/api/files/item') {
    const db = (0, deps.fileArchiveDb)();
    if (!db) { request.sendJson({ ok: false, error: '消息库不可用' }, 503); return true; /* @bridge-handled */ }
    const id = Number(request.url.searchParams.get('id'));
    const row = Number.isInteger(id) ? (0, deps.listArchive)(db, { limit: 1000 }).find((r) => r.id === id) : null;
    if (!row) { request.sendJson({ ok: false, error: '未找到该记录' }, 404); return true; /* @bridge-handled */ }
    let meta = null;
    try { if (row.metaRel) meta = JSON.parse(deps.fs.readFileSync((0, deps.safeResolveInside)((0, deps.fileArchiveRootDir)(), row.metaRel), 'utf8')); } catch {}
    request.sendJson({ ok: true, item: { ...row, meta, boothUrl: row.boothId ? `https://booth.pm/zh-cn/items/${row.boothId}` : null } });
    return true; /* @bridge-handled */
  }
  if (request.req.method === 'GET' && request.url.pathname === '/api/files/thumb') {
    const db = (0, deps.fileArchiveDb)();
    if (!db) { request.sendJson({ ok: false, error: '消息库不可用' }, 503); return true; /* @bridge-handled */ }
    const id = Number(request.url.searchParams.get('id'));
    const row = Number.isInteger(id) ? (0, deps.listArchive)(db, { limit: 1000 }).find((r) => r.id === id) : null;
    // 普通图片在 BOOTH 归类前就进库了，没有 thumbRel —— 直接把原图当缩略图回，
    // 否则库页面上「图片」类条目全是空白（实测 ?id=11 一直 404）。
    const relForThumb = row?.thumbRel || (row?.relPath && /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(row.relPath)) ? row.relPath : '');
    if (!relForThumb) { request.sendJson({ ok: false, error: '没有缩略图' }, 404); return true; /* @bridge-handled */ }
    try {
      const abs = (0, deps.safeResolveInside)((0, deps.fileArchiveRootDir)(), relForThumb);
      const buf = deps.fs.readFileSync(abs);
      // ?w=480 → 服务端缩放（卡片页不用拉几 MB 原图）；ffmpeg 不可用/失败就回原图。
      const w = (0, deps.normalizeThumbWidth)(request.url.searchParams.get('w'));
      const scaled = w ? await (0, deps.scaleImageBuffer)(buf, w, { timeoutMs: 5000 }) : null;
      const out = scaled || buf;
      request.res.writeHead(200, {
        'content-type': (0, deps.mimeFromBuffer)(out) || 'image/jpeg',
        'cache-control': 'public, max-age=86400',
        'x-thumb-scaled': scaled ? String(w) : '0',
        ...request.SECURITY_HEADERS
      });
      request.res.end(out);
      return true; /* @bridge-handled */
    } catch (error) {
      request.sendJson({ ok: false, error: fileLibFsError(error, relForThumb, request.consoleRole) }, 404);
      return true; /* @bridge-handled */
    }
  }
  // BOOTH 元数据重抓（历史没抓到的 / 失败重试 / 单个指定）。
  if (request.req.method === 'GET' && request.url.pathname === '/api/files/meta') {
    const db = (0, deps.fileArchiveDb)();
    if (!db) { request.sendJson({ ok: false, error: '消息库不可用' }, 503); return true; /* @bridge-handled */ }
    const id = Number(request.url.searchParams.get('id'));
    const row = Number.isInteger(id) ? (0, deps.listArchive)(db, { limit: 1000 }).find((r) => r.id === id) : null;
    if (!row?.metaRel) { request.sendJson({ ok: false, error: '没有 meta.json' }, 404); return true; /* @bridge-handled */ }
    try {
      const abs = (0, deps.safeResolveInside)((0, deps.fileArchiveRootDir)(), row.metaRel);
      request.sendJson({ ok: true, meta: JSON.parse(deps.fs.readFileSync(abs, 'utf8')) });
    } catch (error) {
      request.sendJson({ ok: false, error: fileLibFsError(error, row.metaRel, request.consoleRole) }, 404);
    }
    return true; /* @bridge-handled */
  }
  return false;
}

async function dispatchFileArchiveActionRoutes(deps, request) {
  if (request.req.method === 'POST' && request.url.pathname === '/api/files/enrich') {
    const db = (0, deps.fileArchiveDb)();
    if (!db) { request.sendJson({ ok: false, error: '消息库不可用' }, 503); return true; /* @bridge-handled */ }
    if (!(0, deps.boothConfig)().enabled) { request.sendJson({ ok: false, error: 'BOOTH 归类已关闭（fileArchive.booth.enabled）' }, 409); return true; /* @bridge-handled */ }
    const body = await request.readBody();
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200) : [];
    const limit = Math.min(200, Math.max(1, Number(body.limit) || 20));
    const all = body.all === true;
    // 三种语义：ids 指定若干条；all=true 全量重抓（上限 500，防一次请求打爆）；
    // 默认只处理「还没成功抓过/失败超过 1 天」的。
    let targets = ids;
    if (!targets.length && all) {
      targets = (0, deps.listArchive)(db, { limit: 500 }).map((row) => row.id);
    }
    if (!targets.length) targets = (0, deps.rowsNeedingEnrichment)(db, { limit }).map((row) => row.id);
    const results = [];
    for (const id of targets) {
      results.push(await (0, deps.enrichArchiveItem)({
        db,
        rootDir: (0, deps.fileArchiveRootDir)(),
        id,
        cfg: deps.cfg.fileArchive,
        deps: (0, deps.boothDeps)()
      }));
    }
    request.sendJson({ ok: true, results, count: results.length });
    return true; /* @bridge-handled */
  }
  // BOOTH 商品展示图（cover）：本地缓存优先；没有就现场抓一次（30 天缓存）。
  // A 的 /api/library/item-thumb 可以直接用这个 URL，或 import getBoothCover()。
  if (request.req.method === 'GET' && request.url.pathname.startsWith('/api/files/cover/')) {
    const boothId = decodeURIComponent(request.url.pathname.slice('/api/files/cover/'.length)).trim();
    if (!/^\d{5,9}$/.test(boothId)) { request.sendJson({ ok: false, error: 'BOOTH 号必须是 5~9 位数字' }, 400); return true; /* @bridge-handled */ }
    let coverPath = (0, deps.getBoothCoverPath)(boothId, { cacheRoot: (0, deps.boothCacheDir)() });
    if (!coverPath) {
      const cover = await (0, deps.getBoothCover)(boothId, {
        cacheRoot: (0, deps.boothCacheDir)(),
        log: (message) => (0, deps.log)(message)
      });
      if (!cover.ok) {
        request.sendJson({ ok: false, status: cover.status, error: cover.coverError || cover.error || '展示图不可用' }, 404);
        return true; /* @bridge-handled */
      }
      coverPath = cover.path;
    }
    try {
      const buf = deps.fs.readFileSync(coverPath);
      request.res.writeHead(200, {
        'content-type': 'image/jpeg',
        'cache-control': 'public, max-age=86400',
        ...request.SECURITY_HEADERS
      });
      request.res.end(buf);
    } catch (error) {
      request.sendJson({ ok: false, error: fileLibFsError(error, `booth-cache/${boothId}/cover.jpg`, request.consoleRole) }, 500);
    }
    return true; /* @bridge-handled */
  }
  // 同一 BOOTH 号下的所有文件。
  if (request.req.method === 'GET' && request.url.pathname.startsWith('/api/files/booth/')) {
    const db = (0, deps.fileArchiveDb)();
    if (!db) { request.sendJson({ ok: false, error: '消息库不可用' }, 503); return true; /* @bridge-handled */ }
    const boothId = decodeURIComponent(request.url.pathname.slice('/api/files/booth/'.length)).trim();
    if (!/^\d{5,9}$/.test(boothId)) { request.sendJson({ ok: false, error: 'BOOTH 号必须是 5~9 位数字' }, 400); return true; /* @bridge-handled */ }
    const rows = (0, deps.listArchive)(db, { limit: 1000 }).filter((row) => row.boothId === boothId);
    request.sendJson({ ok: true, boothId, files: rows, count: rows.length });
    return true; /* @bridge-handled */
  }
  // 导出（konoasset 风格外部索引）。
  if (request.req.method === 'GET' && request.url.pathname === '/api/files/export') {
    const db = (0, deps.fileArchiveDb)();
    if (!db) { request.sendJson({ ok: false, error: '消息库不可用' }, 503); return true; /* @bridge-handled */ }
    const format = String(request.url.searchParams.get('format') || 'json').toLowerCase();
    const groupId = request.url.searchParams.get('group') || '';
    const rows = (0, deps.exportArchiveRows)(db, { groupId });
    if (format === 'csv') {
      const csv = (0, deps.archiveRowsToCsv)(rows);
      request.res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="file-archive.csv"', ...request.SECURITY_HEADERS });
      request.res.end(csv);
      return true; /* @bridge-handled */
    }
    request.sendJson({ ok: true, exportedAt: new Date().toISOString(), count: rows.length, files: rows });
    return true; /* @bridge-handled */
  }
  if (request.req.method === 'GET' && request.url.pathname === '/api/observe/config') {
    // 观察学习白名单的只读配置：控制台要显示「开关 / 观察群」，之前 cfg.observe 只在内部用、
    // 一个接口都没暴露，前端只能显示「未知」。这里只读，不给写（改配置走 config.json + 重启）。
    const observe = (0, deps.normalizeObserveConfig)(deps.cfg.observe);
    request.sendJson({
      ok: true,
      enabled: observe.enabled,
      groups: observe.groups,
      learnSlang: observe.learnSlang,
      learnStickers: observe.learnStickers,
      description: (0, deps.describeObserveConfig)(observe)
    });
    return true; /* @bridge-handled */
  }
  if (request.req.method === 'GET' && request.url.pathname === '/api/files/stats') {
    const db = (0, deps.fileArchiveDb)();
    if (!db) { request.sendJson({ ok: false, error: '消息库不可用，文件台账读不了' }, 503); return true; /* @bridge-handled */ }
    const stats = (0, deps.archiveStats)(db, { nowMs: Date.now(), retention: deps.cfg.fileArchive?.retention });
    const maxFileMb = Number(deps.cfg.fileArchive?.maxFileMb) || 200;
    const maxFileBytes = maxFileMb * 1024 * 1024;
    // 磁盘余量（只读）：statfs 不可用时给 null，别让面板整个 500。
    let disk = null;
    try {
      // 转存目录可能还没建出来（一个文件都没存过时 state/files 不存在），
      // 那时 statfs 会 ENOENT —— 沿着祖先往上找第一个存在的目录，别让面板显示「未知」。
      let probeDir = (0, deps.fileArchiveRootDir)();
      for (let i = 0; i < 6 && !deps.fs.existsSync(probeDir); i += 1) probeDir = deps.path.dirname(probeDir);
      const st = deps.fs.statfsSync(probeDir);
      const totalBytes = Number(st.blocks) * Number(st.bsize);
      const freeBytes = Number(st.bavail) * Number(st.bsize);
      disk = {
        freeBytes,
        totalBytes,
        guardReserveBytes: deps.DISK_RESERVE_BYTES,
        fitsMaxFile: freeBytes - deps.DISK_RESERVE_BYTES >= maxFileBytes
      };
    } catch (error) {
      (0, deps.log)(`文件统计：读取磁盘余量失败（${error?.message ?? error}）`);
    }
    request.sendJson({
      ...stats,
      enabled: deps.cfg.fileArchive?.enabled === true,
      groups: deps.cfg.fileArchive?.groups ?? [],
      dir: guestStatsDir(deps.cfg.fileArchive?.dir ?? 'state/files', request.consoleRole),
      maxFileMb,
      disk,
      // 转存口径：值与白名单常量同源（不复制字面量，避免两处漂移）。
      accept: {
        maxFileMb,
        extensions: deps.ARCHIVE_EXTENSIONS,
        imageExtensions: deps.ARCHIVE_IMAGE_EXTENSIONS,
        excludes: deps.ARCHIVE_EXCLUDED_KINDS
      },
      nextCleanupAt: (0, deps.archiveNextRunAt)(Date.now())
    });
    return true; /* @bridge-handled */
  }
  if (request.req.method === 'POST' && request.url.pathname === '/api/files/cleanup') {
    // dryRun=只预览不删（用户要「先预览再执行」）；body 缺省/非 true 保持老语义=真删，ops.html 老调用不受影响。
    const result = await (0, deps.runArchiveCleanupNow)('控制台手动', { dryRun: (await request.readBody())?.dryRun === true });
    if (!result) { request.sendJson({ ok: false, error: '消息库不可用，无法清理' }, 503); return true; /* @bridge-handled */ }
    request.sendJson({ ok: true, ...result });
    return true; /* @bridge-handled */
  }
  if (request.req.method === 'POST' && request.url.pathname === '/api/files/category') {
    const body = await request.readBody();
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) { request.sendJson({ ok: false, error: 'id 必须是正整数' }, 400); return true; /* @bridge-handled */ }
    if (typeof body.category !== 'string') { request.sendJson({ ok: false, error: 'category 必须是字符串（空串=未分类）' }, 400); return true; /* @bridge-handled */ }
    // 有 booth_id 的条目：目录名里带分类段，改分类要同步移动目录（失败回滚台账）。
    {
      const db = (0, deps.fileArchiveDb)();
      const row = db ? (0, deps.listArchive)(db, { limit: 1000 }).find((r) => r.id === id) : null;
      const plan = row ? (0, deps.planCategoryMove)({ row, newCategory: String(body.category) }) : null;
      if (plan && !plan.ok) { request.sendJson({ ok: false, error: `无法规划目录移动：${plan.reason}` }, 400); return true; /* @bridge-handled */ }
      if (plan && !plan.simple) {
        const root = (0, deps.fileArchiveRootDir)();
        const oldAbs = (0, deps.safeResolveInside)(root, String(row.relPath).split('/').slice(0, 2).join('/'));
        const newAbs = (0, deps.safeResolveInside)(root, plan.newDirRel);
        try {
          deps.fs.mkdirSync(deps.path.dirname(newAbs), { recursive: true });
          deps.fs.renameSync(oldAbs, newAbs);
          db.prepare('UPDATE file_archive SET rel_path = ?, thumb_rel = ?, meta_rel = ? WHERE id = ?')
            .run(plan.newRel, plan.newThumbRel || '', plan.newMetaRel || '', id);
        } catch (error) {
          try { if (deps.fs.existsSync(newAbs) && !deps.fs.existsSync(oldAbs)) deps.fs.renameSync(newAbs, oldAbs); } catch {}
          request.sendJson({ ok: false, error: `目录移动失败，已回滚：${error?.message ?? error}` }, 500);
          return true; /* @bridge-handled */
        }
      }
    }
    const db = (0, deps.fileArchiveDb)();
    if (!db) { request.sendJson({ ok: false, error: '消息库不可用' }, 503); return true; /* @bridge-handled */ }
    try {
      // 人工分类要**真的移动文件**（未分类工作流）：连同 meta.json/缩略图一起进分类目录；
      // 移动失败（比如文件已被手工挪走）退化为只改台账，并给出 moved=false 的提示。
      let rec;
      let moved = false;
      try {
        rec = (0, deps.moveArchiveItemToCategory)({
          db,
          rootDir: (0, deps.fileArchiveRootDir)(),
          id,
          category: body.category,
          nowMs: Date.now(),
          retention: deps.cfg.fileArchive?.retention
        });
        moved = rec.moved === true;
      } catch (moveError) {
        (0, deps.log)(`控制台：文件 #${id} 移动失败，仅更新分类：${moveError?.message ?? moveError}`);
        rec = (0, deps.setArchiveCategory)(db, {
          id,
          category: body.category,
          source: 'manual',
          nowMs: Date.now(),
          retention: deps.cfg.fileArchive?.retention
        });
      }
      (0, deps.log)(`控制台：文件 #${id} 分类改为「${rec.category || '未分类'}」${moved ? '（已移动）' : '（未移动）'}（清理时间 ${new Date(rec.cleanupAt).toLocaleString('zh-CN', { hour12: false })}）`);
      request.sendJson({ ok: true, ...rec, moved });
    } catch (error) {
      request.sendJson({ ok: false, error: error?.message ?? String(error) }, 404);
    }
    return true; /* @bridge-handled */
  }
  return false;
}

export function createConsoleFileLibrary(deps) {
// @bridge-function handleConsoleFileLibrary:start
async function handleConsoleFileLibrary(request) {
        if (await viewOf(deps).handleLibraryFoldersRoute(request)) return true; /* @bridge-handled */
        if (await viewOf(deps).handleLibraryAssetsRoute(request)) return true; /* @bridge-handled */
        if (await dispatchDshRoutes(deps, request)) return true; /* @bridge-handled */
        if (await dispatchFileArchiveListRoutes(deps, request)) return true; /* @bridge-handled */
        if (await dispatchFileArchiveActionRoutes(deps, request)) return true; /* @bridge-handled */
    return (await handleArchiveRulesRoute(request, deps)) || false;
  }

// @bridge-function handleConsoleFileLibrary:end
  return { handleConsoleFileLibrary };
}

// ── 文件库「转存口径」配置接口（GET 读 / POST 写） ────────────────────────────
//
// 为什么写在 createConsoleFileLibrary 外面：这个工厂和 handleConsoleFileLibrary 的行数
// 被 scripts/code-size-baseline.json 冻结（只允许变小），新增路由放进模块作用域就不会
// 顶破那个预算；请求分派仍走控制台既有的 handleConsoleFileLibrary 兜底出口。


// 「看」这一半的路由在 library-view.js；工厂由 deps 注入（桥接侧的模块不允许静态 import，
// 见 scripts/bridge-source.mjs 会把 ^export 剥进 vm）。这里只做一次懒建 + 复用。
function viewOf(deps) {
  if (!deps.createLibraryView) throw new Error('文件库视图没有注入 createLibraryView');
  if (!viewCache || viewCache.deps !== deps) viewCache = { deps, view: deps.createLibraryView(deps) };
  return viewCache.view;
}
let viewCache = null;

function configWritable(configFile, fs) {
  try {
    fs.accessSync(configFile, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function backupConfigFile(configFile, deps) {
  // 备份是给手滑用户的后悔药：只保留最近 5 份，攒多了白占磁盘。
  // 备份失败不该挡住保存，所以整体 try 住、只留一条日志。
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    deps.fs.copyFileSync(configFile, `${configFile}.bak-${stamp}`);
    const dir = deps.path.dirname(configFile);
    const prefix = `${deps.path.basename(configFile)}.bak-`;
    const olds = deps.fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).sort();
    for (const name of olds.slice(0, Math.max(0, olds.length - 5))) {
      try { deps.fs.unlinkSync(deps.path.join(dir, name)); } catch {}
    }
  } catch (error) {
    (0, deps.log)(`控制台：config.json 备份失败（不影响写入口径）：${error?.message ?? error}`);
  }
}

// ── 文件库「在电脑上的文件夹」：列出转存目录里的真实文件夹，点一下用资源管理器打开 ──
// 只读列目录 + 一个显式动作（打开资源管理器）。路径一律过 safeResolveInside，
// 只允许 root 之内的目录；agent 侧（x-agent-token）不允许调用。
async function handleArchiveRulesRoute(request, deps) {
  if (request.url.pathname !== '/api/file-library/archive-rules') return false;
  const configFile = deps.path.join(deps.ROOT, 'config.json');
  // catalog 让前端不用自己维护扩展名清单：图片/压缩包来自转存白名单的单一事实来源。
  const catalog = {
    images: [...deps.ARCHIVE_IMAGE_EXTENSIONS],
    archives: [...deps.ARCHIVE_EXTENSIONS],
    all: [...deps.ARCHIVE_RULE_EXTENSIONS]
  };
  const writable = configWritable(configFile, deps.fs);
  if (request.req.method === 'GET') {
    const rules = deps.cfg.fileArchive?.rules;
    request.sendJson({ ok: true, writable, rules, catalog, describe: (0, deps.describeArchiveRules)(rules) });
    return true;
  }
  if (request.req.method !== 'POST') {
    request.sendJson({ ok: false, error: '该接口只支持 GET/POST' }, 405);
    return true;
  }
  if (!writable) {
    // 409 而不是 400：配置本身没问题，是文件系统不让写（例如只读挂载），前端要能分开提示。
    request.sendJson({ ok: false, error: 'config.json 当前不可写，无法保存转存口径' }, 409);
    return true;
  }
  let body;
  try { body = await request.readBody(); }
  catch (error) { request.sendJson({ ok: false, error: error?.message ?? '请求体非法' }, Number(error?.statusCode) || 400); return true; }
  if (!body.rules || typeof body.rules !== 'object' || Array.isArray(body.rules)) {
    request.sendJson({ ok: false, error: '请求体需要形如 { rules: {...} } 的对象' }, 400);
    return true;
  }
  try {
    const nextRules = (0, deps.normalizeArchiveRules)(body.rules);
    // 没填 maxMb 时沿用当前口径（它缺省跟随老 maxFileMb），别把用户的「按老上限」悄悄改成默认 2560。
    if (!Object.hasOwn(body.rules, 'maxMb')) nextRules.maxMb = deps.cfg.fileArchive?.rules?.maxMb ?? nextRules.maxMb;
    backupConfigFile(configFile, deps);
    // 自己读盘 + JSON.parse 而不是用 readConfigObject：后者解析失败返回 {}，
    // 拿 {} 回写会把用户整份 config.json 抹掉——宁可 500 也不能静默丢配置。
    const raw = deps.fs.readFileSync(configFile, 'utf8').replace(/^﻿/, '');
    const file = JSON.parse(raw);
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('config.json 顶层不是对象');
    const current = file.fileArchive && typeof file.fileArchive === 'object' && !Array.isArray(file.fileArchive) ? file.fileArchive : {};
    // 只覆盖 rules 一段：其它 fileArchive 字段（白名单群、目录、保留期…）原样保留。
    file.fileArchive = { ...current, rules: nextRules };
    (0, deps.atomicWriteJson)(configFile, file);
    // 写盘后必须热加载：否则运行时还在用旧口径，用户会以为没保存成功。
    // 热加载失败/不可用时退回「直接按新文件重算这一段」——盘上已经是新值，不能让请求失败
    // 又让运行时用旧口径，那才是真的不一致。
    let reloaded = false;
    if (typeof deps.reloadConfigFromDisk === 'function') {
      try { reloaded = (await deps.reloadConfigFromDisk('console-file-library'))?.ok !== false; }
      catch (error) { (0, deps.log)(`控制台：转存口径已写盘但热加载失败（改用直接生效）：${error?.message ?? error}`); }
    }
    if (!reloaded) deps.cfg.fileArchive = (0, deps.normalizeFileArchiveConfig)(file.fileArchive);
    const saved = deps.cfg.fileArchive?.rules ?? nextRules;
    const describe = (0, deps.describeArchiveRules)(saved);
    (0, deps.log)(`控制台：文件库转存口径已保存（${describe}）`);
    request.sendJson({ ok: true, rules: saved, describe });
  } catch (error) {
    request.sendJson({ ok: false, error: `保存转存口径失败：${error?.message ?? error}` }, 500);
  }
  return true;
}
