// file-archive/media.js — 压缩包目录表（sidecar 只读）+ 缩略图信号量 + BOOTH 元数据增强
// 纯搬运自 src/file-archive.js（D61 拆分）：函数体/注释逐字保留，只做模块化与 import/export。

import fs from 'node:fs';
import path from 'node:path';
import { parseBoothName } from '../booth-meta.js';
import { normalizeBoothCategory } from '../booth-classify.js';

import { UNCLASSIFIED_DIR, cleanupDeadline, isClassified, joinError, shortReason } from './common.js';
import { archiveDirRel, fileOpsMu, metaJsonFor, safeResolveInside, simpleBoothId, writeFileAtomicSync } from './paths.js';
import { allocateArchiveTarget, mapArchiveRow, updateArchiveEnrichment } from './db.js';
import { isArchiveFileName, moveFileWithinRoot } from './storage.js';

// ── 压缩包目录表（只读；不解压、不试密码） ─────────────────────────────────
// 规格 §3-P1-7：ZIP 中央目录优先，RAR/7z 后置；"加密"与"损坏"必须能区分。
// 读目录表而不是解压：用户给的包可能 2GB、可能带密码，解压一遍既慢又危险。
export const ARCHIVE_FORMATS = Object.freeze({
  zip: 'zip', rar: 'rar', '7z': '7z', gzip: 'gzip', tar: 'tar', bzip2: 'bzip2', xz: 'xz', zstd: 'zstd', unknown: 'unknown'
});

