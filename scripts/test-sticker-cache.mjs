// 表情缩略图缓存的清理/重试计划（纯函数）。真机问题背景：
// state/sticker-files 207MB 超过 200MB 上限 → 新表情落盘一律失败标 missing；544 个文件里 204 个孤儿；
// 27 条 missing 没有 md5，旧逻辑「missing && 无 md5 永不重试」→ 必须能算出该删谁、该重试谁。
import assert from 'node:assert/strict';

import {
  STICKER_CACHE_KEEP_RATIO,
  STICKER_CACHE_MIN_AGE_MS,
  STICKER_REPAIR_DEFAULT_LIMIT,
  STICKER_REPAIR_MAX_LIMIT,
  THUMB_RETRYABLE_REASONS,
  describeThumbError,
  nextThumbRepairPlan,
  normalizeStickerCacheStats,
  planStickerCacheCleanup
} from '../src/sticker-cache.js';

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`❌ ${name}`);
    console.error(`   ${error?.message ?? error}`);
  }
}
const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const file = (md5, bytes, ageDays = 10, extra = {}) => ({ name: `${md5}.img`, md5, bytes, mtimeMs: NOW - ageDays * DAY, ...extra });

console.log('## 常量');
check('THUMB_RETRYABLE_REASONS 含 cache-limit / evicted', () => {
  assert.ok(THUMB_RETRYABLE_REASONS.has('cache-limit'));
  assert.ok(THUMB_RETRYABLE_REASONS.has('evicted'));
});
check('THUMB_RETRYABLE_REASONS 不含过期/网络（这两类重试也没用）', () => {
  assert.ok(!THUMB_RETRYABLE_REASONS.has('expired-url'));
  assert.ok(!THUMB_RETRYABLE_REASONS.has('network'));
  assert.ok(!THUMB_RETRYABLE_REASONS.has('other'));
});
check('常量取值：0.9 / 1 小时 / 默认 20 / 上限 200', () => {
  assert.equal(STICKER_CACHE_KEEP_RATIO, 0.9);
  assert.equal(STICKER_CACHE_MIN_AGE_MS, 3600000);
  assert.equal(STICKER_REPAIR_DEFAULT_LIMIT, 20);
  assert.equal(STICKER_REPAIR_MAX_LIMIT, 200);
});

console.log('## planStickerCacheCleanup：孤儿');
const entriesA = {
  k1: { md5: 'a', lastUsedAt: 100 },
  k2: { md5: 'b', lastUsedAt: 200 },
  k3: { md5: 'c', updatedAt: 300 }
};
check('孤儿 = 文件名 md5 不在库 + 超过 minAge', () => {
  const plan = planStickerCacheCleanup({
    entries: entriesA,
    files: [file('a', 100), file('b', 100), file('c', 100), file('orphan1', 100)],
    limitBytes: 10000,
    now: NOW
  });
  assert.deepEqual(plan.orphanFiles.map((f) => f.md5), ['orphan1']);
  assert.deepEqual(plan.lruFiles, []);
});
check('刚写入的孤儿（未过 minAge）不删', () => {
  const plan = planStickerCacheCleanup({
    entries: entriesA,
    files: [file('a', 100), file('fresh-orphan', 100, 0)],
    limitBytes: 1000,
    now: NOW
  });
  assert.deepEqual(plan.orphanFiles, []);
  assert.equal(plan.keepBytes, 200);
});
check('minAgeMs 可调（传 0 时不保护新文件）', () => {
  const plan = planStickerCacheCleanup({ entries: entriesA, files: [file('a', 100), file('x', 100, 0)], limitBytes: 1000, minAgeMs: 0, now: NOW });
  assert.deepEqual(plan.orphanFiles.map((f) => f.md5), ['x']);
});
check('freedBytes / keepBytes 与实际删除量一致', () => {
  const plan = planStickerCacheCleanup({
    entries: entriesA,
    files: [file('a', 100), file('b', 100), file('c', 100), file('o', 250)],
    limitBytes: 10000,
    now: NOW
  });
  assert.equal(plan.freedBytes, 250);
  assert.equal(plan.keepBytes, 300);
  assert.equal(plan.totalBytes, 550);
});
check('孤儿也有 evictedKeys（key 为空串、reason=orphan）', () => {
  const plan = planStickerCacheCleanup({ entries: entriesA, files: [file('o', 100)], limitBytes: 1000, now: NOW });
  assert.deepEqual(plan.evictedKeys, [{ md5: 'o', key: '', reason: 'orphan' }]);
});
check('entries 传数组也能识别（key/md5 都在）', () => {
  const plan = planStickerCacheCleanup({
    entries: [{ key: 'k1', md5: 'a' }, { key: 'k2', md5: 'b' }],
    files: [file('a', 10), file('b', 10), file('c', 10)],
    limitBytes: 1000,
    now: NOW
  });
  assert.deepEqual(plan.orphanFiles.map((f) => f.md5), ['c']);
});

