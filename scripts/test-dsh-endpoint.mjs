// dsh-endpoint 单元测试：验证 DSH 端口发现逻辑。
//
// 为什么需要：DSH 桌面版每次启动都换 web 端口，桥接靠 discoverDshBaseUrl 找新地址。
// 这段逻辑一旦出错，表现是「进程活着、QQ 也连着，但 AI 永远不回话」——很难排查。
// 这里用本地 HTTP 服务器模拟 DSH，覆盖四种场景。
//
// 为什么全部注入 findHostPid / listPorts：这两个默认实现要调 PowerShell 和 netstat，
// 结果取决于「本机此刻有没有 DSH 桌面版在跑」。直接调真实实现会让用例在开发机（有 DSH）
// 和 CI（无 DSH）上结果相反——测试必须只验证逻辑，不验证机器状态。
//
// 运行：node scripts/test-dsh-endpoint.mjs

import http from 'node:http';
import { probeDshBaseUrl, discoverDshBaseUrl } from '../src/dsh-endpoint.js';

let pass = 0;
let fail = 0;

function check(name, got, want) {
  const ok = got === want;
  if (ok) { pass += 1; console.log(`  ok   ${name} → ${got}`); }
  else { fail += 1; console.log(`  FAIL ${name} → got ${got}, want ${want}`); }
}

/** 起一个假 DSH：/ 返回指定状态码和正文。 */
function fakeDsh({ status = 401, body = 'dsh web authentication required', delayMs = 0 } = {}) {
  const server = http.createServer((req, res) => {
    const reply = () => {
      res.writeHead(status, { 'content-type': 'text/html' });
      res.end(body);
    };
    if (delayMs) setTimeout(reply, delayMs); else reply();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

/** 常见的「注入值」：有 host 进程，但列端口/探测阶段可以任意伪造。 */
const noHost = async () => null;

console.log('\n[1] 探测：真 DSH（401 + 特征文案）应识别为 true');
{
  const d = await fakeDsh({ status: 401, body: 'dsh web authentication required' });
  check('probe 401+文案', await probeDshBaseUrl(d.url), true);
  await close(d.server);
}

console.log('\n[2] 探测：带 __DSH_BOOT__ 的 200 也应识别为 true');
{
  const d = await fakeDsh({ status: 200, body: '<script>window.__DSH_BOOT__={}</script>' });
  check('probe 200+boot', await probeDshBaseUrl(d.url), true);
  await close(d.server);
}

console.log('\n[3] 探测：普通本地服务（200 无特征）必须判 false，不能误认');
{
  const d = await fakeDsh({ status: 200, body: '<html>hello, i am nginx</html>' });
  check('probe 200 无特征', await probeDshBaseUrl(d.url), false);
  await close(d.server);
}

console.log('\n[4] 探测：端口没人监听 → false（不能抛异常）');
{
  // 用一个几乎肯定没监听的端口
  check('probe 死端口', await probeDshBaseUrl('http://127.0.0.1:9'), false);
}

console.log('\n[5] 探测：空地址 → false');
{
  check('probe 空串', await probeDshBaseUrl(''), false);
  check('probe undefined', await probeDshBaseUrl(undefined), false);
}

console.log('\n[6] 探测：超时必须按时返回 false（不挂死）');
{
  const d = await fakeDsh({ status: 401, body: 'dsh web authentication required', delayMs: 5000 });
  const t0 = Date.now();
  const got = await probeDshBaseUrl(d.url, 300);
  const ms = Date.now() - t0;
  check('超时返回 false', got, false);
  const timely = ms < 2000;
  check(`超时耗时合理 (${ms}ms < 2000ms)`, timely, true);
  await close(d.server);
}

console.log('\n[7] discover：配置地址仍然可用 → changed=false, found=true');
{
  const d = await fakeDsh({ status: 401, body: 'dsh web authentication required' });
  const r = await discoverDshBaseUrl({ current: d.url, log: () => {} });
  check('found', r.found, true);
  check('changed', r.changed, false);
  check('baseUrl 保持原值', r.baseUrl, d.url);
  await close(d.server);
}

console.log('\n[8] discover：配置地址已死 + 注入「找不到 host 进程」→ found=false，不抛异常');
{
  const logs = [];
  const r = await discoverDshBaseUrl({
    current: 'http://127.0.0.1:9',
    log: (m) => logs.push(String(m)),
    findHostPid: noHost
  });
  check('found', r.found, false);
  check('changed', r.changed, false);
  check('baseUrl 回落到配置值', r.baseUrl, 'http://127.0.0.1:9');
  check('有诊断日志', logs.some((m) => m.includes('DSH')), true);
}

console.log('\n[9] discover：空 current 也不能抛（首次启动场景）');
{
  const r = await discoverDshBaseUrl({ current: '', log: () => {}, findHostPid: noHost });
  check('found', r.found, false);
  check('不抛异常', typeof r.baseUrl === 'string', true);
}

console.log('\n[10] discover：注入的 host 进程在别的端口上找到了 DSH → changed=true 并返回新地址');
{
  const d = await fakeDsh({ status: 401, body: 'dsh web authentication required' });
  const r = await discoverDshBaseUrl({
    current: 'http://127.0.0.1:9',
    log: () => {},
    findHostPid: async () => 4242,
    listPorts: async (pid) => { check('listPorts 收到注入的 pid', pid, 4242); return [d.port]; }
  });
  check('found', r.found, true);
  check('changed', r.changed, true);
  check('baseUrl 指向新端口', r.baseUrl, d.url);
  await close(d.server);
}

console.log('\n[11] discover：host 进程的端口里没有 DSH → 不能瞎认，found=false 且说明原因');
{
  const other = await fakeDsh({ status: 200, body: '<html>i am a webpack dev server</html>' });
  const logs = [];
  const r = await discoverDshBaseUrl({
    current: '',
    log: (m) => logs.push(String(m)),
    findHostPid: async () => 5151,
    listPorts: async () => [other.port]
  });
  check('found', r.found, false);
  check('changed', r.changed, false);
  check('日志点明「没有 DSH web」', logs.some((m) => m.includes('没有 DSH web')), true);
  await close(other.server);
}

console.log('\n[12] discover：查进程本身抛异常（如没有 PowerShell）→ 记日志后按未找到处理');
{
  const logs = [];
  const r = await discoverDshBaseUrl({
    current: 'http://127.0.0.1:9',
    log: (m) => logs.push(String(m)),
    findHostPid: async () => { throw new Error('powershell.exe 不在 PATH'); }
  });
  check('found', r.found, false);
  check('baseUrl 回落到配置值', r.baseUrl, 'http://127.0.0.1:9');
  check('记录「查进程」失败日志', logs.some((m) => m.includes('查进程')), true);
}

console.log('\n[13] discover：列端口抛异常 → 记日志后按未找到处理，不影响返回结构');
{
  const logs = [];
  const r = await discoverDshBaseUrl({
    current: '',
    log: (m) => logs.push(String(m)),
    findHostPid: async () => 4242,
    listPorts: async () => { throw new Error('netstat 执行失败'); }
  });
  check('found', r.found, false);
  check('changed', r.changed, false);
  check('baseUrl 是字符串', typeof r.baseUrl, 'string');
  check('记录「列端口」失败日志', logs.some((m) => m.includes('列端口')), true);
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
