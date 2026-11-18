// OpenAI 兼容 transport 的离线测试：起一个本地 http 假端点，不碰真实网络。
//
// 覆盖点：请求形状（tools/stream/bearer/尾部斜杠归一）、SSE 解析（含流尾缺换行）、
// host 工具循环（tool_call → 本地工具 → tool_result → 第二轮文本）、usage/finish_reason、
// maxToolRounds/超时/非 2xx/坏请求的中文 error，以及「工具清单拿不到就降级纯文本」。

import http from 'node:http';
import { createOpenAiTransport } from '../src/agent/transport-openai.js';
import { registerAgentTransport, getAgentTransportFactory, resetAgentTransports } from '../src/agent/registry.js';
import { runHostTurn, agentToolLoopModeOf } from '../src/bridge/mux-helpers.js';
import { normalizeAgentRuntime } from '../src/bridge/config-load.js';

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}
const header = (title) => console.log(`## ${title}`);

function sseOf(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}
function chunk(content, extra = {}) {
  return { choices: [{ index: 0, delta: { content }, finish_reason: null }], ...extra };
}

// 假端点：按 mode 决定回什么；calls 记录每次请求的 path/body/authorization。
function startServer() {
  const state = { mode: 'tool-then-text', calls: [], rounds: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (piece) => { raw += piece; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* 允许空 */ }
      state.calls.push({ path: req.url, headers: req.headers, body });
      const mode = state.mode;
      state.rounds += 1;
      if (mode === 'http500') { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom'); return; }
      if (mode === 'slow') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(sseOf([chunk('慢'), { choices: [{ delta: {}, finish_reason: 'stop' }] }]));
        }, 400);
        return;
      }
      if (mode === 'json') {
        // 有些网关忽略 stream:true，直接回非流式 JSON —— 也要能工作。
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '非流式回复' }, finish_reason: 'stop' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (mode === 'tool-then-text') {
        if (state.rounds === 1) {
          res.write(sseOf([
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'qq_status', arguments: '{"x":1}' } }] }, finish_reason: null }] }
          ]));
          res.end('data: [DONE]\n\n');
          return;
        }
        res.write(sseOf([
          chunk('好的'),
          chunk('收到'),
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 5 } } }
        ]));
        res.end('data: [DONE]\n\n');
        return;
      }
      if (mode === 'tools-forever') {
        res.write(sseOf([
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${state.rounds}`, type: 'function', function: { name: 'qq_status', arguments: '{}' } }] }, finish_reason: null }] }
        ]));
        res.end();
        return;
      }
      if (mode === 'no-trailing-newline') {
        // 最后一条 data 故意不加换行：流尾必须补处理，否则会吞掉 usage。
        res.end(`data: ${JSON.stringify(chunk('尾行'))}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}`);
        return;
      }
      // plain-text 或其它：只回一段文本，没有工具调用
      res.end(sseOf([chunk('只说话'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, server, port: server.address().port })));
}

async function collect(transport, request) {
  const events = [];
  for await (const event of transport.startTurn(request)) events.push(event);
  return events;
}
const baseRequest = { key: 'group:1', sessionId: 's1', messages: [{ role: 'user', text: '你好' }], system: 'sys' };

const { state, server, port } = await startServer();
const baseUrl = `http://127.0.0.1:${port}/v1/`;
try {
  // ── 1. 请求形状 + host 工具循环 + usage ────────────────────────────
  header('请求形状 + host 工具循环');
  {
    const calls = [];
    const localTools = {
      async listTools() {
        return [{ name: 'qq_status', description: '查在线状态', parameters: { type: 'object', properties: { x: { type: 'number' } } } }];
      },
      async callTool(name, args) { calls.push([name, args]); return { content: [{ type: 'text', text: 'QQ 在线' }] }; },
      close() { calls.push(['close']); }
    };
    state.mode = 'tool-then-text';
    state.rounds = 0;
    state.calls = [];
    const transport = createOpenAiTransport({ cfg: { agent: { baseUrl, apiKey: 'sk-test', model: 'gpt-x', timeoutMs: 5000, maxToolRounds: 4 } }, localTools });
    assert(transport.type === 'openai', 'type=openai');
    assert(transport.capabilities().toolLoop === 'host', 'capabilities.toolLoop=host');
    const events = await collect(transport, baseRequest);
    const texts = events.filter((event) => event.type === 'text_delta').map((event) => event.text).join('');
    assert(texts === '好的收到', `文本增量拼接正确（${texts}）`);
    const toolCall = events.find((event) => event.type === 'tool_call');
    assert(toolCall && toolCall.name === 'qq_status', '出现 tool_call 事件');
    const toolResult = events.find((event) => event.type === 'tool_result');
    assert(toolResult && toolResult.text === 'QQ 在线', 'tool_result 带工具返回文本');
    assert(calls[0][0] === 'qq_status' && calls[0][1].x === 1, '本地工具被调用且参数解析正确');
    const usage = events.find((event) => event.type === 'usage');
    assert(usage && usage.usage.prompt === 11 && usage.usage.completion === 7 && usage.usage.cached === 5, 'usage 映射 prompt/completion/cached');
    assert(usage.usage.total === 18, 'usage total 取端点值');
    const turnEnd = events[events.length - 1];
    assert(turnEnd.type === 'turn_end' && turnEnd.finishReason === 'stop', '最后一条是 turn_end(stop)');
    assert(state.calls[0].path === '/v1/chat/completions', '尾部斜杠归一后的请求路径正确');
    assert(state.calls[0].headers.authorization === 'Bearer sk-test', 'Authorization: Bearer');
    assert(state.calls[0].body.stream === true, '请求带 stream:true');
    assert(state.calls[0].body.model === 'gpt-x', '请求带 model');
    const tools = state.calls[0].body.tools;
    assert(Array.isArray(tools) && tools.length === 1 && tools[0].type === 'function', '请求带 OpenAI 格式 tools');
    assert(tools[0].function.name === 'qq_status' && tools[0].function.parameters.type === 'object', 'tools 用 MCP 的 JSON Schema');
    const second = state.calls[1].body.messages;
    assert(second[0].role === 'system' && second[0].content === 'sys', 'system 段在最前');
    assert(second.some((message) => message.role === 'assistant' && Array.isArray(message.tool_calls)), '第二轮带 assistant.tool_calls');
    assert(second.some((message) => message.role === 'tool' && message.tool_call_id === 'call_1'), '第二轮带 role=tool 回填');
    transport.close();
    assert(calls.some((entry) => entry[0] === 'close'), 'close() 关闭本地工具客户端');
  }

  // ── 2. SSE 最后一行没有换行 ───────────────────────────────────────
  header('SSE 流尾缺换行');
  {
    state.mode = 'no-trailing-newline';
    state.rounds = 0;
    const transport = createOpenAiTransport({
      cfg: { agent: { baseUrl, model: 'gpt-x' } },
      localTools: { async listTools() { return []; }, async callTool() { return {}; }, close() {} }
    });
    const events = await collect(transport, baseRequest);
    const texts = events.filter((event) => event.type === 'text_delta').map((event) => event.text).join('');
    assert(texts === '尾行', '流尾最后一行 data 没被吞');
    const usage = events.find((event) => event.type === 'usage');
    assert(usage && usage.usage.prompt === 3 && usage.usage.total === 5, '流尾 usage 也没被吞（total 缺省按 prompt+completion）');
  }

  // ── 3. 超轮数 / 超时 / 非 2xx ─────────────────────────────────────
  header('错误分支');
  {
    state.mode = 'tools-forever';
    state.rounds = 0;
    const transport = createOpenAiTransport({
      cfg: { agent: { baseUrl, model: 'gpt-x', maxToolRounds: 2 } },
      localTools: { async listTools() { return [{ name: 'qq_status', description: '', parameters: { type: 'object' } }]; }, async callTool() { return { content: [{ type: 'text', text: 'ok' }] }; }, close() {} }
    });
    const events = await collect(transport, baseRequest);
    const last = events[events.length - 1];
    assert(last.type === 'error' && last.error.includes('工具循环超过 2 轮'), `超过 maxToolRounds 出 error（${last.error}）`);
    assert(state.rounds === 2, '超过上限后不再发请求');
  }
  {
    state.mode = 'slow';
    state.rounds = 0;
    const transport = createOpenAiTransport({
      cfg: { agent: { baseUrl, model: 'gpt-x', timeoutMs: 5000 } },
      localTools: { async listTools() { return []; }, async callTool() { return {}; }, close() {} }
    });
    const started = Date.now();
    const events = await collect(transport, { ...baseRequest, timeoutMs: 200 });
    const last = events[events.length - 1];
    assert(last.type === 'error' && /超时/.test(last.error), `超时出中文 error（${last.error}）`);
    assert(Date.now() - started < 3000, '超时没有挂住');
  }
  {
    state.mode = 'http500';
    state.rounds = 0;
    const transport = createOpenAiTransport({ cfg: { agent: { baseUrl, model: 'gpt-x' } }, localTools: { async listTools() { return []; }, async callTool() { return {}; }, close() {} } });
    const events = await collect(transport, baseRequest);
    const last = events[events.length - 1];
    assert(last.type === 'error' && last.error.includes('HTTP 500'), `非 2xx 出中文 error（${last.error}）`);
  }

  // ── 4. 坏请求 / 缺配置 / 工具清单失败降级 ─────────────────────────
  header('请求与配置校验');
  {
    const transport = createOpenAiTransport({ cfg: { agent: { baseUrl, model: 'gpt-x' } }, localTools: { async listTools() { return []; }, async callTool() { return {}; }, close() {} } });
    const noKey = await collect(transport, { ...baseRequest, key: '' });
    assert(noKey[0].type === 'error' && noKey[0].error.includes('key'), '缺 key → error');
    const noSession = await collect(transport, { ...baseRequest, sessionId: '' });
    assert(noSession[0].type === 'error' && noSession[0].error.includes('sessionId'), '缺 sessionId → error');
    const noMessages = await collect(transport, { ...baseRequest, messages: [] });
    assert(noMessages[0].type === 'error' && noMessages[0].error.includes('messages'), '空 messages → error');
  }
  {
    state.mode = 'plain-text';
    state.rounds = 0;
    state.calls = [];
    let logged = '';
    const transport = createOpenAiTransport({
      cfg: { agent: { baseUrl, model: 'gpt-x' } },
      log: (line) => { logged = line; },
      localTools: { async listTools() { throw new Error('MCP 挂了'); }, async callTool() { return {}; }, close() {} }
    });
    const events = await collect(transport, baseRequest);
    const texts = events.filter((event) => event.type === 'text_delta').map((event) => event.text).join('');
    assert(texts === '只说话', '工具清单失败时降级为纯文本对话');
    assert(!('tools' in state.calls[0].body), '降级后请求不带 tools');
    assert(logged.includes('工具清单获取失败'), '降级打了日志');
  }
  {
    state.mode = 'plain-text';
    state.rounds = 0;
    const transport = createOpenAiTransport({ cfg: { agent: { baseUrl, model: '' } }, localTools: { async listTools() { return []; }, async callTool() { return {}; }, close() {} } });
    const events = await collect(transport, baseRequest);
    assert(events[0].type === 'error' && events[0].error.includes('agent.model'), '缺 model → error 指出配置项');
  }
  {
    state.mode = 'plain-text';
    state.rounds = 0;
    const transport = createOpenAiTransport({ cfg: { agent: { baseUrl: '   ', model: 'gpt-x' } }, localTools: { async listTools() { return []; }, async callTool() { return {}; }, close() {} } });
    const events = await collect(transport, baseRequest);
    assert(events[0].type === 'error' && events[0].error.includes('agent.baseUrl'), '缺 baseUrl → error 指出配置项');
  }
  // ── 5. 非流式 JSON 回落 + usage 缺省 ────────────────────────────
  header('非流式回落');
  {
    state.mode = 'json';
    state.rounds = 0;
    const transport = createOpenAiTransport({ cfg: { agent: { baseUrl, model: 'gpt-x' } }, localTools: { async listTools() { return []; }, async callTool() { return {}; }, close() {} } });
    const events = await collect(transport, baseRequest);
    const texts = events.filter((event) => event.type === 'text_delta').map((event) => event.text).join('');
    assert(texts === '非流式回复', '端点忽略 stream 时也能解析 JSON 响应');
    const turnEnd = events[events.length - 1];
    assert(turnEnd.type === 'turn_end' && turnEnd.finishReason === 'stop', '非流式也发 turn_end');
    assert(turnEnd.usage === null, '没有 usage 字段时 turn_end.usage 是 null');
  }
  header('tools 描述缺省');
  {
    state.mode = 'plain-text';
    state.rounds = 0;
    state.calls = [];
    const transport = createOpenAiTransport({ cfg: { agent: { baseUrl, model: 'gpt-x' } }, localTools: { async listTools() { return [{ name: 'qq_ping' }]; }, async callTool() { return {}; }, close() {} } });
    await collect(transport, baseRequest);
    const tools = state.calls[0].body.tools;
    assert(tools[0].function.description === '', 'MCP 没给 description 时补空字符串');
    assert(tools[0].function.parameters.type === 'object', 'MCP 没给 parameters 时补空 object schema');
  }
} finally {
  server.close();
}

// ── 注册表 / host 分支的错误口径（真机装配那两行的最小回归） ──
header('注册表与 host 分支');
resetAgentTransports();
assert(getAgentTransportFactory('openai') === null, '未注册时 openai 拿不到工厂（返回 null，不抛）');
registerAgentTransport('openai', createOpenAiTransport);
assert(typeof getAgentTransportFactory('openai') === 'function', '注册后能按 type 取到 openai 工厂');
assert(getAgentTransportFactory('http') === null, '未注册的 http 仍是 null（不会误命中）');
resetAgentTransports();
{
  const bad = await runHostTurn({ agentTransport: {} }, { key: 'private:1', messages: [{ role: 'user', text: 'hi' }] });
  assert(bad.ok === false && /不支持 startTurn/.test(bad.error), 'transport 没有 startTurn 时给中文错误而不是崩');
  assert(agentToolLoopModeOf({ cfg: { agent: { type: 'openai' } } }) === 'host', 'cfg.agent.type=openai 时判定为 host 工具循环');
  assert(agentToolLoopModeOf({ cfg: { agent: { type: 'dsh' } }, agentTransport: { capabilities: () => ({ toolLoop: 'agent' }) } }) === 'agent', 'dsh 仍是 agent 侧工具循环（零行为变化）');
  const runtimeOpenai = normalizeAgentRuntime({ type: 'openai', baseUrl: 'http://127.0.0.1:3987/v1', model: 'mock-model', apiKey: 'k' });
  assert(runtimeOpenai.type === 'openai' && runtimeOpenai.baseUrl === 'http://127.0.0.1:3987/v1', '运行时配置保留 openai 段（探活/装配读的就是它）');
  assert(runtimeOpenai.maxToolRounds === 8 && runtimeOpenai.timeoutMs === 120000, 'openai 段缺省补 maxToolRounds/timeoutMs 默认值');
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed) process.exit(1);
