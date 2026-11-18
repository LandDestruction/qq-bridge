// 视频语音转写的「主动补发」：转写迟到时不再让用户问第二遍。
//
// 旧行为（22:42 / 23:2x 实测）：本轮 prompt 等不到转写就写「没完成」，转写 60s 后
// 才完成，但**没有人把它发出去** —— 用户必须再问一次，下一轮才从上下文里看到。
// 更糟的是旧代码调了一个不存在的 `LongText()`，真触发时直接 ReferenceError（消息根本发不出）。
//
// 现在的约定：
//   1. 视频消息到达即建 job；转写完成调用 `transcriptReady()`；
//   2. 本轮 prompt 若**已经带上**转写（赶上了），调用方 `claim(job)`，绝不重复补发；
//   3. 否则延迟 settleMs（给 prompt 组装留窗口）后主动发一条 QQ 消息；
//   4. 每个视频 key（`${key}:${media.file||media.url}`）只补发一次，状态持久化，重启不重发；
//   5. 同会话连续补发之间至少间隔 minGapMs，避免两条视频同时转完时刷屏。
//
// 本模块纯逻辑、不 import bridge，离线可测。
export const FOLLOWUP_DEFAULTS = Object.freeze({
  enabled: true,
  maxChars: 200,
  minGapMs: 3000,
  settleMs: 1200,
  maxSent: 500
});

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export function normalizeFollowUpConfig(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: src.enabled !== false,
    maxChars: clampInt(src.maxChars, 20, 2000, FOLLOWUP_DEFAULTS.maxChars),
    minGapMs: clampInt(src.minGapMs, 0, 120000, FOLLOWUP_DEFAULTS.minGapMs),
    settleMs: clampInt(src.settleMs ?? FOLLOWUP_DEFAULTS.settleMs, 0, 10000, FOLLOWUP_DEFAULTS.settleMs),
    maxSent: clampInt(src.maxSent, 50, 5000, FOLLOWUP_DEFAULTS.maxSent)
  };
}

/** 「已补发」集合：有界、保序（最旧的先淘汰），接口与 Set 对齐便于持久化。 */
export function createSentStore(initial = [], { max = FOLLOWUP_DEFAULTS.maxSent } = {}) {
  const set = new Set();
  for (const sig of Array.isArray(initial) ? initial : []) {
    const s = String(sig ?? "").trim();
    if (s) set.add(s);
  }
  const limit = Math.max(1, Number(max) || FOLLOWUP_DEFAULTS.maxSent);
  const prune = () => {
    while (set.size > limit) set.delete(set.values().next().value);
  };
  prune();
  return {
    has: (sig) => set.has(String(sig ?? "")),
    add: (sig) => {
      const s = String(sig ?? "").trim();
      if (!s) return;
      set.delete(s); // 重新插入到末尾，淘汰时保留最近用过的
      set.add(s);
      prune();
    },
    delete: (sig) => set.delete(String(sig ?? "")),
    clear: () => set.clear(),
    toArray: () => Array.from(set),
    get size() { return set.size; }
  };
}

const truncateChars = (text, max) => {
  const s = String(text ?? "").trim();
  if (!s) return "";
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : s;
};

const shortReason = (reason) => truncateChars(reason, 40);

/** 视频还没转写完时给模型的事实：必须是「转写中」，不许说「听不到/没有声音」。 */
export function videoMediaFactText(media = {}) {
  const status = String(media?.sttStatus || "");
  const summary = String(media?.summary || "").slice(0, 60);
  const enriched = Boolean(media?.enrichedAt);
  const reason = shortReason(media?.sttError || "");
  if (status === "no-audio") {
    return `[视频：这条视频没有可用的人声${reason ? `（${reason}）` : ""}。不要臆测声音内容]`;
  }
  if (status === "failed") {
    return `[视频：语音转写失败${reason ? `（${reason}）` : ""}。不要臆测声音内容]`;
  }
  if (status === "ok" || enriched) {
    const voice = String(media?.sttText || "").trim().slice(0, 60);
    return `[视频：${summary || "已抽帧，语音转写见消息正文"}${voice ? `；声音原话转写：“${voice}”` : ""}]`;
  }
  return "[视频：语音转写中，还没转写完，稍后会把转写补给你。不要说你听不到/没有声音，也不要编造声音内容；可以先按画面回应]";
}

/** 补发文案：必须基于真实转写（调用方只在 text 非空时才会走到这里）。 */
export function buildFollowUpMessage(job, maxChars = FOLLOWUP_DEFAULTS.maxChars) {
  const said = truncateChars(job?.text, Math.max(20, Number(maxChars) || FOLLOWUP_DEFAULTS.maxChars));
  if (!said) return "";
  return `刚才那条视频的语音我听出来了：${said}`;
}

/**
 * 补发协调器。
 * @param {object} deps
 * @param {(key: string, text: string, job: object) => Promise<boolean|void>} deps.send
 *        真正发 QQ 的函数；返回 false 表示通道明确拒绝（不记为已补发）。
 * @param {() => object} [deps.config]    读 socialV2.stt.followUp
 * @param {ReturnType<typeof createSentStore>} [deps.sentStore]
 * @param {(entry: {sig:string,key:string,at:number}) => void} [deps.persist]  持久化回调
 * @param {() => number} [deps.now]
 * @param {(msg: string) => void} [deps.log]
 * @param {boolean} [deps.unrefTimers]   测试时可关掉 unref，避免进程提前退出
 */
