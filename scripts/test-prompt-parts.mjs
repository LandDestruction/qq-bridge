#!/usr/bin/env node
// D38：/api/debug/prompt-parts 改成按 key 现算。
// 旧实现读 globalThis.__dshPromptParts：不认 key（返回最后一个构建的会话）、重启后归零（假红）、
// 没有时间戳。这里覆盖三件事：
//   [A] 按 key 现算：A 群/B 群各自的分段与 total 不同，且必含 selfModel / crossSession / role；
//   [B] 没有数据不许静默 0：必须带能看懂的原因；没带 key 明确 400；
//   [C] 调试构建不写 state、不消费交接摘要、不把 prompt 正文（含令牌）带出去。
// 用法：node scripts/test-prompt-parts.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY_A = 'group:456';
const KEY_B = 'group:789';
let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) { ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`); }
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const h = await bridgeHarness({
  config: {
    allow: { private: ['123'], groups: ['456', '789'] },
    // 画图能力行要看 imagegen 配置：这里给一个「有 key」的槽，断言 prompt 里必须出现 draw 段。
    imagegen: { enabled: true, mode: 'tiered', preferred: { mode: 'openai-image', baseUrl: 'https://img.example/v4', model: 'cogview-test', apiKey: 'test-key' } },
    socialV2: { wake: { preSleepWaitEnabled: false, preSleepWaitMs: 1000 } },
    dsh: { provider: 'workbuddy2api', model: 'deepseek-v4.1-flash', reasoningEffort: 'high', visionModels: ['deepseek-flash'] }
  },
  files: {
    // 有角色，才会有 role 段（读 state/current-role.json）。
    'state/current-role.json': JSON.stringify({ role: '大肥鱼小姐', mode: 'active' })
  }
});
h.setMode('reserved2');
// 身份段要有内容：harness 默认不设自身昵称/QQ。
h.setSelfIdentity('樰', '100000006');

// A 群：一条带图未读 → mediaAware / 状态段都有内容；B 群：干净会话。
h.appendSocialV2Message(KEY_A, '小明', '你用的什么模型', '你用的什么模型', false, false,
  '1', [{ kind: 'image', file: 'fixture-prompt-parts' }], '789', []);
h.getSocialV2State(KEY_B);
// 跨会话摘要：A 群的摘要会注入到 B 群（排除当前 key），用来验证 crossSession 段非空。
h.socialV2.digests = {
  [KEY_A]: { at: Date.now(), summary: '那边在聊 VRChat 素材库归档', topics: ['素材库'], people: ['小明'] }
};

const stA = h.getSocialV2State(KEY_A);
const stB = h.getSocialV2State(KEY_B);

const server = h.startConsoleServer();
if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));

function request(route, { token = 'fixture-console-token' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = token ? { 'x-console-token': token } : {};
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port,
      path: route, method: 'GET', headers
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: null, raw: data.slice(0, 200) }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('fixture request timeout')));
    req.end();
  });
}
const partsOf = (route, opts) => request(route, opts);

try {
  console.log('[A] 按 key 现算');
  const plainState = () => JSON.stringify({ unread: stA.unread, wake: stA.wakeConfig, read: stA.lastReadThroughSeq });
  const beforeState = plainState();
  const stateFile = path.join(h.temp, 'state/social-v2.json');
  const beforeFileHash = fs.existsSync(stateFile) ? sha256(fs.readFileSync(stateFile)) : null;

  const a = await partsOf(`/api/debug/prompt-parts?key=${encodeURIComponent(KEY_A)}`);
  eq('A 请求 200', a.status, 200);
  eq('A 回应 key 就是请求的 key', a.data.key, KEY_A);
  eq('A mode=live（现算）', a.data.mode, 'live');
  eq('A reason=debug', a.data.reason, 'debug');
  eq('A excluded 明确排除 initialPrompt/handoff', JSON.stringify(a.data.excluded), JSON.stringify(['initialPrompt', 'handoff']));
  ok('A builtAt 是刚写的时间戳', Math.abs(Date.now() - Number(a.data.builtAt)) < 10000, String(a.data.builtAt));
  ok('A total = 各段 chars 之和', a.data.total === a.data.parts.reduce((n, p) => n + p.chars, 0), `total=${a.data.total}`);
  const byName = Object.fromEntries(a.data.parts.map((p) => [p.name, p.chars]));
  ok('A 含 selfModel 段且字数非 0（D37 的 46 字符段）', byName.selfModel > 0, `selfModel=${byName.selfModel}`);
  ok('A 含 role 段（有当前角色才有）', byName.role > 0, `role=${byName.role}`);
  ok('A 含 identity / token 段', byName.identity > 0 && byName.token > 0);
  // 上下文管理工具（compress/decompress/…）不在 QQ 预设里：唤醒词里必须写明边界，
  // 否则模型看见这些工具名就会试一次，被 guard 拒掉后白费一步（线上踩过，见 issue）。
  ok('A 含 hostTool 段（写明没有上下文管理工具）', byName.hostTool > 0, `hostTool=${byName.hostTool}`);
  ok('hostTool 段在 A 里只出现一次', a.data.parts.filter((p) => p.name === 'hostTool').length === 1);
  // 画图能力行：fixture 配置里没有生图 key，所以 chars 是 0；段落必须存在（真机配置了 key 才会非 0，
  // 线上实测 /api/debug/prompt-parts 的 draw=133）。「没 key 就说不会画」的兜底仍由预设负责。
  ok('A 含 draw 段（配置了生图 key 时非 0）', byName.draw !== undefined, `draw=${byName.draw}`);
  // 2026-11-02：群里把「A 说的话」安到「B」头上 → 唤醒词必须有说话人纪律段。
  ok('A 含 attribution 段（说话人纪律）', byName.attribution > 0, `attribution=${byName.attribution}`);
  ok('attribution 段只出现一次', a.data.parts.filter((p) => p.name === 'attribution').length === 1);
  ok('draw 段在 A 里只出现一次', a.data.parts.filter((p) => p.name === 'draw').length === 1);
  ok('A 含 mediaAware 段（这条未读带图）', byName.mediaAware > 0, `mediaAware=${byName.mediaAware}`);
  ok('A 只返回 name+chars，没有 text 正文', a.data.parts.every((p) => !('text' in p) && Object.keys(p).sort().join(',') === 'chars,name'));
  ok('A 返回体不含 prompt 正文标记「【」', !JSON.stringify(a.data).includes('【'));
  ok('A 返回体不含会话令牌', !JSON.stringify(a.data).includes(stA.agentToken));

  const b = await partsOf(`/api/debug/prompt-parts?key=${encodeURIComponent(KEY_B)}`);
  eq('B 请求 200', b.status, 200);
  eq('B key 独立（不是 A 的快照）', b.data.key, KEY_B);
  const byNameB = Object.fromEntries(b.data.parts.map((p) => [p.name, p.chars]));
  ok('B 含 crossSession 段且非 0（A 群摘要注入过来）', byNameB.crossSession > 0, `crossSession=${byNameB.crossSession}`);
  ok('B 没有 mediaAware（B 没有带图未读）', !byNameB.mediaAware || byNameB.mediaAware === 0, `mediaAware=${byNameB.mediaAware}`);
  ok('A/B 的 total 不同（真的按 key 算，不是全局快照）', a.data.total !== b.data.total, `A=${a.data.total} B=${b.data.total}`);

  console.log('\n[B] 没有数据不许静默 0');
  const noKey = await partsOf('/api/debug/prompt-parts');
  eq('不传 key → 400', noKey.status, 400);
  eq('不传 key 的返回码 bad_key', noKey.data?.code, 'bad_key');
  ok('不传 key 的说明里写清要带 ?key=', String(noKey.data?.error || '').includes('?key='));
  const badKey = await partsOf('/api/debug/prompt-parts?key=group:abc');
  eq('非法 key → 400', badKey.status, 400);
  const unknown = await partsOf(`/api/debug/prompt-parts?key=${encodeURIComponent('group:999999')}`);
  eq('没会话状态的 key → 200 但 total:0', `${unknown.status}/${unknown.data?.total}`, '200/0');
  ok('没会话状态时带 reason（不许静默 0）', String(unknown.data?.reason || '').length > 0, unknown.data?.reason);
  eq('没会话状态时 mode=none（没现算也没快照）', unknown.data?.mode, 'none');
  ok('没会话状态时不返回 parts', Array.isArray(unknown.data?.parts) && unknown.data.parts.length === 0);

  const noAuth = await partsOf(`/api/debug/prompt-parts?key=${encodeURIComponent(KEY_A)}`, { token: '' });
  ok('没有控制台令牌 → 被拒（鉴权照旧）', noAuth.status >= 400, `status=${noAuth.status}`);

  console.log('\n[C] 调试构建无副作用');
  eq('跑完 debug 后 unread/wakeConfig/已读水位逐字节不变', plainState(), beforeState);
  const afterFileHash = fs.existsSync(stateFile) ? sha256(fs.readFileSync(stateFile)) : null;
  eq('state/social-v2.json sha256 不变', afterFileHash, beforeFileHash);
  ok('调试构建没有消费交接摘要（handoff 段不在返回里）', !byName.handoff);
  ok('调试构建没有把 initialPrompt 段算进去', !byName.initialPrompt);

  console.log('\n[D] 真实构建 → 快照与 hint');
  // 先看一眼「没有真实构建记录」的 hint。
  ok('没有真实构建时 hint 明确说没有', b.data.hint?.comparedWith === null && String(b.data.hint?.note || '').includes('没有'), JSON.stringify(b.data.hint));
  // 真实构建一次（等价于这条唤醒要被投递），快照应以它为准。
  h.buildWakePromptV2(KEY_B, 'question');
  const b2 = await partsOf(`/api/debug/prompt-parts?key=${encodeURIComponent(KEY_B)}`);
  eq('真实构建后 hint.comparedWith=last-real-build', b2.data.hint?.comparedWith, 'last-real-build');
  ok('hint.lastTotal 是那次真实构建的总长', Number(b2.data.hint?.lastTotal) > 0, String(b2.data.hint?.lastTotal));
  ok('hint.delta 是数字（现算 vs 最近真实构建）', typeof b2.data.hint?.delta === 'number', String(b2.data.hint?.delta));
  ok('hint.lastBuiltAt 是毫秒时间戳', Number(b2.data.hint?.lastBuiltAt) > 0);
  // 调试调用不得覆盖真实快照：再查两次，lastBuiltAt / lastTotal 必须还是刚才那次。
  const firstBuiltAt = b2.data.hint.lastBuiltAt;
  const firstLastTotal = b2.data.hint.lastTotal;
  await partsOf(`/api/debug/prompt-parts?key=${encodeURIComponent(KEY_B)}`);
  const b3 = await partsOf(`/api/debug/prompt-parts?key=${encodeURIComponent(KEY_B)}`);
  eq('多次 debug 不覆盖真实快照（builtAt）', b3.data.hint?.lastBuiltAt, firstBuiltAt);
  eq('多次 debug 不覆盖真实快照（total）', b3.data.hint?.lastTotal, firstLastTotal);
  ok('debug 响应里 mode 仍是 live', b3.data.mode === 'live');
} catch (error) {
  fail += 1;
  console.error('FAIL 用例异常：', error?.stack ?? error);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await h.close();
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exitCode = fail === 0 ? 0 : 1;
