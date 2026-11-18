// ⑨ Token 三项控制（2026-10-28）：
//  A. 黑话学习限流：只在空闲时段跑（高峰延后而不是丢弃）、每日轮次上限、待学队列上限、单轮步数上限 12。
//  B. 普通聊天单轮步数上限 25（到顶收尾 + 留日志/提示），与黑话学习的 12 步口径互相独立。
//  C. 聊天模型白名单：默认只放 deepseek 系（2026-10-29 放宽到 `*/*deepseek*`，pro 可用于降级链），
//     mimo/glm 等非 deepseek 被过滤；[] = 不过滤（回退开关）。
// P1（2026-10-28 晚）：A 默认改成「每天累计 + 04:20 集中跑一批」的 daily 模式，批量前重置学习会话；
//  B 的步数口径改成以 step/start 为准（tool/call 只作旧版 DSH 的兜底）。
// 全部走「纯函数 + 假 deps」：不连 DSH、不写真实 config.json、不发 QQ。
import assert from 'node:assert/strict';
import {
  normalizeTokenControls,
  normalizeSlangLearnConfig,
  normalizeAllowedProviderModels,
  normalizeSlangLearnAt,
  normalizeLibrary
} from '../src/bridge/config-load.js';
import {
  nextOffPeakDelayMs,
  nextDailyAtMs,
  beginSlangLearnRun,
  runDailyBatch,
  resetLearnerSessionForBatch,
  slangLearnCancelDailyTimer,
  slangLearnDailyTimerArmed,
  slangLearnPendingKeys,
  slangLearnRunCount,
  slangLearnClearPending
} from '../src/bridge/slang-runtime.js';
import { turnStepLimit, guardTurnSteps, describeToolResult } from '../src/bridge/mux-helpers.js';
import { isChatModelAllowed, filterChatModels } from '../src/bridge/model-selection.js';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`❌ ${name}\n   ${error?.message ?? error}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`❌ ${name}\n   ${error?.message ?? error}`);
  }
}
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (minutes) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
// 构造一个「此刻正好在高峰窗口内」的 peakPause 配置（窗口 = 现在-1min ~ 现在+30min）。
function peakCfgAroundNow(extra = {}) {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = (cur - 1 + 1440) % 1440;
  const end = (cur + 30) % 1440;
  return { enabled: true, schedule: true, windows: [{ start: hhmm(start), end: hhmm(end) }], days: [now.getDay()], holidays: [], makeupDays: [], ...extra };
}
function fakeDeps({ slangLearn = {}, peakCfg = { enabled: false }, turnMaxSteps, learnerSessions = new Set(), reverse = new Map() } = {}) {
  const deps = {
    cfg: { socialV2: { slangLearn: { enabled: true, dailyRuns: 8, maxStepsPerRun: 12, onlyOffPeak: true, queueMax: 6, ...slangLearn }, turnMaxSteps, peakPause: peakCfg } },
    logged: [],
    timers: [],
    sentQQ: [],
    stops: [],
    activities: [],
    actions: [],
    invalidates: 0,
    learnerSessions,
    reverse,
    DSH_CONTROL_TIMEOUT_MS: 5000,
    setTimeout: (fn, ms) => { const t = { fn, ms, unref() {} }; deps.timers.push(t); return t; },
    peakCfg: () => deps.cfg.socialV2.peakPause,
    appendActivity: (...args) => deps.activities.push(args),
    sendToQQ: async (key, text) => deps.sentQQ.push({ key, text }),
    withTimeout: (promise) => promise,
    invalidateSlangLearnerSession: () => { deps.invalidates += 1; deps.actions.push('invalidate'); },
    api: { stopSessionWork: async (sid, opts) => deps.stops.push({ sid, opts }) }
  };
  deps.log = (line) => { deps.logged.push(String(line)); };
  return deps;
}
const makeDeps = (options = {}) => fakeDeps(options);

check('A0 默认值：slangLearn 八项（daily/04:20）+ turnMaxSteps=8 + 白名单默认放 deepseek 系（含 pro）', () => {
  const social = normalizeTokenControls({});
  assert.deepEqual(social.slangLearn, {
    enabled: true, mode: 'daily', at: '04:20', freshSessionPerBatch: true,
    dailyRuns: 1, maxStepsPerRun: 12, onlyOffPeak: true, queueMax: 6
  });
  assert.equal(social.turnMaxSteps, 8);
  assert.deepEqual(social.modelRouting.allowedProviderModels, ['*/*deepseek*']);
});
check('A0 用户显式值：非法值回退默认，0 保留为「不限」，[] 保留为「不过滤」', () => {
  const social = normalizeTokenControls({
    slangLearn: { enabled: false, mode: 'weird', at: '25:99', freshSessionPerBatch: false, dailyRuns: -1, maxStepsPerRun: 'x', onlyOffPeak: false, queueMax: 0 },
    turnMaxSteps: 0,
    modelRouting: { allowedProviderModels: [] }
  });
  assert.equal(social.slangLearn.enabled, false);
  assert.equal(social.slangLearn.mode, 'daily', '未知 mode 回退 daily');
  assert.equal(social.slangLearn.at, '04:20', '非法 at 回退 04:20');
  assert.equal(social.slangLearn.freshSessionPerBatch, false);
  assert.equal(social.slangLearn.dailyRuns, 1);
  assert.equal(social.slangLearn.maxStepsPerRun, 12);
  assert.equal(social.slangLearn.onlyOffPeak, false);
  assert.equal(social.slangLearn.queueMax, 0);
  assert.equal(social.turnMaxSteps, 0);
  assert.deepEqual(social.modelRouting.allowedProviderModels, []);
  const live = normalizeTokenControls({ slangLearn: { mode: 'live', at: '3:05' } });
  assert.equal(live.slangLearn.mode, 'live', 'live 是唯一保留的模式值（回退开关）');
  assert.equal(live.slangLearn.at, '03:05', 'HH:MM 归一化补零');
  assert.equal(normalizeSlangLearnAt('23:59'), '23:59');
  assert.equal(normalizeSlangLearnAt('24:00'), '04:20');
  assert.equal(normalizeSlangLearnAt('9:5'), '04:20');
  assert.equal(normalizeSlangLearnConfig(null).dailyRuns, 1);
  assert.deepEqual(normalizeAllowedProviderModels(null), ['*/*deepseek*']);
});

check('A0 library 段默认值：autoExtract=false、extractKeepZip=true', () => {
  const lib = normalizeLibrary(undefined);
  assert.deepEqual(lib, { autoExtract: false, extractKeepZip: true });
  assert.deepEqual(normalizeLibrary(null), { autoExtract: false, extractKeepZip: true });
  // 数组/字符串这类「不是对象」的脏值一律回默认，别让 Boolean([]) 之类的直觉把开关打开。
  assert.equal(normalizeLibrary([]).autoExtract, false);
  assert.equal(normalizeLibrary('true').autoExtract, false);
});

check('A0 library 段严格布尔：字符串 \'true\' 不生效，只有真 true 才打开', () => {
  assert.equal(normalizeLibrary({ autoExtract: 'true' }).autoExtract, false);
  assert.equal(normalizeLibrary({ autoExtract: 1 }).autoExtract, false);
  assert.equal(normalizeLibrary({ autoExtract: true }).autoExtract, true);
  assert.equal(normalizeLibrary({ autoExtract: false }).autoExtract, false);
});

check('A0 library 段 extractKeepZip：缺省 true，只认真 true，脏值不生效', () => {
  assert.equal(normalizeLibrary({}).extractKeepZip, true);
  assert.equal(normalizeLibrary({ extractKeepZip: true }).extractKeepZip, true);
  assert.equal(normalizeLibrary({ extractKeepZip: false }).extractKeepZip, false);
  assert.equal(normalizeLibrary({ extractKeepZip: 'true' }).extractKeepZip, false);
});

check('A1 空闲判定：高峰窗口内返回「距窗口结束」的正延迟，窗口外/未启用为 0', () => {
  const cfg = peakCfgAroundNow();
  const delay = nextOffPeakDelayMs(cfg);
  assert.ok(delay > 0, '窗口内应延后');
  assert.ok(delay <= 31 * 60 * 1000, `延后应小于窗口长度（实测 ${delay}ms）`);
  assert.equal(nextOffPeakDelayMs({ enabled: false, schedule: true }), 0);
  assert.equal(nextOffPeakDelayMs({ enabled: true, schedule: true, windows: [{ start: '00:00', end: '00:01' }], days: [] }), 0);
  assert.equal(nextOffPeakDelayMs({ enabled: true, schedule: false }), 30 * 60 * 1000);
});

check('A2 高峰延后而不是丢弃：延迟到期后重跑一次并真正入队（live 模式）', () => {
  const deps = makeDeps({ peakCfg: peakCfgAroundNow(), slangLearn: { onlyOffPeak: true, dailyRuns: 8, queueMax: 6 } });
  let started = 0;
  const okNow = beginSlangLearnRun(deps, 'group:111', () => { started += 1; });
  assert.equal(okNow, false);
  assert.equal(started, 0, '高峰时段不能立即跑');
  assert.equal(deps.timers.length, 1, '应安排一个延后定时器');
  assert.deepEqual(slangLearnPendingKeys(), ['group:111']);
  deps.cfg.socialV2.peakPause = { enabled: false }; // 模拟窗口结束
  deps.timers[0].fn();
  assert.equal(started, 1, '窗口结束后应真正入队');
  assert.deepEqual(slangLearnPendingKeys(), []);
});
check('A3 待学队列上限：只保留最近 queueMax 个 key，最旧的定时器被清掉（live 模式）', () => {
  const deps = makeDeps({ peakCfg: peakCfgAroundNow(), slangLearn: { onlyOffPeak: true, dailyRuns: 8, queueMax: 2 } });
  beginSlangLearnRun(deps, 'group:201', () => {});
  beginSlangLearnRun(deps, 'group:202', () => {});
  beginSlangLearnRun(deps, 'group:203', () => {});
  assert.deepEqual(slangLearnPendingKeys(), ['group:202', 'group:203']);
  assert.ok(deps.logged.some((line) => line.includes('待学队列已满')));
});
check('A4 每日轮次上限（live 模式）：超出后不再跑，并留一行日志', () => {
  // 前面的用例可能已经跑过几轮，这里按「当前已跑轮次 + 1」设上限，保证本用例自洽。
  const deps = makeDeps({ slangLearn: { dailyRuns: slangLearnRunCount() + 1, onlyOffPeak: false } });
  let started = 0;
  assert.equal(beginSlangLearnRun(deps, 'group:301', () => { started += 1; }), true);
  assert.equal(started, 1);
  assert.equal(beginSlangLearnRun(deps, 'group:302', () => { started += 1; }), false);
  assert.equal(started, 1, '超出每日轮次不应再跑');
  assert.ok(deps.logged.some((line) => line.includes('今日已跑')), '应留限流日志');
});
check('A5 回退开关 enabled:false：完全回到旧行为（不判空档/日限/队列）', () => {
  const deps = makeDeps({ peakCfg: peakCfgAroundNow(), slangLearn: { enabled: false, onlyOffPeak: true, dailyRuns: 1, queueMax: 1 } });
  let started = 0;
  for (let i = 0; i < 5; i += 1) {
    beginSlangLearnRun(deps, `group:40${i}`, () => { started += 1; });
  }
  assert.equal(started, 5, 'enabled:false 时应立即执行且不限轮次');
  assert.equal(deps.timers.length, 0);
});

check('B1 步数口径：普通聊天 8、黑话学习 12，互相独立；0=不限', () => {
  const cfg = { socialV2: normalizeTokenControls({}) };
  assert.equal(turnStepLimit(cfg, false), 8);
  const withSlang = { socialV2: normalizeTokenControls({ slangLearn: { maxStepsPerRun: 3 } }) };
  assert.equal(turnStepLimit(withSlang, true), 3);
  assert.equal(turnStepLimit(withSlang, false), 8);
  assert.equal(turnStepLimit({ socialV2: { turnMaxSteps: 0 } }, false), 0);
  assert.equal(turnStepLimit({ socialV2: {} }, false), 0, '未配置=不限（配置默认值由 config-load 给）');
});

await checkAsync('B2 到顶收尾：普通聊天到 25 步调用 stopSessionWork 一次 + 发提示 + 留日志（旧版无 step 事件时按 tool/call 估步）', async () => {
  const cfg = { socialV2: { turnMaxSteps: 25, slangLearn: { maxStepsPerRun: 12 } } };
  const deps = makeDeps();
  deps.cfg = cfg;
  const sid = 'sess-normal';
  deps.reverse.set(sid, 'group:500');
  await guardTurnSteps(deps, { type: 'session/event', sessionId: sid, event: { type: 'turn/start' } });
  for (let i = 0; i < 24; i += 1) await guardTurnSteps(deps, { type: 'session/event', sessionId: sid, event: { type: 'tool/call' } });
  assert.equal(deps.stops.length, 0, '24 步不应收尾');
  await guardTurnSteps(deps, { type: 'session/event', sessionId: sid, event: { type: 'tool/call' } });
  assert.equal(deps.stops.length, 1, '第 25 步应收尾');
  assert.equal(deps.stops[0].sid, sid);
  // 2026-10-29 用户要求：到步数上限**不发任何消息**（群聊也不再发「等下 / 让我捋捋」）。
  assert.equal(deps.sentQQ.length, 0, '到顶不往群里发过渡句（发什么都像凭空插一句收尾）');
  assert.ok(deps.logged.some((line) => line.includes('普通聊天') && line.includes('25')), '具体步数只写日志');

  // 回合被中止时不该在群里播报「⏹️ 已停止」——那是系统口吻。
  const muxSrc = await (await import('node:fs/promises')).readFile(new URL('../src/bridge/mux-runtime.js', import.meta.url), 'utf8');
  const abortedBlock = muxSrc.slice(muxSrc.indexOf("ended.reason.kind === 'aborted'"), muxSrc.indexOf("ended.reason.kind === 'aborted'") + 400);
  assert.doesNotMatch(abortedBlock, /sendToQQ\([^)]*已停止/, '中止分支不再发「已停止」消息');
  assert.ok(abortedBlock.includes('回合被中止'), '中止仍然写日志');
  await guardTurnSteps(deps, { type: 'session/event', sessionId: sid, event: { type: 'tool/call' } });
  assert.equal(deps.stops.length, 1, '收尾后同一轮不应重复调 stopSessionWork');
  await guardTurnSteps(deps, { type: 'session/event', sessionId: sid, event: { type: 'turn/end' } });
  await guardTurnSteps(deps, { type: 'session/event', sessionId: sid, event: { type: 'turn/start' } });
  for (let i = 0; i < 25; i += 1) await guardTurnSteps(deps, { type: 'session/event', sessionId: sid, event: { type: 'tool/call' } });
  assert.equal(deps.stops.length, 2, '下一轮重新计数');
});
await checkAsync('B2 黑话学习会话走 12 步口径：到顶收尾但不发 QQ 提示', async () => {
  const cfg = { socialV2: { turnMaxSteps: 25, slangLearn: { maxStepsPerRun: 12 } } };
  const deps = makeDeps({ learnerSessions: new Set(['sess-learner']) });
  deps.cfg = cfg;
  const sid = 'sess-learner';
  await guardTurnSteps(deps, { type: 'session/event', sessionId: sid, event: { type: 'turn/start' } });
  for (let i = 0; i < 12; i += 1) await guardTurnSteps(deps, { type: 'session/event', sessionId: sid, event: { type: 'tool/call' } });
  assert.equal(deps.stops.length, 1);
  assert.equal(deps.sentQQ.length, 0, '黑话学习会话不该往群里发提示');
  assert.ok(deps.logged.some((line) => line.includes('黑话学习') && line.includes('12')));
});
await checkAsync('B2b 到顶一律不发消息：私聊、群聊都安静收尾', async () => {
  const cfg = { socialV2: { turnMaxSteps: 25, slangLearn: { maxStepsPerRun: 12 } } };
  const deps = makeDeps();
  deps.cfg = cfg;
  const sid = 'sess-private';
  deps.reverse.set(sid, 'private:100000015');
  await guardTurnSteps(deps, { type: 'session/event', sessionId: sid, event: { type: 'turn/start' } });
  for (let i = 0; i < 25; i += 1) await guardTurnSteps(deps, { type: 'session/event', sessionId: sid, event: { type: 'tool/call' } });
  assert.equal(deps.stops.length, 1, '私聊到顶照样收尾');
  assert.equal(deps.sentQQ.length, 0, '私聊里绝不能发「等下 / 让我捋捋」这类话');
  assert.ok(deps.logged.some((line) => line.includes('普通聊天') && line.includes('25')), '步数照旧只写日志');
  // 群聊同样闭嘴（旧行为是群聊发、私聊不发；现在两边都不发）
  const groupDeps = makeDeps();
  groupDeps.cfg = cfg;
  groupDeps.reverse.set('sess-g', 'group:100000001');
  await guardTurnSteps(groupDeps, { type: 'session/event', sessionId: 'sess-g', event: { type: 'turn/start' } });
  for (let i = 0; i < 25; i += 1) await guardTurnSteps(groupDeps, { type: 'session/event', sessionId: 'sess-g', event: { type: 'tool/call' } });
  assert.equal(groupDeps.stops.length, 1, '群聊到顶照样停');
  assert.equal(groupDeps.sentQQ.length, 0, '群聊也不发收尾话');
});
await checkAsync('B3 回退开关 turnMaxSteps=0：不管跑多少步都不收尾', async () => {
  const deps = makeDeps();
  deps.cfg = { socialV2: { turnMaxSteps: 0, slangLearn: { maxStepsPerRun: 12 } } };
  await guardTurnSteps(deps, { type: 'session/event', sessionId: 'sess-x', event: { type: 'turn/start' } });
  for (let i = 0; i < 40; i += 1) await guardTurnSteps(deps, { type: 'session/event', sessionId: 'sess-x', event: { type: 'tool/call' } });
  assert.equal(deps.stops.length, 0);
  assert.equal(deps.logged.length, 0);
});

check('C1 白名单默认：deepseek 系（flash/pro）放行，mimo / glm 等非 deepseek 过滤', () => {
  const deps = { cfg: { socialV2: normalizeTokenControls({}) } };
  const allowed = [
    { provider: 'workbuddy2api', model: 'deepseek-v4.1-flash' },
    { provider: 'deepseek-account', model: 'deepseek-flash' },
    { provider: 'DeepSeek-Account', model: 'DeepSeek-V4-FLASH-EXP' },
    // 10-29 放宽后 pro 属于 deepseek 系，必须放行：降级链里就有 deepseek-v4-pro。
    { provider: 'workbuddy2api', model: 'deepseek-v4-pro' },
    { provider: 'deepseek-account', model: 'deepseek-v4-pro' }
  ];
  const blocked = [
    { provider: 'xiaomi-mimo', model: 'mimo-v2.6-pro' },
    { provider: 'xiaomi-mimo', model: 'mimo-v2.6-flash' },
    { provider: 'workbuddy2api', model: 'glm-5.3' }
  ];
  for (const m of allowed) assert.equal(isChatModelAllowed(deps, m), true, `${m.provider}/${m.model} 应放行`);
  for (const m of blocked) assert.equal(isChatModelAllowed(deps, m), false, `${m.provider}/${m.model} 应过滤`);
  assert.deepEqual(filterChatModels(deps, [...allowed, ...blocked]), allowed);
});
check('C1 回退开关 []（不过滤）：pro 也能用；自定义规则生效', () => {
  const off = { cfg: { socialV2: normalizeTokenControls({ modelRouting: { allowedProviderModels: [] } }) } };
  assert.equal(isChatModelAllowed(off, { provider: 'workbuddy2api', model: 'deepseek-v4-pro' }), true);
  const custom = { cfg: { socialV2: normalizeTokenControls({ modelRouting: { allowedProviderModels: ['workbuddy2api/*'] } }) } };
  assert.equal(isChatModelAllowed(custom, { provider: 'workbuddy2api', model: 'deepseek-v4-pro' }), true);
  assert.equal(isChatModelAllowed(custom, { provider: 'deepseek-account', model: 'deepseek-flash' }), false);
  const bad = { cfg: { socialV2: { modelRouting: { allowedProviderModels: ['[bad'] } } } };
  assert.equal(isChatModelAllowed(bad, { provider: 'p', model: 'm' }), false, '非法 glob 不应抛错');
});

// ---- P1：daily 模式（每天累计 + 固定时间集中跑一批） ----
check('D1 nextDailyAtMs：当天未到→今天，已过→明天，正好到点→明天，非法 at 回退 04:20', () => {
  const base = new Date(2026, 9, 28); // 2026-10-28 本地时间
  const at = (h, m) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, 0, 0).getTime();
  const day = 24 * 3600 * 1000;
  assert.equal(nextDailyAtMs('04:20', at(3, 0)), at(4, 20), '当天未到应排今天');
  assert.equal(nextDailyAtMs('04:20', at(5, 0)), at(4, 20) + day, '当天已过应顺延到明天');
  assert.equal(nextDailyAtMs('04:20', at(4, 20)), at(4, 20) + day, '正好到点也顺延（避免同分钟重复触发）');
  assert.equal(nextDailyAtMs('23:59', at(23, 0)), at(23, 59));
  assert.equal(nextDailyAtMs('25:99', at(3, 0)), at(4, 20), '非法 at 回退 04:20');
  assert.equal(nextDailyAtMs(undefined, at(3, 0)), at(4, 20));
});

await checkAsync('D2 daily 模式不立即跑：只累计 pending，多个 key 全局只挂一个到点定时器', async () => {
  // 清掉前面 live 用例遗留的 pending（A3 留了 group:202/203），避免影响本块断言。
  await runDailyBatch(makeDeps({ slangLearn: { mode: 'daily', dailyRuns: 0 } }));
  slangLearnCancelDailyTimer();
  const deps = makeDeps({ slangLearn: { enabled: true, mode: 'daily', at: '04:20', dailyRuns: 0, queueMax: 6 } });
  const started = [];
  assert.equal(beginSlangLearnRun(deps, 'group:901', () => { started.push('901'); }), true);
  assert.equal(beginSlangLearnRun(deps, 'group:902', () => { started.push('902'); }), true);
  assert.deepEqual(started, [], 'daily 模式不能立即跑');
  assert.deepEqual(slangLearnPendingKeys(), ['group:901', 'group:902']);
  assert.equal(deps.timers.length, 1, '两个 key 只挂一个定时器');
  assert.equal(slangLearnDailyTimerArmed(), true);
  assert.ok(deps.logged.some((line) => line.includes('2 个会话待学') && line.includes('04:20')), '应留「已累计 N 个会话待学」日志');
  await runDailyBatch(deps); // 跑掉本用例的 pending，避免污染 D3 的「本批 N 个会话」计数
});

await checkAsync('D3 到点按序跑：按累计顺序 start、跑完清 pending、批开始前先重置学习会话', async () => {
  const deps = makeDeps({ slangLearn: { enabled: true, mode: 'daily', at: '04:20', dailyRuns: 0, queueMax: 6, freshSessionPerBatch: true } });
  slangLearnCancelDailyTimer();
  beginSlangLearnRun(deps, 'group:911', () => { deps.actions.push('start:911'); });
  beginSlangLearnRun(deps, 'group:912', () => { deps.actions.push('start:912'); });
  const before = slangLearnRunCount();
  await runDailyBatch(deps);
  assert.deepEqual(deps.actions, ['invalidate', 'start:911', 'start:912'], '批开始前先重置会话，再按累计顺序依次跑');
  assert.deepEqual(slangLearnPendingKeys(), []);
  assert.equal(slangLearnRunCount(), before + 1, '一批只记一次');
  assert.ok(deps.logged.some((line) => line.includes('到点开跑') && line.includes('2 个会话')));
  assert.ok(deps.logged.some((line) => line.includes('本批已跑完')));
});

await checkAsync('D4 每日批次数上限：到达 dailyRuns 后到点也不跑，并留跳过日志', async () => {
  slangLearnCancelDailyTimer();
  const cap = slangLearnRunCount();
  const deps = makeDeps({ slangLearn: { enabled: true, mode: 'daily', at: '04:20', dailyRuns: cap, queueMax: 6 } });
  let started = 0;
  beginSlangLearnRun(deps, 'group:921', () => { started += 1; });
  await runDailyBatch(deps);
  assert.equal(started, 0, '到达上限不应再跑');
  assert.ok(deps.logged.some((line) => line.includes('今日已跑') && line.includes('跳过')));
  slangLearnClearPending(); // 到上限时 pending 会被保留到明天，这里清掉避免污染后续用例
});

check('D5 回退开关 freshSessionPerBatch=false：批量前不重置学习会话', () => {
  const off = makeDeps({ slangLearn: { enabled: true, mode: 'daily', freshSessionPerBatch: false } });
  assert.equal(resetLearnerSessionForBatch(off), false);
  assert.equal(off.invalidates, 0);
  const on = makeDeps({ slangLearn: { enabled: true, mode: 'daily', freshSessionPerBatch: true } });
  assert.equal(resetLearnerSessionForBatch(on), true);
  assert.equal(on.invalidates, 1);
});

check('D6 回退开关 mode=live：恢复实时触发，且不挂 daily 定时器', () => {
  slangLearnCancelDailyTimer();
  const deps = makeDeps({ slangLearn: { enabled: true, mode: 'live', dailyRuns: 0, onlyOffPeak: false } });
  let started = 0;
  assert.equal(beginSlangLearnRun(deps, 'group:931', () => { started += 1; }), true);
  assert.equal(started, 1, 'live 模式应立即跑');
  assert.equal(slangLearnDailyTimerArmed(), false, 'live 模式不该挂 daily 定时器');
  assert.deepEqual(slangLearnPendingKeys(), []);
});

await checkAsync('D7 步数口径以 step/start 为准：138 步那种轮次也能停在 12/25 步，tool/call 不重复计数', async () => {
  const cfg = { socialV2: { turnMaxSteps: 25, slangLearn: { maxStepsPerRun: 12 } } };
  const learnerDeps = makeDeps({ learnerSessions: new Set(['sess-learner-2']) });
  learnerDeps.cfg = cfg;
  await guardTurnSteps(learnerDeps, { type: 'session/event', sessionId: 'sess-learner-2', event: { type: 'turn/start' } });
  for (let i = 0; i < 60; i += 1) {
    await guardTurnSteps(learnerDeps, { type: 'session/event', sessionId: 'sess-learner-2', event: { type: 'step/start' } });
    await guardTurnSteps(learnerDeps, { type: 'session/event', sessionId: 'sess-learner-2', event: { type: 'tool/call' } });
  }
  assert.equal(learnerDeps.stops.length, 1, '学习会话应在第 12 个 step/start 收尾');
  assert.equal(learnerDeps.sentQQ.length, 0, '学习会话不发 QQ');
  const normalDeps = makeDeps();
  normalDeps.cfg = cfg;
  normalDeps.reverse.set('sess-normal-2', 'group:600');
  await guardTurnSteps(normalDeps, { type: 'session/event', sessionId: 'sess-normal-2', event: { type: 'turn/start' } });
  for (let i = 0; i < 25; i += 1) await guardTurnSteps(normalDeps, { type: 'session/event', sessionId: 'sess-normal-2', event: { type: 'step/start' } });
  assert.equal(normalDeps.stops.length, 1, '第 25 个 step/start 应收尾');
  assert.equal(normalDeps.sentQQ.length, 0, '到顶安静收尾，不发任何消息');
});

// ── 工具结果的错误文本与「取消回执」──
// 线上事故：回合被中止后正在飞行的 qq_send_message 被取消，DSH 给的是对象错误体，
// 直接 String() 成「[object Object]」，控制台显示成一条红色「发送失败」——其实消息发出去了。
check('对象错误体取 message，而不是 [object Object]', () => {
  const { errorText, cancelled } = describeToolResult({ resultError: true, rawError: { code: 'ABORTED', message: 'call cancelled' }, abortAt: 1000, now: 2000 });
  assert.equal(errorText, 'call cancelled');
  assert.equal(cancelled, true);
});
check('对象没有 message 时落成 JSON（含 code）', () => {
  const { errorText } = describeToolResult({ resultError: true, rawError: { code: 'ABORTED' }, abortAt: 0, now: 1 });
  assert.match(errorText, /ABORTED/);
  assert.doesNotMatch(errorText, /object Object/);
});
check('字符串错误原样保留', () => {
  const { errorText } = describeToolResult({ resultError: true, rawError: 'Error: boom', abortAt: 0, now: 1 });
  assert.equal(errorText, 'Error: boom');
});
check('成功结果没有错误文本、也不算取消', () => {
  const { errorText, cancelled } = describeToolResult({ resultError: false, rawError: { message: 'x' }, abortAt: 1, now: 2 });
  assert.equal(errorText, '');
  assert.equal(cancelled, false);
});
check('中止后 15 秒内算取消', () => {
  assert.equal(describeToolResult({ resultError: true, rawError: 'x', abortAt: 1000, now: 16000 }).cancelled, true);
});
check('中止 15 秒之后仍是真失败', () => {
  assert.equal(describeToolResult({ resultError: true, rawError: 'x', abortAt: 1000, now: 17001 }).cancelled, false);
});
check('没有中止记录时不乱判取消', () => {
  assert.equal(describeToolResult({ resultError: true, rawError: 'x', abortAt: 0, now: 1000 }).cancelled, false);
});

console.log(`\n通过 ${passed} / 失败 ${failed}`);
process.exit(failed > 0 ? 1 : 0);
