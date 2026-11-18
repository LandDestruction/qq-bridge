#!/usr/bin/env node
// 「以图搜源」后端契约测试（src/bridge/console/library-find-by-image.js）。
//
// 为什么用假 deps：这个模块被 vm 裸执行（零 import），所有能力都从 deps 拿。
// 测试里只把「网络、封面下载、指纹计算」换成可控桩，搜索页解析/标题相似度/暂停闸
// 用真实纯规则模块，这样断言的是真实排序与真实暂停语义，而不是复述一遍桩。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLibraryFindByImage } from '../src/bridge/console/library-find-by-image.js';
import * as boothSearch from '../src/booth-search.js';
import * as libraryFind from '../src/library-find.js';

const checks = [];
function check(cond, name, extra) {
  checks.push({ ok: Boolean(cond), name, extra });
  if (!cond) console.error(`✗ ${name}`, extra === undefined ? '' : extra);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-find-by-image-'));
const stateDir = path.join(tmp, 'state');
const rootDir = path.join(tmp, 'library');
const cacheDir = path.join(tmp, 'cover-cache');
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(path.join(rootDir, 'g/c/mew'), { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });
fs.writeFileSync(path.join(rootDir, 'g/c/mew/thumb.png'), 'LOCAL-COVER');

// 指纹桩：按图片首字节给 16 位十六进制，距离可算（同图=0，异图=64）。
const HASHES = {
  L: '0f0f0f0f0f0f0f0f',
  S: '0f0f0f0f0f0f0f0f',
  X: 'ffffffffffffffff'
};
const SAME_COVER_IDS = new Set(['7850009']);

function hashOfBytes(bytes) {
  const first = bytes && bytes.length ? String.fromCharCode(bytes[0]) : '';
  return HASHES[first] || null;
}

const SEARCH_HTML = `
<ul>
  <li class="item-card l-card" data-product-id="7850009" data-product-name="Mew Pose Ver.1" data-product-price="1190" data-product-brand="foxyplay" data-product-position="0">
    <a class="js-thumbnail-image" data-original="https://booth.pximg.net/7850009.jpg"></a>
    <div class="item-card__title"><a class="item-card__title-anchor--multiline">【VRChat】Mew Pose Ver.1</a></div>
    <a class="item-card__shop-name-anchor" href="https://foxyplay.booth.pm/">foxyplay</a>
  </li>
  <li class="item-card l-card" data-product-id="7850010" data-product-name="Unrelated Texture" data-product-price="500" data-product-position="1">
    <a class="js-thumbnail-image" data-original="https://booth.pximg.net/7850010.jpg"></a>
    <div class="item-card__title"><a class="item-card__title-anchor--multiline">完全不相干的高斯模糊贴图</a></div>
    <a class="item-card__shop-name-anchor" href="https://other.booth.pm/">other</a>
  </li>
  <li class="item-card l-card" data-product-id="7850011" data-product-name="Mew Pose Ver.2" data-product-price="1290" data-product-position="2">
    <a class="js-thumbnail-image" data-original="https://booth.pximg.net/7850011.jpg"></a>
    <div class="item-card__title"><a class="item-card__title-anchor--multiline">Mew Pose Ver.2</a></div>
    <a class="item-card__shop-name-anchor" href="https://foxyplay.booth.pm/">foxyplay</a>
  </li>
</ul>
<b>対象商品 3 件</b>
`;

function makeDeps(overrides = {}) {
  const calls = { fetch: [], covers: [], logged: [] };
  const deps = {
    fs,
    path,
    STATE_DIR: stateDir,
    AbortSignal,
    atomicWriteJson: (abs, data) => fs.writeFileSync(abs, JSON.stringify(data, null, 2)),
    boothCacheDir: () => cacheDir,
    boothSearchPure: boothSearch,
    libraryFindPure: libraryFind,
    buildLibrarySnapshot: () => ({
      ok: true,
      assets: [
        { key: 'g/c/mew', title: 'Mew Pose Ver.1', shopName: 'foxyplay', thumbRel: 'g/c/mew/thumb.png', boothId: '' },
        { key: 'g/c/none', title: '没封面的素材', thumbRel: '', boothId: '' }
      ]
    }),
    fileArchiveDb: () => null,
    listArchive: () => [],
    fileArchiveRootDir: () => rootDir,
    safeResolveInside: (root, rel) => {
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(path.resolve(root))) throw new Error('逃出素材目录');
      return abs;
    },
    dhashFromBufferAsync: async (bytes) => hashOfBytes(bytes),
    fetch: async (url) => {
      calls.fetch.push(String(url));
      if (String(url).includes('search')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => SEARCH_HTML
        };
      }
      // 外部图片 URL
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode('LOCAL-COVER').buffer
      };
    },
    getBoothCover: async (boothId) => {
      calls.covers.push(String(boothId));
      const abs = path.join(cacheDir, `${boothId}.jpg`);
      fs.writeFileSync(abs, SAME_COVER_IDS.has(String(boothId)) ? 'SAME' : 'XDIFF');
      return { ok: true, path: abs };
    },
    log: (message) => calls.logged.push(String(message))
  };
  return { deps: { ...deps, ...overrides }, calls };
}

