// 绑定后手动改名（L5=A）：把磁盘上的素材目录与主包文件改成 BOOTH 商品名。
//
// 为什么需要它：素材下载下来叫 `Endless Comfort (Ver1_0_2 Win)`、目录是 `8844481` 这种，
// 人在文件管理器里根本认不出哪件是哪件；而改名必须真动磁盘（目录名 + 主包文件名），
// 页面标题那种覆盖显示不算——用户要的是「文件夹就叫这名字」。
//
// 为什么是纯函数：改名是**不可逆风险最高的动作**（文档原话「改名不可逆风险高，先人确认」），
// 所以「改成什么」先算成一份计划（plan）让人看，再由桥接层照计划逐条 renameSync。
// 计划里每个 move 都是 `{from, to}` 相对路径，撤销就是把 moves 逆序再来一遍。
//
// 日志存 `state/booth-renames.json`，每件素材保留最近几条，供撤销与追查。

// 改名会换掉 contentKey（key = contentKeyFor(主件名, 字节数)），而绑定表/改名日志都按 key 索引：
// 所以计划里必须同时算出改名后的 newKey，否则撤销时前端拿着新 key 永远找不到记录（真机踩过）。
import { contentKeyFor } from './file-archive/common.js';
// 收藏也按 contentKey 存（state/booth-favorites.json）：改名同样会换 key，
// 不迁移的话用户点过的星标会凭空消失。规则很小，直接复用纯模块，不另起一份。
import { readFavoritesState, writeFavoritesState, migrateFavorite } from './library-favorites.js';
// 手动标签/手动分类也按 contentKey 存（state/library-manual-meta.json）：改名换 key 时必须一起搬家，
// 否则用户刚手动归好类，改个名就回到「未分类」——这正是手动信息最容易被白费的地方。
import { readManualMetaState, writeManualMetaState, moveManualMeta } from './library-manual-meta.js';

export const RENAME_RULES_VERSION = 1;
/** 目录/文件名长度上限：Windows 单段 260 路径限制下，60 个字符已经够描述一件素材。 */
export const RENAME_MAX_CHARS = 60;
/** 目标名最短长度：太短的名字（如「衣服」两个字）撞车概率太高，宁可不改。 */
// 最短 2 个字符：`Mew`(3)、`Shiro`(5) 这种正常短名必须能改；只有 1 个字符或纯空白才算非法
// （0/1 字符的目录名在 Windows 上不好用，也几乎不可能是真商品名）。
export const RENAME_MIN_STEM = 2;

const WIN_BAD_CHARS = '<>:"/\\|?*';
/** 日期目录（2026-10 / 2026-10-28 / 202610）：素材落在这种目录里说明是按时间归档的，改名会打乱归档。 */
const DATE_DIR_RE = /^\d{4}([-_.]?\d{2})?([-_.]?\d{2})?$/;
/** 群目录（100000001_扣1复活牢大）：改名会把整个群下面的素材全带走，绝对不允许。 */
const GROUP_DIR_RE = /^\d{5,15}[_-].+/;

/**
 * 把用户给的名字洗成「Windows 上一定能建出来」的目录/文件名。
 * 非法字符 → `_`；控制字符 → `_`；连续空白压一个；去首尾空格与结尾点；截 60。
 * 返回值可能是 ''（清洗后什么都不剩），调用方必须当「名字不合格」处理。
 */
export function sanitizeRenameTarget(name) {
  let text = String(name ?? '');
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) { out += '_'; continue; }
    if (WIN_BAD_CHARS.includes(ch)) { out += '_'; continue; }
    out += ch;
  }
  text = out.replace(/\s+/g, ' ').trim();
  // Windows 不允许目录/文件名以点结尾（`foo.` 会被静默去掉），这里主动去掉避免「改了但名字不对」。
  text = text.replace(/\.+$/, '').trim();
  return text.slice(0, RENAME_MAX_CHARS);
}

