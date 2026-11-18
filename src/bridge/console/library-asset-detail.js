// src/bridge/console/library-asset-detail.js — 单件素材详情（GET /api/library/asset?key=…）。
//
// 为什么单独一个模块：素材卡在列表里只带「数字统计」（files 是件数、previews 是封面），
// 点开详情要的是**事实本身**——目录里到底有哪些文件、多大、哪个是主包、绑定/资料/工程使用/
// 回收站各是什么状态。这些都要真读盘，逻辑放 library-view 里会把那个文件顶破 800 行。
//
// 硬约束：
// - 列目录**只在这件素材自己的目录内**递归（深度 ≤3、最多 50 条），每个 rel 都过
//   deps.safeResolveInside，绝不越出档案根；符号链接/读不动的条目直接跳过，不 500。
// - 只读：不写任何 state、不改磁盘；agent 令牌一律 403。
// - 合并卡：主成员 + 各成员目录的文件都列出来，非主成员的文件带 fromDir 区分。

import { normalizeBindTable } from '../../library-binds.js';
import { scrubLocalPaths } from '../../library-fs-error.js';

const DETAIL_MAX_FILES = 50;
const DETAIL_MAX_DEPTH = 3;
const DETAIL_KEY_MAX = 200;
const DETAIL_USAGE_FILE = 'booth-usage.json';
const DETAIL_TRASH_FILE = 'booth-trash.json';

/** key 是 contentKey：不能为空、不能带空白/控制字符、不能含 `..`（防止被当成路径用）。 */
export function detailKeyOk(key) {
  const text = String(key ?? '');
  if (!text || text.length > DETAIL_KEY_MAX) return false;
  if (/[\s\u0000-\u001f]/.test(text)) return false;
  return !text.includes('..');
}

function readJsonState(deps, fileName, fallback) {
  const stateDir = String(deps.STATE_DIR || '').trim();
  if (!stateDir) return fallback;
  try {
    const raw = JSON.parse(deps.fs.readFileSync(deps.path.join(stateDir, fileName), 'utf8'));
    return raw && typeof raw === 'object' ? raw : fallback;
  } catch {
    return fallback;
  }
}

function extOfName(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return match ? `.${match[1].toLowerCase()}` : '';
}

