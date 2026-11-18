#!/usr/bin/env node
// 打一个**可以直接发给朋友**的发布包：源码 + 前端 + 脚本 + 插件 + 用户文档，外加两道关：
//   ① 打包时净化：把包里的真实 QQ 号、本机绝对路径替换成占位符（**只改 zip 里的副本，不动工作区**）；
//   ② 打包后硬闸：令牌 / API key / Cookie 三类敏感值必须 0 命中，否则 exit 1 不落盘。
//
// 为什么不是「压缩一下完事」：以前手工打包出过两种情况——
//   ① 漏文件（发过去起不来）；
//   ② 把 config.json / state/、以及散落在注释和文档里的真实 QQ 号、本机路径一起发了。
// 所以流程是：白名单收集 → 净化 → 硬闸扫描 → 才写 zip。
//
// 用法：
//   node scripts/pack-release.mjs                  # 打源码包（默认 dist/releases/）
//   node scripts/pack-release.mjs --dry-run        # 只打印清单/净化统计/硬闸结果，不写文件
//   node scripts/pack-release.mjs --with-installer # 额外打一个含安装程序的 full 包
//   node scripts/pack-release.mjs --with-node-modules # 再打一个自带生产依赖的离线包（目标机无网络时能直接 npm start）
//   node scripts/pack-release.mjs --out dist/releases
//   node scripts/pack-release.mjs --dry-run --list # 打印完整文件清单（默认摘要 + 前 30 项）
//   node scripts/pack-release.mjs --json           # 机器可读摘要
//
// 产物：
//   QQDeepSeekBot-<version>-<yyyymmdd>-src.zip          源码包（不含安装程序、不含依赖）
//   QQDeepSeekBot-<version>-<yyyymmdd>-src-offline.zip  源码包 + 生产依赖 node_modules/（--with-node-modules）
//   QQDeepSeekBot-<version>-<yyyymmdd>-full.zip         含 installer/QQDeepSeekBot-Setup-*.exe（--with-installer）
//                                                      两个开关都给时，full 包里也带 node_modules/
//
// 依赖：**没有第三方依赖**。zip 由本文件用 node:zlib 自写（stored + deflate），
// 不调用 tar.exe / PowerShell Compress-Archive，因此 Windows / macOS / Linux 行为一致。
//
// 退出码：0 = 成功；1 = 硬闸命中或打包失败（打印文件 + 脱敏片段，绝不回显凭据本身）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 包里放什么 ────────────────────────────────────────────────────────────────
// 顶层目录：整棵收（docs / scripts 再各自过一遍白名单）。
export const INCLUDE_DIRS = ['src', 'public', 'client', 'plugins', 'dsh', 'docs', 'scripts'];
export const INCLUDE_FILES = [
  'package.json',
  'package-lock.json',
  'config.example.json',
  'README.md',
  'README.en.md',
  'LICENSE',
  'LICENSE.polyform-nc',
  'docs/RELEASE-MANIFEST.md',
];
// 可能还没写好的东西：有就收，没有只提示，不阻断打包。
export const OPTIONAL_PATHS = ['ops', 'docs/系统介绍.md', 'docs/开源说明.md', 'docs/images'];

// docs/ 只收**给用户看的**文档。开发流水（handoff / cross-session / audit / 提交日志 / FIXES…）
// 里全是本机路径和真实群号，既不该发给朋友，也没必要发。
export const DOC_ALLOW_PATTERNS = [
  /^docs\/系统介绍\.md$/,
  /^docs\/开源说明\.md$/,
  /^docs\/QUICKSTART[^/]*$/,
  /^docs\/OPERATING[^/]*$/,
  /^docs\/FOLDER_MAP[^/]*$/,
  /^docs\/CONFIG-FIELDS[^/]*$/,
  /^docs\/BOOTH-LIBRARY-GUIDE\.md$/,
  /^docs\/LESSONS\.md$/,
  /^docs\/THIRD-PARTY\.md$/,
  /^docs\/ai-blacklist\.md$/,
  /^docs\/guides\//,
  /^docs\/images\//,
  /^docs\/RELEASE-MANIFEST\.md$/,
];

// scripts/ 只收「装/建/测」这一层；本机部署脚本（*.ps1 watchdog、计划任务、启动器）与探针
// （probe-*、.tmp*）都是写给这台机器的，换台机器就跑不了，而且里面全是我这边的绝对路径。
export const SCRIPT_ALLOW_PATTERNS = [
  /^scripts\/build-[^/]+\.mjs$/,
  /^scripts\/make-[^/]+\.mjs$/,
  /^scripts\/test-[^/]+\.mjs$/,
  /^scripts\/setup-[^/]+\.mjs$/,
  /^scripts\/check-[^/]+\.mjs$/,
  /^scripts\/regression-all\.mjs$/,
  /^scripts\/pack-release\.mjs$/,
  /^scripts\/lib\//,
  /^scripts\/fixtures\//,
];
// scripts/ 里的「点名补充」：
//   audit-bridge-harness.mjs / vendor/acorn.mjs —— test-* 的公共底座，少了包里那批 test-* 全跑不起来；
//   console-ui-fixture.mjs —— package.json 的 preview:console 与 test-console-ui 依赖它；
//   patch-snowluma-sdk.mjs —— package.json 的 postinstall，缺了 npm ci 直接失败（朋友第一步就卡死）；
//   verify-dsh-021-adaptation.mjs / privacy-scan.mjs —— README 里写了的自检命令；
//   bootstrap.ps1 —— README「快速开始」第一步；它是通用脚本（ASCII、无本机路径），
//   其余 *.ps1（watchdog/计划任务/重启器）是写给这台机器的，仍然排除。
export const SCRIPT_EXTRA_FILES = [
  'scripts/audit-bridge-harness.mjs',
  'scripts/vendor/acorn.mjs',
  'scripts/console-ui-fixture.mjs',
  'scripts/patch-snowluma-sdk.mjs',
  'scripts/verify-dsh-021-adaptation.mjs',
  'scripts/privacy-scan.mjs',
  'scripts/bootstrap.ps1',
];
export const SCRIPT_EXCLUDE_PATTERNS = [/^scripts\/[^/]+\.ps1$/i, /^scripts\/probe-/, /^scripts\/\.tmp/];

