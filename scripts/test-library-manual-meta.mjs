// 手动标签 / 手动分类（state/library-manual-meta.json）的单测。
//
// 为什么要测「联动」而不只测纯函数：手动信息只有在**视图链最后一层**叠上去才有用——
// 分类要压过文件名规则、标签要和解析结果并集，而且 facets / counts / 筛选 / 搜索
// 全都读最终视图。任何一环顺序错了，用户改完分类会发现左栏数字没变，比不能改还糟。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  MANUAL_META_VERSION, MANUAL_META_FILE, MANUAL_TAGS_MAX, MANUAL_TAG_MAX_CHARS,
  MANUAL_CATEGORY_MAX_CHARS, MANUAL_NOTE_MAX_CHARS,
  manualKeyOk, sanitizeManualTags, sanitizeManualCategory, sanitizeManualNote,
  normalizeManualEntry, normalizeManualMeta, manualEntryOf, setManualMeta, clearManualMeta,
  manualMetaCount, moveManualMeta, applyManualMeta, manualMetaStatsOf,
  readManualMetaState, writeManualMetaState
} from '../src/library-manual-meta.js';
import {
  handleLibraryManualMetaRoute, withManualMeta
} from '../src/bridge/console/library-manual-meta.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const { createLibraryView } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-view.js')).href);

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-manual-meta-'));
const logs = [];
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
const deps = {
  fs,
  path,
  STATE_DIR: tmp,
  log: (msg) => logs.push(String(msg)),
  atomicWriteJson: (file, value) => writeJson(file, value)
};

console.log('## 纯规则：标签 / 分类 / 备注清洗');

eq('版本号 1', MANUAL_META_VERSION, 1);
eq('台账文件名', MANUAL_META_FILE, 'library-manual-meta.json');
eq('标签上限 12 / 单标签 20 字', [MANUAL_TAGS_MAX, MANUAL_TAG_MAX_CHARS], [12, 20]);
eq('分类/备注上限', [MANUAL_CATEGORY_MAX_CHARS, MANUAL_NOTE_MAX_CHARS], [20, 200]);

eq('数组标签：去空白 + 去重（大小写不敏感）', sanitizeManualTags(['  发饰 ', 'Hair', 'hair', '']), ['发饰', 'Hair']);
eq('逗号串标签', sanitizeManualTags('服装, 语音、 发饰'), ['服装', '语音', '发饰']);
eq('单个超过 20 字被截断', sanitizeManualTags(['あ'.repeat(30)])[0].length, MANUAL_TAG_MAX_CHARS);
eq('超过 12 个只留前 12 个', sanitizeManualTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, MANUAL_TAGS_MAX);
eq('非数组非字符串 → 空数组', sanitizeManualTags({ a: 1 }), []);
eq('null/undefined → 空数组', [sanitizeManualTags(null), sanitizeManualTags(undefined)], [[], []]);
eq('分类去空白并压空格', sanitizeManualCategory('  3D  衣装 '), '3D 衣装');
eq('分类超过 20 字截断', Array.from(sanitizeManualCategory('服'.repeat(40))).length, MANUAL_CATEGORY_MAX_CHARS);
eq('备注截断 200', Array.from(sanitizeManualNote('x'.repeat(500))).length, MANUAL_NOTE_MAX_CHARS);
eq('备注去掉控制字符', sanitizeManualNote('a\u0001b'), 'a b');

console.log('\n## 纯规则：key 与条目归一');

check('hex key 合法', manualKeyOk('159c4465c7d79d59'));
check('带斜杠的 key 合法（测试/目录形态）', manualKeyOk('g/c/mew-hair'));
check('空 key 非法', !manualKeyOk(''));
check('带空白 key 非法', !manualKeyOk('a b'));
check('含 .. 的 key 非法（防路径穿越）', !manualKeyOk('../etc'));
check('超长 key 非法', !manualKeyOk('a'.repeat(201)));

