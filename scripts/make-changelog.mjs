#!/usr/bin/env node
// 从 git log 生成本项目的更新日志（public/changelog.js）。
//
// 为什么要生成而不是手写：这份日志的价值就在于「真的是从提交记录里长出来的」——
// 改了多少次、修了多少 bug，一眼能数出来；手写一定会忘记维护，最后变成过期文案。
//
// 输出是一个静态文件 public/changelog.js（`window.__QDB_CHANGELOG = {...}`），
// 由桥接照 /client.js 那套白名单直发；控制台设置页点「查看更新日志」时才读它。
//
// 用法：
//   node scripts/make-changelog.mjs                 # 写 public/changelog.js
//   node scripts/make-changelog.mjs --limit 200     # 只留最近 200 条（总数仍统计全部）
//   node scripts/make-changelog.mjs --check         # 只校验现有文件是不是最新的
//   node scripts/make-changelog.mjs --json          # 打到 stdout，方便别的脚本吃
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'changelog.js');

// 提交首行的前缀 → 前端显示的标签。没写前缀的统一归到「其他」。
const TYPES = [
  { type: 'feat', label: '新增', tone: 'ok' },
  { type: 'fix', label: '修复', tone: 'warn' },
  { type: 'perf', label: '优化', tone: 'accent' },
  { type: 'refactor', label: '重构', tone: 'muted' },
  { type: 'docs', label: '文档', tone: 'muted' },
  { type: 'chore', label: '杂项', tone: 'muted' },
  { type: 'test', label: '测试', tone: 'muted' },
  { type: 'build', label: '构建', tone: 'muted' },
  { type: 'style', label: '样式', tone: 'muted' },
  { type: 'revert', label: '回滚', tone: 'warn' },
  { type: 'other', label: '改动', tone: 'muted' }
];
const TYPE_BY_ID = new Map(TYPES.map((t) => [t.type, t]));

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { limit: 0, check: false, json: false, out: OUT };
  for (const arg of argv) {
    if (arg === '--check') out.check = true;
    else if (arg === '--json') out.json = true;
    else if (arg.startsWith('--limit=')) out.limit = Math.max(0, parseInt(arg.slice(8), 10) || 0);
    else if (arg.startsWith('--out=')) out.out = path.resolve(ROOT, arg.slice(6));
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return out;
}

