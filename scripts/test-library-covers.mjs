// 素材库批量补封面（GET /api/library/covers、POST backfill/stop）。
//
// 为什么单独一套：这条路径会**往用户的素材目录写文件**，命名错一次就会在库里留下
// 认不出的垃圾文件（isThumb 只认 `<主件stem>.thumbnail.jpg`），所以断言重点不是「跑通了」，
// 而是「只补真缺的、force 才重抓、失败不中断、命名与绑定补资料完全一致、能停、能安全重跑」。
// 全部用假 deps（假扫盘、假 getBoothCover、真 coverPlan 规则 + 真 fs 临时目录），
// 不发网络请求、不碰真库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createLibraryCovers } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-covers.js')).href);
const libraryFindPure = await import(pathToFileURL(path.join(ROOT, 'src/library-find.js')).href);
// 全局 BOOTH 暂停（429/403）的真实实现：补封面必须先看它，暂停中一个请求都不发。
const boothPausePure = await import(pathToFileURL(path.join(ROOT, 'src/booth-pause.js')).href);
// 压缩包内封面（第 ③ 档）：VM 模块不能 import，靠 deps.libraryPackageCoverPure 注入真实实现。
const libraryPackageCoverPure = await import(pathToFileURL(path.join(ROOT, 'src/library-package-cover.js')).href);
const { buildZip } = await import(pathToFileURL(path.join(ROOT, 'scripts/fixtures/zip-build.mjs')).href);
const { safeResolveInside } = await import(pathToFileURL(path.join(ROOT, 'src/file-archive/paths.js')).href);

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-covers-'));
const libDir = path.join(tmp, 'library');
const cacheDir = path.join(tmp, 'booth-cache');
const stateDir = path.join(tmp, 'state');
fs.mkdirSync(path.join(libDir, 'g', 'a'), { recursive: true });
fs.mkdirSync(path.join(libDir, 'g', 'b'), { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
const coverPng = path.join(tmp, 'cover.png');
fs.writeFileSync(coverPng, 'fake-png-bytes');

// 样本科目：5 件里 4 件有 BOOTH 号（1 件已有缩略图、1 件已有 BOOTH 缓存封面、2 件缺）、1 件无号。
// thumbRel 由「磁盘上到底有没有缩略图」算出来，这样补完封面后重新 GET 就能看到 withCover 涨。
const catalog = [
  { key: 'g/a/hat', title: 'Hat', dir: 'g/a', boothId: '111111', mainName: 'Hat.zip' },
  { key: 'g/a/dress', title: 'Dress', dir: 'g/a', boothId: '222222', mainName: 'Dress.zip' },
  { key: 'g/b/boots', title: 'Boots', dir: 'g/b', boothId: '333333', mainName: 'Boots.zip' },
  { key: 'g/b/cape', title: 'Cape', dir: 'g/b', boothId: '444444', mainName: 'Cape v2.zip' },
  { key: 'g/b/stray', title: 'Stray', dir: 'g/b', boothId: '', mainName: 'Stray.zip' }
];
fs.writeFileSync(path.join(libDir, 'g/a/hat.thumbnail.jpg'), 'old-thumb');
fs.writeFileSync(path.join(cacheDir, '222222.jpg'), 'cached-cover');

function snapshotNow() {
  const assets = catalog.map((card) => {
    const stem = card.mainName.replace(/\.[^.]+$/, '');
    const rel = card.dir && stem ? `${card.dir}/${stem}.thumbnail.jpg` : '';
    const thumbRel = rel && fs.existsSync(path.join(libDir, rel)) ? rel : '';
    // BOOTH 缓存封面映射成 coverUrl（真实链路 enrichAssetsWithBoothMeta 就是这么给的），
    // withCover 判据是 thumbRel || coverUrl；只造文件不给字段，统计会与线上不一致。
    const coverUrl = card.boothId && fs.existsSync(path.join(cacheDir, `${card.boothId}.jpg`)) ? `/api/library/purchases/cover?boothId=${card.boothId}` : "";
    return { ...card, thumbRel, coverUrl };
  });
  return { ok: true, root: libDir, count: assets.length, withThumb: assets.filter((a) => a.thumbRel).length, assets };
}

const coverCalls = [];
const logs = [];
let failIds = new Set();
// 假 getBoothCover：默认给图；failIds 里的号回 not_found（模拟 404/403 那类降级）
let coverGate = null;
const deps = {
  fs,
  path,
  STATE_DIR: stateDir,
  log: (m) => logs.push(String(m)),
  fileArchiveRootDir: () => libDir,
  boothCacheDir: () => cacheDir,
  buildLibrarySnapshot: () => snapshotNow(),
  getBoothCoverPath: (id, { cacheRoot }) => {
    const p = path.join(String(cacheRoot), `${id}.jpg`);
    return fs.existsSync(p) ? p : '';
  },
  libraryFindPure,
  boothPausePure,
  libraryPackageCoverPure,
  safeResolveInside,
  atomicWriteJson: (file, obj) => fs.writeFileSync(file, JSON.stringify(obj)),
  getBoothCover: async (boothId, options) => {
    coverCalls.push({ boothId, force: Boolean(options?.force) });
    if (coverGate) await coverGate();
    if (failIds.has(String(boothId))) return { ok: false, status: 'not_found', coverError: 'BOOTH 没有可用的展示图（404）' };
    return { ok: true, path: coverPng };
  }
};
const covers = createLibraryCovers(deps);

function makeReq(method, pathname, { body = null, headers = {} } = {}) {
  let sent = null;
  return {
    req: { method, headers },
    url: { pathname, searchParams: new URLSearchParams() },
    readBody: async () => body,
    sendJson: (payload, code) => { sent = { payload, code: code || 200 }; },
    getSent: () => sent
  };
}
async function call(method, pathname, opts) {
  const r = makeReq(method, pathname, opts);
  const handled = await covers.handleConsoleLibraryCovers(r);
  const sent = r.getSent() || { payload: null, code: 0 };
  return { handled, code: sent.code, payload: sent.payload };
}
const statePath = path.join(stateDir, 'booth-covers.json');
function readJobFile() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return null; }
}

