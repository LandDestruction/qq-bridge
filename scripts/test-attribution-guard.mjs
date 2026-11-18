#!/usr/bin/env node
// 归因守卫：发消息前粗查「这句话真是这个人说的吗」。
// 现场（2026-11-02）：友人A 说「这鱼一直一股茶味」，机器人把这句安到 依 头上
// （「依，不是嫌我有茶味吗」）。纯规则在 src/attribution-guard.js，这里验证规则 + 接线。
// 用法：node scripts/test-attribution-guard.mjs
import fs from 'node:fs';
import { checkAttribution, describeSuspects, extractClaims, keywordsOf, ATTRIBUTION_VERBS, NOT_NAMES } from '../src/attribution-guard.js';

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const RECENT = [
  { sender: '友人A', text: '这鱼一直一股茶味' },
  { sender: '麦子🌾Wheat', text: '@友人A 谁' },
  { sender: '依', text: '我可能顶不住' },
  { sender: '友人A', text: '有茶味' },
];

// ── 1. 现场复现：把好友A 的话安到 依 头上 ────────────────────────────────
const bad = checkAttribution('依，不是嫌我有茶味吗，这会儿又顶不住了', RECENT, { selfName: '大肥鱼小姐' });
ok('复现：句中称呼 依 + 嫌 → 判可疑', bad.ok === false, JSON.stringify(bad.suspects));
ok('可疑理由是没有证据（no-evidence）', bad.suspects[0]?.reason === 'no-evidence', bad.suspects[0]?.reason);
ok('可疑对象就是 依', bad.suspects[0]?.name === '依', bad.suspects[0]?.name);
ok('describeSuspects 能说人话', describeSuspects(bad.suspects).includes('依嫌'), describeSuspects(bad.suspects));

// ── 2. 正确的归因不报 ───────────────────────────────────────────────────
const good = checkAttribution('友人A说这鱼一股茶味', RECENT, { selfName: '大肥鱼小姐' });
ok('友人A 说茶味 → 放行', good.ok === true, JSON.stringify(good.suspects));
const quoted = checkAttribution('群里有人说这鱼一股茶味，我也不知道是谁', RECENT, { selfName: '大肥鱼小姐' });
ok('「有人说」不是断言 → 放行', quoted.ok === true);

// ── 3. 不认识的说话人 ───────────────────────────────────────────────────
const unknown = checkAttribution('路人甲说这鱼一股茶味', RECENT, { selfName: '大肥鱼小姐' });
ok('最近没人叫「路人甲」→ unknown-speaker', unknown.suspects[0]?.reason === 'unknown-speaker', JSON.stringify(unknown.suspects));

// ── 4. 自己的名字不查 ───────────────────────────────────────────────────
const self = checkAttribution('大肥鱼小姐说这鱼一股茶味', RECENT, { selfName: '大肥鱼小姐' });
ok('自己说的话不参与归因检查', self.ok === true && self.claims === 0, `claims=${self.claims}`);

// ── 5. 虚词拼出来的「名字」不算人 ────────────────────────────────────────
const noise = extractClaims('不是嫌我茶味吗，就是觉得你太吵');
ok('「不是/就是」不被当成人名', noise.every((c) => c.name !== '不是' && c.name !== '就是'), JSON.stringify(noise.map((c) => c.name)));
ok('代词不算人名', extractClaims('她觉得我有茶味').every((c) => !NOT_NAMES.has(c.name)), JSON.stringify(extractClaims('她觉得我有茶味')));

// ── 6. 关键词抽取 ───────────────────────────────────────────────────────
ok('茶味 在关键词里', keywordsOf('我有茶味吗，这会').includes('茶味'), JSON.stringify(keywordsOf('我有茶味吗，这会')));
ok('纯虚词抽不出关键词', keywordsOf('了吗呢啊').length === 0, JSON.stringify(keywordsOf('了吗呢啊')));

// ── 7. 上下文太少不判（刚启动/刚清屏）──────────────────────────────────
const thin = checkAttribution('依嫌我有茶味', RECENT.slice(0, 2), { selfName: '大肥鱼小姐' });
ok('最近消息不足 3 条 → 不判（避免假警告）', thin.ok === true && thin.claims === 0, JSON.stringify(thin));

// ── 8. 接线：发送链路里真的调了 ─────────────────────────────────────────
const bridgeSrc = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
ok('bridge.js 引入 attribution-guard', bridgeSrc.includes("from './attribution-guard.js'"));
ok('sendToQQ 包装里调用 checkAttribution', /checkAttribution\(out,/.test(bridgeSrc));
ok('可疑时打 [归因] 日志', bridgeSrc.includes('[归因] 可疑'));
ok('默认开关来自 socialV2.attributionGuard.enabled', bridgeSrc.includes('socialV2?.attributionGuard?.enabled'));
ok('动词表里含 嫌/说/吐槽', ['嫌', '说', '吐槽'].every((v) => ATTRIBUTION_VERBS.includes(v)));

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
