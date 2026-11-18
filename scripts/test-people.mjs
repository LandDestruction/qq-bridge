#!/usr/bin/env node
// D42：跨群认人（人物档案 + 别名索引 + 命中才召回）。
// [A] 纯逻辑（src/people.js）：三种别名来源、命中/未命中/同名消歧/预算/隐私/容量/TTL；
// [B] 真跑 bridge（audit-bridge-harness，临时目录）：默认关 → 0 注入且不建文件；
//     开启后回填历史消息 → 本轮问到「隔壁的哦鲸鲸」→ people 段出现且 ≤202 字符；
//     没提到人 → 段消失；档案里不出现分数/好感度。
// 用法：node scripts/test-people.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  emptyPeople, noteSighting, recallPeople, loadPeople, savePeople, peopleStats,
  normalizeName, pickDisplayName, PEOPLE_DEFAULTS
} from '../src/people.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) { ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`); }
const len = (s) => [...String(s)].length;

console.log('[A] 纯逻辑：档案、别名、召回、隐私');

// 一条「哦鲸鲸」档案：A 群 17 条，别名来自 sender；台账名是空的（真机就是这样）。
const NOW = Date.now();
const store = emptyPeople();
for (let i = 0; i < 17; i += 1) {
  noteSighting(store, {
    userId: '100000010', name: '聪明头哦鲸鲸', source: 'sender', scope: 'group:100000004',
    at: NOW - 3600000 + i * 1000,
    // 她自己的发言（用来归纳话题）：技术向的句子应产出「打包脚本/入口目录」这种关键词。
    text: i % 3 === 0 ? '打包脚本又报错了，入口目录那边还是空的' : (i % 3 === 1 ? '入口目录的子系统没解压出来，验收要加一步' : '打包完之后自检一下模块')
  });
}
{
  const p = store.people['100000010'];
  eq('按 userId 建档', p.userId, '100000010');
  eq('同一个人在同一个群只算一个人', Object.keys(store.people).length, 1);
  eq('次数按群累计 17', p.groups['group:100000004'].count, 17);
  eq('msgCount=17', p.msgCount, 17);
  ok('affinityRef 只引用不复制分数', p.affinityRef?.file === 'state/affinity.json' && !('score' in p) && JSON.stringify(p).indexOf('"score"') < 0);
  eq('展示名取最近的别名', pickDisplayName(p), '聪明头哦鲸鲸');
}
{
  // 三种来源都进别名：card（群名片）> ledger（台账）> sender；同一个人不会因此多算次数。
  const s = emptyPeople();
  noteSighting(s, { userId: '42', name: '小明', source: 'sender', scope: 'group:1' });
  noteSighting(s, { userId: '42', name: '明明', source: 'card', scope: 'group:1', count: false });
  noteSighting(s, { userId: '42', name: '小明同学', source: 'ledger', scope: null, count: false });
  const aliases = s.people['42'].aliases.map((a) => `${a.name}/${a.source}`);
  ok('三种别名来源都进索引', aliases.length === 3 && aliases.some((x) => x.endsWith('/card')) && aliases.some((x) => x.endsWith('/ledger')) && aliases.some((x) => x.endsWith('/sender')), aliases.join(','));
  eq('补别名不重复计数', s.people['42'].msgCount, 1);
}
{
  // 别名规范化：去 @、纯数字不算名字、超长截断、重复大小写去重。
  eq('去 @ 前缀与空白', normalizeName('  @小明 '), '小明');
  eq('纯 QQ 号不当名字', normalizeName('100000010'), '');
  ok('超长截断到 24', len(normalizeName('长'.repeat(60))) === PEOPLE_DEFAULTS.nameMaxChars);
  const s = emptyPeople();
  noteSighting(s, { userId: '7', name: 'Abc', source: 'sender', scope: 'group:1' });
  noteSighting(s, { userId: '7', name: 'abc', source: 'sender', scope: 'group:1' });
  eq('别名大小写去重', s.people['7'].aliases.length, 1);
}
{
  // 别名上限 5：来源更可信的留下。
  const s = emptyPeople();
  for (let i = 0; i < 8; i += 1) noteSighting(s, { userId: '9', name: `名字${i}`, source: 'sender', scope: 'group:1', count: false });
  noteSighting(s, { userId: '9', name: '名片名', source: 'card', scope: 'group:1', count: false });
  eq('每人别名 ≤5', s.people['9'].aliases.length, 5);
  ok('名片名不会被挤掉', s.people['9'].aliases.some((a) => a.name === '名片名'));
}
{
  // 人数上限：超出按 lastSeenAt 淘汰最旧。
  const s = emptyPeople();
  for (let i = 0; i < 6; i += 1) noteSighting(s, { userId: String(100 + i), name: `人${i}`, source: 'sender', scope: 'group:1', at: NOW - (6 - i) * 100000 });
  noteSighting(s, { userId: '999', name: '新人', source: 'sender', scope: 'group:1', at: NOW, cfg: { maxPeople: 3 } });
  eq('人数上限 3', Object.keys(s.people).length, 3);
  ok('最旧的被淘汰', !s.people['100']);
}

