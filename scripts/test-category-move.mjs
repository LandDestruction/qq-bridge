import assert from "node:assert/strict";
import { planCategoryMove } from "../src/file-archive.js";
let failed = 0;
function check(n, f) { try { f(); console.log("✅ " + n); } catch (e) { failed++; console.error("❌ " + n + " — " + (e?.message ?? e)); } }
const row = { boothId: "9013048", relPath: "100000001/3D衣装/9013048 奥の手/a.zip", thumbRel: "100000001/3D衣装/9013048 奥の手/t.jpg", metaRel: "100000001/3D衣装/9013048 奥の手/meta.json", category: "3D衣装" };
check("有 booth_id：只换分类段，其余路径保持", () => {
  const p = planCategoryMove({ row, newCategory: "压缩包" });
  assert.equal(p.ok, true);
  assert.equal(p.simple, false);
  assert.equal(p.newRel, "100000001/压缩包/9013048 奥の手/a.zip");
  assert.equal(p.newThumbRel, "100000001/压缩包/9013048 奥の手/t.jpg");
  assert.equal(p.newMetaRel, "100000001/压缩包/9013048 奥の手/meta.json");
});
check("空分类（未分类）时保持原分类段（不产生双斜杠）", () => {
  const p = planCategoryMove({ row, newCategory: "" });
  assert.equal(p.newRel, "100000001/3D衣装/9013048 奥の手/a.zip");
});
check("没有 booth_id → simple:true（只改台账）", () => {
  assert.equal(planCategoryMove({ row: { relPath: "1/x/y.zip" }, newCategory: "压缩包" }).simple, true);
});
check("结构异常 → ok:false", () => {
  assert.equal(planCategoryMove({ row: { boothId: "1", relPath: "a.zip" }, newCategory: "x" }).ok, false);
  assert.equal(planCategoryMove({ row: null, newCategory: "x" }).ok, false);
});
if (failed) process.exit(1);
console.log("\n🎉 改分类目录移动规划测试通过");
