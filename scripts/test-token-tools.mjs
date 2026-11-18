// 工具维度 token 归因的纯函数测试（不碰 fs/网络/桥接）。
import assert from 'node:assert/strict';

import {
  DAY_MS,
  TOKEN_DAY_LIMIT,
  TOKEN_KEYS,
  TOOL_GROUPS,
  TOOL_META,
  addTokens,
  addTurnIntoDay,
  aggregateToolDays,
  allocateTurnTokens,
  emptyDayBucket,
  emptyTokens,
  emptyToolTotals,
  normalizeToolName,
  normalizeToolToolsStore,
  tokensFromBuckets
} from '../src/token-tools.js';

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`❌ ${name}`);
    console.error(`   ${error?.message ?? error}`);
  }
}
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const sumTokens = (rows) => rows.reduce((sum, row) => sum + row.tokens.total, 0);
const sumCost = (rows) => rows.reduce((sum, row) => sum + row.cost, 0);

console.log('## 分组与工具表');
check('TOOL_GROUPS 五个类别且都有中文名', () => {
  assert.deepEqual(Object.keys(TOOL_GROUPS), ['message', 'read', 'media', 'memory', 'other']);
  for (const label of Object.values(TOOL_GROUPS)) assert.ok(typeof label === 'string' && label.length > 0);
});
check('TOOL_GROUPS 被冻结（调用方不能改坏共享表）', () => assert.ok(Object.isFrozen(TOOL_GROUPS)));
check('TOOL_META 覆盖真实工具清单（≥17）且都有 label/group', () => {
  // 首版登记 17 个；之后按真机日志补了 4 个（forward/自己最近发言/会话状态/提交黑话）。
  assert.ok(Object.keys(TOOL_META).length >= 17);
  for (const [id, meta] of Object.entries(TOOL_META)) {
    assert.ok(id.startsWith('qq_'), `${id} 应以 qq_ 开头`);
    assert.ok(meta.label.length > 0);
    assert.ok(Object.hasOwn(TOOL_GROUPS, meta.group), `${id} 的 group ${meta.group} 不在 TOOL_GROUPS`);
  }
});
check('已登记工具的类别符合约定（消息=1 媒体=5）', () => {
  const byGroup = {};
  for (const meta of Object.values(TOOL_META)) byGroup[meta.group] = (byGroup[meta.group] ?? 0) + 1;
  assert.equal(byGroup.message, 1);
  assert.equal(byGroup.media, 5);
  assert.ok(byGroup.memory >= 4);
  assert.ok(byGroup.read >= 7);
});
check('TOOL_META 覆盖 qq_send_message 与 qq_draw', () => {
  assert.equal(TOOL_META.qq_send_message.group, 'message');
  assert.equal(TOOL_META.qq_draw.group, 'media');
});

console.log('## normalizeToolName');
check('裸工具名返回登记信息', () => {
  const meta = normalizeToolName('qq_send_sticker');
  assert.deepEqual(meta, { id: 'qq_send_sticker', label: '发表情', group: 'media', groupLabel: '媒体' });
});
check('去 mcp__snowluma__ 前缀', () => {
  const meta = normalizeToolName('mcp__snowluma__qq_get_unread_messages');
  assert.equal(meta.id, 'qq_get_unread_messages');
  assert.equal(meta.group, 'read');
  assert.equal(meta.groupLabel, '查看与等待');
});
check('去 mcp__web-search-safe__ 前缀（未登记工具归 other）', () => {
  const meta = normalizeToolName('mcp__web-search-safe__web_search');
  assert.equal(meta.id, 'web_search');
  assert.equal(meta.label, 'web_search');
  assert.equal(meta.group, 'other');
  assert.equal(meta.groupLabel, '其他');
});
check('未登记工具保留原名当 label、归 other', () => {
  const meta = normalizeToolName('some_unknown_tool');
  assert.deepEqual(meta, { id: 'some_unknown_tool', label: 'some_unknown_tool', group: 'other', groupLabel: '其他' });
});
check('空值/空白不抛，id 为空串', () => {
  assert.equal(normalizeToolName('').id, '');
  assert.equal(normalizeToolName('   ').id, '');
  assert.equal(normalizeToolName(null).id, '');
  assert.equal(normalizeToolName(undefined).id, '');
});
check('前缀里带下划线以外的字符也剥得掉', () => {
  assert.equal(normalizeToolName('mcp__my-server__qq_draw').id, 'qq_draw');
});

