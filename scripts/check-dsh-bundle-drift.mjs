#!/usr/bin/env node
// check-dsh-bundle-drift.mjs — 检查 ~/.dsh/plugins/<bundle> 是不是还连着仓库。
//
// 为什么需要这个文件
// ------------------
// 桥接依赖两个被 DSH 加载的 bundle：qq-agent-presets（preset 行 + 工具守卫）和
// qq-mode-console（控制台宿主注入）。`scripts/setup-dsh.mjs` 会把安装位做成
// 指向本仓库 plugins/<name> 的目录链接（junction/symlink），这样仓库一改、
// DSH 下次启动就直接读到新代码。
//
// 但历史上这两个安装位是**手工复制**出来的普通目录：仓库更新了，DSH 还读旧
// 复制件，于是模型能看见本该被工具守卫隐藏的 `compress` 等工具，每次调用都被
// guard 拒——症状像"守卫坏了"，根因却是安装位没连着仓库。setup 现在会自愈
// （改名备份 + 建链接），可没人跑 setup 时这种漂移会静默存在。
//
// 本脚本就是那条防线：只读、不联网、不起进程，把每个安装位的形态判出来：
//   missing           没装（未安装环境算正常）
//   link              链接且指向本仓库对应目录（正常）
//   link-wrong-target 是链接但指向别处（漂移）
//   copy              普通目录=手工复制件（漂移；再逐文件比 sha256 列不一致文件）
// 退出码：全部 missing/link → 0；有 copy/link-wrong-target → 1。
//
// 用法：
//   node scripts/check-dsh-bundle-drift.mjs                 # 检查默认 DSH_HOME
//   node scripts/check-dsh-bundle-drift.mjs --home <dir>    # 检查指定 DSH_HOME（测试用）
//   node scripts/check-dsh-bundle-drift.mjs --json          # 只输出 JSON
//   node scripts/check-dsh-bundle-drift.mjs qq-agent-presets  # 位置参数=只查指定 bundle
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 默认检查的两个 bundle（与 setup-dsh.mjs 的 ensureBundle 名单一致）。 */
const DEFAULT_BUNDLES = ['qq-agent-presets', 'qq-mode-console'];

/**
 * 本仓库里 bundle 的权威位置。qq-agent-presets 与
 * scripts/build-agent-preset-patches.mjs 的 BUNDLE_DIR 是同一路径；
 * 这里不 import 那个模块，避免为了一次只读检查去拉起 js-yaml 依赖。
 */
function repoBundleDir(name) {
  return path.join(REPO_ROOT, 'plugins', name);
}

/** 最多列出多少个不一致文件（太多没有行动价值，路径都很长）。 */
const STALE_LIST_MAX = 5;

/** 解析命令行：--home <dir>、--json、位置参数=要检查的 bundle 名。 */
function parseArgs(argv) {
  const opts = { home: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), json: false, bundles: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--home') {
      const next = argv[i + 1];
      if (!next) throw new Error('--home 后面缺少目录参数');
      opts.home = next;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`未知参数：${arg}`);
    } else {
      opts.bundles.push(arg);
    }
  }
  if (opts.bundles.length === 0) opts.bundles = [...DEFAULT_BUNDLES];
  return opts;
}

