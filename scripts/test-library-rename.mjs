// 改名纯规则单测：sanitize / plan / 日志与撤销。不碰磁盘、不碰网络。
//
// 为什么单独一套：改名是「不可逆」动作，规则错一次就会把用户的素材目录改坏，
// 所以每条规则（非法字符、日期目录、群目录、扩展名、回落 boundTitle）都要有断言钉住；
// 真正 renameSync 的路由用例在 test-library-find.mjs（那里有整套假 deps）。
import assert from 'node:assert/strict';
import {
  RENAME_RULES_VERSION, RENAME_MAX_CHARS, RENAME_MIN_STEM,
  sanitizeRenameTarget, buildRenamePlan,
  renameLogEntry, normalizeRenameLog, lastUndo, appendRenameLog,
  dropLastRenameLog, renameLogSummary
} from '../src/library-rename.js';
import { contentKeyFor } from '../src/file-archive/common.js';

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name} — ${error?.message ?? error}`);
  }
}

const asset = (patch = {}) => ({
  key: 'g/c/mew',
  title: 'Mew Hair',
  dir: 'g/c/mew-hair',
  mainName: 'mew_hair_v2.zip',
  boundTitle: '',
  ...patch
});

console.log('## sanitizeRenameTarget');
check('常量给人看的默认值', () => {
  assert.equal(RENAME_RULES_VERSION, 1);
  assert.equal(RENAME_MAX_CHARS, 60);
  assert.equal(RENAME_MIN_STEM, 2);
});
check('普通中文名原样保留', () => {
  assert.equal(sanitizeRenameTarget('Endless Comfort 猫耳'), 'Endless Comfort 猫耳');
});
check('Windows 非法字符统一换成下划线', () => {
  assert.equal(sanitizeRenameTarget('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j');
});
check('控制字符换成下划线（换行/制表都算）', () => {
  assert.equal(sanitizeRenameTarget('a\nb\tc'), 'a_b_c');
});
check('去掉结尾的点（Windows 会静默吃掉）', () => {
  assert.equal(sanitizeRenameTarget('Mew Hair...'), 'Mew Hair');
});
check('去首尾空格', () => {
  assert.equal(sanitizeRenameTarget('   Mew Hair   '), 'Mew Hair');
});
check('连续空白压成一个', () => {
  assert.equal(sanitizeRenameTarget('Mew   Hair'), 'Mew Hair');
});
check('超长截到 60 个字符', () => {
  assert.equal(Array.from(sanitizeRenameTarget('あ'.repeat(80))).length, RENAME_MAX_CHARS);
});
check('空串/纯空白 → 空串', () => {
  assert.equal(sanitizeRenameTarget('   '), '');
  assert.equal(sanitizeRenameTarget(''), '');
});
check('null/undefined 不炸，回空串', () => {
  assert.equal(sanitizeRenameTarget(null), '');
  assert.equal(sanitizeRenameTarget(undefined), '');
});
check('中间的点保留（版本号不会被吃掉）', () => {
  assert.equal(sanitizeRenameTarget('Ver1.0.2 Win'), 'Ver1.0.2 Win');
});
check('只有非法字符时留下下划线（不是空）', () => {
  assert.equal(sanitizeRenameTarget('///'), '___');
});

console.log('## buildRenamePlan');
check('正常改名：先改主包文件、再改末级目录', () => {
  const plan = buildRenamePlan(asset(), { name: 'Endless Comfort', now: 1000 });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.moves, [
    { from: 'g/c/mew-hair/mew_hair_v2.zip', to: 'g/c/mew-hair/Endless Comfort.zip' },
    { from: 'g/c/mew-hair', to: 'g/c/Endless Comfort' }
  ]);
  assert.equal(plan.to.dir, 'g/c/Endless Comfort');
  assert.equal(plan.to.mainName, 'Endless Comfort.zip');
});
check('扩展名保留（.7z / .rar 都按原样）', () => {
  assert.equal(buildRenamePlan(asset({ mainName: 'pack.7z' }), { name: 'Mew Pack' }).to.mainName, 'Mew Pack.7z');
});
check('名字带扩展名时不重复加', () => {
  assert.equal(buildRenamePlan(asset(), { name: 'Mew Pack.zip' }).to.mainName, 'Mew Pack.zip');
});
check('name 为空时回落 boundTitle', () => {
  const plan = buildRenamePlan(asset({ boundTitle: '绑定后的名字' }), { name: '' });
  assert.equal(plan.ok, true);
  assert.equal(plan.to.dir, 'g/c/绑定后的名字');
});
check('落在日期目录里拒绝（并给理由）', () => {
  const plan = buildRenamePlan(asset({ dir: '100000001_扣1复活牢大/2026-10' }), { name: 'Endless Comfort' });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /日期目录/);
  assert.deepEqual(plan.moves, []);
});
check('末级是群目录时拒绝', () => {
  const plan = buildRenamePlan(asset({ dir: '100000001_扣1复活牢大' }), { name: 'Endless Comfort' });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /群目录/);
});
check('2 个字符可以（Mew 这种短名不再被挡）', () => {
  const two = buildRenamePlan(asset(), { name: 'Mew' });
  assert.equal(two.ok, true);
  assert.equal(two.to.dir, 'g/c/Mew');
  const short = buildRenamePlan(asset({ boothId: '' }), { name: 'Shiro' });
  assert.equal(short.ok, true);
  assert.equal(short.to.dir, 'g/c/Shiro');
});
check('1 个字符/纯空白被拒（太短）', () => {
  const one = buildRenamePlan(asset({ boothId: '' }), { name: '猫' });
  assert.equal(one.ok, false);
  assert.match(one.reason, /太短/);
  const blank = buildRenamePlan(asset({ boundTitle: '', title: '' }), { name: '   ' });
  assert.equal(blank.ok, false);
  assert.match(blank.reason, /清洗后是空的/);
});
check('清洗后为空拒绝（全是点，sanitize 后什么都不剩）', () => {
  const plan = buildRenamePlan(asset({ boundTitle: '', title: '' }), { name: '......' });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /清洗后是空的/);
});
check('名字没变时拒绝（省一次无意义 rename）', () => {
  const plan = buildRenamePlan(asset({ dir: 'g/c/Endless Comfort', mainName: 'Endless Comfort.zip' }), { name: 'Endless Comfort' });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /名字没变/);
});
check('没有主包文件时拒绝', () => {
  const plan = buildRenamePlan(asset({ mainName: '' }), { name: 'Endless Comfort' });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /没有主包文件/);
});
check('只有一层目录也能改（末级就是它）', () => {
  const plan = buildRenamePlan(asset({ dir: '8844481' }), { name: 'Endless Comfort' });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.moves[1], { from: '8844481', to: 'Endless Comfort' });
});
check('反斜杠目录归一成正斜杠', () => {
  const plan = buildRenamePlan(asset({ dir: 'g\\c\\mew-hair' }), { name: 'Endless Comfort' });
  assert.equal(plan.ok, true);
  assert.equal(plan.to.dir, 'g/c/Endless Comfort');
  assert.equal(plan.moves[0].from, 'g/c/mew-hair/mew_hair_v2.zip');
});
check('名字里的非法字符也进不了计划', () => {
  const plan = buildRenamePlan(asset(), { name: 'Endless:Comfort?猫耳' });
  assert.equal(plan.to.mainName, 'Endless_Comfort_猫耳.zip');
  assert.equal(plan.to.dir, 'g/c/Endless_Comfort_猫耳');
});
check('缺少 contentKey 时拒绝（日志/撤销都靠它）', () => {
  const plan = buildRenamePlan(asset({ key: '' }), { name: 'Endless Comfort' });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /contentKey/);
});

console.log('## 日志与撤销');
check('renameLogEntry 保留 key 与 moves', () => {
  const entry = renameLogEntry({ key: 'g/c/mew', from: { dir: 'a' }, to: { dir: 'b' }, at: 5, moves: [{ from: 'a/x.zip', to: 'b/x.zip' }] });
  assert.equal(entry.key, 'g/c/mew');
  assert.equal(entry.at, 5);
  assert.equal(entry.moves.length, 1);
});
check('normalizeRenameLog 丢坏条目、保留合法表', () => {
  const log = normalizeRenameLog({ version: 9, entries: { 'g/c/mew': [{ at: 1, moves: [{ from: 'a', to: 'b' }] }, 'junk', { moves: [] }] } });
  assert.equal(log.version, RENAME_RULES_VERSION);
  assert.equal(log.entries['g/c/mew'].length, 1);
});
check('同一件素材最多留 10 条', () => {
  let log = normalizeRenameLog(null);
  for (let i = 0; i < 15; i += 1) {
    log = appendRenameLog(log, { key: 'k', from: { dir: `d${i}` }, to: { dir: `e${i}` }, at: i, moves: [{ from: `d${i}/a.zip`, to: `e${i}/a.zip` }] });
  }
  assert.equal(log.entries.k.length, 10);
  assert.equal(log.entries.k[9].at, 14);
});
check('lastUndo 取该件最近一条（key 省略时取全表最新）', () => {
  let log = appendRenameLog(normalizeRenameLog(null), { key: 'a', at: 10, moves: [{ from: 'a1', to: 'a2' }] });
  log = appendRenameLog(log, { key: 'b', at: 20, moves: [{ from: 'b1', to: 'b2' }] });
  assert.equal(lastUndo(log, 'a').at, 10);
  assert.equal(lastUndo(log).at, 20);
  assert.equal(lastUndo(log, 'nope'), null);
});
check('dropLastRenameLog 移除最近一条，空了就删键', () => {
  const log = appendRenameLog(normalizeRenameLog(null), { key: 'a', at: 10, moves: [{ from: 'x', to: 'y' }] });
  const once = dropLastRenameLog(log, 'a');
  assert.equal(once.entries.a, undefined);
  assert.equal(lastUndo(once, 'a'), null);
});
check('renameLogSummary 给件数与最近时间', () => {
  let log = appendRenameLog(normalizeRenameLog(null), { key: 'a', at: 7, moves: [{ from: 'x', to: 'y' }] });
  log = appendRenameLog(log, { key: 'b', at: 9, moves: [{ from: 'x', to: 'y' }] });
  const summary = renameLogSummary(log);
  assert.equal(summary.count, 2);
  assert.equal(summary.lastAt, 9);
});
check('坏 JSON 形状（null/数组/字符串）不会抛', () => {
  assert.deepEqual(normalizeRenameLog(null).entries, {});
  assert.deepEqual(normalizeRenameLog([]).entries, {});
  assert.deepEqual(normalizeRenameLog('nope').entries, {});
});

console.log('## 号前缀（改名必须保住 BOOTH 号）');
check('不带号的名字自动补 <号>_ 并标 prefixed', () => {
  const plan = buildRenamePlan(asset({ boothId: '271777', mainName: 'Mew Hair.zip' }), { name: 'Astraea_Milltina_v1.1', now: 1 });
  assert.equal(plan.ok, true);
  assert.equal(plan.prefixed, true);
  assert.equal(plan.to.dir, 'g/c/271777_Astraea_Milltina_v1.1');
  assert.equal(plan.to.mainName, '271777_Astraea_Milltina_v1.1.zip');
});
check('已经带号的不重复加', () => {
  const plan = buildRenamePlan(asset({ boothId: '271777' }), { name: '271777_Astraea', now: 1 });
  assert.equal(plan.ok, true);
  assert.equal(plan.prefixed, false);
  assert.equal(plan.to.dir, 'g/c/271777_Astraea');
});
check('号后面直接跟描述（空格分隔）也算带号', () => {
  const plan = buildRenamePlan(asset({ boothId: '271777' }), { name: '271777 Astraea', now: 1 });
  assert.equal(plan.prefixed, false);
  assert.equal(plan.to.dir, 'g/c/271777 Astraea');
});
check('没认号（boothId 空/非法）就不加前缀', () => {
  for (const boothId of ['', '1234', 'abc']) {
    const plan = buildRenamePlan(asset({ boothId }), { name: 'Astraea Clean', now: 1 });
    assert.equal(plan.ok, true);
    assert.equal(plan.prefixed, false);
    assert.equal(plan.to.dir, 'g/c/Astraea Clean');
  }
});
check('补前缀后总长仍 ≤ 60 码点', () => {
  const plan = buildRenamePlan(asset({ boothId: '271777' }), { name: '长'.repeat(80), now: 1 });
  assert.equal(plan.ok, true);
  assert.ok(Array.from(plan.to.dir.split('/').pop()).length <= RENAME_MAX_CHARS, plan.to.dir);
  assert.ok(plan.to.dir.endsWith('.zip') === false);
  assert.ok(plan.to.mainName.startsWith('271777_'));
});
check('失败的计划 prefixed 为 false', () => {
  const plan = buildRenamePlan(asset({ boothId: '271777', mainName: '' }), { name: 'Astraea Clean', now: 1 });
  assert.equal(plan.ok, false);
  assert.equal(plan.prefixed, false);
});

console.log('## 改名后的 contentKey（撤销要靠它）');
check('plan 里的 newKey 与新主件名的 contentKeyFor 一致', () => {
  const plan = buildRenamePlan(asset({ mainBytes: 9 }), { name: 'Endless Comfort', now: 1 });
  assert.equal(plan.ok, true);
  assert.equal(plan.newKey, contentKeyFor('Endless Comfort.zip', 9));
  assert.notEqual(plan.newKey, plan.key);
});
check('失败的计划 newKey 是空串（别让前端拿半成品 key 去撤销）', () => {
  const plan = buildRenamePlan(asset({ mainName: '' }), { now: 1 });
  assert.equal(plan.ok, false);
  assert.equal(plan.newKey, '');
});
check('normalizeRenameLog 保留 newKey', () => {
  // 日志条目必须带 moves：normalize 会把「没有可撤销动作」的空条目直接丢掉。
  const entry = renameLogEntry({ key: 'old', newKey: 'new', from: { dir: 'a' }, to: { dir: 'b' }, at: 1, moves: [{ from: 'a/x', to: 'b/x' }] });
  const table = normalizeRenameLog({ entries: { old: [entry] } });
  assert.equal(table.entries.old[0].newKey, 'new');
  const empty = normalizeRenameLog({ entries: { old: [renameLogEntry({ key: 'old', newKey: 'new', moves: [] })] } });
  assert.deepEqual(empty.entries, {});
});
check('lastUndo 用旧 key 能找到', () => {
  const entry = renameLogEntry({ key: 'old', newKey: 'new', from: { dir: 'a' }, to: { dir: 'b' }, at: 1, moves: [{ from: 'a/x', to: 'b/x' }] });
  const table = normalizeRenameLog({ entries: { old: [entry] } });
  const found = lastUndo(table, 'old');
  assert.ok(found && found.key === 'old' && found.newKey === 'new');
});
check('lastUndo 用新 key 也能找到（真机翻车点）', () => {
  const entry = renameLogEntry({ key: 'old', newKey: 'new', from: { dir: 'a' }, to: { dir: 'b' }, at: 1, moves: [{ from: 'a/x', to: 'b/x' }] });
  const table = normalizeRenameLog({ entries: { old: [entry] } });
  const found = lastUndo(table, 'new');
  assert.ok(found, '新 key 找不到就是撤销永远失败');
  assert.equal(found.key, 'old');
});
check('lastUndo 没有任何匹配 → null', () => {
  assert.equal(lastUndo(normalizeRenameLog(null), 'whatever'), null);
});

console.log('');
if (failures.length) {
  console.log(`改名纯规则：通过 ${pass} / 失败 ${failures.length}`);
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
console.log(`改名纯规则：通过 ${pass} / 失败 0`);
