// state/*.json 定时备份 + 保留策略：白名单、增量（mtime+size）、keep/daily 保留、dry-run、
// 坏 JSON、同秒不覆盖、清理不误删手动备份，以及 CLI 子进程行为。
// 不启桥接：直接 import 工厂 + 子进程跑 scripts/backup-state.mjs。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createStateBackup } from '../src/bridge/state-backup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'backup-state.mjs');
const WHITELIST = ['impressions.json', 'member-notes.json', 'slang-abc.json', 'slang.json', 'social-v2.json'];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
}

function mkStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'state-backup-'));
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeJson(file, value) {
  writeFile(file, `${JSON.stringify(value)}\n`);
}

// 造一个「像线上 state/」的目录：白名单 5 个、非白名单若干（子目录/大二进制/派生/日志）。
function seedState(dir) {
  writeJson(path.join(dir, 'social-v2.json'), { sessions: { a: 1 }, topic: '话题' });
  writeJson(path.join(dir, 'slang.json'), { terms: [{ word: 'x' }] });
  writeJson(path.join(dir, 'slang-abc.json'), { shard: 'abc' });
  writeJson(path.join(dir, 'slang-session.json'), { sessionId: 'session-x' });
  writeFile(path.join(dir, 'member-notes.json'), '{"1":{"name":"K"}}');
  writeJson(path.join(dir, 'impressions.json'), { generatedAt: '2026-10-29T00:00:00Z', people: [] });
  writeJson(path.join(dir, 'agents', 'x.json'), { ignored: true });
  writeFile(path.join(dir, 'big.bin'), Buffer.alloc(1024, 7));
  writeJson(path.join(dir, 'tmp-slang.json'), { tmp: true });
  writeJson(path.join(dir, 'tool-log.json'), { log: true });
  writeFile(path.join(dir, 'messages.db'), 'sqlite');
}

function backupFor(stateDir, logLines) {
  return createStateBackup({
    STATE_DIR: stateDir,
    fs,
    path,
    log: (message) => {
      if (logLines) logLines.push(String(message));
    }
  });
}

function backupDir(stateDir) {
  return path.join(stateDir, 'backups');
}

function allNames(stateDir) {
  try {
    return fs.readdirSync(backupDir(stateDir)).sort();
  } catch {
    return [];
  }
}

// 只认自己的命名规则（.manifest.json/.tmp 不算）。
function backupNames(stateDir) {
  return allNames(stateDir).filter((name) => !name.startsWith('.'));
}

function readManifest(stateDir) {
  return JSON.parse(fs.readFileSync(path.join(backupDir(stateDir), '.manifest.json'), 'utf8'));
}

function sourcePath(stateDir, name) {
  return path.join(stateDir, name);
}

function setMtime(file, ms) {
  const date = new Date(ms);
  fs.utimesSync(file, date, date);
}

function bumpMtime(file, seconds) {
  setMtime(file, Date.now() + seconds * 1000);
}

