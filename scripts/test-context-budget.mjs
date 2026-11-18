import { readBridgeSources } from './bridge-source.mjs';
// D45：上下文预算回收的回归测试。
//
// 这条线是止损项（每步重发的历史让 token 随会话长度线性涨），所以负例是重点：
// 关掉开关必须**完全不动作**（连 RPC 都不打）、拿不到压力必须 fail-open（继续用，不回收、不报错）、
// 轮次不够时不许回收（防抖）。另外把「不许每步打 RPC」也测成断言：TTL 内多次检查只打一次。
//
// 全程不连 DSH：RPC 由测试注入的假 call 提供；不读写真实 state/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  budgetConfig, pressureSnapshot, decideBudgetAction, formatBudgetLog, createContextPressureProbe, createBudgetRunner, BUDGET_DEFAULTS
} from '../src/context-budget.js';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 造一个 DSH `session/projections` 的返回值（形状与 ctx-report.mjs 同一口径）
const projections = ({ projected, window = 1_048_576, used = null, turns = null }) => ({
  kind: 'session/projections',
  asOfSeq: 1,
  values: {
    contextPressure: { pressureTokens: used ?? projected, projectedTokens: projected, contextWindow: window },
    ...(turns === null ? {} : { sessionStats: { turns } })
  }
});
const ENABLED = { enabled: true, maxPressurePct: 55, minTurnsBeforeRecycle: 20 };

console.log('## 1. 配置：没有该键＝关闭，非法值回落默认');
{
  check('没有 contextBudget 键 → 关闭（用户没拍板就绝不动手）', budgetConfig(undefined).enabled === false);
  check('空对象 → 关闭', budgetConfig({}).enabled === false);
  check('enabled: "true"（字符串）→ 仍然关闭（只认布尔 true）', budgetConfig({ enabled: 'true' }).enabled === false);
  check('enabled: true → 打开', budgetConfig({ enabled: true }).enabled === true);
  const bad = budgetConfig({ enabled: true, maxPressurePct: 0, minTurnsBeforeRecycle: -3 });
  check('maxPressurePct 0 非法 → 回落默认值', bad.maxPressurePct === BUDGET_DEFAULTS.maxPressurePct);
  check('minTurnsBeforeRecycle 负数非法 → 回落 20', bad.minTurnsBeforeRecycle === BUDGET_DEFAULTS.minTurnsBeforeRecycle);
  check('maxPressurePct 超过 100 → 回落默认值', budgetConfig({ enabled: true, maxPressurePct: 150 }).maxPressurePct === BUDGET_DEFAULTS.maxPressurePct);
  check('合法值原样生效（40 / 5）',
    budgetConfig({ enabled: true, maxPressurePct: 40, minTurnsBeforeRecycle: 5 }).maxPressurePct === 40
    && budgetConfig({ enabled: true, maxPressurePct: 40, minTurnsBeforeRecycle: 5 }).minTurnsBeforeRecycle === 5);
}

console.log('## 2. 压力解析：缺字段一律 null（fail-open 的入口）');
{
  const snap = pressureSnapshot(projections({ projected: 431_372, turns: 57 }));
  check('正常值：pct=41.1、turns=57', snap && snap.pct === 41.1 && snap.turns === 57, JSON.stringify(snap));
  check('values 缺失但顶层直给 → 也能解析', pressureSnapshot({ contextPressure: { contextWindow: 1000, projectedTokens: 500 } })?.pct === 50);
  check('没有 contextPressure → null', pressureSnapshot({ values: {} }) === null);
  check('contextWindow 为 0 → null（算不出比例，别瞎判）', pressureSnapshot(projections({ projected: 100, window: 0 })) === null);
  check('projectedTokens 缺失但有 pressureTokens → 用 pressure 兜底',
    pressureSnapshot({ contextPressure: { contextWindow: 1000, pressureTokens: 250 } })?.pct === 25);
  check('全是垃圾输入 → null 而不是抛错', pressureSnapshot(null) === null && pressureSnapshot('x') === null && pressureSnapshot(42) === null);
  check('sessionStats 缺失 → turns=null（交给调用方兜底，不冒充当 0）',
    pressureSnapshot(projections({ projected: 1000 })).turns === null);
}

