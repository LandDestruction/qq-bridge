#!/usr/bin/env node
// 好感度逻辑自测（M7 规格 §8 的条目 + W1 派单点名的 3/4/5/6/7/9/11/13/14/15）。
//
// 规矩：
//   1. 全部在**系统临时目录**里建库，跑完删掉；真实 state/affinity.json 只做「没碰过」的断言。
//   2. 一条失败不影响其余，最后按失败数退 1 —— 一次运行就能看到全部问题。
//   3. 时间全部显式传入（不用 Date.now 碰运气），跨天/冷却/30 天都能确定性复现。
//
// 用法：node scripts/test-affinity.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  AFFINITY_RULES_VER, DEFAULT_RULES, normalizeRules, clampScore, dayKeyOf,
  emptyStore, ensurePerson, applyInbound, settleDay, applyPenalty, shiftByModel,
  describeForPrompt, privacyLine, progressToScore, prunePeople, listForConsole,
  serialize, parseStore, loadStore, saveStore
} from '../src/affinity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_FILE = path.resolve(HERE, '..', 'state', 'affinity.json');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-affinity-'));
const FILE = path.join(dir, 'affinity.json');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-26T20:00:00+08:00');
const RULES = normalizeRules({}); // 默认值

let failed = 0;
let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`✅ ${name}`); }
  catch (e) { failed += 1; console.error(`❌ ${name} — ${e?.message ?? e}`); }
}

const realBefore = fs.existsSync(REAL_FILE)
  ? crypto.createHash('sha256').update(fs.readFileSync(REAL_FILE)).digest('hex') : null;

function freshStore() {
  const store = emptyStore();
  return store;
}
function personOf(store, id = '100000006') {
  return ensurePerson(store, id, T0, RULES);
}

