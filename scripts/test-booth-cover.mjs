// BOOTH 商品封面（cover）抓取 / 缓存 / 同号图片归属（离线 fake fetch + 真 ffmpeg 缩图）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getBoothCover, coverPaths, COVER_MAX_EDGE, COVER_MAX_BYTES } from '../src/booth-cover.js';
import { matchImageBooth, parseBoothName } from '../src/booth-meta.js';
import { imageSize } from '../src/booth-thumb.js';

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { fail += 1; console.error(`  FAIL ${name}: ${error?.message ?? error}`); }
}

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cover-'));
// 全局暂停文件也落在临时目录：否则仓库里真有一份暂停（线上常见）会把这些用例全判成 paused。
const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cover-state-'));
const samplePng = path.join(tmp, 'sample.png');
if (hasFfmpeg) {
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=600x400', '-frames:v', '1', samplePng], { encoding: 'utf8' });
}

const html = '<html><head>'
  + '<meta property="og:image" content="https://booth.pximg.net/og.jpg">'
  + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"封面测试商品","image":"https://booth.pximg.net/ld.jpg"}</script>'
  + '</head><body></body></html>';

function fakeFetch(counter) {
  return async () => { counter.calls += 1; return { status: 200, text: async () => html }; };
}
function fakeDownload(counter, { copy = true } = {}) {
  return async (url, dest) => {
    counter.downloads += 1;
    counter.lastUrl = url;
    if (!copy) throw new Error('HTTP 500 下载失败');
    fs.copyFileSync(samplePng, dest);
  };
}

