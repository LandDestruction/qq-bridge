// 聊天消息里的文件转存测试（离线：内存 SQLite + 临时目录 + 假下载）。
//
// 背景（为什么要有这组测试）：线上「用户往群里发文件，机器人说没有存文件的功能」，
// 根因是聊天文件走消息 `file` 段，而当时只有 group_upload 事件会转存。
// 这里把 `src/file-archive.js` 的 archiveChatFileSegments / storeArchivedFile 钉住：
// 白名单群才动手、非白名单一次都不碰、超限拒绝、失败如实标注、同一 file_id 不重复存。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ensureFileLedger,
  storeArchivedFile,
  storeDownloadedFile,
  allocateArchiveTarget,
  sha256OfFile,
  archiveChatFileSegments,
  archiveImageAttachment,
  formatArchiveFactsBlock,
  findActiveArchiveBySha,
  chatFileSegments,
  archiveCapabilityHint,
  findActiveArchive,
  normalizeFileArchiveConfig,
  shouldArchiveAttachment,
  describeArchiveSkip
} from '../src/file-archive.js';
import { streamBodyToFile } from '../src/safe-fetch.js';

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${error?.message ?? error}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${error?.message ?? error}`);
  }
}

/** 固定时间，便于断言 `<群号>/<YYYY-MM>/` 这段路径。 */
const T0 = Date.UTC(2026, 0, 15, 4, 0, 0);
const MONTH = '2026-01';
const GID = '100000001';

function freshEnv({ maxFileMb = 200, booth = false } = {}) {
  const db = new DatabaseSync(':memory:');
  ensureFileLedger(db);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-file-archive-'));
  // 这些用例测的是「下载/落盘/台账」本身，用老布局（<群号>/<YYYY-MM>）断言更直观；
  // BOOTH 新布局由最后一条用例和 test-booth-archive.mjs 覆盖。
  const cfg = normalizeFileArchiveConfig({ enabled: true, groups: [GID], dir: 'state/files', maxFileMb, booth: { enabled: booth } });
  const calls = { download: [], getFileUrl: [] };
  const deps = {
    db,
    rootDir,
    nowMs: T0,
    messageId: '10086',
    uploader: '20001',
    uploadedAt: T0 - 1000,
    log: () => {},
    download: async (url, maxBytes) => {
      calls.download.push({ url, maxBytes });
      return { url, statusCode: 200, buffer: Buffer.from('zip-bytes'), truncated: false };
    },
    getFileUrl: async (fileId, busid) => {
      calls.getFileUrl.push({ fileId, busid });
      return { url: `https://public.invalid/${fileId}?busid=${busid}` };
    }
  };
  return { db, rootDir, cfg, deps, calls };
}

function fileSeg({ name = 'a.zip', fileId = 'f-1', size = 9, url = 'https://public.invalid/a.zip', busid = 102 } = {}) {
  return { type: 'file', data: { name, file_id: fileId, file_size: size, url, busid } };
}

