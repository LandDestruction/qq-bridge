// BOOTH 三种失败态（gated / 429 / 404）+ 缓存过期 + 响应上限（假 fetch，离线）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  fetchBoothMeta,
  BOOTH_MAX_RESPONSE_BYTES
} from '../src/booth-meta.js';
import {
  ensureFileLedger,
  storeArchivedFile,
  archiveDirRel,
  enrichArchiveItem,
  listArchive,
  rowsNeedingEnrichment
} from '../src/file-archive.js';

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { fail += 1; console.error(`  FAIL ${name}: ${error?.message ?? error}`); }
}

const T0 = Date.UTC(2026, 0, 15, 4, 0, 0);
const GID = '100000001';
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-errors-cache-'));
// 全局暂停必须落在临时 state：否则 429 用例会把暂停写进仓库 state/，后续用例全被自己的暂停挡住。
const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-errors-state-'));

console.log('[1] 年龄墙（gated）：不丢条目，能拿 title/og:image');
await check('HTML 年齢確認 + og:image → status=gated 且带 thumb', async () => {
  const html = '<html><head><meta property="og:title" content="受限商品 - 店 - BOOTH"><meta property="og:image" content="https://booth.pximg.net/age.jpg"></head><body>年齢確認が必要です</body></html>';
  const fetchImpl = async (url) => (String(url).endsWith('.json')
    ? { status: 404, text: async () => '', headers: { get: () => null } }
    : { status: 200, text: async () => html, headers: { get: () => null } });
  const meta = await fetchBoothMeta('700001', { fetchImpl, cacheDir, now: T0, rateLimitMs: 1, stateDir: tmpState });
  assert.equal(meta.status, 'gated');
  assert.equal(meta.title, '受限商品');
  assert.equal(meta.thumbnailUrl, 'https://booth.pximg.net/age.jpg');
});

console.log('[2] 429：写全局暂停并直接收手（不再重试），上层记 failed（不抛）');
await check('HTML 429 重试 1 次；enrich 记 enrich_status=failed、不搬目录', async () => {
  let htmlCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('.json')) return { status: 404, text: async () => '', headers: { get: () => null } };
    htmlCalls += 1;
    return { status: 429, text: async () => '', headers: { get: () => null } };
  };
  const meta = await fetchBoothMeta('700002', { fetchImpl, cacheDir, now: T0, rateLimitMs: 1, stateDir: tmpState, timeoutMs: 1000 });
  assert.equal(meta.status, 'paused');
  assert.equal(meta.paused, true);
  assert.equal(htmlCalls, 1, '429 已经说明被限速，再重试等于往枪口上撞');
  const paused = JSON.parse(fs.readFileSync(path.join(tmpState, 'booth-search-pause.json'), 'utf8'));
  assert.equal(paused.status, 429, '429 写进了全局暂停');
  assert.ok(paused.pausedUntil > T0, '暂停到未来');
  // 后面的用例共用同一时钟 T0：不清掉这份暂停，它们会被「自己刚写的暂停」全挡住。
  fs.rmSync(path.join(tmpState, 'booth-search-pause.json'), { force: true });

  const db = new DatabaseSync(':memory:');
  ensureFileLedger(db);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-errors-'));
  try {
    const stored = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 'f429', fileName: '700002 商品.zip',
      buffer: Buffer.from('x'), archivedAt: T0, source: 'chat', baseDirRel: archiveDirRel({ groupId: GID })
    });
    const r = await enrichArchiveItem({ db, rootDir, id: stored.id, cfg: { booth: { enabled: true }, retention: null }, deps: { fetchBoothMeta: async () => meta }, nowMs: T0 });
    const row = listArchive(db, { limit: 10 })[0];
    assert.equal(r.relPath, stored.relPath, '抓取失败不能搬目录');
    assert.equal(row.enrichStatus, 'failed');
    assert.match(row.enrichError, /429|重试|HTTP/i);
    // failed 会进入「可重试」列表（1 天后）
    assert.equal(rowsNeedingEnrichment(db, { limit: 10, nowMs: T0 }).length, 0, '刚失败不立即重试');
    assert.equal(rowsNeedingEnrichment(db, { limit: 10, nowMs: T0 + 2 * 86400000 }).length, 1, '超过 1 天可重试');
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

