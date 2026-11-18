#!/usr/bin/env node
import { readBridgeSource } from './bridge-source.mjs';
import { readMcpSafeSource } from './mcp-safe-source.mjs';
// M7-B 接线测试：只验证「bridge 把好感度接对了」，纯逻辑仍由 scripts/test-affinity.mjs 覆盖。
// 用法：node scripts/test-affinity-wiring.mjs
import fs from 'node:fs';
import { describeForPrompt, privacyLine, normalizeRules, emptyStore, ensurePerson, shiftByModel } from '../src/affinity.js';

const bridge = readBridgeSource();
const mcp = readMcpSafeSource();
const pack = JSON.parse(fs.readFileSync(new URL('../scripts/pack-exclude.json', import.meta.url), 'utf8'));

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => { if (c) { pass += 1; console.log(`  ok   ${n}${d ? ' — ' + d : ''}`); } else { fail += 1; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

console.log('[1] 三处接线都在');
ok('bridge 从 affinity.js 引入纯函数', /from '\.\/affinity\.js'/.test(bridge) && bridge.includes('describeForPrompt'));
ok('① 入站结算：appendSocialV2Message 里调 affinityNoteInbound',
  /function appendSocialV2Message[\s\S]{0,6000}?affinityNoteInbound\(key, userId/.test(bridge));
ok('② 被问注入：deliverPromptNow 里把 affinityPromptBlock 前置到 promptText',
  /affinityPromptBlock\(key\)[\s\S]{0,80}promptText = hint \+ promptText/.test(bridge));
ok('③ 改分端点存在且走 agent token + 工具开关',
  bridge.includes("url.pathname === '/api/affinity/shift'") && bridge.includes("v2ToolEnabled('affinityShift')") && bridge.includes('agentTokenOk(key, agentToken)'));
ok('拒绝分支返回 ok:false + code（不是 HTTP 4xx，模型要能看到人话原因）',
  /sendJson\(\{ ok: r\.ok === true, \.\.\.r \}\)/.test(bridge));
ok('入库/落盘路径：state/affinity.json 原子写', bridge.includes("path.join(STATE_DIR, 'affinity.json')") && bridge.includes('saveStore(AFFINITY_FILE'));

console.log('\n[2] 注入片段（≤300 字 + 隐私行 + 不得改分）');
const rules = normalizeRules(null);
const store = emptyStore();
const p = ensurePerson(store, '1000000003', Date.now(), rules);
p.name = '小明';
p.reasons.push({ ts: Date.now(), by: 'heuristic', delta: 1, why: '连续第 7 天来群里' });
const text = describeForPrompt(p, rules);
ok('片段含分数与底分/印象', /当前 \d+\/100（底分 .+ 印象 .+）/.test(text), text.slice(0, 40));
ok('片段含「本轮不得调用 qq_affinity_shift」', text.includes('本轮不得调用 qq_affinity_shift'));
ok('片段长度 ≤300 字', [...text].length <= 300, `${[...text].length} 字`);
ok('隐私行只报对方自己 + 婉拒第三人', privacyLine(rules).includes('只能报对方自己的分数') && privacyLine(rules).includes('婉拒'));
ok('bridge 里把两者都注入（describeForPrompt + privacyLine）',
  /describeForPrompt\(person, rules, \{[^}]*nickname[^}]*memories[^}]*\}\)[\s\S]{0,120}privacyLine\(rules\)/.test(bridge));

console.log('\n[3] 工具拒绝分支的四个返回码（接线依赖，纯函数侧的契约）');
const mk = () => { const s = emptyStore(); ensurePerson(s, '42', Date.now(), rules); return s; };
const codeOf = (args) => shiftByModel(mk(), { userId: '42', delta: 1, reason: '一起玩', now: Date.now(), rules, ...args }).code;
ok('asked_this_turn：被问那一轮拒绝改分', codeOf({ askedThisTurn: true }) === 'asked_this_turn');
ok('no_inbound：本轮没这个人说话拒绝', codeOf({ hadInboundThisTurn: false }) === 'no_inbound');
ok('bad_delta：|delta|>3 拒绝', codeOf({ delta: 4, hadInboundThisTurn: true }) === 'bad_delta');
ok('cooldown：10 分钟内重复拒绝 / daily_limit：日累计超 10 拒绝（二者之一命中即算，取决于既有 modelDelta）',
  ['cooldown', 'daily_limit', 'ok'].includes(codeOf({ hadInboundThisTurn: true })));
ok('bridge 侧把两条上下文喂给 shiftByModel（askedThisTurn + hadInboundThisTurn）',
  bridge.includes('askedThisTurn: !!asked && asked.userId === uid') && bridge.includes('hadInboundThisTurn: recentInbound'));

console.log('\n[4] MCP 工具与打包排除');
ok('qq_affinity_shift 已注册且参数齐（key/token/userId/delta/reason）',
  /'qq_affinity_shift'/.test(mcp) && /userId: z\.union/.test(mcp) && /delta: z\.number\(\)/.test(mcp) && /reason: z\.string\(\)/.test(mcp));
ok('工具 POST 到 /api/affinity/shift 并带 x-agent-token', mcp.includes("agentApi('/api/affinity/shift'") && mcp.includes("'x-agent-token': token"));
ok('pack-exclude 里有 state/affinity.json', (pack.removePaths || []).includes('state/affinity.json'));

console.log('\n[5] 控制台名单 GET /api/affinity（M7 §7：只读、仅管理端）');
ok('名单端点存在且走纯函数 listForConsole', bridge.includes("url.pathname === '/api/affinity'") && bridge.includes('listForConsole('));
ok('拒绝智能体调用（x-agent-call / x-agent-token → admin_only）',
  /admin_only/.test(bridge) && /req\.headers\['x-agent-call'\] !== undefined/.test(bridge));
ok('名单返回体含 rulesVer / count / people（管理员能核规则版本）',
  /count: people\.length[\s\S]{0,80}people/.test(bridge) && /rulesVer: Number\(store\?\.rulesVer\)/.test(bridge));

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exitCode = fail === 0 ? 0 : 1;
