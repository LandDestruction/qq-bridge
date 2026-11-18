// 已购文件清单（GET /api/library/purchase-files）+ 一键导入 Unity 工程（POST /api/library/import-to-unity）。
//
// 这两条路径都会真的碰素材库文件，所以断言重点：
// 清单缓存 10 分钟内只抓一次（refresh 才重抓）、本地已有文件标 downloaded、
// 导入只认配置过的工程根（白名单外 400）、dryRun 不动盘、
// 文件名带 ../ 一律拒绝且不写到工程外、真导入按 Assets/<标题>/ 落文件并记台账。
// 全部用真 fs 临时素材根 + 假 deps + 真 zip 字节，不碰真库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createLibraryPurchaseFiles } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-purchase-files.js')).href);
const { createLibraryImport } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-import.js')).href);
const boothDownloadPure = await import(pathToFileURL(path.join(ROOT, 'src/booth-download.js')).href);
const boothPausePure = await import(pathToFileURL(path.join(ROOT, 'src/booth-pause.js')).href);
const usageRootsPure = await import(pathToFileURL(path.join(ROOT, 'src/library-usage-roots.js')).href);
const zipPure = await import(pathToFileURL(path.join(ROOT, 'src/zip-extract.js')).href);
const { safeResolveInside } = await import(pathToFileURL(path.join(ROOT, 'src/file-archive/paths.js')).href);
const { buildZip } = await import(pathToFileURL(path.join(ROOT, 'scripts/fixtures/zip-build.mjs')).href);

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-import-files-'));
const libDir = path.join(tmp, 'inbox');
const stateDir = path.join(tmp, 'state');
const project = path.join(tmp, 'UnityProject');
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(libDir, { recursive: true });
fs.mkdirSync(project, { recursive: true });

function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpFile, file);
}
const logs = [];
const depsBase = {
  ROOT, STATE_DIR: stateDir, Buffer, fs, path, atomicWriteJson,
  log: (line) => logs.push(String(line)),
  fileArchiveRootDir: () => libDir,
  boothDownloadPure, boothPausePure, safeResolveInside,
};

// ── Cookie 槽：真格式（accounts + current），与下载模块同一份 state/booth-cookies.json
function writeCookie() {
  // 用真 booth-download 的 setCookieAccount 造槽位，保证 key/格式与运行时完全一致。
  const saved = boothDownloadPure.setCookieAccount({}, 'session=fixturecookie; other=1', { note: 'fixture' });
  atomicWriteJson(path.join(stateDir, 'booth-cookies.json'), saved.store);
}

// ── fetch 桩：清单页 + HEAD 下载链接
const calls = [];
function makeFetch(html, sizes = {}) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), method: (options.method || 'GET').toUpperCase() });
    if ((options.method || 'GET').toUpperCase() === 'HEAD') {
      const size = sizes[String(url)] || 0;
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? String(size) : '') },
      };
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(html, 'utf8'),
      headers: { get: () => '' },
    };
  };
}
function listHtml(boothId, title) {
  return `<html><body>
  <div class="item"><a href="/ja/items/${boothId}">${title}</a>
    <div class="js-download-button" data-href="https://booth.pm/downloadables/1111"></div>
    <div class="js-download-button" data-href="https://booth.pm/downloadables/2222"></div>
  </div>
  <div class="item"><a href="/ja/items/7777777">Other</a>
    <div class="js-download-button" data-href="https://booth.pm/downloadables/9999"></div>
  </div></body></html>`;
}
const html = listHtml('5197537', 'ゆらゆらオバケ');
const sizes = { 'https://booth.pm/downloadables/1111': 11, 'https://booth.pm/downloadables/2222': 22 };
writeCookie();

function req(url, { method = 'GET', headers = {}, body } = {}) {
  const sent = [];
  const request = {
    url, method, headers,
    // console-server 的 consoleRequest 暴露 readBody（带 512KB 上限），handler 现在只走它，不直接迭代请求流。
    readBody: async () => (body === undefined ? null : body),
    sendJson: (data, status) => sent.push({ data, status: status || 200 }),
  };
  return { request, sent };
}

