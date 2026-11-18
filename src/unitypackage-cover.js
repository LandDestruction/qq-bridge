// `.unitypackage` 封面抽取（纯函数，只读内存里的 buffer，不落盘）。
//
// unitypackage 就是一个 ZIP：每个资源是一个 `<guid>/` 目录，里面的 `preview.png` 是 BOOTH 卡片图。
// 素材库补封面的第 4 优先级就是这一层（见 docs/guides/LIBRARY-PRO-UI-V2.md §4/§5）：
// 不把整包解压到磁盘，只在内存里读那一张图。
import {
  ZIP_MAX_ENTRY_BYTES,
  findZipPreviewEntries,
  readZipDirectory,
  readZipEntrySafe
} from './zip-read.js';

/** 这些扩展名才可能是 unitypackage（大小写不敏感；其它包走 zip 封面路径）。 */
export function isUnitypackageName(name) {
  return typeof name === 'string' && name.toLowerCase().endsWith('.unitypackage');
}

function mimeOfName(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

function coverFail(error) {
  return { ok: false, entryName: '', bytes: null, mime: '', error };
}

/**
 * 从 unitypackage（zip）里抠封面：优先 preview.png，其次 thumbnail.png / cover.png。
 * @param {Buffer} buffer
 * @param {{maxBytes?: number}} [options]
 * @returns {{ok:boolean, entryName:string, bytes:Buffer|null, mime:string, error:string}}
 *   失败 error：`not_a_zip` / `zip64_unsupported` / `encrypted` / `no_preview` /
 *   `entry_too_large` / `truncated` / `bad_zip`
 */
export function findUnitypackageCover(buffer, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : ZIP_MAX_ENTRY_BYTES;
  let directory;
  try {
    directory = readZipDirectory(buffer);
  } catch (error) {
    return coverFail('bad_zip');
  }
  if (!directory.ok) return coverFail(directory.error);
  if (directory.encrypted) return coverFail('encrypted');
  const previews = findZipPreviewEntries(directory.entries);
  const entry = previews.find((item) => !item.encrypted);
  if (!entry) return coverFail('no_preview');
  const read = readZipEntrySafe(buffer, entry.name, { maxBytes });
  if (!read.ok) return coverFail(read.error || 'read_failed');
  return {
    ok: true,
    entryName: entry.name,
    bytes: read.bytes,
    mime: mimeOfName(entry.name),
    error: ''
  };
}

/** 把封面抽取结果翻译成一句中文人话（给日志/卡片兜底文案用）。 */
export function describeCoverExtraction(result) {
  if (!result || typeof result !== 'object') return '封面读取失败：结果无效';
  if (result.ok) return '已从包里读出封面';
  switch (result.error) {
    case 'not_a_zip':
      return '这个包不是标准 ZIP';
    case 'zip64_unsupported':
      return '这个包用了 ZIP64，暂时读不了';
    case 'encrypted':
      return '压缩包加密了，读不了里面的封面';
    case 'no_preview':
      return '包里没有 preview.png';
    case 'entry_too_large':
      return '封面图太大，读出来也没用';
    case 'truncated':
      return '压缩包不完整（中央目录缺失）';
    case 'bad_zip':
      return '压缩包坏了，读不出封面';
    default:
      return `封面读取失败：${result.error || '未知原因'}`;
  }
}
