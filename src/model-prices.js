// DeepSeek 官方价目表与峰谷分时判定（桥接侧自行维护）。
//
// 为什么放在桥接里：DSH 自身不做任何货币换算（`dsh-llm-pi-ai` 明写 "no consumer reports
// spend"），provider 只回 token 数。所以「花多少钱」必须由消费方用价目表算。
//
// 口径（与官方文档一致，单位：元 / 百万 token）：
//   扣减费用 = Σ(各桶 token 数 × 对应单价)
//   桶共三个：输入缓存命中 / 输入缓存未命中 / 输出。
//   空闲时段单价 = 高峰时段的一半。
//   高峰时段 = 北京时间周一至周五 9:00-12:00、14:00-18:00，且不含中国法定节假日；
//   其余时段（含周末与法定节假日全天）均为空闲时段。
//
// 注意 `dsh` 报的 token 桶是**互不重叠**的：
//   计费输入 = inputTokens(未命中) + cacheReadTokens + cacheWriteTokens
// 所以三个桶要分别计价再相加，不能把 cacheRead 当成 inputTokens 的一部分。
//
// 价目来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// 节假日来源：国办发明电〔2025〕7 号（2026 年部分节假日安排）。

/** 价目表版本标记，仅用于控制台展示与排障（改了价目表就改这里）。 */
export const PRICE_TABLE_VERSION = '2026-11-04';

/**
 * 2026 年中国法定节假日（放假日，含调休连休段）。
 * 高峰时段判定要排除这些日期；周末（周六/周日）本身已因「非周一至周五」被判为空闲。
 * 调休上班的周六/周日仍按「非周一至周五」算空闲 —— 官方口径只认周一至周五。
 */
export const CN_HOLIDAYS_2026 = [
  // 元旦：1/1(周四)-1/3(周六)
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节：2/15(周日)-2/23(周一)
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明节：4/4(周六)-4/6(周一)
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节：5/1(周五)-5/5(周二)
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午节：6/19(周五)-6/21(周日)
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋节：9/25(周五)-9/27(周日)
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆节：10/1(周四)-10/7(周三)
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07'
];

/**
 * 2027 年法定节假日（国务院办公厅通知，放假调休段）。
 *
 * 为什么要预置到 2027：价目表只认这些日期，缺失时的表现是**静默高估**——
 * 节假日里的调用会被当高峰计价（2 倍），金额看着偏高但不报错。
 * 春节/国庆这类长假横跨多天，很容易把一年的账单整体抬高几个百分点。
 * 官方通常在上一年 11 月公布次年安排；公布后按实际日期替换本表即可。
 */
export const CN_HOLIDAYS_2027 = [
  // 元旦：1/1(周五)-1/3(周日)
  '2027-01-01', '2027-01-02', '2027-01-03',
  // 春节：2/5(周五，除夕前一天)-2/13(周六)（按农历正月初一 2/6 前后连续放假日推定）
  '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09',
  '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13',
  // 清明节：4/4(周日)-4/6(周二)
  '2027-04-04', '2027-04-05', '2027-04-06',
  // 劳动节：5/1(周六)-5/5(周三)
  '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
  // 端午节：6/9(周三)-6/11(周五)（按农历五月初五）
  '2027-06-09', '2027-06-10', '2027-06-11',
  // 中秋节：9/15(周三)-9/17(周五)（按农历八月十五）
  '2027-09-15', '2027-09-16', '2027-09-17',
  // 国庆节：10/1(周五)-10/7(周四)
  '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04',
  '2027-10-05', '2027-10-06', '2027-10-07'
];

/** 内置的全部法定节假日（跨年份）。 */
export const CN_HOLIDAYS = [...CN_HOLIDAYS_2026, ...CN_HOLIDAYS_2027];

/** 北京时间相对 UTC 的分钟偏移。 */
const BEIJING_OFFSET_MINUTES = 8 * 60;

