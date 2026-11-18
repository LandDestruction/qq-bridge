#!/usr/bin/env node
// 机器人自检（CLI）：把 AI 的全部子系统按九组体检一遍，每组都给实据数字。
//
// 用法：
//   node scripts/self-check.mjs                 人话表格
//   node scripts/self-check.mjs --json          机器可读（CI/看板用）
//   node scripts/self-check.mjs --fix           只做安全修复：拉起 Ollama、清死锁文件；其余只报告
//   node scripts/self-check.mjs --root <目录>    对另一份安装做体检（默认本仓库；工作树没有 config/state 时用这个）
//   node scripts/self-check.mjs --gap 3000      预算计数采样间隔（毫秒，默认 1500）
//
// 退出码：0 = 没有 fail（可有 warn）；1 = 有 fail；2 = 用法/环境错误。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSelfCheck, createRealDeps } from '../src/self-check.js';

const ROOT_OF_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const hasFlag = (n) => argv.includes('--' + n);
const flagVal = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? String(argv[i + 1] ?? '') : ''; };
const KNOWN = ['--json', '--fix', '--root', '--gap', '--help', '-h'];
const UNKNOWN = argv.filter((a) => a.startsWith('--') && !KNOWN.includes(a));
if (hasFlag('help') || hasFlag('h') || UNKNOWN.length) {
  console.log('用法：node scripts/self-check.mjs [--json] [--fix] [--root <目录>] [--gap <毫秒>]');
  process.exit(UNKNOWN.length ? 2 : 0);
}

const ROOT = path.resolve(flagVal('root') || ROOT_OF_SCRIPT);
if (!fs.existsSync(ROOT)) { console.error(`--root 指定的目录不存在：${ROOT}`); process.exit(2); }

function loadConfig() {
  for (const name of ['config.json', 'config.test.json']) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) continue;
    try {
      const text = fs.readFileSync(p, 'utf8');
      return { path: p, config: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) };
    } catch (error) {
      console.error(`配置解析失败 ${p}：${error.message}`);
      process.exit(2);
    }
  }
  console.error(`找不到配置文件：${path.join(ROOT, 'config.json')}（也没有 config.test.json）`);
  process.exit(2);
}
function readToken() {
  try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}

const { path: cfgPath, config } = loadConfig();
const report = await runSelfCheck({
  root: ROOT,
  config,
  consolePort: Number(config.consolePort || 3100),
  token: readToken(),
  fix: hasFlag('fix'),
  sampleGapMs: Number(flagVal('gap') || 0) || undefined,
  deps: createRealDeps(),
});

if (hasFlag('json')) {
  console.log(JSON.stringify({ root: ROOT, configPath: path.basename(cfgPath), ...report }, null, 2));
} else {
  const icon = { ok: '✓', warn: '⚠', fail: '✗' };
  console.log(`机器人自检 · ${ROOT}`);
  console.log(`配置 ${path.basename(cfgPath)} · ${new Date(report.at).toLocaleString('zh-CN', { hour12: false })} · 耗时 ${report.tookMs} ms`);
  console.log('─'.repeat(72));
  for (const g of report.groups) {
    console.log(`${icon[g.status]} [${g.id}] ${g.title} — ${g.summary}`);
    for (const line of g.evidence || []) console.log(`    · ${line}`);
    if (g.suggestion) console.log(`    → ${g.suggestion}`);
  }
  console.log('─'.repeat(72));
  console.log(`结论：ok ${report.counts.ok} / warn ${report.counts.warn} / fail ${report.counts.fail}` + (report.ok ? '（没有 fail）' : '（有 fail，按上面的 → 处置）'));
  if (report.fixes?.length) {
    console.log('安全修复：');
    for (const f of report.fixes) console.log(`    · ${f}`);
  }
  if (!report.ok) console.log('提示：--fix 只会拉起 Ollama 与清死锁文件，其它项必须人工处置。');
}
process.exit(report.ok ? 0 : 1);
