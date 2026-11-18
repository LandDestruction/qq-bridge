// 引用消息（回复某条消息）在控制台里的呈现：正文不再重复 [图片]、引用框里能看到原图。
// 三处一起测：桥接侧把被引用消息的结构化副本存进 recentMessages；/client 侧剔除重复占位符；
// msgBodyText / quoteHtml 的拼接规则；以及 CSS 是否真有一套引用框样式。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const state = read('src/bridge/message-state.js');
const incoming = read('src/bridge/incoming-runtime.js');
const replySrc = read('src/bridge/reply-resolution.js');
const clientJs = read('public/client.js');
const clientCss = read('public/client.css');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

console.log('[1] 桥接：被引用消息存成结构化副本');
ok('appendSocialV2Message 多收一个 quoted 参数（老调用不用改）',
  /function appendSocialV2Message\(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = \[\], userId = null, forwardIds = \[\], quoted = null\)/.test(state));
ok('quoted 只留展示字段（messageId / sender / userId / text / media）',
  /safeQuoted = \{\s*messageId:[\s\S]{0,240}?sender:[\s\S]{0,220}?media: qMedia\s*\}/.test(state));
ok('引用媒体最多 3 条、且必须有 file 或 url',
  /quoted\.media\.slice\(0, 3\)/.test(state) && /filter\(\(m\) => !!\(m\.file \|\| m\.url\)\)/.test(state));
ok('引用文本截到 120 字（够看清是哪条，不至于塞爆时间线）', /truncateText\)\(String\(quoted\.text \?\? ''\), 120\)/.test(state));
ok('没内容就不写这个字段（老消息形状不变）', /\.\.\.\(safeQuoted \? \{ quoted: safeQuoted \} : \{\}\)/.test(state));

console.log('[2] 桥接：入站解析引用时把副本带出来');
ok('resolveReply 顺便记下 quotedInfo', /let quotedInfo = null;[\s\S]{0,160}?quotedInfo = await \(0, deps\.resolveReplyInfo\)/.test(incoming));
ok('appendSocialV2Message 调用处把 quotedInfo 传进去',
  /appendSocialV2Message\)\(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event\.message_id[\s\S]{0,200}?extractForwardIds\)\(event\.message \?\? \[\]\), quotedInfo\)/.test(incoming));

console.log('[3] 前端：不重复显示 [图片]、引用框带图');
ok('有占位符表与按条数删除的助手', /var MSG_PLACEHOLDER_RE = /.test(clientJs) && /function stripMediaPlaceholders\(text, count\)/.test(clientJs));
ok('有按方括号配平的引用前缀剔除', /function stripQuotePrefix\(text\)/.test(clientJs) && /depth \+= 1;/.test(clientJs) && /depth -= 1;/.test(clientJs));
// 正文要经过 groomGarbledText：历史脏数据（GBK 被按 UTF-8 解）里的 U+FFFD 串渲染成 ⍰ + 标记，
// 不能原样摆出来（否则看着像机器人自己发乱码）。
ok('正文走 msgBodyText，空正文不渲染空行',
  /\(msgBodyText\(m\) \? '<div class="qdb-msg-text">' \+ groomGarbledText\(truncate\(msgBodyText\(m\), 220\)\) \+ '<\/div>' : ''\)/.test(clientJs));
