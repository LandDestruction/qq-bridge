// src/library-notes.js — 把 BOOTH 资料写回素材自己的下载说明（BOOTH 素材库 P2）
//
// 前任笔记里的规矩：说明文件是素材的一部分，资料要「跟着素材走」，不能只存在我们自己的
// 数据库里 —— 换台机器、NAS 重装、别人接手，打开目录就知道这是哪个商品。
//
// 三条硬约束（都是踩过的坑）：
// 1. **只改自己那一段**：用 HTML 注释当边界，重跑只替换边界内的内容，用户自己写在
//    文件别处的字一个都不动。找不到边界就追加到文件末尾。
// 2. **CRLF**：说明文件是给 Windows 记事本看的，混用 \n 会让整篇变成一行。
// 3. 纯函数、不读盘：调用方把「现有内容」读进来，写回去也由调用方做，方便单测。

export const NOTE_MARKER_BEGIN = '<!-- booth-library:begin -->';
export const NOTE_MARKER_END = '<!-- booth-library:end -->';
export const NOTE_FILE_NAME = '素材说明.md';

const CRLF = '\r\n';

/** 把任意换行统一成 CRLF（先把 \r\n 压成 \n 再加，避免 \r\r\n）。 */
export function toCrlf(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, CRLF);
}

function clean(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * 生成自己的那一段（不含边界外的任何东西）。
 * meta 形如 {title, shop, price, tags, itemUrl, boothId, fetchedAt}
 */
export function renderNoteBlock(meta = {}) {
  const boothId = clean(meta.boothId);
  const title = clean(meta.title) || (boothId ? `BOOTH ${boothId}` : '未命名素材');
  const lines = [];
  lines.push('## BOOTH 资料');
  lines.push('');
  lines.push(`- 标题：${title}`);
  if (clean(meta.shop)) lines.push(`- 店铺：${clean(meta.shop)}`);
  if (clean(meta.price)) lines.push(`- 价格：${clean(meta.price)}`);
  const tags = Array.isArray(meta.tags) ? meta.tags.map(clean).filter(Boolean).slice(0, 12) : [];
  if (tags.length) lines.push(`- 标签：${tags.join('、')}`);
  const url = clean(meta.itemUrl) || (boothId ? `https://booth.pm/zh-cn/items/${boothId}` : '');
  if (url) lines.push(`- 商品页：${url}`);
  if (boothId) lines.push(`- 商品号：${boothId}`);
  const at = Number(meta.fetchedAt) || Date.now();
  const day = new Date(at);
  const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  lines.push(`- 资料更新：${stamp}`);
  return `${NOTE_MARKER_BEGIN}${CRLF}${lines.join(CRLF)}${CRLF}${NOTE_MARKER_END}`;
}

/**
 * 把新段合并进已有说明：
 * - 没有文件内容 → 只放这一段；
 * - 有边界 → 只替换边界之间；
 * - 没有边界 → 原内容后面空一行再追加（绝不动原文）。
 */
export function mergeNoteContent(existing, block) {
  const next = toCrlf(block);
  const current = String(existing ?? '');
  if (!current.trim()) return `${next}${CRLF}`;
  const begin = current.indexOf(NOTE_MARKER_BEGIN);
  const end = current.indexOf(NOTE_MARKER_END);
  if (begin >= 0 && end > begin) {
    const before = current.slice(0, begin);
    const after = current.slice(end + NOTE_MARKER_END.length);
    return `${before}${next}${after}`;
  }
  const sep = current.endsWith(CRLF) ? '' : CRLF;
  return `${current}${sep}${CRLF}${next}${CRLF}`;
}

/** 说明文件里是否已经有我们写的段（前端要能提示「会覆盖上次写的那段」）。 */
export function hasNoteBlock(existing) {
  const text = String(existing ?? '');
  const begin = text.indexOf(NOTE_MARKER_BEGIN);
  const end = text.indexOf(NOTE_MARKER_END);
  return begin >= 0 && end > begin;
}
