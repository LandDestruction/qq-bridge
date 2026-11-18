// 私聊临时通行证的纯逻辑单测：日期滚动、间隔封顶、额度边界。
import {
  accrueUsage, dayKey, formatLeft, quotaState,
  DEFAULT_DAILY_MINUTES, DEFAULT_IDLE_CAP_MINUTES
} from '../src/private-quota.js';

let pass = 0;
let fail = 0;
function check(name, got, want) {
  if (got === want) { pass += 1; console.log(`  ok   ${name} → ${got}`); }
  else { fail += 1; console.log(`  FAIL ${name} → got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

const CAP = DEFAULT_IDLE_CAP_MINUTES * 60 * 1000; // 10 分钟
const T0 = new Date('2026-10-24T10:00:00+08:00').getTime();

console.log('\n[1] 日期键与跨天重置');
{
  check('本地日期键格式', dayKey(new Date(T0)), '2026-10-24');
  const first = accrueUsage(undefined, T0, { idleCapMs: CAP });
  check('首次说话不计间隔', first.usedMs, 0);
  const second = accrueUsage(first, T0 + 60_000, { idleCapMs: CAP });
  check('隔 1 分钟累加 1 分钟', second.usedMs, 60_000);
  const nextDay = accrueUsage(second, T0 + 24 * 3600_000, { idleCapMs: CAP });
  check('跨天清零', nextDay.usedMs, 0);
}

console.log('\n[2] 离开不计：间隔超过 idleCap 只算 cap');
{
  let st = accrueUsage(undefined, T0, { idleCapMs: CAP });
  st = accrueUsage(st, T0 + 3 * 3600_000, { idleCapMs: CAP });
  check('离开 3 小时 → 只计 10 分钟', st.usedMs, CAP);
  st = accrueUsage(st, T0 + 3 * 3600_000 + 30_000, { idleCapMs: CAP });
  check('回来继续说 30 秒', st.usedMs, CAP + 30_000);
}

console.log('\n[3] 额度判定与文案');
{
  const budget = DEFAULT_DAILY_MINUTES * 60 * 1000;
  check('刚开聊未超', quotaState(0).exceeded, false);
  check('剩一半', quotaState(budget / 2).leftMs, budget / 2);
  check('刚好用完即超', quotaState(budget).exceeded, true);
  check('百分比封顶 100', quotaState(budget * 2).percent, 100);
  check('剩 90 分钟文案', formatLeft(90 * 60_000), '今天还能聊 1 小时 30 分钟');
  check('剩 5 分钟文案', formatLeft(5 * 60_000), '今天还能聊 5 分钟');
  check('用完文案', formatLeft(0), '今天没有额度了');
}

console.log('\n[4] 入站闸门：白名单群成员自动获得私聊通行证（源码级）');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/bridge/incoming-runtime.js', import.meta.url), 'utf8');
  check('通行证判定包含群成员', /const passPrivate = isPrivate && \(q\.open \|\| \(0, deps\.isGroupMember\)/.test(src), true);
  check('未授权闸门用 passPrivate（不是只看 privateOpen）', /if \(!whitelisted && !passPrivate\)/.test(src), true);
  check('额度扣减也用 passPrivate', /if \(passPrivate && !\(cfg\.allow\?\.private/.test(src), true);
  const passAt = src.indexOf('const passPrivate =');
  const quotaAt = src.indexOf('consumePrivateQuota)(uid)');
  const rejectAt = src.indexOf('if (!whitelisted && !passPrivate)');
  check('判定在扣额度之前', passAt > 0 && quotaAt > passAt, true);
  check('判定在未授权闸门之前', rejectAt > passAt, true);

  const policy = fs.readFileSync(new URL('../src/bridge/session-policy.js', import.meta.url), 'utf8');
  check('会话策略也认群成员', /kind === 'private' && \(0, deps\.isGroupMember\)\(id\)/.test(policy), true);

  const lists = fs.readFileSync(new URL('../src/bridge/console/lists.js', import.meta.url), 'utf8');
  check('名单接口下发 privatePass 状态', /privatePass: \{/.test(lists), true);
  check('privatePass 带成员数与额度', /memberCount: Math\.max\(0, Number\(deps\.groupMemberCache\?\.size\)/.test(lists), true);

  // [5] 私聊真的发得出去：临时会话要有「共同群」可用，且不会因为缺参数 500。
  const quotaSrc = fs.readFileSync(new URL('../src/bridge/private-quota-runtime.js', import.meta.url), 'utf8');
  check('群成员缓存记下他在哪些群', /groups: \[String\(gid\)\]/.test(quotaSrc), true);
  check('导出 memberGroupOf 取共同群', /function memberGroupOf\(uid\)/.test(quotaSrc) && /memberGroupOf, privateQuotaCfg/.test(quotaSrc), true);

  const temp = fs.readFileSync(new URL('../src/private-temp-session.js', import.meta.url), 'utf8');
  check('临时会话在没最近群记录时退到群成员缓存', /const cached = seen \? '' : String\(deps\.memberGroupOf\?\.\(key\) \|\| ''\)/.test(temp), true);
  check('仍然优先用最近发言的那个群', temp.indexOf('const seen = deps.recentUserGroup.get(key)') < temp.indexOf('deps.memberGroupOf'), true);

  const send = fs.readFileSync(new URL('../src/bridge/console/conversation-send.js', import.meta.url), 'utf8');
  check('send-message 把 quotas 阶段的 ctx 交给发送（不然 delays 缺失直接 500）', /sendMessageFinal\(deps, request, prepared\)/.test(send), true);
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
