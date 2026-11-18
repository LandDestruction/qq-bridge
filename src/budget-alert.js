// 花费 / 用量预警的纯逻辑：判定、外推、文案、冷却。
//
// 为什么单独一层：判定规则要能被单测（不看时间、不看网络、不读账本），
// 桥接侧只负责「拿今天的用量 → 喂进来 → 真要发就发」。
//
// 口径（说清楚，免得以后误读）：
//   · 「已用」= 今天 0 点到现在，账本里逐条采样累加的金额 / token（与「用量与花费」页同一份数据）；
//   · 「预计」= 已用 ÷ 已经过去的比例 → 外推到全天。刚过 0 点、比例太小时不外推（会算出天文数字）；
//   · 两档预警：exceed（已经超了）、predict（还没超，但按现在的节奏会超）；
//   · 冷却：同一个档位在 cooldownMinutes 内只提醒一次，避免刷屏。

export const BUDGET_ALERT_DEFAULTS = Object.freeze({
  enabled: false,
  metric: 'cost',          // cost | tokens
  limitCost: 20,           // 元
  limitTokens: 20000000,   // token
  projected: true,         // 预计超支也提醒
  cooldownMinutes: 360,    // 同一档位 6 小时内只提醒一次
  notifyOwner: true,       // 发到管理员 QQ 私聊
});

export const BUDGET_METRICS = Object.freeze(['cost', 'tokens']);

// 外推至少要有这么多已过去的时间，否则比例太小、预计值会离谱
const MIN_ELAPSED_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** 把 config.json 里那段（可能缺字段 / 手改坏了）收拾成可用设置。 */
export function budgetAlertSettingsOf(source) {
  const raw = source && typeof source === 'object' ? source : {};
  const metric = BUDGET_METRICS.includes(raw.metric) ? raw.metric : BUDGET_ALERT_DEFAULTS.metric;
  return {
    enabled: raw.enabled === true,
    metric,
    limitCost: num(raw.limitCost, BUDGET_ALERT_DEFAULTS.limitCost, 0.01, 100000),
    limitTokens: Math.round(num(raw.limitTokens, BUDGET_ALERT_DEFAULTS.limitTokens, 1000, 1e12)),
    projected: raw.projected !== false,
    cooldownMinutes: Math.round(num(raw.cooldownMinutes, BUDGET_ALERT_DEFAULTS.cooldownMinutes, 5, 7 * 24 * 60)),
    notifyOwner: raw.notifyOwner !== false,
  };
}

/** 当前指标对应的限额数值。 */
export function budgetLimitOf(settings) {
  return settings.metric === 'tokens' ? settings.limitTokens : settings.limitCost;
}

/** 从「今日已用 + 已过去的时间」外推全天。 */
export function budgetProjection({ used, now, dayStart }) {
  const nowMs = Number(now) || Date.now();
  const startMs = Number(dayStart) || new Date(nowMs).setHours(0, 0, 0, 0);
  const elapsed = Math.max(0, nowMs - startMs);
  const usedNum = Math.max(0, Number(used) || 0);
  const projected = elapsed < MIN_ELAPSED_MS ? usedNum : usedNum * (DAY_MS / elapsed);
  return {
    used: usedNum,
    projected: Math.round(projected * 100) / 100,
    elapsedMs: elapsed,
    pacePerHour: elapsed > 0 ? usedNum / (elapsed / 3600000) : 0,
    extrapolated: elapsed >= MIN_ELAPSED_MS,
  };
}

/**
 * 判定当前该不该报警。
 * 返回 { level: 'exceed'|'predict'|null, ratio, limit, used, projected }
 */
export function evaluateBudgetAlert({ settings, used, projected, extrapolated = true }) {
  const limit = budgetLimitOf(settings);
  const usedNum = Math.max(0, Number(used) || 0);
  const projNum = Math.max(usedNum, Number(projected) || usedNum);
  const base = { limit, used: usedNum, projected: projNum, ratio: limit > 0 ? usedNum / limit : 0 };
  if (!settings || settings.enabled !== true) return { ...base, level: null };
  if (limit <= 0) return { ...base, level: null };
  if (usedNum >= limit) return { ...base, level: 'exceed' };
  if (settings.projected && extrapolated && projNum >= limit) return { ...base, level: 'predict' };
  return { ...base, level: null };
}

/** 冷却判定：同一档位在 cooldown 内不重复提醒；升级（predict→exceed）可以立刻发。 */
export function shouldNotifyBudget({ level, now, lastFiredAt, lastFiredLevel, cooldownMinutes }) {
  if (!level) return false;
  if (!Number.isFinite(Number(lastFiredAt)) || !lastFiredAt) return true;
  if (level === 'exceed' && lastFiredLevel !== 'exceed') return true;   // 从「预计」升级成「超了」值得再发一条
  const cooldownMs = Math.max(5, Number(cooldownMinutes) || 0) * 60 * 1000;
  return (Number(now) || Date.now()) - Number(lastFiredAt) >= cooldownMs;
}

const METRIC_TEXT = { cost: '花费', tokens: 'token 用量' };

export function formatBudgetNumber(metric, value, symbol = '¥') {
  const n = Number(value) || 0;
  if (metric === 'tokens') {
    if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
    return String(Math.round(n));
  }
  return symbol + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
}

/**
 * 发到管理员私聊的那句话。写成「像人汇报」而不是「系统告警」：
 * 出多少、限额多少、大概怎么来的、接下来会怎样。
 */
export function formatBudgetAlert({
  level = 'exceed', settings, used, projected, symbol = '¥', topKey = '', generatedAt = Date.now()
}) {
  const metric = settings?.metric === 'tokens' ? 'tokens' : 'cost';
  const limit = budgetLimitOf(settings || BUDGET_ALERT_DEFAULTS);
  const usedText = formatBudgetNumber(metric, used, symbol);
  const limitText = formatBudgetNumber(metric, limit, symbol);
  const projText = formatBudgetNumber(metric, projected, symbol);
  const hour = new Date(generatedAt).getHours();
  const when = hour < 5 ? '凌晨' : hour < 11 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上';
  const head = level === 'exceed' ? '【花费预警】超了' : '【花费预警】可能要超';
  const top = topKey ? `最烧的是「${String(topKey).replace(/^(group|private):/, '')}」。` : '';
  if (level === 'exceed') {
    return `${head}：今天${when}为止已经用了 ${usedText}（${METRIC_TEXT[metric]}），超过你设的 ${limitText}。${top}想看明细就打开控制台的「用量与花费」。`;
  }
  return `${head}：今天${when}为止用了 ${usedText}，按现在的节奏全天大概 ${projText}，会超过你设的 ${limitText}。${top}要是今天还要聊不少，可以先把限额调高一点。`;
}

/** 手动试发、而且当前没命中任何档位时的文案：别假装「超了」，就老老实实说这是测试。 */
export function formatBudgetAlertTest({ settings, used, symbol = '¥', generatedAt = Date.now() }) {
  const metric = settings?.metric === 'tokens' ? 'tokens' : 'cost';
  const limitText = formatBudgetNumber(metric, budgetLimitOf(settings || BUDGET_ALERT_DEFAULTS), symbol);
  const usedText = formatBudgetNumber(metric, used, symbol);
  const hour = new Date(generatedAt).getHours();
  const when = hour < 5 ? '凌晨' : hour < 11 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上';
  return `【花费预警】测试：现在${when}为止今天用了 ${usedText}，你设的限额是 ${limitText}。`
    + '预警已经接通，以后真的超了、或者按节奏会超，都会发到这条私聊里来。';
}
