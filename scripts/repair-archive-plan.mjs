#!/usr/bin/env node
// 归档修复**计划器**（对应 T4 审计的 D1/D2/D3/D4）。
//
// 默认就是 --dry-run：只打印「会做什么、影响哪些文件、风险、怎么回滚」，不碰任何文件。
// 本轮（T11）**禁止**真正执行 --apply；代码里 apply 只允许改台账（SQL UPDATE），
// 归档文件一个都不删/不移/不改名——孤儿文件只登记「保留」，等用户拍板。
//
// 用法：
//   node scripts/repair-archive-plan.mjs --root E:/booth-inbox --db <messages.db 副本>
//   node scripts/repair-archive-plan.mjs ... --json         # 机器可读
//   node scripts/repair-archive-plan.mjs ... --apply        # 只改台账，先自动备份 DB
//
// 验收口径（与 docs/archive-audit.md 对齐）：dry-run 打印的文件数/体积必须等于
// 22 个文件 / 239.43 MB（原件 20 + 旁挂 2）。
import fs from 'node:fs';
import path from 'node:path';
import { simpleBoothId } from '../src/file-archive.js';

const argv = process.argv.slice(2);
const argOf = (name, dflt = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(name);
const ROOT = path.resolve(argOf('--root', 'E:/booth-inbox'));
const DB_PATH = argOf('--db', '');
const AS_JSON = has('--json');
const APPLY = has('--apply');
const MB = 1024 * 1024;
const ARTIFACT_RE = /(^meta\.json$|\.meta\.json$|(^|\.)thumbnail\.(jpe?g|png|gif|webp)$)/i;
const SIDECAR_RE = /\.(meta|thumbnail|thumb)\.(json|jpe?g|png|gif|webp)$/i;

const toPosix = (p) => String(p).replace(/\\/g, '/');

function walk(dirAbs, relBase = '', out = []) {
  for (const ent of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const abs = path.join(dirAbs, ent.name);
    const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(abs, rel, out);
    else if (ent.isFile()) out.push({ rel, name: ent.name, bytes: fs.statSync(abs).size });
  }
  return out;
}

if (!fs.existsSync(ROOT)) {
  console.error(`归档根不存在：${ROOT}`);
  process.exit(2);
}
const files = walk(ROOT).sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
const totalBytes = files.reduce((s, f) => s + f.bytes, 0);
const originals = files.filter((f) => !ARTIFACT_RE.test(f.name));
const artifacts = files.filter((f) => ARTIFACT_RE.test(f.name));

// ── 读台账（只读；--apply 时才换成可写连接）────────────────────────────────
if (!DB_PATH) {
  console.error('必须提供 --db（建议传 messages.db 的副本，别指向运行中的库）');
  process.exit(2);
}
const { DatabaseSync } = await import('node:sqlite');
const dbAbs = path.resolve(DB_PATH);
const db = new DatabaseSync(dbAbs, { readOnly: true });
const rows = db.prepare(
  'SELECT id,group_id,file_name,stored_name,rel_path,bytes,category,booth_id,deleted_at,meta_rel,thumb_rel FROM file_archive ORDER BY id'
).all().map((r) => ({ ...r }));
const active = rows.filter((r) => r.deleted_at === null || r.deleted_at === undefined || Number(r.deleted_at) === 0);
const rowRel = new Set(active.map((r) => toPosix(r.rel_path).toLowerCase()));
const onDisk = new Map(files.map((f) => [f.rel.toLowerCase(), f]));

// ── 计划项 ─────────────────────────────────────────────────────────────────
const items = [];

// D1：磁盘有、台账无（孤儿）——本轮只登记，不删不移（需要用户拍板）
const orphans = originals.filter((f) => !rowRel.has(f.rel.toLowerCase()));
for (const f of orphans) {
  const ext = path.extname(f.name).toLowerCase();
  const boothId = simpleBoothId(f.name);
  items.push({
    id: `D1-${toPosix(f.rel).replace(/[^\w\u4e00-\u9fa5.() -]/g, '_')}`,
    kind: 'keep-orphan',
    title: `孤儿文件：磁盘有、台账无`,
    target: toPosix(f.rel),
    bytes: f.bytes,
    dbAction: null,
    fsAction: '无（保留原处）',
    risk: [
      '不知道来源，删了就找不回；simpleMode 不清理，会一直悬空',
      ext === '.png' || ext === '.jpg' ? '可能是同一次并发转存的重名残留，与邻居 sha256 比对后才能判定是否重复' : '非图片/压缩包扩展名，需要人工确认来源',
      boothId ? `文件名可解析出号 ${boothId}，但台账没有行，外部统计看不到它` : '文件名没有 7 位号，无法按号归属'
    ],
    rollback: '本项不改任何东西；将来若补台账，回滚 = 删掉新增的那一行（DELETE FROM file_archive WHERE id = <新 id>）',
    needsUser: true
  });
}

// D3：meta_rel / thumb_rel 指向不存在的文件 —— 纯 UPDATE，找到同目录的旁挂真文件
function findSidecar(row, kind) {
  const dirRel = path.dirname(toPosix(row.rel_path));
  const prefix = new RegExp(`^(\\d{7})?\\.?(${kind})\\.`, 'i');
  const exact = path.join(dirRel, kind === 'meta' ? 'meta.json' : 'thumbnail.jpg');
  if (onDisk.has(toPosix(exact).toLowerCase())) return toPosix(exact);
  for (const f of files) {
    if (path.dirname(f.rel) !== dirRel) continue;
    if (!SIDECAR_RE.test(f.name)) continue;
    const isThumb = /thumbnail|thumb/i.test(f.name);
    if (kind === 'meta' && !isThumb && /meta\.json$/i.test(f.name)) return f.rel;
    if (kind === 'thumb' && isThumb) return f.rel;
    if (kind === 'meta' && prefix.test(f.name) && /\.json$/i.test(f.name)) return f.rel;
  }
  return '';
}
for (const r of active) {
  for (const [col, kind] of [['meta_rel', 'meta'], ['thumb_rel', 'thumb']]) {
    const rel = String(r[col] || '');
    if (!rel) continue;
    if (onDisk.has(toPosix(rel).toLowerCase())) continue;
    const fixed = findSidecar(r, kind);
    items.push({
      id: `D3-${r.id}-${col}`,
      kind: 'db-update',
      title: `台账 ${col} 悬空`,
      target: `#${r.id} ${toPosix(r.rel_path)}`,
      dbAction: fixed
        ? { sql: `UPDATE file_archive SET ${col} = ? WHERE id = ?`, params: [fixed, Number(r.id)], from: rel, to: fixed }
        : null,
      fsAction: '无',
      risk: fixed
        ? [`旧值 ${rel} 已不存在；改成磁盘上真实存在的 ${fixed}，外部按台账取图不再 404`]
        : [`旧值 ${rel} 已不存在，磁盘同目录也找不到替代旁挂——只能先把该列清空或等人工补文件`],
      rollback: fixed
        ? `UPDATE file_archive SET ${col} = '${rel.replace(/'/g, "''")}' WHERE id = ${Number(r.id)};`
        : '本项无自动修复，不改就是零风险',
      needsUser: !fixed
    });
  }
}

// D2：booth_id 为空但文件名可解析出 7 位号 —— 纯 UPDATE
const boothEmpty = active.filter((r) => !String(r.booth_id || '').trim() && simpleBoothId(r.file_name));
if (boothEmpty.length) {
  items.push({
    id: 'D2-booth-id-backfill',
    kind: 'db-update-batch',
    title: `booth_id 回填（${boothEmpty.length} 条）`,
    target: boothEmpty.map((r) => `#${r.id}`).join(', '),
    dbAction: {
      sql: 'UPDATE file_archive SET booth_id = ?, booth_url = ? WHERE id = ? AND booth_id = \'\'',
      paramsFor: (r) => { const bid = simpleBoothId(r.file_name); return [bid, `https://booth.pm/zh-cn/items/${bid}`, Number(r.id)]; },
      rows: boothEmpty.map((r) => ({ id: Number(r.id), boothId: simpleBoothId(r.file_name), file: r.file_name }))
    },
    fsAction: '无（只改台账两列）',
    risk: [
      '与 src/file-archive.js:1023 backfillBoothColumns() 同口径，幂等（WHERE booth_id = \'\'）',
      '改完 idx_file_archive_booth 才会命中这些行，面板的同号图片归属/筛选才能用'
    ],
    rollback: `UPDATE file_archive SET booth_id = '', booth_url = '' WHERE id IN (${boothEmpty.map((r) => Number(r.id)).join(', ')});`,
    needsUser: false
  });
}

// D4：迁移脚本落点过期 —— 只报告，不改代码
const migratePath = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'migrate-archive-simple-layout.mjs');
let migrateStale = { detected: false, target: '' };
if (fs.existsSync(migratePath)) {
  const src = fs.readFileSync(migratePath, 'utf8');
  const m = /path\.join\(groupFolder\(gid, names\), ym, stored\)/.exec(src);
  migrateStale = { detected: Boolean(m), target: m ? 'groupFolder/ym/stored（年月目录）' : '' };
}
if (migrateStale.detected) {
  items.push({
    id: 'D4-migrate-script-stale',
    kind: 'code-report',
    title: '存量迁移脚本落点已落后于运行时布局',
    target: 'scripts/migrate-archive-simple-layout.mjs',
    dbAction: null,
    fsAction: '无（本项不建议现在改）',
    risk: [
      '运行时已改成 <群号_群名>/<7位号>/（b44d97a），该脚本仍写 <群号_群名>/<YYYY-MM>/',
      '谁再跑一次 --apply，合规文件会被搬回年月目录，之后必须再跑 migrate-simple-booth-folders.mjs 折回来'
    ],
    rollback: '本项不改代码；若将来改脚本，回滚 = git checkout -- scripts/migrate-archive-simple-layout.mjs',
    needsUser: true
  });
}

