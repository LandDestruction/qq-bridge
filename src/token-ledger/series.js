// token 账本 —— series.js：走势（series）、最近明细（recent）、统计（stats）、重置（reset）。
// 由 report.js 再拆一层：代码规模闸把工厂函数体也算函数长度，createReport 455 行超 300 行上限。
// 拆分动机（整条线）：单文件 1088 行 / createTokenLedger 闭包近 990 行，超代码规模闸。
import fs from 'node:fs';
import path from 'node:path';
import { ZERO_BUCKETS, addBuckets, isPeakAt, priceUsage, ratesAt, totalTokensOf } from '../model-prices.js';
import { pickBucketMs } from './usage.js';

export function createSeries(ctx, store, report) {
    function series({ hours = 24, maxBuckets = 48, at } = {}) {
      const endAt = Number.isFinite(Number(at)) ? Number(at) : ctx.now();
      const windowHours = Math.min(24 * 90, Math.max(1, Number(hours) || 24));
      const windowMs = windowHours * 60 * 60 * 1000;
      const bucketMs = pickBucketMs(windowMs, Math.max(6, Math.min(120, Number(maxBuckets) || 48)));
      // 桶边界对齐到 bucketMs 的整数倍，这样刷新之间桶不会"漂移"。
      const end = Math.floor(endAt / bucketMs) * bucketMs + bucketMs;
      const start = end - Math.ceil(windowMs / bucketMs) * bucketMs;
      const count = Math.round((end - start) / bucketMs);

      const rows = [];
      for (let i = 0; i < count; i += 1) {
        const t = start + i * bucketMs;
        rows.push({
          t,
          cost: 0,
          tokens: 0,
          cacheMiss: 0,
          cacheHit: 0,
          cacheWrite: 0,
          output: 0,
          turns: 0,
          steps: 0,
          tier: null,
          keys: new Set()
        });
      }
      const totals = { cost: 0, tokens: 0, turns: 0, steps: 0 };
      let estimated = false;
      let countedSamples = 0;
      // 逐桶的「轮次」去重集合（键 = sessionId|turn）。
      // steps 数的是计费请求（同一回合的多个 step / 重试各算一条），turns 数的是真正的对话轮次；
      // 旧代码把去重集合的键写成 sampleKeyOf(sid, turn, step, retry) —— 那**正是 samples 的键**，
      // 遍历 samples 时每个键天然唯一，去重永不命中，于是 row.turns 恒等于 row.steps：
      // 图上标的「轮次」其实一直是「请求数」，且这层去重是纯粹的死代码。
      const turnSeen = new Set();
      const rowTurnSeen = rows.map(() => new Set());
      // 权威总额（含窗口之外）的三个组成部分，按 report.summary() 的同一口径在**同一次遍历**里累加：
      //   ① 被淘汰采样的累计（evicted）② 投影基线自身 ③ 仍然逐轮可拆、且没被基线覆盖的采样（seq > 基线 seq）。
      // 非 live 采样绝不能计入：基线已经包含了它的历史，再算一次就是重复计费，offChartCost 会凭空变大。
      let ledgerCost = 0;
      let ledgerBuckets = { ...ZERO_BUCKETS };
      // 淘汰累计用 goneParts()：按 atoms 的 seq 精确剔除被基线覆盖的那部分。
      // 旧写法 evictionCovered() 是**全有全无** —— 基线只盖住一半时整块照加，那一半被算了两次，
      // series 的 offChartCost 会凭空变大（partial coverage 场景）。
      for (const e of ctx.evicted.values()) {
        const g = store.goneParts(e);
        ledgerCost += g.cost;
        ledgerBuckets = addBuckets(ledgerBuckets, g.buckets);
      }
      for (const base of ctx.baselines.values()) {
        // 与 sessionView() 同口径：基线没有逐时明细，按快照时刻（缺失时取当前）整体计价。
        ledgerCost += ctx.priceOf(base.buckets, base.model, base.t || ctx.now()).cost.total;
        ledgerBuckets = addBuckets(ledgerBuckets, base.buckets);
      }
      for (const s of ctx.samples.values()) {
        // 这条采样的计价只算一次：窗口内的桶与窗口外的"总额"共用同一个 p。
        const p = ctx.priceOf(s.buckets, s.model, s.t || endAt);
        const tokens = totalTokensOf(s.buckets);
        const base = ctx.baselines.get(s.sessionId);
        if (!base || s.seq > base.seq) {
          ledgerCost += p.cost.total;
          ledgerBuckets = addBuckets(ledgerBuckets, s.buckets);
        }
        if (s.t < start || s.t >= end) continue;
        const idx = Math.min(count - 1, Math.max(0, Math.floor((s.t - start) / bucketMs)));
        const row = rows[idx];
        row.cost += p.cost.total;
        row.tokens += tokens;
        row.cacheMiss += s.buckets.cacheMiss;
        row.cacheHit += s.buckets.cacheHit;
        row.cacheWrite += s.buckets.cacheWrite;
        row.output += s.buckets.output;
        row.steps += 1;
        row.tier = row.tier === null || row.tier === p.rates.tier ? p.rates.tier : 'mixed';
        row.keys.add(ctx.keyOf(s.sessionId) ?? s.key ?? null);
        const turnId = `${s.sessionId}|${s.turn}`;
        if (!rowTurnSeen[idx].has(turnId)) {
          rowTurnSeen[idx].add(turnId);
          row.turns += 1;
        }
        // 窗口级轮次：跨桶的同一回合只算一次（所以各桶 turns 之和 ≥ totals.turns）。
        if (!turnSeen.has(turnId)) {
          turnSeen.add(turnId);
          totals.turns += 1;
        }
        totals.cost += p.cost.total;
        totals.tokens += tokens;
        totals.steps += 1;
        estimated ||= p.rates.estimated;
        countedSamples += 1;
      }
      for (const row of rows) {
        // 空桶也要有档位：用该时刻真实的峰谷归属，而不是留空。
        if (row.tier === null) row.tier = isPeakAt(row.t, ctx.priceTable) ? 'peak' : 'off';
        row.keys = [...row.keys].filter(Boolean);
      }

      let busiest = null;
      for (const row of rows) {
        if (row.cost <= 0) continue;
        if (!busiest || row.cost > busiest.cost) busiest = row;
      }
      // 时间轴之外的那部分（更早的回合 / 投影基线覆盖的历史）。
      //
      // 旧实现在这里调 report.summary({ limit: 1 }) 只为拿一个总额 —— 那是又一次 buildIndex()（全量采样、
      // 每条约一次 priceUsage、还建两层 Map）加逐会话聚合，把控制台每 3 秒轮询一次的最热端点成本
      // 直接翻倍，也违背了本函数头「单遍扫描」的约定。现在用上面同一次遍历累出的权威总额。
      const ledgerTokens = totalTokensOf(ledgerBuckets);
      // totals 必须与 report.summary() 同口径：**含投影基线 + 未被覆盖的淘汰累计**。
      // 旧代码只累加「窗口内的逐条采样」，于是 totals.cost 比 summary 小（实测 0.0028 vs 0.01005，
      // 差 3.6 倍）—— 两条算法各算各的，图表和卡片永远对不上。
      // 现在直接复用同一次遍历算出的 ledgerCost / ledgerBuckets，只保留一条算法。
      totals.cost = ledgerCost;
      totals.tokens = ledgerTokens;
      return {
        ok: true,
        generatedAt: endAt,
        currency: ctx.priceTable.currency,
        symbol: ctx.priceTable.symbol,
        hours: windowHours,
        bucketMs,
        from: start,
        to: end,
        buckets: rows.map(({ keys, ...rest }) => ({ ...rest, keys })),
        totals,
        busiest: busiest ? { t: busiest.t, cost: busiest.cost, tokens: busiest.tokens } : null,
        estimated,
        countedSamples,
        // 时间轴之外的部分：图上画不出来，控制台会单独说明，避免"图上加起来 ≠ 总花费"引起误会。
        // totals 已等于权威总额（含窗口外），这两项保留字段只为兼容老前端，恒为 0。
        offChartCost: 0,
        offChartTokens: 0
      };
    }

    /** 最近采样流水（实时观察用，按时间倒序）。 */
    function recent(limit = 50) {
      const n = Math.max(1, Math.min(500, Number(limit) || 50));
      const all = [...ctx.samples.values()].sort((a, b) => b.t - a.t);
      const out = [];
      for (const s of all.slice(0, n)) {
        const p = ctx.priceOf(s.buckets, s.model, s.t || ctx.now());
        out.push({
          time: s.t,
          key: ctx.keyOf(s.sessionId) ?? s.key ?? null,
          sessionId: s.sessionId,
          turn: s.turn,
          step: s.step,
          retry: s.retry,
          model: s.model ?? null,
          tokens: totalTokensOf(s.buckets),
          ...s.buckets,
          cost: p.cost.total,
          tier: p.rates.tier,
          estimated: p.rates.estimated
        });
      }
      return out;
    }

    /**
     * 当日各会话的「调用次数」：一次采样＝一次模型调用，所以数采样就是数调用。
     * 顺手把轮数、token、花费一起给出去，控制台那张卡能一行看完「谁最费」。
     * 按本地时间的零点切日（控制台是给人看的，跨时区不需要），排序按调用次数倒序。
     */
    function todayByKey(at) {
      const nowMs = Number.isFinite(Number(at)) ? Number(at) : ctx.now();
      const dayStart = new Date(nowMs);
      dayStart.setHours(0, 0, 0, 0);
      const from = dayStart.getTime();
      const acc = new Map();
      for (const s of ctx.samples.values()) {
        const t = Number(s.t) || 0;
        if (t < from) continue;
        const key = ctx.keyOf(s.sessionId) ?? s.key ?? null;
        if (!key) continue;
        let row = acc.get(key);
        if (!row) {
          row = { key, calls: 0, turns: new Set(), tokens: 0, cost: 0 };
          acc.set(key, row);
        }
        row.calls += 1;
        // 轮次必须按 (会话, 轮号) 去重：会话重建后 turn 从 1 重来，只按轮号去重
        // 会把不同会话/重建前后的同号轮并成一 轮，算出来的「每轮调用次数」虚高。
        row.turns.add(String(s.sessionId) + '|' + String(s.turn));
        row.tokens += totalTokensOf(s.buckets);
        row.cost += ctx.priceOf(s.buckets, s.model, t).cost.total;
      }
      const rows = [...acc.values()]
        .map((r) => ({ key: r.key, calls: r.calls, turns: r.turns.size, tokens: r.tokens, cost: Number(r.cost.toFixed(6)) }))
        .sort((a, b) => b.calls - a.calls || b.cost - a.cost);
      return { from, to: nowMs, symbol: ctx.priceTable.symbol, totalCalls: rows.reduce((n, r) => n + r.calls, 0), keys: rows };
    }

    function stats() {
      return {
        file: ctx.file,
        journalLines: ctx.journalLines,
        maxLines: ctx.maxLines,
        droppedLines: ctx.droppedLines,
        sessions: new Set([...ctx.baselines.keys(), ...ctx.sessionSeen.keys()]).size,
        unpricedSamples: ctx.unpricedSamples,
        unpricedCostOmitted: ctx.unpricedCostOmitted,
        trackedSessions: ctx.sessionSeen.size,
        maxTrackedSessions: ctx.MAX_TRACKED_SESSIONS,
        baselines: ctx.baselines.size,
        samples: ctx.samples.size,
        lastIngestAt: ctx.lastIngestAt,
        lastCompactedAt: ctx.lastCompactedAt,
        priceVersion: ctx.priceTable.version
      };
    }

    /** 清空账本（控制台手动重置）。 */
    function reset() {
      ctx.baselines.clear();
      ctx.samples.clear();
      ctx.retryAxis.clear();
      ctx.sessionKeys.clear();
      ctx.sessionSeen.clear();
      // 被淘汰采样汇总是「权威累计」的一部分：漏清它，控制台点完重置仍会报出旧花费，
      // 用户以为没清掉。更隐蔽的是 evictedDirty 若保持 true，下一次 maybeCompact() 会走
      // compact()，把内存里这份 **已经被删掉** 的 evicted 重新序列化回磁盘 ——
      // 「删除」的总额在下一个采样到来时原地复活，而且文件被写坏成"重置前的量"。
      ctx.evicted.clear();
      ctx.evictedDirty = false;
      ctx.droppedLines = 0;
      ctx.lastCompactedAt = 0;
      ctx.journalLines = 0;
      try {
        fs.mkdirSync(path.dirname(ctx.file), { recursive: true });
        fs.writeFileSync(ctx.file, '', { encoding: 'utf8', mode: 0o600 });
      } catch (error) {
        ctx.log('token 账本：重置失败', error?.message ?? error);
      }
      ctx.lastIngestAt = 0;
    }

  return { series, recent, todayByKey, stats, reset };
}
