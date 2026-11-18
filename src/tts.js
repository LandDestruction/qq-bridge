// QQ AI 语音（TTS）的纯逻辑：文本清洗、角色映射、SILK 判定、合成目标选择。
//
// 为什么单独成文件：真正的发送走 bridge.js 里已有的 sendVoiceForV2（音量/频率/审计/回读都在那），
// 这里只放「合成前」和「合成后」的判定，它们全是边界：
//   · 文本里混进 CQ 码、Markdown、URL 会被人声念出来（很傻），必须先洗；
//   · QQ 的 AI 语音接口有长度上限，超长会直接失败，得先截断并告诉调用方；
//   · 合成接口是「群维度」的（要 group_id），私聊发送要借一个群做合成；
//   · 返回的音频是 SILK_V3 裸流，没有容器头，扩展名必须是 .silk 才会被发送层跳过转码。
// 这些判定抽出来后，`scripts/test-tts.mjs` 可以逐条覆盖，不必真的合成音频。

/** 默认音色：元气少女（甜系）。 */
export const TTS_DEFAULT_VOICE = 'lucy-voice-xueling';

/** 常用甜系音色的中文别名 → QQ 角色 id（其余 id 直接透传）。 */
export const TTS_VOICES = {
  元气少女: 'lucy-voice-xueling',
  文艺少女: 'lucy-voice-f37',
  邻家小妹: 'lucy-voice-female1',
  傲娇少女: 'lucy-voice-f38',
  酥心御姐: 'lucy-voice-suxinjiejie',
  妲己: 'lucy-voice-daji'
};

export const TTS_MAX_CHARS_DEFAULT = 100;
export const TTS_MAX_CHARS_CAP = 300;

/**
 * 把「AI 给的音色」解析成 QQ 角色 id。
 * 接受：中文别名、完整 id、空（默认）。其它字符串按 id 透传（QQ 侧不认识会自己报错）。
 */
export function resolveTtsVoice(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return TTS_DEFAULT_VOICE;
  if (TTS_VOICES[raw]) return TTS_VOICES[raw];
  return raw;
}

/** 字数上限：默认 100，夹在 [1, 300]。 */
export function clampTtsMaxChars(configured) {
  const n = Number(configured);
  if (!Number.isFinite(n) || n <= 0) return TTS_MAX_CHARS_DEFAULT;
  return Math.min(TTS_MAX_CHARS_CAP, Math.max(1, Math.round(n)));
}

/**
 * 清洗朗读文本。
 * - 去掉 CQ 码（[CQ:image,file=...] 会被念出来）
 * - 去掉 Markdown 记号（**、`、#、链接语法）与裸 URL
 * - 折叠空白、去掉零宽字符
 * - 按上限截断，并告诉调用方是否发生了截断
 * @returns {{ text: string, truncated: boolean }}
 */
export function sanitizeTtsText(raw, maxChars = TTS_MAX_CHARS_DEFAULT) {
  const limit = clampTtsMaxChars(maxChars);
  let s = String(raw ?? '');
  s = s.replace(/\[CQ:[^\]]*\]/gi, ' ');
  s = s.replace(/https?:\/\/\S+/gi, ' ');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/[*_~#>|]+/g, ' ');
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  // 中文之间不需要空格：TTS 念到空格会停顿，把「唱 歌」这种断句拉直。
  s = s.replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '');
  // 朗读不需要结尾的标点堆叠
  s = s.replace(/[，。！？、；：,.!?;:]{2,}$/g, (m) => m.slice(0, 1));
  if (s.length <= limit) return { text: s, truncated: false };
  return { text: s.slice(0, limit), truncated: true };
}

/** 判断是否是 QQ 原生 SILK_V3 裸流（头 9 字节：#!SILK_V3，前面可有 0x02 长度前缀）。 */
export function isSilkV3(buf) {
  if (!buf || typeof buf.length !== 'number' || buf.length < 10) return false;
  const start = buf[0] === 0x02 ? 1 : 0;
  return buf.subarray(start, start + 9).toString('latin1') === '#!SILK_V3';
}

/**
 * 选择「合成用的群」：AI 语音接口要 group_id。
 * 优先用配置里的 synthGroupId，否则取白名单里的第一个群；都没有就返回 null（调用方报错）。
 */
export function pickSynthGroup({ configured, allowedGroups } = {}) {
  const n = Number(configured);
  if (Number.isInteger(n) && n > 0) return n;
  const list = Array.isArray(allowedGroups) ? allowedGroups.map(Number).filter((x) => Number.isInteger(x) && x > 0) : [];
  return list.length ? list[0] : null;
}

/** 语音文件的稳定命名：文本哈希 + 时间戳，避免同文本重复覆盖。 */
export function ttsFileName(text, nowMs = Date.now()) {
  let hash = 0;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return `tts-${hash.toString(16).padStart(8, '0')}-${nowMs}.silk`;
}

/** 把 OneBot 的失败码翻成人话（AI 语音常见的几种）。 */
export function describeTtsError(retcode, wording) {
  const code = Number(retcode);
  if (code === 100) {
    const w = String(wording ?? '');
    if (/MediaData is Empty/i.test(w)) return 'AI 语音合成失败：QQ 侧没有返回音频（文本可能含不支持的内容，或角色 id 不对）';
    if (/group/i.test(w)) return `AI 语音合成失败：群参数无效（${w.slice(0, 120)}）`;
    return `AI 语音合成失败：${w.slice(0, 160) || '未知错误'}`;
  }
  return `AI 语音合成失败（retcode=${retcode ?? '?'}）：${String(wording ?? '').slice(0, 160)}`;
}

/** 前缀形式：[语音] / 【语音】 / [voice] / [tts]，后面跟要朗读的文本。 */
const VOICE_DIRECTIVE_RE = /^[\s\u3000]*[【\[]\s*(?:语音|voice|tts)\s*[】\]]\s*([\s\S]*)$/i;

/**
 * 解析「语音指令前缀」。桥接侧兜底通道用：MCP 工具还没刷新时，
 * 模型把消息写成 `[语音]晚上好呀` 也能发出语音。
 * @returns {{ isVoice: boolean, text: string }}
 */
export function parseVoiceDirective(raw) {
  const s = String(raw ?? '');
  const m = VOICE_DIRECTIVE_RE.exec(s);
  if (!m) return { isVoice: false, text: s };
  return { isVoice: true, text: m[1] };
}

/** 对方这句话是不是「明确在要声音」？（用于本轮提示，不替她做决定）
 * 只认「动词 + 语音/声音」或单独的唱/哼/念给我听；抱怨、疑问、否定一律不算：
 * 「怎么会把语音消息发别的地方」不是要，是质问。
 */
const VOICE_REQUEST_RE = /(?:发|来|整|唱|哼|说|念|讲|用|听|听听|想听|换成|改成)[^。！？!?]{0,6}(?:语音|声音)/;
const VOICE_SOLO_RE = /(?:唱|哼)(?:一|两|个|首|段|句)?[^。！？!?]{0,6}(?:歌|曲|调|来听|听听)?|念(?:给我|一句|一段|个)/;
const VOICE_NEGATIVE_RE = /(?:别|不要|不用|甭|怎么|为什么|为啥|凭什么|谁让|哪来的|发错|发别)/;
export function wantsVoiceReply(text) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 120) return false;
  if (VOICE_NEGATIVE_RE.test(s)) return false;
  return VOICE_REQUEST_RE.test(s) || VOICE_SOLO_RE.test(s);
}