function trimSlash(dir) {
  return String(dir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * 列一个目录下的文件（递归，深度 ≤DETAIL_MAX_DEPTH，总量受 budget.left 限制）。
 * 返回 [{rel,name,size,ext,isMain,fromDir?}]；任何越界/读不动的条目跳过。
 */
function listFilesUnder(deps, rootDir, dirRel, options) {
  const { mainName = '', memberMainName = '', fromDir = '', budget } = options;
  const out = [];
  const baseRel = trimSlash(dirRel);
  let baseAbs = '';
  try { baseAbs = deps.safeResolveInside(rootDir, baseRel || '.'); } catch { return out; }
  let baseStat = null;
  try { baseStat = deps.fs.statSync(baseAbs); } catch { return out; }
  if (!baseStat.isDirectory()) return out;

  const stack = [{ abs: baseAbs, rel: baseRel, depth: 0 }];
  while (stack.length && budget.left > 0) {
    const current = stack.shift();
    let entries = [];
    try { entries = deps.fs.readdirSync(current.abs, { withFileTypes: true }); } catch { continue; }
    // 目录先按名字排序，保证两次请求的 files 顺序一致（前端 diff 不会乱跳）。
    entries.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
    for (const entry of entries) {
      if (budget.left <= 0) break;
      const isDir = typeof entry.isDirectory === 'function' ? entry.isDirectory() : false;
      const isFile = typeof entry.isFile === 'function' ? entry.isFile() : false;
      const childRel = current.rel ? `${current.rel}/${entry.name}` : String(entry.name);
      if (isDir) {
        if (current.depth + 1 <= DETAIL_MAX_DEPTH) {
          let childAbs = '';
          try { childAbs = deps.safeResolveInside(rootDir, childRel); } catch { continue; }
          stack.push({ abs: childAbs, rel: childRel, depth: current.depth + 1 });
        }
        continue;
      }
      if (!isFile) continue; // 符号链接/设备文件等一律忽略
      let abs = '';
      try { abs = deps.safeResolveInside(rootDir, childRel); } catch { continue; }
      let stat = null;
      try { stat = deps.fs.statSync(abs); } catch { continue; }
      if (!stat.isFile()) continue;
      const name = String(entry.name);
      const item = {
        rel: childRel,
        name,
        size: Math.max(0, Math.trunc(Number(stat.size) || 0)),
        ext: extOfName(name),
        isMain: Boolean(mainName) && current.rel === baseRel && name === mainName
      };
      // 合并成员的主包不叫 isMain（isMain 只属于这件素材自己的主包），单独标出来，
      // 前端可以区分「主包 / 成员主包 / 普通文件」三档。
      if (memberMainName && current.rel === baseRel && name === memberMainName) item.isMemberMain = true;
      if (fromDir) item.fromDir = fromDir;
      out.push(item);
      budget.left -= 1;
    }
  }
  return out;
}

/** 绑定表里这件素材的条目（含合并成员兜底）。 */
function detailBind(deps, card) {
  const table = normalizeBindTable(readJsonState(deps, 'booth-binds.json', { entries: {} }));
  const keys = [String(card.key || '')];
  for (const member of Array.isArray(card.mergedMembers) ? card.mergedMembers : []) keys.push(String(member?.key || ''));
  for (const key of keys) {
    if (!key) continue;
    const entry = table.entries[key];
    if (!entry) continue;
    return { boothId: entry.boothId, title: entry.title, source: entry.source, at: entry.at };
  }
  return null;
}

/** 工程使用统计：主卡 + 合并成员的项目并集（按 path 去重）。 */
function detailUsage(deps, card) {
  const state = readJsonState(deps, DETAIL_USAGE_FILE, { usage: {} });
  const usage = state.usage && typeof state.usage === 'object' ? state.usage : {};
  const keys = [String(card.key || '')];
  for (const member of Array.isArray(card.mergedMembers) ? card.mergedMembers : []) keys.push(String(member?.key || ''));
  const seen = new Set();
  const projects = [];
  for (const key of keys) {
    const entry = key ? usage[key] : null;
    for (const project of Array.isArray(entry?.projects) ? entry.projects : []) {
      if (!project || typeof project !== 'object') continue;
      const projectPath = String(project.path || '');
      if (projectPath && seen.has(projectPath)) continue;
      if (projectPath) seen.add(projectPath);
      projects.push({
        name: String(project.name || '').slice(0, 200),
        path: projectPath.slice(0, 500),
        evidence: String(project.evidence || '').slice(0, 300),
        at: Number(project.at) || 0
      });
    }
  }
  return projects.length ? { projects } : null;
}

function detailTrashed(deps, key) {
  const state = readJsonState(deps, DETAIL_TRASH_FILE, { items: [] });
  const items = Array.isArray(state.items) ? state.items : [];
  return items.some((item) => item && String(item.key || '') === key);
}

function detailMeta(card) {
  const meta = card?.meta;
  if (!meta || typeof meta !== 'object') return null;
  const price = String(meta.price || '');
  return {
    title: String(meta.title || ''),
    shop: String(meta.shop || ''),
    price,
    priceText: price,
    tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 8).map((tag) => String(tag).slice(0, 40)) : [],
    itemUrl: String(meta.itemUrl || ''),
    category: String(meta.category || '')
  };
}

/**
 * GET /api/library/asset?key=<contentKey>[&fresh=1]
 * getAssets 由 library-view 传进来（含合并/改名/别名/标签的最终视图），保证详情与列表同一份事实。
 */
export async function handleAssetDetailRoute(request, deps, getAssets) {
  const path = String(request.url?.pathname || '');
  if (path !== '/api/library/asset') return false;
  if (request.req.headers['x-agent-token'] || request.req.headers['x-agent-call']) {
    request.sendJson({ ok: false, error: '素材详情只允许管理端查看' }, 403);
    return true;
  }
  if (request.req.method !== 'GET') {
    request.sendJson({ ok: false, error: '该接口只支持 GET' }, 405);
    return true;
  }
  // 只读访客（L6）也能看详情，但本机绝对路径一律不出访客响应：
  // paths 是「在文件夹里看」用的绝对路径，usage 里带用户工程路径，两者对访客置 null。
  const guest = String(request.consoleRole || '') === 'guest';
  const key = String(request.url.searchParams.get('key') || '').trim();
  if (!key) {
    request.sendJson({ ok: false, error: '缺少 key（素材的 contentKey）' }, 400);
    return true;
  }
  if (!detailKeyOk(key)) {
    request.sendJson({ ok: false, error: 'key 不合法（不能带空白/控制字符/..）' }, 400);
    return true;
  }
  try {
    const snapshot = typeof getAssets === 'function' ? await getAssets() : { assets: [] };
    const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : [];
    const card = assets.find((item) => String(item?.key || '') === key) || null;
    if (!card) {
      request.sendJson({ ok: false, error: '这件素材已经不在了（可能刚被移动/改名）' }, 404);
      return true;
    }
    let rootDir = '';
    try { rootDir = String(deps.fileArchiveRootDir() || ''); } catch { rootDir = ''; }
    if (!rootDir) throw new Error('档案根目录未配置');

    const budget = { left: DETAIL_MAX_FILES };
    const dirRel = trimSlash(card.dir);
    const files = listFilesUnder(deps, rootDir, dirRel, { mainName: String(card.mainName || ''), budget });
    // 合并卡：把各成员目录的文件也列出来（标 fromDir），但主成员的文件排在前面。
    const members = Array.isArray(card.mergedMembers) ? card.mergedMembers : [];
    for (const member of members) {
      if (budget.left <= 0) break;
      const memberDir = trimSlash(member?.dir);
      if (!memberDir || memberDir === dirRel) continue;
      const memberFiles = listFilesUnder(deps, rootDir, memberDir, {
        memberMainName: String(member?.mainName || ''),
        fromDir: memberDir,
        budget
      });
      for (const file of memberFiles) files.push({ ...file, fromDir: memberDir });
    }

    const totalBytes = files.length
      ? files.reduce((sum, file) => sum + (Number(file.size) || 0), 0)
      : Math.max(0, Math.trunc(Number(card.bytes) || 0));

    let dirAbs = '';
    let mainAbs = '';
    try { dirAbs = deps.safeResolveInside(rootDir, dirRel || '.'); } catch { dirAbs = ''; }
    try {
      if (card.mainName) mainAbs = deps.safeResolveInside(rootDir, dirRel ? `${dirRel}/${card.mainName}` : String(card.mainName));
    } catch { mainAbs = ''; }

    request.sendJson({
      ok: true,
      asset: {
        key: String(card.key || ''),
        title: String(card.title || ''),
        aliasTitle: String(card.aliasTitle || ''),
        dir: dirRel,
        mainName: String(card.mainName || ''),
        boothId: String(card.boothId || ''),
        renamed: card.renamed === true,
        mergedCount: Math.max(0, Math.trunc(Number(card.mergedCount) || 0)),
        mergedMembers: members,
        files,
        totalBytes,
        previews: Array.isArray(card.previews) ? card.previews : [],
        thumbRel: String(card.thumbRel || ''),
        coverUrl: String(card.coverUrl || ''),
        meta: detailMeta(card),
        archivePassword: String(card.archivePassword || ''),
        rjCode: String(card.rjCode || ''),
        tags: Array.isArray(card.tags) ? card.tags.slice(0, 20).map((tag) => String(tag).slice(0, 40)) : [],
        source: String(card.source || ''),
        sourceText: String(card.sourceText || ''),
        binds: detailBind(deps, card),
        usage: guest ? null : detailUsage(deps, card),
        trashed: detailTrashed(deps, key)
      },
      paths: guest ? null : { dirAbs, mainAbs },
      generatedAt: Date.now()
    });
  } catch (error) {
    // 详情失败的原话可能带绝对路径（stat '…'），统一脱敏；定位靠相对路径与错误码。
    request.sendJson({ ok: false, error: `读取素材详情失败：${scrubLocalPaths(error?.message ?? error)}` }, 500);
  }
  return true;
}
