// P4 纯规则层单测：Cookie 存法、登录失效判定、翻页防死循环、断点续传计划、文件名清洗、清单页解析。
// 这些规则一旦错，轻则下载到一半重来，重则把 Cookie 写进文件名/日志 —— 所以先钉死。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'booth-download.js')).href);

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fails.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── Cookie ────────────────────────────────────────────────────────────
console.log('## Cookie 规整');
{
  const r = mod.normalizeCookie('  Cookie: a=1; b=2 ;  a=9  ');
  ok(r.ok && r.cookie === 'a=9; b=2', '去掉 Cookie: 前缀、同名后者覆盖', JSON.stringify(r));
  ok(mod.normalizeCookie('').ok === false, '空 Cookie 判坏');
  ok(mod.normalizeCookie('x'.repeat(9000)).ok === false, '超过 8KB 判坏');
  ok(mod.normalizeCookie('badpart').ok === false, '没有 = 的片段判坏');
  ok(mod.normalizeCookie('a=1; =2').ok === false, '名字为空判坏');
  ok(mod.normalizeCookie('a=1\nb=2').ok === true, '换行被折成空格后仍可用');
}

console.log('## 账号槽位');
{
  const a = mod.accountKeyOf('_plaza_session_id=ABCDEF123456; other=1');
  const b = mod.accountKeyOf('_plaza_session_id=ABCDEF123456; other=2');
  const c = mod.accountKeyOf('_plaza_session_id=ZZZZZZ999999; other=1');
  ok(/^sid-[0-9a-f]{8}$/.test(a), '有会话字段时用 sid- 前缀', a);
  ok(a === b, '同一会话字段 → 同一槽位（不受其它 cookie 影响）');
  ok(a !== c, '不同会话 → 不同槽位');
  ok(/^sha-[0-9a-f]{8}$/.test(mod.accountKeyOf('foo=bar')), '没有会话字段时退回 sha- 前缀');
}

console.log('## Cookie 存取摘要不回传原文');
{
  let store = mod.emptyCookieStore();
  const set = mod.setCookieAccount(store, '_plaza_session_id=AAA111; keep=1', { note: '主号', now: 1000 });
  ok(set.ok && /^sid-/.test(set.key), '写入成功并给出槽位');
  store = set.store;
  ok(mod.currentCookie(store).includes('_plaza_session_id=AAA111'), 'currentCookie 取得到');
  const summary = mod.cookieStoreSummary(store);
  ok(summary.count === 1 && summary.accounts[0].note === '主号', '摘要带备注');
  ok(JSON.stringify(summary).indexOf('AAA111') < 0, '摘要里没有 Cookie 原文（只有尾号提示）');
  ok(/…/.test(summary.accounts[0].tail), '摘要给尾号提示');
  const bad = mod.setCookieAccount(store, 'garbage');
  ok(bad.ok === false && bad.store.accounts[summary.current], '写坏 Cookie 不破坏已有槽位');
  const removed = mod.removeCookieAccount(store, summary.current);
  ok(!removed.accounts[summary.current] && removed.current === '', '删除后 current 清空');
  const norm = mod.normalizeCookieStore({ version: 1, current: 'nope', accounts: { 'sid-deadbeef': { cookie: 'a=1', savedAt: 5 }, bad: { cookie: 'a=1' } } });
  ok(Object.keys(norm.accounts).length === 1, '坏槽位名被丢掉');
  ok(norm.current === 'sid-deadbeef', 'current 指向不存在的槽位时自动落到第一个');
}

// ── 登录失效 ──────────────────────────────────────────────────────────
console.log('## 登录失效判定');
{
  ok(mod.isSignedOut({ finalUrl: 'https://booth.pm/sign_in?redirect=1' }).out, 'sign_in 跳转判失效');
  ok(mod.isSignedOut({ status: 401 }).out, '401 判失效');
  ok(mod.isSignedOut({ status: 403 }).out, '403 判失效');
  ok(mod.isSignedOut({ body: '<form><input name="password"></form>' }).out, '登录表单判失效');
  ok(!mod.isSignedOut({ status: 200, finalUrl: 'https://booth.pm/ja/library', body: '<div>已购</div>' }).out, '正常页面不误判');
  // 已购清单搬到账号站之后，accounts.booth.pm/library 是正常页面，不能因为域名就判失效。
  ok(!mod.isSignedOut({ status: 200, finalUrl: 'https://accounts.booth.pm/library?page=1', body: '<div data-signed-in="true">已购</div>' }).out, '账号站清单页不误判失效');
  ok(mod.isSignedOut({ status: 200, finalUrl: 'https://accounts.booth.pm/users/sign_in' }).out, '账号站登录页仍判失效');
}

