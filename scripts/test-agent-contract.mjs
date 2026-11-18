// P0「任意 Agent 接入」契约测试：只验形状与转发，不验任何真实网络/DSH。
// 运行：node scripts/test-agent-contract.mjs
//
// 覆盖：
//   1. contract：三种 type 的能力表、http 由对方声明、配置归一/回退/告警、请求校验；
//   2. 事件归一：6 种内部事件 + 未知事件丢弃计数 + 别名；
//   3. transport-dsh：对 deps 的转发与 baseUrl/discover 映射（造桩，不联网）；
//   4. registry：注册/查询/列出/清空；
//   5. mux 的注入点：有 agentTransport 走它，没有时退回旧 deps.api 路径（零行为变化）。

import {
  AGENT_EVENT_TYPES,
  AGENT_TOOL_LOOP_MODES,
  AGENT_TRANSPORTS,
  describeAgentTransport,
  normalizeAgentConfig,
  projectTurnEvents,
  validateTurnRequest
} from '../src/agent/contract.js';
import { createDshTransport } from '../src/agent/transport-dsh.js';
import {
  getAgentTransportFactory,
  listAgentTransportTypes,
  registerAgentTransport,
  resetAgentTransports
} from '../src/agent/registry.js';
import { agentTransportOf, turnStepLimit } from '../src/bridge/mux-helpers.js';

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed += 1; console.log(`✅ ${label}`); }
  else { failed += 1; console.error(`❌ ${label}`); }
}

// ── 1. 能力表 ────────────────────────────────────────────────────────
{
  assert(AGENT_TRANSPORTS.length === 3 && AGENT_TRANSPORTS.includes('dsh'), '支持 dsh / openai / http');
  const dsh = describeAgentTransport('dsh');
  assert(dsh.stream && dsh.toolLoop === 'agent' && dsh.sessions && dsh.multimodal, 'dsh 四项能力全开（toolLoop=agent）');
  const openai = describeAgentTransport('openai');
  assert(openai.stream && openai.toolLoop === 'host' && openai.sessions && !openai.multimodal, 'openai 除多模态外全开（toolLoop=host）');
  const http = describeAgentTransport('http');
  // P2 起 http 是我们自己的协议：SSE 推流 + 工具由桥接执行（toolLoop:true 等价 host）。
  assert(http.stream === true && http.toolLoop === true && !http.sessions && !http.multimodal, 'http 能力表：流式 + 工具循环（桥接执行），会话/多模态关');
  const httpDeclared = describeAgentTransport('http', { stream: false, toolLoop: 1, sessions: true });
  assert(httpDeclared.stream === false && httpDeclared.toolLoop === true && httpDeclared.sessions === true, 'http 只认类型正确的声明（toolLoop 布尔 1 不算，保留表值）');
  assert(describeAgentTransport('nope').stream === true, '未知 type 退回 dsh 能力表');
  assert(AGENT_EVENT_TYPES.length === 6 && AGENT_EVENT_TYPES.includes('text_delta'), '内部 6 种事件类型');
}

// ── 2. 配置归一 ──────────────────────────────────────────────────────
{
  const defaults = normalizeAgentConfig({});
  assert(defaults.type === 'dsh', '缺省 type=dsh');
  assert(defaults.timeoutMs === 120000 && defaults.warns.length === 0, '缺省 timeout 120s、无告警');
  const bad = normalizeAgentConfig({ agent: { type: 'grpc', timeoutMs: 1 } });
  assert(bad.type === 'dsh' && bad.warns.some((w) => w.includes('grpc')), '未知 type 回退 dsh 并给 warn');
  assert(bad.timeoutMs === 5000, 'timeoutMs 下限夹到 5000');
  const full = normalizeAgentConfig({ agent: { type: 'OPENAI', baseUrl: ' https://x/v1 ', apiKey: 'k', model: 'm', timeoutMs: 9e9 } });
  assert(full.type === 'openai' && full.baseUrl === 'https://x/v1' && full.model === 'm', 'type 归一大小写 + baseUrl trim');
  assert(full.timeoutMs === 600000, 'timeoutMs 上限夹到 600000');
  const junk = normalizeAgentConfig({ agent: 'not-an-object' });
  assert(junk.type === 'dsh', 'agent 段不是对象也能存活');
}
{
  // P1：maxToolRounds 归一（host 工具循环的上限）+ 未知/越界都夹取，不抛。
  const defaults = normalizeAgentConfig({});
  assert(defaults.maxToolRounds === 8, '缺省 maxToolRounds=8');
  assert(normalizeAgentConfig({ agent: { maxToolRounds: 0 } }).maxToolRounds === 1, 'maxToolRounds 下限夹到 1');
  assert(normalizeAgentConfig({ agent: { maxToolRounds: 99 } }).maxToolRounds === 20, 'maxToolRounds 上限夹到 20');
  assert(normalizeAgentConfig({ agent: { maxToolRounds: 'x' } }).maxToolRounds === 8, 'maxToolRounds 非数字回默认 8');
  const modes = AGENT_TOOL_LOOP_MODES;
  assert(Array.isArray(modes) && modes.includes('agent') && modes.includes('host'), 'toolLoop 只有 agent/host 两种语义');
}

