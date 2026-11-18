#!/usr/bin/env node
// state/ 备份的手动入口（定时那一路由 src/bridge/state-backup.js 在桥接启动后挂定时器）。
//
// 用法：
//   node scripts/backup-state.mjs                     # 备份 + 清理（默认每个文件留最近 24 份 + 每日首份 14 天）
//   node scripts/backup-state.mjs --dry-run           # 只打印计划，不落盘
//   node scripts/backup-state.mjs --list              # 列出当前备份（含恢复命令）
//   node scripts/backup-state.mjs --keep=48 --daily=30
//   node scripts/backup-state.mjs --json              # 机器可读（配合定时任务/监控）
//
// 恢复（不做自动恢复：恢复会覆盖线上数据，属于破坏性操作，只给命令自己 cp）：
//   node scripts/backup-state.mjs --list
//   cp state/backups/social-v2.20261028-194500.json state/social-v2.json
//
// 注意：恢复前先停桥接（桥接进程内存里是当前状态，不停会立刻把它写回去覆盖你恢复的文件）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStateBackup } from '../src/bridge/state-backup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STATE_DIR = path.join(ROOT, 'state');

const HELP = `state/ 定时备份的手动入口

用法：node scripts/backup-state.mjs [选项]

  --dry-run            只打印计划，不写任何文件
  --list               列出 state/backups/ 里的备份（按源文件分组，带恢复命令）
  --keep=N             每个源文件保留最近 N 份（默认 24，最小 1）
  --daily=N            每天保留一份「当天首份」，保留最近 N 天（默认 14，0=关闭）
  --state-dir=DIR      指定 state 目录（默认仓库下的 state/，主要给测试/演练用）
  --json               输出机器可读 JSON
  -h, --help           显示本帮助

默认行为 = 备份 + 清理。定时备份由桥接启动后自动执行（每 2 小时一次）。`;

class UsageError extends Error {}

function parseCountFlag(flag, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new UsageError(`${flag} 需要非负整数，收到：${raw}`);
  return value;
}

function parseArgs(argv) {
  const options = { dryRun: false, list: false, json: false, help: false, keep: null, daily: null, stateDir: DEFAULT_STATE_DIR };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--keep=')) options.keep = parseCountFlag('--keep', arg.slice('--keep='.length));
    else if (arg.startsWith('--daily=')) options.daily = parseCountFlag('--daily', arg.slice('--daily='.length));
    else if (arg.startsWith('--state-dir=')) {
      const raw = arg.slice('--state-dir='.length);
      if (!raw) throw new UsageError('--state-dir 不能为空');
      options.stateDir = path.resolve(raw);
    } else throw new UsageError(`未知参数：${arg}`);
  }
  if (options.keep !== null && options.keep < 1) throw new UsageError('--keep 至少为 1（0 会把所有备份删光）');
  return options;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function relPath(absolute) {
  return path.relative(ROOT, absolute).replace(/\\/g, '/');
}

function formatSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '?';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(ms) {
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return '?';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function printRun(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const dir = result.backupDir ? displayPath(result.backupDir) : 'state/backups';
  console.log(`状态备份${result.dryRun ? '（--dry-run，未落盘）' : ''}：${dir}`);
  console.log(`  写入 ${result.written.length} 份 / 跳过 ${result.skipped.length} 份 / 清理 ${result.pruned.length} 份 / 耗时 ${result.ms}ms`);
  for (const item of result.written) console.log(`  + ${item.source} → ${item.name}（${formatSize(item.size)}）`);
  for (const item of result.pruned) console.log(`  - ${item.name}（${formatSize(item.size)}，超出保留策略）`);
  for (const message of result.errors) console.log(`  ! ${message}`);
  if (result.dryRun && result.written.length > 0) console.log('  （去掉 --dry-run 才会真的写 state/backups/）');
}

// 显示用路径：仓库内给相对路径，仓库外（--state-dir 指向临时目录/另一块盘）给绝对路径，
// 免得打印出 ../../tmp/... 这种没法直接粘进命令行的东西。
function displayPath(absolute) {
  const relative = relPath(absolute);
  return relative.startsWith('..') ? absolute : relative;
}

function printList(listing, json, stateDir) {
  if (json) {
    console.log(JSON.stringify(listing, null, 2));
    return;
  }
  const dir = listing.backupDir ? displayPath(listing.backupDir) : 'state/backups';
  console.log(`备份目录：${dir}（共 ${listing.count} 份）`);
  if (listing.count === 0) {
    console.log('  （还没有备份：先跑一次 node scripts/backup-state.mjs）');
    return;
  }
  // files 已按「源文件 → 时间倒序」排好：每个源文件的第一条就是最新备份。
  const groups = new Map();
  for (const file of listing.files) {
    if (!groups.has(file.source)) groups.set(file.source, []);
    groups.get(file.source).push(file);
  }
  for (const [source, files] of groups) {
    const latest = files[0];
    console.log(`  ${source}  ${files.length} 份  最新 ${latest.name}（${formatSize(latest.size)} ${formatTime(latest.mtimeMs)}）`);
    console.log(`    恢复：cp ${dir}/${latest.name} ${displayPath(path.join(stateDir, source))}`);
  }
  console.log('  恢复前先停桥接，否则内存里的旧状态会立刻写回去覆盖恢复的文件。');
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error?.message ?? error));
    console.error('用 node scripts/backup-state.mjs --help 看用法。');
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(HELP);
    return;
  }
  const backup = createStateBackup({ STATE_DIR: options.stateDir, fs, path, log: (message) => console.log(String(message)) });
  if (options.list) {
    printList(backup.listStateBackups(), options.json, options.stateDir);
    return;
  }
  const result = backup.backupStateNow({ dryRun: options.dryRun, keep: options.keep ?? undefined, daily: options.daily ?? undefined });
  printRun(result, options.json);
  if (!result.ok) process.exitCode = 1;
}

main();