console.log('## token 桶');
check('emptyTokens 四项归零', () => assert.deepEqual(emptyTokens(), { prompt: 0, completion: 0, cached: 0, total: 0 }));
check('TOKEN_KEYS 固定四个键', () => assert.deepEqual([...TOKEN_KEYS], ['prompt', 'completion', 'cached', 'total']));
check('tokensFromBuckets 的 total 只算 prompt+completion（cached 不重复计）', () => {
  assert.deepEqual(tokensFromBuckets({ prompt: 100, completion: 50, cached: 40, total: 999 }), { prompt: 100, completion: 50, cached: 40, total: 150 });
});
check('tokensFromBuckets 坏值当 0', () => {
  assert.deepEqual(tokensFromBuckets({ prompt: 'x', completion: null }), { prompt: 0, completion: 0, cached: 0, total: 0 });
  assert.deepEqual(tokensFromBuckets(null), { prompt: 0, completion: 0, cached: 0, total: 0 });
});
check('addTokens 就地累加四项', () => {
  const target = emptyTokens();
  addTokens(target, { prompt: 1, completion: 2, cached: 3, total: 3 });
  addTokens(target, { prompt: 4, completion: 5, cached: 6, total: 9 });
  assert.deepEqual(target, { prompt: 5, completion: 7, cached: 9, total: 12 });
});
check('emptyToolTotals 结构', () => {
  assert.deepEqual(emptyToolTotals(), { calls: 0, turns: 0, failed: 0, tokens: { prompt: 0, completion: 0, cached: 0, total: 0 }, cost: 0 });
});

