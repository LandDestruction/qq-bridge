// 只读访客（BOOTH 素材库 L6 = 做只读访客）：给「只想看看素材库」的人一个只能读的入口。
//
// 为什么要单独一套规则而不是「能读就放行」：
// 1. 控制台里能读的接口一大半是管理端信息（花费账本、人设、白名单、日志、会话明细），
//    只读访客不该看见这些；反过来，漏登记一个写接口就是「访客能改东西」。
// 2. 所以这里用**白名单 + 默认拒绝**：只有明确列出的「看素材库/看文件」的 GET 才放行，
//    其它一律 403。新增接口时忘了登记，结果只是访客看不到，不会变成访客能乱动。
// 3. 角色判定放在纯函数里，方便单测把边界钉死（谁是 admin、谁是 guest、谁的令牌坏掉）。
//
// 令牌：管理员 `state/console-token`（已有），访客 `state/console-guest-token`（新）。
// 访客链接形如 `http://127.0.0.1:3100/client?guest=<guestToken>`，页面会把 guest 令牌
// 存 localStorage 并在请求里带 `x-console-guest`，看不到任何写按钮（后端也会拦）。

export const GUEST_RULES_VERSION = 1;

// 访客能看的接口：只读素材库需要的那几条，全是 GET。
// 顺序无关；前缀以 / 结尾表示「这个前缀下的都算」。
export const GUEST_ALLOWED = [
  '/api/status',                 // 首页那几个健康点
  '/api/version',                // 版本 / QQ 号（顶栏那两枚 chip，公开信息）
  '/api/file-library/archive-rules', // 转存条件（只读展示）
  '/api/library/assets',         // 素材卡列表（含绑定、建议号、封面）
  '/api/library/asset',          // 单件详情（只读；访客视图已剥离 paths/usage，绝对路径只留给管理员）
  '/api/library/binds',          // 已绑定的号（只读展示）
  '/api/library/batchfind',      // 批量找号的进度（GET 只读；POST 不在白名单里）
  '/api/library/find',           // 单件找号（只读搜索；会触发一次外网搜索）
  '/api/library/covers',         // 补封面进度与统计（GET 只读；backfill/stop 是 POST，不在白名单）
  '/api/library/merges',         // 合并组与提案（GET 只读）
  '/api/library/facets',         // 左栏/胶囊的分类·店铺·来源计数（GET 只读，纯计数无路径）
  '/api/library/favorites',      // 收藏列表（GET 只读；写操作 POST /api/library/favorite 不在白名单）
  '/api/library/usage',          // 工程使用统计（GET 只读）
  '/api/library/alias-rules',    // 识别规则表（GET 只读）
  '/api/library/duplicates',     // 重复素材报告（GET 只读；只给 key/标题/字节数，无本机路径）
  '/api/library/collections',    // 素材集列表（GET 只读；update/remove/members 是 POST，不在白名单）
  '/api/library/extract/status', // 解压进度与最近 20 条历史（GET 只读，只有相对路径；POST /api/library/extract 是写操作）
  '/api/library/search-pause',   // BOOTH 限速暂停状态（只读；POST 手动解除仍须管理员，见下）
  '/api/files/stats',            // 转存条件/占用空间
  '/api/files/lists',            // 文件清单（只读）
  '/api/files/raw',              // 原文件（下载/预览）
  '/api/files/thumb',            // 缩略图
  '/api/files/cover/',           // 封面缓存（前缀路由 /api/files/cover/<号>；只读 GET，会顺手抓一次外网封面并写缓存）
  '/api/tokens/tools',           // 各工具维度 token 消耗（GET 只读，纯聚合数字、无本机路径；POST rebuild 不在白名单）
  '/api/stickers/cache',         // 表情缩略图缓存统计（GET 只读，纯数字；cleanup/repair 是 POST，不在白名单）
];

