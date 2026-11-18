// console/social-reads: extracted bridge responsibilities; no startup side effects.
// Live dependencies: ARCHIVE_RECALL_LIMIT, archiveRecall, buildSlangContext, buildStickerContext, buildStickerStrategyHint, cfg, computeWakeSafetyV2, confirmedSlangListV2, currentMode, currentRoleHint, currentRoleHintV2, formatMemoryV2, formatParticipationV2, getSocialV2State, noteModelMessagesV2, personaMaxChars, readRoleState, readThroughSeqV2, replyTimingV2, selfDisplayName, selfIdentityTextV2, selfUserId, slangEntries, stickerEnabled, stickerEntries, syncStickerLibrary, v2ToolEnabled, voiceCfg, voiceLibrary
// media-cache：聊天图片走本地缓存（QQ 直链带 rkey 会过期）。放在模块级，避免工厂函数超 300 行门槛。
const mediaCacheDir = (deps) => deps.path.join(deps.STATE_DIR, 'media-cache');
const MEDIA_CACHE_MAX_BYTES = 30 * 1024 * 1024;
// file 参数只接受 QQ 的图片文件名或 QQ 图床直链：文件名可能带中文/空格/括号（QQ 原样转发对方上传的名字），
// 这里只挡控制字符与路径分隔符；缓存文件名本身是 md5，不会把它当路径用。
function mediaFileNameOk(raw) {
  const name = String(raw);
  if (name.length < 5 || name.length > 180) return false;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  if (!['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'silk', 'amr', 'mp3', 'wav', 'ogg'].includes(ext)) return false;
  const bad = ['/', String.fromCharCode(92), ':', '*', '?', String.fromCharCode(34), '<', '>', '|'];
  for (let n = 0; n < name.length; n += 1) {
    const code = name.charCodeAt(n);
    if (code < 32 || code === 127) return false;
    if (bad.includes(name[n])) return false;
  }
  return true;
}
const MEDIA_URL_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:qpic\.cn|qq\.com|qq\.com\.cn|gtimg\.cn)(?::\d+)?\//i;
const AUDIO_EXT_RE = /\.(?:silk|amr|mp3|wav|ogg)$/i;

function mediaCachePathOf(deps, name) {
  if (!/^[a-f0-9]{20,64}\.img$/.test(name)) return '';
  return deps.path.join(mediaCacheDir(deps), name);
}
function mediaCacheKeyOf(deps, fileOrUrl) {
  return (0, deps.md5Hex)(Buffer.from(String(fileOrUrl), 'utf8')).toLowerCase();
}
function readMediaCache(deps, fileOrUrl) {
  const p = mediaCachePathOf(deps, mediaCacheKeyOf(deps, fileOrUrl) + '.img');
  if (!p) return null;
  try {
    const buf = deps.fs.readFileSync(p);
    return buf.length ? buf : null;
  } catch { return null; }
}
// 总量上限 500MB：聊天图动辄几 MB，不设闸会吃满磁盘。超了就不落盘（当次仍然照常返回字节）。
const MEDIA_CACHE_MAX_TOTAL = 500 * 1024 * 1024;
let mediaCacheTotal = null;
let mediaCacheTotalAt = 0;
function mediaCacheTotalBytes(deps, ) {
  const now = Date.now();
  if (mediaCacheTotal != null && now - mediaCacheTotalAt < 60000) return mediaCacheTotal;
  let total = 0;
  try {
    for (const name of deps.fs.readdirSync(mediaCacheDir(deps))) {
      try { total += deps.fs.statSync(deps.path.join(mediaCacheDir(deps), name)).size; } catch {}
    }
  } catch { total = 0; }
  mediaCacheTotal = total;
  mediaCacheTotalAt = now;
  return total;
}
function writeMediaCache(deps, fileOrUrl, buf) {
  try {
    deps.fs.mkdirSync(mediaCacheDir(deps), { recursive: true });
    if (mediaCacheTotalBytes(deps, ) + buf.length > MEDIA_CACHE_MAX_TOTAL) {
      return '';
    }
    const p = deps.path.join(mediaCacheDir(deps), mediaCacheKeyOf(deps, fileOrUrl) + '.img');
    const tmp = p + '.' + process.pid + '.tmp';
    deps.fs.writeFileSync(tmp, buf);
    deps.fs.renameSync(tmp, p);
    mediaCacheTotal = (mediaCacheTotal || 0) + buf.length;
    mediaCacheTotalAt = Date.now();
    return p;
  } catch (error) {
    (0, deps.log)(`[media-cache] 落盘失败：${error?.message ?? error}`);
    return '';
  }
}
async function fetchMediaBytes(deps, fileOrUrl) {
  const download = async (url) => {
    const r = await (0, deps.fetch)(url, {
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://qun.qq.com/' },
      signal: deps.AbortSignal.timeout(20000)
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length && buf.length <= MEDIA_CACHE_MAX_BYTES ? buf : null;
  };
  // 1) 直接下直链（签名还没过期时最快）
  if (/^https?:/i.test(fileOrUrl)) {
    try {
      const buf = await download(fileOrUrl);
      if (buf) return buf;
    } catch {}
  }
  const fileRef = /^https?:/i.test(fileOrUrl) ? deps.path.basename(new URL(fileOrUrl).pathname) : fileOrUrl;
  // 语音（record 段）走 get_record，并要 mp3：浏览器播不了 silk。
  if (AUDIO_EXT_RE.test(fileRef)) {
    try {
      const H = String(deps.cfg.snowluma?.httpUrl || '').replace(/\/+$/, '');
      const auth = deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {};
      const jr = await (0, deps.fetch)(`${H}/get_record`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ file: fileRef, out_format: 'mp3' }),
        signal: deps.AbortSignal.timeout(20000)
      }).then((x) => x.json()).catch(() => null);
      const data = jr && jr.data ? jr.data : {};
      if (data.base64) {
        const buf = Buffer.from(String(data.base64), 'base64');
        if (buf.length && buf.length <= MEDIA_CACHE_MAX_BYTES) return buf;
      }
      const freshAudio = data.url || data.file;
      if (freshAudio && /^https?:/i.test(freshAudio)) {
        const buf = await download(freshAudio);
        if (buf) return buf;
      }
      if (freshAudio && !/^https?:/i.test(freshAudio)) {
        const p2 = deps.path.resolve(String(freshAudio));
        try { if (deps.fs.statSync(p2).size <= MEDIA_CACHE_MAX_BYTES) return deps.fs.readFileSync(p2); } catch {}
      }
    } catch {}
  }
  // 2) 直链过期：让网关按文件名重新签一次（get_image 对老图也能给新链接）
  try {
    const H = String(deps.cfg.snowluma?.httpUrl || '').replace(/\/+$/, '');
    const auth = deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {};
    const jr = await (0, deps.fetch)(`${H}/get_image`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ file: fileRef }),
      signal: deps.AbortSignal.timeout(15000)
    }).then((x) => x.json()).catch(() => null);
    const data = jr && jr.data ? jr.data : {};
    if (data.base64) {
      const buf = Buffer.from(String(data.base64), 'base64');
      if (buf.length && buf.length <= MEDIA_CACHE_MAX_BYTES) return buf;
    }
    const freshUrl = data.url || data.file;
    if (freshUrl && /^https?:/i.test(freshUrl)) {
      const buf = await download(freshUrl);
      if (buf) return buf;
    }
  } catch {}
  return null;
}

