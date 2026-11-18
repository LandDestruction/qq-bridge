#!/usr/bin/env node
import { readBridgeSource } from './bridge-source.mjs';
import { readMcpSafeSource } from './mcp-safe-source.mjs';
// D37 自报家门：qq_self_model 端点 + 工具 + prompt 提示。
// 分两段：
//   [A] 纯逻辑（src/self-model.js）：四种 source 的选择顺序、base 行不得当实况、不泄漏 sid/token；
//   [B] 真跑 bridge HTTP handler（audit-bridge-harness，临时目录 + 假 DSH/QQ）：
//       配置回落 / 本会话选型 / 含图强制视觉模型 / 控制台覆盖 / 工具开关 / 错误令牌 / prompt 段落。
// 用法：node scripts/test-self-model.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {
  SELF_MODEL_PROMPT,
  SELF_MODEL_SOURCE_LABEL,
  buildSelfModelPayload,
  contextFromBuckets,
  resolveSelfModel,
  sessionTailOf
} from '../src/self-model.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const CFG_DEFAULT = { dsh: { provider: 'workbuddy2api', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } };
let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) { ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`); }

console.log('[A] 纯逻辑：source 选择顺序与回落标注');
ok('prompt 提示 ≤60 字符', [...SELF_MODEL_PROMPT].length <= 60, `${[...SELF_MODEL_PROMPT].length} 字符`);
ok('prompt 提示点名 qq_self_model 且要求别猜', SELF_MODEL_PROMPT.includes('qq_self_model') && SELF_MODEL_PROMPT.includes('别猜'));

{
  const r = resolveSelfModel({ cfg: CFG_DEFAULT });
  eq('全空 → config-default（不冒充实况）', r.source, 'config-default');
  eq('回落时给的是配置里的那一对', `${r.provider}/${r.model}`, 'workbuddy2api/deepseek-v4.1-flash');
  ok('回落 reason 明确说「不代表实际推理用的模型」', r.reason.includes('不代表实际推理用的模型'));
}
{
  const r = resolveSelfModel({
    cfg: CFG_DEFAULT,
    override: { provider: 'deepseek-account', model: 'deepseek-v4-pro', reason: 'console' },
    applied: { provider: 'deepseek-account', model: 'deepseek-flash', source: 'media' }
  });
  eq('override 优先级最高', r.source, 'override');
  eq('override 覆盖 applied 的选择', `${r.provider}/${r.model}`, 'deepseek-account/deepseek-v4-pro');
  ok('override reason 翻成人话（不原样暴露内部码 console）', r.reason.includes('控制台') && !r.reason.includes('console'));
}
{
  const r = resolveSelfModel({ cfg: CFG_DEFAULT, applied: { provider: 'deepseek-account', model: 'deepseek-flash', source: 'idle' } });
  eq('applied（空闲路由）→ session', r.source, 'session');
  ok('session reason 说清是空闲时段路由', r.reason.includes('空闲时段'));
}
{
  const r = resolveSelfModel({ cfg: CFG_DEFAULT, applied: { provider: 'deepseek-account', model: 'deepseek-flash', source: 'media' } });
  eq('含图轮 → source=media', r.source, 'media');
  ok('media reason 说清含图强制', r.reason.includes('带了图'));
  eq('含图轮报的是视觉模型而不是配置默认', `${r.provider}/${r.model}`, 'deepseek-account/deepseek-flash');
}
{
  const r = resolveSelfModel({ cfg: CFG_DEFAULT, applied: { provider: 'deepseek-account', model: 'deepseek-flash', media: true } });
  eq('applied.media=true 也按 media 报', r.source, 'media');
}
{
  const r = resolveSelfModel({ cfg: CFG_DEFAULT, billed: { provider: 'deepseek-account', model: 'deepseek-flash', source: 'turn' } });
  eq('无 applied 时用最近计费回合', r.source, 'billed');
  eq('billed 取的是 turn 行的模型', `${r.provider}/${r.model}`, 'deepseek-account/deepseek-flash');
  ok('billed reason 说明是重启后的回落证据', r.reason.includes('实际计费'));
}
{
  const r = resolveSelfModel({ cfg: CFG_DEFAULT, billed: { provider: 'workbuddy2api', model: 'deepseek-v4.1-flash', source: 'base' } });
  eq('k=base 行（配置默认）不得当实况 → 退回 config-default', r.source, 'config-default');
  ok('base 行被拒的理由：D33 踩过的坑要有注释', /base/.test(fs.readFileSync(new URL('../src/self-model.js', import.meta.url), 'utf8')));
}
{
  const sid = 'session-abcdef-1234567890';
  const payload = buildSelfModelPayload({
    key: KEY, sessionId: sid, mode: 'reserved2', preset: 'qq-chat-v2',
    applied: { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'high', source: 'media', media: true },
    billed: { buckets: { cacheMiss: 100, cacheHit: 50, cacheWrite: 10, output: 40 }, source: 'turn' },
    cfg: CFG_DEFAULT
  });
  eq('sessionTail 只给后 8 位', payload.sessionTail, sessionTailOf(sid));
  eq('sessionTail 长度=8', payload.sessionTail.length, 8);
  const json = JSON.stringify(payload);
  ok('返回体不含完整 sessionId', !json.includes(sid), json.slice(0, 80));
  ok('返回体不含 token 字段', !/"(token|agentToken|baseUrl)"/.test(json));
  eq('payload 带上 sourceLabel', payload.sourceLabel, SELF_MODEL_SOURCE_LABEL.media);
  eq('payload 带上思考强度', payload.reasoningEffort, 'high');
  eq('context.projected = 上回合输入+输出', payload.context.projected, 200);
}
{
  const none = contextFromBuckets(null);
  eq('没有计费样本时 projected 为 null（不是 0）', none.projected, null);
  const noWin = contextFromBuckets({ cacheMiss: 10, cacheHit: 0, cacheWrite: 0, output: 5 });
  eq('没配窗口就没 pct', noWin.pct, null);
  const withWin = contextFromBuckets({ cacheMiss: 10, cacheHit: 0, cacheWrite: 0, output: 5 }, { windowTokens: 100000 });
  eq('配了窗口才算 pct', withWin.pct, 0);
  const big = contextFromBuckets({ cacheMiss: 40000, cacheHit: 0, cacheWrite: 0, output: 1900 }, { windowTokens: 1000000 });
  eq('pct 保留一位小数', big.pct, 4.2);
}
{
  const bridge = readBridgeSource();
  const mcp = readMcpSafeSource();
  ok('bridge 端点存在', bridge.includes("url.pathname === '/api/socialV2/self-model'"));
  ok('端点走 agent token 校验', /self-model[\s\S]{0,900}?agentTokenOk\(key, agentToken\)/.test(bridge));
  ok('端点有工具开关双闸', /self-model[\s\S]{0,1200}?v2ToolEnabled\('selfModel'\)/.test(bridge));
  ok('bridge 从 self-model.js 引入', /from '\.\/self-model\.js'/.test(bridge));
  ok('prompt parts 里有 selfModel 段', /'identity', identityLine\][\s\S]{0,120}?\['selfModel', selfModelLine\]/.test(bridge));
  ok('MCP 注册了 qq_self_model', /'qq_self_model'/.test(mcp));
  ok('MCP 开关映射到 selfModel', /qq_self_model: 'selfModel'/.test(mcp));
  ok('MCP handler 走 /api/socialV2/self-model', mcp.includes("agentApi('/api/socialV2/self-model'"));
}

console.log('\n[B] 真跑 bridge handler（临时目录，假 DSH/QQ）');

const h = await bridgeHarness({
  config: {
    socialV2: {
      wake: { maxWakePerMinute: 0, maxWakePerHour: 0 },
      mediaVision: { describeFirst: false },
      modelForMedia: { provider: 'deepseek-account', model: 'deepseek-flash' },
      tools: {}
    },
    dsh: {
      provider: 'workbuddy2api',
      model: 'deepseek-v4.1-flash',
      reasoningEffort: 'high',
      visionModels: ['deepseek-flash'],
      modelFallbacks: [{ provider: 'deepseek-account', model: 'deepseek-flash' }]
    }
  }
});
h.setMode('reserved2');
const st = h.getSocialV2State(KEY);
const server = h.startConsoleServer();
if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));

function request(route, { body, token = st.agentToken, key = KEY, admin = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'x-console-token': 'fixture-console-token' };
    if (!admin) headers['x-agent-token'] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: `${route.startsWith('/') ? route : `/api/socialV2/${route}`}?key=${encodeURIComponent(key)}`,
      method: body === undefined ? 'GET' : 'POST',
      headers
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (error) { reject(new Error(`${route} 返回非 JSON（${res.statusCode}）：${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`${route} 超时`)));
    req.end(body === undefined ? undefined : JSON.stringify({ key, token: st.agentToken, ...body }));
  });
}
const ask = (key = KEY, token = st.agentToken) => request('/api/socialV2/self-model', { body: {}, key, token });

