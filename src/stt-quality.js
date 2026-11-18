// STT / 视频分析的纯逻辑（D53）：参数构造、低置信判据、抽帧/分段计划。
// 独立成文件便于离线单测；不碰磁盘、不启动进程。

export const STT_DEFAULT_LANGUAGE = 'zh';
export const STT_DEFAULT_INITIAL_PROMPT = '以下是中文群聊语音，可能夹杂网络用语、游戏名和英文缩写。';

/** 低置信阈值（可调）：avg_logprob 越低越不可信；no_speech_prob 越高越像没人说话。 */
export const STT_LOW_LOGPROB = -0.85;
export const STT_HIGH_NO_SPEECH = 0.6;
export const STT_MIN_CHARS = 4;

/** 组装发给常驻服务的请求体（字段名与 tools/stt_server.py 对齐）。 */
export function buildSttRequest({
  path, language = STT_DEFAULT_LANGUAGE, initialPrompt = STT_DEFAULT_INITIAL_PROMPT,
  beamSize = 5, conditionOnPreviousText = false, vadFilter = true
} = {}) {
  return {
    path: String(path ?? ''),
    // 兼容老服务/老测试：同时带 lang 与 language，服务端两者都认。
    lang: String(language || STT_DEFAULT_LANGUAGE).slice(0, 16),
    language: String(language || STT_DEFAULT_LANGUAGE).slice(0, 16),
    initial_prompt: String(initialPrompt ?? '').slice(0, 240),
    beam_size: Math.min(10, Math.max(1, Math.round(Number(beamSize) || 5))),
    condition_on_previous_text: conditionOnPreviousText === true,
    vad_filter: vadFilter !== false
  };
}

/**
 * 重复幻觉检测：whisper 在静音/噪声尾巴上常把同一句复读 3~4 次（实测 medium 在测试音频上复读 4 次）。
 * 用「6~16 字的片段连续出现 3 次」判定，宁可判听不清，也不把复读当内容。
 */
export function hasRepetition(text) {
  const s = String(text ?? '');
  for (let len = 6; len <= 16; len += 1) {
    for (let i = 0; i + len * 3 <= s.length; i += 1) {
      const piece = s.slice(i, i + len);
      if (s.slice(i + len, i + 2 * len) === piece && s.slice(i + 2 * len, i + 3 * len) === piece) return true;
    }
  }
  return false;
}

/**
 * 低置信判据：宁可说「听不清」，也不把乱码当内容。
 * segments 里每段可带 avg_logprob / no_speech_prob（faster-whisper 原生字段）。
 * @returns {{lowConfidence:boolean, reason:string, chars:number, avgLogprob:number|null, noSpeechProb:number|null}}
 */
export function assessTranscript({ segments = [], text = '' } = {}) {
  const segs = Array.isArray(segments) ? segments : [];
  const body = String(text ?? '').trim();
  const chars = [...body].length;
  const nums = (key) => segs.map((s) => Number(s?.[key])).filter((n) => Number.isFinite(n));
  const avg = nums('avg_logprob');
  const nsp = nums('no_speech_prob');
  const avgLogprob = avg.length ? avg.reduce((a, b) => a + b, 0) / avg.length : null;
  const noSpeechProb = nsp.length ? nsp.reduce((a, b) => a + b, 0) / nsp.length : null;

  if (!chars) return { lowConfidence: true, reason: 'empty', chars, avgLogprob, noSpeechProb };
  if (chars < STT_MIN_CHARS) return { lowConfidence: true, reason: 'too_short', chars, avgLogprob, noSpeechProb };
  if (noSpeechProb != null && noSpeechProb > STT_HIGH_NO_SPEECH) {
    return { lowConfidence: true, reason: 'high_no_speech', chars, avgLogprob, noSpeechProb };
  }
  if (hasRepetition(body)) {
    return { lowConfidence: true, reason: 'repetition', chars, avgLogprob, noSpeechProb };
  }
  if (avgLogprob != null && avgLogprob < STT_LOW_LOGPROB) {
    return { lowConfidence: true, reason: 'low_logprob', chars, avgLogprob, noSpeechProb };
  }
  return { lowConfidence: false, reason: 'ok', chars, avgLogprob, noSpeechProb };
}

/** 视频抽帧计划：最长约 1 秒一帧，上限 maxFrames（默认 12），4×3 网格。 */
export function planFramePlan(durationSec, { maxFrames = 12, minFrames = 4 } = {}) {
  const dur = Number(durationSec);
  const safe = Number.isFinite(dur) && dur > 0 ? dur : 0;
  const cap = Math.max(1, Math.round(Number(maxFrames) || 12));
  const floor = Math.max(1, Math.round(Number(minFrames) || 4));
  const wanted = safe ? Math.ceil(safe) : floor;
  const count = Math.min(cap, Math.max(floor, wanted));
  const everySec = safe ? Math.max(0.25, safe / count) : 2;
  const cols = count <= 4 ? 2 : (count <= 9 ? 3 : 4);
  const rows = Math.ceil(count / cols);
  return { count, everySec, cols, rows, strategy: '1fps-capped' };
}

/** 长视频分段（默认 60 秒一段），用于 >60s 分开抽帧/转写，避免一次塞太多 token。 */
export function planVideoSegments(durationSec, { maxSec = 60 } = {}) {
  const dur = Number(durationSec);
  if (!Number.isFinite(dur) || dur <= 0) return [];
  const cap = Math.max(5, Math.min(300, Number(maxSec) || 60));
  const out = [];
  for (let start = 0; start < dur; start += cap) {
    out.push({ start: Math.round(start * 10) / 10, end: Math.round(Math.min(dur, start + cap) * 10) / 10 });
  }
  return out;
}

/** 模型降级链：primary → fallbacks（去重、去掉空值）。 */
export function sttFallbackChain({ model = 'medium', fallbacks = ['small'] } = {}) {
  const primary = String(model || '').trim();
  const list = (Array.isArray(fallbacks) ? fallbacks : [])
    .map((m) => String(m || '').trim()).filter(Boolean);
  return [...new Set([primary, ...list].filter(Boolean))];
}
