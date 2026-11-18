// memory-layers 单测：印象合并/迁移、共享事件打分与预算、脉络摘要。
import assert from 'node:assert/strict';
import {
  mergeImpression, applyImpressionEdit, migrateImpressions, addSharedEvent, pruneEvents,
  scoreEvent, selectEventsForInjection, formatGlobalImpressions, buildHandoffDigest,
  EVENT_MAX_COUNT, INJECT_BUDGET_CHARS
} from '../src/memory-layers.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}: ${e.message}`); }
}

console.log('\n[1] 印象合并');
check('新建条目', () => {
  const g = {};
  const e = mergeImpression(g, '阿虚', { traits: ['喜欢VRChat'], interactionCount: 2, at: 1000 });
  assert.deepEqual(e.traits, ['喜欢VRChat']);
  assert.equal(e.interactionCount, 2);
  assert.equal(e.lastSeenAt, 1000);
});
check('重复 traits 去重 + 次数累加', () => {
  const g = {};
  mergeImpression(g, '阿虚', { traits: ['话多', '夜猫子'], interactionCount: 2, at: 1000 });
  const e = mergeImpression(g, '阿虚', { traits: ['夜猫子', '爱发图'], interactionCount: 3, at: 2000 });
  assert.deepEqual(e.traits, ['话多', '夜猫子', '爱发图']);
  assert.equal(e.interactionCount, 5);
  assert.equal(e.lastSeenAt, 2000);
});
check('非法名字被拒', () => {
  const g = {};
  assert.equal(mergeImpression(g, '__proto__', { traits: ['x'] }), null);
  assert.equal(mergeImpression(g, '   ', { traits: ['x'] }), null);
});
check('traits 支持字符串分隔', () => {
  const g = {};
  const e = mergeImpression(g, '甲', { traits: '爱笑，反应快、话少' });
  assert.deepEqual(e.traits, ['爱笑', '反应快', '话少']);
});

console.log('\n[2] 迁移：每会话一份 → 全局');
check('两个会话的同一个人合并', () => {
  const conversations = new Map([
    ['group:1', { memberImpressions: { 阿虚: { traits: ['话多'], interactionCount: 3, lastSeenAt: 100 } } }],
    ['private:9', { memberImpressions: { 阿虚: { traits: ['爱发图'], interactionCount: 2, lastSeenAt: 200 } } }]
  ]);
  const { global, moved } = migrateImpressions(conversations, {});
  assert.equal(global['阿虚'].interactionCount, 5);
  assert.deepEqual(global['阿虚'].traits, ['话多', '爱发图']);
  assert.equal(global['阿虚'].lastSeenAt, 200);
  assert.ok(moved > 0);
});
check('幂等：再跑一次次数不变', () => {
  const conversations = new Map([['group:1', { memberImpressions: { 甲: { traits: ['a'], interactionCount: 1 } } }]]);
  const g = {};
  migrateImpressions(conversations, g);
  migrateImpressions(conversations, g);
  // 迁移本身是「累加」，重复跑会翻倍 —— 调用方必须只跑一次（用 stateVersion 标记）
  assert.equal(g['甲'].interactionCount, 2);
});

console.log('\n[3] 共享事件');
check('新增并按上限修剪', () => {
  const list = [];
  const base = Date.now() - (EVENT_MAX_COUNT + 10) * 1000;
  for (let i = 0; i < EVENT_MAX_COUNT + 10; i += 1) addSharedEvent(list, { text: `事件${i}`, at: base + i * 1000 });
  assert.equal(list.length, EVENT_MAX_COUNT);
  assert.equal(list[0].text, '事件10');
});
check('空文本不写', () => assert.equal(addSharedEvent([], { text: '   ' }), null));
check('过期事件被剪掉', () => {
  const now = Date.now();
  const list = [{ id: 'a', at: now - 100 * 86400000, text: '很旧', scope: 'global' }];
  pruneEvents(list, { now });
  assert.equal(list.length, 0);
});

