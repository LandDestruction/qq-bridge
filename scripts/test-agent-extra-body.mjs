#!/usr/bin/env node
// agent.extraBody：本地推理端点（如 Strata/qwen3.6）需要的端点专属开关。
// 这里只验三件事：归一化别把请求体写坏、transport 真的把它并进请求体、非对象一律忽略。
import assert from 'node:assert/strict';
import { normalizeAgentConfig } from '../src/agent/contract.js';
import { normalizeAgentRuntime } from '../src/bridge/config-load.js';
import { createOpenAiTransport } from '../src/agent/transport-openai.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`❌ ${name}\n   ${error?.message ?? error}`);
  }
}

// ---- 归一化 ----
check('contract：普通对象原样保留', () => {
  const cfg = normalizeAgentConfig({ agent: { type: 'openai', extraBody: { chat_template_kwargs: { enable_thinking: false } } } });
  assert.deepEqual(cfg.extraBody, { chat_template_kwargs: { enable_thinking: false } });
});

check('contract：缺省给空对象（下游不用判 undefined）', () => {
  const cfg = normalizeAgentConfig({ agent: { type: 'dsh' } });
  assert.deepEqual(cfg.extraBody, {});
});

check('contract：数组/字符串/null 一律忽略', () => {
  for (const bad of [[], 'x', null, 3, true]) {
    const cfg = normalizeAgentConfig({ agent: { type: 'openai', extraBody: bad } });
    assert.deepEqual(cfg.extraBody, {}, `extraBody=${JSON.stringify(bad)} 应被忽略`);
  }
});

check('contract：函数/符号被剔除，其它键保留', () => {
  const cfg = normalizeAgentConfig({ agent: { type: 'openai', extraBody: { a: 1, fn: () => 1, b: 'x' } } });
  assert.deepEqual(cfg.extraBody, { a: 1, b: 'x' });
});

check('config-load：与 contract 口径一致', () => {
  const runtime = normalizeAgentRuntime({ type: 'openai', extraBody: { chat_template_kwargs: { enable_thinking: false } } });
  assert.deepEqual(runtime.extraBody, { chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(normalizeAgentRuntime({ type: 'openai', extraBody: [] }).extraBody, {});
});

check('config-load：保留 maxToolRounds/timeoutMs 旧行为', () => {
  const runtime = normalizeAgentRuntime({ type: 'openai' });
  assert.equal(runtime.maxToolRounds, 8);
  assert.equal(runtime.timeoutMs, 120000);
});

// ---- transport 真的并进请求体 ----
function sseBody() {
  const events = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '好' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
}

async function runTransport(extraBody) {
  const bodies = [];
  const fetchMock = async (url, init) => {
    bodies.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(sseBody(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const transport = createOpenAiTransport({
    cfg: { agent: { type: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', model: 'm', extraBody } },
    fetch: fetchMock,
    log: () => {},
    localTools: { listTools: async () => [], callTool: async () => ({ ok: true }), close: () => {} }
  });
  const events = [];
  for await (const event of transport.startTurn({ key: 'group:1', sessionId: 's1', messages: [{ role: 'user', text: '在吗' }] })) events.push(event);
  return { bodies, events };
}

const withExtra = await runTransport({ chat_template_kwargs: { enable_thinking: false } });
check('transport：extraBody 被并进 /chat/completions 请求体', () => {
  assert.equal(withExtra.bodies.length, 1);
  const payload = withExtra.bodies[0].body;
  assert.deepEqual(payload.chat_template_kwargs, { enable_thinking: false });
  assert.equal(payload.model, 'm');
  assert.equal(payload.stream, true);
});

check('transport：extraBody 不会覆盖 stream/stream_options', () => {
  const payload = withExtra.bodies[0].body;
  assert.equal(payload.stream, true);
  assert.equal(payload.stream_options.include_usage, true);
});

const plainRun = await runTransport({});
check('transport：没有 extraBody 时请求体里没有多余键', () => {
  const payload = plainRun.bodies[0].body;
  assert.equal(payload.chat_template_kwargs, undefined);
});

const badRun = await runTransport([]);
check('transport：乱传 extraBody（数组）不影响请求', () => {
  const payload = badRun.bodies[0].body;
  assert.equal(payload.chat_template_kwargs, undefined);
  assert.equal(payload.stream, true);
});


async function runWithImages() {
  const bodies = [];
  const fetchMock = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(sseBody(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const transport = createOpenAiTransport({
    cfg: { agent: { type: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', model: 'm' } },
    fetch: fetchMock,
    log: () => {},
    localTools: { listTools: async () => [], callTool: async () => ({ content: [] }), close: () => {} }
  });
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: '这张图是什么' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    ]
  }];
  for await (const _event of transport.startTurn({ key: 'group:1', sessionId: 's1', messages })) { /* 跑完 */ }
  return bodies[0];
}

const withImage = await runWithImages();
check('transport：content 数组（含 image_url）原样透传，不压成字符串', () => {
  const content = withImage.messages[0].content;
  assert.equal(Array.isArray(content), true);
  assert.equal(content.length, 2);
  assert.equal(content[1].type, 'image_url');
  assert.equal(content[1].image_url.url.startsWith('data:image/png;base64,'), true);
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
// ---- agent.tools 白名单 ----
check('contract：agent.tools 只留字符串、去重、上限', () => {
  const cfg = normalizeAgentConfig({ agent: { type: 'openai', tools: ['qq_status', ' qq_send_message ', 'qq_status', 3, '', 'x'.repeat(200)] } });
  assert.deepEqual(cfg.tools, ['qq_status', 'qq_send_message']);
});

check('contract：agent.tools 非数组 → 空（= 全部工具）', () => {
  assert.deepEqual(normalizeAgentConfig({ agent: { type: 'openai', tools: 'qq_status' } }).tools, []);
});

check('config-load：agent.tools 与 contract 同口径', () => {
  assert.deepEqual(normalizeAgentRuntime({ type: 'openai', tools: ['a', 'b', 'a'] }).tools, ['a', 'b']);
});

async function runWithTools(allow, toolsList) {
  const bodies = [];
  const fetchMock = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(sseBody(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const transport = createOpenAiTransport({
    cfg: { agent: { type: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', model: 'm', tools: allow } },
    fetch: fetchMock,
    log: () => {},
    localTools: { listTools: async () => toolsList, callTool: async () => ({ content: [] }), close: () => {} }
  });
  for await (const _event of transport.startTurn({ key: 'group:1', sessionId: 's1', messages: [{ role: 'user', text: 'hi' }] })) { /* 跑完 */ }
  return bodies[0];
}

const toolFixtures = ['qq_status', 'qq_send_message', 'qq_send_sticker'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
const filtered = await runWithTools(['qq_status'], toolFixtures);
check('transport：agent.tools 白名单只放行名单内的工具', () => {
  assert.equal(filtered.tools.length, 1);
  assert.equal(filtered.tools[0].function.name, 'qq_status');
});

const full = await runWithTools([], toolFixtures);
check('transport：白名单为空 → 暴露全部工具', () => {
  assert.equal(full.tools.length, 3);
});

process.exitCode = fail === 0 ? 0 : 1;
