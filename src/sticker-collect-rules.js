// 表情库「收录标准」：判定什么图才算表情包（纯函数 + 只读文件头，不解码像素）。
//
// 为什么单独一个文件：贴纸库本体（src/sticker-lib.js）已经贴着 800 行上限；
// 而且这条判定将来还会被「清理脚本 / 控制台」复用，独立出来更好测。
//
// 背景：以前是「任何 kind=image 的图见两次就收」，于是群聊截图、聊天记录长图、照片、
// 二维码、群公告截图全进了表情库（实测 316 条里 133 条根本不是表情）。现在两道闸：
//   1) 协议标记优先：QQ 表情/市场表情段一定带 kind=sticker/face、emojiId 或 subType=1，
//      这类无条件收（容量另受 16MB 上限约束）；
//   2) 普通图片（转发梗图/别人截屏都长这样）只能靠图像本身特征判：动图、透明 PNG、
//      小图（≤420px）、极度扁平的图形（字节/像素 ≤0.12 且最长边 ≤1000）才算表情；
//      手机截图与照片的像素密度远高于此，一律不收。

/** 读图片文件头：格式、宽高、是否有 alpha、是否动图。解析不了返回 null（调用方按「未知」处理）。 */
export function readImageMeta(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length < 16) return null;
  // PNG：8 字节签名 + IHDR（宽高在大端 16..24，颜色类型在 25）
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const colorType = buf[25];
    // APNG 的 acTL 块出现在 IDAT 之前，扫前 4KB 足够
    const animated = buf.indexOf('acTL') > 0 && buf.indexOf('acTL') < 4096;
    return { format: 'PNG', width, height, alpha: colorType === 4 || colorType === 6, animated };
  }
  // GIF：宽高是小端 6..10；图片描述符 0x2C 多于一个即动图
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    let frames = 0;
    for (let i = 13; i < buf.length - 1 && frames < 2; i += 1) {
      if (buf[i] === 0x2c) frames += 1;
    }
    return { format: 'GIF', width, height, alpha: false, animated: frames > 1 };
  }
  // WebP：RIFF....WEBP，VP8X 有 canvas 尺寸；ANIM 块表示动图
  if (buf.length > 16 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    const animated = buf.indexOf('ANIM') > 0;
    if (kind === 'VP8X') {
      const width = 1 + buf.readUIntLE(24, 3);
      const height = 1 + buf.readUIntLE(27, 3);
      return { format: 'WEBP', width, height, alpha: (buf[20] & 0x10) !== 0, animated };
    }
    if (kind === 'VP8 ') {
      return { format: 'WEBP', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, alpha: false, animated };
    }
    if (kind === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { format: 'WEBP', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, alpha: true, animated };
    }
    return { format: 'WEBP', width: 0, height: 0, alpha: false, animated };
  }
  // JPEG：扫 SOF0..SOF3/SOF5..SOF7/SOF9..SOF11 段拿宽高
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb);
      if (isSof && i + 9 < buf.length) {
        return { format: 'JPEG', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), alpha: false, animated: false };
      }
      if (len < 2) break;
      i += 2 + len;
    }
    return { format: 'JPEG', width: 0, height: 0, alpha: false, animated: false };
  }
  return null;
}

export const STICKER_COLLECT_MAX_EDGE = 420;      // 再大就要求「扁平图形」证据
export const STICKER_COLLECT_FLAT_DENSITY = 0.12; // 字节/像素：截图与照片远高于此
export const STICKER_COLLECT_FLAT_MAX_EDGE = 1000;

/**
 * 这张图该不该进表情库。纯函数、只看元数据 + 文件头，不解码像素。
 * @param {{media?:object, meta?:object|null, bytes?:number}} input media 是消息里的媒体段
 * @returns {{ok:boolean, reason:string}}
 */
export function shouldAutoCollectSticker({ media, meta, bytes = 0 } = {}) {
  const m = media || {};
  const kind = String(m.kind || '');
  const marked = kind === 'sticker' || kind === 'face'
    || String(m.emojiId || '').trim() !== ''
    || String(m.subType || '') === '1';
  if (marked) return { ok: true, reason: '表情标记' };
  // 表情库不收视频/文件，别把 mp4 截图流进来
  if (kind && kind !== 'image') return { ok: false, reason: `不是图片（${kind}）` };
  if (!meta || !meta.width || !meta.height) return { ok: false, reason: '读不出图片尺寸，按普通图片不收' };
  const w = Number(meta.width) || 0;
  const h = Number(meta.height) || 0;
  const maxEdge = Math.max(w, h);
  const ratio = h ? w / h : 0;
  if (maxEdge > 1400 || ratio > 2.6 || ratio < 0.38) return { ok: false, reason: '尺寸/长宽比像截图或长图' };
  if (meta.animated && maxEdge <= 700) return { ok: true, reason: '动图' };
  if (meta.format === 'PNG' && meta.alpha && maxEdge <= 700) return { ok: true, reason: '透明 PNG' };
  if (maxEdge <= STICKER_COLLECT_MAX_EDGE) return { ok: true, reason: '小图' };
  const pixels = w * h;
  const density = pixels ? Number(bytes) / pixels : Infinity;
  if (density <= STICKER_COLLECT_FLAT_DENSITY && maxEdge <= STICKER_COLLECT_FLAT_MAX_EDGE) {
    return { ok: true, reason: '扁平图形' };
  }
  return { ok: false, reason: '像素密度像截图/照片' };
}

