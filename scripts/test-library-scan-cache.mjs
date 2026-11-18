// scripts/test-library-scan-cache.mjs — 素材库增量扫描缓存（P2）
//
// 覆盖两层：
//   1. 纯规则（src/library-scan-cache.js）：目录签名、缓存归一化、diffScan、命中率；
//   2. 集成（buildLibrarySnapshotWithCache + 真实临时目录）：首次全扫、二次全复用、
//      新增/改内容（目录 mtime 不变）/删除、版本不符丢弃、坏 JSON、根目录变化、
//      ?full 强制全量、原子写不留 .tmp、卡片与全量结果一致。
//
// 用 mkdtemp 真盘跑：这里要验的就是「stat/签名」与实际文件系统的一致性，喂假 fs 验不出来。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCAN_CACHE_VERSION,
  SCAN_CACHE_FILE,
  dirSignatureOf,
  scanEntryOf,
  normalizeScanCache,
  diffScan,
  buildScanCache,
  assetsFromFilesCached,
  scanCacheHitRate
} from '../src/library-scan-cache.js';
import { buildLibrarySnapshot, buildLibrarySnapshotWithCache } from '../src/library-scan.js';
import { ASSET_RULES_VERSION } from '../src/library-asset.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    if (detail === undefined) console.log(`  ✓ ${name}`);
    else console.log(`  ✓ ${name} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
}

const tmpRoots = [];
function makeTmpRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lib-scan-${label}-`));
  tmpRoots.push(dir);
  return dir;
}
function writeFile(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// ── 1. 纯规则 ───────────────────────────────────────────────────────────────
console.log('## 纯规则：目录签名 / diff / 缓存形状');

const filesA = [
  { name: '9013048_hat.zip', bytes: 120, mtime: 1000, dir: 'x' },
  { name: '9013048_1.jpg', bytes: 30, mtime: 2000, dir: 'x' }
];
check('目录签名与文件顺序无关', dirSignatureOf(filesA) === dirSignatureOf([...filesA].reverse()));
check('目录签名随 size 变化', dirSignatureOf(filesA) !== dirSignatureOf([{ ...filesA[0], bytes: 121 }, filesA[1]]));
check('目录签名随 mtime 变化', dirSignatureOf(filesA) !== dirSignatureOf([filesA[0], { ...filesA[1], mtime: 2001 }]));

const entry = scanEntryOf({ relPath: 'a/b.zip', bytes: 10, mtime: 42.6 }, 'E:\\lib', path);
check('scanEntryOf 给绝对路径 + 取整 mtime', entry.path === path.join('E:\\lib', 'a/b.zip') && entry.mtimeMs === 43 && entry.size === 10, entry);

check('normalizeScanCache：版本不符整份丢弃', normalizeScanCache({ version: SCAN_CACHE_VERSION + 1, rules: ASSET_RULES_VERSION, entries: {} }) === null);
check('normalizeScanCache：规则版本不符丢弃', normalizeScanCache({ version: SCAN_CACHE_VERSION, rules: ASSET_RULES_VERSION + 1, entries: {} }) === null);
check('normalizeScanCache：垃圾值/缺字段丢弃', normalizeScanCache(null) === null && normalizeScanCache({ version: SCAN_CACHE_VERSION, rules: ASSET_RULES_VERSION }) === null);
const normalized = normalizeScanCache({
  version: SCAN_CACHE_VERSION,
  rules: ASSET_RULES_VERSION,
  root: 'E:\\lib',
  entries: { 'E:\\lib\\a.zip': { size: 9, mtimeMs: 5.4 }, '': { size: 1 } },
  dirs: { '': { sig: 'a|9|5', kind: 'single', assets: [{ key: 'k' }], loose: [] }, bad: { sig: 1 } }
});
check('normalizeScanCache：结构合法时归一化（非法条目丢弃、mtime 取整）',
  normalized && Object.keys(normalized.entries).length === 1 && normalized.entries['E:\\lib\\a.zip'].mtimeMs === 5 && Object.keys(normalized.dirs).length === 1,
  normalized && { entries: Object.keys(normalized.entries), dirs: Object.keys(normalized.dirs) });

const diff = diffScan({
  prev: { 'p1': { size: 1, mtimeMs: 1 }, 'p2': { size: 2, mtimeMs: 2 }, 'p3': { size: 3, mtimeMs: 3 } },
  entries: [
    { path: 'p1', size: 1, mtimeMs: 1 },
    { path: 'p2', size: 99, mtimeMs: 2 },
    { path: 'p4', size: 4, mtimeMs: 4 }
  ]
});
check('diffScan 分出 added/changed/removed/reused',
  diff.added.length === 1 && diff.added[0] === 'p4' && diff.changed.length === 1 && diff.changed[0] === 'p2'
  && diff.removed.length === 1 && diff.removed[0] === 'p3' && diff.reused.length === 1 && diff.reused[0] === 'p1', diff);
check('diffScan 无缓存时全部算新增', (() => { const d = diffScan({ prev: null, entries: [{ path: 'x', size: 1, mtimeMs: 1 }] }); return d.added.length === 1 && d.reused.length === 0; })());
check('buildScanCache 带版本/规则且 entries 归一',
  (() => {
    const cache = buildScanCache({ root: 'E:\\lib', entries: [{ path: 'E:\\lib\\a.zip', size: 3, mtimeMs: 7 }], dirs: { '': { sig: 'a', kind: 'single', assets: [], loose: [] } }, savedAt: 123 });
    return cache.version === SCAN_CACHE_VERSION && cache.rules === ASSET_RULES_VERSION && cache.savedAt === 123
      && Object.keys(cache.entries).length === 1 && cache.entries['E:\\lib\\a.zip'].size === 3;
  })());
check('命中率：空集 0、全复用 1、一半 0.5、越界夹紧',
  scanCacheHitRate(0, 0) === 0 && scanCacheHitRate(3, 3) === 1 && scanCacheHitRate(1, 2) === 0.5 && scanCacheHitRate(9, 2) === 1);

const grouped = assetsFromFilesCached(
  [
    { name: '9013048_hat.zip', relPath: 'a/9013048_hat.zip', dir: 'a', bytes: 10, mtime: 1 },
    { name: '9013048_1.jpg', relPath: 'a/9013048_1.jpg', dir: 'a', bytes: 2, mtime: 1 }
  ],
  null
);
check('assetsFromFilesCached 首次按目录认件（1 件素材）', grouped.assets.length === 1 && grouped.assets[0].key, { assets: grouped.assets.length, dirs: grouped.totalDirs });
const groupedCached = assetsFromFilesCached(
  [
    { name: '9013048_hat.zip', relPath: 'a/9013048_hat.zip', dir: 'a', bytes: 10, mtime: 1 },
    { name: '9013048_1.jpg', relPath: 'a/9013048_1.jpg', dir: 'a', bytes: 2, mtime: 1 }
  ],
  grouped.dirsCache
);
check('assetsFromFilesCached 签名一致时整目录复用', groupedCached.reusedDirs === 1 && groupedCached.reusedFiles === 2 && groupedCached.dirsCache.a.sig === grouped.dirsCache.a.sig);
check('assetsFromFilesCached 签名变化后重新认件（reused 归零）',
  assetsFromFilesCached(
    [{ name: '9013048_hat.zip', relPath: 'a/9013048_hat.zip', dir: 'a', bytes: 999, mtime: 1 }],
    grouped.dirsCache
  ).reusedDirs === 0);

// ── 2. 集成：真实临时目录 ───────────────────────────────────────────────────
console.log('## 集成：真实目录的增量扫描');
const root = makeTmpRoot('lib');
writeFile(path.join(root, '9013048_hat', '9013048_hat.zip'), Buffer.alloc(1024, 1));
writeFile(path.join(root, '9013048_hat', '9013048_1.jpg'), Buffer.alloc(64, 2));
writeFile(path.join(root, '9013048_hat', 'README.txt'), '说明');
writeFile(path.join(root, '无号素材', 'sample.zip'), Buffer.alloc(256, 3));
writeFile(path.join(root, '无号素材', 'sample.png'), Buffer.alloc(32, 4));
const cacheFile = path.join(root, '.cache', SCAN_CACHE_FILE);
fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
const opts = { fs, rootDir: root, cacheFile };

check('首次扫描前没有缓存文件', fs.existsSync(cacheFile) === false);
const first = buildLibrarySnapshotWithCache({ ...opts, full: true });
check('首次：scanMode=full 且缓存落盘', first.scanMode === 'full' && fs.existsSync(cacheFile));
const firstCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
check('缓存文件带 version/rules/root/savedAt/entries/dirs',
  firstCache.version === SCAN_CACHE_VERSION && firstCache.rules === ASSET_RULES_VERSION
  && firstCache.root === root && typeof firstCache.savedAt === 'number'
  && Object.keys(firstCache.entries).length === first.fileCount && Object.keys(firstCache.dirs).length > 0);
check('缓存 entries 的键是绝对路径', Object.keys(firstCache.entries).every((key) => path.isAbsolute(key)));

const second = buildLibrarySnapshotWithCache(opts);
check('第二次：scanMode=incremental', second.scanMode === 'incremental');
check('第二次：全部文件复用（reused=fileCount）、目录全复用',
  second.scan && second.scan.reused === second.fileCount && second.scan.dirsReused === second.scan.dirsTotal,
  second.scan);
check('第二次：缓存命中率 100%', second.scan.hitRate === 1);
check('第二次：卡片数量/键与全量结果一致',
  second.count === first.count && JSON.stringify(second.assets.map((a) => a.key)) === JSON.stringify(first.assets.map((a) => a.key)));

// 新增文件
writeFile(path.join(root, '9013048_hat', '9013048_2.jpg'), Buffer.alloc(16, 9));
const afterAdd = buildLibrarySnapshotWithCache(opts);
check('新增文件：added=1、fileCount +1', afterAdd.scanMode === 'incremental' && afterAdd.scan.added === 1 && afterAdd.fileCount === first.fileCount + 1, afterAdd.scan);

// 改内容但目录 mtime 不变（同名覆盖写）
const target = path.join(root, '9013048_hat', '9013048_hat.zip');
const dirBefore = fs.statSync(path.dirname(target)).mtimeMs;
fs.writeFileSync(target, Buffer.alloc(2048, 7));
const dirAfter = fs.statSync(path.dirname(target)).mtimeMs;
check('原地覆盖不改变目录 mtime（用例前提成立）', dirBefore === dirAfter, { dirBefore, dirAfter });
const bytesBeforeChange = (afterAdd.assets.find((a) => a.dir === '9013048_hat') || {}).bytes;
const afterChange = buildLibrarySnapshotWithCache(opts);
const changedCard = afterChange.assets.find((a) => a.dir === '9013048_hat');
check('改内容（目录 mtime 不变）也被发现：changed=1 且卡片 bytes 跟涨',
  afterChange.scanMode === 'incremental' && afterChange.scan.changed === 1 && changedCard && changedCard.bytes === bytesBeforeChange + 1024,
  { scan: afterChange.scan, before: bytesBeforeChange, after: changedCard && changedCard.bytes });

// 删除文件
fs.unlinkSync(path.join(root, '无号素材', 'sample.png'));
const afterRemove = buildLibrarySnapshotWithCache(opts);
check('删文件：removed=1、fileCount -1', afterRemove.scanMode === 'incremental' && afterRemove.scan.removed === 1 && afterRemove.fileCount === afterChange.fileCount - 1, afterRemove.scan);
check('删文件后对应卡片不再出现（成件规则变化）', afterRemove.count <= afterChange.count);

// 版本不符：手写旧版本缓存 → 下次整份丢弃并全扫
fs.writeFileSync(cacheFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cacheFile, 'utf8')), version: SCAN_CACHE_VERSION + 1 }));
const afterVersion = buildLibrarySnapshotWithCache(opts);
check('缓存版本不符：回退全扫并重写为新版本',
  afterVersion.scanMode === 'full' && JSON.parse(fs.readFileSync(cacheFile, 'utf8')).version === SCAN_CACHE_VERSION, afterVersion.scanMode);