try {
  // ── 1. clamp ───────────────────────────────────────────────────────────────
  check('1. clampScore：-1→0、101→100、正常值原样、NaN→0', () => {
    assert.equal(clampScore(-1), 0);
    assert.equal(clampScore(101), 100);
    assert.equal(clampScore(62), 62);
    assert.equal(clampScore(Number.NaN), 0);
  });

  // ── 2. 默认 50 ─────────────────────────────────────────────────────────────
  check('2. 未收录的人默认 50 分，首次互动建条目', () => {
    const store = freshStore();
    const p = ensurePerson(store, '10001', T0, RULES);
    assert.equal(p.score, 50);
    assert.equal(p.base, 50);
    assert.equal(p.modelDelta, 0);
    assert.ok(store.people['10001'], '条目应已建好');
    assert.equal(progressToScore(p).score, 50);
  });

  // ── 3. 跨群同一人合并 ──────────────────────────────────────────────────────
  check('3. 同一 QQ 号在三个群/私聊里说话，只合并成一条记录', () => {
    const store = freshStore();
    for (const scope of ['group:100000001', 'group:100000003', 'private:100000006']) {
      const p = ensurePerson(store, '100000006', T0, RULES);
      applyInbound(p, { scope, kind: scope.startsWith('private') ? 'private' : 'group' }, T0, RULES);
    }
    assert.equal(Object.keys(store.people).length, 1, `实得 ${Object.keys(store.people).length} 条`);
    const p = store.people['100000006'];
    assert.equal(p.counters.msgs, 3);
    assert.ok(p.reasons.length >= 1);
  });

  // ── 4. 每天证据上限（刷 50 条私聊仍 ≤ +2） ─────────────────────────────────
  check('4. 刷 50 条私聊：私聊证据仍封顶 +2（含露面 +1，当天总证据 ≤3）', () => {
    const store = freshStore();
    const p = ensurePerson(store, '20002', T0, RULES);
    for (let i = 0; i < 50; i += 1) applyInbound(p, { kind: 'private' }, T0 + i * 1000, RULES);
    assert.equal(p.dayEvidence.priv, 2, `私聊证据应封顶 2，实得 ${p.dayEvidence.priv}`);
    assert.ok(p.dayBasePoints <= 3 + 1e-9, `当天总证据应 ≤3（露面1+私聊2），实得 ${p.dayBasePoints}`);
    assert.equal(p.base, 50, 'base 当天不该被推动（要等跨天结算）');
  });

  // ── 5. base 向目标 10% 靠拢（不跳变） ──────────────────────────────────────
  check('5. 跨天结算：base 只朝目标挪 10%（50→50.6，而不是直接 +6）', () => {
    const store = freshStore();
    const p = ensurePerson(store, '30003', T0, RULES);
    p.dayBasePoints = 6; // 手工放 6 分当天证据
    const r = settleDay(p, T0 + DAY, RULES);
    assert.equal(r.points, 6);
    assert.equal(p.base, 50.6, `实得 ${p.base}`); // 50 + (56-50)*0.1
    assert.equal(p.dayBasePoints, 0, '当天证据应清零');
    assert.equal(p.dayKey, dayKeyOf(T0 + DAY));
  });

  // ── 6. 30 天未出现 −5（空窗只扣一次） ──────────────────────────────────────
  check('6. 30 天未出现：base −5，同一空窗重复结算不再扣', () => {
    const store = freshStore();
    const p = ensurePerson(store, '40004', T0, RULES);
    p.counters.lastSeenAt = T0;
    const first = settleDay(p, T0 + 31 * DAY, RULES);
    assert.equal(first.absent, -5);
    assert.equal(p.base, 45, `实得 ${p.base}`);
    const second = applyPenalty(p, 'absent30d', T0 + 40 * DAY, RULES);
    assert.equal(second.applied, false, '同一空窗不该重复扣');
    assert.equal(p.base, 45);
  });

  // ── 7. 辱骂 −1 且日上限 −3 ─────────────────────────────────────────────────
  check('7. 辱骂每次 −1、每天最多 −3（第 4 次拒绝）', () => {
    const store = freshStore();
    const p = ensurePerson(store, '50005', T0, RULES);
    const deltas = [];
    for (let i = 0; i < 4; i += 1) {
      const r = applyPenalty(p, 'insult', T0 + i * 1000, RULES);
      deltas.push(r.delta);
    }
    assert.deepEqual(deltas, [-1, -1, -1, 0], `实得 ${JSON.stringify(deltas)}`);
    assert.equal(p.base, 47, `底分应 50-3=47，实得 ${p.base}`);
    assert.equal(p.dayEvidence.insult, -3);
  });

  // ── 8. 露面 +1 每天只一次 ──────────────────────────────────────────────────
  check('8. 当天多条消息只加一次「露面 +1」', () => {
    const store = freshStore();
    const p = ensurePerson(store, '60006', T0, RULES);
    for (let i = 0; i < 10; i += 1) applyInbound(p, {}, T0 + i * 1000, RULES);
    assert.equal(p.counters.daysSeen, 1);
    assert.equal(p.dayBasePoints, 1, `实得 ${p.dayBasePoints}`);
  });

  // ── 9. |delta| > 3 拒绝 ────────────────────────────────────────────────────
  check('9. 模型 delta 超 ±3：拒绝且不改任何字段', () => {
    const store = freshStore();
    ensurePerson(store, '70007', T0, RULES);
    const before = serialize(store);
    for (const d of [4, -4, 3.5]) {
      const r = shiftByModel(store, { userId: '70007', delta: d, reason: '测试', now: T0, rules: RULES, hadInboundThisTurn: true });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'bad_delta');
    }
    assert.equal(serialize(store), before, '拒绝时不该改库');
  });

  // ── 10. 10 分钟冷却 ────────────────────────────────────────────────────────
  check('10. 同一人 10 分钟内第二次改分被拒（cooldown）', () => {
    const store = freshStore();
    ensurePerson(store, '80008', T0, RULES);
    const first = shiftByModel(store, { userId: '80008', delta: 2, reason: '一起斗图', now: T0, rules: RULES, hadInboundThisTurn: true });
    assert.equal(first.ok, true, first.message);
    const second = shiftByModel(store, { userId: '80008', delta: 1, reason: '又聊了两句', now: T0 + 5 * 60_000, rules: RULES, hadInboundThisTurn: true });
    assert.equal(second.code, 'cooldown');
    const third = shiftByModel(store, { userId: '80008', delta: 1, reason: '又聊了两句', now: T0 + 11 * 60_000, rules: RULES, hadInboundThisTurn: true });
    assert.equal(third.ok, true, third.message);
  });

  // ── 11. 日累计 > 10 拒绝 ───────────────────────────────────────────────────
  check('11. 每人每天 |Σdelta| ≤ 10：第 4 次 +3 被拒（daily_limit）', () => {
    const store = freshStore();
    ensurePerson(store, '90009', T0, RULES);
    const codes = [];
    for (let i = 0; i < 4; i += 1) {
      const r = shiftByModel(store, {
        userId: '90009', delta: 3, reason: `第 ${i + 1} 次`, now: T0 + i * (11 * 60_000), rules: RULES, hadInboundThisTurn: true
      });
      codes.push(r.ok ? 'ok' : r.code);
    }
    assert.deepEqual(codes, ['ok', 'ok', 'ok', 'daily_limit'], `实得 ${JSON.stringify(codes)}`);
    assert.equal(store.people['90009'].dayModelDelta, 9);
  });

  // ── 12. 被问当轮禁改 ───────────────────────────────────────────────────────
  check('12. 被问好感度那一轮：asked_this_turn 拒绝', () => {
    const store = freshStore();
    ensurePerson(store, '11011', T0, RULES);
    const r = shiftByModel(store, { userId: '11011', delta: 3, reason: '趁机讨好', now: T0, rules: RULES, askedThisTurn: true, hadInboundThisTurn: true });
    assert.equal(r.code, 'asked_this_turn');
    assert.equal(store.people['11011'].modelDelta, 0);
  });

  // ── 13. 本轮无该人入站拒绝 ─────────────────────────────────────────────────
  check('13. 本轮这个人没说话：no_inbound 拒绝（防自嗨）', () => {
    const store = freshStore();
    ensurePerson(store, '12012', T0, RULES);
    const r = shiftByModel(store, { userId: '12012', delta: 3, reason: '凭印象', now: T0, rules: RULES, hadInboundThisTurn: false });
    assert.equal(r.code, 'no_inbound');
    assert.equal(store.people['12012'].modelDelta, 0);
  });

  // ── 14. 原子写 / tmp 残留 ──────────────────────────────────────────────────
  check('14. 原子写：不留 tmp、不产生半文件；已有 tmp 残留也能正常读写', () => {
    const store = freshStore();
    personOf(store, '13013');
    const n = saveStore(FILE, store);
    assert.ok(n > 0);
    const left = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(left, [], `不该留下 tmp：${left.join(',')}`);
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    assert.equal(parsed.people['13013'].score, 50);

    // 模拟「上次写到一半被杀」：目录里躺着一个半截 tmp，库文件本身完好。
    const stale = path.join(dir, '.affinity.json.9999.dead.tmp');
    fs.writeFileSync(stale, '{"version":1,"people":{"13013":{"base":50', 'utf8');
    const loaded = loadStore(FILE, T0, { rules: RULES });
    assert.equal(loaded.people['13013'].score, 50, '残留 tmp 不该影响读数');
    saveStore(FILE, loaded);
    assert.ok(fs.existsSync(stale), '不属于本次写入的 tmp 不该被删');
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp') && f !== path.basename(stale)).length, 0);
    fs.unlinkSync(stale);
  });

  // ── 15. 坏 JSON / 坏条目恢复 ───────────────────────────────────────────────
  check('15. 坏 JSON 返回空库；坏条目丢弃、好人保留', () => {
    const broken = parseStore('{"people": {"a": {');
    assert.equal(Object.keys(broken.people).length, 0, '坏 JSON 应得到空库');
    assert.equal(broken.corrupted, true);

    const mixed = JSON.stringify({
      version: 1, rulesVer: AFFINITY_RULES_VER,
      people: {
        good: { base: 60, modelDelta: 5, reasons: [{ ts: T0, by: 'heuristic', delta: 1, why: 'ok' }] },
        noScore: { name: 'x' },
        notObject: 'garbage',
        nullEntry: null
      }
    });
    const s = parseStore(mixed);
    assert.equal(Object.keys(s.people).length, 1, `实得 ${Object.keys(s.people).join(',')}`);
    assert.equal(s.people.good.score, 65);
    assert.equal(s.people.good.reasons.length, 1);
  });

  // ── 16. rulesVer 变更重算 ──────────────────────────────────────────────────
  check('16. rulesVer 变更：旧 reasons 清空、分数按新规则重算、版本更新', () => {
    fs.writeFileSync(FILE, JSON.stringify({
      version: 1, rulesVer: 0,
      people: {
        '14014': { base: 70, modelDelta: 40, reasons: Array.from({ length: 5 }, () => ({ ts: T0, by: 'model', delta: 1, why: '旧规则' })) }
      }
    }), 'utf8');
    const loaded = loadStore(FILE, T0, { rules: RULES });
    assert.equal(loaded.rulesVer, AFFINITY_RULES_VER);
    assert.equal(loaded.people['14014'].reasons.length, 0, '旧理由应清空');
    assert.equal(loaded.people['14014'].score, 100, '70+40 应被 clamp 到 100');
  });

  // ── 17. reasons 环形 20 ────────────────────────────────────────────────────
  check('17. reasons 环形只留最近 20 条', () => {
    const store = freshStore();
    const p = ensurePerson(store, '15015', T0, RULES);
    // 每天一次、连做 25 天：绕开「日累计 ≤10」和「10 分钟冷却」，只测环形裁剪。
    for (let i = 0; i < 25; i += 1) {
      shiftByModel(store, {
        userId: '15015', delta: 1, reason: `原因 ${i}`, now: T0 + i * DAY, rules: RULES, hadInboundThisTurn: true
      });
    }
    assert.equal(p.reasons.length, 20, `实得 ${p.reasons.length}`);
    assert.match(p.reasons.at(-1).why, /原因 24/, '最后一条应是最新理由');
  });

  // ── 18. 注入串：≤300 字、含分数与理由；隐私串不含第三人数值 ────────────────
  check('18. 被问注入 ≤300 字且含分数/理由；隐私串不含任何第三人的分数', () => {
    const store = freshStore();
    const p = ensurePerson(store, '16016', T0, RULES);
    p.name = '小明';
    p.base = 55; p.modelDelta = 7;
    p.reasons = [
      { ts: T0, by: 'heuristic', delta: 1, why: '连续第 7 天来群里' },
      { ts: T0, by: 'model', delta: -2, why: '嫌你回得慢' }
    ];
    const text = describeForPrompt(p, RULES);
    assert.ok([...text].length <= 300, `实得 ${[...text].length} 字`);
    assert.ok(text.includes('62/100'), text);
    assert.ok(text.includes('小明'), text);
    assert.ok(text.includes('连续第 7 天来群里'), '应带具体理由');
    assert.ok(text.includes('不得调用 qq_affinity_shift'), '应写明本轮禁令');

    const privacy = privacyLine(RULES);
    assert.ok(/只能报对方自己的分数/.test(privacy));
    assert.ok(!/\d{1,3}\s*\/\s*100/.test(privacy), '隐私串不该出现任何分数');
    assert.ok(!/16016|小明/.test(privacy), '隐私串不该出现任何人名/QQ');
  });

  // ── 18b. 昵称 + 记忆事件（D32）：名字替代号码，记忆优先于计数器 ───────────
  check('18b. 显示昵称而不是裸 QQ 号；记忆事件优先于计数器（≤300 字）', () => {
    const store = freshStore();
    const p = ensurePerson(store, '16016', T0, RULES);
    p.base = 55; p.modelDelta = 7;
    p.reasons = [{ ts: T0, by: 'heuristic', delta: 0.5, why: '被 @ 了 1 次' }];
    const text = describeForPrompt(p, RULES, {
      nickname: '小明',
      memories: ['一起斗过图', '上次帮你骂了刷屏的']
    });
    assert.ok([...text].length <= 300, `实得 ${[...text].length} 字`);
    assert.match(text, /你对 小明 当前 \d+\/100/, text);
    assert.ok(!text.includes('16016'), '取到昵称时不该显示裸 QQ 号');
    assert.ok(text.includes('一起斗过图') && text.includes('上次帮你骂了刷屏的'), '应引用记忆里的具体事');
    assert.ok(!text.includes('被 @ 了 1 次'), '有具体记忆时不该只给计数器描述');
  });

  // ── 18c. 兜底：没昵称退号码；没记忆退计数器；超长内容截断 ──────────────────
  check('18c. 兜底与截断：无昵称退号码、无记忆退计数器、超长记忆仍 ≤300', () => {
    const p = ensurePerson(freshStore(), '16016', T0, RULES);
    p.reasons = [{ ts: T0, by: 'heuristic', delta: 0.5, why: '被引用了 1 次' }];
    const noNick = describeForPrompt(p, RULES);
    assert.ok(noNick.includes('16016'), '没有昵称时应退回号码');
    assert.ok(noNick.includes('被引用了 1 次'), '没有记忆时应退回计数器');
    const long = describeForPrompt(p, RULES, {
      nickname: '长'.repeat(40),
      memories: ['事'.repeat(80), '事'.repeat(80)]
    });
    assert.ok([...long].length <= 300, `实得 ${[...long].length} 字`);
    assert.ok(!long.includes('长'.repeat(25)), '昵称应截到 24 字');
  });

  // ── 19. 180 天清理 ─────────────────────────────────────────────────────────
  check('19. 180 天没互动的人被清理，活跃的人留下', () => {
    const store = freshStore();
    const dead = ensurePerson(store, '17017', T0, RULES);
    dead.counters.lastSeenAt = T0 - 200 * DAY;
    dead.updatedAt = T0 - 200 * DAY;
    const alive = ensurePerson(store, '18018', T0, RULES);
    alive.counters.lastSeenAt = T0 - 10 * DAY;
    alive.updatedAt = T0 - 10 * DAY;
    const r = prunePeople(store, T0, { maxIdleDays: 180 });
    assert.deepEqual(r.removed, ['17017']);
    assert.ok(store.people['18018']);
  });

  // ── 20. 拒绝时零改动 ───────────────────────────────────────────────────────
  check('20. 所有拒绝路径都不改库（cooldown / daily / asked / no_inbound 前后一致）', () => {
    const store = freshStore();
    ensurePerson(store, '19019', T0, RULES);
    shiftByModel(store, { userId: '19019', delta: 3, reason: '先加一次', now: T0, rules: RULES, hadInboundThisTurn: true });
    const snap = serialize(store);
    const rejects = [
      shiftByModel(store, { userId: '19019', delta: 3, reason: 'x', now: T0 + 60_000, rules: RULES, hadInboundThisTurn: true }),
      shiftByModel(store, { userId: '19019', delta: 3, reason: 'x', now: T0 + 600_000, rules: RULES, askedThisTurn: true, hadInboundThisTurn: true }),
      shiftByModel(store, { userId: '19019', delta: 3, reason: 'x', now: T0 + 700_000, rules: RULES, hadInboundThisTurn: false }),
      shiftByModel(store, { userId: '19019', delta: 9, reason: 'x', now: T0 + 900_000, rules: RULES, hadInboundThisTurn: true })
    ];
    assert.deepEqual(rejects.map((r) => r.code), ['cooldown', 'asked_this_turn', 'no_inbound', 'bad_delta']);
    assert.equal(serialize(store), snap, '拒绝不该改库');
  });

  // ── 21. 跨天清零 + 序列化往返 ──────────────────────────────────────────────
  check('21. 跨天清零 dayModelDelta，serialize/parseStore 往返一致', () => {
    const store = freshStore();
    const p = ensurePerson(store, '20020', T0, RULES);
    shiftByModel(store, { userId: '20020', delta: 2, reason: '今天的事', now: T0, rules: RULES, hadInboundThisTurn: true });
    assert.equal(p.dayModelDelta, 2);
    const r = settleDay(p, T0 + DAY, RULES);
    assert.equal(p.dayModelDelta, 0, '跨天应清零日累计');
    assert.equal(r.points, 0);
    const round = parseStore(serialize(store));
    assert.equal(round.people['20020'].modelDelta, 2);
    assert.equal(round.people['20020'].score, p.score);
  });

  // ── 22. 控制台名单（M7 §7，P2）───────────────────────────────────────────
  check('22. 名单：按最近出现排序、limit 生效、只留最近 2 条理由、不带 scope 群号', () => {
    const store = freshStore();
    const a = ensurePerson(store, '22001', T0, RULES);
    a.name = '小明'; a.base = 60; a.counters.lastSeenAt = T0 - 1000;
    const b = ensurePerson(store, '22002', T0, RULES);
    b.base = 70; b.counters.lastSeenAt = T0 - 5000;
    for (let i = 0; i < 4; i += 1) a.reasons.push({ ts: T0 + i, by: 'heuristic', delta: 1, why: `事${i}`, scope: 'group:123456' });
    const list = listForConsole(store, { limit: 1 });
    assert.equal(list.length, 1, 'limit 应生效');
    assert.equal(list[0].userId, '22001', '最近出现的人排前面');
    assert.equal(list[0].reasons.length, 2, '每人只带最近 2 条');
    assert.equal(list[0].reasons[0].why, '事3', '理由新的在前');
    assert.ok(!JSON.stringify(list).includes('123456'), '名单不应把 scope 里的群号带出去');
  });

  // ── 附：规则收敛 / 真实库未被创建 ─────────────────────────────────────────
  check('附1. normalizeRules 收敛坏配置（负上限、NaN、空关键词数组）', () => {
    const r = normalizeRules({ start: 'abc', modelDeltaMax: -3, settleCooldownMs: NaN, queryKeywords: [], showReasons: 999 });
    assert.equal(r.start, DEFAULT_RULES.start);
    assert.equal(r.modelDeltaMax, DEFAULT_RULES.modelDeltaMax, '负的上限应回落默认');
    assert.equal(r.settleCooldownMs, DEFAULT_RULES.settleCooldownMs);
    assert.deepEqual(r.queryKeywords, [...DEFAULT_RULES.queryKeywords]);
    assert.equal(r.showReasons, 10, '上限 10');
    assert.equal(normalizeRules(null).enabled, true);
    assert.equal(normalizeRules({ enabled: false }).enabled, false);
  });
  check('附2. 全程只用临时目录；真实 state/affinity.json 未被创建/改动', () => {
    assert.ok(FILE.startsWith(os.tmpdir()), '测试库必须在临时目录');
    if (realBefore) {
      const after = crypto.createHash('sha256').update(fs.readFileSync(REAL_FILE)).digest('hex');
      assert.equal(after, realBefore, '真实库被改动了');
    } else {
      assert.equal(fs.existsSync(REAL_FILE), false, '本不该创建真实库');
    }
  });
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('');
if (failed) { console.error(`❌ 好感度自测失败：通过 ${passed}、失败 ${failed}`); process.exit(1); }
console.log(`🎉 好感度自测全过：${passed}/${passed}（临时目录，未碰真实 state/affinity.json）`);
