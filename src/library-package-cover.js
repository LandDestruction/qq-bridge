// 从素材自己的压缩包/unitypackage 里抠封面（第 ③ 级来源）。
//
// 为什么单独一个模块：素材库封面优先级是「本地缩略图 → 已购台账 → BOOTH 缓存 → 包内封面 → 商品页抓取」，
// 前三级都是「现成文件」，第四级要读 ZIP 中央目录。读包逻辑在 `src/zip-read.js` / `src/unitypackage-cover.js`，
// 这里只做「选对入口 + 挑哪张图 + 统一错误话术」，好让 VM 模块（library-covers.js 不能 import）通过 deps 注入调用同一份实现。
//
// 边界（2026-10-30 按两轮真机反馈改过，教训写在这里）：
// - **不再拿整包体积当门槛**：真机 `Endless Comfort (Ver1_0_2 Win).zip` 55MB 里其实有样图，旧逻辑「>32MB 不抽」
//   直接把它判死，用户看到的是「找封面不好用」。读包只读中央目录 + 目标条目的本地段，贵的是「解出来的图」，
//   所以限制放在图上：单张解压 ≤ 8MB、一次探测累计 ≤ 40MB；体积只用来拒 >2GB（防坏包/防误传）。
// - **不止 preview.png**：BOOTH 的 zip 经常只带 `assets/xxx.jpg` 这种样图，没有 preview 命名。
//   所以候选分三档：显式 preview 名 > 任意目录的 preview.* > 任意图片（顶层优先、大的优先）。
// - **外层 zip 套 unitypackage 是最常见的形状**（真机 14 件缺失里 6 件整包只有一个 .unitypackage）：
//   直读没有图时，会把内层 .unitypackage 解出来，再用它自己的 `Assets/*/preview.png` 规则找一次。
//   内层包本身不超过 40MB（和探测预算一致），否则回「内层包太大」而不是白读几十 MB。
// - 排除 macOS 副产品（`__MACOSX/`、`._*`、`.DS_Store`）、`thumbs.db`、深度 > 4 的图，以及 <20KB 的小图
//   （图标/水印/表情，拿来当封面会把卡片糊成马赛克）。
// - 只读内存，不落盘、不解压整包、不联网；失败绝不抛，统一回中文原因，调用方写 lastError 后继续下一件。
import zlib from 'node:zlib';
import { describeCoverExtraction, findUnitypackageCover, isUnitypackageName } from './unitypackage-cover.js';
import { ARCHIVE_INFO_MAX_PACKAGE_BYTES, readArchiveInfo } from './library-archive-info.js';
import { ZIP_MAX_ENTRY_BYTES, readZipDirectory, readZipEntrySafe } from './zip-read.js';

/** 整包体积上限：只用来拒「明显不该碰」的包（>2GB），不再按 32MB 判死。 */
export const PACKAGE_COVER_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** 单张图解压上限：一张封面超过 8MB 也没必要抽（和 zip-read 的条目上限对齐）。 */
export const PACKAGE_COVER_MAX_IMAGE_BYTES = ZIP_MAX_ENTRY_BYTES;
/** 一次调用累计探测上限：防止「包里几百张图，挨个解」把 CPU/内存拖死。 */
export const PACKAGE_COVER_PROBE_BUDGET = 40 * 1024 * 1024;
/** 内层 .unitypackage 的大小上限：超过它就不解出来（等于探测预算，别白读几十 MB）。 */
export const PACKAGE_COVER_NESTED_MAX_BYTES = 64 * 1024 * 1024;
/** gunzip 后的上限：unitypackage 是 tar.gz，解压比例高；超过这个就当「读不起」直接放弃，别把桥接吃满内存。 */
export const PACKAGE_COVER_TAR_MAX_BYTES = 384 * 1024 * 1024;
/** 小于这个体积的图不当封面（图标/水印），只对「任意图片」这一档生效。 */
export const PACKAGE_COVER_MIN_IMAGE_BYTES = 20 * 1024;
/** 目录深度上限：包内 demo/资源目录常常很深，太深的图多半是素材中间产物。 */
export const PACKAGE_COVER_MAX_DEPTH = 4;

