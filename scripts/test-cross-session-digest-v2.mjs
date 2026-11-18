#!/usr/bin/env node
/**
 * D34-A 单测：src/cross-session-digest-v2.js（摘要「轻改」版）。
 *
 * 断言的是「毛病被修掉」这件事本身，而不是「输出长这样」：
 *   · 纯占位符不再占槽位        · 不出现半句/半个「人名：」
 *   · 「我：」被压到 ≤1~2 条    · 总长不超过 maxChars
 *   · topics 只留跨消息重复的短语（不再有「算了」这种）
 *   · 与旧 buildDigest 在同一条真实消息流上对比：占位段下降、有效对不减
 *
 * 用法：node scripts/test-cross-session-digest-v2.mjs
 */
import assert from 'node:assert/strict';
import { buildDigest } from '../src/cross-session-memory.js';
import {
  buildDigestV2, shapeBody, isPlaceholderOnly, freshnessLabel, shouldRefreshDigest, DIGEST_V2_DEFAULTS
} from '../src/cross-session-digest-v2.js';
import { analyzeDigest } from './analyze-digest-density.mjs';

/**
 * 改造前的旧实现（D36 之前线上跑的那份）：每条取前 60 字硬拼、拼完再按 maxChars 硬切、
 * topics 从摘要里乱切 2~8 字。留在这里只用于「新旧对比」断言——不参与线上逻辑。
 */
function buildDigestLegacy({ key, messages = [], now = Date.now(), maxChars = 200 } = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && String(m.plain ?? m.text ?? '').trim());
  if (!list.length) return null;
  const recent = list.slice(-10);
  const people = [];
  const topics = [];
  const parts = [];
  for (const m of recent) {
    const sender = String(m.sender || '群友').slice(0, 12);
    if (!people.includes(sender) && !m.isSelf) people.push(sender);
    const body = String(m.plain ?? m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (body) parts.push(m.isSelf ? `我：${body}` : `${sender}：${body}`);
  }
  let summary = parts.join('；');
  if (summary.length > maxChars) summary = `${summary.slice(0, maxChars - 1)}…`;
  for (const t of summary.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,8}/g) || []) {
    if (topics.length >= 6) break;
    if (!topics.includes(t)) topics.push(t);
  }
  return { key: String(key || ''), at: Number(now) || Date.now(), summary, topics, people: people.slice(0, 8) };
}

let pass = 0;
const cases = [];
function t(name, fn) { cases.push([name, fn]); }

const msg = (sender, text, extra = {}) => ({ sender, plain: text, text, time: extra.time || 1793000000000, isSelf: !!extra.isSelf, ...extra });

// 一条「线上长得一模一样」的消息流：混占位符、半句、自述过多
const stream = [
  msg('王耄耋', '[图片]'),
  msg('我', '面吃完了，这会儿已经开始琢磨中午吃什么', { isSelf: true }),
  msg('王耄耋', '你还吃上了'),
  msg('我', '早上那顿太凑合，中午想吃点像样的', { isSelf: true }),
  msg('陌钰凝', '炒香蕉和煮香蕉怎么样'),
  msg('杜十娘', '[表情包:表示兴奋]'),
  msg('陌钰凝', '能减肥'),
  msg('杜十娘', '你快下'),
  msg('我', '炒香蕉我有点不敢试，感觉一下就糊成一坨了', { isSelf: true }),
  msg('我', '减肥就先算啦，我早上刚补完面', { isSelf: true })
];

t('纯占位符消息不占槽位（digest 里没有 [图片]/[表情包:]）', () => {
  const d = buildDigestV2({ key: 'group:1', messages: stream, now: 1793100000000 });
  assert.ok(d, '应生成摘要');
  assert.ok(!d.summary.includes('[图片]'), `摘要不该含占位符：${d.summary}`);
  assert.ok(!d.summary.includes('[表情包'), `摘要不该含表情占位符：${d.summary}`);
  const m = analyzeDigest(d);
  assert.equal(m.placeholderSegs, 0, '占位段应为 0');
});

t('不出现半句 / 半个「人名：」', () => {
  const d = buildDigestV2({ key: 'group:1', messages: stream, now: 1793100000000 });
  const segs = d.summary.split('；');
  for (const s of segs) {
    assert.ok(!s.endsWith('：'), `段尾不能只剩冒号：${s}`);
    const idx = s.indexOf('：');
    assert.ok(idx > 0, `每段都该是「人名：内容」：${s}`);
    assert.ok(s.slice(idx + 1).length >= 2, `内容不能少于 2 字：${s}`);
  }
  assert.ok(!d.summary.endsWith('…'), `尾巴不该是省略号：${d.summary}`);
  const m = analyzeDigest(d);
  assert.equal(m.truncatedTail, 0, '截断尾应为 0');
});

t('「我：」不超过 2 条，且自述截到 40 字内', () => {
  const d = buildDigestV2({ key: 'group:1', messages: stream, now: 1793100000000 });
  const selfs = d.summary.split('；').filter((s) => s.startsWith('我：'));
  assert.ok(selfs.length <= DIGEST_V2_DEFAULTS.maxSelf, `我：应 ≤2 条，实际 ${selfs.length}`);
  assert.ok(selfs.length <= 1, `别人够多（≥3 段）时只该留 1 条自述，实际 ${selfs.length}`);
  for (const s of selfs) assert.ok(s.length - 2 <= 40, `自述过长：${s}`);
  // 旧版在同一流上「我」占 4 段（不受 200 字截断影响时）——这里用宽松 maxChars 让旧版原形毕露
  const oldD = buildDigestLegacy({ key: 'group:1', messages: stream, maxChars: 1000 });
  const oldSelfs = oldD.summary.split('；').filter((s) => s.startsWith('我：')).length;
  assert.ok(selfs.length < oldSelfs, `新版自述条数应少于旧版（新 ${selfs.length} / 旧 ${oldSelfs}）`);
});

