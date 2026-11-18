// Token 用量账本 + 价目表测试。
//
// 覆盖点（每一条都对应一个曾经容易写错的地方）：
// 1. 峰谷分时判定按北京时间，且排除中国法定节假日；
// 2. 四个计费桶互不重叠，金额 = Σ(桶 token × 单价)；
// 3. 未知模型走兜底价并标记 estimated；
// 4. 同一 (turn, step, retry) 的采样「后到覆盖先到」，不是累加；
// 5. 重连重放同一批 snapshot 记录不会让用量翻倍（幂等）；
// 6. `llm/retry-started` 之后同一步骤的第二次请求另算一次；
// 7. 权威总量 = 投影基线 + 基线之后 seq 的增量；
// 8. 逐轮明细与「未逐轮归属」差额自洽；
// 9. 半行（进程中断）不会让整个账本读不出来；
// 10. 日志行数超上限会压缩重写且不丢数据。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PRICE_TABLE,
  CN_HOLIDAYS_2026,
  beijingParts,
  costOfBuckets,
  holidaysOf,
  isPeakAt,
  normalizeUsage,
  priceUsage,
  ratesAt,
  resolvePriceTable,
  totalTokensOf
} from '../src/model-prices.js';
import { createTokenLedger, usageOfEvent, usageFromStream } from '../src/token-ledger.js';

let failed = 0;
function assert(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { console.error(`❌ ${label}`); failed = 1; }
}
function near(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-token-ledger-'));
const ledgerFile = path.join(tmpDir, 'token-usage.jsonl');
function freshLedger(opts = {}) {
  try { fs.unlinkSync(ledgerFile); } catch {}
  return createTokenLedger({ file: ledgerFile, priceTable: DEFAULT_PRICE_TABLE, ...opts });
}

// ── 1. 峰谷分时 ─────────────────────────────────────────────────────────
// 北京时间 = UTC+8。2026-03-02 是周一。
const mon = (hhmm) => Date.parse(`2026-03-02T${hhmm}:00+08:00`);
assert(beijingParts(mon('10:00')).weekday === 1, '2026-03-02 是周一');
assert(isPeakAt(mon('10:00')) === true, '周一 10:00 属高峰时段');
assert(isPeakAt(mon('13:00')) === false, '周一 13:00（午休）属空闲时段');
assert(isPeakAt(mon('15:00')) === true, '周一 15:00 属高峰时段');
assert(isPeakAt(mon('08:59')) === false, '周一 08:59 属空闲时段');
assert(isPeakAt(mon('12:00')) === false, '窗口为半开区间：12:00 已不在高峰');
assert(isPeakAt(mon('18:00')) === false, '窗口为半开区间：18:00 已不在高峰');
// 周六（2026-03-07）全天空闲
assert(isPeakAt(Date.parse('2026-03-07T10:00:00+08:00')) === false, '周六 10:00 属空闲时段');
// 节假日：2026-10-01 是周四，但属国庆假期 → 空闲
assert(beijingParts(Date.parse('2026-10-01T10:00:00+08:00')).weekday === 4, '2026-10-01 是周四');
assert(isPeakAt(Date.parse('2026-10-01T10:00:00+08:00')) === false, '国庆节（周四）10:00 属空闲时段');
// 春节段
assert(isPeakAt(Date.parse('2026-02-17T10:00:00+08:00')) === false, '春节（周二）10:00 属空闲时段');
// 节假日表的边界不应误伤相邻工作日
assert(isPeakAt(Date.parse('2026-10-08T10:00:00+08:00')) === true, '2026-10-08（节后周四）10:00 恢复高峰');
assert(CN_HOLIDAYS_2026.length === 33, `2026 法定节假日共 33 天（实得 ${CN_HOLIDAYS_2026.length}）`);

// ── 2. 单价与金额 ───────────────────────────────────────────────────────
const offRates = ratesAt('deepseek-flash', mon('20:00'), DEFAULT_PRICE_TABLE);
const peakRates = ratesAt('deepseek-flash', mon('10:00'), DEFAULT_PRICE_TABLE);
assert(offRates.tier === 'off' && peakRates.tier === 'peak', '同一模型峰谷档位判定正确');
assert(near(peakRates.cacheMiss, offRates.cacheMiss * 2), '高峰单价为空闲单价的 2 倍');
assert(near(offRates.cacheHit, 0.02) && near(offRates.cacheMiss, 1) && near(offRates.output, 4), 'flash 空闲单价与官方一致（0.02/1/4）');

// 100 万 token 各桶 → 正好等于单价
const cost1M = costOfBuckets({ cacheHit: 1e6, cacheMiss: 1e6, cacheWrite: 0, output: 1e6 }, offRates);
assert(near(cost1M.cacheHit, 0.02) && near(cost1M.cacheMiss, 1) && near(cost1M.output, 4), '桶计价 = 单价 × 百万 token');
assert(near(cost1M.total, 5.02), '合计 = 分项之和');

// 桶互不重叠：normalizeUsage 不能把 cacheRead 也算进未命中
const norm = normalizeUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 5 });
assert(norm.cacheMiss === 100 && norm.cacheHit === 900 && norm.cacheWrite === 5 && norm.output === 10,
  'normalizeUsage 四桶互不重叠（inputTokens 只算未命中）');
assert(totalTokensOf(norm) === 1015, 'token 总量 = 四桶之和');

