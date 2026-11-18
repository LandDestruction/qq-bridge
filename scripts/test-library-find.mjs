// 找号路由单测：用假 deps（假 fetch / 假指纹 / 假快照）跑通
// GET /api/library/find → POST /api/library/bind → GET /api/library/binds → POST /api/library/unbind，
// 外加「智能体令牌一律 403」和「key 不存在时给出人话」。不碰网络、不碰真库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createLibraryFind } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-find.js')).href);
// 纯规则同样走 deps 注入（桥接模块不能 import），所以测试也按 bridge.js 的口径塞进去。
const boothSearchPure = await import(pathToFileURL(path.join(ROOT, 'src/booth-search.js')).href);
const libraryBindsPure = await import(pathToFileURL(path.join(ROOT, 'src/library-binds.js')).href);
const libraryFindPure = await import(pathToFileURL(path.join(ROOT, 'src/library-find.js')).href);
const libraryBatchPure = await import(pathToFileURL(path.join(ROOT, 'src/library-batch.js')).href);
const libraryRenamePure = await import(pathToFileURL(path.join(ROOT, 'src/library-rename.js')).href);
const fixture = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/booth-search-mew.html'), 'utf8');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-find-'));
const libDir = path.join(tmp, 'lib');
const cacheDir = path.join(tmp, 'cache');
fs.mkdirSync(path.join(libDir, 'g', 'c'), { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });
fs.writeFileSync(path.join(libDir, 'g', 'c', 'thumb.png'), 'fake-png-bytes');
const localHash = '1010101010101010101010101010101010101010101010101010101010101010';

const card = { key: 'g/c/mew', title: 'Mew Hair', kind: 'avatar', dir: 'g/c', mainName: 'mew_hair.zip', thumbRel: 'g/c/thumb.png', boothId: '', boothSource: '' };
// 改名用例会往这份快照里临时加一件（真实目录在下面建），其余用例只看到 card 一件。
const snapshotAssets = [{ ...card }];
const logs = [];
const deps = {
  fs,
  path,
  STATE_DIR: tmp,
  ROOT,
  cfg: {},
  log: (m) => logs.push(String(m)),
  atomicWriteJson: (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 1)),
  fetch: async (url) => {
    if (!String(url).startsWith('https://booth.pm/ja/search/')) return { status: 404, text: async () => '' };
    return { status: 200, text: async () => fixture };
  },
  getBoothCover: async (boothId) => {
    const p = path.join(tmp, `${boothId}.jpg`);
    fs.writeFileSync(p, `cover-${boothId}`);   // 内容里带号，下面的假指纹据此区分
    return { ok: true, status: 'ok', path: p };
  },
  // 绑号后补资料走这个：断言它会写进 fetchBoothMeta，而不是再去抓一遍搜索页。
  fetchBoothMeta: async (boothId) => {
    logs.push(`[meta] ${boothId}`);
    return { status: 'ok', boothId, title: 'Night In', shop: 'Atelier', price: '¥ 300' };
  },
  // 只有 7850009 的封面指纹和本地一致：其余候选汉明距很大（封面不像）。
  dhashFromBufferAsync: async (buf) => {
    const text = String(buf);
    if (text === 'fake-png-bytes') return localHash;
    if (text === 'cover-7850009') return localHash;
    return '0000000000000000000000000000000011111111111111111111111111111111';
  },
  buildLibrarySnapshot: () => ({ assets: snapshotAssets.map((item) => ({ ...item })), summary: { total: snapshotAssets.length } }),
  fileArchiveDb: () => ({}),
  listArchive: () => [],
  fileArchiveRootDir: () => libDir,
  boothCacheDir: () => cacheDir,
  safeResolveInside: (root, rel) => path.join(root, rel),
  boothSearchPure,
  libraryBindsPure,
  libraryFindPure,
  libraryBatchPure,
  libraryRenamePure
};
const { handleConsoleLibraryFind } = createLibraryFind(deps);

function makeReq({ method = 'GET', pathname, query = {}, body = null, headers = {} } = {}) {
  const search = new URLSearchParams(query);
  let sent = null;
  return {
    req: { method, headers },
    url: { pathname, searchParams: search },
    readBody: async () => body,
    sendJson: (payload, code) => { sent = { payload, code: code || 200 }; },
    getSent: () => sent
  };
}