try {
  // ① 还没有会话/选型：必须明确标 config-default，而不是把配置当实况。
  {
    const r = await ask();
    eq('① 无选型 → 200 + ok', `${r.status}/${r.data.ok}`, '200/true');
    eq('① source=config-default', r.data.source, 'config-default');
    eq('① 报的是配置默认那一对', `${r.data.provider}/${r.data.model}`, 'workbuddy2api/deepseek-v4.1-flash');
    eq('① 没有会话 id 尾巴', r.data.sessionTail, null);
    eq('① 没有计费样本 → context.projected=null', r.data.context.projected, null);
  }

  // ② 本会话真正 selectModel 之后：source=session，带思考强度。
  //    用另一个会话（KEY2）并把 DSH 会话 id 直接塞进 state.sessions：
  //    ensureSession 自己会对齐一次模型，容易把「本轮选型」污染成桩的默认值。
  {
    const KEY2 = 'group:789';
    const st2 = h.getSocialV2State(KEY2);
    h.state.sessions[KEY2] = 'fixture-self-model-sid';
    h.api.sessions.selectModel = async (params) => ({
      result: { ok: true, value: { selected: { provider: params.provider, model: params.model, reasoningEffort: params.reasoningEffort } } }
    });
    eq('② ensureChatModel 应用成功', await h.ensureChatModel('fixture-self-model-sid', KEY2), 'applied');
    const r = await ask(KEY2, st2.agentToken);
    eq('② source=session', r.data.source, 'session');
    eq('② 报的就是本轮选型', `${r.data.provider}/${r.data.model}`, 'workbuddy2api/deepseek-v4.1-flash');
    eq('② 带思考强度', r.data.reasoningEffort, 'high');
    eq('② 只给 sid 后 8 位', r.data.sessionTail, 'fixture-self-model-sid'.slice(-8));
    ok('② 返回体真的不含完整 sid', !JSON.stringify(r.data).includes('fixture-self-model-sid'));
    ok('② 返回体不含会话令牌', !JSON.stringify(r.data).includes(st2.agentToken));
  }

  // ③ 含图轮：必须报 modelForMedia 的视觉模型，而不是配置默认。
  {
    await h.ensureSession(KEY);
    const sid = h.state.sessions[KEY];
    h.appendSocialV2Message(KEY, 'fixture-person', '[图片]', '[图片]', false, false,
      'fixture-self-model-image', [{ kind: 'image', file: 'fixture-self-model-image' }], '789', []);
    eq('③ 含图轮重新应用模型', await h.ensureChatModel(sid, KEY), 'applied');
    const r = await ask();
    eq('③ source=media', r.data.source, 'media');
    eq('③ 报的是视觉模型而不是配置默认', `${r.data.provider}/${r.data.model}`, 'deepseek-account/deepseek-flash');
    eq('③ media 标记为 true', r.data.media, true);
    ok('③ reason 说清为什么切', r.data.reason.includes('带了图'));
  }

  // ④ 控制台运行期覆盖：override 优先于 applied。
  {
    const set = await request('/api/model', { body: { provider: 'workbuddy2api', model: 'deepseek-v4-pro', scope: 'override' }, admin: true });
    eq('④ 控制台设置覆盖成功', `${set.status}/${set.data.ok}`, '200/true');
    const r = await ask();
    eq('④ source=override', r.data.source, 'override');
    eq('④ 报的是覆盖后的模型', `${r.data.provider}/${r.data.model}`, 'workbuddy2api/deepseek-v4-pro');
    ok('④ reason 说明是控制台切换', r.data.reason.includes('控制台'));
    await request('/api/model?scope=override', { admin: true, body: { scope: 'override', provider: '', model: '' } }).catch(() => {});
  }

  // ⑤ 关掉工具开关：端点必须 403（与 affinityShift 同一套双闸）。
  {
    h.cfg.socialV2.tools.selfModel = false;
    const r = await ask();
    eq('⑤ 工具关闭 → 403', r.status, 403);
    eq('⑤ 拒绝码 tool_disabled', r.data.code, 'tool_disabled');
    h.cfg.socialV2.tools.selfModel = true;
  }

  // ⑥ 错误令牌 / 空 key。
  {
    const bad = await request('/api/socialV2/self-model', { body: {}, token: 'wrong-token' });
    eq('⑥ 错令牌 → 403', bad.status, 403);
    eq('⑥ 拒绝码 bad_token', bad.data.code, 'bad_token');
    const empty = await request('/api/socialV2/self-model', { body: {}, key: '' });
    eq('⑥ 空 key → 400', empty.status, 400);
    eq('⑥ 拒绝码 bad_key', empty.data.code, 'bad_key');
  }

  // ⑦ prompt：selfModel 段真的进了 wake prompt，且字数在预算内。
  {
    h.buildWakePromptV2(KEY, 'question');
    const parts = await request('/api/debug/prompt-parts', { admin: true });
    const part = (parts.data.parts || []).find((p) => p.name === 'selfModel');
    ok('⑦ prompt-parts 里出现 selfModel 段', Boolean(part));
    eq('⑦ selfModel 段字符数 = 提示 + 两个换行', part?.chars, [...SELF_MODEL_PROMPT].length + 2);
    ok('⑦ selfModel 段 ≤60 字符', (part?.chars ?? 999) <= 60, `${part?.chars} 字符`);
    ok('⑦ prompt 总长已含新段', parts.data.total > part.chars, `total=${parts.data.total}`);
    console.log(`  … prompt 总长=${parts.data.total}，其中 selfModel=${part.chars}`);
  }
} catch (error) {
  fail += 1;
  console.error('FAIL 端点用例异常：', error?.stack ?? error);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await h.close();
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exitCode = fail === 0 ? 0 : 1;
