// 下载后解压 / 手动解压（MioVRC 那种「下载完就能用」）。
//
// 约束（安全第一）：
// - **永不删原 zip**：zip-extract 本身就不删，这里也不删；只写 zip 同级的 `<stem>/` 目录。
// - 解压目标目录重复时加 `.1` / `.2`，绝不覆盖用户已解出来的文件。
// - 条目路径穿越由 src/zip-extract.js 统一拦（`unsafe_path` 跳过，不写到根外）。
// - 加密包：有密码本/用户这次输了密码才解；解不开就回「可重试」的 200，下载本身仍然算 done。
// - 全程只认 fileArchiveRootDir 里的相对路径，越界一律拒绝。
//
// 为什么零 import：这个模块会被 vm 裸执行，deps 由 bridge.js 装配注入
// （zip 能力在 deps.zipExtractPure，素材视图在 deps.buildLibrarySnapshot）。
const LIBEXT_LOG_FILE = 'library-extracts.json';
const LIBEXT_LOG_MAX = 20;
const LIBEXT_PREVIEW_MAX = 20;
const LIBEXT_ENC_ERROR = '这个压缩包有密码，输一次就好（会记在本机密码本里）';
const LIBEXT_AES_ERROR = '这个压缩包是 AES 加密的，暂时解不了（换成 ZipCrypto 加密的包，或先手动解压）';
const LIBEXT_BAD_PASSWORD = '密码不对，再试一次';

// 解压密码的三条来源（优先级从高到低）：用户这次显式传入 → 本机密码本 → zip-extract 内部的
// archive-info 候选。这里只负责前两条，第三条由 zip-extract 的 passwords 队列继续试。
function libextPasswordCandidates(deps, input, target, autoCode) {
  const userPassword = typeof input?.password === 'string' ? input.password.trim() : '';
  const book = deps.libraryPasswords && typeof deps.libraryPasswords.lookupPasswords === 'function'
    ? deps.libraryPasswords.lookupPasswords({ key: String(input?.key || ''), boothId: String(target?.boothId || '') })
    : [];
  const passwords = [];
  for (const value of book) {
    const text = String(value == null ? '' : value).trim();
    if (text && text !== userPassword && !passwords.includes(text)) passwords.push(text);
  }
  // 最后才是这次现认出来的码（密码本里已经有它时上面就带上了，不会重复）。
  const auto = autoCode && autoCode.code ? String(autoCode.code).trim() : '';
  if (auto && auto !== userPassword && !passwords.includes(auto)) passwords.push(auto);
  return { userPassword, passwords };
}

// 解压码自动识别：文件名/标题/目录名里常带 `[解压码: xxxx]`，纯规则在 src/library-extract-code.js
// （零 import，由 bridge.js 挂成 deps.libraryExtractCodePure）。
function libextAutoCode(deps, target, input) {
  const pure = deps.libraryExtractCodePure;
  if (!pure || typeof pure.pickBestExtractCode !== 'function') return null;
  try {
    return pure.pickBestExtractCode({
      fileName: String((target && target.fileName) || ''),
      title: String((target && target.title) || ''),
      dir: String((target && target.dir) || ''),
      text: String((input && input.text) || '')
    });
  } catch (error) {
    deps.log(`[解压] 解压码识别失败（忽略）：${error?.message ?? error}`);
    return null;
  }
}

// 认出来的码顺手入密码本（codeSource:'auto'）：用户手填的那条永远优先，这里只补空缺。
function libextLearnCode(deps, target, input, picked) {
  const book = deps.libraryPasswords;
  if (!book || typeof book.rememberAutoPassword !== 'function') return;
  try {
    book.rememberAutoPassword({
      key: String((input && input.key) || ''),
      boothId: String((target && target.boothId) || ''),
      password: String(picked.code || ''),
      title: String((target && target.title) || ''),
      source: `素材${picked.field || '文件名'}识别`
    });
  } catch (error) {
    deps.log(`[解压] 自动记密码失败（忽略）：${error?.message ?? error}`);
  }
}

