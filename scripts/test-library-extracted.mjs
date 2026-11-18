// 解压产物（真机：解压 6985553.zip 后素材库 32→33 件）只在视图层处理。
//
// 为什么要有这一套：用户点「解压」后，扫盘会把 `5197537/6985553/` 这个解压目录也扫成一件素材，
// 于是「共 N 件」多一件、还会拿目录名当商品号进「候选号」。扫盘侧不该知道「解压」这件事
// （那是用户动作，不是磁盘事实），所以父子关系在视图层认：子目录名 = 父件主包名去扩展名，
// 且父件就在同层目录里 → 判为解压产物，默认隐藏；想找就 `view=extracted`。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createLibraryView } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-view.js')).href);
const { markExtractedDirs } = await import(pathToFileURL(path.join(ROOT, 'src/library-assets-query.js')).href);

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-extracted-'));
const libDir = path.join(tmp, 'lib');
const cacheDir = path.join(tmp, 'cache');
fs.mkdirSync(path.join(libDir, 'g', 'x'), { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

// 侧边状态文件：一条已购（给「候选号」提供相似标题，用来验证解压产物不会混进候选列表）。
fs.writeFileSync(path.join(tmp, 'booth-purchases.json'), JSON.stringify({
  version: 1,
  items: { '5197537': { boothId: '5197537', title: 'ゆらゆらオバケギミック' } }
}));
for (const name of ['booth-binds.json', 'booth-batchfind.json', 'booth-merges.json', 'booth-trash.json', 'library-manual-meta.json', 'booth-renames.json', 'booth-favorites.json']) {
  fs.writeFileSync(path.join(tmp, name), JSON.stringify({}));
}

// 4 件：父件（zip 主件）+ 它的解压产物 + 孤儿解压目录（父件不在，照常显示）+ 普通件。
function currentAssets() {
  return [
    {
      key: 'g/x/5197537', title: 'ゆらゆらオバケギミック', dir: 'g/x/5197537', file: '6985553.zip',
      mainName: '6985553.zip', boothId: '5197537', boothSource: 'manual', thumbRel: '', bytes: 1000, files: 1
    },
    {
      // 解压产物：目录名 6985553 = 父件主包名去扩展名。标题故意跟已购台账相似，
      // 若没隐藏就会变成「候选号」，这正是真机里的脏数据。
      key: 'g/x/5197537/6985553', title: 'ゆらゆらオバケギミック', dir: 'g/x/5197537/6985553', file: 'preview.png',
      mainName: 'preview.png', boothId: '6985553', boothSource: 'name-prefix', thumbRel: '', bytes: 500, files: 2
    },
    {
      // 孤儿：父目录 g/x/999 没有对应件，照常显示（不能把用户自己的目录藏了）。
      key: 'g/x/999/123', title: '123', dir: 'g/x/999/123', file: 'a.png', mainName: 'a.png',
      boothId: '', boothSource: '', thumbRel: '', bytes: 10, files: 1
    },
    {
      key: 'g/x/other', title: 'other pack', dir: 'g/x/other', file: 'other.zip', mainName: 'other.zip',
      boothId: '', boothSource: '', thumbRel: '', bytes: 20, files: 1
    }
  ];
}

const deps = {
  fs,
  path,
  STATE_DIR: tmp,
  ROOT,
  log: () => {},
  fileArchiveRootDir: () => libDir,
  boothCacheDir: () => cacheDir,
  fileArchiveDb: () => ({}),
  listArchive: () => [],
  buildLibrarySnapshot: () => ({ ok: true, root: libDir, count: 4, bytes: 1530, withBooth: 0, withThumb: 0, assets: currentAssets() }),
  getBoothCoverPath: () => '',
  safeResolveInside: (root, rel) => path.join(root, rel),
  mimeFromBuffer: () => 'image/png',
  spawn: () => ({ unref() {} }),
  libraryNotes: {},
  getBoothCover: async () => ({ ok: false }),
  fetchBoothMeta: async () => null
};
const view = createLibraryView(deps);

function makeReq(pathname, query = {}) {
  let sent = null;
  const request = {
    req: { method: 'GET', headers: {} },
    url: { pathname, searchParams: new URLSearchParams({ fresh: '1', ...query }) },
    consoleRole: 'admin',
    readBody: async () => ({}),
    sendJson: (payload, code) => { sent = { payload, code: code || 200 }; },
    res: { writeHead() {}, end() {} },
    SECURITY_HEADERS: {}
  };
  return { request, sent: () => sent };
}

async function callAssets(query = {}) {
  const { request, sent } = makeReq('/api/library/assets', query);
  await view.handleLibraryAssetsRoute(request);
  return sent()?.payload;
}

console.log('## 纯函数：父件识别');
const cards = currentAssets();
const marked = markExtractedDirs(cards);
eq('父件在且主包名对得上 → 子目录被摘走', marked.extracted.length, 1);
eq('被摘走的 key 是解压产物', marked.extracted[0]?.key, 'g/x/5197537/6985553');
eq('子件带 extractedFrom 指父件', marked.extracted[0]?.extractedFrom, 'g/x/5197537');
eq('可见件 3 件（父件 + 孤儿 + 普通件）', marked.assets.length, 3);
eq('父件补 extracted 摘要（files/bytes/count）', marked.assets.find((a) => a.key === 'g/x/5197537')?.extracted, {
  dirRel: 'g/x/5197537/6985553', dirs: ['g/x/5197537/6985553'], files: 2, bytes: 500, count: 1
});
check('孤儿目录照常显示', marked.assets.some((a) => a.key === 'g/x/999/123'));
check('父件主包名不是压缩包时不认父子（普通目录）', markExtractedDirs([
  { key: 'p', dir: 'g/p', mainName: 'p.txt' },
  { key: 'c', dir: 'g/p/p', mainName: 'a.png' }
]).extracted.length === 0);
check('父件不存在时不隐藏（孤儿）', markExtractedDirs([{ key: 'c', dir: 'g/none/c', mainName: 'a.png' }]).extracted.length === 0);
eq('空数组不崩', markExtractedDirs([]), { assets: [], extracted: [] });

// 真机 P2②：原 zip 被移走/备份走后，父卡只剩一张缩略图（mainName 空、kind image-only）。
// 这时仍要认出同层的 `<stem>/` 解压目录，否则用户看不到「已解压」。
const thumbParent = markExtractedDirs([
  { key: 'g/x/5197537', dir: 'g/x/5197537', mainName: '', kind: 'image-only', thumbRel: 'g/x/5197537/6985553.thumbnail.png', files: 2, bytes: 60 },
  { key: 'g/x/5197537/6985553', dir: 'g/x/5197537/6985553', mainName: '', files: 2, bytes: 500 }
]);
check('父件原包不在了、只剩缩略图 → 靠封面名兜底仍认「已解压」', thumbParent.extracted.length === 1
  && thumbParent.extracted[0].key === 'g/x/5197537/6985553'
  && thumbParent.assets.length === 1
  && Boolean(thumbParent.assets[0].extracted));
check('兜底认父子也要求名字对得上（缩略图名 ≠ 子目录名时不动）', markExtractedDirs([
  { key: 'p', dir: 'g/p', mainName: '', thumbRel: 'g/p/other.thumbnail.png' },
  { key: 'c', dir: 'g/p/6985553', mainName: '' }
]).extracted.length === 0);

console.log('## 路由：默认隐藏 + 计数同源');
const payload = await callAssets({ limit: '500' });
eq('allCount 回到 3 件（解压产物不算素材）', payload.allCount, 3);
eq('counts.all 与 allCount 同源', payload.counts.all, payload.allCount);
eq('响应告诉前端隐藏了几件', payload.extractedCount, 1);
eq('counts.extracted 同步', payload.counts.extracted, 1);
check('默认列表里没有解压产物', !payload.assets.some((a) => a.key === 'g/x/5197537/6985553'));
check('父件带 extracted 摘要（前端可显示「已解压」）', Boolean(payload.assets.find((a) => a.key === 'g/x/5197537')?.extracted));

console.log('## 路由：view=extracted 才列出来');
const extractedView = await callAssets({ view: 'extracted' });
eq('view=extracted total = 1', extractedView.total, 1);
eq('view 回显 extracted', extractedView.view, 'extracted');
eq('列出的正是解压产物', extractedView.assets[0]?.key, 'g/x/5197537/6985553');
eq('解压产物带 extractedFrom', extractedView.assets[0]?.extractedFrom, 'g/x/5197537');

console.log('## 路由：解压产物不进「候选号」列表');
const { request, sent } = makeReq('/api/library/bind-suggestions');
await view.handleLibraryAssetsRoute(request);
const suggestions = sent()?.payload;
const suggestedKeys = (suggestions?.items || []).map((item) => item.key);
check('候选列表不含解压产物', !suggestedKeys.includes('g/x/5197537/6985553'), JSON.stringify(suggestedKeys));

console.log(`\n解压产物视图：通过 ${pass} / 失败 ${failures.length}`);
fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) { console.error(`\n失败项：${failures.join('、')}`); process.exit(1); }
console.log('🎉 test-library-extracted 全部通过');
