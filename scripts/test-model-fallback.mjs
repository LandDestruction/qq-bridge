import { readBridgeSource } from './bridge-source.mjs';
// 模型降级 / 模型配置校验 / 价格表归一化 的离线单测。
//
// 只 import 纯函数模块（src/model-fallback.js、src/model-prices.js），
// **不 import src/bridge.js**：那个文件一被 import 就会启动桥接进程。
//
// 跑法：node scripts/test-model-fallback.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkModelAgainstList, noteBounded, resolveTurnModel, isModelCapacityError, isModelUnavailableError, collectCatalogModels, listAvailableModels, pickUsableModel, validateModelConfig, orderFallbacksByProvider, planFallback } from '../src/model-fallback.js';
import { DEFAULT_PRICE_TABLE, normalizeModelId, ratesAt, resolvePriceTable } from '../src/model-prices.js';

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ❌ ${name}\n     ${error?.message ?? error}`);
  }
}

// ── 1. 503 主模型池全挂：真实报文（2026-10-25 13:48:38 群 100000008）─────────
const REAL_503 = '503: {"code":"no_healthy_account","gateway_hint":"no healthy account available in pool; check /status or retry later","message":"all accounts are temporarily unavailable, please retry later","type":"api_error"}';

console.log('\n[1] isModelCapacityError —— 容量/限流判定');
check('真实 503 no_healthy_account 报文 → true', () => {
  assert.equal(isModelCapacityError(REAL_503), true);
});
check('只给 JSON 主体（无 503: 前缀）也 → true', () => {
  assert.equal(isModelCapacityError('{"code":"no_healthy_account","message":"all accounts are temporarily unavailable"}'), true);
});
check('429 rate limit → true', () => {
  assert.equal(isModelCapacityError('429 rate limit exceeded, please slow down'), true);
});
check('insufficient quota → true', () => {
  assert.equal(isModelCapacityError('insufficient quota'), true);
});
check('原有分支仍命中：额度不足 → true', () => {
  assert.equal(isModelCapacityError('当前额度已用尽，请稍后再试'), true);
});
check('原有分支仍命中：no such model → true', () => {
  assert.equal(isModelCapacityError('no such model: deepseek-v4-pro'), true);
});
check('结构化 503（code:503）→ true', () => {
  assert.equal(isModelCapacityError('{"code":503,"message":"upstream error"}'), true);
});
check('status=503 → true', () => {
  assert.equal(isModelCapacityError('upstream returned status=503'), true);
});
check('普通回复文本「今天 503 路公交好挤」→ false', () => {
  assert.equal(isModelCapacityError('今天 503 路公交好挤'), false);
});
check('裸 429 仍命中（原有分支刻意保留，历史行为不改）', () => {
  // 429 在旧实现里就是裸匹配，且「保持原有 429 分支命中」是硬要求，这里只固定行为。
  // 真正需要防的是 503：它太容易出现在正常文本里（「503 路公交」），见上一条。
  assert.equal(isModelCapacityError('我 429 岁生日'), true);
});
check('空串 → false', () => {
  assert.equal(isModelCapacityError(''), false);
});
check('null → false', () => {
  assert.equal(isModelCapacityError(null), false);
});
check('undefined → false', () => {
  assert.equal(isModelCapacityError(undefined), false);
});

// ── 2. 模型 id 不存在：换模型池后的真实报文 ──────────────────────────────────
console.log('\n[2] isModelUnavailableError —— 模型 id 不可用判定');
check('pi-ai provider has no configured model → true', () => {
  assert.equal(isModelUnavailableError('pi-ai provider "workbuddy2api" has no configured model "cn:deepseek-v4-pro"'), true);
});
check('session/model-unavailable → true', () => {
  assert.equal(isModelUnavailableError('session/model-unavailable: Select an available model before sending a message.'), true);
});
check('普通 503 容量错误不算模型 id 问题 → false', () => {
  assert.equal(isModelUnavailableError(REAL_503), false);
});
check('空串/null → false', () => {
  assert.equal(isModelUnavailableError(''), false);
  assert.equal(isModelUnavailableError(null), false);
});

// ── 3. 配置的模型不在清单里 → 回退到可用模型 ────────────────────────────────
// 假清单 = 2026-10-25 合池后的真实 provider 注册表
const CATALOG = {
  groups: [
    {
      id: 'workbuddy2api',
      models: [
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash (合池)' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro (合池)' },
        { id: 'glm-5.3', name: 'GLM-5.3 (合池)' }
      ]
    },
    { id: 'deepseek-official', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] }
  ]
};
const AVAILABLE = collectCatalogModels(CATALOG);

console.log('\n[3] 模型配置校验 / 回退');
check('collectCatalogModels 摊平目录', () => {
  assert.deepEqual(AVAILABLE.map((m) => `${m.provider}/${m.model}`), [
    'workbuddy2api/deepseek-v4.1-flash',
    'workbuddy2api/deepseek-v4-pro',
    'workbuddy2api/glm-5.3',
    'deepseek-official/deepseek-flash'
  ]);
});
check('旧 cn: 前缀模型 → 判定不可用，回退到同 provider 的 flash', () => {
  const r = validateModelConfig({ provider: 'workbuddy2api', model: 'cn:deepseek-v4.1-flash', fallbacks: [], available: AVAILABLE });
  assert.equal(r.checked, true);
  assert.equal(r.ok, false);
  assert.equal(r.effective.provider, 'workbuddy2api');
  assert.equal(r.effective.model, 'deepseek-v4.1-flash');
  assert.match(r.warnings[0], /cn:deepseek-v4\.1-flash/);
  assert.match(r.warnings[0], /可用模型/);
});
check('配置的模型存在 → ok=true，不回退', () => {
  const r = validateModelConfig({ provider: 'workbuddy2api', model: 'deepseek-v4.1-flash', fallbacks: [], available: AVAILABLE });
  assert.equal(r.ok, true);
  assert.equal(r.effective, null);
  assert.deepEqual(r.warnings, []);
});
check('fallbacks 里 provider 已下线 → 出告警但不影响主模型 ok', () => {
  const r = validateModelConfig({
    provider: 'workbuddy2api',
    model: 'deepseek-v4.1-flash',
    fallbacks: [{ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }, { provider: 'workbuddy2api', model: 'glm-5.3' }],
    available: AVAILABLE
  });
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /workbuddy\/deepseek-v4\.1-flash/);
});
check('provider 整个消失 → 回退到任意 provider 的 flash', () => {
  const r = validateModelConfig({ provider: 'workbuddy', model: 'deepseek-v4-pro', fallbacks: [], available: AVAILABLE });
  assert.equal(r.ok, false);
  assert.equal(r.effective.model, 'deepseek-v4.1-flash');
});
check('读不到清单 → checked=false，不阻止启动', () => {
  const r = validateModelConfig({ provider: 'workbuddy2api', model: 'cn:xxx', fallbacks: [], available: [] });
  assert.equal(r.checked, false);
  assert.equal(r.ok, true);
  assert.equal(r.effective, null);
});
check('pickUsableModel 跳过刚才失败的那个', () => {
  const picked = pickUsableModel({ provider: 'workbuddy2api', model: 'deepseek-v4.1-flash', available: AVAILABLE });
  assert.equal(picked.model, 'deepseek-v4-pro');
});
check('pickUsableModel 空清单 → null', () => {
  assert.equal(pickUsableModel({ provider: 'a', model: 'b', available: [] }), null);
});

// ── 4. 价格表：前缀归一化 + 档位 ────────────────────────────────────────────
function findTier(wantPeak) {
  for (let d = 0; d < 21; d += 1) {
    const t = Date.parse('2026-11-02T10:00:00+08:00') + d * 86400000;
    const rates = ratesAt('deepseek-v4-pro', t);
    if ((rates.tier === 'peak') === wantPeak) return t;
  }
  throw new Error(`找不到 ${wantPeak ? '高峰' : '空闲'} 时段`);
}
const OFF_AT = findTier(false);
const PEAK_AT = findTier(true);

console.log('\n[4] model-prices 归一化与档位');
check('normalizeModelId 去 cn:/global: 前缀', () => {
  assert.equal(normalizeModelId('cn:deepseek-v4.1-flash'), 'deepseek-v4-flash');
  assert.equal(normalizeModelId('global:deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(normalizeModelId(' CN:DeepSeek-V4-Pro '), 'deepseek-v4-pro');
  assert.equal(normalizeModelId('glm-5.3'), 'glm-5.3');
  assert.equal(normalizeModelId(''), '');
});
check('cn:deepseek-v4-pro 命中 pro 档（4.5 元/M，不再落到 flash 的 1 元）', () => {
  const r = ratesAt('cn:deepseek-v4-pro', OFF_AT);
  assert.equal(r.estimated, false);
  assert.equal(r.cacheMiss, 4.5);
  assert.equal(r.output, 13.5);
});
check('global:deepseek-v4-pro 与裸 id 同价', () => {
  const a = ratesAt('global:deepseek-v4-pro', OFF_AT);
  const b = ratesAt('deepseek-v4-pro', OFF_AT);
  assert.equal(a.cacheMiss, b.cacheMiss);
  assert.equal(a.output, b.output);
  assert.equal(a.estimated, false);
});
check('cn:deepseek-v4.1-flash 命中 flash 档（1 元/M）', () => {
  const r = ratesAt('cn:deepseek-v4.1-flash', OFF_AT);
  assert.equal(r.estimated, false);
  assert.equal(r.cacheMiss, 1);
  assert.equal(r.output, 4);
});
check('高峰时段 = 空闲单价 × peakMultiplier', () => {
  const off = ratesAt('cn:deepseek-v4-pro', OFF_AT);
  const peak = ratesAt('cn:deepseek-v4-pro', PEAK_AT);
  assert.equal(peak.cacheMiss, off.cacheMiss * DEFAULT_PRICE_TABLE.peakMultiplier);
  assert.equal(peak.tier, 'peak');
});
check('glm-5.3 有条目但标记价格未核实', () => {
  const r = ratesAt('cn:glm-5.3', OFF_AT);
  assert.equal(r.estimated, false);
  assert.equal(r.unverified, true);
});
check('未知模型 → estimated=true 且回调一次，模型名原样上报', () => {
  const seen = [];
  const r = ratesAt('cn:totally-unknown', OFF_AT, DEFAULT_PRICE_TABLE, { onUnpriced: (m) => seen.push(m) });
  assert.equal(r.estimated, true);
  assert.deepEqual(seen, ['cn:totally-unknown']);
});
check('配置里用 cn: 前缀写 pricing.models 也能命中', () => {
  const table = resolvePriceTable({ models: { 'cn:my-relay-model': { label: '中转', off: { cacheHit: 0.5, cacheMiss: 3, output: 9 } } } });
  const r = ratesAt('cn:my-relay-model', OFF_AT, table);
  assert.equal(r.estimated, false);
  assert.equal(r.cacheMiss, 3);
});

// ── 汇总 ────────────────────────────────────────────────────────────────────
// ── 落盘前的模型 id 校验（合池后 cn: 前缀 / 换 provider 都是真实故障形态）────
const LIST = [
  { provider: 'workbuddy2api', model: 'deepseek-v4-flash', label: 'Flash' },
  { provider: 'workbuddy2api', model: 'deepseek-v4-pro', label: 'Pro' }
];
check('在清单里 → 通过', () => {
  const v = checkModelAgainstList({ provider: 'workbuddy2api', model: 'deepseek-v4-flash', list: LIST });
  assert.equal(v.ok, true);
  assert.equal(v.known, true);
  assert.equal(v.empty, false);
});
check('不在清单里 → 拒绝，且不是「清单为空」', () => {
  const v = checkModelAgainstList({ provider: 'workbuddy2api', model: 'deepseek-v9-pro', list: LIST });
  assert.equal(v.ok, false);
  assert.equal(v.empty, false);
});
check('拿不到清单（空）→ 放行但标记 empty（DSH 临时不可用不能把运维卡死）', () => {
  const v = checkModelAgainstList({ provider: 'workbuddy2api', model: '任意', list: [] });
  assert.equal(v.ok, true);
  assert.equal(v.empty, true);
});
check('带区域前缀的旧 id 被认下来（cn:deepseek-v4-pro ≡ deepseek-v4-pro）', () => {
  const v = checkModelAgainstList({ provider: 'workbuddy2api', model: 'cn:deepseek-v4-pro', list: LIST });
  assert.equal(v.ok, true);
  assert.deepEqual(v.matches, ['workbuddy2api/deepseek-v4-pro']);
});
check('同名但换了 provider → 拒绝并指出正确 provider', () => {
  const v = checkModelAgainstList({ provider: 'deepseek-official', model: 'deepseek-v4-pro', list: LIST });
  assert.equal(v.ok, false);
  assert.deepEqual(v.matches, ['workbuddy2api/deepseek-v4-pro']);
});
check('provider 留空时只按 model 认', () => {
  assert.equal(checkModelAgainstList({ provider: '', model: 'deepseek-v4-pro', list: LIST }).ok, true);
});
check('listAvailableModels 截断并带上 provider/name', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ provider: 'p', model: `m${i}`, label: `L${i}` }));
  const out = listAvailableModels(many, 5);
  assert.equal(out.length, 5);
  assert.deepEqual(out[0], { provider: 'p', model: 'm0', name: 'L0' });
});

check('noteBounded：塞 250 个 key → size ≤ 200 且最早的不在', () => {
  const set = new Set();
  for (let i = 0; i < 250; i += 1) noteBounded(set, `k${i}`, 200);
  assert.equal(set.size, 200);
  assert.equal(set.has('k0'), false, '最早的必须被淘汰');
  assert.equal(set.has('k49'), false);
  assert.equal(set.has('k249'), true, '最新的必须还在');
});
check('noteBounded：重复 add 不产生重复条目，也不再返回 true', () => {
  const set = new Set();
  assert.equal(noteBounded(set, 'same', 200), true, '第一次是新条目');
  assert.equal(noteBounded(set, 'same', 200), false, '第二次不该再打日志');
  assert.equal(set.size, 1);
});
check('noteBounded：空 key 不计入', () => {
  const set = new Set();
  assert.equal(noteBounded(set, '', 200), false);
  assert.equal(set.size, 0);
});

// ── orderFallbacksByProvider（17:41 连续两跳撞同一家 workbuddy2api 的回归）────
// 线上 modelFallbacks 的真实形状（2026-10-25）：workbuddy2api 三条连排，
// deepseek-account / scnet 各一条。降级时前两跳都落在 workbuddy2api —— 那家整池
// 受限时等于连撞两次墙，而 deepseek-account/deepseek-flash（**唯一能看图的模型**）根本没被试到。
const LIVE_CHAIN = [
  { provider: 'workbuddy2api', model: 'deepseek-v4.1-flash' },
  { provider: 'workbuddy2api', model: 'deepseek-v4-pro' },
  { provider: 'workbuddy2api', model: 'glm-5.3' },
  { provider: 'deepseek-account', model: 'deepseek-flash' },
  { provider: 'scnet', model: 'DeepSeek-V4.1-Flash-1017-Event' }
];
check('orderFallbacksByProvider：当前 provider 的桶排最后，配置最后一项固定为「最后兜底」', () => {
  const out = orderFallbacksByProvider(LIVE_CHAIN, 'workbuddy2api');
  assert.equal(out.length, 5);
  assert.equal(out[0].provider, 'deepseek-account', '当前 provider 失败后先从别家试');
  assert.equal(out[out.length - 1].model, 'DeepSeek-V4.1-Flash-1017-Event', '配置最后一项必须留在链尾（官方 DeepSeek 兜底位）');
  assert.equal(out[out.length - 1].provider, 'scnet');
  const providers = out.map((f) => f.provider);
  assert.notEqual(providers[0], providers[1], '前两跳必须换家');
});
check('orderFallbacksByProvider：同 provider 内部相对顺序保持不变', () => {
  const out = orderFallbacksByProvider(LIVE_CHAIN, 'workbuddy2api');
  const wb = out.filter((f) => f.provider === 'workbuddy2api').map((f) => f.model);
  assert.deepEqual(wb, ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'glm-5.3']);
});
check('orderFallbacksByProvider：过滤没有 model 的项，空输入返回 []', () => {
  assert.deepEqual(orderFallbacksByProvider([], 'x'), []);
  assert.deepEqual(orderFallbacksByProvider(null, 'x'), []);
  const out = orderFallbacksByProvider([{ provider: 'a' }, { provider: 'a', model: 'm' }], '');
  assert.deepEqual(out, [{ provider: 'a', model: 'm' }]);
});
check('orderFallbacksByProvider：配置最后一项固定末尾（其余按 provider 交错）', () => {
  const out = orderFallbacksByProvider([
    { provider: 'a', model: 'a1' }, { provider: 'a', model: 'a2' },
    { provider: 'b', model: 'b1' }, { provider: 'c', model: 'c1' }
  ], 'a');
  assert.deepEqual(out.map((f) => f.model), ['b1', 'a1', 'a2', 'c1'], 'c1 是配置最后一项，永远最后试');
});

// ── 本轮真正生效的模型（视觉守卫必须读它，而不是 override/cfg）────────────────
check('resolveTurnModel：applied 存在时必须以 applied 为准', () => {
  const r = resolveTurnModel({
    applied: { provider: 'deepseek-account', model: 'deepseek-flash' },
    override: { provider: 'workbuddy2api', model: 'glm-5.3' },
    cfgProvider: 'workbuddy2api',
    cfgModel: 'deepseek-v4.1-flash'
  });
  assert.deepEqual(r, { provider: 'deepseek-account', model: 'deepseek-flash' }, '会话已切到 deepseek-flash，就必须按它判定视觉能力');
});
check('resolveTurnModel：applied 缺失 → 回落 override', () => {
  const r = resolveTurnModel({ override: { provider: 'p', model: 'm' }, cfgProvider: 'x', cfgModel: 'y' });
  assert.deepEqual(r, { provider: 'p', model: 'm' });
});
check('resolveTurnModel：都缺失 → 回落 cfg', () => {
  assert.deepEqual(resolveTurnModel({ cfgProvider: 'x', cfgModel: 'y' }), { provider: 'x', model: 'y' });
  assert.deepEqual(resolveTurnModel({}), { provider: '', model: '' });
});
check('resolveTurnModel：applied 缺 model 字段时不当真（避免空模型覆盖）', () => {
  const r = resolveTurnModel({ applied: { provider: 'p' }, cfgProvider: 'x', cfgModel: 'y' });
  assert.deepEqual(r, { provider: 'x', model: 'y' });
});

// ── planFallback：降级只写日志、绝不私聊管理员（2026-10-26 用户明确要求）──────
const OFFICIAL_CHAIN = [
  { provider: 'workbuddy2api', model: 'deepseek-v4-pro' },
  { provider: 'workbuddy2api', model: 'glm-5.3' },
  { provider: 'deepseek-account', model: 'deepseek-flash' },
  { provider: 'scnet', model: 'DeepSeek-V4.1-Flash-1017-Event' },
  { provider: 'deepseek-account', model: 'deepseek-v4-pro' }
];
check('planFallback：容量错误 → 降级，日志带「第 N 次」与原因，notifyOwner=false', () => {
  const plan = planFallback({
    message: '503: {"code":"no_healthy_account","message":"all accounts are temporarily unavailable"}',
    current: { provider: 'workbuddy2api', model: 'deepseek-v4.1-flash' },
    fallbacks: OFFICIAL_CHAIN,
    count: 0
  });
  assert.equal(plan.action, 'fallback');
  assert.equal(plan.count, 1);
  assert.equal(plan.notifyOwner, false);
  assert.match(plan.logLine, /\[模型\] 已降级/);
  assert.match(plan.logLine, /第 1 次/);
  assert.match(plan.logLine, /no_healthy_account/);
  assert.ok(plan.next.provider && plan.next.model);
});
check('planFallback：降级时假 send 被调用 0 次（不再私聊管理员）', () => {
  let sent = 0;
  const fakeSend = () => { sent += 1; };
  const plan = planFallback({
    message: '429 rate limit exceeded',
    current: { provider: 'workbuddy2api', model: 'deepseek-v4-pro' },
    fallbacks: OFFICIAL_CHAIN,
    count: 2
  });
  assert.equal(plan.action, 'fallback');
  if (plan.notifyOwner) fakeSend();
  assert.equal(sent, 0, '降级路径不得调用 sendToQQ');
  assert.equal(plan.count, 3, '第 N 次要连续累加');
});
check('planFallback：官方 DeepSeek 是链尾兜底（配置最后一项最后试到）', () => {
  // 从 scnet 失败开始：其余备用按序，最后一个才是官方 deepseek-account/deepseek-v4-pro
  const plan = planFallback({
    message: '503 no healthy account',
    current: { provider: 'scnet', model: 'DeepSeek-V4.1-Flash-1017-Event' },
    fallbacks: OFFICIAL_CHAIN,
    count: 0
  });
  const ordered = orderFallbacksByProvider(OFFICIAL_CHAIN, 'scnet');
  assert.deepEqual(ordered[ordered.length - 1], { provider: 'deepseek-account', model: 'deepseek-v4-pro' });
  assert.equal(plan.action, 'fallback');
});
check('planFallback：非容量错误 / 没有备用 → none，不误降级', () => {
  assert.equal(planFallback({ message: 'invalid api key', current: { provider: 'p', model: 'm' }, fallbacks: OFFICIAL_CHAIN }).action, 'none');
  const none = planFallback({
    message: '503 no healthy account',
    current: { provider: 'p', model: 'm' },
    fallbacks: [{ provider: 'p', model: 'm' }]
  });
  assert.equal(none.action, 'none');
  assert.equal(none.reason, 'no-fallback');
  assert.equal(none.notifyOwner, false);
});

// ── bridge 接线静态断言：降级/恢复路径里不能再出现 sendToQQ ─────────────────
const BRIDGE_SRC = readBridgeSource();
function bridgeFunctionBody(name) {
  const start = BRIDGE_SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`bridge 里找不到函数 ${name}`);
  // 函数声明在 2 空格缩进层级，函数体结束是第一个 "\n  }\n"（内部块是 4+ 空格）。
  const end = BRIDGE_SRC.indexOf('\n  }\n', start);
  return BRIDGE_SRC.slice(start, end);
}
check('bridge.recordModelFailure：降级只写 plan.logLine，不调用 sendToQQ', () => {
  const body = bridgeFunctionBody('recordModelFailure');
  assert.equal(body.includes('sendToQQ'), false, '降级路径不得私聊管理员');
  assert.match(body, /planFallback\(/, '降级决策必须走纯函数');
  assert.match(body, /plan\.logLine/, '降级必须写「第 N 次/原因」日志');
});
check('bridge.notifyModelAutoFallback：自动回退只写日志，不调用 sendToQQ', () => {
  const body = bridgeFunctionBody('notifyModelAutoFallback');
  assert.equal(body.includes('sendToQQ'), false, '自动回退通知不得私聊管理员');
  assert.match(body, /log\(/, '必须有日志');
});
check('bridge.noteExternalTurnOk：本地兜底恢复只写日志，不私聊', () => {
  const body = bridgeFunctionBody('noteExternalTurnOk');
  assert.equal(body.includes('sendToQQ'), false, '恢复通知不得私聊管理员');
  assert.match(body, /log\(/);
});
check('bridge 仍保留 notifyOwnerOnError 的原语义（不是新开通知）', () => {
  assert.match(BRIDGE_SRC, /notifyOwnerOnError/);
});

const total = pass + failures.length;
console.log(`\n${failures.length ? '❌' : '✅'} ${pass}/${total} 通过`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exit(1);
}
