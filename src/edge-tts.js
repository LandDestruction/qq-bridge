// Edge TTS（微软 Edge 朗读接口）—— 免费、无需 key，音色比 ChatTTS 稳得多。
//
// 实现细节来自社区插件 dsh-plugin-tts 的可用参数（2026 版端点）：
//   wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1
//   ?Ocp-Apim-Subscription-Key=<token>&Sec-MS-GEC=<hash>&Sec-MS-GEC-Version=1-<chrome版>&ConnectionId=<hex>
// 关键点（自己试的时候踩过）：老端点 speech.platform.bing.com + TrustedClientToken 一律 403；
// 必须用新端点、参数名 Ocp-Apim-Subscription-Key、以及带 Origin: chrome-extension://...。
//
// 纯逻辑（token 计算、SSML 拼装、音色解析）抽成可导出函数，便于单测。

import { createHash, randomBytes } from 'node:crypto';

export const EDGE_TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
export const EDGE_CHROMIUM_VERSION = '143.0.3650.75';
export const EDGE_WSS_BASE = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';
export const EDGE_AUDIO_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

/** 常用中文女声（按甜度排序，第一个是默认）。 */
export const EDGE_VOICES = {
  xiaoxiao: 'zh-CN-XiaoxiaoNeural',
  xiaoxuan: 'zh-CN-XiaoxuanNeural',
  xiaoyi: 'zh-CN-XiaoyiNeural',
  xiaomeng: 'zh-CN-XiaomengNeural',
  xiaomo: 'zh-CN-XiaomoNeural',
  xiaoqiu: 'zh-CN-XiaoqiuNeural',
  xiaorui: 'zh-CN-XiaoruiNeural',
  xiaoshuang: 'zh-CN-XiaoshuangNeural',
  xiaoyan: 'zh-CN-XiaoyanNeural',
  xiaoyou: 'zh-CN-XiaoyouNeural',
  xiaozhen: 'zh-CN-XiaozhenNeural'
};
export const DEFAULT_EDGE_VOICE = EDGE_VOICES.xiaoxiao;

/** 中文别名/短名 → 完整 voice id。未知值按原样透传（Edge 侧会报 unsupported voice）。 */
export function resolveEdgeVoice(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return DEFAULT_EDGE_VOICE;
  const lower = raw.toLowerCase();
  if (EDGE_VOICES[lower]) return EDGE_VOICES[lower];
  if (Object.values(EDGE_VOICES).includes(raw)) return raw;
  return raw;
}

/**
 * Sec-MS-GEC 令牌：把当前时间换成 Windows FILETIME（100ns），按 300 秒向下取整，
 * 拼上 token 做 SHA-256 再大写。Edge 用它防重放。
 */
export function buildSecMsGec(nowMs = Date.now()) {
  const seconds = Math.floor(nowMs / 1000) + 11644473600;
  let ticks = BigInt(seconds) * 10000000n;
  ticks -= ticks % 3000000000n;
  return createHash('sha256').update(String(ticks) + EDGE_TRUSTED_TOKEN, 'ascii').digest('hex').toUpperCase();
}

export function xmlEscape(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 组装 SSML：rate/pitch/volume 用 Edge 的百分比与 Hz 语法。 */
export function buildSsml(text, { voice = DEFAULT_EDGE_VOICE, rate = '+0%', pitch = '+0Hz', volume = '+0%' } = {}) {
  return '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN">'
    + '<voice name="' + xmlEscape(voice) + '">'
    + '<prosody rate="' + xmlEscape(rate) + '" pitch="' + xmlEscape(pitch) + '" volume="' + xmlEscape(volume) + '">'
    + xmlEscape(text)
    + '</prosody></voice></speak>';
}

export function buildEdgeUrl(nowMs = Date.now(), connectionId = randomBytes(16).toString('hex')) {
  const q = new URLSearchParams({
    'Ocp-Apim-Subscription-Key': EDGE_TRUSTED_TOKEN,
    'Sec-MS-GEC': buildSecMsGec(nowMs),
    'Sec-MS-GEC-Version': `1-${EDGE_CHROMIUM_VERSION}`,
    ConnectionId: connectionId
  });
  return `${EDGE_WSS_BASE}?${q.toString()}`;
}

const EDGE_HEADERS = {
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.9'
};

/**
 * 合成一段语音，返回 mp3 Buffer。
 * @param {string} text
 * @param {{voice?: string, rate?: string, pitch?: string, volume?: string, timeoutMs?: number}} opts
 */
export async function synthesizeEdgeTts(text, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30000;
  const url = buildEdgeUrl();
  const ssml = buildSsml(text, opts);
  const chunks = [];
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: EDGE_HEADERS });
    ws.binaryType = 'arraybuffer';
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      done(reject, new Error('Edge TTS 超时'));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      const now = new Date().toISOString();
      ws.send(`X-Timestamp:${now}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: EDGE_AUDIO_FORMAT } } } }));
      ws.send(`X-RequestId:${randomBytes(16).toString('hex')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${now}\r\nPath:ssml\r\n\r\n${ssml}`);
    });

    ws.addEventListener('message', async (ev) => {
      const data = ev.data;
      if (typeof data === 'string') {
        if (data.includes('Path:turn.end')) {
          clearTimeout(timer);
          const buf = Buffer.concat(chunks);
          try { ws.close(); } catch {}
          if (buf.length < 200) return done(reject, new Error('Edge TTS 返回的音频过短'));
          done(resolve, buf);
        }
        return;
      }
      const b = Buffer.from(await (data.arrayBuffer ? data.arrayBuffer() : data));
      const headerLen = b.readUInt16BE(0);
      const header = b.subarray(2, 2 + headerLen).toString('utf8');
      if (header.includes('Path:audio')) chunks.push(b.subarray(2 + headerLen));
    });

    ws.addEventListener('error', (err) => {
      clearTimeout(timer);
      done(reject, new Error(`Edge TTS 连接失败：${err?.message ?? 'websocket error'}`));
    });
    ws.addEventListener('close', (ev) => {
      clearTimeout(timer);
      done(reject, new Error(`Edge TTS 连接提前关闭（code=${ev.code}）`));
    });
  });
}
