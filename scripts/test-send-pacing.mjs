// 发送节奏（防 QQ 风控 + 更像人）的单测：纯函数口径 + 时间片分配器的排序/等待，
// 再加几条「真的有接在发送链路上」的源码断言（接线掉了比算错更常见）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { planSendGap, pacingOptions, createPacingState, reserveSendSlot, PACING_DEFAULTS } from '../src/send-pacing.js';

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (error) { failures += 1; console.log(`  FAIL ${name} — ${error.message}`); }
}
function checkAsync(name, fn) {
  return fn().then(
    () => console.log(`  ok   ${name}`),
    (error) => { failures += 1; console.log(`  FAIL ${name} — ${error.message}`); }
  );
}
const source = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

console.log('## 1. 间隔怎么算（planSendGap）');
check('关掉开关就不排队', () => {
  assert.equal(planSendGap({ kind: 'text', chars: 900 }, { kind: 'text' }, { ...PACING_DEFAULTS, enabled: false }), 0);
});
check('第一条之后的文字：至少 minGapMs', () => {
  const gap = planSendGap({ kind: 'text', chars: 0 }, { kind: 'text' }, PACING_DEFAULTS);
  assert.equal(gap, PACING_DEFAULTS.minGapMs);
});
check('上一条字数越多，间隔越长', () => {
  const short = planSendGap({ kind: 'text', chars: 2 }, { kind: 'text' }, PACING_DEFAULTS);
  const long = planSendGap({ kind: 'text', chars: 30 }, { kind: 'text' }, PACING_DEFAULTS);
  assert.ok(long > short, `长消息应更慢：${short} vs ${long}`);
  assert.equal(long, PACING_DEFAULTS.minGapMs + PACING_DEFAULTS.perCharMs * 30);
});
check('字数再多也不超过 maxGapMs', () => {
  const gap = planSendGap({ kind: 'text', chars: 5000 }, { kind: 'text' }, PACING_DEFAULTS);
  assert.equal(gap, PACING_DEFAULTS.maxGapMs);
});
check('表情间隔短得多，也不看字数', () => {
  const gap = planSendGap({ kind: 'text', chars: 500 }, { kind: 'sticker' }, PACING_DEFAULTS);
  assert.equal(gap, PACING_DEFAULTS.stickerGapMs);
  assert.ok(gap < PACING_DEFAULTS.minGapMs);
});
check('语音前后都至少 voiceGapMs', () => {
  const before = planSendGap({ kind: 'text', chars: 1 }, { kind: 'voice' }, PACING_DEFAULTS);
  const after = planSendGap({ kind: 'voice', chars: 0 }, { kind: 'text' }, PACING_DEFAULTS);
  assert.ok(before >= PACING_DEFAULTS.voiceGapMs, `发语音前：${before}`);
  assert.ok(after >= PACING_DEFAULTS.voiceGapMs, `语音后：${after}`);
});
check('图片至少 imageGapMs', () => {
  assert.ok(planSendGap({ kind: 'text', chars: 0 }, { kind: 'image' }, PACING_DEFAULTS) >= PACING_DEFAULTS.imageGapMs);
});

console.log('\n## 2. 参数读取（pacingOptions）');
check('没有配置时用默认值', () => {
  const o = pacingOptions({});
  assert.equal(o.minGapMs, PACING_DEFAULTS.minGapMs);
  assert.equal(o.enabled, true);
});
check('从 socialV2.pacing 读，也接受直接给那段', () => {
  assert.equal(pacingOptions({ socialV2: { pacing: { minGapMs: 2000 } } }).minGapMs, 2000);
  assert.equal(pacingOptions({ pacing: { minGapMs: 2500 } }).minGapMs, 2500);
});
check('负数和离谱的大数会被夹住', () => {
  const o = pacingOptions({ pacing: { minGapMs: -5, perCharMs: 999999, maxGapMs: 10 } });
  assert.equal(o.minGapMs, 0);
  assert.ok(o.perCharMs <= 5000);
  assert.ok(o.maxGapMs >= 0);
});
check('enabled:false 能关掉', () => {
  assert.equal(pacingOptions({ pacing: { enabled: false } }).enabled, false);
});

