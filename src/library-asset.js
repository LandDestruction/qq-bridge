// src/library-asset.js — 「一件素材」怎么认（BOOTH 素材库 P1）
//
// 纯函数：不读磁盘、不碰数据库、不联网。调用方把「一次目录列举」或「一批台账行」
// 喂进来，这里只负责按规则把文件归成「件」，并从名字/说明/包内文件名里抓 BOOTH 号。
//
// 为什么单独一个模块：识别规则是要反复调的（笔记里有二十来条例外），
// 放在 file-archive.js 那种大文件里改一次要跑一遍门禁；这里可以被单测直接钉住。
// 规则版本改了就把 ASSET_RULES_VERSION +1，台账里据此判断「这行是不是旧规则认的」。

import path from 'node:path';
import { contentKeyFor } from './file-archive/common.js';

/** 识别规则版本号：改本文件的任何判定规则都要 +1。 */
export const ASSET_RULES_VERSION = 2;

/** 算「一件」的主件：压缩包 / Unity 工程 / 单个模型文件。 */
export const ARCHIVE_EXTS = new Set([
  '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst',
  '.unitypackage', '.vrm', '.fbx', '.blend', '.package'
]);

/** 预览图。`.meta.json` / `*.thumbnail.jpg` 是抓取来的元数据与缩略图，不算独立素材。 */
export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.avif', '.tif', '.tiff']);

/** 说明类文件：里面可能写着 BOOTH 链接。 */
export const DOC_EXTS = new Set(['.txt', '.md', '.pdf', '.html', '.htm', '.url', '.rtf', '.doc', '.docx', '.csv']);

// Unity 工程特征：只要目录里出现这些扩展名（或这些子目录名），整棵目录算「一件」，
// 不按压缩包拆 —— 解压开的美术工程本来就是一个商品的全部内容。
const UNITY_MARKER_EXTS = new Set(['.prefab', '.fbx', '.mat', '.meta', '.asset', '.controller', '.anim', '.overridecontroller']);
const UNITY_DIR_NAMES = new Set([
  'texture', 'textures', 'prefab', 'prefabs', 'material', 'materials', 'model', 'models',
  'shader', 'shaders', 'animation', 'animations', 'mesh', 'meshes'
]);

/** 商品号候选来源的优先级（越小越可信）。 */
export const BOOTH_ID_SOURCE_RANK = Object.freeze({
  link: 0,            // 说明文件里写了 booth.pm/items/<号> —— 人写的，最可信
  'name-prefix': 1,   // 文件名/目录名以号打头：`9013048_xxx.zip`
  folder: 2,          // 上层目录名就是号：`<群>/9013048/...`
  'name-bare': 3,     // 名字里任意位置夹着号：`【PB】xxx 9013048.zip`
  inner: 4            // 压缩包内前三层的 readme 里写的
});

/** 取扩展名（小写，含点）。复合扩展 `.tar.gz` 只认最后一个。 */
export function extOf(name) {
  return path.extname(String(name ?? '')).toLowerCase();
}

/** 去掉扩展名。 */
export function stemOf(name) {
  const base = path.basename(String(name ?? ''));
  const ext = extOf(base);
  return ext ? base.slice(0, -ext.length) : base;
}

export function isArchive(name) {
  return ARCHIVE_EXTS.has(extOf(name));
}

export function isImage(name) {
  return IMAGE_EXTS.has(extOf(name));
}

export function isDoc(name) {
  return DOC_EXTS.has(extOf(name));
}

/** `9013048.meta.json` —— 抓取来的商品元数据，跟着素材走但不单独成件。 */
export function isMeta(name) {
  return /\.meta\.json$/i.test(String(name ?? '')) || /^meta\.json$/i.test(String(name ?? ''));
}

/** `9013048.thumbnail.jpg` / `xxx_thumb.png` —— 缩略图，排第一当封面。 */
export function isThumb(name) {
  const stem = stemOf(name).toLowerCase();
  return /(^|[._-])(thumbnail|thumb|cover|预览|封面)$/.test(stem);
}

