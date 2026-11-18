// 受控打开目录（POST /api/open-folder）：设置页「桌面客户端」只想让用户看安装包/安装目录/状态目录。
//
// 为什么只收枚举 kind 而不是路径：这个接口等于「让本机执行一次打开动作」，收任意字符串就变成
// 任意目录探测/钓鱼跳板。所以服务端**自己**算绝对路径，前端只能传 installer / desktop / state 三选一。
//
// 本文件是 manifest 模块（scripts/bridge-source.mjs 用 vm 裸执行），**不能 import**：
// 进程能力来自 deps.spawn（测试注入假 spawn 即可断言命令，不会真弹资源管理器）。

const OPENFOLDER_PATH = '/api/open-folder';
const OPENFOLDER_KINDS = Object.freeze(['installer', 'desktop', 'state']);
const OPENFOLDER_EXE = 'QQDeepSeekBot.exe';

export function createOpenFolder(deps) {
  let impl = null;
  const implOf = () => impl || (impl = buildOpenFolder(deps));
  return { handleConsoleOpenFolder: (request) => implOf().handleConsoleOpenFolder(request) };
}

function buildOpenFolder(deps) {
  const fs = deps.fs;
  const path = deps.path;
  const exists = (p) => { try { return Boolean(p) && fs.existsSync(p); } catch { return false; } };
  const env = () => (typeof process === 'object' && process && process.env) ? process.env : {};

  // 安装包目录：dist/installer（构建产物），连带兜底 dist/releases。
  function installerDir() {
    const candidates = [path.join(deps.ROOT, 'dist', 'installer'), path.join(deps.ROOT, 'dist', 'releases')];
    return candidates.find(exists) || '';
  }
  // 已安装目录：和 desktop-client 的判定同口径（config 指定 > Programs > LOCALAPPDATA 直放）。
  function desktopDir() {
    const cfgPath = String((deps.cfg && deps.cfg.desktop && deps.cfg.desktop.exePath) || '').trim();
    const candidates = [];
    if (cfgPath) candidates.push(path.dirname(cfgPath));
    const lad = String(env().LOCALAPPDATA || '').trim();
    if (lad) {
      candidates.push(path.join(lad, 'Programs', 'QQDeepSeekBot'));
      candidates.push(path.join(lad, 'QQDeepSeekBot'));
    }
    candidates.push(path.join(deps.ROOT, 'dist', 'desktop'));
    return candidates.find((p) => exists(path.join(p, OPENFOLDER_EXE))) || '';
  }
  function stateDir() {
    try { return path.resolve(String(deps.STATE_DIR || 'state')); } catch { return ''; }
  }
  function dirOf(kind) {
    if (kind === 'installer') return installerDir();
    if (kind === 'desktop') return desktopDir();
    if (kind === 'state') return stateDir();
    return '';
  }

// @bridge-function handleConsoleOpenFolder:start
  async function handleConsoleOpenFolder(request) {
    const { req, url, sendJson, readBody } = request;
    if (url.pathname !== OPENFOLDER_PATH) return false;
    if (req.method !== 'POST') { sendJson({ ok: false, error: '只支持 POST' }, 405); return true; }
    // 智能体令牌一律不许碰：和 open-url 同一条红线（agent 不能借管理员面板开目录）。
    if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
      sendJson({ ok: false, error: '打开目录只允许管理端操作' }, 403);
      return true;
    }
    let body = null;
    try { body = await readBody(); } catch { body = null; }
    const kind = String((body && body.kind) || '').trim();
    if (!OPENFOLDER_KINDS.includes(kind)) {
      sendJson({ ok: false, error: `kind 只能是 ${OPENFOLDER_KINDS.join(' / ')}` }, 400);
      return true;
    }
    const dir = dirOf(kind);
    if (!dir || !exists(dir)) { sendJson({ ok: false, error: '目录不存在' }); return true; }
    try {
      const child = deps.spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' });
      if (child && typeof child.unref === 'function') child.unref();
    } catch (error) {
      sendJson({ ok: false, error: '打开目录失败：' + String((error && error.message) || error) }, 500);
      return true;
    }
    try { deps.log(`打开目录 ${kind}：${dir}`); } catch { /* 日志失败不影响已打开的事实 */ }
    sendJson({ ok: true, kind, dir });
    return true;
  }
// @bridge-function handleConsoleOpenFolder:end

  return { handleConsoleOpenFolder };
}
