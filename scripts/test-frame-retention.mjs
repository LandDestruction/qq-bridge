import assert from 'node:assert/strict';
import { frameRetentionCfg, planFrameDeletions, FRAME_MIN_AGE_MS } from '../src/frame-retention.js';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); } catch (e) { failed += 1; console.error(`❌ ${name} — ${e?.message ?? e}`); }
}
const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 9, 25, 8, 0, 0);
const mk = (i, ageDays, bytes = 1000) => ({ name: `f${i}.png`, bytes, mtimeMs: NOW - ageDays * DAY });

check('配置：非法值回落默认，天数至少 1', () => {
  assert.deepEqual(frameRetentionCfg({}), { retentionDays: 7, maxTotalBytes: 100 * 1024 * 1024 });
  assert.equal(frameRetentionCfg({ frameRetentionDays: -3 }).retentionDays, 7);
  assert.equal(frameRetentionCfg({ frameRetentionDays: 0.2 }).retentionDays, 1);
});

check('10 个文件里 5 个超过 7 天 → 只删这 5 个', () => {
  const files = [...Array(5)].map((_, i) => mk(i, 10)).concat([...Array(5)].map((_, i) => mk(i + 5, 1)));
  const { drop } = planFrameDeletions(files, { now: NOW, retentionDays: 7, maxTotalBytes: 1e12 });
  assert.equal(drop.length, 5);
  assert.ok(drop.every((n) => Number(n.slice(1, -4)) < 5), '删的必须都是老的那批');
});

check('总量超限 → 按 mtime 从最老删到低于阈值', () => {
  const files = [...Array(10)].map((_, i) => mk(i, 0.5 + i, 10 * 1024 * 1024)); // 各 10MB，共 100MB
  const { drop, keepBytes } = planFrameDeletions(files, { now: NOW, retentionDays: 7, maxTotalBytes: 30 * 1024 * 1024 });
  assert.ok(keepBytes <= 30 * 1024 * 1024, `保留量必须低于阈值（实得 ${keepBytes}）`);
  assert.ok(drop.length >= 7, `至少要删到阈值以下（实得 ${drop.length} 个）`);
  // 这批文件是 mk(i, 0.5 + i)：i 越大越老，所以最先被删的应该是 f9、f8…
  const idx = drop.map((n) => Number(n.slice(1, -4)));
  assert.deepEqual(idx, idx.slice().sort((a, b) => b - a), '必须从最老的（i 最大）开始删');
});

check('1 天内的帧一律不删（发送重试窗口保护）', () => {
  const files = [mk(0, 0.1), mk(1, 0.9)];
  const { drop } = planFrameDeletions(files, { now: NOW, retentionDays: 1, maxTotalBytes: 1024 * 1024 * 1024 });
  assert.deepEqual(drop, [], '年龄门槛不得低于 1 天');
  assert.equal(FRAME_MIN_AGE_MS, DAY);
});

check('空列表/非法输入不抛', () => {
  assert.deepEqual(planFrameDeletions(null, { now: NOW }).drop, []);
  assert.deepEqual(planFrameDeletions([null, {}, { name: 'x', bytes: 0, mtimeMs: 0 }], { now: NOW }).drop, ['x']);
});

if (failed) { console.error(`\n❌ 帧保留策略测试失败（${failed} 项）`); process.exit(1); }
console.log('\n🎉 帧保留策略测试通过');
