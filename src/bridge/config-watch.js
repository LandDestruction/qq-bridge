// config-watch: extracted bridge responsibilities; no startup side effects.
// Live dependencies: ROOT, cfg, clearTimeout, configReloadCount, configReloadTimer, configWatcher, disarmPendingWakeLease, fs, getSocialV2State, lastConfigReloadAt, lastConfigReloadSkipped, loadConfig, log, modelAppliedSessions, path, pendingWakeKeys, pinRestartOnlyFields, planConfigReload, scheduleWakeV2, setInterval, setTimeout, state, turnLastEventAt, v2TurnStartAt
export function createConfigWatch(deps) {
// @bridge-function reloadConfigFromDisk:start
function reloadConfigFromDisk(reason = 'api') {
    let next;
    try {
      next = (0, deps.loadConfig)();
    } catch (error) {
      (0, deps.log)(`[配置] 热加载失败（保持旧配置）：${error?.message ?? error}`);
      return { ok: false, error: String(error?.message ?? error) };
    }
    const plan = (0, deps.planConfigReload)(deps.cfg, next);
    (0, deps.pinRestartOnlyFields)(deps.cfg, next, plan.skipped);
    for (const key of Object.keys(deps.cfg)) delete deps.cfg[key];
    Object.assign(deps.cfg, next);
    deps.lastConfigReloadAt = Date.now();
    deps.configReloadCount += 1;
    deps.lastConfigReloadSkipped = plan.skipped;
    if (plan.unchanged) {
      (0, deps.log)(`[配置] 热加载（${reason}）：磁盘内容无变化`);
    } else {
      (0, deps.log)(`[配置] 热加载（${reason}）：生效 ${plan.changed.length} 项${plan.changed.length ? '（' + plan.changed.join(', ') + '）' : ''}`);
    }
    for (const s2 of plan.skipped) {
      (0, deps.log)(`[配置] 需要重启才生效，已保持旧值：${s2.path} = ${JSON.stringify(s2.from)}（磁盘为 ${JSON.stringify(s2.to)}）`);
    }
    return { ok: true, changed: plan.changed, skipped: plan.skipped, unchanged: plan.unchanged };
  }
// @bridge-function reloadConfigFromDisk:end

// @bridge-function startTurnWatchdog:start
function startTurnWatchdog() {
    const timer = (0, deps.setInterval)(() => {
      const now = Date.now();
      for (const [key, sid] of Object.entries(deps.state.sessions || {})) {
        if (!String(key).startsWith('group:')) continue;
        const startedAt = Number(deps.v2TurnStartAt.get(sid));
        if (!Number.isFinite(startedAt) || startedAt <= 0) continue;
        const lastEvent = Math.max(startedAt, Number(deps.turnLastEventAt.get(sid)) || 0);
        if (now - lastEvent < 4 * 60 * 1000) continue;
        (0, deps.log)(`[看门狗] ${key} 回合超过 4 分钟无事件（起始 ${Math.round((now - startedAt) / 60000)} 分钟前），判定卡死：清忙并补推`);
        deps.v2TurnStartAt.delete(sid);
        deps.turnLastEventAt.delete(sid);
        deps.modelAppliedSessions.delete(sid);
        deps.pendingWakeKeys.delete(key);
        (0, deps.disarmPendingWakeLease)(key);
        const st = (0, deps.getSocialV2State)(key);
        if (Array.isArray(st.pendingWakeReasons) && st.pendingWakeReasons.length) {
          const next = st.pendingWakeReasons.shift();
          (0, deps.scheduleWakeV2)(key, next?.reason || 'replyCheck');
        }
      }
    }, 30000);
    timer.unref?.();
  }
// @bridge-function startTurnWatchdog:end

// @bridge-function startConfigWatcher:start
function startConfigWatcher() {
    const enabled = deps.cfg.socialV2?.hotReload?.enabled === true;
    if (deps.configWatcher) { try { deps.configWatcher.close(); } catch {} deps.configWatcher = null; }
    if (!enabled) return;
    const configPath = deps.path.join(deps.ROOT, 'config.json');
    try {
      deps.configWatcher = deps.fs.watch(configPath, { persistent: false }, () => {
        if (deps.configReloadTimer) (0, deps.clearTimeout)(deps.configReloadTimer);
        deps.configReloadTimer = (0, deps.setTimeout)(() => {
          deps.configReloadTimer = null;
          reloadConfigFromDisk('watch');
          startConfigWatcher(); // 配置可能改了 hotReload 开关，重启监听
        }, 800);
      });
      deps.configWatcher.on?.('error', () => {});
      (0, deps.log)('[配置] 已开启文件监听：改 config.json 后自动热加载（端口/连接类仍需重启）');
    } catch (error) {
      (0, deps.log)(`[配置] 文件监听启动失败：${error?.message ?? error}`);
    }
  }
// @bridge-function startConfigWatcher:end
  return { reloadConfigFromDisk, startTurnWatchdog, startConfigWatcher };
}
