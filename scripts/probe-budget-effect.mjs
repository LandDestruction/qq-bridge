#!/usr/bin/env node
// D45 效果量化探针（只读）：开预算以后，每步输入到底降了多少、曲线有没有压平、55 vs 30 差多少。
//
// 为什么需要：D45 每轮打一行
//   [预算] key=group:100000001 pressure=41.1%~ tokens=431.4k turns=57 动作=keep why=under-budget
// 但没有东西把它和 token-usage.jsonl 里的真实步记录对上——于是「开了预算省了多少」只能靠感觉，
// 「55 还是 30」也只能靠猜。这个探针把两边的数据接起来，给出发票级的三张表。
//
// 用法：
//   node scripts/probe-budget-effect.mjs                 # 人读报告（默认读线上 state/）
//   node scripts/probe-budget-effect.mjs --json          # 机读
//   node scripts/probe-budget-effect.mjs --selftest      # 只跑内置自测（不读线上文件）
//   node scripts/probe-budget-effect.mjs --simulate 15,25,30,55
//   node scripts/probe-budget-effect.mjs --repo <桥接根目录> --log <path> --usage <path> --hours 24
//
// 铁律：**只读**。不写 state/、不改 config、不重启。跑前跑后 state 文件的 sha256 应完全一致。
//
// 口径与已知不确定：
//   ① 「回收前后对比」用日志里 recycle 行的时刻切分 token-usage 的步，各取窗口内的中位数；
//      bridge.log 的行首只有时分秒（没有日期），按文件 mtime 那天补日期——跨天日志会很准，
//      跨天之前的老行会被算错，所以窗口默认只取最近 24h。
//   ② --simulate 是「假如下限设在 X%」的静态估算：截断平均 + 越线步占比 + 越线次数
//      （越线次数≈如果每次都按上限换会话，历史上会触发多少次）。它假设回收后立刻从头长，
//      不建模增长曲线，所以是量级参考，不是预测。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_REPO = 'E:/qq-project/deepseek-harness/qq-bridge-src';
const CONTEXT_WINDOW_DEFAULT = 1_048_576;

// ── 解析 ────────────────────────────────────────────────────────────────────

const LOG_CLOCK = /^(?:(\d{4})\/(\d{2})\/(\d{2})\s+)?(\d{2}):(\d{2}):(\d{2})\s/;
const CHECK_LINE = /\[预算\]\s+key=(\S+)\s+pressure=([\d.]+|\?|)%?\s*~+\s+tokens=(\S+)\s+turns=(\S+)\s+动作=(\w+)(?:\s+why=(\S+))?/;
const RECYCLE_LINE = /\[预算\]\s+(\S+)\s+按预算回收（([\d.]+)%\s*≥\s*([\d.]+)%）/;

/** 把 431.4k / 1.2M / 900 这类日志里的紧凑数字还原成整数。 */
export function parseCompactNumber(text) {
  if (text === undefined || text === null) return null;
  const s = String(text).trim();
  if (!s || s === '?') return null;
  const m = /^([\d.]+)\s*([kKmM]?)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  return Math.round(n * (unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : 1));
}

function clockToMs(match, baseDate) {
  if (!match) return null;
  const [, y, mo, d, hh, mm, ss] = match;
  const year = y ? Number(y) : baseDate.getFullYear();
  const month = mo ? Number(mo) : baseDate.getMonth() + 1;
  const day = d ? Number(d) : baseDate.getDate();
  const ms = new Date(year, month - 1, day, Number(hh), Number(mm), Number(ss)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 解析 bridge.log 里的 [预算] 行。
 * 返回两类事件：kind='check'（一次压力检查）与 kind='recycle'（真的换了会话）。
 */
export function parseBudgetLog(text, { baseDate = new Date() } = {}) {
  const events = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.includes('[预算]')) continue;
    const clock = LOG_CLOCK.exec(line);
    const at = clock ? clockToMs(clock, baseDate) : null;
    const recycle = RECYCLE_LINE.exec(line);
    if (recycle) {
      events.push({ kind: 'recycle', at, key: recycle[1], pct: Number(recycle[2]), limitPct: Number(recycle[3]) });
      continue;
    }
    const check = CHECK_LINE.exec(line);
    if (!check) continue;
    events.push({
      kind: 'check',
      at,
      key: check[1],
      pct: check[2] === '?' || check[2] === '' ? null : Number(check[2]),
      tokens: parseCompactNumber(check[3]),
      turns: parseCompactNumber(check[4]),
      action: check[5],
      why: check[6] || null
    });
  }
  return events;
}

