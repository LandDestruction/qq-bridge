// 存储统计（只读）的单测：用临时目录造假数据，不碰线上 state/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectStorageStats, countLines, sizeOf, sizeOfDetailed, diskFree } from '../src/storage-stats.js';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); }
  catch (error) { failed += 1; console.error(`❌ ${name} — ${error?.message ?? error}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-storage-'));
fs.writeFileSync(path.join(dir, 'big.json'), 'x'.repeat(2048));
fs.writeFileSync(path.join(dir, 'small.jsonl'), 'a\nb\nc\n');
fs.mkdirSync(path.join(dir, 'archive'));
fs.writeFileSync(path.join(dir, 'archive', 'old.json'), 'y'.repeat(512));
fs.mkdirSync(path.join(dir, 'node_modules'));

check('顶层项按大小降序，目录也算总量', () => {
  const s = collectStorageStats({ stateDir: dir });
  assert.equal(s.ok, true);
  const names = s.top.map((i) => i.name);
  assert.equal(names[0], 'big.json', `最大项应是 big.json（实得 ${names[0]}）`);
  const arch = s.top.find((i) => i.name === 'archive');
  assert.equal(arch.kind, 'dir');
  assert.equal(arch.bytes, 512, '目录大小应递归统计（一层）');
});

check('countLines 正确且不整文件读入内存', () => {
  assert.equal(countLines(path.join(dir, 'small.jsonl')), 3);
  assert.equal(countLines(path.join(dir, 'nope.txt')), null, '不存在的文件返回 null 而不是抛');
});

check('软链不递归（防无限循环）', () => {
  try { fs.symlinkSync(dir, path.join(dir, 'loop'), 'dir'); } catch { return; } // Windows 无权限就跳过
  const s = collectStorageStats({ stateDir: dir });
  const loop = s.top.find((i) => i.name === 'loop');
  assert.ok(!loop || (loop.bytes ?? 0) === 0, '软链不得被统计进去');
});

check('超过深度上限的子目录：不递归但计入直接子文件，并标记 truncated', () => {
  // state/ (0) → deep/ (1) → deeper/ (2, 超限)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-depth-'));
  // 要触发截断必须**再往下两层**：文件在任何深度都会被计入，只有「更深的目录」才被截断。
  fs.mkdirSync(path.join(root, 'deep', 'deeper', 'deepest'), { recursive: true });
  fs.writeFileSync(path.join(root, 'deep', 'deeper', 'a.bin'), 'z'.repeat(300));
  fs.writeFileSync(path.join(root, 'deep', 'deeper', 'deepest', 'c.bin'), 'z'.repeat(100));
  const detail = sizeOfDetailed(path.join(root, 'deep'));
  assert.equal(detail.truncated, true, '到深度上限必须标记 truncated');
  assert.equal(detail.bytes, 400, '超限层的直接子文件仍要计入（不能按 0 丢）');
  const s = collectStorageStats({ stateDir: root });
  const deep = s.top.find((i) => i.name === 'deep');
  assert.equal(deep.depthLimited, true, '目录项要带 depthLimited 标记');
  assert.equal(s.truncated, true, '整体要置 truncated，说明 topTotal 是下限');
  fs.rmSync(root, { recursive: true, force: true });
});

check('磁盘剩余：拿不到时给 null，不抛', () => {
  const r = diskFree(dir);
  assert.ok(r === null || (typeof r.free === 'number' && r.free > 0));
  assert.equal(diskFree(path.join(dir, '__nope__')), null);
});

check('db 为 null 时统计仍返回完整结构（各字段 null）', () => {
  const s = collectStorageStats({ stateDir: dir, db: null });
  assert.equal(s.messages.db.rows, null);
  assert.ok(Array.isArray(s.logs) && s.logs.length === 2);
  assert.ok(Array.isArray(s.disks) && s.disks.length >= 1);
});

check('日志项：文件不存在时 bytes/lines 都是 null', () => {
  const s = collectStorageStats({ stateDir: dir });
  const bridge = s.logs.find((l) => l.name === 'bridge.log');
  assert.equal(bridge.bytes, null);
  assert.equal(bridge.lines, null);
});

fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.error(`\n❌ 存储统计测试失败（${failed} 项）`); process.exit(1); }
console.log('\n🎉 存储统计测试通过');
