#!/usr/bin/env node
// verify-delivery.mjs —— 交付包双闸：完整性 + 隐私。任一红就 exit 1。
//
// 用法：
//   node scripts/verify-delivery.mjs --dir dist/delivery/qq-bot-system-20261027-1300
//   node scripts/verify-delivery.mjs --dir <stage> --json
//
// 规则来自 scripts/delivery-manifest.json（唯一真源）：include / pending / redact.allowNumbers。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const dirArg = (() => { const i = argv.indexOf('--dir'); return i >= 0 ? argv[i + 1] : ''; })();
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'delivery-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
const allowNumbers = new Map(Object.entries(manifest.redact.allowNumbers ?? {}).map(([k, v]) => [String(k), String(v)]));

if (!dirArg) { console.error('用法：node scripts/verify-delivery.mjs --dir <stage> [--json]'); process.exit(2); }
const stage = path.resolve(ROOT, dirArg);
if (!fs.existsSync(stage)) { console.error(`❌ 目录不存在：${stage}`); process.exit(2); }

const toPosix = (p) => p.split(path.sep).join('/');
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = toPosix(path.relative(base, abs));
    if (e.isDirectory()) { out.push({ rel, abs, dir: true }); walk(abs, base, out); }
    else if (e.isFile()) out.push({ rel, abs, dir: false });
  }
  return out;
}
const entries = walk(stage);
const files = entries.filter((e) => !e.dir);
const totalBytes = files.reduce((n, e) => n + fs.statSync(e.abs).size, 0);
const mask = (s) => String(s).replace(/\d/g, '#').slice(0, 120);

// ── 闸 1：完整性 ────────────────────────────────────────────────────────────
const checks = [];
const failures = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); if (!ok) failures.push(detail || name); };

for (const inc of manifest.include ?? []) {
  const target = path.join(stage, inc.to ?? inc.from);
  const exists = fs.existsSync(target);
  const nonEmpty = exists && (fs.statSync(target).isFile() || fs.readdirSync(target).length > 0);
  check(`include 存在：${inc.to ?? inc.from}`, nonEmpty, `缺失或为空：${inc.to ?? inc.from}`);
}
const critical = [
  'src/bridge.js', 'src/mcp-snowluma-safe.js', 'package.json', 'package-lock.json',
  'scripts/verify-rebuild.mjs',
  'config.template.json', 'config.example.json', 'LICENSE',
  'docs/DELIVERY-README.md', 'docs/OPERATIONS-HANDBOOK.md', 'docs/THIRD-PARTY.md', 'docs/CONFIG-FIELDS.md',
  'docs/CHANGELOG.md', 'docs/release-runbook.md',
  'roles/README.md', 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml', 'dsh/agent-presets/qq-chat-v2/preset.yml',
  'plugins/qq-agent-presets/package.json',
  'ops/start-all.ps1', 'ops/stop-all.ps1', 'ops/status-all.ps1',
  'persona/current-role.json', 'persona/initial-prompts.example.json',
  // T15/T16/T20：客户端页面与桌面宿主。少了 client.html 桌面壳只能开 404；
  // 少了 desktop/Host.cs 或构建脚本，对方拿到包编不出 QQDeepSeekBot.exe。
  'public/client.html', 'public/ui-preview.html',
  'desktop/Host.cs', 'desktop/Brand.cs', 'scripts/desktop/build-host.ps1',
  // T17：安装器链路。缺安装器就只剩"解压 zip 自己配"，用户装不起来；
  // payload.json 是载荷清单唯一真源，Installer.cs 是构建入口，build-installer.ps1 在仓库根。
  'scripts/test-installer.mjs', 'scripts/installer/Installer.cs', 'scripts/installer/payload.json',
  'build-installer.ps1',
  'dsh/cordis.patch.template.yml',
  'DELIVERY-MANIFEST.json', 'MANIFEST.tsv', 'SHA256SUMS.txt'
];
for (const rel of critical) check(`关键文件：${rel}`, fs.existsSync(path.join(stage, rel)), `关键文件缺失：${rel}`);

