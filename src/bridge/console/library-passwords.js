// 解压密码本：用户给一次，之后同类压缩包自动带上。
//
// 为什么单独一个模块：密码是敏感数据，读写只应该有一处；解压（library-extract）与
// 下载完自动解压（library-download）都要用它，谁都不该自己再解析一遍 JSON。
//
// 安全约定：
// - state/booth-passwords.json 里是明文（要能真解压），但**任何响应/日志都不回明文**：
//   GET 只给 masked（固定 6 个点）与 updatedAt，解压接口只给 hasPassword 布尔。
// - agent 调用一律 403：浏览器/脚本都能读控制台，凭什么让智能体翻密码。
// - 键：素材用素材页的 key，下载/已购路径用 `booth:<号>`；同一件两个键可能都存在。
//
// 为什么零 import：这个模块会被 vm 裸执行，fs/path/原子写都由 bridge.js 注入 deps。
const LIBPW_FILE = 'booth-passwords.json';
const LIBPW_VERSION = 1;
const LIBPW_MAX_ITEMS = 200;
const LIBPW_MAX_LEN = 64;
const LIBPW_MASK = '••••••';

function libpwPath(deps) {
  return deps.path.join(String(deps.STATE_DIR), LIBPW_FILE);
}

// 文件坏了/手改成数组都当空：密码本坏了不该让解压整个不可用。
function libpwLoad(deps) {
  try {
    const raw = deps.fs.readFileSync(libpwPath(deps), 'utf8');
    const parsed = JSON.parse(raw);
    const items = parsed && typeof parsed.items === 'object' && !Array.isArray(parsed.items) ? parsed.items : {};
    return { version: LIBPW_VERSION, items };
  } catch {
    return { version: LIBPW_VERSION, items: {} };
  }
}

function libpwSave(deps, data) {
  const items = data && data.items && typeof data.items === 'object' ? data.items : {};
  // 只保留最近 200 条，别让密码本无限长（也顺手限制坏数据撑爆磁盘）。
  const entries = Object.entries(items).filter(([, value]) => value && typeof value.password === 'string');
  entries.sort((a, b) => Number(b[1].updatedAt || 0) - Number(a[1].updatedAt || 0));
  const kept = {};
  for (const [key, value] of entries.slice(0, LIBPW_MAX_ITEMS)) kept[key] = value;
  deps.atomicWriteJson(libpwPath(deps), { version: LIBPW_VERSION, items: kept });
  return { version: LIBPW_VERSION, items: kept };
}

function libpwKeyOf(input) {
  const key = String((input && input.key) || '').trim();
  if (key) return key;
  const boothId = String((input && input.boothId) || '').trim();
  return boothId ? `booth:${boothId}` : '';
}

// 标题只是给人看的索引；从已购台账里捞，捞不到留空串，绝不为了标题去敲 BOOTH。
function libpwTitleOf(deps, boothId) {
  const id = String(boothId || '').trim();
  if (!id) return '';
  try {
    const raw = deps.fs.readFileSync(deps.path.join(String(deps.STATE_DIR), 'booth-purchases.json'), 'utf8');
    const parsed = JSON.parse(raw);
    // items 是「键 → 条目」的对象（键不一定是号，真机是随机短码），所以按值找 boothId。
    const entries = parsed && parsed.items;
    const list = Array.isArray(entries) ? entries : (entries && typeof entries === 'object' ? Object.values(entries) : []);
    const hit = list.find((item) => String(item && item.boothId) === id);
    return hit ? String(hit.title || '') : '';
  } catch {
    return '';
  }
}

function libpwPublicEntry(key, value) {
  return {
    key,
    boothId: String((value && value.boothId) || ''),
    title: String((value && value.title) || ''),
    masked: LIBPW_MASK,
    // manual = 用户手填 / auto = 从素材名里认出（解压码自动识别），前端据此显示来源、也方便排序。
    codeSource: String((value && value.codeSource) || 'manual'),
    updatedAt: Number((value && value.updatedAt) || 0)
  };
}