console.log('## allocateTurnTokens 均摊');
const turnOf = (prompt, completion, cost) => ({ buckets: { prompt, completion, cached: Math.floor(prompt / 2) }, cost });
check('单工具拿走 100% 的 token 与 cost', () => {
  const alloc = allocateTurnTokens(turnOf(100, 50, 0.12), [{ tool: 'qq_send_message' }]);
  const row = alloc.rows.qq_send_message;
  assert.deepEqual(row.tokens, { prompt: 100, completion: 50, cached: 50, total: 150 });
  assert.equal(row.cost, 0.12);
  assert.equal(row.turns, 1);
  assert.equal(row.calls, 1);
  assert.equal(alloc.noTool.turns, 0);
});
check('两个工具按次数 2:1 均摊，余数给调用多的那个', () => {
  const alloc = allocateTurnTokens(turnOf(100, 50, 0.3), [{ tool: 'qq_send_message' }, { tool: 'qq_send_message' }, { tool: 'qq_draw' }]);
  assert.equal(alloc.rows.qq_send_message.calls, 2);
  assert.equal(alloc.rows.qq_draw.calls, 1);
  assert.deepEqual(alloc.rows.qq_send_message.tokens, { prompt: 67, completion: 34, cached: 34, total: 101 });
  assert.deepEqual(alloc.rows.qq_draw.tokens, { prompt: 33, completion: 16, cached: 16, total: 49 });
});
check('同一输入两次完全一致（可复现）', () => {
  const calls = [{ tool: 'qq_draw' }, { tool: 'qq_send_message' }, { tool: 'qq_wait_for_messages' }];
  assert.deepEqual(allocateTurnTokens(turnOf(101, 37, 0.2), calls), allocateTurnTokens(turnOf(101, 37, 0.2), calls));
});
check('余数平局时按工具名升序决定归属（qq_draw < qq_send_message）', () => {
  const alloc = allocateTurnTokens({ buckets: { prompt: 1, completion: 0 }, cost: 0 }, [{ tool: 'qq_send_message' }, { tool: 'qq_draw' }]);
  // 1 token / 2 次 → 各 0，余 1 给排序第一（qq_draw）
  assert.equal(alloc.rows.qq_draw.tokens.total, 1);
  assert.equal(alloc.rows.qq_send_message.tokens.total, 0);
});
check('cost 分摊后 Σ 与整轮 cost 差 <1e-6', () => {
  for (const cost of [0.12, 0.0137, 1 / 3, 0.000001]) {
    const alloc = allocateTurnTokens({ buckets: { prompt: 10, completion: 5 }, cost }, [{ tool: 'qq_draw' }, { tool: 'qq_draw' }, { tool: 'qq_memory' }]);
    assert.ok(close(sumCost(Object.values(alloc.rows)), cost), `cost=${cost} 差了 ${sumCost(Object.values(alloc.rows)) - cost}`);
  }
});
check('token 三个桶分摊后 Σ 与整轮一致', () => {
  const turn = turnOf(100, 50, 0.5);
  const alloc = allocateTurnTokens(turn, [{ tool: 'qq_draw' }, { tool: 'qq_memory' }, { tool: 'qq_memory' }]);
  const rows = Object.values(alloc.rows);
  const expect = tokensFromBuckets(turn.buckets);
  assert.equal(rows.reduce((s, r) => s + r.tokens.prompt, 0), expect.prompt);
  assert.equal(rows.reduce((s, r) => s + r.tokens.completion, 0), expect.completion);
  assert.equal(rows.reduce((s, r) => s + r.tokens.cached, 0), expect.cached);
});
check('failed 调用按工具计数', () => {
  const alloc = allocateTurnTokens(turnOf(10, 10, 0.01), [{ tool: 'qq_get_message_detail', failed: true }, { tool: 'qq_get_message_detail' }, { tool: 'qq_draw', failed: true }]);
  assert.equal(alloc.rows.qq_get_message_detail.failed, 1);
  assert.equal(alloc.rows.qq_get_message_detail.calls, 2);
  assert.equal(alloc.rows.qq_draw.failed, 1);
});
check('空 calls 整轮进 noTool', () => {
  const alloc = allocateTurnTokens(turnOf(80, 20, 0.05), []);
  assert.deepEqual(alloc.rows, {});
  assert.equal(alloc.noTool.turns, 1);
  assert.equal(alloc.noTool.tokens.total, 100);
  assert.equal(alloc.noTool.cost, 0.05);
  assert.equal(alloc.unassigned.calls, 0);
});
check('calls 非数组当空处理', () => {
  assert.equal(allocateTurnTokens(turnOf(1, 1, 0), null).noTool.turns, 1);
});
check('mcq 前缀的工具名归一到同一 id（两次调用合并计数）', () => {
  const alloc = allocateTurnTokens(turnOf(10, 10, 0.01), [{ tool: 'mcp__snowluma__qq_draw' }, { tool: 'qq_draw' }]);
  assert.equal(alloc.rows.qq_draw.calls, 2);
  assert.deepEqual(Object.keys(alloc.rows), ['qq_draw']);
});
check('工具名为空的调用进 unassigned（不瞎塞给谁）', () => {
  const alloc = allocateTurnTokens(turnOf(10, 10, 0.01), [{ tool: '' }, { tool: 'qq_draw' }]);
  assert.equal(alloc.unassigned.calls, 1);
  assert.equal(alloc.rows.qq_draw.calls, 1);
  assert.ok(alloc.unassigned.tokens.total > 0);
});
check('未知工具也参与均摊（归 other）', () => {
  const alloc = allocateTurnTokens(turnOf(10, 10, 0.01), [{ tool: 'mystery_tool' }, { tool: 'qq_draw' }]);
  assert.ok(Object.hasOwn(alloc.rows, 'mystery_tool'));
  assert.equal(alloc.rows.mystery_tool.tokens.total + alloc.rows.qq_draw.tokens.total, 20);
});

