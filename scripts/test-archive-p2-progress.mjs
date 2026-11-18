// P2②：任务断点（每项落盘 / 重启接着做 / 连续 3 次失败就停）的回归测试。
// 负例是重点：**中途杀进程**（这里用"重新从磁盘读一遍进度"等价模拟）之后必须接着做，
// 不能从头上重做；连续 3 次失败必须真的停下；上一批的迟到结果不能污染新批。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TASK_STATE_FILE, MAX_CONSECUTIVE_FAILURES,
  beginTask, readTaskProgress, writeTaskProgress, clearTaskProgress,
  nextPendingTask, markTaskItem, taskStatus, taskStatePath,
} from '../src/archive-p2.js';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const tmpDirs = [];
function tempState() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-task-')); tmpDirs.push(d); return d; }
const tmpLeftovers = (dir) => fs.readdirSync(dir).filter((f) => f.includes('.tmp-')).length;

// ── 1. 开批 + 断点续做（核心：重启不重做） ─────────────────────────────────
{
  const state = tempState();
  const items = ['item-a', 'item-b', 'item-c', 'item-d', 'item-e'];
  const p = beginTask(state, { batchId: 'B1', items, scope: 'group:100000001' });
  check('开批落盘：文件在 state/file-archive-tasks.json',
    fs.existsSync(taskStatePath(state)) && path.basename(taskStatePath(state)) === TASK_STATE_FILE);
  check('开批时 pending 指向第一项', nextPendingTask(p) === 'item-a');
  check('taskStatus: total=5 done=0 pending=5',
    JSON.stringify(taskStatus(p)).includes('"total":5') && taskStatus(p).done === 0);

  markTaskItem(state, { batchId: 'B1', item: 'item-a', ok: true });
  markTaskItem(state, { batchId: 'B1', item: 'item-b', ok: true });

  // 等价于"进程被杀后重启"：只在磁盘上留进度，进程内对象全部丢弃
  const afterRestart = readTaskProgress(state);
  check('重启后能读回进度', !!afterRestart && afterRestart.batchId === 'B1');
  check('重启后接着做第 3 项（不从头）', nextPendingTask(afterRestart) === 'item-c',
    String(nextPendingTask(afterRestart)));
  check('重启后已完成项仍是 2 项', afterRestart.done.length === 2);
  check('重启后不会重复处理已完成的 item-a',
    afterRestart.items.filter((x) => x === 'item-a').length === 1 && afterRestart.done.includes('item-a'));

  markTaskItem(state, { batchId: 'B1', item: 'item-c', ok: true });
  markTaskItem(state, { batchId: 'B1', item: 'item-d', ok: true });
  markTaskItem(state, { batchId: 'B1', item: 'item-e', ok: true });
  const done = readTaskProgress(state);
  check('全部做完 → state=done', done.state === 'done' && nextPendingTask(done) === null);
  check('全做完后 taskStatus.pending=0', taskStatus(done).pending === 0);
  check('状态目录无 .tmp- 残留', tmpLeftovers(state) === 0);
}

// ── 2. 负例：连续 3 次失败必须停 ───────────────────────────────────────────
{
  const state = tempState();
  beginTask(state, { batchId: 'B2', items: ['x', 'y', 'z'] });
  markTaskItem(state, { batchId: 'B2', item: 'x', ok: false, error: 'ECONNRESET' });
  markTaskItem(state, { batchId: 'B2', item: 'x', ok: false, error: 'ECONNRESET' });
  const two = readTaskProgress(state);
  check(`失败 2 次还没停（阈值 ${MAX_CONSECUTIVE_FAILURES}）`, two.state === 'running' && two.failures === 2);
  const third = markTaskItem(state, { batchId: 'B2', item: 'x', ok: false, error: 'ECONNRESET' });
  check('第 3 次失败 → state=stopped', third.state === 'stopped' && third.stoppedReason.includes('ECONNRESET'));
  const stopped = readTaskProgress(state);
  check('停下的状态落盘了（重启也不会自己接着跑）', stopped.state === 'stopped');
  check('停下后 nextPendingTask 返回 null（不会继续啃下一项）', nextPendingTask(stopped) === null);
  check('失败项记进 failed 便于排查', !!stopped.failed.x && stopped.failed.x.error === 'ECONNRESET');
}

