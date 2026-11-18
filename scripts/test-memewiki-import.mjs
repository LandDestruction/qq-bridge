// 梗百科 → 黑话库导入规则的单测（纯函数，不读盘）。
import assert from 'node:assert/strict';
import {
  MEMEWIKI_RULES_VERSION,
  memewikiSlangPolicy,
  memewikiRowToSlangEntry,
  buildMemewikiSlangEntries,
  describeImportResult
} from '../src/memewiki-import.js';

let pass = 0;
const fails = [];
function ok(name, fn) {
  try { fn(); pass++; } catch (error) { fails.push(name + ' — ' + (error && error.message)); }
}

const row = {
  title: '哈基米',
  slug: '哈基米',
  summary: '日语「はちみつ」的音译，原意蜂蜜；网络流行语里指一段可爱小猫跳舞的 BGM。',
  origin: '来源略',
  usage: '夸某人可爱时说「哈基米」。',
  tags: '动物梗、可爱'
};

ok('规则版本存在', () => assert.equal(typeof MEMEWIKI_RULES_VERSION, 'number'));
ok('短标题 + 无风险 → 可玩', () => {
  const e = memewikiRowToSlangEntry(row, '2026-11-02T00:00:00.000Z');
  assert.equal(e.usagePolicy, 'usable');
  assert.equal(e.status, 'confirmed');
  assert.equal(e.source, 'memewiki');
  assert.equal(e.count, 0);
  assert.ok(e.id.startsWith('mw-'));
});
ok('标题过长 → 只听懂', () => {
  const e = memewikiRowToSlangEntry({ ...row, title: '这是一个非常非常长的梗名字' }, 'x');
  assert.equal(e.usagePolicy, 'understand-only');
});
ok('带风险标签 → 只听懂', () => {
  const e = memewikiRowToSlangEntry({ ...row, tags: '政治、敏感' }, 'x');
  assert.equal(e.usagePolicy, 'understand-only');
});
ok('纯数字/太短标题被丢弃', () => {
  assert.equal(memewikiRowToSlangEntry({ ...row, title: '7' }, 'x'), null);
  assert.equal(memewikiRowToSlangEntry({ ...row, title: '' }, 'x'), null);
});
ok('没有释义被丢弃', () => {
  assert.equal(memewikiRowToSlangEntry({ ...row, summary: '', origin: '' }, 'x'), null);
});
ok('批量去重（与已有词条重复 + 批内重复）', () => {
  const r = buildMemewikiSlangEntries([row, row, { ...row, title: '恶意图', slug: '恶意图' }], { existing: ['哈基米'] });
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].content, '恶意图');
  assert.equal(r.skipped.duplicate, 2);
});
ok('limit 生效', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ ...row, title: '梗' + i, slug: '梗' + i }));
  const r = buildMemewikiSlangEntries(rows, { limit: 2 });
  assert.equal(r.entries.length, 2);
  assert.equal(r.skipped.overLimit, 3);
});
ok('统计可玩/只听', () => {
  const r = buildMemewikiSlangEntries([row, { ...row, title: '很长很长很长很长的梗名' }], {});
  assert.equal(r.stats.total, 2);
  assert.equal(r.stats.usable, 1);
  assert.equal(r.stats.understandOnly, 1);
});
ok('人话描述包含条数与可玩数', () => {
  const msg = describeImportResult({ stats: { total: 3, usable: 2, understandOnly: 1 }, skipped: { duplicate: 1, invalid: 0 } });
  assert.ok(msg.includes('3'));
  assert.ok(msg.includes('2'));
});

console.log(fails.length ? '失败：\n' + fails.join('\n') : '通过 ' + pass + ' / 失败 0');
process.exit(fails.length ? 1 : 0);