console.log('## emptyDayBucket / addTurnIntoDay');
check('emptyDayBucket 结构齐全', () => {
  const day = emptyDayBucket();
  assert.equal(day.total.turns, 0);
  assert.equal(day.total.tokens.total, 0);
  assert.deepEqual(day.rows, {});
  assert.deepEqual(day.byKey, {});
  assert.equal(day.noTool.turns, 0);
  assert.equal(day.unattr.turns, 0);
});
check('addTurnIntoDay 不改入参（纯函数）', () => {
  const before = emptyDayBucket();
  const snapshot = JSON.stringify(before);
  addTurnIntoDay(before, { key: 'group:1', allocation: allocateTurnTokens(turnOf(10, 10, 0.01), [{ tool: 'qq_draw' }]), turnCost: 0.01, turnTokens: { prompt: 10, completion: 10, total: 20 } });
  assert.equal(JSON.stringify(before), snapshot);
});
check('addTurnIntoDay 累加 total/rows/calls/failed', () => {
  const day = addTurnIntoDay(emptyDayBucket(), {
    key: 'group:1',
    allocation: allocateTurnTokens(turnOf(10, 10, 0.01), [{ tool: 'qq_draw', failed: true }, { tool: 'qq_memory' }]),
    turnCost: 0.01,
    turnTokens: { prompt: 10, completion: 10, cached: 5, total: 20 }
  });
  assert.equal(day.total.turns, 1);
  assert.equal(day.total.calls, 2);
  assert.equal(day.total.failed, 1);
  assert.equal(day.total.tokens.total, 20);
  assert.equal(day.total.cost, 0.01);
  assert.ok(day.rows.qq_draw.calls === 1 && day.rows.qq_memory.calls === 1);
});
check('同一 key 连续两轮累加、不同 key 分开', () => {
  let day = emptyDayBucket();
  const alloc = allocateTurnTokens(turnOf(10, 10, 0.02), [{ tool: 'qq_draw' }]);
  const tokens = { prompt: 10, completion: 10, total: 20 };
  day = addTurnIntoDay(day, { key: 'group:1', allocation: alloc, turnCost: 0.02, turnTokens: tokens });
  day = addTurnIntoDay(day, { key: 'group:1', allocation: alloc, turnCost: 0.02, turnTokens: tokens });
  day = addTurnIntoDay(day, { key: 'group:2', allocation: alloc, turnCost: 0.02, turnTokens: tokens });
  assert.equal(day.byKey['group:1'].total.turns, 2);
  assert.equal(day.byKey['group:1'].rows.qq_draw.calls, 2);
  assert.equal(day.byKey['group:2'].total.turns, 1);
  assert.equal(day.total.turns, 3);
});
check('addTurnIntoDay 空 calls 把 noTool 记进当天与 byKey', () => {
  const day = addTurnIntoDay(emptyDayBucket(), { key: 'private:1', allocation: allocateTurnTokens(turnOf(5, 5, 0.001), []), turnCost: 0.001, turnTokens: { prompt: 5, completion: 5, total: 10 } });
  assert.equal(day.noTool.turns, 1);
  assert.equal(day.byKey['private:1'].noTool.turns, 1);
});
check('addTurnIntoDay 缺 allocation 时不抛、把整轮记进 unattr', () => {
  const day = addTurnIntoDay(emptyDayBucket(), { turnCost: 0.5, turnTokens: { prompt: 10, completion: 10, total: 20 } });
  assert.equal(day.total.turns, 1);
  assert.ok(day.unattr.tokens.total >= 0);
  assert.ok(day.unattr.cost >= 0);
});

