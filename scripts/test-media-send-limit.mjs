// 表情/图片在「临时会话私聊」发不出去时，要给一句人能看懂的原因。
//
// 背景（2026-10-29 用户报障）：私聊里 qq_send_sticker / qq_draw 都失败，日志是
//   OneBot send_private_msg 失败: OIDB error 170019003 on 0x11c5_100: verify identify fail
// 根因不是桥接 bug，是 QQ 平台限制：对方不是我好友时，私聊走的是临时会话，只能发文字，
// 图片/表情上传会被服务端拒。原来的错误直接把 OIDB 原文抛给模型，它看不懂，还会反复重试。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name}`); }
};

const { mediaSendLimitText } = await import('../src/bridge/media-send.js');

console.log('## 平台限制要翻译成人话');
const privateFail = 'OneBot send_private_msg 失败: OIDB error 170019003 on 0x11c5_100: verify identify fail';
const text = mediaSendLimitText('send_private_msg', privateFail);
ok(/好友/.test(text) && /临时会话/.test(text) && /只能发文字/.test(text),
  '临时会话里发表情/图片失败 → 说明「对方不是我好友、只能发文字」');
ok(/加我好友|群里发/.test(text), '给出可执行的两条出路：加好友，或改到群里发');
ok(!/OIDB|verify identify/.test(text.replace(/（OIDB 170019003）/, '')), '不把 OIDB 原文丢给模型（只留一个编号方便查日志）');
ok(mediaSendLimitText('send_group_msg', privateFail) === '',
  '群聊失败不套这段文案（群里发图是好的，别误导）');
ok(mediaSendLimitText('send_private_msg', 'OneBot send_private_msg 失败: 发送失败，请先添加对方为好友') === '',
  '别的错误原样透出，不抢着解释');

console.log('## 两条发送路径都接了这个翻译');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, 'src/bridge/media-send.js'), 'utf8');
const stickerBlock = src.slice(
  src.indexOf('// @bridge-function sendStickerV2:start'),
  src.indexOf('// @bridge-function sendStickerV2:end')
);
const imageBlock = src.slice(
  src.indexOf('// @bridge-function sendImageV2:start'),
  src.indexOf('// @bridge-function sendImageV2:end')
);
ok(/mediaSendLimitText\(action, raw\)/.test(stickerBlock), 'sendStickerV2 失败时先过 mediaSendLimitText');
ok(/mediaSendLimitText\(action, raw\)/.test(imageBlock), 'sendImageV2 失败时先过 mediaSendLimitText');
ok(/export function mediaSendLimitText/.test(src), 'helper 是模块级导出（VM 里也能被 harness 直接调）');

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
