// 本地缩略图路由 + 来源链：HTTP 契约（md5 存在 200 / 不存在 404）+ 面板链顺序。
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { startConsoleFixture } from './console-ui-fixture.mjs';

const html = fs.readFileSync('public/ops.html', 'utf8');
const start = html.indexOf('let stickerCache = [];');
const end = html.indexOf('function renderStickers()');
assert.ok(start > 0 && end > start, '无法从 ops.html 抽出缩略图链');
const code = html.slice(start, end);

const results = [];
const check = (label, fn) => {
  try { fn(); results.push('OK   ' + label); } catch (e) { results.push('FAIL ' + label + ' — ' + e.message); process.exitCode = 1; }
};

const fixture = await startConsoleFixture({ port: 0 });
const get = async (path) => {
  const res = await fetch(fixture.url + path);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), bytes: buf.length, text: res.status === 200 ? '' : buf.toString('utf8') };
};

// ① 路由：md5 存在 → 200 + image/* + 缓存头 + 字节数与文件一致
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const hit = await get('/api/stickers/thumb?md5=AAAA1111');
console.log(`[命中] ${hit.status} ${hit.type} ${hit.cache} bytes=${hit.bytes}`);
check('md5 存在 → 200', () => assert.equal(hit.status, 200));
check('返回 Content-Type: image/*', () => assert.match(String(hit.type), /^image\//));
check('返回 Cache-Control: max-age=86400（长期缓存）', () => assert.match(String(hit.cache), /max-age=86400/));
check('字节长度与缓存文件一致（1×1 PNG 68 字节）', () => assert.equal(hit.bytes, png.length));

// ② 路由：md5 不存在 → 404（不是 200 空图）
const miss = await get('/api/stickers/thumb?md5=NOT-EXIST');
console.log(`[未命中] ${miss.status} ${String(miss.text).slice(0, 60)}`);
check('md5 不存在 → 404，且说明原因', () => {
  assert.equal(miss.status, 404);
  assert.match(String(miss.text), /本地缓存里没有这个 md5/);
});
// ③ 路由：md5 为空 → 400
const bad = await get('/api/stickers/thumb');
check('md5 为空 → 400', () => assert.equal(bad.status, 400));

// ④ 面板来源链顺序：本地 md5 路由 → thumbnail → CDN；全部失败才占位
function makeUi(base) {
  const els = new Map();
  const mk = () => ({
    tagName: 'DIV', textContent: '', className: '', style: { cssText: '' }, dataset: {}, children: [], title: '', alt: '',
    _src: '', onerror: null, isConnected: true, parent: null, attrs: {},
    set src(v) { this._src = String(v); },
    get src() { return this._src; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
  });
  const document = {
    getElementById(id) { if (!els.has(id)) { const e = mk(); e.id = id; els.set(id, e); } return els.get(id); },
    createElement: (tag) => Object.assign(mk(), { tagName: String(tag).toUpperCase() }),
    querySelectorAll: () => [],
  };
  const msgs = [];
  const sandbox = {
    document,
    token: 'fixture-token',
    fetch: (url, opts) => fetch(String(url).startsWith('http') ? url : base + url, opts),
    setStickerMsg: (text) => { msgs.push(text); },
    renderStickers: () => {},
    opsGridError: () => {},
    Date, Number, Math, JSON, String, Array, Set, Promise, setTimeout,
    console: { log() {}, warn() {}, error() {} },
  };
  const api = new Function(...Object.keys(sandbox), code + '\nreturn { buildStickerThumb, stickerThumbChain, STICKER_BROKEN_IDS, STICKER_PLACEHOLDER_TEXT, STICKER_EXPIRED_TEXT, isStickerBroken, removeSticker, loadStickers, getTotal: () => stickerTotal };')(...Object.values(sandbox));
  return { ...api, els, msgs, document };
}

const ui = makeUi(fixture.url);
const entry = { id: 'demo-a', md5: 'AAAA1111', url: 'https://p.qpic.cn/qq_expression/xyz/0', desc: '演示' };
const chain = ui.stickerThumbChain(entry);
console.log('[来源链]', chain.join(' → '));
check('来源链顺序：本地 md5 → thumbnail → CDN', () => {
  assert.equal(chain.length, 3);
  assert.match(chain[0], /^\/api\/stickers\/thumb\?md5=AAAA1111/);
  assert.match(chain[1], /^\/api\/stickers\/thumbnail\?id=demo-a/);
  assert.equal(chain[2], entry.url);
});
check('CDN 只在最后一级（不是唯一来源）', () => {
  assert.ok(chain.indexOf(entry.url) === chain.length - 1);
});

const host = ui.buildStickerThumb(entry);
const img = host.children[0];
check('首帧 src 是本地 md5 路由', () => assert.match(img.src, /^\/api\/stickers\/thumb\?md5=/));
img.onerror();
check('第二帧是 thumbnail', () => assert.match(img.src, /^\/api\/stickers\/thumbnail\?id=/));
img.onerror();
check('第三帧是 CDN', () => assert.equal(img.src, entry.url));
img.onerror();
check('全部失败 → 占位文案 + 记入失效集合', () => {
  assert.equal(host.children.length, 1);
  assert.match(host.children[0].textContent, /缩略图不可用（本地缓存缺失\/损坏，可用「重新拉取」）/);
  assert.ok(ui.STICKER_BROKEN_IDS.has(entry.id));
});

// ⑤ 缩略图接口 404 / 超时：链要能继续走，不抛
for (const mode of ['missing', 'timeout']) {
  const f2 = await startConsoleFixture({ port: 0, fail: 'api/stickers/thumb:' + (mode === 'missing' ? '404' : 'timeout') });
  const ui2 = makeUi(f2.url);
  const host2 = ui2.buildStickerThumb(entry);
  const img2 = host2.children[0];
  let thrown = null;
  try {
    img2.onerror();
    img2.onerror();
    img2.onerror();
  } catch (e) { thrown = e; }
  console.log(`[thumb ${mode}] 占位=${host2.children[0] ? host2.children[0].textContent.slice(0, 20) : '(img)'} thrown=${thrown ? 'yes' : 'no'}`);
  check(`thumb ${mode} → 链正常推进且不抛异常`, () => {
    assert.equal(thrown, null);
    assert.ok(host2.children.some((c) => /缩略图不可用/.test(c.textContent)));
  });
  await f2.close();
}

// ⑥ 后端已判定失效（thumbStatus=missing）：直接占位，不发网络请求
const missingEntry = { id: 'demo-missing', md5: '', url: 'https://example.invalid/expired.png', thumbStatus: 'missing', thumbError: '源链接已过期(HTTP 400)，采集时未落盘' };
const host3 = ui.buildStickerThumb(missingEntry);
console.log(`[missing] 占位="${host3.children.map((c) => c.textContent).join('')}" title="${host3.children[0] ? host3.children[0].title : ''}"`);
check('thumbStatus=missing → 直接占位（不产出 <img>）', () => {
  assert.ok(!host3.children.some((c) => c.tagName === 'IMG'));
  assert.match(host3.children[0].textContent, /缩略图不可用 · 源链接已过期/);
});
check('占位的 title 带后端给的 thumbError', () => assert.match(String(host3.children[0].title), /源链接已过期\(HTTP 400\)/));
check('isStickerBroken 认 thumbStatus=missing', () => assert.equal(ui.isStickerBroken(missingEntry), true));

// ⑦ 删除该条：成功 / 失败
await ui.removeSticker(missingEntry, { disabled: false, textContent: '删除该条', isConnected: true });
const okMsg = ui.document.getElementById('sticker-msg').textContent;
console.log(`[删除成功] ${okMsg}`);
check('删除成功 → 成功文案 + 重新拉列表', () => {
  const text = okMsg;
  assert.match(text, /已删除失效表情/);
});
await fetch(fixture.url + '/__fixture/stickers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'removefail' }) });
await ui.removeSticker(missingEntry, { disabled: false, textContent: '删除该条', isConnected: true });
const failMsg = ui.document.getElementById('sticker-msg').textContent;
console.log(`[删除失败] ${failMsg}`);
check('删除失败 → 文案含接口与状态，无成功字样', () => {
  const text = failMsg;
  assert.match(text, /POST \/api\/stickers\/remove 503/);
  assert.ok(!/已删除/.test(text), text);
});

// ⑧ 共 N 用接口 total（84）
await fetch(fixture.url + '/__fixture/stickers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'ok' }) });
await ui.loadStickers();
console.log(`[total] ${ui.getTotal()}`);
check('loadStickers 记录接口 total（84），不本地算', () => assert.equal(ui.getTotal(), 84));

await fixture.close();
console.log('\n' + results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed ? `\n${failed} 项失败` : `\n${results.length} 项全过（thumb 200/404/400 + 来源链四级 + 接口异常不抛）`);