// 目录级排除（出现在路径任何一段都排除）。
export const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'oil-ui-work', 'state', 'logs', '.dsh',
  '__pycache__', '.cache', '.npm-cache', 'delivery', 'archive', 'audio',
]);

// 文件级排除：给出的是「相对路径的正则」。
export const EXCLUDED_FILE_RULES = [
  { name: '真实配置', re: /(^|\/)config\.json$/ },
  { name: '配置备份（含真实令牌）', re: /(^|\/)config\.json\./ },
  { name: '配置测试/模板副本', re: /(^|\/)config\.(test|template)\.json$/ },
  { name: '本机覆盖文件', re: /\.local\.[^/]+$/i },
  { name: '日志', re: /\.log$/i },
  { name: '备份', re: /\.(bak|bak-[^/]*|orig)$/i },
  { name: '安装程序（除 --with-installer 外不打包）', re: /\.exe$/i },
  { name: '系统缓存文件', re: /(^|\/)(thumbs\.db|desktop\.ini|\.ds_store)$/i },
];

// 超过这个大小的文件不进包；fixtures 里的二进制更早截断（Lead 口径 5MB）。
const MAX_PACK_FILE_BYTES = 8 * 1024 * 1024;
const FIXTURE_MAX_BYTES = 5 * 1024 * 1024;
// node_modules 里有编译产物（.node/.wasm），给离线包单独一档更大的上限。
const NODE_MODULES_MAX_FILE_BYTES = 32 * 1024 * 1024;
// 扫描/净化只看 2MB 以内的文本。
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.ico', '.svgz',
  '.mp4', '.webm', '.mov', '.wav', '.mp3', '.ogg', '.m4a', '.flac',
  '.zip', '.tgz', '.gz', '.7z', '.rar', '.zst', '.xz',
  '.exe', '.dll', '.node', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.otf', '.eot',
]);

// ── 收集文件 ──────────────────────────────────────────────────────────────────
function passesPathFilter(rel) {
  if (rel.startsWith('docs/')) return DOC_ALLOW_PATTERNS.some((re) => re.test(rel));
  if (rel.startsWith('scripts/')) {
    if (SCRIPT_EXTRA_FILES.includes(rel)) return true;
    if (SCRIPT_EXCLUDE_PATTERNS.some((re) => re.test(rel))) return false;
    return SCRIPT_ALLOW_PATTERNS.some((re) => re.test(rel));
  }
  return true;
}

function walkDir(root, relDir, out, skipped) {
  const absDir = path.join(root, relDir);
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (error) {
    skipped.push({ rel: relDir, reason: `读不动：${error?.code ?? error?.message ?? error}` });
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    // junction / 符号链接一律不跟：仓库里 `state/` 有过指回自身的 junction，跟着走会无限递归。
    if (entry.isSymbolicLink()) {
      skipped.push({ rel, reason: '符号链接/junction，不跟' });
      continue;
    }
    if (entry.isDirectory()) {
      const excluded = rel.split('/').find((seg) => EXCLUDED_DIRS.has(seg.toLowerCase()));
      if (excluded) continue;
      walkDir(root, rel, out, skipped);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!passesPathFilter(rel)) continue;
    if (EXCLUDED_FILE_RULES.some((rule) => rule.re.test(rel))) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(root, rel));
    } catch {
      continue;
    }
    const limit = rel.startsWith('scripts/fixtures/') ? FIXTURE_MAX_BYTES : MAX_PACK_FILE_BYTES;
    if (stat.size > limit) {
      skipped.push({ rel, reason: `太大（${formatBytes(stat.size)} > 上限 ${formatBytes(limit)}）` });
      continue;
    }
    out.push({ rel, abs: path.join(root, rel), size: stat.size, mtime: stat.mtime });
  }
}

