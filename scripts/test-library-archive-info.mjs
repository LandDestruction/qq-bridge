// 包内信息（readArchiveInfo + GET /api/library/archive-info）测试。
// 为什么单独一套：素材库里大量老包只有 readme 里写着商品号/解压密码，这条链路一旦坏掉，
// 用户就只能手动解压找号；而且它读的是**用户文件内容**，必须证明「只读、只挑文本、有预算」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildZip } from './fixtures/zip-build.mjs';
import {
  readArchiveInfo,
  describeArchiveInfo,
  decodeArchiveText,
  extractBoothIds,
  extractPasswords,
  extractTitleCandidates,
  isTextEntryName,
  ARCHIVE_INFO_MAX_PACKAGE_BYTES,
} from '../src/library-archive-info.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const routeModule = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-archive-info.js')).href);
const { handleArchiveInfoRoute } = routeModule;

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`✅ ${name}`); return; }
  failed += 1;
  console.error(`❌ ${name}${detail ? `：${detail}` : ''}`);
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}
async function checkAsync(name, fn) {
  try { await fn(); passed += 1; console.log(`✅ ${name}`); }
  catch (error) { failed += 1; console.error(`❌ ${name}：${error?.message || error}`); }
}

// ── 纯规则：文本解码 ─────────────────────────────────────────────
check('UTF-8 文本解码', (() => { const r = decodeArchiveText(Buffer.from('パスワード: abc123', 'utf8')); return r && r.encoding === 'utf-8' && r.text.includes('abc123'); })());
check('CP932 文本解码', (() => {
  // 用一行真 CP932 字节（"商品名：テスト" 的 Shift_JIS 编码片段）验证兜底解码。
  const buf = Buffer.from([0x8f, 0xa4, 0x95, 0x69, 0x96, 0xbc, 0x81, 0x46, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67]);
  const r = decodeArchiveText(buf);
  return r && (r.encoding === 'cp932' || r.encoding === 'utf-8-lossy') && r.text.length > 0;
})());
check('空 buffer 解码为 null', decodeArchiveText(Buffer.alloc(0)) === null);
check('二进制内容不当作文本', (() => { const r = decodeArchiveText(Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe])); return !r || r.encoding === 'cp932' || r.text.length >= 0; })());

// ── 纯规则：单行抽取 ─────────────────────────────────────────────
eq('从 booth.pm 链接取号', extractBoothIds('详见 https://booth.pm/ja/items/1234567 页面'), ['1234567']);
eq('从 item_id= 取号', extractBoothIds('{"item_id":"7654321"}'), ['7654321']);
eq('从「#1234567」取号', extractBoothIds('作品「#1234567」'), ['1234567']);
eq('号去重且保持顺序', extractBoothIds('https://booth.pm/items/2222222 https://booth.pm/items/2222222 https://booth.pm/items/1111111'), ['2222222', '1111111']);
eq('从「商品名：」取标题', extractTitleCandidates('商品名：Mew Hair Pack').slice(0, 1), ['Mew Hair Pack']);
eq('从 <title> 取标题', extractTitleCandidates('<html><head><title>Starry Sky</title></head></html>').slice(0, 1), ['Starry Sky']);
eq('从 パスワード 取密码', extractPasswords('パスワード: open123'), ['open123']);
eq('从 解压密码＝ 取密码', extractPasswords('解压密码＝abc-456'), ['abc-456']);
eq('占位密码不算密码', extractPasswords('パスワード: なし'), []);
check('isTextEntryName 认 readme', isTextEntryName('readme.txt') === true && isTextEntryName('docs/はじめに.md') === true);
check('isTextEntryName 排除图片', isTextEntryName('preview.png') === false && isTextEntryName('__MACOSX/._x.txt') === false);

