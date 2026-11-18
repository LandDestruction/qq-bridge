// 上下文预算：给「每步都要重发的会话历史」一条按比例的硬上限。
//
// 为什么需要（D45，用户底线是「不能再这样滚了」）：
//   DSH 每走一步都把**整个会话历史**重发一遍，成本随会话长度线性涨。线上实测 7,130 步、
//   输入 12.9 亿 / 输出 180 万（718:1，告警线 500），每步输入 p50 119k、p90 431k、
//   p99 693k、max 755k token；最长的会话滚到 699 轮。
//   原来的 socialV2.sessionRecycle 只看「消息条数 / 小时数」，不看你实际占了多少上下文：
//   条数 200 条才回收，可 200 条里只要每条都长，单步就能到 70 万 token。
//
// 这里做的不是「省 token 的小优化」，是止损：用 DSH 自己回报的 contextPressure
// （session/projections 的 contextPressure.contextWindow / pressureTokens /
// projectedTokens，口径与 default-workspace\ctx-report.mjs 一致）算一个百分比，
// 超过 maxPressurePct 就退役会话、下一轮重建（复用 bridge 里现成的
// retireSession + saveHandoffDigest + ensureSession 重建，不另起一套）。
//
// 设计取舍：
//   - 默认**关闭**：配置键由用户在 config.json 里加（socialV2.contextBudget），没有该键就完全不动作。
//   - 一律 fail-open：拿不到压力、缺字段、RPC 超时 → 当作「没超」继续用，绝不因为成本检查
//     把正常会话弄坏（这套东西坏了只会多花钱，不该让机器人哑掉）。
//   - RPC 有 TTL + 单飞 + 超时（见 createContextPressureProbe）：压力是慢变量，
//     60 秒问一次足够，绝不每步都打。
//   - 不删人设 / 不缩工具面 / 不动记忆：那是产品决策，成本问题在这里用「换新会话」解决。
import { unwrap } from './dsh-client.js';

export const BUDGET_DEFAULTS = Object.freeze({
  // 2026-10-29 由 55 降到 8：窗口 1M 时 55% 要 55 万 token 才换会话，实测每步输入
  // 中位 82k、p90 193k，等于几乎从不回收；8% ≈ 84k 换新会话，缓存命中率 98%，
  // 重建会话的固定成本远小于继续带着 20 万上下文跑。
  maxPressurePct: 8,
  minTurnsBeforeRecycle: 20
});

/**
 * 读 socialV2.contextBudget 配置。**没有该键 / enabled 不为 true 一律关闭**（用户拍板后才开）。
 * 非法值回落默认而不是抛错：配置写错不该让桥接起不来。
 */
export function budgetConfig(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const maxPct = Number(obj.maxPressurePct);
  const minTurns = Number(obj.minTurnsBeforeRecycle);
  return {
    enabled: obj.enabled === true,
    maxPressurePct: Number.isFinite(maxPct) && maxPct > 0 && maxPct <= 100 ? maxPct : BUDGET_DEFAULTS.maxPressurePct,
    minTurnsBeforeRecycle: Number.isFinite(minTurns) && minTurns >= 0 ? Math.floor(minTurns) : BUDGET_DEFAULTS.minTurnsBeforeRecycle
  };
}

/**
 * 把 `session/projections` 的返回值压成预算判断需要的那几个数。
 * 形状（与 ctx-report.mjs 同一口径）：{kind,asOfSeq,values:{contextPressure:{...},sessionStats:{turns}}}
 * 缺字段 / 窗口为 0 / 预计占用为 0 一律返回 null —— 调用方据此 fail-open。
 */
export function pressureSnapshot(raw) {
  let payload;
  try { payload = unwrap(raw, 'projections'); } catch { payload = raw; }
  const p = payload?.values ?? payload ?? {};
  const cp = p?.contextPressure;
  if (!cp || typeof cp !== 'object') return null;
  const window = Number(cp.contextWindow) || 0;
  const used = Number(cp.pressureTokens) || 0;
  const projected = Number(cp.projectedTokens) || used;
  if (!window || projected <= 0) return null;
  const turns = Number(p?.sessionStats?.turns);
  return {
    window,
    used,
    projected,
    turns: Number.isFinite(turns) ? turns : null,
    pct: Math.round((projected / window) * 1000) / 10
  };
}

/**
 * 纯决策：给定配置与压力快照，返回 keep | recycle | skip。
 * 顺序有意义：关闭 → 无数据 → 轮次不够 → 超线。轮次不够这条是防抖：
 * 刚建好的会话本来就涨得快，没必要每轮都换（换一次要付 digest 交接与重建的代价）。
 */
