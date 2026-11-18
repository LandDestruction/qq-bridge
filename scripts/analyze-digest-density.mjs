#!/usr/bin/env node
/**
 * D34 只读分析器：量化「跨会话摘要」的信息密度。
 *
 * 为什么要有：用户说「跨群记忆体感没有」，主窗口已经定位到三条原因，但「摘要质量低」只是形容词。
 * 没有数字就没法判断改法值不值得做、做完是不是真的变好。这个脚本把「质量」拆成可数的东西：
 *
 *   ① 占位符占比   [图片] / [表情包:…] / [视频…] / [文件…] 吃掉了多少字符
 *   ② 截断尾巴     有多少条 segment 被砍成半句（含「人名：」后直接没了）
 *   ③ 有效信息对数 形如「人名：≥6 字内容」且不是纯占位符的 segment 数
 *   ④ 自说自话占比 「我：」segment 数与字符占比
 *   ⑤ 假话题率     topics 里有多少以虚词开头（「算了」「你叫什么都行」这类）
 *   ⑥ 新鲜度       now - at（注入时模型看到的是几小时前的事）
 *   ⑦ 注入块总量   pickDigests + renderDigestBlock 的真实产物（直接 import 生产函数，不另写一份）
 *
 * 只读：只读 state/config，不写任何文件（--selftest 跑在临时目录、断言线上文件 sha256 不变）。
 *
 * 用法：
 *   node scripts/analyze-digest-density.mjs                      # 线上 state/config（只读）
 *   node scripts/analyze-digest-density.mjs --json               # 机器可读
 *   node scripts/analyze-digest-density.mjs --state <dir> --config <file>
 *   node scripts/analyze-digest-density.mjs --selftest           # 自证 12 项
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DIGEST_DEFAULTS, pickDigests, renderDigestBlock } from '../src/cross-session-memory.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ── 方言：哪些是「占位符」而不是内容 ────────────────────────────────────────
// 与 src/bridge.js 里媒体归一化后的写法对齐：图片/表情包/视频/文件/语音/转发/拍一拍。
const PLACEHOLDER_RE = /\[(?:图片|表情包[^\]]*|视频[^\]]*|文件[^\]]*|语音[^\]]*|转发[^\]]*|拍一拍[^\]]*)\]/g;

// 虚词/口水词：以它们开头的话题串基本不可能是「值得检索的主题」。
// 注意这是**启发式**：会误伤「算法」「行为」这类真词，所以只用来看趋势，不当判据用。
const STOP_PREFIX = new Set(('的了着过是我你他她它这那哪就都也还又再才只没不别很太真更最和与及或者而但因所以如果然后可能应该是要有把被让给对从到在吗吧啊嗯哦呃呀哈嘿咦喂啥嘛呢'
  + '一二三四五六七八九十第个条点些样种次回天年').split(''));
// 常见的口语连接词/填充句：整条话题就是它们的那种，基本没有检索价值。
const JUNK_WORDS = new Set(['算了', '这个', '那个', '什么', '怎么', '可以', '不是', '就是', '然后', '所以', '但是',
  '没有', '知道', '觉得', '一样', '时候', '现在', '还是', '真的', '有点', '好像', '已经', '其实', '意思', '反正',
  '不过', '而且', '一个', '这么', '那么', '干嘛', '咋了', '好吧', '行吧']);

function isPlaceholder(text) {
  const s = String(text || '').replace(/\s+/g, '');
  if (!s) return true;
  const stripped = s.replace(PLACEHOLDER_RE, '');
  return stripped.length === 0;
}

function placeholderChars(text) {
  const s = String(text || '');
  let n = 0;
  for (const m of s.matchAll(PLACEHOLDER_RE)) n += m[0].length;
  return n;
}

function splitSegments(summary) {
  return String(summary || '').split('；').filter((x) => x.trim());
}

/** 单条 digest 的密度指标。 */
export function analyzeDigest(digest, { now = Date.now() } = {}) {
  const summary = String(digest?.summary || '');
  const segs = splitSegments(summary);
  const totalChars = summary.length;

  // ① 占位符
  const phChars = placeholderChars(summary);
  const phCount = (summary.match(PLACEHOLDER_RE) || []).length;
  // 段级：纯占位符的 segment 占了多少「信息位」——这才是「吃篇幅」的真实口径
  // （每条 segment 就是一个「人名：内容」槽位，纯 [图片] 的槽位等于浪费）
  const phSegs = segs.filter((s) => {
    const idx = s.indexOf('：');
    const body = idx > 0 ? s.slice(idx + 1) : s;
    return isPlaceholder(body);
  }).length;

  // ② 截断尾巴：最后一段没有句末标点，且不是完整的「人名：内容≥6 字」结构
  const last = segs[segs.length - 1] || '';
  const endsClean = /[。！？～…）」】"”']$/.test(summary) || summary.endsWith('…');
  const lastBody = last.includes('：') ? last.slice(last.indexOf('：') + 1) : last;
  const truncatedTail = !endsClean && (lastBody.length < 6 || last.endsWith('：') || summary.endsWith('…')) ? 1 : 0;
  const emptyTail = segs.filter((s) => s.endsWith('：')).length;

  // ③ 有效信息对 + ④ 自说自话
  let pairs = 0;
  let selfSegs = 0;
  let selfChars = 0;
  for (const s of segs) {
    const idx = s.indexOf('：');
    if (idx <= 0) continue;
    const who = s.slice(0, idx).trim();
    const body = s.slice(idx + 1).trim();
    const meaningful = body.length >= 6 && !isPlaceholder(body);
    if (who === '我') {
      selfSegs += 1;
      selfChars += s.length;
      if (meaningful) pairs += 0; // 「我：」不算他人信息
    } else if (meaningful) {
      pairs += 1;
    }
  }

  // ⑤ 假话题
  const topics = Array.isArray(digest?.topics) ? digest.topics : [];
  const junkTopics = topics.filter((t) => {
    const s = String(t);
    if (!s) return true;
    if (JUNK_WORDS.has(s)) return true;
    if (STOP_PREFIX.has(s[0])) return true;
    return PLACEHOLDER_RE.test(s);
  });

  return {
    key: String(digest?.key || ''),
    at: Number(digest?.at) || 0,
    ageHours: digest?.at ? Math.round(((Number(now) - Number(digest.at)) / 3600000) * 10) / 10 : null,
    totalChars,
    segments: segs.length,
    placeholderCount: phCount,
    placeholderChars: phChars,
    placeholderSegs: phSegs,
    placeholderSegRatio: segs.length ? Math.round((phSegs / segs.length) * 1000) / 1000 : 0,
    placeholderRatio: totalChars ? Math.round((phChars / totalChars) * 1000) / 1000 : 0,
    truncatedTail,
    emptyTail,
    meaningfulPairs: pairs,
    selfSegs,
    selfCharRatio: totalChars ? Math.round((selfChars / totalChars) * 1000) / 1000 : 0,
    charsPerPair: pairs ? Math.round((totalChars / pairs) * 10) / 10 : null,
    topics: topics.length,
    junkTopics: junkTopics.length,
    junkTopicsList: junkTopics,
    summary
  };
}

/** 整个注入块的指标（直接调用生产函数，数字与线上一致）。 */
export function analyzeBlock({ digests, currentKey, allowKeys, now = Date.now(), opts = {} }) {
  const items = pickDigests({ digests, currentKey, allowKeys, now, opts });
  const block = renderDigestBlock(items, { maxBlockChars: opts.maxBlockChars || DIGEST_DEFAULTS.maxBlockChars });
  const perItem = items.map((it) => analyzeDigest({ ...it, topics: digests?.[it.key]?.topics }, { now }));
  const dedupBlock = block.replace(/【其它会话的近况】[^\n]*\n/, '');
  const bodyChars = dedupBlock.replace(/\n/g, '').length;
  const phChars = placeholderChars(block);
  return {
    currentKey: String(currentKey || ''),
    sessions: items.length,
    blockChars: block.length,
    bodyChars,
    headerChars: block.length - bodyChars - 2,
    placeholderChars: phChars,
    placeholderRatio: block.length ? Math.round((phChars / block.length) * 1000) / 1000 : 0,
    meaningfulPairs: perItem.reduce((a, b) => a + b.meaningfulPairs, 0),
    truncatedTails: perItem.reduce((a, b) => a + b.truncatedTail, 0),
    items: perItem,
    block
  };
}

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function sha(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function pct(x) { return `${Math.round((Number(x) || 0) * 1000) / 10}%`; }

function run({ stateDir, configPath, asJson }) {
  const state = loadJson(path.join(stateDir, 'social-v2.json')) || {};
  const cfg = loadJson(configPath) || {};
  const digests = state.digests && typeof state.digests === 'object' ? state.digests : {};
  const keys = Object.keys(digests);
  const allowKeys = [
    ...(cfg.allow?.groups ?? []).map((g) => `group:${String(g)}`),
    ...(cfg.allow?.private ?? []).map((u) => `private:${String(u)}`)
  ];
  const cfgM = cfg.socialV2?.memory?.crossSession ?? {};
  const opts = {
    maxSessions: Number(cfgM.maxSessions) || DIGEST_DEFAULTS.maxSessions,
    maxCharsEach: Number(cfgM.maxCharsEach) || DIGEST_DEFAULTS.maxCharsEach,
    maxAgeMs: Number(cfgM.maxAgeMs) || DIGEST_DEFAULTS.maxAgeMs,
    maxBlockChars: Number(cfgM.maxBlockChars) || DIGEST_DEFAULTS.maxBlockChars
  };
  const now = Date.now();
  const rows = keys.map((k) => analyzeDigest({ ...digests[k], key: k }, { now }));
  const blocks = allowKeys.map((k) => analyzeBlock({ digests, currentKey: k, allowKeys, now, opts }));

  if (asJson) {
    console.log(JSON.stringify({ now, opts, digests: rows, blocks: blocks.map((b) => ({ ...b, block: b.block.trim() })) }, null, 2));
    return 0;
  }

  console.log(`跨会话摘要密度（只读）  现在 ${new Date(now).toLocaleString('zh-CN')}`);
  console.log(`state: ${path.join(stateDir, 'social-v2.json')}  digest ${rows.length} 条  config: ${JSON.stringify(cfgM)}`);
  if (!rows.length) {
    console.log('\n没有摘要可分析（digests 为空）：先让某个白名单群再收满 everyMessages 条入站。');
    return 0;
  }

  const W = (s, n) => String(s).padEnd(n);
  console.log('\n每条摘要');
  console.log(`${W('会话', 20)}${W('年龄h', 7)}${W('字数', 5)}${W('段数', 5)}${W('占位段', 7)}${W('占位比', 8)}${W('截断尾', 7)}${W('有效对', 6)}${W('我占比', 7)}${W('字/对', 6)}${W('假话题', 7)}`);
  for (const r of rows) {
    console.log(`${W(r.key, 20)}${W(r.ageHours ?? '-', 7)}${W(r.totalChars, 5)}${W(r.segments, 5)}${W(`${r.placeholderSegs}/${r.segments}`, 7)}${W(pct(r.placeholderSegRatio), 8)}${W(`${r.truncatedTail}+${r.emptyTail}`, 7)}${W(r.meaningfulPairs, 6)}${W(pct(r.selfCharRatio), 7)}${W(r.charsPerPair ?? '-', 6)}${W(`${r.junkTopics}/${r.topics}`, 7)}`);
  }

  console.log('\n各会话注入的跨群块（真实渲染，含表头）');
  console.log(`${W('当前会话', 20)}${W('条数', 5)}${W('字符', 6)}${W('占位符', 7)}${W('占位比', 8)}${W('有效对', 6)}${W('截断尾', 7)}`);
  for (const b of blocks) {
    console.log(`${W(b.currentKey, 20)}${W(b.sessions, 5)}${W(b.blockChars, 6)}${W(b.placeholderChars, 7)}${W(pct(b.placeholderRatio), 8)}${W(b.meaningfulPairs, 6)}${W(b.truncatedTails, 7)}`);
  }

  const worst = rows.slice().sort((a, b) => b.placeholderRatio - a.placeholderRatio)[0];
  const allJunk = rows.flatMap((r) => r.junkTopicsList);
  console.log('\n结论');
  console.log(`  · 占位符吃掉最多的是 ${worst.key}：${pct(worst.placeholderRatio)}（${worst.placeholderChars}/${worst.totalChars} 字符）`);
  console.log(`  · 每条摘要平均 ${Math.round(rows.reduce((a, r) => a + r.meaningfulPairs, 0) / rows.length * 10) / 10} 个「他人：有效内容」对，却占 ${Math.round(rows.reduce((a, r) => a + r.totalChars, 0) / rows.length)} 字符`);
  console.log(`  · 截断半句 ${rows.reduce((a, r) => a + r.truncatedTail, 0)} 条，「人名：」后空无一物 ${rows.reduce((a, r) => a + r.emptyTail, 0)} 条`);
  console.log(`  · topics 共 ${rows.reduce((a, r) => a + r.topics, 0)} 个，以虚词开头/占位符的有 ${allJunk.length} 个：${allJunk.slice(0, 10).join('、')}`);
  console.log(`  · 最新一条摘要 ${Math.min(...rows.map((r) => r.ageHours ?? 0))} 小时前，最旧 ${Math.max(...rows.map((r) => r.ageHours ?? 0))} 小时前`);
  return 0;
}

// ── 自测：合成样本 + 只读自证 ──────────────────────────────────────────────
function selftest() {
  let pass = 0;
  let fail = 0;
  const ok = (cond, name, extra = '') => {
    if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${extra}`); }
  };

  const sample = {
    key: 'group:1',
    at: Date.now() - 3 * 3600 * 1000,
    summary: '我：这个梗我不接啦，先溜去煮面；王耄耋：[图片]；daowen：[表情包:兴奋]；夏安：智械危机之后你养的鱼全是小飞象形态；杜十娘：你',
    topics: ['这个梗我不接', '算了', '[图片]'],
    people: ['王耄耋', 'daowen', '杜十娘']
  };
  const a = analyzeDigest(sample);
  ok(a.placeholderCount === 2, '① 数出 2 个占位符', a.placeholderCount);
  ok(a.placeholderChars === '[图片]'.length + '[表情包:兴奋]'.length, '① 占位符字符数正确', a.placeholderChars);
  ok(a.placeholderRatio > 0 && a.placeholderRatio < 1, '① 占位比在 0~1', a.placeholderRatio);
  ok(a.placeholderSegs === 2 && a.segments === 5, '① 纯占位符段 2/5（信息槽位被浪费）', `${a.placeholderSegs}/${a.segments}`);
  ok(a.truncatedTail === 1, '② 认出「杜十娘：你」是截断尾', a.truncatedTail);
  ok(a.meaningfulPairs === 1, '③ 有效对只算「我」以外的 ≥6 字内容', a.meaningfulPairs);
  ok(a.selfSegs === 1, '④ 数出 1 条「我：」', a.selfSegs);
  ok(a.selfCharRatio > 0, '④ 我占比 > 0', a.selfCharRatio);
  ok(a.junkTopics === 3, '⑤ 三个假话题全抓到', `${a.junkTopics} ${a.junkTopicsList}`);
  ok(a.ageHours === 3, '⑥ 年龄 3 小时', a.ageHours);

  const clean = analyzeDigest({ key: 'group:2', at: Date.now(), summary: '夏安：智械危机之后你养的鱼全是小飞象形态。', topics: ['智械危机'], people: ['夏安'] });
  ok(clean.placeholderCount === 0 && clean.truncatedTail === 0 && clean.meaningfulPairs === 1, '干净样本：无占位符/无截断/1 对有效');
  ok(clean.junkTopics === 0, '干净样本：topics 不误判', clean.junkTopicsList);

  // 只读自证：对真实 state 跑一遍，sha256 前后一致
  const realState = path.join(ROOT, 'state');
  const realCfg = path.join(ROOT, 'config.json');
  const before = [path.join(realState, 'social-v2.json'), realCfg, path.join(realState, 'affinity.json')].map(sha);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-density-'));
  try {
    fs.writeFileSync(path.join(tmp, 'social-v2.json'), JSON.stringify({ digests: { 'group:1': sample } }), 'utf8');
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ allow: { groups: [1] } }), 'utf8');
    const out = [];
    const origLog = console.log;
    console.log = (...args) => out.push(args.join(' '));
    run({ stateDir: tmp, configPath: path.join(tmp, 'config.json'), asJson: false });
    console.log = origLog;
    ok(out.join('\n').includes('group:1'), '空/合成 state 也能跑出结果');
    const jsonOut = [];
    console.log = (...args) => jsonOut.push(args.join(' '));
    run({ stateDir: tmp, configPath: path.join(tmp, 'config.json'), asJson: true });
    console.log = origLog;
    const parsed = JSON.parse(jsonOut.join('\n'));
    ok(parsed.digests.length === 1 && parsed.blocks.length === 1, '--json 结构正确');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const after = [path.join(realState, 'social-v2.json'), realCfg, path.join(realState, 'affinity.json')].map(sha);
  ok(before.every((h, i) => h === after[i]), '只读自证：state/config sha256 未变');

  console.log(`\n${fail === 0 ? '🎉' : '❌'} 摘要密度分析器自测：${pass}/${pass + fail}`);
  return fail === 0 ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const argOf = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  if (args.includes('--selftest')) process.exit(selftest());
  process.exit(run({
    stateDir: argOf('--state', path.join(ROOT, 'state')),
    configPath: argOf('--config', path.join(ROOT, 'config.json')),
    asJson: args.includes('--json')
  }));
}
