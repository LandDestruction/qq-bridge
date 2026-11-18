import { readBridgeSource } from './bridge-source.mjs';
// simpleMode 归档：按 7 位 BOOTH 号归到同名文件夹。
//
// 线上布局（改动前）：<root>/<群号_群名>/<YYYY-MM>/<文件>
// 改动后：              <root>/<群号_群名>/<7位BOOTH号>/<文件>
// 没有 7 位号（例如 8 位日期 20240101.zip、6 位号、无号图片）继续走年月目录，不会被误归类。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  ensureFileLedger,
  insertArchiveRecord,
  archiveChatFileSegments,
  simpleArchiveDir,
  simpleBoothId
} from "../src/file-archive.js";

const GID = "100000006";
const GROUP_NAME = "扣1复活牢大";
const T0 = Date.UTC(2026, 0, 15, 4, 0, 0); // 2026-01
const asPosix = (p) => String(p).split(path.sep).join("/");

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("✅ " + name);
  } catch (error) {
    failed += 1;
    console.error("❌ " + name + " — " + (error?.message ?? error));
  }
}

const boothCfg = { groupFolderName: GROUP_NAME };

console.log("\n## 7 位 BOOTH 号解析");
check("普通压缩包/图片：取开头 7 位", () => {
  assert.equal(simpleBoothId("9038753.zip"), "9038753");
  assert.equal(simpleBoothId("8664050.jpg"), "8664050");
  assert.equal(simpleBoothId("9013048_35種 Mew_Pose.zip"), "9013048");
  assert.equal(simpleBoothId("  8664050.jpg  "), "8664050");
  assert.equal(simpleBoothId("8664050"), "8664050");
});
check("不是「恰好 7 位」的一律不认：8 位日期 / 6 位 / 字母开头 / 数字不在开头", () => {
  assert.equal(simpleBoothId("20240101.zip"), "", "8 位日期不能截成 2024010");
  assert.equal(simpleBoothId("903875.zip"), "", "6 位号不是 7 位（simpleMode 闸门本来就不收）");
  assert.equal(simpleBoothId("86640501.zip"), "");
  assert.equal(simpleBoothId("abc8664050.zip"), "");
  assert.equal(simpleBoothId("8664050abc.zip"), "8664050", "7 位后接字母是允许的");
  assert.equal(simpleBoothId(""), "");
});

console.log("\n## 目录布局");
check("有 7 位号 → <群号_群名>/<7位号>", () => {
  assert.equal(asPosix(simpleArchiveDir(boothCfg, GID, T0, "8664050.jpg")), `${GID}_${GROUP_NAME}/8664050`);
  assert.equal(asPosix(simpleArchiveDir(boothCfg, GID, T0, "9013048.zip")), `${GID}_${GROUP_NAME}/9013048`);
});
check("没有 7 位号 → 仍按年月目录（保持旧行为）", () => {
  assert.equal(asPosix(simpleArchiveDir(boothCfg, GID, T0, "20240101.zip")), `${GID}_${GROUP_NAME}/2026-01`);
  assert.equal(asPosix(simpleArchiveDir(boothCfg, GID, T0, "")), `${GID}_${GROUP_NAME}/2026-01`);
  assert.equal(asPosix(simpleArchiveDir(boothCfg, GID, T0)), `${GID}_${GROUP_NAME}/2026-01`);
});
check("群名拿不到就只用群号；群名做文件系统清洗", () => {
  assert.equal(asPosix(simpleArchiveDir({}, GID, T0, "8664050.jpg")), `${GID}/8664050`);
  assert.equal(asPosix(simpleArchiveDir({ groupFolderName: "a/b:c" }, GID, T0, "8664050.jpg")), `${GID}_a_b_c/8664050`);
});