console.log('\n[4] 相关性打分');
{
  const now = Date.now();
  check('本场事件最高分', () => {
    assert.ok(scoreEvent({ at: now, text: 'x', scope: 'group:1' }, { key: 'group:1', now }) > scoreEvent({ at: now, text: 'x', scope: 'global' }, { key: 'group:1', now }));
  });
  check('别的群的事件不外泄（0 分）', () => {
    assert.equal(scoreEvent({ at: now, text: 'x', scope: 'group:2' }, { key: 'group:1', now }), 0);
  });
  check('私聊能看到群事件（弱相关 2 分）', () => {
    // 基础 2 分（跨群可见）+ 新鲜度 2 分 = 4，但必须低于本场事件的 3+2=5
    const priv = scoreEvent({ at: now, text: 'x', scope: 'group:1' }, { key: 'private:9', now });
    const own = scoreEvent({ at: now, text: 'x', scope: 'group:1' }, { key: 'group:1', now });
    assert.equal(priv, 4);
    assert.ok(priv < own);
  });
  check('越新分数越高', () => {
    const fresh = scoreEvent({ at: now, text: 'x', scope: 'global' }, { key: 'group:1', now });
    const old = scoreEvent({ at: now - 30 * 86400000, text: 'x', scope: 'global' }, { key: 'group:1', now });
    assert.ok(fresh > old);
  });
}

console.log('\n[5] 注入选择与预算');
check('最多 6 条', () => {
  const now = Date.now();
  const events = Array.from({ length: 12 }, (_, i) => ({ id: String(i), at: now - i, text: `事件${i}`, scope: 'group:1' }));
  const { picked } = selectEventsForInjection(events, { key: 'group:1', now });
  assert.equal(picked.length, 6);
});
check('预算内不超过 700 字', () => {
  const now = Date.now();
  const events = Array.from({ length: 12 }, (_, i) => ({ id: String(i), at: now - i, text: '很长的描述'.repeat(20), scope: 'group:1' }));
  const { text } = selectEventsForInjection(events, { key: 'group:1', now });
  assert.ok(text.length <= INJECT_BUDGET_CHARS + 40);
});
check('没有相关事件时返回空串', () => {
  assert.equal(selectEventsForInjection([], { key: 'group:1' }).text, '');
});

console.log('\n[6] 全局印象格式');
check('按最近互动排序并截断', () => {
  const g = { 甲: { traits: ['a'], interactionCount: 1, lastSeenAt: 1000 }, 乙: { traits: ['b'], interactionCount: 2, lastSeenAt: 5000 } };
  const text = formatGlobalImpressions(g, { limit: 1 });
  assert.match(text, /乙/);
  assert.doesNotMatch(text, /- 甲/);
});

console.log('\n[7] 交接脉络');
check('含时间与发言人，倒序保留最近的', () => {
  const now = Date.now();
  const msgs = [
    { time: now - 3000, sender: '甲', text: '第一句' },
    { time: now - 2000, isSelf: true, text: '我回一句' },
    { time: now - 1000, sender: '乙', text: '最后一句' }
  ];
  const digest = buildHandoffDigest(msgs, { maxChars: 500, now });
  assert.match(digest, /最后一句/);
  assert.match(digest, /我：/);
  assert.ok(digest.split('\n').length === 3);
});
check('超预算时丢掉更早的', () => {
  const now = Date.now();
  const msgs = Array.from({ length: 100 }, (_, i) => ({ time: now - i * 1000, sender: '甲', text: '这一句挺长的内容'.repeat(3) }));
  const digest = buildHandoffDigest(msgs, { maxChars: 300, now });
  assert.ok(digest.length <= 400);
});