console.log('[1] cover 抓取：优先 og:image，缩到 ≤512 且 ≤200KB');
await check('生成 cover.jpg + cover.json，尺寸/大小达标', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cover-cache-'));
  const fetchCounter = { calls: 0 };
  const dlCounter = { downloads: 0, lastUrl: '' };
  const cover = await getBoothCover('9038753', {
    cacheRoot,
    stateDir: tmpState,
    fetchImpl: fakeFetch(fetchCounter),
    downloadImpl: fakeDownload(dlCounter),
    rateLimitMs: 1
  });
  assert.equal(cover.ok, true);
  assert.equal(cover.status, 'ok');
  assert.equal(dlCounter.lastUrl, 'https://booth.pximg.net/og.jpg', '必须优先 og:image');
  const { coverPath, metaPath } = coverPaths(cacheRoot, '9038753');
  assert.equal(fs.existsSync(coverPath), true);
  assert.equal(fs.statSync(coverPath).size <= COVER_MAX_BYTES, true, `cover 应 ≤200KB（${fs.statSync(coverPath).size}）`);
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.equal(meta.status, 'ok');
  if (hasFfmpeg) {
    const dims = imageSize(coverPath);
    assert.ok(dims, 'ffprobe 应能读尺寸');
    assert.ok(Math.max(dims.width, dims.height) <= COVER_MAX_EDGE, `长边应 ≤512（实际 ${dims.width}x${dims.height}）`);
  }
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

console.log('[2] 缓存：30 天内第二次不重复抓');
await check('第二次调用 cached=true，fetch/download 不增加', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cover-cache-'));
  const fetchCounter = { calls: 0 };
  const dlCounter = { downloads: 0 };
  const opts = { cacheRoot, stateDir: tmpState, fetchImpl: fakeFetch(fetchCounter), downloadImpl: fakeDownload(dlCounter), rateLimitMs: 1 };
  const a = await getBoothCover('9038753', opts);
  const b = await getBoothCover('9038753', opts);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.cached, true);
  assert.equal(fetchCounter.calls, 1);
  assert.equal(dlCounter.downloads, 1);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

console.log('[3] 失败分支：封面下载失败 → error + cover_error，不抛；1 天内不重试');
await check('下载抛错：status=error、coverError 有原因、无 cover.jpg', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cover-cache-'));
  const fetchCounter = { calls: 0 };
  const dlCounter = { downloads: 0 };
  const opts = {
    cacheRoot,
    stateDir: tmpState,
    fetchImpl: fakeFetch(fetchCounter),
    downloadImpl: fakeDownload(dlCounter, { copy: false }),
    rateLimitMs: 1
  };
  const a = await getBoothCover('9038754', opts);
  assert.equal(a.ok, false);
  assert.equal(a.status, 'error');
  assert.match(a.coverError, /下载失败/);
  assert.equal(fs.existsSync(coverPaths(cacheRoot, '9038754').coverPath), false);
  const before = fetchCounter.calls;
  const b = await getBoothCover('9038754', opts);
  assert.equal(b.ok, false);
  assert.equal(b.cached, true, '失败结果也应缓存（1 天）');
  assert.equal(fetchCounter.calls, before, '失败缓存期内不再请求');
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

console.log('[4] 同号图片归属 matchImageBooth');
await check('命中已有 BOOTH 号；未知号/日期陷阱/无号返回 null', () => {
  const ids = ['9038753', '6641548'];
  assert.equal(matchImageBooth('9038753 preview.png', ids), '9038753');
  assert.equal(matchImageBooth('6641548_cover.jpg', ids), '6641548');
  assert.equal(matchImageBooth('9999999 preview.png', ids), null, '不在已有商品号里 → null');
  assert.equal(matchImageBooth('20240101 shot.png', ids), null, '日期开头不算');
  assert.equal(matchImageBooth('preview.png', ids), null);
  assert.equal(matchImageBooth('1234567890 x.png', ids), null, '10 位数字不算');
  // 与 parseBoothName 的陷阱保持一致
  assert.equal(parseBoothName('20240101 shot.png').boothId, null);
});

console.log('[4] 全局暂停：暂停中不发请求，429/403 写同一份状态文件');
await check('暂停中：getBoothCover 直接 paused，一次 fetch 都不发', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cover-cache-'));
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cover-pause-'));
  try {
    fs.writeFileSync(path.join(st, 'booth-search-pause.json'), JSON.stringify({ pausedUntil: Date.now() + 5 * 60 * 1000, reason: 'BOOTH 搜索被限速（HTTP 429）', status: 429, at: Date.now() }));
    const counter = { calls: 0 };
    const cover = await getBoothCover('9038753', { cacheRoot, stateDir: st, fetchImpl: fakeFetch(counter), rateLimitMs: 1, now: Date.now() });
    assert.equal(cover.status, 'paused');
    assert.equal(cover.paused, true);
    assert.equal(counter.calls, 0, '暂停中不许发请求');
    assert.match(cover.error, /剩余 \d+ 分钟/);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(st, { recursive: true, force: true });
  }
});

await check('HTTP 429（带 Retry-After）→ paused 且写全局暂停；过期后恢复请求', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cover-cache-'));
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cover-pause-'));
  try {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { status: 429, headers: { get: () => '90' }, text: async () => '' }; };
    const first = await getBoothCover('9038753', { cacheRoot, stateDir: st, fetchImpl, rateLimitMs: 1, now: 1000 });
    assert.equal(first.status, 'paused');
    assert.equal(calls, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(st, 'booth-search-pause.json'), 'utf8'));
    assert.equal(saved.status, 429);
    assert.equal(saved.pausedUntil, 1000 + 90000, 'Retry-After 90 秒优先');
    // 暂停过期后重新请求（用 ok 的 fetch 验证确实恢复了）
    const okCover = await getBoothCover('9038753', {
      cacheRoot, stateDir: st, fetchImpl: fakeFetch({ calls: 0 }), downloadImpl: fakeDownload({ downloads: 0 }), rateLimitMs: 1,
      now: 1000 + 90000 + 1, force: true
    });
    assert.notEqual(okCover.status, 'paused');
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(st, { recursive: true, force: true });
  }
});

await check('HTTP 403 → paused 且写全局暂停（30 分钟）', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cover-cache-'));
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cover-pause-'));
  try {
    const fetchImpl = async () => ({ status: 403, text: async () => '' });
    const cover = await getBoothCover('9038753', { cacheRoot, stateDir: st, fetchImpl, rateLimitMs: 1, now: 1 });
    assert.equal(cover.status, 'blocked', '旧状态名保留');
    assert.equal(cover.paused, true);
    const saved = JSON.parse(fs.readFileSync(path.join(st, 'booth-search-pause.json'), 'utf8'));
    assert.equal(saved.status, 403);
    assert.equal(saved.pausedUntil, 1 + 30 * 60 * 1000);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(st, { recursive: true, force: true });
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(tmpState, { recursive: true, force: true });
console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
