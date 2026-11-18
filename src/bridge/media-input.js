// media-input: extracted bridge responsibilities; no startup side effects.
// Live dependencies: MAX_DOWNLOAD_BYTES, MAX_MEDIA_BYTES, MAX_MEDIA_PIXELS, STATE_DIR, URL, bot, cfg, convertHeicToJpeg, fs, getImageCached, log, looksLikeImageBuffer, modelMediaLimits, normalizeImageForModel, path, safeFetchBuffer, sniffHeic
export function createMediaInput(deps) {
// @bridge-function mimeFromBuffer:start
function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    // 语音（记录段）：浏览器只认 mp3/wav/ogg，silk/amr 也照实报，由调用方决定要不要转。
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45) return 'audio/wav';
    if (buf.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
    if (buf.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
    if (buf[0] === 0xff && (buf[1] === 0xfb || buf[1] === 0xf3 || buf[1] === 0xf2)) return 'audio/mpeg';
    if (buf.toString('ascii', 0, 9) === '#!SILK_V3') return 'audio/silk';
    if (buf.toString('ascii', 0, 5) === '#!AMR') return 'audio/amr';
    return 'image/jpeg';
  }
// @bridge-function mimeFromBuffer:end

// @bridge-function mimeFromUrl:start
function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new deps.URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }
// @bridge-function mimeFromUrl:end

// @bridge-function getImageDimensions:start
function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }
// @bridge-function getImageDimensions:end

// @bridge-function base64FromMaybe:start
function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }
// @bridge-function base64FromMaybe:end

// @bridge-function toModelMedia:start
async function toModelMedia(buffer, mimeType, label = '图片') {
    const out = await (0, deps.normalizeImageForModel)(buffer, mimeType, { ...deps.modelMediaLimits, label });
    if (!out.ok) {
      (0, deps.log)(`[media] ${label} 不提供：${out.error}`);
      return out;
    }
    if (out.note) (0, deps.log)(`[media] ${label}: ${out.note}`);
    return out;
  }
// @bridge-function toModelMedia:end

// @bridge-function isSafeLocalMediaPath:start
function isSafeLocalMediaPath(filePath) {
    try {
      const real = deps.fs.realpathSync(String(filePath));
      const homeDir = deps.cfg.snowluma?.homeDir ? String(deps.cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = deps.fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + deps.path.sep);
    } catch {
      return false;
    }
  }
// @bridge-function isSafeLocalMediaPath:end

// @bridge-function isProbablySafeImageFileRef:start
function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }
// @bridge-function isProbablySafeImageFileRef:end

// @bridge-function emojiCdnCandidates:start
function emojiCdnCandidates(emojiId) {
    const id = String(emojiId ?? '').trim();
    if (!/^[0-9a-f]{16,64}$/i.test(id)) return [];
    return [`https://gxh.vip.qq.com/club/item/parcel/item/${id.slice(0, 2)}/${id}/raw300.gif`];
  }
// @bridge-function emojiCdnCandidates:end

// @bridge-function emojiIdFromFileName:start
function emojiIdFromFileName(file) {
    const match = /(?:^|[^0-9a-f])([0-9a-f]{32})\.(?:gif|png|jpe?g|webp)$/i.exec(String(file ?? '').trim());
    return match ? match[1] : '';
  }
// @bridge-function emojiIdFromFileName:end

// @bridge-function acceptImageBuffer:start
function acceptImageBuffer(buf, label = '图片') {
    if (!buf || !buf.length) return null;
    if (!(0, deps.looksLikeImageBuffer)(buf)) {
      (0, deps.log)(`${label}不是有效图片（PNG/JPEG/GIF/WebP），已跳过`);
      return null;
    }
    const dims = getImageDimensions(buf);
    if (dims && dims.width * dims.height > deps.MAX_MEDIA_PIXELS) {
      (0, deps.log)(`${label}像素超限，已跳过（${dims.width}x${dims.height}）`);
      return null;
    }
    return { buffer: buf, mimeType: mimeFromBuffer(buf) };
  }
// @bridge-function acceptImageBuffer:end