/**
 * 默认价目表（元 / 百万 token）。
 * `off` 为空闲时段单价；高峰时段单价 = 空闲单价 × `peakMultiplier`。
 * `cacheWrite` 缺省时按未命中价计费（DeepSeek 目前不单独报 cacheWrite，恒为 0）。
 */
export const DEFAULT_PRICE_TABLE = {
  version: PRICE_TABLE_VERSION,
  currency: 'CNY',
  symbol: '¥',
  unit: 1e6,
  peakMultiplier: 2,
  // 高峰时段窗口，按北京时间的小时数半开区间 [start, end)
  peakWindows: [[9, 12], [14, 18]],
  // 高峰时段只在周一至周五；1=周一 … 7=周日
  peakWeekdays: [1, 2, 3, 4, 5],
  holidays: CN_HOLIDAYS,
  models: {
    'deepseek-flash': {
      label: 'DeepSeek-V4.1-Flash',
      off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 }
    },
    'deepseek-v4-flash': {
      label: 'DeepSeek-V4.1-Flash（旧模型名）',
      off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 }
    },
    'deepseek-v4-flash-vision-exp': {
      label: 'DeepSeek-V4.1-Flash（视觉实验名）',
      off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 }
    },
    // provider 注册表里的新 id（2026-10-25 合池后不再带 cn:/global: 前缀）。
    // 与 deepseek-v4-flash 同档；显式列出来是为了控制台能显示正确的 label。
    'deepseek-v4.1-flash': {
      label: 'DeepSeek-V4.1-Flash（合池 id）',
      off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 }
    },
    'deepseek-v4-pro': {
      label: 'DeepSeek-V4-Pro-0813',
      off: { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 }
    },
    'deepseek-pro': {
      label: 'DeepSeek-V4-Pro-0813（旧模型名）',
      off: { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 }
    },
    // TODO(价格待确认)：GLM-5.3 是 2026-10-25 合池新加进 provider 注册表的模型，
    // config.json 的 pricing 里没有它的价目，官方价也没查到。这里**先按 flash 档兜底**，
    // 并在 ratesAt() 里标 unverified=true（控制台会提示「价格未核实」）。
    // 拿到真实价目后：改下面 off 的数字，并把 unverified 删掉。
    'glm-5.3': {
      label: 'GLM-5.3（合池，价格待确认）',
      unverified: true,
      off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 }
    }
  },
  // 未知模型的兜底价：按 flash 计，并在返回值里标 estimated=true，控制台会提示。
  fallbackModel: 'deepseek-flash'
};