function splitDir(rel) {
  return String(rel ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.');
}

function splitExt(name) {
  const text = String(name ?? '');
  const m = text.match(/\.([A-Za-z0-9]{1,10})$/);
  if (!m) return { stem: text, ext: '' };
  return { stem: text.slice(0, text.length - m[0].length), ext: m[1] };
}

/**
 * 算一份改名计划（只读，不碰盘）。
 * - 目标名：传入 `name` 优先，否则 `asset.boundTitle || asset.title`（绑定到 BOOTH 后商品名更准）。
 * - 只改**末级目录**：`群目录/分类/素材目录` 里只动第三段；`群目录/素材目录` 动第二段。
 * - 落在日期目录 / 群目录里的素材直接拒（reason 写清为什么），因为改名会破坏按时间/按群的归档。
 * - 主包文件保留扩展名，只换 stem。
 * 返回 `{ok, key, from:{dir,mainName}, to:{dir,mainName}, moves:[{from,to}], reason}`；
 * 失败时 `ok:false` 且 `reason` 是给用户看的中文原因。
 */
export function buildRenamePlan(asset, { name = '', now = Date.now() } = {}) {
  const key = String(asset?.key ?? '').trim();
  const dir = String(asset?.dir ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const mainName = String(asset?.mainName ?? '').trim();
  const rawTarget = String(name ?? '').trim() || String(asset?.boundTitle ?? '').trim() || String(asset?.title ?? '').trim();
  let target = sanitizeRenameTarget(rawTarget);
  const perms = { key, at: Number(now) || Date.now() };
  const fail = (reason) => ({
    ok: false,
    ...perms,
    from: { dir, mainName },
    to: { dir, mainName },
    moves: [],
    newKey: '',
    prefixed: false,
    reason
  });
  if (!key) return fail('缺少 contentKey');
  if (!target) return fail('名字清洗后是空的（非法字符太多）');
  if (Array.from(target).length < RENAME_MIN_STEM) return fail(`名字太短（至少 ${RENAME_MIN_STEM} 个字）`);
  // 号是素材的身份，改名只允许在号后面加/改描述：不带号就自动补 `<号>_`，并把 prefixed 透给前端，
  // 免得用户以为「名字被偷偷改了」。没认号的素材不补（没有号可加）。
  const boothId = String(asset?.boothId ?? '').trim();
  let prefixed = false;
  if (/^\d{5,9}$/.test(boothId) && !target.startsWith(boothId)) {
    const prefix = `${boothId}_`;
    const room = Math.max(1, RENAME_MAX_CHARS - prefix.length);
    target = `${prefix}${Array.from(target).slice(0, room).join('')}`;
    prefixed = true;
  }
  if (!mainName) return fail('没有主包文件，没法改名');
  const segments = splitDir(dir);
  if (!segments.length) return fail('素材不在独立目录里，没法改名');
  const last = segments[segments.length - 1];
  if (DATE_DIR_RE.test(last)) return fail('素材在日期目录里，先归位到独立目录再改名');
  if (GROUP_DIR_RE.test(last)) return fail('这一层是群目录，改名会把整个群带进来');
  const { ext } = splitExt(mainName);
  const newMainName = ext && !target.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? `${target}.${ext}` : target;
  const toSegments = segments.slice(0, -1).concat(target);
  const toDir = toSegments.join('/');
  if (toDir === dir && newMainName === mainName) return fail('名字没变');
  // 顺序很关键：先在旧目录里把主包改名，再改目录名（目录一改，旧路径就全变了）。
  const moves = [
    { from: `${dir}/${mainName}`, to: `${dir}/${newMainName}` },
    { from: dir, to: toDir }
  ];
  return {
    ok: true,
    ...perms,
    from: { dir, mainName },
    to: { dir: toDir, mainName: newMainName },
    moves,
    // 改名后卡片 key 会变：记下来，撤销与绑定迁移都靠它。
    newKey: contentKeyFor(newMainName, Number(asset?.mainBytes) || 0),
    prefixed,
    reason: ''
  };
}

/** 造一条日志（撤销就是拿它的 moves 逆序执行）。 */
export function renameLogEntry({ key, newKey, from, to, at, moves }) {
  const cleanMoves = (Array.isArray(moves) ? moves : [])
    .map((move) => ({ from: String(move?.from ?? '').trim(), to: String(move?.to ?? '').trim() }))
    .filter((move) => move.from && move.to);
  return {
    at: Number(at) || Date.now(),
    from: { dir: String(from?.dir ?? ''), mainName: String(from?.mainName ?? '') },
    to: { dir: String(to?.dir ?? ''), mainName: String(to?.mainName ?? '') },
    key: String(key ?? '').trim(),
    newKey: String(newKey ?? '').trim(),
    moves: cleanMoves
  };
}

const RENAME_LOG_KEEP = 10;

/** 规范化日志：坏条目丢、每件素材只留最近 10 条（撤销只需要最近几条，留太多只会让文件膨胀）。 */
export function normalizeRenameLog(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const from = src.entries && typeof src.entries === 'object' && !Array.isArray(src.entries) ? src.entries : {};
  const entries = {};
  for (const [rawKey, list] of Object.entries(from)) {
    const key = String(rawKey ?? '').trim();
    if (!key || !Array.isArray(list)) continue;
    const cleaned = list
      .map((item) => renameLogEntry({ key, newKey: item?.newKey, from: item?.from, to: item?.to, at: item?.at, moves: item?.moves }))
      .filter((item) => item.moves.length > 0);
    if (!cleaned.length) continue;
    entries[key] = cleaned.slice(-RENAME_LOG_KEEP);
  }
  return { version: RENAME_RULES_VERSION, entries };
}

/**
 * 取某件素材最近一条改名记录（撤销用）。
 * 同时认旧 key 与 newKey：前端拿到的是**当前卡片**的 key（改名后已经是 newKey），
 * 只按旧 key 找必然找不到——真机就是这么翻车的。
 */
export function lastUndo(log, contentKey = '') {
  const table = normalizeRenameLog(log).entries;
  const key = String(contentKey ?? '').trim();
  if (key) {
    const direct = table[key];
    if (direct && direct.length) return direct[direct.length - 1];
    for (const list of Object.values(table)) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].newKey && list[i].newKey === key) return list[i];
      }
    }
    return null;
  }
  let best = null;
  for (const list of Object.values(table)) {
    const entry = list[list.length - 1];
    if (entry && (!best || entry.at > best.at)) best = entry;
  }
  return best;
}

