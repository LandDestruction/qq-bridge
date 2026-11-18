// 视觉能力探针：给每个候选模型发一张纯色小图，问「这张图是什么颜色」。
//
// 为什么需要它：DSH 的 `session/modelCatalog` 返回的模型对象**只有 id/name/reasoning**，
// 没有任何 inputModalities / capabilities 字段（2026-10-25 实测）。所以「哪个模型能看图」
// 在 DSH 侧拿不到 —— 只能真发一张图试出来，把结果写进 config.json 的 `dsh.visionModels`。
//
// 用法：
//   node scripts/probe-vision.mjs                      # 探 catalog 里的全部模型
//   node scripts/probe-vision.mjs deepseek-flash ...   # 只探指定模型（按 id 匹配）
//   PROBE_TEXT=1 node scripts/probe-vision.mjs glm-5.3 # 对照组：只发文字，判「模型本身能不能用」
//   PROBE_DEBUG=1 ...                                  # 打每个事件类型
//
// 为什么要对照组：探针里有两种失败——「模型看不见图」和「模型根本连不上（超时/报错）」。
// 只发图时两者都表现为 ❌。文本对照组会答就说明链路通、失败出在图片上；
// 对照组也超时，说明这个 provider 当时不可用，**不能据此说它不支持视觉**。
//
// 采集方式（2026-10-25 修）：**不能用 `session/projections`** —— 它返回的是
// `{asOfSeq, values}`，values 里的键是 `inbox`（排队中的用户消息），**没有 messages 字段**，
// 所以旧版探针永远读到空回复、白等 90s。正确路径是 mux 事件流的 `session/follow`：
// 等 `turn/end`，`assistant/message` 里攒文本。且**不能只靠 turn/start 建账**：
// follow 与 prompt 走两条连接，turn/start 有极小概率漏掉，漏掉就永远等不到回合结束。
//
// 注意：会在 DSH 里建临时会话（每个模型一个），跑完不自动删；用同一个 workspace「视觉探针」。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { NodeApiClient, unwrap } from '../src/dsh-client.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const cfgPath = path.join(ROOT, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const dsh = cfg.dsh ?? {};
const baseUrl = String(process.env.DSH_BASE_URL || dsh.baseUrl || 'http://127.0.0.1:3080');
const only = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 120000);
const TEXT_ONLY = process.env.PROBE_TEXT === '1';
const DEBUG = process.env.PROBE_DEBUG === '1';

// ---------- 纯色 PNG（无第三方依赖）：1x1 的图在部分视觉管道里容易被当成坏图，
// 用 64x64 纯红实心块，提问「什么颜色」不可能有歧义。
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function solidPng(w, h, [r, g, b]) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const p = y * stride + 1 + x * 3;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}
const RED_PNG = solidPng(64, 64, [220, 30, 30]);

const api = new NodeApiClient(baseUrl, undefined, {
  token: dsh.authToken,
  tokenExplicit: dsh.authTokenExplicit === true,
  header: dsh.authHeader,
  prefix: dsh.authPrefix,
  allowRemote: dsh.allowRemote === true
});

/**
 * 在 mux 事件流上等这一次 prompt 的 turn/end。
 * 返回 { text, reason, error, seen }；reason.kind 为 'timeout' 表示 90s 内没有回合结束。
 */
async function runTurn(sessionId, content) {
  const ac = new AbortController();
  let opened;
  const openedP = new Promise((resolve) => { opened = { resolve }; });
  const mux = api.events.mux({}, ac.signal, () => opened.resolve());
  api.events.follow(sessionId); // 记进 _desiredFollows，socket open 时会重放
  let text = '';
  let reason = null;
  let failure = null;
  const seen = new Map();

  const pump = (async () => {
    for await (const envelope of mux) {
      const frame = envelope?.payload;
      if (!frame) continue;
      if (frame.type === 'stream/error') {
        failure = new Error(`stream/error: ${frame.error?.code || '?'}: ${frame.error?.message || ''}`);
        return;
      }
      if (frame.type !== 'session/event' || frame.sessionId !== sessionId) continue;
      const event = frame.event;
      const type = event?.type ?? '?';
      seen.set(type, (seen.get(type) ?? 0) + 1);
      if (DEBUG) console.log(`     · ${type}`);
      if (type === 'assistant/message') {
        for (const block of event.data?.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
        }
      } else if (type === 'error') {
        failure = new Error(`session/error: ${event.data?.message || event.data?.code || JSON.stringify(event.data)}`);
      } else if (type === 'turn/end') {
        reason = event.data?.reason ?? { kind: 'unknown' };
        return;
      }
    }
  })();

  await Promise.race([openedP, new Promise((r) => setTimeout(r, 5000))]);
  // **必须 unwrap**：NodeApiClient.callUnary 对 `result.ok === false` 不抛异常，只把
  // `{error:{code,message}}` 原样返回。旧版探针没解，于是「模型不支持图片」这种
  // 立刻返回的拒绝被当成「没回音」，白等满 90s 才报 timeout —— 失败原因全丢了。
  unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content }), 'session/prompt');

  const deadline = new Promise((r) => setTimeout(() => r('timeout'), TIMEOUT_MS));
  await Promise.race([pump, deadline]);
  ac.abort();
  api.events.forget(sessionId);
  const seenText = [...seen.entries()].map(([k, v]) => `${k}×${v}`).join(',');
  if (!reason && !failure) return { text: text.trim(), reason: { kind: 'timeout', seen: seenText }, error: null, seen };
  if (!reason && failure) return { text: text.trim(), reason: { kind: 'failed' }, error: failure, seen };
  return { text: text.trim(), reason, error: failure, seen };
}

