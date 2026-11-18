// BOOTH 已购/免费下载（P4）桥接模块的行为测试：假 deps + 假 fetch，跑真路由。
// 不联网、不碰真实 state：STATE_DIR 与转存目录都在临时目录里。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const mod = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-download.js')).href);
const pure = await import(pathToFileURL(path.join(ROOT, 'src/booth-download.js')).href);
// 全局暂停（429/403）的真实实现：下载链路必须和找号/补封面写同一份 state/booth-search-pause.json。
const pausePure = await import(pathToFileURL(path.join(ROOT, 'src/booth-pause.js')).href);

let pass = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-libdl-'));
const stateDir = path.join(tmp, 'state');
const saveDir = path.join(tmp, 'inbox');
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(saveDir, { recursive: true });

const fixtureHtml = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/booth-owned-list.html'), 'utf8');
const signedOutHtml = '<html><body><h1>ログイン</h1><form action="/users/sign_in"><input name="user[login]"></form></body></html>';

function makeRes({ status = 200, headers = {}, body = '', url = '' } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const bytes = Buffer.from(body);
  return {
    status,
    url,
    headers: { get: (name) => (h.has(String(name).toLowerCase()) ? h.get(String(name).toLowerCase()) : null) },
    text: async () => bytes.toString('utf8'),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new Uint8Array(bytes) };
          }
        };
      }
    }
  };
}

const calls = [];
function makeFetch(handler) {
  return async (url, init = {}) => {
    calls.push({ url, method: (init.method || 'GET').toUpperCase(), headers: init.headers || {} });
    return handler(url, init);
  };
}

// 分块 + 带延迟的响应体：用来在「下载进行到一半」时抓 status 里的 percent。
function makeSlowRes(chunks, delayMs) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  return {
    status: 200,
    url: '',
    headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? String(total) : null) },
    text: async () => '',
    arrayBuffer: async () => Buffer.concat(chunks).buffer,
    body: {
      getReader: () => {
        let i = 0;
        return {
          read: async () => {
            if (i >= chunks.length) return { done: true, value: undefined };
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            const chunk = chunks[i];
            i += 1;
            return { done: false, value: new Uint8Array(chunk) };
          }
        };
      }
    }
  };
}

let fetchHandler = () => makeRes({ status: 500, body: 'unexpected' });
const deps = {
  path,
  fs,
  STATE_DIR: stateDir,
  atomicWriteJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  },
  log: () => {},
  fetch: (url, init) => makeFetch(fetchHandler)(url, init),
  boothDownloadPure: pure,
  boothPausePure: pausePure,
  Buffer,
  AbortSignal,
  fileArchiveRootDir: () => saveDir
};

const dl = mod.createLibraryDownload(deps);
const handle = dl.handleConsoleLibraryDownload;

function mkReq({ method = 'GET', headers = {}, body = null } = {}) {
  const r = {
    req: { method, headers },
    url: new URL('http://127.0.0.1:3100/placeholder'),
    res: {},
    readBody: async () => body,
    sent: null,
    sendJson(payload, status = 200) { r.sent = { payload, status }; }
  };
  return r;
}

async function callOn(handler, pathname, { method = 'GET', headers = {}, body = null } = {}) {
  const r = mkReq({ method, headers, body });
  r.url = new URL('http://127.0.0.1:3100' + pathname);
  const handled = await handler(r);
  return { handled, status: r.sent ? r.sent.status : 0, payload: r.sent ? r.sent.payload : null };
}

