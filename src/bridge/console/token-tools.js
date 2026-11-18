// 工具维度的 token 消费（账本落盘 + 控制台路由）。
//
// 为什么要单独一个模块、还要在「每轮结束」记一笔：
// 账本（src/token-ledger）只回答「这一轮花了多少」，回答不了「钱花在哪个工具上」。
// 用户问的是后者，而工具归因只能在一轮结束、工具调用日志完整时才算得准；事后重算只能
// 依赖工具日志还留着（会被截断），所以设计成「先落盘、后查询」：
// - turn/end 时 recordTurn 读该轮账本行 + 该轮工具调用，按调用次数均摊后写进
//   state/token-tools.json 的「天」桶（含 byKey，按群筛选就是读它）；
// - GET /api/tokens/tools 只读这份天桶，不碰账本、不扫日志 —— 控制台轮询不会越查越慢；
// - seen（sessionId:turn）防重复计入：DSH 重连、turn/end 重放都不会把同一轮记两遍。
//
// 为什么不在这里 import 纯函数：这个模块会被 vm 裸执行（见 manifest / audit harness），
// 均摊规则在 src/token-tools.js（rules-backend 维护），装配层用 deps.tokenToolsPure 注入。
//
// 失败一律只记日志：聊天链路的收尾绝不能因为统计写盘失败而断掉，统计少一笔不算事故。

const TT_FILE = 'token-tools.json';
const TT_VERSION = 1;
const TT_SEEN_KEEP_DAYS = 60;
const TT_RANGES = ['today', '7d', '30d', 'all'];
const TT_NOTE = '按轮均摊；此功能上线前的历史不回填';
const DAY_MS = 24 * 3600 * 1000;

function ttNowMs(deps) {
  try {
    const value = typeof deps.now === 'function' ? deps.now() : deps.now;
    const ms = Number(value);
    return Number.isFinite(ms) && ms > 0 ? ms : Date.now();
  } catch {
    return Date.now();
  }
}

function ttPath(deps) {
  return deps.path.join(String(deps.STATE_DIR), TT_FILE);
}