eq('空对象条目 → null', normalizeManualEntry({}), null);
eq('全空字段条目 → null', normalizeManualEntry({ tags: [], category: '', note: '' }), null);
eq('数组不是条目 → null', normalizeManualEntry([]), null);
eq('只有分类也算条目', normalizeManualEntry({ category: '衣装' }), { tags: [], category: '衣装', note: '', updatedAt: 0 });
eq('updatedAt 取正整数', normalizeManualEntry({ category: '衣装', updatedAt: 123.9 }).updatedAt, 123);

const normalized = normalizeManualMeta({
  version: 99,
  items: {
    'g/c/a': { tags: ['服装', '服装'], category: '衣装', note: '备注' },
    'bad key': { category: '衣装' },
    'g/c/empty': {},
    'g/c/b': { category: '   ' }
  }
});
eq('坏 key / 空条目被丢弃', Object.keys(normalized.items), ['g/c/a']);
eq('版本号被规整为 1', normalized.version, 1);
eq('标签去重后落库', normalized.items['g/c/a'].tags, ['服装']);
eq('entries 别名也接受', Object.keys(normalizeManualMeta({ entries: { 'g/c/x': { category: '贴图' } } }).items), ['g/c/x']);

console.log('\n## 纯规则：写入 / 清空 / 迁移（不改入参）');

const base = normalizeManualMeta({ items: { 'g/c/a': { tags: ['服装'], category: '衣装' } } });
const frozen = JSON.stringify(base);
const withTag = setManualMeta(base, 'g/c/a', { tags: ['服装', '测试'] }, { now: 10 });
eq('写入后标签变了', withTag.items['g/c/a'].tags, ['服装', '测试']);
eq('只改给的字段：分类保持', withTag.items['g/c/a'].category, '衣装');
eq('写入不改入参', JSON.stringify(base), frozen);
eq('写入刷新 updatedAt', withTag.items['g/c/a'].updatedAt, 10);
const clearedTags = setManualMeta(withTag, 'g/c/a', { tags: [] }, { now: 11 });
eq('tags:[] 清掉手动标签但保留分类', [clearedTags.items['g/c/a'].tags, clearedTags.items['g/c/a'].category], [[], '衣装']);
const clearedCategory = setManualMeta(withTag, 'g/c/a', { category: '' }, { now: 12 });
eq('category:"" 回退规则分类（条目仍在因为还有标签）', clearedCategory.items['g/c/a'].category, '');
const allEmpty = setManualMeta(base, 'g/c/a', { tags: [], category: '' }, { now: 13 });
eq('三个字段都空了 → 条目删除', allEmpty.items['g/c/a'], undefined);
let threw = '';
try { setManualMeta(base, '', {}); } catch (error) { threw = String(error?.message ?? error); }
check('空 key 写入抛错', threw.includes('不合法'));
eq('清空指定条目', Object.keys(clearManualMeta(base, 'g/c/a').items), []);
eq('计数', [manualMetaCount(base), manualMetaCount(null)], [1, 0]);

const moved = moveManualMeta(base, 'g/c/a', 'g/c/b');
eq('迁移：旧 key 消失、新 key 有值', [moved.table.items['g/c/a'], moved.table.items['g/c/b']?.category], [undefined, '衣装']);
eq('迁移 moved 标记', moved.moved, true);
eq('迁移旧 key 不存在 → moved:false', moveManualMeta(base, 'g/c/zzz', 'g/c/b').moved, false);
const newer = moveManualMeta(
  normalizeManualMeta({ items: { 'g/c/a': { category: '衣装', updatedAt: 5 }, 'g/c/b': { category: '贴图', updatedAt: 9 } } }),
  'g/c/a', 'g/c/b'
);
eq('两边都有条目时保留更新的那份', newer.table.items['g/c/b'].category, '贴图');

console.log('\n## 纯规则：叠加到素材卡');

