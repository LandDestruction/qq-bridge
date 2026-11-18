// 绑定表导出 / 导入：换机器、重装、搬目录时人工确认过的「素材 ↔ BOOTH 号」不丢。
//
// 为什么要单独一个模块：`state/booth-binds.json` 是唯一不可再生的数据（自动认号还能重跑，
// 人工绑定的判断重跑不出来）。导出成一坨可直接粘贴的 JSON、导入时**默认不覆盖已有绑定**，
// 这样两台机器的表可以互相同步，而不会被旧机器上的表覆盖掉新机器上刚钉的号。
//
// 为什么不能写 import：桥接模块被 vm.runInContext 裸执行（scripts/bridge-source.mjs），
// 出现 import 语句整个装配阶段就 SyntaxError。纯规则（normalizeBindTable / isBoothId）由
// src/bridge.js 组装成 deps.libraryBindsPure 传进来；下面还留了一个同口径兜底，万一哪天
// 接线漏了这个 dep，模块也只是「不支持兜底校验」，不会连导出都做不了。
//
// deps 一律在函数体里惰性取用、不在工厂里读：scripts/test-bridge-modules.mjs 会给每个
// 声明的依赖装「一碰就抛」的 getter，构造期读 deps 会直接判红（这是故意的，防装配顺序事故）。

const BIND_IO_FORMAT = 'qdb-booth-binds';
const BIND_IO_VERSION = 1;
/** 一次最多收多少条：绑定表正常几百条，上限只用来挡「粘错文件」把整张表灌爆。 */
const BIND_IO_MAX_ENTRIES = 5000;
const BIND_IO_TITLE_MAX = 200;
const BIND_IO_SOURCE = 'import';
/** 试运行预览最多回多少条：够看清「这批会动哪些」，又不至于把几百条塞进响应。 */
const BIND_IO_PREVIEW_MAX = 50;

const BIND_IO_ID_RE = /^\d{5,9}$/;

/** 兜底版 BOOTH 号校验（与 src/library-binds.js 的 isBoothId 同口径）。 */
function bindIoIsBoothId(value) {
  return BIND_IO_ID_RE.test(String(value == null ? '' : value).trim());
}

/** 兜底版规范化：坏值丢、版本号补齐（与 src/library-binds.js 的 normalizeBindTable 同口径）。 */
function bindIoNormalize(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const from = src.entries && typeof src.entries === 'object' && !Array.isArray(src.entries) ? src.entries : {};
  const entries = {};
  for (const [key, value] of Object.entries(from)) {
    const contentKey = String(key == null ? '' : key).trim();
    if (!contentKey) continue;
    const boothId = String(value && value.boothId != null ? value.boothId : '').trim();
    if (!bindIoIsBoothId(boothId)) continue;
    entries[contentKey] = {
      boothId,
      title: String(value && value.title != null ? value.title : '').slice(0, BIND_IO_TITLE_MAX),
      source: String(value && value.source != null ? value.source : 'manual').slice(0, 40) || 'manual',
      at: Number.isFinite(Number(value && value.at)) ? Number(value.at) : 0
    };
  }
  return { version: 1, entries };
}

