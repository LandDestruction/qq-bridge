import assert from "node:assert/strict";
import { buildLibraryItems, buildLibraryItemDetail, buildLibraryUnclassified, planImageBoothBackfill } from "../src/library-items.js";
let failed = 0;
function check(n, f) { try { f(); console.log("✅ " + n); } catch (e) { failed++; console.error("❌ " + n + " — " + (e?.message ?? e)); } }
const row = (id, fileName, boothId, extra = {}) => ({ id, fileName, boothId, bytes: 100, category: "压缩包", storedName: fileName, relPath: `g/${fileName}`, archivedAt: 1000 + id, enrichStatus: "ok", boothTitle: "奥の手", boothShop: "ZigZag", boothUrl: "", ...extra });
const rows = [
  row(1, "a.zip", "123"), row(2, "b.7z", "123"), row(3, "c.zip", ""),
  row(4, "123pic.png", "123"), row(5, "nopic.png", "")
];
check("items 只包含压缩包，按 boothId 聚合（同号两文件 → 1 项）", () => {
  const items = buildLibraryItems(rows);
  assert.equal(items.length, 1);
  assert.equal(items[0].boothId, "123");
  assert.equal(items[0].fileCount, 2);
  assert.deepEqual(items[0].files.map((f) => f.id), [1, 2]);
  assert.equal(items[0].coverUrl, "/api/library/item-thumb?boothId=123");
});
check("图片不出现在 items；无号压缩包也不进 items", () => {
  const items = buildLibraryItems(rows);
  assert.equal(items.some((i) => i.files.some((f) => f.fileName.endsWith(".png"))), false);
  assert.equal(items.some((i) => i.boothId === ""), false);
});
check("未分类：1 个无号压缩包 + 1 张无号图片", () => {
  const u = buildLibraryUnclassified(rows);
  assert.equal(u.archives.length, 1);
  assert.equal(u.archives[0].id, 3);
  assert.equal(u.images.length, 1);
  assert.equal(u.images[0].id, 5);
});
check("商品详情：同号图片作为素材（123png）", () => {
  const d = buildLibraryItemDetail(rows, "123");
  assert.equal(d.boothId, "123");
  assert.deepEqual(d.images.map((i) => i.id), [4]);
  assert.equal(buildLibraryItemDetail(rows, "999"), null);
});
check("同号图片回填：只回填文件名前缀命中已存在 booth_id 的图片", () => {
  const rows2 = [
    row(10, "12345 extra.png", ""),
    row(11, "99999 nope.png", ""),
    row(12, "12345 main.zip", "12345"),
    row(13, "noext.png", "")
  ];
  const up = planImageBoothBackfill(rows2);
  assert.deepEqual(up, [{ id: 10, boothId: "12345" }]);
});
if (failed) process.exit(1);
console.log("\n🎉 Library 聚合测试通过");
