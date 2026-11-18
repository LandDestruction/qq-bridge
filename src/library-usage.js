// 工程使用统计（纯函数层，零 import）。
//
// 干什么：用户配几个「工程根目录」，这里找出根下的 VRChat 工程，扫它们 Assets/ 里
// 引用到的 GUID（`.meta` 的 `guid: <32hex>` 与 `.prefab/.unity/.mat` 正文里的 32 位 hex），
// 再把素材侧 GUID 集合与工程侧 GUID 集合求交 —— 交集非空即「这件素材被这个工程用过」。
//
// 为什么单独一层：真库几万件素材、工程里几万个文本资产，这段会被后台扫描循环反复调用。
// 所以这一层不碰 fs/net，全部依赖注入（io），也不读整包大文件；上限写死在下面常量里，
// 超了只记 truncated，不抛错、不拖死桥接。
//
// 素材侧 GUID 从哪来：`.unitypackage` 是 tar.gz，条目名首段就是 GUID（见 library-usage-guids.js）。
// 拿不到 GUID 的素材（云端卡、还没下载完、包损坏）算 `unknown`，不要谎报 unused。

export const USAGE_MAX_ROOTS = 12;
export const USAGE_PROJECT_DEPTH = 2;
export const USAGE_MAX_FILES_PER_PROJECT = 20000;
export const USAGE_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const USAGE_MAX_GUIDS_PER_ASSET = 600;
export const USAGE_MAX_ROOT_CHARS = 400;

// .meta 要收（`guid:` 在它里面）；其余是 Unity 引用 GUID 的文本资产。
export const USAGE_TEXT_EXTENSIONS = ['.meta', '.prefab', '.unity', '.asset', '.mat', '.controller', '.anim', '.cs'];

// 工程里这些目录不含用户资产，扫了只是白花时间（Library 尤其大）。
export const USAGE_SKIP_DIRS = new Set([
  'node_modules', '.git', 'Library', 'Temp', 'obj', 'Logs', 'Build', 'Builds',
  '.vs', '.idea', 'UserSettings', 'PackageCache', '.s3bak'
]);

const GUID_RE = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i;

/** 单条根目录规整：去引号/空白/尾斜杠，反斜杠统一成 `/`；不是绝对路径就丢掉（返回 ''）。 */
export function normalizeUsageRoot(value, options = {}) {
  if (typeof value !== 'string') return '';
  let text = value.trim().replace(/^["']|["']$/g, '').trim();
  if (!text || text.length > USAGE_MAX_ROOT_CHARS) return '';
  text = text.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!text) return '';
  // 盘符绝对路径 `E:/xxx` 或 UNC `//host/share`
  const absolute = /^[a-zA-Z]:\//.test(text) || /^\/\//.test(text) || (options.posixAbsolute === true && text.startsWith('/'));
  if (!absolute) return '';
  if (!options.keepCase && /^[a-zA-Z]:\//.test(text)) text = text[0].toUpperCase() + text.slice(1);
  return text;
}

/** 数组 / 逗号（或分号、换行）分隔字符串 → 去重保序的绝对路径数组；相对路径与重复项直接丢。 */
export function normalizeUsageRoots(input, options = {}) {
  const list = Array.isArray(input)
    ? input
    : (typeof input === 'string' ? input.split(/[,;\n\r]+/) : []);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const root = normalizeUsageRoot(item, options);
    if (!root) continue;
    const dedupeKey = root.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(root);
    if (out.length >= USAGE_MAX_ROOTS) break;
  }
  return out;
}

/** 一段文本里所有 32 位 hex GUID（小写、去重、保序）；不是 GUID 的 32 位字母数字混排会被正则挡掉。 */
export function collectGuidRefs(text, limit = USAGE_MAX_GUIDS_PER_ASSET) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const seen = new Set();
  const matches = text.match(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi) || [];
  for (const raw of matches) {
    const guid = raw.toLowerCase();
    if (seen.has(guid)) continue;
    seen.add(guid);
    out.push(guid);
    if (out.length >= limit) break;
  }
  return out;
}

