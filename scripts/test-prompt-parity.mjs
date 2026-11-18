// 非 DSH 后端的提示词「覆盖度」自检（P3 第一步：只分析，不接线）。
//
// 为什么要有这个套件：换掉 DSH 之后，DSH 预设里的人设/规则散文就没了；桥接必须保证
// 「该有的段落一段不少」。判断依据不能靠感觉，只能对着源码数：wake-prompts.js 里的
// promptParts 有哪些段、personaUp 排在哪、dsh 时是否为空、纯模式会不会把人设砍掉。
//
// 全程只读源码 + 调纯函数：不连 3100、不连 DSH、不需要任何活服务。
// 用法：node scripts/test-prompt-parity.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PURE_MODE_DROPS, applyPureMode } from '../src/pure-mode.js';
import {
  PERSONA_SECTION_IDS,
  PERSONA_SECTION_TITLES,
  PERSONA_LIMITS,
  buildPersonaSections,
  buildHandoffSection,
  buildInitialPromptSection
} from '../src/persona-prompt.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WAKE_FILE = path.join(ROOT, 'src/bridge/wake-prompts.js');
const DOC_FILE = path.join(ROOT, 'docs/guides/PERSONA-MIGRATION.md');

const wakeSource = fs.readFileSync(WAKE_FILE, 'utf8');
const docText = fs.readFileSync(DOC_FILE, 'utf8');

// 期望必须出现在 promptParts 里的段名（覆盖 lead 列出的那些 + 其余实际存在的段）。
const EXPECTED_PARTS = [
  'activeRole', 'mediaAware', 'ttsHint', 'voiceNow', 'role', 'identity', 'attribution', 'memeWiki', 'selfModel',
  'personaUp', 'token', 'hostTool', 'draw', 'handoff', 'persona', 'personaCmdHint',
  'initialPrompt', 'antiAi', 'aiBlacklist', 'proactive', 'sticker', 'reply',
  'memoryEventHint', 'memory', 'crossSession', 'people', 'participation', 'preSleep',
  'localModel', 'timeSense'
];

let passed = 0;
let failed = 0;
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

// ── 从源码里抠出 promptParts 数组与 personaUpLineFor ─────────────────────────
function extractPromptPartsText(source) {
  const start = source.indexOf('const promptParts = [');
  assert.ok(start >= 0, '源码里找不到 const promptParts = [');
  const end = source.indexOf('\n    ];', start);
  assert.ok(end > start, '找不到 promptParts 数组的结尾');
  return source.slice(start, end);
}

function extractPartNames(arrayText) {
  return [...arrayText.matchAll(/\[\s*'([A-Za-z][A-Za-z0-9]*)'\s*,/g)].map((m) => m[1]);
}

function extractPersonaUpFn(source) {
  const start = source.indexOf('function personaUpLineFor(deps, key) {');
  assert.ok(start >= 0, '源码里找不到 personaUpLineFor');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, '找不到 personaUpLineFor 的结尾');
  return source.slice(start, end + 2);
}

const partsText = extractPromptPartsText(wakeSource);
const partNames = extractPartNames(partsText);

// ── A. 段落清单：齐全、唯一、干净 ──────────────────────────────────────────
check('promptParts 数组能抠出来且非空', () => {
  assert.ok(partsText.length > 300);
  assert.ok(partNames.length >= 25, `只数到 ${partNames.length} 段`);
});
check(`${EXPECTED_PARTS.length} 段全部登记在 promptParts 里`, () => {
  assert.equal(partNames.length, EXPECTED_PARTS.length, `实际 ${partNames.length} 段`);
});
check('lead 列出的段名一个不少', () => {
  const set = new Set(partNames);
  const missing = EXPECTED_PARTS.filter((name) => !set.has(name));
  assert.deepEqual(missing, []);
});
check('每个段名在 promptParts 里只出现一次', () => {
  const seen = new Map();
  for (const name of partNames) seen.set(name, (seen.get(name) || 0) + 1);
  const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([name, n]) => `${name}×${n}`);
  assert.deepEqual(dup, []);
});
check('promptParts 里没有夹带 pureMode（它是由纯净模式动态前置的）', () => {
  assert.ok(!partNames.includes('pureMode'));
});
check('ttsHint 只出现一次（旧版重复注入 330 字已修）', () => {
  assert.equal(partNames.filter((name) => name === 'ttsHint').length, 1);
});

