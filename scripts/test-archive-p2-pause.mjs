// P2①：全局暂停（429/403 → 整体暂停 → 快速失败 → 到期自动恢复）的回归测试。
// 负例是重点：**造一个会失败的输入**——429/403 必须触发暂停、暂停期间任务必须"快速失败"而不是重试、
// 坏掉的暂停文件不能把业务卡死。全程只用 %TEMP%，不碰真实 state/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PAUSE_STATE_FILE, DEFAULT_PAUSE_MS, ArchivePausedError,
  classifyArchiveHttpFailure, recordArchiveHttpFailure, writeArchivePause,
  readArchivePause, isArchivePaused, assertArchiveNotPaused, clearArchivePause, pauseStatePath,
} from '../src/archive-p2.js';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const tmpDirs = [];
function tempState() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-pause-')); tmpDirs.push(d); return d; }
const tmpLeftovers = (dir) => fs.readdirSync(dir).filter((f) => f.includes('.tmp-')).length;

// ── 1. 状态分类：只有 429/403 触发暂停 ──────────────────────────────────────
{
  check('500：不暂停、可重试（单任务重试，不该整体停）',
    classifyArchiveHttpFailure(500).pause === false && classifyArchiveHttpFailure(500).retryable === true);
  check('404：不暂停、不重试（不是限流问题）',
    classifyArchiveHttpFailure(404).pause === false && classifyArchiveHttpFailure(404).retryable === false);
  check('429：暂停 + 可重试（限流是暂时的）',
    classifyArchiveHttpFailure(429).pause === true && classifyArchiveHttpFailure(429).retryable === true);
  check('403：暂停 + 不重试（被拒了，再试只会继续撞墙）',
    classifyArchiveHttpFailure(403).pause === true && classifyArchiveHttpFailure(403).retryable === false);
}

// ── 2. 负例：429 真的写出暂停文件（原子、字段齐全） ────────────────────────
{
  const state = tempState();
  const now = Date.now();
  const r = recordArchiveHttpFailure(state, { status: 429, scope: 'group:100000001', nowMs: now });
  check('429 → 返回 paused:true 且带 untilMs', r.paused === true && r.untilMs > now, JSON.stringify(r));
  const file = pauseStatePath(state);
  check('暂停文件落在 state/file-archive-pause.json', fs.existsSync(file) && path.basename(file) === PAUSE_STATE_FILE);
  const rec = readArchivePause(state);
  check('暂停记录带 until/why/scope/since',
    !!rec && rec.untilMs > now && rec.why === 'rate-limited' && rec.scope === 'group:100000001' && rec.sinceMs === now,
    JSON.stringify(rec));
  check('默认暂停窗口 ≈ DEFAULT_PAUSE_MS',
    Math.abs(rec.untilMs - now - DEFAULT_PAUSE_MS) < 1000, String(rec.untilMs - now));
  check('状态目录里没有 .tmp- 残留（原子写收尾干净）', tmpLeftovers(state) === 0);
  check('暂停时 isArchivePaused=true 且 remainingMs>0', isArchivePaused(state, { nowMs: now }).paused === true);
}

// ── 3. 负例：暂停期间任务必须"快速失败"，且不写任何重试状态 ────────────────
{
  const state = tempState();
  const now = Date.now();
  writeArchivePause(state, { untilMs: now + 60_000, why: 'rate-limited', scope: 'group:1' }, { nowMs: now });
  const before = fs.readFileSync(pauseStatePath(state), 'utf8');
  let err = null;
  try { assertArchiveNotPaused(state, { nowMs: now + 1000 }); } catch (e) { err = e; }
  check('暂停中 assertArchiveNotPaused 抛 ArchivePausedError',
    err instanceof ArchivePausedError && err.code === 'ARCHIVE_PAUSED', String(err && err.message));
  check('错误里带剩余时间与原因', !!err && err.remainingMs > 0 && err.why === 'rate-limited');
  check('快速失败不改暂停文件（没有重试记账/没有续期）',
    fs.readFileSync(pauseStatePath(state), 'utf8') === before);
  // 连撞三次仍然只是抛，不会累加成别的状态
  for (let i = 0; i < 3; i++) { try { assertArchiveNotPaused(state, { nowMs: now + 2000 }); } catch {} }
  check('连撞 3 次后暂停文件仍未变', fs.readFileSync(pauseStatePath(state), 'utf8') === before);
}

// ── 4. 到期自动恢复 ────────────────────────────────────────────────────────
{
  const state = tempState();
  const now = Date.now();
  writeArchivePause(state, { untilMs: now + 30, why: 'rate-limited' }, { nowMs: now });
  check('到期前 1ms 仍是暂停', isArchivePaused(state, { nowMs: now + 29 }).paused === true);
  check('到期后自动恢复（不需要任何清理动作）', isArchivePaused(state, { nowMs: now + 31 }).paused === false);
  let threw = false;
  try { assertArchiveNotPaused(state, { nowMs: now + 31 }); } catch { threw = true; }
  check('到期后任务闸不再抛', threw === false);
  check('到期后记录仍在（等显式清理，不偷偷写盘）', readArchivePause(state) !== null);
  check('显式清理后文件消失', clearArchivePause(state) === true && !fs.existsSync(pauseStatePath(state)));
  check('重复清理返回 false 不抛', clearArchivePause(state) === false);
}

// ── 5. 负例：坏状态文件不能卡死业务 ────────────────────────────────────────
{
  const state = tempState();
  fs.writeFileSync(pauseStatePath(state), '{ 这不是 JSON');
  check('坏暂停文件 → isArchivePaused=false（不抛）', isArchivePaused(state).paused === false);
  let threw = false;
  try { assertArchiveNotPaused(state); } catch { threw = true; }
  check('坏暂停文件 → 任务闸放行', threw === false);
  check('坏暂停文件 → readArchivePause 返回 null', readArchivePause(state) === null);

  fs.writeFileSync(pauseStatePath(state), JSON.stringify({ untilMs: 'not-a-number', why: 'x' }));
  check('untilMs 非数字 → 视为无暂停', isArchivePaused(state).paused === false);

  fs.writeFileSync(pauseStatePath(state), JSON.stringify({ untilMs: Date.now() - 1000 }));
  check('写入一个已过期的 until → 不暂停', isArchivePaused(state).paused === false);
  const past = writeArchivePause(state, { untilMs: Date.now() - 5000, why: 'x' }, { nowMs: Date.now() });
  check('writeArchivePause 传过期时间 → 返回 null 且清掉文件',
    past === null && !fs.existsSync(pauseStatePath(state)));
}

// ── 6. 自定义暂停窗口（被封久一点） ────────────────────────────────────────
{
  const state = tempState();
  const now = Date.now();
  const r = recordArchiveHttpFailure(state, { status: 403, nowMs: now, pauseMs: 3 * 60 * 60 * 1000 });
  check('403 用自定义 3h 窗口', r.paused === true && Math.abs(r.untilMs - now - 3 * 3600_000) < 1000);
  check('403 的 why=forbidden', readArchivePause(state).why === 'forbidden');
}

for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
const total = pass + failures.length;
if (failures.length) {
  console.log(`\n❌ test-archive-p2-pause 失败 ${failures.length}/${total}`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log(`\n✅ test-archive-p2-pause 全部通过（${pass}/${total}）`);