// ── 3. 未知模型兜底 ─────────────────────────────────────────────────────
const unknown = ratesAt('some-future-model', mon('10:00'), DEFAULT_PRICE_TABLE);
assert(unknown.estimated === true, '未知模型标记 estimated');
assert(near(unknown.cacheMiss, 2), '未知模型按 flash 兜底（高峰期 1×2）');
const tbl = resolvePriceTable({ models: { 'my-model': { label: '自定义', off: { cacheHit: 0.5, cacheMiss: 3, output: 9 } } } });
assert(tbl.models['my-model'].off.cacheWrite === 3, '自定义模型未给 cacheWrite 时跟随 cacheMiss');
assert(tbl.models['deepseek-flash'].off.cacheMiss === 1, '自定义覆盖不影响内置模型');

// ── 3b. 按模型的高峰倍数（D49）───────────────────────────────────────────
// 背景：MiMo 全天同价，高峰不涨价；以前 ratesAt 一律乘全局 peakMultiplier=2，
// 于是 MiMo 每笔高峰记账多算一倍（而 MiMo 恰好在高峰用）。
// 这份片段就是交给用户粘进 config.json 的那一份，测试直接用它，保证「给出去的 JSON 是验过的」。
const MIMO_PRICING = {
  models: {
    'mimo-v2.6-pro': { label: 'MiMo-V2.6-Pro', peakMultiplier: 1, off: { cacheHit: 0.025, cacheMiss: 3, cacheWrite: 3, output: 6 } },
    'mimo-v2.6-flash': { label: 'MiMo-V2.6-Flash', peakMultiplier: 1, off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 2 } },
    'mimo-v2.6-pro-ultraspeed': { label: 'MiMo-V2.6-Pro-UltraSpeed', peakMultiplier: 1, off: { cacheHit: 0.25, cacheMiss: 30, cacheWrite: 30, output: 60 } }
  }
};
{
  const t = resolvePriceTable(MIMO_PRICING);
  const peak = ratesAt('deepseek-flash', mon('10:00'), t);
  const idle = ratesAt('deepseek-flash', mon('20:00'), t);
  assert(peak.multiplier === 2 && near(peak.cacheMiss, 2), '没写 peakMultiplier 的模型仍乘全局 2（deepseek 高峰 1→2）');
  assert(idle.multiplier === 1 && near(idle.cacheMiss, 1), '空闲档倍数恒为 1');

  // 条目自己写了 1 → 高峰与空闲同价（全天同价）
  for (const [name, price] of [
    ['mimo-v2.6-pro', { cacheHit: 0.025, cacheMiss: 3, output: 6 }],
    ['mimo-v2.6-flash', { cacheHit: 0.02, cacheMiss: 1, output: 2 }],
    ['mimo-v2.6-pro-ultraspeed', { cacheHit: 0.25, cacheMiss: 30, output: 60 }]
  ]) {
    const p = ratesAt(name, mon('10:00'), t);
    const o = ratesAt(name, mon('20:00'), t);
    assert(p.multiplier === 1 && o.multiplier === 1, `${name} 高峰/空闲倍数都是 1（全天同价）`);
    assert(near(p.cacheMiss, price.cacheMiss) && near(p.output, price.output) && near(p.cacheHit, price.cacheHit),
      `${name} 高峰单价就是真实价（未命中 ${price.cacheMiss} / 输出 ${price.output}）`);
    assert(near(o.cacheMiss, p.cacheMiss), `${name} 空闲价与高峰价相同（不会再 ×2）`);
    assert(p.estimated === false, `${name} 已定价（/api/tokens/summary 不该再报「未定价模型」）`);
    assert(p.unverified !== true, `${name} 不标未核实`);
  }

  // 条目没写 peakMultiplier → 回落全局（不是继承上一个模型的 1）
  const mixed = resolvePriceTable({
    models: {
      'x-flat': { off: { cacheHit: 0.01, cacheMiss: 2, output: 4 }, peakMultiplier: 1 },
      'x-nofield': { off: { cacheHit: 0.01, cacheMiss: 2, output: 4 } }
    }
  });
  assert(ratesAt('x-nofield', mon('10:00'), mixed).multiplier === 2, '条目没写 peakMultiplier 时回落全局 2');
  assert(ratesAt('x-flat', mon('10:00'), mixed).multiplier === 1, '写了 1 的条目不受全局影响');

  // resolvePriceTable 不能把 per-model 字段丢掉（这正是当初的 bug）
  assert(t.models['mimo-v2.6-pro'].peakMultiplier === 1, 'resolvePriceTable 保留了 per-model 的 peakMultiplier');
  assert(t.models['mimo-v2.6-pro'].off.cacheMiss === 3, '合并后 off 价保留');
  assert(t.models['mimo-v2.6-pro'].off.cacheWrite === 3, 'cacheWrite 未给时跟随 cacheMiss');
  // 非法倍数不生效（回落全局）
  const bogus = resolvePriceTable({ models: { 'x-bad': { peakMultiplier: 0, off: { cacheMiss: 1 } } } });
  assert(ratesAt('x-bad', mon('10:00'), bogus).multiplier === 2, 'peakMultiplier 非法（0）时回落全局 2');
}