// ── 3. 请求校验 ──────────────────────────────────────────────────────
{
  const ok = validateTurnRequest({
    key: 'group:1',
    sessionId: 's1',
    messages: [{ role: 'user', text: 'hi' }],
    system: 'sys',
    tools: [{ name: 'qq_send_message', description: 'd', parameters: { type: 'object' } }],
    persona: '猫娘'
  });
  assert(ok.ok === true, '最小合法请求通过');
  const each = [
    [null, '请求必须是对象'],
    [{ sessionId: 's', messages: [{ role: 'user', text: 'x' }] }, 'key'],
    [{ key: 'k', messages: [{ role: 'user', text: 'x' }] }, 'sessionId'],
    [{ key: 'k', sessionId: 's', messages: [] }, 'messages'],
    [{ key: 'k', sessionId: 's', messages: [{ role: 'robot', text: 'x' }] }, 'role'],
    [{ key: 'k', sessionId: 's', messages: [{ role: 'user' }] }, 'text'],
    [{ key: 'k', sessionId: 's', messages: [{ role: 'user', text: 'x' }], tools: [{ name: '' }] }, 'tools[0].name'],
    [{ key: 'k', sessionId: 's', messages: [{ role: 'user', text: 'x' }], tools: [{ name: 't', parameters: [] }] }, 'parameters'],
    [{ key: 'k', sessionId: 's', messages: [{ role: 'user', text: 'x' }], persona: 42 }, 'persona'],
    [{ key: 'k', sessionId: 's', messages: [{ role: 'user', text: 'x' }], system: 1 }, 'system']
  ];
  for (const [req, word] of each) {
    const out = validateTurnRequest(req);
    assert(out.ok === false && out.error.includes(word), `非法请求被拒（含「${word}」）`);
  }
}

// ── 4. 事件归一 ──────────────────────────────────────────────────────
{
  const out = projectTurnEvents([
    { type: 'text', text: 'a' },
    { type: 'tool-call', name: 't' },
    { type: 'tool_result', name: 't' },
    { type: 'usage', input: 1 },
    { type: 'done' },
    { type: 'weird', x: 1 },
    { type: 'weird2' },
    { type: 'weird' }
  ]);
  assert(out.events.length === 5, `5 条被归一（实得 ${out.events.length}）`);
  assert(out.dropped === 3, `未知事件丢弃 3 条（实得 ${out.dropped}）`);
  assert(out.unknownTypes.length === 2 && out.unknownTypes.includes('weird'), '未知类型去重记录');
  assert(out.events[0].type === 'text_delta' && out.events[1].type === 'tool_call' && out.events[2].type === 'tool_result', '别名映射 text/tool-call/tool_result');
  assert(out.events[4].type === 'turn_end', 'done → turn_end');
  assert(projectTurnEvents(null).events.length === 0 && projectTurnEvents(null).dropped === 0, '非可迭代输入给空结果不抛');
  assert(projectTurnEvents([{ event: 'error', message: 'x' }]).events[0].type === 'error', 'event 字段也能识别');
}

