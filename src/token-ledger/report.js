// token 账本 —— report.js：由 src/token-ledger.js 机械拆出（纯移动，逻辑未改）。
// 拆分动机：单文件 1088 行 / 单个 createTokenLedger 闭包近 990 行，超代码规模闸（文件≤800、函数≤300）。
import fs from 'node:fs';
import path from 'node:path';
import { ZERO_BUCKETS, addBuckets, isPeakAt, priceUsage, ratesAt, totalTokensOf } from '../model-prices.js';
import { pickBucketMs } from './usage.js';

/**
 * 某时间窗内的逐条采样（按 provider 归集用）。
 *
 * 直接读 ctx.samples（ingest 已按 sampleKey 去重过），不重新解析 JSONL，
 * 也就不可能与 summary 的口径打架。cost 用和 summary 同一个 priceOf 现算。
 */
function samplesSinceOf(ctx, { from = 0, to = 0, key = '' } = {}) {
  const fromMs = Number(from) || 0;
  const toMs = Number(to) || 0;
  const keyWanted = String(key ?? '').trim();
  const rows = [];
  for (const sample of ctx.samples.values()) {
    const t = Number(sample.t) || 0;
    if (fromMs && t < fromMs) continue;
    if (toMs && t >= toMs) continue;
    if (keyWanted && String(sample.key ?? '') !== keyWanted) continue;
    const price = ctx.priceOf(sample.buckets, sample.model, t || ctx.now());
    rows.push({
      sessionId: sample.sessionId,
      key: sample.key,
      t,
      turn: sample.turn,
      step: sample.step,
      retry: sample.retry,
      model: sample.model,
      provider: sample.provider,
      buckets: sample.buckets,
      cost: price.cost.total,
      tier: price.rates.tier
    });
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

export function createReport(ctx, store) {
    function buildIndex() {
      const index = new Map();
      for (const s of ctx.samples.values()) {
        let entry = index.get(s.sessionId);
        if (!entry) {
          entry = {
            liveBuckets: { ...ZERO_BUCKETS },
            liveCost: 0,
            liveByTier: { peak: 0, off: 0 },
            allCost: 0,
            allByTier: { peak: 0, off: 0 },
            estimated: false,
            turns: new Map(),
            models: new Set()
          };
          index.set(s.sessionId, entry);
        }
        const base = ctx.baselines.get(s.sessionId);
        const isLive = !base || s.seq > base.seq;
        const p = ctx.priceOf(s.buckets, s.model, s.t || ctx.now());
        entry.estimated ||= p.rates.estimated;
        entry.allCost += p.cost.total;
        entry.allByTier[p.rates.tier] += p.cost.total;
        if (isLive) {
          entry.liveBuckets = addBuckets(entry.liveBuckets, s.buckets);
          entry.liveCost += p.cost.total;
          entry.liveByTier[p.rates.tier] += p.cost.total;
        }
        // 逐轮明细保留全部采样（含已被基线覆盖的历史回合）：明细是给人看的，
        // 而 attributedCost 只统计「没进基线」的那部分（见 sessionView 里的注释），
        // 两者口径不同是**有意的**——明细给历史，归属只算能对上的钱。
        let row = entry.turns.get(s.turn);
        if (!row) {
          row = {
            sessionId: s.sessionId,
            key: s.key,
            turn: s.turn,
            steps: 0,
            attempts: 0,
            startedAt: s.t,
            endedAt: s.t,
            model: s.model,
            provider: s.provider,
            buckets: { ...ZERO_BUCKETS },
            cost: 0,
            tier: null
          };
          entry.turns.set(s.turn, row);
        }
        row.buckets = addBuckets(row.buckets, s.buckets);
        row.steps += 1;
        row.attempts += s.retry > 0 ? 1 : 0;
        if (s.t < row.startedAt) row.startedAt = s.t;
        if (s.t > row.endedAt) row.endedAt = s.t;
        if (s.model) { row.model = s.model; entry.models.add(s.model); }
        if (s.provider) row.provider = s.provider;
        row.cost += p.cost.total;
        row.tier = row.tier === null || row.tier === p.rates.tier ? p.rates.tier : 'mixed';
      }
      return index;
    }
    /** 把一个会话的索引项 + 投影基线合成「会话视图」。 */
    function sessionView(key, sessionIds, index) {
      const view = {
        key,
        sessionIds,
        sessions: sessionIds.length,
        buckets: { ...ZERO_BUCKETS },
        cost: 0,
        unattributedCost: 0,
        attributedCost: 0,
        byTier: { peak: 0, off: 0 },
        turns: 0,
        steps: 0,
        estimated: false,
        lastAt: 0,
        firstAt: 0,
        models: []
      };
      const models = new Set();
      for (const sid of sessionIds) {
        const base = ctx.baselines.get(sid);
        const entry = index.get(sid) ?? null;
        const gone = store.goneParts(ctx.evicted.get(sid) ?? null);
        const liveBuckets = entry?.liveBuckets ?? { ...ZERO_BUCKETS };
        const cumulative = addBuckets(base?.buckets ?? ZERO_BUCKETS, gone.buckets);
        const total = addBuckets(cumulative, liveBuckets);
        view.buckets = addBuckets(view.buckets, total);

        let cost = (entry?.liveCost ?? 0) + gone.cost;
        view.byTier.peak += (entry?.liveByTier.peak ?? 0) + gone.byTier.peak;
        view.byTier.off += (entry?.liveByTier.off ?? 0) + gone.byTier.off;
        view.estimated ||= (entry?.estimated ?? false) || gone.estimated;
        if (base) {
          const p = ctx.priceOf(base.buckets, base.model, base.t || ctx.now());
          cost += p.cost.total;
          view.byTier[p.rates.tier] += p.cost.total;
          view.estimated ||= p.rates.estimated;
        }
        view.cost += cost;
        if (entry) {
          for (const model of entry.models) models.add(model);
          for (const row of entry.turns.values()) {
            view.steps += row.steps;
            if (!view.firstAt || row.startedAt < view.firstAt) view.firstAt = row.startedAt;
            if (row.endedAt > view.lastAt) view.lastAt = row.endedAt;
          }
          view.turns += entry.turns.size;
        }
        // 能拆到具体某一轮的花费 = **seq 大于基线**的那些采样（entry.liveCost）。
        // 旧写法用 entry.allCost（全部采样），把已经被投影基线覆盖的采样也算了进来 ——
        // 那些采样不在 cost 里，于是 attributed > cost，max(0, cost-attributed) 归零，
        // 两个数相加就比 cost 多（线上实测 +9%）。差额 = 淘汰累计 + 投影基线，
        // 本来就没法拆到具体某一轮。
        const attributed = entry?.liveCost ?? 0;
        view.attributedCost += attributed;
        view.unattributedCost += Math.max(0, cost - attributed);
      }
      view.models = [...models];
      for (const sid of sessionIds) {
        const t = ctx.sessionSeen.get(sid);
        if (t && t > view.lastAt) view.lastAt = t;
      }
      return view;
    }

    /** 某个会话的逐轮明细（新的在前）。 */
    function turnsOf(sessionIds, index) {
      const rows = [];
      for (const sid of sessionIds) {
        const entry = index.get(sid);
        if (entry) rows.push(...entry.turns.values());
      }
      rows.sort((a, b) => b.turn - a.turn || b.endedAt - a.endedAt);
      return rows;
    }

    /** 账本里出现过的全部 sessionId（基线、采样、被淘汰汇总、活动记录四处的并集）。 */
    function allSessionIds() {
      const ids = new Set([...ctx.baselines.keys(), ...ctx.sessionSeen.keys(), ...ctx.evicted.keys()]);
      for (const s of ctx.samples.values()) ids.add(s.sessionId);
      return ids;
    }

    /** 汇总：全局 + 每个会话。 */
    function summary({ limit = 200 } = {}) {
      const index = buildIndex();
      const byKey = new Map();
      for (const sid of allSessionIds()) {
        const key = ctx.keyOf(sid) ?? (ctx.baselines.get(sid)?.key) ?? null;
        const bucketKey = key ?? `未归属:${sid.slice(0, 8)}`;
        if (!byKey.has(bucketKey)) byKey.set(bucketKey, []);
        byKey.get(bucketKey).push(sid); // 同一会话 key 的多个 sessionId 归到一个会话头下
      }
      const conversations = [];
      for (const [key, sids] of byKey) conversations.push(sessionView(key, sids, index));
      conversations.sort((a, b) => b.cost - a.cost || totalTokensOf(b.buckets) - totalTokensOf(a.buckets));

      const totals = {
        buckets: { ...ZERO_BUCKETS }, cost: 0,
        attributedCost: 0, unattributedCost: 0,
        byTier: { peak: 0, off: 0 },
        turns: 0,
        steps: 0,
        conversations: conversations.length,
        estimated: false
      };
      for (const c of conversations) {
        totals.buckets = addBuckets(totals.buckets, c.buckets);
        totals.cost += c.cost;
        totals.attributedCost += c.attributedCost;
        totals.unattributedCost += c.unattributedCost;
        totals.byTier.peak += c.byTier.peak; totals.byTier.off += c.byTier.off;
        totals.turns += c.turns;
        totals.steps += c.steps;
        totals.estimated ||= c.estimated;
      }
      const totalTok = totalTokensOf(totals.buckets);
      const inputTok = totals.buckets.cacheMiss + totals.buckets.cacheHit + totals.buckets.cacheWrite;
      return {
        ok: true,
        generatedAt: ctx.now(),
        priceVersion: ctx.priceTable.version,
        currency: ctx.priceTable.currency,
        symbol: ctx.priceTable.symbol,
        nowTier: ratesAt(undefined, ctx.now(), ctx.priceTable),
        priceTable: {
          version: ctx.priceTable.version,
          currency: ctx.priceTable.currency,
          symbol: ctx.priceTable.symbol,
          unit: ctx.priceTable.unit,
          peakMultiplier: ctx.priceTable.peakMultiplier,
          peakWindows: ctx.priceTable.peakWindows,
          peakWeekdays: ctx.priceTable.peakWeekdays,
          holidayCount: (ctx.priceTable.holidays ?? []).length,
          models: Object.fromEntries(Object.entries(ctx.priceTable.models).map(([name, m]) => [name, { label: m.label, off: m.off }]))
        },
        totals: {
          ...totals,
          totalTokens: totalTok,
          inputTokens: inputTok,
          cacheHitRate: inputTok > 0 ? totals.buckets.cacheHit / inputTok : 0,
          avgCostPerTurn: totals.turns > 0 ? totals.cost / totals.turns : 0,
          avgCostPerStep: totals.steps > 0 ? totals.cost / totals.steps : 0
        },
        billing: { cacheHit: totals.buckets.cacheHit, cacheMiss: totals.buckets.cacheMiss, output: totals.buckets.output, billed: totals.buckets.cacheMiss + totals.buckets.output },
        conversations: conversations.slice(0, Math.max(1, Math.min(500, Number(limit) || 200)))
      };
    }

    /** 单会话明细：汇总 + 逐轮（新的在前）。 */
    function conversation(key, { turnLimit = 200 } = {}) {
      if (typeof key !== 'string' || !key) return null;
      const sids = [];
      for (const sid of allSessionIds()) {
        if (ctx.keyOf(sid) === key) sids.push(sid);
      }
      if (!sids.length) return null;
      const index = buildIndex();
      const view = sessionView(key, sids, index);
      const rows = turnsOf(sids, index);
      return {
        ok: true,
        generatedAt: ctx.now(),
        currency: ctx.priceTable.currency,
        symbol: ctx.priceTable.symbol,
        ...view,
        turnLimit,
        turns: rows.slice(0, Math.max(1, Math.min(1000, Number(turnLimit) || 200)))
      };
    }

    /**
     * 按时间分桶的走势数据（控制台走势图用）。
     *
     * 三个刻意的设计：
     * 1. **单遍扫描**：控制台每 3 秒拉一次，不能是 O(会话×采样) 或多次遍历。
     * 2. **空桶补零**：没有调用的时段必须出现在图里（值为 0），否则"那段时间很安静"
     *    会被画成"那两个小时之间什么都没有"，图会撒谎。
     * 3. **桶的峰谷档位**：桶里只有一种档位就用它；混了就标 `mixed`；**空桶按该时刻
     *    实际属于高峰还是空闲来标** —— 这样即使某段时间完全没用量，图上也能看出
     *    "这段时间本来就是 2 倍价"。
     * 桶宽阶梯与选择规则在模块级（`BUCKET_LADDER_MS` / `pickBucketMs`），离线 fixture 复用同一份。
     */

    /**
     * 某个时间窗内结束的每一轮（工具维度 token 归因用）。
     *
     * 为什么不复用 summary：summary 是「按会话/按群聚合」的口径，工具归因要的是**逐轮**
     * 明细（每轮按工具调用次数均摊），且只要 endedAt 落在窗口里的那批。排序与 turnsOf 一致。
     *
     * 桶口径转换：账本内部是 4 个计费桶（cacheMiss/cacheHit/cacheWrite/output + reasoning），
     * 工具归因对外统一用 {prompt, completion, cached, total}：prompt = 三个输入桶之和，
     * cached 单列（cacheHit），total 只加 prompt+completion（cached 是子集，不重复计数）。
     */
    function toolTurnRow(row) {
      const buckets = row?.buckets ?? {};
      const prompt = (buckets.cacheMiss ?? 0) + (buckets.cacheHit ?? 0) + (buckets.cacheWrite ?? 0);
      const completion = buckets.output ?? 0;
      return {
        sessionId: row.sessionId,
        key: row.key,
        turn: row.turn,
        buckets: { prompt, completion, cached: buckets.cacheHit ?? 0, total: prompt + completion },
        cost: row.cost,
        model: row.model,
        provider: row.provider,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        steps: row.steps,
        attempts: row.attempts,
        tier: row.tier
      };
    }

    function turnsSince(fromMs, { toMs = 0 } = {}) {
      const from = Number(fromMs) || 0;
      const to = Number(toMs) || 0;
      const index = buildIndex();
      return turnsOf(allSessionIds(), index)
        .filter((row) => row.endedAt >= from && (!to || row.endedAt < to))
        .map(toolTurnRow);
    }

    /** 单轮明细（recordTurn 用）：拿不到就返回 null，调用方当「这一轮不入账」处理。 */
    function turnOf(sessionId, turn) {
      if (!sessionId) return null;
      const index = buildIndex();
      const entry = index.get(sessionId);
      const t = Number(turn);
      if (!entry || !Number.isFinite(t)) return null;
      const row = entry.turns.get(t) ?? null;
      return row ? toolTurnRow(row) : null;
    }

  function samplesSince(options) { return samplesSinceOf(ctx, options); }

  return { buildIndex, sessionView, turnsOf, turnsSince, turnOf, samplesSince, allSessionIds, summary, conversation };
}
