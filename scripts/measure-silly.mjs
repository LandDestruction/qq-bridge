#!/usr/bin/env node
// 「变笨」五指标一键度量（**只读**）。
//
// 背景：`docs/why-silly.md §2` 把「机器人显得笨」拆成五个可量化的指标，但此前每次都要
// 人手一条条去 state 里翻。这个脚本把它们一次跑完，输出人读摘要（默认）或 --json。
//
// 五个指标与数据来源：
//   ① 发言质量   state/social-v2.json 里 isSelf 的最近 50 条：字数中位/上限、问句占比、近重复率、纯表情占比
//   ② 想/说比    state/token-usage.jsonl 的 turn 行（b.reasoning vs b.output）；DSH 会话日志只作旁证
//   ③ 唤醒提示   GET /api/debug/prompt-parts（带 x-console-token）各族字符数与总数
//   ④ 固定开销   DSH 会话日志 session.v4.jsonl.zstd 的 system/message + request/header.tools vs 对话正文
//   ⑤ 模型分布   state/token-usage.jsonl 最近 200 条的 provider/model 分布
//
// 硬约束（对应任务红线）：**只读**。不写 state/config、不重启桥接、不发群消息。
// 唯一的网络动作是 GET 本机控制台的 /api/debug/prompt-parts；`--selftest` 全程离线。
//
// 关于 DSH 会话日志的一个坑：`.zstd` 文件是**多帧追加**写的（每条记录一帧），
// `zlib.zstdDecompressSync()` 和流式解压都**只吃第一帧**，直接读会得到 1 行 session 头。
// 这里按 zstd 魔数 `28 B5 2F FD` 逐帧切开再解，实测 294 帧 / 517 条记录 / 0 失败。
//
// 用法：
//   node scripts/measure-silly.mjs                 # 人读摘要
//   node scripts/measure-silly.mjs --json          # 机器可读
//   node scripts/measure-silly.mjs --selftest      # 用临时样例跑通五段（离线，不碰真实数据）
//   node scripts/measure-silly.mjs --state <dir> --sessions <dir> --usage <file> --endpoint <url>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 通用小工具 ─────────────────────────────────────────────────────────────
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function readJsonl(file, limit = 0) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const lines = raw.split('\n').filter((s) => s.trim());
  const use = limit > 0 ? lines.slice(-limit) : lines;
  const out = [];
  for (const l of use) { try { out.push(JSON.parse(l)); } catch { /* 坏行跳过 */ } }
  return out;
}
const chars = (s) => String(s ?? '').length;
const pct = (n, d) => (d > 0 ? Number(((n / d) * 100).toFixed(1)) : null);
function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Number(((a[m - 1] + a[m]) / 2).toFixed(1));
}
// 归一化后比较：去掉空白与标点，只留内容，避免「好 的」和「好的」被当成两条不同的
function normalizeReply(text) {
  return String(text ?? '')
    .replace(/\[[^\]]{1,12}\]/g, '')            // 表情/图片占位符
    .replace(/[\s\u3000]/g, '')
    .replace(/[,.!?;:~，。！？；：、…—－\-"'“”‘’()（）【】\[\]]/g, '')
    .toLowerCase();
}
/** 编辑距离 ≤1 视为「改一个字」的复读（长度差 >1 直接排除）。 */
export function isNearDuplicate(a, b) {
  const x = normalizeReply(a); const y = normalizeReply(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.abs(x.length - y.length) > 1) return false;
  if (x.length === y.length) {
    let diff = 0;
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) { diff += 1; if (diff > 1) return false; }
    return diff === 1;
  }
  // 长度差 1：短的插一个字符能变成长的
  const [s, l] = x.length < y.length ? [x, y] : [y, x];
  let i = 0; let j = 0; let skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i += 1; j += 1; continue; }
    if (skipped) return false;
    skipped = true; j += 1;
  }
  return true;
}

