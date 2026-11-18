// 配置热加载的纯逻辑：决定哪些字段能在不重启的情况下替换，哪些必须重启。
// 桥接侧只负责「读文件 → loadConfig() → 用这里的 plan 把旧值钉回必须重启的字段 → 原地替换 cfg」。

/** 改了必须重启才生效的字段（连接/端口/进程级）。 */
export const RESTART_REQUIRED_PATHS = Object.freeze([
  'consolePort',
  'sessionCwd',
  'agentPreset',
  'snowluma.wsUrl',
  'snowluma.httpUrl',
  'snowluma.accessToken',
  'dsh.baseUrl',
  'dsh.authToken',
  'dsh.authHeader',
  'dsh.authPrefix'
]);

export function getPath(obj, dotted) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

export function setPath(obj, dotted, value) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

function stable(v) {
  try { return JSON.stringify(v ?? null); } catch { return String(v); }
}

/**
 * @param {object} oldCfg 当前运行中的配置
 * @param {object} newCfg 从磁盘重新加载出来的配置
 * @returns {{ ok:boolean, changed:string[], skipped:Array<{path:string,from:any,to:any}>, unchanged:boolean }}
 *   skipped 里是「磁盘变了但必须重启」的字段；调用方应把旧值写回 newCfg 再替换。
 */
export function planConfigReload(oldCfg, newCfg, { restartRequired = RESTART_REQUIRED_PATHS } = {}) {
  const skipped = [];
  for (const path of restartRequired) {
    const from = getPath(oldCfg, path);
    const to = getPath(newCfg, path);
    if (stable(from) !== stable(to)) skipped.push({ path, from, to });
  }
  const changed = [];
  for (const key of new Set([...Object.keys(oldCfg || {}), ...Object.keys(newCfg || {})])) {
    if (stable(oldCfg?.[key]) !== stable(newCfg?.[key])) changed.push(key);
  }
  return { ok: true, changed, skipped, unchanged: changed.length === 0 && skipped.length === 0 };
}

/** 把必须重启的字段的旧值写回 newCfg（让它们在内存里保持不变）。 */
export function pinRestartOnlyFields(oldCfg, newCfg, skipped) {
  for (const s of skipped) setPath(newCfg, s.path, s.from);
  return newCfg;
}