/** 收集发布包内容（docs / scripts 已按白名单收窄）。返回 { files, skipped, missingOptional, nodeModules }。 */
export function collectReleaseFiles({ root = ROOT, withInstaller = false, withNodeModules = false } = {}) {
  const files = [];
  const skipped = [];
  const missingOptional = [];
  let nodeModules = null;
  for (const dir of INCLUDE_DIRS) {
    if (!fs.existsSync(path.join(root, dir))) {
      missingOptional.push(dir);
      continue;
    }
    walkDir(root, dir, files, skipped);
  }
  for (const rel of INCLUDE_FILES) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    if (stat.isFile()) files.push({ rel, abs, size: stat.size, mtime: stat.mtime });
  }
  for (const rel of OPTIONAL_PATHS) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      missingOptional.push(rel);
      continue;
    }
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) walkDir(root, rel, files, skipped);
    else if (stat.isFile()) files.push({ rel, abs, size: stat.size, mtime: stat.mtime });
  }
  if (withInstaller) {
    const installer = findInstaller(root);
    if (!installer) throw new Error('找不到 dist/installer/QQDeepSeekBot-Setup-*.exe：先用 build-installer.ps1 打安装程序，或去掉 --with-installer');
    files.push({ rel: `installer/${installer.name}`, abs: installer.path, size: installer.size, mtime: installer.mtime });
    // 安装程序旁边放一份 sha256：朋友拿到 -full 包能就地核对，不用回头问我们要值。
    const installHash = crypto.createHash('sha256').update(fs.readFileSync(installer.path)).digest('hex');
    const note = Buffer.from(`${installHash}  ${installer.name}\n${installer.size} bytes\n`, 'utf8');
    files.push({ rel: 'installer/SHA256.txt', data: note, size: note.length, mtime: installer.mtime });
  }
  if (withNodeModules) {
    // 依赖放进包里的路径不变（`node_modules/<name>`），解压后就是仓库根，`npm start` 直接能跑。
    const tops = listProductionTopDirs({ root });
    const collected = collectNodeModulesFiles({ root, tops });
    files.push(...collected.files);
    skipped.push(...collected.skipped);
    nodeModules = {
      tops,
      files: collected.files.length,
      bytes: collected.files.reduce((sum, file) => sum + file.size, 0),
    };
  }
  // 去重：docs/ 整棵收的时候，INCLUDE_FILES / OPTIONAL_PATHS 里点名的那些也在树里，
  // 不去重会在 zip 里出现同名两份（解压时谁覆盖谁看心情）。
  const unique = new Map();
  for (const file of files) if (!unique.has(file.rel)) unique.set(file.rel, file);
  const deduped = [...unique.values()].sort((a, b) => a.rel.localeCompare(b.rel));
  return { files: deduped, skipped, missingOptional, nodeModules };
}

function findInstaller(root) {
  const dir = path.join(root, 'dist', 'installer');
  if (!fs.existsSync(dir)) return null;
  const candidates = fs.readdirSync(dir)
    .filter((name) => /^QQDeepSeekBot-Setup-.*\.exe$/i.test(name))
    .map((name) => {
      const abs = path.join(dir, name);
      const stat = fs.statSync(abs);
      return { name, path: abs, size: stat.size, mtime: stat.mtime };
    })
    .filter((item) => item.size > 0);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0];
}

// ── 离线包：生产依赖 node_modules/（--with-node-modules） ─────────────────────
// 目标机没有网络时，解压后必须能直接 `npm start`，所以把生产依赖一起打进去。
// **只打生产依赖**：devDependencies 是测试/构建工具链（acorn 已在 scripts/vendor 里），
// 打进去只会让包大一倍、还多出一堆许可证说明；生产依赖由 npm 自己算准，别手写白名单：
//   - 少了 → 目标机 import 失败（`npm start` 直接挂）；
//   - 多了 → 把 dev 工具链塞进包里。
export const NODE_MODULES_SKIP_NAMES = new Set([
  '.bin', '.cache', '.modules.yaml', '.package-lock.json', '.npm', '.tmp',
]);

function findNpmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((item) => fs.existsSync(item)) ?? '';
}

/**
 * 生产依赖的顶层目录（`node_modules/<name>` 或 `node_modules/@scope/<name>`）。
 * 用 `npm ls --omit=dev --all --parseable` 算：它给的是「安装树里属于生产的全部包」，
 * 含传递依赖与已安装的 optional。注意 npm 遇到缺失的 peer 依赖会以非 0 退出，但 stdout
 * 仍然是完整的树——所以只看 stdout，只有一行都没有才算真失败。
 */