console.log('## GET /api/library/covers：概览口径与 withCover 同步');
{
  const { handled, code, payload } = await call('GET', '/api/library/covers');
  check('路由被本模块处理', handled === true && code === 200);
  eq('total = 库内件数', payload.total, 5);
  eq('withCover = 已有缩略图 1 + BOOTH 缓存 1', payload.withCover, 2);
  eq('missing = 没有封面的件数（含无号那件，与 counts.noCover 同口径）', payload.missing, 3);
  check('running 初始 false 且 job 结构齐全',
    payload.running === false && payload.job && typeof payload.job.state === 'string' && payload.job.done === 0,
    JSON.stringify(payload.job));
  eq('lastError 初始为空', payload.lastError, '');
}

console.log('## 智能体一律 403（补封面会写用户目录）');
{
  for (const [name, headers] of [
    ['x-agent-token', { 'x-agent-token': 'abc123' }],
    ['x-agent-call', { 'x-agent-call': '1' }]
  ]) {
    const get = await call('GET', '/api/library/covers', { headers });
    check(`${name} 的 GET 被 403`, get.code === 403 && get.payload.ok === false, `${get.code} ${JSON.stringify(get.payload)}`);
    const post = await call('POST', '/api/library/covers/backfill', { headers, body: {} });
    check(`${name} 的 backfill 被 403`, post.code === 403 && post.payload.ok === false, `${post.code}`);
  }
}

