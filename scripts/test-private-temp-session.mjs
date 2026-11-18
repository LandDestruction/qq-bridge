// D67：私聊临时会话兜底治理的回归测试。
//
// 真机 17:52 的现象：临时会话已过期，桥接却遍历 4 个白名单群各试一次，SnowLuma 全报
// no such temp session → 4 条日志、每条消息都重试。这里钉住四件事：
//   ① 只试 recentUserGroup 记录的那一个群（没有记录就不试，绝不遍历 cfg.allow.groups）；
//   ② 命中 QQ 临时会话错误 → 按 uid 写 30 分钟冷却，冷却期内不再发（只记一行日志）；
//   ③ 白名单群成员且冷却刚触发 → 在最近群里 @ 他一次；陌生人静默；
//   ④ 成功/失败都只记一行（不再刷 4 条）。
// 另外钉住接线：outbound-text 的 sendPrivateViaTempSession 必须委托给这个服务，桥接里建好注入。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOutboundText } from '../src/bridge/outbound-text.js';
import {
  createPrivateUnreachableStore,
  createTempSessionFallback,
  isTempSessionFailure,
  TEMP_SESSION_COOLDOWN_MS,
  TEMP_SESSION_GROUP_HINT
} from '../src/private-temp-session.js';
import { readBridgeSource } from './bridge-source.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd67-private-'));
const fileOf = (name) => path.join(tmpDir, name);

// 假网关闭包：可按动作排错误，记录每次请求；原子写用「临时文件+rename」模拟线上实现。
function makeHarness({ privateFails = false, wording = 'no such temp session', members = new Set(), groups = ['111', '222', '333', '444'] } = {}) {
  const logLines = [];
  const fetches = [];
  let clock = 1_793_090_000_000;
  const now = () => clock;
  const store = createPrivateUnreachableStore({
    file: fileOf(`unreachable-${Math.random().toString(36).slice(2)}.json`),
    fs,
    now,
    writeJson: (file, obj) => {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, file);
    },
    log: (m) => logLines.push(String(m))
  });
  const deps = {
    cfg: { snowluma: { httpUrl: 'http://127.0.0.1:3000' }, allow: { groups }, sendDelayMs: 0 },
    AbortSignal,
    fetch: async (url, init = {}) => {
      const body = JSON.parse(init.body || '{}');
      const action = String(url).split('/').pop();
      fetches.push({ action, body });
      if (action === 'send_group_msg') return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 77 } }) };
      if (privateFails) return { ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 16, wording }) };
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
    },
    recentUserGroup: new Map(),
    isGroupMember: (uid) => members.has(String(uid)),
    log: (m) => logLines.push(String(m)),
    KNOWN_AGENT_TOKENS: new Set(),
    escapeCqText: (s) => s,
    withTimeout: (p) => p,
    sleep: async () => {},
    splitForQQ: (s) => [s],
    text: (s) => s
  };
  // 群内提示走真实的 onebotSend（@ 段由它拼），这样断言的是真正会发出去的消息结构。
  const outbound = createOutboundText(deps);
  const send = createTempSessionFallback({
    get cfg() { return deps.cfg; },
    fetch: deps.fetch,
    AbortSignal,
    log: deps.log,
    get recentUserGroup() { return deps.recentUserGroup; },
    store,
    get isGroupMember() { return deps.isGroupMember; },
    sendGroupHint: (groupId, uid) => outbound.onebotSend('group', groupId, TEMP_SESSION_GROUP_HINT, null, uid)
  });
  return { deps, store, fetches, logLines, send, advance: (ms) => { clock += ms; }, now };
}

console.log('## 1. 失败文案判定：三种实锤都认，普通错误不认（不误冷却）');
{
  check('no such temp session', isTempSessionFailure('no such temp session'));
  check('请先添加对方为好友', isTempSessionFailure('请先添加对方为好友'));
  check('result=16', isTempSessionFailure('send failed: result=16'));
  check('retcode=16（兜底再造的同一含义）', isTempSessionFailure('retcode=16'));
  check('大小写不敏感', isTempSessionFailure('No Such Temp Session'));
  check('普通网络错误不当成临时会话失败', !isTempSessionFailure('ECONNRESET'));
  check('空值不炸', !isTempSessionFailure(undefined) && !isTempSessionFailure(null));
}

