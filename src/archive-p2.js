// 归档升级 P2 第一批（M6 规格 §3 P2 的第 11/13/16 条）：
//   ① pausedUntil 全局暂停：429/403 时写 state/file-archive-pause.json，到期自动恢复，
//      暂停期间任务**快速失败**（抛 ArchivePausedError），而不是每个任务各自重试撞墙。
//   ② 任务断点落盘：每项任务写 progress（batch/已处理/待处理/连续失败），重启后接着做，
//      连续 3 次失败就停。
//   ③ 说明文件 sidecar 写回：商品资料写成素材目录里的「说明.md」，带日期区块，
//      只替换自己那块，**绝不动用户手写内容**，也不删/改名任何用户文件。
//
// 设计取舍：
// - 三个状态文件都在 state/，一律走 file-archive.js 的 writeFileAtomicSync（临时文件 + rename），
//   并记 ownWrites，避免扫描把自己的写当外部改动。
// - 本模块只做「能力 + 纯函数」，不 import bridge.js、不读 config：接线（谁在什么时候调）
//   留给后续批次，这样本批可独立测试、独立 revert。
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync, recordOwnWrite, isOwnWrite } from './file-archive.js';
import { hammingDistance } from './image-hash.js';

export const PAUSE_STATE_FILE = 'file-archive-pause.json';
export const TASK_STATE_FILE = 'file-archive-tasks.json';
export const SIDECAR_FILE_NAME = '说明.md';

export const SIDECAR_START_RE = /<!--\s*archive-facts:start(?:\s+([0-9]{4}-[0-9]{2}-[0-9]{2}))?\s*-->/g;
export const SIDECAR_END_RE = /<!--\s*archive-facts:end(?:\s+([0-9]{4}-[0-9]{2}-[0-9]{2}))?\s*-->/;

/** 触发整体暂停的 HTTP 状态：429 是限流，403 多半是被封/权限掉了。 */
export const PAUSE_HTTP_STATUSES = Object.freeze([429, 403]);
export const DEFAULT_PAUSE_MS = 15 * 60 * 1000;
export const MAX_CONSECUTIVE_FAILURES = 3;

// ── 通用：state 文件读写 ────────────────────────────────────────────────────
const stateFile = (stateDir, name) => path.join(path.resolve(String(stateDir)), name);

function readJsonState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  } catch { return null; }
}

// ── ① 全局暂停 ──────────────────────────────────────────────────────────────
export class ArchivePausedError extends Error {
  constructor({ untilMs, why, scope, nowMs } = {}) {
    const remain = Math.max(0, Number(untilMs) - Number(nowMs ?? Date.now()));
    super(`归档已全局暂停（还剩 ${Math.ceil(remain / 1000)}s）${why ? '：' + why : ''}`);
    this.name = 'ArchivePausedError';
    this.code = 'ARCHIVE_PAUSED';
    this.untilMs = Number(untilMs) || 0;
    this.remainingMs = remain;
    this.why = why || '';
    this.scope = scope || '';
  }
}

export function pauseStatePath(stateDir) { return stateFile(stateDir, PAUSE_STATE_FILE); }

/** 读暂停记录。坏文件/缺字段返回 null（永不因为状态文件坏了而阻塞业务）。 */
export function readArchivePause(stateDir) {
  const rec = readJsonState(pauseStatePath(stateDir));
  if (!rec) return null;
  const untilMs = Number(rec.untilMs ?? rec.until ?? 0);
  if (!Number.isFinite(untilMs) || untilMs <= 0) return null;
  return {
    untilMs,
    why: String(rec.why ?? ''),
    scope: String(rec.scope ?? ''),
    sinceMs: Number(rec.sinceMs ?? 0) || 0,
  };
}

/** 写暂停（原子）。untilMs 必须 > nowMs，否则直接把暂停清掉（避免写进一个已过期的时间）。 */
export function writeArchivePause(stateDir, { untilMs, why = '', scope = '' } = {}, { nowMs = Date.now() } = {}) {
  const until = Number(untilMs);
  if (!Number.isFinite(until)) throw new Error('writeArchivePause 需要 untilMs');
  if (until <= nowMs) { clearArchivePause(stateDir); return null; }
  const rec = { untilMs: until, why: String(why), scope: String(scope), sinceMs: Number(nowMs) };
  writeFileAtomicSync(pauseStatePath(stateDir), `${JSON.stringify(rec, null, 1)}\n`);
  return rec;
}

