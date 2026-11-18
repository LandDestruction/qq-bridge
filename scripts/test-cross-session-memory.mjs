import { readBridgeSource } from './bridge-source.mjs';
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDigest, pickDigests, renderDigestBlock, digestSnapshot, normalizeDigests, DIGEST_DEFAULTS } from "../src/cross-session-memory.js";
let failed = 0;
function check(n, f) { try { f(); console.log("✅ " + n); } catch (e) { failed++; console.error("❌ " + n + " — " + (e?.message ?? e)); } }
const now = 1_760_000_000_000;
const mk = (text, sender = "群友", isSelf = false) => ({ sender, plain: text, text, isSelf });
const dA = buildDigest({ key: "group:111", messages: [mk("今天开黑吗", "甲"), mk("来啊", "乙"), mk("我在打副本", "我", true)], now });
const dB = buildDigest({ key: "group:222", messages: [mk("新显卡到了", "丙"), mk("多少钱")], now });
const dOld = buildDigest({ key: "group:333", messages: [mk("旧消息")], now: now - 25 * 3600 * 1000 });

check("摘要：含 sender 与短句、带 people/topics、有 at", () => {
  assert.ok(dA.summary.includes("甲") && dA.summary.includes("今天开黑吗"));
  assert.ok(dA.people.includes("甲") && dA.people.includes("乙"));
  assert.ok(dA.people.includes("我") === false, "自己不算 people");
  assert.ok(Array.isArray(dA.topics), "topics 必须是数组");
  assert.equal(dA.at, now);
});
check("摘要 ≤ maxChars（装不下就停，不硬切）", () => {
  const long = buildDigest({ key: "group:1", messages: Array.from({ length: 10 }, (_, i) => mk("很长的消息内容".repeat(10), `u${i}`)), now, maxChars: 60 });
  assert.ok(long === null || long.summary.length <= 60, `实得 ${long?.summary?.length}`);
});
check("只注入白名单会话，当前会话排除，观察群/非白名单不出现", () => {
  const items = pickDigests({ digests: { "group:111": dA, "group:222": dB, "group:999": dOld }, currentKey: "group:111", allowKeys: ["group:111", "group:222"], now });
  assert.equal(items.length, 1);
  assert.equal(items[0].key, "group:222");
});
check("过期（>24h）不注入", () => {
  const items = pickDigests({ digests: { "group:333": dOld }, currentKey: "group:1", allowKeys: ["group:333"], now });
  assert.equal(items.length, 0);
});
check("最多 3 个、每个 ≤120 字", () => {
  const digests = {};
  for (let i = 0; i < 6; i += 1) digests[`group:${i}`] = buildDigest({ key: `group:${i}`, messages: [mk("x".repeat(300))], now });
  const items = pickDigests({ digests, currentKey: "group:z", allowKeys: Object.keys(digests), now });
  assert.equal(items.length, DIGEST_DEFAULTS.maxSessions);
  for (const it of items) assert.ok(it.summary.length <= DIGEST_DEFAULTS.maxCharsEach);
});
check("渲染块：默认 B 档（被问起可以说、但不复述原话/不点隐私），总字数 ≤600，空列表返回空串", () => {
  const block = renderDigestBlock([{ key: "group:222", summary: "新显卡到了；多少钱" }]);
  assert.ok(block.includes("被问起时可以说"), "默认应允许「被问起时说」");
  assert.ok(block.includes("不复述别人的原话"), "仍要守住「不复述原话」");
  assert.ok(/手机号|住址|真实姓名|账号/.test(block), "应点名隐私细节禁区");
  assert.ok(!block.includes("不要主动把其它群"), "默认不该再是旧的禁止措辞");
  assert.ok(block.includes("群 222"));
  assert.ok(block.length <= 600 + 4);
  assert.equal(renderDigestBlock([]), "");
});

// ── D36 新增：披露口径可切换（用户拍板 B=open，strict 保留以便回滚） ─────────
check("disclosure='strict' 切回旧措辞（可配置回滚，不用改代码）", () => {
  const block = renderDigestBlock([{ key: "group:222", summary: "新显卡到了" }], { disclosure: "strict" });
  assert.ok(block.includes("不要主动把其它群"), "strict 应是旧的那句");
  assert.ok(!block.includes("被问起时可以说"), "strict 不该混进 open 的措辞");
});

check("disclosure 传未知值/不传 → 一律按 open（默认），不会渲染出空块头", () => {
  for (const d of [undefined, null, "", "OPEN", "nonsense"]) {
    const block = renderDigestBlock([{ key: "group:222", summary: "x" }], d === undefined ? {} : { disclosure: d });
    assert.ok(block.includes("被问起时可以说"), `disclosure=${String(d)} 应按 open 处理`);
  }
});

