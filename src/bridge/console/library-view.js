// src/bridge/console/library-view.js — 文件库里的「看着像什么」那些页：文件夹入口、
// 素材卡（BOOTH 素材库 L2）、抓封面（P2）、把 BOOTH 资料写回素材说明（P2）。
//
// 为什么单拆一个文件：这些路由合起来三百多行，全塞回 file-library.js 会把那个模块顶过
// 800 行的规模闸；而且它们只读盘/只用注入的 deps，和「转存管道」本身没有耦合。
// 纯规则（怎么认一件素材）在 src/library-asset.js，扫盘在 src/library-scan.js，
// 说明文档的合并规则在 src/library-notes.js —— 三个都有单测，这里只做路由与缓存。

import { buildLibrarySnapshot } from '../../library-scan.js';
import { applyBinds, normalizeBindTable } from '../../library-binds.js';
import { normalizeBatchState, suggestionFor } from '../../library-batch.js';
import { normalizeRenameLog } from '../../library-rename.js';
import { withAliases, handleAliasRoutes } from './library-alias-routes.js';
import { applyAssetTags, countAssetTagStats } from './library-tag-views.js';
import { pickAssetsPage, countAssetBuckets, hasBoothNumber, hasCoverImage, applyAssetView, normalizeAssetView, markExtractedDirs } from '../../library-assets-query.js';
// 素材库 v2（文档 §1/§3）：cloud = 已购但本地没下载，trash = 回收站；
// 两类远程卡片的读取/分页在 library-cover.js（本文件贴着 800 行规模闸）。
import { handleLibraryCoverRoute, annotateCoverState, buildRemoteAssetView } from './library-cover.js';
import { annotateLibraryAssets } from './library-annotations.js';
import { handleLibraryFacetsRoute } from './library-facets.js';
import { handleLibraryFavoritesRoute } from './library-favorites.js';
// 手动标签/手动分类：纯规则（台账 + 叠加）由本文件以命名空间传入，路由模块保持零 import。
import * as manualMetaPure from '../../library-manual-meta.js';
import { withManualMeta, handleLibraryManualMetaRoute } from './library-manual-meta.js';
// 筛选/分页/计数已搬到 src/library-assets-query.js（本文件贴着 800 行闸），
// 这里 re-export 保持旧 import 路径可用（既有测试就是从本文件 import 的）。
export { pickAssetsPage, countAssetBuckets } from '../../library-assets-query.js';
import { handleReconcileRoutes } from './library-reconcile-routes.js';
import { handleAssetDetailRoute } from './library-asset-detail.js';
import { handleArchiveInfoRoute } from './library-archive-info.js'; // 包内信息（号/标题/解压码）只读接口
import { duplicateCounts, duplicateKeySet, handleLibraryDuplicatesRoute } from './library-duplicates.js'; // 「清理重复」报告
import { handlePurchaseDetailRoute } from './library-purchase-detail.js'; // 商品详情面板（已购/下载/素材集三份台账）
// 认号可信度（2026-10-30 用户反馈「封面和商品名都没对上」）：只有 verified（已购台账/人工绑定）
// 才许显示商品名、才许拿去抓封面；扫盘按文件名猜出来的号只当「候选」，不能当真。
import {
  annotateBindStatus, countAssetViews, countCloudCards, countTrashCards, handleBindSuggestionRoutes
} from './library-bind-view.js';
import {
  normalizeMergeTable, mergeIdOf, groupOfKey, setMerge, removeMerge,
  mergeTableSummary, proposeMergeGroups, applyMerges
} from '../../library-merge.js';
import { fsErrorText, scrubLocalPaths } from '../../library-fs-error.js';
function libraryRootOf(deps) {
  // 桥接注入的是函数（按 config 现算），不是常量字符串
  const raw = typeof deps.fileArchiveRootDir === 'function' ? deps.fileArchiveRootDir() : deps.fileArchiveRootDir;
  const dir = String(raw || '').trim();
  return dir ? deps.path.resolve(dir) : '';
}

function folderCountAt(deps, abs) {
  let files = 0;
  let bytes = 0;
  try {
    for (const ent of deps.fs.readdirSync(abs, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      files += 1;
      try { bytes += deps.fs.statSync(deps.path.join(abs, ent.name)).size; } catch {}
    }
  } catch {}
  return { files, bytes };
}

function subdirsOf(deps, abs) {
  try {
    return deps.fs.readdirSync(abs, { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => ent.name)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  } catch {
    return [];
  }
}

function listLibraryFolders(deps) {
  const root = libraryRootOf(deps);
  if (!root) return { ok: false, dir: '', error: '转存目录还没配（config.json 的 fileArchive.dir）' };
  if (!deps.fs.existsSync(root)) return { ok: true, dir: root, missing: true, folders: [] };
  const folders = [];
  const rootStat = folderCountAt(deps, root);
  folders.push({ rel: '', name: deps.path.basename(root) || '转存目录', kind: 'root', depth: 0, ...rootStat });
  for (const gid of subdirsOf(deps, root)) {
    const abs = deps.path.join(root, gid);
    folders.push({ rel: gid, name: gid, kind: 'group', depth: 1, ...folderCountAt(deps, abs) });
    for (const cat of subdirsOf(deps, abs)) {
      const cabs = deps.path.join(abs, cat);
      folders.push({ rel: gid + '/' + cat, name: cat, kind: 'category', depth: 2, group: gid, ...folderCountAt(deps, cabs) });
    }
  }
  return { ok: true, dir: root, missing: false, folders, total: folders.length };
}

function openFolderInExplorer(deps, rel) {
  const root = libraryRootOf(deps);
  if (!root) throw new Error('转存目录还没配，打不开');
  const wanted = String(rel ?? '').trim();
  // 空 rel 表示转存根目录本身；其余一律走 safeResolveInside（拒绝 ..、绝对路径、盘符）
  const target = wanted ? (0, deps.safeResolveInside)(root, wanted) : root;
  let st;
  try { st = deps.fs.statSync(target); }
  catch { throw new Error('这个文件夹已经不在了：' + target); }
  if (!st.isDirectory()) throw new Error('这不是文件夹：' + target);
  if (typeof deps.spawn !== 'function') throw new Error('这台机器上打不开资源管理器（spawn 不可用）');
  // detached + unref：explorer 是独立进程，桥接不等着它、也不跟着它退出
  const child = deps.spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false });
  if (child && typeof child.unref === 'function') child.unref();
  (0, deps.log)(`控制台：在资源管理器里打开文件库目录 ${target}`);
  return target;
}

