// 画面记忆「补描述」后台任务：把本地表情文件交给视觉模型，生成详细描述后写入图库。
// VM-safe：零 import；spawn / 路径 / 统计都从 deps 拿（bridge.js 注入）。
//
// 为什么不在这里直接读图：识图、ffmpeg 转码、批量重试都写成独立脚本
// （scripts/backfill-image-memory.mjs），桥接只负责「起任务 / 看进度 / 停任务」，
// 免得把长任务塞进 HTTP 进程里把控制台拖死。
export function createImageBackfill(deps) {
  // 路径在调用时才算：装配期 deps 的 getter 指向尚未初始化的 live 绑定，
  // 构造时读 deps.ROOT 会被 scripts/test-bridge-modules.mjs 判成 eager access。
  const scriptPath = () => `${deps.ROOT}/scripts/backfill-image-memory.mjs`;
  let child = null;
  let job = { state: 'idle', pid: null, startedAt: 0, endedAt: 0, limit: 0, exitCode: null, error: '' };

  function agentBlocked(request) {
    const headers = request?.req?.headers ?? {};
    if (headers['x-agent-token'] || headers['x-agent-call']) {
      request.sendJson({ ok: false, error: '未授权：画面记忆是管理端操作' }, 403);
      return true;
    }
    return false;
  }

  function snapshot() {
    const stats = (() => {
      try { return deps.imageMemoryStats(); } catch (error) { return { error: String(error?.message ?? error) }; }
    })();
    return { ok: true, ...stats, job: { ...job, running: job.state === 'running' } };
  }

// @bridge-function handleImageMemoryStatus:start
  function handleImageMemoryStatus(request) {
    if (request.url.pathname !== '/api/image-memory/status') return false;
    if (agentBlocked(request)) return true;
    if (request.method !== 'GET') {
      request.sendJson({ ok: false, error: '该接口只支持 GET' }, 405);
      return true;
    }
    request.sendJson(snapshot());
    return true;
  }
// @bridge-function handleImageMemoryStatus:end

// @bridge-function handleImageMemoryBackfill:start
  async function handleImageMemoryBackfill(request) {
    if (request.url.pathname !== '/api/image-memory/backfill') return false;
    if (agentBlocked(request)) return true;
    if (request.method !== 'POST') {
      request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405);
      return true;
    }
    if (job.state === 'running') {
      request.sendJson({ ok: false, error: '补描述任务已经在跑了', job: { ...job, running: true } }, 409);
      return true;
    }
    try {
      const body = await request.readBody({ maxBytes: 4 * 1024 }).catch(() => ({}));
      const limit = Math.max(1, Math.min(2000, Number(body?.limit) || 40));
      const delay = Math.max(0, Math.min(5000, Number(body?.delay) || 250));
      const force = body?.force === true;
      const args = [scriptPath(), '--limit', String(limit), '--delay', String(delay)];
      if (force) args.push('--force');
      job = { state: 'running', pid: null, startedAt: Date.now(), endedAt: 0, limit, exitCode: null, error: '' };
      const spawned = deps.spawn(deps.nodeExe, args, { cwd: deps.ROOT, stdio: 'ignore', windowsHide: true });
      child = spawned;
      job.pid = spawned?.pid ?? null;
      const finish = (code, err) => {
        child = null;
        // 用户点「停止」时 taskkill 会让子进程非 0 退出；这条 exit 不能把 stopped 改写成 failed，
        // 否则界面上明明是用户主动停的，却显示「上一轮失败」。
        if (job.state === 'stopped') {
          job = { ...job, exitCode: Number.isFinite(code) ? code : job.exitCode };
          return;
        }
        job = { ...job, state: code === 0 ? 'done' : 'failed', exitCode: code, endedAt: Date.now(), error: err ? String(err.message ?? err) : '' };
      };
      spawned?.on?.('exit', (code) => finish(Number.isFinite(code) ? code : -1));
      spawned?.on?.('error', (err) => finish(-1, err));
      (0, deps.log)(`[画面记忆] 补描述任务已启动 pid=${job.pid} limit=${limit}${force ? ' force' : ''}`);
      request.sendJson({ ok: true, started: true, job: { ...job, running: true } });
    } catch (error) {
      job = { ...job, state: 'failed', endedAt: Date.now(), error: String(error?.message ?? error) };
      (0, deps.log)('画面记忆补描述启动失败:', error?.message ?? error);
      request.sendJson({ ok: false, error: '启动失败：' + (error?.message ?? error) }, 500);
    }
    return true;
  }
// @bridge-function handleImageMemoryBackfill:end

// @bridge-function handleImageMemoryStop:start
  function handleImageMemoryStop(request) {
    if (request.url.pathname !== '/api/image-memory/backfill/stop') return false;
    if (agentBlocked(request)) return true;
    if (request.method !== 'POST') {
      request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405);
      return true;
    }
    if (job.state !== 'running' || !child) {
      request.sendJson({ ok: false, error: '没有在跑的补描述任务' }, 409);
      return true;
    }
    try {
      deps.spawn('taskkill', ['/pid', String(job.pid ?? child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch (error) {
      (0, deps.log)('画面记忆停止失败:', error?.message ?? error);
    }
    job = { ...job, state: 'stopped', endedAt: Date.now() };
    child = null;
    request.sendJson({ ok: true, stopped: true, job: { ...job, running: false } });
    return true;
  }
// @bridge-function handleImageMemoryStop:end

  return { handleImageMemoryStatus, handleImageMemoryBackfill, handleImageMemoryStop };
}
