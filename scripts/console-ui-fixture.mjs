#!/usr/bin/env node
/** Offline console preview. No production modules, credentials, state, or network clients are loaded. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roleCharStats, roleSectionReport } from '../src/role-card.js';
import { pickBucketMs } from '../src/token-ledger.js';
import { manualDirCommand } from '../src/state-acl.mjs';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timestamp = '2026-09-20T08:30:00.000Z';

// GET /api/dsh/models 的假清单（施工 A 的接口形状）：故意只给 3 个，方便验证「不在清单里就拒绝」。
// 其中一个带区域前缀 workbuddy2api/deepseek-v4.1-flash，用来区分 provider/model 的拼接口径。
function fixtureModels() {
  return [
    { provider: 'deepseek-official', model: 'deepseek-flash', name: 'Flash' },
    { provider: 'deepseek-official', model: 'deepseek-pro', name: 'Pro' },
    { provider: 'workbuddy2api', model: 'deepseek-v4.1-flash' },
  ];
}

// 预设状态：mock 直接复用真实字段口径，避免与 bridge.js 漂移。
function presetStatusFixture(preset) {
  return {
    preset,
    label: preset === 'qq-chat' ? '一代仿真（reserved）' : '二代仿真（reserved2）',
    sourceFile: `dsh/agent-presets/${preset}/agent.cordis.yml`,
    installed: true,
    requiresRestart: true,
  };
}

// ── 令牌与花费：离线示例数据 ──────────────────────────────────────────────
// 字段口径与 src/token-ledger.js 的 summary()/conversation()/recent() 保持一致，
// 这样控制台渲染路径在离线预览与真实环境走的是同一套形状。
const USAGE_SYMBOL = '¥';
const USAGE_PRICE_TABLE = {
  version: '2026-11-04',
  currency: 'CNY',
  symbol: USAGE_SYMBOL,
  unit: 1e6,
  peakMultiplier: 2,
  peakWindows: [[9, 12], [14, 18]],
  peakWeekdays: [1, 2, 3, 4, 5],
  holidayCount: 33,
  models: {
    'deepseek-flash': { label: 'DeepSeek-V4.1-Flash', off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 } },
    'deepseek-v4-pro': { label: 'DeepSeek-V4-Pro-0813', off: { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 } },
  },
};

function usageConversationFixture(key, buckets, cost, turns, steps, unattributed = 0) {
  const input = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite;
  return {
    key,
    sessionIds: [`fixture-session-${key.replace(/\W/g, '')}`],
    sessions: 1,
    buckets,
    cost,
    unattributedCost: unattributed,
    attributedCost: cost - unattributed,
    byTier: { peak: cost * 0.4, off: cost * 0.6 },
    turns,
    steps,
    estimated: false,
    lastAt: Date.parse(timestamp),
    firstAt: Date.parse(timestamp) - 3600_000,
    models: ['deepseek-flash'],
    cacheHitRate: input > 0 ? buckets.cacheHit / input : 0,
  };
}

function usageSummaryFixture() {
  const conversations = [
    usageConversationFixture('group:123456789', { cacheMiss: 41230, cacheHit: 1284000, cacheWrite: 0, output: 18420, reasoning: 0 }, 0.2886, 42, 231),
    usageConversationFixture('private:100001', { cacheMiss: 8600, cacheHit: 210400, cacheWrite: 0, output: 3900, reasoning: 0 }, 0.0467, 9, 48),
    usageConversationFixture('internal:黑话学习', { cacheMiss: 2200, cacheHit: 18000, cacheWrite: 0, output: 900, reasoning: 0 }, 0.0075, 3, 11),
  ];
  const buckets = conversations.reduce((acc, c) => ({
    cacheMiss: acc.cacheMiss + c.buckets.cacheMiss,
    cacheHit: acc.cacheHit + c.buckets.cacheHit,
    cacheWrite: acc.cacheWrite + c.buckets.cacheWrite,
    output: acc.output + c.buckets.output,
    reasoning: 0,
  }), { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 });
  const cost = conversations.reduce((acc, c) => acc + c.cost, 0);
  const input = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite;
  const turns = conversations.reduce((acc, c) => acc + c.turns, 0);
  const steps = conversations.reduce((acc, c) => acc + c.steps, 0);
  return {
    ok: true,
    generatedAt: Date.parse(timestamp),
    priceVersion: USAGE_PRICE_TABLE.version,
    currency: 'CNY',
    symbol: USAGE_SYMBOL,
    nowTier: { model: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', tier: 'off', tierLabel: '空闲时段', estimated: false },
    priceTable: USAGE_PRICE_TABLE,
    totals: {
      buckets,
      cost,
      attributedCost: cost - 0.02,
      unattributedCost: 0.02,
      byTier: { peak: cost * 0.4, off: cost * 0.6 },
      turns,
      steps,
      conversations: conversations.length,
      estimated: false,
      totalTokens: buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite + buckets.output,
      inputTokens: input,
      cacheHitRate: input > 0 ? buckets.cacheHit / input : 0,
      avgCostPerTurn: cost / turns,
      avgCostPerStep: cost / steps,
    },
    conversations,
    ledger: { file: '(fixture)', journalLines: 0, maxLines: 20000, droppedLines: 0, sessions: 3, baselines: 3, samples: steps, lastIngestAt: Date.parse(timestamp), lastCompactedAt: 0, priceVersion: USAGE_PRICE_TABLE.version },
  };
}

// 走势图示例数据：24 小时 × 30 分钟 = 48 格，故意留出空白时段。
// 峰谷档位按**真实规则**推算（周一至周五 9:00-12:00、14:00-18:00 为高峰），
// 这样示例图看起来和真实使用一致（两条高峰带），而不是人为交替的噪点。
function usageSeriesFixture(hoursRaw) {
  const hours = [24, 72, 168, 720].includes(Number(hoursRaw)) ? Number(hoursRaw) : 24;
  // 桶宽用**生产同一套阶梯**（从 token-ledger 导出），避免预览与线上粒度不一致。
  const bucketMs = pickBucketMs(hours * 3600 * 1000, 48);
  // 走势图的锚点固定在一个**工作日**：fixture 的 timestamp 落在周日，按真实峰谷规则
  // 算出来整条图都是空闲色，示例数据就永远看不到高峰带（离线预览也就失去意义）。
  // 锚点固定也让截图/断言可复现。
  const anchor = Date.parse('2026-09-16T08:30:00.000Z'); // 周三
  const end = Math.floor(anchor / bucketMs) * bucketMs + bucketMs;
  const start = end - Math.ceil((hours * 3600 * 1000) / bucketMs) * bucketMs;
  const count = Math.round((end - start) / bucketMs);
  const isPeakHour = (ms) => {
    const d = new Date(ms);
    const day = d.getDay();
    if (day === 0 || day === 6) return false;
    const h = d.getHours();
    return (h >= 9 && h < 12) || (h >= 14 && h < 18);
  };
  // 档位要**扫完整个桶**，不能只看首尾：12 小时的桶完全可能把 9:00-12:00 整段包在
  // 中间，而两端都在空闲区（首尾采样法会把它误判成「空闲」）。
  const tierOfBucket = (t) => {
    let sawPeak = false;
    let sawOff = false;
    for (let ms = t; ms < t + bucketMs; ms += Math.min(bucketMs, 30 * 60 * 1000)) {
      if (isPeakHour(ms)) sawPeak = true; else sawOff = true;
      if (sawPeak && sawOff) return 'mixed';
    }
    return sawPeak ? 'peak' : 'off';
  };
  const buckets = [];
  // 桶内按 30 分钟小格累加，而不是"只看桶起点那一小时"：
  // 粗桶（如 24 小时）起点可能落在深夜，只看起点会让整条 30 天视图全是 0。
  // 累加也更接近真账本的行为（一个桶 = 该时段所有采样之和）。
  const subStepMs = Math.min(bucketMs, 30 * 60 * 1000);
  for (let i = 0; i < count; i += 1) {
    const t = start + i * bucketMs;
    let cacheMiss = 0;
    let cacheHit = 0;
    let output = 0;
    let cost = 0;
    let turns = 0;
    let steps = 0;
    for (let ms = t; ms < t + bucketMs; ms += subStepMs) {
      const hour = new Date(ms).getHours();
      if (hour < 9 || hour > 23) continue; // 深夜为 0，图上有明显的空白段
      const wave = (Math.sin((ms - start) / (3 * subStepMs)) + 1) / 2;
      const cm = Math.round(300 + wave * 1800);
      const ch = Math.round(6000 + wave * 42000);
      const out = Math.round(60 + wave * 400);
      const sub = (cm / 1e6) * 1 + (ch / 1e6) * 0.02 + (out / 1e6) * 4;
      cacheMiss += cm;
      cacheHit += ch;
      output += out;
      cost += isPeakHour(ms) ? sub * 2 : sub; // 高峰单价 ×2，逐格判定
      turns += 1;
      steps += 3 + (Math.floor(ms / subStepMs) % 5);
    }
    buckets.push({
      t,
      cost,
      tokens: cacheMiss + cacheHit + output,
      cacheMiss,
      cacheHit,
      cacheWrite: 0,
      output,
      turns,
      steps,
      tier: tierOfBucket(t),
      keys: steps > 0 ? ['group:123456789'] : [],
    });
  }
  const totals = buckets.reduce((acc, b) => ({
    cost: acc.cost + b.cost,
    tokens: acc.tokens + b.tokens,
    turns: acc.turns + b.turns,
    steps: acc.steps + b.steps,
  }), { cost: 0, tokens: 0, turns: 0, steps: 0 });
  const busiest = buckets.reduce((best, b) => (!best || b.cost > best.cost ? b : best), null);
  return {
    ok: true,
    generatedAt: Date.parse(timestamp),
    currency: 'CNY',
    symbol: USAGE_SYMBOL,
    hours,
    bucketMs,
    from: start,
    to: end,
    buckets,
    totals,
    busiest: busiest ? { t: busiest.t, cost: busiest.cost, tokens: busiest.tokens } : null,
    estimated: false,
    countedSamples: buckets.reduce((n, b) => n + b.steps, 0),
    offChartCost: 0.02,
    offChartTokens: 18000,
  };
}

function usageTurnsFixture(key) {
  const target = key || 'group:123456789';
  const base = Date.parse(timestamp);
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    const buckets = { cacheMiss: 900 + i * 120, cacheHit: 32000 + i * 800, cacheWrite: 0, output: 420 + i * 30, reasoning: 0 };
    rows.push({
      sessionId: `fixture-session-${target.replace(/\W/g, '')}`,
      key: target,
      turn: 42 - i,
      steps: 4 + (i % 3),
      attempts: i === 2 ? 1 : 0,
      startedAt: base - (i + 1) * 600_000,
      endedAt: base - i * 600_000,
      model: 'deepseek-flash',
      provider: 'deepseek-official',
      buckets,
      cost: (buckets.cacheMiss / 1e6) * 1 + (buckets.cacheHit / 1e6) * 0.02 + (buckets.output / 1e6) * 4,
      tier: i === 1 ? 'peak' : (i === 4 ? 'mixed' : 'off'),
    });
  }
  const cost = rows.reduce((acc, t) => acc + t.cost, 0);
  return {
    ok: true,
    generatedAt: base,
    currency: 'CNY',
    symbol: USAGE_SYMBOL,
    key: target,
    sessionIds: [`fixture-session-${target.replace(/\W/g, '')}`],
    sessions: 1,
    steps: rows.reduce((acc, t) => acc + t.steps, 0),
    cost,
    attributedCost: cost,
    unattributedCost: 0.0123,
    buckets: rows.reduce((acc, t) => ({
      cacheMiss: acc.cacheMiss + t.buckets.cacheMiss,
      cacheHit: acc.cacheHit + t.buckets.cacheHit,
      cacheWrite: 0,
      output: acc.output + t.buckets.output,
      reasoning: 0,
    }), { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 }),
    byTier: { peak: cost * 0.3, off: cost * 0.7 },
    estimated: false,
    models: ['deepseek-flash'],
    turnLimit: 200,
    // 与 src/token-ledger.js 的 conversation() 一致：`turns` 是**数组**（不是条数）。
    turns: rows,
  };
}

function usageRecentFixture() {
  const base = Date.parse(timestamp);
  const rows = [];
  for (let i = 0; i < 8; i += 1) {
    rows.push({
      time: base - i * 45_000,
      key: i % 3 === 2 ? 'private:100001' : 'group:123456789',
      sessionId: 'fixture-session',
      turn: 42 - Math.floor(i / 4),
      step: 1 + (i % 4),
      retry: 0,
      model: 'deepseek-flash',
      tokens: 34000 + i * 500,
      cacheMiss: 820 + i * 40,
      cacheHit: 33000 + i * 400,
      cacheWrite: 0,
      output: 260 + i * 12,
      reasoning: 0,
      cost: 0.0021 + i * 0.0001,
      tier: i === 3 ? 'peak' : 'off',
      estimated: false,
    });
  }
  return rows;
}

export function makeFixtureState() {
  return {
    mode: 'reserved2', role: '小鲸鱼', roleMode: 'active', closedAgentPreset: '', paused: false,
    roles: ['小鲸鱼', '温柔助手', '技术伙伴'],
    roleContents: {
      小鲸鱼: '# 小鲸鱼\n\n- 性格：好奇、爱接梗，遇到不懂的会直接问\n- 说话风格：简短，偶尔用 emoji',
      温柔助手: '# 温柔助手\n\n- 性格：温和、有耐心\n- 说话风格：先共情再回答',
      技术伙伴: '# 技术伙伴\n\n- 性格：直接、爱讲原理\n- 说话风格：先给结论再解释',
    },
    simPrompts: {
      'qq-chat-v2': '你是 QQ 群里的仿真群友。\n\n【二代仿真模式 —— 安全规则（最高优先级，不可违反）】\n1. 你没有本地工具。\n\n【二代仿真模式 —— 工具协议（最高优先级）】\n1. 文本输出不会自动发送到 QQ。',
      'qq-chat': '你是 QQ 群里的仿真群友（一代）。\n\n【一代仿真模式 —— 安全规则】\n1. 你没有本地工具。\n\n【一代仿真模式 —— 工具协议】\n1. 回复会自动转发到 QQ。',
    },
    roleInjectMax: 8000,
    dshEffort: 'max',
    // GET /api/model 的假状态：本地兜底三分支（未启用 / 待命 / 接管中）靠 /__fixture/local 切换
    model: { provider: 'deepseek-official', model: 'deepseek-flash', degraded: false, fallbacks: ['deepseek-official/deepseek-pro'] },
    local: { enabled: false, active: false, since: 0, model: 'qwen2.5:7b-instruct', baseUrl: 'http://127.0.0.1:11434/v1', ok: 0, fail: 0 },
    whitelist: { allow: { groups: [123456789, 100003], private: [100001] }, deny: { groups: [], private: [] }, ownerQQ: '100001' },
    sessions: [
      { key: 'group:123456789', sessionId: 'demo-community-20260920', owner: false },
      { key: 'group:100003', sessionId: 'demo-development-20260920', owner: false },
      { key: 'private:100001', sessionId: 'demo-owner-20260920', owner: true },
    ],
    social: {
      triggerProbability: 0.2, activeCheckMinMs: 10000, activeCheckMaxMs: 30000,
      activeReplyDelayMinMs: 1000, activeReplyDelayMaxMs: 3000, activeDurationEnabled: true,
      activeDurationMinMs: 180000, activeDurationMaxMs: 600000, idleWindowMs: 300000,
      idleRetryProbability: 0.4, idleRetryWaitMs: 120000, skipProbability: 0.15,
      surrenderProbability: 0.08, contextWindow: 20, maxReplyChars: 500,
      burstEnabled: true, burstIntervalMinMs: 1000, burstIntervalMaxMs: 3000,
      longGapProbability: 0.1, longGapMinMs: 2500, longGapMaxMs: 5000,
      mustReplyKeywords: ['小鲸鱼', 'DeepSeek'], proactiveEnabled: true,
      proactiveIdleThresholdMs: 1800000, proactiveCheckMinMs: 300000,
      proactiveCheckMaxMs: 900000, proactiveProbability: 0.2,
    },
    socialStates: { 'group:123456789': { phase: 'active' }, 'group:100003': { phase: 'idle' } },
    v2: { enabled: true, agentPreset: 'qq-chat-v2', provideRecommendations: true, tools: {} },
    // 会话初始提示词（离线示例）：整段内容都是虚构的演示文本。
    initPrompt: '离线示例：这是一个演示用的群聊环境说明，不会写进任何真实配置。',
    slangConfig: { enabled: true, extractMinMessages: 10, extractCooldownMs: 300000, inferenceThresholds: [1, 3, 6], researchChunkSize: 5, researchTimeoutMs: 300000, injectMax: 8, learnerPreset: 'qq-chat', workspaceTitle: 'QQ 黑话学习', autoResearch: true, autoConfirmWeb: true },
    slang: [
      // basis 演示三种释义来源：web=联网确认，context=语境推断，缺省=无标注
      { id: 'demo-candidate', content: '有被治愈到', meaning: '感到温暖和安慰', status: 'candidate', count: 4, source: 'auto', basis: 'context', evidence: [{ sender: '演示群友', text: '今天这张图，有被治愈到。' }], createdAt: timestamp, updatedAt: timestamp },
      { id: 'demo-confirmed', content: '绝绝子', meaning: '很好、很棒', usage: '表达赞美', example: '这个设计绝绝子。', status: 'confirmed', count: 12, source: 'manual', basis: 'web', createdAt: timestamp, updatedAt: timestamp },
      { id: 'demo-rejected', content: '测试噪声', meaning: '', risk: '演示排除项', status: 'rejected', count: 1, source: 'auto', createdAt: timestamp, updatedAt: timestamp },
    ],
    security: { interceptNotify: true },
    // state/ 的 ACL 是否已收紧。离线演示默认给「未收紧」，这样告警条在预览里可见
    // （真实场景：Windows 上未以管理员身份运行桥接时就是这个状态）。
    hardenStateDir: false,
    toolLog: [
      { time: timestamp, key: 'group:123456789', tool: 'qq_get_recent_messages', type: 'call', args: JSON.stringify({ key: 'group:123456789', limit: 20 }) },
      { time: timestamp, key: 'group:123456789', tool: 'qq_get_recent_messages', type: 'result', ok: true },
    ],
    feedback: [{ time: timestamp, level: 'info', message: '这是离线演示反馈。' }],
  };
}

/**
 * 故障注入：把「接口失败时界面会怎样」变成可回归测试。
 *   FIXTURE_FAIL="api/slang:500,api/sessions:badjson,api/status:timeout"
 *   FIXTURE_FAIL_MODE=500|badjson|timeout|empty   （未写 :mode 的条目用这个默认值）
 *   FIXTURE_FAIL_DELAY_MS=300                     （timeout 模式先等这么久再回 504）
 * 命中规则：请求路径「包含」配置里的片段（例如 'api/slang' 命中 /api/slang 与 /api/slang/xxx）。
 */