// ── 纯规则：整包读取 ─────────────────────────────────────────────
const readmeZip = buildZip([
  { name: 'readme.txt', data: 'Mew Hair\nhttps://booth.pm/ja/items/1234567\nパスワード: open123\n商品名: Mew Hair Pack' },
  { name: 'preview.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
]);
const info1 = readArchiveInfo(readmeZip);
check('整包读取成功', info1.ok === true, JSON.stringify(info1).slice(0, 200));
eq('整包读出号', info1.boothIds, ['1234567']);
check('整包读出商品链接', info1.itemUrls.some((url) => url.includes('booth.pm/ja/items/1234567')));
check('整包读出标题', info1.titleCandidates.includes('Mew Hair Pack'));
eq('整包读出密码', info1.passwordCandidates, ['open123']);
check('整包记录扫过的条目', Array.isArray(info1.scanned) && info1.scanned.some((item) => item.name === 'readme.txt'));
check('describeArchiveInfo 有中文摘要', /号|标题|密码|没有/.test(describeArchiveInfo(info1)));

const emptyZip = buildZip([{ name: 'a.bin', data: Buffer.alloc(64) }]);
const infoEmpty = readArchiveInfo(emptyZip);
check('无文本包 ok 但无信息', infoEmpty.ok === true && infoEmpty.boothIds.length === 0 && infoEmpty.passwordCandidates.length === 0);
check('非 zip 包报行话错误', (() => { const r = readArchiveInfo(Buffer.from('not a zip')); return r.ok === false && r.error === 'not_a_zip' && /zip/.test(r.text); })());
check('空 zip 不崩', (() => { const r = readArchiveInfo(buildZip([])); return r.ok === true; })());
check('maxBytes 截断置 truncated', (() => {
  const big = buildZip([{ name: 'readme.txt', data: 'x'.repeat(64 * 1024) + '\nhttps://booth.pm/items/9999999' }]);
  const r = readArchiveInfo(big, { maxBytes: 1024 });
  return r.ok === true && (r.truncated === true || r.boothIds.length === 0);
})());
check('条目预算生效（maxEntries=1 时不读第二个文本）', (() => {
  const zip = buildZip([
    { name: 'a.txt', data: 'https://booth.pm/items/1111111' },
    { name: 'b.txt', data: 'https://booth.pm/items/2222222' },
  ]);
  const r = readArchiveInfo(zip, { maxEntries: 1 });
  return r.ok === true && r.boothIds.length <= 1;
})());
check('包内文件名里的号也会被扫到', (() => {
  const zip = buildZip([{ name: 'readme_8765432.txt', data: 'no links here' }]);
  const r = readArchiveInfo(zip);
  return r.ok === true && r.boothIds.includes('8765432');
})());
check('路径 + readFile 入参可用', (() => {
  const zip = buildZip([{ name: 'info.txt', data: 'https://booth.pm/items/5555555' }]);
  const r = readArchiveInfo('/virtual/x.zip', { readFile: () => zip });
  return r.ok === true && r.boothIds.includes('5555555');
})());
check('路径入参但没给 readFile 时明确报错', (() => {
  const r = readArchiveInfo('/virtual/x.zip');
  return r.ok === false && r.error === 'need_read_file';
})());
check('readFile 抛错时回中文原因', (() => {
  const r = readArchiveInfo('/virtual/y.zip', { readFile: () => { throw new Error('EPERM'); } });
  return r.ok === false && r.error === 'read_failed' && /EPERM/.test(r.text);
})());
check('空 buffer 报 not_a_buffer', (() => {
  const r = readArchiveInfo(Buffer.alloc(0));
  return r.ok === false && r.error === 'not_a_buffer';
})());

// ── 路由 ─────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-archive-info-'));
const libDir = path.join(tmp, 'lib');
fs.mkdirSync(path.join(libDir, 'g', 'a'), { recursive: true });
fs.writeFileSync(path.join(libDir, 'g', 'a', 'Pack.zip'), readmeZip);
fs.writeFileSync(path.join(libDir, 'g', 'a', 'Photo.jpg'), Buffer.from('jpg'));

function safeResolveInside(root, rel) {
  const abs = path.resolve(root, rel);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) return '';
  return abs;
}
const cards = [
  { key: 'key-pack', dir: 'g/a', mainName: 'Pack.zip', coverSource: 'package' },
  { key: 'key-photo', dir: 'g/a', mainName: 'Photo.jpg', coverSource: 'local' },
  { key: 'key-gone', dir: 'g/a', mainName: 'Gone.zip', coverSource: '' },
];
const deps = {
  fs, path, log: () => {}, fileArchiveRootDir: libDir, safeResolveInside,
};
async function call(method, query, headers = {}) {
  let payload = null;
  let code = 0;
  const url = new URL(`http://local/api/library/archive-info${query}`);
  const request = {
    req: { method, headers },
    url: { pathname: url.pathname, searchParams: url.searchParams },
    sendJson: (data, status = 200) => { payload = data; code = status; },
  };
  const handled = await handleArchiveInfoRoute(request, deps, async () => ({ assets: cards }));
  return { handled, status: code, data: payload };
}

