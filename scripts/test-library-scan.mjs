// test-library-scan.mjs — 素材库扫描（L2 素材卡）的单测
//
// 扫描器是「读盘 + 认件 + 对账」的胶水层，规则本身在 library-asset.js 里已有单测；
// 这里用真实临时目录钉住三件事：目录树怎么走（跳过什么、空目录怎么记、上限怎么截断）、
// 怎么按目录认件、以及快照对前端要交代的字段（封面 URL、对账结果、汇总数字）。
//
// 用真实目录而不是假 fs：扫描器传下去的是绝对路径，假 fs 在不同平台上还原相对路径
// 很容易写错（踩过一次：写成「所有文件都在根目录」，件数永远是 0），真目录没有这个问题。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SCAN_SKIP_DIRS,
  SCAN_DEFAULTS,
  scanLibraryTree,
  assetsFromFiles,
  assetThumbRel,
  assetCard,
  buildLibrarySnapshot
} from '../src/library-scan.js';

let failures = 0;
function ok(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (error) { failures += 1; console.log('  FAIL ' + name + ' — ' + (error?.message ?? error)); }
}

// ── 现造一个档案根目录 ───────────────────────────────────────────────────────
const ROOT = path.join(os.tmpdir(), `libscan-${process.pid}-${Date.now()}`);
const put = (rel, bytes = 100) => {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(bytes, 7));
};
fs.mkdirSync(ROOT, { recursive: true });
put('group_A/9013048/9013048_model.zip', 4000);
put('group_A/9013048/9013048_cover.jpg', 900);
put('group_A/9013048/readme.txt', 120);
put('group_A/9028816/9028816_asset.zip', 3000);
put('group_A/9028816/9028816.jpg', 800);
put('group_A/.thumbnails/cache.jpg', 50);
put('group_A/desktop.ini', 5);
put('group_A/lone.jpg', 60);
fs.mkdirSync(path.join(ROOT, 'group_A/empty_one'), { recursive: true });
put('group_B/1077209_vrm/model.vrm', 5000);
put('group_B/1077209_vrm/thumb.png', 700);
// P2① 真机：原包被人工挪到 `.s3bak/` 备份、下载中断留下 `.part`——都不该被扫成素材。
put('group_A/.s3bak/6985553.zip', 900);
put('group_A/6985553.zip.part', 835);
put('group_A/.tmp-download.tmp', 10);

process.on('exit', () => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
});

console.log('## 扫描目录');
ok('跳过 .thumbnails 与 desktop.ini，且不把跳过目录算成空目录', () => {
  const scan = scanLibraryTree({ fs, rootDir: ROOT });
  const names = scan.files.map((f) => f.name);
  assert.ok(!names.includes('cache.jpg'), '.thumbnails 应该被跳过');
  assert.ok(!names.includes('desktop.ini'), 'desktop.ini 应该被跳过');
  assert.ok(SCAN_SKIP_DIRS.has('.thumbnails'));
  assert.ok(!scan.emptyDirs.some((d) => String(d.rel).includes('.thumbnails')));
});

ok('空目录单独记一条 emptyDirs（前端要提示「收到文件才会自动建」）', () => {
  const scan = scanLibraryTree({ fs, rootDir: ROOT });
  assert.ok(scan.emptyDirs.some((d) => d.rel === 'group_A/empty_one' && d.reason === 'empty'));
});

ok('隐藏目录 .s3bak 与 .part/.tmp 中间态不进扫盘（P2① 同号重复卡的来源）', () => {
  const scan = scanLibraryTree({ fs, rootDir: ROOT });
  const names = scan.files.map((f) => f.name);
  assert.ok(!names.includes('6985553.zip'), '.s3bak/ 里的备份包不该被当素材扫进来');
  assert.ok(!names.includes('6985553.zip.part'), '下载残留 .part 不是素材');
  assert.ok(!names.includes('.tmp-download.tmp'), '.tmp 临时文件不是素材');
  assert.ok(!scan.dirs.some((d) => String(d.rel).includes('.s3bak')), '.s3bak 目录不进目录汇总');
});

ok('相对路径统一用 / 分隔，且带 dir 字段', () => {
  const scan = scanLibraryTree({ fs, rootDir: ROOT });
  const f = scan.files.find((x) => x.name === '9013048_model.zip');
  assert.equal(f.relPath, 'group_A/9013048/9013048_model.zip');
  assert.equal(f.dir, 'group_A/9013048');
  assert.ok(f.bytes > 0 && f.mtime > 0);
});

ok('目录汇总带文件数与体积', () => {
  const scan = scanLibraryTree({ fs, rootDir: ROOT });
  const d = scan.dirs.find((x) => x.rel === 'group_A/9013048');
  assert.equal(d.files, 3);
  assert.ok(d.bytes >= 4000);
});

ok('maxFiles 截断时标 truncated', () => {
  const scan = scanLibraryTree({ fs, rootDir: ROOT, maxFiles: 2 });
  assert.equal(scan.truncated, true);
  assert.equal(scan.files.length, 2);
});

ok('根目录不存在时给 missing（不抛）', () => {
  const scan = scanLibraryTree({ fs, rootDir: path.join(ROOT, 'nope') });
  assert.ok(scan.missing === false, '读不动的目录按空目录记，不整页报错');
  assert.equal(scanLibraryTree({ fs, rootDir: '' }).missing, true);
  assert.equal(scanLibraryTree({ fs: null, rootDir: ROOT }).missing, true);
  assert.ok(SCAN_DEFAULTS.maxDepth > 0);
});