async function call(pathname, opts) {
  return callOn(handle, pathname, opts);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jobsFile = () => path.join(stateDir, 'booth-downloads.json');
const readJobs = () => JSON.parse(fs.readFileSync(jobsFile(), 'utf8'));

console.log('## 智能体令牌一律 403');
{
  const r = await call('/api/library/booth-cookie', { headers: { 'x-agent-token': 'abc' } });
  ok(r.handled === true && r.status === 403, '带 x-agent-token 的请求被拒（403）');
  const r2 = await call('/api/library/owned', { headers: { 'x-agent-call': '1' } });
  ok(r2.status === 403, '带 x-agent-call 的请求被拒（403）');
}

console.log('## Cookie 存取');
{
  const r = await call('/api/library/booth-cookie');
  ok(r.payload.ok === true && r.payload.accounts && Object.keys(r.payload.accounts).length === 0, '还没存 Cookie 时摘要为空');
  ok(!/cookie/i.test(JSON.stringify(r.payload).replace(/booth-cookie|Cookie/g, '')), '摘要里不含 Cookie 原文');
}
{
  const r = await call('/api/library/owned?page=1');
  ok(r.status === 400 && r.payload.needCookie === true, '没存 Cookie 时 /owned 回 400 + needCookie');
}
{
  const cookie = '_plaza_session_id=deadbeefcafe; other=1';
  const r = await call('/api/library/booth-cookie', { method: 'POST', body: { cookie, note: '主号' } });
  ok(r.payload.ok === true, 'POST 保存 Cookie 成功');
  ok(r.payload.current && /^sid-[0-9a-f]{8}$/.test(r.payload.current), '账号槽位名是 sid-<8位>');
  const file = path.join(stateDir, 'booth-cookies.json');
  ok(fs.existsSync(file), 'Cookie 落到 state/booth-cookies.json');
  const text = fs.readFileSync(file, 'utf8');
  ok(!text.includes('deadbeefcafe') === false, '文件里确实存了 Cookie（用于请求），但…');
  const summary = JSON.stringify(r.payload);
  ok(!summary.includes('deadbeefcafe'), '回给页面的摘要里没有 Cookie 原文');
  const stat = fs.statSync(file);
  if (process.platform === 'win32') console.log('  ⏭️ 跳过权限位断言：Windows 上 chmod 不生效（代码里仍尽力收紧）');
  else ok((stat.mode & 0o077) === 0, 'Cookie 文件权限收紧到 0600');
}
{
  const r = await call('/api/library/booth-cookie/remove', { method: 'POST', body: { key: 'sid-00000000' } });
  ok(r.payload.ok === true, '删除不存在的槽位不报错');
}

console.log('## 清单页');
{
  fetchHandler = () => makeRes({ status: 200, body: signedOutHtml, url: 'https://booth.pm/users/sign_in' });
  const r = await call('/api/library/owned?page=1');
  ok(r.status === 401 && r.payload.signedOut === true, '被跳到登录页时回 401 + signedOut');
}
{
  fetchHandler = (url) => makeRes({ status: 200, body: fixtureHtml, url: String(url) });
  const r = await call('/api/library/owned?page=1');
  ok(r.status === 200 && r.payload.ok === true, '正常清单页回 200');
  ok(Array.isArray(r.payload.ids) && r.payload.ids.length === 3, '解析出 3 件已购（fixture）');
  ok(r.payload.next && typeof r.payload.next.stop === 'boolean', '带翻页判定 next');
  const last = calls[calls.length - 1];
  ok(String(last.headers.cookie || '').includes('_plaza_session_id'), '请求带了 Cookie');
}

console.log('## 下载');
{
  const bad = await call('/api/library/download', { method: 'POST', body: { boothId: 'abc', url: 'https://x/' } });
  ok(bad.status === 400, '商品号非法回 400');
  const noUrl = await call('/api/library/download', { method: 'POST', body: { boothId: '9038753' } });
  ok(noUrl.status === 400, '缺 url 回 400');
}
{
  const payload = Buffer.from('PK\u0003\u0004fakezipbytes');
  fetchHandler = (url, init) => (String(init.method || 'GET').toUpperCase() === 'HEAD'
    ? makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="mew.zip"', 'content-length': payload.length } })
    : makeRes({ status: 200, headers: { 'content-length': payload.length, etag: '"abc"' }, body: payload }));
  const r = await call('/api/library/download', { method: 'POST', body: { boothId: '9038753', url: 'https://booth.pm/dl/9038753/mew.zip' } });
  ok(r.payload.ok === true, 'POST 下载启动成功');
  // 等后台 Promise 落盘
  for (let i = 0; i < 40 && !fs.existsSync(path.join(saveDir, '9038753', 'mew.zip')); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const saved = path.join(saveDir, '9038753', 'mew.zip');
  ok(fs.existsSync(saved), '文件落盘到 <转存目录>/<商品号>/<文件名>');
  ok(fs.existsSync(saved) && fs.readFileSync(saved).length === payload.length, '落盘字节数正确');
  ok(!fs.existsSync(saved + '.part'), '临时 .part 文件清理干净');
  const st = await call('/api/library/download/status');
  ok(st.payload.ok === true && st.payload.jobs.some((j) => j.boothId === '9038753' && j.state === 'done'), '状态接口能查到已完成');
}
{
  // 断点续传：已有 .part 与元数据 → 请求应带 Range
  const dir = path.join(saveDir, '9040444');
  fs.mkdirSync(dir, { recursive: true });
  const part = path.join(dir, 'tail.zip.part');
  fs.writeFileSync(part, Buffer.from('PK\u0003\u0004'));
  fs.writeFileSync(part + '.json', JSON.stringify({ etag: '"v1"', total: 20 }));
  calls.length = 0;
  const payload = Buffer.alloc(16, 1);
  fetchHandler = (url, init) => (String(init.method || 'GET').toUpperCase() === 'HEAD'
    ? makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="tail.zip"', 'content-length': 20, etag: '"v1"' } })
    : makeRes({ status: 200, headers: { 'content-length': payload.length } }));
  const r = await call('/api/library/download', { method: 'POST', body: { boothId: '9040444', url: 'https://booth.pm/dl/9040444/tail.zip' } });
  ok(r.payload.ok === true, '续传任务启动成功');
  for (let i = 0; i < 40 && !fs.existsSync(path.join(dir, 'tail.zip')); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const getCall = calls.find((c) => c.method === 'GET');
  ok(Boolean(getCall && getCall.headers && getCall.headers.range), '续传请求带了 Range 头');
}

console.log('## 任务台账（落盘 / 重启 / 重试 / 不覆盖 / 并发）');
{
  // 台账只存去 query 的 booth.pm 路径：/dl/ 链接带签名，写盘就等于把凭据落了盘。
  const payload = Buffer.from('PK\u0003\u0004q');
  fetchHandler = (url, init) => (String(init.method || 'GET').toUpperCase() === 'HEAD'
    ? makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="q.zip"', 'content-length': payload.length } })
    : makeRes({ status: 200, headers: { 'content-length': payload.length }, body: payload }));
  const r = await call('/api/library/download', { method: 'POST', body: { boothId: '9055555', url: 'https://booth.pm/dl/9055555/q.zip?sig=SECRETSIG' } });
  ok(r.payload.ok === true, '带 query 的 dl 链接可以下载');
  for (let i = 0; i < 60 && !fs.existsSync(path.join(saveDir, '9055555', 'q.zip')); i += 1) await sleep(50);
  ok(fs.existsSync(jobsFile()), '下载任务台账落到 state/booth-downloads.json');
  const text = fs.readFileSync(jobsFile(), 'utf8');
  ok(text.includes('https://booth.pm/dl/9055555/q.zip') && !text.includes('SECRETSIG'), '台账只存去 query 的路径（签名不入盘）');
  ok(!text.includes('_plaza_session_id') && !text.includes('deadbeefcafe'), '台账不含 Cookie 原文');
}
{
  // 模拟「上次进程跑到一半被杀」：台账里是 downloading，新实例读回来必须标 interrupted。
  fs.writeFileSync(jobsFile(), JSON.stringify({
    v: 1,
    jobs: [
      { boothId: '9066666', url: 'https://booth.pm/dl/9066666/a.zip', fileName: 'a.zip', bytes: 10, total: 100, state: 'downloading', error: '', startedAt: Date.now() - 5000, finishedAt: 0 },
      { boothId: '9077777', url: 'https://booth.pm/dl/9077777/r.zip', fileName: 'r.zip', bytes: 0, total: 0, state: 'failed', error: 'HTTP 403', startedAt: Date.now() - 4000, finishedAt: Date.now() - 3000 }
    ]
  }));
  const dl2 = mod.createLibraryDownload(deps);
  const st = await callOn(dl2.handleConsoleLibraryDownload, '/api/library/download/status');
  const job = st.payload.jobs.find((j) => j.boothId === '9066666');
  ok(Boolean(job) && job.state === 'interrupted', '重启读回：没跑完的任务标成 interrupted');
  ok(Boolean(job) && /重启|打断/.test(job.error), 'interrupted 带人类可读原因');
}
{
  // 重试用台账里存的 url（去 query 版本）重新入队。
  const payload = Buffer.from('PK\u0003\u0004r');
  fetchHandler = (url, init) => (String(init.method || 'GET').toUpperCase() === 'HEAD'
    ? makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="r.zip"', 'content-length': payload.length } })
    : makeRes({ status: 200, headers: { 'content-length': payload.length }, body: payload }));
  calls.length = 0;
  const dl3 = mod.createLibraryDownload(deps);
  const r = await callOn(dl3.handleConsoleLibraryDownload, '/api/library/download/retry', { method: 'POST', body: { boothId: '9077777' } });
  ok(r.payload.ok === true && r.payload.queued === true, 'retry 用落盘 url 重新入队');
  for (let i = 0; i < 60 && !fs.existsSync(path.join(saveDir, '9077777', 'r.zip')); i += 1) await sleep(50);
  // 文件是先建出来再发 GET 的；而且前面块里还没做完的后台下载可能把 GET 记进同一个 calls，
  // 所以按「这条 URL 的 GET 出现过」判定，别拿 calls 里的第一个 GET 当替身。
  const WANT = 'https://booth.pm/dl/9077777/r.zip';
  for (let i = 0; i < 60 && !calls.some((c) => c.method === 'GET' && c.url === WANT); i += 1) await sleep(50);
  const getCall = calls.find((c) => c.method === 'GET' && c.url === WANT);
  ok(Boolean(getCall), 'retry 请求用的是去 query 的 url');
  const st = await callOn(dl3.handleConsoleLibraryDownload, '/api/library/download/status');
  const job = st.payload.jobs.find((j) => j.boothId === '9077777');
  ok(Boolean(job) && job.state === 'done', 'retry 后任务变成 done');
}
{
  // 目标文件已存在且字节数相符 → 直接标 done（skipped:true），不覆盖。
  const dir = path.join(saveDir, '9088888');
  fs.mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from('original-bytes-keep');
  fs.writeFileSync(path.join(dir, 'keep.zip'), bytes);
  const different = Buffer.alloc(bytes.length, 0x41);
  fetchHandler = (url, init) => (String(init.method || 'GET').toUpperCase() === 'HEAD'
    ? makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="keep.zip"', 'content-length': bytes.length } })
    : makeRes({ status: 200, headers: { 'content-length': different.length }, body: different }));
  const dl4 = mod.createLibraryDownload(deps);
  await callOn(dl4.handleConsoleLibraryDownload, '/api/library/download', { method: 'POST', body: { boothId: '9088888', url: 'https://booth.pm/dl/9088888/keep.zip' } });
  await sleep(600);
  const st = await callOn(dl4.handleConsoleLibraryDownload, '/api/library/download/status');
  const job = st.payload.jobs.find((j) => j.boothId === '9088888');
  ok(Boolean(job) && job.state === 'done' && job.skipped === true, '已存在且字节相符：标 done（skipped:true）');
  ok(fs.readFileSync(path.join(dir, 'keep.zip')).equals(bytes), '不覆盖已有文件');
}
{
  // 同一件在跑时不入第二份（HEAD 挂起以制造并发窗口）。
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let headCalls = 0;
  fetchHandler = async (url, init) => {
    if (String(init.method || 'GET').toUpperCase() === 'HEAD') {
      headCalls += 1;
      await gate;
      return makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="c.zip"', 'content-length': 4 } });
    }
    return makeRes({ status: 200, headers: { 'content-length': 4 }, body: Buffer.from('cccc') });
  };
  const dl5 = mod.createLibraryDownload(deps);
  const first = await callOn(dl5.handleConsoleLibraryDownload, '/api/library/download', { method: 'POST', body: { boothId: '9099999', url: 'https://booth.pm/dl/9099999/c.zip' } });
  const second = await callOn(dl5.handleConsoleLibraryDownload, '/api/library/download', { method: 'POST', body: { boothId: '9099999', url: 'https://booth.pm/dl/9099999/c.zip' } });
  ok(first.payload.queued === true && second.payload.already === true, '同一件在跑时不入第二份');
  release();
  await sleep(400);
  const st = await callOn(dl5.handleConsoleLibraryDownload, '/api/library/download/status');
  ok(headCalls === 1 && st.payload.jobs.filter((j) => j.boothId === '9099999').length === 1, '只发一次 HEAD、台账只有一条');
}
{
  const dl6 = mod.createLibraryDownload(deps);
  const r = await callOn(dl6.handleConsoleLibraryDownload, '/api/library/download', { method: 'POST', body: { boothId: '9100000', url: 'https://evil.example/dl/x.zip' } });
  ok(r.status >= 400 && /booth\.pm/.test(String(r.payload.error)), '非 booth.pm 域名拒绝');
}

console.log('## 进度 percent');
{
  // 4 块 × 25 字节、每块 90ms：中途轮询应该能抓到 0<percent<100，完成后是 100。
  const chunks = [Buffer.alloc(25, 1), Buffer.alloc(25, 2), Buffer.alloc(25, 3), Buffer.alloc(25, 4)];
  fetchHandler = (url, init) => (String(init.method || 'GET').toUpperCase() === 'HEAD'
    ? makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="slow.zip"', 'content-length': 100 } })
    : makeSlowRes(chunks, 90));
  const dlP = mod.createLibraryDownload(deps);
  const started = await callOn(dlP.handleConsoleLibraryDownload, '/api/library/download', { method: 'POST', body: { boothId: '9111111', url: 'https://booth.pm/dl/9111111/slow.zip' } });
  ok(started.payload.job && started.payload.job.percent === null, '刚入队 total 未知时 percent 是 null');
  const seen = [];
  let last = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(40);
    const st = await callOn(dlP.handleConsoleLibraryDownload, '/api/library/download/status');
    last = st.payload.jobs.find((j) => j.boothId === '9111111') || null;
    if (last && typeof last.percent === 'number') seen.push(last.percent);
    if (last && last.state === 'done') break;
  }
  ok(seen.some((p) => Number.isInteger(p) && p > 0 && p < 100), '下载中途 percent 是 0~100 的整数且会动');
  ok(Boolean(last) && last.state === 'done' && last.percent === 100, '完成后 percent=100');
}
{
  // HEAD 拿不到 content-length：total 未知，percent 必须一直是 null（不能拿 0 冒充 0%）。
  fetchHandler = () => makeRes({ status: 500, body: 'nope' });
  const dlN = mod.createLibraryDownload(deps);
  let releaseN;
  const gateN = new Promise((resolve) => { releaseN = resolve; });
  fetchHandler = async (url, init) => {
    if (String(init.method || 'GET').toUpperCase() === 'HEAD') {
      await gateN;
      return makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="unknown.zip"' } });
    }
    return makeSlowRes([Buffer.alloc(10, 7)], 60);
  };
  await callOn(dlN.handleConsoleLibraryDownload, '/api/library/download', { method: 'POST', body: { boothId: '9112222', url: 'https://booth.pm/dl/9112222/unknown.zip' } });
  const mid = await callOn(dlN.handleConsoleLibraryDownload, '/api/library/download/status');
  const job = mid.payload.jobs.find((j) => j.boothId === '9112222');
  ok(Boolean(job) && job.percent === null && job.total === 0, 'total 未知时 percent 是 null');
  releaseN();
  await sleep(300);
}

console.log('## 失败分类 errorKind');
{
  const classify = mod.classifyLibraryDownloadError;
  ok(classify('还没保存 BOOTH Cookie，先在上面贴一个') === 'signedOut', 'errorKind：没存 Cookie → signedOut');
  ok(classify('跳转到登录页', true) === 'signedOut', 'errorKind：signedOut 标记 → signedOut');
  ok(classify('HTTP 403') === 'expired', 'errorKind：HTTP 403 → expired');
  ok(classify('链接过期了，重新载入已购清单再下载') === 'expired', 'errorKind：链接过期话术 → expired');
  ok(classify('fetch failed') === 'network', 'errorKind：fetch failed → network');
  ok(classify('ENOSPC: no space left on device') === 'disk', 'errorKind：磁盘满 → disk');
  ok(classify('HTTP 500') === 'unknown', 'errorKind：其它 → unknown');
}
{
  // 端到端：GET 一律 403（链接过期）→ 任务 failed 且 errorKind=expired 落进 status。
  fetchHandler = (url, init) => (String(init.method || 'GET').toUpperCase() === 'HEAD'
    ? makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="gone.zip"', 'content-length': 8 } })
    : makeRes({ status: 403, body: 'expired' }));
  const dlE = mod.createLibraryDownload(deps);
  await callOn(dlE.handleConsoleLibraryDownload, '/api/library/download', { method: 'POST', body: { boothId: '9133333', url: 'https://booth.pm/dl/9133333/gone.zip' } });
  let job = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(100);
    const st = await callOn(dlE.handleConsoleLibraryDownload, '/api/library/download/status');
    job = st.payload.jobs.find((j) => j.boothId === '9133333') || null;
    if (job && job.state === 'failed') break;
  }
  ok(Boolean(job) && job.state === 'failed' && job.errorKind === 'expired', '失败任务带 errorKind=expired');
  ok(Boolean(job) && /过期|失效/.test(String(job.error)), '原有 error 文案不变（仍是链接过期话术）');
}

console.log('## 清理已完成任务（clear）');
{
  const r403 = await call('/api/library/download/clear', { method: 'POST', headers: { 'x-agent-token': 'abc' } });
  ok(r403.status === 403, '带 x-agent-token 的 clear 被拒（403）');
  const dlC = mod.createLibraryDownload(deps);
  const before = await callOn(dlC.handleConsoleLibraryDownload, '/api/library/download/status');
  const doneIds = before.payload.jobs.filter((j) => j.state === 'done').map((j) => j.boothId);
  ok(doneIds.length > 0, '清理前台账里有已完成任务（前面用例留在盘上的）');
  const r = await callOn(dlC.handleConsoleLibraryDownload, '/api/library/download/clear', { method: 'POST' });
  ok(r.payload.ok === true && r.payload.cleared === doneIds.length, 'clear 只清 done 且数量正确');
  const after = await callOn(dlC.handleConsoleLibraryDownload, '/api/library/download/status');
  ok(after.payload.jobs.every((j) => j.state !== 'done'), 'clear 后 status 里没有任何 done');
  ok(after.payload.jobs.some((j) => j.state === 'failed' && j.boothId === '9133333'), 'clear 不动 failed（留给重试）');
  ok(fs.existsSync(path.join(saveDir, '9055555', 'q.zip')), 'clear 不删磁盘文件');
  ok(readJobs().jobs.every((j) => j.state !== 'done'), 'clear 已落盘（台账里也没有 done）');
}

console.log('## 全局暂停：暂停中 0 次请求、429/403 写回同一份暂停');
{
  const pauseFile = path.join(stateDir, 'booth-search-pause.json');
  fs.writeFileSync(pauseFile, JSON.stringify({ pausedUntil: Date.now() + 5 * 60 * 1000, reason: 'BOOTH 搜索被限速（HTTP 429）', status: 429, at: Date.now() }));
  const dlP = mod.createLibraryDownload(deps);
  const before = calls.length;
  const r = await callOn(dlP.handleConsoleLibraryDownload, '/api/library/download', { method: 'POST', body: { boothId: '9144444', url: 'https://booth.pm/dl/9144444/p.zip' } });
  ok(r.status === 409 && r.payload.paused === true, '暂停中下载接口回 409 + paused:true');
  ok(/BOOTH 正在限速暂停，剩余 \d+ 分钟/.test(String(r.payload.error)), `错误是「剩余 N 分钟」人话：${r.payload.error}`);
  ok(calls.length === before, '暂停中一个请求都没发（fetch 0 次）');
  ok(readJobs().jobs.every((j) => j.boothId !== '9144444'), '暂停中不建注定失败的任务台账');
  fs.rmSync(pauseFile, { force: true });
}
{
  const pauseFile = path.join(stateDir, 'booth-search-pause.json');
  // HEAD 回 429（带 Retry-After）：后台任务失败并把暂停写进同一份状态文件，不拿 429 响应体当文件。
  fetchHandler = (url, init) => (String(init.method || 'GET').toUpperCase() === 'HEAD'
    ? makeRes({ status: 429, headers: { 'retry-after': '120' }, body: '' })
    : makeRes({ status: 500, body: 'should-not-download' }));
  const dlR = mod.createLibraryDownload(deps);
  const r = await callOn(dlR.handleConsoleLibraryDownload, '/api/library/download', { method: 'POST', body: { boothId: '9155555', url: 'https://booth.pm/dl/9155555/r.zip' } });
  ok(r.status === 200 && r.payload.queued === true, '429 的 HEAD：先入队（后台跑），不当场抛');
  let job429 = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(50);
    const st = await callOn(dlR.handleConsoleLibraryDownload, '/api/library/download/status');
    job429 = st.payload.jobs.find((j) => j.boothId === '9155555') || null;
    if (job429 && job429.state === 'failed') break;
  }
  ok(Boolean(job429) && job429.state === 'failed' && /BOOTH 正在限速暂停/.test(String(job429.error)), `429 的任务回暂停人话：${job429 && job429.error}`);
  const rec429 = JSON.parse(fs.readFileSync(pauseFile, 'utf8'));
  ok(rec429.status === 429 && Number(rec429.pausedUntil) > Date.now(), '429 写进 state/booth-search-pause.json 且未到期');
  ok(!fs.existsSync(path.join(saveDir, '9155555', 'r.zip')), '429 的响应体没有落成文件');
  fs.rmSync(pauseFile, { force: true });

  // 403 也写（风控/区域限制比 429 停得久，由纯函数决定）。
  fetchHandler = () => makeRes({ status: 403, body: 'forbidden' });
  const dlF = mod.createLibraryDownload(deps);
  await callOn(dlF.handleConsoleLibraryDownload, '/api/library/download', { method: 'POST', body: { boothId: '9166666', url: 'https://booth.pm/dl/9166666/f.zip' } });
  let rec403 = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(50);
    try { rec403 = JSON.parse(fs.readFileSync(pauseFile, 'utf8')); break; } catch { /* 还没写 */ }
  }
  ok(Boolean(rec403) && rec403.status === 403, `403 也写进同一份暂停：${JSON.stringify(rec403)}`);
  ok(Boolean(rec403) && Number(rec403.pausedUntil) - Date.now() > 20 * 60 * 1000, '403 停得比 429 久（>20 分钟）');
  fs.rmSync(pauseFile, { force: true });
}