const ruleAsset = { key: 'g/c/a', title: 'Mew Hair', category: '发型', categoryFrom: 'rule', tags: ['发饰'] };
const applied = applyManualMeta(ruleAsset, { tags: ['发饰', '测试'], category: '衣装', note: '自用' });
eq('手动分类压过规则分类', applied.category, '衣装');
eq('分类来源标 manual', applied.categoryFrom, 'manual');
eq('解析标签保留在 tags', applied.tags, ['发饰']);
eq('标签并集去重', applied.tagsAll, ['发饰', '测试']);
eq('手动字段齐全', [applied.manualCategory, applied.manualNote, applied.manualTags], ['衣装', '自用', ['发饰', '测试']]);
eq('叠加不改入参', [ruleAsset.category, ruleAsset.categoryFrom, ruleAsset.tagsAll], ['发型', 'rule', undefined]);
const plainApplied = applyManualMeta({ key: 'g/c/b', category: '未分类', tags: [] }, null);
eq('没有手动条目：分类不变、手动字段为空', [plainApplied.category, plainApplied.manualCategory, plainApplied.manualTags, plainApplied.tagsAll], ['未分类', '', [], []]);

console.log('\n## 台账读写（state 目录）');

eq('台账路径用 STATE_DIR', path.basename(path.dirname(path.join(tmp, MANUAL_META_FILE))), path.basename(tmp));
writeManualMetaState(deps, base);
const reread = readManualMetaState(deps);
eq('写盘后能读回', Object.keys(reread.items), ['g/c/a']);
fs.writeFileSync(path.join(tmp, MANUAL_META_FILE), '{坏 JSON');
eq('坏 JSON 当空台账（不让素材页炸）', Object.keys(readManualMetaState(deps).items), []);
fs.writeFileSync(path.join(tmp, MANUAL_META_FILE), '\ufeff' + JSON.stringify({ items: { 'g/c/b': { category: '贴图' } } }));
eq('BOM 也能读', Object.keys(readManualMetaState(deps).items), ['g/c/b']);

writeManualMetaState(deps, normalizeManualMeta({
  items: {
    'g/c/x': { tags: ['甲', '乙'], category: '衣装', note: '有备注', updatedAt: 3 },
    'g/c/y': { tags: ['丙'], category: '', note: '', updatedAt: 4 },
    'g/c/z': { tags: [], category: '', note: '只有备注', updatedAt: 5 }
  }
}));
eq('台账统计按条目算（不是按卡片）', manualMetaStatsOf(readManualMetaState(deps)), { entries: 3, tagged: 2, categorized: 1, noted: 2 });
eq('空台账统计全 0', manualMetaStatsOf(normalizeManualMeta(null)), { entries: 0, tagged: 0, categorized: 0, noted: 0 });
// 复原成路由段依赖的那份台账（不然下面「清空后台账里没有这条」会看到残留条目）
fs.writeFileSync(path.join(tmp, MANUAL_META_FILE), '﻿' + JSON.stringify({ version: 1, items: { 'g/c/b': { category: '贴图' } } }));

console.log('\n## 路由：GET / POST / 清空 / 403 / 405 / 404');

function makeReq({ pathname = '/api/library/manual-meta', query = {}, method = 'GET', headers = {}, body = null, role = '' } = {}) {
  const sent = { payload: null, code: 200 };
  return {
    sent,
    request: {
      req: { method, headers },
      url: { pathname, searchParams: new URLSearchParams(query) },
      consoleRole: role,
      readBody: async () => { if (body instanceof Error) throw body; return body; },
      sendJson: (payload, code) => { sent.payload = payload; sent.code = code || 200; }
    }
  };
}
const snapshot = { assets: [{ key: 'g/c/a', title: 'Mew Hair' }, { key: 'g/c/b', title: 'plain pack' }] };
const getAssets = async () => snapshot;

const missReq = makeReq();
await handleLibraryManualMetaRoute(missReq.request, deps, getAssets, await import('../src/library-manual-meta.js'));
eq('GET 不带 key → 200 返统计（不是 400）', [missReq.sent.code, missReq.sent.payload.ok, missReq.sent.payload.key], [200, true, undefined]);
eq('统计与台账条目一致', missReq.sent.payload.stats, { entries: 1, tagged: 0, categorized: 1, noted: 0 });

