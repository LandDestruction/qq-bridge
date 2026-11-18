// 工具维度的 token 归因（纯函数）。
// 契约（已拍板）：一轮开销按该轮工具**调用次数**均摊；16 个工具按类别分组；今日/7天/全部 + 按群筛选。
// 均摊必须可复现：余数按「调用次数降序、工具名升序」全给第一个，cost 最后一项吸收舍入误差。

export const TOKEN_DAY_LIMIT = 60;
export const DAY_MS = 24 * 3600 * 1000;
export const TOKEN_KEYS = Object.freeze(['prompt', 'completion', 'cached', 'total']);
export const TOOL_GROUPS = Object.freeze({ message: '消息', read: '查看与等待', media: '媒体', memory: '记忆与配置', other: '其他' });

const M = (label, group) => ({ label, group });
// 17 个已登记的 QQ 工具（去 `mcp__snowluma__` 前缀后的名字）；未登记的走 other，label 保留原名。
export const TOOL_META = Object.freeze({
  qq_send_message: M('发消息', 'message'),
  qq_send_sticker: M('发表情', 'media'), qq_draw: M('画图', 'media'), qq_send_image: M('发图片', 'media'),
  qq_get_message_images: M('消息图片', 'media'), qq_collect_sticker: M('收藏表情', 'media'),
  qq_get_unread_messages: M('未读消息', 'read'), qq_get_recent_messages: M('最近消息', 'read'),
  qq_get_message_detail: M('消息详情', 'read'), qq_wait_for_messages: M('等消息', 'read'),
  qq_mark_read: M('标已读', 'read'), qq_search_history: M('搜历史', 'read'), qq_list_stickers: M('表情列表', 'read'),
  qq_set_wake_config: M('唤醒配置', 'memory'), qq_get_prompt: M('当前提示词', 'memory'),
  qq_memory: M('记忆', 'memory'), qq_memory_event: M('事件记忆', 'memory'),
  // 补充：真机日志里出现过、但首版漏登记的几个（未登记会回退成英文 id，表格不好看）。
  qq_get_forward_msg: M('看转发消息', 'read'), qq_get_my_recent_messages: M('自己最近发言', 'read'),
  qq_social_state: M('会话状态', 'read'), qq_slang_submit: M('提交黑话', 'memory')
});

const num = (value) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
const round = (value, digits) => { const n = Number(value); if (!Number.isFinite(n)) return 0; const f = 10 ** digits; return Math.round(n * f) / f; };

export const emptyTokens = () => ({ prompt: 0, completion: 0, cached: 0, total: 0 });
export function tokensFromBuckets(buckets) {
  const src = buckets && typeof buckets === 'object' ? buckets : {};
  const prompt = num(src.prompt);
  const completion = num(src.completion);
  // cached 是 prompt 的子集，单列给人看；total 只加 prompt+completion，避免重复计数。
  return { prompt, completion, cached: num(src.cached), total: prompt + completion };
}
export function addTokens(target, extra) {
  const out = target && typeof target === 'object' ? target : emptyTokens();
  for (const key of TOKEN_KEYS) out[key] = num(out[key]) + num(extra?.[key]);
  return out;
}
export const emptyToolTotals = () => ({ calls: 0, turns: 0, failed: 0, tokens: emptyTokens(), cost: 0 });
const emptyBucketBase = () => ({
  total: { turns: 0, calls: 0, failed: 0, tokens: emptyTokens(), cost: 0 },
  rows: {},
  noTool: { turns: 0, tokens: emptyTokens(), cost: 0 },
  unattr: { turns: 0, tokens: emptyTokens(), cost: 0 }
});
export const emptyDayBucket = () => ({ ...emptyBucketBase(), byKey: {} });
const emptyKeyBucket = () => emptyBucketBase();

export function normalizeToolName(raw) {
  const original = String(raw ?? '').trim();
  // 工具名可能带 MCP 前缀（mcp__snowluma__qq_send_message / mcp__web-search-safe__web_search）。
  const id = original.replace(/^mcp__[A-Za-z0-9-]+__/, '');
  const meta = TOOL_META[id];
  const group = meta?.group && TOOL_GROUPS[meta.group] ? meta.group : 'other';
  return { id, label: meta?.label ?? id, group, groupLabel: TOOL_GROUPS[group] ?? TOOL_GROUPS.other };
}