console.log('## 鉴权');
{
  const r = makeReq({ pathname: '/api/library/find', query: { key: 'g/c/mew' }, headers: { 'x-agent-token': 'abc' } });
  const handled = await handleConsoleLibraryFind(r);
  check('带智能体令牌 → 403 且被本路由处理', handled === true && r.getSent().code === 403);
}
console.log('## 找号');
let findPayload = null;
{
  const r = makeReq({ pathname: '/api/library/find', query: { key: 'g/c/mew' } });
  const handled = await handleConsoleLibraryFind(r);
  findPayload = r.getSent().payload;
  check('GET /api/library/find 被本路由处理', handled === true);
  check('返回候选列表', Array.isArray(findPayload.candidates) && findPayload.candidates.length >= 2, `候选 ${findPayload.candidates?.length}`);
  check('本地指纹算出来了', findPayload.localHash === localHash);
  check('封面对上的候选被排到第一并默认勾选',
    findPayload.candidates[0]?.boothId === '7850009' && findPayload.pick === '7850009' && findPayload.auto === true,
    JSON.stringify({ first: findPayload.candidates[0]?.boothId, pick: findPayload.pick, auto: findPayload.auto }));
  check('候选带封面比对张数', findPayload.coverChecked > 0);
  check('一句话说明不为空', typeof findPayload.summary === 'string' && findPayload.summary.length > 4);
  check('错误数组里没有噪声', Array.isArray(findPayload.errors) && findPayload.errors.length === 0, JSON.stringify(findPayload.errors));
}
{
  const r = makeReq({ pathname: '/api/library/find', query: { key: 'nope' } });
  await handleConsoleLibraryFind(r);
  check('库里没有这件素材 → 500 + 人话', r.getSent().code === 500 && /找不到这件素材/.test(r.getSent().payload.error));
}
{
  const r = makeReq({ pathname: '/api/library/find' });
  await handleConsoleLibraryFind(r);
  check('缺 key → 400', r.getSent().code === 400 && /缺少 key/.test(r.getSent().payload.error));
}
console.log('## 绑定与解绑');
{
  const t0 = Date.now();
  const r = makeReq({ method: 'POST', pathname: '/api/library/bind', body: { key: 'g/c/mew', boothId: '7850009', title: 'Night In' } });
  await handleConsoleLibraryFind(r);
  const elapsedMs = Date.now() - t0;
  const payload = r.getSent().payload;
  check('POST /api/library/bind 返回 ok', payload.ok === true && payload.count === 1);
  // 补资料/补封面是 fire-and-forget：绑定必须立刻回，不能等网络。
  check('绑定 2 秒内返回（抓 meta/封面不阻塞）', elapsedMs < 2000, `${elapsedMs}ms`);
  check('绑定响应不夹带 meta/封面（异步补，不在这条里）',
    !('meta' in payload) && !('cover' in payload) && !('coverUrl' in payload));
  check('绑定表落盘', fs.existsSync(path.join(tmp, 'booth-binds.json')));
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'booth-binds.json'), 'utf8'));
  check('落盘内容带号与来源', saved.entries['g/c/mew'].boothId === '7850009' && saved.entries['g/c/mew'].source === 'manual');
  check('绑定响应告诉前端 enrich 已排队', payload.enrich === 'queued');
}
console.log('## 绑定后补资料 + 补本地封面');
{
  // 补资料/补封面是 fire-and-forget：绑定必须立刻回，不能等网络。
  for (let i = 0; i < 40; i += 1) {
    if (fs.existsSync(path.join(libDir, 'g', 'c', 'mew_hair.thumbnail.jpg'))) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  check('绑号后抓了商品资料（fetchBoothMeta 被调用）', logs.some((m) => m.startsWith('[meta] 7850009')), logs.slice(-4).join(' | '));
  // 名字必须跟着主件（mew_hair.zip）走：多包同目录时 <boothId>.jpg 会被当成散图，永远进不了 thumbRel。
  check('绑号后把 BOOTH 封面落成 <主件stem>.thumbnail.jpg',
    fs.existsSync(path.join(libDir, 'g', 'c', 'mew_hair.thumbnail.jpg')),
    fs.readdirSync(path.join(libDir, 'g', 'c')).join(','));
  check('补封面不再用裸 <boothId>.jpg（那样配不上件）',
    !fs.existsSync(path.join(libDir, 'g', 'c', '7850009.jpg')));
  check('补封面日志写了相对路径', logs.some((m) => m.includes('绑号后补封面：g/c/mew_hair.thumbnail.jpg')), logs.slice(-4).join(' | '));
  // 复跑一次不该重复抓（文件已在就不动）：这条只验证日志里不出现第二次补封面
  const coverLogsBefore = logs.filter((m) => m.includes('绑号后补封面：')).length;
  const again = makeReq({ method: 'POST', pathname: '/api/library/bind', body: { key: 'g/c/mew', boothId: '7850009', title: 'Night In' } });
  await handleConsoleLibraryFind(again);
  await new Promise((res) => setTimeout(res, 60));
  check('已经补过的封面不重复写', logs.filter((m) => m.includes('绑号后补封面：')).length === coverLogsBefore);
}
{
  const r = makeReq({ pathname: '/api/library/binds' });
  await handleConsoleLibraryFind(r);
  check('GET /api/library/binds 读回一条', r.getSent().payload.count === 1 && r.getSent().payload.table.entries['g/c/mew'].boothId === '7850009');
}
{
  const r = makeReq({ method: 'POST', pathname: '/api/library/bind', body: { key: 'g/c/mew', boothId: '12' } });
  await handleConsoleLibraryFind(r);
  check('非法 BOOTH 号 → 400', r.getSent().code === 400 && /5~9 位数字/.test(r.getSent().payload.error));
}
{
  const r = makeReq({ method: 'POST', pathname: '/api/library/unbind', body: { key: 'g/c/mew' } });
  await handleConsoleLibraryFind(r);
  check('POST /api/library/unbind 删掉绑定', r.getSent().payload.ok === true && r.getSent().payload.count === 0);
}
console.log('## 批量找号');
{
  // 这一轮先看空状态
  let r = makeReq({ pathname: '/api/library/batchfind' });
  await handleConsoleLibraryFind(r);
  check('GET /api/library/batchfind 回进度', r.getSent().payload.ok === true && typeof r.getSent().payload.text === 'string');

  // 起一轮：只给一个 key（假 fetch 回 fixture、假指纹和本地一致 → 应该找到 7850009）
  r = makeReq({ method: 'POST', pathname: '/api/library/batchfind', body: { keys: ['g/c/mew'] } });
  await handleConsoleLibraryFind(r);
  const started = r.getSent().payload;
  check('POST 起批量任务', started.ok === true && started.queued === 1);

  // 等后台跑完（任务里每一步都写盘，最多等 3 秒）
  let state = null;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((res) => setTimeout(res, 50));
    const file = path.join(tmp, 'booth-batchfind.json');
    if (!fs.existsSync(file)) continue;
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state && state.entries && state.entries['g/c/mew']) break;
  }
  check('结果落到 state/booth-batchfind.json', Boolean(state && state.entries && state.entries['g/c/mew']));
  check('批量结果记住了候选号', state && state.entries['g/c/mew'].pick === '7850009', JSON.stringify(state && state.entries && state.entries['g/c/mew']));
  check('批量结果带分数', state && state.entries['g/c/mew'].score > 0);

  r = makeReq({ pathname: '/api/library/batchfind' });
  await handleConsoleLibraryFind(r);
  const after = r.getSent().payload;
  check('进度里能看到 1 件有候选', after.progress.total >= 1 && after.progress.withPick >= 1, JSON.stringify(after.progress));

  // 没有待找的素材时，再起一轮应该是 0 件
  r = makeReq({ method: 'POST', pathname: '/api/library/batchfind', body: {} });
  await handleConsoleLibraryFind(r);
  check('没有待找素材时回 queued:0', r.getSent().payload.queued === 0, JSON.stringify(r.getSent().payload));

  // 清空
  r = makeReq({ method: 'POST', pathname: '/api/library/batchfind/clear', body: {} });
  await handleConsoleLibraryFind(r);
  const cleared = JSON.parse(fs.readFileSync(path.join(tmp, 'booth-batchfind.json'), 'utf8'));
  check('clear 把记录清空', Object.keys(cleared.entries || {}).length === 0);
}

