// 人设 prompt 拼装（src/persona-prompt.js）单测：纯函数，不需要桥接/网络/磁盘。
// 跑法：node scripts/test-persona-prompt.mjs
import assert from 'node:assert/strict';
import {
  PERSONA_DEFAULTS,
  PERSONA_LIMITS,
  PERSONA_SECTION_IDS,
  normalizePersonaConfig,
  describeWakeRules,
  buildPersonaSections,
  mergePersonaLayers,
  describePersonaPlan
} from '../src/persona-prompt.js';

let failed = 0;
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('✅ ' + name);
  } catch (error) {
    failed += 1;
    console.error('❌ ' + name);
    console.error('   ' + (error?.message ?? error));
  }
}
const cpLen = (value) => Array.from(String(value ?? '')).length;
const baseCfg = () => ({
  socialV2: {
    turnMaxSteps: 12,
    proactive: { enabled: true, probability: 0.3, idleThresholdMs: 900000 },
    wake: {
      recommendedAtMention: true,
      recommendedNameMention: true,
      recommendedKeywords: ['小鲸鱼', '鲸鱼', 'DeepSeek'],
      recommendedProbability: 0.05
    }
  }
});

// ── 默认值与常量 ───────────────────────────────────────────────────────────
check('默认人设名是「大肥鱼小姐」', () => {
  assert.equal(PERSONA_DEFAULTS.name, '大肥鱼小姐');
});
check('长度上限冻结且总上限 4000', () => {
  assert.ok(Object.isFrozen(PERSONA_LIMITS));
  assert.equal(PERSONA_LIMITS.total, 4000);
  assert.equal(PERSONA_LIMITS.rules, 20);
  assert.equal(PERSONA_LIMITS.rule, 200);
});
check('段落顺序固定为 6 段', () => {
  assert.deepEqual(PERSONA_SECTION_IDS, ['identity', 'tone', 'rules', 'wake', 'capabilities', 'extra']);
});
check('空配置也能拼出 prompt（含名字与规则）', () => {
  const built = buildPersonaSections({});
  assert.ok(built.chars > 200);
  assert.match(built.text, /大肥鱼小姐/);
  assert.match(built.text, /必须遵守/);
  assert.deepEqual(built.sections.map((s) => s.id), ['identity', 'tone', 'rules', 'wake', 'capabilities']);
});
check('默认配置没有任何 warning', () => {
  assert.deepEqual(buildPersonaSections({}).warnings, []);
});
check('normalizePersonaConfig({}) 回默认且不改默认对象', () => {
  const norm = normalizePersonaConfig({});
  assert.equal(norm.name, PERSONA_DEFAULTS.name);
  assert.ok(norm.rules.length >= 6);
  assert.equal(PERSONA_DEFAULTS.extra, '');
});

