// 高峰期本地小模型接管的纯逻辑测试（不联网、不启动模型）。
import assert from 'node:assert/strict';
import {
  PEAK_LOCAL_DEFAULTS,
  buildPeakRequest,
  peakLocalCfg,
  normalizeMemberRole,
  shouldPeakLocal,
  buildPeakChatBody,
  parsePeakReply,
  buildPeakMessages
} from '../src/peak-local.js';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('✅ ' + name); } catch (e) { failed += 1; console.error('❌ ' + name + ' — ' + (e?.message ?? e)); }
}

check('默认值：关闭、qwen3:8b、不思考、只允许 owner/admin', () => {
  const c = peakLocalCfg(undefined);
  assert.equal(c.enabled, false);
  assert.equal(c.model, PEAK_LOCAL_DEFAULTS.model);
  assert.equal(c.think, false);
  assert.deepEqual(c.roles, ['owner', 'admin']);
  assert.equal(c.replyToAll, true);
  assert.equal(c.requireMention, false);
});

check('配置收敛：非法值回落默认、roles 过滤只留 owner/admin', () => {
  const c = peakLocalCfg({ enabled: 'yes', model: '  ', timeoutMs: -5, maxChars: 9999, roles: ['OWNER', 'member', 'Admin', 'x'], requireMention: false });
  assert.equal(c.enabled, false); // 只有 true 才算开
  assert.equal(c.model, PEAK_LOCAL_DEFAULTS.model);
  assert.equal(c.timeoutMs, 2000); // 夹到下限
  assert.equal(c.maxChars, 600); // 夹到上限
  assert.deepEqual(c.roles, ['owner', 'admin']);
  assert.equal(c.requireMention, false);
});

check('角色归一化：creator→owner、administrator→admin、未知→空', () => {
  assert.equal(normalizeMemberRole('owner'), 'owner');
  assert.equal(normalizeMemberRole('creator'), 'owner');
  assert.equal(normalizeMemberRole('ADMIN'), 'admin');
  assert.equal(normalizeMemberRole('administrator'), 'admin');
  assert.equal(normalizeMemberRole('member'), 'member');
  assert.equal(normalizeMemberRole(''), '');
  assert.equal(normalizeMemberRole(null), '');
});

check('接管判定矩阵', () => {
  const on = peakLocalCfg({ enabled: true, replyToAll: false });
  assert.equal(shouldPeakLocal({ cfg: on, role: 'owner', mentioned: true }).ok, true);
  assert.equal(shouldPeakLocal({ cfg: on, role: 'admin', mentioned: true }).ok, true);
  assert.equal(shouldPeakLocal({ cfg: on, role: 'member', mentioned: true }).ok, false);
  assert.equal(shouldPeakLocal({ cfg: on, role: 'owner', mentioned: false }).ok, false);
  assert.equal(shouldPeakLocal({ cfg: on, role: '', mentioned: true }).ok, false);
  assert.equal(shouldPeakLocal({ cfg: peakLocalCfg({ enabled: false }), role: 'owner', mentioned: true }).ok, false);
  const noMention = peakLocalCfg({ enabled: true, replyToAll: false, requireMention: false });
  assert.equal(shouldPeakLocal({ cfg: noMention, role: 'owner', mentioned: false }).ok, true);
  const ownerOnly = peakLocalCfg({ enabled: true, replyToAll: false, roles: ['owner'] });
  assert.equal(shouldPeakLocal({ cfg: ownerOnly, role: 'admin', mentioned: true }).ok, false);
  // 显式放行：群里实际是 member（实测 100000006 在四个群都是 member），靠 userIds 兜住
  const withUid = peakLocalCfg({ enabled: true, replyToAll: false, userIds: ['100000006'] });
  assert.equal(shouldPeakLocal({ cfg: withUid, role: 'member', mentioned: true, uid: '100000006' }).ok, true);
  assert.equal(shouldPeakLocal({ cfg: withUid, role: 'member', mentioned: false, uid: '100000006' }).ok, false);
  assert.equal(shouldPeakLocal({ cfg: withUid, role: 'member', mentioned: true, uid: '999999' }).ok, false);
});

check('ollama 请求体：think 必须显式传布尔、带 num_predict', () => {
  const body = buildPeakChatBody({ cfg: peakLocalCfg({ enabled: true, think: false, numPredict: 99 }), messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(body.model, PEAK_LOCAL_DEFAULTS.model);
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.equal(body.options.num_predict, 99);
  const thinkOn = buildPeakChatBody({ cfg: peakLocalCfg({ enabled: true, think: true }), messages: [] });
  assert.equal(thinkOn.think, true);
});

check('响应解析：空正文返回空串（调用方按失败处理）', () => {
  assert.equal(parsePeakReply({ message: { content: ' 你好 ' } }), '你好');
  assert.equal(parsePeakReply({ message: { content: '' } }), '');
  assert.equal(parsePeakReply({}), '');
  assert.equal(parsePeakReply(null), '');
});

check('消息组装：带最近记录与当前这句，限制条数', () => {
  const recent = [
    { sender: '群友A', plain: '今天吃啥' },
    { sender: '小鲸鱼', plain: '吃面', isSelf: true },
    { sender: '群友B', plain: '  ' }
  ];
  // historyMessages=4 → 取最近 3 条（再拼当前这句），这样群友A也在里面
  const msgs = buildPeakMessages({ recent, incomingText: '@小鲸鱼 出来聊天', cfg: peakLocalCfg({ enabled: true, historyMessages: 4 }) });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[1].content.includes('群友A：今天吃啥'));
  assert.ok(msgs[1].content.includes('我：吃面'));
  assert.ok(!msgs[1].content.includes('群友B'));
  assert.ok(msgs[1].content.includes('群友：@小鲸鱼 出来聊天'));
  assert.ok(msgs[1].content.endsWith('直接给出你要发到群里的那一句话。'));
});

check('消息组装：空历史时给兜底引导', () => {
  const msgs = buildPeakMessages({ recent: [], incomingText: '', cfg: peakLocalCfg({ enabled: true }) });
  assert.ok(msgs[1].content.includes('群里有人叫了你一声'));
});

check('OpenAI 兼容请求：带 Bearer、thinking 关闭、max_tokens', () => {
  const req = buildPeakRequest({ cfg: peakLocalCfg({ enabled: true, provider: 'openai', model: 'mimo-v2.6-pro', apiKey: 'sk-test' }), messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(req.url.endsWith('/chat/completions'));
  assert.equal(req.headers.authorization, 'Bearer sk-test');
  assert.equal(req.body.model, 'mimo-v2.6-pro');
  assert.deepEqual(req.body.thinking, { type: 'disabled' });
  assert.ok(req.body.max_tokens > 0);
});

check('ollama 请求：仍走 /api/chat 且带 think 字段', () => {
  const req = buildPeakRequest({ cfg: peakLocalCfg({ enabled: true, provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b' }), messages: [] });
  assert.ok(req.url.endsWith('/api/chat'));
  assert.equal(req.body.think, false);
});

check('parsePeakReply 兼容 OpenAI choices', () => {
  assert.equal(parsePeakReply({ choices: [{ message: { content: ' 在呢 ' } }] }), '在呢');
  assert.equal(parsePeakReply({ choices: [] }), '');
});

console.log(failed ? `\n❌ ${failed} 项失败` : `\n🎉 test-peak-local 全部通过（11 项）`);
process.exit(failed ? 1 : 0);
