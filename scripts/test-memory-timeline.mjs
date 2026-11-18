#!/usr/bin/env node
// D48：跨群记忆的时间线。
// 用户真机：「记忆是一段段蹦出来的片段，没有自己的时间线」。
// 覆盖：①相对时间渲染（刚刚/分钟/小时/昨天/前天/N 天前/缺时间）②buildDigest 结构化存
// 每条记忆的**说话时间** ③注入按时间正序、每条带相对时间 ④people 话题带时间与群来源
// ⑤新增字符预算 ≤150 ⑥缺时间不编、跨天必须说昨天。
// 用法：node scripts/test-memory-timeline.mjs
import assert from 'node:assert/strict';
import {
  buildDigest, pickDigests, renderDigestBlock, normalizeDigests, digestSnapshot,
  DISCLOSURE_HEADERS
} from '../src/cross-session-memory.js';
import { relativeTimeLabel, calendarDayDiff } from '../src/relative-time.js';
import { emptyPeople, noteSighting, recallPeople } from '../src/people.js';

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass += 1; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); } else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); } }
function eq(name, actual, expected) { ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`); }
const len = (s) => [...String(s)].length;

// 固定基准：2026-10-27 13:30 本地时间（周一下午），方便算跨天。
const NOW = new Date(2026, 9, 27, 13, 30, 0).getTime();
const H = 3600000;
const D = 86400000;

console.log('[A] 相对时间渲染');
eq('刚刚（<5 分钟）', relativeTimeLabel(NOW - 2 * 60000, NOW), '刚刚');
eq('N 分钟前', relativeTimeLabel(NOW - 35 * 60000, NOW), '35 分钟前');
eq('同一天 N 小时前', relativeTimeLabel(NOW - 3 * H, NOW), '3 小时前');
// 跨天：凌晨 01:00 vs 昨天 23:00 → 差 2 小时但日历差 1 天，必须说「昨天」而不是「2 小时前」。
const earlyMorning = new Date(2026, 9, 27, 1, 0, 0).getTime();
eq('跨天（差 2 小时）说昨天', relativeTimeLabel(earlyMorning - 2 * H, earlyMorning), '昨天');
eq('跨天再往前 → 前天', relativeTimeLabel(NOW - 2 * D, NOW), '前天');
eq('5 天前', relativeTimeLabel(NOW - 5 * D, NOW), '5 天前');
ok('30 天以上说上个月', ['上个月', '更早'].includes(relativeTimeLabel(NOW - 45 * D, NOW)), relativeTimeLabel(NOW - 45 * D, NOW));
eq('缺时间 → 空串（不编）', relativeTimeLabel(0, NOW), '');
eq('非法时间 → 空串', relativeTimeLabel('nonsense', NOW), '');
eq('未来时间（时钟偏差）→ 刚刚，不出现负值', relativeTimeLabel(NOW + 5000, NOW), '刚刚');
eq('日历天差：同天=0', calendarDayDiff(NOW - 3 * H, NOW), 0);
eq('日历天差：昨天=1', calendarDayDiff(NOW - D + 3 * H, NOW), 1);

console.log('\n[B] buildDigest：每条记忆带说话时间');
const msgs = [
  { seq: 1, sender: '甲', plain: '昨天的打包脚本挂了', isSelf: false, time: NOW - 26 * H },
  { seq: 2, sender: '乙', plain: '今天早上又试了一次', isSelf: false, time: NOW - 5 * H },
  { seq: 3, sender: '丙', plain: '我把入口目录补上了', isSelf: false, time: NOW - 2 * H },
  { seq: 4, sender: '我', plain: '那晚上再看', isSelf: true, time: NOW - 1 * H }
];
const d = buildDigest({ key: 'group:222', messages: msgs, now: NOW });
ok('digest 有结构化 entries', Array.isArray(d.entries) && d.entries.length > 0, JSON.stringify(d.entries));
ok('entries 的 at 是**说话时间**而不是生成时间', d.entries.some((x) => x.at === NOW - 26 * H) && d.entries.every((x) => x.at !== NOW), JSON.stringify(d.entries.map((x) => x.at)));
ok('entries 按时间正序', d.entries.every((x, i) => i === 0 || x.at >= d.entries[i - 1].at), JSON.stringify(d.entries.map((x) => x.at)));
ok('entries 带说话人 from', d.entries.every((x) => x.from && x.from.length > 0), JSON.stringify(d.entries.map((x) => x.from)));
ok('summary 仍是旧格式（兼容历史/控制台）', d.summary.includes('甲：'), d.summary);

console.log('\n[C] 注入：每条带相对时间，按时间正序');
const block = renderDigestBlock([{ key: 'group:222', at: NOW, summary: d.summary, entries: d.entries }], { now: NOW });
ok('有块头', block.includes('其它会话的近况'), block.slice(0, 30));
ok('块头标「N 小时前更新」', block.includes('更新'), block.slice(180, 260));
ok('含「昨天」', block.includes('昨天'), block);
ok('含「5 小时前」/「2 小时前」', /5 小时前|2 小时前/.test(block), block);
ok('条目顺序：昨天在 2 小时前之前', block.indexOf('昨天') < block.indexOf('2 小时前'), block);
ok('每条记忆都带时间（3 条时间戳）', (block.match(/昨天|小时前|分钟前|刚刚/g) || []).length >= 3, block);
ok('每条用「时间｜说话人：内容」', /昨天｜甲：/.test(block) && /小时前｜我：/.test(block), block);
ok('块 ≤600 字符', len(block) <= 604, String(len(block)));

console.log('\n[D] 旧摘要降级：没有 entries 就用块级时间；时间缺失不编');
const legacy = renderDigestBlock([{ key: 'group:333', at: NOW - 3 * H, summary: '老格式摘要' }], { now: NOW });
ok('旧摘要带块级时间', legacy.includes('3 小时前更新'), legacy);
const noTime = renderDigestBlock([{ key: 'group:444', at: 0, summary: '没时间的旧摘要' }], { now: NOW });
ok('缺时间说「时间不详」而不是编一个', noTime.includes('时间不详'), noTime);
ok('缺时间不出现「刚刚」', !noTime.includes('刚刚'), noTime);
// 更老的数据：entries 直接是纯字符串 → 时间未知，不许伪造 at。
const stringEntry = normalizeDigests({ 'group:555': { at: NOW, summary: '旧摘要', entries: '没有时间的纯字符串片段' } }, { now: NOW });
ok('纯字符串 entries 被接受', stringEntry['group:555'].entries.length === 1, JSON.stringify(stringEntry['group:555'].entries));
ok('纯字符串一律 at=0（不伪造时间）', stringEntry['group:555'].entries[0].at === 0);
const stringBlock = renderDigestBlock([{ key: 'group:555', at: NOW, summary: '旧摘要', entries: stringEntry['group:555'].entries }], { now: NOW });
ok('纯字符串渲染成「时间不详」', stringBlock.includes('时间不详'), stringBlock);

console.log('\n[E] 落盘/读取保留 entries');
const normalized = normalizeDigests({ 'group:222': { ...d, at: NOW, entries: [...d.entries, { at: 0, text: '没时间的条目', from: '甲' }, { at: 'bad', text: '' }] } }, { now: NOW });
ok('normalize 保留 entries', Array.isArray(normalized['group:222'].entries) && normalized['group:222'].entries.length >= d.entries.length, JSON.stringify(normalized['group:222'].entries));
ok('坏条目（空 text）被丢掉', normalized['group:222'].entries.every((x) => x.text && x.text.trim()));
ok('缺 at 的条目被保留为 0（不编时间）', normalized['group:222'].entries.some((x) => x.at === 0));
const snapshot = digestSnapshot({ 'group:222': { ...d, at: NOW } }, { now: NOW });
ok('落盘快照也保留 entries', Array.isArray(snapshot['group:222']?.entries) && snapshot['group:222'].entries.length > 0);
const picked = pickDigests({ digests: { 'group:222': { ...d, at: NOW } }, currentKey: 'group:x', allowKeys: ['group:222'], now: NOW });
ok('取摘要时带上 entries', Array.isArray(picked[0]?.entries) && picked[0].entries.length > 0);

console.log('\n[F] 防编造：三句硬化都在块头里');
ok('①时间都是标注好的、不许推断编造', DISCLOSURE_HEADERS.open.includes('标注好的') && DISCLOSURE_HEADERS.open.includes('不许自己推断或编造'), DISCLOSURE_HEADERS.open.slice(-90));
ok('②无标注旧片段说记不清、不许当刚发生', DISCLOSURE_HEADERS.open.includes('记不清是什么时候') && DISCLOSURE_HEADERS.open.includes('不许说成刚发生'));
ok('③问多久以前只答能确认的粒度', DISCLOSURE_HEADERS.open.includes('只回答能确认的粒度'));
ok('strict 档也有时间规则', DISCLOSURE_HEADERS.strict.includes('不推断不编造'));

console.log('\n[G] people 话题带时间与群来源');
{
  const s = emptyPeople();
  // 话题都在别的群：昨天的 + 3 小时前的；再塞一个没有时间的。
  noteSighting(s, { userId: 'U1', name: '聪明头哦鲸鲸', source: 'sender', scope: 'group:100000004', at: NOW - 26 * H, text: '昨天的打包脚本又挂了，入口目录还是空的' });
  noteSighting(s, { userId: 'U1', name: '聪明头哦鲸鲸', source: 'sender', scope: 'group:100000004', at: NOW - 3 * H, text: '入口目录补上了，验收要加一步' });
  s.people.U1.recentTopics = [
    { text: '打包脚本', groupId: 'group:100000004', at: NOW - 26 * H },
    { text: '入口目录', groupId: 'group:100000004', at: NOW - 3 * H },
    { text: '某件没时间的事', groupId: 'group:100000004', at: 0 }
  ];
  const r = recallPeople(s, { text: '哦鲸鲸最近在聊什么', scope: 'group:100000003', now: NOW });
  ok('话题带相对时间（昨天）', r.text.includes('昨天'), r.text);
  ok('话题带相对时间（3 小时前）', r.text.includes('3 小时前'), r.text);
  ok('话题带群来源（另一个群）', r.text.includes('另一个群'), r.text);
  ok('缺时间的话题标「时间不详」，不编（单查一条缺时间的话题）', (() => {
    s.people.U1.recentTopics = [{ text: '某件没时间的事', groupId: 'group:100000004', at: 0 }];
    const r2 = recallPeople(s, { text: '哦鲸鲸呢', scope: 'group:100000003', now: NOW });
    return r2.text.includes('时间不详');
  })());
  ok('整段 ≤200 字符', len(r.text) <= 200, String(len(r.text)));
  ok('不含 QQ 号/群号', !r.text.includes('100000010') && !/group:\d+/.test(r.text), r.text);
  ok('口径句写明时间规则', r.text.includes('时间是标注好的') && r.text.includes('别自己推断') && r.text.includes('别当刚发生'), r.text);
}

console.log('\n[H] 新增字符预算 ≤150；超了砍条数不砍时间');
{
  // 三条摘要 × 各 3 条带时间条目：时间标签总字符数就是「新增」开销。
  const items = [
    { key: 'group:1', at: NOW, summary: 'x', entries: [
      { at: NOW - 2 * D, text: '昨天的事', from: '甲' }, { at: NOW - 5 * H, text: '五小时前', from: '乙' }, { at: NOW - 10 * 60000, text: '十分钟前', from: '丙' }
    ] },
    { key: 'group:2', at: NOW, summary: 'y', entries: [
      { at: NOW - 3 * D, text: '三天前', from: '甲' }, { at: NOW - 2 * H, text: '两小时前', from: '乙' }, { at: NOW - 30 * 60000, text: '半小时前', from: '丙' }
    ] },
    { key: 'group:3', at: NOW, summary: 'z', entries: [
      { at: NOW - 10 * D, text: '十天前', from: '甲' }, { at: NOW - 1 * H, text: '一小时前', from: '乙' }, { at: NOW - 60000, text: '一分钟前', from: '丙' }
    ] }
  ];
  const b = renderDigestBlock(items, { now: NOW });
  const labelChars = (b.match(/刚刚|分钟前|小时前|昨天|前天|\d+ 天前/g) || []).join('').length;
  ok('时间标签总字符 ≤150', labelChars <= 150, `${labelChars} 字符`);
  ok('整块 ≤600 字符', len(b) <= 604, String(len(b)));
  // 每行都有时间（砍的是条数，不会砍出无时间行）
  const itemLines = b.split('\n').filter((l) => l.startsWith('  '));
  const timeLineRe = /^(刚刚|\d+ 分钟前|\d+ 小时前|昨天|前天|\d+ 天前|时间不详)｜/;
  ok('渲染出的每条都带时间', itemLines.length > 0 && itemLines.every((l) => timeLineRe.test(l.trim())), JSON.stringify(itemLines));
  // 预算很紧时：条数往下砍，但留下的每条仍有时间标签。
  const tiny = renderDigestBlock(items, { now: NOW, maxBlockChars: 300 });
  ok('紧预算下 ≤300 字符', len(tiny) <= 304, String(len(tiny)));
  const tinyItems = tiny.split('\n').filter((l) => l.startsWith('  '));
  ok('紧预算下没有丢时间的条目', tinyItems.length > 0 && tinyItems.every((l) => timeLineRe.test(l.trim())), JSON.stringify(tinyItems));
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exitCode = fail === 0 ? 0 : 1;