// ── 素材卡（BOOTH 素材库 L2）：GET /api/library/assets + GET /api/files/raw ────────
// 「件」的规则在 src/library-scan.js + src/library-asset.js（纯函数、有单测），这里只做
// 读盘缓存、台账对账和把图片按原字节回给页面。扫一次真实库约 30ms，缓存 20 秒足够：
// 转存是低频动作，20 秒延迟可以接受，换来的是每次进页面不用再走一遍磁盘。
const LIBRARY_ASSETS_TTL_MS = 20000;
let libraryAssetsCache = { at: 0, root: '', data: null };

/**
 * 让人工确认认号之后立刻生效，而不是等 20 秒缓存过期。
 * 只把时间戳置零、不直接清 data：下一次读仍走同一条扫盘+覆盖链路，不会读到半成品。
 */
export function invalidateLibraryAssetsViewCache() {
  libraryAssetsCache = { at: 0, root: '', data: null };
}

function libraryAssetsSnapshot(deps, { fresh = false, fastScan = false } = {}) {
  const root = typeof deps.fileArchiveRootDir === 'function' ? deps.fileArchiveRootDir() : deps.fileArchiveRootDir;
  const rootDir = String(root || '');
  const now = Date.now();
  if (!fresh && libraryAssetsCache.data && libraryAssetsCache.root === rootDir && now - libraryAssetsCache.at < LIBRARY_ASSETS_TTL_MS) {
    return libraryAssetsCache.data;
  }
  let rows = [];
  try {
    const db = (0, deps.fileArchiveDb)();
    if (db) rows = (0, deps.listArchive)(db, { limit: 5000, offset: 0 });
  } catch (error) {
    (0, deps.log)(`素材卡读台账失败（只按盘面统计）：${error?.message ?? error}`);
  }
  const data = (0, deps.buildLibrarySnapshot)({ fs: deps.fs, rootDir, rows, full: fresh, fastScan }); // fresh=1 全量重扫并重写缓存；scan=fast 目录 mtime 未变时连文件 stat 都省掉
  enrichAssetsWithBoothMeta(deps, data);
  libraryAssetsCache = { at: now, root: rootDir, data };
  return data;
}

// 素材卡上的 BOOTH 资料与封面：资料读 `state/booth-cache/<id>.json`（fetchBoothMeta 写的缓存），
// 封面只在**本地已缓存**时给 URL —— 没缓存就让前端显示「抓封面」按钮，别让页面一进来
// 就对十几个商品打 BOOTH（限速 1 秒/次，会卡成一条长队）。
function enrichAssetsWithBoothMeta(deps, data) {
  const assets = Array.isArray(data?.assets) ? data.assets : [];
  if (!assets.length) return data;
  let cacheDir = '';
  try { cacheDir = String((0, deps.boothCacheDir)() || ''); } catch { cacheDir = ''; }
  for (const asset of assets) {
    asset.meta = null;
    asset.coverUrl = '';
    const id = String(asset.boothId || '');
    if (!/^\d{5,9}$/.test(id)) continue;
    if (cacheDir) {
      try {
        const raw = deps.fs.readFileSync(deps.path.join(cacheDir, `${id}.json`), 'utf8');
        const parsed = JSON.parse(raw);
        const meta = parsed && parsed.meta;
        if (meta && meta.status === 'ok') {
          asset.meta = {
            title: String(meta.title || ''),
            shop: String(meta.shop || ''),
            price: String(meta.price || ''),
            tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 8) : [],
            itemUrl: String(meta.itemUrl || ''),
            category: String(meta.category || ''),
            fetchedAt: Number(parsed.fetchedAt) || 0
          };
        }
      } catch { /* 没缓存就留空，卡片上不显示资料 */ }
    }
    try {
      const coverPath = (0, deps.getBoothCoverPath)(id, { cacheRoot: cacheDir });
      if (coverPath) asset.coverUrl = `/api/files/cover/${encodeURIComponent(id)}`;
    } catch { /* 封面缓存坏了就当没有 */ }
  }
  data.withMeta = assets.filter((a) => a.meta).length;
  // 「有封面可看」= 本地缩略图或 BOOTH 缓存图任一存在。之前只数 coverUrl（BOOTH 缓存），
  // 会把 15 件有缩略图的素材算成只有 8 件有封面，仪表盘「缺封面」和文件库页筛选口径对不上。
  data.withCover = assets.filter((a) => Boolean(a.thumbRel) || Boolean(a.coverUrl)).length;
  return data;
}

// 人工绑定（P3 找号）：state/booth-binds.json 里记着「这钱素材就是那个 BOOTH 商品」。
// 每次返回时覆盖到卡片上（不写进缓存，解绑后缓存不用等 20 秒过期）。
function readBindTable(deps) {
  try {
    const p = deps.path.join(String(deps.STATE_DIR), 'booth-binds.json');
    return normalizeBindTable(JSON.parse(deps.fs.readFileSync(p, 'utf8')));
  } catch {
    return normalizeBindTable(null);
  }
}