console.log('## 对账入队的任务带 from=reconcile');
{
  fs.rmSync(path.join(saveDir, '9048449'), { recursive: true, force: true });
  const dlR = mod.createLibraryDownload(deps);
  fetchHandler = (url, init) => {
    const u = String(url);
    if (u.includes('accounts.booth.pm/library') || u.includes('/ja/library')) return makeRes({ status: 200, body: fixtureHtml, url: u });
    return makeRes({
      status: 200,
      headers: { 'content-length': '4', 'content-disposition': 'attachment; filename="ghi789.zip"' },
      body: Buffer.from('PK\u0003\u0004'),
      url: u
    });
  };
  const queued = await dlR.enqueueReconcileDownload({ boothId: '9048449' });
  ok(queued.ok === true && queued.queued === true, '对账入队：清单里找到 dl 链接后入队');
  const st = await callOn(dlR.handleConsoleLibraryDownload, '/api/library/download/status');
  const job = (st.payload.jobs || []).find((row) => row.boothId === '9048449');
  ok(Boolean(job) && job.from === 'reconcile', '入队任务的 from 是 reconcile（前端据此分批量/单件）');
  const manual = await callOn(dlR.handleConsoleLibraryDownload, '/api/library/download', { method: 'POST', body: { boothId: '9048449', url: 'https://booth.pm/dl/9048449/ghi789' } });
  ok(manual.payload.ok === true && manual.payload.already === true, '同一件再手动点一次：already 不并发');
}