// 解压失败原因 → 人话 + 机器可读 reason。密码类错误在控制台是「可重试」的 200，不是 500。
function libextEncReason(result) {
  const reason = String(result?.reason || '');
  const triedPasswords = Number(result?.triedPasswords) || 0;
  if (reason === 'password_required') return { reason, triedPasswords, error: LIBEXT_ENC_ERROR };
  if (reason === 'bad_password') return { reason, triedPasswords, error: `${LIBEXT_BAD_PASSWORD}（试了 ${triedPasswords} 个）` };
  if (reason === 'aes_unsupported') return { reason, triedPasswords, error: LIBEXT_AES_ERROR };
  return null;
}

function libextNow(deps) {
  return typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
}

function libextRoot(deps) {
  const raw = typeof deps.fileArchiveRootDir === 'function' ? deps.fileArchiveRootDir() : deps.fileArchiveRootDir;
  return raw ? String(raw) : '';
}

function libextLogPath(deps) {
  return deps.path.join(String(deps.STATE_DIR), LIBEXT_LOG_FILE);
}

// 解压历史只留最近 20 条；文件坏了当空，不能让一个手改的 JSON 挡住解压本身。
function libextLoadLog(deps) {
  try {
    const raw = deps.fs.readFileSync(libextLogPath(deps), 'utf8');
    const parsed = JSON.parse(raw);
    return { items: Array.isArray(parsed?.items) ? parsed.items : [] };
  } catch {
    return { items: [] };
  }
}

function libextSaveLog(deps, log) {
  try {
    deps.atomicWriteJson(libextLogPath(deps), { items: log.items.slice(-LIBEXT_LOG_MAX) });
  } catch (error) {
    deps.log(`[解压] 历史落盘失败：${error?.message ?? error}`);
  }
}