function readBatchState(deps) {
  try {
    const p = deps.path.join(String(deps.STATE_DIR), 'booth-batchfind.json');
    return normalizeBatchState(JSON.parse(deps.fs.readFileSync(p, 'utf8')));
  } catch {
    return normalizeBatchState(null);
  }
}

function withBinds(deps, data) {
  const table = readBindTable(deps);
  const batch = readBatchState(deps);
  const assets = applyBinds(Array.isArray(data?.assets) ? data.assets : [], table);
  // 批量找号的结果只是「建议」：卡片上带一个 suggestion，人在页面上点一下才真的绑。
  for (const asset of assets) {
    const suggestion = suggestionFor(asset, batch);
    if (suggestion) asset.suggestion = suggestion;
  }
  return {
    ...data,
    assets,
    // 绑定会凭空给「无号」的素材补上号，而 withBooth 是扫盘时算的、不含绑定结果：
    // 不重算就会出现「页面说有号 17、筛 no-booth 却只有 3」这种自相矛盾（筛选胶囊和统计对不上）。
    withBooth: assets.filter((a) => hasBoothNumber(a)).length,
    bound: assets.filter((a) => a.boothSource === 'bind').length,
    suggested: assets.filter((a) => a.suggestion).length
  };
}

// ── 同号合并（L5b）：state/booth-merges.json ────────────────────────────────────
// 合并只是展示层折叠：不动磁盘、不改 contentKey、不碰绑定表与下载台账，
// 所以状态单独存一个文件，拆开就等于把文件删一条记录。
const MERGE_FILE_NAME = 'booth-merges.json';

function mergeFilePath(deps) {
  const stateDir = String(deps.STATE_DIR || '').trim();
  if (!stateDir) return '';
  return deps.path.join(stateDir, MERGE_FILE_NAME);
}

function readMergeTable(deps) {
  const file = mergeFilePath(deps);
  if (!file) return normalizeMergeTable(null);
  try {
    return normalizeMergeTable(JSON.parse(deps.fs.readFileSync(file, 'utf8')));
  } catch {
    return normalizeMergeTable(null);
  }
}

function writeMergeTable(deps, table) {
  const file = mergeFilePath(deps);
  if (!file) throw new Error('STATE_DIR 没配，不能保存合并状态');
  deps.atomicWriteJson(file, normalizeMergeTable(table));
}

function withMerges(deps, data) {
  const applied = applyMerges(Array.isArray(data?.assets) ? data.assets : [], readMergeTable(deps));
  return {
    ...data,
    assets: applied.cards,
    // merged = 被折叠掉（从列表里消失）的卡片数；mergedGroups = 生效的组数。
    merged: applied.mergedAway,
    mergedGroups: applied.groups
  };
}

// ── 改过名的素材（L5）：卡片要显示「已改名」并保住带号前缀的标题 ──────────────
// 改名会换 contentKey：日志里的条目是旧 key，执行时新算的 newKey 才是磁盘上现在的 key。
// 两边都认，才不会出现「刚改完名卡片立刻变回未改名」。
function readRenameLog(deps) {
  try {
    const file = deps.path.join(String(deps.STATE_DIR), 'booth-renames.json');
    return normalizeRenameLog(JSON.parse(deps.fs.readFileSync(file, 'utf8')));
  } catch {
    return normalizeRenameLog(null);
  }
}

function renamedTitleOf(asset) {
  // displayTitle 会把「8844481 Test Rename」的前导号当编号剥成「Test Rename」，
  // 结果卡片反而认不出这是哪件；改名后主件名就是用户确认过的新名字，直接用它。
  const raw = String(asset?.mainName || asset?.file || '').trim();
  const stem = raw.replace(/\.[^.]+$/, '').trim();
  if (stem) return stem;
  const last = String(asset?.dir || '').trim().split('/').filter(Boolean).pop() || '';
  return last.trim();
}

function withRenames(deps, data) {
  const table = readRenameLog(deps);
  const renamedKeys = new Set();
  for (const [contentKey, list] of Object.entries(table.entries)) {
    renamedKeys.add(contentKey);
    for (const entry of list) if (entry.newKey) renamedKeys.add(entry.newKey);
  }
  const assets = (Array.isArray(data?.assets) ? data.assets : []).map((asset) => {
    if (!renamedKeys.has(String(asset?.key ?? ''))) return asset;
    return { ...asset, renamed: true, title: renamedTitleOf(asset) || asset.title };
  });
  return { ...data, assets, renamed: assets.filter((asset) => asset.renamed).length };
}

/** 素材卡的最终视图：扫盘快照 → 人工绑定 → 合并 → 改名 → 别名 → 标签/来源。
 *  对账和素材页必须走同一条链：否则「页面上看到的卡片」和「对账算出来的卡片」会各算一套。 */
/**
 * 顶部那排统计（有号 / 有封面 / 手动绑定 / 待确认建议）必须按**最终视图**算。
 * 以前它们是 withBinds 那一步算的，而合并会把几条卡折叠成一条——于是页面出现
 * 「共 17 件」却写「有号 22 件」这种自相矛盾（验收时抓到的）。
 *
 * 口径分工（2026-10-30 拍板 B）：`src/library-asset.js summarizeAssets` 只给扫盘原始数
 * （未合并/未改名/未套绑定），**summary.assets 由这里按最终视图覆盖**；扫盘侧不承担这段，
 * 也别再往 summarize 里塞合并逻辑（那会让 scan 反过来依赖 merge 表）。
 */