console.log('## planStickerCacheCleanup：LRU');
const lruEntries = { k1: { md5: 'a', lastUsedAt: 100 }, k2: { md5: 'b', lastUsedAt: 200 }, k3: { md5: 'c', lastUsedAt: 300 } };
check('不超限时不跑 LRU', () => {
  const plan = planStickerCacheCleanup({ entries: lruEntries, files: [file('a', 100), file('b', 100)], limitBytes: 1000, now: NOW });
  assert.deepEqual(plan.lruFiles, []);
  assert.equal(plan.overLimit, false);
});
check('超限时按最久没用先删，删到 ≤ limit×0.9', () => {
  const plan = planStickerCacheCleanup({
    entries: lruEntries,
    files: [file('a', 100), file('b', 100), file('c', 100), file('o', 100)],
    limitBytes: 150,
    now: NOW
  });
  assert.deepEqual(plan.lruFiles.map((f) => f.md5), ['a', 'b']);
  assert.equal(plan.keepBytes, 100);
  assert.ok(plan.keepBytes <= 150 * STICKER_CACHE_KEEP_RATIO);
});
check('用到最近的条目保住（c 不动）', () => {
  const plan = planStickerCacheCleanup({ entries: lruEntries, files: [file('a', 100), file('b', 100), file('c', 100)], limitBytes: 260, now: NOW });
  assert.deepEqual(plan.lruFiles.map((f) => f.md5), ['a']);
  assert.ok(!plan.lruFiles.some((f) => f.md5 === 'c'));
});
check('lastUsedAt 相同则 mtime 更老的先删', () => {
  const entries = { k1: { md5: 'a', lastUsedAt: 500 }, k2: { md5: 'b', lastUsedAt: 500 } };
  const plan = planStickerCacheCleanup({
    entries,
    files: [file('a', 100, 1), file('b', 100, 20)],
    limitBytes: 150,
    now: NOW
  });
  assert.deepEqual(plan.lruFiles.map((f) => f.md5), ['b']);
});
check('evictedKeys 的 lru 条目带真实 key', () => {
  const plan = planStickerCacheCleanup({ entries: { 'group:1|sticker:9': { md5: 'a', lastUsedAt: 1 } }, files: [file('a', 100)], limitBytes: 10, now: NOW });
  assert.deepEqual(plan.evictedKeys, [{ md5: 'a', key: 'group:1|sticker:9', reason: 'lru' }]);
});
check('evictedKeys 集合 === 实际被删文件集合', () => {
  const plan = planStickerCacheCleanup({
    entries: lruEntries,
    files: [file('a', 100), file('b', 100), file('c', 100), file('o', 100)],
    limitBytes: 150,
    now: NOW
  });
  const deleted = new Set([...plan.orphanFiles, ...plan.lruFiles].map((f) => f.md5));
  assert.deepEqual(plan.evictedKeys.map((e) => e.md5).sort(), [...deleted].sort());
});
check('limitBytes=0 当「没配上上限」：只清孤儿，不删在用文件', () => {
  const plan = planStickerCacheCleanup({ entries: lruEntries, files: [file('a', 100), file('b', 100), file('o', 100)], limitBytes: 0, now: NOW });
  assert.deepEqual(plan.orphanFiles.map((f) => f.md5), ['o']);
  assert.deepEqual(plan.lruFiles, []);
  assert.equal(plan.keepBytes, 200);
});
check('limitBytes 非法/未传当不设上限（只清孤儿）', () => {
  const plan = planStickerCacheCleanup({ entries: lruEntries, files: [file('a', 100), file('o', 100)], now: NOW });
  assert.deepEqual(plan.orphanFiles.map((f) => f.md5), ['o']);
  assert.deepEqual(plan.lruFiles, []);
  assert.equal(plan.keepBytes, 100);
});
check('空输入不抛，全零', () => {
  const plan = planStickerCacheCleanup();
  assert.deepEqual(plan, { orphanFiles: [], lruFiles: [], keepBytes: 0, freedBytes: 0, evictedKeys: [], totalBytes: 0, limitBytes: 0, overLimit: false });
});
check('文件名没给 md5 时按去扩展名推断', () => {
  const plan = planStickerCacheCleanup({
    entries: lruEntries,
    files: [{ name: 'a.img', bytes: 10, mtimeMs: NOW - 10 * DAY }, { name: 'zzz.png', bytes: 10, mtimeMs: NOW - 10 * DAY }],
    limitBytes: 1000,
    now: NOW
  });
  assert.deepEqual(plan.orphanFiles.map((f) => f.md5), ['zzz']);
});