/** 解析 token-usage.jsonl 的 k='turn' 记录：输入 = cacheMiss + cacheHit + cacheWrite。 */
export function parseTurnUsage(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.k !== 'turn') continue;
    const b = e.b || {};
    const input = (Number(b.cacheMiss) || 0) + (Number(b.cacheHit) || 0) + (Number(b.cacheWrite) || 0);
    const t = Number(e.t);
    if (!input || !Number.isFinite(t)) continue;
    rows.push({ t, key: String(e.key ?? '?'), input, output: Number(b.output) || 0, model: String(e.model ?? '?') });
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

// ── 统计 ────────────────────────────────────────────────────────────────────

export const median = (arr) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};

export function summarizeBudget(events) {
  const checks = events.filter((e) => e.kind === 'check');
  const recycles = events.filter((e) => e.kind === 'recycle');
  const byAction = { keep: 0, recycle: 0, skip: 0 };
  for (const c of checks) if (byAction[c.action] !== undefined) byAction[c.action] += 1;
  const byKey = new Map();
  for (const c of checks) {
    const cur = byKey.get(c.key) || { key: c.key, checks: 0, lastPct: null, lastAction: null, lastAt: null, recycles: 0 };
    cur.checks += 1;
    cur.lastPct = c.pct;
    cur.lastAction = c.action;
    cur.lastAt = c.at;
    byKey.set(c.key, cur);
  }
  for (const r of recycles) {
    const cur = byKey.get(r.key) || { key: r.key, checks: 0, lastPct: r.pct, lastAction: 'recycle', lastAt: r.at, recycles: 0 };
    cur.recycles += 1;
    cur.lastAt = r.at ?? cur.lastAt;
    byKey.set(r.key, cur);
  }
  return { checks: checks.length, recycles: recycles.length, byAction, byKey: [...byKey.values()] };
}

/** 按小时的中位数趋势（便于看「曲线压平了没有」）。 */
export function hourlyTrend(rows, { hours = 24, now = Date.now(), windowMs = CONTEXT_WINDOW_DEFAULT } = {}) {
  const from = now - hours * 3600_000;
  const buckets = new Map();
  for (const r of rows) {
    if (r.t < from) continue;
    const h = Math.floor(r.t / 3600_000) * 3600_000;
    const b = buckets.get(h) || [];
    b.push(r.input);
    buckets.set(h, b);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([hour, list]) => ({
    hour, n: list.length, median: median(list), pct: windowMs ? Math.round((median(list) / windowMs) * 1000) / 10 : null
  }));
}

/**
 * 每个被回收的 key：回收时刻之前 vs 之后，每步输入的中位数（模型参数用 --hours 等同窗口）。
 * 只用「回收事件之后确实有新步」的 key；没新步的说明回收后还没聊，不能算效果。
 */
export function recycleEffect(rows, events, { window = 40 } = {}) {
  const recycles = events.filter((e) => e.kind === 'recycle' && Number.isFinite(e.at));
  const out = [];
  for (const r of recycles) {
    const mine = rows.filter((x) => x.key === r.key);
    const before = mine.filter((x) => x.t < r.at).slice(-window).map((x) => x.input);
    const after = mine.filter((x) => x.t >= r.at).slice(0, window).map((x) => x.input);
    const bm = median(before);
    const am = median(after);
    out.push({
      key: r.key, at: r.at, pct: r.pct, limitPct: r.limitPct,
      beforeN: before.length, afterN: after.length,
      beforeMedian: bm, afterMedian: am,
      dropPct: bm && am !== null ? Math.round((1 - am / bm) * 1000) / 10 : null
    });
  }
  return out;
}

/**
 * 「假如下限设在 pct」的静态估算：
 *   cappedAvg  每步输入按上限截断后的平均（保守下界）
 *   overPct    历史上有多少比例的步超过该上限
 *   crossings  每个会话「从线下越到线上」的次数 ≈ 如果每次越线都换会话，历史上会换几次
 */
export function simulate(rows, pcts, { windowMs = CONTEXT_WINDOW_DEFAULT } = {}) {
  const out = [];
  const base = rows.length ? rows.reduce((a, r) => a + r.input, 0) / rows.length : 0;
  for (const pct of pcts) {
    const cap = (pct / 100) * windowMs;
    const cappedAvg = rows.length ? rows.reduce((a, r) => a + Math.min(r.input, cap), 0) / rows.length : 0;
    const over = rows.filter((r) => r.input > cap).length;
    let crossings = 0;
    const lastByKey = new Map();
    for (const r of rows) {
      const prev = lastByKey.get(r.key);
      if (r.input > cap && (prev === undefined || prev <= cap)) crossings += 1;
      lastByKey.set(r.key, r.input);
    }
    out.push({
      pct, cap: Math.round(cap),
      baseAvg: Math.round(base), cappedAvg: Math.round(cappedAvg),
      savedPct: base ? Math.round((1 - cappedAvg / base) * 1000) / 10 : null,
      overPct: rows.length ? Math.round((over / rows.length) * 1000) / 10 : null,
      crossings,
      crossingsPer100: rows.length ? Math.round((crossings / rows.length) * 1000) / 10 : null
    });
  }
  return out;
}

