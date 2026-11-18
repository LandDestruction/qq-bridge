// 六窗口看板工具（default-workspace\win6-board.mjs）行为自测。
//
// 为什么单独测它：看板是六个窗口唯一的共享通道，但它不在本仓库里（<本机路径>\_board），
// 一旦它丢事件、折叠错状态或并发写撕裂，整条协作线会静默失灵——没有报错，只是活没人接。
//
// 用法：node scripts/test-win6-board.mjs
//       WIN6_BOARD_TOOL=<路径> node scripts/test-win6-board.mjs   # 换一份看板脚本再测
// 找不到看板脚本时打印 SKIP 并 exit 0（本仓库 clone 到没装 default-workspace 的机器上不该红）。
//
// 每个用例用独立临时目录（WIN6_BOARD_DIR），绝不碰真实看板。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const TOOL = process.env.WIN6_BOARD_TOOL
  || "C:/Users/PC/Documents/deepseek-harness/default-workspace/win6-board.mjs";

if (!fs.existsSync(TOOL)) {
  console.log(`SKIP test-win6-board：找不到看板脚本 ${TOOL}`);
  console.log("SKIP 0/0 用例（未运行）");
  process.exit(0);
}

const dirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "win6-board-"));
  dirs.push(d);
  return d;
}
function run(dir, ...args) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    env: { ...process.env, WIN6_BOARD_DIR: dir },
    encoding: "utf8",
  });
}
function runAsync(dir, ...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [TOOL, ...args], { env: { ...process.env, WIN6_BOARD_DIR: dir } });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code, out }));
  });
}
function boardFile(dir) { return path.join(dir, "workboard.jsonl"); }
function events(dir) {
  try {
    return fs.readFileSync(boardFile(dir), "utf8").split("\n").filter((s) => s.trim());
  } catch { return []; }
}
function parsed(dir) {
  return events(dir).map((l) => { try { return JSON.parse(l); } catch { return null; } });
}

let failed = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log("✓ " + name); }
  catch (e) { failed++; console.error("✗ " + name + " — " + (e?.message ?? e)); }
}

// ── 1. 正常路径 ────────────────────────────────────────────────────────────
await check("add 后 list 能看到任务，owner 正确落盘", () => {
  const d = tmpDir();
  const r = run(d, "add", "--id", "T1", "--title", "标题", "--brief", "验收标准", "--owner", "w2", "--by", "w1", "--touches", "src/a.js,docs/b.md");
  assert.equal(r.status, 0, "add 应 exit 0：" + r.stderr);
  const out = run(d, "list").stdout;
  assert.match(out, /T1/);
  assert.match(out, /w2/);
  const ev = parsed(d).filter((e) => e && e.type === "task" && e.id === "T1")[0];
  assert.deepEqual(ev.touches, ["src/a.js", "docs/b.md"]);
  assert.equal(ev.owner, "w2");
});

await check("touches 逐项 trim、空项过滤（缺陷 #4 已修）", () => {
  const d = tmpDir();
  run(d, "add", "--id", "T1", "--title", "t", "--owner", "w2", "--by", "w1", "--touches", "src/a.js, docs/b.md");
  const ev = parsed(d).filter((e) => e && e.id === "T1")[0];
  assert.deepEqual(ev.touches, ["src/a.js", "docs/b.md"], "应按逗号切分后逐项 trim");
  // 空项与纯空格项要丢掉，不能变成 "" 进 touches
  assert.equal(run(d, "add", "--id", "T2", "--title", "t", "--owner", "w2", "--by", "w1", "--touches", " a ,, , b ,").status, 0);
  const ev2 = parsed(d).filter((e) => e && e.id === "T2")[0];
  assert.deepEqual(ev2.touches, ["a", "b"], "空项应被过滤");
});

await check("状态折叠：claim→doing→blocked→done 终态为 done，note 取最后一次", () => {
  const d = tmpDir();
  run(d, "add", "--id", "T2", "--title", "t", "--owner", "w3", "--by", "w1");
  run(d, "claim", "--id", "T2", "--by", "w3");
  assert.match(run(d, "list").stdout, /→ T2/);
  run(d, "doing", "--id", "T2", "--by", "w3", "--note", "改到 src/x.js");
  assert.match(run(d, "list").stdout, /▶ T2 \[w3\] t — 改到 src\/x\.js/);
  run(d, "blocked", "--id", "T2", "--by", "w3", "--note", "等 w4");
  assert.match(run(d, "list").stdout, /⛔ T2/);
  run(d, "done", "--id", "T2", "--by", "w3", "--note", "提交 abc123，test-x 12/12");
  const out = run(d, "list").stdout;
  assert.match(out, /✅ T2/);
  assert.match(out, /提交 abc123/);
  assert.match(out, /未完成 0 \/ 完成 1/);
});