// ── 归一与越界裁剪 ─────────────────────────────────────────────────────────
check('name 超 40 字被截断并记 warning', () => {
  const norm = normalizePersonaConfig({ socialV2: { persona: { name: '鱼'.repeat(60) } } });
  assert.equal(cpLen(norm.name), PERSONA_LIMITS.name);
  assert.ok(norm.warnings.some((w) => w.includes('name 超长')));
});
check('selfDesc 超 400 字被截断并记 warning', () => {
  const norm = normalizePersonaConfig({ socialV2: { persona: { selfDesc: '鲸'.repeat(500) } } });
  assert.equal(cpLen(norm.selfDesc), PERSONA_LIMITS.selfDesc);
  assert.ok(norm.warnings.some((w) => w.includes('selfDesc 超长')));
});
check('tone 超 200 字被截断并记 warning', () => {
  const norm = normalizePersonaConfig({ socialV2: { persona: { tone: '话'.repeat(300) } } });
  assert.equal(cpLen(norm.tone), PERSONA_LIMITS.tone);
  assert.ok(norm.warnings.some((w) => w.includes('tone 超长')));
});
check('rules 超过 20 条只留 20 条并记 warning', () => {
  const rules = Array.from({ length: 25 }, (_, i) => `规则 ${i + 1}`);
  const norm = normalizePersonaConfig({ socialV2: { persona: { rules } } });
  assert.equal(norm.rules.length, 20);
  assert.ok(norm.warnings.some((w) => w.includes('rules 超过')));
});
check('单条规则超 200 字被截断', () => {
  const norm = normalizePersonaConfig({ socialV2: { persona: { rules: ['规'.repeat(400)] } } });
  assert.equal(cpLen(norm.rules[0]), PERSONA_LIMITS.rule);
});
check('rules 不是数组 → 回退内置规则并记 warning', () => {
  const norm = normalizePersonaConfig({ socialV2: { persona: { rules: '一条规则' } } });
  assert.deepEqual(norm.rules, [...PERSONA_DEFAULTS.rules]);
  assert.ok(norm.warnings.some((w) => w.includes('rules 不是数组')));
});
check('rules 全是空文本 → 回退内置规则并记 warning', () => {
  const norm = normalizePersonaConfig({ socialV2: { persona: { rules: ['', '   '] } } });
  assert.deepEqual(norm.rules, [...PERSONA_DEFAULTS.rules]);
  assert.ok(norm.warnings.some((w) => w.includes('全是空文本')));
});
check('extra 不是字符串 → 置空并记 warning', () => {
  const norm = normalizePersonaConfig({ socialV2: { persona: { extra: { a: 1 } } } });
  assert.equal(norm.extra, '');
  assert.ok(norm.warnings.some((w) => w.includes('extra 不是字符串')));
});
check('persona 不是对象 → 回默认人设并记 warning', () => {
  const norm = normalizePersonaConfig({ socialV2: { persona: '傲娇一点' } });
  assert.equal(norm.name, PERSONA_DEFAULTS.name);
  assert.ok(norm.warnings.some((w) => w.includes('不是对象')));
});
check('空字符串字段不会覆盖默认值', () => {
  const norm = normalizePersonaConfig({ socialV2: { persona: { name: '  ', tone: '' } } });
  assert.equal(norm.name, PERSONA_DEFAULTS.name);
  assert.equal(norm.tone, PERSONA_DEFAULTS.tone);
});
check('extra 超 2000 字被截断并记 warning', () => {
  const norm = normalizePersonaConfig({ socialV2: { persona: { extra: '补'.repeat(2500) } } });
  assert.equal(cpLen(norm.extra), PERSONA_LIMITS.extra);
  assert.ok(norm.warnings.some((w) => w.includes('extra 超长')));
});

// ── 能力行：没有的能力不许写 ───────────────────────────────────────────────
check('只有画图能力时只提 qq_draw，不提表情与联网', () => {
  const text = buildPersonaSections({}, { capabilities: { draw: true } }).text;
  assert.match(text, /qq_draw/);
  assert.ok(!text.includes('qq_send_sticker'));
  assert.ok(!text.includes('web_search'));
});
check('只有表情能力时只提表情工具', () => {
  const text = buildPersonaSections({}, { capabilities: { sticker: true } }).text;
  assert.match(text, /qq_send_sticker/);
  assert.ok(!text.includes('qq_draw'));
  assert.ok(!text.includes('web_search'));
});
check('只有联网能力时只提 web_search', () => {
  const text = buildPersonaSections({}, { capabilities: { search: true } }).text;
  assert.match(text, /web_search/);
  assert.ok(!text.includes('qq_draw'));
});
check('一个能力都没有时明确「以工具表为准」且不提具体工具', () => {
  const text = buildPersonaSections({}, { capabilities: {} }).text;
  assert.match(text, /工具表为准/);
  assert.ok(!text.includes('qq_draw'));
  assert.ok(!text.includes('qq_send_sticker'));
  assert.ok(!text.includes('web_search'));
});
check('三种能力都给时三句都在', () => {
  const text = buildPersonaSections({}, { capabilities: { draw: true, sticker: true, search: true } }).text;
  assert.match(text, /qq_draw/);
  assert.match(text, /qq_send_sticker/);
  assert.match(text, /web_search/);
});

// ── 频道差异 ───────────────────────────────────────────────────────────────
check('channel=group 时说明是群聊', () => {
  const built = buildPersonaSections({}, { channel: 'group' });
  assert.match(built.text, /群聊/);
  assert.equal(built.channel, 'group');
});
check('channel=private 时说明是私聊', () => {
  const built = buildPersonaSections({}, { channel: 'private' });
  assert.match(built.text, /私聊/);
  assert.equal(built.channel, 'private');
});
check('非法 channel 回落 group', () => {
  assert.equal(buildPersonaSections({}, { channel: 'weird' }).channel, 'group');
});

