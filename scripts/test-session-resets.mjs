import { readBridgeSource } from './bridge-source.mjs';
// D47：sessionResets（「距上次重建过了多少条」）落盘/恢复的回归测试。
//
// 这条记帐是 sessionRecycle（200 条/8h）与 D45 上下文预算 turns 兜底的共同依据。
// 它以前**从不落盘**（白名单式序列化漏字段），重启即归零 —— 等于阈值按「本次进程启动以来」算。
// 这里钉住两件事：①读写往返不丢不错；②脏数据（旧文件缺字段、垃圾值、坏 at）不会把业务弄坏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeSessionResets, packSessionResets, unpackSessionResets, MAX_ENTRIES } from '../src/session-resets.js';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('## 1. 往返：写出去再读回来，值一模一样');
{
  const before = {
    'group:100000006': { at: 1793035087960, count: 0, reason: 'budget' },
    'private:1000000003': { at: 1793000000000, count: 37, reason: 'messages' }
  };
  const onDisk = JSON.parse(JSON.stringify({ sessionResets: packSessionResets(before) }));
  const after = unpackSessionResets(onDisk.sessionResets);
  check('两条记录的 at/count/reason 全部还原',
    Object.keys(after).length === 2
    && after['group:100000006'].at === 1793035087960 && after['group:100000006'].reason === 'budget'
    && after['private:1000000003'].count === 37 && after['private:1000000003'].reason === 'messages',
    JSON.stringify(after));
  check('pack 后可以直接 JSON.stringify（不是 Object.create(null) 造成的问题）',
    typeof JSON.stringify(packSessionResets(before)) === 'string');
  check('pack 不修改入参', before['group:100000006'].count === 0 && before['private:1000000003'].count === 37);
}

console.log('## 2. 旧文件/脏数据：不炸、不误判');
{
  check('没有该字段（旧文件）→ 空对象', Object.keys(unpackSessionResets(undefined)).length === 0);
  check('null → 空对象', Object.keys(unpackSessionResets(null)).length === 0);
  check('数组 → 空对象（不是「把它当条目」）', Object.keys(unpackSessionResets([{ at: 1 }])).length === 0);
  check('字符串/数字 → 空对象', Object.keys(unpackSessionResets('x')).length === 0 && Object.keys(unpackSessionResets(42)).length === 0);
  const dirty = {
    'group:1': { at: 1000, count: 5, reason: 'budget' },
    'group:2': { count: 9, reason: 'age' },            // 没 at → 丢
    'group:3': { at: 'abc', count: 1 },                // at 非数字 → 丢
    'group:4': { at: 0 },                              // at=0 → 丢（0 是「没重建过」，不能当依据）
    'group:5': { at: 2000, count: -3, reason: 123 },   // count 负数→0；reason 非串→unknown
    'group:6': 'not-an-object',                        // 条目本身不是对象 → 丢
    'group:7': { at: 3000, count: '7' }                // count 是数字串 → 收下并转数
  };
  const clean = unpackSessionResets(dirty);
  check('缺 at / at 非数字 / at=0 的条目被丢掉（没有 at 就没法判断「多少条之后」）',
    !('group:2' in clean) && !('group:3' in clean) && !('group:4' in clean));
  check('非对象条目被丢掉', !('group:6' in clean));
  check('count 负数归 0、reason 非串归 unknown', clean['group:5'].count === 0 && clean['group:5'].reason === 'unknown');
  check('count 数字串转成数字', clean['group:7'].count === 7);
  check('干净的条目原样保留', clean['group:1'].at === 1000 && clean['group:1'].count === 5 && clean['group:1'].reason === 'budget');
}

console.log('## 3. 封顶：老会话不能把文件撑大');
{
  const many = {};
  for (let i = 0; i < MAX_ENTRIES + 40; i++) many[`group:${i}`] = { at: 1000 + i, count: 0, reason: 'age' };
  const capped = packSessionResets(many);
  const keys = Object.keys(capped);
  check(`条目数封顶在 ${MAX_ENTRIES}`, keys.length === MAX_ENTRIES, `实际 ${keys.length}`);
  check('留下的是 at 最新的那批（最老的 40 个被裁掉）',
    !('group:0' in capped) && !('group:39' in capped) && `group:${MAX_ENTRIES + 39}` in capped);
  check('边界值不炸（正好 MAX_ENTRIES 条全部保留）', Object.keys(packSessionResets(
    Object.fromEntries(Array.from({ length: MAX_ENTRIES }, (_, i) => [`k${i}`, { at: i + 1, count: 0 }]))
  )).length === MAX_ENTRIES);
}

console.log('## 4. 接线（静态断言）：bridge 的 save 与 load 都真的用了它');
{
  const bridge = readBridgeSource();
  check('bridge 引入了 session-resets 模块', /from '\.\/session-resets\.js'/.test(bridge));
  check('saveSocialV2State 里落盘 sessionResets（白名单漏字段就是这个坑）',
    /sessionResets: packSessionResets\(socialV2\.sessionResets\)/.test(bridge));
  check('loadSocialV2State 里恢复 sessionResets',
    /socialV2\.sessionResets = unpackSessionResets\(raw\?\.sessionResets\)/.test(bridge));
  check('恢复时打一行日志（重启后能从日志确认有没有恢复）',
    /已恢复 \$\{Object\.keys\(socialV2\.sessionResets\)\.length\} 个会话的重建记帐/.test(bridge));
  check('两个消费方读取路径没变（sessionRecycle 的条数、D45 的 turns 兜底）',
    /socialV2\.sessionResets\[key\]/.test(bridge) && /function messagesSinceSessionReset/.test(bridge)
    && /socialV2\.sessionResets\?\.\[key\]\?\.at/.test(bridge));
  check('sessionRecycle 仍会写 reason=budget / preset / messages / age 四种来源',
    ['budget', 'preset'].every((r) => bridge.includes(`reason: '${r}'`)) && /reason: tooMany \? 'messages' : 'age'/.test(bridge));
}

console.log('');
const total = pass + failures.length;
if (failures.length) {
  console.log(`❌ test-session-resets 失败 ${failures.length}/${total}`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log(`✅ test-session-resets 全部通过（${pass}/${total}）`);
assert.ok(normalizeSessionResets({}) !== null);