// ── ① 发言质量 ─────────────────────────────────────────────────────────────
export function measureReplyQuality(socialV2, { limit = 50 } = {}) {
  const convs = socialV2?.conversations && typeof socialV2.conversations === 'object' ? socialV2.conversations : {};
  const mine = [];
  for (const [key, conv] of Object.entries(convs)) {
    for (const m of (Array.isArray(conv?.recentMessages) ? conv.recentMessages : [])) {
      if (!m || m.isSelf !== true) continue;
      const text = String(m.text ?? '').trim();
      if (!text) continue;
      mine.push({ key, text, time: Number(m.time) || 0 });
    }
  }
  mine.sort((a, b) => b.time - a.time);
  const top = mine.slice(0, Math.max(1, limit));
  const lens = top.map((m) => chars(m.text));
  const question = top.filter((m) => /[?？]\s*$/.test(m.text)).length;
  const emojiOnly = top.filter((m) => {
    const t = m.text;
    return /^(\s*\[[^\]]{1,12}\]\s*)+$/.test(t) || /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(t);
  }).length;
  // 近重复率：有多少条能在同批里找到「同句 / 改一个字的复读」（自己不算）
  let dupCount = 0;
  for (let i = 0; i < top.length; i += 1) {
    let dup = false;
    for (let j = 0; j < top.length && !dup; j += 1) {
      if (i !== j && isNearDuplicate(top[i].text, top[j].text)) dup = true;
    }
    if (dup) dupCount += 1;
  }
  return {
    conversations: Object.keys(convs).length,
    available: mine.length,
    sampled: top.length,
    chars: { median: median(lens), max: lens.length ? Math.max(...lens) : null, min: lens.length ? Math.min(...lens) : null, total: lens.reduce((a, b) => a + b, 0) },
    questionRatio: pct(question, top.length),
    questionCount: question,
    nearDupRatio: pct(dupCount, top.length),
    nearDupCount: dupCount,
    emojiOnlyRatio: pct(emojiOnly, top.length),
    samples: top.slice(0, 5).map((m) => ({ key: m.key, len: chars(m.text), text: m.text.slice(0, 80) }))
  };
}

// ── ② 想/说比 ──────────────────────────────────────────────────────────────
export function measureThinkingRatio(usageRows, { turns = 200 } = {}) {
  const rows = (Array.isArray(usageRows) ? usageRows : []).filter((r) => r && r.k === 'turn');
  const top = rows.slice(-turns);
  let reasoning = 0; let output = 0; let zeroReasoning = 0;
  const perTurn = [];
  for (const r of top) {
    const b = r.b || {};
    const re = Number(b.reasoning) || 0;
    const ou = Number(b.output) || 0;
    reasoning += re; output += ou;
    if (re === 0 && ou > 0) zeroReasoning += 1;
    if (ou > 0) perTurn.push(re / ou);
  }
  return {
    source: 'state/token-usage.jsonl（k=turn 行的 b.reasoning / b.output）',
    turns: top.length,
    reasoningTokens: reasoning,
    outputTokens: output,
    // 想/说比 = 推理 token / 输出 token；输出为 0 时无意义，报 null
    ratio: output > 0 ? Number((reasoning / output).toFixed(3)) : null,
    medianPerTurn: perTurn.length ? Number(median(perTurn).toFixed(3)) : null,
    zeroReasoningTurns: zeroReasoning,
    note: reasoning === 0
      ? '推理 token 全程为 0：要么该档位不产 reasoning，要么中转把 reasoning 吞了 —— 两种都意味着「想」这一步实际上没发生。'
      : ''
  };
}

