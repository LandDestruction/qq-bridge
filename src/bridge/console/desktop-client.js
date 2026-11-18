// 设置页「桌面客户端」：只读地报告本机装的是哪个版本、和仓库里的安装包版本差多少。
//
// 为什么要这个模块：客户端（WebView2 壳）和桥接是一起发版的，用户机器上常常是旧壳配新桥接，
// 「关于」里又只能看到桥接版本，出问题时分不清是谁旧了。这里给设置页一个只读面板：
// 装了没 / 装的什么版本 / 仓库安装包是什么版本 / 开始菜单有没有快捷方式。
//
// 口径：
// - installed：`%LOCALAPPDATA%\QQDeepSeekBot\QQDeepSeekBot.exe` 存在（也兼容 `Programs\` 那一层，
//   因为安装器历史版本两处都放过）；config 里 `desktop.exePath` 优先。
// - installedVersion：安装目录里的 `version.txt`，没有就 `package.json` 的 `version`，都没有 → null。
// - expectedVersion：仓库 `scripts/installer/version.txt`（**不写死数字**，读不到就 null）。
// - startMenu：开始菜单 Programs 下的 `QQ Deep Bot.lnk`（历史名 `QQ DeepSeek Bot.lnk` 也认）。
//
// 约束：本文件是 manifest 模块，被 scripts/bridge-source.mjs 用 vm.runInContext 裸执行，
// **不能 import**；构造期不读 deps。任何异常都吞掉，按「没装/未知」返回，绝不 500。

const DESKTOP_STATUS_PATH = '/api/desktop-client/status';
const DESKTOP_CHECK_PATH = '/api/desktop-client/check';
const DESKTOP_EXE = 'QQDeepSeekBot.exe';
const DESKTOP_START_MENU_NAMES = ['QQ Deep Bot.lnk', 'QQ DeepSeek Bot.lnk'];

export function createDesktopClient(deps) {
  let impl = null;
  const implOf = () => impl || (impl = buildDesktopClient(deps));
  return {
    handleConsoleDesktopClientStatus: (request) => implOf().handleConsoleDesktopClientStatus(request),
    handleConsoleDesktopClientCheck: (request) => implOf().handleConsoleDesktopClientCheck(request)
  };
}

