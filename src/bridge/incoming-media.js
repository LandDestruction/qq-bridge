// incoming-media: extracted bridge responsibilities; no startup side effects.
// Live dependencies: ARCHIVE_DAYS, ARCHIVE_DIR, ARCHIVE_RECALL_LIMIT, AbortSignal, STATE_DIR, VIDEO_MAX_BYTES, VIDEO_MAX_SECONDS, archiveFileFor, archiveWritable, cfg, collectSticker, createStagedTask, crypto, dhashFromBufferAsync, extractAudioWav, extractFrameGrid, fetch, fetchOneBotImage, fs, hammingDistance, log, mediaQueue, parseArchiveLines, path, pendingVideoEnrich, probeDuration, readBodyBounded, redactPii, resolveFfprobePath, saveSocialV2State, saveStickerStoreSafe, searchArchive, stickerEntries, stickerHashInFlight, stickerSeenCounts, sttService, videoFollowUps, videoInFlight
// 收录闸（模块级：createIncomingMedia 有 335 行冻结基线，判定逻辑不占工厂行数）。
// 只看文件头，代价可忽略；拒绝时打一行日志便于回查「为什么这张没入库」。
function stickerCollectAllowed(deps, media, buf) {
  const gate = (0, deps.shouldAutoCollectSticker)({ media, meta: (0, deps.readImageMeta)(buf), bytes: buf.length });
  if (gate.ok) {
    media.collectReason = gate.reason;
    return true;
  }
  (0, deps.log)(`[收集] 跳过（${gate.reason}）：${String(media.summary || media.file || '').slice(0, 40)}`);
  return false;
}

// @bridge-function collectByContentHash:start
async function collectByContentHash(deps, key, media, sender) {
    if (deps.stickerHashInFlight >= 3) return;
    deps.stickerHashInFlight += 1;
    try {
      const got = await (0, deps.fetchOneBotImage)(media);
      const buf = got?.buffer;
      if (!buf || !buf.length) return;
      const md5 = deps.crypto.createHash('md5').update(buf).digest('hex').toUpperCase();
      // 命中库内已有表情：把备注回填到这条消息的摘要，让她知道「这张我认识」。
      let hit = deps.stickerEntries.find((e) => String(e.md5 || '') === md5);
      // 库里没有这张 → 先过「收录标准」，不过闸就不算 dHash、不记次数（截图/长图/照片会被挡掉）。
      if (!hit && !stickerCollectAllowed(deps, media, buf)) return;
      // 这次算出来的 dHash：md5 未命中时要拿它兜底比对，新入库时也要**存下来**。
      // 以前它只在比对用完后就被丢掉，于是库里的 dHash 覆盖率永远上不去（196 条只有 53 条有），
      // 兜底比对等于每轮都白跑 —— 同一张图重编码后再出现，照样多收一张。
      let contentDhash = '';
      // md5 未命中（QQ 重编码/缩放）：用 dHash 兜底，汉明距离 ≤6 视为同一张。
      if (!hit) {
        try {
          // 异步：这一句以前是 spawnSync(ffmpeg)，每个媒体都会把事件循环按住（超时 15s）。
          const dh = await (0, deps.dhashFromBufferAsync)(buf, { ffmpegPath: String(deps.cfg.socialV2?.voice?.ffmpegPath || 'ffmpeg') });
          if (dh) {
            contentDhash = dh;
            let best = null;
            let bestD = 99;
            for (const e of deps.stickerEntries) {
              if (!e.dhash) continue;
              const d = (0, deps.hammingDistance)(dh, e.dhash);
              if (d < bestD) { bestD = d; best = e; }
            }
            if (best && bestD <= 6) { hit = best; }
            else if (best) (0, deps.log)(`[收集] 近邻未达阈值：距离 ${bestD}（>6）`);
          }
        } catch {}
      }
      if (hit) {
        hit.seenCount = (Number(hit.seenCount) || 0) + 1;
        hit.lastSeenAt = Date.now();
        hit.lastSeenContext = `${key} 有人发过这张`;
        (0, deps.saveStickerStoreSafe)();
        try { (0, deps.saveSocialV2State)(); } catch {}
        (0, deps.log)(`[收集] 命中库内表情（${String(hit.md5 || '') === md5 ? 'md5' : 'dhash'}），不冒充图片描述：描述由图像记忆（image-memory）独立负责`);
        return;
      }
      const n = (deps.stickerSeenCounts.get(md5) || 0) + 1;
      deps.stickerSeenCounts.set(md5, n);
      (0, deps.log)(`[收集] 图片 hash=${md5.slice(0, 8)} 第 ${n} 次（${(buf.length / 1024).toFixed(0)}KB）`);
      if (n < 2) return;
      if (n > 2) return;
      const added = (0, deps.collectSticker)(deps.stickerEntries, {
        md5,
        url: media.url,
        dhash: contentDhash,
        source: key,
        collectedBy: sender,
        context: String(media.summary || '').slice(0, 60),
      });
      if (added) {
        // 缓存表情原图：QQ 链接会过期，本地留一份缩略图才不至于空白
        try { const d = deps.path.join(deps.STATE_DIR, 'sticker-files'); deps.fs.mkdirSync(d, { recursive: true }); deps.fs.writeFileSync(deps.path.join(d, `${md5}.img`), buf); } catch {}
        (0, deps.saveStickerStoreSafe)();
        (0, deps.log)(`表情收集：${key} 里同一张图出现 2 次，已入库（待注释，${(buf.length / 1024).toFixed(0)}KB）`);
      }
    } catch (error) {
      (0, deps.log)('[收集] 下载/哈希失败:', error?.message ?? error);
    } finally {
      deps.stickerHashInFlight -= 1;
    }
  }
