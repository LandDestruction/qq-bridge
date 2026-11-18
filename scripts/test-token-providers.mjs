// 「按 provider / 计费口径」测试。
//
// 三块：
// 1. token-providers 纯函数：provider 归一、billed=cacheMiss+output、share 求和 100、basis 切换、窗口/会话过滤；
// 2. 账本访问器 samplesSince：只给窗口内的采样、key 过滤、cost 与 summary 同源；
// 3. 路由 /api/tokens/providers：range/basis 校验、agent 403、返回形状与 note；summary 里 billing 字段。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PRICE_TABLE, normalizeUsage } from '../src/model-prices.js';
import { createTokenLedger } from '../src/token-ledger.js';
import * as providers from '../src/token-providers.js';
import { createConsoleJournal } from '../src/bridge/console/journal.js';

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed += 1; console.log(`✅ ${label}`); }
  else { failed += 1; console.error(`❌ ${label}`); }
}

// 纯函数造样本（不经过账本，测口径本身）
function sample({ provider = 'deepseek-account', t = 0, key = 'group:1', sessionId = 's1', turn = 1, cacheMiss = 100, cacheHit = 1000, cacheWrite = 0, output = 50, cost = 0.01 } = {}) {
  return { sessionId, turn, key, t, provider, model: 'deepseek-flash', buckets: { cacheMiss, cacheHit, cacheWrite, output }, cost };
}

// ── 1. provider 归一与标签 ──────────────────────────────────────────────
{
  assert(providers.PROVIDER_LABELS.workbuddy2api === 'WorkBuddy', 'workbuddy2api → WorkBuddy');
  assert(providers.PROVIDER_LABELS.workbuddy === 'WorkBuddy', 'workbuddy 也归 WorkBuddy');
  assert(providers.PROVIDER_LABELS['deepseek-account'] === 'DeepSeek 官方账号', 'deepseek-account 标签正确');
  assert(providers.PROVIDER_LABELS['deepseek-official'] === 'DeepSeek 官方', 'deepseek-official 标签正确');
  assert(providers.PROVIDER_LABELS['xiaomi-mimo'] === '小米 MiMo', 'xiaomi-mimo 标签正确');
  assert(providers.providerLabelOf('brand-new-provider') === 'brand-new-provider', '未知 provider 原样显示');
  assert(providers.providerOf({ provider: 'workbuddy2api' }) === 'workbuddy2api', 'providerOf 取 provider 字段');
  assert(providers.providerOf({ providerId: 'xiaomi-mimo' }) === 'xiaomi-mimo', 'providerOf 兼容 providerId');
  assert(providers.providerOf({}) === 'unknown', '缺 provider 字段 → unknown');
  assert(providers.providerOf({ provider: '  ' }) === 'unknown', '空白 provider → unknown');
  assert(providers.providerLabelOf('unknown') === 'unknown', 'unknown 的标签是 unknown（不假装有名字）');
}

// ── 2. 桶累加：billed = cacheMiss(+cacheWrite) + output ────────────────
{
  const bucket = providers.emptyProviderBucket();
  providers.addSampleIntoProvider(bucket, sample({ cacheMiss: 100, cacheWrite: 20, cacheHit: 5000, output: 30, cost: 0.25 }));
  assert(bucket.calls === 1, 'calls 按采样数累加');
  assert(bucket.cacheMiss === 120, `cacheMiss 含 cacheWrite（实得 ${bucket.cacheMiss}）`);
  assert(bucket.cacheHit === 5000, 'cacheHit 单列');
  assert(bucket.output === 30, 'output 单列');
  assert(bucket.billed === 150, `billed = cacheMiss + output = 150（实得 ${bucket.billed}）`);
  assert(bucket.tokens === 120 + 5000 + 30, `tokens = 四桶和（实得 ${bucket.tokens}）`);
  assert(Math.abs(bucket.cost - 0.25) < 1e-9, 'cost 累加');
  assert(bucket.turns === 1, 'turns 按 (sessionId,turn) 去重初值 1');
  providers.addSampleIntoProvider(bucket, sample({ turn: 1 }));
  assert(bucket.turns === 1 && bucket.calls === 2, '同一轮多采样：轮数不变、calls 增加');
  providers.addSampleIntoProvider(bucket, sample({ turn: 2 }));
  assert(bucket.turns === 2, '不同轮：轮数 +1');
}

