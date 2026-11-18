// P2「资料跟着素材走」的测试：说明文档合并（纯函数）+ 两个写接口（写说明 / 抓封面）。
// 不联网、不碰真库：说明走临时目录，封面用假的 getBoothCover。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  NOTE_MARKER_BEGIN, NOTE_MARKER_END, NOTE_FILE_NAME,
  toCrlf, renderNoteBlock, mergeNoteContent, hasNoteBlock,
} from '../src/library-notes.js';
import { createLibraryView } from '../src/bridge/console/library-view.js';

let failures = 0;
const ok = (name, fn) => {
  try { fn(); console.log('  \u2713 ' + name); } catch (e) { failures++; console.log('  \u2717 ' + name + '\n    ' + (e && e.message)); }
};

const META = {
  boothId: '9013048', title: 'ディスロザ', shop: 'PetiDoll', price: '\u00a5 990~',
  tags: ['\u30a2\u30d0\u30bf\u30fc\u5bfe\u5fdc', '3D\u30e2\u30c7\u30eb'], fetchedAt: 1792941532513,
};

console.log('## 说明文档（纯函数）');
ok('renderNoteBlock 用注释边界包住，且带标题/店铺/价格/商品页', () => {
  const block = renderNoteBlock(META);
  assert.equal(block.startsWith(NOTE_MARKER_BEGIN), true);
  assert.equal(block.trimEnd().endsWith(NOTE_MARKER_END), true);
  assert.match(block, /## BOOTH 资料/);
  assert.match(block, /精肉/ === /精肉/ ? /PetiDoll/ : /PetiDoll/);
  assert.match(block, /990/);
  assert.match(block, /booth\.pm\/.*9013048/);
});
ok('空文件 → 只有我们那段（末尾 CRLF）', () => {
  const out = mergeNoteContent('', renderNoteBlock(META));
  assert.equal(out.indexOf(NOTE_MARKER_BEGIN) >= 0, true);
  assert.equal(out.slice(-2), '\r\n');
});
ok('重跑只替换自己那段，用户写的正文原样保留', () => {
  const mine = '# 我自己的笔记\r\n\r\n这段别动。\r\n';
  const first = mergeNoteContent(mine, renderNoteBlock(META));
  const second = mergeNoteContent(first, renderNoteBlock({ ...META, price: '\u00a5 1,200' }));
  assert.equal(second.includes('这段别动'), true);
  assert.equal(second.includes('\u00a5 1,200'), true);
  assert.equal(second.includes('990'), false);
  assert.equal((second.match(/booth-library:begin/g) || []).length, 1);
});
ok('我们写的那一段全是 CRLF（记事本打开不会挤成一行），已有正文的换行不动', () => {
  const block = renderNoteBlock(META);
  assert.equal(/[^\r]\n/.test(block), false);
  // 老文件里原本是 LF：合并后我们只保证自己那段是 CRLF，人家的正文一个字符都不改
  const out = mergeNoteContent('前情：备注\n', block);
  assert.equal(out.startsWith('前情：备注\n'), true);
  assert.equal(out.endsWith('\r\n'), true);
});
ok('没边界的老文件：追加在末尾，不破坏原文', () => {
  const old = '老说明：这里有作者自己的字\r\n';
  const out = mergeNoteContent(old, renderNoteBlock(META));
  assert.equal(out.startsWith(old), true);
  assert.equal(out.includes(NOTE_MARKER_BEGIN), true);
});
ok('hasNoteBlock 能判断「之前写过」', () => {
  assert.equal(hasNoteBlock(renderNoteBlock(META)), true);
  assert.equal(hasNoteBlock('随便一段说明'), false);
});
ok('资料缺字段时不写空行（只有标题也成立）', () => {
  const block = renderNoteBlock({ boothId: '123', title: '只有标题' });
  assert.equal(block.includes('店铺'), false);
  assert.equal(block.includes('只有标题'), true);
});
ok('toCrlf 不会制造 \r\r\n', () => {
  assert.equal(toCrlf('a\r\nb\rc\nd'), 'a\r\nb\r\nc\r\nd');
});

console.log('\n## 接口：POST /api/library/asset/note 与 /cover');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'libnotes-'));
const cacheDir = path.join(tmp, 'cache');
fs.mkdirSync(cacheDir, { recursive: true });
const boothDir = path.join(tmp, 'inbox', 'group_1', '9013048');
fs.mkdirSync(boothDir, { recursive: true });
fs.writeFileSync(path.join(cacheDir, '9013048.json'), JSON.stringify({ fetchedAt: 1792941532513, meta: { status: 'ok', ...META } }));

const { createConsoleFileLibrary } = await import('../src/bridge/console/file-library.js');