console.log('## 搜索保护闸（纯规则）');
{
  const { searchPauseFor, normalizeSearchPause, searchPauseState, describeSearchPause } = libraryFindPure;
  check('429 带 Retry-After 按秒数停', searchPauseFor({ status: 429, retryAfter: 60 })?.pauseMs === 60000);
  check('429 没给 Retry-After 停 10 分钟', searchPauseFor({ status: 429 })?.pauseMs === 10 * 60 * 1000);
  check('403 停 30 分钟', searchPauseFor({ status: 403 })?.pauseMs === 30 * 60 * 1000);
  check('500 不触发暂停', searchPauseFor({ status: 500 }) === null);
  check('Retry-After 再大也夹到 6 小时上限', searchPauseFor({ status: 429, retryAfter: 999999 })?.pauseMs === 6 * 60 * 60 * 1000);
  check('Retry-After 太小时抬到 1 分钟下限', searchPauseFor({ status: 429, retryAfter: 1 })?.pauseMs === 60000);
  const now = Date.now();
  check('坏值当没暂停（脏文件不锁死找号）', searchPauseState(normalizeSearchPause('garbage'), now).paused === false);
  const st = searchPauseState({ pausedUntil: now + 120000, reason: '被限速' }, now);
  check('暂停中剩余时间算对', st.paused === true && st.remainingMs > 110000 && st.remainingMs <= 120000);
  check('过期后自动恢复', searchPauseState({ pausedUntil: now - 1000 }, now).paused === false);
  check('人话里有等待时间', /分钟/.test(describeSearchPause({ pausedUntil: now + 120000, reason: '被限速' }, now)));
  check('没暂停时人话为空', describeSearchPause({ pausedUntil: 0 }, now) === '');
}

console.log('## 搜索保护闸（路由）');
{
  const pauseTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-find-pause-'));
  let fetchCalls = 0;
  let fetchMode = 'ok';
  const depsPause = {
    ...deps,
    STATE_DIR: pauseTmp,
    fetch: async () => {
      fetchCalls += 1;
      const header = (name) => (fetchMode === '429' && String(name).toLowerCase() === 'retry-after' ? '60' : null);
      if (fetchMode === '429') return { status: 429, headers: { get: header }, text: async () => '' };
      if (fetchMode === '403') return { status: 403, headers: { get: header }, text: async () => '' };
      return { status: 200, headers: { get: header }, text: async () => fixture };
    }
  };
  const { handleConsoleLibraryFind: handlePause } = createLibraryFind(depsPause);

  // 保护闸只在 429/403 生效：正常 200 不能留下暂停文件，也不能让结果带 paused。
  const normalReq = makeReq({ pathname: '/api/library/find', query: { key: 'g/c/mew', fresh: '1' } });
  await handlePause(normalReq);
  const normalPayload = normalReq.getSent().payload;
  check('正常找号成功且不写暂停文件',
    normalPayload.ok === true && !fs.existsSync(path.join(pauseTmp, 'booth-search-pause.json')),
    logs.slice(-2).join(' | '));
  check('正常找号结果不带 paused 标记', !('paused' in normalPayload) || normalPayload.paused === false);
  const normalCalls = fetchCalls;

  fetchMode = '429';
  let r = makeReq({ pathname: '/api/library/find', query: { key: 'g/c/mew', fresh: '1' } });
  await handlePause(r);
  let payload = r.getSent().payload;
  check('429 → 找号返回 paused 而不是「搜不到」', payload.paused === true && payload.ok === false);
  check('429 → error 说被限速', /限速/.test(String(payload.error)), String(payload.error));
  check('429 → 第一个搜索词就停（不再打第二个）', fetchCalls === normalCalls + 1, `fetch ${fetchCalls} 次（正常那轮用了 ${normalCalls}）`);
  const pauseFile = path.join(pauseTmp, 'booth-search-pause.json');
  check('暂停状态落盘', fs.existsSync(pauseFile));
  const savedPause = JSON.parse(fs.readFileSync(pauseFile, 'utf8'));
  check('落盘带 pausedUntil（Retry-After 60s）与原因', savedPause.pausedUntil > Date.now() + 30000 && /限速/.test(savedPause.reason));

  const callsBefore = fetchCalls;
  r = makeReq({ pathname: '/api/library/find', query: { key: 'g/c/mew', fresh: '1' } });
  await handlePause(r);
  payload = r.getSent().payload;
  check('暂停中再点找号 → 直接回人话、零请求', payload.paused === true && fetchCalls === callsBefore, `fetch ${fetchCalls} 次`);
  check('暂停中结果带 retryAfterMs', payload.retryAfterMs > 0);

  r = makeReq({ pathname: '/api/library/search-pause' });
  await handlePause(r);
  payload = r.getSent().payload;
  check('GET /api/library/search-pause 报暂停与剩余时间', payload.ok === true && payload.paused === true && payload.remainingMs > 0);
  // at = 这次暂停从何时开始：前端要显示「已暂停 N 分钟」，只靠 remainingMs 算不出来。
  check('GET /api/library/search-pause 带暂停开始时间 at', payload.at > 0 && payload.at <= Date.now(), String(payload.at));
  check('暂停人话里有分钟', /分钟/.test(String(payload.text)));

  r = makeReq({ method: 'POST', pathname: '/api/library/batchfind', body: { keys: ['g/c/mew'] } });
  await handlePause(r);
  payload = r.getSent().payload;
  check('暂停中不许开新批量任务（409 + paused）', r.getSent().code === 409 && payload.paused === true && payload.ok === false);
  check('被拒的批量任务没发请求', fetchCalls === callsBefore, `fetch ${fetchCalls} 次`);

  r = makeReq({ method: 'PUT', pathname: '/api/library/search-pause' });
  await handlePause(r);
  check('search-pause 只收 GET/POST', r.getSent().code === 405);

  r = makeReq({ method: 'POST', pathname: '/api/library/search-pause', body: {} });
  await handlePause(r);
  payload = r.getSent().payload;
  check('POST /api/library/search-pause 手动解除', payload.ok === true && payload.cleared === true && payload.paused === false);

  fetchMode = 'ok';
  r = makeReq({ pathname: '/api/library/find', query: { key: 'g/c/mew', fresh: '1' } });
  await handlePause(r);
  payload = r.getSent().payload;
  check('解除后能正常找号', payload.ok === true && Array.isArray(payload.candidates) && payload.candidates.length >= 2, JSON.stringify({ ok: payload.ok, n: payload.candidates?.length }));

  fetchMode = '403';
  r = makeReq({ pathname: '/api/library/find', query: { key: 'g/c/mew', fresh: '1' } });
  await handlePause(r);
  payload = r.getSent().payload;
  check('403 → 也落暂停且停更久（≥20 分钟）', payload.paused === true && payload.retryAfterMs > 20 * 60 * 1000, String(payload.error));
  check('403 的 error 说被拒绝', /拒绝/.test(String(payload.error)), String(payload.error));

  fs.rmSync(pauseTmp, { recursive: true, force: true });
}

