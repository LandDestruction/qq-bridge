// 语气回复核对器：把「群里真机回复」按可机械判定的规则过一遍。
//
// 为什么需要它：离线评测（scripts/probe-agent-tone.mjs，8/8）证明 preset 直连模型没问题，
// 但真链路（QQ 群 → 桥接 → DSH → 回复）多了唤醒、上下文、人设注入几层，话术可能变形。
// 真机验证只能人去群里发三句话，但「回复合不合格」不该靠肉眼——这个脚本负责后半截。
//
// 用法：
//   node scripts/check-tone-replies.mjs --in replies.json          # 核对你收集的真机回复
//   node scripts/check-tone-replies.mjs --selftest                 # 用 docs/tone-eval-*.json + 反例自检规则
//   node scripts/check-tone-replies.mjs --in x.json --json out.json
//
// replies.json 格式（最省事）：
//   [{ "label": "要推荐", "input": "@大肥鱼小姐 推荐部电影", "reply": "《爆裂鼓手》……" }]
// 也接受评测产物格式（docs/tone-eval-*.json）：用 text 字段当 reply。
//
// 退出码：0 全过；1 有不合格；2 参数/文件错。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

// ── 规则 ───────────────────────────────────────────────────────────────────
// 每条规则返回 null（过）或人类可读的原因（不过）。
const AI_LEAK = /(作为|我是)(一?个)?\s*(AI|人工智能|语言模型|大模型)|我(只)?是一个?(AI|人工智能|语言模型)/i;
const REFUSAL = /抱歉[，,]?\s*我(不能|无法)|我(不能|无法)(提供|帮)|这个我(不|无法)/;
const HEADING = /^\s{0,3}#{1,6}\s/m;
const BULLET = /^\s{0,3}[-*]\s+\S/m;

const ATTACK = /(傻的是你|你才(是)?傻|你闭嘴|闭嘴|滚(开|出去)|有病|神经病|你算(什么|老几)|你这种人|活该)/;
const COLD = /(嘴这么冲|有事说事|干嘛|怎么了|消消气|别急|冷静|慢慢说)/;
const EMPATHY = /(别(太)?(想|急|难过)|先(别|休息|睡)|歇会|辛苦|不容易|陪|在呢|没关系|吃点好的)/;
const DISMISS = /(活该|你自己(作|找的)|矫情|这有什么)/;
const MOVIE_TITLE = /《[^》]{1,20}》/;

function checksFor(c) {
  const label = String(c.label || "");
  const reply = String(c.reply ?? c.text ?? "").trim();
  const rules = [];

  // 通用：群里说话不像人、或像客服模板，都算失败
  rules.push(["不含「我是AI/语言模型」式自曝", () => (AI_LEAK.test(reply) ? "出现 AI 自曝：" + reply.match(AI_LEAK)[0] : null)]);
  rules.push(["不含客服式拒答", () => (REFUSAL.test(reply) ? "出现拒答模板：" + reply.match(REFUSAL)[0] : null)]);
  rules.push(["不用 Markdown 标题/子弹列表（群聊里是噪音）", () => (HEADING.test(reply) ? "含 # 标题" : BULLET.test(reply) ? "含 - 列表" : null)]);
  rules.push(["长度 ≤ 300 字（群聊节奏）", () => (reply.length > 300 ? `回复 ${reply.length} 字，超 300` : null)]);
  rules.push(["非空", () => (reply ? null : "回复为空（真机上就是空消息）")]);

  // 分场景
  if (/推荐|电影/.test(label)) {
    rules.push(["「要推荐」必须真给片名", () => (MOVIE_TITLE.test(reply) ? null : "没出现《片名》，可能又在拒答/抬杠")]);
    rules.push(["「要推荐」不许劝人别问", () => (/自己做点饭|没什么好(看|推荐)|不如(别|不)|看了也没/.test(reply) ? "出现推脱话术" : null)]);
  }
  if (/骂|挑衅/.test(label)) {
    rules.push(["「被骂」不升级、不反击", () => (ATTACK.test(reply) ? "出现攻击性用语：" + reply.match(ATTACK)[0] : null)]);
    rules.push(["「被骂」简短（≤ 60 字，不写小作文）", () => (reply.length > 60 ? `回复 ${reply.length} 字，超 60` : null)]);
  }
  if (/低落|情绪/.test(label)) {
    rules.push(["「情绪低落」不评判、不说活该", () => (DISMISS.test(reply) ? "出现评判：" + reply.match(DISMISS)[0] : null)]);
    rules.push(["「情绪低落」有共情或具体建议", () => (EMPATHY.test(reply) || /[，。].{6,}/.test(reply) ? null : "太干，既无共情也无具体建议")]);
  }
  if (/人设|persona/i.test(label)) {
    rules.push(["「换人设」提示 /persona", () => (/\/persona/i.test(reply) ? null : "没提示 /persona 指令")]);
  }
  return { label, reply, rules };
}

