#!/usr/bin/env node
// 高峰期判定的**只读静态探针**：给定任意 HH:mm，打印这算不算高峰、以及凭什么这么判。
//
// 为什么要有它：高峰判定有两套互不相干的实现，出问题时分不清是「时段算错了」还是「模型没切」。
//   1) 业务侧（决定要不要切 MiMo）：src/bridge.js 的 inPeakWindow() / peakPauseActive()
//      —— 闭包内部函数，没有 export，只能用本文件逐条镜像；
//   2) 计费侧（决定按高峰价还是空闲价记账）：src/model-prices.js 的 isPeakAt()
//      —— 有 export，本文件直接 import 做交叉对照。
// 两边口径不同（见 docs/peak-mimo-verification.md 的「口径差异」一节），所以本探针**同时**
// 打印两个结果；不一致时以业务侧为准判断「模型会不会切」。
//
// 不读也不写 config.json / state / logs：默认参数内置，想拿真实节假日表就显式 --config 指过去（只读）。
//
// 用法：
//   node scripts/probe-peak-static.mjs 09:00
//   node scripts/probe-peak-static.mjs 09:05 --date 2026-10-27 --config E:/deepseek-harness/qq-bridge-src/config.json
//   node scripts/probe-peak-static.mjs --all              # 八个边界点一览表
//   node scripts/probe-peak-static.mjs --selftest         # 自检（含边界/周末/节假日/调休/跨夜）
// 选项：
//   --date YYYY-MM-DD     指定日期（默认今天）
//   --config <path>       只读加载 socialV2.peakPause 的 windows/days/holidays/makeupDays/enabled/schedule
//   --windows "09:00-12:00,14:00-18:00"   覆盖时段表
//   --days 1,2,3,4,5                     覆盖工作日（0=周日，1=周一 … 6=周六）
//   --holidays / --makeup  逗号分隔日期，覆盖节假日/调休补班表
//   --enabled true|false / --schedule true|false   覆盖总开关/自动时段
//   --json                机器可读输出
// 退出码：0 正常；1 自检失败或参数错误。
import fs from 'node:fs';
import { isPeakAt, resolvePriceTable } from '../src/model-prices.js';

const DEFAULT_WINDOWS = [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }];
const DEFAULT_DAYS = [1, 2, 3, 4, 5];
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
// 自检/一览表固定用这一天：2026-10-27 是周二，且不在 2026 节假日表里（真工作日）。
const SAMPLE_DATE = '2026-10-27';
const BOUNDARY_POINTS = ['08:59', '09:00', '11:59', '12:00', '13:59', '14:00', '17:59', '18:00'];

// ── 参数解析 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const flagBool = (f) => { const v = val(f); return v === undefined ? undefined : v !== 'false'; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

function parseClock(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return -1;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return -1;
  return h * 60 + mi;
}
function fmtClock(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
function parseWindows(spec) {
  if (!spec) return null;
  const out = [];
  for (const part of String(spec).split(',')) {
    const [a, b] = part.split('-').map((x) => String(x || '').trim());
    if (parseClock(a) < 0 || parseClock(b) < 0) throw new Error(`时段写法不对：${part}（要 HH:mm-HH:mm）`);
    out.push({ start: a, end: b });
  }
  return out.length ? out : null;
}
function parseDayList(spec) {
  if (!spec) return null;
  return String(spec).split(',').map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
}
function parseDateList(spec) {
  if (spec === undefined) return null;
  return String(spec).split(',').map((x) => x.trim()).filter(Boolean);
}
function parseDateArg(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`日期写法不对：${s}（要 YYYY-MM-DD）`);
  const y = Number(m[1]); const mo = Number(m[2]) - 1; const d = Number(m[3]);
  const at = new Date(y, mo, d, 12, 0, 0); // 中午取日号，避开夏令时/跨日歧义
  if (at.getFullYear() !== y || at.getMonth() !== mo || at.getDate() !== d) throw new Error(`日期不存在：${s}`);
  return { dateStr: `${m[1]}-${m[2]}-${m[3]}`, weekday: at.getDay(), at };
}

// ── 配置：内置默认 ← --config（只读）← 命令行覆盖 ───────────────────────────
const configPath = val('--config');
let cfg = {
  enabled: true,
  schedule: true,
  windows: DEFAULT_WINDOWS,
  days: DEFAULT_DAYS,
  holidays: [],
  makeupDays: [],
  source: '内置默认（未读 config.json）'
};
if (configPath) {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const pp = raw?.socialV2?.peakPause || {};
  cfg = {
    enabled: pp.enabled === true,
    schedule: pp.schedule === true,
    windows: Array.isArray(pp.windows) && pp.windows.length ? pp.windows.map((w) => ({ start: String(w.start), end: String(w.end) })) : DEFAULT_WINDOWS,
    days: Array.isArray(pp.days) && pp.days.length ? pp.days.map(Number) : DEFAULT_DAYS,
    holidays: Array.isArray(pp.holidays) ? pp.holidays.map(String) : [],
    makeupDays: Array.isArray(pp.makeupDays) ? pp.makeupDays.map(String) : [],
    source: `config: ${configPath}`
  };
}
const winOverride = parseWindows(val('--windows'));
if (winOverride) cfg.windows = winOverride;
const daysOverride = parseDayList(val('--days'));
if (daysOverride && daysOverride.length) cfg.days = daysOverride;
const holOverride = parseDateList(val('--holidays'));
if (holOverride) cfg.holidays = holOverride;
const makeupOverride = parseDateList(val('--makeup'));
if (makeupOverride) cfg.makeupDays = makeupOverride;
const enOverride = flagBool('--enabled');
if (enOverride !== undefined) cfg.enabled = enOverride;
const schOverride = flagBool('--schedule');
if (schOverride !== undefined) cfg.schedule = schOverride;