export function clearArchivePause(stateDir) {
  try { fs.unlinkSync(pauseStatePath(stateDir)); return true; } catch { return false; }
}

/** 当前是否处于暂停中。到期即为 false（不写盘；要清文件用 clearArchivePause）。 */
export function isArchivePaused(stateDir, { nowMs = Date.now() } = {}) {
  const rec = readArchivePause(stateDir);
  if (!rec) return { paused: false, untilMs: 0, remainingMs: 0, why: '', scope: '' };
  const remainingMs = rec.untilMs - Number(nowMs);
  return {
    paused: remainingMs > 0,
    untilMs: rec.untilMs,
    remainingMs: Math.max(0, remainingMs),
    why: rec.why,
    scope: rec.scope,
  };
}

/** 任务入口闸：暂停中直接抛（快速失败，不做任何重试记账）。 */
export function assertArchiveNotPaused(stateDir, { nowMs = Date.now() } = {}) {
  const st = isArchivePaused(stateDir, { nowMs });
  if (st.paused) throw new ArchivePausedError({ ...st, nowMs });
  return st;
}

/** HTTP 失败分类：要不要整体暂停、还值不值得单任务重试。 */
export function classifyArchiveHttpFailure(status) {
  const code = Number(status);
  return {
    status: code,
    // 429/403 说明"现在整体不该再打了"，不是单个任务的问题
    pause: PAUSE_HTTP_STATUSES.includes(code),
    // 5xx/429 是暂时的；403 是被拒，重试没意义
    retryable: code === 429 || (code >= 500 && code < 600),
    why: code === 429 ? 'rate-limited' : code === 403 ? 'forbidden' : code >= 500 ? 'server-error' : 'http-' + code,
  };
}

/**
 * 记录一次 HTTP 失败：该暂停就落盘暂停文件并返回 {paused:true}；
 * 不该暂停返回 {paused:false}，由调用方决定要不要按 retryable 重试。
 */
export function recordArchiveHttpFailure(stateDir, { status, scope = '', nowMs = Date.now(), pauseMs = DEFAULT_PAUSE_MS } = {}) {
  const cls = classifyArchiveHttpFailure(status);
  if (!cls.pause) return { paused: false, ...cls };
  const rec = writeArchivePause(stateDir, { untilMs: Number(nowMs) + Math.max(1000, Number(pauseMs) || DEFAULT_PAUSE_MS), why: cls.why, scope }, { nowMs });
  return { paused: true, ...cls, untilMs: rec ? rec.untilMs : 0 };
}

// ── ② 任务断点 ──────────────────────────────────────────────────────────────
export function taskStatePath(stateDir) { return stateFile(stateDir, TASK_STATE_FILE); }

export function readTaskProgress(stateDir) {
  const rec = readJsonState(taskStatePath(stateDir));
  if (!rec) return null;
  const items = Array.isArray(rec.items) ? rec.items.map(String) : [];
  const done = Array.isArray(rec.done) ? rec.done.map(String).filter((x) => items.includes(x)) : [];
  const failed = rec.failed && typeof rec.failed === 'object' ? rec.failed : {};
  if (!rec.batchId || !items.length) return null;
  return {
    batchId: String(rec.batchId),
    scope: String(rec.scope ?? ''),
    items,
    done,
    failed,
    failures: Math.max(0, Number(rec.failures) || 0),
    state: ['running', 'stopped', 'done'].includes(rec.state) ? rec.state : 'running',
    stoppedReason: String(rec.stoppedReason ?? ''),
    createdAt: Number(rec.createdAt) || 0,
    updatedAt: Number(rec.updatedAt) || 0,
  };
}

export function writeTaskProgress(stateDir, progress) {
  writeFileAtomicSync(taskStatePath(stateDir), `${JSON.stringify(progress, null, 1)}\n`);
  return true;
}

export function clearTaskProgress(stateDir) {
  try { fs.unlinkSync(taskStatePath(stateDir)); return true; } catch { return false; }
}