console.log('[3] 404：标 not_found，且 7 天缓存内不再请求');
await check('两次 enrich 只真正抓一次（404 缓存生效）', async () => {
  const db = new DatabaseSync(':memory:');
  ensureFileLedger(db);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-errors-'));
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { status: 404, text: async () => '', headers: { get: () => null } }; };
  try {
    const stored = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 'f404', fileName: '700003 不存在.zip',
      buffer: Buffer.from('x'), archivedAt: T0, source: 'chat', baseDirRel: archiveDirRel({ groupId: GID })
    });
    const deps = { fetchBoothMeta: (id) => fetchBoothMeta(id, { fetchImpl, cacheDir, now: T0, rateLimitMs: 1, stateDir: tmpState }) };
    await enrichArchiveItem({ db, rootDir, id: stored.id, cfg: { booth: { enabled: true }, retention: null }, deps, nowMs: T0 });
    const firstCalls = calls;
    assert.equal(firstCalls, 3, 'ja.json + zh-cn.json + HTML');
    await enrichArchiveItem({ db, rootDir, id: stored.id, cfg: { booth: { enabled: true }, retention: null }, deps, nowMs: T0 + 1000 });
    assert.equal(calls, firstCalls, '404 缓存 7 天内不再请求');
    const row = listArchive(db, { limit: 10 })[0];
    assert.equal(row.enrichStatus, 'not_found');
    assert.equal(rowsNeedingEnrichment(db, { limit: 10, nowMs: T0 + 3 * 86400000 }).length, 0, 'not_found 不自动重试');
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

console.log('[4] 缓存过期后重新抓取');
await check('成功缓存 30 天后失效，会再发请求', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cache-expire-'));
  let calls = 0;
  const html = '<html><head><meta property="og:title" content="A - 店 - BOOTH"><meta property="og:image" content="https://x/a.jpg"></head></html>';
  const fetchImpl = async (url) => {
    calls += 1;
    if (String(url).endsWith('.json')) return { status: 404, text: async () => '', headers: { get: () => null } };
    return { status: 200, text: async () => html, headers: { get: () => null } };
  };
  const now = T0;
  await fetchBoothMeta('700004', { fetchImpl, cacheDir: dir, now, rateLimitMs: 1, stateDir: tmpState });
  const afterFirst = calls;
  await fetchBoothMeta('700004', { fetchImpl, cacheDir: dir, now: now + 1000, rateLimitMs: 1, stateDir: tmpState });
  assert.equal(calls, afterFirst, '缓存有效期内不重复请求');
  const later = now + 31 * 86400000;
  const meta = await fetchBoothMeta('700004', { fetchImpl, cacheDir: dir, now: later, rateLimitMs: 1, stateDir: tmpState });
  assert.equal(calls, afterFirst + 3, '过期后重新抓（ja.json 404 + zh-cn.json 404 + HTML）');
  assert.equal(meta.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('[5] 单次响应上限 2MB');
await check('超过 BOOTH_MAX_RESPONSE_BYTES 的 HTML → error，不抛', async () => {
  const big = 'x'.repeat(BOOTH_MAX_RESPONSE_BYTES + 1024);
  const fetchImpl = async (url) => (String(url).endsWith('.json')
    ? { status: 404, text: async () => '', headers: { get: () => null } }
    : { status: 200, text: async () => big, headers: { get: () => String(big.length) } });
  const meta = await fetchBoothMeta('700005', { fetchImpl, cacheDir, now: T0, rateLimitMs: 1, stateDir: tmpState });
  assert.equal(meta.status, 'error');
  assert.match(meta.error, /2MB|上限|超过/i);
});

console.log('[6] 缩略图规格化失败 → thumbStatus=fallback，仍写 meta');
await check('downloadThumb 返回 fallback：卡片有图、meta 有 files', async () => {
  const db = new DatabaseSync(':memory:');
  ensureFileLedger(db);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-errors-'));
  try {
    const stored = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 'fb', fileName: '700006 商品.zip',
      buffer: Buffer.from('x'), archivedAt: T0, source: 'chat', baseDirRel: archiveDirRel({ groupId: GID })
    });
    const deps = {
      fetchBoothMeta: async () => ({ status: 'ok', title: 'T', shop: 'S', price: '', tags: [], thumbnailUrl: 'https://x/t.png', itemUrl: '', category: '素材', error: '' }),
      downloadThumb: async (url, destAbs) => { fs.writeFileSync(destAbs, Buffer.from('raw')); return { ok: true, status: 'fallback', bytes: 3 }; }
    };
    const r = await enrichArchiveItem({ db, rootDir, id: stored.id, cfg: { booth: { enabled: true }, retention: null }, deps, nowMs: T0 });
    const row = listArchive(db, { limit: 10 })[0];
    assert.equal(row.thumbStatus, 'fallback');
    assert.equal(fs.existsSync(path.join(rootDir, row.thumbRel)), true);
    const meta = JSON.parse(fs.readFileSync(path.join(rootDir, path.dirname(r.relPath), 'meta.json'), 'utf8'));
    assert.equal(meta.files.length, 1);
    assert.equal(meta.thumbStatus, 'fallback');
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

fs.rmSync(cacheDir, { recursive: true, force: true });
console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