// ── 翻页 ──────────────────────────────────────────────────────────────
console.log('## 清单翻页防死循环');
{
  ok(mod.nextPageDecision({ page: 1, pageIds: ['1', '2'], seenIds: [], hasNext: true }).stop === false, '有新商品且还有下一页 → 继续');
  ok(mod.nextPageDecision({ page: 2, pageIds: ['1', '2'], seenIds: ['1', '2'], hasNext: true }).stop === true, '全是见过的 → 停');
  ok(mod.nextPageDecision({ page: 1, pageIds: [], hasNext: true }).stop === true, '空页 → 停');
  ok(mod.nextPageDecision({ page: 20, pageIds: ['9'], seenIds: [], hasNext: true }).stop === true, '到页数上限 → 停');
  ok(mod.nextPageDecision({ page: 1, pageIds: ['9'], seenIds: [], hasNext: false }).stop === true, '没有下一页 → 停');
}

// ── 断点续传 ──────────────────────────────────────────────────────────
console.log('## 断点续传计划');
{
  ok(mod.planDownload({ expectedBytes: 100, existingBytes: 0 }).action === 'fresh', '没有临时文件 → fresh');
  ok(mod.planDownload({ expectedBytes: 100, existingBytes: 40, etag: 'e1', validators: { etag: 'e1' } }).action === 'resume', 'ETag 一致 → resume');
  ok(mod.planDownload({ expectedBytes: 100, existingBytes: 40, etag: 'e2', validators: { etag: 'e1' } }).action === 'restart', 'ETag 变了 → 从头');
  ok(mod.planDownload({ expectedBytes: 100, existingBytes: 120 }).action === 'restart', '临时文件比目标大 → 从头');
  ok(mod.planDownload({ expectedBytes: 100, existingBytes: 100 }).action === 'reuse', '已完整 → 复用');
  ok(mod.planDownload({ expectedBytes: 0, existingBytes: 30 }).action === 'resume', '不知道总长但有临时文件 → 续传');
  const r206 = mod.interpretRangeResponse({ status: 206, contentRange: 'bytes 40-99/100' });
  ok(r206.ok && r206.mode === 'resume' && r206.from === 40 && r206.total === 100, '206 解析出续传起点与总长');
  ok(mod.interpretRangeResponse({ status: 200, bytes: 100 }).mode === 'full', '200 视为整包');
  ok(mod.interpretRangeResponse({ status: 416 }).mode === 'restart', '416 从头');
  ok(mod.interpretRangeResponse({ status: 500 }).ok === false, '500 判失败');
  ok(mod.shouldRetryDownload({ attempt: 1 }).retry === true, '第一次失败 → 重试');
  ok(mod.shouldRetryDownload({ attempt: 3 }).retry === false, '用完次数 → 不重试');
  ok(mod.shouldRetryDownload({ attempt: 1, error: 'HTTP 404' }).retry === false, '404 不重试');
  ok(mod.shouldRetryDownload({ attempt: 1, error: 'sign_in' }).retry === false, '登录失效不重试');
}

// ── 文件名 ────────────────────────────────────────────────────────────
console.log('## 文件名清洗');
{
  ok(mod.safeFileName({ disposition: 'attachment; filename="mew.zip"' }) === 'mew.zip', '用 Content-Disposition 的名字');
  ok(mod.safeFileName({ disposition: `attachment; filename*=UTF-8''${encodeURIComponent('ねこ 素材.zip')}` }) === 'ねこ 素材.zip', '支持 filename*=UTF-8');
  ok(mod.safeFileName({ url: 'https://booth.pximg.net/a/b/c/file%20x.zip?sig=1' }) === 'file%20x.zip', 'URL 末段兜底');
  ok(mod.safeFileName({ disposition: 'attachment; filename="../../etc/passwd"' }) === 'etc_passwd.zip', '削掉路径穿越并补扩展名');
  ok(mod.safeFileName({ boothId: '9038753' }) === '9038753.zip', '什么都没有时用商品号');
  ok(mod.safeFileName({ disposition: 'attachment; filename="' + 'x'.repeat(300) + '.zip"' }).length <= 120, '超长名字截断');
}