console.log('## 3. 决策：超阈值→回收 / 未超→不回收 / 开关关→不动作 / minTurns 生效');
{
  const over = decideBudgetAction(ENABLED, pressureSnapshot(projections({ projected: 600_000, turns: 30 })));
  check('57.2% ≥ 55% 且轮次够 → recycle', over.action === 'recycle' && over.why === 'over-budget', JSON.stringify(over));

  const under = decideBudgetAction(ENABLED, pressureSnapshot(projections({ projected: 300_000, turns: 30 })));
  check('28.6% < 55% → keep', under.action === 'keep' && under.why === 'under-budget', JSON.stringify(under));

  check('正好压线 55% → recycle（≥ 而不是 >，免得贴着线一直涨）',
    decideBudgetAction(ENABLED, pressureSnapshot(projections({ projected: 576_717, turns: 30 }))).action === 'recycle');

  const off = decideBudgetAction(budgetConfig(undefined), pressureSnapshot(projections({ projected: 900_000, turns: 99 })));
  check('开关关闭 → skip（压力再高也不回收）', off.action === 'skip' && off.why === 'disabled');

  const tooEarly = decideBudgetAction(ENABLED, pressureSnapshot(projections({ projected: 900_000, turns: 19 })));
  check('minTurnsBeforeRecycle=20：19 轮 → keep（防抖，刚建的会话别乱换）',
    tooEarly.action === 'keep' && tooEarly.why === 'min-turns', JSON.stringify(tooEarly));
  const justEnough = decideBudgetAction(ENABLED, pressureSnapshot(projections({ projected: 900_000, turns: 20 })));
  check('20 轮整 → recycle（边界包含）', justEnough.action === 'recycle');
  const noTurns = decideBudgetAction(ENABLED, pressureSnapshot(projections({ projected: 900_000 })));
  check('轮次未知 → keep（fail-open，不拿缺数据当超线）', noTurns.action === 'keep' && noTurns.why === 'no-turns');

  const noData = decideBudgetAction(ENABLED, null);
  check('压力拿不到（null）→ keep 且 why=no-pressure（fail-open）',
    noData.action === 'keep' && noData.why === 'no-pressure');
}