t('总长不超过 maxChars，且不丢「他人信息」', () => {
  const d = buildDigestV2({ key: 'group:1', messages: stream, now: 1793100000000 });
  assert.ok(d.summary.length <= DIGEST_V2_DEFAULTS.maxChars, `总长 ${d.summary.length}`);
  const others = d.summary.split('；').filter((s) => !s.startsWith('我：'));
  assert.ok(others.length >= 3, `他人段应 ≥3，实际 ${others.length}：${d.summary}`);
});

t('比旧版：占位段更少、有效信息对不减（同一条真实流）', () => {
  // 旧版用宽松 maxChars，让它把 4 段自述 + 2 段占位符都拼进来（否则 200 字截断会掩盖问题）
  const oldM = analyzeDigest({ ...buildDigestLegacy({ key: 'group:1', messages: stream, maxChars: 1000 }), key: 'group:1' });
  const newM = analyzeDigest(buildDigestV2({ key: 'group:1', messages: stream, now: 1793100000000 }));
  assert.ok(oldM.placeholderSegs > 0, `旧版应含占位段（实得 ${oldM.placeholderSegs}）——样本没构造对`);
  assert.ok(newM.placeholderSegs < oldM.placeholderSegs, `占位段应下降（旧 ${oldM.placeholderSegs} / 新 ${newM.placeholderSegs}）`);
  assert.ok(newM.meaningfulPairs >= oldM.meaningfulPairs, `有效对应不减（旧 ${oldM.meaningfulPairs} / 新 ${newM.meaningfulPairs}）`);
  assert.ok(newM.totalChars <= oldM.totalChars, `字数应不涨（旧 ${oldM.totalChars} / 新 ${newM.totalChars}）`);
});

t('topics 只留跨消息重复的短语，且不含虚词开头', () => {
  const messages = [
    msg('甲', '周末去爬山吗，天气预报说不错'),
    msg('乙', '爬山我脚还没好'),
    msg('甲', '那就改成爬山脚下喝茶'),
    msg('丙', '爬山改成喝茶我同意'),
    msg('甲', '[图片]')
  ];
  const d = buildDigestV2({ key: 'group:1', messages, now: 1793100000000 });
  assert.ok(d.topics.length > 0, '应有话题');
  assert.ok(d.topics.some((x) => x.includes('爬山')), `应抓到反复出现的「爬山」：${d.topics}`);
  for (const x of d.topics) {
    assert.ok(!['算了', '这个', '那个', '什么', '怎么'].includes(x), `不该有口水词：${x}`);
  }
});

t('全占位符 / 空输入 → null（不硬造摘要）', () => {
  assert.equal(buildDigestV2({ key: 'group:1', messages: [] }), null);
  assert.equal(buildDigestV2({ key: 'group:1', messages: [msg('甲', '[图片]'), msg('乙', '[表情包:笑]')] }), null);
});

t('shapeBody：短句原样，超长句按句末标点断，不产生半个字', () => {
  assert.equal(shapeBody('你还吃上了'), '你还吃上了');
  // 44 字、第一个句号在第 7 字：超长时应在句号处断开，而不是硬切
  const long = shapeBody('第一句说完了。第二句还在继续而且很长很长很长很长很长很长很长很长很长很长很长很长很长');
  assert.ok(long.endsWith('。'), `应在句末标点断开：${long}`);
  assert.ok(long.length <= DIGEST_V2_DEFAULTS.maxBody + 10, `断开位置不该超过窗口：${long.length}`);
  const noPunct = shapeBody('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九一一二三四五六七八九十');
  assert.ok(noPunct.endsWith('…') && noPunct.length <= DIGEST_V2_DEFAULTS.maxBody, `50 字无标点时按长度截并标 …：${noPunct}`);
});

t('isPlaceholderOnly 认得出占位符与空白', () => {
  assert.equal(isPlaceholderOnly('[图片]'), true);
  assert.equal(isPlaceholderOnly('  [表情包:表示兴奋] '), true);
  assert.equal(isPlaceholderOnly('[图片] 这猫好胖'), false);
  assert.equal(isPlaceholderOnly(''), true);
});

t('freshnessLabel：刚刚 / N 小时前 / N 天前', () => {
  const now = 1793100000000;
  assert.equal(freshnessLabel(now - 60 * 1000, now), '刚刚');
  assert.equal(freshnessLabel(now - 5 * 3600 * 1000, now), '5 小时前');
  assert.equal(freshnessLabel(now - 50 * 3600 * 1000, now), '2 天前');
});

t('shouldRefreshDigest：条数到了刷、太旧了刷、都不到不刷', () => {
  const now = 1793100000000;
  assert.deepEqual(shouldRefreshDigest({ count: 20, lastAt: now - 60000, now }), { refresh: true, why: 'count' });
  assert.equal(shouldRefreshDigest({ count: 7, lastAt: now - 3 * 3600 * 1000, now }).why, 'age');
  assert.equal(shouldRefreshDigest({ count: 7, lastAt: now - 60000, now }).refresh, false);
  // 线上实测的那种情况：count 只到 14（漏计），但摘要 8.6 小时前 → 必须刷
  assert.equal(shouldRefreshDigest({ count: 14, lastAt: now - 8.6 * 3600 * 1000, now }).refresh, true);
});

for (const [name, fn] of cases) {
  try {
    fn();
    pass += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.log(`❌ ${name}\n   ${error.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${process.exitCode ? '❌' : '🎉'} D34-A 摘要轻改单测：${pass}/${cases.length}`);