export function decideBudgetAction(cfg, snap) {
  if (!cfg || cfg.enabled !== true) return { action: 'skip', why: 'disabled', pct: null };
  if (!snap) return { action: 'keep', why: 'no-pressure', pct: null };
  // 注意 Number(null) === 0：轮次缺失必须显式当「未知」，否则会被误判成「0 轮」而永远不回收。
  if (snap.turns === null || snap.turns === undefined) return { action: 'keep', why: 'no-turns', pct: snap.pct };
  const turns = Number(snap.turns);
  if (!Number.isFinite(turns)) return { action: 'keep', why: 'no-turns', pct: snap.pct };
  if (turns < cfg.minTurnsBeforeRecycle) return { action: 'keep', why: 'min-turns', pct: snap.pct };
  if (snap.pct >= cfg.maxPressurePct) return { action: 'recycle', why: 'over-budget', pct: snap.pct };
  return { action: 'keep', why: 'under-budget', pct: snap.pct };
}

const kFmt = (n) => (Number(n) >= 1000 ? `${(Number(n) / 1000).toFixed(1)}k` : String(n));

/**
 * 每次检查打一行（用户要用这行做量化）：
 *   [预算] key=group:100000001 pressure=11.4%~ tokens=119k turns=37 动作=keep why=under-budget
 * pressure 后面那个 `~` 表示这是「预计占用 / 窗口上限」的比例（ctx-report 的 projected 口径）。
 */
export function formatBudgetLog(key, snap, decision) {
  // Number(null) === 0 这个坑：pct 缺失必须打成 ?，不能写成 0%（否则日志会骗人）。
  const rawPct = decision?.pct === null || decision?.pct === undefined ? (snap ? snap.pct : null) : decision.pct;
  const pctNum = rawPct === null || rawPct === undefined || !Number.isFinite(Number(rawPct)) ? null : Number(rawPct);
  const pct = pctNum === null ? '?' : `${pctNum}%`;
  const tokens = snap ? kFmt(snap.projected) : '?';
  const turns = snap && Number.isFinite(Number(snap.turns)) ? String(snap.turns) : '?';
  const why = decision?.why ? ` why=${decision.why}` : '';
  return `[预算] key=${key} pressure=${pct}~ tokens=${tokens} turns=${turns} 动作=${decision?.action ?? 'keep'}${why}`;
}

/**
 * 压力探针：TTL 缓存 + 单飞 + 超时，失败一律返回 null（fail-open）。
 * 与 bridge 里 sessions.list 存活守卫（D34）同一套模式：60 秒 TTL、5 秒超时、
 * 出错后 60 秒内不再重试（DSH 半死时别每条消息都白等 5 秒）。
 *
 * call(sessionId) 由调用方注入（bridge 里是 api.callUnary('session/projections', …)），
 * 这样单测能真跑 TTL/单飞/超时/失败，而不用起 DSH。
 */