console.log('## nextThumbRepairPlan');
const repairEntries = {
  'k:p1': { md5: 'm1', url: 'https://x/1', thumbStatus: 'missing', thumbErrorKind: 'cache-limit' },
  'k:p2': { md5: 'm2', url: 'https://x/2', thumbStatus: 'missing', thumbError: '本地表情缓存已达上限（200MB），跳过落盘' },
  'k:p3': { url: 'https://x/3', thumbStatus: 'missing', thumbError: '链接过期' },
  'k:p4': { md5: 'm4', url: 'https://x/4', thumbStatus: 'ok' },
  'k:p5': { md5: 'm5', url: 'https://x/5', thumbStatus: 'missing', thumbErrorKind: 'expired-url' },
  'k:p6': { thumbStatus: 'missing', thumbError: '网络超时' },
  'k:p7': { md5: 'm7', url: 'https://x/7', thumbStatus: 'ok' },
  'k:p8': { md5: 'm8', url: 'https://x/8', thumbStatus: 'missing', thumbErrorKind: 'evicted' }
};
const hasCached = (md5) => md5 === 'm7';
check('三类优先级与排序（重试 → 无 md5 → 文件丢失）', () => {
  const plan = nextThumbRepairPlan({ entries: repairEntries, limit: 50, hasCached });
  assert.deepEqual(plan.items.map((i) => i.key), ['k:p1', 'k:p2', 'k:p8', 'k:p3', 'k:p4']);
  assert.deepEqual(plan.items.map((i) => i.priority), [1, 1, 1, 2, 3]);
});
check('missing + 可重试原因（cache-limit）进第一档', () => {
  const plan = nextThumbRepairPlan({ entries: repairEntries, limit: 50, hasCached });
  const hit = plan.items.find((i) => i.key === 'k:p1');
  assert.equal(hit.priority, 1);
  assert.equal(hit.reason, 'cache-limit');
});
check('thumbError 中文文案也能判成 cache-limit', () => {
  const plan = nextThumbRepairPlan({ entries: repairEntries, limit: 50, hasCached });
  assert.equal(plan.items.find((i) => i.key === 'k:p2').reason, 'cache-limit');
});
check('missing 且无 md5（有 url）进第二档', () => {
  const plan = nextThumbRepairPlan({ entries: repairEntries, limit: 50, hasCached });
  const hit = plan.items.find((i) => i.key === 'k:p3');
  assert.equal(hit.priority, 2);
  assert.equal(hit.reason, 'no-md5');
});
check('状态 ok 但本地文件没了（hasCached=false）进第三档', () => {
  const plan = nextThumbRepairPlan({ entries: repairEntries, limit: 50, hasCached });
  const hit = plan.items.find((i) => i.key === 'k:p4');
  assert.equal(hit.priority, 3);
  assert.equal(hit.reason, 'file-gone');
});
check('missing 但原因是过期链接的不重试', () => {
  const plan = nextThumbRepairPlan({ entries: repairEntries, limit: 50, hasCached });
  assert.ok(!plan.items.some((i) => i.key === 'k:p5'));
});
check('无 url 且无 md5 的跳过（重试也没用）', () => {
  const plan = nextThumbRepairPlan({ entries: repairEntries, limit: 50, hasCached });
  assert.ok(!plan.items.some((i) => i.key === 'k:p6'));
});
check('hasCached 说文件还在的 ok 条目不动', () => {
  const plan = nextThumbRepairPlan({ entries: repairEntries, limit: 50, hasCached });
  assert.ok(!plan.items.some((i) => i.key === 'k:p7'));
});
check('不传 hasCached 时不报「文件丢失」（不能瞎猜）', () => {
  const plan = nextThumbRepairPlan({ entries: repairEntries, limit: 50 });
  assert.ok(!plan.items.some((i) => i.priority === 3));
});
check('limit 截断 + truncated/total 正确', () => {
  const plan = nextThumbRepairPlan({ entries: repairEntries, limit: 2, hasCached });
  assert.equal(plan.items.length, 2);
  assert.equal(plan.truncated, true);
  assert.equal(plan.total, 5);
  assert.equal(plan.limit, 2);
});
check('limit 超上限被夹到 200', () => {
  assert.equal(nextThumbRepairPlan({ entries: repairEntries, limit: 9999 }).limit, STICKER_REPAIR_MAX_LIMIT);
});
check('limit=0 表示这次不修（不回落默认值）', () => {
  const plan = nextThumbRepairPlan({ entries: repairEntries, limit: 0, hasCached });
  assert.equal(plan.items.length, 0);
  assert.equal(plan.limit, 0);
  assert.equal(plan.truncated, false);
});
check('limit 未传用默认 20', () => {
  assert.equal(nextThumbRepairPlan({ entries: repairEntries, hasCached }).limit, STICKER_REPAIR_DEFAULT_LIMIT);
});
check('同 md5 多条目只修一次（去重）', () => {
  const plan = nextThumbRepairPlan({
    entries: {
      a: { md5: 'dup', url: 'u', thumbStatus: 'missing', thumbErrorKind: 'cache-limit' },
      b: { md5: 'dup', url: 'u', thumbStatus: 'missing', thumbErrorKind: 'evicted' }
    },
    limit: 10
  });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].md5, 'dup');
});
check('空 entries 返回空计划', () => {
  assert.deepEqual(nextThumbRepairPlan({ entries: [], limit: 5 }), { items: [], total: 0, truncated: false, limit: 5 });
});

