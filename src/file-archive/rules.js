// 文件库自动转存「口径」的可配置条件规则（纯函数，不碰 IO / 不碰数据库）。
//
// 为什么单独拆一个文件：口径判断要在三个地方复用——群文件通知（file-archive-runtime）、
// 聊天图片（attachment-archive）、以及控制台/提示词里的口径说明。放在纯函数里才能单测，
// 也能保证「默认配置」与改造前的老行为逐字节一致（见 DEFAULT_ARCHIVE_RULES 的来历）。
//
// 判定顺序（命中即返回原因，与合同 archive/console-archive-rules-contract.md 一致）：
// 扩展名白名单 → 扩展名黑名单 → 文件名必需关键词 → 文件名排除关键词 → 体积下限/上限 → 发送者名单。
// 「每小时上限」依赖台账计数，属于 IO，留在 runtime 里查，不放进本文件。

import { ARCHIVE_EXTENSIONS, IMAGE_EXTENSIONS, MAX_FILE_MB, extensionOf, normalizeIdList } from './common.js';

// 默认白名单 = 改造前 shouldArchiveAttachment 认可的全部类型（压缩包 + 图片）。
// 这里从 common.js 派生而不是重新抄一份：那两个常量是转存逻辑的唯一事实来源，
// 复制一份迟早会漂移（比如以后加了 webp）。
export const ARCHIVE_RULE_EXTENSIONS = Object.freeze([...ARCHIVE_EXTENSIONS, ...IMAGE_EXTENSIONS]);

// 默认规则必须与「用户没配 rules」时的老行为一模一样：
// 压缩包 + 图片全收、不设关键词、不限体积下限、体积上限沿用老 maxFileMb（2560）、不限发送者、不限频率。
export const DEFAULT_ARCHIVE_RULES = Object.freeze({
  extensions: ARCHIVE_RULE_EXTENSIONS,
  excludeExtensions: Object.freeze([]),
  minKb: 0,
  maxMb: MAX_FILE_MB,
  includeKeywords: Object.freeze([]),
  excludeKeywords: Object.freeze([]),
  senderMode: 'any',
  senders: Object.freeze([]),
  perHourMax: 0
});

const EXT_RE = /^[a-z0-9]{1,12}$/;
const SENDER_MODES = ['any', 'include', 'exclude'];

function normalizeExt(value) {
  // 扩展名统一成「小写、无前导点」：用户手填 .ZIP / ZIP 都应该等价，否则匹配不上会很困惑。
  const ext = String(value ?? '').trim().toLowerCase().replace(/^\./, '');
  return EXT_RE.test(ext) ? ext : '';
}

function normalizeExtList(value) {
  // 非数组一律当「没配」处理（回落默认）；是数组但元素全非法时保留空数组 =
  // fail-closed（什么都不转），这比悄悄放行安全。
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    const ext = normalizeExt(item);
    if (ext && !out.includes(ext)) out.push(ext);
  }
  return out;
}

function normalizeKeywordList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const word = String(item ?? '').trim();
    if (word && !out.includes(word)) out.push(word);
  }
  return out;
}

function nonNegativeInt(value, fallback) {
  // 类型错/NaN/负数都算「没配」：配置是用户手改的，绝不能因为一个笔误让桥接启动即崩。
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Math.round(num);
}

/**
 * 把配置里可能是任意形状的 `fileArchive.rules` 收敛成固定结构。
 * 幂等：normalizeArchiveRules(normalizeArchiveRules(x)) 与 normalizeArchiveRules(x) 结果相同。
 */
export function normalizeArchiveRules(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const extList = normalizeExtList(src.extensions);
  const excludeList = normalizeExtList(src.excludeExtensions);
  const maxMb = nonNegativeInt(src.maxMb, DEFAULT_ARCHIVE_RULES.maxMb) || DEFAULT_ARCHIVE_RULES.maxMb;
  const senderMode = SENDER_MODES.includes(src.senderMode) ? src.senderMode : 'any';
  return {
    // 缺省 extensions → 默认白名单；显式给空数组 → 空（谁都不收），不能悄悄填回默认。
    extensions: extList === null ? [...ARCHIVE_RULE_EXTENSIONS] : extList,
    excludeExtensions: excludeList === null ? [] : excludeList,
    minKb: nonNegativeInt(src.minKb, 0),
    // 上限夹到 MAX_FILE_MB：比它更大的文件下载/落盘本身就不现实，放行只会白下载一遍再失败。
    maxMb: Math.min(MAX_FILE_MB, Math.max(1, maxMb)),
    includeKeywords: normalizeKeywordList(src.includeKeywords),
    excludeKeywords: normalizeKeywordList(src.excludeKeywords),
    senderMode,
    senders: Array.isArray(src.senders) ? normalizeIdList(src.senders) : [],
    perHourMax: nonNegativeInt(src.perHourMax, 0)
  };
}

function sampleExtensions(list, max) {
  return list.slice(0, max).map((ext) => `.${ext}`).join('/');
}

