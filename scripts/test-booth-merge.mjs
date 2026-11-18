// 同 BOOTH 号多文件合并 / meta.json 合并 / 人工分类不被覆盖（离线）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ensureFileLedger,
  storeArchivedFile,
  archiveDirRel,
  enrichArchiveItem,
  setArchiveCategory,
  moveArchiveItemToCategory,
  listArchive
} from '../src/file-archive.js';

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { fail += 1; console.error(`  FAIL ${name}: ${error?.message ?? error}`); }
}

const T0 = Date.UTC(2026, 0, 15, 4, 0, 0);
const GID = '100000001';

function fresh() {
  const db = new DatabaseSync(':memory:');
  ensureFileLedger(db);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-merge-'));
  return { db, rootDir };
}

const metaOk = (over = {}) => ({
  status: 'ok', title: '奥の手 -OkunoTe-', shop: 'ZigZag', price: '¥ 290~',
  tags: ['衣装'], thumbnailUrl: 'https://booth.pximg.net/t.jpg',
  itemUrl: 'https://booth.pm/zh-cn/items/9038753', category: '3D衣装', error: '',
  ...over
});
const depsFor = (meta) => ({
  fetchBoothMeta: async () => meta,
  downloadThumb: async (url, destAbs) => { fs.writeFileSync(destAbs, Buffer.from('thumb')); return { ok: true, status: 'ok', bytes: 5 }; }
});

await check('同号多文件 → 同一目录；meta.json 的 files 数组合并（不互相覆盖）', async () => {
  const { db, rootDir } = fresh();
  try {
    const a = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 'a', fileName: '9038753 商品A.zip',
      buffer: Buffer.from('aaa'), archivedAt: T0, source: 'chat', baseDirRel: archiveDirRel({ groupId: GID })
    });
    const b = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 'b', fileName: '9038753 商品B.zip',
      buffer: Buffer.from('bbb'), archivedAt: T0 + 1, source: 'chat', baseDirRel: archiveDirRel({ groupId: GID })
    });
    const ra = await enrichArchiveItem({ db, rootDir, id: a.id, cfg: { booth: { enabled: true }, retention: null }, deps: depsFor(metaOk()), nowMs: T0 });
    const rb = await enrichArchiveItem({ db, rootDir, id: b.id, cfg: { booth: { enabled: true }, retention: null }, deps: depsFor(metaOk()), nowMs: T0 + 1 });
    assert.equal(path.dirname(ra.relPath), path.dirname(rb.relPath), '同 BOOTH 号必须并目录');
    const dirAbs = path.join(rootDir, path.dirname(ra.relPath));
    assert.equal(fs.existsSync(path.join(dirAbs, path.basename(ra.relPath))), true);
    assert.equal(fs.existsSync(path.join(dirAbs, path.basename(rb.relPath))), true);
    const meta = JSON.parse(fs.readFileSync(path.join(dirAbs, 'meta.json'), 'utf8'));
    assert.equal(meta.files.length, 2, 'meta.json 必须合并两个文件');
    assert.deepEqual(meta.files.map((f) => f.fileName).sort(), [path.basename(ra.relPath), path.basename(rb.relPath)].sort());
    assert.equal(meta.files.every((f) => f.sha256 && f.bytes > 0), true);
    assert.equal(meta.title, '奥の手 -OkunoTe-');
    assert.equal(meta.thumbPath, path.join(path.dirname(ra.relPath), 'thumbnail.jpg').split(path.sep).join(path.sep));
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

