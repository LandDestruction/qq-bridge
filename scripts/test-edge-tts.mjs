// Edge TTS 纯逻辑单测：令牌、声音解析、SSML 转义、URL 拼装。
//
// 为什么需要：Edge TTS 自己在踩坑时发现——端点/参数名/版本号任一个不对就是 403，
// 而 403 和“声音不存在”在生产里表现一样（没声音）。所以把能离线验证的部分固定住。
//
// 运行：node scripts/test-edge-tts.mjs

import {
  EDGE_TRUSTED_TOKEN,
  EDGE_WSS_BASE,
  EDGE_CHROMIUM_VERSION,
  DEFAULT_EDGE_VOICE,
  EDGE_VOICES,
  resolveEdgeVoice,
  buildSecMsGec,
  buildSsml,
  buildEdgeUrl,
  xmlEscape
} from '../src/edge-tts.js';

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass += 1; console.log(`  ok   ${name} → ${JSON.stringify(got)}`); }
  else { fail += 1; console.log(`  FAIL ${name} → got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

console.log('\n[1] 令牌：64 位大写十六进制，且 300 秒内稳定');
{
  const t = buildSecMsGec(Date.UTC(2026, 9, 24, 3, 0, 0));
  check('长度 64', t.length, 64);
  check('全大写十六进制', /^[0-9A-F]{64}$/.test(t), true);
  check('同一 300 秒窗口内稳定', buildSecMsGec(Date.UTC(2026, 9, 24, 3, 0, 10)), t);
  check('跨窗口变化', buildSecMsGec(Date.UTC(2026, 9, 24, 3, 6, 0)) === t, false);
}

console.log('\n[2] 音色解析：短名 / 中文别名 / 完整 id / 空值');
{
  check('空值 → 默认晓晓', resolveEdgeVoice(''), DEFAULT_EDGE_VOICE);
  check('短名 xiaoyi', resolveEdgeVoice('xiaoyi'), EDGE_VOICES.xiaoyi);
  check('大小写不敏感', resolveEdgeVoice('XiaoXuan'), EDGE_VOICES.xiaoxuan);
  check('完整 id 原样', resolveEdgeVoice('zh-CN-XiaoyiNeural'), 'zh-CN-XiaoyiNeural');
  check('未知值透传（让 Edge 报 unsupported voice）', resolveEdgeVoice('xx-Unknown'), 'xx-Unknown');
}

console.log('\n[3] SSML：特殊字符必须转义，否则整段合成失败');
{
  check('转义尖括号', xmlEscape('a<b>'), 'a&lt;b&gt;');
  check('转义引号与 &', xmlEscape('a&"b"'), 'a&amp;&quot;b&quot;');
  const ssml = buildSsml('5 < 6 & 7 > 2', { voice: EDGE_VOICES.xiaoxiao, rate: '+6%', pitch: '+3Hz' });
  check('含 voice 名', ssml.includes(EDGE_VOICES.xiaoxiao), true);
  check('rate 生效', ssml.includes('rate="+6%"'), true);
  check('pitch 生效', ssml.includes('pitch="+3Hz"'), true);
  check('文本已转义', ssml.includes('5 &lt; 6 &amp; 7 &gt; 2'), true);
}

console.log('\n[4] 连接 URL：新端点 + Ocp-Apim-Subscription-Key + 版本号');
{
  const url = buildEdgeUrl(Date.UTC(2026, 9, 24, 3, 0, 0), 'abc123');
  check('使用新端点', url.startsWith(EDGE_WSS_BASE + '?'), true);
  check('带 Ocp-Apim-Subscription-Key', url.includes('Ocp-Apim-Subscription-Key=' + EDGE_TRUSTED_TOKEN), true);
  check('带 Sec-MS-GEC-Version', url.includes('Sec-MS-GEC-Version=1-' + encodeURIComponent(EDGE_CHROMIUM_VERSION)) || url.includes('Sec-MS-GEC-Version=1-' + EDGE_CHROMIUM_VERSION), true);
  check('带 ConnectionId', url.includes('ConnectionId=abc123'), true);
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