// ── 报告 ────────────────────────────────────────────────────────────────────

const fmt = (n) => {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '?';
  const v = Number(n);
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
};
const fmtClock = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '?');

export function buildReport({ events, rows, hours = 24, now = Date.now(), simulatePcts = [] }) {
  const summary = summarizeBudget(events);
  const trend = hourlyTrend(rows, { hours, now });
  const effect = recycleEffect(rows, events);
  const sim = simulatePcts.length ? simulate(rows, simulatePcts) : [];
  const lines = [];
  lines.push(`数据：token 步 ${rows.length} 条；[预算] 行 ${events.length} 条（check ${summary.checks} / recycle ${summary.recycles}）`);
  if (!events.length) {
    lines.push('❗还没有任何 [预算] 行：要么开关没开（socialV2.contextBudget.enabled 不为 true），要么开了但还没重启桥接。');
  } else {
    lines.push(`动作分布：keep ${summary.byAction.keep} / recycle ${summary.byAction.recycle} / skip ${summary.byAction.skip}`);
    lines.push('');
    lines.push('会话'.padEnd(30) + '检查  回收  最后 pressure  最后动作  最后时刻');
    for (const k of summary.byKey.sort((a, b) => b.checks - a.checks)) {
      lines.push(
        String(k.key).padEnd(28) + String(k.checks).padStart(5) + String(k.recycles).padStart(6) +
        `${String(k.lastPct ?? '?').padStart(12)}%` + String(k.lastAction ?? '?').padStart(10) + '  ' + fmtClock(k.lastAt)
      );
    }
  }
  lines.push('');
  lines.push(`每步输入趋势（最近 ${hours} 小时，按小时取中位数；% = 占 1,048,576 窗口）`);
  if (!trend.length) lines.push('  （这段时间没有步记录）');
  for (const t of trend) {
    const bar = '▁▂▃▄▅▆▇█'[Math.min(7, Math.max(0, Math.round((t.pct ?? 0) / 12.5)))];
    lines.push(`  ${fmtClock(t.hour).slice(0, 16).padEnd(18)} ${bar} 中位 ${fmt(t.median).padStart(8)}  ${String(t.pct ?? '?').padStart(5)}%  步数 ${t.n}`);
  }
  lines.push('');
  lines.push('回收效果（同一会话：回收前 40 步 vs 回收后 40 步的每步输入中位数）');
  if (!effect.length) lines.push('  （还没有带时间戳的回收事件）');
  for (const e of effect) {
    if (e.afterN === 0) {
      lines.push(`  ${e.key.padEnd(28)} ${String(e.pct).padStart(5)}% ≥ ${e.limitPct}%  回收后还没有新步，效果未知`);
      continue;
    }
    lines.push(`  ${e.key.padEnd(28)} ${String(e.pct).padStart(5)}% ≥ ${e.limitPct}%  前 ${fmt(e.beforeMedian).padStart(8)}(n=${e.beforeN}) → 后 ${fmt(e.afterMedian).padStart(8)}(n=${e.afterN})  降 ${e.dropPct === null ? '?' : e.dropPct + '%'}`);
  }
  if (sim.length) {
    lines.push('');
    lines.push('假如上限设成（静态估算，非预测）：');
    lines.push('  上限    截断后平均/步   相对基线   越线步占比   越线次数   每百步回收');
    for (const s of sim) {
      lines.push(
        `${String(s.pct).padStart(4)}%  ${fmt(s.cappedAvg).padStart(14)}  ${String(s.savedPct ?? '?').padStart(8)}%  ${String(s.overPct ?? '?').padStart(11)}%  ${String(s.crossings).padStart(9)}  ${String(s.crossingsPer100).padStart(10)}`
      );
    }
    lines.push('  注：截断平均是保守下界（真实回收后从头长，更省）；越线次数假设每次越线就换会话，是量级参考。');
  }
  return { text: lines.join('\n'), summary, trend, effect, sim };
}

// ── 自测 ────────────────────────────────────────────────────────────────────

