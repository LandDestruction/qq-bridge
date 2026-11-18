// 已购 ⇄ 本地同步：deep=1 对账视图 + sync/bind/download/forget 写接口。
// 为什么单独一套：这些接口会改台账（可能把用户的「已购」删掉），写盘逻辑不能只靠人工点页面验收；
// 而且前端 07n 已经按固定形状对接，字段名/路径一改就静默白屏，必须有红灯。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pure = await import(pathToFileURL(path.join(ROOT, 'src/library-reconcile.js')).href);
const routes = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-reconcile-routes.js')).href);
const { reconcileDeepPlan } = pure;
const { handleReconcileRoutes } = routes;

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name} — ${error?.message ?? error}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name} — ${error?.message ?? error}`);
  }
}
function eq(name, actual, expected) {
  check(name, () => assert.deepEqual(actual, expected));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-sync-'));
function atomicWriteJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staging = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(staging, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(staging, file);
}
const enqueued = [];
let enqueueImpl = async (input) => {
  enqueued.push(input);
  return { ok: true, queued: true, job: { state: 'queued', boothId: input.boothId } };
};
const deps = {
  fs,
  path,
  STATE_DIR: tmp,
  ROOT,
  log: () => {},
  atomicWriteJson,
  enqueueReconcileDownload: (input) => enqueueImpl(input)
};

const PURCHASES = {
  version: 1,
  items: {
    271777: { boothId: '271777', title: 'Astraea', shopName: 'Studio A', priceText: '¥1,100', updatedAt: 100 },
    7850009: { boothId: '7850009', title: 'Mew Hair', shopName: 'B', priceText: '¥550', updatedAt: 200, gone: true },
    111111: { boothId: '111111', title: 'Missing One', shopName: 'C', priceText: '¥330', updatedAt: 300 },
    424242: { boothId: '424242', title: 'Extra Care', shopName: 'D', priceText: '¥220', updatedAt: 400 }
  }
};
const ASSETS = [
  { key: 'g/a/astraea', title: 'Astraea', dir: 'R/271777_Astraea', boothId: '271777' },
  { key: 'g/b/mew', title: 'Mew Hair', dir: 'R/7850009_Mew', boothId: '7850009' },
  { key: 'g/c/extra1', title: 'Extra Pack', dir: 'R/999999_Extra', boothId: '999999' },
  { key: 'g/c/extra2', title: 'Extra Pack 2', dir: 'R/999999_Extra2', boothId: '999999' },
  { key: 'g/d/same', title: 'Missing One', dir: 'R/888888_Same', boothId: '888888' },
  { key: 'g/e/plain', title: 'Plain', dir: 'R/plain', boothId: '' }
];
const getAssets = async () => ({ ok: true, assets: ASSETS });
function writePurchases(state = PURCHASES) {
  fs.writeFileSync(path.join(tmp, 'booth-purchases.json'), JSON.stringify(state), 'utf8');
}
function readPurchases() {
  return JSON.parse(fs.readFileSync(path.join(tmp, 'booth-purchases.json'), 'utf8'));
}
function readBinds() {
  try { return JSON.parse(fs.readFileSync(path.join(tmp, 'booth-binds.json'), 'utf8')); } catch { return null; }
}
writePurchases();

function makeReq({ method = 'GET', pathname = '/api/library/reconcile', headers = {}, search = '', body = null } = {}) {
  let sent = null;
  return {
    req: { method, headers },
    url: { pathname, searchParams: new URLSearchParams(search) },
    readBody: async () => body,
    sendJson: (payload, code) => { sent = { payload, code: code || 200 }; },
    getSent: () => sent
  };
}

console.log('## deep=1 纯计划（不传 deps、不写盘）');
const plan = reconcileDeepPlan({ purchases: Object.values(PURCHASES.items), assets: ASSETS, goneIds: ['7850009'], now: 7 });
eq('stats 在老五项之外补 pending/forgotten/ambiguous', plan.stats, {
  purchased: 4, inLibrary: 5, matched: 2, missing: 2, extra: 3, pending: 5, forgotten: 1, ambiguous: 1
});
eq('summary 按 action 类型计数', plan.summary, { bind: 1, download: 2, forget: 1, review: 1 });
eq('actions 按类型顺序：bind → download → forget → review', plan.actions.map((a) => a.type), ['bind', 'download', 'download', 'forget', 'review']);
eq('bind 只在同号 ≥2 件时出，keys 给全部候选', plan.actions[0], {
  id: 'bind:999999', type: 'bind', action: 'bind', boothId: '999999',
  keys: ['g/c/extra1', 'g/c/extra2'], title: 'Extra Pack', reason: '库里有 2 件同号素材还没登记已购'
});
eq('download 只给已购有、库里 0 件的号（带 downloadable）', plan.actions.slice(1, 3).map((a) => [a.id, a.boothId]), [['download:111111', '111111'], ['download:424242', '424242']]);
eq('missing 条目带 downloadable:true 给前端禁用/启用按钮', plan.missing.map((m) => [m.boothId, m.downloadable]), [['111111', true], ['424242', true]]);
eq('forget 只对 gone 台账条目出（宁缺勿假）', plan.actions[3], {
  id: 'forget:7850009', type: 'forget', action: 'forget', boothId: '7850009',
  title: 'Mew Hair', reason: 'BOOTH 侧这件已删除/下架，台账里还留着'
});
eq('review 只对同名但号对不上的保守提示', plan.actions[4].id, 'review:111111:888888');
eq('review 带 ambiguous 别名（老前端只认 action）', [plan.actions[4].action, plan.actions[4].boothId, plan.actions[4].keys], ['ambiguous', '111111', ['g/d/same']]);
eq('inLibrary 按号分组（keys/dirs 给前端按号操作）', plan.inLibrary.map((g) => [g.boothId, g.keys]), [
  ['271777', ['g/a/astraea']], ['7850009', ['g/b/mew']], ['888888', ['g/d/same']], ['999999', ['g/c/extra1', 'g/c/extra2']]
]);
eq('extra 按号分组', plan.extra.map((g) => g.boothId), ['888888', '999999']);
eq('deep 不改变老统计口径（inLibrary 仍数有号卡）', plan.stats.matched, 2);

console.log('## GET /api/library/reconcile?deep=1');
await checkAsync('deep=1 返回 stats/三组分组/actions/decisions/summary', async () => {
  const req = makeReq({ search: 'deep=1' });
  assert.equal(await handleReconcileRoutes(req, deps, getAssets), true);
  const { payload, code } = req.getSent();
  assert.equal(code, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.stats.pending, 5);
  assert.equal(payload.stats.forgotten, 1);
  assert.equal(payload.stats.ambiguous, 1);
  assert.deepEqual(payload.actions.map((a) => a.type), ['bind', 'download', 'download', 'forget', 'review']);
  assert.deepEqual(payload.decisions, payload.actions, 'decisions 必须是 actions 的别名（前端 07n 读 decisions）');
  assert.deepEqual(payload.summary, { bind: 1, download: 2, forget: 1, review: 1 });
  assert.deepEqual(payload.missing.map((m) => m.downloadable), [true, true]);
  assert.deepEqual(payload.inLibrary.map((g) => g.keys.length), [1, 1, 1, 2]);
  assert.equal(typeof payload.generatedAt, 'number');
});

await checkAsync('不传 deep 时形状完全不变（老前端不能崩）', async () => {
  const req = makeReq();
  await handleReconcileRoutes(req, deps, getAssets);
  const { payload } = req.getSent();
  assert.deepEqual(payload.stats, { purchased: 4, inLibrary: 5, matched: 2, missing: 2, extra: 3 });
  assert.equal('pending' in payload.stats, false);
  assert.equal('actions' in payload, false);
  assert.equal('decisions' in payload, false);
  assert.equal('summary' in payload, false);
  // 老形状里 inLibrary/extra 是「卡片数组」而不是分组
  assert.equal(payload.inLibrary[0].key, 'g/a/astraea');
});

await checkAsync('deep=1 + getAssets 抛错 → 500 且带「对账失败」', async () => {
  const req = makeReq({ search: 'deep=1' });
  await handleReconcileRoutes(req, deps, async () => { throw new Error('扫描炸了'); });
  assert.equal(req.getSent().code, 500);
  assert.ok(req.getSent().payload.error.includes('对账失败'));
});

console.log('## POST /api/library/reconcile/sync');
await checkAsync('dryRun:true 一个字节都不写（台账/绑定/入队都没动）', async () => {
  const before = fs.readFileSync(path.join(tmp, 'booth-purchases.json'), 'utf8');
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/sync', body: { dryRun: true } });
  assert.equal(await handleReconcileRoutes(req, deps, getAssets), true);
  const { payload, code } = req.getSent();
  assert.equal(code, 200);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.total, 5);
  assert.deepEqual(payload.actions, payload.decisions);
  assert.equal(fs.readFileSync(path.join(tmp, 'booth-purchases.json'), 'utf8'), before);
  assert.equal(readBinds(), null, 'dryRun 不许创建 booth-binds.json');
  assert.equal(enqueued.length, 0);
});

await checkAsync('dryRun 字符串 "false" 不生效 → 400（严格布尔）', async () => {
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/sync', body: { dryRun: 'false' } });
  await handleReconcileRoutes(req, deps, getAssets);
  const { payload, code } = req.getSent();
  assert.equal(code, 400);
  assert.ok(payload.error.includes('dryRun 必须是严格的 true 或 false'), payload.error);
});

await checkAsync('dryRun 缺省同样 400', async () => {
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/sync', body: {} });
  await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(req.getSent().code, 400);
});

await checkAsync('dryRun:false + decisions 执行 bind：写 booth-binds.json、source=reconcile', async () => {
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/sync', body: { dryRun: false, decisions: [{ id: 'bind:999999' }] } });
  await handleReconcileRoutes(req, deps, getAssets);
  const { payload, code } = req.getSent();
  assert.equal(code, 200);
  assert.equal(payload.dryRun, false);
  assert.deepEqual(payload.applied.map((a) => [a.id, a.type, a.boothId, a.result.bound]), [['bind:999999', 'bind', '999999', 2]]);
  const table = readBinds();
  assert.equal(table.version, 1);
  assert.deepEqual(table.entries['g/c/extra1'], { boothId: '999999', title: 'Extra Pack', source: 'reconcile', at: table.entries['g/c/extra1'].at });
  assert.equal(table.entries['g/c/extra1'].source, 'reconcile');
  assert.equal(table.entries['g/c/extra2'].boothId, '999999');
  assert.equal(typeof table.entries['g/c/extra1'].at, 'number');
});

await checkAsync('decisions 也接受前端回传的完整 action 对象', async () => {
  fs.rmSync(path.join(tmp, 'booth-binds.json'), { force: true });
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/sync', body: { dryRun: false, decisions: [{ id: 'bind:999999', type: 'bind', boothId: '999999', keys: ['g/c/extra1'] }] } });
  await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(req.getSent().payload.applied.length, 1);
  assert.deepEqual(Object.keys(readBinds().entries), ['g/c/extra1']);
});

await checkAsync('review 动作不能自动执行 → skipped 带「人工确认」', async () => {
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/sync', body: { dryRun: false, decisions: [{ id: 'review:111111:888888' }] } });
  await handleReconcileRoutes(req, deps, getAssets);
  const { payload } = req.getSent();
  assert.equal(payload.applied.length, 0);
  assert.equal(payload.skipped.length, 1);
  assert.ok(payload.skipped[0].error.includes('人工确认'), payload.skipped[0].error);
});

await checkAsync('不存在的 action id → skipped 且不写盘', async () => {
  const before = fs.readFileSync(path.join(tmp, 'booth-purchases.json'), 'utf8');
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/sync', body: { dryRun: false, decisions: ['nope:1'] } });
  await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(req.getSent().payload.applied.length, 0);
  assert.equal(req.getSent().payload.skipped.length, 1);
  assert.equal(fs.readFileSync(path.join(tmp, 'booth-purchases.json'), 'utf8'), before);
});

await checkAsync('download 动作调 enqueueReconcileDownload 并把结果带回来', async () => {
  enqueued.length = 0;
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/sync', body: { dryRun: false, decisions: [{ id: 'download:111111' }] } });
  await handleReconcileRoutes(req, deps, getAssets);
  const { payload } = req.getSent();
  assert.equal(payload.applied[0].type, 'download');
  assert.equal(payload.applied[0].result.queued, true);
  assert.deepEqual(enqueued.map((e) => e.boothId), ['111111']);
});

await checkAsync('forget 动作只删台账条目（不碰文件、不碰别的号）', async () => {
  writePurchases();
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/sync', body: { dryRun: false, decisions: [{ id: 'forget:7850009' }] } });
  await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(req.getSent().payload.applied[0].type, 'forget');
  const state = readPurchases();
  assert.equal('7850009' in state.items, false);
  assert.deepEqual(Object.keys(state.items).sort(), ['111111', '271777', '424242']);
  assert.equal(state.version, 1);
});

await checkAsync('enqueue 抛错 → 该条 skipped、其它 decision 继续', async () => {
  const original = enqueueImpl;
  enqueueImpl = async () => { throw new Error('清单翻页超时'); };
  try {
    const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/sync', body: { dryRun: false, decisions: [{ id: 'download:111111' }, { id: 'bind:999999' }] } });
    await handleReconcileRoutes(req, deps, getAssets);
    const { payload } = req.getSent();
    assert.equal(payload.applied.length, 1);
    assert.equal(payload.applied[0].id, 'bind:999999');
    assert.equal(payload.skipped[0].id, 'download:111111');
    assert.ok(payload.skipped[0].error.includes('清单翻页超时'));
  } finally {
    enqueueImpl = original;
  }
});

console.log('## POST bind / download / forget（含 purchases 别名）');
await checkAsync('bind：存在的 key 写、不存在的 key 跳过并回报', async () => {
  fs.rmSync(path.join(tmp, 'booth-binds.json'), { force: true });
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/bind', body: { boothId: '888888', keys: ['g/d/same', 'nope'] } });
  await handleReconcileRoutes(req, deps, getAssets);
  const { payload, code } = req.getSent();
  assert.equal(code, 200);
  assert.deepEqual([payload.bound, payload.keys, payload.skipped.map((s) => s.key)], [1, ['g/d/same'], ['nope']]);
  assert.equal(readBinds().entries['g/d/same'].boothId, '888888');
});

await checkAsync('bind：不传 keys 时把这个号在库里全部候选绑上', async () => {
  fs.rmSync(path.join(tmp, 'booth-binds.json'), { force: true });
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/bind', body: { boothId: '999999' } });
  await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(req.getSent().payload.bound, 2);
  assert.deepEqual(Object.keys(readBinds().entries).sort(), ['g/c/extra1', 'g/c/extra2']);
});

await checkAsync('bind：非法 boothId → 400 且不写盘', async () => {
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/bind', body: { boothId: '12' } });
  await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(req.getSent().code, 400);
});

await checkAsync('/api/library/purchases/bind 别名走同一套逻辑', async () => {
  fs.rmSync(path.join(tmp, 'booth-binds.json'), { force: true });
  const req = makeReq({ method: 'POST', pathname: '/api/library/purchases/bind', body: { boothId: '888888', keys: ['g/d/same'] } });
  assert.equal(await handleReconcileRoutes(req, deps, getAssets), true);
  assert.equal(req.getSent().payload.bound, 1);
});

await checkAsync('download 接口单独调用 enqueue 并回 queued', async () => {
  enqueued.length = 0;
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/download', body: { boothId: '111111' } });
  await handleReconcileRoutes(req, deps, getAssets);
  const { payload, code } = req.getSent();
  assert.equal(code, 200);
  assert.equal(payload.queued, true);
  assert.deepEqual(enqueued.map((e) => e.boothId), ['111111']);
});

await checkAsync('download 未接线（deps 没有 enqueue）→ 503 人话', async () => {
  const bareDeps = { fs, path, STATE_DIR: tmp, ROOT, log: () => {}, atomicWriteJson };
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/download', body: { boothId: '111111' } });
  await handleReconcileRoutes(req, bareDeps, getAssets);
  assert.equal(req.getSent().code, 503);
  assert.ok(req.getSent().payload.error.includes('还没接线'));
});

console.log('## POST download-all（批量补下）');
const PAUSE_FILE = () => path.join(tmp, 'booth-search-pause.json');
function writePause(ms) {
  fs.writeFileSync(PAUSE_FILE(), JSON.stringify({ pausedUntil: Date.now() + ms, reason: 'BOOTH 搜索被限速（HTTP 429）', status: 429, at: Date.now() }), 'utf8');
}
function clearPause() {
  fs.rmSync(PAUSE_FILE(), { force: true });
}

await checkAsync('dryRun:true 只回候选、一个号都不入队', async () => {
  writePurchases();
  enqueued.length = 0;
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/download-all', body: { dryRun: true } });
  await handleReconcileRoutes(req, deps, getAssets);
  const { payload, code } = req.getSent();
  assert.equal(code, 200);
  assert.equal(payload.dryRun, true);
  assert.deepEqual(payload.queued, []);
  assert.deepEqual(payload.skipped, []);
  assert.deepEqual(payload.candidates.map((c) => c.boothId), ['111111', '424242']);
  assert.equal(payload.total, 2);
  assert.equal(enqueued.length, 0);
});

await checkAsync('dryRun 字符串 "true" 也当 true（URLSearchParams 口径）', async () => {
  enqueued.length = 0;
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/download-all', body: { dryRun: 'true', limit: 1 } });
  await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(req.getSent().payload.dryRun, true);
  assert.equal(req.getSent().payload.candidates.length, 1);
  assert.equal(enqueued.length, 0);
});

await checkAsync('dryRun 非法值（"yes"）→ 400 且不入队', async () => {
  enqueued.length = 0;
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/download-all', body: { dryRun: 'yes' } });
  await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(req.getSent().code, 400);
  assert.ok(req.getSent().payload.error.includes('dryRun 只认'));
  assert.equal(enqueued.length, 0);
});

await checkAsync('dryRun:"false" → 真跑（与前端字符串口径一致）', async () => {
  enqueued.length = 0;
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/download-all', body: { dryRun: 'false' } });
  await handleReconcileRoutes(req, deps, getAssets);
  const { payload, code } = req.getSent();
  assert.equal(code, 200);
  assert.equal(payload.dryRun, false);
  assert.deepEqual(payload.queued, ['111111', '424242']);
  assert.deepEqual(enqueued.map((e) => e.boothId), ['111111', '424242']);
});

await checkAsync('limit 夹取：limit:1 只入队第一件；limit:99 不超过候选数；limit:0 视作 1', async () => {
  enqueued.length = 0;
  const one = makeReq({ method: 'POST', pathname: '/api/library/reconcile/download-all', body: { dryRun: false, limit: 1 } });
  await handleReconcileRoutes(one, deps, getAssets);
  assert.deepEqual(one.getSent().payload.queued, ['111111']);
  enqueued.length = 0;
  const big = makeReq({ method: 'POST', pathname: '/api/library/reconcile/download-all', body: { dryRun: true, limit: 99 } });
  await handleReconcileRoutes(big, deps, getAssets);
  assert.equal(big.getSent().payload.candidates.length, 2, '候选只有 2 件，limit 20 的夹取上限不额外造候选');
  const zero = makeReq({ method: 'POST', pathname: '/api/library/reconcile/download-all', body: { dryRun: false, limit: 0 } });
  enqueued.length = 0;
  await handleReconcileRoutes(zero, deps, getAssets);
  assert.deepEqual(zero.getSent().payload.queued, ['111111'], 'limit:0 夹取成 1');
  const bad = makeReq({ method: 'POST', pathname: '/api/library/reconcile/download-all', body: { dryRun: false, limit: 'abc' } });
  await handleReconcileRoutes(bad, deps, getAssets);
  assert.equal(bad.getSent().code, 400);
});

await checkAsync('skipped 三种原因：done / 在队列 / 入队失败', async () => {
  const original = enqueueImpl;
  enqueueImpl = async (input) => {
    if (input.boothId === '111111') return { ok: true, already: true, queued: false, job: { state: 'done', boothId: '111111' } };
    if (input.boothId === '424242') return { ok: false, error: '已购清单里没找到这个商品的下载链接' };
    return { ok: true, queued: true };
  };
  try {
    const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/download-all', body: { dryRun: false } });
    await handleReconcileRoutes(req, deps, getAssets);
    const { payload } = req.getSent();
    assert.deepEqual(payload.queued, []);
    assert.deepEqual(payload.skipped.map((s) => s.boothId), ['111111', '424242']);
    assert.ok(payload.skipped[0].reason.includes('已经下过'));
    assert.ok(payload.skipped[1].reason.includes('没找到这个商品'));
  } finally {
    enqueueImpl = original;
  }
});

await checkAsync('队列里已有一件（state:queued）→ skipped「已经在下载队列里」', async () => {
  const original = enqueueImpl;
  enqueueImpl = async () => ({ ok: true, already: true, queued: false, job: { state: 'queued' } });
  try {
    const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/download-all', body: { dryRun: false, limit: 1 } });
    await handleReconcileRoutes(req, deps, getAssets);
    assert.ok(req.getSent().payload.skipped[0].reason.includes('已经在下载队列里'));
  } finally {
    enqueueImpl = original;
  }
});

await checkAsync('BOOTH 暂停中 → 409 + retryAfterMs，一个号都不入队（dryRun 也一样）', async () => {
  writePurchases();
  writePause(5 * 60 * 1000);
  try {
    enqueued.length = 0;
    for (const dryRun of [false, true]) {
      const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/download-all', body: { dryRun } });
      await handleReconcileRoutes(req, deps, getAssets);
      const { payload, code } = req.getSent();
      assert.equal(code, 409);
      assert.equal(payload.paused, true);
      assert.ok(/BOOTH 正在限速暂停，剩余 \d+ 分钟/.test(payload.error), payload.error);
      assert.ok(payload.retryAfterMs > 0);
      assert.equal(enqueued.length, 0);
    }
  } finally {
    clearPause();
  }
});

await checkAsync('agent 令牌 → 403，不入队', async () => {
  enqueued.length = 0;
  for (const header of ['x-agent-token', 'x-agent-call']) {
    const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/download-all', headers: { [header]: '1' }, body: { dryRun: false } });
    await handleReconcileRoutes(req, deps, getAssets);
    assert.equal(req.getSent().code, 403);
  }
  assert.equal(enqueued.length, 0);
});

await checkAsync('GET → 405；enqueue 未接线 → 503', async () => {
  const get = makeReq({ method: 'GET', pathname: '/api/library/reconcile/download-all' });
  await handleReconcileRoutes(get, deps, getAssets);
  assert.equal(get.getSent().code, 405);
  const bareDeps = { fs, path, STATE_DIR: tmp, ROOT, log: () => {}, atomicWriteJson };
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/download-all', body: { dryRun: true } });
  await handleReconcileRoutes(req, bareDeps, getAssets);
  assert.equal(req.getSent().code, 503);
  assert.ok(req.getSent().payload.error.includes('还没接线'));
});

await checkAsync('forget 接口只删台账、保留其它条目并回 removed', async () => {
  writePurchases();
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/forget', body: { boothIds: ['7850009'] } });
  await handleReconcileRoutes(req, deps, getAssets);
  const { payload, code } = req.getSent();
  assert.equal(code, 200);
  assert.equal(payload.removed, 1);
  assert.deepEqual(payload.removedIds, ['7850009']);
  assert.equal('7850009' in readPurchases().items, false);
  assert.equal(readPurchases().items['271777'].title, 'Astraea');
});

await checkAsync('/api/library/purchases/forget 别名 + 不存在的号 removed 0', async () => {
  writePurchases();
  const req = makeReq({ method: 'POST', pathname: '/api/library/purchases/forget', body: { boothIds: ['424242', '123456'] } });
  await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(req.getSent().payload.removed, 1);
  assert.deepEqual(req.getSent().payload.removedIds, ['424242']);
});

await checkAsync('forget：boothIds 里夹非法值 → 400 且不写盘', async () => {
  writePurchases();
  const before = fs.readFileSync(path.join(tmp, 'booth-purchases.json'), 'utf8');
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/forget', body: { boothIds: ['271777', 'abc'] } });
  await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(req.getSent().code, 400);
  assert.equal(fs.readFileSync(path.join(tmp, 'booth-purchases.json'), 'utf8'), before);
});

await checkAsync('forget：boothIds 不是数组 → 400', async () => {
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/forget', body: { boothIds: '271777' } });
  await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(req.getSent().code, 400);
});

console.log('## 鉴权 / 方法 / 请求体');
await checkAsync('agent 令牌：deep 读 → 403 不扫描', async () => {
  const req = makeReq({ search: 'deep=1', headers: { 'x-agent-token': 'x' } });
  let scanned = false;
  await handleReconcileRoutes(req, deps, async () => { scanned = true; return { assets: ASSETS }; });
  assert.equal(req.getSent().code, 403);
  assert.equal(req.getSent().payload.error, '已购对账只允许管理端操作');
  assert.equal(scanned, false);
});

await checkAsync('agent 令牌：sync 写 → 403 且不创建绑定文件', async () => {
  fs.rmSync(path.join(tmp, 'booth-binds.json'), { force: true });
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/bind', headers: { 'x-agent-call': '1' }, body: { boothId: '888888' } });
  await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(req.getSent().code, 403);
  assert.equal(req.getSent().payload.error, '同步接口只允许管理端操作');
  assert.equal(readBinds(), null);
});

await checkAsync('写接口用 GET → 405', async () => {
  const req = makeReq({ method: 'GET', pathname: '/api/library/reconcile/sync' });
  await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(req.getSent().code, 405);
});

await checkAsync('读接口用 POST → 405（老行为不变）', async () => {
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile' });
  await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(req.getSent().code, 405);
});

await checkAsync('请求体不是对象 → 400 中文原因', async () => {
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/sync', body: 'dryRun=true' });
  await handleReconcileRoutes(req, deps, getAssets);
  assert.equal(req.getSent().code, 400);
  assert.ok(req.getSent().payload.error.includes('JSON 对象'));
});

await checkAsync('未知路径 → false 且不响应（不吞别人的路由）', async () => {
  const req = makeReq({ pathname: '/api/library/reconcile/nope' });
  assert.equal(await handleReconcileRoutes(req, deps, getAssets), false);
  assert.equal(req.getSent(), null);
});

await checkAsync('getAssets 抛错：sync 写路径 → 500 且带「同步失败」', async () => {
  const req = makeReq({ method: 'POST', pathname: '/api/library/reconcile/sync', body: { dryRun: true } });
  await handleReconcileRoutes(req, deps, async () => { throw new Error('视图炸了'); });
  assert.equal(req.getSent().code, 500);
  assert.ok(req.getSent().payload.error.includes('同步失败'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
if (failures.length) {
  console.error(`❌ test-library-reconcile-sync：${pass} 通过 / ${failures.length} 失败`);
  console.error('   失败项：' + failures.join('；'));
  process.exit(1);
}
console.log(`🎉 test-library-reconcile-sync 全部通过（${pass} 项）`);