// ── D36 新增：摘要质量三条（占位符 / 半截尾 / 假话题） ──────────────────────
check("纯占位符消息不进摘要（[图片]/[表情包]/[视频]/[文件]）", () => {
  const msgs = [mk("[图片]", "甲"), mk("[表情包:表示兴奋]", "乙"), mk("语音条", "丙"), mk("[视频]", "丁"), mk("其实我想说的是显卡到了", "甲")];
  const d = buildDigest({ key: "group:1", messages: msgs, now });
  assert.ok(d, "应仍有摘要");
  for (const bad of ["[图片]", "[表情包", "[视频]", "[文件]"]) assert.ok(!d.summary.includes(bad), `不该含 ${bad}：${d.summary}`);
  assert.ok(d.summary.includes("显卡到了"), "真实内容要留下");
});

check("带事实的媒体占位符要保留（[视频 12 秒｜已抽 9 帧] 这类）", () => {
  const msgs = [mk("[视频 12 秒｜已抽 9 帧]", "甲"), mk("这段翻车的", "乙")];
  const d = buildDigest({ key: "group:1", messages: msgs, now });
  assert.ok(d.summary.includes("12 秒"), `带时长/帧数的媒体是事实，应保留：${d.summary}`);
});

check("不留半截尾条：末段不可能是「人名：」或半个名字", () => {
  // 造一条「刚好会超」的消息流：前几条正常，最后一条长到装不下
  const msgs = [
    mk("甲说的话一号", "甲"), mk("乙说的话二号", "乙"), mk("丙说的话三号", "丙"),
    mk("这条特别长长长长长长长长长长长长长长长长长长长长长长长长长长长长", "丁")
  ];
  const d = buildDigest({ key: "group:1", messages: msgs, now, maxChars: 40 });
  assert.ok(d, "应仍有摘要");
  const last = d.summary.split("；").pop();
  assert.ok(!last.endsWith("："), `末段不能只剩冒号：${d.summary}`);
  assert.ok(!/^[^：]{1,12}：.{0,1}$/.test(last) || last.length > 6, `末段不能是半个名字+半个字：${last}`);
  assert.ok(d.summary.length <= 40, `总长 ${d.summary.length}`);
});

check("topics：只留跨消息重复出现的短语，且不含口水词", () => {
  const msgs = [mk("周末去爬山吗", "甲"), mk("爬山我脚还没好", "乙"), mk("那就改成爬山脚下喝茶", "甲"), mk("爬山改成喝茶我同意", "丙")];
  const d = buildDigest({ key: "group:1", messages: msgs, now });
  assert.ok(d.topics.some((x) => x.includes("爬山")), `应抓到重复出现的「爬山」：${JSON.stringify(d.topics)}`);
  for (const junk of ["算了", "这个", "那个", "什么", "怎么"]) assert.ok(!d.topics.includes(junk), `不该有口水词：${junk}`);
});

check("全占位符消息 → 返回 null（宁可不存，也不存一条没有信息的摘要）", () => {
  assert.equal(buildDigest({ key: "group:1", messages: [mk("[图片]", "甲"), mk("[表情包:笑]", "乙")], now }), null);
});
check("关闭开关：pickDigests 由调用方控制，bridge 里读 enabled===false 就不注入", () => {
  const src = readBridgeSource();
  assert.ok(src.includes("cfgM.enabled === false"), "应有开关判断");
  assert.ok(src.includes("['crossSession', crossSessionText]"), "prompt 段落里应包含跨会话块");
  assert.ok(src.includes("不传 key 就是跨会话搜"), "提示词应教她跨会话检索");
});

