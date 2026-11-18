// 端到端确认：buildWakePromptV2 真的把「群成员，不是客服」拼进去了，并且旧指令已消失。
import { bridgeHarness } from './audit-bridge-harness.mjs';

const h = await bridgeHarness();
const KEY = 'group:100000001';
h.setState?.(KEY, { agentToken: 'tok', unread: [], recentMessages: [], wakeConfig: {}, userPersonas: {} });

let text;
try {
  text = h.buildWakePromptV2(KEY, 'atMention', { dryRun: true });
} catch (error) {
  // 有的 harness 需要先建会话状态；退一步用 debug 原因再试
  text = h.buildWakePromptV2(KEY, 'debug', { dryRun: true });
}

const has = (needle) => String(text).includes(needle);
console.log('len', String(text).length);
console.log('风格块  ', has('群里的一个成员，不是客服'));
console.log('可以不说话', has('可以插话，也可以不说话'));
console.log('收尾路径 ', has('qq_mark_read'));
console.log('例子     ', has('你那一把还没打完啊'));
console.log('旧指令   ', has('不要习惯性潜水'), '(应为 false)');