console.log('## 补封面与失败码（纯规则）');
{
  const {
    coverFileNameFor, coverPlan, FIND_FAILURE_CODES, failureCodeOf,
    SEARCH_PAUSE_429_MS, normalizeSearchPause, searchPauseState
  } = libraryFindPure;
  const { BATCH_FAILURE_CODES, normalizeBatchState, markBatchEntry, batchProgress } = libraryBatchPure;

  check('封面文件名跟着主件名走（多包目录才配得上）', coverFileNameFor('1234567', 'Night In.zip') === 'Night In.thumbnail.jpg');
  check('没有主件名时退回 <boothId>.jpg', coverFileNameFor('1234567') === '1234567.jpg' && coverFileNameFor('1234567', '') === '1234567.jpg');
  check('主件带路径/多级扩展也只取文件名', coverFileNameFor('1234567', 'g/c/Night In.ZIP') === 'Night In.thumbnail.jpg');
  check('非法 BOOTH 号没有封面文件名', coverFileNameFor('abc') === '' && coverFileNameFor('') === '' && coverFileNameFor('123') === '');
  check('coverPlan 给出素材目录内的相对路径', (() => {
    const p = coverPlan({ boothId: '1234567', dir: 'g/c', mainName: 'Night In.zip' });
    return p && p.fileName === 'Night In.thumbnail.jpg' && p.relPath === 'g/c/Night In.thumbnail.jpg';
  })());
  check('coverPlan 容忍反斜杠与首尾斜杠', (() => {
    const p = coverPlan({ boothId: '1234567', dir: '\\g\\c\\', mainName: 'Night In.zip' });
    return p && p.relPath === 'g/c/Night In.thumbnail.jpg';
  })());
  check('coverPlan 在根目录素材上只给文件名', (() => {
    const p = coverPlan({ boothId: '1234567', dir: '', mainName: 'Night In.zip' });
    return p && p.relPath === 'Night In.thumbnail.jpg';
  })());
  check('已有同名封面 → coverPlan 返回 null（不覆盖用户文件）', coverPlan({ boothId: '1234567', dir: 'g/c', exists: true, mainName: 'Night In.zip' }) === null);
  check('非法号 → coverPlan 返回 null', coverPlan({ boothId: 'x', dir: 'g/c', mainName: 'Night In.zip' }) === null);

  check('两份失败码白名单同值', JSON.stringify(FIND_FAILURE_CODES) === JSON.stringify(BATCH_FAILURE_CODES), JSON.stringify(FIND_FAILURE_CODES));
  check('失败码：暂停 → rate_limit', failureCodeOf({ paused: true, candidates: 3, errors: ['超时'] }) === 'rate_limit');
  check('失败码：超时 → timeout', failureCodeOf({ candidates: 2, errors: ['等待搜索页超时'] }) === 'timeout');
  check('失败码：没候选 → no_candidates', failureCodeOf({ candidates: 0, errors: [] }) === 'no_candidates');
  check('失败码：其它错误 → 空（不瞎猜）', failureCodeOf({ candidates: 3, errors: ['搜索页 HTTP 500'] }) === '');

  // 旧文件没有 reasonCode：读得进来、给空串、条目不丢。
  const old = normalizeBatchState({ entries: { k1: { pick: '', skipped: true, reason: '没找到', candidates: 0 } } });
  check('旧批量状态没有 reasonCode 也能读', old.entries.k1 && old.entries.k1.reasonCode === '' && old.entries.k1.skipped === true);
  check('写进去的 reasonCode 只收白名单', markBatchEntry({}, 'k2', { pick: '', reasonCode: 'wat', candidates: 0 }).entries.k2.reasonCode === '');
  check('合法 reasonCode 落库', markBatchEntry({}, 'k3', { pick: '', reasonCode: 'no_candidates', candidates: 0 }).entries.k3.reasonCode === 'no_candidates');
  check('reasonCode 不影响进度统计', batchProgress(markBatchEntry({}, 'k4', { pick: '', reasonCode: 'timeout', candidates: 0 })).skipped === 1);
  // 暂停信息与 coverPlan 无关，但顺手确认暂停规则没被这轮改动带坏
  check('暂停纯规则仍可用', normalizeSearchPause(null).pausedUntil === 0 && searchPauseState(null, Date.now()).paused === false && SEARCH_PAUSE_429_MS > 0);
}

