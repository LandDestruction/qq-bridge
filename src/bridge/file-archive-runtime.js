// file-archive-runtime: extracted bridge responsibilities; no startup side effects.
// Live dependencies: ARCHIVE_CLASSIFY_SESSION_FILE, AbortSignal, MESSAGE_DB_FILE, ROOT, SIMPLE_BOOTH_RE, STATE_DIR, allocateArchiveTarget, api, archiveCfgFor, archiveClassifySessionId, archiveCleanupTimer, archiveDirRel, atomicWriteJson, cfg, checkDiskSpace, describeArchiveSkip, describeDiskVerdict, dshReady, enrichArchiveItem, ensureChatModel, fetch, fetchBoothMeta, fileArchiveDb, formatArchiveBytes, formatCleanupLog, fs, getBoothCover, isArchiveGroup, lastArchiveCleanupDay, learnerSessions, log, logArchiveSkip, matchArchiveRules, messageDbHandle, normalizeBoothConfig, normalizeThumbnailFile, parseClassifyReply, path, readJsonSafe, resolveArchiveRoot, runArchiveCleanup, safeFetchBinary, safeFetchToFile, setArchiveCategory, setInterval, setTimeout, shouldArchiveAttachment, simpleArchiveDir, storeDownloadedFile, unwrap, waitLearnerTurn
// 转存口径判定只需要 deps 和入参，放工厂外既不占 createFileArchiveRuntime 的行数预算，也能直接单测。
function archiveGateReasonFor(deps, { kind = '', segType = '', fileName = '', bytes, senderId = '' } = {}) {
  const name = String(fileName || '');
  const imageSeg = String(segType || '') === 'image' || String(kind || '') === 'image';
  const simpleMode = deps.cfg.fileArchive?.simpleMode === true;
  if (simpleMode && !deps.SIMPLE_BOOTH_RE.test(name)) return { ok: false, reason: '文件名不是 7 位 BOOTH 号开头（simpleMode 只收这类）' };
  if (!(0, deps.shouldArchiveAttachment)({ kind, segType: simpleMode ? (segType || 'file') : segType, fileName: name })) {
    // 表情包/表情标记/未知段类型都由 shouldArchiveAttachment 兜住，这里只转述结论。
    return { ok: false, reason: (0, deps.describeArchiveSkip)({ fileName: name }) };
  }
  // 图片段经常没有文件名（QQ 的 media.name 为空），落盘时我们统一按 png 处理；
  // 若原样拿空名字去查扩展名白名单，默认口径会把所有无名图片误判成「不在白名单」。
  const ruleName = imageSeg && !/\.[a-z0-9]+$/i.test(name) ? '图片.png' : name;
  return (0, deps.matchArchiveRules)(deps.cfg.fileArchive?.rules, { fileName: ruleName, bytes, senderId });
}

// 每小时上限是唯一需要查台账的条件（纯函数判不了）：按本群最近 1 小时仍有效的转存记录计数。
// deleted_at IS NULL 表示还没被清理/删除；已删除的不占额度，否则清理过的额度会一直被占着。
function perHourLimitReached(deps, db, groupId) {
  const perHourMax = Math.max(0, Number(deps.cfg.fileArchive?.rules?.perHourMax) || 0);
  if (!(perHourMax > 0)) return 0;
  const since = Date.now() - 60 * 60 * 1000;
  const recent = Number(db.prepare('SELECT COUNT(*) AS n FROM file_archive WHERE group_id = ? AND deleted_at IS NULL AND archived_at >= ?').get(groupId, since)?.n) || 0;
  return recent >= perHourMax ? perHourMax : 0;
}

// @bridge-function fileArchiveRootDir:start
function fileArchiveRootDir(deps) {
    return (0, deps.resolveArchiveRoot)(deps.ROOT, deps.cfg.fileArchive?.dir);
  }
// @bridge-function fileArchiveRootDir:end

