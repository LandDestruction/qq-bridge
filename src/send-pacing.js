// send-pacing: 全局发送节奏（防 QQ 风控 + 更像人）。
//
// 规则：
// - 两条消息之间至少 minGapMs；间隔随「上一条消息的字数」增加（perCharMs × 字数）；
// - 有上限 maxGapMs（一条两千字长文不该让下一条等半分钟）；
// - 语音前后留 voiceGapMs（合成完立刻又发一条，最容易触发风控）；
// - 表情例外：stickerGapMs（默认 500ms）就够，斗图不该像幻灯片。
//
// 这里是纯函数 + 一个带状态的时间片分配器：状态由调用方（bootConsoleAndSend）持有，
// 依赖（sleep/log/cfg）也从调用方注入 —— 这样能直接单测，不用起整个桥接。
export const PACING_DEFAULTS = Object.freeze({
  enabled: true,
  minGapMs: 1400,
  perCharMs: 90,
  maxGapMs: 12000,
  voiceGapMs: 4000,
  stickerGapMs: 500,
  imageGapMs: 1500,
  jitterMs: 300
});

/** 从 config（socialV2.pacing 或直接给 pacing 段）读出一份规整后的参数。 */
export function pacingOptions(cfg) {
  const raw = (cfg && cfg.socialV2 && cfg.socialV2.pacing)
    || (cfg && cfg.pacing)
    || cfg
    || {};
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    enabled: raw.enabled !== false,
    minGapMs: num(raw.minGapMs, PACING_DEFAULTS.minGapMs, 0, 60000),
    perCharMs: num(raw.perCharMs, PACING_DEFAULTS.perCharMs, 0, 5000),
    maxGapMs: num(raw.maxGapMs, PACING_DEFAULTS.maxGapMs, 0, 120000),
    voiceGapMs: num(raw.voiceGapMs, PACING_DEFAULTS.voiceGapMs, 0, 120000),
    stickerGapMs: num(raw.stickerGapMs, PACING_DEFAULTS.stickerGapMs, 0, 60000),
    imageGapMs: num(raw.imageGapMs, PACING_DEFAULTS.imageGapMs, 0, 120000),
    jitterMs: num(raw.jitterMs, PACING_DEFAULTS.jitterMs, 0, 60000)
  };
}

/**
 * 算出「上一条是 prev、这一条是 next」之间至少要隔多久（毫秒）。
 * prev/next 形如 {kind:'text'|'sticker'|'image'|'voice', chars:number}
 */
export function planSendGap(prev, next, options = PACING_DEFAULTS) {
  const o = options || PACING_DEFAULTS;
  if (!o.enabled) return 0;
  const prevKind = String((prev && prev.kind) || '');
  const kind = String((next && next.kind) || 'text');
  // 表情：斗图是一来一回的，间隔短得多，也不看字数。
  if (kind === 'sticker') return Math.max(0, Math.round(o.stickerGapMs));
  const prevChars = Math.min(400, Math.max(0, Number((prev && prev.chars) || 0)));
  let gap = o.minGapMs + o.perCharMs * prevChars;
  gap = Math.min(o.maxGapMs, Math.max(o.minGapMs, gap));
  if (kind === 'voice' || prevKind === 'voice') gap = Math.max(gap, o.voiceGapMs);
  if (kind === 'image') gap = Math.max(gap, o.imageGapMs);
  return Math.max(0, Math.round(gap));
}

/** 新开一个时间片分配器的状态（进程内全局共用一份）。 */
export function createPacingState() {
  return { chain: Promise.resolve(), last: { at: 0, kind: '', chars: 0 } };
}

/**
 * 领一个发送时间片：排在上一个后面，等够间隔再返回。
 * ctx = { state, cfg:()=>配置, sleep, log, now, random }
 */
export function reserveSendSlot(ctx, kind, payload) {
  const state = ctx.state;
  const run = state.chain.then(async () => {
    const options = pacingOptions(typeof ctx.cfg === 'function' ? ctx.cfg() : ctx.cfg);
    const chars = typeof payload === 'string' ? payload.length : 0;
    const gap = planSendGap(state.last, { kind, chars }, options);
    if (state.last.at && gap > 0) {
      const random = typeof ctx.random === 'function' ? ctx.random : Math.random;
      const jitter = options.jitterMs > 0 ? Math.floor(random() * options.jitterMs) : 0;
      const waitMs = state.last.at + gap + jitter - (typeof ctx.now === 'function' ? ctx.now() : Date.now());
      if (waitMs > 0) {
        if (typeof ctx.log === 'function') ctx.log(`[节奏] ${kind} 等 ${waitMs}ms（上一条 ${state.last.kind}/${state.last.chars} 字）`);
        await ctx.sleep(waitMs);
      }
    }
    state.last = { at: typeof ctx.now === 'function' ? ctx.now() : Date.now(), kind, chars };
    return { kind, gap, chars };
  });
  // 队列不能因为一次等待失败就断掉：后面还要继续发。
  state.chain = run.then(() => {}, () => {});
  return run;
}
