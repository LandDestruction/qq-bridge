// file-archive/storage.js — 落盘与命名（附件判定/目录/落盘/记账/分类移动/空目录）
// 纯搬运自 src/file-archive.js（D61 拆分）：函数体/注释逐字保留，只做模块化与 import/export。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseBoothName, normalizeBoothConfig } from '../booth-meta.js';

import { ARCHIVE_EXTENSIONS, DEFAULT_MAX_FILE_MB, IMAGE_EXTENSIONS, MAX_FILE_MB, MAX_RETENTION_DAYS, MB, RETENTION_CLASSIFIED_DAYS, RETENTION_UNCLASSIFIED_DAYS, UNCLASSIFIED_DIR, cleanupDeadline, contentKeyFor, extensionOf, formatBytes, formatRulesVersion, normalizeIdList, positiveNumber, sha256Of, shortReason } from './common.js';
import { archiveDirRel, archiveManualDirRel, fileOpsMu, recordOwnWrite, safeResolveInside, simpleArchiveDir, writeFileAtomicSync } from './paths.js';
import { allocateArchiveTarget, findActiveArchive, findActiveArchiveBySha, insertArchiveRecord, mapArchiveRow } from './db.js';
import { describeArchiveRules, normalizeArchiveRules } from './rules.js';

/**
 * 显式白名单：这条附件到底该不该转存。
 *
 * 判据（用户拍板）：
 * - `image` 段 / `media.kind==='image'` → 转（用户发的图片）；
 * - `file` 段且扩展名在压缩包/图片白名单 → 转；
 * - `face`/`mface` 段、`media.kind` 为 `face`/`sticker` → **绝不转**（表情包）；
 * - 其它一律不转。
 *
 * **判不准就不转**：image 段若带表情标记（`emojiId` 或 `subType==='1'`），
 * 说明它其实是被当成表情发的，宁可不存也不要把表情塞进台账。
 *
 * @param {{kind?:string, segType?:string, fileName?:string, emojiId?:string, subType?:string}} input
 * @returns {boolean}
 */
export function shouldArchiveAttachment({ kind = '', segType = '', fileName = '', emojiId = '', subType = '' } = {}) {
  const k = String(kind || '');
  const t = String(segType || '');
  const ext = extensionOf(fileName);
  // 表情：face/mface 段或表情类媒体，无论带不带 url 都不转。
  if (t === 'face' || t === 'mface' || k === 'face' || k === 'sticker') return false;
  // 图片：真·图片段，或扩展名属于图片白名单的 file 段。
  const looksLikeImage = t === 'image' || k === 'image' || IMAGE_EXTENSIONS.includes(ext);
  if (looksLikeImage) {
    const isEmojiMarked = String(emojiId || '').trim() !== '' || String(subType || '') === '1';
    return !isEmojiMarked;
  }
  // 文件：只认压缩包/图片扩展名（图片已在上面返回）。
  if (t === 'file' || k === 'file' || k === 'video-file') return ARCHIVE_EXTENSIONS.includes(ext) || IMAGE_EXTENSIONS.includes(ext);
  return false;
}

/** 给人看的一句话：为什么跳过（日志/事实都用它）。 */
export function describeArchiveSkip({ fileName = '' } = {}) {
  const ext = extensionOf(fileName);
  return ext ? `类型不在转存白名单（.${ext}）` : '类型不在转存白名单（无扩展名）';
}

/**
 * 是不是「压缩包」（商品条目只从压缩包派生；图片只作为商品素材/缩略图，不单独成条目）。
 * 与转存白名单里的 ARCHIVE_EXTENSIONS 同源。
 */
export function isArchiveFileName(fileName) {
  return ARCHIVE_EXTENSIONS.includes(extensionOf(fileName));
}

/**
 * 回收站保留期（天）：0 = 永久保留；非法/缺失 → 30。
 * 单列成函数是因为 storage 是公开模块（测试也直接 import），递归放在 normalizeFileArchiveConfig
 * 里会让那个函数越来越长、也不好单测边界。
 * @param {unknown} raw
 * @returns {number}
 */
export function normalizeTrashRetentionDays(raw) {
  if (raw === undefined || raw === null || raw === '') return 30;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 30;
  return Math.min(3650, Math.max(0, Math.round(days)));
}

/**
 * 规范化 fileArchive 配置（每段都必须有默认值；config.json 是用户可编辑的，不能信任类型）。
 * @param {object|null|undefined} raw
 * @returns {{enabled:boolean,groups:string[],dir:string,maxFileMb:number,
 *   retention:{unclassifiedDays:number,classifiedDays:number},
 *   category:{enabled:boolean,preset:string},cleanupHour:number,rules:object,
 *   usageRoots:string[],trashRetentionDays:number}}
 */