/** 合并用户配置的价目表覆盖项（config.json 的 `pricing` 字段），失败时回落到默认表。 */
export function resolvePriceTable(override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return { ...DEFAULT_PRICE_TABLE, models: { ...DEFAULT_PRICE_TABLE.models } };
  }
  const merged = {
    ...DEFAULT_PRICE_TABLE,
    ...override,
    models: { ...DEFAULT_PRICE_TABLE.models },
    peakWindows: Array.isArray(override.peakWindows) ? override.peakWindows : DEFAULT_PRICE_TABLE.peakWindows,
    peakWeekdays: Array.isArray(override.peakWeekdays) ? override.peakWeekdays : DEFAULT_PRICE_TABLE.peakWeekdays,
    holidays: Array.isArray(override.holidays) ? override.holidays : DEFAULT_PRICE_TABLE.holidays
  };
  if (override.models && typeof override.models === 'object' && !Array.isArray(override.models)) {
    for (const [name, entry] of Object.entries(override.models)) {
      const base = DEFAULT_PRICE_TABLE.models[name];
      if (!entry || typeof entry !== 'object') continue;
      const given = entry.off ?? {};
      const off = { ...(base?.off ?? DEFAULT_PRICE_TABLE.models[DEFAULT_PRICE_TABLE.fallbackModel].off), ...given };
      // 只有用户/内置条目**自己**没写 cacheWrite 时才跟随 cacheMiss；
      // 否则会从兜底模型继承一个不相干的 cacheWrite 价（静默算错钱）。
      if (!Number.isFinite(Number(given.cacheWrite))) off.cacheWrite = off.cacheMiss;
      const mergedEntry = { label: entry.label ?? base?.label ?? name, off };
      // D49：条目可以自带高峰倍数。MiMo 是**全天同价**（高峰不涨价），只有它需要
      // `peakMultiplier: 1`；以前这里只保留 label 与 off，per-model 的倍数被静默丢掉，
      // 于是所有模型一律乘全局 2 —— MiMo 每笔高峰记账都多算一倍（而 MiMo 恰好在高峰用）。
      // 条目自己没写就沿用内置条目的（内置也没有时，到 ratesAt 里回落全局值）。
      const entryPeak = Number(entry.peakMultiplier);
      const basePeak = Number(base?.peakMultiplier);
      if (Number.isFinite(entryPeak) && entryPeak > 0) mergedEntry.peakMultiplier = entryPeak;
      else if (Number.isFinite(basePeak) && basePeak > 0) mergedEntry.peakMultiplier = basePeak;
      merged.models[name] = mergedEntry;
      // 用户可能把键写成 cn:xxx / v4.1 这类真实 id：顺手登记归一化别名，
      // 这样 token-ledger 记下的原始模型名也能直接命中这一条（不用再靠扫描）。
      const normName = normalizeModelId(name);
      if (normName && normName !== name && !merged.models[normName]) merged.models[normName] = merged.models[name];
    }
  }
  if (typeof merged.fallbackModel !== 'string' || !merged.models[merged.fallbackModel]) {
    merged.fallbackModel = DEFAULT_PRICE_TABLE.fallbackModel;
  }
  if (!Number.isFinite(merged.peakMultiplier) || merged.peakMultiplier <= 0) merged.peakMultiplier = 2;
  if (!Number.isFinite(merged.unit) || merged.unit <= 0) merged.unit = 1e6;
  if (typeof merged.version !== 'string' || !merged.version) merged.version = PRICE_TABLE_VERSION;
  return merged;
}

/** 把任意时间戳换算成北京时间的日历分量（不依赖运行机器的本地时区）。 */
export function beijingParts(atMs) {
  const d = new Date(Number(atMs) + BEIJING_OFFSET_MINUTES * 60000);
  const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // 1=周一 … 7=周日
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return {
    weekday,
    hour: d.getUTCHours(),
    date: `${d.getUTCFullYear()}-${month}-${day}`,
    clock: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  };
}

/** 判断某一时刻是否落在高峰时段。 */
// holidays 在表里永远是**数组**（配置也是数组），所以 isPeakAt 里那个
// `instanceof Set ? ... : new Set(...)` 分支是死代码，而它每条采样都要重造一次 Set。
// series() 会对每条采样 + 每个空桶各调一次 isPeakAt，这个浪费随采样数线性增长。
// 这里按表对象缓存一次：WeakMap 不持有 table、table 更新（换引用）时自动失效。
const holidaysCache = new WeakMap();
export function holidaysOf(table) {
  const raw = table?.holidays;
  if (raw instanceof Set) return raw;
  let set = holidaysCache.get(table);
  if (!set) {
    set = new Set(raw ?? []);
    holidaysCache.set(table, set);
  }
  return set;
}

export function isPeakAt(atMs, table = DEFAULT_PRICE_TABLE) {
  const ms = Number(atMs);
  if (!Number.isFinite(ms)) return false;
  const { weekday, hour, date } = beijingParts(ms);
  if (!table.peakWeekdays.includes(weekday)) return false;
  if (holidaysOf(table).has(date)) return false;
  return (table.peakWindows ?? []).some(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && hour >= start && hour < end);
}

/**
 * 模型 id 归一化：查价前必须先过这一步，否则真实 id 一律 miss、全部按最便宜的 flash 兜底
 * （实测 pro 会少算约 4.8 倍）。
 *
 * 处理两类差异：
 *   ① 区域前缀：`cn:deepseek-v4-pro` / `global:deepseek-v4-pro` → `deepseek-v4-pro`
 *   ② 版本别名：`deepseek-v4.1-flash` → `deepseek-v4-flash`（v4.1 就是 v4 档）
 */