console.log('## backfill：只补真缺的，命名与绑定补资料一致，幂等');
{
  coverCalls.length = 0;
  const { code, payload } = await call('POST', '/api/library/covers/backfill', { body: {} });
  eq('返回 ok 且成功两件', [code, payload.ok, payload.done, payload.failed], [200, true, 2, 0]);
  eq('只抓了缺封面的两个号', coverCalls.map((c) => c.boothId).sort(), ['333333', '444444']);
  eq('落盘文件名 = <主件stem>.thumbnail.jpg',
    ['g/b/Boots.thumbnail.jpg', 'g/b/Cape v2.thumbnail.jpg'].map((rel) => fs.existsSync(path.join(libDir, rel))).every(Boolean), true);
  check('已有缩略图那件没被覆盖', fs.readFileSync(path.join(libDir, 'g/a/hat.thumbnail.jpg'), 'utf8') === 'old-thumb');
  eq('状态文件落成 done', [readJobFile()?.state, readJobFile()?.done, readJobFile()?.failed], ['done', 2, 0]);
  const again = await call('POST', '/api/library/covers/backfill', { body: {} });
  eq('第二次跑幂等：done=0 且不再抓', [again.payload.done, coverCalls.length], [0, 2]);
  const after = await call('GET', '/api/library/covers');
  // missing = 「全部 - 有封面」：无号那件补不出来，补完仍剩 1；不再把救不了的件宣传成可补。
  eq('withCover 从 2 涨到 4、missing 只剩无号那件', [after.payload.withCover, after.payload.missing], [4, 1]);
}

console.log('## keys 过滤与 force 重抓');
{
  coverCalls.length = 0;
  const scoped = await call('POST', '/api/library/covers/backfill', { body: { keys: ['g/a/hat'] } });
  eq('keys 指定那件：非 force 时有封面 → 没有待补', scoped.payload.done, 0);
  const forced = await call('POST', '/api/library/covers/backfill', { body: { keys: ['g/a/hat'], force: true } });
  eq('force=true 才会重抓已有封面（即便 keys 只指一件）', [forced.payload.done, coverCalls.length], [1, 1]);
  eq('force 透传给 getBoothCover', [coverCalls[0].boothId, coverCalls[0].force], ['111111', true]);
}

console.log('## 失败计入 failed、不中断后面的件');
{
  coverCalls.length = 0;
  failIds = new Set(['111111']);
  const { payload } = await call('POST', '/api/library/covers/backfill', { body: { force: true, limit: 10 } });
  eq('4 件里 1 件失败 3 件成功', [payload.done, payload.failed], [3, 1]);
  check('lastError 记下失败原因（含标题）', /BOOTH 没有可用的展示图/.test(String(payload.lastError)) && /Hat/.test(String(payload.lastError)), String(payload.lastError));
  eq('失败不中断：4 件都尝试过', coverCalls.length, 4);
  failIds = new Set();
  const retry = await call('POST', '/api/library/covers/backfill', { body: { keys: ['g/a/hat'], force: true } });
  eq('失败件下一轮可重试成功', [retry.payload.done, retry.payload.failed], [1, 0]);
}

console.log('## 并发：running 时再点回 409；stop 生效');
{
  let release = null;
  coverGate = () => new Promise((resolve) => { release = resolve; });
  const pending = call('POST', '/api/library/covers/backfill', { body: { force: true, limit: 10 } });
  // 让 backfill 进入 running + 停在第一件抓取上。
  // 多级来源之后第一件之前多了几次 await（读暂停/查台账/查缓存），固定 0ms 不再够用：
  // 轮询到「抓取真的停在 gate 上」再断言，否则会在 release() 处拿到 null。
  for (let i = 0; i < 100 && !release; i += 1) await new Promise((r) => setTimeout(r, 5));
  const running = await call('GET', '/api/library/covers');
  eq('running 时 GET 报 true', running.payload.running, true);
  const conflict = await call('POST', '/api/library/covers/backfill', { body: {} });
  eq('running 时再点 backfill 回 409', [conflict.code, conflict.payload.ok], [409, false]);
  const stop = await call('POST', '/api/library/covers/stop', { body: {} });
  eq('stop 回 stopping', [stop.code, stop.payload.stopping], [200, true]);
  release();
  const result = await pending;
  eq('停下来的那轮标记 stopped 且只跑了一件', [result.payload.stopped, result.payload.done + result.payload.failed], [true, 1]);
  eq('状态文件记 stopped', readJobFile()?.state, 'stopped');
  const stopAgain = await call('POST', '/api/library/covers/stop', { body: {} });
  eq('没在跑时 stop 回 409', stopAgain.code, 409);
  coverGate = null;
}

