// 附件类型判定（纯函数）：所有入口（当前消息段、引用、转发、观察群）共用。
//
// 事故背景：22:42 群友发「[文件10月23日.mp4]」并用引用引用它，桥接把**引用里的 mp4**
// 当成图片去 fetchOneBotImage → safeFetchBuffer 报「抓取内容不是有效图片」，
// 视频于是永远进不了 enrichVideoFile。根因是「扩展名 → 媒体类型」的判定散落在多处，
// 引用路径干脆没有判定。
export const VIDEO_EXTS = ["mp4", "mov", "mkv", "webm", "avi", "m4v", "flv", "wmv"];
export const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif", "tif", "tiff"];

/** 从任意候选串里取扩展名（allow 路径/URL 末段）。 */
export function extOf(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  const cleaned = s.split(/[?#]/)[0];
  const m = cleaned.match(/\.([a-z0-9]{1,8})$/i);
  return m ? m[1].toLowerCase() : "";
}

/**
 * 判定附件类型。
 * @param {{ segType?: string, name?: string, file?: string, url?: string, fileName?: string }} p
 * @returns {'video-file'|'image'|'sticker'|'file'|'unknown'}
 */
export function classifyAttachment({ segType = "", name = "", file = "", url = "", fileName = "" } = {}) {
  const t = String(segType ?? "").toLowerCase();
  if (t === "video") return "video-file";
  if (t === "image") return "image";
  if (t === "mface") return "sticker";
  if (t === "face") return "sticker";
  // file 段（以及引用里只有 name/file/url 的场景）：把能拿到的字段都试一遍
  for (const cand of [name, fileName, file, url]) {
    const e = extOf(cand);
    if (!e) continue;
    if (VIDEO_EXTS.includes(e)) return "video-file";
    if (IMAGE_EXTS.includes(e)) return "image";
  }
  if (t === "file") return "file";
  return "unknown";
}