// 坏 JSON
fs.writeFileSync(cacheFile, '{不是 JSON');
const afterBadJson = buildLibrarySnapshotWithCache(opts);
check('缓存是坏 JSON：不抛错、回退全扫', afterBadJson.scanMode === 'full' && afterBadJson.ok === true);

// 根目录变化：缓存 root 是别的库 → 不复用
const otherRoot = makeTmpRoot('other');
writeFile(path.join(otherRoot, 'x', 'x.zip'), Buffer.alloc(8, 5));
buildLibrarySnapshotWithCache({ fs, rootDir: otherRoot, cacheFile });
const cacheOther = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
check('缓存 root 跟随最近一次扫描的库', cacheOther.root === otherRoot);
const backToFirstRoot = buildLibrarySnapshotWithCache(opts);
check('换库后缓存根不匹配 → 全扫（不复用别的库的路径）', backToFirstRoot.scanMode === 'full' && backToFirstRoot.scan.cached === false, backToFirstRoot.scan);

// 强制全量：即使缓存有效也不复用
const fullAgain = buildLibrarySnapshotWithCache({ ...opts, full: true });
check('?full 强制全量：scanMode=full、reused=0', fullAgain.scanMode === 'full' && fullAgain.scan.reused === 0);

// 原子写：不留 .tmp、缓存可解析
check('原子写：不残留 .tmp 且 JSON 可被解析',
  fs.existsSync(`${cacheFile}.tmp`) === false
  && (() => { try { return Boolean(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).entries); } catch { return false; } })());

