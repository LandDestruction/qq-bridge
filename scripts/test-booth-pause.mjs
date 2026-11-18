// BOOTH 全局限速暂停（P2）：纯规则 + 状态文件读写 + 「所有抓取入口共用同一份暂停」的闭环。
// 这条链路的意义在于：429/403 一出现，找号搜索、商品页抓取、封面抓取、已购同步必须一起停；
// 只要有一个入口还照打，出口 IP 就会被打黑（线上真踩过：搜索退避了、补封面还在敲门）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BOOTH_PAUSE_FILE,
  SEARCH_PAUSE_429_MS,
  SEARCH_PAUSE_403_MS,
  SEARCH_PAUSE_MIN_MS,
  SEARCH_PAUSE_MAX_MS,
  defaultStateDir,
  pauseFilePath,
  searchPauseFor,
  normalizeSearchPause,
  searchPauseState,
  describeSearchPause,
  pauseErrorMessage,
  pauseRecordFrom,
  readPause,
  writePause,
  noteBoothPause,
  retryAfterOf
} from '../src/booth-pause.js';
import { fetchBoothMeta } from '../src/booth-meta.js';
import { getBoothCover } from '../src/booth-cover.js';

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { fail += 1; console.error(`  FAIL ${name}: ${error?.message ?? error}`); }
}

const T0 = 1_700_000_000_000;
const mkState = () => fs.mkdtempSync(path.join(os.tmpdir(), 'booth-pause-'));

console.log('[1] 纯规则：哪些响应触发暂停、停多久');
await check('429 无 Retry-After → 默认停 10 分钟', () => {
  const hit = searchPauseFor({ status: 429 });
  assert.equal(hit.status, 429);
  assert.equal(hit.pauseMs, SEARCH_PAUSE_429_MS);
  assert.match(hit.reason, /429/);
});
await check('429 带 Retry-After（秒）→ 按它停', () => {
  assert.equal(searchPauseFor({ status: 429, retryAfter: 120 }).pauseMs, 120_000);
  // 30 秒小于退避下限（1 分钟），会被夹到下限——BOOTH 说 30 秒也别 30 秒后再打。
  assert.equal(searchPauseFor({ status: 429, retryAfter: '30' }).pauseMs, SEARCH_PAUSE_MIN_MS);
});
await check('Retry-After 过小/过大都被夹到 [1 分钟, 6 小时]', () => {
  assert.equal(searchPauseFor({ status: 429, retryAfter: 1 }).pauseMs, SEARCH_PAUSE_MIN_MS);
  assert.equal(searchPauseFor({ status: 429, retryAfter: 0.5 }).pauseMs, SEARCH_PAUSE_MIN_MS);
  assert.equal(searchPauseFor({ status: 429, retryAfter: 999_999 }).pauseMs, SEARCH_PAUSE_MAX_MS);
  assert.equal(SEARCH_PAUSE_MIN_MS, 60_000);
  assert.equal(SEARCH_PAUSE_MAX_MS, 6 * 3600 * 1000);
});
await check('403 → 停 30 分钟；其它状态码不暂停', () => {
  const hit = searchPauseFor({ status: 403 });
  assert.equal(hit.status, 403);
  assert.equal(hit.pauseMs, SEARCH_PAUSE_403_MS);
  for (const status of [0, 200, 404, 500, 502, NaN, 'abc']) {
    assert.equal(searchPauseFor({ status }), null, `${status} 不该触发暂停`);
  }
});
await check('retryAfterOf：数字头正常解析，缺失/非数字给 null', () => {
  assert.equal(retryAfterOf({ get: () => '120' }), 120);
  assert.equal(retryAfterOf({ get: () => '0' }), null);
  assert.equal(retryAfterOf({ get: () => 'abc' }), null);
  assert.equal(retryAfterOf({ get: () => null }), null);
  assert.equal(retryAfterOf(null), null);
});

