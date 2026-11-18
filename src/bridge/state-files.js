// state-files: extracted bridge responsibilities; no startup side effects.
// Live dependencies: STATE_FILE, atomicWriteJson, fs, log, state, stateWritable
export function createStateFiles(deps) {
// @bridge-function loadState:start
function loadState() {
  let raw;
  try {
    raw = deps.fs.readFileSync(deps.STATE_FILE, 'utf8');
  } catch (error) {
    deps.state = { sessions: {}, sessionPolicies: {} };
    if (error?.code !== 'ENOENT') {
      deps.stateWritable = false;
      (0, deps.log)(`⚠️ sessions.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
    }
    return;
  }
  let loaded = null;
  if (raw.trim() !== '') {
    try {
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      loaded = JSON.parse(text);
    } catch (error) {
      deps.state = { sessions: {}, sessionPolicies: {} };
      deps.stateWritable = false;
      (0, deps.log)(`⚠️ sessions.json 内容损坏，已降级为「只读不写」（不会覆盖原文件，请先备份再修复）：${error?.message ?? error}`);
      return;
    }
  }
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') deps.state = loaded;
  else deps.state = { sessions: {} };
  if (!deps.state.sessionPolicies || typeof deps.state.sessionPolicies !== 'object' || Array.isArray(deps.state.sessionPolicies)) deps.state.sessionPolicies = {};
}
// @bridge-function loadState:end

// @bridge-function saveState:start
function saveState() {
  // 统一走原子写：固定 `.tmp` 名 + 无 mode 的手写版本会在外部进程（杀软/备份）
  // 占住 sessions.json.tmp 时抛 EPERM，且写出的文件权限与其它 state 文件不一致。
  if (!deps.stateWritable) return; // 见 loadState：读失败/损坏时绝不回写，避免把丢失变成永久
  (0, deps.atomicWriteJson)(deps.STATE_FILE, deps.state);
}
// @bridge-function saveState:end
  return { loadState, saveState };
}