// ── 3c. 端到端：配了同样的片段后，账本不再报「未定价模型」且按真实价记钱（D49）──
{
  let logs = 0;
  const led = freshLedger({ priceTable: resolvePriceTable(MIMO_PRICING), resolveKey: () => 'group:900', log: () => { logs += 1; } });
  const peakAt = mon('10:00'); // 高峰时段 —— 以前这里会多算一倍
  led.ingestEvent({
    sessionId: 's-mimo',
    event: {
      type: 'assistant/message', seq: 1, time: peakAt,
      data: { turn: 1, step: 1, model: 'mimo-v2.6-pro', provider: 'mimo', usage: { inputTokens: 1e6, outputTokens: 1e6 } }
    }
  });
  const sum = led.summary();
  // 100 万未命中输入（3.00）+ 100 万输出（6.00）= 9.00 元；按旧逻辑会变成 18.00
  assert(Math.abs(sum.totals.cost - 9) < 0.01, `mimo 高峰花费应为真实价 9.00 元（实得 ${sum.totals.cost}）`);
  assert(logs === 0, `/api/tokens/summary 不应再打「未定价模型」日志（实得 ${logs} 条）`);

  // 对照：同一个模型、同样用量，若没配这段价目 → 仍走 flash 兜底并报未定价（确保上面的 0 不是假绿）
  let logs2 = 0;
  const led2 = freshLedger({ priceTable: DEFAULT_PRICE_TABLE, resolveKey: () => 'group:901', log: () => { logs2 += 1; } });
  led2.ingestEvent({
    sessionId: 's-mimo2',
    event: {
      type: 'assistant/message', seq: 1, time: peakAt,
      data: { turn: 1, step: 1, model: 'mimo-v2.6-pro', provider: 'mimo', usage: { inputTokens: 1e6, outputTokens: 1e6 } }
    }
  });
  // 「未定价」提示是在聚合（summary）时打的，不是 ingest 时 —— 所以先取一次汇总再断言。
  const sum2 = led2.summary();
  assert(logs2 === 1, `反向对照：没配价目时确实会打「未定价模型」日志（实得 ${logs2} 条）`);
  assert(Math.abs(sum2.totals.cost - 10) < 0.01, '反向对照：没配价目时按 flash 高峰价算（1×2 + 4×2 = 10）');
}



// ── 4~8. 账本折叠语义 ───────────────────────────────────────────────────
const usage = (inputTokens, outputTokens, cacheReadTokens = 0, extra = {}) =>
  ({ inputTokens, outputTokens, cacheReadTokens, ...extra });
// ⚠️ `time` 必须显式给：账本对**没有时间戳**的采样会回退到 `now()`，
// 而 `now()` 落在高峰时段（周一至周五 9:00-12:00、14:00-18:00）时单价是 2 倍
// ⇒ 这个测试会随"跑测试的时刻"时红时绿（实测：周一 17:29 会失败，12:00-16:00 通过）。
// 这里统一钉到下面的 `at`（周一 20:00，空闲档），让期望值与任何跑测试的时刻无关。
const at = mon('20:00');
const evMsg = (seq, turn, step, u) => ({ seq, time: at, type: 'assistant/message', data: { turn, step, usage: u, model: 'deepseek-flash', provider: 'deepseek-account' } });
const evRetry = (seq, turn, step, retry) => ({ seq, time: at, type: 'llm/retry-started', data: { turn, step, retry } });

let ledger = freshLedger({ resolveKey: (sid) => (sid === 's1' ? 'group:100' : undefined) });

// 流式采样 → 最终结算应覆盖，而不是累加
ledger.ingestEvent({ sessionId: 's1', event: { seq: 10, time: at, type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [{ usage: usage(1000, 50, 0) }] } } });
ledger.ingestEvent({ sessionId: 's1', event: evMsg(11, 1, 1, usage(1200, 80, 4000)) });
let conv = ledger.conversation('group:100');
assert(conv.turns.length === 1, '同一 (turn, step) 只有一行逐轮明细（流式被结算覆盖）');
assert(conv.turns[0].buckets.cacheMiss === 1200 && conv.turns[0].buckets.output === 80,
  '覆盖语义：保留最终结算值 1200/80');
assert(conv.turns[0].steps === 1, 'steps 计为该回合的采样条数（1）');

// 同回合第二个 step 累加
ledger.ingestEvent({ sessionId: 's1', event: evMsg(12, 1, 2, usage(300, 20, 100)) });
conv = ledger.conversation('group:100');
assert(conv.turns[0].steps === 2, '同回合第 2 个 step 计入同一行');
assert(conv.turns[0].buckets.cacheMiss === 1500 && conv.turns[0].buckets.output === 100, '同回合跨 step 累加');
assert(conv.turns.length === 1, '两个 step 仍是同一轮对话');

// 重连重放：同 seq 同内容不得翻倍
const before = ledger.recent(50).length;
ledger.ingestEvent({ sessionId: 's1', event: evMsg(11, 1, 1, usage(1200, 80, 4000)) });
ledger.ingestEvent({ sessionId: 's1', event: evMsg(12, 1, 2, usage(300, 20, 100)) });
assert(ledger.recent(50).length === before, '重连重放同样的事件不新增采样（幂等）');
conv = ledger.conversation('group:100');
assert(conv.turns[0].buckets.cacheMiss === 1500, '重放后用量不翻倍');

// 旧快照不得覆盖新数据：seq 更旧、以及 seq 相等但内容不同，都必须被拒绝
ledger.ingestEvent({ sessionId: 's1', event: evMsg(5, 1, 1, usage(1, 1, 0)) });
conv = ledger.conversation('group:100');
assert(conv.turns[0].buckets.cacheMiss === 1500, 'seq 更旧的采样被拒绝（不回退）');
ledger.ingestEvent({ sessionId: 's1', event: evMsg(11, 1, 1, usage(1, 1, 0)) });
conv = ledger.conversation('group:100');
assert(conv.turns[0].buckets.cacheMiss === 1500, 'seq 相等但内容不同的采样被拒绝（只信严格更新的 seq）');