console.log('## 素材卡列表：默认上限与 truncated');
{
  // 用真实扫描（临时目录里放 3 个素材目录），只造假 db / 假封面缓存。
  const { createLibraryView } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-view.js')).href);
  const { buildLibrarySnapshot: realBuildSnapshot } = await import(pathToFileURL(path.join(ROOT, 'src/library-scan.js')).href);
  const viewTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-view-'));
  const viewLib = path.join(viewTmp, 'lib');
  const viewCache = path.join(viewTmp, 'cache');
  for (const name of ['a', 'b', 'c']) {
    fs.mkdirSync(path.join(viewLib, 'g', 'c', name), { recursive: true });
    fs.writeFileSync(path.join(viewLib, 'g', 'c', name, `${name}.zip`), 'zip');
  }
  fs.mkdirSync(viewCache, { recursive: true });
  const view = createLibraryView({
    fs, path, STATE_DIR: viewTmp, ROOT,
    fileArchiveRootDir: () => viewLib,
    boothCacheDir: () => viewCache,
    fileArchiveDb: () => ({}),
    listArchive: () => [],
    buildLibrarySnapshot: realBuildSnapshot,
    getBoothCoverPath: () => '',
    safeResolveInside: (root, rel) => path.join(root, rel),
    spawn: () => ({ unref() {} }),
    log: () => {},
    libraryNotes: {}
  });
  function viewReq(pathname, query = '') {
    let sent = null;
    return {
      req: { method: 'GET', headers: {} },
      url: new URL(`http://x${pathname}${query}`),
      sendJson: (payload, code) => { sent = { payload, code: code || 200 }; },
      getSent: () => sent
    };
  }
  const all = viewReq('/api/library/assets', '?fresh=1');
  await view.handleLibraryAssetsRoute(all);
  const allPayload = all.getSent().payload;
  check('默认 limit = 500（超过 120 件不再静默截断）', allPayload.limit === 500, String(allPayload.limit));
  check('默认返回全部 3 件，truncated=false', allPayload.assets.length === 3 && allPayload.total === 3 && allPayload.truncated === false, JSON.stringify({ n: allPayload.assets.length, total: allPayload.total }));
  check('count = 本页条数、bytes 仍是全量统计', allPayload.count === 3 && typeof allPayload.bytes === 'number');

  const cut = viewReq('/api/library/assets', '?fresh=1&limit=2');
  await view.handleLibraryAssetsRoute(cut);
  const cutPayload = cut.getSent().payload;
  check('显式 limit=2 → 只回 2 件但 total 仍是 3', cutPayload.assets.length === 2 && cutPayload.total === 3);
  check('被截断时 truncated=true', cutPayload.truncated === true);

  fs.rmSync(viewTmp, { recursive: true, force: true });
}

