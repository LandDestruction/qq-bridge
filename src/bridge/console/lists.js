// console/lists: 名单系统后端（7 个名单的读写 + AI 黑名单设置 + allowAllWhenEmpty 开关）。
//
// Live dependencies: aiBlacklist, atomicWriteJson, cfg, fs, groupMemberCache, groupMemberRefreshedAt, log, path, reloadConfigFromDisk, updateConfigFile
//
// 路由（console-server 只做路径分发，鉴权与 body 解析仍走集中的 consoleRequest）：
//   GET  /api/lists            → { ok, writable, flags, lists, ai }
//   POST /api/lists            → add / remove / clear（成功也回最新 views，前端不用二次 GET）
//   POST /api/lists/settings   → 仅 list:'ai' 的 enabled/mode/minIntervalMs/perHourMax/atMeReply
//   POST /api/lists/flag       → allowAllWhenEmpty
//
// 写盘边界：只碰 LISTS 里的 7 个路径 + allowAllWhenEmpty；一律 updateConfigFile（读盘-合并-写），
// 写前备份 config.json（只留最近 5 份），绝不整份重写 config，也绝不碰 allow.privateOpen /
// ownerQQ / dsh / snowluma。
const LIST_ID_RE = /^\d{5,20}$/;
const LIST_NOTE_MAX = 40;
const AI_SETTING_KEYS = Object.freeze(['enabled', 'mode', 'minIntervalMs', 'perHourMax', 'atMeReply']);
const AI_MODES = Object.freeze(['reduce', 'silent']);
const AI_DEFAULTS = Object.freeze({ enabled: false, mode: 'reduce', minIntervalMs: 600000, perHourMax: 3, atMeReply: true });
// 顺序固定（控制台左栏目录按这个顺序排）；kind 只用于前端选择「群号还是 QQ 号」的校验提示。
// objectEntries: 只有 ai-blacklist 在 config.json 里是 { id, note, addedAt } 对象数组；
// 其余 6 个名单必须是纯字符串数组（它们的消费方不止一处，元素类型变了会漏出 "[object Object]"）。
const LISTS = Object.freeze([
  { id: 'allow-groups', title: '允许的群', kind: 'group', path: ['allow', 'groups'] },
  { id: 'allow-private', title: '允许的私聊', kind: 'qq', path: ['allow', 'private'] },
  { id: 'deny-groups', title: '拒绝的群', kind: 'group', path: ['deny', 'groups'] },
  { id: 'deny-private', title: '拒绝的私聊', kind: 'qq', path: ['deny', 'private'] },
  { id: 'observe-groups', title: '只看不说的群', kind: 'group', path: ['observe', 'groups'] },
  { id: 'archive-groups', title: '自动归档的群', kind: 'group', path: ['fileArchive', 'groups'] },
  { id: 'ai-blacklist', title: 'AI 黑名单', kind: 'qq', path: ['socialV2', 'aiBlacklist', 'qq'], objectEntries: true }
]);
const AI_PATH = Object.freeze(['socialV2', 'aiBlacklist']);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getAt(source, keys) {
  let cur = source;
  for (const key of keys) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function setAt(target, keys, value) {
  let cur = target;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(cur[key])) cur[key] = {};
    cur = cur[key];
  }
  cur[keys[keys.length - 1]] = value;
}

/** ai-blacklist：条目统一成 { id, note?, addedAt? }；老配置里的纯字符串条目也算合法。 */
function normalizeObjectEntries(value) {
  if (!Array.isArray(value)) return [];
  const entries = [];
  for (const raw of value) {
    const text = String((isPlainObject(raw) ? raw.id : raw) ?? '').trim();
    if (!/^\d+$/.test(text)) continue;
    const entry = { id: text };
    if (isPlainObject(raw) && typeof raw.note === 'string' && raw.note) entry.note = raw.note;
    if (isPlainObject(raw) && Number.isFinite(raw.addedAt)) entry.addedAt = raw.addedAt;
    entries.push(entry);
  }
  return entries;
}

function listNotesOf(disk, listId) {
  const section = getAt(disk, ['socialV2', 'listNotes']);
  if (!isPlainObject(section)) return {};
  return isPlainObject(section[listId]) ? section[listId] : {};
}

/** 读某个名单的条目：6 个名单以纯字符串数组存，备注从 socialV2.listNotes[list][id] 拼回。
 *  读取宽松（老配置里有短号，如测试用的 456），写入才按 LIST_ID_RE 严格校验。 */