console.log('## describeThumbError');
check('中文「缓存已达上限」→ cache-limit', () => assert.equal(describeThumbError('本地表情缓存已达上限（200MB），跳过落盘'), 'cache-limit'));
check('英文 cache limit / ENOSPC → cache-limit', () => {
  assert.equal(describeThumbError('cache limit reached'), 'cache-limit');
  assert.equal(describeThumbError('ENOSPC: no space left on device'), 'cache-limit');
});
check('「淘汰」/evicted → evicted', () => {
  assert.equal(describeThumbError('缓存淘汰：文件已被清理'), 'evicted');
  assert.equal(describeThumbError('evicted by lru'), 'evicted');
});
check('「过期」/expired/403 → expired-url', () => {
  assert.equal(describeThumbError('图片链接已过期'), 'expired-url');
  assert.equal(describeThumbError('HTTP 403 Forbidden'), 'expired-url');
  assert.equal(describeThumbError('signed url expired'), 'expired-url');
});
check('「网络」/timeout/ENOENT → network', () => {
  assert.equal(describeThumbError('网络超时'), 'network');
  assert.equal(describeThumbError('request timeout'), 'network');
  assert.equal(describeThumbError('ENOENT: no such file'), 'network');
});
check('无法识别 → other（空值也是 other）', () => {
  assert.equal(describeThumbError('something weird happened'), 'other');
  assert.equal(describeThumbError(''), 'other');
  assert.equal(describeThumbError(null), 'other');
});
check('大小写不敏感', () => assert.equal(describeThumbError('CACHE LIMIT'), 'cache-limit'));