export function normalizeFileArchiveConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const retention = src.retention && typeof src.retention === 'object' ? src.retention : {};
  const category = src.category && typeof src.category === 'object' ? src.category : {};
  const unclassifiedDays = Math.min(MAX_RETENTION_DAYS, Math.max(1, Math.round(positiveNumber(retention.unclassifiedDays, RETENTION_UNCLASSIFIED_DAYS))));
  const classifiedDays = Math.min(MAX_RETENTION_DAYS, Math.max(1, Math.round(positiveNumber(retention.classifiedDays, RETENTION_CLASSIFIED_DAYS))));
  const hour = Number(src.cleanupHour);
  const maxFileMb = Math.min(MAX_FILE_MB, Math.max(1, Math.round(positiveNumber(src.maxFileMb, DEFAULT_MAX_FILE_MB))));
  // 转存口径规则（可配置条件）。rules.maxMb 没显式配时跟随老的 maxFileMb：
  // 用户只调了 maxFileMb 却忘了 rules 的话，不该出现两套互相打脸的上限。
  const rules = normalizeArchiveRules(src.rules);
  if (!(Number(src.rules?.maxMb) > 0)) rules.maxMb = maxFileMb;
  return {
    enabled: src.enabled === true,
    groups: normalizeIdList(src.groups),
    dir: typeof src.dir === 'string' && src.dir.trim() ? src.dir.trim() : 'state/files',
    maxFileMb,
    retention: { unclassifiedDays, classifiedDays },
    category: {
      enabled: category.enabled !== false,
      preset: typeof category.preset === 'string' && category.preset.trim() ? category.preset.trim() : 'qq-chat'
    },
    // 每天几点跑清理（0~23，默认凌晨 4 点）。错过就等下一小时轮询命中。
    cleanupHour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 4,
    // simpleMode：用户退而求其次的兜底——只收「7 位 BOOTH 号开头」的压缩包/图片，
    // 不抓 BOOTH、不自动分类、不自动清理（用户自己整理）。必须在这里显式搬运，
    // 否则 loadConfig 白名单构造会把它丢掉（实测：开了 simpleMode 但清理照跑）。
    simpleMode: src.simpleMode === true,
    // BOOTH 元数据/分类（konoasset 风格元数据管理）。simpleMode 下不启用。
    booth: normalizeBoothConfig(src.booth),
    // 转存口径（扩展名/关键词/体积/发送者/频率）。用户不配时这里是默认值，
    // 与改造前「图片+压缩包全收、表情包永不转」完全等价。
    rules,
    // 「工程使用统计」的扫描根（只读用，见 src/bridge/console/library-usage.js）。
    // 必须在这里显式搬运，否则 loadConfig 的白名单构造会把它丢掉 → 前端永远提示「没配扫描根」。
    usageRoots: (Array.isArray(src.usageRoots) ? src.usageRoots : [])
      .map((item) => String(item ?? '').trim())
      .filter(Boolean),
    // 素材回收站保留期（天，见 src/bridge/console/library-trash.js 的自动清理）。
    // 0 = 永久保留；不配用默认 30 天。同样必须显式搬运，否则 loadConfig 白名单构造会丢字段。
    trashRetentionDays: normalizeTrashRetentionDays(src.trashRetentionDays)
  };
}

/** 群是否在「文件保存」白名单里。空数组 = 谁都不存（fail-closed）。 */
export function isArchiveGroup(cfg, groupId) {
  const gid = String(groupId ?? '').trim();
  if (!gid) return false;
  return Boolean(cfg?.enabled) && Array.isArray(cfg.groups) && cfg.groups.includes(gid);
}

/**
 * 给模型的能力提示（拼进该群每一轮 prompt 的尾部）。
 * 白名单群才有：桥接自动转存，模型没有任何文件工具，必须知道这一点，否则会照旧回答
 * 「我没有存文件的功能」——那对用户来说是「坏了」。同时钉死「保存≠读过内容」。
 */
export function archiveCapabilityHint(cfg, groupId) {
  if (!isArchiveGroup(cfg, groupId)) return '';
  return `【文件自动转存】本群已开启：群友发的文件按约定口径自动保存到本地（${describeArchiveRules(cfg?.rules)}；表情包永不转存）。`
    + '你没有任何文件工具，但请记住这件事——不要再说「我没有存文件的功能」；'
    + '用户问起就如实回答「已经存到本地了，但我没有读取文件内容」。'
    + '文件内容你看不到，不要假装读过、也不要猜内容。';
}

