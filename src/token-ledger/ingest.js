// token 账本 —— ingest.js：由 src/token-ledger.js 机械拆出（纯移动，逻辑未改）。
// 拆分动机：单文件 1088 行 / 单个 createTokenLedger 闭包近 990 行，超代码规模闸（文件≤800、函数≤300）。
import { normalizeUsage, totalTokensOf } from '../model-prices.js';
import { sampleKeyOf, usageOfEvent } from './usage.js';

export function createIngest(ctx, store) {
    function ingestEvent({ sessionId, event, origin = 'live', at, model, provider } = {}) {
      if (typeof sessionId !== 'string' || !sessionId || !event || typeof event !== 'object') return false;
      // 时间优先取事件自带的 `time`（Unix 毫秒，由 DSH 写入），它决定峰谷档位；
      // 取不到才回落到「收到时间」，避免机器时钟/重放顺序影响计价。
      const t = Number.isFinite(Number(at)) ? Number(at)
        : (Number.isFinite(Number(event.time)) ? Number(event.time) : ctx.now());
      const seq = Number.isFinite(Number(event.seq)) ? Number(event.seq) : -1;
      const eventModel = model ?? event.data?.model ?? event.data?.usage?.model;
      const eventProvider = provider ?? event.data?.provider;

      if (event.type === 'llm/retry-started') {
        const turn = Number(event.data?.turn);
        const step = Number(event.data?.step);
        if (!Number.isFinite(turn) || !Number.isFinite(step)) return false;
        const retry = Number.isFinite(Number(event.data?.retry)) ? Number(event.data.retry) : 1;
        const axis = ctx.retryAxis.get(sessionId);
        if (axis && axis.seq > seq) return false;
        ctx.retryAxis.set(sessionId, { turn, step, retry, seq });
        return false; // 轴本身不入账
      }

      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return false;
      const raw = usageOfEvent(event);
      if (!raw) return false;
      const turn = Number(event.data?.turn);
      const step = Number(event.data?.step);
      if (!Number.isFinite(turn) || !Number.isFinite(step)) return false;
      const axis = ctx.retryAxis.get(sessionId);
      const retry = axis && axis.turn === turn && axis.step === step ? axis.retry : 0;
      const buckets = normalizeUsage(raw);
      if (totalTokensOf(buckets) === 0) return false;

      // 机器人开的会话由 reverse 映射给出 QQ 会话 key；DSH 桌面端自己开的窗口没有映射，
      // 由调用方传 fallbackKey（external:<工作区>），否则这些用量永远归不了户。
      const key = ctx.keyOf(sessionId) ?? (typeof fallbackKey === 'string' && fallbackKey ? fallbackKey : undefined);
      const sk = sampleKeyOf(sessionId, turn, step, retry);
      const prev = ctx.samples.get(sk);
      if (prev && seq >= 0 && prev.seq >= seq) return false;

      // 空 model 的采样：以前会拿 fallbackModel 的价格静默兜底，日志里只有一行
      // 「未定价模型「(空)」」，查不到来源。现在**保留采样**（丢掉会破坏 cost 恒等式），
      // 但把定位信息（sessionId/turn/step/type）打到日志里，同一组合只报一次。
      const resolvedModel = String(eventModel ?? prev?.model ?? '').trim();
      // 空 model 的归因：摄入时计数一次（只读路径不会再重复计数）。
      // 尝试用「会话最近一次的 model」兜底（重启后 sessionModels 可能为空），兜不住才计 0 成本。
      if (!resolvedModel) ctx.noteUnpriced(sessionId, event.type);
      const record = {
        k: 'turn', t, sid: sessionId, key, seq,
        turn, step, retry,
        model: eventModel ?? prev?.model,
        provider: eventProvider ?? prev?.provider,
        b: buckets
      };
      ctx.samples.set(sk, {
        sessionId, key, seq, t, turn, step, retry,
        model: record.model, provider: record.provider, buckets
      });
      ctx.touchSession(sessionId, t);
      ctx.lastIngestAt = ctx.now();
      store.appendLine(record);
      store.maybeCompact();
      return true;
    }

    /**
     * 摄入 `session/follow` snapshot 帧的投影基线（整条会话日志的权威累计桶）。
     * 语义：基线与「seq 大于 baseline.seq 的采样」相加才是会话总量。
     */
    function ingestBaseline({ sessionId, projection, at, model, provider, key: fallbackKey } = {}) {
      if (typeof sessionId !== 'string' || !sessionId || !projection) return false;
      const values = projection.values ?? projection;
      const tokenUsage = values?.tokenUsage;
      if (!tokenUsage) return false;
      const seq = Number.isFinite(Number(projection.asOfSeq)) ? Number(projection.asOfSeq) : -1;
      const t = Number.isFinite(Number(at)) ? Number(at) : ctx.now();
      const buckets = normalizeUsage(tokenUsage);
      const prev = ctx.baselines.get(sessionId);
      if (prev && prev.seq > seq) return false;
      const key = ctx.keyOf(sessionId);
      const same = prev && prev.seq === seq
        && prev.buckets.cacheMiss === buckets.cacheMiss
        && prev.buckets.cacheHit === buckets.cacheHit
        && prev.buckets.cacheWrite === buckets.cacheWrite
        && prev.buckets.output === buckets.output;
      ctx.baselines.set(sessionId, { sessionId, key, seq, t, model, provider, buckets });
      ctx.touchSession(sessionId, t);
      // 内容与 seq 都没变的重复基线（重连重发）不再落盘：否则每重连一次就多一行，
      // 而 follow 集合只会增长，日志会被无意义地推大。
      if (same) return false;
      ctx.lastIngestAt = ctx.now();
      store.appendLine({
        k: 'base', t, sid: sessionId, key, seq,
        model, provider, b: buckets
      });
      // 基线也要参与压缩判断：重连风暴会在每个会话上各追加一行基线，
      // 只靠 ingestEvent 触发压缩的话，这些行可能永远等不到一次压缩。
      store.maybeCompact();
      return true;
    }

    /** 摄入 snapshot 的全部历史记录（逐轮明细回填）。 */
    function ingestSnapshotRecords({ sessionId, records, at, model, provider } = {}) {
      if (!Array.isArray(records)) return 0;
      let n = 0;
      for (const entry of records) {
        const event = entry?.type === 'event' ? entry.event : entry;
        if (!event || typeof event !== 'object') continue;
        // 事件自己带的 model 优先（那是真实计价依据）；只有它缺失时才用调用方传来的
        // 「桥接已知模型」兜底 —— 否则会把历史里明确写着 pro 的行改写成当前模型。
        const evModel = event.data?.model ?? event.data?.usage?.model ?? model;
        const evProvider = event.data?.provider ?? provider;
        if (ingestEvent({ sessionId, event, origin: 'snapshot', at, model: evModel, provider: evProvider })) n += 1;
      }
      return n;
    }

    // ── 读取 ────────────────────────────────────────────────────────────────

    /** 按 sessionId 取「基线 + 基线之后采样」的权威桶。 */
    /**
     * 单遍索引：一次扫过所有采样，算出每个会话需要的全部聚合量。
     *
     * 为什么必须这么写：控制台每 3 秒拉一次 `/api/tokens/summary`，而它跑在**和 QQ 事件
     * 同一个事件循环**里。原先 summary 对每个会话都重扫一遍全部采样（O(会话数 × 采样数)，
     * 而且 sessionTotals/sessionCost/turnRows 各扫一遍 = 3 倍），几千条采样、几十个会话
     * 就是百万级迭代。这里压成单遍 O(采样数)。
     *
     * 基线单独计价（它没有逐时明细，只能整体按快照时刻的峰谷算），并只把
     * `seq > 基线 seq` 的采样算进「权威累计」，避免和基线重复计费。
     */

  return { ingestEvent, ingestBaseline, ingestSnapshotRecords };
}
