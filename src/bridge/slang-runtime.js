// slang-runtime: extracted bridge responsibilities; no startup side effects.
// Live dependencies: RESEARCH_TURN_TIMEOUT_MS, SLANG_FILE, SLANG_MAX_ENTRIES, SLANG_SESSION_FILE, SLANG_STATUS, STATE_DIR, api, atomicWriteJson, buildExtractionPrompt, buildResearchPrompt, buildSlangContext, cfg, dshReady, ensureChatModel, fs, learnerCollectors, learnerSessions, learnerWaiters, log, parseExtractionJson, parseResearchJson, path, readJsonSafe, resolvePresetName, saveSlang, setTimeout, slangContentKey, slangEntries, slangExtractionCooldowns, slangLearnerSessionId, slangResearchingIds, slangStoreWritable, slangSubmitTimes, slangTaskChain, slangWindows, truncateText, unwrap, upsertSlangEntry
// ⑨ 黑话学习限流（2026-10-28）：只在空闲时段跑、每日轮次上限、待学队列上限。
// P1（2026-10-28 晚）：默认从「实时、每个 key 一批」改成「每天累计 + 固定时间集中跑一次」，
// 并在每批开始前重置学习会话——不重置的话 agent 上下文越滚越长，单轮 prompt 能到几十万 token。
// 状态与纯函数都放模块作用域：不占冻结的 createSlangRuntime 行数，也不在加载时碰任何 deps。
const SLANG_LEARN_STATE = { day: '', runs: 0 };
const SLANG_LEARN_PENDING = new Map(); // key -> { start, timer? }
let slangDailyBatchTimer = null;       // daily 模式：全局唯一的「下一个 at」定时器
const SLANG_LEARN_AT_DEFAULT = '04:20';
function localDayKey(now = new Date()) {
  const y = now.getFullYear(); const m = String(now.getMonth() + 1).padStart(2, '0'); const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function minutesOfHHMM(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}
// 纯函数：按 peakPause 配置算「距下一个空闲时段还有多久」（0=现在就能跑）。
export function nextOffPeakDelayMs(peakCfg, now = new Date()) {
  const c = peakCfg && typeof peakCfg === 'object' ? peakCfg : {};
  if (c.enabled !== true) return 0;                // 高峰暂停没开：永远算空闲
  if (c.schedule !== true) return 30 * 60 * 1000;  // 手动全时段暂停：半小时后再看
  const windows = Array.isArray(c.windows) && c.windows.length ? c.windows : [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }];
  const day = localDayKey(now);
  const holidays = Array.isArray(c.holidays) ? c.holidays.map(String) : [];
  const makeupDays = Array.isArray(c.makeupDays) ? c.makeupDays.map(String) : [];
  const days = Array.isArray(c.days) && c.days.length ? c.days.map(Number) : [1, 2, 3, 4, 5];
  const isWorkday = makeupDays.includes(day) || (!holidays.includes(day) && days.includes(now.getDay()));
  if (!isWorkday) return 0;
  const cur = now.getHours() * 60 + now.getMinutes();
  for (const w of windows) {
    const a = minutesOfHHMM(w.start); const b = minutesOfHHMM(w.end);
    if (a < 0 || b < 0) continue;
    const inside = a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b);
    if (!inside) continue;
    const endMin = a <= b ? b : b + 24 * 60;      // 跨夜窗口（如 22:00-02:00）
    const curMin = cur >= a ? cur : cur + 24 * 60;
    return Math.max(0, (endMin - curMin) * 60 * 1000);
  }
  return 0;
}
function slangLearnAtText(cfg) {
  const text = typeof cfg?.at === 'string' ? cfg.at.trim() : '';
  return /^\d{1,2}:\d{2}$/.test(text) ? text : SLANG_LEARN_AT_DEFAULT;
}
// 纯函数：算下一次每天固定时刻的触发时间戳（当天已过就顺延到明天）；非法 at 回退 04:20。
export function nextDailyAtMs(at, nowMs = Date.now()) {
  const m = String(at || '').match(/^(\d{1,2}):(\d{2})$/);
  let hh = 4; let mm = 20;
  if (m) {
    const h = Number(m[1]); const mi = Number(m[2]);
    if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) { hh = h; mm = mi; }
  }
  const base = new Date(nowMs);
  const target = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh, mm, 0, 0);
  if (target.getTime() <= nowMs) target.setDate(target.getDate() + 1);
  return target.getTime();
}
// 只挂一个全局定时器（重复调用幂等）：daily 模式下所有 pending key 到点一起跑。
export function scheduleDailyBatch(deps) {
  if (slangDailyBatchTimer) return;
  const cfg = deps.cfg?.socialV2?.slangLearn;
  if (!cfg || cfg.enabled === false || cfg.mode !== 'daily') return;
  const now = Date.now();
  const atMs = nextDailyAtMs(cfg.at, now);
  const timer = deps.setTimeout(() => { slangDailyBatchTimer = null; void runDailyBatch(deps); }, Math.max(1000, atMs - now));
  if (timer && typeof timer.unref === 'function') timer.unref();
  slangDailyBatchTimer = timer;
}
// 测试/切模式时清掉已挂的定时器，避免旧 at 残留。
export function slangLearnCancelDailyTimer() {
  if (slangDailyBatchTimer) { clearTimeout(slangDailyBatchTimer); slangDailyBatchTimer = null; }
}
export function slangLearnDailyTimerArmed() { return Boolean(slangDailyBatchTimer); }
// 每批开始前重置学习会话（freshSessionPerBatch=false 时保留旧上下文，作为回退开关）。
export function resetLearnerSessionForBatch(deps, cfg) {
  const learn = cfg || deps.cfg?.socialV2?.slangLearn || {};
  if (learn.freshSessionPerBatch === false) return false;
  if (typeof deps.invalidateSlangLearnerSession !== 'function') return false;
  deps.invalidateSlangLearnerSession();
  return true;
}
// 到点：按 pending 插入顺序逐个 start()（start 内部仍走 queueSlangTask 串行），跑完清账。
export async function runDailyBatch(deps) {
  slangDailyBatchTimer = null;
  // 系统总开关：暂停期间不学习，pending 留着，恢复后照常跑。
  if (deps.socialV2?.paused) {
    (0, deps.log)('[黑话学习] 系统已暂停，本批顺延');
    return;
  }
  const cfg = deps.cfg?.socialV2?.slangLearn || {};
  const entries = [...SLANG_LEARN_PENDING.entries()];
  if (!entries.length) return;
  const day = localDayKey();
  if (SLANG_LEARN_STATE.day !== day) { SLANG_LEARN_STATE.day = day; SLANG_LEARN_STATE.runs = 0; }
  const dailyRuns = Number(cfg.dailyRuns) || 0;
  if (dailyRuns > 0 && SLANG_LEARN_STATE.runs >= dailyRuns) {
    // 到上限就跳过，但**不清 pending**：明天同一时刻接着跑，不丢已经攒下的会话。
    (0, deps.log)(`[黑话学习] 今日已跑 ${SLANG_LEARN_STATE.runs}/${dailyRuns} 批，跳过（socialV2.slangLearn.dailyRuns 可调，0=不限）`);
    scheduleDailyBatch(deps);
    return;
  }
  SLANG_LEARN_PENDING.clear();
  (0, deps.log)(`[黑话学习] 到点开跑（${entries.length} 个会话）`);
  if (resetLearnerSessionForBatch(deps, cfg)) {
    (0, deps.log)('[黑话学习] 已重置学习会话上下文（socialV2.slangLearn.freshSessionPerBatch=false 可保留旧上下文）');
  }
  for (const [pendingKey, item] of entries) {
    try { await item.start(); } catch (error) { (0, deps.log)(`[黑话学习] ${pendingKey} 学习失败：${error?.message ?? error}`); }
  }
  SLANG_LEARN_STATE.runs += 1;
  (0, deps.log)(`[黑话学习] 本批已跑完（${entries.length} 个会话）`);
  if (SLANG_LEARN_PENDING.size) scheduleDailyBatch(deps);
}
// 入口：工厂把「真正入队」的闭包传进来；这里统一判开关/队列/模式。
export function beginSlangLearnRun(deps, key, start) {
  const cfg = deps.cfg?.socialV2?.slangLearn;
  if (!cfg || cfg.enabled === false) { SLANG_LEARN_PENDING.delete(key); start(); return true; } // 回退开关：旧行为
  const day = localDayKey();
  if (SLANG_LEARN_STATE.day !== day) { SLANG_LEARN_STATE.day = day; SLANG_LEARN_STATE.runs = 0; }
  const queueMax = Number(cfg.queueMax) || 0;
  if (queueMax > 0 && !SLANG_LEARN_PENDING.has(key) && SLANG_LEARN_PENDING.size >= queueMax) {
    const oldest = SLANG_LEARN_PENDING.keys().next().value;
    if (oldest !== undefined) {
      const dropped = SLANG_LEARN_PENDING.get(oldest);
      if (dropped?.timer) clearTimeout(dropped.timer);
      SLANG_LEARN_PENDING.delete(oldest);
      (0, deps.log)(`[黑话学习] 待学队列已满（${queueMax}），丢弃最旧的 ${oldest}（socialV2.slangLearn.queueMax 可调）`);
    }
  }
  if (cfg.mode === 'daily') {
    if (SLANG_LEARN_PENDING.has(key)) return true;
    SLANG_LEARN_PENDING.set(key, { start });
    (0, deps.log)(`[黑话学习] 已累计 ${SLANG_LEARN_PENDING.size} 个会话待学，将在 ${slangLearnAtText(cfg)} 集中跑一次`);
    scheduleDailyBatch(deps);
    return true;
  }
  // ---- 以下 live 模式：保留旧的实时行为（每日轮次上限 + 高峰延后）
  const dailyRuns = Number(cfg.dailyRuns) || 0;
  if (dailyRuns > 0 && SLANG_LEARN_STATE.runs >= dailyRuns) {
    SLANG_LEARN_PENDING.delete(key);
    (0, deps.log)(`[黑话学习] 今日已跑 ${SLANG_LEARN_STATE.runs}/${dailyRuns} 轮，跳过 ${key}（socialV2.slangLearn.dailyRuns 可调，0=不限）`);
    return false;
  }
  const delay = cfg.onlyOffPeak === false ? 0 : nextOffPeakDelayMs(deps.peakCfg?.(), new Date());
  if (delay > 0) {
    if (SLANG_LEARN_PENDING.has(key)) return false;
    const timer = deps.setTimeout(() => beginSlangLearnRun(deps, key, start), delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    SLANG_LEARN_PENDING.set(key, { start, timer });
    (0, deps.log)(`[黑话学习] 高峰时段，${key} 延后 ${Math.max(1, Math.round(delay / 60000))} 分钟到窗口结束再跑`);
    return false;
  }
  SLANG_LEARN_PENDING.delete(key);
  SLANG_LEARN_STATE.runs += 1;
  start();
  return true;
}
// 测试用：清空模块级待学队列与 daily 定时器（用例之间互不污染）。
export function slangLearnClearPending() {
  for (const item of SLANG_LEARN_PENDING.values()) if (item?.timer) clearTimeout(item.timer);
  SLANG_LEARN_PENDING.clear();
  slangLearnCancelDailyTimer();
}
export function slangLearnPendingKeys() { return [...SLANG_LEARN_PENDING.keys()]; }
export function slangLearnRunCount() { return SLANG_LEARN_STATE.runs; }
// @bridge-function saveSlangStore:start
function saveSlangStore(deps) {
    if (!deps.slangStoreWritable) {
      (0, deps.log)('⚠️ 黑话库处于只读降级状态（启动时加载失败），本次改动不落盘');
      return;
    }
    try {
      const result = (0, deps.saveSlang)(deps.SLANG_FILE, deps.slangEntries);
      if (result?.dropped > 0) {
        deps.slangEntries = result.entries;
        (0, deps.log)(`黑话库超过 ${deps.SLANG_MAX_ENTRIES} 条上限，已按「已确认优先」丢弃 ${result.dropped} 条最不活跃的词条`);
      }
    } catch (error) { (0, deps.log)('保存黑话库失败:', error?.message ?? error); }
  }
// @bridge-function saveSlangStore:end

// @bridge-function queueSlangTask:start
function queueSlangTask(deps, fn) {
    deps.slangTaskChain = deps.slangTaskChain.then(fn).catch((error) => (0, deps.log)('黑话学习任务异常:', error?.message ?? error));
    return deps.slangTaskChain;
  }
// @bridge-function queueSlangTask:end

// @bridge-function ensureSlangLearnerSession:start
async function ensureSlangLearnerSession(deps) {
    const preset = (0, deps.resolvePresetName)(deps.cfg.slang?.learnerPreset || deps.cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话学习缺少已验证的安全 preset，拒绝创建或复用会话');
    const saved = (0, deps.readJsonSafe)(deps.SLANG_SESSION_FILE, null);
    // 旧记录没有 preset 元数据，无法证明其权限，必须重新创建。
    if (saved?.preset !== preset) invalidateSlangLearnerSession(deps);
    if (deps.slangLearnerSessionId) {
      deps.learnerSessions.add(deps.slangLearnerSessionId);
      deps.api.events.follow(deps.slangLearnerSessionId);
      return deps.slangLearnerSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      deps.slangLearnerSessionId = String(saved.sessionId);
      deps.learnerSessions.add(deps.slangLearnerSessionId);
      deps.api.events.follow(deps.slangLearnerSessionId);
      await (0, deps.ensureChatModel)(deps.slangLearnerSessionId);
      return deps.slangLearnerSessionId;
    }
    const dir = deps.path.join(deps.STATE_DIR, 'slang-agent');
    deps.fs.mkdirSync(dir, { recursive: true });
    const wsValue = (0, deps.unwrap)(await deps.api.workspace.create({ path: dir }), 'slang workspace.create');
    const workspaceTitle = deps.cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await deps.api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = (0, deps.unwrap)(await deps.api.sessions.create(params), 'slang session.create');
    deps.slangLearnerSessionId = value.sessionId;
    deps.learnerSessions.add(deps.slangLearnerSessionId);
    deps.api.events.follow(deps.slangLearnerSessionId);
    await (0, deps.ensureChatModel)(deps.slangLearnerSessionId);
    deps.fs.mkdirSync(deps.STATE_DIR, { recursive: true });
    (0, deps.atomicWriteJson)(deps.SLANG_SESSION_FILE, { sessionId: deps.slangLearnerSessionId, preset });
    (0, deps.log)(`黑话学习会话已创建：${deps.slangLearnerSessionId}`);
    return deps.slangLearnerSessionId;
  }
// @bridge-function ensureSlangLearnerSession:end

// @bridge-function invalidateSlangLearnerSession:start
function invalidateSlangLearnerSession(deps) {
    // 如果在途任务仍在使用旧会话，先保留 learnerSessions 以便事件继续被消费；
    // 没有等待/收集中的旧会话才从集合移除。
    const oldId = deps.slangLearnerSessionId;
    deps.slangLearnerSessionId = null;
    if (oldId && !deps.learnerWaiters.has(oldId) && !deps.learnerCollectors.has(oldId)) {
      deps.learnerSessions.delete(oldId);
    }
    try { deps.fs.unlinkSync(deps.SLANG_SESSION_FILE); } catch {}
  }
// @bridge-function invalidateSlangLearnerSession:end

// @bridge-function waitLearnerTurn:start
function waitLearnerTurn(deps, sessionId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timer = (0, deps.setTimeout)(() => {
        const arr = deps.learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) deps.learnerWaiters.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      const arr = deps.learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      deps.learnerWaiters.set(sessionId, arr);
    });
  }
// @bridge-function waitLearnerTurn:end

// @bridge-function runSlangExtraction:start
async function runSlangExtraction(deps, key) {
    if (deps.cfg.slang?.enabled === false) return;
    if (!deps.dshReady) return;
    const messages = deps.slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(deps.cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;

    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession(deps);
    } catch (error) {
      (0, deps.log)(`黑话学习会话创建失败 (${key}):`, error?.message ?? error);
      return;
    }

    const promptText = (0, deps.buildExtractionPrompt)(messages);
    try {
      const accepted = await deps.api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        (0, deps.log)(`黑话提取被拒 (${key}): ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(deps, sessionId);
      const items = (0, deps.parseExtractionJson)(output);
      if (!items.length) {
        (0, deps.log)(`黑话提取：${key} 未发现候选`);
        const win = deps.slangWindows.get(key) ?? [];
        deps.slangWindows.set(key, win.slice(messages.length));
        return;
      }
      let added = 0;
      let updated = 0;
      const researchCandidates = [];
      const thresholds = Array.isArray(deps.cfg.slang?.inferenceThresholds) ? deps.cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [1, 3, 6];
      const seenContents = new Set();
      for (const item of items) {
        if (seenContents.has(item.content)) continue;
        seenContents.add(item.content);
        const idx = Number(item.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: src.text, time: src.time }] : [];
        const result = (0, deps.upsertSlangEntry)(deps.slangEntries, item.content, { evidence, countIncrement: 1 });
        if (result.created) added += 1; else updated += 1;
        if (result.entry && result.entry.status === deps.SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
          researchCandidates.push(result.entry);
        }
      }
      const win = deps.slangWindows.get(key) ?? [];
      deps.slangWindows.set(key, win.slice(messages.length));
      saveSlangStore(deps);
      (0, deps.log)(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);
      if (researchCandidates.length && deps.cfg.slang?.autoResearch !== false) {
        queueSlangTask(deps, () => runSlangResearch(deps, researchCandidates));
      }
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession(deps);
      }
      (0, deps.log)(`黑话提取失败 (${key}):`, error?.message ?? error);
    }
  }
// @bridge-function runSlangExtraction:end

// @bridge-function runSlangResearch:start
async function runSlangResearch(deps, candidates) {
    if (!candidates || !candidates.length) return;
    if (deps.cfg.slang?.enabled === false) return;
    if (!deps.dshReady) return;
    // 过滤掉已经在研究队列里的候选，避免同一批被重复排队研究。
    const targets = candidates.filter((e) => e && !deps.slangResearchingIds.has(e.id));
    if (!targets.length) return;
    for (const e of targets) deps.slangResearchingIds.add(e.id);
    // 分批：一轮让 agent 联网考究太多词，既容易超时，也会把每个词的检索摊薄。
    const chunkSize = Math.max(1, Math.min(10, Number(deps.cfg.slang?.researchChunkSize) || 5));
    let written = 0;
    let skipped = 0;
    let returned = 0;
    let autoConfirmed = 0;
    // 内容比较键索引：模型回「色色（色情）」这种带注解的形式也要能对上库里的「色色」。
    const byKey = new Map();
    for (const e of deps.slangEntries) {
      const k = (0, deps.slangContentKey)(e.content);
      if (!k) continue;
      const list = byKey.get(k);
      if (list) list.push(e); else byKey.set(k, [e]);
    }
    try {
      for (let i = 0; i < targets.length; i += chunkSize) {
        const chunk = targets.slice(i, i + chunkSize);
        // 每块考究都换一个新会话：同一会话里连跑多块，前一块的联网考究结果会一直
        // 留在上下文里，第 3、4 块的输入能滚到 20 万 token（实测一步 223k）。
        // 每块都是独立的一问一答，重置会话不影响结论，只把上下文从 20 万拉回一万多。
        if (i > 0) invalidateSlangLearnerSession(deps);
        let sessionId;
        try {
          sessionId = await ensureSlangLearnerSession(deps);
        } catch (error) {
          (0, deps.log)('黑话研究会话创建失败:', error?.message ?? error);
          break; // 会话起不来，后面批次必然同样失败
        }
        try {
          const accepted = await deps.api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: (0, deps.buildResearchPrompt)(chunk) }] });
          if (!accepted.result.ok) {
            (0, deps.log)(`黑话研究被拒: ${accepted.result.error.code}: ${accepted.result.error.message}`);
            break;
          }
          const output = await waitLearnerTurn(deps, sessionId, deps.RESEARCH_TURN_TIMEOUT_MS);
          const results = (0, deps.parseResearchJson)(output);
          returned += results.length;
          for (const r of results) {
            const k = (0, deps.slangContentKey)(r.content);
            // 一个 key 可能对应多条（大小写不同/重复收录，如 BOOTH 与 booth）：
            // 只写第一条会让另一条静默留空——这正是要修的那类"结果凭空消失"。
            const matches = (k && byKey.get(k)) || [];
            if (!matches.length) {
              // 以前是静默 continue：模型换个写法，结果就凭空消失，日志还显示"已更新"。
              (0, deps.log)(`黑话研究：模型返回「${r.content}」在库里找不到对应词条，已跳过`);
              skipped += 1;
              continue;
            }
            // 释义优先级：人工 > 联网确认(web) > 语境推断(context)。推断型不覆盖已有释义。
            const basis = r.basis || (r.confirmed === true ? 'web' : 'context');
            for (const entry of matches) {
              if (r.meaning && (!entry.meaning || (basis === 'web' && entry.source !== 'manual'))) {
                entry.meaning = r.meaning;
              }
              if (!entry.meaning) {
                // 确实推不出含义：保留候选，等它再出现或人工补。
                (0, deps.log)(`黑话研究：${entry.content} 没有可用释义（confirmed=${r.confirmed === true}），保留候选待后续研究`);
                skipped += 1;
                continue;
              }
              if (!entry.usage && r.usage) entry.usage = r.usage;
              if (!entry.example && r.example) entry.example = r.example;
              if (!entry.risk && r.risk) entry.risk = r.risk;
              // 只有联网确认（web）的才留来源：语境推断也附上 URL 会让人误以为"网上有据"。
              if (basis === 'web' && Array.isArray(r.sources) && r.sources.length) {
                entry.sources = r.sources.slice(0, 10);
              }
              entry.basis = basis;
              entry.lastInferenceCount = entry.count;
              entry.updatedAt = new Date().toISOString();
              written += 1;
              // 联网确认(web)的结果可以直接进聊天提示词；语境推断(context)的仍留人工确认，
              // 免得群里瞎猜出来的词被当成真事塞进机器人的嘴。
              if (basis === 'web' && entry.status === deps.SLANG_STATUS.CANDIDATE && deps.cfg.slang?.autoConfirmWeb !== false) {
                entry.status = deps.SLANG_STATUS.CONFIRMED;
                if (entry.source !== 'manual') entry.source = 'ai-research';
                autoConfirmed += 1;
              }
            }
          }
        } catch (error) {
          // 单个批次失败不连坐其余批次。
          if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
            invalidateSlangLearnerSession(deps);
          }
          (0, deps.log)('黑话研究失败:', error?.message ?? error);
        }
      }
      if (written) saveSlangStore(deps);
      // 旧日志打的是 results.length（模型返回几条），和真正落库的条数不是一回事，误导排查。
      (0, deps.log)(`黑话研究：写入 ${written} 条（目标 ${targets.length} 条，模型返回 ${returned} 条，跳过 ${skipped} 条，自动确认 ${autoConfirmed} 条）`);
    } finally {
      for (const e of targets) deps.slangResearchingIds.delete(e.id);
    }
  }
// @bridge-function runSlangResearch:end

// @bridge-function maybeQueueSlangExtraction:start
function maybeQueueSlangExtraction(deps, key) {
    if (deps.cfg.slang?.enabled === false) return;
    if (!deps.dshReady) return;
    const cooldown = Number(deps.cfg.slang?.extractCooldownMs ?? 300000);
    const last = deps.slangExtractionCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    const messages = deps.slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(deps.cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;
    deps.slangExtractionCooldowns.set(key, Date.now());
    beginSlangLearnRun(deps, key, () => queueSlangTask(deps, () => runSlangExtraction(deps, key)));
  }
// @bridge-function maybeQueueSlangExtraction:end

// @bridge-function feedSlangWindow:start
function feedSlangWindow(deps, key, sender, plainContent) {
    if (deps.cfg.slang?.enabled === false) return;
    if (!key || !plainContent || typeof plainContent !== 'string') return;
    const text = plainContent.trim();
    if (!text || text.startsWith('/')) return;
    if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
    if (!deps.slangWindows.has(key)) deps.slangWindows.set(key, []);
    const win = deps.slangWindows.get(key);
    win.push({ sender: String(sender || '未知'), text: (0, deps.truncateText)(text, 200), time: Date.now() });
    if (win.length > 80) win.splice(0, win.length - 80);
    maybeQueueSlangExtraction(deps, key);
  }
// @bridge-function feedSlangWindow:end

// @bridge-function allowSlangSubmit:start
function allowSlangSubmit(deps, key) {
    const now = Date.now();
    const arr = (deps.slangSubmitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
    const MAX_PER_MINUTE = 2;
    const MAX_PER_HOUR = 10;
    if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
    arr.push(now);
    deps.slangSubmitTimes.set(key, arr);
    return true;
  }
// @bridge-function allowSlangSubmit:end

// @bridge-function publicSlangEntry:start
function publicSlangEntry(deps, e) {
    return {
      id: e?.id ?? '',
      content: e?.content ?? '',
      meaning: e?.meaning ?? '',
      usage: e?.usage ?? '',
      example: e?.example ?? '',
      risk: e?.risk ?? '',
      basis: e?.basis ?? '',
      status: e?.status ?? deps.SLANG_STATUS.CANDIDATE,
      source: e?.source ?? 'ai',
      count: Number(e?.count) || 0,
      lastInferenceCount: Number(e?.lastInferenceCount) || 0,
      updatedAt: e?.updatedAt ?? ''
    };
  }
// @bridge-function publicSlangEntry:end

// @bridge-function confirmedSlangListV2:start
function confirmedSlangListV2(deps) {
    const max = Math.max(1, Math.min(30, Number(deps.cfg.slang?.injectMax) || 8));
    return deps.slangEntries
      .filter((e) => e.status === deps.SLANG_STATUS.CONFIRMED && e.content && e.meaning)
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, max)
      .map((e) => publicSlangEntry(deps, e));
  }
// @bridge-function confirmedSlangListV2:end

// @bridge-function withSlangContext:start
function withSlangContext(deps, promptText) {
    const now = new Date();
    const timeLine = `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
    const parts = [timeLine];
    if (deps.cfg.slang?.enabled !== false) {
      const block = (0, deps.buildSlangContext)(deps.slangEntries, deps.cfg.slang?.injectMax ?? 8);
      if (block) parts.push(block);
    }
    return parts.join('\n\n') + '\n\n' + promptText;
  }
// @bridge-function withSlangContext:end
export function createSlangRuntime(deps) {
  return {
    saveSlangStore: () => saveSlangStore(deps),
    queueSlangTask: (fn) => queueSlangTask(deps, fn),
    ensureSlangLearnerSession: () => ensureSlangLearnerSession(deps),
    invalidateSlangLearnerSession: () => invalidateSlangLearnerSession(deps),
    waitLearnerTurn: (sessionId, timeoutMs) => waitLearnerTurn(deps, sessionId, timeoutMs),
    runSlangExtraction: (key) => runSlangExtraction(deps, key),
    runSlangResearch: (candidates) => runSlangResearch(deps, candidates),
    maybeQueueSlangExtraction: (key) => maybeQueueSlangExtraction(deps, key),
    feedSlangWindow: (key, sender, plainContent) => feedSlangWindow(deps, key, sender, plainContent),
    allowSlangSubmit: (key) => allowSlangSubmit(deps, key),
    publicSlangEntry: (e) => publicSlangEntry(deps, e),
    confirmedSlangListV2: () => confirmedSlangListV2(deps),
    withSlangContext: (promptText) => withSlangContext(deps, promptText)
  };
}