// ── 3. 成功一次就把连续失败清零（不是累计 3 次） ───────────────────────────
{
  const state = tempState();
  beginTask(state, { batchId: 'B3', items: ['a', 'b', 'c', 'd', 'e'] });
  markTaskItem(state, { batchId: 'B3', item: 'a', ok: false, error: 'e1' });
  markTaskItem(state, { batchId: 'B3', item: 'b', ok: false, error: 'e2' });
  markTaskItem(state, { batchId: 'B3', item: 'c', ok: true });
  const afterOk = readTaskProgress(state);
  check('成功一项后 failures 归零', afterOk.failures === 0 && afterOk.state === 'running');
  markTaskItem(state, { batchId: 'B3', item: 'd', ok: false, error: 'e3' });
  markTaskItem(state, { batchId: 'B3', item: 'e', ok: false, error: 'e4' });
  const end = readTaskProgress(state);
  check('清零后再失败 2 次也不会停（说明是"连续"不是"累计"）',
    end.state === 'running' && end.failures === 2, `state=${end.state} failures=${end.failures}`);
}

// ── 4. 负例：上一批的迟到结果不能污染新批 ─────────────────────────────────
{
  const state = tempState();
  beginTask(state, { batchId: 'OLD', items: ['a', 'b'] });
  beginTask(state, { batchId: 'NEW', items: ['p', 'q'] });
  const stale = markTaskItem(state, { batchId: 'OLD', item: 'a', ok: true });
  check('旧 batchId 的结果被拒（stale）', stale.stale === true && stale.reason === 'batch-mismatch');
  const cur = readTaskProgress(state);
  check('新批没被写脏：batchId 仍是 NEW 且 done=0', cur.batchId === 'NEW' && cur.done.length === 0);
  const unknown = markTaskItem(state, { batchId: 'NEW', item: '不存在', ok: true });
  check('不在本批 items 里的项被拒', unknown.stale === true && unknown.reason === 'unknown-item');
}

// ── 5. 负例：坏状态文件 / 空批 ────────────────────────────────────────────
{
  const state = tempState();
  fs.writeFileSync(taskStatePath(state), '{"batchId":"X"');
  check('坏进度文件 → readTaskProgress 返回 null（不抛）', readTaskProgress(state) === null);
  check('坏进度文件 → nextPendingTask(null)=null', nextPendingTask(null) === null);
  let threw = false;
  try { beginTask(state, { batchId: 'E1', items: [] }); } catch { threw = true; }
  check('空 items 开批直接报错（避免"空跑成功"）', threw === true);
  let threw2 = false;
  try { beginTask(state, { items: ['a'] }); } catch { threw2 = true; }
  check('缺 batchId 开批报错', threw2 === true);
  check('重复 item 会去重（同项重复入队会让 done 计数错）', (() => {
    const s2 = tempState();
    const p = beginTask(s2, { batchId: 'D1', items: ['a', 'a', 'b'] });
    return p.items.length === 2;
  })());
  check('clearTaskProgress 删文件', (() => {
    const s3 = tempState();
    beginTask(s3, { batchId: 'C1', items: ['a'] });
    return clearTaskProgress(s3) === true && !fs.existsSync(taskStatePath(s3));
  })());
}

for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
const total = pass + failures.length;
if (failures.length) {
  console.log(`\n❌ test-archive-p2-progress 失败 ${failures.length}/${total}`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log(`\n✅ test-archive-p2-progress 全部通过（${pass}/${total}）`);