/**
 * 按规则判定一个附件要不要转存。返回 { ok, reason }，reason 是给日志/用户看的中文原因。
 * 注意：调用方传入的 rules 可以是原始配置，本函数会先 normalize（幂等，别担心性能）。
 */
export function matchArchiveRules(rules, options = {}) {
  const r = normalizeArchiveRules(rules);
  const fileName = String(options?.fileName ?? '');
  const ext = extensionOf(fileName);
  const lowerName = fileName.toLowerCase();
  const bytes = Number(options?.bytes);
  const senderId = String(options?.senderId ?? '').trim();

  if (!ext) {
    // 没扩展名无法判定类型；合同要求 fail-closed。群文件/聊天文件都有名字，
    // 唯一可能走到这里的是「图片段没带文件名」，那由 archiveGate 补成 .png 再进来。
    return { ok: false, reason: '类型不在转存白名单（无扩展名）' };
  }
  if (!r.extensions.includes(ext)) {
    return { ok: false, reason: `类型不在转存白名单（.${ext}）` };
  }
  if (r.excludeExtensions.includes(ext)) {
    return { ok: false, reason: `扩展名在黑名单（.${ext}）` };
  }
  if (r.includeKeywords.length > 0) {
    const hit = r.includeKeywords.some((word) => lowerName.includes(word.toLowerCase()));
    if (!hit) return { ok: false, reason: '文件名不含必需关键词' };
  }
  if (r.excludeKeywords.length > 0) {
    const hit = r.excludeKeywords.find((word) => lowerName.includes(word.toLowerCase()));
    if (hit) return { ok: false, reason: `文件名含排除关键词「${hit}」` };
  }
  // 体积未知（图片段拿不到 size）时不拦：宁可多存一张，也不要因为缺字段把正常图片拒掉。
  if (Number.isFinite(bytes) && bytes >= 0) {
    if (r.minKb > 0 && bytes < r.minKb * 1024) {
      return { ok: false, reason: `文件小于 ${r.minKb} KB` };
    }
    if (bytes > r.maxMb * 1024 * 1024) {
      return { ok: false, reason: `文件超过 ${r.maxMb} MB` };
    }
  }
  // senderId 缺失（旧调用方/图片段）按「不限」放行，避免把名单规则误伤到拿不到发送者的路径。
  if (senderId && r.senderMode === 'include' && !r.senders.includes(senderId)) {
    return { ok: false, reason: '发送者不在允许名单' };
  }
  if (senderId && r.senderMode === 'exclude' && r.senders.includes(senderId)) {
    return { ok: false, reason: '发送者在排除名单' };
  }
  return { ok: true, reason: '' };
}

/**
 * 一句话中文口径，给控制台展示和模型提示词共用。
 * 不带句号结尾，方便调用方自己接标点。
 */
export function describeArchiveRules(input) {
  const r = normalizeArchiveRules(input);
  const parts = [];
  if (r.extensions.length === 0) {
    parts.push('不转存任何类型（扩展名白名单为空）');
  } else if (
    r.extensions.length === ARCHIVE_RULE_EXTENSIONS.length &&
    ARCHIVE_RULE_EXTENSIONS.every((ext) => r.extensions.includes(ext))
  ) {
    parts.push(`只收 ${sampleExtensions(ARCHIVE_RULE_EXTENSIONS, 4)} 等 ${ARCHIVE_RULE_EXTENSIONS.length} 类压缩包与图片`);
  } else {
    const shown = r.extensions.length > 4 ? sampleExtensions(r.extensions, 4) : r.extensions.map((ext) => `.${ext}`).join('/');
    parts.push(`只收 ${shown}${r.extensions.length > 4 ? ` 等 ${r.extensions.length} 类` : ''}`);
  }
  if (r.excludeExtensions.length > 0) parts.push(`不收 ${sampleExtensions(r.excludeExtensions, 4)}`);
  if (r.includeKeywords.length > 0) parts.push(`文件名需含${r.includeKeywords.map((word) => `「${word}」`).join('或')}`);
  if (r.excludeKeywords.length > 0) parts.push(`排除${r.excludeKeywords.map((word) => `「${word}」`).join('或')}`);
  const sizeBits = [];
  if (r.minKb > 0) sizeBits.push(`不小于 ${r.minKb} KB`);
  if (r.maxMb !== DEFAULT_ARCHIVE_RULES.maxMb) sizeBits.push(`不超过 ${r.maxMb} MB`);
  if (sizeBits.length > 0) parts.push(`文件体积${sizeBits.join('、')}`);
  if (r.senderMode === 'include' && r.senders.length > 0) parts.push(`只转存 ${r.senders.length} 位指定发送者的文件`);
  if (r.senderMode === 'exclude' && r.senders.length > 0) parts.push(`排除 ${r.senders.length} 位发送者`);
  if (r.perHourMax > 0) parts.push(`每群每小时最多 ${r.perHourMax} 个`);
  return parts.join('；');
}
