// token 账本 —— context.js：由 src/token-ledger.js 机械拆出（纯移动，逻辑未改）。
// 拆分动机：单文件 1088 行 / 单个 createTokenLedger 闭包近 990 行，超代码规模闸（文件≤800、函数≤300）。
import { priceUsage } from '../model-prices.js';
import { DEFAULT_PRICE_TABLE } from '../model-prices.js';

export function createLedgerContext({ file, log = () => {}, priceTable = DEFAULT_PRICE_TABLE, resolveKey, maxLines = 20000, now = () => Date.now() } = {}) {
    /** sessionId -> 最新一条投影基线 */
    const baselines = new Map();
    /** sampleKey -> 采样记录 */
    const samples = new Map();
    /** sessionId -> { turn, step, retry, seq }：重试轴，用于区分同一步骤的多次计费请求 */
    const retryAxis = new Map();
    /** sessionId -> 最近一次见到的会话 key（会话退役后仍可归属到原 QQ 会话） */
    const sessionKeys = new Map();
    /** sessionId -> 被淘汰（只剩累计值、无法再拆到某一轮）的采样汇总 */
    const evicted = new Map();
    let evictedDirty = false;
    /** sessionId -> 最近一次活动时间 */
    const sessionSeen = new Map();
    // per-session 结构以前只增不减（慢速泄漏：每个 DSH 会话一条，几个月后才看得出来）。
    // 这里只淘汰「最后活跃时间」这条记录，**不影响成本**——累计成本在 baselines/samples/evicted
    // 里独立存放，删 sessionSeen 的条目不会丢钱，只丢「最近什么时候活跃过」。
    const MAX_TRACKED_SESSIONS = 500;
    /** 落盘行数（含被覆盖的旧采样），用于决定何时压缩 */
    let journalLines = 0;
    let lastIngestAt = 0;
    let lastCompactedAt = 0;
    let droppedLines = 0;
    /**
     * 未定价模型：真实 id 形如 `cn:deepseek-v4-pro`，价格表曾经一律 miss、全部按最便宜的
     * flash 兜底（pro 少算约 4.8 倍）。model-prices 现在先归一化区域前缀/版本别名，
     * 仍然 miss 的才走兜底价——这里每个模型只报一次，避免每笔采样刷一行日志。
     */
    const unpricedReported = new Set();
    const priceOpts = {
      onUnpriced: (model) => {
        const name = String(model ?? '');
        if (unpricedReported.has(name)) return;
        unpricedReported.add(name);
        log(`⚠️ 未定价模型「${name}」：价格表里没有它，暂按 ${priceTable.fallbackModel} 兜底计价（花费会偏低，请补 pricing.models）`);
      }
    };
    // 摄入侧的 unpriced 计数（**只在摄入时累加**，不要放在 priceOf 里）：
    // priceOf 会被 summary()/series()/recent() 等只读路径反复调用，控制台每 3 秒轮询一次就会
    // 把同一条样本重复计数 —— 之前日志刷到 10300 条就是这么来的假象。
    let unpricedSamples = 0;
    let unpricedCostOmitted = 0;
    let unpricedLogged = 0;
    function touchSession(sid, t) {
      if (!sid || !(Number(t) > (ctx.sessionSeen.get(sid) ?? 0))) return;
      ctx.sessionSeen.set(sid, Number(t));
      const overflow = ctx.sessionSeen.size - ctx.MAX_TRACKED_SESSIONS;
      if (overflow <= 0) return;
      const oldest = [...ctx.sessionSeen.entries()].sort((a, b) => a[1] - b[1]).slice(0, overflow);
      for (const [k] of oldest) ctx.sessionSeen.delete(k);
    }
    function priceOf(buckets, model, at) {
      const name = String(model ?? '').trim();
      if (!name) return { cost: { total: 0 }, rates: { tier: 'off', estimated: true, unpriced: true } };
      return priceUsage(buckets, { model: name, at, table: ctx.priceTable, ...ctx.priceOpts });
    }

    /** 摄入侧记账：每条空 model 样本 +1；首条与每 100 条打一次日志（带 sessionId 与事件类型）。 */
    function noteUnpriced(sessionId, eventType) {
      ctx.unpricedSamples += 1;
      if (ctx.unpricedSamples === 1 || ctx.unpricedSamples % 100 === 0) {
        ctx.unpricedLogged += 1;
        ctx.log(`⚠️ 空 model 采样按 0 成本记账（累计 ${ctx.unpricedSamples} 条，最近来源 sessionId=${sessionId} type=${eventType}）：请检查调用点是否漏传 model`);
      }
    }

    function keyOf(sessionId) {
      let key;
      try {
        key = ctx.resolveKey?.(sessionId);
      } catch {
        key = undefined;
      }
      if (key) {
        ctx.sessionKeys.set(sessionId, key);
        return key;
      }
      return ctx.sessionKeys.get(sessionId);
    }

    // ── 载入 ────────────────────────────────────────────────────────────────

  const ctx = { baselines, samples, retryAxis, sessionKeys, evicted, evictedDirty, sessionSeen, MAX_TRACKED_SESSIONS, journalLines, lastIngestAt, lastCompactedAt, droppedLines, unpricedReported, priceOpts, unpricedSamples, unpricedCostOmitted, unpricedLogged, file, log, now, resolveKey, maxLines, priceTable, touchSession, priceOf, noteUnpriced, keyOf };
  return ctx;
}
