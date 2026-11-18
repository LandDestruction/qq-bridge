// 收藏（星标）路由：GET /api/library/favorites、POST /api/library/favorite。
//
// 为什么单独一个文件：library-view.js 贴着 800 行规模闸，而收藏要读写 state/ 文件，
// 跟「纯读视图」不是一类事。这里只做三件事：读表、开关、落盘（原子写）。
// 纯规则与文件读写都在 src/library-favorites.js（normalize/set/migrate/read/write），
// 这里负责路由与权限：访客只读（GET 允许、POST 403）——访客链接可能被转发出去，
// 不能让人顺手改管理员收藏。

import {
  FAVORITES_FILE, setFavorite, favoriteCount, favoriteKeysOf,
  readFavoritesState, writeFavoritesState
} from '../../library-favorites.js';

export { FAVORITES_FILE };

/** 读收藏表（坏文件当空表；收藏丢了也不能让素材页 500）。 */
export function readFavorites(deps) {
  return readFavoritesState(deps);
}

export function writeFavorites(deps, table) {
  writeFavoritesState(deps, table);
}

function isGuest(request) {
  return String(request?.consoleRole || '') === 'guest';
}

/**
 * 路由入口：命中返回 true（控制台按 true 结束请求），没命中返回 false。
 * GET /api/library/favorites → {ok, keys, count}
 * POST /api/library/favorite {key, on} → {ok, favorite, count}
 */
export async function handleLibraryFavoritesRoute(request, deps) {
  const p = request.url.pathname;
  const isList = p === '/api/library/favorites';
  const isToggle = p === '/api/library/favorite';
  if (!isList && !isToggle) return false;
  if (isList && request.req.method !== 'GET') {
    request.sendJson({ ok: false, error: '该接口只支持 GET' }, 405);
    return true;
  }
  if (isToggle && request.req.method !== 'POST') {
    request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405);
    return true;
  }
  if (isToggle && isGuest(request)) {
    request.sendJson({ ok: false, error: '访客只能查看收藏，不能修改' }, 403);
    return true;
  }
  if (isList) {
    const table = readFavorites(deps);
    request.sendJson({ ok: true, keys: favoriteKeysOf(table), count: favoriteCount(table) });
    return true;
  }
  let body;
  try {
    body = await request.readBody();
  } catch (error) {
    request.sendJson({ ok: false, error: error?.message ?? '请求体非法' }, Number(error?.statusCode) || 400);
    return true;
  }
  const key = String(body?.key ?? '').trim();
  if (!key) {
    request.sendJson({ ok: false, error: '缺少 key（素材的 contentKey）' }, 400);
    return true;
  }
  // 不传 on 时按「切换」处理：前端只有一个星标按钮，重复点传 undefined 的情况不少。
  const table = readFavorites(deps);
  const on = body?.on == null ? !table.entries[key] : body.on !== false;
  try {
    const next = setFavorite(table, key, on, Date.now());
    writeFavorites(deps, next);
    deps.log?.(`素材库：${on ? '收藏' : '取消收藏'} ${key}（共 ${favoriteCount(next)} 件）`);
    request.sendJson({ ok: true, key, favorite: on, count: favoriteCount(next) });
  } catch (error) {
    request.sendJson({ ok: false, error: `保存收藏失败：${error?.message ?? error}` }, 500);
  }
  return true;
}