export function createLibraryBindIo(deps) {
  /** 纯规则优先用注入的（唯一真源）；没接线时用上面的兜底。 */
  function pure() {
    return (deps && deps.libraryBindsPure) || {};
  }
  function normalize(raw) {
    const fn = pure().normalizeBindTable;
    return typeof fn === 'function' ? fn(raw) : bindIoNormalize(raw);
  }
  function validBoothId(value) {
    const fn = pure().isBoothId;
    return typeof fn === 'function' ? Boolean(fn(value)) : bindIoIsBoothId(value);
  }
  function statePath() {
    return (0, deps.path).join(String(deps.STATE_DIR), 'booth-binds.json');
  }

  /** 读盘坏了返回空表：导出是只读操作，脏文件不该让「备份一下」这件事本身失败。 */
  function readTable() {
    try {
      return normalize(JSON.parse((0, deps.fs).readFileSync(statePath(), 'utf8')));
    } catch {
      return normalize(null);
    }
  }

  function summaryOf(table) {
    const fn = pure().bindTableSummary;
    if (typeof fn === 'function') return fn(table);
    const values = Object.values(table.entries);
    return { version: table.version, count: values.length, uniqueIds: new Set(values.map((e) => e.boothId)).size };
  }

  /** 导出用的载荷：字段只挑换机器需要的，`version` 与 `exportedAt` 让接收端能判年代。 */
  function exportPayload(table) {
    return {
      ok: true,
      format: BIND_IO_FORMAT,
      version: BIND_IO_VERSION,
      exportedAt: new Date().toISOString(),
      entries: table.entries,
      count: Object.keys(table.entries).length,
      summary: summaryOf(table)
    };
  }

  /**
   * 把请求体摊平成一串 `{ contentKey, boothId, title }`。
   * 兼容三种手感：`{ entries: {key: {...}} }`（导出原样回灌）、`{ entries: [...] }`、
   * `{ table: {...} }`（整张表连 version 一起贴进来）。认不出的条目原样留给下面判非法。
   */
  function entriesOfBody(body) {
    const src = body && typeof body === 'object' ? body : {};
    const container = src.table && typeof src.table === 'object' && !Array.isArray(src.table) ? src.table : src;
    const raw = container.entries !== undefined ? container.entries : container;
    if (Array.isArray(raw)) {
      return raw.map((item) => ({
        contentKey: String((item && (item.contentKey || item.key)) || '').trim(),
        boothId: String((item && item.boothId) || '').trim(),
        title: String((item && item.title) || '').slice(0, BIND_IO_TITLE_MAX)
      }));
    }
    if (raw && typeof raw === 'object') {
      return Object.entries(raw).map(([key, value]) => ({
        contentKey: String(key == null ? '' : key).trim(),
        boothId: String((value && value.boothId) || '').trim(),
        title: String((value && value.title) || '').slice(0, BIND_IO_TITLE_MAX)
      }));
    }
    return [];
  }

  /**
   * 合并：默认「已有的不动」。
   * 为什么要这个默认：两台机器各钉过一批号，拿 A 的表灌 B 时，B 上更新的判断不该被 A 的旧判断覆盖；
   * 真要覆盖必须显式 `overwrite:true`（前端要二次确认）。
   */
  function mergeEntries(base, list, { overwrite = false, now = Date.now() } = {}) {
    const entries = { ...base.entries };
    let addedOnly = 0;
    let overwritten = 0;
    let skipped = 0;
    let invalid = 0;
    const skippedKeys = [];
    // 试运行要能逐条说清「会发生什么」，所以合并过程顺手记一份分类；真导入不用它，白算也便宜。
    const actions = [];
    for (const item of list) {
      const title = String(item.title || '').slice(0, BIND_IO_TITLE_MAX);
      if (!item.contentKey || !validBoothId(item.boothId)) {
        invalid += 1;
        actions.push({ contentKey: item.contentKey, boothId: item.boothId, title, action: 'invalid' });
        continue;
      }
      const exists = Boolean(entries[item.contentKey]);
      if (exists && !overwrite) {
        skipped += 1;
        skippedKeys.push(item.contentKey);
        actions.push({ contentKey: item.contentKey, boothId: item.boothId, title, action: 'skip' });
        continue;
      }
      entries[item.contentKey] = { boothId: item.boothId, title, source: BIND_IO_SOURCE, at: now };
      if (exists) overwritten += 1;
      else addedOnly += 1;
      actions.push({ contentKey: item.contentKey, boothId: item.boothId, title, action: exists ? 'overwrite' : 'add' });
    }
    return {
      table: { version: base.version, entries },
      // added 保持历史口径（真正写进表里的条数，含覆盖），新增 overwritten 单独标覆盖数；
      // 试运行的 added 才是「纯新增」，因为它要分别告诉人「新增几条、覆盖几条」。
      stat: { added: addedOnly + overwritten, addedOnly, overwritten, skipped, invalid, skippedKeys, actions }
    };
  }

  function writeTable(table) {
    const next = normalize(table);
    (0, deps.atomicWriteJson)(statePath(), next);
    return next;
  }

// @bridge-function handleConsoleLibraryBindIo:start
  async function handleConsoleLibraryBindIo(request) {
    const pathname = request.url.pathname;
    const isExport = pathname === '/api/library/binds/export';
    const isImport = pathname === '/api/library/binds/import';
    if (!isExport && !isImport) return false;
    // 和 /api/library/binds 同口径：绑定表只给管理端点，智能体令牌一律拒绝
    // （否则 AI 可以自己导出一份「哪件素材对应哪个商品号」再去拿它做事）。
    if (request.req.headers['x-agent-token'] || request.req.headers['x-agent-call']) {
      request.sendJson({ ok: false, error: '绑定表导出/导入只允许管理端操作' }, 403);
      return true;
    }
    if (isExport) {
      if (request.req.method !== 'GET') { request.sendJson({ ok: false, error: '导出只支持 GET' }, 405); return true; }
      request.sendJson(exportPayload(readTable()));
      return true;
    }
    if (request.req.method !== 'POST') { request.sendJson({ ok: false, error: '导入只支持 POST' }, 405); return true; }
    let body;
    try { body = await request.readBody(); }
    catch (error) { request.sendJson({ ok: false, error: error && error.message ? error.message : '请求体非法' }, Number(error && error.statusCode) || 400); return true; }
    const list = entriesOfBody(body).slice(0, BIND_IO_MAX_ENTRIES);
    if (!list.length) {
      request.sendJson({ ok: false, error: '没有可导入的条目（要 entries 对象或数组，或整张 table）' }, 400);
      return true;
    }
    const base = readTable();
    const overwrite = Boolean(body && body.overwrite);
    // 严格判定：只认布尔 true 或字符串 'true'。命令行/表单常把开关传成字符串，
    // 用 Boolean(body.dryRun) 会把 'false' 也当成试运行——那是反的，必须显式转。
    const rawDryRun = body && body.dryRun;
    const dryRun = rawDryRun === true || rawDryRun === 'true';
    const merged = mergeEntries(base, list, { overwrite, now: Date.now() });
    const stat = merged.stat;
    // 试运行优先级最高：合并照算（规则与真导入同一段代码），但落盘前就返回，state 一个字节都不动。
    if (dryRun) {
      (0, deps.log)(`素材库：试运行导入绑定 新增 ${stat.addedOnly} 条，覆盖 ${stat.overwritten} 条，跳过 ${stat.skipped} 条，非法 ${stat.invalid} 条（未写盘）`);
      request.sendJson({
        ok: true,
        dryRun: true,
        added: stat.addedOnly,
        overwritten: stat.overwritten,
        skipped: stat.skipped,
        invalid: stat.invalid,
        overwrite,
        // 前端预览只拿来列给人看，50 条足够看清「这批文件会动哪些」；再多就该直接看统计数字了。
        preview: stat.actions.slice(0, BIND_IO_PREVIEW_MAX)
      });
      return true;
    }
    // 一条都没导入、却全是非法号：这不是「成功导入了 0 条」，而是用户拿错了文件（格式对但号不对），
    // 回 200 会让前端显示「导入成功」——必须 400 说清楚，且不写盘（写盘也只是把原表原样覆盖一遍）。
    const importable = stat.addedOnly + stat.overwritten;
    if (importable === 0 && stat.invalid > 0) {
      request.sendJson({ ok: false, error: `没有一条能导入：${stat.invalid} 条商品号不合法`, invalid: stat.invalid, skipped: stat.skipped }, 400);
      return true;
    }
    let table;
    try {
      table = writeTable(merged.table);
    } catch (error) {
      request.sendJson({ ok: false, error: `绑定表写盘失败：${error && error.message ? error.message : error}` }, 500);
      return true;
    }
    (0, deps.log)(`素材库：导入绑定 ${stat.added} 条，跳过 ${stat.skipped} 条（已存在，未覆盖），非法 ${stat.invalid} 条`);
    request.sendJson({
      ok: true,
      added: stat.added,
      overwritten: stat.overwritten,
      skipped: stat.skipped,
      invalid: stat.invalid,
      overwrite,
      // 前端要能说清「跳过了哪几条」，但不该把几百个 key 全塞进 toast：只回前 20 个。
      skippedKeys: stat.skippedKeys.slice(0, 20),
      count: Object.keys(table.entries).length,
      summary: summaryOf(table)
    });
    return true;
    // 走到这里说明路径没匹配上（scripts/bridge-source.mjs 的路由展开按最后这个 return false; 切片，
    // 少了它会把函数体截到前面那个 if 里，静态守卫就看不见后面的分支）。
    // eslint-disable-next-line no-unreachable
    return false;
  }
// @bridge-function handleConsoleLibraryBindIo:end

  return { handleConsoleLibraryBindIo };
}