// 相对于今天第 offsetDays 天的备份戳（YYYYMMDD-HHmmss），避免测试依赖固定日期。
function dayStamp(offsetDays, clock = '030000') {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const monthDay = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${monthDay}-${clock}`;
}

// 备份名按键排序（日期 > 时刻 > 同秒序号），用于断言「每组首条是最新」。
function nameKey(name) {
  const match = /\.(\d{8}-\d{6})(?:-(\d+))?\.json$/.exec(name);
  if (!match) return '';
  return `${match[1]}-${String(match[2] ?? 0).padStart(3, '0')}`;
}

function fabricate(stateDir, name, content) {
  writeFile(path.join(backupDir(stateDir), name), content ?? '{"old":true}');
}

const NAME_RE = /^(affinity|friend-names|group-names|impressions|member-notes|people|slang|slang-abc|social-v2|stickers)\.(\d{8}-\d{6})(-\d+)?\.json$/;

function runMain() {
  // ---- 1. 首次备份：白名单、命名、manifest、字节一致 ----
  const dir1 = mkStateDir();
  seedState(dir1);
  const logs1 = [];
  const b1 = backupFor(dir1, logs1);
  const r1 = b1.backupStateNow();
  check('首次运行 ok', r1.ok === true);
  check('只备份白名单 5 个文件', r1.written.length === 5
    && r1.written.map((item) => item.source).sort().join(',') === WHITELIST.join(','));
  check('文件名 <name>.<YYYYMMDD-HHmmss>.json', backupNames(dir1).length === WHITELIST.length && backupNames(dir1).every((name) => NAME_RE.test(name)));
  check('非白名单/大文件/派生文件不进备份', backupNames(dir1).every((name) => !/agents|big\.bin|tmp-slang|slang-session|tool-log|messages\.db/.test(name)));
  check('备份目录里只有 5 份备份 + 索引', allNames(dir1).length === WHITELIST.length + 1 && allNames(dir1).includes('.manifest.json'));
  check('没有残留 .tmp', allNames(dir1).every((name) => !name.endsWith('.tmp')));

  const manifest1 = readManifest(dir1);
  const socialStat = fs.statSync(sourcePath(dir1, 'social-v2.json'));
  check('索引记录 mtimeMs', manifest1['social-v2.json']?.mtimeMs === Math.round(socialStat.mtimeMs));
  check('索引记录 size', manifest1['social-v2.json']?.size === socialStat.size);
  check('索引记录 lastBackupAt（ISO 时间）', typeof manifest1['social-v2.json']?.lastBackupAt === 'string'
    && !Number.isNaN(Date.parse(manifest1['social-v2.json'].lastBackupAt)));
  check('索引只记录白名单 5 项', Object.keys(manifest1).sort().join(',') === WHITELIST.join(','));
  const socialBackup = r1.written.find((item) => item.source === 'social-v2.json');
  check('备份字节与源文件完全一致', fs.readFileSync(socialBackup.path).equals(fs.readFileSync(sourcePath(dir1, 'social-v2.json'))));
  check('写入结果带 size', r1.written.every((item) => item.size > 0 && item.name && item.path));

  // ---- 2. 再跑一次且没变：全部跳过，不产生新文件、不重写索引 ----
  const beforeNames = backupNames(dir1).join(',');
  const beforeManifest = fs.readFileSync(path.join(backupDir(dir1), '.manifest.json'), 'utf8');
  const r2 = b1.backupStateNow();
  check('文件未变时全部跳过', r2.written.length === 0 && r2.skipped.length === WHITELIST.length);
  check('跳过不产生新备份', backupNames(dir1).join(',') === beforeNames);
  check('跳过不重写索引', fs.readFileSync(path.join(backupDir(dir1), '.manifest.json'), 'utf8') === beforeManifest);

  // ---- 3. 改内容（mtime 变化）→ 只重备这一个 ----
  writeJson(sourcePath(dir1, 'social-v2.json'), { sessions: { a: 1, b: 2 } });
  bumpMtime(sourcePath(dir1, 'social-v2.json'), 3);
  const r3 = b1.backupStateNow();
  check('改动后只备份改动的文件', r3.written.length === 1 && r3.written[0].source === 'social-v2.json');
  check('改动产生新备份文件', backupNames(dir1).length === WHITELIST.length + 1);
  check('新备份是改动后的内容', JSON.parse(fs.readFileSync(r3.written[0].path, 'utf8')).sessions.b === 2);

  // ---- 4. 只改大小（mtime 不变）也要重备：mtime 精度不够时的兜底 ----
  const notesStat = fs.statSync(sourcePath(dir1, 'member-notes.json'));
  fs.writeFileSync(sourcePath(dir1, 'member-notes.json'), '{"1":{"name":"K"},"2":{}}');
  setMtime(sourcePath(dir1, 'member-notes.json'), notesStat.mtimeMs);
  const rSize = b1.backupStateNow();
  check('大小变化（mtime 不变）也重备', rSize.written.some((item) => item.source === 'member-notes.json'));

  // ---- 5. 坏 JSON 也备份成功（只搬字节，不解析） ----
  const broken = '{ 这不是 json';
  fs.writeFileSync(sourcePath(dir1, 'slang.json'), broken);
  bumpMtime(sourcePath(dir1, 'slang.json'), 6);
  const r4 = b1.backupStateNow();
  const brokenBackup = r4.written.find((item) => item.source === 'slang.json');
  check('坏 JSON 备份成功', r4.ok === true && Boolean(brokenBackup));
  check('坏 JSON 备份字节一致', fs.readFileSync(brokenBackup.path, 'utf8') === broken);
  check('坏 JSON 源文件没被改写', fs.readFileSync(sourcePath(dir1, 'slang.json'), 'utf8') === broken);

  // ---- 6. dry-run：报告计划，一个字节都不落盘 ----
  const dir2 = mkStateDir();
  seedState(dir2);
  const b2 = backupFor(dir2);
  writeFile(sourcePath(dir2, 'social-v2.json'), '{"changed":true}');
  bumpMtime(sourcePath(dir2, 'social-v2.json'), 9);
  const rd = b2.backupStateNow({ dryRun: true });
  check('dry-run 报告将会写入 5 份', rd.dryRun === true && rd.written.length === WHITELIST.length && rd.written.every((item) => item.planned === true));
  check('dry-run 不建备份目录', !fs.existsSync(backupDir(dir2)));
  check('dry-run 耗时字段存在', typeof rd.ms === 'number' && rd.ms >= 0);

  // ---- 7. keep：只留最近 N 份，清理的正是旧的 ----
  const dir3 = mkStateDir();
  writeJson(sourcePath(dir3, 'social-v2.json'), { v: 0 });
  const b3 = backupFor(dir3);
  b3.backupStateNow();
  for (const offset of [-4, -3, -2, -1]) fabricate(dir3, `social-v2.${dayStamp(offset)}.json`);
  const rk = b3.backupStateNow({ keep: 2, daily: 0 });
  const keptKeep = backupNames(dir3).filter((name) => name.startsWith('social-v2.'));
  check('keep=2 只留最近 2 份', keptKeep.length === 2);
  check('保留的是最新两份', keptKeep.some((name) => name.includes(dayStamp(-1))) && !keptKeep.some((name) => name.includes(dayStamp(-2)) || name.includes(dayStamp(-3)) || name.includes(dayStamp(-4))));
  check('被清理的是旧备份', rk.pruned.length === 3 && rk.pruned.every((item) => item.source === 'social-v2.json'));

  // ---- 8. 每日首份：最近 N 天各留当天最早一份 ----
  const dir4 = mkStateDir();
  writeJson(sourcePath(dir4, 'slang.json'), { v: 0 });
  const b4 = backupFor(dir4);
  b4.backupStateNow();
  for (const offset of [-5, -4, -3, -2, -1]) {
    fabricate(dir4, `slang.${dayStamp(offset)}.json`);
    fabricate(dir4, `slang.${dayStamp(offset, '150000')}.json`);
  }
  b4.backupStateNow({ keep: 1, daily: 3 });
  const keptDaily = backupNames(dir4).filter((name) => name.startsWith('slang.'));
  check('每日首份：最近 3 天各留当天最早一份', [dayStamp(-1), dayStamp(-2)].every((stamp) => keptDaily.includes(`slang.${stamp}.json`)));
  check('每日首份：同一天晚些的那份被清掉', !keptDaily.some((name) => name.includes('-150000')));
  check('每日首份：超出 3 天的更早日期全清', [dayStamp(-5), dayStamp(-4), dayStamp(-3)].every((stamp) => !keptDaily.some((name) => name.includes(stamp))));
  check('每日首份 + keep=1 共留 3 份（今天的 + 2 天首份）', keptDaily.length === 3);

  // ---- 9. 清理不碰用户手动放的备份（命名规则之外的文件） ----
  fabricate(dir3, 'manual-keep.json', '{"manual":true}');
  fabricate(dir3, 'my-notes.txt', 'hello');
  b3.backupStateNow({ keep: 1, daily: 0 });
  check('手动放的 manual-keep.json 留着', fs.existsSync(path.join(backupDir(dir3), 'manual-keep.json')));
  check('非 JSON 文件留着', fs.existsSync(path.join(backupDir(dir3), 'my-notes.txt')));

  // ---- 10. 同秒重复不覆盖：-2 后缀 ----
  const dirX = mkStateDir();
  writeJson(sourcePath(dirX, 'people.json'), { v: 1 });
  const bX = backupFor(dirX);
  bX.backupStateNow();
  writeJson(sourcePath(dirX, 'people.json'), { v: 2 });
  bumpMtime(sourcePath(dirX, 'people.json'), 20);
  bX.backupStateNow();
  writeJson(sourcePath(dirX, 'people.json'), { v: 3 });
  bumpMtime(sourcePath(dirX, 'people.json'), 21);
  bX.backupStateNow();
  const peopleNames = backupNames(dirX).filter((name) => name.startsWith('people.'));
  check('同秒连续备份不覆盖（3 份都在）', peopleNames.length === 3 && new Set(peopleNames).size === 3);

  // ---- 11. 索引损坏：按空索引重备一轮，不丢数据 ----
  const dir5 = mkStateDir();
  writeJson(sourcePath(dir5, 'people.json'), { a: 1 });
  writeFile(path.join(backupDir(dir5), '.manifest.json'), 'not json');
  const logs5 = [];
  const r5 = backupFor(dir5, logs5).backupStateNow();
  check('索引损坏仍能备份', r5.ok === true && r5.written.length === 1);
  check('索引损坏有日志留痕', logs5.some((line) => line.includes('索引损坏')));
  check('索引损坏后重建索引', Object.keys(readManifest(dir5)).length === 1);

  // ---- 12. state 目录不存在：不炸、不凭空建目录 ----
  const dir8 = path.join(mkStateDir(), 'nope');
  const r8 = backupFor(dir8).backupStateNow();
  check('state 目录不存在时 ok 且无写入', r8.ok === true && r8.written.length === 0);
  check('state 目录不存在时不建备份目录', !fs.existsSync(backupDir(dir8)));

  // ---- 13. list：按源分组、时间倒序、每组首条是最新 ----
  const listing = backupFor(dir1).listStateBackups();
  check('list 返回备份目录', listing.backupDir === backupDir(dir1));
  check('list 计数与磁盘一致', listing.count === backupNames(dir1).length);
  check('list 每条带 source/name/size/mtimeMs', listing.files.length > 0 && listing.files.every((file) => file.source && file.name && typeof file.size === 'number' && file.size > 0 && typeof file.mtimeMs === 'number'));
  const firstBySource = new Map();
  for (const file of listing.files) if (!firstBySource.has(file.source)) firstBySource.set(file.source, file);
  check('list 每组首条是该源最新备份', [...firstBySource.values()].every((first) => listing.files
    .filter((file) => file.source === first.source)
    .every((file) => nameKey(file.name) <= nameKey(first.name))));

  // ---- 14. 定时循环：2 小时一次、启动 10s 补跑、unref、只起一套 ----
  const dir6 = mkStateDir();
  writeJson(sourcePath(dir6, 'stickers.json'), { a: 1 });
  const logs6 = [];
  const timers = [];
  const fakeTimer = (fn, ms) => {
    const timer = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
    timers.push(timer);
    return timer;
  };
  const loopBackup = createStateBackup({ STATE_DIR: dir6, fs, path, log: (message) => logs6.push(String(message)), setInterval: fakeTimer, setTimeout: fakeTimer });
  const loopTimer = loopBackup.startStateBackupLoop();
  check('定时器周期 2 小时', loopTimer === timers.find((timer) => timer.ms === 7200000));
  check('启动后 10s 补跑一次', timers.some((timer) => timer.ms === 10000));
  check('所有计时器 unref（不拖住进程退出）', timers.length === 2 && timers.every((timer) => timer.unrefCalled === true));
  check('启动日志写明周期与保留策略', logs6.some((line) => line.includes('每 2 小时') && line.includes('24') && line.includes('14')));
  timers.find((timer) => timer.ms === 10000).fn();
  check('启动补跑真的产生备份', backupNames(dir6).length === 1);
  const again = loopBackup.startStateBackupLoop();
  check('重复调用不重复起表', again === loopTimer && timers.length === 2);

  // ---- 15. CLI：真跑、dry-run、list、非法参数 ----
  const dir7 = mkStateDir();
  seedState(dir7);
  const cli = (args) => spawnSync(process.execPath, [CLI, `--state-dir=${dir7}`, ...args], { cwd: ROOT, encoding: 'utf8' });
  const run1 = cli(['--json']);
  let out1 = null;
  try { out1 = JSON.parse(run1.stdout); } catch { out1 = null; }
  check('CLI 退出码 0 且输出可解析 JSON', run1.status === 0 && out1?.ok === true);
  check('CLI 真写了 5 份备份', backupNames(dir7).length === WHITELIST.length);
  check('CLI 输出带耗时与写入明细', typeof out1?.ms === 'number' && out1.written.length === WHITELIST.length);

  writeFile(sourcePath(dir7, 'social-v2.json'), '{"changed":2}');
  bumpMtime(sourcePath(dir7, 'social-v2.json'), 12);
  const run2 = cli(['--dry-run', '--json']);
  const out2 = JSON.parse(run2.stdout);
  check('CLI --dry-run 报告计划', out2.dryRun === true && out2.written.length === 1 && out2.written[0].source === 'social-v2.json');
  check('CLI --dry-run 不落盘', backupNames(dir7).length === WHITELIST.length);

  const run3 = cli(['--list', '--json']);
  const out3 = JSON.parse(run3.stdout);
  check('CLI --list 列出备份', run3.status === 0 && out3.count === WHITELIST.length);

  check('CLI 非法计数退出码 2', cli(['--keep=abc']).status === 2);
  check('CLI 未知参数退出码 2', cli(['--nope']).status === 2);

  const h = cli(['--help']);
  check('CLI --help 列出主要参数', h.status === 0 && h.stdout.includes('--dry-run') && h.stdout.includes('--keep=N') && h.stdout.includes('--state-dir'));
  const listText = cli(['--list']);
  const listOut = listText.stdout.replace(/\\/g, '/');
  check('CLI --list 给出 cp 恢复命令', listText.status === 0 && listOut.includes('恢复：cp ')
    && listOut.includes(`${dir7.replace(/\\/g, '/')}/social-v2.json`));

  // ---- 汇总 ----
  const failed = results.filter((item) => !item.ok);
  const total = results.length;
  const passed = total - failed.length;
  console.log(`\nstate-backup: ${passed}/${total} ok`);
  if (failed.length > 0) {
    console.log('失败的检查：');
    for (const item of failed) console.log(`  - ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
    process.exitCode = 1;
  }
}

runMain();
