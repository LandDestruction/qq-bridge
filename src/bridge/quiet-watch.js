// quiet-watch: 「偶尔才看一眼群」的注意力仲裁。
//
// 为什么需要：群里每条消息都要过一遍触发判定（@ / 叫名字 / 关键词 / 提问 / 概率），
// 命中就唤醒一次模型；再加上「说完 30 秒回看」（replyCheck）和定时主动检查
// （proactiveCheck），在热闹的群里表现就是一直在接话——群友反馈「太吵」。
//
// 这里给每个「群」会话加两态，私聊完全不参与（对方发消息就是叫你）：
//   sleeping（默认）：只有「被点名」才算唤醒——@ / 引用你 / 叫名字 / 指定成员 / 拍一拍。
//                     关键词、提问、概率一律吞掉；replyCheck / proactiveCheck 也不再排。
//                     为了不装死，每 glanceMinMs~glanceMaxMs 排一次「抬眼」定时器，
//                     命中 glanceProbability 才真的唤醒一次（叫醒也不进入在场态）。
//   engaged：被点名后进入，engagedMs 内保持「在场」——关键词/提问/概率照常生效，
//            自己每发一条消息都把在场时间续到 lastAiReplyAt + engagedMs；
//            到期没人再叫你，自动退回 sleeping。
//
// 为什么用「最后一次自己发言」当续期依据：真人也是这样——你接了话，话题就还在你这里；
// 你不说了、别人也散了，六分钟后你自然就不在场了。用「最后一条群消息」续期会让热闹群里
// 永远在场（正是要修的行为）。
//
// 状态不放 st 上：st 会被 saveSocialV2State 白名单序列化，混进定时器句柄等于给状态文件埋雷。
// 进程重启后一律从 sleeping 开始，这也正是想要的行为。

export const QUIET_DEFAULTS = Object.freeze({
  enabled: true,
  groupsOnly: true,
  engagedMs: 6 * 60 * 1000,
  glanceMinMs: 8 * 60 * 1000,
  glanceMaxMs: 20 * 60 * 1000,
  glanceProbability: 0.5,
  // 「被点名」：命中任何一种都算有人对你说活，立刻进入在场态。
  hardTriggers: Object.freeze(['atMention', 'nameMention', 'speaker', 'poke', 'private', 'admin', 'bootstrap'])
});

const SUPPRESS_LOG_GAP_MS = 60000;

// 触发源会带子类型：`speaker:阿宝`、`keyword:小鲸鱼`、`atMention@seq194`（见 wake-prompts 的注释）。
// 归一到基名后才能和 hardTriggers 比对——只按 ':' 切会把 `atMention@seq194` 当成另一个词，
// 结果就是「潜水期被 @ 也被吞掉了」。
export function triggerBase(reason) {
  return String(reason ?? '').split(/[:@]/)[0];
}

export function normalizeQuietSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const num = (value, fallback, min) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  const minGlance = num(src.glanceMinMs, QUIET_DEFAULTS.glanceMinMs, 1000);
  // 上界只保证「不早于下界」：写小了就钳到下界，写坏了才回默认，避免配置成 1 秒一次抬眼。
  const rawMax = Number(src.glanceMaxMs);
  const maxGlance = Number.isFinite(rawMax)
    ? Math.max(minGlance, rawMax)
    : Math.max(minGlance, QUIET_DEFAULTS.glanceMaxMs);
  const probability = Number(src.glanceProbability);
  const hard = Array.isArray(src.hardTriggers) && src.hardTriggers.length
    ? src.hardTriggers.map((item) => triggerBase(item).toLowerCase()).filter(Boolean)
    : QUIET_DEFAULTS.hardTriggers.map((item) => item.toLowerCase());
  return {
    enabled: src.enabled !== false,
    groupsOnly: src.groupsOnly !== false,
    engagedMs: num(src.engagedMs, QUIET_DEFAULTS.engagedMs, 1000),
    glanceMinMs: minGlance,
    glanceMaxMs: maxGlance,
    glanceProbability: Number.isFinite(probability) ? Math.min(1, Math.max(0, probability)) : QUIET_DEFAULTS.glanceProbability,
    hardTriggers: hard
  };
}