// 重试轴：同一步骤的第二次请求另算
ledger.ingestEvent({ sessionId: 's1', event: evMsg(20, 2, 1, usage(500, 10, 0)) });
ledger.ingestEvent({ sessionId: 's1', event: evRetry(21, 2, 1, 1) });
ledger.ingestEvent({ sessionId: 's1', event: evMsg(22, 2, 1, usage(600, 12, 0)) });
conv = ledger.conversation('group:100');
const t2 = conv.turns.find((r) => r.turn === 2);
assert(t2.buckets.cacheMiss === 1100 && t2.buckets.output === 22, 'llm/retry-started 之后同一 step 的第二次请求另算一次');
assert(t2.attempts === 1, '重试次数被记录');

// 基线：权威总量 = 基线 + 基线之后的增量
ledger = freshLedger({ resolveKey: () => 'group:100' });
ledger.ingestBaseline({ sessionId: 's1', projection: { asOfSeq: 100, values: { tokenUsage: { uncachedInputTokens: 5000, outputTokens: 500, cacheReadTokens: 50000, cacheWriteTokens: 0 } } }, at: mon('20:00'), model: 'deepseek-flash' });
// seq <= 100 的采样属于基线范围，只进逐轮明细、不再计入总量
ledger.ingestEvent({ sessionId: 's1', event: evMsg(80, 1, 1, usage(5000, 500, 50000)) });
// seq > 100 的采样是增量
ledger.ingestEvent({ sessionId: 's1', event: evMsg(120, 2, 1, usage(1000, 100, 0)) });
let sum = ledger.summary();
let c = sum.conversations.find((x) => x.key === 'group:100');
assert(c.buckets.cacheMiss === 6000, '权威总量 = 基线 5000 + 增量 1000');
assert(c.buckets.cacheHit === 50000, '基线命中量计入总量');
assert(c.buckets.output === 600, '基线输出计入总量');
const expectCost = (5000 / 1e6) * 1 + (50000 / 1e6) * 0.02 + (500 / 1e6) * 4 + (1000 / 1e6) * 1 + (100 / 1e6) * 4;
assert(near(c.cost, expectCost, 1e-9), `花费 = 基线 + 增量，实得 ${c.cost.toFixed(8)} 期望 ${expectCost.toFixed(8)}`);
assert(c.turns === 2, '基线范围内的回合仍出现在逐轮明细里（共 2 轮）');
assert(near(c.unattributedCost, Math.max(0, c.cost - c.attributedCost), 1e-9), '未逐轮归属差额自洽');
assert(near(sum.totals.cost, c.cost, 1e-9), '全局合计 = 各会话之和');
assert(sum.totals.cacheHitRate > 0.85, `缓存命中率按输入桶计算（${(sum.totals.cacheHitRate * 100).toFixed(1)}%）`);

// 峰谷混算：同一会话内高峰与空闲的采样各按各的档位
ledger = freshLedger({ resolveKey: () => 'group:100' });
ledger.ingestEvent({ sessionId: 's1', event: evMsg(10, 1, 1, usage(1e6, 1e6, 0)), at: mon('10:00') }); // 高峰：1 + 4 → ×2
ledger.ingestEvent({ sessionId: 's1', event: evMsg(20, 2, 1, usage(1e6, 1e6, 0)), at: mon('20:00') }); // 空闲：1 + 4
c = ledger.summary().conversations[0];
assert(near(c.cost, (1 + 4) * 2 + (1 + 4)), `峰谷分时计价：高峰轮 ¥10 + 空闲轮 ¥5 = ¥15（实得 ${c.cost}）`);
assert(near(c.byTier.peak, 10) && near(c.byTier.off, 5), '高峰期/空闲期花费分开统计');

// ── 9. 半行容错 ─────────────────────────────────────────────────────────
fs.appendFileSync(ledgerFile, '{"k":"turn","sid":"s1","turn":9,"ste', 'utf8');
ledger = createTokenLedger({ file: ledgerFile, priceTable: DEFAULT_PRICE_TABLE, resolveKey: () => 'group:100' });
assert(ledger.stats().droppedLines === 1, '进程中断留下的半行被跳过而不是让账本读不出来');
assert(ledger.summary().conversations.length === 1, '半行之后仍能读出既有数据');

// ── 10. 压缩与淘汰 ──────────────────────────────────────────────────────
// 逐轮明细超过上限时必须真的淘汰（否则每次采样都会整文件重写），
// 但**累计总量必须精确**——即使这个会话没有投影基线。
ledger = freshLedger({ resolveKey: () => 'group:100', maxLines: 20 });
for (let i = 0; i < 30; i += 1) {
  ledger.ingestEvent({ sessionId: 's1', event: evMsg(1000 + i, i + 1, 1, usage(10, 1, 0)), at: mon('20:00') });
}
const stats = ledger.stats();
assert(stats.samples <= 20, `逐轮明细被压到上限内（实得 ${stats.samples}）`);
assert(stats.journalLines <= 40, `压缩后磁盘行数受控（实得 ${stats.journalLines}）`);
const afterEvict = ledger.summary().totals;
const expectEvictCost = 30 * ((10 / 1e6) * 1 + (1 / 1e6) * 4);
assert(afterEvict.buckets.cacheMiss === 300, `淘汰后累计未命中输入仍为 30×10=300（实得 ${afterEvict.buckets.cacheMiss}）`);
assert(afterEvict.buckets.output === 30, `淘汰后累计输出仍为 30（实得 ${afterEvict.buckets.output}）`);
assert(near(afterEvict.cost, expectEvictCost, 1e-9), `淘汰后累计花费不变（实得 ${afterEvict.cost.toFixed(8)} 期望 ${expectEvictCost.toFixed(8)}）`);
assert(afterEvict.unattributedCost > 0, '被淘汰的回合归入「未逐轮归属」而不是凭空消失');
const reloaded = createTokenLedger({ file: ledgerFile, priceTable: DEFAULT_PRICE_TABLE, resolveKey: () => 'group:100' });
assert(reloaded.stats().samples === stats.samples, '淘汰后重新载入不丢采样');
assert(near(reloaded.summary().totals.cost, afterEvict.cost, 1e-9), '淘汰结果的累计花费可跨重启复现');