// ── 3. 聚合：比例、排序、basis ──────────────────────────────────────────
{
  const samples = [
    sample({ provider: 'deepseek-account', t: 100, key: 'group:1', sessionId: 'a', turn: 1, cacheMiss: 100, cacheHit: 10000, output: 100, cost: 1 }),
    sample({ provider: 'deepseek-account', t: 200, key: 'group:1', sessionId: 'a', turn: 2, cacheMiss: 100, cacheHit: 10000, output: 100, cost: 1 }),
    sample({ provider: 'workbuddy2api', t: 300, key: 'group:2', sessionId: 'b', turn: 1, cacheMiss: 1000, cacheHit: 100, output: 1000, cost: 2 })
  ];
  const billed = providers.aggregateProviderDays(samples);
  assert(billed.basis === 'billed', '默认 basis=billed');
  assert(billed.providers.length === 2, `两个 provider（实得 ${billed.providers.length}）`);
  const wb = billed.providers.find((row) => row.provider === 'workbuddy2api');
  const ds = billed.providers.find((row) => row.provider === 'deepseek-account');
  assert(wb.billed === 2000 && ds.billed === 400, `billed 分别 2000 / 400（实得 ${wb.billed} / ${ds.billed}）`);
  assert(wb.share === 0.8333 && wb.sharePct === 83.3, `workbuddy share=0.8333/sharePct=83.3（实得 ${wb.share}/${wb.sharePct}）`);
  const sum = billed.providers.reduce((acc, row) => acc + row.share, 0);
  const sumPct = billed.providers.reduce((acc, row) => acc + row.sharePct, 0);
  assert(Math.abs(sum - 1) < 0.001, `Σshare≈1（实得 ${sum}）`);
  assert(Math.abs(sumPct - 100) < 0.5, `ΣsharePct≈100（实得 ${sumPct}）`);
  assert(billed.providers[0].provider === 'workbuddy2api', '默认按 billed 降序');
  assert(billed.total.cacheHit === 20100, `total.cacheHit 汇总（实得 ${billed.total.cacheHit}）`);
  assert(billed.total.billed === 2400, `total.billed=2400（实得 ${billed.total.billed}）`);
  assert(billed.total.providers === 2, 'total.providers = provider 个数');
  assert(billed.total.turns === 3, `total.turns 去重轮数=3（实得 ${billed.total.turns}）`);

  const raw = providers.aggregateProviderDays(samples, { basis: 'raw' });
  assert(raw.basis === 'raw', 'basis=raw 生效');
  assert(raw.providers[0].provider === 'deepseek-account', 'raw 口径下 deepseek 排第一（cacheHit 更大）');
  assert(raw.providers[0].share > 0.9 && raw.providers[0].sharePct > 90, `raw 口径下 deepseek share≈0.9（实得 ${raw.providers[0].share}）`);

  const filtered = providers.aggregateProviderDays(samples, { from: 50, to: 300 });
  assert(filtered.total.calls === 2, `窗口只留 2 条（实得 ${filtered.total.calls}）`);
  const byKey = providers.aggregateProviderDays(samples, { key: 'group:2' });
  assert(byKey.providers.length === 1 && byKey.providers[0].provider === 'workbuddy2api', 'key 过滤只留该会话');
  assert(byKey.total.calls === 1, 'key 过滤后 calls=1');

  const unknown = providers.aggregateProviderDays([sample({ provider: '' })]);
  assert(unknown.providers[0].provider === 'unknown', '未知 provider 归 unknown 桶而不是丢弃');
  assert(unknown.providers[0].label === 'unknown', 'unknown 标签原样');
}

// ── 4. 窗口计算 ────────────────────────────────────────────────────────
{
  const now = new Date(2026, 9, 30, 15, 0, 0).getTime();
  const today = providers.providerRangeWindow('today', now);
  assert(today.from === new Date(2026, 9, 30, 0, 0, 0).getTime(), 'today 从本地零点开始');
  assert(today.to === 0 && today.days === 1, 'today 无上界、1 天');
  const d7 = providers.providerRangeWindow('7d', now);
  assert(d7.from === today.from - 6 * 86400000, '7d = 零点往前 6 天');
  const d30 = providers.providerRangeWindow('30d', now);
  assert(d30.from === today.from - 29 * 86400000, '30d = 零点往前 29 天');
  const all = providers.providerRangeWindow('all', now);
  assert(all.from === 0 && all.to === 0, 'all 不设窗口');
}

