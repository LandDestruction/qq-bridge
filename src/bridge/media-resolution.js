// media-resolution: extracted bridge responsibilities; no startup side effects.
// Live dependencies: MAX_MEDIA_BYTES, MAX_MEDIA_COUNT, activeModelOverride, appliedModelBySession, archiveMediaAttachment, cfg, currentMode, fetchFaceMedia, fetchOneBotImage, getSocialV2State, log, markMediaTurn, messageMediaStore, modelSeesImages, resolveTurnModel, socialV2, state, toModelMedia, videoMediaFactText, warnedNoVision
// 这轮模型看不了图时：先用智谱（桥接直连）把画面描述成文字，失败才退回「看不了图」。
// 注意：必须写在 resolveMediaList 内部——audit harness 会把函数体单独 eval，模块级符号会 ReferenceError。

export function createMediaResolution(deps) {
// @bridge-function resolveMediaList:start
async function resolveMediaList(mediaList, key = null) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    // 本轮真正生效的模型 + 能不能塞 image part：必须在**循环外**算一次，让「表情」「图片」两条分支共用。
    // 历史坑（两个一起）：① 这段原本只写在下面的 face 分支里，普通图片分支读同名变量 →
    // `ReferenceError: imagePartsAllowed is not defined`；② 里面直接引用了不存在的 `sessionId`
    // （这个函数只有 key 形参）→ 走到就 `sessionId is not defined`。两者都让含图消息的 parts
    // 构造整轮抛异常/丢图。会话 id 必须由 key 从 state.sessions 解析出来。
    // 必须用「本轮真正生效的模型」：含图回合 ensureChatModel 会把会话切到 deepseek-flash，
    // 但那个选择不回写 activeModelOverride —— 读 override/cfg 会误判成「看不了图」。
    const mediaSessionId = key ? String(deps.state.sessions?.[key] || '') : '';
    const turnModel = (0, deps.resolveTurnModel)({
      applied: (mediaSessionId && deps.appliedModelBySession.get(mediaSessionId)) || null,
      override: deps.activeModelOverride,
      cfgProvider: deps.cfg.dsh?.provider,
      cfgModel: deps.cfg.dsh?.model
    });
    // 非 DSH 后端（本地 OpenAI 兼容端点）由 agent.vision 决定能不能看图；
    // config 里 agent.vision 默认视为 true（Strata 这类端点默认开 --vision）。
    const agentType = String(deps.cfg?.agent?.type || 'dsh').toLowerCase();
    const imagePartsAllowed = agentType === 'dsh'
      ? (0, deps.modelSeesImages)(turnModel.provider, turnModel.model, turnModel)
      : deps.cfg?.agent?.vision !== false;

    // 补看排队：图没进来时记一笔并排一次补看（NO_VISION_TEXT 与描述兜底在模块级）。
    const noteVisionMiss = (missKind) => {
      if (!key) return;
      try { (0, deps.markMediaTurn)(key); } catch {}
      try { (0, deps.appendActivity)('media-no-vision', { key, kind: missKind, at: Date.now() }); } catch {}
      try { if (typeof deps.scheduleMediaFollowup === 'function') (0, deps.scheduleMediaFollowup)(key, 'mediaFollowup'); } catch {}
    };
    const NO_VISION_TEXT = '[图片] 当前模型看不了图（这轮没加载图像），已排队：下一轮我会用能看图的模型补看。先别猜画面内容，也别对用户说「我永远看不到图」。';
    // 兜底：describeImage 由桥接注入（智谱直连），harness 里没有就走回原文案。
    const noVisionText = async (label, prep) => {
      let hash = '';
      try {
        hash = typeof deps.hashImageBuffer === 'function' && prep?.buffer?.length ? await deps.hashImageBuffer(prep.buffer) : '';
        const hit = hash && typeof deps.imageMemoryLookup === 'function' ? deps.imageMemoryLookup(hash) : null;
        if (hit?.entry) { (0, deps.log)(`[识图] ${label} 命中本地图库（距离 ${hit.distance}）`); return `${label} 是本地图库里的老图（凭 dhash 认出来的）：${hit.entry.d}`; }
        const d = typeof deps.describeImage === 'function' && prep?.buffer?.length ? await deps.describeImage({ buffer: prep.buffer, mimeType: prep.mimeType, label }) : null;
        if (d?.ok && d.text) { (0, deps.log)(`[识图] ${label} 识图 ${d.ms ?? '?'}ms / ${String(d.text).length} 字`); if (hash && typeof deps.imageMemoryRemember === 'function') deps.imageMemoryRemember(hash, d.text, prep.kind || 'image'); return `${label} 的画面描述（由识图模型转述，不是你自己看到的）：${d.text}`; }
        if (d) (0, deps.log)(`[识图] ${label} 失败：${d?.error || '没有结果'}`);
      } catch (error) { (0, deps.log)(`[识图] ${label} 异常：${error?.message || error}`); } return NO_VISION_TEXT;
    };
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > deps.MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${deps.MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      // 视频（video-file）**不走图片路径**：以前会落到 else 分支调 fetchOneBotImage(media)，
      // 把 mp4 当图片去 safeFetchBuffer → 「抓取内容不是有效图片」，白费一次抓取，
      // 还让模型以为「有张图但没发出去」。视频的信息由 enrichVideoFile 回填（抽帧拼图 + 转写）。
      if (media.kind === 'video-file') {
        // 视频（video-file）**不走图片路径**。事实必须诚实：
        //   · 转写已完成 → 带转写摘要；
        //   · 还在转写     → 明确说「转写中，稍后补给你」，绝不说「听不到/没有声音」；
        //   · 没有音轨/失败 → 明确说明原因。
        parts.push({ type: 'text', text: (0, deps.videoMediaFactText)(media) });
        continue;
      }
      if (media.kind === 'face') {
        const face = await (0, deps.fetchFaceMedia)(media);
        if (face.buffer && key) (0, deps.archiveMediaAttachment)(key, media, face.buffer, index, face.mimeType);
        const prep = face.buffer ? await (0, deps.toModelMedia)(face.buffer, face.mimeType, `表情#${media.faceId ?? index}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > deps.MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += prep.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          if (prep.note) parts.push({ type: 'text', text: `（${prep.note}）` });
          // 视觉能力守卫：当前模型不在已知可看图清单里 → 不塞 image part，改成文字说明，
          // 否则模型会基于「看不见的图」编造内容（实测就会「我看到了」）。
          if (!imagePartsAllowed) {
            // K2（2026-11-01）：图到得比回合开始晚时（本轮已定模型、无视觉），除了一句「看不了」，
            // 还要把「这轮有图」记下来 + 排一次补看，否则这张图就彻底消失（私聊 19:18:39 那次的现场）。
            noteVisionMiss('face');
            parts.push({ type: 'text', text: await noVisionText(`[表情${index}]`, prep) });
            const label = `${turnModel.provider}/${turnModel.model}`;
            if (deps.warnedNoVision !== label) { deps.warnedNoVision = label; (0, deps.log)(`⚠️ 当前模型 ${label} 不支持看图：图片已降级为文字说明（降级链切到无视觉模型时会这样）`); }
                    } else { (0, deps.log)('[识图调试] 表情塞图路径 imageMemoryEnsureSeen=' + typeof deps.imageMemoryEnsureSeen + ' buffer=' + (prep?.buffer?.length || 0)); void deps.imageMemoryEnsureSeen?.(
`[表情${index}]`, prep, 'face');
          parts.push({ type: 'image', mediaType: prep.mimeType, data: prep.buffer.toString('base64'), name: `face-${media.faceId}.${(prep.mimeType || 'png').split('/')[1]}` });
          }
        } else if (prep && !prep.ok) {
          // 压不到可用体积：明确说明原因，别让模型对着「（获取失败）」瞎猜。
          parts.push({ type: 'text', text: `[表情${index}（${prep.error}）]` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await (0, deps.fetchOneBotImage)(media);
        if (img?.buffer && key) (0, deps.archiveMediaAttachment)(key, media, img.buffer, index, img.mimeType);
        const sticker = media.kind === 'sticker';
        const summary = sticker && media.summary ? `:${String(media.summary).slice(0, 20)}` : '';
        const label = sticker ? (summary ? `[表情${summary}]` : `[表情${index}]`) : `[图片${index}]`;
        const prep = img?.buffer ? await (0, deps.toModelMedia)(img.buffer, img.mimeType, `${label}`) : null;
        // 逐图失败必须可见：否则用户只看到「没识别」，日志里什么都没有。
        // 同时把事实写进给模型的内容，它就不会假装看到。
        if (!prep?.ok) {
          const why = !img?.buffer ? '抓取失败（下载被截断或格式不认）' : (prep?.error || '未知原因');
          (0, deps.log)(`[media] ${label.replace(/[\[\]]/g, '')} 未发送：${why}（原始 ${img?.buffer ? `${(img.buffer.length / 1024).toFixed(0)}KB` : 'n/a'}）`);
          parts.push({ type: 'text', text: `${label} 未能发送：${why}` });
          continue;
        }
        // 超长截图：归一化层切成了多片（prep.tiles）。每片单独一个 image part，
        // 文本里标「第 i/N 段」——否则模型会把 8 片当成 8 张不同的图，重复描述、漏掉下半截。
        // 总字节按所有片求和计入 MAX_MEDIA_BYTES（和普通图同一本账）。
        if (prep?.ok && Array.isArray(prep.tiles) && prep.tiles.length > 1) {
          const tileBytes = prep.tiles.reduce((sum, t) => sum + (t?.buffer?.length || 0), 0);
          if (totalBytes + tileBytes > deps.MAX_MEDIA_BYTES) {
            (0, deps.log)(`[media] ${label.replace(/[\[\]]/g, '')} 未发送：长图切片后仍超预算（${(tileBytes / 1024).toFixed(0)}KB > ${(deps.MAX_MEDIA_BYTES / 1024).toFixed(0)}KB）`);
            parts.push({ type: 'text', text: `${label} 未能发送：长图切片后仍超预算（${(tileBytes / 1024).toFixed(0)}KB > ${(deps.MAX_MEDIA_BYTES / 1024).toFixed(0)}KB）` });
            continue;
          }
          totalBytes += tileBytes;
          parts.push({ type: 'text', text: label });
          if (prep.note) parts.push({ type: 'text', text: `（${prep.note}）` });
          if (imagePartsAllowed) {
            prep.tiles.forEach((tile, i) => {
              parts.push({ type: 'text', text: `长图第 ${i + 1}/${prep.tiles.length} 段` });
              parts.push({ type: 'image', mediaType: tile.mimeType, data: tile.buffer.toString('base64'), name: `qq-${sticker ? 'sticker' : 'image'}-${index}-tile${i + 1}.jpg` });
            });
          } else {
            noteVisionMiss('image-tile');
            parts.push({ type: 'text', text: await noVisionText(`${label}第 1/${prep.tiles.length} 段`, prep.tiles[0]) });
            const noVisionLabel = `${turnModel.provider}/${turnModel.model}`;
            if (deps.warnedNoVision !== noVisionLabel) { deps.warnedNoVision = noVisionLabel; (0, deps.log)(`⚠️ 当前模型 ${noVisionLabel} 不支持看图：图片已降级为文字说明（降级链切到无视觉模型时会这样）`); }
          }
          continue;
        }
        if (prep?.ok) {
          totalBytes += prep.buffer.length;
          parts.push({ type: 'text', text: label });
          if (prep.note) parts.push({ type: 'text', text: `（${prep.note}）` });
          if (imagePartsAllowed) { (0, deps.log)('[识图调试] 图片塞图路径 imageMemoryEnsureSeen=' + typeof deps.imageMemoryEnsureSeen + ' buffer=' + (prep?.buffer?.length || 0)); void deps.imageMemoryEnsureSeen?.(label, prep, sticker ? 'sticker' : 'image');
            parts.push({ type: 'image', mediaType: prep.mimeType, data: prep.buffer.toString('base64'), name: `qq-${sticker ? 'sticker' : 'image'}-${index}.${(prep.mimeType || 'image/jpeg').split('/')[1]}` });
          } else {
            // 和表情分支保持一致：塞不了图就必须明说，否则模型会对着「[图片1]」这个标签瞎编画面。
            noteVisionMiss('image');
            parts.push({ type: 'text', text: await noVisionText(label, prep) });
            const noVisionLabel = `${turnModel.provider}/${turnModel.model}`;
            if (deps.warnedNoVision !== noVisionLabel) { deps.warnedNoVision = noVisionLabel; (0, deps.log)(`⚠️ 当前模型 ${noVisionLabel} 不支持看图：图片已降级为文字说明（降级链切到无视觉模型时会这样）`); }
          }
        } else if (prep && !prep.ok) {
          parts.push({ type: 'text', text: `${label}（${prep.error}）` });
        } else {
          parts.push({ type: 'text', text: `${label}（获取失败）` });
        }
      }
    }
    return parts;
  }
// @bridge-function resolveMediaList:end

// @bridge-function fetchMediaData:start
async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > deps.MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : (media?.kind === 'sticker' ? 'sticker' : 'image'), text: `（超过单条上限 ${deps.MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await (0, deps.fetchFaceMedia)(media);
        const prep = face.buffer ? await (0, deps.toModelMedia)(face.buffer, face.mimeType, `表情#${media.faceId ?? index}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > deps.MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += prep.buffer.length;
          const faceMem = await deps.imageMemoryEnsureSeen?.(`表情#${media.faceId ?? index}`, prep, 'face'), faceMemText = faceMem?.desc ? `[画面描述·${faceMem.hit ? '本地档案' : '本次识图已存档'}] ${faceMem.desc}` : '';
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            ...(faceMem?.desc ? {} : { mimeType: prep.mimeType, data: prep.buffer.toString('base64') }),
            text: [face.text || '', prep.note ? `（${prep.note}）` : '', faceMemText].filter(Boolean).join(' ')
          });
        } else if (prep && !prep.ok) {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: `（获取失败：${prep.error}）` });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await (0, deps.fetchOneBotImage)(media);
        const kind = media.kind === 'sticker' ? 'sticker' : 'image';
        const noun = kind === 'sticker' ? '表情' : '图片';
        const base = {
          index,
          kind,
          ...(media.file ? { file: String(media.file) } : {}),
          ...(media.url ? { url: String(media.url) } : {}),
          ...(media.emojiId ? { emojiId: String(media.emojiId) } : {}),
          ...(media.summary ? { summary: String(media.summary) } : {}),
          ...(media.subType ? { subType: String(media.subType) } : {})
        };
        const prep = img?.buffer ? await (0, deps.toModelMedia)(img.buffer, img.mimeType, `${noun}${index}`) : null;
        // 超长截图：一张图 → 多条 entry（每条一片）。MCP 侧本来就是「一条 entry 一个 image part」，
        // 所以这里拆成多条就等于给模型多段图；text 里标「第 i/N 段」，让它知道这是同一张图。
        if (prep?.ok && Array.isArray(prep.tiles) && prep.tiles.length > 1) {
          const tileBytes = prep.tiles.reduce((sum, t) => sum + (t?.buffer?.length || 0), 0);
          if (totalBytes + tileBytes > deps.MAX_MEDIA_BYTES) {
            out.push({ ...base, text: `（${noun}切成 ${prep.tiles.length} 段后总大小超限，已跳过）` });
            continue;
          }
          totalBytes += tileBytes;
          const total = prep.tiles.length;
          prep.tiles.forEach((tile, i) => {
            const hint = `${i === 0 ? `这是一张被切开的超长截图，共 ${total} 段，按顺序看；` : ''}长图第 ${i + 1}/${total} 段`;
            out.push({
              ...base,
              mimeType: tile.mimeType,
              data: tile.buffer.toString('base64'),
              text: prep.note && i === 0 ? `${hint}（${prep.note}）` : hint
            });
          });
          continue;
        }
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > deps.MAX_MEDIA_BYTES) {
            out.push({ ...base, text: `（${noun}总大小超限，已跳过）` });
            continue;
          }
          totalBytes += prep.buffer.length;
          const imgMem = await deps.imageMemoryEnsureSeen?.(`${noun}${index}`, prep, kind), imgMemText = imgMem?.desc ? `[画面描述·${imgMem.hit ? '本地档案' : '本次识图已存档'}] ${imgMem.desc}` : '';
          out.push({
            ...base,
            ...(imgMem?.desc ? {} : { mimeType: prep.mimeType, data: prep.buffer.toString('base64') }),
            text: [prep.note ? `（${prep.note}）` : '', imgMemText].filter(Boolean).join(' ')
          });
        } else if (prep && !prep.ok) {
          out.push({ ...base, text: `（${noun}获取失败：${prep.error}）` });
        } else {
          out.push({ ...base, text: `（${noun}获取失败）` });
        }
      }
    }
    return out;
  }
