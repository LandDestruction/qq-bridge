// 从素材自己的压缩包里读「文本线索」：BOOTH 号 / 商品标题 / 解压密码。
//
// 为什么需要：真机 32 件素材里有 20 件没认到 BOOTH 号，人工一个个开包看 readme 才知道号是多少；
// 而作者几乎都会在包里塞 `readme.txt` / `説明.txt` / `*.url`，里面写着商品链接和解压密码。
// 这里只做「读出来的候选」，**不绑定、不改任何状态**——认号仍然是人的决定（认错了比没认更糟）。
//
// 边界：
// - 只扫文本类条目（txt/md/nfo/url/html/json 等）与条目名本身；二进制条目不读、不猜。
// - 编码只试 UTF-8 与 CP932（日本作者常用 Shift_JIS）；不可打印字符超过 30% 直接丢弃，
//   宁可少认一条，也不把乱码当标题展示出去。
// - 有预算：最多 400 个候选条目、累计读 2MB、单文件 512KB；超了置 `truncated`，不静默截断。
// - 纯内存、不落盘、不联网；任何失败都不抛，统一回中文原因。
import zlib from 'node:zlib';
import { readZipDirectory, readZipEntrySafe } from './zip-read.js';

/** 一次最多看多少个文本候选条目。 */
export const ARCHIVE_INFO_MAX_ENTRIES = 400;
/** 一次最多读多少字节的文本（防止包里塞几百 MB 的 log）。 */
export const ARCHIVE_INFO_MAX_BYTES = 2 * 1024 * 1024;
/** 单个文本文件最多读多少字节（readme 一般几 KB，超过这个多半是无关日志）。 */
export const ARCHIVE_INFO_MAX_ENTRY_BYTES = 512 * 1024;
/** 整个包的上限：再大就先解压再看，别把桥接内存吃满。 */
export const ARCHIVE_INFO_MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

/** 文件名像文本的才读内容（名字本身另外单独扫号）。 */
const TEXT_NAME_RE = /\.(txt|md|markdown|nfo|url|html?|json|ini|yml|yaml|text)$/i;
const README_NAME_RE = /^(readme|read_me|info|information|instructions?|license|お読みください|はじめに|説明|説明書|説明文)/i;