console.log('## 2. 冷却账本：按 uid、30 分钟、落盘可跨进程、脏文件不炸');
{
  const h = makeHarness();
  check('初始不在冷却', h.store.isCooling('10001') === false);
  const first = h.store.markUnreachable('10001', { reason: 'no such temp session', groupId: '111' });
  check('第一次 mark：newly=true', first.newly === true);
  check('冷却时长=30 分钟', first.until - h.now() === TEMP_SESSION_COOLDOWN_MS && TEMP_SESSION_COOLDOWN_MS === 30 * 60 * 1000);
  check('冷却中 isCooling=true', h.store.isCooling('10001') === true);
  check('冷却信息带群与原因', h.store.coolingInfo('10001')?.groupId === '111' && h.store.coolingInfo('10001')?.reason.includes('temp session'));
  check('别的 uid 不受影响', h.store.isCooling('10002') === false);
  const file = fileOf('reload.json');
  const s1 = createPrivateUnreachableStore({ file, fs, now: () => 1000, writeJson: (f, o) => fs.writeFileSync(f, JSON.stringify(o)) });
  s1.markUnreachable('20001', { reason: '请先添加对方为好友', groupId: '222' });
  const s2 = createPrivateUnreachableStore({ file, fs, now: () => 1000 + 60_000, writeJson: () => {} });
  check('重新加载（模拟重启）仍记得冷却', s2.isCooling('20001') === true && s2.coolingInfo('20001')?.groupId === '222');
  const s3 = createPrivateUnreachableStore({ file, fs, now: () => 1000 + TEMP_SESSION_COOLDOWN_MS + 1, writeJson: () => {} });
  check('过期后自动失效', s3.isCooling('20001') === false);
  const s4 = createPrivateUnreachableStore({ file, fs, now: () => 1000, writeJson: () => {} });
  const again = s4.markUnreachable('20001', { reason: 'no such temp session', groupId: '222' });
  check('冷却期内重复失败不延长冷却（until 不变）', again.newly === false && again.until === 1000 + TEMP_SESSION_COOLDOWN_MS);
  const corrupt = fileOf('corrupt.json');
  fs.writeFileSync(corrupt, '{not json');
  const s5 = createPrivateUnreachableStore({ file: corrupt, fs, now: () => 1000, writeJson: () => {} });
  check('坏文件当空账本，不抛', s5.isCooling('1') === false);
  const junk = fileOf('junk.json');
  fs.writeFileSync(junk, JSON.stringify({ '30001': { until: 'abc' }, '30002': 'x', '30003': { until: 999999 } }));
  const s6 = createPrivateUnreachableStore({ file: junk, fs, now: () => 1000, writeJson: () => {} });
  check('脏条目被丢掉，好条目保留', s6.isCooling('30001') === false && s6.isCooling('30002') === false && s6.isCooling('30003') === true);
}

console.log('## 3. 只试最近那个群一次：没有记录就不试，4 个白名单群也只打 1 次');
{
  const h = makeHarness({ privateFails: true });
  h.deps.recentUserGroup.set('40001', '111');
  const ok = await h.send(40001, [{ type: 'text', data: { text: 'hi' } }]);
  check('返回 false（没发出去）', ok === false);
  check('只发了 1 次请求（不再 ×4 遍历）', h.fetches.length === 1 && h.fetches[0].action === 'send_private_msg');
  check('请求带的是最近群 111，不是白名单里的 222/333/444', h.fetches[0].body.group_id === 111);
  check('失败后 40001 进入冷却', h.store.isCooling('40001') === true);
  const failLogs = h.logLines.filter((l) => l.includes('私聊临时会话不可达'));
  check('日志只记一行（uid/群/原因都在）', failLogs.length === 1 && failLogs[0].includes('40001') && failLogs[0].includes('111'));

  const callsBefore = h.fetches.length;
  const ok2 = await h.send(40001, [{ type: 'text', data: { text: 'hi again' } }]);
  check('冷却期内不再发请求', ok2 === false && h.fetches.length === callsBefore);
  check('冷却期只记账（一行「冷却中」）', h.logLines.filter((l) => l.includes('冷却中')).length >= 1);

  const h2 = makeHarness({ privateFails: true });
  await h2.send(40002, [{ type: 'text', data: { text: 'x' } }]);
  check('没有最近群记录时一次都不试', h2.fetches.length === 0);
  check('没有记录时日志说清原因', h2.logLines.some((l) => l.includes('没有最近群记录')) && !h2.store.isCooling('40002'));
}