// D7：台账 active 但磁盘上已经没有这个文件 —— 说明文件被外部删除/移走（脚本只报告，不猜原因）
const missingOnDisk = active.filter((r) => !onDisk.has(toPosix(r.rel_path).toLowerCase()));
if (missingOnDisk.length) {
  items.push({
    id: 'D7-ledger-missing-files',
    kind: 'db-mark-or-restore',
    title: `台账还有 ${missingOnDisk.length} 行指向已不存在的文件`,
    target: missingOnDisk.map((r) => `#${r.id}`).join(', '),
    dbAction: null,
    fsAction: '无（先别改：要么从备份/回收站恢复文件，要么把台账标记 deleted）',
    risk: [
      '文件不是本脚本删的：审计器（22:55）之后、计划器首次运行（23:03）之前，这些文件已从磁盘消失',
      '台账仍当它们是 active，面板会显示一堆点不开的条目，统计体积也会偏高',
      `涉及体积 ${(missingOnDisk.reduce((s, r) => s + Number(r.bytes || 0), 0) / MB).toFixed(2)} MB，其中 ${missingOnDisk.length} 行有 sha256 可用来校验恢复出来的文件`,
      '恢复和标记删除是两条完全不同的路，必须先确认文件是不是进了回收站/备份，再决定'
    ],
    rollback: '本项不改任何东西。若将来标记 deleted，回滚 = UPDATE file_archive SET deleted_at = NULL, delete_reason = \'\' WHERE id IN (...)；若要恢复文件，回滚 = 把文件放回 rel_path 并核 sha256',
    needsUser: true,
    rows: missingOnDisk.map((r) => ({ id: Number(r.id), rel: toPosix(r.rel_path), bytes: Number(r.bytes || 0) }))
  });
}

