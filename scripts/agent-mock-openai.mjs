// 假 OpenAI 兼容端点（真机验收用）：第一轮回 tool_call(qq_status)，第二轮回文本 + usage。
// 只监听 127.0.0.1，不联网；请求摘要写 stdout，方便从后台任务里取证。
import http from 'node:http';

const PORT = Number(process.env.MOCK_OPENAI_PORT || 3987);
let round = 0;

function sseStart(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
}

function sseSend(res, payload) {
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

function sseEnd(res) {
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const first = Array.isArray(body.messages) && body.messages[0] ? String(body.messages[0].content ?? '') : '';
    const summary = { n: ++round, url: req.url, auth: String(req.headers.authorization || '').slice(0, 12), model: body.model, stream: body.stream, tools: tools.length, firstLen: first.length, roles: (body.messages || []).map((m) => m.role) };
    console.log('[mock-openai] request', JSON.stringify(summary));
    const hasToolResult = (body.messages || []).some((m) => m.role === 'tool');
    if (!hasToolResult) {
      sseStart(res);
      sseSend(res, {
        id: 'mock-1', object: 'chat.completion.chunk', model: body.model || 'mock-model',
        choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: 'qq_status', arguments: '{}' } }] }, finish_reason: null }]
      });
      sseEnd(res);
      return;
    }
    sseStart(res);
    sseSend(res, {
      id: 'mock-2', object: 'chat.completion.chunk', model: body.model || 'mock-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: '（mock）工具已执行：' }, finish_reason: null }]
    });
    sseSend(res, {
      id: 'mock-3', object: 'chat.completion.chunk', model: body.model || 'mock-model',
      choices: [{ index: 0, delta: { content: 'qq_status 调用成功，这是本地假端点的验收回复。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168, prompt_tokens_details: { cached_tokens: 60 } }
    });
    sseEnd(res);
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`[mock-openai] listening on http://127.0.0.1:${PORT}/v1`));
