// 归档检索（B 组）纯逻辑单测：2 字滑窗打分 + 坏行容忍 + 同分时间倒序。
//
// 为什么需要：/recall 的坑都在边界——单字查询（没有滑窗，应该什么都匹配不到）、
// 归档文件写了半行（JSON 坏行不能拖垮整次检索）、同分消息多（必须按时间倒序，否则
// 群友问「刚说的那个」会拿到昨天的）。这些逻辑原来内联在 bridge.js 的闭包里，只能靠起桥接验证。
//
// 运行：node scripts/test-archive.mjs

import { queryShingles, parseArchiveLines, searchArchive } from '../src/archive-search.js';

let pass = 0;
let fail = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass += 1; console.log(`  ok   ${name} → ${JSON.stringify(got)}`); }
  else { fail += 1; console.log(`  FAIL ${name} → got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

console.log('\n[1] 滑窗：中文按 2 字切；单字查询没有滑窗（= 匹配不到任何东西）');
{
  check('两字词', [...queryShingles('猫娘')], ['猫娘']);
  check('三字词', [...queryShingles('猫娘酱')], ['猫娘', '娘酱']);
  check('单字 → 空集合', [...queryShingles('猫')], []);
  check('空串 → 空集合', [...queryShingles('')], []);
  check('undefined → 空集合', [...queryShingles(undefined)], []);
  check('首尾空白被裁掉', [...queryShingles('  猫娘  ')], ['猫娘']);
  check('英文按字符切', [...queryShingles('abc')], ['ab', 'bc']);
}

console.log('\n[2] 坏行容忍：归档是 append-only 文件，进程被杀时会留下半行');
{
  const text = [
    '{"text":"今天天气不错","t":1}',
    '',
    '{"text":"被截断的半行"',
    '123',
    '{"text":"昨天聊过猫娘","t":2}',
    '   '
  ].join('\n');
  const recs = parseArchiveLines(text);
  check('只保留合法且是对象的行', recs.map((r) => r.text), ['今天天气不错', '昨天聊过猫娘']);
  check('空文本输入', parseArchiveLines(''), []);
  check('null 输入', parseArchiveLines(null), []);
}

console.log('\n[3] 检索：命中数打分 + 同分时间倒序 + limit');
{
  const recs = [
    { text: '完全无关的一句话', t: 100, sender: 'A' },
    { text: '猫娘今天很开心', t: 200, sender: 'B' }, // 命中「猫娘」
    { text: '猫娘和娘酱都在', t: 300, sender: 'C' }, // 命中「猫娘」「娘酱」→ 2 分
    { text: '猫娘昨天下线了', t: 400, sender: 'D' }, // 命中「猫娘」→ 1 分，比 B 新
    { text: '', t: 500, sender: 'E' }
  ];
  const got = searchArchive(recs, '猫娘酱');
  check('按分数降序：2 分的排第一', got[0].sender, 'C');
  check('同分按时间倒序：D 比 B 新', got.slice(1).map((r) => r.sender), ['D', 'B']);
  check('无关/空文本不返回', got.some((r) => r.sender === 'A' || r.sender === 'E'), false);
  check('不把内部 _score 泄漏给调用方', Object.keys(got[0]).includes('_score'), false);

  check('空查询 → 空结果', searchArchive(recs, ''), []);
  check('单字查询 → 空结果（无滑窗）', searchArchive(recs, '猫'), []);
  check('没有命中 → 空结果', searchArchive(recs, '导弹'), []);
  check('limit 生效', searchArchive(recs, '猫娘酱', 1).length, 1);
  check('limit 非法回落默认 12', searchArchive(recs, '猫娘酱', 'abc').length, 3);
  check('非数组输入不抛', searchArchive(null, '猫娘'), []);
  check('记录缺 text 字段被跳过', searchArchive([{ t: 1 }, { text: '猫娘', t: 2 }], '猫娘').length, 1);
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
