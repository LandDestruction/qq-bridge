#!/usr/bin/env node
// 发布包脚本自检：净化规则、硬闸规则、结构检查、白名单收集、自写 ZIP 的往返一致性。
// 不联网、不依赖本机 config.json / state/console-token（上下文全部手工构造），跑 < 1s。
//
// 跑法：node scripts/test-pack-release.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSanitizeRules,
  sanitizeEntries,
  buildHardGateRules,
  scanTextForSecrets,
  scanEntries,
  findLeftoverQq,
  checkStructure,
  collectReleaseFiles,
  buildZipBuffer,
  formatBytes,
  parseArgs,
  splitPackEntries,
  listProductionTopDirs,
  collectNodeModulesFiles,
  SCRIPT_EXTRA_FILES,
} from './pack-release.mjs';
import { readZipDirectory, readZipEntrySafe } from '../src/zip-read.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const failures = [];

function ok(condition, message) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(message);
  console.error(`✗ ${message}`);
}

function equal(actual, expected, message) {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
  } catch {
    failures.push(`${message}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`);
    console.error(`✗ ${failures.at(-1)}`);
  }
}

const ctx = { qqNumbers: ['100000006', '123456789'], tokens: ['tok-abcdef0123456789'] };

// ── 净化规则 ─────────────────────────────────────────────────────────────────
{
  const rules = buildSanitizeRules(ctx);
  equal(rules.map((r) => r.name), ['真实 QQ 号', '本机路径（E:\\qq-project）', '本机路径（C:\\Users\\PC）'], '净化规则三条');

  const qq = rules[0];
  qq.pattern.lastIndex = 0;
  equal('ownerQQ=100000006;'.replace(qq.pattern, qq.replacement), 'ownerQQ=123456789;', '真 QQ 号被换成占位号');

  // 边界：更长的数字串里包含这些号时不能误替换。
  qq.pattern.lastIndex = 0;
  equal('id=1100000006'.replace(qq.pattern, qq.replacement), 'id=1100000006', '长数字里的子串不替换');
  qq.pattern.lastIndex = 0;
  equal('id=1000000060'.replace(qq.pattern, qq.replacement), 'id=1000000060', '后缀数字不替换');

  equal('path E:\\qq-project\\state'.replace(rules[1].pattern, rules[1].replacement), 'path <repo>\\state', 'E 盘反斜杠路径被替换');
  equal('path E:/qq-project/src'.replace(rules[1].pattern, rules[1].replacement), 'path <repo>/src', 'E 盘正斜杠路径被替换');
  equal('C:\\Users\\PC\\Desktop'.replace(rules[2].pattern, rules[2].replacement), 'C:\\Users\\<user>\\Desktop', 'C 盘用户目录被替换');

  // 没有 QQ 号时只出两条路径规则（不产出空正则）。
  equal(buildSanitizeRules({ qqNumbers: [] }).length, 2, '没有 QQ 号时不生成 QQ 规则');
}

// ── 净化条目 ─────────────────────────────────────────────────────────────────
{
  const rules = buildSanitizeRules(ctx);
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
  const entries = [
    { name: 'src/a.js', data: Buffer.from('qq=100000006 at E:\\qq-project') },
    { name: 'public/logo.png', data: binary },
    { name: 'src/b.js', data: Buffer.from('nothing to change') },
  ];
  const before = entries[0].data.toString('utf8');
  const result = sanitizeEntries(entries, rules);
  equal(result.entries[0].data.toString('utf8'), 'qq=123456789 at <repo>', '文本条目被净化');
  equal(entries[0].data.toString('utf8'), before, '入参 Buffer 不被就地修改（只改副本）');
  equal(result.entries[1].data, binary, '二进制条目原样透传');
  equal(result.changedFiles.length, 1, '只统计真正改过的文件');
  const stat = result.stats.find((item) => item.name === '真实 QQ 号');
  equal(stat.occurrences, 1, 'QQ 规则命中 1 处');
  equal(stat.files, 1, 'QQ 规则涉及 1 个文件');
  equal(result.stats.find((item) => item.name === '本机路径（E:\\qq-project）').occurrences, 1, '路径规则命中 1 处');
  // 替换用函数式（不是字符串），所以替换值里的 `$&` 不会被 String.replace 展开。
  const dollar = sanitizeEntries([{ name: 'x.md', data: Buffer.from('hello') }], [{ name: '自定义', pattern: /hello/g, replacement: '$&-$&' }]);
  equal(dollar.entries[0].data.toString('utf8'), '$&-$&', '替换值原样落盘：$ 不特殊展开');
}

