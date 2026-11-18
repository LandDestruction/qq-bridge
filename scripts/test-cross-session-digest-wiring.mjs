#!/usr/bin/env node
import { readBridgeSource } from './bridge-source.mjs';
/**
 * D34 接线单测：确认 `src/bridge.js` 真的把摘要换成轻改版 + 时间兜底刷新 + 新鲜度标签。
 *
 * 为什么单独测接线：纯函数单测（test-cross-session-digest-v2.mjs）只能证明「函数对」，
 * 证明不了「线上跑的是它」。D34 之前的表现就是「模块都在，但摘要还是老的」——
 * 这类错只有把 bridge.js 的源码当被测对象才拦得住。
 *
 * 用法：node scripts/test-cross-session-digest-wiring.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshnessLabel, shouldRefreshDigest } from '../src/cross-session-digest-v2.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = readBridgeSource();

let pass = 0;
const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('bridge.js 从 cross-session-digest-v2 只导入接线层两个函数', () => {
  const m = bridge.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/cross-session-digest-v2\.js'/);
  assert.ok(m, '应有一行从 ./cross-session-digest-v2.js 的 import');
  assert.ok(m[1].includes('shouldRefreshDigest'), `应导入 shouldRefreshDigest：${m[1].trim()}`);
  assert.ok(m[1].includes('freshnessLabel'), `应导入 freshnessLabel：${m[1].trim()}`);
});

t('摘要重建走 cross-session-memory.js 的 buildDigest（单一真源，不再有第二份实现）', () => {
  const fn = bridge.slice(bridge.indexOf('function maybeRefreshDigest'), bridge.indexOf('function maybeRefreshDigest') + 1600);
  assert.ok(fn.includes('buildDigest({'), 'maybeRefreshDigest 应调用 buildDigest');
  assert.ok(!fn.includes('buildDigestV2('), '不该再调用兼容别名 buildDigestV2（单一真源）');
  assert.ok(/from\s*'\.\/cross-session-memory\.js'/.test(bridge), 'buildDigest 应来自 cross-session-memory.js');
  const v2 = bridge.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/cross-session-digest-v2\.js'/)[1];
  assert.ok(!v2.includes('buildDigestV2'), 'bridge 不该再从 v2 模块拿生成器');
});

t('渲染时把 disclosure 传进去（open/strict 可配置切换，默认 open）', () => {
  const i = bridge.indexOf('const disclosure =');
  assert.ok(i > 0, '渲染前应算出 disclosure');
  const seg = bridge.slice(i, i + 400);
  assert.ok(/cfgM\.disclosure\s*===\s*'strict'/.test(seg), "只有显式 'strict' 才切旧措辞");
  assert.ok(/:\s*'open'/.test(seg), "其它值一律按 'open'");
  // 取到 renderDigestBlock(...) 的整段（参数里有函数调用，不能用 [^)]* 截）
  const call = seg.slice(seg.indexOf('renderDigestBlock('), seg.indexOf('renderDigestBlock(') + 200);
  assert.ok(call.includes('disclosure'), `应把 disclosure 传进 renderDigestBlock：${call.slice(0, 120)}`);
});

t('刷新判定走 shouldRefreshDigest，并把 lastAt 传进去', () => {
  const fn = bridge.slice(bridge.indexOf('function maybeRefreshDigest'), bridge.indexOf('function maybeRefreshDigest') + 1600);
  assert.ok(fn.includes('shouldRefreshDigest({'), '应调用 shouldRefreshDigest');
  assert.ok(/lastAt/.test(fn), '应把当前摘要的 at 作为 lastAt 传入');
  assert.ok(fn.includes('verdict.refresh'), '应按 verdict.refresh 决定是否重建');
  assert.ok(fn.includes("verdict.why === 'age'"), '按年龄重建后应把计数器归零（否则会连着重两次）');
});

t('注入块给每条摘要加新鲜度，且可用 showFreshness=false 关掉', () => {
  const i = bridge.indexOf('const withAge =');
  assert.ok(i > 0, '渲染前应有 withAge 步骤');
  const seg = bridge.slice(i, i + 700);
  assert.ok(seg.includes('freshnessLabel('), '应调用 freshnessLabel');
  assert.ok(/showFreshness\s*===\s*false/.test(seg), '应有 showFreshness=false 的关闭开关（改措辞/省 token 时用）');
  assert.ok(seg.includes('（${label}）'), '标签应包在中文括号里，紧跟摘要');
});

t('刷新兜底年龄默认 2 小时、且不低于 5 分钟（防抖）', () => {
  const i = bridge.indexOf('Math.max(5 * 60 * 1000');
  assert.ok(i > 0, '应有 Math.max(5*60*1000, …) 的防抖下限');
  const seg = bridge.slice(i, i + 200);
  assert.ok(/2 \* 3600 \* 1000/.test(seg), `默认应为 2 小时：${seg.slice(0, 120)}`);
  assert.ok(seg.includes('refreshMaxAgeMs'), '应允许 cfgM.refreshMaxAgeMs 覆盖');
});

t('行为对照：旧逻辑会漏刷的那条，新判定必须刷', () => {
  const now = Date.now();
  const oldWouldRefresh = (count, every) => count % every === 0;
  // 线上实测：计数只到 14（回填不计），摘要 8.6 小时前
  assert.equal(oldWouldRefresh(14, 20), false, '旧逻辑此时不刷（这就是 8.6h 不更新的原因）');
  assert.equal(shouldRefreshDigest({ count: 14, lastAt: now - 8.6 * 3600 * 1000, now }).refresh, true, '新逻辑此时必须刷');
});

t('新鲜度文案与线上一致（刚刚 / N 小时前 / N 天前）', () => {
  const now = 1793100000000;
  assert.equal(freshnessLabel(now - 30 * 1000, now), '刚刚');
  assert.equal(freshnessLabel(now - 5 * 3600 * 1000, now), '5 小时前');
  assert.equal(freshnessLabel(now - 26 * 3600 * 1000, now), '1 天前');
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
console.log(`\n${process.exitCode ? '❌' : '🎉'} D34 接线单测：${pass}/${cases.length}`);