function libextDlJobs(deps) {
  try {
    const parsed = JSON.parse(deps.fs.readFileSync(deps.path.join(String(deps.STATE_DIR), 'booth-downloads.json'), 'utf8'));
    return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

// 手动解压成功后回填下载台账里的 job.extract：前端只轮询 /api/library/downloads，
// 不回填它就只能退回 asset.extracted。同一件重复解压只更新那条 job，不新建记录。
function libextBackfillJob(deps, view) {
  const boothId = String((view && view.boothId) || '').trim();
  if (!/^\d{5,9}$/.test(boothId) || !view || view.ok !== true) return false;
  const file = deps.path.join(String(deps.STATE_DIR), 'booth-downloads.json');
  let state = null;
  try { state = JSON.parse(deps.fs.readFileSync(file, 'utf8')); } catch { return false; }
  const jobs = Array.isArray(state && state.jobs) ? state.jobs : null;
  // 匹配不能只看 asset.boothId：素材页的号常是名字前缀（6985553），台账/目录用的是 BOOTH 号（5197537）。
  // 所以依次按 zip 主名 stem、zip 所在目录名、boothId 三种键找，任一对上就算同一件。
  const stemOf = (name) => String(name || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').trim();
  const zipStem = stemOf(view && view.zipRel);
  const zipDir = String((view && view.zipRel) || '').split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] || '';
  const hit = (row) => Boolean(row) && (String(row.boothId || '') === boothId || (zipStem && stemOf(row.fileName) === zipStem) || (zipDir && String(row.boothId || '') === zipDir));
  const job = jobs ? jobs.find((row) => hit(row) && row.state === 'done') || jobs.find(hit) : null;
  if (!job || job.state !== 'done') return false;
  job.extract = { state: 'done', files: Number(view.files) || 0, bytes: Number(view.bytes) || 0, destDirRel: String(view.destDirRel || ''), at: libextNow(deps) };
  if (view.destDirRel) job.destDirRel = String(view.destDirRel);
  try { deps.atomicWriteJson(file, state); } catch { return false; }
  deps.log(`[解压] #${boothId} 回填下载台账：job.extract 已更新（重复解压只更新不新增）`);
  return true;
}

function libextStemOf(name) {
  const text = String(name || '').trim();
  const base = text.replace(/\\/g, '/').split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).slice(0, 120) || 'archive';
}

// 解压目标目录：`<zip 同级>/<stem>`；已存在就 `.1`、`.2`……（绝不覆盖）。
function libextPickDest(deps, parentAbs, stem) {
  for (let index = 0; index <= 999; index += 1) {
    const name = index === 0 ? stem : `${stem}.${index}`;
    const abs = deps.path.join(parentAbs, name);
    if (!deps.fs.existsSync(abs)) return { abs, name };
  }
  return null;
}

// safeResolveInside 遇到 ../ 这类非法相对路径会抛错（validateArchiveRelPath），
// 而这里的 relPath 来自下载台账/素材卡（用户可手改），所以统一兜成 {ok:false} 再回 400，
// 绝不能让异常冒到 handler 变成 500，更不能绕过档案根解压。
function libextSafeAbs(deps, root, relPath) {
  try {
    const abs = deps.safeResolveInside(root, relPath);
    return abs ? { ok: true, abs } : { ok: false };
  } catch (error) {
    return { ok: false, why: String(error?.message ?? error) };
  }
}

// 从下载台账找已下载的 zip（台账里只记 fileName，路径规则与下载模块一致：<root>/<boothId>/<fileName>）。
function libextZipFromDownloads(deps, boothId) {
  const root = libextRoot(deps);
  if (!root) return { ok: false, status: 404, error: '转存目录还没配（config.json 的 fileArchive.dir）' };
  const id = String(boothId || '').trim();
  const jobs = libextDlJobs(deps);
  // 缩略图也走同一个下载器（fileName 会是 xxx.thumbnail.png）：按号找 job 时只认压缩包后缀，
  // 多个候选按 finishedAt 最新优先，否则「先下封面再下包」的号会永远挑到封面。
  const done = jobs.filter((item) => String(item?.boothId || '') === id && String(item?.state || '') === 'done');
  const archives = done
    .filter((item) => /\.(zip|7z|rar|tar|tar\.gz|tgz|unitypackage)$/i.test(String(item.fileName || item.name || '')))
    .sort((a, b) => Number(b.finishedAt || 0) - Number(a.finishedAt || 0));
  const job = archives[0];
  if (!job) {
    const pending = jobs.find((item) => String(item?.boothId || '') === id);
    if (!pending) return { ok: false, status: 404, error: '下载台账里没有这件，先下载再解压' };
    if (String(pending.state || '') !== 'done') return { ok: false, status: 409, error: `这件的下载还没完成（当前状态：${pending.state || '未知'}）` };
    return { ok: false, status: 400, error: '这个商品只下过封面，没有压缩包（再点一次下载会下包）' };
  }
  const fileName = String(job.fileName || job.name || '');
  const dirRel = id.replace(/\D/g, '').slice(0, 12) || 'unknown';
  const relPath = deps.path.join(dirRel, fileName);
  const inside = libextSafeAbs(deps, root, relPath);
  if (!inside.ok) return { ok: false, status: 400, error: `下载台账里的文件名不合法（${inside.why || relPath}），拒绝解压` };
  if (!deps.fs.existsSync(inside.abs)) return { ok: false, status: 404, error: '压缩包不在磁盘上（可能被移动或清掉了）' };
  return { ok: true, zipAbs: inside.abs, zipRel: relPath, boothId: id, fileName, title: String(job.title || ''), dir: '' };
}

// 从素材库找主件 zip（key 是素材页那个 contentKey）。
function libextZipFromAssets(deps, key) {
  const root = libextRoot(deps);
  if (!root) return { ok: false, status: 404, error: '转存目录还没配（config.json 的 fileArchive.dir）' };
  const wanted = String(key || '').trim();
  let snapshot = null;
  try {
    snapshot = typeof deps.buildLibrarySnapshot === 'function' ? deps.buildLibrarySnapshot({ fs: deps.fs, rootDir: root }) : null;
  } catch (error) {
    return { ok: false, status: 500, error: `扫描素材库失败：${error?.message ?? error}` };
  }
  const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : [];
  const asset = assets.find((item) => String(item?.key || '') === wanted);
  if (!asset) return { ok: false, status: 404, error: '库里找不到这件素材（可能刚被移动/改名）' };
  // 素材卡的真实形状是 mainName（相对路径要自己按 dir 拼），只有少数调用方会给 main 对象；
  // 两种都认，免得真库里一串 zip 都被判「主件不是压缩包」。
  const main = asset.main || (asset.mainName ? { name: String(asset.mainName), relPath: deps.path.join(String(asset.dir || ''), String(asset.mainName)) } : null);
  if (!main || !/\.(zip|unitypackage)$/i.test(String(main.name || ''))) return { ok: false, status: 400, error: '这件的主件不是压缩包，不用解压' };
  const relPath = String(main.relPath || main.name || '').split(String.fromCharCode(92)).join('/');
  const inside = libextSafeAbs(deps, root, relPath);
  if (!inside.ok) return { ok: false, status: 400, error: `素材主件路径不合法（${inside.why || relPath}），拒绝解压` };
  if (!deps.fs.existsSync(inside.abs)) return { ok: false, status: 404, error: '压缩包不在磁盘上（可能被移动或清掉了）' };
  // title/dir 带出去只给「解压码自动识别」用：素材名和目录名里常写 [解压码: xxx]。
  return { ok: true, zipAbs: inside.abs, zipRel: relPath, boothId: String(asset.boothId || ''), fileName: String(main.name || ''), title: String(asset.displayTitle || asset.title || ''), dir: String(asset.dir || '') };
}

function libextResolve(deps, input) {
  const key = String(input?.key || '').trim();
  const boothId = String(input?.boothId || '').trim();
  if (!key && !boothId) return { ok: false, status: 400, error: '请给 key（素材页的 key）或 boothId' };
  return boothId ? libextZipFromDownloads(deps, boothId) : libextZipFromAssets(deps, key);
}

function libextParseDryRun(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: false };
  if (raw === true || raw === 'true') return { ok: true, value: true };
  if (raw === false || raw === 'false') return { ok: true, value: false };
  return { ok: false, error: 'dryRun 只认 true 或 false（字符串 "true"/"false" 也行）' };
}