// ── 硬闸规则 ─────────────────────────────────────────────────────────────────
{
  const rules = buildHardGateRules(ctx);
  const names = rules.map((rule) => rule.name);
  ok(names.includes('API key（sk- 20+）'), '硬闸含 sk- 规则');
  ok(names.includes('apiKey 真值'), '硬闸含 apiKey 规则');
  ok(names.some((name) => name.includes('Cookie')), '硬闸含 Cookie 规则');
  ok(names.some((name) => name.includes('控制台令牌')), '硬闸含控制台令牌字面量规则');

  const hits = (text, entryName = 'src/x.js') => scanTextForSecrets(text, rules, entryName);
  ok(hits('const k = "sk-abcdefghijklmnopqrstuvwx";').length === 1, '真 sk- key 被拦');
  ok(hits('const k = "sk-short";').length === 0, '短 sk- 不误拦');
  ok(hits('apiKey: "abcd1234efgh5678"').length === 1, 'apiKey 真值被拦');
  ok(hits("apiKey: ''").length === 0, '空 apiKey 不拦');
  ok(hits('apiKey: "${process.env.KEY}"').length === 0, '模板占位不拦');
  ok(hits('const h = { Cookie: "_plaza_session_id=0123456789abcdef0123; adult=1" };').length >= 1, '真 cookie 头被拦');
  ok(hits('const token = "tok-abcdef0123456789";').length === 1, '控制台令牌字面量被拦');
  ok(hits('账号 100000006').length === 0, 'QQ 号不是硬闸（由净化处理）');

  // 假值白名单：只在 scripts/test-*.mjs 与 scripts/fixtures/** 内放行，且值要「一眼假」。
  const fakeKey = 'const k = "sk-test-only-for-unit-test";';
  ok(hits(fakeKey, 'scripts/test-foo.mjs').length === 0, '测试文件里的假 key 放行');
  ok(hits(fakeKey, 'scripts/fixtures/fake.json').length === 0, 'fixtures 里的假 key 放行');
  ok(hits(fakeKey, 'src/bridge.js').length === 1, '同样内容在 src/ 下不放行');
  ok(hits(fakeKey, 'scripts/audit-bridge-harness.mjs').length === 1, '同样内容在非 test- 脚本里不放行');
  ok(hits('real = "sk-q1w2e3r4t5y6u7i8o9p0asdf";', 'scripts/test-foo.mjs').length === 1, '测试文件里的「不像假的」真 key 仍然拦');
  const fakeCookie = '_plaza_session_id=abc123; adult=t';
  ok(hits(`const c = { cookie: '${fakeCookie}' };`, 'scripts/test-library-purchases-sync.mjs').length === 0, '测试夹具的假 cookie 放行');
  ok(hits(`const c = { cookie: '${fakeCookie}' };`, 'src/bridge/booth-login.js').length === 1, '假 cookie 在 src/ 下不放行');
}