// git log 用 %x1f 当字段分隔、%x1e 当提交分隔：这两个控制字符不会出现在提交信息里，
// 比用 \n\n 硬切口安全（正文里本来就有空行）。
export function readCommits(cwd = ROOT) {
  const raw = execFileSync('git', ['log', '--no-merges', '--date=short', '--pretty=format:%H%x1f%ad%x1f%s%x1f%b%x1e'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const out = [];
  for (const chunk of raw.split('\x1e')) {
    const text = chunk.replace(/^\n+/, '');
    if (!text) continue;
    const [hash, date, subject, body = ''] = text.split('\x1f');
    if (!hash || !date || !subject) continue;
    out.push({ hash: hash.trim(), date: date.trim(), subject: subject.trim(), body: body.trim() });
  }
  return out;
}

// 早期提交用的是中文前缀（「文档：…」「T21：…」），也认一下，别让它们全掉进「改动」。
const CN_PREFIX = { 文档: 'docs', 修复: 'fix', 优化: 'perf', 重构: 'refactor', 新增: 'feat', 测试: 'test', 构建: 'build', 样式: 'style' };

// 首行可能是 `fix(console): 会话三处…`；拆出 type 与「去掉前缀后的人话」。
export function splitSubject(subject) {
  const m = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.*)$/.exec(subject);
  if (m) {
    const type = TYPE_BY_ID.has(m[1]) ? m[1] : 'other';
    return { type, scope: m[2] || '', text: m[3] || subject };
  }
  const cn = /^(文档|修复|优化|重构|新增|测试|构建|样式)[：:]\s*(.*)$/.exec(subject);
  if (cn) return { type: CN_PREFIX[cn[1]], scope: '', text: cn[2] || subject };
  return { type: 'other', scope: '', text: subject };
}

// 正文只取第一段第一句：日志里要的是「为什么」，不是完整提交信息。
export function firstSentence(body) {
  const line = String(body || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    // 正文里的元信息行（Co-authored-by、Signed-off-by、逗号分隔的技术清单）不进日志
    .find((s) => s && !/^(co-authored-by|signed-off-by|change-id):/i.test(s) && !s.startsWith('- '));
  if (!line) return '';
  const cut = line.length > 180 ? line.slice(0, 178) + '…' : line;
  return cut;
}

export function buildChangelog(commits, options = {}) {
  const version = readVersion();
  const stats = Object.fromEntries(TYPES.map((t) => [t.type, 0]));
  stats.other = 0;
  const days = new Map();
  for (const c of commits) {
    const parsed = splitSubject(c.subject);
    stats[parsed.type] = (stats[parsed.type] || 0) + 1;
    if (!days.has(c.date)) days.set(c.date, []);
    days.get(c.date).push({
      h: c.hash.slice(0, 7),
      t: parsed.type,
      s: parsed.text,
      b: firstSentence(c.body)
    });
  }
  const limit = options.limit > 0 ? options.limit : 0;
  const sortedDays = [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  let kept = 0;
  const shownDays = [];
  for (const [date, items] of sortedDays) {
    if (limit && kept >= limit) break;
    const slice = limit ? items.slice(0, Math.max(0, limit - kept)) : items;
    if (!slice.length) continue;
    kept += slice.length;
    shownDays.push({ d: date, n: slice.length, items: slice });
  }
  const dates = [...days.keys()].sort();
  return {
    // 生成时间只写日期，不写具体时分：否则每次生成都产生 diff，提交记录里会冒出一堆纯噪音
    generatedAt: new Date().toISOString().slice(0, 10),
    version,
    total: commits.length,
    limit,
    // 最新一条的短 hash：校验时用它把文件锚回 git log 里，允许之后再有新提交
    top: commits.length ? commits[0].hash.slice(0, 7) : '',
    shown: kept,
    since: dates[0] || '',
    until: dates[dates.length - 1] || '',
    days: dates.length,
    types: stats,
    labels: TYPES.map((t) => ({ t: t.type, n: t.label })),
    groups: shownDays
  };
}

// 校验一个已生成的数据块是否与 git log 一致。
//
// 允许「文件比 git log 少几条最新提交」：日志文件本身要跟提交一起入库，它自己的那笔提交
// 永远追不进去（追一次就多一支提交，又落后一条，死循环）。所以这里只要求：
//   · 文件里每条改动的短 hash 在 git log 里还找得到；
//   · 那条提交的标题（去掉前缀后）与文件里写的一致；
//   · 类型统计合计等于总数。
// 历史被改写、标题被手改、统计对不上都会在这里变红。
export function verifyData(data, commits) {
  if (!data || !Array.isArray(data.groups)) return { ok: false, reason: '文件里没有 groups（读不到/不是本脚本生成的）' };
  if (!commits.length) return { ok: false, reason: 'git log 是空的' };
  const byHash = new Map(commits.map((c) => [c.hash.slice(0, 7), c]));
  const missing = [];
  const mismatch = [];
  let count = 0;
  for (const group of data.groups) {
    for (const item of group.items || []) {
      count += 1;
      const commit = byHash.get(item.h);
      if (!commit) { missing.push(item.h); continue; }
      const parsed = splitSubject(commit.subject);
      if (parsed.text !== item.s) mismatch.push(item.h);
    }
  }
  if (missing.length) return { ok: false, reason: `${missing.length} 条提交在 git log 里找不到（历史被改写？）：${missing.slice(0, 3).join(', ')}`, ahead: 0 };
  if (mismatch.length) return { ok: false, reason: `${mismatch.length} 条标题与 git log 不一致（被手改过？）：${mismatch.slice(0, 3).join(', ')}`, ahead: 0 };
  const sum = Object.values(data.types || {}).reduce((n, v) => n + (Number(v) || 0), 0);
  if (sum !== data.total) return { ok: false, reason: `类型统计合计 ${sum} 与总数 ${data.total} 不一致`, ahead: 0 };
  const ahead = Math.max(0, commits.length - data.total);
  return {
    ok: true,
    ahead,
    reason: ahead
      ? `校验通过（${count} 条都对得上）；git log 之后又有 ${ahead} 条新提交，打包前会重新生成`
      : `与 git log 完全同步（${count} 条都对得上）`
  };
}

function readVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '');
  } catch {
    return '';
  }
}

export function renderFile(data) {
  const json = JSON.stringify(data).replace(/<\//g, '<\\/');
  return '/* 自动生成，别手改：node scripts/make-changelog.mjs（源数据是 git log） */\n'
    + 'window.__QDB_CHANGELOG = ' + json + ';\n';
}

function main() {
  const args = parseArgs();
  if (args.help) {
    console.log('node scripts/make-changelog.mjs [--limit=N] [--check] [--json] [--out=path]');
    return 0;
  }
  const data = buildChangelog(readCommits(), { limit: args.limit });
  const content = renderFile(data);
  if (args.json) {
    process.stdout.write(content);
    return 0;
  }
  if (args.check) {
    let current = '';
    try {
      current = fs.readFileSync(args.out, 'utf8');
    } catch {
      current = '';
    }
    const sandbox = { window: {} };
    try {
      vm.runInNewContext(current, sandbox);
    } catch {
      console.log('changelog 读不出来（文件坏了或没生成过）：跑 node scripts/make-changelog.mjs');
      return 1;
    }
    const result = verifyData(sandbox.window.__QDB_CHANGELOG, readCommits());
    console.log(result.ok ? `changelog 与 git log 一致：${result.reason}` : `changelog 与 git log 不一致：${result.reason}`);
    return result.ok ? 0 : 1;
  }
  fs.writeFileSync(args.out, content, 'utf8');
  console.log(`已写 ${path.relative(ROOT, args.out)}：${data.shown}/${data.total} 条提交、${data.days} 天、版本 ${data.version}、${(content.length / 1024).toFixed(1)} KB`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
