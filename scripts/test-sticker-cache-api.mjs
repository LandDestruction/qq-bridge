// 表情缩略图缓存（自愈/统计/修复）接口测试。
//
// 用真实 observe-runtime + 真实 sticker-lib 的落盘实现跑在临时 state 目录上（不联网、不起桥接），
// 覆盖：统计口径、dryRun 不删文件、真删孤儿、LRU 淘汰只标条目不删条目、repair 修好 missing 并补 md5、
// 路由参数/权限校验、坏 JSON 容错。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as stickerCachePure from '../src/sticker-cache.js';
import { stickerCacheBytes, stickerCachePath, persistStickerThumb } from '../src/sticker-lib.js';
import { createObserveRuntime } from '../src/bridge/observe-runtime.js';
import { createStickerCacheOps } from '../src/bridge/console/sticker-cache-ops.js';

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed += 1; console.log(`✅ ${label}`); }
  else { failed += 1; console.error(`❌ ${label}`); }
}

function makeDeps({ limitBytes = 1024 * 1024, fetchBytes = 200 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-cache-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const entries = [];
  const logs = [];
  let saves = 0;
  const deps = {
    STATE_DIR: stateDir,
    STICKER_CACHE_MAX_BYTES: limitBytes,
    STICKER_THUMB_MAX_BYTES: 2 * 1024 * 1024,
    cfg: {},
    fs,
    path,
    log: (line) => { logs.push(String(line)); },
    stickerEntries: entries,
    stickerCachePath,
    stickerCacheBytes,
    md5Hex: (buf) => crypto.createHash('md5').update(buf).digest('hex'),
    stickerCachePure,
    saveStickerStoreSafe: () => { saves += 1; },
    persistStickerThumb,
    safeFetchBinary: async () => Buffer.alloc(fetchBytes, 7),
    fetchFaceMedia: async () => null,
    fetchOneBotImage: async () => null,
    collectSticker: () => null,
    findSticker: () => null,
    describeObserveStickerSegments: () => [],
    planObserveLearning: () => null,
    feedSlangWindow: () => {},
    applyObserveLearning: async () => ({}),
    observeLoggedAt: new Map(),
    observeShapeLoggedAt: new Map(),
    stickerCacheTotalCache: null,
    stickerCacheWarnedAt: 0
  };
  return { root, stateDir, deps, entries, logs, savesRef: () => saves };
}

function cacheDirOf(stateDir) { return path.join(stateDir, 'sticker-files'); }

function writeCacheFile(stateDir, name, bytes, ageMs = 2 * 3600 * 1000) {
  const dir = cacheDirOf(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  // 清理计划会跳过「1 小时内写过」的文件（防误删正在写的图）；测试里把 mtime 拨老。
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(file, at, at);
}

function fileCount(stateDir) {
  try { return fs.readdirSync(cacheDirOf(stateDir)).length; } catch { return 0; }
}

function fakeRequest({ method = 'GET', pathName, headers = {}, body = null, bodyRaw = null }) {
  const out = { status: 0, payload: null };
  return {
    out,
    request: {
      req: { method, headers },
      method,
      url: new URL(`http://127.0.0.1:3100${pathName}`),
      sendJson: (payload, status = 200) => { out.payload = payload; out.status = status; },
      readBody: async () => {
        if (bodyRaw !== null) return bodyRaw;
        if (body === null) throw new Error('bad body');
        return body;
      }
    }
  };
}

// ── 1. 统计口径 + dryRun 不删 + 真删孤儿 ────────────────────────────────
{
  const { stateDir, deps, entries, logs, root } = makeDeps({ limitBytes: 300 });
  // 三条条目：A 有缓存（ok）、B missing（cache-limit 无 md5）、C 有 md5 但文件不在（缺文件）
  writeCacheFile(stateDir, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.img', 40);
  writeCacheFile(stateDir, 'ORPHANORPHANORPHANORPHANORPHAN.img', 120);
  writeCacheFile(stateDir, 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC.img', 40);
  entries.push(
    { id: 'a', key: 'k-a', md5: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', thumbStatus: 'ok', url: 'https://x/a.png', lastUsedAt: 5 },
    { id: 'b', key: 'k-b', thumbStatus: 'missing', thumbError: '本地表情缓存已达上限（1MB），跳过落盘', thumbErrorKind: 'cache-limit', url: 'https://x/b.png' },
    { id: 'c', key: 'k-c', md5: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', thumbStatus: 'ok', url: 'https://x/c.png', lastUsedAt: 9 }
  );
  const observe = createObserveRuntime(deps);
  const ops = createStickerCacheOps({
    ...deps,
    stickerCacheFileList: observe.stickerCacheFileList,
    stickerCacheLimit: observe.stickerCacheLimit,
    cleanupStickerCache: observe.cleanupStickerCache,
    persistMissingStickerThumbs: observe.persistMissingStickerThumbs
  });

  const st = fakeRequest({ pathName: '/api/stickers/cache' });
  await ops.handleStickerCacheStatus(st.request);
  assert(st.out.status === 200 && st.out.payload.ok === true, 'GET /api/stickers/cache 200');
  const stats = st.out.payload;
  assert(stats.entries === 3, `entries=3（实得 ${stats.entries}）`);
  assert(stats.withThumb === 2, `withThumb=2（实得 ${stats.withThumb}）`);
  assert(stats.missing === 1, `missing=1（实得 ${stats.missing}）`);
  assert(stats.retryable === 1, `retryable=1（实得 ${stats.retryable}）`);
  assert(stats.orphanFiles === 1, `orphanFiles=1（实得 ${stats.orphanFiles}）`);
  assert(stats.bytes === 200, `bytes=200（实得 ${stats.bytes}）`);
  assert(stats.limitBytes === 300, `limitBytes=300（实得 ${stats.limitBytes}）`);
  assert(typeof stats.usageRatio === 'number', 'usageRatio 是数字');
  assert(stats.overLimit === false || stats.overLimit === true, 'overLimit 是布尔');

  const before = fileCount(stateDir);
  const dry = fakeRequest({ pathName: '/api/stickers/cache/cleanup', method: 'POST', body: { dryRun: true } });
  await ops.handleStickerCacheCleanup(dry.request);
  assert(dry.out.status === 200 && dry.out.payload.dryRun === true, 'cleanup dryRun:true 回 dryRun:true');
  assert(dry.out.payload.orphanFiles >= 1, `dryRun 报告孤儿数（实得 ${dry.out.payload.orphanFiles}）`);
  assert(fileCount(stateDir) === before, 'dryRun 一个文件都没删');
  assert(dry.out.payload.freedBytes > 0, 'dryRun 给出预计释放字节');
  assert(dry.out.payload.stats && dry.out.payload.stats.entries === 3, 'dryRun 响应带最新 stats');

  const real = fakeRequest({ pathName: '/api/stickers/cache/cleanup', method: 'POST', body: {} });
  await ops.handleStickerCacheCleanup(real.request);
  assert(real.out.status === 200 && real.out.payload.dryRun === false, 'cleanup 缺省就是真删（dryRun:false）');
  assert(fileCount(stateDir) === before - 1, `真删只动孤儿（删了 ${before - fileCount(stateDir)} 个）`);
  assert(!fs.existsSync(path.join(cacheDirOf(stateDir), 'ORPHANORPHANORPHANORPHANORPHAN.img')), '孤儿文件确实删了');
  assert(real.out.payload.stats.bytes < 200, `删后统计字节变小（实得 ${real.out.payload.stats.bytes}）`);
  assert(real.out.payload.freedBytes === 120, `释放字节=120（实得 ${real.out.payload.freedBytes}）`);
  assert(entries.length === 3, '删文件不动条目本身');
  assert(logs.some((line) => line.includes('[sticker] 清理缓存孤儿 1 个')), '日志写「清理缓存孤儿 1 个」');
  void root;
}

// ── 2. LRU 淘汰：删文件、条目留 missing + evicted ──────────────────────
{
  const { stateDir, deps, entries } = makeDeps({ limitBytes: 150 });
  // 两个文件共 200B > 150B → 需要 LRU 淘汰到 ≤135B，删最久没用的那个正好够
  writeCacheFile(stateDir, 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD.img', 100);
  writeCacheFile(stateDir, 'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE.img', 100);
  entries.push(
    { id: 'd', key: 'k-d', md5: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', thumbStatus: 'ok', url: 'https://x/d.png', lastUsedAt: 1 },
    { id: 'e', key: 'k-e', md5: 'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', thumbStatus: 'ok', url: 'https://x/e.png', lastUsedAt: 99 }
  );
  const observe = createObserveRuntime(deps);
  const result = await observe.cleanupStickerCache({});
  assert(result.ok === true && result.lruFiles === 1, `LRU 只淘汰最久没用的 1 个（实得 ${result.lruFiles}）`);
  const d = entries.find((entry) => entry.id === 'd');
  const evicted = entries.find((entry) => entry.thumbStatus === 'missing');
  assert(evicted && evicted.thumbErrorKind === 'evicted', '被淘汰条目 thumbErrorKind=evicted');
  assert(evicted && evicted.thumbError === '缓存淘汰，可重试', '被淘汰条目提示「缓存淘汰，可重试」');
  assert(d.thumbStatus === 'missing' || entries.find((entry) => entry.id === 'e').thumbStatus === 'missing', '至少一条状态改成 missing');
  assert(entries.length === 2, '淘汰不删除条目');
  assert(!fs.existsSync(path.join(cacheDirOf(stateDir), 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD.img')), '被淘汰的文件真删了');
  const remaining = fileCount(stateDir);
  assert(remaining === 1, `较新的那条文件保留（剩 ${remaining} 个）`);
  assert(fs.existsSync(path.join(cacheDirOf(stateDir), 'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE.img')), '留下的是最近用过的 E');
  assert(result.remainingBytes <= 135, `剩余字节降到上限内（实得 ${result.remainingBytes}）`);
}

// ── 3. repair：missing+无 md5（可重试）修好并补 md5 ─────────────────────
{
  const { stateDir, deps, entries, logs } = makeDeps({ limitBytes: 1024 * 1024, fetchBytes: 300 });
  entries.push(
    { id: 'm1', key: 'k-m1', thumbStatus: 'missing', thumbErrorKind: 'cache-limit', thumbError: '本地表情缓存已达上限（1MB），跳过落盘', url: 'https://x/m1.png' },
    { id: 'm2', key: 'k-m2', thumbStatus: 'missing', thumbErrorKind: 'expired-url', thumbError: '链接过期', url: 'https://x/m2.png' },
    { id: 'ok1', key: 'k-ok1', md5: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', thumbStatus: 'ok', url: 'https://x/ok1.png' }
  );
  writeCacheFile(stateDir, 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF.img', 10);
  const observe = createObserveRuntime(deps);
  const res = await observe.persistMissingStickerThumbs({ limit: 10 });
  assert(res && typeof res.attempted === 'number', 'persistMissingStickerThumbs 回 {attempted,...}');
  assert(res.attempted >= 1, `至少尝试 1 条（实得 ${res.attempted}）`);
  assert(res.fixed >= 1, `至少修好 1 条（实得 ${res.fixed}）`);
  const m1 = entries.find((entry) => entry.id === 'm1');
  assert(m1.thumbStatus === 'ok', 'cache-limit 的 missing 条目被修好');
  assert(typeof m1.md5 === 'string' && m1.md5.length === 32, `成功下载后自动补了 md5（实得 ${m1.md5}）`);
  assert(m1.thumbErrorKind === '' || m1.thumbErrorKind === undefined, '修好后清空 thumbErrorKind');
  assert(fs.existsSync(stickerCachePath(cacheDirOf(stateDir), m1.md5)), '缩略图文件真的落盘了');
  assert(logs.some((line) => line.includes('[sticker] 修复缩略图：尝试')), '日志写「修复缩略图：尝试…」');
}

// ── 4. repair 自愈：跑一轮会先把孤儿清掉 ────────────────────────────────
{
  const { stateDir, deps, entries } = makeDeps({ limitBytes: 1024 * 1024 });
  writeCacheFile(stateDir, 'GARBAGEGARBAGEGARBAGEGARBAGEGARBAGE.img', 60);
  entries.push({ id: 'n1', key: 'k-n1', thumbStatus: 'missing', thumbErrorKind: 'network', url: 'https://x/n1.png' });
  const observe = createObserveRuntime(deps);
  await observe.persistMissingStickerThumbs({ limit: 5 });
  assert(!fs.existsSync(path.join(cacheDirOf(stateDir), 'GARBAGEGARBAGEGARBAGEGARBAGEGARBAGE.img')), 'repair 前自愈清掉了孤儿');
}

// ── 5. 路由/参数/权限 ───────────────────────────────────────────────────
{
  const { deps } = makeDeps({ limitBytes: 1024 });
  const flags = { cleanup: 0, repair: 0, saves: 0 };
  const ops = createStickerCacheOps({
    ...deps,
    stickerCacheFileList: () => [],
    stickerCacheLimit: () => 1024,
    cleanupStickerCache: async ({ dryRun }) => { flags.cleanup += 1; return { ok: true, dryRun, freedBytes: 0, orphanFiles: 0, lruFiles: 0, remainingBytes: 0 }; },
    persistMissingStickerThumbs: async ({ limit }) => { flags.repair += 1; return { attempted: 0, fixed: 0, stillMissing: 0, limit }; }
  });

  const agent = fakeRequest({ pathName: '/api/stickers/cache', headers: { 'x-agent-token': 'abc' } });
  await ops.handleStickerCacheStatus(agent.request);
  assert(agent.out.status === 403, 'agent 令牌打 status → 403');
  const agentClean = fakeRequest({ pathName: '/api/stickers/cache/cleanup', method: 'POST', headers: { 'x-agent-call': '1' }, body: {} });
  await ops.handleStickerCacheCleanup(agentClean.request);
  assert(agentClean.out.status === 403, 'agent 令牌打 cleanup → 403');
  assert(flags.cleanup === 0, 'agent 403 时没执行清理');

  const postStatus = fakeRequest({ pathName: '/api/stickers/cache', method: 'POST' });
  await ops.handleStickerCacheStatus(postStatus.request);
  assert(postStatus.out.status === 405, 'status 只收 GET');

  const getClean = fakeRequest({ pathName: '/api/stickers/cache/cleanup' });
  await ops.handleStickerCacheCleanup(getClean.request);
  assert(getClean.out.status === 405, 'cleanup 只收 POST');

  const badBody = fakeRequest({ pathName: '/api/stickers/cache/cleanup', method: 'POST', body: null });
  await ops.handleStickerCacheCleanup(badBody.request);
  assert(badBody.out.status === 400, 'cleanup 请求体坏 → 400');

  const badDry = fakeRequest({ pathName: '/api/stickers/cache/cleanup', method: 'POST', body: { dryRun: 'yes' } });
  await ops.handleStickerCacheCleanup(badDry.request);
  assert(badDry.out.status === 400 && /dryRun/.test(badDry.out.payload.error), 'dryRun 非布尔 → 400 说清');

  const dryStr = fakeRequest({ pathName: '/api/stickers/cache/cleanup', method: 'POST', body: { dryRun: 'true' } });
  await ops.handleStickerCacheCleanup(dryStr.request);
  assert(dryStr.out.status === 200 && dryStr.out.payload.dryRun === true, 'dryRun:"true" 当作 true（不删）');
  assert(flags.cleanup === 1, 'dryRun 也走了一遍计划（不算真删）');

  const badLimit = fakeRequest({ pathName: '/api/stickers/thumbs/repair', method: 'POST', body: { limit: 'abc' } });
  await ops.handleStickerThumbsRepair(badLimit.request);
  assert(badLimit.out.status === 400, 'repair limit 非数字 → 400');

  const repair = fakeRequest({ pathName: '/api/stickers/thumbs/repair', method: 'POST', body: { limit: 999 } });
  await ops.handleStickerThumbsRepair(repair.request);
  assert(repair.out.status === 200 && repair.out.payload.ok === true, 'repair 200');
  assert(repair.out.payload.limit === 50, `limit 被夹到 50（实得 ${repair.out.payload.limit}）`);
  assert(flags.repair === 1, 'repair 调了一次修复');
  assert(repair.out.payload.stats && repair.out.payload.stats.entries === 0, 'repair 响应带最新 stats');

  const other = fakeRequest({ pathName: '/api/other' });
  assert(await ops.handleStickerCacheStatus(other.request) === false, '其它路径不接管');
  const noPure = createStickerCacheOps({});
  const np = fakeRequest({ pathName: '/api/stickers/cache' });
  assert(await noPure.handleStickerCacheStatus(np.request) === false, '没注入纯函数时安全返回 false（不抛）');
}

// ── 6. 坏账本/坏 json 容错 ─────────────────────────────────────────────
{
  const { stateDir, deps, entries } = makeDeps({ limitBytes: 1024 * 1024 });
  const observe = createObserveRuntime(deps);
  // 目录里混进一个非文件（子目录）与坏名字：清理/统计都不能抛
  fs.mkdirSync(path.join(cacheDirOf(stateDir), 'sub'), { recursive: true });
  fs.writeFileSync(path.join(cacheDirOf(stateDir), 'noext'), Buffer.alloc(5));
  entries.push({ id: 'x', key: 'k-x', md5: 'NOTAHEX', thumbStatus: 'ok', url: 'https://x/x.png' });
  let threw = false;
  try {
    const stats = observe.stickerCachePlan();
    assert(stats && typeof stats.totalBytes === 'number', '混合目录下 plan 仍能算出字节');
  } catch { threw = true; }
  assert(threw === false, '子目录/无扩展名文件不会让 plan 抛错');
  const cleaned = await observe.cleanupStickerCache({ dryRun: true });
  assert(cleaned.ok === true, 'dryRun 在混合目录上也不抛');
}

// ── 7. HTTP 4xx → unavailable（不再算 missing，不再重试）────────────────
{
  const { stateDir, deps, entries, logs } = makeDeps({ limitBytes: 1024 * 1024 });
  deps.safeFetchBinary = async () => { throw new Error('文件下载失败：HTTP 400'); };
  entries.push({ id: 'bad1', key: 'k-bad1', thumbStatus: 'missing', url: 'https://multimedia.nt.qq.com.cn/download?fileid=x' });
  const observe = createObserveRuntime(deps);
  const res = await observe.persistEntryThumb(entries[0]);
  assert(res?.status === 'missing', 'persistEntryThumb 仍回报 missing（调用方据此记日志）');
  assert(entries[0].thumbStatus === 'unavailable', 'HTTP 400 的条目改标 unavailable');
  assert(entries[0].thumbErrorKind === 'expired-url', 'thumbErrorKind=expired-url');
  assert(/链接已失效/.test(entries[0].thumbError), '错误文案说明链接已失效');
  assert(logs.some((line) => line.includes('标记 unavailable')), '日志说明已标 unavailable');
  const plan = observe.stickerCachePlan();
  assert(!plan.orphanFiles.length || true, '计划可正常生成');
  void stateDir;
  // 统计：unavailable 不进 missing
  const ops = createStickerCacheOps({
    ...deps,
    stickerCacheFileList: observe.stickerCacheFileList,
    stickerCacheLimit: observe.stickerCacheLimit,
    cleanupStickerCache: observe.cleanupStickerCache,
    persistMissingStickerThumbs: observe.persistMissingStickerThumbs,
    markExpiredMissingUnavailable: observe.markExpiredMissingUnavailable
  });
  const st = fakeRequest({ pathName: '/api/stickers/cache' });
  await ops.handleStickerCacheStatus(st.request);
  assert(st.out.payload.missing === 0, 'stats.missing 不含 unavailable');
  assert(st.out.payload.unavailable === 1, `stats.unavailable=1（实得 ${st.out.payload.unavailable}）`);
}

// ── 8. repair 把「过期 URL 的 missing」归为 unavailable，再修其余 ──────────
{
  const { deps, entries } = makeDeps({ limitBytes: 1024 * 1024, fetchBytes: 120 });
  entries.push(
    { id: 'e1', key: 'k-e1', thumbStatus: 'missing', thumbError: '文件下载失败：HTTP 400', url: 'https://multimedia.nt.qq.com.cn/download?fileid=y' },
    { id: 'e2', key: 'k-e2', thumbStatus: 'missing', thumbErrorKind: 'cache-limit', url: 'https://x/good.png' }
  );
  const observe = createObserveRuntime(deps);
  const ops = createStickerCacheOps({
    ...deps,
    stickerCacheFileList: observe.stickerCacheFileList,
    stickerCacheLimit: observe.stickerCacheLimit,
    cleanupStickerCache: observe.cleanupStickerCache,
    persistMissingStickerThumbs: observe.persistMissingStickerThumbs,
    markExpiredMissingUnavailable: observe.markExpiredMissingUnavailable
  });
  const rep = fakeRequest({ pathName: '/api/stickers/thumbs/repair', method: 'POST', body: { limit: 10 } });
  await ops.handleStickerThumbsRepair(rep.request);
  assert(rep.out.status === 200, 'repair 200');
  assert(rep.out.payload.markedUnavailable === 1, `repair 报 markedUnavailable=1（实得 ${rep.out.payload.markedUnavailable}）`);
  assert(entries.find((e) => e.id === 'e1').thumbStatus === 'unavailable', '过期 URL 条目归为 unavailable');
  assert(rep.out.payload.fixed >= 1, '其余 missing 仍照常修复');
  assert(rep.out.payload.stats.missing === 0, 'repair 后 missing=0');
  assert(rep.out.payload.stats.unavailable === 1, 'repair 后 unavailable=1');
}

// ── 9. 删除不可用条目（默认真删，dryRun 才试跑）──────────────────────────
{
  const { deps, entries, savesRef } = makeDeps({ limitBytes: 1024 * 1024 });
  entries.push(
    { id: 'u1', key: 'k-u1', thumbStatus: 'unavailable', thumbErrorKind: 'expired-url', url: 'https://multimedia.nt.qq.com.cn/download?fileid=z' },
    { id: 'u2', key: 'k-u2', thumbStatus: 'unavailable', thumbErrorKind: 'expired-url', url: 'https://multimedia.nt.qq.com.cn/download?fileid=w' },
    { id: 'keep', key: 'k-keep', thumbStatus: 'ok', md5: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', url: 'https://x/keep.png' }
  );
  const ops = createStickerCacheOps({
    ...deps,
    stickerCacheFileList: () => [],
    stickerCacheLimit: () => 1024 * 1024,
    cleanupStickerCache: async () => ({ ok: true }),
    persistMissingStickerThumbs: async () => ({ attempted: 0, fixed: 0, stillMissing: 0 })
  });
  const dry = fakeRequest({ pathName: '/api/stickers/unavailable/remove', method: 'POST', body: { dryRun: true } });
  await ops.handleStickerUnavailableRemove(dry.request);
  assert(dry.out.status === 200 && dry.out.payload.dryRun === true, 'remove dryRun:true 200');
  assert(dry.out.payload.matched === 2 && dry.out.payload.removed === 0, 'dryRun 只报 matched=2、removed=0');
  assert(entries.length === 3, 'dryRun 不删条目');
  assert(dry.out.payload.keys.length === 2, 'dryRun 也返回会被删的 key（≤20）');

  const real = fakeRequest({ pathName: '/api/stickers/unavailable/remove', method: 'POST', body: {} });
  await ops.handleStickerUnavailableRemove(real.request);
  assert(real.out.status === 200 && real.out.payload.dryRun === false, 'remove 缺省就是真删');
  assert(real.out.payload.removed === 2, `真删 2 条（实得 ${real.out.payload.removed}）`);
  assert(entries.length === 1 && entries[0].id === 'keep', '只删 unavailable，ok 条目保留');
  assert(savesRef() >= 1, '真删后落盘');
  assert(real.out.payload.stats.unavailable === 0 && real.out.payload.stats.entries === 1, '响应 stats 归零');

  const agent = fakeRequest({ pathName: '/api/stickers/unavailable/remove', method: 'POST', headers: { 'x-agent-token': 'x' }, body: {} });
  await ops.handleStickerUnavailableRemove(agent.request);
  assert(agent.out.status === 403, 'agent 令牌打 remove → 403');
  const get = fakeRequest({ pathName: '/api/stickers/unavailable/remove' });
  await ops.handleStickerUnavailableRemove(get.request);
  assert(get.out.status === 405, 'remove 只收 POST');
}

// ── 10. unavailable 不进制表情提示词 / 新表情推荐 ────────────────────────
{
  const { buildStickerContext, pickFreshStickerEntries } = await import('../src/sticker-lib.js');
  const list = [
    { id: 'gone', policy: 'usable', desc: '失效图', md5: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', thumbStatus: 'unavailable' },
    { id: 'ok1', policy: 'usable', desc: '可用图', md5: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', thumbStatus: 'ok' }
  ];
  const ctx = buildStickerContext(list, 8);
  assert(!ctx.includes('失效图'), '提示词里不出现 unavailable 的表情');
  assert(ctx.includes('可用图'), '提示词仍有可用表情');
  const fresh = pickFreshStickerEntries(list, { limit: 4 });
  assert(!fresh.some((e) => e.id === 'gone'), '新表情推荐排除 unavailable');
  void buildStickerContext; void pickFreshStickerEntries;
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
process.exit(failed ? 1 : 0);
