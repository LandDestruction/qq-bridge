import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureFileLedger, archiveStats, normalizeListParams, listArchive, countArchive } from "../src/file-archive.js";
import { observeApiView } from "../src/observe-learn.js";
let failed = 0;
function check(n, f) { try { f(); console.log("✅ " + n); } catch (e) { failed++; console.error("❌ " + n + " — " + (e?.message ?? e)); } }

// ① byGroup 永远是数组
check("空台账：byGroup 是 []（不是 null/对象）", () => {
  const db = new DatabaseSync(":memory:");
  ensureFileLedger(db);
  const stats = archiveStats(db, { nowMs: 0, retention: null });
  assert.ok(Array.isArray(stats.byGroup), "byGroup 必须是数组");
  assert.equal(stats.byGroup.length, 0);
});
check("单个群：byGroup 仍是数组，长度 1", () => {
  const db = new DatabaseSync(":memory:");
  ensureFileLedger(db);
  db.prepare(`INSERT INTO file_archive (group_id, file_id, file_name, stored_name, rel_path, bytes, archived_at, cleanup_at, category, category_source)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("100000001", "f1", "a.zip", "a.zip", "p/a.zip", 100, 1000, 9999999, "压缩包", "rule");
  const stats = archiveStats(db, { nowMs: 0, retention: null });
  assert.ok(Array.isArray(stats.byGroup));
  assert.equal(stats.byGroup.length, 1);
  assert.equal(stats.byGroup[0].groupId, "100000001");
});

// ② 分页参数
check("limit 超上限 1000 → 夹到 1000", () => assert.equal(normalizeListParams({ limit: 5000 }).limit, 1000));
check("limit 非数字/0/负 → 默认 100", () => {
  assert.equal(normalizeListParams({ limit: "abc" }).limit, 100);
  assert.equal(normalizeListParams({ limit: 0 }).limit, 100);
  assert.equal(normalizeListParams({ limit: -5 }).limit, 100);
});
check("offset 负数/非数字 → 0；正常值透传", () => {
  assert.equal(normalizeListParams({ offset: -1 }).offset, 0);
  assert.equal(normalizeListParams({ offset: "x" }).offset, 0);
  assert.equal(normalizeListParams({ offset: 7 }).offset, 7);
});
check("offset > total → listArchive 返回空数组（路由回显请求 offset）", () => {
  const db = new DatabaseSync(":memory:");
  ensureFileLedger(db);
  db.prepare(`INSERT INTO file_archive (group_id, file_id, file_name, stored_name, rel_path, bytes, archived_at, cleanup_at, category, category_source)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("1", "f1", "a.zip", "a.zip", "p/a.zip", 1, 1, 999, "压缩包", "rule");
  assert.equal(countArchive(db), 1);
  const { limit, offset } = normalizeListParams({ limit: 10, offset: 99 });
  assert.equal(offset, 99, "路由回显请求值");
  assert.deepEqual(listArchive(db, { limit, offset }), []);
});

// ③ observe/config 三种状态
check("未启用：description=null、effectiveGroups=[]", () => {
  const v = observeApiView({ enabled: false, groups: ["100000005"] });
  assert.equal(v.enabled, false);
  assert.equal(v.description, null);
  assert.deepEqual(v.effectiveGroups, []);
  assert.deepEqual(v.groups, ["100000005"], "groups 仍是配置原值，便于前端显示");
});
check("启用但 groups 空：description 提示无观察群、effectiveGroups=[]", () => {
  const v = observeApiView({ enabled: true, groups: [] });
  assert.equal(v.enabled, true);
  assert.ok(String(v.description).includes("groups 为空"));
  assert.deepEqual(v.effectiveGroups, []);
});
check("启用且有群：effectiveGroups 等于 groups", () => {
  const v = observeApiView({ enabled: true, groups: ["100000005"], learnSlang: true, learnStickers: false });
  assert.deepEqual(v.effectiveGroups, ["100000005"]);
  assert.ok(v.description.includes("100000005"));
  assert.equal(v.learnStickers, false);
  assert.equal(v.source, "config.json");
});
if (failed) process.exit(1);
console.log("\n🎉 契约测试通过（byGroup/分页/observe 三组）");
