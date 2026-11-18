// D46：预算效果量化探针的回归测试。
//
// 探针读的是线上 state/（只读），所以它的解析与统计一旦错，会给出「看起来很像真的」
// 假结论——比没有探针更糟。这里用合成输入逐段钉住：日志解析、token-usage 解析、
// 回收前后对比、截断估算、报告的空数据分支。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseCompactNumber, parseBudgetLog, parseTurnUsage, median,
  summarizeBudget, hourlyTrend, recycleEffect, simulate, buildReport
} from './probe-budget-effect.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

const BASE = new Date(2026, 9, 27, 14, 0, 0); // 2026-10-27 14:00 本地
const log = [
  '13:14:10 [bridge] [预算] key=group:1 pressure=51.5%~ tokens=540.0k turns=461 动作=recycle why=over-budget',
  '13:14:10 [bridge] [预算] group:1 按预算回收（51.5% ≥ 15%），下一轮重建',
  '13:15:02 [bridge] [预算] key=group:1 pressure=2.1%~ tokens=22.0k turns=1 动作=keep why=min-turns',
  '13:16:00 [bridge] [预算] key=group:2 pressure=?~ tokens=? turns=? 动作=keep why=no-pressure',
  '13:17:00 [bridge] group:1 与预算无关的一行',
  '2026/10/27 13:18:00 [bridge] [预算] key=group:3 pressure=30.0%~ tokens=314.6k turns=9 动作=keep why=min-turns'
].join('\n');

console.log('## 1. 日志解析');
{
  const events = parseBudgetLog(log, { baseDate: BASE });
  const checks = events.filter((e) => e.kind === 'check');
  const recs = events.filter((e) => e.kind === 'recycle');
  check('只认 [预算] 行：5 条相关行 → check 4 + recycle 1',
    checks.length === 4 && recs.length === 1, `check=${checks.length} recycle=${recs.length}`);
  check('带 % 的 pressure 能解析（51.5%~ 不是解析失败）', checks[0].pct === 51.5 && checks[0].action === 'recycle');
  check('tokens 紧凑数字还原：540.0k → 540000', checks[0].tokens === 540000);
  check('turns 还原：461', checks[0].turns === 461);
  check('why 解析', checks[0].why === 'over-budget' && checks[2].why === 'no-pressure');
  check('拿不到压力时 pct/tokens/turns 为 null（不是 0，也不是 NaN）',
    checks[2].pct === null && checks[2].tokens === null && checks[2].turns === null);
  check('recycle 行解析出 pct 与上限', recs[0].pct === 51.5 && recs[0].limitPct === 15 && recs[0].key === 'group:1');
  check('无日期的行按 baseDate 补日期', new Date(checks[0].at).getDate() === 27 && new Date(checks[0].at).getHours() === 13);
  check('自带日期的行用自带日期', new Date(checks[3].at).getHours() === 13 && new Date(checks[3].at).getMinutes() === 18);
  check('空输入不炸', parseBudgetLog('', { baseDate: BASE }).length === 0);
}

console.log('## 2. token-usage 解析');
{
  const usage = [
    JSON.stringify({ k: 'turn', t: 5000, key: 'group:1', b: { cacheMiss: 10, cacheHit: 90, cacheWrite: 0, output: 5 } }),
    JSON.stringify({ k: 'turn', t: 4000, key: 'group:1', b: { cacheMiss: 0, cacheHit: 0, cacheWrite: 40, output: 5 } }),
    JSON.stringify({ k: 'base', t: 3000, key: 'group:1', b: { cacheMiss: 999 } }),
    JSON.stringify({ k: 'turn', t: 6000, key: 'group:2', b: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0 } }),
    'not json',
    ''
  ].join('\n');
  const rows = parseTurnUsage(usage);
  check('输入 = cacheMiss + cacheHit + cacheWrite', rows.length === 2 && rows[0].input === 40 && rows[1].input === 100);
  check('跳过 base 记录、坏行、零输入行', rows.every((r) => r.input > 0) && rows.length === 2);
  check('按时间升序（后面对比靠这个）', rows[0].t === 4000 && rows[1].t === 5000);
  check('空输入不炸', parseTurnUsage('').length === 0);
}