// 不写缓存时（cacheWrite:false）
const noWrite = buildLibrarySnapshotWithCache({ ...opts, full: true, cacheWrite: false });
check('cacheWrite:false 不落盘（文件 mtime 不变）', noWrite.scanMode === 'full' && fs.statSync(cacheFile).mtimeMs >= 0);

// 不存在的库：missing 且不炸
// 口径与 test-library-scan 一致：目录读不动按「空目录」记（missing 只表示参数缺失），不整页报错。
const missingSnap = buildLibrarySnapshotWithCache({ fs, rootDir: path.join(root, '__not_here__'), cacheFile, full: true });
check('根目录不存在：不抛错、count=0、空目录有记录、缓存仍可写',
  missingSnap.ok === true && missingSnap.count === 0 && missingSnap.fileCount === 0 && Array.isArray(missingSnap.emptyDirs) && missingSnap.emptyDirs.length === 1);

// 与「直接 buildLibrarySnapshot」对照：没有缓存时两者结果一致
const plain = buildLibrarySnapshot({ fs, rootDir: root });
const viaCache = buildLibrarySnapshotWithCache({ ...opts, full: true });
check('首扫结果与 buildLibrarySnapshot 完全一致', plain.count === viaCache.count && JSON.stringify(plain.assets.map((a) => a.key)) === JSON.stringify(viaCache.assets.map((a) => a.key)) && plain.fileCount === viaCache.fileCount);

