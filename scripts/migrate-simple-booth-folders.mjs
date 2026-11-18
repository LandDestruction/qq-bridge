#!/usr/bin/env node
// 把 simpleMode 已转存的文件按 7 位 BOOTH 号收进同名文件夹（一次性的存量整理）：
//   <root>/<群号_群名>/<YYYY-MM>/<文件>  →  <root>/<群号_群名>/<7位号>/<文件>
// 没有 7 位号（8 位日期、6 位号、无号图片）保持原样；台账 rel_path/stored_name 同步更新，
// 搬完逐个重算 sha256 与台账比对。默认只预演，加 --apply 才真正搬（先备份 messages.db）。
//
// 用法：
//   node scripts/migrate-simple-booth-folders.mjs                 # 预演
//   node scripts/migrate-simple-booth-folders.mjs --apply         # 真正搬
//   node scripts/migrate-simple-booth-folders.mjs --db <path> --root <path>   # 测试/自定义
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { simpleBoothId } from "../src/file-archive.js";
import { testConfigFromEnv } from "./config-for-tests.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || "") : "";
};
// D64：测试可用 QQ_BRIDGE_TEST_CONFIG 指向一份占位配置；线上行为不变（没设就用 config.json，缺了照旧报错）。
const CONFIG_FILE = testConfigFromEnv(ROOT) || path.join(ROOT, "config.json");
const CFG = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const ROOT_DIR = argValue("--root") || (path.isAbsolute(String(CFG.fileArchive?.dir || ""))
  ? path.normalize(String(CFG.fileArchive.dir))
  : path.resolve(ROOT, String(CFG.fileArchive?.dir || "state/files")));
const DB_PATH = argValue("--db") || path.join(ROOT, "state", "messages.db");
const apply = process.argv.includes("--apply");

function sha256(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
}

function uniqueDest(absPath) {
  if (!fs.existsSync(absPath)) return absPath;
  const ext = path.extname(absPath);
  const base = ext ? absPath.slice(0, -ext.length) : absPath;
  for (let i = 1; i < 10000; i += 1) {
    const candidate = `${base} (${i})${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`同名文件过多：${absPath}`);
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`找不到台账：${DB_PATH}`);
  process.exit(2);
}
const db = new DatabaseSync(DB_PATH);
const rows = db.prepare(
  "SELECT id, group_id, file_name, stored_name, rel_path, sha256, meta_rel, thumb_rel FROM file_archive WHERE deleted_at IS NULL ORDER BY id"
).all();

const plan = [];
for (const r of rows) {
  const stored = String(r.stored_name || path.basename(String(r.rel_path || "")) || "file");
  const boothId = simpleBoothId(stored) || simpleBoothId(String(r.file_name || ""));
  if (!boothId) continue;
  const rel = String(r.rel_path || "");
  const parts = rel.split(path.sep);
  // 只整理「<前面>/<YYYY-MM>/<文件>」这种旧布局；已经在 <boothId>/ 里的跳过。
  if (parts.length < 3 || !/^\d{4}-\d{2}$/.test(parts[parts.length - 2])) continue;
  const destDirRel = path.join(...parts.slice(0, -2), boothId);
  const destRel = path.join(destDirRel, stored);
  plan.push({
    id: r.id,
    stored,
    sha: String(r.sha256 || ""),
    src: path.join(ROOT_DIR, rel),
    dest: path.join(ROOT_DIR, destRel),
    destRel,
    oldDir: path.dirname(path.join(ROOT_DIR, rel)),
    newDir: path.join(ROOT_DIR, destDirRel),
    boothId,
    metaRel: String(r.meta_rel || ""),
    thumbRel: String(r.thumb_rel || "")
  });
}

console.log(`台账有效条目 ${rows.length}，待归类 ${plan.length}；根目录 ${ROOT_DIR}`);
for (const p of plan) {
  const exists = fs.existsSync(p.src);
  console.log(`#${p.id} [${p.boothId}] ${path.relative(ROOT_DIR, p.src)} → ${p.destRel}${exists ? "" : "  [源文件缺失!]"}`
    + (p.metaRel ? `（含 meta）` : "") + (p.thumbRel ? `（含 thumb）` : ""));
}
if (!plan.length) {
  console.log("没有需要整理的条目（可能已经是 <7位号>/ 布局）。");
  process.exit(0);
}
if (!apply) {
  console.log("\n（预演，加 --apply 才真正搬；会先备份 messages.db）");
  process.exit(0);
}