/** 压缩包内的压缩包目录表里挑 readme（找 BOOTH 号用）。 */
export function pickReadme(names) {
  const list = Array.isArray(names) ? names : [];
  return list.filter((n) => /(^|\/)(readme|read[ _-]?me|说明|はじめに)[^/]*$/i.test(String(n)))
    .filter((n) => String(n).split('/').filter(Boolean).length <= 3)
    // 名字里带号的那个更值得读（`ReadMe_9013048.txt` 比 `readme.txt` 有用）
    .sort((a, b) => (digitsIn(b).length ? 1 : 0) - (digitsIn(a).length ? 1 : 0) || String(a).length - String(b).length)[0] || '';
}

/**
 * 归一化名字用来配对：小写、全角括号转半角、`(1)` 这类浏览器编号去掉、
 * 下划线/连字符/全角空格统一成空格。
 * 例：`9013048_【9アバター対応】♡ ハート.zip` 与 `9013048_1.jpg` 都能配到同一个基名。
 */
export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,6}$/i, '')
    .replace(/[（(]\s*\d{1,2}\s*[)）]\s*$/, '')
    .replace(/[\s_\-—–·.,、，。]+/g, ' ')
    .trim();
}

/** 名字里的 5~8 位数字（BOOTH 号长度），已排除像日期的 8 位/6 位。 */
export function digitsIn(name) {
  const text = String(name ?? '');
  const out = [];
  const re = /(?<!\d)(\d{5,8})(?!\d)/g;
  let m = re.exec(text);
  while (m) {
    if (!looksLikeDate(m[1])) out.push(m[1]);
    m = re.exec(text);
  }
  return out;
}

/** 20261027 / 202610 / 1999 这类明显是日期或年份的，不当商品号。 */
export function looksLikeDate(digits) {
  const d = String(digits ?? '');
  if (/^(19|20)\d{6}$/.test(d)) return true;   // YYYYMMDD
  if (/^(19|20)\d{4}$/.test(d)) return true;   // YYYYMM（6 位）
  return false;
}

/**
 * 抓 BOOTH 号的所有候选。输入可以给名字、目录名、说明文本、压缩包内文件名表。
 * 返回 [{ id, source }]，按可信度从高到低排好，重复号只留最早出现的那条。
 */
export function boothIdCandidates(input = {}) {
  const name = String(input.name ?? '');
  const folderName = String(input.folderName ?? '');
  const text = String(input.text ?? '');
  const innerNames = Array.isArray(input.innerNames) ? input.innerNames : [];
  const found = [];
  const push = (id, source) => {
    const v = String(id ?? '').trim();
    if (!/^\d{5,8}$/.test(v) || looksLikeDate(v)) return;
    if (found.some((c) => c.id === v)) return;
    found.push({ id: v, source });
  };

  // ① 说明文本里的商品链接：booth.pm/ja/items/9013048、booth.pm/items/9013048
  const linkRe = /booth\.pm\/(?:[a-z]{2}\/)?items\/(\d{5,8})/gi;
  let m = linkRe.exec(text);
  while (m) { push(m[1], 'link'); m = linkRe.exec(text); }

  // ② 名字/目录名以号打头，允许 `Booth-` `booth_` 前缀
  const prefixRe = /^(?:booth[-_\s]*)?(\d{5,8})(?!\d)/i;
  const pName = prefixRe.exec(name);
  if (pName) push(pName[1], 'name-prefix');
  const pFolder = prefixRe.exec(folderName);
  if (pFolder) push(pFolder[1], 'folder');

  // ③ 目录名本身就是号
  if (/^\d{5,8}$/.test(folderName.trim())) push(folderName.trim(), 'folder');

  // ④ 名字里任意位置夹着号（`【PB】xxx 9013048.zip`）
  for (const id of digitsIn(name)) push(id, 'name-bare');

  // ⑤ 压缩包里前三层 readme 的路径（readme 里再出现号也能算，由调用方把文本塞进 text）
  for (const id of digitsIn(innerNames.join(' '))) push(id, 'inner');

  return found.sort((a, b) => (BOOTH_ID_SOURCE_RANK[a.source] ?? 9) - (BOOTH_ID_SOURCE_RANK[b.source] ?? 9));
}