/** 开一批任务。items 去重但保序（同一项重复入队没意义，还会让 done 计数错）。 */
export function beginTask(stateDir, { batchId, items = [], scope = '', nowMs = Date.now() } = {}) {
  if (!batchId) throw new Error('beginTask 需要 batchId');
  const list = [...new Set(items.map(String).filter(Boolean))];
  if (!list.length) throw new Error('beginTask 需要至少一个 item');
  const now = Number(nowMs) || Date.now();
  const progress = {
    batchId: String(batchId), scope: String(scope), items: list, done: [], failed: {},
    failures: 0, state: 'running', stoppedReason: '', createdAt: now, updatedAt: now,
  };
  writeTaskProgress(stateDir, progress);
  return progress;
}

export function nextPendingTask(progress) {
  if (!progress) return null;
  if (progress.state === 'stopped') return null;
  const done = new Set(progress.done);
  return progress.items.find((it) => !done.has(it)) ?? null;
}

export function taskStatus(progress) {
  if (!progress) return { batchId: '', state: 'idle', total: 0, done: 0, pending: 0, failures: 0, stoppedReason: '' };
  const done = progress.done.length;
  return {
    batchId: progress.batchId,
    state: progress.state,
    total: progress.items.length,
    done,
    pending: progress.items.length - done,
    failures: progress.failures,
    stoppedReason: progress.stoppedReason,
  };
}

/**
 * 记一项的结果。ok → 进 done、连续失败清零；fail → 连续失败 +1，够 3 次把整批判 stopped。
 * batchId 不匹配返回 {stale:true} 且不写盘——防止上一批的迟到结果污染新批。
 */
export function markTaskItem(stateDir, { batchId, item, ok, error = '', nowMs = Date.now() } = {}) {
  const progress = readTaskProgress(stateDir);
  if (!progress) return { stale: true, reason: 'no-progress' };
  if (String(progress.batchId) !== String(batchId)) return { stale: true, reason: 'batch-mismatch', current: progress.batchId };
  const key = String(item);
  if (!progress.items.includes(key)) return { stale: true, reason: 'unknown-item' };

  if (ok) {
    if (!progress.done.includes(key)) progress.done.push(key);
    delete progress.failed[key];
    progress.failures = 0;
  } else {
    progress.failed[key] = { error: String(error || ''), at: Number(nowMs) || Date.now() };
    progress.failures = (Number(progress.failures) || 0) + 1;
    if (progress.failures >= MAX_CONSECUTIVE_FAILURES) {
      progress.state = 'stopped';
      progress.stoppedReason = String(error || `连续 ${MAX_CONSECUTIVE_FAILURES} 次失败`);
    }
  }
  if (progress.done.length >= progress.items.length) progress.state = 'done';
  progress.updatedAt = Number(nowMs) || Date.now();
  writeTaskProgress(stateDir, progress);
  return { stale: false, ...taskStatus(progress) };
}

// ── ③ 说明文件 sidecar ──────────────────────────────────────────────────────
export function sidecarPath(dirAbs) { return path.join(String(dirAbs), SIDECAR_FILE_NAME); }

