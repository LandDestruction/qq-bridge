// P2③：说明文件 sidecar 写回（带日期区块、只替换自己那块、绝不动用户手写内容）的回归测试。
// 负例是重点：**用户段落必须一个字节都不变**；标记畸形时宁可追加也不做手术；
// 符号链接 / 不存在的目录必须拒绝写（绝不隐式创建或覆盖用户文件）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SIDECAR_FILE_NAME, sidecarPath, buildSidecarBlock, mergeSidecar,
  readSidecar, writeArchiveSidecar,
} from '../src/archive-p2.js';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const tmpDirs = [];
function tempDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-sidecar-')); tmpDirs.push(d); return d; }
const tmpLeftovers = (dir) => fs.readdirSync(dir).filter((f) => f.includes('.tmp-')).length;
const facts = { boothId: '9013048', title: '示例商品', shop: '某店', price: '¥0', tags: ['标签A', '标签B'], url: 'https://example.invalid/items/9013048' };

// ── 1. 负例：目录里已有用户手写内容，写回后必须原样保留 ───────────────────
{
  const dir = tempDir();
  const userText = '# 我的收藏\n\n这是我手写的笔记，绝对不能被改。\n\n- 买了两个\n';
  fs.writeFileSync(path.join(dir, '用户自己.md'), userText);
  check('前置：用户自己的文件先放进去', fs.readFileSync(path.join(dir, '用户自己.md'), 'utf8') === userText);

  const r = writeArchiveSidecar(dir, facts, { dateKey: '2026-10-27' });
  check('写回成功并落到「说明.md」',
    r.ok === true && path.basename(r.path) === SIDECAR_FILE_NAME, JSON.stringify(r));
  const text = fs.readFileSync(path.join(dir, SIDECAR_FILE_NAME), 'utf8');
  check('生成的文件带日期标记头尾',
    text.includes('<!-- archive-facts:start 2026-10-27 -->') && text.includes('<!-- archive-facts:end 2026-10-27 -->'));
  check('资料字段写进去了（商品号/标题/店铺/标签）',
    text.includes('9013048') && text.includes('示例商品') && text.includes('某店') && text.includes('标签A'));
  check('**没有碰用户自己的 .md 文件**', fs.readFileSync(path.join(dir, '用户自己.md'), 'utf8') === userText);
  check('目录里多出来的只有「说明.md」',
    fs.readdirSync(dir).sort().join(',') === ['用户自己.md', SIDECAR_FILE_NAME].sort().join(','));
}

// ── 2. 负例：已有的用户手写段落（在说明.md 里）必须逐字节保留 ──────────────
{
  const dir = tempDir();
  const userPart = '# 我自己的说明\n\n这段是用户手写的，写回不能动它。\n\n- 注意：这个包很大\n';
  fs.writeFileSync(sidecarPath(dir), userPart);
  writeArchiveSidecar(dir, facts, { dateKey: '2026-10-27' });
  const text = fs.readFileSync(sidecarPath(dir), 'utf8');
  check('用户原文作为前缀逐字节保留', text.startsWith(userPart), JSON.stringify(text.slice(0, 40)));
  check('归档区块追加在用户内容之后',
    text.indexOf('<!-- archive-facts:start 2026-10-27 -->') > userPart.length - 1);
}

// ── 3. 幂等：同一天写两次不会长出第二块 ───────────────────────────────────
{
  const dir = tempDir();
  writeArchiveSidecar(dir, facts, { dateKey: '2026-10-27' });
  const first = fs.readFileSync(sidecarPath(dir), 'utf8');
  writeArchiveSidecar(dir, facts, { dateKey: '2026-10-27' });
  const second = fs.readFileSync(sidecarPath(dir), 'utf8');
  const starts = (second.match(/archive-facts:start/g) || []).length;
  check('同一天写两次：只有 1 个 start 标记', starts === 1, `实际 ${starts}`);
  check('同一天写两次：内容完全一致（幂等）', second === first);
}

// ── 4. 同一天更新资料 → 只替换自己那块，用户内容仍然不动 ──────────────────
{
  const dir = tempDir();
  const userPart = '用户写的开头\n\n';
  fs.writeFileSync(sidecarPath(dir), userPart);
  writeArchiveSidecar(dir, facts, { dateKey: '2026-10-27' });
  const r2 = writeArchiveSidecar(dir, { ...facts, title: '改名后的商品' }, { dateKey: '2026-10-27' });
  const text = fs.readFileSync(sidecarPath(dir), 'utf8');
  check('第二轮写回是"替换"而不是追加', r2.replaced === true && r2.appended === false, JSON.stringify(r2));
  check('新标题进了文件', text.includes('改名后的商品'));
  check('旧标题被替换掉（没有两块并存）', !text.includes('示例商品'));
  check('用户前缀没动', text.startsWith(userPart));
  check('标记仍然成对且只有一个', (text.match(/archive-facts:start/g) || []).length === 1);
}

// ── 5. 不同日期 → 各自一块，互不影响 ──────────────────────────────────────
{
  const dir = tempDir();
  writeArchiveSidecar(dir, facts, { dateKey: '2026-10-26' });
  const day1 = fs.readFileSync(sidecarPath(dir), 'utf8');
  writeArchiveSidecar(dir, { ...facts, title: '第二天的标题' }, { dateKey: '2026-10-27' });
  const text = fs.readFileSync(sidecarPath(dir), 'utf8');
  check('两个日期各一块', (text.match(/archive-facts:start/g) || []).length === 2);
  check('第一天的区块逐字节没变', text.includes(day1.trim()));
  check('第二天的标题也在', text.includes('第二天的标题'));
}