// ── 5. 账本访问器 samplesSince + summary.billing ──────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-token-providers-'));
const ledgerFile = path.join(tmpDir, 'token-usage.jsonl');
// 用「今天的 10:00」而不是写死日期：否则跨 0 点后 range=today 会把 fixture 全过滤掉（假红）。
const dayA = (() => { const d = new Date(); d.setHours(10, 0, 0, 0); return d.getTime(); })();
const dayB = dayA - 24 * 3600 * 1000;
const KEY_BY_SESSION = { 's-a': 'group:101', 's-b': 'group:202' };

function freshLedger() {
  try { fs.unlinkSync(ledgerFile); } catch { /* 首次没有文件 */ }
  return createTokenLedger({ file: ledgerFile, priceTable: DEFAULT_PRICE_TABLE, resolveKey: (sid) => KEY_BY_SESSION[sid] ?? null });
}

function ingestTurn(led, { sessionId, turn, time, provider, input = 1000, output = 100, cacheRead = 200 }) {
  led.ingestEvent({
    sessionId,
    event: {
      type: 'assistant/message',
      seq: turn,
      time,
      data: { turn, step: 1, model: 'deepseek-flash', provider, usage: normalizeUsage({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead }) }
    }
  });
}

{
  const led = freshLedger();
  ingestTurn(led, { sessionId: 's-a', turn: 1, time: dayA, provider: 'deepseek-account' });
  ingestTurn(led, { sessionId: 's-a', turn: 2, time: dayA + 5000, provider: 'workbuddy2api' });
  ingestTurn(led, { sessionId: 's-b', turn: 1, time: dayB, provider: 'xiaomi-mimo' });

  const all = led.samplesSince({});
  assert(all.length === 3, `samplesSince({}) 给全部 3 条采样（实得 ${all.length}）`);
  assert(all.every((row) => typeof row.cost === 'number' && row.t >= 0), '每条采样带 cost 与时间');
  assert(new Set(all.map((row) => row.provider)).size === 3, '三条采样三个 provider');
  const todayOnly = led.samplesSince({ from: dayA - 1000 });
  assert(todayOnly.length === 2, `窗口过滤只留 2 条（实得 ${todayOnly.length}）`);
  const bounded = led.samplesSince({ from: 0, to: dayA });
  assert(bounded.length === 1 && bounded[0].sessionId === 's-b', 'to 半开区间');
  const byKey = led.samplesSince({ key: 'group:101' });
  assert(byKey.length === 2 && byKey.every((row) => row.key === 'group:101'), 'key 过滤');
  assert(led.samplesSince({ key: 'group:999' }).length === 0, '不存在的 key 给空数组');

  const sum = led.summary();
  assert(sum.ok === true, 'summary 正常');
  assert(sum.billing && typeof sum.billing.billed === 'number', 'summary 带 billing 字段');
  assert(sum.billing.billed === sum.billing.cacheMiss + sum.billing.output, 'billing.billed = cacheMiss + output');
  assert(sum.billing.cacheMiss === sum.totals.buckets.cacheMiss, 'billing.cacheMiss 与 totals 同源');
  assert(sum.billing.output === sum.totals.buckets.output, 'billing.output 与 totals 同源');
}