// ══════════════════════════════════════════════════════════════════
console.log('## 文件清单：缓存 / 刷新 / 本地状态');
const pf = createLibraryPurchaseFiles({ ...depsBase, fetch: makeFetch(html, sizes) });
{
  const { request, sent } = req('/api/library/purchase-files?boothId=5197537');
  const handled = await pf.handleConsoleLibraryPurchaseFiles(request);
  check('接管 purchase-files 路由', handled === true);
  eq('第一页清单 200', sent[0] && sent[0].status, 200);
  eq('两个文件', sent[0] && sent[0].data.files.length, 2);
  eq('文件名取 URL 末段', sent[0] && sent[0].data.files.map((f) => f.fileName), ['1111.zip', '2222.zip']);
  eq('字节来自 HEAD', sent[0] && sent[0].data.files.map((f) => f.bytes), [11, 22]);
  eq('都是 pending', sent[0] && sent[0].data.files.map((f) => f.state), ['pending', 'pending']);
  check('缓存已落盘', fs.existsSync(path.join(stateDir, 'booth-purchase-files.json')));
  const fetchesAfterFirst = calls.filter((c) => c.method === 'GET').length;
  const again = createLibraryPurchaseFiles({ ...depsBase, fetch: makeFetch(html, sizes) });
  const second = req('/api/library/purchase-files?boothId=5197537');
  await again.handleConsoleLibraryPurchaseFiles(second.request);
  eq('10 分钟内命中缓存', second.sent[0] && second.sent[0].data.cached, true);
  eq('缓存命中不再抓页', calls.filter((c) => c.method === 'GET').length, fetchesAfterFirst);
  const third = req('/api/library/purchase-files?boothId=5197537&refresh=1');
  await again.handleConsoleLibraryPurchaseFiles(third.request);
  eq('refresh=1 强制重抓', third.sent[0] && third.sent[0].data.cached, false);
}
{
  // 本地已有 1111 → downloaded；台账里 done 的 2222 → downloaded
  const dir = path.join(libDir, '5197537');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '1111.zip'), Buffer.alloc(11, 1));
  atomicWriteJson(path.join(stateDir, 'booth-downloads.json'), { v: 1, jobs: [{ boothId: '5197537', fileName: '2222.zip', state: 'done', bytes: 22 }] });
  const api = createLibraryPurchaseFiles({ ...depsBase, fetch: makeFetch(html, sizes) });
  const one = req('/api/library/purchase-files?boothId=5197537&refresh=1');
  await api.handleConsoleLibraryPurchaseFiles(one.request);
  eq('本地文件是 downloaded', one.sent[0] && one.sent[0].data.files.map((f) => f.state), ['downloaded', 'downloaded']);
}
{
  const api = createLibraryPurchaseFiles({ ...depsBase, fetch: makeFetch(html, sizes) });
  const bad = req('/api/library/purchase-files?boothId=abc');
  await api.handleConsoleLibraryPurchaseFiles(bad.request);
  eq('非法商品号 400', bad.sent[0] && bad.sent[0].status, 400);
  const agent = req('/api/library/purchase-files?boothId=5197537', { headers: { 'x-agent-token': 'x' } });
  await api.handleConsoleLibraryPurchaseFiles(agent.request);
  eq('智能体令牌 403', agent.sent[0] && agent.sent[0].status, 403);
  const post = req('/api/library/purchase-files?boothId=5197537', { method: 'POST' });
  await api.handleConsoleLibraryPurchaseFiles(post.request);
  eq('非 GET 405', post.sent[0] && post.sent[0].status, 405);
  const other = req('/api/library/other');
  eq('别的路径不接管', await api.handleConsoleLibraryPurchaseFiles(other.request), false);
}
{
  // 暂停闸：真 booth-pause 读写同一份 state/booth-search-pause.json
  atomicWriteJson(path.join(stateDir, 'booth-search-pause.json'), {
    pausedUntil: Date.now() + 5 * 60 * 1000, reason: 'BOOTH 搜索被限速（HTTP 429）', status: 429, at: Date.now(),
  });
  const api = createLibraryPurchaseFiles({ ...depsBase, fetch: makeFetch(html, sizes) });
  const paused = req('/api/library/purchase-files?boothId=5197537&refresh=1');
  await api.handleConsoleLibraryPurchaseFiles(paused.request);
  eq('暂停中 409', paused.sent[0] && paused.sent[0].status, 409);
  eq('409 带 paused', paused.sent[0] && paused.sent[0].data.paused, true);
  fs.rmSync(path.join(stateDir, 'booth-search-pause.json'), { force: true });
}
{
  fs.rmSync(path.join(stateDir, 'booth-cookies.json'), { force: true });
  const api = createLibraryPurchaseFiles({ ...depsBase, fetch: makeFetch(html, sizes) });
  const noCookie = req('/api/library/purchase-files?boothId=5197537&refresh=1');
  await api.handleConsoleLibraryPurchaseFiles(noCookie.request);
  eq('没 Cookie 回 400 人话', noCookie.sent[0] && noCookie.sent[0].status, 400);
  check('人话提示去登录', /Cookie/.test(String(noCookie.sent[0] && noCookie.sent[0].data.error)));
  writeCookie();
}