function recountAssetSummary(data) {
  const assets = Array.isArray(data?.assets) ? data.assets : [];
  // 嵌套的 summary.assets 也是扫盘那一步算的（合并前），同样要按最终视图改——
  // 仪表盘「文件库」卡曾经读它，于是合并后写着 23 件、点进去只有 17 件。
  // 下面 withDhash 同理：扫盘算的是合并前的卡数，真机出现过 29 vs 27。
  const summary = data?.summary && typeof data.summary === 'object'
    ? { ...data.summary, assets: assets.length }
    : data?.summary;
  return {
    ...data,
    ...(summary ? { summary } : {}),
    withBooth: assets.filter((a) => hasBoothNumber(a)).length,
    withCover: assets.filter((a) => Boolean(a.thumbRel) || Boolean(a.coverUrl)).length,
    withMeta: assets.filter((a) => a.meta).length,
    withDhash: assets.filter((a) => Boolean(a.dhash)).length,
    bound: assets.filter((a) => a.boothSource === 'bind').length, suggested: assets.filter((a) => a.suggestion).length
  };
}

function libraryAssetsView(deps, { fresh = false, fastScan = false } = {}) {
  const snapshot = libraryAssetsSnapshot(deps, { fresh, fastScan });
  // 合并/改名/别名/标签全部走完之后再数一遍，统计口径才和「共 N 件」一致。
  // 最后两步：annotate 补关系型字段（分类/适配模型/收藏/已购/使用次数/重复号），
  // withManualMeta 再把手动分类/标签压上去——手动解释必须排在规则之后，
  // 否则用户改完分类，facets/筛选还按文件名规则算，左右栏数字会和列表打架。
  const tagged = recountAssetSummary(withManualMeta(deps, annotateLibraryAssets(deps, applyAssetTags(deps, withAliases(deps, withRenames(deps, withMerges(deps, withBinds(deps, snapshot)))))), manualMetaPure));
  // 认号结论（verified/candidate/none）必须排在封面之前：封面链要靠它判断
  // 「这个号是查证过的还是文件名猜的」——猜的号去 BOOTH 抓图会抓到别的商品。
  const bound = annotateBindStatus(deps, tagged);
  // 封面来源（v2 §4）：给每张卡标 coverSource / coverReady，前端据此显示占位图，
  // 不再把所有「没有本地缩略图」的卡一律说成「无预览」——台账/缓存里其实有图。
  const covered = annotateCoverState(deps, bound);
  // 解压产物只在视图层摘掉：父件补 extracted 摘要，子目录默认隐藏、`view=extracted` 才列出来。
  const marked = markExtractedDirs(covered.assets);
  // bindStats 按「摘掉解压产物之后」的最终卡重算：中间统计会把隐藏的那张也算成 candidate（真机 17 vs 16）。
  const bindStats = { verified: marked.assets.filter((a) => a.boothStatus === 'verified').length, candidate: marked.assets.filter((a) => a.boothStatus === 'candidate').length, none: marked.assets.filter((a) => a.boothStatus === 'none').length };
  return { ...covered, assets: marked.assets, bindStats, extractedCards: marked.extracted, extractedCount: marked.extracted.length };
}

/**
 * 访客只读视图：把扫盘根的绝对路径抹掉（`root`，如 `<本机路径>\booth-inbox`）。
 * 管理员保留——前端要用它做相对路径展示。单拎成纯函数是为了能单测「guest 形态 root === null」，
 * 不必起桥接、造整套 deps（真机全量兜底另有 sweep）。
 */
export function assetsRootForRole(root, role) {
  return String(role || '') === 'guest' ? null : root;
}

/**
 * 给旁路模块（补封面等 VM 模块）拿**素材页同一份最终视图**的出口。
 * 这些模块不能 import 本文件，统计口径一旦各算一套，页面就会写「共 23 · 有封面 18」
 * 而列表只有 17 件（真机 bug）。由 bridge.js 包成 deps.libraryAssetsViewOf 注入。
 */
export function libraryAssetsViewOf(deps, { fresh = false, fastScan = false } = {}) {
  return libraryAssetsView(deps, { fresh, fastScan });
}

function cleanTextList(values, limit = 50) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function mergeSourceCards(deps, fresh) {
  const data = withBinds(deps, libraryAssetsSnapshot(deps, { fresh }));
  return Array.isArray(data?.assets) ? data.assets : [];
}

function pickMergePrimary(members) {
  // 主成员决定「合并后这张卡长什么样」：优先有缩略图的、其次字节大的，最后看 key 稳定序。
  let best = members[0];
  for (const card of members.slice(1)) {
    const coverA = Boolean(best?.thumbRel) ? 1 : 0;
    const coverB = Boolean(card?.thumbRel) ? 1 : 0;
    if (coverB !== coverA) { if (coverB > coverA) best = card; continue; }
    if ((Number(card?.bytes) || 0) > (Number(best?.bytes) || 0)) best = card;
  }
  return String(best?.key ?? '');
}