/** 路径比较口径：Windows 大小写不敏感，链接目标两侧都 realpath 后比。 */
function samePath(a, b) {
  const norm = (p) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/** 递归列出目录下所有文件（相对路径用 / 分隔），跳过 node_modules。 */
function walkFiles(dir, base = '', out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const abs = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkFiles(abs, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 普通目录（复制件）的漂移判定：以仓库文件为准，逐个比 sha256；
 * 仓库有而安装位缺失、或内容不同的，都算 stale。安装位多出来的文件
 * （备份、旧产物）不影响加载，不列入清单。
 */
function staleCopyFiles(repoDir, installDir) {
  if (!fs.existsSync(repoDir)) return [];
  const stale = [];
  for (const rel of walkFiles(repoDir, '')) {
    const repoFile = path.join(repoDir, rel);
    const instFile = path.join(installDir, rel);
    if (!fs.existsSync(instFile) || sha256(repoFile) !== sha256(instFile)) {
      stale.push(rel);
      if (stale.length >= STALE_LIST_MAX) break;
    }
  }
  return stale;
}

/** 读安装位的链接目标；realpath 失败时退回 readlink，判不了就当空。 */
function linkTargetOf(linkPath) {
  try {
    return fs.realpathSync(linkPath);
  } catch {
    try {
      return path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
    } catch {
      return null;
    }
  }
}

/** 判一个 bundle 安装位的形态。只读，不修改任何东西。 */
function inspectBundle(home, name) {
  const repoDir = repoBundleDir(name);
  const installDir = path.join(home, 'plugins', name);
  let stat = null;
  try {
    stat = fs.lstatSync(installDir);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!stat) return { name, status: 'missing', target: null, staleFiles: [], repoDir, installDir };
  if (stat.isSymbolicLink()) {
    const target = linkTargetOf(installDir);
    const expected = fs.existsSync(repoDir) ? fs.realpathSync(repoDir) : path.resolve(repoDir);
    const status = target && samePath(target, expected) ? 'link' : 'link-wrong-target';
    return { name, status, target, staleFiles: [], repoDir, installDir };
  }
  if (stat.isDirectory() || stat.isFile()) {
    const staleFiles = stat.isDirectory() ? staleCopyFiles(repoDir, installDir) : [];
    return { name, status: 'copy', target: null, staleFiles, repoDir, installDir };
  }
  return { name, status: 'copy', target: null, staleFiles: [], repoDir, installDir };
}

/** 把判定结果翻成给人看的中文结论；一条 bundle 一句，方便直接贴进工单。 */
function findingFor(bundle) {
  const { name, status, target, staleFiles } = bundle;
  if (status === 'missing') return `${name}：未安装（~/.dsh/plugins 下没有该目录），按未安装处理。`;
  if (status === 'link') return `${name}：已链接到仓库（${target}），正常。`;
  if (status === 'link-wrong-target') {
    return `${name}：链接指向了别处（${target ?? '目标不可读'}），不是本仓库，属漂移；跑 node scripts/setup-dsh.mjs 可自愈。`;
  }
  const hint = staleFiles.length > 0
    ? `与仓库不一致的文件：${staleFiles.join('、')}`
    : '文件内容与仓库一致，但它是复制件而不是链接';
  return `${name}：是手工复制件，DSH 读的是这份旧拷贝（${hint}）；跑 node scripts/setup-dsh.mjs 可自愈。`;
}

/** 汇总成最终 JSON；ok 只认 missing/link 两种正常形态。 */
export function checkDrift({ home, bundles = DEFAULT_BUNDLES }) {
  const homeDir = path.resolve(home);
  const homeExists = fs.existsSync(homeDir);
  const inspected = bundles.map((name) => inspectBundle(homeDir, name));
  const findings = inspected.map(findingFor);
  if (!homeExists) findings.unshift(`未找到 DSH 安装目录 ${homeDir}，按未安装处理。`);
  const drifted = inspected.filter((b) => b.status === 'copy' || b.status === 'link-wrong-target');
  const payload = {
    ok: drifted.length === 0,
    home: homeDir,
    bundles: inspected.map((b) => ({
      name: b.name,
      status: b.status,
      target: b.target,
      staleFiles: b.staleFiles,
    })),
    findings,
  };
  return payload;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, home: '', bundles: [], findings: [e.message] }));
    process.exit(2);
  }
  if (opts.help) {
    console.log('用法：node scripts/check-dsh-bundle-drift.mjs [--home <dir>] [--json] [bundle...]');
    return;
  }
  const payload = checkDrift({ home: opts.home, bundles: opts.bundles });
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    for (const b of payload.bundles) {
      const extra = b.staleFiles.length > 0 ? `  不一致：${b.staleFiles.join(', ')}` : '';
      console.log(`[bundle-drift] ${b.name}: ${b.status}${b.target ? ` → ${b.target}` : ''}${extra}`);
    }
    for (const line of payload.findings) console.log(`[bundle-drift] ${line}`);
    console.log(`[bundle-drift] ${payload.ok ? 'OK：安装位都连着仓库' : 'DRIFT：有安装位没连着仓库（见上）'}`);
  }
  process.exit(payload.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