// ══════════════════════════════════════════════════════════════════
console.log('## 一键导入 Unity 工程');
const collected = { starts: [], waited: [] };
const impDeps = {
  ...depsBase,
  cfg: { fileArchive: { usageRoots: [project] } },
  matchConfiguredUsageRoot: usageRootsPure.matchConfiguredUsageRoot,
  libraryUsageRootsPure: usageRootsPure,
  purchaseFiles: { listPurchaseFiles: async () => ({ ok: true, title: 'ゆらゆらオバケ', files: [] }) },
  downloadStart: async (boothId, url, origin, title, fileName) => { collected.starts.push({ boothId, origin, fileName }); return { ok: true, queued: true }; },
  waitDownload: async (boothId) => { collected.waited.push(boothId); return { ok: true }; },
  zipExtractPure: zipPure,
};
const imp = createLibraryImport(impDeps);
{
  const dry = req('/api/library/import-to-unity', { method: 'POST', body: { boothId: '5197537', usageRoot: project, dryRun: true } });
  await imp.handleConsoleLibraryImport(dry.request);
  eq('dryRun 200', dry.sent[0] && dry.sent[0].status, 200);
  eq('dryRun 标记', dry.sent[0] && dry.sent[0].data.dryRun, true);
  eq('dryRun 不写盘', fs.existsSync(path.join(stateDir, 'library-imports.json')), false);
  const outside = req('/api/library/import-to-unity', { method: 'POST', body: { boothId: '5197537', usageRoot: path.join(tmp, 'NotAllowed') } });
  await imp.handleConsoleLibraryImport(outside.request);
  eq('白名单外 400', outside.sent[0] && outside.sent[0].status, 400);
  check('白名单人话', /不在允许的扫描根/.test(String(outside.sent[0] && outside.sent[0].data.error)));
  const agent = req('/api/library/import-to-unity', { method: 'POST', headers: { 'x-agent-token': 'x' }, body: { boothId: '5197537', usageRoot: project } });
  await imp.handleConsoleLibraryImport(agent.request);
  eq('智能体令牌 403', agent.sent[0] && agent.sent[0].status, 403);
  const bad = req('/api/library/import-to-unity', { method: 'POST', body: { boothId: 'zz', usageRoot: project } });
  await imp.handleConsoleLibraryImport(bad.request);
  eq('非法商品号 400', bad.sent[0] && bad.sent[0].status, 400);
}