console.log('## 4. 探针：TTL 60s / 单飞 / 超时 / 失败冷却全部 fail-open');
{
  // 4.1 TTL：60 秒内多次检查只打一次 RPC（「不许每步都打 RPC」的机器化断言）
  let calls = 0;
  let clock = 1_000_000;
  const probe = createContextPressureProbe({
    now: () => clock,
    call: async () => { calls += 1; return projections({ projected: 100_000, turns: 50 }); }
  });
  await probe.get('s1');
  const afterFirst = calls;
  for (let i = 0; i < 20; i++) { clock += 2_000; await probe.get('s1'); } // 走了 40 秒
  check(`TTL 内 21 次检查只打 ${afterFirst} 次 RPC（不许每步都打）`, afterFirst === 1 && calls === 1, `calls=${calls}`);  clock += 25_000; // 累计 65 秒，过期
  await probe.get('s1');
  check('超过 60 秒 TTL 才重新取一次', calls === 2, `calls=${calls}`);
  check('同一个会话不同 sid 各自缓存', (await probe.get('s2')) !== null && calls === 3);

  // 4.2 单飞：并发 5 次只打一次 RPC
  let conc = 0;
  const probe2 = createContextPressureProbe({
    call: async () => { conc += 1; await sleep(30); return projections({ projected: 222_222, turns: 7 }); }
  });
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => probe2.get('same')));
  check('5 个并发 get 合并成 1 次 RPC（单飞）', conc === 1 && all.every((x) => x && x.turns === 7), `conc=${conc}`);

  // 4.3 RPC 抛错 → 返回 null（fail-open），且 60 秒内不再重试（免得 DSH 半死时每条消息白等 5 秒）
  let boom = 0;
  let clock3 = 5_000_000;
  const probe3 = createContextPressureProbe({
    now: () => clock3,
    call: async () => { boom += 1; throw new Error('DSH 挂了'); }
  });
  const r1 = await probe3.get('s3');
  const r2 = await probe3.get('s3');
  check('RPC 失败 → 返回 null（不抛，不回收）', r1 === null && r2 === null);
  check(`失败后 60 秒内不再重试：只打了 ${boom} 次`, boom === 1, `calls=${boom}`);
  clock3 += 61_000;
  const r3 = await probe3.get('s3');
  check('过了冷却期会重试（DSH 恢复后能自愈）', boom === 2 && r3 === null);
  check('RPC 失败不改变决策：null 快照 → keep',
    decideBudgetAction(ENABLED, r3).action === 'keep');

  // 4.4 缺字段（DSH 版本不同/字段改名）→ 当作失败，fail-open
  const probe4 = createContextPressureProbe({ call: async () => ({ values: { somethingElse: 1 } }) });
  check('返回值缺 contextPressure → null（fail-open）', (await probe4.get('s4')) === null);

  // 4.5 超时：底层 RPC 挂住 → 5 秒（这里缩到 50ms）后返回 null，不把调用方拖死
  const probe5 = createContextPressureProbe({
    timeoutMs: 50,
    call: () => new Promise(() => {}) // 永不 resolve
  });
  const t0 = Date.now();
  const timedOut = await probe5.get('s5');
  const spent = Date.now() - t0;
  check(`RPC 挂住 → ${spent}ms 后 fail-open 返回 null（不无限等）`, timedOut === null && spent < 2000, `spent=${spent}ms`);
  check('超时后 stats 记到一次失败', probe5.stats().failures === 1);

  // 4.6 getDetail 的 cached 标记：调用方靠它决定「这次要不要打日志」
  //     （每轮一行的日志会把只有 128KB 的 state/bridge.log 几小时冲干净）
  let calls6 = 0;
  let clock6 = 9_000_000;
  const probe6 = createContextPressureProbe({
    now: () => clock6,
    call: async () => { calls6 += 1; return projections({ projected: 90_000, turns: 30 }); }
  });
  const d1 = await probe6.getDetail('s6');
  const d2 = await probe6.getDetail('s6');
  check('首次 getDetail：有数据 + cached=false（这次该打日志）',
    d1.snap !== null && d1.cached === false, JSON.stringify({ cached: d1.cached }));
  check('TTL 内再查：cached=true（不该再打一行 keep 日志）',
    d2.snap !== null && d2.cached === true && calls6 === 1, `calls=${calls6}`);
  clock6 += 61_000;
  const d3 = await probe6.getDetail('s6');
  check('过了 TTL：cached=false（又重新真查一次）', d3.cached === false && calls6 === 2, `calls=${calls6}`);
  const failing = createContextPressureProbe({ call: async () => { throw new Error('x'); } });
  const dfail = await failing.getDetail('s7');
  check('失败时 getDetail 也是 fail-open：snap=null 且不抛', dfail.snap === null);
}

console.log('## 5. 日志行（用户要用它做量化，格式别随手改）');
{
  const snap = pressureSnapshot(projections({ projected: 431_372, turns: 57 }));
  const line = formatBudgetLog('group:100000006', snap, decideBudgetAction(ENABLED, snap));
  check('含 key / pressure / tokens / 动作',
    line.includes('key=group:100000006') && line.includes('pressure=41.1%~') && line.includes('tokens=431.4k') && line.includes('动作=keep'),
    line);
  const line2 = formatBudgetLog('group:1', null, { action: 'keep', why: 'no-pressure', pct: null });
  check('拿不到压力时打 ?，不打出 undefined/NaN', line2.includes('pressure=?~') && line2.includes('tokens=?') && !/undefined|NaN/.test(line2), line2);
  const line3 = formatBudgetLog('group:1', pressureSnapshot(projections({ projected: 600_000, turns: 30 })),
    decideBudgetAction(ENABLED, pressureSnapshot(projections({ projected: 600_000, turns: 30 }))));
  check('回收动作写成 动作=recycle', line3.includes('动作=recycle') && line3.includes('why=over-budget'), line3);
}