/** 按魔数认格式（只看文件头，不读内容）。 */
export function detectArchiveFormat(head) {
  const b = head instanceof Uint8Array ? head : Buffer.from(head ?? []);
  const at = (offset, bytes) => bytes.every((v, i) => b[offset + i] === v);
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return ARCHIVE_FORMATS.zip;
  if (b.length >= 7 && at(0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return ARCHIVE_FORMATS.rar;
  if (b.length >= 6 && at(0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return ARCHIVE_FORMATS['7z'];
  if (b.length >= 2 && at(0, [0x1f, 0x8b])) return ARCHIVE_FORMATS.gzip;
  if (b.length >= 3 && at(0, [0x42, 0x5a, 0x68])) return ARCHIVE_FORMATS.bzip2;
  if (b.length >= 6 && at(0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return ARCHIVE_FORMATS.xz;
  if (b.length >= 4 && at(0, [0x28, 0xb5, 0x2f, 0xfd])) return ARCHIVE_FORMATS.zstd;
  if (b.length >= 262 && String.fromCharCode(...b.subarray(257, 262)) === 'ustar') return ARCHIVE_FORMATS.tar;
  return ARCHIVE_FORMATS.unknown;
}

const ZIP_EOCD_SIG = 0x06054b50;

const ZIP_CD_SIG = 0x02014b50;

const ZIP64_LOCATOR_SIG = 0x07064b50;

/**
 * 解析 ZIP 中央目录（Buffer 版，便于测试）。
 * @returns {{ok:boolean, format:string, count:number, entries:Array<{name:string,size:number,compressedSize:number,method:number,encrypted:boolean,isDir:boolean}>, encrypted:boolean, error?:string, truncated?:boolean}}
 */
export function parseZipCentralDirectory(buffer) {
  const buf = buffer instanceof Uint8Array ? Buffer.from(buffer) : Buffer.alloc(0);
  const base = { ok: false, format: ARCHIVE_FORMATS.zip, count: 0, entries: [], encrypted: false };
  if (buf.length < 22) return { ...base, error: 'corrupt', truncated: true };
  // 从尾部找 EOCD（注释最长 65535 字节）
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return { ...base, error: 'corrupt' };
  const entriesTotal = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entriesTotal === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return { ...base, error: 'zip64-unsupported' };
  }
  if (cdOffset + cdSize > buf.length) return { ...base, error: 'corrupt' };
  const entries = [];
  let encrypted = false;
  let pos = cdOffset;
  for (let i = 0; i < entriesTotal; i += 1) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== ZIP_CD_SIG) return { ...base, error: 'corrupt' };
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    const isEncrypted = (flags & 0x1) === 0x1;
    if (isEncrypted) encrypted = true;
    entries.push({ name, size, compressedSize, method, encrypted: isEncrypted, isDir: /\/$/.test(name) });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, format: ARCHIVE_FORMATS.zip, count: entries.length, entries, encrypted, ...(encrypted ? { error: 'encrypted' } : {}) };
}

/**
 * 读压缩包目录表（文件版；只读文件头 + 尾部 + 中央目录，不解压、不读文件内容）。
 * 大文件友好：2.5GB 的包也只读几十 KB。
 * @returns {{ok:boolean, format:string, error?:string, count:number, entries:Array, encrypted:boolean}}
 */
export function readArchiveToc(filePath) {
  const abs = path.resolve(String(filePath));
  const base = { ok: false, format: ARCHIVE_FORMATS.unknown, count: 0, entries: [], encrypted: false };
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return { ...base, format: ARCHIVE_FORMATS.unknown, error: 'corrupt' };
    const headLen = Math.min(512, size);
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);
    const format = detectArchiveFormat(head);
    if (format === ARCHIVE_FORMATS.rar || format === ARCHIVE_FORMATS['7z']) {
      return { ...base, format, error: 'unsupported-format' };
    }
    if (format !== ARCHIVE_FORMATS.zip) return { ...base, format, error: 'unsupported-format' };
    // EOCD 在文件尾部（最多 22+65535 字节内）
    const tailLen = Math.min(size, 22 + 65535);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    const offsetInTail = (() => {
      for (let i = tail.length - 22; i >= 0; i -= 1) if (tail.readUInt32LE(i) === ZIP_EOCD_SIG) return i;
      return -1;
    })();
    if (offsetInTail < 0) return { ...base, format, error: 'corrupt' };
    const entriesTotal = tail.readUInt16LE(offsetInTail + 10);
    const cdSize = tail.readUInt32LE(offsetInTail + 12);
    const cdOffset = tail.readUInt32LE(offsetInTail + 16);
    if (entriesTotal === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      return { ...base, format, error: 'zip64-unsupported' };
    }
    const cap = Math.min(cdSize, 64 * 1024 * 1024); // 中央目录上限 64MB，防烂文件吃内存
    const cd = Buffer.alloc(cap);
    const read = fs.readSync(fd, cd, 0, cap, cdOffset);
    if (read < cap && cap === cdSize) return { ...base, format, error: 'corrupt' };
    return parseZipCdOnly(cd, entriesTotal, { ...base, format });
  } catch (error) {
    return { ...base, error: 'io-error', reason: shortReason(error) };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

/** 只解析中央目录区（文件版用；没有 EOCD 可借）。 */
function parseZipCdOnly(cd, entriesTotal, base) {
  const entries = [];
  let encrypted = false;
  let pos = 0;
  for (let i = 0; i < entriesTotal; i += 1) {
    if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== ZIP_CD_SIG) return { ...base, error: 'corrupt' };
    const flags = cd.readUInt16LE(pos + 8);
    const method = cd.readUInt16LE(pos + 10);
    const compressedSize = cd.readUInt32LE(pos + 20);
    const size = cd.readUInt32LE(pos + 24);
    const nameLen = cd.readUInt16LE(pos + 28);
    const extraLen = cd.readUInt16LE(pos + 30);
    const commentLen = cd.readUInt16LE(pos + 32);
    const name = cd.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    const isEncrypted = (flags & 0x1) === 0x1;
    if (isEncrypted) encrypted = true;
    entries.push({ name, size, compressedSize, method, encrypted: isEncrypted, isDir: /\/$/.test(name) });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return { ...base, ok: true, count: entries.length, entries, encrypted, ...(encrypted ? { error: 'encrypted' } : {}) };
}

/** 目录表摘要（给归档用：几个文件、有没有说明文件、出现过哪些 7 位商品号）。 */
export function summarizeArchiveToc(toc) {
  const entries = Array.isArray(toc?.entries) ? toc.entries : [];
  const names = entries.map((e) => String(e.name || ''));
  const boothIds = [...new Set(names.map((n) => simpleBoothId(path.posix.basename(n))).filter(Boolean))];
  const readme = names.find((n) => /(^|\/)readme|说明/i.test(n)) || '';
  return {
    ok: Boolean(toc?.ok),
    format: String(toc?.format || ''),
    error: String(toc?.error || ''),
    encrypted: Boolean(toc?.encrypted),
    count: Number(toc?.count) || entries.length,
    totalBytes: entries.reduce((n, e) => n + (Number(e.size) || 0), 0),
    hasReadme: Boolean(readme),
    readmeName: readme,
    boothIds
  };
}

// ── 缩略图信号量（并发上限 2）+ 超大跳过 ────────────────────────────────────
export const THUMB_CONCURRENCY = 2;

export const THUMB_MAX_BYTES = 8 * 1024 * 1024;

/** 极简信号量：`run(fn)` 排队，最多 limit 个并发。 */
export function createSemaphore(limit = THUMB_CONCURRENCY) {
  const cap = Math.max(1, Math.trunc(Number(limit) || 1));
  let active = 0;
  const queue = [];
  const release = () => {
    // 先减再唤醒：被唤醒者会自己 +1，否则交接时 active 会虚高（并发上限就破了）。
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };
  return {
    get active() { return active; },
    get waiting() { return queue.length; },
    get limit() { return cap; },
    async run(fn) {
      if (active >= cap) await new Promise((resolve) => queue.push(resolve));
      active += 1;
      try { return await fn(); } finally { release(); }
    }
  };
}

/** 全局缩略图信号量（大批量抓封面时别把 CPU/IO 打满）。 */
export const thumbSemaphore = createSemaphore(THUMB_CONCURRENCY);

/** 在缩略图槽位里跑（并发上限 2）。 */
export function withThumbSlot(fn) {
  return thumbSemaphore.run(fn);
}

/** 超大图不解/不缩（按字节数判断；未知大小按"不跳过"处理）。 */
export function shouldSkipThumb({ bytes = 0, maxBytes = THUMB_MAX_BYTES } = {}) {
  const n = Math.max(0, Number(bytes) || 0);
  const cap = Math.max(0, Number(maxBytes) || THUMB_MAX_BYTES);
  return n > cap;
}

/**
 * 增强一条转存记录（BOOTH 元数据 + 归类 + meta.json + 缩略图）。**总是不抛**。
 *
 * 归类优先级（人工优先是硬规则）：
 * 1. `category_source === 'manual'`：**完全不改分类、不移动文件**，只补 BOOTH 元数据/缩略图；
 * 2. BOOTH 页面分类（ld+json 的 category）；
 * 3. 扩展名规则分类（入库时已写）；
 * 4. `未分类`。
 *
 * @param {{db:object,rootDir:string,id:number,cfg:object,nowMs?:number,deps?:object}} args
 *   deps.fetchBoothMeta(boothId) → meta；deps.downloadThumb(url, destAbs, maxBytes) → boolean
 * @returns {Promise<{id:number,status:string,boothId:string,category?:string,relPath?:string,error?:string,skipped?:boolean}>}
 */
export async function enrichArchiveItem(args = {}) {
  // 抓元数据会搬文件、写 meta.json：整段持有 fileOpsMu，避免扫描看到半搬运状态。
  return fileOpsMu.run(() => enrichArchiveItemUnlocked(args), 'archive-enrich');
}

async function enrichArchiveItemUnlocked({ db, rootDir, id, cfg = {}, nowMs = Date.now(), deps = {} } = {}) {
  const row = db.prepare('SELECT * FROM file_archive WHERE id = ?').get(Number(id));
  if (!row) return { id: Number(id), status: 'skipped', boothId: '', skipped: true, error: '台账里没有这条记录' };
  const mapped = mapArchiveRow(row);
  if (mapped.deletedAt) return { id: Number(id), status: 'skipped', boothId: mapped.boothId, skipped: true, error: '文件已清理' };
  const parsed = parseBoothName(mapped.fileName);
  const boothEnabled = cfg?.booth?.enabled !== false;
  if (!parsed.boothId || !boothEnabled) {
    return { id: Number(id), status: 'skipped', boothId: parsed.boothId || '', skipped: true, error: parsed.boothId ? 'BOOTH 功能已关闭' : '文件名没有 BOOTH 号' };
  }
  // 商品条目只从**压缩包**派生；图片照旧落盘/进台账，但只记录 BOOTH 号（供「同号图片归属」查询），
  // 不建商品目录、不写 meta.json、不抢封面。
  if (!isArchiveFileName(mapped.fileName)) {
    try {
      updateArchiveEnrichment(db, id, {
        boothId: parsed.boothId,
        boothUrl: `https://booth.pm/zh-cn/items/${parsed.boothId}`,
        enrichStatus: 'skipped',
        enrichError: '图片不创建商品条目（只归档压缩包）',
        enrichedAt: Number(nowMs) || Date.now()
      });
    } catch {}
    return { id: Number(id), status: 'skipped', boothId: parsed.boothId, skipped: true, error: '图片不创建商品条目（只归档压缩包）' };
  }
  const manual = mapped.categorySource === 'manual';
  let meta;
  try {
    meta = typeof deps.fetchBoothMeta === 'function'
      ? await deps.fetchBoothMeta(parsed.boothId)
      : { status: 'error', error: '未提供 fetchBoothMeta' };
  } catch (error) {
    meta = { status: 'error', error: `抓取异常：${error?.message ?? error}` };
  }
  const status = ['ok', 'not_found', 'gated', 'blocked', 'error'].includes(meta?.status) ? meta.status : 'error';
  // 防御性再归一化：即使 meta 来自旧缓存/自定义 fetchImpl，也保证目录名只可能是映射表里的值。
  // 页面没有分类/分类不在映射表 → 视为「无页面分类」，继续用扩展名规则（不强行改「未分类」）。
  const rawMetaCategory = status === 'ok' ? String(meta.category || '').trim() : '';
  const mappedMetaCategory = rawMetaCategory ? normalizeBoothCategory(rawMetaCategory) : '';
  const metaCategory = mappedMetaCategory && mappedMetaCategory !== '未分类' ? mappedMetaCategory : '';
  // 只有抓到有效商品页（status=ok）才「按商品建目录搬家」。404/年龄墙/被拦/网络错误都不搬：
  // 否则 QQ 那种纯数字文件名（如 9013048.zip，其实是网关文件 id）会造出一堆垃圾商品目录。
  // 失败时只记 booth_id / enrich_status / enrich_error，文件留在原处（新文件在「未分类」）。
  const shouldRelocate = !manual && status === 'ok';
  // 人工优先：manual 分类绝不覆盖；否则 BOOTH 分类 > 现有规则分类 > 未分类。
  let category = mapped.category;
  let categorySource = mapped.categorySource;
  if (!manual) {
    if (metaCategory) { category = metaCategory; categorySource = 'booth'; }
    else if (!isClassified(category)) { category = UNCLASSIFIED_DIR; categorySource = categorySource || 'none'; }
  }
  const dirRel = !shouldRelocate
    ? path.dirname(mapped.relPath)
    : (() => {
      const sibling = db.prepare("SELECT rel_path FROM file_archive WHERE group_id = ? AND booth_id = ? AND deleted_at IS NULL AND id <> ? ORDER BY id LIMIT 1")
        .get(mapped.groupId, parsed.boothId, Number(id));
      return sibling ? path.dirname(String(sibling.rel_path)) : archiveDirRel({
        groupId: mapped.groupId,
        category,
        boothId: parsed.boothId,
        // 目录名优先用页面标题（「<boothId> <标题>」），标题为空才退文件名解析出的商品名。
        productName: String(meta.title || parsed.productName || ''),
        fallbackName: mapped.fileName
      });
    })();
  const patch = {
    boothId: parsed.boothId,
    boothUrl: String(meta.itemUrl || `https://booth.pm/zh-cn/items/${parsed.boothId}`),
    boothTitle: String(meta.title || ''),
    boothShop: String(meta.shop || ''),
    boothPrice: String(meta.price || ''),
    boothTags: Array.isArray(meta.tags) ? meta.tags.join('|') : '',
    // 台账口径：抓取失败（网络/429/5xx）记 failed；404/年龄墙/被拦保留原状态。
    enrichStatus: status === 'error' ? 'failed' : status,
    enrichError: String(meta.error || ''),
    enrichedAt: Number(nowMs) || Date.now(),
    category,
    categorySource,
    cleanupAt: cleanupDeadline(mapped.archivedAt, category, cfg?.retention)
  };
  let finalRel = mapped.relPath;
  try {
    if (!manual && path.dirname(mapped.relPath) !== dirRel) {
      const target = allocateArchiveTarget({
        db,
        rootDir,
        groupId: mapped.groupId,
        archivedAt: mapped.archivedAt,
        fileName: mapped.storedName || mapped.fileName,
        baseDirRel: dirRel
      });
      moveFileWithinRoot(rootDir, mapped.relPath, target.relPath);
      patch.relPath = target.relPath;
      patch.storedName = target.storedName;
      finalRel = target.relPath;
    }
    const finalDirRel = path.dirname(finalRel);
    // 只有拿到有效商品页（ok/gated 至少有 og 信息）才写 meta.json / 缩略图；
    // 404/被拦/网络错误只更新台账状态，不在目录里留垃圾文件。
    if (status === 'ok' || status === 'gated') {
      // meta.json：始终写到文件所在目录（手动分类后也补上，方便外部索引）。
      const metaRel = path.join(finalDirRel, 'meta.json');
      patch.metaRel = metaRel;
      // 缩略图：失败不致命，只把原因记进 enrich_error。
      const thumbUrl = String(meta.thumbnailUrl || '').trim();
      if (thumbUrl && typeof deps.downloadThumb === 'function' && boothEnabled) {
        const ext = (thumbUrl.match(/\.(jpe?g|png|gif|webp)(?:[?#]|$)/i) || [])[1] || 'jpg';
        const thumbRel = path.join(finalDirRel, `thumbnail.${ext.toLowerCase()}`);
        try {
          // 缩略图并发上限 2（信号量）：大批量抓封面时不把 CPU/IO 打满。
          const saved = await withThumbSlot(() => deps.downloadThumb(thumbUrl, safeResolveInside(rootDir, thumbRel), Number(cfg?.booth?.thumbMaxBytes) || 2 * 1024 * 1024));
          // downloadThumb 兼容两种返回：boolean（旧测试）或 {ok,status,bytes}（桥接真实实现）。
          const ok = saved === true || (saved && saved.ok !== false);
          if (ok) {
            patch.thumbRel = thumbRel;
            patch.thumbStatus = saved?.status === 'fallback' ? 'fallback' : 'ok';
          } else {
            patch.thumbStatus = 'missing';
            patch.enrichError = joinError(patch.enrichError, saved?.error || '缩略图下载失败');
          }
        } catch (error) {
          patch.thumbStatus = 'missing';
          patch.enrichError = joinError(patch.enrichError, `缩略图下载失败：${shortReason(error)}`);
        }
      } else if (status === 'gated') {
        patch.thumbStatus = 'missing';
      }
      // 商品展示图（cover）：只对压缩包抓；同一个 BOOTH 号首次抓取后走 30 天缓存，
      // 失败只写进 meta 的 coverError，不阻塞转存、也不改动台账状态。
      let coverInfo = null;
      if (typeof deps.ensureCover === 'function') {
        try {
          coverInfo = await deps.ensureCover(parsed.boothId);
        } catch (error) {
          coverInfo = { ok: false, path: '', error: shortReason(error) };
        }
      }
      const metaObj = metaJsonFor({
        ...mapped,
        ...patch,
        relPath: finalRel,
        archivedAt: mapped.archivedAt
      });
      metaObj.coverPath = String(coverInfo?.path || '');
      metaObj.coverError = String(coverInfo?.error || coverInfo?.coverError || '');
      // 同一商品多文件：meta.json 不能互相覆盖 —— 读旧文件，把本次文件并进 files 数组
      // （按 sha256 去重），其余字段以最新一次抓取为准。
      const metaAbs = safeResolveInside(rootDir, metaRel);
      try {
        const prev = JSON.parse(fs.readFileSync(metaAbs, 'utf8'));
        const prevFiles = Array.isArray(prev?.files) ? prev.files : [];
        const current = {
          fileName: String(patch.storedName || mapped.storedName || mapped.fileName),
          bytes: Number(mapped.bytes) || 0,
          sha256: String(mapped.sha256 || ''),
          relPath: finalRel,
          archivedAt: Number(mapped.archivedAt) || 0
        };
        metaObj.files = [
          ...prevFiles.filter((f) => f && f.sha256 !== current.sha256 && f.relPath !== current.relPath),
          current
        ];
      } catch {
        metaObj.files = [{
          fileName: String(patch.storedName || mapped.storedName || mapped.fileName),
          bytes: Number(mapped.bytes) || 0,
          sha256: String(mapped.sha256 || ''),
          relPath: finalRel,
          archivedAt: Number(mapped.archivedAt) || 0
        }];
      }
      fs.mkdirSync(safeResolveInside(rootDir, finalDirRel), { recursive: true });
      writeFileAtomicSync(metaAbs, `${JSON.stringify(metaObj, null, 1)}\n`);
    }
    updateArchiveEnrichment(db, id, patch);
    return { id: Number(id), status, boothId: parsed.boothId, category, relPath: finalRel, thumbRel: patch.thumbRel || '', metaRel: patch.metaRel || '', error: patch.enrichError || '' };
  } catch (error) {
    const failure = `归类/写入失败：${shortReason(error)}`;
    patch.enrichStatus = 'error';
    patch.enrichError = joinError(patch.enrichError, failure);
    try { updateArchiveEnrichment(db, id, patch); } catch {}
    return { id: Number(id), status: 'error', boothId: parsed.boothId, category, relPath: finalRel, error: patch.enrichError };
  }
}
