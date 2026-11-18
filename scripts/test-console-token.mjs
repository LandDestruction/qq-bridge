// 控制台令牌持久化：HTML 壳子免令牌、数据接口仍要令牌、令牌成功后种 Cookie、之后靠 Cookie 就能用。
// 这套行为靠的是「跑着的桥接」，所以桥接不在就直接跳过（不假装通过）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.CONSOLE_PORT || 3100);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name}`); }
};

function tokenFromState() {
  try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}

async function head(p, init) {
  try {
    const res = await fetch(BASE + p, { ...init, redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers };
  } catch (error) {
    return { status: 0, text: '', headers: null, error };
  }
}

const probe = await head('/api/status');
if (probe.status === 0) {
  console.log('SKIP 桥接没在跑（127.0.0.1:' + PORT + ' 连不上），跳过控制台令牌测试');
  process.exit(0);
}

const token = tokenFromState();
if (!token) {
  console.log('SKIP 读不到 state/console-token，跳过控制台令牌测试');
  process.exit(0);
}

console.log('## 壳子免令牌');
const shell = await head('/client');
ok(shell.status === 200, 'GET /client 不带令牌也返回 200（页面壳子本身没有数据）');
ok(/<html/i.test(shell.text), '返回的是 HTML，不是那段 401 JSON');

console.log('## 数据接口仍要令牌');
const noAuth = await head('/api/status');
ok(noAuth.status === 401, 'GET /api/status 不带令牌仍回 401');
ok(/控制台访问令牌/.test(noAuth.text), '401 的文案说明要令牌（不是空响应）');
const wrong = await head('/api/status?token=deadbeef');
ok(wrong.status === 401, '令牌不对也回 401');

console.log('## 令牌有效时种 Cookie');
const withToken = await head('/api/status?token=' + encodeURIComponent(token));
ok(withToken.status === 200, '带正确令牌回 200');
const setCookie = String(withToken.headers.get('set-cookie') || '');
ok(/qdb_console=/.test(setCookie), '响应里带了 qdb_console Cookie');
ok(/HttpOnly/i.test(setCookie), 'Cookie 是 HttpOnly（脚本读不到它）');
ok(/SameSite=Strict/i.test(setCookie), 'Cookie 是 SameSite=Strict（别的站点发起的请求不会带）');
ok(/Max-Age=\d+/.test(setCookie), 'Cookie 有有效期（不是关掉页面就没了）');

console.log('## 之后只靠 Cookie 也能用');
const cookie = setCookie.split(';')[0];
const cookieOnly = await head('/api/status', { headers: { cookie } });
ok(cookieOnly.status === 200, '只带 Cookie、不带任何令牌头，/api/status 回 200');
ok(/运行|ok/i.test(cookieOnly.text), '返回的是真的状态数据，不是错误');

console.log('## 页面脚本侧');
const shellJs = await head('/client.js');
ok(shellJs.status === 200 && /showTokenGate/.test(shellJs.text), '/client.js 里有令牌输入层（showTokenGate）');
ok(/x-console-token/.test(shellJs.text), '请求仍然会带 x-console-token（Cookie 是兜底不是替代）');

console.log('');
console.log(`控制台令牌：通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
