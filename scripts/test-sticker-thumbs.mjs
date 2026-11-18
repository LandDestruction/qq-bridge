// 表情缩略图兜底链 + 重新拉取：用 fixture 真跑 ops.html 里的这段代码（假 DOM）。
// 覆盖：三级兜底顺序、占位文案、alt、重新拉取的四种失败形态、空列表。
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { startConsoleFixture } from './console-ui-fixture.mjs';

const html = fs.readFileSync('public/ops.html', 'utf8');
const start = html.indexOf('function stickerDedupeKey');
const end = html.indexOf('function renderStickers() {');
assert.ok(start > 0 && end > start, '无法从 ops.html 抽出缩略图代码块');
const code = html.slice(start, end);

function makeDom() {
  const els = new Map();
  class El {
    constructor(tag = 'div') {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this._text = '';
      this.className = '';
      this.style = { cssText: '' };
      this.dataset = {};
      this.attrs = {};
      this.title = '';
      this.alt = '';
      this.hidden = false;
      this.disabled = false;
      this._src = '';
      this.onerror = null;
      this.onclick = null;
      this.isConnected = true;
      this._html = '';
    }
    set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set src(v) { this._src = String(v); if (this.__autoFail !== false && this.onerror) setTimeout(() => this.onerror(), 0); }
    get src() { return this._src; }
    set innerHTML(v) { this._html = v == null ? '' : String(v); this.children = []; }
    get innerHTML() { return this._html; }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    addEventListener() {}
  }
  const document = {
    getElementById(id) { if (!els.has(id)) { const e = new El('div'); e.id = id; els.set(id, e); } return els.get(id); },
    createElement: (tag) => new El(tag),
    querySelectorAll: () => [],
  };
  return { document, els };
}

const msgs = [];
function makeUi(base) {
  const { document, els } = makeDom();
  const sandbox = {
    document,
    token: 'fixture-token',
    location: { search: '' },
    fetch: (url, opts) => fetch(String(url).startsWith('http') ? url : base + url, opts),
    setStickerMsg: (text, color) => { msgs.push({ text, color }); const el = document.getElementById('sticker-msg'); if (el) el.textContent = text; },
    loadStickers: async () => { msgs.push({ text: '(reload)', color: '' }); },
    opsGridError: (gridId, title) => { msgs.push({ text: 'grid:' + gridId + ':' + title, color: '' }); },
    stickerCache: [],
    stickerPage: 0,
    STICKER_PAGE_SIZE: 24,
    renderStickers: () => {},
    Date, Number, Math, JSON, String, Array, Set, Promise, setTimeout, console: { log() {}, warn() {}, error() {} },
  };
  const api = new Function(...Object.keys(sandbox), code + '\nreturn { loadStickers, buildStickerThumb, stickerThumbUrl, stickerAlt, repairStickers, repairAllStickers, STICKER_PLACEHOLDER_TEXT };')(...Object.values(sandbox));
  return { ...api, els, msgs, document };
}