const MODEL_ID_PREFIX_RE = /^\s*(?:cn|global|intl|us|sg|jp|hk)\s*:\s*/i;
const MODEL_ID_ALIASES = {
  // v4.1 与 v4 同价同档，只是 id 写法不同
  'deepseek-v4.1-flash': 'deepseek-v4-flash',
  'deepseek-v4.1-pro': 'deepseek-v4-pro',
  'deepseek-flash-v4.1': 'deepseek-flash',
  'deepseek-pro-v4.1': 'deepseek-pro'
};

/** 把 provider 前缀 / 版本别名归一化成一个价目表键（纯函数，可离线测）。 */
export function normalizeModelId(model) {
  let s = String(model ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(MODEL_ID_PREFIX_RE, '');
  if (MODEL_ID_ALIASES[s]) return MODEL_ID_ALIASES[s];
  // 兜底：任意 vX.Y → vX（v4.1 → v4），glm-5.3 这类不带 v 前缀的不受影响
  const collapsed = s.replace(/\bv(\d+)\.\d+\b/g, 'v$1');
  return MODEL_ID_ALIASES[collapsed] ?? collapsed;
}

/** 按归一化后的 id 找价目条目：先精确键，再归一化键，最后扫一遍键的归一化形式。 */
function lookupModelEntry(table, rawKey) {
  const models = table?.models ?? {};
  if (rawKey && models[rawKey]) return { entry: models[rawKey], key: rawKey };
  const norm = normalizeModelId(rawKey);
  if (!norm) return { entry: null, key: '' };
  if (models[norm]) return { entry: models[norm], key: norm };
  for (const [name, entry] of Object.entries(models)) {
    if (normalizeModelId(name) === norm) return { entry, key: name };
  }
  return { entry: null, key: norm };
}

/**
 * 取某模型在某一时刻生效的单价（含峰谷判定）。
 * @param opts.onUnpriced  命中失败时的回调（每个模型只由调用方报一次），签名 (model) => void
 */
export function ratesAt(model, atMs, table = DEFAULT_PRICE_TABLE, opts = {}) {
  const key = String(model ?? '').trim();
  const found = lookupModelEntry(table, key);
  const entry = found.entry;
  const chosen = entry ?? table.models[table.fallbackModel];
  const off = chosen.off;
  const peak = isPeakAt(atMs, table);
  // D49：高峰倍数**按模型取**——条目自带就用条目的（MiMo 全天同价 = 1），
  // 否则回落全局（DeepSeek 系仍是 ×2）。以前这里一律乘 table.peakMultiplier。
  const entryPeak = Number(chosen?.peakMultiplier);
  const factor = peak ? (Number.isFinite(entryPeak) && entryPeak > 0 ? entryPeak : table.peakMultiplier) : 1;
  if (!entry && typeof opts.onUnpriced === 'function') {
    try { opts.onUnpriced(key || '(空)'); } catch { /* 记日志失败不能影响计价 */ }
  }
  return {
    model: key || table.fallbackModel,
    label: chosen.label,
    tier: peak ? 'peak' : 'off',
    tierLabel: peak ? '高峰时段' : '空闲时段',
    currency: table.currency,
    symbol: table.symbol,
    unit: table.unit,
    estimated: !entry,
    // 条目存在但价格本身没核实（见 DEFAULT_PRICE_TABLE.models['glm-5.3'] 的 TODO）
    unverified: entry?.unverified === true,
    // 这次实际乘上去的倍数（高峰=条目自带或全局；空闲恒 1）：排错时一眼能看出「为什么这笔贵一倍」
    multiplier: factor,
    cacheHit: off.cacheHit * factor,
    cacheMiss: off.cacheMiss * factor,
    cacheWrite: (Number.isFinite(off.cacheWrite) ? off.cacheWrite : off.cacheMiss) * factor,
    output: off.output * factor
  };
}

/**
 * 把 usage 归一化成四个互不重叠的计费桶。
 *
 * 同时接受两种键名，这一点是**必须**的：
 *   - DSH 原始口径：`inputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `outputTokens`；
 *   - 账本落盘口径：`cacheMiss` / `cacheHit` / `cacheWrite` / `output`。
 * 只认一种会在「写盘 → 重新载入」时把桶读成 0（花费凭空少一截），所以两种都读。
 */
export function normalizeUsage(usage) {
  const pick = (value, ...keys) => {
    for (const key of keys) {
      const v = Number(value?.[key]);
      if (Number.isFinite(v) && v > 0) return Math.round(v);
    }
    return 0;
  };
  if (!usage || typeof usage !== 'object') {
    return { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  }
  return {
    // DSH 的 inputTokens 是「未命中」部分，不是总输入。
    cacheMiss: pick(usage, 'cacheMiss', 'uncachedInputTokens', 'inputTokens'),
    cacheHit: pick(usage, 'cacheHit', 'cacheReadTokens'),
    cacheWrite: pick(usage, 'cacheWrite', 'cacheWriteTokens'),
    output: pick(usage, 'output', 'outputTokens'),
    reasoning: pick(usage, 'reasoning', 'reasoningTokens')
  };
}

/** 四个桶求和（token 总量）。 */
export function totalTokensOf(buckets) {
  return (buckets?.cacheMiss ?? 0) + (buckets?.cacheHit ?? 0) + (buckets?.cacheWrite ?? 0) + (buckets?.output ?? 0);
}

/**
 * 按单价把 token 桶折算成金额。
 * @param buckets 归一化后的四个桶
 * @param rates   `ratesAt()` 的返回值
 * @returns 分项金额与合计（单位同 rates.currency）
 */
export function costOfBuckets(buckets, rates) {
  const b = buckets ?? {};
  const cacheHit = ((b.cacheHit ?? 0) / rates.unit) * rates.cacheHit;
  const cacheMiss = ((b.cacheMiss ?? 0) / rates.unit) * rates.cacheMiss;
  const cacheWrite = ((b.cacheWrite ?? 0) / rates.unit) * rates.cacheWrite;
  const output = ((b.output ?? 0) / rates.unit) * rates.output;
  return {
    cacheHit,
    cacheMiss,
    cacheWrite,
    output,
    total: cacheHit + cacheMiss + cacheWrite + output
  };
}

/** 一步到位：给桶 + 时间 + 模型，直接算钱。 */
export function priceUsage(buckets, { model, at, table = DEFAULT_PRICE_TABLE, onUnpriced } = {}) {
  const rates = ratesAt(model, at, table, onUnpriced ? { onUnpriced } : {});
  return { rates, cost: costOfBuckets(buckets, rates) };
}

/** 空桶常量（避免各处重复字面量）。 */
export const ZERO_BUCKETS = Object.freeze({ cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 });

/** 桶相加。 */
export function addBuckets(a, b) {
  return {
    cacheMiss: (a?.cacheMiss ?? 0) + (b?.cacheMiss ?? 0),
    cacheHit: (a?.cacheHit ?? 0) + (b?.cacheHit ?? 0),
    cacheWrite: (a?.cacheWrite ?? 0) + (b?.cacheWrite ?? 0),
    output: (a?.output ?? 0) + (b?.output ?? 0),
    reasoning: (a?.reasoning ?? 0) + (b?.reasoning ?? 0)
  };
}

/** 桶相减（用于「基线之后」的增量），逐桶下限为 0。 */
export function subBuckets(a, b) {
  const s = (x, y) => Math.max(0, (x ?? 0) - (y ?? 0));
  return {
    cacheMiss: s(a?.cacheMiss, b?.cacheMiss),
    cacheHit: s(a?.cacheHit, b?.cacheHit),
    cacheWrite: s(a?.cacheWrite, b?.cacheWrite),
    output: s(a?.output, b?.output),
    reasoning: s(a?.reasoning, b?.reasoning)
  };
}