// 给解压用：按 key 优先、boothId 兜底，最多返回 1 条（用户手动输入的密码由调用方先排）。
function libpwCandidates(deps, input) {
  const data = libpwLoad(deps);
  const key = libpwKeyOf(input);
  const entry = (key && data.items[key]) || null;
  const picked = entry && typeof entry.password === 'string' ? entry.password : '';
  return picked ? [picked] : [];
}

function libpwHas(deps, input) {
  return libpwCandidates(deps, input).length > 0;
}

function libpwParseBody(body) {
  const password = String((body && body.password) || '').trim();
  if (!password) return { ok: false, error: '请填解压密码（不能是空的）' };
  if (password.length > LIBPW_MAX_LEN) return { ok: false, error: `密码最多 ${LIBPW_MAX_LEN} 个字符` };
  const key = libpwKeyOf(body);
  if (!key) return { ok: false, error: '请给 key（素材页的 key）或 boothId' };
  return { ok: true, key, password };
}

function libpwFactory(deps) {
  // @bridge-function lookupPasswords:start
  function lookupPasswords(input) {
    return libpwCandidates(deps, input || {});
  }
// @bridge-function lookupPasswords:end

  // @bridge-function hasPassword:start
  function hasPassword(input) {
    return libpwHas(deps, input || {});
  }
// @bridge-function hasPassword:end

  // 解压成功且密码是用户这次输的 → 记下来；密码本自己命中的不重复写（updatedAt 不该被自动带出刷）。
  // @bridge-function rememberPassword:start
  function rememberPassword(input) {
    const key = libpwKeyOf(input);
    const password = String((input && input.password) || '').trim();
    if (!key || !password) return { ok: false, error: '缺少 key/boothId 或密码' };
    if (password.length > LIBPW_MAX_LEN) return { ok: false, error: `密码最多 ${LIBPW_MAX_LEN} 个字符` };
    const boothId = String((input && input.boothId) || '').trim() || key.replace(/^booth:/, '');
    const data = libpwLoad(deps);
    data.items[key] = {
      boothId,
      title: String((input && input.title) || '') || libpwTitleOf(deps, boothId),
      password,
      // 用户手填永远标 manual：后面自动识别只会补空缺，不会盖掉这条。
      codeSource: 'manual',
      updatedAt: Date.now()
    };
    const saved = libpwSave(deps, data);
    deps.log(`[密码本] 记住 ${key} 的解压密码（长度 ${password.length}）`);
    return { ok: true, entry: libpwPublicEntry(key, saved.items[key]) };
  }
// @bridge-function rememberPassword:end

  // 自动识别出来的解压码入本（解压码自动识别）：只在没有「用户手填」的条目时写，
  // 已有手填的一律让路（用户填的永远可覆盖）。同一串码重复识别不刷 updatedAt。
  // @bridge-function rememberAutoPassword:start
  function rememberAutoPassword(input) {
    const key = libpwKeyOf(input);
    const password = String((input && input.password) || '').trim();
    const source = String((input && input.source) || '').trim() || '素材名';
    if (!key || !password) return { ok: false, error: '缺少 key/boothId 或密码' };
    if (password.length > LIBPW_MAX_LEN) return { ok: false, error: `密码最多 ${LIBPW_MAX_LEN} 个字符` };
    const boothId = String((input && input.boothId) || '').trim() || key.replace(/^booth:/, '');
    const data = libpwLoad(deps);
    const existing = data.items[key] || null;
    if (existing && existing.codeSource !== 'auto') {
      // 手填优先：哪怕这次认出来的码不一样，也不动用户的。
      return { ok: true, written: false, reason: 'manual-wins', entry: libpwPublicEntry(key, existing) };
    }
    if (existing && String(existing.password || '') === password) {
      return { ok: true, written: false, reason: 'unchanged', entry: libpwPublicEntry(key, existing) };
    }
    data.items[key] = {
      boothId,
      title: String((input && input.title) || '') || libpwTitleOf(deps, boothId),
      password,
      codeSource: 'auto',
      source,
      updatedAt: Date.now()
    };
    const saved = libpwSave(deps, data);
    // 「这条码从哪来」只打一行：控制台日志里要能追溯，但不该刷屏、也绝不回明文。
    deps.log(`[密码本] 自动记下 ${key} 的解压码（来源：${source}）`);
    return { ok: true, written: true, entry: libpwPublicEntry(key, saved.items[key]) };
  }
// @bridge-function rememberAutoPassword:end

  // @bridge-function removePassword:start
  function removePassword(input) {
    const key = libpwKeyOf(input);
    if (!key) return { ok: false, status: 400, error: '请给 key 或 boothId' };
    const data = libpwLoad(deps);
    if (!data.items[key]) return { ok: false, status: 404, error: '密码本里没有这条' };
    delete data.items[key];
    libpwSave(deps, data);
    deps.log(`[密码本] 删掉 ${key} 的解压密码`);
    return { ok: true, removed: key };
  }
// @bridge-function removePassword:end

  // @bridge-function handleConsoleLibraryPasswords:start
  async function handleConsoleLibraryPasswords(request) {
    const { req, res, url, sendJson, readBody } = request;
    void res;
    const path = url.pathname;
    const isList = path === '/api/library/passwords';
    const isRemove = path === '/api/library/passwords/remove';
    if (!isList && !isRemove) return false;
    if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
      sendJson({ ok: false, error: '未授权：密码本是管理端操作' }, 403);
      return true;
    }
    if (isList) {
      if (req.method === 'GET') {
        const data = libpwLoad(deps);
        const entries = Object.entries(data.items)
          .map(([key, value]) => libpwPublicEntry(key, value))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        sendJson({ ok: true, count: entries.length, entries });
        return true;
      }
      if (req.method !== 'POST') { sendJson({ ok: false, error: '该接口只支持 GET 或 POST' }, 405); return true; }
    } else if (req.method !== 'POST') {
      sendJson({ ok: false, error: '该接口只支持 POST' }, 405);
      return true;
    }
    let body = {};
    try {
      body = (await readBody()) || {};
    } catch {
      sendJson({ ok: false, error: '请求体不是合法 JSON' }, 400);
      return true;
    }
    if (isRemove) {
      const result = removePassword(body);
      if (!result.ok) { sendJson({ ok: false, error: result.error }, result.status || 400); return true; }
      sendJson(result);
      return true;
    }
    const parsed = libpwParseBody(body);
    if (!parsed.ok) { sendJson({ ok: false, error: parsed.error }, 400); return true; }
    const result = rememberPassword({ key: parsed.key, boothId: body.boothId, password: parsed.password, title: body.title });
    sendJson({ ok: true, entry: result.entry });
    return true;
  }
// @bridge-function handleConsoleLibraryPasswords:end

  return { handleConsoleLibraryPasswords, lookupPasswords, hasPassword, rememberPassword, rememberAutoPassword, removePassword };
}

/**
 * 密码本工厂（VM-safe：构造期不读 deps，全部推迟到调用时）。
 */
export function createLibraryPasswords(deps) {
  let impl = null;
  const ensure = () => {
    if (!impl) impl = libpwFactory(deps);
    return impl;
  };
  return {
    handleConsoleLibraryPasswords: (request) => ensure().handleConsoleLibraryPasswords(request),
    lookupPasswords: (input) => ensure().lookupPasswords(input),
    hasPassword: (input) => ensure().hasPassword(input),
    rememberPassword: (input) => ensure().rememberPassword(input),
    rememberAutoPassword: (input) => ensure().rememberAutoPassword(input),
    removePassword: (input) => ensure().removePassword(input)
  };
}
