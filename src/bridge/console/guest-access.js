// 只读访客（BOOTH 素材库 L6）的管理端接口：给设置页拿「访客链接」。
// 为什么要单独一个模块：`scripts/test-client-ui.mjs` 要求客户端用到的每个 /api/ 路径都必须在
// src/bridge/console/*.js 里有真实路由；而鉴权与角色判定留在 console-server（请求入口）。
// 这里只负责「管理员看访客令牌」这一件事。
//
// 约束（同其它桥接模块）：被 vm.runInContext 裸执行，不能 import；令牌与规则由 deps 注入。

// @bridge-function handleConsoleGuestAccess:start
function handleConsoleGuestAccess(request) {
  const { sendJson, req, url } = request;
  if (req.method !== 'GET' || url.pathname !== '/api/console/guest') return false;
  const token = String(request.guestToken || '');
  if (!token) {
    sendJson({ ok: false, error: '访客令牌还没生成：重启桥接会自动生成 state/console-guest-token' }, 503);
    return true; /* @bridge-handled */
  }
  const pure = request.consoleGuestPure || {};
  const port = request.boundPort || 3100;
  const link = typeof pure.guestLink === 'function'
    ? pure.guestLink(`http://127.0.0.1:${port}`, token)
    : 'http://127.0.0.1:' + port + '/client?guest=' + encodeURIComponent(token);
  const scope = typeof pure.describeGuestScope === 'function'
    ? pure.describeGuestScope()
    : '访客只能看素材库，看不到花费/人设/白名单，也改不了任何东西。';
  sendJson({ ok: true, token, link, scope, rulesVersion: pure.GUEST_RULES_VERSION || 1 });
  return true; /* @bridge-handled */
}
// @bridge-function handleConsoleGuestAccess:end

export function createGuestAccess(deps) {
  return {
    handleConsoleGuestAccess: (request) => handleConsoleGuestAccess({
      // 用显式取值而不是 Object.create(request)：consoleRequest 上的字段是只读 getter，
      // 直接往上写会报 "Cannot set property guestToken of #<Object> which has only a getter"。
      sendJson: request.sendJson,
      req: request.req,
      url: request.url,
      boundPort: request.boundPort,
      guestToken: deps.guestToken,
      consoleGuestPure: deps.consoleGuestPure
    })
  };
}