// 访客明确不能碰的（写操作与敏感读）——写在这里主要是给测试和文档用，
// 判定本身靠「不在 GUEST_ALLOWED 里就拒绝」。
export const GUEST_DENIED_SAMPLE = [
  '/api/library/bind', '/api/library/unbind', '/api/library/asset/note', '/api/library/asset/cover',
  '/api/library/download', '/api/library/booth-cookie', '/api/library/owned', '/api/library/favorite',
  '/api/library/manual-meta',    // 手动标签/分类/备注：备注是私人内容，GET 也不给访客
  // 包内信息：包内标题/解压密码候选是私人线索，GET 也不给访客。
  '/api/library/archive-info',
  // 解压（POST 写盘）、下载中心（含本机下载队列与本机路径）、素材集写操作、一键认号写操作
  // 全部只给管理端；GET /api/library/extract/status 与 GET /api/library/collections 才在白名单。
  '/api/library/extract', '/api/library/downloads',
  '/api/library/downloads/pause', '/api/library/downloads/resume',
  '/api/library/collections/update', '/api/library/collections/remove', '/api/library/collections/members',
  '/api/library/bind-suggestion/accept', '/api/library/passwords',
  // BOOTH 登录（弹浏览器抓 Cookie）：登录态是管理端操作，start/status/stop 三条都不给访客。
  '/api/library/purchases/login/start', '/api/library/purchases/login/status', '/api/library/purchases/login/stop',
  '/api/library/purchases', '/api/library/purchases/ocr', '/api/library/purchases/ocr/status', '/api/agent/probe',
  '/api/library/reconcile', '/api/library/trash', '/api/open-url',
  '/api/tokens/summary',
  '/api/tokens/providers', '/api/persona', '/api/config', '/api/socialV2/ai-blacklist',
  // 工具维度消耗的「重建」要读全天台账重算写盘，只给管理端；GET /api/tokens/tools 是只读聚合，在白名单里。
  '/api/tokens/tools/rebuild'
];

function normalizePath(p) {
  const raw = String(p || '');
  const cut = raw.search(/[?#]/);
  const path = cut >= 0 ? raw.slice(0, cut) : raw;
  return path.startsWith('/') ? path : '/' + path;
}

/**
 * 访客能不能访问这个方法+路径。
 * 只有 GET 且命中白名单才放行；HEAD 也算读（静态资源常用），其余方法一律不行。
 */
export function guestAllowed(method, pathname) {
  const m = String(method || '').toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return false;
  const p = normalizePath(pathname);
  for (const item of GUEST_ALLOWED) {
    if (item.endsWith('/')) {
      if (p.startsWith(item)) return true;
    } else if (p === item) {
      return true;
    }
  }
  return false;
}

/** 命中的是哪条白名单（给 403 文案与调试用）；没命中回空串。 */
export function guestAllowRule(method, pathname) {
  const m = String(method || '').toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return '';
  const p = normalizePath(pathname);
  for (const item of GUEST_ALLOWED) {
    if (item.endsWith('/') ? p.startsWith(item) : p === item) return item;
  }
  return '';
}

/**
 * 用请求里带的两套令牌判定角色。
 * 管理员令牌优先（同一个人可能两者都带，管理员当然按管理员算）。
 * 返回 'admin' | 'guest' | ''。
 */
export function roleForTokens({ supplied, adminToken, guestToken }) {
  const given = String(supplied || '');
  if (!given) return '';
  const admin = String(adminToken || '');
  // 长度先比：定长比较在调用方做，这里只做角色归类（真比较仍在 console-server 用 timingSafeEqual）
  if (admin && given.length === admin.length && given === admin) return 'admin';
  const guest = String(guestToken || '');
  if (guest && given.length === guest.length && given === guest) return 'guest';
  return '';
}

/** 给设置页显示的一段人话：访客能看什么、不能看什么。 */
export function describeGuestScope() {
  return '访客只能看：首页健康状态、素材卡与封面、文件清单与占用、单件找号结果、BOOTH 限速暂停状态。'
    + '文件库可看：素材列表、单件详情（不含本机绝对路径）、封面补齐进度、合并组、工程使用统计（仅工程名）、识别规则、分类计数（facets）、收藏列表、重复素材报告、素材集（只读）、解压进度。'
    + '还能看：各工具维度的 token 消耗（只读聚合，没有逐轮明细）。'
    + '不能看：总花费账本与逐轮流水、人设/记忆、白名单、日志、会话明细、已购清单与对账、回收站、包内信息（标题/解压密码候选）；也不能改任何设置、绑定、下载、解压或写说明，也不能触发用量重建。';
}

/** 访客链接（把令牌拼进 URL；页面读完就存 localStorage、地址栏抹掉）。 */
export function guestLink(baseUrl, token) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const t = String(token || '');
  if (!t) return '';
  return base + '/client?guest=' + encodeURIComponent(t);
}

/** 令牌长度检查：和 console-token 一样，太短就当没配。 */
export function validGuestToken(token) {
  const t = String(token || '').trim();
  return t.length >= 24 && /^[A-Za-z0-9_-]+$/.test(t);
}