// 边界：坏台账 / 空文件 / 未知 key 都不能让接口炸，也不能编数字。
fs.writeFileSync(path.join(tmp, MANUAL_META_FILE), '{坏 JSON');
const badStatsReq = makeReq();
await handleLibraryManualMetaRoute(badStatsReq.request, deps, getAssets, await import('../src/library-manual-meta.js'));
eq('坏台账 → 统计全 0（不报错）', [badStatsReq.sent.code, badStatsReq.sent.payload.stats], [200, { entries: 0, tagged: 0, categorized: 0, noted: 0 }]);
fs.writeFileSync(path.join(tmp, MANUAL_META_FILE), '');
const emptyFileReq = makeReq();
await handleLibraryManualMetaRoute(emptyFileReq.request, deps, getAssets, await import('../src/library-manual-meta.js'));
eq('空文件 → 统计全 0', [emptyFileReq.sent.code, emptyFileReq.sent.payload.stats], [200, { entries: 0, tagged: 0, categorized: 0, noted: 0 }]);

const emptyReq = makeReq({ query: { key: 'g/c/absent' } });
await handleLibraryManualMetaRoute(emptyReq.request, deps, getAssets, await import('../src/library-manual-meta.js'));
eq('GET 没写过的 key → 200 entry:null', [emptyReq.sent.code, emptyReq.sent.payload.entry], [200, null]);

const putReq = makeReq({ pathname: '/api/library/manual-meta' });
putReq.request.req.method = 'PUT';
await handleLibraryManualMetaRoute(putReq.request, deps, getAssets, await import('../src/library-manual-meta.js'));
eq('PUT 不支持 → 405', putReq.sent.code, 405);

const agentReq = makeReq({ headers: { 'x-agent-token': 't' } });
await handleLibraryManualMetaRoute(agentReq.request, deps, getAssets, await import('../src/library-manual-meta.js'));
eq('agent 令牌 → 403', [agentReq.sent.code, agentReq.sent.payload.error.includes('管理端')], [403, true]);

const guestReq = makeReq({ role: 'guest', method: 'POST', body: { key: 'g/c/a' } });
await handleLibraryManualMetaRoute(guestReq.request, deps, getAssets, await import('../src/library-manual-meta.js'));
eq('访客 → 403', guestReq.sent.code, 403);

const notFoundReq = makeReq({ method: 'POST', body: { key: 'g/c/absent', category: '衣装' } });
await handleLibraryManualMetaRoute(notFoundReq.request, deps, getAssets, await import('../src/library-manual-meta.js'));
eq('写不存在的素材 → 404', [notFoundReq.sent.code, notFoundReq.sent.payload.error.includes('没有这件素材')], [404, true]);

const saveReq = makeReq({ method: 'POST', body: { key: 'g/c/b', tags: '测试, 手写', category: '衣装', note: '自用备注' } });
const handled = await handleLibraryManualMetaRoute(saveReq.request, deps, getAssets, await import('../src/library-manual-meta.js'));
eq('保存 → 200 且命中路由', [handled, saveReq.sent.code, saveReq.sent.payload.ok], [true, 200, true]);
eq('保存回显 entry', [saveReq.sent.payload.entry.tags, saveReq.sent.payload.entry.category, saveReq.sent.payload.entry.note], [['测试', '手写'], '衣装', '自用备注']);
check('保存写了日志', logs.some((line) => line.includes('手动标签 g/c/b') && line.includes('标签2个')));

const readReq = makeReq({ query: { key: 'g/c/b' } });
await handleLibraryManualMetaRoute(readReq.request, deps, getAssets, await import('../src/library-manual-meta.js'));
eq('GET 读回保存的条目', readReq.sent.payload.entry.category, '衣装');

// 只改分类：标签不能被顺手清空（hasOwnProperty 判断的用途）。
const patchReq = makeReq({ method: 'POST', body: { key: 'g/c/b', category: '贴图' } });
await handleLibraryManualMetaRoute(patchReq.request, deps, getAssets, await import('../src/library-manual-meta.js'));
eq('只传分类：标签保留', patchReq.sent.payload.entry.tags, ['测试', '手写']);
eq('只传分类：分类已更新', patchReq.sent.payload.entry.category, '贴图');