console.log('## 按目录认件');
ok('每个下载目录各认一件，散文件不丢', () => {
  const scan = scanLibraryTree({ fs, rootDir: ROOT });
  const out = assetsFromFiles(scan.files);
  // 3 个压缩包各一件 + group_A 根下那张孤图也算一件（单图成件规则）
  assert.equal(out.assets.length, 4);
  const ids = out.assets.map((a) => a.boothId || '无号').sort();
  assert.deepEqual(ids, ['1077209', '9013048', '9028816', '无号'].sort());
  for (const asset of out.assets) assert.ok(asset.dir, '件要带所在目录，才能「在文件夹里看」');
  assert.equal(out.loose.length, 0, '孤图自己成件，不算散文件');
});

ok('带号的排在前面', () => {
  const files = [
    { name: 'no_id.zip', relPath: 'a/no_id.zip', dir: 'a', bytes: 10 },
    { name: '1234567_x.zip', relPath: 'b/1234567_x.zip', dir: 'b', bytes: 10 }
  ];
  const out = assetsFromFiles(files);
  assert.equal(out.assets[0].boothId, '1234567');
});

console.log('## 素材卡字段');
ok('有预览图时封面走 /api/files/raw?rel=，路径要 encodeURIComponent', () => {
  const files = [
    { name: '9013048_model.zip', relPath: '群 甲/9013048/9013048_model.zip', dir: '群 甲/9013048', bytes: 999 },
    { name: '9013048.jpg', relPath: '群 甲/9013048/9013048.jpg', dir: '群 甲/9013048', bytes: 50 }
  ];
  const out = assetsFromFiles(files);
  const card = assetCard(out.assets[0]);
  assert.ok(card.thumbUrl.startsWith('/api/files/raw?rel='));
  assert.ok(card.thumbUrl.includes('%2F'));
  assert.equal(card.thumbRel, '群 甲/9013048/9013048.jpg');
  assert.equal(assetThumbRel(out.assets[0]), '群 甲/9013048/9013048.jpg');
  assert.equal(card.boothId, '9013048');
  assert.equal(card.files, 2);
  assert.equal(card.previews, 1);
  assert.ok(card.bytes > 0);
});

ok('没有预览图时 thumbUrl 为空（前端画「无预览」，不去请求 404）', () => {
  const out = assetsFromFiles([{ name: '9013048_model.zip', relPath: 'x/9013048_model.zip', dir: 'x', bytes: 10 }]);
  const card = assetCard(out.assets[0]);
  assert.equal(card.thumbUrl, '');
  assert.equal(card.previews, 0);
});

console.log('## 快照与台账对账');
ok('快照带 count/bytes/withBooth/withThumb/loose 与内联在件上的 inLedger', () => {
  const snap = buildLibrarySnapshot({ fs, rootDir: ROOT, rows: [] });
  assert.equal(snap.ok, true);
  assert.equal(snap.count, 4);
  assert.ok(snap.bytes > 0);
  assert.equal(snap.withBooth, 3, '孤图没有商品号');
  assert.equal(snap.withThumb, 4);
  assert.equal(snap.notInLedger.length, 4, '台账为空时四件全是「台账里没有」');
  assert.ok(snap.assets.every((a) => a.inLedger === false));
  assert.equal(snap.rules, 2);
  assert.equal(snap.truncated, false);
});

ok('素材卡自带识别字段（解压码/RJ 号/标签），没认出来也是空值不是 undefined', () => {
  const snap = buildLibrarySnapshot({ fs, rootDir: ROOT, rows: [] });
  for (const card of snap.assets) {
    assert.equal(typeof card.archivePassword, 'string', `archivePassword 必须是字符串：${card.key}`);
    assert.equal(typeof card.rjCode, 'string', `rjCode 必须是字符串：${card.key}`);
    assert.ok(Array.isArray(card.tags), `tags 必须是数组：${card.key}`);
  }
});

ok('台账里有对应 contentKey 时 inLedger 变 true', () => {
  const probe = buildLibrarySnapshot({ fs, rootDir: ROOT, rows: [] });
  const key = probe.assets[0].key;
  const snap = buildLibrarySnapshot({ fs, rootDir: ROOT, rows: [{ id: 7, content_key: key, file_name: 'x.zip' }] });
  const hit = snap.assets.find((a) => a.key === key);
  assert.equal(hit.inLedger, true);
  assert.equal(snap.notInLedger.length, 3);
});

ok('台账有、盘上没了会单独列出来（对账扫描用）', () => {
  const snap = buildLibrarySnapshot({
    fs,
    rootDir: ROOT,
    rows: [{ id: 9, content_key: 'ghost', file_name: 'gone.zip' }]
  });
  assert.equal(snap.missingOnDisk.length, 1);
  assert.equal(snap.missingOnDisk[0].fileName, 'gone.zip');
});

ok('根目录缺失时快照仍可用（missing 透传，不抛）', () => {
  const snap = buildLibrarySnapshot({ fs, rootDir: path.join(ROOT, 'nope'), rows: [] });
  assert.equal(snap.ok, true);
  assert.equal(snap.count, 0);
});

ok('summary 与 kinds 都有（前端头部统计要用）', () => {
  const snap = buildLibrarySnapshot({ fs, rootDir: ROOT, rows: [] });
  assert.equal(snap.summary.assets, 4);
  assert.ok(snap.summary.files >= 3);
  assert.equal(typeof snap.kinds, 'object');
  assert.ok(Object.keys(snap.kinds).length >= 1);
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exitCode = failures ? 1 : 0;