// ── B. 顺序：人格要在最前面 ────────────────────────────────────────────────
check('personaUp 排在 token 之前', () => {
  assert.ok(partNames.indexOf('personaUp') >= 0);
  assert.ok(partNames.indexOf('personaUp') < partNames.indexOf('token'));
});
check('identity 与 role 都在 personaUp 之前（先说是谁，再说人设补充）', () => {
  assert.ok(partNames.indexOf('identity') < partNames.indexOf('personaUp'));
  assert.ok(partNames.indexOf('role') < partNames.indexOf('personaUp'));
});
check('antiAi 与 aiBlacklist 在 personaUp 之后（规则类跟着人设走）', () => {
  assert.ok(partNames.indexOf('antiAi') > partNames.indexOf('personaUp'));
  assert.ok(partNames.indexOf('aiBlacklist') > partNames.indexOf('personaUp'));
});

// ── C. personaUp 的渲染行为（从源码里取函数本体直接跑） ────────────────────
const personaUpFn = (() => {
  const fnText = extractPersonaUpFn(wakeSource);
  // 源码里是普通函数声明，转成表达式再取回来：这样测的还是盘上那份实现。
  // eslint-disable-next-line no-new-func
  return new Function('return (' + fnText + ')')();
})();

check('personaUpLineFor 能从源码里取出来并在测试里执行', () => {
  assert.equal(typeof personaUpFn, 'function');
});
check('deps 里没有 personaPromptFor（纯 dsh 环境）→ 空串', () => {
  assert.equal(personaUpFn({}, 'group:1'), '');
});
check('personaPromptFor 返回 null（dsh 分支）→ 空串', () => {
  assert.equal(personaUpFn({ personaPromptFor: () => null }, 'group:1'), '');
});
check('personaPromptFor 返回 {text:""} → 空串', () => {
  assert.equal(personaUpFn({ personaPromptFor: () => ({ text: '' }) }, 'group:1'), '');
});
check('personaPromptFor 返回 {text} → 带【人格与规则】标题与正文', () => {
  const out = personaUpFn({ personaPromptFor: () => ({ text: '你是大肥鱼小姐' }) }, 'group:1');
  assert.match(out, /【人格与规则】/);
  assert.match(out, /你是大肥鱼小姐/);
});
check('群聊 key 传 channel=group', () => {
  let got = null;
  personaUpFn({ personaPromptFor: (channel) => { got = channel; return { text: 'x' }; } }, 'group:456');
  assert.equal(got, 'group');
});
check('私聊 key 传 channel=private', () => {
  let got = null;
  personaUpFn({ personaPromptFor: (channel) => { got = channel; return { text: 'x' }; } }, 'private:2814');
  assert.equal(got, 'private');
});
check('personaPromptFor 抛异常 → 空串（不把唤醒整条打挂）', () => {
  assert.equal(personaUpFn({ personaPromptFor: () => { throw new Error('boom'); } }, 'group:1'), '');
});
check('正文前后空白被 trim', () => {
  const out = personaUpFn({ personaPromptFor: () => ({ text: '  人设正文  ' }) }, 'group:1');
  assert.ok(out.includes('【人格与规则】\n人设正文'), JSON.stringify(out));
});
check('源码里 personaUpText 确实来自 personaUpLineFor', () => {
  assert.match(wakeSource, /const personaUpText = personaUpLineFor\(deps, key\);/);
});