function makeLib(opts = {}) {
  const coverCalls = [];
  const library = createConsoleFileLibrary({
    fs, path, ROOT: 'E:/qq-project',
    fileArchiveRootDir: () => path.join(tmp, 'inbox'),
    boothCacheDir: () => cacheDir,
    safeResolveInside: (root, rel) => {
      const abs = path.resolve(root, String(rel || ''));
      if (abs !== path.resolve(root) && !abs.startsWith(path.resolve(root) + path.sep)) throw new Error('目录越界');
      return abs;
    },
    listArchive: () => [],
    buildLibraryItems: () => ({ items: [] }),
    fileArchiveDb: () => ({ rows: () => [] }),
    fetchBoothMeta: async () => ({ status: 'ok', ...META }),
    getBoothCover: async (boothId) => { coverCalls.push(boothId); return opts.coverFail ? { ok: false, status: 404, coverError: '没有展示图' } : { ok: true, bytes: 70246, cached: false }; },
    libraryNotes: { NOTE_FILE_NAME, renderNoteBlock, mergeNoteContent, hasNoteBlock },
    createLibraryView,
    log: () => {},
    ...(opts.deps || {}),
  });
  return { library, coverCalls };
}

function call(library, method, pathname, body) {
  return new Promise((resolve) => {
    const req = { method, headers: {}, res: {} };
    const res = { _code: 0, setHeader() {}, end(chunk) { resolve({ code: this._code, body: chunk ? JSON.parse(chunk) : null }); } };
    const sendJson = (data, code) => { res._code = code || 200; res.end(JSON.stringify(data)); };
    library.handleConsoleFileLibrary({
      req, res, url: new URL('http://x' + pathname), sendJson,
      readBody: async () => (body === undefined ? {} : body),
    });
  });
}

// 图片路由走 res.writeHead + res.end(buf)，原来那个 call 只看 sendJson，抓不到头。
// 这里单独收一份 headers，用来验「Cache-Control 只有一个且不是 no-store」。
function callBinary(library, method, pathname) {
  return new Promise((resolve) => {
    const req = { method, headers: {} };
    const res = {
      writeHead(status, headers = {}) { this._code = status; this._headers = headers; },
      end(chunk) { resolve({ code: this._code, headers: this._headers || {}, body: chunk }); }
    };
    library.handleConsoleFileLibrary({
      req, res, url: new URL('http://x' + pathname),
      // console-server 真实注入的安全头里带这个；不照抄就验不出「被 no-store 顶掉」。
      SECURITY_HEADERS: { 'x-frame-options': 'DENY', 'Cache-Control': 'no-store' },
      sendJson: (data, code) => resolve({ code: code || 200, headers: {}, body: JSON.stringify(data) }),
      readBody: async () => ({})
    });
  });
}

const { library } = makeLib();
const noteRes = await call(library, 'POST', '/api/library/asset/note', { boothId: '9013048', dir: 'group_1/9013048' });
ok('写说明：落到素材目录的 素材说明.md，回 replaced=false', () => {
  assert.equal(noteRes.code, 200);
  assert.equal(noteRes.body.ok, true);
  assert.equal(noteRes.body.replaced, false);
  assert.equal(noteRes.body.file, 'group_1/9013048/' + NOTE_FILE_NAME);
  const text = fs.readFileSync(path.join(boothDir, NOTE_FILE_NAME), 'utf8');
  assert.equal(text.includes(META.title), true);
  assert.equal(/[^\r]\n/.test(text), false);
});
const again = await call(library, 'POST', '/api/library/asset/note', { boothId: '9013048', dir: 'group_1/9013048' });
ok('写第二次：replaced=true 且只有一段注释块', () => {
  assert.equal(again.body.replaced, true);
  const text = fs.readFileSync(path.join(boothDir, NOTE_FILE_NAME), 'utf8');
  assert.equal((text.match(/booth-library:begin/g) || []).length, 1);
});
const escapeTry = await call(library, 'POST', '/api/library/asset/note', { boothId: '9013048', dir: '../../etc' });
ok('目录越界被拒（400，且不会写出任何文件）', () => {
  assert.equal(escapeTry.code, 400);
  assert.equal(escapeTry.body.ok, false);
  assert.match(String(escapeTry.body.error), /不合法/);
});
const badId = await call(library, 'POST', '/api/library/asset/note', { boothId: 'abc', dir: 'group_1/9013048' });
ok('BOOTH 号非法被拒（400）', () => {
  assert.equal(badId.code, 400);
  assert.equal(badId.body.ok, false);
});
const noMetaLib = makeLib({ deps: { fetchBoothMeta: async () => ({ status: 'bad' }) } });
const noMetaDir = path.join(tmp, 'inbox', 'group_2', '9000000');
fs.mkdirSync(noMetaDir, { recursive: true });
const noMetaRes = await call(noMetaLib.library, 'POST', '/api/library/asset/note', { boothId: '9000000', dir: 'group_2/9000000' });
ok('抓不到 BOOTH 资料时不写文件，并提示先抓封面', () => {
  assert.equal(noMetaRes.body.ok, false);
  assert.match(String(noMetaRes.body.error), /抓封面/);
  assert.equal(fs.existsSync(path.join(noMetaDir, NOTE_FILE_NAME)), false);
});