// ── 10b. 读取路径是单遍索引：总量不随采样数二次膨胀 ─────────────────────
ledger = freshLedger({ resolveKey: () => 'group:100', maxLines: 5000 });
for (let turn = 1; turn <= 40; turn += 1) {
  for (let step = 1; step <= 5; step += 1) {
    ledger.ingestEvent({ sessionId: 's1', event: evMsg(turn * 100 + step, turn, step, usage(100, 10, 0)), at: mon('20:00') });
  }
}
const multi = ledger.summary();
assert(multi.conversations.length === 1 && multi.conversations[0].turns === 40,
  `40 轮 × 5 步聚合成 40 行逐轮明细（实得 ${multi.conversations[0]?.turns}）`);
assert(multi.totals.steps === 200, `步数统计正确（实得 ${multi.totals.steps}）`);
assert(multi.totals.buckets.cacheMiss === 40 * 5 * 100, '多轮多步累计正确');
const detail = ledger.conversation('group:100');
assert(detail.turns.length === 40 && detail.turns[0].turn === 40, '逐轮明细按回合倒序返回');

// ── 11. 走势分桶（series） ───────────────────────────────────────────────
// 三条不能错的性质：空桶补零（否则图会撒谎）、桶的峰谷档位、图与数字自洽。
ledger = freshLedger({ resolveKey: () => 'group:100' });
const sBase = Date.parse('2026-03-02T09:00:00+08:00'); // 周一 09:00 = 高峰窗口起点
const sAt = sBase + 6 * 3600_000;                      // 观察时刻
const emitAt = (ms, turn, step, u) => ledger.ingestEvent({
  sessionId: 's1',
  event: { seq: turn * 100 + step, time: ms, type: 'assistant/message', data: { turn, step, usage: u, model: 'deepseek-flash', provider: 'deepseek-account' } },
  at: ms
});
// 09:30、09:45（高峰）各一笔；13:00（午休空闲）一笔；中间留出 3 小时空档
const peak1 = sBase + 30 * 60_000;
const peak2 = sBase + 45 * 60_000;
const off1 = sBase + 4 * 3600_000;
emitAt(peak1, 1, 1, usage(1000, 100, 0));
emitAt(peak2, 1, 2, usage(1000, 100, 0));
emitAt(off1, 2, 1, usage(2000, 200, 0));

const ser = ledger.series({ hours: 6, at: sAt });
assert(ser.ok === true && Array.isArray(ser.buckets), 'series 返回桶数组');
assert(ser.bucketMs > 0 && ser.buckets.length > 0, `桶宽与桶数有效（${ser.bucketMs}ms × ${ser.buckets.length}）`);
assert(ser.buckets.length <= 48, `桶数不超过上限（实得 ${ser.buckets.length}）`);
assert(ser.buckets.every((b) => b.t % ser.bucketMs === 0), '桶边界对齐到桶宽整数倍（刷新之间不漂移）');
// 窗口按桶对齐：覆盖最近 hours 小时，起止最多各差一个桶（否则刷新时整条图会抖）
assert(ser.from % ser.bucketMs === 0 && ser.to % ser.bucketMs === 0, '窗口起止也对齐到桶边界');
assert(ser.to - ser.from >= 6 * 3600_000 && ser.to - ser.from < 6 * 3600_000 + ser.bucketMs,
  `窗口长度≈6 小时（实得 ${((ser.to - ser.from) / 3600_000).toFixed(2)}h）`);
assert(ser.buckets.filter((b) => b.cost === 0).length >= 3, '没有调用的时段被补成 0 值桶（不会在图上凭空消失）');
assert(ser.countedSamples === 3, `三笔采样全部落入窗口（实得 ${ser.countedSamples}）`);

// 峰谷档位：09:30/09:45 与 13:00 分别落在高峰与空闲
const tierAt = (ms) => ser.buckets.find((b) => ms >= b.t && ms < b.t + ser.bucketMs)?.tier;
assert(tierAt(peak1) === 'peak', '09:30（周一高峰）的桶标为 peak');
assert(tierAt(off1) === 'off', '13:00（午休空闲）的桶标为 off');
assert(ser.buckets.some((b) => b.tier === 'peak') && ser.buckets.some((b) => b.tier === 'off'),
  '空桶也有档位（图上能看出"这段时间本来就是 2 倍价"）');

// 合计：每笔按自己时刻的峰谷计价（高峰 2 倍）
const expectWindow = 2 * ((1000 / 1e6) * 2 + (100 / 1e6) * 8) + ((2000 / 1e6) * 1 + (200 / 1e6) * 4);
assert(near(ser.totals.cost, expectWindow, 1e-9),
  `窗口合计按各桶自身时刻的峰谷计价（实得 ${ser.totals.cost.toFixed(6)} 期望 ${expectWindow.toFixed(6)}）`);
