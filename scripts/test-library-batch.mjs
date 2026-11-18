// 批量找号纯规则单测：状态表规整、待找队列、结果记账、建议号、进度文案。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const batch = await import(pathToFileURL(path.join(ROOT, 'src/library-batch.js')).href);
const {
  BATCH_RULES_VERSION, normalizeBatchState, batchStale, batchPending,
  markBatchEntry, batchProgress, suggestionFor, describeBatchProgress
} = batch;

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('## 状态表规整');
{
  const empty = normalizeBatchState(null);
  check('空值规整成 {version:1, entries:{}}', empty.version === 1 && Object.keys(empty.entries).length === 0);
  check('空表规则版本是当前版本', empty.rulesVersion === BATCH_RULES_VERSION);

  const dirty = normalizeBatchState({
    rulesVersion: 3,
    entries: {
      'g/c/a': { at: 1700000000000, pick: '1234567', auto: true, score: 0.856, title: 'A', candidates: 4 },
      'g/c/b': { at: 'nope', pick: 'abc', auto: true, score: 'x', candidates: -2 },
      '': { pick: '1234567' },
      'g/c/c': 'not-an-object'
    }
  });
  check('保留合法条目', dirty.entries['g/c/a'].pick === '1234567' && dirty.entries['g/c/a'].auto === true);
  check('分数保留两位', dirty.entries['g/c/a'].score === 0.86, String(dirty.entries['g/c/a'].score));
  check('坏号被清空且 auto 归 false', dirty.entries['g/c/b'].pick === '' && dirty.entries['g/c/b'].auto === false);
  check('坏 at / score / candidates 归零',
    dirty.entries['g/c/b'].at === 0 && dirty.entries['g/c/b'].score === 0 && dirty.entries['g/c/b'].candidates === 0);
  check('空 key 被丢掉', !Object.prototype.hasOwnProperty.call(dirty.entries, ''));
  check('非对象条目不进表', !Object.prototype.hasOwnProperty.call(dirty.entries, 'g/c/c'));
  check('规则版本读回来', dirty.rulesVersion === 3);
}

console.log('## 规则版本');
{
  check('规则版本不同 → 需要重找', batchStale({ rulesVersion: 0, entries: {} }) === true);
  check('规则版本相同 → 不必重找', batchStale({ rulesVersion: BATCH_RULES_VERSION, entries: {} }) === false);
}

console.log('## 待找队列');
{
  const cards = [
    { key: 'k1' },                                   // 没号没记录 → 要找
    { key: 'k2', boothId: '7654321' },               // 已经有号 → 跳过
    { key: 'k3' },                                   // 找过 → 跳过
    { key: 'k4' },                                   // 找过但没找到 → 默认跳过
    { key: 'k1' }                                    // 重复 key
  ];
  const state = {
    rulesVersion: BATCH_RULES_VERSION,
    entries: {
      k3: { at: 1, pick: '111111', auto: true },
      k4: { at: 2, pick: '', skipped: true }
    }
  };
  check('只挑没找过的', JSON.stringify(batchPending(cards, state)) === JSON.stringify(['k1']));
  check('force 会把找过的也找一遍（没号的）', JSON.stringify(batchPending(cards, state, { force: true })) === JSON.stringify(['k1', 'k3', 'k4']));
  check('规则版本变了会重找（没号的）', JSON.stringify(batchPending(cards, { ...state, rulesVersion: 0 })) === JSON.stringify(['k1', 'k3', 'k4']));
  check('limit 截断', batchPending([{ key: 'a' }, { key: 'b' }, { key: 'c' }], { entries: {} }, { limit: 2 }).length === 2);
  check('空列表不炸', batchPending(null, null).length === 0);

  // 限流/超时是「环境没给机会」，不算放弃：暂停解除后下一轮批量要自动捡回来，不让人手动点「只重试」。
  const transient = {
    rulesVersion: BATCH_RULES_VERSION,
    entries: {
      k5: { at: 3, pick: '', skipped: true, reasonCode: 'rate_limit' },
      k6: { at: 4, pick: '', skipped: true, reasonCode: 'timeout' },
      k7: { at: 5, pick: '', skipped: true, reasonCode: 'no_candidates' }
    }
  };
  const transientCards = [{ key: 'k5' }, { key: 'k6' }, { key: 'k7' }];
  const retried = batchPending(transientCards, transient);
  check('限流/超时的记录视作待找（不 force 也捡回来）', JSON.stringify(retried) === JSON.stringify(['k5', 'k6']), JSON.stringify(retried));
  check('无候选的记录仍然跳过（那是真搜过了）', !retried.includes('k7'));
  check('旧文件没有 reasonCode 时照旧跳过', JSON.stringify(batchPending([{ key: 'k4' }], state)) === '[]');
}

console.log('## 记账');
{
  const base = normalizeBatchState(null);
  const next = markBatchEntry(base, 'g/c/mew', { pick: '7850009', auto: true, score: 0.923, title: 'Mew', reason: '标题一致', candidates: 5, at: 42 });
  check('写入结果', next.entries['g/c/mew'].pick === '7850009');
  check('分数两位小数', next.entries['g/c/mew'].score === 0.92);
  check('不影响原对象', Object.keys(base.entries).length === 0);
  check('跳过（没 pick）标记 skipped', markBatchEntry(base, 'x', { pick: '' }).entries.x.skipped === true);
  check('非法号不写 pick', markBatchEntry(base, 'y', { pick: '12' }).entries.y.pick === '');
  check('规则版本写当前版本', next.rulesVersion === BATCH_RULES_VERSION);
  check('空 key 原样返回', markBatchEntry(base, '', { pick: '123456' }).entries[''] === undefined);
}

console.log('## 进度与建议');
{
  const state = markBatchEntry(markBatchEntry(normalizeBatchState(null), 'a', { pick: '1234567', score: 0.8 }), 'b', { pick: '' });
  const progress = batchProgress(state);
  check('进度统计', progress.total === 2 && progress.withPick === 1 && progress.skipped === 1, JSON.stringify(progress));
  check('进度文案（未跑）', describeBatchProgress(progress).includes('找过 2 件'));
  check('进度文案（跑着）', describeBatchProgress(progress, { running: true }).includes('正在找号'));
  check('空进度文案', describeBatchProgress(batchProgress(normalizeBatchState(null))).includes('还没批量找过'));

  check('没号时给出建议', suggestionFor({ key: 'a' }, state).boothId === '1234567');
  check('同号不再建议', suggestionFor({ key: 'a', boothId: '1234567' }, state) === null);
  check('别的号仍要建议（提示可以改绑）', suggestionFor({ key: 'a', boothId: '999999' }, state).boothId === '1234567');
  check('没记录不返回建议', suggestionFor({ key: 'zzz' }, state) === null);
  check('建议带分数与理由', suggestionFor({ key: 'a' }, state).score === 0.8);
}

console.log('');
console.log(`批量找号纯规则：通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