async function handleMergeRoutes(request, deps) {
  const p = request.url.pathname;
  if (request.req.headers['x-agent-token'] || request.req.headers['x-agent-call']) {
    request.sendJson({ ok: false, error: '合并只允许管理端操作' }, 403);
    return true;
  }
  if (p === '/api/library/merges') {
    if (request.req.method !== 'GET') { request.sendJson({ ok: false, error: '该接口只支持 GET' }, 405); return true; }
    try {
      const table = readMergeTable(deps);
      const cards = mergeSourceCards(deps, request.url.searchParams.get('fresh') === '1');
      request.sendJson({
        ok: true,
        table,
        summary: mergeTableSummary(table),
        // 只提示「还能合并的」：已经合过的号不再喊，免得页面上一堆重复按钮。
        proposals: proposeMergeGroups(cards, table)
      });
    } catch (error) {
      request.sendJson({ ok: false, error: request.consoleRole === 'guest' ? '素材扫描失败' : `素材扫描失败：${scrubLocalPaths(error?.message ?? error)}` }, 500);
    }
    return true;
  }
  if (request.req.method !== 'POST') { request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }
  let body;
  try { body = await request.readBody(); }
  catch (error) { request.sendJson({ ok: false, error: error?.message ?? '请求体非法' }, Number(error?.statusCode) || 400); return true; }

  if (p === '/api/library/merge/split') {
    const mergeId = String(body?.mergeId ?? '').trim();
    if (!mergeId) { request.sendJson({ ok: false, error: '缺少 mergeId' }, 400); return true; }
    const table = readMergeTable(deps);
    if (!table.groups[mergeId]) { request.sendJson({ ok: false, error: '没有这个合并组（可能已经拆开了）' }, 404); return true; }
    const next = removeMerge(table, mergeId);
    writeMergeTable(deps, next);
    deps.log(`素材库：拆开合并组 ${mergeId}`);
    request.sendJson({ ok: true, mergeId, table: next, summary: mergeTableSummary(next) });
    return true;
  }

  let boothId = String(body?.boothId ?? '').trim();
  let keys = cleanTextList(body?.keys);
  let cards;
  try { cards = mergeSourceCards(deps, true); } catch (error) {
    request.sendJson({ ok: false, error: request.consoleRole === 'guest' ? '素材扫描失败' : `素材扫描失败：${scrubLocalPaths(error?.message ?? error)}` }, 500);
    return true;
  }
  const byKey = new Map(cards.map((card) => [String(card.key ?? ''), card]));
  // 只传 boothId 时，把同一号下的所有卡片都当成候选——页面「这 3 条可以合并」点一下就够。
  if (!keys.length && boothId) {
    keys = cards.filter((card) => String(card.boothId ?? '').trim() === boothId).map((card) => String(card.key ?? ''));
  }
  if (keys.length < 2) { request.sendJson({ ok: false, error: '至少选两条素材才能合并' }, 400); return true; }
  const missing = keys.filter((key) => !byKey.has(key));
  if (missing.length) {
    request.sendJson({ ok: false, error: `这些素材不在库里（刷新一下再试）：${missing.slice(0, 3).join('、')}` }, 400);
    return true;
  }
  const members = keys.map((key) => byKey.get(key));
  const memberBooths = [...new Set(members.map((card) => String(card.boothId ?? '').trim()).filter(Boolean))];
  if (memberBooths.length > 1) {
    request.sendJson({ ok: false, error: `得同一个 BOOTH 号才能合并（现在有 ${memberBooths.join('、')}）` }, 400);
    return true;
  }
  if (!boothId) boothId = memberBooths.length === 1 ? memberBooths[0] : '';
  if (!boothId) {
    request.sendJson({ ok: false, error: '这些素材没有共同的 BOOTH 号：先绑定号码再合并' }, 400);
    return true;
  }
  if (memberBooths.some((id) => id !== boothId)) {
    request.sendJson({ ok: false, error: `得同一个 BOOTH 号才能合并（现在有 ${memberBooths.join('、')}）` }, 400);
    return true;
  }
  const primaryKey = String(body?.primaryKey ?? '').trim() || pickMergePrimary(members);
  try {
    const next = setMerge(readMergeTable(deps), { boothId, keys, primaryKey, note: body?.note, now: Date.now() });
    writeMergeTable(deps, next);
    deps.log(`素材库：合并 ${keys.length} 条到 BOOTH ${boothId}（主成员 ${primaryKey}）`);
    const applied = applyMerges(cards, next);
    request.sendJson({
      ok: true,
      mergeId: mergeIdOf(boothId),
      table: next,
      summary: mergeTableSummary(next),
      merged: applied.mergedAway,
      mergedGroups: applied.groups,
      assets: applied.cards
    });
  } catch (error) {
    request.sendJson({ ok: false, error: error?.message ?? '合并失败' }, 400);
  }
  return true;
}