function dateKeyOf(nowMs) {
  const d = new Date(Number(nowMs) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const SIDECAR_FIELD_ORDER = [
  ['boothId', '商品号'], ['title', '标题'], ['shop', '店铺'], ['price', '价格'],
  ['category', '分类'], ['tags', '标签'], ['url', '链接'],
];

/** 生成一个带日期标记的自有区块（markdown）。空字段不写。 */
export function buildSidecarBlock(facts = {}, { dateKey = dateKeyOf() } = {}) {
  const lines = [`<!-- archive-facts:start ${dateKey} -->`, '', `## ${dateKey}`, ''];
  let wrote = 0;
  for (const [key, label] of SIDECAR_FIELD_ORDER) {
    const v = facts[key];
    const text = Array.isArray(v) ? v.filter(Boolean).join(' / ') : String(v ?? '').trim();
    if (!text) continue;
    lines.push(`- ${label}：${text}`);
    wrote++;
  }
  lines.push('', `<!-- archive-facts:end ${dateKey} -->`);
  return { block: lines.join('\n'), fields: wrote };
}

/**
 * 把自己的区块并入既有文本：同日期区块**原位替换**，否则追加到末尾。
 * 其它内容（用户手写的、别的日期的区块）一个字节都不动。
 * 标记不成对时不做手术，直接追加并报 unbalanced —— 宁可多一块，也不切坏用户文件。
 */
export function mergeSidecar(existingText, block, { dateKey = dateKeyOf() } = {}) {
  const text = String(existingText ?? '');
  SIDECAR_START_RE.lastIndex = 0;
  const starts = [...text.matchAll(SIDECAR_START_RE)];
  const spans = [];
  for (const m of starts) {
    const from = m.index;
    const startTag = m[0];
    const bodyStart = from + startTag.length;
    const tail = text.slice(bodyStart);
    const endMatch = tail.match(/<!--\s*archive-facts:end(?:\s+[0-9]{4}-[0-9]{2}-[0-9]{2})?\s*-->/);
    if (!endMatch) return { text: appendBlock(text, block), replaced: false, appended: true, unbalanced: true };
    spans.push({ from, to: bodyStart + endMatch.index + endMatch[0].length, dateKey: m[1] || '' });
  }
  const hit = spans.find((s) => s.dateKey === dateKey) ?? spans.find((s) => !s.dateKey);
  if (!hit) return { text: appendBlock(text, block), replaced: false, appended: true, unbalanced: false };
  return {
    text: text.slice(0, hit.from) + block + text.slice(hit.to),
    replaced: true,
    appended: false,
    unbalanced: false,
  };
}

function appendBlock(text, block) {
  if (!text) return block + '\n';
  const trimmed = text.replace(/\s+$/, '');
  return `${trimmed}\n\n${block}\n`;
}

export function readSidecar(dirAbs) {
  try {
    const p = sidecarPath(dirAbs);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return { path: p, text: '', symlink: true };
    return { path: p, text: fs.readFileSync(p, 'utf8'), symlink: false };
  } catch { return { path: sidecarPath(dirAbs), text: '', missing: true, symlink: false }; }
}

/**
 * 把商品资料写回素材目录的「说明.md」。
 * - dryRun：只算不写（返回会变成什么，便于预演）；
 * - 目录必须已存在（不隐式创建素材目录）；
 * - 符号链接拒绝写（防止把链接指向的文件覆盖掉）；
 * - 写完记 ownWrites，扫描不会当成外部改动。
 */
export function writeArchiveSidecar(dirAbs, facts = {}, { nowMs = Date.now(), dateKey, dryRun = false } = {}) {
  const dir = path.resolve(String(dirAbs));
  let st;
  try { st = fs.statSync(dir); } catch { return { ok: false, reason: 'dir-missing', path: sidecarPath(dir) }; }
  if (!st.isDirectory()) return { ok: false, reason: 'not-a-directory', path: sidecarPath(dir) };

  const key = dateKey || dateKeyOf(nowMs);
  const file = sidecarPath(dir);
  const cur = readSidecar(dir);
  if (cur.symlink) return { ok: false, reason: 'symlink', path: file };

  const { block, fields } = buildSidecarBlock(facts, { dateKey: key });
  const merged = mergeSidecar(cur.text || '', block, { dateKey: key });
  const result = {
    ok: true, path: file, dateKey: key, fields,
    replaced: merged.replaced, appended: merged.appended, unbalanced: merged.unbalanced,
    bytes: Buffer.byteLength(merged.text, 'utf8'), dryRun: !!dryRun,
  };
  if (dryRun) return { ...result, text: merged.text };
  writeFileAtomicSync(file, merged.text);
  recordOwnWrite(file);
  return { ...result, ownWrite: isOwnWrite(file) };
}

export { dateKeyOf as sidecarDateKey };

// ── ④ Range 断点续传（M6 规格 P2-12）────────────────────────────────────────
// 设计：真正的网络请求由调用方注入 `fetchRange(url, { start, headers })`（生产端应复用它
// 现有的 safe-fetch 校验，避免这里绕开 SSRF 防护）；本函数只负责「分片文件 + 校验器 + 有限重试」。
// 约束：服务器忽略 Range 时必须从头写（绝不能 append 出 `abcabcdef`）；校验器变了就丢掉旧分片；
// 只有完整收齐才 rename 到目标文件——中途失败保留 .part，下次接着传。

export const DEFAULT_RESUME_RETRIES = 3;
export const RESUME_STATE_SUFFIX = '.json';

/** `bytes 100-299/300` → { start, end, total }；`*` 或非法返回 null。 */
export function parseContentRange(value) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value ?? '').trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
}

/** 续传请求头：start>0 才带 Range，有校验器就带 If-Range（校验器变了服务器会回 200 全量）。 */
export function resumeFetchHeaders({ start = 0, etag = '', lastModified = '' } = {}) {
  const headers = {};
  if (Number(start) > 0) {
    headers.Range = `bytes=${Number(start)}-`;
    const validator = String(etag || lastModified || '');
    if (validator) headers['If-Range'] = validator;
  }
  return headers;
}

