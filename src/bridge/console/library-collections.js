// 素材集（套装 / 装配方案）VM 模块。
//
// 一个「素材集」= 名字 + 一串素材 key（例如「这套搭配用的衣服 / 发型 / 配件」）。
// 素材本身的视图（assets 列表）不在这里改：前端拿 GET /api/library/assets 之后，
// 自己用这里返回的 keys / count 合并显示。模块只负责 state/library-collections.json 的读写。
//
// 硬约束：
// - 纯规则（normalize/create/update/remove/addKeys/removeKeys/decorate/collectionsOfAsset）
//   全部在 src/library-collections.js，由 deps.libraryCollectionsPure 注入；
// - 素材视图走 deps.libraryAssetsViewOf（与素材页同一份最终视图，合并/改名/绑定之后的口径）；
// - 写盘一律 deps.atomicWriteJson（tmp+rename），坏 JSON 当空表回落，不抛 500；
// - 管理端接口：带智能体令牌一律 403。
//
// 约束：本文件是 manifest 模块，被 scripts/bridge-source.mjs 用 vm.runInContext 裸执行，
// **不能 import**；纯规则/文件系统都从 deps 注入，构造期不读 deps（VM 边界测试会用
// 「一访问就抛」的 getter 构造工厂）。
// 顶部不要有和 src/bridge.js 同名的 const/let（VM 里共用一个全局词法作用域）。

const LIBCOL_STATE_FILE = 'library-collections.json';
const LIBCOL_ROUTE = '/api/library/collections';
const LIBCOL_ROUTE_UPDATE = '/api/library/collections/update';
const LIBCOL_ROUTE_REMOVE = '/api/library/collections/remove';
const LIBCOL_ROUTE_MEMBERS = '/api/library/collections/members';

export function createLibraryCollections(deps) {
  let impl = null;
  const implOf = () => impl || (impl = buildLibraryCollections(deps));
  return { handleConsoleLibraryCollections: (request) => implOf().handleConsoleLibraryCollections(request) };
}

// ── 存储 ──────────────────────────────────────────────────────────────
function libcolStatePath(deps) {
  return deps.path.join(String(deps.STATE_DIR), LIBCOL_STATE_FILE);
}

function libcolPure(deps) {
  const pure = deps.libraryCollectionsPure;
  if (!pure || typeof pure.normalizeCollections !== 'function') {
    throw new Error('素材集规则模块没接上（deps.libraryCollectionsPure）');
  }
  return pure;
}

/** 读表：坏 JSON / 坏结构都当空表，不让一个手改坏的文件把整个页面弄崩。 */
function libcolLoad(deps) {
  const pure = libcolPure(deps);
  let raw = null;
  try {
    raw = JSON.parse(deps.fs.readFileSync(libcolStatePath(deps), 'utf8'));
  } catch {
    return pure.normalizeCollections(null);
  }
  return pure.normalizeCollections(raw);
}

function libcolSave(deps, table) {
  deps.atomicWriteJson(libcolStatePath(deps), table);
}

// ── 视图 ──────────────────────────────────────────────────────────────
function libcolAssetsOf(deps) {
  try {
    const view = typeof deps.libraryAssetsViewOf === 'function' ? deps.libraryAssetsViewOf({ fresh: false }) : null;
    return Array.isArray(view?.assets) ? view.assets : [];
  } catch (error) {
    // 素材视图读失败不影响素材集本身的增删改：coverUrl 为空，前端仍能显示名字和成员数。
    if (typeof deps.log === 'function') deps.log(`[library-collections] 读素材视图失败：${error?.message ?? error}`);
    return [];
  }
}

function libcolDecorated(deps, table) {
  const pure = libcolPure(deps);
  return pure.decorateCollections(table, libcolAssetsOf(deps));
}

function libcolItemOf(deps, table, id) {
  const items = libcolDecorated(deps, table);
  return items.find((item) => item.id === id) || null;
}

// ── 请求工具 ──────────────────────────────────────────────────────────
function libcolReadBody(request) {
  return request.readBody();
}

function libcolIsPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function libcolErrorCode(error) {
  const message = String(error?.message ?? error ?? '');
  // 纯规则抛的是中文业务错误：集合不存在按 404，其余（名字/参数非法）按 400。
  if (message.includes('不存在')) return 404;
  return 400;
}

function libcolFail(sendJson, error, fallback = '素材集操作失败') {
  const message = String(error?.message ?? '').trim() || fallback;
  sendJson({ ok: false, error: message }, libcolErrorCode(error));
}