/** 拿最可信的那个号；没有就空串。 */
export function pickBoothId(input = {}) {
  const list = boothIdCandidates(input);
  return list.length ? list[0].id : '';
}

/** 名字里的词（用来判「这张图和这个包是不是一件事」）。 */
function tokensOf(name) {
  const norm = normalizeName(name).replace(/[^\p{L}\p{N}]+/gu, ' ');
  return norm.split(' ').filter((t) => t && t.length > 1 && !/^\d+$/.test(t));
}

/** 两张名字的相似度：共有的词数；有同一个 BOOTH 号时直接判满。 */
function nameScore(left, right) {
  const lid = digitsIn(left)[0] || '';
  const rid = digitsIn(right)[0] || '';
  if (lid && rid && lid === rid) return 100;
  const lt = new Set(tokensOf(left));
  const rt = tokensOf(right);
  let score = 0;
  for (const t of rt) if (lt.has(t)) score += 1;
  return score;
}

/** 是否有 Unity 工程特征（扩展名或目录名）。 */
export function looksLikeUnityProject(files) {
  const list = Array.isArray(files) ? files : [];
  return list.some((f) => {
    const name = typeof f === 'string' ? f : String(f?.name ?? f?.relPath ?? '');
    if (UNITY_MARKER_EXTS.has(extOf(name))) return true;
    return String(name).split(/[\\/]+/).some((seg) => UNITY_DIR_NAMES.has(seg.toLowerCase()));
  });
}

/** 一行的展示名：去掉号前缀与多余分隔符，别把「件」叫成一串编号。 */
export function displayTitle(name) {
  let stem = stemOf(name).normalize('NFKC').trim();
  stem = stem.replace(/^(?:booth[-_\s]*)?\d{5,8}[\s_\-—–·.、，,]*/i, '');
  stem = stem.replace(/^[\s_\-—–·.、，,]+/, '');
  return stem || stemOf(name) || String(name ?? '');
}

function toFile(entry) {
  if (typeof entry === 'string') return { name: entry, bytes: 0, relPath: entry };
  const name = String(entry?.name ?? entry?.fileName ?? '');
  return {
    name,
    bytes: Math.max(0, Math.trunc(Number(entry?.bytes ?? entry?.size) || 0)),
    relPath: String(entry?.relPath ?? name),
    mtime: Number(entry?.mtime) || 0
  };
}

/**
 * 只剩缩略图的目录也认成「一件」：`kind:'image-only'`，主件留空。
 * 缩略图（`6985553.thumbnail.png`）永远不能当主件——它只是原包的封面缓存；原包被移走
 * 后把它当主件，件名会变成缩略图名，`markExtractedDirs` 就认不出同层的 `<stem>/` 解压目录了。
 */
function makeImageOnlyAsset(thumb, extra, dir) {
  const files = [thumb, ...extra];
  const previews = [thumb, ...extra.filter((f) => isImage(f.name) && !isMeta(f.name))];
  const docs = extra.filter((f) => isDoc(f.name) && !isMeta(f.name));
  const metas = extra.filter((f) => isMeta(f.name));
  const others = extra.filter((f) => !previews.includes(f) && !docs.includes(f) && !metas.includes(f));
  const booth = boothIdCandidates({
    name: thumb.name,
    folderName: dir,
    text: docs.map((f) => f.name).join(' '),
    innerNames: []
  });
  return {
    kind: 'image-only',
    key: contentKeyFor(thumb.name, thumb.bytes),
    title: thumbDisplayTitle(thumb.name),
    boothId: booth.length ? booth[0].id : '',
    boothSource: booth.length ? booth[0].source : '',
    boothCandidates: booth,
    main: null,
    previews,
    docs,
    metas,
    others,
    files,
    bytes: files.reduce((sum, f) => sum + (Number(f.bytes) || 0), 0),
    rules: ASSET_RULES_VERSION
  };
}

/** `6985553.thumbnail.png` → `6985553`：缩略图的标题别叫「thumbnail」。 */
function thumbDisplayTitle(name) {
  const stem = stemOf(name).replace(/(^|[._-])(thumbnail|thumb|cover|预览|封面)$/i, '');
  return displayTitle(stem || stemOf(name)) || String(name ?? '');
}

