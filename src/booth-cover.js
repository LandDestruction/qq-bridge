// BOOTH 商品展示图（cover）抓取与缓存。
//
// 口径照抄 BOOTH Library Manager 的 item 模型：每个商品一条记录，`thumbnailUrl` 就是商品页展示图。
// 我们把它落成 `state/booth-cache/<boothId>/cover.jpg`（长边 ≤512、≤200KB），
// 供库页面的 `/api/library/item-thumb` 直接读本地文件，避免每次都打 BOOTH CDN。
//
// 约定（交接里也写）：
// - 对 A 暴露 `getBoothCover(boothId)`（本模块导出）与 `GET /api/files/cover/<boothId>`（桥接 HTTP）。
// - 成功缓存 30 天；失败缓存 1 天（避免 429/超时后立刻反复重试）。
// - 抓取失败只返回 status/error（`cover_error`），绝不 throw、不阻塞转存。

import fs from 'node:fs';
import path from 'node:path';
import { parseBoothCoverSource, BOOTH_MAX_RESPONSE_BYTES, BOOTH_ITEM_BASE } from './booth-meta.js';
import { normalizeThumbnailFile, imageSize } from './booth-thumb.js';
import { safeFetchToFile } from './safe-fetch.js';
import { readPause, searchPauseState, noteBoothPause, pauseErrorMessage, retryAfterOf } from './booth-pause.js';

export const COVER_MAX_EDGE = 512;
export const COVER_MAX_BYTES = 200 * 1024;
export const COVER_OK_TTL_MS = 30 * 24 * 3600 * 1000;
export const COVER_FAIL_TTL_MS = 24 * 3600 * 1000;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

export function coverPaths(cacheRoot, boothId) {
  const dir = path.join(String(cacheRoot), String(boothId));
  return { dir, coverPath: path.join(dir, 'cover.jpg'), metaPath: path.join(dir, 'cover.json') };
}

/** 已经有新鲜 cover 时直接返回路径（给 API/库页面做零成本读取）。 */
export function getBoothCoverPath(boothId, { cacheRoot = 'state/booth-cache' } = {}) {
  const { coverPath, metaPath } = coverPaths(cacheRoot, boothId);
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.status !== 'ok' || !fs.existsSync(coverPath)) return '';
    if (Date.now() - Number(meta.fetchedAt || 0) > COVER_OK_TTL_MS) return '';
    return coverPath;
  } catch {
    return '';
  }
}

function readMeta(metaPath) {
  try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return null; }
}