console.log('## 手动绑定后：指纹从空变成有值（coverChecked/localHash 的变化链路）');
{
  // 这一组回答「手动 bind 到底有没有把资料/封面补齐」：用真实扫描（临时目录里放一个多包目录），
  // 只造假网络/假指纹。断言的是因果链：绑定 → 封面落进件里 → 重扫 thumbRel 有值 → 本地指纹算得出。
  const { buildLibrarySnapshot: realBuildSnapshot } = await import(pathToFileURL(path.join(ROOT, 'src/library-scan.js')).href);
  const enTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-enrich-'));
  const enLib = path.join(enTmp, 'lib');
  const enCache = path.join(enTmp, 'cache');
  // 多包目录（两个 zip）：裸 <boothId>.jpg 在这里会被当成散图，正是上一轮踩的坑。
  fs.mkdirSync(path.join(enLib, 'g2', 'c2'), { recursive: true });
  fs.writeFileSync(path.join(enLib, 'g2', 'c2', 'Mew Hair.zip'), 'zip-1');
  fs.writeFileSync(path.join(enLib, 'g2', 'c2', 'Another Pack.zip'), 'zip-2');
  fs.mkdirSync(enCache, { recursive: true });

  const enLogs = [];
  const enDeps = {
    fs, path, STATE_DIR: enTmp, ROOT,
    log: (m) => enLogs.push(String(m)),
    atomicWriteJson: (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 1)),
    fetch: async (url) => {
      if (!String(url).startsWith('https://booth.pm/ja/search/')) return { status: 404, text: async () => '' };
      return { status: 200, text: async () => fixture };
    },
    getBoothCover: async (boothId) => {
      const p = path.join(enTmp, `${boothId}.jpg`);
      fs.writeFileSync(p, `cover-${boothId}`);
      return { ok: true, status: 'ok', path: p };
    },
    fetchBoothMeta: async (boothId) => ({ status: 'ok', boothId, title: 'Night In', shop: 'Atelier' }),
    dhashFromBufferAsync: async (buf) => String(buf) === 'cover-7850009' ? localHash : '0000000000000000000000000000000011111111111111111111111111111111',
    buildLibrarySnapshot: realBuildSnapshot,
    fileArchiveDb: () => ({}),
    listArchive: () => [],
    fileArchiveRootDir: () => enLib,
    boothCacheDir: () => enCache,
    safeResolveInside: (root, rel) => path.join(root, rel),
    boothSearchPure, libraryBindsPure, libraryFindPure, libraryBatchPure
  };
  const enFind = createLibraryFind(enDeps);
  const key = realBuildSnapshot({ fs, rootDir: enLib, rows: [] }).assets[0].key;
  const mainName = realBuildSnapshot({ fs, rootDir: enLib, rows: [] }).assets[0].mainName;
  check('真实扫描认出这件素材（多包目录里主件名是 zip）', Boolean(key) && /\.zip$/.test(String(mainName)), String(mainName));

  const before = makeReq({ pathname: '/api/library/find', query: { key, fresh: '1' } });
  await enFind.handleConsoleLibraryFind(before);
  const beforePayload = before.getSent().payload;
  check('绑定前：本地没有封面指纹（localHash 空）', beforePayload.localHash === '', String(beforePayload.localHash));
  check('绑定前：coverChecked=0（没本地图可比）', beforePayload.coverChecked === 0, String(beforePayload.coverChecked));
  const beforeScore = Number(beforePayload.candidates?.[0]?.score) || 0;

  const bindReq = makeReq({ method: 'POST', pathname: '/api/library/bind', body: { key, boothId: '7850009', title: 'Night In' } });
  await enFind.handleConsoleLibraryFind(bindReq);
  check('手动 bind 返回 ok 且 enrich 排队', bindReq.getSent().payload?.ok === true && bindReq.getSent().payload?.enrich === 'queued');

  // 封面文件名必须跟这件素材的主件走（同一目录里还有别的包，配错了就永远进不了 thumbRel）。
  const stem = String(mainName).replace(/\.[^.]+$/, '');
  const coverAbs = path.join(enLib, 'g2', 'c2', `${stem}.thumbnail.jpg`);
  for (let i = 0; i < 60; i += 1) {
    if (fs.existsSync(coverAbs)) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  check('手动 bind 后封面落成 <主件stem>.thumbnail.jpg', fs.existsSync(coverAbs),
    fs.readdirSync(path.join(enLib, 'g2', 'c2')).join(','));
  const rescan = realBuildSnapshot({ fs, rootDir: enLib, rows: [] });
  const rescanCard = rescan.assets.find((a) => String(a.key) === String(key));
  check('重扫后 thumbRel 指向新封面（多包目录也没被当散图）',
    Boolean(rescanCard?.thumbRel) && String(rescanCard.thumbRel).endsWith('.thumbnail.jpg'),
    JSON.stringify({ thumbRel: rescanCard?.thumbRel, previews: rescanCard?.previews?.length }));

  const after = makeReq({ pathname: '/api/library/find', query: { key, fresh: '1' } });
  await enFind.handleConsoleLibraryFind(after);
  const afterPayload = after.getSent().payload;
  check('绑定后：localHash 从空变成有值', afterPayload.localHash === localHash, String(afterPayload.localHash).slice(0, 16));
  check('绑定后：coverChecked>0（开始逐张比封面）', afterPayload.coverChecked > 0, String(afterPayload.coverChecked));
  check('绑定后：top1 分数比绑定前高', Number(afterPayload.candidates?.[0]?.score) > beforeScore,
    `${beforeScore} → ${afterPayload.candidates?.[0]?.score}`);
  check('绑定后：排第一的就是刚绑的号且封面一致',
    afterPayload.candidates?.[0]?.boothId === '7850009' && afterPayload.candidates?.[0]?.coverMatch === true);

  fs.rmSync(enTmp, { recursive: true, force: true });
}