// ── 5. transport-dsh 转发 ────────────────────────────────────────────
{
  const calls = [];
  const fakeApi = {
    baseUrl: 'http://127.0.0.1:3080',
    events: { mux: (opts) => ({ opts, fake: true }) },
    respond: (m) => { calls.push(['respond', m]); return Promise.resolve('ok'); },
    stopSessionWork: (s, o) => { calls.push(['stop', s, o]); return Promise.resolve(); },
    invalidateAuth: () => { calls.push(['invalidate']); }
  };
  const deps = {
    api: fakeApi,
    createTurnCollector: () => ({ push: () => null, size: () => 0 }),
    discoverDshBaseUrl: (opts) => { calls.push(['discover', opts]); return Promise.resolve({ changed: true, baseUrl: 'http://127.0.0.1:3999' }); },
    log: () => {}
  };
  const transport = createDshTransport(deps);
  assert(transport.type === 'dsh' && transport.capabilities.toolLoop === 'agent', 'transport 声明 dsh 能力（toolLoop=agent）');
  const iter = transport.events();
  assert(iter.fake === true, 'events() 转发到 api.events.mux');
  await transport.respond({ a: 1 });
  await transport.stopSessionWork('s1', { timeoutMs: 1 });
  const collector = transport.createCollector();
  assert(typeof collector.push === 'function' && calls.length === 2, 'respond/stopSessionWork 转发（2 次调用被记录）');
  assert(transport.baseUrl === 'http://127.0.0.1:3080', 'baseUrl 读转发');
  transport.baseUrl = 'http://127.0.0.1:4999';
  assert(fakeApi.baseUrl === 'http://127.0.0.1:4999', 'baseUrl 写转发到 api');
  transport.invalidateAuth();
  const found = await transport.discoverBaseUrl({ log: () => {} });
  assert(found.changed === true && calls.some((c) => c[0] === 'discover'), 'discoverBaseUrl 转发');
  assert(calls.some((c) => c[0] === 'invalidate'), 'invalidateAuth 转发');
  let threw = false;
  try { createDshTransport({}).events(); } catch (error) { threw = /缺少依赖：api/.test(error.message); }
  assert(threw === true, '缺 api 时给明确错误（构造期不炸，调用才炸）');
}

// ── 6. registry ─────────────────────────────────────────────────────
{
  resetAgentTransports();
  const factory = (deps) => createDshTransport(deps);
  registerAgentTransport('DSH', factory);
  assert(getAgentTransportFactory('dsh') === factory, '注册后按小写 type 取回工厂');
  assert(listAgentTransportTypes().join(',') === 'dsh', '列出的类型只有 dsh');
  assert(getAgentTransportFactory('openai') === null, '未注册返回 null');
  let badType = false;
  try { registerAgentTransport('', factory); } catch { badType = true; }
  assert(badType === true, '空 type 注册抛错');
  resetAgentTransports();
  assert(listAgentTransportTypes().length === 0, 'reset 清空注册表');
}

// ── 7. mux 注入点：有 transport 走它，没装退回旧路径 ─────────────────
{
  const seen = [];
  const transport = {
    events: () => { seen.push('events'); return { fake: true }; },
    respond: (m) => { seen.push(['respond', m]); return Promise.resolve(); },
    stopSessionWork: (s, o) => { seen.push(['stop', s, o]); return Promise.resolve(); },
    createCollector: () => { seen.push('collector'); return { push: () => null, size: () => 0 }; },
    get baseUrl() { return 'http://t/'; },
    set baseUrl(v) { seen.push(['setBase', v]); },
    invalidateAuth: () => seen.push('invalidate'),
    discoverBaseUrl: (opts) => { seen.push(['discover', opts]); return Promise.resolve({ changed: true }); }
  };
  const chosen = agentTransportOf({ agentTransport: transport, api: null });
  assert(chosen === transport, '装了 agentTransport 就直接用');
  chosen.events();
  chosen.createCollector();
  chosen.baseUrl = 'http://x/';
  chosen.invalidateAuth();
  assert(seen.includes('events') && seen.includes('collector') && seen.includes('invalidate'), 'mux 注入点把调用转发给 transport');

  // 旧路径 fallback：没有 agentTransport 时，适配器只包 deps.api，不发网络。
  const legacyCalls = [];
  const legacyApi = {
    baseUrl: 'http://legacy/',
    events: { mux: (opts) => { legacyCalls.push(['mux', opts]); return { legacy: true }; } },
    respond: () => Promise.resolve(), stopSessionWork: () => Promise.resolve(), invalidateAuth: () => legacyCalls.push(['invalidate'])
  };
  const legacy = agentTransportOf({ api: legacyApi, createTurnCollector: () => 'collector', discoverDshBaseUrl: () => Promise.resolve({ changed: false }), log: () => {} });
  assert(legacy.events().legacy === true, 'fallback events() 走 api.events.mux({})');
  assert(legacy.createCollector() === 'collector', 'fallback createCollector 走 deps.createTurnCollector');
  assert(legacy.baseUrl === 'http://legacy/', 'fallback baseUrl 读 api');
  legacy.baseUrl = 'http://legacy2/';
  assert(legacyApi.baseUrl === 'http://legacy2/', 'fallback baseUrl 写回 api');
  assert(turnStepLimit({ socialV2: { turnMaxSteps: 25 } }, false) === 25, 'mux 业务逻辑未被 transport 改动（turnStepLimit 25）');
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