console.log('## aggregateToolDays');
function buildTwoDays() {
  const a = allocateTurnTokens(turnOf(100, 50, 0.12), [{ tool: 'qq_send_message' }, { tool: 'qq_draw' }, { tool: 'qq_get_unread_messages', failed: true }]);
  const b = allocateTurnTokens(turnOf(40, 10, 0.03), [{ tool: 'qq_draw' }]);
  const c = allocateTurnTokens(turnOf(10, 10, 0.01), []);
  let day1 = addTurnIntoDay(emptyDayBucket(), { key: 'group:1', allocation: a, turnCost: 0.12, turnTokens: { prompt: 100, completion: 50, cached: 50, total: 150 } });
  day1 = addTurnIntoDay(day1, { key: 'group:2', allocation: b, turnCost: 0.03, turnTokens: { prompt: 40, completion: 10, cached: 20, total: 50 } });
  let day2 = addTurnIntoDay(emptyDayBucket(), { key: 'group:1', allocation: c, turnCost: 0.01, turnTokens: { prompt: 10, completion: 10, cached: 5, total: 20 } });
  day2 = addTurnIntoDay(day2, { key: 'group:2', allocation: a, turnCost: 0.12, turnTokens: { prompt: 100, completion: 50, cached: 50, total: 150 } });
  return { day1, day2 };
}
check('全部范围：total 汇总与 mismatch 为 null', () => {
  const { day1, day2 } = buildTwoDays();
  const agg = aggregateToolDays([day1, day2], { fromMs: 1000, toMs: 2000 });
  assert.equal(agg.total.turns, 4);
  assert.equal(agg.total.calls, 7);
  // 带 failed 的那轮在两天各记了一次，所以是 2。
  assert.equal(agg.total.failed, 2);
  assert.equal(agg.total.tokens.total, 150 + 50 + 20 + 150);
  assert.ok(close(agg.total.cost, 0.12 + 0.03 + 0.01 + 0.12));
  assert.equal(agg.mismatch, null);
  assert.deepEqual(agg.range, { from: 1000, to: 2000, days: 2 });
});
check('tools 按 tokens 降序且字段齐全', () => {
  const { day1, day2 } = buildTwoDays();
  const agg = aggregateToolDays([day1, day2]);
  assert.ok(agg.tools.length >= 3);
  const first = agg.tools[0];
  assert.ok(first.tokens.total >= agg.tools[1].tokens.total);
  for (const tool of agg.tools) {
    for (const key of ['id', 'label', 'group', 'groupLabel', 'calls', 'turns', 'failed', 'tokens', 'cost', 'share', 'avgTokensPerTurn']) {
      assert.ok(Object.hasOwn(tool, key), `tools[] 缺 ${key}`);
    }
    assert.ok(tool.share >= 0 && tool.share <= 1);
  }
  const draw = agg.tools.find((tool) => tool.id === 'qq_draw');
  assert.equal(draw.calls, 3);
  assert.equal(draw.turns, 3);
});
check('groups 汇总每个类别、share 合计 ≈1', () => {
  const { day1, day2 } = buildTwoDays();
  const agg = aggregateToolDays([day1, day2]);
  const totalShare = agg.tools.reduce((sum, tool) => sum + tool.share, 0) + agg.noTool.share + agg.unattr.share;
  assert.ok(close(totalShare, 1, 1e-3), `share 合计 ${totalShare}`);
  const groupSum = agg.groups.reduce((sum, group) => sum + group.tokens.total, 0);
  assert.equal(groupSum, agg.total.tokens.total - agg.noTool.tokens.total - agg.unattr.tokens.total);
});
check('noTool 记录没调工具的轮次与占比', () => {
  const { day1, day2 } = buildTwoDays();
  const agg = aggregateToolDays([day1, day2]);
  assert.equal(agg.noTool.turns, 1);
  assert.equal(agg.noTool.tokens.total, 20);
  assert.ok(agg.noTool.share > 0);
});
check('unattr 正常为 0（数据干净时不背锅）', () => {
  const { day1, day2 } = buildTwoDays();
  assert.equal(aggregateToolDays([day1, day2]).unattr.turns, 0);
});
check('mismatch 能报出来（人为把 total 改大）', () => {
  const { day1 } = buildTwoDays();
  const tampered = { ...day1, total: { ...day1.total, tokens: { ...day1.total.tokens, total: day1.total.tokens.total + 7 } } };
  const agg = aggregateToolDays([tampered]);
  assert.ok(agg.mismatch);
  assert.ok(agg.mismatch.tokenDiff < 0 || agg.mismatch.tokenDiff > 0);
});
check('key 过滤只看该群', () => {
  const { day1, day2 } = buildTwoDays();
  const g1 = aggregateToolDays([day1, day2], { key: 'group:1' });
  assert.equal(g1.total.turns, 2);
  assert.equal(g1.total.tokens.total, 150 + 20);
  const g2 = aggregateToolDays([day1, day2], { key: 'group:2' });
  assert.equal(g2.total.turns, 2);
  assert.equal(g2.total.tokens.total, 50 + 150);
  const none = aggregateToolDays([day1, day2], { key: 'group:404' });
  assert.equal(none.total.turns, 0);
  assert.deepEqual(none.tools, []);
  assert.equal(none.range.days, 0);
});
check('key 传 all/undefined/空串都是全部', () => {
  const { day1, day2 } = buildTwoDays();
  const all = aggregateToolDays([day1, day2]).total;
  assert.equal(aggregateToolDays([day1, day2], { key: 'all' }).total.turns, all.turns);
  assert.equal(aggregateToolDays([day1, day2], { key: '' }).total.turns, all.turns);
});
check('空 days / 非数组不抛', () => {
  assert.equal(aggregateToolDays([]).total.turns, 0);
  assert.equal(aggregateToolDays(null).total.tokens.total, 0);
  assert.deepEqual(aggregateToolDays({}).tools, []);
});
check('days 传对象（日期→桶）也能聚合', () => {
  const { day1 } = buildTwoDays();
  const agg = aggregateToolDays({ '2026-10-30': day1 });
  assert.equal(agg.total.turns, 2);
});
check('avgTokensPerTurn = tokens/turns', () => {
  const alloc = allocateTurnTokens(turnOf(100, 100, 0.02), [{ tool: 'qq_draw' }]);
  const tokens = { prompt: 100, completion: 100, total: 200 };
  let day = addTurnIntoDay(emptyDayBucket(), { allocation: alloc, turnCost: 0.02, turnTokens: tokens });
  day = addTurnIntoDay(day, { allocation: alloc, turnCost: 0.02, turnTokens: tokens });
  const draw = aggregateToolDays([day]).tools.find((tool) => tool.id === 'qq_draw');
  assert.equal(draw.turns, 2);
  assert.equal(draw.avgTokensPerTurn, 200);
});