function ttDayKey(ms) {
  const d = new Date(Number(ms) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 本地零点：range=today/7d/30d 的 from 用它算，避免 UTC 把「今天」切成两半。
function ttDayStart(ms) {
  const d = new Date(Number(ms) || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function ttDayKeyToStart(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

function ttLoad(deps) {
  try {
    const raw = deps.fs.readFileSync(ttPath(deps), 'utf8');
    const parsed = JSON.parse(raw);
    const src = parsed && typeof parsed === 'object' ? parsed : {};
    const days = src.days && typeof src.days === 'object' && !Array.isArray(src.days) ? src.days : {};
    const seen = src.seen && typeof src.seen === 'object' && !Array.isArray(src.seen) ? src.seen : {};
    const normalized = typeof deps.tokenToolsPure?.normalizeToolToolsStore === 'function'
      ? deps.tokenToolsPure.normalizeToolToolsStore({ version: TT_VERSION, days }, { now: ttNowMs(deps) })
      : { version: TT_VERSION, days };
    return { version: TT_VERSION, days: normalized.days || {}, seen };
  } catch {
    return { version: TT_VERSION, days: {}, seen: {} };
  }
}

function ttSave(deps, store) {
  const days = store && store.days && typeof store.days === 'object' ? store.days : {};
  const seen = store && store.seen && typeof store.seen === 'object' ? store.seen : {};
  const keptSeen = {};
  const cutoffKey = ttDayKey(ttNowMs(deps) - TT_SEEN_KEEP_DAYS * DAY_MS);
  for (const [key, dayKey] of Object.entries(seen)) {
    if (String(dayKey) >= cutoffKey) keptSeen[key] = dayKey;
  }
  deps.atomicWriteJson(ttPath(deps), { version: TT_VERSION, days, seen: keptSeen });
  return { days, seen: keptSeen };
}

// 该轮的工具调用：日志里一条 call 算一次。failed 不靠 result 映射（result 里没有 callId/turn），
// 只认 call 记录自己带的标记，宁可少算失败也不误判。
function ttCallsOf(deps, sessionId, turn, options = {}) {
  const turnNo = Number(turn);
  const rows = options.rows;
  const calls = [];
  for (const row of rows) {
    if (row?.type !== 'call') continue;
    if (row.sessionId !== sessionId) continue;
    if (Number(row.turn) !== turnNo) continue;
    calls.push({ tool: String(row.tool || ''), failed: row.ok === false || Boolean(row.error) });
  }
  return calls;
}

// 读工具日志：实时记录只看最近 1000 条（够覆盖当前轮）；rebuild 要整天数据，直接读文件。
function ttReadLogRows(deps, { full = false } = {}) {
  if (!full && typeof deps.readToolLog === 'function') {
    const rows = deps.readToolLog(1000);
    return Array.isArray(rows) ? rows : [];
  }
  try {
    const raw = deps.fs.readFileSync(String(deps.TOOL_LOG_FILE), 'utf8');
    const rows = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { rows.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
    return rows;
  } catch {
    return typeof deps.readToolLog === 'function' ? deps.readToolLog(1000) : [];
  }
}

function ttRangeWindow(deps, range, now) {
  if (range === 'all') return { from: 0, to: 0 };
  if (range === 'today') return { from: ttDayStart(now), to: 0 };
  if (range === '7d') return { from: ttDayStart(now) - 6 * DAY_MS, to: 0 };
  return { from: ttDayStart(now) - 29 * DAY_MS, to: 0 };
}

function ttDaysInWindow(store, from, to) {
  const days = store && store.days ? store.days : {};
  const list = [];
  for (const [dayKey, day] of Object.entries(days)) {
    const start = ttDayKeyToStart(dayKey);
    if (start == null) continue;
    if (from && start < from) continue;
    if (to && start >= to) continue;
    list.push(day);
  }
  return list;
}

function ttPublicReport(deps, { range = 'today', key = 'all', now = 0 } = {}) {
  const nowMs = now || ttNowMs(deps);
  const store = ttLoad(deps);
  const win = ttRangeWindow(deps, range, nowMs);
  const days = ttDaysInWindow(store, win.from, win.to);
  const agg = (deps.tokenToolsPure?.aggregateToolDays ?? (() => ({})))(days, { fromMs: win.from, toMs: win.to, key });
  return {
    ok: true,
    range: { from: win.from, to: win.to, days: Number(agg?.range?.days) || 0 },
    key,
    total: agg?.total ?? { turns: 0, calls: 0, failed: 0, tokens: { prompt: 0, completion: 0, cached: 0, total: 0 }, cost: 0 },
    noTool: agg?.noTool ?? null,
    unattr: agg?.unattr ?? null,
    tools: agg?.tools ?? [],
    groups: agg?.groups ?? [],
    mismatch: agg?.mismatch ?? null,
    note: TT_NOTE
  };
}

// rebuild：用账本 + 工具日志把最近 N 天重算一遍（清掉该天桶后重建，seen 一并重建）。
// 今天上线后立刻能用它把「上线前已经在跑、但没记过」的今天补出来。
function ttRebuild(deps, days = 1) {
  const count = Math.max(1, Math.min(60, Math.floor(Number(days) || 1)));
  const nowMs = ttNowMs(deps);
  const from = ttDayStart(nowMs) - (count - 1) * DAY_MS;
  const turns = typeof deps.tokenLedgerTurnsSince === 'function' ? deps.tokenLedgerTurnsSince(from, { toMs: 0 }) : [];
  const rows = ttReadLogRows(deps, { full: true });
  const store = ttLoad(deps);
  const targetKeys = new Set();
  for (let i = 0; i < count; i += 1) targetKeys.add(ttDayKey(ttDayStart(nowMs) - i * DAY_MS));
  for (const dayKey of targetKeys) {
    delete store.days[dayKey];
    for (const seenKey of Object.keys(store.seen)) {
      if (store.seen[seenKey] === dayKey) delete store.seen[seenKey];
    }
  }
  const rebuilt = {};
  let turnsDone = 0;
  for (const row of Array.isArray(turns) ? turns : []) {
    const dayKey = ttDayKey(row.endedAt || nowMs);
    if (!targetKeys.has(dayKey)) continue;
    const calls = ttCallsOf(deps, row.sessionId, row.turn, { rows });
    const allocation = deps.tokenToolsPure.allocateTurnTokens(row, calls);
    const turnTokens = deps.tokenToolsPure.tokensFromBuckets(row.buckets);
    store.days[dayKey] = deps.tokenToolsPure.addTurnIntoDay(store.days[dayKey], {
      key: row.key,
      allocation,
      turnCost: row.cost,
      turnTokens
    });
    store.seen[`${row.sessionId}:${row.turn}`] = dayKey;
    rebuilt[dayKey] = (rebuilt[dayKey] || 0) + 1;
    turnsDone += 1;
  }
  ttSave(deps, store);
  const list = [...targetKeys].sort().map((day) => ({
    day,
    turns: rebuilt[day] || 0,
    tools: Object.keys(store.days[day]?.rows ?? {}).length
  }));
  return { ok: true, turns: turnsDone, days: list };
}

function ttParseRange(raw) {
  const range = String(raw ?? '').trim() || 'today';
  return TT_RANGES.includes(range) ? range : null;
}

// @bridge-function recordTurn:start
function recordTurn(deps, input = {}) {
  try {
    const sessionId = String(input.sessionId || '');
    const turn = Number(input.turn);
    if (!sessionId || !Number.isFinite(turn)) return { ok: false, skipped: true, error: '缺少 sessionId 或 turn' };
    const seenKey = `${sessionId}:${turn}`;
    const store = ttLoad(deps);
    if (store.seen[seenKey]) return { ok: true, skipped: true, reason: 'already-recorded' };
    const row = typeof deps.tokenLedgerTurnOf === 'function' ? deps.tokenLedgerTurnOf(sessionId, turn) : null;
    if (!row) return { ok: false, skipped: true, error: '账本里找不到这一轮' };
    const calls = ttCallsOf(deps, sessionId, turn, { rows: ttReadLogRows(deps) });
    const allocation = deps.tokenToolsPure.allocateTurnTokens(row, calls);
    const turnTokens = deps.tokenToolsPure.tokensFromBuckets(row.buckets);
    const dayKey = ttDayKey(row.endedAt || ttNowMs(deps));
    store.days[dayKey] = deps.tokenToolsPure.addTurnIntoDay(store.days[dayKey], {
      key: row.key,
      allocation,
      turnCost: row.cost,
      turnTokens
    });
    store.seen[seenKey] = dayKey;
    ttSave(deps, store);
    return { ok: true, skipped: false, day: dayKey, calls: calls.length };
  } catch (error) {
    try { deps.log(`[工具归因] 记录失败（不影响聊天）：${error?.message ?? error}`); } catch { /* 日志失败也不抛 */ }
    return { ok: false, skipped: true, error: error?.message ?? String(error) };
  }
}
// @bridge-function recordTurn:end

// @bridge-function readStore:start
function readStore(deps) {
  return ttLoad(deps);
}
// @bridge-function readStore:end

// @bridge-function buildReport:start
function buildReport(deps, options = {}) {
  return ttPublicReport(deps, options);
}
// @bridge-function buildReport:end

// @bridge-function handleTokensTools:start
async function handleTokensTools(deps, request) {
  const { req, url, sendJson, readBody } = request;
  const path = url.pathname;
  const isQuery = path === '/api/tokens/tools';
  const isRebuild = path === '/api/tokens/tools/rebuild';
  if (!isQuery && !isRebuild) return false;
  if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
    sendJson({ ok: false, error: '未授权：工具用量统计是控制台接口' }, 403);
    return true;
  }
  if (isQuery) {
    if (req.method !== 'GET') { sendJson({ ok: false, error: '该接口只支持 GET' }, 405); return true; }
    const range = ttParseRange(url.searchParams.get('range'));
    if (!range) {
      sendJson({ ok: false, error: `range 不合法（只支持 ${TT_RANGES.join(' / ')}）` }, 400);
      return true;
    }
    const key = String(url.searchParams.get('key') ?? '').trim() || 'all';
    try {
      sendJson(ttPublicReport(deps, { range, key }));
    } catch (error) {
      deps.log(`[工具归因] 查询失败：${error?.message ?? error}`);
      sendJson({ ok: false, error: '读取工具用量失败，稍后再试' }, 500);
    }
    return true;
  }
  if (req.method !== 'POST') { sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }
  let body = {};
  try { body = (await readBody()) || {}; } catch { sendJson({ ok: false, error: '请求体不是合法 JSON' }, 400); return true; }
  const days = body?.days === undefined ? 1 : Number(body.days);
  if (!Number.isFinite(days) || days < 1 || days > 60) {
    sendJson({ ok: false, error: 'days 必须是 1~60 的整数' }, 400);
    return true;
  }
  try {
    sendJson(ttRebuild(deps, Math.floor(days)));
  } catch (error) {
    deps.log(`[工具归因] 重算失败：${error?.message ?? error}`);
    sendJson({ ok: false, error: '重算失败，稍后再试' }, 500);
  }
  return true;
}
// @bridge-function handleTokensTools:end

/**
 * 工具归因工厂（VM-safe：构造期只绑定 deps，真正读写都推迟到调用时）。
 */
export function createTokenTools(deps) {
  return {
    recordTurn: (input) => recordTurn(deps, input),
    readStore: () => readStore(deps),
    buildReport: (options) => buildReport(deps, options),
    handleTokensTools: (request) => handleTokensTools(deps, request)
  };
}