export function listProductionTopDirs({ root = ROOT, npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm', run = spawnSync } = {}) {
  // Windows 上 npm 是 .cmd：直接 spawn 会 EINVAL，走 shell 又触发 DEP0190（args 不转义）；
  // 优先 `node <npm-cli.js>` 直连 Node 自带的 npm，找不到才退回 shell。
  const npmCli = findNpmCli();
  const command = npmCli ? process.execPath : npmCommand;
  const args = [...(npmCli ? [npmCli] : []), 'ls', '--omit=dev', '--all', '--parseable'];
  const result = run(command, args, { cwd: root, encoding: 'utf8', shell: !npmCli && process.platform === 'win32' });
  const lines = String(result?.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    const detail = String(result?.stderr ?? '').trim().slice(0, 200);
    throw new Error(`npm ls --omit=dev 没有输出（exit ${result?.status ?? '?'}）：${detail || '先 npm ci 装好依赖'}`);
  }
  const modulesDir = path.join(root, 'node_modules');
  const tops = new Set();
  for (const line of lines) {
    const abs = path.resolve(root, line);
    if (abs === path.resolve(root)) continue;
    const rel = path.relative(modulesDir, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const parts = rel.split('/');
    const top = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (!top || top.startsWith('.') || NODE_MODULES_SKIP_NAMES.has(top)) continue;
    if (!fs.existsSync(path.join(modulesDir, top))) continue;
    tops.add(top);
  }
  if (!tops.size) throw new Error('没解析出任何生产依赖目录：npm ls --omit=dev 的输出里没有 node_modules/*？');
  return [...tops].sort();
}

/** 收集生产依赖文件。跳过 `.bin` / `.cache` / 所有隐藏项（`.package-lock.json` 之类），保留 `.node` 二进制。 */
export function collectNodeModulesFiles({ root = ROOT, tops = [] } = {}) {
  const files = [];
  const skipped = [];
  const walk = (relDir) => {
    const absDir = path.join(root, relDir);
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (error) {
      skipped.push({ rel: relDir, reason: `读不动：${error?.code ?? error?.message ?? error}` });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      // node_modules 里 `.bin` 是装依赖时生成的软链包装、`.cache` 是构建缓存、
      // `.package-lock.json` 是给 npm 自己看的清单——目标机 `npm start` 一个都不需要。
      if (entry.name.startsWith('.') || NODE_MODULES_SKIP_NAMES.has(entry.name)) continue;
      const childRel = `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        skipped.push({ rel: childRel, reason: '符号链接，不跟' });
        continue;
      }
      if (entry.isDirectory()) {
        walk(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = fs.statSync(path.join(root, childRel));
      } catch {
        continue;
      }
      if (stat.size > NODE_MODULES_MAX_FILE_BYTES) {
        skipped.push({ rel: childRel, reason: `太大（${formatBytes(stat.size)} > 上限 ${formatBytes(NODE_MODULES_MAX_FILE_BYTES)}）` });
        continue;
      }
      files.push({ rel: childRel, abs: path.join(root, childRel), size: stat.size, mtime: stat.mtime });
    }
  };
  for (const top of tops) {
    const dir = path.join(root, 'node_modules', top);
    if (!fs.existsSync(dir)) {
      skipped.push({ rel: `node_modules/${top}`, reason: '目录不存在' });
      continue;
    }
    walk(`node_modules/${top}`);
  }
  return { files, skipped };
}

// ── 净化：真实 QQ 号 / 本机路径 → 占位符（只改 zip 里的副本） ─────────────────
export function loadSecretContext(root = ROOT) {
  const ctx = { tokens: [], qqNumbers: [], sources: [] };
  const configPath = path.join(root, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
      collectIdentifiers(cfg, ctx, 0);
      ctx.sources.push('config.json');
    } catch {
      ctx.sources.push('config.json（解析失败，跳过）');
    }
  }
  const tokenPath = path.join(root, 'state', 'console-token');
  if (fs.existsSync(tokenPath)) {
    try {
      const token = fs.readFileSync(tokenPath, 'utf8').trim();
      if (token.length >= 8) ctx.tokens.push(token);
      ctx.sources.push('state/console-token');
    } catch {
      /* 读不到就不拿它比对；硬闸的其它规则照常生效 */
    }
  }
  ctx.qqNumbers = [...new Set(ctx.qqNumbers)].filter((n) => /^\d{5,13}$/.test(n));
  ctx.tokens = [...new Set(ctx.tokens)];
  return ctx;
}

function collectIdentifiers(node, ctx, depth) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) collectIdentifiers(item, ctx, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if ((typeof value === 'number' || typeof value === 'string') && /(qq|owner|allow|deny|admin|group)/i.test(key) && /^\d{5,13}$/.test(String(value))) {
      ctx.qqNumbers.push(String(value));
    }
    if (value && typeof value === 'object') collectIdentifiers(value, ctx, depth + 1);
  }
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 净化规则：QQ 号统一换成 123456789，本机路径换成占位符。 */
export function buildSanitizeRules(context) {
  const rules = [];
  const numbers = (context?.qqNumbers ?? []).filter((n) => /^\d+$/.test(n));
  if (numbers.length) {
    rules.push({
      name: '真实 QQ 号',
      pattern: new RegExp(`(?<!\\d)(?:${numbers.map(escapeRegExp).join('|')})(?!\\d)`, 'g'),
      replacement: '123456789',
    });
  }
  rules.push(
    { name: '本机路径（E:\\qq-project）', pattern: /E:[\\/]qq-project/gi, replacement: '<repo>' },
    { name: '本机路径（C:\\Users\\PC）', pattern: /C:[\\/]Users[\\/]PC/gi, replacement: 'C:\\Users\\<user>' },
  );
  return rules;
}

/** 对条目做净化。返回 { entries, stats, changedFiles }。 */
export function sanitizeEntries(entries, rules) {
  const stats = new Map(rules.map((rule) => [rule.name, { files: 0, occurrences: 0 }]));
  const changedFiles = [];
  const out = entries.map((entry) => {
    if (entry.data.length > MAX_SCAN_BYTES || !isTextEntry(entry.name) || looksBinary(entry.data)) return entry;
    let text = entry.data.toString('utf8');
    let changed = false;
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      let count = 0;
      text = text.replace(rule.pattern, () => {
        count += 1;
        return rule.replacement;
      });
      if (count > 0) {
        const bucket = stats.get(rule.name);
        bucket.occurrences += count;
        bucket.files += 1;
        changed = true;
      }
    }
    if (!changed) return entry;
    changedFiles.push(entry.name);
    return { ...entry, data: Buffer.from(text, 'utf8') };
  });
  return { entries: out, stats: [...stats.entries()].map(([name, stat]) => ({ name, ...stat })), changedFiles };
}

// ── 硬闸：令牌 / API key / Cookie（净化前后都查，命中即 exit 1） ──────────────
/** 测试夹具里刻意写的假 key：白名单**只对 scripts/test-*.mjs 与 scripts/fixtures/** 生效**。 */
const KNOWN_FAKE_KEYS = new Set([
  'sk-verysecret-123456',
  'sk-test-only-for-unit-test',
  'sk-from-dsh-credentials',
]);

/** 扫描器自己（和它的自检）里必然含有规则文本，逐条扫会自报家门。 */
const SELF_SCAN_SKIP = new Set(['scripts/pack-release.mjs', 'scripts/test-pack-release.mjs']);

function isFakeKeyAllowed(entryName) {
  return /^scripts\/test-[^/]+\.mjs$/.test(entryName) || entryName.startsWith('scripts/fixtures/');
}

// 测试夹具里的假值长什么样：`sk-high-abcdef`、`pk-free-123456`、`sk-from-env`、
// `_plaza_session_id=abc123`…… 白名单**只对 scripts/test-*.mjs 与 scripts/fixtures/** 生效**，
// 且只放过「一眼假」的值；真 key 混进测试文件照样会被拦下。
const FAKE_VALUE_MARKERS = /(?:test|fake|dummy|mock|sample|example|placeholder|invalid|wrong|free|high|from-env|from-config|abc|1234)/i;

function isFakeValueAllowed(entryName, raw) {
  if (!isFakeKeyAllowed(entryName)) return false;
  return KNOWN_FAKE_KEYS.has(raw) || FAKE_VALUE_MARKERS.test(raw);
}

/** 硬闸规则。literal = 明文比对（令牌），pattern = 正则（匹配「值」而不是「名字」）。 */
export function buildHardGateRules(context) {
  const rules = [
    { name: 'API key（sk- 20+）', pattern: /sk-[A-Za-z0-9_-]{20,}/g, fakeable: true },
    { name: 'bigmodel 密钥', pattern: /bigmodel[^\n]{0,80}?\b[0-9a-f]{16,}\b/gi },
    {
      name: 'apiKey 真值',
      pattern: /["']?apiKey["']?\s*:\s*["']([A-Za-z0-9_\-.]{12,})["']/gi,
      fakeable: true,
      valueGroup: 1,
    },
    { name: 'BOOTH 会话值', pattern: /_plaza_session_id\s*=\s*[A-Za-z0-9%._-]{16,}/g, fakeable: true },
    // 尾部再带一段：好让「假值放行」能看见 cookie 的值本身（只看 `Cookie: ..._plaza_session_id` 这几个字
    // 判断不了真假，会把测试夹具里的 abc123 也当成真会话）。
    { name: '带 booth 的 Cookie 头', pattern: /Cookie:\s*[^\n]{0,200}?(?:booth|booth_session|_plaza_session_id)[^\n]{0,120}/gi, fakeable: true },
    { name: 'booth_session 值', pattern: /booth_session\s*=\s*[A-Za-z0-9%._-]{8,}/gi, fakeable: true },
    { name: 'BOOTH Cookie 数据', pattern: /booth-cookies[^\n]{0,40}["']?(?:current|accounts|cookies)["']?\s*:\s*[{[]["']?/i },
  ];
  for (const token of context?.tokens ?? []) {
    rules.push({ name: '控制台令牌（state/console-token 的实际值）', literal: token });
  }
  return rules;
}

/** 只回显脱敏片段：首 3 + *** + 末 2，长度不足就全遮。 */
export function maskSnippet(text) {
  const s = String(text ?? '');
  if (s.length <= 6) return '*'.repeat(Math.max(s.length, 1));
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

function isPlaceholderValue(value) {
  const v = String(value ?? '');
  return v === '' || /[<$`{}\\]/.test(v) || /^(?:x{3,}|your|test|example|placeholder|dummy|fake)/i.test(v) || KNOWN_FAKE_KEYS.has(v);
}

/** 逐条规则扫一段文本，返回 [{ rule, snippet }]；allowed 收集「按测试假值放行」的项。 */
export function scanTextForSecrets(text, rules, entryName = '', allowed = null) {
  const hits = [];
  for (const rule of rules) {
    if (rule.literal) {
      let from = 0;
      for (;;) {
        const index = text.indexOf(rule.literal, from);
        if (index < 0) break;
        hits.push({ rule: rule.name, snippet: maskSnippet(rule.literal) });
        from = index + rule.literal.length;
      }
      continue;
    }
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(text)) !== null) {
      const raw = rule.valueGroup ? match[rule.valueGroup] : match[0];
      const allowedFake = rule.fakeable && isFakeValueAllowed(entryName, raw);
      if (allowedFake) {
        // 放行的假值也留痕：报告里会列出「哪几个文件的哪条规则按测试假值放过」。
        if (allowed) allowed.push({ rule: rule.name, snippet: maskSnippet(match[0]) });
      } else if (rule.valueGroup) {
        if (!isPlaceholderValue(raw)) hits.push({ rule: rule.name, snippet: maskSnippet(match[0]) });
      } else {
        hits.push({ rule: rule.name, snippet: maskSnippet(match[0]) });
      }
      if (match[0].length === 0) rule.pattern.lastIndex += 1;
    }
  }
  return hits;
}

function looksBinary(buffer) {
  const head = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of head) if (byte === 0) return true;
  return false;
}