console.log('## 改名（preview / dryRun / 执行 / 撤销）');
{
  // 真建一套目录：改名是唯一「真动磁盘」的接口，假路径验不出来。
  const renameDir = path.join(libDir, 'R', 'rename-a');
  fs.mkdirSync(renameDir, { recursive: true });
  fs.writeFileSync(path.join(renameDir, 'Mew Hair.zip'), 'zip-bytes');
  const oldDir = path.join(libDir, 'R', 'rename-a');
  const newDir = path.join(libDir, 'R', 'Endless Comfort');
  const newFile = path.join(newDir, 'Endless Comfort.zip');
  const renameLogFile = path.join(tmp, 'booth-renames.json');
  snapshotAssets.push({
    key: 'R/rename-a', title: 'Mew Hair', dir: 'R/rename-a', mainName: 'Mew Hair.zip',
    thumbRel: '', previews: [], boothId: '', boothSource: '', boundTitle: 'Endless Comfort'
  });

  const preview = makeReq({ method: 'POST', pathname: '/api/library/rename/preview', body: { key: 'R/rename-a' } });
  await handleConsoleLibraryFind(preview);
  const planPayload = preview.getSent().payload;
  check('preview 返回计划（name 省略时回落 boundTitle）',
    planPayload.ok === true && planPayload.plan?.to?.dir === 'R/Endless Comfort', JSON.stringify(planPayload.plan?.to));
  check('preview 给出两条 move（先文件后目录）',
    planPayload.plan?.moves?.length === 2 && planPayload.plan.moves[0].to.endsWith('Endless Comfort.zip'));
  check('preview 不改盘', fs.existsSync(oldDir) && !fs.existsSync(newDir));
  check('preview 不写改名日志', !fs.existsSync(renameLogFile));

  const noKey = makeReq({ method: 'POST', pathname: '/api/library/rename/preview', body: {} });
  await handleConsoleLibraryFind(noKey);
  check('缺 key → 400', noKey.getSent().code === 400 && /缺少 key/.test(noKey.getSent().payload.error));

  const getRename = makeReq({ method: 'GET', pathname: '/api/library/rename/preview' });
  await handleConsoleLibraryFind(getRename);
  check('GET 改名接口 → 405', getRename.getSent().code === 405);

  const missing = makeReq({ method: 'POST', pathname: '/api/library/rename/preview', body: { key: 'R/nope' } });
  await handleConsoleLibraryFind(missing);
  check('库里没有这件素材 → 404 + 人话', missing.getSent().code === 404 && /没有这件素材/.test(missing.getSent().payload.error));

  // 最短长度已放宽到 2（Mew/Shiro 这种正常短名不该被挡），所以「太短」只剩 1 个字符这一档。
  const short = makeReq({ method: 'POST', pathname: '/api/library/rename', body: { key: 'R/rename-a', name: '喵' } });
  await handleConsoleLibraryFind(short);
  check('名字太短（1 个字）→ 409 且带理由', short.getSent().code === 409 && /太短/.test(short.getSent().payload.error));
  check('被拒的改名没动盘', fs.existsSync(oldDir) && !fs.existsSync(newDir));

  // 手工绑定表是按 contentKey 存的，改名会换 key：先在旧 key 上绑一个号，
  // 改完名要能迁到新 key（否则「改个名素材就不认号了」），撤销再迁回来。
  const bindsFile = path.join(tmp, 'booth-binds.json');
  fs.writeFileSync(bindsFile, JSON.stringify({
    version: 1,
    entries: { 'R/rename-a': { boothId: '7850009', title: 'Mew Hair', source: 'manual', at: 1 } }
  }));

  // 收藏也按 contentKey 存：改名不迁移的话，用户「星星」会跟着旧 key 一起消失。
  const favFile = path.join(tmp, 'booth-favorites.json');
  fs.writeFileSync(favFile, JSON.stringify({ version: 1, entries: { 'R/rename-a': { at: 3 } } }));
  // 手动分类/标签也按 contentKey 存：同一场景一起验迁移。
  fs.writeFileSync(path.join(tmp, 'library-manual-meta.json'), JSON.stringify({
    version: 1,
    items: { 'R/rename-a': { tags: ['测试'], category: '衣装', note: '', updatedAt: 4 } }
  }));

  const dry = makeReq({ method: 'POST', pathname: '/api/library/rename', body: { key: 'R/rename-a', dryRun: true } });
  await handleConsoleLibraryFind(dry);
  check('dryRun 只回计划、不改盘', dry.getSent().payload.dryRun === true && fs.existsSync(oldDir) && !fs.existsSync(newDir));

  const applied = makeReq({ method: 'POST', pathname: '/api/library/rename', body: { key: 'R/rename-a' } });
  await handleConsoleLibraryFind(applied);
  const appliedPayload = applied.getSent().payload;
  check('真执行成功', appliedPayload.ok === true && appliedPayload.renamed?.length === 2, JSON.stringify(appliedPayload.error));
  check('磁盘上新旧对调（目录与主包都改了）',
    !fs.existsSync(oldDir) && fs.existsSync(newDir) && fs.existsSync(newFile));
  check('写进 state/booth-renames.json',
    fs.existsSync(renameLogFile) && fs.readFileSync(renameLogFile, 'utf8').includes('R/rename-a'));

  // Bug 1/2 回归：响应必须带 newKey；绑定要迁到 newKey，旧 key 上不能再有。
  const newKey = String(appliedPayload.newKey || '');
  check('执行结果带 newKey（切面：前端撤销要用它）', /^[0-9a-f]{8,}$/.test(newKey), newKey);
  const bindsAfter = JSON.parse(fs.readFileSync(bindsFile, 'utf8'));
  check('改名后：手动绑定迁到新 key、旧 key 清掉',
    bindsAfter.entries?.[newKey]?.boothId === '7850009' && !bindsAfter.entries?.['R/rename-a'],
    JSON.stringify(bindsAfter.entries));
  check('响应标记 bindMigrated', appliedPayload.bindMigrated === true);

  // 收藏随改名迁移（与绑定同一调用点）：旧 key 消失、新 key 上有星星。
  const favAfter = JSON.parse(fs.readFileSync(favFile, 'utf8'));
  check('改名后：收藏迁到新 key、旧 key 清掉',
    favAfter.entries?.[newKey]?.at === 3 && !favAfter.entries?.['R/rename-a'],
    JSON.stringify(favAfter.entries));
  check('响应标记 favoritesMigrated', appliedPayload.favoritesMigrated === true);

  // 手动标签/分类同样按 contentKey 存：改名不迁移，用户刚纠正的分类会静默回退（最气人的一种丢失）。
  const manualMetaFile = path.join(tmp, 'library-manual-meta.json');
  const manualAfter = JSON.parse(fs.readFileSync(manualMetaFile, 'utf8'));
  check('改名后：手动标签/分类迁到新 key、旧 key 清掉',
    manualAfter.items?.[newKey]?.category === '衣装' && !manualAfter.items?.['R/rename-a'],
    JSON.stringify(manualAfter.items));
  check('响应标记 manualMetaMigrated', appliedPayload.manualMetaMigrated === true);

  const again = makeReq({ method: 'POST', pathname: '/api/library/rename/preview', body: { key: 'R/rename-a' } });
  await handleConsoleLibraryFind(again);
  const againPayload = again.getSent().payload;
  check('再 preview：目标已存在 → ok:false + reason',
    againPayload.ok === false && /目标已存在/.test(againPayload.reason || ''), JSON.stringify(againPayload.reason));

  // 真机翻车点：卡片改名后 key 变了，前端拿的是**新** key，只按旧 key 找必然找不到。
  const undo = makeReq({ method: 'POST', pathname: '/api/library/rename/undo', body: { key: newKey } });
  await handleConsoleLibraryFind(undo);
  check('用新 key 也能撤销（Bug 1）', undo.getSent().payload.ok === true, JSON.stringify(undo.getSent().payload.error));
  const bindsBack = JSON.parse(fs.readFileSync(bindsFile, 'utf8'));
  check('撤销后：绑定迁回旧 key（Bug 2）',
    bindsBack.entries?.['R/rename-a']?.boothId === '7850009' && !bindsBack.entries?.[newKey],
    JSON.stringify(bindsBack.entries));
  const manualBack = JSON.parse(fs.readFileSync(manualMetaFile, 'utf8'));
  check('撤销后：手动分类迁回旧 key',
    manualBack.items?.['R/rename-a']?.category === '衣装' && !manualBack.items?.[newKey],
    JSON.stringify(manualBack.items));
  check('撤销后目录与主包都回到原名',
    fs.existsSync(oldDir) && fs.existsSync(path.join(oldDir, 'Mew Hair.zip')) && !fs.existsSync(newDir));
  const favBack = JSON.parse(fs.readFileSync(favFile, 'utf8'));
  check('撤销后：收藏迁回旧 key',
    favBack.entries?.['R/rename-a']?.at === 3 && !favBack.entries?.[newKey],
    JSON.stringify(favBack.entries));
  const logAfter = JSON.parse(fs.readFileSync(renameLogFile, 'utf8'));
  check('撤销后日志里这条记录被移除', !logAfter.entries['R/rename-a']);

  const undoAgain = makeReq({ method: 'POST', pathname: '/api/library/rename/undo', body: { key: 'R/rename-a' } });
  await handleConsoleLibraryFind(undoAgain);
  check('没有记录时撤销 → 409 + 人话', undoAgain.getSent().code === 409 && /没有改名记录/.test(undoAgain.getSent().payload.error));

  const agent = makeReq({ method: 'POST', pathname: '/api/library/rename', body: { key: 'R/rename-a' }, headers: { 'x-agent-token': 'abc' } });
  const agentHandled = await handleConsoleLibraryFind(agent);
  check('智能体令牌 → 403（预览也一样）', agentHandled === true && agent.getSent().code === 403);
  const agentPreview = makeReq({ method: 'POST', pathname: '/api/library/rename/preview', body: { key: 'R/rename-a' }, headers: { 'x-agent-call': '1' } });
  await handleConsoleLibraryFind(agentPreview);
  check('智能体预览 → 403', agentPreview.getSent().code === 403);

  snapshotAssets.pop();
}

