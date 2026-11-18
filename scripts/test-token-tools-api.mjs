// 工具维度 token 消费（后端管线）测试。
//
// 覆盖三类容易错的地方：
// 1. 账本口径：turnsSince/turnOf 只给窗口内的轮，且桶从 4 个计费桶换成 {prompt,completion,cached,total}；
// 2. 落盘/幂等：recordTurn 写 state/token-tools.json、seen 防重、异常不影响聊天（只记日志）；
// 3. 查询口径：range 的 from/to、key 过滤后「没归因的」只能落到 unattr、非法 range 400、agent 403、
//    rebuild 只重算指定天、原子写不留 .tmp。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PRICE_TABLE, normalizeUsage } from '../src/model-prices.js';
import { createTokenLedger } from '../src/token-ledger.js';
import * as tokenToolsPure from '../src/token-tools.js';
import { createTokenTools } from '../src/bridge/console/token-tools.js';

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed += 1; console.log(`✅ ${label}`); }
  else { failed += 1; console.error(`❌ ${label}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-token-tools-'));
const stateDir = path.join(tmpDir, 'state');
fs.mkdirSync(stateDir, { recursive: true });
const toolLogFile = path.join(tmpDir, 'tool-calls.jsonl');
const ledgerFile = path.join(tmpDir, 'token-usage.jsonl');

const dayA = new Date(2026, 9, 30, 10, 0, 0).getTime(); // 本地 2026-10-30 10:00
const dayB = dayA - 24 * 3600 * 1000;                    // 前一天

function freshLedger() {
  try { fs.unlinkSync(ledgerFile); } catch { /* 首次没有文件 */ }
  return createTokenLedger({ file: ledgerFile, priceTable: DEFAULT_PRICE_TABLE });
}

function ingestTurn(led, { sessionId, turn, time, input = 1000, output = 100, cacheRead = 200, model = 'deepseek-flash' }) {
  led.ingestEvent({
    sessionId,
    event: {
      type: 'assistant/message',
      seq: turn,
      time,
      data: { turn, step: 1, model, usage: normalizeUsage({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead }) }
    }
  });
}

// ── 1. 账本访问器：窗口过滤 + 桶口径转换 ────────────────────────────────
{
  const led = freshLedger();
  ingestTurn(led, { sessionId: 's-a', turn: 1, time: dayA });
  ingestTurn(led, { sessionId: 's-a', turn: 2, time: dayA + 5000 });
  ingestTurn(led, { sessionId: 's-b', turn: 1, time: dayB });
  const all = led.turnsSince(0);
  assert(all.length === 3, `turnsSince(0) 应给全部 3 轮（实得 ${all.length}）`);
  const todayOnly = led.turnsSince(dayA - 1000);
  assert(todayOnly.length === 2, `turnsSince 只给窗口内的轮（实得 ${todayOnly.length}）`);
  assert(todayOnly.every((row) => row.endedAt >= dayA - 1000), '窗口外的那一轮被排除');
  const bounded = led.turnsSince(0, { toMs: dayA });
  assert(bounded.length === 1 && bounded[0].sessionId === 's-b', 'toMs 半开区间：只含更早的那一轮');
  const row = all.find((item) => item.sessionId === 's-a' && item.turn === 1);
  assert(row && typeof row.buckets.prompt === 'number', '每项都带 buckets.prompt');
  assert(row.buckets.completion === 100, `completion = output 桶（实得 ${row.buckets.completion}）`);
  assert(row.buckets.prompt === 1000 + 200, `prompt = 输入桶 + cacheHit（实得 ${row.buckets.prompt}）`);
  assert(row.buckets.cached === 200, `cached = cacheHit 单列（实得 ${row.buckets.cached}）`);
  assert(row.buckets.total === row.buckets.prompt + row.buckets.completion, 'total 只加 prompt+completion');
  assert(typeof row.cost === 'number' && row.cost > 0, '每项带 cost');
  assert(row.key === undefined || typeof row.key === 'string', 'key 字段存在或未归属');
  const one = led.turnOf('s-a', 1);
  assert(one && one.turn === 1 && one.buckets.total === row.buckets.total, 'turnOf 与 turnsSince 口径一致');
  assert(led.turnOf('s-a', 99) === null, 'turnOf 找不到时返回 null');
  assert(led.turnOf('', 1) === null, 'turnOf 空 sessionId 返回 null');
}

// ── 2. 工厂：空账本 / recordTurn 落盘与幂等 ──────────────────────────────
const led = freshLedger();
const KEY_BY_SESSION = { 's-a': 'group:101', 's-b': 'group:202' };
const keyOf = (sid) => KEY_BY_SESSION[sid] ?? null;
const ledgerWithKeys = createTokenLedger({
  file: ledgerFile,
  priceTable: DEFAULT_PRICE_TABLE,
  resolveKey: (sid) => keyOf(sid)
});
ingestTurn(ledgerWithKeys, { sessionId: 's-a', turn: 1, time: dayA });
ingestTurn(ledgerWithKeys, { sessionId: 's-a', turn: 2, time: dayA + 5000 });
ingestTurn(ledgerWithKeys, { sessionId: 's-b', turn: 1, time: dayB });
void led;

const calls = [
  { type: 'call', sessionId: 's-a', turn: 1, tool: 'qq_send_message', args: '{}' },
  { type: 'call', sessionId: 's-a', turn: 1, tool: 'qq_get_unread_messages', args: '{}' },
  { type: 'call', sessionId: 's-a', turn: 2, tool: 'qq_send_message', args: '{}' },
  { type: 'call', sessionId: 's-b', turn: 1, tool: 'qq_draw', args: '{}' }
];
fs.writeFileSync(toolLogFile, calls.map((row) => JSON.stringify(row)).join('\n') + '\n');

let nowMs = dayA + 60_000;
function atomicWriteJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
const deps = {
  STATE_DIR: stateDir,
  TOOL_LOG_FILE: toolLogFile,
  fs,
  path,
  atomicWriteJson,
  log: (line) => console.log(`   [log] ${line}`),
  now: () => nowMs,
  tokenToolsPure,
  readToolLog: (limit = 200) => calls.slice(-limit),
  tokenLedgerTurnOf: (sessionId, turn) => ledgerWithKeys.turnOf(sessionId, turn),
  tokenLedgerTurnsSince: (fromMs, opts) => ledgerWithKeys.turnsSince(fromMs, opts)
};
const tools = createTokenTools(deps);

const storeFile = path.join(stateDir, 'token-tools.json');
const empty = tools.buildReport({ range: 'today' });
assert(empty.ok === true && empty.total.turns === 0, '空账本：today 轮数 0');
assert(Array.isArray(empty.tools) && empty.tools.length === 0, '空账本：tools 是空数组');
assert(typeof empty.note === 'string' && empty.note.includes('按轮均摊'), 'note 说明「按轮均摊、历史不回填」');
assert(empty.range.from > 0 && empty.range.to === 0, 'today 的 range.from 是本地零点、to=0');

const rec1 = tools.recordTurn({ sessionId: 's-a', turn: 1 });
assert(rec1.ok === true && rec1.skipped === false, 'recordTurn 首次成功');
assert(rec1.day === '2026-10-30', `落在本地日期桶（实得 ${rec1.day}）`);
assert(fs.existsSync(storeFile), 'token-tools.json 已落盘');
const parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
assert(parsed.version === 1, '落盘 version=1');
assert(parsed.days['2026-10-30'] && parsed.days['2026-10-30'].total.turns === 1, '该天桶 turns=1');
assert(parsed.seen['s-a:1'] === '2026-10-30', 'seen 记下 sessionId:turn');
const rec2 = tools.recordTurn({ sessionId: 's-a', turn: 1 });
assert(rec2.skipped === true && rec2.reason === 'already-recorded', '重复 recordTurn 走 seen 跳过');
const parsedAfter = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
assert(parsedAfter.days['2026-10-30'].total.turns === 1, '重复记录不让 turns 翻倍');
const rec3 = tools.recordTurn({ sessionId: 's-a', turn: 2 });
assert(rec3.ok === true && rec3.skipped === false, '同会话第二轮也能入账');
const recMissing = tools.recordTurn({ sessionId: 's-nope', turn: 1 });
assert(recMissing.ok === false && recMissing.skipped === true, '账本里没有的轮：不抛、跳过');
const recBad = tools.recordTurn({});
assert(recBad.ok === false && recBad.skipped === true, '缺参数：不抛、跳过');
const afterTwo = tools.buildReport({ range: 'today' });
assert(afterTwo.total.turns === 2, `today 轮数 2（实得 ${afterTwo.total.turns}）`);
const ledgerTurn = ledgerWithKeys.turnOf('s-a', 1);
assert(afterTwo.total.tokens.total >= ledgerTurn.buckets.total, '当天总 token 不少于单轮 token');
const msgRow = afterTwo.tools.find((item) => item.id === 'qq_send_message');
assert(msgRow && msgRow.calls === 2, `qq_send_message 调用 2 次（实得 ${msgRow?.calls}）`);
const unreadRow = afterTwo.tools.find((item) => item.id === 'qq_get_unread_messages');
assert(unreadRow && unreadRow.calls === 1, 'qq_get_unread_messages 调用 1 次');
assert(afterTwo.groups.some((group) => group.group === 'message'), 'groups 里有「消息」类');
assert(afterTwo.total.tokens.total === msgRow.tokens.total + unreadRow.tokens.total, '两个工具 tokens 之和 = 本轮 total（均摊不丢）');
assert(afterTwo.byKey === undefined, '响应不直接暴露内部 byKey（按群查询用 key 参数）');
const keyed = tools.buildReport({ range: 'today', key: 'group:101' });
assert(keyed.total.turns === 2 && keyed.key === 'group:101', 'key 过滤后仍看到本群 2 轮');
const otherKey = tools.buildReport({ range: 'today', key: 'group:999' });
assert(otherKey.total.turns === 0 && otherKey.total.tokens.total === 0, '不存在的群：0 轮');
const crossKey = tools.buildReport({ range: 'all', key: 'group:101' });
assert(crossKey.range.from === 0, 'all 的 range.from=0');

// ── 3. 范围与跨天 ───────────────────────────────────────────────────────
const recOld = tools.recordTurn({ sessionId: 's-b', turn: 1 });
assert(recOld.ok === true, '前一天的轮也能补记');
const seven = tools.buildReport({ range: '7d' });
assert(seven.range.from < dayA, '7d 的 from 早于今天零点');
assert(seven.total.turns === 1 || seven.total.turns === 3, '7d 覆盖今天与前一天的桶');
const allRange = tools.buildReport({ range: 'all' });
assert(allRange.total.turns === 3, `all 汇总 3 轮（实得 ${allRange.total.turns}）`);
const daysInAll = JSON.parse(fs.readFileSync(storeFile, 'utf8')).days;
assert(Object.keys(daysInAll).length === 2, 'store 里有两个天的桶');
assert(allRange.mismatch === null, '正常记账：汇总差额为 0（mismatch=null）');

// ── 4. 造坏账：mismatch 必须能暴露差额 ──────────────────────────────────
{
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  store.days['2026-10-30'].total.tokens.total += 999;
  atomicWriteJson(storeFile, store);
  const bad = tools.buildReport({ range: 'today' });
  assert(bad.mismatch && bad.mismatch.tokenDiff > 0, '伪造账本：mismatch 报出 token 差额');
  store.days['2026-10-30'].total.tokens.total -= 999;
  atomicWriteJson(storeFile, store);
}

// ── 5. rebuild：只重算指定天 ────────────────────────────────────────────
{
  const before = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  const oldDayBefore = before.days['2026-10-29'] ?? null;
  const oldDayTurns = oldDayBefore?.total?.turns ?? -1;
  // 清空今天的桶（模拟「功能上线前没记过」），rebuild 应该从账本+工具日志补回来
  delete before.days['2026-10-30'];
  for (const seenKey of Object.keys(before.seen)) if (before.seen[seenKey] === '2026-10-30') delete before.seen[seenKey];
  atomicWriteJson(storeFile, before);
  const cleared = tools.buildReport({ range: 'today' });
  assert(cleared.total.turns === 0, '清空后 today 轮数 0（待 rebuild）');
  // rebuild 走真实路由（工厂只暴露 manifest 里的四个函数，没有内部 _rebuild 可调）
  const rbOut = { status: 0, payload: null };
  const rbHandled = await tools.handleTokensTools({
    req: { method: 'POST', headers: {} },
    url: new URL('http://127.0.0.1:3100/api/tokens/tools/rebuild'),
    sendJson: (payload, status = 200) => { rbOut.payload = payload; rbOut.status = status; },
    readBody: async () => ({ days: 1 })
  });
  assert(rbHandled === true && rbOut.status === 200, 'rebuild 走 POST 路由回 200');
  const rebuilt = rbOut.payload;
  assert(rebuilt.ok === true && rebuilt.turns === 2, `rebuild(1) 重算 2 轮（实得 ${rebuilt.turns}）`);
  assert(JSON.stringify(rebuilt.days.map((d) => d.day)) === JSON.stringify(['2026-10-30']), 'rebuild 只碰今天');
  const saved = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  const savedOld = saved.days['2026-10-29'] ?? null;
  assert(savedOld && savedOld.total.turns === oldDayTurns && JSON.stringify(savedOld.total) === JSON.stringify(oldDayBefore.total), '前一天桶的总数原样不动');
  const afterRebuild = tools.buildReport({ range: 'today' });
  assert(afterRebuild.total.turns === 2, 'rebuild 后 today 轮数恢复 2');
  assert(saved.seen['s-a:1'] === '2026-10-30', 'rebuild 一并重建 seen');
}

// ── 6. 路由：参数校验 / agent 403 / 原子写 ──────────────────────────────
function fakeRequest({ method = 'GET', pathName, search = '', headers = {}, body = null }) {
  const out = { status: 0, payload: null };
  return {
    out,
    request: {
      req: { method, headers },
      url: new URL(`http://127.0.0.1:3100${pathName}${search}`),
      sendJson: (payload, status = 200) => { out.payload = payload; out.status = status; },
      readBody: async () => body
    }
  };
}