const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;
const PREVIEW_STEM_RE = /^preview\.(png|jpe?g|webp)$/i;
const SUFFIX_PREVIEW_RE = /_preview\.(png|jpe?g|webp)$/i;
const JUNK_DIR_RE = /(^|\/)__MACOSX\//i;
const JUNK_FILE_RE = /(^|\/)(\.ds_store|thumbs\.db)$/i;

function mimeOfName(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

function baseNameOf(name) {
  const text = String(name || '');
  const cut = text.lastIndexOf('/');
  return cut === -1 ? text : text.slice(cut + 1);
}

function depthOf(name) {
  return String(name || '').split('/').length - 1;
}

function fail(error, text, info = null) {
  return {
    ok: false,
    source: '',
    entryName: '',
    bytes: null,
    mime: '',
    error,
    text: text || '',
    info: info || null,
    probed: { candidates: 0, readBytes: 0, packageBytes: 0, skippedTooLarge: 0 }
  };
}

/**
 * 找不到封面时顺手读一下包内文本线索（readme 里的 BOOTH 号 / 标题 / 解压码）。
 * 为什么放在「封面失败」路径：用户补封面失败时最需要的不是一句「没图」，而是
 * 「这个包大概是哪个商品、解压码是多少」——这正是 `library-archive-info.js` 干的事。
 * 只回摘要（各取前几条），不把整个 scanned 列表塞进 job 日志。
 */
function archiveInfoOfBuffer(buffer, packageBytes) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  if (Number.isFinite(packageBytes) && packageBytes > ARCHIVE_INFO_MAX_PACKAGE_BYTES) return null;
  try {
    const info = readArchiveInfo(buffer);
    if (!info?.ok) return null;
    const summary = {
      boothIds: info.boothIds.slice(0, 5),
      titleCandidates: info.titleCandidates.slice(0, 3),
      passwordCandidates: info.passwordCandidates.slice(0, 3),
      truncated: Boolean(info.truncated)
    };
    if (!summary.boothIds.length && !summary.titleCandidates.length && !summary.passwordCandidates.length) return null;
    return summary;
  } catch {
    return null;
  }
}

function newProbe() {
  return { candidates: 0, readBytes: 0, packageBytes: 0, skippedTooLarge: 0 };
}

/** 垃圾条目：macOS 副产品、系统缩略图缓存。 */
function isJunkEntry(name) {
  const text = String(name || '');
  if (!text) return true;
  if (JUNK_DIR_RE.test(text)) return true;
  if (JUNK_FILE_RE.test(text)) return true;
  return baseNameOf(text).startsWith('._');
}

/**
 * 给包里的图片排序：越靠前越像封面。
 * 分三档（tier 越小越优先）：
 *   1 = 顶层 preview.png/preview.jpg，或任意目录的 `*_preview.*`；
 *   2 = 任意目录的 preview.*；
 *   3 = 其它任意图片（还要按体积/深度挑）。
 * 同档内：顶层优先 → 未压缩体积大的优先 → 名字稳定排序。
 * @param {Array<{name:string,size?:number,encrypted?:boolean}>} entries
 * @returns {Array<{name:string,size:number,tier:number}>}
 */
