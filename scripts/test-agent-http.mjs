// 自研 HTTP agent transport 的离线测试：起一个本地 http 假端点，不碰真实网络。
//
// 覆盖点：请求形状（/turn、headers、body）、SSE 5 类事件解析、工具由桥接执行 + POST /tool-result
// 回填后同一条流继续、帧坏 JSON/非 2xx/非 SSE 归一成 error、空闲超时、取消时 DELETE /turn/:id、
// probe /health 的 200/401、submitToolResult 公开方法。

import http from 'node:http';
import { createHttpTransport } from '../src/agent/transport-http.js';
import { describeAgentTransport, projectTurnEvents, AGENT_TRANSPORTS } from '../src/agent/contract.js';

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}
const header = (title) => console.log(`## ${title}`);

function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function startServer() {
  const state = { mode: 'normal', calls: [], streamRes: null, health: 200 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (piece) => { raw += piece; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* 允许空 */ }
      state.calls.push({ method: req.method, path: req.url, headers: req.headers, body });
      if (req.method === 'GET' && req.url === '/health') {
        if (state.health === 200) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
        else { res.writeHead(state.health, { 'content-type': 'application/json' }); res.end('{"ok":false}'); }
        return;
      }
      if (req.method === 'DELETE' && req.url?.startsWith('/turn/')) { res.writeHead(404); res.end(); return; }
      if (req.method === 'POST' && req.url === '/tool-result') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        const stream = state.streamRes;
        if (stream && state.mode === 'tool') {
          state.streamRes = null;
          stream.write(frame('text_delta', { text: '工具后回复' }));
          stream.write(frame('turn_end', { stopReason: 'stop' }));
          stream.end();
        }
        return;
      }
      if (req.method === 'POST' && req.url === '/turn') {
        const mode = state.mode;
        if (mode === 'http500') { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom'); return; }
        if (mode === 'nonsse') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (mode === 'normal') {
          res.write(frame('text_delta', { text: '你好' }));
          res.write(frame('text_delta', { text: '世界' }));
          res.write(frame('usage', { promptTokens: 12, completionTokens: 3 }));
          res.write(frame('turn_end', { stopReason: 'stop' }));
          res.end();
          return;
        }
        if (mode === 'badjson') {
          res.write('event: text_delta\ndata: {not-json\n\n');
          res.end();
          return;
        }
        if (mode === 'tool') {
          state.streamRes = res;
          res.write(frame('tool_call', { id: 'call_9', name: 'qq_status', args: { verbose: true } }));
          return; // 等 /tool-result 再继续
        }
        if (mode === 'idle') {
          res.write(frame('text_delta', { text: '先给一句' }));
          return; // 不结束，测空闲超时
        }
        if (mode === 'cancel') {
          res.write(frame('text_delta', { text: '取消前' }));
          return; // 不结束，测 DELETE
        }
        res.end();
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  return { server, state };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const cfg = (extra = {}) => ({ agent: { type: 'http', baseUrl: '', apiKey: 'test-token', model: '', timeoutMs: 5000, ...extra } });

function toolClient(calls) {
  return {
    listTools: async () => [{ name: 'qq_status', description: '状态', parameters: { type: 'object', properties: {} } }],
    callTool: async (name, args) => { calls.push({ name, args }); return { content: [{ type: 'text', text: 'tool-ok' }] }; },
    close: () => {}
  };
}

async function run() {
  header('契约：http 能力表与事件投影');
  assert(AGENT_TRANSPORTS.includes('http'), 'http 在 AGENT_TRANSPORTS 里');
  const caps = describeAgentTransport('http');
  assert(caps.stream === true, 'http.stream=true');
  assert(caps.toolLoop === true, 'http.toolLoop=true（桥接执行工具）');
  assert(caps.sessions === false, 'http.sessions=false');
  assert(caps.multimodal === false, 'http.multimodal=false');
  const projected = projectTurnEvents([
    { type: 'text_delta', text: 'a' },
    { type: 'tool_call', name: 'x' },
    { type: 'turn_end', stopReason: 'stop' },
    { type: 'usage', usage: {} },
    { type: 'error', error: 'e' }
  ]);
  assert(projected.events.length === 5, 'projectTurnEvents 认识 5 类事件');
  assert(projected.dropped === 0, '5 类事件没有被丢弃');

  // ---- 正常流 ----
  header('正常流：text_delta ×2 + usage + turn_end');
  {
    const { server, state } = startServer();
    const baseUrl = await listen(server);
    state.mode = 'normal';
    const toolCalls = [];
    const transport = createHttpTransport({ cfg: cfg({ baseUrl }), localTools: toolClient(toolCalls), log: () => {} });
    const handlers = { texts: [], usages: [], ends: [] };
    const turn = await transport.runTurn({
      key: 'group:123',
      sessionId: 'sid-1',
      system: 'SYS',
      messages: [{ role: 'user', text: '你好' }],
      tools: [{ name: 'qq_status', description: '状态', parameters: { type: 'object', properties: {} } }],
      persona: { name: '小鲸鱼', text: '人格' },
      turnId: 'turn-fixed-1'
    }, {
      onText: (text) => handlers.texts.push(text),
      onUsage: (usage) => handlers.usages.push(usage),
      onEnd: (end) => handlers.ends.push(end)
    });
    assert(turn.ok === true, 'runTurn ok');
    assert(turn.text === '你好世界', `文本拼接正确（${turn.text}）`);
    assert(turn.usage && turn.usage.prompt === 12, 'usage.prompt=12');
    assert(turn.usage && turn.usage.completion === 3, 'usage.completion=3');
    assert(turn.stopReason === 'stop', 'stopReason=stop');
    assert(handlers.texts.join('') === '你好世界', 'onText 回调逐段收到');
    assert(handlers.usages.length === 1, 'onUsage 回调一次');
    assert(handlers.ends.length === 1, 'onEnd 回调一次');
    const req = state.calls.find((call) => call.path === '/turn');
    assert(Boolean(req), '请求打到 /turn');
    assert(req.headers['content-type'] === 'application/json', 'content-type=application/json');
    assert(req.headers.accept === 'text/event-stream', 'accept=text/event-stream');
    assert(req.headers['x-qdb-turn'] === 'turn-fixed-1', 'x-qdb-turn 带 turnId');
    assert(req.headers.authorization === 'Bearer test-token', 'authorization 带 Bearer token');
    assert(req.body.turnId === 'turn-fixed-1', 'body.turnId 一致');
    assert(req.body.sessionKey === 'group:123', 'body.sessionKey 保留会话 key');
    assert(req.body.system === 'SYS', 'body.system 原样');
    assert(Array.isArray(req.body.messages) && req.body.messages[0].text === '你好', 'body.messages 原样');
    assert(req.body.tools && req.body.tools[0].name === 'qq_status', 'body.tools 带工具 schema');
    assert(req.body.persona && req.body.persona.name === '小鲸鱼', 'body.persona 原样');
    server.close();
  }

  // ---- 工具回填：同一条流继续 ----
  header('工具由桥接执行：tool_call → /tool-result → 同一流继续');
  {
    const { server, state } = startServer();
    const baseUrl = await listen(server);
    state.mode = 'tool';
    const toolCalls = [];
    const transport = createHttpTransport({ cfg: cfg({ baseUrl }), localTools: toolClient(toolCalls), log: () => {} });
    const turn = await transport.runTurn({ key: 'group:123', sessionId: 'sid-2', messages: [{ role: 'user', text: '查状态' }], turnId: 'turn-tool-1' });
    const types = turn.events.map((event) => event.type);
    assert(types.includes('tool_call'), '事件流有 tool_call');
    assert(types.includes('tool_result'), '事件流有 tool_result（桥接执行结果）');
    assert(turn.text.includes('工具后回复'), '工具回填后同一条流继续输出文本');
    assert(toolCalls.length === 1 && toolCalls[0].name === 'qq_status', '本地工具被调用一次');
    assert(toolCalls[0] && toolCalls[0].args && toolCalls[0].args.verbose === true, '工具参数从 args 对象解析');
    const submitted = state.calls.find((call) => call.path === '/tool-result');
    assert(Boolean(submitted), '回填请求打到 /tool-result');
    assert(submitted.body.turnId === 'turn-tool-1', '回填带 turnId');
    assert(submitted.body.id === 'call_9', '回填带工具调用 id');
    assert(submitted.body.ok === true, '回填 ok=true');
    assert(String(submitted.body.result).includes('tool-ok'), '回填带工具结果文本');
    server.close();
  }

  // ---- 帧坏 JSON ----
  header('帧坏 JSON：归一成 error，不抛');
  {
    const { server, state } = startServer();
    const baseUrl = await listen(server);
    state.mode = 'badjson';
    const transport = createHttpTransport({ cfg: cfg({ baseUrl }), localTools: toolClient([]), log: () => {} });
    const turn = await transport.runTurn({ key: 'k', sessionId: 's', messages: [{ role: 'user', text: 'x' }] });
    assert(turn.ok === false, '坏 JSON 导致 ok=false');
    assert(/无法解析的 JSON/.test(turn.error), `error 说明帧坏 JSON（${turn.error}）`);
    server.close();
  }

  // ---- 非 2xx ----
  header('非 2xx：归一成 error');
  {
    const { server, state } = startServer();
    const baseUrl = await listen(server);
    state.mode = 'http500';
    const transport = createHttpTransport({ cfg: cfg({ baseUrl }), localTools: toolClient([]), log: () => {} });
    const turn = await transport.runTurn({ key: 'k', sessionId: 's', messages: [{ role: 'user', text: 'x' }] });
    assert(turn.ok === false, 'HTTP 500 → ok=false');
    assert(/HTTP 500/.test(turn.error), `error 带状态码（${turn.error}）`);
    server.close();
  }

  // ---- 非 SSE ----
  header('非 SSE：归一成 error');
  {
    const { server, state } = startServer();
    const baseUrl = await listen(server);
    state.mode = 'nonsse';
    const transport = createHttpTransport({ cfg: cfg({ baseUrl }), localTools: toolClient([]), log: () => {} });
    const turn = await transport.runTurn({ key: 'k', sessionId: 's', messages: [{ role: 'user', text: 'x' }] });
    assert(turn.ok === false, '非 SSE → ok=false');
    assert(/text\/event-stream/.test(turn.error), `error 提到 text/event-stream（${turn.error}）`);
    server.close();
  }

  // ---- 空闲超时 ----
  header('空闲超时：长时间没有事件就放弃');
  {
    const { server, state } = startServer();
    const baseUrl = await listen(server);
    state.mode = 'idle';
    const transport = createHttpTransport({ cfg: cfg({ baseUrl }), localTools: toolClient([]), log: () => {} });
    const turn = await transport.runTurn({ key: 'k', sessionId: 's', messages: [{ role: 'user', text: 'x' }], idleTimeoutMs: 200 });
    assert(turn.ok === false, '空闲超时 → ok=false');
    assert(/空闲超时/.test(turn.error), `error 说明空闲超时（${turn.error}）`);
    server.close();
  }

  // ---- 取消：DELETE /turn/:id ----
  header('取消：向服务端 DELETE /turn/:id');
  {
    const { server, state } = startServer();
    const baseUrl = await listen(server);
    state.mode = 'cancel';
    const transport = createHttpTransport({ cfg: cfg({ baseUrl }), localTools: toolClient([]), log: () => {} });
    const controller = new AbortController();
    const pending = transport.runTurn({ key: 'k', sessionId: 's', messages: [{ role: 'user', text: 'x' }], turnId: 'turn-cancel-1', signal: controller.signal });
    setTimeout(() => controller.abort(), 120);
    const turn = await pending;
    assert(turn.ok === false, '取消后 ok=false');
    assert(/取消/.test(turn.error), `error 说明被取消（${turn.error}）`);
    const deleted = state.calls.find((call) => call.method === 'DELETE');
    assert(Boolean(deleted), '取消时发出了 DELETE');
    assert(deleted && deleted.path === '/turn/turn-cancel-1', `DELETE 路径带 turnId（${deleted && deleted.path}）`);
    server.close();
  }

  // ---- probe ----
  header('probe /health');
  {
    const { server, state } = startServer();
    const baseUrl = await listen(server);
    state.health = 200;
    const transport = createHttpTransport({ cfg: cfg({ baseUrl }) });
    const ok = await transport.probe();
    assert(ok.ok === true, 'health 200 → probe ok');
    state.health = 401;
    const denied = await transport.probe();
    assert(denied.ok === false, 'health 401 → probe not ok');
    assert(/需要鉴权/.test(denied.error), `401 error 说明需要鉴权（${denied.error}）`);
    server.close();
  }

  // ---- submitToolResult 公开方法 ----
  header('submitToolResult 公开方法');
  {
    const { server, state } = startServer();
    const baseUrl = await listen(server);
    const transport = createHttpTransport({ cfg: cfg({ baseUrl }) });
    const result = await transport.submitToolResult('turn-pub-1', 'call_pub', 'ok-text');
    assert(result.ok === true, 'submitToolResult 回 ok');
    const posted = state.calls.find((call) => call.path === '/tool-result');
    assert(posted && posted.body.turnId === 'turn-pub-1' && posted.body.id === 'call_pub', 'submitToolResult body 正确');
    server.close();
  }

  // ---- 契约：能力表 ----
  header('transport 自身能力');
  {
    const transport = createHttpTransport({ cfg: cfg({ baseUrl: 'http://127.0.0.1:1' }) });
    assert(transport.type === 'http', 'type=http');
    assert(typeof transport.startTurn === 'function', '实现 startTurn');
    assert(typeof transport.runTurn === 'function', '实现 runTurn');
    const caps = transport.capabilities();
    assert(caps.toolLoop === 'host' && caps.stream === true, 'capabilities 报 host 流式');
  }

  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