// @bridge-function collectByContentHash:end

// @bridge-function enrichVideoFile:start
async function enrichVideoFile(deps, key, media, msg, opts = {}) {
    const tArrived = Date.now();
    let stage = null;
    let job = null;
    let tmp = null;
    let said = '';
    let claimedInflight = false;
    try {
      if (!media || media.kind !== 'video-file') return;
      const sig = `${key}:${media.file || media.url}`;
      if (deps.videoInFlight.has(sig)) return;
      deps.videoInFlight.add(sig);
      claimedInflight = true;
      try { media.sttStatus = 'pending'; media.sttError = ''; } catch {}
      (0, deps.log)(`[video] ${key} 收到视频${media.name ? `「${String(media.name).slice(0, 40)}」` : ''}（${sig.slice(0, 80)}）`);
      // 任务/阶段必须**同步**登记：prompt 可能在这条消息入队后立刻组装，
      // 如果等下载/探测完再登记，processPromptQueue 看不到任何 stage，本轮就白等了。
      stage = (0, deps.createStagedTask)();
      stage.job = job = deps.videoFollowUps.createJob({ key, sig });
      stage.autoClaim = opts.autoClaim !== false;
      try { opts.onJob?.(job); } catch {}
      {
        let set = deps.pendingVideoEnrich.get(key);
        if (!set) { set = new Set(); deps.pendingVideoEnrich.set(key, set); }
        set.add(stage);
      }
      const sizeCap = Number(deps.cfg.socialV2?.video?.maxBytes) || deps.VIDEO_MAX_BYTES;
      // 不再只凭 media.size 前置判定：OneBot 的 file_size 经常是 0，一短路就变成
      // 全量 arrayBuffer 读入几百 MB → 堆爆 → 守护进程重启。这里改成流式读取 + 字节截断。
      let buf = null;
      let truncated = false;
      let truncatedFrom = 0;
      const readBounded = async (url, timeoutMs) => {
        const r = await (0, deps.fetch)(url, { signal: deps.AbortSignal.timeout(timeoutMs) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const out = await (0, deps.readBodyBounded)(r.body, sizeCap);
        if (out.truncated) { truncated = true; truncatedFrom = Math.max(truncatedFrom, out.bytesRead); }
        return out.buffer;
      };
      if (media.url) {
        try { buf = await readBounded(media.url, 20000); } catch (error) { (0, deps.log)(`[video] ${key} 直链下载失败：${error?.message ?? error}`); }
      }
      if ((!buf || !buf.length) && media.file) {
        const H = String(deps.cfg.snowluma?.httpUrl || '').replace(/\/+$/, '');
        const auth = deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {};
        try {
          const res = await (0, deps.fetch)(`${H}/get_file`, {
            method: 'POST', headers: { 'content-type': 'application/json', ...auth },
            body: JSON.stringify({ file_id: media.file, file: media.file }),
            signal: deps.AbortSignal.timeout(20000)
          });
          const j = await res.json().catch(() => ({}));
          const url = j?.data?.url || j?.data?.file;
          if (url && /^https?:/.test(url)) buf = await readBounded(url, 60000);
        } catch (error) { (0, deps.log)(`[video] ${key} get_file 下载失败：${error?.message ?? error}`); }
      }
      if (truncated) {
        (0, deps.log)(`[video] ${key} 视频超过 ${(sizeCap / 1048576).toFixed(1)}MB，已按字节截断到 ${(truncatedFrom / 1048576).toFixed(1)}MB（未整段读入内存）`);
      }
      if (!buf || !buf.length) {
        (0, deps.log)(`[video] ${key} 视频下载失败：${media.name || ''}`);
        try { media.sttStatus = 'failed'; media.sttError = '视频下载失败'; } catch {}
        try { stage.markFrames(); stage.markStt(); } catch {}
        void deps.videoFollowUps.transcriptReady(job, { text: '', status: 'failed', error: '视频下载失败' }).catch(() => {});
        return;
      }
      tmp = deps.path.join(deps.STATE_DIR, `vid_${Date.now()}_${process.pid}.mp4`);
      deps.fs.writeFileSync(tmp, buf);
      const ff = String(deps.cfg.socialV2?.voice?.ffmpegPath || 'ffmpeg');
      // 别再靠正则推导 ffprobe：配成 `ffmpeg`（PATH）或 `/usr/bin/ffmpeg` 时旧写法会拿到
      // ffmpeg 自己的路径，probeDuration 返回 null 且不留日志（视频时长静默丢失）。
      const ffprobe = (0, deps.resolveFfprobePath)(ff);
      const dur = await (0, deps.probeDuration)(tmp, ffprobe);
      if (dur === null) (0, deps.log)(`[video] ${key} ffprobe 探测时长失败（ffprobe=${ffprobe}），将按未知时长抽帧`);
      const secCap = Number(deps.cfg.socialV2?.video?.maxSeconds) || deps.VIDEO_MAX_SECONDS;
      // 重活（抽帧 / 抽音轨 / 转写）走**进程级**并发闸门：几个群同时来视频时，
      // 不会各自起一个 ffmpeg 把 CPU 与内存打满。排队超时只让这条视频退化成纯文本，
      // 绝不能把整条消息丢掉。
      let grid = null;
      stage.job.durationSec = dur;
      const metrics = { dur, audioBytes: 0, framesMs: 0, sttModel: '', sttMs: 0, sttSource: '', chars: 0, truncated: false, sttError: '' };
      let sttError = '';
      let noAudio = false;
      let lowConfidence = false;
      let lowReason = '';
      let status = 'pending';
      // 把「这条视频的事实」一次性写进 media/msg。**必须在 stage.markStt() 之前写**：
      // processPromptQueue 在 stt 完成后会立刻 claim 并组装 prompt，如果这时 msg 还没回填，
      // 模型就会看到「转写中」而实际转写已经好了（或者反过来，把没转写的内容当成已带上）。
      const applyVideoFacts = (gridInfo) => {
        status = said ? 'ok' : (noAudio ? 'no-audio' : 'failed');
        const picture = gridInfo ? `｜画面：已抽 ${gridInfo.frames} 帧${gridInfo.everySec ? `（约 ${gridInfo.everySec.toFixed(1)}s/帧）` : ''}拼成 ${gridInfo.cols}×${gridInfo.rows} 网格` : '';
        const line = `[视频${dur ? ` ${Math.round(dur)} 秒` : ''}${picture}]`;
        // 会话语录只写「事实」：听不清/没有声音各标一句即可，别把给模型的判断与指令
        // （「别臆测声音内容」那类话）写进消息正文——那些话只该留在日志与 prompt 里。
        // 声音单独一行：画面/声音混在一句里时模型容易只答画面（用户直报）。
        const sound = said
          ? `声音：“${said}”`
          : (lowConfidence ? '声音：听不清'
            : (status === 'no-audio' ? '声音：无'
              : (status === 'failed' ? '声音：没转出来' : '声音：转写中')));
        try {
          media.summary = line.slice(0, 80);
          media.sttStatus = status;
          media.sttError = sttError;
          media.sttLowConfidence = lowConfidence;
          media.sttText = said;
          media.enrichedAt = Date.now();
        } catch {}
        msg.text = `${String(msg.text || '').replace(/\[(?:文件|视频)[^\]]*\]/g, '').trim()} ${line}\n${sound}`.trim();
        msg.plain = msg.text;
        return line;
      };
      try {
        const analyzed = await deps.mediaQueue.run(async () => {
          const tFrames = Date.now();
          const g = await (0, deps.extractFrameGrid)(tmp, { ffmpegPath: ff, durationSec: dur && dur > secCap ? secCap : dur });
          metrics.framesMs = Date.now() - tFrames;
          stage.markFrames(); // 帧好了，prompt 可以先走
          (0, deps.log)(`[video] ${key} 抽帧完成 耗时=${metrics.framesMs}ms ${g ? `帧=${g.frames}张 ${g.cols}×${g.rows}` : '（失败，仅保留时长）'}`);
          const w = await (0, deps.extractAudioWav)(tmp, { ffmpegPath: ff, maxSeconds: secCap });
          metrics.audioBytes = Buffer.isBuffer(w) ? w.length : 0;
          let text = '';
          const missingAudio = !w || !w.length;
          if (missingAudio) {
            sttError = '音频提取失败或视频没有音轨';
            metrics.sttError = sttError;
          } else {
            // 默认 small：实测 medium 在 CPU 上 40s 音频要 45s（small 5s），且测试音频出现重复幻觉；
            // 要上 medium/large-v3 用 socialV2.stt.model 配（有 CUDA 时服务端自动优先 cuda）。
            const sttModel = String(deps.cfg.socialV2?.stt?.videoModel || deps.cfg.socialV2?.stt?.model || 'small');
            metrics.sttModel = sttModel;
            const tStt = Date.now();
            const stt = await deps.sttService.transcribe(w, { model: sttModel, lang: String(deps.cfg.socialV2?.stt?.lang || 'zh') });
            metrics.sttMs = Number(stt?.ms) || (Date.now() - tStt);
            metrics.sttSource = String(stt?.source || '');
            if (stt?.ok && stt.lowConfidence) {
              // 宁可说「听不清」，也不把乱码当内容传给模型。
              lowConfidence = true;
              lowReason = String(stt.reason || 'low_confidence');
              sttError = `语音听不清（${lowReason}）`;
              metrics.sttError = sttError;
            } else if (stt?.ok && stt.text) {
              const maxChars = Number(deps.cfg.socialV2?.stt?.maxChars) || 600;
              const full = (0, deps.redactPii)(String(stt.text));
              text = full.slice(0, maxChars);
              metrics.chars = text.length;
              metrics.truncated = full.length > maxChars;
            } else {
              sttError = String(stt?.error || '转写返回空').slice(0, 120);
              metrics.sttError = sttError;
            }
          }
          stage.sttError = sttError;
          stage.text = text;
          said = text;
          noAudio = missingAudio;
          applyVideoFacts(g); // 先回填事实，再放行 prompt（顺序不能反）
          stage.markStt();
          (0, deps.log)(`[video] ${key} 转写(${metrics.sttSource === 'service' ? '服务' : metrics.sttSource === 'cli' ? 'CLI' : '未执行'}) 耗时=${metrics.sttMs}ms 字数=${metrics.chars}${metrics.truncated ? '（已截断）' : ''}${sttError ? ` 错误=${sttError}` : ''}`);
          return { grid: g };
        });
        grid = analyzed.grid;
      } catch (error) {
        sttError = sttError || (error?.code === 'MEDIA_QUEUE_TIMEOUT'
          ? '媒体队列排队超时'
          : `媒体处理失败：${error?.message ?? error}`);
        // 排队超时 / 处理异常：如实记录，并让这条消息退化成纯文本 [视频 N 秒]。
        if (error?.code === 'MEDIA_QUEUE_TIMEOUT') (0, deps.log)(`[video] ${key} 媒体队列排队超时，本条只保留时长信息：${error.message}`);
        else (0, deps.log)(`[video] ${key} 媒体处理失败（已降级为纯文本）：${error?.message ?? error}`);
        try { stage.markFrames(); } catch {}
        applyVideoFacts(null);
        try { stage.markStt(); } catch {}
      }
      // 幂等回填：正常路径已在 markStt 前写过；异常路径这里补上时长/失败原因。
      applyVideoFacts(grid);
      if (grid) {
        // 拼图落盘，state 里只存相对路径：Buffer 直接塞进消息会把 state 文件撑到几十 MB。
        const frameDir = deps.path.join(deps.STATE_DIR, 'video-frames');
        deps.fs.mkdirSync(frameDir, { recursive: true });
        const frameName = `vid_${Date.now()}_${process.pid}.png`;
        deps.fs.writeFileSync(deps.path.join(frameDir, frameName), grid.buffer);
        msg.media = Array.isArray(msg.media) ? msg.media : [];
        msg.media.push({ kind: 'image', localFile: `video-frames/${frameName}`, summary: '视频抽帧拼图', url: '' });
        msg.hasMedia = true;
      }
      try { (0, deps.saveSocialV2State)(); } catch {}
      (0, deps.log)(`[video] ${key} 视频分析完成：总耗时=${Date.now() - tArrived}ms ${dur ? Math.round(dur) + 's ' : ''}${said ? `有语音（${metrics.chars} 字）` : status === 'no-audio' ? '无可用人声' : '转写失败'} 截断视频=${truncated ? '是' : '否'}`);
      // 迟到补发：本轮 prompt 没赶上就会在这里（延迟 settleMs 后）主动发一条。
      void deps.videoFollowUps.transcriptReady(job, { text: said, status, error: sttError, durationSec: dur })
        .catch((error) => (0, deps.log)(`[video] ${key} 补发流程异常：${error?.message ?? error}`));
    } catch (error) {
      (0, deps.log)('[video] 分析失败:', error?.message ?? error);
      try { if (media) media.sttStatus = 'failed'; } catch {}
      if (job) {
        void deps.videoFollowUps.transcriptReady(job, { text: said, status: said ? 'ok' : 'failed', error: error?.message ?? String(error) })
          .catch(() => {});
      }
    } finally {
      if (tmp) { try { deps.fs.unlinkSync(tmp); } catch {} }
      try {
        if (stage) {
          const set = deps.pendingVideoEnrich.get(key);
          if (set) { set.delete(stage); if (!set.size) deps.pendingVideoEnrich.delete(key); }
        }
      } catch {}
      try { if (claimedInflight) deps.videoInFlight.delete(`${key}:${media?.file || media?.url}`); } catch {}
    }
  }
// @bridge-function enrichVideoFile:end

// @bridge-function maybeCollectSticker:start
function maybeCollectSticker(deps, key, media, sender) {
    try {
      if (deps.cfg.socialV2?.sticker?.autoCollect === false) return;
      if (!Array.isArray(media)) return;
      for (const m of media) {
        if (!m) continue;
        if (m.kind !== 'image' && m.kind !== 'sticker' && m.kind !== 'face') continue;
        if (!m.url && !m.file && !m.emojiId) continue;
        void collectByContentHash(deps, key, m, sender);
      }
    } catch (error) {
      (0, deps.log)('表情收集失败:', error?.message ?? error);
    }
  }
// @bridge-function maybeCollectSticker:end

// @bridge-function archivePrune:start
function archivePrune(deps) {
    if (!deps.archiveWritable) return;
    try {
      const cutoff = Date.now() - deps.ARCHIVE_DAYS * 86400000;
      for (const f of deps.fs.readdirSync(deps.ARCHIVE_DIR)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = deps.path.join(deps.ARCHIVE_DIR, f);
        try {
          const stat = deps.fs.statSync(p);
          if (stat.mtimeMs < cutoff && Date.now() - stat.mtimeMs > deps.ARCHIVE_DAYS * 86400000) {
            deps.fs.unlinkSync(p);
          }
        } catch {}
      }
    } catch {}
  }
// @bridge-function archivePrune:end

// @bridge-function archiveRecall:start
function archiveRecall(deps, key, query, limit = deps.ARCHIVE_RECALL_LIMIT) {
    if (!deps.archiveWritable) return [];
    const p = (0, deps.archiveFileFor)(key);
    if (!deps.fs.existsSync(p)) return [];
    if (!String(query || '').trim()) return [];
    let text;
    try { text = deps.fs.readFileSync(p, 'utf8'); } catch { return []; }
    return (0, deps.searchArchive)((0, deps.parseArchiveLines)(text), query, limit);
  }
// @bridge-function archiveRecall:end

export function createIncomingMedia(deps) {
  return {
    collectByContentHash: (key, media, sender) => collectByContentHash(deps, key, media, sender),
    enrichVideoFile: (key, media, msg, opts) => enrichVideoFile(deps, key, media, msg, opts),
    maybeCollectSticker: (key, media, sender) => maybeCollectSticker(deps, key, media, sender),
    archivePrune: () => archivePrune(deps),
    archiveRecall: (key, query, limit) => archiveRecall(deps, key, query, limit)
  };
}