assert(ser.totals.steps === 3 && ser.totals.turns === 2, `步数 3 / 轮次 2（实得 ${ser.totals.steps}/${ser.totals.turns}）`);
assert(ser.buckets.some((b) => b.t === peak1 - (peak1 % ser.bucketMs) || b.tier === 'peak'), '高峰桶确实存在');
assert(ser.busiest && tierAt(ser.busiest.t) === 'peak', '最贵的一格是高峰那一格');
assert(near(ser.buckets.reduce((s, b) => s + b.cost, 0), ser.totals.cost, 1e-12),
  '各桶花费之和 = 窗口合计（图与数字自洽）');
assert(near(ser.buckets.reduce((s, b) => s + b.tokens, 0), ser.totals.tokens, 1e-9), 'token 同样自洽');
assert(ser.offChartCost >= 0, '给出"时间轴之外"的花费，避免图合计 ≠ 总花费引起误解');

// 窗口大小决定桶宽；窗口外的采样不计入
const wide = ledger.series({ hours: 24 * 30, at: sAt, maxBuckets: 48 });
assert(wide.bucketMs > ser.bucketMs, `更大的窗口用更粗的桶（${ser.bucketMs} → ${wide.bucketMs}）`);
assert(wide.buckets.length <= 48, '放大窗口后桶数仍受上限约束');
const emptyWindow = ledger.series({ hours: 1, at: sBase - 60 * 60 * 1000 });
assert(emptyWindow.countedSamples === 0, '采样发生在窗口之后时不计入');
assert(emptyWindow.buckets.every((b) => b.cost === 0), '窗口内无用量时全为 0 桶');

// ── reset ───────────────────────────────────────────────────────────────
ledger.reset();
assert(ledger.summary().conversations.length === 0, 'reset 清空内存态');
assert(fs.readFileSync(ledgerFile, 'utf8') === '', 'reset 清空磁盘日志');

// ── usageOfEvent ────────────────────────────────────────────────────────
assert(usageOfEvent({ type: 'assistant/message', data: { usage: { inputTokens: 1 } } })?.inputTokens === 1, 'usageOfEvent 优先取 data.usage');
assert(usageFromStream([{ usage: { inputTokens: 7 } }, { text: 'x' }])?.inputTokens === 7, 'usageFromStream 从流尾部找 usage');
assert(usageOfEvent({ type: 'tool/call', data: {} }) === undefined, '非 assistant 事件不产生 usage');

// ── 归属恒等式：attributed + unattributed 必须恒等于 cost ────────────────────
// 线上实测过 +9% 的缺口：attributed 用了「全部采样」的 allCost，而 cost 只含
// 「seq > 基线」的采样 + 基线 + 淘汰累计 —— 被基线覆盖的那部分采样凭空多算一次。
{
  const file = path.join(tmpDir, 'attribution.jsonl');
  const led = createTokenLedger({ file, priceTable: DEFAULT_PRICE_TABLE, resolveKey: () => 'group:100', maxLines: 1000 });
  const t0 = Date.UTC(2026, 5, 1, 4, 0, 0); // 北京时间 12:00，空闲档
  // 第 1、2 条采样先进来（后面会被基线覆盖）
  for (const seq of [1, 2]) {
    led.ingestEvent({
      sessionId: 's-attr',
      event: { type: 'assistant/message', seq, time: t0 + seq * 1000, data: { turn: seq, step: 1, usage: { inputTokens: 1000, outputTokens: 100 }, model: 'deepseek-flash', provider: 'deepseek-account' } }
    });
  }
  // 基线覆盖到 seq=1：seq1 进基线，seq2 仍是「增量」
  led.ingestBaseline({
    sessionId: 's-attr',
    projection: { asOfSeq: 1, values: { tokenUsage: normalizeUsage({ inputTokens: 1000, outputTokens: 100 }) } },
    at: t0 + 2000,
    model: 'deepseek-v4-pro'
  });
  const sum = led.summary();
  const cost = sum.totals.cost;
  const attr = sum.totals.attributedCost;
  const un = sum.totals.unattributedCost;
  assert(Math.abs(attr + un - cost) < 0.01, `attributed+unattributed 必须等于 cost（${attr} + ${un} vs ${cost}）`);
  assert(attr > 0, '至少有一部分花费能拆到具体回合');
  assert(un > 0, '基线带来的花费应落在「未逐轮归属」');
  // 逐会话视图也要自洽
  for (const c of sum.conversations) {
    assert(Math.abs((c.attributedCost + c.unattributedCost) - c.cost) < 0.01, `会话 ${c.key} 的归属不自洽`);
  }
}