// ── 扫描条目 + 净化残留自检 ──────────────────────────────────────────────────
{
  const rules = buildHardGateRules(ctx);
  const entries = [
    { name: 'src/ok.js', data: Buffer.from('nothing secret') },
    { name: 'src/bad.js', data: Buffer.from('apiKey: "abcd1234efgh5678"') },
    { name: 'public/logo.png', data: Buffer.from([0x89, 0x50, 0x00]) },
    { name: 'scripts/pack-release.mjs', data: Buffer.from('sk-abcdefghijklmnopqrstuvwx') },
  ];
  const result = scanEntries(entries, rules);
  equal(result.hits.map((hit) => hit.file), ['src/bad.js'], '只报真正命中的条目（跳过二进制与自身）');
  equal(result.scanned, 2, '扫描了 2 个文本文件');
  equal(result.skippedBinary, 2, '跳过 2 个（二进制 + 扫描器自身）');
  ok(result.allowedFake.length === 0, '没有假值放行时列表为空');
}
{
  const numbers = { qqNumbers: ['100000006'] };
  equal(findLeftoverQq([{ name: 'a.txt', data: Buffer.from('123456789') }], numbers), [], '净化后无残留');
  equal(findLeftoverQq([{ name: 'a.txt', data: Buffer.from('100000006') }], numbers), ['a.txt'], '有残留能报出来');
  equal(findLeftoverQq([{ name: 'a.txt', data: Buffer.from('x') }], { qqNumbers: [] }), [], '没有 QQ 号上下文时不报');
}

// ── 结构检查 ─────────────────────────────────────────────────────────────────
{
  const good = [
    { name: 'package.json' },
    { name: 'config.example.json' },
    { name: 'docs/RELEASE-MANIFEST.md' },
  ];
  equal(checkStructure(good), [], '最小合法包通过');
  ok(checkStructure([{ name: 'package.json' }]).length === 2, '缺两个必需文件报 2 项');
  ok(checkStructure([...good, { name: 'config.json' }]).some((p) => p.includes('真实配置')), '包内 config.json 被拦');
  ok(checkStructure([...good, { name: 'state/booth-binds.json' }]).some((p) => p.includes('state/')), '包内 state/ 被拦');
  ok(checkStructure([...good, { name: 'node_modules/x/index.js' }]).some((p) => p.includes('node_modules')), '包内 node_modules 被拦');
  equal(checkStructure([...good, { name: 'node_modules/x/index.js' }], { allowNodeModules: true }), [], '离线包允许 node_modules/');
  ok(checkStructure([...good, { name: 'node_modules/.bin/x' }], { allowNodeModules: true }).some((p) => p.includes('node_modules')), '离线包仍拦 node_modules/.bin');
  ok(checkStructure([...good, { name: 'node_modules/.cache/x' }], { allowNodeModules: true }).some((p) => p.includes('node_modules')), '离线包仍拦 node_modules/.cache');
  ok(checkStructure([...good, { name: '../evil.js' }]).some((p) => p.includes('路径不安全')), '路径穿越被拦');
  ok(checkStructure([...good, { name: 'tool.exe' }]).some((p) => p.includes('exe')), '非 installer 的 exe 被拦');
  ok(checkStructure([...good, { name: 'installer/QQDeepSeekBot-Setup-0.1.0.exe' }]).length === 0, 'installer/ 下的 exe 允许');
  ok(checkStructure([...good, { name: 'logs/a.log' }]).some((p) => p.includes('日志')), '日志被拦');
}