const badBodyReq = makeReq({ method: 'POST', body: Object.assign(new Error('请求体非法'), { statusCode: 413 }) });
await handleLibraryManualMetaRoute(badBodyReq.request, deps, getAssets, await import('../src/library-manual-meta.js'));
eq('readBody 异常按 statusCode 回', badBodyReq.sent.code, 413);

const clearReq = makeReq({ method: 'POST', body: { key: 'g/c/b', clear: true } });
await handleLibraryManualMetaRoute(clearReq.request, deps, getAssets, await import('../src/library-manual-meta.js'));
eq('clear:true → entry:null', [clearReq.sent.code, clearReq.sent.payload.cleared, clearReq.sent.payload.entry], [200, true, null]);
eq('清空后台账里没有这条', Object.keys(readManualMetaState(deps).items), []);
const afterClearStats = makeReq();
await handleLibraryManualMetaRoute(afterClearStats.request, deps, getAssets, await import('../src/library-manual-meta.js'));
eq('清空后台账统计归零', afterClearStats.sent.payload.stats, { entries: 0, tagged: 0, categorized: 0, noted: 0 });

console.log('\n## 视图联动（真实 createLibraryView + 最终视图链）');

const libDir = path.join(tmp, 'lib');
const cacheDir = path.join(tmp, 'cache');
fs.mkdirSync(libDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });
function sampleAssets() {
  return [
    { key: 'g/c/hair', title: 'Mew Hair', dir: 'g/c', file: 'Mew Hair.zip', mainName: 'Mew Hair.zip', boothId: '', boothSource: '', thumbRel: 'g/c/hair.png', bytes: 10, tags: ['发饰'], meta: { shop: 'MewStore' } },
    { key: 'g/c/witch', title: 'Witch Costume', dir: 'g/c', file: 'Witch.zip', mainName: 'Witch.zip', boothId: '111111', boothSource: '', thumbRel: '', bytes: 20, tags: [], meta: { shop: 'WitchShop' } },
    { key: 'g/c/plain', title: 'plain pack', dir: 'g/c', file: 'plain.zip', mainName: 'plain.zip', boothId: '', boothSource: '', thumbRel: '', bytes: 30, tags: [], meta: {} }
  ];
}
const viewDeps = {
  fs,
  path,
  STATE_DIR: tmp,
  ROOT,
  log: (m) => logs.push(String(m)),
  fileArchiveRootDir: () => libDir,
  boothCacheDir: () => cacheDir,
  fileArchiveDb: () => ({}),
  listArchive: () => [],
  buildLibrarySnapshot: () => ({ ok: true, root: libDir, count: 3, bytes: 60, withBooth: 1, withThumb: 1, assets: sampleAssets() }),
  getBoothCoverPath: () => '',
  safeResolveInside: (root, rel) => path.join(root, rel),
  mimeFromBuffer: () => 'image/png',
  spawn: () => ({ unref() {} }),
  libraryNotes: {},
  atomicWriteJson: (file, value) => writeJson(file, value),
  getBoothCover: async () => ({ ok: false }),
  fetchBoothMeta: async () => null
};
const view = createLibraryView(viewDeps);

function makeAssetsReq(query = {}) {
  let sent = null;
  const request = {
    req: { method: 'GET', headers: {} },
    url: { pathname: '/api/library/assets', searchParams: new URLSearchParams(query) },
    sendJson: (payload, code) => { sent = { payload, code: code || 200 }; }
  };
  return { request, getSent: () => sent };
}
// 通过真实路由写台账（视图侧只读文件，不依赖内部函数）。
writeManualMetaState(viewDeps, setManualMeta(normalizeManualMeta(null), 'g/c/plain', { tags: '测试', category: '衣装', note: '自用' }, { now: 1 }));