await check("add 前就出现的事件不会让任务消失（占位为未登记、owner 待领）", () => {
  const d = tmpDir();
  run(d, "doing", "--id", "T9", "--by", "w5", "--note", "先干后登记");
  const out = run(d, "list").stdout;
  assert.match(out, /▶ T9 \[待领\] \(未登记\)/);
  assert.match(out, /先干后登记/);
});

// ── 2. 参数与退出码 ────────────────────────────────────────────────────────
await check("缺 --id / --title / msg 缺 --to / 未知子命令 均 exit 2", () => {
  const d = tmpDir();
  assert.equal(run(d, "add", "--title", "x").status, 2, "缺 --id");
  assert.equal(run(d, "add", "--id", "T3").status, 2, "缺 --title");
  assert.equal(run(d, "msg", "--by", "w1", "--text", "hi").status, 2, "msg 缺 --to");
  assert.equal(run(d, "msg", "--to", "w1", "--by", "w1").status, 2, "msg 缺 --text");
  assert.equal(run(d, "claim", "--by", "w1").status, 2, "claim 缺 --id");
  assert.equal(run(d, "nonsense").status, 2, "未知子命令");
});

// ── 3. 容错 ────────────────────────────────────────────────────────────────
await check("坏行/半行不会让看板整体挂掉", () => {
  const d = tmpDir();
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(boardFile(d), '{"type":"task","id":"TX","title":"半行\n{不是 JSON}\n\n');
  run(d, "add", "--id", "T1", "--title", "好行", "--owner", "w1", "--by", "w1");
  const out = run(d, "list").stdout;
  assert.match(out, /T1/);
  assert.match(out, /看板：1 个任务/);
});

await check("空 brief / 空 owner 允许登记（T99 那种空壳），不报错", () => {
  const d = tmpDir();
  assert.equal(run(d, "add", "--id", "T99", "--title", "空壳", "--by", "w2").status, 0);
  const ev = parsed(d).filter((e) => e && e.id === "T99")[0];
  assert.equal(ev.brief, "");
  assert.equal(ev.owner, "");
  assert.match(run(d, "list").stdout, /T99 \[待领\]/);
});

// ── 4. 并发写入（六窗口同时 add） ──────────────────────────────────────────
await check("6 进程 × 20 条并发 add 不丢行、不撕裂", async () => {
  const d = tmpDir();
  const jobs = [];
  for (let w = 1; w <= 6; w++) {
    for (let i = 1; i <= 20; i++) {
      jobs.push(runAsync(d, "add", "--id", `C${w}-${i}`, "--title", `并发 ${w}/${i}`, "--owner", `w${w}`, "--by", `w${w}`));
    }
  }
  const res = await Promise.all(jobs);
  assert.equal(res.filter((r) => r.code === 0).length, 120, "120 次 add 都应成功");
  const lines = events(d);
  assert.equal(lines.length, 120, "行数应为 120，实际 " + lines.length);
  const bad = lines.filter((l) => { try { JSON.parse(l); return false; } catch { return true; } });
  assert.equal(bad.length, 0, "不应有撕裂行");
  const ids = new Set(parsed(d).map((e) => e.id));
  assert.equal(ids.size, 120, "120 个 id 都应能读回");
});

// ── 5. 守卫与边界（缺陷 #1-#5 修完之后的行为） ─────────────────────────────
await check("重复 add 同一 id 被拒绝（exit 3），原任务状态与标题不受影响", () => {
  const d = tmpDir();
  run(d, "add", "--id", "T2", "--title", "原名", "--owner", "w2", "--by", "w1");
  run(d, "doing", "--id", "T2", "--by", "w2", "--note", "干到一半");
  const again = run(d, "add", "--id", "T2", "--title", "重登记", "--owner", "w9", "--by", "w1");
  assert.equal(again.status, 3, "重复 id 应 exit 3");
  const out = run(d, "list").stdout;
  assert.match(out, /▶ T2 \[w2\] 原名/);
  assert.match(out, /干到一半/);
  assert.doesNotMatch(out, /重登记/);
});