export function rankPackageImageEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const ranked = [];
  for (const entry of list) {
    const name = String(entry?.name || '');
    if (!name || entry?.encrypted) continue;
    if (isJunkEntry(name)) continue;
    const depth = depthOf(name);
    if (depth > PACKAGE_COVER_MAX_DEPTH) continue;
    const base = baseNameOf(name);
    if (!IMAGE_EXT_RE.test(base)) continue;
    const size = Number(entry?.size) || 0;
    let tier = 0;
    if (depth === 0 && PREVIEW_STEM_RE.test(base)) tier = 1;
    else if (SUFFIX_PREVIEW_RE.test(base)) tier = 1;
    else if (PREVIEW_STEM_RE.test(base)) tier = 2;
    else tier = 3;
    // 「任意图片」这一档要求够大，否则包里一堆小图标会被当封面。
    if (tier === 3 && size < PACKAGE_COVER_MIN_IMAGE_BYTES) continue;
    ranked.push({ name, size, tier });
  }
  ranked.sort((left, right) => {
    if (left.tier !== right.tier) return left.tier - right.tier;
    const depthGap = depthOf(left.name) - depthOf(right.name);
    if (depthGap) return depthGap;
    if (left.size !== right.size) return right.size - left.size;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  return ranked;
}

/** 把 tier 折成「这一档算显式预览图还是兜底大图」。 */
function sourceOfTier(tier) {
  return tier >= 3 ? 'image' : 'preview';
}

/**
 * 在一个已解析的 ZIP 目录里挑一张图读出来（外层与内层 unitypackage 共用）。
 * @returns {{ok:true, source:string, entryName:string, bytes:Buffer, mime:string, text:string}
 *   | {ok:false, error:string, text:string}}
 */
function readBestImageFromDirectory(buffer, directory, { imageLimit, budget, probe }) {
  const ranked = rankPackageImageEntries(directory.entries);
  if (!ranked.length) return { ok: false, error: 'no_preview', text: '包里没有能当封面的图片' };
  let lastError = '';
  for (const candidate of ranked) {
    probe.candidates += 1;
    if (candidate.size > imageLimit) {
      probe.skippedTooLarge += 1;
      lastError = 'entry_too_large';
      continue;
    }
    if (probe.readBytes + candidate.size > budget) {
      return { ok: false, error: 'probe_budget', text: '包里的图太多/太大，探测预算用完，没选出封面' };
    }
    const read = readZipEntrySafe(buffer, candidate.name, { maxBytes: imageLimit });
    if (!read.ok || !read.bytes?.length) {
      lastError = read.error || 'read_failed';
      continue;
    }
    probe.readBytes += read.bytes.length;
    return {
      ok: true,
      source: sourceOfTier(candidate.tier),
      entryName: read.name || candidate.name,
      bytes: read.bytes,
      mime: mimeOfName(candidate.name),
      text: candidate.tier >= 3 ? '已从包里挑出体积最大的一张图当封面' : '已从包里读出预览图'
    };
  }
  return {
    ok: false,
    error: lastError || 'no_preview',
    text: lastError === 'entry_too_large' ? '包里的图片都太大了（单张上限 8MB）' : '包里的图片读不出来（压缩包可能不完整）'
  };
}

/**
 * 真 .unitypackage 是 **tar.gz**（不是 zip）：`<guid>/preview.png` 是卡片图。
 * 为什么这里自己解 tar：`unitypackage-cover.js` 按 zip 解析，遇到 tar.gz 只会回 not_a_zip；
 * 真机 7 件缺失素材全是「外层 zip 里一个 tar.gz unitypackage」，不解开就永远补不上封面。
 * 只在内存里顺序扫 tar 头，找到 preview 就返回，不写盘、不整包解压到磁盘。
 */
function readTarGzCover(buffer, { maxBytes, maxTotalBytes }) {
  let tar = null;
  try {
    tar = zlib.gunzipSync(buffer, { maxOutputLength: maxTotalBytes });
  } catch {
    return { ok: false, error: 'bad_tar_gz', text: '这个 .unitypackage 解不开（tar.gz 损坏或太大）' };
  }
  let offset = 0;
  let fallback = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = header.subarray(0, 100);
    const zero = rawName.indexOf(0);
    const name = rawName.subarray(0, zero === -1 ? rawName.length : zero).toString('utf8').trim();
    if (!name) break;
    const rawSize = header.subarray(124, 136);
    const zeroSize = rawSize.indexOf(0);
    const sizeText = rawSize.subarray(0, zeroSize === -1 ? rawSize.length : zeroSize).toString('ascii').trim();
    const size = Number.parseInt(sizeText, 8) || 0;
    const typeFlag = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const isFile = typeFlag === '0' || typeFlag === '\u0000';
    const base = baseNameOf(name);
    if (isFile && IMAGE_EXT_RE.test(base)) {
      const preview = PREVIEW_STEM_RE.test(base) || SUFFIX_PREVIEW_RE.test(base);
      const candidate = { name, size, preview };
      if (preview || (size >= PACKAGE_COVER_MIN_IMAGE_BYTES && (!fallback || size > fallback.size))) {
        if (preview) {
          if (size > maxBytes) return { ok: false, error: 'entry_too_large', text: 'unitypackage 里的 preview 图太大' };
          return {
            ok: true,
            entryName: name,
            bytes: tar.subarray(dataStart, dataStart + size),
            mime: mimeOfName(name),
            text: '已从 unitypackage（tar.gz）里读出预览图'
          };
        }
        fallback = candidate;
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (fallback && fallback.size <= maxBytes) {
    return {
      ok: true,
      entryName: fallback.name,
      bytes: tar.subarray(512 * 0, 0), // 占位，下面立刻重扫一遍取数据
      mime: mimeOfName(fallback.name),
      text: '',
      needsSecondPass: true
    };
  }
  return { ok: false, error: 'no_preview', text: 'unitypackage 里没有 preview.png' };
}

/** 二次扫描：tar 里没有 preview.* 但有渲染图时，按体积最大的那张取数据。 */
function readTarGzImage(buffer, targetName, { maxBytes, maxTotalBytes }) {
  let tar = null;
  try {
    tar = zlib.gunzipSync(buffer, { maxOutputLength: maxTotalBytes });
  } catch {
    return { ok: false, error: 'bad_tar_gz', text: '这个 .unitypackage 解不开（tar.gz 损坏或太大）' };
  }
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = header.subarray(0, 100);
    const zero = rawName.indexOf(0);
    const name = rawName.subarray(0, zero === -1 ? rawName.length : zero).toString('utf8').trim();
    if (!name) break;
    const rawSize = header.subarray(124, 136);
    const zeroSize = rawSize.indexOf(0);
    const size = Number.parseInt(rawSize.subarray(0, zeroSize === -1 ? rawSize.length : zeroSize).toString('ascii').trim(), 8) || 0;
    const dataStart = offset + 512;
    if (name === targetName) {
      if (size > maxBytes) return { ok: false, error: 'entry_too_large', text: 'unitypackage 里的图太大' };
      return { ok: true, entryName: name, bytes: tar.subarray(dataStart, dataStart + size), mime: mimeOfName(name), text: '已从 unitypackage（tar.gz）里挑出一张图' };
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return { ok: false, error: 'no_preview', text: 'unitypackage 里没有可用的图' };
}

/** 统一入口：先按 zip 形式的 unitypackage 找，再按真机常见的 tar.gz 形式找。 */
function coverFromUnitypackageBuffer(buffer, imageLimit) {
  const zipForm = findUnitypackageCover(buffer, { maxBytes: imageLimit });
  if (zipForm.ok) return { ...zipForm, text: describeCoverExtraction(zipForm) };
  const tarOptions = { maxBytes: imageLimit, maxTotalBytes: PACKAGE_COVER_TAR_MAX_BYTES };
  const tarForm = readTarGzCover(buffer, tarOptions);
  if (tarForm.ok && tarForm.needsSecondPass) {
    const again = readTarGzImage(buffer, tarForm.entryName, tarOptions);
    return again.ok ? again : tarForm;
  }
  if (tarForm.ok) return tarForm;
  // tar.gz 解析已经给出「解不开/太大/没有 preview」时，那才是真原因；
  // 只有它完全没给出有用信息（理论上不会）才退回 zip 形式的 not_a_zip，免得 lastError 误导人。
  if (tarForm.error && tarForm.error !== 'no_preview') return tarForm;
  return tarForm.error === 'no_preview' || !zipForm.ok ? tarForm : zipForm;
}

/** 外层 zip 里可能套着的 .unitypackage：浅的、小的先试，别一上来就解 40MB。 */
function nestedUnitypackagesOf(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list
    .filter((entry) => entry && !entry.encrypted && isUnitypackageName(entry.name))
    .map((entry) => ({ name: entry.name, size: Number(entry.size) || 0, depth: depthOf(entry.name) }))
    .sort((left, right) => left.depth - right.depth || left.size - right.size);
}

/**
 * 从压缩包 buffer 里抠封面。
 * @param {Buffer} buffer
 * @param {{name?:string, maxBytes?:number, packageBytes?:number, maxImageBytes?:number, probeBudget?:number}} [options]
 *   packageBytes：整个包的大小（调用方 stat 得到）；只用于拒 >2GB
 * @returns {{ok:boolean, source:'preview'|'image'|'unitypackage'|'', entryName:string, bytes:Buffer|null,
 *   mime:string, error:string, text:string, probed:{candidates:number, readBytes:number, skippedTooLarge:number}}}
 */
export function extractPackageCoverFromBuffer(buffer, options = {}) {
  const packageBytes = Number(options.packageBytes);
  if (Number.isFinite(packageBytes) && packageBytes > PACKAGE_COVER_MAX_BYTES) {
    return fail('package_too_large', '包太大（超过 2GB），不抽里面的封面');
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) return fail('not_a_zip', '文件读不出来');

  const name = String(options.name || '');
  const imageLimit = Number.isFinite(options.maxImageBytes) && options.maxImageBytes > 0
    ? Math.min(options.maxImageBytes, PACKAGE_COVER_MAX_IMAGE_BYTES)
    : PACKAGE_COVER_MAX_IMAGE_BYTES;
  const budget = Number.isFinite(options.probeBudget) && options.probeBudget > 0
    ? Math.min(options.probeBudget, PACKAGE_COVER_PROBE_BUDGET)
    : PACKAGE_COVER_PROBE_BUDGET;
  const probe = newProbe();

  // ① 主件本身就是 .unitypackage：真 .unitypackage 是 tar.gz，先走它自己的解析（在 zip 目录解析之前，
  //    否则会先被 readZipDirectory 判成 not_a_zip 而永远走不到这一步）。
  let unityFailure = null;
  if (isUnitypackageName(name)) {
    const found = coverFromUnitypackageBuffer(buffer, imageLimit);
    if (found.ok) {
      probe.candidates += 1;
      probe.readBytes += found.bytes?.length || 0;
      return {
        ok: true,
        source: 'unitypackage',
        entryName: found.entryName,
        bytes: found.bytes,
        mime: found.mime || mimeOfName(found.entryName),
        error: '',
        text: found.text || '已从 unitypackage 里读出封面',
        probed: probe
      };
    }
    unityFailure = found;
  }

  // 读目录：中央目录很便宜（zip-read 只扫文件尾 64KB + 目录段）。
  let directory;
  try {
    directory = readZipDirectory(buffer);
  } catch (error) {
    directory = { ok: false, error: 'bad_zip' };
  }
  if (!directory.ok) {
    if (unityFailure) return fail(unityFailure.error || directory.error, unityFailure.text || describeCoverExtraction({ ok: false, error: unityFailure.error }));
    return fail(directory.error, describeCoverExtraction({ ok: false, error: directory.error }));
  }
  if (directory.encrypted) return fail('encrypted', '压缩包加密了，读不了里面的封面');

  const done = (picked, entryPrefix) => ({
    ok: true,
    source: picked.source,
    entryName: entryPrefix ? `${entryPrefix}!/${picked.entryName}` : picked.entryName,
    bytes: picked.bytes,
    mime: picked.mime,
    error: '',
    text: picked.text,
    probed: probe
  });

  // ② 直接在包里挑图（普通 zip 的主路径；unitypackage 走到这里说明它自己没 preview，再按图片兜一层）。
  const directFailure = readBestImageFromDirectory(buffer, directory, { imageLimit, budget, probe });
  if (directFailure.ok) return done(directFailure);

  // ③ 外层 zip 里套 .unitypackage（真机最常见）：解出内层，再用 unitypackage 规则找一次。
  //    内层包一般只有几 MB，preview.png 很小，所以不会把探测预算吃光。
  const nested = nestedUnitypackagesOf(directory.entries);
  let lastError = '';
  for (const inner of nested) {
    if (inner.size > PACKAGE_COVER_NESTED_MAX_BYTES) {
      lastError = 'nested_too_large';
      continue;
    }
    probe.candidates += 1;
    const readInner = readZipEntrySafe(buffer, inner.name, { maxBytes: PACKAGE_COVER_NESTED_MAX_BYTES });
    if (!readInner.ok || !readInner.bytes?.length) {
      lastError = readInner.error || 'read_failed';
      continue;
    }
    // 内层包体积单独记账：探测预算（40MB）是给「解出来的图」的，包本身由 NESTED_MAX 管，
    // 否则一个 60MB 的 unitypackage 会被误判成「预算用完」而永远补不上封面（真机 Aveline Hair 就是这样）。
    probe.packageBytes += readInner.bytes.length;
    const found = coverFromUnitypackageBuffer(readInner.bytes, imageLimit);
    if (found.ok) {
      return done({
        source: 'unitypackage',
        entryName: found.entryName,
        bytes: found.bytes,
        mime: found.mime || mimeOfName(found.entryName),
        text: `已从包内 .unitypackage 读出预览图（${found.text || 'ok'}）`
      }, inner.name);
    }
    lastError = found.error || lastError;
    // 内层 unitypackage 也没有 preview：按普通 zip 规则再挑一次图（有些作者会塞渲染图）。
    const innerDirectory = readZipDirectory(readInner.bytes);
    if (innerDirectory.ok) {
      const picked = readBestImageFromDirectory(readInner.bytes, innerDirectory, { imageLimit, budget, probe });
      if (picked.ok) return done(picked, inner.name);
      lastError = picked.error || lastError;
    } else if (!lastError) {
      // 内层是 tar.gz 时 readZipDirectory 必然 not_a_zip，别拿它覆盖掉「没有 preview」这个真原因。
      lastError = innerDirectory.error || lastError;
    }
  }

  // 失败时顺手读包内文本（readme 里的号/标题/解压码）——用户补封面失败最想知道「这包是哪个商品」。
  const failWithInfo = (error, text) => fail(error, text, archiveInfoOfBuffer(buffer, packageBytes));
  if (lastError === 'nested_too_large') {
    return failWithInfo('nested_too_large', '包里的 .unitypackage 太大（>64MB），不解出来找封面');
  }
  // 直读路径的失败原因更贴切（比如「图片都太大」），只有它没给原因时才用嵌套路径的。
  if (directFailure && !directFailure.ok && directFailure.error !== 'no_preview') {
    return failWithInfo(directFailure.error, directFailure.text);
  }
  return failWithInfo(lastError || 'no_preview', '包里没有能当封面的图片（找过 preview.*、包内 .unitypackage 和包里的图片）');
}

/** 只有这些主件名才值得去包里找封面（zip/unitypackage），其它类型直接跳过、不留错误。 */
export function isPackageCoverCandidate(name) {
  const lower = String(name || '').toLowerCase();
  return lower.endsWith('.zip') || lower.endsWith('.unitypackage');
}

/** 抽取结果的一句话解释（失败时给日志/卡片兜底用，中文）。 */
export function describePackageCover(result) {
  if (!result || typeof result !== 'object') return '封面读取失败：结果无效';
  if (result.ok) return result.text || '已从包里读出封面';
  return result.text || '包里没有能当封面的图片';
}
