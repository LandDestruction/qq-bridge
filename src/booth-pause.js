// BOOTH 全局限速暂停：429/403 一旦出现，**所有**打 BOOTH 的任务一起停，包括
// 找号搜索、商品页抓取（booth-meta）、展示图抓取（booth-cover）、已购清单同步。
//
// 为什么从 src/library-find.js 抽出来：以前暂停只有找号在遵守，商品页/封面照打不误——
// 结果是「搜索退避了，封面还在敲门」，照样把出口 IP 打黑。现在这份状态文件是唯一真相，
// 谁抓到 429/403 谁写，谁要发请求谁先读，格式只有一种。
//
// 兼容约定：文件名与字段（pausedUntil/reason/status/at）沿用线上正在跑的
// state/booth-search-pause.json，别改名（改名等于所有已积累的暂停失效）。
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOOTH_PAUSE_FILE = 'booth-search-pause.json';
export const SEARCH_PAUSE_429_MS = 10 * 60 * 1000;   // 429 没给 Retry-After 时的默认停 10 分钟
export const SEARCH_PAUSE_403_MS = 30 * 60 * 1000;   // 403 通常是区域/风控，停久一点
export const SEARCH_PAUSE_MIN_MS = 60 * 1000;        // 退避下限：Retry-After 说 1 秒也别立刻再打
export const SEARCH_PAUSE_MAX_MS = 6 * 60 * 60 * 1000; // 上限：Retry-After 再大也不超 6 小时

/** 默认 state 目录：仓库根/state（按本文件位置推，不依赖进程 cwd，脚本/测试/桥接都成立）。 */
export function defaultStateDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state');
}

/** 暂停状态文件绝对路径。 */
export function pauseFilePath(stateDir = '') {
  return path.join(String(stateDir || defaultStateDir()), BOOTH_PAUSE_FILE);
}

function clampMs(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 把一次非 2xx 响应归成「要不要暂停」。
 * @param {{status?:number, retryAfter?:number}} input retryAfter 单位秒（HTTP Retry-After 的数字形态）
 * @returns {{pauseMs:number, reason:string, status:number}|null} 不是限速信号就返回 null
 */
export function searchPauseFor({ status = 0, retryAfter = null } = {}) {
  const code = Number(status) || 0;
  if (code === 429) {
    const retryMs = Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : 0;
    return {
      pauseMs: clampMs(retryMs || SEARCH_PAUSE_429_MS, SEARCH_PAUSE_MIN_MS, SEARCH_PAUSE_MAX_MS),
      reason: 'BOOTH 搜索被限速（HTTP 429）',
      status: 429
    };
  }
  if (code === 403) {
    return { pauseMs: SEARCH_PAUSE_403_MS, reason: 'BOOTH 搜索被拒绝（HTTP 403，可能要登录或换网络）', status: 403 };
  }
  return null;
}

/** 读盘回来的暂停状态一律过这里：坏值当「没暂停」，避免一个脏文件把任务永久锁死。 */
export function normalizeSearchPause(raw, now = Date.now()) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const until = Number(src.pausedUntil);
  const safeUntil = Number.isFinite(until) && until > 0 ? Math.min(until, now + SEARCH_PAUSE_MAX_MS) : 0;
  return {
    pausedUntil: safeUntil,
    reason: String(src.reason ?? '').slice(0, 200),
    status: Number.isFinite(Number(src.status)) ? Number(src.status) : 0,
    at: Number.isFinite(Number(src.at)) && Number(src.at) > 0 ? Number(src.at) : 0
  };
}

/** 当前是否在暂停里 + 还剩多久（前端/日志都用这一份口径）。 */
export function searchPauseState(pause, now = Date.now()) {
  const normalized = normalizeSearchPause(pause, now);
  const remainingMs = normalized.pausedUntil > now ? normalized.pausedUntil - now : 0;
  return {
    paused: remainingMs > 0,
    remainingMs,
    pausedUntil: normalized.pausedUntil,
    reason: normalized.reason,
    status: normalized.status
  };
}