console.log('## normalizeStickerCacheStats');
const statEntries = {
  a: { md5: 'a', thumbStatus: 'ok' },
  b: { md5: 'b-missing-file', thumbStatus: 'ok' },
  c: { md5: 'c', url: 'u', thumbStatus: 'missing', thumbErrorKind: 'cache-limit' },
  d: { url: 'u', thumbStatus: 'missing', thumbError: '链接过期' },
  e: { thumbStatus: 'missing', thumbError: '网络超时' },
  f: { md5: 'f', url: 'u', thumbStatus: 'missing', thumbErrorKind: 'expired-url' }
};
const statFiles = [{ name: 'a.img', md5: 'a', bytes: 100, mtimeMs: NOW }, { name: 'o.img', md5: 'orphan', bytes: 50, mtimeMs: NOW }];
check('entries/withThumb/missing 计数', () => {
  const stats = normalizeStickerCacheStats({ entries: statEntries, files: statFiles, limitBytes: 100 });
  assert.equal(stats.entries, 6);
  assert.equal(stats.withThumb, 1);
  assert.equal(stats.missing, 4);
});
check('retryable = 可重试原因 + 无 md5 的 missing（2 条）', () => {
  const stats = normalizeStickerCacheStats({ entries: statEntries, files: statFiles, limitBytes: 100 });
  assert.equal(stats.retryable, 2);
});
check('orphanFiles / bytes 正确', () => {
  const stats = normalizeStickerCacheStats({ entries: statEntries, files: statFiles, limitBytes: 1000 });
  assert.equal(stats.orphanFiles, 1);
  assert.equal(stats.bytes, 150);
});
check('overLimit 与 usageRatio（4 位小数）', () => {
  const stats = normalizeStickerCacheStats({ entries: statEntries, files: statFiles, limitBytes: 100 });
  assert.equal(stats.overLimit, true);
  assert.equal(stats.usageRatio, 1.5);
  const under = normalizeStickerCacheStats({ entries: statEntries, files: statFiles, limitBytes: 150 });
  assert.equal(under.overLimit, false);
  assert.equal(under.usageRatio, 1);
});
check('limitBytes=0 时 usageRatio 记 Infinity 且 overLimit=false（不设上限语义）', () => {
  const stats = normalizeStickerCacheStats({ entries: statEntries, files: statFiles, limitBytes: 0 });
  assert.equal(stats.usageRatio, Infinity);
  assert.equal(stats.overLimit, false);
  assert.equal(stats.limitBytes, 0);
});
check('空输入不抛，全零（usageRatio 为 Infinity）', () => {
  const stats = normalizeStickerCacheStats();
  assert.deepEqual({ entries: stats.entries, withThumb: stats.withThumb, missing: stats.missing, retryable: stats.retryable, orphanFiles: stats.orphanFiles, bytes: stats.bytes, overLimit: stats.overLimit }, { entries: 0, withThumb: 0, missing: 0, retryable: 0, orphanFiles: 0, bytes: 0, overLimit: false });
  assert.equal(stats.usageRatio, Infinity);
});
check('真机口径复算（207.3MB / 544 文件 / 200MB 上限）', () => {
  const stats = normalizeStickerCacheStats({
    entries: Array.from({ length: 500 }, (_, i) => ({ md5: `m${i}`, thumbStatus: i < 472 ? 'ok' : 'missing', ...(i >= 472 ? { thumbErrorKind: 'cache-limit', url: 'u' } : {}) })),
    files: Array.from({ length: 544 }, (_, i) => ({ name: `m${i}.img`, md5: `m${i}`, bytes: 400 * 1024, mtimeMs: NOW })),
    limitBytes: 200 * 1024 * 1024
  });
  assert.equal(stats.entries, 500);
  assert.equal(stats.withThumb, 472);
  assert.equal(stats.missing, 28);
  assert.equal(stats.retryable, 28);
  assert.equal(stats.orphanFiles, 44);
  assert.equal(stats.overLimit, true);
  assert.ok(stats.usageRatio > 1);
});

if (failures.length) {
  console.error(`\n❌ test-sticker-cache 失败 ${failures.length} 项`);
  process.exit(1);
}
console.log(`\n🎉 test-sticker-cache 全部通过（${passed} 项）`);