// @bridge-function fileArchiveDeps:start
function fileArchiveDeps(deps, id, event) {
    return {
      db: (0, deps.fileArchiveDb)(),
      rootDir: fileArchiveRootDir(deps),
      // 2.5G 上限下必须流式落盘：safeFetchBinary 会把整个正文读进内存（会 OOM），
      // 这里给 downloadToFile，模块会直接写进目标临时文件（边下边写边算 sha256）。
      downloadToFile: (url, tmpPath, maxBytes) => (0, deps.safeFetchToFile)(url, tmpPath, { maxBytes, timeoutMs: 120000 }),
      download: (url, maxBytes) => (0, deps.safeFetchBinary)(url, maxBytes),
      getFileUrl: async (fileId, busid) => {
        const data = await oneBotAction(deps, 'get_group_file_url', { group_id: Number(id), file_id: fileId, busid });
        return data?.url ?? '';
      },
      nowMs: Date.now(),
      messageId: String(event?.message_id ?? event?.msg_id ?? ''),
      uploader: String(event?.user_id ?? ''),
      uploadedAt: Number(event?.time) ? Number(event.time) * 1000 : 0,
      log: (message) => (0, deps.log)(message),
      logSkip: (name, reason) => (0, deps.logArchiveSkip)(`group:${id}`, name, reason),
      // BOOTH 归类开启时，先落到「未分类」，再由 enrichArchiveItem 抓到商品信息后挪进分类目录。
      baseDirRel: boothConfig(deps).enabled ? (0, deps.archiveDirRel)({ groupId: id }) : ''
    };
  }
// @bridge-function fileArchiveDeps:end

// @bridge-function boothConfig:start
function boothConfig(deps) {
    return deps.cfg.fileArchive?.booth ?? (0, deps.normalizeBoothConfig)({});
  }
// @bridge-function boothConfig:end

// @bridge-function boothCacheDir:start
function boothCacheDir(deps) {
    return deps.path.resolve(deps.ROOT, boothConfig(deps).cacheDir);
  }
// @bridge-function boothCacheDir:end

// @bridge-function boothDeps:start
function boothDeps(deps) {
    return {
      fetchBoothMeta: (boothId) => (0, deps.fetchBoothMeta)(boothId, {
        cfg: boothConfig(deps),
        cacheDir: boothCacheDir(deps),
        log: (message) => (0, deps.log)(message)
      }),
      downloadThumb: async (url, destAbs, maxBytes) => {
        // 两段式：先原图下到 .src，再 ffmpeg 缩成「长边 ≤512 的 JPEG」写到目标；
        // ffmpeg 失败时 normalizeThumbnailFile 会把原图复制过去并返回 fallback，
        // 这样卡片至少有图可显示（同时 thumbStatus 记 fallback，面板可提示）。
        const rawPath = `${destAbs}.src`;
        try {
          const fetched = await (0, deps.safeFetchToFile)(url, rawPath, { maxBytes, timeoutMs: boothConfig(deps).timeoutMs });
          if (fetched.truncated) {
            try { deps.fs.rmSync(rawPath, { force: true }); } catch {}
            return { ok: false, status: 'missing', error: '缩略图超过大小上限' };
          }
          const normalized = (0, deps.normalizeThumbnailFile)({ srcPath: rawPath, destPath: destAbs, maxEdge: 512 });
          try { deps.fs.rmSync(rawPath, { force: true }); } catch {}
          if (!normalized.ok) {
            (0, deps.log)(`BOOTH 缩略图规格化失败：${normalized.error}`);
            return { ok: false, status: 'missing', error: normalized.error };
          }
          return {
            ok: true,
            status: normalized.mode === 'resized' ? 'ok' : 'fallback',
            bytes: normalized.bytes,
            mode: normalized.mode
          };
        } catch (error) {
          try { deps.fs.rmSync(rawPath, { force: true }); } catch {}
          try { deps.fs.rmSync(destAbs, { force: true }); } catch {}
          (0, deps.log)(`BOOTH 缩略图下载失败：${error?.message ?? error}`);
          return { ok: false, status: 'missing', error: String(error?.message ?? error) };
        }
      },
      // 商品展示图（cover）：只对压缩包调用；同 id 30 天内只抓一次，失败写 cover_error 不阻塞。
      ensureCover: (boothId) => (0, deps.getBoothCover)(boothId, {
        cacheRoot: boothCacheDir(deps),
        log: (message) => (0, deps.log)(message)
      })
    };
  }
// @bridge-function boothDeps:end