// ── 6. 路由 /api/tokens/providers ─────────────────────────────────────
{
  const led = freshLedger();
  ingestTurn(led, { sessionId: 's-a', turn: 1, time: dayA, provider: 'deepseek-account' });
  // 第二轮换到 s-b（group:202）：让「按真实 key 过滤」能真的分出两个 provider。
  ingestTurn(led, { sessionId: 's-b', turn: 1, time: dayA + 5000, provider: 'workbuddy2api' });
  const deps = { tokenLedger: led, tokenProvidersPure: providers, priceTable: DEFAULT_PRICE_TABLE };
  const handler = createConsoleJournal(deps).handleConsoleJournal;
  const call = async (pathName, headers = {}) => {
    const out = { status: 0, payload: null };
    const request = {
      req: { method: 'GET', headers },
      method: 'GET',
      url: new URL(`http://127.0.0.1:3100${pathName}`),
      sendJson: (payload, status = 200) => { out.payload = payload; out.status = status; }
    };
    const done = await handler(request);
    return { ...out, done };
  };
  const ok = await call('/api/tokens/providers?range=today&basis=billed');
  assert(ok.status === 200 && ok.payload.ok === true, 'range=today&basis=billed → 200');
  assert(ok.payload.providers.length === 2, `两个 provider（实得 ${ok.payload.providers.length}）`);
  assert(ok.payload.total.billed > 0, '有 billed 合计');
  const sumShare = ok.payload.providers.reduce((acc, row) => acc + row.share, 0);
  const sumSharePct = ok.payload.providers.reduce((acc, row) => acc + row.sharePct, 0);
  assert(Math.abs(sumShare - 1) < 0.001, `Σshare≈1（实得 ${sumShare}）`);
  assert(Math.abs(sumSharePct - 100) < 0.5, `ΣsharePct≈100（实得 ${sumSharePct}）`);
  assert(ok.payload.providers.every((row) => row.share >= 0 && row.share <= 1), '每个 share 都是 0~1 小数');
  assert(ok.payload.range.range === 'today' && ok.payload.basis === 'billed', 'range/basis 原样回显');
  assert(/billed/.test(ok.payload.note), 'note 解释计费口径');

  // 前端「全部群」下拉传字面量 all：必须当「不筛选」，否则接口回空、页面永远「没有采样」。
  const keyAll = await call('/api/tokens/providers?range=today&basis=billed&key=all');
  assert(keyAll.status === 200 && keyAll.payload.providers.length === 2, `key=all 不筛选（实得 ${keyAll.payload.providers.length} 个 provider）`);
  assert(keyAll.payload.total.tokens === ok.payload.total.tokens, 'key=all 的合计与不带 key 完全一致');
  assert(keyAll.payload.range.key === '', 'key=all 回显成空（表示未筛选）');
  const keyEmpty = await call('/api/tokens/providers?range=today&basis=billed&key=');
  assert(keyEmpty.payload.providers.length === 2 && keyEmpty.payload.total.tokens === ok.payload.total.tokens, 'key 为空同样不筛选');
  const keyAllUpper = await call('/api/tokens/providers?range=today&key=ALL');
  assert(keyAllUpper.payload.providers.length === 2, 'key=ALL 大小写不敏感');
  const keyCn = await call(`/api/tokens/providers?range=today&key=${encodeURIComponent('全部群')}`);
  assert(keyCn.payload.providers.length === 2, 'key=全部群 也不筛选');
  const keyReal = await call('/api/tokens/providers?range=today&key=group:101');
  assert(keyReal.payload.providers.length === 1 && keyReal.payload.providers[0].provider === 'deepseek-account', `真实 key 仍按会话过滤（实得 ${JSON.stringify(keyReal.payload.providers.map((r) => r.provider))}）`);

  const raw = await call('/api/tokens/providers?range=today&basis=raw');
  assert(raw.status === 200 && raw.payload.basis === 'raw', 'basis=raw → 200 且回显 raw');
  assert(raw.payload.providers[0].tokens >= raw.payload.providers[0].billed, 'raw 口径 share 按 tokens');

  const all = await call('/api/tokens/providers?range=all');
  assert(all.status === 200 && all.payload.range.days === 0, 'range=all 无窗口');

  const badRange = await call('/api/tokens/providers?range=year');
  assert(badRange.status === 400 && /range/.test(badRange.payload.error), '非法 range → 400 说清');
  const badBasis = await call('/api/tokens/providers?range=today&basis=foo');
  assert(badBasis.status === 400 && /basis/.test(badBasis.payload.error), '非法 basis → 400 说清');

  const agent = await call('/api/tokens/providers?range=today', { 'x-agent-token': 'abc' });
  assert(agent.status === 403, 'agent 令牌 → 403');
  const other = await (async () => {
    const request = { req: { method: 'GET', headers: {} }, method: 'GET', url: new URL('http://127.0.0.1:3100/api/other'), sendJson: () => {} };
    return handler(request);
  })();
  assert(other === false, '其它路径不接管');
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
process.exit(failed ? 1 : 0);