console.log('## 翻页找号（第 1 页全是不相干的号）');
{
  fs.rmSync(path.join(saveDir, '9055555'), { recursive: true, force: true });
  const dlP = mod.createLibraryDownload(deps);
  const pagesFetched = [];
  const page1 = '<a href="https://booth.pm/ja/items/9000001">甲</a>'.repeat(3) + '<a rel="next" href="?page=2">次へ</a>';
  // 账号站的下载按钮是 data-href="…/downloadables/<另一套 id>"，链接里没有商品号，只能按 DOM 顺序归属。
  const page2 = '<a href="https://booth.pm/ja/items/9055555">目标</a><div class="js-download-button" data-href="https://booth.pm/downloadables/777"></div>';
  fetchHandler = (url) => {
    const u = String(url);
    if (u.includes('/library?page=1')) { pagesFetched.push(1); return makeRes({ status: 200, body: page1, url: u }); }
    if (u.includes('/library?page=2')) { pagesFetched.push(2); return makeRes({ status: 200, body: page2, url: u }); }
    return makeRes({ status: 200, headers: { 'content-length': '4', 'content-disposition': 'attachment; filename="ppp.zip"' }, body: Buffer.from('PK'), url: u });
  };
  const res = await dlP.enqueueReconcileDownload({ boothId: '9055555' });
  ok(res.ok === true && res.queued === true, '翻到第 2 页找到号并入队');
  ok(pagesFetched.includes(2), '确实请求了第 2 页（第 1 页不判「服务器在重复返回」）');
  ok(String(res.job && res.job.url).includes('/downloadables/'), 'data-href 的 downloadables 链接按顺序归给对应条目');
}