ok('msgHtml 里插了引用框', /'<\/div>' \+ quoteHtml\(m\)/.test(clientJs));
ok('引用框渲染名字 / 原文 / 缩略图', /qdb-quote-name/.test(clientJs) && /qdb-quote-text/.test(clientJs) && /qdb-quote-media/.test(clientJs));
ok('引用图走统一取图入口（过期链接也能显示）', /data-zoom="' \+ esc\(src\) \+ '" src="' \+ esc\(src\) \+ '"/.test(clientJs) && /var src = mediaSourceFor\(item\);/.test(clientJs));
ok('日志时间线同样按 media 条数删占位符',
  /stripMediaPlaceholders\(String\(m\.text !== undefined/.test(clientJs));
ok('引用框样式存在', /\.qdb-quote \{/.test(clientCss) && /\.qdb-quote-img \{/.test(clientCss) && /\.qdb-quote-img\.is-sticker/.test(clientCss));

console.log('[3b] 引用可点：带被引用消息 id，点了能回到原消息');
ok('safeQuoted 里带 messageId（否则前端没法定位原消息）',
  /messageId: quoted\.messageId != null && String\(quoted\.messageId\)/.test(state));
ok('resolveReplyInfo 把 messageId 一起返回',
  /messageId: String\(messageId\),/.test(replySrc));
ok('引用块带 data-quote-mid / data-quote-text 与「可点」的可访问性标记',
  /data-quote-mid="/.test(clientJs) && /data-quote-text="/.test(clientJs) && /role="button" tabindex="0" title="点击跳到这条消息"/.test(clientJs));
ok('每条消息带 data-mid / data-seq 供定位',
  /data-mid="' \+ esc\(mid\)/.test(clientJs) && /data-seq="' \+ esc\(mseq\)/.test(clientJs));
ok('有跳转/闪光函数，找不到时自动再取一页',
  /function jumpToQuoted\(node\)/.test(clientJs) && /function flashMsg\(node\)/.test(clientJs) && /loadOlderSession\(sessSeq\)\.then/.test(clientJs));
ok('点击委托先判引用块（图片放大仍走 data-zoom）',
  /closest\('\[data-quote-mid\], \.qdb-quote'\)/.test(clientJs) && /if \(quote\) \{ jumpToQuoted\(quote\); return; \}/.test(clientJs));
ok('键盘回车/空格也能跳（tabindex 后要能按键）',
  /if \(ev\.key !== 'Enter' && ev\.key !== ' '\) return;/.test(clientJs) && /jumpToQuoted\(quote\);/.test(clientJs));
ok('引用块是嵌套卡片样式（淡底+左边强调色+悬停），跳到后闪一下',
  /\.qdb-quote \{[^}]*border-left: 3px solid var\(--ui-accent\)/.test(clientCss)
  && /\.qdb-quote:hover/.test(clientCss)
  && /\.qdb-quote-go \{/.test(clientCss)
  && /\.qdb-msg\.is-flash \{ animation: qdb-msg-flash/.test(clientCss)
  && /@keyframes qdb-msg-flash/.test(clientCss));

console.log('[4] 行为：真正跑一遍这两个纯函数');
const START = clientJs.indexOf('  var MSG_PLACEHOLDER_RE');
const END = clientJs.indexOf('  function quoteHtml(m)');
ok('能从 client.js 里切出这两个函数做真值测试', START > 0 && END > START);
if (START > 0 && END > START) {
  const snippet = clientJs.slice(START, END);
  const factory = new Function(`${snippet}\nreturn { stripMediaPlaceholders, stripQuotePrefix };`);
  const { stripMediaPlaceholders, stripQuotePrefix } = factory();
  ok('两张图的正文：[图片][图片]好慢啊 → 好慢啊', stripMediaPlaceholders('[图片][图片]好慢啊', 2) === '好慢啊', stripMediaPlaceholders('[图片][图片]好慢啊', 2));
  ok('一张图 + @：@星夜IX [图片] → @星夜IX', stripMediaPlaceholders('@星夜IX [图片]', 1) === '@星夜IX', stripMediaPlaceholders('@星夜IX [图片]', 1));
  ok('只删 media 条数那么多（多出来的占位符是你自己打的字）',
    stripMediaPlaceholders('[图片]我写的[图片]', 1) === '我写的[图片]', stripMediaPlaceholders('[图片]我写的[图片]', 1));
  ok('没有 media 就一个字都不动', stripMediaPlaceholders('纯文字 [图片]', 0) === '纯文字 [图片]');
  ok('引用前缀里嵌着 [图片] 也能整体剔除',
    stripQuotePrefix('[引用 大肥鱼小姐：[图片]]@大肥鱼小姐 这张我要转存') === '@大肥鱼小姐 这张我要转存',
    stripQuotePrefix('[引用 大肥鱼小姐：[图片]]@大肥鱼小姐 这张我要转存'));
  ok('前缀在中间时只摘掉引用段',
    stripQuotePrefix('@nice [引用 nice：[图片][图片]好慢啊] 怎么才下').replace(/\s{2,}/g, ' ') === '@nice 怎么才下',
    stripQuotePrefix('@nice [引用 nice：[图片][图片]好慢啊] 怎么才下'));
  ok('没有引用前缀时原样返回', stripQuotePrefix('普通一句话') === '普通一句话');
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
if (fail) process.exit(1);