async function handleLibraryAssetsRoute(request, deps) {
  const p = request.url.pathname;
  if (p === '/api/library/facets') {
    // 左栏/胶囊计数：和列表走同一条最终视图链，否则「服装 2 件」点进去只有 1 件。
    return handleLibraryFacetsRoute(request, deps, () => libraryAssetsView(deps, { fresh: request.url.searchParams.get('fresh') === '1' }));
  }
  if (p === '/api/library/bind-suggestions' || p === '/api/library/bind-suggestion/accept') {
    // 认号建议/确认：确认后写绑定表并让素材视图立刻失效，否则页面要等 20 秒才看到「已核准」。
    return handleBindSuggestionRoutes(request, deps, () => libraryAssetsView(deps, { fresh: request.url.searchParams.get('fresh') === '1' }), invalidateLibraryAssetsViewCache);
  }
  if (p === '/api/library/favorites' || p === '/api/library/favorite') {
    return handleLibraryFavoritesRoute(request, deps);
  }
  // 和列表同一条最终视图链：写之前要能在这份快照里找到这件素材，写完立刻按新口径回。
  if (p === '/api/library/manual-meta') return handleLibraryManualMetaRoute(request, deps, () => libraryAssetsView(deps, { fresh: request.url.searchParams.get('fresh') === '1' }), manualMetaPure);
  if (p === '/api/library/archive-info') return handleArchiveInfoRoute(request, deps, () => libraryAssetsView(deps, { fresh: request.url.searchParams.get('fresh') === '1' }));
  if (p === '/api/library/duplicates') return handleLibraryDuplicatesRoute(request, deps, () => libraryAssetsView(deps, { fresh: request.url.searchParams.get('fresh') === '1' })); if (p === '/api/library/purchase-detail') return handlePurchaseDetailRoute(request, deps, () => libraryAssetsView(deps, { fresh: request.url.searchParams.get('fresh') === '1' })); // 同行的第二段是商品详情面板（两者都是「拿最终视图 → 只读」）
  if (p === '/api/library/cover') {
    // 素材库 v2 的统一封面入口：按「本地 → 台账 → 缓存 → 商品页」解析后直接吐图。
    return handleLibraryCoverRoute(request, deps, () => libraryAssetsView(deps, { fresh: request.url.searchParams.get('fresh') === '1' }));
  }
  if (p === '/api/library/asset/cover') return handleAssetCoverRoute(request, deps);
  if (p === '/api/library/asset/note') return handleAssetNoteRoute(request, deps);
  if (p === '/api/library/merges' || p === '/api/library/merge' || p === '/api/library/merge/split') {
    return handleMergeRoutes(request, deps);
  }
  if (p === '/api/library/alias-rules') return handleAliasRoutes(request, deps);
  if (p === '/api/library/reconcile' || p === '/api/library/reconcile/sync' || p === '/api/library/reconcile/bind'
    || p === '/api/library/reconcile/download' || p === '/api/library/reconcile/download-all' || p === '/api/library/reconcile/forget'
    || p === '/api/library/purchases/bind' || p === '/api/library/purchases/forget') {
    // 对账和素材页共用同一条最终视图链；?fresh=1 时绕过 20 秒缓存。
    return handleReconcileRoutes(request, deps, () => libraryAssetsView(deps, { fresh: request.url.searchParams.get('fresh') === '1' }));
  }
  if (p === '/api/library/asset') {
    // 详情和列表同一条最终视图链；fresh=1 绕过 20 秒缓存（刚改名/绑定完要立刻看到新事实）。
    return handleAssetDetailRoute(request, deps, () => libraryAssetsView(deps, { fresh: request.url.searchParams.get('fresh') === '1' }));
  }
  if (p !== '/api/library/assets' && p !== '/api/files/raw') return false;
  if (request.req.headers['x-agent-token'] || request.req.headers['x-agent-call']) {
    request.sendJson({ ok: false, error: '素材库扫描只允许管理端操作' }, 403);
    return true;
  }
  if (request.req.method !== 'GET') {
    request.sendJson({ ok: false, error: '该接口只支持 GET' }, 405);
    return true;
  }
  if (p === '/api/library/assets') {
    try {
      const searchParams = request.url.searchParams;
      const scanMode = searchParams.get('scan'); const fresh = searchParams.get('fresh') === '1' || scanMode === 'full'; const fastScan = scanMode === 'fast'; // scan=full 强制全量；scan=fast 无 stat 快速模式；默认增量，响应带 scanMode/scan
      // 标签/来源放在最后一步：合并卡用主成员的名字定标签，改名后的新目录名也算来源。
      const snap = libraryAssetsView(deps, { fresh, fastScan });
      // v2 视图（文档 §1）：view 先筛，再套现有 filter/q/sort/分页。
      // cloud / trash 的数据源不是扫盘结果，走同构远程卡片；其余视图直接筛素材数组。
      const view = normalizeAssetView(searchParams.get('view'));
      if (view === 'cloud' || view === 'trash') {
        request.sendJson(buildRemoteAssetView({
          deps,
          snap,
          view,
          searchParams,
          root: assetsRootForRole(snap.root, request.consoleRole),
          allCount: Array.isArray(snap.assets) ? snap.assets.length : 0
        }));
        return true;
      }
      // 筛选/分页在服务端做：total=筛选后总数、count=本页条数、allCount=全库件数（「共 N 件」用 total/allCount）。
      // view=extracted 的数据源是「被默认隐藏的解压产物」，不是可见素材，所以先换数组再套过滤。
      const source = view === 'extracted' ? (snap.extractedCards || []) : snap.assets;
      const viewed = view === 'extracted' ? source.slice() : applyAssetView(source, view);
      // 重复分组只算一次：counts.duplicated / filter=duplicated / facets.quality 共用这份 key 集合（否则左栏 3 张、点进去 1 张）。
      const dupKeys = duplicateKeySet(snap.assets);
      const page = pickAssetsPage(viewed, {
        duplicatedKeys: dupKeys,
        q: searchParams.get('q'),
        filter: searchParams.get('filter'),
        sort: searchParams.get('sort'),
        offset: searchParams.get('offset'),
        limit: searchParams.get('limit'),
        // Pro 界面（文档 §2.2）：分类/店铺/标签/适配模型/仅图片/收藏/已购+免费。
        category: searchParams.get('category'),
        shop: searchParams.get('shop'),
        tag: searchParams.get('tag'),
        model: searchParams.get('model'),
        kind: searchParams.get('kind'),
        fav: searchParams.get('fav'),
        purchase: searchParams.get('purchase')
      });
      const allCount = Array.isArray(snap.assets) ? snap.assets.length : 0;
      // counts 基于**全库**快照算，一次算完随响应回；筛选胶囊的数字用它，不能用本页 count。
      // 口径必须与各 view 的 total 同源：withBooth 只算 verified（台账/人工绑定），
      // 以前这里是「扫盘看到号就算」，于是左栏写「已认号 31」而真认过的只有 5 件（真机 bug）。
      const counts = {
        ...countAssetBuckets(snap.assets),
        ...countAssetViews({
          assets: snap.assets,
          bindStats: snap.bindStats,
          annotationStats: snap.annotationStats,
          cloud: countCloudCards(deps, snap.assets),
          trash: countTrashCards(deps)
        })
      };
      // 手动信息/重复组/解压产物都从台账与最终视图直接统计，不按本页卡片另数（口径不同会互相打脸）。
      counts.manual = Number(snap.manualMetaStats?.categorized) || 0; counts.manualTagged = Number(snap.manualMetaStats?.tagged) || 0;
      counts.duplicated = dupKeys.size; counts.duplicateGroups = duplicateCounts(snap.assets).groups;
      // 解压产物默认隐藏，但要让前端知道「隐藏了几件」，否则用户解压后觉得文件「不见了」。
      counts.extracted = Number(snap.extractedCount) || 0;
      // 访客只读视图：`root` 是扫盘根的**绝对路径**（如 <本机路径>\booth-inbox），
      // 访客用不到，却把本机目录结构漏给了拿到访客链接的人。管理员照旧（前端拿它做相对路径展示）。
      request.sendJson({
        ...snap,
        root: assetsRootForRole(snap.root, request.consoleRole),
        assets: page.assets,
        count: page.assets.length,
        total: page.total,
        allCount,
        offset: page.offset,
        limit: page.limit,
        truncated: page.truncated,
        view,
        // 顶部计数改用 counts 口径：以前 withBooth 是扫盘侧「看到号就算」，
        // 与左栏「已认号」两套数字互相打脸（真机 accept 后仍然 31 vs 5）。
        withBooth: counts.withBooth,
        withCover: counts.withCover,
        // 回显归一化后的筛选条件：前端据此确认后端真的筛了，不会退回本地过滤。
        q: page.q,
        filter: page.filter,
        sort: page.sort,
        // 新筛选参数也回显：前端靠它确认「后端真按分类/收藏筛了」，不会退回本地过滤。
        category: page.category,
        shop: page.shop,
        tag: page.tag,
        model: page.model,
        kind: page.kind,
        fav: page.fav,
        purchase: page.purchase,
        counts,
        // 解压产物被默认隐藏了几件（view=extracted 才列出来）。
        extractedCount: Number(snap.extractedCount) || 0,
        // 关系型字段统计（收藏/已购/使用过/重复号）：由 annotateLibraryAssets 基于最终视图算。
        annotationStats: snap.annotationStats,
        // 认号统计（已核准/待确认/无号）：前端左栏与「确认认号」面板读这一份，别再本地算。
        bindStats: snap.bindStats,
        favorites: snap.annotationStats?.favorites ?? 0,
        // 解压码 / RJ 号 / 类型标签的统计：和 counts 一样基于全库快照，不是本页。
        withTags: snap.tagStats?.withTags ?? countAssetTagStats(snap.assets).withTags,
        passwords: snap.tagStats?.passwords ?? 0,
        rjCount: snap.tagStats?.rjCount ?? 0
      });
    } catch (error) {
      // 扫描失败的原话可能带绝对路径（EACCES/ENOENT 会回显 stat 的文件）：管理员也脱敏，访客只给结论。
      request.sendJson({ ok: false, error: `素材扫描失败：${request.consoleRole === 'guest' ? '读取失败' : scrubLocalPaths(error?.message ?? error)}` }, 500);
    }
    return true;
  }
  // /api/files/raw?rel=：素材卡的封面原图。只回图片、只在档案根目录内，路径先过 safeResolveInside。
  const rel = String(request.url.searchParams.get('rel') || '');
  if (!rel) { request.sendJson({ ok: false, error: '缺少 rel' }, 400); return true; }
  if (!/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(rel)) {
    request.sendJson({ ok: false, error: '只回图片' }, 415);
    return true;
  }
  try {
    const root = typeof deps.fileArchiveRootDir === 'function' ? deps.fileArchiveRootDir() : deps.fileArchiveRootDir;
    const abs = (0, deps.safeResolveInside)(String(root || ''), rel);
    const stat = deps.fs.statSync(abs);
    if (!stat.isFile()) { request.sendJson({ ok: false, error: '不是文件' }, 400); return true; }
    // 页面只要封面，超过 12MB 的图直接拒：正常预览图都是几百 KB，超大的是误点。
    if (stat.size > 12 * 1024 * 1024) { request.sendJson({ ok: false, error: '图片太大（>12MB）' }, 413); return true; }
    const buf = deps.fs.readFileSync(abs);
    request.res.writeHead(200, {
      'content-type': (0, deps.mimeFromBuffer)(buf) || 'application/octet-stream',
      'content-length': String(buf.length),
      'cache-control': 'private, max-age=60'
    });
    request.res.end(buf);
  } catch (error) {
    // 错误文本统一走 fsErrorText：访客只看到「路径不存在/读取失败」，管理员带相对路径+错误码；
    // 绝不把 Node 原话里的绝对路径回给 API（真机泄漏过 <本机路径>\booth-inbox\…）。
    request.sendJson({ ok: false, error: fsErrorText(error, rel, request.consoleRole) }, 404);
  }
  return true;
}

