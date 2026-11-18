// console-server: extracted bridge responsibilities; no startup side effects.
// Live dependencies: URL, canonicalV2Key, cfg, handleConsoleAgentProbe, clearTimeout, console, crypto, currentMode, handleConsoleAiBlacklist, handleConsoleBudgetAlert, handleConsoleMemberNotes, handleConsoleConfigAdmin, handleConsoleConversationSend, handleConsoleDraw, handleConsoleFileLibrary, handleConsoleJournal, handleConsoleLists, handleConsoleMediaTools, handleConsoleMemory, handleConsoleMessageDetail, handleConsoleModelsAffinity, handleConsoleOperations, handleConsolePresets, handleConsoleRoleDraft, handleConsoleRoles, handleConsoleSecuritySocial, handleConsoleSendReset, handleConsoleSessionAdmin, handleConsoleSlang, handleConsoleSlangTools, handleConsoleSocialConfig, handleConsoleSocialReads, handleConsoleStickersVoices, handleConsoleWait, handleConsoleWakeControls, http, isSessionAllowedInCurrentMode, loadOrCreateConsoleToken, log, setTimeout, slangStoreWritable, socialV2, stickerStoreWritable
// Windows 上的 curl / PowerShell 5 会按系统 ANSI 码页（简体中文＝GBK）发请求体，
// 直接 toString('utf8') 就把中文变成一串 U+FFFD —— 这些替换字符以前真被发进 QQ 过。
// 先严格按 UTF-8 解，失败再退 GB18030（GBK 的超集）；两个都不行才抛错（让上层回 400）。
// 单独抽成模块作用域函数：readBody 在 server 闭包里，直接写进去会把函数行数顶超规模闸基线。
export function decodeRequestBody(raw, pathname, log) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    try {
      const text = new TextDecoder('gb18030', { fatal: true }).decode(raw);
      (0, log)(`[控制台] 请求体不是 UTF-8，已按 GB18030 重新解码：${pathname}`);
      return text;
    } catch {
      throw new Error('请求体不是 UTF-8（也不是 GBK）：请把中文按 UTF-8 编码后再发');
    }
  }
}

// 令牌持久化的两件小事放在模块级：写进 server() 里会把那段函数撑过冻结基线。
// 1) 从 Cookie 里取出上一次种下的令牌；2) 令牌有效时种一个 HttpOnly Cookie，
//    让刷新页面不再需要 ?token=（表现和 SnowLuma / WorkBuddy 那些面板一致）。
// 角色判定：管理员令牌已在调用点判过（tokenMatches），这里只判访客令牌。
// 单独成函数有两个原因：server() 的行数被冻结基线卡着；以及这段逻辑要被单测钉住。
// 访客也允许取页面壳子与静态资源（/client、/client.js、/bgm/*）：它们不含数据。
function guestShellPath(req, pathname) {
  return req.method === 'GET' && NO_TOKEN_GET_PATHS.has(pathname);
}

function roleOf(req, url, guestToken, crypto) {
  if (!guestToken) return '';
  const supplied = String(url.searchParams.get('guest') ?? req.headers['x-console-guest'] ?? '');
  if (!supplied) return '';
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(guestToken, 'utf8');
  if (a.length !== b.length) return '';
  return crypto.timingSafeEqual(a, b) ? 'guest' : '';
}