// ── 判定（逐条镜像 src/bridge.js:14973-15016）───────────────────────────────
/**
 * 等价于 bridge 的 peakPauseActive()：enabled 是总开关，schedule 只决定「要不要按时段限流」。
 * @returns {{peak:boolean, code:string, reason:string, window:?{start:string,end:string}}}
 */
export function evaluateAt({ dateStr, clock, cfg: c }) {
  const cur = parseClock(clock);
  if (cur < 0) throw new Error(`时刻写法不对：${clock}（要 HH:mm）`);
  const { weekday } = parseDateArg(dateStr);
  const isHoliday = c.holidays.includes(dateStr);
  const isMakeup = c.makeupDays.includes(dateStr);
  const dayLabel = `${dateStr}（${WEEKDAY_CN[weekday]}${isMakeup ? '，调休补班' : ''}${isHoliday ? '，法定节假日' : ''}）`;

  // 1) 总开关
  if (!c.enabled) {
    return { peak: false, code: 'disabled', window: null, reason: 'socialV2.peakPause.enabled=false：总开关关着，任何时段都不算高峰（群聊正常用 idle 模型）' };
  }
  // 2) 自动时段关掉 = 全天按高峰（enabled=true 且 schedule=false）
  if (!c.schedule) {
    return { peak: true, code: 'all-day', window: null, reason: 'enabled=true 且 schedule=false：不受时段限制，全天按高峰处理（控制台「只在时段内」关掉就是这个状态）' };
  }
  // 3) 工作日判定：调休补班优先，节假日排除
  const isWorkday = isMakeup || (!isHoliday && c.days.includes(weekday));
  if (!isWorkday) {
    const why = isHoliday ? '法定节假日' : `非工作日（${WEEKDAY_CN[weekday]} 不在 days=[${c.days.join(',')}]）`;
    return { peak: false, code: 'non-workday', window: null, reason: `${dayLabel} → ${why}，高峰只看工作日` };
  }
  // 4) 时段命中：半开区间 [start, end)，start 算、end 不算；start > end 视为跨夜
  let endHit = null;
  for (const w of c.windows) {
    const a = parseClock(w.start); const b = parseClock(w.end);
    if (a < 0 || b < 0) continue;
    const overnight = a > b;
    const inside = overnight ? (cur >= a || cur < b) : (cur >= a && cur < b);
    if (inside) {
      return {
        peak: true, code: 'in-window', window: w,
        reason: `${dayLabel}，${clock} 落在窗口 ${w.start}–${w.end}${overnight ? '（跨夜：≥起点或 <终点）' : '（含起点、不含终点）'}`
      };
    }
    if (cur === b && !overnight) endHit = w;
  }
  if (endHit) {
    return { peak: false, code: 'window-end', window: null, reason: `${dayLabel}，${clock} 正好是窗口 ${endHit.start}–${endHit.end} 的终点——终点排他，所以不算高峰（下一段空闲从这一分钟开始）` };
  }
  return {
    peak: false, code: 'outside', window: null,
    reason: `${dayLabel}，${clock} 不在任何窗口内（窗口：${c.windows.map((w) => `${w.start}-${w.end}`).join('、')}）`
  };
}

/** 计费侧口径（src/model-prices.js isPeakAt）：北京时间、整点粒度、只看小时。 */
function pricedAt({ dateStr, clock }) {
  const cur = parseClock(clock);
  const { at } = parseDateArg(dateStr);
  const ms = new Date(at.getFullYear(), at.getMonth(), at.getDate(), Math.floor(cur / 60), cur % 60, 0).getTime();
  const table = resolvePriceTable(null);
  return { peak: isPeakAt(ms, table), beijing: true };
}