// ── ③ 唤醒提示各族字符数 ───────────────────────────────────────────────────
export function measurePromptParts(partsJson) {
  const parts = Array.isArray(partsJson?.parts) ? partsJson.parts : [];
  const list = parts
    .map((p) => ({ name: String(p.name ?? '?'), chars: Number(p.chars) || 0 }))
    .filter((p) => p.chars > 0)
    .sort((a, b) => b.chars - a.chars);
  const total = list.reduce((n, p) => n + p.chars, 0);
  return {
    available: list.length > 0,
    total: Number.isFinite(partsJson?.total) ? partsJson.total : total,
    parts: list,
    families: list.length,
    top3Share: pct(list.slice(0, 3).reduce((n, p) => n + p.chars, 0), total),
    note: list.length ? '' : '没拿到零件：桥接可能刚启动还没装配过一轮，或接口不通（见 --help 里的排查）'
  };
}

// ── ④ 固定开销 vs 对话占比 ────────────────────────────────────────────────
/** 把 DSH 会话日志的 `.zstd`（**多帧追加**）逐帧解开；单帧解压只给第一行，不能用。 */
export function decodeZstdFrames(buf) {
  const MAGIC = Buffer.from([0x28, 0xB5, 0x2f, 0xfd]);
  const offs = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i >= 0) { offs.push(i); i = buf.indexOf(MAGIC, i + 4); }
  if (!offs.length) { try { return zlib.zstdDecompressSync(buf); } catch { return Buffer.alloc(0); } }
  const out = [];
  for (let k = 0; k < offs.length; k += 1) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { out.push(zlib.zstdDecompressSync(buf.subarray(offs[k], end))); } catch { /* 单帧坏掉不影响其它 */ }
  }
  return Buffer.concat(out);
}
export function readSessionRecords(file) {
  try {
    const raw = decodeZstdFrames(fs.readFileSync(file)).toString('utf8');
    return raw.split('\n').filter((s) => s.trim()).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
/** 从消息对象的 content 里只取 text 部分（工具调用/图片块不算「说话」）。 */
function textOfMessage(msg) {
  const content = Array.isArray(msg?.content) ? msg.content : [];
  let n = 0;
  for (const part of content) {
    if (part && (part.type === 'text' || typeof part.text === 'string')) n += chars(part.text);
  }
  return n;
}
export function measureFixedOverhead(records) {
  const recs = Array.isArray(records) ? records : [];
  const systems = recs.filter((r) => r.type === 'system/message');
  const headers = recs.filter((r) => r.type === 'request/header');
  const userMsgs = recs.filter((r) => r.type === 'user/message');
  const asstMsgs = recs.filter((r) => r.type === 'assistant/message');
  if (!systems.length && !headers.length) {
    return { available: false, reason: '会话日志里没有 system/message 与 request/header 记录' };
  }
  // 取**最后一条**（当前这一轮实际用的），多条时也给个区间
  const sysChars = systems.length ? textOfMessage(systems[systems.length - 1].data?.message) : 0;
  const hdr = headers.length ? headers[headers.length - 1].data?.header : null;
  const tools = Array.isArray(hdr?.tools) ? hdr.tools : [];
  const toolsChars = tools.length ? chars(JSON.stringify(tools)) : 0;
  const conversation = userMsgs.reduce((n, r) => n + textOfMessage(r.data?.message || r.data), 0)
    + asstMsgs.reduce((n, r) => n + textOfMessage(r.data?.message || r.data), 0);
  const fixed = sysChars + toolsChars;
  return {
    available: true,
    systemChars: sysChars,
    toolCount: tools.length,
    toolsChars,
    fixedChars: fixed,
    conversationChars: conversation,
    fixedShare: pct(fixed, fixed + conversation),
    conversationShare: pct(conversation, fixed + conversation),
    ratio: conversation > 0 ? Number((fixed / conversation).toFixed(2)) : null,
    config: hdr?.config || null,
    samples: { systemMessages: systems.length, headers: headers.length, userMessages: userMsgs.length, assistantMessages: asstMsgs.length }
  };
}

// ── ⑤ 模型分布 ─────────────────────────────────────────────────────────────
export function measureModelDistribution(rows, { limit = 200 } = {}) {
  const top = (Array.isArray(rows) ? rows : []).slice(-limit);
  const byModel = new Map();
  const byProvider = new Map();
  for (const r of top) {
    const model = String(r?.model ?? '(未知)');
    const provider = String(r?.provider ?? '(未知)');
    byModel.set(model, (byModel.get(model) || 0) + 1);
    byProvider.set(provider, (byProvider.get(provider) || 0) + 1);
  }
  const sortDesc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n, share: pct(n, top.length) }));
  return { rows: top.length, byModel: sortDesc(byModel), byProvider: sortDesc(byProvider) };
}