// @bridge-function scheduleArchiveEnrichment:start
function scheduleArchiveEnrichment(deps, ids) {
    // simpleMode：不抓 BOOTH、不分类，跳过所有后台补抓。
    if (deps.cfg.fileArchive?.simpleMode === true) return;
    if (!boothConfig(deps).enabled) return;
    const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!list.length) return;
    const db = (0, deps.fileArchiveDb)();
    if (!db) return;
    for (const id of list) {
      void (0, deps.enrichArchiveItem)({
        db,
        rootDir: fileArchiveRootDir(deps),
        id,
        cfg: deps.cfg.fileArchive,
        deps: boothDeps(deps)
      }).then((result) => {
        if (result?.status === 'ok') {
          (0, deps.log)(`BOOTH 已归类：台账 #${id}「${result.category}」（id=${result.boothId}）→ ${result.relPath}`);
        } else if (result && !result.skipped) {
          (0, deps.log)(`BOOTH 归类未完成：台账 #${id}（${result.boothId || '-'}）status=${result.status} ${result.error || ''}`.trim());
        }
      }).catch((error) => (0, deps.log)(`BOOTH 归类异常：台账 #${id} ${error?.message ?? error}`));
    }
  }
// @bridge-function scheduleArchiveEnrichment:end

// @bridge-function oneBotAction:start
async function oneBotAction(deps, action, body) {
    const httpUrl = String(deps.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const auth = deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {};
    const res = await (0, deps.fetch)(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body),
      signal: deps.AbortSignal.timeout(20000)
    });
    const json = await res.json().catch(() => ({}));
    if (json?.status !== 'ok') {
      throw new Error(`${action} 失败：${json?.wording || json?.retcode || `HTTP ${res.status}`}`);
    }
    return json.data;
  }
// @bridge-function oneBotAction:end

// @bridge-function archiveGateReason:start
function archiveGateReason(deps, input) { return archiveGateReasonFor(deps, input); }
// @bridge-function archiveGateReason:end

// @bridge-function archiveGate:start
function archiveGate(deps, input) { return archiveGateReason(deps, input).ok; }
// @bridge-function archiveGate:end