function isTextEntry(rel) {
  return !BINARY_EXT.has(path.extname(rel).toLowerCase());
}

/** 扫所有要打包的条目（entry = { name, data }）；allowedFake 记录按测试假值放行的项。 */
export function scanEntries(entries, rules) {
  const hits = [];
  const allowedFake = [];
  let scanned = 0;
  let skippedBinary = 0;
  let skippedLarge = 0;
  for (const entry of entries) {
    if (SELF_SCAN_SKIP.has(entry.name)) {
      skippedBinary += 1;
      continue;
    }
    if (entry.data.length > MAX_SCAN_BYTES) {
      skippedLarge += 1;
      continue;
    }
    if (!isTextEntry(entry.name) || looksBinary(entry.data)) {
      skippedBinary += 1;
      continue;
    }
    scanned += 1;
    const allowedHere = [];
    for (const hit of scanTextForSecrets(entry.data.toString('utf8'), rules, entry.name, allowedHere)) {
      hits.push({ file: entry.name, rule: hit.rule, snippet: hit.snippet });
    }
    for (const item of allowedHere) allowedFake.push({ file: entry.name, ...item });
  }
  return { hits, allowedFake, scanned, skippedBinary, skippedLarge };
}

/** 净化后的自检：QQ 号必须 0 命中（防止有文件因超 2MB 被跳过净化却没被拦）。 */
export function findLeftoverQq(entries, context) {
  const numbers = (context?.qqNumbers ?? []).filter((n) => /^\d+$/.test(n));
  if (!numbers.length) return [];
  const pattern = new RegExp(`(?<!\\d)(?:${numbers.map(escapeRegExp).join('|')})(?!\\d)`);
  const leftovers = [];
  for (const entry of entries) {
    if (SELF_SCAN_SKIP.has(entry.name) || !isTextEntry(entry.name) || looksBinary(entry.data)) continue;
    if (pattern.test(entry.data.toString('utf8'))) leftovers.push(entry.name);
  }
  return leftovers;
}