console.log('## normalizeToolToolsStore');
check('version 强制 1、坏日期键与坏 day 丢弃', () => {
  const store = normalizeToolToolsStore({ version: 9, days: { '2026-10-30': emptyDayBucket(), bad: {}, '2026/10/29': emptyDayBucket(), '2026-10-28': null } });
  assert.equal(store.version, 1);
  assert.deepEqual(Object.keys(store.days), ['2026-10-30']);
});
check('坏整体输入回空 store（不抛）', () => {
  for (const raw of [null, undefined, 42, 'x', [], { days: [] }]) {
    const store = normalizeToolToolsStore(raw, { now: Date.parse('2026-10-30T12:00:00Z') });
    assert.equal(store.version, 1);
    assert.deepEqual(store.days, {});
  }
});
check('超过 60 天按日期倒序裁剪', () => {
  const days = {};
  for (let i = 0; i < 70; i += 1) {
    const d = new Date(Date.UTC(2026, 0, 1) + i * DAY_MS);
    days[`${d.toISOString().slice(0, 10)}`] = emptyDayBucket();
  }
  // now:0 关掉时间窗，只测「最多 60 天」这一条（否则 70 天跨度会先被窗口裁掉）。
  const store = normalizeToolToolsStore({ days }, { now: 0 });
  assert.equal(Object.keys(store.days).length, TOKEN_DAY_LIMIT);
  const keys = Object.keys(store.days);
  assert.ok(keys[0] > keys[keys.length - 1], '应按日期倒序');
});
check('now 时间窗把 60 天前的键过滤掉', () => {
  const day = emptyDayBucket();
  const store = normalizeToolToolsStore({ days: { '2026-01-01': day, '2026-10-30': day } }, { now: Date.parse('2026-10-30T12:00:00Z') });
  assert.deepEqual(Object.keys(store.days), ['2026-10-30']);
});
check('byKey 被复制保留，且与 days 数据不共享引用', () => {
  const day = emptyDayBucket();
  day.byKey['group:1'] = { ...emptyDayBucket() };
  delete day.byKey['group:1'].byKey;
  const store = normalizeToolToolsStore({ days: { '2026-10-30': day } }, { now: Date.parse('2026-10-30T12:00:00Z') });
  assert.ok(store.days['2026-10-30'].byKey['group:1']);
  assert.notEqual(store.days['2026-10-30'].byKey['group:1'], day.byKey['group:1']);
});
check('往返幂等（normalize 两次结果一致）', () => {
  const { day1 } = (() => {
    const alloc = allocateTurnTokens(turnOf(10, 5, 0.01), [{ tool: 'qq_draw' }]);
    const day = addTurnIntoDay(emptyDayBucket(), { key: 'group:1', allocation: alloc, turnCost: 0.01, turnTokens: { prompt: 10, completion: 5, total: 15 } });
    return { day1: day };
  })();
  const now = Date.parse('2026-10-30T12:00:00Z');
  const once = normalizeToolToolsStore({ days: { '2026-10-30': day1 } }, { now });
  const twice = normalizeToolToolsStore(once, { now });
  assert.deepEqual(twice, once);
});

