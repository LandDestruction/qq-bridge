// 系统打开链接（POST /api/open-url）。
//
// 为什么单独一套：这个接口等于「让本机执行一次打开动作」，白名单一旦漏了就是钓鱼/SSRF 跳板
// （伪造域名诱导管理员点、file:// 读本地文件、javascript: 之类），所以断言重点不是「能打开」，
// 而是「只打开 booth.pm / booth.pximg.net 的 https 链接、其它全 400、智能体一律 403、
// 日志里不落敏感查询串」。打开动作注入假 spawn，既断言传给系统的命令与 URL，又不会真弹浏览器。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createOpenUrl } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/open-url.js')).href);

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'open-url-'));
const stateDir = path.join(tmp, 'state');
const logPath = path.join(stateDir, 'open-url.log');
const spawnCalls = [];
const logs = [];
function fakeSpawn(...args) {
  spawnCalls.push(args);
  return { unref() {} };
}
const deps = {
  fs,
  path,
  URL,
  STATE_DIR: stateDir,
  log: (message) => logs.push(String(message)),
  spawn: fakeSpawn
};
const handler = createOpenUrl(deps).handleConsoleOpenUrl;

async function call(method, { body = null, headers = {}, rawBody = null } = {}) {
  const result = { payload: null, status: 0, handled: false };
  const request = {
    req: { method, headers },
    url: new URL('http://127.0.0.1:3100/api/open-url'),
    readBody: async () => {
      if (rawBody !== null) return rawBody;
      if (body === null) throw new Error('没有请求体');
      return body;
    },
    sendJson: (payload, status) => { result.payload = payload; result.status = status || 200; }
  };
  result.handled = await handler(request);
  return result;
}
const open = (url, extra = {}) => call('POST', { body: { url }, ...extra });
const host = 'booth.pm';
const itemUrl = 'https://booth.pm/ja/items/8942722';

console.log('## 白名单内：真的交给系统打开');
{
  spawnCalls.length = 0;
  const res = await open(itemUrl);
  eq('200', res.status, 200);
  eq('handled=true', res.handled, true);
  eq('回显归一化后的 url', res.payload.url, itemUrl);
  eq('确实调了一次 spawn', spawnCalls.length, 1);
  const [cmd, args, options] = spawnCalls[0];
  eq('Windows 走 cmd.exe', cmd, 'cmd.exe');
  eq('命令形态是 /c start "" "<url>"', args, ['/c', 'start', '""', `"${itemUrl}"`]);
  eq('宿主进程不等待（detached + stdio:ignore）', [options.detached, options.stdio], [true, 'ignore']);
  check('日志记了 host 与路径', fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes(`${host} /ja/items/8942722`), fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '无日志');
}
{
  for (const allowed of [
    'https://booth.pm/ja/items/1',
    'https://accounts.booth.pm/login',
    'https://shop.booth.pm/items/1',
    'https://booth.pximg.net/c/300x300_a2_g5/x/i/1/y.jpg',
    'https://cdn.booth.pximg.net/a.png'
  ]) {
    const res = await open(allowed);
    check(`放行 ${allowed}`, res.status === 200 && res.payload.ok === true, `${res.status} ${res.payload?.error || ''}`);
  }
}
// 末尾点与 :443 是等价写法：允许打开，但回显的 host 必须归一（否则日志里是另一个「域名」）。
{
  spawnCalls.length = 0;
  const dotted = await open('https://booth.pm./ja/items/1');
  eq('末尾点允许（等价域名）', dotted.status, 200);
  eq('末尾点 host 归一', dotted.payload.url, 'https://booth.pm/ja/items/1');
  const explicitPort = await open('https://booth.pm:443/ja/items/1');
  eq(':443 允许（等价默认端口）', explicitPort.status, 200);
  eq(':443 归一去掉端口', explicitPort.payload.url, 'https://booth.pm/ja/items/1');
}