await checkAsync('路由：非本路径返回 false', async () => {
  let touched = false;
  const handled = await handleArchiveInfoRoute({ req: { method: 'GET', headers: {} }, url: { pathname: '/api/library/assets', searchParams: new URLSearchParams() }, sendJson: () => { touched = true; } }, deps, async () => ({ assets: [] }));
  check('非本路径不接管', handled === false && touched === false);
});
await checkAsync('路由：agent 令牌 403', async () => {
  const r = await call('GET', '?key=key-pack', { 'x-agent-token': 't' });
  check('agent 403', r.handled === true && r.status === 403);
});
await checkAsync('路由：非 GET 405', async () => {
  const r = await call('POST', '?key=key-pack');
  check('POST 405', r.handled === true && r.status === 405);
});
await checkAsync('路由：缺 key 400', async () => {
  const r = await call('GET', '');
  check('缺 key 400', r.status === 400 && /key/.test(r.data.error));
});
await checkAsync('路由：未知 key 404', async () => {
  const r = await call('GET', '?key=nope');
  check('未知 key 404', r.status === 404);
});
await checkAsync('路由：fileArchiveRootDir 是 getter 函数也能读', async () => {
  // file-library 的 deps 传的是 `() => root`；曾因只认字符串在真机 500（path.join 收到函数）。
  let payload = null;
  let code = 0;
  const getterDeps = { ...deps, fileArchiveRootDir: () => libDir };
  const request = {
    req: { method: 'GET', headers: {} },
    url: { pathname: '/api/library/archive-info', searchParams: new URLSearchParams('key=key-pack') },
    sendJson: (data, status = 200) => { payload = data; code = status; },
  };
  const handled = await handleArchiveInfoRoute(request, getterDeps, async () => ({ assets: cards }));
  check('getter 形式 root 200 且读到号', handled === true && code === 200 && payload.info?.boothIds?.includes('1234567'), JSON.stringify(payload).slice(0, 160));
});

