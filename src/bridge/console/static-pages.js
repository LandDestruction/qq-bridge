// console/static-pages: 控制台 3100 服务上**所有静态页面**的唯一分派点。
//
// 为什么单独成文件、放在工厂外：
// ① 原来 /、/ops、/library 三段各写一遍「readFileSync(public/x.html) + writeHead + end」，
//    加一页就要再复制一段；而 handleConsoleOperations 已被代码规模闸（D56）盯上，只许变小。
// ② /library 与 /library.html、/client 与 /client.html 两两等价，散着写最容易只加一半。
// ③ 页面清单集中在这张表里，scripts/test-client-ui.mjs 才能用正则抽「有哪些页 / 哪些文件」，
//    而不是在测试里手抄一份（手抄的清单会过期）。
//
// 现有三页：`/`（= /client，新版客户端页 client.html）、`/ops`（运维面板 ops.html）、
// `/library`（库页面 library.html）。旧控制台 public/console.html 已下线，
// `/` 不再回旧页；历史备份 scripts/fixtures/console.before.html 只给 UI 夹具的 --original 用。
//
// 纯函数 + 显式 deps：没有启动副作用、不碰进程状态，测试可以直接喂假 request/res 验行为。
const STATIC_PAGES = new Map([
  ['/', { file: 'client.html', label: '客户端页面' }],
  ['/ops', { file: 'ops.html', label: '运维面板页面' }],
  ['/library', { file: 'library.html', label: '库页面' }],
  ['/library.html', { file: 'library.html', label: '库页面' }],
  ['/client', { file: 'client.html', label: '客户端页面' }],
  ['/client.html', { file: 'client.html', label: '客户端页面' }],
]);

/** 路径 → 页面描述；不是静态页就返回 null（调用方据此继续走 API 分派）。 */
export function staticPageFor(pathname) {
  return STATIC_PAGES.get(String(pathname ?? '')) ?? null;
}

/** 去重后的页面文件名（测试用来核对 public/ 里真的有这些文件）。 */
export function staticPageFiles() {
  return [...new Set([...STATIC_PAGES.values()].map((page) => page.file))];
}

/**
 * 回一个 200 的 HTML 页面。
 * 文件缺失时不静默回 200 空页：把「缺哪个文件」写进响应体，排查时一眼看到。
 */
export function serveStaticPage(request, deps, page) {
  request.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...request.SECURITY_HEADERS });
  try {
    request.res.end(deps.fs.readFileSync(deps.path.join(deps.ROOT, 'public', page.file), 'utf8'));
  } catch {
    request.res.end(`${page.label}缺失：qq-bridge/public/${page.file}`);
  }
  return true; /* @bridge-handled */
}
