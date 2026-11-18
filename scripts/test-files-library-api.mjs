import assert from "node:assert/strict";
import { filterArchiveRows, sortArchiveRows, fileListsFromRows, fileNotifyFromRows } from "../src/file-archive.js";
let failed = 0;
function check(n, f) { try { f(); console.log("✅ " + n); } catch (e) { failed++; console.error("❌ " + n + " — " + (e?.message ?? e)); } }
const rows = [
  { id: 1, fileName: "9013048 奥の手.zip", category: "3D衣装", boothId: "9013048", boothTitle: "奥の手", boothShop: "ZigZag", enrichStatus: "ok", archivedAt: 100, enrichedAt: 500 },
  { id: 2, fileName: "a.zip", category: "压缩包", boothId: "", boothTitle: "", boothShop: "", enrichStatus: "", archivedAt: 200 },
  { id: 3, fileName: "b.zip", category: "", boothId: "777", boothTitle: "测试", boothShop: "ShopB", enrichStatus: "failed", archivedAt: 300 },
  { id: 4, fileName: "del.zip", category: "", boothId: "888", deletedAt: 1, archivedAt: 400 }
];
check("q 中文/大小写不敏感 命中标题与店铺", () => {
  assert.equal(filterArchiveRows(rows, { q: "奥の手" }).length, 1);
  assert.equal(filterArchiveRows(rows, { q: "zigzag" }).length, 1);
  assert.equal(filterArchiveRows(rows, { q: "777" }).length, 1);
});
check("category 精确 + uncategorized=1", () => {
  assert.equal(filterArchiveRows(rows, { category: "3D衣装" }).length, 1);
  assert.deepEqual(filterArchiveRows(rows, { uncategorized: true }).map((r) => r.id), [3], "只有 category 为空且未删除的行");
});
check("shop / status 过滤", () => {
  assert.equal(filterArchiveRows(rows, { shop: "ShopB" }).length, 1);
  assert.equal(filterArchiveRows(rows, { status: "enriched" }).length, 1);
  assert.equal(filterArchiveRows(rows, { status: "pending" }).length, 1);
  assert.equal(filterArchiveRows(rows, { status: "unclassified" }).length, 1);
});
check("已删除行一律不出现在结果里", () => {
  assert.equal(filterArchiveRows(rows, {}).some((r) => r.id === 4), false);
});
check("sort：newest/oldest/title/booth，非法回退 newest", () => {
  // sortArchiveRows 只排序不过滤（已删除行由 filterArchiveRows 负责剔除）
  assert.deepEqual(sortArchiveRows(rows, "newest").map((r) => r.id), [4, 3, 2, 1]);
  assert.deepEqual(sortArchiveRows(rows, "oldest").map((r) => r.id), [1, 2, 3, 4]);
  assert.equal(sortArchiveRows(rows, "banana")[0].id, 4, "非法 sort 回退 newest");
  assert.equal(sortArchiveRows(rows, "booth")[0].boothId, "9013048", "有 booth_id 的排前面");
});
check("lists：分类计数 + uncategorized", () => {
  const l = fileListsFromRows(rows);
  assert.deepEqual(l.lists.sort((a, b) => a.category.localeCompare(b.category)), [{ category: "3D衣装", count: 1 }, { category: "压缩包", count: 1 }]);
  assert.equal(l.uncategorized.count, 1);
});
check("notify：pending/failed/unclassified/lastBackfillAt", () => {
  const n = fileNotifyFromRows(rows);
  assert.equal(n.unclassified, 1);
  assert.equal(n.failed, 1);
  assert.equal(n.pendingEnrich, 0);
  assert.equal(n.lastBackfillAt, 500);
});
if (failed) process.exit(1);
console.log("\n🎉 库管理器过滤/聚合测试通过");