function buildLibraryCollections(deps) {
  // @bridge-function handleConsoleLibraryCollections:start
  async function handleConsoleLibraryCollections(request) {
    const { req, url, sendJson } = request;
    // 素材集是管理端数据：智能体一律 403（与其它写接口一致）。
    if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
      sendJson({ ok: false, error: '未授权：素材集只允许管理端操作' }, 403);
      return true;
    }
    const pathname = url.pathname;
    const known = pathname === LIBCOL_ROUTE
      || pathname === LIBCOL_ROUTE_UPDATE
      || pathname === LIBCOL_ROUTE_REMOVE
      || pathname === LIBCOL_ROUTE_MEMBERS;
    if (!known) return false;
    const pure = libcolPure(deps);

    try {
      if (pathname === LIBCOL_ROUTE && req.method === 'GET') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const table = libcolLoad(deps);
        if (key) {
          const items = pure.collectionsOfAsset(table, key);
          sendJson({ ok: true, items, total: items.length });
          return true;
        }
        const items = libcolDecorated(deps, table);
        sendJson({ ok: true, items, total: items.length });
        return true;
      }

      if (pathname === LIBCOL_ROUTE && req.method === 'POST') {
        const body = await libcolReadBody(request);
        if (!libcolIsPlainObject(body)) {
          sendJson({ ok: false, error: '请求体必须是 JSON 对象（{name, note?, keys?}）' }, 400);
          return true;
        }
        if (body.keys !== undefined && !Array.isArray(body.keys)) {
          sendJson({ ok: false, error: 'keys 必须是数组' }, 400);
          return true;
        }
        const before = libcolLoad(deps);
        const table = pure.createCollection(before, {
          name: body.name,
          note: body.note,
          coverKey: body.coverKey,
          keys: body.keys
        });
        libcolSave(deps, table);
        const createdId = Object.keys(table.items).find((id) => !before.items[id]) ?? '';
        const items = libcolDecorated(deps, table);
        sendJson({ ok: true, id: createdId, item: items.find((item) => item.id === createdId) ?? null, total: items.length });
        return true;
      }

      if (pathname === LIBCOL_ROUTE_UPDATE && req.method === 'POST') {
        const body = await libcolReadBody(request);
        if (!libcolIsPlainObject(body)) {
          sendJson({ ok: false, error: '请求体必须是 JSON 对象（{id, patch}）' }, 400);
          return true;
        }
        if (!libcolIsPlainObject(body.patch)) {
          sendJson({ ok: false, error: 'patch 必须是对象（name / note / coverKey）' }, 400);
          return true;
        }
        const table = pure.updateCollection(libcolLoad(deps), body.id, body.patch);
        libcolSave(deps, table);
        const items = libcolDecorated(deps, table);
        sendJson({ ok: true, id: body.id, item: items.find((item) => item.id === body.id) ?? null, total: items.length });
        return true;
      }

      if (pathname === LIBCOL_ROUTE_REMOVE && req.method === 'POST') {
        const body = await libcolReadBody(request);
        if (!libcolIsPlainObject(body) || !String(body.id ?? '').trim()) {
          sendJson({ ok: false, error: '请提供要删除的集合 id' }, 400);
          return true;
        }
        const table = pure.removeCollection(libcolLoad(deps), body.id);
        libcolSave(deps, table);
        const items = libcolDecorated(deps, table);
        sendJson({ ok: true, removed: body.id, total: items.length });
        return true;
      }

      if (pathname === LIBCOL_ROUTE_MEMBERS && req.method === 'POST') {
        const body = await libcolReadBody(request);
        if (!libcolIsPlainObject(body)) {
          sendJson({ ok: false, error: '请求体必须是 JSON 对象（{id, add?, remove?}）' }, 400);
          return true;
        }
        const add = body.add;
        const remove = body.remove;
        if (add !== undefined && !Array.isArray(add)) {
          sendJson({ ok: false, error: 'add 必须是数组' }, 400);
          return true;
        }
        if (remove !== undefined && !Array.isArray(remove)) {
          sendJson({ ok: false, error: 'remove 必须是数组' }, 400);
          return true;
        }
        if (!Array.isArray(add) && !Array.isArray(remove)) {
          sendJson({ ok: false, error: 'add 和 remove 至少给一个（都是数组）' }, 400);
          return true;
        }
        let table = libcolLoad(deps);
        if (Array.isArray(add) && add.length) table = pure.addKeys(table, body.id, add);
        if (Array.isArray(remove) && remove.length) table = pure.removeKeys(table, body.id, remove);
        libcolSave(deps, table);
        const items = libcolDecorated(deps, table);
        sendJson({ ok: true, id: body.id, item: items.find((item) => item.id === body.id) ?? null, total: items.length });
        return true;
      }

      // 已知路径但方法不对：GET 打 POST 路径要明确 405，不能落到 404 让人以为路由没上。
      if (req.method === 'GET') {
        sendJson({ ok: false, error: '该接口只支持 POST' }, 405);
        return true;
      }
      if (req.method === 'POST') {
        sendJson({ ok: false, error: '该接口只支持 GET' }, 405);
        return true;
      }
      sendJson({ ok: false, error: `不支持的请求方法：${req.method}` }, 405);
      return true;
    } catch (error) {
      libcolFail(sendJson, error);
      return true;
    }
  }
// @bridge-function handleConsoleLibraryCollections:end

  return { handleConsoleLibraryCollections };
}
