// D1：群友印象归纳的「后台跑一轮」——控制台按钮触发，另外每两天凌晨自动跑一次。
//
// 为什么 spawn 现有 CLI，而不是在桥接里重写归纳：
// scripts/build-impressions.mjs 那条链路已经真机跑通过（283 秒、¥0.14、原子写盘、分片失败重跑），
// 切分片/校验/合并的判定只在 src/impressions.js 里有一份。桥接这边只负责三件事——
// 单飞（同一时刻只跑一轮）、计时（每两天）、状态查询（按钮要能显示进度），不抄第二份归纳逻辑。
//
// 形状约定：真正的逻辑都是**模块作用域函数**（ctx 当第一个参数），工厂只负责建 ctx 并把它们绑成方法。
// 这样每个对外方法都能打 @bridge-function 标记（标记必须在行首），审计才认。

const DEFAULT_EVERY_DAYS = 2;
const DEFAULT_HOUR = 4;
const DEFAULT_MINUTE = 10;
// 正常一轮 4~5 分钟；20 分钟还没结束就当成卡死，允许下一次手动/定时覆盖，
// 否则一个残留的 pid 会把「立即归纳」永久锁死（重启后锁文件残留的教训）。
const RUN_TIMEOUT_MS = 20 * 60 * 1000;

// @bridge-function nextImpressionRunAt:start
/**
 * 下一次该自动归纳的时刻（毫秒时间戳）。
 * 纯函数：只依赖传入的 now，方便离线单测「今天还没到点 / 已经过点 / 跨月」三种情况。
 */
export function nextImpressionRunAt(nowMs, options = {}) {
  const everyDays = Math.max(1, Math.floor(Number(options.everyDays) || DEFAULT_EVERY_DAYS));
  const hour = Math.min(23, Math.max(0, Math.floor(Number(options.hour ?? DEFAULT_HOUR))));
  const minute = Math.min(59, Math.max(0, Math.floor(Number(options.minute ?? DEFAULT_MINUTE))));
  const now = Number(nowMs) || Date.now();
  const base = new Date(now);
  const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
  while (at.getTime() <= now) at.setDate(at.getDate() + everyDays);
  return at.getTime();
}
// @bridge-function nextImpressionRunAt:end

function stateFilePath(ctx) { return ctx.deps.path.join(ctx.deps.STATE_DIR, 'impressions-run.json'); }
function logFilePath(ctx) { return ctx.deps.path.join(ctx.deps.ROOT, 'logs', 'impressions-run.log'); }

function readRunState(ctx) {
  try { return JSON.parse(ctx.deps.fs.readFileSync(stateFilePath(ctx), 'utf8')) || {}; } catch { return {}; }
}

function writeRunState(ctx, next) {
  try {
    const file = stateFilePath(ctx);
    ctx.deps.fs.mkdirSync(ctx.deps.path.dirname(file), { recursive: true });
    ctx.deps.fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    ctx.deps.log(`[印象归纳] 写运行状态失败：${error?.message ?? error}`);
  }
}

function pidAlive(ctx, pid) {
  try { return typeof ctx.deps.isPidAlive === 'function' ? ctx.deps.isPidAlive(pid) : true; } catch { return false; }
}

// @bridge-function status:start
/** 当前状态：running 只认「有 pid、进程还活着、没超过超时」，不认文件里一句 running。 */
function status(ctx) {
  const state = readRunState(ctx);
  const startedAt = Number(state.startedAt) || 0;
  const running = Boolean(startedAt && state.pid && !state.finishedAt
    && Date.now() - startedAt < RUN_TIMEOUT_MS && pidAlive(ctx, state.pid));
  return {
    running,
    startedAt,
    finishedAt: Number(state.finishedAt) || 0,
    trigger: String(state.trigger || ''),
    ok: typeof state.ok === 'boolean' ? state.ok : null,
    code: typeof state.code === 'number' ? state.code : null,
    error: String(state.error || ''),
    logFile: logFilePath(ctx),
    everyDays: ctx.everyDays,
    nextRunAt: nextImpressionRunAt(Date.now(), { everyDays: ctx.everyDays })
  };
}
// @bridge-function status:end

