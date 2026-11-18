// session-recycle: extracted bridge responsibilities; no startup side effects.
// Live dependencies: CONTEXT_BUDGET_SWEEP_EVERY_N_TURNS, CONTEXT_BUDGET_TIMEOUT_MS, CONTEXT_BUDGET_TTL_MS, api, budgetConfig, budgetSweepPromise, budgetTurnsSinceSweep, cfg, createBudgetRunner, createContextPressureProbe, fs, isSessionAllowedInCurrentMode, log, messageDb, os, path, retireSession, saveHandoffDigest, saveSocialV2State, socialV2, state
export function createSessionRecycle(deps) {
// @bridge-function sessionRecycleCfg:start
function sessionRecycleCfg() {
    const c = deps.cfg.socialV2?.sessionRecycle || {};
    return {
      enabled: c.enabled !== false,
      maxMessages: Number(c.maxMessages) > 0 ? Number(c.maxMessages) : 600,
      maxAgeHours: Number(c.maxAgeHours) > 0 ? Number(c.maxAgeHours) : 48
    };
  }
// @bridge-function sessionRecycleCfg:end

// @bridge-function contextPressureProbeInstance:start
function contextPressureProbeInstance() {
    if (!contextPressureProbeInstance.cache) {
      contextPressureProbeInstance.cache = (0, deps.createContextPressureProbe)({
        call: (sessionId) => deps.api.callUnary('session/projections', { sessionId }),
        ttlMs: deps.CONTEXT_BUDGET_TTL_MS,
        timeoutMs: deps.CONTEXT_BUDGET_TIMEOUT_MS
      });
    }
    return contextPressureProbeInstance.cache;
  }
// @bridge-function contextPressureProbeInstance:end

// @bridge-function messagesSinceSessionReset:start
function messagesSinceSessionReset(key) {
    try {
      const since = Number(deps.socialV2.sessionResets?.[key]?.at) || 0;
      const row = (0, deps.messageDb)().prepare('SELECT COUNT(*) n FROM messages WHERE key = ? AND ts >= ?').get(key, since);
      return Number(row?.n || 0);
    } catch { return null; }
  }
// @bridge-function messagesSinceSessionReset:end

// @bridge-function budgetRunnerInstance:start
function budgetRunnerInstance() {
    if (budgetRunnerInstance.cache) return budgetRunnerInstance.cache;
    budgetRunnerInstance.cache = (0, deps.createBudgetRunner)({
    getConfig: () => (0, deps.budgetConfig)(deps.cfg.socialV2?.contextBudget),
    // 探针自带 60s TTL + 单飞 + 5s 超时；这里把 {snap, cached} 一起交上去（runner 靠 cached 决定要不要打 keep 日志）
    getPressure: (sessionId) => contextPressureProbeInstance().getDetail(sessionId),
    getTurns: (key) => messagesSinceSessionReset(key),
    recycle: ({ key, sessionId, snap, limitPct, source }) => {
      // 期间可能已被别的路径换过会话（reset / 手动回收 / 白名单变更）：别砍错人。
      if (deps.state.sessions[key] !== sessionId) {
        budgetRunnerInstance().noteMismatch({ key, mappedSid: deps.state.sessions[key], actualSid: sessionId });
        return false;
      }
      (0, deps.retireSession)(key); // 内含 saveHandoffDigest：下一轮 bootstrap 注入交接脉络
      deps.socialV2.sessionResets = deps.socialV2.sessionResets || Object.create(null);
      deps.socialV2.sessionResets[key] = { at: Date.now(), count: 0, reason: 'budget' };
      (0, deps.saveSocialV2State)();
      (0, deps.log)(`[预算] ${key} 按预算回收（${snap?.pct ?? '?'}% ≥ ${limitPct}%，来源=${source}），下一轮重建`);
      return true;
    },
    log: (...args) => (0, deps.log)(...args)
    });
    return budgetRunnerInstance.cache;
  }
// @bridge-function budgetRunnerInstance:end

// @bridge-function budgetTickForTurn:start
function budgetTickForTurn(key, sessionId) {
    const mapped = deps.state.sessions[key];
    if (mapped !== sessionId) {
      budgetRunnerInstance().noteMismatch({ key, mappedSid: mapped, actualSid: sessionId });
      return null;
    }
    budgetRunnerInstance().clearMismatch(key);
    deps.budgetTurnsSinceSweep += 1;
    // 「每 N 轮」也扫一次：不依赖「回合末恰好映射一致」这一条路径（D51 的漏点就是它）。
    if (deps.budgetTurnsSinceSweep >= deps.CONTEXT_BUDGET_SWEEP_EVERY_N_TURNS) scheduleBudgetSweep('turns');
    return budgetRunnerInstance().checkTurn({ key, sessionId });
  }
// @bridge-function budgetTickForTurn:end

// @bridge-function scheduleBudgetSweep:start
function scheduleBudgetSweep(reason) {
    deps.budgetTurnsSinceSweep = 0;
    if (deps.budgetSweepPromise) return deps.budgetSweepPromise; // 单飞：别叠着扫
    const bc = (0, deps.budgetConfig)(deps.cfg.socialV2?.contextBudget);
    if (!bc.enabled) return null;
    const sessions = {};
    for (const [key, sid] of Object.entries(deps.state.sessions || {})) {
      if (!sid) continue;
      try { if (!(0, deps.isSessionAllowedInCurrentMode)(key)) continue; } catch { continue; }
      sessions[key] = sid;
    }
    const started = Date.now();
    deps.budgetSweepPromise = budgetRunnerInstance().sweep({ sessions })
      .then((r) => {
        if (r?.recycled) (0, deps.log)(`[预算] sweep（${reason}）扫 ${r.entries} 个会话，回收 ${r.recycled} 个（${Date.now() - started}ms）`);
        return r;
      })
      .catch((error) => { (0, deps.log)('[预算] sweep 失败（本轮跳过，不影响回复）:', error?.message ?? error); return null; })
      .finally(() => { deps.budgetSweepPromise = null; });
    return deps.budgetSweepPromise;
  }
// @bridge-function scheduleBudgetSweep:end

// @bridge-function presetFingerprint:start
function presetFingerprint() {
    const file = process.env.DSH_PRESET_FILE
      || deps.path.join(deps.os.homedir(), '.dsh', 'plugins', 'qq-agent-presets', 'presets', 'qq-chat-v2.patch.yml');
    try {
      const st = deps.fs.statSync(file);
      return `${Math.round(st.mtimeMs)}:${st.size}`;
    } catch {
      return null;
    }
  }
// @bridge-function presetFingerprint:end

// @bridge-function checkPresetFingerprint:start
function checkPresetFingerprint() {
    const now = presetFingerprint();
    if (!now) return;
    const prev = deps.socialV2.presetFingerprint;
    deps.socialV2.presetFingerprint = now;
    try { (0, deps.saveSocialV2State)(); } catch {}
    if (!prev || prev === now) return;
    deps.socialV2.pendingPresetRecycle = true;
    try { (0, deps.saveSocialV2State)(); } catch {}
    (0, deps.log)(`preset 已变更（${prev} -> ${now}），下一轮会话回收时全部重建（存量会话此前仍用旧配置）`);
  }
// @bridge-function checkPresetFingerprint:end

// @bridge-function sessionRecycleTick:start
async function sessionRecycleTick() {
    const rc = sessionRecycleCfg();
    if (!rc.enabled) return;
    // preset 变更后的强制重建：优先于按年龄/条数的常规回收，跑一次即清标记。
    if (deps.socialV2.pendingPresetRecycle) {
      deps.socialV2.pendingPresetRecycle = false;
      let rebuilt = 0;
      for (const key of [...(deps.state.sessions ? Object.keys(deps.state.sessions) : [])]) {
        try {
          (0, deps.saveHandoffDigest)(key);
          (0, deps.retireSession)(key);
          deps.socialV2.sessionResets = deps.socialV2.sessionResets || Object.create(null);
          deps.socialV2.sessionResets[key] = { at: Date.now(), count: 0, reason: 'preset' };
          rebuilt += 1;
        } catch (error) {
          (0, deps.log)('[回收] preset 重建失败:', error?.message ?? error);
        }
      }
      try { (0, deps.saveSocialV2State)(); } catch {}
      (0, deps.log)(`[回收] preset 变更：已重建 ${rebuilt} 个会话（下一条消息起用新配置）`);
    }
    if (!deps.socialV2.sessionResets || typeof deps.socialV2.sessionResets !== 'object') deps.socialV2.sessionResets = Object.create(null);
    const now = Date.now();
    for (const key of [...deps.state.sessions ? Object.keys(deps.state.sessions) : []]) {
      try {
        const rec = deps.socialV2.sessionResets[key] || { at: now, count: 0 };
        const ageH = (now - Number(rec.at || now)) / 3600000;
        let count = 0;
        try {
          const row = (0, deps.messageDb)().prepare('SELECT COUNT(*) n FROM messages WHERE key = ? AND ts >= ?').get(key, Number(rec.at) || 0);
          count = Number(row?.n || 0);
        } catch {}
        const tooOld = ageH >= rc.maxAgeHours;
        const tooMany = count >= rc.maxMessages;
        if (!tooOld && !tooMany) continue;
        (0, deps.saveHandoffDigest)(key);
        (0, deps.retireSession)(key);
        deps.socialV2.sessionResets[key] = { at: now, count: 0, reason: tooMany ? 'messages' : 'age' };
        try { (0, deps.saveSocialV2State)(); } catch {}
        (0, deps.log)(`[回收] ${key} 已重建会话（${tooMany ? `消息 ${count} 条` : `已 ${ageH.toFixed(1)} 小时`}）`);
      } catch (error) {
        (0, deps.log)('[回收] 失败:', error?.message ?? error);
      }
    }
  }
// @bridge-function sessionRecycleTick:end
  return { sessionRecycleCfg, contextPressureProbeInstance, messagesSinceSessionReset, budgetRunnerInstance, budgetTickForTurn, scheduleBudgetSweep, presetFingerprint, checkPresetFingerprint, sessionRecycleTick };
}