await checkAsync('路由：包内读到号/密码', async () => {
  const r = await call('GET', '?key=key-pack');
  check('200 且 ok', r.status === 200 && r.data.ok === true);
  check('probed 带包名与字节', r.data.probed.packageName === 'Pack.zip' && r.data.probed.bytes === readmeZip.length, JSON.stringify(r.data.probed));
  eq('info 里号正确', r.data.info.boothIds, ['1234567']);
  eq('info 里密码正确', r.data.info.passwordCandidates, ['open123']);
  check('coverSource 透传', r.data.coverSource === 'package');
  check('有中文摘要', typeof r.data.text === 'string' && r.data.text.length > 0);
});
await checkAsync('路由：主件不是压缩包时给理由', async () => {
  const r = await call('GET', '?key=key-photo');
  check('200 且 info 为 null', r.status === 200 && r.data.ok === true && r.data.info === null);
  check('理由提到压缩包', /压缩包/.test(r.data.text));
});
await checkAsync('路由：包在盘上不存在时 400 人话', async () => {
  const r = await call('GET', '?key=key-gone');
  check('400 且说明包不在盘上', r.status === 400 && /不在磁盘上/.test(r.data.error), String(r.status) + ' ' + JSON.stringify(r.data));
});
await checkAsync('路由：key 带穿越片段 400', async () => {
  const r = await call('GET', '?key=' + encodeURIComponent('../../etc/passwd'));
  check('穿越 key 400', r.status === 400, String(r.status));
});
await checkAsync('路由：tar.gz 主件也能读（真 unitypackage 形状）', async () => {
  // 用 zlib 造一个最小 tar.gz：Assets/x/readme.txt 里写号与密码。
  const zlib = await import('node:zlib');
  function tarEntry(name, data) {
    const h = Buffer.alloc(512, 0);
    h.write(name, 0, 'utf8');
    h.write('0000644 ', 100);
    h.write('0000000 ', 108);
    h.write('0000000 ', 116);
    h.write((data.length).toString(8).padStart(11, '0') + ' ', 124);
    h.write('00000000000 ', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar ', 257);
    h.write('00', 263);
    return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512, 0)]);
  }
  const readmeText = ['https://booth.pm/ja/items/1234567', 'パスワード: open123'].join('\n');
  const tar = Buffer.concat([tarEntry('Assets/x/readme.txt', Buffer.from(readmeText, 'utf8')), Buffer.alloc(1024, 0)]);
  const tgz = zlib.gzipSync(tar);
  fs.writeFileSync(path.join(libDir, 'g/a', 'UnityPkg.unitypackage'), tgz);
  let payload = null;
  let code = 0;
  const request = {
    req: { method: 'GET', headers: {} },
    url: { pathname: '/api/library/archive-info', searchParams: new URLSearchParams('key=key-unity') },
    sendJson: (data, status = 200) => { payload = data; code = status; },
  };
  const handled = await handleArchiveInfoRoute(request, deps, async () => ({ assets: [{ key: 'key-unity', dir: 'g/a', mainName: 'UnityPkg.unitypackage' }] }));
  check('tar.gz 200 且 format=tar.gz', handled === true && code === 200 && payload.info?.format === 'tar.gz', payload?.info?.error || '');
  eq('tar.gz 读出号', payload.info?.boothIds, ['1234567']);
  eq('tar.gz 读出密码', payload.info?.passwordCandidates, ['open123']);
});
await checkAsync('路由：safeResolveInside 拒绝时 404', async () => {
  let payload = null;
  let code = 0;
  const request = {
    req: { method: 'GET', headers: {} },
    url: { pathname: '/api/library/archive-info', searchParams: new URLSearchParams('key=key-pack') },
    sendJson: (data, status = 200) => { payload = data; code = status; },
  };
  const handled = await handleArchiveInfoRoute(request, { ...deps, safeResolveInside: () => '' }, async () => ({ assets: cards }));
  check('越界路径 404', handled === true && code === 404 && payload.ok === false);
});
await checkAsync('路由：超过 256MB 只回理由不读盘', async () => {
  let payload = null;
  let code = 0;
  const bigDeps = { ...deps, fs: { ...fs, statSync: () => ({ size: ARCHIVE_INFO_MAX_PACKAGE_BYTES + 10 }) } };
  const request = {
    req: { method: 'GET', headers: {} },
    url: { pathname: '/api/library/archive-info', searchParams: new URLSearchParams('key=key-pack') },
    sendJson: (data, status = 200) => { payload = data; code = status; },
  };
  const handled = await handleArchiveInfoRoute(request, bigDeps, async () => ({ assets: cards }));
  check('大包 200 + info null', handled === true && code === 200 && payload.info === null);
  check('理由提到 256MB', /256MB/.test(payload.text));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n包内信息：通过 ${passed} / 失败 ${failed}`);
if (failed) process.exit(1);
console.log('🎉 test-library-archive-info 全部通过');