console.log('## 重启：running 状态读回标 interrupted、能继续跑');
{
  fs.writeFileSync(statePath, JSON.stringify({ v: 1, at: 1, running: true, state: 'running', startedAt: 123, done: 1, failed: 0, lastKey: 'g/a/hat', lastError: '' }));
  const freshDeps = { ...deps, getBoothCover: async (boothId, options) => { coverCalls.push({ boothId, force: Boolean(options?.force) }); return { ok: true, path: coverPng }; } };
  const fresh = createLibraryCovers(freshDeps);
  const r = makeReq('GET', '/api/library/covers');
  await fresh.handleConsoleLibraryCovers(r);
  const payload = r.getSent().payload;
  eq('重启后 job.state 读回 interrupted', payload.job.state, 'interrupted');
  check('提示可以重跑', /重跑|打断/.test(String(payload.lastError)), String(payload.lastError));
  eq('running 读回 false（进程都没了）', payload.running, false);
}

console.log('## 越界路径防护（coverPlan 给出越界 relPath 时必须被拒绝）');
{
  const evilDeps = {
    ...deps,
    libraryFindPure: { coverPlan: () => ({ fileName: 'x.thumbnail.jpg', relPath: '../../etc/x.thumbnail.jpg' }) },
    getBoothCover: async () => ({ ok: true, path: coverPng })
  };
  const evil = createLibraryCovers(evilDeps);
  const req = makeReq('POST', '/api/library/covers/backfill', { body: { keys: ['g/a/hat'], force: true } });
  await evil.handleConsoleLibraryCovers(req);
  const payload = req.getSent().payload;
  eq('越界路径记为 failed（不写文件）', [payload.done, payload.failed], [0, 1]);
  eq('库目录外没有写出文件', fs.existsSync(path.join(tmp, 'etc', 'x.thumbnail.jpg')), false);
}

console.log('## 全局暂停：暂停中不发请求，接口直接说「暂停中」');
{
  const before = coverCalls.length;
  fs.writeFileSync(
    path.join(stateDir, 'booth-search-pause.json'),
    JSON.stringify({ pausedUntil: Date.now() + 5 * 60 * 1000, reason: 'BOOTH 搜索被限速（HTTP 429）', status: 429, at: Date.now() })
  );
  const get = await call('GET', '/api/library/covers');
  check('GET 带 paused=true 与倒计时文案', get.payload.paused === true && /还要等约 \d+ 分钟/.test(get.payload.pauseText), JSON.stringify(get.payload.pauseText));
  check('GET 的 retryAfterMs 是正数', Number(get.payload.retryAfterMs) > 0);

  const backfill = await call('POST', '/api/library/covers/backfill', { body: {} });
  eq('POST backfill 暂停中回 409', backfill.code, 409);
  check('回包说明 paused 与文案', backfill.payload.paused === true && /限速/.test(String(backfill.payload.error)), String(backfill.payload.error));
  eq('暂停中一件都不抓', coverCalls.length, before);
  eq('没留下 running 的 task 状态', readJobFile()?.running, false);
}

console.log('## 解除暂停后恢复（删除状态文件等价于立刻解除）');
{
  fs.rmSync(path.join(stateDir, 'booth-search-pause.json'), { force: true });
  const backfill = await call('POST', '/api/library/covers/backfill', { body: { limit: 1 } });
  eq('解除后 backfill 正常 200', backfill.code, 200);
  check('确实抓到封面', coverCalls.length > 0);
}