// @bridge-function fetchMediaData:end

// @bridge-function mediaHintFor:start
function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    // 这一轮上下文里有图 → 记一笔（内存 + 会话状态），让随后（或此刻）的 ensureChatModel 必须选能看图的模型。
    // reserved2 下这是「图还没回来、但马上要回来」的唯一信号，早于模型选型。
    if (mediaList.some((m) => m && (m.kind === 'image'
      || (m.kind === 'sticker' && deps.cfg?.socialV2?.mediaVision?.stickers === true)))) (0, deps.markMediaTurn)(key);
    if (deps.currentMode === 'reserved2') {
      return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"。`;
    }
    return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。`;
  }
// @bridge-function mediaHintFor:end

// @bridge-function findMessageMedia:start
function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (deps.currentMode === 'reserved2' || deps.socialV2.conversations.has(key)) {
      try {
        const st = (0, deps.getSocialV2State)(key);
        if (st) {
          // Unread can outlive the recent window. Compact model views retain
          // handles instead of transport URLs, so both buffers must resolve.
          for (const messages of [st.recentMessages, st.unread]) {
            const found = (Array.isArray(messages) ? messages : []).find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
            if (found && Array.isArray(found.media) && found.media.length) return found.media;
          }
        }
      } catch {}
    }
    // 一代/普通模式：messageMediaStore
    const byRef = deps.messageMediaStore.get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }
// @bridge-function findMessageMedia:end
  return { resolveMediaList, fetchMediaData, mediaHintFor, findMessageMedia };
}