function makeRequest({ method = 'POST', pathname = '/api/library/find-by-image', headers = {}, body } = {}) {
  const out = { status: 0, json: null, handled: false };
  const request = {
    url: { pathname },
    req: { method, headers },
    readBody: async () => {
      if (body === undefined) {
        const error = new Error('请求体不是合法 JSON');
        error.statusCode = 400;
        throw error;
      }
      return body;
    },
    sendJson: (json, status = 200) => {
      out.json = json;
      out.status = status;
    }
  };
  return { request, out };
}

const service = createLibraryFindByImage(makeDeps().deps);
const handle = service.handleConsoleLibraryFindByImage;
check(typeof handle === 'function', '工厂返回 handleConsoleLibraryFindByImage', typeof handle);
check(Object.keys(service).length === 1, '工厂只暴露一个处理函数', Object.keys(service));

// ① 不接管别的路径
{
  const { request, out } = makeRequest({ pathname: '/api/library/find', body: {} });
  const handled = await handle(request);
  check(handled === false && out.json === null, '不接管其它路径（留给 library-find）', handled);
}

// ② 只收 POST
{
  const { deps } = makeDeps();
  const { request, out } = makeRequest({ method: 'GET', body: undefined });
  await createLibraryFindByImage(deps).handleConsoleLibraryFindByImage(request);
  check(out.status === 405, '导出只收 POST（GET → 405）', out.status);
}

// ③ 智能体令牌一律拒绝
{
  const { deps } = makeDeps();
  const { request, out } = makeRequest({ headers: { 'x-agent-token': 'abc' }, body: {} });
  await createLibraryFindByImage(deps).handleConsoleLibraryFindByImage(request);
  check(out.status === 403 && /管理端/.test(out.json?.error || ''), '带 x-agent-token → 403 且说人话', out.json);
}

// ④ 缺参数
{
  const { deps } = makeDeps();
  const { request, out } = makeRequest({ body: {} });
  await createLibraryFindByImage(deps).handleConsoleLibraryFindByImage(request);
  check(out.status === 400 && /key 或 imageUrl/.test(out.json?.error || ''), '缺 key/imageUrl → 400', out.json);
}

// ⑤ 素材不存在
{
  const { deps } = makeDeps();
  const { request, out } = makeRequest({ body: { key: 'g/c/不存在' } });
  await createLibraryFindByImage(deps).handleConsoleLibraryFindByImage(request);
  check(out.status === 404, '素材找不到 → 404', out.json);
}