console.log('\n## 3. 时间片分配器（reserveSendSlot）');
const makeCtx = (overrides = {}) => {
  let clock = 1_000_000; // 非 0 起点：pacer 用 last.at 的真值判断「是不是第一条」

  const slept = [];
  const ctx = {
    state: createPacingState(),
    cfg: { pacing: { minGapMs: 1000, perCharMs: 100, maxGapMs: 5000, voiceGapMs: 3000, stickerGapMs: 200, imageGapMs: 500, jitterMs: 0 } },
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    log: () => {},
    now: () => clock,
    ...overrides
  };
  return { ctx, slept, clock: () => clock };
};
await checkAsync('第一条不等，第二条按上一条字数等', async () => {
  const { ctx, slept } = makeCtx();
  await reserveSendSlot(ctx, 'text', 'hi');
  assert.equal(slept.length, 0, '第一条不该等');
  await reserveSendSlot(ctx, 'text', 'ok');
  assert.equal(slept.length, 1);
  assert.equal(slept[0], 1000 + 100 * 2, `上一条 2 个字，应等 1200ms，实际 ${slept[0]}`);
});
await checkAsync('连发多条是串行的，顺序不乱', async () => {
  const { ctx, slept } = makeCtx();
  const order = [];
  const p1 = reserveSendSlot(ctx, 'text', 'a').then(() => order.push(1));
  const p2 = reserveSendSlot(ctx, 'sticker', '').then(() => order.push(2));
  const p3 = reserveSendSlot(ctx, 'text', 'b').then(() => order.push(3));
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(slept.length, 2, '第二、三条各等一次');
});
await checkAsync('等的时候用 sleep，不用忙等', async () => {
  const { ctx, slept } = makeCtx();
  await reserveSendSlot(ctx, 'text', 'x');
  await reserveSendSlot(ctx, 'voice', '');
  assert.ok(slept[0] >= 3000, `语音前应至少 3000ms，实际 ${slept[0]}`);
});
await checkAsync('上一次等待失败，队列不能断', async () => {
  const { ctx } = makeCtx();
  await reserveSendSlot(ctx, 'text', 'prime'); // 先发一条，第二条才会真的进入等待
  ctx.sleep = async () => { throw new Error('boom'); };
  await assert.rejects(reserveSendSlot(ctx, 'text', 'a'));
  await assert.rejects(reserveSendSlot(ctx, 'text', 'b'));
  ctx.sleep = async () => {};
  await reserveSendSlot(ctx, 'text', 'c'); // 还能继续排
});
await checkAsync('抖动只加不减（不会比下限更快）', async () => {
  const { ctx, slept } = makeCtx({ random: () => 0.99 });
  ctx.cfg.pacing.jitterMs = 300;
  await reserveSendSlot(ctx, 'text', 'a');
  await reserveSendSlot(ctx, 'text', 'a');
  assert.ok(slept[0] >= 1000 + 100, `应 ≥1100ms，实际 ${slept[0]}`);
  assert.ok(slept[0] <= 1000 + 100 + 300);
});

console.log('\n## 4. 真的接在发送链路上（源码断言）');
const outboundText = source('../src/bridge/outbound-text.js');
const mediaSend = source('../src/bridge/media-send.js');
const voice = source('../src/bridge/voice.js');
const boot = source('../src/bridge/boot/console-send.js');
const bridge = source('../src/bridge.js');
const configLoad = source('../src/bridge/config-load.js');
check('文字发送（sendToQQ）先领时间片', () => {
  assert.ok(outboundText.includes("await (0, deps.reserveSendSlot)('text', part);"), 'sendToQQ 没接节奏');
});
check('onebotSend（临时会话/兜底）也领时间片', () => {
  assert.ok(outboundText.includes("await (0, deps.reserveSendSlot)('text', rawMessage);"));
});
check('表情用 sticker 档、图片用 image 档', () => {
  assert.ok(mediaSend.includes("await (0, deps.reserveSendSlot)('sticker', '');"));
  assert.ok(mediaSend.includes("await (0, deps.reserveSendSlot)('image', '');"));
});
check('语音用 voice 档', () => {
  assert.ok(voice.includes("await (0, deps.reserveSendSlot)('voice', '');"));
});
check('表情/图片原来固定 800~2000ms 的停顿已交给节奏表', () => {
  assert.ok(!mediaSend.includes('randInt)(800, 2000)'), '旧的固定停顿还在，会叠加成两倍等待');
});
check('boot 阶段持有全局唯一的时间片状态', () => {
  assert.ok(boot.includes('const pacingState = deps.makePacingState();'));
  assert.ok(boot.includes('get reserveSendSlot() { return reserveSendSlotFor; }'));
});
check('bridge.js 把节奏函数注入绑定', () => {
  assert.ok(bridge.includes('import { createPacingState as makePacingState'));
  assert.ok(bridge.includes('get reserveSendSlot() { return states.stConsoleSend.reserveSendSlot; }'));
});
check('config-load 有 pacing 默认值', () => {
  assert.ok(configLoad.includes('pacing: {'));
  for (const key of ['minGapMs', 'perCharMs', 'maxGapMs', 'voiceGapMs', 'stickerGapMs', 'imageGapMs']) {
    assert.ok(configLoad.includes(`${key}:`), `缺默认值 ${key}`);
  }
});

