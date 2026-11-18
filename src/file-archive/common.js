// file-archive/common.js — 通用常量与纯工具（规则版本 / 内容标识 / 字节与错误格式化 / 保留期口径）
// 纯搬运自 src/file-archive.js（D61 拆分）：函数体/注释逐字保留，只做模块化与 import/export。

import crypto from 'node:crypto';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** 未分类文件的保留天数（60 天）。 */
export const RETENTION_UNCLASSIFIED_DAYS = 60;

/** 已分类文件的保留天数（120 天）。 */
export const RETENTION_CLASSIFIED_DAYS = 120;

/** 单文件上限（用户拍板 2.5GB；按 2.5GiB = 2560MB 算，配置值超过它会被夹到 2560）。 */
export const MAX_FILE_MB = 2560;

/** 默认单文件上限：与硬上限一致（不配也是 2.5GB）。 */
export const DEFAULT_MAX_FILE_MB = 2560;

export const MAX_RETENTION_DAYS = 3650;

// ── P0 一致性基座（M6 spec §3）：contentKey / 规则版本 / 原子写 / 自写记账 / fileOpsMu ──
// 原则：**只加不删**。新能力都有默认值，旧调用点（同步移动、清理）行为不变，
// 只是多了互斥、原子写与记账；踩过的坑写在注释里，别轻易"简化"。

/** 识别规则版本号：改 shouldArchive/simpleBoothId 这类"认得出"的规则就 +1。 */
export const IDENTIFY_RULES_VERSION = 1;

/** 分类规则版本号：改 CATEGORY_RULES / 未分类映射就 +1。 */
export const CATEGORY_RULES_VERSION = 1;

/** BOOTH 规则版本号：改商品号解析 / 目录布局就 +1。 */
export const BOOTH_RULES_VERSION = 1;

export const RULES_VERSIONS = Object.freeze({
  identify: IDENTIFY_RULES_VERSION,
  category: CATEGORY_RULES_VERSION,
  booth: BOOTH_RULES_VERSION
});

/** 规则版本落盘文件名（放在 state/ 下，与台账互为备份）。 */
export const RULES_STATE_FILE = 'file-archive-rules.json';

/** 台账行上的版本串：`identify=1,category=1,booth=1`（人可读，SQL 里也好查）。 */
export function formatRulesVersion(versions = RULES_VERSIONS) {
  const v = versions && typeof versions === 'object' ? versions : {};
  return ['identify', 'category', 'booth']
    .map((k) => `${k}=${Number(v[k]) || 0}`)
    .join(',');
}

export function parseRulesVersion(text) {
  const out = { identify: 0, category: 0, booth: 0 };
  for (const part of String(text ?? '').split(',')) {
    const [k, v] = part.split('=');
    const key = String(k ?? '').trim();
    if (key in out) out[key] = Number(v) || 0;
  }
  return out;
}

/** 这一行的结论是不是按当前规则算的；不是就该重算（旧结论当参考、不再当真相）。 */
export function isStaleRulesVersion(text, current = RULES_VERSIONS) {
  const row = parseRulesVersion(text);
  return ['identify', 'category', 'booth'].some((k) => row[k] !== (Number(current[k]) || 0));
}

/**
 * 稳定内容标识：`sha256(文件名小写 + 字节数)` 前 16 位。
 * 为什么不是纯路径：文件被移动/改名后路径就变了，contentKey 不变——这是"盘上文件是唯一真相"的地基。
 * 用 `\0` 分隔名与大小，避免 `a.zip`+`12` 与 `a.zip1`+`2` 拼成同一个串。
 */
export function contentKeyFor(fileName, bytes) {
  const name = String(fileName ?? '').trim().toLowerCase();
  const size = Math.max(0, Math.trunc(Number(bytes) || 0));
  return sha256Of(Buffer.from(`${name}\u0000${size}`, 'utf8')).slice(0, 16);
}

/** 计算 sha256（十六进制小写）。 */
export function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ── 转存类型白名单（用户拍板：只转图片和压缩包，表情包绝不转） ─────────────
/** 压缩包扩展名（大小写不敏感）。 */
export const ARCHIVE_EXTENSIONS = ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst'];

/** 图片扩展名（以「文件」形式发的图也算）。 */
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic'];

// ── 转存口径（只读导出，供控制台展示；值来自上面的 CATEGORY_RULES，避免两处漂移）──
/** 收哪些扩展名：只转图片 + 压缩包；表情包（face/mface）不转。 */
// 这两组是给控制台/统计用的「口径」名字，值必须从上面的主白名单派生，
// 否则两处会漂移（合并时就是这里重复声明了 ARCHIVE_EXTENSIONS 才炸的）。
export const ARCHIVE_IMAGE_EXTENSIONS = IMAGE_EXTENSIONS.concat(['tif', 'tiff']);

export const ARCHIVE_EXCLUDED_KINDS = ['face', 'mface', 'sticker'];

export const MB = 1024 * 1024;

export function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v)))];
}

export function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function extensionOf(name) {
  return String(name ?? '').trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
}

export function shortReason(error, max = 80) {
  const text = String(error?.message ?? error ?? '未知错误').replace(/[\r\n]+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function joinError(base, extra) {
  const a = String(base ?? '').trim();
  const b = String(extra ?? '').trim();
  if (!b) return a;
  return a ? `${a}；${b}` : b;
}

/** 人类可读字节数。 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** 分类字段是否算「已归类」。 */
export function isClassified(category) {
  const c = String(category ?? '').trim().toLowerCase();
  return Boolean(c) && c !== 'unclassified' && c !== '未分类';
}

/** 按分类取保留天数：已分类 120 天，未分类 60 天。 */
export function retentionDaysFor(category, retention = null) {
  const r = retention || {};
  const classified = positiveNumber(r.classifiedDays, RETENTION_CLASSIFIED_DAYS);
  const unclassified = positiveNumber(r.unclassifiedDays, RETENTION_UNCLASSIFIED_DAYS);
  return isClassified(category) ? classified : unclassified;
}

/** 清理时间戳 = 转存时间 + 保留天数（分类变化时必须重算）。 */
export function cleanupDeadline(archivedAtMs, category, retention = null) {
  const at = Number(archivedAtMs) || 0;
  return at + retentionDaysFor(category, retention) * DAY_MS;
}

// ── BOOTH 布局（konoasset 风格：一个商品一个目录 + meta.json） ──────────────

export const UNCLASSIFIED_DIR = '未分类';