// ⑥ 没有封面
{
  const { deps } = makeDeps();
  const { request, out } = makeRequest({ body: { key: 'g/c/none' } });
  await createLibraryFindByImage(deps).handleConsoleLibraryFindByImage(request);
  check(out.status === 400 && out.json?.error === '这件没有封面，先补封面', '没有封面 → 400 且提示补封面', out.json);
}

// ⑦ 正常路径：本地封面算指纹 → 标题生成搜索词 → 候选按「封面指纹 + 标题」排序
{
  const { deps, calls } = makeDeps();
  const { request, out } = makeRequest({ body: { key: 'g/c/mew' } });
  await createLibraryFindByImage(deps).handleConsoleLibraryFindByImage(request);
  const json = out.json || {};
  check(out.status === 200 && json.ok === true, '正常路径 200 ok', { status: out.status, error: json.error });
  check(json.localHash === HASHES.L, '本地封面 dHash 已算出', json.localHash);
  check(Array.isArray(json.queries) && json.queries.length >= 1 && json.queries[0].includes('Mew Pose'), '搜索词从标题生成', json.queries);
  check(calls.fetch.length === json.queries.length, '每个搜索词只联网一次', calls.fetch.length);
  check(Array.isArray(json.candidates) && json.candidates.length === 3, '候选都回来了（按 boothId 去重）', json.candidates?.length);
  const top = json.candidates?.[0] || {};
  check(top.boothId === '7850009', '封面指纹一致 + 标题相似的那件排第一', top.boothId);
  check(top.coverDistance === 0 && top.coverMatch === true, '第一名的封面距 0（同一张图）', { coverDistance: top.coverDistance, coverMatch: top.coverMatch });
  check(typeof top.score === 'number' && top.score > 0 && top.titleScore > 0.5, '分数与标题相似度都在响应里', { score: top.score, titleScore: top.titleScore });
  const irrelevant = (json.candidates || []).find((c) => c.boothId === '7850010') || {};
  check(irrelevant.coverDistance >= 10 && irrelevant.score < top.score, '不相干候选封面距超过阈值且分数更低', { coverDistance: irrelevant.coverDistance, score: irrelevant.score });
  check(
    ['boothId', 'title', 'shopName', 'price', 'itemUrl', 'thumbUrl', 'coverDistance', 'titleScore', 'score'].every((k) => k in top),
    '候选字段齐（boothId/title/shopName/price/itemUrl/thumbUrl/coverDistance/titleScore/score）',
    Object.keys(top)
  );
  check(/7850009/.test(json.summary || ''), 'summary 说人话（带上最像的号）', json.summary);
}

// ⑧ 本地没有标题时用调用方给的 queries
{
  const { deps, calls } = makeDeps({
    buildLibrarySnapshot: () => ({ assets: [{ key: 'g/c/bare', title: '', thumbRel: 'g/c/mew/thumb.png' }] })
  });
  const { request, out } = makeRequest({ body: { key: 'g/c/bare', queries: ['Mew Pose'] } });
  await createLibraryFindByImage(deps).handleConsoleLibraryFindByImage(request);
  check(out.status === 200 && out.json?.queries?.[0] === 'Mew Pose', '没标题时用调用方 queries', out.json?.queries);
  check(calls.fetch.length === 1, '只用了一个搜索词', calls.fetch.length);
}

// ⑨ 既没标题也没 queries → 400
{
  const { deps } = makeDeps({
    buildLibrarySnapshot: () => ({ assets: [{ key: 'g/c/bare', title: '', thumbRel: 'g/c/mew/thumb.png' }] })
  });
  const { request, out } = makeRequest({ body: { key: 'g/c/bare' } });
  await createLibraryFindByImage(deps).handleConsoleLibraryFindByImage(request);
  check(out.status === 400 && /queries/.test(out.json?.error || ''), '没标题也没 queries → 400', out.json);
}