console.log('## 单件下载（已购台账）+ 下载中心 + 调度暂停');
{
  fs.rmSync(path.join(saveDir, '9048449'), { recursive: true, force: true });
  fs.rmSync(path.join(saveDir, '9040444'), { recursive: true, force: true });
  // 已购台账和 /api/library/purchases 共用一份（items 以 boothId 为键）：单件下载要能查到标题。
  fs.writeFileSync(path.join(stateDir, 'booth-purchases.json'), JSON.stringify({
    v: 1,
    at: Date.now(),
    items: {
      '9038753': { boothId: '9038753', title: 'Mew Pose' },
      '9040444': { boothId: '9040444', title: 'Tail Pack' },
      '9048449': { boothId: '9048449', title: 'Slow Pack' }
    }
  }));
  // 先造一条「上次已经下好」的台账（单件下载要回 already，不能又下一遍）。
  fs.writeFileSync(jobsFile(), JSON.stringify({
    v: 1,
    at: Date.now(),
    paused: false,
    pausedAt: 0,
    jobs: [{ boothId: '9038753', from: 'manual', url: 'https://booth.pm/dl/9038753/abc123', fileName: 'abc123', bytes: 14, total: 14, state: 'done', error: '', errorKind: '', skipped: false, startedAt: Date.now() - 1000, finishedAt: Date.now() - 500 }]
  }));
  // 台账 done 只是「上次下过」：adopt 要求目标文件真的在磁盘上（不在就该重下）。
  const keptFile = path.join(saveDir, '9038753', 'abc123');
  fs.mkdirSync(path.dirname(keptFile), { recursive: true });
  fs.writeFileSync(keptFile, Buffer.alloc(14, 7));
  const dlCenter2 = mod.createLibraryDownload(deps);
  const callC = (p, o) => callOn(dlCenter2.handleConsoleLibraryDownload, p, o);

  const bad = await callC('/api/library/purchases/download', { method: 'POST', body: { boothId: 'abc' } });
  ok(bad.status === 400, '单件下载：商品号非法回 400');
  const miss = await callC('/api/library/purchases/download', { method: 'POST', body: { boothId: '9081999' } });
  ok(miss.status === 404 && /已购库里没有/.test(miss.payload.error), '单件下载：不在已购台账回 404 人话');
  const already = await callC('/api/library/purchases/download', { method: 'POST', body: { boothId: '9038753' } });
  ok(already.payload.ok === true && already.payload.already === true, '单件下载：已完成回 already');
  ok(already.payload.skipped === 'exists' || (already.payload.skipped === true && already.payload.reason === 'file_exists'), '单件下载：already 带 skipped=exists');
  ok(typeof already.payload.path === 'string' && already.payload.path.endsWith('abc123'), '单件下载：already 带本地文件路径');
  ok(already.payload.job && already.payload.job.state === 'done', '单件下载：adopt 后 job 仍是 done');

  // 慢速下载中再点一次 → dup（同一件不并发下两次）
  const slowChunks = [Buffer.from('PK\u0003\u0004'), Buffer.from('slow-bytes')];
  fetchHandler = (url, init) => {
    // 清单页（入队要先按号在已购清单里找 dl 链接）回 fixture；HEAD/文件流才走慢速包。
    if (String(url).includes('accounts.booth.pm/library')) return makeRes({ status: 200, body: fixtureHtml, url: String(url) });
    if (String(init.method || 'GET').toUpperCase() === 'HEAD') return makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="slow.zip"', 'content-length': 14 } });
    return makeSlowRes(slowChunks, 150);
  };
  const first = await callC('/api/library/purchases/download', { method: 'POST', body: { boothId: '9048449' } });
  ok(first.payload.ok === true && first.payload.queued === true, '单件下载入队成功');
  ok(first.payload.job && first.payload.job.from === 'purchase', '入队任务 from=purchase');
  ok(first.payload.job && first.payload.job.title === 'Slow Pack', '任务带已购台账标题');
  const dup = await callC('/api/library/purchases/download', { method: 'POST', body: { boothId: '9048449' } });
  const doneDir = path.join(saveDir, '9048449');
  try {
    const leftovers = fs.readdirSync(doneDir).filter((n) => /\.part(\.json)?$/i.test(n));
    ok(leftovers.length === 0, '下载收尾不留 .part 残片', JSON.stringify(leftovers));
  } catch { ok(true, '下载收尾不留 .part 残片（目录不存在跳过）'); }

  ok(dup.payload.ok === true && dup.payload.queued === false && dup.payload.reason === 'dup', '同一件已在队列 → queued:false, reason:dup');

  for (let i = 0; i < 80; i += 1) {
    const st = await callC('/api/library/downloads');
    const job = st.payload.jobs.find((j) => j.boothId === '9048449');
    if (job && job.state === 'done') break;
    await sleep(100);
  }
  const all = await callC('/api/library/downloads');
  ok(all.payload.ok === true && Array.isArray(all.payload.jobs) && all.payload.jobs.length <= 200, '下载中心：jobs 数组且不超过 200 条');
  ok(typeof all.payload.running === 'boolean' && all.payload.paused === false, '下载中心：running / paused 字段');
  ok(all.payload.summary && typeof all.payload.summary.total === 'number' && typeof all.payload.summary.needsScan === 'number', '下载中心：summary 带 total 与 needsScan');
  const doneJob = all.payload.jobs.find((j) => j.boothId === '9048449');
  ok(Boolean(doneJob) && doneJob.state === 'done' && doneJob.from === 'purchase' && doneJob.needsScan === true && doneJob.percent === 100, '完成的任务：state/from/needsScan/percent 正确');
  ok(all.payload.summary.needsScan >= 1, 'needsScan 计数 ≥ 1（提示去刷新/扫描）');
  const order = ['downloading', 'queued', 'interrupted', 'failed', 'done'];
  ok(all.payload.jobs.every((j, i, arr) => i === 0 || order.indexOf(arr[i - 1].state) <= order.indexOf(j.state)), 'jobs 按状态分组排序（进行中在前、完成在后）');
  const limited = await callC('/api/library/downloads?limit=1');
  ok(limited.payload.jobs.length === 1, 'limit=1 只回 1 条');

  const p1 = await callC('/api/library/downloads/pause', { method: 'POST' });
  ok(p1.payload.ok === true && p1.payload.paused === true, '暂停成功');
  const p2 = await callC('/api/library/downloads/pause', { method: 'POST' });
  ok(p2.status === 409 && /已经暂停/.test(p2.payload.error), '重复暂停回 409 人话');
  const pausedFile = JSON.parse(fs.readFileSync(jobsFile(), 'utf8'));
  ok(pausedFile.paused === true && Number(pausedFile.pausedAt) > 0, '暂停状态落台账（含 pausedAt）');
  const blocked = await callC('/api/library/purchases/download', { method: 'POST', body: { boothId: '9040444' } });
  ok(blocked.status === 409 && /下载队列已暂停/.test(blocked.payload.error), '暂停中新任务回 409');
  const dlRestart = mod.createLibraryDownload(deps);
  const afterRestart = await callOn(dlRestart.handleConsoleLibraryDownload, '/api/library/downloads');
  ok(afterRestart.payload.paused === true, '重启后暂停状态还在');
  const r1 = await callOn(dlRestart.handleConsoleLibraryDownload, '/api/library/downloads/resume', { method: 'POST' });
  ok(r1.payload.ok === true && r1.payload.paused === false, '恢复成功');
  const r2 = await callOn(dlRestart.handleConsoleLibraryDownload, '/api/library/downloads/resume', { method: 'POST' });
  ok(r2.status === 409 && /已经在跑/.test(r2.payload.error), '重复恢复回 409 人话');
  const resumed = JSON.parse(fs.readFileSync(jobsFile(), 'utf8'));
  ok(resumed.paused === false, '恢复状态落台账');
  const agent = await callC('/api/library/downloads', { headers: { 'x-agent-token': 'x' } });
  ok(agent.status === 403, '下载中心：agent 令牌 403');
}