console.log("\n## 转存落盘（archiveChatFileSegments）");
async function runIntegration() {
  const db = new DatabaseSync(":memory:");
  ensureFileLedger(db);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-booth-dir-"));
  const cfg = {
    enabled: true,
    groups: [GID],
    dir: rootDir,
    maxFileMb: 10,
    simpleMode: true,
    groupFolderName: GROUP_NAME,
    retention: null,
    booth: { enabled: false }
  };
  const segments = [
    { type: "file", data: { name: "8664050.jpg", file_id: "a", file_size: 5, url: "https://fixture.invalid/a.jpg" } },
    { type: "file", data: { name: "8664050_35種 Mew_Pose_Ver.3.zip", file_id: "b", file_size: 5, url: "https://fixture.invalid/b.zip" } },
    { type: "file", data: { name: "20240101.zip", file_id: "c", file_size: 5, url: "https://fixture.invalid/c.zip" } },
    // 同一个号里再次出现同名文件：不能覆盖，应加 (1)
    { type: "file", data: { name: "8664050.jpg", file_id: "d", file_size: 5, url: "https://fixture.invalid/d.jpg" } }
  ];
  try {
    const result = await archiveChatFileSegments({
      segments,
      groupId: GID,
      cfg,
      deps: {
        db,
        rootDir,
        nowMs: T0,
        download: async () => ({ buffer: Buffer.from("fixture-bytes") }),
        log: () => {}
      }
    });
    assert.equal(result.archived.length, 4, "四个文件都应转存");
    const rels = result.archived.map((r) => asPosix(r.relPath));
    assert.deepEqual(rels, [
      `${GID}_${GROUP_NAME}/8664050/8664050.jpg`,
      `${GID}_${GROUP_NAME}/8664050/8664050_35種 Mew_Pose_Ver.3.zip`,
      `${GID}_${GROUP_NAME}/2026-01/20240101.zip`,
      `${GID}_${GROUP_NAME}/8664050/8664050 (1).jpg`
    ]);
    for (const rel of rels) {
      const abs = path.join(rootDir, rel.split("/").join(path.sep));
      assert.equal(fs.existsSync(abs), true, `应真的落盘：${rel}`);
    }
    // 台账 rel_path 与磁盘一致
    const rows = db.prepare("SELECT rel_path FROM file_archive ORDER BY id").all();
    assert.deepEqual(rows.map((r) => asPosix(r.rel_path)), rels);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

await runIntegration()
  .then(() => console.log("✅ 同号文件进同一个 7 位号文件夹；无号/8 位日期留在年月目录；重名加 (1)"))
  .catch((error) => {
    failed += 1;
    console.error("❌ 转存落盘集成 — " + (error?.stack ?? error?.message ?? error));
  });

console.log("\n## 存量整理脚本（migrate-simple-booth-folders.mjs）");
async function runMigration() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "booth-dir-migrate-"));
  const dbPath = path.join(rootDir, "messages.db");
  const groupDir = path.join(rootDir, `${GID}_${GROUP_NAME}`, "2026-10");
  fs.mkdirSync(groupDir, { recursive: true });
  const files = {
    "8664050.jpg": "jpg-bytes",
    "8664050_35種 Mew_Pose_Ver.3.zip": "zip-bytes",
    "20240101.zip": "date-bytes",
    "9013048.zip": "booth-zip",
    "9013048.meta.json": '{"boothId":"9013048"}',
    "9013048.thumbnail.jpg": "thumb-bytes",
    // 台账引用已失效（旧 state/files 布局），但同目录有 `<boothId>.meta.*` 的兜底场景
    "7777777.zip": "stale-zip",
    "7777777.meta.json": '{"boothId":"7777777"}'
  };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(groupDir, name), body);
  const db = new DatabaseSync(dbPath);
  ensureFileLedger(db);
  const sha = (s) => crypto.createHash("sha256").update(Buffer.from(s)).digest("hex");
  const add = (name, body) => insertArchiveRecord(db, {
    groupId: GID, fileId: "", fileName: name, storedName: name,
    relPath: path.join(`${GID}_${GROUP_NAME}`, "2026-10", name),
    bytes: Buffer.byteLength(body), sha256: sha(body), archivedAt: T0,
    category: "unclassified", categorySource: "none", source: "chat"
  }).id;
  const id866 = add("8664050.jpg", files["8664050.jpg"]);
  add("8664050_35種 Mew_Pose_Ver.3.zip", files["8664050_35種 Mew_Pose_Ver.3.zip"]);
  add("20240101.zip", files["20240101.zip"]);
  const id901 = add("9013048.zip", files["9013048.zip"]);
  db.prepare("UPDATE file_archive SET meta_rel = ?, thumb_rel = ? WHERE id = ?").run(
    path.join(`${GID}_${GROUP_NAME}`, "2026-10", "9013048.meta.json"),
    path.join(`${GID}_${GROUP_NAME}`, "2026-10", "9013048.thumbnail.jpg"),
    id901
  );
  const id777 = add("7777777.zip", files["7777777.zip"]);
  db.prepare("UPDATE file_archive SET meta_rel = ? WHERE id = ?").run(
    "100000006\\3D衣装\\7777777 zip\\meta.json", // 不存在：迁移时不许清空
    id777
  );
  db.close();

  const script = fileURLToPath(new URL("./migrate-simple-booth-folders.mjs", import.meta.url));
  // D64：子进程也要能拿到测试配置（工作树没有 config.json），显式传占位配置路径，两边行为一致。
  const testConfig = fileURLToPath(new URL("../config.test.json", import.meta.url));
  const runScript = (extra = []) => execFileSync(process.execPath, [script, "--db", dbPath, "--root", rootDir, ...extra], {
    encoding: "utf8",
    env: { ...process.env, QQ_BRIDGE_TEST_CONFIG: testConfig }
  });
  try {
    const dry = runScript();
    assert.match(dry, /待归类 4/);
    assert.match(dry, /8664050\.jpg/);
    assert.doesNotMatch(dry, /20240101\.zip/, "预演不应把 8 位日期列进计划");
    assert.equal(fs.existsSync(path.join(rootDir, `${GID}_${GROUP_NAME}`, "8664050", "8664050.jpg")), false, "预演不能真搬");

    const applied = runScript(["--apply"]);
    assert.match(applied, /完成：搬了 4/);
    const check = new DatabaseSync(dbPath);
    try {
      const rows = check.prepare("SELECT id, rel_path, stored_name, meta_rel, thumb_rel FROM file_archive ORDER BY id").all();
      const byId = new Map(rows.map((r) => [Number(r.id), r]));
      assert.equal(asPosix(byId.get(id866).rel_path), `${GID}_${GROUP_NAME}/8664050/8664050.jpg`);
      assert.equal(asPosix(byId.get(id901).rel_path), `${GID}_${GROUP_NAME}/9013048/9013048.zip`);
      assert.equal(asPosix(byId.get(id901).meta_rel), `${GID}_${GROUP_NAME}/9013048/9013048.meta.json`);
      assert.equal(asPosix(byId.get(id901).thumb_rel), `${GID}_${GROUP_NAME}/9013048/9013048.thumbnail.jpg`);
      // 引用失效时：列值原样保留（不清空），同目录 sidecar 仍按文件名搬进号目录
      assert.equal(byId.get(id777).meta_rel, "100000006\\3D衣装\\7777777 zip\\meta.json");
      assert.equal(fs.existsSync(path.join(rootDir, `${GID}_${GROUP_NAME}`, "7777777", "7777777.meta.json")), true);
      const dateRow = rows.find((r) => String(r.rel_path).includes("20240101.zip"));
      assert.ok(String(dateRow.rel_path).includes("2026-10"), "8 位日期文件保持原布局");
    } finally { check.close(); }
    assert.equal(fs.existsSync(path.join(rootDir, `${GID}_${GROUP_NAME}`, "9013048", "9013048.thumbnail.jpg")), true);
    assert.equal(fs.existsSync(path.join(groupDir, "8664050.jpg")), false, "旧位置不应残留");

    const again = runScript();
    assert.match(again, /没有需要整理的条目|待归类 0/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

await runMigration()
  .then(() => console.log("✅ 存量整理：预演/--apply/台账与 sidecar 同步/幂等"))
  .catch((error) => {
    failed += 1;
    console.error("❌ 存量整理 — " + (error?.stack ?? error?.message ?? error));
  });

console.log("\n## 桥接接线（静态）");
check("图片/群文件两条转存路径都把文件名传给 simpleArchiveDir", () => {
  const bridge = readBridgeSource();
  assert.match(bridge, /simpleArchiveDir\(archiveCfgFor\(gid\), gid, Date\.now\(\), name\)/);
  assert.match(bridge, /simpleArchiveDir\(archiveCfgFor\(groupId\), groupId, Date\.now\(\), rawName\)/);
  // simpleMode 下图片自带 7 位号时保留原名（否则会存成「图片-N.png」，号丢失）
  assert.match(bridge, /simpleBoothId\(originalName\)/);
});

if (failed) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log("\n🎉 simpleMode BOOTH 号文件夹测试通过");