// POST /api/library/asset/cover {boothId}：素材卡「抓封面」——现场抓一次并缓存（30 天）。
async function handleAssetCoverRoute(request, deps) {
  if (request.req.method !== 'POST') { request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }
  let body;
  try { body = await request.readBody(); }
  catch (error) { request.sendJson({ ok: false, error: error?.message ?? '请求体非法' }, Number(error?.statusCode) || 400); return true; }
  const boothId = String(body?.boothId ?? '').trim();
  if (!/^\d{5,9}$/.test(boothId)) { request.sendJson({ ok: false, error: 'BOOTH 号必须是 5~9 位数字' }, 400); return true; }
  try {
    const cover = await (0, deps.getBoothCover)(boothId, {
      cacheRoot: (0, deps.boothCacheDir)(),
      force: body?.force === true,
      log: (message) => (0, deps.log)(message)
    });
    libraryAssetsCache = { at: 0, root: '', data: null }; // 让下一次读重新拼图（封面/资料都变了）
    if (!cover.ok) { request.sendJson({ ok: false, status: cover.status, error: cover.coverError || cover.error || '展示图不可用' }, 404); return true; }
    request.sendJson({ ok: true, boothId, coverUrl: `/api/files/cover/${boothId}`, bytes: cover.bytes, cached: cover.cached });
  } catch (error) {
    // 抓封面失败的原话可能回显缓存目录绝对路径，统一脱敏（本路由管理员专用）。
    request.sendJson({ ok: false, error: `抓封面失败：${scrubLocalPaths(error?.message ?? error)}` }, 500);
  }
  return true;
}