console.log('[2] 纯规则：坏数据永远当「没暂停」');
await check('normalizeSearchPause：null / 数组 / 字符串 / 空对象 → 全零', () => {
  for (const raw of [null, undefined, [], 'x', 42, {}]) {
    const rec = normalizeSearchPause(raw, T0);
    assert.equal(rec.pausedUntil, 0);
    assert.equal(rec.reason, '');
    assert.equal(rec.status, 0);
    assert.equal(rec.at, 0);
  }
});
await check('normalizeSearchPause：pausedUntil 超上限被夹到 now+6 小时', () => {
  const rec = normalizeSearchPause({ pausedUntil: T0 + 999 * 3600 * 1000 }, T0);
  assert.equal(rec.pausedUntil, T0 + SEARCH_PAUSE_MAX_MS);
});
await check('normalizeSearchPause：reason 截断 200 字、非法 at 归零', () => {
  const rec = normalizeSearchPause({ pausedUntil: T0 + 1000, reason: 'x'.repeat(500), at: -5 }, T0);
  assert.equal(rec.reason.length, 200);
  assert.equal(rec.at, 0);
});
await check('searchPauseState：暂停中给剩余毫秒，过期给 0', () => {
  const paused = searchPauseState({ pausedUntil: T0 + 90_000 }, T0);
  assert.equal(paused.paused, true);
  assert.equal(paused.remainingMs, 90_000);
  assert.equal(searchPauseState({ pausedUntil: T0 - 1 }, T0).paused, false);
  assert.equal(searchPauseState(null, T0).paused, false);
});
await check('describeSearchPause：未暂停空串；分钟 / 小时两种人话', () => {
  assert.equal(describeSearchPause(null, T0), '');
  assert.match(describeSearchPause({ pausedUntil: T0 + 5 * 60_000, reason: '限速' }, T0), /限速.*还要等约 5 分钟/);
  assert.match(describeSearchPause({ pausedUntil: T0 + 90 * 60_000, reason: '限速' }, T0), /1 小时 30 分钟/);
});
await check('pauseErrorMessage：未暂停空串；暂停中「剩余 N 分钟」', () => {
  assert.equal(pauseErrorMessage(null, T0), '');
  const text = pauseErrorMessage({ pausedUntil: T0 + 4 * 60_000 }, T0);
  assert.equal(text, 'BOOTH 正在限速暂停，剩余 4 分钟');
});
await check('pauseRecordFrom：429/403 生成记录，其它 null；pausedUntil = now + pauseMs', () => {
  const rec = pauseRecordFrom({ status: 429, retryAfter: 60, now: T0 });
  assert.equal(rec.pausedUntil, T0 + 60_000);
  assert.equal(rec.status, 429);
  assert.equal(rec.at, T0);
  assert.equal(pauseRecordFrom({ status: 403, now: T0 }).pausedUntil, T0 + SEARCH_PAUSE_403_MS);
  assert.equal(pauseRecordFrom({ status: 500, now: T0 }), null);
});