await check("claim 有归属校验：别人名下的任务抢不走，本人 claim 幂等（缺陷 #2 已修）", () => {
  const d = tmpDir();
  run(d, "add", "--id", "T2", "--title", "t", "--owner", "w2", "--by", "w1");
  // 外人 claim → exit 3，owner 与状态都不变
  const steal = run(d, "claim", "--id", "T2", "--by", "w9");
  assert.equal(steal.status, 3, "抢别人的任务应 exit 3");
  assert.match(run(d, "list").stdout, /T2 \[w2\]/, "owner 不应被改掉");
  // 本人 claim → 成功且幂等（重复 claim 不报错）
  assert.equal(run(d, "claim", "--id", "T2", "--by", "w2").status, 0, "本人 claim 应成功");
  assert.equal(run(d, "claim", "--id", "T2", "--by", "w2").status, 0, "重复 claim 也应成功");
  assert.match(run(d, "list").stdout, /→ T2 \[w2\]/);
  // 没人领的任务谁都能领
  run(d, "add", "--id", "T3", "--title", "空领", "--by", "w1");
  assert.equal(run(d, "claim", "--id", "T3", "--by", "w4").status, 0, "待领任务谁都能 claim");
  assert.match(run(d, "list").stdout, /→ T3 \[w4\]/);
  // doing 不做归属校验（done/blocked 有归属校验，见第 6 节 D25 用例）
  assert.equal(run(d, "doing", "--id", "T2", "--by", "w9").status, 0, "doing 不做归属校验");
});

await check("只有主窗口能改派（reassign --by main），改派后新 owner 可 claim", () => {
  const d = tmpDir();
  run(d, "add", "--id", "T5", "--title", "t", "--owner", "w2", "--by", "w1");
  // 窗口自己改派 → exit 3
  assert.equal(run(d, "reassign", "--id", "T5", "--owner", "w4", "--by", "w4").status, 3, "非 main 改派应 exit 3");
  // --owner 非法 → exit 2
  assert.equal(run(d, "reassign", "--id", "T5", "--owner", "w99", "--by", "main").status, 2, "非法 owner 应 exit 2");
  // 不存在的 id → exit 3
  assert.equal(run(d, "reassign", "--id", "T404", "--owner", "w4", "--by", "main").status, 3, "未知 id 应 exit 3");
  // 正常改派
  assert.equal(run(d, "reassign", "--id", "T5", "--owner", "w4", "--by", "main", "--note", "改派给 w4").status, 0);
  assert.match(run(d, "list").stdout, /T5 \[w4\]/);
  assert.match(run(d, "list").stdout, /改派给 w4/);
  // 改派后新 owner claim 通过、原 owner 抢不回来
  assert.equal(run(d, "claim", "--id", "T5", "--by", "w4").status, 0);
  assert.equal(run(d, "claim", "--id", "T5", "--by", "w2").status, 3);
});

await check("任务按「前缀 + 数字」排序：T2 在 T10 前，D13/M1/T 各自成组（缺陷 #3 已修）", () => {
  const d = tmpDir();
  for (const [id, title] of [["T10", "十"], ["T2", "二"], ["M1", "M一"], ["D13", "D十三"], ["T1", "一"]]) {
    run(d, "add", "--id", id, "--title", title, "--owner", "w2", "--by", "w1");
  }
  const order = run(d, "list").stdout.split("\n")
    .filter((l) => /^[·→▶⛔✅] /.test(l))
    .map((l) => l.split(" ")[1]);
  assert.deepEqual(order, ["D13", "M1", "T1", "T2", "T10"], "应为 D13,M1,T1,T2,T10；实际 " + order.join(","));
});

await check("--owner 白名单校验：非法 owner exit 2，合法与留空照收（缺陷 #5 已修）", () => {
  const d = tmpDir();
  for (const bad of ["w99", "W1", "w0", "main", "w7"]) {
    const r = run(d, "add", "--id", "TB", "--title", "t", "--owner", bad, "--by", "w1");
    assert.equal(r.status, 2, `--owner ${bad} 应 exit 2`);
    assert.match(r.stderr, /--owner/, "错误信息应提到 --owner");
  }
  for (const ok of ["w1", "w6"]) {
    assert.equal(run(d, "add", "--id", "TG-" + ok, "--title", "t", "--owner", ok, "--by", "w1").status, 0, `${ok} 应被接受`);
  }
  assert.equal(run(d, "add", "--id", "TN", "--title", "t", "--by", "w1").status, 0, "留空 owner 应被接受");
  const out = run(d, "list").stdout;
  assert.match(out, /TN \[待领\]/);
  assert.doesNotMatch(out, /TB |w99/, "非法 owner 不应落盘");
});