const byCallsDescNameAsc = (a, b) => (b.calls !== a.calls ? b.calls - a.calls : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// 按调用次数占比切成整数，余数全给排序第一个（保证可复现）。
function splitInteger(value, participants) {
  const totalCalls = participants.reduce((sum, item) => sum + item.calls, 0);
  const result = new Map(participants.map((item) => [item.id, 0]));
  if (!totalCalls || !value) return result;
  let used = 0;
  for (const item of participants) {
    const base = Math.floor((value * item.calls) / totalCalls);
    result.set(item.id, base);
    used += base;
  }
  result.set(participants[0].id, result.get(participants[0].id) + (value - used));
  return result;
}

// cost 分到 6 位小数，最后一项吸收舍入误差，保证 Σ == cost（误差 <1e-6）。
function splitCost(cost, participants) {
  const totalCalls = participants.reduce((sum, item) => sum + item.calls, 0);
  const result = new Map(participants.map((item) => [item.id, 0]));
  if (!totalCalls) return result;
  let used = 0;
  participants.forEach((item, index) => {
    if (index === participants.length - 1) result.set(item.id, round(cost - used, 6));
    else { const part = round((cost * item.calls) / totalCalls, 6); result.set(item.id, part); used += part; }
  });
  return result;
}

export function allocateTurnTokens(turnRow = {}, calls = []) {
  const tokens = tokensFromBuckets(turnRow?.buckets);
  const cost = num(turnRow?.cost);
  const list = Array.isArray(calls) ? calls : [];
  const unassigned = emptyToolTotals();
  const noTool = { turns: 0, tokens: emptyTokens(), cost: 0 };
  // 没调工具的一轮：整轮 token/cost 都进 noTool（用户看到的「闲聊/思考」成本）。
  if (!list.length) return { rows: {}, unassigned, noTool: { turns: 1, tokens, cost } };
  const per = new Map();
  for (const call of list) {
    const { id } = normalizeToolName(call?.tool ?? '');
    // 工具名为空（网关没给 tool 字段）：算「无法归属」，不硬塞进某个工具。
    if (!id) { unassigned.calls += 1; if (call?.failed) unassigned.failed += 1; continue; }
    const cur = per.get(id) ?? { id, calls: 0, failed: 0 };
    cur.calls += 1;
    if (call?.failed) cur.failed += 1;
    per.set(id, cur);
  }
  const participants = [...per.values()];
  if (unassigned.calls > 0) participants.push({ id: '', calls: unassigned.calls });
  participants.sort(byCallsDescNameAsc);
  const split = {
    prompt: splitInteger(tokens.prompt, participants),
    completion: splitInteger(tokens.completion, participants),
    cached: splitInteger(tokens.cached, participants)
  };
  const costs = splitCost(cost, participants);
  const rows = {};
  for (const item of participants) {
    if (!item.id) continue;
    const prompt = split.prompt.get(item.id) ?? 0;
    const completion = split.completion.get(item.id) ?? 0;
    rows[item.id] = {
      calls: item.calls, turns: 1, failed: item.failed ?? 0,
      tokens: { prompt, completion, cached: split.cached.get(item.id) ?? 0, total: prompt + completion },
      cost: costs.get(item.id) ?? 0
    };
  }
  if (unassigned.calls > 0) {
    const prompt = split.prompt.get('') ?? 0;
    const completion = split.completion.get('') ?? 0;
    unassigned.tokens = { prompt, completion, cached: split.cached.get('') ?? 0, total: prompt + completion };
    unassigned.cost = costs.get('') ?? 0;
  }
  return { rows, unassigned, noTool };
}

const cloneToolTotals = (row) => ({ calls: num(row?.calls), turns: num(row?.turns), failed: num(row?.failed), tokens: addTokens(emptyTokens(), row?.tokens), cost: num(row?.cost) });
function mergeToolTotals(target, extra) {
  target.calls += num(extra?.calls);
  target.turns += num(extra?.turns);
  target.failed += num(extra?.failed);
  addTokens(target.tokens, extra?.tokens);
  target.cost += num(extra?.cost);
  return target;
}
function cloneRows(rows) {
  const out = {};
  for (const [id, row] of Object.entries(rows ?? {})) out[id] = cloneToolTotals(row);
  return out;
}
function cloneBucketLike(bucket) {
  return {
    total: cloneToolTotals(bucket?.total),
    rows: cloneRows(bucket?.rows),
    noTool: { turns: num(bucket?.noTool?.turns), tokens: addTokens(emptyTokens(), bucket?.noTool?.tokens), cost: num(bucket?.noTool?.cost) },
    unattr: { turns: num(bucket?.unattr?.turns), tokens: addTokens(emptyTokens(), bucket?.unattr?.tokens), cost: num(bucket?.unattr?.cost) }
  };
}

function applyAllocation(bucket, allocation, turnCost, turnTokens) {
  const rows = allocation?.rows ?? {};
  const noTool = allocation?.noTool ?? { turns: 0, tokens: emptyTokens(), cost: 0 };
  const unassigned = allocation?.unassigned ?? emptyToolTotals();
  const tokens = turnTokens ?? emptyTokens();
  const cost = num(turnCost);
  bucket.total.turns += 1;
  bucket.total.cost += cost;
  addTokens(bucket.total.tokens, tokens);
  let attributedTokens = 0;
  let attributedCost = 0;
  for (const [id, row] of Object.entries(rows)) {
    bucket.rows[id] = mergeToolTotals(cloneToolTotals(bucket.rows[id]), row);
    bucket.total.calls += num(row?.calls);
    bucket.total.failed += num(row?.failed);
    attributedTokens += num(row?.tokens?.total);
    attributedCost += num(row?.cost);
  }
  if (num(noTool.turns) > 0) {
    bucket.noTool.turns += num(noTool.turns);
    addTokens(bucket.noTool.tokens, noTool.tokens);
    bucket.noTool.cost += num(noTool.cost);
    attributedTokens += num(noTool.tokens?.total);
    attributedCost += num(noTool.cost);
  }
  if (num(unassigned.calls) > 0) {
    bucket.total.calls += num(unassigned.calls);
    bucket.total.failed += num(unassigned.failed);
    attributedTokens += num(unassigned.tokens?.total);
    attributedCost += num(unassigned.cost);
  }
  // 分不掉的零头进 unattr：不是正常路径，但出现时必须看得见（写进报告而不是静默抹平）。
  const tokenDiff = num(tokens.total) - attributedTokens;
  const costDiff = cost - attributedCost;
  if (Math.abs(tokenDiff) > 1e-6 || Math.abs(costDiff) > 1e-6) {
    bucket.unattr.turns += 1;
    bucket.unattr.tokens.total += Math.max(0, tokenDiff);
    bucket.unattr.cost += Math.max(0, costDiff);
  }
  return bucket;
}

// 纯函数：返回新的一天桶（不改入参）。byKey[key] 是同一轮按群/会话拆出来的副本。
export function addTurnIntoDay(day, { key = '', allocation, turnCost = 0, turnTokens } = {}) {
  const src = day && typeof day === 'object' ? day : {};
  const base = { ...cloneBucketLike(src), byKey: {} };
  for (const [k, bucket] of Object.entries(src.byKey ?? {})) base.byKey[k] = cloneBucketLike(bucket);
  applyAllocation(base, allocation, turnCost, turnTokens);
  if (key) {
    const bucket = base.byKey[key] ?? emptyKeyBucket();
    applyAllocation(bucket, allocation, turnCost, turnTokens);
    base.byKey[key] = bucket;
  }
  return base;
}

export function aggregateToolDays(days, { fromMs = 0, toMs = 0, key = 'all' } = {}) {
  const list = Array.isArray(days) ? days : Object.values(days ?? {});
  const total = { turns: 0, calls: 0, failed: 0, tokens: emptyTokens(), cost: 0 };
  const rows = {};
  const noTool = { turns: 0, tokens: emptyTokens(), cost: 0 };
  const unattr = { turns: 0, tokens: emptyTokens(), cost: 0 };
  let usedDays = 0;
  for (const day of list) {
    const bucket = !key || key === 'all' ? day : day?.byKey?.[key] ?? null;
    if (!bucket) continue;
    if (num(bucket.total?.turns) > 0) usedDays += 1;
    mergeToolTotals(total, bucket.total);
    for (const [id, row] of Object.entries(bucket.rows ?? {})) rows[id] = mergeToolTotals(cloneToolTotals(rows[id]), row);
    noTool.turns += num(bucket.noTool?.turns);
    addTokens(noTool.tokens, bucket.noTool?.tokens);
    noTool.cost += num(bucket.noTool?.cost);
    unattr.turns += num(bucket.unattr?.turns);
    addTokens(unattr.tokens, bucket.unattr?.tokens);
    unattr.cost += num(bucket.unattr?.cost);
  }
  const totalTokens = num(total.tokens.total);
  const shareOf = (value) => (totalTokens > 0 ? round(value / totalTokens, 4) : 0);
  const norm = (id) => normalizeToolName(id);
  const tools = Object.entries(rows).map(([id, row]) => {
    const meta = norm(id);
    return {
      id, label: meta.label, group: meta.group, groupLabel: meta.groupLabel,
      calls: row.calls, turns: row.turns, failed: row.failed,
      tokens: addTokens(emptyTokens(), row.tokens), cost: round(row.cost, 6),
      share: shareOf(num(row.tokens?.total)),
      avgTokensPerTurn: row.turns > 0 ? round(num(row.tokens?.total) / row.turns, 2) : 0
    };
  }).sort((a, b) => (b.tokens.total - a.tokens.total) || (b.calls - a.calls) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const groupMap = new Map();
  for (const tool of tools) {
    const cur = groupMap.get(tool.group) ?? { group: tool.group, groupLabel: tool.groupLabel, tokens: emptyTokens(), cost: 0 };
    addTokens(cur.tokens, tool.tokens);
    cur.cost += num(tool.cost);
    groupMap.set(tool.group, cur);
  }
  const groups = [...groupMap.values()]
    .map((item) => ({ ...item, cost: round(item.cost, 6), share: shareOf(num(item.tokens.total)) }))
    .sort((a, b) => (b.tokens.total - a.tokens.total) || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
  let sumTokens = num(noTool.tokens.total) + num(unattr.tokens.total);
  let sumCost = num(noTool.cost) + num(unattr.cost);
  for (const tool of tools) { sumTokens += num(tool.tokens.total); sumCost += num(tool.cost); }
  const tokenDiff = round(num(total.tokens.total) - sumTokens, 6);
  const costDiff = round(num(total.cost) - sumCost, 6);
  const mismatch = Math.abs(tokenDiff) > 1e-6 || Math.abs(costDiff) > 1e-6 ? { tokenDiff, costDiff } : null;
  return {
    range: { from: num(fromMs), to: num(toMs), days: usedDays },
    total: { turns: total.turns, calls: total.calls, failed: total.failed, tokens: addTokens(emptyTokens(), total.tokens), cost: round(total.cost, 6) },
    noTool: { turns: noTool.turns, tokens: addTokens(emptyTokens(), noTool.tokens), cost: round(noTool.cost, 6), share: shareOf(num(noTool.tokens.total)) },
    unattr: { turns: unattr.turns, tokens: addTokens(emptyTokens(), unattr.tokens), cost: round(unattr.cost, 6), share: shareOf(num(unattr.tokens.total)) },
    tools, groups, mismatch
  };
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayStartOf = (dateKey) => { const ms = Date.parse(`${dateKey}T00:00:00.000Z`); return Number.isFinite(ms) ? ms : null; };

export function normalizeToolToolsStore(raw, { now = Date.now() } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawDays = src.days && typeof src.days === 'object' && !Array.isArray(src.days) ? src.days : {};
  const cutoff = num(now) > 0 ? num(now) - TOKEN_DAY_LIMIT * DAY_MS : 0;
  // 只留最近 60 天：按日期键倒序取前 60，给了 now 再按时间窗裁一刀（防未来/上古脏键）。
  const kept = Object.entries(rawDays)
    .filter(([dateKey, day]) => DAY_KEY_RE.test(dateKey) && day && typeof day === 'object')
    .filter(([dateKey]) => {
      if (!cutoff) return true;
      const start = dayStartOf(dateKey);
      return start !== null && start >= cutoff;
    })
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .slice(0, TOKEN_DAY_LIMIT);
  const days = {};
  for (const [dateKey, day] of kept) {
    const bucket = { ...cloneBucketLike(day), byKey: {} };
    for (const [k, value] of Object.entries(day.byKey ?? {})) bucket.byKey[k] = cloneBucketLike(value);
    days[dateKey] = bucket;
  }
  return { version: 1, days };
}