const impressions = () => ['说话直接', '爱接梗'];
{
  const r = recallPeople(store, { text: '你认识隔壁的哦鲸鲸吗', scope: 'group:100000003', now: NOW, impressionFor: impressions });
  eq('部分名字（后缀）也能命中', r.mode, 'hit');
  ok('注入里带全名', r.text.includes('聪明头哦鲸鲸'), r.text);
  ok('注入里带次数', r.text.includes('17 次'), r.text);
  ok('注入里带话题（说得出聊过什么）', r.text.includes('聊过：'), r.text);
  ok('话题是「打包脚本/入口目录」这种技术向词块', /打包脚本|入口目录/.test(r.text), r.text);
  ok('注入里带印象（来自 memory 真源）', r.text.includes('说话直接'));
  ok('注入里带口径句', r.text.includes('不复述原话') && r.text.includes('不给第三人评分'));
  ok('注入 ≤200 字符', len(r.text) <= 200, `${len(r.text)} 字符`);
  ok('注入里没有好感度分数', !/好感度|\/\s*100\b/.test(r.text));
  ok('注入里没有群号', !/group:\d+/.test(r.text) && !/\d{6,}/.test(r.text), r.text);
}
{
  const p = store.people['100000010'];
  ok('档案里有人物级话题（不是只有整群摘要）', Array.isArray(p.recentTopics) && p.recentTopics.length > 0, JSON.stringify(p.recentTopics));
  ok('话题每条 ≤40 字', p.recentTopics.every((t) => [...t.text].length <= 40));
  ok('话题是归纳出来的词块，不是整句原话', !p.recentTopics.some((t) => String(t.text).includes('打包脚本又报错了')));
  ok('话题带来源群与时间', p.recentTopics.every((t) => t.groupId && t.at > 0));
  ok('口水话不会盖过技术话题（重复次数优先）', /打包脚本|入口目录|子系统/.test(p.recentTopics[0]?.text || ''), String(p.recentTopics[0]?.text));
}
{
  // 预算不够时：名字 + 至少 1 个话题必须保住。
  const r = recallPeople(store, { text: '哦鲸鲸呢', scope: 'group:100000003', now: NOW, impressionFor: impressions, maxChars: 70 });
  ok('预算不够时保名字 + 至少 1 个话题', r.text.includes('聪明头哦鲸鲸') && r.text.includes('聊过：') && len(r.text) <= 70, `${len(r.text)}：${r.text}`);
}
{
  // 第三个人名混进话题：不能点名第三人。
  const s = emptyPeople();
  noteSighting(s, { userId: 'A1', name: '阿鲸', source: 'sender', scope: 'group:X', text: '小明说打包脚本要改，入口目录也空' });
  noteSighting(s, { userId: 'B2', name: '小明', source: 'sender', scope: 'group:Y', text: '我在呢' });
  const r = recallPeople(s, { text: '阿鲸最近聊什么', scope: 'group:Z', now: NOW });
  ok('话题不点名第三人', r.text.includes('阿鲸') && !r.text.includes('小明'), r.text);
  ok('技术话题保留', /打包脚本|入口目录/.test(r.text), r.text);
}
{
  const r = recallPeople(store, { text: '今天吃什么', scope: 'group:100000003', now: NOW, impressionFor: impressions });
  eq('没提到任何人 → 0 注入', r.text, '');
  eq('没提到任何人 → mode=none', r.mode, 'none');
}
{
  const r = recallPeople(store, { text: '某某某最近在干嘛', scope: 'group:100000003', now: NOW, impressionFor: impressions });
  eq('不认识的名字（没有任何线索）→ 0 注入（允许说不认识）', r.text, '');
}
{
  // 名单模式：问「你们群/隔壁」，没点名但确实认识别处的人。
  const r = recallPeople(store, { text: '你认识隔壁的人吗', scope: 'group:100000003', now: NOW, impressionFor: impressions });
  eq('句式触发名单模式', r.mode, 'roster');
  ok('名单里有名字', r.text.includes('聪明头哦鲸鲸'), r.text);
  ok('名单模式也带「只认得出这些」', r.text.includes('只认得出这些'));
  ok('名单模式 ≤200 字符', len(r.text) <= 200);
}
{
  // 同名不同人：两个 userId 都有「小林」→ 不许混，明确说不确定。
  const s = emptyPeople();
  noteSighting(s, { userId: '1001', name: '小林', source: 'sender', scope: 'group:A' });
  noteSighting(s, { userId: '1002', name: '小林', source: 'sender', scope: 'group:B' });
  const r = recallPeople(s, { text: '小林最近怎么样', scope: 'group:C', now: NOW });
  eq('同名不同人 → ambiguous', r.mode, 'ambiguous');
  ok('明确说不确定/别硬认', r.text.includes('两个不同的人') && r.text.includes('别硬认'), r.text);
  ok('不混成一个人（不提次数）', !r.text.includes('出现过'), r.text);
}
{
  // 隐私：印象里混进分数时，那一条必须被过滤掉。
  const dirty = () => ['好感度 78/100 很高', '说话直接'];
  const r = recallPeople(store, { text: '哦鲸鲸呢', scope: 'group:100000003', now: NOW, impressionFor: dirty });
  ok('带分数的印象不注入', !r.text.includes('78') && !r.text.includes('好感度'), r.text);
  ok('干净的那条印象保留', r.text.includes('说话直接'));
}
{
  // 预算：超长时截断到 maxChars，不整段崩。
  const long = () => ['很长的印象'.repeat(30)];
  const r = recallPeople(store, { text: '哦鲸鲸', scope: 'group:100000003', now: NOW, impressionFor: long, maxChars: 200 });
  ok('超长截断到 200', len(r.text) <= 200, `${len(r.text)} 字符`);
  ok('截断也保留开头（人名）', r.text.startsWith('【认人】'));
}
{
  // 90 天未出现：降权不召回（数据仍保留）。
  const s = emptyPeople();
  noteSighting(s, { userId: '555', name: '老熟人', source: 'sender', scope: 'group:old', at: NOW - 120 * 86400000 });
  const r = recallPeople(s, { text: '老熟人最近怎样', scope: 'group:new', now: NOW });
  eq('超过 90 天不召回', r.text, '');
  ok('但档案还在（降权不删）', Boolean(s.people['555']));
}
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-test-'));
  const file = path.join(dir, 'people.json');
  savePeople(file, store);
  const back = loadPeople(file);
  eq('落盘/读回人数一致', Object.keys(back.people).length, Object.keys(store.people).length);
  eq('读回别名一致', back.people['100000010'].aliases[0].name, '聪明头哦鲸鲸');
  fs.writeFileSync(file, '{ this is not json');
  eq('坏 JSON 当空档案（不炸）', Object.keys(loadPeople(file).people).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  const stats = peopleStats(store, NOW);
  eq('统计：1 人', stats.people, 1);
  eq('统计：fresh=1', stats.fresh, 1);
}