await check("tail 默认 20 条、可指定条数", () => {
  const d = tmpDir();
  for (let i = 1; i <= 25; i++) run(d, "note", "--by", "w1", "--text", "n" + i);
  assert.equal(run(d, "tail").stdout.trim().split("\n").length, 20);
  assert.equal(run(d, "tail", "5").stdout.trim().split("\n").length, 5);
});

// ── 6. D25：done / blocked 的归属校验（防 23:52 那种误标） ─────────────────
// 事故：2026-10-26 23:52，w4 因 id 撞号把 w5 的 D23 标成 done，看板状态被写错，只能人工恢复。
// claim 在 D13 已有归属校验，但 done/blocked 没有——这两个才是把「没干的活」写成「干完了」的入口。
await check("他人 done 被拒（exit 3，说清是谁的任务，状态不变）", () => {
  const d = tmpDir();
  run(d, "add", "--id", "D1", "--title", "别人的活", "--owner", "w5", "--by", "w1");
  run(d, "doing", "--id", "D1", "--by", "w5", "--note", "干到一半");
  const r = run(d, "done", "--id", "D1", "--by", "w4", "--note", "手滑");
  assert.equal(r.status, 3, "非 owner 的 done 必须 exit 3：" + r.stderr);
  assert.match(r.stderr, /属于 w5/, "stderr 要点名 owner");
  assert.match(r.stderr, /reassign/, "要提示改派路径");
  const out = run(d, "list").stdout;
  assert.match(out, /▶ D1 \[w5\]/, "状态必须还是 doing");
  assert.doesNotMatch(out, /✅ D1/);
  assert.doesNotMatch(out, /手滑/, "被拒的 note 不能落盘");
});

await check("他人 blocked 被拒（exit 3，状态不变）", () => {
  const d = tmpDir();
  run(d, "add", "--id", "D2", "--title", "别人的活", "--owner", "w5", "--by", "w1");
  const r = run(d, "blocked", "--id", "D2", "--by", "w4", "--note", "等接口");
  assert.equal(r.status, 3);
  assert.match(run(d, "list").stdout, /· D2 \[w5\]/, "状态必须还是 todo");
});

await check("done 不存在的 id 被拒（exit 3，且不写事件、不冒出假任务）", () => {
  const d = tmpDir();
  const r = run(d, "done", "--id", "D999", "--by", "w6", "--note", "凭空 done");
  assert.equal(r.status, 3, "未登记的任务不能 done");
  assert.match(r.stderr, /没有 D999/);
  assert.equal(events(d).length, 0, "任何事件都不该写进去");
  assert.doesNotMatch(run(d, "list").stdout, /D999/);
});

await check("owner 自己 done 仍然正常通过（不能误伤日常流程）", () => {
  const d = tmpDir();
  run(d, "add", "--id", "D3", "--title", "我的活", "--owner", "w6", "--by", "w1");
  const r = run(d, "done", "--id", "D3", "--by", "w6", "--note", "提交 abc1234，test-x 12/12");
  assert.equal(r.status, 0, "owner 自己 done 应 exit 0：" + r.stderr);
  const out = run(d, "list").stdout;
  assert.match(out, /✅ D3 \[w6\]/);
  assert.match(out, /提交 abc1234/);
});

await check("待领任务（无 owner）谁都能标 done，不被归属校验误伤", () => {
  const d = tmpDir();
  run(d, "add", "--id", "D4", "--title", "待领", "--by", "w1");
  assert.equal(run(d, "done", "--id", "D4", "--by", "w6", "--note", "我干完了").status, 0);
  assert.match(run(d, "list").stdout, /✅ D4/);
});

await check("add 撞号的提示里带「当前状态」，一眼看清撞了谁", () => {
  const d = tmpDir();
  run(d, "add", "--id", "D5", "--title", "原名", "--owner", "w5", "--by", "w1");
  run(d, "doing", "--id", "D5", "--by", "w5");
  const r = run(d, "add", "--id", "D5", "--title", "重登记", "--owner", "w4", "--by", "w4");
  assert.equal(r.status, 3);
  assert.match(r.stderr, /owner=w5/);
  assert.match(r.stderr, /当前状态 doing/);
  assert.match(r.stderr, /原名/);
});

// 清理临时目录
for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

console.log(`\n${failed ? "✗" : "✓"} ${total - failed}/${total} 用例通过${failed ? `（失败 ${failed}）` : ""}`);
process.exit(failed ? 1 : 0);