export function createContextPressureProbe({ call, ttlMs = 60000, timeoutMs = 5000, now = () => Date.now() } = {}) {
  if (typeof call !== 'function') throw new TypeError('createContextPressureProbe 需要 call(sessionId) 函数');
  const cache = new Map(); // sid -> { at, snap }
  const errors = new Map(); // sid -> at（失败冷却，期间直接返回 null 不打 RPC）
  const inFlight = new Map(); // sid -> Promise（单飞）
  const stats = { calls: 0, failures: 0 };

  async function fetchOnce(sid) {
    stats.calls += 1;
    let timer = null;
    try {
      const raw = await Promise.race([
        Promise.resolve().then(() => call(sid)),
        new Promise((_, reject) => {
          // 不 unref：这个 timer 是「RPC 挂住时唯一的逃生通道」，unref 掉它会让
          // 事件循环空转退出（单测里表现为顶层 await 永不 settle）。finally 里会清掉。
          timer = setTimeout(() => reject(new Error(`contextPressure 超时 ${timeoutMs}ms`)), timeoutMs);
        })
      ]);
      const snap = pressureSnapshot(raw);
      if (!snap) throw new Error('contextPressure 缺字段（窗口/预计占用为空）');
      cache.set(sid, { at: now(), snap });
      errors.delete(sid);
      return snap;
    } catch {
      stats.failures += 1;
      errors.set(sid, now());
      return null; // fail-open：调用方按「没超」继续用
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 取压力，并告诉调用方这次是「真的问了 DSH」还是「吃缓存」。
   * 为什么需要区分：轮末每次都会调一次检查，但 RPC 被 60s TTL 限流；如果每次检查都写一行
   * [预算] 日志，一条 150 字节、每轮一行，会把只有 128KB 的 state/bridge.log 几小时冲干净 ——
   * 用户正是要用这个日志做量化的。所以调用方只在 cached=false（或真要动作为 recycle）时打日志。
   */
  async function getDetail(sessionId) {
    const sid = String(sessionId);
    const hit = cache.get(sid);
    if (hit && now() - hit.at < ttlMs) return { snap: hit.snap, cached: true };
    const errAt = errors.get(sid);
    if (errAt !== undefined && now() - errAt < ttlMs) return { snap: null, cached: false };
    let p = inFlight.get(sid);
    if (!p) {
      p = fetchOnce(sid).finally(() => inFlight.delete(sid));
      inFlight.set(sid, p);
    }
    return { snap: await p, cached: false };
  }

  return {
    getDetail,
    /** 兼容简单调用方：只要快照。 */
    async get(sessionId) { return (await getDetail(sessionId)).snap; },
    stats: () => ({ ...stats, cached: cache.size, cooling: errors.size }),
    /** 仅供测试与 /api 排查用：丢掉缓存（不改变真实 RPC 行为）。 */
    reset: () => { cache.clear(); errors.clear(); inFlight.clear(); stats.calls = 0; stats.failures = 0; }
  };
}

// ── 回收执行器（D51）：回合末检查 + 兜底 sweep + 计数 ────────────────────────
//
// 为什么需要单独一层：D45 只在「回合结束时映射恰好一致」时才检查。2026-10-27 13:14 重启后
// DSH 会恢复「进行中的回合」，那些 frame 的 sessionId 与 state.sessions[key] 不一致 ⇒
// 守卫为假 ⇒ 既不检查也不打日志，group:100000004 在 31 分钟里 5 步烧掉 3.53M（706k/步）而
// [预算] 日志一条都没有。所以这里补两件事：
//   ① 不匹配不再静默 —— 打一行 warn（同一组 (key, 映射 sid, 实际 sid) 只打一次）；
//   ② 兜底 sweep —— 每 N 轮 / 每 10 分钟对白名单里所有 key 主动查一次，不依赖回合末的映射一致。
//
// 设计约束（"坏了最多多花钱，绝不许把正常回复弄没"）：
//   - 任何异常都由调用方/这里 catch 掉，fail-open；
//   - sweep 幂等：刚被回收过的 key 在一个 hold 窗口内不再动（回合末刚回收完，sweep 又砍一刀）；
//   - 仍然受 minTurnsBeforeRecycle 约束（sweep 与回合末同一套决策）。

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig      返回 budgetConfig(...) 的结果（每次现取，支持热加载）
 * @param {(sid: string) => Promise<{snap: object|null, cached?: boolean}>} deps.getPressure 压力探针
 * @param {(key: string, snap: object|null) => number|null} [deps.getTurns] DSH 没回报轮次时的兜底
 * @param {(info: object) => boolean} deps.recycle  真正执行回收；返回 true 表示确实回收了
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {number} [deps.holdMs]  同一 key 两次回收的最小间隔（sweep 幂等窗口）
 */
export function createBudgetRunner({ getConfig, getPressure, getTurns, recycle, log, now = () => Date.now(), holdMs = 10 * 60 * 1000 } = {}) {
  if (typeof getConfig !== 'function' || typeof getPressure !== 'function' || typeof recycle !== 'function') {
    throw new TypeError('createBudgetRunner 需要 getConfig / getPressure / recycle');
  }
  const say = typeof log === 'function' ? log : () => {};
  const counters = {
    checks: 0, recycles: 0, skipsSessionMismatch: 0, skipsNoKey: 0, skipsHeld: 0,
    sweeps: 0, sweepRecycles: 0, errors: 0,
    lastPct: null, lastKey: null, lastAt: null
  };
  const lastRecycleAt = new Map(); // key -> ms
  const lastMismatch = new Map(); // key -> "mapped>actual"（同一组只打一次）
  const short = (sid) => (sid === null || sid === undefined || sid === '' ? '(无)' : String(sid).slice(-8));

  /** 回合末发现映射不一致：不再静默，打一行 warn（同一组只在状态变化时打一次，别每步刷屏）。 */
  function noteMismatch({ key, mappedSid, actualSid }) {
    counters.skipsSessionMismatch += 1;
    const sig = `${short(mappedSid)}>${short(actualSid)}`;
    if (lastMismatch.get(key) === sig) return false;
    lastMismatch.set(key, sig);
    say(`[预算] 跳过 key=${key} 映射=${short(mappedSid)} 实际=${short(actualSid)}（会话已换：不检查，等 sweep 兜底）`);
    return true;
  }
  /** 某个 key 完全没映射（frame 的 sessionId 不在 reverse 里）：同样只记一次。 */
  function noteNoKey(sessionId) {
    counters.skipsNoKey += 1;
    const sig = short(sessionId);
    if (lastMismatch.get('(无 key)') === sig) return false;
    lastMismatch.set('(无 key)', sig);
    say(`[预算] 跳过 未知会话 实际=${sig}（reverse 里没有映射：不检查，等 sweep 兜底）`);
    return true;
  }
  /** 映射恢复正常后清掉去重状态，下次真的再错还能打出来。 */
  function clearMismatch(key) { lastMismatch.delete(key); lastMismatch.delete('(无 key)'); }

  async function evaluate(key, sessionId, source) {
    const cfg = getConfig();
    if (!cfg || cfg.enabled !== true) return { action: 'skip', why: 'disabled', pct: null, recycled: false };
    let detail = null;
    try { detail = await getPressure(sessionId); } catch (error) { counters.errors += 1; detail = null; }
    const snap = detail?.snap ?? null;
    const fresh = detail ? detail.cached !== true : false;
    counters.checks += 1;
    let turns = snap?.turns ?? null;
    if (snap && (turns === null || turns === undefined) && typeof getTurns === 'function') {
      try { turns = getTurns(key, snap); } catch { turns = null; }
    }
    const withTurns = snap && Number.isFinite(Number(turns)) ? { ...snap, turns: Number(turns) } : snap;
    const decision = decideBudgetAction(cfg, withTurns);
    counters.lastPct = withTurns?.pct ?? null;
    counters.lastKey = key;
    counters.lastAt = now();
    // 日志纪律：真查了一次才打 keep 行（吃缓存时不打，免得冲掉 bridge.log）；回收行永远打。
    if (fresh || decision.action === 'recycle') say(formatBudgetLog(key, withTurns, decision));
    if (decision.action !== 'recycle') return { ...decision, recycled: false };

    const lastAt = lastRecycleAt.get(key) ?? 0;
    if (now() - lastAt < holdMs) {
      counters.skipsHeld += 1;
      say(`[预算] ${key} 刚回收过（${Math.round((now() - lastAt) / 1000)}s 前），本次${source}不再回收（幂等）`);
      return { ...decision, recycled: false, why: 'held' };
    }
    let done = false;
    try {
      done = recycle({ key, sessionId, snap: withTurns, limitPct: cfg.maxPressurePct, source }) === true;
    } catch (error) {
      counters.errors += 1;
      say('[预算] 回收失败:', error?.message ?? error);
      return { ...decision, recycled: false, why: 'recycle-error' };
    }
    if (done) {
      counters.recycles += 1;
      lastRecycleAt.set(key, now());
      if (source === 'sweep') counters.sweepRecycles += 1;
    }
    return { ...decision, recycled: done };
  }

  return {
    counters,
    noteMismatch,
    noteNoKey,
    clearMismatch,
    /** 回合末检查（与 D45 同一套决策，只是现在会记账、会打 warn）。 */
    async checkTurn({ key, sessionId }) { return evaluate(key, sessionId, 'turn'); },
    /**
     * 兜底 sweep：对给定的 key→sid 映射逐个查一次。
     * 幂等靠 holdMs：刚回收过的 key 不再动（回合末刚砍完，sweep 不该再砍）。
     */
    async sweep({ sessions } = {}) {
      const cfg = getConfig();
      if (!cfg || cfg.enabled !== true) return { skipped: 'disabled', entries: 0, recycled: 0 };
      const pairs = sessions && typeof sessions === 'object' ? Object.entries(sessions) : [];
      counters.sweeps += 1;
      let recycled = 0;
      for (const [key, sessionId] of pairs) {
        if (!sessionId) continue;
        try {
          const r = await evaluate(key, sessionId, 'sweep');
          if (r.recycled) recycled += 1;
        } catch (error) {
          counters.errors += 1;
          say(`[预算] sweep 检查 ${key} 失败（跳过）:`, error?.message ?? error);
        }
      }
      return { entries: pairs.length, recycled };
    },
    /** /api 观测用快照（含当前配置，省得再猜「开关到底开没开」）。 */
    snapshot() {
      const cfg = getConfig();
      return {
        ...counters,
        enabled: cfg?.enabled === true,
        maxPressurePct: cfg?.maxPressurePct ?? null,
        minTurnsBeforeRecycle: cfg?.minTurnsBeforeRecycle ?? null,
        // 最近一次真回收的时刻（毫秒时间戳，没有回收过就是 null）：比「距离 lastKey 多久」可靠。
        lastRecycleAtMs: lastRecycleAt.size ? Math.max(...lastRecycleAt.values()) : null
      };
    },
    /** 测试用：清空计数与幂等窗口。 */
    reset() {
      for (const k of Object.keys(counters)) counters[k] = null;
      counters.checks = 0; counters.recycles = 0; counters.skipsSessionMismatch = 0; counters.skipsNoKey = 0;
      counters.skipsHeld = 0; counters.sweeps = 0; counters.sweepRecycles = 0; counters.errors = 0;
      lastRecycleAt.clear(); lastMismatch.clear();
    }
  };
}
