// 梗库（memewiki）管理接口：看统计 + 重新导入到黑话库。
// VM-safe：零 import，读库/写盘都在 bridge.js 提供的 deps 里。
export function createMemewiki(deps) {
  function agentBlocked(request) {
    const headers = request?.req?.headers ?? {};
    if (headers['x-agent-token'] || headers['x-agent-call']) {
      request.sendJson({ ok: false, error: '未授权：梗库是管理端操作' }, 403);
      return true;
    }
    return false;
  }

// @bridge-function handleMemewikiStatus:start
  function handleMemewikiStatus(request) {
    const pathname = request.url.pathname;
    if (pathname !== '/api/memewiki/status') return false;
    if (agentBlocked(request)) return true;
    if (request.method !== 'GET') {
      request.sendJson({ ok: false, error: '该接口只支持 GET' }, 405);
      return true;
    }
    try {
      request.sendJson(deps.memewikiStatus());
    } catch (error) {
      (0, deps.log)('梗库统计失败:', error?.message ?? error);
      request.sendJson({ ok: false, error: '统计梗库失败：' + (error?.message ?? error) }, 500);
    }
    return true;
  }
// @bridge-function handleMemewikiStatus:end

// @bridge-function handleMemewikiReimport:start
  async function handleMemewikiReimport(request) {
    const pathname = request.url.pathname;
    if (pathname !== '/api/memewiki/reimport') return false;
    if (agentBlocked(request)) return true;
    if (request.method !== 'POST') {
      request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405);
      return true;
    }
    try {
      const body = await request.readBody({ maxBytes: 8 * 1024 }).catch(() => ({}));
      const limit = Number(body && body.limit) || undefined;
      const result = deps.memewikiReimport({ limit });
      request.sendJson(result);
    } catch (error) {
      (0, deps.log)('梗库导入失败:', error?.message ?? error);
      request.sendJson({ ok: false, error: '导入失败：' + (error?.message ?? error) }, 500);
    }
    return true;
  }
// @bridge-function handleMemewikiReimport:end

  return { handleMemewikiStatus, handleMemewikiReimport };
}