// 真导入：素材库里已有一份 zip + 一个 txt（zip 走解压、txt 走复制）
const prodDir = path.join(libDir, '5197537');
fs.mkdirSync(prodDir, { recursive: true });
const zipPath = path.join(prodDir, '5197537.zip');
fs.writeFileSync(zipPath, buildZip([{ name: 'pack/readme.txt', data: Buffer.from('hello unity', 'utf8') }]));
fs.writeFileSync(path.join(prodDir, 'extra.txt'), Buffer.from('extra', 'utf8'));
function setListed(files) {
  impDeps.purchaseFiles = {
    listPurchaseFiles: async () => ({ ok: true, title: 'ゆらゆらオバケ', files }),
  };
}
{
  collected.starts.length = 0;
  collected.waited.length = 0;
  setListed([
    { fileName: '5197537.zip', url: 'https://booth.pm/downloadables/1111', bytes: 1, state: 'downloaded' },
    { fileName: 'extra.txt', url: 'https://booth.pm/downloadables/2222', bytes: 5, state: 'downloaded' },
  ]);
  const run = req('/api/library/import-to-unity', { method: 'POST', body: { boothId: '5197537', usageRoot: project } });
  await imp.handleConsoleLibraryImport(run.request);
  const data = (run.sent[0] || {}).data || {};
  eq('导入 200 且 ok', [run.sent[0] && run.sent[0].status, data.ok], [200, true]);
  eq('目标目录 Assets/<标题>', data.destRel, 'Assets/ゆらゆらオバケ');
  check('zip 解出的 readme.txt 在工程里', fs.existsSync(path.join(project, 'Assets/ゆらゆらオバケ/pack/readme.txt')));
  check('txt 被复制进去', fs.existsSync(path.join(project, 'Assets/ゆらゆらオバケ/extra.txt')));
  check('素材库 zip 还在（keepZip）', fs.existsSync(zipPath));
  check('导入台账已写', fs.existsSync(path.join(stateDir, 'library-imports.json')));
  check('日志有一行导入记录', logs.some((line) => /\[导入工程\] #5197537/.test(line)));
  eq('没有走下载', collected.starts.length, 0);
  const again = req('/api/library/import-to-unity', { method: 'POST', body: { boothId: '5197537', usageRoot: project } });
  await imp.handleConsoleLibraryImport(again.request);
  eq('重复导入回 already', again.sent[0] && again.sent[0].data.already, true);
}

// 未下载的文件：走 downloadStart + waitDownload，桩里把文件落盘
{
  collected.starts.length = 0;
  collected.waited.length = 0;
  setListed([{ fileName: 'late.txt', url: 'https://booth.pm/downloadables/3333', bytes: 4, state: 'pending' }]);
  fs.mkdirSync(path.join(libDir, '5197538'), { recursive: true });
  impDeps.downloadStart = async (boothId, url, origin, title, fileName) => {
    collected.starts.push({ boothId, origin, fileName });
    fs.writeFileSync(path.join(libDir, '5197538', fileName), Buffer.from('late', 'utf8'));
    return { ok: true, queued: true };
  };
  const key = fs.readFileSync(path.join(stateDir, 'library-imports.json'), 'utf8');
  const run = req('/api/library/import-to-unity', { method: 'POST', body: { boothId: '5197538', usageRoot: project } });
  await imp.handleConsoleLibraryImport(run.request);
  check('先下后导入：downloadStart 收到文件名', collected.starts.some((one) => one.fileName === 'late.txt'));
  eq('downloadStart 来源 import', collected.starts[0] && collected.starts[0].origin, 'import');
  eq('等到了下载完成', collected.waited, ['5197538']);
  const data = (run.sent[0] || {}).data || {};
  check('late.txt 进了工程', fs.existsSync(path.join(project, 'Assets/ゆらゆらオバケ/late.txt')));
  check('台账随之更新', fs.readFileSync(path.join(stateDir, 'library-imports.json'), 'utf8') !== key);
}

// 文件名穿越：../../evil.txt 必须只进 errors，不写到工程外
{
  setListed([{ fileName: '../../evil.txt', url: 'https://booth.pm/downloadables/4444', bytes: 4, state: 'downloaded' }]);
  const run = req('/api/library/import-to-unity', { method: 'POST', body: { boothId: '5197539', usageRoot: project } });
  await imp.handleConsoleLibraryImport(run.request);
  const data = (run.sent[0] || {}).data || {};
  eq('穿越文件名进 errors', data.ok, false);
  check('errors 说明越界', (data.errors || []).some((one) => /越界/.test(String(one.error))));
  check('没有写到工程外', fs.existsSync(path.join(tmp, 'evil.txt')) === false);
}

// 接线回归（真机事故复盘）：路由写好了，但 handler 没进 wired 名单 / consoleRequest 没有 method getter，
// 表现是「接口 404 / 方法永远对不上」。这些不是运行时行为，只是接线，所以用源码断言锁住。
{
  const bridgeSource = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
  check("bridge.js 的 library-usage-roots import 是相对路径 './library-usage-roots.js'", /from '\.\/library-usage-roots\.js'/.test(bridgeSource) && !/from '\.\.\/library-usage-roots\.js'/.test(bridgeSource));
  // 修屎山：console handlers 现装配在 wireRuntimeConsole 里，经 ...consolePart 展开进 wired 名单，
  // 所以从 wireRuntimeConsole 起截取才能同时覆盖两个装配函数。
  const wireStart = bridgeSource.indexOf('function wireRuntimeConsole');
  const wireBody = wireStart >= 0 ? bridgeSource.slice(wireStart, wireStart + 60000) : '';
  check('wired 名单含 handleConsoleLibraryPurchaseFiles', wireBody.includes('handleConsoleLibraryPurchaseFiles'));
  check('wired 名单含 handleConsoleLibraryImport', wireBody.includes('handleConsoleLibraryImport'));
  const serverSource = fs.readFileSync(path.join(ROOT, 'src/bridge/console-server.js'), 'utf8');
  check('consoleRequest 带 method getter（否则 handler 看到 undefined）', /get method\(\)\s*\{\s*return req\.method;/.test(serverSource));
  const importSource = fs.readFileSync(path.join(ROOT, 'src/bridge/console/library-import.js'), 'utf8');
  check('library-import 复用 request.readBody({ maxBytes })', /request\.readBody\(\{\s*maxBytes:\s*512\s*\*\s*1024\s*\}\)/.test(importSource));
  check('library-import 不再自己 for-await 迭代 request', !/for await \(const \w+ of request\)/.test(importSource));
}

// ══════════════════════════════════════════════════════════════════
console.log('## 陌生号：整体 6s 超时 + 60s 负缓存 + 不完整清单不落缓存');
{
  // 挂死 fetch：整件事 6s 必须自己放弃，而不是翻 40 页拖到前端 3s 超时。
  const hangFetch = () => new Promise(() => {});
  const api = createLibraryPurchaseFiles({ ...depsBase, fetch: hangFetch });
  const startedAt = Date.now();
  const res = await api.listPurchaseFiles('6985553');
  const cost = Date.now() - startedAt;
  check('陌生号 6s 内返回（实测 ' + cost + 'ms）', cost >= 4500 && cost <= 9000, String(cost));
  eq('超时把人话讲清楚', res && res.ok, false);
  eq('超时错误文案', res && res.error, '取文件清单超时/失败（BOOTH 可能限速）');
  const negCache = JSON.parse(fs.readFileSync(path.join(stateDir, 'booth-purchase-files.json'), 'utf8'));
  check('负缓存落盘（negative:true）', negCache.items['6985553'] && negCache.items['6985553'].negative === true);

  // 60s 内同一号不再打网：换一个「会数调用」的 fetch 也应当 0 次。
  let hitCount = 0;
  const countingFetch = async () => { hitCount += 1; return { ok: true, status: 200, headers: { get: () => '' }, arrayBuffer: async () => Buffer.from('') }; };
  const api2 = createLibraryPurchaseFiles({ ...depsBase, fetch: countingFetch });
  const again = await api2.listPurchaseFiles('6985553');
  eq('负缓存命中 0 次网络', hitCount, 0);
  eq('负缓存也返回同一人话', again && again.error, '取文件清单超时/失败（BOOTH 可能限速）');
  check('负缓存带 retryAfterMs', Number(again && again.retryAfterMs) > 0, String(again && again.retryAfterMs));
  const forced = await api2.listPurchaseFiles('6985553', { refresh: true });
  eq('refresh=1 绕过负缓存', forced && forced.ok, false);   // 这个桩的页面里没有 6985553，所以还是失败，但至少打了网
  check('refresh 打了网', hitCount > 0, String(hitCount));
}
{
  // 清单不完整（HEAD 拿不到 content-length → bytes 0）：不写 10 分钟正缓存。
  const badHtml = `<html><body><div class="item"><a href="/ja/items/6999999">Bad</a>
    <div class="js-download-button" data-href="https://booth.pm/downloadables/7777777"></div></div></body></html>`;
  const callsBefore = calls.length;
  const api = createLibraryPurchaseFiles({ ...depsBase, fetch: makeFetch(badHtml, {}) });
  const first = await api.listPurchaseFiles('6999999');
  eq('不完整清单回 ok:false', first && first.ok, false);
  check('不完整时人话说清', /不完整/.test(String(first && first.error)), String(first && first.error));
  const cache = JSON.parse(fs.readFileSync(path.join(stateDir, 'booth-purchase-files.json'), 'utf8'));
  check('坏形状没写进正缓存', !cache.items['6999999'] || cache.items['6999999'].negative === true);
  const netAfterFirst = calls.length - callsBefore;
  const second = await api.listPurchaseFiles('6999999');
  eq('负缓存生效：不再抓页', calls.length - callsBefore, netAfterFirst);
  check('第二次仍回 ok:false', second && second.ok === false);
}

{
  // BOOTH 打不动时用「上次清单」兜底：6s 超时是给陌生号的，不能把已知商品打成 400。
  const cachePath = path.join(stateDir, 'booth-purchase-files.json');
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  cached.items['6985554'] = { boothId: '6985554', title: '老清单商品', files: [{ fileName: 'old.zip', url: 'https://booth.pm/downloadables/old', bytes: 123, state: 'pending' }], fetchedAt: Date.now() - 60 * 60 * 1000 };
  atomicWriteJson(cachePath, cached);
  const api = createLibraryPurchaseFiles({ ...depsBase, fetch: () => new Promise(() => {}) });
  const startedAt = Date.now();
  const res = await api.listPurchaseFiles('6985554');
  check('缓存过期 + 网络挂：6s 后回上次清单', Date.now() - startedAt <= 9000, String(Date.now() - startedAt));
  eq('兜底结果 ok', res && res.ok, true);
  eq('兜底结果标 stale', res && res.stale, true);
  eq('兜底文件还在', res && res.files && res.files[0] && res.files[0].fileName, 'old.zip');
  const negative = JSON.parse(fs.readFileSync(cachePath, 'utf8')).items['6985554'];
  check('兜底成功不写负缓存', !negative || negative.negative !== true);
  const secondStart = Date.now();
  const twice = await api.listPurchaseFiles('6985554');
  check('兜底后刷了时间戳：第二次秒回（不再等 6s）', Date.now() - secondStart < 1000, String(Date.now() - secondStart));
  eq('第二次命中缓存', twice && twice.cached, true);
}

// ══════════════════════════════════════════════════════════════════
console.log('## 下载成功后自动认号 + 补封面（autoClaimAfterDownload）');
const { contentKeyFor } = await import(pathToFileURL(path.join(ROOT, 'src/file-archive/common.js')).href);
const libraryBindsPure = await import(pathToFileURL(path.join(ROOT, 'src/library-binds.js')).href);
const libraryFindPure = await import(pathToFileURL(path.join(ROOT, 'src/library-find.js')).href);
const claimDepsBase = { ...depsBase, contentKeyFor, libraryBindsPure, libraryFindPure, Buffer, AbortSignal };
function writeLedger(items) {
  atomicWriteJson(path.join(stateDir, 'booth-purchases.json'), { v: 1, items });
}
function readBinds() {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'booth-binds.json'), 'utf8')); } catch { return { entries: {} }; }
}
{
  writeLedger({ a: { boothId: '7510001', title: '测试商品', coverUrl: 'https://booth.pximg.net/covers/7510001.jpg' } });
  const dir = path.join(libDir, '7510001');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'game.zip'), Buffer.alloc(14, 7));
  let coverHits = 0;
  const coverFetch = async () => { coverHits += 1; return { ok: true, status: 200, arrayBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) }; };
  const api = createLibraryPurchaseFiles({ ...claimDepsBase, fetch: coverFetch });
  const claimed = await api.autoClaimAfterDownload({ boothId: '7510001', fileName: 'game.zip', dirAbs: dir });
  eq('台账命中 → 自动绑定', claimed && claimed.autoBound, true);
  eq('远程封面 → 落盘', claimed && claimed.coverSaved, true);
  const binds = readBinds();
  const key = contentKeyFor('game.zip', 14);
  check('绑定键 = contentKeyFor(主件名, 字节)', Boolean(binds.entries[key]), Object.keys(binds.entries).join(','));
  eq('绑定号正确', binds.entries[key] && binds.entries[key].boothId, '7510001');
  eq('绑定来源 download-auto', binds.entries[key] && binds.entries[key].source, 'download-auto');
  eq('绑定标题来自台账', binds.entries[key] && binds.entries[key].title, '测试商品');
  check('封面文件落盘（game.thumbnail.jpg）', fs.existsSync(path.join(dir, 'game.thumbnail.jpg')));
  const again = await api.autoClaimAfterDownload({ boothId: '7510001', fileName: 'game.zip', dirAbs: dir });
  eq('幂等：第二次不再写绑定', again && again.autoBound, false);
  eq('幂等：第二次不再抓封面', coverHits, 1);
}
{
  // 人工绑定优先：已有人工条目绝不被 download-auto 覆盖。
  const dir = path.join(libDir, '7510002');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manual.zip'), Buffer.alloc(9, 1));
  const key = contentKeyFor('manual.zip', 9);
  atomicWriteJson(path.join(stateDir, 'booth-binds.json'), libraryBindsPure.setBind({}, key, '1111111', { title: '人工绑的', source: 'manual' }));
  writeLedger({ m: { boothId: '7510002', title: '新商品' } });
  const api = createLibraryPurchaseFiles({ ...claimDepsBase, fetch: async () => ({ ok: false, status: 500, arrayBuffer: async () => Buffer.from('') }) });
  const claimed = await api.autoClaimAfterDownload({ boothId: '7510002', fileName: 'manual.zip', dirAbs: dir });
  eq('人工绑定优先：不覆盖', claimed && claimed.autoBound, false);
  const binds = readBinds();
  eq('人工绑定的号没变', binds.entries[key] && binds.entries[key].boothId, '1111111');
  eq('人工绑定来源没变', binds.entries[key] && binds.entries[key].source, 'manual');
  eq('封面失败不阻塞（coverSaved:false）', claimed && claimed.coverSaved, false);
}
{
  // 台账里没有这个号：不认（用户自己下的文件不该被硬绑到别人号上）。
  const dir = path.join(libDir, '7510003');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'own.zip'), Buffer.alloc(5, 1));
  const before = readBinds();
  const api = createLibraryPurchaseFiles({ ...claimDepsBase, fetch: async () => ({ ok: false, status: 500, arrayBuffer: async () => Buffer.from('') }) });
  const claimed = await api.autoClaimAfterDownload({ boothId: '7510003', fileName: 'own.zip', dirAbs: dir });
  eq('台账没有 → 不绑', claimed && claimed.autoBound, false);
  eq('绑定表没被改', JSON.stringify(readBinds()), JSON.stringify(before));
  eq('也不抓封面', claimed && claimed.coverSaved, false);
}
{
  // 边界：空输入不炸（下载模块异常时不能把下载搞挂）。
  const api = createLibraryPurchaseFiles({ ...claimDepsBase, fetch: async () => ({ ok: false, status: 500, arrayBuffer: async () => Buffer.from('') }) });
  const claimed = await api.autoClaimAfterDownload({});
  eq('空输入回 false 不抛', claimed && claimed.autoBound === false && claimed.coverSaved === false, true);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n已购文件清单 + 导入工程：通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  for (const name of failures) console.log('  - ' + name);
  process.exitCode = 1;
}
