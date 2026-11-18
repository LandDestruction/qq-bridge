// 角色音（GPT-SoVITS）档：验证 provider=gsv 时走 /tts、术语替换、截断、以及挂掉时能退回 Edge。
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTts } from '../src/bridge/tts.js';

let pass = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); pass += 1; console.log('  ok   ' + name); }
  catch (error) { failures.push(name + ' → ' + (error?.message || error)); console.log('  FAIL ' + name + ' → ' + (error?.message || error)); }
}

const WAV = Buffer.alloc(4096, 9);
const REF = 'data/voice/m7refs/B_energy.wav';
const PROMPT = '为了取得你的信任，咱们就先自爆家门，流光一停，你应该再熟悉不过了吧';

function makeDeps({ gsvFails = false, edgeFails = false, requests = [] } = {}) {
  return {
    cfg: {
      socialV2: {
        tts: {
          provider: 'gsv', enabled: true, maxChars: 0, timeoutMs: 20000,
          gsvUrl: 'http://127.0.0.1:9880', gsvRef: REF, gsvPromptText: PROMPT,
          gsvSpeed: 1, gsvTopK: 10, gsvTemperature: 0.6, gsvMaxChars: 60, gsvTimeoutMs: 120000
        },
        voice: { dir: path.join(process.cwd(), 'audio') }
      }
    },
    ROOT: process.cwd(),
    path,
    AbortSignal,
    log: () => {},
    voiceCfg: () => ({ dir: path.join(process.cwd(), 'audio'), enabled: true }),
    edgeTtsModule: {
      resolveEdgeVoice: (v) => String(v || 'zh-CN-XiaoxiaoNeural'),
      synthesizeEdgeTts: async () => { if (edgeFails) throw new Error('edge 挂了'); return Buffer.alloc(2048, 3); }
    },
    fetch: async (url, opts) => {
      if (String(url).includes(':9880/tts')) {
        requests.push(JSON.parse(opts.body));
        if (gsvFails) return { ok: false, status: 400, text: async () => '{"message":"bad"}' };
        return { ok: true, status: 200, arrayBuffer: async () => WAV };
      }
      if (String(url).includes('8765/tts')) return { ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(3000, 1) };
      if (String(url).endsWith('/tts')) {
        if (edgeFails) return { ok: false, status: 503, text: async () => '{"error":"x"}' };
        return { ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(3000, 1) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    },
    isRecentSynthesis: () => false,
    autoVoiceSentAt: new Map(),
    autoVoiceSeq: 0,
    nextAutoVoiceMark: (x) => x
  };
}

console.log('角色音（GPT-SoVITS）：');

await test('群聊 + provider=gsv → 走 9880 并返回 gsv/wav', async () => {
  const requests = [];
  const tts = createTts(makeDeps({ requests }));
  const r = await tts.synthesizeTts('晚安呀，今天辛苦啦', '元气少女', 'sweet', 'group:100000001');
  assert.equal(r.provider, 'gsv');
  assert.equal(r.ext, '.wav');
  assert.equal(r.buf.length, WAV.length);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].ref_audio_path.replace(/\\/g, '/').endsWith('data/voice/m7refs/B_energy.wav'));
  assert.equal(requests[0].prompt_text, PROMPT);
  assert.equal(requests[0].text_lang, 'zh');
});

await test('术语替换：token → 词元（GSV 念英文缩写会 400）', async () => {
  const requests = [];
  const tts = createTts(makeDeps({ requests }));
  await tts.synthesizeTts('这一轮花了三万 token，你猜贵不贵', '元气少女', 'sweet', 'group:100000001');
  assert.ok(requests[0].text.includes('词元'), requests[0].text);
  assert.ok(!/token/i.test(requests[0].text), requests[0].text);
});

await test('超长文本按 gsvMaxChars 截断并补句号', async () => {
  const requests = [];
  const tts = createTts(makeDeps({ requests }));
  await tts.synthesizeTts('啊'.repeat(120), '元气少女', 'sweet', 'group:100000001');
  assert.equal(Array.from(requests[0].text).length, 61);
  assert.ok(requests[0].text.endsWith('。'));
});

await test('gsv 挂了 → 群聊退回 Edge', async () => {
  const tts = createTts(makeDeps({ gsvFails: true }));
  const r = await tts.synthesizeTts('晚安', '元气少女', 'sweet', 'group:100000001');
  assert.equal(r.provider, 'edge');
});

await test('私聊 + gsv 挂 + Edge 挂 → 退到本机 TTS', async () => {
  const tts = createTts(makeDeps({ gsvFails: true, edgeFails: true }));
  const r = await tts.synthesizeTts('晚安', '元气少女', 'sweet', 'private:100000007');
  assert.equal(r.provider, 'local');
});

await test('provider=gsv 时 ttsCfg 认得 gsv 字段', async () => {
  const tts = createTts(makeDeps({}));
  const c = tts.ttsCfg();
  assert.equal(c.provider, 'gsv');
  assert.equal(c.gsvUrl, 'http://127.0.0.1:9880');
  assert.equal(c.gsvRef, REF);
  assert.equal(c.gsvMaxChars, 60);
});

console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) { for (const f of failures) console.log(' - ' + f); process.exit(1); }