console.log('## 下载完自动解压（library.autoExtract）');
{
  fs.rmSync(path.join(saveDir, '9048449'), { recursive: true, force: true });
  fs.rmSync(path.join(saveDir, '9087654'), { recursive: true, force: true });
  // 默认 deps 没有 cfg → 自动解压关闭：下完的 job 不该带 extract。
  fs.writeFileSync(jobsFile(), JSON.stringify({ v: 1, at: Date.now(), paused: false, pausedAt: 0, jobs: [] }));
  fetchHandler = (url, init) => {
    if (String(init.method || 'GET').toUpperCase() === 'HEAD') {
      return Promise.resolve(makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="auto.zip"', 'content-length': '7' } }));
    }
    return Promise.resolve(makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="auto.zip"', 'content-length': '7' }, body: 'abcdefg' }));
  };
  const dlOff = mod.createLibraryDownload(deps);
  const offPost = await callOn(dlOff.handleConsoleLibraryDownload, '/api/library/download', { method: 'POST', body: { boothId: '9048449', url: 'https://booth.pm/dl/9048449/auto.zip' } });
  ok(offPost.payload.ok === true, '自动解压关闭时下载照常入队');
  for (let i = 0; i < 60; i += 1) {
    const st = await callOn(dlOff.handleConsoleLibraryDownload, '/api/library/downloads');
    const job = st.payload.jobs.find((j) => j.boothId === '9048449');
    if (job && job.state === 'done') break;
    await sleep(50);
  }
  const offAll = await callOn(dlOff.handleConsoleLibraryDownload, '/api/library/downloads');
  const offJob = offAll.payload.jobs.find((j) => j.boothId === '9048449');
  ok(offJob && offJob.state === 'done' && !offJob.extract, '自动解压关闭：done 的 job 没有 extract');

  // 打开后：下载仍然照常 done，只是多一段 extract 结果（复用 library-extract 的实现）。
  const seen = [];
  const stubOk = { extractLibraryAsset: async ({ boothId }) => { seen.push(boothId); return { ok: true, files: 3, bytes: 120, destDirRel: '9048449/auto' }; } };
  const depsAuto = { ...deps, cfg: { library: { autoExtract: true } }, libraryExtract: stubOk };
  fs.writeFileSync(jobsFile(), JSON.stringify({ v: 1, at: Date.now(), paused: false, pausedAt: 0, jobs: [] }));
  fs.rmSync(path.join(saveDir, '9048449'), { recursive: true, force: true });   // 上一轮已下过 auto.zip，清掉再测「自动解压开启」路径
  const dlOn = mod.createLibraryDownload(depsAuto);
  const onPost = await callOn(dlOn.handleConsoleLibraryDownload, '/api/library/download', { method: 'POST', body: { boothId: '9048449', url: 'https://booth.pm/dl/9048449/auto.zip' } });
  ok(onPost.payload.ok === true && onPost.payload.queued === true, '自动解压开启时下载照常入队');
  for (let i = 0; i < 80; i += 1) {
    const st = await callOn(dlOn.handleConsoleLibraryDownload, '/api/library/downloads');
    const job = st.payload.jobs.find((j) => j.boothId === '9048449');
    if (job && job.state === 'done') break;
    await sleep(50);
  }
  const onAll = await callOn(dlOn.handleConsoleLibraryDownload, '/api/library/downloads');
  const onJob = onAll.payload.jobs.find((j) => j.boothId === '9048449');
  ok(seen.length === 1 && seen[0] === '9048449', '下载完成后用同一个解压实现（被调用一次）');
  ok(onJob && onJob.state === 'done' && onJob.extract && onJob.extract.state === 'done', '开启后 done 的 job 带 extract.state=done');
  ok(onJob && onJob.extract.files === 3 && onJob.extract.bytes === 120, 'extract 里带 files/bytes');
  ok(onJob && onJob.destDirRel === '9048449/auto', 'job 带 destDirRel');
  ok(onAll.payload.summary && onAll.payload.summary.extracted >= 1, 'summary.extracted 计数 ≥ 1');
  ok(onJob && onJob.needsScan === true, '自动解压不改变 needsScan 语义');

  // 加密包：下载仍 done，extract.state=encrypted，不抛 500。
  const stubEnc = { extractLibraryAsset: async ({ boothId }) => { seen.push(boothId); return { ok: false, encrypted: true, error: '这个压缩包有密码，控制台还没接解压密码' }; } };
  const depsEnc = { ...deps, cfg: { library: { autoExtract: true } }, libraryExtract: stubEnc };
  fs.writeFileSync(jobsFile(), JSON.stringify({ v: 1, at: Date.now(), paused: false, pausedAt: 0, jobs: [] }));
  fs.rmSync(path.join(saveDir, '9087654'), { recursive: true, force: true });
  const dlEnc = mod.createLibraryDownload(depsEnc);
  await callOn(dlEnc.handleConsoleLibraryDownload, '/api/library/download', { method: 'POST', body: { boothId: '9087654', url: 'https://booth.pm/dl/9087654/enc.zip' } });
  for (let i = 0; i < 80; i += 1) {
    const st = await callOn(dlEnc.handleConsoleLibraryDownload, '/api/library/downloads');
    const job = st.payload.jobs.find((j) => j.boothId === '9087654');
    if (job && job.state === 'done') break;
    await sleep(50);
  }
  const encAll = await callOn(dlEnc.handleConsoleLibraryDownload, '/api/library/downloads');
  const encJob = encAll.payload.jobs.find((j) => j.boothId === '9087654');
  ok(encJob && encJob.state === 'done', '加密包下载本身仍算 done');
  ok(encJob && encJob.extract && encJob.extract.state === 'encrypted', '加密包 extract.state=encrypted');
  ok(encJob && /有密码/.test(encJob.extract.error), 'extract.error 说清要密码');

  // 密码类（password_required / aes_unsupported）：下载照样 done，extract 单独标状态，不重试、不抛 500。
  const stubPw = { extractLibraryAsset: async () => ({ ok: false, encrypted: true, encryption: 'zipcrypto', reason: 'password_required', triedPasswords: 0, error: '这个包有密码，输一次就好（会记在本机密码本里）' }) };
  const depsPw = { ...deps, cfg: { library: { autoExtract: true } }, libraryExtract: stubPw };
  fs.writeFileSync(jobsFile(), JSON.stringify({ v: 1, at: Date.now(), paused: false, pausedAt: 0, jobs: [] }));
  fs.rmSync(path.join(saveDir, '9090001'), { recursive: true, force: true });
  const dlPw = mod.createLibraryDownload(depsPw);
  await callOn(dlPw.handleConsoleLibraryDownload, '/api/library/download', { method: 'POST', body: { boothId: '9090001', url: 'https://booth.pm/dl/9090001/pw.zip' } });
  for (let i = 0; i < 80; i += 1) {
    const st = await callOn(dlPw.handleConsoleLibraryDownload, '/api/library/downloads');
    const job = st.payload.jobs.find((j) => j.boothId === '9090001');
    if (job && job.state === 'done') break;
    await sleep(50);
  }
  const pwAll = await callOn(dlPw.handleConsoleLibraryDownload, '/api/library/downloads');
  const pwJob = pwAll.payload.jobs.find((j) => j.boothId === '9090001');
  ok(pwJob && pwJob.state === 'done', '有密码的包下载本身仍 done');
  ok(pwJob && pwJob.extract && pwJob.extract.state === 'password_required', 'extract.state=password_required');
  ok(pwJob && pwJob.extract.encryption === 'zipcrypto', 'extract 保留 encryption 供前端提示');
  ok(pwAll.payload.summary.extracted === 0, '密码未解出时 summary.extracted 不计数');
}

console.log('## 目标文件已存在：不覆盖、不重下（adopt）');
{
  // 真机事故复现：清掉下载台账后再点「下载 #5197537」，它重新下载并覆盖了本地 zip。
  // 现在改成「落盘前看目标文件」：本地文件是用户资产，字节不同也不许覆盖，只 adopt 成 done。
  const ledgerTitle = '【MA設定済】ゆらゆらオバケギミック';
  fs.writeFileSync(jobsFile(), JSON.stringify({ v: 1, at: Date.now(), paused: false, pausedAt: 0, jobs: [] }));
  fs.writeFileSync(path.join(stateDir, 'booth-purchases.json'), JSON.stringify({
    v: 1,
    at: Date.now(),
    items: {
      '9066001': { boothId: '9066001', title: ledgerTitle },
      '9066002': { boothId: '9066002', title: 'Size Mismatch Pack' },
      '9066003': { boothId: '9066003', title: 'Redownload Me' }
    }
  }));
  // 9066003：台账里说 done，但文件其实没了 —— 必须允许重下。
  fs.writeFileSync(jobsFile(), JSON.stringify({
    v: 1,
    at: Date.now(),
    paused: false,
    pausedAt: 0,
    jobs: [{ boothId: '9066003', from: 'purchase', url: 'https://booth.pm/dl/9066003/gone.zip', name: 'gone.zip', fileName: 'gone.zip', bytes: 9, total: 9, state: 'done', error: '', errorKind: '', skipped: false, startedAt: Date.now() - 1000, finishedAt: Date.now() - 500 }]
  }));

  const ownedPage = [
    '<a href="https://booth.pm/ja/items/9066001">a</a><div class="js-download-button" data-href="https://booth.pm/downloadables/91"></div>',
    '<a href="https://booth.pm/ja/items/9066002">b</a><div class="js-download-button" data-href="https://booth.pm/downloadables/92"></div>',
    '<a href="https://booth.pm/ja/items/9066003">c</a><div class="js-download-button" data-href="https://booth.pm/downloadables/93"></div>'
  ].join('');
  let fileGets = 0;
  let headBytes = 11;
  fetchHandler = (url, init) => {
    const u = String(url);
    if (u.includes('accounts.booth.pm/library') || u.includes('/ja/library')) return makeRes({ status: 200, body: ownedPage, url: u });
    if (String(init.method || 'GET').toUpperCase() === 'HEAD') {
      return makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="oka.zip"', 'content-length': String(headBytes) } });
    }
    fileGets += 1;
    return makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="oka.zip"', 'content-length': '4' }, body: Buffer.from('PK\u0003\u0004') });
  };
  const dlG = mod.createLibraryDownload(deps);
  const callG = (p, o) => callOn(dlG.handleConsoleLibraryDownload, p, o);

  // ① 同尺寸已存在：already + file_exists，0 次真正下载，字节不变
  const f1 = path.join(saveDir, '9066001', 'oka.zip');
  fs.mkdirSync(path.dirname(f1), { recursive: true });
  const localBytes = Buffer.from('PK\u0003\u0004-LOCAL');
  fs.writeFileSync(f1, localBytes);
  // 目录里还有更大的缩略图：adopt 只认下载件，不能被图片骗走。
  fs.writeFileSync(path.join(path.dirname(f1), 'oka.thumbnail.png'), Buffer.alloc(4096, 1));
  headBytes = localBytes.length;
  const got = await callG('/api/library/purchases/download', { method: 'POST', body: { boothId: '9066001' } });
  ok(got.payload.ok === true && got.payload.already === true, '已存在：回 already（不重新下载）');
  ok(got.payload.skipped === 'exists' || got.payload.skipped === true, '已存在：skipped=exists（verifier 契约）');
  ok(got.payload.fileName === 'oka.zip' || String(got.payload.path).endsWith('oka.zip'), '已存在：带文件名/相对路径');
  ok(typeof got.payload.path === 'string' && got.payload.path.endsWith('oka.zip'), '已存在：响应带本地文件路径');
  ok(fileGets === 0, '已存在：一次文件下载请求都没发');
  ok(fs.readFileSync(f1).equals(localBytes), '已存在：本地文件字节一个都没变');

  // ② 尺寸与远端 content-length 不同：也不覆盖，标 size_mismatch + errorKind=local_differs
  const f2 = path.join(saveDir, '9066002', 'oka.zip');
  fs.mkdirSync(path.dirname(f2), { recursive: true });
  const localBytes2 = Buffer.from('PK\u0003\u0004-OLDER');
  fs.writeFileSync(f2, localBytes2);
  headBytes = 6; // 远端每次重新生成，字节数不同
  const diff = await callG('/api/library/purchases/download', { method: 'POST', body: { boothId: '9066002' } });
  ok(diff.payload.ok === true && diff.payload.already === true && (diff.payload.skipped === 'size_mismatch' || diff.payload.reason === 'size_mismatch'), '尺寸不同：回 already + size_mismatch');
  ok(Number.isFinite(Number(diff.payload.recordedBytes)) || Number.isFinite(Number(diff.payload.bytes)), '尺寸不同：带记录字节数供人工判断');
  ok(fileGets === 0, '尺寸不同：仍然一次下载都没发（不覆盖）');
  ok(fs.readFileSync(f2).equals(localBytes2), '尺寸不同：本地文件没被替换');
  const dlAfter = await callG('/api/library/downloads');
  const j2 = dlAfter.payload.jobs.find((j) => j.boothId === '9066002');
  ok(j2 && j2.state === 'done' && (j2.skipped === true || Boolean(j2.skipped)) && j2.reason === 'size_mismatch', '尺寸不同：job 标 done+skipped，未覆盖');
  ok(j2 && j2.errorKind === 'local_differs', '尺寸不同：errorKind 标 local_differs（留给人工判断）');

  // ③ 台账标题要盖掉抓页标题（乱码问题）：job.title === 已购台账 title
  const j1 = dlAfter.payload.jobs.find((j) => j.boothId === '9066001');
  ok(j1 && j1.title === ledgerTitle, 'job.title 取已购台账标题（不是抓页/旧台账的乱码）');

  // ④ 台账说 done 但文件丢了 → 允许重下并真的落盘
  const f3 = path.join(saveDir, '9066003', 'oka.zip');
  ok(!fs.existsSync(f3), '前提：9066003 的本地文件确实不在');
  const redo = await callG('/api/library/purchases/download', { method: 'POST', body: { boothId: '9066003' } });
  ok(redo.payload.ok === true && redo.payload.queued === true, '台账 done 但文件丢了：允许重新入队');
  for (let i = 0; i < 60 && !fs.existsSync(f3); i += 1) await sleep(50);
  ok(fs.existsSync(f3), '文件丢了的情况：重新下载后文件真的落盘');

  // ⑤ skipped 要进下载中心汇总
  const sum = await callG('/api/library/downloads');
  ok(Number(sum.payload.summary.skipped) >= 2, 'summary.skipped 统计跳过件数（≥2）');
}

console.log('## 下载成功 → 自动认号/补封面（委托 purchaseFiles，不复制规则）');
{
  fs.writeFileSync(jobsFile(), JSON.stringify({ v: 1, at: Date.now(), paused: false, pausedAt: 0, jobs: [] }));
  fs.rmSync(path.join(saveDir, '9090123'), { recursive: true, force: true });
  fetchHandler = (url, init) => {
    if (String(init.method || 'GET').toUpperCase() === 'HEAD') {
      return Promise.resolve(makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="claim.zip"', 'content-length': '7' } }));
    }
    return Promise.resolve(makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="claim.zip"', 'content-length': '7' }, body: 'abcdefg' }));
  };
  const claimed = [];
  const stubClaim = { autoClaimAfterDownload: async (input) => { claimed.push(input); return { autoBound: true, coverSaved: true }; } };
  const dlClaim = mod.createLibraryDownload({ ...deps, purchaseFiles: stubClaim });
  const post = await callOn(dlClaim.handleConsoleLibraryDownload, '/api/library/download', { method: 'POST', body: { boothId: '9090123', url: 'https://booth.pm/dl/9090123/claim.zip' } });
  ok(post.payload.ok === true && post.payload.queued === true, '下载照常入队（自动认号不阻塞）');
  for (let i = 0; i < 80; i += 1) {
    const st = await callOn(dlClaim.handleConsoleLibraryDownload, '/api/library/downloads');
    const job = st.payload.jobs.find((j) => j.boothId === '9090123');
    if (job && job.state === 'done') break;
    await sleep(50);
  }
  ok(claimed.length === 1, 'done 后调用了一次 autoClaimAfterDownload');
  ok(claimed[0] && claimed[0].boothId === '9090123', '把号传给了认号模块');
  ok(claimed[0] && claimed[0].fileName === 'claim.zip', '把落盘文件名传给了认号模块');
  ok(claimed[0] && /9090123$/.test(String(claimed[0].dirAbs || '')), '把素材目录传给了认号模块');
  const all = await callOn(dlClaim.handleConsoleLibraryDownload, '/api/library/downloads');
  const job = all.payload.jobs.find((j) => j.boothId === '9090123');
  ok(job && job.autoBound === true, 'job 带 autoBound:true');
  ok(job && job.coverSaved === true, 'job 带 coverSaved:true');
  const persisted = JSON.parse(fs.readFileSync(jobsFile(), 'utf8'));
  const row = (persisted.jobs || []).find((j) => j.boothId === '9090123');
  ok(row && row.autoBound === true && row.coverSaved === true, 'autoBound/coverSaved 落台账（重启后仍能看到）');
  const restart = mod.createLibraryDownload({ ...deps, purchaseFiles: stubClaim });
  const after = await callOn(restart.handleConsoleLibraryDownload, '/api/library/downloads');
  const again = after.payload.jobs.find((j) => j.boothId === '9090123');
  ok(again && again.autoBound === true && again.coverSaved === true, '重启实例读台账后标记还在');
}
{
  // 没注入 purchaseFiles 的实例：done 后不能崩，两个标记为 false。
  fs.writeFileSync(jobsFile(), JSON.stringify({ v: 1, at: Date.now(), paused: false, pausedAt: 0, jobs: [] }));
  fs.rmSync(path.join(saveDir, '9090124'), { recursive: true, force: true });
  fetchHandler = (url, init) => {
    if (String(init.method || 'GET').toUpperCase() === 'HEAD') {
      return Promise.resolve(makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="plain.zip"', 'content-length': '4' } }));
    }
    return Promise.resolve(makeRes({ status: 200, headers: { 'content-disposition': 'attachment; filename="plain.zip"', 'content-length': '4' }, body: 'abcd' }));
  };
  const dlPlain = mod.createLibraryDownload(deps);
  await callOn(dlPlain.handleConsoleLibraryDownload, '/api/library/download', { method: 'POST', body: { boothId: '9090124', url: 'https://booth.pm/dl/9090124/plain.zip' } });
  for (let i = 0; i < 80; i += 1) {
    const st = await callOn(dlPlain.handleConsoleLibraryDownload, '/api/library/downloads');
    const job = st.payload.jobs.find((j) => j.boothId === '9090124');
    if (job && job.state === 'done') break;
    await sleep(50);
  }
  const plainAll = await callOn(dlPlain.handleConsoleLibraryDownload, '/api/library/downloads');
  const plainJob = plainAll.payload.jobs.find((j) => j.boothId === '9090124');
  ok(plainJob && plainJob.state === 'done', '没注入认号模块下载也照常 done');
  ok(plainJob && plainJob.autoBound === false && plainJob.coverSaved === false, '标记安全地是 false');
}

console.log('## 其它路径不接管');
{
  const r = await call('/api/library/assets');
  ok(r.handled === false, '别的路径返回 false（交给下一个 handler）');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log(`BOOTH 下载：通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