const FAIL_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
export function parseFailSpec(raw, defaultMode = '500') {
  const out = [];
  for (const part of String(raw || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    // 支持「方法:路径:模式」，例如 PATCH:api/slang:500 —— 只让撤销（PATCH）失败，批量写入照常
    const segs = part.split(':').map((x) => String(x || '').trim());
    let method = null;
    if (segs.length >= 3 && FAIL_METHODS.includes(segs[0].toUpperCase())) {
      method = segs[0].toUpperCase();
      segs.shift();
    }
    const fragment = segs[0] || '';
    if (!fragment) continue;
    const mode = ['404', '500', 'badjson', 'timeout', 'empty'].includes(segs[1] || '') ? segs[1] : defaultMode;
    out.push({ fragment, mode, method });
  }
  return out;
}

/** Bind only to loopback. Mutations affect this server's disposable in-memory state. */
export async function startConsoleFixture({ port = 0, original = false, htmlPath, logWrites = false, fail = process.env.FIXTURE_FAIL, failMode = process.env.FIXTURE_FAIL_MODE || '500', failDelayMs = Number(process.env.FIXTURE_FAIL_DELAY_MS) || 300 } = {}) {
  const file = htmlPath || resolve(projectRoot, original ? 'scripts/fixtures/console.before.html' : 'public/client.html');
  await readFile(file); // Fail early rather than displaying a broken preview.
  const state = makeFixtureState();
  const failSpec = parseFailSpec(fail, failMode);
  const requests = [];
  const unknownRequests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method || 'GET';
    const json = (value, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    // 故障注入优先于一切真实路由（静态页与 fixture 控制口除外，否则连测试脚本都起不来）
    const failHit = path.startsWith('/__fixture/')
      ? null
      : failSpec.find((x) => path.includes(x.fragment) && (!x.method || x.method === method));
    if (failHit) {
      requests.push({ method, path, injected: failHit.mode });
      if (failHit.mode === 'badjson') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{ "ok": true, <<< 这不是合法 JSON');
        return;
      }
      if (failHit.mode === '404') {
        json({ ok: false, error: '未找到（fixture 注入）' }, 404);
        return;
      }
      if (failHit.mode === 'empty') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': '0' });
        res.end();
        return;
      }
      if (failHit.mode === 'timeout') {
        await new Promise((r) => setTimeout(r, failDelayMs));
        json({ ok: false, error: '网关超时（fixture 注入）' }, 504);
        return;
      }
      json({ ok: false, error: '内部错误（fixture 注入）' }, 500);
      return;
    }
    try {
      if (method === 'GET' && ['/', '/client', '/client.html'].includes(path)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "connect-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self' blob: data:; object-src 'none'" });
        res.end(await readFile(file));
        return;
      }
      if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      // client.html 只有 <link href="/client.css"> 和 <script src="/client.js">，本 fixture 以前只 serve HTML，
      // 离线预览因此白屏。assets 直接从 public/ 读，不复制第二份（避免预览与真实页面漂移）。
      if (method === 'GET' && (path === '/client.js' || path === '/client.css' || path === '/changelog.js' || path === '/bgm/default-tune.mp3' || path === '/bgm/haloflux-sw421k.mp3' || path === '/bgm/HALOFLUX-LICENSE.txt')) {
        const asset = path === '/client.js' ? 'client.js'
          : (path === '/client.css' ? 'client.css'
            : (path === '/changelog.js' ? 'changelog.js' : (path === '/bgm/haloflux-sw421k.mp3' ? 'bgm/haloflux-sw421k.mp3' : (path === '/bgm/HALOFLUX-LICENSE.txt' ? 'bgm/HALOFLUX-LICENSE.txt' : 'bgm/default-tune.mp3'))));
        const type = path === '/client.css' ? 'text/css; charset=utf-8'
          : (path === '/bgm/haloflux-sw421k.mp3' ? 'audio/mpeg' : (path === '/bgm/HALOFLUX-LICENSE.txt' ? 'text/plain; charset=utf-8' : (path === '/bgm/default-tune.mp3' ? 'audio/mpeg' : 'text/javascript; charset=utf-8')));
        try {
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
          res.end(await readFile(resolve(projectRoot, 'public', asset)));
        } catch {
          json({ ok: false, error: asset + ' 不存在' }, 404);
        }
        return;
      }
      if (method === 'GET' && path === '/__fixture/requests') return json({ requests, unknownRequests });
      if (method === 'GET' && path === '/__fixture/info') return json({ offline: true, htmlPath: file });
      if (!path.startsWith('/api/')) {
        // fixture 专用控制口：脚本/手工都能把「未启用 / 待命 / 接管中」三种本地兜底造出来
        if (path === '/__fixture/stickers' && method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let sBody = {};
          try { sBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { sBody = {}; }
          state.stickers = Object.assign({ mode: 'ok' }, state.stickers || {}, sBody);
          return json({ ok: true, stickers: state.stickers });
        }
        if (path === '/__fixture/observe' && method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let oBody = {};
          try { oBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { oBody = {}; }
          state.observe = Object.assign({ enabled: false, groups: ['100000001'], learnSlang: true, learnStickers: true }, state.observe || {}, oBody);
          return json({ ok: true, observe: state.observe });
        }
        if (path === '/__fixture/routing' && method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let rBody = {};
          try { rBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { rBody = {}; }
          state.routing = Object.assign({ mode: 'ok' }, state.routing || {}, rBody);
          return json({ ok: true, routing: state.routing });
        }
        if (path === '/__fixture/models' && method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let mBody = {};
          try { mBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { mBody = {}; }
          state.models = Object.assign({ mode: 'ok' }, state.models || {}, mBody);
          return json({ ok: true, models: state.models });
        }
        if (path === '/__fixture/peak' && method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let pBody = {};
          try { pBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { pBody = {}; }
          state.peak = Object.assign({ mode: 'ok' }, state.peak || {}, pBody);
          return json({ ok: true, peak: state.peak });
        }
        if (path === '/__fixture/library' && method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let lBody = {};
          try { lBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { lBody = {}; }
          state.library = Object.assign({ mode: 'ok' }, state.library || {}, lBody);
          return json({ ok: true, library: state.library });
        }
        if (path === '/__fixture/files' && method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let fBody = {};
          try { fBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { fBody = {}; }
          state.files = Object.assign({ mode: 'ok', byGroup: 'array' }, state.files || {}, fBody);
          return json({ ok: true, files: state.files });
        }
        if (path === '/__fixture/vision' && method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let vBody = {};
          try { vBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { vBody = {}; }
          state.vision = Object.assign({ mode: 'supported' }, state.vision || {}, vBody);
          return json({ ok: true, vision: state.vision });
        }
        if (path === '/__fixture/imagegen-quota' && method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let qBody = {};
          try { qBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { qBody = {}; }
          state.imagegenQuota = Object.assign({ mode: 'ok', remaining: 23, limit: 30, used: 7 }, state.imagegenQuota || {}, qBody);
          return json({ ok: true, quota: state.imagegenQuota });
        }
        if (path === '/__fixture/storage' && method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let stBody = {};
          try { stBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { stBody = {}; }
          state.storage = Object.assign({ mode: 'ok' }, state.storage || {}, stBody);
          return json({ ok: true, storage: state.storage });
        }
        if (path === '/__fixture/gateway' && method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let gwBody = {};
          try { gwBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { gwBody = {}; }
          state.gateway = Object.assign({ mode: 'ok' }, state.gateway || {}, gwBody);
          return json({ ok: true, gateway: state.gateway });
        }
        if (path === '/__fixture/draw' && method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let drawBody = {};
          try { drawBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { drawBody = {}; }
          state.draw = Object.assign({ mode: 'ok', waitSec: 12 }, state.draw || {}, drawBody);
          return json({ ok: true, draw: state.draw });
        }
        if (path === '/__fixture/usage' && method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let usageBody = {};
          try { usageBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { usageBody = {}; }
          state.usageInconsistent = usageBody.inconsistent === true;
          return json({ ok: true, inconsistent: state.usageInconsistent });
        }
        if (path === '/__fixture/local' && method === 'POST') {
          // 这里在 /api/ 分流之前，没有共用的 readBody()，就地读一次
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let localBody = {};
          try { localBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { localBody = {}; }
          Object.assign(state.local, localBody);
          return json({ ok: true, local: state.local });
        }
        return json({ ok: false, error: 'Offline fixture route not found' }, 404);
      }

      let body = {};
      if (method !== 'GET') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        requests.push({ method, path, body });
        if (logWrites) console.log(`[mock write] ${method} ${path} ${JSON.stringify(body)}`);
      }
      if (method === 'GET') {
        switch (path) {
          case '/api/files/enrich': {
            return json({ ok: true, enriched: Array.isArray(body.ids) ? body.ids.length : 1, failed: 0 });
          }
          case '/api/files/cleanup': {
            const mode = (state.files && state.files.mode) || 'ok';
            if (mode === 'missing') return json({ ok: false, error: '消息库不可用，无法清理' }, 503);
            return json({ ok: true, checkedAt: Date.now(), deleted: 2, bytes: 1048576, missing: 0, failed: 0 });
          }
          case '/api/files/category': {
            const mode = (state.files && state.files.mode) || 'ok';
            if (mode === 'missing') return json({ ok: false, error: '消息库不可用' }, 503);
            const id = Number(body.id);
            if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: 'id 必须是正整数' }, 400);
            if (typeof body.category !== 'string') return json({ ok: false, error: 'category 必须是字符串（空串=未分类）' }, 400);
            return json({ ok: true, id, category: String(body.category).trim(), cleanupAt: 1793078400000 });
          }
          case '/api/status': return json({ ok: true, dshReady: true, mode: state.mode, role: state.role, roleMode: state.roleMode, closedAgentPreset: state.closedAgentPreset, ownerQQ: state.whitelist.ownerQQ, allowGroups: state.whitelist.allow.groups, allowPrivate: state.whitelist.allow.private, activity: '[08:30:00] 演示桥接已连接\n[08:30:12] group:123456789 · 已处理一条消息\n[08:30:20] 二代社交助手正在运行\n以上均为离线模拟数据。',
      peakLocal: (state.peak && state.peak.localMissing) ? undefined : {
        enabled: true,
        model: 'xiaomi-mimo/mimo-v2.6-pro',
        repliesLastHour: 12,
        avgMs: 1830,
        lastReplyAt: 1792991400000,
        lastReplyText: '这首《夜に駆ける》我也很喜欢，副歌那段转音真的很上头，你平时还听 YOASOBI 的哪些歌？',
      } });
          case '/api/presets': return json({ presets: [{ id: 'qq-chat-v2', trust: 'user' }, { id: 'qq-chat', trust: 'user' }] });
          case '/api/roles': return json({
            roles: state.roles.slice(),
            summaries: state.roles.map((name) => {
              const content = state.roleContents[name] ?? '';
              const stats = roleCharStats(content);
              const injectMax = state.roleInjectMax;
              return {
                name,
                bytes: Buffer.byteLength(content, 'utf8'),
                chars: content.length,
                lines: content.split('\n').length,
                mtime: Date.parse(timestamp),
                excerpt: content.split('\n').find((line) => line.trim() && !line.trim().startsWith('#')) ?? '',
                injectedV1: Math.min(stats.v1, injectMax),
                injectedV2: Math.min(stats.v2, injectMax),
                charsV1: stats.v1,
                charsV2: stats.v2,
                hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
                truncated: stats.v1 > injectMax || stats.v2 > injectMax,
                warnings: 0,
              };
            }),
            current: state.role,
            limits: { nameMax: 40, contentMaxBytes: 65536, injectMaxChars: state.roleInjectMax },
          });
          case '/api/roles/content': {
            const name = url.searchParams.get('name') ?? '';
            if (!state.roleContents[name]) return json({ ok: false, error: `人格「${name}」不存在` }, 404);
            const content = state.roleContents[name];
            return json({
              ok: true,
              name,
              content,
              chars: content.length,
              bytes: Buffer.byteLength(content, 'utf8'),
              warnings: [],
              limits: { injectMaxChars: state.roleInjectMax },
              stats: roleCharStats(content),
              sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
            });
          }
          case '/api/preset/sim-prompt': {
            const preset = url.searchParams.get('preset') === 'qq-chat' ? 'qq-chat' : 'qq-chat-v2';
            return json({
              ok: true,
              content: state.simPrompts[preset],
              chars: state.simPrompts[preset].length,
              bytes: Buffer.byteLength(state.simPrompts[preset], 'utf8'),
              warnings: [],
              status: presetStatusFixture(preset),
              presets: [presetStatusFixture('qq-chat'), presetStatusFixture('qq-chat-v2')],
            });
          }
          case '/api/preset/sim-prompt/backups': {
            const preset = url.searchParams.get('preset') === 'qq-chat' ? 'qq-chat' : 'qq-chat-v2';
            return json({ ok: true, backups: [{ file: `${preset}.agent.cordis.yml.fixture`, mtime: Date.parse(timestamp) }] });
          }
          case '/api/model-routing': {
            const mode = (state.routing && state.routing.mode) || 'ok';
            if (mode === 'missing') return json({ ok: false, error: '未找到' }, 404);
            const emptyOptions = mode === 'emptyOptions';
            return json({
              ok: true,
              peakPause: {
                enabled: true,
                schedule: { peak: [[9, 12], [14, 18]] },
                windows: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
                inWindow: true,
                active: false,
              },
              routing: {
                idle: { provider: 'deepseek-account', model: 'deepseek-flash' },
                peak: { provider: 'xiaomi-mimo', model: 'mimo-v2.6-flash' },
                fallback: [
                  { provider: 'workbuddy2api', model: 'deepseek-v4-pro' },
                ],
                disabled: [
                  { provider: 'workbuddy2api', model: 'glm-5.3' },
                ],
              },
              effective: { provider: 'xiaomi-mimo', model: 'mimo-v2.6-flash', source: 'peak' },
              options: emptyOptions ? [] : [
                { provider: 'deepseek-account', model: 'deepseek-flash', label: 'DeepSeek Flash（官方，便宜快）' },
                { provider: 'xiaomi-mimo', model: 'mimo-v2.6-pro', label: 'MiMo v2.6 Pro（高峰 agent）' },
                { provider: 'xiaomi-mimo', model: 'mimo-v2.6-flash', label: 'MiMo v2.6 Flash（高峰 agent）' },
                { provider: 'workbuddy2api', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro（中转，强）' },
                { provider: 'workbuddy2api', model: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash（中转，快）' },
                { provider: 'workbuddy2api', model: 'glm-5.3', label: 'GLM-5.3（中转）' },
                { provider: 'deepseek-account', model: 'deepseek-reasoner', label: 'DeepSeek Reasoner（官方）' },
              ],
              catalog: { total: 5 },
              note: '下一轮生效，无需重启',
            });
          }
          case '/api/models': {
            const mode = (state.models && state.models.mode) || 'ok';
            if (mode === 'missing') return json({ ok: false, error: '未找到' }, 404);
            const options = mode === 'emptyOptions' ? [] : [
              { provider: 'deepseek-account', model: 'deepseek-flash', label: 'DeepSeek Flash（官方，便宜快）' },
              { provider: 'xiaomi-mimo', model: 'mimo-v2.6-pro', label: 'MiMo v2.6 Pro（高峰 agent）' },
              { provider: 'xiaomi-mimo', model: 'mimo-v2.6-flash', label: 'MiMo v2.6 Flash（高峰 agent）' },
              { provider: 'workbuddy2api', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro（中转，强）' },
            ];
            const scopes = mode === 'noScopes' ? undefined : {
              main: { provider: 'deepseek-account', model: 'deepseek-flash' },
              peak: { provider: 'xiaomi-mimo', model: 'mimo-v2.6-flash' },
              media: { provider: 'deepseek-account', model: 'deepseek-flash' },
              group: { provider: 'workbuddy2api', model: 'deepseek-v4-pro' },
              private: null,
              override: null,
            };
            return json({
              ok: true,
              current: { provider: 'deepseek-account', model: 'deepseek-flash' },
              scopes,
              options,
              catalog: { total: options.length },
              note: '切换对下一轮生效，无需重启',
            });
          }
          case '/api/model': return json({
            ok: true,
            provider: state.model.provider,
            model: state.model.model,
            degraded: state.model.degraded === true,
            fallbacks: state.model.fallbacks || [],
            local: {
              enabled: state.local.enabled === true,
              active: state.local.active === true,
              since: state.local.since || 0,
              model: state.local.model,
              baseUrl: state.local.baseUrl,
              ok: state.local.ok || 0,
              fail: state.local.fail || 0,
              description: state.local.description || (state.local.active ? '本地兜底接管中（fixture）' : '本地兜底待命（fixture）'),
            },
          });
          case '/api/dsh/models': {
            // 网关清单：/__fixture/gateway 可切成「空清单」或「直接失败」，用来验体检卡第 4 项
            const gw = state.gateway || { mode: 'ok' };
            if (gw.mode === 'fail') return json({ ok: false, error: '模型探测失败（fixture 注入）' }, 500);
            const vision = state.vision || { mode: 'supported' };
            const models = gw.mode === 'empty' ? [] : fixtureModels().map((m) => {
              // 权威口径是 A 在每项上给的 seesImages: boolean。
              // mode: supported=true / unsupported=false / missing=不给这个字段
              if (vision.mode === 'missing') return m;
              return { ...m, seesImages: vision.mode !== 'unsupported' };
            });
            return json({
              ok: true,
              current: { provider: 'deepseek-official', model: state.dshModel || 'deepseek-flash' },
              degraded: state.dshModelDegraded === true,
              models,
              total: models.length,
              source: models.length ? 'cache' : 'error',
            });
          }
          case '/api/dsh/model': return json({
            provider: 'deepseek-official',
            model: 'deepseek-flash',
            reasoningEffort: state.dshEffort,
            options: ['low', 'high', 'max'],
            labels: { low: { name: 'Low', description: 'routine' }, high: { name: 'High', description: 'default balance' }, max: { name: 'Max', description: 'hardest tasks' } },
            default: 'max',
            providerDefault: 'high',
            catalogSource: 'dsh',
            globalSideEffect: true,
          });
          case '/api/whitelist': return json(state.whitelist);
          case '/api/sessions': return json({ sessions: state.sessions });
          case '/api/pending': return json({ pending: [{ key: 'group:123456789', kind: 'approval', toolName: '演示工具', reason: '等待管理员确认（离线示例）' }] });
          case '/api/social': return json({ config: state.social, states: state.socialStates, pendingSummaries: { 'group:123456789': 2 } });
          case '/api/socialV2/config': return json({ ok: true, config: state.v2 });
          case '/api/socialV2/activity': return json({ ok: true, paused: state.paused });
          case '/api/socialV2/tool-log': return json({ ok: true, entries: state.toolLog });
          case '/api/socialV2/feedback': return json({ ok: true, entries: state.feedback });
          case '/api/socialV2/memory': return json({ ok: true, raw: { activeTopics: [{ text: '周末的阅读计划', pendingQuestion: '有没有推荐的书？' }], pendingThoughts: [{ text: '分享一张风景照片', motivation: '轻松交流' }], memberImpressions: { 演示群友: { traits: ['友善', '喜欢技术'], interactionCount: 6 } } } });
          case '/api/socialV2/state': return json({ ok: true, key: url.searchParams.get('key'), wakeConfig: { mode: 'diving', infinite: false, sleepUntil: '2026-09-20T09:00:00.000Z', triggers: { atMention: true, keywords: ['小鲸鱼'] }, wakeCount: 4 }, wakeSafety: { guaranteed: true }, unreadCount: 2, lastWakeReason: 'atMention' });
          case '/api/socialV2/states': return json({ ok: true, conversations: state.sessions.map(x => ({ key: x.key, phase: 'diving', unreadCount: 2 })) });
          case '/api/socialV2/initial-prompt': {
            const key = url.searchParams.get('key') || '';
            if (!key) {
              return json({
                ok: true,
                maxChars: 2000,
                writable: true,
                entries: state.initPrompt
                  ? [{ key: 'group:123456789', chars: String(state.initPrompt).length, updatedAt: Date.now(), preview: String(state.initPrompt).slice(0, 80) }]
                  : []
              });
            }
            return json({
              ok: true, key, exists: !!state.initPrompt, text: state.initPrompt || '',
              createdAt: Date.now(), updatedAt: Date.now(), maxChars: 2000, writable: true
            });
          }
          // 语音库（离线示例：不含任何真实音频路径）
          case '/api/voice/list':
          case '/api/socialV2/voices': return json({
            ok: true,
            key: url.searchParams.get('key') || 'group:123456789',
            count: 2,
            voices: [
              { name: '演示-问候.mp3', ok: true, bytes: 20480, detail: '2秒 · 20.0 KB · mp3 · 24.0kHz · 单声道', seconds: 2 },
              { name: '演示-太长.wav', ok: false, bytes: 99999999, error: '时长 12分00秒 超过上限 5分00秒' },
            ],
            limits: { maxSeconds: 300, maxBytes: 20971520, maxPerMinute: 2, maxPerHour: 10 },
            hint: '用 qq_send_voice 传 name 即可把其中一个当语音发出去',
          });
          case '/api/slang': return json({ ok: true, entries: state.slang, config: state.slangConfig });
          case '/api/imagegen/quota': {
            // 分级出图的付费档配额（GET → { ok, remaining, dailyLimit }）；mode=missing 模拟老桥接没这个接口
            const q = state.imagegenQuota || { mode: 'ok', remaining: 23, limit: 30, used: 7 };
            if (q.mode === 'missing') return json({ ok: false, error: '未找到' }, 404);
            // 真实契约：{ ok, date, used, limit, remaining }
            if (q.mode === 'used') return json({ ok: true, date: '2026-10-25', used: Number(q.used) || 0, limit: q.limit });
            return json({ ok: true, date: '2026-10-25', used: Number(q.used) || 0, limit: q.limit, remaining: Number(q.remaining) || 0 });
          }
          case '/api/stickers': {
            // 表情列表：url 是「会过期的 QQ CDN 链接」的替身（example.invalid 永远取不到）
            const st = state.stickers || { mode: 'ok' };
            if (st.mode === 'missing') return json({ ok: false, error: '未找到' }, 404);
            if (st.mode === 'empty') return json({ ok: true, stickers: [] });
            return json({
              ok: true,
              total: 84,
              stickers: [
                { id: 'demo-a', md5: 'AAAA1111', url: 'https://example.invalid/a.png', desc: '演示表情 A', localNote: '', policy: 'usable', tags: ['打招呼'] },
                { id: 'demo-b', url: 'https://example.invalid/b.png', desc: '', localNote: '', policy: 'understand-only', tags: [] },
                { id: 'demo-missing', md5: '', url: 'https://example.invalid/expired.png', desc: '', localNote: '', policy: 'understand-only', tags: [], thumbStatus: 'missing', thumbError: '源链接已过期(HTTP 400)，采集时未落盘' },
              ],
            });
          }
          case '/api/stickers/thumb': {
            // 计划中的本地缩略图路由：直接吐 state/sticker-files/<md5>.img
            const md5 = String(url.searchParams.get('md5') ?? '').trim().toUpperCase();
            if (!md5) return json({ ok: false, error: 'md5 不能为空' }, 400);
            if (md5 !== 'AAAA1111' && md5 !== 'YYYY2222') return json({ ok: false, error: '本地缓存里没有这个 md5' }, 404);
            const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
            res.end(png);
            return;
          }
          case '/api/stickers/thumbnail': {
            const st = state.stickers || { mode: 'ok' };
            if (st.mode === 'thumb502') {
              return json({ ok: false, error: '图片源不可用（1 个候选都取不到，链接可能已过期）；可在控制台调用 POST /api/stickers/repair 清理/修复' }, 502);
            }
            // 1x1 PNG
            const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=60' });
            res.end(png);
            return;
          }
          case '/api/observe/config': {
            // 照 src/bridge.js:5545：{ ok, enabled, groups, learnSlang, learnStickers, description }
            const o = state.observe || { enabled: false, groups: ['100000001'], learnSlang: true, learnStickers: true };
            const enabled = o.enabled === true;
            // 注意：线上这个接口**没有 ok 字段**，fixture 保持一致，避免前端又按 r.ok 判断
            return json({
              enabled,
              groups: o.groups || [],
              learnSlang: o.learnSlang !== false,
              learnStickers: o.learnStickers !== false,
              // 关键：未启用时 description 必须是 null（与 describeObserveConfig 一致）
              description: enabled ? ('观察学习白名单：' + (o.groups || []).join(',') + '（这些群只在后台收集词汇+表情包，不会唤醒/回复/发消息）') : null,
            });
          }
          case '/api/library/items': {
            const mode = (state.library && state.library.mode) || 'ok';
            if (mode === 'missing') return json({ ok: false, error: '未找到' }, 404);
            if (mode === 'empty') return json({ ok: true, items: [] });
            return json({
              ok: true,
              items: [
                {
                  boothId: '4123456',
                  title: '演示衣装 套装',
                  shop: '演示店铺',
                  category: '3D衣装',
                  coverUrl: '',
                  boothUrl: 'https://booth.pm/zh-cn/items/4123456',
                  files: [
                    { id: 101, fileName: 'demo-4123456.zip', bytes: 10485760, archivedAt: 1792900000000, cleanupAt: 1792992000000, relPath: '100000001/2026-10/demo.zip' },
                    { id: 102, fileName: 'demo-4123456-2.zip', bytes: 5242880, archivedAt: 1792901000000, cleanupAt: 1792992000000, relPath: '100000001/2026-10/demo2.zip' },
                  ],
                  totalBytes: 15728640,
                  fileCount: 2,
                  enrichStatus: 'ok',
                  addedAt: 1792900000000,
                },
                {
                  boothId: '4000001',
                  title: '缺少封面的商品',
                  shop: '另一家店',
                  category: '3D衣装',
                  coverUrl: '',
                  boothUrl: '',
                  files: [],
                  totalBytes: 0,
                  fileCount: 0,
                  enrichStatus: 'pending',
                  addedAt: 1792890000000,
                },
              ],
            });
          }
          case '/api/library/item/4123456':
            return json({
              ok: true,
              item: {
                boothId: '4123456', title: '演示衣装 套装', shop: '演示店铺', category: '3D衣装',
                boothUrl: 'https://booth.pm/zh-cn/items/4123456', totalBytes: 15728640, fileCount: 2,
                files: [
                  { id: 101, fileName: 'demo-4123456.zip', bytes: 10485760, archivedAt: 1792900000000, relPath: '100000001/2026-10/demo.zip' },
                  { id: 102, fileName: 'demo-4123456-2.zip', bytes: 5242880, archivedAt: 1792901000000, relPath: '100000001/2026-10/demo2.zip' },
                ],
              },
              images: [
                { id: 201, fileName: '预览-1.png', thumbUrl: '/api/files/thumb?id=201' },
                { id: 202, fileName: '预览-2.png', thumbUrl: '/api/files/thumb?id=202' },
              ],
              meta: { boothId: '4123456', title: '演示衣装 套装', shop: '演示店铺', price: '¥1500', tags: ['3D', '衣装'] },
            });
          case '/api/library/unclassified': {
            const mode = (state.library && state.library.mode) || 'ok';
            if (mode === 'missing') return json({ ok: false, error: '未找到' }, 404);
            if (mode === 'empty') return json({ ok: true, archives: [], images: [] });
            return json({
              ok: true,
              archives: [{ id: 301, fileName: '无号压缩包.zip', bytes: 204800, archivedAt: 1792902000000, cleanupAt: 1792992000000 }],
              images: [{ id: 302, fileName: '无号截图.png', bytes: 4096, archivedAt: 1792903000000, cleanupAt: 1792992000000 }],
            });
          }
          case '/api/library/assets': {
            return json({
              ok: true,
              count: 2, bytes: 4096, withBooth: 1, withThumb: 1, suggested: 1, bound: 0,
              assets: [
                { key: 'g/c/mew', kind: 'zip', title: 'Mew_Pose_Ver.3', dir: '100000001/mew', boothId: '8664050', boothSource: 'zip', files: 2, bytes: 2048, previews: 1, hasReadme: true, thumbUrl: '/api/library/thumb?rel=x.png' },
                { key: 'g/c/astraea', kind: 'zip', title: 'Astraea', dir: '100000001/astraea', boothId: '', boothSource: '', files: 1, bytes: 2048, previews: 0, hasReadme: false, thumbUrl: '',
                  suggestion: { boothId: '271777', title: 'Astraea', score: 0.85, auto: true, reason: '标题高度一致（100%）' } }
              ]
            });
          }
          case '/api/library/batchfind': {
            if (req.method === 'POST') return json({ ok: true, queued: 1, running: false, job: { total: 1, done: 0 }, progress: { total: 0, withPick: 0 }, text: '正在找号… 0/1' });
            return json({ ok: true, running: false, job: { total: 0, done: 0 }, progress: { total: 0, withPick: 0 }, text: '还没批量找过' });
          }
          case '/api/library/batchfind/clear':
          case '/api/library/batchfind/stop': {
            return json({ ok: true, running: false, job: { total: 0, done: 0 }, progress: { total: 0, withPick: 0 }, text: '还没批量找过' });
          }
          case '/api/library/item-thumb': {
            const boothId = String(url.searchParams.get('boothId') || '');
            if (boothId === '4000001') return json({ ok: false, error: '抓取封面失败' }, 404);
            const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
            res.end(png);
            return;
          }
          case '/api/files/lists': {
            if ((state.files && state.files.lists) === 'missing') return json({ ok: false, error: '未找到' }, 404);
            return json({
              ok: true,
              lists: [
                { category: '3D衣装', count: 40 },
                { category: 'image', count: 40 },
                { category: '未分类', count: 40 },
              ],
              uncategorized: { count: 40 },
            });
          }
          case '/api/files/notify': {
            if ((state.files && state.files.notify) === 'missing') return json({ ok: false, error: '未找到' }, 404);
            return json({ ok: true, pendingEnrich: 17, failed: 2, unclassified: 30, lastBackfillAt: 1792940748933 });
          }
          case '/api/files/item': {
            const id = Number(url.searchParams.get('id'));
            return json({ ok: true, id, boothTitle: '演示衣装 ' + id, boothShop: '演示店铺', category: '3D衣装', relPath: '100000001/2026-10/file-' + id + '.png', bytes: 1024 * id, archivedAt: 1792900000000 + id, cleanupAt: 1792992000000 });
          }
          case '/api/files/export': {
            const format = url.searchParams.get('format') || 'json';
            res.writeHead(200, { 'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8' });
            res.end(format === 'csv' ? 'id,fileName\n1,file-1.png\n' : JSON.stringify({ ok: true, files: [] }));
            return;
          }
          case '/api/files/stats': {
            // 契约照 src/file-archive.js 的 archiveStats()：{ ok, files{active,activeBytes,...}, byGroup[], nextCleanupAt, ... }
            const mode = (state.files && state.files.mode) || 'ok';
            if (mode === 'missing') return json({ ok: false, error: '未找到' }, 404);
            if (mode === 'empty') return json({ ok: true, files: { active: 0, activeBytes: 0, classified: 0, unclassified: 0, due: 0, dueBytes: 0, deleted: 0, deletedBytes: 0, total: 0 }, byGroup: [], enabled: true, maxFileMb: 2500, nextCleanupAt: 1792992000000 });
            if (mode === 'huge') return json({ ok: true, files: { active: 2, activeBytes: 60 * 1024 * 1024 * 1024, classified: 0, unclassified: 2, due: 0, dueBytes: 0, deleted: 0, deletedBytes: 0, total: 2 }, byGroup: [{ groupId: '123456789', files: 2, bytes: 60 * 1024 * 1024 * 1024 }], enabled: true, maxFileMb: 2500, nextCleanupAt: 1792992000000 });
            return json({
              ok: true,
              files: { active: 4, activeBytes: 5242880, classified: 1, unclassified: 3, due: 1, dueBytes: 1048576, deleted: 2, deletedBytes: 4096, total: 6 },
              byGroup: (() => {
                const shape = (state.files && state.files.byGroup) || 'array';
                if (shape === 'missing') return undefined;
                const one = { groupId: '123456789', files: 10, bytes: 240795428 };
                if (shape === 'object') return one;
                if (shape === 'empty') return [];
                return [one, { groupId: '987654321', files: 2, bytes: 1048576 }];
              })(),
              enabled: true,
              maxFileMb: 2500,
              nextCleanupAt: 1792992000000,
            });
          }
          case '/api/files': {
            // 线上真实返回：{ ok, files, total, offset, limit }
            const mode = (state.files && state.files.mode) || 'ok';
            if (mode === 'missing') return json({ ok: false, error: '未找到' }, 404);
            const all = [];
            for (let i = 1; i <= 120; i += 1) {
              all.push({
                id: i,
                groupId: i % 2 ? '123456789' : '987654321',
                fileName: 'file-' + i + (i % 3 === 0 ? '.zip' : '.png'),
                bytes: 1024 * i,
                category: i % 3 === 0 ? '3D衣装' : (i % 2 ? 'image' : ''),
                boothId: i % 4 === 0 ? '' : String(4000000 + i),
                boothUrl: i % 4 === 0 ? '' : ('https://booth.pm/zh-cn/items/' + (4000000 + i)),
                boothTitle: (i % 4 === 0 || i % 7 === 0) ? '' : ('演示衣装 ' + i),
                boothShop: (i % 4 === 0 || i % 7 === 0) ? '' : ('演示店铺 ' + (i % 3)),
                boothPrice: i % 4 === 0 ? '' : '¥' + (500 + i * 10),
                boothTags: i % 4 === 0 ? '' : '3D|衣装',
                enrichStatus: i % 7 === 0 ? 'pending' : (i % 4 === 0 ? 'none' : 'ok'),
                thumbUrl: i % 5 === 0 ? '' : ('/api/files/thumb?id=' + i),
                archivedAt: 1792900000000 + i * 1000,
                cleanupAt: 1792992000000,
                uploader: '演示群友',
              });
            }
            if (mode === 'empty') return json({ ok: true, files: [], total: 0, offset: 0, limit: 50 });
            const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
            const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
            const total = all.length;
            const safeOffset = Math.min(offset, Math.max(0, (Math.ceil(total / limit) - 1) * limit));
            return json({ ok: true, files: all.slice(safeOffset, safeOffset + limit), total, offset: safeOffset, limit });
          }
          case '/api/peak/status': {
            if ((state.peak && state.peak.mode) === 'missing') return json({ ok: false, error: '未找到' }, 404);
            return json({
              ok: true,
              enabled: true,
              schedule: { peak: [[9, 12], [14, 18]] },
              windows: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
              inWindow: true,
              active: false,
              validYear: 2026,
              updatedAt: '2026-10-25T00:00:00.000Z',
              expired: false,
              serverTime: '10:30:00',
            });
          }
          case '/api/storage/stats': {
            // 结构完全照 src/storage-stats.js 的 collectStorageStats()（线上实际返回）
            const mode = (state.storage && state.storage.mode) || 'ok';
            if (mode === 'missing') return json({ ok: false, error: '未找到' }, 404);
            const walBytes = mode === 'wal' ? 4161232 : 204800;
            const top = [
              { name: 'sticker-files', kind: 'dir', bytes: 35720793 },
              { name: 'messages.db', kind: 'file', bytes: 1708032 },
              { name: 'archive', kind: 'dir', bytes: 385024 },
              { name: 'token-usage.jsonl', kind: 'file', bytes: 830000 },
              { name: 'social-v2.json', kind: 'file', bytes: 96000 },
              ...(mode === 'truncated' ? [{ name: 'deep-dir', kind: 'dir', bytes: 12000, depthLimited: true }] : []),
            ];
            return json({
              ok: true,
              generatedAt: Date.now(),
              stateDir: 'C:/demo/state',
              top,
              topTotal: top.reduce((n, it) => n + it.bytes, 0),
              truncated: mode === 'truncated',
              messages: {
                db: { pageCount: mode === 'freelist' ? 343 : 417, pageSize: 4096, freelistCount: mode === 'freelist' ? 88 : 2, rows: 3442 },
                dbBytes: 1708032,
                walBytes,
              },
              logs: [
                { name: 'bridge.log', bytes: 41400, lines: 423 },
                { name: 'qq-activity.log', bytes: 8800, lines: 51 },
              ],
              disks: [{ dir: 'C:/demo/state', free: { total: 233000000000, free: 221000000000 } }],
            });
          }
          // state/ 的 ACL 收紧结果：用离线示例值演示「未收紧」的告警条（Windows 上未提权时的真实情况）
          // 命令本身必须来自 `src/state-acl.mjs`，不能在这里另抄一份：这里曾经抄的是
          // `icacls DIR /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" /T /C` —— 正是那句
          // 会把子文件 DACL 清空、让桥接读不到自己令牌的破坏性命令。示例数据是给人照抄的，
          // 抄错的那一版和真的那一版看起来一模一样。
          case '/api/security': return json({
            ok: true,
            security: state.security,
            stateDir: state.hardenStateDir
              ? { hardened: true, path: 'D:\\demo\\qq-bridge\\state', manualCommand: '' }
              : { hardened: false, path: 'D:\\demo\\qq-bridge\\state', manualCommand: manualDirCommand('D:\\demo\\qq-bridge\\state') }
          });
          // 令牌与花费：全部为离线示例数据，不含任何真实用量。
          case '/api/tokens/summary': {
            const summary = usageSummaryFixture();
            if (state.usageInconsistent === true) {
              // 复刻审阅窗口实测到的那组数：已归属 + 未归属比 cost 多约 9%
              summary.totals.attributedCost = Math.round(summary.totals.cost * 1090) / 1000 - 0.02;
              summary.totals.unattributedCost = 0.02;
            }
            return json(summary);
          }
          case '/api/tokens/series': return json(usageSeriesFixture(url.searchParams.get('hours')));
          case '/api/tokens/turns': return json(usageTurnsFixture(url.searchParams.get('key')));
          case '/api/tokens/recent': return json({ ok: true, symbol: '¥', entries: usageRecentFixture() });
          case '/api/tokens/today': {
            // 今日各群调用：离线示例数据，两个群各若干次
            return json({
              ok: true,
              symbol: '¥',
              totalCalls: 42,
              from: Date.now(),
              to: Date.now(),
              keys: [
                { key: 'group:100000001', calls: 30, turns: 8, tokens: 1200000, cost: 1.2 },
                { key: 'group:100000003', calls: 12, turns: 4, tokens: 480000, cost: 0.48 }
              ]
            });
          }
        }
      }
      if (method === 'POST') {
        switch (path) {
          case '/api/stickers/remove': {
            const st = state.stickers || {};
            if (st.mode === 'removefail') return json({ ok: false, error: '表情库不可用' }, 503);
            const id = String(body.id ?? body.stickerId ?? '');
            return json({ ok: true, removed: { id } });
          }
          case '/api/stickers/dedupe': {
            // 默认模拟「后端还没实现」；mode=dedupeok 时给出真实形态
            const st = state.stickers || {};
            if (st.mode !== 'dedupeok') return json({ ok: false, error: '未找到' }, 404);
            return json({ ok: true, merged: 8, before: 92, after: 84 });
          }
          case '/api/stickers/repair': {
            const st = state.stickers || { mode: 'ok' };
            if (st.mode === 'repair404') return json({ ok: false, error: '未找到' }, 404);
            if (st.mode === 'repairfail') return json({ ok: false, error: '消息库不可用' }, 503);
            return json({ ok: true, applied: true, repaired: [{ id: 'demo-a', md5: 'YYYY2222', bytes: 68 }], dead: [], failed: [], total: 2 });
          }
          case '/api/mode': state.mode = body.mode; state.closedAgentPreset = body.closedAgentPreset; return json({ ok: true, dshSynced: true });
          case '/api/role': state.role = body.role; return json({ ok: true });
          case '/api/roles/create': state.roles.push(body.name); state.roleContents[body.name] = body.content ?? ''; return json({ ok: true, role: body.name, warnings: [] });
          case '/api/roles/update': state.roleContents[body.name] = body.content ?? ''; return json({ ok: true, role: body.name, chars: String(body.content ?? '').length, warnings: [] });
          case '/api/roles/rename': {
            const idx = state.roles.indexOf(body.from);
            if (idx >= 0) state.roles[idx] = body.to;
            state.roleContents[body.to] = state.roleContents[body.from] ?? '';
            delete state.roleContents[body.from];
            if (state.role === body.from) state.role = body.to;
            return json({ ok: true, role: body.to, renamed: true, currentFollowed: state.role === body.to });
          }
          case '/api/roles/delete': {
            const idx = state.roles.indexOf(body.name);
            if (idx >= 0) state.roles.splice(idx, 1);
            delete state.roleContents[body.name];
            const cleared = state.role === body.name;
            if (cleared) state.role = null;
            return json({ ok: true, deleted: body.name, clearedCurrent: cleared });
          }
          case '/api/roles/limit': state.roleInjectMax = Number(body.maxInjectChars) || state.roleInjectMax; return json({ ok: true, maxInjectChars: state.roleInjectMax, limits: { injectMaxChars: state.roleInjectMax } });
          case '/api/preset/sim-prompt': {
            const preset = body.preset === 'qq-chat' ? 'qq-chat' : 'qq-chat-v2';
            const content = String(body.content ?? '');
            const unchanged = content === state.simPrompts[preset];
            if (!unchanged) state.simPrompts[preset] = content;
            return json({ ok: true, unchanged, chars: content.length, warnings: [], synced: true, requiresRestart: !unchanged, status: presetStatusFixture(preset) });
          }
          case '/api/preset/sim-prompt/restore': {
            const preset = body.preset === 'qq-chat' ? 'qq-chat' : 'qq-chat-v2';
            return json({ ok: true, restoredFrom: `${preset}.agent.cordis.yml.fixture`, requiresRestart: true });
          }
          case '/api/dsh/effort': state.dshEffort = body.reasoningEffort; return json({ ok: true, reasoningEffort: body.reasoningEffort });
          case '/api/socialV2/draw': {
            // 与 src/bridge.js:7637 的出图路由同序：token → 冷却/额度 → 参数 → 成功。
            // tier 必填、只认小写 'free' / 'high'（后端原话：无默认值，模型必须先问过用户再调）。
            const draw = state.draw || { mode: 'ok', waitSec: 12 };
            state.lastDraw = body;
            if (!req.headers['x-agent-token']) return json({ ok: false, error: 'reserved2 模式出图必须携带 agent token' }, 403);
            if (draw.mode === '403') return json({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            if (draw.mode === 'tierreject') {
              // A 的 tier 硬约束：没先问用户选档就拒绝出图（禁止静默改免费）
              return json({ ok: false, code: 'tier-required', error: "tier 必填：必须先问用户选哪档（'free' 免费档 / 'high' 高质量档），本轮被拒绝出图" }, 400);
            }
            if (draw.mode === '429') {
              const msg = draw.reason || ('出图冷却中，请 ' + (Number(draw.waitSec) || 12) + ' 秒后再试');
              return json({ ok: false, error: msg }, 429);
            }
            if (!body.key || !body.prompt) return json({ ok: false, error: 'key 和 prompt 不能为空' }, 400);
            if (String(body.prompt).length > 500) return json({ ok: false, error: 'prompt 过长（最多 500 字）' }, 400);
            const tier = String(body.tier ?? '').trim();
            if (tier !== 'free' && tier !== 'high') {
              return json({ ok: false, error: "tier 必填，只能取 'free'（免费档，带水印）或 'high'（高质量档，无水印，每天 30 次）；请先问用户选哪档" }, 400);
            }
            if (tier === 'high') {
              const q = state.imagegenQuota || { remaining: 23, limit: 30, used: 7 };
              if (Number(q.remaining) <= 0) return json({ ok: false, error: '今天的付费出图次数用完了（30/30）' }, 429);
              q.remaining = Math.max(0, Number(q.remaining) - 1);
              q.used = Number(q.used) + 1;
              state.imagegenQuota = q;
            }
            // mode=notier 模拟「返回体只有最少字段」；legacy 模拟当前线上那版（连 tier 都不回）
            if (draw.mode === 'notier') return json({ ok: true, key: body.key, messageId: 9001, sent: 1 });
            if (draw.mode === 'legacy') return json({ ok: true, key: body.key, messageId: 9001, sent: 1 });
            const q2 = state.imagegenQuota || { remaining: 23, limit: 30, used: 7 };
            return json({
              ok: true,
              key: body.key,
              messageId: 9001,
              sent: 1,
              tier,
              provider: tier === 'high' ? 'siliconflow' : 'zhipu',
              charged: tier === 'high',
              watermarked: tier === 'free',
              quota: tier === 'high' ? { used: q2.used, limit: q2.limit, remaining: q2.remaining } : null,
              url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
            });
          }
          case '/api/model-routing': {
            if ((state.routing && state.routing.postFail) === true) {
              return json({ ok: false, error: 'provider 与 model 都不能为空（fixture 注入）' }, 400);
            }
            state.routingLastSave = body;
            return json({ ok: true, saved: true, note: '下一轮生效' });
          }
          case '/api/model': {
            if (method === 'DELETE') {
              const scope = String(url.searchParams.get('scope') || '');
              if (!scope) return json({ ok: false, error: 'scope 不能为空' }, 400);
              if (scope === 'main') return json({ ok: false, error: 'main 不可清除' }, 400);
              return json({ ok: true, scope, cleared: true });
            }
            if ((state.models && state.models.postFail) === true) {
              return json({ ok: false, error: '模型 x/y 不在可用清单里（fixture 注入）' }, 400);
            }
            const scope = String(body.scope || 'main');
            state.model.provider = body.provider;
            state.model.model = body.model;
            state.model.degraded = false;
            state.modelScope = scope;
            return json({ ok: true, scope, provider: body.provider, model: body.model, persisted: body.persist === true });
          }
          case '/api/dsh/model': {
            const wanted = body.provider ? body.provider + '/' + body.model : String(body.model || '');
            const known = fixtureModels().some((m) => (m.provider ? m.provider + '/' : '') + m.model === wanted);
            if (!known) return json({ ok: false, error: '模型不在可用清单里（fixture）', models: fixtureModels() }, 400);
            state.dshModel = body.model;
            state.dshModelDegraded = false;
            return json({ ok: true, provider: body.provider, model: body.model });
          }
          case '/api/role-mode': state.roleMode = body.mode; return json({ ok: true });
          case '/api/whitelist': state.whitelist = body; return json({ ok: true });
          case '/api/social': state.social = body; return json({ ok: true });
          case '/api/social/state': state.socialStates[body.key] = { phase: body.phase }; return json({ ok: true });
          case '/api/socialV2/config': state.v2 = body; return json({ ok: true });
          case '/api/socialV2/activity': state.paused = body.paused; return json({ ok: true });
          case '/api/socialV2/tool-log/clear': state.toolLog = []; return json({ ok: true });
          case '/api/socialV2/feedback-clear': state.feedback = []; return json({ ok: true });
          case '/api/socialV2/reset': return json({ ok: true });
          case '/api/socialV2/initial-prompt': {
            const text = body.delete === true ? '' : String(body.text ?? '');
            state.initPrompt = text;
            return json({
              ok: true, key: body.key || '', deleted: !text, chars: text.length,
              exists: !!text, updatedAt: Date.now(), maxChars: 2000
            });
          }
          case '/api/slang/config': state.slangConfig = body; return json({ ok: true });
          case '/api/slang': state.slang.push({ ...body, id: `demo-${state.slang.length + 1}`, status: 'confirmed', source: 'manual', count: 1 }); return json({ ok: true });
          case '/api/security':
            if (body.rehardenStateDir === true) {
              // 离线演示：把「重新检测」当成一次成功的收紧（真实实现要管理员权限）
              state.hardenStateDir = true;
              return json({ ok: true, hardened: true, path: 'D:\\demo\\qq-bridge\\state' });
            }
            state.security = body;
            return json({ ok: true });
          case '/api/console/token': return json({ ok: true, token: body.token || 'offline-demo-token-123456', generated: !body.token });
          case '/api/test-send': return json({ ok: true, message_id: 'mock-message-001' });
          // 语音试发（操作者通道）：离线只回执，不产生任何真实 QQ 消息
          case '/api/voice/send': return json(body.dryRun
            ? { ok: true, dryRun: true, target: body.target, file: body.file, detail: '2秒 · 20.0 KB · mp3 · 24.0kHz · 单声道', verified: false }
            : { ok: true, target: body.target, file: body.file, detail: '2秒 · 20.0 KB · mp3', messageId: 9001, verified: true, limits: { maxSeconds: 300, maxBytes: 20971520, maxPerMinute: 2, maxPerHour: 10 } });
          case '/api/console/notify-ai': return json({ ok: true, sessionId: 'mock-dsh-session' });
          case '/api/restart': return json({ ok: true, message: '离线预览：已模拟重启，实际服务未改变。' });
          case '/api/workspace/reset': state.sessions = []; return json({ ok: true, archivedCount: 3 });
          case '/api/session/reset': state.sessions = state.sessions.filter(x => x.key !== body.key); return json({ ok: true });
          case '/api/slang/extract': return json({ ok: true });
          case '/api/slang/research': return json({ ok: true, count: body.ids?.length || 1 });
          case '/api/slang/batch-confirm':
          case '/api/slang/batch-reject':
          case '/api/slang/batch-delete': {
            const ids = body.ids || [];
            if (path.endsWith('delete')) state.slang = state.slang.filter(x => !ids.includes(x.id));
            else state.slang.forEach(x => { if (ids.includes(x.id)) x.status = path.endsWith('confirm') ? 'confirmed' : 'rejected'; });
            return json({ ok: true, count: ids.length, confirmed: ids.length, rejected: ids.length, deleted: ids.length });
          }
          case '/api/social/flush':
          case '/api/socialV2/wake':
          case '/api/socialV2/memory-clear':
          case '/api/socialV2/memory-update':
          case '/api/socialV2/memory-remove': return json({ ok: true });
          case '/api/tokens/reset': return json({ ok: true });
        }
      }
      const slangMatch = path.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
      if (slangMatch && ['POST', 'PATCH', 'DELETE'].includes(method)) {
        const entry = state.slang.find(x => x.id === slangMatch[1]);
        if (!entry) return json({ ok: false, error: '演示词条不存在' }, 404);
        if (method === 'DELETE') state.slang = state.slang.filter(x => x !== entry);
        else Object.assign(entry, body, slangMatch[2] ? { status: slangMatch[2] === 'confirm' ? 'confirmed' : 'rejected' } : {});
        return json({ ok: true });
      }
      unknownRequests.push({ method, path });
      if (method === 'DELETE') {
        switch (path) {
          case '/api/model': {
            const scope = String(url.searchParams.get('scope') || '');
            if (!scope) return json({ ok: false, error: 'scope 不能为空' }, 400);
            if (scope === 'main') return json({ ok: false, error: 'main 不可清除' }, 400);
            return json({ ok: true, scope, cleared: true });
          }
        }
      }
      return json({ ok: false, error: `Unimplemented fixture route: ${method} ${path}` }, 404);
    } catch (error) {
      json({ ok: false, error: error.message }, 500);
    }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  return { server, state, requests, unknownRequests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolveClose => server.close(resolveClose)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = name => args.find(x => x.startsWith(`${name}=`))?.slice(name.length + 1);
  const fixture = await startConsoleFixture({ port: Number(value('--port') || 4173), original: args.includes('--original'), htmlPath: value('--html') ? resolve(value('--html')) : undefined, logWrites: true });
  console.log(`Offline console preview: ${fixture.url}\nAll data is synthetic; writes stay in memory.\nRecorded requests: ${fixture.url}/__fixture/requests`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await fixture.close(); process.exit(0); });
}