/** 一句话人话（UI 顶部提示、日志、接口 error 都用它，保证口径一致）。 */
export function describeSearchPause(pause, now = Date.now()) {
  const state = searchPauseState(pause, now);
  if (!state.paused) return '';
  const minutes = Math.max(1, Math.round(state.remainingMs / 60000));
  const wait = minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
  return `${state.reason || 'BOOTH 搜索被限流'}，还要等约 ${wait} 再试`;
}

/** 抓取器（商品页/封面）用的错误文案：调用方直接塞进 status:'paused' 的结果里。 */
export function pauseErrorMessage(pause, now = Date.now()) {
  const state = searchPauseState(pause, now);
  if (!state.paused) return '';
  const minutes = Math.max(1, Math.round(state.remainingMs / 60000));
  return `BOOTH 正在限速暂停，剩余 ${minutes} 分钟`;
}

/** 把 pauseMs 落成一条暂停记录（给调用方在收到 429/403 后直接写盘）。 */
export function pauseRecordFrom({ status = 0, retryAfter = null, now = Date.now() } = {}) {
  const hit = searchPauseFor({ status, retryAfter });
  if (!hit) return null;
  return normalizeSearchPause({ pausedUntil: now + hit.pauseMs, reason: hit.reason, status: hit.status, at: now }, now);
}

function pickFsp(fsImpl) {
  const candidate = fsImpl?.promises;
  return candidate && typeof candidate.readFile === 'function' ? candidate : fsPromises;
}

/**
 * 读暂停（异步，别用 sync 阻塞事件循环）。
 * 任何解析/读盘错误都当「没暂停」——状态文件坏了不能让所有 BOOTH 功能停摆。
 * @param {{fs?:object, stateDir?:string, now?:number}} [opts]
 */
export async function readPause(opts = {}) {
  const fsp = pickFsp(opts.fs);
  const file = pauseFilePath(opts.stateDir);
  try {
    const text = await fsp.readFile(file, 'utf8');
    return normalizeSearchPause(JSON.parse(String(text).replace(/^\uFEFF/, '')), Number(opts.now) || Date.now());
  } catch {
    return normalizeSearchPause(null, Number(opts.now) || Date.now());
  }
}

/**
 * 写暂停（原子：临时文件 + rename）。传 normalizeSearchPause(null) 的等价物即是「清除」，
 * 与旧实现（写全零记录）保持同一格式，读的一方不用区分「文件不存在」和「已解除」。
 * @param {{fs?:object, stateDir?:string, now?:number}} [opts]
 * @param {object} pause
 */
export async function writePause(opts = {}, pause) {
  const fsp = pickFsp(opts.fs);
  const file = pauseFilePath(opts.stateDir);
  const record = normalizeSearchPause(pause, Number(opts.now) || Date.now());
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, `${JSON.stringify(record, null, 1)}\n`, 'utf8');
    await fsp.rename(tmp, file);
    return record;
  } catch (error) {
    // 清 tmp 失败也不该盖住原错误；写暂停失败同样只降级（调用方已知道被限速了）。
    try { await fsp.rm(tmp, { force: true }); } catch {}
    throw error;
  }
}

/** 收到 429/403 后记一笔全局暂停（所有抓取入口共用这一个写口，格式只有一种）。 */
export async function noteBoothPause(opts = {}, { status = 0, retryAfter = null } = {}) {
  const now = Number(opts.now) || Date.now();
  const record = pauseRecordFrom({ status, retryAfter, now });
  if (!record) return null;
  try {
    await writePause({ ...opts, now }, record);
    return record;
  } catch {
    return record; // 写盘失败也把「现在该停」的事实返回给调用方
  }
}

/** Retry-After 头解析（秒数；HTTP 日期形态忽略，交给默认停时）。 */
export function retryAfterOf(headers) {
  try {
    const raw = headers?.get?.('retry-after');
    const sec = Number(raw);
    return Number.isFinite(sec) && sec > 0 ? sec : null;
  } catch {
    return null;
  }
}