const allReq = makeAssetsReq();
await view.handleLibraryAssetsRoute(allReq.request);
const allData = allReq.getSent().payload;
const plainCard = allData.assets.find((asset) => asset.key === 'g/c/plain');
eq('最终视图带手动字段', [plainCard.manualCategory, plainCard.manualTags, plainCard.manualNote], ['衣装', ['测试'], '自用']);
eq('手动分类生效', [plainCard.category, plainCard.categoryFrom], ['衣装', 'manual']);
eq('tagsAll 含手动标签', plainCard.tagsAll, ['测试']);
eq('manualMetaStats 统计', [allData.manualMetaStats.entries, allData.manualMetaStats.tagged, allData.manualMetaStats.categorized], [1, 1, 1]);
eq('counts.unclassified 按手动后口径（原 1 件 → 0）', allData.counts.unclassified, 0);
eq('counts.manual = 台账里有分类的条目数', [allData.counts.manual, allData.manualMetaStats.categorized], [1, 1]);
eq('counts.manualTagged = 台账里有标签的条目数', [allData.counts.manualTagged, allData.manualMetaStats.tagged], [1, 1]);

const catReq = makeAssetsReq({ category: '衣装' });
await view.handleLibraryAssetsRoute(catReq.request);
eq('assets?category=衣装 命中它', [catReq.getSent().payload.total, catReq.getSent().payload.assets.map((a) => a.key)], [1, ['g/c/plain']]);
eq('回显 category=衣装', catReq.getSent().payload.category, '衣装');

const oldCatReq = makeAssetsReq({ category: '未分类' });
await view.handleLibraryAssetsRoute(oldCatReq.request);
eq('旧分类「未分类」不再命中它', oldCatReq.getSent().payload.total, 0);

const facetReq = { req: { method: 'GET', headers: {} }, url: { pathname: '/api/library/facets', searchParams: new URLSearchParams() }, sendJson: () => {} };
const facetSent = { payload: null, code: 200 };
facetReq.sendJson = (payload, code) => { facetSent.payload = payload; facetSent.code = code || 200; };
await view.handleLibraryAssetsRoute(facetReq);
const facetCat = facetSent.payload.facets.category;
eq('facets 用手动后的分类（衣装 1）', facetCat.find((item) => item.value === '衣装')?.count, 1);
eq('facets 未分类不再含它', facetCat.find((item) => item.value === '未分类')?.count, undefined);
eq('facets total 与卡数一致', facetSent.payload.total, 3);
eq('facets 手动分类标 fromManual:true', facetCat.find((item) => item.value === '衣装')?.fromManual, true);
eq('facets 只有手动分类带标记', facetCat.filter((item) => item.fromManual).map((item) => item.value), ['衣装']);
eq('facets 旧字段没被破坏（value/label/count 都在）', facetCat.every((item) => typeof item.value === 'string' && typeof item.label === 'string' && typeof item.count === 'number'), true);

const qReq = makeAssetsReq({ q: '测试' });
await view.handleLibraryAssetsRoute(qReq.request);
eq('q 能搜到手动标签', qReq.getSent().payload.total, 1);
const tagReq = makeAssetsReq({ tag: '测试' });
await view.handleLibraryAssetsRoute(tagReq.request);
eq('tag=测试 能筛到', tagReq.getSent().payload.total, 1);

// 清空后必须回到规则分类（否则用户没法「撤销自己的纠正」）。
writeManualMetaState(viewDeps, clearManualMeta(readManualMetaState(viewDeps), 'g/c/plain'));
const backReq = makeAssetsReq();
await view.handleLibraryAssetsRoute(backReq.request);
const backCard = backReq.getSent().payload.assets.find((asset) => asset.key === 'g/c/plain');
eq('清空手动条目后回到规则分类', [backCard.category, backCard.manualCategory], ['未分类', '']);
eq('清空后 counts.manual 归零', [backReq.getSent().payload.counts.manual, backReq.getSent().payload.counts.manualTagged], [0, 0]);

fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  console.error(`\n❌ test-library-manual-meta：失败 ${failures.length} 项`);
  process.exit(1);
}
console.log(`\n🎉 test-library-manual-meta 全部通过（${pass} 项）`);