// ── 淘汰累计被基线部分覆盖时不得重复计费 ────────────────────────────────────
{
  const file = path.join(tmpDir, 'attribution-evict.jsonl');
  const led = createTokenLedger({ file, priceTable: DEFAULT_PRICE_TABLE, resolveKey: () => 'group:200', maxLines: 2 });
  const t1 = Date.UTC(2026, 5, 1, 4, 0, 0);
  for (const seq of [1, 2, 3, 4]) {
    led.ingestEvent({
      sessionId: 's-ev',
      event: { type: 'assistant/message', seq, time: t1 + seq * 1000, data: { turn: seq, step: 1, usage: { inputTokens: 1000, outputTokens: 100 }, model: 'deepseek-flash', provider: 'deepseek-account' } }
    });
  }
  // maxLines=2 → 前两条被淘汰进 atoms；基线覆盖到 seq=2（正好吃掉被淘汰的那两条）
  led.ingestBaseline({
    sessionId: 's-ev',
    projection: { asOfSeq: 2, values: { tokenUsage: normalizeUsage({ inputTokens: 2000, outputTokens: 200 }) } },
    at: t1 + 5000,
    model: 'deepseek-v4-pro'
  });
  const sum = led.summary();
  const conv = sum.conversations.find((c) => c.key === 'group:200');
  assert(conv, '应有 group:200 会话');
  // 基线 2000/200 + 未覆盖的 seq3/4 2000/200 = 4000/400，不是 6000/600
  const evTokens = conv.buckets.cacheMiss + conv.buckets.cacheHit + conv.buckets.cacheWrite;
  assert(evTokens === 4000, `被基线覆盖的淘汰样本不得重复计入（实得 ${evTokens}，期望 4000）`);
  assert(Math.abs((conv.attributedCost + conv.unattributedCost) - conv.cost) < 0.01, '淘汰场景下归属仍要自洽');
}

// ── snapshot 回填必须带上 model（否则历史行没有 model，只能按兜底价计费）────────
{
  const file = path.join(tmpDir, 'snapshot-model.jsonl');
  const led = createTokenLedger({ file, priceTable: DEFAULT_PRICE_TABLE, resolveKey: () => 'group:100' });
  const records = [
    { type: 'event', event: { type: 'assistant/message', seq: 1, time: Date.now(), data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, model: 'deepseek-v4-pro', provider: 'workbuddy2api' } } }
  ];
  led.ingestSnapshotRecords({ sessionId: 's-snap', records, model: 'deepseek-v4-pro', provider: 'workbuddy2api' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const turnLine = lines.find((l) => l.k === 'turn');
  assert(turnLine, 'snapshot 回填应落盘一条 turn 行');
  assert(turnLine.model === 'deepseek-v4-pro', `回填的 turn 行必须带 model（实得 ${turnLine.model}）`);
  assert(turnLine.provider === 'workbuddy2api', `回填的 turn 行必须带 provider（实得 ${turnLine.provider}）`);
  // 事件自带的 model 优先于调用方透传的兜底值
  const file2 = path.join(tmpDir, 'snapshot-model2.jsonl');
  const led2 = createTokenLedger({ file: file2, priceTable: DEFAULT_PRICE_TABLE, resolveKey: () => 'group:100' });
  led2.ingestSnapshotRecords({
    sessionId: 's-snap2',
    records: [{ type: 'event', event: { type: 'assistant/message', seq: 2, time: Date.now(), data: { turn: 2, step: 1, model: 'deepseek-v4-flash', usage: { inputTokens: 5, outputTokens: 1 } } } }],
    model: 'deepseek-v4-pro'
  });
  const line2 = fs.readFileSync(file2, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.k === 'turn');
  assert(line2?.model === 'deepseek-v4-flash', '事件自带的 model 不得被兜底值覆盖');
}

// ── isPeakAt 不得每条采样都重建节假日 Set ──────────────────────────────────
{
  const table = resolvePriceTable({});
  const h1 = holidaysOf(table);
  const h2 = holidaysOf(table);
  assert(h1 instanceof Set, 'holidays 规范化后应是 Set');
  assert(h1 === h2, '同一张价目表必须复用同一个 Set（旧实现每次 new Set，series 里每条采样都重建一次）');
  assert(resolvePriceTable({ holidays: ['2026-01-01'] })?.holidays?.length === 1, '自定义 holidays 仍以数组形式保留在表上');
  const custom = resolvePriceTable({ holidays: ['2030-05-01'] });
  assert(holidaysOf(custom) !== h1, '换了表就是新 Set（WeakMap 按表缓存，不会串味）');
  assert(holidaysOf(custom).has('2030-05-01'), '自定义节假日生效');
  // 判定本身不受缓存影响
  assert(isPeakAt(Date.UTC(2026, 0, 1, 2, 0, 0), table) === false, '元旦（节假日）不判为高峰');
}

// ── series.totals 必须与 summary.totals 同口径（曾经差 3.6 倍）──────────────
{
  const file = path.join(tmpDir, 'series-totals.jsonl');
  const led = createTokenLedger({ file, priceTable: DEFAULT_PRICE_TABLE, resolveKey: () => 'group:400', maxLines: 2 });
  const t0 = Date.UTC(2026, 5, 1, 4, 0, 0);
  for (const seq of [1, 2, 3, 4]) {
    led.ingestEvent({
      sessionId: 's-series2',
      event: { type: 'assistant/message', seq, time: t0 + seq * 1000, data: { turn: seq, step: 1, usage: { inputTokens: 1000, outputTokens: 100 }, model: 'deepseek-flash', provider: 'deepseek-account' } }
    });
  }
  led.ingestBaseline({
    sessionId: 's-series2',
    projection: { asOfSeq: 1, values: { tokenUsage: normalizeUsage({ inputTokens: 1000, outputTokens: 100 }) } },
    at: t0 + 5000,
    model: 'deepseek-v4-pro'
  });
  const sum = led.summary();
  const ser = led.series({ hours: 24, at: t0 + 6000 });
  const diff = Math.abs(ser.totals.cost - sum.totals.cost);
  assert(diff <= 0.01, `series.totals 必须等于 summary.totals（${ser.totals.cost} vs ${sum.totals.cost}，差 ${diff}）`);
  assert(ser.offChartCost === 0 && ser.offChartTokens === 0, 'offChart 字段保留但恒为 0');
}

// ── 只读路径不得产生副作用（曾经把 unpriced 计数刷到 10300 条日志）──────
{
  const file = path.join(tmpDir, 'unpriced-purity.jsonl');
  let logs = 0;
  const led = createTokenLedger({
    file, priceTable: DEFAULT_PRICE_TABLE, resolveKey: () => 'group:500',
    log: () => { logs += 1; }
  });
  const t0 = Date.UTC(2026, 5, 1, 4, 0, 0);
  led.ingestEvent({ sessionId: 's-unp', event: { type: 'assistant/message', seq: 1, time: t0, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 } } } });
  assert(logs === 1, `首条空 model 应打 1 条日志（实得 ${logs}）`);
  for (let i = 0; i < 100; i += 1) { led.summary(); led.series({ hours: 24, at: t0 + 1000 }); }
  assert(logs === 1, `只读路径不得产生日志（实得 ${logs}）`);
  for (let i = 2; i <= 100; i += 1) {
    led.ingestEvent({ sessionId: 's-unp', event: { type: 'assistant/message', seq: i, time: t0 + i, data: { turn: i, step: 1, usage: { inputTokens: 10, outputTokens: 1 } } } });
  }
  assert(logs === 2, `每 100 条只多 1 条日志（实得 ${logs}）`);
  const st = led.stats();
  assert(st.unpricedSamples === 100, `unpricedSamples 应为 100（实得 ${st.unpricedSamples}）`);
  assert(st.unpricedCostOmitted === 0, '空 model 计 0 成本，省掉的金额为 0');
}

