// token 账本 —— store.js：由 src/token-ledger.js 机械拆出（纯移动，逻辑未改）。
// 拆分动机：单文件 1088 行 / 单个 createTokenLedger 闭包近 990 行，超代码规模闸（文件≤800、函数≤300）。
import fs from 'node:fs';
import path from 'node:path';
import { ZERO_BUCKETS, addBuckets, normalizeUsage } from '../model-prices.js';
import { sampleKeyOf } from './usage.js';

export function createStore(ctx) {
    function applyRecord(record, { fromDisk }) {
      if (!record || typeof record !== 'object') return false;
      const sid = record.sid;
      if (typeof sid !== 'string' || !sid) return false;
      if (record.key) ctx.sessionKeys.set(sid, record.key);
      const seq = Number.isFinite(Number(record.seq)) ? Number(record.seq) : -1;
      const t = Number.isFinite(Number(record.t)) ? Number(record.t) : 0;
      const buckets = normalizeUsage(record.b);

      // 被淘汰的逐轮采样：只保留累计桶与花费，不保留回合归属。
      if (record.k === 'evict') {
        const prevEvicted = ctx.evicted.get(sid);
        if (prevEvicted && prevEvicted.dropped >= (Number(record.dropped) || 0)) return false;
        ctx.evicted.set(sid, {
          sessionId: sid,
          key: record.key,
          buckets,
          cost: Number(record.cost) || 0,
          // 逐条原子记录（可选）：{ seq, b, c, t, e }。有它才能按「基线覆盖到哪一条」
          // 精确剔除，而不是全有全无（见 goneParts()）。
          atoms: Array.isArray(record.atoms) ? record.atoms.map((a) => ({ seq: Number(a?.seq) || -1, b: normalizeUsage(a?.b), c: Number(a?.c) || 0, t: a?.t === 'peak' ? 'peak' : 'off', e: a?.e === true })) : null,
          byTier: {
            peak: Number(record.peak) || 0,
            off: Number(record.off) || 0
          },
          estimated: record.estimated === true,
          dropped: Number(record.dropped) || 0,
          maxSeq: Number.isFinite(Number(record.maxSeq)) ? Number(record.maxSeq) : -1
        });
        ctx.touchSession(sid, t);
        return true;
      }

      if (record.k === 'base') {
        const prev = ctx.baselines.get(sid);
        if (prev && prev.seq > seq) return false; // 旧基线不得覆盖新基线
        ctx.baselines.set(sid, {
          sessionId: sid,
          key: record.key,
          seq,
          t,
          model: record.model,
          provider: record.provider,
          buckets
        });
        ctx.touchSession(sid, t);
        return true;
      }

      if (record.k === 'turn') {
        const turn = Number(record.turn);
        const step = Number(record.step);
        const retry = Number.isFinite(Number(record.retry)) ? Number(record.retry) : 0;
        if (!Number.isFinite(turn) || !Number.isFinite(step)) return false;
        const sk = sampleKeyOf(sid, turn, step, retry);
        const prev = ctx.samples.get(sk);
        // 幂等关键：只有 seq **严格更新**才允许覆盖。
        // 相等 seq 只可能是同一条事件的重放（重连时 snapshot 会重发），
        // 若放行「相等 seq 覆盖」，旧快照就能把新数据改小 —— 花费会凭空缩水。
        if (prev && seq >= 0 && prev.seq >= seq) return false;
        ctx.samples.set(sk, {
          sessionId: sid,
          key: record.key,
          seq,
          t,
          turn,
          step,
          retry,
          model: record.model,
          provider: record.provider,
          buckets
        });
        const axis = ctx.retryAxis.get(sid);
        if (!axis || axis.seq <= seq) ctx.retryAxis.set(sid, { turn, step, retry, seq });
        ctx.touchSession(sid, t);
        return true;
      }
      return false;
    }

    function load() {
      ctx.baselines.clear();
      ctx.samples.clear();
      ctx.retryAxis.clear();
      ctx.sessionKeys.clear();
      ctx.sessionSeen.clear();
      ctx.journalLines = 0;
      ctx.droppedLines = 0;
      let raw;
      try {
        raw = fs.readFileSync(ctx.file, 'utf8');
      } catch {
        return; // 首次运行：文件还不存在
      }
      const lines = raw.split('\n');
      for (const line of lines) {
        if (!line) continue;
        ctx.journalLines += 1;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          ctx.droppedLines += 1; // 进程中断留下的半行：跳过
          continue;
        }
        try {
          applyRecord(record, { fromDisk: true });
        } catch (error) {
          ctx.droppedLines += 1;
          ctx.log('token 账本：丢弃无法应用的行', error?.message ?? error);
        }
      }
    }

    // ── 落盘 ────────────────────────────────────────────────────────────────
    function appendLine(record) {
      try {
        fs.mkdirSync(path.dirname(ctx.file), { recursive: true });
        fs.appendFileSync(ctx.file, `${JSON.stringify(record)}\n`, 'utf8');
        ctx.journalLines += 1;
        return true;
      } catch (error) {
        ctx.log('token 账本：写入失败', error?.message ?? error);
        return false;
      }
    }

    /**
     * 把内存态整体重写回磁盘：顺带丢掉被覆盖的旧采样，控制文件体积。
     */
    function compact() {
      const out = [];
      for (const base of ctx.baselines.values()) {
        out.push({
          k: 'base', t: base.t, sid: base.sessionId, key: base.key, seq: base.seq,
          model: base.model, provider: base.provider, b: base.buckets
        });
      }
      for (const s of ctx.samples.values()) {
        out.push({
          k: 'turn', t: s.t, sid: s.sessionId, key: s.key, seq: s.seq,
          turn: s.turn, step: s.step, retry: s.retry,
          model: s.model, provider: s.provider, b: s.buckets
        });
      }
      for (const e of ctx.evicted.values()) {
        out.push({
          k: 'evict', t: ctx.sessionSeen.get(e.sessionId) ?? 0, sid: e.sessionId, key: e.key,
          b: e.buckets, cost: e.cost, peak: e.byTier.peak, off: e.byTier.off,
          estimated: e.estimated, dropped: e.dropped, maxSeq: Number(e.maxSeq) >= 0 ? Number(e.maxSeq) : -1,
          // 原子记录落盘才谈得上跨重启的精确剔除；没有它只能退回全有全无。
          ...(Array.isArray(e.atoms) ? { atoms: e.atoms } : {})
        });
      }
      try {
        fs.mkdirSync(path.dirname(ctx.file), { recursive: true });
        const tmp = `${ctx.file}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
        fs.writeFileSync(tmp, out.map((r) => `${JSON.stringify(r)}\n`).join(''), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, ctx.file);
        ctx.journalLines = out.length;
        ctx.evictedDirty = false;
        ctx.lastCompactedAt = ctx.now();
        return true;
      } catch (error) {
        ctx.log('token 账本：压缩失败', error?.message ?? error);
        return false;
      }
    }

    /**
     * 淘汰最旧的逐轮采样，把内存与磁盘都压在 maxLines 条以内。
     *
     * 为什么必须有淘汰：`compact()` 只是把内存态「重写」一遍 —— 如果内存本身无限增长，
     * 那么一旦条数越过上限，**之后每一条采样**都会触发一次整文件同步重写（多 MB 的
     * JSONL 写在 QQ 事件路径上），而且内存会一直涨。所以压缩必须真的丢东西。
     *
     * 关键：**丢明细不能丢总量**。被淘汰的采样先把桶累加进 `evicted`（连同它自己那一次的
     * 计价结果），读取时照样算进权威累计；只是这些旧回合不再能拆到具体某一轮，控制台会
     * 把它归进「未逐轮归属」。这样即使某个会话还没有投影基线，总量也依然精确。
     */
    function evictOldestSamples() {
      const overflow = ctx.samples.size - ctx.maxLines;
      if (overflow <= 0) return 0;
      const ordered = [...ctx.samples.entries()].sort((a, b) => a[1].t - b[1].t);
      for (let i = 0; i < overflow; i += 1) {
        const [sampleId, sample] = ordered[i];
        ctx.samples.delete(sampleId);
        const acc = ctx.evicted.get(sample.sessionId) ?? {
          sessionId: sample.sessionId,
          key: sample.key,
          buckets: { ...ZERO_BUCKETS },
          cost: 0,
          byTier: { peak: 0, off: 0 },
          estimated: false,
          dropped: 0,
          atoms: [],
          // 被淘汰采样里最大的 seq：一旦更新的投影基线覆盖到它，这些桶就已经包含在
          // 基线里了，再相加就是重复计费（见 evictionCovered()）。
          maxSeq: -1
        };
        acc.buckets = addBuckets(acc.buckets, sample.buckets);
        const sampleSeq = Number(sample.seq);
        if (Number.isFinite(sampleSeq) && sampleSeq >= 0) {
          acc.maxSeq = Math.max(Number(acc.maxSeq) >= 0 ? Number(acc.maxSeq) : -1, sampleSeq);
        }
        const p = ctx.priceOf(sample.buckets, sample.model, sample.t || ctx.now());
        if (Array.isArray(acc.atoms)) acc.atoms.push({ seq: Number.isFinite(Number(sample.seq)) ? Number(sample.seq) : -1, b: { ...sample.buckets }, c: p.cost.total, t: p.rates.tier === 'peak' ? 'peak' : 'off', e: p.rates.estimated === true });
        acc.cost += p.cost.total;
        acc.byTier[p.rates.tier] += p.cost.total;
        acc.estimated ||= p.rates.estimated;
        acc.dropped += 1;
        if (sample.key) acc.key = sample.key;
        ctx.evicted.set(sample.sessionId, acc);
        ctx.evictedDirty = true;
      }
      return overflow;
    }

    /**
     * 被淘汰的累计桶是否已经被更**新的投影基线**整块覆盖。
     *
     * 为什么必须判断：基线（session/follow 快照的 tokenUsage）本身就是"整条会话日志"的
     * 权威累计，包含 seq <= asOfSeq 的全部事件；而淘汰桶没有 seq，旧代码无条件把它和基线
     * 相加 —— 一旦重连后拿到的基线覆盖了被淘汰的采样，这部分 token 与花费就被算了两遍
     * （实测 +33%，且只有 reset() 能清掉）。
     */
    function evictionCovered(entry) {
      if (!entry) return false;
      const base = ctx.baselines.get(entry.sessionId);
      const maxSeq = Number(entry.maxSeq);
      if (!base || !Number.isFinite(maxSeq) || maxSeq < 0) return false;
      return Number(base.seq) >= maxSeq;
    }

    /**
     * 被淘汰的累计桶里，**还该算进总量**的那一部分。
     *
     * 旧实现是全有全无（evictionCovered：只有基线 seq 盖住最大那条才整块丢弃），
     * 基线只盖住一半时整块照加 —— 那部分 token 与花费就被算了两次。
     * 有 atoms（逐条 seq/桶/价）时按 `seq > 基线 seq` 精确累加；老记录没有 atoms，
     * 退回全有全无，行为与以前一致。
     */
    function goneParts(gone) {
      const out = { buckets: { ...ZERO_BUCKETS }, cost: 0, byTier: { peak: 0, off: 0 }, estimated: false, counted: 0 };
      if (!gone) return out;
      const base = ctx.baselines.get(gone.sessionId);
      const baseSeq = base && Number.isFinite(Number(base.seq)) ? Number(base.seq) : null;
      const atoms = Array.isArray(gone.atoms) ? gone.atoms : null;
      if (atoms) {
        for (const a of atoms) {
          const seq = Number(a?.seq);
          if (baseSeq !== null && Number.isFinite(seq) && seq >= 0 && seq <= baseSeq) continue;
          out.buckets = addBuckets(out.buckets, a?.b ?? ZERO_BUCKETS);
          const c = Number(a?.c) || 0;
          out.cost += c;
          if (a?.t === 'peak') out.byTier.peak += c; else out.byTier.off += c;
          if (a?.e === true) out.estimated = true;
          out.counted += 1;
        }
        return out;
      }
      if (evictionCovered(gone)) return out;
      out.buckets = { ...gone.buckets };
      out.cost = Number(gone.cost) || 0;
      out.byTier = { peak: gone.byTier?.peak ?? 0, off: gone.byTier?.off ?? 0 };
      out.estimated = gone.estimated === true;
      out.counted = gone.dropped ?? 0;
      return out;
    }

    function maybeCompact() {
      if (ctx.journalLines <= ctx.maxLines && ctx.samples.size <= ctx.maxLines && !ctx.evictedDirty) return;
      const dropped = evictOldestSamples();
      if (dropped > 0) ctx.log(`token 账本：逐轮明细超过 ${ctx.maxLines} 条，已淘汰最旧的 ${dropped} 条（累计总量不受影响）`);
      compact();
    }

    // ── 摄入 ────────────────────────────────────────────────────────────────

    /**
     * 摄入一条会话事件。
     * @param {object} args
     * @param {string} args.sessionId
     * @param {object} args.event       SessionEvent（含 seq/type/data）
     * @param {'live'|'snapshot'} [args.origin] 事件来源；仅用于统计，两路都走同一套幂等折叠
     * @param {number} [args.at]        事件时间（缺省用事件自带的 time）
     * @param {string} [args.model]     实际模型（调用方按会话跟踪；缺省尝试从事件里取）
     * @param {string} [args.provider]
     * @returns {boolean} 是否产生了新的账本记录
     */

  return { applyRecord, load, appendLine, compact, evictOldestSamples, evictionCovered, goneParts, maybeCompact };
}
