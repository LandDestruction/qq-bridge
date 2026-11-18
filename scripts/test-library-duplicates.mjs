// src/library-duplicates.js 的契约测试：纯规则重复检测 + 清理计划（不碰盘）。
//
// 覆盖：四类重复各命中/不命中、已合并的卡不报、keepKey 优先级（封面 > 非日期目录 > bytes > key）、
// 同号与标题近似去重只报一次、bytes 差距 5% 边界、清理计划不动 keepKey、keys 勾选范围、
// largest/newest 覆盖、空输入与脏输入不炸。
//
// 真机基线（2026-10-30，38 件卡）：合并功能已经把同号消化掉，检测当时报 0 组——不是规则失效；
// 后来补了封面指纹（src/library-dhash.js，扫盘缓存）后，同一天复算报出 1 组「封面近似」。
import {
  groupDuplicates,
  normalizeMainName,
  normalizeTitle,
  planDuplicatesCleanup,
  summarizeDuplicates
} from '../src/library-duplicates.js';

const failures = [];
let pass = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail === undefined ? '' : ' — ' + String(detail)}`);
  }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

// 默认值按 key 派生，避免「本来只想测 X 类，结果被 Y 类误命中」的串味。
function seedOf(key) {
  let hash = 0;
  for (const ch of String(key)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash;
}
function card(overrides = {}) {
  const key = overrides.key || 'k1';
  return {
    key,
    title: `作品 ${key}`,
    dir: 'Shop',
    boothId: '',
    bytes: 1000,
    mainBytes: 1000 + (seedOf(key) % 97),
    mainName: `file-${key}.zip`,
    thumbRel: '',
    ...overrides
  };
}

console.log('## 归一化小工具');
{
  eq('去扩展名 + 小写', normalizeMainName('Model.ZIP'), 'model');
  eq('去复制后缀 _1', normalizeMainName('model_1.zip'), 'model');
  eq('去复制后缀 (1)', normalizeMainName('model (1).zip'), 'model');
  eq('全角括号（2）也去', normalizeMainName('model（2）.zip'), 'model');
  eq('多层后缀只留主干', normalizeMainName('model_1 (2).zip'), 'model');
  eq('中间的下划线不动', normalizeMainName('my_model_v2.zip'), 'my_model_v2');
  eq('标题剥号前缀', normalizeTitle({ title: '1234567 Model' }), 'model');
  eq('标题优先 displayTitle', normalizeTitle({ title: '1234567 x', displayTitle: '真标题' }), '真标题');
  eq('标题忽略大小写与分隔符', normalizeTitle({ title: 'A  B-C' }), 'a b c');
  eq('没标题回空串', normalizeTitle({}), '');
}

console.log('## 同类重复：同号');
{
  const assets = [
    card({ key: 'a', boothId: '8844481' }),
    card({ key: 'b', boothId: '8844481', bytes: 1200 })
  ];
  const result = groupDuplicates(assets);
  eq('1 组', result.groups.length, 1);
  eq('原因标中文「同号」', result.groups[0].reason, '同号');
  eq('成员两个 key', result.groups[0].keys, ['a', 'b']);
  eq('多出 1 个', result.totalExtra, 1);
  eq('keepKey 取 bytes 大的', result.groups[0].keepKey, 'b');
  eq('多余字节 = 总字节 - 保留字节', result.groups[0].extraBytes, 1000);
  eq('同号只在 boothId 相同时报到', groupDuplicates([card({ key: 'a', boothId: '1' }), card({ key: 'b', boothId: '2' })]).groups.length, 0);
  eq('不像号的 boothId 不认', groupDuplicates([card({ key: 'a', boothId: 'abc' }), card({ key: 'b', boothId: 'abc' })]).groups.length, 0);
}

console.log('## 同号但已合并 → 不报');
{
  const merged = card({ key: 'a', boothId: '8844481', mergedKeys: ['a', 'z'], mergeId: 'm-8844481', mergedCount: 2 });
  const other = card({ key: 'b', boothId: '8844481' });
  eq('已合并的那张不参与，剩 1 张也不成组', groupDuplicates([merged, other]).groups.length, 0);
  eq('两张都合并过也不报', groupDuplicates([
    card({ key: 'a', boothId: '8844481', mergeId: 'm1', mergedKeys: ['a', 'x'] }),
    card({ key: 'b', boothId: '8844481', mergeId: 'm2', mergedKeys: ['b', 'y'] })
  ]).groups.length, 0);
}

console.log('## 同类重复：同名同大小');
{
  const assets = [
    card({ key: 'a', mainBytes: 1234, mainName: 'ShiroTensi.zip' }),
    card({ key: 'b', mainBytes: 1234, mainName: 'shirotensi (1).ZIP' })
  ];
  const result = groupDuplicates(assets);
  eq('1 组', result.groups.length, 1);
  eq('原因「同名同大小」', result.groups[0].reason, '同名同大小');
  eq('成员 key 都在', result.groups[0].keys.sort(), ['a', 'b']);
  eq('大小相同但名字不同不报', groupDuplicates([
    card({ key: 'a', mainBytes: 1234, mainName: 'one.zip' }),
    card({ key: 'b', mainBytes: 1234, mainName: 'two.zip' })
  ]).groups.length, 0);
  eq('名字相同但大小不同不报', groupDuplicates([
    card({ key: 'a', mainBytes: 1234, mainName: 'one.zip' }),
    card({ key: 'b', mainBytes: 9999, mainName: 'one.zip' })
  ]).groups.length, 0);
  eq('mainBytes 为 0 不参与（未识别主件）', groupDuplicates([
    card({ key: 'a', mainBytes: 0, mainName: 'one.zip' }),
    card({ key: 'b', mainBytes: 0, mainName: 'one.zip' })
  ]).groups.length, 0);
}

console.log('## 同类重复：封面近似（dhash）');
{
  const assets = [
    card({ key: 'a', dhash: 'ABCDEF0123456789' }),
    card({ key: 'b', dhash: 'abcdef0123456789' })
  ];
  const result = groupDuplicates(assets);
  eq('dhash 大小写不同也算同一张图', result.groups.length, 1);
  eq('原因「封面近似」', result.groups[0].reason, '封面近似');
  eq('dhash 不同不报', groupDuplicates([
    card({ key: 'a', dhash: 'aaaa' }),
    card({ key: 'b', dhash: 'bbbb' })
  ]).groups.length, 0);
  eq('dhash 空串不参与', groupDuplicates([
    card({ key: 'a', dhash: '' }),
    card({ key: 'b', dhash: '' })
  ]).groups.length, 0);
  eq('没有 dhash 字段不参与', groupDuplicates([card({ key: 'a' }), card({ key: 'b' })]).groups.length, 0);
}

console.log('## 同类重复：标题近似（bytes 5% 内）');
{
  const assets = [
    card({ key: 'a', title: '1234567 My Model', boothId: '', bytes: 1000 }),
    card({ key: 'b', title: 'my model (1)', boothId: '', bytes: 960 })
  ];
  const result = groupDuplicates(assets);
  eq('1 组', result.groups.length, 1);
  eq('原因「标题近似」', result.groups[0].reason, '标题近似');
  eq('bytes 差 4% 命中', result.groups[0].keys.length, 2);
  eq('bytes 差 6% 不命中', groupDuplicates([
    card({ key: 'a', title: 'Same Title', bytes: 1000 }),
    card({ key: 'b', title: 'same title', bytes: 940 })
  ]).groups.length, 0);
  eq('标题不同不命中', groupDuplicates([
    card({ key: 'a', title: 'Title A', bytes: 1000 }),
    card({ key: 'b', title: 'Title B', bytes: 1000 })
  ]).groups.length, 0);
  eq('空标题不凑组', groupDuplicates([
    card({ key: 'a', title: '', bytes: 1000 }),
    card({ key: 'b', title: '', bytes: 1000 })
  ]).groups.length, 0);
}

console.log('## keepKey 优先级（与合并主成员规则一致）');
{
  // 有封面的赢没封面的
  let result = groupDuplicates([
    card({ key: 'a', boothId: '9014210', bytes: 9999 }),
    card({ key: 'b', boothId: '9014210', bytes: 10, thumbRel: 'x/thumb.png' })
  ]);
  eq('有封面 > bytes 大', result.groups[0].keepKey, 'b');
  // 非日期独立目录赢日期目录
  result = groupDuplicates([
    card({ key: 'a', boothId: '9014211', dir: '2026-10-30' }),
    card({ key: 'b', boothId: '9014211', dir: 'ShopName' })
  ]);
  eq('非日期目录 > 日期目录', result.groups[0].keepKey, 'b');
  // bytes 大的赢
  result = groupDuplicates([
    card({ key: 'a', boothId: '9014212', bytes: 100 }),
    card({ key: 'b', boothId: '9014212', bytes: 200 })
  ]);
  eq('bytes 大 > bytes 小', result.groups[0].keepKey, 'b');
  // 完全并列 → key 小的
  result = groupDuplicates([
    card({ key: 'zz', boothId: '9014213', bytes: 100 }),
    card({ key: 'aa', boothId: '9014213', bytes: 100 })
  ]);
  eq('并列时 key 小者优先', result.groups[0].keepKey, 'aa');
  // 日期名判定：2026 也算，2026-10-30 也算
  result = groupDuplicates([
    card({ key: 'a', boothId: '9014214', dir: '2026' }),
    card({ key: 'b', boothId: '9014214', dir: 'keep-me' })
  ]);
  eq('纯年份目录也算日期目录', result.groups[0].keepKey, 'b');
}

console.log('## 去重：同一组 key 只报一次（同号优先于标题近似）');
{
  const assets = [
    card({ key: 'a', boothId: '9027237', title: 'Same', bytes: 1000 }),
    card({ key: 'b', boothId: '9027237', title: 'same', bytes: 1000 })
  ];
  const result = groupDuplicates(assets);
  eq('只报 1 组', result.groups.length, 1);
  eq('报的是同号（优先级高）', result.groups[0].reason, '同号');
}

console.log('## 汇总摘要');
{
  const groups = [
    { keys: ['a', 'b', 'c'], bytes: 300, extraBytes: 200, keepKey: 'c' },
    { keys: ['d', 'e'], bytes: 100, extraBytes: 50, keepKey: 'd' },
    { keys: ['solo'], bytes: 10 }
  ];
  eq('摘要数字', summarizeDuplicates(groups), { groupCount: 2, extraCount: 3, extraBytes: 250, savedBytes: 250 });
  eq('空输入摘要', summarizeDuplicates([]), { groupCount: 0, extraCount: 0, extraBytes: 0, savedBytes: 0 });
  eq('传 groupDuplicates 的整个结果也行', summarizeDuplicates({ groups }).extraCount, 3);
  eq('非数组不炸', summarizeDuplicates(null), { groupCount: 0, extraCount: 0, extraBytes: 0, savedBytes: 0 });
}

console.log('## 清理计划：默认不动 keepKey');
{
  const groups = groupDuplicates([
    card({ key: 'a', boothId: '9000001', bytes: 100 }),
    card({ key: 'b', boothId: '9000001', bytes: 300 }),
    card({ key: 'c', boothId: '9000001', bytes: 200 })
  ]).groups;
  const plan = planDuplicatesCleanup(groups);
  eq('保留的是 bytes 最大的 b', plan.keepKeys, ['b']);
  eq('其余两条进回收站', plan.trashKeys.sort(), ['a', 'c']);
  check('keepKey 绝不在 trashKeys 里', !plan.trashKeys.includes('b'));
  eq('没有跳过项', plan.skipped, []);
}

console.log('## 清理计划：keep=largest / keep=newest');
{
  const groups = [{
    keys: ['a', 'b'],
    count: 2,
    bytes: 300,
    keepKey: 'a',
    extraBytes: 100,
    members: [
      { key: 'a', bytes: 100, mtime: 500 },
      { key: 'b', bytes: 200, mtime: 100 }
    ]
  }];
  eq('默认听 keepKey', planDuplicatesCleanup(groups).keepKeys, ['a']);
  eq('largest 改留 b', planDuplicatesCleanup(groups, { keep: 'largest' }).keepKeys, ['b']);
  eq('largest 时 trash 里只有 a', planDuplicatesCleanup(groups, { keep: 'largest' }).trashKeys, ['a']);
  eq('newest 留 mtime 最大的 a', planDuplicatesCleanup(groups, { keep: 'newest' }).keepKeys, ['a']);
  const noTime = [{ ...groups[0], members: [{ key: 'a', bytes: 100 }, { key: 'b', bytes: 200 }] }];
  eq('没有 mtime 时 newest 回落到 keepKey', planDuplicatesCleanup(noTime, { keep: 'newest' }).keepKeys, ['a']);
}

console.log('## 清理计划：keys 勾选只处理给定 key');
{
  const groups = [{
    keys: ['a', 'b', 'c'],
    count: 3,
    bytes: 600,
    keepKey: 'c',
    extraBytes: 200,
    members: [{ key: 'a', bytes: 100 }, { key: 'b', bytes: 200 }, { key: 'c', bytes: 300 }]
  }];
  const plan = planDuplicatesCleanup(groups, { keys: ['a', 'c', 'zzz'] });
  eq('只删勾选且非 keep 的 a', plan.trashKeys, ['a']);
  eq('keepKey c 仍保留', plan.keepKeys, ['c']);
  eq('勾了 keepKey → skipped 说明原因', plan.skipped.find((item) => item.key === 'c')?.reason, '保留项不能删（keepKey）');
  eq('勾了不在组里的 key → skipped', plan.skipped.find((item) => item.key === 'zzz')?.reason, '不在重复组里');
  eq('没勾的 b 不动', plan.trashKeys.includes('b'), false);
  const allPlan = planDuplicatesCleanup(groups, { keys: ['a', 'b'] });
  eq('同时勾 a/b → 都能删', allPlan.trashKeys.sort(), ['a', 'b']);
}

console.log('## 空输入与脏数据');
{
  eq('空数组', groupDuplicates([]), { groups: [], totalExtra: 0, totalExtraBytes: 0 });
  eq('null 不炸', groupDuplicates(null), { groups: [], totalExtra: 0, totalExtraBytes: 0 });
  eq('非对象成员被忽略', groupDuplicates([null, 42, 'x', card({ key: '' })]).groups.length, 0);
  eq('重复 key 只算一次', groupDuplicates([
    card({ key: 'a', boothId: '9000002' }),
    card({ key: 'a', boothId: '9000002', bytes: 5 }),
    card({ key: 'b', boothId: '9000002' })
  ]).groups[0].keys, ['a', 'b']);
  eq('plan 空输入', planDuplicatesCleanup([]), { trashKeys: [], keepKeys: [], skipped: [] });
  eq('plan null 不炸', planDuplicatesCleanup(null), { trashKeys: [], keepKeys: [], skipped: [] });
  const singleGroup = [{ keys: ['only'], count: 1, bytes: 10, keepKey: 'only' }];
  eq('单成员组不产生删除项', planDuplicatesCleanup(singleGroup), { trashKeys: [], keepKeys: [], skipped: [] });
}

console.log('## 真实形状：合并视图的卡 + 台账字段混着也不炸');
{
  const assets = [
    card({ key: 'a', boothId: '9040914', mergedKeys: ['a', 'm'], mergeId: 'm-9040914', mergedCount: 2, inLedger: true, category: '服装' }),
    card({ key: 'b', boothId: '9040915', thumbRel: 'x.png', coverReady: true, modelCount: 3 }),
    card({ key: 'c', boothId: '9040915', mainBytes: 0, mainName: '', dhash: '', tags: ['VRChat'] })
  ];
  const result = groupDuplicates(assets);
  eq('同号的合并卡不报，剩下 b/c 同号成组', result.groups.map((group) => group.reason), ['同号']);
  eq('组里不含合并卡', result.groups[0].keys.sort(), ['b', 'c']);
  eq('keepKey 是有封面的 b', result.groups[0].keepKey, 'b');
  const plan = planDuplicatesCleanup(result);
  eq('计划只删 c', plan.trashKeys, ['c']);
  eq('摘要数量对得上', summarizeDuplicates(result).groupCount, 1);
}

console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  console.log('失败项：');
  for (const name of failures) console.log(` - ${name}`);
}
process.exit(failures.length ? 1 : 0);