// 纯函数：把「AI 黑名单成员」发的消息从模型可见列表里摘掉（保持原顺序，返回条数）。
// 只做判定，不碰状态；调用方负责决定只对模型面（x-agent-token）生效。
export function filterBlacklistedMessages(messages, isBlacklisted) {
  const list = Array.isArray(messages) ? messages : [];
  if (typeof isBlacklisted !== 'function') return { kept: list, hidden: 0 };
  const kept = [];
  let hidden = 0;
  for (const m of list) {
    let isBL = false;
    try {
      const uid = m && (m.userId ?? m.user_id ?? m.senderId);
      isBL = uid != null && uid !== '' && isBlacklisted(String(uid)) === true;
    } catch { isBL = false; }
    if (isBL) { hidden += 1; continue; }
    kept.push(m);
  }
  return { kept, hidden };
}
// 模型面消息出口（x-agent-token 才生效）：返回折叠后的列表与条数。
// 与 filterBlacklistedMessages 分开，是为了把「只对模型面生效」这条策略本身也测住。
export function scrubMessagesForModel(messages, isBlacklistedFn, isAgent) {
  const list = Array.isArray(messages) ? messages : [];
  if (isAgent !== true) return { messages: list, hiddenByBlacklist: 0 };
  const out = filterBlacklistedMessages(list, isBlacklistedFn);
  return { messages: out.kept, hiddenByBlacklist: out.hidden };
}
export function createConsoleSocialReads(deps) {
  // ── 聊天图片本地缓存 ───────────────────────────────────────────────────
  // QQ 的聊天图片直链带 rkey 签名，几小时到几天就失效（实测 10/10 条 multimedia.nt.qq.com.cn
  // 链接已经 400），前端直接 <img src> 就会裂成「部分图片加载失败」。这里改成浏览器只请求桥接，
  // 桥接负责「有缓存读缓存 / 没有就现取一次并落盘」，之后再失效也不影响。
  //
  // file 参数只接受两种形态：QQ 的图片文件名（A1B2….jpg）或 QQ 图床的 http(s) 链接；其余一律 400，
  // 免得变成任意 URL 抓取器（SSRF）。
  // 惰性求值：模块构造时不许碰 deps（test-bridge-modules 会抓「eager access」）
  // GET /api/socialV2/media-cache?file=<图片文件名或图床直链>&token=…
  // 命中缓存直接吐字节；没命中就现取一次并落盘（QQ 直链会过期，落过盘以后都能看）。
  async function serveMediaCache(request) {
    const raw = String(request.url.searchParams.get('file') ?? '').trim();
    if (!raw) { request.sendJson({ ok: false, error: '缺少 file 参数' }, 400); return true; /* @bridge-handled */ }
    if (!mediaFileNameOk(raw) && !MEDIA_URL_RE.test(raw)) {
      request.sendJson({ ok: false, error: '图片标识不被接受（只允许 QQ 图片文件名或图床直链）' }, 400);
      return true; /* @bridge-handled */
    }
    const sendBytes = (buf) => {
      request.res.writeHead(200, {
        'content-type': (0, deps.mimeFromBuffer)(buf) || 'image/jpeg',
        'cache-control': 'public, max-age=604800, immutable',
        ...request.SECURITY_HEADERS
      });
      request.res.end(buf);
    };
    const cached = readMediaCache(deps, raw);
    if (cached) { sendBytes(cached); return true; /* @bridge-handled */ }
    const fresh = await fetchMediaBytes(deps, raw);
    if (fresh) {
      writeMediaCache(deps, raw, fresh);
      sendBytes(fresh);
      return true; /* @bridge-handled */
    }
    // 兜底：消息里同时带的直链（有些动画表情的文件名网关查不到，直链反而能下）
    const alt = String(request.url.searchParams.get('alt') ?? '').trim();
    if (alt && MEDIA_URL_RE.test(alt)) {
      const fromAlt = await fetchMediaBytes(deps, alt);
      if (fromAlt) {
        writeMediaCache(deps, raw, fromAlt);
        sendBytes(fromAlt);
        return true; /* @bridge-handled */
      }
    }
    request.sendJson({ ok: false, error: '这张图已经取不回来了（QQ 直链过期且网关也拿不到）' }, 404);
    return true; /* @bridge-handled */
  }
// 模型面读消息时折叠 AI 黑名单成员的消息。
// 背景（2026-10-30 线上事故）：黑名单只拦「唤醒」，不拦「同一轮上下文里其他 AI 的消息」——
// 真人 @ 一下把模型叫醒后，它照样能读到黑名单 AI 的发言并接着互刷。这里在消息出口统一折叠，
// 只对带 x-agent-token 的模型调用生效；控制台/管理员仍然看得到全部（并在 hiddenByBlacklist 里报数）。
function scrubBlacklistedForModel(deps, key, messages, request) {
  const list = Array.isArray(messages) ? messages : [];
  const isAgent = Boolean(request?.req?.headers?.['x-agent-token']);
  try {
    const isBL = deps.isAiBlacklisted;
    const fn = typeof isBL === 'function' ? (uid) => isBL(key, uid) : null;
    return scrubMessagesForModel(list, fn, isAgent);
  } catch { return { messages: list, hiddenByBlacklist: 0 }; }
}
// @bridge-function handleConsoleSocialReads:start
async function handleConsoleSocialReads(request) {
        if (request.req.method === 'GET' && request.url.pathname === '/api/socialV2/media-cache') {
          return await serveMediaCache(request);
        }
        if (request.req.method === 'GET' && request.url.pathname === '/api/socialV2/state') {
          const key = String(request.url.searchParams.get('key') ?? '').trim();
          if (!key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('socialState')) { request.sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return true; /* @bridge-handled */ }
          const st = (0, deps.getSocialV2State)(key);
          request.sendJson({
            ok: true,
            key,
            wakeConfig: st.wakeConfig,
            wakeSafety: (0, deps.computeWakeSafetyV2)(st.wakeConfig),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt
          });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'GET' && request.url.pathname === '/api/socialV2/prompt') {
          const key = String(request.url.searchParams.get('key') ?? '').trim();
          if (!key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('getPrompt')) { request.sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return true; /* @bridge-handled */ }
          const st = (0, deps.getSocialV2State)(key);
          // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
          if (deps.cfg.socialV2?.sticker?.enabled !== false) {
            try { await (0, deps.syncStickerLibrary)(false); } catch {}
          }
          const roleState = (0, deps.readRoleState)();
          const toolMap = {
            getPrompt: 'qq_get_prompt',
            getUnread: 'qq_get_unread_messages',
            getRecent: 'qq_get_recent_messages',
            socialState: 'qq_social_state',
            sendGroup: 'qq_send_group_message',
            sendPrivate: 'qq_send_private_message',
            reply: 'qq_reply',
            sendBurst: 'qq_send_burst',
            sendMessage: 'qq_send_message',
            waitMessages: 'qq_wait_for_messages',
            feedback: 'qq_report_feedback',
            getMyRecent: 'qq_get_my_recent_messages',
            getMessageDetail: 'qq_get_message_detail',
            getActiveMembers: 'qq_get_active_members',
            setWakeConfig: 'qq_set_wake_config',
            markRead: 'qq_mark_read',
            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
            slangQuery: 'qq_slang_query',
            slangSubmit: 'qq_slang_submit',
            getImages: 'qq_get_message_images',
            getForwardMsg: 'qq_get_forward_msg',
            sendPoke: 'qq_send_poke',
            listStickers: 'qq_list_stickers',
            getStickerImage: 'qq_get_sticker_image',
            sendSticker: 'qq_send_sticker',
            setStickerRemark: 'qq_set_sticker_remark',
            stickerNote: 'qq_sticker_note',
            collectSticker: 'qq_collect_sticker',
            getSelfImage: 'qq_get_self_image',
            sendVoice: 'qq_send_voice / qq_list_voices',
            tts: 'qq_send_tts',
            setPersona: 'qq_set_persona'
          };
          const tools = deps.cfg.socialV2?.tools ?? {};
          const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
          const enabledTools = [];
          for (const [flag, name] of Object.entries(toolMap)) {
            if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !(0, deps.stickerEnabled)())) enabledTools.push(name);
          }
          request.sendJson({
            ok: true,
            key,
            time: new Date().toISOString(),
            // 机器人自己的身份：agent 需要它才能把「@樰」对到自己身上（issue #29）。
            self: {
              nickname: deps.selfDisplayName || null,
              userId: deps.selfUserId || null,
              line: (0, deps.selfIdentityTextV2)().trim() || null
            },
            role: { name: roleState.role ?? null, hint: deps.currentMode === 'reserved2' ? (0, deps.currentRoleHintV2)() : (0, deps.currentRoleHint)() },
            persona: st.persona?.text ? { text: st.persona.text, setAt: st.persona.setAt || 0, maxChars: (0, deps.personaMaxChars)() } : null,
            recommended: deps.cfg.socialV2?.provideRecommendations === false ? null : {
              wake: deps.cfg.socialV2?.wake ?? {},
              send: deps.cfg.socialV2?.send ?? {},
              wait: deps.cfg.socialV2?.wait ?? {},
              proactive: deps.cfg.socialV2?.proactive ?? {}
            },
            enabledTools,
            replyTiming: (0, deps.replyTimingV2)(st),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            currentWakeConfig: st.wakeConfig,
            wakeSafety: (0, deps.computeWakeSafetyV2)(st.wakeConfig),
            memory: (0, deps.formatMemoryV2)(st),
            participation: (0, deps.formatParticipationV2)(st),
            slang: {
              enabled: deps.cfg.slang?.enabled !== false,
              entries: (0, deps.confirmedSlangListV2)(),
              block: (0, deps.buildSlangContext)(deps.slangEntries, deps.cfg.slang?.injectMax ?? 8)
            },
            stickers: {
              enabled: deps.cfg.socialV2?.sticker?.enabled !== false,
              total: deps.stickerEntries.length,
              context: deps.cfg.socialV2?.sticker?.includeInPrompt !== false ? (0, deps.buildStickerContext)(deps.stickerEntries, deps.cfg.socialV2?.sticker?.promptMaxStickers ?? 8) : '',
              strategy: deps.cfg.socialV2?.sticker?.includeInPrompt !== false ? (0, deps.buildStickerStrategyHint)() : ''
            },
            // 语音库摘要：让 AI 一开始就知道有哪些语音可发（真发之前用 qq_list_voices 看详情）。
            voices: deps.cfg.socialV2?.voice?.enabled === false ? { enabled: false } : {
              enabled: true,
              total: (0, deps.voiceLibrary)().length,
              names: (0, deps.voiceLibrary)().slice(0, 12).map((v) => v.name),
              maxSeconds: (0, deps.voiceCfg)().maxSeconds,
              hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去'
            }
          });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'GET' && request.url.pathname === '/api/socialV2/unread') {
          const key = String(request.url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(request.url.searchParams.get('limit')) || 30));
          if (!key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('getUnread')) { request.sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return true; /* @bridge-handled */ }
          const afterRaw = request.url.searchParams.get('afterSeq');
          const afterSeq = afterRaw === null ? null : Number(afterRaw);
          if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
            request.sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
            return true; /* @bridge-handled */
          }
          const st = (0, deps.getSocialV2State)(key);
          // Preserve the old tail read by default; cursor paging lets a backlog
          // larger than one response be read completely, even outside recent.
          const messages = afterSeq === null ? st.unread.slice(-limit)
            : st.unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
          const readThroughSeq = request.req.headers['x-agent-token'] ? (0, deps.noteModelMessagesV2)(st, messages) : (0, deps.readThroughSeqV2)(st);
          const scrubbed = scrubBlacklistedForModel(deps, key, messages, request);
          request.sendJson({ ok: true, key, unreadCount: st.unread.length, messages: scrubbed.messages, hiddenByBlacklist: scrubbed.hiddenByBlacklist, readThroughSeq });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'GET' && request.url.pathname === '/api/socialV2/recent') {
          const key = String(request.url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(request.url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(request.url.searchParams.get('offset')) || 0);
          if (!key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('getRecent')) { request.sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return true; /* @bridge-handled */ }
          const st = (0, deps.getSocialV2State)(key);
          const start = Math.max(0, st.recentMessages.length - offset - limit);
          const end = Math.max(0, st.recentMessages.length - offset);
          const messages = st.recentMessages.slice(start, end);
          const readThroughSeq = request.req.headers['x-agent-token'] ? (0, deps.noteModelMessagesV2)(st, messages) : (0, deps.readThroughSeqV2)(st);
          const scrubbed = scrubBlacklistedForModel(deps, key, messages, request);
          request.sendJson({ ok: true, key, messages: scrubbed.messages, hiddenByBlacklist: scrubbed.hiddenByBlacklist, readThroughSeq });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/recall') {
          if (deps.cfg.archive?.enabled === false) { request.sendJson({ ok: false, error: '归档检索功能已关闭' }, 403); return true; /* @bridge-handled */ }
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          const query = String(body.query ?? '').trim();
          const limit = Number(body.limit) || deps.ARCHIVE_RECALL_LIMIT;
          if (!key || !query) { request.sendJson({ ok: false, error: 'key 和 query 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (deps.currentMode !== 'reserved2') { request.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; /* @bridge-handled */ }
          const results = (0, deps.archiveRecall)(key, query, Math.min(Math.max(limit, 1), 50));
          request.sendJson({ ok: true, key, query, count: results.length, results });
          return true; /* @bridge-handled */
        }
    return false;
  }
// @bridge-function handleConsoleSocialReads:end
  return { handleConsoleSocialReads };
}