// @bridge-function startRun:start
/** 手动/定时共用的入口：已有任务在跑就直接回 busy，不排队也不杀旧进程。 */
function startRun(ctx, trigger = 'console') {
  const before = status(ctx);
  if (before.running) return { ok: false, busy: true, status: before };
  const { deps } = ctx;
  if (typeof deps.spawn !== 'function') return { ok: false, busy: false, error: 'spawn 不可用', status: before };

  let fd = null;
  try {
    const logFile = logFilePath(ctx);
    deps.fs.mkdirSync(deps.path.dirname(logFile), { recursive: true });
    fd = deps.fs.openSync(logFile, 'a');
    deps.fs.writeSync(fd, `\n===== ${new Date().toISOString()} 印象归纳开始（${trigger}）=====\n`);
  } catch (error) {
    deps.log(`[印象归纳] 打不开日志文件 ${logFilePath(ctx)}：${error?.message ?? error}`);
    return { ok: false, busy: false, error: '打不开日志文件', status: before };
  }

  const state = { startedAt: Date.now(), pid: 0, trigger, finishedAt: 0, ok: null };
  try {
    const script = deps.path.join(deps.ROOT, 'scripts', 'build-impressions.mjs');
    const child = deps.spawn(deps.execPath, [script, '--apply', `--days=${deps.days || 2}`], {
      cwd: deps.ROOT,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: deps.env
    });
    state.pid = Number(child.pid) || 0;
    writeRunState(ctx, state);
    deps.log(`[印象归纳] 已开始（${trigger}）pid=${state.pid}，日志 ${logFilePath(ctx)}`);
    const finish = (ok, extra = {}) => {
      writeRunState(ctx, { ...readRunState(ctx), ...state, finishedAt: Date.now(), ok, ...extra });
      deps.log(`[印象归纳] ${ok ? '完成' : '失败'}（${trigger}）：${ok ? '已写入 state/impressions.json' : (extra.error || `退出码 ${extra.code}`)}`);
      try { if (fd !== null) deps.fs.closeSync(fd); } catch {}
    };
    child.on('exit', (code, signal) => finish(code === 0, { code: Number(code) || 0, error: code === 0 ? '' : `退出码 ${code ?? signal}` }));
    child.on('error', (error) => finish(false, { code: -1, error: String(error?.message || error) }));
    if (typeof child.unref === 'function') child.unref();
  } catch (error) {
    writeRunState(ctx, { ...state, finishedAt: Date.now(), ok: false, error: String(error?.message || error) });
    deps.log(`[印象归纳] 启动失败：${error?.message ?? error}`);
    try { if (fd !== null) deps.fs.closeSync(fd); } catch {}
    return { ok: false, busy: false, error: String(error?.message || error), status: status(ctx) };
  }
  return { ok: true, busy: false, status: status(ctx) };
}
// @bridge-function startRun:end

// @bridge-function startSchedule:start
/** 每两天一次：到点就跑，跑完再排下一次；timer unref，不挡进程退出。 */
function startSchedule(ctx) {
  if (ctx.timer) return nextImpressionRunAt(Date.now(), { everyDays: ctx.everyDays });
  const scheduleNext = () => {
    const at = nextImpressionRunAt(Date.now(), { everyDays: ctx.everyDays });
    ctx.timer = setTimeout(() => {
      ctx.timer = null;
      try { startRun(ctx, 'schedule'); } catch (error) { ctx.deps.log(`[印象归纳] 定时触发失败：${error?.message ?? error}`); }
      scheduleNext();
    }, Math.max(1000, at - Date.now()));
    if (typeof ctx.timer?.unref === 'function') ctx.timer.unref();
    return at;
  };
  const at = scheduleNext();
  ctx.deps.log(`[印象归纳] 每 ${ctx.everyDays} 天自动归纳一次，下次 ${new Date(at).toLocaleString('zh-CN')}`);
  return at;
}
// @bridge-function startSchedule:end

// @bridge-function stop:start
function stop(ctx) {
  if (ctx.timer) clearTimeout(ctx.timer);
  ctx.timer = null;
}
// @bridge-function stop:end

// @bridge-function nextRunAt:start
function nextRunAt(ctx) {
  return nextImpressionRunAt(Date.now(), { everyDays: ctx.everyDays });
}
// @bridge-function nextRunAt:end

export function createImpressionsRunner(deps) {
  // 审计要求工厂期只存 deps、不取值（eager access），所以这里不碰 deps.*（except everyDays 由 ctx 建时给默认）。
  const ctx = { deps, everyDays: DEFAULT_EVERY_DAYS, timer: null };
  return {
    startRun: (trigger) => startRun(ctx, trigger),
    status: () => status(ctx),
    startSchedule: () => startSchedule(ctx),
    stop: () => stop(ctx),
    nextRunAt: () => nextRunAt(ctx)
  };
}