function headerOf(headers, name) {
  if (!headers) return '';
  const lower = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (String(k).toLowerCase() === lower) return String(v ?? '');
  return '';
}

function fileSize(fsImpl, file) {
  try { return fsImpl.statSync(file).size || 0; } catch { return 0; }
}

async function* chunksOf(body) {
  if (!body) return;
  if (Buffer.isBuffer(body) || typeof body === 'string') { yield Buffer.from(body); return; }
  if (Array.isArray(body)) { for (const b of body) yield Buffer.from(b); return; }
  for await (const chunk of body) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

/**
 * 带断点续传的下载。返回 { bytes, resumed, attempts, restarted }。
 * @param {object} o
 * @param {string} o.url
 * @param {string} o.destPath 最终文件（只有收齐才写这里）
 * @param {string} [o.tempDir] 分片目录（独立临时目录；默认与目标同目录）
 * @param {(url: string, o: {start: number, headers: object}) => Promise<{status:number, headers:object, body:any}>} o.fetchRange
 * @param {number} [o.maxBytes] 上限；超了立刻失败（不继续写）
 * @param {number} [o.maxRetries] 失败重试次数（默认 3）
 */
export async function downloadFileResumable({
  url, destPath, tempDir = '', fetchRange, maxBytes = 0,
  maxRetries = DEFAULT_RESUME_RETRIES, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fsImpl = fs
} = {}) {
  if (typeof fetchRange !== 'function') throw new Error('downloadFileResumable 需要注入 fetchRange(url, { start, headers })');
  const src = String(url || '');
  if (!src) throw new Error('downloadFileResumable 需要 url');
  const dest = path.resolve(String(destPath));
  const tmpDir = tempDir ? path.resolve(String(tempDir)) : path.dirname(dest);
  fsImpl.mkdirSync(tmpDir, { recursive: true });
  fsImpl.mkdirSync(path.dirname(dest), { recursive: true });
  const partPath = path.join(tmpDir, `${path.basename(dest)}.part`);
  const statePath = `${partPath}${RESUME_STATE_SUFFIX}`;
  const retries = Math.max(0, Math.min(10, Number(maxRetries) || 0));
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : 0;
  const backoff = (n) => Math.min(2000, 100 * 2 ** Math.max(0, n - 1));
  let state = readJsonState(statePath) || {};
  if (String(state.url || '') !== src) {
    // 换了 URL：旧分片不可信
    try { fsImpl.rmSync(partPath, { force: true }); } catch {}
    state = { url: src };
    writeState(statePath, state);
  }
  let bytes = fileSize(fsImpl, partPath);
  const initialBytes = bytes;
  let restarted = false;
  function writeState(file, obj) {
    try { fsImpl.writeFileSync(`${file}.tmp`, JSON.stringify(obj)); fsImpl.renameSync(`${file}.tmp`, file); } catch {}
  }

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let resp;
    try {
      resp = await fetchRange(src, { start: bytes, headers: resumeFetchHeaders({ start: bytes, etag: state.etag, lastModified: state.lastModified }) });
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleep(backoff(attempt + 1));
      continue;
    }
    const status = Number(resp?.status || 0);
    const headers = resp?.headers || {};
    const etag = headerOf(headers, 'etag');
    const lastModified = headerOf(headers, 'last-modified');

    // 校验器变了：旧分片不再可信，丢掉重来（只免费重来一次，避免死循环）。
    const validatorChanged = bytes > 0 && ((state.etag && etag && state.etag !== etag)
      || (state.lastModified && lastModified && state.lastModified !== lastModified));
    if (validatorChanged) {
      try { fsImpl.rmSync(partPath, { force: true }); } catch {}
      bytes = 0;
      state = { url: src };
      writeState(statePath, state);
      if (!restarted) { restarted = true; continue; }
      throw new Error('续传失败：文件已变更（ETag/Last-Modified 不一致）');
    }

    if (status === 416) {
      // 本地已有分片不小于远端：收齐了就落盘，否则从头来一次。
      if (Number(state.totalBytes) > 0 && bytes === Number(state.totalBytes)) {
        fsImpl.renameSync(partPath, dest);
        try { fsImpl.rmSync(statePath, { force: true }); } catch {}
        return { bytes, resumed: true, attempts: attempt + 1, restarted };
      }
      try { fsImpl.rmSync(partPath, { force: true }); } catch {}
      bytes = 0;
      state = { url: src };
      writeState(statePath, state);
      if (!restarted) { restarted = true; continue; }
      throw new Error('续传失败：服务器拒绝 Range，且本地分片与总大小不符');
    }
    if (status === 200) {
      // 服务器忽略了 Range（换了内容或本来就支持全量）：必须从头写，绝不能追加。
      try { fsImpl.rmSync(partPath, { force: true }); } catch {}
      bytes = 0;
      if (!state.url) state.url = src;
      state.etag = etag || '';
      state.lastModified = lastModified || '';
      state.totalBytes = Number(headerOf(headers, 'content-length')) || 0;
      if (limit && state.totalBytes > limit) throw new Error(`下载超过上限（${state.totalBytes} > ${limit} 字节）`);
      writeState(statePath, state);
    } else if (status === 206) {
      const cr = parseContentRange(headerOf(headers, 'content-range'));
      if (!cr) throw new Error('续传失败：206 但缺少合法 Content-Range');
      if (cr.total != null) {
        if (limit && cr.total > limit) throw new Error(`下载超过上限（${cr.total} > ${limit} 字节）`);
        state.totalBytes = cr.total;
      }
      if (cr.start !== bytes) {
        // 服务器给的起点和本地分片对不上：丢掉重来，不能拼。
        try { fsImpl.rmSync(partPath, { force: true }); } catch {}
        bytes = 0;
        if (!restarted) { restarted = true; continue; }
        throw new Error(`续传失败：服务器从 ${cr.start} 开始，本地要 ${bytes}`);
      }
      state.etag = etag || state.etag || '';
      state.lastModified = lastModified || state.lastModified || '';
      writeState(statePath, state);
    } else if (status === 429 || status >= 500) {
      if (attempt >= retries) throw new Error(`下载失败：HTTP ${status}`);
      await sleep(backoff(attempt + 1));
      continue;
    } else {
      throw new Error(`下载失败：HTTP ${status}`);
    }

    let written = 0;
    try {
      for await (const chunk of chunksOf(resp.body)) {
        written += chunk.length;
        if (limit && bytes + written > limit) throw new Error(`下载超过上限（>${limit} 字节）`);
        fsImpl.appendFileSync(partPath, chunk);
      }
    } catch (error) {
      bytes = fileSize(fsImpl, partPath);
      writeState(statePath, { ...state, bytes });
      if (attempt >= retries) throw error;
      await sleep(backoff(attempt + 1));
      continue;
    }
    bytes = fileSize(fsImpl, partPath);
    writeState(statePath, { ...state, bytes });
    const total = Number(state.totalBytes) || bytes;
    if (total && bytes < total) {
      if (attempt >= retries) throw new Error(`下载不完整：${bytes}/${total} 字节`);
      await sleep(backoff(attempt + 1));
      continue;
    }
    fsImpl.renameSync(partPath, dest);
    try { fsImpl.rmSync(statePath, { force: true }); } catch {}
    return { bytes, resumed: initialBytes > 0 || restarted, attempts: attempt + 1, restarted };
  }
  throw new Error('下载失败：重试次数用尽');
}

// ── ⑤ 封面 dHash 判同图（M6 规格 P2-14）────────────────────────────────────
// 复用 src/image-hash.js 的 9×8 dHash（与表情共用同一套算法），但**阈值不共用**：
// 表情是 1（严，防误并）；文件封面默认 10（宽，同一张图被重编码/加白边也能认出来）。
export const COVER_DHASH_THRESHOLD = 10;
const DHASH_HEX_RE = /^[0-9a-f]{16}$/;

export function normalizeDhash(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** 两个 dHash 是否同一张封面。无效/空 hash 一律 false（不知道就不合并）。 */
export function sameCover(a, b, { threshold = COVER_DHASH_THRESHOLD } = {}) {
  const x = normalizeDhash(a);
  const y = normalizeDhash(b);
  if (!DHASH_HEX_RE.test(x) || !DHASH_HEX_RE.test(y)) return false;
  const t = Number(threshold);
  if (!Number.isFinite(t) || t < 0) return false;
  return hammingDistance(x, y) <= t;
}