function libextBool(value) {
  return value === true || value === 'true';
}

// 解压后的目录（相对档案根），前端拿去拼「打开目录」。
function libextRelOf(deps, abs) {
  const root = libextRoot(deps);
  if (!root) return '';
  return deps.path.relative(root, abs).replace(/\\/g, '/');
}

function libextLogItem(deps, input, result) {
  const log = libextLoadLog(deps);
  const item = {
    key: String(input.key || ''),
    boothId: String(input.boothId || result.boothId || ''),
    zip: String(result.zipRel || ''),
    destDir: String(result.destDirRel || ''),
    files: Number(result.files) || 0,
    bytes: Number(result.bytes) || 0,
    skipped: Array.isArray(result.skipped) ? result.skipped.length : 0,
    at: libextNow(deps)
  };
  log.items.push(item);
  libextSaveLog(deps, log);
  return item;
}

function libextStatusJson(deps, impl) {
  const log = libextLoadLog(deps);
  return {
    ok: true,
    running: impl.active > 0,
    active: impl.active,
    items: log.items.slice(-LIBEXT_LOG_MAX)
  };
}

function libextFactory(deps) {
  const impl = { active: 0 };

  // 解压一件：调用方给 {key} 或 {boothId}；dryRun 只看目录。
  // 这个入口同时给下载模块的「下载完自动解压」用，保证两条路径行为一致。
  // @bridge-function extractLibraryAsset:start
  async function extractLibraryAsset(input) {
    const target = libextResolve(deps, input || {});
    if (!target.ok) return { ok: false, status: target.status || 400, error: target.error };
    const dryRun = libextBool(input?.dryRun) || input?.dryRun === true;
    // 密码来源：手动输入的优先，其次本机密码本（两者都不命中时 zip-extract 会自己试 archive-info 候选）。
    // 先认名里的解压码（入密码本，手填的不会被盖），再拼本次要试的候选。
    const autoCode = libextAutoCode(deps, target, input);
    if (autoCode) libextLearnCode(deps, target, input, autoCode);
    const pwd = libextPasswordCandidates(deps, input || {}, target, autoCode);
    const hasPassword = pwd.userPassword !== '' || pwd.passwords.length > 0;
    const zipName = String(target.fileName || deps.path.basename(target.zipAbs));
    const parentAbs = deps.path.dirname(target.zipAbs);
    const stem = libextStemOf(zipName);
    const destChoice = libextPickDest(deps, parentAbs, stem);
    if (!destChoice) return { ok: false, status: 500, error: '目标目录名都被占用了（同名太多），先整理一下' };
    const base = {
      boothId: String(target.boothId || ''),
      zipRel: String(target.zipRel || ''),
      destDirRel: libextRelOf(deps, destChoice.abs),
      encrypted: false,
      hasPassword,
      skipped: []
    };

    if (dryRun) {
      const preview = await deps.zipExtractPure.listZipPreview(target.zipAbs, { maxEntries: LIBEXT_PREVIEW_MAX });
      if (!preview.ok) return { ok: false, status: 400, error: `这个压缩包读不了（${preview.error}）`, ...base };
      const directory = await deps.zipExtractPure.readZipDirectoryFromFile(target.zipAbs);
      const entries = Array.isArray(directory?.entries) ? directory.entries : preview.entries;
      let totalBytes = 0;
      for (const entry of entries) totalBytes += Number(entry.size) || 0;
      return {
        ok: true,
        dryRun: true,
        ...base,
        destDirRel: base.destDirRel,
        zipEntries: entries.length,
        zipBytes: totalBytes,
        encrypted: directory?.encrypted === true,
        encryption: String(directory?.encryption || (directory?.encrypted ? 'zipcrypto' : 'none')),
        preview: preview.entries
      };
    }

    impl.active += 1;
    try {
      const result = await deps.zipExtractPure.extractZipToDir(target.zipAbs, destChoice.abs, {
        keepZip: true,
        password: pwd.userPassword || undefined,
        passwords: pwd.passwords
      });
      const view = {
        ...base,
        ok: result.ok === true,
        files: Number(result.files) || 0,
        bytes: Number(result.bytes) || 0,
        skipped: Array.isArray(result.skipped) ? result.skipped : [],
        encrypted: result.encrypted === true,
        encryption: String(result.encryption || (result.encrypted ? 'zipcrypto' : 'none')),
        reason: String(result.reason || ''),
        triedPasswords: Number(result.triedPasswords) || 0,
        error: String(result.error || '')
      };
      const encFail = !view.ok ? libextEncReason(result) : null;
      if (encFail) {
        view.reason = encFail.reason;
        view.triedPasswords = encFail.triedPasswords;
        view.error = encFail.error;
      } else if (!view.ok && !view.error) view.error = '解压失败（未知原因）';
      else if (!view.ok) view.error = `解压失败（${view.error}）`;
      else view.error = '';
      // 用户这次手输的密码解开了 → 记住；密码本自己命中的不重复写（updatedAt 不该被自动带出刷）。
      if (view.ok && pwd.userPassword && String(result.usedPassword || '') === pwd.userPassword
        && deps.libraryPasswords && typeof deps.libraryPasswords.rememberPassword === 'function') {
        deps.libraryPasswords.rememberPassword({ key: String(input?.key || ''), boothId: String(target.boothId || ''), password: pwd.userPassword });
        view.hasPassword = true;
      }
      libextLogItem(deps, input || {}, view);
      libextBackfillJob(deps, view);
      const label = view.boothId || String(input?.key || '');
      deps.log(`[解压] ${label} ${view.ok ? `解出 ${view.files} 个文件 / ${view.bytes} 字节` : `失败：${view.error}`}`.replace(/\s+/g, ' ').trim());
      return view;
    } finally {
      impl.active -= 1;
    }
  }
// @bridge-function extractLibraryAsset:end

  // GET /api/library/extract/status：最近 20 条 + 是否在跑。
  // @bridge-function extractStatus:start
  function extractStatus() {
    return libextStatusJson(deps, impl);
  }
// @bridge-function extractStatus:end

  // @bridge-function handleConsoleLibraryExtract:start
  async function handleConsoleLibraryExtract(request) {
    const { req, res, url, sendJson, readBody } = request;
    void res;
    const path = url.pathname;
    const isPost = path === '/api/library/extract';
    const isStatus = path === '/api/library/extract/status';
    if (!isPost && !isStatus) return false;
    if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
      sendJson({ ok: false, error: '未授权：解压是管理端操作' }, 403);
      return true;
    }
    if (isStatus) {
      if (req.method !== 'GET') { sendJson({ ok: false, error: '该接口只支持 GET' }, 405); return true; }
      sendJson(extractStatus());
      return true;
    }
    if (req.method !== 'POST') { sendJson({ ok: false, error: '该接口只支持 POST' }, 405); return true; }
    let body = {};
    try {
      body = (await readBody()) || {};
    } catch {
      sendJson({ ok: false, error: '请求体不是合法 JSON' }, 400);
      return true;
    }
    const dry = libextParseDryRun(body.dryRun);
    if (!dry.ok) { sendJson({ ok: false, error: dry.error }, 400); return true; }
    // 密码：可选的字符串（最多 64 字）；非字符串直接 400，别让对象/数字静默变成 "[object Object]"。
    let password;
    if (body.password !== undefined && body.password !== null && body.password !== '') {
      if (typeof body.password !== 'string') { sendJson({ ok: false, error: 'password 必须是字符串' }, 400); return true; }
      password = body.password.trim();
      if (!password) { sendJson({ ok: false, error: 'password 不能是空白' }, 400); return true; }
      if (password.length > 64) { sendJson({ ok: false, error: 'password 最多 64 个字符' }, 400); return true; }
    }
    const result = await extractLibraryAsset({ key: body.key, boothId: body.boothId, dryRun: dry.value, password });
    if (result.ok) { sendJson(result); return true; }
    // 密码类失败是「可重试」的状态，不是服务器错误：200 + reason，前端弹输入框/提示 AES。
    if (result.reason === 'password_required' || result.reason === 'bad_password' || result.reason === 'aes_unsupported') {
      sendJson({ ok: false, reason: result.reason, triedPasswords: Number(result.triedPasswords) || 0, hasPassword: result.hasPassword === true, encrypted: result.encrypted === true, encryption: String(result.encryption || ''), error: result.error }, 200);
      return true;
    }
    sendJson(result, Number(result.status) || 400);
    return true;
  }
// @bridge-function handleConsoleLibraryExtract:end

  return { handleConsoleLibraryExtract, extractStatus, extractLibraryAsset };
}

/**
 * 解压模块工厂（VM-safe：构造期不读 deps，第一次请求才装配）。
 */
export function createLibraryExtract(deps) {
  let impl = null;
  const ensure = () => {
    if (!impl) impl = libextFactory(deps);
    return impl;
  };
  return {
    handleConsoleLibraryExtract: (request) => ensure().handleConsoleLibraryExtract(request),
    extractStatus: () => ensure().extractStatus(),
    extractLibraryAsset: (input) => ensure().extractLibraryAsset(input)
  };
}