/** booth.pm 商品页：/items/<id>、/ja/items/<id>、/en/items/<id>、/zh-cn/items/<id>。 */
const BOOTH_ITEM_URL_RE = /https?:\/\/(?:[a-z0-9-]+\.)*booth\.pm\/(?:(?:ja|en|zh-cn|zh-tw)\/)?items\/(\d{5,9})/gi;
/** 有些清单/JSON 里是 `item_id=1234567`。 */
const ITEM_ID_ASSIGN_RE = /\bitem_?id["']?\s*[=:]\s*["']?(\d{5,9})/gi;
/** 作者手写「#1234567」或「「#1234567」」。 */
const HASH_TAG_RE = /[「＃#]\s*(\d{5,9})\s*[」]/g;
/** 条目名里常直接写号（`1234567_readme.txt`、`X (6543210).zip`）：只在名字扫描里用裸号（正文里误报太多）。 */
const BARE_ID_RE = /(?<!\d)(\d{7,9})(?!\d)/g;
/** <title>xxx</title>。 */
const HTML_TITLE_RE = /<title[^>]*>([\s\S]{1,200}?)<\/title>/i;
/** 「商品名: xxx」「タイトル：xxx」。 */
const TITLE_LINE_RE = /(?:商品名|タイトル|作品名|title|name)\s*[:：]\s*(.{1,120})/i;
/** 解压密码的常见写法（日文/中文/英文），同一行 40 字以内。 */
const PASSWORD_LINE_RE = /(?:パスワード|ぱすわーど|解凍パス(?:ワード)?|解凍pass|解凍方法|解压密码|解壓密碼|解压缩密码|password|passwd|pass)\s*[:：=＝]\s*([^\s、。,;；|]{1,40})/i;
/** 这些「密码」是占位词，不是密码。 */
const PASSWORD_PLACEHOLDER_RE = /^(?:なし|无|無|不要|没有|n\/a|none|null|-|--)$/i;
/** readme 第一行不像标题时跳过（链接、密码行、分隔线）。 */
const FIRST_LINE_SKIP_RE = /^(?:https?:|www\.|password|passwd|パスワード|解凍|解压|#|\/\/|=+|-+|\*+|\[)/i;

const BOOTH_ID_MAX = 5;
const ITEM_URL_MAX = 3;
const TITLE_MAX = 5;
const PASSWORD_MAX = 8;
const TITLE_CHARS_MAX = 120;
const PASSWORD_CHARS_MAX = 40;
const FIRST_LINE_CHARS_MAX = 120;

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function pushUnique(list, value, max) {
  const text = String(value == null ? '' : value).trim();
  if (!text || list.length >= max) return;
  if (!list.includes(text)) list.push(text);
}

/** 失败结果保持同一形状，调用方不用判断字段是否存在。 */
function infoFail(error, text) {
  return {
    ok: false,
    boothIds: [],
    itemUrls: [],
    titleCandidates: [],
    passwordCandidates: [],
    scanned: [],
    truncated: false,
    bytesScanned: 0,
    error: String(error || ''),
    text: String(text || '')
  };
}

/** 不可打印字符占比（用于丢弃乱码/二进制）。 */
function nonPrintableRatio(text) {
  const chars = Array.from(String(text || ''));
  if (!chars.length) return 1;
  let bad = 0;
  for (const char of chars) {
    const code = char.codePointAt(0);
    if (code === 0xfffd) bad += 1;
    else if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) bad += 1;
  }
  return bad / chars.length;
}

function tryDecode(buffer, label) {
  try {
    const decoder = new TextDecoder(label, { fatal: true });
    const text = decoder.decode(buffer);
    if (!text || nonPrintableRatio(text) > 0.3) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * 解一段文本：先严格 UTF-8，再 CP932（Shift_JIS），最后放宽到「有损 UTF-8 但可打印」。
 * @returns {{text:string, encoding:'utf-8'|'cp932'|'utf-8-lossy'}|null}
 */
export function decodeArchiveText(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  const utf8 = tryDecode(buffer, 'utf-8');
  if (utf8) return { text: utf8, encoding: 'utf-8' };
  const cp932 = tryDecode(buffer, 'shift_jis');
  if (cp932) return { text: cp932, encoding: 'cp932' };
  const lossy = buffer.toString('utf8');
  if (lossy && nonPrintableRatio(lossy) <= 0.3) return { text: lossy, encoding: 'utf-8-lossy' };
  return null;
}

/** 条目名像不像文本文件（内容要不要读）。 */
export function isTextEntryName(name) {
  const base = String(name || '').split('/').pop() || '';
  if (!base || base.startsWith('._')) return false;
  return TEXT_NAME_RE.test(base) || README_NAME_RE.test(base);
}

/** 从一段文本里找 BOOTH 号（按出现顺序去重）。 */
export function extractBoothIds(text) {
  const source = String(text || '');
  const found = [];
  BOOTH_ITEM_URL_RE.lastIndex = 0;
  let match = BOOTH_ITEM_URL_RE.exec(source);
  while (match && found.length < BOOTH_ID_MAX) {
    pushUnique(found, match[1], BOOTH_ID_MAX);
    match = BOOTH_ITEM_URL_RE.exec(source);
  }
  ITEM_ID_ASSIGN_RE.lastIndex = 0;
  match = ITEM_ID_ASSIGN_RE.exec(source);
  while (match && found.length < BOOTH_ID_MAX) {
    pushUnique(found, match[1], BOOTH_ID_MAX);
    match = ITEM_ID_ASSIGN_RE.exec(source);
  }
  HASH_TAG_RE.lastIndex = 0;
  match = HASH_TAG_RE.exec(source);
  while (match && found.length < BOOTH_ID_MAX) {
    pushUnique(found, match[1], BOOTH_ID_MAX);
    match = HASH_TAG_RE.exec(source);
  }
  return found;
}

/** 从一段文本里找完整的 BOOTH 商品链接。 */
export function extractItemUrls(text) {
  const source = String(text || '');
  const found = [];
  BOOTH_ITEM_URL_RE.lastIndex = 0;
  let match = BOOTH_ITEM_URL_RE.exec(source);
  while (match && found.length < ITEM_URL_MAX) {
    pushUnique(found, match[0], ITEM_URL_MAX);
    match = BOOTH_ITEM_URL_RE.exec(source);
  }
  return found;
}

/**
 * 标题候选：<title>、`商品名:` 行、readme 第一行。
 * 只保留「看着像名字」的短行（≤120 字），避免把整段说明当标题。
 */
export function extractTitleCandidates(text) {
  const source = String(text || '');
  const found = [];
  const tag = HTML_TITLE_RE.exec(source);
  if (tag) pushUnique(found, String(tag[1]).replace(/\s+/g, ' ').slice(0, TITLE_CHARS_MAX), TITLE_MAX);
  const lines = source.split(/\r?\n/);
  for (const raw of lines) {
    if (found.length >= TITLE_MAX) break;
    const line = raw.trim();
    if (!line) continue;
    const titled = TITLE_LINE_RE.exec(line);
    if (titled) {
      pushUnique(found, titled[1].trim().slice(0, TITLE_CHARS_MAX), TITLE_MAX);
      continue;
    }
    // 只看第一行像标题的情况，别把正文段落全塞进来。
    if (found.length === 0 && line.length >= 2 && line.length <= FIRST_LINE_CHARS_MAX && !FIRST_LINE_SKIP_RE.test(line)) {
      pushUnique(found, line.slice(0, TITLE_CHARS_MAX), 1);
    }
  }
  return found;
}

/** 解压密码候选：日文/中文/英文写法，同一行 40 字以内；占位词过滤掉。 */
export function extractPasswords(text) {
  const source = String(text || '');
  const found = [];
  for (const raw of source.split(/\r?\n/)) {
    if (found.length >= PASSWORD_MAX) break;
    const line = raw.trim();
    if (!line || line.length > 200) continue;
    const match = PASSWORD_LINE_RE.exec(line);
    if (!match) continue;
    const value = String(match[1] || '').trim().replace(/[）)】」』"']+$/, '');
    if (!value || PASSWORD_PLACEHOLDER_RE.test(value)) continue;
    pushUnique(found, value.slice(0, PASSWORD_CHARS_MAX), PASSWORD_MAX);
  }
  return found;
}

/**
 * 读一个压缩包里的文本线索。
 * @param {Buffer|string} input Buffer，或「文件路径 + options.readFile」
 * @param {{maxEntries?:number, maxBytes?:number, fileName?:string, readFile?:(path:string)=>Buffer}} [options]
 * @returns {{ok:boolean, boothIds:string[], itemUrls:string[], titleCandidates:string[],
 *   passwordCandidates:string[], scanned:Array<{name:string,bytes:number}>, truncated:boolean,
 *   bytesScanned:number, error:string, text:string}}
 */
/** tar.gz（真 unitypackage 就是这种形状）读取上限：解压后最多看 384MB，防 zip bomb。 */
export const ARCHIVE_INFO_TAR_MAX_BYTES = 384 * 1024 * 1024;

/**
 * 顺序扫 tar 头，收集文本类条目（名字 + 内容切片）。
 * tar 结构：512 字节头（name[100] size[12] typeflag[1] …），数据按 512 对齐；读到全零块结束。
 * 这里只读需要的文本条目，二进制条目只跳过、不进内存。
 */
function readTarEntries(buffer, { maxEntries, maxBytes, maxEntryBytes }) {
  const entries = [];
  let offset = 0;
  let truncated = false;
  let bytesScanned = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    // 全零块 = 归档结束（规范里是两个，坏包常常只有一个）。
    if (header.every((byte) => byte === 0)) break;
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isFinite(size) || size < 0) break;
    const typeflag = String.fromCharCode(header[156] || 48);
    offset += 512;
    const dataStart = offset;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) break;
    // ustar 前缀字段（POSIX 长路径）：name 只有 100 字节，长名要拼 prefix。
    let fullName = name;
    if (header.subarray(257, 262).toString('ascii') === 'ustar') {
      const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
      if (prefix) fullName = `${prefix}/${name}`;
    }
    if (entries.length >= maxEntries) { truncated = true; break; }
    if ((typeflag === '0' || typeflag === '\u0000') && fullName && isTextEntryName(fullName)) {
      if (size > maxEntryBytes || bytesScanned + size > maxBytes) {
        truncated = true;
      } else {
        entries.push({ name: fullName, bytes: buffer.subarray(dataStart, dataEnd) });
        bytesScanned += size;
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return { entries, truncated, bytesScanned };
}

/** 从 tar.gz 里抽文本线索；非 gzip/坏包回 infoFail。 */
function readTarGzInfo(buffer, { maxEntries, maxBytes }) {
  let tar;
  try {
    tar = zlib.gunzipSync(buffer, { maxOutputLength: ARCHIVE_INFO_TAR_MAX_BYTES });
  } catch (error) {
    return infoFail('bad_tar_gz', `tar.gz 解不开：${error?.message ?? error}`);
  }
  const { entries, truncated, bytesScanned } = readTarEntries(tar, {
    maxEntries, maxBytes, maxEntryBytes: ARCHIVE_INFO_MAX_ENTRY_BYTES,
  });
  const boothIds = [];
  const itemUrls = [];
  const titleCandidates = [];
  const passwordCandidates = [];
  const scanned = [];
  for (const entry of entries) {
    for (const id of extractBoothIds(entry.name)) pushUnique(boothIds, id, BOOTH_ID_MAX);
    const decoded = decodeArchiveText(entry.bytes);
    if (!decoded) continue;
    scanned.push({ name: entry.name, bytes: entry.bytes.length });
    for (const id of extractBoothIds(decoded.text)) pushUnique(boothIds, id, BOOTH_ID_MAX);
    for (const url of extractItemUrls(decoded.text)) pushUnique(itemUrls, url, ITEM_URL_MAX);
    for (const title of extractTitleCandidates(decoded.text)) pushUnique(titleCandidates, title, TITLE_MAX);
    for (const password of extractPasswords(decoded.text)) pushUnique(passwordCandidates, password, PASSWORD_MAX);
  }
  const parts = [];
  if (boothIds.length) parts.push(`BOOTH 号 ${boothIds.join('、')}`);
  if (titleCandidates.length) parts.push(`标题候选 ${titleCandidates.length} 条`);
  if (passwordCandidates.length) parts.push('找到解压密码候选');
  return {
    ok: true,
    format: 'tar.gz',
    boothIds,
    itemUrls,
    titleCandidates,
    passwordCandidates,
    scanned,
    truncated,
    bytesScanned,
    error: '',
    text: parts.length ? `包内${parts.join('，')}${truncated ? '（条目太多，只看了前面一部分）' : ''}` : '包内没有找到号/标题/解压密码（只扫文本类条目）'
  };
}

export function readArchiveInfo(input, options = {}) {
  const maxEntries = clampInt(options.maxEntries, ARCHIVE_INFO_MAX_ENTRIES, 1, ARCHIVE_INFO_MAX_ENTRIES);
  const maxBytes = clampInt(options.maxBytes, ARCHIVE_INFO_MAX_BYTES, 1024, ARCHIVE_INFO_MAX_BYTES);
  let buffer = input;
  let fileName = String(options.fileName || '');
  if (typeof input === 'string') {
    if (typeof options.readFile !== 'function') {
      return infoFail('need_read_file', '这个接口只接内存里的包；传路径时请一并给 readFile');
    }
    fileName = fileName || input;
    try {
      buffer = options.readFile(input);
    } catch (error) {
      return infoFail('read_failed', `读不了这个包：${error?.message ?? error}`);
    }
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) return infoFail('not_a_buffer', '包内容为空，读不出信息');
  if (buffer.length > ARCHIVE_INFO_MAX_PACKAGE_BYTES) {
    return infoFail('package_too_large', `包太大（超过 ${Math.round(ARCHIVE_INFO_MAX_PACKAGE_BYTES / 1024 / 1024)}MB），先解压再读包内信息`);
  }

  let directory;
  try {
    directory = readZipDirectory(buffer);
  } catch (error) {
    directory = { ok: false, error: 'bad_zip', text: `压缩包打不开：${error?.message ?? error}` };
  }
  if (!directory.ok) {
    // 真 unitypackage 是 tar.gz（magic 1f 8b），不是坏包：交给 tar 路径读文本。
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      return readTarGzInfo(buffer, { maxEntries, maxBytes });
    }
    const text = directory.error === 'encrypted'
      ? '压缩包加密了，读不了包内文本'
      : '这个包不是普通 zip（.unitypackage 是 tar.gz），暂不扫包内文本';
    return infoFail(directory.error || 'not_a_zip', directory.text || text);
  }

  const boothIds = [];
  const itemUrls = [];
  const titleCandidates = [];
  const passwordCandidates = [];
  const scanned = [];
  let truncated = false;
  let bytesScanned = 0;

  // ① 条目名本身也可能带号（`1234567_readme.txt`、`booth_1234567.url`），先扫一遍名字，便宜。
  let namesSeen = 0;
  for (const entry of directory.entries) {
    if (namesSeen >= maxEntries) { truncated = true; break; }
    namesSeen += 1;
    const name = String(entry?.name || '');
    if (!name) continue;
    for (const id of extractBoothIds(name)) pushUnique(boothIds, id, BOOTH_ID_MAX);
    // 名字里的裸号：BOOTH 号通常是 7 位；文件名里出现基本就是商品号，正文里这么扫会误报。
    BARE_ID_RE.lastIndex = 0;
    let bare = BARE_ID_RE.exec(name);
    while (bare && boothIds.length < BOOTH_ID_MAX) {
      pushUnique(boothIds, bare[1], BOOTH_ID_MAX);
      bare = BARE_ID_RE.exec(name);
    }
  }

  // ② 再按文件名挑文本条目读内容，受条目数/总字节/单文件三重预算。
  let candidates = 0;
  for (const entry of directory.entries) {
    const name = String(entry?.name || '');
    if (!name || entry?.encrypted) continue;
    if (!isTextEntryName(name)) continue;
    if (candidates >= maxEntries) { truncated = true; break; }
    candidates += 1;
    const declared = Number(entry?.size) || 0;
    if (declared > ARCHIVE_INFO_MAX_ENTRY_BYTES) { truncated = true; continue; }
    if (bytesScanned + declared > maxBytes) { truncated = true; continue; }
    const read = readZipEntrySafe(buffer, name, { maxBytes: ARCHIVE_INFO_MAX_ENTRY_BYTES });
    if (!read.ok || !read.bytes?.length) continue;
    bytesScanned += read.bytes.length;
    scanned.push({ name: read.name || name, bytes: read.bytes.length });
    const decoded = decodeArchiveText(read.bytes);
    if (!decoded) continue;
    for (const id of extractBoothIds(decoded.text)) pushUnique(boothIds, id, BOOTH_ID_MAX);
    for (const url of extractItemUrls(decoded.text)) pushUnique(itemUrls, url, ITEM_URL_MAX);
    for (const title of extractTitleCandidates(decoded.text)) pushUnique(titleCandidates, title, TITLE_MAX);
    for (const password of extractPasswords(decoded.text)) pushUnique(passwordCandidates, password, PASSWORD_MAX);
  }

  const parts = [];
  if (boothIds.length) parts.push(`BOOTH 号 ${boothIds.join('、')}`);
  if (titleCandidates.length) parts.push(`标题候选 ${titleCandidates.length} 条`);
  if (passwordCandidates.length) parts.push('找到解压密码候选');
  return {
    ok: true,
    boothIds,
    itemUrls,
    titleCandidates,
    passwordCandidates,
    scanned,
    truncated,
    bytesScanned,
    error: '',
    text: parts.length ? `包内${parts.join('，')}${truncated ? '（条目太多，只看了前面一部分）' : ''}` : '包内没有找到号/标题/解压密码（只扫文本类条目）'
  };
}

/** 一句话描述抽出什么（日志/卡片兜底用，中文）。 */
export function describeArchiveInfo(info) {
  if (!info || typeof info !== 'object') return '包内信息读取失败：结果无效';
  if (!info.ok) return info.text || '包内没有可读的文本信息';
  return info.text || '包内没有找到号/标题/解压密码';
}