console.log('## 白名单外：全部 400，且不真的打开');
const rejected = [
  ['http 不是 https', 'http://booth.pm/ja/items/1'],
  ['javascript: 伪协议', 'javascript:alert(1)'],
  ['file: 读本地文件', 'file:///C:/Windows/win.ini'],
  ['data: 伪协议', 'data:text/html,<h1>x</h1>'],
  ['后缀骗术 booth.pm.evil.com', 'https://booth.pm.evil.com/ja/items/1'],
  ['前缀骗术 evilbooth.pm', 'https://evilbooth.pm/ja/items/1'],
  ['近似域名 booth.pxmg.net', 'https://booth.pxmg.net/x.jpg'],
  ['本机回环 127.0.0.1', 'https://127.0.0.1:3100/api/config'],
  ['内网 IP', 'https://192.168.1.1/'],
  ['无关站点', 'https://example.com/ja/items/1'],
  ['userinfo 骗术', 'https://booth.pm@evil.com/x'],
  ['非默认端口 :8443', 'https://booth.pm:8443/ja/items/1']
];
for (const [name, url] of rejected) {
  spawnCalls.length = 0;
  const res = await open(url);
  check(`${name} → 400`, res.status === 400 && res.payload.ok === false, `${res.status} ${res.payload?.error || ''}`);
  eq(`${name} → 一次都没打开`, spawnCalls.length, 0);
}

console.log('## 参数非法：400 且说清原因');
{
  spawnCalls.length = 0;
  const bad = [
    ['没传 url', {}, /url/],
    ['url 不是字符串', { url: 123 }, /字符串/],
    ['空串', { url: '   ' }, /不能为空/],
    ['中间有空白', { url: 'https://booth.pm/ja/items/1 x' }, /空白/],
    ['带换行控制字符', { url: 'https://booth.pm/ja/items/1\n' }, /空白|控制字符/],
    ['超长（>1000）', { url: `https://booth.pm/${'a'.repeat(1000)}` }, /太长/],
    ['解析不了', { url: 'https://' }, /解析/]
  ];
  for (const [name, body, re] of bad) {
    const res = await call('POST', { body });
    check(`${name} → 400`, res.status === 400 && re.test(res.payload.error || ''), `${res.status} ${res.payload?.error || ''}`);
  }
  eq('非法参数一次都没打开', spawnCalls.length, 0);
  const noBody = await call('POST', {});
  eq('没有请求体 → 400', noBody.status, 400);
}

console.log('## 智能体令牌：一律 403，不打开不写日志');
{
  const before = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  spawnCalls.length = 0;
  const a = await open(itemUrl, { headers: { 'x-agent-token': 'agent-x' } });
  eq('x-agent-token → 403', a.status, 403);
  check('403 文案说明是管理端', /管理端/.test(a.payload.error || ''), a.payload.error);
  const b = await open(itemUrl, { headers: { 'x-agent-call': '1' } });
  eq('x-agent-call → 403', b.status, 403);
  eq('agent 请求没打开', spawnCalls.length, 0);
  const after = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  eq('agent 请求没写日志', after, before);
}

console.log('## 方法 / spawn 不可用');
{
  const get = await call('GET', {});
  eq('GET → 405', get.status, 405);
  const noSpawn = createOpenUrl({ ...deps, spawn: null }).handleConsoleOpenUrl;
  const req = {
    req: { method: 'POST', headers: {} },
    url: new URL('http://127.0.0.1:3100/api/open-url'),
    readBody: async () => ({ url: itemUrl }),
    sendJson: (payload, status) => { req.sent = { payload, status: status || 200 }; }
  };
  await noSpawn(req);
  eq('spawn 不可用 → 500', req.sent.status, 500);
  check('500 文案说清原因', /打开失败/.test(req.sent.payload.error || ''), req.sent.payload.error);
  check('打了一条失败日志', logs.some((line) => line.includes('打开链接失败')), logs.join(' | '));
}

console.log('## 日志脱敏：token/session 一类参数值不落盘');
{
  spawnCalls.length = 0;
  const res = await open('https://booth.pm/ja/items/1?token=SECRET-TOKEN-VALUE&session_id=ABC123&x=1');
  eq('带查询串也 200', res.status, 200);
  const text = fs.readFileSync(logPath, 'utf8');
  check('token 值已打码', !text.includes('SECRET-TOKEN-VALUE') && text.includes('token=***'), text.split('\n').slice(-2).join(' / '));
  check('session_id 值已打码', !text.includes('ABC123') && text.includes('session_id=***'), text.split('\n').slice(-2).join(' / '));
  check('普通参数保留', text.includes('x=1'));
  check('日志行以时间开头', /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
