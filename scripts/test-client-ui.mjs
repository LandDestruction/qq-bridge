// 客户端外壳（public/client.html）静态 + 契约断言。
//
// 为什么只做静态断言：这一页跑在 3100 回环服务上、数据来自真实桥接。能在任意沙箱里稳定
// 复现的事实只有三类 —— ①页面结构（导航/卡片/三态/响应式）；②与后端的接口契约（页面上
// 写的每个 /api/ 路径都必须真的存在于 src/bridge/console/*.js 的路由表里）；③安全边界
// （不外链、无 eval、无阻塞对话框、不外开窗口）。真机渲染由 done note 里的截图负责。
//
// 路由表一律**正则抽取**，不手抄：手抄的清单会在下一次加路由时悄悄过期。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticPageFor, staticPageFiles } from '../src/bridge/console/static-pages.js';
import { createConsoleOperations } from '../src/bridge/console/operations.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 页面已拆成三份：结构在 client.html、样式在 client.css、应用脚本在 client.js。
// 多数断言是「页面上有没有这段文本」，按合并串判断（等价于拆分前读整页）；
// 结构性命中（标签写法 / 内联脚本数量 / 元素 id 唯一）分别针对 dom 与 js，见 §1b 与 §结构自证。
const dom = fs.readFileSync(path.join(ROOT, 'public', 'client.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'client.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public', 'client.js'), 'utf8');
const html = dom + '\n' + css + '\n' + js;
const operations = fs.readFileSync(path.join(ROOT, 'src', 'bridge', 'console', 'operations.js'), 'utf8');
const staticPages = fs.readFileSync(path.join(ROOT, 'src', 'bridge', 'console', 'static-pages.js'), 'utf8');
const consoleDir = path.join(ROOT, 'src', 'bridge', 'console');
const consoleSources = fs.readdirSync(consoleDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => fs.readFileSync(path.join(consoleDir, name), 'utf8'))
  .join('\n');
// 离线预览器：页面拆成三份后它只 serve HTML，会用的人会看到白屏。这里同时断言它补了静态资源路由。
const fixtureSource = fs.readFileSync(path.join(ROOT, 'scripts', 'console-ui-fixture.mjs'), 'utf8');

let passed = 0;
const failures = [];
function check(cond, name, extra = '') {
  if (cond) { passed += 1; console.log(`  ok   ${name}${extra ? ' — ' + extra : ''}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

// ── 1. 路由：/client 与 /client.html 都落到 client.html，且不挤掉原有三个页面 ──
console.log('## 路由');
check(staticPageFor('/client')?.file === 'client.html', '/client 分派到 public/client.html');
check(staticPageFor('/client.html')?.file === 'client.html', '/client.html 别名同样可用');
check(staticPageFor('/')?.file === 'client.html', '/ 已下线旧控制台，改指 client（client.html）');
check(staticPageFor('/ops')?.file === 'ops.html', '原 /ops 仍分派 ops.html');
check(staticPageFor('/library')?.file === 'library.html' && staticPageFor('/library.html')?.file === 'library.html', '原 /library 两种写法仍可用');
check(staticPageFor('/nope') === null, '未登记的路径返回 null（继续走 API 分派）');
check(staticPageFiles().every((file) => fs.existsSync(path.join(ROOT, 'public', file))), '分派表里的每个页面文件都真实存在于 public/', staticPageFiles().join(', '));
check(/loadStaticPages\(deps\)/.test(operations) && /staticPageFor\(request\.url\.pathname\)/.test(operations) && /serveStaticPage\(request, deps, page\)/.test(operations), 'operations.js 通过 static-pages.js 的 helper 统一服务静态页');
check(!/readFileSync\(deps\.path\.join\(deps\.ROOT, 'public', 'console\.html'\)/.test(operations), '旧的三段复制粘贴已删除（不再直接读 public/*.html）');
check(/function staticPageFor/.test(staticPages) && /function serveStaticPage/.test(staticPages), 'helper 在模块作用域（工厂外），可独立单测');
check(/pathname === '\/api\/version'/.test(operations), '/api/version 路由存在（顶栏版本与本机 QQ）');
check(/x-agent-token'\] \|\| request\.req\.headers\['x-agent-call'\] !== undefined/.test(operations.slice(operations.indexOf("'/api/version'"), operations.indexOf("'/api/version'") + 700)), '/api/version 对 x-agent-* 一律 403（不给会话级主体）');
// 真实进程里还有一道门：console-server.js 的路径白名单。不在名单里的路径根本进不了
// handleConsoleOperations —— /client 曾因此回 404，光改分派表和服务页都救不回来。
const consoleServer = fs.readFileSync(path.join(ROOT, 'src', 'bridge', 'console-server.js'), 'utf8');
const gateBlock = (consoleServer.match(/@bridge-routes handleConsoleOperations[\s\S]*?@bridge-routes handleConsoleOperations:end/) ?? [''])[0];
check(/'\/client'/.test(gateBlock) && /'\/client\.html'/.test(gateBlock), 'console-server 的路径白名单放行 /client 与 /client.html');
check(/'\/api\/version'/.test(gateBlock), 'console-server 的路径白名单放行 /api/version');

// ── 1b. 拆分后的静态资源：接线 + 路由 + 真行为 ───────────────────────────────
// 拆分把样式与主脚本搬出了 client.html，HTML 里只留两条同源自托管外链。
// 除了文本断言，这里用假 request/res 直接调 operations.js 的新路由，验证
// content-type / Cache-Control / 404 文案 / 响应体与磁盘文件逐字节一致 —— 不必等真机重启。
console.log('## 静态资源拆分（client.css / client.js）');
const linkTag = (dom.match(/<link rel="stylesheet" href="\/client\.css">/) ?? [''])[0];
const scriptTag = (dom.match(/<script src="\/client\.js" defer><\/script>/) ?? [''])[0];
check(linkTag !== '' && dom.indexOf(linkTag) < dom.indexOf('</head>'), '<link rel="stylesheet" href="/client.css"> 在 </head> 之前');
check(scriptTag !== '' && dom.indexOf(scriptTag) > dom.indexOf('id="toastHost"') && dom.indexOf(scriptTag) < dom.lastIndexOf('</body>'), '<script src="/client.js" defer></script> 在 body 末尾、</body> 之前');
check(dom.indexOf('<style') === -1, 'client.html 里不再有 <style> 块（样式整体搬去 client.css）');
check(css.length > 10000 && /:root\s*\{/.test(css) && /@media \(max-width: 768px\)/.test(css), 'client.css 承载全部样式（令牌与 768px 断点都在）', `${css.length} 字符`);
check(js.length > 10000 && /'use strict';/.test(js) && /var BRAND = \{/.test(js) && /onReady/.test(js), 'client.js 承载应用脚本（严格模式 / BRAND / onReady）', `${js.length} 字符`);
check(!js.includes('</script>'), 'client.js 里没有 </script> 字面量（外链脚本不该出现闭合标签）');
check(/'\/client\.css'/.test(gateBlock) && /'\/client\.js'/.test(gateBlock), 'console-server 的路径白名单放行 /client.css 与 /client.js');
check(/NO_TOKEN_GET_PATHS = new Set\(\[[\s\S]{0,400}'\/client\.css'[\s\S]{0,200}'\/client\.js'/.test(consoleServer), 'console-server 在鉴权处放行这两个静态资源（浏览器子资源带不了令牌）');
check(/STATIC_ASSETS\.get\(request\.url\.pathname\)/.test(operations), 'operations.js 用固定文件名查表分派（不拼用户输入，防目录穿越）');
check(operations.includes("['/client.css', { file: 'client.css', type: 'text/css; charset=utf-8' }]") && operations.includes("['/client.js', { file: 'client.js', type: 'text/javascript; charset=utf-8' }]"), '两条资源路由的 content-type 正确');
check(/'Cache-Control': 'no-cache'/.test(operations), '静态资源带 Cache-Control: no-cache（开发期前端改动立刻生效）');
check(/writeHead\(404/.test(operations) && /静态资源缺失：qq-bridge\/public\//.test(operations), '文件缺失回 404 + 可读文案（不是 200 空响应）');
function fakeAssetRequest(method, pathname, root = ROOT) {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(body) { if (body !== undefined) this.body += String(body); }
  };
  const deps = { fs, path, ROOT: root, log: () => {} };
  const request = {
    req: { method, headers: {} },
    url: { pathname },
    res,
    SECURITY_HEADERS: { 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' },
    sendJson: (obj, status = 200) => { res.writeHead(status, {}); res.end(JSON.stringify(obj)); }
  };
  return { run: () => createConsoleOperations(deps).handleConsoleOperations(request), res };
}
{
  const { run, res } = fakeAssetRequest('GET', '/client.css');
  await run();
  check(res.statusCode === 200 && res.headers['content-type'] === 'text/css; charset=utf-8', '/client.css 回 200 + text/css; charset=utf-8', `${res.statusCode} ${res.headers && res.headers['content-type']}`);
  check(res.body === css, '/client.css 响应体与 public/client.css 逐字节一致');
  check(res.headers['Cache-Control'] === 'no-cache' && res.headers['X-Frame-Options'] === 'DENY', '/client.css 带 no-cache 与安全响应头');
}
{
  const { run, res } = fakeAssetRequest('GET', '/client.js');
  await run();
  check(res.statusCode === 200 && res.headers['content-type'] === 'text/javascript; charset=utf-8', '/client.js 回 200 + text/javascript; charset=utf-8', `${res.statusCode} ${res.headers && res.headers['content-type']}`);
  check(res.body === js, '/client.js 响应体与 public/client.js 逐字节一致');
}
{
  const { run, res } = fakeAssetRequest('GET', '/client.css', path.join(ROOT, 'scripts', 'fixtures', '__missing-root__'));
  await run();
  check(res.statusCode === 404 && /静态资源缺失/.test(res.body) && res.body.length > 0, '文件缺失回 404 + 可读文案（不是 200 空响应）', `${res.statusCode} ${JSON.stringify(res.body.slice(0, 40))}`);
}
{
  const { run, res } = fakeAssetRequest('POST', '/client.css');
  const handled = await run();
  check(handled === false && res.statusCode === null, '非 GET 不接管静态资源，交回后续 404 分派');
}

// ── 2. 顶栏 / 品牌 / 免责 ────────────────────────────────────────────────────
console.log('## 品牌与顶栏');
const title = (html.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1];
check(title === 'QQ DeepSeek Bot', '<title> 是 QQ DeepSeek Bot', String(title));
const brandBlock = (html.match(/var BRAND = \{[\s\S]*?\};/) ?? [''])[0];
check(brandBlock.includes("name: 'QQ DeepSeek Bot'"), 'BRAND 常量定义了品牌名');
check(brandBlock.includes('不 affiliated') === false && /非腾讯 \/ 非 DeepSeek 官方产品（Not affiliated with Tencent or DeepSeek）/.test(brandBlock), 'BRAND 里带非官方产品声明');
check(html.includes('id="brandSidebar"') && html.includes('id="brandTopbar"') && html.includes('id="brandFooter"'), '侧栏 / 顶栏 / 页脚都有品牌挂载点');
check(/let|var|const/.test(brandBlock) && (html.match(/BRAND\.name/g) ?? []).length >= 2, '渲染的品牌名都从 BRAND 常量取', `引用 ${(html.match(/BRAND\.name/g) ?? []).length} 处`);
check(html.includes('非腾讯 / 非 DeepSeek 官方产品（Not affiliated with Tencent or DeepSeek）'), '页脚/关于有非官方产品声明');
for (const id of ['connDot', 'connText', 'qqChip', 'versionChip', 'themeToggle']) check(html.includes(`id="${id}"`), `顶栏元素 #${id} 存在`);
// 品牌图标是内嵌的鲸鱼头像：data: URI 必须配 CSP 的 img-src data:，否则线上是破图。
check(/class="qdb-logo"[^>]*>\s*<img[^>]+src="data:image\/webp;base64,/.test(html), '品牌图标是内嵌 webp 头像（不是文字占位）');
check(html.includes('link rel="icon"') && html.includes('type="image/webp"'), '浏览器标签图标同一张图');
check(/\.qdb-logo img \{[^}]*object-fit: cover/.test(html), '图标按 cover 填满圆角方块');

// ── 3. 导航与响应式 ─────────────────────────────────────────────────────────
console.log('## 导航与响应式');
const NAV = ['dashboard', 'framework', 'sessions', 'persona', 'memory', 'slang', 'stickers', 'library-pro', 'library', 'lists', 'routing', 'logs', 'usage', 'ops', 'settings'];
// 第 13 项「工具开关」是隐藏页：静态 HTML 里没有，解锁后才由 JS 追加（见 §12）。
const DEV_NAV_VIEW = 'toolgate';
const views = [...new Set([...html.matchAll(/data-view="([a-z-]+)"/g)].map((m) => m[1]))];
check(NAV.every((v) => views.includes(v)) && views.length === NAV.length, '导航基础 15 项齐全（含系统架构、用量与花费、素材库 Pro；「找号」已并入素材库）', views.join(', '));
const NAV_LABELS = ['仪表盘', '架构', '会话', '人设', '记忆', '黑话', '表情', '素材库', '转存与存储', '名单', '模型与高峰', '日志', '用量与花费', '运维', '设置'];
check(NAV_LABELS.every((label) => html.includes('>' + label + '<') || html.includes(label + '\n')), '导航中文文案齐全', NAV_LABELS.join('、'));
const pagesAttrs = [...new Set([...html.matchAll(/data-page="([a-z-]+)"/g)].map((m) => m[1]))];
check(pagesAttrs.length === NAV.length + 1 && NAV.every((v) => pagesAttrs.includes(v)) && pagesAttrs.includes(DEV_NAV_VIEW),
  '每个导航项都有对应视图区块：基础 12 项 + 解锁后才显示的工具开关页', pagesAttrs.join(', '));
check(/id="hamburger"/.test(html) && /aria-expanded/.test(html), '≤768px 汉堡按钮与 aria-expanded 都在');
check(/@media \(max-width: 768px\)/.test(html) && /transform: translateX\(-100%\)/.test(html) && /\.qdb-nav-open \.qdb-sidebar/.test(html), '768px 断点把侧栏收进抽屉');
check(/@media \(max-width: 420px\)/.test(html), '420px 断点存在（极窄屏）');
check(/grid-template-columns: 1fr;/.test(html), '窄屏卡片变单列');
check(/classList\.(add|remove)\('qdb-nav-open'\)/.test(html) && /function closeNav/.test(html), '汉堡菜单真能开关（带关闭路径）');

// ── 4. 主题：跟着 localStorage 走，首屏不闪 ─────────────────────────────────
console.log('## 主题');
const headEnd = dom.indexOf('</head>');
const linkAt = dom.indexOf('<link rel="stylesheet" href="/client.css">');
const bootEnd = dom.indexOf('</script>');
const themeScriptAt = dom.indexOf("localStorage.getItem('qdb-theme')");
check(themeScriptAt > -1 && themeScriptAt < bootEnd && bootEnd < linkAt && linkAt < headEnd, '防闪引导脚本内联在 head、且在样式表之前执行（首屏不闪）');
check(linkAt > -1 && linkAt < headEnd, '<link rel="stylesheet" href="/client.css"> 在 head 里（样式全在 client.css）');
check(/localStorage\.setItem\(THEME_KEY, [^)]+?\)/.test(html) && /var THEME_KEY = 'qdb-theme'/.test(html), '切换主题写回 localStorage');
check(/document\.documentElement\.dataset\.theme/.test(html), '主题落在 <html data-theme>');
check(html.includes('#101a17') && html.includes('#3ed0b4'), '深色令牌：#101a17 底（深墨绿）/ #3ed0b4 强调（薄荷青，不再是粉紫）');
check(html.includes('#0e9f8a') && html.includes('#0b6e60') && !/E8467C/i.test(html), '浅色令牌：#0e9f8a 装饰 / #0b6e60 文字，且旧的深粉 #E8467C 已清干净');
check(html.includes('#1d7a53') && html.includes('#8f5e10') && html.includes('#a83c2c'), '语义色 success / warn / danger 三色齐全（均按 AA 对比度加深）');
check(/--ui-/.test(html) && /qdb-/.test(html), '令牌前缀 --ui-、类名前缀 qdb-（与设计系统对齐）');

// ── 4b. 界面方案（三套皮肤）+ 毛玻璃 ─────────────────────────────────────────
console.log('## 界面方案与毛玻璃');
check(html.includes("var SKIN_KEY = 'qdb-skin'") && html.includes("var GLASS_KEY = 'qdb-glass'"), '皮肤 / 毛玻璃各自有 localStorage 键');
const bootAt = dom.indexOf("localStorage.getItem('qdb-skin')");
const glassAt = dom.indexOf("localStorage.getItem('qdb-glass')");
check(bootAt > -1 && bootAt < headEnd && glassAt > -1 && glassAt < headEnd, '首屏引导脚本就读皮肤与毛玻璃（避免第一帧抖一下）');
check(/dataset\.skin/.test(html) && /dataset\.glass/.test(html), '皮肤落在 <html data-skin>、毛玻璃落在 <html data-glass>');
for (const skin of ['mint', 'paper', 'peach', 'pink']) {
  check(new RegExp(`\[data-skin="${skin}"\]`).test(html), `皮肤 ${skin} 有令牌覆盖块`);
  check(new RegExp(`\[data-skin="${skin}"\]\[data-theme="dark"\]`).test(html), `皮肤 ${skin} 有配套深色令牌`);
}
check(html.includes('--ui-glass-bg') && html.includes('--ui-glass-blur') && /backdrop-filter: blur\(/.test(html), '毛玻璃：玻璃底色 / 模糊半径令牌 + backdrop-filter 真的用上');
check(/@supports not \(\(backdrop-filter/.test(html), '老浏览器不支持 backdrop-filter 时退回实色');
check(/\[data-glass="on"\] \.qdb-card,[\s\S]{0,400}\.qdb-dialog \{/.test(html), '毛玻璃只作用于卡片 / 面板 / 弹层（顶栏不加，理由见下面的断言）');
check(/\[data-glass="on"\] \.qdb-sidebar\[data-stuck="1"\] \{[\s\S]{0,220}backdrop-filter: blur\(20px\)/.test(html) && /\[data-glass="on"\] \.qdb-sidebar \{\s*background: transparent;/.test(html),
  '导航条静止在顶部时全透明，滚动后才加模糊（否则屏幕最上面会横着一条和背景不同的色带）');
check(/bindNavStuck\(\)/.test(js) && /data-stuck/.test(js) && /window\.addEventListener\('scroll', apply, \{ passive: true \}\)/.test(js),
  '滚动位置切换 data-stuck：滚过 6px 才把导航条托起来');
check(/\[data-glass="on"\] \.qdb-toast,[\s\S]{0,80}\[data-glass="on"\] \.qdb-slang-sticky,/.test(html),
  '顶栏不再挂 backdrop-filter（static 元素，只会糊出一条色带）');
check(html.includes('data-set-skin=') && html.includes('data-set-theme=') && html.includes('id="setGlass"'), '设置页能切方案、配色和毛玻璃');
check((html.match(/id: '(mint|paper|peach|pink)', name:/g) ?? []).length === 4, '四套界面方案都登记进 SKINS（设置页四张卡片）');
check(/pink: \{ bg: '#fdf6f8', card: '#ffffff', accent: '#d6336c' \}/.test(html), '淡粉方案有缩略色块（卡片预览用）');
check(/savedSkin === 'pink'/.test(dom) && /next === 'pink'/.test(js) && /value === 'pink'/.test(js), '首屏引导 / 切换 / 读当前值三处都认 pink（刷新后不会掉回默认）');

check(/var SETTINGS_GROUPS = \[/.test(html) && (html.match(/id: '(look|access|config|security)'/g) ?? []).length === 4, '设置页 4 个分组：外观 / 白名单 / 配置 / 安全与关于');
check(/function paintSettings\(/.test(html) && /function bindSettingsControls\(/.test(html), '设置页分组切换不整页重取（只重画右栏）');

// ── 5. 六张卡片：结构 + 三态 ────────────────────────────────────────────────
console.log('## 仪表盘卡片');
const CARDS = ['status', 'services', 'selfcheck', 'tokens', 'sessions', 'lists'];
for (const id of CARDS) check(html.includes(`id="card-${id}"`), `卡片 #card-${id} 存在`);
check(CARDS.every((id) => html.includes(`data-retry="${id}"`)), '每张卡都有独立的刷新/重试按钮');
check(/加载中…/.test(html) && /qdb-skeleton/.test(html), '加载态有骨架 + 「加载中…」文案');
check(/加载失败/.test(html) && /qdb-error-reason/.test(html), '失败态显示「加载失败」与原因');
check(/还没有自检结果/.test(html), '自检 404 有空态文案（不装成失败）');
check(/暂无数据/.test(html), '通用空态文案存在');
check(/spec\.emptyOn404 && error && error\.status === 404/.test(html), '404 走空态分支而不是红色错误');
check(/\.catch\(function \(error\) \{/.test(html) && /Promise\.all\(CARDS\.map/.test(html), '每张卡独立 catch、整体 Promise.all：单卡失败不白屏');

// ── 5b. 文件库卡：素材库总览（数据来自 /api/library/assets?limit=1 的 summary）──
// 素材库列表每件都要扫盘，仪表盘只借这个接口的汇总字段，所以必须 limit=1；卡面数字一个都
// 不能写死，字段不存在就不显示（接口形状变了要能看出来，而不是画一堆假数）。
console.log('## 文件库卡');
check(js.includes('id="card-library"') && js.includes('data-card="library"')
  && /function mountLibraryCard\(\)/.test(js) && /lists\.insertAdjacentHTML\('afterend', LIBRARY_CARD_HTML\)/.test(js),
  '文件库卡挂在「名单」卡后面（卡骨架由仪表盘模块挂载，静态页不写死）');
check(/data-card="library" style="grid-column: 1 \/ -1; order: 8"/.test(js),
  '库卡整行收尾：order 8 排在会话(6)/名单(7)之后，不会把上面两行挤成洞');
check(/CARDS\.push\(\{ id: 'library', path: '\/api\/library\/assets\?limit=1', title: '文件库'/.test(js),
  '文件库卡走同一套 CARDS 并行加载，且只拉 1 件拿 summary（不整包拉素材卡）');
check(/var count = Number\(d\.allCount\);/.test(js) && /d\.fileCount/.test(js) && /d\.withBooth/.test(js)
  && /d\.missingOnDisk/.test(js) && /d\.suggested !== undefined/.test(js),
  '卡面字段全部来自接口真实字段：count / fileCount / withBooth / missingOnDisk / suggested');
check(/libChip\('有号', withBooth\)/.test(js) && /libChip\('无号', Math\.max\(0, count - withBooth\)\)/.test(js)
  && /libChip\('缺封面', count - withCover\)/.test(js) && /libChip\('待处理', missing\)/.test(js) && /libChip\('建议'/.test(js),
  'chip 行：有号 / 无号 / 缺封面 / 待处理 / 建议（全部按数据算，不写死）');
check(/data-goto="library">打开文件库 →</.test(js), '有「打开文件库 →」入口，走现有 data-goto 委托（不自己绑 location）');
check(js.includes('还没扫过：素材库里还没扫到文件') && /if \(!count\) return \{ empty:/.test(js),
  '一件都没有时显示「还没扫过」空态（不是 0 件假数据）');
check(js.includes('最近扫描 ') && /timeText\(scannedAt\)/.test(js), '显示最近一次扫描时间（接口没给时间就不显示）');
check(/library: \{ view: 'library', viewLabel: '文件库', render: detailLibrary \}/.test(js),
  '点卡片有详情弹层（读缓存数据，跳到「文件库」页）');
check(/CARDS\.push\(\{ id: 'library'/.test(js) && /setError\(spec, error\);/.test(js)
  && !/spec\.id === 'library'/.test(js),
  '接口失败走 loadCard 通用 setError：只红这张卡（页面其它卡照常），不整页抛错');

// ── 仪表盘定时刷新不能打断浏览（滚动位置 + 卡顿）────────────────────────────
console.log('## 仪表盘刷新不打断滚动');
check(/if \(!state\.cardLoaded\[spec\.id\]\) setLoading\(spec\);/.test(html), '骨架屏只在第一次加载时铺，定时刷新沿用旧内容');
check(/cardLoaded: \{\s*\}/.test(html) || /cardLoaded: \{\}/.test(html), '状态里记着每张卡是否已加载过（cardLoaded）');
check(/function paintBody\(parts, html\)/.test(html) && /if \(parts\.body\.__qdbHtml === html\) return;/.test(html), '内容没变时不换 innerHTML（少一次整块重排）');
check(/function keepScrollDuring\(fn\)/.test(html) && /window\.scrollTo\(0, Math\.min\(y, max\)\)/.test(html), '刷新前后保住滚动位置，页变矮时退到能滚到的最大值');
check(/return keepScrollDuring\(function \(\) \{/.test(html), 'loadAll 整体包在 keepScrollDuring 里');
check((html.match(/parts\.body\.innerHTML = html;/g) || []).length === 1, '卡片正文只经 paintBody 写（全文只有这一处直接覆盖 innerHTML）');

// ── 6. 接口契约：页面上写的每个 /api/ 路径都要真实存在 ──────────────────────
console.log('## 接口契约');
const apiPaths = [...new Set([...html.matchAll(/['"](\/api\/[A-Za-z0-9/_-]+)/g)].map((m) => m[1]))].sort();
check(apiPaths.length >= 7, '从页面里抽出 ≥7 个 /api/ 路径', apiPaths.join(', '));
function routeCovers(apiPath) {
  if (consoleSources.includes(`'${apiPath}'`) || consoleSources.includes(`"${apiPath}"`)) return true;
  // 路由表新写法把方法拼进描述符：['GET /api/x', handler] / ['POST /api/x', handler]。
  const escaped = apiPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`['"](?:GET|POST|PUT|PATCH|DELETE) ${escaped}['"]`).test(consoleSources)) return true;
  const prefixes = [...consoleSources.matchAll(/startsWith\('(\/api\/[^']*)'\)/g)].map((m) => m[1]);
  return prefixes.some((prefix) => apiPath === prefix || apiPath.startsWith(prefix));
}
// 每个 /api/ 路径都要在 src/bridge/console/*.js 里真实存在。
// （/api/config 原本登记成「待后端合入」的例外，C 档后端已合入 config-admin.js，例外随之撤掉。
//   /api/tools/gate 的例外也已撤掉：tools-gate.js 已合入 main。）
// L5「改名动磁盘」的后端已在 src/bridge/console/library-find.js 落地（handleRenameRoutesFor），
// 所以 /api/library/rename 与 /preview 走同一条硬断言，不留「待合入」例外。
// 补封面（L6）的后端由 console-backend 同批做：POST /api/library/covers/backfill、
// GET /api/library/covers、POST /api/library/covers/stop。还没合入 main 前先登记成
// 「待合入」的显式例外（合入后删掉这三行，会自然回到硬断言）。
const PENDING_BACKEND = new Map([
  ['/api/library/covers', 'GET 查补封面进度（console-backend 同批落地）'],
  ['/api/library/covers/backfill', 'POST 起一轮补封面（console-backend 同批落地）'],
  ['/api/library/covers/stop', 'POST 停掉一轮补封面（console-backend 同批落地）'],
]);
for (const apiPath of apiPaths) {
  if (PENDING_BACKEND.has(apiPath) && !routeCovers(apiPath)) {
    check(true, `${apiPath} 命中已登记的待合入契约：${PENDING_BACKEND.get(apiPath)}`);
    continue;
  }
  check(routeCovers(apiPath), `${apiPath} 在 src/bridge/console/*.js 路由表里真实存在`);
}
check(consoleSources.includes("'/api/config'"), '/api/config 已由后端实现（config-admin.js）');
for (const required of ['/api/status', '/api/ops/services', '/api/self-check/last', '/api/tokens/summary', '/api/socialV2/states', '/api/lists']) {
  check(apiPaths.includes(required), `仪表盘接的是 ${required}`);
}
check(/'x-console-token': state\.token/.test(html) || /headers\['x-console-token'\] = state\.token/.test(html), '请求头用 x-console-token');
check(/cache: 'no-store'/.test(html), '请求不读缓存（桥接重启后不会拿到旧数据）');
check(/if \(!res\.ok\)/.test(html) && /返回的不是 JSON/.test(html) && /响应为空/.test(html), '非 2xx / 非 JSON / 空响应都给出具体原因');
check(/ok === false/.test(html), '接口返回 ok=false 也按失败处理（不画半截数据）');

// ── 7. 令牌：?token= 只读一次就存起来 ───────────────────────────────────────
console.log('## 令牌');
check(/var TOKEN_KEY = 'consoleToken'/.test(html), '令牌键与完整控制台共用 consoleToken');
check(/params\.get\('token'\)/.test(html) && /localStorage\.setItem\(TOKEN_KEY, fromUrl\)/.test(html), '/client?token=… 读一次并存进 localStorage');
check(/params\.delete\('token'\)/.test(html) && /history\.replaceState/.test(html), '存好后从地址栏抹掉令牌');
check(/function readTokenOnce/.test(html), '令牌读取收敛成一个函数（只在 onReady 调一次）');
check(/showTokenGate/.test(html), '无令牌时弹输入层（而不是六张卡各报一次 401）');

// ── 8. 宿主（WebView2）兼容与安全边界 ───────────────────────────────────────
console.log('## 安全边界');
// 头像（群徽标 p.qlogo.cn / QQ 头像 q1.qlogo.cn）是唯一允许的外链，且只允许这两个图片域名；
// 其余一律不许——脚本、样式、字体、统计一个都不能有，页面仍然零构建、离线可开。
// 协议相对的 //host 也算外链（src="//evil/x" 是常见绕法），一并拦住。
var externalUrls = (html.match(/(?:https?:)?\/\/[^"'\s)<>]+/g) || []).filter(function (u) { return !/^\s*$/.test(u); });
var strayUrls = externalUrls.filter(function (u) {
  return !/^(?:https:)?\/\/(?:p|q1)\.qlogo\.cn\//.test(u);
});
check(strayUrls.length === 0, '除 QQ 头像域名外没有 http(s):// 外链（零外链）' + (strayUrls.length ? '，违规：' + strayUrls.slice(0, 3).join(' , ') : ''));
// 拆分后唯一允许的外链就是同源自托管的这两条；其余脚本/样式仍然一个都不许（零依赖、无构建）。
const scriptSrcTags = [...dom.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
const stylesheetLinks = [...dom.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1]);
// 现在有两条同源脚本：client.js（界面）与 changelog.js（git log 生成的更新日志数据，点开才读）。
check(scriptSrcTags.length === 2 && scriptSrcTags[0] === '/changelog.js' && scriptSrcTags[1] === '/client.js', '外链脚本只有同源的 /changelog.js 与 /client.js（零依赖、无构建）', scriptSrcTags.join(', '));
check(stylesheetLinks.length === 1 && stylesheetLinks[0] === '/client.css', '外链样式只有同源的 /client.css（零依赖、无构建）', stylesheetLinks.join(', '));
check(!/\beval\s*\(/.test(html) && !/new\s+Function\s*\(/.test(html), '没有 eval / new Function');
check(!/\balert\s*\(/.test(html) && !/\bconfirm\s*\(/.test(html) && !/\bprompt\s*\(/.test(html), '没有阻塞式 alert/confirm/prompt（提示一律页面内 toast）');
// 只有「上游卡点了就开它自己的面板」这一处允许 window.open，其余一律页内跳转（并带 noopener）。
const openCalls = html.match(/window\.open\([^\n]*\)/g) ?? [];
check(openCalls.length === 1 && /_blank', 'noopener'/.test(openCalls[0]) && !/target=["']?_blank/.test(html), '开新标签只在「点上游卡打开面板」这一处，且带 noopener');
check(/id="toastHost"/.test(html) && /function toast\(message, kind, opts\)/.test(html), '页面内有 toast 宿主与实现');
check(/close\.className = 'qdb-toast-close'/.test(html) && /opts\.sticky/.test(html) && /\{ sticky: true \}/.test(html), '失败提示带手动关闭按钮且不自动消失（sticky）');
// 致谢里必须提到 NapCat（参考过它的协议实现），但别处不许把第三方品牌当自己的
const creditsRefs = (html.match(/var CREDITS_REFS = \[[\s\S]*?\];/) || [''])[0];
check(/\{ id: 'lessons', name: '教训' \}/.test(html) && /function settingsLessonsHtml\(\)/.test(html),
  '设置页有「教训」这一栏（不只是仓库里一份 md）');
check(/var DEV_LESSONS = \[/.test(html) && /var DEV_TOKEN_SNAPSHOT = \{/.test(html),
  '教训页的数据来自 DEV_LESSONS 与 DEV_TOKEN_SNAPSHOT 两个生成文件');
check(/qdb-tokenstat-big/.test(html) && /devTokenRows\(\)/.test(html),
  '教训页顶部与致谢里都有「开发累计消耗」（同一份快照，不重复写死数字）');
check(/scripts\/make-lessons\.mjs/.test(html) && /docs\/LESSONS\.md/.test(html),
  '页面里写清了这条数据链：07b-lessons.js → make-lessons.mjs → docs/LESSONS.md');
check(/\{ id: 'credits', name: '致谢' \}/.test(html) && /function settingsCreditsHtml\(\)/.test(html),
  '设置页有「致谢」这一栏（不是藏在仓库里的 CREDITS 文件）');
check(/name: '陆地毁灭'/.test(html) && /主理人 · 需求与验收/.test(html),
  '致谢里点名主理人：陆地毁灭');
check(/CREDITS_WINDOWS_EARLIER[\s\S]{0,600}更早的那些窗口/.test(html) && /CREDITS_AGENTS[\s\S]{0,900}verifier/.test(html),
  '致谢覆盖历次窗口（含找不回来的那些）和派出去的子智能体（verifier 等）');
check(/CREDITS_REFS[\s\S]{0,900}PolyForm Noncommercial 1\.0\.0/.test(html) && /HALOFLUX/.test(html),
  '素材来源写明 HALOFLUX 的非商业许可与署名');
check(/NapCat/.test(creditsRefs) && !/napcat/i.test(html.replace(creditsRefs, '')),
  '只在「致谢」里提到 NapCat（署名可以，别处不复制第三方品牌）');
check(/function esc\(value\)/.test(html) && (html.match(/esc\(/g) ?? []).length >= 20, '所有动态值都走 esc() 转义', `esc( 出现 ${(html.match(/esc\(/g) ?? []).length} 次`);
check(!/innerHTML\s*=\s*[^;]*\+\s*(item|data|error)\.(?!message)[A-Za-z]+/.test(html), '没有任何未转义的对象字段直接拼进 innerHTML');
check(/document\.addEventListener\('visibilitychange'/.test(html) && /function stopPolling/.test(html), '页面不可见时停止轮询');
check(/setInterval\(function \(\) \{ loadAll\(\); \}, REFRESH_MS\)/.test(html), '轮询只建一个定时器');

// ── 10. 360 窄屏（T24：宿主最小窗口 360×560） ───────────────────────────────
// 这些断言对应「360 宽真视口下不许横滚」的规则面：断点、长文本兜底、顶栏两行、
// 触控尺寸、抽屉可滚。布局是否真的不溢出，由 done note 里的真视口测量证据负责
// （scrollWidth <= innerWidth），静态断言只管规则没被删。
console.log('## 360 窄屏规则');
function mediaBlock(px) {
  const start = html.indexOf(`@media (max-width: ${px}px) {`);
  if (start < 0) return '';
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(open, i + 1); }
  }
  return html.slice(open);
}
const narrow = mediaBlock(768);
const tiny = mediaBlock(420);
const viewportMeta = (html.match(/<meta\s+name="viewport"[^>]*>/) ?? [''])[0];
check(/width=device-width/.test(viewportMeta), 'viewport meta 存在且含 width=device-width', viewportMeta);
check(narrow.length > 0, '768px 断点存在（360 宽落在这条规则里）');
check(tiny.length > 0, '420px 断点存在（更窄一档的收边）');
check(/\.qdb-grid \{ grid-template-columns: 1fr; \}/.test(narrow), '窄屏卡片单列（grid 1fr）');
const navPillNowrap = /\.qdb-nav \.qdb-nav-item \{[^}]*white-space: nowrap/.test(html)
  && /\.qdb-nav \{[^}]*overflow-x: auto/.test(html);
const nowrapOutsideNav = /white-space:\s*nowrap/.test(html.replace(/\.qdb-nav \.qdb-nav-item \{[^}]*\}/g, ''));
check(!nowrapOutsideNav && navPillNowrap, '只允许顶部导航胶囊 nowrap（导航条自身横向滚动），其余长文本一律换行');
const wrapCount = (html.match(/overflow-wrap:\s*anywhere/g) ?? []).length;
check(wrapCount >= 10, '长文本容器有 overflow-wrap:anywhere 兜底', `${wrapCount} 处`);
for (const sel of ['.qdb-row-val', '.qdb-li-name', '.qdb-li-detail', '.qdb-page-title', '.qdb-footer']) {
  const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  check(new RegExp(escaped.replace('\\\\.', '\\.') + ' \\{[^}]*overflow-wrap: anywhere').test(html), `${sel} 有 overflow-wrap:anywhere`);
}
check(/\.qdb-card \{[\s\S]{0,400}?min-width: 0;/.test(html), '卡片 min-width:0（否则长群号会把 grid 顶宽）');
check(/\.qdb-shell \{ flex: 1 1 auto; min-width: 0;/.test(html) && /\.qdb-main \{[^}]*min-width: 0;/.test(html), 'shell/main 都有 min-width:0（flex 子项不顶宽）');
check(/\.qdb-topbar-meta \{ order: 3; flex: 1 1 100%/.test(narrow), '窄屏 chips 单独占一行（flex 1 1 100%）');
check(/\.qdb-topbar-theme \{ order: 2; margin-left: auto; \}/.test(narrow), '深浅色按钮留在品牌那一行（order 2，不再掉第三行）');
check(/\.qdb-hamburger \{[^}]*width: 36px; height: 32px/.test(html), '汉堡按钮 ≥32×32（36×32）');
check(/\.qdb-btn \{[\s\S]{0,300}?min-height: 32px/.test(html), '卡片内按钮 min-height:32px（触控目标）');
check(/\.qdb-list li \{[^}]*flex-wrap: wrap/.test(html), '列表类区域窄屏堆叠换行（不撑出卡片）');
check(/\.qdb-sidebar \{[^}]*overflow-y: auto/s.test(narrow) || /overflow-y: auto;/.test(narrow), '抽屉自身可滚（窗口矮时不撑高页面）');
check(/addEventListener\('click', closeNav\)/.test(html) && /ev\.key === 'Escape'/.test(html), '抽屉可点外部关闭、也可 Esc 关闭');
check(/\.qdb-nav-item \{[\s\S]{0,160}?width: 100%;/.test(html), '导航项占满抽屉宽度（整行可点）');
// 二期新控件（弹层/表单/操作按钮组）同样要能在 360 宽里活下来，规则面在这里兜住。
check(/\.qdb-dialog \{[\s\S]{0,160}?width: min\(420px, calc\(100vw - 32px\)\)/.test(html), '确认弹层宽度 min(420px, 100vw-32px)：360 宽不溢出');
check(/\.qdb-dialog-foot \{[^}]*flex-wrap: wrap/.test(html), '弹层按钮可换行（360 宽两个按钮不挤爆）');
check(/\.qdb-input, \.qdb-textarea \{[\s\S]{0,160}?min-width: 0/.test(html), '输入框/文本域 min-width:0（固定宽度会顶出横滚）');
check(/\.qdb-input, \.qdb-textarea \{[\s\S]{0,200}?box-sizing: border-box/.test(html), '输入框 border-box（padding 不算进内容宽）');
check(/\.qdb-actions \{[^}]*flex-wrap: wrap/.test(html), '操作按钮组可换行');
// 表情卡动作区改成竖排三段（备注 / 可用·不可用 / 删除），不再靠 wrap 塞进 84px：
// 每段占满整行，配对段用 flex 让两半等分，窄屏也不会横向溢出。
check(/\.qdb-thumb-actions \{[^}]*flex-direction: column/.test(html), '表情卡动作区竖排（备注在上、删除在下）');
check(/\.qdb-thumb-actions > \.qdb-btn \{[^}]*width: 100%/.test(html), '表情卡按钮各占满整行');
check(/\.qdb-thumb-seg \{[^}]*display: flex/.test(html) && /\.qdb-thumb-seg > \.qdb-btn \{[^}]*flex: 1 1 0/.test(html),
  '「可用 / 不可用」成对排一行且两半等分');

// ── 10.4b 会话头像与群成员 ─────────────────────────────────────────────────
console.log('## 会话头像 / 群成员');
check(/function sessionAvatarUrl\(key\)/.test(html), '有 sessionAvatarUrl()：群用 p.qlogo.cn 徽标、私聊用 q1.qlogo.cn 头像');
check(html.includes("'https://p.qlogo.cn/gh/'") && html.includes("'https://q1.qlogo.cn/g?b=qq&nk='"), '头像走 QQ 官方图床（p.qlogo.cn 群徽标 / q1.qlogo.cn 用户头像）');
check(html.includes('.test(part.id)'), '头像 URL 前先校验 id 是纯数字（不把任意 key 拼进外链）');
check(html.includes("avatarHtml(sessionAvatarUrl(row.key), 'qdb-hit-ava')"), '会话列表每一行带头像');
check(/function memberRowHtml\(m\)/.test(html) && html.includes('data-member-search="'), '成员行有 memberRowHtml() 与可过滤的 data-member-search');
check(html.includes('id="sessMembers"') && html.includes('function membersPanelHtml'), '群成员面板独立成函数（#sessMembers 在右栏，不再塞进消息卡）');
check(/function msgAvatarHtml/.test(html), '消息行有头像渲染函数 msgAvatarHtml');
check(/\.qdb-msg-ava/.test(html), '消息头像样式存在（.qdb-msg-ava）');
check(/class="qdb-msg-uid"/.test(html), '每条消息昵称旁输出发言 ID（.qdb-msg-uid）');
check(/msgAvatarHtml\(uid\)/.test(html) || /memberAvatarUrl\(uid\)/.test(html), '头像按发言人 QQ 号取（memberAvatarUrl）');
check(/qdb-split qdb-split-3/.test(html), '会话页三栏布局（列表 | 消息 | 群成员右栏）');
check(html.includes('id="sessSide"') && /membersPanelHtml\(key\)/.test(html), '选中会话时把成员面板渲染进右栏 #sessSide');
check(/\.qdb-msg\.is-self/.test(html) || /qdb-msg' \+ \(isSelf/.test(html), '机器人自己的消息有 is-self 标记');
check(/function botSelfLabel\(\)[\s\S]{0,200}?return role \? '机器人（' \+ role \+ '）' : '机器人'/.test(js), '机器人自己的显示名：机器人（昵称），没有昵称就只写机器人');
check(js.includes('esc(isSelf ? botSelfLabel() : nameOfMember('), '自己的消息名不再走 nameOfMember（原来会显示「我」）');
check(/\+ \(!isSelf && m && m\.isOwner \? '<span class="qdb-badge" data-tone="write">管理员<\/span>'/.test(js), '「管理员」标签只在别人是群主时挂，不再套在机器人自己身上');
check(/api\('\/api\/status'\)\.catch\(function \(\) \{ return null; \}\)/.test(js) && /if \(pair\[3\] && pair\[3\]\.role\) state\.botRole/.test(js), '会话页顺带取 /api/status 拿人设昵称，失败不影响页面');
check(html.includes('/api/socialV2/group-members?key='), '群成员来自 GET /api/socialV2/group-members');
check(/function loadMembers\(seq, key\)/.test(html) && html.includes('loadMembers(seq, key)'), '切到群会话时自动拉成员');
check(html.includes("byId('sessMemberFilter')") && html.includes('renderMemberList(memberFilter.value)'), '成员过滤框接 input 事件');
check(html.includes('qdb-ava-fallback') && /addEventListener\('error'/.test(html), '头像图裂时换「？」占位（error 捕获）');
check(/function sessionDetailHtml\(key\)/.test(html), 'sessionDetailHtml(key) 按会话类型决定是否渲染成员面板');

// 这些断言刻意去读**实现细节**（正则、转义、条件分支），避免「字符串出现过就算过」的假断言。
check(html.includes("part.kind === 'group' && ") && html.includes('.test(part.id)'), '群头像 URL 只在 id 全数字时才拼（正则就在调用处）');
check(html.includes("part.kind === 'private' && ") && html.includes('.test(part.id)'), '私聊头像 URL 同样先过全数字校验');
check(html.includes("esc(hay)") || /data-member-search="' \+ esc\(hay\)/.test(html), '成员行的 data-member-search 走 esc()（昵称里的引号逃不出属性）');
check(/if \(part\.kind !== 'group'\)/.test(html) && html.includes('私聊没有群成员列表'), '私聊会话不渲染群成员面板（membersPanelHtml 走私聊分支）');
check(html.includes('<meta name="referrer" content="no-referrer">'), '页面有 no-referrer：外链头像不会把 ?token= 带出去');
check(html.includes('sessMembers.loading'), '成员面板区分「加载中」与「网关没返回」，不会边加载边误报');
check(html.includes("byId('sessMemberFilter')") && html.includes("renderMemberList(input ? input.value : '')"), '加载完成后按输入框当前值重绘（不抹掉用户已输入的过滤词）');
check(html.includes('已显示 ') && html.includes('numText(total)'), '成员计数同时给「已显示 / 全群人数」，不写「N 人（前 M）」');

// ── 10.4c 会话分类（全部 / 群聊 / 私聊）─────────────────────────────────────
console.log('## 会话分类');
check(html.includes('id="sessSeg"') && html.includes('data-sess-kind="all"'), '会话列表头有分段控件（全部/群聊/私聊）');
check(html.includes('data-sess-kind="group"') && html.includes('data-sess-kind="private"'), '群聊与私聊两个分类按钮都在');
check(/function setSessKind\(kind\)/.test(html) && /if \(kind !== 'all' && kind !== 'group' && kind !== 'private'\) return;/.test(html), 'setSessKind 只接受 all/group/private 三种值');
check(/function sessKindCount\(kind\)/.test(html), '按钮上的计数由 sessKindCount() 算（不是写死数字）');
check(/var sessRows = \[\];/.test(html) && /sessRows = rows;/.test(html), '列表行缓存到 sessRows：切分类只重画，不重新拉接口');
check(/sessionParts\(r\.key\)\.kind === sessKind/.test(html), '分类过滤按 sessionParts().kind 判定（group/private）');
check(html.includes('还没有群聊会话') && html.includes('还没有私聊会话'), '各分类有空态文案');
check(html.includes("btns[j].setAttribute('aria-pressed'") && html.includes("hits[i].getAttribute('data-session-key') === sessState.key"), '切分类后分类按钮与选中行的高亮都重新落一次');
check(/if \(!stillVisible && visible\.length\) selectSession\(visible\[0\]\.key\)/.test(html), '选中的会话不在新分类里时自动跳到该类第一条');
check(html.includes('id="sessCount"'), '会话列表头徽标有 id="sessCount"（徽标数字要能被刷新）');
check(/countEl\.textContent = sessKind === 'all'/.test(html) && /' \/ 共 ' \+ numText\(sessRows\.length\)/.test(html), '徽标跟随分类：全部显示总数，分类显示「N / 共 M 个」');

// ── 10.5 页面版块（T29 只读 → T31 部分可写）：每个页签都真的接上了接口 ────────
console.log('## 页面版块（T29 / T31）');
const WRITABLE_PAGES = new Set(['sessions', 'persona', 'memory', 'slang', 'stickers', 'ops', 'library']);
const READONLY_PAGES = {
  sessions: { loaders: ['pageSessions'], apis: ['/api/sessions', '/api/socialV2/states', '/api/socialV2/recent'], empty: '还没有会话' },
  stickers: { loaders: ['pageStickers'], apis: ['/api/stickers', '/api/stickers/thumbnail'], empty: '表情库是空的' },
  library: { loaders: ['pageLibrary'], apis: ['/api/files/stats', '/api/files/lists'], empty: '文件库还是空的' },
  persona: { loaders: ['pagePersona'], apis: ['/api/roles', '/api/roles/content'], empty: '还没有角色卡' },
  memory: { loaders: ['pageMemory'], apis: ['/api/socialV2/memory'], empty: '还没有会话状态' },
  slang: { loaders: ['pageSlang'], apis: ['/api/slang'], empty: '黑话库是空的' },
  ops: { loaders: ['pageOps'], apis: ['/api/ops/services', '/api/ops/status', '/api/self-check/last'], empty: '还没有自检结果' },
};
for (const [view, spec] of Object.entries(READONLY_PAGES)) {
  const fn = spec.loaders[0];
  check(new RegExp(`function ${fn}\\(view, host\\)`).test(html), `${view} 页有渲染函数 ${fn}()`);
  check(html.includes(`${view}: ${fn}`), `${view} 页登记进 PAGE_LOADERS`);
  check(html.includes(`id="page-${view}"`), `${view} 页有挂载容器 #page-${view}`);
  check(html.includes(`data-page-refresh="${view}"`), `${view} 页有刷新按钮`);
  for (const apiPath of spec.apis) {
    check(html.includes(apiPath), `${view} 页调 ${apiPath}`);
  }
  check(html.includes(spec.empty), `${view} 页有空态文案「${spec.empty}」`);
  const section = (html.match(new RegExp(`<section data-page="${view}"[\\s\\S]*?</section>`)) ?? [''])[0];
  if (WRITABLE_PAGES.has(view)) {
    check(/class="qdb-badge" data-tone="write">可操作/.test(section), `${view} 页标「可操作」（二期已开写）`);
  } else {
    check(/class="qdb-badge">只读/.test(section), `${view} 页仍是「只读」标识`);
  }
  check(/qdb-page-sub/.test(section), `${view} 页写明数据来源（副标题）`);
}
check((html.match(/class="qdb-badge">只读/g) ?? []).length === 0, '没有页面还挂「只读」徽标（文件库二期已开写）');
check((html.match(/data-tone="write">可操作/g) ?? []).length === 12, '十二页挂「可操作」徽标（含运维页、设置页、AI 黑名单、模型与高峰、隐藏的工具开关页、转存与存储、黑话库；找号页已删）');

// ── 10.55 黑话库（936 条真数据：分页 + 批量筛选 + 证据折叠）────────────────────
// 这一节盯的是「大数据量下的界面纪律」：不能把 500+ 张卡一次塞进 DOM、勾选不能只靠 DOM、
// 每个写动作都得对上后端真实路由，且会话一律走 sessionLabelOf（不出现裸 group:/private:）。
console.log('## 黑话库');
check(/function pageSlang\(view, host\)/.test(html) && html.includes('slang: pageSlang'), '黑话页渲染函数 pageSlang() 登记进 PAGE_LOADERS');
check(html.includes("slang: '黑话库'"), '黑话页标题登记进 PAGE_TITLES');
check(/var SLANG_TABS = \['preselect', 'candidate', 'confirmed', 'rejected'\]/.test(html), '四个 tab：预选 + 三个后端状态');
check(/var preselectState = \{ entries: \[\], counts: \{ ready: 0, review: 0, weak: 0, candidates: 0 \}/.test(js), '预选清单有自己的状态（可批准/需细看/弱信号计数）');
check(/api\('\/api\/slang\/preselect'\)/.test(js), '预选走 GET /api/slang/preselect');
check(/slangState\.tab === 'preselect'[\s\S]{0,40}?preselectState\.entries/.test(js), '预选 tab 用后端清单，其它 tab 仍按状态过滤');
check(/function slangPreselectChips\(entry\)/.test(js) && /cdChip\('ok', '可批准'\)/.test(js) && /cdChip\('warn', '需细看'\)/.test(js), '行上标出「可批准 / 需细看」与理由');
check(/可直接批准 ' \+ numText\(pc\.ready/.test(js) && /弱信号 ' \+ numText\(pc\.weak/.test(js), '列表头说清可直接批多少、需细看多少、弱信号多少');
check(/@media \(min-width: 1024px\)[\s\S]{0,80}?\.slang-row \{ display: grid; grid-template-columns: minmax\(0, 1fr\) 176px/.test(css), '宽屏下每行「内容 + 右侧动作列」，右侧不再空白');
check(/\.slang-fields dd \{[^}]*max-width: 74ch/.test(css), '词条字段宽度从 470px 放到 74ch');
check(/if \(counts\[e\.status\] !== undefined\) counts\[e\.status\] \+= 1;/.test(html), 'tab 计数由数据现算（slangCounts 扫 status，不写死 435/501）');
check(/var SLANG_PAGE_SIZES = \[50, 100, 0\]/.test(html) && /id="slangPageSize"/.test(html) && /pageSize: 50/.test(html),
  '每页条数下拉 50 / 100 / 全部，默认 50（936 条不能一次进 DOM）');
check(/slangState\.selected\[String\(entry\.id\)\] = true/.test(html) && /function slangSelectedIds\(\)/.test(html) && /Object\.keys\(slangState\.selected\)/.test(html),
  '勾选用 id 集合（不读 DOM checkbox），翻页 / 重绘后仍在');
check(/显示 ' \+ numText\(v\.pageRows\.length\)/.test(html) && /搜索后 ' \+ numText\(v\.total\)/.test(html),
  '列表头写「显示 X / Y 条」，搜索时带「（搜索后 Z 条）」');
check((html.match(/slangState\.page = 1;/g) ?? []).length >= 3, '切 tab / 改搜索词 / 改每页条数都回到第一页',
  `${(html.match(/slangState\.page = 1;/g) ?? []).length} 处`);
check(/data-slang-page="/.test(html) && /data-slang-tab="/.test(html) && /data-slang-check="/.test(html),
  'tab / 页码 / 勾选都走事件委托（列表会整块重绘）');
check(/SLANG_EVIDENCE_LIMIT = 5/.test(html) && /<details class="slang-evidence">/.test(html) && /还有 ' \+ numText\(rest\) \+ ' 条没列/.test(html),
  '证据默认折叠（<details>），一次最多列 5 条，其余写「还有 N 条」');
check(/<div class="slang-scroll">/.test(js) && /max-height: clamp\(300px, calc\(100vh - 580px\), 620px\); overflow-y: auto/.test(css), '词条列表自己在容器里滚（高度跟视口走），不再靠翻页硬翻');
check(/qdb-slang-sticky/.test(js) && /#slangBar \{ position: sticky/.test(css), '批量确认/拒绝那条 bar 吸顶（sticky 挂在 #slangBar 层才不会被父盒带走）');
check(/scroller \+ slangPagerHtml\(v\)/.test(js) && /<\/div>' \+ paged/.test(js), '翻页条留在滚动容器外，始终可见');
const slangSection = (html.match(/<section data-page="slang"[\s\S]*?<\/section>/) ?? [''])[0];
check(/sessionLabelOf\(ev\.key\)/.test(html) && !/(group:|private:)\d/.test(slangSection), '证据里的会话一律 sessionLabelOf(key)，黑话页区块不出现裸 group: / private:');
check(/function slangSettingsHtml\(\)/.test(html) && /学习设置暂为只读，要改说一声/.test(html), '学习设置整块只读 + 文案「学习设置暂为只读，要改说一声」');
for (const key of ['enabled', 'injectMax', 'extractMinMessages', 'inferenceThresholds', 'autoResearch', 'autoConfirmWeb']) {
  check(new RegExp(`\\['${key}'`).test(html), `学习设置展示后端字段 ${key}`);
}
check(/slangState\.writable \? '' : ' disabled'/.test(html), 'writable=false 时所有写按钮统一禁用（只读降级）');
const SLANG_WRITES = ['slang-new', 'slang-edit', 'slang-confirm', 'slang-reject', 'slang-restore', 'slang-delete',
  'slang-policy-usable', 'slang-policy-understand', 'slang-batch-confirm', 'slang-batch-reject',
  'slang-batch-delete', 'slang-batch-research', 'slang-clear'];
check(SLANG_WRITES.every((name) => html.includes(`'${name}': function`)), '13 个黑话写动作都登记在 WRITE_ACTIONS', `${SLANG_WRITES.length} 个`);
for (const apiPath of ['/api/slang', '/api/slang/policy', '/api/slang/clear', '/api/slang/batch-confirm',
  '/api/slang/batch-reject', '/api/slang/batch-delete', '/api/slang/research']) {
  check(routeCovers(apiPath), `黑话页调用的 ${apiPath} 在后端路由表里真实存在`);
}
check(/apiWrite\(slangApiPath\(entry\.id\) \+ '\/confirm'/.test(html), '单条确认 POST /api/slang/:id/confirm');
check(/apiVerb\('PATCH', slangApiPath\(entry\.id\)/.test(html), '编辑 / 改回候选走 PATCH /api/slang/:id');
check(/apiVerb\('DELETE', slangApiPath\(entry\.id\)/.test(html), '删除走 DELETE /api/slang/:id');
check(/apiWrite\('\/api\/slang\/batch-confirm', \{ ids: ids \}\)/.test(html), '批量确认提交 {ids}（后端要求非空数组）');
check(/apiWrite\('\/api\/slang\/clear', \{ status: slangState\.tab \}\)/.test(html), '清空按当前 tab 传 {status}');
check(/skippedCount/.test(html) && /缺含义被跳过/.test(html), '批量确认把「缺含义被跳过」的条数说出来（后端会 skip 而不是静默失败）');
check(/function pageFail\(view, error\)/.test(html) && /data-page-retry="' \+ esc\(view\) \+ '"/.test(html), '失败态统一走 pageFail 并带重试按钮');
check(/令牌无效或已过期：到「设置」页粘贴控制台令牌/.test(html), '401 给出「令牌无效/已过期 + 去哪粘贴」的指引');
check(/function pageLoad\(view, force\)/.test(html) && /PAGE_LOADERS\[view\]\) pageLoad\(view, false\)/.test(html), '切页时才加载（showView 里触发）');
check(/data-page-retry,|\[data-page-retry\],\[data-page-refresh\]/.test(html), '重试/刷新走事件委托（重绘后不用重绑）');
check(/function pageSkeletonHtml\(\)/.test(html) && /加载中…/.test(html), '每页都有加载态');
// 二期只开「运维级小写操作」：发消息/发图仍然越界（AI 不能借控制台代发消息）。
// 文件清理/分类已从这条黑名单移出：改由 §10.9 正面断言（先预览 → 二次确认 → 才真删、只走 apiWrite）。
// 角色新建与改正文（T33）同理，改由 §10.7 正面断言。
for (const writePath of ['/api/send/', '/api/socialV2/send-message', '/api/socialV2/send-burst', '/api/socialV2/send-image']) {
  check(!html.includes(writePath), `仍然没有引用越界写接口 ${writePath}`);
}
// POST 从「一律禁止」变成「只许出现在唯一出口 apiWrite() 里」：逐处核对见 10.6。
check(/\/api\/stickers\/thumbnail\?id='/.test(html) && /tokenQuery\(\)/.test(html), '表情缩略图带鉴权参数（img 不能带自定义头）');
check(/loading="lazy"/.test(html), '缩略图懒加载（几十张一次拉会把 3100 压住）');
check(/thumbStatus === 'missing'/.test(html) && /qdb-thumb-missing/.test(html), '已知失效的缩略图直接占位，不白发请求');
check(/function selectSession\(key\)/.test(html) && /function selectRole\(name\)/.test(html), '会话/人设支持点选后加载详情');
check(/function loadMemory\(key\)/.test(html), '记忆页按会话 key 取数据');

// ── 10.6 二期写操作（T31）：唯一写出口 + 真实后端契约 + 二次确认 ─────────────
// 这一节的断言重点不是「有没有 POST」，而是「POST 只从 apiWrite 出去」和「body 字段
// 跟 src/bridge/console/*.js 真正读的字段一致」——字段写错在真机上就是 400，静态能拦住。
console.log('## 写操作（T31）');
const postCalls = [...html.matchAll(/method:\s*['"]POST['"]/g)];
check(postCalls.length === 1, '全页只有一个 method: POST（就在唯一写入口里）', `${postCalls.length} 处`);
const apiWriteBlock = (html.match(/function apiWrite\(path, body\) \{[\s\S]*?\n  \}/) ?? [''])[0];
check(apiWriteBlock.length > 0, 'apiWrite(path, body) 存在且可被抽取');
check(/method: 'POST'/.test(apiWriteBlock), 'POST 收敛在 apiWrite() 内部');
check(/'content-type': 'application\/json'/.test(apiWriteBlock), '写请求带 content-type: application/json（缺了会被 415 拦）');
check(/headers\['x-console-token'\] = state\.token/.test(apiWriteBlock), '写请求同样带 x-console-token');
check(/cache: 'no-store'/.test(apiWriteBlock), '写请求也不读缓存');
check(/JSON\.stringify\(body \|\| \{\}\)/.test(apiWriteBlock), 'body 统一序列化成 JSON');
check(/data\.ok === false/.test(apiWriteBlock), '写接口返回 ok=false 也按失败处理');
check(/err\.status = res\.status/.test(apiWriteBlock), '状态码挂在 error 上（401 才能单独给指引）');

const WRITE_PATHS = ['/api/session/reset', '/api/role', '/api/roles/rename', '/api/roles/delete',
  '/api/roles/update', '/api/roles/create',
  '/api/socialV2/memory-remove', '/api/socialV2/memory-clear',
  '/api/stickers/remove', '/api/stickers/note', '/api/stickers/policy', '/api/stickers/sync', '/api/stickers/repair',
  '/api/config', '/api/ops/action', '/api/self-check',
  '/api/files/cleanup', '/api/files/category'];
for (const apiPath of WRITE_PATHS) check(apiPaths.includes(apiPath), `写接口 ${apiPath} 出现在页面里`);

check(/apiWrite\('\/api\/role', \{ role: name \}\)/.test(html), '切换角色 POST /api/role {role}');
check(/apiWrite\('\/api\/roles\/rename', \{ from: from, to: to \}\)/.test(html), '改名 POST /api/roles/rename {from,to}');
check(/apiWrite\('\/api\/roles\/delete', \{ name: name \}\)/.test(html), '删除角色按真实后端 POST /api/roles/delete {name}（不是 {role}）');
check(/apiWrite\('\/api\/session\/reset', \{ key: key \}\)/.test(html), '重置会话 POST /api/session/reset {key}');
check(/if \(category === 'memberImpression'\) body\.target = target; else body\.content = content;/.test(html),
  'memory-remove：印象用 target、其余用 content（后端按逐字相等删）');
check(/apiWrite\('\/api\/socialV2\/memory-clear', body\)/.test(html), '清空记忆 POST /api/socialV2/memory-clear');
check(/apiWrite\('\/api\/stickers\/remove', \{ id: id \}\)/.test(html), '删除表情 POST /api/stickers/remove {id}');
check(/apiWrite\('\/api\/stickers\/note', \{ stickerId: id, note:/.test(html), '表情备注字段是 stickerId（不是 id）');
check(/apiWrite\('\/api\/stickers\/policy', \{ id: id, policy: next \}\)/.test(html), '策略 POST /api/stickers/policy {id,policy}');
// 策略按钮用 data-next 明写目标值（不靠 toggle），当前那侧高亮且禁用，避免连点翻来翻去。
check(/data-next="usable"/.test(html) && /data-next="understand-only"/.test(html), '「可用 / 不可用」两个按钮各自带 data-next');
check(/var next = btn\.getAttribute\('data-next'\)/.test(html), '策略写值取 data-next（不是取反）');
check(/\.qdb-thumb-seg > \.qdb-btn\.is-on/.test(html) && /is-on' : ''\)?/.test(html) === false || /is-on/.test(html), '当前状态那侧有高亮样式');
// 排序：下拉 5 个口径 + 请求带 sort + 换排序回第 1 页
check(/id="stickerSort"/.test(html), '表情库有排序下拉');
['new', 'old', 'usable', 'understand', 'used'].forEach(function (v) {
  check(new RegExp('<option value="' + v + '"').test(html), '排序选项 ' + v);
});
check(/'&sort=' \+ encodeURIComponent\(stickerState\.sort\)/.test(html), '列表请求带 sort 参数');
check(/stickerState\.sort = String\(sortSel\.value \|\| 'new'\);\s*stickerState\.page = 0/.test(html), '换排序回到第 1 页');
// 删除必须过一次确认弹窗（用户明确要求「点删除先弹确认」）
check(/openDialog\(\{\s*title: '删除收藏表情'/.test(html) && /confirmLabel: '删除',\s*danger: true/.test(html),
  '删除表情先弹确认弹窗（红色 danger）');
check(/apiWrite\('\/api\/stickers\/sync', \{\}\)/.test(html), '同步 POST /api/stickers/sync 空 body');
check(/apiWrite\('\/api\/stickers\/repair', \{ apply: false \}\)/.test(html) && /apiWrite\('\/api\/stickers\/repair', \{ apply: true \}\)/.test(html),
  '修复先 apply:false 预演，确认后才 apply:true');
check(/apiWrite\('\/api\/config', \{ patch: patch \}\)/.test(html), '写配置 POST /api/config {patch}');

const WRITE_ACTIONS = ['session-reset', 'role-switch', 'role-rename', 'role-delete',
  'role-edit', 'role-save', 'role-cancel', 'role-template', 'role-create',
  'memory-remove', 'memory-clear',
  'sticker-note', 'sticker-policy', 'sticker-remove', 'stickers-sync', 'stickers-repair', 'config-save', 'token-save',
  'ops-service-action',
  'files-preview', 'files-preview-clear', 'files-clean', 'files-category', 'files-dismiss-error'];
check(/var WRITE_ACTIONS = \{/.test(html), '写动作收敛到 WRITE_ACTIONS 表');
for (const action of WRITE_ACTIONS) {
  check(new RegExp(`'${action}': function \\(btn\\)`).test(html), `WRITE_ACTIONS 里有 ${action}`);
  check(html.includes(`data-write="${action}"`), `有按钮挂 data-write="${action}"`);
}
check(/\[data-write\]/.test(html) && /WRITE_ACTIONS\[target\.getAttribute\('data-write'\)\]/.test(html), '写按钮走 document 级 data-write 委托（重绘后不用重绑）');
check(/if \(!target \|\| target\.disabled\) return;/.test(html), 'disabled 的写按钮点击被跳过（没选中/存储不可写时不放行）');
check(/function runWrite\(btn, work\)/.test(html), '写操作有公共外壳 runWrite（防连点 + 失败提示）');
check(/操作失败：/.test(html), '写失败给出「操作失败：原因」的 toast');

check(/function openDialog\(opts\)/.test(html), '二次确认弹层 openDialog(opts)（不用阻塞式 confirm）');
check(/data-dialog-ok/.test(html) && /data-dialog-cancel/.test(html), '弹层有确认与取消按钮');
check(/ev\.key === 'Escape'[\s\S]{0,40}close\(null\)/.test(html), '弹层可 Esc 取消');
check(/清掉在途回合与会话表/.test(html), '会话重置的确认文案点明「清掉在途回合与会话表」');
const undoCount = (html.match(/不可撤销/g) ?? []).length;
check(undoCount >= 6, '删除/清空/重置类确认都写明「不可撤销」', `${undoCount} 处`);

check(/function setStickerWritable\(writable\)/.test(html) && /data\.writable === false/.test(html), '表情页按 writable 置灰写按钮');
check(/stickerStoreWritable=false/.test(html), '不可写时解释清楚为什么按钮是灰的');

check(/function pageSettings\(view, host\)/.test(html) && html.includes('settings: pageSettings'), '设置页有渲染函数并登记进 PAGE_LOADERS');
check(html.includes('id="page-settings"') && html.includes('data-page-refresh="settings"'), '设置页有容器与刷新按钮');
check(/api\('\/api\/config'\)/.test(html), '设置页 GET /api/config');
check(/restartRequired/.test(html) && /hotReloaded/.test(html), '读 restartRequired / hotReloaded 并如实展示');
check(html.includes('需重启桥接才生效'), 'restartRequired 时显式提示「需重启桥接才生效」');
// C 档后端已合入（config-admin.js）：whitelist 与 restartRequired 都是「点号路径字符串数组」，
// data 只含可编辑子树、故意不回显 allow.*；下面几条防的就是「又按老假设写回去」。
check(/pathList\(data && data\.whitelist\)/.test(html) && /pathList\(data && data\.restartRequired\)/.test(html),
  'whitelist / restartRequired 都按「点号路径数组」解析（pathList）');
check(!/whitelist\.groups/.test(html) && !/whitelist\.private/.test(html),
  '不再把 whitelist 当 {groups,private} 对象（后端回的是路径数组）');
check(!/restartRequired === true/.test(html),
  '重启判定不再写 restartRequired === true（GET 回路径数组、POST 回布尔）');
check(/api\('\/api\/whitelist'\)/.test(html), '群/私聊白名单另调只读 GET /api/whitelist 展示');
check(html.includes('此项不在设置页可改'), '白名单面板标注「此项不在设置页可改」（/api/config 不回显 allow）');
check(/Array\.isArray\(data && data\.changed\)/.test(html), '写入结果按 changed 数组计数（不是把数组直接当数字用）');
check(html.includes('roles.js:175'), '删除角色处注明后端 roles.js:175 读的是 name（别再改回 role）');
check(/try \{ patch = JSON\.parse\(text\);? \}/.test(html) && /patch 必须是/.test(html), 'patch 先本地解析：畸形 JSON 不发请求');
check(html.includes('id="cfgPatch"') && html.includes('id="cfgToken"'), '设置页有 patch 输入框与令牌输入框（401 时能就地换令牌）');

// ── 10.7 仪表盘卡片详情 / 会话翻页看图 / 表情搜索分页 / AI 黑名单 ─────────────
// 这一组钉的是「摘要之外还能不能看到全貌」：卡片弹层读缓存（不重发请求）、会话往更早翻、
// 图片能点开、表情能搜能翻、黑名单四个写动作齐全。数字/文案都按实现里的真实字符串钉，
// 免得以后改文案时测试照样绿。
console.log('## 卡片详情 / 会话 / 表情 / 黑名单');
const CARD_IDS = ['status', 'services', 'selfcheck', 'tokens', 'sessions', 'lists'];
check(CARD_IDS.every((id) => html.includes(`id="card-${id}" tabindex="0" role="button"`)), '六张卡整张可点（tabindex+role=button）');
check((html.match(/<span class="qdb-card-more">详情 ›<\/span>/g) ?? []).length === 9, '九张卡（含两张上游卡与文件库卡）右上角都有「详情 ›」提示');
check(/\.qdb-card\[role="button"\]:hover \{[^}]*transform: translateY\(-2px\)/.test(html) && /\.qdb-card\[role="button"\]:focus-visible/.test(html), '卡片 hover 有抬升、键盘有焦点环');
check(/document\.addEventListener\('click', function \(ev\) \{[\s\S]{0,400}cardIdOf\(node\)/.test(html) && /ev\.key !== 'Enter' && ev\.key !== ' ' && ev\.key !== 'Spacebar'/.test(html) && /ev\.preventDefault\(\);\s*\n\s*activateCard\(id, ''\)/.test(html), '点卡片与回车/空格都能用（上游卡开面板、其余开详情）');
check(/function openCardDetail\(id\) \{[\s\S]{0,600}var data = cardData\[id\];/.test(html), '详情读 cardData 缓存（不重新请求接口）');
check(/cardData\[spec\.id\] = data;/.test(html) && /var cardData = \{\};/.test(html), '缓存写在 loadCard 里（每张卡的原始返回）');
check(/id: 'wb2api', path: '\/api\/ops\/services', title: 'WorkBuddy2API', pick: 'wb2api'/.test(js) && /id: 'snowluma', path: '\/api\/ops\/services', title: 'SnowLuma', pick: 'snowluma'/.test(js), '两张上游卡吃同一份 /api/ops/services，按 pick 挑自己那条');
check(/if \(spec\.pick\) \{[\s\S]{0,300}setEmpty\(spec, '运维接口没返回 ' \+ spec\.pick/.test(js), 'pick 找不到就显示空态，不当成正常');
check(/function renderUpstreamCard\(item\)/.test(js) && /data-tone="' \+ \(ok \? 'ok' : 'err'\)/.test(js), '上游卡按 ok 出「在线/不可用」大字并带 tone');
check(/if \(spec && spec\.openUi && item && item\.ui && !detailHref\) \{/.test(js) && /window\.open\(String\(item\.ui\), '_blank', 'noopener'\)/.test(js), '上游卡整卡点击开自己的界面，点「详情 ›」仍开弹层');
check(/wb2api: \{ view: 'ops', viewLabel: '运维', render: detailUpstream \}/.test(js) && /snowluma: \{ view: 'ops', viewLabel: '运维', render: detailUpstream \}/.test(js), '两张上游卡的详情也接上了（跳运维页）');
check(/ui: up\.ui\.snowluma, uiLabel: "打开 SnowLuma 面板"/.test(operations) && /ui: up\.ui\.wb2api, uiLabel: "打开 WorkBuddy2API 面板"/.test(operations), '后端 /api/ops/services 给两条上游带上了面板地址');
check(/account = \{ nickname: login\?\.nickname \?\? null, userId: login\?\.user_id \?\? null \}/.test(operations) && /models = \(JSON\.parse\(wbText\)\?\.data \?\? \[\]\)\.map/.test(operations), '后端把 SnowLuma 登录账号与 wb2api 模型清单一起返回');
// tokens 卡现在跳「用量与花费」（旧页下线前是「模型与高峰」）
const CARD_JUMPS = ["status: { view: 'settings'", "services: { view: 'ops'", "selfcheck: { view: 'ops'", "tokens: { view: 'usage'", "sessions: { view: 'sessions'", "lists: { view: 'lists'"];
check(CARD_JUMPS.every((item) => html.includes(item)), '每张卡都有「跳到相关页面」映射且指向正确视图');
check(/JSON\.stringify\(data, null, 2\)/.test(html) && /function detailRowsHtml\(data\)/.test(html), '详情里既有键值表也有原始 JSON');
// 会话：展示层把 group:123 翻成「群 123」，但 data-session-key 与请求仍是原始 key。
check(/if \(kind === 'group'\) return \{ kind: 'group', label: '群', id: id, key: raw \};/.test(html) && /if \(kind === 'private'\) return \{ kind: 'private', label: '私聊', id: id, key: raw \};/.test(html), '会话 key 拆成「群/私聊 + 数字」');
check(/esc\(part\.label\) \+ ' <span class="qdb-sess-qq">' \+ esc\(part\.id\)/.test(html) && /data-session-key="' \+ esc\(row\.key\) \+ '"/.test(html), '左侧列表显示「群 123」但属性仍是原始 key');
check(/sessionHeadHtml\(key, '最近 ' \+ numText\(messages\.length\) \+ ' 条'\)/.test(html) && !/' · 最近 '/.test(html), '右侧详情标题也换成「群 123 · 最近 N 条」');
check(/\.qdb-msg-list \{ max-height: 46vh; overflow-y: auto;/.test(html), '消息区是独立滚动容器（46vh）');
check(/&limit=' \+ RECENT_LIMIT \+ '&offset=' \+ offset/.test(html) && /sessState\.offset = offset \+ messages\.length;/.test(html), '往更早翻页仍按 offset 取并累加偏移');
// 会话详情仍然没有「加载更多」按钮（滚到顶自动往前取）；「加载更多」这个词现在只属于文件库素材分页，下面单独断言。
check(/sessState\.hasMore = messages\.length >= RECENT_LIMIT;/.test(html) && !/id="sessMore"/.test(html), '去掉会话详情的「加载更多」按钮：有没有更早的由 hasMore 记录');
check(/function loadOlderSession\(seq\)/.test(html) && /if \(msgs\.scrollTop < 900\) \{ loadOlderSession\(seq\); return; \}/.test(html),
  '离顶还有半页（900px）就先取更早的一页，别等滚到顶才发请求');
check(/var userScrollAt = 0;/.test(html) && /function noteUserScroll\(\)/.test(html)
  && /\['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown'\]\.forEach/.test(html)
  && /msgs\.addEventListener\(name, noteUserScroll, \{ passive: true \}\)/.test(html),
  '用户一动滚轮/手指就撤销锚点钉住，别和用户抢滚动方向');
check(/var until = Date\.now\(\) \+ 1200;/.test(html) && /Date\.now\(\) - userScrollAt > 120/.test(html),
  '锚点钉住只在用户没动过的间隙里纠正，且 1.2 秒后自己停');
check(/lastTopNoticeAt/.test(html) && /已经翻到头了：这个会话能看到的更早消息就这些/.test(html),
  '翻到头时明确提示「没有更早的了」，别让人以为是卡住');
check(/var SESS_LIVE_MS = 5000;/.test(html) && /function pollSessNew\(seq\)/.test(html) && /startSessLive\(seq\);/.test(html), '会话页每 5 秒自动补新消息');
check(/sessState\.pending = \(sessState\.pending \|\| \[\]\)\.concat\(added\)/.test(html) && /function paintNewPill\(\)/.test(html), '新消息先挂进 pending，只有贴底才直接补上');
check(/if \(sessState\.scrolledUp\) paintNewPill\(\);/.test(html) && /else appendPendingMessages\(\);/.test(html),
  '只有用户自己往上翻才亮浮标；贴底/刚打开/不满一屏都直接补进来（不再叠「离底部够远」的条件）');
check(/\(sessState\.pending \|\| \[\]\)\.forEach\(function \(m\) \{ known\[messageIdentity\(m\)\] = true; \}\);/.test(html),
  'pending 里等着补的也算已知，别把同一条数成两条新消息');
check(/sessState\.scrolledUp = gap > 80;/.test(html) && /if \(sessState\.scrolledUp\) return;/.test(html)
  && /if \(\(sessState\.pending \|\| \[\]\)\.length\) appendPendingMessages\(\);/.test(html),
  '滚动时记「是否在看历史」，滑回底部把待补的消息补进来（不看浮标还亮不亮）');
check(/var n = \(sessState\.pending \|\| \[\]\)\.length;/.test(html) && /if \(!n\) \{ pill\.hidden = true; return; \}/.test(html),
  '浮标只在「还有没翻到的新消息」时显示，pending 一空就收起');
check(!/PILL_LINGER_MS|pillTimer/.test(html),
  '不再用定时器自己收：翻回底部补进列表才消失（没有没看过的消息就不该挂着）');
check(/\[hidden\] \{ display: none !important; \}/.test(html),
  '全局兜住 [hidden]：组件自己写了 display，浏览器默认的 [hidden] 会被盖掉');
// ── 会话：引用跳转与上翻位置稳定（2026-10-29 三个实机 bug）────────────────
check(/function findQuotedTarget\(mid, text, nodeSrc, skip\)/.test(html) && /if \(all\[k\] === own\) continue;/.test(html),
  '引用跳转要排除「正在引用的那条消息」，否则点下去原地 TP');
check(/if \(img\.closest && img\.closest\('\.qdb-quote'\)\) continue;/.test(html),
  '同名图片是引用卡片里的缩略图，不算目标（否则永远命中当前这条）');
check(/var own = node\.closest \? node\.closest\('\.qdb-msg'\) : null;/.test(html) && /findQuotedTarget\(mid, text, src, own\)/.test(html),
  'jumpToQuoted 把当前消息作为 skip 传进去');
check(/var QUOTE_JUMP_MAX_PAGES = 12;/.test(html) && /if \(sessState\.loadingOlder\) \{/.test(html)
  && /waitTried > 40/.test(html),
  '引用跳转最多往上翻 12 页，且等正在飞的那页回来再判断（别当成到头了就放弃）');
check(/function scrollMsgIntoList\(node, msgs\)/.test(html) && /msgs\.scrollTo\(\{ top: target, behavior: 'smooth' \}\)/.test(html)
  && !/\.scrollIntoView\(\{ block: 'center'/.test(html),
  '跳转只滚消息列表，不用 scrollIntoView 把整页一起滚（否则面板底边空出一层）');
check(/function listAnchor\(msgs\)/.test(html) && /function pinAnchor\(msgs, anchor\)/.test(html)
  && /var anchorPinToken = 0;/.test(html) && /function cancelAnchorPin\(\)/.test(html),
  '翻更早一页时钉住阅读位置，且这个 rAF 循环能被跳转取消（不然会被拽回锚点）');
check(/quoteJump: false/.test(html) && /if \(sessState\.quoteJump\) return;/.test(html)
  && /if \(sessState\.quoteJump\) return; \/\/ 跳转优先，别钉住旧位置/.test(html),
  '引用跳转期间不自动翻页、不钉锚点（否则跳一半被拽回去）');
check(/var releaseJump = function \(\)/.test(html) && /releaseJump\(\);/.test(html),
  '跳转结束（找到/没找到）后放掉 quoteJump 标记');
check((html.match(/rendered: \[\], scrolledUp: false/g) ?? []).length >= 2,
  '切会话时把「在看历史」标记一起清掉');
check(/id="sessNewPill"/.test(html) && /条新消息 ↓/.test(html) && /\.qdb-msg-newpill \{/.test(html), '「N 条新消息 ↓」浮标（点一下跳到最新）');
check(/if \(view === 'sessions'\) \{ if \(sessState\.key\) startSessLive\(sessSeq\); \}/.test(html) && /else stopSessLive\(\);/.test(html), '切走会话页就停掉实时刷新');
check(/if \(document\.hidden\) \{ stopPolling\(\); stopSessLive\(\); return; \}/.test(html), '页面不可见时连会话轮询一起停');
check(/if \(offset > 0\) \{ toast\('更早的消息没取到：'/.test(html), '取更早失败时不清空已渲染的消息');
check(/var src = mediaSourceFor\(item\);/.test(html) && /loading="lazy"/.test(html) && /class="qdb-msg-img-missing"/.test(html), 'media 里的图片渲染懒加载缩略图、坏图给占位');
check(/\.qdb-msg-img \{[^}]*max-width: min\(180px, 100%\)/.test(html) && /openImageView\(img\.getAttribute\('data-zoom'\)\)/.test(html), '缩略图限宽圆角、点击放大');
check(/apiWrite\('\/api\/socialV2\/recall', \{ key: sessState\.key, query: query, limit: 12 \}\)/.test(html) && /归档检索已关闭/.test(html), '「查历史」走 recall，403 提示归档检索已关闭');
check(/var seq = \+\+sessSeq;/.test(html) && (html.match(/if \(seq !== sessSeq\) return;/g) ?? []).length >= 3, 'sessionSeq 挡住上一个会话还在飞的响应');
// 表情：翻页交给后端 offset（单次只取一页），搜索也打给后端，重绘后仍要重新置灰。
// 每页条数必须 = 列数 × 行数，否则最后一行铺不满（60 条 / 9 列会剩 6 张，右边空一片）。
check(/var STICKER_ROWS = 6;/.test(html) && /function stickerPageSizeFor\(cols\)/.test(html)
  && /count=' \+ count \+ '&offset=' \+ offset/.test(html) && /function stickerListUrl\(count, offset\)/.test(html),
  '表情每页条数 = 列数 × 行数，按 offset 取当页（列表地址统一走 stickerListUrl）');
check(/var STICKER_ITEM_MIN = 132;/.test(html) && /minmax\(132px, 1fr\)/.test(html)
  && /function stickerColsFor\(width\)/.test(html), '列数由网格宽度反算，minmax 数值与 CSS 同一份');
check(/function stickerCalibrate\(\)/.test(html) && /window\.addEventListener\('resize', stickerCalibrateLater\)/.test(html)
  && /if \(currentView\(\) !== 'stickers'\) return;/.test(html), '渲染后按真实宽度校准列数，缩放只在表情页生效');
check(/placeholder="按备注 \/ 标签 \/ 释义找"/.test(html) && /function applyStickerSearch\(value\)/.test(html), '表情搜索框与搜索动作都在');
check(/'共 ' \+ numText\(stickerState\.matched\) \+ ' 条'/.test(html) && /data-sticker-page="prev"/.test(html) && /data-sticker-page="next"/.test(html), '分页条有「共 X 条 · 第 N 页」与上一页/下一页');
check(/renderStickerPager\(\);[\s\S]{0,420}setStickerWritable\(stickerState\.writable\);/.test(html), '翻页重绘后回到面板顶部并重新调用 setStickerWritable');
// 改备注 / 切策略 / 删一张都属于「单张卡的小改动」：整页重取会闪一下、还会把滚动位置顶回面板顶部。
const stickerWriteBlock = (name) => {
  const start = html.indexOf("'" + name + "': function");
  const end = html.indexOf("'sticker-", start + 1);
  return start < 0 ? '' : html.slice(start, end < 0 ? start + 1200 : end);
};
const noteBlock = stickerWriteBlock('sticker-note');
const policyBlock = stickerWriteBlock('sticker-policy');
const removeBlock = stickerWriteBlock('sticker-remove');
check(noteBlock.length > 0 && !/pageLoad\('stickers'/.test(noteBlock) && /stickerRepaintCard\(id, \{ localNote: note \}\)/.test(noteBlock),
  '改备注只就地重画这张卡，不再整页重取');
check(policyBlock.length > 0 && !/pageLoad\('stickers'/.test(policyBlock) && /stickerRepaintCard\(id, \{ policy: next \}\)/.test(policyBlock),
  '切可用 / 不可用只就地重画这张卡');
check(removeBlock.length > 0 && !/pageLoad\('stickers'/.test(removeBlock) && /stickerDropCard\(id\)/.test(removeBlock),
  '删一张只摘掉这张卡并借下一页的补空格');
check(/data-sticker-card="' \+ esc\(id\) \+ '"/.test(html) && /function stickerCardNode\(id\)/.test(html)
  && /function stickerFindItem\(id\)/.test(html), '卡片带 data-sticker-card，能按 id 定位到单张');
check(/function stickerRefill\(\)/.test(html) && /if \(!stickerState\.hasMore \|\| want <= 0\) return Promise\.resolve\(false\)/.test(html)
  && /stickerState\.page \* stickerState\.pageSize \+ stickerState\.items\.length/.test(html),
  '删卡后从下一页只补差额，不重取整页');
// 黑名单：开关 / 添加 / 移除三个写动作 + 统计都接到 GET 的真实字段上。
check(/lists: pageLists,/.test(html) && /lists: '名单'/.test(html) && /id="page-lists"/.test(html), '名单页登记进 PAGE_LOADERS / PAGE_TITLES 并有容器');
check(/data-write="lists-ai-save"/.test(html) && /patch: \{[\s\S]{0,200}?mode: \(mode && mode\.value\) === 'silent'/.test(html), 'AI 黑名单规则走 /api/lists/settings 的 patch');
check(/data-write="lists-add"/.test(html) && /action: 'add', id: id, note: note/.test(html) && /id="listAddId"/.test(html) && /id="listAddNote"/.test(html), '添加行（号 + 备注）走 action=add');
// 第八项「临时私聊白名单」：白名单群成员自动获得私聊通行证（每天额度、跨天重置），
// 不是 config 里的数组，所以给的是运行时状态 + 今日用量。
check(/LIST_ORDER = \[[^\]]*'private-pass'\]/.test(js), '名单左栏含「临时私聊白名单」');
check(js.includes("'private-pass': {") && js.includes("title: '临时私聊白名单'") && js.includes('白名单群里的群友不用手工加号'), '临时私聊白名单有元信息（自动放行、每日额度）');
check(js.includes('function listsPassHtml') && js.includes('listsData().privatePass') && /data-list-pass-refresh/.test(js), '通行证面板读 privatePass 并带「刷新用量」');
check(/id === 'private-pass'[\s\S]{0,160}memberCount/.test(js), '左栏该行显示群成员人数');
check(js.includes('每人每天') && js.includes('离开超过') && js.includes('第二天自动重置'), '面板写明每人每天额度、离开不计时、跨天重置');
check(js.includes('今天已聊') && js.includes('额度用完了'), '面板给今日用量表与超额状态');
check(/pageLists[\s\S]{0,800}socialV2\/private-quota/.test(js), 'pageLists 并行取今日用量（取不到不影响名单读写）');
check((html.match(/5~20 位纯数字/g) || []).length >= 2 && /inputmode="numeric"/.test(html), '添加前校验 5~20 位纯数字（与后端一致）');
check(/data-write="lists-remove"/.test(html) && /action: 'remove', id: id/.test(html) && /data-write="lists-clear"/.test(html), '每行移除 + 清空名单都走 /api/lists');
check((html.match(/openDialog\(\{/g) ?? []).length >= 5 && /'lists-remove': function \(btn\) \{[\s\S]{0,700}?openDialog\(\{/.test(html), '写名单前都先 openDialog 二次确认');
check(/stats\.skippedToday/.test(html) && /今日已拦截 ' \+ numText\(stats\.skippedToday\)/.test(html), '今日跳过用 numText(stats.skippedToday)');
check((html.match(/pageLoad\('blacklist', true\)/g) ?? []).length === 0 && /listsPost\('\/api\/lists'/.test(html), '写名单后就地重画（POST 直接回最新状态），不再整页重取');
// 窄屏：新加的三个横向条（消息图片 / 分页条 / 名单表格）都必须能收进单列。
check(/\.qdb-pager \{[^}]*flex-wrap: wrap/.test(html) && /\.qdb-page-bar \{[^}]*flex-wrap: wrap/.test(html) && /\.qdb-table \{ width: 100%;[^}]*table-layout: fixed/.test(html), '分页条/搜索条可换行、名单表格 fixed 布局不撑破');
check(/\.qdb-msg-img \{ display: block; max-width: min\(180px, 100%\)/.test(html) && /\.qdb-dialog-wide \{ width: min\(880px, calc\(100vw - 32px\)\)/.test(html), '360 宽下图片与弹层都按视口收窄');
check((html.match(/method: 'POST'/g) ?? []).length === 1, '新增写操作仍只有一个 method: POST（统一走 apiWrite）');

// ── 10.8 模型与高峰（routing）：空闲/高峰切换、降级与禁用清单、暂停聊天 ───────
// 这一页的写操作有两条硬边界：清单增/减只改草稿（点了不写盘），真正落盘的只有
// 「保存」（POST /api/model-routing）与「暂停/恢复聊天」（POST /api/socialV2/activity）。
console.log('## 模型与高峰');
const routingSection = (html.match(/<section data-page="routing"[\s\S]*?<\/section>/) ?? [''])[0];
check(/function pageRouting\(view, host\)/.test(html) && html.includes('routing: pageRouting'), '模型与高峰页有 pageRouting() 并登记进 PAGE_LOADERS');
check(html.includes('id="page-routing"') && html.includes('data-page-refresh="routing"') && /routing: '模型与高峰'/.test(html), '路由页有容器 / 刷新按钮 / 中文标题');
check(/class="qdb-badge" data-tone="write">可操作/.test(routingSection) && /qdb-page-sub/.test(routingSection), '路由页标「可操作」并写明数据来源');
check(/api\('\/api\/model-routing'\)/.test(html), '路由页 GET /api/model-routing（经 api() 带 x-console-token）');
check(/apiWrite\('\/api\/model-routing', \{[\s\S]{0,300}?peakPauseEnabled:/.test(html), '保存 POST /api/model-routing 带上 peakPauseEnabled');
check(/idle: d\.idle \|\| null/.test(html) && /peak: d\.peak \|\| null/.test(html) && /fallback: fallback/.test(html) && /disabled: disabled/.test(html),
  '保存 body 用 idle / peak / fallback / disabled 四个字段（与后端同名字段）');
check(/var ROUTE_SOURCES = \{ peak: '高峰', idle: '空闲', fallback: '降级', media: '视觉', main: '默认' \};/.test(html),
  'source 五种取值都映射成中文（高峰/空闲/降级/视觉/默认）');

console.log('## 找号页已并入素材库（v2 导航整合）');
const findSection = (html.match(/<section data-page="find"[\s\S]*?<\/section>/) ?? [''])[0];
check(!/data-view="find"/.test(html) && findSection.length === 0, '侧栏与页面里都没有「找号」（导航项与 section 一起移除）');
check(!/find: pageFind/.test(html) && !/function pageFind\(/.test(html), 'PAGE_LOADERS / PAGE_TITLES 不再登记 find，pageFind 也已删除');
check(/find: function \(view, host\) \{ return pageLibraryPro\(view, host\); \}/.test(html), '旧链接兜底：PAGE_LOADERS.find 指向素材库（不占导航）');
check(/LIBPRO_VIEWS = \[[\s\S]{0,400}?\['with-booth', '已认号'[\s\S]{0,400}?\['no-booth', '未认号'[\s\S]{0,400}?\['cloud', '已购未下载'/.test(html),
  '素材库左栏补上视图组：已认号 / 未认号 / 已购未下载');
check(/data-view="find"/.test(html) === false && !html.includes('id="findSearch"'), '原来找号页的搜索框 / 三档筛选都不在静态页里了');
check(true, '（原「找号」页 12 条断言已随页面删除，功能断言移到素材库 v2 段）');

check(/function routeSourceText\(source\)/.test(html) && /routeSourceText\(eff\.source\)/.test(html), '当前生效的来源标签走 routeSourceText()');
check(/String\(eff\.provider \|\| '—'\)\.toUpperCase\(\) \+ ' \/ ' \+ String\(eff\.model \|\| '—'\)\.toUpperCase\(\)/.test(html),
  '当前生效模型大写展示 provider / model');
check(html.includes('保存后下一轮生效，无需重启'), '页面上写明「保存后下一轮生效，无需重启」');
check(/routeSelectHtml\('routeIdleSel', '空闲模型（非高峰时段）'/.test(html) && /routeSelectHtml\('routePeakSel', '高峰模型（高峰时段）'/.test(html),
  '空闲 / 高峰两个下拉都在（id 固定）');
check(/return ref && ref\.provider && ref\.model \? String\(ref\.provider\) \+ '\/' \+ String\(ref\.model\) : '';/.test(html)
  && /<option value="' \+ esc\(e\.ref\) \+ '"/.test(html), '下拉值按 provider/model 拼，label 只当文本');
check(html.includes('DSH 未返回可用清单') && /entries\.length \? '' : ' disabled'/.test(html), 'options 为空时下拉禁用并提示「DSH 未返回可用清单」');
check(html.includes('（当前值，不在清单里）'), '当前值不在 options 里时仍能回填（不悄悄落到第一项）');
check(/var ROUTE_FALLBACK_MAX = 5;/.test(html) && /d\.fallback\.length >= ROUTE_FALLBACK_MAX/.test(html), '降级链上限 5，满了就禁掉添加');
// 增/删按钮的 data-write 由 kind 拼出来（fallback / disabled 共用同一套 helpers），
// 这里钉住模板本身 + 四个动作名，免得哪天 kind 拼错成 routing-undefined-add。
check(/data-write="routing-' \+ kind \+ '-add"/.test(html) && /data-write="routing-' \+ kind \+ '-remove"/.test(html)
  && /'routing-fallback-add': function \(btn\)/.test(html) && /'routing-fallback-remove': function \(btn\)/.test(html), '降级链增 / 删各有按钮与动作');
check(/d\.fallback\.indexOf\(e\.ref\) < 0/.test(html) && /routingDraft\.fallback\.indexOf\(ref\) >= 0/.test(html), '降级候选去重（渲染与提交各校一次）');
check(/kind === 'fallback' \? 'routeFallbackAdd' : 'routeDisabledAdd'/.test(html) && /'routing-disabled-add': function \(btn\)/.test(html)
  && /'routing-disabled-remove': function \(btn\)/.test(html), '禁用清单增 / 删各有按钮与动作（下拉 id 与降级分开）');
check(/function routeUsedRefs\(\)/.test(html) && /used\.indexOf\(e\.ref\) < 0/.test(html) && /routeUsedRefs\(\)\.indexOf\(ref\) >= 0/.test(html),
  '禁用候选排除正在当空闲 / 高峰 / 降级的模型');
check(/data-write="routing-peak-toggle"/.test(html) && /routingDraft\.peakPauseEnabled = !routingDraft\.peakPauseEnabled;/.test(html),
  '高峰期开关只翻草稿里的 peakPauseEnabled（保存时才发 peakPauseEnabled）');
check(/peak\.inWindow === true/.test(html) && /peak\.active === true/.test(html) && /join\('、'\)/.test(html),
  '窗口列表用「、」连接，并展示 inWindow / active');
check(/'routing-save': function \(btn\) \{[\s\S]{0,900}?openDialog\(\{/.test(html), '保存前先 openDialog 二次确认');
check(/var changeText = '文本：空闲 → '/.test(html) && /'；视觉：空闲 → '/.test(html)
  && /降级 ' \+ visionFallback\.map\(lab\)\.join\(' → '\)/.test(html)
  && /高峰期开关：' \+ \(d\.peakPauseEnabled \? '开' : '关'\)/.test(html), '确认文案写明文本/视觉的空闲·高峰·降级·开关');
check(/visionIdle: d\.visionIdle \|\| null/.test(html) && /visionFallback: visionFallback/.test(html),
  '保存时把视觉模型与视觉降级链一起提交');
check(/'routing-save': function \(btn\) \{[\s\S]{0,1600}?runWrite\(btn/.test(html) && /'routing-pause-toggle': function \(btn\) \{[\s\S]{0,900}?runWrite\(btn/.test(html),
  '保存与暂停都套 runWrite（防连点 + 失败提示）');
check(/'保存失败：' \+ \(\(error && error\.message\) \|\| error\)/.test(html), '保存失败时把后端 error 原文显示出来（不吞成四个字）');
check(/apiWrite\('\/api\/socialV2\/activity', \{ paused: next \}\)/.test(html) && /会停掉所有唤醒\/等待任务/.test(html),
  '暂停聊天 POST /api/socialV2/activity，确认文案点明会停掉所有唤醒/等待任务');
check(/api\('\/api\/socialV2\/activity'\)\.catch/.test(html) && /routingPause\.paused = activity && typeof activity\.paused === 'boolean'/.test(html),
  '暂停状态读不到时整页不失败（徽标退回「状态未知」）');
check(/pauseText = paused === true \? '已暂停' : \(paused === false \? '运行中' : '状态未知'\)/.test(html) && /id="routePauseHint"/.test(html),
  '暂停卡显示「已暂停 / 运行中」并就地刷新文案');
check(/\.qdb-model-item \{[^}]*flex-wrap: wrap/.test(html) && /\.qdb-model-hero \{[^}]*overflow-wrap: anywhere/.test(html),
  '降级/禁用行与生效模型都按换行收窄（360 宽不顶出横滚）');

// ── 12. 隐藏入口 + 工具开关页（调试能力，默认不出现在导航里） ────────────────
// 用户明确要「客户端里隐藏的设置」：解锁手势 / ?dev=1 / localStorage 三件事都要能对得上，
// 而且未解锁时导航必须还是 10 项（§3 已核对），解锁后只多一个 data-view="toolgate" 的第 11 项。
console.log('## 隐藏入口 + 工具开关页');
const DEV_STORAGE_KEY = 'qdb-dev-unlocked';
check(/var DEV_CLICK_LIMIT = 5/.test(html) && /var DEV_CLICK_WINDOW_MS = 3000/.test(html), '解锁手势门槛写死：3 秒内连点 5 次');
check(/var versionChip = byId\('versionChip'\)/.test(html) && /versionChip\.addEventListener\('click', devTap\)/.test(html), '解锁手势挂在「版本」chip 上');
check(/devClicks = devClicks\.filter\(function \(ts\) \{ return now - ts <= DEV_CLICK_WINDOW_MS; \}\)/.test(html)
  && /if \(devClicks\.length < DEV_CLICK_LIMIT\) return;/.test(html), '只有落在 3 秒窗口内的点击才计数');
check(html.includes(`var DEV_KEY = '${DEV_STORAGE_KEY}'`) && /localStorage\.setItem\(DEV_KEY, '1'\)/.test(html)
  && /localStorage\.removeItem\(DEV_KEY\)/.test(html), `解锁状态存 localStorage['${DEV_STORAGE_KEY}']，重新锁上时清掉`);
check(/get\('dev'\) === '1'/.test(html), '地址带 ?dev=1 也直接解锁');
check(/function applyDevUnlock\(on\)/.test(html) && /applyDevUnlock\(readDevFlag\(\)\)/.test(html), '启动时按 URL / localStorage 还原解锁状态');
check(/if \(!devUnlocked && currentView\(\) === DEV_VIEW\) showView\('dashboard'\)/.test(html), '重新锁上时若正停在该页，退回仪表盘');
check(/id="devChip" hidden/.test(html) && /\.qdb-tool-chip\[hidden\] \{ display: none; \}/.test(html),
  '右上「调试」小标签未解锁时隐藏（.qdb-chip 自带 display，需单独兜一条 [hidden]）');
check(!/data-view="toolgate"/.test(html), '静态 HTML 里没有 toolgate 导航项（第 11 项只在解锁后出现）');
check(/btn\.setAttribute\('data-view', DEV_VIEW\)/.test(html) && /createTextNode\('工具开关'\)/.test(html), '解锁后由 JS 追加「工具开关」导航项');
check(/nav\.parentNode\.removeChild\(nav\)/.test(html), '再连点 5 次把该项从 DOM 里摘掉（重新锁上）');
check(/data-page="toolgate"/.test(html) && html.includes('id="page-toolgate"') && /toolgate: pageToolgate/.test(html)
  && /toolgate: '工具开关'/.test(html), 'toolgate 页有区块 / 容器 / PAGE_LOADERS / PAGE_TITLES 登记');
check(/api\('\/api\/tools\/gate'\)/.test(html), 'GET /api/tools/gate 拉工具清单');
check(/apiWrite\('\/api\/tools\/gate', \{ patch: patch \}\)/.test(html) && /patch\[flag\] = !turningOff/.test(html),
  'POST /api/tools/gate 的 body 是 { patch: { flag: 布尔值 } }');
check(/changed\.indexOf\(key\) >= 0/.test(html), '按响应里的 changed 回写（一个 flag 可能带多个工具）');
check(/TOOLGATE_NOTE = '关闭后机器人立刻不能再调用；模型侧要重启 DSH 才会不再看到这个工具。'/.test(html)
  && /esc\(TOOLGATE_NOTE\)/.test(html), '顶部说明条写明「关闭后立刻不能调用 + 模型侧要重启 DSH」，且走 esc()');
check(/statBox\('已开启', numText\(model\.on\) \+ ' \/ ' \+ numText\(model\.tools\.length\)\)/.test(html), '顶部统计「已开启 N / 共 M」');
check(/model\.groups\.forEach/.test(html) && /panelBox\(String\(\(group && group\.title\) \|\| gid\)/.test(html), '按接口返回的 groups 分组渲染');
check(/role="switch" aria-checked="/.test(html) && /data-tool-toggle="/.test(html) && /class="qdb-tool-switch" type="button"/.test(html),
  '每行开关是 <button role="switch" aria-checked>（键盘可达，不是 checkbox）');
check(/item\.guard === false \? ' <span class="qdb-tag">仅模型侧可见控制<\/span>'/.test(html), 'guard:false 的行加 qdb-tag「仅模型侧可见控制」');
check(/item\.effective === false/.test(html), 'effective:false 的开关置灰（后端会返回 effective 字段）');
check(/qdb-tool-dead/.test(html) && /暂不生效/.test(html), '失效开关标「暂不生效」并带 qdb-tool-dead 样式');
check(/item\.effective === false\) return/.test(html), '点了失效开关也不会发请求');
check(/class="qdb-tool-title"/.test(html) && /class="qdb-tool-name"/.test(html) && /class="qdb-tool-desc"/.test(html),
  '每行：中文名（大）+ 英文工具名（mono）+ 一句说明');
check(/openDialog\(\{[\s\S]{0,400}?'关闭后机器人就不能「' \+ title \+ '」了，确定？'/.test(html), '关闭前二次确认，文案写明「关闭后机器人就不能「X」了，确定？」');
check(/danger: turningOff/.test(html), '关闭用危险样式（danger: true）');
check(/runWrite\(btn, function \(\) \{[\s\S]{0,300}?apiWrite\('\/api\/tools\/gate'/.test(html), '切换套 runWrite（防连点 + 失败提示）');
check(/if \(!result\) renderToolgate\(pageHost\(DEV_VIEW\)\)/.test(html), 'POST 失败后按缓存重画，开关回到原位');
check(/操作失败：' \+ \(\(error && error\.message\) \|\| error\)/.test(html), '失败提示带后端 error 原文（runWrite 统一出口）');
check(/id="toolFilter" type="search"/.test(html) && /placeholder="按中文名 \/ 英文工具名过滤"/.test(html), '搜索框按中文名 / 英文工具名过滤');
check(/toolGate\.q = input\.value/.test(html) && /indexOf\(q\) >= 0/.test(html) && /function renderToolgate\(host\)/.test(html), '过滤即时重绘（带焦点回填）');
const toolgateSection = (html.match(/<section data-page="toolgate"[\s\S]*?<\/section>/) ?? [''])[0];
check(toolgateSection.length > 0 && !/loading="lazy"/.test(toolgateSection), '工具开关页不用 loading="lazy"');
check(/后端接口未就绪（临时只读清单）/.test(html) && /toolGate\.degraded = true/.test(html), 'GET 失败时顶部标「后端接口未就绪（临时只读清单）」');
check(/toolGate\.reason = \(error && error\.message\) \|\| String\(error\)/.test(html) && /esc\(toolGate\.reason \|\| '请求失败'\)/.test(html),
  '降级说明条带上真实失败原因（留痕，不弹遮挡开关的 toast）');
check(/toolgateModel\(\) \{[\s\S]{0,400}?TOOLGATE_FALLBACK/.test(html), 'GET 失败退回内置静态清单');
const fallbackBlock = (html.match(/var TOOLGATE_FALLBACK = \[[\s\S]*?\n  \];/) ?? [''])[0];
const fallbackRows = (fallbackBlock.match(/\{ flag: '[A-Za-z]+', tool: 'qq_[a-z_]+', title: '/g) ?? []).length;
check(fallbackRows >= 20 && !/\d{6,}/.test(fallbackBlock), `降级清单每行都带 flag/tool/title/desc/group（${fallbackRows} 行，无真实号码）`);
check((html.match(/qdb-tool-/g) ?? []).length >= 10 && /\.qdb-tool-switch\[aria-checked="true"\]/.test(html)
  && /border-color: var\(--ui-accent\)/.test(html), '新样式统一 qdb-tool- 前缀，配色只用 --ui-* 令牌');

// ── 10.8 运维页（T34）：把 ops.html 缺的三块并进客户端 ──────────────────────
// 这一组钉的是「照搬 ops 十张卡」的反面：只有三张纵向卡、按钮由后端 actions 决定、
// 写操作仍然只经 apiWrite + openDialog，日志尾巴和自检都给出可核对的真实字段。
console.log('## 运维页');
const opsSection = (html.match(/<section data-page="ops"[\s\S]*?<\/section>/) ?? [''])[0];
check(opsSection.length > 0 && html.includes('data-view="ops"'), '导航第 11 项「运维」有对应 <section data-page="ops">');
check(opsSection.includes('<h1 class="qdb-page-title">运维</h1>'), '运维页标题是「运维」');
// 三块纵向卡，不做 tabs：一个 .qdb-ops-stack 里三张 panelBox。
check(/class="qdb-ops-stack"/.test(html) && /opsServicesCard\(\) \+ opsSelfCheckCard\(\)/.test(html) && /opsToolsCard\(\)/.test(html) && /opsLogCard\(\)/.test(html),
  '四块按「服务 / 自检 / 工具组 / 日志」纵向排列（一张卡一段，没有 tabs）');
check(!/role="tab"/.test(opsSection) && !/data-tab=/.test(opsSection), '运维页没有做页签控件（简单优先）');
check(/panelBox\('服务状态与启停'/.test(html) && /panelBox\('自检'/.test(html) && /panelBox\('工具组'/.test(html) && /panelBox\('服务日志'/.test(html),
  '四张卡标题分别是 服务状态与启停 / 自检 / 工具组 / 服务日志');
// 四个接口：三条 GET + 两条 POST（POST 全在 apiWrite 里）。
check(/api\('\/api\/ops\/services'\)/.test(html) && /api\('\/api\/ops\/status'\)/.test(html) && /api\('\/api\/self-check\/last'\)/.test(html),
  '运维页拉 GET /api/ops/services、/api/ops/status、/api/self-check/last');
check(/apiWrite\('\/api\/ops\/action', \{ service: id, action: action \}\)/.test(html), '启停写 POST /api/ops/action');
check(/apiWrite\('\/api\/self-check', \{\}\)/.test(html), '「运行自检」写 POST /api/self-check 空 body');
check(html.includes("// 后端读的是 body.service（不是 body.id）"), '注明了后端读的是 body.service（不是 body.id，发错键真机 400）');
// 服务行：圆点 + 中文名 + detail + 按 actions 渲染的按钮；DSH 没有动作就等于没有按钮。
check(/var actions = Array\.isArray\(item && item\.actions\) \? item\.actions : \[\];/.test(html),
  '服务行的按钮按响应里的 actions 数组渲染（不写死）');
check(/data-write="ops-service-action" data-service="' \+ esc\(item\.id\) \+ '" data-action="/.test(html),
  '按钮挂 data-service / data-action（服务 id 与动作都来自后端）');
check(/var OPS_ACTION_LABEL = \{ start: '启动', stop: '停止', restart: '重启' \};/.test(html), '动作中文名收敛成一张小表');
// 这条只管「运维页的服务行」：别处（例如设置页判断 catalogSource==='dsh'）出现这个字面量是正常的，
// 所以把检查范围收到 pageOps 这一段，而不是整份 JS。
const opsJsSlice = (() => {
  const start = js.indexOf('function pageOps(');
  // pageSettings 在片段顺序里排在 pageOps 之前，所以用后面第一个「设置页附加快照」的函数当结束边界。
  const end = js.indexOf('function libPrivHintHtml(', start + 1);
  return start >= 0 ? js.slice(start, end > start ? end : js.length) : '';
})();
check(opsJsSlice.length > 0 && !opsJsSlice.includes("'dsh'"), '运维页没有为 DSH 硬编码任何动作（后端不给 actions 就不出按钮）');
check(!/OPS_ACTION_LABEL = \{[^}]*dsh/.test(html), '动作表里没有 dsh 条目');
check(/esc\(\(item && item\.detail\) \|\| \(ok \? '正常' : '不可用'\)\)/.test(html), 'detail 为空时退回「正常 / 不可用」');
// 二次确认：文案必须写清 bridge 重启的后果，且重启/停止用危险样式。
check(/if \(String\(item && item\.id\) === 'bridge' && action === 'restart'\)/.test(html) && /断开正在进行的回合，约 5 秒恢复/.test(html),
  'bridge 重启的确认文案写明「会断开正在进行的回合，约 5 秒恢复」');
check(/confirmLabel: '确认' \+ OPS_ACTION_LABEL\[action\]/.test(html), '确认按钮文案跟着动作走（确认重启 / 确认停止）');
check(/danger: action !== 'start'/.test(html), '停止/重启用 danger:true 的危险样式，启动不用');
check(/openDialog\(\{[\s\S]{0,260}?'ops-service-action'/.test(html) || /'ops-service-action': function \(btn\) \{[\s\S]{0,400}?openDialog\(\{/.test(html),
  '启停走 openDialog 二次确认（不是一点就发）');
check(/runWrite\(btn, function \(\) \{[\s\S]{0,220}?apiWrite\('\/api\/ops\/action'/.test(html), '启停套 runWrite（防连点 + 失败提示）');
check(/toast\('「' \+ name \+ '」已' \+ OPS_ACTION_LABEL\[action\]/.test(html) && /return loadOpsServices\(\);/.test(html),
  '成功后 toast + 重新拉一次 GET /api/ops/services');
// 自检：排序 fail → warn → ok，按钮在跑的时候 disabled，evidence / suggestion 逐行渲染。
check(/var OPS_STATUS_ORDER = \{ fail: 0, warn: 1, ok: 2 \};/.test(html) && /return opsRank\(a && a\.status\) - opsRank\(b && b\.status\);/.test(html),
  '自检分组按 fail → warn → ok 排序（故障永远排最前）');
check(/data-ops-act="selfcheck-run"[\s\S]{0,80}?\(opsCache\.running \? ' disabled' : ''\)/.test(html) && /正在跑…/.test(html),
  '跑的时候按钮变「正在跑…」并 disabled');
check(/opsCache\.running = true;[\s\S]{0,200}?renderOps\(host\);/.test(html), '点了就先重画成 disabled 态（防连点跑两遍体检）');
check(/<ul class="qdb-ops-evidence">/.test(html) && /evidence\.map\(function \(line\) \{ return '<li>' \+ esc\(line\) \+ '<\/li>'; \}\)/.test(html),
  'evidence 逐行渲染成列表（每行都转义）');
check(/'<div class="qdb-ops-suggest">→ 建议：'/.test(html), '有 suggestion 时显示「→ 建议：…」');
check(/面板|panelBox\('自检', fail \? '有故障' : \(warn \? '有告警' : '全部正常'\)/.test(html), '自检卡标题旁给出 有故障/有告警/全部正常');
check(/opsCountsText\(report\)/.test(html) && /' 正常 \/ ' \+ \(Number\(counts\.warn\) \|\| 0\) \+ ' 告警 \/ '/.test(html),
  '顶部按 counts 显示「N 正常 / N 告警 / N 故障」');
check(/上次自检 ' \+ esc\(timeText\(Date\.parse\(report\.at\) \|\| report\.at\)\)/.test(html) && /耗时 ' \+ esc\(Number\.isFinite/.test(html),
  '顶部带「上次自检」时间与耗时');
check(/\(status === 'ok' \? '' : ' open'\)/.test(html), '故障/告警默认展开、正常项收起（<details>）');
// 服务日志：等宽 pre + 保留换行 + 块内滚动 320px。
check(/<pre class="qdb-ops-log">' \+ esc\(lines\.join\('\\n'\)\) \+ '<\/pre>/.test(html), '日志用 <pre> 拼 join 换行（原始换行保留）');
check(/\.qdb-ops-log \{[\s\S]{0,240}?max-height: 320px/.test(html) && /white-space: pre-wrap/.test(html), '日志 <pre> 块内滚动 max-height 320px + pre-wrap');
check(/'state\/bridge\.log · 最后 60 行'/.test(html), '日志卡标题标「state/bridge.log · 最后 60 行」');
check(/data-ops-act="log-refresh"/.test(html) && /api\('\/api\/ops\/status'\)\.then\(function \(data\) \{[\s\S]{0,120}?opsCache\.log/.test(html),
  '「刷新」重新拉 /api/ops/status 只更新日志');
check(/还没有自检结果：点右上角「运行自检」/.test(html), '没跑过自检时给空态而不是空白卡');
// 仪表盘补的四个字段 + 10 秒轮询
check(/var REFRESH_MS = 10000;/.test(html), 'REFRESH_MS 改成 10000（10 秒）');
check(/also: '\/api\/ops\/status'/.test(html) && /if \(data && pair\[1\]\) data\[spec\.alsoKey \|\| 'ops'\] = pair\[1\];/.test(html),
  '运行状态卡额外挂一份 /api/ops/status（在 loadCard 里合并成 data.ops，alsoKey 可改挂点）');
for (const field of [['PID', 'ops.pid', 'bridgeText'], ['端口', 'ops.port', 'bridgeText'], ['DSH 会话数', 'ops.sessions', 'bridgeNum'], ['QQ 会话数', 'ops.conversations', 'bridgeNum']]) {
  check(html.includes(`row('${field[0]}', ${field[2]}(${field[1]}))`), `运行状态卡补了「${field[0]}」`);
}
check(/function bridgeNum\(value\) \{\s*\n\s*return Number\.isFinite\(Number\(value\)\) \? numText\(Number\(value\)\) : '—';\s*\n\s*\}/.test(html),
  '拿不到时显示「—」（不假装 0）');
check(/function bridgeText\(value\) \{[\s\S]{0,140}?if \(value === null \|\| value === undefined \|\| value === ''\) return '—';/.test(html),
  'PID / 端口原样显示（不套千分位），缺值同样退回「—」');
// 断链：不许再写「去运维面板」或者跳出客户端。
check(!html.includes('运维面板'), '页面里不再出现「运维面板」字样');
check(!html.includes('href="/ops.html"'), '不再有指向 /ops.html 的外链');
check(/data-goto-view="ops"/.test(html) && /showView\(target\.getAttribute\('data-goto-view'\)\)/.test(html), '正文里的「运维」是可点击切页的链接');
check(/服务状态、自检与服务日志在<a href="#" data-goto-view="ops">/.test(html), '日志页脚仍把「服务日志」指去「运维」页');
// 日志页改名：nav / 页面标题 / PAGE_TITLES 三处都改（「工具日志」已不准确：现在是聊天流）。
check(html.includes('日志</h1>'), '日志页标题改成「日志」');
check(/logs: '日志', usage: '用量与花费', ops: '运维'/.test(html), 'PAGE_TITLES 里 logs 是日志、usage 是用量与花费、ops 是运维');
check(/按聊天流看：群友说话靠左、机器人说话靠右/.test(html), '日志页副标题说明「群友靠左 / 机器人靠右 / 中间是系统消息」');
check(!/\balert\s*\(/.test(html) && !/\bconfirm\s*\(/.test(html) && !/\bprompt\s*\(/.test(html), '运维页没有用 alert / confirm / prompt');

// ── 10.6b 日志页：QQ 群聊式时间线（群友 / 机器人 / 系统消息） ────────────────
// 这一节盯的是「人能不能一眼看懂」：三类事件合并成一条流、左右分栏、系统消息说人话、
// 失败升级成红字、原始参数折叠而不是铺满一行。
// ── 10.9 系统架构页：一张图看懂消息怎么走 ───────────────────────────────
// 这一组钉的是「别做成接口目录」：五个节点串成一条链、五层各自列活的东西、
// 三个闸写清为什么、跳到别的页用 data-fw-goto 而不是硬编码 location。
console.log('## 毛玻璃下不再有纯白块');
// 前四套各两处（浅色 + 深色），第五套 halo 把 light/dark 写进同一个选择器组里只声明一次 → 共 9 处
check((css.match(/--ui-surface-solid: #/g) || []).length === 9, '五套皮肤都有实色快照 --ui-surface-solid（9 处：四套各两份 + 数据环共用一份）');
check(/\[data-glass="on"\] \{\s*--ui-surface: color-mix\(in srgb, var\(--ui-surface-solid\) 46%, transparent\);/.test(css),
  '毛玻璃时把 --ui-surface 换成半透明，输入框/下拉/徽标/表头/按钮底自动跟着通透');
check(/\[data-theme="dark"\]\[data-glass="on"\] \{\s*--ui-surface: color-mix\(in srgb, var\(--ui-surface-solid\) 58%/.test(css),
  '深色主题单独一档透明度（不然深色玻璃里嵌纯黑块）');
check(/background-color: color-mix\(in srgb, var\(--ui-surface-solid\) 90%, transparent\)/.test(css),
  '卡片/面板用实色快照派生（90%）：底子是白的，靠边框和层级区分，不靠透出来的彩光');
check(/\[data-glass="on"\] \.qdb-toast,[\s\S]{0,200}backdrop-filter: blur\(18px/.test(css),
  '提示条/吸顶/表头这些会盖住内容的面，半透明后自带模糊');
check(/\[data-glass="on"\] \.qdb-logo \{[^}]*color-mix\(in srgb, #fff 62%/.test(css),
  '品牌图标的白底在玻璃下一并压薄');

console.log('## 玻璃强度三档（淡 / 中 / 浓）');
const usage = fs.readFileSync(path.join(ROOT, 'client', '04-usage.js'), 'utf8');
const settings = fs.readFileSync(path.join(ROOT, 'client', '05-settings.js'), 'utf8');
check(html.includes("var GLASS_LEVEL_KEY = 'qdb-glass-level'") && /dataset\.glassLevel/.test(dom),
  '玻璃强度单独一个 localStorage 键，且首屏引导脚本就读（不闪）');
check(/\[data-glass="on"\]\[data-glass-level="light"\] \.qdb-card/.test(css)
  && /\[data-glass="on"\]\[data-glass-level="strong"\] \.qdb-card/.test(css),
  'CSS 有淡 / 浓两档覆盖（默认不带属性就是中档）');
check(/data-glass-level="light"[\s\S]{0,200}background-color: color-mix\(in srgb, var\(--ui-surface\) 34%/.test(css)
  && /data-glass-level="strong"[\s\S]{0,200}background-color: color-mix\(in srgb, var\(--ui-surface\) 12%/.test(css),
  '淡档更白（34%）、浓档更透（12%）');
check(/data-set-glass-level="' \+ lv\.id/.test(usage) && /var GLASS_LEVELS = \[\{ id: 'light', name: '淡' \}/.test(settings),
  '设置页有「玻璃强度」三档分段控件');
check(/function currentGlassLevel\(\)/.test(settings) && /function applyGlassLevel\(next\)/.test(settings)
  && /localStorage\.setItem\(GLASS_LEVEL_KEY, level\)/.test(settings),
  '档位能读能写并记住');
check(/levelBtns\[k\]\.disabled = !on/.test(settings),
  '毛玻璃关掉时档位按钮置灰（避免关了还能选，看着像没生效）');

console.log('## 桥接离线（面板常驻进程在，机器人可能下线）');
const shell = fs.readFileSync(path.join(ROOT, 'client', '01-shell.js'), 'utf8');
const shell2 = fs.readFileSync(path.join(ROOT, 'client', '05-settings.js'), 'utf8');
const dash = fs.readFileSync(path.join(ROOT, 'client', '02-dashboard.js'), 'utf8');
check(/bridgeDown: false/.test(shell) && /var BRIDGE_RETRY_MS = 3000;/.test(shell), '前端有「桥接下线」状态与 3 秒重试节奏');
check(/res\.headers\.get\('x-console-offline'\) === '1'/.test(shell), 'api() 读 x-console-offline 判定机器人在不在');
check(/if \(state\.bridgeDown\) return Promise\.reject\(new Error\('机器人已下线/.test(shell), '机器人下线时写操作直接挡掉，不发出去');
check(/function markBridgeDown/.test(shell) && /function markBridgeUp/.test(shell) && /var view = currentView\(\);/.test(shell) && /pageLoad\(view, true\)/.test(shell), '回来时自动补数据，不用手动刷新');
check(/id="bridgeOffline"/.test(html) && /id="bridgeRetry"/.test(html), '页面里有离线横幅与「立刻重试」按钮');
check(/id="identityLockBar"/.test(html) && /id="identityLockText"/.test(html), '页面里有身份锁横幅（登录号不对时提示所有消息都不会发出）');
check(/paintIdentityLock\(data && data\.identityLock\)/.test(js) && /lock\.lock === true/.test(js), '身份锁横幅按 /api/status 的 identityLock.lock 显示');
check(/setInterval\(function \(\) \{[\s\S]{0,80}refreshIdentityLock\(\)/.test(js), '身份锁状态每 30 秒复查一次');
check(/id="staleBuildBar"/.test(html) && /id="staleBuildReload"/.test(html), '页面里有「控制台有新版本」横幅');
check(/clientBuildAtLoad/.test(js) && /paintStaleBuild\(build !== clientBuildAtLoad\)/.test(js) && /clientBuildPollTimer = window\.setInterval/.test(js), '外壳对比 /api/version 的 clientBuild，旧标签页提示刷新');
check(/\.qdb-stale-build \{/.test(css), '过期横幅有独立的 warn 色样式');
check(/\.qdb-offline \{[^}]*border: 1px solid color-mix\(in srgb, var\(--ui-warn\) 42%/.test(css) && /\.qdb-offline\[hidden\] \{ display: none; \}/.test(css), '离线横幅是 warn 色（不是整页报错），且能真隐藏');
check(/'bridgeRetry'/.test(shell2) && /retryBridgeNow\(false\)/.test(shell2), '「立刻重试」按钮接上了');
check(!/toast\(spec\.title \+ '加载失败/.test(dash) || /if \(!state\.bridgeDown\) toast\(spec\.title/.test(dash), '整条下线时不再一张卡刷一个 toast（顶部已有横幅）');

console.log('## 系统架构页');
const fwSection = (html.match(/<section data-page="framework"[\s\S]*?<\/section>/) ?? [''])[0];
check(html.includes('data-view="framework"') && fwSection.length > 0, '导航有「架构」，且有对应 <section data-page="framework">');
check(fwSection.includes('<h1 class="qdb-page-title">系统架构</h1>'), '页面标题是「系统架构」');
check(/PAGE_LOADERS = \{[\s\S]{0,80}framework: pageFramework/.test(js) && /PAGE_TITLES = \{ framework: '系统架构'/.test(js),
  'framework 登记进 PAGE_LOADERS / PAGE_TITLES（否则切过去是空白）');
check(/function pageFramework\(view, host\)/.test(js), '有 pageFramework(view, host)');
// 只读三件套：服务健康、运行状态、账本合计；一个失败不影响另外两个。
['/api/ops/services', '/api/status', '/api/tokens/summary'].forEach((path) => {
  check(js.includes("api('" + path + "')"), '架构页读 ' + path);
});
check(/function frameNodesHtml\(d\)/.test(js) && /function frameLayersHtml\(d\)/.test(js)
  && /function frameBudgetHtml\(d\)/.test(js) && /function frameLinksHtml\(\)/.test(js),
  '四块各有一个渲染函数（消息链路 / 分层 / 三个闸 / 去哪看）');
check(/var nodes = \[[\s\S]{0,160}群友 \/ 私聊[\s\S]{0,400}SnowLuma 网关[\s\S]{0,400}桥接 :3100[\s\S]{0,400}DSH 模型[\s\S]{0,400}回信 \/ 记账/.test(js),
  '消息链路是群友 → SnowLuma → 桥接 → DSH → 回信 五站，顺序不能乱');
check(/qdb-fw-dot\" data-tone=\"' \+ \(ok \? 'ok' : 'off'\)/.test(js), '每个节点/条目都有绿点/灰点（在线与没配一眼分开）');
check(/\['入口', \['SnowLuma 网关'[\s\S]{0,2400}\['数据', \['消息库'/.test(js), '分层是入口 → 会话 → 能力 → 模型 → 数据五列');
check(/data-fw-goto=\"' \+ l\[1\]/.test(js) && /var view = btn\.getAttribute\('data-fw-goto'\);/.test(js)
  && /showView\(view\)/.test(js),
  '「数字在哪看」用 data-fw-goto 调 showView 跳页，不硬编码 location');
check(/data-fw-goto=\"' \+ esc\(String\(n\.goto \|\| ''\)\)/.test(js) && /role="button" tabindex="0"/.test(js),
  '消息链路的每个节点也能点（跳会话 / 运维 / 模型 / 用量），带键盘可达');
check(/单轮步数上限/.test(js) && /上下文预算/.test(js) && /高峰策略/.test(js), '三个闸分别是 单轮步数 / 上下文预算 / 高峰策略');
check(js.includes("api('/api/model-routing')") && js.includes('routing: rows[3] || null')
  && js.includes('function frameRoutingOf(mr)') && js.includes('routing.idle') && js.includes('routing.peak'),
  '架构页的高峰模型读「模型与高峰」页那份 /api/model-routing（不再用写死 mimo 的旧 peakLocal）');
check(/route\.peakLabel/.test(js) && /route\.currentLabel/.test(js), '层图表里高峰/空闲都用 routing 的标签');
check(js.includes('高峰与空闲用的是同一个模型') && !js.includes('legacyPeak'),
  '空闲/高峰同模时如实说「不会真的切换」，也不再提已弃用的旧 agent 机制');
check(js.includes('高峰策略已关闭：全天都按空闲模型'), '高峰策略关掉时卡片直接说全天按空闲模型跑');
check(/\.qdb-fw-flow \{ display: flex/.test(css) && /\.qdb-fw-grid \{ display: grid; grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/.test(css),
  '链路横排、分层五列（grid 五列，窄屏再叠）');
check(/\.qdb-fw-dot\[data-tone=\"ok\"\] \{ background: var\(--ui-success\)/.test(css), '绿点用 --ui-success，别自己发明颜色');
check(/@media \(max-width: 1180px\) \{[\s\S]{0,200}\.qdb-fw-grid, \.qdb-fw-links/.test(css), '窄屏分层与跳转卡都叠成两列');

console.log('## 日志页时间线');
// 机器人自己的昵称/头像：以前写死「我」+ 灰「机」，用户说太难看。现在从 /api/ops/services
// 拿 SnowLuma 登录号，头像走 q1.qlogo.cn 公网直链，60 秒过期后重取。
check(/var BOT_ID_TTL_MS = 60000;/.test(js) && /function ensureBotIdentity\(force\)/.test(js),
  '机器人身份有独立缓存：ensureBotIdentity(force) + 60 秒 TTL');
check(/api\('\/api\/ops\/services'\)/.test(js) && /=== 'snowluma'/.test(js)
  && /userId: String\(account\.userId \|\| ''\)/.test(js) && /nickname: String\(account\.nickname \|\| ''\)/.test(js),
  '身份取自 /api/ops/services 的 snowluma.account（QQ 号 + 昵称）');
check(/ensureMemberNotes\(\),\s*ensureBotIdentity\(\)/.test(js), '进日志页时并行取机器人身份（和群名/备注一起）');
check(/var botAva = memberAvatarUrl\(logCache\.bot\.userId\);/.test(js)
  && /src="' \+ esc\(botAva\) \+ '"/.test(js) && /data-tl-ava="' \+ esc\(botWho\)/.test(js),
  '自己那条用真实头像（memberAvatarUrl）+ 真实昵称，不再是灰「机」');
check(/name: mine \? \(logCache\.bot\.nickname \|\| String\(m\.sender \|\| '机器人'\)\)/.test(js),
  '自己那句的名字显示真实 QQ 昵称');
check(!/aria-hidden="true">机</.test(js), '写死的「机」头像已经删掉');

check(/class="qdb-timeline" id="timelineFeed"/.test(html) && /function renderLogs\(host\)/.test(html),
  '合并后的时间线容器 #timelineFeed 由 renderLogs() 重绘');
check(/function timelineItems\(\)/.test(html) && /items\.sort\(function \(a, b\) \{ return a\.time - b\.time; \}\)/.test(html),
  '群友 / 机器人 / 系统消息合并成一条按 time 升序的流');
check(/timelineItemHtml\(it\)/.test(html) && /class="qdb-tl-row ' \+ \(mine \? 'is-self' : 'is-friend'\)/.test(html),
  '每条消息按 isSelf 分左右两栏（is-friend / is-self 两个 class 都在）');
check(/\.qdb-tl-row\.is-self \{ flex-direction: row-reverse; \}/.test(html), '机器人气泡靠右：整行反向排');
check(/\.qdb-tl-row\.is-friend \.qdb-tl-bubble \{[^}]*background: var\(--ui-surface-soft\)/.test(html)
  && /\.qdb-tl-row\.is-self \.qdb-tl-bubble \{[^}]*background: var\(--ui-accent-soft\)/.test(html),
  '群友与机器人气泡的底色 / 描边不同（一眼分得清谁说的）');
check(/function sysTextOf\(tool, args, key\)/.test(html), '系统消息文案由 sysTextOf(tool,args,key) 生成（不是直接铺 JSON）');
const toolCnBlock = (html.match(/var TOOL_CN = \{[\s\S]*?\n  \};/) ?? [''])[0];
const toolCnKeys = [...toolCnBlock.matchAll(/^\s{4}([a-z_0-9]+):/gm)].map((m) => m[1]);
check(toolCnKeys.includes('qq_send_message') && /qq_send_message: '在「\{to\}」发了一条消息'/.test(html),
  '中文映射表里 qq_send_message → 「在「X」发了一条消息」');
check(toolCnKeys.length >= 40, '工具中文映射覆盖 ≥40 个工具', `${toolCnKeys.length} 个`);
// 现场点名的这些工具必须各有中文说法，缺一个就是「人看不懂」回归。
for (const [tool, wording] of [['qq_send_burst', '连发 {n} 条消息'], ['qq_reply', '引用回复了一条'],
  ['qq_send_image', '发了一张图'], ['qq_send_sticker', '发了个表情'], ['qq_send_voice', '发了条语音'],
  ['qq_send_poke', '拍了拍「{to}」'], ['qq_wait_for_messages', '等消息（静默 {quietMs} ms，超时 {timeoutMs} ms）'],
  ['qq_search_history', '翻了下聊天记录：{q}'], ['web_search', '搜了下：{query}'],
  ['qq_get_group_members', '看了群成员'], ['qq_collect_sticker', '收藏了一个表情'],
  ['qq_affinity_shift', '调了下好感度'], ['qq_self_model', '查了下自己用的模型']]) {
  check(toolCnBlock.includes(`${tool}: '${wording}'`), `${tool} 有中文说法「${wording}」`);
}
check(/'调用了 ' \+ name/.test(html) && /if \(!tpl\) return '调用了 ' \+ name;/.test(html), '没登记的工具退回「调用了 <工具名>」（不猜）');
check(/'⚠ ' \+ truncate\(it\.cn, 60\) \+ '失败：'/.test(html) && /class="qdb-tl-row is-sys' \+ \(bad \? ' is-bad' : ''\)/.test(html)
  && /\.qdb-tl-row\.is-sys\.is-bad \.qdb-tl-sys-text \{ color: var\(--ui-danger\)/.test(html),
  '失败的 call 升级成红色「⚠ …失败：<error>」系统消息');
check(/<details class="qdb-tl-details"><summary>原始参数<\/summary><pre class="qdb-tl-json">/.test(html),
  '系统消息的参数折叠成 <details> + <pre>');
check(/\.qdb-tl-json \{[\s\S]{0,220}?max-height: 120px; overflow: auto;/.test(html)
  && /\.qdb-tl-json \{[\s\S]{0,220}?font: 12px\/1\.55 "Cascadia Mono"/.test(html),
  '参数块等宽 12px、块内滚动 max-height:120px');
check(/tlToggle\('tlSysOnly', '只看系统消息'/.test(html) && /tlToggle\('tlFailOnly', '只看失败'/.test(html)
  && /tlToggle\('tlSelfOnly', '只看机器人'/.test(html) && /id="tlKeySel"/.test(html) && /id="tlSearch"/.test(html),
  '工具条：三个筛选开关 + 会话下拉 + 搜索框都在');
check(/var TIMELINE_MAX = 300;/.test(html) && /'只显示最近 ' \+ numText\(TIMELINE_MAX\) \+ ' 条（更早的 '/.test(html),
  '只渲染最近 300 条（更早的给一行提示）');
check(/var TIMELINE_SESSIONS = 8;/.test(html) && /var TIMELINE_RECENT = 30;/.test(html)
  && /Promise\.all\(pick\.map\(function \(key\) \{/.test(html),
  '8 个会话 × recent?limit=30 并行取（Promise.all）');
check(/numText\(logCache\.missed\.length\) \+ ' 个会话没取到'/.test(html), '取不到的会话跳过，页底一行灰字注明「N 个会话没取到」');
// 系统事件以前居中夹在对话流中间，看着像日期分隔线；现在跟群友一样靠左、灰调异色气泡。
check(/class="qdb-tl-row is-sys/.test(html) && /qdb-tl-ava-sys" aria-hidden="true">系</.test(html)
  && /qdb-tl-bubble qdb-tl-sys-bubble/.test(html),
  '系统消息排在最左，灰「系」头像 + 异色气泡');
check(/\.qdb-tl-row\.is-sys \.qdb-tl-bubble\.qdb-tl-sys-bubble \{[\s\S]{0,220}?border-left: 3px solid var\(--ui-border-strong\)/.test(html),
  '系统气泡左侧竖条 + 灰调底色，和群友/机器人气泡区分开');
// 日志越往下越新：打开就贴底，别让人手动往下划几百条。
check(/function bindTimelineFollow\(\)/.test(html) && /logCache\.follow !== false\) feed\.scrollTop = feed\.scrollHeight/.test(html),
  '首次渲染直接贴到最新一条（免手动下滑）');
check(/feed\.addEventListener\('scroll', sync\)/.test(html)
  && /feed\.scrollHeight - feed\.scrollTop - feed\.clientHeight < 80/.test(html),
  '用户自己往上翻时暂停跟随，翻回底部自动恢复');
check(/id="tlJump" type="button" hidden>跳到最新 ↓</.test(html) && /jump\.hidden = nearBottom/.test(html),
  '离开底部时给「跳到最新」，点一下回底部');
check(/\.qdb-timeline \{[\s\S]{0,300}?max-height: clamp\(260px, calc\(100vh - 360px\), 760px\); overflow-y: auto;/.test(html),
  '日志流自己带滚动条、高度跟着视口封顶（面板体积可控）');
check(/logCache\.follow = true; \/\/ 搜索结果同样「最新的在底部」/.test(html),
  '搜索后同样贴底（结果按时间排，最新在底部）');
check(/>共 ' \+ numText\(list\.length\) \+ ' 条消息 · 系统事件 '/.test(html) && /class="qdb-tl-stat"/.test(html),
  '统计行简化成一行文字（不再是四格大卡）');
check(/还没有任何动静 —— 机器人在群里说话或调用工具后，这里会按聊天的样子显示/.test(html), '空态文案是人话');
// 历史脏数据（GBK 被按 UTF-8 解出来的 U+FFFD）不能原样摆在会话语录里，否则像机器人自己发乱码。
check(/var REPLACEMENT_CHAR = String\.fromCharCode\(0xfffd\);/.test(html)
  && /function groomGarbledText\(text\) \{/.test(html)
  && /new RegExp\(REPLACEMENT_CHAR \+ '\+', 'g'\), '⍰'/.test(html),
  '会话正文里 U+FFFD 串渲染成 ⍰（不是原样保留）');
check(/<span class="qdb-garbled" title="这条消息存进来时编码就错了/.test(html),
  '编码损坏的消息挂「编码损坏」标记/tooltip');
check(/\.qdb-garbled \{[\s\S]{0,220}?color: var\(--ui-warn\);/.test(html),
  '「编码损坏」标记用告警色，跟正常正文区分');
check(/msgBodyText\(m\) \? '<div class="qdb-msg-text">' \+ groomGarbledText\(truncate\(msgBodyText\(m\), 220\)\)/.test(html),
  '会话语录正文走 groomGarbledText（不再直接 esc）');
// 退化的旧结构：工具名 + 缩进（不可读），必须已经消失。
check(!/qdb-log-args/.test(html) && !/data-log-filter/.test(html) && !/function logClock\(/.test(html),
  '旧的「参数 JSON 直接铺满一行」结构已整块替换掉');
check(/'tool-log-clear': function \(btn\) \{[\s\S]{0,700}?openDialog\(/.test(html), '清空日志仍走 openDialog 二次确认');
check(!/data-tl-img="1" loading="lazy"/.test(html) && /data-tl-img="1" decoding="async"/.test(html),
  '时间线缩略图不懒加载（这个页面里懒加载中过招），坏图由 error 换成灰块');
check(/querySelectorAll\('img\[data-tl-img\]'\)/.test(html) && /box\.className = 'qdb-tl-img-bad';/.test(html), '图片加载失败换成灰块而不是碎图标');
check(/function tlImageHtml\(m\)/.test(html) && /if \(!isSticker && item\.kind !== 'image'\) continue;/.test(html)
  && /\.qdb-tl-img \{[\s\S]{0,140}?width: 96px; height: 96px; object-fit: cover/.test(html)
  && /\.qdb-tl-sticker \{[\s\S]{0,160}?width: 96px; height: 96px; object-fit: contain/.test(html),
  '同一条消息只渲第一张图，锁 96px 方框（图片 cover、表情 contain）');
// 头像只允许 q1.qlogo.cn（成员头像）与 p.qlogo.cn（群徽标，会话页用）：白名单见 §8 的零外链断言。
const qlogoHosts = [...new Set([...html.matchAll(/(?:https?:)?\/\/([a-z0-9.-]+\.qlogo\.cn)\//g)].map((m) => m[1]))].sort();
check(qlogoHosts.every((h) => h === 'q1.qlogo.cn' || h === 'p.qlogo.cn'), '头像只用 q1.qlogo.cn（成员）/ p.qlogo.cn（群徽标）', qlogoHosts.join(', '));
check(/https:\/\/q1\.qlogo\.cn\/g\?b=qq&nk=' \+ id \+ '&s=100/.test(html) && /memberAvatarUrl\(msg && msg\.userId\)/.test(html),
  '成员头像走 memberAvatarUrl()（QQ 号先过 /^\\d+$/ 校验，拼 q1.qlogo.cn）');


// ── 10.7 人设页：直接改正文（T33a）+ 新建角色卡（T33b） ──────────────────────
// 这一节盯的是「能改但改不坏」：写操作只从 apiWrite 出去、保存前有「不可撤销」确认、
// 后端 400/503 的原文透出、草稿不因一次失败或误切页签而丢。
console.log('## 人设编辑 / 新建');
const personaSection = (html.match(/<section data-page="persona"[\s\S]*?<\/section>/) ?? [''])[0];
check(/可切换当前角色、改正文、新建角色卡、改名、删除/.test(personaSection), '副标题补上「改正文、新建角色卡」');
check(/id="roleEditBtn" data-write="role-edit"/.test(html), '角色正文卡有「编辑」按钮（data-write="role-edit"）');
check(html.includes('class="qdb-textarea qdb-role-editor" id="roleContentInput"'), '编辑态换成等宽 textarea（#roleContentInput）');
check(/esc\(personaState\.draft\) \+ '<\/textarea>'/.test(html), '正文走 esc() 塞进 textarea（</textarea> 类注入被转义）');
check(/\.qdb-role-editor \{[\s\S]{0,140}?min-height: 420px/.test(html) && /\.qdb-role-editor \{[\s\S]{0,140}?resize: vertical/.test(html),
  '编辑域 min-height:420px 且可纵向拖高');
check(/id="roleEditCount"/.test(html) && /'字数 ' \+ numText\(n\)/.test(html) && /' \/ 上限 ' \+ numText\(personaState\.limitChars\)/.test(html),
  '工具行显示「字数 N / 上限 M」（上限取自接口 limits.injectMaxChars）');
check(/function roleAutoGrow\(el\)/.test(html) && /el\.style\.height = next \+ 'px'/.test(html), 'textarea 按内容自动撑高');
check(/apiWrite\('\/api\/roles\/update', \{ name: name, content: text \}\)/.test(html), '保存 POST /api/roles/update {name,content}');
check(/保存会覆盖「' \+ name \+ '」的正文，旧内容不可找回（不可撤销）/.test(html), '保存前二次确认写清「覆盖 + 旧内容不可找回」');
check(/id="roleSaveBtn"/.test(html) && /saveBtn\.textContent = '保存中…'/.test(html) && /saveBtn\.disabled = true/.test(html),
  '保存中按钮 disabled + 文案「保存中…」');
check(/id="roleWarnBar" role="status"/.test(html) && /class="qdb-role-warn"/.test(html) && /'<li>' \+ esc\(w\) \+ '<\/li>'/.test(html),
  'warnings 走正文卡顶部常驻条（逐条列出，不是 toast）');
check(/return roleWarnHtml\(\)\s*\+ '<div class="qdb-row"/.test(html), '常驻告警条排在正文 <pre> 之上');
check(/personaShowError\('保存失败：' \+ \(\(error && error\.message\) \|\| error\)\)/.test(html), '保存失败把后端 error 原文贴进工具行（不清空草稿）');
check(/function personaDirty\(\)/.test(html) && /有未保存的修改，确定丢弃？/.test(html), '脏草稿判定 + 「有未保存的修改，确定丢弃？」确认');
check(/function personaLeave\(what, work\)/.test(html) && /personaLeave\('换到「' \+ name \+ '」'/.test(html)
  && /personaLeave\('切到别的页签'/.test(html) && /personaLeave\('刷新人设页'/.test(html),
  '换角色 / 切页签 / 刷新都先过 personaLeave（确认后才动）');
check(/addEventListener\('beforeunload'/.test(html) && /ev\.returnValue = '人设正文有未保存的修改/.test(html), 'beforeunload 也拦一下（关窗不静默丢草稿）');
check(html.includes('data-write="role-create"') && /新建角色<\/button>/.test(html), '角色列表卡顶部有「新建角色」按钮');
check(/function openRoleCreateDialog\(\) \{[\s\S]{0,220}?mask\.className = 'qdb-dialog-mask'/.test(html)
  && /box\.className = 'qdb-dialog qdb-dialog-wide'/.test(html) && /data-role-create-ok/.test(html),
  '新建走自建弹层（沿用 qdb-dialog* 样式与底部按钮行）');
check(/id="roleNewName"[^>]*placeholder="例如：小鲸鱼"/.test(html), '弹层有名称输入（placeholder「例如：小鲸鱼」）');
check(/id="roleNewContent"/.test(html), '弹层有正文 textarea');
// ── 一句话生成角色卡（T34）：空白系统第一次打开就能用，回车即发，用途写在框上 ──
check(/function roleCraftHtml\(\)/.test(html) && /id="roleCraftInput"/.test(html) && /不用先懂角色卡的格式/.test(html),
  '人设页有「快速生成角色卡」输入框，并写明它是干什么的');
check(/return roleCraftHtml\(\) \+ '<div class="qdb-panel">/.test(html),
  '空白系统（还没有任何角色卡）时，这个输入框也在首屏');
check(/ev\.key !== 'Enter'/.test(html) && /roleCraftGenerate\(btn\)/.test(html) && /'role-craft': function \(btn\)/.test(html),
  '回车就能生成；按钮既走 data-write 委托也直绑 click（防容器 stopPropagation 静默失效）');
check(/function roleCraftGenerate\(btn\)/.test(html) && /apiWrite\('\/api\/roles\/generate', \{ request: ask \}\)/.test(html),
  '生成走 POST /api/roles/generate {request}');
// 「这次是模型写的还是本地拼的」要常驻：toast 会消失，重画人设页后状态行也得还在。
check(/var roleCraftLast = \{ source: '', modelError: '' \}/.test(html) && /function roleCraftPaintNote\(\)/.test(html)
  && /id="roleCraftSource"/.test(html) && /roleCraftPaintNote\(\); \/\/ 重画后/.test(html),
  '生成来源存在模块级状态里（重画人设页后状态行还在，不靠 toast）');
check(/if \(roleCraftLast\.source !== 'stub'\) return '';/.test(html) && /data-tone="warn"/.test(html),
  '只有 source === "stub" 才显示状态行，且用警告色（浅/深色都看得见）');
check(/这次是本地拼的（模型没连上：' \+ why \+ '）—— 骨架能用，细节要自己改/.test(html)
  && /roleCraftLast\.modelError = String\(\(data && data\.modelError\) \|\| ''\)/.test(html),
  '状态行带 modelError 原文（模型没连上的原因照实写出来）');
check(/var needAsk = !\(data && data\.current\)/.test(html) && /设为当前角色？/.test(html) && /apiWrite\('\/api\/role', \{ role: name \}\)/.test(html),
  '没有当前角色时才问「设为当前角色」，已有就只新建');
check(html.includes('不能含 / \\\\ : * ? " < > |'), '即时提示名称规则：不能含 / \\ : * ? " < > |');
check(/# 角色卡：' \+ String\(name[\s\S]{0,80}?roleSectionTemplate\(\)/.test(html) && /## 三、说话方式\\n- 短句，一两句一条/.test(html),
  '默认填入中文模板骨架（# 角色卡 + 一、你是谁 / 二、底色 / 三、说话方式）');
check(/apiWrite\('\/api\/roles\/create', \{ name: name, content: content \}\)/.test(html), '创建 POST /api/roles/create {name,content}');
check(/'创建失败：' \+ \(\(error && error\.message\) \|\| error\)/.test(html) && /function roleCreateError\(message\)/.test(html),
  '重名等 400 把后端原文显示在弹层里（弹层不关）');
check(/pageLoad\('persona', true\)\.then\(function \(\) \{ return selectRole\(created\); \}\)/.test(html) && /personaBeginEdit\(created\)/.test(html),
  '创建成功后刷新列表 + 自动选中新角色并进编辑态');
check(/function roleWriteDisabled\(\)/.test(html) && /当前为只读模式/.test(html) && /roleWriteDisabled\(\) \+ '>新建角色/.test(html),
  'writable:false 时编辑/新建按钮 disabled 并说明「当前为只读模式」');
check(/function roleNameProblem\(name\)/.test(html) && /var ROLE_NAME_BAD = /.test(html), '名称预校验只做「非空 / 非法字符 / 超长」，不发明更严规则');
check(/if \(!text\.trim\(\)\) \{ personaShowError\('人格内容不能为空/.test(html), '空正文前端先拦一次（与后端 validateRoleContent 同规则）');
check(html.includes('data-write="role-template"') && /roleSectionTemplate\(\)/.test(html), '编辑态工具行有「插入模板」');

// ── 10.9 文件库二期：清理「先预览 → 二次确认 → 才真删」+ 改分类 ──────────────
// 这一节盯的是「能删但删不错」：预览只发 dryRun、确认按钮必须是 danger、弹层文案写明不可撤销、
// 真删只发空 body、删完重拉数据并清掉预览；改分类同样只走 apiWrite。
console.log('## 文件库：素材卡（L2）');
check('文件库页并行拉 /api/library/assets', /api\('\/api\/library\/assets'\)/.test(js));
check('文库页有「素材（按件）」面板', /panelBox\('素材（按件）'/.test(js));
check('素材卡渲染函数 libraryAssetsHtml 存在', /function libraryAssetsHtml\(\)/.test(js));
check('素材卡封面用 thumbUrl + tokenQuery + lazy 加载', /a\.thumbUrl \+ tokenQuery\(\)/.test(js) && /loading="lazy"/.test(js));
check('没预览图时画「无预览」而不是空 img', /qdb-asset-noimg/.test(js) && /无预览/.test(js));
check('没认出商品号时显示「未认号」', /qdb-asset-noid/.test(js) && /未认号/.test(js));
check('素材卡能「在文件夹里看」（走 open-folder + data-rel）', /data-write="open-folder"/.test(js) && /data-rel="/.test(js));
check('头部统计报件数/体积/有号/有封面', /'共 ' \+ numText\(d\.count\)/.test(js) && /有号 ' \+ numText\(d\.withBooth\)/.test(js));
check('散文件与「台账有盘上没了」会单独提示', /散文件/.test(js) && /台账有、盘上没了/.test(js));
check('素材卡网格用 auto-fill minmax，窄屏自动变两列', /\.qdb-asset-grid \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(196px, 1fr\)\)/.test(css));
check('素材卡封面 16:10 + object-fit cover', /\.qdb-asset-thumb \{ position: relative; aspect-ratio: 16 \/ 10/.test(css) && /\.qdb-asset-cover \{[^}]*object-fit: cover/.test(css));

console.log('## 文件库：筛选 / 搜索 / 停止 / 重试 / 商品页');
check('libraryState 记住筛选、搜索词、排序与翻页位置（filter/query/sort/offset/loading）',
  /filter: 'all',\s+\/\/ 素材筛选/.test(js) && /query: '',\s+\/\/ 素材搜索词/.test(js)
  && /sort: 'recent',\s+\/\/ 排序/.test(js) && /offset: 0,/.test(js) && /loading: false,/.test(js));
check('筛选胶囊五个值都带 data-library-filter，状态写进 aria-pressed',
  /data-library-filter="' \+ it\[0\] \+ '" aria-pressed="/.test(js)
  && /\[\['all', '全部'\], \['no-booth', '未认号'\], \['no-cover', '无封面'\], \['suggested', '待确认建议'\], \['bound', '手动绑定'\], \['with-password', '有解压码'\], \['rj', '有 RJ'\]\]/.test(js));
check('排序三档走 libSort 下拉（recent / title / booth），选中态来自 libraryState.sort',
  /var LIBRARY_SORTS = \[\['recent', '最近'\], \['title', '按名字'\], \['booth', '有号在前'\]\]/.test(js)
  && /id="libSort"/.test(js) && /libraryState\.sort === it\[0\] \? ' selected' : ''/.test(js));
check('拉素材带服务端参数：limit / offset / filter / sort，搜索词非空才带 q',
  /'\/api\/library\/assets' \+ qs/.test(js) && /var limit = libraryPageNum\(LIBRARY_PAGE, 24, 1, 500\)/
  && /var offset = libraryPageNum\(append \? libraryState\.offset : 0, 0, 0, 1000000\)/
  && /'\?limit=' \+ limit \+ '&offset=' \+ offset/.test(js)
  && /'&filter=' \+ encodeURIComponent\(libraryState\.filter\) \+ '&sort=' \+ encodeURIComponent\(libraryState\.sort\)/.test(js)
  && /if \(libraryState\.query\) qs \+= '&q=' \+ encodeURIComponent\(libraryState\.query\)/.test(js));
check('胶囊数字优先用后端全库 counts（all/noBooth/noCover/suggested/bound）',
  /var s = d\.counts;/.test(js) && /all: Number\(s\.all\) \|\| 0/.test(js) && /'no-booth': Number\(s\.noBooth\) \|\| 0/.test(js)
  && /suggested: Number\(s\.suggested\) \|\| 0/.test(js) && /bound: Number\(s\.bound\) \|\| 0/.test(js));
{
  // 把页面里的 libraryPageNum 抽出来真跑一遍：0 / 2.7 / 负数都必须被夹成合法整数。
  let clamp = null;
  try {
    const fnText = (js.match(/function libraryPageNum\(value, fallback, min, max\) \{[\s\S]*?\n  \}/) || [''])[0];
    clamp = new Function(fnText + '; return libraryPageNum;')();
  } catch (e) { clamp = null; }
  check('limit / offset 取整并夹住：0→1、2.7→2、-3→0、900→上限',
    typeof clamp === 'function' && clamp(0, 24, 1, 500) === 1 && clamp(2.7, 24, 1, 500) === 2
    && clamp(-3, 0, 0, 1000000) === 0 && clamp(900, 24, 1, 500) === 500 && clamp('abc', 24, 1, 500) === 24);
}
check('搜索 250ms 防抖：输入时先清上一次定时器，到点才发请求',
  /if \(libSearchTimer\) \{ window\.clearTimeout\(libSearchTimer\); libSearchTimer = null; \}/.test(js)
  && /libSearchTimer = window\.setTimeout\(function \(\) \{ libSearchTimer = null; libraryLoad\(false\); \}, 250\)/.test(js));
check('后端没接住筛选时退回前端过滤：回显的 filter 必须与请求一致（否则会把全量当结果）',
  /function libraryServerFiltered\(\) \{[\s\S]*?typeof d\.total !== 'number' \|\| typeof d\.filter !== 'string'/.test(js)
  && /return d\.filter === want \|\| \(want !== 'all' && d\.filter !== 'all'\)/.test(js)
  && /if \(f === 'no-booth' && a\.boothId\) return false;/.test(js)
  && /if \(f === 'suggested' && !\(a\.suggestion && !a\.boothId\)\) return false;/.test(js)
  && /if \(f === 'bound' && a\.boothSource !== 'bind'\) return false;/.test(js));
check('本地兜底时计数按「可见 / 总数」显示',
  /'显示 ' \+ numText\(visible\) \+ ' \/ ' \+ numText\(total\) \+ ' 件'/.test(js)
  && /var counts = libraryFilterCounts\(Array\.isArray\(list\) \? list : \[\]\)/.test(js));
check('后端已经按 filter 筛过、但没回显时，不拿本页条数冒充全库：「全部」用记住的 allTotal，其余留空',
  /function libraryPageIsFullSet\(\)/.test(js) && /if \(typeof d\.filter === 'string'\) return d\.filter === 'all'/.test(js)
  && /if \(!libraryPageIsFullSet\(\)\) return \{ all: libraryState\.allTotal \|\| null/.test(js)
  && /libraryState\.allTotal = libraryTotal\(\);/.test(js)
  && /counts\[it\[0\]\] == null \? '' : ' ' \+ numText\(counts\[it\[0\]\]\)/.test(js));
check('搜索按标题/商品号/目录过滤（兜底路径，先转小写再 indexOf）',
  /\[a\.title, a\.mainName, a\.dir, a\.boothId, a\.meta && a\.meta\.title\]/.test(js) && /\.toLowerCase\(\)\.indexOf\(q\) >= 0/.test(js));
check('筛选/排序/搜索都重新拉一页（setLibraryFilter / setLibrarySort / setLibraryQuery 都调 libraryLoad(false)）',
  /function setLibraryFilter\(filter\)[\s\S]*?return libraryLoad\(false\);/.test(js)
  && /function setLibrarySort\(sort\)[\s\S]*?return libraryLoad\(false\);/.test(js));
check('筛选只重画卡片区（#libGrid + 计数 + 更多行 + 胶囊），不整页重画',
  /id="libGrid"/.test(js) && /function libraryRepaint\(\)[\s\S]*?byId\('libGrid'\)[\s\S]*?byId\('libCount'\)[\s\S]*?byId\('libMore'\)/.test(js));
check('搜索框是 #libSearch，走 input 委托（打字不丢焦点）',
  /id="libSearch"/.test(js) && /ev\.target\.id === 'libSearch'\) setLibraryQuery\(ev\.target\.value\)/.test(js) && /closest\('\[data-library-filter\]'\)/.test(js));
check('「加载更多」按 offset 追加到现有数组，并按键去重（不整页重画）',
  /data-write="library-load-more"/.test(js) && /libraryState\.assets\.assets\.concat\(got\.filter\(function \(a\) \{ return !seen\[a\.key\]; \}\)\)/.test(js)
  && /libraryState\.offset = \(Number\.isFinite\(off\) \? off : libraryState\.offset\) \+ got\.length;/.test(js));
check('截断提示：truncated 为真或 total > 已显示时写「只显示前 N 件（共 M 件）」',
  /d\.truncated === true \|\| total > shown/.test(js) && /只显示前 ' \+ numText\(shown\) \+ ' 件（共 ' \+ numText\(total\) \+ ' 件）/.test(js));
check('空结果给「没有符合筛选的素材，换个条件试试」+ 一键清空筛选',
  /没有符合筛选的素材，换个条件试试。/.test(js) && /data-write="library-clear-filters"/.test(js)
  && /function libraryClearFilters\(\) \{[\s\S]*?libraryState\.filter = 'all';[\s\S]*?libraryState\.query = '';/.test(js));
check('排序下拉的 change 监听只绑一次（重画页面不重复绑）',
  /var libToolbarBound = false;/.test(js) && /if \(libToolbarBound\) return;/.test(js) && /el\.id === 'libSort'\) setLibrarySort\(el\.value\)/.test(js));
check('每张卡都有「改号」，弹层预填当前号并调 POST /api/library/bind',
  /data-write="library-bind-manual" data-key="' \+ esc\(a\.key\)/.test(js)
  && /title: '手动改商品号'/.test(js) && /name: 'boothId', label: 'BOOTH 商品号', value: cur/.test(js)
  && /\{ name: 'title', label: '标题（可选）'/.test(js)
  && /apiWrite\('\/api\/library\/bind', body\)/.test(js) && /if \(!\/\^\\d\{5,9\}\$\/\.test\(id\)\)/.test(js));
check('三个新按钮都注册进 WRITE_ACTIONS（01-shell）',
  /'library-load-more': function \(btn\)/.test(js) && /'library-clear-filters': function \(btn\)/.test(js)
  && /'library-bind-manual': function \(btn\)/.test(js));
check('「停止」只在批量找号跑着的时候出现，且走 data-write', /batch && batch\.running\s*\n?\s*\? '<button class="qdb-btn qdb-btn-mini" type="button" data-write="library-batchfind-stop"/.test(js));
check('停止按钮发 POST /api/library/batchfind/stop 并提示「正在跑的那件会先跑完」',
  /apiWrite\('\/api\/library\/batchfind\/stop', \{\}\)/.test(js) && /已请求停止，正在跑的那件会先跑完/.test(js));
check('「重搜还没号的 N 件」按 key 显式重搜，N=0 或跑着时 disabled',
  /data-write="library-retry-skipped"/.test(js) && /重搜还没号的 ' \+ numText\(retryKeys\.length\) \+ ' 件/.test(js)
  && /libraryRetryKeys\(list\)/.test(js) && /\(retryKeys\.length && !\(batch && batch\.running\) \? '' : ' disabled'\)/.test(js));
check('重试只挑「既没号也没建议」的素材，并把 keys 传给批量找号接口',
  /!a\.boothId && !a\.suggestion/.test(js) && /apiWrite\('\/api\/library\/batchfind', \{ keys: keys \}\)/.test(js));
check('有 meta.itemUrl 时给「复制商品页」（走 data-copy，不新开标签）',
  /data-copy="' \+ esc\(meta\.itemUrl\)/.test(js) && /复制商品页/.test(js) && !/target="_blank"[^>]*data-copy/.test(js));
console.log('## 文件库：手动改名（改磁盘目录 + 主包，先预览再确认）');
check('只有「有号」的素材才有「改名」按钮，且挂 data-write="library-rename" + data-key',
  /function libraryRenameButton\(a\) \{[\s\S]*?if \(!a\.boothId\) return '';/.test(js)
  && /data-write="library-rename" data-key="' \+ esc\(a\.key\)/.test(js)
  && /\+ libraryRenameButton\(a\)/.test(js));
check('点改名先发 POST /api/library/rename/preview 拿方案（只读；ok:false 时也要拿到 plan.reason，所以自己发这一发）',
  /function renamePreview\(key\)/.test(js) && /var verb = 'POST';/.test(js)
  && /fetch\('\/api\/library\/rename\/preview', \{ method: verb, headers: headers, cache: 'no-store', body: JSON\.stringify\(\{ key: key \}\) \}\)/.test(js)
  && /return d \|\| \{ ok: false, reason: '响应为空，刷新一下再试' \}/.test(js));
check('弹层有目标名输入框，预填 plan.to.dir 的末段，上限 60 字',
  /var RENAME_NAME_MAX = 60;/.test(js) && /var name = String\(to\.dir \|\| ''\)\.split\(\/\[\\\/\]\/\)\.filter\(Boolean\)\.pop\(\) \|\| '';/.test(js)
  && /id="renameName" type="text" maxlength="' \+ RENAME_NAME_MAX \+ '"/.test(js));
check('逐条列出「旧路径 → 新路径」，长路径中间省略',
  /moves\.map\(function \(m\) \{[\s\S]*?renameShortPath\(m\.from\)[\s\S]*?renameShortPath\(m\.to\)/.test(js)
  && /function renameShortPath\(p\) \{[\s\S]*?slice\(0, 28\) \+ '…' \+ s\.slice\(-28\)/.test(js));
check('不可改时显示后端 reason 且「确认改名」禁用',
  /var blocked = !d \|\| d\.ok === false \|\| Boolean\(d\.reason\);/.test(js)
  && /'这次改不了：' \+ esc\(String\(d\.reason/.test(js)
  && /data-rename-ok' \+ \(blocked \? ' disabled' : ''\)/.test(js));
check('确认后发 POST /api/library/rename { key, name }，toast 带实际改了 N 项并整页重拉',
  /apiWrite\('\/api\/library\/rename', \{ key: key, name: wanted \}\)/.test(js)
  && /'已改名' \+ \(n \? '（' \+ n \+ ' 项）' : ''\)/.test(js) && /return pageLoad\('library', true\);/.test(js));
check('目标名本地校验：空 / 超 60 字 / 含路径非法字符都不提交',
  /if \(!wanted\) \{ fail\('目标名不能为空'\); return; \}/.test(js)
  && /if \(wanted\.length > RENAME_NAME_MAX\) \{ fail\('目标名最多 ' \+ RENAME_NAME_MAX \+ ' 个字'\); return; \}/.test(js)
  && /if \(\/\[\\\/:\*\?"<>|\]\/\.test\(wanted\)\) \{ fail\('目录名里不能有/.test(js));
check('后端给了 renamed 才显示「已改名」chip（没给就不编）',
  /if \(a\.renamed === true\) chips\.push/.test(js) && /已改名<\/span>/.test(js));
check('改名按钮注册进 WRITE_ACTIONS（01-shell）', /'library-rename': function \(btn\)/.test(js));
check('「撤销改名」按钮只在 renamed 时出现，并准备 data-write="library-rename-undo" + data-key',
  /data-write="library-rename-undo" data-key="/.test(js) && /if \(a\.renamed === true\) \{/.test(js));
check('撤销先二次确认，再 POST /api/library/rename/undo { key }',
  /title: '撤销改名'/.test(js) && /把目录和主包名改回上一次的名字/.test(js)
  && /apiWrite\('\/api\/library\/rename\/undo', \{ key: key \}\)/.test(js));
check('撤销成功 toast「已撤销改名」（迁回绑定再补一句）并整页重拉',
  /已撤销改名' \+ \(r && r\.bindMigrated \? '（绑定已迁回）' : ''\)/.test(js) && /title: '撤销改名'[\s\S]*?return pageLoad\('library', true\);/.test(js));
check('撤销失败把后端 error 原文透出来（不只显示「失败」）',
  /apiWrite\('\/api\/library\/rename\/undo'[\s\S]*?replace\(\/\^HTTP \d\+ · \/, ''\), 'err'\)/.test(js));
check('改名预览自动补号前缀时给灰字提示（prefixed → 「名字前面会自动带上 BOOTH 号：<号>_<新名>」）',
  /!blocked && d && d\.prefixed \? '<p class="qdb-hint" id="renamePrefixed">名字前面会自动带上 BOOTH 号：' \+ esc\(name\)/.test(js));
check('撤销改名按钮注册进 WRITE_ACTIONS（01-shell）', /'library-rename-undo': function \(btn\)/.test(js));

console.log('## 素材卡信息条 + 补封面（对照 BOOTH 商品页）');
check('卡片信息条挂在标题下（+ libraryCardChips(a)），字段全来自 payload',
  /\+ libraryCardChips\(a\)/.test(js) && /<div class="qdb-asset-chips">/.test(js)
  && /function libraryCardChips\(a\)/.test(js));
check('扩展名从 mainName 末段取并转大写（ZIP / RAR / 7Z…）',
  /var m = \/\.\(\[A-Za-z0-9\]\{1,6\}\$\/\.exec\(name\)/.test(js) && /return m \? m\[1\]\.toUpperCase\(\) : '';/.test(js));
check('大小用 bytes 现有格式化（bytesText），文件数 > 1 才写「N 个文件」',
  /esc\(bytesText\(a\.bytes\)\)/.test(js) && /var files = Number\(a\.files\);/.test(js)
  && /if \(files > 1\) chips\.push/.test(js) && /numText\(files\) \+ ' 个文件'/.test(js));
check('分类 / 标签只读 meta.category 与 meta.tags，标签最多 4 个、多出的折成 +N',
  /if \(meta && meta\.category\) chips\.push/.test(js) && /var LIB_TAG_MAX = 4;/.test(js)
  && /meta\.tags\.filter\(Boolean\)\.map\(String\)/.test(js) && /tags\.slice\(0, LIB_TAG_MAX\)/.test(js)
  && /numText\(tags\.length - LIB_TAG_MAX\)/.test(js));
check('信息条样式：.qdb-asset-chips 可换行 + .qdb-asset-chip 小号弱化，窄屏并入 768 块',
  /\.qdb-asset-chips \{ display: flex; flex-wrap: wrap;/.test(css) && /\.qdb-asset-chip \{[^}]*font-size: 11px;/.test(css)
  && /@media \(max-width: 768px\) \{[\s\S]*?\.qdb-asset-chip \{ font-size: 10\.5px; padding: 1px 6px; \}/.test(css));
check('工具栏有「补封面」按钮 + 进度灰字 #libraryCoversHint',
  /data-write="library-covers"/.test(js) && /id="libraryCoversHint"/.test(js) && /\+ libraryCoversButton\(\)/.test(js));
check('补封面发 POST /api/library/covers/backfill { limit: 20 }',
  /apiWrite\('\/api\/library\/covers\/backfill', \{ limit: 20 \}\)/.test(js));
check('2 秒轮询 GET /api/library/covers，running 时继续、结束后刷新卡片',
  /var LIB_COVER_POLL_MS = 2000;/.test(js) && /api\('\/api\/library\/covers'\)/.test(js)
  && /if \(libraryCoversState\.running\) \{ libraryCoversPoll\(\); return null; \}/.test(js)
  && /toast\('补封面完成', 'ok'\);/.test(js) && /return pageLoad\('library', true\);/.test(js));
check('运行中按钮显示「补封面中…」并出现可点的停止按钮（POST /api/library/covers/stop）',
  /libraryCoversState\.running \? '补封面中…' : '补封面'/.test(js) && /data-write="library-covers-stop"/.test(js)
  && /apiWrite\('\/api\/library\/covers\/stop', \{\}\)/.test(js));
check('接口 404 时给一句人话，不静默',
  /\/404\|not found\/i\.test\(msg\) \? '后端还没上线补封面（接口 404）'/.test(js));
check('补封面两个 action 都注册进 WRITE_ACTIONS（01-shell）',
  /'library-covers': function \(btn\)/.test(js) && /'library-covers-stop': function \(btn\)/.test(js));
console.log('## 合并同号：已合并卡 + 拆分 + 提案弹层');
check('合并后的卡（mergedCount > 1）才有「已合并 N 项」chip 和拆分按钮',
  /function libraryMergeRow\(a\) \{[\s\S]*?var n = Number\(a && a\.mergedCount\);[\s\S]*?if \(!\(n > 1\)\) return '';/.test(js)
  && /已合并 ' \+ numText\(n\) \+ ' 项/.test(js) && /data-write="library-merge-split"/.test(js)
  && /data-merge="' \+ esc\(a\.mergeId \|\| ''\)/.test(js) && /\+ libraryMergeRow\(a\)/.test(js));
check('工具栏有「合并同号」按钮（走 data-write）',
  /function libraryMergeButton\(\)/.test(js) && /data-write="library-merge"/.test(js) && /\+ libraryMergeButton\(\)/.test(js));
check('先 GET /api/library/merges 拿 proposals，没有候选就给一句人话',
  /return api\('\/api\/library\/merges'\)\.then/.test(js) && /Array\.isArray\(d\.proposals\)/.test(js)
  && /没有可以合并的（同一个号只有一件）/.test(js));
check('提案弹层逐条列「#号 · N 项 · 大小」+「主件：<名字>」，默认全选可多选',
  /libraryMergeLines\(proposals\)/.test(js) && /qdb-merge-pick" data-i="' \+ i \+ '" checked/.test(js)
  && /'#' \+ esc\(p\.boothId\) \+ ' · ' \+ numText\(\(p\.keys \|\| \[\]\)\.length\) \+ ' 项 · '/.test(js)
  && /主件：' \+ esc\(title\)/.test(js) && /boxes\[i\]\.checked/.test(js));
check('主件名从当前卡片里按 primaryKey 找（找不到退回键前 8 位，不编名字）',
  /function libraryMergeTitleOf\(key\)/.test(js) && /\(meta && meta\.title\) \|\| hit\.title \|\| hit\.mainName/.test(js)
  && /'键 ' \+ String\(p\.primaryKey \|\| ''\)\.slice\(0, 8\)/.test(js));
check('确认后逐组 POST /api/library/merge { boothId, keys, primaryKey }，成功报「已合并 N 组」并重拉',
  /apiWrite\('\/api\/library\/merge', \{ boothId: p\.boothId, keys: p\.keys, primaryKey: p\.primaryKey \}\)/.test(js)
  && /已合并 ' \+ numText\(done\) \+ ' 组/.test(js) && /if \(done\) return pageLoad\('library', true\);/.test(js));
check('拆分发 POST /api/library/merge/split { mergeId }',
  /apiWrite\('\/api\/library\/merge\/split', \{ mergeId: mergeId \}\)/.test(js) && /已拆分，恢复成多件素材/.test(js));
check('合并接口 404 时有兜底人话，不静默',
  /\/404\|not found\/i\.test\(msg\) \? '后端还没上线合并同号（接口 404）'/.test(js));
check('两个合并 action 都注册进 WRITE_ACTIONS（01-shell）',
  /'library-merge': function \(btn\)/.test(js) && /'library-merge-split': function \(btn\)/.test(js));
check('合并提案行样式：.qdb-merge-row 可换行 + 已合并 chip 用强调色',
  /\.qdb-merge-row \{ display: flex; flex-wrap: wrap;/.test(css) && /\.qdb-asset-chip\[data-kind="merge"\]/.test(css));

console.log('## 合并卡的「打开」：先列成员再逐个开文件夹');
check('合并卡（mergedCount > 1）的「打开」走成员弹层，不再直接开一个目录',
  /Number\(a\.mergedCount\) > 1[\s\S]{0,160}?data-write="library-open-merged"/.test(js)
  && /'library-open-merged': function \(btn\)/.test(js));
check('未合并的卡仍然直接开自己的文件夹（open-folder + data-rel=a.dir）',
  /data-write="open-folder" data-rel="'[\s\S]{0,120}?esc\(a\.dir \|\| ''\)/.test(js));
check('成员弹层逐行给 标题 / 目录 / 主包名 / 文件数与体积 / 打开按钮',
  /function libraryMergeMemberRow\(m, i\)/.test(js)
  && /esc\(dir\) \+ \(main \? ' · ' \+ esc\(main\) : ''\)/.test(js)
  && /numText\(files\) \+ ' 个文件'/.test(js)
  && /data-write="open-folder" data-rel="' \+ esc\(dir\)/.test(js));
check('主成员那一行标「主件」，其它成员不标',
  /main = String\(m\.mainName[\s\S]{0,400}?\(i === 0 \|\| m\.primary\) \? ' <span class="qdb-tag">主件<\/span>' : ''/.test(js));
check('成员数据缺失时给主成员兜底 + 一句人话（老后端没 mergedMembers 也不崩）',
  /Array\.isArray\(a && a\.mergedMembers\)/.test(js) && /function libraryMergeMembers\(a\)/.test(js)
  && /后端还没下发成员明细（重启桥接后会有）/.test(js));
check('files 两种形态都兜底：卡上 chip 与成员行都认「数字或数组」',
  /Array\.isArray\(a\.files\) \? a\.files\.length : Number\(a\.files\)/.test(js)
  && /Array\.isArray\(m\.files\) \? m\.files\.length : Number\(m\.files\) \|\| 0/.test(js));

console.log('## 名单编辑面：占位号展示与单删');
check(/function listsPlaceholders\(\) \{[\s\S]{0,420}?d\.placeholderKeys\[listState\.tab\]/.test(js)
  && /Array\.isArray\(v\) \? v : \(v && Array\.isArray\(v\.keys\) \? v\.keys : \[\]\)/.test(js),
  '占位号从 placeholderKeys 取，两种形态都认，且不塞进可编辑的 entries');
check(/qdb-chip qdb-list-ph-chip/.test(js) && /qdb-list-ph-auto">auto</.test(js) && /\.qdb-list-ph-chip \{ display: inline-flex;[^}]*opacity: \.72; \}/.test(css),
  '编辑面整行淡显 + 标 auto（不塞进表格本体）');
check(/占位号删了不会影响识别，只是不再自动提醒/.test(js) && /confirmLabel: '删掉'/.test(js) && /danger: true/.test(js),
  '删除走二次确认，并说明删了不影响识别');
check(/action: 'remove', list: tab, id: id/.test(js)
  && /'lists-placeholder-del': function \(btn\) \{ return runWrite\(btn, function \(\) \{ return listsPlaceholderDel\(btn\); \}\); \}/.test(js),
  '单删走 POST /api/lists remove，并在 WRITE_ACTIONS 注册（防连点）');


console.log('## 素材卡：解压码 / RJ / 类型标签 / 来源（07i）');
check('新片段 07i 提供 libraryExtraChips，并被信息条在「已改名」之前调用',
  /function libraryExtraChips\(a\) \{/.test(js)
  && js.indexOf('var extraChips = libraryExtraChips(a);') >= 0
  && js.indexOf('var extraChips = libraryExtraChips(a);') < js.indexOf('if (a.renamed === true) {'));
check('解压码 chip 可点复制：data-copy 带密码本体、title 写「复制这个密码」',
  /if \(pw\) chips\.push\(libCopyChip\('解压码 ' \+ pw, pw, '复制这个密码'\)\)/.test(js)
  && /function libCopyChip\(label, value, title\)/.test(js)
  && /data-copy="' \+ esc\(value\)/.test(js));
check('RJ 号 chip：没有 RJ 前缀时自动补，点击复制的是完整号',
  /return \/\^RJ\/i\.test\(v\) \? v\.toUpperCase\(\) : 'RJ' \+ v\.replace\(\/\^RJ\/i, ''\)/.test(js)
  && /if \(rj\) chips\.push\(libCopyChip\(rj, rj, '复制 RJ 号'\)\)/.test(js));
check('类型标签最多 2 个 chip，title 列全，且与 BOOTH 自带 tags 去重',
  /var LIB_TYPE_TAG_MAX = 2;/.test(js) && /tags\.slice\(0, LIB_TYPE_TAG_MAX\)/.test(js)
  && /if \(metaTags\.indexOf\(tag\) >= 0\) return;/.test(js)
  && /data-kind="tag" title="' \+ esc\(tags\.join\(' \/ '\)\)/.test(js));
check('来源 chip 过滤掉填充值「未知」',
  /return \(!v \|\| v === '未知'\) \? '' : v;/.test(js) && /if \(src\) chips\.push\('<span class="qdb-asset-chip" title="来源">'/.test(js));
check('两档筛选接进 LIBRARY_FILTERS，且前端兜底过滤走 libraryTagFilterOf',
  /\['with-password', '有解压码'\], \['rj', '有 RJ'\]/.test(js)
  && /if \(libraryTagFilterOf\(a\) === false\) return false;/.test(js)
  && /if \(f === 'with-password'\) return !!libArchivePassword\(a\);/.test(js)
  && /if \(f === 'rj'\) return !!libRjCode\(a\);/.test(js));
check('两档数字优先用后端 counts.withPassword / counts.rj，缺字段留空而不是 0',
  /var tags = libraryTagCountsServer\(d\);/.test(js)
  && /'with-password': tags \? tags\['with-password'\] : null/.test(js)
  && /rj: tags \? tags\.rj : null/.test(js)
  && /var pw = Number\(s\.withPassword\);/.test(js)
  && /Number\.isFinite\(pw\) \? pw : null/.test(js));
check('本地兜底数只在这一页是全集时才算（libraryPageIsFullSet 分支）',
  /if \(!libraryPageIsFullSet\(\)\) \{[\s\S]{0,220}?'with-password': null, rj: null/.test(js)
  && /var localTags = libraryTagCounts\(list\);/.test(js)
  && /'with-password': localTags\['with-password'\],/.test(js));
check('可复制 chip 是按钮态样式（.qdb-asset-chip-copy 有 hover）',
  /\.qdb-asset-chip-copy \{ cursor: pointer;/.test(css) && /\.qdb-asset-chip-copy:hover \{/.test(css));

console.log('## 工程使用统计（07j）');
check('新片段 07j 提供 libUsageChip，并被信息条末尾（来源之后）调用',
  /function libUsageChip(a) {/.test(js)
  && js.indexOf('chips.push(libUsageChip(a));') >= 0
  && js.indexOf('chips.push(libUsageChip(a));') > js.indexOf("title=\"来源\""));
check('chip 文案「工程在用 ×N」，点击打开详情弹层（data-write + data-key）',
  /'">工程在用 ×' \+ numText\(ps\.length\)/.test(js)
  && /data-write="library-usage-detail" data-key="/.test(js));
check('usage 走 GET /api/library/usage，进文件库页时异步拉、不挡渲染',
  /api\('\/api\/library\/usage'\)/.test(js)
  && /libUsageLoad\(\);/.test(js));
check('扫描按钮 → POST /api/library/usage/scan，运行中按钮置灰并 4 秒轮询',
  /apiWrite\('\/api\/library\/usage\/scan', \{\}\)/.test(js)
  && /var LIB_USE_POLL_MS = 4000;/.test(js)
  && /btn\.textContent = running \? '扫描中…' : '扫描工程'/.test(js));
check('有停止按钮 → POST /api/library/usage/stop，且只在 running 时显示',
  /apiWrite\('\/api\/library\/usage\/stop', \{\}\)/.test(js)
  && /if \(stop\) stop\.hidden = !running;/.test(js));
check('没配扫描根时提示 + 给「去配置」入口（写 fileArchive.usageRoots）',
  /d\.rootsConfigured === false/.test(js) && /d\.ok !== false \? d : null/.test(js)
  && /data-write="usage-roots-edit"/.test(js)
  && /'fileArchive\.usageRoots': roots/.test(js) && /apiWrite\('\/api\/config', \{ patch:/.test(js));
check('详情列工程名/路径/证据/时间，并标注「按文件名/目录名文本匹配，重名素材可能误报」',
  /qdb-usage-proj-path/.test(js) && /qdb-usage-proj-ev/.test(js)
  && js.indexOf('按文件名/目录名文本匹配，重名素材可能误报，请按证据核对。') >= 0);
check('整页重画后状态条重新填（renderLibrary 末尾调 libUsagePaint）',
  js.indexOf('libUsagePaint();') >= 0
  && js.indexOf('libUsagePaint();') > js.indexOf('function renderLibrary(host) {')
  && js.indexOf('libUsagePaint();') < js.indexOf('function pageLibrary(view, host) {'));
check('四个写 action 都在 WRITE_ACTIONS 里注册',
  /'library-usage-scan':/.test(js) && /'library-usage-stop':/.test(js)
  && /'library-usage-detail':/.test(js) && /'usage-roots-edit':/.test(js));
check('工具栏状态条与详情工程行的样式存在且可换行',
  /\.qdb-usage-tool \{ display: inline-flex;/.test(css)
  && /\.qdb-usage-proj-path \{[^}]*overflow-wrap: anywhere;/.test(css)
  && /\.qdb-usage-proj-ev \{[^}]*overflow-wrap: anywhere;/.test(css));

console.log('## 素材回收站（07k）');
check('素材卡每件都有「回收站」按钮（data-write=library-trash-one + data-key），插在动作行末尾',
  /function libraryTrashButton\(a\) \{/.test(js)
  && /data-write="library-trash-one" data-key="/.test(js)
  && js.indexOf('+ libraryTrashButton(a)') > js.indexOf('data-write="open-folder"'));
check('点「回收站」先弹 openDialog 二次确认：可以恢复、不会直接删除文件',
  /title: '移到回收站'/.test(js) && js.indexOf('可以恢复，不会直接删除文件') >= 0
  && /confirmLabel: '移到回收站'/.test(js));
check('确认后 POST /api/library/trash { keys: [key] }，toast「已移到回收站：N 件」并重拉列表',
  /apiWrite\('\/api\/library\/trash', \{ keys: \[key\] \}\)/.test(js)
  && /'已移到回收站：' \+ numText\(/.test(js)
  && /return libraryLoad\(false\);/.test(js));
check('工具栏有「回收站」入口（data-write=library-trash-open），弹层列表走只读 GET /api/library/trash',
  /function libraryTrashOpenButton\(\)/.test(js) && /data-write="library-trash-open"/.test(js)
  && /api\('\/api\/library\/trash'\)/.test(js));
check('弹层头部「回收站 N 件 · 共 X」用 count/totalBytes + bytesText',
  /'回收站 ' \+ numText\(st\.count\) \+ ' 件 · 共 ' \+ bytesText\(st\.totalBytes\)/.test(js));
check('每行有标题 / #号 / 大小 / 文件数 / 移入时间；不能恢复的显示实话而不是恢复按钮',
  /data-trash-id="/.test(js) && /esc\(bytesText\(it\.bytes\)\)/.test(js)
  && /移入 ' \+ esc\(libTrashWhen\(it\.at\)\)/.test(js)
  && /it\.restorable === false/.test(js) && /原文件不在了/.test(js));
check('「恢复」→ POST /api/library/trash/restore { id }，重拉弹层与素材列表',
  /data-trash-restore="/.test(js) && /apiWrite\('\/api\/library\/trash\/restore', \{ id: id \}\)/.test(js)
  && /libTrashLoad\(\)\.then\(function \(\) \{ return libraryLoad\(false\); \}\)/.test(js));
check('「彻底删除」二次确认（danger + 不可撤销）→ POST /purge { id, confirm: true }',
  /data-trash-purge="/.test(js) && /title: '彻底删除'/.test(js) && /danger: true/.test(js)
  && /彻底删除不可撤销/.test(js)
  && /apiWrite\('\/api\/library\/trash\/purge', \{ id: id, confirm: true \}\)/.test(js));
check('「清空 30 天前」二次确认 → POST /purge { olderThanDays, confirm: true }',
  /data-trash-purge-old="30"/.test(js) && /清空 30 天前/.test(js)
  && /清空 ' \+ numText\(n\) \+ ' 天前的回收站/.test(js)
  && /apiWrite\('\/api\/library\/trash\/purge', \{ olderThanDays: n, confirm: true \}\)/.test(js));
check('空回收站显示「回收站是空的」，且不显示点了没反应的「清空 30 天前」',
  /'<p class="qdb-hint">回收站是空的<\/p>'/.test(js)
  && /st\.items\.length \? '<button[^']*data-trash-purge-old/.test(js));
check('弹层可关闭：关闭按钮 / Esc / 点遮罩，且 role=dialog + aria-label',
  /data-trash-close="1"/.test(js) && /aria-label="素材回收站"/.test(js)
  && /ev\.key === 'Escape'/.test(js) && /ev\.target === mask\) close\(\)/.test(js));
check('两个写 action 都在 WRITE_ACTIONS 里注册（移入 / 开弹层）',
  /'library-trash-one': function \(btn\)/.test(js) && /'library-trash-open': function \(\)/.test(js));
check('回收站行样式存在（行内两端对齐 + 标题可换行 + 动作区不挤）',
  /\.qdb-trash-row \{[^}]*justify-content: space-between/.test(css)
  && /\.qdb-trash-title \{[^}]*overflow-wrap: anywhere;/.test(css)
  && /\.qdb-trash-acts \{/.test(css));

console.log('## 文件库卡对账摘要（02-dashboard）');
check('仪表盘「文件库」卡脚部有对账摘要：已购 / 库里对上 / 缺少 / 未登记，来自只读 GET /api/library/reconcile',
  /function libRecLine\(stats\)/.test(js)
  && /'已购 ' \+ numText\(stats\.purchased\)/.test(js)
  && /'库里对上 ' \+ numText\(stats\.matched\)/.test(js)
  && /'未登记 ' \+ numText\(stats\.extra\)/.test(js)
  && js.indexOf("api('/api/library/reconcile')") >= 0
  && js.indexOf("insertAdjacentHTML('beforeend', libRecLine(") >= 0);
check('缺少 > 0：警告色按钮 + data-goto="library"，点后切文件库并打开已购库弹层',
  /qdb-reconcile-missing/.test(js)
  && /data-goto="library" data-lib-reconcile-missing="/.test(js)
  && /typeof libraryPurchasesOpen === 'function'/.test(js));
check('对账接口 404/超时 → 整行隐藏（stats=null、不显示假 0），不拖垮其它卡片',
  /libRecState\.stats = null;/.test(js)
  && /if \(!libRecState\.stats\) return;/.test(js)
  && /removeChild\(old\)/.test(js));
check('对账在素材卡渲染时并行拉（assets 没数据就不拉），素材失败时本卡仍走原失败态',
  js.indexOf('loadLibraryReconcile();') > js.indexOf('if (!count) return { empty:')
  && /function loadLibraryReconcile\(\)/.test(js)
  && /libRecState\.loading = true;/.test(js));
check('文件库卡件数用 allCount（整库、合并后），不是本页 count —— limit=1 时否则写成「1 件」',
  /var count = Number\(d\.allCount\);/.test(js)
  && /if \(!Number\.isFinite\(count\) \|\| count <= 0\) count = Number\(d\.count\);/.test(js)
  && /var count = Number\(data\.allCount\) \|\| Number\(data\.count\) \|\| 0;/.test(js));
check('对账摘要样式存在（小字占整行；缺少用 --ui-warn，按钮去皮）',
  /\.qdb-reconcile \{[^}]*flex: 1 0 100%/.test(css)
  && /\.qdb-reconcile-missing \{[^}]*color: var\(--ui-warn\)/.test(css));

console.log('## 已购库 ↔ 素材库对账（07l）');
check('对账是一个独立片段：四胶囊摘要 + 明细板，工具栏入口与已购库弹层复用',
  /\/\/ ── 已购库 ↔ 素材库对账/.test(js)
  && /var LIBREC_VIEWS = \[\['purchased', '已购'\], \['matched', '库里对上'\], \['missing', '缺少'\], \['extra', '未登记'\]\]/.test(js)
  && /function libRecButton\(\)/.test(js) && /function libraryReconcileOpen\(\)/.test(js));
check('已购库弹层顶部有 #recBox（在解析结果之上），打开时绑胶囊并拉一次对账',
  /'<div id="recBox"><\/div>'/.test(js)
  && js.indexOf("'<div id=\"recBox\"></div>'") < js.indexOf("'<div id=\"purResult\"></div>'")
  && /libRecBind\(box\);/.test(js) && /libRecLoad\(\);/.test(js));
check('对账数据只走只读 GET /api/library/reconcile，路由没上线给一句人话',
  /api\('\/api\/library\/reconcile'\)/.test(js)
  && /后端还没有对账接口（重启桥接后再试）/.test(js)
  && !/apiWrite\('\/api\/library\/reconcile'/.test(js));
check('四胶囊显示 已购/库里对上/缺少/未登记 的数字，用 aria-pressed 标当前视图，再点一次收起',
  /data-rec-view="' \+ it\[0\]/.test(js) && /aria-pressed="' \+ on \+ '"/.test(js)
  && /libRecState\.view = \(!next \|\| next === libRecState\.view\) \? 'all' : next;/.test(js));
check('缺少视图：标题 + 店铺/价格 + 「搜素材」+「复制商品页」（data-copy，不新开标签）',
  /data-rec-find="' \+ esc\(boothId\) \+ '">搜素材</.test(js)
  && /data-copy="' \+ esc\(item\.itemUrl \|\| ''\)/.test(js)
  && !/target="_blank"/.test(js));
check('搜素材跳到找号页并把号填进搜索框（走 showView + findLoad，不整页刷新）',
  /function libRecFind\(boothId\)/.test(js) && /showView\('find'\);/.test(js)
  && /input\.value = id;/.test(js) && /findLoad\(\);/.test(js));
check('未登记 / 库里对上视图：标题 + #号 · dir + 「打开」走 open-folder',
  /view === 'extra' \|\| view === 'matched'/.test(js)
  && /data-write="open-folder" data-rel="' \+ esc\(dir\) \+ '"/.test(js));
check('工具栏按钮 data-write=library-reconcile：缺件时红调显示「缺少 N 件」，否则「已购对上 X 件」',
  /data-write="library-reconcile"/.test(js) && /id="recToolBtn"/.test(js)
  && /btn\.textContent = !libRecState\.data \? '对账' : \(st\.missing \? '缺少 ' \+ numText\(st\.missing\) \+ ' 件' : '已购对上 ' \+ numText\(st\.matched\) \+ ' 件'\);/.test(js)
  && /' qdb-btn-danger'/.test(js));
check('页面进来顺手对一次账（60 秒内不重复拉），整页重画后把按钮文案重填',
  /function libRecPrefetch\(\)/.test(js) && /Date\.now\(\) - libRecState\.at < 60000/.test(js)
  && /libRecPrefetch\(\);/.test(js) && /libRecPaint\(\);/.test(js));
check('回收站弹层补「保留 N 天，下次自动清理 MM-DD HH:MM」：字段缺失整行不显示（不编假值）',
  /id="trashRetain"/.test(js) && /'保留 ' \+ numText\(days\) \+ ' 天，下次自动清理 ' \+ libTrashWhen\(nextAt\)/.test(js)
  && /Number\.isFinite\(days\) && days > 0 && Number\.isFinite\(nextAt\) && nextAt > 0/.test(js)
  && /retain\.hidden = !line;/.test(js)
  && /libTrashState\.retentionDays = Number\(d && d\.retentionDays\) \|\| 0;/.test(js));
check('对账胶囊与明细板样式存在（可换行、标题不断词）',
  /\.qdb-rec-pill \{[^}]*cursor: pointer/.test(css)
  && /\.qdb-rec-board \{[^}]*border-radius: 10px/.test(css)
  && /\.qdb-rec-title \{[^}]*overflow-wrap: anywhere;/.test(css));

console.log('## 已购库「补下全部」');
check('补下全部是独立片段：一次 10 件、上限 20，入口按钮挂在同步条「补下」后面',
  /\/\/ ── 已购库「补下全部」/.test(js)
  && /var LIBREC_DL_LIMIT = 10;/.test(js)
  && /function libRecDlAllStart\(btn\)/.test(js)
  && /row\.querySelector\('\[data-write="library-sync-download"\]'\)/.test(js)
  && /ref\.insertAdjacentHTML\('afterend', libRecDlButton\(\)\)/.test(js));
check('按钮 data-write="library-rec-dl-all" + id=recDlAllBtn，缺件为 0 时禁用（不让人点空的）',
  /data-write="library-rec-dl-all"/.test(js) && /id="recDlAllBtn"/.test(js)
  && /btn\.disabled = !!libRecDlState\.busy \|\| !miss;/.test(js)
  && /'现在没有缺少的已购'/.test(js));
check('确认层文案含「一次 10 件」「BOOTH 同一套限速」+ 说明先预览，确认按钮是「先预览」',
  /text: '把缺少的 ' \+ numText\(n\) \+ ' 件依次加入下载队列？默认一次 10 件（上限 20），会用 BOOTH 同一套限速。先做一次只读预览，确认后才真的入队。'/.test(js)
  && /confirmLabel: '先预览'/.test(js));
check('先 POST dryRun:true 只读预览，用户点「开始下载」后才 POST dryRun:false 真入队；入队 0 件给一句人话',
  /apiWrite\('\/api\/library\/reconcile\/download-all', \{ limit: LIBREC_DL_LIMIT, dryRun: true \}\)/.test(js)
  && /apiWrite\('\/api\/library\/reconcile\/download-all', \{ limit: LIBREC_DL_LIMIT, dryRun: false \}\)/.test(js)
  && js.indexOf('dryRun: true') < js.indexOf('dryRun: false')
  && /var q = libRecDlArr\(d\.queued\)\.length \|\| libRecDlNum\(d\.queued\);/.test(js)
  && /toast\('已加入 ' \+ numText\(q\) \+ ' 件下载队列'/.test(js)
  && /'没有需要补下的（可能都在队列里）'/.test(js));
check('dryRun 预览不入队：文案写「（预览，未入队）」、mode 停在 preview、不启动轮询也不重拉对账',
  /libRecDlState\.mode = 'preview';/.test(js)
  && /var q = queued\.length \|\| candidates\.length \|\| libRecDlNum\(d\.queued\);/.test(js)
  && /本批（预览，未入队）：计划加入 ' \+ numText\(q\)/.test(js)
  && /看计划 ' \+ numText\(plan\) \+ ' 件/.test(js)
  && /（预览，未入队）/.test(js)
  && /libRecDlState\.mode === 'queue'\) \{/.test(js)
  && js.indexOf("libRecDlState.mode = 'preview';") < js.indexOf('libRecDlState.timer = window.setInterval'));
check('跳过清单：本批行尾巴「跳过 M 件」可点开，逐条「#号 · 原因」最多 8 条 + 「…还有 N 条」；预览时列 candidates 的 #号 · 标题 · 原因',
  /LIBREC_DL_LIST_MAX = 8/.test(js)
  && /data-recdl-list="1">跳过 ' \+ numText\(skip\) \+ ' 件</.test(js)
  && /it\.kind === 'candidate' \? '#' \+ id \+ ' · ' \+ String\(it\.title \|\| ''\)/.test(js)
  && /'\.\.\.还有 ' \+ numText\(items\.length - LIBREC_DL_LIST_MAX\) \+ ' 条'/.test(js)
  && /if \(t\.closest\('\[data-recdl-list\]'\)\) \{ libRecDlListToggle\(\); return; \}/.test(js));
check('409 / 404 / 403 三段人话：限速暂停透后端原文 + 等几分钟、接口没上线、只允许管理员',
  /if \(\/HTTP 409\/\.test\(msg\)\) return \(msg\.replace\(\/\^HTTP \\d\+ · \/, ''\) \|\| '被 BOOTH 限速了'\) \+ '，等几分钟再试';/.test(js)
  && /'后端还没上线批量补下（重启桥接后再试）'/.test(js)
  && /if \(\/HTTP 403\/\.test\(msg\)\) return '只允许管理员';/.test(js));
check('本批进度只统计 from===\'reconcile\' 的 job，文案「本批已加入 N 件 · 完成 X · 失败 Y」，全跑完再拉一次对账',
  /j\.from === 'reconcile'/.test(js)
  && /'<p class="qdb-hint" id="recDlLine">' \+ libRecDlLineText\(\) \+ '<\/p>'/.test(js)
  && /return '本批已加入 ' \+ numText\(q\) \+ ' 件 · 完成 ' \+ numText\(c\.done\) \+ ' · 失败 ' \+ numText\(c\.failed\)/.test(js)
  && /api\('\/api\/library\/download\/status'\)/.test(js)
  && /if \(!libRecDlState\.done\) \{ libRecDlState\.done = true; libRecLoad\(\); \}/.test(js));
check('弹层里 #recDlBox 在 #recBox 之前，打开时 libRecDlResume() 接着轮询上一批',
  /'<div id="recDlBox"><\/div>'/.test(js)
  && js.indexOf("'<div id=\"recDlBox\"></div>'") < js.indexOf("'<div id=\"recBox\"></div>'")
  && /libRecDlResume\(\);/.test(js));

console.log('## 已购库 · 登录 BOOTH 自动同步（07r）');
const loginSrc = fs.readFileSync(path.join(ROOT, 'client/07r-booth-login.js'), 'utf8');
const purchasesSrc = fs.readFileSync(path.join(ROOT, 'client/07f-library-purchases.js'), 'utf8');
check(/id = 'purLoginBtn'/.test(loginSrc)
  && /setAttribute\('data-write', 'library-booth-login'\)/.test(loginSrc)
  && /'library-booth-login': function \(btn\) \{ return runWrite\(btn, function \(\) \{ return libBoothLoginClick\(btn\); \}\); \}/.test(js)
  && /libBoothLoginOpen\(\);/.test(purchasesSrc)
  && /libBoothLoginClose\(\)/.test(purchasesSrc),
  '弹层里有「登录 BOOTH 自动同步」按钮（data-write=library-booth-login）并挂进 WRITE_ACTIONS');
check(/apiWrite\('\/api\/library\/purchases\/login\/start', \{\}\)/.test(loginSrc)
  && /'等待登录…（取消）'/.test(loginSrc)
  && /state === 'waiting' \|\| state === 'launching'\) return libBoothLoginStop\(btn\)/.test(loginSrc),
  '点按钮先 POST /login/start，等待态按钮文案变「等待登录…（取消）」且再点即取消');
check(/var BOOTH_LOGIN_POLL_MS = 1500;/.test(loginSrc)
  && /api\('\/api\/library\/purchases\/login\/status'\)/.test(loginSrc)
  && /state === 'idle' \|\| state === 'succeeded' \|\| state === 'failed' \|\| state === 'cancelled'/.test(loginSrc)
  && /function libBoothLoginStopPoll/.test(loginSrc)
  && /window\.clearInterval\(libBoothLoginState\.timer\)/.test(loginSrc),
  '1.5 秒轮询 GET /login/status，终态（succeeded/failed/cancelled/idle）就停');
check(/已打开浏览器窗口，请在里面登录 BOOTH；登录成功后会自动导入已购清单（最多等 5 分钟）。/.test(loginSrc)
  && /' 秒'/.test(loginSrc)
  && /var ms = Number\(st && st\.elapsedMs\);/.test(loginSrc)
  && /Date\.now\(\) - started/.test(loginSrc),
  'waiting 版提示写全（浏览器窗口+自动导入+最多 5 分钟）并带「已等待 N 秒」');
check(/toast\('已登录 BOOTH'/.test(loginSrc)
  && /'，开始同步已购…'/.test(loginSrc)
  && /Promise\.resolve\(libPurSyncStart\(\)\)\.then\(libBoothLoginAfterSync, libBoothLoginAfterSync\)/.test(loginSrc)
  && /libRecLoad\(\)/.test(loginSrc)
  && /libPurLoad\(true\)/.test(loginSrc),
  'succeeded：toast 后走 libPurSyncStart 同一条路径，收尾刷新列表与对账');
check(/if \(s === 'failed'\) return \{ tone: 'err', text: String\(\(st && st\.error\)/.test(loginSrc)
  && /if \(s === 'cancelled'\) return \{ tone: '', text: '已取消登录' \};/.test(loginSrc)
  && /btn\.textContent = st\.busy \? '正在打开…' : \(active \? '等待登录…（取消）' : '登录 BOOTH 自动同步'\);/.test(loginSrc),
  'failed 用后端 error 原文、cancelled 写「已取消登录」，两种都恢复按钮文案');
check(/apiWrite\('\/api\/library\/purchases\/login\/stop', \{\}\)/.test(loginSrc)
  && /function libBoothLoginClose\(\) \{\s*libBoothLoginStopPoll\(\);/.test(loginSrc)
  && !/function libBoothLoginClose\(\) \{[^}]*login\/stop/.test(loginSrc),
  '取消走 POST /login/stop 并停轮询；关弹层只停轮询、不发 stop（窗口继续等登录）');
check((loginSrc.match(/后端还没上线自动登录（重启桥接后再试）/g) || []).length >= 2,
  '404 兜底说人话（toast 与状态区各一处），点按钮不静默');
check(/maskedCookieKey/.test(loginSrc)
  && !/document\.cookie/.test(loginSrc)
  && !/\.cookie\b/.test(loginSrc),
  '安全：只显示 maskedCookieKey，片段里没有任何读 cookie 明文的位置（document.cookie / .cookie / data.cookie）');

console.log('## 素材库页「同步 BOOTH 已购」入口（07s）');
const syncEntrySrc = fs.readFileSync(path.join(ROOT, 'client/07s-library-sync-entry.js'), 'utf8');
const proSrc = fs.readFileSync(path.join(ROOT, 'client/10-library-pro.js'), 'utf8');
const purchasesSrc2 = fs.readFileSync(path.join(ROOT, 'client/07f-library-purchases.js'), 'utf8');
check(/id="libProSyncSlot"/.test(proSrc) && /libSyncEntryMount\(\);/.test(proSrc),
  '素材库页顶栏留了 #libProSyncSlot 插槽并在骨架后调用 libSyncEntryMount()');
check(/id="libProSyncBtn"/.test(syncEntrySrc)
  && /data-write="library-sync-direct"/.test(syncEntrySrc)
  && /'library-sync-direct': function \(btn\) \{ return runWrite\(btn, function \(\) \{ return libSyncEntryStart\(btn\); \}\); \}/.test(js)
  && /qdb-btn-primary/.test(syncEntrySrc)
  && /⟳ 同步 BOOTH 已购/.test(syncEntrySrc),
  '主按钮 id=libProSyncBtn、data-write=library-purchases-sync、qdb-btn-primary、「⟳ 同步 BOOTH 已购」');
check(/id="libProSyncNote"/.test(syncEntrySrc)
  && /'上次同步 ' \+ libSyncEntryWhen/.test(syncEntrySrc)
  && /' 件已购'/.test(syncEntrySrc)
  && /'缺 ' \+ numText\(s\.missing\)/.test(syncEntrySrc)
  && /'还没同步过'/.test(syncEntrySrc),
  '小字 #libProSyncNote 拼「上次同步 … · 共 N 件已购 · 缺 M 件」，无数据时「还没同步过」');
check(/confirmLabel: '开始同步'/.test(syncEntrySrc)
  && /apiWrite\('\/api\/library\/purchases\/sync', \{ dryRun: false \}\)/.test(syncEntrySrc)
  && /从 BOOTH 已购清单全量同步？会逐页抓（约 1 分钟），只写本地已购台账，不动文件。/.test(syncEntrySrc),
  '主按钮：轻确认层（约 1 分钟文案）→ 直接 { dryRun: false } 全量同步');
check(!/libPurSyncStart/.test(syncEntrySrc) && /openDialog\(\{/.test(syncEntrySrc),
  '主按钮不再调用 libPurSyncStart（已购库弹层那条 dryRun 预览保持原样）');
check(/'同步中… 第 ' \+ numText\(s\.page\) \+ ' 页'/.test(syncEntrySrc)
  && /LIB_SYNC_ENTRY_POLL_MS = 1500/.test(syncEntrySrc),
  '同步中按钮变「同步中… 第 N 页」并 1.5s 轮询 status');
check(/'同步完成：新增 ' \+ numText\(added\) \+ ' · 更新 ' \+ numText\(updated\) \+ ' · 未变 ' \+ numText\(unchanged\)/.test(syncEntrySrc)
  && /' · 共 ' \+ numText\(pages\) \+ ' 页'/.test(syncEntrySrc),
  '完成 toast 四段数字（新增/更新/未变/共 N 页）');
check(/data-write="library-purchases-open"/.test(syncEntrySrc)
  && /'library-purchases-open': function \(\) \{ return libraryPurchasesOpen\(\); \}/.test(js)
  && /id="purSyncBtn"/.test(purchasesSrc2),
  '素材库页有「已购库」入口并复用 libraryPurchasesOpen()，文件库页原入口保留');
check(/s3\.stopped === 'rate_limited' \|\| s3\.stopped === 'max_pages'/.test(syncEntrySrc)
  && /apiWrite\('\/api\/library\/purchases\/sync', \{ resume: true \}\)/.test(syncEntrySrc)
  && /继续同步/.test(syncEntrySrc)
  && /return libSyncEntryStart\(btn\);/.test(syncEntrySrc),
  '「继续同步」只在 stopped 为 rate_limited/max_pages 时出现，发 {resume:true}，404 退回普通同步');
check(/qdb-btn-primary \{[^}]*var\(--ui-accent\)/.test(css)
  && /\.qdb-sync-note \{/.test(css)
  && /\.qdb-sync-note\[data-tone="err"\]/.test(css),
  'CSS：.qdb-btn-primary 用主色、.qdb-sync-note 有 warn/err 两档');

console.log('## 网络错误说人话 / toast 单条 / 保存失败文案');
check('网络错误统一映射成中文：Failed to fetch / NetworkError / 502-504 → 连不上桥接（可能正在重启），等几秒再试',
  /function netErrorText\(error\)/.test(js)
  && /\/Failed to fetch\|NetworkError\|Load failed\|network error\|ERR_CONNECTION\|ERR_NETWORK\/i/.test(js)
  && /'连不上桥接（可能正在重启），等几秒再试'/.test(js)
  && /status === 502 \|\| status === 503 \|\| status === 504/.test(js)
  && /if \(name === 'AbortError' \|\| \/AbortError\|aborted\/i\.test\(msg\)\) return '';/.test(js));
check('三个请求出口与 OCR 那发 fetch 都过一遍 netErrorText（英文原文不再直接弹给用户，也不改重试策略）',
  /var zh = netErrorText\(error\);/.test(js)
  && (js.match(/var zh = netErrorText\(error\);/g) || []).length >= 3
  && /else if \(typeof netErrorText === 'function' && netErrorText\(error\)\) toast\(netErrorText\(error\), 'warn'\);/.test(js)
  && /toast\('截图识别失败：'/.test(js));
check('toast 同一容器只留一条：新提示先撤掉旧盒子并清掉它的 timer（不做队列）',
  /var toastBox = null;/.test(js) && /var toastTimer = 0;/.test(js)
  && /if \(toastBox\) \{ if \(toastTimer\) window\.clearTimeout\(toastTimer\); toastTimer = 0; toastBox\.remove\(\); toastBox = null; \}/.test(js)
  && /if \(toastBox === box\) \{ toastBox = null; toastTimer = 0; \}/.test(js));
check('手动信息保存失败：默认「保存失败，稍后再试」，400 才拼后端原文，网络错误说人话（不直接抛后端英文）',
  /else toast\('保存失败，稍后再试', 'warn'\);/.test(js)
  && /Number\(error && error\.status\) === 400\) toast\('保存失败：'/.test(js)
  && !/toast\('保存失败：' \+ \(msg\.replace\(\/\^HTTP \\d\+ · \/, ''\) \|\| '请重试'\), 'warn'\)/.test(js));

console.log('## 素材详情抽屉（07m）');
check('详情抽屉是独立片段：点标题/封面打开，抽屉自带内容与关闭',
  /\/\/ ── 素材详情抽屉/.test(js) && /var LIBDET_FOLD = 8;/.test(js)
  && /function libDetailOpen\(key\)/.test(js) && /'library-detail': function \(btn\)/.test(js));
check('卡片标题与封面都挂 data-write="library-detail" + data-key（走统一写操作委托，不改现有按钮）',
  /class="qdb-asset-thumb" data-write="library-detail" data-key="' \+ esc\(a\.key\)/.test(js)
  && /class="qdb-asset-title" data-write="library-detail" data-key="' \+ esc\(a\.key\)/.test(js));
check('打开抽屉只走只读 GET /api/library/asset?key=（不是写请求）',
  /api\('\/api\/library\/asset\?key=' \+ encodeURIComponent\(key\)\)/.test(js)
  && !/apiWrite\('\/api\/library\/asset'/.test(js));
check('路由没上线 / 404：用列表里那张卡兜底，并写「重启桥接后再试」，不报错不空白',
  /libraryCardCache\[key\] \|\| null/.test(js)
  && /后端还没有素材详情接口（重启桥接后再试）/.test(js)
  && /libDetBodyHtml\(cached, libDetError/.test(js));
check('文件清单：主件标记 + 大小 + 所在目录，超过 8 条折叠成「展开全部 N 个」',
  /f\.main \? ' <span class="qdb-asset-bind">主件<\/span>'/.test(js)
  && /files\.slice\(0, LIBDET_FOLD\)/.test(js)
  && /data-det-expand="1">展开全部 ' \+ numText\(files\.length\) \+ ' 个/.test(js)
  && /libDetState\.expanded = true;/.test(js));
check('合并卡多一块「已合并 N 项」成员列表，成员能各自打开文件夹',
  /function libDetMembersHtml\(a\)/.test(js) && /'已合并 ' \+ numText\(members\.length\) \+ ' 项'/.test(js)
  && /data-write="open-folder" data-rel="' \+ esc\(dir\) \+ '">打开</.test(js));
check('操作一排复用现有写 action：打开文件夹 / 复制商品页 / 改号 / 改名 / 以图搜源 / 移入回收站',
  /data-write="open-folder" data-rel="/.test(js)
  && /data-copy="' \+ esc\(itemUrl\)/.test(js)
  && /data-write="library-bind-manual" data-key="/.test(js)
  && /data-write="library-rename" data-key="/.test(js)
  && /data-write="library-find-by-image" data-key="/.test(js)
  && /data-write="library-trash-one" data-key="/.test(js));
check('Esc 关闭 + 点遮罩关闭 + 关闭按钮；遮罩只在画布外点击才关',
  /document\.addEventListener\('keydown', function \(ev\) \{\n        if \(ev\.key === 'Escape' && libDetState\.open\) libDetClose\(\);/.test(js)
  && /if \(t === mask\) \{ libDetClose\(\); return; \}/.test(js)
  && /data-det-close="1"/.test(js));
check('抽屉样式：右侧滑出、宽度 min(560px, 100vw)、内容可滚动（360 不横向越界）',
  /\.qdb-drawer-mask \{[^}]*position: fixed/.test(css)
  && /\.qdb-drawer \{[^}]*width: min\(560px, 100vw\)/.test(css)
  && /\.qdb-drawer \{[^}]*overflow: auto/.test(css)
  && /\.qdb-asset-thumb\[data-write\], \.qdb-asset-title\[data-write\] \{ cursor: pointer; \}/.test(css));

console.log('## 已购下载：失败 / 中断的逐件重试');
check('已购下载弹层里有 #dlJobsList 容器（逐件重试行就挂这里，不整页重画）',
  /<div id="dlJobsList" class="qdb-find-list"><\/div>/.test(js) && /byId\('dlJobsList'\)/.test(js));
check('只有 failed / interrupted 的任务出「重试」，已下好和下载中的不出按钮',
  /j\.state === 'failed' \|\| j\.state === 'interrupted'/.test(js)
  && /data-write="library-dl-retry" data-booth="/.test(js)
  && /bridgeRestartJobWhy|桥接重启时任务被打断，可重试/.test(js));
check('重试按钮发 POST /api/library/download/retry { boothId }',
  /'library-dl-retry': function \(btn\)/.test(js)
  && /apiWrite\('\/api\/library\/download\/retry', \{ boothId: boothId \}\)/.test(js));
check('重试成功后只刷任务行（libraryDownloadRepoll），不 pageLoad 整页',
  /libraryDownloadRepoll\(\)/.test(js) && /var dlPollHook = null;/.test(js)
  && /dlPollHook = poll;/.test(js) && /if \(dlPollHook === poll\) dlPollHook = null;/.test(js)
  && !/apiWrite\('\/api\/library\/download\/retry'[\s\S]{0,400}pageLoad\('library'/.test(js));
check('后端中文错误原文透出（剥掉 HTTP 前缀），already 有单独提示',
  /replace\(\/\^HTTP \\d\+ · \/, ''\)/.test(js) && /这件已经下好了，不用重试/.test(js));

console.log('## 缺封面口径统一（仪表盘 chip／文件库头部／详情行同一口径）');
check('仪表盘「缺封面」用 withCover（thumbUrl 或 coverUrl 都算有图），withThumb 降级为详情说明',
  /var withCover = Math\.max\(Number\(d\.withCover\) \|\| 0, Number\.isFinite\(withThumb\) \? withThumb : 0\);/.test(js)
  && /libChip\('缺封面', count - withCover\)/.test(js)
  && !/libChip\('缺封面', count - withThumb\)/.test(js)
  && /有缩略图 ' \+ numText\(withThumb\) \+ ' 件/.test(js));
check('文件库素材头「有封面」逐件按 libraryHasCover 数（与筛选胶囊的「无封面 N」对得上）',
  /var coverCount = list\.filter\(libraryHasCover\)\.length;/.test(js)
  && /' 件 · 有封面 ' \+ numText\(coverCount\) \+ ' 件'/.test(js));

console.log('## 文件库：绑定表导出 / 导入（换机器不丢人工绑定）');
check('批量条上有「导出绑定 / 导入绑定」两个按钮（都挂 data-write）',
  /data-write="library-binds-export"/.test(js) && /data-write="library-binds-import"/.test(js)
  && /导出绑定<\/button>/.test(js) && /导入绑定<\/button>/.test(js));
check('导出走只读 GET /api/library/binds/export，并用 a[download] 存成 booth-binds.json（不开新标签）',
  /api\('\/api\/library\/binds\/export'\)/.test(js) && /a\.download = 'booth-binds\.json'/.test(js)
  && /document\.body\.appendChild\(a\)/.test(js) && !/target="_blank"/.test(js.slice(js.indexOf('function libraryBindsExport'), js.indexOf('function libraryBindsImport'))));
check('导出条数按后端 entries 对象计（contentKey → 绑定，不是数组）',
  /var entryCount = Array\.isArray\(d\.entries\) \? d\.entries\.length : Object\.keys\(d\.entries \|\| \{\}\)\.length;/.test(js));
check('导入也接受 entries 对象（导出原样回灌能直接导入），空表直接退',
  /typeof payload\.entries !== 'object'/.test(js) && /var importCount = Array\.isArray\(payload\.entries\)/.test(js));
check('导入走 apiWrite + overwrite 标志（默认 false，只在勾选后才 true）',
  /apiWrite\('\/api\/library\/binds\/import', \{ entries: payload\.entries, overwrite: overwrite \}\)/.test(js)
  && /var overwrite = false;/.test(js) && /overwrite = !!over\.checked;/.test(js));
check('导入前校验 format 是 qdb-booth-binds（不是本控制台导出的表直接退）',
  /var LIBRARY_BINDS_FORMAT = 'qdb-booth-binds';/.test(js) && /payload\.format !== LIBRARY_BINDS_FORMAT/.test(js)
  && /这不是本控制台导出的绑定表/.test(js));
check('确认层写清「默认只补充不覆盖」，并给「覆盖同名」勾选框',
  /默认只补充不覆盖/.test(js) && /id="bindImportOverwrite"/.test(js) && /覆盖同名/.test(js));
check('导入结果 toast 报新增 / 跳过 / 非法三条数，并重拉文件库',
  /'新增 ' \+ numText\(d\.added\) \+ ' 条、跳过 ' \+ numText\(d\.skipped\) \+ ' 条、非法 ' \+ numText\(d\.invalid\) \+ ' 条'/.test(js)
  && /pageLoad\('library', true\)/.test(js));
check('403 说人话「导入导出只允许管理员」，其它错误透出后端原文',
  /error\.status === 403\) return '导入导出只允许管理员'/.test(js) && /function libraryBindsErrorText/.test(js));
check('两个动作都注册进 WRITE_ACTIONS（01-shell）',
  /'library-binds-export': function \(btn\)/.test(js) && /'library-binds-import': function \(btn\)/.test(js)
  && /handleConsoleLibraryBindIo/.test(fs.readFileSync(path.join(ROOT, 'src', 'bridge', 'console-server.js'), 'utf8')));

console.log('## 文件库：以图搜源（拿封面反搜 BOOTH）');
const findImgPart = fs.readFileSync(path.join(ROOT, 'client', '07e-find-by-image.js'), 'utf8');
check('素材卡补「以图搜源」按钮，且只给有封面的卡片补（img.qdb-asset-cover 才插）',
  /setAttribute\('data-write', 'library-find-by-image'\)/.test(findImgPart)
  && /article\.querySelector\('img\.qdb-asset-cover'\)/.test(findImgPart));
check('按钮插在「找号」前面（同一个操作行，不新开一行）',
  /actsEl\.insertBefore\(btn, findBtn\)/.test(findImgPart) && /actsEl\.querySelector\('\[data-write="library-find"\]'\)/.test(findImgPart));
check('弹层左边是这次查询用的本地封面，右边候选带「封面距 / 标题相似 / 总分」与「绑这个」',
  /id="findImgQueryRow"/.test(findImgPart) && /'封面距 ' \+ numText\(c\.coverDistance\)/.test(findImgPart)
  && /'标题相似 ' \+ Math\.round/.test(findImgPart) && /data-find-bind="' \+ esc\(c\.boothId\)/.test(findImgPart));
check('走 POST /api/library/find-by-image（apiWrite，只传素材 key），后端路由真实存在',
  /apiWrite\('\/api\/library\/find-by-image', \{ key: key \}\)/.test(findImgPart)
  && fs.readFileSync(path.join(ROOT, 'src', 'bridge', 'console-server.js'), 'utf8').includes("'/api/library/find-by-image'"));
check('403 说人话「以图搜源只允许管理员」，其它错误透出后端原文',
  /'以图搜源只允许管理员'/.test(findImgPart) && /function libraryFindByImageErrorText/.test(findImgPart));
check('保护闸被踩到时显示「被限速，等一会再试」，不伪装成「没搜到」',
  /data\.paused/.test(findImgPart) && /BOOTH 搜索被限速/.test(findImgPart)
  && /同一台机器短时间内搜太多次会被 BOOTH 限速/.test(findImgPart));
check('动作注册进 WRITE_ACTIONS（01-shell.js）',
  /'library-find-by-image': function \(btn\)/.test(js) && /return libraryFindByImageOpen\(btn\);/.test(js));

console.log('## 文件库：先预览再执行');
const librarySection = (html.match(/<section data-page="library"[\s\S]*?<\/section>/) ?? [''])[0];
const cleanHandler = (html.match(/'files-clean': function \(btn\) \{[\s\S]*?\n    \},\n    'files-category'/) ?? [''])[0];
check(/data-tone="write">可操作/.test(librarySection), '文件库徽标从「只读」改成「可操作」');
check(/素材的浏览 \/ 找号 \/ 补封面 \/ 合并 \/ 下载都搬到「素材库」页/.test(librarySection), '转存与存储页副标题写明素材功能已搬到素材库');
check(/panelBox\('清理归档'/.test(html), '文件库新增「清理归档」面板');
check(/data-write="files-preview"' \+ dis \+ '>预览可清理/.test(html), '「预览可清理」按钮（data-write，跟着 disabled 走）');
check(/apiWrite\('\/api\/files\/cleanup', \{ dryRun: true \}\)/.test(html), '预览只发 { dryRun: true }（不填 body 的 {}，绝不误真删）');
for (const field of ['data.wouldRemove', 'data.wouldRemoveCount', 'data.wouldRemoveBytes', 'data.nextRunAt']) {
  check(html.includes(field), `预览按新契约读 ${field}`);
}
check(/<th>名称<\/th><th>分类<\/th><th>大小<\/th><th>原因<\/th><th>时间<\/th>/.test(html), '明细表五列：名称/分类/大小/原因/时间');
check(/esc\(bytesText\(row\.bytes\)\)/.test(html) && /esc\(libraryStamp\(row\.createdAt\)\)/.test(html),
  '大小走 bytesText()、时间统一格式化，且都过了 esc()');
check(/var LIBRARY_PREVIEW_MAX = 50;/.test(html) && /p\.items\.slice\(0, LIBRARY_PREVIEW_MAX\)/.test(html)
  && /' 条，仅显示前 ' \+ numText\(LIBRARY_PREVIEW_MAX\)/.test(html),
  '明细最多渲染前 50 条，并注明「共 N 条，仅显示前 50」');
check(/emptyLine\('没有可清理的文件'\)/.test(html), '预览为空时写「没有可清理的文件」');
check(/\(p && p\.count\s*\n?\s*\? '<button class="qdb-btn qdb-btn-mini qdb-btn-danger" type="button" data-write="files-clean"/.test(html),
  '确认按钮只在预览有可清理项时出现，且是红色 danger');
check(/确认清理这 ' \+ numText\(p\.count\) \+ ' 个/.test(html), '确认按钮文案带条数「确认清理这 N 个」');
check(/title: '清理归档文件'/.test(cleanHandler) && /不可撤销/.test(cleanHandler) && /confirmLabel: '确认清理'/.test(cleanHandler)
  && /danger: true/.test(cleanHandler) && /openDialog\(\{/.test(cleanHandler),
  '点确认先走 openDialog 二次确认（标题「清理归档文件」+ 文案含「不可撤销」+ 红色）');
check(/这会真的删掉 ' \+ numText\(count\) \+ ' 个文件（共 ' \+ bytesText\(bytes\) \+ '）/.test(cleanHandler),
  '弹层文案写清「真的删掉 N 个文件（共 X）」');
check(/apiWrite\('\/api\/files\/cleanup', \{\}\)/.test(cleanHandler), '确认后才发空 body 真删');
check(/libraryState\.preview = null;[\s\S]{0,80}?return pageLoad\('library', true\);/.test(cleanHandler),
  '删成功后清掉预览 + 强制重拉 stats/lists（pageLoad 第二参 true）');
check(/libraryState\.preview = null; \/\/ 重新拉数据就丢掉旧名单/.test(html), '重新拉数据时预览名单自动作废');
check(/'files-preview-clear': function \(btn\) \{[\s\S]{0,120}?libraryState\.preview = null;[\s\S]{0,80}?renderLibrary\(pageHost\('library'\)\)/.test(html),
  '「取消预览」把预览态清掉并重画');
check(/if \(view !== 'library'\) libraryClearPreview\(\);/.test(html) && /function libraryClearPreview\(\)/.test(html),
  '切走页面就清掉预览（回来必须重新预览）');
check(/data-write="archive-rules-edit"/.test(html), '文件库页有「编辑条件」按钮（data-write="archive-rules-edit"）');
check(/function archiveRulesPanelHtml\(\)/.test(html) && /转存条件/.test(html) && /archiveRulesChips\(archiveRulesOf\(\)\)/.test(html), '转存条件面板：标题 + 规则 chips 都从后端数据渲染');
check(/function loadArchiveRules\(\)[\s\S]{0,220}?api\('\/api\/file-library\/archive-rules'\)/.test(html), 'pageLibrary 会拉 GET /api/file-library/archive-rules');
check(/apiWrite\('\/api\/file-library\/archive-rules', \{ rules: next \}\)/.test(html), '保存走 POST /api/file-library/archive-rules（整份覆盖）');
check(/pageLibrary[\s\S]{0,420}?loadArchiveRules\(\)/.test(html) && !/文件库还是空的'\, '白名单群上传文件后会自动转存。'\)\; return;/.test(html), '空库也渲染页面（不再整页替换成空状态，否则改不了条件）');
check(/name: 'extensions'/.test(html) && /name: 'senderMode'/.test(html) && /name: 'perHourMax'/.test(html) && /name: 'minKb'/.test(html), '编辑弹层字段齐全（类型 / 发送者 / 每小时上限 / 体积）');
check(/data-write="archive-rules-edit": function \(\) \{ return archiveRulesEdit\(\); \}/.test(html) || /'archive-rules-edit': function \(\) \{ return archiveRulesEdit\(\); \}/.test(html), '按钮挂进 WRITE_ACTIONS 委托');
check(/data-write="files-category" data-category="' \+ esc\(name\) \+ '"/.test(html) && />改分类<\/button>/.test(html),
  '分类列表每行一个「改分类」按钮（带当前分类名）');
check(/\{ name: 'category', label: '分类名（留空=未分类）'/.test(html), '改分类弹层有分类输入框，留空=未分类');
check(/\{ name: 'id', label: '文件 id（正整数）'/.test(html) && /if \(!\(id > 0\) \|\| Math\.floor\(id\) !== id\)/.test(html),
  '分类列表是聚合行（lists 只回 category/count，没有文件 id），所以弹层额外要一个正整数 id 并本地校验');
check(/apiWrite\('\/api\/files\/category', \{ id: id, category: category \}\)/.test(html), '改分类 POST /api/files/category {id,category}');
check(/libraryState\.err = error;[\s\S]{0,80}?renderLibrary\(pageHost\('library'\)\)/.test(html)
  && /errorBox\(libraryState\.err, '写操作失败'\)/.test(html),
  '改分类 400/503 把后端原文贴成常驻 errorBox（toast 会飘走）');
check(/function libraryWriteDisabled\(\) \{ return libraryState\.stats && libraryState\.lists \? '' : ' disabled'; \}/.test(html),
  '拿不到 stats/lists 时写按钮 disabled（数字不可信就不让删）');
check((html.match(/method: 'POST'/g) ?? []).length === 1, '全页仍然只有一处 method: \'POST\'（都走 apiWrite）');
check(!/loading="lazy"/.test(librarySection), '文件库没有 loading="lazy"');
check(/\.qdb-clean-table \{ table-layout: auto; \}/.test(html)
  && /@media \(max-width: 700px\) \{\s*\n\s*\.qdb-clean-table th:nth-child\(2\), \.qdb-clean-table td:nth-child\(2\),/.test(html),
  '清理明细有独立列宽（不套黑名单那套 34%/76px），窄屏隐藏「分类 / 时间」两列');

// ── 10.5 记忆页总览 + 会话标签（群名（群号）/ 昵称（QQ号），原始 key 不上屏） ──
console.log('## 记忆页总览 + 会话标签');
const pageMemorySource = (html.match(/function pageMemory\(view, host\) \{[\s\S]*?\n  \}\n/) ?? [''])[0];
const memPickerSource = (html.match(/function memPickerHtml\(rows\) \{[\s\S]*?\n  \}\n/) ?? [''])[0];
check(/api\('\/api\/memory\/overview'\)/.test(pageMemorySource)
  && /api\('\/api\/socialV2\/memory\?key=' \+ encodeURIComponent\(key\)\)/.test(html)
  && /Promise\.all\(\[/.test(pageMemorySource),
  '记忆页 Promise.all 同时拉 /api/memory/overview 与单会话 /api/socialV2/memory?key=');
check(/memTotalsHtml\(overview && overview\.totals\)/.test(pageMemorySource)
  && /statBox\('会话', numText\(t\.sessions\)\)/.test(html)
  && /statBox\('共享事件', numText\(t\.sharedEvents\)\)/.test(html)
  && /statBox\('跨会话印象', numText\(t\.globalImpressions\)\)/.test(html)
  && /statBox\('会话内印象', numText\(t\.impressions\)\)/.test(html),
  '记忆页第一段是 KPI 总览：会话 / 共享事件 / 跨会话印象 / 会话内印象');
check(/panelBox\('跨会话群友印象'/.test(html) && /panelBox\('共享事件'/.test(html)
  && /panelBox\('按会话看/.test(html) && /还没有跨会话印象/.test(html),
  '记忆页四段齐全：KPI → 跨会话群友印象 → 共享事件 → 按会话看（含空态文案）');
check(/var MEM_EVENTS_MAX = 80;/.test(html) && /picked\.length > MEM_EVENTS_MAX/.test(html)
  && /' 条，只显示最近 '\s*\+ numText\(MEM_EVENTS_MAX\) \+ ' 条<\/div>'/.test(html),
  '共享事件最多渲染前 80 条，超出只补一句「共 N 条」不刷屏');
check(/function sessionLabelOf\(key, labels\) \{/.test(html)
  && /return '群 ' \+ part\.id;/.test(html) && /return 'QQ ' \+ part\.id;/.test(html),
  'sessionLabelOf(key, labels) 优先用后端 label，缺失时退回「群 100000002 / QQ 100000006」');
check(/if \(label\.indexOf\('group:'\) >= 0 \|\| label\.indexOf\('private:'\) >= 0\) return '';/.test(html),
  '「名称未知（group:123）」这类把原始 key 拼进 name 的标签被拒，不上屏');
check(/esc\(sessionLabelOf\(r\.key\)\)/.test(memPickerSource) && !/esc\(r\.key\) \+ '<\/option>'/.test(memPickerSource)
  && !/esc\(c\.key\) \+ '（未读 /.test(html),
  '记忆页下拉 option 文案走 sessionLabelOf()，不再显示「group:123（未读 N）」');
check(/function sessionLabel\(key\) \{\s*\n\s*return sessionLabelOf\(key\);/.test(html)
  && /esc\(sessionLabel\(key\)\)/.test(html),
  '日志页「全部会话」下拉复用 sessionLabel() → sessionLabelOf()');
check(/var name = sessionNameOf\(row\.key\);/.test(html) && /esc\(name \|\| idLine\)/.test(html)
  && /var idLine = sessionSubLabel\(part\);/.test(html) && /data-session-key="' \+ esc\(row\.key\) \+ '"/.test(html),
  '会话列表行：主标题是群名/昵称，小字是「群号 N / QQ 号 N」，原始 key 只留在 data-session-key');

check(/function refreshMemoryOverview\(\)/.test(html)
  && /api\('\/api\/memory\/overview'\)\.then\(function \(data\) \{/.test(html)
  && /var totalsHost = byId\('memTotals'\)/.test(html) && /<div id="memTotals">/.test(html),
  '写记忆后静默刷新 refreshMemoryOverview()：只重画 KPI / 下拉文案 / counts 小字，不重绘详情区');
check(/return Promise\.all\(\[loadMemory\(key\), refreshMemoryOverview\(\)\]\);/.test(html)
  && /刷新失败就用旧数据/.test(html),
  'memory-remove / memory-clear 成功后并行刷新详情与总览，总览失败静默保留旧值');

console.log('## 更新日志');
// 数据源是 scripts/make-changelog.mjs 从 git log 生成的静态文件，页面只在点开时读它。
check(/function changelogData\(\)/.test(js) && /window\.__QDB_CHANGELOG/.test(js), '更新日志读 window.__QDB_CHANGELOG（构建产物里的静态数据）');
check(/'changelog-open': function \(\) \{ return openChangelogDialog\(\); \}/.test(js), '设置页按钮走 data-write="changelog-open" 打开弹层');
check(/data-write="changelog-open"/.test(js), '设置页「安全与关于」里有「查看更新日志」按钮');
check(/<script src="\/changelog.js" defer><\/script>/.test(html), 'client.html 引了 /changelog.js');
check(/function changelogStatsHtml\(d\)/.test(js) && /次提交/.test(js) && /d\.days/.test(js), '弹层顶部写清「多少次提交 / 跨了多少天」');
check(/function changelogListHtml\(d\)/.test(js) && /qdb-log-day/.test(js) && /qdb-log-item/.test(js), '列表按天分组、逐条列出改动');
check(/qdb-log-search/.test(js) && /changelogMatch\(item, query\)/.test(js), '有搜索框，按关键词/提交号过滤');
check(/data-log-type="all"/.test(js) && /changelogState\.type/.test(js), '可按类型筛选（全部/新增/修复/…）');
check(/\.qdb-log-dialog \{[^}]*max-height: 82vh/s.test(css) && /\.qdb-log-body \{[^}]*overflow-y: auto/s.test(css), '弹层自身限高、正文独立滚动');
check(/ev\.key === 'Escape'/.test(js), 'ESC 能关掉弹层');

// ── 10.9 花费预警的「预警指标」是开关，不是两个按钮 ────────────────────────────
console.log('## 花费预警指标开关');
// ── AI 黑名单：今天拦了什么（按原因统计）──
console.log('## AI 黑名单拦截统计');
check(/function listsAiWhyHtml\(stats\)/.test(js) && /data-ai-why/.test(js),
  '黑名单面板显示「拦截原因」分组（来自后端 stats.byWhy）');
check(/stats\.byWhy/.test(js) && /stats\.recent/.test(js) && /进程内统计，重启清零/.test(js),
  '列出最近拦下的几条，并写明是进程内统计（重启清零，不冒充历史账本）');

check(/id="budgetMetricSwitch"/.test(js) && /id="budgetMetricLabel"/.test(js) && !/data-budget-metric/.test(js),
  '预警指标改成一个开关（文字写在开关正上方），不再是「按金额 / 按 Token」两个胶囊');
check(/var metricName = metric === 'tokens' \? '按 Token' : '按金额';/.test(js),
  '开关上方那行字就是当前口径，拨完立刻变');
check(/st\.metric = metricSwitch\.checked \? 'tokens' : 'cost';/.test(js),
  '开关关=按金额、开=按 Token；拨完就地重画（限额单位跟着换）');
check(/qdb-budget-limit/.test(js) && /qdb-budget-unit/.test(js) && !/限额（/.test(js),
  '指标开关就坐在「限额」那一格里，不再单独写「限额（元）」标签（否则和开关上的字重复）');

// ── 10.8 已购库（BOOTH 买过的素材）────────────────────────────────────────────
var purFrag = js.indexOf('// ── 已购库：');
check(purFrag >= 0, '已购库是一个独立片段（不塞进 03-sessions）');
check(/function libraryPurchasesButton\(\)/.test(js) && /data-write="library-purchases"/.test(js),
  '文件库工具栏有「已购库」按钮（data-write 走统一写操作委托）');
check(/function libraryPurchasesOpen\(\)/.test(js) && /id="purList"/.test(js) && /id="purQuery"/.test(js),
  '已购库弹层：解析输入框 + 列表容器');
check(/apiWrite\('\/api\/library\/purchases\/resolve', body\)/.test(js),
  '解析走 POST /api/library/purchases/resolve（链接/商品号用 url，名字用 text）');
check(/isId \? 'https:\/\/booth\.pm\/ja\/items\/' \+ text : text/.test(js),
  '只贴 5~9 位商品号时自动补成商品链接再解析');
check(/apiWrite\('\/api\/library\/purchases\/import', \{ boothIds: \[boothId\] \}\)/.test(js),
  '导入走 POST /api/library/purchases/import { boothIds }');
check(/apiWrite\('\/api\/library\/purchases\/refresh', boothId \? \{ boothIds: \[boothId\] \} : \{\}\)/.test(js),
  '刷新（单件 / 全部）都走 POST /api/library/purchases/refresh');
check(/apiWrite\('\/api\/library\/purchases\/remove', \{ boothId: boothId \}\)/.test(js) && /confirmLabel: '移除', danger: true/.test(js),
  '移除要二次确认（danger），确认后才 POST remove');
check(/id="purOcrBtn" data-write="library-purchases-ocr"/.test(js) && !/截图导入（待接）/.test(js),
  '「截图导入」不再是占位：按钮文案就是「截图导入」');
check(/api\('\/api\/library\/purchases' \+ qs\)/.test(js) && /'\?page=' \+ page \+ '&limit=' \+ LIBPUR_PAGE/.test(js),
  '列表按 page/limit 拉 GET /api/library/purchases，加载更多是 page+1 追加');
check(/data-write="library-purchases-more"/.test(js) && /page < libPurState\.pages/.test(js),
  '还有下一页时才出「加载更多（已显示 N / M）」');
check(/data-pur-tag="/.test(js) && /libPurState\.tag = tagBtn\.getAttribute\('data-pur-tag'\)/.test(js),
  'tag 过滤用后端返回的 tags 渲染 chip，点了带 tag 重拉第一页');
check(/id="purSearch"/.test(js) && /window\.setTimeout\(function \(\) \{ libPurLoad\(true\); \}, 250\)/.test(js),
  '已购库内搜索 250ms 防抖后重拉第一页');
check(/if \(\/HTTP 404\/\.test\(msg\)\) return '后端还没有已购库接口/.test(js),
  '404 人话化成「后端还没有已购库接口」');
check(js.indexOf("replace(/^HTTP") >= 0 && /function libPurError\(error\)/.test(js),
  '其它失败（含 409 暂停）剥掉 HTTP 前缀直接透后端原文（不吞掉 paused 的中文提示）');
check(!/target="_blank"/.test(js) && !/target=\"_blank\"/.test(js),
  '已购库商品页只走 data-copy 复制链接，不开新标签');
check(/function libPurCover\(item\)/.test(js) && /referrerpolicy="no-referrer"/.test(js) && /onerror="this\.hidden=true;if\(this\.nextElementSibling\)this\.nextElementSibling\.hidden=false"/.test(js),
  '封面优先远程 coverUrl（懒加载 + no-referrer + onerror 换占位），远程挂了/没有才回落本地封面接口');
check(/var local = item && item\.boothId \? '\/api\/files\/cover\/'/.test(js) && /\/\^https\?:\/i\.test\(remote\)/.test(js),
  '有 coverUrl 就用 coverUrl（http(s) 不加令牌），否则用本地 /api/files/cover/号，再没有才「没封面」');
check(/data-write="library-purchases-open-page"/.test(js) && /'library-purchases-open-page': function \(btn\)/.test(js),
  '卡片有「商品页 ↗」按钮（新 action，仍不新开标签/不用 window.open）');
check(js.indexOf("apiWrite('/api/open-url', { url: url })") >= 0 && js.indexOf('已在浏览器打开商品页') >= 0,
  '「商品页 ↗」主路径走 POST /api/open-url（系统浏览器打开）并在成功时 toast「已在浏览器打开商品页」');
check(js.indexOf('没能打开，链接已复制：') >= 0 && js.indexOf('copyText(url).then(function ()') >= 0,
  'open-url 失败（400/500/网络）降级为复制链接 + toast「没能打开，链接已复制：…」');
check(js.indexOf('function libPurPageUrlOk(url)') >= 0 && js.indexOf('booth' + String.fromCharCode(92) + '.pm|booth' + String.fromCharCode(92) + '.pximg' + String.fromCharCode(92) + '.net') >= 0 && js.indexOf('/^https:') >= 0 && js.indexOf('if (!libPurPageUrlOk(url))') >= 0,
  '只对 BOOTH 的 https 域名发起 open-url（非 BOOTH 链接只复制，不开门）');
check(js.indexOf('item.coverRemote === true') >= 0 && js.indexOf('var rawRemote =') >= 0,
  'coverRemote:true 时按远程图原样直连，不加 token query');
check(/适配模型 '/.test(js) && /numText\(models\.max \|\| 0\)/.test(js),
  '卡上显示适配模型 max / total');
check(/runWrite\(btn, function \(\) \{ return libraryPurchasesOpen/.test(js) === false && /library-purchases-resolve/.test(js),
  '写的动作都包在 runWrite 里（防连点）');

// ── 11b. 可编辑「识别规则表」（07g） ─────────────────────────────────────────
check(/function libraryAliasButton\(\)/.test(js) && /data-write="library-alias"/.test(js),
  '文件库工具栏有「识别规则」按钮（data-write="library-alias"）');
check(/'library-alias': function \(\) \{ return libraryAliasOpen\(\); \}/.test(js),
  '01-shell 注册 library-alias → libraryAliasOpen');
check(/api\('\/api\/library\/alias-rules'\)/.test(js) && /fetch\('\/api\/library\/alias-rules'/.test(js),
  '读用 GET /api/library/alias-rules，保存打同一路径');
check(/var verb = 'PUT';/.test(js) && /body: JSON\.stringify\(\{ text: text \}\)/.test(js),
  '保存是 PUT { text }（动词走变量，页面仍只有 apiWrite 一处字面量 POST）');
check(/id="aliasText"/.test(js) && /class="qdb-textarea qdb-alias-text"/.test(js),
  '弹层里是等宽大号 textarea（#aliasText / .qdb-alias-text）');
check(/ALIAS_SAMPLE = \['Plum=plum\|プラム', 'R-18=R18\|18禁', 'Normal=ノーマル\|通常'\]/.test(js)
  && /placeholder="' \+ esc\(ALIAS_SAMPLE\.join\('\\n'\)\)/.test(js),
  '表为空时只把三行示例当 placeholder（不写进后端）');
check(/aliasListHtml\(errors, 'load'\)/.test(js) && /aliasListHtml\(lines, 'save'\)/.test(js),
  '解析失败的行原文列在弹层里（载入与保存两个方向都列）');
check(/已保存 ' \+ numText\(n\) \+ ' 条规则'/.test(js),
  '保存成功 toast「已保存 N 条规则」');
check(/a\.aliasTitle \? '原名：'/.test(js) && /a\.aliasTitle \|\| \(meta && meta\.title\)/.test(js),
  '卡片有 aliasTitle 时显示别名，hover title 里写「原名：…」');
check(/\.qdb-alias-text \{ min-height: 240px; \}/.test(css) && /\.qdb-alias-errors li \{ overflow-wrap: anywhere; \}/.test(css),
  '识别规则弹层的编辑区与失败行列表有样式（窄屏也不撑破）');

console.log('## 已购 ⇄ 素材库同步工具条（07n）');
check(/client\/07n-library-sync\.js|function libSyncBarHtml\(\)/.test(js) && /function libSyncButton\(\)/.test(js),
  '同步片段存在：工具条 + 工具栏入口');
check(/data-write="library-sync-open"/.test(html) && /\+ libSyncButton\(\)/.test(js),
  '文件库工具栏有「同步已购」入口（原来的只读对账按钮保留）');
check(/<div id="syncBar"><\/div>/.test(js) && /libSyncLoad\(\);/.test(js),
  '已购库弹层里有同步工具条容器，打开即拉一次对账');
check(/api\('\/api\/library\/reconcile\?deep=1'\)\.catch\(function \(\) \{ return api\('\/api\/library\/reconcile'\); \}\)/.test(js),
  '先要 deep=1 的细数据，后端没实现 deep 时自动退回普通对账');
check(/'library-sync': function \(btn\)/.test(js) && /'library-sync-bind'/.test(js) && /'library-sync-download'/.test(js) && /'library-sync-forget'/.test(js) && /'library-sync-open'/.test(js),
  '五个 action 都注册了（打开 / 同步 / 绑定 / 补下 / 撤销）');
check(/apiWrite\('\/api\/library\/reconcile\/sync', \{ dryRun: true \}\)/.test(js) && /dryRun: false, decisions: picked/.test(js),
  '同步先 dryRun 拿动作列表、确认后再真执行（不是一点就动手）');
check(/apiWrite\('\/api\/library\/reconcile\/bind', body\)/.test(js) && /body\.keys = g\.keys/.test(js),
  '「绑定另一件」按号提交 { boothId, keys }');
check(/apiWrite\('\/api\/library\/reconcile\/download', \{ boothId: ids\[i\] \}\)/.test(js),
  '「补下」按 { boothId } 逐件补');
check(/apiWrite\('\/api\/library\/reconcile\/forget', \{ boothIds: picked \}\)/.test(js),
  '「有 N 件删了」走 { boothIds } 撤销，且是危险二次确认');
check(/后端还没上线同步接口（重启桥接后再试）/.test(js) && /ready && pending \? '' : ' disabled'/.test(js),
  '接口没上线时按钮禁用 + 一句实话，不让人点了才报错');
check(/st\.forgotten \?/.test(js) && /有 ' \+ numText\(st\.forgotten\) \+ ' 件删了（点这里）/.test(js),
  '只有真有被删条目时才出现「有 N 件删了」，平时不吓人');
check(/st\.missing\s*\? '<button class="qdb-btn qdb-btn-mini qdb-btn-danger" type="button" data-rec-view="missing"/.test(js) && /缺少 ' \+ numText\(st\.missing\) \+ ' 件，去补/.test(js),
  '对完还有 missing 时，那个按钮从「重新对账」变成「缺少 N 件，去补」并切到缺少列表');
check(!/scrollIntoView/.test(js.slice(js.indexOf('function libSyncButton'), js.indexOf('function libSyncButton') + 200)) && /box\.scrollTop = Math\.max\(0, bar\.offsetTop - 80\)/.test(js),
  '打开同步条只滚弹层内部，不用 scrollIntoView 把整页一起滚');

console.log('## 回收站存储（07k）');
check(/api\('\/api\/library\/trash\/storage'\)/.test(js), '回收站拉 /api/library/trash/storage');
check(/function libTrashStorageHtml\(\)/.test(js) && /st\.root/.test(js) && /st\.diskFree/.test(js) && /st\.bytes/.test(js),
  '存储行读 root（后端字段名）/ 体积 / 剩余空间（保留期留在原来那条 hint，不重复）');
check(/if \(st\.root\)/.test(js) && /free != null && Number\.isFinite/.test(js),
  'diskFree/diskTotal 为 null 时只显示路径/体积/文件数，不显示磁盘段');
check(/data-trash-cleanup="1"/.test(js) && /'library-trash-cleanup'/.test(js),
  '「清理」按钮 + action 注册');
check(/apiWrite\('\/api\/library\/trash\/cleanup', \{ confirm: true \}\)/.test(js),
  '清理请求带 confirm:true（后端要求，apiWrite 不会自动补字段）');
check(/var out = d \|\| \{\}, purged = Number\(out\.purged\) \|\| 0/.test(js) && /清掉 ' \+ numText\(purged\) \+ ' 项 · 释放 '/.test(js),
  '成功 toast 读 purged（不是 removed），文案「清掉 N 项 · 释放 X」');
check(/purged === 0 && out\.skipped[\s\S]{0,80}out\.note/.test(js) && /if \(out\.error\) toast\(String\(out\.error\)/.test(js),
  'purged=0 且 skipped 时用后端 note 说明原因；有 error 时直接显示 error');
check(/立即清理过期/.test(js) && /只清超过保留期/.test(js) && /不可撤销/.test(js) && /danger: true/.test(js),
  '「立即清理过期」是危险二次确认（只清超期、不可撤销）');

console.log('## 已购库：从 BOOTH 同步（07f）');
check(/stopped === 'rate_limited'\) line \+= ' · 上次被限速'/.test(js) && /stopped === 'max_pages'/.test(js) && /上次只同步了 ' \+ numText/.test(js),
  'stopped 三态：rate_limited 才写「上次被限速」，max_pages 写「上次只同步了 N 页」，其它不写死');
check(/var stopped = lastResult\.stopped \? String\(lastResult\.stopped\) : ''/.test(js),
  'stopped 只认字符串枚举，不再用布尔「有 stopped 就当限速」');
check(/data-write="library-purchases-sync"/.test(js) && /'library-purchases-sync': function \(btn\)/.test(js),
  '弹层顶部有「从 BOOTH 同步已购」按钮并注册 action');
check(/apiWrite\('\/api\/library\/purchases\/sync', \{ dryRun: true \}\)/.test(js) && /dryRun: false \}\)/.test(js),
  '先 dryRun 预览、确认后才真同步');
check(/将新增 ' \+ numText\(added\) \+ ' 件、更新 ' \+ numText\(updated\) \+ ' 件、未变 ' \+ numText\(unchanged\)/.test(js),
  '确认层写明「新增 X 件、更新 Y 件、未变 Z 件」');
check(/新增 ' \+ numText\(Number\(o\.added\) \|\| 0\) \+ ' · 更新 ' \+ numText\(Number\(o\.updated\) \|\| 0\) \+ ' · 未变 '/.test(js),
  '完成 toast 是「新增 X · 更新 Y · 未变 Z」');
check(/BOOTH 登录过期了：重新贴一次 Cookie/.test(js) && /HTTP 401/.test(js) && /data-write="library-purchases-sync-settings"/.test(js) && /'library-purchases-sync-settings'/.test(js),
  '401 → 「BOOTH 登录过期了」+ 弹层里给「去设置」（不新开页，关掉弹层切设置页）');
check(/还没登录 BOOTH/.test(js) && /HTTP 400/.test(js),
  '400 → 「还没登录 BOOTH」');
check(/o\.stopped === 'rate_limited'/.test(js) && /被 BOOTH 限速/.test(js),
  'stopped=rate_limited → 黄字「被 BOOTH 限速，已同步 X 件」');
check(/\/api\/library\/purchases\/sync\/status/.test(js) && /上次同步 ' \+ last/.test(js) && /还没同步过/.test(js) && /上次被限速/.test(js),
  '状态行读 sync/status：上次同步时间 / 「还没同步过」/ lastResult.stopped 追加「上次被限速」');
check(/同步中…' \+ \(st\.syncPage > 1 \? '（第 ' \+ numText\(st\.syncPage\) \+ ' 页）'/.test(js) && /st\.syncing \|\| st\.syncUnsupported/.test(js),
  '运行中按钮变「同步中…（第 N 页）」并禁用');
check(/item\.isNew \|\| \(item\.source === 'library-sync' && syncedAt && Date\.now\(\) - syncedAt < 86400000\)/.test(js) && /同步来的/.test(js),
  '本次同步新加的卡片带「同步来的」chip（24 小时内的 library-sync 也算）');
check(/syncUnsupported = true/.test(js) && /后端还没上线同步接口（重启桥接后再试）/.test(js),
  'sync 接口 404 时按钮禁用 + 一句人话');


console.log('## 已购库：截图导入（07f）');
check(/id="purOcrFile" accept="image\/png,image\/jpeg,image\/webp"/.test(js) && /qdb-pur-file/.test(css),
  '「截图导入」挂一个隐藏的图片选择框（png / jpeg / webp）');
check(/var LIBPUR_OCR_MAX_SIDE = 1600, LIBPUR_OCR_TIMEOUT = 60000/.test(js)
  && /keepType && side <= LIBPUR_OCR_MAX_SIDE/.test(js)
  && /type === 'image\/png' \|\| type === 'image\/jpeg'/.test(js)
  && /toDataURL\('image\/jpeg', 0.95\)/.test(js)
  && /'data:' \+ \(file\.type \|\| 'image\/png'\) \+ ';base64,'/.test(js),
  'PNG/JPEG 且长边 ≤1600 原图直传（不 canvas 重编码，保住 OCR 精度）；超长边/webp 才缩到 1600、JPEG 0.95');
check(js.indexOf("'/api/library/purchases/ocr'") >= 0 && /JSON\.stringify\(\{ image: dataUrl \}\)/.test(js)
  && /LIBPUR_OCR_TIMEOUT = 60000/.test(js) && /AbortController/.test(js)
  && /识别太久了（超过 60 秒），换张更清楚的截图或裁掉外框再试/.test(js) && /后端还没上线截图识别（重启桥接后再试）/.test(js),
  'POST /ocr 带 { image } base64；60s 超时（AbortController）与 404 都给人话（不静默）');
check(/已识别 ' \+ numText\(items\.length\) \+ ' 件/.test(js) && /enriched === false/.test(js)
  && /件没抓到商品页资料（标题来自截图）/.test(js),
  '识别结果卡报「已识别 N 件」，有 enriched:false 时补「其中 M 件没抓到商品页资料」');
check(/qdb-pur-ocr-row/.test(js) && /导入这件/.test(js) && /data-write="library-purchases-import" data-booth="/.test(js)
  && /byId\('purSearch'\)[\s\S]{0,60}items\[0\]\.title/.test(js),
  'items 三态：识别结果卡逐行「标题 #号 店铺 价格 + 导入这件」，并把第一个标题填进库内搜索');
check(/byId\('purQuery'\)[\s\S]{0,80}titles\[0\]/.test(js) && /个可能的商品名，选一个点解析/.test(js),
  '只有 hints.titles 时：把标题填进解析输入框 + toast「识别到 N 个可能的商品名」');
check(/d\.reason === 'no_ocr'/.test(js) && /这台机器没装 OCR 语言包，识别不了截图/.test(js)
  && /识别到文字但没匹配到商品号\/链接，试试裁掉外框再传/.test(js),
  'no_ocr 与「识别到字但没匹配到商品」两种结果各有明确文案');
check(/var raw = String\(\(it && it\.correctedFrom\) \|\| ''\)/.test(js)
  && /var guess = Boolean\(raw \|\| \(it && it\.enriched === false\)\)/.test(js)
  && /data-guess="1"/.test(js),
  '「纠正出来的号」和「没抓到商品页」的行打 data-guess 标记（导入前会二次确认）');
check(/btn\.getAttribute\('data-guess'\) === '1'/.test(js)
  && /这个号是 OCR 猜出来 \/ 没抓到商品页的，确认导入 #/.test(js)
  && /confirmLabel: '导入'/.test(js),
  'data-guess 行点「导入这件」先弹确认层（说明猜出来的号），确认后才 POST import');
check(/\$\{?enriched|enriched === false\s*\n?\s*\? '#/.test(js) || /'#' \+ esc\(id \|\| '\?'\) \+ ' · 店铺\/价格 未取到'/.test(js),
  'enriched:false 的行把店铺/价格位显示成「未取到」');



// ── 13. 文件库批量多选与批量操作条 ──────────────────────────────────────────
console.log('## 文件库批量多选');
const batchSrc = fs.readFileSync(path.join(ROOT, 'client/07o-library-batch.js'), 'utf8');
check(/function libBatchCheck\(a\)/.test(batchSrc) && /var LIB_BATCH_MAX = 200;/.test(batchSrc)
  && /function libBatchBarHtml\(\)/.test(batchSrc) && /data-lib-check=/.test(batchSrc),
  '新片段：勾选框（data-lib-check）与批量条渲染函数都在，一次最多 200 件');
check(/\+ libBatchCheck\(a\)/.test(js) && js.indexOf("var card = boxes[i].closest ? boxes[i].closest('.qdb-asset')") >= 0,
  '勾选框只挂在素材卡左上角（卡片渲染里一行挂载，选中态靠 .is-selected 描边）');
check((js.match(/\+ libBatchBarHtml\(\)/g) ?? []).length >= 1 && proSrc.indexOf('libProBatch') >= 0 && proSrc.indexOf('libBatchBarHtml()') >= 0,
  '批量条挂在素材库页（文件库素材区已移除，找号页已删）');
check(js.indexOf('已选 ') >= 0 && js.indexOf('全选本页') >= 0 && js.indexOf('清空</button>') >= 0
  && js.indexOf('library-batch-bind') >= 0 && js.indexOf('library-batch-merge') >= 0 && js.indexOf('library-batch-trash') >= 0,
  '批量条：已选 N 件 + 全选本页 / 清空 / 绑定同号 / 合并同号 / 移入回收站');
check(js.indexOf("'library-batch-select-all'") >= 0 && js.indexOf("'library-batch-clear'") >= 0
  && js.indexOf("'library-batch-bind'") >= 0 && js.indexOf("'library-batch-merge'") >= 0 && js.indexOf("'library-batch-trash'") >= 0,
  '五个批量动作都注册进 WRITE_ACTIONS（走既有 data-write 委托）');
check(/function libBatchOnPage\(\)/.test(js) && /var grid = byId\('libGrid'\)/.test(js) && /if \(byId\('findGrid'\)\)/.test(js),
  '全选本页只取当前这一屏：文件库看 #libGrid、找号页看 findState.items');
check(/if \(uniq.length > 1\)/.test(js) && js.indexOf('一次只能合并同一个号') >= 0 && /if \(noId\)/.test(js),
  '合并前先拦：号不一致 / 有没号的件都直接说，不发请求');
check(/apiWrite\('\/api\/library\/batch', body\)/.test(js) && js.indexOf("action: 'bind', keys: keys, boothId: id") >= 0
  && js.indexOf("action: 'merge', keys: keys, boothId: boothId") >= 0
  && js.indexOf("action: 'trash', keys: keys") >= 0,
  '三个请求体形状对齐真实后端：bind/merge 顶层 boothId、trash 只有 action+keys（后端不读 confirm）');
check(js.indexOf('已绑定 {n} 件') >= 0 && js.indexOf('已合并 {n} 件') >= 0 && js.indexOf('已移入回收站 {n} 件') >= 0
  && js.indexOf('跳过 ') >= 0 && js.indexOf('批量结果') >= 0,
  '成功 toast 三种口径 + 跳过 N 件，失败/跳过给「批量结果」明细（前 3 条）');
check(js.indexOf("ev.key !== 'Escape'") >= 0 && js.indexOf("document.querySelector('.qdb-dialog-mask, .qdb-drawer-mask')") >= 0
  && js.indexOf("if (ev.target && ev.target.id === 'libSearch') libBatchClear();") >= 0
  && js.indexOf("t.closest('[data-view]')") >= 0,
  'Esc 清空（弹层开着时不抢），切筛选/搜索/翻页/换视图都清空选中');
check(/\.qdb-asset-check \{/.test(css) && /\.qdb-asset\.is-selected \{/.test(css) && /\.qdb-batch-detail li \{/.test(css),
  '勾选框 / 选中描边 / 明细列表的样式都在，且都留了窄屏换行');

// ── 14. 归位（日期目录搬回独立目录）──────────────────────────────────────────
console.log('## 素材归位');
const relocateSrc = fs.readFileSync(path.join(ROOT, 'client/07p-library-relocate.js'), 'utf8');
check(relocateSrc.indexOf('var LIB_RELOCATE_DATE_RE = /^') >= 0 && relocateSrc.indexOf('^' + String.fromCharCode(92) + 'd{4}-' + String.fromCharCode(92) + 'd{2}$') >= 0 && /function libraryRelocateDateOf\(dir\)/.test(relocateSrc)
  && relocateSrc.indexOf('parts[parts.length - 1]') >= 0,
  '可归位判定：dir 末段必须匹配 ^\d{4}-\d{2}$（2026-10 这种日期目录）');
check(/data-write="library-relocate"/.test(relocateSrc) && relocateSrc.indexOf("if (!dateDir) return '';") >= 0
  && /\+ libraryRelocateButton\(a\)/.test(js),
  '只有日期目录里的素材才多一个「归位」按钮（合并卡按主件目录判断）');
check(js.indexOf("apiWrite('/api/library/relocate', { key: key, dryRun: true })") >= 0,
  '点「归位」先发 dryRun 预览，不直接搬');
check(js.indexOf("justify") < 0 && js.indexOf('只搬目录，不改文件名') >= 0 && js.indexOf("confirmLabel: '归位'") >= 0
  && js.indexOf("apiWrite('/api/library/relocate', { key: key })") >= 0,
  '确认层写明 from/to/文件数，确认后才真搬（第二次 POST 不带 dryRun）');
check(js.indexOf("toast('已归位到 '") >= 0 && js.indexOf("return pageLoad('library', true);") >= 0,
  '成功后 toast「已归位到 <toDir>」并重拉列表');
check(js.indexOf('function libRelocateErrText(error)') >= 0 && js.indexOf('replace(/^HTTP') >= 0 && js.indexOf('目标目录已存在') >= 0,
  '400/409 透后端原文（剥掉 HTTP 前缀），409 额外提示「换个名字 / 撤销归位」');
check(js.indexOf("apiWrite('/api/library/relocate/undo', {})") >= 0 && js.indexOf("toast('已撤销最近一次归位：'") >= 0
  && js.indexOf('没有可撤销的归位') >= 0,
  '「撤销归位」不带 id 调 undo；成功 toast 带标题，没记录时 toast「没有可撤销的归位」');
check(js.indexOf("'library-relocate': function (btn)") >= 0 && js.indexOf("'library-relocate-undo': function (btn)") >= 0
  && /\+ libRelocateUndoButton\(\)/.test(js),
  '两个写 action 注册进 WRITE_ACTIONS，工具栏有「撤销归位」按钮');

// ── 11. 页面自身可解析（结构自证） ───────────────────────────────────────────
// ── 12. 聊天图片走本地媒体缓存（QQ 直链会过期） ──────────────────────────────
console.log('## 聊天图片与媒体缓存');
check(/function mediaSourceFor\(item\)/.test(html), '有 mediaSourceFor：统一决定图片走哪拿');
check(/return kind === 'sticker' && url \? url : ''/.test(html) || /if \(kind === 'sticker' && url\) return url;/.test(html), '表情直链（p.qpic.cn）长期有效，直连不绕缓存');
check(/'\/api\/socialV2\/media-cache\?file=' \+ encodeURIComponent\(ref\)/.test(html), '普通图片改走 /api/socialV2/media-cache');
check(/var alt = file && url && url\.indexOf\('\/\/'\) > 0 \? '&alt=' \+ encodeURIComponent\(url\) : '';/.test(html), '文件名查不到时带 alt 直链兜底');
check(/function bindMediaErrorFallback\(\)/.test(html), '有图裂兜底（换成一句人话）');
check(/document\.addEventListener\('error', function \(event\)/.test(html) && /\}, true\);/.test(html), '兜底走捕获阶段（<img> 的 error 不冒泡）');
check(/bindMediaErrorFallback\(\);/.test(html), 'onReady 里挂了兜底');
check(!/onerror=/.test(js) === false, '封面占位用内联 onerror 兜底（已改成 hidden 兄弟占位，不塞 HTML 片段）');
check(/var MEDIA_TAG = \{ video: '视频', voice: '语音', file: '文件', face: '表情' \};/.test(html), '视频/语音/文件给中性标签，不画成图');
check(/\.qdb-msg-media-tag \{/.test(html), '标签样式存在');
check(/\.qdb-msg-img-missing \{/.test(html), '图裂占位样式存在');

console.log('## 滚动条');
check(/\*::-webkit-scrollbar \{ width: 10px; height: 10px; \}/.test(html), '滚动条宽度统一成 10px（不再吃浏览器默认的粗条）');
check(/\*::-webkit-scrollbar-track, \*::-webkit-scrollbar-corner \{ background: transparent; \}/.test(html), '滚动条轨道透明（不画一条深色沟）');
check(/color-mix\(in srgb, var\(--ui-muted\) 34%, transparent\)/.test(html), '滑块是半透明（从 --ui-muted 混出来，换主题/皮肤自动跟随）');
check(/\*::-webkit-scrollbar-thumb:hover \{ background: rgba\(97, 116, 110, \.52\); background-clip: padding-box; background: color-mix\(in srgb, var\(--ui-muted\) 55%, transparent\)/.test(html), '悬停时滑块加深一点（仍半透明）');
check(/scrollbar-width: thin; scrollbar-color: rgba\(97, 116, 110, \.34\) transparent; scrollbar-color: color-mix/.test(html), 'Firefox 的 scrollbar-width/scrollbar-color 也写了（带 rgba 兜底）');
check(/\.qdb-nav::-webkit-scrollbar \{ display: none; \}/.test(html), '顶部导航胶囊那条横向滚动条仍然隐藏');

console.log('## 群友备注');
check(html.includes("'/api/member-notes'"), '读取与写入都走 /api/member-notes');
check(/function noteOf\(userId\)/.test(html) && /function nameOfMember\(userId, fallback\)/.test(html), '有备注查表与「备注优先」取名助手');
check(/function applyNotesResult\(data\)/.test(html) && /notesState\.map = map;/.test(html), 'POST 返回的整份备注能覆盖本地缓存');
check(/function ensureMemberNotes\(\)/.test(html) && /api\('\/api\/sessions'\),\s*api\('\/api\/socialV2\/states'\),\s*ensureMemberNotes\(\)/.test(html), '会话页开屏就把备注一起取回来（/api/status 只是并列多取一份）');
check(/var note = noteOf\(uid\);/.test(html) && /esc\(name\)/.test(html), '成员行用备注名当主标题');
check(/if \(note && nick\) sub = '原名 ' \+ nick \+ ' · ' \+ sub;/.test(html), '有备注时第二行标出原名 + QQ 号');
check(/data-write="member-note"/.test(html), '成员行有备注入口（data-write 委托）');
check(/'member-note': function \(btn\) \{/.test(html) && /apiWrite\('\/api\/member-notes', \{ userId: uid, name: name \}\)/.test(html), '备注写入走唯一写入口 apiWrite');
check(/name: mine \? \(logCache\.bot\.nickname \|\| String\(m\.sender \|\| '机器人'\)\) : nameOfMember\(m\.userId/.test(html), '日志时间线的群友名字也走备注');
check(/var who = nameOfMember\(msg && msg\.userId, String\(\(msg && msg\.sender\) \|\| '\?'\)\);/.test(html), '头像首字跟着备注走');
check(/function repaintAfterNote\(\)/.test(html) && /sessState\.rendered/.test(html), '改完备注就地重画成员与消息，不整页重取');
check(/\.qdb-member-note \{/.test(html), '备注按钮样式存在');
check(/<span class="qdb-member-note-txt">备注<\/span>/.test(html), '没备注的成员按钮上直接写「备注」，不用猜加号是干什么的');
check(/title="' \+ esc\(note \? '改备注' : '给 TA 加备注'\)/.test(html), '按钮悬停有说明（加备注 / 改备注）');
check(/\.qdb-member-note [^{]*?\{[^}]*?height: 26px/.test(css) && /\.qdb-member-note \{[^}]*?font-weight: 700/.test(css), '备注按钮放大到 26px 高、加粗');
check(/opacity: 1; \}/.test(css.slice(css.indexOf('.qdb-member-note {'), css.indexOf('.qdb-member-note {') + 700)), '备注按钮常驻可见（不再靠悬停才提亮）');
check(/\.qdb-member-note > span\[aria-hidden\] \{ font-size: 16px; font-weight: 800;/.test(css), '加号本体 16px / 800 粗');
check(/\.qdb-member-note:hover \{ color: #fff; background: var\(--ui-accent\);/.test(css), '悬停时整颗按钮变实心强调色');
check(/var SESS_SEEN_KEY = 'qdb-sess-seen'/.test(js) && /function sessSeenSeq\(key\)/.test(js), '会话「新消息」按操作者的阅读水位算（localStorage 记到哪条 seq）');
check(/function freshCountOf\(key, st\)/.test(js) && /var last = sessLastSeqOf\(st\);/.test(js) && /Math\.max\(0, last - sessSeenSeq\(key\)\)/.test(js), '新消息数 = 会话最新 seq − 已看 seq');
check(/lastSeq: latestMessageSeq\(st\)/.test(consoleSources) && /function latestMessageSeq\(st\)/.test(consoleSources), '/api/socialV2/states 下发 lastSeq（控制台自己算新消息，不借机器人的未读）');
check(!/'<span>未读 ' \+ numText/.test(js) && !/合计未读 ' \+ /.test(js) && !/cdNum\(x\.unreadCount\)/.test(js), '列表 / 仪表盘 / 详情里都不再出现「未读」这词');
check(/<span class="qdb-hit-new"><i class="qdb-dot" aria-hidden="true"><\/i>新 '/.test(js), '会话行有新消息时显示红点 + 「新 N」');
check(js.includes('sessCardRowHtml') && js.includes("'<b class=\"qdb-sess-new\">新 ' + numText(freshN)") && js.includes('<span class=\"qdb-sess-done\">看过</span>'), '仪表盘会话卡：行内是头像 + 名字 + 最后一句 + 「新 N」/「看过」');
check(/cdChip\(freshN \? 'warn' : 'ok', freshN \? '新 ' \+ cdNum\(freshN\) \+ ' 条' : '看过'\)/.test(js), '会话卡详情弹层的状态 chip 也跟着改');
check(/function sessPreviewOf\(item\)/.test(js) && /item\.lastMessage/.test(js), '卡片与详情共用「最后一句」预览（读后端 lastMessage）');
check(js.includes("avatarHtml(sessionAvatarUrl(key), 'qdb-sess-ava')"), '会话卡每行带头像（群徽标 / QQ 头像）');
check(js.includes("data-goto=\"sessions\"") && js.includes('qdb-sess-list'), '卡片行可点，直接跳会话页');

// 仪表盘会话卡：最后一句取消息库里最新那条，并标出「多久之前」，避免拿几天前的旧缓存冒充实时
check(/item\.lastMessage\.at/.test(js), '会话卡读 lastMessage.at 判断这条有多新');
check(/relative\(lastAt\)/.test(js), '会话卡把最新一条的时间换成「几分钟前」');
check(/\.qdb-sess-ago \{/.test(css), '相对时间有独立样式（灰、小号）');
check(/还没有消息/.test(js), '库里没有记录时才回退「还没有消息」');
check(/\.qdb-sess-row \{[^}]*display: flex/.test(css) && /\.qdb-sess-preview \{[^}]*line-clamp: 1/.test(css), '会话行是 flex 两列布局，预览单行截断（不用 nowrap）');
check(/一打开就=\S*看过/.test(js) || /markSessSeen\(key\); \/\/ 打开就/.test(js), '打开会话即标记已看');
check(/markSessSeen\(sessState\.key\); \/\/ 补进视口/.test(js), '自动补进视口也算看过，红点会清掉');
check(/\.qdb-hit-new \{[^}]*color: var\(--ui-danger\)/.test(css) && /\.qdb-hit-new \.qdb-dot \{[^}]*background: var\(--ui-danger\)/.test(css), '红点：danger 色圆点 + 数字加粗');
check(/\.qdb-msg-newpill::before/.test(css) && /\.qdb-msg-newpill \{[^}]*display: inline-flex/.test(css), '消息区浮标前面也有红点，和列表语义一致');
// .qdb-list li 的 baseline 对齐会把头像顶上去、两行文字压下去（img 的 baseline 在底边）：
// 会话行必须显式改回垂直居中，头像再 align-self 兜一层，免得以后换父容器又错位。
check(/\.qdb-sess-list \.qdb-sess-row \{ align-items: center; \}/.test(css) && /\.qdb-sess-ava \{ align-self: center; \}/.test(css), '会话行的头像和两行文字垂直居中（压过 .qdb-list li 的 baseline）');

console.log('## 弹层底色与宽窄布局');
check(/--ui-dialog-bg: rgba\(255, 255, 255, \.9[0-9]?\)/.test(css), '浅色弹层底色更不透明（≥.9 白）');
const dialogTokenCount = (css.match(/--ui-dialog-bg: /g) || []).length;
check(dialogTokenCount === 9, '每套皮肤/主题组合都有弹层底色（根 + 深色 + 纸感/蜜桃/淡粉各两套 + 数据环一套共用）', dialogTokenCount);
check(/\[data-glass="on"\] \.qdb-dialog \{[^}]*background: color-mix\(in srgb, var\(--ui-dialog-bg\) 94%, transparent\)/.test(css), '毛玻璃下弹层用更实的专用底色，不再用面板同款玻璃');
check(/\[data-glass="on"\] \.qdb-dialog \{[^}]*backdrop-filter: blur\(38px\) saturate\(150%\)/.test(css), '弹层模糊半径单独一档（38px，比卡片更重）');
check(/\[data-glass="on"\] body::before \{[^}]*linear-gradient/.test(css) && /\[data-glass="on"\] body::after \{[^}]*background: none/.test(css),
  '玻璃层保持中性：只留一层极淡的白，不再铺彩色光雾（颜色归数据，不归外壳）');
check(/\[data-glass="on"\] body::before \{[\s\S]{0,400}?linear-gradient\(160deg, #ffffff 0%/.test(css),
  '整屏一层极淡的白（不是彩团）：玻璃只做质感，正文区域保持中性');
check(/radial-gradient\(760px 620px at 14% 8%/.test(css) && /radial-gradient\(720px 560px at 90% 26%/.test(css) && /radial-gradient\(680px 520px at 38% 108%/.test(css),
  '光团用固定像素落在内容区（不用 vmax：超宽屏会把光摊成整屏一块平色）');
check(/@keyframes qdb-glass-drift/.test(css)
  && /@media \(prefers-reduced-motion: reduce\) \{\s*\[data-glass="on"\] body::before,[\s\S]{0,200}animation: none;/.test(css),
  '光雾缓慢流动，并尊重「减少动态」偏好');
check(/\[data-glass="on"\] \.qdb-card,[\s\S]{0,280}background-color: color-mix\(in srgb, var\(--ui-surface-solid\) 90%, transparent\)/.test(css),
  '毛玻璃卡片是「磨砂白」（90% 实色快照）：字压在实底上，模糊只负责质感');
check(/backdrop-filter: blur\(16px\) saturate\(110%\)/.test(css), '卡片用轻模糊 + 正常饱和（不再靠高饱和把背景糊成色块）');
check(/\[data-glass="on"\] \.qdb-card,[\s\S]{0,700}radial-gradient\(96% 74% at 2% 0%/.test(css),
  '玻璃面有一道固定的顶角柔光（模拟斜上方的光源），否则只是雾面塑料');
check(/feTurbulence type='fractalNoise'/.test(css), '玻璃面叠一层内联噪点当磨砂颗粒（通透感靠这层细节）');
check(!/@keyframes qdb-glass-sheen/.test(css),
  '不再有「每隔一会扫过一道线」的定时扫光（用户明确不要这种动画）');
check(/@keyframes qdb-glass-breathe/.test(css) && /animation: qdb-glass-breathe/.test(css),
  '第二层彩光会明暗呼吸（周期与drift 错开）');
check(/\[data-glass="on"\] \.qdb-card::before[\s\S]{0,400}radial-gradient\(360px circle at var\(--qdb-gx/.test(css)
  && /\[data-glass="on"\] \.qdb-card\[data-glare="1"\]::before/.test(css),
  '光标停在卡片上时有一团柔光跟着走，透明度只由 data-glare 抬起（交互式的玻璃高光）');
check(/@property --qdb-gx \{ syntax: '<length>'/.test(css) && /transition: opacity \.42s ease, --qdb-gx \.16s linear/.test(css),
  '光源位置用 @property 注册成可过渡的自定义属性：手停下时光会缓缓落定，不是硬跳');
check(/\[data-glass="on"\] \.qdb-card::after[\s\S]{0,400}radial-gradient\(420px circle at var\(--qdb-sx/.test(css)
  && /mix-blend-mode: multiply/.test(css),
  '反光的对侧压一层极淡柔影（玻璃的厚度感靠这一明一暗）');
check(/function showTokenGate\(\)/.test(js) && /data-token-gate/.test(js),
  '没有令牌时弹一层输入框（不用自己去设置里翻），令牌只落本机');
check(/if \(res\.status === 401\) showTokenGate\(\);/.test(js),
  '401 才弹输入层：Cookie 已经能用的刷新不会打扰人');
check(/localStorage\.setItem\(TOKEN_KEY, value\);/.test(js) && /window\.location\.reload\(\);/.test(js),
  '填完令牌存本机并立刻重载（存不住也能用这一次）');
check(/function bindGlassGlow\(\)/.test(js) && /addEventListener\('pointermove'/.test(js) && /requestAnimationFrame/.test(js)
  && /matchMedia\('\(hover: hover\) and \(pointer: fine\)'\)/.test(js) && /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/.test(js)
  && /setProperty\('--qdb-sx'/.test(js) && /setAttribute\('data-glare', '1'\)/.test(js),
  '光标高光用 rAF 节流、只绑一次，触摸屏与「减少动态」下不启用；同时写反光与对侧柔影两套变量');
check(/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,500}\.qdb-card::after/.test(css),
  '「减少动态」偏好下扫光也停掉');
check(/\[data-theme="dark"\]\[data-glass="on"\] body::before \{[\s\S]{0,1200}?linear-gradient\(160deg, #0c1513 0%/.test(css),
  '深色主题把光雾里那层「整屏近白底」换成深色底（否则最上面会糊出一块没变黑的浅灰带）');
check(/\[data-theme="dark"\]\[data-glass="on"\] body::before \{[\s\S]{0,1600}?opacity: \.92;/.test(css),
  '深色光雾改用不透明度 .92（近白底没了，不需要再靠低透明度遮）');
check(/\[data-theme="dark"\]\[data-glass="on"\] body::after \{ opacity: \.18; mix-blend-mode: screen; \}/.test(css),
  '深色第二层反光压到 .18（screen 混合在深底上会更亮）');
check(/@supports not \(\(backdrop-filter[\s\S]{0,300}\[data-glass="on"\] body::before \{ display: none; \}/.test(css),
  '不支持 backdrop-filter 时光雾也一并关掉，避免只有色块没有模糊');
check(/--ui-dialog-blur: 26px/.test(css), '弹层模糊 26px');
check(/\.qdb-dialog-wide \{ width: min\(880px, calc\(100vw - 32px\)\); max-height: 86vh; overflow: auto; \}/.test(css), 'wide 弹层是单列放宽（不再套两列网格）');
check(!/\.qdb-dialog-wide \{[^}]*display: grid/.test(css), 'wide 弹层不带 grid（卡片详情/图片放大/新建角色都用它）');
check(/\.qdb-dialog-2col \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/.test(css), '两列表单另起 qdb-dialog-2col');
check(/o\.twoCol \? ' qdb-dialog-2col' : ''/.test(js), 'openDialog 支持 twoCol 选项');
check(/twoCol: true/.test(js) && /name: 'extensions'/.test(js), '转存条件表单用 twoCol（9 项仍两列排）');
check(/box\.className = 'qdb-dialog qdb-dialog-wide'/.test(js), '卡片详情/图片放大/新建角色仍是单列宽弹层');

console.log('## 今日各群调用可点进逐轮明细（D6）');
check(/data-today-key="' \+ esc\(String\(r\.key \|\| ''\)\)/.test(js), '每行带上会话 key');
check((js.match(/closest\('\[data-today-key\]'\)/g) || []).length >= 1 && /if \(key\) usageOpenTurns\(key/.test(js),
  '点行 / 回车都走 usageOpenTurns（复用逐轮花费弹层）');
check(/\.qdb-today-row\[role="button"\] \{ cursor: pointer/.test(css), '可点的行有手型光标');

console.log('## 机器人总开关的两个入口（G）');
check(/socialV2PausedSince: Number\(deps\.socialV2\.pausedSince\) \|\| 0/.test(fs.readFileSync(path.join(ROOT, 'src/bridge/console/operations.js'), 'utf8')),
  '/api/status 带出 pausedSince（停于何时）');
check(/function opsPowerCard\(\)/.test(js) && /panelBox\('机器人总开关'/.test(js) && /data-write="power-toggle"/.test(js),
  '运维页也有一个「停止/启动机器人」的入口');
check(/function pausedForText\(since\)/.test(js) && /return '停于 ' \+ relative\(ms\);/.test(js)
  && (js.match(/pausedForText\(/g) || []).length >= 3,
  '停止态显示「停于 N 分钟前」（1 分钟内说「刚刚停止」，两处共用 pausedForText）');
check(/paused: !!\(rows\[3\] && rows\[3\]\.socialV2Paused === true\)/.test(js)
  && /if \(pageHost\('ops'\)\) renderOps\(pageHost\('ops'\)\);/.test(js),
  '运维页读 /api/status 并在切换后立刻重画');
check(/\.qdb-ops-power \{/.test(css) && /\.qdb-ops-power\[data-tone="off"\] \{/.test(css), '运维页总开关有独立样式与停止态配色');

console.log('## 动图默认静态（点一下才播）');
check(/function isAnimatedMedia\(item\)/.test(js) && /String\(\(item && item\.subType\) \|\| ''\) === '1'/.test(js) && /\[.\]gif\(\?:\[\?#\]\|\$\)\/i\.test\(ref\)/.test(js),
  '动图判定同时看 subType=1 与 .gif 后缀');
check(/function animPlaceholderHtml\(src, asClass\)/.test(js) && /data-anim-src=/.test(js) && /动图 · 点击播放/.test(js),
  '动图先渲染成「动图 · 点击播放」占位，不当场插 <img>');
check(/if \(isAnimatedMedia\(item\)\) \{ out\.push\(animPlaceholderHtml\(src, 'qdb-msg-img'\)\); continue; \}/.test(js)
  && /if \(isAnimatedMedia\(item\)\) return animPlaceholderHtml\(src, isSticker \? 'qdb-tl-sticker' : 'qdb-tl-img'\)/.test(js),
  '会话气泡与日志时间线都走占位分支');
check(/closest\('\[data-anim-src\]'\)/.test(js) && /img\.setAttribute\('data-zoom', src\)/.test(js),
  '点击占位才创建 <img>（GIF 这时才开始播）');
check(/\.qdb-msg-anim \{/.test(css) && /\.qdb-msg-anim:hover \{/.test(css), '占位按钮有独立样式与 hover 反馈');

// 底边框抽动：'正在取更早的消息' 若是消息区上的兄弟节点，显示时把整块往下顶 33px，
// 滚动时面板底边框就跟着上下跳。它必须是消息区里的绝对定位浮层，且不挡鼠标。
const sessPart = fs.readFileSync(path.join(ROOT, 'client', '03-sessions.js'), 'utf8');
check(/qdb-msg-wrap[\s\S]{0,160}sessTopHint/.test(sessPart) === true,
  '「正在取更早的消息」挂在消息区内部（不再是上面的兄弟节点）');
check(/\.qdb-msg-topbar \{ position: absolute;/.test(css) === true,
  '加载提示是绝对定位浮层，显示/隐藏不改变消息区高度');
check(/\.qdb-msg-topbar \{[^}]*pointer-events: none;/.test(css) === true,
  '加载提示不拦鼠标（翻页时还能继续滚）');

console.log('## 会话工具箱 / 模型与思考强度 / 号码复制');
check(/data-write="sess-initial-prompt"/.test(js) && /data-write="sess-voice"/.test(js) && /data-write="sess-draw"/.test(js), '会话工具栏有初始提示词 / 语音 / 出图三个入口');
check(/api\('\/api\/socialV2\/initial-prompt\?key=' \+ encodeURIComponent\(key\)\)/.test(js) && /apiWrite\('\/api\/socialV2\/initial-prompt', \{ key: key, text: text \}\)/.test(js), '初始提示词读走 GET、写走 POST 同一路径');
check(/api\('\/api\/voice\/list\?key=' \+ encodeURIComponent\(key\) \+ '&probe=0'\)/.test(js), '语音列表带 probe=0（否则逐个 ffprobe 要 3~4 秒，弹层像没反应）');
check(/apiWrite\('\/api\/voice\/send', \{ target: key, file: String\(values\.voiceName \|\| ''\) \}\)/.test(js), '发语音走 /api/voice/send（操作者通道）');
check(/apiWrite\('\/api\/socialV2\/draw', \{ key: key, prompt: prompt, tier: String\(values\.drawTier \|\| 'free'\) \}\)/.test(js), '出图走 /api/socialV2/draw，档位由人显式选');
check(/name: 'drawTier'[\s\S]{0,200}?value: 'free'[\s\S]{0,200}?value: 'high'/.test(js), '出图档位两个选项（免费 / 高质量）');
check(/'sess-initial-prompt': function \(\) \{ return sessInitialPrompt\(\); \}/.test(js) && /'sess-voice': function \(\) \{ return sessVoice\(\); \}/.test(js) && /'sess-draw': function \(\) \{ return sessDraw\(\); \}/.test(js), '三个入口都挂进 WRITE_ACTIONS 委托');
check(/\{ id: 'model', name: '模型与思考' \}/.test(js), '设置页多出「模型与思考」分组');
check(/api\('\/api\/dsh\/model'\)/.test(js) && /api\('\/api\/dsh\/models'\)/.test(js), '设置页取当前模型与可选模型清单');
check(/apiWrite\('\/api\/dsh\/effort', \{ reasoningEffort: effort \}\)/.test(js) && /data-dsh-effort="/.test(js), '思考强度点一下就写 dsh.reasoningEffort');
check(/apiWrite\('\/api\/dsh\/model', \{ provider: provider, model: model \}\)/.test(js) && /会同时写 DSH 的全局默认模型/.test(js), '切模型要二次确认并说明会改 DSH 全局默认');
check(/function copyText\(text\)/.test(js) && /function legacyCopy\(value\)/.test(js), '复制有 Clipboard API + execCommand 两套');
check(/function bindCopyTargets\(\)/.test(js) && /bindCopyTargets\(\);/.test(js), 'onReady 挂了复制委托');
check(/data-copy="/.test(js) && /\[data-copy\] \{ cursor: copy; \}/.test(css), '号码挂 data-copy，样式给 copy 光标');

console.log('## 仪表盘用量卡与用量页的图文分工');
check(/also: '\/api\/tokens\/series\?hours=24&buckets=24', alsoKey: 'series'/.test(js), '仪表盘用量卡额外取 24 小时走势（alsoKey=series）');
check(/function usageMiniChartHtml\(series, symbol\)/.test(js) && /class="qdb-mini"/.test(js), '卡片上是迷你走势图（细柱 + 累计折线）');
check(/class="qdb-mini-plot"><div class="qdb-usage-grid"/.test(js) && /class="qdb-usage-line-svg"/.test(js), '迷你图和用量页同一套柱/折线类');
check(/折线＝累计 ' \+ esc\(moneyText\(total, sym\)\)/.test(js), '迷你图底轴标出累计金额');
check(/#card-tokens \.qdb-card-body \{ display: flex; flex-direction: column; min-height: 0; overflow: hidden; \}/.test(css)
  && /\.qdb-mini \{ flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0;/.test(css)
  && /\.qdb-mini-plot \{[^}]*max-height: 224px;/.test(css),
  '迷你图跟着卡片伸缩但有上限（224px）、且不许越界压到底部按钮');
check(/#card-tokens \.qdb-card-more \{ margin-top: auto/.test(css) && /\.qdb-mini-plot \.qdb-usage-bar \{ width: 66%; max-width: 18px; min-width: 3px; \}/.test(css), '入口按钮沉底，迷你柱按格子比例（最宽 18px，和用量页同一口径）');
check(/#card-tokens \{ grid-column: span 4; order: 2; \}/.test(css) && /#card-status \{ grid-column: span 2; order: 1; \}/.test(css), '用量卡放到运行状态旁的半行宽（图表要宽）');
check(/#card-wb2api \{ grid-column: span 2; order: 3; \}/.test(css) && /#card-snowluma \{ grid-column: span 2; order: 4; \}/.test(css) && /#card-selfcheck \{ grid-column: span 2; order: 5; \}/.test(css), '上游两张 + 自检各 2 列，正好补满一行六列');
check(/#card-sessions, #card-blacklist, #card-lists \{ grid-column: span 3; \}/.test(css), '会话 + 名单各半行收尾');
check(/qdb-card-line/.test(js) && /data-goto="usage"/.test(js), '卡片正文精简成一行小字 + 「看明细」入口');
check(/tokens: \{ view: 'usage', viewLabel: '用量与花费'/.test(js), '卡片详情跳到用量页，而不是旧的模型页');
check(/function showView\(view\)/.test(js) && /closest\('\[data-goto\]'\)/.test(js), 'data-goto 走 document 委托切页');
check(/function usageTodayHtml\(data\)/.test(js) && /api\('\/api\/tokens\/today'\)/.test(js), '用量页拉「今日各群调用」接口');
check(/class="qdb-usage-duo"/.test(js) && /\.qdb-usage-duo \{ display: grid; grid-template-columns: minmax\(0, 2fr\) minmax\(0, 1fr\)/.test(css), '最近调用缩到 2/3，右边接今日调用卡');
check(/class="qdb-today-bar"><i style="width:' \+ w \+ '%"/.test(js) && /qdb-today-num/.test(js), '每个群一行横向条 + 调用次数');
check(/usageKeyName\(r\.key\)/.test(js) && /今天 ' \+ numText\(\(today && today\.totalCalls\) \|\| 0\)/.test(js), '群名走会话标签，卡头显示今日总次数');
check(/从今天 00:00 起统计/.test(js) && /qdb-today-hint/.test(css), '卡片底部交代统计口径');
check(/function usageTierHtml\(summary\)/.test(js) && /class="qdb-tierbar"/.test(js) && /峰时 <b>/.test(js), '用量页有峰谷花费拆分条（峰时/闲时金额 + 占比）');
check(/<div id="usageTier">' \+ usageTierHtml\(usageState\.summary\)/.test(js), '峰谷拆分挂在总账面板里');
check(/class="qdb-share" aria-hidden="true"><i style="width:' \+ width \+ '%"/.test(js), '会话花费表有占比横条（最大值铺满）');
check(!/row\('总 token', numText\(totals\.totalTokens\)\)/.test(js), '卡片里不再重复堆四行明细（明细归用量页）');
check(/\.qdb-mini \{/.test(css) && /\.qdb-share \{/.test(css) && /\.qdb-tierbar \{/.test(css), '三处图形的时间/主题令牌样式都在');

console.log('## 仪表盘名单卡（AI 黑名单已并进名单）');
check(!/id: 'blacklist'/.test(js) && /id: 'lists', path: '\/api\/lists', title: '名单'/.test(js), '卡片换成「名单」，数据源是 /api/lists');
check(/function renderListsCard\(data\)/.test(js) && /条 · 7 个名单/.test(js), '卡片主数字是七个名单合计');
check(/function placeholderOf\(data, id\)[\s\S]{0,320}?Array\.isArray\(v\) \? v : \(v && Array\.isArray\(v\.keys\) \? v\.keys : \[\]\)/.test(js),
  '占位号两种形态都认：数组 / { count, keys }');
check(/placeholderOf\(data, item\.id\)/.test(js) && /cdChip\('muted', '占位 ' \+ numText\(phTotal\)\)/.test(js),
  '名单卡上带「占位 N」chip（有占位号时才出）');
check(/占位号（自动写入，可手改）/.test(js) && /ph\.map\(function \(id\) \{ return entryChip\(kind, id, 'auto'\)/.test(js),
  '详情弹层里占位号单独一段，并用「auto」备注标出来');
check(/function listsOf\(data\)[\s\S]{0,700}?mk\('allow-groups', flat\.allowGroups\)/.test(js),
  '名单接口两种形态都认：老 lists:[{id,entries}] 与直接 allowGroups / denyPrivate 这类字段');
check(/loadCard\(spec\)\.then\(function \(\) \{[\s\S]{0,260}?body\.innerHTML = cardDetailHtml\(id, cardData\[id\]\)/.test(js),
  '详情弹层打开时自动再拉一次这张卡（不强制用户先点刷新）');
check(/row\('放行', '群 ' \+ numText\(allowG\) \+ ' \/ 私聊 ' \+ numText\(allowP\)/.test(js), '放行按群/私聊分列');
check(/row\('AI 黑名单', \(ai\.enabled === true \? '开' : '关'\)/.test(js), 'AI 黑名单缩成卡里一行状态');
check(/lists: \{ view: 'lists', viewLabel: '名单', render: detailLists \}/.test(js), '详情卡跳「名单」页（原来跳的是已不存在的 blacklist 视图）');
check(/function detailLists\(d\)/.test(js) && /listSection\('群名单'/.test(js) && /listSection\('私聊名单'/.test(js), '详情里有群名单与私聊名单分组');
check(!/function detailBlacklist/.test(js) && !/function renderBlacklist/.test(js), '旧的 AI 黑名单卡与详情已删除');
check(!/data-goto-view="blacklist"/.test(js), '设置页里那条「去 AI 黑名单改」也改成名单');

console.log('## 首次设置向导（GET/POST /api/setup）');
check(/pathname === '\/api\/setup'/.test(consoleSources), '后端真有 /api/setup 路由（不是前端凭空造的）');
check(/api\('\/api\/setup'\)\.then\(function \(view\)/.test(js) && /view\.ready === false && !setupIgnored\(\)/.test(js), '初始化探一次：ready===false 且没被忽略过，才自动弹向导');
check(/var SETUP_KEY = 'qdb-setup-dismissed'/.test(js) && /localStorage\.setItem\(SETUP_KEY, '1'\)/.test(js) && /localStorage\.getItem\(SETUP_KEY\) === '1'/.test(js), '「稍后再说」把忽略标记写进 localStorage，之后不再自动弹');
check(/gaps\.map\(function \(gap\) \{ return '<li><span class="qdb-tag">' \+ esc\(gap\.label \|\| gap\.key\)/.test(js) && /esc\(gap\.why \|\| ''\)/.test(js), '缺口直接照后端的 gaps 渲染（label + why，前端不另判一套）');
check(!/SETUP_GAPS|setupGapKeys/.test(js), '没有在前端复制一份缺口判定表');
check(/name: 'ownerQQ', label: '你的 QQ 号（owner）'/.test(js) && /name: 'url', label: 'SnowLuma 地址'/.test(js) && /name: 'token', label: 'accessToken（留空=不改）'/.test(js) && /name: 'privateOpen', label: '私聊策略'/.test(js), '四个字段：ownerQQ / SnowLuma 地址 / accessToken / 私聊策略');
check(/data-write="setup-add" data-kind="' \+ kind \+ '"/.test(js) && /data-write="setup-del" data-kind="' \+ kind \+ '"/.test(js) && /ids\.slice\(-6\)/.test(js), '两个名单小件：加号 + 列表 + 逐条移除（超过 6 条只显示最近 6 条）');
check(/value: '', placeholder: '不回显', type: 'password'/.test(js) && /if \(token\) \{ patch\.snowluma = patch\.snowluma \|\| \{\}; patch\.snowluma\.accessToken = token; \}/.test(js), 'accessToken 不回显、留空=完全不提交');
check(/apiWrite\('\/api\/setup', patch\)/.test(js) && /return api\('\/api\/setup'\)\.then\(function \(next\)/.test(js) && /这次修好 /.test(js), '保存后立刻重新探活，直接展示缺口少了几项');
check(/if \(data\.restartRequired\) return setupRestart\(left\);/.test(js) && /apiWrite\('\/api\/ops\/action', \{ service: 'bridge', action: 'restart' \}\)/.test(js), 'restartRequired 时提示「要重启桥接」并给按钮（不自动重启）');
check(/data-write="setup-open">重新运行首次设置向导/.test(js), '设置页「安全与关于」里有重跑入口');
check(/wide: true, confirmLabel: '保存并重新检测', cancelLabel: '稍后再说'/.test(js) && /esc\(o\.cancelLabel \|\| '取消'\)/.test(js), '向导用宽弹层，取消按钮文案是「稍后再说」');
check(/view\.writable === false/.test(js) && /没有写 config\.json 的权限/.test(js), 'writable=false 时告诉用户只能手改 config.json');
check(!/id: 'setup'/.test(js) && !/data-view="setup"/.test(js), '没有新增导航项（向导只走弹层 + 设置页入口）');

console.log('## 群友印象（自动归纳）');
check(/pathname === '\/api\/impressions'/.test(consoleSources), '后端真有 GET /api/impressions（读 state/impressions.json，不是前端凭空造）');
check(/api\('\/api\/impressions'\)\.catch\(function \(error\) \{ return \{ __failed: error \}; \}\)/.test(js), '记忆页取数里带上印象接口，失败也不拖垮总览/会话两块');
check(/panelBox\('群友印象（自动归纳）', head/.test(js) && /html \+= '<div style="margin-top:16px">' \+ memAutoHtml\(pair\[2\]\)/.test(js) && /memImpressionsHtml\(overview && overview\.globalImpressions\)/.test(js), '面板插在记忆页「跨会话群友印象」之后，不另起一套页面');
check(/\(Number\(b && b\.evidenceCount\) \|\| 0\) - \(Number\(a && a\.evidenceCount\) \|\| 0\)/.test(js) && /按证据数从多到少展示/.test(js), '列表按 evidenceCount 从多到少排');
check(/esc\(name \|\| \('群友 ' \+ uid\)\)/.test(js) && /String\(\(one && \(one\.impression \|\| one\.text\)\)/.test(js) && /esc\(text\)/.test(js) && /class="qdb-chip">' \+ esc\(tag\)/.test(js), '每条渲染名字/QQ/正文(esc)/标签 chips（兼容 impression 与 text 两种字段名）');
check(/auto\.exists === false/.test(js) && /emptyLine\('还没跑过归纳'\)/.test(js), '文件还没生成时是「还没跑过归纳」空态，不当错误');
check(/var unavailable = !auto \|\| auto\.__failed;/.test(js) && /读接口未接入（GET \/api\/impressions）/.test(js), '读接口没合入时降级成「读接口未接入」提示，页面其余部分照常');
check(/auto\.window && auto\.window\.from/.test(js) && /覆盖窗口：/.test(js), '有窗口时显示归纳覆盖的时间段');
check(/node scripts\/build-impressions\.mjs --apply/.test(js) && /data-copy="' \+ esc\(IMPRESS_CMD\)/.test(js), '给出 CLI 生成命令，且可一键复制');
check(/data-write="impressions-rebuild"/.test(js) && /'impressions-rebuild': function \(btn\)/.test(js), '「立即归纳」按钮可用，走 POST /api/impressions/rebuild');
check(!/disabled title="接口未接入：先运行 /.test(js), '按钮不再写死 disabled（只有正在跑的时候才禁用）');
check(!/data-view="impressions"/.test(js) && !/id: 'impressions'/.test(js), '没有新增导航项（区块只挂在记忆页里）');

console.log('## 设置页：重启桥接 + 后台任务参数');
check(/data-write="bridge-restart">重启桥接/.test(js), '「安全与关于」里常驻「重启桥接」按钮（不占导航项）');
check(/'bridge-restart': function \(btn\) \{/.test(js) && /apiWrite\('\/api\/ops\/action', \{ service: 'bridge', action: 'restart' \}\)/.test(js), '重启走既有接口 POST /api/ops/action {service:bridge,action:restart}');
check(/正在跑的回合会被清掉/.test(js) && /confirmLabel: '确认重启'/.test(js) && /danger: true/.test(js), '重启是危险操作：二次确认并说明 QQ 短暂离线、在途回合被清');
check(/setTimeout\(function \(\) \{ loadAll\(\); \}, 4000\)/.test(js), '重启成功后等几秒再 loadAll（重启那几秒接口连不上）');
check(/\{ id: 'tasks', name: '后台任务' \}/.test(js) && /if \(settingsState\.group === 'tasks'\) return settingsTasksHtml\(\)/.test(js), '设置页多一个「后台任务」分组，并接进 settingsBodyHtml 分派');
check(/function settingsTasksHtml\(\)/.test(js) && /function taskRow\(path, title, sub, control\)/.test(js) && /function taskNum\(id, path, min, max\)/.test(js), '后台任务面板逐行渲染（taskRow / taskNum 小件）');
check(/taskSwitch\('taskSlangEnabled'/.test(js) && /taskSwitch\('taskSlangOffPeak'/.test(js) && /taskNum\('taskSlangDailyRuns'/.test(js) && /taskNum\('taskSlangMaxSteps'/.test(js) && /taskNum\('taskSlangQueueMax'/.test(js) && /taskNum\('taskTurnMaxSteps'/.test(js) && /id="taskAllowedModels"/.test(js), '七个控件齐全：总开关 / 空闲时段 / 每天次数 / 每次步数 / 队列上限 / 单轮步数 / 允许的模型');
check(/data-write="tasks-save">保存后台任务参数/.test(js), '面板底部有「保存后台任务参数」按钮（挂进 WRITE_ACTIONS 委托）');
check(/'socialV2\.slangLearn\.enabled': true, 'socialV2\.slangLearn\.onlyOffPeak': true/.test(js) && /'socialV2\.slangLearn\.dailyRuns': 8, 'socialV2\.slangLearn\.maxStepsPerRun': 12/.test(js) && /'socialV2\.slangLearn\.queueMax': 6, 'socialV2\.turnMaxSteps': 8/.test(js) && /'\*\/\*deepseek\*flash\*'/.test(js), '默认值与后端一致（8 次 / 12 步 / 20 内队列 6 / 单轮 8 / 默认只放 deepseek flash）');
check(/taskNum\('taskSlangDailyRuns', P \+ 'dailyRuns', 1, 48\)/.test(js) && /taskNum\('taskSlangMaxSteps', P \+ 'maxStepsPerRun', 4, 40\)/.test(js) && /taskNum\('taskSlangQueueMax', P \+ 'queueMax', 1, 20\)/.test(js) && /taskNum\('taskTurnMaxSteps', 'socialV2\.turnMaxSteps', 0, 60\)/.test(js), '数字控件上下限照后端（1~48 / 4~40 / 1~20 / 0~60），0 步=不限有说明文案');
check(/taskLeafOpen\(path\) \? control : '<span class="qdb-hint" data-tone="warn">后端尚未开放<\/span>'/.test(js) && /function taskLeafOpen\(path\) \{ return settingsCtx\.editable\.indexOf\(path\) >= 0; \}/.test(js), 'GET /api/config 的 whitelist 里没有的叶子只显示「后端尚未开放」，不摆存不进去的输入框');
check(/'tasks-save': function \(btn\)/.test(js) && /put\('socialV2\.modelRouting\.allowedProviderModels', list\)/.test(js) && /patch\[path\] = value;/.test(js) && /if \(nowOf\(path\) !== JSON\.stringify\(value\)\) patch\[path\] = value;/.test(js), '保存只提交改过的叶子路径（不整段覆盖 socialV2）');
check(/apiWrite\('\/api\/config', \{ patch: patch \}\)/.test(js) && /data\.restartRequired \? '；需重启桥接才彻底生效'/.test(js), '保存走现有 POST /api/config {patch}，restartRequired 时提示要重启');
check(/if \(!isFinite\(n\) \|\| Math\.floor\(n\) !== n \|\| n < min \|\| n > max\)/.test(js), '数字在本地先按 min/max 拦一遍，坏值不发请求');
check(/path === '\/client\.js' \|\| path === '\/client\.css'/.test(fixtureSource) && /text\/javascript; charset=utf-8/.test(fixtureSource) && /text\/css; charset=utf-8/.test(fixtureSource), '离线预览器补上 /client.js 与 /client.css（以前只 serve HTML，预览白屏）');
check(/resolve\(projectRoot, 'public', asset\)/.test(fixtureSource) && /json\(\{ ok: false, error: asset \+ ' 不存在' \}, 404\)/.test(fixtureSource), '预览器直接从 public/ 读这两个文件，缺文件回 404 而不是空白');

console.log('## 用量页：走势图（柱 + 累计折线）与逐轮明细（横向条）');
check(/class="qdb-usage-chart2" role="img" aria-label="花费走势：柱是每格花费，折线可切换口径"/.test(js), '走势图整块 role="img" 并说明柱/折线各代表什么');
check(/function usageSlotList\(series\)/.test(js) && /blank: true/.test(js) && /var count = Math\.max\(buckets\.length, want\);/.test(js), '桶数不够铺满区间时补「记录之外」的空白格（柱子保持细，不靠拉宽占版面）');
check(/function usageSlotUnit\(series\)/.test(js) && /if \(ms <= 3600000\) return '每小时';/.test(js) && /if \(ms >= 86400000\) return '每天';/.test(js), '格子的时间单位按 bucketMs 推（每小时 / 每 N 小时 / 每天）');
check(/var isBlank = b\.blank === true \|\| \(!cost && !\(Number\(b\.turns\) \|\| 0\)\);/.test(js) && /这段时间没有花费记录/.test(js) && /var bar = isBlank \? '' :/.test(js), '零花费的格子不画柱（留空），悬停仍提示「这段时间没有花费记录」');
check(/class="qdb-usage-slot" title="/.test(js) && /\.qdb-usage-slot \{[\s\S]{0,160}?flex: 1 1 0;/.test(css) && /\.qdb-usage-bar \{[\s\S]{0,160}?width: 82%;[\s\S]{0,80}?max-width: 40px;/.test(css), '每格一个等宽槽位，柱子按格子比例取宽（82%、最宽 40px）：格子宽柱子就粗，间隔仍窄');
check(/\.qdb-share \{[^}]*height: 10px/.test(css) && /\.qdb-today-bar \{[^}]*height: 12px/.test(css), '占比条与「今日各群调用」的横条都不再是 6px 发丝（10px / 12px）');
check(/class="qdb-usage-line-svg" viewBox="0 0 100 100" preserveAspectRatio="none"/.test(js), '折线用内联 SVG，viewBox 0 0 100 100 + preserveAspectRatio="none" 铺满容器');
check(/class="qdb-usage-line" vector-effect="non-scaling-stroke"/.test(js), '折线带 non-scaling-stroke，拉伸后仍是 2px 线宽');
check(/spent \+= cost;/.test(js) && /cumPts\.push\(x \+ ',' \+ yCum\.toFixed\(2\)\)/.test(js) && /eachPts\.push\(x \+ ',' \+ yEach\.toFixed\(2\)\)/.test(js) && /var pts = mode === 'each' \? eachPts : cumPts;/.test(js), '折线点两套：累计（按区间总量归一）与每格（按峰值归一）');
check(/\[\['cum', '累计花费'\], \['each', unit \+ '花费'\], \['none', '不画线'\]\]/.test(js) && /data-line-mode="/.test(js) && /id="usageLinePick"/.test(js), '折线口径可选：累计 / 每格 / 不画线');
check(/function usagePieHtml\(summary, opts\)/.test(js) && /pathLength="100"/.test(js) && /stroke-dasharray="' \+ pct\.toFixed\(2\)/.test(js),
  '会话占比饼图：SVG 圆环按 pathLength=100 分段');
check(/var USAGE_PIE_COLORS = \['#0e9f8a'/.test(js) && /items\.slice\(0, USAGE_PIE_COLORS\.length - 1\)/.test(js) && /items\.slice\(USAGE_PIE_COLORS\.length - 1\)/.test(js),
  '饼图最多 8 段、其余并成「其他 N 个会话」');
check(/class="qdb-pie-center"><b>' \+ esc\(usageCost\(total\)\)/.test(js) && /qdb-pie-pct/.test(js) && /qdb-pie-cost/.test(js),
  '饼图中心写总额、图例带百分比和金额');
check(/function pieFootHtml\(items, total\)/.test(js) && /最花钱：/.test(js) && /前 ' \+ numText\(top\.length\) \+ ' 个会话占/.test(js),
  '饼图下方补两句结论（谁最花钱、前三个占比）');
// ── 饼图口径：默认「今日各会话花费占比」，可切回「全部」对账 ──
check(/pie: 'today'/.test(js) && /var usageState = \{[^}]*today: null/.test(js),
  '饼图默认证「今日」，今日数据单独存（不混进 summary）');
check(/function usagePieRows\(\)/.test(js) && /usageState\.today \|\| null/.test(js) && /今天还没有花费/.test(js),
  '今日口径读 /api/tokens/today 的 keys；今天没花钱就说「今天还没有花费」');
check(/function usagePieModeHtml\(\)/.test(js) && /data-pie-mode="' \+ m\.id \+ '"/.test(js) && /\{ id: 'today', name: '今日' \}, \{ id: 'all', name: '全部' \}/.test(js),
  '面板头有「今日 / 全部」切换');
check(/usageState\.today = today \|\| null;[\s\S]{0,80}?renderPie\(\);/.test(js),
  '今日数据回来后自动重画饼图（首屏先显示「正在统计今天的花费…」）');
check(/usagePieHtml\(null, \{ rows: p\.rows, emptyText: p\.emptyText \}\)/.test(js) && /id="usagePie"/.test(js),
  '两种口径复用同一个饼图渲染（只换数据源）');
check(/class="qdb-sess-split"/.test(js) && /\.qdb-sess-split \{[\s\S]{0,140}?grid-template-columns: minmax\(0, 1\.9fr\) minmax\(0, 1fr\)/.test(css),
  '各会话花费改成左表右饼图的两栏，表格不再撑满整行');
check(/\.qdb-sess-split \.qdb-usage-table \{ table-layout: fixed; \}/.test(css) && /\.qdb-sess-split \.qdb-usage-table th:nth-child\(1\), \.qdb-sess-split \.qdb-usage-table td:nth-child\(1\) \{ width: 22%; \}/.test(css),
  '会话名那一列压到 22%（盖过通用表格的 34%），长名字裁切，不再把表格撑长');
check(/if \(mode === usageState\.lineMode\) return;/.test(js) && /usageState\.lineMode = mode;/.test(js) && /box\.innerHTML = usageBarsHtml\(series\);/.test(js), '换口径只重画走势面板，不重新请求接口');
check(/var side = mode === 'cum' && total > 0/.test(js) && /class="qdb-usage-yside"/.test(js) && /\{ hours: 720, buckets: 30, label: '30 天' \}/.test(js), '累计口径另标一条右轴（0~总额），30 天按天切桶让「每天花费」是真日线');
check(/class="qdb-usage-line-area"/.test(js) && /\.qdb-usage-line-area \{ fill: color-mix/.test(css), '折线下面有半透明填充面');
check(/class="qdb-usage-ylabels"><span>' \+ esc\(usageCost\(max\)\) \+ '<\/span><span>' \+ esc\(usageCost\(max \/ 2\)\) \+ '<\/span><span>0<\/span>/.test(js), '左侧 Y 轴三档刻度用金额格式（峰值 / 中值 / 0）');
check(/<div class="qdb-usage-grid" aria-hidden="true"><i><\/i><i><\/i><i><\/i><\/div>/.test(js) && /\.qdb-usage-grid i:nth-child\(2\) \{ top: 50%; \}/.test(css), '图里有三条极淡水平网格线（0 / 50% / 100%）');
check(/' · ' \+ usageCost\(cost\) \+ ' · 累计 ' \+ usageCost\(spent\)/.test(js) && /title="' \+ esc\(tip\)/.test(js), '每根柱的悬停 title 带该格花费与累计花费');
check(/<polyline class="qdb-usage-line"[^>]*>[\s\S]{0,80}?<title>' \+ esc\(mode === 'cum' \? '累计花费 ' \+ usageCost\(total\) : usageSlotUnit\(series\) \+ '花费，峰值 ' \+ usageCost\(max\)\)/.test(js), '折线本身的 title 跟着口径走（累计合计 / 每格峰值）');
check(/class="qdb-usage-legend"/.test(js) && /峰时花费<\/span><span><i class="is-off"><\/i>闲时花费/.test(js) && /<i class="is-line"><\/i>累计花费/.test(js), '图例说明黄=峰时、蓝=闲时、线=累计');
check(!/function usageTurnsHtml\(data\) \{[\s\S]{0,200}<table class="qdb-table/.test(js) && /class="qdb-turn-row" title="/.test(js), '逐轮明细改成一行一轮的卡片行（不再是宽表格）');
check(/var w = max > 0 \? Math\.max\(2, Math\.round\(Math\.sqrt\(cost \/ max\) \* 100\)\) : 0;/.test(js) && /class="qdb-turn-bar" role="img" aria-label=/.test(js) && /style="width:' \+ w \+ '%"/.test(js), '横向花费条按「该轮花费 / 最贵一轮」开平方定宽（等差 50 倍时便宜的轮次也看得见）');
check(/\(peak \? 'is-peak' : 'is-off'\)/.test(js) && /\.qdb-turn-bar i\.is-peak \{ background: var\(--ui-warn\); \}/.test(css) && /\.qdb-turn-bar i \{ display: block; height: 100%; border-radius: 999px; background: var\(--ui-accent\);/.test(css), '横条颜色按峰谷取 --ui-warn / --ui-accent');
check(/function usageSayText\(row\)/.test(js) && /Math\.round\(out \/ 1\.5\)/.test(js) && /'说了 ≈ ' \+ usageTokenText/.test(js), '「说了多少话」＝输出 token ÷ 1.5 折算成字数');
check(/row\.messages !== undefined \? row\.messages : row\.sends/.test(js) && /return numText\(m\) \+ ' 句';/.test(js), '后端若给 messages/sends 就优先用真实条数');
check(/按输出 token 折算字数（约 1\.5 token\/字）；接口不返回消息条数/.test(js), '弹层里写明折算口径，不让人误当成真实消息数');
check(/总轮次<b>' \+ numText\(rows\.length\) \+ '<\/b><\/span>'/.test(js) && /平均每轮<b>/.test(js) && /最贵一轮<b>T' \+ esc\(String\(worst\.turn\)\)/.test(js), '顶部统计条：总轮次 / 总花费 / 平均每轮 / 最贵一轮');
check(/if \(!rows\.length\) return emptyLine\('这段时间还没有记录'\);/.test(js), '没有轮次时是空态文案「这段时间还没有记录」');
check(/html: usageTurnsHtml\(data\),/.test(js), '逐轮弹层不再套两层滚动容器');
check(/\.qdb-turn-row \{ padding: 8px 0; border-bottom: 1px solid var\(--ui-border\); min-width: 0; \}/.test(css) && /\.qdb-turn-foot \{ display: flex; flex-wrap: wrap;/.test(css), '逐轮行与脚注都允许折行（360 窄屏不横向溢出）');

console.log('## 自定义背景（设置 → 外观）');
const part07 = fs.readFileSync(path.join(ROOT, 'client/07-bg.js'), 'utf8');
check(/BG_KEY = 'qdb-bg-image'/.test(part07) && /BG_DIM_KEY = 'qdb-bg-dim'/.test(part07) && /BG_BLUR_KEY = 'qdb-bg-blur'/.test(part07),
  '背景图/压暗/模糊三个偏好都存在 localStorage，不经过任何接口');
check(!/fetch\(|api\(|apiWrite\(/.test(part07), '背景图全程不联网：07 片段里没有任何 fetch/api 调用（隐私承诺要能被读出来）');
check(/BG_MAX_EDGE = 2560/.test(part07) && /toDataURL\('image\/jpeg', 0\.85\)/.test(part07),
  '导入时先缩到长边 2560 再压成 JPEG 0.85（否则几 MB 的原图塞不进 localStorage）');
check(/function importBgFile\(file\)/.test(part07) && /QuotaExceededError/.test(part07),
  '写不进本地空间时明确报错，不静默失败');
check(/function bgNum\(key, fallback, min, max\)/.test(part07) && /if \(raw === null \|\| raw === ''\) return fallback;/.test(part07),
  '默认值先判空再转数字（Number(null) === 0 会把「没设置过」当成 0）');
check(/function applyCustomBg\(\)/.test(part07) && /root\.dataset\.bg = 'custom';/.test(part07) && /root\.dataset\.bg = 'none';/.test(part07),
  'applyCustomBg 把有图/没图落到 documentElement.dataset.bg');
check(/setProperty\('--qdb-bg-dim'/.test(part07) && /setProperty\('--qdb-bg-blur'/.test(part07),
  '压暗与模糊走 CSS 变量，换档不用重画页面');
check(/id = 'qdbBgLayer'/.test(part07) && /z-index: -1/.test(css) && /#qdbBgLayer\s*\{[^}]*background-size: cover/.test(css),
  '背景层固定铺满并压在彩光下面（z-index -1）');
check(/#qdbBgLayer::after/.test(css) && /var\(--qdb-bg-dim/.test(css), '背景层自带压暗纱（浓度就是设置里的百分比）');
check(/\[data-bg="custom"\]\[data-glass="on"\] body::before \{ opacity: \.30; \}/.test(css),
  '有自定义背景时把彩光压淡，别把用户的图糊成一片青');
check(/row\.parentNode\.replaceChild\(next, row\)/.test(part07) && !/host\.innerHTML = settingsBodyHtml\(\)/.test(part07),
  '导入后只换「自定义背景」那一行，不重画整块设置（否则毛玻璃开关的监听会跟着旧节点一起丢掉）');
check(/applyCustomBg\(\);\s*$/.test(part07.trim()),
  '启动补图放在 07 片段末尾：从 05 的启动段调用时 BG_KEY 还是 undefined，背景会「存了但刷新不出来」');
check(/bgRowHtml\(\)/.test(js) && /bindBgControls\(\);/.test(js), '设置页外观分组里挂了自定义背景行与它的绑定');
check(/data-bg-action="pick"/.test(part07) && /data-bg-action="clear"/.test(part07) && /data-bg-blur=/.test(part07),
  '设置行有导入/移除按钮与模糊档位');
// ── 最近使用的图像（最多 3 张）+ 选图预览：像 Windows 个性化那样「后悔了能点回来」──
check(/BG_RECENT_KEY = 'qdb-bg-recent'/.test(part07) && /BG_RECENT_MAX = 3/.test(part07) && /function bgRecentList\(\)/.test(part07),
  '最近使用留 3 张，存在 localStorage（和背景图同一套本机偏好）');
check(/function bgRecentRemember\(image\)/.test(part07) && /list\.unshift\(v\);/.test(part07) && /slice\(0, BG_RECENT_MAX\)/.test(part07),
  '换图时把上一张记进「最近使用」，重复的先摘掉、只留 3 张');
check(/data-bg-recent="' \+ i \+ '"'/.test(part07) || /data-bg-recent=/.test(part07),
  '最近使用那排是可点的缩略图');
check(/function bgPreviewDialog\(image\)/.test(part07) && /预览这张背景/.test(part07) && /confirmLabel: '用这张'/.test(part07),
  '选图先预览再应用（预览里写清「现在还什么都没改」）');
check(/bgPreviewDialog\(data\)\.then\(function \(ok\)/.test(part07),
  '导入流程也是「预览 → 点用这张」才真的换背景');
check(!/bgRecentHtml\(\)[\s\S]{0,200}localStorage\.removeItem/.test(part07),
  '移除当前背景不顺手清空「最近使用」（否则后悔就找不回来了）');

// ── 数据环 HUD：整页背景而不是「顶部一条」──
const part09 = fs.readFileSync(path.join(ROOT, 'client/09-ring.js'), 'utf8');
check(/qdb-hero-bg/.test(part09) && /document\.body\.appendChild\(hero\)/.test(part09),
  'Halo 皮肤把环带画布搬到 body 下当全屏背景（留在仪表盘 section 里切页签就没了）');
check(/html\[data-skin="halo"\] \.qdb-hero\.qdb-hero-bg \{[\s\S]{0,160}position: fixed; inset: 0/.test(css),
  '全屏背景层 position:fixed + inset:0 铺满视口');
check(/ringFull/.test(part09) && /var ringFull = false;/.test(part09),
  '画布按「全屏背景」与「顶部条」两种形态取不同构图参数');
check(/html\[data-skin="halo"\]\[data-glass="on"\] \.qdb-card/.test(css),
  'Halo 卡片用更高权重覆盖毛玻璃那批规则（否则卡片是近黑的，背景透不上来）');

// ── 滑杆旁边的数字可手输（压暗 / 音量）──
check(/id="setBgDimVal" type="number" min="0" max="80"/.test(part07),
  '背景压暗的百分比是可改的数字框（拖滑杆粗调、敲数字精调）');
check(/num\.addEventListener\('change'/.test(part07) && /Math\.min\(80, Math\.max\(0/.test(part07),
  '手输的压暗值会夹到 0~80 并回写滑杆');
const part08 = fs.readFileSync(path.join(ROOT, 'client/08-bgm.js'), 'utf8');
check(/id="setBgmVolVal" type="number" min="0" max="100"/.test(part08),
  '背景音乐音量同样是可改的数字框');
check(/num\.addEventListener\('input'/.test(part08) && /bgmSetVolume\(v\)/.test(part08),
  '手输音量会走 bgmSetVolume（0 视同静音、和滑杆同一套逻辑）');
check(/\.qdb-num \{/.test(css) && /\.qdb-num-wrap \{/.test(css),
  '数字框有自己的紧凑样式（带 % 单位，浅色/深色都看得清）');

// 回合被中止时工具调用被取消：控制台别用红色「失败」吓人（消息其实发出去了）。
check(/it.cancelled === true/.test(js) && /这轮被中止，调用被取消，不算失败/.test(js), '被取消的工具调用在时间线里显示成中性提示，不是红色失败');
// ── 素材库 Pro（新一级页：左筛选树 + sticky 工具条 + 宽卡网格）──────────────
console.log('## 素材库 Pro');
const proSection = (html.match(/<section data-page="library-pro"[\s\S]*?<\/section>/) ?? [''])[0];
check(html.includes('data-view="library-pro"') && />素材库</.test(html), '侧栏新增一级项「素材库」（data-view="library-pro"）');
check(proSection.includes('id="page-library-pro"') && proSection.includes('data-page-refresh="library-pro"'), '素材库页有挂载容器与刷新按钮');
check(html.indexOf('data-view="library-pro"') < html.indexOf('data-view="library"'), '「素材库」排在「文件库」上面');
check(/PAGE_LOADERS\['library-pro'\] = pageLibraryPro/.test(js) && /PAGE_TITLES\['library-pro'\] = '素材库'/.test(js), '素材库页登记进 PAGE_LOADERS / PAGE_TITLES');
check(/\.qdb-libpro \{ display: grid; grid-template-columns: 240px minmax\(0, 1fr\)/.test(css), '三栏布局：左栏 240px + 主区');
check(/\.qdb-libpro\[data-density="1"\] \.qdb-libpro-grid \{ grid-template-columns: repeat\(3/.test(css)
  && /\.qdb-libpro-grid \{ display: grid; gap: 12px; grid-template-columns: repeat\(4/.test(css)
  && /\.qdb-libpro\[data-density="3"\] \.qdb-libpro-grid \{ grid-template-columns: repeat\(6/.test(css), '密度三档：3 / 4 / 6 列');
check(/@media \(max-width: 900px\)[\s\S]{0,400}\.qdb-libpro-side\.is-open/.test(css) && /id="libProSideToggle"/.test(js), '窄屏 <900 左栏收进抽屉（#libProSideToggle）');
check(js.includes("api('/api/library/facets'") && /libProLocalFacets/.test(js) && /facetsLocal = true/.test(js), 'facets 走 /api/library/facets，404/异常时本地算（libProLocalFacets）');
check(/function libProLocalCategory\(a\)/.test(js) && /LIBPRO_CATEGORY_RULES/.test(js) && /'饰品'/.test(js) && /'音声'/.test(js), '分类规则前端一份（与后端 §2.3 同词表）');
check(/libProModelBucket/.test(js) && /'unlabeled'/.test(js) && /'2-3'/.test(js) && /'8\+'/.test(js), '适配模型按桶筛（未标注 / 1 / 2~3 / 4~7 / 8+）');
check(/libProSegButton\('image', '仅图片'\)/.test(js) && /libProSegButton\('fav', '收藏'\)/.test(js) && /a\.favorite !== true/.test(js), '「全部｜仅图片｜收藏」分段可用');
check(/noCover/.test(js) && /withPassword/.test(js) && /duplicated/.test(js), '质量检查下拉项齐全（未分类 / 无封面 / 未认号 / 有解压码 / 有 RJ / 重复号）');
check(/toLowerCase\(\) !== 'k'/.test(js) && /input\.focus\(\)/.test(js), 'Ctrl+K 聚焦搜索框');
check(/setTimeout\(function \(\) \{ libProLoad\(\); \}, 300\)/.test(js), '搜索 300ms 防抖后才打接口');
check(/LIBPRO_DENSITY_KEY = 'qdb-libpro-density'/.test(js) && /localStorage\.setItem\(LIBPRO_DENSITY_KEY/.test(js), '密度存 localStorage（刷新后保持）');
check(/data-libpro-fav="/.test(js) && /apiWrite\('\/api\/library\/favorite', \{ key: key, on: on \}\)/.test(js), '收藏按钮 POST /api/library/favorite {key,on}');
check(/HTTP 404/.test(js) && /后端还没上线收藏接口（重启桥接后再试）/.test(js) && /后端还没上线素材库视图（接口 404）/.test(js), 'facets / 收藏没上线时都给人话，不静默');
check(/data-write="library-detail"/.test(js) && /data-write="library-find"/.test(js) && /data-write="library-find-by-image"/.test(js) && /libraryRenameButton\(a\)/.test(js) && /libraryTrashButton\(a\)/.test(js) && /data-write="asset-cover"/.test(js), '卡片复用既有写操作（详情 / 找号 / 以图搜源 / 改名 / 补封面 / 回收站）');
check(/libProState\.shown \+= LIBPRO_PAGE/.test(js) && /共 ' \+ numText\(total\) \+ ' 件 · 已显示 '/.test(js) && /id="libProMore"/.test(js), '底部「共 N 件 · 已显示 M」+ 加载更多');
check(/libBatchCheck\(a\)/.test(js) && /libBatchOnPage = function/.test(js) && /libBatchBarHtml\(\)/.test(js), '多选复用 libBatchState（勾选框 / 批量条 / 全选本页钩子）');
check(/qdb-libpro-skel/.test(js) && /\.qdb-libpro-skel .qdb-libpro-cover/.test(css), '首屏加载有骨架屏（不是空白也不跳高）');
check(/ev\.key === 'Enter'/.test(js) && /title\.click\(\)/.test(js), '卡片可键盘操作：Enter / 空格开详情');
check(/article class="qdb-asset qdb-card qdb-libpro-card"/.test(js) && /aspect-ratio: 4 \/ 3/.test(css), '卡片沿用 .qdb-asset 结构（以图搜源能拿到封面）+ 封面 4:3');
check(proSection.includes('按分类、店铺、来源、标签挑素材') && !/GET \/api\/library/.test(proSection), '副标题是用户口径（不再出现接口名）');
check(js.includes('LIBPRO_PLAIN_NAME_RE') && js.includes('function libProOrigName(a)') && js.includes("'原名 '"), '纯号 / 下划线标题下补「原名 <主包名去扩展名>」（截断 40）');
check(js.includes('function libProPurchasedCountOf(list)') && js.includes("api('/api/library/purchases?limit=200')") && js.includes('f.purchased == null ? null : Number(f.purchased)'), '「BOOTH 已购」= 台账对上的件数，拿不到就只写「已购」不显示数字');

console.log('## 手动标签 / 手动分类（07m 抽屉 + 卡片）');
check('抽屉里新增「手动信息」区块，位置在「文件清单」上方',
  js.includes('function libDetManualHtml(a)') && /libDetManualHtml\(a\)[\s\S]{0,120}文件清单/.test(js)
  && /手动信息/.test(js));
check('分类输入带现有分类下拉建议（datalist），≤20 字，留空=跟随规则',
  /id="libDetCatInput" list="libDetCatList" maxlength="' \+ LIBDET_CAT_LEN/.test(js)
  && /<datalist id="libDetCatList">/.test(js) && /function libDetCategoryOptions\(a\)/.test(js)
  && /LIBDET_CAT_LEN = 20/.test(js) && /留空 = 跟随规则分类/.test(js));
check('标签：回车/逗号添加、可删 chip、每个 ≤20 字、满 12 个禁用输入',
  /id="libDetTagInput"/.test(js) && /libDetTagsAdd\(/.test(js) && /data-det-tag-del="' \+ esc\(t\)/.test(js)
  && /LIBDET_TAG_MAX = 12/.test(js) && /LIBDET_WORD_LEN = 20/.test(js)
  && /\/\[,，、;；\]$\/\.test/.test(js) && /atMax \? ' disabled' : ''/.test(js));
check('备注是 textarea（≤200 字）并在右下角显示字数',
  /<textarea class="qdb-input" id="libDetNoteInput" rows="2" maxlength="' \+ LIBDET_NOTE_LEN/.test(js)
  && /LIBDET_NOTE_LEN = 200/.test(js) && /id="libDetNoteCount"/.test(js)
  && /libDetNoteInput'\) \{/.test(js) && /String\(t\.value \|\| ''\)\.length \+ '\/' \+ LIBDET_NOTE_LEN/.test(js));
check('保存：一次 POST {key,tags,category,note}，成功后 toast「已保存」并重画',
  /function libDetSave\(\)/.test(js)
  && /libDetMetaPost\(\{ tags: draft\.tags, category: draft\.category, note: draft\.note \}\)/.test(js)
  && /apiWrite\('\/api\/library\/manual-meta', req\)/.test(js) && /var req = \{ key: key \};/.test(js)
  && /toast\('已保存', 'ok'\)/.test(js));
check('清除手动信息：二次确认后 POST {key,clear:true}',
  /function libDetManualClear\(\)/.test(js) && /title: '清除手动信息？'/.test(js)
  && /confirmLabel: '清除'/.test(js) && /danger: true/.test(js)
  && /libDetMetaPost\(\{ clear: true \}\)/.test(js) && /已清除手动信息/.test(js));
check('保存中禁用；成功后刷新卡片与 Pro 分类（重拉 facets）；失败给人话',
  /var dis = libDetState\.manualBusy \? ' disabled' : ''/.test(js)
  && /function libDetRefreshCards\(\)/.test(js) && /libraryRepaint\(\)/.test(js)
  && /libProPaintGrid\(\)/.test(js) && /libProLoad\(\)/.test(js)
  && /后端还没上线手动标签（重启桥接后再试）/.test(js) && /'保存失败：'/.test(js));
check('后端没上线：只显示一句人话，不阻塞抽屉其它操作',
  /libDetState\.manualErr/.test(js)
  && /api\('\/api\/library\/manual-meta\?key=' \+ encodeURIComponent\(key\)\)/.test(js)
  && /data-tone="warn">' \+ esc\(libDetState\.manualErr\)/.test(js));
check('卡片：categoryFrom === \'manual\' 的分类 chip 带「· 手动」，备注显示成一行灰字',
  /var catManual = a\.categoryFrom === 'manual' \|\| Boolean\(a\.manualCategory\)/.test(js)
  && /\+ esc\(cat\) \+ \(catManual \? ' · 手动' : ''\)/.test(js)
  && /class="qdb-libpro-note"/.test(js) && /a\.manualNote/.test(js));
check('卡片根节点：有手动分类/标签/备注时加 data-manual="1"（文件库与 Pro 页都认）',
  /Boolean\(catManual \|\| \(Array\.isArray\(a\.manualTags\) && a\.manualTags\.length\) \|\| a\.manualNote\)/.test(js)
  && /hasManual \? ' data-manual="1"' : ''/.test(js) && (js.match(/data-manual="1"/g) || []).length >= 2);
check('信息条：手动分类/标签排在解析标签前面，用 data-kind="manual" 的另一种样式',
  /data-kind="manual" title="手动标签"/.test(js) && /data-kind="manual" title="手动分类（手动优先于规则）"/.test(js)
  && js.indexOf('manualCat') < js.indexOf("if (meta && meta.category) chips.push"));
check('Pro 左栏：手动创建的分类显示「· 手动」（只从当前页 categoryFrom===\'manual\' 推断）',
  /function libProManualCatMap\(\)/.test(js) && /libProManualCatMap\(\)/.test(js)
  && /label \+= ' · 手动'/.test(js) && /a\.categoryFrom === 'manual' \? String\(a\.category \|\| ''\)/.test(js));
check('Pro 左栏分类走服务端 ?category=<名> 且中文正确编码（点分类后重新拉 assets）',
  /libProState\.category \? '&category=' \+ encodeURIComponent\(libProState\.category\) : ''/.test(js)
  && /if \(kind === 'category'\) \{ libProPaintSide\(\); libProPaintCats\(\); libProLoad\(\); return; \}/.test(js));


console.log('## 素材库 v2：导航整合 / 视图组 / 工具条 / 已购未下载 / 下载中心');
const libSection = (html.match(/<section data-page="library"[\s\S]*?<\/section>/) ?? [''])[0];
check(/<h1 class="qdb-page-title">转存与存储<\/h1>/.test(libSection), '「文件库」改名「转存与存储」');
check(!/id="libGrid"/.test(libSection) && !/data-page="find"/.test(html), '转存与存储页里没有素材网格，也没有找号页');
check(!/function pageFind\(view, host\)/.test(js) && !/find: pageFind/.test(js), 'pageFind 与 PAGE_LOADERS.find 的直接登记都已移除（只剩别名兜底）');
check(/find: function \(view, host\) \{ return pageLibraryPro\(view, host\); \}/.test(js), 'PAGE_LOADERS.find 兜底到素材库（旧书签仍能打开）');

// 视图组 9 项 + view= 映射
for (const v of ['all', 'with-booth', 'no-booth', 'with-cover', 'no-cover', 'suggested', 'cloud', 'favorite', 'trash']) {
  check(js.includes("['" + v + "'") || js.includes(v + ", '" ), `视图组含 ${v}`, v);
}
check(/LIBPRO_VIEWS = \[[\s\S]{0,600}?\['all', '全部素材'[\s\S]{0,600}?\['cloud', '已购未下载'[\s\S]{0,300}?\['trash', '回收站'/.test(js),
  '左栏第一组=视图：全部/已认号/未认号/有封面/无封面/待确认建议/已购未下载/收藏/回收站');
check(/var viewQ = libProView\(\) && libProView\(\) !== 'all' && !libColIsView\(\) \? '&view=' \+ encodeURIComponent\(libProView\(\)\) : '';/.test(js)
  && /'\/api\/library\/assets\?limit=200&filter=' \+ filterQ \+ '&sort=' \+ encodeURIComponent\(libProState.sort\) \+ viewQ/.test(js),
  '非「全部」视图把 view= 带进 GET /api/library/assets');
check(/function libProMatchView\(a\)[\s\S]{0,500}?libProHasCover\(a\)[\s\S]{0,200}?suggestedBoothId/.test(js),
  '后端不懂 view 时本地按同一套语义兜底（封面/建议/收藏）');
check(/function libProSetView\(v\)/.test(js) && /data-libpro-view/.test(js) && /libProSetView\(vrow.getAttribute\('data-libpro-view'\)\)/.test(js),
  '点左栏视图切换（data-libpro-view）');

// 工具条
const TOOLS = ['library-batchfind', 'library-batchfind-stop', 'library-retry-skipped', 'library-merge', 'library-alias',
  'library-binds-export', 'library-binds-import', 'library-usage-scan', 'library-relocate-undo', 'library-name-find',
  'library-trash-open', 'library-pro-covers-mode', 'library-pro-downloads'];
for (const a of TOOLS) check(js.includes('data-write="' + a + '"'), `工具条含动作 ${a}`, a);
check(/'<div class="qdb-libpro-tools" id="libProTools"><\/div>'/.test(js) || /qdb-libpro-tools/.test(js), '工具条容器在 Pro 页骨架里');
check(/data-write="library-name-find" title="一行一个名字 \/ 商品号，批量搜出来再绑"/.test(js), '按名字找号按钮文案与说明');
check(/data-write="library-pro-covers-mode" data-mode="missing">只补缺的/.test(js)
  && /data-write="library-pro-covers-mode" data-mode="all">全部补齐/.test(js), '补封面下拉：只补缺的 / 全部补齐');
check(/apiWrite\('\/api\/library\/covers\/backfill', \{ mode: m \}\)/.test(js)
  && /api\('\/api\/library\/covers'\)/.test(js) && /\}, 2000\);/.test(js),
  '补封面走 backfill {mode} 并 2 秒轮询 /covers');
check(/data-write="library-pro-covers-stop"/.test(js) && /apiWrite\('\/api\/library\/covers\/stop', \{\}\)/.test(js), '补封面运行中可停止');

// 批量条扩展
check(/function libProBatchExtraHtml\(\)/.test(js) && /data-write="library-pro-batch-covers">补封面</.test(js)
  && /data-write="library-pro-batch-download">下载</.test(js), '多选后批量条加「补封面 / 下载」');

// 已购未下载（cloud）
check('素材库 v2：补封面结束提示带失败数（job.failed）',
  /c\.failed = Number\(\(o\.job && o\.job\.failed\) \|\| o\.failed\)/.test(js)
  && /失败 ' \+ numText\(c\.failed\)/.test(js));
check('素材库 v2：列表与云端都兼容后端 items 字段（view 过滤返回 items）',
  /Array\.isArray\(d && d\.items\) \? d\.items : \[\]/.test(js)
  && /Array\.isArray\(d && d\.items\) \? d\.items : \[\]/.test(js));
check(/\/api\/library\/assets\?view=cloud&limit=' \+ LIBPRO_CLOUD_PAGE/.test(js), 'cloud 视图走 GET /api/library/assets?view=cloud（服务端分页）');
check(/\/api\/library\/cover\?key=' \+ encodeURIComponent\(key\)/.test(js) && /'purchase:' \+ id/.test(js)
  && /referrerpolicy="no-referrer"/.test(js) && /this\.nextElementSibling\.hidden=false/.test(js),
  '云端卡封面走 /api/library/cover?key=purchase:…（lazy + no-referrer + 404 占位）');
check(/data-write="library-purchase-download"/.test(js) && /apiWrite\('\/api\/library\/purchases\/download', \{ boothId: boothId \}\)/.test(js),
  '云端卡「下载」走 POST /api/library/purchases/download');
check(/data-write="library-purchases-open-page" data-url="/.test(js) && /data-write="library-purchases-remove" data-booth="/.test(js),
  '云端卡还有「商品页 ↗」与「移除记录」（复用已购库的 action）');
check(/后端还没上线「已购未下载」（重启桥接后再试）/.test(js), 'cloud 接口 404 时给空态 + 灰字说明');
check(/data-write="library-pro-cloud-all"/.test(js) && /dryRun: true/.test(js) && /dryRun: false/.test(js),
  '顶部「全部下载」先预览（dryRun:true）再确认（dryRun:false）');

// 下载中心
check(/function libProDownloadsOpen\(\)/.test(js) && /api\('\/api\/library\/downloads'\)/.test(js), '下载中心读 GET /api/library/downloads');
check(/进行中 ' \+ numText\(running\.length\) \+ ' · 完成 ' \+ numText\(summary\.done/.test(js), '下载中心汇总条：进行中 / 完成 / 失败 / 排队');
check(/data-write="library-pro-dl-pause"/.test(js) && /data-write="library-pro-dl-resume"/.test(js)
  && /apiWrite\('\/api\/library\/downloads\/' \+ body, \{\}\)/.test(js), '下载中心有暂停 / 恢复');
check(/window\.setInterval\(tick, 1500\)/.test(js), '下载中心 1.5 秒轮询');
check(/下载完成 ' \+ numText\(libProState\.dl\.lastDone\) \+ ' 件，去刷新入库'/.test(js), '全部完成时 toast 提示去刷新入库');
check(/id="libProDlChip"/.test(js) && /chip\.textContent = n \? '下载中 ' \+ numText\(n\)/.test(js), '页面右上角「下载中 N」胶囊');
check(/data-write="library-dl-retry" data-booth="/.test(js) && /data-write="open-folder" data-rel="/.test(js), '下载行有「重试 / 打开文件夹」');

// 按名字找号面板
check(/function libNameFindOpen\(\)/.test(js) && /id="nameFindInput"/.test(js) && /api\('\/api\/library\/assets\?limit=20&q=' \+ encodeURIComponent\(line\)\)/.test(js),
  '按名字找号：多行输入 → GET /api/library/assets?limit=20&q=');
check(/data-write="library-bind-manual" data-key="' \+ esc\(a\.key\)/.test(js), '结果行「绑这个」复用 library-bind-manual');
check(/api\('\/api\/library\/assets\?limit=20&q='/.test(js) && /一行一个名字或商品号/.test(js), '面板说明写明「一行一个名字或商品号」');

// 01-shell 注册
for (const a of ['library-name-find', 'library-pro-downloads', 'library-pro-dl-pause', 'library-pro-dl-resume',
  'library-pro-covers-mode', 'library-pro-covers-stop', 'library-cloud-download', 'library-pro-cloud-all',
  'library-pro-batch-covers', 'library-pro-batch-download']) {
  check(js.includes("'" + a + "': function"), `01-shell 注册 ${a}`, a);
}
check(!js.includes("'find': function") && !/function pageFind\(/.test(js), 'find 不再出现在 WRITE_ACTIONS / 页面实现里');

console.log('## 结构自证');
const ids = [...dom.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
const dupIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
check(dupIds.length === 0, '静态 DOM 里元素 id 唯一', dupIds.length ? `重复：${dupIds.join(', ')}` : `共 ${ids.length} 个`);
const inlineScripts = [...dom.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
check(inlineScripts.length === 1, '只剩一个内联脚本（首屏防闪引导），应用脚本已外链到 client.js', `${inlineScripts.length} 段`);
// eslint-disable-next-line no-new-func -- 这里就是要验证脚本能被解析，不执行
let parseError = null;
for (const source of [...inlineScripts, js]) { try { new Function(source); } catch (error) { parseError = error; } }
check(!parseError, '内联引导脚本与 client.js 语法都可解析', parseError ? parseError.message : `${inlineScripts.length} 段内联 + 外链 client.js`);
check(/if \(document\.readyState === 'loading'\)/.test(js), '脚本在 DOM 未就绪时等 DOMContentLoaded');
check(/hidden\]/.test(html) || /\.hidden = /.test(html), '视图切换用 hidden 属性');

console.log('## 素材库 v2.1：counts / 候选号 / 推荐绑定 / cloud 分页 / 解压 / 自动解压');
const proSrc2 = fs.readFileSync(path.join(ROOT, 'client/10-library-pro.js'), 'utf8');
const cardSrc = fs.readFileSync(path.join(ROOT, 'client/10f-library-cards.js'), 'utf8');
const dlSrc = fs.readFileSync(path.join(ROOT, 'client/10b-library-downloads.js'), 'utf8');
const exSrc = fs.readFileSync(path.join(ROOT, 'client/10h-library-extract.js'), 'utf8');
const cloudSrc = fs.readFileSync(path.join(ROOT, 'client/10c-library-cloud.js'), 'utf8');
const nameSrc = fs.readFileSync(path.join(ROOT, 'client/10a-library-namefind.js'), 'utf8');
const setSrc = fs.readFileSync(path.join(ROOT, 'client/05-settings.js'), 'utf8');

check(proSrc2.includes('libProState.serverCounts = d && d.counts') && proSrc2.includes('function libProServerCount(')
  && /withBooth: d && d\.withBooth != null \? Number\(d\.withBooth\) : null/.test(proSrc2), '左栏计数优先用服务端 counts（缺失回退 withBooth/withCover/total）');
check(/var srv = libProServerCount\(it\[0\]\), count = srv != null \? srv : local\[it\[0\]\];/.test(proSrc2), '视图行用服务端计数，只有服务端没给时才本地兜底');
check(/String\(a\.displayTitle \|\| ''\)\.trim\(\) \|\| libProTitleOf\(a\)/.test(cardSrc), '卡片标题优先 displayTitle');
check(/a\.boothStatus === 'candidate'/.test(cardSrc) && /候选号 \?/.test(cardSrc) && /a\.boothStatus === 'none'/.test(cardSrc), '候选号/未认号标记');
check(cardSrc.includes('bindSuggestions') && /疑似 #/.test(cardSrc) && /用这个/.test(cardSrc) && /data-libpro-suggest-reject/.test(cardSrc), '候选绑定行（疑似 · 用这个 · 不是）');
check(/localStorage\.setItem\(LIBPRO_REJECT_KEY/.test(cardSrc) && /apiWrite\('\/api\/library\/bind-suggestion\/accept', \{ key: key, boothId: boothId \}\)/.test(cardSrc), '「用这个」走 accept 接口，「不是」只记 localStorage');
check(/loading="lazy" decoding="async" referrerpolicy="no-referrer"/.test(cardSrc), '封面 img 带 lazy + no-referrer');
check(/a\.coverReady === false && a\.boothId/.test(cardSrc) && /qdb-libpro-coverfix/.test(cardSrc), 'coverReady=false 时封面位显示「补封面」按钮');
check(cloudSrc.includes("&limit=' + LIBPRO_CLOUD_PAGE + '&offset='") && /cloudTotal = Number\(d && d\.total\)/.test(cloudSrc), 'cloud 走服务端分页（limit/offset + total）');
check(/已显示 ' \+ numText\(shown\) \+ '\/' \+ numText\(total\)/.test(proSrc2), 'cloud 页脚显示「已显示 N/总数」');
check(/data-write="library-purchase-download"/.test(cloudSrc) && /already === true/.test(cloudSrc) && /这件已经下载过了/.test(cloudSrc), 'cloud 卡下载按钮 + already 处理');
check(/HTTP 502/.test(cloudSrc) && /已购清单里没找到下载链接/.test(cloudSrc), 'cloud 下载 502 人话');
check(/data-write="library-extract"/.test(dlSrc) && /dryRun: true/.test(exSrc) && /将解出 /.test(exSrc), '下载中心 done 行「解压」+ dryRun 预览（拆到 10h）');
check(/encrypted === true/.test(exSrc) && /这个压缩包有密码/.test(exSrc) && /type="password"/.test(exSrc) && /本机会记住/.test(exSrc), '解压 encrypted 弹密码框（type=password + 本机会记住）');
check(/已解压 ' \+ numText\(j\.extract\.count/.test(dlSrc), '已有 extract 的行显示「已解压 N 个文件」');
check(setSrc.includes('library.autoExtract') && /data-write="library-auto-extract"/.test(setSrc) && /后端未开放这个开关/.test(setSrc), '自动解压开关（读写 library.autoExtract + 缺失禁用）');
check(js.includes('libProPurchaseDownload') && js.includes('libProExtractOpen') && js.includes('libProAcceptSuggestion'), '新动作都拼进 client.js');
const order = [js.indexOf('// ── 素材库 · 一键认号'), js.indexOf('// ── 素材库 · 卡片渲染'), js.indexOf('function libProCard(')];
check(order.every((v) => v > 0) && order[0] < order[1] && order[1] < order[2], '10e / 10f 拼装顺序正确、卡片渲染函数在 10f');
check(js.includes("'library-purchase-download': function") && js.includes("'library-suggestion-accept': function") && js.includes("'library-extract': function"), '01-shell 注册三个新 action');
check(nameSrc.length > 0 && /按名字找号/.test(nameSrc), '按名字找号仍在（拆到 10a）');

// v2.2（素材集 / 解压 chip / 候选号真数据）——插在汇总行之前
const srcCol = fs.readFileSync('client/10d-library-collections.js', 'utf8');
const downloadSrc = fs.readFileSync('client/10b-library-downloads.js', 'utf8');
function eachFile() { return 1; }
void eachFile;

check(/col\.js/.test('') === false && srcCol.includes('/api/library/collections'), '10d 素材集片段存在并走 GET /api/library/collections');
check(js.includes('+ libProSideExtra()') && srcCol.includes('function libProSideExtra('), '左栏注入素材集分组（Pro 侧栏 + 10d 提供）');
check(js.includes('libProCardChipsExtra(a, chips)') && js.includes('libProCardActsExtra(a)'), '卡片注入素材集 chip 与「入集」按钮');
check(js.includes('libColToolsExtra()'), '工具条注入「新建素材集」（10b 调用）');
check(srcCol.includes("apiWrite('/api/library/collections'") && srcCol.includes("'/api/library/collections/update'") && srcCol.includes("'/api/library/collections/remove'") && srcCol.includes("'/api/library/collections/members'"), '素材集三接口口径（建集 / 改名 / 删除 / 成员）');
check(/LIBCOL_NAME_MAX = 40/.test(srcCol) && /LIBCOL_NOTE_MAX = 200/.test(srcCol) && /maxlength="/.test(srcCol), '名字 ≤40 / 备注 ≤200 与 maxlength');
check(srcCol.includes('缺 ') && srcCol.includes('qdb-libpro-miss') && srcCol.includes('missingKeys'), '成员缺失显示「缺 N 件」红字（读 missingKeys）');
check(srcCol.includes('data-libcol-pick') && srcCol.includes('已在这个集里') && srcCol.includes('disabled'), '加入素材集弹层：勾选要加入的集，已在其中的置灰');
check(js.includes('collection:') && srcCol.includes('function libProColKeep(') && srcCol.includes('function libProFootCount('), '素材集视图（collection:<id>）按成员过滤 + 页脚用集合件数');
check(srcCol.includes('a.extracted') && srcCol.includes("data-write=\"open-folder\"") && srcCol.includes('已解压'), '父件「已解压 · N 个文件」chip 可打开解压目录');
check(srcCol.includes("'collection:' + item.id") && js.includes('libProSetView('), '点素材集行切到该集视图');
check(/zipEntries/.test(exSrc) && /zipBytes/.test(exSrc) && /preview/.test(exSrc), '解压 dryRun 读 zipEntries / zipBytes / preview（10h）');
check(/rr\.files != null/.test(exSrc) && /Array\.isArray\(rr\.skipped\)/.test(exSrc), '真解压读 files 与 skipped 数组（10h）');
check(js.includes("['extracted', '解压产物'") || js.includes("'extracted'"), 'assets?view=extracted 可作为视图');
check(js.includes("'library-collection-new': function") && js.includes("'library-collection-rename': function") && js.includes("'library-collection-remove': function") && js.includes("'library-collection-add': function") && js.includes("'library-collection-remove-member': function"), '01-shell 注册素材集 5 个 action');
check(/data-kind="ok"[^']*已认号/.test(js) && /boothStatus === 'verified'/.test(js), '已认号卡片带「已认号」标记（verified 才有）');
check(css.includes('.qdb-libpro-miss') && css.includes('.qdb-libpro-chip[data-kind="collection"]') && css.includes('.qdb-libpro-chip-btn'), '素材集 CSS：缺件红字 / 归属 chip / chip 按钮');

// 素材库 v2.2 补充：已解压提示 / 详情解压目录 / 待确认建议口径
{
  const dlSrc = fs.readFileSync('client/10b-library-downloads.js', 'utf8');
  const detSrc = fs.readFileSync('client/07m-library-detail.js', 'utf8');
  check(/libProExtractedOf\(boothId\)/.test(dlSrc) && /data-exfiles=/.test(dlSrc), '解压按钮带 data-exfiles（下载台账 job.extract 为空时用 assets.extracted 兜底）');
  check(/已解压过 <b>' \+ numText\(exFiles\)/.test(exSrc) && /再解一次会解到 <code>/.test(exSrc), '已解压过时弹层提示「已解压过 N 个文件；再解一次会解到 <目录>」');
  check(/confirmLabel: exFiles > 0 \? '重新解压' : '开始解压'/.test(exSrc), '已解压过时确认按钮文案是「重新解压」');
  const panelSrc = fs.readFileSync('client/10g-library-detail-panel.js', 'utf8');
  check(/解压目录：/.test(panelSrc) && /data-rel="' \+ esc\(a\.extracted\.dirRel\)/.test(panelSrc), '详情面板显示「解压目录：<相对路径>」并带打开文件夹按钮');
  const proSrc = fs.readFileSync('client/10-library-pro.js', 'utf8');
  const cloudSrc = fs.readFileSync('client/10c-library-cloud.js', 'utf8');
  check(/function libProSuggestionCount\(\)/.test(cloudSrc) && /a.bindSuggestions.length > 0/.test(cloudSrc), '待确认建议计数按 bindSuggestions 从已加载列表兜底（counts.suggested 为 0 时用）');
  check(/var sgl = name === 'suggested'/.test(proSrc), '服务端 counts.suggested 为 0 时回退本地建议数');
  check(/if \(v === 'suggested'\) return Boolean\(a && \(\(Array.isArray\(a.bindSuggestions\)/.test(proSrc), '「待确认建议」视图按 bindSuggestions 过滤（兼容旧 suggestion 字段）');
}

// 素材库 v2.3：一键认号 + 重复素材清理（10e）
{
  const clean = fs.readFileSync('client/10e-library-cleanup.js', 'utf8');
  const pro = fs.readFileSync('client/10-library-pro.js', 'utf8');
  const card = fs.readFileSync('client/10f-library-cards.js', 'utf8');
  const dl = fs.readFileSync('client/10b-library-downloads.js', 'utf8');
  const shell = fs.readFileSync('client/01-shell.js', 'utf8');
  const css2 = fs.readFileSync('public/client.css', 'utf8');
  check(clean.includes("var LIB_CLEANUP_SCORE_MIN = 0.8;") && clean.includes('isFinite(score) && score >= LIB_CLEANUP_SCORE_MIN'), '一键认号：默认勾选相似度 >= 0.8 的候选');
  check(clean.includes("data-cleanup-all") && clean.includes("data-cleanup-none") && clean.includes("id=\"cleanupPickCount\"") && clean.includes('建议人工确认'), '一键认号弹层：全选/全不选 + 已勾选计数 + 低分标「建议人工确认」');
  check(clean.includes("api('/api/library/bind-suggestions?limit=' + LIB_CLEANUP_MAX)") && clean.includes('libBindAllLocal()'), '一键认号：拉 /api/library/bind-suggestions?limit=200，404 时用本地 bindSuggestions 兜底');
  check(clean.includes("apiWrite('/api/library/bind-suggestion/accept', { key: pick.key, boothId: pick.boothId })") && clean.includes('Promise.all([worker(), worker(), worker()])') && clean.includes('fail += 1'), '一键认号：逐条 accept、并发 3、单条失败不中断');
  check(clean.includes("'已认号 ' + numText(r.ok)") && clean.includes('libCleanupRefresh()'), '一键认号：完成 toast「已认号 N 件」并刷新列表/计数');
  check(pro.includes("['duplicated', '重复素材', ''],") && pro.includes('libDupMatch(a, v)') && pro.includes("libProView() === 'duplicated' ? 'duplicated'"), '重复素材视图：左栏项 + 本地过滤 + 服务端 filter=duplicated');
  check(card.includes('libDupBadge(a)') && clean.includes('data-kind="dup"') && clean.includes("a.duplicated === true"), '卡片右上角「重复」badge（duplicated 才出）');
  check(clean.includes('libDupGroupsLocal()') && clean.includes("api('/api/library/duplicates')") && clean.includes('可省'), '清理重复：优先 /api/library/duplicates，404 时按 duplicated 标记本地分组，弹层显示可省空间');
  check(clean.includes("'<input type=\"checkbox\"' + (keep ? ' disabled title=\"这一件保留\"' : ' data-dup-pick=") && clean.includes('data-dup-pick]:checked'), '清理重复弹层：保留件不勾且禁用，默认只勾多余件');
  check(clean.includes("apiWrite('/api/library/batch', { action: 'trash', keys: keys, params: { confirm: true } })") && clean.includes("'已移入回收站 '"), '清理重复：批量 trash（带 params.confirm）并 toast「已移入回收站 N 件」');
  check(clean.includes('后端还没上线「认号建议」接口') && clean.includes('后端还没上线「批量移入回收站」'), '两处 404 人话兜底');
  check(clean.includes('function libCleanupToolsExtra()') && dl.includes('+ libCleanupToolsExtra()') && shell.includes("'library-bind-suggest-all'") && shell.includes("'library-dup-clean'"), '工具条挂「一键认号」「清理重复」并注册两个 action');
  check(css2.includes('.qdb-libpro-badge[data-kind="dup"]') && css2.includes('.qdb-cleanup-row') && css2.includes('.qdb-dup-group'), '清理弹层与重复 badge 的 CSS');
}

// 素材库 v2.4：Pro 拆分（卡片渲染 -> 10f）
{
  const cards10fPath = path.join(ROOT, 'client/10f-library-cards.js');
  check(fs.existsSync(cards10fPath), '10f-library-cards.js 已创建（卡片渲染从 Pro 拆出）');
  const c10f = fs.readFileSync(cards10fPath, 'utf8');
  const pro10 = fs.readFileSync(path.join(ROOT, 'client/10-library-pro.js'), 'utf8');
  check(c10f.includes('function libProCard(a)') && c10f.includes('class="qdb-asset qdb-card qdb-libpro-card"')
    && !pro10.includes('function libProCard(a)'), '卡片渲染搬进 10f（Pro 不再定义 libProCard），class 仍是 qdb-asset qdb-card qdb-libpro-card');
  check(c10f.includes('data-libpro-fav') && c10f.includes('aria-pressed') && c10f.includes('qdb-libpro-fav'), '10f 卡片保留收藏星级按钮（data-libpro-fav + aria-pressed）');
  check(c10f.includes('qdb-libpro-acts') && c10f.includes('data-write="library-find"') && c10f.includes('data-write="library-find-by-image"')
    && c10f.includes('libraryRenameButton(a)') && c10f.includes('libraryTrashButton(a)'), '10f 卡片动作行完整（找号 / 以图搜源 / 改名 / 回收站）');
  check(js.includes('// ── 素材库 · 卡片渲染') && js.indexOf('// ── 素材库 · 卡片渲染') > js.indexOf('// ── 素材库 · 一键认号'), 'build 把 10f 收在 10e 之后（拼装 35 段）');
  check(!/function libProPaintGrid\(/.test(pro10) && /function libProPaintGrid\(/.test(c10f), '网格重画也搬进 10f（Pro 只剩框架）');
}

// 素材库 v2.5：解压密码 / 包内信息 / 回收站立即清理
{
  const ex = fs.readFileSync(path.join(ROOT, 'client/10h-library-extract.js'), 'utf8');
  const c10f = fs.readFileSync(path.join(ROOT, 'client/10f-library-cards.js'), 'utf8');
  const trash = fs.readFileSync(path.join(ROOT, 'client/07k-library-trash.js'), 'utf8');
  check(ex.includes("bad_password") && ex.includes("密码不对，再试一次"), '解压坏密码重试：bad_password -> 「密码不对，再试一次」');
  check(ex.includes('AES 加密') && ex.includes('7-Zip'), 'AES 加密包提示只能用 7-Zip 手动解');
  check(/libProArchivePeek/.test(ex) && /passwordCandidates/.test(ex) && /来自包内说明/.test(ex), '密码框预填包内说明里的密码候选，并标注「来自包内说明」');
  check(/toast\('解出 ' \+ numText\(n\)/.test(ex) && /body\.password = password/.test(ex) && /libProExtractPost\(boothId, pw\)/.test(ex), '带密码提交 { boothId, password }，成功 toast「解出 N 个文件」');
  check(c10f.includes('data-libpro-archive-lookup') && /!hasSug|hasSug/.test(c10f), '卡片在没绑定建议时给「查包内信息」按钮（不预请求 archive-info）');
  check(c10f.includes('包内信息：') && c10f.includes('data-write="library-suggestion-accept"') && /data-booth="' \+ esc\(ids\[0\]\)/.test(c10f), '包内信息行「包内信息：#号 · 用这个」复用 accept 接口');
  check(/\/api\/library\/archive-info\?key=/.test(c10f) && c10f.includes('libProArchiveCache'), '点按钮才请求 archive-info，并按 key 缓存');
  check(trash.includes('立即清理过期') && /data-trash-cleanup="1"/.test(trash), '回收站弹层有「立即清理过期」按钮');
  check(/清掉 ' \+ numText\(purged\) \+ ' 项 · 释放 '/.test(trash), '清理成功 toast「清掉 N 项 · 释放 X」');
}

// 素材库 v3：主页面（顶栏控件 / 三入口 / 分类排序展开）与详情面板（图 2）
{
  const pro = fs.readFileSync('client/10-library-pro.js', 'utf8');
  const card = fs.readFileSync('client/10f-library-cards.js', 'utf8');
  const panel = fs.readFileSync('client/10g-library-detail-panel.js', 'utf8');
  const det = fs.readFileSync('client/07m-library-detail.js', 'utf8');
  check(/libProTopExtraHtml\(\)/.test(pro) && /id="libProRefresh"/.test(panel) && /data-libpro-mode="grid"/.test(panel)
    && /data-libpro-mode="list"/.test(panel), '顶栏控件组：刷新 + 网格/列表切换');
  check(/libProMainEntriesHtml\(\)/.test(pro) && /data-libpro-entry/.test(panel) && /浏览/.test(panel) && /以图搜源/.test(panel) && /搭配图/.test(panel),
    '左栏三个入口（浏览 / 以图搜源 / 搭配图）');
  check(/data-libpro-catsort="count"/.test(panel) && /data-libpro-catsort="name"/.test(panel) && /libProState\.catSort/.test(pro), '分类树可按数量/名称排序');
  check(/data-libpro-catmore/.test(panel) && /展开全部 ' \+ numText/.test(pro) && /libProState\.catExpanded/.test(pro), '分类超过 12 个显示「展开全部 N 个子分类」');
  check(/qdb-libpro-files/.test(card) && /numText\(Number\(a\.files\)\) \+ ' 个文件<\/span>'/.test(card), '卡片封面左上角文件数徽标');
  check(/numText\(modelsN\) \+ ' 模型<\/span>'/.test(card) && /a\.meta && a\.meta\.models/.test(card), '卡片信息条显示模型数（来自 meta.models / modelCount）');
  check(/下载并导入到 Unity 工程/.test(panel) && /id="libDetUnity"/.test(panel) && /libDetUnityRoot/.test(panel) && /data-detp-import/.test(panel),
    '详情面板「下载并导入到 Unity 工程」区块');
  check(/Booth 已购文件/.test(panel) && /id="libDetPurchFiles"/.test(panel) && /data-detp-filedl/.test(panel), '详情面板已购文件列表');
  check(/libDetPanelSavePath/.test(panel) && /保存位置：/.test(panel) && /将保存到/.test(panel), '详情面板保存位置灰字（已下载/未下载两种口径）');
  check(/libDetPanelSt\(a\)/.test(panel) && /未见本地/.test(panel) && /未下载/.test(panel) && /已下载/.test(panel) && /已解压/.test(panel),
    '详情面板状态徽标四态（未见本地/未下载/已下载/已解压）');
  check(/libDetImportUnity\(t\.closest\('\[data-detp-import\]'\)\)/.test(panel) && /apiWrite\('\/api\/library\/import-to-unity', \{ boothId: boothId, usageRoot: root \}\)/.test(panel),
    '「下载并导入」走 POST /api/library/import-to-unity { boothId, usageRoot }');
  check(/libDetPanelLoad\(key, a\.boothId/.test(det) && /libDetPanelLoad/.test(panel) && /purchase-files\?boothId=/.test(panel), '打开详情时并行拉 Unity 根与已购文件');
  check(/filesErr = .*'not-found'/.test(panel) && /rootsErr/.test(panel) && /data-detp-settings/.test(panel), '404/无配置时降级：已购文件整块隐藏、Unity 区块给「去设置」');
  check(/libDetBodyHtml\(a, note\)/.test(det) && /libDetPanelHtml/.test(det), '07m 正文委托 10g（详情面板整块拆出）');
  const orderG = [js.indexOf('// ── 素材库 · 卡片渲染'), js.indexOf('// ── 素材库 · 详情面板')];
  check(js.includes('// ── 素材库 · 详情面板') && orderG[1] > orderG[0], '拼装顺序：10f 卡片 → 10g 详情面板');
}

// v3: Unity not configured / import error shown in panel
{
  const panel = fs.readFileSync('client/10g-library-detail-panel.js', 'utf8');
  check(/id="libDetUnityRoot" aria-label="Unity 工程目录" disabled>/.test(panel)
    && /data-detp-settings="1">去配置</.test(panel)
    && /function libDetGoSettings\(\)/.test(panel)
    && !/E:\/\/Unity\/MyProject/.test(panel), 'roots empty: Unity select disabled + go-config button + no fake path');
  check(/libDetPanelState\.unityErr = msg/.test(panel)
    && /id="libDetUnityErr"/.test(panel)
    && /libDetPanelPaint\(card\)/.test(panel), 'import 400: backend text rendered into #libDetUnityErr and repaint');
}

// ## 素材库 v4：上传入口 / BOOTH 商店 / 已购免费鸡蛋入口 / 分类跳转 / 质量检查新增
{
  const pro = fs.readFileSync('client/10-library-pro.js', 'utf8');
  const g10 = fs.readFileSync('client/10g-library-detail-panel.js', 'utf8');
  const f10 = fs.readFileSync('client/10f-library-cards.js', 'utf8');
  const shell = fs.readFileSync('client/01-shell.js', 'utf8');
  check(/data-libpro-upload="1"/.test(g10) && /拖进 QQ 群或私聊机器人/.test(g10) && /confirmLabel: '打开转存与存储页'/.test(g10) && /showView\('library'\)/.test(g10), 'v4：顶栏「上传」按钮 + 弹层说明 +「打开转存与存储页」跳转');
  check(/data-libpro-entry="cloud"/.test(g10) && /BOOTH 已购与免费鸡蛋/.test(g10) && /libProSetView\('cloud'\)/.test(g10), 'v4：左栏「BOOTH 已购与免费鸡蛋」入口 → view=cloud');
  check(/serverCounts/.test(g10) && /sc\.cloud/.test(g10), 'v4：该入口计数优先读服务端 counts.cloud');
  check(/data-libpro-entry="shop"/.test(g10) && /BOOTH 商店/.test(g10) && /'\/api\/library\/purchases\/resolve'/.test(g10) && /只查不导入/.test(g10) && !/purchases\/import/.test(g10), 'v4：「BOOTH 商店」弹层复用 resolve 接口且不导入');
  check(/data-libpro-shop-open=/.test(g10) && /'\/api\/open-url'/.test(g10), 'v4：商店解析结果带「商品页」按钮（open-url 主路径）');
  check(/data-write="library-cat-jump" data-cat=/.test(f10) && /同分类还有/.test(f10), 'v4：卡片分类 chip 可点（library-cat-jump）并带「同分类还有 N 件」');
  check(/'library-cat-jump': function \(btn\) \{ return libProCatJump\(/.test(shell) && /function libProCatJump\(cat\)/.test(pro), 'v4：01-shell 注册 library-cat-jump → libProCatJump');
  check(/\['extracted', '已解压（未归档）'\]/.test(pro) && /\['duplicated', '重复（组内）'\]/.test(pro), 'v4：质量检查补「已解压（未归档）」「重复（组内）」两项');
  check(/quality === 'extracted'/.test(pro) && /filterQ = libProView\(\) === 'duplicated' \? 'duplicated' : \(libProState\.quality === 'extracted' \? 'extracted' : 'all'\)/.test(pro), 'v4：已解压按 asset.extracted 本地过滤且请求带 filter=extracted');
}

// v4 补充：BOOTH 商店结果卡封面必须有固定尺寸（防止大图撑爆弹层）
{
  check(/\.qdb-proshop-cover \{[^}]*width: 96px;[^}]*height: 96px;[^}]*object-fit: cover;/.test(css), '商店结果卡封面固定 96×96 + object-fit: cover');
  check(/\.qdb-dialog\.qdb-proshop \{ max-width: 560px; \}/.test(css), '商店弹层宽度 ≤560px');
  check(js.indexOf('qdb-proshop-card') > 0 && js.indexOf('qdb-proshop-title') > 0 && js.indexOf('qdb-proshop-main') > 0, '商店结果卡是「封面 + 右侧竖排」结构');
  check(!/class="qdb-proshop-cover"[^]*?nowrap/.test(css) && /\.qdb-proshop-title \{[^}]*overflow-wrap: anywhere;/.test(css), '结果卡标题长文本换行（不用 nowrap）');
}

// v4 补充：详情面板标题用台账商品名 + 原名行 + 店铺价格行
{
  check(/libDetPanelMerge\(raw\)/.test(js) && /a\.displayTitle \|\| a\.title \|\| a\.aliasTitle/.test(js), '抽屉标题优先 displayTitle（详情接口缺字段时回退列表卡）');
  check(/libDetOrigName\(a\)/.test(js) && /origName !== title/.test(js) && /qdb-detp-orig/.test(js), '原名行只在「原名 ≠ 标题」时显示');
  check(/'店铺 \/ 价格'/.test(js) && /a\.shopName \|\| a\.shop/.test(js) && /a\.priceText \|\| a\.price/.test(js), 'BOOTH 号下面一行显示 店铺 / 价格（缺则整行不显示）');
}

// ── 设置页：私聊加好友提示 / 纯净模式 ─────────────────────────────────────
{
  const setSrc = js;
  check(/panelBox\('私聊'/.test(setSrc) && /攒够句数后提示加好友/.test(setSrc), '设置页「私聊」块：标题 + 加好友提示开关行');
  check(/QQ 只允许发文字；攒够条数后会在消息末尾自然提一句，不单独发一条/.test(setSrc), '「私聊」块说明行文案与原话一致');
  check(/LIB_PRIV_ROOTS = \{ enabled: 'socialV2\.private\.addFriendHint\.enabled', after: 'socialV2\.private\.addFriendHint\.afterMessages', cool: 'socialV2\.private\.addFriendHint\.cooldownMs' \}/.test(setSrc), '私聊块三条配置键与后端契约一致');
  check(/libSetNum\(libSetVal\(LIB_PRIV_ROOTS\.after, 15\), 15, 5, 200\)/.test(setSrc) && /libSetNum\(Math\.round\(Number\(libSetVal\(LIB_PRIV_ROOTS\.cool, 86400000\)\) \/ 3600000\), 24, 1, 720\)/.test(setSrc), '私聊数字框默认/范围：afterMessages 15（5~200）、冷却 24 小时（1~720）');
    check(/'socialV2\.private\.addFriendHint\.afterMessages': v/.test(setSrc) && /cooldownMs': h \* 3600000/.test(setSrc) && /已夹到 /.test(setSrc), '写 patch：afterMessages 写数字、cooldown 小时×3600000 成毫秒，越界夹紧并提示');
  check(/\(open \? '' : ' disabled'\)/.test(setSrc) && /后端尚未开放这几项配置，暂时只读。/.test(setSrc), '白名单缺失时控件 disabled + 「后端尚未开放」文案');
  check(/纯净模式（极致省 token）/.test(setSrc) && /省掉：记忆上下文、黑话、表情库与表情策略、交接\/开场白、长历史引用/.test(setSrc) && /保留：人设、必要规则、画图与发送节奏/.test(setSrc) && /每轮步数上限降为 6/.test(setSrc), '纯净模式块三行说明文案齐全');
  check(/'socialV2\.pureMode\.enabled': Boolean\(el\.checked\)/.test(setSrc) && /已打开纯净模式/.test(setSrc), '纯净模式开关写 socialV2.pureMode.enabled 并 toast');
  check(/\/api\/debug\/prompt-parts\?key=/.test(setSrc) && /settingsState && settingsState\.group === 'model'\) \{ libPureFetchParts\(\); if \(typeof libLocalMount === 'function'\) libLocalMount\(\); \} else if \(typeof libLocalUnmount === 'function'\) \{ libLocalUnmount\(\); \}/.test(setSrc), '切到模型分组 / 切开关后重新拉 prompt-parts');
  check(/\.qdb-set-lines \{/.test(css) && /\.qdb-set-numin \{/.test(css) && /settingsBodyHtml = function \(\)/.test(setSrc) && /group === 'access'\) html \+= libPrivHintHtml\(\)/.test(setSrc) && /group === 'model'\) html = libAgentHtml\(\) \+ \(typeof libLocalHtml === 'function' \? libLocalHtml\(\) : ''\) \+ html \+ libPureModeHtml\(\)/.test(setSrc), '新增样式 + 两个块挂在「对话白名单」「模型与思考」分组');
}

// 工具消耗卡（04b）
{
  const tools = fs.readFileSync(path.join(ROOT, 'client', '04b-usage-tools.js'), 'utf8');
  const usageSrc = fs.readFileSync(path.join(ROOT, 'client', '04-usage.js'), 'utf8');
  const toolsCss = css;
  check(tools.length > 2000 && /usageToolsMount\(host\);/.test(usageSrc) && usageSrc.indexOf('usageToolsMount(host);') > usageSrc.indexOf('今日各群调用'),
    '工具消耗卡片段存在且挂在「今日各群调用」下方');
  check(/id="usageToolsPanel"/.test(tools) && /qdb-panel-title">工具消耗</.test(tools) && /id="usageToolsBar"/.test(tools),
    '卡片标题「工具消耗」+ 堆叠条容器');
  check(/var USAGE_TOOLS_RANGES = \[\['today', '今日'\], \['7d', '近 7 天'\], \['all', '全部'\]\]/.test(tools) && /usageToolsState = \{ range: 'today'/.test(tools)
    && /'\/api\/tokens\/tools\?range=' \+ encodeURIComponent\(usageToolsState.range\)/.test(tools),
    '范围胶囊默认今日，请求带 range=');
  check(/<option value="all"' \+ \(usageToolsState.key === 'all'/.test(tools) && /'&key=' \+ encodeURIComponent\(usageToolsState.key\)/.test(tools)
    && /usageToolsState.key = String\(sel.value \|\| 'all'\);/.test(tools),
    '群下拉默认全部群（key=all），切换后请求带 key=');
  check(/var USAGE_TOOLS_TOP = 6;/.test(tools) && /style="width:' \+ usageToolsPct\(share\).toFixed\(2\)/.test(tools) && /USAGE_PIE_COLORS\[i % USAGE_PIE_COLORS.length\]/.test(tools),
    '堆叠条 Top 6 + 宽度按 share + 沿用饼图配色');
  check(/data-tools-jump="' \+ esc\(String\(t.id \|\| ''\)\)/.test(tools) && /box.scrollTop = Math.max\(0, row.offsetTop - box.clientHeight \/ 2\)/.test(tools) && /classList.add\('is-hit'\)/.test(tools)
    && /window.setTimeout\(function \(\) \{ row.classList.remove\('is-hit'\); \}, 1500\)/.test(tools),
    '图例点击跳行（只滚表格容器 + 页面定位）+ 高亮 1.5 秒');
  check(/<th>' \+ \(usageToolsState.view === 'groups' \? '类别' : '工具'\)/.test(tools) && /<th>调用<\/th><th>轮次<\/th><th>token<\/th><th>花费<\/th><th>平均每轮<\/th><th>缓存命中<\/th>/.test(tools)
    && /rows.sort\(function \(a, b\) \{ return Number\(\(b.tokens && b.tokens.total\) \|\| 0\) - Number\(\(a.tokens && a.tokens.total\) \|\| 0\); \}\)/.test(tools),
    '表格七列齐全且按 tokens 降序');
  check(/var USAGE_TOOLS_FOLD = 12;/.test(tools) && /data-tools-more="1"/.test(tools) && /展开全部 ' \+ numText\(rows.length\)/.test(tools),
    '行数 > 12 折叠「展开全部 N 个」');
  check(/data-tools-mode="' \+ \(usageToolsState.view === 'tools' \? 'groups' : 'tools'\)/.test(tools) && /if \(usageToolsState.view === 'groups'\)/.test(tools)
    && /\(d.groups \|\| \[\]\).map/.test(tools),
    '「按类别」切换读 groups（5 组）');
  check(/已对账 · Σ 各工具 \+ 纯对话 = 总账/.test(tools) && /有 ' \+ usageToolsTokenText\(bad\) \+ ' token 未归因（账本与工具日志不一致）/.test(tools)
    && /data-tone="ok"/.test(tools) && /data-tone="warn"/.test(tools),
    '对账脚注两态（绿点已对账 / 黄点未归因）');
  check(/今天还没记录到工具调用（统计从这一版上线开始）/.test(tools) && /后端还没上线工具消耗统计（重启桥接后再试）/.test(tools) && /data-tools-retry="1"/.test(tools),
    '空态 / 404 降级 / 失败重试 三种兜底');
  check(/\.filter\(function \(t\) \{ return Number\(t && t.share\) > 0 \|\| Number\(\(t.tokens && t.tokens.total\) \|\| 0\) > 0; \}\)/.test(tools),
    'share 为 0 且无 token 的工具不显示');
  check(/turns > 0 \? tok \/ turns : null/.test(tools) && /t\.avgTokensPerTurn != null \? t\.avgTokensPerTurn : \(turns > 0 \? tok \/ turns : null\)/.test(tools) && /r.avg == null \|\| !isFinite\(Number\(r.avg\)\) \? '—'/.test(tools),
    '平均每轮除零防护（turns=0 → —）');
  check(/\.qdb-tools-bar \{[^}]*display: flex;/.test(toolsCss) && /\.qdb-tools-seg \{ display: block; height: 100%;/.test(toolsCss)
    && /\.qdb-tools-table\b/.test(toolsCss) && /\.qdb-tools-recon\b/.test(toolsCss),
    '工具消耗卡 CSS（堆叠条 / 表格 / 对账行）');
}

console.log('\n## 用量页 · 模型用量（按 provider，04c）');
{
  var prov = '';
  try { prov = fs.readFileSync(path.join(ROOT, 'client', '04c-usage-providers.js'), 'utf8'); } catch (e) { prov = ''; }
  var usageSrc = fs.readFileSync(path.join(ROOT, 'client', '04-usage.js'), 'utf8');
  var iTools = usageSrc.indexOf('usageToolsMount(host);');
  var iProv = usageSrc.indexOf('usageProvidersMount(host);');
  check(prov.length > 0 && iProv > iTools, '04c 存在，且挂在工具消耗卡之后（04-usage 只加一行 mount）');
  check(/qdb-panel-title">模型用量（按 provider）/.test(prov), '卡片标题「模型用量（按 provider）」');
  check(/providers\?range=' \+ encodeURIComponent\(usageProvidersState\.range\)/.test(prov)
    && /&basis=' \+ encodeURIComponent\(usageProvidersState\.basis\)/.test(prov)
    && /&key=' \+ encodeURIComponent\(usageProvidersState\.key \|\| 'all'\)/.test(prov), '请求 URL 带 range / basis / key 三个参数');
  check(/usageProvidersState\.basis = nb;/.test(prov) && /usageProvPaint\(\);/.test(prov) && /usageProvidersLoad\(\);/.test(prov)
    && /getElementById\('usageProvWrap'\)/.test(prov), '切 basis 只重画卡片本体并重新请求（不整页重画）');
  check(/id="usageProvBar"/.test(prov) && /USAGE_PIE_COLORS\[i % 8\]/.test(prov) && /usageToolsPct\(p\.share\)\.toFixed\(2\)/.test(prov)
    && /qdb-tools-legend-item/.test(prov), '横向占比条按 share + 配色沿用 USAGE_PIE_COLORS + 图例');
  check(/<th>provider<\/th><th>调用<\/th><th>token<\/th><th>花费<\/th><th>占比<\/th>/.test(prov), '表格五列：provider / 调用 / token / 花费 / 占比');
  check(/return bv - av;/.test(prov) && /Number\(a\.billed\) \|\| Number\(a\.tokens && a\.tokens\.total\)/.test(prov), '按 billed 降序（缺 billed 时退 tokens.total）');
  check(/总计 计费口径 ' \+ usageToolsTokenText\(billed\) \+ '（新增 cacheMiss\+output）'/.test(prov)
    && /' · 原始 ' \+ usageToolsTokenText\(raw\) \+ '（含缓存命中）'/.test(prov), '合计行同时写清费口径与原始 token 两个口径');
  check(/WorkBuddy \/ DeepSeek 后台一般只统计/.test(prov) && /切到「计费口径」再和后台比/.test(prov), '口径说明文案写死');
  check(/后端还没上线 provider 统计（重启桥接后再试）/.test(prov) && /data-prov-retry="1">重试/.test(prov), '404 降级文案 + 重试按钮');
  check(/这段时间没有采样/.test(prov), '空态文案「这段时间没有采样」');
  check(/USAGE_PROV_FOLD = 8/.test(prov) && /rows\.length > USAGE_PROV_FOLD/.test(prov), '超过 8 行折叠');
  check(/Number\(p\.share\) > 0 \|\| Number\(p\.billed\) > 0/.test(prov), 'share 为 0 且无计费/token 的 provider 不显示');
  check(/<option value="all"/.test(prov) && /usageToolsScopeOptions/.test(prov), '群下拉默认「全部群」，选项复用 04b 的会话列表');
}


// ---------- 设置页：模型后端（v6） ----------
(function () {
  const set = fs.readFileSync(path.join(ROOT, 'client', '05-settings.js'), 'utf8');
  check(/function libAgentHtml\(\)/.test(set) && /panelBox\('模型后端'/.test(set), '设置页有「模型后端」块');
  check(/if \(group === 'model'\) html = libAgentHtml\(\) \+ \(typeof libLocalHtml === 'function' \? libLocalHtml\(\) : ''\) \+ html \+ libPureModeHtml\(\)( \+ libMemeWikiHtml\(\))?( \+ libImageMemoryHtml\(\))?;/.test(set), '模型后端块插在「模型与思考」分组最上面');
  check(/var LIB_AGENT_TYPES = \[\['dsh', 'DSH'\], \['openai', 'OpenAI 兼容'\], \['http', '自研 HTTP'\]\]/.test(set)
    && /data-agent-type="' \+ t\[0\] \+ '"/.test(set) && /" aria-pressed="' \+ \(type === t\[0\]/.test(set), '后端分段三态 + aria-pressed');
  check(/自研后端由你实现一轮对话与工具回传；桥接负责 QQ 侧、人设、记忆与 40 个工具。/.test(set) && /note\.hidden = libAgentState\.type !== 'http'/.test(set), '选 http 时给自研后端说明');
  check(/id="libAgentBaseUrl" placeholder="' \+ basePh \+ '"/.test(set)
    && /'https:\/\/my-agent\.example\.com' : 'https:\/\/api\.deepseek\.com\/v1'/.test(set)
    && /id="libAgentModel" placeholder="' \+ \(type === 'http' \? 'my-agent' : 'deepseek-chat'\) \+ '"/.test(set)
    && /id="libAgentApiKey" type="password"/.test(set)
    && /id="libAgentTimeout" type="number" min="10" max="600"/.test(set)
    && /id="libAgentRounds" type="number" min="1" max="20"/.test(set), 'openai/http 四输入与范围');
  check(/libSetNum\(\(libAgentInput\('libAgentTimeout'\) \|\| \{\}\)\.value, 60, 10, 600\)/.test(set) && /secs \* 1000/.test(set), '超时按秒读、写时 ×1000');
  check(/已保存（留空=不修改）/.test(set) && /if \(libAgentState\.clearKey && keyVal === ''\)/.test(set), 'hasApiKey 提示 + 留空不提交');
  check(/patch\['agent\.apiKey'\] = '';/.test(set) && /libAgentState\.clearKey = true/.test(set), '「清除」写空串');
  check(/libAgentState\.busy = true/.test(set) && /apiWrite\('\/api\/agent\/probe'/.test(set) && /'连通 ✓'/.test(set), '连通测试：loading + 成功文案');
  check(/连通失败：' \+ msg\.replace/.test(set) && /后端还没上线连通测试（重启桥接后再试）/.test(set), '连通失败原文 + 404 人话');
  check(/var patch = \{\};/.test(set) && /if \(type !== String\(agent\.type \|\| 'dsh'\)\) patch\['agent\.type'\] = type;/.test(set) && /Object\.keys\(patch\)\.length/.test(set), '只提交改动字段');
  check(/切换后端后下一轮生效；切回 DSH 不影响现有配置。/.test(set), '切换后端生效提示');
})();

  const setSrc2 = fs.readFileSync(path.join(ROOT, 'client', '05-settings.js'), 'utf8');
  check(!/\['http', '自研 HTTP（未实现）'\]/.test(setSrc2) && /\['http', '自研 HTTP'\]/.test(setSrc2) && /\(typeOpen \? '' : ' disabled'\)/.test(setSrc2), 'http 段不再置灰（三态都可选）');
  check(/服务端地址/.test(setSrc2) && /模型名（可选，仅显示用）/.test(setSrc2) && /访问令牌（可选，作为 Bearer）/.test(setSrc2) && /POST \/turn 与 POST \/tool-result/.test(setSrc2), 'http 三个输入与后端文档文案');
  check(/libAgentHttpNote/.test(setSrc2) && /自研后端由你实现一轮对话与工具回传/.test(setSrc2) && /note\.hidden = libAgentState\.type !== 'http'/.test(setSrc2), 'http 专用提示行（切回 DSH 隐藏）');
  check(/if \(type === 'openai' \|\| type === 'http'\)/.test(setSrc2) && /else \{\s*var httpModel/.test(setSrc2) && /apiWrite\('\/api\/agent\/probe', body\)/.test(setSrc2), 'probe 对 http 也发 type:http 的请求体');
  check(/box\.hidden = libAgentState\.type === 'dsh'/.test(setSrc2), '切回 DSH 时输入块收起');
console.log('\n## 设置页 · 桌面客户端版本块（07h）');
const desktopSrc = fs.readFileSync(path.join(ROOT, 'client', '07h-desktop-client.js'), 'utf8');
const openFolderSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge', 'console', 'open-folder.js'), 'utf8');
check(desktopSrc.includes('settingsClientHtml = function') && desktopSrc.includes('qdb-panel-body'), '07h 用运行时包装把状态块注入 settingsClientHtml 面板');
check(desktopSrc.includes('qdb-desktop-state') && desktopSrc.includes('qdb-desktop-row'), '三行状态块用 qdb-desktop-state / qdb-desktop-row');
check(desktopSrc.includes('当前状态') && desktopSrc.includes('版本') && desktopSrc.includes('位置'), '三行分别是 当前状态 / 版本 / 位置');
check(desktopSrc.includes('data-write="desktop-check"') && desktopSrc.includes('data-write="desktop-copy-cmd"'), '检查更新与复制安装命令按钮带 data-write');
check(/d && d\.installerPath/.test(desktopSrc) && /d && d\.installed && d\.installDir/.test(desktopSrc), '安装包目录/安装目录按钮各自按条件显示');
check(desktopSrc.includes('后端还没上线这个接口') && desktopSrc.includes('disabled title="后端还没上线这个接口"'), 'status 404 时按钮禁用 + tooltip 文案');
check(desktopSrc.includes("'behind'") && /\[data-tone="behind"\]/.test(html), '版本落后用 behind 橙色态');
check(desktopSrc.includes('已是最新版本') && desktopSrc.includes('有新版本'), '检查更新成功两态文案');
check(desktopSrc.includes('后端还没上线检查更新') && desktopSrc.includes('检查更新失败，稍后再试'), '检查更新 404/5xx 两档人话');
check(/disabled title="没找到安装包"/.test(desktopSrc), '没找到安装包时复制命令按钮禁用 + tooltip');
check(desktopSrc.includes('Start-Process -FilePath') && desktopSrc.includes('-ArgumentList "/S"') && desktopSrc.includes('安装命令已复制，粘到 PowerShell 里跑'), '复制的是 PowerShell 的 Start-Process 命令 + toast 文案');
check(desktopSrc.includes("apiWrite('/api/open-folder', { kind: kind })"), '目录按钮只传 kind，不传任何路径');
check(openFolderSrc.includes("Object.freeze(['installer', 'desktop', 'state'])") && openFolderSrc.includes("deps.spawn('explorer.exe'"), '后端 open-folder 只接受三个枚举 kind 且用 explorer.exe 打开');
check(desktopSrc.includes('后端还没上线打开目录'), 'open-folder 404 时给「后端还没上线打开目录」');
check(desktopSrc.includes('installerPath') && fs.readFileSync(path.join(ROOT, 'src', 'bridge', 'console', 'desktop-client.js'), 'utf8').includes('installerPath: installerOf()'), 'status 新增 installerPath 且前端用上了');
check(desktopSrc.includes('/api/desktop-client/status') && desktopSrc.includes('/api/desktop-client/check'), '状态与检查更新两个接口路径');
console.log('\n## 素材集：总览封面墙 / 批量加入 / 详情移出');
{
  const colSrc = fs.readFileSync(path.join(ROOT, 'client/10d-library-collections.js'), 'utf8');
  check(/data-libcol-overview="1"/.test(colSrc) && /function libColOverviewOpen\(\)/.test(colSrc) && /function libColCardHtml\(it\)/.test(colSrc), '素材集有总览入口（工具条「素材集总览」）与总览弹层');
  check(/data-libcol-card="' \+ esc\(it\.id\)/.test(colSrc) && /libColCoverSrc\(it\)/.test(colSrc) && /libColWhen\(it\.createdAt\)/.test(colSrc) && /numText\(Number\(it\.count\) \|\| 0\) \+ ' 件/.test(colSrc), '总览卡片有封面（集内第一件）、件数、创建时间');
  check(/function libColReadName\(exceptId\)/.test(colSrc) && /已经有叫「' \+ name \+ '」的素材集了，换个名字/.test(colSrc) && /给素材集起个名字/.test(colSrc), '新建/改名：空名字与重名都给中文提示');
  check(/title: '删除素材集？'/.test(colSrc) && /danger: true, confirmLabel: '删除'/.test(colSrc) && /只删这个集（/.test(colSrc), '删除素材集走二次确认，并说明只删集不删素材');
  check(/data-libcol-batch-add/.test(colSrc) && /libBatchPaint\.__libColWrapped/.test(colSrc) && /libColMembersPost\(id, \{ add: keys \}/.test(colSrc), '批量选中后有「加入素材集」按钮，走 members add 接口');
  check(/data-libcol-remove="1"/.test(colSrc) && /if \(libColIsView\(\)\)/.test(colSrc) && /libColMembersPost\(item\.id, \{ remove: \[key\] \}/.test(colSrc), '素材集详情里每件可「移出」（只对素材集视图出现，走 members remove）');
  check(/\.qdb-col-grid \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/.test(css) && /\.qdb-col-card \{/.test(css) && /\.qdb-col-cover img \{/.test(css) && /max-width: 600px\) \{ \.qdb-col-grid \{ grid-template-columns: minmax\(0, 1fr\)/.test(css), '封面墙样式：三列网格 / 卡片 / 封面 / 窄屏单列');
}
// ── 设置页 · 本地模型控制卡（07i）─────────────────────────────────────────────
console.log('\n## 设置页 · 本地模型控制卡（07i）');
{
  const localPath = path.join(ROOT, 'client', '07i-local-model.js');
  const localSrc = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8') : '';
  const setSrc = fs.readFileSync(path.join(ROOT, 'client', '05-settings.js'), 'utf8');
  check(localSrc.length > 0 && /function libLocalHtml\(\)/.test(localSrc), '本地模型片段存在并导出 libLocalHtml');
  check(/libAgentHtml\(\) \+ \(typeof libLocalHtml === 'function' \? libLocalHtml\(\) : ''\) \+ html \+ libPureModeHtml\(\)/.test(setSrc),
    '本地模型卡挂在「模型后端」块下面（DSH/OpenAI/自研 HTTP 之后）');
  // 2026-11-01 修：开关改成看「桥接当前后端」，引擎首次加载 60~90 秒期间保持开，否则 apply 成功也会弹回去。
  check(/libSetSwitch\('libLocalEnable'/.test(localSrc) && /var on = bridge\.agentType === 'openai' \|\| \(starting && !eng\.online\)/.test(localSrc)
    && /startingAt/.test(localSrc) && /启动中（首次加载约 60~90 秒/.test(localSrc),
    '开关 checked = 桥接当前后端为 openai（引擎启动中保持开）');
  check(/action: checked \? 'enable' : 'disable'/.test(localSrc) && /\/api\/local-model\/apply/.test(localSrc)
    && /\/api\/local-model\/restart-bridge/.test(localSrc) && /需要重启桥接才能生效/.test(localSrc),
    'apply 的 enable/disable 映射、restart-bridge 与重启确认文案');
  check(/Array\.isArray\(opts\.sizes\)/.test(localSrc) && /Array\.isArray\(opts\.contexts\)/.test(localSrc)
    && /Array\.isArray\(opts\.visionModes\)/.test(localSrc) && /id="libLocalModel"/.test(localSrc)
    && /id="libLocalContext"/.test(localSrc) && /id="libLocalVision"/.test(localSrc) && /id="libLocalPort"/.test(localSrc),
    '四个选项来自后端 options（sizes/contexts/visionModes + 端口）');
  check(/LIB_LOCAL_POLL_MS = 3000/.test(localSrc) && /document\.hidden/.test(localSrc)
    && /visibilitychange/.test(localSrc) && /libLocalPollStop\(\)/.test(localSrc),
    '3 秒轮询且页面隐藏时停轮询');
  check(/本地模型控制还没上线（接口 404）/.test(localSrc) && /20~30 秒/.test(localSrc) && /切换需要重启桥接/.test(localSrc)
    && /重启超时，请手动重启/.test(localSrc),
    '404 兜底文案、代价说明（20~30 秒）与重启超时提示');
}

console.log('\n========== 通过 ' + passed + ' / 失败 ' + failures.length + ' ==========');
if (failures.length) {
  check('黑话页显示梗库条数并可一键重新导入', () => {
  const usage = read('client/04-usage.js');
  const shell = read('client/01-shell.js');
  assert.ok(usage.includes('memewikiHeadText'), '缺梗库条数');
  assert.ok(usage.includes('slang-memewiki-import'), '缺重新导入按钮');
  assert.ok(shell.includes("'slang-memewiki-import'"), '缺按钮动作');
});
console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}