const coverLib = makeLib();
const coverRes = await call(coverLib.library, 'POST', '/api/library/asset/cover', { boothId: '9038753' });
ok('抓封面：回 /api/files/cover/<id> 与字节数', () => {
  assert.equal(coverRes.code, 200);
  assert.equal(coverRes.body.ok, true);
  assert.equal(coverRes.body.coverUrl, '/api/files/cover/9038753');
  assert.equal(coverRes.body.bytes, 70246);
  assert.deepEqual(coverLib.coverCalls, ['9038753']);
});
const coverFail = makeLib({ coverFail: true });
const coverFailRes = await call(coverFail.library, 'POST', '/api/library/asset/cover', { boothId: '9038753' });
ok('抓不到封面：404 + 明确错误，不假装成功', () => {
  assert.equal(coverFailRes.code, 404);
  assert.equal(coverFailRes.body.ok, false);
  assert.match(String(coverFailRes.body.error), /展示图|没有/);
});
const coverBadId = await call(coverLib.library, 'POST', '/api/library/asset/cover', { boothId: 'x1' });
ok('抓封面：号非法 400', () => { assert.equal(coverBadId.code, 400); });

// 前端部分：贴的是 public/client.js（拼装产物）里的片段，防止改了片段忘了重新拼装
const clientSrc = fs.readFileSync(new URL('../public/client.js', import.meta.url), 'utf8');
ok('素材卡上有「抓封面」按钮，走 POST /api/library/asset/cover，抓完重画文件库', () => {
  assert.match(clientSrc, /data-write="asset-cover"/);
  assert.ok(clientSrc.includes("apiWrite('/api/library/asset/cover'"));
  assert.ok(clientSrc.includes("pageLoad('library', true)"));
});
ok('素材卡上有「写说明」按钮，走 POST /api/library/asset/note，先弹确认', () => {
  assert.match(clientSrc, /data-write="asset-note"/);
  assert.ok(clientSrc.includes("apiWrite('/api/library/asset/note'"));
  assert.ok(clientSrc.includes('只改本工具写的那一段'));
});
ok('卡片封面优先本地预览图，其次才是已抓到的 BOOTH 图', () => {
  assert.ok(clientSrc.includes("var coverSrc = a.thumbUrl || a.coverUrl || '';"));
});
ok('有 BOOTH 资料时卡片显示店铺/价格', () => {
  assert.ok(clientSrc.includes("meta.shop, meta.price"));
});

// ── /api/library/item-thumb：商品封面长缓存（同源 bug：小写 cache-control 被 SECURITY_HEADERS 的 no-store 顶掉）──
const thumbRoot = path.join(tmp, 'thumb-root');
const thumbDir = path.join(thumbRoot, 'state', 'booth-cache', '9013048');
fs.mkdirSync(thumbDir, { recursive: true });
fs.writeFileSync(path.join(thumbDir, 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
const thumbLib = makeLib({ deps: { ROOT: thumbRoot, cfg: {} } });
const thumb = await callBinary(thumbLib.library, 'GET', '/api/library/item-thumb?boothId=9013048');
ok('商品封面缩略图：200 + image/jpeg + 字节一致', () => {
  assert.equal(thumb.code, 200);
  assert.equal(thumb.headers['content-type'], 'image/jpeg');
  assert.deepEqual([...thumb.body], [0xff, 0xd8, 0xff, 0xd9]);
});
ok('商品封面缩略图：Cache-Control 只有一个且是公共长缓存（不被全局 no-store 抹掉）', () => {
  const keys = Object.keys(thumb.headers).filter((k) => k.toLowerCase() === 'cache-control');
  assert.equal(keys.length, 1, JSON.stringify(thumb.headers));
  assert.equal(thumb.headers['Cache-Control'], 'public, max-age=86400');
});
const thumbMiss = await callBinary(thumbLib.library, 'GET', '/api/library/item-thumb?boothId=4040404');
ok('没有本地封面 → 404（不假装成功）', () => {
  assert.equal(thumbMiss.code, 404);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log('');
console.log(failures ? '失败 ' + failures + ' 项' : '全部通过');
process.exitCode = failures ? 1 : 0;