// 基线核对：dry-run 数字必须和审计一致
const baseline = { files: files.length, bytes: totalBytes, originals: originals.length, artifacts: artifacts.length };
const EXPECT = { files: 22, originals: 20, artifacts: 2 };
const matchBaseline = baseline.files === EXPECT.files && baseline.originals === EXPECT.originals && baseline.artifacts === EXPECT.artifacts;

// ── 输出 ───────────────────────────────────────────────────────────────────
const dbUpdates = items.filter((i) => i.dbAction && (i.kind.startsWith('db-update')));
const plan = {
  root: ROOT, db: dbAbs, mode: APPLY ? 'apply' : 'dry-run',
  baseline, baselineMatchesAudit: matchBaseline, expectedBaseline: EXPECT,
  ledgerRows: rows.length, activeRows: active.length,
  items,
  summary: {
    items: items.length,
    dbUpdates: dbUpdates.length,
    fsTouched: 0,
    needUser: items.filter((i) => i.needsUser).length,
    orphanFiles: orphans.length,
    orphanBytes: orphans.reduce((s, f) => s + f.bytes, 0),
    missingOnDisk: missingOnDisk.length,
    missingOnDiskBytes: missingOnDisk.reduce((s, r) => s + Number(r.bytes || 0), 0)
  }
};

