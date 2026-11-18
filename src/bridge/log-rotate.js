// log-rotate: 日志/数据文件按体积轮转（当前文件改名成 .1、.1 变 .2…，超保留份数的删掉）；
// 工厂无启动副作用，循环由 bridge.js 在模块作用域启动。
// Live dependencies: ROOT, STATE_DIR, fs, log, path, setInterval, setTimeout
//
// 为什么需要：state/ 下几个只追加的文件长期只增大 —— token-usage.jsonl 2026-10-31 已 4.4MB、
// tool-calls.jsonl 217KB、bridge.out 675KB。这些文件没有「删除」路径，跑几个月就会把盘吃满，
// 而盘满之后 writeFile 抛错的是 state 保存与日志本身，属于「不影响聊天但迟早全线故障」的那类问题。
//
// 为什么按体积而不是按行数：行长度差异极大（token 台账一行几百字节、日志一行几十字节），
// 行数上限对体积几乎没有约束力。已有的 createCappedLogger（bridge.log 2000 行、qq-activity.log
// 500 行）是行数兜底，这里按字节再兜一层；两者都 rename 到 .1，日志类文件的 .1 可能被后轮转的
// 那一方覆盖 —— 有意的取舍：日志只求别爆盘，不求代代可回溯。
//
// 为什么直接读 config.json（而不是走 cfg）：loadConfig() 是白名单式逐段搬运，而且被代码规模闸
// 冻结在 371 行，`logging` 段加不进去；轮转是运维参数，读失败/写坏一律回退默认值即可，不需要
// 跟着启动配置校验一起失败。读取时机是每次检查前 —— 改 config.json 后下一轮即生效，不用重启。
//
// 白名单而不是扫目录：state/ 下还有 agents/、messages.db(+WAL)、booth-cache/、媒体缓存，
// 轮转它们等于删数据。这里只认下面 6 个文件名，其它文件即使再大也一律不碰。
const LOGROTATE_FILES = Object.freeze([
  'token-usage.jsonl', // token 台账（只追加；按天聚合读最近 N 天，旧段删掉不影响）
  'tool-calls.jsonl',  // 工具调用流水（同上）
  'bridge.log',        // 桥接日志（另有 createCappedLogger 的 2000 行兜底）
  'bridge.out',        // 启动器 stdout/stderr 重定向落盘
  'qq-activity.log',   // 活动流水
  'activity.log'       // 旧名/别名：有的部署里是这个名字，两个都认
]);
const LOGROTATE_CONFIG_FILE = 'config.json';
const LOGROTATE_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const LOGROTATE_DEFAULT_KEEP = 3;
const LOGROTATE_MIN_MAX_BYTES = 1024;              // 再小就是每小时切一份空文件，没有意义
const LOGROTATE_MAX_MAX_BYTES = 512 * 1024 * 1024;
const LOGROTATE_MAX_KEEP = 9;                      // 再多就是拿磁盘换「更早的日志」，不如备份
const LOGROTATE_INTERVAL_MS = 60 * 60 * 1000;      // 每小时检查一次
const LOGROTATE_STARTUP_DELAY_MS = 10 * 1000;      // 启动补查延迟：避开启动高峰

/**
 * 把 `name` 解析成「基名 + 第几代」。
 * `token-usage.jsonl` → { base, index: 0 }；`token-usage.jsonl.2` → { base, index: 2 }；
 * 其它（`token-usage.jsonl.bak`、白名单外的名字）→ null。
 */
function logRotateIndexOf(name) {
  for (const base of LOGROTATE_FILES) {
    if (name === base) return { base, index: 0 };
    if (name.startsWith(`${base}.`)) {
      const rest = name.slice(base.length + 1);
      if (/^\d+$/.test(rest)) return { base, index: Number(rest) };
    }
  }
  return null;
}

function logRotateClampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 归一化轮转配置。输入可以是整份 config.json（取 logging.rotate），也可以直接给 rotate 段。
 * 坏值一律回退默认：一个手滑的 `"maxBytes": "8MB"` 不能让轮转停摆（那正是它要防的事）。
 */
function normalizeLogRotateConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const section = src.logging && typeof src.logging === 'object' ? src.logging : src;
  const rotate = section.rotate && typeof section.rotate === 'object' ? section.rotate : section;
  return {
    enabled: rotate.enabled !== false,
    maxBytes: logRotateClampNumber(rotate.maxBytes, LOGROTATE_DEFAULT_MAX_BYTES, LOGROTATE_MIN_MAX_BYTES, LOGROTATE_MAX_MAX_BYTES),
    keep: logRotateClampNumber(rotate.keep, LOGROTATE_DEFAULT_KEEP, 1, LOGROTATE_MAX_KEEP)
  };
}