{
  const { request, out } = fakeRequest({ pathName: '/api/tokens/tools', search: '?range=today' });
  const handled = await tools.handleTokensTools(request);
  assert(handled === true && out.status === 200 && out.payload.ok === true, 'GET /api/tokens/tools 200');
  assert(out.payload.range && out.payload.tools.length >= 1, '响应带 range 与 tools');
  const other = fakeRequest({ pathName: '/api/other' });
  assert(await tools.handleTokensTools(other.request) === false, '其它路径不接管');
  const badRange = fakeRequest({ pathName: '/api/tokens/tools', search: '?range=year' });
  await tools.handleTokensTools(badRange.request);
  assert(badRange.out.status === 400 && /range 不合法/.test(badRange.out.payload.error), '非法 range → 400 说清允许值');
  const postQuery = fakeRequest({ pathName: '/api/tokens/tools', method: 'POST' });
  await tools.handleTokensTools(postQuery.request);
  assert(postQuery.out.status === 405, '查询接口只收 GET');
  const agentQuery = fakeRequest({ pathName: '/api/tokens/tools', headers: { 'x-agent-token': 'x' } });
  await tools.handleTokensTools(agentQuery.request);
  assert(agentQuery.out.status === 403, 'agent 令牌 403（查询）');
  const agentCall = fakeRequest({ pathName: '/api/tokens/tools/rebuild', method: 'POST', headers: { 'x-agent-call': '1' }, body: {} });
  await tools.handleTokensTools(agentCall.request);
  assert(agentCall.out.status === 403, 'agent 令牌 403（rebuild）');
  const getRebuild = fakeRequest({ pathName: '/api/tokens/tools/rebuild' });
  await tools.handleTokensTools(getRebuild.request);
  assert(getRebuild.out.status === 405, 'rebuild 只收 POST');
  const badJson = fakeRequest({ pathName: '/api/tokens/tools/rebuild', method: 'POST', body: null });
  badJson.request.readBody = async () => { throw new Error('bad'); };
  await tools.handleTokensTools(badJson.request);
  assert(badJson.out.status === 400, '请求体坏 → 400');
  const badDays = fakeRequest({ pathName: '/api/tokens/tools/rebuild', method: 'POST', body: { days: 0 } });
  await tools.handleTokensTools(badDays.request);
  assert(badDays.out.status === 400 && /days/.test(badDays.out.payload.error), 'days 越界 → 400');
  const okRebuild = fakeRequest({ pathName: '/api/tokens/tools/rebuild', method: 'POST', body: { days: 1 } });
  await tools.handleTokensTools(okRebuild.request);
  assert(okRebuild.out.status === 200 && okRebuild.out.payload.ok === true, 'rebuild 200');
  const leftovers = fs.readdirSync(stateDir).filter((name) => name.endsWith('.tmp'));
  assert(leftovers.length === 0, `原子写不留 .tmp（实得 ${leftovers.join(',') || '无'}）`);
  const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  assert(raw.version === 1 && raw.days && typeof raw.seen === 'object', '落盘 JSON 可解析且结构完整');
}

// ── 7. 坏文件容错 ───────────────────────────────────────────────────────
{
  fs.writeFileSync(storeFile, '{ 这不是 JSON');
  const broken = tools.buildReport({ range: 'today' });
  assert(broken.ok === true && broken.total.turns === 0, '账本文件坏掉：查询回空而不是抛');
  const rec = tools.recordTurn({ sessionId: 's-a', turn: 2 });
  assert(rec.ok === false || rec.ok === true, '坏文件下 recordTurn 不抛（要么重建要么跳过）');
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ }

console.log(`\n通过 ${passed} / 失败 ${failed}`);
process.exit(failed ? 1 : 0);