console.log('\n[B] 真跑 bridge：默认关 = 0 注入 / 开启后按需注入');

const A = 'group:100000004';   // 哦鲸鲸在的群
const B = 'group:100000003';   // 用户提问的群
const h = await bridgeHarness({
  config: {
    allow: { private: ['123'], groups: ['456', '100000004', '100000003'] },
    socialV2: { wake: { preSleepWaitEnabled: false, preSleepWaitMs: 1000 }, memory: { people: { enabled: false } } }
  }
});
h.setMode('reserved2');
h.setSelfIdentity('大肥鱼小姐', '100000006');
const stateFile = path.join(h.temp, 'state/people.json');
const partsUrl = (key) => `/api/debug/prompt-parts?key=${encodeURIComponent(key)}`;

const server = h.startConsoleServer();
if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
const getParts = (key) => new Promise((resolve, reject) => {
  const req = http.request({
    hostname: '127.0.0.1', port: server.address().port, path: partsUrl(key), method: 'GET',
    headers: { 'x-console-token': 'fixture-console-token' }
  }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { data += c; });
    res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.end();
});
const append = (key, sender, text, userId) => h.appendSocialV2Message(key, sender, text, text, false, false,
  `m-${key}-${Date.now()}-${Math.random()}`, [], String(userId), []);
const partOf = (data, name) => (data.parts || []).find((p) => p.name === name) || null;