function rows(db) {
  return db.prepare('SELECT * FROM file_archive ORDER BY id').all();
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

await checkAsync('白名单群：file 段被转存，模型看到「已转存到本地，内容未读取」', async () => {
  const { db, rootDir, cfg, deps, calls } = freshEnv();
  try {
    const res = await archiveChatFileSegments({ segments: [fileSeg()], groupId: GID, cfg, deps });
    const text = res.annotations.get(0);
    assert.match(text, /^\[文件a\.zip（已转存到本地，id=1，内容未读取）\]$/);
    // 用的是消息段自带的 url，没有多打一次 get_group_file_url
    assert.equal(calls.download.length, 1);
    assert.equal(calls.download[0].url, 'https://public.invalid/a.zip');
    assert.equal(calls.download[0].maxBytes, 200 * 1024 * 1024);
    assert.equal(calls.getFileUrl.length, 0);
    // 落盘路径：<群号>/<YYYY-MM>/<原名>
    const abs = path.join(rootDir, GID, MONTH, 'a.zip');
    assert.equal(fs.existsSync(abs), true, `应当落盘 ${abs}`);
    assert.equal(fs.readFileSync(abs, 'utf8'), 'zip-bytes');
    // 台账：source=chat、分类规则、sha256 与大小
    const all = rows(db);
    assert.equal(all.length, 1);
    assert.equal(all[0].source, 'chat');
    assert.equal(all[0].file_id, 'f-1');
    assert.equal(all[0].bytes, 9);
    assert.equal(all[0].uploader, '20001');
    assert.equal(all[0].message_id, '10086');
    assert.equal(all[0].category_source, 'rule');
    assert.equal(all[0].category, '压缩包');
    assert.match(all[0].sha256, /^[0-9a-f]{64}$/);
  } finally { cleanup(rootDir); }
});

await checkAsync('非白名单群：返回 null，一次下载/台账都不碰', async () => {
  const { db, rootDir, cfg, deps, calls } = freshEnv();
  try {
    const res = await archiveChatFileSegments({ segments: [fileSeg()], groupId: '111111111', cfg, deps });
    assert.equal(res, null);
    assert.equal(calls.download.length, 0);
    assert.equal(calls.getFileUrl.length, 0);
    assert.equal(rows(db).length, 0);
    assert.deepEqual(fs.readdirSync(rootDir), []);
    // 关掉 enabled 也一样
    const off = { ...cfg, enabled: false };
    assert.equal(await archiveChatFileSegments({ segments: [fileSeg()], groupId: GID, cfg: off, deps }), null);
    assert.equal(calls.download.length, 0);
  } finally { cleanup(rootDir); }
});

await checkAsync('超限：声明大小超过 maxFileMb → 不下载、不落盘，说明写清原因', async () => {
  const { db, rootDir, cfg, deps, calls } = freshEnv({ maxFileMb: 1 });
  try {
    const res = await archiveChatFileSegments({
      segments: [fileSeg({ name: 'big.zip', size: 2 * 1024 * 1024 })],
      groupId: GID, cfg, deps
    });
    assert.match(res.annotations.get(0), /未转存：2\.0 MB，超过 1\.0 MB 上限/);
    assert.equal(calls.download.length, 0);
    assert.equal(rows(db).length, 0);
    assert.deepEqual(fs.readdirSync(rootDir), []);
  } finally { cleanup(rootDir); }
});

await checkAsync('幂等：同一个 file_id 第二次不重复下载、不重复落盘', async () => {
  const { db, rootDir, cfg, deps, calls } = freshEnv();
  try {
    const first = await archiveChatFileSegments({ segments: [fileSeg()], groupId: GID, cfg, deps });
    assert.match(first.annotations.get(0), /已转存到本地/);
    const second = await archiveChatFileSegments({ segments: [fileSeg()], groupId: GID, cfg, deps });
    assert.match(second.annotations.get(0), /已在本地，id=1，没有重复转存/);
    assert.equal(calls.download.length, 1);
    assert.equal(rows(db).length, 1);
  } finally { cleanup(rootDir); }
});

await checkAsync('消息里没有 url：回退 get_group_file_url(file_id, busid)，参数原样传下去', async () => {
  const { db, rootDir, cfg, deps, calls } = freshEnv();
  try {
    const res = await archiveChatFileSegments({
      segments: [fileSeg({ url: '', busid: 102 })],
      groupId: GID, cfg, deps
    });
    assert.match(res.annotations.get(0), /已转存到本地/);
    assert.deepEqual(calls.getFileUrl, [{ fileId: 'f-1', busid: 102 }]);
    assert.equal(calls.download[0].url, 'https://public.invalid/f-1?busid=102');
  } finally { cleanup(rootDir); }
});

await checkAsync('下载失败：如实标注失败原因，不落盘、不抛给调用方', async () => {
  const { db, rootDir, cfg, deps, calls } = freshEnv();
  deps.download = async () => { throw new Error('文件下载失败：HTTP 403'); };
  try {
    const res = await archiveChatFileSegments({ segments: [fileSeg()], groupId: GID, cfg, deps });
    assert.match(res.annotations.get(0), /转存失败：文件下载失败：HTTP 403/);
    assert.equal(rows(db).length, 0);
    assert.deepEqual(fs.readdirSync(rootDir), []);
  } finally { cleanup(rootDir); }
});

await checkAsync('截断（实际字节超限）：拒绝保存并说清', async () => {
  const { db, rootDir, cfg, deps } = freshEnv();
  deps.download = async (url) => ({ url, statusCode: 200, buffer: Buffer.from('x'), truncated: true });
  try {
    const res = await archiveChatFileSegments({ segments: [fileSeg()], groupId: GID, cfg, deps });
    assert.match(res.annotations.get(0), /未转存：超过 200 MB 上限被截断/);
    assert.equal(rows(db).length, 0);
  } finally { cleanup(rootDir); }
});

await checkAsync('同名不同 file_id：第二条存成 `a (1).zip`，两条都在台账里', async () => {
  const { db, rootDir, cfg, deps } = freshEnv();
  try {
    const res = await archiveChatFileSegments({
      segments: [fileSeg({ fileId: 'f-1' }), fileSeg({ fileId: 'f-2' })],
      groupId: GID, cfg, deps
    });
    assert.match(res.annotations.get(0), /a\.zip（已转存到本地，id=1/);
    assert.match(res.annotations.get(1), /a\.zip（已转存到本地，id=2/);
    assert.equal(fs.existsSync(path.join(rootDir, GID, MONTH, 'a.zip')), true);
    assert.equal(fs.existsSync(path.join(rootDir, GID, MONTH, 'a (1).zip')), true);
    assert.equal(rows(db).length, 2);
  } finally { cleanup(rootDir); }
});

await checkAsync('清理过的文件允许重新转存（deleted_at 不算「已在本地」）', async () => {
  const { db, rootDir, cfg, deps, calls } = freshEnv();
  try {
    await archiveChatFileSegments({ segments: [fileSeg()], groupId: GID, cfg, deps });
    db.prepare('UPDATE file_archive SET deleted_at = ?, delete_reason = ?').run(T0 + 1, '过期清理');
    assert.equal(findActiveArchive(db, { groupId: GID, fileId: 'f-1' }), null);
    const res = await archiveChatFileSegments({ segments: [fileSeg()], groupId: GID, cfg, deps });
    assert.match(res.annotations.get(0), /已转存到本地/);
    assert.equal(calls.download.length, 2);
    assert.equal(rows(db).length, 2);
  } finally { cleanup(rootDir); }
});

check('chatFileSegments：兼容 file_id/id、file_size/size、name/file 三套写法', () => {
  const list = chatFileSegments([
    { type: 'text', data: { text: 'hi' } },
    { type: 'file', data: { name: 'x.zip', file_id: 'id-1', file_size: 12, url: 'u', file_hash: 'h' } },
    { type: 'file', data: { file: 'y.png', id: 'id-2', size: 7 } },
    { type: 'file', data: { file_id: 'id-3' } }
  ]);
  assert.equal(list.length, 3);
  assert.deepEqual(
    list.map((x) => ({ index: x.index, name: x.name, fileId: x.fileId, size: x.size, url: x.url })),
    [
      { index: 1, name: 'x.zip', fileId: 'id-1', size: 12, url: 'u' },
      { index: 2, name: 'y.png', fileId: 'id-2', size: 7, url: '' },
      { index: 3, name: '文件-id-3', fileId: 'id-3', size: 0, url: '' }
    ]
  );
});

check('storeArchivedFile：直接落盘记账，source 写入台账', () => {
  const { db, rootDir } = freshEnv();
  try {
    const stored = storeArchivedFile({
      db, rootDir, groupId: GID, fileId: 'n-1', fileName: 'doc.pdf',
      buffer: Buffer.from('pdf'), archivedAt: T0, retention: null, source: 'notice'
    });
    assert.equal(stored.storedName, 'doc.pdf');
    assert.equal(stored.category, '文档');
    assert.equal(stored.categorySource, 'rule');
    const row = db.prepare('SELECT * FROM file_archive WHERE id = ?').get(stored.id);
    assert.equal(row.source, 'notice');
    assert.equal(row.cleanup_at, stored.cleanupAt);
  } finally { cleanup(rootDir); }
});

check('ensureFileLedger：旧库没有 source 列时自动 ALTER 补列，不动已有数据', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE file_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, file_id TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL, stored_name TEXT NOT NULL, rel_path TEXT NOT NULL UNIQUE,
    bytes INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT '',
    message_id TEXT NOT NULL DEFAULT '', uploader TEXT NOT NULL DEFAULT '',
    uploaded_at INTEGER NOT NULL DEFAULT 0, archived_at INTEGER NOT NULL,
    category TEXT NOT NULL DEFAULT '', category_source TEXT NOT NULL DEFAULT '',
    cleanup_at INTEGER NOT NULL, deleted_at INTEGER, delete_reason TEXT NOT NULL DEFAULT ''
  )`);
  db.prepare(`INSERT INTO file_archive (group_id, file_name, stored_name, rel_path, archived_at, cleanup_at)
    VALUES ('1','old.zip','old.zip','1/2026-01/old.zip', 1, 2)`).run();
  ensureFileLedger(db);
  const cols = db.prepare('PRAGMA table_info(file_archive)').all().map((c) => c.name);
  assert.equal(cols.includes('source'), true);
  const row = db.prepare('SELECT * FROM file_archive').get();
  assert.equal(row.stored_name, 'old.zip');
  assert.equal(row.source, '');
  // 幂等：再调一次不报错
  ensureFileLedger(db);
});

check('archiveCapabilityHint：白名单群给明确说明，其它群一个字都不加', () => {
  const cfg = normalizeFileArchiveConfig({ enabled: true, groups: [GID] });
  const hint = archiveCapabilityHint(cfg, GID);
  assert.match(hint, /文件自动转存/);
  assert.match(hint, /不要再说「我没有存文件的功能」/);
  assert.match(hint, /没有读取文件内容/);
  assert.equal(archiveCapabilityHint(cfg, '111111111'), '');
  assert.equal(archiveCapabilityHint({ ...cfg, enabled: false }, GID), '');
});

// ── 大文件：流式下载（2.5G 上限下不能把正文读进内存） ─────────────────────
const MB = 1024 * 1024;

await checkAsync('流式：downloadToFile 直接写目标临时文件，成功后改名、记 sha256', async () => {
  const { db, rootDir, cfg, deps } = freshEnv();
  const downloads = [];
  deps.downloadToFile = async (url, tmpPath, maxBytes) => {
    downloads.push({ url, tmpPath, maxBytes });
    fs.writeFileSync(tmpPath, 'streamed-bytes', { flag: 'wx' });
    return { url, statusCode: 200, bytes: 14, sha256: 'a'.repeat(64), truncated: false };
  };
  try {
    const res = await archiveChatFileSegments({ segments: [fileSeg()], groupId: GID, cfg, deps });
    assert.match(res.annotations.get(0), /已转存到本地，id=1，内容未读取/);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].url, 'https://public.invalid/a.zip');
    assert.equal(downloads[0].maxBytes, 200 * MB, '上限按 maxFileMb 传下去');
    const monthDir = path.join(rootDir, GID, MONTH);
    assert.equal(fs.readFileSync(path.join(monthDir, 'a.zip'), 'utf8'), 'streamed-bytes');
    // 临时文件已改名，不残留 .tmp
    assert.deepEqual(fs.readdirSync(monthDir), ['a.zip']);
    const row = rows(db)[0];
    assert.equal(row.bytes, 14);
    assert.equal(row.sha256, 'a'.repeat(64));
    assert.equal(row.source, 'chat');
  } finally { cleanup(rootDir); }
});

await checkAsync('流式：超限截断 → 删掉半截临时文件、不记账、如实说清', async () => {
  const { db, rootDir, cfg, deps } = freshEnv({ maxFileMb: 1 });
  deps.downloadToFile = async (url, tmpPath) => {
    fs.writeFileSync(tmpPath, 'half-file');
    return { url, statusCode: 200, bytes: 9, sha256: '', truncated: true };
  };
  try {
    const res = await archiveChatFileSegments({ segments: [fileSeg({ size: 0 })], groupId: GID, cfg, deps });
    assert.match(res.annotations.get(0), /未转存：超过 1\.0 MB 上限被截断/);
    assert.equal(rows(db).length, 0);
    const monthDir = path.join(rootDir, GID, MONTH);
    assert.equal(fs.existsSync(monthDir), true, '目录会先建好');
    assert.deepEqual(fs.readdirSync(monthDir), [], '半截文件必须删掉');
  } finally { cleanup(rootDir); }
});

await checkAsync('流式：下载器没给字节数 → 判失败并清理临时文件（不落空文件）', async () => {
  const { db, rootDir, cfg, deps } = freshEnv();
  deps.downloadToFile = async (url, tmpPath) => {
    fs.writeFileSync(tmpPath, '');
    return { url, statusCode: 200, truncated: false };
  };
  try {
    const res = await archiveChatFileSegments({ segments: [fileSeg({ size: 0 })], groupId: GID, cfg, deps });
    assert.match(res.annotations.get(0), /转存失败：下载结果为空/);
    assert.equal(rows(db).length, 0);
    assert.deepEqual(fs.readdirSync(path.join(rootDir, GID, MONTH)), []);
  } finally { cleanup(rootDir); }
});

await checkAsync('storeDownloadedFile：没给 sha256 时流式计算摘要（不读整文件进内存）', async () => {
  const { db, rootDir } = freshEnv();
  try {
    const target = allocateArchiveTarget({ db, rootDir, groupId: GID, archivedAt: T0, fileName: 'big.bin' });
    fs.writeFileSync(target.tmpPath, 'abc');
    const stored = await storeDownloadedFile({
      db, groupId: GID, fileId: 'b-1', fileName: 'big.bin', target,
      bytes: 3, archivedAt: T0, source: 'notice'
    });
    const expected = await sha256OfFile(path.join(rootDir, GID, MONTH, 'big.bin'));
    assert.equal(stored.sha256, expected);
    assert.equal(stored.sha256.length, 64);
    assert.equal(fs.existsSync(target.tmpPath), false, '临时文件已改名');
    assert.equal(db.prepare('SELECT source, bytes FROM file_archive').get().source, 'notice');
  } finally { cleanup(rootDir); }
});

// ── 每轮「转存结果」事实 + 图片转存 ──────────────────────────────────────
await checkAsync('facts：成功/重复/超限/失败都有对应事实，供 prompt 拼事实块', async () => {
  const { db, rootDir, cfg, deps } = freshEnv();
  try {
    const okRes = await archiveChatFileSegments({ segments: [fileSeg()], groupId: GID, cfg, deps });
    assert.deepEqual(okRes.facts, [{ status: 'ok', name: 'a.zip', bytes: 9, id: 1 }]);
    const dupRes = await archiveChatFileSegments({ segments: [fileSeg()], groupId: GID, cfg, deps });
    assert.deepEqual(dupRes.facts, [{ status: 'dup', name: 'a.zip', id: 1 }]);
    const overCfg = { ...cfg, maxFileMb: 1 };
    const overRes = await archiveChatFileSegments({
      segments: [fileSeg({ name: 'big.zip', fileId: 'f-big', size: 2 * 1024 * 1024 })], groupId: GID, cfg: overCfg, deps
    });
    assert.equal(overRes.facts[0].status, 'skipped');
    assert.match(overRes.facts[0].reason, /超过 1\.0 MB 上限/);
    deps.download = async () => { throw new Error('文件下载失败：HTTP 403'); };
    const failRes = await archiveChatFileSegments({ segments: [fileSeg({ fileId: 'f-9' })], groupId: GID, cfg, deps });
    assert.equal(failRes.facts[0].status, 'failed');
    assert.match(failRes.facts[0].reason, /HTTP 403/);
  } finally { cleanup(rootDir); }
});

await checkAsync('图片：复用媒体 buffer 落盘，category=image、source=image、按 sha256 去重', async () => {
  const { db, rootDir } = freshEnv();
  try {
    const png = Buffer.from('fake-png-bytes');
    const first = archiveImageAttachment({
      db, rootDir, groupId: GID, buffer: png, fileName: '图片-1.png',
      fileId: 'abc123', archivedAt: T0, messageId: '777', uploader: '20001'
    });
    assert.equal(first.status, 'ok');
    assert.equal(first.bytes, png.length);
    const row = db.prepare('SELECT * FROM file_archive WHERE id = ?').get(first.id);
    assert.equal(row.category, 'image');
    assert.equal(row.category_source, 'media');
    assert.equal(row.source, 'image');
    const abs = path.join(rootDir, row.rel_path);
    assert.equal(fs.readFileSync(abs).toString(), 'fake-png-bytes');
    // 同一张图再发一次：sha256 命中 → dup，不重复落盘
    const second = archiveImageAttachment({
      db, rootDir, groupId: GID, buffer: Buffer.from('fake-png-bytes'), fileName: '图片-2.png', archivedAt: T0 + 1000
    });
    assert.equal(second.status, 'dup');
    assert.equal(second.id, first.id);
    assert.equal(rows(db).length, 1);
    assert.ok(findActiveArchiveBySha(db, { groupId: GID, sha256: row.sha256 }));
    // 超限：返回 skipped，不写盘
    const over = archiveImageAttachment({
      db, rootDir, groupId: GID, buffer: Buffer.alloc(2 * 1024 * 1024, 1), fileName: 'big.png', maxBytes: 1024 * 1024
    });
    assert.equal(over.status, 'skipped');
    assert.match(over.reason, /超过 1\.0 MB 上限/);
    assert.equal(rows(db).length, 1);
  } finally { cleanup(rootDir); }
});

check('事实块：无附件/已转存/未转存三种形态的文案与「不许编」硬句', () => {
  const none = formatArchiveFactsBlock({ isWhitelisted: true, facts: [] });
  assert.match(none, /本轮没有可转存的附件/);
  assert.match(none, /只有上面写了「已转存」才可以说存好了；否则必须如实说没存/);

  const ok = formatArchiveFactsBlock({
    isWhitelisted: true,
    facts: [{ status: 'ok', name: 'a.png', bytes: 12 * 1024, id: 7 }]
  });
  assert.match(ok, /本轮已转存 1 个附件/);
  assert.match(ok, /a\.png（12\.0 KB，台账 id=7）/);

  const bad = formatArchiveFactsBlock({
    isWhitelisted: true,
    facts: [
      { status: 'skipped', name: 'big.zip', reason: '213.0 MB 超过 200 MB 上限' },
      { status: 'dup', name: 'old.zip', id: 3 }
    ]
  });
  assert.match(bad, /本轮附件未转存：big\.zip（213\.0 MB 超过 200 MB 上限）/);
  assert.match(bad, /已在本地（未重复转存）.*old\.zip.*id=3/);

  const nonWhite = formatArchiveFactsBlock({ isWhitelisted: false, facts: [] });
  assert.match(nonWhite, /或该群不在白名单/);
  assert.equal(/文件自动转存】本群已开启/.test(nonWhite), false, '非白名单群不要冒充已开启');
});

// ── 转存类型白名单（只图片 + 压缩包；表情包绝不转） ──────────────────────
check('类型矩阵：image/zip/rar/7z/jpg-as-file ✅；face/mface/mp4/pdf ❌', () => {
  const yes = [
    { label: 'image 段', input: { segType: 'image' } },
    { label: 'zip', input: { segType: 'file', fileName: 'a.zip' } },
    { label: 'RAR 大写', input: { segType: 'file', fileName: 'A.RAR' } },
    { label: '7z', input: { segType: 'file', fileName: 'x.7z' } },
    { label: 'tar.gz', input: { segType: 'file', fileName: 'x.tar.gz' } },
    { label: 'jpg 以文件发', input: { segType: 'file', fileName: 'p.JPG' } },
    { label: 'media.kind=image', input: { kind: 'image' } }
  ];
  for (const item of yes) {
    assert.equal(shouldArchiveAttachment(item.input), true, `${item.label} 应转存`);
  }
  const no = [
    { label: 'face 段', input: { segType: 'face' } },
    { label: 'mface 段', input: { segType: 'mface' } },
    { label: 'media.kind=face', input: { kind: 'face' } },
    { label: 'media.kind=sticker', input: { kind: 'sticker' } },
    { label: '带表情标记的 image', input: { kind: 'image', emojiId: 'abc' } },
    { label: 'subType=1 的 image', input: { kind: 'image', subType: '1' } },
    { label: 'mp4', input: { segType: 'file', fileName: 'v.mp4' } },
    { label: 'pdf', input: { segType: 'file', fileName: 'd.pdf' } },
    { label: 'docx', input: { segType: 'file', fileName: 'd.docx' } },
    { label: 'txt', input: { segType: 'file', fileName: 'a.txt' } },
    { label: '无扩展名', input: { segType: 'file', fileName: 'noext' } }
  ];
  for (const item of no) {
    assert.equal(shouldArchiveAttachment(item.input), false, `${item.label} 不应转存`);
  }
  assert.equal(describeArchiveSkip({ fileName: 'v.mp4' }), '类型不在转存白名单（.mp4）');
  assert.match(describeArchiveSkip({ fileName: 'noext' }), /无扩展名/);
});

await checkAsync('类型过滤：mp4/pdf 不下载、留事实与跳过日志；表情段 0 次下载', async () => {
  const { db, rootDir, cfg, deps, calls } = freshEnv();
  const skips = [];
  deps.logSkip = (name, reason) => skips.push({ name, reason });
  try {
    const segments = [
      { type: 'file', data: { name: 'v.mp4', file_id: 'mp4-1', file_size: 1024 } },
      { type: 'file', data: { name: 'd.pdf', file_id: 'pdf-1', file_size: 1024 } },
      { type: 'file', data: { name: 'ok.zip', file_id: 'zip-1', file_size: 9 } }
    ];
    const res = await archiveChatFileSegments({ segments, groupId: GID, cfg, deps });
    // 只有 zip 被下载（没有 url，回退 get_group_file_url(file_id)）
    assert.equal(calls.download.length, 1);
    assert.equal(calls.download[0].url, 'https://public.invalid/zip-1?busid=102');
    assert.equal(rows(db).length, 1);
    assert.equal(rows(db)[0].file_name, 'ok.zip');
    // 两条跳过的事实都写进 facts，模型不会以为存了
    const skippedFacts = res.facts.filter((f) => f.status === 'skipped');
    assert.equal(skippedFacts.length, 2);
    assert.match(skippedFacts[0].reason, /\.mp4/);
    assert.match(skippedFacts[1].reason, /\.pdf/);
    // 跳过必须有日志（折叠由桥接做，这里断言 hook 被逐条调用）
    assert.deepEqual(skips.map((s) => s.name), ['v.mp4', 'd.pdf']);
    assert.match(res.annotations.get(0), /未转存：类型不在转存白名单（\.mp4）/);

    // 表情段（face/mface/image 带表情标记）不产生任何转存动作
    calls.download.length = 0;
    const emojiRes = await archiveChatFileSegments({
      segments: [
        { type: 'face', data: { id: '13' } },
        { type: 'mface', data: { file: 'x', summary: '哈哈' } }
      ],
      groupId: GID, cfg, deps
    });
    assert.equal(calls.download.length, 0);
    assert.equal(emojiRes.facts.length, 0);
    assert.equal(emojiRes.archived.length, 0);
  } finally { cleanup(rootDir); }
});

// ── 流式写盘的超限中止与分块语义 ─────────────────────────────────────────
function fakeBody(chunks) {
  const state = { pulled: 0, returned: false };
  const body = {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= chunks.length) return { done: true, value: undefined };
          const value = chunks[i];
          i += 1;
          state.pulled += 1;
          return { done: false, value };
        },
        async return() { state.returned = true; return { done: true, value: undefined }; }
      };
    }
  };
  return { body, state };
}

await checkAsync('流式：越过上限立即中止，只消费到越界那块，.tmp 被删', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-body-'));
  const dest = path.join(dir, 'x.tmp');
  try {
    const chunk = Buffer.alloc(1024, 0x41);
    const { body, state } = fakeBody([chunk, chunk, chunk, chunk]);
    let error = null;
    try {
      await streamBodyToFile(body, dest, { maxBytes: 1500 });
    } catch (e) { error = e; }
    assert.ok(error, '超限必须抛错');
    assert.equal(error.code, 'ARCHIVE_TOO_LARGE');
    assert.equal(error.bytes, 1024, '报告的是越界前已写入的字节数');
    assert.equal(state.returned, true, '必须主动断开响应体');
    assert.equal(state.pulled, 2, '分块消费：拉到第二块就越界中止，不会读完全部');
    assert.equal(fs.existsSync(dest), false, '半截 .tmp 必须删除');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await checkAsync('流式：未超限时边写边算 sha256，返回真实字节数', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-body-'));
  const dest = path.join(dir, 'y.bin');
  try {
    const { body, state } = fakeBody([Buffer.from('abc'), Buffer.from('def')]);
    const result = await streamBodyToFile(body, dest, { maxBytes: 1024 });
    assert.equal(result.bytes, 6);
    assert.equal(fs.readFileSync(dest).toString(), 'abcdef');
    assert.equal(result.sha256.length, 64);
    assert.equal(state.pulled, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await checkAsync('BOOTH 开启时：聊天文件先落 `<群号>/未分类/`（等待桥接归类）', async () => {
  const { db, rootDir, cfg, deps } = freshEnv({ booth: true });
  try {
    const res = await archiveChatFileSegments({ segments: [fileSeg({ name: '9038753 商品.zip', fileId: 'b-1' })], groupId: GID, cfg, deps });
    const row = rows(db)[0];
    assert.equal(row.rel_path.split(path.sep).join('/'), `${GID}/未分类/9038753 商品.zip`);
    assert.equal(fs.existsSync(path.join(rootDir, row.rel_path)), true);
    assert.match(res.annotations.get(0), /已转存到本地/);
  } finally { cleanup(rootDir); }
});

if (failed) {
  console.error(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n🎉 test-chat-file-archive 全部通过');
