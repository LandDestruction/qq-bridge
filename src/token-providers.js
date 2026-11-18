// token 用量的「按 provider / 计费口径」纯函数（零依赖，不读文件、不碰时间源以外的东西）。
//
// 为什么需要它：账本里的 token 96% 以上是 cacheHit（缓存命中，通常不计费），
// 控制台只显示 raw 总量时，用户会和 WorkBuddy 后台的「计费量」对不上。
// 这里把采样按 provider 归集，同时给出三个口径：
//   raw     —— 全部 token（含 cacheHit），历史累计用
//   billed  —— cacheMiss + output（真正按量计费的部分），和后台账单对齐
//   cacheHit—— 只读缓存命中量，用来解释「为什么 raw 巨大但账单不大」
// share 的基数由 basis 决定，默认按 billed（谁花的钱多），可选 raw。

/** provider 的展示名。未知 provider 原样回，避免把新 provider 藏起来。 */
export const PROVIDER_LABELS = Object.freeze({
  workbuddy2api: 'WorkBuddy',
  workbuddy: 'WorkBuddy',
  'deepseek-account': 'DeepSeek 官方账号',
  'deepseek-official': 'DeepSeek 官方',
  'xiaomi-mimo': '小米 MiMo'
});

/** 从一条采样里取 provider；缺字段统一 'unknown'（不丢数据，也不假装知道）。 */
export function providerOf(sample) {
  const raw = sample?.provider ?? sample?.providerId ?? '';
  const value = String(raw ?? '').trim();
  return value || 'unknown';
}

/** provider 的展示名。 */
export function providerLabelOf(provider) {
  const value = String(provider ?? '').trim() || 'unknown';
  return PROVIDER_LABELS[value] ?? value;
}

/** 空桶（一个 provider 的累计）。 */
export function emptyProviderBucket() {
  return { calls: 0, turns: 0, tokens: 0, cacheHit: 0, cacheMiss: 0, output: 0, billed: 0, cost: 0 };
}

function sampleTokens(buckets) {
  const b = buckets ?? {};
  return (b.cacheMiss ?? 0) + (b.cacheHit ?? 0) + (b.cacheWrite ?? 0) + (b.output ?? 0);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 把一条采样累加进 provider 桶。
 *
 * turns 的统计方式：同 (sessionId, turn) 只算一轮 —— 一轮有多个 step 采样，
 * 直接按采样数当轮数会把「一轮 5 步」算成 5 轮（和账本 summary 的轮数对不上）。
 */
export function addSampleIntoProvider(bucket, sample) {
  const target = bucket ?? emptyProviderBucket();
  const b = sample?.buckets ?? {};
  const cacheHit = num(b.cacheHit);
  const cacheMiss = num(b.cacheMiss) + num(b.cacheWrite);
  const output = num(b.output);
  target.calls += 1;
  target.tokens += sampleTokens(b);
  target.cacheHit += cacheHit;
  target.cacheMiss += cacheMiss;
  target.output += output;
  target.billed = target.cacheMiss + target.output;
  target.cost += num(sample?.cost ?? sample?.costTotal);
  if (!target._turns) target._turns = new Set();
  target._turns.add(`${sample?.sessionId ?? ''}|${sample?.turn ?? ''}`);
  target.turns = target._turns.size;
  return target;
}

/** 本地零点（range=all 时不限制）。 */
export function providerRangeWindow(range, nowMs = Date.now()) {
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  const start = day.getTime();
  const DAY = 86400000;
  if (range === 'today') return { range, from: start, to: 0, days: 1 };
  if (range === '7d') return { range, from: start - 6 * DAY, to: 0, days: 7 };
  if (range === '30d') return { range, from: start - 29 * DAY, to: 0, days: 30 };
  return { range: 'all', from: 0, to: 0, days: 0 };
}

/**
 * 按 provider 归集一批采样。
 *
 * @param {Array} samples 采样数组（含 provider / buckets / cost / sessionId / turn / t）
 * @param {{from?: number, to?: number, key?: string, basis?: 'billed'|'raw'}} options
 * @returns {{total: object, providers: Array, basis: string}}
 */
export function aggregateProviderDays(samples, options = {}) {
  const from = num(options.from);
  const to = num(options.to);
  const key = String(options.key ?? '').trim();
  const basis = options.basis === 'raw' ? 'raw' : 'billed';
  const map = new Map();
  let total = emptyProviderBucket();
  for (const sample of Array.isArray(samples) ? samples : []) {
    const t = num(sample?.t);
    if (from && t < from) continue;
    if (to && t >= to) continue;
    if (key && String(sample?.key ?? '') !== key) continue;
    const provider = providerOf(sample);
    if (!map.has(provider)) map.set(provider, { provider, label: providerLabelOf(provider), ...emptyProviderBucket() });
    const bucket = addSampleIntoProvider(map.get(provider), sample);
    total = addSampleIntoProvider(total, sample);
  }
  const providers = [...map.values()].map((bucket) => {
    const { _turns, ...rest } = bucket;
    void _turns;
    return rest;
  });
  const basisOf = (bucket) => (basis === 'raw' ? bucket.tokens : bucket.billed);
  const basisTotal = providers.reduce((sum, bucket) => sum + basisOf(bucket), 0);
  for (const bucket of providers) {
    // 与 /api/tokens/tools 的 tools[].share 保持同一口径：**小数 0~1**（前端 ×100 用）。
    // sharePct 只是给文档/其它消费者的便捷百分数，别拿它当前端比例（否则会 4300%）。
    const ratio = basisTotal > 0 ? basisOf(bucket) / basisTotal : 0;
    bucket.share = Number(ratio.toFixed(4));
    bucket.sharePct = Number((ratio * 100).toFixed(1));
  }
  providers.sort((a, b) => basisOf(b) - basisOf(a) || b.tokens - a.tokens);
  const { _turns: totalTurns, ...totalOut } = total;
  void totalTurns;
  totalOut.providers = providers.length;
  return { total: totalOut, providers, basis };
}
