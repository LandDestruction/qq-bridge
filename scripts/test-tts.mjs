// QQ AI 语音（TTS）纯逻辑单测：文本清洗、音色映射、SILK 判定、合成群选择。
//
// 为什么需要：这些判定直接决定「发出去的语音会不会很傻」或「能不能发出去」——
// CQ 码被念出来、长文被接口拒绝、格式变了还照发。合成接口本身要连网+真实 QQ 账号，
// 所以只测合成前后的纯逻辑。
//
// 运行：node scripts/test-tts.mjs

import {
  TTS_DEFAULT_VOICE,
  TTS_MAX_CHARS_CAP,
  resolveTtsVoice,
  clampTtsMaxChars,
  sanitizeTtsText,
  isSilkV3,
  pickSynthGroup,
  ttsFileName,
  describeTtsError,
  parseVoiceDirective,
  wantsVoiceReply
} from '../src/tts.js';

let pass = 0;
let fail = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass += 1; console.log(`  ok   ${name} → ${JSON.stringify(got)}`); }
  else { fail += 1; console.log(`  FAIL ${name} → got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

console.log('\n[1] 音色解析：中文别名 / 完整 id / 空值');
{
  check('空值 → 默认元气少女', resolveTtsVoice(''), TTS_DEFAULT_VOICE);
  check('undefined → 默认', resolveTtsVoice(undefined), 'lucy-voice-xueling');
  check('别名 邻家小妹', resolveTtsVoice('邻家小妹'), 'lucy-voice-female1');
  check('别名 傲娇少女', resolveTtsVoice('傲娇少女'), 'lucy-voice-f38');
  check('别名 酥心御姐', resolveTtsVoice('酥心御姐'), 'lucy-voice-suxinjiejie');
  check('完整 id 透传', resolveTtsVoice('lucy-voice-daji'), 'lucy-voice-daji');
  check('未知字符串透传（让 QQ 侧报错）', resolveTtsVoice('unknown-voice'), 'unknown-voice');
}

console.log('\n[2] 字数上限：默认 100，夹在 [1, 300]');
{
  check('未配置 → 100', clampTtsMaxChars(undefined), 100);
  check('0 → 100', clampTtsMaxChars(0), 100);
  check('负数 → 100', clampTtsMaxChars(-3), 100);
  check('非数字 → 100', clampTtsMaxChars('abc'), 100);
  check('合法值原样', clampTtsMaxChars(60), 60);
  check('超上限夹到 300', clampTtsMaxChars(9999), TTS_MAX_CHARS_CAP);
}

console.log('\n[3] 文本清洗：CQ 码/URL/Markdown 都不该被念出来');
{
  check('去 CQ 码', sanitizeTtsText('看图[CQ:image,file=abc.jpg]好看吧').text, '看图好看吧');
  check('去裸 URL', sanitizeTtsText('看这个 https://example.com/a?b=1 很好').text, '看这个很好');
  check('去 Markdown 强调', sanitizeTtsText('**真的**很开心').text, '真的很开心');
  check('去代码块', sanitizeTtsText('看代码 ```js\nconsole.log(1)\n``` 完').text, '看代码完');
  check('去零宽字符', sanitizeTtsText('你\u200B好').text, '你好');
  check('折叠空白', sanitizeTtsText('  今晚   想听你唱\n歌  ').text, '今晚想听你唱歌');
  check('重复标点收成一个', sanitizeTtsText('真的吗!!!!').text, '真的吗!');
  check('空串 → 空', sanitizeTtsText('').text, '');
  check('全是 CQ 码 → 空', sanitizeTtsText('[CQ:image,file=a.jpg]').text, '');
  const long = '好'.repeat(150);
  const r = sanitizeTtsText(long, 100);
  check('超长被截断', r.text.length, 100);
  check('截断标记为 true', r.truncated, true);
  check('未超长 truncated=false', sanitizeTtsText('短句', 100).truncated, false);
}

console.log('\n[4] SILK_V3 判定：头部校验，避免把 HTML 错误页当语音发出去');
{
  const silk = Buffer.concat([Buffer.from([0x02]), Buffer.from('#!SILK_V3'), Buffer.alloc(20, 1)]);
  check('带 0x02 前缀的 SILK', isSilkV3(silk), true);
  check('无前缀的 SILK', isSilkV3(Buffer.concat([Buffer.from('#!SILK_V3'), Buffer.alloc(20, 1)])), true);
  check('mp3（ID3）不是 SILK', isSilkV3(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20, 1)])), false);
  check('HTML 错误页不是 SILK', isSilkV3(Buffer.from('<html>404</html>')), false);
  check('空 buffer 不是 SILK', isSilkV3(Buffer.alloc(0)), false);
  check('null 不抛', isSilkV3(null), false);
}

console.log('\n[5] 合成群选择：配置优先，否则白名单第一个群');
{
  check('配置了群 → 用它', pickSynthGroup({ configured: 123, allowedGroups: [456] }), 123);
  check('未配置 → 白名单第一个', pickSynthGroup({ configured: 0, allowedGroups: [456, 789] }), 456);
  check('都没有 → null', pickSynthGroup({ configured: 0, allowedGroups: [] }), null);
  check('非法配置被忽略', pickSynthGroup({ configured: 'x', allowedGroups: [789] }), 789);
  check('白名单里的非法值被过滤', pickSynthGroup({ configured: null, allowedGroups: [0, -1, 789] }), 789);
}

console.log('\n[6] 文件名与错误文案');
{
  check('同一文本同一时刻 → 同名', ttsFileName('晚安', 1000), ttsFileName('晚安', 1000));
  check('不同文本 → 不同名', ttsFileName('晚安', 1000) === ttsFileName('早安', 1000), false);
  check('扩展名是 .silk（发送层才会跳过转码）', ttsFileName('晚安', 1000).endsWith('.silk'), true);
  check('MediaData is Empty 给可读提示',
    describeTtsError(100, 'OIDB error 70001 AudioRsp MediaData is Empty').includes('没有返回音频'), true);
  check('retcode 非 100 也带码', describeTtsError(1400, 'bad request').includes('1400'), true);
}


console.log('\n[7] [语音] 前缀解析：不只是工具，消息前缀也能触发');
{
  check('[语音] 前缀', parseVoiceDirective('[语音]晚安呀').isVoice, true);
  check('[语音] 后面的文本', parseVoiceDirective('[语音]晚安呀').text, '晚安呀');
  check('【语音】全角括号', parseVoiceDirective('【语音】 晚安').isVoice, true);
  check('[voice] 英文前缀', parseVoiceDirective('[voice]hi').isVoice, true);
  check('普通消息不算', parseVoiceDirective('晚上好呀').isVoice, false);
  check('其它前缀不算', parseVoiceDirective('[图片]看图').isVoice, false);
  check('空串不算', parseVoiceDirective('').isVoice, false);
  check('只有前缀没有内容 → 文本为空', parseVoiceDirective('[语音]').text.trim(), '');
}


console.log('\n[8] 对方是不是在要语音：自动转语音的触发条件');
{
  check('发个语音', wantsVoiceReply('那你发个语音消息给我看'), true);
  check('听听你的声音', wantsVoiceReply('好想听听你的声音'), true);
  check('唱首歌', wantsVoiceReply('给我唱首歌吧'), true);
  check('哼一句', wantsVoiceReply('哼一句来听听'), true);
  check('抱怨/质问不算（怎么会把语音发别处）', wantsVoiceReply('怎么会把语音消息发别的地方哇'), false);
  check('否定不算（别发语音）', wantsVoiceReply('别发语音了'), false);
  check('疑问不算（为什么发语音）', wantsVoiceReply('为什么发语音'), false);
  check('普通聊天不算', wantsVoiceReply('今天天气不错啊'), false);
  check('空串不算', wantsVoiceReply(''), false);
  check('长文本不算（避免误判）', wantsVoiceReply('语音'.repeat(80)), false);
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