// ── per-session 跟踪结构必须有上限（慢速泄漏：每个会话一条，只增不减）────────
{
  const file = path.join(tmpDir, 'session-cap.jsonl');
  const led = createTokenLedger({ file, priceTable: DEFAULT_PRICE_TABLE, resolveKey: () => 'group:1', maxLines: 100000 });
  const base = Date.UTC(2026, 5, 1, 4, 0, 0);
  for (let i = 0; i < 600; i += 1) {
    led.ingestEvent({
      sessionId: `s-cap-${i}`,
      event: { type: 'assistant/message', seq: 1, time: base + i * 1000, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 }, model: 'deepseek-flash', provider: 'deepseek-account' } }
    });
  }
  const st = led.stats();
  assert(st.trackedSessions <= 500, `跟踪的会话数必须被夹到上限（实得 ${st.trackedSessions}）`);
  assert(st.maxTrackedSessions === 500, '上限常量应为 500');
  // 最新那个必须还在（淘汰的是最久没更新的）
  const newest = led.summary();
  assert(Array.isArray(newest.conversations), 'summary 仍可用');
}

// ── 12. 当日各会话调用次数（todayByKey） ─────────────────────────────────
// 「调用次数」= 采样条数（一步一次模型调用），按本地零点切日；跨会话排序按次数倒序。
{
  const file = path.join(tmpDir, 'today.jsonl');
  const keyMap = { 's-a': 'group:111', 's-b': 'group:222' };
  const led = createTokenLedger({ file, priceTable: DEFAULT_PRICE_TABLE, resolveKey: (sid) => keyMap[sid] ?? null });
  const mk = (sid, turn, step, ms, tokens) => led.ingestEvent({
    sessionId: sid,
    event: { seq: turn * 100 + step, time: ms, type: 'assistant/message', data: { turn, step, usage: usage(tokens, 10, 0), model: 'deepseek-flash', provider: 'deepseek-account' } },
    at: ms
  });
  const at = Date.parse('2026-03-05T15:00:00+08:00');
  const todayMorning = Date.parse('2026-03-05T09:00:00+08:00');
  const yesterday = Date.parse('2026-03-04T22:00:00+08:00');
  mk('s-a', 1, 1, todayMorning, 1000);
  mk('s-a', 1, 2, todayMorning + 60_000, 1000);
  mk('s-a', 2, 1, todayMorning + 120_000, 1000);
  mk('s-b', 1, 1, todayMorning + 180_000, 2000);
  mk('s-a', 3, 1, yesterday, 5000); // 昨天的不能算进今天

  const today = led.todayByKey(at);
  assert(today && Array.isArray(today.keys), 'todayByKey 返回 keys 数组');
  assert(today.totalCalls === 4, `今日调用总数只算今天（实得 ${today.totalCalls}）`);
  assert(today.keys[0].key === 'group:111' && today.keys[0].calls === 3, `调用次数多的排前面（${JSON.stringify(today.keys[0])}）`);
  assert(today.keys[0].turns === 2, `同一 key 的轮数去重（实得 ${today.keys[0].turns}）`);
  assert(today.keys[1].key === 'group:222' && today.keys[1].calls === 1, '第二个会话的次数正确');
  assert(today.keys[1].turns === 1, `不同会话的同号轮各算一轮（实得 ${today.keys[1].turns}）`);
  assert(today.keys.every((k) => k.cost >= 0 && k.tokens > 0), '每条都带 token 与花费');
  assert(today.symbol && today.from <= at, 'todayByKey 带币种与起点时间');
}

// ── 收尾 ────────────────────────────────────────────────────────────────
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

if (failed) {
  console.error('\n❌ token 账本测试失败');
  process.exit(1);
}
console.log('\n🎉 token 账本 / 价目表测试通过');
