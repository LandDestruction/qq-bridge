// P3 端到端自证：非 dsh 后端（openai 兼容 mock 进程）+ 桥接工具循环。
//
// 链路：本测试 spawn `scripts/mock-openai-agent.mjs`（独立进程、监听 127.0.0.1 随机端口）→
// createOpenAiTransport 指向它 → startTurn 一轮 → transport 解析 SSE 工具调用 → 通过
// deps.localTools.callTool 执行工具 → 把结果作为 role:'tool' 回填第二轮 → mock 回最终文本。
//
// 说明：工具执行用**测试桩**（真实 local-tools 会 spawn MCP 子进程连 SnowLuma 网关，
// 在无网关的 CI/沙箱里不可用）；桩的接口与 src/agent/local-tools.js 完全一致
// （listTools → [{name,description,inputSchema}]，callTool(name,args) → {content:[{type:'text',text}]}），
// 因此「transport 收到 tool_call 后真的去调 localTools」这一环仍是真跑的。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenAiTransport } from '../src/agent/transport-openai.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed += 1; console.log('✅ ' + label); } else { failed += 1; console.error('❌ ' + label); }
}
function header(title) { console.log('\n## ' + title); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startMock(extraEnv = {}) {
  const port = 18800 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-openai-agent.mjs')], {
    cwd: ROOT,
    env: { ...process.env, MOCK_OPENAI_PORT: String(port), MOCK_QUIET: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return { port, child };
}

async function waitForMock(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(80);
  }
  return false;
}

// 与 src/agent/local-tools.js 同形的工具桩：记录调用，返回 MCP content 形状。
function makeLocalTools() {
  const calls = [];
  return {
    calls,
    client: {
      listTools: async () => [{ name: 'qq_status', description: '查询 QQ 机器人状态', inputSchema: { type: 'object', properties: {} } }],
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, qq: 'online', tool: name }) }] };
      },
      close: async () => {}
    }
  };
}

function makeTransport(port, { maxToolRounds = 4, localTools } = {}) {
  return createOpenAiTransport({
    cfg: {
      agent: {
        type: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'mock',
        model: 'mock-model',
        maxToolRounds,
        timeoutMs: 15000
      }
    },
    localTools,
    log: () => {}
  });
}

async function runTurn(transport) {
  const events = [];
  for await (const event of transport.startTurn({ key: 'private:10001', sessionId: 'e2e-session', messages: [{ role: 'user', text: '帮我查一下状态' }] })) {
    events.push(event);
  }
  return events;
}

async function main() {
  header('一轮内 tool_call → tool_result → 文本 → turn_end（真实独立 mock 进程）');
  const normal = startMock();
  const childText = [];
  normal.child.stderr.on('data', (piece) => childText.push(String(piece)));
  const up = await waitForMock(normal.port);
  assert(up, `mock 进程已监听 127.0.0.1:${normal.port}`);
  const localTools = makeLocalTools();
  const transport = makeTransport(normal.port, { localTools: localTools.client });
  const events = await runTurn(transport);
  const kinds = events.map((event) => event.type);
  const toolCall = events.find((event) => event.type === 'tool_call');
  const toolResult = events.find((event) => event.type === 'tool_result');
  const text = events.filter((event) => event.type === 'text_delta').map((event) => event.text).join('');
  const turnEnd = events.find((event) => event.type === 'turn_end');
  const usage = events.find((event) => event.type === 'usage');

  assert(Boolean(toolCall), '事件里出现 tool_call');
  assert(toolCall && toolCall.name === 'qq_status', `tool_call 是 qq_status（实得 ${toolCall && toolCall.name}）`);
  assert(toolCall && typeof toolCall.arguments === 'string' && JSON.parse(toolCall.arguments || '{}'), 'tool_call.arguments 是 JSON 字符串（可解析）');
  assert(localTools.calls.length === 1 && localTools.calls[0].name === 'qq_status', '桥接侧真的调用了 localTools.callTool(qq_status)');
  assert(Boolean(toolResult), '事件里出现 tool_result');
  assert(toolResult && /"ok":true/.test(String(toolResult.text)), 'tool_result 带回工具输出（含 ok:true）');
  assert(text === '状态查询完成', `第二轮正文为「状态查询完成」（实得「${text}」）`);
  assert(Boolean(turnEnd) && turnEnd.finishReason === 'stop', `turn_end finishReason=stop（实得 ${turnEnd && turnEnd.finishReason}）`);
  assert(Boolean(usage), '事件里带 usage');
  const usageValue = usage && usage.usage || {};
  assert(usageValue.prompt === 42 && usageValue.completion === 7 && usageValue.total === 49, `usage 记录正确（实得 ${usage && JSON.stringify(usage)}）`);
  assert(kinds.indexOf('tool_call') < kinds.indexOf('tool_result'), '顺序：tool_call 在 tool_result 之前');
  assert(kinds.indexOf('tool_result') < kinds.indexOf('text_delta'), '顺序：tool_result 在最终文本之前');
  assert(kinds.indexOf('text_delta') < kinds.indexOf('turn_end'), '顺序：文本在 turn_end 之前');
  assert(!kinds.includes('error'), '整轮没有 error 事件');
  transport.close();
  normal.child.kill();
  await sleep(120);
  assert(normal.child.killed || normal.child.exitCode !== null, 'mock 子进程已结束');
  assert(childText.length === 0, 'mock 子进程没有报错输出');

  header('maxToolRounds 生效：mock 一直回 tool_call，2 轮后终止');
  const alwaysTool = startMock({ MOCK_ALWAYS_TOOL: '1' });
  const alwaysUp = await waitForMock(alwaysTool.port);
  assert(alwaysUp, 'always-tool mock 已监听');
  const tools2 = makeLocalTools();
  const transport2 = makeTransport(alwaysTool.port, { maxToolRounds: 2, localTools: tools2.client });
  const events2 = await runTurn(transport2);
  const error2 = events2.find((event) => event.type === 'error');
  assert(Boolean(error2), '超轮后出现 error 事件（不会无限循环）');
  assert(error2 && /工具循环超过 2 轮/.test(String(error2.error)), `error 文案说明轮数上限（实得 ${error2 && error2.error}）`);
  assert(tools2.calls.length === 2, `正好执行 2 轮工具（实得 ${tools2.calls.length}）`);
  assert(!events2.some((event) => event.type === 'turn_end'), '超轮收尾不再发 turn_end');
  transport2.close();
  alwaysTool.child.kill();

  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('❌ e2e 主流程崩溃：', error && error.stack || error);
  process.exitCode = 1;
});
