// 「一键导入 Unity 工程」：把某件已购商品的全部文件下载到素材库，再解到工程 Assets 下。
//
// 约束：本文件是 manifest 模块，被 scripts/bridge-source.mjs 用 vm.runInContext 裸执行，
// **不能 import**。下载入口、解压能力、工程根白名单匹配全部由 src/bridge.js 组装进 deps。
// 顶部不要有和 src/bridge.js 同名的 const/let（VM 里共用一个全局词法作用域）。

const LIBIMP_FILE = 'library-imports.json';
const LIBIMP_MAX_ENTRIES = 200;
const LIBIMP_EXTRA_INFO_MS = 120000;

function libimpFilePath(deps) {
  return deps.path.join(deps.STATE_DIR, LIBIMP_FILE);
}

function libimpLoad(deps) {
  try {
    const raw = JSON.parse(deps.fs.readFileSync(libimpFilePath(deps), 'utf8'));
    return { version: 1, items: raw && typeof raw.items === 'object' && raw.items ? raw.items : {} };
  } catch {
    return { version: 1, items: {} };
  }
}

function libimpSave(deps, state) {
  try {
    deps.atomicWriteJson(libimpFilePath(deps), { version: 1, at: Date.now(), items: state.items });
  } catch (error) {
    deps.log('[导入工程] 记录写入失败：' + (error && error.message ? error.message : error));
  }
}

// 标题当目录名：去掉 Windows 非法字符与末尾点/空格，限 60 字（太长会撞 260 路径上限）。
function libimpSafeDirName(title, boothId) {
  const base = String(title || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[.\s]+$/, '').trim();
  const name = base.slice(0, 60) || ('BOOTH_' + boothId);
  return name;
}

function libimpAnyPath(deps, base, rel) {
  const abs = deps.path.resolve(base, rel);
  const root = deps.path.resolve(base);
  if (abs !== root && !abs.toLowerCase().startsWith(root.toLowerCase() + deps.path.sep.toLowerCase())) {
    throw new Error('路径越界，拒绝操作：' + rel);
  }
  return abs;
}

function createLibraryImport(deps) {
  let buildLibraryImport = null;
  const api = () => {
    if (!buildLibraryImport) buildLibraryImport = buildImport(deps);
    return buildLibraryImport;
  };
  return {
    handleConsoleLibraryImport: (request) => api().handle(request),
  };
}

