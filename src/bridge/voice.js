// voice: extracted bridge responsibilities; no startup side effects.
// Live dependencies: AUDIO_EXTS, AbortSignal, KNOWN_AGENT_TOKENS, ROOT, SENSITIVE_RE, appendActivity, captureSendGuard, cfg, cleanupTemp, describeAudio, describeSensitiveMatch, fetch, fs, getSocialV2State, inspectAudio, listAudioFiles, log, path, processAudioVolume, resolveAudioSource, safeJoinLibrary, saveSocialV2State, sendChain, sendPrivateViaTempSession, shouldAuditKey, truncateText, voiceSendTimes
// @bridge-function assertOutboundAuditOk:start
function assertOutboundAuditOk(deps, key, subject) {
    const text = String(subject ?? '');
    const hasKnownToken = [...deps.KNOWN_AGENT_TOKENS].some((t) => t && text.includes(t));
    if ((0, deps.shouldAuditKey)(key) && (deps.SENSITIVE_RE.test(text) || hasKnownToken)) {
      const vhit = hasKnownToken ? { name: 'known-agent-token', excerpt: '***' } : ((0, deps.describeSensitiveMatch)(subject) || { name: 'unknown', excerpt: '***' });
      (0, deps.log)(`⚠️ 语音发送被安全策略拦截 (${key})：规则=${vhit.name} 片段=${vhit.excerpt}`);
      (0, deps.appendActivity)(`${key} [voice] 发送被拦截（文件名疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      throw new Error('音频文件名疑似包含敏感信息（路径/凭据/会话令牌），已阻止发送；请重命名后再发');
    }
  }
// @bridge-function assertOutboundAuditOk:end

// @bridge-function voiceCfg:start
function voiceCfg(deps) {
    const v = deps.cfg.socialV2?.voice ?? {};
    return {
      enabled: v.enabled !== false,
      dir: deps.path.resolve(deps.ROOT, String(v.dir ?? 'audio')),
      maxSeconds: Number(v.maxSeconds) > 0 ? Number(v.maxSeconds) : 300,
      maxBytes: Number(v.maxBytes) > 0 ? Number(v.maxBytes) : 20 * 1024 * 1024,
      maxPerMinute: Number(v.maxPerMinute) >= 0 ? Number(v.maxPerMinute) : 2,
      maxPerHour: Number(v.maxPerHour) >= 0 ? Number(v.maxPerHour) : 10,
      allowAbsolutePath: v.allowAbsolutePath === true,
      defaultVolume: Number(v.defaultVolume) > 0 ? Number(v.defaultVolume) : 1,
      loudness: v.loudness || 'normal',
      brightness: Number(v.brightness) || 0,
      ffmpegPath: process.env.FFMPEG_PATH || v.ffmpegPath || null,
      autoReadback: v.autoReadback !== false
    };
  }
// @bridge-function voiceCfg:end

// @bridge-function voiceLibrary:start
function voiceLibrary(deps) {
    const dir = voiceCfg(deps).dir;
    const files = (0, deps.listAudioFiles)(dir);
    return files.map((f) => {
      let stat = null;
      try { stat = deps.fs.statSync(f); } catch {}
      return { name: deps.path.relative(dir, f).split(deps.path.sep).join('/'), bytes: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0 };
    });
  }
// @bridge-function voiceLibrary:end

// @bridge-function voicePathInsideLibrary:start
function voicePathInsideLibrary(deps, vc, absPath) {
    const rel = deps.path.relative(vc.dir, absPath);
    if (!rel || rel.startsWith('..') || deps.path.isAbsolute(rel)) return null;
    if (!deps.fs.existsSync(absPath) || !deps.fs.statSync(absPath).isFile()) return null;
    return (0, deps.safeJoinLibrary)(vc.dir, rel);
  }
// @bridge-function voicePathInsideLibrary:end

// @bridge-function resolveVoicePathForV2:start
function resolveVoicePathForV2(deps, input) {
    const vc = voiceCfg(deps);
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频：给语音库里的文件名（可用 qq_list_voices 查看）');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受语音库里的本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const isAbs = deps.path.isAbsolute(raw) || /^file:\/\//i.test(raw) || raw.startsWith('~');

    let resolved = null;
    if (isAbs) {
      const r = (0, deps.resolveAudioSource)(raw, {});
      const confined = r.path ? voicePathInsideLibrary(deps, vc, r.path) : null;
      if (confined) {
        resolved = { path: confined, via: `${r.via}+library-confined` };
      } else {
        // 只报目录名，不报绝对路径：这条消息会经 MCP 工具错误回给模型，
        // 而模型面对的是不可信的群聊内容（prompt injection 可能诱导它复述本机路径）。
        throw new Error(`语音只能从语音库取文件（语音库目录：${deps.path.basename(vc.dir)}）；即使是绝对路径也必须位于语音库之内（socialV2.voice.allowAbsolutePath 已不再放宽 AI 通道）。请把音频放进语音库，或用操作者通道（CLI / 控制台）发送库外文件。`);
      }
    } else {
      // ⚠️ 安全关键：相对路径**只能**在语音库内解析。
      //
      // 不能直接丢给 resolveAudioSource —— 它会**先用 process.cwd() 解析相对路径**
      // （voice-core.js 的 cwd 分支），于是 AI 传 `..\..\某个\本机文件.mp3` 就能读库外文件，
      // 把 allowAbsolutePath=false 这个闸门整个绕过去（实测可复现）。
      // 相对路径一律先过 safeJoinLibrary（含 realpath 复核，挡 symlink 逃逸）。
      const joined = (0, deps.safeJoinLibrary)(vc.dir, raw);
      if (joined && deps.fs.existsSync(joined) && deps.fs.statSync(joined).isFile()) {
        resolved = { path: joined, via: 'voice-dir-safe' };
      } else {
        // 允许省略扩展名：逐个补常见扩展名再在库内试一次（仍然不越出语音库）
        if (!deps.path.extname(raw)) {
          for (const ext of deps.AUDIO_EXTS) {
            const cand = (0, deps.safeJoinLibrary)(vc.dir, `${raw}${ext}`);
            if (cand && deps.fs.existsSync(cand) && deps.fs.statSync(cand).isFile()) {
              resolved = { path: cand, via: 'voice-dir-safe+ext' };
              break;
            }
          }
        }
        if (!resolved) {
          // 库内没找到：检查是不是"想读库外文件"（这条错误要说清楚，避免误以为是名字写错）
          const looksLikeEscape = /(^|[\\/])\.\.([\\/]|$)/.test(raw) || deps.path.isAbsolute(raw);
          if (looksLikeEscape) {
            throw new Error('语音只能从语音库取文件：路径里出现了「..」或绝对路径，已拒绝（防止读到库外的本机文件）');
          }
        }
      }
    }

    if (resolved) return { path: resolved.path, via: resolved.via, resolvedFrom: raw };

    // 模糊提示：只列库内文件（绝不回显库外路径）
    const library = voiceLibrary(deps);
    const hint = library.length
      ? `语音库里现有：${library.slice(0, 12).map((x) => x.name).join('、')}${library.length > 12 ? ` 等 ${library.length} 个` : ''}`
      : `语音库（${deps.path.basename(vc.dir)}）目前是空的，先把音频文件放进去`;
    // 按 basename 去扩展名做近似匹配（只用于提示）
    const want = deps.path.basename(raw).toLowerCase();
    const wantNoExt = want.replace(/\.[^.]+$/, '');
    const fuzzyHits = library
      .filter((x) => {
        const base = deps.path.basename(x.name).toLowerCase();
        return base === want || base.replace(/\.[^.]+$/, '') === wantNoExt;
      })
      .map((x) => x.name);
    const fuzzy = fuzzyHits.length ? `；近似匹配：${fuzzyHits.join('、')}` : '';
    throw new Error(`语音库里找不到「${raw}」${fuzzy}。${hint}`);
  }
// @bridge-function resolveVoicePathForV2:end

// @bridge-function resolveVoicePathForOperator:start
function resolveVoicePathForOperator(deps, input) {
    const vc = voiceCfg(deps);
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频路径');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const r = (0, deps.resolveAudioSource)(raw, { voiceDir: vc.dir });
    if (r.path) return { path: r.path, via: r.via, resolvedFrom: raw };
    const fuzzy = r.candidates?.length ? `；语音库近似匹配：${r.candidates.map((c) => deps.path.basename(c.path)).join('、')}` : '';
    throw new Error(`找不到音频「${raw}」${fuzzy}`);
  }
// @bridge-function resolveVoicePathForOperator:end

// @bridge-function voiceBudgetCheck:start
function voiceBudgetCheck(deps, scopeKey, cfgV) {
    const now = Date.now();
    const bucket = deps.voiceSendTimes.get(scopeKey) ?? [];
    const inMinute = bucket.filter((t) => now - t < 60000);
    const inHour = bucket.filter((t) => now - t < 3600000);
    if (cfgV.maxPerMinute > 0 && inMinute.length + 1 > cfgV.maxPerMinute) {
      throw new Error(`语音发送频率超限（每分钟最多 ${cfgV.maxPerMinute} 条），请稍后再试`);
    }
    if (cfgV.maxPerHour > 0 && inHour.length + 1 > cfgV.maxPerHour) {
      throw new Error(`语音发送频率超限（每小时最多 ${cfgV.maxPerHour} 条），请稍后再试`);
    }
  }
// @bridge-function voiceBudgetCheck:end

// @bridge-function voiceBudgetCommit:start
function voiceBudgetCommit(deps, scopeKey, at = Date.now()) {
    const bucket = (deps.voiceSendTimes.get(scopeKey) ?? []).filter((t) => at - t < 3600000);
    bucket.push(at);
    deps.voiceSendTimes.set(scopeKey, bucket);
  }
// @bridge-function voiceBudgetCommit:end

// @bridge-function sendVoiceV2:start
async function sendVoiceV2(deps, key, filePath, { guard = false, audit = true, audio = null } = {}) {
    const vc = voiceCfg(deps);
    // 注意：这里**不检查** vc.enabled —— 那是「AI 能不能发语音」的开关，判定放在
    // AI 路由（/api/socialV2/send-voice）与 sendVoiceForV2 里。底层只管发，
    // 否则"默认不启用"会连操作者通道（CLI / 控制台面板 / 图形界面）一起封死。
    if (audit) assertOutboundAuditOk(deps, key, `[语音:${deps.path.basename(filePath)}]`);
    let info;
    try {
      info = await (0, deps.inspectAudio)(filePath, { maxBytes: vc.maxBytes, maxSeconds: vc.maxSeconds });
    } catch (error) {
      throw new Error(`音频检查失败：${error?.message ?? error}`);
    }
    if (!info.ok) throw new Error(`音频不可发送：${info.error}`);

    // 音量处理（默认原样 → 不产生临时文件）
    let processed;
    try {
      processed = await (0, deps.processAudioVolume)(filePath, {
        volume: audio?.volume ?? vc.defaultVolume,
        normalize: audio?.normalize === true,
        loudness: audio?.loudness ?? vc.loudness,
        brightness: audio?.brightness ?? vc.brightness,
        ffmpegPath: vc.ffmpegPath
      });
    } catch (error) {
      throw new Error(`音量处理失败：${error?.message ?? error}`);
    }
    const sendPath = processed.path;

    const assertSendAllowed = guard ? (0, deps.captureSendGuard)(key) : null;
    const [kind, id] = key.split(':');
    const recordSegment = { type: 'record', data: { file: sendPath } };
    let resolveSend;
    let rejectSend;
    const sendPromise = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
    deps.sendChain = deps.sendChain.then(async () => {
      try {
        if (assertSendAllowed) assertSendAllowed();
        (0, deps.assertIdentitySendAllowed)();
        await (0, deps.reserveSendSlot)('voice', ''); // 语音前后多留一会儿：合成完立刻再发一条最容易触发风控
        // 语音条大、要过 SILK 转码，给 60s 预算（与文本共用 sendChain：语音发完前文本自然排队，不会插队）。
        const httpUrl = String(deps.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
        const params = kind === 'private'
          ? { user_id: Number(id), message: [recordSegment] }
          : { group_id: Number(id), message: [recordSegment] };
        await (0, deps.assertFreshHttpIdentitySendAllowed)();
        const res = await (0, deps.fetch)(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: deps.AbortSignal.timeout(60000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          // 非好友私聊：改用临时会话（带共同群 group_id）再发一次语音。
          if (kind === 'private' && /好友|result=16/i.test(String(body.wording || ''))) {
            const viaTemp = await (0, deps.sendPrivateViaTempSession)(Number(id), [recordSegment]);
            if (viaTemp) { resolveSend({ message_id: null, viaTempSession: true }); return; }
          }
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        resolveSend(body.data);
      } catch (error) {
        rejectSend(error);
      }
    });
    try {
      const data = await sendPromise;
      return {
        messageId: data?.message_id ?? null,
        bytes: info.size,
        duration: info.duration ?? null,
        codec: info.codec ?? '',
        warnings: info.warnings ?? [],
        detail: (0, deps.describeAudio)(info),
        // 音量处理信息：mode='original' 表示没动过（没产生临时文件）
        audioProcessing: processed.detail,
        volume: processed.volume,
        loudness: processed.loudness,
        audioMode: processed.mode
      };
    } finally {
      // 音量处理产物是一次性的：发完（或失败）就删，别把 temp 撑大
      (0, deps.cleanupTemp)(sendPath, processed.converted);
    }
  }
// @bridge-function sendVoiceV2:end

// @bridge-function recordVoiceSentV2:start
function recordVoiceSentV2(deps, key, sent, label) {
    const st = (0, deps.getSocialV2State)(key);
    const display = label || `[语音 ${sent.detail}]`;
    const entry = {
      messageId: sent.messageId ? String(sent.messageId) : null,
      sender: '我',
      text: (0, deps.truncateText)(display, 200),
      plain: (0, deps.truncateText)(display, 200),
      quoteTargetIsSelf: false,
      isOwner: true,
      ownerLabel: '我',
      isSelf: true,
      at: Date.now(),
      time: Date.now()
    };
    st.recentMessages.push(entry);
    if (st.recentMessages.length > 200) st.recentMessages = st.recentMessages.slice(-200);
    st.lastAiReplyAt = entry.at;
    st.lastActionAt = entry.at;
    st.wakeConfig.noActionCount = 0;
    (0, deps.saveSocialV2State)();
  }
// @bridge-function recordVoiceSentV2:end

// @bridge-function verifyVoiceMessageSent:start
async function verifyVoiceMessageSent(deps, messageId) {
    if (!messageId) return null;
    try {
      const httpUrl = String(deps.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await (0, deps.fetch)(`${httpUrl}/get_msg`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify({ message_id: Number(messageId) }),
        signal: deps.AbortSignal.timeout(30000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) return null;
      const segments = Array.isArray(body.data?.message) ? body.data.message : [];
      const record = segments.find((s) => s?.type === 'record');
      if (!record) return null;
      // 注意：只回报「确认成功 + 时长」，**不回传 file/url**。
      // 私聊消息里 get_msg 会把源文件路径塞进 url（如 <本机路径>\audio\xxx.mp3），
      // 回给 AI 就等于把本机路径写进模型上下文（也会被敏感信息审计拦）。
      return {
        confirmed: true,
        duration: record.data?.duration != null ? Number(record.data.duration) : null
      };
    } catch (error) {
      (0, deps.log)(`[voice] 发送后回读校验失败（不影响已发送）：${error?.message ?? error}`);
      return null;
    }
  }
// @bridge-function verifyVoiceMessageSent:end
export function createVoice(deps) {
  return {
    assertOutboundAuditOk: (key, subject) => assertOutboundAuditOk(deps, key, subject),
    voiceCfg: () => voiceCfg(deps),
    voiceLibrary: () => voiceLibrary(deps),
    voicePathInsideLibrary: (vc, absPath) => voicePathInsideLibrary(deps, vc, absPath),
    resolveVoicePathForV2: (input) => resolveVoicePathForV2(deps, input),
    resolveVoicePathForOperator: (input) => resolveVoicePathForOperator(deps, input),
    voiceBudgetCheck: (scopeKey, cfgV) => voiceBudgetCheck(deps, scopeKey, cfgV),
    voiceBudgetCommit: (scopeKey, at) => voiceBudgetCommit(deps, scopeKey, at),
    sendVoiceV2: (key, filePath, opts) => sendVoiceV2(deps, key, filePath, opts),
    recordVoiceSentV2: (key, sent, label) => recordVoiceSentV2(deps, key, sent, label),
    verifyVoiceMessageSent: (messageId) => verifyVoiceMessageSent(deps, messageId)
  };
}