for (const rel of ['package.json', 'config.template.json', 'DELIVERY-MANIFEST.json']) {
  const p = path.join(stage, rel);
  let ok = false; let detail = '';
  try { JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); ok = true; } catch (e) { detail = `${rel} 解析失败：${e.message}`; }
  check(`JSON 可解析：${rel}`, ok, detail);
}

// node --check：所有 .js/.mjs（不含 node_modules）
const scriptFiles = files.filter((e) => /\.(mjs|js|cjs)$/i.test(e.rel) && !e.rel.startsWith('node_modules/'));
let syntaxFail = 0;
for (const f of scriptFiles) {
  const r = spawnSync(process.execPath, ['--check', f.abs], { encoding: 'utf8' });
  if (r.status !== 0) {
    syntaxFail += 1;
    const line = (r.stderr || '').split('\n').find((l) => /SyntaxError|Error:/.test(l)) || '语法错误';
    failures.push(`node --check 失败：${f.rel}（${line.trim().slice(0, 120)}）`);
    if (syntaxFail > 5) break;
  }
}
check(`node --check 全过（${scriptFiles.length} 个脚本）`, syntaxFail === 0, `语法错误 ${syntaxFail} 个`);

const pending = Object.keys(manifest.pending ?? {});
const pendingMissing = pending.filter((rel) => !fs.existsSync(path.join(stage, rel)));

// ── 闸 2：隐私 ──────────────────────────────────────────────────────────────
const violations = [];
const bannedSegments = new Set(['state', 'logs', '.git', '__pycache__', '.npm-cache', '.venv']);
const bannedNames = [/\.bak/i, /^\.env(\.|$)/i, /^privacy-rules\.json$/i, /^config\.json$/i];
const stateWhitelist = manifest.stateWhitelist?.paths ?? [];
const stateAllowed = (rel) => stateWhitelist.some((p) => rel === p || rel.startsWith(p + '/'));
for (const e of entries) {
  const segs = e.rel.split('/');
  const badSeg = segs.find((s) => bannedSegments.has(s));
  // state/ 目录本身（容器）允许存在；只允许它的白名单子路径带内容。
  if (badSeg && !(badSeg === 'state' && (e.rel === 'state' || stateAllowed(e.rel)))) {
    violations.push({ file: e.rel, kind: 'banned-dir', detail: `路径含禁用目录 ${badSeg}/（state/ 只允许白名单例外）` });
    continue;
  }
  if (e.dir) continue;
  if (bannedNames.some((re) => re.test(segs[segs.length - 1]))) {
    violations.push({ file: e.rel, kind: 'banned-file', detail: '文件名命中禁用清单（*.bak/.env/token*/config.json/privacy-rules.json）' });
  }
}
if (files.some((e) => e.rel.startsWith('node_modules/'))) {
  violations.push({ file: 'node_modules/', kind: 'banned-dir', detail: 'normal 档不该带 node_modules（-Full 档请在构建时显式允许并人工复核）' });
}

const textExts = new Set(manifest.redact.extensions ?? []);
// 数字类检查（QQ 号/群号）只扫「文档与配置」：源码里有大量毫秒/字节常量与测试夹具号，
// 它们不是隐私，但会把闸门刷成假红。源码仍然查本机路径/令牌（那些才是真泄漏）。
const numberScanExts = new Set(['.md', '.json', '.yml', '.yaml', '.ps1', '.bat', '.cmd', '.txt', '.tsv']);
const patterns = [
  { kind: 'local-user-path', re: /[A-Za-z]:\\Users\\/ },
  { kind: 'local-user-path', re: /\/home\/[a-z][a-z0-9_-]*\// },
  { kind: 'api-key', re: /sk-[A-Za-z0-9_-]{16,}/ },
  { kind: 'bearer-token', re: /Bearer\s+[A-Za-z0-9_.-]{24,}/ },
  { kind: 'token-value', re: /(?:accessToken|authToken|consoleToken|apiKey)\s*[:=]\s*"([^"<>\s]{12,})"/ }
];
const numberScanSkipFiles = new Set([
  'MANIFEST.tsv', 'SHA256SUMS.txt', 'DELIVERY-MANIFEST.json',
  'scripts/delivery-manifest.json',
  // 表情记录：url/fileid 里的数字是发消息必需的（删了表情就废），字段级脱敏已在构建期做
  'state/stickers.json'
]);
const qqRe = /\b[1-9]\d{7,9}\b/g;
// 8-9 位（原 6-9 位）：6~7 位连续数字在文档里大量是 **pid 与 7 位全数字 git 短 sha**
// （实测 102156 / 118188 / 280138 / 2201609 等），一律判红会把正常文档拦下，
// 反而逼人去放宽规则。真实群号/QQ 号在本系统里都是 9~10 位，收窄后仍能覆盖。
// 代价：若有 6~7 位的旧群号会漏检——由 redact 规则与人工复核兜底。
const groupRe = /\b[1-9]\d{7,8}\b/g;
const skipNumber = (n) => allowNumbers.has(n) || /^20\d{6}$/.test(n) || /^0\d+$/.test(n);
const numberWarnings = [];

