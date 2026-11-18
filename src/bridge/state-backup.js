// state-backup: state/*.json 的定时备份 + 保留策略；工厂无启动副作用（循环由 bridge.js 启动）。
// Live dependencies: STATE_DIR, fs, log, path, setInterval, setTimeout
//
// 为什么需要：config.json 每次写前留 5 份备份，但真正贵的数据在 state/ 下——social-v2.json
// （会话/话题/印象/共享事件）、slang.json（936 条黑话）、stickers.json（备注/标签/使用计数）
// 一份备份都没有；手滑清空、写到一半断电，就再也回不来。这里只搬字节、不解析 JSON，
// 所以坏 JSON 也能备份成功（「能恢复」比「能解析」重要）。
//
// 白名单而不是扫目录：state/ 下还有 agents/、sticker-files/、media-cache/、messages.db(+WAL)，
// 全量扫一次几百 MB，还会把备份目录自己扫进去；tmp-slang.json、tool-log*.json 这类派生文件
// 与日志也不值钱，不进白名单。
//
// BOOTH 素材库那一批 state（booth-*.json）：binds 是人工认号的唯一产物（丢了要重新一个个认），
// batchfind/downloads/search-pause 是重跑成本高的进度与限速状态，都进白名单；唯独
// booth-cookies.json 永不备份（见 STATE_BACKUP_NEVER）。
//
// 保留策略：每个源文件留最近 24 份（2 小时一次 ≈ 2 天）+「每天首份」留 14 天，用于长跨度回滚。
// 清理只删自己命名规则（<name>.<YYYYMMDD-HHmmss>[-n].json）匹配的文件，用户手放进去的备份
// （state/backups/manual-keep.json 之类）永远不动。文件名同秒重复时加 -2 后缀，不覆盖前一份。
const BACKUP_SUBDIR = 'backups';
const MANIFEST_NAME = '.manifest.json';
const MANIFEST_TMP = '.manifest.json.tmp';
const STAMP_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;
const BACKUP_NAME_RE = /^(.+)\.(\d{8}-\d{6})(?:-(\d+))?\.json$/i;
const KEEP_DEFAULT = 24;
const DAILY_DEFAULT = 14;
const INTERVAL_MS = 2 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 10 * 1000;

// 白名单：真正贵的记忆库 + 几个小文件。新增 state 文件时要来这里加一行，否则不会被备份
// （有意为之：宁可漏一个小文件，也不要把备份目录撑爆）。
const STATE_BACKUP_FILES = Object.freeze([
  'booth-batchfind.json',
  'booth-binds.json',
  'booth-covers.json',
  'booth-downloads.json',
  'booth-favorites.json',
  'booth-merges.json',
  'booth-purchases.json',
  'booth-purchases-sync.json',
  'booth-relocations.json',
  'booth-renames.json',
  'booth-search-pause.json',
  'booth-trash.json',
  'library-alias-rules.json',
  'library-collections.json', // 素材集（名字 + 成员 key，纯人工整理，丢了要重挑一遍）
  'library-manual-meta.json', // 手动标签/分类/备注（纯人工数据，丢了很难补）
  'affinity.json',
  'current-role.json',
  'feedback.json',
  'friend-names.json',
  'group-names.json',
  'impressions.json',
  'member-notes.json',
  'mode.json',
  'people.json',
  'sessions.json',
  'slang.json',
  'social-v2.json',
  'stickers.json'
]);
// 黑话词库以后若拆成 slang-<分片>.json 也一起备份；tmp-slang.json 不匹配，天然排除。
const STATE_BACKUP_PATTERN = /^slang-[a-z0-9-]+\.json$/i;
// 运行标记 / 配额 / 体检结果类文件（budget-alert、imagegen-quota、private-quota、
// private-unreachable、impressions-run、startup-notice、self-check-last）**故意不备份**：
// 它们都能重建或只是计数，备份只会把目录撑大、真出事时也帮不上忙。要加之前先想清楚值不值。
// 派生/会话标记文件：不是记忆库，pattern 会误匹配 slang-session.json，这里显式排除。
// booth-dhash-cache.json（封面指纹缓存，能从封面重算）、library-extracts.json（解压历史，
// 只是最近 20 条日志）同理不进白名单：备份它们只会把目录撑大，真出事也帮不上忙。
const STATE_BACKUP_SKIP = new Set(['slang-session.json']);
// 永不备份：凭据原文。备份目录会被整包拷走（换机、上报排障、git 私库），
// cookie / 解压密码一进备份就等于把账号会话与密码抄了一份到处放 —— 所以这里显式写死，
// 即使以后有人放开 booth-*.json / library-*.json 通配，也必须先删掉这一行才会漏（删之前先想清楚）。
const STATE_BACKUP_NEVER = new Set(['booth-cookies.json', 'booth-passwords.json']);

