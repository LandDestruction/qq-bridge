// console/media-tools: extracted bridge responsibilities; no startup side effects.
// Live dependencies: AbortSignal, STATE_DIR, URL, appendActivity, applyStickerNote, applyStickerNoteV2, backfillStickerMd5, cfg, currentMode, describeAudio, fetch, fs, getSocialV2State, imagegenCfg, inspectAudio, log, md5Hex, mimeFromBuffer, modeAllowed, parseTargetKey, path, resolveAudioProcessing, resolveReplyTargetV2, resolveVoicePathForOperator, resolveVoicePathForV2, saveSocialV2State, saveStickerStoreSafe, scheduleReplyCheckV2, sendImageV2, sendStickerV2, sendVoiceForV2, sendVoiceV2, setStickerRemarkV2, shouldBlockSilentReply, stickerCandidates, stickerEnabled, stickerEntries, synthesizeTts, truncateText, ttsCfg, ttsCfgForKey, ttsHelpers, v2ToolEnabled, verifyVoiceMessageSent, voiceBudgetCheck, voiceBudgetCommit, voiceCfg
// 表情图字节的三段取法。注意：这个函数**必须留在本模块**——console-server 里那个
// requestBindings 的 fetchStickerImageBytes 从来就没有实现（裸标识符，模块化后就一直是
// ReferenceError），缩略图兜底与「检查修复」都靠这里。
//   A 直连：链接还有效时最快；
//   B 换签：QQ 多媒体直链带 rkey，过期就 400 —— 网关的 get_image 接受**原链接**并回一个新的签名
//     链接（实测 6 条过期链接全部换新成功），这是旧表情还能救回来的唯一路径；
//   C 按 file/md5 再问一次网关（别处已经写了缓存文件名的情况）。
async function fetchStickerImageBytes(deps, entry) {
  if (!entry) return null;
  const timeout = (ms) => deps.AbortSignal.timeout(ms);
  const download = async (url, ms) => {
    if (!url || !/^https?:/.test(String(url))) return null;
    try {
      const r = await (0, deps.fetch)(String(url), { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://qq.com/' }, signal: timeout(ms) });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return buf.length ? buf : null;
    } catch { return null; }
  };
  const direct = await download(entry.url, 15000);
  if (direct) return direct;
  const gatewayHost = String(deps.cfg.snowluma?.httpUrl || '').replace(/\/+$/, '');
  const auth = deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {};
  const askGateway = async (fileRef) => {
    if (!fileRef || !gatewayHost) return null;
    try {
      const jr = await (0, deps.fetch)(`${gatewayHost}/get_image`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ file: fileRef }),
        signal: timeout(10000)
      }).then((x) => x.json()).catch(() => null);
      const fresh = jr?.data?.url || jr?.data?.file;
      return download(fresh, 20000);
    } catch { return null; }
  };
  if (entry.url) {
    const resigned = await askGateway(String(entry.url));
    if (resigned) return resigned;
  }
  return askGateway(entry.file || (entry.md5 ? `${String(entry.md5).toLowerCase()}.jpg` : ''));
}


// 大图（几 MB 的动图）不原样写缓存：卡片只显示一百多像素，缩成单帧 JPEG。
// md5 仍按原图算（内容身份不变），所以去重与缓存文件名都不受影响。
async function shrinkStickerBytesForStore(deps, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length <= 300 * 1024) return buffer;
  try {
    const small = await (0, deps.scaleImageBuffer)(buffer, 320);
    if (Buffer.isBuffer(small) && small.length > 64 && small.length < buffer.length) return small;
  } catch { /* 缩图是优化，失败照存原图 */ }
  return buffer;
}