function makeAsset(main, extra, dir) {
  const files = [main, ...extra];
  const previews = extra.filter((f) => isImage(f.name) && !isMeta(f.name))
    .sort((a, b) => (isThumb(b.name) ? 1 : 0) - (isThumb(a.name) ? 1 : 0));
  const docs = extra.filter((f) => isDoc(f.name) && !isMeta(f.name));
  const metas = extra.filter((f) => isMeta(f.name));
  const others = extra.filter((f) => !previews.includes(f) && !docs.includes(f) && !metas.includes(f));
  const booth = boothIdCandidates({
    name: main.name,
    folderName: dir,
    text: docs.map((f) => f.name).join(' '),
    innerNames: []
  });
  return {
    kind: isArchive(main.name) ? 'archive' : 'file',
    key: contentKeyFor(main.name, main.bytes),
    title: displayTitle(main.name),
    boothId: booth.length ? booth[0].id : '',
    boothSource: booth.length ? booth[0].source : '',
    boothCandidates: booth,
    main,
    previews,
    docs,
    metas,
    others,
    files,
    bytes: files.reduce((sum, f) => sum + (Number(f.bytes) || 0), 0),
    rules: ASSET_RULES_VERSION
  };
}

/**
 * 把一次目录列举归成「件」。
 *
 * @param {{ files?: Array<string|object>, dir?: string }} input
 *   files：同一层目录下的文件（名字或 {name,bytes,relPath}）。dir：目录名（用来抓号）。
 * @returns {{ assets: object[], loose: object[], kind: string, rules: number }}
 *   assets 是认出来的件（每件含 main/previews/docs/metas/others）；
 *   loose 是没配上任何件的散文件（可能是别人手放进来的图）。
 */
export function buildAssets(input = {}) {
  const files = (Array.isArray(input.files) ? input.files : []).map(toFile).filter((f) => f.name);
  const dir = String(input.dir ?? '');
  const out = { assets: [], loose: [], kind: 'none', rules: ASSET_RULES_VERSION };

  // 解压开的 Unity 工程：整棵目录就是一件，不往下拆
  if (looksLikeUnityProject(files)) {
    out.kind = 'unity';
    const booth = boothIdCandidates({ folderName: dir, text: files.map((f) => f.name).join(' ') });
    out.assets.push({
      kind: 'unity',
      key: contentKeyFor(dir || 'unity-project', files.reduce((s, f) => s + f.bytes, 0)),
      title: displayTitle(dir || 'Unity 工程'),
      boothId: booth.length ? booth[0].id : '',
      boothSource: booth.length ? booth[0].source : '',
      boothCandidates: booth,
      main: files.slice().sort((a, b) => b.bytes - a.bytes)[0] || null,
      previews: files.filter((f) => isImage(f.name)),
      docs: files.filter((f) => isDoc(f.name) && !isMeta(f.name)),
      metas: files.filter((f) => isMeta(f.name)),
      others: [],
      files,
      bytes: files.reduce((s, f) => s + f.bytes, 0),
      rules: ASSET_RULES_VERSION
    });
    return out;
  }

  const archives = files.filter((f) => isArchive(f.name));
  const attachments = files.filter((f) => !isArchive(f.name));
  if (!archives.length) {
    // 没有压缩包：单张图/单个模型文件也算「一件」（.vrm/.fbx 在 ARCHIVE_EXTS 里，走上面）
    const images = attachments.filter((f) => isImage(f.name) && !isMeta(f.name));
    // 主件判定优先「同名压缩包 > 其它」，缩略图永远不当主件（见 makeImageOnlyAsset 注释）。
    const realImages = images.filter((f) => !isThumb(f.name));
    if (realImages.length === 1 && attachments.length <= 3) {
      out.kind = 'image';
      out.assets.push(makeAsset(realImages[0], attachments.filter((f) => f !== realImages[0]), dir));
      return out;
    }
    if (!realImages.length && images.length === 1 && attachments.length <= 3) {
      out.kind = 'image-only';
      out.assets.push(makeImageOnlyAsset(images[0], attachments.filter((f) => f !== images[0]), dir));
      return out;
    }
    out.kind = 'none';
    out.loose = attachments;
    return out;
  }

  out.kind = archives.length === 1 ? 'single' : 'multi';
  const used = new Set();
  for (const archive of archives) {
    const extra = archives.length === 1
      ? attachments.filter((f) => !used.has(f.relPath))
      : [];
    const asset = makeAsset(archive, extra, dir);
    if (extra.length) extra.forEach((f) => used.add(f.relPath));
    out.assets.push(asset);
  }

  // 多个包时：图/说明/元数据按名字相似度配给最像的那一件，配不上就留成散文件
  if (archives.length > 1) {
    for (const file of attachments) {
      if (used.has(file.relPath)) continue;
      let best = null;
      let bestScore = 0;
      for (const asset of out.assets) {
        const score = nameScore(asset.main.name, file.name);
        if (score > bestScore) { best = asset; bestScore = score; }
      }
      if (!best) { out.loose.push(file); continue; }
      if (isImage(file.name) && !isMeta(file.name)) best.previews.push(file);
      else if (isMeta(file.name)) best.metas.push(file);
      else if (isDoc(file.name)) best.docs.push(file);
      else best.others.push(file);
      best.files.push(file);
      best.bytes += file.bytes;
    }
    for (const asset of out.assets) {
      asset.previews.sort((a, b) => (isThumb(b.name) ? 1 : 0) - (isThumb(a.name) ? 1 : 0));
    }
  }
  return out;
}