console.log('## 统计口径 = 素材页最终视图（total=allCount、missing=noCover）');
{
  // 真机 bug：covers 用扫盘快照数（23 件 / 18 有封面），素材页走 rename/merge/binds 后的视图
  // （17 件 / 16 有封面）。这里注入一个「合并折叠掉一件」的最终视图，断言两边的数字同源。
  const { countAssetBuckets } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-view.js')).href);
  const viewAssets = [
    { key: 'g/a/hat', title: 'Hat', dir: 'g/a', boothId: '111111', thumbRel: 'g/a/hat.thumbnail.jpg' },
    { key: 'g/b/boots', title: 'Boots', dir: 'g/b', boothId: '333333', thumbRel: '' },
    { key: 'g/b/cape', title: 'Cape v2', dir: 'g/b', boothId: '444444', thumbRel: '', coverUrl: '' },
    { key: 'g/b/stray', title: 'Stray', dir: 'g/b', boothId: '', thumbRel: '' }
  ];
  const viewDeps = { ...deps, libraryAssetsViewOf: () => ({ assets: viewAssets, scannedAt: 1700000000000 }) };
  const viewCovers = createLibraryCovers(viewDeps);
  const r = makeReq('GET', '/api/library/covers');
  await viewCovers.handleConsoleLibraryCovers(r);
  const payload = r.getSent().payload;
  const counts = countAssetBuckets(viewAssets);
  eq('total = 最终视图件数（与 /api/library/assets 的 allCount 同源）', payload.total, counts.all);
  eq('missing = counts.noCover（缺封面的都算，含没号的）', payload.missing, counts.noCover);
  eq('withCover = all - noCover', payload.withCover, counts.all - counts.noCover);
  eq('scannedAt 用最终视图的', payload.scannedAt, 1700000000000);

  coverCalls.length = 0;
  const r2 = makeReq('POST', '/api/library/covers/backfill', { body: {} });
  await viewCovers.handleConsoleLibraryCovers(r2);
  eq('候选键也来自最终视图：只补「有号且缺封面」的两件', coverCalls.map((c) => c.boothId).sort(), ['333333', '444444']);
}