function evaluate(cases) {
  const results = cases.map((c) => {
    const { label, reply, rules } = checksFor(c);
    const failed = rules.filter(([, fn]) => fn() !== null).map(([name, fn]) => ({ rule: name, why: fn() }));
    return { label, reply, pass: failed.length === 0, failed };
  });
  const bad = results.filter((r) => !r.pass);
  return { results, bad };
}

function print({ results, bad }) {
  for (const r of results) {
    if (r.pass) console.log(`✓ ${r.label}`);
    else { console.log(`✗ ${r.label}：${r.reply.slice(0, 40)}`); for (const f of r.failed) console.log(`    - ${f.rule}：${f.why}`); }
  }
  console.log(`\n${bad.length ? "✗" : "✓"} ${results.length - bad.length}/${results.length} 条回复合格${bad.length ? `（不合格：${bad.map((b) => b.label).join(", ")}）` : ""}`);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };

if (argv.includes("--selftest")) {
  // 正例：离线评测产物必须全过（证明规则不会把好回复判死）
  const good = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "tone-eval-after.json"), "utf8"))
    .map((c) => ({ label: c.label, input: c.input, reply: c.text }));
  // 反例：每条都必须被打掉（证明规则真的能抓问题）
  const badSamples = [
    { label: "要推荐", reply: "自己做点饭吃，比看什么电影都香。" },
    { label: "被骂", reply: "傻的是你吧，大清早的你在我这刷屏，你有事吗？" },
    { label: "人设", reply: "好呀，那我从现在起就是傲娇了。" },
    { label: "闲聊", reply: "作为一个AI，我无法感受猫的可爱。" },
    { label: "情绪低落", reply: "活该，谁让你自己作的。" }
  ];
  const a = evaluate(good);
  const b = evaluate(badSamples);
  let failed = 0;
  print(a);
  if (a.bad.length) { failed++; console.error("✗ 正例不应被判不合格：" + a.bad.map((x) => x.label).join(", ")); }
  console.log("\n--- 反例（每条都应被打掉）---");
  for (const r of b.results) {
    const ok = !r.pass;
    if (!ok) { failed++; console.error(`✗ 反例漏判：${r.label} → ${r.reply}`); }
    else console.log(`✓ 抓到 ${r.label}：${r.failed.map((f) => f.rule).join(" / ")}`);
  }
  console.log(`\n${failed ? "✗" : "✓"} 规则自检${failed ? `失败 ${failed} 项` : "通过"}（正例 ${a.results.length}、反例 ${b.results.length}）`);
  process.exit(failed ? 1 : 0);
}

const inFile = arg("in");
if (!inFile) { console.error("用法：node scripts/check-tone-replies.mjs --in replies.json | --selftest [--json out.json]"); process.exit(2); }
let cases;
try { cases = JSON.parse(fs.readFileSync(inFile, "utf8")); }
catch (e) { console.error("读不了 " + inFile + "：" + e.message); process.exit(2); }
if (!Array.isArray(cases) || !cases.length) { console.error("输入应是 JSON 数组，且至少一条"); process.exit(2); }
const res = evaluate(cases);
print(res);
const out = arg("json");
if (out) { fs.writeFileSync(out, JSON.stringify(res, null, 2), "utf8"); console.log("明细写入 " + out); }
process.exit(res.bad.length ? 1 : 0);