/**
 * 结构检查：不该进包的东西一出现就是事故，不依赖内容扫描。
 * `allowNodeModules` 只在 `--with-node-modules` 离线包里为 true（依赖是刻意打进去的）；
 * 即使允许，`.bin` / `.cache` / `.package-lock.json` 这些运行时不需要的仍算问题。
 */
export function checkStructure(entries, { allowNodeModules = false } = {}) {
  const problems = [];
  const required = ['package.json', 'config.example.json', 'docs/RELEASE-MANIFEST.md'];
  for (const rel of required) {
    if (!entries.some((entry) => entry.name === rel)) problems.push(`缺少必需文件：${rel}`);
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name === 'config.json' || name.startsWith('config.json.')) problems.push(`包内含真实配置：${name}`);
    if (/(^|\/)state\//.test(name)) problems.push(`包内含 state/：${name}`);
    if (/(^|\/)\.dsh\//.test(name)) problems.push(`包内含 .dsh/：${name}`);
    if (/(^|\/)node_modules\//.test(name)) {
      const allowed = allowNodeModules && !/^node_modules\/\.(?:bin|cache|package-lock\.json)(?:\/|$)/.test(name);
      if (!allowed) problems.push(`包内含 node_modules/：${name}`);
    }
    if (/(^|\/)__pycache__\//.test(name)) problems.push(`包内含 __pycache__/：${name}`);
    if (name.startsWith('/') || name.includes('..')) problems.push(`包内路径不安全：${name}`);
    if (/\.exe$/i.test(name) && !name.startsWith('installer/')) problems.push(`包内含 exe：${name}`);
    if (/\.log$/i.test(name)) problems.push(`包内含日志：${name}`);
    if (/\.local\./i.test(name)) problems.push(`包内含本机覆盖文件：${name}`);
  }
  return problems;
}

// ── 自写 ZIP（stored + deflate，无第三方依赖） ────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const ALREADY_COMPRESSED = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.mp4', '.webm', '.mov',
  '.wav', '.mp3', '.ogg', '.m4a', '.zip', '.tgz', '.gz', '.7z', '.rar', '.zst', '.xz',
  '.exe', '.dll', '.node', '.woff', '.woff2', '.ttf', '.otf',
]);