// ⑩ 暂停闸：已经暂停时不联网，回 paused
{
  const { deps, calls } = makeDeps();
  fs.writeFileSync(
    path.join(stateDir, 'booth-search-pause.json'),
    JSON.stringify({ pausedUntil: Date.now() + 600000, reason: 'BOOTH 搜索被限速（HTTP 429）', status: 429, at: Date.now() })
  );
  const { request, out } = makeRequest({ body: { key: 'g/c/mew' } });
  await createLibraryFindByImage(deps).handleConsoleLibraryFindByImage(request);
  check(out.json?.paused === true && out.json?.ok === false, '暂停中 → 回 paused', out.json);
  check(calls.fetch.length === 0, '暂停中一次都不联网', calls.fetch.length);
  check(/还要等约/.test(out.json?.error || ''), '暂停提示含等待时长', out.json?.error);
  fs.rmSync(path.join(stateDir, 'booth-search-pause.json'), { force: true });
}

// ⑪ 搜索撞 429 → 落暂停文件，并回 paused
{
  const { deps } = makeDeps({
    fetch: async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => (String(name).toLowerCase() === 'retry-after' ? '120' : null) },
      text: async () => ''
    })
  });
  const { request, out } = makeRequest({ body: { key: 'g/c/mew' } });
  await createLibraryFindByImage(deps).handleConsoleLibraryFindByImage(request);
  const pauseFile = path.join(stateDir, 'booth-search-pause.json');
  check(out.json?.paused === true, '429 → 回 paused', out.json?.error);
  check(fs.existsSync(pauseFile), '429 → 落了 booth-search-pause.json');
  const saved = JSON.parse(fs.readFileSync(pauseFile, 'utf8'));
  check(saved.status === 429 && saved.pausedUntil > Date.now(), '暂停文件里有 status 与 pausedUntil', saved);
  fs.rmSync(pauseFile, { force: true });
}

// ⑫ 搜索页 500（不是限速）→ 不落暂停，回错误但 ok
{
  const { deps } = makeDeps({
    fetch: async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => '' })
  });
  const { request, out } = makeRequest({ body: { key: 'g/c/mew' } });
  await createLibraryFindByImage(deps).handleConsoleLibraryFindByImage(request);
  check(out.status === 200 && out.json?.ok === true && (out.json?.errors || []).length >= 1, '搜索页 500 → ok:true + errors 里说明', out.json);
  check(!fs.existsSync(path.join(stateDir, 'booth-search-pause.json')), '500 不触发暂停闸');
}

// ⑬ imageUrl 直接给图（本机相对地址）
{
  const { deps } = makeDeps();
  const { request, out } = makeRequest({ body: { imageUrl: '/api/files/raw?rel=' + encodeURIComponent('g/c/mew/thumb.png'), queries: ['Mew Pose'] } });
  await createLibraryFindByImage(deps).handleConsoleLibraryFindByImage(request);
  check(out.status === 200 && out.json?.localHash === HASHES.L, 'imageUrl 支持本机相对地址', out.json?.localHash);
}

// ⑭ imageUrl 是外部地址
{
  const { deps, calls } = makeDeps();
  const { request, out } = makeRequest({ body: { imageUrl: 'https://example.com/x.png', queries: ['Mew Pose'] } });
  await createLibraryFindByImage(deps).handleConsoleLibraryFindByImage(request);
  check(out.status === 200 && out.json?.localHash === HASHES.L, 'imageUrl 支持外部图片地址', out.json?.localHash);
  check(calls.fetch.some((u) => u.includes('example.com')), '真的去下载了那张图', calls.fetch);
}

// ⑮ 请求体不是合法 JSON → 400
{
  const { deps } = makeDeps();
  const { request, out } = makeRequest({ body: undefined });
  await createLibraryFindByImage(deps).handleConsoleLibraryFindByImage(request);
  check(out.status === 400, '请求体非法 → 400', out.json);
}

fs.rmSync(tmp, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
for (const item of checks) if (item.ok) console.log(`✓ ${item.name}`);
console.log(`\n========== 以图搜源：通过 ${checks.length - failed.length} / 失败 ${failed.length} ==========`);
if (failed.length) process.exit(1);