export function createFollowUpHub({
  send,
  config = () => ({}),
  sentStore = createSentStore(),
  persist = () => {},
  now = Date.now,
  log = () => {},
  unrefTimers = true
} = {}) {
  if (typeof send !== "function") throw new Error("createFollowUpHub 需要 send");
  const lastSentByKey = new Map();
  const activeJobs = new Set(); // 尚未 finish 的 job（dispose 时清定时器）

  function createJob({ key, sig, durationSec = null } = {}) {
    if (!key || !sig) throw new Error("createJob 需要 key 与 sig");
    return {
      key: String(key),
      sig: String(sig),
      durationSec: Number.isFinite(Number(durationSec)) ? Number(durationSec) : null,
      text: "",
      status: "pending",
      error: "",
      claimed: false,
      claimReason: "",
      sent: false,
      sentAt: 0,
      timer: null,
      promise: null,
      resolve: null,
      logged: false,
      createdAt: now()
    };
  }

  function finish(job, result) {
    if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    activeJobs.delete(job);
    const resolve = job.resolve;
    job.resolve = null;
    if (!job.logged) {
      job.logged = true;
      log(`[video] ${job.key} 补发=${result.sent ? "是" : "否"} 原因=${result.reason}${result.sent ? ` 字数=${result.chars}` : ""}`);
    }
    if (resolve) resolve(result);
    return result;
  }

  function claim(job, reason = "本轮 prompt 已带上") {
    if (!job || job.sent) return;
    job.claimed = true;
    job.claimReason = reason;
    if (job.resolve) finish(job, { sent: false, reason });
    else if (job.timer) { clearTimeout(job.timer); job.timer = null; }
  }

  function arm(job, waitMs) {
    job.timer = setTimeout(() => {
      job.timer = null;
      void attemptSend(job, normalizeFollowUpConfig(config()));
    }, Math.max(0, waitMs));
    if (unrefTimers) job.timer.unref?.();
  }

  function schedule(job, cfg) {
    if (!cfg.enabled) return finish(job, { sent: false, reason: "补发已关闭（socialV2.stt.followUp.enabled=false）" });
    if (!job.text) {
      const reason = job.status === "no-audio"
        ? "这条视频没有可用的人声"
        : (job.status === "failed" ? `转写失败：${shortReason(job.error) || "未知原因"}` : "没有转写内容");
      return finish(job, { sent: false, reason });
    }
    if (job.claimed) return finish(job, { sent: false, reason: job.claimReason || "本轮 prompt 已带上" });
    if (job.sent || sentStore.has(job.sig)) return finish(job, { sent: false, reason: "已经补发过（去重）" });
    const last = lastSentByKey.get(job.key) || 0;
    const waitMs = Math.max(cfg.settleMs, cfg.minGapMs - (now() - last));
    arm(job, waitMs);
  }

  async function attemptSend(job, cfg) {
    // 定时器与 claim 可能擦肩而过：发送前再确认一次所有闸门。
    if (job.claimed) return finish(job, { sent: false, reason: job.claimReason || "本轮 prompt 已带上" });
    if (job.sent || sentStore.has(job.sig)) return finish(job, { sent: false, reason: "已经补发过（去重）" });
    if (!job.text) return finish(job, { sent: false, reason: "没有转写内容" });
    const last = lastSentByKey.get(job.key) || 0;
    if (now() - last < cfg.minGapMs) {
      arm(job, cfg.minGapMs - (now() - last));
      return undefined;
    }
    const message = buildFollowUpMessage(job, cfg.maxChars);
    const sentAt = now();
    try {
      const ok = await send(job.key, message, job);
      if (ok === false) return finish(job, { sent: false, reason: "发送失败（通道未确认）" });
    } catch (error) {
      return finish(job, { sent: false, reason: `发送异常：${shortReason(error?.message ?? error)}` });
    }
    job.sent = true;
    job.sentAt = sentAt;
    lastSentByKey.set(job.key, sentAt);
    sentStore.add(job.sig);
    try {
      persist({ sig: job.sig, key: job.key, at: sentAt });
    } catch (error) {
      log(`[video] ${job.key} 补发状态持久化失败：${error?.message ?? error}`);
    }
    return finish(job, { sent: true, reason: "已发送", chars: message.length, message });
  }

  /**
   * 转写完成（或确认失败）后调用。
   * @returns {Promise<{sent:boolean, reason:string, message?:string, chars?:number}>}
   */
  function transcriptReady(job, { text = "", status = "ok", error = "", durationSec = null } = {}) {
    if (!job) return Promise.resolve({ sent: false, reason: "无任务" });
    job.text = String(text ?? "").trim();
    job.status = String(status || "ok");
    job.error = String(error || "");
    if (Number.isFinite(Number(durationSec))) job.durationSec = Number(durationSec);
    if (job.promise) return job.promise;
    job.promise = new Promise((resolve) => { job.resolve = resolve; });
    activeJobs.add(job);
    schedule(job, normalizeFollowUpConfig(config()));
    return job.promise;
  }

  function dispose() {
    // 测试收尾：清掉未触发的定时器（生产进程退出时由 OS 回收）。
    for (const job of activeJobs) {
      if (job.timer) clearTimeout(job.timer);
      job.timer = null;
    }
    activeJobs.clear();
  }

  const wrapJob = (job) => { activeJobs.add(job); return job; };

  return {
    createJob: (opts) => wrapJob(createJob(opts)),
    transcriptReady,
    claim,
    dispose,
    sentCount: () => sentStore.size,
    _internals: { lastSentByKey, activeJobs }
  };
}