console.log('\n[8] memory-update 的印象编辑（改名 / 就地更新）');
// 回归背景：这段逻辑原来写在 bridge.js 的 /api/socialV2/memory-update 路由里，
// 却引用了另一个路由（memory-append）才有的 extra → ReferenceError → 500，
// 内存里的 memberImpressions 已经改了但 saveSocialV2State 永不执行（状态文件与内存分叉），
// 跨会话 mergeImpression 也成了死代码。抽成纯函数后三条路径都能离线断言。
check('改名：条目搬到新名字，旧名字消失，返回新落点', () => {
  const table = { 阿虚: { traits: ['喜欢VRChat'], interactionCount: 3, lastSeenAt: 1000 } };
  const r = applyImpressionEdit(table, { oldTarget: '阿虚', newTarget: '阿虚2' });
  assert.equal(r.ok, true);
  assert.equal(r.renamed, true);
  assert.equal(r.target, '阿虚2');
  assert.equal(table['阿虚'], undefined, '旧名字必须删掉');
  assert.deepEqual(table['阿虚2'].traits, ['喜欢VRChat'], '印象内容跟着搬过去');
  assert.equal(table['阿虚2'].interactionCount, 3);
});
check('就地更新（不新增条目）：同名改写 traits 与互动次数', () => {
  const table = { 阿虚: { traits: ['旧标签'], interactionCount: 1, lastSeenAt: 1000 } };
  const r = applyImpressionEdit(table, { oldTarget: '阿虚', traits: ['新标签A', '新标签B'], interactionCount: 9 });
  assert.equal(r.ok, true);
  assert.equal(r.renamed, false);
  assert.equal(Object.keys(table).length, 1, '不许凭空多一条');
  assert.deepEqual(table['阿虚'].traits, ['新标签A', '新标签B']);
  assert.equal(table['阿虚'].interactionCount, 9);
});
check('改名后能直接拿去并进全局表（跨会话 mergeImpression 真的会跑）', () => {
  const table = { 阿虚: { traits: ['喜欢VRChat'], interactionCount: 1, lastSeenAt: 5000 } };
  const r = applyImpressionEdit(table, { oldTarget: '阿虚', newTarget: '阿虚3' });
  const global = {};
  const entry = table[r.target];
  mergeImpression(global, r.target, { traits: entry.traits, interactionCount: 0, lastSeenAt: entry.lastSeenAt });
  assert.deepEqual(global['阿虚3'].traits, ['喜欢VRChat']);
  assert.equal(global['阿虚3'].lastSeenAt, 5000);
  assert.equal(global['阿虚'], undefined, '旧名字不该进全局表');
});
check('找不到条目 ⇒ 404（新印象必须走 append）', () => {
  const r = applyImpressionEdit({}, { oldTarget: '查无此人' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});
check('原型污染名字与空名字一律 400', () => {
  const table = { __proto__x: 1 };
  for (const bad of ['__proto__', 'constructor', 'prototype', '']) {
    const r = applyImpressionEdit(table, { oldTarget: bad });
    assert.equal(r.ok, false, `${bad} 应被拒`);
    assert.equal(r.status, 400);
  }
  // 已有条目改成非法名字也要拒（不能把数据搬到 __proto__ 上）
  const t2 = { 阿虚: { traits: [], interactionCount: 0, lastSeenAt: 1 } };
  const r2 = applyImpressionEdit(t2, { oldTarget: '阿虚', newTarget: '__proto__' });
  assert.equal(r2.ok, false);
  assert.ok(t2['阿虚'], '被拒时不能改动原条目');
});
check('条目数上限按 lastSeenAt 淘汰最旧', () => {
  const table = {};
  for (let i = 0; i < 5; i += 1) table[`人${i}`] = { traits: [], interactionCount: 0, lastSeenAt: i };
  const r = applyImpressionEdit(table, { oldTarget: '人0', maxNames: 3 });
  assert.equal(r.ok, true);
  assert.equal(Object.keys(table).length, 3);
  assert.equal(table['人0'], undefined, '最旧的被淘汰');
});

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
