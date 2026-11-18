// 「@我 + /persona」命令识别：文本与段数组两种形态（纯函数）。
// 为什么要测这么细：误判的代价是「用户随口提一句『你可以发 /persona 试试』就被换人设」，
// 漏判的代价是「@了我却当闲聊回」。两种形态 QQ 网关都会给，所以两边都要覆盖。
import { parseMentionCommand, personaUsageHint } from '../src/mention-command.js';

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}
function at(qq, extra = {}) { return { type: 'at', qq, ...extra }; }
function txt(text) { return { type: 'text', text }; }

const SELF = { selfIds: ['123'], selfNames: ['大肥鱼小姐'] };

console.log('\n## 段数组');
const seg = parseMentionCommand([at('123', { name: '大肥鱼小姐' }), txt(' /persona 猫娘')], SELF);
eq('at 自己 + /persona 猫娘：命中', [seg.found, seg.command, seg.arg], [true, '/persona', '猫娘']);
eq('strippedText 保留命令原文', seg.strippedText, '/persona 猫娘');
eq('atSelf=true', seg.atSelf, true);
eq('at 别人不触发',
  parseMentionCommand([at('999'), txt(' /persona 猫娘')], SELF),
  { found: false, command: '', arg: '', strippedText: '', atSelf: false });
eq('段数组没有 at 不触发', parseMentionCommand([txt('/persona 猫娘')], SELF).found, false);
eq('at 自己但第一 token 不是命令不触发',
  parseMentionCommand([at('123'), txt(' 你可以发 /persona 试试')], SELF).found, false);
eq('data.qq 形态也认',
  parseMentionCommand([{ type: 'at', data: { qq: '123' } }, txt('/persona 猫娘')], SELF).found, true);
eq('命令大小写不敏感',
  parseMentionCommand([at('123'), txt('/PERSONA 猫娘')], SELF).arg, '猫娘');
check('strippedText 保留原始大小写',
  parseMentionCommand([at('123'), txt('/Persona 猫娘')], SELF).strippedText === '/Persona 猫娘');

console.log('\n## 文本形态');
const textCase = parseMentionCommand('@大肥鱼小姐 /persona 猫娘', SELF);
eq('@昵称 + 命令：命中', [textCase.found, textCase.arg, textCase.strippedText], [true, '猫娘', '/persona 猫娘']);
eq('前缀多余空格也算', parseMentionCommand('  @大肥鱼小姐   /persona   猫娘  ', SELF).arg, '猫娘');
eq('昵称大小写不同不算（名字精确匹配）',
  parseMentionCommand('@大肥鱼 /persona 猫娘', SELF).found, false);
const cq = parseMentionCommand('[CQ:at,qq=123] /persona x', SELF);
eq('CQ 码形态命中', [cq.found, cq.arg, cq.strippedText], [true, 'x', '/persona x']);
eq('CQ 码 at 别人不触发', parseMentionCommand('[CQ:at,qq=999] /persona x', SELF).found, false);
eq('selfNames 为空：@ anybody 视为可能，但要求命令紧跟其后',
  [parseMentionCommand('@谁 /persona x', { selfIds: ['123'] }).found,
    parseMentionCommand('@谁 你好 /persona x', { selfIds: ['123'] }).found],
  [true, false]);
eq('没有 @ 不触发（私聊里也得 @ 才改人设）',
  parseMentionCommand('/persona x', SELF).found, false);
eq('正文提及 /persona 不触发（哪怕在 @ 之后）',
  parseMentionCommand('@大肥鱼小姐 你可以发 /persona 试试', SELF).found, false);
eq('@别人 + 命令不触发', parseMentionCommand('@其他人 /persona x', SELF).found, false);
eq('/personasync 不算命令', parseMentionCommand('@大肥鱼小姐 /personasync x', SELF).found, false);

console.log('\n## 参数与提示');
const noArg = parseMentionCommand('@大肥鱼小姐 /persona', SELF);
eq('无参数：arg 空、仍命中', [noArg.found, noArg.arg, noArg.strippedText], [true, '', '/persona']);
eq('/persona off 原样带回', parseMentionCommand('@大肥鱼小姐 /persona off', SELF).arg, 'off');
eq('非 persona 命令不误判',
  parseMentionCommand('@大肥鱼小姐 /help', SELF),
  { found: false, command: '', arg: '', strippedText: '', atSelf: true });
eq('空消息不炸', parseMentionCommand('', SELF), { found: false, command: '', arg: '', strippedText: '', atSelf: false });
eq('undefined 不炸', parseMentionCommand(undefined, SELF).found, false);
const hint = personaUsageHint();
check('用法提示 ≤60 字', Array.from(hint).length <= 60, `实际 ${Array.from(hint).length}`);
check('用法提示含 /persona off 与「不用 @」', hint.includes('/persona off') && hint.includes('不用 @'));
check('连续 @ 两个自己：吞掉两个前缀仍命中',
  parseMentionCommand('@大肥鱼小姐 @大肥鱼小姐 /persona 猫娘', SELF).found === true);

console.log('');
if (failures.length) {
  console.error(`mention-command：通过 ${pass} / 失败 ${failures.length}`);
  process.exit(1);
}
console.log(`🎉 mention-command 全部通过（${pass} 项）`);