console.log('## 6. 接线（静态断言）：bridge 真的在轮末调用，且复用现成的退役+重建');
{
  // ④/D62 之后两处接线搬了家：turn 末尾预算仍由 bridge.js 的 handleMuxFrame 调，
  // 但「每 N 轮 / 每 10 分钟」的 sweep 触发在 boot/recycle-loops.js 与 session-recycle.js 里。
  // 所以这里搜 bridge.js + boot/*.js + console/*.js 的职责跨越视图，而不是单文件文本。
  const bridgeSrc = readBridgeSources();
  const moduleSrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'context-budget.js'), 'utf8');
  check('bridge 引入了 context-budget 模块', /from '\.\/context-budget\.js'/.test(bridgeSrc));
  check('压力来自 DSH 的 session/projections（不是自己估算）',
    /callUnary\('session\/projections'/.test(bridgeSrc));
  check('RPC 有 60 秒 TTL + 5 秒超时（不许每步都打）',
    /CONTEXT_BUDGET_TTL_MS = 60 \* 1000/.test(bridgeSrc) && /CONTEXT_BUDGET_TIMEOUT_MS = 5000/.test(bridgeSrc));
  check('轮末（turn/end 的 ended 分支）触发，且 fire-and-forget + catch',
    /if \(ended\) \{[\s\S]{0,900}handleTurnEnd\(deps, frame, key, ended\)/.test(bridgeSrc)
    && /budgetTickForTurn\(key, frame\.sessionId\)[\s\S]{0,300}void pending\.catch/.test(bridgeSrc));
  // D51：守卫为假时以前是「直接不检查也不打日志」，现在必须留痕并交给 sweep
  check('映射不一致不再静默：走 noteMismatch（会打 warn 并计数）',
    /if \(mapped !== sessionId\) \{\s*\n\s*budgetRunnerInstance\(\)\.noteMismatch/.test(bridgeSrc));
  check('frame 没有 key 时也留痕（noteNoKey）', /budgetRunnerInstance\(\)\.noteNoKey\(frame\.sessionId\)/.test(bridgeSrc));
  check('兜底 sweep：按时间（10 分钟）与按轮数（每 10 轮）两条触发',
    /CONTEXT_BUDGET_SWEEP_INTERVAL_MS = 10 \* 60 \* 1000/.test(bridgeSrc)
    && /CONTEXT_BUDGET_SWEEP_EVERY_N_TURNS = 10/.test(bridgeSrc)
    && /setInterval\(\(\) => \{ void (?:wired\.)?scheduleBudgetSweep\('timer'\); \}/.test(bridgeSrc)
    && /budgetTurnsSinceSweep >= CONTEXT_BUDGET_SWEEP_EVERY_N_TURNS\) scheduleBudgetSweep\('turns'\)/.test(bridgeSrc));
  check('sweep 只扫白名单内的会话（isSessionAllowedInCurrentMode）',
    /if \(!isSessionAllowedInCurrentMode\(key\)\) continue;/.test(bridgeSrc));
  check('sweep 单飞（不叠着扫）', /if \(budgetSweepPromise\) return budgetSweepPromise;/.test(bridgeSrc));
  check('回收复用 retireSession（内含 digest 交接），不另写重建',
    /retireSession\(key\); \/\/ 内含 saveHandoffDigest/.test(bridgeSrc));
  check('回收后记 sessionResets.reason=budget（sessionRecycle 的计时会跟着重算）',
    /reason: 'budget'/.test(bridgeSrc));
  check('回收前核对会话没被别的路径换掉（别砍错人）',
    /if \(state\.sessions\[key\] !== sessionId\) \{/.test(bridgeSrc));
  check('配置键就是 socialV2.contextBudget', /socialV2\?\.contextBudget/.test(bridgeSrc));
  // 日志纪律在 runner 里（D51 把决策搬进模块，bridge 只注入副作用）
  check('keep 日志只在「真查了一次」或「要回收」时才打（别每轮一行冲掉 bridge.log）',
    /if \(fresh \|\| decision\.action === 'recycle'\) say\(formatBudgetLog/.test(moduleSrc));
  check('/api/status 暴露 budget 计数', /budget: budgetRunnerInstance\(\)\.snapshot\(\)/.test(bridgeSrc));
  check('/api/debug/budget 存在，且对 agent 头一律 403（含群号）',
    /url\.pathname === '\/api\/debug\/budget'/.test(bridgeSrc)
    && /预算计数含群号，不对会话级主体开放/.test(bridgeSrc));
}

console.log('## 7. 执行器（D51）：mismatch 留痕 / sweep 兜底 / 幂等 / fail-open / minTurns');
{
  // 造一个可控的执行器：压力、回收、日志全都记下来，不碰任何真实文件
  const makeRunner = ({ enabled = true, pressure = null, turns = 30 } = {}) => {
    const calls = { pressure: 0, recycled: [], logged: [] };
    const pressureFn = pressure ?? (async () => ({ snap: { window: 1_048_576, used: 706_000, projected: 706_000, turns, pct: 67.3 }, cached: false }));
    const runner = createBudgetRunner({
      getConfig: () => ({ enabled, maxPressurePct: 15, minTurnsBeforeRecycle: 20 }),
      getPressure: async (sid) => { calls.pressure += 1; return pressureFn(sid); },
      getTurns: () => turns,
      recycle: ({ key }) => { calls.recycled.push(key); return true; },
      log: (line) => calls.logged.push(String(line)),
      now: () => Date.now()
    });
    return { runner, calls };
  };

  // 7.1 mismatch：留痕（且只留一次），不误回收
  {
    const { runner, calls } = makeRunner();
    const changed1 = runner.noteMismatch({ key: 'group:100000009', mappedSid: 'session-aaaaaaaa1111', actualSid: 'session-bbbbbbbb2222' });
    const changed2 = runner.noteMismatch({ key: 'group:100000009', mappedSid: 'session-aaaaaaaa1111', actualSid: 'session-bbbbbbbb2222' });
    check('mismatch 第一次打 warn（含两侧 sid 后 8 位）',
      changed1 === true && calls.logged.some((l) => l.includes('跳过') && l.includes('1111') && l.includes('2222')), calls.logged.join(' | '));
    check('同一组 mismatch 第二次不再刷屏（去重）', changed2 === false && calls.logged.length === 1, `logs=${calls.logged.length}`);
    check('mismatch 只计数、不产生回收', calls.recycled.length === 0 && runner.snapshot().skipsSessionMismatch === 2);
    check('映射换了新的 sid → 会再打一次', runner.noteMismatch({ key: 'group:100000009', mappedSid: 'session-aaaaaaaa1111', actualSid: 'session-cccccccc3333' }) === true);
    runner.clearMismatch('group:100000009');
    check('恢复后清状态：同一条 mismatch 能再打出来',
      runner.noteMismatch({ key: 'group:100000009', mappedSid: 'session-aaaaaaaa1111', actualSid: 'session-bbbbbbbb2222' }) === true);
  }

  // 7.2 sweep：超阈值就回收（不依赖回合末映射）
  {
    const { runner, calls } = makeRunner();
    const r = await runner.sweep({ sessions: { 'group:a': 'sid-a', 'group:b': 'sid-b' } });
    check('sweep 扫到 2 个会话并回收 2 个', r.entries === 2 && r.recycled === 2 && calls.recycled.length === 2, JSON.stringify(r));
    check('sweep 计数记到 snapshot', runner.snapshot().sweeps === 1 && runner.snapshot().recycles === 2 && runner.snapshot().sweepRecycles === 2);
    check('sweep 也记录 lastKey/lastPct/lastAt（可观测）',
      runner.snapshot().lastKey === 'group:b' && runner.snapshot().lastPct === 67.3 && Number.isFinite(runner.snapshot().lastAt));
  }

  // 7.3 幂等：回合末刚回收过的 key，sweep 在 hold 窗口内不再砍
  {
    const { runner, calls } = makeRunner();
    await runner.checkTurn({ key: 'group:a', sessionId: 'sid-a' });
    const before = calls.recycled.length;
    const r = await runner.sweep({ sessions: { 'group:a': 'sid-a' } });
    check('回合末回收后，sweep 不再回收同一个 key（幂等）',
      before === 1 && r.recycled === 0 && calls.recycled.length === 1, `recycled=${calls.recycled.length}`);
    check('幂等跳过的原因记在 skipsHeld 与日志里',
      runner.snapshot().skipsHeld === 1 && calls.logged.some((l) => l.includes('刚回收过')));
  }

  // 7.4 RPC 失败：fail-open（不回收、不抛、计数）
  {
    const { runner, calls } = makeRunner({ pressure: async () => { throw new Error('DSH 挂了'); } });
    const r = await runner.checkTurn({ key: 'group:a', sessionId: 'sid-a' });
    check('RPC 抛错时 checkTurn 正常返回且不回收',
      r.action === 'keep' && r.recycled === false && calls.recycled.length === 0, JSON.stringify(r));
    check('抛错计入 errors 与 checks（可观测，不是无声）',
      runner.snapshot().errors === 1 && runner.snapshot().checks === 1);
    const { runner: r2, calls: c2 } = makeRunner({ pressure: async () => ({ snap: null, cached: false }) });
    const r2r = await r2.sweep({ sessions: { 'group:a': 'sid-a' } });
    check('探针返回 null（超时/缺字段）时 sweep 也不回收', r2r.recycled === 0 && c2.recycled.length === 0);
  }

  // 7.5 sweep 也遵守 minTurnsBeforeRecycle（不能因为它绕开回合就绕过防抖）
  {
    const { runner, calls } = makeRunner({ turns: 5 });
    const r = await runner.sweep({ sessions: { 'group:a': 'sid-a' } });
    check('轮次不足 20：sweep 不回收（why=min-turns）', r.recycled === 0 && calls.recycled.length === 0, JSON.stringify(r));
    check('但压力仍然被记录（lastPct 有值，说明查了不是没查）', runner.snapshot().lastPct === 67.3);
  }

  // 7.6 开关关闭：连 RPC 都不打
  {
    const { runner, calls } = makeRunner({ enabled: false });
    const a = await runner.checkTurn({ key: 'group:a', sessionId: 'sid-a' });
    const b = await runner.sweep({ sessions: { 'group:a': 'sid-a' } });
    check('关闭时 checkTurn/sweep 都是 skip，且一次 RPC 都没打',
      a.action === 'skip' && b.skipped === 'disabled' && calls.pressure === 0 && calls.recycled.length === 0);
  }

  // 7.7 frame 没有 key：留痕一次
  {
    const { runner, calls } = makeRunner();
    runner.noteNoKey('session-zzzz9999');
    runner.noteNoKey('session-zzzz9999');
    check('无 key 的会话留痕一次（不刷屏）并计数',
      calls.logged.length === 1 && runner.snapshot().skipsNoKey === 2 && calls.logged[0].includes('9999'));
  }
}

console.log('');
const total = pass + failures.length;
if (failures.length) {
  console.log(`❌ test-context-budget 失败 ${failures.length}/${total}`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log(`✅ test-context-budget 全部通过（${pass}/${total}）`);
assert.ok(true);