// ── 落盘往返：这条是 T12 的回归。之前 saveSocialV2State() 不写 digests，
//    摘要只活在内存里，桥接一重启跨会话记忆就归零（线上 state 文件里连字段都没有）。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "w3-digest-roundtrip-"));
try {
  const stateFile = path.join(tmpDir, "social-v2.json");
  const memory = {
    "group:111": buildDigest({ key: "group:111", messages: [mk("今晚开黑吗", "甲"), mk("来啊", "乙")], now }),
    "group:222": buildDigest({ key: "group:222", messages: [mk("新显卡到了", "丙")], now }),
    "group:333": buildDigest({ key: "group:333", messages: [mk("一天前的老消息")], now: now - 25 * 3600 * 1000 })
  };

  // 模拟 saveSocialV2State()：内存里的摘要跟着整份 state 一起落盘（写的是系统临时目录）。
  fs.writeFileSync(stateFile, JSON.stringify({ conversations: {}, digests: digestSnapshot(memory, { now }) }), "utf8");
  // 模拟 loadMemoryLayers()：读盘后归一。
  const onDisk = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const reloaded = normalizeDigests(onDisk.digests);

  check("写盘→重载：摘要仍在，且重启后还能继续注入", () => {
    assert.ok(onDisk.digests && typeof onDisk.digests === "object", "state 里必须有 digests 字段");
    assert.deepEqual(Object.keys(reloaded).sort(), ["group:111", "group:222"], "24h 内的摘要都应重载回来");
    const items = pickDigests({ digests: reloaded, currentKey: "group:111", allowKeys: ["group:111", "group:222"], now });
    assert.equal(items.length, 1, "重载后 group:111 仍应看到 group:222");
    assert.equal(items[0].key, "group:222");
    assert.ok(items[0].summary.includes("新显卡到了"), "摘要正文不能丢");
  });
  check("重载保留 people/topics/summary 字段结构", () => {
    const d = reloaded["group:111"];
    assert.equal(typeof d.at, "number");
    assert.ok(d.summary.length > 0);
    assert.ok(Array.isArray(d.people) && d.people.includes("甲"), `people 实得 ${JSON.stringify(d.people)}`);
    assert.ok(Array.isArray(d.topics));
  });
  check("落盘快照丢掉 >24h 的旧摘要（它们本来就进不了 prompt）", () => {
    const snap = digestSnapshot(memory, { now });
    assert.equal(snap["group:333"], undefined, "过期摘要不该占盘");
    assert.ok(snap["group:111"] && snap["group:222"]);
  });
  check("落盘快照最多留 50 个会话，且字段被裁到上限", () => {
    const many = {};
    for (let i = 0; i < 80; i += 1) many[`group:${i}`] = buildDigest({ key: `group:${i}`, messages: [mk("x".repeat(500))], now });
    const snap = digestSnapshot(many, { now });
    assert.equal(Object.keys(snap).length, 50, `实得 ${Object.keys(snap).length}`);
    for (const d of Object.values(snap)) assert.ok(d.summary.length <= DIGEST_DEFAULTS.maxChars);
  });
  check("归一：坏条目一律丢掉，不炸", () => {
    const dirty = {
      "group:1": { key: "group:1", at: now, summary: "正常" },
      "group:2": { at: now },                        // 无 summary
      "group:3": { summary: "无时间" },               // 无 at
      "group:4": null,                                // 空
      "group:5": "字符串",                            // 不是对象
      "group:6": { at: now, summary: "   " }          // 空白 summary
    };
    const clean = normalizeDigests(dirty);
    assert.deepEqual(Object.keys(clean), ["group:1"]);
  });
  check("归一：digests 本身是数组/字符串/undefined 都按空处理", () => {
    for (const bad of [undefined, null, [], "x", 42]) assert.deepEqual(normalizeDigests(bad), {});
  });
  check("快照不修改内存里的原对象（保存不能有副作用）", () => {
    const before = JSON.stringify(memory);
    digestSnapshot(memory, { now });
    assert.equal(JSON.stringify(memory), before);
  });
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

check("bridge 接线：saveSocialV2State 落盘 digests、loadMemoryLayers 归一，且两者都从本模块导入", () => {
  const src = readBridgeSource();
  assert.ok(/digests:\s*digestSnapshot\(/.test(src), "saveSocialV2State 的 obj 里应写入 digests 快照");
  assert.ok(/normalizeDigests\(raw\?\.digests\)/.test(src), "loadMemoryLayers 应用 normalizeDigests 归一");
  assert.ok(/digestSnapshot,\s*normalizeDigests/.test(src), "应从 cross-session-memory.js 导入这两个函数");
  const saveFn = src.slice(src.indexOf("function saveSocialV2State("), src.indexOf("function saveSocialV2State(") + 2200);
  assert.ok(saveFn.includes("digests"), "saveSocialV2State 函数体内必须出现 digests");
});

check("bridge 把披露口径从配置传进 renderDigestBlock（disclosure，默认 open）", () => {
  const src = readBridgeSource();
  const i = src.indexOf("const disclosure =");
  assert.ok(i > 0, "应在渲染前算出 disclosure");
  const seg = src.slice(i, i + 400);
  assert.ok(/cfgM\.disclosure\s*===\s*'strict'/.test(seg), "strict 才切旧措辞，其它值都按 open");
  assert.ok(seg.includes("renderDigestBlock(") && /disclosure\s*\}?\)?/.test(seg), "应把 disclosure 传给 renderDigestBlock");
});

if (failed) process.exit(1);
console.log("\n🎉 跨会话记忆测试通过");
