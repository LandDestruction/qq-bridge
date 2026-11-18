// tts: extracted bridge responsibilities; no startup side effects.
// Live dependencies: AbortSignal, ROOT, appendActivity, autoVoiceSentAt, autoVoiceSeq, cfg, fetch, fs, isOwnSynthesis, isRecentSynthesis, log, nextAutoVoiceMark, path, recordVoiceSentV2, resolveAudioProcessing, resolveVoicePathForV2, sendVoiceV2, ttsModulePromise, verifyVoiceMessageSent, voiceBudgetCheck, voiceBudgetCommit, voiceCfg
// 从 createTts 提升到模块级的纯函数：只按情绪关键词匹配场景，不依赖 deps。
function pickGsvScene(spoken, t) {
function pickGsvScene(spoken, t) {
    const scenes = t.gsvScenes;
    if (!scenes) return null;
    const RULES = [
      ['comfort', /别怕|没关系|没事|陪|安慰|别难过|放心|抱抱|不哭|辛苦啦|缓缓/],
      ['sad', /难过|伤心|哭|离开|失去|想念|遗憾|抱歉|对不起|消失|舍不得|眼泪/],
      ['thanks', /谢谢|感谢|不客气|多谢|辛苦/],
      ['surprise', /咦|哇|什么|居然|难道|天哪|惊讶|不会吧|真的假的/],
      ['solemn', /发誓|立誓|命运|郑重|严肃|宣告|宣布|誓言|起誓/],
      ['cheer', /加油|太棒|好耶|开心|高兴|一起|冲呀|冲鸭|棒棒|真棒/],
      ['playful', /嘿嘿|哈哈|调皮|捉弄|逗你|开玩笑|略略略|略略|才不/],
      ['explain', /因为|所以|首先|其实|比如|说明|解释|步骤|方法|原理|意思是|简单来说/],
    ];
    for (const [name, re] of RULES) {
      if (re.test(spoken)) {
        const sc = scenes[name];
        if (sc && sc.ref && sc.prompt) return sc;
      }
    }
    return null;
  }}