try {
  // 历史：哦鲸鲸在 A 群说过 17 次（回填的数据源）。
  h.getSocialV2State(A);
  for (let i = 0; i < 17; i += 1) {
    append(A, '聪明头哦鲸鲸', i % 2 === 0 ? '打包脚本又报错了，入口目录那边还是空的' : '入口目录的子系统没解压出来，验收要加一步', '100000010');
  }
  h.getSocialV2State(B);
  append(B, '路人', '今天好热', '222');

  // ① 默认关：即便历史里有她，也一个字都不注入，且不生成档案文件。
  const before = await getParts(B);
  {
    ok('默认关：没有 people 段', !partOf(before, 'people'));
    ok('默认关：不生成 state/people.json', !fs.existsSync(stateFile));
  }

  // ② 开启：先不追加新消息，只查一次 → 回填只读，不写盘。
  h.cfg.socialV2.memory.people.enabled = true;
  {
    const warm = await getParts(B);
    ok('开启后首次查询不会凭空写盘（回填只读）', !fs.existsSync(stateFile));
    ok('开启但还没问人：仍然没有 people 段', !partOf(warm, 'people'), JSON.stringify(partOf(warm, 'people')));
    // 「没提到人 → prompt 总长不变」：段集合与改前一致（people 没混进 parts）
    eq('没提到人时 parts 段名与开启前一致', JSON.stringify((warm.parts || []).map((p) => p.name)), JSON.stringify((before.parts || []).map((p) => p.name)));
  }

  // ③ 用户真机那句：@大肥鱼小姐 你认识隔壁的哦鲸鲸吗
  append(B, '用户', '@大肥鱼小姐 你认识隔壁的哦鲸鲸吗', '333');
  {
    const data = await getParts(B);
    const people = partOf(data, 'people');
    ok('问到人 → 出现 people 段', Boolean(people), JSON.stringify(people));
    ok('people 段 ≤202 字符（200 预算 + 两个换行）', people.chars <= 202, `${people?.chars} 字符`);
    ok('people 段确实有内容', people.chars > 20);
    ok('历史消息被回填后生成了档案文件', fs.existsSync(stateFile));
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const person = raw.people['100000010'];
    ok('档案里有她（按 userId）', Boolean(person));
    ok('档案别名含「聪明头哦鲸鲸」', person?.aliases?.some((a) => a.name === '聪明头哦鲸鲸'));
    ok('档案记了 A 群和次数', person?.groups?.[A]?.count >= 17, JSON.stringify(person?.groups));
    ok('档案里没有分数/好感度', !JSON.stringify(raw).includes('好感度') && !JSON.stringify(raw).match(/"score"/));
    ok('档案里有人物级话题', Array.isArray(person?.recentTopics) && person.recentTopics.length > 0, JSON.stringify(person?.recentTopics));

    // 验收用例的模拟自测：用真实落盘的档案再跑一次召回（不改任何状态），把注入段原文打出来。
    const live = loadPeople(stateFile);
    for (const q of ['你认识隔壁的哦鲸鲸吗', '哦鲸鲸最近在聊什么']) {
      const sim = recallPeople(live, { text: q, scope: B, now: Date.now() });
      console.log(`  … 验收模拟「${q}」→ ${[...sim.text].length} 字符：${sim.text}`);
      ok(`模拟「${q}」认得出名字`, sim.text.includes('聪明头哦鲸鲸'), sim.text);
      ok(`模拟「${q}」说得出聊过什么`, sim.text.includes('聊过：'), sim.text);
      ok(`模拟「${q}」不说 QQ 号`, !sim.text.includes('100000010'));
      ok(`模拟「${q}」≤200 字符`, [...sim.text].length <= 200);
    }
  }

  // ④ 没提到人：people 段必须消失（0 开销）。
  append(B, '路人', '晚上吃什么好', '222');
  {
    const data = await getParts(B);
    ok('没提到人 → people 段消失', !partOf(data, 'people'));
  }

  // ⑤ 不认识的名字 + 没有名单线索 → 不注入（允许她说「不认识」）。
  append(B, '用户', '你认识隔壁的某某某吗', '333');
  {
    const data = await getParts(B);
    const people = partOf(data, 'people');
    // 注意：名单模式会列出「你在别处认识的人」，这是允许的；但不能出现「某某某」这个人的档案。
    ok('不认识的名字不会被硬编成档案', !JSON.stringify(fs.readFileSync(stateFile, 'utf8')).includes('某某某'));
    if (people) ok('名单模式 ≤202 字符', people.chars <= 202, `${people.chars}`);
  }
} catch (error) {
  fail += 1;
  console.error('FAIL 用例异常：', error?.stack ?? error);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await h.close();
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exitCode = fail === 0 ? 0 : 1;