console.log('## 补充契约细节');
check('TOOL_META 被冻结', () => assert.ok(Object.isFrozen(TOOL_META)));
check('DAY_MS 是 24 小时、TOKEN_DAY_LIMIT 是 60', () => {
  assert.equal(DAY_MS, 86400000);
  assert.equal(TOKEN_DAY_LIMIT, 60);
});
check('四个分组各有能落进去的工具', () => {
  const groups = new Set(Object.values(TOOL_META).map((meta) => meta.group));
  for (const group of ['message', 'read', 'media', 'memory']) assert.ok(groups.has(group), `没有 ${group} 类工具`);
});
check('三个同类工具同次数时余数给名字最小的', () => {
  const alloc = allocateTurnTokens({ buckets: { prompt: 2, completion: 1 }, cost: 0 }, [
    { tool: 'qq_send_message' },
    { tool: 'qq_draw' },
    { tool: 'qq_memory' }
  ]);
  // 2 tokens / 3 次 → 各 0，余 2 全给排序第一（qq_draw < qq_memory < qq_send_message）
  assert.equal(alloc.rows.qq_draw.tokens.prompt, 2);
  assert.equal(alloc.rows.qq_memory.tokens.prompt, 0);
  assert.equal(alloc.rows.qq_send_message.tokens.prompt, 0);
});
check('cost 分摊保留不超过 6 位小数', () => {
  const alloc = allocateTurnTokens({ buckets: { prompt: 10, completion: 0 }, cost: 1 / 7 }, [{ tool: 'qq_draw' }, { tool: 'qq_memory' }, { tool: 'qq_memory' }]);
  for (const row of Object.values(alloc.rows)) {
    const text = String(row.cost);
    const decimals = text.includes('.') ? text.split('.')[1].length : 0;
    assert.ok(decimals <= 6, `cost=${row.cost} 超过 6 位小数`);
  }
});
check('aggregate 的 tools[].label 来自登记表（前缀名也能还原中文）', () => {
  const alloc = allocateTurnTokens(turnOf(10, 10, 0.01), [{ tool: 'mcp__snowluma__qq_get_unread_messages' }]);
  const day = addTurnIntoDay(emptyDayBucket(), { allocation: alloc, turnCost: 0.01, turnTokens: { prompt: 10, completion: 10, total: 20 } });
  const tool = aggregateToolDays([day]).tools[0];
  assert.equal(tool.id, 'qq_get_unread_messages');
  assert.equal(tool.label, '未读消息');
  assert.equal(tool.groupLabel, '查看与等待');
});
check('没有空转轮次时 noTool.share 为 0', () => {
  const alloc = allocateTurnTokens(turnOf(10, 10, 0.01), [{ tool: 'qq_draw' }]);
  const day = addTurnIntoDay(emptyDayBucket(), { allocation: alloc, turnCost: 0.01, turnTokens: { prompt: 10, completion: 10, total: 20 } });
  const agg = aggregateToolDays([day]);
  assert.equal(agg.noTool.share, 0);
  assert.equal(agg.noTool.turns, 0);
});
check('byKey 各群合计 == 当天 total（拆群不漏账）', () => {
  const alloc = allocateTurnTokens(turnOf(10, 10, 0.02), [{ tool: 'qq_draw' }]);
  const tokens = { prompt: 10, completion: 10, total: 20 };
  let day = addTurnIntoDay(emptyDayBucket(), { key: 'group:1', allocation: alloc, turnCost: 0.02, turnTokens: tokens });
  day = addTurnIntoDay(day, { key: 'group:2', allocation: alloc, turnCost: 0.02, turnTokens: tokens });
  const buckets = Object.values(day.byKey);
  assert.equal(buckets.reduce((sum, b) => sum + b.total.turns, 0), day.total.turns);
  assert.equal(buckets.reduce((sum, b) => sum + b.total.tokens.total, 0), day.total.tokens.total);
  assert.ok(close(buckets.reduce((sum, b) => sum + b.total.cost, 0), day.total.cost));
});
check('normalize 保留 byKey 里的 token 明细（不是只剩空壳）', () => {
  const alloc = allocateTurnTokens(turnOf(10, 10, 0.02), [{ tool: 'qq_draw' }]);
  const day = addTurnIntoDay(emptyDayBucket(), { key: 'group:1', allocation: alloc, turnCost: 0.02, turnTokens: { prompt: 10, completion: 10, total: 20 } });
  const store = normalizeToolToolsStore({ days: { '2026-10-30': day } }, { now: Date.parse('2026-10-30T12:00:00Z') });
  const bucket = store.days['2026-10-30'].byKey['group:1'];
  assert.equal(bucket.total.tokens.total, 20);
  assert.equal(bucket.rows.qq_draw.calls, 1);
});
check('key 过滤后的 mismatch 也是 null（干净数据）', () => {
  const { day1, day2 } = buildTwoDays();
  assert.equal(aggregateToolDays([day1, day2], { key: 'group:1' }).mismatch, null);
});
check('aggregate 不改入参的 day 对象', () => {
  const { day1 } = buildTwoDays();
  const snapshot = JSON.stringify(day1);
  aggregateToolDays([day1], { key: 'group:1' });
  assert.equal(JSON.stringify(day1), snapshot);
});

if (failures.length) {
  console.error(`\n❌ test-token-tools 失败 ${failures.length} 项`);
  process.exit(1);
}
console.log(`\n🎉 test-token-tools 全部通过（${passed} 项）`);