/**
 * 每轮注入给模型的「本轮附件转存结果」事实块（取代原来只有能力说明的静态提示）。
 * 硬要求：没有写「已转存」时模型不许说存好了；文件内容看不到，不许假装读过。
 */
export function formatArchiveFactsBlock({ isWhitelisted = false, facts = [], rules } = {}) {
  const list = Array.isArray(facts) ? facts.filter(Boolean) : [];
  const lines = [];
  if (isWhitelisted) lines.push(`【文件自动转存】本群已开启：群友发的文件按约定口径（${describeArchiveRules(rules)}）由桥接自动保存到本地（表情包和别的类型不转存；你没有任何文件工具）。`);
  const ok = list.filter((f) => f.status === 'ok');
  const dup = list.filter((f) => f.status === 'dup');
  const bad = list.filter((f) => f.status !== 'ok' && f.status !== 'dup');
  if (!list.length) {
    lines.push('【本轮转存结果】本轮没有可转存的附件（这条消息里没有文件/图片，或该群不在白名单）。');
  } else {
    if (ok.length) {
      lines.push(`【本轮转存结果】本轮已转存 ${ok.length} 个附件：`
        + ok.map((f) => `${f.name}（${formatBytes(f.bytes)}，台账 id=${f.id}）`).join('、'));
    }
    if (dup.length) {
      lines.push(`【本轮转存结果】本轮附件已在本地（未重复转存）：`
        + dup.map((f) => `${f.name}（台账 id=${f.id}）`).join('、'));
    }
    for (const f of bad) lines.push(`【本轮转存结果】本轮附件未转存：${f.name}（${f.reason || '原因未知'}）`);
  }
  lines.push('只有上面写了「已转存」才可以说存好了；否则必须如实说没存。文件内容你看不到，不要假装读过或猜内容。');
  return lines.join('\n');
}

// ── 最小分类（规则兜底） ───────────────────────────────────────────────────

// 关键词规则先给「最小可用」：不依赖模型也能立刻有分类；
// 需要更聪明的分类时由桥接用现有 DSH 会话来覆盖（category_source='ai'）。
const CATEGORY_RULES = [
  ['图片', /\.(png|jpe?g|gif|webp|bmp|heic|tiff?)$/i],
  ['视频', /\.(mp4|mkv|mov|avi|flv|wmv|webm|ts)$/i],
  ['音频', /\.(mp3|flac|wav|aac|ogg|m4a|opus)$/i],
  ['压缩包', /\.(zip|7z|rar|tar|gz|bz2|xz)$/i],
  ['文档', /\.(pdf|docx?|xlsx?|pptx?|txt|md|csv|rtf|odt|ods)$/i],
  ['代码', /\.(js|mjs|cjs|ts|tsx|jsx|py|java|c|cpp|h|cs|go|rs|rb|php|html?|css|json|ya?ml|toml|sh|ps1|bat)$/i],
  ['安装包', /\.(exe|msi|apk|ipa|dmg|deb|rpm|appimage)$/i],
  ['电子书', /\.(epub|mobi|azw3?|cbz|cbr)$/i]
];

/**
 * 按扩展名/文件名做最小分类；认不出返回 `unclassified`（→ 60 天保留期）。
 * @returns {{category:string, source:'rule'|'none'}}
 */
export function classifyByRules(fileName) {
  const name = String(fileName ?? '');
  for (const [label, re] of CATEGORY_RULES) {
    if (re.test(name)) return { category: label, source: 'rule' };
  }
  if (/聊天记录|合并转发|\.json$/i.test(name)) return { category: '聊天记录', source: 'rule' };
  return { category: 'unclassified', source: 'none' };
}

