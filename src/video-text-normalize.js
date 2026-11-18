// 会话语录里「视频声音」那行的历史正文回填（纯函数，启动加载态时跑一遍）。
//
// 旧代码把「给模型的判断/指令」写进了消息正文：
//   `【视频声音】听不清（empty）：这段语音不可当作内容依据，别猜、别复述。 [视频 10 秒｜画面：…]`
// 控制台会话页直接显示正文，于是机器人的判断漏进了聊天记录。新代码只写事实
// （`声音：无` / `声音：听不清` / `声音：“原话”`），这里把**存量**消息按同一口径回填，
// 顺便把历史上被重复拼了两遍的正文收敛成一份。
//
// 只在加载状态时跑：正常消息没有 `【视频声音】` 字样，判断成本就是一次 includes。
const VIDEO_LINE = /\[视频[^\]]*\]/;
const VOICE_CHUNK = /【视频声音】[^【]*?(?=\[视频|【视频声音】|$)/g;

/**
 * 把一条旧正文换成「事实版」；不需要改时返回 null。
 * @param {string} text
 * @returns {string|null}
 */
export function normalizeVideoRecordText(text) {
  const src = String(text || '');
  if (!src.includes('【视频声音】')) return null;
  const videoMatch = src.match(VIDEO_LINE);
  const videoLine = videoMatch ? videoMatch[0] : '';
  let voice = '';
  const said = /【视频声音】原话转写：“([\s\S]*?)”/.exec(src);
  if (said) voice = `声音：“${said[1].trim()}”`;
  else if (/【视频声音】听不清/.test(src)) voice = '声音：听不清';
  else if (/【视频声音】没有可用的人声/.test(src)) voice = '声音：无';
  else if (/【视频声音】转写失败/.test(src)) voice = '声音：没转出来';
  else if (/【视频声音】转写中/.test(src)) voice = '声音：转写中';
  const rest = src
    .replace(VOICE_CHUNK, ' ')
    .replace(VIDEO_LINE, ' ')
    .replace(/这段语音不可当作内容依据[，,]?别猜、别复述。?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const next = [rest, videoLine, voice].filter(Boolean).join('\n').trim();
  return next && next !== src ? next : null;
}

/**
 * 批量回填（原地改，返回同一个数组；加载态时用，无额外分配）。
 * @param {Array<object>} list
 * @returns {Array<object>}
 */
export function normalizeVideoRecordMessages(list) {
  if (!Array.isArray(list)) return list;
  for (const msg of list) {
    if (!msg || typeof msg !== 'object') continue;
    if (typeof msg.text === 'string') {
      const next = normalizeVideoRecordText(msg.text);
      if (next) {
        msg.text = next;
        if (typeof msg.plain === 'string') msg.plain = next;
      }
    }
  }
  return list;
}