export function selftest() {
  const log = [
    '13:14:10 [bridge] [预算] key=group:1 pressure=51.5%~ tokens=540.0k turns=461 动作=recycle why=over-budget',
    '13:14:10 [bridge] [预算] group:1 按预算回收（51.5% ≥ 15%），下一轮重建',
    '13:15:02 [bridge] [预算] key=group:1 pressure=2.1%~ tokens=22.0k turns=1 动作=keep why=min-turns',
    '13:16:00 [bridge] [预算] key=group:2 pressure=?~ tokens=? turns=? 动作=keep why=no-pressure',
    '13:17:00 [bridge] 与预算无关的一行'
  ].join('\n');
  const events = parseBudgetLog(log, { baseDate: new Date(2026, 9, 27, 23, 0, 0) });
  const checks = events.filter((e) => e.kind === 'check');
  const recs = events.filter((e) => e.kind === 'recycle');
  const usage = [
    JSON.stringify({ k: 'turn', t: 1000, key: 'group:1', b: { cacheMiss: 10, cacheHit: 90, cacheWrite: 0, output: 5 } }),
    JSON.stringify({ k: 'turn', t: 2000, key: 'group:1', b: { cacheMiss: 0, cacheHit: 0, cacheWrite: 40, output: 5 } }),
    JSON.stringify({ k: 'base', t: 3000, key: 'group:1', b: { cacheMiss: 999 } }),
    'not json'
  ].join('\n');
  const rows = parseTurnUsage(usage);
  const sim = simulate(rows, [50], { windowMs: 180 }); // 上限 = 50% × 180 = 90
  const cases = [
    ['日志只认 [预算] 行（不相关行被忽略）', events.length === 4],
    ['check 行解析出 key/pct/tokens/turns/action/why',
      checks[0].key === 'group:1' && checks[0].pct === 51.5 && checks[0].tokens === 540000 && checks[0].turns === 461 && checks[0].action === 'recycle'],
    ['recycle 行解析出 pct 与上限', recs.length === 1 && recs[0].pct === 51.5 && recs[0].limitPct === 15],
    ['补充了日期（无日期的行按 baseDate）', new Date(checks[0].at).getDate() === 27],
    ['拿不到压力时 pct/tokens 为 null 而不是 0', checks[2].pct === null && checks[2].tokens === null],
    ['token-usage：输入=cacheMiss+cacheHit+cacheWrite，且跳过 base/坏行', rows.length === 2 && rows[0].input === 100 && rows[1].input === 40],
    ['compact 数字解析：540.0k / 1.2M / ?', parseCompactNumber('540.0k') === 540000 && parseCompactNumber('1.2M') === 1200000 && parseCompactNumber('?') === null],
    ['中位数：偶数取中间两个平均', median([1, 2, 3, 4]) === 2.5 && median([5]) === 5 && median([]) === null],
    ['simulate：上限 90 时只有第一步越线（同一会话连续越线不重复计）', sim[0].cap === 90 && sim[0].crossings === 1],
    ['simulate 截断平均 = mean(min(input,cap))', sim[0].cappedAvg === 65],
    ['空日志不炸', parseBudgetLog('').length === 0 && parseTurnUsage('').length === 0]
  ];
  let failed = 0;
  for (const [name, ok] of cases) {
    if (ok) console.log(`  ✅ ${name}`);
    else { failed += 1; console.error(`  ❌ ${name}`); }
  }
  if (failed) { console.error(`\n❌ probe-budget-effect 自测失败 ${failed}/${cases.length}`); process.exit(1); }
  console.log(`\n✅ probe-budget-effect 自测通过（${cases.length}/${cases.length}）`);
}

// ── 入口 ────────────────────────────────────────────────────────────────────

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function main() {
  const repo = arg('--repo', process.env.QQ_BRIDGE_SRC || DEFAULT_REPO);
  const logPath = arg('--log', path.join(repo, 'state/bridge.log'));
  const usagePath = arg('--usage', path.join(repo, 'state/token-usage.jsonl'));
  const hours = Number(arg('--hours', 24)) || 24;
  const simulatePcts = String(arg('--simulate', '') || '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0);

  let logText = '';
  let baseDate = new Date();
  try {
    logText = fs.readFileSync(logPath, 'utf8');
    baseDate = fs.statSync(logPath).mtime;
  } catch (e) { console.error(`⚠️ 读不到预算日志（${logPath}）：${e?.message ?? e}`); }
  let usageText = '';
  try { usageText = fs.readFileSync(usagePath, 'utf8'); } catch (e) { console.error(`⚠️ 读不到 token 用量（${usagePath}）：${e?.message ?? e}`); }

  const events = parseBudgetLog(logText, { baseDate });
  const rows = parseTurnUsage(usageText);
  const report = buildReport({ events, rows, hours, now: Date.now(), simulatePcts });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ summary: report.summary, trend: report.trend, effect: report.effect, sim: report.sim }, null, 2));
  } else {
    console.log(report.text);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--selftest')) selftest();
  else main();
}