// POST /api/library/asset/note {dir, boothId}：把 BOOTH 资料写回素材自己的 `素材说明.md`。
// 只替换本工具写的那一段（HTML 注释边界），文件里别的字一个都不动；默认 CRLF。
async function handleAssetNoteRoute(request, deps) {
  if (request.req.method !== 'POST') { request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }
  let body;
  try { body = await request.readBody(); }
  catch (error) { request.sendJson({ ok: false, error: error?.message ?? '请求体非法' }, Number(error?.statusCode) || 400); return true; }
  const boothId = String(body?.boothId ?? '').trim();
  const dir = String(body?.dir ?? '').split(String.fromCharCode(92)).join('/');
  if (!/^\d{5,9}$/.test(boothId)) { request.sendJson({ ok: false, error: 'BOOTH 号必须是 5~9 位数字' }, 400); return true; }
  let meta = null;
  const cacheDir = String((0, deps.boothCacheDir)() || '');
  try {
    const parsed = JSON.parse(deps.fs.readFileSync(deps.path.join(cacheDir, `${boothId}.json`), 'utf8'));
    if (parsed?.meta?.status === 'ok') meta = { ...parsed.meta, fetchedAt: Number(parsed.fetchedAt) || 0 };
  } catch { meta = null; }
  if (!meta) {
    // 没缓存就现场抓一次（和封面同一套限速/缓存），抓不到就让用户先「抓封面」。
    try {
      meta = await (0, deps.fetchBoothMeta)(boothId, { cacheDir, log: (message) => (0, deps.log)(message) });
    } catch (error) { meta = null; }
    if (!meta || meta.status !== 'ok') {
      request.sendJson({ ok: false, error: '这个商品还没有抓到资料：先点「抓封面」再写说明' }, 409);
      return true;
    }
  }
  try {
    const root = String((0, deps.fileArchiveRootDir)() || '');
    let dirAbs = '';
    try { dirAbs = (0, deps.safeResolveInside)(root, dir || '.'); }
    catch { request.sendJson({ ok: false, error: '素材目录不合法：不能写到素材库外面的路径' }, 400); return true; }
    if (!deps.fs.existsSync(dirAbs) || !deps.fs.statSync(dirAbs).isDirectory()) {
      request.sendJson({ ok: false, error: '素材目录不存在' }, 404);
      return true;
    }
    const noteName = deps.libraryNotes.NOTE_FILE_NAME;
    const fileAbs = deps.path.join(dirAbs, noteName);
    let existing = '';
    try { existing = deps.fs.readFileSync(fileAbs, 'utf8'); } catch { existing = ''; }
    const block = deps.libraryNotes.renderNoteBlock({ ...meta, boothId, itemUrl: meta.itemUrl || `https://booth.pm/zh-cn/items/${boothId}` });
    const next = deps.libraryNotes.mergeNoteContent(existing, block);
    deps.fs.writeFileSync(fileAbs, next, 'utf8');
    libraryAssetsCache = { at: 0, root: '', data: null };
    (0, deps.log)(`控制台：把 BOOTH ${boothId} 的资料写回 ${dir || '.'}/${noteName}`);
    request.sendJson({
      ok: true,
      boothId,
      file: deps.path.join(dir || '.', deps.libraryNotes.NOTE_FILE_NAME).split(String.fromCharCode(92)).join('/'),
      bytes: Buffer.byteLength(next, 'utf8'),
      replaced: deps.libraryNotes.hasNoteBlock(existing),
      title: String(meta.title || '')
    });
  } catch (error) {
    request.sendJson({ ok: false, error: `写说明失败：${scrubLocalPaths(error?.message ?? error)}` }, 500);
  }
  return true;
}

async function handleLibraryFoldersRoute(request, deps) {
  const p = request.url.pathname;
  if (p !== '/api/files/folders' && p !== '/api/files/open-folder') return false;
  if (request.req.headers['x-agent-token'] || request.req.headers['x-agent-call']) {
    request.sendJson({ ok: false, error: '打开电脑上的文件夹只允许管理端操作' }, 403);
    return true;
  }
  if (p === '/api/files/folders') {
    if (request.req.method !== 'GET') { request.sendJson({ ok: false, error: '该接口只支持 GET' }, 405); return true; }
    try {
      request.sendJson(listLibraryFolders(deps));
    } catch (error) {
      request.sendJson({ ok: false, error: `列目录失败：${scrubLocalPaths(error?.message ?? error)}` }, 500);
    }
    return true;
  }
  if (request.req.method !== 'POST') { request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }
  let body;
  try { body = await request.readBody(); }
  catch (error) { request.sendJson({ ok: false, error: error?.message ?? '请求体非法' }, Number(error?.statusCode) || 400); return true; }
  try {
    const opened = openFolderInExplorer(deps, body && body.rel);
    request.sendJson({ ok: true, opened });
  } catch (error) {
    request.sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
  }
  return true;
}


/** 把这些路由绑到同一份 deps 上（file-library 的工厂里调用一次）。 */
export function createLibraryView(deps) {
  return {
    handleLibraryFoldersRoute: (request) => handleLibraryFoldersRoute(request, deps),
    handleLibraryAssetsRoute: (request) => handleLibraryAssetsRoute(request, deps),
    handleAssetCoverRoute: (request) => handleAssetCoverRoute(request, deps),
    handleAssetNoteRoute: (request) => handleAssetNoteRoute(request, deps),
    listLibraryFolders: () => listLibraryFolders(deps),
    openFolderInExplorer: (rel) => openFolderInExplorer(deps, rel)
  };
}