// ── D. 纯净模式不能把人设砍掉 ─────────────────────────────────────────────
check('PURE_MODE_DROPS 里没有 personaUp / identity / persona', () => {
  for (const name of ['personaUp', 'identity', 'persona']) {
    assert.ok(!PURE_MODE_DROPS.includes(name), `${name} 不该在 drop 名单里`);
  }
});
check('applyPureMode 保留 personaUp（省 token 也不丢人设）', () => {
  const cfg = { socialV2: { pureMode: { enabled: true } } };
  const parts = [
    { name: 'personaUp', chars: 200 },
    { name: 'token', chars: 50 },
    { name: 'memory', chars: 800 },
    { name: 'sticker', chars: 400 }
  ];
  const plan = applyPureMode(cfg, parts);
  assert.equal(plan.enabled, true);
  const kept = plan.parts.map((part) => part.name);
  assert.ok(kept.includes('personaUp'));
  assert.ok(kept.includes('token'));
  assert.ok(!kept.includes('memory'));
  assert.ok(!kept.includes('sticker'));
  assert.ok(plan.savedChars > 0);
});
check('纯净模式关闭时一段都不删', () => {
  const plan = applyPureMode({ socialV2: { pureMode: { enabled: false } } }, [{ name: 'memory', chars: 10 }]);
  assert.equal(plan.enabled, false);
});
check('源码里 pureMode 段是前置到第一项的', () => {
  assert.match(wakeSource, /\[\['pureMode',/);
});
check('源码按 keptNames 过滤、未命中的段一律保留', () => {
  assert.match(wakeSource, /promptParts\.filter\(\(\[name\]\) => keptNames\.has\(name\)\)/);
});

// ── E. 没有任何一段依赖 DSH 独有能力 ─────────────────────────────────────
check('wake-prompts.js 不出现 dshClient', () => {
  assert.ok(!wakeSource.includes('dshClient'));
});
check('wake-prompts.js 不直接读 deps.dsh', () => {
  assert.ok(!/deps\.dsh\b/.test(wakeSource));
});
check('wake-prompts.js 不 import 任何 DSH 客户端文件', () => {
  assert.ok(!/from\s+['"][^'"]*dsh-client/.test(wakeSource));
});

// ── F. 段落 id ↔ 迁移文档一一对应 ────────────────────────────────────────
check('persona-prompt 导出 6 个段落 id 且顺序固定', () => {
  assert.deepEqual([...PERSONA_SECTION_IDS], ['identity', 'tone', 'rules', 'wake', 'capabilities', 'extra']);
});
check('文档里出现全部 6 个段落 id', () => {
  const missing = [...PERSONA_SECTION_IDS].filter((id) => !docText.includes(id));
  assert.deepEqual(missing, []);
});
check('文档里出现 6 个段落的中文标题', () => {
  const missing = PERSONA_SECTION_IDS.filter((id) => !docText.includes(PERSONA_SECTION_TITLES[id]));
  assert.deepEqual(missing, []);
});
check('文档有「非 DSH 后端的提示词覆盖清单」这一节', () => {
  assert.match(docText, /## 非 DSH 后端的提示词覆盖清单/);
});
check('文档给出结论：桥接侧段落 100% 保留', () => {
  assert.match(docText, /桥接侧段落 100% 保留/);
});
check('文档列出三条已知差异', () => {
  assert.match(docText, /三条已知差异/);
  assert.match(docText, /handoff` \/ `initialPrompt` 由 `personaUp` 补等价文案/);
  assert.match(docText, /纯模式下 DSH 预设不参与/);
});
check('文档写明自检命令', () => {
  assert.match(docText, /node scripts\/test-prompt-parity\.mjs/);
});

// ── G. P3 第二步：非 dsh 后端补上 handoff / initialPrompt 两段 ─────────────
// 这两段在 dsh 下来自 DSH 预设与交接摘要；换后端后会变空。现在由 persona-prompt 的
// buildHandoffSection / buildInitialPromptSection 生成等价文案，经 buildPersonaSections
// 的返回值透传，由 personaUpLineFor 拼进同一个【人格与规则】块。
const openaiCfg = () => ({
  agent: { type: 'openai' },
  socialV2: { persona: { name: '小鲸鱼测试', selfDesc: '测试用鲸鱼', tone: '口语' } }
});
const builtFor = (cfg = openaiCfg(), channel = 'group') =>
  buildPersonaSections(cfg, { channel, capabilities: {} });

check('buildPersonaSections 额外返回 handoffText / initialPromptText', () => {
  const built = builtFor();
  assert.ok(built.handoffText && built.handoffText.includes('【上次会话的脉络'));
  assert.ok(built.initialPromptText && built.initialPromptText.includes('【群聊环境'));
  assert.ok(built.handoffSection && built.initialPromptSection);
});

check('两段都不挤占人设 4000 字预算（text 只含 6 段人设）', () => {
  const built = builtFor();
  assert.ok(built.chars <= PERSONA_LIMITS.total);
  assert.ok(!built.text.includes('【上次会话的脉络'));
  assert.ok(!built.text.includes('【群聊环境'));
});

check('非 dsh + personaPromptFor 有值 → 输出含两段且顺序 personaUp→handoff→initialPrompt', () => {
  const built = builtFor();
  const deps = { cfg: openaiCfg(), personaPromptFor: () => built };
  const line = personaUpFn(deps, 'group:1');
  assert.ok(line.includes('【人格与规则】'));
  const iPersona = line.indexOf('【人格与规则】');
  const iHandoff = line.indexOf('【上次会话的脉络');
  const iInitial = line.indexOf('【群聊环境');
  assert.ok(iHandoff > iPersona, 'handoff 应在 personaUp 之后');
  assert.ok(iInitial > iHandoff, 'initialPrompt 应在 handoff 之后');
});

check('dsh 模式即使 personaPromptFor 有值也返回空串（不双重人格）', () => {
  const built = builtFor();
  const deps = { cfg: { agent: { type: 'dsh' } }, personaPromptFor: () => built };
  assert.equal(personaUpFn(deps, 'group:1'), '');
});

check('handoff 段字数受 600 上限约束且含查历史指引', () => {
  const sec = buildHandoffSection(openaiCfg());
  assert.ok(sec.chars > 0 && sec.chars <= PERSONA_LIMITS.handoff);
  assert.ok(sec.text.includes('qq_search_history'));
});

check('initialPrompt 段默认群聊/私聊文案不同', () => {
  const group = buildInitialPromptSection(openaiCfg(), { channel: 'group' }).text;
  const priv = buildInitialPromptSection(openaiCfg(), { channel: 'private' }).text;
  assert.ok(group.includes('【群聊环境'));
  assert.ok(priv.includes('【私聊环境'));
  assert.notEqual(group, priv);
});

check('配置了 socialV2.initialPrompt 时正文用它且 fromConfig=true', () => {
  const cfg = { socialV2: { initialPrompt: '本群是绘画交流群，大家主要聊 VRChat 素材。' } };
  const sec = buildInitialPromptSection(cfg, { channel: 'group' });
  assert.equal(sec.fromConfig, true);
  assert.ok(sec.text.includes('本群是绘画交流群'));
});

check('超长 initialPrompt 截到 500 字以内', () => {
  const cfg = { socialV2: { initialPrompt: '背'.repeat(2000) } };
  const sec = buildInitialPromptSection(cfg, { channel: 'group' });
  assert.ok(sec.chars <= PERSONA_LIMITS.initialPrompt);
});

check('两段都不含 dsh 专属字样（DSH / compress / decompress）', () => {
  const built = builtFor();
  for (const text of [built.handoffText, built.initialPromptText]) {
    assert.ok(!/DSH/.test(text), '不应出现 DSH');
    assert.ok(!/compress/i.test(text), '不应出现 compress');
    assert.ok(!/decompress/i.test(text), '不应出现 decompress');
  }
});

check('纯模式不砍人格块：两段随 personaUp 一起保留', () => {
  // 两段是 personaUp 块的内容，不在 promptParts 里，所以纯模式按名字摘段时碰不到它们。
  assert.ok(!PURE_MODE_DROPS.includes('personaUp'));
  const kept = applyPureMode({ socialV2: { pureMode: { enabled: true } } }, [
    { name: 'pureMode', text: '【纯净模式】…' },
    { name: 'personaUp', text: '【人格与规则】\n含承接与预设\n\n' },
    { name: 'memory', text: '记忆' }
  ]);
  const names = kept.parts.map((part) => part.name);
  assert.ok(names.includes('personaUp'));
  assert.ok(!names.includes('memory'));
});

console.log(`
提示词覆盖度：通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exit(1);