// ── 唤醒规则 ───────────────────────────────────────────────────────────────
check('空配置的唤醒规则全为 null 且给默认句', () => {
  const wake = describeWakeRules({});
  assert.equal(wake.atMention, null);
  assert.equal(wake.keywords, null);
  assert.equal(wake.probability, null);
  assert.equal(wake.turnMaxSteps, null);
  assert.equal(wake.proactive, null);
  assert.match(wake.text, /被 @/);
});
check('@ 与名字唤醒写进人话', () => {
  const wake = describeWakeRules({ socialV2: { wake: { recommendedAtMention: true, recommendedNameMention: true } } });
  assert.match(wake.text, /被 @ 时醒来/);
  assert.match(wake.text, /名字/);
});
check('关键词写进人话（最多展示 5 个）', () => {
  const wake = describeWakeRules(baseCfg());
  assert.match(wake.text, /小鲸鱼/);
  assert.ok(wake.keywords.length === 3);
});
check('普通消息概率换算成百分比', () => {
  assert.match(describeWakeRules(baseCfg()).text, /5%/);
});
check('指定群友发言唤醒写成「额外留意 N 位」', () => {
  const wake = describeWakeRules({ socialV2: { wake: { speakerIds: ['111', '222'] } } });
  assert.match(wake.text, /额外留意 2 位/);
});
check('activeHours 窗口写成「A-B 更活跃」', () => {
  const wake = describeWakeRules({ socialV2: { wake: { activeHours: [{ start: '22:00', end: '01:00' }] } } });
  assert.deepEqual(wake.activeHours, [{ start: '22:00', end: '01:00' }]);
  assert.match(wake.text, /22:00-01:00 更活跃/);
});
check('turnMaxSteps 写进人话', () => {
  assert.match(describeWakeRules(baseCfg()).text, /最多想 12 步/);
});
check('proactive 开启时写「会自己找话说」并带空闲分钟与概率', () => {
  const text = describeWakeRules(baseCfg()).text;
  assert.match(text, /会自己找话说/);
  assert.match(text, /15 分钟/);
  assert.match(text, /30%/);
});
check('唤醒文案硬上限 300 码点（塞满关键词也不超）', () => {
  const keywords = Array.from({ length: 8 }, (_, i) => `关键词${i}${'长'.repeat(20)}`);
  const wake = describeWakeRules({ socialV2: { wake: { recommendedKeywords: keywords, recommendedProbability: 0.05, speakerIds: ['1', '2', '3'] } } });
  assert.ok(cpLen(wake.text) <= PERSONA_LIMITS.wakeText, `实际 ${cpLen(wake.text)} 字`);
});

// ── 总长 4000 与裁剪顺序 ───────────────────────────────────────────────────
check('正常配置总长不超过 4000', () => {
  assert.ok(buildPersonaSections(baseCfg()).chars <= PERSONA_LIMITS.total);
});
check('超限先裁 extra 段并记 warning', () => {
  const cfg = { socialV2: { persona: { extra: '补'.repeat(3000), rules: Array.from({ length: 20 }, () => '规'.repeat(200)) } } };
  const built = buildPersonaSections(cfg);
  assert.ok(built.chars <= PERSONA_LIMITS.total);
  assert.ok(!built.sections.some((s) => s.id === 'extra'));
  assert.ok(built.warnings.some((w) => w.includes('补充设定')));
});
check('没有 extra 时截断 tone 段并记 warning', () => {
  const cfg = { socialV2: { persona: { selfDesc: '鲸'.repeat(400), tone: '话'.repeat(200), rules: Array.from({ length: 20 }, () => '规'.repeat(200)) } } };
  const built = buildPersonaSections(cfg);
  assert.ok(built.chars <= PERSONA_LIMITS.total);
  const tone = built.sections.find((s) => s.id === 'tone');
  assert.ok(tone.chars < PERSONA_LIMITS.tone);
  assert.ok(built.warnings.some((w) => w.includes('怎么说话')));
});
check('extra+tone 都超时按顺序裁（先 extra 再 tone）', () => {
  const cfg = {
    socialV2: {
      persona: {
        selfDesc: '鲸'.repeat(400),
        tone: '话'.repeat(200),
        extra: '补'.repeat(2000),
        rules: Array.from({ length: 20 }, () => '规'.repeat(200))
      }
    }
  };
  const built = buildPersonaSections(cfg);
  assert.ok(built.chars <= PERSONA_LIMITS.total);
  assert.ok(!built.sections.some((s) => s.id === 'extra'));
  const hit = built.warnings.filter((w) => w.includes('超过 4000 字'));
  assert.ok(hit.length >= 2, `实际 ${hit.length} 条`);
});
check('裁剪不会动 identity 与 rules 段', () => {
  const cfg = { socialV2: { persona: { extra: '补'.repeat(3000), rules: ['只有这一条规则'] } } };
  const built = buildPersonaSections(cfg);
  assert.match(built.text, /大肥鱼小姐/);
  assert.match(built.text, /只有这一条规则/);
});