/**
 * 把台账行（id/rel_path/bytes/booth_id）挂到认出来的件上：
 * 磁盘扫出来的件可能台账里没有（手工放进来的），台账里也可能有盘上已经没有的。
 * 这里只做匹配与对账结果，不写库。
 */
export function reconcileWithLedger(assets, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const keyOf = (row) => String(row?.content_key ?? row?.contentKey ?? '');
  const byKey = new Map();
  for (const row of list) {
    const key = keyOf(row);
    if (key && !byKey.has(key)) byKey.set(key, row);
  }
  const seen = new Set();
  const matched = [];
  for (const asset of Array.isArray(assets) ? assets : []) {
    // 一件可能对应台账多行（包 + 预览图 + 说明各一行），所以件里任一文件命中都算对上，
    // 只用主件的 contentKey 去比会把「挂在件里的预览图」误报成「盘上没了」。
    const fileKeys = (asset.files || []).map((f) => contentKeyFor(f.name, f.bytes));
    const row = byKey.get(asset.key) || fileKeys.map((k) => byKey.get(k)).find(Boolean) || null;
    for (const key of fileKeys) seen.add(key);
    seen.add(asset.key);
    if (row) seen.add(keyOf(row));
    matched.push({
      key: asset.key,
      title: asset.title,
      boothId: String(row?.booth_id ?? row?.boothId ?? asset.boothId ?? ''),
      inLedger: Boolean(row),
      rowId: row?.id ?? null,
      rows: fileKeys.map((k) => byKey.get(k)).filter(Boolean).map((r) => r.id),
      asset
    });
  }
  return {
    items: matched,
    notInLedger: matched.filter((x) => !x.inLedger),
    missingOnDisk: list.filter((r) => !seen.has(keyOf(r)))
  };
}

/** 一句话总结（控制台/日志用）。
 *  口径（2026-10-30 拍板 B）：这里数的是**扫盘视图的原始数**——未合并、未改名、未套人工绑定。
 *  对外响应（/api/library/assets、对账）里的 summary 以 `recountAssetSummary` 按最终视图覆盖后的值为准；
 *  扫盘侧不引入合并表，保持无状态纯扫描。两边别互相"顺手补一下"，否则口径会再分叉。 */
export function summarizeAssets(result) {
  const assets = Array.isArray(result?.assets) ? result.assets : [];
  const loose = Array.isArray(result?.loose) ? result.loose : [];
  return {
    kind: result?.kind || 'none',
    assets: assets.length,
    files: assets.reduce((s, a) => s + a.files.length, 0),
    bytes: assets.reduce((s, a) => s + a.bytes, 0),
    withBooth: assets.filter((a) => a.boothId).length,
    withPreview: assets.filter((a) => a.previews.length).length,
    loose: loose.length
  };
}