export function createQuietWatch(deps = {}) {
  // 依赖一律惰性读：审计沙箱（scripts/test-bridge-modules.mjs）用「访问未初始化绑定就抛错」
  // 的代理注入 deps，构造期碰一下 deps.log 就会被判成 eager access（那条断言是硬门）。
  const readDeps = () => (deps && typeof deps === 'object' ? deps : {});
  const fnOf = (name) => {
    const fn = readDeps()[name];
    return typeof fn === 'function' ? fn : null;
  };
  function log(...args) {
    const fn = fnOf('log');
    if (!fn) return;
    try { fn(...args); } catch {}
  }
  const getState = (key) => {
    const fn = fnOf('getSocialV2State');
    return fn ? fn(key) : {};
  };
  const scheduleWake = (key, reason) => {
    const fn = fnOf('scheduleWake');
    if (fn) fn(key, reason);
  };
  const now = () => {
    const fn = fnOf('now');
    return fn ? fn() : Date.now();
  };
  const random = () => {
    const fn = fnOf('random');
    return fn ? fn() : Math.random();
  };
  const setTimer = (fn, ms) => {
    const impl = fnOf('setTimeout') ?? setTimeout;
    return impl(fn, ms);
  };
  const clearTimer = (timer) => {
    const impl = fnOf('clearTimeout') ?? clearTimeout;
    impl(timer);
  };
  const states = new Map();

// @bridge-function settings:start
  function settings() {
    const getConfig = fnOf('getConfig');
    let cfg = null;
    try { cfg = getConfig ? getConfig() : null; } catch { cfg = null; }
    return normalizeQuietSettings(cfg?.socialV2?.quiet);
  }
// @bridge-function settings:end

  function stateOf(key) {
    if (!states.has(key)) {
      states.set(key, { mode: 'sleeping', engagedUntil: 0, engagedBy: '', glanceTimer: null, nextGlanceAt: 0, lastGlanceAt: 0, glances: 0, admitted: 0, suppressed: 0, lastSuppressLogAt: 0 });
    }
    return states.get(key);
  }

  function scoped(key, cfg) {
    if (!cfg.enabled) return false;
    if (!cfg.groupsOnly) return true;
    return String(key ?? '').startsWith('group:');
  }

  function refresh(state, st, at, cfg) {
    const lastReply = Number(st?.lastAiReplyAt) || 0;
    if (state.mode === 'sleeping' && lastReply > 0 && at - lastReply < cfg.engagedMs) {
      // 自己刚说过话 → 话题还在自己这里，算在场（例如「抬眼」看了一眼就接了话）。
      state.mode = 'engaged';
      state.engagedBy = 'self-reply';
      state.engagedUntil = lastReply + cfg.engagedMs;
    }
    if (state.mode !== 'engaged') return;
    if (lastReply > 0) state.engagedUntil = Math.max(state.engagedUntil, lastReply + cfg.engagedMs);
    if (at < state.engagedUntil) return;
    state.mode = 'sleeping';
    state.engagedBy = '';
    state.engagedUntil = 0;
    log(`[静默] ${state.key ?? ''} 在场时间到，退回偶尔看一眼`.replace('  ', ' '));
  }

  function armGlance(key, st, state, at, cfg) {
    if (state.mode !== 'sleeping' || state.glanceTimer) return;
    const unread = Array.isArray(st?.unread) ? st.unread.length : 0;
    if (!unread) return; // 没有新东西可看，抬眼也没意义（等有新消息再排）
    const span = Math.max(0, cfg.glanceMaxMs - cfg.glanceMinMs);
    const delay = cfg.glanceMinMs + Math.round(span * random());
    state.glanceTimer = setTimer(() => {
      state.glanceTimer = null;
      fire(key);
    }, delay);
    state.glanceTimer?.unref?.();
    state.nextGlanceAt = at + delay;
  }

  function fire(key) {
    const cfg = settings();
    if (!scoped(key, cfg)) return;
    let st = {};
    try { st = getState(key) ?? {}; } catch { st = {}; }
    const state = stateOf(key);
    state.key = key;
    const at = now();
    refresh(state, st, at, cfg);
    if (state.mode !== 'sleeping') return;
    const unread = Array.isArray(st?.unread) ? st.unread.length : 0;
    if (!unread) return;
    if (random() >= cfg.glanceProbability) {
      log(`[抬眼] ${key} 看了一眼（未读 ${unread} 条），没决定开口，继续潜水`);
      armGlance(key, st, state, at, cfg);
      return;
    }
    state.glances += 1;
    state.lastGlanceAt = at;
    log(`[抬眼] ${key} 偶尔看一眼群聊（未读 ${unread} 条），唤醒一次模型`);
    try { scheduleWake(key, 'glance'); } catch (error) { log(`[抬眼] ${key} 唤醒失败: ${error?.message ?? error}`); }
  }

  // 每个进群的消息都会走这里（reason 可能为 null）：决定「这次触发算不算数」。
  // 返回 null 表示吞掉；返回原 reason 表示放行。副作用：维护在场态 + 排抬眼定时器。
// @bridge-function admit:start
  function admit(key, st, reason) {
    const cfg = settings();
    if (!scoped(key, cfg)) return reason;
    const state = stateOf(key);
    state.key = key;
    const at = now();
    refresh(state, st, at, cfg);
    if (!reason) {
      armGlance(key, st, state, at, cfg);
      return reason;
    }
    const base = triggerBase(reason);
    if (cfg.hardTriggers.includes(base.toLowerCase())) {
      state.mode = 'engaged';
      state.engagedBy = base;
      state.engagedUntil = Math.max(state.engagedUntil, at + cfg.engagedMs);
      state.admitted += 1;
      log(`[静默] ${key} 被点名（${reason}）→ 在场 ${Math.round(cfg.engagedMs / 60000)} 分钟`);
      return reason;
    }
    if (state.mode === 'engaged') {
      state.admitted += 1;
      return reason;
    }
    state.suppressed += 1;
    armGlance(key, st, state, at, cfg);
    if (at - state.lastSuppressLogAt >= SUPPRESS_LOG_GAP_MS) {
      state.lastSuppressLogAt = at;
      log(`[静默] ${key} 潜水期吞掉一次唤醒（${reason}），累计 ${state.suppressed} 次`);
    }
    return null;
  }
// @bridge-function admit:end

  // 定时类唤醒（replyCheck / proactiveCheck）在潜水期不该排：它们才是「自己凑上去说话」。
// @bridge-function allowsTimerWake:start
  function allowsTimerWake(key, st, reason) {
    const cfg = settings();
    if (!scoped(key, cfg)) return true;
    const state = stateOf(key);
    state.key = key;
    const at = now();
    refresh(state, st, at, cfg);
    if (state.mode === 'engaged') return true;
    if (at - state.lastSuppressLogAt >= SUPPRESS_LOG_GAP_MS) {
      state.lastSuppressLogAt = at;
      log(`[静默] ${key} 潜水期跳过定时唤醒（${reason}）`);
    }
    return false;
  }
// @bridge-function allowsTimerWake:end

// @bridge-function status:start
  function status(key) {
    const cfg = settings();
    const state = key ? stateOf(key) : null;
    if (state) {
      // 顺手按当前时间刷新一次：调用方问的是「现在是不是在场」，不是「上次写下的值」。
      let st = {};
      try { st = getState(key) ?? {}; } catch { st = {}; }
      refresh(state, st, now(), cfg);
      return { key, mode: state.mode, engagedUntil: state.engagedUntil, engagedBy: state.engagedBy, nextGlanceAt: state.nextGlanceAt, lastGlanceAt: state.lastGlanceAt, glances: state.glances, admitted: state.admitted, suppressed: state.suppressed, settings: cfg };
    }
    return { settings: cfg, conversations: [...states.entries()].map(([k, s]) => ({ key: k, mode: s.mode, engagedUntil: s.engagedUntil, glances: s.glances, suppressed: s.suppressed })) };
  }
// @bridge-function status:end

// @bridge-function reset:start
  function reset(key) {
    const state = states.get(key);
    if (!state) return;
    if (state.glanceTimer) clearTimer(state.glanceTimer);
    states.delete(key);
  }
// @bridge-function reset:end

  return { admit, allowsTimerWake, status, reset, settings };
}
