// AI 黑名单「发送前硬闸」：纯判定单测（src/ai-blacklist-gate.js）+ 接线断言。
//
// 为什么测两层：
//   ① 纯函数：名单/模式/引用/@/文字 @ 的每条规则都在这里锁住，改文案或改优先级时先红；
//   ② 接线：闸门是"发送前"才有效，必须断言它真的插在 sendMessageAutoVoice /
//      sendMessageQuota 之前（否则语音路径会绕过），并且两个发送入口（send-message、
//      send-burst）都过闸、拒绝时会写 tool-calls 的 blocked 记录。
// 不联网、不读写 state：纯函数 + 读源码文本。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const gate = await import(pathToFileURL(path.join(ROOT, 'src/ai-blacklist-gate.js')).href);
const sendSrc = fs.readFileSync(path.join(ROOT, 'src/bridge/console/conversation-send.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
const harnessSrc = fs.readFileSync(path.join(ROOT, 'scripts/audit-bridge-harness.mjs'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/bridge/manifest.json'), 'utf8'));
const gateSrc = fs.readFileSync(path.join(ROOT, 'src/ai-blacklist-gate.js'), 'utf8');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const AI = { id: '27247015170' , qq: '1' };
const HUMAN = { id: '10001000' };
const cfgOn = {
  enabled: true,
  mode: 'reduce',
  qq: [
    { id: '100000007', note: '小冰' },
    { id: '90001000', note: '阿米娅' }
  ]
};
const cfgOff = { ...cfgOn, enabled: false };
const cfgSilent = { ...cfgOn, mode: 'silent' };

const run = (input) => gate.gateAiBlacklistSend(input);

console.log('## 配置归一化');
check('未配置时默认关闭', gate.normalizeGateConfig(undefined).enabled === false);
check('mode 缺省按 reduce', gate.normalizeGateConfig({ enabled: true }).mode === 'reduce');
check('mode=silent 保留', gate.normalizeGateConfig({ enabled: true, mode: 'silent' }).mode === 'silent');
check('坏 id 被丢掉、重复 id 去重', (() => {
  const cfg = gate.normalizeGateConfig({ enabled: true, qq: [{ id: '12345' }, { id: '12345' }, { id: 'abc' }, { id: '１２３４５' }] });
  return cfg.entries.length === 1 && cfg.entries[0].id === '12345';
})());
check('昵称截到 40 字、空白折叠成匹配键', (() => {
  const cfg = gate.normalizeGateConfig({ enabled: true, qq: [{ id: '12345', note: '  阿 米 娅  ' }] });
  const entry = cfg.entries[0];
  return entry.note.length <= 40 && entry.noteKey === '阿米娅';
})());

console.log('## 规则一：引用名单里的 AI');
check('回名单内被拒（reason=reply-to-blacklisted）', (() => {
  const r = run({ cfg: cfgOn, kind: 'group', replyToUserId: '100000007', texts: ['在吗'] });
  return r.allow === false && r.reason === 'reply-to-blacklisted';
})());
check('拒绝文案是给模型看的人话', (() => {
  const r = run({ cfg: cfgOn, kind: 'group', replyToUserId: '100000007', texts: ['在吗'] });
  return r.text === '这条是回名单里那个 AI 的，不接（AI 黑名单）';
})());
check('回人类放行', run({ cfg: cfgOn, kind: 'group', replyToUserId: '10001000', texts: ['在吗'] }).allow === true);
check('数字/字符串 senderId 都认', run({ cfg: cfgOn, kind: 'group', replyToUserId: 100000007 }).allow === false);
check('引用目标缺失/空串放行', run({ cfg: cfgOn, kind: 'group', replyToUserId: '' }).allow === true && run({ cfg: cfgOn, kind: 'group', replyToUserId: null }).allow === true);
check('私聊引用名单 AI 也拦', run({ cfg: cfgOn, kind: 'private', replyToUserId: '100000007' }).allow === false);

console.log('## 规则二：at 名单里的 AI');
check('atUserId 命中被拒（reason=at-blacklisted）', (() => {
  const r = run({ cfg: cfgOn, kind: 'group', atUserIds: ['90001000'], texts: ['你好'] });
  return r.allow === false && r.reason === 'at-blacklisted' && r.matchedId === '90001000';
})());
check('at 人类放行', run({ cfg: cfgOn, kind: 'group', atUserIds: ['10001000'], texts: ['你好'] }).allow === true);
check('私聊的 at 不参与判定', run({ cfg: cfgOn, kind: 'private', atUserIds: ['90001000'], texts: ['你好'] }).allow === true);
check('文本里的 [CQ:at,qq=] 也拦（防绕过）', run({ cfg: cfgOn, kind: 'group', texts: ['[CQ:at,qq=90001000] 你好'] }).allow === false);
check('文本里的 <at qq="..."> 也拦（防绕过）', run({ cfg: cfgOn, kind: 'group', texts: ['<at qq="90001000"> 你好'] }).allow === false);
check('atIdsFromText 解析两种写法', (() => {
  const ids = gate.atIdsFromText('[CQ:at,qq=12345] 和 <at user_id="67890"> 还有 <at qq=\'11111\'>');
  return ids.join(',') === '12345,67890,11111';
})());

console.log('## 规则三：文字里的「@昵称」');
check('文字 @ 名单昵称被拒（reason=text-at-blacklisted）', (() => {
  const r = run({ cfg: cfgOn, kind: 'group', texts: ['@小冰 你觉得呢'] });
  return r.allow === false && r.reason === 'text-at-blacklisted' && r.matchedNote === '小冰';
})());
check('昵称中间有空格也能匹配（归一化后包含）', run({ cfg: cfgOn, kind: 'group', texts: ['@阿 米 娅 在吗'] }).allow === false);
check('文字 @ 没匹配到名单放行', run({ cfg: cfgOn, kind: 'group', texts: ['@张三 你看'] }).allow === true);
check('只 @ 了名单但拼成别的词不误伤', run({ cfg: cfgOn, kind: 'group', texts: ['小冰这个名字不错'] }).allow === true);
check('多个名单成员同名时宁可不拦（避免误伤）', (() => {
  const cfg = { enabled: true, mode: 'reduce', qq: [{ id: '12345', note: '同名' }, { id: '67890', note: '同名' }] };
  return run({ cfg, kind: 'group', texts: ['@同名 在吗'] }).allow === true;
})());

console.log('## 规则四：开关与 silent 模式');
check('enabled=false 时全放行（含引用/at/文字 @）', (() => {
  return run({ cfg: cfgOff, kind: 'group', replyToUserId: '100000007', atUserIds: ['90001000'], texts: ['@小冰'] }).allow === true;
})());
check('silent 仍拦引用', run({ cfg: cfgSilent, kind: 'group', replyToUserId: '100000007' }).allow === false);
check('silent 仍拦 at', run({ cfg: cfgSilent, kind: 'group', atUserIds: ['90001000'] }).allow === false);
check('silent 放行纯文字 @（不参与本轮）', run({ cfg: cfgSilent, kind: 'group', texts: ['@小冰 你好'] }).allow === true);
check('坏配置对象不炸（null / 空对象）', run({ cfg: null, kind: 'group', texts: ['hi'] }).allow === true && run({}).allow === true);

console.log('## 文案与形状');
check('放行时 reason=null、text 为空', (() => {
  const r = run({ cfg: cfgOn, kind: 'group', texts: ['hi'] });
  return r.allow === true && r.reason === null && r.text === '';
})());
check('三种拒绝文案都不含 [object Object]', ['reply-to-blacklisted', 'at-blacklisted', 'text-at-blacklisted'].every((reason) => {
  const cfg = { enabled: true, mode: 'reduce', qq: [{ id: '100000007', note: '小冰' }] };
  const r = reason === 'reply-to-blacklisted'
    ? run({ cfg, kind: 'group', replyToUserId: '100000007' })
    : (reason === 'at-blacklisted' ? run({ cfg, kind: 'group', atUserIds: ['100000007'] }) : run({ cfg, kind: 'group', texts: ['@小冰'] }));
  return r.reason === reason && !/\[object Object\]/.test(r.text) && r.text.length > 0;
}));
check('reason 都登记了中文文案', ['reply-to-blacklisted', 'at-blacklisted', 'text-at-blacklisted'].every((reason) => typeof gate.AI_BLACKLIST_GATE_REASON_TEXT[reason] === 'string'));

console.log('## 纯模块约束（VM-safe）');
check('ai-blacklist-gate.js 没有 import/require', !/^\s*import\s/m.test(gateSrc) && !/\brequire\(/.test(gateSrc));
check('ai-blacklist-gate.js 不碰 process/Buffer/fs', !/\bprocess\./.test(gateSrc) && !/\bBuffer\./.test(gateSrc) && !/\brequire\b/.test(gateSrc));

console.log('## 接线：发送路由');
const gateCallAt = sendSrc.indexOf("tool: 'qq_send_message'");
const voiceCallAt = sendSrc.indexOf('sendMessageAutoVoice(deps, request, ctx)');
const quotaCallAt = sendSrc.indexOf('sendMessageQuota(deps, request, ctx)');
const finalCallAt = sendSrc.indexOf('sendMessageFinal(deps, request, prepared)');
check('send-message 有 aiBlacklistSendGate 调用', gateCallAt > 0);
check('闸门插在自动转语音之前（语音路径不绕过）', gateCallAt > 0 && voiceCallAt > gateCallAt);
check('闸门插在额度预占/引用解析之前', gateCallAt > 0 && quotaCallAt > gateCallAt);
check('闸门在真正发送之前', gateCallAt > 0 && finalCallAt > gateCallAt);
check('send-burst 同样过闸（tool=qq_send_burst）', /tool: 'qq_send_burst'/.test(sendSrc));
check('闸门位于 burst 的静默检查之后、发送之前', (() => {
  const silentAt = sendSrc.indexOf('静默模式已开启，当前不允许发送');
  const burstGateAt = sendSrc.indexOf("tool: 'qq_send_burst'");
  const burstSendAt = sendSrc.indexOf('sendBurstSend(deps, request, { key, messages })');
  return silentAt > 0 && burstGateAt > silentAt && burstSendAt > burstGateAt;
})());
check('拒绝时写 tool-calls：blocked=ai-blacklist + reason', /blocked: 'ai-blacklist'/.test(sendSrc) && /reason: gate\.reason/.test(sendSrc));
check('拒绝时不抛错：回 403 JSON 人话', /request\.sendJson\(\{ ok: false, blocked: 'ai-blacklist', reason: gate\.reason, error: gate\.text \}, 403\)/.test(sendSrc));
check('关闭时短路、不解析引用（省 OneBot 查询）', /normalizeGateConfig\)\(deps\.cfg\?\.socialV2\?\.aiBlacklist\)\.enabled\) return false;/.test(sendSrc));

console.log('## 接线：注入与清单');
check('bridge.js 注入 aiBlacklistGatePure', /import \* as aiBlacklistGatePure from '\.\/ai-blacklist-gate\.js';/.test(bridgeSrc) && /runtimeBindings\.aiBlacklistGatePure = aiBlacklistGatePure;/.test(bridgeSrc));
check('harness context 注入 aiBlacklistGatePure', /aiBlacklistGatePure: aiBlacklistGateNs,/.test(harnessSrc));
check('conversation-send manifest 声明 aiBlacklistGatePure + appendToolLog', (() => {
  const entry = manifest.modules.find((m) => m.file === 'src/bridge/console/conversation-send.js');
  return !!entry && entry.dependencies.includes('aiBlacklistGatePure') && entry.dependencies.includes('appendToolLog');
})());
check('aiBlacklistGatePure 不在 manifest 里当模块（它是纯规则，不是 VM 模块）', !manifest.modules.some((m) => m.file === 'src/ai-blacklist-gate.js'));

console.log('## 未改 runtime 语义');
check('src/ai-blacklist.js 仍只导出 runtime/admin（不含发送闸）', (() => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ai-blacklist.js'), 'utf8');
  return !/gateAiBlacklistSend/.test(src) && /createAiBlacklistRuntime/.test(src) && /createAiBlacklistAdmin/.test(src);
})());

console.log('## 媒体路径：贴纸 / 图片 / 出图');
const mediaSrc = fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe/tools-media.js'), 'utf8');
const mediaGuardMod = await import(pathToFileURL(path.join(ROOT, 'src/mcp-snowluma-safe/media-reply-guard.js')).href);
const MEDIA_TOOLS = [['qq_send_sticker', "/api/socialV2/send-sticker"], ['qq_send_image', "/api/socialV2/send-image"], ['qq_draw', "/api/socialV2/draw"]];
check('三个媒体入口都接了 guardMediaReply，且拒绝时在 agentApi 之前 return isError', MEDIA_TOOLS.every(([tool, api]) => {
  const guardAt = mediaSrc.indexOf(`guardMediaReply({ key, token, replyToMessageId, tool: '${tool}' })`);
  const apiAt = mediaSrc.indexOf(`await agentApi('${api}'`);
  return guardAt > 0 && apiAt > guardAt && mediaSrc.includes("if (blocked) return { content: [{ type: 'text', text: blocked.text }], isError: true };");
}));
const mkMediaGuard = (opt = {}) => {
  const calls = { resolve: 0, blocked: [] };
  const guard = mediaGuardMod.createMediaReplyGuard({
    getConfig: () => ({ socialV2: { aiBlacklist: opt.cfg ?? cfgOn } }),
    resolveReplySender: async () => {
      calls.resolve += 1;
      if (opt.resolveError) throw new Error('消息详情接口炸了');
      return opt.userId === undefined ? '100000007' : opt.userId;
    },
    appendBlocked: (entry) => calls.blocked.push(entry),
    log: () => {}
  });
  return { guard, calls };
};
const blockedMedia = await mkMediaGuard().guard({ key: 'group:123', token: 't', replyToMessageId: 5, tool: 'qq_send_sticker' });
check('媒体回复名单 AI 被拒：文案是「不发送」且 reason 正确', blockedMedia?.reason === 'reply-to-blacklisted' && blockedMedia?.text === mediaGuardMod.MEDIA_REPLY_BLOCKED_TEXT && blockedMedia.text === '这条是回名单里那个 AI 的，不发送（AI 黑名单）');
const humanMedia = await mkMediaGuard({ userId: '10001000' }).guard({ key: 'group:123', token: 't', replyToMessageId: 5, tool: 'qq_send_image' });
check('媒体回复人类放行', humanMedia === null);
const offGuard = mkMediaGuard({ cfg: cfgOff });
const offMedia = await offGuard.guard({ key: 'group:123', token: 't', replyToMessageId: 5, tool: 'qq_draw' });
check('黑名单关闭时媒体放行，且不查消息详情（零成本）', offMedia === null && offGuard.calls.resolve === 0);
const logGuard = mkMediaGuard();
const logMedia = await logGuard.guard({ key: 'group:123', token: 't', replyToMessageId: 5, tool: 'qq_send_sticker' });
check('媒体拦截写 tool-calls：type=blocked + blocked=ai-blacklist + reason', (() => {
  const entry = logGuard.calls.blocked[0];
  return !!logMedia && !!entry && entry.type === 'blocked' && entry.blocked === 'ai-blacklist' && entry.reason === 'reply-to-blacklisted' && entry.tool === 'qq_send_sticker' && entry.key === 'group:123';
})());
const noAtGuard = mkMediaGuard();
await noAtGuard.guard({ key: 'group:123', token: 't', replyToMessageId: 5, tool: 'qq_send_image' });
check('媒体判定只传 replyTo，不带 at 段（避免过度拦截）', !/atUserIds/.test(String(mediaGuardMod.createMediaReplyGuard)) && !/atUserIds/.test(fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe/media-reply-guard.js'), 'utf8').replace(/\/\/.*$/gm, '')));
const failOpen = await mkMediaGuard({ resolveError: true }).guard({ key: 'group:123', token: 't', replyToMessageId: 5, tool: 'qq_draw' });
check('消息详情解析失败时 fail-open（不误拦）且文案无 [object Object]', failOpen === null && !/\[object Object\]/.test(mediaGuardMod.MEDIA_REPLY_BLOCKED_TEXT));
const guardSrc = fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe/media-reply-guard.js'), 'utf8').replace(/\/\/.*$/gm, '');
check('媒体闸查 senderId 用控制台令牌（readConsoleToken），不带 x-agent-token / x-agent-call', /readConsoleToken\(\)/.test(guardSrc) && /x-console-token/.test(guardSrc) && !/x-agent-token/.test(guardSrc) && !/x-agent-call/.test(guardSrc));

console.log('## 语音 / 转发：还有没有绕过面（tripwire）');
// 工具块切分：每个 server.tool( 到下一个 server.tool( 之间算一个工具的代码块。
const toolBlocks = mediaSrc.split('server.tool(').slice(1).map((block, i) => {
  const name = (block.match(/'([a-z0-9_]+)'/) || [])[1] || `#${i}`;
  return { name, block };
});
const replyCapableTools = toolBlocks.filter((t) => /replyToMessageId:\s*z\./.test(t.block));
check('tripwire：所有声明 replyToMessageId 的媒体工具都在 agentApi 前过 media-reply-guard', replyCapableTools.length >= 3 && replyCapableTools.every((t) => {
  const guardAt = t.block.indexOf('guardMediaReply(');
  const apiAt = t.block.indexOf('agentApi(');
  return guardAt > 0 && apiAt > guardAt;
}));

const mediaConsole = fs.readFileSync(path.join(ROOT, 'src/bridge/console/media-tools.js'), 'utf8');
const sliceBetween = (src, from, to) => {
  const a = src.indexOf(from);
  const b = to ? src.indexOf(to) : src.length;
  return a >= 0 && b > a ? src.slice(a, b) : '';
};
const routeTtsSrc = sliceBetween(mediaConsole, 'async function routeTts(', 'async function sendVoiceAfterBudget(');
const sendVoiceBranch = sliceBetween(mediaConsole, "pathname === '/api/socialV2/send-voice'", "pathname === '/api/socialV2/send-sticker'");
check('qq_send_tts 没有引用语义：工具 schema 与桥接 routeTts 都不接 replyToMessageId', (() => {
  const block = toolBlocks.find((t) => t.name === 'qq_send_tts')?.block || '';
  return block.length > 0 && !/replyToMessageId/.test(block) && routeTtsSrc.length > 0 && !/replyToMessageId/.test(routeTtsSrc);
})());
check('qq_send_voice 没有引用语义：工具 schema、桥接 send-voice 分支、送发参数都不接 replyToMessageId', (() => {
  const block = toolBlocks.find((t) => t.name === 'qq_send_voice')?.block || '';
  return block.length > 0 && !/replyToMessageId/.test(block) && sendVoiceBranch.length > 0 && !/replyToMessageId/.test(sendVoiceBranch);
})());
const allToolsSrc = fs.readdirSync(path.join(ROOT, 'src/mcp-snowluma-safe'))
  .filter((f) => /^tools-.*\.js$/.test(f))
  .map((f) => fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe', f), 'utf8'))
  .join('\n');
check('没有「发送合并转发」工具（qq_send_forward / qq_merge_forward 都不存在），只有只读 qq_get_forward_msg', !/'qq_send_forward'/.test(allToolsSrc) && !/'qq_merge_forward'/.test(allToolsSrc) && /'qq_get_forward_msg'/.test(allToolsSrc));
const noReplyGuard = mediaGuardMod.createMediaReplyGuard({
  getConfig: () => ({ socialV2: { aiBlacklist: cfgOn } }),
  resolveReplySender: async () => { throw new Error('无引用时不该解析'); },
  appendBlocked: () => { throw new Error('无引用时不该写日志'); },
  log: () => {}
});
check('语音类调用（无 replyToMessageId）零成本放行：不解析、不写日志、不查配置以外的任何东西', (await noReplyGuard({ key: 'group:123', token: 't' })) === null && (await noReplyGuard({ key: 'group:123', token: 't', replyToMessageId: undefined })) === null && (await noReplyGuard({ key: 'group:123', token: 't', replyToMessageId: '' })) === null);

console.log('');
console.log(`ai-blacklist-gate：通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
