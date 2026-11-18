// 磁盘空间护栏的离线断言（假 statfs，不碰真磁盘）。
import assert from 'node:assert/strict';
import { checkDiskSpace, DISK_RESERVE_BYTES } from '../src/disk-guard.js';

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`✅ ${name}`); }
  catch (e) { failed += 1; console.error(`❌ ${name} — ${e?.message ?? e}`); }
}
const GB = 1024 ** 3;
const NEED = 2500 * 1024 * 1024; // 2.5GB 上限
const statfsOf = (freeGB) => async () => ({ bavail: String(Math.round(freeGB * 1024)), bsize: String(1024 * 1024) });

await check('空间充足（剩余 20GB > 2.5GB + 5GB）→ 放行', async () => {
  const v = await checkDiskSpace({ statfs: statfsOf(20), dir: '.', needBytes: NEED });
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'ok');
});

await check('空间不足（剩余 6GB < 2.5 + 5=7.5GB）→ 拒绝，且给出剩余/需要/预留', async () => {
  const v = await checkDiskSpace({ statfs: statfsOf(6), dir: '.', needBytes: NEED });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'insufficient');
  assert(v.freeBytes > 0 && v.needBytes === NEED && v.reserveBytes === DISK_RESERVE_BYTES);
});

await check('临界值：正好够（free = need + reserve）→ 放行', async () => {
  const v = await checkDiskSpace({ statfs: statfsOf(7.5), dir: '.', needBytes: NEED });
  assert.equal(v.ok, true);
});

await check('statfs 抛错（目录不可读/平台不支持）→ 放行但标记 unknown', async () => {
  const v = await checkDiskSpace({ statfs: async () => { throw new Error('ENOTSUP'); }, dir: '.', needBytes: NEED });
  assert.equal(v.ok, true);
  assert.equal(v.unknown, true);
  assert.match(v.reason, /ENOTSUP/);
});

await check('needBytes=0 时不查盘直接放行', async () => {
  let called = 0;
  const v = await checkDiskSpace({ statfs: async () => { called += 1; return { bavail: '0', bsize: '1' }; }, dir: '.', needBytes: 0 });
  assert.equal(v.ok, true);
  assert.equal(called, 0, '没有需求时不该调用 statfs');
});

await check('2.5GB 是普通 Number（不经过 int32）—— need+reserve 不溢出', async () => {
  const total = NEED + DISK_RESERVE_BYTES;
  assert(total > 2 ** 31 - 1, '2.5GB+5GB 必然超过 int32');
  assert.equal(total, 2500 * 1024 * 1024 + 5 * 1024 ** 3);
});

if (failed) { console.error(`\n❌ 磁盘护栏测试失败（${failed} 项）`); process.exit(1); }
console.log('\n🎉 磁盘护栏测试通过');