async function probeOne(model) {
  const started = Date.now();
  const dir = path.join(ROOT, 'state', 'vision-probe', model.id.replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  try {
    const ws = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
    const created = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId }), 'session.create');
    const sessionId = created.sessionId;
    await api.sessions.selectModel({ sessionId, provider: model.provider, model: model.id });
    const content = TEXT_ONLY
      ? [{ type: 'text', text: '只回答阿拉伯数字：1+1 等于几？' }]
      : (() => {
        // PROBE_IMAGE=<绝对路径> 时改发那张图（用来复现「大图识别不了」）。
        // PROBE_QUESTION 可换提问；PROBE_MEDIA_TYPE 覆盖 mediaType（默认按扩展名推断）。
        const imgPath = String(process.env.PROBE_IMAGE || '').trim();
        if (!imgPath) {
          return [
            { type: 'text', text: '这张图是什么颜色？只回答颜色名，不要解释。' },
            { type: 'image', mediaType: 'image/png', data: RED_PNG.toString('base64'), name: 'probe-red.png' }
          ];
        }
        const buf = fs.readFileSync(imgPath);
        const ext = (imgPath.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || 'png';
        const mediaType = String(process.env.PROBE_MEDIA_TYPE || '').trim()
          || ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', bmp: 'image/bmp' }[ext] || 'image/png');
        const question = String(process.env.PROBE_QUESTION || '').trim()
          || '这张图里有什么？请描述主要内容；如果看不到图就直说看不到。';
        console.log(`[probe] 图片 ${imgPath} ${(buf.length / 1024).toFixed(0)}KB mediaType=${mediaType}`);
        return [
          { type: 'text', text: question },
          { type: 'image', mediaType, data: buf.toString('base64'), name: `probe.${ext}` }
        ];
      })();
    const turn = await runTurn(sessionId, content);
    const ok = TEXT_ONLY ? /2|二|two/i.test(turn.text) : /红|red/i.test(turn.text);
    const detail = turn.text
      || `[${turn.reason?.kind ?? 'unknown'}${turn.reason?.seen ? `: ${turn.reason.seen}` : ''}${turn.reason?.message ? `: ${turn.reason.message}` : ''}${turn.error ? ` / ${turn.error.message}` : ''}]`;
    return { model, ok, text: detail.slice(0, 200), ms: Date.now() - started };
  } catch (error) {
    return { model, ok: false, text: `❌ ${error?.message ?? error}`.slice(0, 200), ms: Date.now() - started };
  }
}

const catalog = unwrap(await api.callUnary('session/modelCatalog', {}), 'session/modelCatalog');
const models = [];
for (const g of catalog?.groups ?? []) {
  for (const m of g.models ?? []) models.push({ provider: m.provider ?? g.id, id: m.id });
}
const targets = only.length
  ? models.filter((m) => only.some((k) => m.id === k || m.id.endsWith(k) || `${m.provider}/${m.id}` === k))
  : models;

console.log(`探针目标 ${targets.length} 个模型（baseUrl=${baseUrl}${TEXT_ONLY ? '，文本对照组' : ''}）\n`);
const rows = [];
for (const m of targets) {
  const r = await probeOne(m);
  rows.push(r);
  console.log(`${r.ok ? '✅' : '❌'} ${m.provider}/${m.id}  ${r.ms}ms  ${r.text.replace(/\s+/g, ' ')}`);
}
console.log('\n=== 汇总（把 ✅ 的写进 config.json 的 dsh.visionModels）===');
for (const r of rows) console.log(`${r.ok ? '支持' : '不支持'}\t${r.model.provider}/${r.model.id}`);
process.exit(0);