/** 把 [{name, data, mtime}] 打成 zip Buffer。UTF-8 文件名（flag bit 11）。 */
export function buildZipBuffer(entries) {
  if (entries.length > 65000) throw new Error(`条目过多（${entries.length} > 65000）：ZIP 经典格式上限`);
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const raw = entry.data;
    const ext = path.extname(entry.name).toLowerCase();
    let method = 0;
    let payload = raw;
    if (!ALREADY_COMPRESSED.has(ext)) {
      try {
        const deflated = zlib.deflateRawSync(raw, { level: 9 });
        if (deflated.length < raw.length) {
          method = 8;
          payload = deflated;
        }
      } catch {
        /* 压缩失败就 stored，不让打包失败 */
      }
    }
    const crc = crc32(raw);
    const { time, date } = dosDateTime(entry.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
    if (offset > 0xffffffff - 0x06000000) throw new Error('包太大（超过 4GB）：ZIP 经典格式不支持，需 ZIP64');
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuffer, eocd]);
}

/** 写出 zip 并回 { bytes, sha256 }。 */
export function writeZip(entries, outPath) {
  const buffer = buildZipBuffer(entries);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return { bytes: buffer.length, sha256 };
}

/** 拆包：安装程序只进 -full，依赖只进 -src-offline（以及带 --with-node-modules 的 -full）。 */
export function splitPackEntries(entries) {
  const isInstaller = (entry) => entry.name.startsWith('installer/');
  const isNodeModules = (entry) => entry.name.startsWith('node_modules/');
  return {
    // 默认源码包：既不带安装程序，也不带依赖（体积最小，目标机 npm ci）。
    src: entries.filter((entry) => !isInstaller(entry) && !isNodeModules(entry)),
    // 离线包：源码 + 生产依赖，仍然不带安装程序（目标机有 Node 就能 npm start）。
    offline: entries.filter((entry) => !isInstaller(entry)),
    // full 包：全部（给了 --with-node-modules 时也含依赖）。
    full: entries,
  };
}

// ── 输出 ──────────────────────────────────────────────────────────────────────
export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function dateStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function readVersion(root = ROOT) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function parseArgs(argv) {
  const opts = { dryRun: false, withInstaller: false, withNodeModules: false, out: 'dist/releases', list: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--with-installer') opts.withInstaller = true;
    else if (arg === '--with-node-modules') opts.withNodeModules = true;
    else if (arg === '--list') opts.list = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--out') {
      const next = argv[i + 1];
      if (!next) throw new Error('--out 后面要跟输出目录');
      opts.out = next;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`不认识的参数：${arg}（支持 --dry-run / --with-installer / --with-node-modules / --out <dir> / --list / --json）`);
    }
  }
  return opts;
}