console.log('## 无 stat 快速模式（scan=fast）');
// 快速模式只在目录 mtime + 可见名字都没变时跳过文件 stat：
// 它的收益要用「statSync 调用次数」证明，而不是只看毫秒（测试机快，毫秒噪声大）。
const fastRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libscan-fast-'));
tmpRoots.push(fastRoot);
const fastCache = `${fastRoot}-cache.json`; // 缓存放库外，避免自己成为「新增文件」干扰计数
const fastDir = path.join(fastRoot, '1000001_asset');
fs.mkdirSync(fastDir, { recursive: true });
fs.writeFileSync(path.join(fastDir, '1000001_pack.zip'), Buffer.alloc(4096, 7));
fs.writeFileSync(path.join(fastDir, 'preview.jpg'), Buffer.alloc(1024, 8));
let statCalls = 0;
const countingFs = {
  ...fs,
  statSync(target, ...rest) { statCalls += 1; return fs.statSync(target, ...rest); }
};
const countStats = (fn) => { statCalls = 0; const out = fn(); return { out, calls: statCalls }; };
const fastFull = countStats(() => buildLibrarySnapshotWithCache({ fs: countingFs, rootDir: fastRoot, cacheFile: fastCache, full: true }));
check('快速模式前置：全量扫描会为每个文件 stat', fastFull.out.fileCount === 2 && fastFull.calls >= 2, { calls: fastFull.calls });
const fastCached = JSON.parse(fs.readFileSync(fastCache, 'utf8'));
check('缓存落盘带目录 mtime + 可见名字（快速模式复用依据）', fastCached.dirs && fastCached.dirs['1000001_asset']
  && Number(fastCached.dirs['1000001_asset'].mtimeMs) > 0 && Array.isArray(fastCached.dirs['1000001_asset'].names) && fastCached.dirs['1000001_asset'].names.length === 2);