console.log('[3] 状态文件：原子写、坏文件当没暂停、清除写全零');
await check('默认路径：仓库根/state/booth-search-pause.json（沿用线上文件名）', () => {
  assert.equal(BOOTH_PAUSE_FILE, 'booth-search-pause.json');
  assert.ok(defaultStateDir().endsWith(`${path.sep}state`));
  assert.equal(pauseFilePath('/tmp/x'), path.join('/tmp/x', 'booth-search-pause.json'));
});
await check('writePause → readPause 往返一致，且不留 .tmp 残file', async () => {
  const st = mkState();
  try {
    await writePause({ stateDir: st, now: T0 }, { pausedUntil: T0 + 120_000, reason: '测试', status: 429, at: T0 });
    const rec = await readPause({ stateDir: st, now: T0 });
    assert.equal(rec.pausedUntil, T0 + 120_000);
    assert.equal(rec.reason, '测试');
    assert.equal(rec.status, 429);
    const files = fs.readdirSync(st);
    assert.deepEqual(files, [BOOTH_PAUSE_FILE], `目录里只该有状态文件（实际 ${files.join(',')}）`);
  } finally { fs.rmSync(st, { recursive: true, force: true }); }
});
await check('readPause：文件不存在 / JSON 坏了 / 类型不对 → 都当没暂停（不抛）', async () => {
  const st = mkState();
  try {
    assert.equal(searchPauseState(await readPause({ stateDir: st, now: T0 }), T0).paused, false);
    fs.writeFileSync(path.join(st, BOOTH_PAUSE_FILE), '{ 坏掉的 json');
    assert.equal(searchPauseState(await readPause({ stateDir: st, now: T0 }), T0).paused, false);
    fs.writeFileSync(path.join(st, BOOTH_PAUSE_FILE), '[1,2,3]');
    assert.equal(searchPauseState(await readPause({ stateDir: st, now: T0 }), T0).paused, false);
    fs.writeFileSync(path.join(st, BOOTH_PAUSE_FILE), '\uFEFF{"pausedUntil":' + (T0 + 1000) + '}');
    assert.equal(searchPauseState(await readPause({ stateDir: st, now: T0 }), T0).paused, true, 'BOM 也要能读');
  } finally { fs.rmSync(st, { recursive: true, force: true }); }
});
await check('writePause(normalize(null)) 等于清除：读回来 paused=false', async () => {
  const st = mkState();
  try {
    await writePause({ stateDir: st, now: T0 }, { pausedUntil: T0 + 60_000, reason: 'x', status: 429 });
    assert.equal(searchPauseState(await readPause({ stateDir: st, now: T0 }), T0).paused, true);
    await writePause({ stateDir: st, now: T0 }, normalizeSearchPause(null, T0));
    assert.equal(searchPauseState(await readPause({ stateDir: st, now: T0 }), T0).paused, false);
  } finally { fs.rmSync(st, { recursive: true, force: true }); }
});
await check('noteBoothPause：429/403 写盘并返回记录，500 不写', async () => {
  const st = mkState();
  try {
    const hit = await noteBoothPause({ stateDir: st, now: T0 }, { status: 403 });
    assert.equal(hit.status, 403);
    assert.equal(hit.pausedUntil, T0 + SEARCH_PAUSE_403_MS);
    assert.equal(searchPauseState(await readPause({ stateDir: st, now: T0 }), T0).paused, true);
    assert.equal(await noteBoothPause({ stateDir: st, now: T0 }, { status: 500 }), null);
  } finally { fs.rmSync(st, { recursive: true, force: true }); }
});
await check('writePause：state 目录不存在会自动建', async () => {
  const parent = mkState();
  const st = path.join(parent, 'nested', 'state');
  try {
    await writePause({ stateDir: st, now: T0 }, { pausedUntil: T0 + 1000 });
    assert.equal(fs.existsSync(path.join(st, BOOTH_PAUSE_FILE)), true);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

console.log('[4] 抓取入口互相看得见同一份暂停（商品页 ↔ 封面 ↔ 搜索）');
await check('封面抓取遇到 429 写暂停 → 商品页抓取直接 paused，0 次请求', async () => {
  const st = mkState();
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-pause-cache-'));
  const now = 5_000_000;
  try {
    let coverCalls = 0;
    const cover = await getBoothCover('9038753', {
      cacheRoot, stateDir: st, now, rateLimitMs: 1,
      fetchImpl: async () => { coverCalls += 1; return { status: 429, headers: { get: () => '300' }, text: async () => '' }; }
    });
    assert.equal(cover.status, 'paused');
    assert.equal(coverCalls, 1);

    let metaCalls = 0;
    const meta = await fetchBoothMeta('9038753', {
      stateDir: st, cacheDir: cacheRoot, now: now + 1000, rateLimitMs: 1,
      fetchImpl: async () => { metaCalls += 1; return { status: 200, text: async () => '<html></html>' }; }
    });
    assert.equal(meta.status, 'paused');
    assert.equal(metaCalls, 0, '封面写的暂停，商品页必须同样遵守');
    assert.match(meta.error, /剩余 \d+ 分钟/);
  } finally {
    fs.rmSync(st, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});
await check('商品页遇到 403 写暂停 → 封面抓取直接 paused，0 次请求', async () => {
  const st = mkState();
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-pause-cache-'));
  const now = 6_000_000;
  try {
    let metaCalls = 0;
    const meta = await fetchBoothMeta('9038753', {
      stateDir: st, cacheDir: cacheRoot, now, rateLimitMs: 1,
      fetchImpl: async (url) => {
        metaCalls += 1;
        if (String(url).endsWith('.json')) return { status: 404, text: async () => '' };
        return { status: 403, text: async () => '' };
      }
    });
    assert.equal(meta.status, 'blocked', '403 保留旧 status 名');
    assert.equal(meta.paused, true);

    let coverCalls = 0;
    const cover = await getBoothCover('9038753', {
      cacheRoot, stateDir: st, now: now + 1000, rateLimitMs: 1,
      fetchImpl: async () => { coverCalls += 1; return { status: 200, text: async () => '<html></html>' }; }
    });
    assert.equal(cover.status, 'paused');
    assert.equal(coverCalls, 0, '商品页写的暂停，封面必须同样遵守');
    const saved = JSON.parse(fs.readFileSync(path.join(st, BOOTH_PAUSE_FILE), 'utf8'));
    assert.equal(saved.status, 403);
  } finally {
    fs.rmSync(st, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