// @bridge-function handleGroupFileUpload:start
async function handleGroupFileUpload(deps, event) {
    const groupId = String(event?.group_id ?? '');
    if (!(0, deps.isArchiveGroup)(deps.cfg.fileArchive, groupId)) return; // 白名单外：不下载/不提示/不打日志
    const file = event?.file ?? {};
    const fileId = String(file.id ?? '');
    const rawName = String(file.name || fileId || 'file');
    const size = Number(file.size) || 0;
    const busid = Number.isFinite(Number(file.busid)) ? Number(file.busid) : 102;
    // 转存口径（扩展名/关键词/体积/发送者）在这里一次判完；失败原因直接进日志，方便用户对照配置。
    const gate = archiveGateReason(deps, { segType: 'file', fileName: rawName, bytes: size, senderId: String(event?.user_id ?? '') });
    if (!gate.ok) {
      (0, deps.logArchiveSkip)(`group:${groupId}`, rawName, gate.reason || (0, deps.describeArchiveSkip)({ fileName: rawName }));
      return;
    }
    if (!fileId) {
      (0, deps.log)(`群文件转存跳过：事件缺少 file.id（群 ${groupId}，${rawName}）`);
      return;
    }
    const maxBytes = Math.max(1, Number(deps.cfg.fileArchive.maxFileMb) || 2500) * 1024 * 1024;
    if (size > maxBytes) {
      (0, deps.log)(`群文件转存跳过：${rawName} 超过上限 ${deps.cfg.fileArchive.maxFileMb}MB（${(0, deps.formatArchiveBytes)(size)}）`);
      return;
    }
    const db = (0, deps.fileArchiveDb)();
    if (!db) {
      (0, deps.log)('群文件转存跳过：消息库不可用（台账打不开）');
      return;
    }
    const dup = db.prepare('SELECT id FROM file_archive WHERE group_id = ? AND file_id = ? AND deleted_at IS NULL LIMIT 1').get(groupId, fileId);
    if (dup) {
      (0, deps.log)(`群文件转存跳过：file_id=${fileId} 已经转存过（台账 #${dup.id}）`);
      return;
    }
    const perHourHit = perHourLimitReached(deps, db, groupId);
    if (perHourHit) { (0, deps.logArchiveSkip)(`group:${groupId}`, rawName, `每小时上限 ${perHourHit} 个已满`); return; }
    // 磁盘空间护栏（2.5GB 单文件必须过这一关，否则几个文件就能把盘写满）：
    // 要求 freeBytes > maxBytes + 5GB 预留。拿不到 statfs 时按「放行但告警」处理，
    // 不能让一次 API 不可用把转存功能整体拖死。
    {
      const rootDir = fileArchiveRootDir(deps);
      try { deps.fs.mkdirSync(rootDir, { recursive: true }); } catch (error) { (0, deps.log)(`群文件转存：目录不可写（${error?.message ?? error}）`); }
      const verdict = await (0, deps.checkDiskSpace)({ statfs: deps.fs.promises.statfs, dir: rootDir, needBytes: maxBytes });
      if (!verdict.ok) {
        (0, deps.log)(`群文件转存跳过：磁盘剩余 ${(verdict.freeBytes / 1024 ** 3).toFixed(1)} GB，不足以下载 ${(maxBytes / 1024 ** 3).toFixed(1)} GB 文件（需预留 5 GB）`);
        return;
      }
      if (verdict.unknown) (0, deps.log)(`群文件转存：磁盘空间检查${(0, deps.describeDiskVerdict)(verdict)}`);
    }
    const data = await oneBotAction(deps, 'get_group_file_url', { group_id: Number(groupId), file_id: fileId, busid });
    const url = String(data?.url ?? '');
    if (!url) throw new Error('get_group_file_url 未返回 url');
    // 与聊天 file 段共用同一条落盘/记账实现（src/file-archive.js）：大文件走**流式**下载，
    // 边下边写临时文件、边算 sha256，2.5G 也不会把正文读进内存（旧实现在这里会 OOM）。
    const target = (0, deps.allocateArchiveTarget)({
      db,
      rootDir: fileArchiveRootDir(deps),
      groupId,
      archivedAt: Date.now(),
      fileName: rawName,
      baseDirRel: deps.cfg.fileArchive?.simpleMode === true
        ? (0, deps.simpleArchiveDir)((0, deps.archiveCfgFor)(groupId), groupId, Date.now(), rawName)
        : (boothConfig(deps).enabled ? (0, deps.archiveDirRel)({ groupId }) : '')
    });
    const fetched = await (0, deps.safeFetchToFile)(url, target.tmpPath, { maxBytes, timeoutMs: 120000 });
    if (fetched.truncated) {
      try { deps.fs.unlinkSync(target.tmpPath); } catch {}
      throw new Error(`下载被截断（超过 ${(0, deps.formatArchiveBytes)(maxBytes)} 上限），已放弃保存`);
    }
    const stored = await (0, deps.storeDownloadedFile)({
      db,
      groupId,
      fileId,
      fileName: rawName,
      target,
      bytes: fetched.bytes,
      sha256: fetched.sha256,
      messageId: String(event?.message_id ?? event?.file?.message_id ?? ''),
      uploader: String(event?.user_id ?? ''),
      uploadedAt: Number(event?.time) ? Number(event.time) * 1000 : 0,
      archivedAt: Date.now(),
      retention: deps.cfg.fileArchive.retention,
      source: 'notice'
    });
    (0, deps.log)(`群文件已转存：群 ${groupId}「${stored.storedName}」${(0, deps.formatArchiveBytes)(stored.bytes)}`
      + ` → ${stored.relPath}（分类 ${stored.category}/${stored.categorySource}，清理时间 ${new Date(stored.cleanupAt).toLocaleString('zh-CN', { hour12: false })}）`);
    // 规则认不出来才问模型（省调用）；分类失败不影响转存结果。
    if (stored.categorySource === 'none' && stored.inserted) {
      void classifyArchivedFile(deps, stored.id, stored.storedName).catch((error) => {
        (0, deps.log)(`文件自动分类失败 #${stored.id}：${error?.message ?? error}`);
      });
    }
    // BOOTH：解析文件名里的编号 → 抓商品信息 → 挪到分类目录并写 meta.json/缩略图。
    scheduleArchiveEnrichment(deps, stored.id);
  }
// @bridge-function handleGroupFileUpload:end