export function createTts(deps) {
// @bridge-function ttsHelpers:start
function ttsHelpers() {
    deps.ttsModulePromise ??= import("../tts.js");
    return deps.ttsModulePromise;
  }
// @bridge-function ttsHelpers:end
// @bridge-function ttsPromptHint:start
function ttsPromptHint() {
    if (!ttsCfg().enabled || !(0, deps.voiceCfg)().enabled) return '';
    return '【你可以发语音，日常默认用语音（只在信息密集时才打字）】\n'
      + '想用声音说话时，调用 qq_send_tts（text=要说的话）。voice 只在 provider 为 QQ 官方语音时生效；当前的角色音/Edge 会忽略它。\n'
      + '如果工具列表里没有 qq_send_tts，就用 qq_send_message，把消息开头写成 [语音]（例：[语音]晚安呀，今天辛苦啦），效果一样。\n'
      + '什么时候用语音：日常闲聊、接梗、撒娇、道晚安/早安、表达情绪、哼歌、念台词、回应亲昵（被喊妈妈、被夸、被贴贴、被撩）→ 都优先发语音，更像真人；'
      + '只有讲道理、解释操作、给长信息、列清单、复述大段事实 → 才用文字。一条语音就是一条消息，不能同条带文字，想补充另发一条。\n'
      + '语音别只说一两个字：宁可一句完整的 20~60 字（带点情绪、语气词），也别只剩「好」「嗯」；超过 200 字会被截断。\n'
      + '注意：你**可以**发语音，不要说「我只会打字」「我说了不算」；同一条内容也别在多个会话里重复发。\n\n';
  }
// @bridge-function ttsPromptHint:end

// @bridge-function ttsCfg:start
function ttsCfg() {
    const t = deps.cfg.socialV2?.tts ?? {};
    const v = deps.cfg.socialV2?.voice ?? {};
    return {
      enabled: t.enabled !== false,
      autoWhenAsked: t.autoWhenAsked === true,
      provider: (['local', 'edge', 'qq', 'gsv'].includes(t.provider) ? t.provider : 'qq'),
      gsvUrl: String(t.gsvUrl ?? 'http://127.0.0.1:9880').replace(/\/+$/, ''),
      gsvRef: String(t.gsvRef ?? 'data/voice/march7/ref.wav'),
      gsvPromptText: String(t.gsvPromptText ?? '为了取得你的信任，咱们就先自爆家门，流光一停，你应该再熟悉不过了吧'),
      gsvSpeed: Number(t.gsvSpeed) > 0 ? Number(t.gsvSpeed) : 1.08,
      gsvTopK: Number(t.gsvTopK) > 0 ? Number(t.gsvTopK) : 10,
      gsvTemperature: Number(t.gsvTemperature) > 0 ? Number(t.gsvTemperature) : 0.6,
      gsvMaxChars: Number(t.gsvMaxChars) > 0 ? Number(t.gsvMaxChars) : 400,
      gsvTimeoutMs: Number(t.gsvTimeoutMs) > 0 ? Number(t.gsvTimeoutMs) : 180000,
      gsvScenes: (t.gsvScenes && typeof t.gsvScenes === 'object') ? t.gsvScenes : null,
      edgeRate: String(t.edgeRate ?? '+6%'),
      edgePitch: String(t.edgePitch ?? '+3Hz'),
      style: String(t.style ?? 'sweet'),
      speaker: String(t.speaker ?? 'female_1'),
      speed: Number(t.speed) > 0 ? Number(t.speed) : 1.12,
      localUrl: String(t.localUrl ?? 'http://127.0.0.1:8765').replace(/\/+$/, ''),
      voice: String(t.voice ?? ''),
      maxChars: Number(t.maxChars) > 0 ? Number(t.maxChars) : 0,
      synthGroupId: Number(t.synthGroupId) > 0 ? Number(t.synthGroupId) : null,
      timeoutMs: Number(t.timeoutMs) > 0 ? Number(t.timeoutMs) : 60000,
      dir: deps.path.join(deps.path.resolve(deps.ROOT, String(v.dir ?? 'audio')), 'tts')
    };
  }
// @bridge-function ttsCfg:end

// @bridge-function ttsCfgForKey:start
function ttsCfgForKey(key) {
    const base = ttsCfg();
    const table = deps.cfg.socialV2?.tts?.byKey;
    const override = table && typeof table === 'object' ? table[String(key || '')] : null;
    if (!override || typeof override !== 'object') return base;
    return { ...base, ...override };
  }
// @bridge-function ttsCfgForKey:end


// @bridge-function synthesizeLocalTts:start
async function synthesizeLocalTts(text, style) {
    const t = ttsCfg();
    const res = await (0, deps.fetch)(`${t.localUrl}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, style: style || t.style, speaker: t.speaker, speed: t.speed }),
      // 本机 TTS 是 CPU 合成：实测 22 个字 16 秒，机器一忙就奔 40~60 秒；
      // 原来卡 60 秒，正好落在「排到队但没合成完」的边界（13:45 那次 60.0s 被 abort）。
      signal: deps.AbortSignal.timeout(Math.max(120000, t.timeoutMs))
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`本地 TTS 失败（HTTP ${res.status}）：${detail.slice(0, 120)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new Error('本地 TTS 返回的音频过短');
    return buf;
  }
// @bridge-function synthesizeLocalTts:end

// @bridge-function synthesizeGsv:start
async function synthesizeGsv(text, opts = {}) {
    const t = ttsCfg();
    const speed = Number(opts.speed) > 0 ? Math.max(0.7, Math.min(1.4, Number(opts.speed))) : t.gsvSpeed;
    const TERM_MAP = [[/tokens?/gi, '词元'], [/prompts?/gi, '提示词'], [/API/g, '接口'], [/URL/g, '链接'], [/OK/g, '好的']];
    let spoken = String(text || '').replace(/[*#`_>]/g, '').replace(/\s+/g, ' ').trim();
    for (const [re, to] of TERM_MAP) spoken = spoken.replace(re, to);
    if (!spoken) throw new Error('没有可朗读的文本');
    if (Array.from(spoken).length > t.gsvMaxChars) spoken = Array.from(spoken).slice(0, t.gsvMaxChars).join('') + '。';
    const scene = pickGsvScene(spoken, t);
    const refPath = scene ? deps.path.resolve(deps.ROOT, scene.ref) : deps.path.resolve(deps.ROOT, t.gsvRef);
    const promptText = scene && scene.prompt ? scene.prompt : t.gsvPromptText;
    const res = await (0, deps.fetch)(`${t.gsvUrl}/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: spoken, text_lang: 'zh', ref_audio_path: refPath, prompt_text: promptText, prompt_lang: 'zh', text_split_method: 'cut5', media_type: 'wav', speed_factor: speed, top_k: t.gsvTopK, temperature: t.gsvTemperature }), signal: deps.AbortSignal.timeout(t.gsvTimeoutMs) });
    if (!res.ok) { const detail = await res.text().catch(() => ''); throw new Error(`角色音合成失败（HTTP ${res.status}）：${detail.slice(0, 160)}`); }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new Error('角色音合成返回的音频过短');
    return buf;
}
// @bridge-function synthesizeGsv:end

// @bridge-function synthesizeTts:start
async function synthesizeTts(text, voice, style, targetKey = '', opts = {}) {
    const t = ttsCfgForKey(targetKey);
    // QQ 官方 AI 语音会把语音直接发进「合成用的群」（实测：仓库里那条 record 就是合成时落群的），
    // 所以私聊目标绝不能走它，否则语音会窜到别的群。私聊的链路只能是 Edge → 本机 TTS。
    // 而 Edge 要连微软的 websocket，会抖；以前抖起来会一路落到 QQ 官方语音，然后报
    // 「只支持群聊目标」，用户看到的就是一条完全看不懂的错。所以私聊必须自带兜底。
    const isGroupTarget = /^group:\d+$/.test(String(targetKey || ''));
    const plan = !isGroupTarget
      ? (t.provider === 'gsv' ? ['gsv', 'edge', 'local'] : (t.provider === 'local' ? ['local', 'edge'] : ['edge', 'local']))
      : (t.provider === 'gsv' ? ['gsv', 'edge', 'qq'] : (t.provider === 'edge' ? ['edge', 'qq'] : (t.provider === 'local' ? ['local', 'qq'] : ['qq'])));
    const errors = [];
    // 每一档都试两遍：Edge 会「连上后被对端提前关掉」（code=1007），抖一下就好，
    // 单次失败就掉到下一档太浪费（13:44 那次就是这么两条都空了，用户只收到一句「没让过」）。
    const TTS_ATTEMPTS = 2;
    const backoff = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (const step of plan) {
      // QQ 官方 AI 语音绝不重试：它每合成一次就会把语音落进「合成群」一条，重试 = 群里多一条。
      const attemptsFor = step === 'qq' ? 1 : TTS_ATTEMPTS;
      for (let attempt = 1; attempt <= attemptsFor; attempt += 1) {
        const attemptStartedAt = Date.now();
        try {
          if (step === 'edge') {
            const edge = deps.edgeTtsModule || (await import("../edge-tts.js"));
            const buf = await edge.synthesizeEdgeTts(text, {
              voice: edge.resolveEdgeVoice(voice || t.voice),
              rate: t.edgeRate,
              pitch: t.edgePitch,
              timeoutMs: Math.max(15000, t.timeoutMs)
            });
            (0, deps.log)(`[tts] ${targetKey || '(空)'} edge 合成成功 ${Date.now() - attemptStartedAt}ms ${buf.length} 字节（第 ${attempt} 次）`);
            return { buf, groupId: null, provider: 'edge', ext: '.mp3' };
          }
          if (step === 'gsv') {
            const buf = await synthesizeGsv(text, opts);
            (0, deps.log)(`[tts] ${targetKey || '(空)'} gsv 合成成功 ${Date.now() - attemptStartedAt}ms ${buf.length} 字节（第 ${attempt} 次）`);
            return { buf, groupId: null, provider: 'gsv', ext: '.wav' };
          }
          if (step === 'local') {
            const buf = await synthesizeLocalTts(text, style);
            (0, deps.log)(`[tts] ${targetKey || '(空)'} local 合成成功 ${Date.now() - attemptStartedAt}ms ${buf.length} 字节（第 ${attempt} 次）`);
            return { buf, groupId: null, provider: 'local', ext: '.wav' };
          }
          const r = await synthesizeAiVoice(text, voice, targetKey);
          return { ...r, provider: 'qq', ext: '.silk' };
        } catch (error) {
          const message = error?.message ?? String(error);
          (0, deps.log)(`[tts] ${targetKey || '(空)'} ${step} 合成失败（第 ${attempt}/${attemptsFor} 次，${Date.now() - attemptStartedAt}ms）：${message}`);
          if (attempt >= attemptsFor) { errors.push(`${step}: ${message}`); break; }
          // 重试前等 400ms：刚被拒就连回去通常立刻再被拒，等一下命中率明显更高。
          await backoff(400);
        }
      }
    }
    if (!isGroupTarget) {
      throw new Error('私聊语音合成失败：Edge 与本机 TTS 都没成（' + errors.join('；') + '）。'
        + `私聊没有「合成群」，QQ 官方 AI 语音发不了；请确认本机 TTS 服务在 ${t.localUrl} 上跑着（config.json 的 socialV2.tts.localUrl）。`);
    }
    throw new Error('语音合成失败：' + errors.join('；'));
  }
// @bridge-function synthesizeTts:end

// @bridge-function synthesizeAiVoice:start
async function synthesizeAiVoice(text, voice, targetKey = '') {
    const helpers = await ttsHelpers();
    const markKey = String(targetKey || '');
    if ((0, deps.isRecentSynthesis)(deps.autoVoiceSentAt.get(markKey))) {
      throw new Error('刚刚已经发过一条语音了，30 秒内不重复合成（避免同一条语音在群里出现两次）');
    }
    const t = ttsCfg();
    const targetGroup = /^group:(\d+)$/.exec(String(targetKey || ''));
    // 只用「目标群自己」合成：QQ 会把语音直接发进这个群，正好就是目标；
    // 私聊没有目标群，必须由调用方先分流到 Edge，这里直接拒绝，避免泄漏到任意群。
    if (!targetGroup) throw new Error('QQ 官方 AI 语音只支持群聊目标（私聊请用 Edge）');
    const groupId = Number(targetGroup[1]);
    if (!groupId) {
      throw new Error('AI 语音缺少合成群：请配置 socialV2.tts.synthGroupId，或在 allow.groups 里至少留一个群');
    }
    const httpUrl = String(deps.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await (0, deps.fetch)(`${httpUrl}/get_ai_record`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify({ group_id: groupId, character: voice, text, chat_type: 1 }),
      signal: deps.AbortSignal.timeout(t.timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      throw new Error(helpers.describeTtsError(body.retcode, body.wording));
    }
    const url = String(body.data ?? '');
    if (!/^https?:\/\//i.test(url)) throw new Error('AI 语音合成失败：接口没有返回音频地址');
    // 接口一返回，QQ 就已经把语音发进这个群了：标记要在下载/校验之前打上，否则后面的
    // 任何失败都会让模型重试，于是群里出现第二条。
    // 序号每次递增：只有拿着这一条标记来发送才会被跳过，别的语音照常发。
    deps.autoVoiceSeq += 1;
    let autoMark = (0, deps.nextAutoVoiceMark)({ seq: deps.autoVoiceSeq, key: markKey, at: Date.now() });
    deps.autoVoiceSentAt.set(markKey, autoMark);
    const audio = await (0, deps.fetch)(url, { signal: deps.AbortSignal.timeout(t.timeoutMs) });
    if (!audio.ok) throw new Error(`AI 语音下载失败：HTTP ${audio.status}`);
    const buf = Buffer.from(await audio.arrayBuffer());
    if (!buf.length) throw new Error('AI 语音下载失败：音频为空');
    autoMark = (0, deps.nextAutoVoiceMark)({ ...autoMark, at: Date.now() });
    deps.autoVoiceSentAt.set(markKey, autoMark);
    // 发送层要求是 QQ 原生 SILK；接口变格式时这里直接报错，而不是发一条放不出来的语音。
    if (!helpers.isSilkV3(buf)) {
      // QQ 偶尔返回非 SILK_V3 的音频（接口变动）：原样交给网关，失败由网关报，
      // 这里硬失败只会让模型重试 → 群里多一条。
      (0, deps.log)(`[tts] 警告：AI 语音不是 SILK_V3 头，按原样交给网关`);
    }
    return { buf, groupId, autoToken: { seq: autoMark.seq, key: autoMark.key } };
  }
// @bridge-function synthesizeAiVoice:end

// @bridge-function voiceDirectiveSend:start
async function voiceDirectiveSend(key, rawText, label = 'tts-directive') {
    const helpers = await ttsHelpers();
    if (!ttsCfg().enabled) return { ok: false, status: 403, error: 'AI 语音功能已关闭（socialV2.tts.enabled=false）' };
    if (!(0, deps.voiceCfg)().enabled) return { ok: false, status: 403, error: '语音发送已关闭（socialV2.voice.enabled=false）' };
    const spoken = helpers.sanitizeTtsText(rawText, helpers.clampTtsMaxChars(ttsCfg().maxChars));
    if (!spoken.text) return { ok: false, status: 400, error: '[语音] 后面没有可朗读的内容' };
    const voiceName = helpers.resolveTtsVoice(ttsCfgForKey(key).voice);
    try {
      const synth = await synthesizeTts(spoken.text, voiceName, ttsCfgForKey(key).style, key);
      deps.fs.mkdirSync(ttsCfg().dir, { recursive: true });
      const fname = helpers.ttsFileName(spoken.text, Date.now()).replace(/\.silk$/, synth.ext || '.silk');
      const abs = deps.path.join(ttsCfg().dir, fname);
      deps.fs.writeFileSync(abs, synth.buf);
      const rel = deps.path.relative((0, deps.voiceCfg)().dir, abs).split(deps.path.sep).join('/');
      if (synth.provider === 'qq') {
        // QQ 官方语音在合成阶段就把语音发进目标群了（实测：get_ai_record 后群里立刻多一条 record），
        // 这里再调用发送会重复，所以直接返回「已由合成通道送达」。
        (0, deps.log)(`[tts] ${key} 已由 QQ 官方语音直接发入群（合成即发送）${fname}`);
        return { ok: true, via: 'tts', provider: 'qq', key, voice: voiceName, text: spoken.text, file: rel, sent: { auto: true, note: 'QQ 合成时已直接发入目标群，未重复发送' } };
      }
      const sent = await sendVoiceForV2(key, rel, { label, autoToken: synth.autoToken });
      (0, deps.log)(`[tts] ${key} 已发送语音（[语音] 前缀）${fname}`);
      return { ok: true, via: 'tts', key, voice: voiceName, text: spoken.text, file: rel, sent };
    } catch (error) {
      (0, deps.log)(`[tts] ${key} 语音发送失败：${error?.message ?? error}`);
      return { ok: false, status: 502, error: String(error?.message ?? error) };
    }
  }
// @bridge-function voiceDirectiveSend:end

// @bridge-function sendVoiceForV2:start
async function sendVoiceForV2(key, voiceRef, { label = '', verify = null, readback = false, audio = null, autoToken = null } = {}) {
    // QQ 官方语音在合成阶段就已经发进目标群了，所以「刚合成那条」自己不必再发一次。
    // 判定必须带标记序号（autoToken）：只按会话 key + 30 秒窗口会把同一会话里
    // 语音库文件 / tts: / [语音] 的发送一起静默吞掉，调用方还拿到 ok:true。
    if ((0, deps.isOwnSynthesis)(deps.autoVoiceSentAt.get(String(key || '')), autoToken)) {
      // 不清标记：窗口内再来一次合成会被 synthesizeAiVoice 拦住，避免群里多一条。
      (0, deps.log)(`[voice] ${key} 已由 QQ 官方语音自动发入群，跳过重复发送`);
      return { auto: true, messageId: null, detail: 'QQ 合成直发', note: '未重复发送' };
    }
    const vc = (0, deps.voiceCfg)();
    if (!vc.enabled) throw new Error('语音功能已关闭（socialV2.voice.enabled=false）');
    const resolved = (0, deps.resolveVoicePathForV2)(voiceRef);
    // 音量参数校验前置（AI 传错时给出可读错误，而不是让 ffmpeg 报奇怪的错）
    if (audio) (0, deps.resolveAudioProcessing)({ volume: audio.volume ?? vc.defaultVolume, normalize: audio.normalize === true, loudness: audio.loudness ?? vc.loudness });
    (0, deps.voiceBudgetCheck)(key, vc);
    const sent = await (0, deps.sendVoiceV2)(key, resolved.path, { guard: true, audit: true, audio });
    (0, deps.voiceBudgetCommit)(key);
    (0, deps.recordVoiceSentV2)(key, sent, label);
    (0, deps.log)(`[voice] ${key} 已发送语音 ${deps.path.basename(resolved.path)} (${sent.detail}, messageId=${sent.messageId ?? '?'})`);
    (0, deps.appendActivity)(`${key} [voice] 发送语音 ${deps.path.basename(resolved.path)} (${sent.detail})`);
    let readbackText = null;
    const wantReadback = readback === true;
    if (wantReadback && sent.messageId) {
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
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.status === 'ok' && body.retcode === 0) readbackText = body.data?.text ?? '';
      } catch (error) {
        (0, deps.log)(`[voice] 语音转写回读失败（不影响已发送）：${error?.message ?? error}`);
      }
    }
    // 默认做「回读到 record 段」的落地校验；转写按需（自己发的语音通常没有转写）。
    const wantVerify = verify === true || (verify !== false && vc.autoReadback);
    const verification = wantVerify ? await (0, deps.verifyVoiceMessageSent)(sent.messageId) : null;
    return { ...sent, key, file: resolved.path, via: resolved.via, verification, readback: readbackText };
  }
// @bridge-function sendVoiceForV2:end
  return { ttsHelpers, ttsPromptHint, ttsCfg, ttsCfgForKey, synthesizeLocalTts, synthesizeTts, synthesizeAiVoice, voiceDirectiveSend, sendVoiceForV2 };
}