export function createLogRotate(deps) {
  let loopTimer = null;

  /**
   * 纯函数：算轮转计划，不碰磁盘。
   * @param {{ dir?: string, files?: Array<{name: string, size: number}>, maxBytes?: number, keep?: number }} options
   *   files 只描述「目录里有什么、多大」（调用方 stat 得来）；这里只根据名字与大小做决策。
   * @returns {{ ok: boolean, dir: string, maxBytes: number, keep: number, plans: Array<object> }}
   *   plans[i] = { name, size, actions: Array<{ kind: 'remove'|'rename', from, to? }>, create: true }
   *   actions 已按执行顺序排好：先删最老的，再从高代往低代改名，最后把当前文件改成 .1。
   */
// @bridge-function planRotations:start
function planRotations(options = {}) {
    const files = Array.isArray(options.files) ? options.files : [];
    // 显式传入的阈值按原样用（测试/演练要给小值）；只有来自 config.json 的值才夹到安全区间。
    const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.round(options.maxBytes)
      : LOGROTATE_DEFAULT_MAX_BYTES;
    const keep = logRotateClampNumber(options.keep, LOGROTATE_DEFAULT_KEEP, 1, LOGROTATE_MAX_KEEP);
    const byBase = new Map();
    for (const item of files) {
      const name = typeof item?.name === 'string' ? item.name : '';
      const parsed = logRotateIndexOf(name);
      if (!parsed) continue;
      const size = Number.isFinite(item?.size) ? Math.max(0, item.size) : 0;
      if (!byBase.has(parsed.base)) byBase.set(parsed.base, []);
      byBase.get(parsed.base).push({ index: parsed.index, size, name });
    }
    const plans = [];
    for (const base of LOGROTATE_FILES) {
      const entries = byBase.get(base);
      if (!entries) continue;
      const current = entries.find((entry) => entry.index === 0);
      if (!current) continue; // 当前文件不存在：没什么可轮的
      if (!(current.size > maxBytes)) continue; // 恰好等于阈值不轮转，避免抖动
      const actions = [];
      const older = entries.filter((entry) => entry.index > 0).sort((a, b) => b.index - a.index);
      for (const entry of older) {
        if (entry.index >= keep) actions.push({ kind: 'remove', from: entry.name });
        else actions.push({ kind: 'rename', from: entry.name, to: `${base}.${entry.index + 1}` });
      }
      actions.push({ kind: 'rename', from: base, to: `${base}.1` });
      plans.push({ name: base, size: current.size, actions, create: true });
    }
    return { ok: true, dir: typeof options.dir === 'string' ? options.dir : '', maxBytes, keep, plans };
  }
// @bridge-function planRotations:end

  /**
   * 执行计划：删超限的旧档 → 从高代往低代改名 → 当前文件改成 .1 → 建一个空的当前文件。
   * 顺序很关键：先删除/改名腾出位置，最后才动当前文件；中途失败只记 errors，其它文件继续。
   */
// @bridge-function rotateFiles:start
function rotateFiles(options = {}) {
    const dir = typeof options.dir === 'string' ? options.dir : '';
    const plans = Array.isArray(options.plan?.plans) ? options.plan.plans : [];
    const rotated = [];
    const removed = [];
    const errors = [];
    if (!dir) return { ok: false, error: '缺少目录', rotated, removed, errors };
    for (const plan of plans) {
      try {
        for (const action of plan.actions) {
          const from = (0, deps.path).join(dir, action.from);
          if (action.kind === 'remove') {
            (0, deps.fs).unlinkSync(from);
            removed.push({ name: action.from });
            continue;
          }
          (0, deps.fs).renameSync(from, (0, deps.path).join(dir, action.to));
        }
        // 重建空文件：调用方用 appendFileSync 追加写，不需要重新打开句柄，也不会写回旧 inode。
        (0, deps.fs).writeFileSync((0, deps.path).join(dir, plan.name), '', 'utf8');
        rotated.push({ name: plan.name, size: plan.size, target: `${plan.name}.1` });
      } catch (error) {
        errors.push(`${plan.name}: ${error?.message ?? error}`);
      }
    }
    return { ok: errors.length === 0, rotated, removed, errors };
  }
// @bridge-function rotateFiles:end

  /** 读 config.json 的 logging.rotate；读不到/坏 JSON 一律用默认值（轮转不能因为配置坏掉而停）。 */
  function readRotateConfig() {
    let raw = {};
    try {
      const configPath = (0, deps.path).join((0, deps.ROOT), LOGROTATE_CONFIG_FILE);
      raw = JSON.parse((0, deps.fs).readFileSync(configPath, 'utf8'));
    } catch {
      raw = {};
    }
    return normalizeLogRotateConfig(raw);
  }

  /**
   * 扫一遍 state 目录：白名单文件 + 它们的 `.N` 历史档，各拿真实大小。
   * 必须用 readdir 而不是逐个拼白名单名字 —— 只用白名单基名的话，`.1/.2` 永远看不见，
   * 第二轮轮转就会把 `.1` 覆盖掉、永远攒不出 `.2`（保留份数形同虚设）。
   */
  function listRotateEntries(dir) {
    const sizes = [];
    let names = [];
    try {
      names = (0, deps.fs).readdirSync(dir);
    } catch {
      return sizes; // 目录不存在：没有可轮转的
    }
    for (const name of names) {
      if (!logRotateIndexOf(name)) continue; // 白名单外一律不看
      try {
        const stat = (0, deps.fs).statSync((0, deps.path).join(dir, name));
        if (!stat.isFile()) continue;
        sizes.push({ name, size: stat.size });
      } catch {
        continue; // 列目录到 stat 之间被删掉了，跳过即可
      }
    }
    return sizes;
  }

  /**
   * 跑一次轮转。
   * @param {{ dryRun?: boolean, maxBytes?: number, keep?: number, enabled?: boolean }} [options]
   *   测试/控制台可以显式传阈值覆盖；不传就用 config.json 的 logging.rotate 或默认值。
   */
// @bridge-function rotateLogsNow:start
function rotateLogsNow(options = {}) {
    const startedAt = Date.now();
    const dir = (0, deps.STATE_DIR);
    const config = readRotateConfig();
    const enabled = options.enabled === undefined ? config.enabled : options.enabled !== false;
    const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : config.maxBytes;
    const keep = Number.isFinite(options.keep) ? options.keep : config.keep;
    if (!enabled) {
      return { ok: true, enabled: false, dir, dryRun: Boolean(options.dryRun), plans: [], rotated: [], removed: [], errors: [], ms: Date.now() - startedAt };
    }
    let plan;
    try {
      plan = planRotations({ dir, files: listRotateEntries(dir), maxBytes, keep });
    } catch (error) {
      return { ok: false, enabled: true, dir, dryRun: Boolean(options.dryRun), plans: [], rotated: [], removed: [], errors: [String(error?.message ?? error)], ms: Date.now() - startedAt };
    }
    if (options.dryRun === true) {
      return { ok: true, enabled: true, dir, dryRun: true, maxBytes: plan.maxBytes, keep: plan.keep, plans: plan.plans, rotated: [], removed: [], errors: [], ms: Date.now() - startedAt };
    }
    const result = rotateFiles({ dir, plan });
    return {
      ok: result.ok,
      enabled: true,
      dir,
      dryRun: false,
      maxBytes: plan.maxBytes,
      keep: plan.keep,
      plans: plan.plans,
      rotated: result.rotated,
      removed: result.removed,
      errors: result.errors,
      ms: Date.now() - startedAt
    };
  }
// @bridge-function rotateLogsNow:end

  /**
   * 启动轮转循环：启动后 10s 补查一次（进程可能整夜没开、已积了几百 MB），之后每小时一次。
   * 只在真的轮转了文件时打日志，避免每小时刷一行「无事发生」。
   */
// @bridge-function startLogRotateLoop:start
function startLogRotateLoop() {
    if (loopTimer) return loopTimer;
    const run = (trigger) => {
      try {
        const result = rotateLogsNow();
        if (!result.ok) (0, deps.log)(`日志轮转失败（${trigger}）：${result.errors.join('；')}`);
        else if (result.rotated.length > 0 || result.removed.length > 0) {
          (0, deps.log)(`日志轮转（${trigger}）：已轮转 ${result.rotated.length} 个文件，清理 ${result.removed.length} 个旧档，耗时 ${result.ms}ms`);
        }
      } catch (error) {
        (0, deps.log)(`日志轮转失败（${trigger}）：${error?.message ?? error}`);
      }
    };
    const config = readRotateConfig();
    const thresholdText = config.maxBytes >= 1024 * 1024
      ? `${Math.round(config.maxBytes / 1024 / 1024)}MB`
      : `${Math.max(1, Math.round(config.maxBytes / 1024))}KB`;
    (0, deps.log)(`日志轮转：每 ${LOGROTATE_INTERVAL_MS / 3600000} 小时检查一次（阈值 ${thresholdText}、每文件留 ${config.keep} 份、${config.enabled ? '已启用' : '已关闭'}）`);
    // 开关关掉时也保留定时器：config.json 改了之后下一轮要能重新启用（配置在 run 里读）。
    const startupTimer = (0, deps.setTimeout)(() => run('启动检查'), LOGROTATE_STARTUP_DELAY_MS);
    startupTimer?.unref?.();
    loopTimer = (0, deps.setInterval)(() => run('定时检查'), LOGROTATE_INTERVAL_MS);
    loopTimer?.unref?.();
    return loopTimer;
  }
// @bridge-function startLogRotateLoop:end

  return { planRotations, rotateFiles, rotateLogsNow, startLogRotateLoop };
}
