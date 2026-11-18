// 本地画面记忆（按 dhash 查表）的单测：纯函数，不碰磁盘、不碰网络。
import assert from 'node:assert/strict';
import {
  normalizeImageMemory, hammingHex, findImageMemory, rememberImage, imageMemoryLine,
  DEFAULT_MAX_DISTANCE,
} from '../src/image-memory.js';

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const H = '0123456789abcdef';
const H1 = '0123456789abcdee'; // 与 H 差 1 bit

console.log('[1] 归一化');
{
  const mem = normalizeImageMemory({ version: 1, entries: [
    { h: H, d: '一只猫', k: 'sticker', at: 100, n: 2 },
    { h: H, d: '重复的猫', k: 'image' },
    { h: 'zz', d: '非法 hash' },
    { h: '1111222233334444', d: '' },
  ] });
  ok('丢掉非法 hash/空描述、同 hash 去重', mem.entries.length === 1, String(mem.entries.length));
  ok('同 hash 去重（保留第一条）', mem.entries[0].d === '一只猫');
  ok('kind 只允许 sticker/image', mem.entries.every((e) => e.k === 'sticker' || e.k === 'image'));
  ok('数字字段归一', mem.entries[0].n === 2 && mem.entries[0].at === 100);
  ok('空输入不炸', normalizeImageMemory(null).entries.length === 0);
}

console.log('[2] 汉明距离');
{
  ok('自身距离 0', hammingHex(H, H) === 0);
  ok('差 1 bit', hammingHex(H, H1) === 1);
  ok('长度异常给 64', hammingHex('abc', H) === 64);
}

console.log('[3] 查表');
{
  const store = { entries: [{ h: H, d: '猫', k: 'sticker', n: 3 }, { h: 'ffffffffffffffff', d: '狗' }] };
  const exact = findImageMemory(store, H);
  ok('精确命中', exact?.entry.d === '猫' && exact.distance === 0);
  const near = findImageMemory(store, H1);
  ok('近似命中（≤6 bit）', near?.entry.d === '猫' && near.distance === 1);
  ok('差太远不命中', findImageMemory(store, 'aaaaaaaaaaaaaaaa') === null);
  ok('非法 hash 不命中', findImageMemory(store, 'xyz') === null);
  ok('阈值可调', findImageMemory(store, 'aaaaaaaaaaaaaaaa', { maxDistance: 64 }) !== null);
  ok('默认阈值是 6', DEFAULT_MAX_DISTANCE === 6);
}

console.log('[4] 记忆写入');
{
  const r1 = rememberImage({ entries: [] }, { hash: H, desc: '一只橘猫', kind: 'sticker' }, { now: 1000 });
  ok('新增', r1.added === true && r1.store.entries.length === 1);
  ok('描述落库', r1.store.entries[0].d === '一只橘猫');
  ok('kind 落库', r1.store.entries[0].k === 'sticker');

  const r2 = rememberImage(r1.store, { hash: H, desc: '橘猫趴着' }, { now: 2000 });
  ok('同 hash 更新而非新增', r2.updated === true && r2.store.entries.length === 1);
  ok('描述被刷新', r2.store.entries[0].d === '橘猫趴着');
  ok('计数 +1', r2.store.entries[0].n === 1);

  const bad = rememberImage(r1.store, { hash: 'nope', desc: 'x' }, {});
  ok('非法 hash 不写', bad.store.entries.length === 1 && bad.added === false);

  const empty = rememberImage(r1.store, { hash: '9999000099990000', desc: '' }, {});
  ok('空描述不写', empty.store.entries.length === 1);
}

console.log('[5] 上限淘汰');
{
  let store = { entries: [] };
  for (let i = 0; i < 5; i += 1) {
    store = rememberImage(store, { hash: `000000000000000${i}`, desc: `图${i}` }, { now: i, maxEntries: 10 }).store;
  }
  // 让 0 号用得最多，然后塞到超过上限
  store.entries[0].n = 99;
  for (let i = 5; i < 12; i += 1) {
    store = rememberImage(store, { hash: `00000000000000${i.toString(16)}0`, desc: `图${i}` }, { now: i, maxEntries: 8 }).store;
  }
  ok('不超过上限', store.entries.length <= 8, String(store.entries.length));
  ok('高频条被保留', store.entries.some((e) => e.h === '0000000000000000'), JSON.stringify(store.entries.map((e) => e.h)));
}

console.log('[6] 提示词行');
{
  const line = imageMemoryLine('[表情2]', { d: '一只白猫在鼓掌', n: 4 });
  ok('标明是本地图库认出来的', line.includes('本地图库') && line.includes('dhash'), line);
  ok('带命中次数', line.includes('4'), line);
  ok('带描述', line.includes('白猫'), line);
  ok('没有描述时回空串', imageMemoryLine('[图片1]', { d: '' }) === '');
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
if (fail) process.exitCode = 1;
assert.ok(pass >= 20);
