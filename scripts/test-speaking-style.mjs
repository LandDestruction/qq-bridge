// 发言风格块：把「负责回复的人」换成「可以插话、也可以不说话的群成员」。
// 这里只测文本契约（开关、必须出现的收尾路径、必须消失的旧指令），不测模型行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPEAKING_STYLE_DEFAULTS, composeSpeakingStyle, createSpeakingStyle, normalizeSpeakingStyle } from '../src/bridge/speaking-style.js';

test('默认开启：身份、参与规则、收尾路径都在', () => {
  const text = composeSpeakingStyle(SPEAKING_STYLE_DEFAULTS);
  assert.match(text, /群里的一个成员，不是客服/);
  assert.match(text, /可以插话，也可以不说话/);
  assert.match(text, /qq_mark_read/);
  assert.match(text, /每轮只接一个点/);
  assert.match(text, /不自动补安慰/);
});

test('旧指令「不要习惯性潜水」必须不再出现（否则模型会继续硬憋一句）', () => {
  const text = composeSpeakingStyle(SPEAKING_STYLE_DEFAULTS);
  assert.equal(text.includes('不要习惯性潜水'), false);
  assert.equal(text.includes('主动参与'), false);
});

test('例子是「完整片段」而不是口头禅', () => {
  const text = composeSpeakingStyle(SPEAKING_STYLE_DEFAULTS);
  assert.match(text, /你那一把还没打完啊/);
  assert.match(text, /这轮不用接/);
  assert.match(text, /别急着上安慰＋分析＋建议/);
});

test('examples=false 只剩规则（省 prompt）', () => {
  const text = composeSpeakingStyle({ enabled: true, examples: false });
  assert.match(text, /可以插话/);
  assert.equal(text.includes('你那一把还没打完啊'), false);
  assert.equal(text.includes('接住一个点'), false);
});

test('enabled=false 整块为空（回到旧文案的路径）', () => {
  assert.equal(composeSpeakingStyle({ enabled: false }), '');
  assert.equal(composeSpeakingStyle(null).length > 0, true);
});

test('normalizeSpeakingStyle 收敛脏值', () => {
  assert.deepEqual(normalizeSpeakingStyle(undefined), { enabled: true, examples: true, brevity: true });
  assert.equal(normalizeSpeakingStyle({ enabled: 'false' }).enabled, true); // 只有显式 false 才关
  assert.equal(normalizeSpeakingStyle({ enabled: false }).enabled, false);
  assert.equal(normalizeSpeakingStyle([]).enabled, true);
});

test('createSpeakingStyle 惰性读配置，未配置时按默认开', () => {
  const watch = createSpeakingStyle({ cfg: { socialV2: {} } });
  assert.match(watch.block(), /可以插话/);
  const off = createSpeakingStyle({ cfg: { socialV2: { style: { enabled: false } } } });
  assert.equal(off.block(), '');
  // 配置里没有 socialV2 也不能炸（首启、热加载中途）
  assert.match(createSpeakingStyle({ cfg: {} }).block(), /可以插话/);
});
