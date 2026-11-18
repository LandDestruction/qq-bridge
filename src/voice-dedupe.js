// 「QQ 官方语音合成即发送」的去重判定。纯函数，无 IO —— 单独成文件是为了能离线单测。
//
// 背景：QQ 的 get_ai_record 一返回，语音就已经发进目标群了，所以后续「发送」必须跳过，
// 否则群里会多一条一模一样的语音。
//
// 原来的实现只按会话 key 记一个时间戳（30 秒窗口），于是 sendVoiceForV2 里任何一次
// 发送都会在窗口内被静默吞掉并返回 ok:true —— 包括 qq_send_voice 发语音库文件、
// tts: 前缀、[语音] 前缀。模型以为发出去了，群里什么也没有。
//
// 现在标记带一个**递增序号**：只有调用方拿着「本次刚合成那条」的序号来发送才跳过，
// 别的语音（语音库文件、另一条 tts）照常发。

/** 合成后多久内不再重复合成/发送（毫秒）。 */
export const AUTO_VOICE_SKIP_MS = 30000;

/** 生成一条新标记：序号由调用方传入（全局递增），同一个 key 覆盖旧标记。 */
export function nextAutoVoiceMark({ seq, key = '', fingerprint = '', at = Date.now() } = {}) {
  const n = Math.max(0, Number(seq) || 0);
  return { seq: n, key: String(key ?? ''), fingerprint: String(fingerprint ?? ''), at: Number(at) || Date.now() };
}

/** 该会话刚合成过语音吗（用于拦住 30 秒内的重复合成）。 */
export function isRecentSynthesis(mark, { now = Date.now(), windowMs = AUTO_VOICE_SKIP_MS } = {}) {
  if (!mark || typeof mark !== 'object') return false;
  const at = Number(mark.at) || 0;
  if (!at) return false;
  const age = now - at;
  return age >= 0 && age < (Number(windowMs) || AUTO_VOICE_SKIP_MS);
}

/**
 * 这次发送是不是「刚合成那条」本身？
 *
 * @param {object|null} mark 该会话当前标记
 * @param {object|null} token 调用方持有的标记副本（{ seq, key }）；不传=不是合成产物
 * @returns {boolean} true 表示应跳过发送
 */
export function isOwnSynthesis(mark, token, { now = Date.now(), windowMs = AUTO_VOICE_SKIP_MS } = {}) {
  if (!mark || !token || typeof token !== 'object') return false;
  const seq = Number(token.seq) || 0;
  if (!seq || seq !== (Number(mark.seq) || 0)) return false;
  if (String(token.key ?? '') !== String(mark.key ?? '')) return false;
  // 指纹只在两边都有时才比较（调用方可以不传）。
  const fp = String(token.fingerprint ?? '');
  if (fp && String(mark.fingerprint ?? '') && fp !== String(mark.fingerprint)) return false;
  return isRecentSynthesis(mark, { now, windowMs });
}