if (AS_JSON) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  const mb = (n) => (n / MB).toFixed(2);
  console.log(`模式：${plan.mode}${APPLY ? '' : '（默认，不改任何东西）'}`);
  console.log(`归档根：${ROOT}`);
  console.log(`台账：${dbAbs}（${rows.length} 行，有效 ${active.length}）`);
  console.log(`基线：${baseline.files} 个文件 / ${mb(baseline.bytes)} MB（原件 ${baseline.originals} + 旁挂 ${baseline.artifacts}）`
    + (matchBaseline ? '  ✅ 与 T4 审计基线一致' : `  ⚠️ 与审计基线不一致（期望 ${EXPECT.files}/${EXPECT.originals}/${EXPECT.artifacts}）`));
  console.log(`计划项：${plan.summary.items} 个（台账更新 ${plan.summary.dbUpdates}、文件系统改动 ${plan.summary.fsTouched}、需用户拍板 ${plan.summary.needUser}）`);
  if (plan.summary.missingOnDisk) {
    console.log(`⚠️ 台账有 ${plan.summary.missingOnDisk} 行、共 ${mb(plan.summary.missingOnDiskBytes)} MB 的文件已不在磁盘上（见 D7）；`
      + `所以磁盘基线比 T4 审计时少，不是本脚本造成的。`);
  }
  console.log('');
  for (const it of items) {
    console.log(`▸ [${it.kind}] ${it.title} — ${it.id}`);
    console.log(`   目标：${it.target}${it.bytes ? `（${mb(it.bytes)} MB）` : ''}`);
    if (it.dbAction) {
      if (it.dbAction.sql && it.dbAction.params) console.log(`   台账：${it.dbAction.sql}  ← ${it.dbAction.params.join(', ')}`);
      else if (it.dbAction.sql) console.log(`   台账：${it.dbAction.sql}（${it.dbAction.rows.length} 行：${it.dbAction.rows.map((r) => `#${r.id}→${r.boothId}`).join(' ')}）`);
    } else console.log('   台账：不改');
    console.log(`   文件：${it.fsAction}`);
    for (const r of it.risk) console.log(`   风险：${r}`);
    console.log(`   回滚：${it.rollback}`);
    console.log('');
  }
  console.log(APPLY ? '（--apply：仅执行上面的台账更新，归档文件一个都不动）' : '（dry-run：以上动作一条都没有执行；本轮禁止 --apply）');
}

// ── 执行（--apply）─────────────────────────────────────────────────────────
if (APPLY) {
  if (!matchBaseline) {
    console.error('基线不一致，拒绝执行 --apply（先确认归档根是不是被改动过）');
    process.exit(3);
  }
  if (missingOnDisk.length) {
    console.error(`台账有 ${missingOnDisk.length} 行文件已不在磁盘，先处理 D7（恢复或标记删除）再谈其它修复`);
    process.exit(4);
  }
  console.log('\n[apply] 先备份台账…');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${dbAbs}.bak-repair-${stamp}`;
  fs.copyFileSync(dbAbs, backup);
  console.log(`[apply] 备份：${backup}`);
  const w = new DatabaseSync(dbAbs);
  let done = 0;
  try {
    for (const it of dbUpdates) {
      if (it.dbAction.paramsFor) {
        const stmt = w.prepare(it.dbAction.sql);
        for (const r of boothEmpty) { const res = stmt.run(...it.dbAction.paramsFor(r)); done += Number(res.changes) || 0; }
      } else if (it.dbAction.params) {
        const res = w.prepare(it.dbAction.sql).run(...it.dbAction.params);
        done += Number(res.changes) || 0;
      }
    }
    console.log(`[apply] 台账更新 ${done} 处；归档文件未改动。`);
    console.log(`[apply] 回滚：复制回 ${path.basename(backup)}（停桥接后覆盖）`);
  } finally {
    w.close();
  }
}