// ── 6. 负例：标记畸形（用户误粘了一个 start）→ 只追加，不切坏文件 ─────────
{
  const dir = tempDir();
  const broken = '用户的文字\n<!-- archive-facts:start -->\n这里没有结束标记，后面都是用户内容\n';
  fs.writeFileSync(sidecarPath(dir), broken);
  const r = writeArchiveSidecar(dir, facts, { dateKey: '2026-10-27' });
  const text = fs.readFileSync(sidecarPath(dir), 'utf8');
  check('畸形标记时报告 unbalanced（不假装成功）', r.unbalanced === true);
  check('畸形标记时走追加', r.appended === true && r.replaced === false);
  check('用户原文仍然完整保留', text.startsWith(broken));
  check('新块追加在末尾且自身成对',
    text.endsWith('<!-- archive-facts:end 2026-10-27 -->\n') || text.trimEnd().endsWith('<!-- archive-facts:end 2026-10-27 -->'));
}

// ── 7. 负例：dryRun 不落盘；目录不存在/是符号链接必须拒绝 ─────────────────
{
  const dir = tempDir();
  const r = writeArchiveSidecar(dir, facts, { dateKey: '2026-10-27', dryRun: true });
  check('dryRun 返回预览文本但**没有写文件**',
    r.ok === true && typeof r.text === 'string' && !fs.existsSync(sidecarPath(dir)));

  const missing = path.join(tempDir(), '不存在的目录');
  const r2 = writeArchiveSidecar(missing, facts);
  check('目录不存在 → 拒绝写（绝不隐式创建素材目录）',
    r2.ok === false && r2.reason === 'dir-missing');

  const realDir = tempDir();
  const target = path.join(realDir, '真文件.md');
  fs.writeFileSync(target, '真实文件内容\n');
  const linkDir = tempDir();
  const sidecarAtLink = path.join(linkDir, SIDECAR_FILE_NAME);
  // 本机（没开开发者模式）建文件符号链接会被拒；目录 junction 不需要特权且 Node 的 lstat 同样报 isSymbolicLink，
  // 所以两级兜底，保证「说明.md 是链接」这条路径**真的被执行到**而不是被跳过。
  let linkKind = '';
  try { fs.symlinkSync(target, sidecarAtLink); linkKind = 'symlink'; } catch {
    const targetDir = path.join(realDir, 'junction-target-dir');
    fs.mkdirSync(targetDir, { recursive: true });
    try { fs.symlinkSync(targetDir, sidecarAtLink, 'junction'); linkKind = 'junction'; } catch { linkKind = ''; }
  }
  if (linkKind) {
    const before = fs.readFileSync(target, 'utf8');
    const targetDirFiles = linkKind === 'junction'
      ? fs.readdirSync(path.join(realDir, 'junction-target-dir')).length : -1;
    const r3raw = (() => {
      try { return writeArchiveSidecar(linkDir, facts, { dateKey: '2026-10-27' }); }
      catch (e) { return { ok: false, reason: 'threw:' + (e?.code || e?.message || e) }; }
    })();
    const r3 = r3raw;
    check(`说明.md 是${linkKind === 'junction' ? '目录 junction' : '符号链接'} → 拒绝写（不覆盖链接目标）`,
      r3.ok === false && r3.reason === 'symlink', JSON.stringify(r3));
    check('链接目标文件内容未被改', fs.readFileSync(target, 'utf8') === before);
    if (linkKind === 'junction') {
      check('junction 目标目录里没有被塞进任何文件',
        fs.readdirSync(path.join(realDir, 'junction-target-dir')).length === targetDirFiles);
    }
  } else {
    console.log('  ⚠️ 跳过链接用例（本机既不能建符号链接也不能建 junction）');
  }
  check('目录里没有 .tmp- 残留', tmpLeftovers(realDir) === 0);
}

// ── 8. 纯函数：mergeSidecar 不写盘、只做文本替换 ──────────────────────────
{
  const block = buildSidecarBlock(facts, { dateKey: '2026-10-27' }).block;
  const user = '用户内容\n';
  const m = mergeSidecar(user, block, { dateKey: '2026-10-27' });
  check('mergeSidecar 保留用户内容并追加', m.text.startsWith(user) && m.text.includes('9013048'));
  const empty = mergeSidecar('', block, { dateKey: '2026-10-27' });
  check('空文件合并 = 只有自己的块', empty.text.trim() === block.trim());
  check('buildSidecarBlock 空字段不写', (() => {
    const b = buildSidecarBlock({ title: '只有标题' }, { dateKey: '2026-10-27' }).block;
    return b.includes('标题：只有标题') && !b.includes('商品号');
  })());
  check('readSidecar 对不存在的文件返回 missing', readSidecar(tempDir()).missing === true);
}

for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
const total = pass + failures.length;
if (failures.length) {
  console.log(`\n❌ test-archive-p2-sidecar 失败 ${failures.length}/${total}`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log(`\n✅ test-archive-p2-sidecar 全部通过（${pass}/${total}）`);