console.log('## 改名保住 BOOTH 号 + 撤销响应结构');
{
  const numOld = path.join(libDir, 'R', 'num-a');
  fs.mkdirSync(numOld, { recursive: true });
  fs.writeFileSync(path.join(numOld, 'Mew.zip'), 'zip-bytes');
  snapshotAssets.push({
    key: 'R/num-a', title: 'Astraea', dir: 'R/num-a', mainName: 'Mew.zip',
    thumbRel: '', previews: [], boothId: '271777', boothSource: 'bind', boundTitle: ''
  });

  const preview = makeReq({ method: 'POST', pathname: '/api/library/rename/preview', body: { key: 'R/num-a', name: 'Astraea_Milltina_v1.1' } });
  await handleConsoleLibraryFind(preview);
  const payload = preview.getSent().payload;
  check('不带号的名字自动补号前缀（prefixed 上浮到顶层）',
    payload.plan?.prefixed === true && payload.prefixed === true && payload.plan?.to?.dir === 'R/271777_Astraea_Milltina_v1.1',
    JSON.stringify(payload.plan?.to));

  const applied = makeReq({ method: 'POST', pathname: '/api/library/rename', body: { key: 'R/num-a', name: 'Astraea_Milltina_v1.1' } });
  await handleConsoleLibraryFind(applied);
  const done = applied.getSent().payload;
  check('执行成功且名字带号', done.ok === true && done.plan?.to?.dir === 'R/271777_Astraea_Milltina_v1.1', JSON.stringify(done.error));

  const undo = makeReq({ method: 'POST', pathname: '/api/library/rename/undo', body: { key: done.newKey } });
  await handleConsoleLibraryFind(undo);
  const undone = undo.getSent().payload;
  check('撤销成功（用新 key）', undone.ok === true, JSON.stringify(undone.error));
  check('撤销响应给 restored 路径列表（前端能直接刷新）',
    Array.isArray(undone.restored) && undone.restored.includes('R/num-a/Mew.zip') && undone.restored.includes('R/num-a'),
    JSON.stringify(undone.restored));
  check('撤销响应给 restoredDir / restoredMainName',
    undone.restoredDir === 'R/num-a' && undone.restoredMainName === 'Mew.zip',
    JSON.stringify({ dir: undone.restoredDir, main: undone.restoredMainName }));
  check('磁盘真的回到原名', fs.existsSync(path.join(numOld, 'Mew.zip')) && !fs.existsSync(path.join(libDir, 'R', '271777_Astraea_Milltina_v1.1')));

  snapshotAssets.pop();
}

console.log('## 不认识的路径');
{
  const r = makeReq({ pathname: '/api/library/whatever' });
  const handled = await handleConsoleLibraryFind(r);
  check('别的路径不接管', handled === false && r.getSent() === null);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log(`找号路由：通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