console.log('## 3. 统计：摘要 / 趋势 / 回收前后');
{
  const events = parseBudgetLog(log, { baseDate: BASE });
  const s = summarizeBudget(events);
  check('摘要：check 4 / recycle 1', s.checks === 4 && s.recycles === 1);
  check('动作分布统计到 keep 与 recycle', s.byAction.keep === 3 && s.byAction.recycle === 1);
  const g1 = s.byKey.find((k) => k.key === 'group:1');
  check('按 key 归并，并记下回收次数', g1.checks === 2 && g1.recycles === 1, JSON.stringify(g1));

  const now = new Date(2026, 9, 27, 14, 0, 0).getTime();
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push({ t: now - (60 - i) * 60_000, key: 'group:1', input: i < 30 ? 200_000 : 50_000, output: 1 });
  const trend = hourlyTrend(rows, { hours: 3, now, windowMs: 1_000_000 });
  check('趋势按小时分桶且给出中位数与占比', trend.length >= 1 && trend.every((t) => Number.isFinite(t.median) && Number.isFinite(t.pct)));
  check('窗口外的步被排除（只要最近 3 小时）', trend.every((t) => t.hour >= Math.floor((now - 3 * 3600_000) / 3600_000) * 3600_000));

  // 回收前后：group:1 在 13:14:10 回收，之前 30 步 200k、之后 30 步 50k
  const recycleAt = new Date(2026, 9, 27, 13, 14, 10).getTime();
  const rows2 = [];
  for (let i = 0; i < 30; i++) rows2.push({ t: recycleAt - (30 - i) * 60_000, key: 'group:1', input: 200_000 });
  for (let i = 0; i < 30; i++) rows2.push({ t: recycleAt + (i + 1) * 60_000, key: 'group:1', input: 50_000 });
  const eff = recycleEffect(rows2, events, { window: 40 });
  const one = eff.find((e) => e.key === 'group:1');
  check('回收前后中位数与降幅算对（200k → 50k，降 75%）',
    one && one.beforeMedian === 200_000 && one.afterMedian === 50_000 && one.dropPct === 75, JSON.stringify(one));
  check('回收后没有新步时明确标「效果未知」而不是算成 100%',
    (() => { const e = recycleEffect(rows2.filter((r) => r.t < recycleAt), events, { window: 40 }).find((x) => x.key === 'group:1'); return e && e.afterN === 0; })());
  check('回收事件没有时间戳时不参与对比（不能瞎切）',
    recycleEffect(rows2, [{ kind: 'recycle', at: null, key: 'group:1', pct: 9, limitPct: 5 }]).length === 0);
}

console.log('## 4. 截断估算（--simulate 的口径）');
{
  const rows = [
    { t: 1, key: 'a', input: 100 }, { t: 2, key: 'a', input: 300 }, { t: 3, key: 'a', input: 400 },
    { t: 4, key: 'b', input: 50 }
  ];
  const [s50] = simulate(rows, [50], { windowMs: 400 }); // 上限 200
  check('截断后平均 = mean(min(input,cap))：min 后 100+200+200+50 = 550/4 = 137.5 → 138',
    s50.cap === 200 && s50.cappedAvg === 138, JSON.stringify(s50));
  check('越线步占比：4 步里 2 步越线 = 50%', s50.overPct === 50);
  check('越线次数：a 从 100 越到 300 算 1 次（连续越线不重复计），b 不越线', s50.crossings === 1);
  check('相对基线给出降幅', s50.savedPct === Math.round((1 - 137.5 / 212.5) * 1000) / 10);
  const empty = simulate([], [50], { windowMs: 400 })[0];
  check('空数据不出现 NaN', empty.cappedAvg === 0 && empty.savedPct === null && empty.overPct === null);
}

console.log('## 5. 报告：空数据分支与只读纪律');
{
  const r = buildReport({ events: [], rows: [], hours: 24, now: Date.now(), simulatePcts: [30] });
  check('没有 [预算] 行时明确说「开关没开或没重启」，不装作有效果',
    r.text.includes('还没有任何 [预算] 行'), r.text.split('\n')[1]);
  check('空报告不出现 undefined / NaN', !/undefined|NaN/.test(r.text));
  const src = fs.readFileSync(path.join(import.meta.dirname, 'probe-budget-effect.mjs'), 'utf8');
  check('探针只读：没有 writeFile / appendFile / rename / unlink',
    !/writeFileSync|appendFileSync|unlinkSync|renameSync|createWriteStream/.test(src));
  check('探针只碰 state 下两个只读文件（bridge.log / token-usage.jsonl）', /state\/bridge\.log/.test(src) && /state\/token-usage\.jsonl/.test(src));
  check('有 --selftest 与 --json 两个机读入口', /--selftest/.test(src) && /--json/.test(src));
}

console.log('');
const total = pass + failures.length;
if (failures.length) {
  console.log(`❌ test-budget-effect 失败 ${failures.length}/${total}`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log(`✅ test-budget-effect 全部通过（${pass}/${total}）`);
assert.ok(os.tmpdir() && median([1]) === 1);