function printManifest(files, extras) {
  const byRoot = new Map();
  for (const file of files) {
    const root = file.rel.split('/')[0];
    const bucket = byRoot.get(root) ?? { count: 0, bytes: 0 };
    bucket.count += 1;
    bucket.bytes += file.size;
    byRoot.set(root, bucket);
  }
  console.log(`[清单] 共 ${files.length} 个文件 / ${formatBytes(extras.totalBytes)}（未压缩）`);
  for (const [root, bucket] of [...byRoot.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${root.padEnd(16)} ${String(bucket.count).padStart(5)} 个 / ${formatBytes(bucket.bytes)}`);
  }
  if (extras.missingOptional.length) console.log(`[清单] 未找到（跳过，不阻断）：${extras.missingOptional.join('、')}`);
  const shown = extras.list ? files : files.slice(0, 30);
  console.log(`[清单] ${extras.list ? '全部' : '前 30 项'}：`);
  for (const file of shown) console.log(`  ${file.rel}`);
  if (!extras.list && files.length > shown.length) console.log(`  … 其余 ${files.length - shown.length} 项（--list 看全部）`);
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
async function main() {
  const started = Date.now();
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const text = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    console.log(text.split('\n').slice(1, 26).join('\n').replace(/^\/\/ ?/gm, ''));
    return 0;
  }
  const version = readVersion(ROOT);
  const stamp = dateStamp();
  const { files, skipped, missingOptional, nodeModules } = collectReleaseFiles({
    root: ROOT,
    withInstaller: opts.withInstaller,
    withNodeModules: opts.withNodeModules,
  });
  if (!files.length) throw new Error('没收集到任何文件：工作目录不对？');
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (opts.dryRun) printManifest(files, { totalBytes, missingOptional, list: opts.list });
  if (nodeModules) {
    // 单独报一行：离线包大多少、值不值，一眼能看出来；也便于跟 -full 包对比。
    console.log(`[清单] node_modules（生产依赖 ${nodeModules.tops.length} 个顶层目录，npm ls --omit=dev）：${nodeModules.files} 个文件 / ${formatBytes(nodeModules.bytes)}`);
  }
  if (skipped.length) {
    console.log(`[清单] 跳过 ${skipped.length} 个文件：`);
    for (const item of skipped.slice(0, 10)) console.log(`  - ${item.rel}（${item.reason}）`);
    if (skipped.length > 10) console.log(`  … 其余 ${skipped.length - 10} 个省略`);
  }

  // ① 收集 → ② 净化（只改内存副本）
  const context = loadSecretContext(ROOT);
  const rawEntries = files.map((file) => ({
    name: file.rel,
    // installer/SHA256.txt 这类合成条目直接带 data；普通文件才读盘。
    data: file.data ?? fs.readFileSync(file.abs),
    mtime: file.mtime,
  }));
  const sanitize = sanitizeEntries(rawEntries, buildSanitizeRules(context));
  const entries = sanitize.entries;

  // ③ 硬闸（净化后的副本上跑；净化规则不碰令牌/key/Cookie，所以不会掩盖真泄漏）
  const hardRules = buildHardGateRules(context);
  const { hits, allowedFake, scanned, skippedBinary, skippedLarge } = scanEntries(entries, hardRules);
  const structural = checkStructure(entries, { allowNodeModules: opts.withNodeModules });
  const leftoverQq = findLeftoverQq(entries, context);

  const noChange = sanitize.changedFiles.length === 0;
  console.log(`[净化] 改了 ${sanitize.changedFiles.length} 个文件${noChange ? '（本来就没有要替换的）' : ''}：`);
  for (const stat of sanitize.stats) {
    console.log(`  ${stat.name.padEnd(24)} ${String(stat.occurrences).padStart(4)} 处 / ${stat.files} 个文件`);
  }
  console.log(`[硬闸] 扫描 ${scanned} 个文本文件（跳过二进制 ${skippedBinary} / 超 2MB ${skippedLarge}），规则 ${hardRules.length} 条`);
  if (allowedFake.length) {
    console.log(`[硬闸] 按测试假值放行 ${allowedFake.length} 处（仅 scripts/test-*.mjs 与 scripts/fixtures/**）：`);
    for (const item of allowedFake) console.log(`  - ${item.file} → ${item.rule}（${item.snippet}）`);
  }
  if (leftoverQq.length) console.error(`[硬闸] ✗ 净化后仍残留真实 QQ 号：${leftoverQq.join('、')}`);
  if (structural.length) {
    console.error(`[硬闸] ✗ 结构检查命中 ${structural.length} 项：`);
    for (const problem of structural) console.error(`  - ${problem}`);
  }
  if (hits.length) {
    console.error(`[硬闸] ✗ 敏感信息命中 ${hits.length} 处：`);
    for (const hit of hits.slice(0, 40)) console.error(`  - ${hit.file} → ${hit.rule}（${hit.snippet}）`);
    if (hits.length > 40) console.error(`  … 其余 ${hits.length - 40} 处省略`);
  }
  const summary = {
    version,
    stamp,
    withInstaller: opts.withInstaller,
    withNodeModules: opts.withNodeModules,
    nodeModules,
    files: files.length,
    totalBytes,
    sanitize: { changedFiles: sanitize.changedFiles.length, stats: sanitize.stats },
    hardGate: {
      scanned,
      skippedBinary,
      skippedLarge,
      rules: hardRules.length,
      hits: hits.length,
      allowedFake: allowedFake.length,
      identifiers: context.qqNumbers.length,
      tokenSources: context.sources,
    },
    skippedFiles: skipped,
    missingOptional,
    secretHits: hits.map((hit) => ({ file: hit.file, rule: hit.rule })),
    allowedFakeValues: allowedFake.map((item) => ({ file: item.file, rule: item.rule })),
    structuralProblems: structural,
    leftoverQq,
  };
  if (leftoverQq.length || structural.length || hits.length) {
    summary.ok = false;
    if (opts.json) console.log(JSON.stringify(summary, null, 2));
    console.error('[硬闸] 打包已中止（exit 1）：先把上面的文件处理干净再发。');
    return 1;
  }
  console.log('[硬闸] ✓ 令牌 / key / Cookie 0 命中；净化后 QQ 号 0 残留；结构检查通过');

  if (opts.dryRun) {
    console.log('[打包] --dry-run：只打印清单与检查结果，未写任何文件');
    summary.ok = true;
    if (opts.json) console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  const outDir = path.resolve(ROOT, opts.out);
  const baseName = `QQDeepSeekBot-${version}-${stamp}`;
  // src 包**不含** installer/ 也不含 node_modules/：安装程序只进 -full，依赖只进 -src-offline，
  // 否则三个包彼此重复、体积失控（源码包 671 个文件里凭空多 55MB 安装程序 + 21MB 依赖）。
  const { src: srcEntries, offline: offlineEntries, full: fullEntries } = splitPackEntries(entries);
  summary.outputs = [];
  const writeAndReport = (list, suffix) => {
    const outPath = path.join(outDir, `${baseName}${suffix}.zip`);
    const written = writeZip(list, outPath);
    console.log(`[产物] ${path.relative(ROOT, outPath).replace(/\\/g, '/')} · ${list.length} 个文件 · ${formatBytes(written.bytes)} · sha256 ${written.sha256}`);
    summary.outputs.push({ path: outPath, files: list.length, bytes: written.bytes, sha256: written.sha256 });
    return written;
  };
  writeAndReport(srcEntries, '-src');
  if (opts.withNodeModules) writeAndReport(offlineEntries, '-src-offline');
  if (opts.withInstaller) writeAndReport(fullEntries, '-full');
  summary.ok = true;
  summary.elapsedMs = Date.now() - started;
  console.log(`[完成] 用时 ${(summary.elapsedMs / 1000).toFixed(2)}s`);
  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  return 0;
}

const isDirectRun = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[pack-release] 失败：${error?.message ?? error}`);
      process.exit(1);
    });
}
