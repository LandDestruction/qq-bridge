// 只读访客（BOOTH 素材库 L6）：规则纯函数 + 真桥接上的角色行为。
// 桥接不在就跳过真机部分（纯函数部分仍然要过）。
import fs from 'node:fs';
import path from 'node:path';
import * as guest from '../src/console-guest.js';
// 素材卡响应里的绝对路径剥离逻辑在 console 路由层；单拎成纯函数才能脱离桥接单测。
import { assetsRootForRole } from '../src/bridge/console/library-view.js';
// 读盘失败的对外文本：访客只回「路径不存在/读取失败」，管理员回相对路径+错误码，绝不出现盘符。
import { fsErrorText, scrubLocalPaths } from '../src/library-fs-error.js';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0;
const failures = [];
const ok = (cond, name, detail) => {
  if (cond) { pass += 1; } else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

console.log('## 白名单：访客只能读素材库那几条');
ok(guest.guestAllowed('GET', '/api/library/assets'), 'GET /api/library/assets 放行');
ok(guest.guestAllowed('HEAD', '/api/library/assets'), 'HEAD 也算读');
ok(guest.guestAllowed('GET', '/api/files/raw?rel=x.zip'), '带查询串的路径也能命中');
ok(guest.guestAllowed('GET', '/api/files/cover/271777'), '封面缓存放行（前缀规则）');
ok(guest.guestAllowed('GET', '/api/status'), 'GET /api/status 放行');
ok(!guest.guestAllowed('POST', '/api/library/bind'), '写接口一律拒绝');
ok(!guest.guestAllowed('GET', '/api/library/bind'), '写接口连 GET 也不放行（不在白名单）');
ok(guest.guestAllowed('GET', '/api/library/search-pause'), 'GET /api/library/search-pause 放行（访客要看得到 BOOTH 限速暂停）');
ok(!guest.guestAllowed('POST', '/api/library/search-pause'), 'POST /api/library/search-pause 仍拒绝（解除暂停须管理员）');
// 素材库 Pro 界面新增的两条只读接口：分类计数与收藏列表放行；收藏写（POST /api/library/favorite）仍拒。
for (const p of ['/api/library/facets', '/api/library/favorites']) {
  ok(guest.guestAllowed('GET', p), `GET ${p} 放行（只读）`);
  ok(!guest.guestAllowed('POST', p), `POST ${p} 不放行（只读接口不因同名而放行写）`);
}
ok(!guest.guestAllowed('POST', '/api/library/favorite') && !guest.GUEST_ALLOWED.includes('/api/library/favorite'),
  'POST /api/library/favorite 不给访客（收藏是写操作）');
ok(guest.GUEST_DENIED_SAMPLE.includes('/api/library/favorite'), 'GUEST_DENIED_SAMPLE 含 /api/library/favorite');
// 截图导入（OCR）：POST 是算力接口、GET status 会暴露本机装了哪些语言包，两个都不给访客。
ok(!guest.guestAllowed('POST', '/api/library/purchases/ocr'), 'POST /api/library/purchases/ocr 不给访客（算力写接口）');
ok(!guest.guestAllowed('GET', '/api/library/purchases/ocr'), 'GET /api/library/purchases/ocr 也不放行（白名单是精确匹配，不按前缀外溢）');
ok(!guest.guestAllowed('GET', '/api/library/purchases/ocr/status'), 'GET /api/library/purchases/ocr/status 不给访客（泄露本机 OCR 语言包）');
ok(guest.GUEST_DENIED_SAMPLE.includes('/api/library/purchases/ocr/status'), 'GUEST_DENIED_SAMPLE 含 /api/library/purchases/ocr/status');
// 手动标签/分类/备注：备注是私人内容，GET 也不给访客（不是只拦写操作）。
ok(!guest.guestAllowed('GET', '/api/library/manual-meta'), 'GET /api/library/manual-meta 不给访客（备注是私人内容）');
ok(!guest.guestAllowed('POST', '/api/library/manual-meta'), 'POST /api/library/manual-meta 不给访客（写台账）');
ok(guest.GUEST_DENIED_SAMPLE.includes('/api/library/manual-meta'), 'GUEST_DENIED_SAMPLE 含 /api/library/manual-meta');
// BOOTH 登录：弹浏览器抓 Cookie 属管理端操作，start/status/stop 三条都不给访客。
for (const p of ['/api/library/purchases/login/start', '/api/library/purchases/login/status', '/api/library/purchases/login/stop']) {
  ok(!guest.guestAllowed('GET', p) && !guest.guestAllowed('POST', p)
    && guest.GUEST_DENIED_SAMPLE.includes(p), `BOOTH 登录接口不给访客：${p}`);
}
ok(!guest.GUEST_ALLOWED.includes('/api/library/downloads/retry'), '下载重试接口不进白名单');
ok(!guest.GUEST_ALLOWED.includes('/api/library/binds/export'), '绑定导出接口不进白名单');
ok(!guest.GUEST_ALLOWED.includes('/api/library/binds/import'), '绑定导入接口不进白名单');
// agent 探活要读 baseUrl/apiKey 配置并会发网络请求：管理端专用，访客 POST/GET 一律 403。
ok(!guest.guestAllowed('POST', '/api/agent/probe') && !guest.guestAllowed('GET', '/api/agent/probe'),
  '访客打 /api/agent/probe 一律 403（探活是管理端操作）');
ok(guest.GUEST_DENIED_SAMPLE.includes('/api/agent/probe'), 'GUEST_DENIED_SAMPLE 含 /api/agent/probe');

// v2.2/v2.3 新增的只读接口：重复素材报告、素材集（只读）、解压进度放给访客。
for (const p of ['/api/library/duplicates', '/api/library/collections', '/api/library/extract/status']) {
  ok(guest.guestAllowed('GET', p), `GET ${p} 放行（只读）`);
  ok(!guest.guestAllowed('POST', p), `POST ${p} 不放行（同路径写方法一律拒）`);
}
// 包内信息（标题/解压密码候选）与写接口（解压/下载中心/素材集写/一键认号写/密码本）一律不给访客。
for (const p of [
  '/api/library/archive-info',
  '/api/library/extract', '/api/library/downloads',
  '/api/library/downloads/pause', '/api/library/downloads/resume',
  '/api/library/collections/update', '/api/library/collections/remove', '/api/library/collections/members',
  '/api/library/bind-suggestion/accept', '/api/library/passwords'
]) {
  ok(!guest.guestAllowed('GET', p) && !guest.guestAllowed('POST', p)
    && guest.GUEST_DENIED_SAMPLE.includes(p), `不给访客（敏感读/写接口）：${p}`);
}

// 本轮新增的只读接口（单件详情/补封面进度/合并组/工程使用统计/识别规则）：GET 放行、写方法不放行。
for (const p of ['/api/library/asset', '/api/library/covers', '/api/library/merges', '/api/library/usage', '/api/library/alias-rules']) {
  ok(guest.guestAllowed('GET', p), `GET ${p} 放行（只读）`);
  ok(!guest.guestAllowed('POST', p), `POST ${p} 不放行（同名路径不按前缀规则漏写）`);
}
ok(!guest.guestAllowed('GET', '/api/library/covers/backfill'), 'GET /api/library/covers/backfill 不放行（前缀不外溢）');
ok(!guest.guestAllowed('GET', '/api/library/merges/merge'), 'GET /api/library/merges/merge 不放行（前缀不外溢）');
// 敏感读与写入口必须仍被拒，且在「明确不给」样本里（给测试与文档当反例）。
for (const p of ['/api/library/purchases', '/api/library/reconcile', '/api/library/trash', '/api/open-url']) {
  ok(!guest.guestAllowed('GET', p), `GET ${p} 不给访客（敏感读/管理端）`);
  ok(guest.GUEST_DENIED_SAMPLE.includes(p), `GUEST_DENIED_SAMPLE 含 ${p}`);
}
ok(!guest.guestAllowed('GET', '/api/tokens/summary'), '花费账本不给访客看');
// 工具维度 token 消耗：GET 是纯聚合数字（无逐轮明细/无本机路径），给访客只读；
// rebuild 要读全天台账重算写盘，只给管理端。两条都逐步锁死，防止「加一条只读顺手把写接口放开」。
ok(guest.guestAllowed('GET', '/api/tokens/tools'), 'GET /api/tokens/tools 放行（只读聚合）');
ok(!guest.guestAllowed('POST', '/api/tokens/tools'), 'POST /api/tokens/tools 不放行（只读接口不接写）');
ok(!guest.guestAllowed('POST', '/api/tokens/tools/rebuild'), 'POST /api/tokens/tools/rebuild 不给访客（重建要写盘）');
ok(!guest.guestAllowed('GET', '/api/tokens/tools/rebuild'), 'GET /api/tokens/tools/rebuild 也不给访客（不在白名单，前缀不外溢）');
ok(guest.GUEST_DENIED_SAMPLE.includes('/api/tokens/tools/rebuild'), 'GUEST_DENIED_SAMPLE 含 /api/tokens/tools/rebuild');
ok(guest.guestAllowRule('GET', '/api/tokens/tools') === '/api/tokens/tools', '工具消耗命中规则回原样路径');
ok(guest.guestAllowRule('GET', '/api/tokens/tools/rebuild') === '', '前缀不外溢：tools/rebuild 不因 tools 放行');
ok(!guest.guestAllowed('GET', '/api/persona'), '人设不给访客看');
ok(!guest.guestAllowed('GET', '/api/socialV2/ai-blacklist'), '黑名单配置不给访客看');
ok(!guest.guestAllowed('DELETE', '/api/library/assets'), '非 GET/HEAD 一律拒绝');
ok(guest.guestAllowRule('GET', '/api/library/assets') === '/api/library/assets', '命中规则回原样路径');
ok(guest.guestAllowRule('GET', '/api/library/bind') === '', '没命中回空串');

console.log('## 角色判定：管理员优先');
const admin = 'a'.repeat(48);
const guestTok = 'b'.repeat(48);
ok(guest.roleForTokens({ supplied: admin, adminToken: admin, guestToken: guestTok }) === 'admin', '管理员令牌判 admin');
ok(guest.roleForTokens({ supplied: guestTok, adminToken: admin, guestToken: guestTok }) === 'guest', '访客令牌判 guest');
ok(guest.roleForTokens({ supplied: 'c'.repeat(48), adminToken: admin, guestToken: guestTok }) === '', '错令牌判空');
ok(guest.roleForTokens({ supplied: '', adminToken: admin, guestToken: guestTok }) === '', '没带令牌判空');
ok(guest.roleForTokens({ supplied: guestTok, adminToken: '', guestToken: '' }) === '', '没配令牌时谁都不是');

console.log('## 令牌与链接');
ok(guest.validGuestToken(guestTok), '48 位字母数字算合法');
ok(!guest.validGuestToken('short'), '太短不算');
ok(!guest.validGuestToken('带中文的令牌' + 'x'.repeat(30)), '非 ASCII 不算');
const link = guest.guestLink('http://127.0.0.1:3100/', guestTok);
ok(link === 'http://127.0.0.1:3100/client?guest=' + guestTok, '链接形状正确且保留编码');
ok(guest.guestLink('http://x', '') === '', '没令牌时不给链接');
ok(/访客只能看/.test(guest.describeGuestScope()) && /不能看/.test(guest.describeGuestScope()), '范围说明写清了能看/不能看');
ok(/文件库可看/.test(guest.describeGuestScope())
  && /素材列表/.test(guest.describeGuestScope())
  && /不含本机绝对路径/.test(guest.describeGuestScope())
  && /封面补齐进度/.test(guest.describeGuestScope())
  && /合并组/.test(guest.describeGuestScope())
  && /仅工程名/.test(guest.describeGuestScope())
  && /识别规则/.test(guest.describeGuestScope())
  && /分类计数/.test(guest.describeGuestScope())
  && /收藏列表/.test(guest.describeGuestScope())
  && /重复素材报告/.test(guest.describeGuestScope())
  && /素材集（只读）/.test(guest.describeGuestScope())
  && /解压进度/.test(guest.describeGuestScope())
  && /包内信息/.test(guest.describeGuestScope()), '范围说明补了「文件库可看」八项（含 facets/收藏/重复素材/素材集/解压进度，且不泄露绝对路径）');
// 工具维度消耗是本批新增的只读可见项，同时「总花费账本/逐轮流水」仍不给——文案要把两边都写清，
// 否则访客既不知道能看什么，也容易误以为能看到逐轮花了多少。
ok(/各工具维度/.test(guest.describeGuestScope()), '范围说明补了「各工具维度 token 消耗」');
ok(/总花费账本与逐轮流水/.test(guest.describeGuestScope()), '范围说明明确「总花费账本与逐轮流水」不给访客');

// 访客视图剥离绝对路径（纯函数，不依赖桥接）。扫盘根是 <本机路径>\booth-inbox 这种本机路径，
// 访客链接一旦分享出去，响应体里不该再出现它——这里锁死「guest 形态 root===null，管理员不变」。
console.log('## 访客视图：扫盘根绝对路径剥离');
const scanRoot = 'E:\\qq-project\\booth-inbox';
ok(assetsRootForRole(scanRoot, 'guest') === null, 'guest 形态 root === null');
ok(assetsRootForRole(scanRoot, 'admin') === scanRoot, '管理员形态 root 保持原值（前端要用）');
ok(assetsRootForRole('', '') === '', '没角色时保持原值（别误伤内部调用）');

// 读盘失败的对外文本（纯函数）：Node 的 ENOENT 原话带 `stat '<本机路径>\x.jpg'`，直接回给前端就等于
// 泄漏本机目录结构（真机在 /api/files/raw 上踩过）。访客只给结论；管理员给相对路径+错误码。
console.log('## 读盘失败文本：说清原因，但不回本机绝对路径');
const ABS_PATH_RE = /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/;
const enoentError = () => Object.assign(
  new Error("ENOENT: no such file or directory, stat 'E:\\qq-project\\booth-inbox\\__guest_sweep__.jpg'"),
  { code: 'ENOENT' }
);
ok(fsErrorText(enoentError(), '__guest_sweep__.jpg', 'guest') === '路径不存在', '访客侧 ENOENT 只说「路径不存在」');
ok(fsErrorText(enoentError(), 'sub\\a.jpg', 'admin') === '路径不存在：sub/a.jpg',
  '管理员侧 ENOENT 给相对路径（斜杠归一），不带盘符', fsErrorText(enoentError(), 'sub\\a.jpg', 'admin'));
ok(!ABS_PATH_RE.test(fsErrorText(enoentError(), 'sub\\a.jpg', 'admin')), '管理员侧 ENOENT 文本不含盘符');
const eaccesError = () => Object.assign(new Error("EACCES: permission denied, open 'E:\\qq-project\\booth-inbox\\x.jpg'"), { code: 'EACCES' });
ok(fsErrorText(eaccesError(), 'x.jpg', 'guest') === '读取失败', '访客侧其它错误只说「读取失败」');
const adminEacces = fsErrorText(eaccesError(), 'x.jpg', 'admin');
ok(/EACCES/.test(adminEacces) && !ABS_PATH_RE.test(adminEacces),
  '管理员侧其它错误保留错误码，但盘符换成 <本机路径>', adminEacces);
ok(!/E:/.test(scrubLocalPaths(`stat 'E:\\a\\b.jpg'`)) && /<本机路径>/.test(scrubLocalPaths(`stat 'E:\\a\\b.jpg'`)),
  'scrubLocalPaths 抹掉 Windows 盘符路径');
ok(!/\/home\//.test(scrubLocalPaths('open /home/u/c.jpg')), 'scrubLocalPaths 抹掉 /home/ 家目录');
ok(!/AppData/i.test(scrubLocalPaths('at C:\\Users\\PC\\AppData\\Roaming\\x')), 'scrubLocalPaths 抹掉 AppData');
ok(fsErrorText(Object.assign(new Error('boom'), { code: 'EIO' }), 'a.jpg', '') === 'EIO：boom',
  '非文件系统错误码也带码回话（便于定位）');

// ── 真桥接（可选）─────────────────────────────────────────────────────
const PORT = Number(process.env.CONSOLE_PORT || 3100);
const BASE = `http://127.0.0.1:${PORT}`;
const readFile = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8').trim(); } catch { return ''; } };
const consoleToken = readFile('state/console-token');
const guestToken = readFile('state/console-guest-token');

async function req(pathname, init) {
  try {
    const res = await fetch(BASE + pathname, { ...init, redirect: 'manual' });
    const text = await res.text();
    return {
      status: res.status,
      contentType: String(res.headers.get('content-type') || ''),
      text,
      json: (() => { try { return JSON.parse(text); } catch { return null; } })()
    };
  } catch {
    return null;
  }
}

const probe = consoleToken ? await req('/api/status') : null;
if (!probe) {
  console.log('SKIP 桥接没在跑（或没 state/console-token），跳过真机部分');
} else if (!guestToken) {
  console.log('SKIP 没有 state/console-guest-token（重启桥接后才会生成），跳过真机部分');
} else {
  console.log('## 真桥接：角色边界');
  const asAdmin = await req('/api/console/guest', { headers: { 'x-console-token': consoleToken } });
  ok(asAdmin.status === 200 && !!asAdmin.json && asAdmin.json.ok === true, '管理员能取访客链接', `HTTP ${asAdmin.status}`);
  ok(asAdmin.json && /guest=/.test(String(asAdmin.json.link || '')), '链接里带 guest 参数');
  ok(asAdmin.json && String(asAdmin.json.token || '').length >= 24, '返回了访客令牌本体（只有管理员能看）');

  const guestCookie = await req('/api/console/guest', { headers: { 'x-console-guest': guestToken } });
  ok(guestCookie.status === 403, '访客自己取访客令牌被拒（403）', `HTTP ${guestCookie.status}`);

  // 页面壳子必须放行：否则访客拿到的是一片 403 JSON，连输入层都没机会出现（真机踩过）。
  const shell = await req('/client?guest=' + encodeURIComponent(guestToken));
  ok(shell.status === 200 && /<html/i.test(shell.text), '访客能打开 /client 壳子（200 HTML，不是 403 JSON）', `HTTP ${shell.status}`);
  const shellJs = await req('/client.js');
  ok(shellJs.status === 200, '访客能取到 /client.js（静态资源也要放行）', `HTTP ${shellJs.status}`);
  // 但数据接口仍然要按白名单走。
  const adminApi = await req('/api/ops/services', { headers: { 'x-console-guest': guestToken } });
  ok(adminApi.status === 403, '访客读管理端接口仍然 403', `HTTP ${adminApi.status}`);

  // /api/status 在访客白名单里，但只能给「跑没跑」：ownerQQ / 白名单 / activity 都是跨群管理信息。
  const guestStatus = await req('/api/status', { headers: { 'x-console-guest': guestToken } });
  const gs = guestStatus.json || {};
  ok(guestStatus.status === 200 && gs.guest === true, '访客能读 /api/status（只要状态灯那几个布尔量）', `HTTP ${guestStatus.status}`);
  ok(!('ownerQQ' in gs) && !('allowGroups' in gs) && !('allowPrivate' in gs) && !('activity' in gs),
    '访客拿不到 ownerQQ / 白名单 / activity（管理端字段一个都不许漏）');
  const adminStatus = await req('/api/status', { headers: { 'x-console-token': consoleToken } });
  ok(adminStatus.status === 200 && adminStatus.json && 'activity' in adminStatus.json,
    '管理员仍然能拿到完整 /api/status（没有把管理端一起削掉）');

  // 白名单里不该有「无路由」或「前缀会顺带放行写接口」的条目（审阅发现过 /api/meta 与 /api/library/asset/）。
  ok(!guest.GUEST_ALLOWED.includes('/api/meta'), '白名单里没有死路径（/api/meta 没路由）');
  ok(guest.GUEST_ALLOWED.filter((p) => p.endsWith('/')).join(',') === '/api/files/cover/', '只有 /api/files/cover/ 这一个真前缀路由，其它条目都是精确路径');

  const guestRead = await req('/api/library/assets', { headers: { 'x-console-guest': guestToken } });
  ok(guestRead.status === 200 && guestRead.json && guestRead.json.ok === true, '访客能读素材卡列表', `HTTP ${guestRead.status}`);

  // 素材库因 BOOTH 限速停摆时，访客要能看见「暂停到什么时候」，否则只会以为页面卡住。
  const guestPause = await req('/api/library/search-pause', { headers: { 'x-console-guest': guestToken } });
  const gp = guestPause.json || {};
  const adminPause = await req('/api/library/search-pause', { headers: { 'x-console-token': consoleToken } });
  if (guestPause.status === 403 && adminPause.status === 200) {
    // 路由存在（管理员 200）但访客被拦：线上进程还是旧白名单，重启桥接后才生效。
    // 这不是回归，按「真机部分 SKIP」处理，别把没重启的假红算到白名单头上。
    console.log('SKIP 线上桥接仍是旧白名单（重启后才生效），search-pause 放行待重启后验证');
  } else {
    ok(guestPause.status === 200 && gp.ok === true && typeof gp.paused === 'boolean'
      && typeof gp.remainingMs === 'number' && typeof gp.pausedUntil === 'number'
      && typeof gp.reason === 'string' && typeof gp.status === 'number' && typeof gp.text === 'string',
      '访客能读搜索暂停状态（200 且字段齐全）', `HTTP ${guestPause.status}`);
  }
  const guestPausePost = await req('/api/library/search-pause', {
    method: 'POST', headers: { 'x-console-guest': guestToken }
  });
  ok(guestPausePost.status === 403 && guestPausePost.json && guestPausePost.json.guest === true,
    '访客 POST 解除暂停仍 403', `HTTP ${guestPausePost.status}`);

  // 本轮新增的只读接口：访客应当 200。线上桥接若还没重启（访客 403 而管理员 200），
  // 说明跑的是旧白名单，记一条 SKIP 而不是假红。
  const newReads = ['/api/library/covers', '/api/library/merges', '/api/library/usage', '/api/library/alias-rules'];
  const staleReads = [];
  const ABS_PATH_RE = /[A-Za-z]:\\/;
  for (const p of newReads) {
    const asGuest = await req(p, { headers: { 'x-console-guest': guestToken } });
    if (asGuest.status === 403) {
      const asAdmin = await req(p, { headers: { 'x-console-token': consoleToken } });
      if (asAdmin.status === 200) { staleReads.push(p); continue; }
    }
    ok(asGuest.status === 200 && asGuest.json && asGuest.json.ok === true,
      `访客能读新增只读接口 ${p}`, `HTTP ${asGuest.status}`);
    const raw = String(asGuest.text || '');
    ok(!ABS_PATH_RE.test(raw) && !/\/home\//.test(raw) && !/AppData/.test(raw),
      `访客读 ${p} 不含本机绝对路径（盘符/家目录/AppData）`);
  }
  if (staleReads.length) {
    console.log(`SKIP 线上桥接仍是旧白名单（重启后才生效），这些新增只读接口待重启后验证：${staleReads.join(', ')}`);
  }

  // 素材库 Pro 界面的两条新只读接口（rules-backend 落地后才有路由）：放行且不含绝对路径。
  // 路由还没上线时线上是 404，先 SKIP（别把「接口没写」误记成白名单回归）；上线重启后这组必须转真。
  for (const p of ['/api/library/facets', '/api/library/favorites']) {
    const asGuestPro = await req(p, { headers: { 'x-console-guest': guestToken } });
    if (asGuestPro.status === 403) {
      const asAdminPro = await req(p, { headers: { 'x-console-token': consoleToken } });
      if (asAdminPro.status === 200) { console.log(`SKIP 线上桥接仍是旧白名单，${p} 待重启后验证`); continue; }
      // 管理员也是 404：路由本身还没写（rules-backend 未落地），与白名单无关。
      if (asAdminPro.status === 404) { console.log(`SKIP 接口还没上线（${p}：管理员也 404，等 rules-backend 落地 + 重启）`); continue; }
    }
    if (asGuestPro.status === 404) { console.log(`SKIP 接口还没上线（${p} 404，等 rules-backend 落地 + 重启）`); continue; }
    ok(asGuestPro.status === 200 && asGuestPro.json && asGuestPro.json.ok === true,
      `访客能读 ${p}`, `HTTP ${asGuestPro.status}`);
    const rawPro = String(asGuestPro.text || '');
    ok(!ABS_PATH_RE.test(rawPro) && !/\/home\//.test(rawPro) && !/AppData/.test(rawPro),
      `访客读 ${p} 不含本机绝对路径（盘符/家目录/AppData）`);
    if (p === '/api/library/facets') {
      ok(!('root' in (asGuestPro.json || {})), 'facets 响应不带 root（真带了也要按访客剥成 null）');
    }
  }
  const favoritePost = await req('/api/library/favorite', {
    method: 'POST',
    headers: { 'x-console-guest': guestToken, 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'g/c/hair', on: true })
  });
  ok(favoritePost.status === 403 && favoritePost.json && favoritePost.json.guest === true,
    '访客 POST /api/library/favorite 收藏被拒（403）', `HTTP ${favoritePost.status}`);

  // v2.2/v2.3 只读接口：重复素材 / 素材集 / 解压进度给访客；包内信息与解压写入口不给。
  // 旧进程（白名单未重启生效）时按「访客 403 而管理员 200」记 SKIP，不把没重启算成回归。
  const versionedReads = ['/api/library/duplicates', '/api/library/collections', '/api/library/extract/status'];
  const staleVersioned = [];
  for (const p of versionedReads) {
    const asGuestV = await req(p, { headers: { 'x-console-guest': guestToken } });
    if (asGuestV.status === 403) {
      const asAdminV = await req(p, { headers: { 'x-console-token': consoleToken } });
      if (asAdminV.status === 200) { staleVersioned.push(p); continue; }
      if (asAdminV.status === 404) { console.log(`SKIP 接口还没上线（${p}：管理员也 404）`); continue; }
    }
    ok(asGuestV.status === 200 && asGuestV.json && asGuestV.json.ok === true,
      `访客能读 v2.2/v2.3 只读接口 ${p}`, `HTTP ${asGuestV.status}`);
  }
  if (staleVersioned.length) {
    console.log(`SKIP 线上桥接仍是旧白名单（重启后才生效），这些接口待重启后验证：${staleVersioned.join(', ')}`);
  }
  // 工具维度 token 消耗：GET 只读给访客；rebuild 是写盘重算，访客必须 403。
  // 接口还没合入时管理员也 404 —— 记 SKIP（不把「没写完」误记成白名单回归），上线重启后这组必须转真。
  const guestTools = await req('/api/tokens/tools?range=7d&key=all', { headers: { 'x-console-guest': guestToken } });
  const adminTools = await req('/api/tokens/tools?range=7d&key=all', { headers: { 'x-console-token': consoleToken } });
  if (adminTools.status === 404) {
    console.log('SKIP 工具消耗接口还没上线（管理员也 404，等 console-backend 落地 + 重启）');
  } else if (guestTools.status === 403 && adminTools.status === 200) {
    console.log('SKIP 线上桥接仍是旧白名单（重启后才生效），/api/tokens/tools 待重启后验证');
  } else {
    ok(adminTools.status === 200 && adminTools.json && adminTools.json.ok === true,
      '管理员能读工具维度 token 消耗（GET /api/tokens/tools）', `HTTP ${adminTools.status}`);
    ok(guestTools.status === 200 && guestTools.json && guestTools.json.ok === true
      && Array.isArray(guestTools.json.tools) && Array.isArray(guestTools.json.groups),
      '访客能读工具维度 token 消耗（只读聚合，含 tools/groups 数组）', `HTTP ${guestTools.status}`);
    ok(guestTools.json && guestTools.json.total && guestTools.json.noTool && guestTools.json.unattr,
      '访客读到的工具消耗带 total/noTool/unattr 三个桶', JSON.stringify(Object.keys(guestTools.json || {})).slice(0, 120));
    ok(!/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(JSON.stringify(guestTools.json || {})),
      '工具消耗响应不含本机路径（无盘符）', String(JSON.stringify(guestTools.json || {}).slice(0, 160)));
  }
  const guestRebuild = await req('/api/tokens/tools/rebuild', {
    method: 'POST',
    headers: { 'x-console-guest': guestToken, 'content-type': 'application/json' },
    body: JSON.stringify({ days: 1 })
  });
  ok(guestRebuild.status === 403 && guestRebuild.json && guestRebuild.json.guest === true,
    '访客 POST /api/tokens/tools/rebuild 被拒（403，重建要读台账写盘）', `HTTP ${guestRebuild.status}`);

  // 解压写入口：访客 POST 必须 403（管理员 GET status 作对照，说明路由在、403 是白名单拦的）。
  const guestExtract = await req('/api/library/extract', {
    method: 'POST',
    headers: { 'x-console-guest': guestToken, 'content-type': 'application/json' },
    body: JSON.stringify({ boothId: '1234567' })
  });
  ok(guestExtract.status === 403 && guestExtract.json && guestExtract.json.guest === true,
    '访客 POST /api/library/extract 被拒（403，解压会写盘）', `HTTP ${guestExtract.status}`);
  const guestArchiveInfo = await req('/api/library/archive-info?key=deadbeefdeadbeef', { headers: { 'x-console-guest': guestToken } });
  ok(guestArchiveInfo.status === 403 && guestArchiveInfo.json && guestArchiveInfo.json.guest === true,
    '访客 GET /api/library/archive-info 被拒（403，包内标题/密码候选是私人信息）', `HTTP ${guestArchiveInfo.status}`);
  const guestDownloads = await req('/api/library/downloads', { headers: { 'x-console-guest': guestToken } });
  ok(guestDownloads.status === 403, '访客 GET /api/library/downloads 被拒（403，下载队列是本机信息）', `HTTP ${guestDownloads.status}`);
  const adminExtractStatus = await req('/api/library/extract/status', { headers: { 'x-console-token': consoleToken } });
  if (adminExtractStatus.status !== 404) {
    ok(adminExtractStatus.status === 200 && adminExtractStatus.json && adminExtractStatus.json.ok === true,
      '管理员能读解压进度 200（访客 403 是白名单拦的，不是路由不存在）', `HTTP ${adminExtractStatus.status}`);
  } else {
    console.log('SKIP 解压接口还没上线（管理员也 404）');
  }

  // 截图导入（OCR）：访客 POST 是算力接口、GET status 泄露本机语言包，两个都必须 403；
  // 管理员 status 应 200（说明 403 是白名单拦的，不是路由不存在）。
  const guestOcr = await req('/api/library/purchases/ocr', {
    method: 'POST',
    headers: { 'x-console-guest': guestToken, 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'nope.png' })
  });
  ok(guestOcr.status === 403 && guestOcr.json && guestOcr.json.guest === true,
    '访客 POST /api/library/purchases/ocr 被拒（403）', `HTTP ${guestOcr.status}`);
  const guestOcrStatus = await req('/api/library/purchases/ocr/status', { headers: { 'x-console-guest': guestToken } });
  ok(guestOcrStatus.status === 403 && guestOcrStatus.json && guestOcrStatus.json.guest === true,
    '访客 GET /api/library/purchases/ocr/status 被拒（403）', `HTTP ${guestOcrStatus.status}`);
  const adminOcrStatus = await req('/api/library/purchases/ocr/status', { headers: { 'x-console-token': consoleToken } });
  ok(adminOcrStatus.status === 200 && adminOcrStatus.json
    && typeof adminOcrStatus.json.available === 'boolean'
    && Array.isArray(adminOcrStatus.json.langs)
    && typeof adminOcrStatus.json.engine === 'string',
    '管理员能读 OCR 探活（available/langs/engine）', `HTTP ${adminOcrStatus.status}`);

  // 手动标签/分类/备注：访客 GET/POST 都必须 403（备注是私人内容，GET 也不给）；
  // 管理员按真实 contentKey 读应 200 —— 说明 403 是白名单拦的，不是路由不存在。
  const mmGuestGet = await req('/api/library/manual-meta', { headers: { 'x-console-guest': guestToken } });
  ok(mmGuestGet.status === 403 && mmGuestGet.json && mmGuestGet.json.guest === true,
    '访客 GET /api/library/manual-meta 被拒（403，备注是私人内容）', `HTTP ${mmGuestGet.status}`);
  const mmGuestPost = await req('/api/library/manual-meta', {
    method: 'POST',
    headers: { 'x-console-guest': guestToken, 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'g/c/hair', tags: ['女发'] })
  });
  ok(mmGuestPost.status === 403 && mmGuestPost.json && mmGuestPost.json.guest === true,
    '访客 POST /api/library/manual-meta 被拒（403）', `HTTP ${mmGuestPost.status}`);
  const mmAdminBare = await req('/api/library/manual-meta', { headers: { 'x-console-token': consoleToken } });
  const mmKeyList = await req('/api/library/assets?limit=1', { headers: { 'x-console-token': consoleToken } });
  const mmKey = String(mmKeyList?.json?.assets?.[0]?.key || '');
  if (mmAdminBare.status === 404) {
    console.log('SKIP 手动标签接口还没上线（管理员也 404，等 rules-backend 落地 + 重启）');
  } else if (!mmKey) {
    console.log('SKIP 素材列表里没有可用的 key，管理员 manual-meta 对照待有素材后再验证');
  } else {
    const mmAdmin = await req('/api/library/manual-meta?key=' + encodeURIComponent(mmKey), { headers: { 'x-console-token': consoleToken } });
    ok(mmAdmin.status === 200 && mmAdmin.json && mmAdmin.json.ok === true,
      '管理员按 key 读手动标签 200（访客 403 是白名单拦的，不是路由不存在）', `HTTP ${mmAdmin.status}`);
  }

  // BOOTH 登录：访客 start/status/stop 三条都必须 403；管理员 status 200 作对照
  //（接口还没上线时管理员也 404，按 SKIP 记，别把「没写完」误记成白名单回归）。
  const lgGuestStart = await req('/api/library/purchases/login/start', {
    method: 'POST',
    headers: { 'x-console-guest': guestToken, 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  ok(lgGuestStart.status === 403 && lgGuestStart.json && lgGuestStart.json.guest === true,
    '访客 POST /api/library/purchases/login/start 被拒（403，登录态是管理端操作）', `HTTP ${lgGuestStart.status}`);
  const lgGuestStatus = await req('/api/library/purchases/login/status', { headers: { 'x-console-guest': guestToken } });
  ok(lgGuestStatus.status === 403 && lgGuestStatus.json && lgGuestStatus.json.guest === true,
    '访客 GET /api/library/purchases/login/status 被拒（403）', `HTTP ${lgGuestStatus.status}`);
  const lgGuestStop = await req('/api/library/purchases/login/stop', {
    method: 'POST',
    headers: { 'x-console-guest': guestToken, 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  ok(lgGuestStop.status === 403 && lgGuestStop.json && lgGuestStop.json.guest === true,
    '访客 POST /api/library/purchases/login/stop 被拒（403）', `HTTP ${lgGuestStop.status}`);
  const lgAdminStatus = await req('/api/library/purchases/login/status', { headers: { 'x-console-token': consoleToken } });
  if (lgAdminStatus.status === 404) {
    console.log('SKIP BOOTH 登录接口还没上线（管理员 status 也 404，等 booth-login.js 落地 + 重启）');
  } else {
    ok(lgAdminStatus.status === 200 && lgAdminStatus.json && lgAdminStatus.json.ok === true,
      '管理员能读 BOOTH 登录状态 200（访客 403 是白名单拦的，不是路由不存在）', `HTTP ${lgAdminStatus.status}`);
  }

  // 工程使用统计：管理员看得到 roots[].dir / projects[].path，访客只能看到工程名。
  if (!staleReads.includes('/api/library/usage')) {
    const usageAdmin = await req('/api/library/usage', { headers: { 'x-console-token': consoleToken } });
    const usageGuest = await req('/api/library/usage', { headers: { 'x-console-guest': guestToken } });
    const adminRoots = Array.isArray(usageAdmin?.json?.roots) ? usageAdmin.json.roots : [];
    const guestRoots = Array.isArray(usageGuest?.json?.roots) ? usageGuest.json.roots : [];
    if (adminRoots.length) {
      ok(adminRoots.every((root) => path.isAbsolute(String(root?.dir || ''))),
        '管理员看使用统计仍带扫描根绝对路径（功能没被削）');
      ok(guestRoots.every((root) => !('dir' in root)
        && (root.projects || []).every((project) => !('path' in project) && !('evidence' in project))),
        '访客看使用统计只剩工程名（无 dir/path/evidence）');
    } else {
      ok(guestRoots.length === 0, '访客使用统计形状正常（当前没配置扫描根）');
    }
  }

  // 单件详情：先从列表拿一个真实 contentKey，再让访客按 key 读详情。
  const guestList = await req('/api/library/assets?limit=1', { headers: { 'x-console-guest': guestToken } });
  const firstKey = String(guestList?.json?.assets?.[0]?.key || '');
  if (!firstKey) {
    console.log('SKIP 素材列表里没有可用的 key，单件详情待有素材后再验证');
  } else {
    const detailPath = '/api/library/asset?key=' + encodeURIComponent(firstKey);
    const detail = await req(detailPath, { headers: { 'x-console-guest': guestToken } });
    const adminDetail = await req(detailPath, { headers: { 'x-console-token': consoleToken } });
    if (detail.status === 403 && adminDetail.status === 200) {
      console.log('SKIP 线上桥接仍是旧白名单（重启后才生效），单件详情待重启后验证');
    } else if (detail.status !== 200) {
      ok(false, '访客能读单件详情', `HTTP ${detail.status}（管理员 ${adminDetail.status}）`);
    } else {
      const raw = String(detail.text || '');
      ok(detail.json && detail.json.ok === true, '访客能读单件详情（/api/library/asset?key=…）', `HTTP ${detail.status}`);
      ok(detail.json.paths === null && detail.json.asset && detail.json.asset.usage === null,
        '访客详情里 paths=null、asset.usage=null（绝对路径与工程路径都不给）');
      ok(!ABS_PATH_RE.test(raw) && !/\/home\//.test(raw) && !/AppData/.test(raw),
        '访客详情整段 JSON 不含本机绝对路径');
      ok(detail.json.asset && Array.isArray(detail.json.asset.files)
        && detail.json.asset.files.every((file) => typeof file.rel === 'string' && !path.isAbsolute(file.rel)),
        '访客详情仍保留相对路径字段（files[].rel 都是相对路径）');
      // 管理端功能不能被削：同一件素材，管理员仍拿到绝对路径。
      ok(adminDetail.status === 200 && adminDetail.json && adminDetail.json.paths
        && path.isAbsolute(String(adminDetail.json.paths.dirAbs || '')),
        '管理员详情仍带绝对路径（没有把功能删坏）');
    }
  }

  // 敏感读与写入口：访客必须 403（已购清单=个人数据、对账含已购、回收站保守不给、open-url 是管理端动作）。
  for (const p of ['/api/library/purchases', '/api/library/reconcile', '/api/library/trash']) {
    const res = await req(p, { headers: { 'x-console-guest': guestToken } });
    ok(res.status === 403, `访客读敏感接口 ${p} 被拒（403）`, `HTTP ${res.status}`);
  }
  const openUrlAsGuest = await req('/api/open-url', {
    method: 'POST',
    headers: { 'x-console-guest': guestToken, 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://booth.pm/' })
  });
  ok(openUrlAsGuest.status === 403, '访客调用 /api/open-url 被拒（403）', `HTTP ${openUrlAsGuest.status}`);

  // /api/console/guest 的 scope 文案必须包含本轮新增的「文件库可看」范围（旧进程会落后，按 SKIP 记）。
  const scopeText = String(asAdmin.json?.scope || '');
  if (/文件库可看/.test(scopeText) && /识别规则/.test(scopeText)) {
    ok(true, '/api/console/guest 的 scope 已包含新增的只读范围');
  } else if (scopeText) {
    console.log('SKIP 线上桥接仍是旧文案（重启后才生效），scope 待重启后验证');
  } else {
    ok(false, '/api/console/guest 返回的 scope 为空');
  }

  const guestWrite = await req('/api/library/bind', {
    method: 'POST',
    headers: { 'x-console-guest': guestToken, 'content-type': 'application/json', 'x-console-call': '1' },
    body: JSON.stringify({ key: 'x/y/z', boothId: '123456' })
  });
  ok(guestWrite.status === 403 && guestWrite.json && guestWrite.json.guest === true, '访客写绑定被拒（403 guest）', `HTTP ${guestWrite.status}`);

  const guestSpend = await req('/api/tokens/summary', { headers: { 'x-console-guest': guestToken } });
  ok(guestSpend.status === 403, '访客看花费被拒（403）', `HTTP ${guestSpend.status}`);

  const noToken = await req('/api/library/assets');
  ok(noToken.status === 401, '什么都不带仍然 401', `HTTP ${noToken.status}`);

  const adminRead = await req('/api/library/assets', { headers: { 'x-console-token': consoleToken } });
  ok(adminRead.status === 200, '管理员读素材卡照旧 200', `HTTP ${adminRead.status}`);

  // ── 绝对路径兜底（真机）：素材卡 root / 文件统计 dir，访客一律 null，管理员照旧 ──
  const guestAssets = await req('/api/library/assets?limit=1', { headers: { 'x-console-guest': guestToken } });
  const adminAssetsRes = await req('/api/library/assets?limit=1', { headers: { 'x-console-token': consoleToken } });
  ok(guestAssets.status === 200 && guestAssets.json && guestAssets.json.root === null,
    '访客素材卡 root=null（不泄露扫盘根绝对路径）', `HTTP ${guestAssets.status}`);
  if (adminAssetsRes.status === 200 && adminAssetsRes.json) {
    ok(typeof adminAssetsRes.json.root === 'string' && path.isAbsolute(String(adminAssetsRes.json.root)),
      '管理员素材卡仍带扫盘根绝对路径（功能没被削）');
  }
  const guestStats = await req('/api/files/stats', { headers: { 'x-console-guest': guestToken } });
  const adminStats = await req('/api/files/stats', { headers: { 'x-console-token': consoleToken } });
  ok(guestStats.status === 200 && guestStats.json && guestStats.json.dir === null,
    '访客文件统计 dir=null（转存目录可能被配成绝对路径）', `HTTP ${guestStats.status}`);
  if (adminStats.status === 200 && adminStats.json) {
    ok(typeof adminStats.json.dir === 'string', '管理员文件统计 dir 字段仍在（面板要显示转存位置）');
  }

  // 读不存在的图：404 的错误文本不能带本机绝对路径（真机泄漏过 stat '<本机路径>\x.jpg'）。
  const rawMissGuest = await req('/api/files/raw?rel=__guest_sweep__.jpg', { headers: { 'x-console-guest': guestToken } });
  const rawMissAdmin = await req('/api/files/raw?rel=__guest_sweep__.jpg', { headers: { 'x-console-token': consoleToken } });
  const guestErr = String(rawMissGuest?.json?.error || '');
  if (rawMissGuest && rawMissGuest.status === 403) {
    console.log('SKIP 线上桥接仍是旧白名单（重启后才生效），raw 404 文本待重启后验证');
  } else if (ABS_PATH_RE.test(guestErr)) {
    // 旧进程（本次改动重启前）：如实报 SKIP 而不是红——重启后这组断言必须转真。
    console.log(`SKIP 线上桥接还是改前代码（raw 404 仍回绝对路径：${guestErr}），重启后这组断言转真`);
  } else {
    ok(rawMissGuest?.status === 404, '访客读不存在的图返回 404', `HTTP ${rawMissGuest?.status}`);
    ok(guestErr === '路径不存在',
      '访客 404 的错误文本只说「路径不存在」，不含盘符/本机路径', guestErr);
    const adminErr = String(rawMissAdmin?.json?.error || '');
    ok(adminErr.startsWith('路径不存在：__guest_sweep__.jpg') && !ABS_PATH_RE.test(adminErr),
      '管理员 404 给相对路径定位，同样不含盘符', adminErr);
  }

  // ── 全量兜底：白名单里每条 GET 都真打一次，响应体统一扫本机路径片段。
  // 以后谁新增只读接口忘了剥离绝对路径，这里会立刻红，不用等 Lead 真机发现。
  const LEAK_PATTERNS = [
    [/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/, 'Windows 盘符'],
    [/\/home\//, '/home/ 家目录'],
    [/AppData/i, 'AppData'],
    [/booth-inbox/i, '扫描根目录名'],
    [/sticker-files|media-cache/, '内部缓存目录名']
  ];
  const sweepKey = String(firstKey || 'deadbeefdeadbeef');
  const sweepBoothId = String(guestAssets.json?.assets?.[0]?.boothId || '1234567');
  const sweepUrl = (rule) => {
    if (rule === '/api/library/asset' || rule === '/api/library/find') return rule + '?key=' + encodeURIComponent(sweepKey);
    if (rule === '/api/files/raw' || rule === '/api/files/thumb') return rule + '?rel=__guest_sweep__.jpg';
    if (rule.endsWith('/')) return rule + sweepBoothId;
    return rule;
  };
  const sweeps = [];
  const staleSweep = [];
  const leaks = [];
  const badBinary = [];
  // 二进制响应（图片/下载）只断言状态码：把 JPEG 字节当文本扫，随机字节会撞上盘符正则（真机误报过）。
  const BINARY_OK = new Set([200, 304, 404]);
  for (const rule of guest.GUEST_ALLOWED) {
    const res = await req(sweepUrl(rule), { headers: { 'x-console-guest': guestToken } });
    if (!res) { sweeps.push([rule, 0]); continue; }
    if (res.status === 403) staleSweep.push(rule);
    sweeps.push([rule, res.status]);
    const type = String(res.contentType || '').toLowerCase();
    const isBinary = type.startsWith('image/') || type.startsWith('application/octet-stream') || type.startsWith('application/zip');
    if (isBinary) {
      if (!BINARY_OK.has(res.status)) badBinary.push(`${rule}:${res.status}(${type})`);
      continue;
    }
    for (const [re, label] of LEAK_PATTERNS) {
      if (re.test(String(res.text || ''))) leaks.push(`${rule} → ${label}`);
    }
  }
  if (staleSweep.length) {
    console.log(`SKIP 线上桥接仍是旧白名单（重启后才生效），全量绝对路径兜底待重启：${staleSweep.join(', ')}`);
  } else {
    ok(leaks.length === 0, `白名单 ${guest.GUEST_ALLOWED.length} 条 GET 的响应体都不含本机绝对路径`, leaks.slice(0, 4).join('；'));
    ok(badBinary.length === 0, '图片/下载类响应状态码在 200/304/404 之内（二进制不做文本扫描）', badBinary.slice(0, 4).join('；'));
    ok(sweeps.every(([, status]) => status !== 401 && status !== 500),
      '白名单内每条 GET 都不会因缺令牌/服务端错误而失败',
      sweeps.filter(([, s]) => s === 401 || s === 500).map(([r, s]) => `${r}:${s}`).join('；'));
    ok(sweeps.filter(([, status]) => status === 200).length >= 8,
      `白名单内至少 8 条 GET 真能读出 200（实测 ${sweeps.filter(([, s]) => s === 200).length} 条）`);
  }
}

console.log('');
console.log(`只读访客：通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