/** 写一条日志（返回新表，不改入参）。 */
export function appendRenameLog(log, entry) {
  const base = normalizeRenameLog(log);
  const item = renameLogEntry(entry);
  const key = item.key;
  if (!key) return base;
  const list = (base.entries[key] || []).concat([item]).slice(-RENAME_LOG_KEEP);
  base.entries[key] = list;
  return base;
}

/** 移除某件素材最近一条记录（撤销成功后调用）。 */
export function dropLastRenameLog(log, contentKey) {
  const base = normalizeRenameLog(log);
  const key = String(contentKey ?? '').trim();
  const list = base.entries[key] || [];
  if (list.length <= 1) delete base.entries[key];
  else base.entries[key] = list.slice(0, -1);
  return base;
}

/** 给前端看的摘要：改过名的素材件数与最近一次改名时间。 */
export function renameLogSummary(log) {
  const table = normalizeRenameLog(log);
  const keys = Object.keys(table.entries);
  let lastAt = 0;
  for (const list of Object.values(table.entries)) {
    for (const entry of list) lastAt = Math.max(lastAt, Number(entry.at) || 0);
  }
  return { version: table.version, count: keys.length, lastAt };
}

// ── 路由适配层 ────────────────────────────────────────────────────────────
// 为什么路由处理写在这个「纯规则」文件里：console 模块是在 VM 里裸执行的（不能 import），
// 想复用同一份改名逻辑只能由 deps.libraryRenamePure 把本模块命名空间递进去。
// 这个函数自己不碰全局：deps / 快照 / 绑定表 / 日志读写全部由调用方通过 ctx 传入。