function readListEntries(def, disk) {
  const raw = getAt(disk, def.path);
  if (!Array.isArray(raw)) return [];
  if (def.objectEntries === true) return normalizeObjectEntries(raw);
  const notes = listNotesOf(disk, def.id);
  const entries = [];
  for (const item of raw) {
    const id = String(typeof item === 'string' ? item : (isPlainObject(item) ? item.id : item) ?? '').trim();
    if (!/^\d+$/.test(id)) continue;
    entries.push({ id, note: typeof notes[id] === 'string' ? notes[id] : '' });
  }
  return entries;
}

/** 写某个名单：6 个名单落盘成纯字符串数组，备注单独放 socialV2.listNotes（空则删掉对应小节）。 */
function writeListEntries(def, disk, entries) {
  if (def.objectEntries === true) {
    setAt(disk, def.path, entries.map((entry) => {
      const out = { id: entry.id, note: entry.note ?? '' };
      if (entry.addedAt) out.addedAt = entry.addedAt;
      return out;
    }));
    return;
  }
  setAt(disk, def.path, entries.map((entry) => entry.id));
  const notes = {};
  for (const entry of entries) if (entry.note) notes[entry.id] = entry.note;
  const section = getAt(disk, ['socialV2', 'listNotes']);
  const hasSection = isPlainObject(section) && Object.prototype.hasOwnProperty.call(section, def.id);
  if (Object.keys(notes).length) { setAt(disk, ['socialV2', 'listNotes', def.id], notes); return; }
  if (!hasSection) return;
  delete section[def.id];
  if (!Object.keys(section).length) delete disk.socialV2.listNotes;
}

function listView(def, source) {
  const entries = readListEntries(def, source);
  return { id: def.id, title: def.title, kind: def.kind, path: def.path.join('.'), count: entries.length, entries };
}

function aiView(raw, stats) {
  const ai = isPlainObject(raw) ? raw : {};
  return {
    enabled: ai.enabled === true,
    mode: AI_MODES.includes(ai.mode) ? ai.mode : AI_DEFAULTS.mode,
    minIntervalMs: Number.isFinite(ai.minIntervalMs) && ai.minIntervalMs >= 0 ? ai.minIntervalMs : AI_DEFAULTS.minIntervalMs,
    perHourMax: Number.isFinite(ai.perHourMax) && ai.perHourMax >= 0 ? ai.perHourMax : AI_DEFAULTS.perHourMax,
    atMeReply: ai.atMeReply !== false,
    stats: isPlainObject(stats) ? { skippedToday: Number(stats.skippedToday) || 0, day: stats.day ?? null } : { skippedToday: 0, day: null }
  };
}