function writeMeta(metaPath, meta) {
  try {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 1)}\n`, 'utf8');
  } catch {}
}

/**
 * 抓/取一个 BOOTH 商品的 cover。
 * @returns {Promise<{ok:boolean,status:'ok'|'not_found'|'blocked'|'error',path:string,bytes:number,
 *   width:number,height:number,cached:boolean,error:string,coverError:string}>}
 */
export async function getBoothCover(boothId, {
  cacheRoot = 'state/booth-cache', fetchImpl = globalThis.fetch, downloadImpl = null,
  now = Date.now(), maxEdge = COVER_MAX_EDGE, maxBytes = COVER_MAX_BYTES,
  timeoutMs = 15000, rateLimitMs = 1000, force = false, log = () => {}, stateDir = ''
} = {}) {
  const id = String(boothId ?? '').trim();
  const { dir, coverPath, metaPath } = coverPaths(cacheRoot, id);
  const base = { ok: false, status: 'error', path: '', bytes: 0, width: 0, height: 0, cached: false, error: '', coverError: '' };
  if (!/^\d{5,9}$/.test(id)) return { ...base, error: 'BOOTH 号必须是 5~9 位数字', coverError: '无效 BOOTH 号' };
  const cachedMeta = readMeta(metaPath);
  if (!force && cachedMeta && Number.isFinite(Number(cachedMeta.fetchedAt))) {
    const age = now - Number(cachedMeta.fetchedAt);
    if (cachedMeta.status === 'ok' && fs.existsSync(coverPath) && age >= 0 && age < COVER_OK_TTL_MS) {
      const dims = imageSize(coverPath) || { width: 0, height: 0 };
      return { ...base, ok: true, status: 'ok', path: coverPath, bytes: fs.statSync(coverPath).size, ...dims, cached: true, error: '', coverError: '' };
    }
    if (cachedMeta.status !== 'ok' && age >= 0 && age < COVER_FAIL_TTL_MS) {
      return { ...base, status: cachedMeta.status || 'error', cached: true, error: String(cachedMeta.error || ''), coverError: String(cachedMeta.error || '') };
    }
  }
  if (typeof fetchImpl !== 'function') return { ...base, error: '没有可用的 fetch', coverError: '没有可用的 fetch' };
  // 全局暂停：找号/商品页谁挨了 429/403 都会写这份状态，封面抓取必须一起等，
  // 否则「搜索退避了、封面还在敲门」，照样把出口 IP 打黑（P2 验收的口径）。
  const pauseRec = await readPause({ stateDir: stateDir || undefined, now });
  if (searchPauseState(pauseRec, now).paused) {
    return { ...base, status: 'paused', paused: true, error: pauseErrorMessage(pauseRec, now), coverError: pauseErrorMessage(pauseRec, now) };
  }
  const fail = (status, error) => {
    writeMeta(metaPath, { status, fetchedAt: now, error: String(error || '').slice(0, 200) });
    log(`BOOTH cover 失败 ${id}：${error}`);
    return { ...base, status, error: String(error || ''), coverError: String(error || '') };
  };
  try {
    const wait = rateLimitMs - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const res = await fetchImpl(`${BOOTH_ITEM_BASE}${id}`, {
      headers: { 'user-agent': DEFAULT_UA, 'accept-language': 'zh-CN', accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const statusCode = Number(res?.status) || 0;
    if (statusCode === 404) return fail('not_found', '商品不存在（HTTP 404）');
    if (statusCode === 403 || statusCode === 429) {
      // 403/429 都写全局暂停（同一份 state/booth-search-pause.json，与找号/商品页共用）：
      // 以前这里只按 1 天失败缓存降级，搜索那边退避了封面还在敲门，等于白挨打。
      const pause = await noteBoothPause({ stateDir: stateDir || undefined, now }, { status: statusCode, retryAfter: retryAfterOf(res?.headers) });
      const minutes = Math.max(1, Math.round((pause?.pauseMs || 0) / 60000));
      log(`BOOTH cover HTTP ${statusCode}：写入全局暂停（${minutes} 分钟）`);
      // 兼容口径：403 保留旧 status='blocked'（旧调用方按它做降级），另加 paused 让新调用方识别全局暂停。
      const pausedStatus = statusCode === 403 ? 'blocked' : 'paused';
      return { ...fail(pausedStatus, `BOOTH 回了 HTTP ${statusCode}，已全局暂停抓取 ${minutes} 分钟`), ok: false, paused: true, blocked: statusCode === 403 };
    }
    if (statusCode < 200 || statusCode >= 300) return fail('error', `HTTP ${statusCode}`);
    const text = await res.text();
    if (Buffer.byteLength(String(text ?? ''), 'utf8') > BOOTH_MAX_RESPONSE_BYTES) return fail('error', '响应超过 2MB 上限');
    const source = parseBoothCoverSource(text);
    if (!source.chosen) return fail('error', '页面没有展示图（og:image / ld+json image 都为空）');

    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${coverPath}.src`;
    try {
      if (typeof downloadImpl === 'function') await downloadImpl(source.chosen, tmp, 4 * 1024 * 1024);
      else {
        const fetched = await safeFetchToFile(source.chosen, tmp, { maxBytes: 4 * 1024 * 1024, timeoutMs });
        if (fetched.truncated) throw new Error('展示图超过 4MB 上限');
      }
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size <= 0) throw new Error('下载结果为空');
      // 长边 ≤512 + 质量递减，尽量压到 ≤200KB；压不下去就保留最小结果并记原因（卡片仍有图）。
      let best = null;
      for (const edge of [maxEdge, 448, 384, 320]) {
        for (const quality of [3, 6, 9]) {
          const out = normalizeThumbnailFile({ srcPath: tmp, destPath: coverPath, maxEdge: edge, quality });
          if (!out.ok) continue;
          best = { edge, quality, bytes: out.bytes };
          if (out.bytes <= maxBytes) break;
          if (!best || out.bytes < best.bytes) best = { edge, quality, bytes: out.bytes };
        }
        if (best && best.bytes <= maxBytes) break;
      }
      if (!best || !fs.existsSync(coverPath)) {
        throw new Error('展示图规格化失败（ffmpeg 不可用且复制也失败）');
      }
      const dims = imageSize(coverPath) || { width: 0, height: 0 };
      const oversize = best.bytes > maxBytes;
      const meta = {
        status: 'ok', fetchedAt: now, sourceUrl: source.chosen, bytes: best.bytes,
        width: dims.width, height: dims.height, edge: best.edge, quality: best.quality,
        error: oversize ? `压缩后仍超过 ${Math.round(maxBytes / 1024)}KB（${best.bytes} bytes）` : ''
      };
      writeMeta(metaPath, meta);
      return {
        ...base, ok: true, status: 'ok', path: coverPath, bytes: best.bytes,
        width: dims.width, height: dims.height, cached: false, error: meta.error, coverError: meta.error
      };
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
  } catch (error) {
    return fail('error', String(error?.message ?? error));
  }
}
