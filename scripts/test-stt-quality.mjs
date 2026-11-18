#!/usr/bin/env node
// D53：语音/视频质量纯逻辑测试（低置信、语言参数、降级链、抽帧/分段计划）。
// 用法：node scripts/test-stt-quality.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readBridgeSource } from './bridge-source.mjs';
import {
  STT_DEFAULT_LANGUAGE, STT_DEFAULT_INITIAL_PROMPT,
  assessTranscript, buildSttRequest, planFramePlan, planVideoSegments, sttFallbackChain
} from '../src/stt-quality.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(`${root}${rel}`, 'utf8');
const bridge = readBridgeSource();
const service = read('src/stt-service.js');
const video = read('src/video-analyze.js');
const server = read('tools/stt_server.py');
const cli = read('tools/stt_cli.py');
let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('[A] 低置信判据：宁说听不清，不把乱码当内容');
{
  const garbage = { text: '关关呗就是这个啊一颗花地我这边打了插件', segments: [{ avg_logprob: -1.25, no_speech_prob: 0.15 }] };
  const r = assessTranscript(garbage);
  ok('乱码低 logprob → lowConfidence', r.lowConfidence === true && r.reason === 'low_logprob', `reason=${r.reason} avg=${r.avgLogprob}`);
}
{
  const r = assessTranscript({ text: '今天天气不错', segments: [{ avg_logprob: -0.3, no_speech_prob: 0.92 }] });
  ok('no_speech 高 → high_no_speech', r.lowConfidence === true && r.reason === 'high_no_speech');
}
{
  const r = assessTranscript({ text: '嗯', segments: [{ avg_logprob: -0.2 }] });
  ok('字数过少 → too_short', r.lowConfidence === true && r.reason === 'too_short', `chars=${r.chars}`);
}
{
  const r = assessTranscript({ text: '今天去吃了火锅，味道还不错。', segments: [{ avg_logprob: -0.32, no_speech_prob: 0.03 }] });
  ok('正常中文 → 置信合格', r.lowConfidence === false && r.reason === 'ok');
}
{
  const r = assessTranscript({ text: '', segments: [] });
  ok('空文本 → empty 且判低置信', r.lowConfidence === true && r.reason === 'empty');
}
{
  // medium 在测试音频上的真实输出：同一句复读 4 次
  const r = assessTranscript({ text: '第二句，如果您的语音转文字功能是不太好，如果您的语音转文字功能是不太好，如果您的语音转文字功能是不太好，如果您的语音转文字功能是不太好。', segments: [{ avg_logprob: -0.36, no_speech_prob: 0.12 }] });
  ok('复读 3 次以上 → repetition', r.lowConfidence === true && r.reason === 'repetition', `reason=${r.reason}`);
}
{
  // 没有置信字段（旧服务/CLI）时不能误杀：只按字数判断
  const r = assessTranscript({ text: '这是一段正常长度的中文转写。', segments: [{ text: '这是一段正常长度的中文转写。' }] });
  ok('缺置信字段 → 不误判低置信', r.lowConfidence === false && r.avgLogprob === null);
}

console.log('\n[B] 参数透传：语言锁定 / initial_prompt / beam / VAD');
{
  const body = buildSttRequest({ path: 'C:/tmp/a.wav' });
  ok('默认 language=zh', body.language === STT_DEFAULT_LANGUAGE, body.language);
  ok('默认带中文 initial_prompt', body.initial_prompt === STT_DEFAULT_INITIAL_PROMPT && body.initial_prompt.includes('中文群聊'));
  ok('默认 beam_size=5、vad=true、condition=false', body.beam_size === 5 && body.vad_filter === true && body.condition_on_previous_text === false);
  const other = buildSttRequest({ path: 'x', language: 'ja', beamSize: 99 });
  ok('语言可覆盖、beam 收敛到 10', other.language === 'ja' && other.beam_size === 10);
  ok('service 用 buildSttRequest 发请求', service.includes('buildSttRequest({') && service.includes('language: lang || cfg.language'));
  ok('server 读 language/initial_prompt/beam/vad', server.includes('payload.get("language")') && server.includes('payload.get("initial_prompt")') && server.includes('beam_size'));
  ok('CLI 支持 --language 且带 avg_logprob', cli.includes('"--language", "--lang"') && cli.includes('avg_logprob'));
}

console.log('\n[C] 降级链 / 分段 / 抽帧');
{
  const chain = sttFallbackChain({ model: 'large-v3', fallbacks: ['medium', 'small', 'medium', ''] });
  ok('降级链 large-v3 → medium → small（去重去空）', JSON.stringify(chain) === JSON.stringify(['large-v3', 'medium', 'small']), chain.join(' → '));
  ok('server 支持 --fallback-model 与 cuda→cpu 降级', server.includes('--fallback-model') && server.includes('_device_candidates') && server.includes('"cpu", "int8"'));
}
{
  const p = planFramePlan(16);
  ok('16 秒 → 12 帧 4×3（约 1.33s/帧）', p.count === 12 && p.cols === 4 && p.rows === 3, `count=${p.count} every=${p.everySec.toFixed(2)}`);
  const q = planFramePlan(4);
  ok('4 秒短片 → 4 帧 2×2（不硬凑 12 帧）', q.count === 4 && q.cols === 2 && q.rows === 2);
  ok('video-analyze 用 planFramePlan 抽帧', video.includes('planFramePlan(') && video.includes('plan.cols'));
}
{
  const segs = planVideoSegments(150);
  ok('150 秒 → 3 段（60/60/30）', segs.length === 3 && segs[2].start === 120 && segs[2].end === 150, JSON.stringify(segs));
}
{
  ok('bridge 把画面/声音分开且听不清只写事实', bridge.includes('声音：听不清') && bridge.includes('声音：“'));
  ok('会话语录不写「别猜、别复述」这类模型指令', !bridge.includes('别猜、别复述') && bridge.includes('声音：无'));
  ok('video-analyze 音频做去静音/响度归一化，失败回退裸抽', video.includes('silenceremove') && video.includes('loudnorm') && video.includes('r = await runCommandAsync'));
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exitCode = fail === 0 ? 0 : 1;
