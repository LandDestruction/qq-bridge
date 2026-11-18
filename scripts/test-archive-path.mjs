// M6-P0 ⑤：路径校验的边界测试（空段 / `.` / `..` / 绝对路径 / 盘符 / 越界根 / NUL）。
//
// 为什么需要：台账里的 rel_path 会被拿去删文件、搬文件、写 meta.json。一旦校验漏一个形状，
// 最坏情况是删到转存根之外（历史上有人的 rel_path 被手工改坏过）。这里把每种"坏形状"都钉死，
// 同时保证合法路径（含名字里带 `..` 的文件）不会被误杀。
//
// 纯函数测试，不碰磁盘、不碰真实 state/。
// 用法：node scripts/test-archive-path.mjs

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  validateArchiveRelPath,
  parentDirRel,
  safeResolveInside
} from '../src/file-archive.js';

let failed = 0;
let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`✅ ${name}`); }
  catch (error) { failed += 1; console.error(`❌ ${name} —— ${error?.message ?? error}`); }
}

const ROOT = path.join(os.tmpdir(), 'archive-path-root');

// ── 合法路径 ────────────────────────────────────────────────────────────────
check('合法：普通相对路径原样通过', () => {
  assert.equal(validateArchiveRelPath('100000001_扣1复活牢大/9013048/9013048.zip'), '100000001_扣1复活牢大/9013048/9013048.zip');
});

check('合法：反斜杠统一成 /（台账一律用正斜杠）', () => {
  assert.equal(validateArchiveRelPath('g\\2026-01\\a.zip'), 'g/2026-01/a.zip');
});

check('合法：文件名里带 .. 前缀不算越界（只拒整段是 ..）', () => {
  assert.equal(validateArchiveRelPath('g/..hidden/a.zip'), 'g/..hidden/a.zip');
  assert.equal(validateArchiveRelPath('g/a..b.zip'), 'g/a..b.zip');
});

check('合法：带空格/中文/括号的文件名通过', () => {
  assert.equal(validateArchiveRelPath('g/9013048/9013048_商品 (1).zip'), 'g/9013048/9013048_商品 (1).zip');
});

// ── 坏形状：空 ──────────────────────────────────────────────────────────────
check('拒绝：空字符串与纯空白', () => {
  assert.throws(() => validateArchiveRelPath(''), /转存目录之外/);
  assert.throws(() => validateArchiveRelPath('   '), /转存目录之外/);
  assert.throws(() => validateArchiveRelPath(null), /转存目录之外/);
});

// ── 坏形状：`.` / `..` / 空段 ───────────────────────────────────────────────
check('拒绝：整段是 .', () => {
  assert.throws(() => validateArchiveRelPath('.'), /转存目录之外/);
  assert.throws(() => validateArchiveRelPath('./a.zip'), /转存目录之外/);
  assert.throws(() => validateArchiveRelPath('g/./a.zip'), /转存目录之外/);
});

check('拒绝：整段是 ..（上跳）', () => {
  assert.throws(() => validateArchiveRelPath('..'), /转存目录之外/);
  assert.throws(() => validateArchiveRelPath('../outside.txt'), /转存目录之外/);
  assert.throws(() => validateArchiveRelPath('a/../../x.txt'), /转存目录之外/);
});

check('拒绝：空段（a//b、结尾分隔符）', () => {
  assert.throws(() => validateArchiveRelPath('a//b.zip'), /转存目录之外/);
  assert.throws(() => validateArchiveRelPath('a/b/'), /转存目录之外/);
});

// ── 坏形状：绝对路径 / 盘符 / UNC / NUL ────────────────────────────────────
check('拒绝：正斜杠开头的绝对路径', () => {
  assert.throws(() => validateArchiveRelPath('/etc/passwd'), /转存目录之外/);
  assert.throws(() => validateArchiveRelPath('/'), /转存目录之外/);
});

check('拒绝：Windows 盘符路径', () => {
  assert.throws(() => validateArchiveRelPath('C:\\Windows\\System32'), /转存目录之外/);
  assert.throws(() => validateArchiveRelPath('e:/booth-inbox/x.zip'), /转存目录之外/);
});

check('拒绝：UNC 路径', () => {
  assert.throws(() => validateArchiveRelPath('\\\\server\\share\\x.zip'), /转存目录之外/);
});

check('拒绝：含 NUL 的路径', () => {
  assert.throws(() => validateArchiveRelPath('a/\u0000b.zip'), /转存目录之外/);
});

// ── parentDirRel ────────────────────────────────────────────────────────────
check('parentDirRel：取父目录（正斜杠）', () => {
  assert.equal(parentDirRel('g/9013048/a.zip'), 'g/9013048');
  assert.equal(parentDirRel('a.zip'), '', '根目录返回空串（不是 "."）');
});

// ── safeResolveInside：包含性 + 越界根 ──────────────────────────────────────
check('safeResolveInside：合法路径落在根内', () => {
  assert.equal(safeResolveInside(ROOT, 'g/2026-01/a.zip'), path.join(ROOT, 'g', '2026-01', 'a.zip'));
});

check('safeResolveInside：拒绝跳出根（含回到根再上跳）', () => {
  assert.throws(() => safeResolveInside(ROOT, '../outside.txt'), /转存目录之外/);
  assert.throws(() => safeResolveInside(ROOT, 'a/../../x.txt'), /转存目录之外/);
});

check('safeResolveInside：拒绝兄弟目录（前缀相同但不是子目录）', () => {
  // 关键边界：root2 与 root 前缀相同，必须按分隔符判断而不是 startsWith 字符串
  assert.throws(() => safeResolveInside(ROOT, '../archive-path-root2/x.zip'), /转存目录之外/);
});

check('safeResolveInside：拒绝空路径与 "."（不许把根目录本身当文件）', () => {
  assert.throws(() => safeResolveInside(ROOT, ''), /转存目录之外/);
  assert.throws(() => safeResolveInside(ROOT, '.'), /转存目录之外/);
});

check('safeResolveInside：非法输入不会返回任何路径（先抛再算）', () => {
  let out = 'unset';
  try { out = safeResolveInside(ROOT, 'C:\\Windows'); } catch { out = 'threw'; }
  assert.equal(out, 'threw');
});

// ── 收尾 ────────────────────────────────────────────────────────────────────
const total = passed + failed;
if (failed) { console.error(`\n❌ test-archive-path 失败 ${failed}/${total}`); process.exit(1); }
console.log(`\n✅ test-archive-path 全部通过（${passed}/${total}）`);
