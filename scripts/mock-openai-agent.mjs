// 开发用 mock OpenAI agent（独立进程，P3 端到端自证）。
//
// 用途：不依赖外部 key / 网络，就能把「非 dsh 后端 + 桥接工具循环」整条链路跑起来。
// 行为脚本化：
//   第 1 次请求（没有 role:'tool'）      → SSE tool_calls(qq_status, finish_reason='tool_calls')
//   收到 role:'tool' 后（第 2 次请求）   → SSE delta.content='状态查询完成' + finish_reason='stop' + usage
// 环境变量：
//   MOCK_OPENAI_PORT   监听端口（默认 8799）
//   MOCK_ALWAYS_TOOL=1 永远回 tool_calls（测 maxToolRounds 上限用）
//   MOCK_QUIET=1       不打印请求摘要
// 端点：POST /v1/chat/completions（SSE）、GET /v1/models（200，给探活/兼容客户端用）。
import http from 'node:http';

const PORT = Number(process.env.MOCK_OPENAI_PORT || 8799);
const ALWAYS_TOOL = process.env.MOCK_ALWAYS_TOOL === '1';
const QUIET = process.env.MOCK_QUIET === '1';

function frame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chatChunk(model, delta, finishReason = null, extra = {}) {
  return { id: 'mock-chat', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-openai-agent', object: 'model', owned_by: 'mock' }] }));
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }
  let raw = '';
  req.on('data', (piece) => { raw += piece; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* 允许空体 */ }
    const model = body.model || 'mock-model';
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const sawToolResult = messages.some((message) => message && message.role === 'tool');
    if (!QUIET) {
      console.log('[mock-openai-agent] request', JSON.stringify({
        n: messages.length,
        model,
        stream: body.stream === true,
        tools: tools.length,
        roles: messages.map((message) => message && message.role),
        firstLen: String(messages[0] && messages[0].content || '').length
      }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (ALWAYS_TOOL || !sawToolResult) {
      res.write(frame(chatChunk(model, {
        role: 'assistant',
        tool_calls: [{ index: 0, id: `call_mock_${Date.now()}`, type: 'function', function: { name: 'qq_status', arguments: '{}' } }]
      }, 'tool_calls')));
      res.end('data: [DONE]\n\n');
      return;
    }
    res.write(frame(chatChunk(model, { role: 'assistant', content: '状态查询完成' })));
    res.write(frame(chatChunk(model, {}, 'stop', {
      usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49, prompt_tokens_details: { cached_tokens: 0 } }
    })));
    res.end('data: [DONE]\n\n');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  if (!QUIET) console.log(`[mock-openai-agent] listening http://127.0.0.1:${PORT}/v1 (alwaysTool=${ALWAYS_TOOL})`);
});
