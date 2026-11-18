// console/budget-alert：花费 / 用量预警（阈值、指标、冷却、发到管理员私聊）。
//
// 契约：
//   GET  /api/budget/alert        → 设置 + 今天已用 / 预计 / 上次提醒
//   POST /api/budget/alert        → 改设置（只改给的那几个字段），写回 config.json 的 socialV2.budgetAlert
//   POST /api/budget/alert/test   → 立刻按当前数据发一条（手动验证能不能收到）
// 安全：带 x-agent-token / x-agent-call 一律 403 —— 花多少钱是管理端的事，
// 群里的 AI 不该知道、也不该能改限额。
//
// 巡检：start() 之后每 5 分钟算一次；命中阈值且过了冷却才发，发送结果写 state/budget-alert.json。
// 纯规则在 src/budget-alert.js 里（有独立单测）。这里不写 import —— 桥接模块是被
// vm 裸执行的（scripts/bridge-source.mjs 只剥 export，不处理 import），所以纯函数
// 通过 deps.budgetAlertPure 注入（见 bridge.js 的 runtimeBindings）。

const TICK_MS = 5 * 60 * 1000;
const MIN_TICK_MS = 30 * 1000;   // 单测/调试时允许更短的间隔

export function createBudgetAlert(deps) {
  // 构造期不许读 deps（VM 里依赖可能还没注入，测试会用「会抛错的 getter」验证这一点）：
  // 纯规则第一次真正用到时才解构，之后缓存（进程内纯规则对象不会变）。
  let pureCache = null;
  const pureOf = () => {
    if (!pureCache) pureCache = deps.budgetAlertPure || {};
    return pureCache;
  };
  const stateFile = () => (0, deps.path).join(deps.STATE_DIR, 'budget-alert.json');

  function readState() {
    try {
      const raw = (0, deps.fs).readFileSync(stateFile(), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }

  function writeState(next) {
    try {
      (0, deps.fs).mkdirSync(deps.STATE_DIR, { recursive: true });
      (0, deps.atomicWriteJson)(stateFile(), next);
    } catch {}
  }

  function settingsNow() {
    const { budgetAlertSettingsOf } = pureOf();
    return budgetAlertSettingsOf(deps.cfg?.socialV2?.budgetAlert ?? deps.cfg?.budgetAlert);
  }

  function ownerKey() {
    const qq = String(deps.cfg?.ownerQQ ?? '').trim();
    return /^\d{5,12}$/.test(qq) ? `private:${qq}` : '';
  }

  /** 今天 0 点到现在：从账本里逐条采样累加（与「用量与花费」页同一份数据）。 */
  function usageToday() {
    let keys = [];
    let from = new Date().setHours(0, 0, 0, 0);
    try {
      const today = deps.tokenLedger?.todayByKey ? deps.tokenLedger.todayByKey() : null;
      if (today && Array.isArray(today.keys)) {
        keys = today.keys;
        if (Number.isFinite(Number(today.from))) from = Number(today.from);
      }
    } catch (error) {
      (0, deps.log)(`[预算预警] 读账本失败：${error?.message ?? error}`);
    }
    const usedCost = keys.reduce((sum, row) => sum + (Number(row.cost) || 0), 0);
    const usedTokens = keys.reduce((sum, row) => sum + (Number(row.tokens) || 0), 0);
    const top = keys.slice().sort((a, b) => (Number(b.cost) || 0) - (Number(a.cost) || 0))[0];
    return { usedCost, usedTokens, from, topKey: top ? String(top.key || '') : '', conversations: keys.length };
  }

  function snapshot() {
    const { budgetProjection, evaluateBudgetAlert, budgetLimitOf, shouldNotifyBudget } = pureOf();
    const settings = settingsNow();
    const usage = usageToday();
    const metric = settings.metric;
    const used = metric === 'tokens' ? usage.usedTokens : usage.usedCost;
    const proj = budgetProjection({ used, now: Date.now(), dayStart: usage.from });
    const verdict = evaluateBudgetAlert({ settings, used, projected: proj.projected, extrapolated: proj.extrapolated });
    const state = readState();
    return {
      ok: true,
      settings,
      limit: budgetLimitOf(settings),
      metric,
      symbol: deps.priceTable?.symbol || '¥',
      today: {
        usedCost: Number(usage.usedCost.toFixed(4)),
        usedTokens: Math.round(usage.usedTokens),
        conversations: usage.conversations,
        topKey: usage.topKey,
        projected: proj.projected,
        projectedCost: metric === 'tokens' ? null : proj.projected,
        pacePerHour: Math.round(proj.pacePerHour * 100) / 100,
        extrapolated: proj.extrapolated,
        ratio: verdict.ratio
      },
      now: { level: verdict.level, wouldNotify: shouldNotifyBudget({ level: verdict.level, now: Date.now(), lastFiredAt: state.lastFiredAt, lastFiredLevel: state.lastFiredLevel, cooldownMinutes: settings.cooldownMinutes }) },
      status: {
        lastFiredAt: Number(state.lastFiredAt) || 0,
        lastFiredLevel: String(state.lastFiredLevel || ''),
        lastFiredText: String(state.lastFiredText || ''),
        firedCount: Number(state.firedCount) || 0
      },
      canNotify: Boolean(ownerKey()),
      ownerQQ: String(deps.cfg?.ownerQQ ?? '').trim()
    };
  }

  async function fire({ level, snapshotData, manual = false } = {}) {
    const { formatBudgetAlert, formatBudgetAlertTest } = pureOf();
    const settings = snapshotData.settings;
    const key = ownerKey();
    if (!key) return { ok: false, sent: false, error: '还没设置管理员 QQ（config.json 的 ownerQQ），没地方发' };
    const metric = settings.metric;
    const used = metric === 'tokens' ? snapshotData.today.usedTokens : snapshotData.today.usedCost;
    // 手动试发时如果当前根本没命中档位，就别套「超了」的文案（7 块钱说超了 20 块像在撒谎）
    const text = (manual && !level) ? formatBudgetAlertTest({ settings, used, symbol: snapshotData.symbol }) : formatBudgetAlert({
      level: level || 'exceed',
      settings,
      used,
      projected: metric === 'tokens' ? used : snapshotData.today.projected,
      symbol: snapshotData.symbol,
      topKey: snapshotData.today.topKey
    });
    try {
      await (0, deps.sendToQQ)(key, text);
    } catch (error) {
      const message = String(error?.message ?? error);
      (0, deps.log)(`[预算预警] 发送失败：${message}`);
      return { ok: false, sent: false, error: message, text };
    }
    const state = readState();
    const count = (Number(state.firedCount) || 0) + 1;
    // 手动「试发」不能占掉冷却：否则试一下就把真正超限的那条提醒压掉了。
    writeState(manual
      ? { ...state, lastFiredText: text, firedCount: count, lastManualAt: Date.now() }
      : { lastFiredAt: Date.now(), lastFiredLevel: level || 'exceed', lastFiredText: text, firedCount: count });
    (0, deps.log)(`[预算预警] 已发给 ${key}：${text}`);
    return { ok: true, sent: true, text };
  }

  /** 巡检一次：命中就发，没命中什么都不做。 */
  async function tick() {
    const { shouldNotifyBudget } = pureOf();
    const data = snapshot();
    if (!data.settings.enabled) return { ok: true, level: null };
    const state = readState();
    const due = shouldNotifyBudget({
      level: data.now.level,
      now: Date.now(),
      lastFiredAt: state.lastFiredAt,
      lastFiredLevel: state.lastFiredLevel,
      cooldownMinutes: data.settings.cooldownMinutes
    });
    if (!data.now.level || !due) return { ok: true, level: data.now.level, sent: false };
    if (!data.settings.notifyOwner) return { ok: true, level: data.now.level, sent: false, reason: 'notifyOwner=false' };
    return fire({ level: data.now.level, snapshotData: data });
  }

  let timer = null;
  function start({ intervalMs = TICK_MS } = {}) {
    if (timer) return false;
    const every = Math.max(MIN_TICK_MS, Number(intervalMs) || TICK_MS);
    timer = setInterval(() => { tick().catch((error) => (0, deps.log)(`[预算预警] 巡检异常：${error?.message ?? error}`)); }, every);
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } return true; }

// @bridge-function handleConsoleBudgetAlert:start
  async function handleBudgetAlert(request) {
    const { BUDGET_ALERT_DEFAULTS, budgetAlertSettingsOf } = pureOf();
    const path = request.url.pathname;
    if (path !== '/api/budget/alert' && path !== '/api/budget/alert/test') return false;
    const headers = request.req.headers || {};
    if (headers['x-agent-token'] || headers['x-agent-call']) {
      request.sendJson({ ok: false, error: '花费预警只允许管理端查看/修改' }, 403);
      return true;
    }
    if (path === '/api/budget/alert/test') {
      if (request.req.method !== 'POST') { request.sendJson({ ok: false, error: '只支持 POST' }, 405); return true; }
      const data = snapshot();
      // level 为空表示「现在没命中档位」——试发只验证通道，不制造假的超限
      const level = data.now.level || '';
      const result = await fire({ level, snapshotData: data, manual: true });
      request.sendJson({ ...result, level: result.level || null });
      return true;
    }
    if (request.req.method === 'GET') {
      request.sendJson(snapshot());
      return true;
    }
    if (request.req.method !== 'POST') { request.sendJson({ ok: false, error: '只支持 GET/POST' }, 405); return true; }
    const body = await request.readBody();
    const diskCfg = (0, deps.readConfigObject)((0, deps.path).join(deps.ROOT, 'config.json'));
    const baseRaw = diskCfg?.socialV2?.budgetAlert && typeof diskCfg.socialV2.budgetAlert === 'object'
      ? diskCfg.socialV2.budgetAlert
      : (deps.cfg?.socialV2?.budgetAlert ?? {});
    const merged = { ...BUDGET_ALERT_DEFAULTS, ...baseRaw };
    for (const field of ['enabled', 'metric', 'limitCost', 'limitTokens', 'projected', 'cooldownMinutes', 'notifyOwner']) {
      if (Object.prototype.hasOwnProperty.call(body, field)) merged[field] = body[field];
    }
    const settings = budgetAlertSettingsOf(merged);
    try {
      (0, deps.updateConfigFile)((0, deps.path).join(deps.ROOT, 'config.json'), (disk) => {
        if (!disk.socialV2 || typeof disk.socialV2 !== 'object') disk.socialV2 = {};
        disk.socialV2.budgetAlert = settings;
      }, { atomicWrite: deps.atomicWriteJson });
    } catch (error) {
      request.sendJson({ ok: false, error: `写入 config.json 失败：${error?.message ?? error}` }, 500);
      return true;
    }
    if (!deps.cfg.socialV2 || typeof deps.cfg.socialV2 !== 'object') deps.cfg.socialV2 = {};
    deps.cfg.socialV2.budgetAlert = settings;
    (0, deps.log)(`[预算预警] 设置已更新：${settings.enabled ? '开' : '关'} · ${settings.metric === 'tokens' ? 'token' : '金额'} · 限额 ${settings.metric === 'tokens' ? settings.limitTokens : settings.limitCost} · 冷却 ${settings.cooldownMinutes} 分钟`);
    request.sendJson({ ...snapshot(), ok: true });
    return true;
  }
// @bridge-function handleConsoleBudgetAlert:end

  // manifest 登记的是「装配面」：VM 网关只认声明式 handler（handleConsoleBudgetAlert）。
  // 巡检 start/stop、快照、试发、纯规则读数是运行时 API，桥接与单测可以直接调用，但不算装配面，
  // 所以挂成不可枚举 —— 这样 Object.keys(service) 与 manifest.functions 严格一致（1 个），
  // VM 边界测试才能验证「manifest 的 functions 就是模块构造后暴露的装配面」。
  // handleBudgetAlert 是历史别名：bridge.js 仍按旧名解构，留一个不可枚举别名即可。
  const service = { handleConsoleBudgetAlert: handleBudgetAlert };
  Object.defineProperties(service, {
    snapshot: { value: snapshot, enumerable: false, configurable: true },
    tick: { value: tick, enumerable: false, configurable: true },
    start: { value: start, enumerable: false, configurable: true },
    stop: { value: stop, enumerable: false, configurable: true },
    fire: { value: fire, enumerable: false, configurable: true },
    settingsNow: { value: settingsNow, enumerable: false, configurable: true },
    ownerKey: { value: ownerKey, enumerable: false, configurable: true },
    usageToday: { value: usageToday, enumerable: false, configurable: true },
    handleBudgetAlert: { value: handleBudgetAlert, enumerable: false, configurable: true }
  });
  return service;
}
