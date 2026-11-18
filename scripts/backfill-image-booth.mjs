// 同号图片回填：文件名开头数字命中「已存在 booth_id」的图片挂到该商品下。
// 默认 dry-run（只读）；--apply 才写库。幂等：只处理 booth_id 为空的图片。
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listArchive } from "../src/file-archive.js";
import { planImageBoothBackfill } from "../src/library-items.js";

const live = process.env.QQ_BRIDGE_LIVE || "E:/deepseek-harness/qq-bridge-src";
const dbFile = path.join(live, "state", "messages.db");
const apply = process.argv.includes("--apply");
const db = new DatabaseSync(dbFile, { readOnly: !apply });
const rows = listArchive(db, { limit: 1000 });
const updates = planImageBoothBackfill(rows);
const total = rows.length;
console.log("扫描 " + total + " 行，待回填 " + updates.length + " 条（" + (apply ? "APPLY" : "dry-run") + "）");
for (const u of updates) console.log("  #" + u.id + " → booth_id=" + u.boothId);
if (apply && updates.length) {
  const stmt = db.prepare("UPDATE file_archive SET booth_id = ? WHERE id = ? AND booth_id = ''");
  let n = 0;
  for (const u of updates) n += stmt.run(u.boothId, u.id).changes;
  console.log("已更新 " + n + " 行");
}
db.close();