async function routeStickerThumbnail(deps, request) {
  const id = String(request.url.searchParams.get('id') ?? '').trim();
  const candidates = (0, deps.stickerCandidates)(deps.stickerEntries, id);
  if (!candidates.length) { request.sendJson({ ok: false, error: '找不到该表情' }, 404); return true; /* @bridge-handled */ }
  const cacheDir = deps.path.join(deps.STATE_DIR, 'sticker-files');
  const cachePathFor = (entry) => (entry.md5 ? deps.path.join(cacheDir, `${String(entry.md5).toUpperCase()}.img`) : '');
  const sendImage = (buf) => {
    // 先展开 SECURITY_HEADERS 再覆盖 Cache-Control：它带 'Cache-Control': 'no-store'，
    // 写成小写 'cache-control' 放在展开前会被后者顶掉，表情缩略图就变成每次重下。
    request.res.writeHead(200, {
      ...request.SECURITY_HEADERS,
      'content-type': (0, deps.mimeFromBuffer)(buf) || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400'
    });
    request.res.end(buf);
  };
  // 1) 任一候选有本地缓存：QQ 链接会过期，落过盘的直接读（不必等联网失败）
  for (const entry of candidates) {
    const p = cachePathFor(entry);
    if (!p) continue;
    try {
      const buf = deps.fs.readFileSync(p);
      if (buf.length) { sendImage(buf); return true; /* @bridge-handled */ }
    } catch {}
  }
  // 2) 逐个候选联网取；取到的顺手缓存，并把 md5 回填进库
  for (const entry of candidates) {
    const buf = await fetchStickerImageBytes(deps, entry);
    if (!buf?.length) continue;
    const digest = String(entry.md5 || (0, deps.md5Hex)(buf)).toUpperCase();
    try { deps.fs.mkdirSync(cacheDir, { recursive: true }); deps.fs.writeFileSync(deps.path.join(cacheDir, `${digest}.img`), buf); } catch {}
    if (!entry.md5 && (0, deps.backfillStickerMd5)(deps.stickerEntries, { id: entry.id, md5: digest, url: entry.url })) {
      entry.md5 = digest;
      (0, deps.saveStickerStoreSafe)();
      (0, deps.log)(`[sticker] 缩略图回填 md5：${entry.id.slice(0, 18)} → ${digest.slice(0, 8)}（之后不再依赖会过期的链接）`);
    }
    sendImage(buf);
    return true; /* @bridge-handled */
  }
  request.sendJson({
    ok: false,
    error: `图片源不可用（${candidates.length} 个候选都取不到，链接可能已过期）；可在控制台调用 POST /api/stickers/repair 清理/修复`
  }, 502);
  return true; /* @bridge-handled */
}

// 删除失效表情（缩略图拿不到时用）。
async function routeStickerRemove(deps, request) {
  const body = await request.readBody();
  const id = String(body.id ?? '').trim();
  if (!id) { request.sendJson({ ok: false, error: 'id 不能为空' }, 400); return true; /* @bridge-handled */ }
  const before = deps.stickerEntries.length;
  deps.stickerEntries = deps.stickerEntries.filter((e) => String(e.id) !== id);
  if (deps.stickerEntries.length === before) { request.sendJson({ ok: false, error: '找不到该表情' }, 404); return true; /* @bridge-handled */ }
  (0, deps.saveStickerStoreSafe)();
  (0, deps.log)('表情库：已删除 ' + id);
  request.sendJson({ ok: true, id, remaining: deps.stickerEntries.length });
  return true; /* @bridge-handled */
}

// 表情库修复（只处理「没有 md5 的收录表情」：这类条目缩略图完全依赖会过期的链接）：
// - 链接还能取到字节 → 算 md5、落本地缓存、回填 md5（以后永久可显示）；
// - 链接已失效且没缓存 → 标记为 dead；apply=true 时从库里删掉（只删 id+url 都匹配的那条，
//   避免误删同 id 的其他表情）。
// 默认预演（apply=false），控制台确认后再 apply。

async function routeStickerRepair(deps, request) {
  const body = await request.readBody();
  const apply = body?.apply === true;
  const cacheDir = deps.path.join(deps.STATE_DIR, 'sticker-files');
  const repaired = [];
  const dead = [];
  const failed = [];
  const cacheFileFor = (md5) => deps.path.join(cacheDir, `${String(md5).toUpperCase()}.img`);
  for (const entry of [...deps.stickerEntries]) {
    if (entry.md5) {
      // 之前修过一半的条目：md5 有了、缓存也有了，但 thumbStatus 还停在 missing
      // （旧版修复只回填 md5 不更新状态），这里直接扶正，不用再联网。
      const cached = cacheFileFor(entry.md5);
      if (entry.thumbStatus === 'ok' || !deps.fs.existsSync(cached)) continue;
      entry.thumbStatus = 'ok';
      entry.thumbError = '';
      entry.thumbBytes = deps.fs.statSync(cached).size;
      entry.updatedAt = new Date().toISOString();
      repaired.push({ id: entry.id, md5: entry.md5, bytes: entry.thumbBytes, cached: true });
      continue;
    }
    const buf = await fetchStickerImageBytes(deps, entry);
    if (!buf?.length) {
      const host = (() => { try { return new deps.URL(String(entry.url || '')).host; } catch { return ''; } })();
      dead.push({ id: entry.id, urlHost: host });
      if (apply) {
        deps.stickerEntries = deps.stickerEntries.filter((e) => !(String(e.id) === String(entry.id) && String(e.url || '') === String(entry.url || '')));
      }
      continue;
    }
    const stored = await shrinkStickerBytesForStore(deps, buf), digest = (0, deps.md5Hex)(buf);
    try { deps.fs.mkdirSync(cacheDir, { recursive: true }); deps.fs.writeFileSync(cacheFileFor(digest), stored); } catch (error) {
      failed.push({ id: entry.id, reason: `写缓存失败：${error?.message ?? error}` });
      continue;
    }
    repaired.push({ id: entry.id, md5: digest, bytes: buf.length });
    if (apply) {
      (0, deps.backfillStickerMd5)(deps.stickerEntries, { id: entry.id, md5: digest, url: entry.url });
      entry.md5 = digest;
      // 只回填 md5 不够：面板看的是 thumbStatus，不一起改就还是「缩略图不可用」。
      entry.thumbStatus = 'ok';
      entry.thumbError = '';
      entry.thumbBytes = stored.length;
      if (stored.length !== buf.length) entry.thumbShrunk = true;
      entry.updatedAt = new Date().toISOString();
    }
  }
  if (apply && (repaired.length || dead.length)) (0, deps.saveStickerStoreSafe)();
  (0, deps.log)(`表情库修复（${apply ? '已应用' : '预演'}）：可修复 ${repaired.length}，失效 ${dead.length}，失败 ${failed.length}`);
  request.sendJson({ ok: true, applied: apply, repaired, dead, failed, total: deps.stickerEntries.length });
  return true; /* @bridge-handled */
}

