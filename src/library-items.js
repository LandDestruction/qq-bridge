// 库（Library）以「BOOTH 商品」为单位聚合：只有压缩包构成商品，图片只能作为同号素材。
// 纯函数：路由与测试共用，不碰 fs/DB。
import { ARCHIVE_EXTENSIONS, ARCHIVE_IMAGE_EXTENSIONS } from "./file-archive.js";

const ARCHIVE_EXT = new Set((ARCHIVE_EXTENSIONS || ["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "zst"]).map((e) => String(e).toLowerCase()));
const IMAGE_EXT = new Set((ARCHIVE_IMAGE_EXTENSIONS || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "tif", "tiff"]).map((e) => String(e).toLowerCase()));

export function extOfName(fileName) {
  const m = String(fileName || "").match(/\.([a-z0-9]{1,8})$/i);
  return m ? m[1].toLowerCase() : "";
}
export function isArchiveFile(row) { return ARCHIVE_EXT.has(extOfName(row?.fileName)); }
export function isImageFile(row) { return IMAGE_EXT.has(extOfName(row?.fileName)); }

/** 台账行 → 商品卡片列表（只含压缩包，按 boothId 聚合）。 */
export function buildLibraryItems(rows, { thumbBase = "/api/library/item-thumb?boothId=" } = {}) {
  const byBooth = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.deletedAt) continue;
    const bid = String(r.boothId || "").trim();
    if (!bid) continue;                 // 没有 BOOTH 号 → 未分类
    if (!isArchiveFile(r)) continue;    // 图片不进商品列表
    let item = byBooth.get(bid);
    if (!item) {
      item = {
        boothId: bid,
        title: String(r.boothTitle || "") || String(r.fileName || "").replace(/\.[a-z0-9]+$/i, ""),
        shop: String(r.boothShop || ""),
        category: String(r.category || ""),
        coverUrl: `${thumbBase}${encodeURIComponent(bid)}`,
        boothUrl: String(r.boothUrl || "") || `https://booth.pm/zh-cn/items/${bid}`,
        enrichStatus: String(r.enrichStatus || ""),
        files: [],
        totalBytes: 0,
        fileCount: 0
      };
      byBooth.set(bid, item);
    }
    item.files.push({ id: r.id, fileName: r.fileName, bytes: r.bytes, storedName: r.storedName, relPath: r.relPath, archivedAt: r.archivedAt });
    item.totalBytes += Number(r.bytes) || 0;
    item.fileCount += 1;
    if (!item.title && r.boothTitle) item.title = r.boothTitle;
  }
  return [...byBooth.values()].sort((a, b) => b.files.reduce((n, f) => Math.max(n, f.archivedAt || 0), 0) - a.files.reduce((n, f) => Math.max(n, f.archivedAt || 0), 0));
}

/** 商品详情：卡片 + 同号图片（素材/画廊）。 */
export function buildLibraryItemDetail(rows, boothId) {
  const items = buildLibraryItems(rows);
  const item = items.find((i) => i.boothId === String(boothId)) || null;
  if (!item) return null;
  const images = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && !r.deletedAt && String(r.boothId || "") === String(boothId) && isImageFile(r))
    .map((r) => ({ id: r.id, fileName: r.fileName, bytes: r.bytes, thumbUrl: `/api/files/thumb?id=${r.id}&w=480` }));
  return { ...item, images };
}

/** 未分类：没有 booth_id 的压缩包与图片，分区返回。 */
export function buildLibraryUnclassified(rows) {
  const archives = [];
  const images = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.deletedAt) continue;
    if (String(r.boothId || "").trim()) continue;
    if (isArchiveFile(r)) archives.push({ id: r.id, fileName: r.fileName, bytes: r.bytes, category: r.category, archivedAt: r.archivedAt });
    else if (isImageFile(r)) images.push({ id: r.id, fileName: r.fileName, bytes: r.bytes, archivedAt: r.archivedAt, thumbUrl: `/api/files/thumb?id=${r.id}&w=480` });
  }
  return { archives, images };
}

/** 同号图片归属：文件名开头数字命中「已存在的 booth_id」→ 回填。返回待更新的 {id, boothId}。 */
export function planImageBoothBackfill(rows) {
  const known = new Set((Array.isArray(rows) ? rows : []).map((r) => String(r.boothId || "").trim()).filter(Boolean));
  const updates = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.deletedAt) continue;
    if (String(r.boothId || "").trim()) continue;
    if (!isImageFile(r)) continue;
    const m = String(r.fileName || "").match(/^\s*(\d{5,10})/);
    if (!m) continue;
    if (!known.has(m[1])) continue;   // 对不上 → 保持未分类
    updates.push({ id: r.id, boothId: m[1] });
  }
  return updates;
}