const results = [];
const check = (label, fn) => {
  try { fn(); results.push('OK   ' + label); } catch (e) { results.push('FAIL ' + label + ' — ' + e.message); process.exitCode = 1; }
};
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const fixture = await startConsoleFixture({ port: 0 });
const setStickers = (body) => fetch(fixture.url + '/__fixture/stickers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ui = makeUi(fixture.url);

// ① 第一级：先打桥接的本地缓存路由（不是裸 CDN）
const entry = { id: 'demo-a', md5: 'AAAA1111', url: 'https://example.invalid/a.png', desc: '演示表情 A', localNote: '' };
const host = ui.buildStickerThumb(entry);
const img = host.children[0];
console.log(`[一级] src=${img.src} alt=${img.alt}`);
check('缩略图第一级走本地 md5 路由 /api/stickers/thumb', () => {
  assert.equal(img.src, '/api/stickers/thumb?md5=AAAA1111&token=fixture-token');
});
check('不是直接用 QQ 原始 URL 作为唯一来源', () => {
  assert.notEqual(img.src, entry.url);
});
check('alt 用 desc/localNote（读屏可读）', () => assert.equal(img.alt, '演示表情 A'));

// ② 第二级：md5 路由失败 → 桥接 thumbnail（内部再查缓存/联网）
img.__autoFail = true;
img.onerror();
console.log(`[二级] src=${img.src}`);
check('md5 路由失败后回落到 /api/stickers/thumbnail', () => assert.equal(img.src, '/api/stickers/thumbnail?id=demo-a&token=fixture-token'));
img.onerror();
console.log(`[三级] src=${img.src}`);
check('thumbnail 也失败后才回落 QQ 原始 URL', () => assert.equal(img.src, entry.url));

// ④ 最后一级：原始 URL 也失败 → 占位图 + 明确文案（不允许碎图标）
img.onerror();
console.log(`[三级] 占位="${host.children.map((c) => c.textContent).join('')}"`);
check('两级都失败 → 占位文案「缩略图不可用（可用「重新拉取」）」', () => {
  assert.equal(host.children.length, 1);
  assert.match(host.children[0].textContent, /缩略图不可用（本地缓存缺失\/损坏，可用「重新拉取」）/);
});
check('占位时把 <img> 移除（不会出现浏览器默认碎图标）', () => assert.ok(!host.children.some((c) => c.tagName === 'IMG')));

// ④ 重新拉取：成功 → 显示服务端计数，并刷新列表
msgs.length = 0;
await ui.repairStickers({ disabled: false, textContent: '重新拉取', isConnected: true });
console.log(`[repair成功] ${msgs.map((m) => m.text).filter((t) => !t.startsWith('(')).join(' | ')}`);
check('重新拉取成功 → 显示服务端返回的修复/失效/失败计数', () => {
  const text = msgs.map((m) => m.text).join(' ');
  assert.match(text, /已重新拉取：修复 1 ／ 失效 0 ／ 失败 0/);
});
check('重新拉取成功后重新拉取列表（就地换图）', () => assert.ok(msgs.some((m) => /已重新拉取/.test(m.text))));

// ⑤ 重新拉取失败：接口 503 → 显示服务端原文，绝不假成功
await setStickers({ mode: 'repairfail' });
msgs.length = 0;
await ui.repairStickers({ disabled: false, textContent: '重新拉取', isConnected: true });
console.log(`[repair失败] ${msgs.map((m) => m.text).join(' | ')}`);
check('重新拉取失败 → 文案含接口、状态码和服务端原文', () => {
  const text = msgs.map((m) => m.text).join(' ');
  assert.match(text, /POST \/api\/stickers\/repair 503/);
  assert.match(text, /消息库不可用/);
});
check('重新拉取失败 → 不出现任何成功字样', () => {
  const text = msgs.map((m) => m.text).join(' ');
  assert.ok(!/已重新拉取：修复/.test(text) && !/完成/.test(text), text);
});

// ⑥ 批量：同一接口，带进度与禁用态
await setStickers({ mode: 'ok' });
const batchBtn = { disabled: false, textContent: '批量重新拉取' };
msgs.length = 0;
await ui.repairAllStickers(batchBtn);
console.log(`[批量] ${msgs.map((m) => m.text).join(' | ')} btn=${batchBtn.textContent} disabled=${batchBtn.disabled}`);
check('批量重新拉取有「进行中」进度文案与禁用态', () => {
  assert.ok(msgs.some((m) => /批量重新拉取中/.test(m.text)));
  assert.equal(batchBtn.disabled, false, '结束后应恢复可点');
  assert.equal(batchBtn.textContent, '批量重新拉取');
});

// ⑦ 4 种故障：列表接口 404 / 空列表 / 坏 JSON / 超时 —— 面板不崩、有可读原因
for (const [mode, label] of [['missing', '404'], ['empty', '空列表']]) {
  await setStickers({ mode });
  msgs.length = 0;
  let thrown = null;
  try { await ui.loadStickers(); } catch (e) { thrown = e; }
  const text = msgs.map((m) => m.text).join(' | ');
  console.log(`[故障·${label}] ${text}`);
  check(`列表 ${label} → 不抛异常`, () => assert.equal(thrown, null));
  if (mode === 'missing') check('列表 404 → 文案含接口名与 HTTP 状态', () => assert.match(text, /GET \/api\/stickers\?count=500 404/));
  else check('列表空 → 不报错（不是故障）', () => assert.ok(!/⚠️/.test(text), text));
}
// 坏 JSON / 超时：用独立 fixture 注入（同一个 fixture 里 500 会连带其它请求）
for (const mode of ['badjson', 'timeout']) {
  const f2 = await startConsoleFixture({ port: 0, fail: 'api/stickers:' + mode });
  const ui2 = makeUi(f2.url);
  const localMsgs = [];
  ui2.msgs.length = 0;
  let thrown = null;
  try { await ui2.loadStickers(); } catch (e) { thrown = e; }
  const text = ui2.msgs.map((m) => m.text).join(' | ') + ' ' + localMsgs.join(' ');
  console.log(`[故障·${mode}] ${text}`);
  check(`列表 ${mode} → 不抛异常`, () => assert.equal(thrown, null));
  check(`列表 ${mode} → 文案含接口名与 HTTP 状态`, () => assert.match(text, /GET \/api\/stickers\?count=500 \d{3}/));
  await f2.close();
}
await fixture.close();

console.log('\n' + results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed ? `\n${failed} 项失败` : `\n${results.length} 项全过（兜底链三级 / 占位文案 / alt / 重新拉取成功与失败 / 批量 / 4 种故障不崩）`);
process.exit(failed ? 1 : 0);