function pad2(value) {
  return String(value).padStart(2, '0');
}

function stampOf(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

function backupBaseFor(sourceName) {
  return sourceName.replace(/\.json$/i, '');
}

/** 解析「自己写出来的」备份文件名；解析不了的一律不当作备份（也就永远不会被清理）。 */
function parseBackupName(name) {
  const match = BACKUP_NAME_RE.exec(name);
  if (!match) return null;
  const stamp = match[2];
  const parts = STAMP_RE.exec(stamp);
  if (!parts) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return null;
  return {
    base: match[1],
    source: `${match[1]}.json`,
    stamp,
    suffix: Number(match[3] ?? 0),
    dateKey: stamp.slice(0, 8),
    timeKey: stamp.slice(9)
  };
}

function normalizeCount(value, fallback, min) {
  const parsed = value === undefined || value === null || value === '' ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

/**
 * 保留计划（纯函数）：给磁盘上已有的备份 + 策略，返回该留哪些、该删哪些。
 * 规则 = 每个源文件最近 keep 份 ∪ 最近 daily 个「有备份日期」的当天首份。
 */
function planRetention(entries, { keep, daily }) {
  const bySource = new Map();
  for (const entry of entries) {
    const list = bySource.get(entry.source);
    if (list) list.push(entry);
    else bySource.set(entry.source, [entry]);
  }
  const kept = new Set();
  for (const list of bySource.values()) {
    const sorted = [...list].sort((a, b) => b.dateKey.localeCompare(a.dateKey)
      || b.timeKey.localeCompare(a.timeKey)
      || b.suffix - a.suffix);
    for (const entry of sorted.slice(0, keep)) kept.add(entry.name);
    // 每天首份：同一天只留最早那份（长跨度回滚只需要「当天刚开始」的状态）。
    const firstOfDay = new Map();
    for (const entry of sorted) {
      const current = firstOfDay.get(entry.dateKey);
      if (!current || entry.timeKey < current.timeKey) firstOfDay.set(entry.dateKey, entry);
    }
    const days = daily > 0 ? [...firstOfDay.keys()].sort().slice(-daily) : [];
    for (const day of days) kept.add(firstOfDay.get(day).name);
  }
  return { kept, prune: entries.filter((entry) => !kept.has(entry.name)) };
}

export function createStateBackup(deps) {
  let loopTimer = null;

  function backupRootDir() {
    return deps.STATE_DIR ? deps.path.join(deps.STATE_DIR, BACKUP_SUBDIR) : '';
  }

  function summarizeEntry(entry) {
    return { source: entry.source, name: entry.name, path: entry.path, size: entry.size };
  }

  /** 上次备份索引：{ "social-v2.json": { mtimeMs, size, lastBackupAt } }。坏了就按空索引处理。 */
  function loadManifest() {
    let raw;
    try {
      raw = deps.fs.readFileSync(deps.path.join(backupRootDir(), MANIFEST_NAME), 'utf8');
    } catch {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      (0, deps.log)(`状态备份：索引损坏，本轮按无索引处理（会重备一轮）：${error?.message ?? error}`);
      return {};
    }
  }

  function saveManifest(manifest) {
    const dir = backupRootDir();
    const tmp = deps.path.join(dir, MANIFEST_TMP);
    deps.fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
    deps.fs.renameSync(tmp, deps.path.join(dir, MANIFEST_NAME));
  }

  /** 磁盘上已有的备份（只认自己的命名规则，别的文件当不存在）。 */
  function readBackupEntries() {
    const dir = backupRootDir();
    let names = [];
    try {
      names = deps.fs.readdirSync(dir);
    } catch {
      return [];
    }
    const entries = [];
    for (const name of names) {
      const parsed = parseBackupName(name);
      if (!parsed) continue;
      const file = deps.path.join(dir, name);
      let stat;
      try {
        stat = deps.fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      entries.push({ ...parsed, name, path: file, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
    }
    return entries.sort((a, b) => a.source.localeCompare(b.source)
      || b.dateKey.localeCompare(a.dateKey)
      || b.timeKey.localeCompare(a.timeKey)
      || b.suffix - a.suffix);
  }

  /** 白名单里「此刻真实存在」的源文件；从不递归扫目录。 */
  function listSources() {
    const names = new Set(STATE_BACKUP_FILES);
    let diskNames = [];
    try {
      diskNames = deps.fs.readdirSync(deps.STATE_DIR);
    } catch {
      diskNames = [];
    }
    for (const name of diskNames) {
      if (STATE_BACKUP_PATTERN.test(name) && !STATE_BACKUP_SKIP.has(name)) names.add(name);
    }
    // 最后统一摘掉「永不备份」的凭据文件：白名单 / 通配 / 以后新增的规则都拦不住这里。
    for (const name of STATE_BACKUP_NEVER) names.delete(name);
    const sources = [];
    for (const name of names) {
      const file = deps.path.join(deps.STATE_DIR, name);
      try {
        if (deps.fs.statSync(file).isFile()) sources.push({ name, file });
      } catch {
        // 白名单里但还没落盘的文件：跳过，不算错误。
      }
    }
    return sources.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 拷一份：先写 .tmp 再 rename —— 写一半被杀/盘满都不会留下半截 JSON 冒充好备份。 */
  function writeBackupCopy(item, now) {
    const dir = backupRootDir();
    const base = `${backupBaseFor(item.name)}.${stampOf(now)}`;
    let name = `${base}.json`;
    let target = deps.path.join(dir, name);
    for (let attempt = 2; deps.fs.existsSync(target) && attempt < 100; attempt += 1) {
      name = `${base}-${attempt}.json`;
      target = deps.path.join(dir, name);
    }
    const tmp = deps.path.join(dir, `.${name}.tmp`);
    const bytes = deps.fs.readFileSync(item.file);
    try {
      deps.fs.writeFileSync(tmp, bytes);
      deps.fs.renameSync(tmp, target);
    } catch (error) {
      try {
        deps.fs.unlinkSync(tmp);
      } catch {
        // 临时文件清理失败不影响备份结论：它不匹配命名规则，永远不会被当备份，下轮同名覆盖。
      }
      throw error;
    }
    return { source: item.name, name, path: target, size: bytes.length };
  }

// @bridge-function backupStateNow:start
function backupStateNow(options = {}) {
    const startedAt = Date.now();
    const dryRun = options?.dryRun === true;
    const keep = normalizeCount(options?.keep, KEEP_DEFAULT, 1);
    const daily = normalizeCount(options?.daily, DAILY_DEFAULT, 0);
    const backupDir = backupRootDir();
    const result = { ok: true, dryRun, backupDir, keep, daily, written: [], skipped: [], pruned: [], errors: [], ms: 0 };
    if (!backupDir) {
      result.ok = false;
      result.errors.push('STATE_DIR 未配置');
      result.ms = Date.now() - startedAt;
      return result;
    }
    const sources = listSources();
    const manifest = loadManifest();
    const changed = [];
    for (const source of sources) {
      let stat;
      try {
        stat = deps.fs.statSync(source.file);
      } catch (error) {
        result.errors.push(`${source.name}: ${error?.message ?? error}`);
        continue;
      }
      const mtimeMs = Math.round(stat.mtimeMs);
      const previous = manifest[source.name];
      if (previous && Number(previous.mtimeMs) === mtimeMs && Number(previous.size) === stat.size) {
        result.skipped.push(source.name);
        continue;
      }
      changed.push({ name: source.name, file: source.file, size: stat.size, mtimeMs });
    }
    // 清理只针对「现在还在白名单里的源文件」：某个文件被删掉时保留它的备份，
    // 那正是最需要回滚的场景；白名单外/手放的备份一律不碰。
    const activeNames = new Set(sources.map((source) => source.name));
    const prunePlan = planRetention(readBackupEntries(), { keep, daily }).prune
      .filter((entry) => activeNames.has(entry.source));
    const now = new Date();
    if (dryRun) {
      // 预演：一个字节都不落盘。文件名按当前时间算，实际跑可能差几秒。
      result.written = changed.map((item) => ({ source: item.name, name: `${backupBaseFor(item.name)}.${stampOf(now)}.json`, size: item.size, planned: true }));
      result.pruned = prunePlan.map(summarizeEntry);
      result.ms = Date.now() - startedAt;
      return result;
    }
    try {
      if (changed.length > 0) deps.fs.mkdirSync(backupDir, { recursive: true });
    } catch (error) {
      result.ok = false;
      result.errors.push(`建备份目录失败：${error?.message ?? error}`);
      result.ms = Date.now() - startedAt;
      return result;
    }
    for (const item of changed) {
      try {
        result.written.push(writeBackupCopy(item, now));
        manifest[item.name] = { mtimeMs: item.mtimeMs, size: item.size, lastBackupAt: new Date().toISOString() };
      } catch (error) {
        result.errors.push(`${item.name}: ${error?.message ?? error}`);
      }
    }
    if (result.written.length > 0) {
      try {
        saveManifest(manifest);
      } catch (error) {
        result.errors.push(`索引写入失败：${error?.message ?? error}`);
      }
    }
    // 先写完新备份再清理：盘满/被杀时宁可多留旧备份，也不能先删后失败。
    for (const entry of prunePlan) {
      try {
        deps.fs.unlinkSync(entry.path);
        result.pruned.push(summarizeEntry(entry));
      } catch (error) {
        result.errors.push(`清理 ${entry.name} 失败：${error?.message ?? error}`);
      }
    }
    if (result.errors.length > 0) result.ok = false;
    result.ms = Date.now() - startedAt;
    return result;
  }
// @bridge-function backupStateNow:end

// @bridge-function listStateBackups:start
function listStateBackups() {
    const backupDir = backupRootDir();
    const files = readBackupEntries().map((entry) => ({
      source: entry.source,
      name: entry.name,
      path: entry.path,
      size: entry.size,
      mtimeMs: entry.mtimeMs
    }));
    return { ok: Boolean(backupDir), backupDir, count: files.length, files };
  }
// @bridge-function listStateBackups:end

// @bridge-function startStateBackupLoop:start
function startStateBackupLoop() {
    if (loopTimer) return loopTimer;
    const run = (trigger) => {
      try {
        const result = backupStateNow();
        if (!result.ok) (0, deps.log)(`状态备份失败（${trigger}）：${result.errors.join('；')}`);
        else if (result.written.length > 0 || result.pruned.length > 0) {
          (0, deps.log)(`状态备份（${trigger}）：写入 ${result.written.length} 份，清理 ${result.pruned.length} 份，跳过 ${result.skipped.length} 份，耗时 ${result.ms}ms`);
        }
      } catch (error) {
        (0, deps.log)(`状态备份失败（${trigger}）：${error?.message ?? error}`);
      }
    };
    (0, deps.log)(`状态备份：每 ${INTERVAL_MS / 3600000} 小时备份 state/ 到 state/backups/（每文件留 ${KEEP_DEFAULT} 份 + 每日首份 ${DAILY_DEFAULT} 天）`);
    // 启动补跑：进程可能整夜没开，错过好几个备份窗口；延迟 10s 避开启动高峰。
    const startupTimer = (0, deps.setTimeout)(() => run('启动补跑'), STARTUP_DELAY_MS);
    startupTimer?.unref?.();
    loopTimer = (0, deps.setInterval)(() => run('定时'), INTERVAL_MS);
    loopTimer?.unref?.();
    return loopTimer;
  }
// @bridge-function startStateBackupLoop:end

  return { backupStateNow, listStateBackups, startStateBackupLoop };
}