// ── 采集（只读） ───────────────────────────────────────────────────────────
function sessionDirFor(cwd) {
  const key = `--${String(cwd).replace(/[:]/g, '').replace(/[\\/]/g, '-')}--`;
  return path.join(os.homedir(), '.dsh', 'sessions', key);
}
function newestSessionFile(dir) {
  try {
    const files = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.zstd')) files.push({ full, m: fs.statSync(full).mtimeMs });
      else if (e.isDirectory()) {
        const sub = path.join(full, 'session.v4.jsonl.zstd');
        if (fs.existsSync(sub)) files.push({ full: sub, m: fs.statSync(sub).mtimeMs });
      }
    }
    files.sort((a, b) => b.m - a.m);
    return files[0]?.full || null;
  } catch { return null; }
}
async function fetchPromptParts(endpoint, configFiles = []) {
  // 令牌现取现用，绝不打印、绝不落盘
  let token = '';
  for (const f of configFiles) {
    const t = String(readJson(f)?.consoleToken ?? '').trim();
    if (t) { token = t; break; }
  }
  if (!token) {
    for (const f of configFiles.map((x) => path.join(path.dirname(x), 'state', 'console-token'))) {
      try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) { token = t; break; } } catch {}
    }
  }
  if (!token) return { ok: false, error: `读不到 consoleToken（试过：${configFiles.join(' / ')} 及各自 state/console-token）` };
  try {
    const r = await fetch(endpoint.replace(/\/+$/, '') + '/api/debug/prompt-parts', { headers: { 'x-console-token': token }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true, json: await r.json() };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

export async function collect(opts = {}) {
  const stateDir = opts.stateDir || path.join(ROOT, 'state');
  const usageFile = opts.usageFile || path.join(stateDir, 'token-usage.jsonl');
  const socialFile = opts.socialFile || path.join(stateDir, 'social-v2.json');
  const sessionCwd = opts.sessionCwd || path.join(stateDir, 'agents');
  const sessionDir = opts.sessionDir || sessionDirFor(sessionCwd);
  const sessionFile = opts.sessionFile || newestSessionFile(sessionDir);

  const usageRows = opts.usageRows || readJsonl(usageFile);
  const social = opts.socialV2 || readJson(socialFile);
  const records = opts.sessionRecords || (sessionFile ? readSessionRecords(sessionFile) : []);

  let parts = opts.promptParts;
  if (!parts) {
    // 从工作树跑时真实 config.json 在 --state 的上级目录，这里一并试
    const cfgFiles = [opts.configFile, path.join(stateDir, '..', 'config.json'), path.join(ROOT, 'config.json')]
      .filter(Boolean).filter((f, i, a) => a.indexOf(f) === i);
    parts = opts.promptPartsJson || await fetchPromptParts(opts.endpoint || 'http://127.0.0.1:3100', cfgFiles);
  }
  const partsJson = parts?.ok === false ? null : (parts?.json ?? parts);

  return {
    generatedAt: new Date().toISOString(),
    paths: { stateDir, usageFile, socialFile, sessionDir, sessionFile },
    reply: measureReplyQuality(social, { limit: opts.replyLimit || 50 }),
    thinking: measureThinkingRatio(usageRows),
    promptParts: partsJson ? measurePromptParts(partsJson) : { available: false, total: 0, parts: [], families: 0, note: `不可得：${parts?.error || '接口未返回'}` },
    fixed: measureFixedOverhead(records),
    models: measureModelDistribution(usageRows, { limit: 200 })
  };
}

// ── 输出 ───────────────────────────────────────────────────────────────────
export function renderReport(r) {
  const L = [];
  L.push(`「变笨」五指标度量（只读） ${r.generatedAt}`);
  L.push(`数据：${r.paths.stateDir}`);
  L.push('');
  const q = r.reply;
  L.push('① 发言质量（最近 ' + q.sampled + ' 条机器人发言 / 库存 ' + q.available + ' 条，' + q.conversations + ' 个会话）');
  L.push(`   字数  中位 ${q.chars.median ?? '-'} / 上限 ${q.chars.max ?? '-'} / 下限 ${q.chars.min ?? '-'} / 合计 ${q.chars.total}`);
  L.push(`   问句占比 ${q.questionRatio ?? '-'}%（${q.questionCount}/${q.sampled}）`);
  L.push(`   近重复率 ${q.nearDupRatio ?? '-'}%（${q.nearDupCount}/${q.sampled} 条能找到同句或改一字的复读）`);
  L.push(`   纯表情占比 ${q.emojiOnlyRatio ?? '-'}%`);
  for (const s of q.samples) L.push(`   · [${s.len}字] ${s.text}`);
  L.push('');
  const t = r.thinking;
  L.push(`② 想/说比（${t.turns} 轮 turn 行）`);
  L.push(`   推理 token ${t.reasoningTokens} / 输出 token ${t.outputTokens} → 比 ${t.ratio ?? '不可得'}（每轮中位 ${t.medianPerTurn ?? '-'}）`);
  L.push(`   全程无推理的轮次 ${t.zeroReasoningTurns}/${t.turns}`);
  if (t.note) L.push(`   ⚠️ ${t.note}`);
  L.push('');
  const p = r.promptParts;
  L.push(`③ 唤醒提示各块字符数${p.available ? '' : '（不可得）'}`);
  if (p.available) {
    L.push(`   合计 ${p.total} 字符 / ${p.families} 块；前三块占 ${p.top3Share}%`);
    for (const x of p.parts) L.push(`   · ${x.name} ${x.chars}`);
  } else L.push(`   ${p.note}`);
  L.push('');
  const f = r.fixed;
  L.push('④ 固定开销 vs 对话占比（DSH 会话日志）');
  if (f.available) {
    L.push(`   系统提示 ${f.systemChars} + 工具 schema ${f.toolsChars}（${f.toolCount} 个）= 固定 ${f.fixedChars} 字符`);
    L.push(`   对话正文 ${f.conversationChars} 字符 → 固定占 ${f.fixedShare}%，对话占 ${f.conversationShare}%（固定是对话的 ${f.ratio} 倍）`);
    L.push(`   记录：system ${f.samples.systemMessages} / header ${f.samples.headers} / user ${f.samples.userMessages} / assistant ${f.samples.assistantMessages}`);
  } else L.push(`   ${f.reason}（路径：${r.paths.sessionFile || r.paths.sessionDir}）`);
  L.push('');
  const m = r.models;
  L.push(`⑤ 模型分布（最近 ${m.rows} 条 token-usage）`);
  for (const x of m.byModel) L.push(`   · ${x.name} ${x.n} 条（${x.share}%）`);
  if (m.byProvider.length > 1) L.push(`   provider：${m.byProvider.map((x) => `${x.name} ${x.n}`).join(' / ')}`);
  return L.join('\n');
}

// ── selftest：临时样例跑通五段（离线） ─────────────────────────────────────
async function selftest() {
  let pass = 0; const fails = [];
  const chk = (name, fn) => { try { fn(); pass += 1; console.log('✓ ' + name); } catch (e) { fails.push(name); console.error('✗ ' + name + ' — ' + (e?.message ?? e)); } };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-silly-'));
  try {
    // ① 固定样例：6 条自己发言（其中 2 条是「好」「好！」= 近重复；1 条问句；1 条纯表情）
    const social = { conversations: { 'group:1': { recentMessages: [
      { text: '好', isSelf: true, time: 100 },
      { text: '好！', isSelf: true, time: 200 },
      { text: '你们在聊什么？', isSelf: true, time: 300 },
      { text: '[表情]', isSelf: true, time: 400 },
      { text: '我先去忙', isSelf: true, time: 500 },
      { text: '别人说的不算', isSelf: false, time: 600 }
    ] } } };
    const q = measureReplyQuality(social, { limit: 50 });
    chk('① 只统计 isSelf，问句/近重复/纯表情算得对', () => {
      assert(q.sampled === 5, '样本应 5 条，实际 ' + q.sampled);
      assert(q.questionCount === 1, '问句应 1 条，实际 ' + q.questionCount);
      assert(q.nearDupCount === 2, '近重复应 2 条（好/好！），实际 ' + q.nearDupCount);
      assert(q.emojiOnlyRatio === 20, '纯表情应 20%，实际 ' + q.emojiOnlyRatio);
      assert(q.chars.max === 7, '最长应 7 字（你们在聊什么？），实际 ' + q.chars.max);
    });
    chk('① isNearDuplicate：同句 / 改一字 / 加标点算重复，无关句不算', () => {
      assert(isNearDuplicate('好的', '好的') === true, '同句');
      assert(isNearDuplicate('好的', '好的！') === true, '标点差异');
      assert(isNearDuplicate('好的呀', '好的') === true, '多一字');
      assert(isNearDuplicate('好的', '不行') === false, '无关句');
    });

    // ② token-usage 样例：3 轮，其中 2 轮 reasoning=0
    const usage = [
      { k: 'turn', model: 'deepseek-v4.1-flash', provider: 'workbuddy2api', b: { reasoning: 0, output: 100 } },
      { k: 'turn', model: 'deepseek-v4.1-flash', provider: 'workbuddy2api', b: { reasoning: 50, output: 100 } },
      { k: 'turn', model: 'deepseek-flash', provider: 'deepseek-account', b: { reasoning: 0, output: 200 } },
      { k: 'base', model: 'deepseek-flash', provider: 'deepseek-account', b: { reasoning: 0, output: 0 } }
    ];
    chk('② 想/说比与「无推理轮次」算得对', () => {
      const t = measureThinkingRatio(usage);
      assert(t.turns === 3, '只算 k=turn，应 3 轮，实际 ' + t.turns);
      assert(t.reasoningTokens === 50 && t.outputTokens === 400, '应为 50/400');
      assert(t.ratio === 0.125, '比值应 0.125，实际 ' + t.ratio);
      assert(t.zeroReasoningTurns === 2, '无推理轮次应 2，实际 ' + t.zeroReasoningTurns);
    });
    chk('⑤ 模型分布只取最近 N 条', () => {
      const m = measureModelDistribution(usage, { limit: 3 });
      assert(m.rows === 3, '应取 3 条');
      // 末三条 = [v4.1 的 turn2, deepseek-flash 的 turn3, deepseek-flash 的 base]
      assert(m.byModel[0].name === 'deepseek-flash' && m.byModel[0].n === 2, 'deepseek-flash 应 2 条，实际 ' + JSON.stringify(m.byModel));
      assert(m.byProvider.length === 2, 'provider 应 2 种');
    });

    // ③ prompt-parts 样例
    chk('③ 各块字符数、总数、前三占比', () => {
      const p = measurePromptParts({ ok: true, total: 300, parts: [{ name: 'a', chars: 100 }, { name: 'b', chars: 90 }, { name: 'c', chars: 80 }, { name: 'd', chars: 30 }, { name: 'zero', chars: 0 }] });
      assert(p.families === 4, 'chars=0 的不计，应 4 块，实际 ' + p.families);
      assert(p.total === 300, '总数应 300');
      assert(p.top3Share === 90, '前三占比应 90%，实际 ' + p.top3Share);
    });
    chk('③ 拿不到零件时报不可得而不是崩', () => {
      const p = measurePromptParts(null);
      assert(p.available === false && p.total === 0, '应为不可得');
    });

    // ④ 真实走一遍「多帧 zstd」：每条记录压一帧，验证逐帧解码
    const recs = [
      { type: 'session', id: 's1' },
      { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'x'.repeat(1000) }] } } },
      { type: 'request/header', data: { header: { tools: [{ name: 't', description: 'y'.repeat(500) }], config: { provider: 'p', model: 'm' } } } },
      { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'u'.repeat(50) }] } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a'.repeat(100) }] } } }
    ];
    const frames = Buffer.concat(recs.map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8'))));
    const sf = path.join(dir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(sf, frames);
    chk('④ 多帧 zstd 能逐帧解出全部记录（单帧解压的坑）', () => {
      const got = readSessionRecords(sf);
      assert(got.length === recs.length, `应解出 ${recs.length} 条，实际 ${got.length}`);
      assert(got[1].type === 'system/message', '第二条应是 system/message');
    });
    chk('④ 固定开销 = 系统提示 + 工具 schema，占比算得对', () => {
      const f = measureFixedOverhead(readSessionRecords(sf));
      assert(f.available === true, '应可得');
      assert(f.systemChars === 1000, '系统提示应 1000 字，实际 ' + f.systemChars);
      assert(f.toolCount === 1 && f.toolsChars > 500, '工具 schema 字符数应含描述');
      assert(f.conversationChars === 150, '对话应 50+100=150 字，实际 ' + f.conversationChars);
      assert(f.fixedShare > 80, '固定占比应远大于 80%，实际 ' + f.fixedShare);
    });
    chk('④ 没有 system/header 时如实报不可得', () => {
      const f = measureFixedOverhead([{ type: 'user/message', data: {} }]);
      assert(f.available === false && f.reason, '应为不可得并给原因');
    });

    // 汇总：collect() 走一遍临时目录，保证五段能拼成一份报告
    fs.writeFileSync(path.join(dir, 'social-v2.json'), JSON.stringify(social));
    fs.writeFileSync(path.join(dir, 'token-usage.jsonl'), usage.map((u) => JSON.stringify(u)).join('\n'));
    const report = await collect({ stateDir: dir, socialFile: path.join(dir, 'social-v2.json'), usageFile: path.join(dir, 'token-usage.jsonl'), sessionRecords: readSessionRecords(sf), promptParts: { ok: true, json: { ok: true, total: 300, parts: [{ name: 'a', chars: 300 }] } } });
    chk('汇总：五段齐全，能渲染成报告且 JSON 可序列化', () => {
      const txt = renderReport(report);
      for (const mark of ['①', '②', '③', '④', '⑤']) assert(txt.includes(mark), '报告缺 ' + mark);
      assert(JSON.stringify(report).length > 200, 'JSON 应可序列化');
    });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${fails.length ? '✗' : '✓'} selftest ${pass}/${pass + fails.length} 通过`);
  process.exit(fails.length ? 1 : 0);
}

// ── 入口 ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined; };

if (flag('selftest')) {
  await selftest();
} else if (flag('help')) {
  console.log('用法：node scripts/measure-silly.mjs [--json] [--selftest]\n  --state <dir>       默认 <repo>/state\n  --sessions <dir>    默认 ~/.dsh/sessions/--<sessionCwd mangled>--\n  --usage <file>      默认 <state>/token-usage.jsonl\n  --endpoint <url>    默认 http://127.0.0.1:3100\n  --limit <n>         发言样本条数（默认 50）');
  process.exit(0);
} else {
  const report = await collect({
    stateDir: opt('state'),
    sessionDir: opt('sessions'),
    usageFile: opt('usage'),
    endpoint: opt('endpoint'),
    replyLimit: Number(opt('limit')) || undefined
  });
  if (flag('json')) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReport(report));
}