/** 文本里是否真有这个 GUID（比 collect 快：命中即返回）。 */
export function hasGuidRef(text, guid) {
  if (typeof text !== 'string' || !guid) return false;
  const needle = String(guid).toLowerCase();
  if (!GUID_RE.test(needle)) return false;
  return text.toLowerCase().includes(needle);
}

function isTextAsset(name, extensions) {
  const lower = String(name || '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return false;
  return extensions.includes(lower.slice(dot));
}

function readUnityVersion(readText, file) {
  try {
    const text = String(readText(file) ?? '').slice(0, 4096);
    const match = /m_EditorVersion:\s*(\S+)/.exec(text);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

/**
 * 在一个根目录下找工程（有 `ProjectSettings/ProjectVersion.txt` 的目录算工程），
 * 再逐个工程扫 Assets/ 下的 GUID 引用。
 * @param {{roots: string[], io: object, depth?: number, maxFiles?: number, maxFileBytes?: number}} input
 * io 需要：readdir(dir) → [{name, isDirectory}], statFile(path) → {size}, readText(path) → string,
 *         join(...), basename(path), exists(path), isDirectory(path)
 * @returns {{projects: object[], errors: object[], scannedAt: number}}
 */
export function scanProjectUsage(input = {}) {
  const io = input.io || {};
  const roots = Array.isArray(input.roots) ? input.roots : [];
  const depthLimit = Number.isInteger(input.depth) && input.depth >= 0 ? input.depth : USAGE_PROJECT_DEPTH;
  const maxFiles = Number.isInteger(input.maxFiles) && input.maxFiles > 0 ? input.maxFiles : USAGE_MAX_FILES_PER_PROJECT;
  const maxFileBytes = Number.isInteger(input.maxFileBytes) && input.maxFileBytes > 0 ? input.maxFileBytes : USAGE_MAX_FILE_BYTES;
  const extensions = Array.isArray(input.extensions) && input.extensions.length ? input.extensions : USAGE_TEXT_EXTENSIONS;
  const projects = [];
  const errors = [];

  const findProjects = (root) => {
    const found = [];
    const visit = (dir, depth) => {
      if (depth > depthLimit) return;
      let entries = [];
      try { entries = io.readdir(dir) || []; } catch (error) {
        errors.push({ root, path: dir, error: `读不了目录：${error?.message ?? error}` });
        return;
      }
      const isProject = entries.some((entry) => entry && entry.isDirectory && entry.name === 'ProjectSettings');
      if (isProject) {
        const versionFile = io.join(dir, 'ProjectSettings', 'ProjectVersion.txt');
        let hasVersion = false;
        try { hasVersion = io.exists(versionFile) === true; } catch { hasVersion = false; }
        if (hasVersion) {
          found.push({ name: io.basename(dir) || dir, path: dir, unityVersion: readUnityVersion(io.readText, versionFile) });
          return;
        }
      }
      for (const entry of entries) {
        if (!entry || !entry.isDirectory) continue;
        if (USAGE_SKIP_DIRS.has(entry.name)) continue;
        visit(io.join(dir, entry.name), depth + 1);
      }
    };
    visit(root, 0);
    return found;
  };

  const scanGuids = (project) => {
    const guids = new Set();
    let files = 0;
    let bytes = 0;
    let truncated = false;
    const visit = (dir) => {
      if (files >= maxFiles) { truncated = true; return; }
      let entries = [];
      try { entries = io.readdir(dir) || []; } catch { return; }
      for (const entry of entries) {
        if (files >= maxFiles) { truncated = true; return; }
        if (!entry) continue;
        if (entry.isDirectory) {
          if (USAGE_SKIP_DIRS.has(entry.name)) continue;
          visit(io.join(dir, entry.name));
          continue;
        }
        if (!isTextAsset(entry.name, extensions)) continue;
        const file = io.join(dir, entry.name);
        let size = 0;
        try { size = Number(io.statFile(file)?.size) || 0; } catch { continue; }
        if (size <= 0 || size > maxFileBytes) continue;
        let text = '';
        try { text = String(io.readText(file) ?? ''); } catch { continue; }
        files += 1;
        bytes += size;
        for (const guid of collectGuidRefs(text, 4000)) guids.add(guid);
      }
    };
    visit(io.join(project.path, 'Assets'));
    return { guids: Array.from(guids), files, bytes, truncated };
  };

  for (const root of roots) {
    let exists = false;
    try { exists = io.exists(root) === true; } catch { exists = false; }
    if (!exists) {
      errors.push({ root, path: root, error: '目录不存在' });
      continue;
    }
    const found = findProjects(root);
    if (!found.length) errors.push({ root, path: root, error: '这个根下没找到 Unity 工程（看 ProjectSettings/ProjectVersion.txt）' });
    for (const project of found) {
      const scanned = scanGuids(project);
      projects.push({
        root,
        project: project.name,
        path: project.path,
        unityVersion: project.unityVersion,
        guids: scanned.guids,
        files: scanned.files,
        bytes: scanned.bytes,
        truncated: scanned.truncated
      });
    }
  }
  return { projects, errors, scannedAt: Number(input.now) || Date.now() };
}

/**
 * 素材 × 工程求交。
 * @param {{assets: Array<{key: string, guids?: string[]}>, projects: object[]}} input
 * @returns {{usage: object, usedIn: object, summary: {withUsage: number, unused: number, unknown: number}}}
 */
export function matchAssetsToProjects(input = {}) {
  const assets = Array.isArray(input.assets) ? input.assets : [];
  const projects = Array.isArray(input.projects) ? input.projects : [];
  // guid → 工程列表：先建反向索引，避免每件素材扫一遍所有工程的 GUID 数组。
  const byGuid = new Map();
  for (const project of projects) {
    const guids = Array.isArray(project?.guids) ? project.guids : [];
    for (const guid of guids) {
      const key = String(guid).toLowerCase();
      let bucket = byGuid.get(key);
      if (!bucket) { bucket = []; byGuid.set(key, bucket); }
      bucket.push(project);
    }
  }
  const usage = {};
  const usedIn = {};
  for (const asset of assets) {
    const key = String(asset?.key || '');
    if (!key) continue;
    const guids = Array.isArray(asset.guids) ? asset.guids : [];
    if (!guids.length) { usage[key] = 'unknown'; usedIn[key] = []; continue; }
    const hits = new Map();
    for (const guid of guids) {
      const bucket = byGuid.get(String(guid).toLowerCase());
      if (!bucket) continue;
      for (const project of bucket) {
        const existing = hits.get(project.path);
        if (existing) existing.refs += 1;
        else hits.set(project.path, { root: project.root, project: project.project, path: project.path, refs: 1 });
      }
    }
    if (!hits.size) { usage[key] = 'unused'; usedIn[key] = []; continue; }
    usage[key] = 'used';
    usedIn[key] = Array.from(hits.values()).sort((left, right) => right.refs - left.refs);
  }
  return { usage, usedIn, summary: summarizeUsage(usage) };
}

/** 汇总行：多少件在用、多少件没用过、多少件拿不到 GUID 判不了。 */
export function summarizeUsage(usage) {
  const out = { withUsage: 0, unused: 0, unknown: 0 };
  if (!usage || typeof usage !== 'object') return out;
  for (const value of Object.values(usage)) {
    if (value === 'used') out.withUsage += 1;
    else if (value === 'unused') out.unused += 1;
    else out.unknown += 1;
  }
  return out;
}

/** 给日志/前端用的一行中文摘要。 */
export function describeUsageSummary(summary, total) {
  const count = Number(total) > 0 ? Number(total) : (summary?.withUsage || 0) + (summary?.unused || 0) + (summary?.unknown || 0);
  const withUsage = Number(summary?.withUsage) || 0;
  const unused = Number(summary?.unused) || 0;
  const unknown = Number(summary?.unknown) || 0;
  const parts = [`共 ${count} 件素材`, `${withUsage} 件被工程引用`];
  if (unused) parts.push(`${unused} 件没用过`);
  if (unknown) parts.push(`${unknown} 件判不了（没有 GUID）`);
  return parts.join('，');
}
