#!/usr/bin/env node
// M7 §7（P2）控制台名单端点：真跑 bridge HTTP handler（audit-bridge-harness，临时目录 + 假 DSH/QQ）。
// 只验四件事：①仅管理端（智能体调用必须被拒）②返回结构 ③limit ④不把 scope 里的群号带出去。
// 用法：node scripts/test-affinity-endpoint.mjs
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const CONSOLE_TOKEN = 'fixture-console-token';
const now = Date.now();
const AFFINITY_STORE = {
  version: 1,
  rulesVer: 1,
  people: {
    111: {
      userId: '111', name: '小明', score: 62, base: 55, modelDelta: 7,
      updatedAt: now, counters: { lastSeenAt: now - 1000, msgs: 10 },
      reasons: [
        { ts: now - 3000, by: 'heuristic', delta: 0.5, why: '被 @ 了一次', scope: 'group:123456' },
        { ts: now - 2000, by: 'model', delta: 2, why: '一起斗过图', scope: 'group:123456' },
        { ts: now - 1000, by: 'model', delta: 1, why: '帮他骂了刷屏的', scope: 'group:123456' }
      ]
    },
    222: {
      userId: '222', name: '', score: 50, base: 50, modelDelta: 0,
      updatedAt: now, counters: { lastSeenAt: now - 9000, msgs: 1 }, reasons: []
    }
  }
};

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const h = await bridgeHarness({
  config: {
    socialV2: { affinity: { enabled: true, start: 50 }, wake: { maxWakePerMinute: 0, maxWakePerHour: 0 }, tools: {} },
    dsh: { provider: 'deepseek-account', model: 'deepseek-flash' }
  },
  files: { 'state/affinity.json': JSON.stringify(AFFINITY_STORE) }
});
h.setMode('reserved2');
const st = h.getSocialV2State(KEY);
const server = h.startConsoleServer();
if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'GET',
      headers: { 'x-console-token': CONSOLE_TOKEN, ...headers }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('超时')));
    req.end();
  });
}

try {
  // ① 管理端：正常返回名单（按最近出现倒序、最近 2 条理由）
  {
    const r = await get('/api/affinity');
    ok('管理端 GET → 200', r.status === 200, `实际 ${r.status}`);
    ok('返回 ok + rulesVer + count', r.json?.ok === true && r.json?.rulesVer === 1 && r.json?.count === 2, `${r.json?.count ?? 'null'}`);
    ok('按最近出现倒序（111 在 222 前）', r.json?.people?.[0]?.userId === '111');
    ok('每人只带最近 2 条理由，新的在前', r.json?.people?.[0]?.reasons?.length === 2 && r.json.people[0].reasons[0].why === '帮他骂了刷屏的');
    ok('不把 scope 里的群号带出去', !r.raw.includes('123456'));
  }

  // ② 智能体（带会话令牌）一律拒绝：MCP 工具进程也持有控制台令牌，不能靠令牌区分
  {
    const r = await get('/api/affinity', { 'x-agent-call': '1', 'x-agent-token': st.agentToken });
    ok('智能体调用 → 403 且不吐名单', r.status === 403 && !r.raw.includes('小明'), `${r.status}/${r.json?.code ?? r.json?.error ?? ''}`);
  }
  // ③ 只带 x-agent-token 也必须拒绝（老 MCP 客户端不带 x-agent-call）
  {
    const r = await get('/api/affinity', { 'x-agent-token': st.agentToken });
    ok('只带 x-agent-token → 403 且不吐名单', r.status === 403 && !r.raw.includes('小明'), `${r.status}/${r.json?.code ?? r.json?.error ?? ''}`);
  }
  // ④ limit 生效
  {
    const r = await get('/api/affinity?limit=1');
    ok('limit=1 → 只返回 1 人', r.json?.count === 1 && r.json?.people?.length === 1);
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
