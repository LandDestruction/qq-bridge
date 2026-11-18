// 纯净模式（极致省 token）：计划清单 + 提示词分段过滤（纯函数）。
// 为什么要测：这套开关唯一的产出就是「哪些段被摘掉、省了多少字」。摘错了会丢人设，
// 摘少了等于没开——两个方向都不能靠肉眼。
import { PURE_MODE_DROPS, PURE_MODE_KEEP, applyPureMode, pureModePlan } from '../src/pure-mode.js';

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

const ON = { socialV2: { pureMode: { enabled: true } } };

console.log('\n## 计划');
eq('默认关闭', pureModePlan({}).enabled, false);
eq('无参也不炸', pureModePlan().enabled, false);
eq('打开：socialV2.pureMode.enabled === true', pureModePlan(ON).enabled, true);
eq('字符串 "true" 不算开', pureModePlan({ socialV2: { pureMode: { enabled: 'true' } } }).enabled, false);
eq('drop 集合固定 8 项', pureModePlan(ON).drop, PURE_MODE_DROPS);
check('keep 非空且含 persona/token', PURE_MODE_KEEP.includes('persona') && PURE_MODE_KEEP.includes('token'));
eq('keep 与 drop 不重叠', PURE_MODE_KEEP.filter((name) => PURE_MODE_DROPS.includes(name)), []);
eq('turnMaxSteps = 6', pureModePlan(ON).turnMaxSteps, 6);
check('note 是一句中文人话', typeof pureModePlan(ON).note === 'string' && pureModePlan(ON).note.includes('省'));
eq('drop 是副本：改结果不影响常量', (() => { const p = pureModePlan(ON); p.drop.push('x'); return PURE_MODE_DROPS.includes('x'); })(), false);

console.log('\n## applyPureMode');
const parts = [
  { name: 'persona', chars: 1200 },
  { name: 'memory', chars: 800 },
  { name: 'slang', chars: 300 },
  { name: 'sticker', chars: 500 },
  { name: 'token', chars: 200 },
  { name: 'sendRhythm', chars: 90 }
];
const off = applyPureMode({}, parts);
eq('关闭时原样返回（顺序不变）', off.parts.map((p) => p.name), parts.map((p) => p.name));
eq('关闭时 savedChars = 0', off.savedChars, 0);
const on = applyPureMode(ON, parts);
eq('开启后摘掉 memory/slang/sticker', on.parts.map((p) => p.name), ['persona', 'token', 'sendRhythm']);
eq('dropped 记录被摘名字', on.dropped, ['memory', 'slang', 'sticker']);
eq('savedChars = 800+300+500', on.savedChars, 1600);
eq('turnMaxSteps 透传', on.turnMaxSteps, 6);
eq('未知 part 名保留', applyPureMode(ON, [{ name: 'mystery', chars: 10 }]).parts.map((p) => p.name), ['mystery']);
eq('空 parts', applyPureMode(ON, []), { enabled: true, parts: [], dropped: [], savedChars: 0, turnMaxSteps: 6, note: pureModePlan(ON).note });
eq('非数组当空', applyPureMode(ON, null).parts, []);
eq('chars 非法不计入 savedChars', applyPureMode(ON, [{ name: 'memory', chars: 'x' }]).savedChars, 0);
check('不改入参（数组与元素都没被动过）',
  parts.length === 6 && parts[1].name === 'memory' && on.parts[0] !== parts[0]);
check('返回的元素是副本', on.parts[0] !== parts[0] && on.parts[0].name === 'persona');
eq('关闭时也返回副本', applyPureMode({}, parts).parts[0] !== parts[0], true);
eq('同名 part 都摘', applyPureMode(ON, [{ name: 'slang', chars: 5 }, { name: 'slang', chars: 7 }]).savedChars, 12);

console.log('');
if (failures.length) {
  console.error(`pure-mode：通过 ${pass} / 失败 ${failures.length}`);
  process.exit(1);
}
console.log(`🎉 pure-mode 全部通过（${pass} 项）`);