// @bridge-function ensureArchiveClassifySession:start
async function ensureArchiveClassifySession(deps) {
    if (deps.archiveClassifySessionId) {
      // 事件循环在每个 turn 结束后会把非黑话学习会话移出 learnerSessions，
      // 所以每次使用前必须重新登记，否则下一轮 turn/end 不会被收集、wait 会一直等到超时。
      deps.learnerSessions.add(deps.archiveClassifySessionId);
      return deps.archiveClassifySessionId;
    }
    const preset = deps.cfg.fileArchive?.category?.preset || 'qq-chat';
    const saved = (0, deps.readJsonSafe)(deps.ARCHIVE_CLASSIFY_SESSION_FILE, null);
    if (saved?.sessionId && saved.preset === preset) {
      deps.archiveClassifySessionId = String(saved.sessionId);
      deps.learnerSessions.add(deps.archiveClassifySessionId);
      deps.api.events.follow(deps.archiveClassifySessionId);
      await (0, deps.ensureChatModel)(deps.archiveClassifySessionId);
      return deps.archiveClassifySessionId;
    }
    const dir = deps.path.join(deps.STATE_DIR, 'file-archive-agent');
    deps.fs.mkdirSync(dir, { recursive: true });
    const wsValue = (0, deps.unwrap)(await deps.api.workspace.create({ path: dir }), 'file-archive workspace.create');
    const params = { workspaceId: wsValue.workspace.workspaceId, agentPreset: preset };
    const value = (0, deps.unwrap)(await deps.api.sessions.create(params), 'file-archive session.create');
    deps.archiveClassifySessionId = value.sessionId;
    deps.learnerSessions.add(deps.archiveClassifySessionId);
    deps.api.events.follow(deps.archiveClassifySessionId);
    await (0, deps.ensureChatModel)(deps.archiveClassifySessionId);
    (0, deps.atomicWriteJson)(deps.ARCHIVE_CLASSIFY_SESSION_FILE, { sessionId: deps.archiveClassifySessionId, preset });
    (0, deps.log)(`文件分类会话已创建：${deps.archiveClassifySessionId}`);
    return deps.archiveClassifySessionId;
  }
// @bridge-function ensureArchiveClassifySession:end

// @bridge-function classifyArchivedFile:start
async function classifyArchivedFile(deps, id, fileName) {
    if (deps.cfg.fileArchive?.category?.enabled === false) return null;
    if (!deps.dshReady) return null;
    const sessionId = await ensureArchiveClassifySession(deps);
    const promptText = '你是群文件归档助手。只输出一个中文分类名（2~6 个字），不要解释、不要标点。\n'
      + '可选分类：图片、视频、音频、压缩包、文档、代码、安装包、电子书、聊天记录、其他\n'
      + '无法判断就输出：unclassified\n'
      + `文件名：${fileName}`;
    const accepted = await deps.api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
    if (!accepted?.result?.ok) return null;
    const output = await (0, deps.waitLearnerTurn)(sessionId, 60000);
    const category = (0, deps.parseClassifyReply)(output);
    if (!category) return null;
    const db = (0, deps.fileArchiveDb)();
    if (!db) return null;
    const rec = (0, deps.setArchiveCategory)(db, { id, category, source: 'ai', retention: deps.cfg.fileArchive.retention });
    (0, deps.log)(`文件自动分类：#${id}「${fileName}」→ ${category}`
      + `（清理时间顺延至 ${new Date(rec.cleanupAt).toLocaleString('zh-CN', { hour12: false })}）`);
    return rec;
  }
// @bridge-function classifyArchivedFile:end