const allowPathMatches = new Set((manifest.redact.allowPathMatches ?? []).map((x) => `${x.file}|${x.match}`));
for (const e of files) {
  if (!textExts.has(path.extname(e.rel).toLowerCase())) continue;
  const text = fs.readFileSync(e.abs, 'utf8');
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    for (const p of patterns) {
      const m = p.re.exec(line);
      if (m) {
        if (allowPathMatches.has(`${e.rel}|${m[0]}`)) continue;
        violations.push({ file: e.rel, line: i + 1, kind: p.kind, excerpt: mask(m[0]) });
      }
    }
    const numbers = (numberScanExts.has(path.extname(e.rel).toLowerCase()) && !numberScanSkipFiles.has(e.rel))
      ? new Set([...(line.match(qqRe) ?? []), ...(line.match(groupRe) ?? [])])
      : new Set();
    for (const n of numbers) {
      if (skipNumber(n)) continue;
      // 12:59 口径：群号/QQ 号必须以 <群号>/<QQ号> 形式出现，命中 6-9 位连续数字即判失败。
      // 例外：构建期已生成/已字段级脱敏的文件（下面 numberScanSkipFiles）。
      violations.push({ file: e.rel, line: i + 1, kind: n.length >= 9 ? 'qq-like-number' : 'group-like-number', excerpt: mask(n) });
      break; // 一行只报一个数字，避免刷屏
    }
    if (violations.length > 200) break;
  }
  if (violations.length > 200) break;
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const integrity = {
  ok: failures.length === 0,
  checks,
  failures: failures.slice(0, 50),
  pendingMissing,
  summary: failures.length === 0
    ? `通过（${checks.length} 项；脚本 ${scriptFiles.length} 个 node --check 全过；待外部交付 ${pendingMissing.length} 项：${pendingMissing.join(', ') || '无'}）`
    : `失败 ${failures.length} 项`
};
const privacy = {
  ok: violations.length === 0,
  violations: violations.slice(0, 100),
  warnings: numberWarnings.slice(0, 50),
  warningCount: numberWarnings.length,
  summary: violations.length === 0
    ? '通过（无 state/logs/令牌/本机路径/群号/QQ 号残留；state/ 只有表情库白名单例外）'
    : `命中 ${violations.length} 项`
};
const report = {
  ok: integrity.ok && privacy.ok,
  stage,
  stats: { files: files.length, bytes: totalBytes, mb: Number((totalBytes / 1024 / 1024).toFixed(2)) },
  integrity,
  privacy
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`=== 交付包双闸：${stage} ===`);
  console.log(`  文件 ${files.length} / ${report.stats.mb} MB`);
  console.log(`  完整性：${integrity.ok ? '✅' : '❌'} ${integrity.summary}`);
  if (!integrity.ok) for (const f of integrity.failures.slice(0, 20)) console.log('   - ' + f);
  console.log(`  隐私  ：${privacy.ok ? '✅' : '❌'} ${privacy.summary}`);
  for (const v of privacy.violations.slice(0, 20)) console.log(`   - ${v.file}:${v.line ?? 0} [${v.kind}] ${v.excerpt ?? v.detail ?? ''}`);
}
process.exit(report.ok ? 0 : 1);
