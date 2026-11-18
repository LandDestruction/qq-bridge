// 认号可信度 + verified-only 封面链的单元测试。
//
// 背景（2026-10-30 真机反馈）：素材库里的号是扫盘从目录名/文件名猜出来的，猜错时页面会显示
// 另一个商品的封面与商品名。这里的规矩是：
//   verified = 号在已购台账（state/booth-purchases.json）或人工绑定表（state/booth-binds.json）里
//   只有 verified 才许显示台账标题、才许拿这个号去 BOOTH 抓封面
//   candidate/none 只算线索，页面上要标「?」或显示清洗过的文件名
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BIND_MIN_SCORE, BIND_SUGGESTION_LIMIT, boothIdSourceOf, boothStatusOf, cleanDisplayTitle,
  dirBoothIdOf, displayTitleOf, normalizeTitle, resolveBoothId, suggestBindings, titleScore, titleTokens
} from '../src/library-bind-match.js';
import {
  annotateBindStatus, countAssetViews, countCloudCards, countTrashCards, handleBindSuggestionRoutes
} from '../src/bridge/console/library-bind-view.js';
import { annotateCoverState, handleLibraryCoverRoute } from '../src/bridge/console/library-cover.js';

let pass = 0;
let failures = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${error?.message ?? error}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${error?.message ?? error}`);
  }
}
function eq(name, actual, expected) {
  check(name, () => assert.deepEqual(actual, expected));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bind-match-'));
const stateDir = path.join(tmp, 'state');
fs.mkdirSync(stateDir, { recursive: true });

const PURCHASES = {
  version: 1,
  items: {
    6985553: { boothId: '6985553', title: 'Mew Pose Collection', shopName: 'AstroShop', priceText: '¥1,200', itemUrl: 'https://booth.pm/ja/items/6985553', coverUrl: 'https://img.example/6985553.jpg' },
    1234567: { boothId: '1234567', title: 'ミルティナ Mummy Skin', shopName: 'ShopB', priceText: '¥900', itemUrl: '' }
  }
};
const writeState = (name, value) => fs.writeFileSync(path.join(stateDir, name), JSON.stringify(value), 'utf8');

function makeDeps(extra = {}) {
  return {
    fs,
    path,
    STATE_DIR: stateDir,
    log: () => {},
    atomicWriteJson: (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'),
    safeResolveInside: (root, rel) => path.join(root, rel),
    mimeFromBuffer: () => 'image/jpeg',
    fileArchiveRootDir: path.join(tmp, 'library'),
    boothCacheDir: path.join(tmp, 'booth-cache'),
    ...extra
  };
}

// ── 纯规则：标题清洗 / 相似度 ───────────────────────────────────────────────
check('normalizeTitle 去扩展名、转小写', () => {
  assert.equal(normalizeTitle('Mew Pose Ver.1.2.zip'), 'mew pose ver 1 2');
});
check('normalizeTitle 去掉 [RJ123] 这类编号括号', () => {
  assert.equal(normalizeTitle('[RJ123] Mew Pose.zip'), 'mew pose');
});
check('normalizeTitle 去掉【6985553】里的商品号', () => {
  assert.equal(normalizeTitle('【6985553】ミルティナ'), 'ミルティナ');
});
check('normalizeTitle 全角转半角（NFKC）', () => {
  assert.equal(normalizeTitle('Ｍｅｗ　Ｐｏｓｅ'), 'mew pose');
});
check('normalizeTitle 下划线/连续短横线压成空格', () => {
  assert.equal(normalizeTitle('Mew___Pose--v1'), 'mew pose v1');
});
check('cleanDisplayTitle 保留大小写', () => {
  assert.equal(cleanDisplayTitle('Mew_Pose_v1.zip'), 'Mew Pose v1');
});
check('titleTokens 对日文切 2-gram 且去重', () => {
  const tokens = titleTokens('ミルティナ');
  assert.ok(tokens.includes('ミル'));
  assert.ok(tokens.includes('ルテ'));
  assert.equal(tokens.length, new Set(tokens).size);
});
eq('titleScore 完全相同 = 1', titleScore('Mew Pose', 'Mew Pose'), 1);
check('titleScore 无关标题很低', () => {
  assert.ok(titleScore('Mew Pose', '完全不同的东西') < 0.2);
});
check('titleScore 对称', () => {
  const a = titleScore('Mew Pose Collection', 'Mew Pose');
  const b = titleScore('Mew Pose', 'Mew Pose Collection');
  assert.ok(Math.abs(a - b) < 1e-9);
});

// ── 纯规则：候选与三态 ──────────────────────────────────────────────────────
const purchases = Object.values(PURCHASES.items);
check('suggestBindings：asset.boothId 命中台账 → 1.0 且 source=id', () => {
  const out = suggestBindings({ boothId: '6985553', title: '随便什么' }, purchases);
  assert.equal(out[0].boothId, '6985553');
  assert.equal(out[0].score, 1);
  assert.equal(out[0].source, 'id');
});
check('suggestBindings：目录里的号命中台账也算 id', () => {
  const out = suggestBindings({ dir: '5197537/1234567', title: 'x' }, purchases);
  assert.equal(out[0].boothId, '1234567');
  assert.equal(out[0].source, 'id');
});
check('suggestBindings：标题相似 → source=title 且分数过阈值', () => {
  const out = suggestBindings({ title: 'Mew Pose Ver1.0' }, purchases);
  assert.equal(out[0].boothId, '6985553');
  assert.equal(out[0].source, 'title');
  assert.ok(out[0].score >= BIND_MIN_SCORE);
});
check('suggestBindings：limit 生效', () => {
  const out = suggestBindings({ title: 'Mew Pose' }, purchases, { limit: 1 });
  assert.ok(out.length <= 1);
});
check('suggestBindings：minScore 过高时没有候选', () => {
  assert.deepEqual(suggestBindings({ title: 'Mew Pose Ver1.0' }, purchases, { minScore: 0.99 }), []);
});
check('suggestBindings：完全对不上的标题不硬凑', () => {
  assert.deepEqual(suggestBindings({ title: 'zzz qqq' }, purchases), []);
});
check('boothStatusOf：号在 verified 集合 → verified', () => {
  assert.equal(boothStatusOf({ boothId: '6985553' }, new Set(['6985553']), []), 'verified');
});
check('boothStatusOf：有候选无验证 → candidate', () => {
  assert.equal(boothStatusOf({ boothId: '' }, new Set(), [{ boothId: '1' }]), 'candidate');
});
check('boothStatusOf：都没有 → none', () => {
  assert.equal(boothStatusOf({ boothId: '' }, new Set(), []), 'none');
});
eq('displayTitleOf：verified 用台账标题', displayTitleOf({ mainName: 'a.zip' }, { status: 'verified', verifiedTitle: 'Mew Pose Collection' }), 'Mew Pose Collection');
eq('displayTitleOf：candidate 加问号前缀', displayTitleOf({ mainName: 'a.zip' }, { status: 'candidate', suggestion: { title: 'Mew Pose' } }), '? Mew Pose');
eq('displayTitleOf：none 用洗过的文件名', displayTitleOf({ mainName: 'Mew_Pose_v1.zip' }, { status: 'none' }), 'Mew Pose v1');
eq('displayTitleOf：verified 但台账没标题时退回文件名', displayTitleOf({ mainName: 'Mew_Pose_v1.zip' }, { status: 'verified', verifiedTitle: '' }), 'Mew Pose v1');

// ── annotateBindStatus：三态 + 商品名 + 统计 ────────────────────────────────
writeState('booth-purchases.json', PURCHASES);
writeState('booth-binds.json', { version: 1, entries: { 'key-bound': { boothId: '5551234', title: '绑定过的商品', source: 'manual', at: 1 } } });
const deps = makeDeps();
const baseAssets = [
  { key: 'key-purchased', boothId: '6985553', title: '6985553', dir: '5197537', mainName: 'MewPose.zip', thumbRel: '' },
  { key: 'key-bound', boothId: '9990000', title: '绑定前的错号', dir: 'g', mainName: 'bound.zip', thumbRel: '' },
  { key: 'key-candidate', boothId: '', title: 'Mew Pose Ver1.0', dir: 'g2', mainName: 'cand.zip', thumbRel: '' },
  { key: 'key-none', boothId: '', title: '星空背景セット', dir: 'g3', mainName: 'Starry_Sky.zip', thumbRel: '' }
];
const annotated = annotateBindStatus(deps, { assets: baseAssets });
const byKey = Object.fromEntries(annotated.assets.map((asset) => [asset.key, asset]));
check('已购台账里的号 → verified', () => {
  assert.equal(byKey['key-purchased'].boothStatus, 'verified');
  assert.equal(byKey['key-purchased'].boothVerified, true);
  assert.deepEqual(byKey['key-purchased'].bindSuggestions, []);
});
check('verified 的 displayTitle 用台账标题', () => {
  assert.equal(byKey['key-purchased'].displayTitle, 'Mew Pose Collection');
});
check('人工绑定表的号也算 verified，并覆盖 asset 上错的号', () => {
  assert.equal(byKey['key-bound'].boothStatus, 'verified');
  assert.equal(byKey['key-bound'].boothId, '5551234');
  assert.equal(byKey['key-bound'].displayTitle, '绑定过的商品');
});
check('只有标题相似的件 → candidate 且带候选', () => {
  assert.equal(byKey['key-candidate'].boothStatus, 'candidate');
  assert.ok(byKey['key-candidate'].bindSuggestions.length >= 1);
  assert.ok(byKey['key-candidate'].displayTitle.startsWith('? '));
});
check('对不上的件 → none 且显示洗过的文件名', () => {
  assert.equal(byKey['key-none'].boothStatus, 'none');
  assert.equal(byKey['key-none'].displayTitle, 'Starry Sky');
});
eq('bindStats 计数', annotated.bindStats, { verified: 2, candidate: 1, none: 1 });

// ── counts：与 view 的 total 同源 ───────────────────────────────────────────
eq('countAssetViews 用 verified 口径', countAssetViews({ assets: annotated.assets, bindStats: annotated.bindStats, annotationStats: { favorites: 1 }, cloud: 718, trash: 2 }), {
  // withCover 1：verified 的已购件现在会继承台账封面（认号核准后必须立刻显示正确封面），
  // 所以 4 件里 key-purchased 有 coverUrl，其余 3 件仍无。
  all: 4, withBooth: 2, noBooth: 2, withCover: 1, noCover: 3, verified: 2, candidate: 1, suggested: 1, favorite: 1, cloud: 718, trash: 2
});
check('countAssetViews 有缩略图算 withCover', () => {
  const counts = countAssetViews({ assets: [{ thumbRel: 'a.jpg' }, { coverUrl: '' }], bindStats: { verified: 0 } });
  assert.equal(counts.withCover, 1);
  assert.equal(counts.noCover, 1);
});
eq('countCloudCards 排除库里已有的号', countCloudCards(deps, [{ boothId: '6985553' }]), 1);
writeState('booth-trash.json', { v: 1, at: 1, items: [{ id: 't1', key: 'k', title: 'x', movedTo: 'state/trash/t1', relPaths: ['a'] }, { id: 't2', key: 'k2', title: 'y', movedTo: 'state/trash/t2', relPaths: ['b'] }] });
eq('countTrashCards', countTrashCards(deps), 2);

// ── 路由 ────────────────────────────────────────────────────────────────────
function makeRequest({ method = 'GET', pathname, query = {}, body = null, headers = {}, role = '' } = {}) {
  const cap = { status: 0, headers: null, body: null, chunks: [] };
  const request = {
    req: { method, headers },
    url: { pathname, searchParams: new URLSearchParams(query) },
    consoleRole: role,
    SECURITY_HEADERS: { 'x-frame-options': 'DENY', 'Cache-Control': 'no-store' },
    readBody: async () => {
      if (body instanceof Error) throw body;
      return body ?? {};
    },
    sendJson: (payload, code = 200) => { cap.status = code; cap.body = payload; },
    res: {
      writeHead: (code, headersIn) => { cap.status = code; cap.headers = headersIn; },
      end: (chunk) => { if (chunk !== undefined) cap.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); }
    }
  };
  return { request, cap };
}
const getAssets = () => annotateBindStatus(deps, { assets: baseAssets });

await checkAsync('GET /api/library/bind-suggestions 只列未 verified 且有候选的件', async () => {
  const { request, cap } = makeRequest({ pathname: '/api/library/bind-suggestions' });
  const handled = await handleBindSuggestionRoutes(request, deps, getAssets, () => {});
  assert.equal(handled, true);
  assert.equal(cap.status, 200);
  assert.equal(cap.body.ok, true);
  assert.deepEqual(cap.body.items.map((item) => item.key), ['key-candidate']);
  assert.equal(cap.body.stats.verified, 2);
});
await checkAsync('GET bind-suggestions 的 limit 回显并被夹住', async () => {
  const { request, cap } = makeRequest({ pathname: '/api/library/bind-suggestions', query: { limit: '9999' } });
  await handleBindSuggestionRoutes(request, deps, getAssets, () => {});
  assert.equal(cap.body.limit, 500);
});
await checkAsync('GET bind-suggestions minScore 过滤掉低分候选', async () => {
  const pass = makeRequest({ pathname: '/api/library/bind-suggestions', query: { minScore: '0.5' } });
  await handleBindSuggestionRoutes(pass.request, deps, getAssets, () => {});
  assert.deepEqual(pass.cap.body.items.map((item) => item.key), ['key-candidate']);
  assert.equal(pass.cap.body.minScore, 0.5);
  const blocked = makeRequest({ pathname: '/api/library/bind-suggestions', query: { minScore: '0.99' } });
  await handleBindSuggestionRoutes(blocked.request, deps, getAssets, () => {});
  assert.deepEqual(blocked.cap.body.items, []);
});
await checkAsync('bind-suggestions 对智能体令牌 403', async () => {
  const { request, cap } = makeRequest({ pathname: '/api/library/bind-suggestions', headers: { 'x-agent-token': 'x' } });
  await handleBindSuggestionRoutes(request, deps, getAssets, () => {});
  assert.equal(cap.status, 403);
});
await checkAsync('POST 打到列表接口 → 405', async () => {
  const { request, cap } = makeRequest({ method: 'POST', pathname: '/api/library/bind-suggestions' });
  await handleBindSuggestionRoutes(request, deps, getAssets, () => {});
  assert.equal(cap.status, 405);
});
await checkAsync('POST accept 写入绑定表并回 verified', async () => {
  let invalidated = 0;
  const { request, cap } = makeRequest({ method: 'POST', pathname: '/api/library/bind-suggestion/accept', body: { key: 'key-candidate', boothId: '6985553' } });
  await handleBindSuggestionRoutes(request, deps, getAssets, () => { invalidated += 1; });
  assert.equal(cap.status, 200);
  assert.equal(cap.body.boothStatus, 'verified');
  assert.equal(cap.body.title, 'Mew Pose Collection');
  assert.equal(invalidated, 1);
  const disk = JSON.parse(fs.readFileSync(path.join(stateDir, 'booth-binds.json'), 'utf8'));
  assert.equal(disk.entries['key-candidate'].boothId, '6985553');
  writeState('booth-binds.json', { version: 1, entries: { 'key-bound': { boothId: '5551234', title: '绑定过的商品', source: 'manual', at: 1 } } });
});
await checkAsync('accept 对访客 403', async () => {
  const { request, cap } = makeRequest({ method: 'POST', pathname: '/api/library/bind-suggestion/accept', body: { key: 'key-candidate', boothId: '6985553' }, role: 'guest' });
  await handleBindSuggestionRoutes(request, deps, getAssets, () => {});
  assert.equal(cap.status, 403);
});
await checkAsync('accept 缺 key → 400', async () => {
  const { request, cap } = makeRequest({ method: 'POST', pathname: '/api/library/bind-suggestion/accept', body: { boothId: '6985553' } });
  await handleBindSuggestionRoutes(request, deps, getAssets, () => {});
  assert.equal(cap.status, 400);
});
await checkAsync('accept 号不合法 → 400', async () => {
  const { request, cap } = makeRequest({ method: 'POST', pathname: '/api/library/bind-suggestion/accept', body: { key: 'key-candidate', boothId: 'abc' } });
  await handleBindSuggestionRoutes(request, deps, getAssets, () => {});
  assert.equal(cap.status, 400);
});
await checkAsync('accept 找不到素材 → 404', async () => {
  const { request, cap } = makeRequest({ method: 'POST', pathname: '/api/library/bind-suggestion/accept', body: { key: '不存在', boothId: '6985553' } });
  await handleBindSuggestionRoutes(request, deps, getAssets, () => {});
  assert.equal(cap.status, 404);
});
await checkAsync('GET accept → 405', async () => {
  const { request, cap } = makeRequest({ pathname: '/api/library/bind-suggestion/accept' });
  await handleBindSuggestionRoutes(request, deps, getAssets, () => {});
  assert.equal(cap.status, 405);
});
await checkAsync('非本模块路径返回 false', async () => {
  const { request } = makeRequest({ pathname: '/api/library/other' });
  assert.equal(await handleBindSuggestionRoutes(request, deps, getAssets, () => {}), false);
});

// ── verified-only 封面链 ────────────────────────────────────────────────────
fs.mkdirSync(path.join(stateDir, 'booth-cache', '6985553'), { recursive: true });
fs.writeFileSync(path.join(stateDir, 'booth-cache', '6985553', 'cover.jpg'), Buffer.from([1, 2, 3]));
fs.mkdirSync(path.join(tmp, 'library'), { recursive: true });

const coverDeps = makeDeps({
  boothCacheDir: path.join(stateDir, 'booth-cache'),
  getBoothCover: async () => {
    coverDeps.__calls = (coverDeps.__calls || 0) + 1;
    const file = path.join(tmp, 'fetched.jpg');
    fs.writeFileSync(file, Buffer.from([9, 9, 9]));
    return { ok: true, path: file };
  }
});

const coverState = annotateCoverState(coverDeps, {
  assets: [
    { key: 'unverified', boothId: '6985553', boothStatus: 'candidate', boothVerified: false, thumbRel: '', coverUrl: '/api/files/cover/6985553' },
    { key: 'verified', boothId: '6985553', boothStatus: 'verified', boothVerified: true, thumbRel: '', coverUrl: '/api/files/cover/6985553' }
  ]
});
check('未 verified 且无本地缩略图：coverUrl 清空、coverReady=false', () => {
  const card = coverState.assets.find((asset) => asset.key === 'unverified');
  assert.equal(card.coverUrl, '');
  assert.equal(card.coverReady, false);
});
check('verified：允许用台账/BOOTH 缓存里的封面', () => {
  const card = coverState.assets.find((asset) => asset.key === 'verified');
  assert.equal(card.coverReady, true);
  assert.equal(card.coverSource, 'ledger');
  assert.equal(card.coverUrl, '/api/files/cover/6985553');
});

await checkAsync('未 verified 的号不触发 BOOTH 抓取（假 fetch 计数 0）', async () => {
  coverDeps.__calls = 0;
  const { request, cap } = makeRequest({ pathname: '/api/library/cover', query: { key: 'unverified' } });
  const handled = await handleLibraryCoverRoute(request, coverDeps, async () => ({
    assets: [{ key: 'unverified', boothId: '6985553', boothStatus: 'candidate', boothVerified: false, thumbRel: '', dir: 'g', mainName: 'x.jpg' }]
  }));
  assert.equal(handled, true);
  assert.equal(cap.status, 404);
  assert.equal(coverDeps.__calls, 0);
});
await checkAsync('verified 的号触发 BOOTH 抓取，头里是 X-Cover-Source: booth', async () => {
  coverDeps.__calls = 0;
  const { request, cap } = makeRequest({ pathname: '/api/library/cover', query: { key: 'verified' } });
  await handleLibraryCoverRoute(request, coverDeps, async () => ({
    assets: [{ key: 'verified', boothId: '999888777', boothStatus: 'verified', boothVerified: true, thumbRel: '', dir: 'g', mainName: 'x.jpg' }]
  }));
  assert.equal(cap.status, 200);
  assert.equal(cap.headers['X-Cover-Source'], 'booth');
  assert.equal(coverDeps.__calls, 1);
});

// ── 目录号才是商品号（2026-10-30 用户追问「已购里抓的商品名/封面都对，素材库对不上」）────
// 真机事实：转存结构是 `<商品号>/<下载文件>.zip`，目录 5197537 是商品号，文件名 6985553 是下载文件 id。
// 旧逻辑优先采信名字前缀 → 16 件绑到了下载 id 上，商品名/封面自然全错。
writeState('booth-purchases.json', {
  version: 1,
  items: {
    ...PURCHASES.items,
    5197537: {
      boothId: '5197537', title: '【MA設定済】ゆらゆらオバケギミック', shopName: 'manzp’s SHOP',
      priceText: '¥300', coverUrl: 'https://img.example/5197537.jpg', updatedAt: 5
    }
  }
});

check('dirBoothIdOf：目录第一段是合法号', () => {
  assert.equal(dirBoothIdOf({ dir: '5197537' }), '5197537');
});
check('dirBoothIdOf：群目录混文字时取第一个纯数字段', () => {
  assert.equal(dirBoothIdOf({ dir: '100000001_扣1复活牢大/9028816' }), '9028816');
});
check('dirBoothIdOf：目录里没有号 → 空', () => {
  assert.equal(dirBoothIdOf({ dir: 'g/c/plain' }), '');
  assert.equal(dirBoothIdOf({}), '');
});
check('boothIdSourceOf：name-prefix 标成 download-id', () => {
  assert.equal(boothIdSourceOf({ boothSource: 'name-prefix' }), 'download-id');
  assert.equal(boothIdSourceOf({ boothSource: 'folder' }), 'folder');
  assert.equal(boothIdSourceOf({}), 'guess');
});
const dirVerified = new Set(['5197537', '6985553']);
check('resolveBoothId：目录号命中台账 → dir 且 verified', () => {
  assert.deepEqual(resolveBoothId({ boothId: '6985553', boothSource: 'name-prefix', dir: '5197537' }, dirVerified), {
    boothId: '5197537', source: 'dir', verified: true
  });
});
check('resolveBoothId：目录号不在台账、有绑定 → bind', () => {
  assert.deepEqual(resolveBoothId({ dir: 'g', boothId: '' }, dirVerified, '5551234'), { boothId: '5551234', source: 'bind', verified: true });
});
check('resolveBoothId：只有名字前缀 → 不 verified（下载 id 不是商品号）', () => {
  const out = resolveBoothId({ boothId: '6985553', boothSource: 'name-prefix', dir: 'g' }, dirVerified);
  assert.equal(out.boothId, '6985553');
  assert.equal(out.source, 'download-id');
  assert.equal(out.verified, false);
});
check('resolveBoothId：dir 不在台账时也不抢人工绑定', () => {
  assert.equal(resolveBoothId({ dir: '7777777', boothId: '6985553' }, dirVerified, '5551234').source, 'bind');
});
check('suggestBindings：目录号命中 → 1.0 且 source=dir，压过名字前缀', () => {
  const out = suggestBindings({ boothId: '6985553', boothSource: 'name-prefix', dir: '5197537' }, [
    { boothId: '6985553', title: 'Mew Pose Collection' },
    { boothId: '5197537', title: '【MA設定済】ゆらゆらオバケギミック' }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].boothId, '5197537');
  assert.equal(out[0].score, 1);
  assert.equal(out[0].source, 'dir');
  assert.equal(out[0].kind, 'item-id');
});
check('suggestBindings：名字前缀撞上商品号 → 0.95 + kind=download-id', () => {
  const out = suggestBindings({ boothId: '6985553', boothSource: 'name-prefix', dir: 'g' }, [{ boothId: '6985553', title: 'Mew Pose Collection' }]);
  assert.equal(out[0].boothId, '6985553');
  assert.equal(out[0].score, 0.95);
  assert.equal(out[0].source, 'download-id');
  assert.equal(out[0].kind, 'download-id');
});
check('suggestBindings：dir 是号但台账没有 → 当候选交人确认', () => {
  const out = suggestBindings({ dir: '7777777' }, [{ boothId: '6985553', title: 'Mew Pose Collection' }]);
  assert.equal(out[0].boothId, '7777777');
  assert.equal(out[0].source, 'dir');
  assert.equal(out[0].kind, 'item-id');
});
check('boothStatusOf：目录号命中 verified → verified（哪怕自带号是错的）', () => {
  assert.equal(boothStatusOf({ boothId: '6985553', boothIdKind: 'download-id', dir: '5197537' }, new Set(['5197537']), []), 'verified');
});
const dirAnnotated = annotateBindStatus(deps, {
  assets: [
    { key: 'dir-hit', boothId: '6985553', boothSource: 'name-prefix', title: '6985553', dir: '5197537', mainName: '6985553.zip', thumbRel: '' },
    { key: 'prefix-only', boothId: '6985553', boothSource: 'name-prefix', title: '6985553', dir: 'g', mainName: '6985553.zip', thumbRel: '' },
    { key: 'dir-unknown', boothId: '', dir: '7777777', mainName: 'mystery.zip', thumbRel: '' }
  ]
});
const dirByKey = Object.fromEntries(dirAnnotated.assets.map((asset) => [asset.key, asset]));
check('目录号命中台账：换成真商品号并 verified', () => {
  const card = dirByKey['dir-hit'];
  assert.equal(card.boothId, '5197537');
  assert.equal(card.boothIdSource, 'dir');
  assert.equal(card.boothStatus, 'verified');
  assert.equal(card.boothVerified, true);
});
check('目录号命中台账：商品名与封面都来自台账', () => {
  const card = dirByKey['dir-hit'];
  assert.equal(card.displayTitle, '【MA設定済】ゆらゆらオバケギミック');
  assert.equal(card.coverUrl, 'https://img.example/5197537.jpg');
});
check('名字前缀不再产生 verified，并标成 download-id 提示', () => {
  const card = dirByKey['prefix-only'];
  assert.equal(card.boothStatus, 'candidate');
  assert.equal(card.boothIdKind, 'download-id');
  assert.equal(card.bindSuggestions[0].kind, 'download-id');
});
check('dir 是号但台账没有 → candidate，候选就是那个目录号', () => {
  const card = dirByKey['dir-unknown'];
  assert.equal(card.boothStatus, 'candidate');
  assert.equal(card.boothId, '7777777');
  assert.equal(card.bindSuggestions[0].boothId, '7777777');
  assert.equal(card.bindSuggestions[0].source, 'dir');
});
eq('目录号批的 bindStats', dirAnnotated.bindStats, { verified: 1, candidate: 2, none: 0 });

fs.rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n❌ ${failures} 项失败（通过 ${pass}）`);
  process.exit(1);
}
console.log(`\n🎉 test-library-bind-match 全部通过（${pass} 项）`);