// @bridge-function archiveNextRunAt:start
function archiveNextRunAt(deps, nowMs = Date.now()) {
    const d = new Date(nowMs);
    d.setHours(Number(deps.cfg.fileArchive?.cleanupHour) || 0, 0, 0, 0);
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
// @bridge-function archiveNextRunAt:end

// @bridge-function runArchiveCleanupNow:start
async function runArchiveCleanupNow(deps, trigger, options = {}) {
    const dryRun = options?.dryRun === true; // dryRun=只预览：结果里带 wouldRemove*，一个字节都不落盘
    // 回收站自动清理搭同一次调度（cleanupHour 同概念；dryRun 预览不删；没注入就跳过）。
    if (!dryRun && typeof deps.archiveTrashAutoPurge === 'function') await (0, deps.archiveTrashAutoPurge)(trigger).catch((error) => (0, deps.log)(`回收站自动清理失败：${error?.message ?? error}`));
    if (!deps.messageDbHandle && !deps.fs.existsSync(deps.MESSAGE_DB_FILE)) return null; // 从没落过库就别顺手建库
    const db = (0, deps.fileArchiveDb)();
    if (!db) return null;
    const result = (0, deps.runArchiveCleanup)({ db, rootDir: fileArchiveRootDir(deps), nowMs: Date.now(), log: deps.log, dryRun });
    const nextRunAt = archiveNextRunAt(deps, Date.now());
    // 台账空的时候不刷日志：没人用这个功能就不该每天多一行噪音；预演也不刷（预览不该留痕）。
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM file_archive').get()?.n) || 0;
    if (!dryRun && total > 0) (0, deps.log)(`[${trigger}] ${(0, deps.formatCleanupLog)(result, nextRunAt)}`);
    return { ...result, nextRunAt };
  }
// @bridge-function runArchiveCleanupNow:end

// @bridge-function startArchiveCleanupLoop:start
function startArchiveCleanupLoop(deps) {
    // simpleMode：文件是用户手动整理的，不能被 60/120 天定时清理删掉。
    if (deps.cfg.fileArchive?.simpleMode === true) {
      (0, deps.log)('文件清理：simpleMode 已开启（只收 7 位 BOOTH 号开头的压缩包/图片），不执行自动清理');
      return;
    }
    if (deps.archiveCleanupTimer) return;
    if (deps.cfg.fileArchive?.enabled !== true && deps.fs.existsSync(deps.MESSAGE_DB_FILE)) {
      // 功能关着也要清理历史台账（否则关掉开关后旧文件永远留在盘里）。
      (0, deps.log)('文件清理：fileArchive.enabled=false（不再转存新文件，历史台账仍按保留期清理）');
    }
    // 启动补跑：进程可能整夜没开，错过清理点。
    (0, deps.setTimeout)(() => {
      void runArchiveCleanupNow(deps, '启动补跑').catch((error) => (0, deps.log)(`文件清理失败（启动补跑）：${error?.message ?? error}`));
    }, 10 * 1000).unref?.();
    deps.archiveCleanupTimer = (0, deps.setInterval)(() => {
      const now = Date.now();
      const d = new Date(now);
      if (d.getHours() !== (Number(deps.cfg.fileArchive?.cleanupHour) || 0)) return;
      const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      if (deps.lastArchiveCleanupDay === day) return;
      deps.lastArchiveCleanupDay = day;
      void runArchiveCleanupNow(deps, '每日定时').catch((error) => (0, deps.log)(`文件清理失败（每日定时）：${error?.message ?? error}`));
    }, 60 * 60 * 1000);
    deps.archiveCleanupTimer.unref?.();
  }
// @bridge-function startArchiveCleanupLoop:end

export function createFileArchiveRuntime(deps) {
  return {
    fileArchiveRootDir: () => fileArchiveRootDir(deps),
    fileArchiveDeps: (id, event) => fileArchiveDeps(deps, id, event),
    boothConfig: () => boothConfig(deps),
    boothCacheDir: () => boothCacheDir(deps),
    boothDeps: () => boothDeps(deps),
    scheduleArchiveEnrichment: (ids) => scheduleArchiveEnrichment(deps, ids),
    oneBotAction: (action, body) => oneBotAction(deps, action, body),
    archiveGate: (input) => archiveGate(deps, input),
    archiveGateReason: (input) => archiveGateReason(deps, input),
    handleGroupFileUpload: (event) => handleGroupFileUpload(deps, event),
    ensureArchiveClassifySession: () => ensureArchiveClassifySession(deps),
    classifyArchivedFile: (id, fileName) => classifyArchivedFile(deps, id, fileName),
    archiveNextRunAt: (nowMs) => archiveNextRunAt(deps, nowMs),
    runArchiveCleanupNow: (trigger, options) => runArchiveCleanupNow(deps, trigger, options),
    startArchiveCleanupLoop: () => startArchiveCleanupLoop(deps)
  };
}