// 备份台账
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.copyFileSync(DB_PATH, `${DB_PATH}.bak-booth-dir-${stamp}`);
console.log(`\n已备份 ${path.basename(DB_PATH)}.bak-booth-dir-${stamp}`);

const upd = db.prepare("UPDATE file_archive SET rel_path = ?, stored_name = ?, meta_rel = ?, thumb_rel = ? WHERE id = ?");
let moved = 0;
let skipped = 0;
let failed = 0;
for (const p of plan) {
  try {
    if (!fs.existsSync(p.src)) { console.log(`跳过 #${p.id}：源文件不存在`); skipped += 1; continue; }
    fs.mkdirSync(p.newDir, { recursive: true });
    const dest = uniqueDest(p.dest);
    try { fs.renameSync(p.src, dest); } catch { fs.copyFileSync(p.src, dest); fs.unlinkSync(p.src); }
    const got = sha256(dest);
    if (p.sha && got !== p.sha) {
      fs.renameSync(dest, p.src);
      console.log(`校验失败 #${p.id}：sha256 不匹配，已回滚`);
      failed += 1;
      continue;
    }
    const destName = path.basename(dest);
    // meta.json / 缩略图：跟着主文件进新目录。
    // 注意：台账里的 meta_rel/thumb_rel 可能还指向**更早的** state/files 布局（路径已失效）；
    // 这种情况下不能把列值清空，保留原值，并按文件名兜底搬同目录里的 `<boothId>.meta.*`。
    const sidecar = (rel, label) => {
      if (!rel) return "";
      const oldAbs = path.join(ROOT_DIR, rel);
      if (!fs.existsSync(oldAbs)) return rel; // 引用已失效：保留原值，别抹掉
      const newAbs = uniqueDest(path.join(p.newDir, path.basename(oldAbs)));
      if (path.resolve(oldAbs) !== path.resolve(newAbs)) {
        try {
          fs.renameSync(oldAbs, newAbs);
        } catch (error) {
          console.log(`   ${label} 搬移失败（保留原处）：${error?.message ?? error}`);
          return rel;
        }
      }
      return path.relative(ROOT_DIR, newAbs);
    };
    const nextMeta = sidecar(p.metaRel, "meta");
    const nextThumb = sidecar(p.thumbRel, "thumbnail");
    upd.run(path.relative(ROOT_DIR, dest), destName, nextMeta, nextThumb, p.id);
    // 兜底：旧 simpleMode 迁移留下的 `<boothId>.meta.json` / `<boothId>.thumbnail.jpg`
    // 不在台账的 meta_rel/thumb_rel 里，但应该跟主文件进同一个号目录。
    try {
      const prefixRe = new RegExp(`^${p.boothId}\\.(meta|thumbnail|thumb)\\.`, "i");
      for (const name of fs.readdirSync(p.oldDir)) {
        if (!prefixRe.test(name)) continue;
        const from = path.join(p.oldDir, name);
        if (!fs.existsSync(from)) continue;
        const to = uniqueDest(path.join(p.newDir, name));
        try { fs.renameSync(from, to); } catch (error) {
          console.log(`   sidecar ${name} 搬移失败（保留原处）：${error?.message ?? error}`);
        }
      }
    } catch {}
    moved += 1;
    console.log(`#${p.id} → ${path.relative(ROOT_DIR, dest)}（sha256 校验${p.sha ? "通过" : "跳过(无记录)"}）`);
  } catch (error) {
    console.log(`失败 #${p.id}：${error?.message ?? error}`);
    failed += 1;
  }
}
console.log(`\n完成：搬了 ${moved}，跳过 ${skipped}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