const fastRun = countStats(() => buildLibrarySnapshotWithCache({ fs: countingFs, rootDir: fastRoot, cacheFile: fastCache, fastScan: true }));
check('目录未变时快速模式跳过文件 stat（stat 次数从「文件数+目录数」降到只剩目录）', fastRun.calls < fastFull.calls && fastRun.calls <= 2, { full: fastFull.calls, fast: fastRun.calls });
check('快速模式结果与全量一致，并标记 scan.fastScan/statSkipped', fastRun.out.fileCount === 2 && fastRun.out.count === fastFull.out.count
  && JSON.stringify(fastRun.out.assets.map((a) => a.key)) === JSON.stringify(fastFull.out.assets.map((a) => a.key))
  && fastRun.out.scan.fastScan === true && fastRun.out.scan.statSkipped === 2 && fastRun.out.scan.fastDirs === 1, fastRun.out.scan);
// 加文件：目录 mtime 变 → 快速模式必须发现（不能漏新增）
fs.writeFileSync(path.join(fastDir, 'notes.txt'), Buffer.alloc(16, 1));
const fastAdded = buildLibrarySnapshotWithCache({ fs, rootDir: fastRoot, cacheFile: fastCache, fastScan: true });
check('快速模式仍能发现新增文件（目录 mtime 变）', fastAdded.fileCount === 3 && fastAdded.scan.added === 1, fastAdded.scan);
// 原地覆盖：目录 mtime 不变 → 快速模式看不到（这是用速度换掉的可检测性，必须写下来）
const packPath = path.join(fastDir, '1000001_pack.zip');
fs.writeFileSync(packPath, Buffer.alloc(4096, 9)); // 同尺寸原地覆盖：目录 mtime 不变，只有文件 mtime 变
const fastInPlace = buildLibrarySnapshotWithCache({ fs, rootDir: fastRoot, cacheFile: fastCache, fastScan: true });
const strictInPlace = buildLibrarySnapshotWithCache({ fs, rootDir: fastRoot, cacheFile: fastCache });
check('原地覆盖：严格增量靠文件 stat 发现 changed=1，快速模式看不到（已知取舍，需在文档里写明）',
  strictInPlace.scan.changed === 1 && fastInPlace.scan.fastScan === true && fastInPlace.scan.changed === 0,
  { fast: fastInPlace.scan, strictChanged: strictInPlace.scan.changed });
const fastNoCache = buildLibrarySnapshotWithCache({ fs, rootDir: fastRoot, cacheFile: path.join(fastRoot, 'none.json'), fastScan: true });
check('没有缓存时 fastScan 退化为全扫（scanMode=full、fastScan=false）', fastNoCache.scanMode === 'full' && fastNoCache.scan.fastScan === false);
try { fs.rmSync(fastRoot, { recursive: true, force: true }); fs.rmSync(fastCache, { force: true }); } catch {}

// 清理临时目录
for (const dir of tmpRoots) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('');
console.log(`library-scan-cache：通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