console.log('## 4. 群成员兜底提示只发一次；陌生人静默');
{
  const h = makeHarness({ privateFails: true, members: new Set(['50001']) });
  h.deps.recentUserGroup.set('50001', '222');
  await h.send(50001, [{ type: 'text', data: { text: 'x' } }]);
  const groupSends = h.fetches.filter((f) => f.action === 'send_group_msg');
  check('群成员：发了 1 条群里提示', groupSends.length === 1 && groupSends[0].body.group_id === 222);
  const segs = groupSends[0]?.body?.message;
  check('提示 @ 了他本人', Array.isArray(segs) && segs.some((s) => s.type === 'at' && String(s.data.qq) === '50001'));
  check('提示文案是「私聊通道暂时不通…在群里叫我就行」', Array.isArray(segs) && segs.some((s) => s.type === 'text' && s.data.text.includes('私聊通道暂时不通') && s.data.text.includes('在群里叫我就行')));
  await h.send(50001, [{ type: 'text', data: { text: 'y' } }]);
  check('冷却期内不重复 @', h.fetches.filter((f) => f.action === 'send_group_msg').length === 1);

  const h2 = makeHarness({ privateFails: true, members: new Set() });
  h2.deps.recentUserGroup.set('50002', '222');
  await h2.send(50002, [{ type: 'text', data: { text: 'x' } }]);
  check('陌生人：群里完全静默', h2.fetches.filter((f) => f.action === 'send_group_msg').length === 0);
  check('陌生人仍会写冷却（避免重复撞）', h2.store.isCooling('50002') === true);

  const h3 = makeHarness({ privateFails: true, members: new Set(['50003']), groups: ['222'] });
  h3.deps.recentUserGroup.set('50003', '999'); // 最近群不在白名单
  await h3.send(50003, [{ type: 'text', data: { text: 'x' } }]);
  check('最近群不在白名单时不往该群发提示（防越界）', h3.fetches.filter((f) => f.action === 'send_group_msg').length === 0);
}

console.log('## 5. 成功与非临时会话错误：不写冷却');
{
  const h = makeHarness({ privateFails: false });
  h.deps.recentUserGroup.set('60001', '333');
  const ok = await h.send(60001, [{ type: 'text', data: { text: 'hello' } }]);
  check('成功返回 true', ok === true);
  check('成功后不写冷却', h.store.isCooling('60001') === false);
  check('成功日志一行', h.logLines.filter((l) => l.includes('私聊改用临时会话发出')).length === 1);

  const h2 = makeHarness({ privateFails: true, wording: 'blocked by server' });
  h2.deps.recentUserGroup.set('60002', '333');
  const ok2 = await h2.send(60002, [{ type: 'text', data: { text: 'hello' } }]);
  check('非临时会话错误返回 false 且不冷却（网络问题不锁 30 分钟）', ok2 === false && h2.store.isCooling('60002') === false);
  check('非临时会话错误也只是一行日志', h2.logLines.filter((l) => l.includes('私聊临时会话发送失败')).length === 1);

  // 冷却到期后允许再试一次
  const h3 = makeHarness({ privateFails: true });
  h3.deps.recentUserGroup.set('60003', '444');
  await h3.send(60003, [{ type: 'text', data: { text: '1' } }]);
  h3.advance(TEMP_SESSION_COOLDOWN_MS + 1);
  const before = h3.fetches.length;
  await h3.send(60003, [{ type: 'text', data: { text: '2' } }]);
  check('冷却到期后会再试（不是永久锁死）', h3.fetches.length === before + 1);
}

console.log('## 6. 接线（静态）：outbound-text 委托、bridge 建服务并注入');
{
  const bridge = readBridgeSource();
  check('bridge 引入了 private-temp-session 模块', /from '\.\/private-temp-session\.js'/.test(bridge));
  check('bridge 建了 private-unreachable.json 账本', /private-unreachable\.json/.test(bridge));
  check('bridge 建了 privateTempSession 服务并注入 runtimeBindings',
    /createTempSessionFallback\(/.test(bridge) && /privateTempSession\(\) \{ return privateTempSession; \}/.test(bridge));
  check('outbound-text 的 sendPrivateViaTempSession 委托给该服务（逻辑不堆回工厂）',
    /return deps\.privateTempSession\(Number\(uid\), message\)/.test(
      fs.readFileSync(new URL('../src/bridge/outbound-text.js', import.meta.url), 'utf8')));
  check('outbound-text 工厂没有重新长胖（仍是委托一行）', /async function sendPrivateViaTempSession\(uid, message\) \{\n\s+\/\/ D67/.test(
    fs.readFileSync(new URL('../src/bridge/outbound-text.js', import.meta.url), 'utf8')));
  check('仍然只有 send_private_msg（SnowLuma 不支持 send_group_private_msg）', !bridge.includes('send_group_private_msg'));
  const delegationProbe = createOutboundText({ privateTempSession: async (uid, message) => ({ uid, message }) });
  const got = await delegationProbe.sendPrivateViaTempSession('70001', 'ping');
  check('委托真的把 (uid, message) 传下去，且 uid 归一成数字', got?.uid === 70001 && got?.message === 'ping');
}

console.log('');
const total = pass + failures.length;
if (failures.length) {
  console.log(`❌ test-private-temp-session 失败 ${failures.length}/${total}`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log(`✅ test-private-temp-session 全部通过（${pass}/${total}）`);
assert.ok(pass > 0);
