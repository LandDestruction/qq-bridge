// 纯函数单测：绑定表（src/library-binds.js）与找号裁剪（src/library-find.js）。
// 这两块不碰网络，所以是「先锁规则、再接线」的那一半。
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const mod = await import(pathToFileURL(path.join(ROOT, 'src/library-binds.js')).href);
const find = await import(pathToFileURL(path.join(ROOT, 'src/library-find.js')).href);

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('## 绑定表：读数与规整');
check('空表规整成 {version, entries:{}}',
  eq(mod.normalizeBindTable(null), { version: mod.BIND_RULES_VERSION, entries: {} }));
check('坏号/坏 key 的项被丢掉',
  eq(Object.keys(mod.normalizeBindTable({ entries: {
    good: { boothId: '12345', source: 'manual', at: 5 },
    badId: { boothId: 'abc', source: 'manual' },
    '': { boothId: '55555' }
  } }).entries), ['good']));
check('超长 title/source 被截断、at 不是数字归零',
  (() => {
    const t = mod.normalizeBindTable({ entries: { k: { boothId: '12345', title: 'x'.repeat(500), source: 'y'.repeat(80), at: 'oops' } } });
    return t.entries.k.title.length === 200 && t.entries.k.source.length === 40 && t.entries.k.at === 0;
  })());
check('isBoothId 只认 5~9 位数字',
  mod.isBoothId('12345') && mod.isBoothId('123456789') && !mod.isBoothId('1234') && !mod.isBoothId('1234567890') && !mod.isBoothId('１２３４５'));

console.log('## 绑定表：写/删/查');
const base = mod.normalizeBindTable(null);
const t1 = mod.setBind(base, 'g/c/foo', '7850009', { title: 'Mew Hair', source: 'manual', now: 1000 });
check('setBind 写入后 bindOf 能查到', mod.bindOf(t1, 'g/c/foo')?.boothId === '7850009');
check('setBind 不改入参', mod.bindCount(base) === 0 && mod.bindCount(t1) === 1);
check('setBind 同一 key 覆盖旧值', mod.bindOf(mod.setBind(t1, 'g/c/foo', '8644793', { now: 2000 }), 'g/c/foo')?.boothId === '8644793');
check('setBind 拒绝非法号', (() => { try { mod.setBind(base, 'k', '12', {}); return false; } catch { return true; } })());
check('setBind 拒绝空 key', (() => { try { mod.setBind(base, '', '12345', {}); return false; } catch { return true; } })());
check('removeBind 删掉后查不到', mod.bindOf(mod.removeBind(t1, 'g/c/foo'), 'g/c/foo') === null);
check('removeBind 删不存在的 key 不报错也不改表', mod.bindCount(mod.removeBind(t1, 'nope')) === 1);
check('summary 报数量与去重号数', (() => {
  const s = mod.bindTableSummary(t1);
  return s.count === 1 && s.uniqueIds === 1 && s.version === mod.BIND_RULES_VERSION;
})());
check('summary 空表不炸', eq(mod.bindTableSummary(null), { version: mod.BIND_RULES_VERSION, count: 0, uniqueIds: 0, manualAt: 0 }));

console.log('## 绑定表：覆盖到素材卡');
const cards = [
  { key: 'g/a/one', title: 'One', boothId: '11111', boothSource: 'auto' },
  { key: 'g/a/two', title: 'Two', boothId: '', boothSource: '' }
];
const bindTable = mod.setBind(mod.setBind(base, 'g/a/two', '22222', { title: 'Two BOOTH', now: 5 }), 'g/a/one', '33333', { now: 6 });
const applied = mod.applyBinds(cards, bindTable);
check('applyBinds 命中时改 boothId 并把来源标成 bind',
  applied[0].boothId === '33333' && applied[0].boothSource === 'bind' && applied[0].boundTitle === '');
check('applyBinds 把原来的自动号留在 autoBoothId', applied[0].autoBoothId === '11111');
check('applyBinds 给没号的卡补上号', applied[1].boothId === '22222' && applied[1].boundTitle === 'Two BOOTH');
check('applyBinds 不改原始卡片数组', cards[0].boothId === '11111' && cards[1].boothId === '');

console.log('## 找号：候选裁剪');
check('pickPool 丢掉非法号', find.pickPool([{ boothId: '12345' }, { boothId: 'x' }, { boothId: '67890' }]).length === 2);
check('pickPool 按 max 截断', find.pickPool(Array.from({ length: 50 }, (_, i) => ({ boothId: String(10000 + i) })), { max: 7 }).length === 7);
const trimmed = find.toResponseCandidate({
  boothId: 7850009, title: 'Mew Hair '.repeat(30), shopName: 'foxyplay', price: '1190',
  itemUrl: 'https://booth.pm/ja/items/7850009', thumbUrl: 'https://booth.pximg.net/x.jpg',
  score: 0.81234, titleScore: 0.7, coverMatch: true, coverDistance: 3, shopMatch: false,
  reasons: ['标题很像', '封面几乎一样', '店铺一致', '价格接近', '多余理由']
});
check('toResponseCandidate 把号转成字符串', trimmed.boothId === '7850009');
check('toResponseCandidate 价格转数字', trimmed.price === 1190);
check('toResponseCandidate 分数保留三位', trimmed.score === 0.812 && trimmed.titleScore === 0.7);
check('toResponseCandidate 标题截到 200 字', trimmed.title.length === 200);
check('toResponseCandidate 理由最多四条', trimmed.reasons.length === 4);
check('toResponseCandidate 空值返回 null', find.toResponseCandidate(null) === null);

console.log('## 找号：一句话说明');
check('没候选时说没搜到', /没有搜到候选/.test(find.describeFindSummary({ candidates: 0, phrases: ['mew'] })));
check('有候选时报数量与封面比对张数', (() => {
  const s = find.describeFindSummary({ candidates: 4, phrases: ['mew hair'], coverChecked: 3 });
  return /4 个候选/.test(s) && /3 张封面指纹/.test(s) && /mew hair/.test(s);
})());
check('auto 时补一句「默认帮你选中」', /默认帮你选中/.test(find.describeFindSummary({ candidates: 2, phrases: ['x'], auto: true })));

console.log('');
console.log(`library-binds / library-find：通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
