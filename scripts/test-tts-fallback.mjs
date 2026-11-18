// 私聊语音兜底：QQ 官方 AI 语音只能发群（会把语音直接发进「合成群」），
// 私聊只能 Edge → 本机 TTS。Edge 靠微软 websocket 会抖，抖起来必须还能退到本机 TTS，
// 而不是报一句「只支持群聊目标」让用户摸不着头脑。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTts } from '../src/bridge/tts.js';

let pass = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); pass += 1; console.log('  ok   ' + name); }
  catch (error) { failures.push(name + ' → ' + (error?.message || error)); console.log('  FAIL ' + name + ' → ' + (error?.message || error)); }
}

const WAV = Buffer.alloc(4096, 7);

function makeDeps({ edgeFails = true, localFails = false, provider = 'qq', events = [] } = {}) {
  return {
    cfg: {
      snowluma: { httpUrl: 'http://127.0.0.1:3000' },
      socialV2: {
        tts: { provider, enabled: true, edgeRate: '+6%', edgePitch: '+3Hz', style: 'sweet', speaker: 'female_1', speed: 1.12, localUrl: 'http://127.0.0.1:8765', voice: '', maxChars: 0, synthGroupId: 123, timeoutMs: 20000, byKey: {} },
        voice: { dir: path.join(process.cwd(), 'audio') }
      }
    },
    ROOT: process.cwd(),
    path,
    fs: { mkdirSync() {}, writeFileSync() {} },
    AbortSignal,
    log: () => {},
    voiceCfg: () => ({ dir: path.join(process.cwd(), 'audio'), enabled: true }),
    edgeTtsModule: {
      resolveEdgeVoice: (v) => String(v || 'zh-CN-XiaoxiaoNeural'),
      synthesizeEdgeTts: async () => {
        events.push('edge');
        if (edgeFails) throw new Error('edge 连不上（模拟网络抖动）');
        return Buffer.alloc(2048, 3);
      }
    },
    fetch: async (url, opts) => {
      if (String(url).endsWith('/tts')) {
        events.push('local:' + String(opts?.body ?? ''));
        if (localFails) return { ok: false, status: 503, text: async () => '{"error":"模型还在加载"}' };
        return { ok: true, status: 200, arrayBuffer: async () => WAV };
      }
      events.push('qq:' + String(url));
      return { ok: false, status: 500, json: async () => ({ status: 'failed', retcode: 1200, wording: '合成失败' }) };
    },
    isRecentSynthesis: () => false,
    autoVoiceSentAt: new Map(),
    autoVoiceSeq: 0,
    nextAutoVoiceMark: (x) => x
  };
}

console.log('私聊语音兜底：');

await test('私聊 + Edge 挂掉 → 退到本机 TTS（wav）', async () => {
  const events = [];
  const tts = createTts(makeDeps({ edgeFails: true, events }));
  const r = await tts.synthesizeTts('晚安呀，今天辛苦啦', '元气少女', 'sweet', 'private:100000007');
  assert.equal(r.provider, 'local');
  assert.equal(r.ext, '.wav');
  assert.equal(r.buf.length, WAV.length);
  // 每一档都重试两次：Edge 抖一次不该直接掉档，所以是 edge、edge、local。
  assert.deepEqual(events.map((e) => e.split(':')[0]), ['edge', 'edge', 'local']);
});

await test('私聊 + Edge 第一次抖、第二次好 → 直接用 Edge（重试生效，不再掉到本机 TTS）', async () => {
  const events = [];
  let edgeCalls = 0;
  const deps = makeDeps({ edgeFails: false, events });
  deps.edgeTtsModule.synthesizeEdgeTts = async () => {
    edgeCalls += 1;
    events.push('edge');
    if (edgeCalls === 1) throw new Error('Edge TTS 连接提前关闭（code=1007）');
    return Buffer.alloc(2048, 3);
  };
  const tts = createTts(deps);
  const r = await tts.synthesizeTts('晚安呀', '元气少女', 'sweet', 'private:100000007');
  assert.equal(r.provider, 'edge');
  assert.equal(r.ext, '.mp3');
  assert.equal(edgeCalls, 2);
  assert.deepEqual(events.map((e) => e.split(':')[0]), ['edge', 'edge']);
});

await test('本机 TTS 拿到的超时是 120 秒（60 秒会卡在「排到队但没合成完」的边界）', async () => {
  const src = fs.readFileSync(new URL('../src/bridge/tts.js', import.meta.url), 'utf8');
  assert.ok(src.includes('Math.max(120000, t.timeoutMs)'), '本机 TTS 超时应为 120s');
});

await test('QQ 官方 AI 语音绝不重试（每合成一次都会往合成群落一条）', async () => {
  const src = fs.readFileSync(new URL('../src/bridge/tts.js', import.meta.url), 'utf8');
  assert.ok(src.includes("const attemptsFor = step === 'qq' ? 1 : TTS_ATTEMPTS;"), 'qq 档必须只试一次');
});

await test('私聊 + Edge 挂掉 + 本机 TTS 也挂 → 报错里两条原因都在，不再说「只支持群聊目标」', async () => {
  const tts = createTts(makeDeps({ edgeFails: true, localFails: true }));
  await assert.rejects(
    () => tts.synthesizeTts('在吗', '', 'sweet', 'private:100000007'),
    (error) => {
      const m = String(error.message);
      assert.match(m, /私聊语音合成失败/);
      assert.match(m, /edge: /);
      assert.match(m, /local: /);
      assert.match(m, /127\.0\.0\.1:8765/);
      assert.doesNotMatch(m, /只支持群聊目标/);
      return true;
    }
  );
});

await test('私聊 + 本机 TTS 是首选时才先走本机（provider=local 不先试 Edge）', async () => {
  const events = [];
  const tts = createTts(makeDeps({ provider: 'local', events }));
  const r = await tts.synthesizeTts('哼一段', '', 'sweet', 'private:100000007');
  assert.equal(r.provider, 'local');
  assert.deepEqual(events.map((e) => e.split(':')[0]), ['local']);
});

await test('本机 TTS 请求体与它认的字段一致（text/style/speaker/speed）', async () => {
  const events = [];
  const tts = createTts(makeDeps({ provider: 'local', events }));
  await tts.synthesizeTts('测试一下', '', 'gentle', 'private:100000007');
  const body = JSON.parse(events[0].slice('local:'.length));
  assert.equal(body.text, '测试一下');
  assert.equal(body.style, 'gentle');
  assert.equal(body.speaker, 'female_1');
  assert.equal(body.speed, 1.12);
});

await test('群聊 + provider=qq 维持原样：不试 Edge，也绝不碰本机 TTS', async () => {
  const events = [];
  const tts = createTts(makeDeps({ provider: 'qq', events }));
  await assert.rejects(
    () => tts.synthesizeTts('大家好', '', 'sweet', 'group:100000003'),
    (error) => {
      assert.match(String(error.message), /语音合成失败/);
      assert.doesNotMatch(String(error.message), /私聊/);
      return true;
    }
  );
  assert.equal(events.length, 1);
  assert.match(events[0], /^qq:http:\/\/127\.0\.0\.1:3000\/get_ai_record$/);
});

console.log('\n私聊语音兜底：通过 ' + pass + ' / 失败 ' + failures.length);
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exitCode = 1; }