console.log('## v2 多级来源：台账/缓存 0 网络，只有最后一档才抓 BOOTH');
{
  // 全新一套库：三件都缺封面，分别由「台账本地图 / BOOTH 缓存 / 商品页抓取」补上。
  // 断言重点：前两档一件网络请求都不发（coverCalls 只该有第三件），bySource 分别计数。
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'library-covers-v2-'));
  const lib2 = path.join(tmp2, 'library');
  const cache2 = path.join(tmp2, 'booth-cache');
  const state2 = path.join(tmp2, 'state');
  for (const dir of ['g/c/one', 'g/c/two', 'g/c/three']) fs.mkdirSync(path.join(lib2, dir), { recursive: true });
  fs.mkdirSync(cache2, { recursive: true });
  fs.mkdirSync(path.join(state2, 'booth-purchase-covers'), { recursive: true });
  fs.writeFileSync(path.join(state2, 'booth-purchases.json'), JSON.stringify({
    version: 1,
    items: {
      555555: { boothId: '555555', title: 'Ledger Only', coverUrl: 'https://img.example/555555.jpg', addedAt: 1 },
      666666: { boothId: '666666', title: 'Cache Only', coverUrl: 'https://img.example/666666.jpg', addedAt: 2 }
    }
  }));
  // ① 台账本地已有图：state/booth-purchase-covers/555555.jpg
  fs.writeFileSync(path.join(state2, 'booth-purchase-covers', '555555.jpg'), 'ledger-bytes');
  // ② BOOTH 缓存里已有图（getBoothCoverPath 的约定是 <cacheRoot>/<id>.jpg）
  fs.writeFileSync(path.join(cache2, '666666.jpg'), 'cache-bytes');
  const cards2 = [
    { key: 'g/c/one', title: 'One', dir: 'g/c/one', boothId: '555555', mainName: 'One.zip', thumbRel: '', coverUrl: '' },
    { key: 'g/c/two', title: 'Two', dir: 'g/c/two', boothId: '666666', mainName: 'Two.zip', thumbRel: '', coverUrl: '' },
    { key: 'g/c/three', title: 'Three', dir: 'g/c/three', boothId: '777777', mainName: 'Three.zip', thumbRel: '', coverUrl: '' }
  ];
  const calls2 = [];
  const deps2 = {
    ...deps,
    STATE_DIR: state2,
    fileArchiveRootDir: () => lib2,
    boothCacheDir: () => cache2,
    // 和线上一样：thumbRel 由磁盘决定（补完封面重新扫才看得到），不能写死在卡片里，
    // 否则 summary 的 withCover 永远不动，测不出「补完之后看得见」。
    buildLibrarySnapshot: () => ({
      ok: true,
      root: lib2,
      count: cards2.length,
      scannedAt: 1700000000000,
      assets: cards2.map((card) => {
        const stem = card.mainName.replace(/\.[^.]+$/, '');
        const rel = `${card.dir}/${stem}.thumbnail.jpg`;
        return { ...card, thumbRel: fs.existsSync(path.join(lib2, rel)) ? rel : '' };
      })
    }),
    getBoothCoverPath: (id, { cacheRoot }) => {
      const file = path.join(String(cacheRoot), `${id}.jpg`);
      return fs.existsSync(file) ? file : '';
    },
    getBoothCover: async (boothId) => { calls2.push(String(boothId)); return { ok: true, path: coverPng }; }
  };
  const covers2 = createLibraryCovers(deps2);
  const r = makeReq('POST', '/api/library/covers/backfill', { body: { limit: 10 } });
  await covers2.handleConsoleLibraryCovers(r);
  const payload = r.getSent().payload;
  eq('三件都补上', payload.done, 3);
  eq('只有商品页那一件发了网络请求', calls2, ['777777']);
  eq('bySource 记录来源分布', payload.bySource, { ledger: 1, cache: 1, unitypackage: 0, package: 0, booth: 1 });
  check('台账/缓存两件的图字节与来源文件一致',
    fs.readFileSync(path.join(lib2, 'g/c/one/One.thumbnail.jpg'), 'utf8') === 'ledger-bytes'
    && fs.readFileSync(path.join(lib2, 'g/c/two/Two.thumbnail.jpg'), 'utf8') === 'cache-bytes',
    'copy mismatch');
  const summary = makeReq('GET', '/api/library/covers');
  await covers2.handleConsoleLibraryCovers(summary);
  eq('GET 概览也带 bySource', summary.getSent().payload.bySource, { ledger: 1, cache: 1, unitypackage: 0, package: 0, booth: 1 });
  eq('GET 概览 total/withCover 同步', [summary.getSent().payload.total, summary.getSent().payload.withCover], [3, 3]);

  // mode=all：连已经有封面的也重补一遍（force 语义）→ 三件都走最后一档。
  calls2.length = 0;
  const r2 = makeReq('POST', '/api/library/covers/backfill', { body: { mode: 'all', limit: 10 } });
  await covers2.handleConsoleLibraryCovers(r2);
  eq('mode=all 全量重补三件', r2.getSent().payload.done, 3);
  eq('mode=all 全走商品页（force）', calls2.sort(), ['555555', '666666', '777777']);
  eq('mode 回显', r2.getSent().payload.mode, 'all');

  // 非法 mode 回落 missing：不因为参数写错就报错。
  const r3 = makeReq('POST', '/api/library/covers/backfill', { body: { mode: 'banana', limit: 1 } });
  await covers2.handleConsoleLibraryCovers(r3);
  eq('非法 mode 回落 missing', r3.getSent().payload.mode, 'missing');
  fs.rmSync(tmp2, { recursive: true, force: true });
}