// ── 清单页解析 ────────────────────────────────────────────────────────
console.log('## 清单页解析');
{
  const fixture = path.join(ROOT, 'scripts', 'fixtures', 'booth-owned-list.html');
  if (fs.existsSync(fixture)) {
    const parsed = mod.parseOwnedListHtml(fs.readFileSync(fixture, 'utf8'));
    ok(parsed.ids.length >= 2, 'fixture 里至少解析出 2 个商品', JSON.stringify(parsed.ids));
    ok(parsed.ids.includes('9038753'), '解析出 9038753');
    ok(parsed.items.some((it) => it.title && it.title.length > 1), '解析出标题');
    ok(parsed.downloads.length >= 1, '抓到下载链接');
    ok(parsed.items.every((it) => !it.downloadUrl || /^https:\/\//.test(it.downloadUrl)), '条目上的下载链接是绝对 https 地址');
    ok(parsed.items.some((it) => String(it.downloadUrl || '').includes(it.boothId)), '下载链接按商品号配到了对应条目');
    ok(parsed.hasNext === true, '识别出「有下一页」');
  } else {
    ok(false, '缺 fixture scripts/fixtures/booth-owned-list.html');
  }
  const inline = mod.parseOwnedListHtml('<a href="/ja/items/1234567">小物</a><a href="https://booth.pm/dl/abc">DL</a>');
  ok(inline.ids.includes('1234567') && inline.downloads[0] === 'https://booth.pm/dl/abc', '内联 HTML 也能解析（相对链接补全）');
  // 账号站的下载按钮：data-href 指向 /downloadables/<另一套 id>，不带商品号，只能按出现顺序归属。
  const account = mod.parseOwnedListHtml('<a href="https://booth.pm/zh-cn/items/9053400">甲</a><div class="js-download-button" data-href="https://booth.pm/downloadables/10024049"></div><a href="https://booth.pm/zh-cn/items/9000436">乙</a><div class="js-download-button" data-href="https://booth.pm/downloadables/9959783"></div>');
  ok(account.items.find((it) => it.boothId === '9053400')?.downloadUrl === 'https://booth.pm/downloadables/10024049', 'data-href 下载按钮按顺序归给前一个号');
  ok(account.items.find((it) => it.boothId === '9000436')?.downloadUrl === 'https://booth.pm/downloadables/9959783', '第二个号也各自归到自己的下载链接');
  ok(mod.parseOwnedListHtml('').ids.length === 0, '空 HTML 不炸');
}

// ── 请求构造 / 文案 ───────────────────────────────────────────────────
console.log('## 请求与文案');
{
  const req = mod.buildDownloadRequest({ url: 'https://booth.pm/dl/x', cookie: 'a=1', plan: { from: 40 } });
  ok(req.headers.range === 'bytes=40-' && req.headers.cookie === 'a=1', '续传带 Range 与 Cookie');
  const fresh = mod.buildDownloadRequest({ url: 'https://booth.pm/dl/x' });
  ok(!fresh.headers.range && !fresh.headers.cookie, '新下载不带 Range/Cookie 空值');
  ok(mod.describeDownloadState({ boothId: '1', saved: true, bytes: 2048 }).includes('已下载'), '已下载文案');
  ok(mod.describeDownloadState({ boothId: '1', bytes: 2048, total: 4096 }).includes('/'), '下载中文案带进度');
  ok(mod.formatBytes(1024 * 1024 * 3).startsWith('3.0 MB'), 'formatBytes 换算');
}

console.log('');
console.log(`P4 下载规则：通过 ${pass} / 失败 ${fails.length}`);
if (fails.length) process.exitCode = 1;