// ── 输出 ────────────────────────────────────────────────────────────────────
function describe(point) {
  const r = evaluateAt({ dateStr: point.dateStr, clock: point.clock, cfg });
  const p = pricedAt({ dateStr: point.dateStr, clock: point.clock });
  return { ...r, pricedPeak: p.peak };
}
function printPoint(point) {
  const r = describe(point);
  const verdict = r.peak ? 'PEAK（高峰）' : 'IDLE（空闲）';
  console.log(`时间：${point.dateStr} ${point.clock}`);
  console.log(`判定：${verdict}`);
  console.log(`原因：${r.reason}`);
  console.log(`时段：${cfg.windows.map((w) => `${w.start}-${w.end}`).join('、')}  工作日：${cfg.days.join(',')}  enabled=${cfg.enabled} schedule=${cfg.schedule}`);
  console.log(`口径来源：${cfg.source}`);
  console.log(`计费侧 isPeakAt 对照：${r.pricedPeak ? 'PEAK' : 'IDLE'}${r.pricedPeak === r.peak ? '（与业务侧一致）' : '（与业务侧不一致，见文档「口径差异」）'}`);
}

// ── 自检 ────────────────────────────────────────────────────────────────────
function selftest() {
  const cases = [];
  const add = (name, point, cfgPatch, want) => cases.push({ name, point, cfgPatch, want });
  // 八个边界点（周二工作日）
  const want8 = { '08:59': false, '09:00': true, '11:59': true, '12:00': false, '13:59': false, '14:00': true, '17:59': true, '18:00': false };
  for (const clock of BOUNDARY_POINTS) add(`边界 ${clock}`, { dateStr: SAMPLE_DATE, clock }, {}, want8[clock]);
  // 周末 / 节假日 / 调休补班
  add('周六 10:00 非工作日', { dateStr: '2026-10-31', clock: '10:00' }, {}, false);
  add('节假日 10:00', { dateStr: SAMPLE_DATE, clock: '10:00' }, { holidays: [SAMPLE_DATE] }, false);
  add('调休补班（周六）10:00', { dateStr: '2026-10-31', clock: '10:00' }, { makeupDays: ['2026-10-31'] }, true);
  // 开关语义
  add('enabled=false 时 09:30 不算高峰', { dateStr: SAMPLE_DATE, clock: '09:30' }, { enabled: false }, false);
  add('schedule=false 时 03:00 也算高峰', { dateStr: SAMPLE_DATE, clock: '03:00' }, { schedule: false }, true);
  add('schedule=false 时周日凌晨也算高峰', { dateStr: '2026-10-31', clock: '03:00' }, { schedule: false }, true);
  // 跨夜窗口
  const night = [{ start: '22:00', end: '02:00' }];
  add('跨夜 23:30', { dateStr: SAMPLE_DATE, clock: '23:30' }, { windows: night }, true);
  add('跨夜 01:30', { dateStr: SAMPLE_DATE, clock: '01:30' }, { windows: night }, true);
  add('跨夜 02:00 终点排他', { dateStr: SAMPLE_DATE, clock: '02:00' }, { windows: night }, false);
  add('跨夜 21:59', { dateStr: SAMPLE_DATE, clock: '21:59' }, { windows: night }, false);

  const base = { ...cfg };
  let ok = 0;
  for (const c of cases) {
    cfg = { ...base, ...c.cfgPatch };
    const r = evaluateAt({ dateStr: c.point.dateStr, clock: c.point.clock, cfg });
    const pass = r.peak === c.want;
    if (pass) ok += 1;
    console.log(`${pass ? '✅' : '❌'} ${c.name} → ${r.peak ? 'PEAK' : 'IDLE'}（期望 ${c.want ? 'PEAK' : 'IDLE'}）${pass ? '' : ` | ${r.reason}`}`);
  }
  cfg = base;
  console.log(`\n自检：${ok}/${cases.length}`);
  return ok === cases.length;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const jsonOut = has('--json');
if (has('--selftest')) {
  process.exitCode = selftest() ? 0 : 1;
} else if (has('--all')) {
  const dateStr = val('--date') || SAMPLE_DATE;
  const points = BOUNDARY_POINTS.map((clock) => ({ dateStr, clock }));
  if (jsonOut) {
    console.log(JSON.stringify(points.map((p) => ({ ...p, ...describe(p) })), null, 1));
  } else {
    console.log(`边界点一览（${dateStr}）——窗口 ${cfg.windows.map((w) => `${w.start}-${w.end}`).join('、')}\n`);
    for (const p of points) {
      const r = describe(p);
      console.log(`${p.clock.padEnd(5)}  ${(r.peak ? 'PEAK' : 'IDLE').padEnd(4)}  计费侧=${(r.pricedPeak ? 'PEAK' : 'IDLE').padEnd(4)}  ${r.reason}`);
    }
  }
} else if (positional.length) {
  const clock = String(positional[0]).trim();
  const dateStr = val('--date') || new Date().toLocaleDateString('sv-SE'); // sv-SE = YYYY-MM-DD
  const point = { dateStr, clock };
  if (jsonOut) {
    console.log(JSON.stringify({ ...point, ...describe(point) }, null, 1));
  } else {
    printPoint(point);
  }
} else {
  console.error('用法：node scripts/probe-peak-static.mjs <HH:mm> [--date YYYY-MM-DD] [--config <path>] [--all] [--selftest] [--json]');
  process.exitCode = 1;
}