console.log('## v2 第 ③ 档：压缩包里的 preview.png（纯本地读，0 网络）');
{
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'library-covers-pack-'));
  const lib3 = path.join(tmp3, 'library');
  const state3 = path.join(tmp3, 'state');
  fs.mkdirSync(path.join(lib3, 'g/d/pack'), { recursive: true });
  fs.mkdirSync(path.join(lib3, 'g/d/plain'), { recursive: true });
  fs.mkdirSync(path.join(lib3, 'g/d/nob'), { recursive: true });
  fs.mkdirSync(path.join(lib3, 'g/d/big'), { recursive: true });
  fs.mkdirSync(state3, { recursive: true });
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const previewBytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(64, 7)]);
  // .zip 里带 preview.png：这一档应该直接读出来，不去抓商品页。
  fs.writeFileSync(path.join(lib3, 'g/d/pack/Pack.zip'), buildZip([
    { name: 'readme.txt', data: 'hello' },
    { name: 'preview.png', data: previewBytes }
  ]));
  // 另一个包没有 preview.png：这一档失败后要落到商品页，且失败原因要能看见。
  // 没有 preview.png 的包：readme 里写着商品号和解压密码——补封面失败时要顺手把这两样摘出来。
  const plainReadme = ['商品名: Plain Set', 'https://booth.pm/ja/items/7654321', 'パスワード: open123'].join('\n');
  fs.writeFileSync(path.join(lib3, 'g/d/plain/Plain.zip'), buildZip([{ name: 'readme.txt', data: plainReadme }]));
  // 没有 BOOTH 号的老包：也应该能从自己的 preview.png 补上封面（用户的库里一堆这种）。
  fs.writeFileSync(path.join(lib3, 'g/d/nob/Nob.zip'), buildZip([{ name: 'preview.png', data: previewBytes }]));
  // 40MB 大包：旧逻辑「>32MB 不抽」会直接判死；真机 55MB 的 Endless Comfort 就是这种。
  // 这里只要求「体积不再当门槛」且仍然只解那一张小图（探测字节远小于包体积）。
  fs.writeFileSync(path.join(lib3, 'g/d/big/Big.zip'), buildZip([
    { name: 'assets/big.bin', data: Buffer.alloc(40 * 1024 * 1024, 0), method: 0 },
    { name: 'preview.png', data: previewBytes, method: 0 }
  ]));
  const cards3 = [
    { key: 'g/d/pack', title: 'Pack', dir: 'g/d/pack', boothId: '888888', mainName: 'Pack.zip', thumbRel: '', coverUrl: '' },
    { key: 'g/d/plain', title: 'Plain', dir: 'g/d/plain', boothId: '999999', mainName: 'Plain.zip', thumbRel: '', coverUrl: '' },
    { key: 'g/d/nob', title: 'Nob', dir: 'g/d/nob', boothId: '', mainName: 'Nob.zip', thumbRel: '', coverUrl: '' },
    { key: 'g/d/big', title: 'Big', dir: 'g/d/big', boothId: '', mainName: 'Big.zip', thumbRel: '', coverUrl: '' }
  ];
  const calls3 = [];
  const deps3 = {
    ...deps,
    STATE_DIR: state3,
    fileArchiveRootDir: () => lib3,
    boothCacheDir: () => path.join(tmp3, 'booth-cache'),
    libraryPackageCoverPure,
    buildLibrarySnapshot: () => ({
      ok: true,
      root: lib3,
      count: cards3.length,
      assets: cards3.map((card) => {
        const stem = card.mainName.replace(/\.[^.]+$/, '');
        const jpg = `${card.dir}/${stem}.thumbnail.jpg`;
        const png = `${card.dir}/${stem}.thumbnail.png`;
        const rel = fs.existsSync(path.join(lib3, png)) ? png : fs.existsSync(path.join(lib3, jpg)) ? jpg : '';
        return { ...card, thumbRel: rel };
      })
    }),
    getBoothCoverPath: () => '',
    getBoothCover: async (boothId) => { calls3.push(String(boothId)); return { ok: false, status: 'not_found', coverError: 'BOOTH 没有可用的展示图（404）' }; }
  };
  const covers3 = createLibraryCovers(deps3);
  const r = makeReq('POST', '/api/library/covers/backfill', { body: { limit: 10 } });
  await covers3.handleConsoleLibraryCovers(r);
  const payload = r.getSent().payload;
  eq('包内封面三件（有号 + 无号 + 40MB 大包）都补上了', payload.done, 3);
  eq('bySource 记 package（普通 zip 挑图）', payload.bySource, { ledger: 0, cache: 0, unitypackage: 0, package: 3, booth: 0 });
  eq('lastPackage 记下包内封面的来源明细', [payload.lastPackage?.source, payload.lastPackage?.entryName, payload.lastPackage?.bytes], ['preview', 'preview.png', previewBytes.length]);
  eq('没有 preview 的包落到商品页（失败不中断整批）', payload.failed, 1);
  check('包内封面按真实格式落成 .thumbnail.png 且字节一致',
    fs.existsSync(path.join(lib3, 'g/d/pack/Pack.thumbnail.png'))
    && fs.readFileSync(path.join(lib3, 'g/d/pack/Pack.thumbnail.png')).equals(previewBytes),
    'file mismatch');
  check('无号件也从自己的包补上了封面', fs.existsSync(path.join(lib3, 'g/d/nob/Nob.thumbnail.png')) && fs.readFileSync(path.join(lib3, 'g/d/nob/Nob.thumbnail.png')).equals(previewBytes), 'nob missing');
  check('40MB 大包也补上了（体积不再当门槛）', fs.existsSync(path.join(lib3, 'g/d/big/Big.thumbnail.png')) && fs.readFileSync(path.join(lib3, 'g/d/big/Big.thumbnail.png')).equals(previewBytes), 'big missing');
  check('没有 preview 的包没写垃圾文件', !fs.existsSync(path.join(lib3, 'g/d/plain/Plain.thumbnail.jpg')) && !fs.existsSync(path.join(lib3, 'g/d/plain/Plain.thumbnail.png')));
  check('失败原因带包内封面这一句', String(payload.lastError || '').includes('包内封面'), String(payload.lastError));
  eq('只有有号且缺 preview 的那件发过网络请求（无号件不联网）', calls3, ['999999']);
  const again = makeReq('GET', '/api/library/covers');
  await covers3.handleConsoleLibraryCovers(again);
  eq('重扫后 withCover=3（.thumbnail.png 被 isThumb 认出来了）', again.getSent().payload.withCover, 3);
  eq('GET 概览也带 lastPackage', again.getSent().payload.lastPackage?.entryName, 'preview.png');
  eq('补不上图的包把 readme 里的号摘出来了', payload.lastArchiveInfo?.boothIds, ['7654321']);
  eq('补不上图的包把 readme 里的解压密码摘出来了', payload.lastArchiveInfo?.passwordCandidates, ['open123']);
  eq('GET 概览的 job 也带 lastArchiveInfo', again.getSent().payload.job?.lastArchiveInfo?.passwordCandidates, ['open123']);
  // lead 要的是「lastPackage 里挂 info」，前端排障只看一个地方；两个字段必须同时有。
  eq('lastPackage 里也挂了包内信息摘要', again.getSent().payload.job?.lastPackage?.info?.boothIds, ['7654321']);
  eq('lastPackage.info 与 lastArchiveInfo 同源', again.getSent().payload.job?.lastPackage?.info?.passwordCandidates, again.getSent().payload.job?.lastArchiveInfo?.passwordCandidates);
  fs.rmSync(tmp3, { recursive: true, force: true });
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
