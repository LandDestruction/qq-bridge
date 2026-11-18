// src/library-dhash.js 的契约测试：封面指纹缓存 + 后台补算（不碰真盘、不调真 ffmpeg）。
//
// 覆盖：缓存键随 size/mtime 变、LRU 淘汰、坏缓存文件不炸、dhashFromImageFile 的失败路径
// （非图片/读失败/算失败/超预算）、目标文件选择（缩略图优先、BOOTH 封面兜底、都没有就跳过）、
// fillCards 的并发上限与缓存命中、后台循环的手动 runOnce、以及 dhash/withDhash 进扫描快照。
import {
  DHASH_CACHE_FILE,
  createDhashCache,
  createLibraryDhash,
  dhashCacheKey,
  dhashFileOf,
  dhashFromImageFile,
  isImageFile
} from '../src/library-dhash.js';
import { buildLibrarySnapshot } from '../src/library-scan.js';

const failures = [];
let pass = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail === undefined ? '' : ' — ' + String(detail)}`);
  }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}
const HASH_A = '0123456789abcdef';
const HASH_B = 'fedcba9876543210';

function makeCache(overrides = {}) {
  const writes = [];
  const cache = createDhashCache({
    stateDir: 'state',
    writeJson: (file, obj) => writes.push({ file, obj }),
    readText: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    ...overrides
  });
  return { cache, writes };
}

// ── 缓存键与图片判定 ─────────────────────────────────────────
console.log('\n## 缓存键 / 图片判定');
eq('键 = size:mtimeMs', dhashCacheKey({ size: 1234, mtimeMs: 1699999999123 }), '1234:1699999999123');
eq('mtime 取整', dhashCacheKey({ size: 10, mtimeMs: 5.7 }), '10:6');
eq('stat 为空回空串', dhashCacheKey(null), '');
check('png 是图片', isImageFile('a/preview.png'));
check('大写扩展名也认', isImageFile('preview.JPG'));
check('zip 不是图片', !isImageFile('a/model.zip'));
check('没有扩展名不是图片', !isImageFile('a/preview'));

// ── dhashFromImageFile 的失败路径 ────────────────────────────
console.log('\n## dhashFromImageFile');
const okHash = await dhashFromImageFile('a/preview.png', {
  readFile: async () => Buffer.from([1, 2, 3]),
  dhashBuffer: async () => HASH_A
});
eq('正常算出一张图', okHash, HASH_A);
eq('非图片直接空串，不读盘', await dhashFromImageFile('a/model.zip', { readFile: async () => { throw new Error('不该被读'); } }), '');
eq('读失败回空串', await dhashFromImageFile('a/preview.png', { readFile: async () => { throw new Error('EACCES'); }, dhashBuffer: async () => HASH_A }), '');
eq('空文件回空串', await dhashFromImageFile('a/preview.png', { readFile: async () => Buffer.alloc(0), dhashBuffer: async () => HASH_A }), '');
eq('算法抛错回空串', await dhashFromImageFile('a/preview.png', { readFile: async () => Buffer.from([1]), dhashBuffer: () => { throw new Error('ffmpeg 没了'); } }), '');
eq('算法返回 null 回空串', await dhashFromImageFile('a/preview.png', { readFile: async () => Buffer.from([1]), dhashBuffer: async () => null }), '');
eq('算法返回怪形状回空串', await dhashFromImageFile('a/preview.png', { readFile: async () => Buffer.from([1]), dhashBuffer: async () => 'not-a-hash' }), '');
const startedAt = Date.now();
eq('超预算不拖住调用方', await dhashFromImageFile('a/preview.png', {
  readFile: async () => Buffer.from([1]),
  dhashBuffer: () => new Promise(() => {}),
  budgetMs: 60
}), '');
check('超预算在预算附近返回（没等到 15s）', Date.now() - startedAt < 2000, `${Date.now() - startedAt}ms`);

// ── 目标文件选择 ─────────────────────────────────────────────
console.log('\n## 目标文件选择');
eq('缩略图优先', dhashFileOf({ thumbRel: 'A/preview.png', boothId: '9040914' }, { rootDir: 'E:/lib/', boothCoverPath: () => 'E:/cover.jpg' }), 'E:/lib/A/preview.png');
eq('反斜杠归一', dhashFileOf({ thumbRel: 'A\\preview.png' }, { rootDir: 'E:/lib' }), 'E:/lib/A/preview.png');
eq('没缩略图退到本地 BOOTH 封面', dhashFileOf({ boothId: '9040914' }, { rootDir: 'E:/lib', boothCoverPath: (id) => `E:/cache/${id}.jpg` }), 'E:/cache/9040914.jpg');
eq('boothCoverPath 抛错不影响', dhashFileOf({ boothId: '9040914' }, { boothCoverPath: () => { throw new Error('坏配置'); } }), '');
eq('什么图都没有就空串（cloud 卡不下载）', dhashFileOf({ key: 'x', source: 'cloud' }, { rootDir: 'E:/lib' }), '');
eq('boothId 形状不对不查封面', dhashFileOf({ boothId: 'not-an-id' }, { boothCoverPath: () => 'E:/cover.jpg' }), '');

// ── 缓存对象 ─────────────────────────────────────────────────
console.log('\n## 缓存对象');
{
  const { cache, writes } = makeCache();
  check('set 成功', cache.set('10:1', HASH_A));
  eq('get 拿得回', cache.get('10:1'), HASH_A);
  check('非法 hash 不收', !cache.set('10:2', 'zzz'));
  check('空键不收', !cache.set('', HASH_A));
  check('save 写盘一次', cache.save());
  check('写完再 save 不重复写', !cache.save());
  eq('写盘文件名对', writes[0].file, `state/${DHASH_CACHE_FILE}`);
  eq('写盘带版本号', writes[0].obj.version, 1);
  eq('写盘带 order', writes[0].obj.order, ['10:1']);
}
{
  const { cache } = makeCache({ limit: 3 });
  cache.set('k1', HASH_A);
  cache.set('k2', HASH_A);
  cache.set('k3', HASH_A);
  cache.get('k1'); // 摸一下 k1，让它变成最近用过的
  cache.set('k4', HASH_A); // 触发淘汰：应该淘汰 k2（最老）
  eq('LRU 淘汰最老的', cache.keys().sort(), ['k1', 'k3', 'k4']);
  eq('被淘汰的查不到', cache.get('k2'), '');
  eq('留着的还查得到', cache.get('k1'), HASH_A);
}
{
  const { cache } = makeCache({ readText: () => '{ 这不是 JSON' });
  eq('坏缓存文件当空缓存', cache.get('10:1'), '');
  check('坏缓存文件还能继续写', cache.set('10:1', HASH_B));
}
{
  const saved = JSON.stringify({ version: 1, entries: { 'a:1': HASH_A, 'b:2': HASH_B }, order: ['b:2', 'a:1'] });
  const { cache } = makeCache({ readText: () => saved });
  eq('按 order 读回（顺序=LRU 顺序）', cache.keys(), ['b:2', 'a:1']);
  eq('读回的值对', cache.get('a:1'), HASH_A);
}
{
  const { cache } = makeCache({ readText: () => JSON.stringify({ version: 1, entries: { bad: 'xyz', ok: HASH_A } }), limit: 16 });
  check('读回时过滤坏值', !cache.has('bad') && cache.has('ok'));
}

// ── lookup：同步只读缓存 ─────────────────────────────────────
console.log('\n## lookup');
{
  const { cache } = makeCache();
  const lib = createLibraryDhash({
    cache,
    statFile: (p) => ({ size: p.length, mtimeMs: 1000 }),
    readFile: async () => Buffer.from([1]),
    dhashBuffer: async () => HASH_A,
    log: () => {}
  });
  const card = { key: 'a', thumbRel: 'A/preview.png' };
  eq('缓存空时 lookup 空串', lib.lookup(card, { rootDir: 'E:/lib' }), '');
  cache.set(`${('E:/lib/A/preview.png').length}:1000`, HASH_A);
  eq('缓存命中 lookup 拿到值', lib.lookup(card, { rootDir: 'E:/lib' }), HASH_A);
  eq('没有缩略图的卡 lookup 空串', lib.lookup({ key: 'b' }, { rootDir: 'E:/lib' }), '');
}

// ── fillCards：并发上限 / 命中不重算 / 失败计数 ─────────────
console.log('\n## fillCards');
{
  const { cache, writes } = makeCache();
  let inflight = 0;
  let maxInflight = 0;
  const seen = new Map();
  const statA = (p) => ({ size: [...p].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 1000000, mtimeMs: 500 });
  const lib = createLibraryDhash({
    cache,
    concurrency: 4,
    statFile: statA,
    readFile: async (p) => Buffer.from([1, 2, 3]),
    dhashBuffer: async (buf) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inflight -= 1;
      return HASH_A;
    },
    log: () => {}
  });
  const cards = [
    { key: 'a', thumbRel: 'A/preview.png' }, // 未缓存，要算
    { key: 'b', thumbRel: 'B/preview.png' }, // 先塞缓存，命中
    { key: 'c', thumbRel: 'C/preview.png' }, // 未缓存，要算
    { key: 'd' }, // 没图，跳过
    { key: 'e', thumbRel: 'E/preview.png' } // 未缓存，要算
  ];
  cache.set(dhashCacheKey(statA('E:/lib/B/preview.png')), HASH_B);
  const progress = [];
  const stats = await lib.fillCards(cards, { rootDir: 'E:/lib', onProgress: (p) => progress.push(p) });
  eq('目标数 = 有图的卡数', stats.targets, 4);
  eq('缓存命中 1 件', stats.cached, 1);
  eq('新算 3 件', stats.computed, 3);
  eq('没有失败', stats.failed, 0);
  eq('withDhash = 命中 + 新算', stats.withDhash, 4);
  eq('没图的那张算跳过', stats.skipped, 1);
  check('并发不超过 4', maxInflight <= 4 && maxInflight > 1, `峰值 ${maxInflight}`);
  eq('进度回调每次算完都报', progress.length, 3);
  eq('缓存里落了新算的', cache.get(dhashCacheKey(statA('E:/lib/A/preview.png'))), HASH_A);
  eq('落盘文件是缓存文件', writes.at(-1).file, `state/${DHASH_CACHE_FILE}`);
  eq('第二遍全部命中，不重算', (await lib.fillCards(cards, { rootDir: 'E:/lib' })).computed, 0);
}
{
  const { cache } = makeCache();
  let inflight = 0;
  let maxInflight = 0;
  const lib = createLibraryDhash({
    cache,
    concurrency: 2,
    statFile: (p) => ({ size: [...p].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 11) % 1000000, mtimeMs: 700 }),
    readFile: async () => Buffer.from([1]),
    dhashBuffer: async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inflight -= 1;
      return '';
    },
    log: () => {}
  });
  const cards = Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, thumbRel: `D${i}/preview.png` }));
  const stats = await lib.fillCards(cards, { rootDir: 'E:/lib' });
  eq('坏图全部计入失败', stats.failed, 6);
  eq('坏图不算进 withDhash', stats.withDhash, 0);
  check('并发上限听注入的 2', maxInflight <= 2, `峰值 ${maxInflight}`);
}

// ── startLoop：计时器可注入、runOnce 可手动跑 ───────────────
console.log('\n## startLoop');
{
  const { cache } = makeCache();
  const timers = [];
  const intervals = [];
  const lib = createLibraryDhash({
    cache,
    statFile: (p) => ({ size: p.length, mtimeMs: 900 }),
    readFile: async () => Buffer.from([1]),
    dhashBuffer: async () => HASH_A,
    log: () => {}
  });
  const loop = lib.startLoop({
    getRoot: () => 'E:/lib',
    getCards: () => [{ key: 'a', thumbRel: 'A/preview.png' }],
    setTimeoutImpl: (fn, ms) => { timers.push(ms); const h = { fn, unref() {} }; return h; },
    setIntervalImpl: (fn, ms) => { intervals.push(ms); const h = { fn, unref() {} }; return h; },
    clearTimeoutImpl: () => {},
    clearIntervalImpl: () => {},
    startDelayMs: 8000,
    intervalMs: 300000
  });
  eq('首跑延迟 8s', timers, [8000]);
  eq('补算间隔 5 分钟', intervals, [300000]);
  const stats = await loop.runOnce();
  eq('runOnce 算出了 1 件', stats.computed, 1);
  loop.stop();
}
{
  const { cache } = makeCache();
  const lib = createLibraryDhash({ cache, log: () => {}, statFile: () => null, dhashBuffer: async () => HASH_A });
  const loop = lib.startLoop({ getRoot: () => '', setTimeoutImpl: () => ({ unref() {} }), setIntervalImpl: () => ({ unref() {} }) });
  eq('没有档案根就跳过', (await loop.runOnce()).reason, 'no_root');
  loop.stop();
}

// ── 扫描快照：dhash 字段与 withDhash 计数 ───────────────────
console.log('\n## 扫描快照');
{
  const scan = {
    files: [
      { name: 'preview.png', relPath: 'A/preview.png', dir: 'A', bytes: 100, mtime: 1 },
      { name: 'model.zip', relPath: 'A/model.zip', dir: 'A', bytes: 2000, mtime: 1 }
    ],
    dirs: ['A'],
    emptyDirs: [],
    truncated: false,
    missing: false,
    root: 'E:/lib'
  };
  const plain = buildLibrarySnapshot({ scan, rootDir: 'E:/lib' });
  eq('不注入 lookup 时 dhash 是空串', plain.assets[0].dhash, '');
  eq('不注入时 withDhash = 0', plain.withDhash, 0);
  const filled = buildLibrarySnapshot({ scan, rootDir: 'E:/lib', dhashLookup: () => HASH_B });
  eq('注入 lookup 后卡片带 dhash', filled.assets[0].dhash, HASH_B);
  eq('withDhash 统计对', filled.withDhash, 1);
  const throwing = buildLibrarySnapshot({ scan, rootDir: 'E:/lib', dhashLookup: () => { throw new Error('坏了'); } });
  eq('lookup 抛错只让这张卡没指纹', throwing.assets[0].dhash, '');
}

console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  console.log('失败项：');
  for (const name of failures) console.log(` - ${name}`);
}
process.exit(failures.length ? 1 : 0);