export async function handleRenameRoutesFor(ctx, request) {
  const {
    deps, currentSnapshot, readRenames, writeRenames,
    readBinds, writeBinds, setBind, removeBind, bindOf, findCache
  } = ctx;
  const p = request.url.pathname;
  if (request.req.method !== 'POST') { request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }
  let body;
  try { body = await request.readBody(); }
  catch (error) { request.sendJson({ ok: false, error: error?.message ?? '请求体非法' }, Number(error?.statusCode) || 400); return true; }
  const key = String(body?.key ?? '').trim();
  if (!key) { request.sendJson({ ok: false, error: '缺少 key（素材的 contentKey）' }, 400); return true; }

  const rootDir = String(typeof deps.fileArchiveRootDir === 'function' ? deps.fileArchiveRootDir() : deps.fileArchiveRootDir || '').trim();
  if (!rootDir) { request.sendJson({ ok: false, error: '转存目录还没配（config.json 的 fileArchive.dir）' }, 503); return true; }
  const absOf = (rel) => deps.safeResolveInside(rootDir, rel);
  // 改名会换 key，而人工绑定表是按 key 存的：不迁移的话「改完名素材就不认号了」。
  // 撤销时再迁回去，两个方向都走这一个函数，免得一边写错。
  const migrateBind = (fromKey, toKey) => {
    if (!fromKey || !toKey || fromKey === toKey || typeof bindOf !== 'function') return false;
    const bound = bindOf(readBinds(), fromKey);
    if (!bound) return false;
    const next = setBind(removeBind(readBinds(), fromKey), toKey, bound.boothId, { title: bound.title, source: bound.source });
    writeBinds(next);
    if (findCache && typeof findCache.delete === 'function') { findCache.delete(fromKey); findCache.delete(toKey); }
    deps.log(`素材库：绑定随改名迁移 ${fromKey} → ${toKey}（BOOTH ${bound.boothId}）`);
    return true;
  };
  // 收藏与绑定是同一类东西：都按 contentKey 索引，改名后必须跟着搬家。
  // 失败只记日志、不中断改名——磁盘已经改完了，回头再点一次星标成本远低于让改名失败。
  const migrateFavorites = (fromKey, toKey) => {
    if (!fromKey || !toKey || fromKey === toKey) return false;
    try {
      const moved = migrateFavorite(readFavoritesState(deps), fromKey, toKey);
      if (!moved.moved) return false;
      writeFavoritesState(deps, moved.table);
      deps.log(`素材库：收藏随改名迁移 ${fromKey} → ${toKey}`);
      return true;
    } catch (error) {
      deps.log(`素材库：收藏迁移失败（${fromKey} → ${toKey}）：${error?.message ?? error}`);
      return false;
    }
  };
  // 手动标签/手动分类同理：按 key 存的台账都要跟着改名搬。失败只记日志，绝不中断改名。
  const migrateManualMeta = (fromKey, toKey) => {
    if (!fromKey || !toKey || fromKey === toKey) return false;
    try {
      const moved = moveManualMeta(readManualMetaState(deps), fromKey, toKey);
      if (!moved.moved) return false;
      writeManualMetaState(deps, moved.table);
      deps.log(`素材库：手动标签随改名迁移 ${fromKey} → ${toKey}`);
      return true;
    } catch (error) {
      deps.log(`素材库：手动标签迁移失败（${fromKey} → ${toKey}）：${error?.message ?? error}`);
      return false;
    }
  };

  if (p === '/api/library/rename/undo') {
    const log = readRenames();
    const entry = lastUndo(log, key);
    if (!entry || !entry.moves.length) {
      request.sendJson({ ok: false, error: '这件素材没有改名记录，没法撤销' }, 409);
      return true;
    }
    const moves = entry.moves.slice().reverse();   // 记录是「先文件后目录」，撤销要反过来
    const done = [];
    let migratedBind = false;
    try {
      for (const move of moves) {
        deps.fs.renameSync(absOf(move.to), absOf(move.from));
        done.push(move);
      }
    } catch (error) {
      let rolledBack = 0;
      for (const move of done.slice().reverse()) {
        try { deps.fs.renameSync(absOf(move.from), absOf(move.to)); rolledBack += 1; }
        catch (inner) { deps.log(`素材库：撤销回滚失败（${move.from}）：${inner?.message ?? inner}`); }
      }
      request.sendJson({ ok: false, error: `撤销失败：${error?.message ?? error}（已回滚 ${rolledBack}/${done.length} 条）`, rolledBack }, 500);
      return true;
    }
    migratedBind = migrateBind(entry.newKey, entry.key);
    const migratedFavorite = migrateFavorites(entry.newKey, entry.key);
    const migratedManualMeta = migrateManualMeta(entry.newKey, entry.key);
    const next = dropLastRenameLog(log, entry.key);
    writeRenames(next);
    deps.log(`素材库：撤销改名 ${entry.key}（${moves.length} 条）`);
    request.sendJson({
      ok: true,
      key: entry.key,
      // 前端要能立刻刷新「现在磁盘上叫什么」：restored 是从路径（撤销后重新存在的那些），
      // restoredDir/restoredMainName 是撤销后的目录与主件名；undone 保留原样给老调用方。
      restored: moves.map((move) => move.from),
      restoredDir: entry.from?.dir ?? '',
      restoredMainName: entry.from?.mainName ?? '',
      undone: moves,
      bindMigrated: migratedBind,
      favoritesMigrated: migratedFavorite,
      manualMetaMigrated: migratedManualMeta,
      log: renameLogSummary(next)
    });
    return true;
  }

  let asset = null;
  try {
    asset = (currentSnapshot().assets || []).find((item) => String(item.key) === key) || null;
  } catch (error) {
    request.sendJson({ ok: false, error: `素材扫描失败：${error?.message ?? error}` }, 500);
    return true;
  }
  if (!asset) { request.sendJson({ ok: false, error: '没有这件素材（刷新一下素材卡列表再试）' }, 404); return true; }

  const plan = buildRenamePlan(asset, { name: String(body?.name ?? '').trim(), now: Date.now() });
  if (p === '/api/library/rename/preview') {
    // 预览只读：plan 不 ok 也回 200，把 reason 带回去让前端原地显示（不用抛红）。
    // 目标是否已被占用也要在预览里说清楚——用户点「改名」之前就该看到会撞车。
    const previewConflicts = plan.ok ? plan.moves.filter((move) => deps.fs.existsSync(absOf(move.to))) : [];
    const previewReason = plan.ok
      ? (previewConflicts.length ? `目标已存在，先手动处理：${previewConflicts[0].to}` : '')
      : plan.reason;
    request.sendJson({
      ok: plan.ok && !previewConflicts.length,
      plan,
      // 顶层再给一份 prefixed：前端预览提示「将自动带上号前缀」时不用深入 plan 里找。
      prefixed: Boolean(plan.prefixed),
      reason: previewReason,
      conflicts: previewConflicts.map((move) => move.to)
    });
    return true;
  }
  if (!plan.ok) { request.sendJson({ ok: false, error: plan.reason, plan }, 409); return true; }
  const conflicts = plan.moves.filter((move) => deps.fs.existsSync(absOf(move.to)));
  if (conflicts.length) {
    request.sendJson({ ok: false, error: `目标已存在，先手动处理：${conflicts[0].to}`, plan, conflicts: conflicts.map((m) => m.to) }, 409);
    return true;
  }
  if (body?.dryRun) { request.sendJson({ ok: true, dryRun: true, plan }); return true; }

  const done = [];
  try {
    for (const move of plan.moves) {
      deps.fs.renameSync(absOf(move.from), absOf(move.to));
      done.push(move);
    }
  } catch (error) {
    let rolledBack = 0;
    for (const move of done.slice().reverse()) {
      try { deps.fs.renameSync(absOf(move.to), absOf(move.from)); rolledBack += 1; }
      catch (inner) { deps.log(`素材库：改名回滚失败（${move.to}）：${inner?.message ?? inner}`); }
    }
    request.sendJson({ ok: false, error: `改名失败：${error?.message ?? error}（已回滚 ${rolledBack}/${done.length} 条）`, rolledBack, plan }, 500);
    return true;
  }
  const bindMigrated = migrateBind(key, plan.newKey);
  const favoritesMigrated = migrateFavorites(key, plan.newKey);
  const manualMetaMigrated = migrateManualMeta(key, plan.newKey);
  const logNext = appendRenameLog(readRenames(), renameLogEntry({
    key, newKey: plan.newKey, from: plan.from, to: plan.to, at: plan.at, moves: plan.moves
  }));
  writeRenames(logNext);
  deps.log(`素材库：改名 ${key} → ${plan.to.dir}/${plan.to.mainName}（新 key ${plan.newKey}）`);
  request.sendJson({ ok: true, key, newKey: plan.newKey, renamed: plan.moves, bindMigrated, favoritesMigrated, manualMetaMigrated, plan, log: renameLogSummary(logNext) });
  return true;
}