// @bridge-function fetchOneBotImage:start
async function fetchOneBotImage(media) {
    // 防御：视频绝不能被当图片抓（会用 mp4 的下载 URL 打 safeFetchBuffer，必然失败且误导用户）。
    if (media?.kind === 'video-file') {
      (0, deps.log)('[media] 拒绝把视频当图片抓取（应走 enrichVideoFile）');
      return null;
    }
    // 本地生成的文件（如视频抽帧拼图）直接读盘，不走 OneBot。
    if (media?.localFile) {
      try {
        const p = deps.path.join(deps.STATE_DIR, String(media.localFile));
        const buf = deps.fs.readFileSync(p);
        if (buf.length) return { ok: true, buffer: buf, mimeType: mimeFromBuffer(buf), via: 'local' };
      } catch {}
    }
    // 表情包（市场/收藏表情）优先走 CDN：get_image 对市场表情必然失败
    // （SnowLuma 缓存里没有该文件），先试 URL 能省一次失败往返，也更可靠。
    const emojiId = String(media.emojiId || emojiIdFromFileName(media.file) || '');
    const isSticker = media.kind === 'sticker' || !!emojiId || String(media.subType || '') === '1';
    const label = isSticker ? '表情' : '图片';
    const failures = [];
    const urls = [];
    const pushUrl = (raw) => {
      const s = String(raw ?? '').trim();
      if (!/^https?:\/\//i.test(s) || urls.includes(s)) return;
      urls.push(s);
    };
    pushUrl(media.url);
    for (const candidate of emojiCdnCandidates(emojiId)) pushUrl(candidate);

    const tryUrls = async () => {
      for (const url of urls) {
        try {
          const fetched = await (0, deps.safeFetchBuffer)(url, deps.MAX_DOWNLOAD_BYTES);
          if (fetched?.truncated) (0, deps.log)(`${label} URL 超过抓取上限 ${(deps.MAX_DOWNLOAD_BYTES / 1048576).toFixed(0)}MB，已放弃：${url.slice(0, 80)}`);
          let accepted = acceptImageBuffer(fetched.buffer, `${label} URL `);
          if (!accepted && (0, deps.sniffHeic)(fetched.buffer)) {
            const conv = await (0, deps.convertHeicToJpeg)(fetched.buffer, { ffmpegPath: String(deps.cfg.socialV2?.voice?.ffmpegPath || 'ffmpeg'), spawnImpl: null, timeoutMs: 20000 });
            if (conv.ok) {
              (0, deps.log)(`[media] ${label} URL 是 HEIC，已转码为 JPEG（${(fetched.buffer.length / 1024).toFixed(0)}KB → ${(conv.buffer.length / 1024).toFixed(0)}KB）`);
              accepted = acceptImageBuffer(conv.buffer, `${label} URL（HEIC→JPEG）`);
            } else {
              (0, deps.log)(`[media] ${label} URL HEIC 转码失败：${conv.reason}`);
              failures.push(`HEIC 转码失败：${conv.reason}`);
            }
          }
          if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(url) };
          failures.push(`${url} 不是有效图片（sniff 失败；抓取 ${(fetched?.buffer?.length ?? 0)} 字节）`);
        } catch (error) {
          failures.push(`${url}: ${error?.message ?? error}`);
        }
      }
      return null;
    };
    // 只有 file 是安全缓存文件名时才允许交给网关（防任意路径/内网 URL 注入）。
    const tryGetImage = async () => {
      if (!(media.kind === 'image' || media.kind === 'sticker')) return null;
      if (!media.file || !isProbablySafeImageFileRef(media.file)) return null;
      try {
        const info = await (0, deps.getImageCached)(String(media.file));
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= deps.MAX_MEDIA_BYTES) {
            const accepted = acceptImageBuffer(Buffer.from(base64, 'base64'), 'get_image 返回的图片');
            if (accepted) return accepted;
          } else {
            (0, deps.log)(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          try {
            const fetched = await (0, deps.safeFetchBuffer)(String(obj.url), deps.MAX_MEDIA_BYTES);
            const accepted = acceptImageBuffer(fetched.buffer, 'get_image URL 图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(obj.url) };
          } catch (error) {
            failures.push(`get_image url: ${error?.message ?? error}`);
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && deps.fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = deps.fs.statSync(obj.file);
          if (stat.size > deps.MAX_MEDIA_BYTES) {
            (0, deps.log)(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const accepted = acceptImageBuffer(deps.fs.readFileSync(obj.file), '本地图片');
            if (accepted) return accepted;
          }
        }
      } catch (error) {
        failures.push(`get_image: ${error?.message ?? error}`);
      }
      return null;
    };

    const result = isSticker
      ? (await tryUrls()) ?? (await tryGetImage())
      : (await tryGetImage()) ?? (await tryUrls());
    if (result) return result;
    if (failures.length) {
      (0, deps.log)(`[media] ${label}获取失败（${failures.length} 次尝试）：${failures.slice(0, 3).join(' | ')}`);
    }
    return null;
  }
// @bridge-function fetchOneBotImage:end

// @bridge-function fetchFaceMedia:start
async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    // 系统小表情（face 段）：只有数字 id 才有对应实体；拿不到时至少保留 summary 文案。
    const fallbackText = media.summary ? `[表情:${media.summary}]` : `[表情#${media.faceId}]`;
    if (!Number.isInteger(faceId)) return { text: fallbackText };
    try {
      const face = await deps.bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await (0, deps.safeFetchBuffer)(String(face.url), deps.MAX_MEDIA_BYTES);
            const accepted = acceptImageBuffer(fetched.buffer, '表情图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
          } catch (error) {
            (0, deps.log)(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : fallbackText };
      }
    } catch (error) {
      (0, deps.log)(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: fallbackText };
  }
// @bridge-function fetchFaceMedia:end
  return { mimeFromBuffer, mimeFromUrl, getImageDimensions, base64FromMaybe, toModelMedia, isSafeLocalMediaPath, isProbablySafeImageFileRef, emojiCdnCandidates, emojiIdFromFileName, acceptImageBuffer, fetchOneBotImage, fetchFaceMedia };
}
