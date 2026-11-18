// 自发媒体消息进时间线单测（离线：假 deps）。
//
// 事故背景：机器人用 qq_send_sticker 发过表情，群里确实收到了（QQ 侧 message_id 可查），
// 但控制台「日志」页只看得到「调用了 qq_send_sticker」的系统行，没有对应的「我」气泡——
// 根因是 recordSentMessagesV2 只接受纯文本、也只被文字发送路径调用；表情/图片发送成功后
// 没人把它写进 st.recentMessages。修法：该函数接受 { text, media, messageId }，两个媒体发送
// 路径都在成功后回写一条自我消息（media 带 kind=sticker/image 供时间线渲染小图）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMessageState } from '../src/bridge/message-state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { fail += 1; console.error(`  FAIL ${name}: ${error?.message ?? error}`); }
}

function makeHarness(recentLimit = 100) {
  const state = { recentMessages: [], unread: [] };
  let saves = 0;
  const deps = {
    getSocialV2State: () => state,
    saveSocialV2State: () => { saves += 1; },
    cfg: { socialV2: { context: { recentLimit } } },
    redactKnownTokensOnly: (text) => String(text),
    sanitizeMediaSummary: (text) => String(text ?? '').slice(0, 40),
    truncateText: (text, max) => String(text ?? '').slice(0, max),
    truncateTextTail: (text, max) => String(text ?? '').slice(-max),
    detectPersonaRequest: () => ({ hit: false }),
    notePersonaRequest: () => {},
    affinityNoteInbound: () => {},
    peopleNoteInbound: () => {},
    archiveAppend: () => {},
    markMediaTurn: () => {},
    maybeCollectSticker: () => {},
    maybeRefreshDigest: () => {},
    enrichVideoFile: async () => {},
    sanitizeForwardId: (value) => String(value ?? '').trim(),
    seenForwardIds: new Map()
  };
  const api = createMessageState(deps);
  return { state, api, saves: () => saves };
}

console.log('[1] 纯文本调用（老形态）保持原行为');
await check('字符串条目照旧记成一条「我」的文字消息', () => {
  const { state, api } = makeHarness();
  api.recordSentMessagesV2('group:1', ['我的上一句', '第二句']);
  assert.equal(state.recentMessages.length, 2);
  const first = state.recentMessages[0];
  assert.equal(first.sender, '我');
  assert.equal(first.isSelf, true);
  assert.equal(first.text, '我的上一句');
  assert.equal(first.hasMedia, false);
  assert.deepEqual(first.media, []);
  assert.equal(first.messageId, null);
});

console.log('[2] 媒体条目（表情 / 图片）');
await check('表情条目：kind=sticker、url/emojiId/summary 保留、messageId 转字符串', () => {
  const { state, api } = makeHarness();
  api.recordSentMessagesV2('group:1', [{
    text: '[表情] 表示自己楚楚可怜',
    media: [{
      kind: 'sticker',
      url: 'https://p.qpic.cn/qq_expression/x/0',
      emojiId: 'abc',
      summary: '[表情:表示自己楚楚可怜]',
      file: 'x.gif'
    }],
    messageId: -1526821109
  }]);
  const msg = state.recentMessages[0];
  assert.equal(msg.text, '[表情] 表示自己楚楚可怜');
  assert.equal(msg.hasMedia, true);
  assert.equal(msg.messageId, '-1526821109');
  assert.equal(msg.media.length, 1);
  assert.equal(msg.media[0].kind, 'sticker');
  assert.equal(msg.media[0].url, 'https://p.qpic.cn/qq_expression/x/0');
  assert.equal(msg.media[0].emojiId, 'abc');
  assert.equal(msg.media[0].file, 'x.gif');
  assert.equal(msg.media[0].summary, '[表情:表示自己楚楚可怜]');
});

await check('图片条目：kind=image 且有 url 时保留', () => {
  const { state, api } = makeHarness();
  api.recordSentMessagesV2('group:1', [{
    text: '[图片]',
    media: [{ kind: 'image', url: 'https://multimedia.nt.qq.com.cn/y' }],
    messageId: 42
  }]);
  const msg = state.recentMessages[0];
  assert.equal(msg.media[0].kind, 'image');
  assert.equal(msg.media[0].url, 'https://multimedia.nt.qq.com.cn/y');
  assert.equal(msg.hasMedia, true);
});