await check('目录名优先用页面标题：`<boothId> <标题>`，标题空才用商品名', async () => {
  const { db, rootDir } = fresh();
  try {
    const a = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 't1', fileName: '9038753 文件名里的商品名.zip',
      buffer: Buffer.from('x'), archivedAt: T0, source: 'chat', baseDirRel: archiveDirRel({ groupId: GID })
    });
    const r = await enrichArchiveItem({ db, rootDir, id: a.id, cfg: { booth: { enabled: true }, retention: null }, deps: depsFor(metaOk({ title: '页面标题 B' })), nowMs: T0 });
    assert.equal(path.basename(path.dirname(r.relPath)), '9038753 页面标题 B');

    const b = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 't2', fileName: '6641548 无标题商品.zip',
      buffer: Buffer.from('y'), archivedAt: T0 + 1, source: 'chat', baseDirRel: archiveDirRel({ groupId: GID })
    });
    const r2 = await enrichArchiveItem({ db, rootDir, id: b.id, cfg: { booth: { enabled: true }, retention: null }, deps: depsFor(metaOk({ title: '', category: '3D衣装' })), nowMs: T0 + 1 });
    assert.equal(path.basename(path.dirname(r2.relPath)), '6641548 无标题商品');
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

await check('人工分类（manual）永不被后台重抓覆盖：分类/目录不变，仅更新 BOOTH 字段', async () => {
  const { db, rootDir } = fresh();
  try {
    const a = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 'm1', fileName: '9038753 商品.zip',
      buffer: Buffer.from('m'), archivedAt: T0, source: 'chat', baseDirRel: archiveDirRel({ groupId: GID })
    });
    // 先按人工分类放到「手工分类」
    setArchiveCategory(db, { id: a.id, category: '手工分类', source: 'manual', retention: null });
    const before = listArchive(db, { limit: 10 }).find((r) => r.id === a.id);

    // 后台重抓：页面分类是 3D衣装，且标题变了 —— 仍不能动分类/目录
    const r = await enrichArchiveItem({
      db, rootDir, id: a.id, cfg: { booth: { enabled: true }, retention: null },
      deps: depsFor(metaOk({ category: '3D衣装', title: '新标题' })), nowMs: T0 + 10
    });
    const after = listArchive(db, { limit: 10 }).find((r) => r.id === a.id);
    assert.equal(after.category, '手工分类');
    assert.equal(after.categorySource, 'manual');
    assert.equal(after.relPath, before.relPath, 'manual 条目不能被移动');
    assert.equal(r.boothTitle, undefined); // 返回值里没有这个字段，用 DB 断言
    assert.equal(after.boothTitle, '新标题', 'BOOTH 元数据仍应更新');
    assert.equal(after.boothShop, 'ZigZag');
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

await check('未分类工作流：人工指定分类 → 文件真的移动到分类目录（无 BOOTH 号）', async () => {
  const { db, rootDir } = fresh();
  try {
    const stored = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 'u1', fileName: '普通商品.zip',
      buffer: Buffer.from('u'), archivedAt: T0, source: 'chat', baseDirRel: archiveDirRel({ groupId: GID })
    });
    assert.equal(path.dirname(stored.relPath).split(path.sep)[1], '未分类');
    const moved = moveArchiveItemToCategory({ db, rootDir, id: stored.id, category: '素材' });
    assert.equal(moved.moved, true);
    assert.equal(moved.relPath.split(path.sep).join('/'), `${GID}/素材/${path.basename(stored.relPath)}`);
    assert.equal(fs.existsSync(path.join(rootDir, moved.relPath)), true);
    assert.equal(fs.existsSync(path.join(rootDir, stored.relPath)), false, '旧位置文件应已移走');
    const row = listArchive(db, { limit: 10 }).find((r) => r.id === stored.id);
    assert.equal(row.category, '素材');
    assert.equal(row.categorySource, 'manual');
    // 手动分类后重抓（无 BOOTH 号）不会把它挪走
    const r = await enrichArchiveItem({ db, rootDir, id: stored.id, cfg: { booth: { enabled: true }, retention: null }, deps: { fetchBoothMeta: async () => ({ status: 'ok' }) }, nowMs: T0 + 1 });
    assert.equal(r.skipped, true);
    assert.equal(listArchive(db, { limit: 10 }).find((x) => x.id === stored.id).relPath, moved.relPath);
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

await check('未分类工作流：BOOTH 商品人工分类 → `<分类>/<boothId> <商品名>/`，meta.json 分类同步', async () => {
  const { db, rootDir } = fresh();
  try {
    const stored = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 'u2', fileName: '9038753 商品.zip',
      buffer: Buffer.from('u2'), archivedAt: T0, source: 'chat', baseDirRel: archiveDirRel({ groupId: GID })
    });
    // 先正常归类出 meta.json
    await enrichArchiveItem({ db, rootDir, id: stored.id, cfg: { booth: { enabled: true }, retention: null }, deps: depsFor(metaOk()), nowMs: T0 });
    const before = listArchive(db, { limit: 10 }).find((r) => r.id === stored.id);
    assert.ok(before.metaRel, '应先有 meta.json');
    const moved = moveArchiveItemToCategory({ db, rootDir, id: stored.id, category: '手工分类' });
    assert.equal(moved.relPath.split(path.sep).join('/').includes('/手工分类/9038753 '), true);
    const afterRow = listArchive(db, { limit: 10 }).find((r) => r.id === stored.id);
    assert.ok(afterRow.metaRel, 'meta.json 应跟着移动');
    assert.equal(afterRow.metaRel.startsWith(path.join(GID, '手工分类')), true, `meta 应在新的分类目录（实际 ${afterRow.metaRel}）`);
    const meta = JSON.parse(fs.readFileSync(path.join(rootDir, afterRow.metaRel), 'utf8'));
    assert.equal(meta.category, '手工分类');
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

await check('只归档压缩包：同号图片只记录 boothId，不建商品目录/不抓封面', async () => {
  const { db, rootDir } = fresh();
  try {
    const stored = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 'img1', fileName: '9038753 preview.png',
      buffer: Buffer.from('png'), archivedAt: T0, source: 'chat', baseDirRel: archiveDirRel({ groupId: GID })
    });
    let metaCalls = 0;
    let coverCalls = 0;
    const r = await enrichArchiveItem({
      db, rootDir, id: stored.id, cfg: { booth: { enabled: true }, retention: null },
      deps: {
        fetchBoothMeta: async () => { metaCalls += 1; return metaOk(); },
        ensureCover: async () => { coverCalls += 1; return { ok: true, path: '/tmp/cover.jpg' }; }
      },
      nowMs: T0
    });
    assert.equal(r.skipped, true, '图片不创建商品条目');
    assert.equal(metaCalls, 0, '图片不抓商品元数据');
    assert.equal(coverCalls, 0, '图片不抓封面');
    const row = listArchive(db, { limit: 10 }).find((x) => x.id === stored.id);
    assert.equal(row.relPath, stored.relPath, '图片不能移动');
    assert.equal(row.boothId, '9038753', '图片仍要记录 BOOTH 号，供同号归属');
    assert.equal(row.enrichStatus, 'skipped');
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

await check('压缩包 enrich 会调用 ensureCover（同号封面只由压缩包触发）', async () => {
  const { db, rootDir } = fresh();
  try {
    const stored = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 'cov1', fileName: '9038753 商品.zip',
      buffer: Buffer.from('zip'), archivedAt: T0, source: 'chat', baseDirRel: archiveDirRel({ groupId: GID })
    });
    const seen = [];
    const r = await enrichArchiveItem({
      db, rootDir, id: stored.id, cfg: { booth: { enabled: true }, retention: null },
      deps: {
        ...depsFor(metaOk()),
        ensureCover: async (boothId) => { seen.push(boothId); return { ok: true, path: '/tmp/cover.jpg', error: '' }; }
      },
      nowMs: T0
    });
    assert.equal(r.status, 'ok');
    assert.deepEqual(seen, ['9038753']);
    const meta = JSON.parse(fs.readFileSync(path.join(rootDir, r.metaRel), 'utf8'));
    assert.equal(meta.coverPath, '/tmp/cover.jpg');
    assert.equal(meta.coverError, '');
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
