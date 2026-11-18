// 观察学习白名单的单测：语义是「只看不说」，所以断言集中在「绝不回复」。
import assert from 'node:assert/strict';
import {
  normalizeObserveConfig,
  isObserveGroup,
  decideGroupEvent,
  describeObserveConfig,
  describeObserveStickerSegments,
  planObserveLearning,
  applyObserveLearning
} from '../src/observe-learn.js';
import { collectSticker } from '../src/sticker-lib.js';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); }
  catch (error) { failed += 1; console.error(`❌ ${name} — ${error?.message ?? error}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log(`✅ ${name}`); }
  catch (error) { failed += 1; console.error(`❌ ${name} — ${error?.message ?? error}`); }
}

check('配置：默认关闭、空白名单、学习项默认开', () => {
  const cfg = normalizeObserveConfig(undefined);
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.groups, []);
  assert.equal(cfg.learnSlang, true);
  assert.equal(cfg.learnStickers, true);
});

check('配置：非法项收敛（去重、非数字丢弃、learn 可关）', () => {
  const cfg = normalizeObserveConfig({
    enabled: true,
    groups: ['100000001', 100000001, 'abc', ' x '],
    learnStickers: false
  });
  assert.deepEqual(cfg.groups, ['100000001']);
  assert.equal(cfg.learnSlang, true);
  assert.equal(cfg.learnStickers, false);
});

check('白名单判定：数字/字符串群号都能命中；enabled=false 一律不命中', () => {
  const on = normalizeObserveConfig({ enabled: true, groups: ['100000001'] });
  assert.equal(isObserveGroup(on, '100000001'), true);
  assert.equal(isObserveGroup(on, 100000001), true);
  assert.equal(isObserveGroup(on, '111'), false);
  const off = normalizeObserveConfig({ enabled: false, groups: ['100000001'] });
  assert.equal(isObserveGroup(off, '100000001'), false);
});

check('分流：观察群永远 reply=false（即使同时在 allow.groups、即使被 @）', () => {
  const d = decideGroupEvent({ isObserve: true, isAllowListed: true, mentionsBot: true });
  assert.equal(d.observe, true);
  assert.equal(d.reply, false, '观察优先：命中允许回复白名单也不回');
  assert.match(d.reason, /只看不说/);
});

check('分流：观察群仍然学习（词汇/表情被调用），且可单独关掉某一项', () => {
  const d = decideGroupEvent({ isObserve: true, learnSlang: true, learnStickers: true });
  assert.equal(d.learnSlang, true);
  assert.equal(d.learnStickers, true);
  const onlySlang = decideGroupEvent({ isObserve: true, learnStickers: false });
  assert.equal(onlySlang.learnSlang, true);
  assert.equal(onlySlang.learnStickers, false);
});

check('分流：非观察群按原白名单语义，不受影响', () => {
  const allowed = decideGroupEvent({ isObserve: false, isAllowListed: true });
  assert.equal(allowed.observe, false);
  assert.equal(allowed.reply, true);
  const notAllowed = decideGroupEvent({ isObserve: false, isAllowListed: false });
  assert.equal(notAllowed.reply, false);
});

check('计划：观察群的文本与表情候选被列出；非观察群/无关消息返回 null', () => {
  const cfg = normalizeObserveConfig({ enabled: true, groups: ['100000001'] });
  const event = {
    group_id: 100000001,
    user_id: 123456,
    sender: { card: '小明', nickname: '小明' },
    message: [
      { type: 'text', data: { text: '这个玩法 绝绝子' } },
      { type: 'image', data: { url: 'https://public.invalid/a.png', file: '0123456789abcdef0123456789abcdef' } },
      { type: 'face', data: { url: 'https://public.invalid/b.gif', file: '不是md5' } },
      { type: 'at', data: { qq: '999' } }
    ]
  };
  const plan = planObserveLearning(event, cfg);
  assert.equal(plan.groupId, '100000001');
  assert.equal(plan.key, 'group:100000001');
  assert.equal(plan.sender, '小明');
  assert.equal(plan.text, '这个玩法 绝绝子');
  assert.equal(plan.learnSlang, true);
  assert.equal(plan.learnStickers, true);
  assert.equal(plan.stickers.length, 2);
  assert.equal(plan.stickers[0].md5, '0123456789abcdef0123456789abcdef', '32 位 hex 的 file 当 md5');
  assert.equal(plan.stickers[1].md5, '', '文件名不是 md5 时不能当摘要');

  assert.equal(planObserveLearning({ group_id: 111, message: [] }, cfg), null, '非观察群必须返回 null');
  const off = normalizeObserveConfig({ enabled: false, groups: ['100000001'] });
  assert.equal(planObserveLearning(event, off), null, 'enabled=false 时不算观察群');
});

await checkAsync('执行：注入假实现 → 学习被调用；全程没有任何「发送」动作', async () => {
  const cfg = normalizeObserveConfig({ enabled: true, groups: ['100000001'] });
  const event = {
    group_id: 100000001,
    user_id: 123456,
    sender: { nickname: '小红' },
    message: [
      { type: 'text', data: { text: '草 笑死' } },
      { type: 'image', data: { url: 'https://public.invalid/c.png' } }
    ]
  };
  const plan = planObserveLearning(event, cfg);
  const calls = { slang: [], stickers: [], saved: 0, send: 0 };
  const applied = await applyObserveLearning(plan, {
    feedSlang: (key, sender, text) => calls.slang.push({ key, sender, text }),
    collectSticker: (sticker) => { calls.stickers.push(sticker); return { id: 'c_1' }; },
    onStickersSaved: (n) => { calls.saved += n; },
    // 故意提供一个发送 hook：实现里根本不会调它，用来证明「观察群不发消息」。
    sendMessage: () => { calls.send += 1; }
  });
  assert.equal(applied.slang, true);
  assert.equal(applied.stickers, 1);
  assert.deepEqual(calls.slang, [{ key: 'group:100000001', sender: '小红', text: '草 笑死' }]);
  assert.equal(calls.stickers.length, 1);
  assert.equal(calls.saved, 1);
  assert.equal(calls.send, 0, '观察群绝不能调用发送');
});

await checkAsync('执行：学习项被关掉时对应 hook 一次都不调用', async () => {
  const cfg = normalizeObserveConfig({ enabled: true, groups: ['100000001'], learnSlang: false, learnStickers: false });
  const plan = planObserveLearning({
    group_id: 100000001,
    sender: { nickname: 'x' },
    message: [{ type: 'text', data: { text: 'hi' } }, { type: 'image', data: { url: 'https://public.invalid/d.png' } }]
  }, cfg);
  let called = 0;
  const applied = await applyObserveLearning(plan, {
    feedSlang: () => { called += 1; },
    collectSticker: () => { called += 1; return {}; },
    onStickersSaved: () => { called += 1; }
  });
  assert.deepEqual(applied, { slang: false, stickers: 0 });
  assert.equal(called, 0);
});

check('启动日志：说清「只学习不发言」，空名单不假装生效', () => {
  assert.equal(describeObserveConfig({ enabled: false, groups: ['1'] }), null);
  const empty = describeObserveConfig(normalizeObserveConfig({ enabled: true, groups: [] }));
  assert.match(empty, /groups 为空/);
  const line = describeObserveConfig(normalizeObserveConfig({ enabled: true, groups: ['100000001'] }));
  assert.match(line, /100000001/);
  assert.match(line, /不会唤醒\/回复\/发消息/);
  const noLearn = describeObserveConfig(normalizeObserveConfig({
    enabled: true, groups: ['100000001'], learnSlang: false, learnStickers: false
  }));
  assert.match(noLearn, /学习项都已关闭/);
});

// 实测形态：QQ 表情在网关里常常没有 url —— image 段只有 file，face 段只有 id。
// 这两种都必须进「计划」，由执行器走 get_image 兜底；拿不到时也要留日志。
check('计划：没有 url 的 image/face 段也要进学习计划（不能只认 url）', () => {
  const cfg = normalizeObserveConfig({ enabled: true, groups: ['100000005'] });
  const plan = planObserveLearning({
    group_id: 100000005,
    sender: { nickname: '甲' },
    message: [
      { type: 'text', data: { text: '哈哈哈' } },
      { type: 'image', data: { file: 'A1B2C3D4E5F60718293A4B5C6D7E8F90' } },
      { type: 'face', data: { id: '13' } },
      { type: 'mface', data: { file: 'not-a-md5-key', url: '' } }
    ]
  }, cfg);
  assert.equal(plan.stickers.length, 3);
  assert.equal(plan.stickers[0].md5, 'a1b2c3d4e5f60718293a4b5c6d7e8f90', '32 位 hex 的 file 当 md5');
  assert.equal(plan.stickers[0].url, '');
  assert.equal(plan.stickers[1].faceId, '13');
  assert.equal(plan.stickers[2].file, 'not-a-md5-key');
  assert.equal(plan.learnStickers, true);
});

await checkAsync('执行：无 url 的段会交给 hook（异步）兜底；hook 拿不到时记为未收集', async () => {
  const cfg = normalizeObserveConfig({ enabled: true, groups: ['100000005'] });
  const plan = planObserveLearning({
    group_id: 100000005,
    sender: { nickname: '乙' },
    message: [{ type: 'image', data: { file: 'deadbeef' } }, { type: 'face', data: { id: '4' } }]
  }, cfg);
  const seen = [];
  const applied = await applyObserveLearning(plan, {
    feedSlang: () => {},
    // 模拟「网关也拿不到字节」：返回 null
    collectSticker: async (sticker) => { seen.push({ file: sticker.file, faceId: sticker.faceId }); return null; },
    onStickersSaved: () => { throw new Error('没有收集成功时不应落盘'); }
  });
  assert.deepEqual(seen, [{ file: 'deadbeef', faceId: '' }, { file: '', faceId: '4' }]);
  assert.deepEqual(applied, { slang: false, stickers: 0 });
});

check('sticker-lib：观察群来源保留在 source（便于按 source 验收查询）', () => {
  const entries = [];
  const entry = collectSticker(entries, {
    md5: 'a'.repeat(32),
    source: '观察群 100000005',
    collectedBy: '丙',
    context: '哈哈哈'
  });
  assert.ok(entry);
  assert.equal(entry.source, '观察群 100000005');
  assert.equal(entry.collectedFrom, '观察群 100000005');
  assert.equal(entry.policy, 'understand-only', '只理解、不自动发出去');
  // 普通来源仍然归一成 qq
  const plain = collectSticker(entries, { md5: 'b'.repeat(32), source: 'group:1' });
  assert.equal(plain.source, 'qq');
});

check('诊断：段形态只给 type/有无 url/file 前缀，不含完整 url', () => {
  const shapes = describeObserveStickerSegments({
    message: [
      { type: 'image', data: { url: 'https://x.invalid/a?rkey=SECRET', file: 'ABCDEF0123456789ABCDEF0123456789' } },
      { type: 'face', data: { id: '13' } },
      { type: 'text', data: { text: 'hi' } }
    ]
  });
  assert.equal(shapes.length, 2);
  assert.deepEqual(shapes[0], {
    type: 'image', hasUrl: true, hasFile: true, filePrefix: 'ABCDEF0123456789ABCDEF0123456789', faceId: ''
  });
  assert.equal(shapes[1].type, 'face');
  assert.equal(shapes[1].hasUrl, false);
  const json = JSON.stringify(shapes);
  assert.equal(json.includes('SECRET'), false, '诊断里不能出现完整 url');
});

if (failed) {
  console.error(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n🎉 test-observe-learn 全部通过');