// ── 设置页「发送节奏」：能手动改，且每格都写着推荐值 ──────────────────────
check('设置页有「发送节奏」分组与面板', () => {
  const usage = source('../client/04-usage.js');
  const settings = source('../client/05-settings.js');
  assert.ok(usage.includes("{ id: 'pacing', name: '发送节奏' },"));
  assert.ok(usage.includes("if (settingsState.group === 'pacing') return settingsPacingHtml();"));
  assert.ok(settings.includes('function settingsPacingHtml()'));
});
check('七个参数都有输入框、都标了推荐值', () => {
  const settings = source('../client/05-settings.js');
  assert.ok(settings.includes('PACING_FIELDS'), '缺字段表');
  for (const key of ['minGapMs', 'perCharMs', 'maxGapMs', 'jitterMs', 'voiceGapMs', 'stickerGapMs', 'imageGapMs']) {
    assert.ok(settings.includes("key: '" + key + "'"), '缺字段 ' + key);
}
  assert.ok(settings.includes('（推荐 '), '推荐值必须显示在界面上');
});
check('数字输入框不能带千分位（type=number 会判非法直接清空）', () => {
  const settings = source('../client/05-settings.js');
  assert.ok(settings.includes('String(val)'), 'value 要用 String(val)');
});
check('保存只写 socialV2.pacing 的叶子路径（不整段覆盖）', () => {
  const settings = source('../client/05-settings.js');
  assert.ok(settings.includes("'socialV2.pacing.enabled'"));
  assert.ok(settings.includes("'socialV2.pacing.' + PACING_FIELDS[i].key"));
  assert.ok(settings.includes("apiWrite('/api/config', { patch: patch })"));
});
check('前端自校验：数字范围 + 上限不能小于下限', () => {
  const settings = source('../client/05-settings.js');
  assert.ok(settings.includes('function readPacingForm()'));
  assert.ok(settings.includes('要填数字'));
  assert.ok(settings.includes('不能比「两条之间至少隔」还小'));
});
check('「填回推荐值」只改表单不写盘', () => {
  const settings = source('../client/05-settings.js');
  assert.ok(settings.includes('function fillRecommendedPacing()'));
  const from = settings.indexOf('function fillRecommendedPacing()');
  const to = settings.indexOf('function updatePacingPreview()');
  const body = settings.slice(from, to);
  assert.ok(!body.includes('apiWrite('), '推荐值按钮不该自己写盘');
  assert.ok(body.includes('toast('), '要告诉用户「还没保存」');
});
check('实时预览把毫秒翻成人能读的秒', () => {
  const settings = source('../client/05-settings.js');
  assert.ok(settings.includes('function pacingPreviewText(p, chars)'));
  assert.ok(settings.includes('function updatePacingPreview()'));
  assert.ok(settings.includes("' 秒（'"), '预览要给秒数');
  assert.ok(settings.includes('id="pacePreview"'), '缺预览容器');
});
check('写操作表挂了保存/填推荐两个入口', () => {
  const shell = source('../client/01-shell.js');
  assert.ok(shell.includes("'pacing-save': function"));
  assert.ok(shell.includes("'pacing-reset': function"));
});
check('网格样式压得过 .qdb-set-row 的 flex', () => {
  const css = source('../public/client.css');
  assert.ok(css.includes('.qdb-set-row.qdb-set-row-grid'), '同权重会被后面的 .qdb-set-row{display:flex} 盖掉');
  assert.ok(css.includes('repeat(auto-fill, minmax(228px, 1fr))'));
});

if (failures) { console.log(`\n❌ 失败 ${failures} 条`); process.exit(1); }
console.log('\n🎉 test-send-pacing 全部通过');