// ── 白名单收集（临时目录，不碰真实仓库） ─────────────────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-release-'));
  const write = (rel, text = 'x') => {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  write('src/bridge.js');
  write('public/client.html');
  write('client/01-shell.js');
  write('docs/OPERATING.md');
  write('docs/HANDOFF-2026.md');
  write('docs/guides/QUICKSTART.md');
  write('docs/RELEASE-MANIFEST.md');
  write('scripts/test-a.mjs');
  write('scripts/audit-bridge-harness.mjs');
  write('scripts/bootstrap.ps1');
  write('scripts/watchdog-stack.ps1');
  write('scripts/probe-events.mjs');
  write('scripts/console-ui-fixture.mjs');
  write('scripts/patch-snowluma-sdk.mjs');
  write('config.json');
  write('config.example.json');
  write('state/console-token');
  write('package.json');
  write('node_modules/x/index.js');
  const { files } = collectReleaseFiles({ root: tmp });
  const names = files.map((file) => file.rel);
  ok(names.includes('src/bridge.js'), 'src/ 被收集');
  ok(names.includes('docs/OPERATING.md'), 'docs 白名单内的文档被收集');
  equal(new Set(names).size, names.length, '收集结果无重名条目（docs 树 + 点名文件不重复收）');
  ok(names.filter((name) => name === 'docs/RELEASE-MANIFEST.md').length === 1, '点名的发布说明只出现一次');
  ok(names.includes('docs/RELEASE-MANIFEST.md'), '发布说明被收集');
  ok(!names.includes('docs/HANDOFF-2026.md'), 'docs 流水文档被排除');
  ok(names.includes('scripts/test-a.mjs'), 'scripts/test-* 被收集');
  ok(names.includes('scripts/audit-bridge-harness.mjs'), 'test 底座被点名收集');
  ok(names.includes('scripts/patch-snowluma-sdk.mjs'), 'postinstall 依赖被点名收集');
  ok(names.includes('scripts/bootstrap.ps1'), 'bootstrap.ps1 被点名收集（README 第一步用）');
  ok(!names.includes('scripts/watchdog-stack.ps1'), '本机 watchdog 脚本被排除');
  ok(!names.includes('scripts/probe-events.mjs'), 'probe-* 被排除');
  ok(!names.includes('config.json'), '真实配置被排除');
  ok(!names.includes('state/console-token'), 'state/ 被排除');
  ok(!names.includes('node_modules/x/index.js'), 'node_modules 被排除');
  ok(SCRIPT_EXTRA_FILES.includes('scripts/patch-snowluma-sdk.mjs'), '补充清单里含 postinstall 脚本');

  // --with-installer：安装程序进包，旁边多一份 SHA256.txt
  write('dist/installer/QQDeepSeekBot-Setup-0.1.0.exe', 'MZ-fake-installer');
  const withInstaller = collectReleaseFiles({ root: tmp, withInstaller: true });
  const installerRel = 'installer/QQDeepSeekBot-Setup-0.1.0.exe';
  ok(withInstaller.files.some((file) => file.rel === installerRel), '-full 收集到安装程序');
  const hashNote = withInstaller.files.find((file) => file.rel === 'installer/SHA256.txt');
  ok(Boolean(hashNote?.data), '安装程序旁生成 installer/SHA256.txt');
  const expectedHash = crypto.createHash('sha256').update('MZ-fake-installer').digest('hex');
  ok(hashNote.data.toString('utf8').includes(expectedHash), 'SHA256.txt 内容是该安装程序的 sha256');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 自写 ZIP 往返（用仓库自己的 zip-read 读回来） ────────────────────────────
{
  const entries = [
    { name: 'README.md', data: Buffer.from(`# 中文名字也要能读\n${'重复内容'.repeat(200)}\n`), mtime: new Date('2026-10-30T10:00:00') },
    { name: 'empty.txt', data: Buffer.alloc(0), mtime: new Date('2026-10-30T10:00:00') },
    { name: 'assets/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), mtime: new Date('2026-10-30T10:00:00') },
  ];
  const zip = buildZipBuffer(entries);
  ok(zip.length > 100, 'zip 非空');
  const dir = readZipDirectory(zip);
  ok(dir.ok, 'zip-read 能读目录');
  equal(dir.entries.filter((entry) => !entry.isDir).map((entry) => entry.name).sort(), ['README.md', 'assets/logo.png', 'empty.txt'], '条目名一致');
  for (const entry of entries) {
    const read = readZipEntrySafe(zip, entry.name);
    ok(read.ok, `回读 ${entry.name} 成功`);
    ok(read.bytes.equals(entry.data), `${entry.name} 内容逐字节一致`);
  }
  const deflated = readZipDirectory(zip).entries.find((entry) => entry.name === 'README.md');
  equal(deflated.method, 8, '文本走 deflate');
  ok(!zip.subarray(0, 4).equals(Buffer.from([0, 0, 0, 0])), 'zip 头有效');
}

// ── 参数解析 ─────────────────────────────────────────────────────────────────
{
  equal(parseArgs([]), { dryRun: false, withInstaller: false, withNodeModules: false, out: 'dist/releases', list: false, json: false }, '默认参数');
  equal(parseArgs(['--dry-run', '--with-installer', '--out', 'dist/x', '--list', '--json']).out, 'dist/x', '--out 取值');
  equal(parseArgs(['--dry-run']).dryRun, true, '--dry-run 生效');
  equal(parseArgs(['--with-node-modules']).withNodeModules, true, '--with-node-modules 生效');
  equal(parseArgs(['--with-installer', '--with-node-modules']).withInstaller, true, '两个开关可同时给');
  let threw = false;
  try {
    parseArgs(['--nope']);
  } catch {
    threw = true;
  }
  ok(threw, '未知参数抛错');
  ok(formatBytes(1024) === '1.0 KB', 'formatBytes KB');
  ok(formatBytes(0) === '0 B', 'formatBytes 0');
}

// ── src / offline / full 三种包的内容切分 ────────────────────────────────────
{
  const entries = [
    { name: 'src/bridge.js', data: Buffer.from('x') },
    { name: 'installer/QQDeepSeekBot-Setup-0.1.0.exe', data: Buffer.from('MZ') },
    { name: 'node_modules/express/index.js', data: Buffer.from('module.exports=1') },
  ];
  const split = splitPackEntries(entries);
  equal(split.src.map((entry) => entry.name), ['src/bridge.js'], 'src 包不含 installer/ 与 node_modules/');
  equal(split.offline.map((entry) => entry.name), ['src/bridge.js', 'node_modules/express/index.js'], 'offline 包带依赖、不带安装程序');
  equal(split.full.map((entry) => entry.name), ['src/bridge.js', 'installer/QQDeepSeekBot-Setup-0.1.0.exe', 'node_modules/express/index.js'], 'full 包全都有');
}

// ── 离线包：生产依赖收集（临时目录 + 假 npm 输出） ──────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-nm-'));
  const write = (rel, text = 'x') => {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  write('package.json', '{}');
  write('node_modules/express/index.js', 'express');
  write('node_modules/express/package.json', '{}');
  write('node_modules/@deepseek-ai/schemastery/index.js', 'schema');
  write('node_modules/express/.bin/cli.js', 'bin');
  write('node_modules/express/.package-lock.json', '{}');
  write('node_modules/express/.cache/cache.js', 'cache');
  write('node_modules/typescript/index.js', 'dev-only');

  const modules = path.join(tmp, 'node_modules');
  const fakeRun = (stdout) => () => ({ status: 1, stdout, stderr: 'missing peer deps' });
  const stdout = [tmp, path.join(modules, 'express'), path.join(modules, '@deepseek-ai', 'schemastery')].join('\r\n');
  const tops = listProductionTopDirs({ root: tmp, run: fakeRun(stdout) });
  equal(tops, ['@deepseek-ai/schemastery', 'express'], 'npm ls 解析出生产依赖顶层目录（含 @scope、丢掉 root）');

  const collected = collectNodeModulesFiles({ root: tmp, tops });
  equal(collected.files.map((file) => file.rel).sort(), [
    'node_modules/@deepseek-ai/schemastery/index.js',
    'node_modules/express/index.js',
    'node_modules/express/package.json',
  ], '只收生产依赖里的真实文件');
  ok(!collected.files.some((file) => file.rel.includes('typescript')), 'dev 依赖（不在 npm ls 输出里）不会被收集');
  ok(collected.files.every((file) => !/(^|\/)\.(bin|cache)\//.test(file.rel) && !file.rel.endsWith('.package-lock.json')), '.bin / .cache / .package-lock.json 全部跳过');

  let threw = false;
  try {
    listProductionTopDirs({ root: tmp, run: fakeRun('') });
  } catch {
    threw = true;
  }
  ok(threw, 'npm ls 一行输出都没有时抛错（不静默打空包）');

  equal(collectReleaseFiles({ root: tmp }).nodeModules, null, '默认（不带开关）不收集 node_modules');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 收尾 ─────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n${passed}/${passed + failures.length} ok，${failures.length} 项失败`);
  process.exit(1);
}
console.log(`test-pack-release: ${passed}/${passed} ok`);
