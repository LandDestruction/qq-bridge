// BOOTH 缩略图规格化：卡片库要 4:3、长边 ≤512 的 JPEG，不能把几 MB 原图直接塞给浏览器。
//
// 用系统 ffmpeg（线上已验证可用）：`scale=512:512:force_original_aspect_ratio=decrease`
// 保证长边不超过 512、等比缩放；`-q:v 3` 控制 JPEG 质量。
// ffmpeg 不可用/失败时**保留原图**（复制成目标文件）并返回 mode='fallback'，
// 调用方据此写 thumbStatus，不能因为缩图失败就把缩略图丢掉。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const BOOTH_THUMB_MAX_EDGE = 512;

/**
 * 把 srcPath 缩成 ≤maxEdge 的 JPEG 写到 destPath。
 * @returns {{ok:boolean, mode:'resized'|'fallback'|'failed', bytes:number, error?:string}}
 */
export function normalizeThumbnailFile({
  srcPath, destPath, maxEdge = BOOTH_THUMB_MAX_EDGE, quality = 3,
  ffmpegPath = 'ffmpeg', spawnImpl = spawnSync
} = {}) {
  if (!srcPath || !destPath) return { ok: false, mode: 'failed', bytes: 0, error: '缺少源/目标路径' };
  const edge = Math.min(2048, Math.max(64, Math.round(Number(maxEdge) || BOOTH_THUMB_MAX_EDGE)));
  const q = Math.min(31, Math.max(1, Math.round(Number(quality) || 3)));
  try {
    const result = spawnImpl(ffmpegPath, [
      '-y', '-loglevel', 'error',
      '-i', srcPath,
      '-vf', `scale=${edge}:${edge}:force_original_aspect_ratio=decrease:flags=lanczos`,
      '-q:v', String(q),
      '-frames:v', '1',
      destPath
    ], { encoding: 'utf8', timeout: 20000 });
    if (result?.status === 0 && fs.existsSync(destPath)) {
      const bytes = fs.statSync(destPath).size;
      if (bytes > 0) return { ok: true, mode: 'resized', bytes };
    }
  } catch { /* 走 fallback */ }
  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    const bytes = fs.statSync(destPath).size;
    return { ok: true, mode: 'fallback', bytes, error: 'ffmpeg 缩图失败，已保留原图' };
  } catch (error) {
    return { ok: false, mode: 'failed', bytes: 0, error: String(error?.message ?? error) };
  }
}

/** 读图片宽高（ffprobe；失败返回 null，调用方自行降级为只报文件大小）。 */
export function imageSize(filePath, { ffprobePath = 'ffprobe', spawnImpl = spawnSync } = {}) {
  try {
    const r = spawnImpl(ffprobePath, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', filePath
    ], { encoding: 'utf8', timeout: 10000 });
    if (r?.status !== 0) return null;
    const [width, height] = String(r.stdout || '').trim().split(',').map(Number);
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}