function cookieOf(req) {
  const raw = String(req.headers.cookie ?? '');
  const m = /(?:^|;\s*)qdb_console=([^;]*)/.exec(raw);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return ''; }
}
function plantConsoleCookie(res, consoleToken) {
  try {
    res.setHeader('Set-Cookie', `qdb_console=${encodeURIComponent(consoleToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
  } catch { /* 头部已发出就忽略：下一次请求还会再种 */ }
}
// HTML 壳子（/、/client 等）不设令牌门槛：它本身不含任何数据，脚本拿不到令牌就弹输入层。
// 数据接口仍然一律要令牌 —— 免掉的只是「连页面都打不开」，不是鉴权。
const NO_TOKEN_GET_PATHS = new Set([
  '/', '/client', '/client.html', '/ops',
  '/client.css', '/client.js', '/changelog.js',
  '/bgm/default-tune.mp3', '/bgm/haloflux-sw421k.mp3', '/bgm/HALOFLUX-LICENSE.txt'
]);

// 从 server 回调里提取：前置检查（空 token / 暂停 / 模式开关 / 模式隔离 / 管理端专用 / 表情库 / agent 白名单 / 只读降级）。
// 搬出闭包、按参数传递 deps，是因为 server() 的行数被 code-size 闸门冻结基线卡着，不能把这些压在一个 642 行函数里。
// 返回 true = 已写入响应、调用方应立即 return；false = 检查全通过，继续路由分派。逻辑与原来逐字等价。
async function guardConsoleRequest(deps, req, url, sendJson) {
  // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
  if (req.headers['x-agent-token'] === '') {
    sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
    return true;
  }
  // 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝
  if (deps.socialV2.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
    sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
    return true;
  }
  // 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理）
  if (deps.cfg.socialV2?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
    sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
    return true;
  }
  // 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用
  if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && deps.currentMode !== 'reserved2') {
    sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
    return true;
  }
  // 管理端专用 v2 接口：带 agent token 的请求一律拒绝，防止 MCP 工具越权访问控制台功能
  // /api/socialV2/initial-prompt 也在这里：它是操作者写给 AI 的"环境背景"，
  // 让 AI 自己读/改等于把控制台的管理输入（以及未来可能写入的其它群信息）交给会话主体。
  const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states', '/api/socialV2/wake', '/api/socialV2/initial-prompt'];
  if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET'))) {
    sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
    return true;
  }
  // 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库）
  if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
    sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
    return true;
  }
  // agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
  // 因此仅靠控制台令牌挡不住 AI。这里改成白名单：只有 AI 真正需要的面放行，
  // 其余（人格/提示词/思考强度/白名单/重启…）一律 403——避免以后新增管理端点时忘记拉黑。
  if (req.headers['x-agent-token']) {
    const agentAllowed = url.pathname === '/api/status'
      || url.pathname.startsWith('/api/socialV2/')
      || url.pathname.startsWith('/api/send/')
      || url.pathname.startsWith('/api/images/')
      || url.pathname === '/api/authorize/read';
    if (!agentAllowed) {
      sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
      return true;
    }
  }
  // 只读降级：黑话库/表情库在启动时加载失败时，写接口必须**明确失败**。
  // 旧行为是 save 函数里只打一行日志就 return，而接口照样回 {ok:true}：
  // 控制台显示"✅ 已保存"，实际只改在内存里，重启后全部消失。
  if (req.method !== 'GET') {
    const readonlyStore = (!deps.slangStoreWritable && (url.pathname === '/api/slang'
      || url.pathname === '/api/slang/clear'
      || url.pathname === '/api/slang/extract'
      || url.pathname === '/api/slang/research'
      || url.pathname.startsWith('/api/slang/batch-')
      || url.pathname === '/api/socialV2/slang/submit')) ? '黑话库'
      : (!deps.stickerStoreWritable && (url.pathname === '/api/stickers/sync'
        || url.pathname === '/api/stickers/note' || url.pathname === '/api/stickers/dedupe'
        || url.pathname === '/api/stickers/remark'
        || url.pathname === '/api/socialV2/sticker-note'
        || url.pathname === '/api/socialV2/sticker-remark'
        || url.pathname === '/api/socialV2/collect-sticker')) ? '表情库'
        : '';
    if (readonlyStore) {
      sendJson({ ok: false, error: `${readonlyStore}处于只读降级状态（启动时加载失败，未覆盖原文件），本次修改不会落盘；请修复 state/ 下的对应文件后重启桥接` }, 503);
      return true;
    }
  }
  return false;
}

// 从 server 回调提取：路由分派第一段（operations / roles / role-draft / presets / slang / session-admin）。
// 逻辑逐字等价，只把 return 改成 return true（已响应信号）、段尾 return false（未命中，继续下一段）。
async function dispatchRoutesA(deps, req, url, consoleRequest) {
  // @bridge-routes handleConsoleOperations
  if (
    // 这份名单是「进 handleConsoleOperations 的门」：漏掉的路径到不了那边的页面/接口分派表
    // （/client 曾因此回 404）。加页/加接口必须两边一起加，scripts/test-client-ui.mjs 会核对。
    (req.method === 'GET' && ['/', '/ops', '/client', '/client.html', '/client.css', '/client.js', '/changelog.js', '/bgm/default-tune.mp3', '/bgm/haloflux-sw421k.mp3', '/bgm/HALOFLUX-LICENSE.txt'].includes(url.pathname)) ||
    (req.method === 'GET' && (url.pathname === '/library' || url.pathname === '/library.html')) ||
    (['POST', 'GET'].includes(req.method) && url.pathname === '/api/config/reload') ||
    (url.pathname === '/api/peak/status') ||
    (req.method === 'POST' && url.pathname === '/api/peak/toggle') ||
    (req.method === 'GET' && url.pathname === '/api/debug/budget') || url.pathname.startsWith('/api/self-check') ||
    (req.method === 'GET' && url.pathname === '/api/debug/prompt-parts') ||
    (req.method === 'GET' && url.pathname === '/api/ops/services') ||
    (req.method === 'POST' && url.pathname === '/api/ops/action') ||
    (req.method === 'GET' && url.pathname === '/api/ops/status') ||
    (req.method === 'GET' && (url.pathname === '/api/status' || url.pathname === '/api/version')) ||
    (req.method === 'GET' && url.pathname === '/api/presets')
  ) {
    if (await (0, deps.handleConsoleOperations)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleOperations:end
  // @bridge-routes handleConsoleRoles
  if (
    (req.method === 'POST' && url.pathname === '/api/mode') ||
    (req.method === 'POST' && url.pathname === '/api/role') ||
    (req.method === 'POST' && url.pathname === '/api/role-mode') ||
    (req.method === 'GET' && url.pathname === '/api/roles') ||
    (req.method === 'GET' && url.pathname === '/api/roles/content') ||
    (req.method === 'POST' && url.pathname === '/api/roles/limit') ||
    (req.method === 'POST' && url.pathname === '/api/roles/create') ||
    (req.method === 'POST' && url.pathname === '/api/roles/update') ||
    (req.method === 'POST' && url.pathname === '/api/roles/rename') ||
    (req.method === 'POST' && url.pathname === '/api/roles/delete')
  ) {
    if (await (0, deps.handleConsoleRoles)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleRoles:end
  // @bridge-routes handleConsoleRoleDraft
  if (req.method === 'POST' && url.pathname === '/api/roles/generate') {
    if (await (0, deps.handleConsoleRoleDraft)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleRoleDraft:end
  // @bridge-routes handleConsolePresets
  if (
    (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt') ||
    (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt') ||
    (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt/backups') ||
    (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt/restore')
  ) {
    if (await (0, deps.handleConsolePresets)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsolePresets:end
  // @bridge-routes handleConsoleSlang
  if (
    (req.method === 'GET' && (url.pathname === '/api/slang' || url.pathname === '/api/slang/preselect')) ||
    (req.method === 'POST' && url.pathname === '/api/slang/policy') ||
    (req.method === 'POST' && url.pathname === '/api/slang') ||
    (req.method === 'POST' && url.pathname === '/api/slang/clear') ||
    (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') ||
    (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') ||
    (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') ||
    (req.method === 'PATCH' && (url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/)) && !(url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/))[2]) ||
    (req.method === 'POST' && (url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/)) && (url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/))[2] === 'confirm') ||
    (req.method === 'POST' && (url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/)) && (url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/))[2] === 'reject') ||
    (req.method === 'DELETE' && (url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/)) && !(url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/))[2])
  ) {
    if (await (0, deps.handleConsoleSlang)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleSlang:end
  // @bridge-routes handleConsoleSessionAdmin
  if (
    (req.method === 'POST' && url.pathname === '/api/slang/extract') ||
    (req.method === 'POST' && url.pathname === '/api/slang/research') ||
    (req.method === 'POST' && url.pathname === '/api/slang/config') ||
    (req.method === 'GET' && url.pathname === '/api/sessions') ||
    (req.method === 'GET' && url.pathname === '/api/pending') ||
    (req.method === 'GET' && url.pathname === '/api/whitelist') ||
    (req.method === 'POST' && url.pathname === '/api/whitelist') ||
    (req.method === 'GET' && url.pathname === '/api/dsh/model')
  ) {
    if (await (0, deps.handleConsoleSessionAdmin)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleSessionAdmin:end
  return false;
}

// 路由分派第二段（file-library / security-social / social-config / lists / budget / tokens / sticker-cache / memewiki / image-memory / sticker-thumbs / library 全系列）。
async function dispatchRoutesB(deps, req, url, consoleRequest) {
  // @bridge-routes handleConsoleFileLibrary
  if (
    (req.method === 'GET' && url.pathname === '/api/dsh/models') ||
    (req.method === 'POST' && url.pathname === '/api/dsh/effort') ||
    (req.method === 'GET' && url.pathname === '/api/observe/config') ||
    (req.method === 'GET' && url.pathname === '/api/storage/stats') ||
    (req.method === 'GET' && url.pathname === '/api/files') ||
    (req.method === 'GET' && url.pathname === '/api/library/items') ||
    (req.method === 'GET' && url.pathname.startsWith('/api/library/item/')) ||
    (req.method === 'GET' && url.pathname === '/api/library/unclassified') ||
    (req.method === 'GET' && url.pathname === '/api/library/item-thumb') ||
    (req.method === 'GET' && url.pathname === '/api/files/lists') ||
    (req.method === 'GET' && url.pathname === '/api/files/notify') ||
    (req.method === 'GET' && url.pathname === '/api/files/item') ||
    (req.method === 'GET' && url.pathname === '/api/files/thumb') ||
    (req.method === 'GET' && url.pathname === '/api/files/meta') ||
    (req.method === 'POST' && url.pathname === '/api/files/enrich') ||
    (req.method === 'GET' && url.pathname.startsWith('/api/files/cover/')) ||
    (req.method === 'GET' && url.pathname.startsWith('/api/files/booth/')) ||
    (req.method === 'GET' && url.pathname === '/api/files/export') ||
    (req.method === 'GET' && url.pathname === '/api/observe/config') ||
    (req.method === 'GET' && url.pathname === '/api/files/stats') ||
    (req.method === 'POST' && url.pathname === '/api/files/cleanup') ||
    (url.pathname === '/api/file-library/archive-rules') || (req.method === 'GET' && url.pathname === '/api/files/folders') || (req.method === 'POST' && url.pathname === '/api/files/open-folder') || (req.method === 'POST' && url.pathname === '/api/files/category') || (req.method === 'GET' && (url.pathname === '/api/library/assets' || url.pathname === '/api/library/cover')) || (req.method === 'GET' && (url.pathname === '/api/library/facets' || url.pathname === '/api/library/favorites')) || (req.method === 'POST' && url.pathname === '/api/library/favorite') || (url.pathname === '/api/library/manual-meta') || (req.method === 'GET' && url.pathname === '/api/files/raw') || (req.method === 'POST' && (url.pathname === '/api/library/asset/cover' || url.pathname === '/api/library/asset/note')) || (url.pathname === '/api/library/merges') || (url.pathname === '/api/library/alias-rules') || (req.method === 'GET' && (url.pathname === '/api/library/reconcile' || url.pathname === '/api/library/archive-info' || url.pathname === '/api/library/duplicates' || url.pathname === '/api/library/purchase-detail')) || (req.method === 'GET' && url.pathname === '/api/library/asset') || (req.method === 'POST' && (url.pathname === '/api/library/merge' || url.pathname === '/api/library/merge/split')) || (url.pathname === '/api/library/reconcile/sync' || url.pathname === '/api/library/reconcile/bind' || url.pathname === '/api/library/reconcile/download' || url.pathname === '/api/library/reconcile/download-all' || url.pathname === '/api/library/reconcile/forget' || url.pathname === '/api/library/purchases/bind' || url.pathname === '/api/library/purchases/forget' || (req.method === 'GET' && url.pathname === '/api/library/bind-suggestions') || (req.method === 'POST' && url.pathname === '/api/library/bind-suggestion/accept'))
  ) {
    if (await (0, deps.handleConsoleFileLibrary)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleFileLibrary:end
  // @bridge-routes handleConsoleSecuritySocial
  if (
    (req.method === 'GET' && url.pathname === '/api/security') ||
    (req.method === 'POST' && url.pathname === '/api/security') ||
    (req.method === 'POST' && url.pathname === '/api/console/token') ||
    (req.method === 'POST' && url.pathname === '/api/test-send') ||
    (req.method === 'POST' && url.pathname === '/api/social/state') ||
    (req.method === 'GET' && url.pathname === '/api/social') ||
    (req.method === 'POST' && url.pathname === '/api/social') ||
    (req.method === 'POST' && url.pathname === '/api/social/flush') ||
    (req.method === 'POST' && url.pathname === '/api/console/notify-ai')
  ) {
    if (await (0, deps.handleConsoleSecuritySocial)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleSecuritySocial:end
  // @bridge-routes handleConsoleSocialConfig
  if (
    (req.method === 'GET' && url.pathname === '/api/socialV2/config') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/config') ||
    (req.method === 'GET' && url.pathname === '/api/socialV2/activity') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/activity') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/reset') ||
    (req.method === 'GET' && url.pathname === '/api/socialV2/private-quota')
  ) {
    if (await (0, deps.handleConsoleSocialConfig)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleSocialConfig:end
  // @bridge-routes handleConsoleLists
  if (url.pathname === '/api/lists' || url.pathname.startsWith('/api/lists/')) { if (await (0, deps.handleConsoleLists)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLists:end
  // @bridge-routes handleConsoleBudgetAlert
  if (url.pathname === '/api/budget/alert' || url.pathname === '/api/budget/alert/test') { if (await (0, deps.handleConsoleBudgetAlert)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleBudgetAlert:end
  // @bridge-routes handleTokensTools
  if (url.pathname === '/api/tokens/tools' || url.pathname === '/api/tokens/tools/rebuild') { if (await (0, deps.handleTokensTools)(consoleRequest)) return true; }
  // @bridge-routes handleTokensTools:end
  // @bridge-routes handleStickerCacheStatus
  if (url.pathname === '/api/stickers/cache') { if (await (0, deps.handleStickerCacheStatus)(consoleRequest)) return true; }
  // @bridge-routes handleStickerCacheStatus:end
  // @bridge-routes handleStickerCacheCleanup
  if (url.pathname === '/api/stickers/cache/cleanup') { if (await (0, deps.handleStickerCacheCleanup)(consoleRequest)) return true; }
  if (url.pathname === '/api/memewiki/status') { if (await (0, deps.handleMemewikiStatus)(consoleRequest)) return true; }
  if (url.pathname === '/api/memewiki/reimport') { if (await (0, deps.handleMemewikiReimport)(consoleRequest)) return true; }
  if (url.pathname === '/api/image-memory/status') { if (await (0, deps.handleImageMemoryStatus)(consoleRequest)) return true; }
  if (url.pathname === '/api/image-memory/backfill') { if (await (0, deps.handleImageMemoryBackfill)(consoleRequest)) return true; }
  if (url.pathname === '/api/image-memory/backfill/stop') { if (await (0, deps.handleImageMemoryStop)(consoleRequest)) return true; }
  // @bridge-routes handleStickerCacheCleanup:end
  // @bridge-routes handleStickerThumbsRepair
  if (url.pathname === '/api/stickers/thumbs/repair') { if (await (0, deps.handleStickerThumbsRepair)(consoleRequest)) return true; }
  // 删除「链接已失效」的不可用表情（死数据，留着只会污染列表和提示词）。
  // @bridge-routes handleStickerUnavailableRemove
  if (url.pathname === '/api/stickers/unavailable/remove') { if (await (0, deps.handleStickerUnavailableRemove)(consoleRequest)) return true; }
  // @bridge-routes handleStickerUnavailableRemove:end
  // @bridge-routes handleStickerThumbsRepair:end
  // @bridge-routes handleConsoleLibraryFind
  if (url.pathname === '/api/library/find' || url.pathname === '/api/library/binds' || url.pathname === '/api/library/bind' || url.pathname === '/api/library/unbind' || url.pathname === '/api/library/batchfind' || url.pathname === '/api/library/batchfind/stop' || url.pathname === '/api/library/batchfind/clear' || url.pathname === '/api/library/search-pause' || url.pathname === '/api/library/rename' || url.pathname === '/api/library/rename/preview' || url.pathname === '/api/library/rename/undo') { if (await (0, deps.handleConsoleLibraryFind)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLibraryFind:end
  // @bridge-routes handleConsoleLibraryBindIo
  if (url.pathname === '/api/library/binds/export' || url.pathname === '/api/library/binds/import') { if (await (0, deps.handleConsoleLibraryBindIo)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLibraryBindIo:end
  // @bridge-routes handleConsoleLibraryFindByImage
  if (url.pathname === '/api/library/find-by-image') { if (await (0, deps.handleConsoleLibraryFindByImage)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLibraryFindByImage:end
  // @bridge-routes handleConsoleLibraryDownload
  // 下载后解压（手动 / 下载完自动走同一实现）：路由块固定 3 行。
  // @bridge-routes handleConsoleLibraryExtract
  if (url.pathname === '/api/library/extract' || url.pathname === '/api/library/extract/status') { if (await (0, deps.handleConsoleLibraryExtract)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLibraryExtract:end
  // 解压密码本：GET 列表 / POST 记住 / POST 删除，明文一律不回（只给掩码）。
  // @bridge-routes handleConsoleLibraryPasswords
  if (url.pathname === '/api/library/passwords' || url.pathname === '/api/library/passwords/remove') { if (await (0, deps.handleConsoleLibraryPasswords)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLibraryPasswords:end
  // @bridge-routes handleConsoleLibraryPurchaseFiles
  if (url.pathname === '/api/library/purchase-files') { if (await (0, deps.handleConsoleLibraryPurchaseFiles)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLibraryPurchaseFiles:end
  // @bridge-routes handleConsoleLibraryImport
  if (url.pathname === '/api/library/import-to-unity') { if (await (0, deps.handleConsoleLibraryImport)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLibraryImport:end
  if (url.pathname === '/api/library/booth-cookie' || url.pathname === '/api/library/booth-cookie/remove' || url.pathname === '/api/library/booth-cookie/current' || url.pathname === '/api/library/owned' || url.pathname === '/api/library/download' || url.pathname === '/api/library/download/status' || url.pathname === '/api/library/download/retry' || url.pathname === '/api/library/download/clear' || url.pathname === '/api/library/downloads' || url.pathname === '/api/library/downloads/pause' || url.pathname === '/api/library/downloads/resume' || url.pathname === '/api/library/purchases/download') { if (await (0, deps.handleConsoleLibraryDownload)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLibraryDownload:end
  // @bridge-routes handleConsoleLibraryCovers
  if (url.pathname === '/api/library/covers' || url.pathname === '/api/library/covers/backfill' || url.pathname === '/api/library/covers/stop') { if (await (0, deps.handleConsoleLibraryCovers)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLibraryCovers:end
  // @bridge-routes handleConsoleLibraryUsage
  if (url.pathname === '/api/library/usage' || url.pathname === '/api/library/usage/scan' || url.pathname === '/api/library/usage/stop') { if (await (0, deps.handleConsoleLibraryUsage)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLibraryUsage:end
  // @bridge-routes handleConsoleLibraryTrash
  if (url.pathname === '/api/library/trash' || url.pathname === '/api/library/trash/restore' || url.pathname === '/api/library/trash/purge' || url.pathname === '/api/library/trash/storage' || url.pathname === '/api/library/trash/cleanup') { if (await (0, deps.handleConsoleLibraryTrash)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLibraryTrash:end
  // @bridge-routes handleConsoleLibraryBatch
  if (url.pathname === '/api/library/batch') { if (await (0, deps.handleConsoleLibraryBatch)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLibraryBatch:end
  // @bridge-routes handleConsoleLibraryRelocate
  if (url.pathname === '/api/library/relocate' || url.pathname === '/api/library/relocate/undo') { if (await (0, deps.handleConsoleLibraryRelocate)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLibraryRelocate:end
  // @bridge-routes handleConsoleLibraryPurchases
  if (url.pathname === '/api/library/purchases' || url.pathname === '/api/library/purchases/resolve' || url.pathname === '/api/library/purchases/import' || url.pathname === '/api/library/purchases/refresh' || url.pathname === '/api/library/purchases/remove' || url.pathname === '/api/library/purchases/ocr' || url.pathname === '/api/library/purchases/ocr/status' || url.pathname === '/api/library/purchases/cover') { if (await (0, deps.handleConsoleLibraryPurchases)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLibraryPurchases:end
  // @bridge-routes handleConsoleLibraryPurchasesSync
  if (url.pathname === '/api/library/purchases/sync' || url.pathname === '/api/library/purchases/sync/status') { if (await (0, deps.handleConsoleLibraryPurchasesSync)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLibraryPurchasesSync:end
  // @bridge-routes handleConsoleLibraryCollections
  if (url.pathname === '/api/library/collections' || url.pathname === '/api/library/collections/update' || url.pathname === '/api/library/collections/remove' || url.pathname === '/api/library/collections/members') { if (await (0, deps.handleConsoleLibraryCollections)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLibraryCollections:end
  // @bridge-routes handleConsoleBoothLogin
  if (url.pathname === '/api/library/purchases/login/start' || url.pathname === '/api/library/purchases/login/status' || url.pathname === '/api/library/purchases/login/stop') { if (await (0, deps.handleConsoleBoothLogin)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleBoothLogin:end
  return false;
}

// 路由分派第三段（open-url / guest / ai-blacklist / social-reads / affinity / wake / conversation-send / media-tools / draw / stickers-voices / wait / journal / message-detail / memory / slang-tools / send-reset / config-admin / tools-gate / agent-probe / local-model）。
async function dispatchRoutesC(deps, req, url, consoleRequest) {
  // @bridge-routes handleConsoleOpenUrl
  if (req.method === 'POST' && (url.pathname === '/api/open-url' || url.pathname === '/api/open-folder')) { if (await (0, deps.handleConsoleOpenUrl)(consoleRequest) || await (0, deps.handleConsoleOpenFolder)(consoleRequest)) return true; } if (url.pathname === '/api/desktop-client/status') { if (await (0, deps.handleConsoleDesktopClientStatus)(consoleRequest)) return true; } if (url.pathname === '/api/desktop-client/check') { if (await (0, deps.handleConsoleDesktopClientCheck)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleOpenUrl:end
  // @bridge-routes handleConsoleGuestAccess
  if (req.method === 'GET' && url.pathname === '/api/console/guest') { if (await (0, deps.handleConsoleGuestAccess)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleGuestAccess:end
  // @bridge-routes handleConsoleAiBlacklist
  if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/socialV2/ai-blacklist') {
    if (await (0, deps.handleConsoleAiBlacklist)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleAiBlacklist:end
  // @bridge-routes handleConsoleSocialReads
  if (
    (req.method === 'GET' && (url.pathname === '/api/socialV2/state' || url.pathname === '/api/socialV2/media-cache')) ||
    (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') ||
    (req.method === 'GET' && url.pathname === '/api/socialV2/unread') ||
    (req.method === 'GET' && url.pathname === '/api/socialV2/recent') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/recall')
  ) {
    if (await (0, deps.handleConsoleSocialReads)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleSocialReads:end
  // @bridge-routes handleConsoleModelsAffinity
  if (
    (req.method === 'GET' && url.pathname === '/api/affinity') ||
    (req.method === 'POST' && url.pathname === '/api/affinity/shift') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/self-model') ||
    (url.pathname === '/api/model-routing') || (url.pathname === '/api/imagegen/providers') ||
    (req.method === 'GET' && url.pathname === '/api/models') ||
    (url.pathname === '/api/model' || (req.method === 'POST' && url.pathname === '/api/dsh/model'))
  ) {
    if (await (0, deps.handleConsoleModelsAffinity)(consoleRequest) || await (0, deps.handleConsoleImagegen)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleModelsAffinity:end
  // @bridge-routes handleConsoleWakeControls
  if (
    (req.method === 'POST' && url.pathname === '/api/socialV2/search-history') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') ||
    (req.method === 'GET' && url.pathname === '/api/socialV2/states') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/wake')
  ) {
    if (await (0, deps.handleConsoleWakeControls)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleWakeControls:end
  // @bridge-routes handleConsoleConversationSend
  if (
    (url.pathname === '/api/socialV2/initial-prompt' && (req.method === 'GET' || req.method === 'POST')) ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') ||
    (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') ||
    (req.method === 'GET' && url.pathname === '/api/socialV2/self-image')
  ) {
    if (await (0, deps.handleConsoleConversationSend)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleConversationSend:end
  // @bridge-routes handleConsoleMediaTools
  if (
    (req.method === 'GET' && url.pathname === '/api/stickers/thumbnail') ||
    (req.method === 'POST' && url.pathname === '/api/stickers/remove') ||
    (req.method === 'POST' && url.pathname === '/api/stickers/repair') ||
    (req.method === 'POST' && url.pathname === '/api/stickers/policy') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') ||
    (req.method === 'POST' && (url.pathname === '/api/voice/send' || url.pathname === '/api/send/voice')) ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/tts') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/send-voice') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/send-image')
  ) {
    if (await (0, deps.handleConsoleMediaTools)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleMediaTools:end
  // @bridge-routes handleConsoleDraw
  if (req.method === 'POST' && url.pathname === '/api/socialV2/draw') { if (await (0, deps.handleConsoleDraw)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleDraw:end
  // @bridge-routes handleConsoleStickersVoices
  if (
    (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') ||
    (req.method === 'GET' && (url.pathname === '/api/socialV2/voices' || url.pathname === '/api/voice/list')) ||
    (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-list') ||
    (req.method === 'GET' && url.pathname === '/api/stickers') ||
    (req.method === 'POST' && url.pathname === '/api/stickers/sync') ||
    (req.method === 'POST' && url.pathname === '/api/stickers/note') ||
    (req.method === 'POST' && url.pathname === '/api/stickers/remark') || (req.method === 'POST' && url.pathname === '/api/stickers/dedupe')
  ) {
    if (await (0, deps.handleConsoleStickersVoices)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleStickersVoices:end
  // @bridge-routes handleConsoleWait
  if (
    (req.method === 'POST' && url.pathname === '/api/socialV2/wait') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/check-send')
  ) {
    if (await (0, deps.handleConsoleWait)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleWait:end
  // @bridge-routes handleConsoleJournal
  if (
    (url.pathname === '/api/tokens/summary' || url.pathname.startsWith('/api/tokens/')) ||
    (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') ||
    (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') ||
    (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent')
  ) {
    if (await (0, deps.handleConsoleJournal)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleJournal:end
  // @bridge-routes handleConsoleMessageDetail
  if (
    (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') ||
    (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') ||
    (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') ||
    (req.method === 'GET' && url.pathname === '/api/socialV2/group-members') || (url.pathname === '/api/member-notes')
  ) {
    if (await (0, url.pathname === '/api/member-notes' ? deps.handleConsoleMemberNotes : deps.handleConsoleMessageDetail)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleMessageDetail:end
  // @bridge-routes handleConsoleMemory
  if (
    (req.method === 'GET' && (url.pathname === '/api/memory/overview' || url.pathname === '/api/impressions')) ||
    (req.method === 'POST' && (url.pathname === '/api/socialV2/memory-append' || url.pathname === '/api/impressions/rebuild')) ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/set-persona') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') ||
    (req.method === 'GET' && url.pathname === '/api/socialV2/memory') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') ||
    (url.pathname === '/api/socialV2/memory-event') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear')
  ) {
    if (await (0, deps.handleConsoleMemory)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleMemory:end
  // @bridge-routes handleConsoleSlangTools
  if (
    (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') ||
    (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit')
  ) {
    if (await (0, deps.handleConsoleSlangTools)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleSlangTools:end
  // @bridge-routes handleConsoleSendReset
  if (
    (req.method === 'POST' && url.pathname === '/api/authorize/read') ||
    (req.method === 'GET' && url.pathname === '/api/images/message') ||
    (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) ||
    (req.method === 'POST' && url.pathname === '/api/session/reset') ||
    (req.method === 'POST' && url.pathname === '/api/workspace/reset') ||
    (req.method === 'POST' && url.pathname === '/api/restart')
  ) {
    if (await (0, deps.handleConsoleSendReset)(consoleRequest)) return true;
  }
  // @bridge-routes handleConsoleSendReset:end
  // @bridge-routes handleConsoleConfigAdmin
  if ((req.method === 'GET' || req.method === 'POST') && (url.pathname === '/api/config' || url.pathname === '/api/setup' || url.pathname === '/api/autostart')) { if (await (0, deps.handleConsoleConfigAdmin)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleConfigAdmin:end
  // @bridge-routes handleConsoleToolsGate
  if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/tools/gate') { if (await (0, deps.handleConsoleToolsGate)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleToolsGate:end
  // @bridge-routes handleConsoleAgentProbe
  if (req.method === 'POST' && url.pathname === '/api/agent/probe') { if (await (0, deps.handleConsoleAgentProbe)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleAgentProbe:end
  // @bridge-routes handleConsoleLocalModel
  if ((req.method === 'GET' && url.pathname === '/api/local-model/status') || (req.method === 'POST' && url.pathname === '/api/local-model/apply')) { if (await (0, deps.handleConsoleLocalModel)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLocalModel:end
  // @bridge-routes handleConsoleLocalModelRestart
  if (req.method === 'POST' && url.pathname === '/api/local-model/restart-bridge') { if (await (0, deps.handleConsoleLocalModelRestart)(consoleRequest)) return true; }
  // @bridge-routes handleConsoleLocalModelRestart:end
  return false;
}

async function dispatchConsoleRoutes(deps, req, url, consoleRequest, sendJson) {
  if (await dispatchRoutesA(deps, req, url, consoleRequest)) return true;
  if (await dispatchRoutesB(deps, req, url, consoleRequest)) return true;
  if (await dispatchRoutesC(deps, req, url, consoleRequest)) return true;
  sendJson({ ok: false, error: 'not found' }, 404);
  return true;
}

export function createConsoleServer(deps) {
// @bridge-function startConsoleServer:start
function startConsoleServer() {
    const port = deps.cfg.consolePort ?? 3100;
    // 控制台鉴权：优先用 config.consoleToken，未配置则自动生成并持久化，不再默认无鉴权。
    // 使用 let 以便控制台内手动修改令牌后热更新。
    const configuredToken = String(deps.cfg.consoleToken ?? '').trim();
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
    let consoleToken = tokenValid ? configuredToken : (0, deps.loadOrCreateConsoleToken)();
    // 只读访客令牌（L6）：和 console-token 一样自动生成并持久化；配置里显式给就先用配置。
    const configuredGuest = String(deps.cfg?.consoleGuestToken ?? '').trim();
    let guestToken = /^[A-Za-z0-9_-]{24,}$/.test(configuredGuest) ? configuredGuest : (0, deps.loadOrCreateGuestToken)();
    // 令牌必须非空才继续（失败关闭）：原写法「令牌为空 ⇒ 放行」会让改配置/发消息/读记录的接口
    // 完全免鉴权，而 Host 白名单只挡跨机访问、挡不住本机进程；写盘异常被吞时也宁可启动报错，
    // 不要静默开着一个无鉴权的管理 API。
    if (!consoleToken) throw new Error('控制台令牌为空：拒绝以无鉴权方式启动控制台 API');
    if (!tokenValid && configuredToken) (0, deps.log)(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    if (!configuredToken) (0, deps.log)(`控制台未配置 consoleToken，已自动生成：${String(consoleToken).slice(0, 6)}…（完整值保存在 state/console-token）`);
    // 二代会话级隔离：MCP 工具调用时若带 x-agent-token，则必须匹配该会话的 agentToken。
    // 控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
    // 定长比较：会话令牌也是凭据，`===` 会短路、可被时延试探，故与控制台令牌同用 timingSafeEqual。
    const tokenEq = (a, b) => {
      if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
      const x = Buffer.from(a, 'utf8');
      const y = Buffer.from(b, 'utf8');
      return x.length === y.length && deps.crypto.timingSafeEqual(x, y);
    };
    const agentTokenOk = (key, token) => {
      const canonical = (0, deps.canonicalV2Key)(key);
      const st = deps.socialV2.conversations.get(canonical ?? key);
      return !!st && !!st.agentToken && tokenEq(token, st.agentToken);
    };
    /**
     * 令牌是否匹配**任意**一个活跃二代会话。
     *
     * 用途是集中式纵深防御（见下方 x-agent-call 关卡）：各端点自己那套
     * `if (x-agent-token && !agentTokenOk(key, token))` 把关的是「这个令牌能不能动这个
     * 会话」；这里把关的是「这到底是不是一次智能体调用」。两层都需要，因为前者在
     * 端点漏写时会整个失效。
     */
    const isLiveAgentToken = (token) => {
      if (typeof token !== 'string' || !token) return false;
      for (const st of deps.socialV2.conversations.values()) {
        if (st?.agentToken && tokenEq(token, st.agentToken)) return true;
      }
      return false;
    };
    // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
    const v2SessionAllowed = deps.isSessionAllowedInCurrentMode;
    const server = deps.http.createServer(async (req, res) => {
      let url;
      try { url = new deps.URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
        res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
        return;
      }
      const SECURITY_HEADERS = {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http://gchat.qpic.cn http://*.qpic.cn https://tjc-download.ftn.qq.com; media-src 'self' blob: data:", // img-src 放行 data:：品牌图标内嵌进 HTML，不为一张 6KB 图新增静态路由；图床白名单只放 QQ 的（会话里直接显示聊天图片，不代理不自建静态路由）；http://gchat.qpic.cn 必须留着——老消息存的就是 http 地址，收紧成 https-only 会让它们全变破图；同文件函数行数被 code-size 闸冻结，别把它拆成两行
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      };
      const sendJson = (obj, status = 200) => {
        // 客户端提前断开（切页、刷新、面板重启）时，错误分支可能还想再写一次头；
        // 那时 res 已经发过响应，writeHead 会抛 ERR_HTTP_HEADERS_SENT 把整个桥接带崩。
        if (res.headersSent || res.writableEnded) return;
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        res.end(JSON.stringify(obj, null, 2));
      };
      // 默认 1MB；OCR 这类要传截图的接口显式传 maxBytes（8MB 图的 base64 约 11MB）。
      const readBody = (options = {}) => new Promise((resolve, reject) => {
        const MAX_BODY_BYTES = (options && Number(options.maxBytes)) || 1_000_000;
        const LIMIT_TEXT = `超过 ${Math.max(1, Math.round(MAX_BODY_BYTES / 1048576))}MB`;
        const chunks = [];
        let total = 0;
        let settled = false;
        let bodyTimer = null;
        const fail = (status, message) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) (0, deps.clearTimeout)(bodyTimer);
          const err = new Error(message);
          err.statusCode = status;
          reject(err);
        };
        const done = (val) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) (0, deps.clearTimeout)(bodyTimer);
          resolve(val);
        };
        // 提前按 Content-Length 拒绝超限请求体
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          fail(413, `请求体过大（${LIMIT_TEXT}）`);
          return;
        }
        bodyTimer = (0, deps.setTimeout)(() => fail(400, '请求体读取超时'), 30000);
        req.on('data', (c) => {
          if (settled) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += buf.length;
          if (total > MAX_BODY_BYTES) {
            req.pause();
            fail(413, `请求体过大（${LIMIT_TEXT}）`);
            return;
          }
          chunks.push(buf);
        });
        req.on('end', () => {
          if (settled) return;
          const raw = Buffer.concat(chunks);
          let data;
          try { data = decodeRequestBody(raw, url.pathname, deps.log); }
          catch (err) { fail(400, err.message); return; }
          if (!data.trim()) { done({}); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fail(400, '请求体必须是 JSON 对象');
            return;
          }
          done(parsed);
        });
        // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
        req.on('error', () => fail(400, '请求体读取失败'));
        req.on('aborted', () => fail(400, '请求体读取中断'));
      });
      // 浏览器会自动请求 /favicon.ico 且不带令牌：任何鉴权之前直接 204 收掉，免得每次打开控制台都在 DevTools 留 401 噪音。
      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')) {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }
      // Host 头校验（DNS rebinding 硬化）：控制台只监听 127.0.0.1，合法 Host 只可能是本机回环名+本端口；
      // 卡住这一层后，TTL=0 域名解析到 127.0.0.1 的请求在进业务分支前就被拒。反代/端口转发一并拒绝（有意）。
      // 用**实际绑定端口**而不是配置值（测试夹具 consolePort:0 由系统分配）：请求必然发生在 listen 之后。
      const hostHeader = String(req.headers.host ?? '');
      const boundPort = server.address()?.port ?? port;
      const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
      if (!allowedHosts.includes(hostHeader.toLowerCase())) {
        sendJson({ ok: false, error: `Host 头不被允许（${hostHeader || '缺失'}）：控制台只接受本机回环访问` }, 403);
        return;
      }
      // 控制台鉴权：三种来源按序取 —— ?token=（首次链接）、x-console-token（页面脚本）、
      // Cookie（刷新后免再输入）。定长比较避免时延逐字节试探（只监听回环，属纵深防御）。
      const suppliedToken = String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? cookieOf(req));
      const tokenMatches = (() => {
        if (!consoleToken) return false; // 上面已拒绝空令牌；真出现也只许失败关闭，绝不 return true
        const a = Buffer.from(suppliedToken, 'utf8');
        const b = Buffer.from(consoleToken, 'utf8');
        if (a.length !== b.length) return false;
        return deps.crypto.timingSafeEqual(a, b);
      })();
      // 只读访客（L6）：第二套令牌，只能看素材库那几条 GET。管理员令牌优先（判定见模块级 roleOf）。
      const role = tokenMatches ? 'admin' : roleOf(req, url, guestToken, deps.crypto);
      if (tokenMatches) plantConsoleCookie(res, consoleToken);
      if (consoleToken && !role && !(req.method === 'GET' && (NO_TOKEN_GET_PATHS.has(url.pathname)))) {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          res.end('<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>');
        } else {
          sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
        }
        return;
      }
      // 访客只读：白名单之外的路径一律拒绝（写操作自然全在里面）；页面壳子与静态资源放行
      // （否则访客连 /client 都打不开，拿到的是一片 403 JSON —— 壳子不含数据）。
      if (role === 'guest' && !guestShellPath(req, url.pathname) && !(deps.consoleGuestPure?.guestAllowed?.(req.method, url.pathname))) {
        sendJson({ ok: false, error: '只读访客：这个操作需要管理员令牌', guest: true, path: url.pathname }, 403);
        return;
      }
      // 智能体调用隔离（集中关卡）：控制台令牌是「管理端全权」，会话令牌是「只能动自己这个会话」，
      // MCP 工具进程两者都持有 —— 「这次请求是智能体还是管理端发的」必须由请求自己声明。
      //
      // 旧写法是各端点自己 `if (x-agent-token && !agentTokenOk(...))` 做会话绑定校验，但头缺失时
      // 整条跳过；而头缺失恰恰是模型没传 token 时的自然结果（旧版 mcp-snowluma-safe.js 用
      // `...(token ? {...} : {})` 直接省略这个头）。于是「漏传令牌」不是被拒绝，而是**升级成控制台
      // 全权**：典型的 confused deputy。现在 MCP 端一律带 x-agent-call: 1；带了令牌就必须命中某个
      // 活跃会话，端点自己漏写校验也不会退回管理端。
      //
      // 但「没带令牌」的智能体调用不能一律拒绝：closed-agent（管理员私聊）模式下模型**没有**
      // 会话令牌（令牌只在 reserved2 的唤醒提示里下发），而 qq_send_group_message / qq_list_groups
      // 等工具必须在该模式可用（工具描述写的也是"closed-agent 模式不需要"）。所以无令牌调用只放行
      // /api/status、/api/send/*、/api/images/* 这条非 v2 会话面；整个 /api/socialV2/ 前缀一概不放
      // ——那里全是 `if (x-agent-token && …)` 校验，放进来就退化成管理端全权（confused deputy）。
      if (req.headers['x-agent-call'] !== undefined) {
        const agentToken = req.headers['x-agent-token'];
        const hasToken = typeof agentToken === 'string' && agentToken !== '';
        if (hasToken && !isLiveAgentToken(agentToken)) {
          sendJson({ ok: false, error: '未授权：智能体调用携带的会话令牌无效' }, 403);
          return;
        }
        if (!hasToken) {
          const tokenlessAgentAllowed = url.pathname === '/api/status'
            || url.pathname.startsWith('/api/send/')
            || url.pathname.startsWith('/api/images/');
          if (!tokenlessAgentAllowed) {
            sendJson({ ok: false, error: '未授权：该接口的智能体调用必须携带有效的会话令牌' }, 403);
            return;
          }
        }
      }
      // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
      // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
      // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
      if (req.method !== 'GET') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!ctype.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers['origin'];
        if (origin) {
          let originHost = '';
          try { originHost = new deps.URL(String(origin)).host; } catch {}
          if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(originHost)) {
            sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        }
      }
      const consoleRequest = { get method(){ return req.method; }, get SECURITY_HEADERS(){ return SECURITY_HEADERS; }, get agentTokenOk(){ return agentTokenOk; }, get boundPort(){ return boundPort; }, get consoleToken(){ return consoleToken; }, set consoleToken(value){ consoleToken=value; }, get guestToken(){ return guestToken; }, get consoleRole(){ return role; }, get consoleGuestPure(){ return deps.consoleGuestPure; }, get readBody(){ return readBody; }, get req(){ return req; }, get res(){ return res; }, get sendJson(){ return sendJson; }, get url(){ return url; }, get v2SessionAllowed(){ return v2SessionAllowed; } };
      try {
        if (await guardConsoleRequest(deps, req, url, sendJson)) return;
        if (await dispatchConsoleRoutes(deps, req, url, consoleRequest, sendJson)) return;
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      (0, deps.log)(`本地控制台已启动：http://127.0.0.1:${port}`);
    });
    // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
    server.on('error', (error) => {
      (0, deps.log)(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        deps.console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      process.exit(1);
    });
    return server;
  }
// @bridge-function startConsoleServer:end
  return { startConsoleServer };
}