await check('既没有 file/url/emojiId 的媒体会被丢掉，hasMedia=false', () => {
  const { state, api } = makeHarness();
  api.recordSentMessagesV2('group:1', [{ text: '[图片]', media: [{ kind: 'image' }] }]);
  const msg = state.recentMessages[0];
  assert.deepEqual(msg.media, []);
  assert.equal(msg.hasMedia, false);
});

await check('未知 kind 归一成 image，不抛错', () => {
  const { state, api } = makeHarness();
  api.recordSentMessagesV2('group:1', [{ text: 'x', media: [{ kind: 'video-file', file: 'a.mp4' }] }]);
  assert.equal(state.recentMessages[0].media[0].kind, 'image');
});

console.log('[3] 长度上限与落盘');
await check('超出 recentLimit 时从头裁掉', () => {
  const { state, api } = makeHarness(3);
  for (let i = 0; i < 5; i += 1) api.recordSentMessagesV2('group:1', ['m' + i]);
  assert.deepEqual(state.recentMessages.map((m) => m.text), ['m2', 'm3', 'm4']);
});

await check('写自我消息会触发一次 saveSocialV2State', () => {
  const { api, saves } = makeHarness();
  const before = saves();
  api.recordSentMessagesV2('group:1', [{ text: '[表情]', media: [{ kind: 'sticker', file: 'a.gif' }] }]);
  assert.equal(saves(), before + 1);
});

console.log('[4] 发送路径确实回写了时间线（静态检查）');
const mediaSendSrc = fs.readFileSync(path.join(root, 'src/bridge/media-send.js'), 'utf8');
// 控制台的 <style>/<script> 已拆成独立静态资源（2026-10-28），断言要跟着读新位置，
// 否则拆分一落地这个套件就假失败（retire-console 已报过）。
const clientHtml = fs.readFileSync(path.join(root, 'public/client.html'), 'utf8');
const clientJs = fs.readFileSync(path.join(root, 'public/client.js'), 'utf8');
const clientCss = fs.readFileSync(path.join(root, 'public/client.css'), 'utf8');
const clientSrc = clientHtml + "\n" + clientJs + "\n" + clientCss;

function sliceBetween(source, startMark, endMark) {
  const start = source.indexOf(startMark);
  assert.ok(start >= 0, `找不到 ${startMark}`);
  const end = source.indexOf(endMark, start);
  assert.ok(end > start, `找不到 ${endMark}`);
  return source.slice(start, end);
}

await check('sendStickerV2 里调用 recordSentMessagesV2 且 kind=sticker', () => {
  const block = sliceBetween(mediaSendSrc, '@bridge-function sendStickerV2:start', '@bridge-function sendStickerV2:end');
  assert.match(block, /recordSentMessagesV2/);
  assert.match(block, /kind: 'sticker'/);
  assert.match(block, /\[表情\]/);
});

await check('sendImageV2 里调用 recordSentMessagesV2 且 kind=image', () => {
  const block = sliceBetween(mediaSendSrc, '@bridge-function sendImageV2:start', '@bridge-function sendImageV2:end');
  assert.match(block, /recordSentMessagesV2/);
  assert.match(block, /kind: 'image'/);
  assert.match(block, /\[图片\]/);
});

await check('媒体回写失败只记日志，不影响发送结果', () => {
  const block = sliceBetween(mediaSendSrc, '@bridge-function sendStickerV2:start', '@bridge-function sendStickerV2:end');
  assert.match(block, /try \{[\s\S]*recordSentMessagesV2[\s\S]*\} catch/);
  assert.match(block, /return \{ entry: updated\.entry, messageId/);
});

console.log('[5] 客户端把表情画成小图（静态检查）');
await check('tlImageHtml 同时接受 image 与 sticker，并给 sticker 单独类名', () => {
  const block = sliceBetween(clientSrc, 'function tlImageHtml(m)', 'function bindTimelineImages(root)');
  assert.match(block, /item\.kind === 'sticker'/);
  assert.match(block, /qdb-tl-sticker/);
});

await check('样式里定义了 96px 的 .qdb-tl-sticker', () => {
  assert.match(clientSrc, /\.qdb-tl-sticker \{[\s\S]{0,200}width: 96px/);
});

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
