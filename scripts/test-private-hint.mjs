// 私聊「加我好友」提示：阈值 / 冷却 / 归零（纯函数，无副作用）。
// 真机场景：私聊只能收文字，聊到十几句用户还不知道「加好友能收图」——所以这条提示
// 的阈值错了会变成打扰、冷却错了会变成刷屏，必须有测试钉住边界。
import {
  PRIVATE_HINT_DEFAULT,
  normalizePrivateHintConfig,
  privateHintText,
  shouldAddFriendHint,
  nextHintState
} from '../src/private-hint.js';

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

const NOW = 1_760_000_000_000;
const DAY = 24 * 3600 * 1000;

console.log('\n## 默认配置');
eq('默认阈值 15 句 / 24 小时 / 开启',
  [PRIVATE_HINT_DEFAULT.afterMessages, PRIVATE_HINT_DEFAULT.cooldownMs, PRIVATE_HINT_DEFAULT.enabled],
  [15, DAY, true]);
eq('空 cfg 用默认值', normalizePrivateHintConfig(), { afterMessages: 15, cooldownMs: DAY, enabled: true });
eq('坏值回落默认（阈值 0 / 冷却 -1）',
  normalizePrivateHintConfig({ afterMessages: 0, cooldownMs: -1 }),
  { afterMessages: 15, cooldownMs: DAY, enabled: true });
eq('enabled 只认显式 false 才关', normalizePrivateHintConfig({ enabled: 'no' }).enabled, true);

console.log('\n## 阈值边界');
eq('14 句不提示', shouldAddFriendHint({ sentCount: 14, lastHintAt: 0, now: NOW }), { hint: false, text: '' });
eq('15 句提示', shouldAddFriendHint({ sentCount: 15, lastHintAt: 0, now: NOW }).hint, true);
eq('16 句提示', shouldAddFriendHint({ sentCount: 16, lastHintAt: null, now: NOW }).hint, true);
eq('自定义 3 句', shouldAddFriendHint({ sentCount: 3, cfg: { afterMessages: 3 }, now: NOW }).hint, true);
eq('负数计数当 0', shouldAddFriendHint({ sentCount: -5, now: NOW }).hint, false);
eq('非法计数当 0', shouldAddFriendHint({ sentCount: 'abc', now: NOW }).hint, false);

console.log('\n## 冷却');
eq('冷却中（1 小时前提示过）不提示',
  shouldAddFriendHint({ sentCount: 20, lastHintAt: NOW - 3600 * 1000, now: NOW }).hint, false);
eq('冷却刚过（23:59 前提示）仍不提示',
  shouldAddFriendHint({ sentCount: 20, lastHintAt: NOW - DAY + 60_000, now: NOW }).hint, false);
eq('冷却满 24 小时再提示',
  shouldAddFriendHint({ sentCount: 20, lastHintAt: NOW - DAY, now: NOW }).hint, true);
eq('自定义冷却 1 分钟：2 分钟前提示过可再提示',
  shouldAddFriendHint({ sentCount: 20, lastHintAt: NOW - 120_000, now: NOW, cfg: { cooldownMs: 60_000 } }).hint, true);

console.log('\n## 开关与文案');
eq('enabled:false 永不提示（即使 999 句且冷却早过）',
  shouldAddFriendHint({ sentCount: 999, lastHintAt: 0, now: NOW, cfg: { enabled: false } }),
  { hint: false, text: '' });
const text = privateHintText();
check('文案 ≤45 字', Array.from(text).length <= 45, `实际 ${Array.from(text).length}`);
check('文案像人话：含「好友」「表情」', text.includes('好友') && text.includes('表情'));
check('文案不含「系统」', !text.includes('系统'));
eq('提示命中时带的就是这句文案', shouldAddFriendHint({ sentCount: 15, now: NOW }).text, text);

console.log('\n## 状态推进');
eq('hinted=true：记时间 + 计数归零',
  nextHintState({ sentCount: 18, lastHintAt: 0 }, NOW, true),
  { sentCount: 0, lastHintAt: NOW });
eq('hinted=false：原样（不改计数/时间）',
  nextHintState({ sentCount: 18, lastHintAt: 123 }, NOW, false),
  { sentCount: 18, lastHintAt: 123 });
eq('坏状态回落 0', nextHintState({ sentCount: 'x', lastHintAt: -3 }, NOW, false), { sentCount: 0, lastHintAt: 0 });
const state = { sentCount: 20, lastHintAt: 5 };
const next = nextHintState(state, NOW, true);
check('不改入参', state.sentCount === 20 && state.lastHintAt === 5 && next.sentCount === 0);
check('提示后要重新攒够 15 句才再提示',
  shouldAddFriendHint({ sentCount: next.sentCount + 14, lastHintAt: next.lastHintAt, now: NOW + 1 }).hint === false
  && shouldAddFriendHint({ sentCount: 15, lastHintAt: next.lastHintAt, now: NOW + DAY }).hint === true);

console.log('');
if (failures.length) {
  console.error(`private-hint：通过 ${pass} / 失败 ${failures.length}`);
  process.exit(1);
}
console.log(`🎉 private-hint 全部通过（${pass} 项）`);