function badRequest(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function createConsoleLists(deps) {
// @bridge-function handleConsoleLists:start
async function handleConsoleLists(request) {
  const pathname = request.url.pathname;
  if (pathname !== '/api/lists' && !pathname.startsWith('/api/lists/')) return false;
  // 和 /api/affinity、/api/socialV2/ai-blacklist 同口径：MCP 工具进程也持有控制台令牌，
  // 名单只允许管理端改，智能体不能自己把自己加进白名单。
  if (request.req.headers['x-agent-call'] !== undefined || request.req.headers['x-agent-token']) {
    request.sendJson({ ok: false, code: 'admin_only', error: '名单只允许管理端读写（智能体不得自行改名单）' }, 403);
    return true; /* @bridge-handled */
  }
  try {
    const isRead = request.req.method === 'GET';
    if (pathname === '/api/lists') {
      if (isRead) { request.sendJson({ ok: true, ...buildView(readSnapshot()) }); return true; }
      if (request.req.method !== 'POST') throw badRequest('名单接口只支持 GET/POST', 405);
      request.sendJson(writeLists(await readJsonBody(request)));
      return true; /* @bridge-handled */
    }
    if (pathname === '/api/lists/settings' || pathname === '/api/lists/flag') {
      if (request.req.method !== 'POST') throw badRequest('名单写接口只支持 POST', 405);
      const body = await readJsonBody(request);
      request.sendJson(pathname === '/api/lists/settings' ? writeAiSettings(body) : writeAllowAllWhenEmpty(body));
      return true; /* @bridge-handled */
    }
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    const message = status >= 500 ? `名单操作失败：${error?.message ?? error}` : String(error?.message ?? error);
    request.sendJson({ ok: false, error: message }, status);
    return true; /* @bridge-handled */
  }
  // 走到这里说明路径没匹配上（readBridgeSource 的路由展开按最后这个 return false; 切片）。
  return false;
}
// @bridge-function handleConsoleLists:end

  function configPath() {
    return deps.path.join(deps.ROOT, 'config.json');
  }

  function readJsonBody(request) {
    return request.readBody().catch(() => ({}));
  }

  /** 读盘；文件不存在返回 null；损坏抛错（写路径靠它 fail-fast，避免拿空对象回写）。 */
  function readDiskConfig() {
    const file = configPath();
    let text;
    try {
      text = deps.fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (!isPlainObject(parsed)) throw new Error('config.json 顶层不是 JSON 对象');
    return parsed;
  }

  /** 读取快照：磁盘优先，读不到/读坏时退回内存配置（GET 不因配置损坏 500）。 */
  function readSnapshot() {
    try {
      const disk = readDiskConfig();
      if (disk) return disk;
    } catch (error) {
      (0, deps.log)(`[名单] 读取 config.json 失败，改用内存配置：${error?.message ?? error}`);
    }
    return isPlainObject(deps.cfg) ? deps.cfg : {};
  }

  function configWritable() {
    try {
      deps.fs.accessSync(configPath(), deps.fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  function readAiStats() {
    try {
      const stats = typeof deps.aiBlacklist?.stats === 'function' ? deps.aiBlacklist.stats() : null;
      return isPlainObject(stats) ? stats : null;
    } catch {
      return null;
    }
  }

  function buildView(source) {
    return {
      writable: configWritable(),
      flags: {
        allowAllWhenEmpty: source.allowAllWhenEmpty === true,
        observeEnabled: getAt(source, ['observe', 'enabled']) === true,
        archiveEnabled: getAt(source, ['fileArchive', 'enabled']) === true,
        privateOpen: getAt(source, ['allow', 'privateOpen']) === true
      },
      lists: LISTS.map((def) => listView(def, source)),
      // 第八项不是 config 里的数组，而是「运行时算出来的白名单」：
      // 白名单群成员自动可私聊（每天额度、跨天重置），所以这里给状态而不是条目。
      privatePass: {
        memberAuto: true,
        privateOpen: getAt(source, ['allow', 'privateOpen']) === true,
        dailyMinutes: Number(getAt(source, ['socialV2', 'privateQuota', 'dailyMinutes'])) > 0
          ? Number(getAt(source, ['socialV2', 'privateQuota', 'dailyMinutes'])) : 120,
        idleCapMinutes: Number(getAt(source, ['socialV2', 'privateQuota', 'idleCapMinutes'])) > 0
          ? Number(getAt(source, ['socialV2', 'privateQuota', 'idleCapMinutes'])) : 10,
        memberCount: Math.max(0, Number(deps.groupMemberCache?.size) || 0),
        refreshedAt: Number(deps.groupMemberRefreshedAt) || 0
      },
      ai: aiView(getAt(source, AI_PATH), readAiStats())
    };
  }

  /** 写前备份 config.json → config.json.bak-<ISO>，只留最近 5 份（照抄 createAiBlacklistAdmin）。 */
  function backupConfig() {
    const file = configPath();
    try {
      if (!deps.fs.existsSync(file)) return '';
      const target = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      deps.fs.copyFileSync(file, target);
      try {
        const dir = deps.path.dirname(file);
        const base = deps.path.basename(file) + '.bak-';
        const olds = deps.fs.readdirSync(dir).filter((name) => name.startsWith(base)).sort();
        for (const name of olds.slice(0, Math.max(0, olds.length - 5))) deps.fs.rmSync(deps.path.join(dir, name), { force: true });
      } catch {}
      return target;
    } catch (error) {
      (0, deps.log)(`[名单] 备份 config.json 失败（继续写）：${error?.message ?? error}`);
      return '';
    }
  }

  function assertWritable() {
    if (!configWritable()) throw badRequest('config.json 当前不可写', 409);
  }

  /**
   * 读盘-合并-写并回最新 views。mutate 在磁盘最新内容上执行，所以并发两次 patch 都能落盘；
   * 写前严格读一次，配置损坏直接 500，绝不把空对象写回去。
   */
  function commit(mutate, logText) {
    const file = configPath();
    if (!isPlainObject(readDiskConfig())) throw badRequest('config.json 当前不存在', 409);
    backupConfig();
    const next = (0, deps.updateConfigFile)(file, mutate, { atomicWrite: deps.atomicWriteJson });
    try { (0, deps.reloadConfigFromDisk)?.('console-lists'); } catch {}
    if (logText) (0, deps.log)(logText);
    return { ok: true, ...buildView(next) };
  }

  function findList(listId) {
    const id = String(listId ?? '').trim();
    return LISTS.find((def) => def.id === id) || null;
  }

  function validateId(rawId) {
    const id = String(rawId ?? '').trim();
    if (!LIST_ID_RE.test(id)) throw badRequest('id 必须是 5~20 位数字（群号或 QQ 号）');
    return id;
  }

  /** POST /api/lists：add / remove / clear / note（改备注）。 */
  function writeLists(body) {
    const def = findList(body?.list);
    if (!def) throw badRequest('未知名单：list 只支持 allow-groups / allow-private / deny-groups / deny-private / observe-groups / archive-groups / ai-blacklist');
    const action = String(body?.action ?? '').trim();
    if (action !== 'add' && action !== 'remove' && action !== 'clear' && action !== 'note') {
      throw badRequest('action 只支持 add / remove / clear / note');
    }
    const id = action === 'clear' ? '' : validateId(body?.id);
    const note = action === 'add' || action === 'note' ? String(body?.note ?? '').trim() : '';
    if (note.length > LIST_NOTE_MAX) throw badRequest(`备注最多 ${LIST_NOTE_MAX} 字`);
    assertWritable();
    const label = action === 'add' ? `添加 ${id}` : action === 'remove' ? `移除 ${id}`
      : action === 'note' ? `${id} 改备注` : '清空';
    return commit((disk) => {
      const current = readListEntries(def, disk);
      let entries = current;
      if (action === 'add') {
        // 重复添加按幂等处理：不覆盖已有备注，也不重复落盘。
        if (!current.some((entry) => entry.id === id)) {
          entries = [...current, def.objectEntries === true ? { id, addedAt: Date.now(), note } : { id, note }];
        }
      } else if (action === 'remove') {
        entries = current.filter((entry) => entry.id !== id);
      } else if (action === 'note') {
        // 只改这一条的备注；备注清空等于删掉这条备注（不是删条目）。
        if (!current.some((entry) => entry.id === id)) throw badRequest('这条不在名单里：先加入名单再写备注');
        entries = current.map((entry) => (entry.id === id ? { ...entry, note } : entry));
      } else {
        entries = [];
      }
      writeListEntries(def, disk, entries);
    }, `[名单] ${def.title}：${label}`);
  }

  /** POST /api/lists/settings：只允许 list:'ai'。 */
  function writeAiSettings(body) {
    if (String(body?.list ?? '').trim() !== 'ai') throw badRequest('settings 目前只支持 list: ai');
    const patch = body?.patch;
    if (!isPlainObject(patch)) throw badRequest('patch 必须是对象');
    const keys = Object.keys(patch);
    for (const key of keys) {
      if (!AI_SETTING_KEYS.includes(key)) throw badRequest(`不支持的设置项：${key}`);
      const value = patch[key];
      if (key === 'enabled' || key === 'atMeReply') {
        if (typeof value !== 'boolean') throw badRequest(`${key} 必须是布尔值`);
      } else if (key === 'mode') {
        if (!AI_MODES.includes(String(value ?? '').trim())) throw badRequest('mode 只能是 reduce 或 silent');
      } else if (key === 'minIntervalMs') {
        if (!Number.isInteger(value) || value < 0) throw badRequest('minIntervalMs 必须是 ≥0 的整数（毫秒）');
      } else if (!Number.isInteger(value) || value < 0 || value > 1000) {
        throw badRequest('perHourMax 必须是 0~1000 的整数');
      }
    }
    if (!keys.length) return { ok: true, ...buildView(readSnapshot()) };
    assertWritable();
    return commit((disk) => {
      const ai = isPlainObject(getAt(disk, AI_PATH)) ? getAt(disk, AI_PATH) : {};
      for (const key of keys) ai[key] = key === 'mode' ? String(patch[key]).trim() : patch[key];
      setAt(disk, AI_PATH, ai);
    }, `[名单] AI 黑名单设置已更新：${keys.join(',')}`);
  }

  /** POST /api/lists/flag：allowAllWhenEmpty。 */
  function writeAllowAllWhenEmpty(body) {
    const keys = Object.keys(body ?? {});
    if (keys.length !== 1 || keys[0] !== 'allowAllWhenEmpty') throw badRequest('只支持 allowAllWhenEmpty 一个字段');
    if (typeof body.allowAllWhenEmpty !== 'boolean') throw badRequest('allowAllWhenEmpty 必须是布尔值');
    assertWritable();
    const value = body.allowAllWhenEmpty;
    return commit((disk) => { disk.allowAllWhenEmpty = value; }, `[名单] allowAllWhenEmpty 已${value ? '开启' : '关闭'}`);
  }

  return { handleConsoleLists };
}