/** 把模型输出解析成分类名（容忍引号/句号/空白）。非法返回空串。 */
export function parseClassifyReply(raw) {
  // 只取第一行；再一次性剥掉首尾的引号/括号/句末标点（中英文都要认）。
  const firstLine = String(raw ?? '').split(/[\r\n]/)[0] ?? '';
  let text = firstLine.trim();
  text = text.replace(/^[\s"'`「『（(]+/, '').replace(/[\s"'`」』）)。.!！?？]+$/, '');
  text = text.trim();
  if (!text || text.length > 12) return '';
  if (/^unclassified$/i.test(text) || text === '未分类') return 'unclassified';
  return text;
}

/** 把已经就位的文件改名进目标位置并写台账（buffer 路径与流式下载路径共用）。 */
function finalizeArchivedFile({
  db, groupId, fileId, fileName, storedName, relPath, absPath, tmpPath,
  bytes, sha256, messageId, uploader, uploadedAt, archivedAt,
  retention, source, category, categorySource
}) {
  // 先写临时文件再 rename：中途失败不会留下「半个文件被当成完整文件」的假象。
  fs.renameSync(tmpPath, absPath);
  recordOwnWrite(absPath); // 自己搬完的文件：扫描别当成外部改动（防自激重扫）
  const rule = category == null
    ? classifyByRules(storedName)
    : { category: String(category), source: categorySource || 'manual' };
  const cleanupAt = cleanupDeadline(archivedAt, rule.category, retention);
  const { id, inserted } = insertArchiveRecord(db, {
    groupId,
    fileId,
    fileName,
    storedName,
    relPath,
    bytes,
    sha256,
    messageId,
    uploader,
    uploadedAt,
    archivedAt,
    category: rule.category,
    categorySource: rule.source,
    cleanupAt,
    retention,
    source
  });
  return {
    id, inserted, relPath, storedName, bytes, sha256,
    contentKey: contentKeyFor(fileName, bytes),
    rulesVer: formatRulesVersion(),
    category: rule.category, categorySource: rule.source, cleanupAt, archivedAt
  };
}

/**
 * 把一段已下载好的字节按统一规则落盘并记账（notice 与聊天 file 段共用同一条路径规则）：
 * 目录 `<群号>/<YYYY-MM>/`、重名加 `(n)`、先写 `.tmp` 再 rename、sha256、分类、清理时间。
 * 分类：传了 `category` 就用它（`categorySource` 记来源），否则按扩展名规则。
 * @returns {{id:number,inserted:boolean,relPath:string,storedName:string,bytes:number,sha256:string,
 *   category:string,categorySource:string,cleanupAt:number,archivedAt:number}}
 */
export function storeArchivedFile({
  db, rootDir, groupId, fileId = '', fileName = 'file', buffer,
  messageId = '', uploader = '', uploadedAt = 0, archivedAt = Date.now(),
  retention = null, source = '', category = null, categorySource = '',
  baseDirRel = ''
} = {}) {
  if (!db) throw new Error('storeArchivedFile 需要已打开的台账连接');
  if (!buffer || !buffer.length) throw new Error('storeArchivedFile 需要非空文件内容');
  const when = Number(archivedAt) || Date.now();
  const target = allocateArchiveTarget({ db, rootDir, groupId, archivedAt: when, fileName, baseDirRel });
  fs.writeFileSync(target.tmpPath, buffer, { flag: 'wx' });
  return finalizeArchivedFile({
    db, groupId, fileId, fileName, ...target,
    bytes: buffer.length,
    sha256: sha256Of(buffer),
    messageId, uploader, uploadedAt,
    archivedAt: when, retention, source, category, categorySource
  });
}

/**
 * 流式版本：文件字节已经由下载器写进 `target.tmpPath`（边下边写、边算 sha256）。
 * 调用方负责保证 tmpPath 非空、且下载没有被截断。
 * @returns {Promise<object>} 与 storeArchivedFile 相同
 */
export async function storeDownloadedFile({
  db, groupId, fileId = '', fileName = 'file', target,
  bytes, sha256 = '', messageId = '', uploader = '', uploadedAt = 0,
  archivedAt = Date.now(), retention = null, source = '', category = null, categorySource = ''
} = {}) {
  if (!db) throw new Error('storeDownloadedFile 需要已打开的台账连接');
  if (!target?.tmpPath) throw new Error('storeDownloadedFile 需要 allocateArchiveTarget 的结果');
  const when = Number(archivedAt) || Date.now();
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) {
    try { fs.unlinkSync(target.tmpPath); } catch {}
    throw new Error('storeDownloadedFile 需要正确的字节数（空文件不转存）');
  }
  const digest = /^[0-9a-f]{64}$/i.test(String(sha256)) ? String(sha256).toLowerCase() : await sha256OfFile(target.tmpPath);
  return finalizeArchivedFile({
    db, groupId, fileId, fileName, ...target,
    bytes: size,
    sha256: digest,
    messageId, uploader, uploadedAt,
    archivedAt: when, retention, source, category, categorySource
  });
}

/** 流式算文件 sha256（内存占用恒定；下载器没给摘要时用）。 */
export function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 把 OneBot 消息段里的 `file` 段摘出来（聊天里发的文件走消息，不是 group_upload 事件）。
 * 字段来自 SnowLuma 的 file 元素映射（index.mjs: `file.toSegment`）：
 * `{file, file_id, file_size, name, size, id, url, file_hash}` —— 同一个信息有 snake/camel/短名三套写法。
 */
export function chatFileSegments(segments) {
  const out = [];
  const list = Array.isArray(segments) ? segments : [];
  for (let index = 0; index < list.length; index += 1) {
    const seg = list[index];
    if (!seg || seg.type !== 'file') continue;
    const d = seg.data ?? {};
    const fileId = String(d.file_id ?? d.id ?? d.fileId ?? '').trim();
    const rawName = String(d.name ?? d.file_name ?? d.fileName ?? d.file ?? '').trim();
    const size = Number(d.file_size ?? d.size ?? d.fileSize) || 0;
    out.push({
      index,
      name: rawName || (fileId ? `文件-${fileId}` : '文件'),
      fileId,
      size,
      url: String(d.url ?? ''),
      busid: Number(d.busid) || 102,
      fileHash: String(d.file_hash ?? d.fileHash ?? '')
    });
  }
  return out;
}

/**
 * 聊天消息里的文件转存（桥接在把消息交给模型之前调用）。
 * - 不在白名单群：返回 null，**一次下载/台账都不碰**（非白名单群行为完全不变）。
 * - 下载优先用消息段自带的 `url`；没有 url 才用 `getFileUrl(fileId)`（OneBot get_group_file_url）。
 * - 返回的 `annotations` 是 `Map<段下标, 给模型看的说明>`：成功时模型能看见「已转存到本地」，
 *   失败/超限也如实写清原因，不会静默丢文件。
 * @param {{segments:any[],groupId:string|number,cfg:object,deps:object}} args
 * @returns {Promise<null|{annotations:Map<number,string>,archived:object[]}>}
 */
export async function archiveChatFileSegments({ segments, groupId, cfg, deps = {} } = {}) {
  const gid = String(groupId ?? '').trim();
  if (!isArchiveGroup(cfg, gid)) return null;
  const db = deps.db;
  if (!db) throw new Error('archiveChatFileSegments 需要 deps.db（文件台账）');
  const rootDir = deps.rootDir;
  if (!rootDir) throw new Error('archiveChatFileSegments 需要 deps.rootDir（转存目录）');
  const nowMs = Number(deps.nowMs) || Date.now();
  const maxMb = Math.max(1, Number(cfg?.maxFileMb) || DEFAULT_MAX_FILE_MB);
  const maxBytes = maxMb * MB;
  // simpleMode：按每个文件自己的 7 位 BOOTH 号分目录（同号文件落同一个号文件夹）；
  // 没有 7 位号的（如 8 位日期误判）继续走年月目录。非 simpleMode 保持原逻辑。
  const baseDirFor = (name) => (cfg?.simpleMode === true
    ? simpleArchiveDir(cfg, gid, nowMs, name)
    : (cfg?.booth?.enabled === false ? '' : archiveDirRel({ groupId: gid })));
  const annotations = new Map();
  const archived = [];
  // facts：给模型看的「本轮转存结果」事实（与 annotations 的区别是它不含暗示，
  // 只有 ok/dup/skipped/failed 四种状态，由桥接拼成每轮注入的事实块）。
  const facts = [];
  const skipped = [];
  for (const item of chatFileSegments(segments)) {
    const label = item.name;
    const baseDirRel = baseDirFor(label);
    // 类型白名单（用户拍板：只转图片 + 压缩包）。不满足的**绝不下载**，但必须留日志/事实，
    // 否则「发了却没存」永远查不出来。判不准（例如表情标记）同样按不转处理。
    if (!shouldArchiveAttachment({ segType: 'file', fileName: label })) {
      const reason = describeArchiveSkip({ fileName: label });
      annotations.set(item.index, `[文件${label}（未转存：${reason}）]`);
      facts.push({ status: 'skipped', name: label, reason });
      skipped.push({ index: item.index, name: label, reason });
      if (typeof deps.logSkip === 'function') deps.logSkip(label, reason);
      else if (typeof deps.log === 'function') deps.log(`聊天文件跳过：群 ${gid}「${label}」${reason}`);
      continue;
    }
    if (item.fileId) {
      const existing = findActiveArchive(db, { groupId: gid, fileId: item.fileId });
      if (existing) {
        annotations.set(item.index, `[文件${label}（已在本地，id=${existing}，没有重复转存）]`);
        facts.push({ status: 'dup', name: label, id: existing });
        continue;
      }
    }
    if (item.size > maxBytes) {
      annotations.set(item.index, `[文件${label}（未转存：${formatBytes(item.size)}，超过 ${formatBytes(maxBytes)} 上限）]`);
      facts.push({ status: 'skipped', name: label, bytes: item.size, reason: `${formatBytes(item.size)} 超过 ${formatBytes(maxBytes)} 上限` });
      continue;
    }
    try {
      let url = item.url;
      if (!url && item.fileId && typeof deps.getFileUrl === 'function') {
        const info = await deps.getFileUrl(item.fileId, item.busid);
        url = typeof info === 'string' ? info : String(info?.url ?? '');
      }
      if (!url) throw new Error('消息里没有下载地址，get_group_file_url 也没给 url');
      // 大文件（2.5G 级别）必须**流式**下载并直接写进目标临时文件：读进内存会 OOM。
      // 优先用 deps.downloadToFile；没提供时才退回 buffer 版本（测试/小文件）。
      let stored;
      if (typeof deps.downloadToFile === 'function') {
        const target = allocateArchiveTarget({ db, rootDir, groupId: gid, archivedAt: nowMs, fileName: label, baseDirRel });
        const fetched = await deps.downloadToFile(url, target.tmpPath, maxBytes);
        if (fetched?.truncated) {
          try { fs.unlinkSync(target.tmpPath); } catch {}
          annotations.set(item.index, `[文件${label}（未转存：超过 ${formatBytes(maxBytes)} 上限被截断）]`);
          facts.push({ status: 'skipped', name: label, reason: `超过 ${formatBytes(maxBytes)} 上限被截断` });
          continue;
        }
        const size = Number(fetched?.bytes);
        if (!Number.isFinite(size) || size <= 0) {
          try { fs.unlinkSync(target.tmpPath); } catch {}
          throw new Error('下载结果为空');
        }
        stored = await storeDownloadedFile({
          db, groupId: gid, fileId: item.fileId, fileName: label, target,
          bytes: size,
          sha256: fetched?.sha256 ?? '',
          messageId: String(deps.messageId ?? ''),
          uploader: String(deps.uploader ?? ''),
          uploadedAt: Number(deps.uploadedAt) || 0,
          archivedAt: nowMs,
          retention: cfg?.retention,
          source: 'chat'
        });
      } else {
        if (typeof deps.download !== 'function') throw new Error('没有可用的下载实现');
        const fetched = await deps.download(url, maxBytes);
        if (fetched?.truncated) {
          annotations.set(item.index, `[文件${label}（未转存：超过 ${formatBytes(maxBytes)} 上限被截断）]`);
          facts.push({ status: 'skipped', name: label, reason: `超过 ${formatBytes(maxBytes)} 上限被截断` });
          continue;
        }
        const buffer = fetched?.buffer;
        if (!buffer || !buffer.length) throw new Error('下载结果为空');
        stored = storeArchivedFile({
          db,
          rootDir,
          groupId: gid,
          fileId: item.fileId,
          fileName: label,
          buffer,
          messageId: String(deps.messageId ?? ''),
          uploader: String(deps.uploader ?? ''),
          uploadedAt: Number(deps.uploadedAt) || 0,
          archivedAt: nowMs,
          retention: cfg?.retention,
          source: 'chat',
          baseDirRel
        });
      }
      archived.push({ ...stored, index: item.index });
      annotations.set(item.index, `[文件${label}（已转存到本地，id=${stored.id}，内容未读取）]`);
      facts.push({ status: 'ok', name: label, bytes: stored.bytes, id: stored.id });
    } catch (error) {
      annotations.set(item.index, `[文件${label}（转存失败：${shortReason(error)}）]`);
      facts.push({ status: 'failed', name: label, reason: shortReason(error) });
      if (typeof deps.log === 'function') deps.log(`聊天文件转存失败：群 ${gid}「${label}」${shortReason(error)}`);
    }
  }
  return { annotations, archived, facts, skipped };
}

/**
 * 图片附件转存（复用媒体管线已经下载好的 buffer，**不二次下载**）。
 * - 只接受「真图片」：`kind` 为 face/sticker、或带表情标记（emojiId/subType=1）一律 skipped，
 *   宁可不存也不把表情塞进台账。
 * - 按 sha256 去重：同一张图连发两次只存一份（台账里 `category=image`）。
 * - 超出上限、写盘失败都返回 fact，让模型如实说「没存」，而不是猜「存好了」。
 * @returns {{status:'ok'|'dup'|'skipped'|'failed', name:string, bytes?:number, id?:number, reason?:string, record?:object}}
 */
export function archiveImageAttachment({
  db, rootDir, groupId, buffer, fileName = 'image.png', fileId = '',
  mimeType = '', messageId = '', uploader = '', uploadedAt = 0,
  archivedAt = Date.now(), retention = null, maxBytes = DEFAULT_MAX_FILE_MB * MB,
  kind = 'image', segType = 'image', emojiId = '', subType = '', baseDirRel = ''
} = {}) {
  const name = String(fileName || 'image.png');
  // 表情包/判不准的一律不转（用户明确要求）。
  if (!shouldArchiveAttachment({ kind, segType, fileName: name, emojiId, subType })) {
    return { status: 'skipped', name, reason: '表情包或类型不在转存白名单，不转存' };
  }
  if (!buffer || !buffer.length) return { status: 'failed', name, reason: '图片字节为空' };
  const size = buffer.length;
  if (size > maxBytes) {
    return { status: 'skipped', name, bytes: size, reason: `${formatBytes(size)} 超过 ${formatBytes(maxBytes)} 上限` };
  }
  try {
    const sha = sha256Of(buffer);
    const dupId = findActiveArchiveBySha(db, { groupId, sha256: sha });
    if (dupId) return { status: 'dup', name, bytes: size, id: dupId };
    // 图片的 file_id 用网关给的 file（通常是 md5/资源 id），没有就留空，去重靠 sha256。
    const record = storeArchivedFile({
      db,
      rootDir,
      groupId,
      fileId: String(fileId || ''),
      fileName: name,
      buffer,
      messageId,
      uploader,
      uploadedAt,
      archivedAt,
      retention,
      source: 'image',
      category: 'image',
      categorySource: 'media',
      baseDirRel
    });
    return { status: 'ok', name, bytes: size, id: record.id, record };
  } catch (error) {
    return { status: 'failed', name, bytes: size, reason: shortReason(error) };
  }
}

/**
 * 人工/AI 覆盖分类：同时重算 cleanup_at（未分类↔已分类的保留期不同，漏重算就会出现
 * 「分类了却仍按 60 天删」的错账）。
 */
export function setArchiveCategory(db, { id, category, source = 'manual', nowMs = Date.now(), retention = null }) {
  const row = db.prepare('SELECT id, archived_at FROM file_archive WHERE id = ?').get(Number(id));
  if (!row) throw new Error(`台账里没有 id=${id} 的记录`);
  const nextCategory = String(category ?? '').trim();
  const cleanupAt = cleanupDeadline(Number(row.archived_at) || nowMs, nextCategory, retention);
  db.prepare('UPDATE file_archive SET category = ?, category_source = ?, cleanup_at = ? WHERE id = ?')
    .run(nextCategory, String(source), cleanupAt, Number(id));
  return { id: Number(id), category: nextCategory, cleanupAt };
}

/**
 * 人工指定分类并**移动文件**（连同 meta.json/缩略图），写 `category_source='manual'`。
 * 移动后会重算 cleanup_at；BOOTH 后台重抓看到 manual 不会再搬（判定点见 enrichArchiveItem）。
 *
 * @returns {{id:number, category:string, relPath:string, moved:boolean, cleanupAt:number}}
 */
export function moveArchiveItemToCategory(opts = {}) {
  // 人工改分类会**真移动文件**：必须与扫描互斥。同步函数等不了 Promise，
  // 所以忙时直接抛 FileOpsBusyError（调用方回 409/重试），绝不半搬运。
  return fileOpsMu.runSync(() => moveArchiveItemToCategoryUnlocked(opts), 'archive-move');
}

function moveArchiveItemToCategoryUnlocked({ db, rootDir, id, category, retention = null, nowMs = Date.now() } = {}) {
  const row = mapArchiveRow(db.prepare('SELECT * FROM file_archive WHERE id = ?').get(Number(id)));
  if (!row) throw new Error(`台账里没有 id=${id} 的记录`);
  if (row.deletedAt) throw new Error('该文件已清理，不能移动');
  const nextCategory = String(category ?? '').trim() || UNCLASSIFIED_DIR;
  const parsed = parseBoothName(row.fileName);
  const boothId = row.boothId || parsed.boothId || '';
  const dirRel = archiveManualDirRel({
    groupId: row.groupId,
    category: nextCategory,
    boothId,
    productName: parsed.productName,
    fallbackName: row.fileName
  });
  let relPath = row.relPath;
  let storedName = row.storedName;
  let metaRel = row.metaRel;
  let thumbRel = row.thumbRel;
  let moved = false;
  if (path.dirname(row.relPath) !== dirRel) {
    const target = allocateArchiveTarget({
      db,
      rootDir,
      groupId: row.groupId,
      archivedAt: row.archivedAt,
      fileName: row.storedName || row.fileName,
      baseDirRel: dirRel
    });
    moveFileWithinRoot(rootDir, row.relPath, target.relPath);
    relPath = target.relPath;
    storedName = target.storedName;
    moved = true;
    // meta.json / 缩略图跟着走（保 basename；目标目录里已有同名就先删旧的，避免 UNIQUE/覆盖歧义）
    for (const [key, rel] of [['metaRel', row.metaRel], ['thumbRel', row.thumbRel]]) {
      if (!rel) continue;
      const base = path.basename(rel);
      const toRel = path.join(dirRel, base);
      try {
        const fromAbs = safeResolveInside(rootDir, rel);
        const toAbs = safeResolveInside(rootDir, toRel);
        if (fs.existsSync(fromAbs)) {
          fs.mkdirSync(path.dirname(toAbs), { recursive: true });
          if (fs.existsSync(toAbs)) fs.rmSync(toAbs, { force: true });
          fs.renameSync(fromAbs, toAbs);
        }
        if (key === 'metaRel') metaRel = toRel; else thumbRel = toRel;
      } catch {}
    }
  }
  const cleanupAt = cleanupDeadline(row.archivedAt || nowMs, nextCategory, retention);
  db.prepare(`UPDATE file_archive SET rel_path = ?, stored_name = ?, meta_rel = ?, thumb_rel = ?,
    category = ?, category_source = 'manual', cleanup_at = ? WHERE id = ?`)
    .run(relPath, storedName, metaRel, thumbRel, nextCategory, cleanupAt, Number(id));
  if (moved) {
    // 旧目录（商品目录/未分类）空了就删，别留空壳
    try { pruneEmptyDirs(rootDir, safeResolveInside(rootDir, path.dirname(row.relPath))); } catch {}
  }
  // 顺手把 meta.json 里的 category/thumbPath 也更新（外部索引不会看到旧分类）
  if (metaRel) {
    try {
      const metaAbs = safeResolveInside(rootDir, metaRel);
      const meta = JSON.parse(fs.readFileSync(metaAbs, 'utf8'));
      meta.category = nextCategory;
      meta.thumbPath = thumbRel;
      writeFileAtomicSync(metaAbs, `${JSON.stringify(meta, null, 1)}\n`);
    } catch {}
  }
  return { id: Number(id), category: nextCategory, relPath, moved, cleanupAt };
}

/** 改分类时的目录移动规划（纯函数；fs 操作由调用方做，便于回滚与测试）。
 * 结构约定：state/files/<群>/<分类>/<boothId> <标题>/  → 只换第二段。
 * 没有 booth_id（未建目录）→ {simple:true}，只改台账分类。
 */
export function planCategoryMove({ row, newCategory } = {}) {
  const cat = String(newCategory || '').trim();
  if (!row) return { ok: false, reason: 'row-required' };
  if (!row.boothId) return { ok: true, simple: true };
  const rel = String(row.relPath || '');
  const parts = rel.split('/');
  if (parts.length < 3) return { ok: false, reason: 'unexpected-structure' };
  const oldCat = parts[1];
  const rest = parts.slice(2).join('/');
  const newRel = [parts[0], cat || oldCat, rest].filter(Boolean).join('/');
  const remap = (p2) => {
    const v = String(p2 || '');
    if (!v) return v;
    const seg = v.split('/');
    if (seg.length < 3) return v;
    return [seg[0], cat || oldCat, ...seg.slice(2)].join('/');
  };
  return { ok: true, simple: false, oldCategory: oldCat, newCategory: cat || oldCat, newDirRel: parts.slice(0,2).join('/').replace(parts[1], cat || oldCat), newRel, newThumbRel: remap(row.thumbRel), newMetaRel: remap(row.metaRel) };
}

/** 目录里是否还留着实则文件（用于清理空目录；thumbnail/meta 也算，所以要一起删）。 */
function removeFileQuietly(absPath) {
  try { fs.unlinkSync(absPath); } catch {}
}

/** 从某个文件/目录往上删空目录（不会越过 rootDir）。 */
export function pruneEmptyDirs(rootDir, absPath) {
  const root = path.resolve(rootDir);
  let dir = path.resolve(absPath);
  try {
    if (fs.statSync(dir).isFile()) dir = path.dirname(dir);
  } catch { dir = path.dirname(dir); }
  for (;;) {
    if (dir === root || !dir.startsWith(root + path.sep)) break;
    let entries;
    try { entries = fs.readdirSync(dir); } catch { break; }
    if (entries.length > 0) break;
    try { fs.rmdirSync(dir); } catch { break; }
    dir = path.dirname(dir);
  }
}

/**
 * 把文件移动到同一转存根下的新位置（同盘 rename；跨盘/占用时退回复制+删除）。
 * 目标目录会自动创建；目标已存在同名文件时由调用方先 allocate。
 */
export function moveFileWithinRoot(rootDir, fromRel, toRel) {
  const fromAbs = safeResolveInside(rootDir, fromRel);
  const toAbs = safeResolveInside(rootDir, toRel);
  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  try {
    fs.renameSync(fromAbs, toAbs);
  } catch {
    fs.copyFileSync(fromAbs, toAbs);
    removeFileQuietly(fromAbs);
  }
  recordOwnWrite(toAbs);
}