function buildDesktopClient(deps) {
  const fs = deps.fs;
  const path = deps.path;

  const exists = (p) => { try { return Boolean(p) && fs.existsSync(p); } catch { return false; } };
  const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

  function localAppData() {
    const env = typeof process === 'object' && process && process.env ? process.env : {};
    return String(env.LOCALAPPDATA || '').trim();
  }
  function roamingAppData() {
    const env = typeof process === 'object' && process && process.env ? process.env : {};
    return String(env.APPDATA || '').trim();
  }

  // 候选顺序：config 指定 > 安装器新路径（Programs）> 安装器旧路径（直接放 LOCALAPPDATA）> 仓库构建产物。
  function installCandidates() {
    const out = [];
    const push = (value) => {
      const v = String(value || '').trim();
      if (v && !out.includes(v)) out.push(v);
    };
    push(deps.cfg && deps.cfg.desktop && deps.cfg.desktop.exePath);
    const lad = localAppData();
    if (lad) {
      push(path.join(lad, 'Programs', 'QQDeepSeekBot', DESKTOP_EXE));
      push(path.join(lad, 'QQDeepSeekBot', DESKTOP_EXE));
    }
    push(path.join(deps.ROOT, 'dist', 'desktop', DESKTOP_EXE));
    return out;
  }

  function versionFromDir(dir) {
    const txt = String(readText(path.join(dir, 'version.txt')) || '').trim();
    if (txt) return txt.split(String.fromCharCode(10))[0].trim() || null;
    try {
      const pkg = JSON.parse(readText(path.join(dir, 'package.json')) || 'null');
      const v = pkg && typeof pkg.version === 'string' ? pkg.version.trim() : '';
      if (v) return v;
    } catch { /* 坏 JSON 就当没有版本 */ }
    return null;
  }

  function expectedVersionOf() {
    const candidates = [
      path.join(deps.ROOT, 'scripts', 'installer', 'version.txt'),
      path.join(deps.ROOT, 'scripts', 'installer', 'payload.json')
    ];
    const txt = String(readText(candidates[0]) || '').trim();
    if (txt) return txt.split(String.fromCharCode(10))[0].trim() || null;
    try {
      const payload = JSON.parse(readText(candidates[1]) || 'null');
      const v = payload && typeof payload.version === 'string' ? payload.version.trim() : '';
      if (v) return v;
    } catch { /* 没有就算了 */ }
    return null;
  }

  // 安装包路径：dist/installer 下最新一个 Setup 安装包（「复制安装命令」用它拼 PowerShell）。
  function installerOf() {
    const dir = path.join(deps.ROOT, 'dist', 'installer');
    try {
      const names = fs.readdirSync(dir)
        .filter((n) => /^QQDeepSeekBot-Setup-.+\.exe$/i.test(n))
        .sort();
      if (!names.length) return '';
      return path.join(dir, names[names.length - 1]);
    } catch { return ''; }
  }

  function startMenuPaths() {
    const out = [];
    const push = (base) => {
      const b = String(base || '').trim();
      if (!b) return;
      for (const name of DESKTOP_START_MENU_NAMES) {
        out.push(path.join(b, 'Microsoft', 'Windows', 'Start Menu', 'Programs', name));
      }
    };
    push(roamingAppData());
    push('C:' + String.fromCharCode(92) + 'ProgramData');
    return out;
  }

  function probe() {
    const e = (deps.cfg && deps.cfg.desktop) || {};
    const exePath = installCandidates().find(exists) || '';
    const installDir = exePath ? path.dirname(exePath) : '';
    const startMenu = startMenuPaths().some(exists);
    const installedVersion = installDir ? versionFromDir(installDir) : null;
    const expectedVersion = expectedVersionOf();
    return {
      ok: true,
      installed: Boolean(exePath),
      installedVersion,
      expectedVersion,
      installDir,
      exeName: exePath ? path.basename(exePath) : DESKTOP_EXE,
      installerPath: installerOf(),
      startMenu,
      checkedAt: Date.now(),
      // 给前端做「落后/最新」判断时用，省得两边各写一遍比较规则。
      upToDate: Boolean(installedVersion && expectedVersion && installedVersion === expectedVersion)
    };
  }

// @bridge-function handleConsoleDesktopClientStatus:start
  async function handleConsoleDesktopClientStatus(request) {
    const { url, sendJson } = request;
    if (url.pathname !== DESKTOP_STATUS_PATH) return false;
    let view;
    try { view = probe(); } catch (error) {
      try { deps.log('读桌面客户端状态失败：' + String(error && error.message ? error.message : error)); } catch { /* log 也炸就闭嘴 */ }
      view = { ok: true, installed: false, installedVersion: null, expectedVersion: null, installDir: '', exeName: DESKTOP_EXE, startMenu: false, checkedAt: Date.now(), upToDate: false };
    }
    sendJson(view);
    return true;
  }
// @bridge-function handleConsoleDesktopClientStatus:end

// @bridge-function handleConsoleDesktopClientCheck:start
  async function handleConsoleDesktopClientCheck(request) {
    const { url, sendJson } = request;
    if (url.pathname !== DESKTOP_CHECK_PATH) {
      // 同一路由行上先到 status handler；check 路径落到这里才处理。
      return false;
    }
    let view;
    try { view = probe(); } catch {
      view = { installed: false, installedVersion: null, expectedVersion: null };
    }
    sendJson({
      ok: true,
      upToDate: Boolean(view.installedVersion && view.expectedVersion && view.installedVersion === view.expectedVersion),
      installedVersion: view.installedVersion ?? null,
      expectedVersion: view.expectedVersion ?? null,
      installed: Boolean(view.installed),
      installDir: view.installDir || '',
      checkedAt: Date.now(),
      // 比对不出来时给一句人话，前端直接显示。
      hint: view.installedVersion
        ? (view.expectedVersion ? '' : '仓库里没找到安装包版本号，无法比较')
        : '没检测到已安装的桌面客户端'
    });
    return true;
  }
// @bridge-function handleConsoleDesktopClientCheck:end

  return { handleConsoleDesktopClientStatus, handleConsoleDesktopClientCheck };
}
