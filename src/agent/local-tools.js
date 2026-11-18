// 本地工具客户端（P1）：把「桥接自己跑工具循环」要用的工具，走同一个 MCP server 暴露出来。
//
// 为什么不手写 zod → JSON Schema：src/mcp-snowluma-safe.js 里已经有全部工具的**现成 JSON Schema**
// （DSH 用的也是它）。openai 兼容端点要的 `tools:[{type:'function',function:{name,description,parameters}}]`
// 正好能直接从 `tools/list` 映射，没必要维护第二份参数定义（两处漂移迟早出事）。
//
// 协议：MCP 走 stdio，JSON-RPC 一行一条消息。
//   initialize → notifications/initialized → tools/list → tools/call
// 本文件零 import：spawn 由 deps 注入（审计沙箱里拿不到就报「spawn 不可用」，不炸装配）。
// 失败语义：所有方法都 reject 带中文原因的 Error，调用方（transport）转成 error 事件。

const MCP_PROTOCOL_VERSION = '2024-11-05';

function jrpcErrorText(message) {
  if (!message || typeof message !== 'object') return 'MCP 返回了无法解析的消息';
  const error = message.error;
  if (error && typeof error === 'object') return String(error.message ?? error.code ?? 'MCP 返回错误');
  return 'MCP 返回错误';
}

/**
 * @param {object} deps
 * @param {Function} deps.spawn node:child_process.spawn
 * @param {string} [deps.ROOT] 仓库根（拼 src/mcp-snowluma-safe.js）
 * @param {string} [deps.mcpScript] 直接指定 MCP server 路径
 * @param {number} [deps.timeoutMs] 单次 JSON-RPC 超时（默认 20000）
 * @param {object} [deps.env] 子进程环境（默认 process.env）
 * @param {Function} [deps.log]
 * @param {Function} [deps.setTimeout]/[deps.clearTimeout] 便于测试注入
 * @returns {{listTools:Function, callTool:Function, close:Function}}
 */
export function createLocalToolClient(deps) {
  const read = (name) => deps?.[name];
  let child = null;
  let nextId = 1;
  let ready = null;
  let buffer = '';
  const pending = new Map();

  const log = (line) => {
    if (typeof read('log') === 'function') read('log')(line);
  };
  const timerOf = () => read('setTimeout') ?? setTimeout;
  const clearTimer = () => read('clearTimeout') ?? clearTimeout;

  function rejectAll(error) {
    for (const [, entry] of pending) {
      entry.fail(error);
    }
    pending.clear();
  }

  function onLine(line) {
    const text = line.trim();
    if (!text) return;
    let message;
    try { message = JSON.parse(text); } catch { log(`[MCP] 非 JSON 输出（已忽略）：${text.slice(0, 200)}`); return; }
    if (message == null || typeof message !== 'object') return;
    // 通知（没有 id）永远不需要回包。
    if (message.id == null) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    const timeout = timerOf();
    void timeout; // 保留注入形参，超时清理由 entry.done 负责
    entry.done();
    if (message.error) entry.fail(new Error(jrpcErrorText(message)));
    else entry.ok(message.result ?? {});
  }

  function onChunk(chunk) {
    buffer += String(chunk);
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      onLine(line);
      index = buffer.indexOf('\n');
    }
  }

  function request(method, params, overrideMs) {
    const timeoutMs = Number(overrideMs) > 0
      ? Number(overrideMs)
      : (Number(read('timeoutMs')) > 0 ? Number(read('timeoutMs')) : 20000);
    return new Promise((resolve, reject) => {
      if (!child) { reject(new Error('MCP 子进程还没启动')); return; }
      const id = nextId++;
      const setTimer = timerOf();
      const clear = clearTimer();
      const timer = setTimer(() => {
        pending.delete(id);
        reject(new Error(`MCP 调用超时（${method}，${timeoutMs}ms）`));
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      pending.set(id, { ok: resolve, fail: reject, done: () => clear(timer) });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`);
      } catch (error) {
        pending.delete(id);
        clear(timer);
        reject(new Error(`写 MCP 请求失败：${error?.message ?? error}`));
      }
    });
  }

  function start() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const spawn = read('spawn');
      if (typeof spawn !== 'function') { reject(new Error('spawn 不可用：本地工具客户端没有注入 child_process.spawn')); return; }
      const root = read('ROOT') || process.cwd();
      const script = read('mcpScript') || `${root}/src/mcp-snowluma-safe.js`;
      let proc;
      try {
        proc = spawn(process.execPath, [script], { cwd: root, env: read('env') ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        reject(new Error(`启动 MCP server 失败：${error?.message ?? error}`));
        return;
      }
      child = proc;
      proc.stdout?.on('data', onChunk);
      proc.stderr?.on('data', (chunk) => log(`[MCP] ${String(chunk).slice(0, 300)}`));
      proc.on?.('error', (error) => { rejectAll(new Error(`MCP 子进程错误：${error?.message ?? error}`)); reject(new Error(`MCP 子进程错误：${error?.message ?? error}`)); });
      proc.on?.('exit', (code, signal) => {
        child = null;
        ready = null;
        rejectAll(new Error(`MCP 子进程退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）`));
      });
      request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'qq-bridge-agent', version: '1.0' }
      }).then(() => {
        try { proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`); } catch { /* 通知失败不影响后续 */ }
        return request('tools/list', {});
      }).then((result) => {
        pendingState.tools = Array.isArray(result?.tools) ? result.tools : [];
        resolve(pendingState.tools);
      }).catch((error) => {
        ready = null;
        reject(error);
      });
    });
    return ready;
  }

  const pendingState = { tools: [] };

  return {
    /** 拿到 MCP 的 tools/list（首次触发 initialize），返回原始 tool 定义数组。 */
    async listTools() {
      const tools = await start();
      return pendingState.tools.length ? pendingState.tools : tools;
    },
    /** 调一个工具；content[].text 由调用方拼成 tool_result 文本。 */
    async callTool(name, args) {
      await start();
      // 长等待类工具（沉睡前观察最长 300s）不能被默认 20s 掐断：按参数放大单次超时。
      let overrideMs
      if (name === 'qq_wait_for_messages') {
        const budget = Number(args && args.timeoutMs) > 0 ? Number(args.timeoutMs) : 30000
        const quiet = Number(args && args.quietMs) > 0 ? Number(args.quietMs) : 0
        overrideMs = Math.min(700000, budget + quiet + 30000)
      }
      const result = await request('tools/call', { name: String(name), arguments: args ?? {} }, overrideMs);
      return result;
    },
    /** 关闭子进程（幂等；退出时 reject 所有在飞的请求）。 */
    close() {
      const proc = child;
      child = null;
      ready = null;
      pendingState.tools = [];
      if (proc) {
        try { proc.stdin?.end(); } catch { /* 已关 */ }
        try { proc.kill(); } catch { /* 已退 */ }
      }
      rejectAll(new Error('本地工具客户端已关闭'));
    }
  };
}