async function routeStickerPolicy(deps, request) {
  const body = await request.readBody();
  const id = String(body.id ?? '').trim();
  const policy = String(body.policy ?? '').trim();
  if (!id) { request.sendJson({ ok: false, error: 'id 不能为空' }, 400); return true; /* @bridge-handled */ }
  if (!['usable', 'understand-only'].includes(policy)) { request.sendJson({ ok: false, error: 'policy 必须是 usable 或 understand-only' }, 400); return true; /* @bridge-handled */ }
  const res = (0, deps.applyStickerNote)(deps.stickerEntries, id, { policy });
  if (!res.entry) { request.sendJson({ ok: false, error: '找不到该表情' }, 404); return true; /* @bridge-handled */ }
  deps.stickerEntries = res.entries;
  (0, deps.saveStickerStoreSafe)();
  (0, deps.log)(`表情库：${id} → ${policy}（控制台）`);
  request.sendJson({ ok: true, id, policy });
  return true; /* @bridge-handled */
}

async function routeStickerNote(deps, request) {
  if (!(0, deps.stickerEnabled)()) { request.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; /* @bridge-handled */ }
  const body = await request.readBody();
  const key = String(body.key ?? '').trim();
  const stickerId = String(body.stickerId ?? '').trim();
  if (!key || !stickerId) { request.sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('stickerNote')) { request.sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return true; /* @bridge-handled */ }
  const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
  const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
  const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
  const entry = (0, deps.applyStickerNoteV2)(stickerId, note, tags, usage);
  if (!entry) { request.sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return true; /* @bridge-handled */ }
  (0, deps.log)(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
  request.sendJson({ ok: true, key, sticker: entry });
  return true; /* @bridge-handled */
}

async function routeStickerRemark(deps, request) {
  if (!(0, deps.stickerEnabled)()) { request.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; /* @bridge-handled */ }
  const body = await request.readBody();
  const key = String(body.key ?? '').trim();
  const stickerId = String(body.stickerId ?? '').trim();
  if (!key || !stickerId) { request.sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('setStickerRemark')) { request.sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return true; /* @bridge-handled */ }
  try {
    const entry = await (0, deps.setStickerRemarkV2)(stickerId, String(body.remark ?? ''));
    (0, deps.log)(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
    request.sendJson({ ok: true, key, sticker: entry });
  } catch (error) {
    request.sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
  }
  return true; /* @bridge-handled */
}

// ── 语音发送（操作者通道：CLI / 控制台，凭 consoleToken） ──────────────
//
// 与 /api/send/* 的 agent 通道分开：操作者可能不在任何 QQ 会话里，
// 所以不套「会话/模式」闸门，但白名单 + 语音限流 + 文件名审计一个都不少。

async function routeVoiceOperator(deps, request) {
  const body = await request.readBody();
  const agentToken = String(request.req.headers['x-agent-token'] ?? '').trim();
  const voice = (0, deps.voiceCfg)();
  // 注意：这里是**操作者通道**（CLI / 控制台面板 / 图形界面），由控制台令牌鉴权。
  // socialV2.voice.enabled 是「AI 能不能发语音」的总闸，不该连你手动试发一起关掉——
  // 否则"默认不启用"会变成"谁都发不了"，连放音频试一下都做不到。
  // AI 通道的开关在 /api/socialV2/send-voice 里单独判定。
  // /api/send/voice 是 AI 工具入口：带 agent token 时一律按 agent 规则走，
  // 避免 AI 借用操作者通道绕过「只能发自己会话」的限制。
  if (request.url.pathname === '/api/send/voice' && agentToken) {
    request.sendJson({
      ok: false,
      error: 'AI 请改用 /api/socialV2/send-voice（带 key + token）'
    }, 403);
    return true; /* @bridge-handled */
  }
  const key = String(body.target ?? body.key ?? '').trim();
  const parsedTarget = (0, deps.parseTargetKey)(key);
  if (!parsedTarget) { request.sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return true; /* @bridge-handled */ }
  if (!(0, deps.modeAllowed)(key, parsedTarget.kind, Number(parsedTarget.id), deps.cfg, deps.currentMode)) {
    const a = deps.cfg.allow ?? {};
    request.sendJson({
      ok: false,
      error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`
    }, 403);
    return true; /* @bridge-handled */
  }
    return voiceOperatorProbe(deps, request, { key, voice, body });
}

async function voiceOperatorProbe(deps, request, ctx) {
  const { key, voice, body } = ctx;
  let resolved;
  try {
    resolved = (0, deps.resolveVoicePathForOperator)(body.file ?? body.path ?? '');
  } catch (error) {
    request.sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
    return true; /* @bridge-handled */
  }
  // 音量参数先校验（写错了当场告诉你，不要等到发的时候才炸）
  try {
    (0, deps.resolveAudioProcessing)({
      volume: body.volume ?? voice.defaultVolume,
      normalize: body.normalize === true,
      loudness: body.loudness ?? voice.loudness
    });
  } catch (error) {
    request.sendJson({ ok: false, error: error.message }, 400);
    return true; /* @bridge-handled */
  }
  const probe = await (0, deps.inspectAudio)(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
  if (!probe.ok) { request.sendJson({ ok: false, error: probe.error }, 400); return true; /* @bridge-handled */ }
  const preview = {
    key,
    file: resolved.path,
    via: resolved.via,
    bytes: probe.size,
    duration: probe.duration,
    codec: probe.codec,
    detail: (0, deps.describeAudio)(probe),
    warnings: probe.warnings ?? [],
    limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour }
  };
  if (body.dryRun === true) { request.sendJson({ ok: true, dryRun: true, ...preview }); return true; /* @bridge-handled */ }
    return voiceOperatorSend(deps, request, { key, body, voice, resolved, preview });
}

async function voiceOperatorSend(deps, request, ctx) {
  const { key, body, voice, resolved, preview } = ctx;
  const now = Date.now();
  try {
    (0, deps.voiceBudgetCheck)('operator:cli', voice);
    const sent = await (0, deps.sendVoiceV2)(key, resolved.path, {
      guard: false,
      audit: true,
      audio: {
        volume: body.volume ?? voice.defaultVolume,
        normalize: body.normalize === true,
        loudness: body.loudness ?? voice.loudness
      }
    });
    (0, deps.voiceBudgetCommit)('operator:cli', now);
    (0, deps.log)(`[voice] (操作者) ${key} 已发送语音 ${deps.path.basename(resolved.path)} (${sent.detail}${sent.audioMode === 'original' ? '' : '，' + sent.audioProcessing}, messageId=${sent.messageId ?? '?'})`);
    (0, deps.appendActivity)(`${key} [voice] (操作者) 发送语音 ${deps.path.basename(resolved.path)} (${sent.detail})`);
    // CLI 默认要落地校验（--verify 之外也能给出可信证据）；readback 仅在做"收到的语音"实验时用。
    const verification = body.verify === false ? null : await (0, deps.verifyVoiceMessageSent)(sent.messageId);
    let readbackText = null;
    if (body.readback === true && sent.messageId) {
      try {
        const httpUrl = String(deps.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const res = await (0, deps.fetch)(`${httpUrl}/fetch_ptt_text`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify({ message_id: String(sent.messageId) }),
          signal: deps.AbortSignal.timeout(30000)
        });
        const rb = await res.json().catch(() => ({}));
        if (res.ok && rb.status === 'ok' && rb.retcode === 0) readbackText = rb.data?.text ?? '';
      } catch (error) {
        (0, deps.log)(`[voice] 转写回读失败：${error?.message ?? error}`);
      }
    }
    request.sendJson({
      ok: true,
      ...preview,
      messageId: sent.messageId,
      verified: verification?.confirmed === true,
      readback: readbackText,
      audioProcessing: sent.audioProcessing,
      volume: sent.volume,
      loudness: sent.loudness
    });
  } catch (error) {
    request.sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
  }
  return true; /* @bridge-handled */
}

// ── 语音发送（AI 通道：reserved2 + agent token，只能发自己那个会话） ────
//
// AI 语音（TTS）：文本 → QQ 官方 AI 语音 → 作为语音条发出。

async function routeTts(deps, request) {
  const body = await request.readBody();
  const token = String(body.token ?? request.req.headers['x-agent-token'] ?? '').trim();
  const key = String(body.key ?? body.target ?? '').trim();
  const t = (0, deps.ttsCfg)();
  if (!t.enabled) { request.sendJson({ ok: false, error: 'AI 语音功能已关闭（socialV2.tts.enabled=false）' }, 403); return true; /* @bridge-handled */ }
  if (!(0, deps.voiceCfg)().enabled) { request.sendJson({ ok: false, error: '语音发送已关闭（socialV2.voice.enabled=false）' }, 403); return true; /* @bridge-handled */ }
  if (!key) { request.sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return true; /* @bridge-handled */ }
  if (deps.currentMode !== 'reserved2') { request.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; /* @bridge-handled */ }
  if (!token) { request.sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; /* @bridge-handled */ }
  if (!request.agentTokenOk(key, token)) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
  if (!(0, deps.v2ToolEnabled)('tts')) { request.sendJson({ ok: false, error: '工具未启用：qq_send_tts' }, 403); return true; /* @bridge-handled */ }
  if (!request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
  if ((0, deps.shouldBlockSilentReply)(key)) { request.sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; /* @bridge-handled */ }
  const keyMatch = /^(group|private):(\d+)$/.exec(key);
  if (!keyMatch) { request.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; /* @bridge-handled */ }
  if (!(0, deps.modeAllowed)(key, keyMatch[1], Number(keyMatch[2]), deps.cfg, deps.currentMode)) {
    request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
    return true; /* @bridge-handled */
  }
  const helpers = await (0, deps.ttsHelpers)();
  const { text, truncated } = helpers.sanitizeTtsText(body.text ?? body.content ?? '', helpers.clampTtsMaxChars(t.maxChars));
  if (!text) { request.sendJson({ ok: false, error: 'text 不能为空（清洗后没有可朗读的内容）' }, 400); return true; /* @bridge-handled */ }
  const styleForCall = (() => {
    const raw = String(body.style ?? '').trim();
    if (raw) return raw;
    const v = String(body.voice ?? '').trim();
    return ['sweet','cheerful','gentle','sad','calm'].includes(v) ? v : t.style;
  })();
  const voice = helpers.resolveTtsVoice(body.voice ?? t.voice);
  if (body.dryRun === true) {
    request.sendJson({ ok: true, dryRun: true, key, voice, text, truncated });
    return true; /* @bridge-handled */
  }
  let synth;
  try {
    synth = await (0, deps.synthesizeTts)(text, voice, styleForCall, key);
  } catch (error) {
    (0, deps.log)(`[tts] ${key} 合成失败：${error?.message ?? error}`);
    request.sendJson({ ok: false, error: String(error?.message ?? error) }, 502);
    return true; /* @bridge-handled */
  }
  try {
    deps.fs.mkdirSync(t.dir, { recursive: true });
    const fname = helpers.ttsFileName(text, Date.now()).replace(/\.silk$/, synth.ext || '.silk');
    const abs = deps.path.join(t.dir, fname);
    deps.fs.writeFileSync(abs, synth.buf);
    const rel = deps.path.relative((0, deps.voiceCfg)().dir, abs).split(deps.path.sep).join('/');
    const sent = await (0, deps.sendVoiceForV2)(key, rel, { label: '[语音]', autoToken: synth.autoToken });
    (0, deps.log)(`[tts] ${key} 已发送语音 ${fname}（voice=${voice}，provider=${synth.provider}，${synth.buf.length} 字节）`);
    request.sendJson({ ok: true, key, voice, text, truncated, bytes: synth.buf.length, file: rel, sent });
  } catch (error) {
    (0, deps.log)(`[tts] ${key} 发送失败：${error?.message ?? error}`);
    request.sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
  }
  return true; /* @bridge-handled */
}

async function sendVoiceTtsBranch(deps, request, ctx) {
  const { key, body } = ctx;
  // 现成的语音工具入口：voice 传 "tts:<文本>" 就现场合成一段 AI 语音再发。
  // 用 qq_send_voice 这个老工具承载，是为了不依赖 DSH 重启刷新 MCP 工具列表。
  const rawVoiceRef = String(body.voice ?? body.file ?? '').trim();
  if (/^tts[:：]/i.test(rawVoiceRef)) {
    const speakText = rawVoiceRef.replace(/^tts[:：]/i, '').trim();
    const helpers0 = await (0, deps.ttsHelpers)();
    const spoken0 = helpers0.sanitizeTtsText(speakText, helpers0.clampTtsMaxChars((0, deps.ttsCfg)().maxChars));
    if (!spoken0.text) { request.sendJson({ ok: false, error: 'tts: 后面没有可朗读的内容' }, 400); return true; /* @bridge-handled */ }
    if (!(0, deps.ttsCfg)().enabled) { request.sendJson({ ok: false, error: 'AI 语音功能已关闭（socialV2.tts.enabled=false）' }, 403); return true; /* @bridge-handled */ }
    const voiceName0 = helpers0.resolveTtsVoice((0, deps.ttsCfgForKey)(key).voice);
    try {
      const synth0 = await (0, deps.synthesizeTts)(spoken0.text, voiceName0, (0, deps.ttsCfgForKey)(key).style, key, { speed: body.speed });
      deps.fs.mkdirSync((0, deps.ttsCfg)().dir, { recursive: true });
      const fname0 = helpers0.ttsFileName(spoken0.text, Date.now()).replace(/\.silk$/, synth0.ext || '.silk');
      const abs0 = deps.path.join((0, deps.ttsCfg)().dir, fname0);
      deps.fs.writeFileSync(abs0, synth0.buf);
      const rel0 = deps.path.relative((0, deps.voiceCfg)().dir, abs0).split(deps.path.sep).join('/');
      const sent0 = await (0, deps.sendVoiceForV2)(key, rel0, { label: body.label ? String(body.label).slice(0, 100) : 'tts', autoToken: synth0.autoToken });
      (0, deps.log)(`[tts] ${key} 已发送语音（qq_send_voice + tts: 前缀）${fname0}`);
      request.sendJson({ ok: true, via: 'tts', key, voice: voiceName0, text: spoken0.text, file: rel0, sent: sent0 });
    } catch (error) {
      (0, deps.log)(`[tts] ${key} tts: 发送失败：${error?.message ?? error}`);
      request.sendJson({ ok: false, error: String(error?.message ?? error) }, 502);
    }
    return true; /* @bridge-handled */
  }
}

async function sendVoiceAfterBudget(deps, request, ctx) {
  const { key, body, voice, resolved } = ctx;
  try {
    if (body.dryRun === true) {
      const probe = await (0, deps.inspectAudio)(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
      if (!probe.ok) { request.sendJson({ ok: false, error: probe.error }, 400); return true; /* @bridge-handled */ }
      request.sendJson({ ok: true, dryRun: true, key, file: resolved.path, detail: (0, deps.describeAudio)(probe) });
      return true; /* @bridge-handled */
    }
    const sent = await (0, deps.sendVoiceForV2)(key, body.voice ?? body.file, {
      label: body.label ? String(body.label).slice(0, 100) : '',
      verify: body.verify,
      readback: body.readback === true,
      // AI 也可以调音量（默认走 config 的 defaultVolume）
      audio: (body.volume !== undefined || body.normalize === true || body.loudness !== undefined)
        ? { volume: body.volume, normalize: body.normalize === true, loudness: body.loudness }
        : null
    });
    request.sendJson({
      ok: true,
      key,
      messageId: sent.messageId,
      file: deps.path.basename(sent.file),
      detail: sent.detail,
      audioProcessing: sent.audioProcessing,
      // verified=true 表示已用 get_msg 回读到这条消息的 record 段（"真的发出去了"的硬证据）
      verified: sent.verification?.confirmed === true,
      readback: sent.readback,
      warnings: sent.warnings
    });
  } catch (error) {
    // 额度只在真正发出后才记账（voiceBudgetCommit），所以失败路径无需回滚。
    request.sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
  }
  return true;
}

async function routeSendSticker(deps, request) {
  if (!(0, deps.stickerEnabled)()) { request.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; /* @bridge-handled */ }
  const body = await request.readBody();
  const key = String(body.key ?? '').trim();
  const stickerId = String(body.stickerId ?? '').trim();
  const caption = String(body.message ?? body.caption ?? '').trim();
  const replyToMessageId = body.replyToMessageId;
  const atUserId = body.atUserId ?? null;
  if (!key || !stickerId) { request.sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; /* @bridge-handled */ }
  // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
  if (caption) {
    request.sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
    return true; /* @bridge-handled */
  }
  if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('sendSticker')) { request.sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return true; /* @bridge-handled */ }
  if (deps.currentMode !== 'reserved2') { request.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; /* @bridge-handled */ }
  if (!request.req.headers['x-agent-token']) { request.sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; /* @bridge-handled */ }
  const keyMatch = /^(group|private):(\d+)$/.exec(key);
  if (!keyMatch) { request.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; /* @bridge-handled */ }
  const kind = keyMatch[1];
  const id = Number(keyMatch[2]);
  if (!Number.isFinite(id) || id <= 0 || !(0, deps.modeAllowed)(key, kind, id, deps.cfg, deps.currentMode)) {
    request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
    return true; /* @bridge-handled */
  }
  if (kind === 'private' && atUserId) { request.sendJson({ ok: false, error: '私聊不需要 @' }, 400); return true; /* @bridge-handled */ }
  if ((0, deps.shouldBlockSilentReply)(key)) { request.sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; /* @bridge-handled */ }
  if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
    request.sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
    return true; /* @bridge-handled */
  }
  let quotedInfo = null;
  let actualReplyToMessageId = replyToMessageId;
  if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
    const stForReply = (0, deps.getSocialV2State)(key);
    const resolved = await (0, deps.resolveReplyTargetV2)(stForReply, kind, id, String(replyToMessageId).trim());
    if (!resolved) {
      request.sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
      return true; /* @bridge-handled */
    }
    quotedInfo = resolved.info;
    actualReplyToMessageId = resolved.messageId;
  }
    return sendStickerDispatch(deps, request, { key, stickerId, actualReplyToMessageId, quotedInfo, atUserId });
}

async function sendStickerDispatch(deps, request, ctx) {
  const { key, stickerId, actualReplyToMessageId, quotedInfo, atUserId } = ctx;
  const sendCfg = deps.cfg.socialV2?.send ?? {};
  const now = Date.now();
  try {
    const st = (0, deps.getSocialV2State)(key);
    const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
    const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
    const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
      request.sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
      return true; /* @bridge-handled */
    }
    st.sendTimes.push(now);
    if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
    const sent = await (0, deps.sendStickerV2)(key, stickerId, {
      replyToMessageId: actualReplyToMessageId,
      atUserId
    });
    // 时间线的自我消息由 sendStickerV2 统一回写（带 media，日志页能出表情小图），这里不再重复 push。
    const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
    const recentLimit = Number(deps.cfg.socialV2?.context?.recentLimit) || 100;
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.lastAiReplyAt = now;
    st.lastActionAt = now;
    st.wakeConfig.noActionCount = 0;
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    (0, deps.saveSocialV2State)();
    (0, deps.scheduleReplyCheckV2)(key);
    (0, deps.log)(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
    (0, deps.appendActivity)(`${key} [sticker] 工具发送表情：${label}`);
    request.sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
  } catch (error) {
    const st = (0, deps.getSocialV2State)(key);
    const idx = st.sendTimes.indexOf(now);
    if (idx >= 0) st.sendTimes.splice(idx, 1);
    if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
    (0, deps.saveSocialV2State)();
    (0, deps.log)(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
    request.sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
  }
  return true; /* @bridge-handled */
}

async function routeSendImage(deps, request) {
  if (deps.cfg.imagegen?.enabled === false) { request.sendJson({ ok: false, error: '出图/发图功能已关闭' }, 403); return true; /* @bridge-handled */ }
  const body = await request.readBody();
  const key = String(body.key ?? '').trim();
  const imageRef = String(body.imageRef ?? '').trim();
  const replyToMessageId = body.replyToMessageId;
  const atUserId = body.atUserId ?? null;
  if (!key || !imageRef) { request.sendJson({ ok: false, error: 'key 和 imageRef 不能为空' }, 400); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
  if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('sendImage')) { request.sendJson({ ok: false, error: '工具未启用：qq_send_image' }, 403); return true; /* @bridge-handled */ }
  if (deps.currentMode !== 'reserved2') { request.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; /* @bridge-handled */ }
  if (!request.req.headers['x-agent-token']) { request.sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; /* @bridge-handled */ }
  const keyMatch = /^(group|private):(\d+)$/.exec(key);
  if (!keyMatch) { request.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; /* @bridge-handled */ }
  const kind = keyMatch[1];
  const id = Number(keyMatch[2]);
  if (!Number.isFinite(id) || id <= 0 || !(0, deps.modeAllowed)(key, kind, id, deps.cfg, deps.currentMode)) {
    request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
    return true; /* @bridge-handled */
  }
  if (kind === 'private' && atUserId) { request.sendJson({ ok: false, error: '私聊不需要 @' }, 400); return true; /* @bridge-handled */ }
  if ((0, deps.shouldBlockSilentReply)(key)) { request.sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; /* @bridge-handled */ }
  const st = (0, deps.getSocialV2State)(key);
  const now = Date.now();
  // 发图频次限制（send-image 以前**完全没有限流**：agent 一旦循环发图就可能把 QQ 侧打到风控）。
  // 与 draw 的计数**刻意分开**：画一张（imagegen.drawTimes）和转一张的成本不同，
  // 共用一份会让「画图配额被转发挤占」，反而更难解释。
  // 取舍：只用进程内状态，重启清零 —— 这是「防循环」而不是「计费」，不需要跨重启精确。
  {
    const imgCfg = (0, deps.imagegenCfg)(deps.cfg);
    const cd = Number(imgCfg.sendImageCooldownMs) || 3000;
    const perHour = Number(imgCfg.sendImageMaxPerHour) || 120;
    const lastAt = Number(st.lastSendImageAt) || 0;
    if (lastAt && now - lastAt < cd) {
      const waitSec = Math.ceil((cd - (now - lastAt)) / 1000);
      request.sendJson({ ok: false, error: `发图太频繁，请 ${waitSec} 秒后再试` }, 429);
      return true; /* @bridge-handled */
    }
    const times = (st.sendImageTimes || []).filter((t) => now - t < 3600000);
    if (times.length + 1 > perHour) {
      request.sendJson({ ok: false, error: `发图太频繁（每小时上限 ${perHour} 张），请稍后再试` }, 429);
      return true; /* @bridge-handled */
    }
    st.sendImageTimes = times;
    st.sendImageTimes.push(now);
    st.lastSendImageAt = now;
    if (st.sendImageTimes.length > 500) st.sendImageTimes = st.sendImageTimes.slice(-500);
  }
  try {
    const sent = await (0, deps.sendImageV2)(key, imageRef, { replyToMessageId, atUserId });
    // 时间线的自我消息由 sendImageV2 统一回写（带 media），这里不再重复 push。
    const recentLimit = Number(deps.cfg.socialV2?.context?.recentLimit) || 100;
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.lastAiReplyAt = now;
    st.lastActionAt = now;
    st.wakeConfig.noActionCount = 0;
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    (0, deps.saveSocialV2State)();
    (0, deps.scheduleReplyCheckV2)(key);
    (0, deps.log)(`[image] 工具发送图片 ${key}`);
    (0, deps.appendActivity)(`${key} [image] 工具发送图片`);
    // 把档位与计费信息带回给模型，让它能自然复述「用的是免费档/今天还剩几次」。
    request.sendJson({
      ok: true, key, messageId: sent.messageId, sent: 1,
      tier, charged: drawn.charged, quota: drawn.quota, watermarked: drawn.watermarked, source: drawn.source
    });
  } catch (error) {
    (0, deps.log)(`[image] 工具发送图片失败 ${key}: ${error?.message ?? error}`);
    request.sendJson({ ok: false, error: `发送图片失败：${error?.message ?? error}` }, 500);
  }
  return true; /* @bridge-handled */
}

export function createConsoleMediaTools(deps) {
// @bridge-function handleConsoleMediaTools:start
async function handleConsoleMediaTools(request) {
  if (request.req.method === 'GET' && request.url.pathname === '/api/stickers/thumbnail') return routeStickerThumbnail(deps, request);
  if (request.req.method === 'POST' && request.url.pathname === '/api/stickers/remove') return routeStickerRemove(deps, request);
  if (request.req.method === 'POST' && request.url.pathname === '/api/stickers/repair') return routeStickerRepair(deps, request);
  if (request.req.method === 'POST' && request.url.pathname === '/api/stickers/policy') return routeStickerPolicy(deps, request);
  if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/sticker-note') return routeStickerNote(deps, request);
  if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/sticker-remark') return routeStickerRemark(deps, request);
  if (request.req.method === 'POST' && (request.url.pathname === '/api/voice/send' || request.url.pathname === '/api/send/voice')) return routeVoiceOperator(deps, request);
  if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/tts') return routeTts(deps, request);
  if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/send-voice') {
    const body = await request.readBody();
    const token = String(body.token ?? request.req.headers['x-agent-token'] ?? '').trim();
    const key = String(body.key ?? body.target ?? '').trim();
    const voice = (0, deps.voiceCfg)();
    if (!voice.enabled) { request.sendJson({ ok: false, error: '语音功能已关闭' }, 403); return true; /* @bridge-handled */ }
    if (!key) { request.sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return true; /* @bridge-handled */ }
    if (deps.currentMode !== 'reserved2') { request.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; /* @bridge-handled */ }
    if (!token) { request.sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; /* @bridge-handled */ }
    if (!request.agentTokenOk(key, token)) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
    if (!(0, deps.v2ToolEnabled)('sendVoice')) { request.sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return true; /* @bridge-handled */ }
    if (!request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
    if ((0, deps.shouldBlockSilentReply)(key)) { request.sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; /* @bridge-handled */ }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { request.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; /* @bridge-handled */ }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !(0, deps.modeAllowed)(key, kind, id, deps.cfg, deps.currentMode)) {
      request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true; /* @bridge-handled */
    }
    if (await sendVoiceTtsBranch(deps, request, { key, body })) return true;
    // 只要名字（解析）不要内容（预览）：dry-run 也必须经过与真发相同的解析与校验。
    let resolved;
    try {
      resolved = (0, deps.resolveVoicePathForV2)(body.voice ?? body.file ?? '');
    } catch (error) {
      request.sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
      return true; /* @bridge-handled */
    }
    try {
      (0, deps.voiceBudgetCheck)(key, voice);
    } catch (error) {
      request.sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
      return true; /* @bridge-handled */
    }
    return sendVoiceAfterBudget(deps, request, { key, body, voice, resolved });
  }
  if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/send-sticker') return routeSendSticker(deps, request);
  if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/send-image') return routeSendImage(deps, request);
  return false;
}
// @bridge-function handleConsoleMediaTools:end
  return { handleConsoleMediaTools };
}