function buildImport(deps) {
  // 复用 console-server 的 readBody（它已经做了 Content-Length 预检、超限 413、30s 超时、JSON 解析）。
  const readBody = async (request) => {
    const value = await request.readBody({ maxBytes: 512 * 1024 });
    return value && typeof value === 'object' ? value : {};
  };

  const matchRoot = (usageRoot) => {
    const roots = deps.cfg && deps.cfg.fileArchive && Array.isArray(deps.cfg.fileArchive.usageRoots) ? deps.cfg.fileArchive.usageRoots : [];
    const value = String(usageRoot || '').trim();
    if (!value) return { ok: false, error: '请先选一个 Unity 工程（usageRoot 不能为空）' };
    if (typeof deps.matchConfiguredUsageRoot === 'function') {
      // matchConfiguredUsageRoot 是纯函数，返回「命中的那个根字符串」（空串=不匹配），不是 {ok,path}。
      const matched = deps.matchConfiguredUsageRoot(value, roots, { baseDir: deps.ROOT });
      const hit = typeof matched === 'string' ? matched : (matched && matched.ok === true ? String(matched.path || '') : '');
      if (hit) return { ok: true, path: deps.path.resolve(deps.ROOT || '.', hit), roots };
      const list = deps.libraryUsageRootsPure && deps.libraryUsageRootsPure.describeUsageRoots ? deps.libraryUsageRootsPure.describeUsageRoots(roots) : '';
      return { ok: false, error: '这个工程不在允许的扫描根里：' + value + (list ? '（当前配置：' + list + '）' : '（还没配置 fileArchive.usageRoots）') };
    }
    if (!roots.length) return { ok: false, error: '还没配置 Unity 工程根（fileArchive.usageRoots）' };
    const hit = roots.find((root) => String(root || '').trim().toLowerCase() === value.toLowerCase());
    return hit ? { ok: true, path: hit, roots } : { ok: false, error: '这个工程不在允许的扫描根里：' + value };
  };

  const importOne = async (boothId, rootAbs, listed, options) => {
    const destRel = deps.path.join('Assets', libimpSafeDirName(listed.title, boothId)).replace(/\\/g, '/');
    const destAbs = deps.safeResolveInside(rootAbs, destRel);
    deps.fs.mkdirSync(destAbs, { recursive: true });
    const queued = [];
    const errors = [];
    let files = 0;
    let bytes = 0;
    for (const file of listed.files) {
      const fileName = String(file && file.fileName ? file.fileName : '');
      if (!fileName) continue;
      const dir = deps.path.join(deps.fileArchiveRootDir(), boothId);
      let src;
      try {
        src = libimpAnyPath(deps, dir, fileName);
      } catch (error) {
        errors.push({ fileName, error: error.message });
        continue;
      }
      if (!deps.fs.existsSync(src)) {
        if (file.state === 'downloaded') {
          errors.push({ fileName, error: '素材库里找不到这个文件（台账说下过了，可能被手动删了）' });
          continue;
        }
        const started = await deps.downloadStart(boothId, file.url, 'import', listed.title, fileName);
        if (!started || started.ok === false) {
          errors.push({ fileName, error: String((started && started.error) || '入队失败') });
          continue;
        }
        const done = await deps.waitDownload(boothId, LIBIMP_EXTRA_INFO_MS);
        if (!done) {
          errors.push({ fileName, error: '下载没在 2 分钟内完成，稍后再点一次导入' });
          continue;
        }
        if (!deps.fs.existsSync(src)) {
          errors.push({ fileName, error: '下载完成了但文件不在预期位置' });
          continue;
        }
      }
      queued.push(fileName);
      try {
        if (/\.zip$/i.test(fileName)) {
          const result = await deps.zipExtractPure.extractZipToDir(src, destAbs, {
            keepZip: true,
            maxEntries: LIBIMP_MAX_ENTRIES * 10,
            password: options.password,
          });
          if (!result || result.ok !== true) {
            errors.push({ fileName, error: String((result && result.error) || '解压失败') });
            continue;
          }
          files += Number(result.files) || 0;
          bytes += Number(result.bytes) || 0;
        } else {
          const target = deps.path.join(destAbs, deps.path.basename(fileName));
          deps.fs.copyFileSync(src, target);
          files += 1;
          bytes += deps.fs.statSync(target).size;
        }
      } catch (error) {
        errors.push({ fileName, error: error && error.message ? error.message : String(error) });
      }
    }
    return { destRel, destAbs, queued, errors, files, bytes };
  };

// @bridge-function handleConsoleLibraryImport:start
  async function handleConsoleLibraryImport(request) {
    const url = new URL(String(request && request.url ? request.url : ''), 'http://127.0.0.1');
    if (url.pathname !== '/api/library/import-to-unity') return false;
    const headers = request && request.headers ? request.headers : {};
    if (headers['x-agent-token'] || headers['x-agent-call']) {
      request.sendJson({ ok: false, error: '未授权：导入工程是管理端操作' }, 403);
      return true;
    }
    if (request.method !== 'POST') {
      request.sendJson({ ok: false, error: '该接口只支持 POST' }, 405);
      return true;
    }
    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      request.sendJson({ ok: false, error: String(error && error.message ? error.message : error) }, 400);
      return true;
    }
    const boothId = String((body && body.boothId) || '').trim();
    if (!/^\d{5,9}$/.test(boothId)) {
      request.sendJson({ ok: false, error: '商品号要是 5~9 位数字' }, 400);
      return true;
    }
    const dryRun = body && (body.dryRun === true || body.dryRun === 'true');
    const root = matchRoot(body && body.usageRoot);
    if (!root.ok) {
      request.sendJson({ ok: false, error: root.error }, 400);
      return true;
    }
    let listed;
    try {
      listed = await deps.purchaseFiles.listPurchaseFiles(boothId, { refresh: false });
    } catch (error) {
      request.sendJson({ ok: false, error: '读已购文件清单失败：' + (error && error.message ? error.message : error) }, 500);
      return true;
    }
    if (!listed || listed.ok !== true) {
      const status = listed && listed.paused ? 409 : 400;
      request.sendJson({ ok: false, error: String((listed && listed.error) || '读已购文件清单失败'), paused: Boolean(listed && listed.paused) }, status);
      return true;
    }
    const state = libimpLoad(deps);
    const key = boothId + '@' + deps.path.resolve(root.path);
    const destRelPreview = deps.path.join('Assets', libimpSafeDirName(listed.title, boothId)).replace(/\\/g, '/');
    const pending = listed.files.filter((file) => file.state !== 'downloaded');
    if (state.items[key] && !dryRun) {
      request.sendJson({ ok: true, already: true, boothId, usageRoot: root.path, destRel: String(state.items[key].destRel || destRelPreview), imported: state.items[key] }, 200);
      return true;
    }
    if (dryRun) {
      request.sendJson({ ok: true, dryRun: true, boothId, usageRoot: root.path, title: listed.title, files: pending.map((file) => file.fileName), downloaded: listed.files.length - pending.length, destRel: destRelPreview }, 200);
      return true;
    }
    const result = await importOne(boothId, root.path, listed, { password: body && body.password });
    state.items[key] = { boothId, usageRoot: deps.path.resolve(root.path), title: listed.title, destRel: result.destRel, files: result.files, bytes: result.bytes, at: Date.now() };
    libimpSave(deps, state);
    deps.log('[导入工程] #' + boothId + ' → ' + result.destRel + '（' + result.files + ' 个文件）');
    request.sendJson({
      ok: result.errors.length === 0,
      dryRun: false,
      boothId,
      usageRoot: root.path,
      destRel: result.destRel,
      queued: result.queued,
      imported: { destRel: result.destRel, files: result.files, bytes: result.bytes },
      errors: result.errors,
    }, 200);
    return true;
  }
// @bridge-function handleConsoleLibraryImport:end

  return { handle: handleConsoleLibraryImport };
}

export { createLibraryImport };
