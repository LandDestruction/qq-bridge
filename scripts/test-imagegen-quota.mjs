import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quotaDay, normalizeQuota, takeQuota, refundQuota, readQuota, writeQuota } from '../src/imagegen-quota.js';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); } catch (e) { failed += 1; console.error(`❌ ${name} — ${e?.message ?? e}`); }
}
const NOW = Date.UTC(2026, 9, 25, 4, 0, 0); // 北京时间 12:00

check('quotaDay 按北京时间算自然日', () => {
  assert.equal(quotaDay(NOW), '2026-10-25');
  assert.equal(quotaDay(Date.UTC(2026, 9, 25, 15, 59, 0)), '2026-10-25'); // 北京 23:59
  assert.equal(quotaDay(Date.UTC(2026, 9, 25, 16, 1, 0)), '2026-10-26'); // 北京 00:01
});

check('跨日期 → used 归零', () => {
  assert.deepEqual(normalizeQuota({ date: '2026-10-24', used: 30 }, NOW), { date: '2026-10-25', used: 0 });
  assert.deepEqual(normalizeQuota({ date: '2026-10-25', used: 7 }, NOW), { date: '2026-10-25', used: 7 });
});

check('未超限 → 占用成功且 used+1', () => {
  const r = takeQuota({ date: '2026-10-25', used: 7 }, { dailyLimit: 30, atMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.state.used, 8);
});

check('到达上限 → 拒绝并给可读原因（调用方回落免费通道）', () => {
  const r = takeQuota({ date: '2026-10-25', used: 30 }, { dailyLimit: 30, atMs: NOW });
  assert.equal(r.ok, false);
  assert.match(r.reason, /用完了/);
});

check('回滚不会变负', () => {
  assert.equal(refundQuota({ date: '2026-10-25', used: 0 }, NOW).used, 0);
  assert.equal(refundQuota({ date: '2026-10-25', used: 3 }, NOW).used, 2);
});

check('持久化：写盘再读回，重启不复活（同一天 used 保留）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-quota-'));
  const file = path.join(dir, 'imagegen-quota.json');
  let s = readQuota(file, fs, NOW);
  assert.equal(s.used, 0, '文件不存在时按 0');
  for (let i = 0; i < 5; i += 1) {
    const r = takeQuota(s, { dailyLimit: 30, atMs: NOW });
    s = r.state; writeQuota(file, s, fs);
  }
  assert.equal(readQuota(file, fs, NOW).used, 5, '重启（重新读文件）后仍是 5，不复活');
  assert.equal(readQuota(file, fs, Date.UTC(2026, 9, 26, 4, 0, 0)).used, 0, '换天归零');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('状态文件损坏 → 当作 0，不抛（配额不能把生图打死）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-quota2-'));
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{not json');
  assert.equal(readQuota(file, fs, NOW).used, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

if (failed) { console.error(`\n❌ 配额测试失败（${failed} 项）`); process.exit(1); }
console.log('\n🎉 配额测试通过');