// ── 三层合并 ───────────────────────────────────────────────────────────────
check('字符串层落到 extra 段', () => {
  const base = buildPersonaSections({});
  const merged = mergePersonaLayers(base, '预设摘录：你是鲸鱼', null);
  const extra = merged.find((s) => s.id === 'extra');
  assert.ok(extra);
  assert.match(extra.text, /预设摘录/);
});
check('对象层按 id 覆盖 identity', () => {
  const base = buildPersonaSections({});
  const merged = mergePersonaLayers(base, null, { identity: '覆盖后的身份' });
  assert.equal(merged.find((s) => s.id === 'identity').text, '覆盖后的身份');
});
check('同 id 用户层优先于预设层', () => {
  const base = buildPersonaSections({});
  const merged = mergePersonaLayers(base, { extra: '预设版补充' }, { extra: '用户版补充' });
  assert.equal(merged.find((s) => s.id === 'extra').text, '用户版补充');
});
check('合并后段落顺序仍固定', () => {
  const merged = mergePersonaLayers(buildPersonaSections({}), '预设', { identity: '身份' });
  assert.deepEqual(merged.map((s) => s.id).slice(0, 5), ['identity', 'tone', 'rules', 'wake', 'capabilities']);
});
check('空层不改变基础段落', () => {
  const base = buildPersonaSections({});
  const merged = mergePersonaLayers(base, null, undefined);
  assert.deepEqual(merged.map((s) => s.id), base.sections.map((s) => s.id));
});
check('未知 id 追加在最后', () => {
  const merged = mergePersonaLayers(buildPersonaSections({}), null, { custom: '自定义段落' });
  assert.equal(merged.at(-1).id, 'custom');
  assert.equal(merged.at(-1).text, '自定义段落');
});
check('合并不修改传入的 base', () => {
  const base = buildPersonaSections({});
  const before = base.sections.map((s) => s.text);
  mergePersonaLayers(base, '预设', { identity: '改了身份' });
  assert.deepEqual(base.sections.map((s) => s.text), before);
});

// ── 控制台摘要 ─────────────────────────────────────────────────────────────
check('默认配置的 source 全是 default', () => {
  const plan = describePersonaPlan({});
  assert.ok(plan.sections.every((s) => s.source === 'default'), JSON.stringify(plan.sections));
});
check('配了 name 时 identity 标 config', () => {
  const plan = describePersonaPlan({ socialV2: { persona: { name: '小鱼' } } });
  assert.equal(plan.sections.find((s) => s.id === 'identity').source, 'config');
  assert.equal(plan.sections.find((s) => s.id === 'rules').source, 'default');
});
check('配了 wake 时 wake 段标 config', () => {
  const plan = describePersonaPlan(baseCfg());
  assert.equal(plan.sections.find((s) => s.id === 'wake').source, 'config');
});
check('plan.chars 与同 opts 的 build 一致', () => {
  const opts = { channel: 'private', capabilities: { draw: true } };
  const built = buildPersonaSections(baseCfg(), opts);
  const plan = describePersonaPlan(baseCfg(), opts);
  assert.equal(plan.chars, built.chars);
});
check('plan 的段落 id 与 build 一致', () => {
  const opts = { capabilities: { draw: false } };
  assert.deepEqual(
    describePersonaPlan(baseCfg(), opts).sections.map((s) => s.id),
    buildPersonaSections(baseCfg(), opts).sections.map((s) => s.id)
  );
});

// ── 坏输入不抛 ─────────────────────────────────────────────────────────────
check('cfg=null 不抛且能拼默认', () => {
  const built = buildPersonaSections(null);
  assert.ok(built.text.includes('大肥鱼小姐'));
});
check('socialV2 是字符串不抛', () => {
  const built = buildPersonaSections({ socialV2: 'nope' });
  assert.ok(built.chars > 0);
});
check('persona 是数组时回退默认并记 warning', () => {
  const built = buildPersonaSections({ socialV2: { persona: ['a', 'b'] } });
  assert.ok(built.text.includes('大肥鱼小姐'));
  assert.ok(built.warnings.some((w) => w.includes('不是对象')));
});
check('describeWakeRules(null) 不抛且给默认句', () => {
  assert.match(describeWakeRules(null).text, /被 @/);
});

console.log(`\n人设 prompt：通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exit(1);
