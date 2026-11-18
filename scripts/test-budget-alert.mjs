// 花费 / 用量预警：纯逻辑（阈值、外推、两档判定、冷却、升级立刻发、文案）+ 路由契约。
//
// 覆盖：
//   ① 设置收拾：缺字段/手改坏/越界都要 clamp 回可用值，metric 不认识的落回 cost；
//   ② 外推：刚过 0 点不外推（不然算出天文数字），过去一半时间时预计≈已用×2；
//   ③ 判定：已经超了 = exceed、按节奏会超 = predict、都在线下 = null；关掉开关一律 null；
//   ④ 冷却：冷却内不重复发；换成「已经超了」时即使还在冷却也立刻发；
//   ⑤ 文案：超了 / 可能要超 两套话术，带金额与限额，带最烧的会话；
//   ⑥ 路由：GET 快照、POST 合并写 config.json、POST /test 真发、DELETE 405、
//      智能体带 x-agent-token / x-agent-call 一律 403；
//   ⑦ 巡检：开关关着不动、开着超限发一条、紧接着再巡检（冷却内）不发；
//   ⑧ 前端：用量页有这张卡、写操作已登记、CSS 有对应类。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUDGET_ALERT_DEFAULTS, BUDGET_METRICS, budgetAlertSettingsOf, budgetLimitOf,
  budgetProjection, evaluateBudgetAlert, shouldNotifyBudget,
  formatBudgetNumber, formatBudgetAlert
} from '../src/budget-alert.js';
import { createBudgetAlert } from '../src/bridge/console/budget-alert.js';
import * as budgetPure from '../src/budget-alert.js';
import { updateConfigFile } from '../src/config-write.js';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── ① 设置收拾 ─────────────────────────────────────────────────────────
console.log('## 设置收拾');
const defaults = budgetAlertSettingsOf(undefined);
check('空配置落到默认值', defaults.enabled === false && defaults.metric === 'cost' && defaults.limitCost === 20, JSON.stringify(defaults));
check('默认别名与导出常量一致', BUDGET_ALERT_DEFAULTS.limitTokens === defaults.limitTokens && BUDGET_METRICS.length === 2);
const clamped = budgetAlertSettingsOf({ enabled: 'yes', metric: 'usd', limitCost: -5, limitTokens: 10, cooldownMinutes: 99999 });
check('enabled 只认 true', clamped.enabled === false, String(clamped.enabled));
check('metric 不认识就落回 cost', clamped.metric === 'cost', clamped.metric);
check('limitCost 下限 0.01', clamped.limitCost === 0.01, String(clamped.limitCost));
check('limitTokens 下限 1000', clamped.limitTokens === 1000, String(clamped.limitTokens));
check('cooldown 上限 7 天', clamped.cooldownMinutes === 10080, String(clamped.cooldownMinutes));
const switched = budgetAlertSettingsOf({ metric: 'tokens', limitTokens: 5000000 });
check('切到 token 指标', switched.metric === 'tokens' && budgetLimitOf(switched) === 5000000);
check('金额指标时 limit 取 limitCost', budgetLimitOf(budgetAlertSettingsOf({ metric: 'cost', limitCost: 33 })) === 33);

// ── ② 外推 ─────────────────────────────────────────────────────────────
console.log('## 外推');
const dayStart = new Date('2026-10-29T00:00:00+08:00').getTime();
const early = budgetProjection({ used: 4, now: dayStart + 10 * 60 * 1000, dayStart });
check('刚过 0 点不外推', early.extrapolated === false && early.projected === 4, JSON.stringify(early));
const noon = budgetProjection({ used: 10, now: dayStart + 12 * 3600 * 1000, dayStart });
check('过去一半时间时预计≈已用×2', noon.extrapolated === true && Math.abs(noon.projected - 20) < 0.01, JSON.stringify(noon));
check('每小时速度对得上', Math.abs(noon.pacePerHour - 10 / 12) < 0.01, String(noon.pacePerHour));
const zero = budgetProjection({ used: 0, now: dayStart + 6 * 3600 * 1000, dayStart });
check('没用钱时预计是 0', zero.projected === 0 && zero.pacePerHour === 0, JSON.stringify(zero));

// ── ③ 判定 ─────────────────────────────────────────────────────────────
console.log('## 判定');
const on = budgetAlertSettingsOf({ enabled: true, metric: 'cost', limitCost: 20, projected: true });
const exceed = evaluateBudgetAlert({ settings: on, used: 25, projected: 40, extrapolated: true });
check('超过限额 = exceed', exceed.level === 'exceed' && exceed.ratio === 1.25, JSON.stringify(exceed));
const predict = evaluateBudgetAlert({ settings: on, used: 12, projected: 30, extrapolated: true });
check('按节奏会超 = predict', predict.level === 'predict', JSON.stringify(predict));
const safe = evaluateBudgetAlert({ settings: on, used: 5, projected: 8, extrapolated: true });
check('都在线下 = null', safe.level === null, JSON.stringify(safe));
const off = evaluateBudgetAlert({ settings: { ...on, enabled: false }, used: 99, projected: 99, extrapolated: true });
check('开关关着不报警', off.level === null, JSON.stringify(off));
const noExtrap = evaluateBudgetAlert({ settings: on, used: 12, projected: 30, extrapolated: false });
check('没外推就不报 predict', noExtrap.level === null, JSON.stringify(noExtrap));
const noProj = evaluateBudgetAlert({ settings: { ...on, projected: false }, used: 12, projected: 30, extrapolated: true });
check('关掉「预计也提醒」只报 exceed', noProj.level === null, JSON.stringify(noProj));

// ── ④ 冷却 ─────────────────────────────────────────────────────────────
console.log('## 冷却');
const nowMs = 1000 * 60 * 60 * 24;
check('从没发过 = 该发', shouldNotifyBudget({ level: 'exceed', now: nowMs, lastFiredAt: 0, lastFiredLevel: '', cooldownMinutes: 60 }) === true);
check('冷却内不重复发', shouldNotifyBudget({ level: 'predict', now: nowMs, lastFiredAt: nowMs - 10 * 60 * 1000, lastFiredLevel: 'predict', cooldownMinutes: 60 }) === false);
check('冷却过了再发', shouldNotifyBudget({ level: 'predict', now: nowMs, lastFiredAt: nowMs - 61 * 60 * 1000, lastFiredLevel: 'predict', cooldownMinutes: 60 }) === true);
check('预测升级成超限立刻发', shouldNotifyBudget({ level: 'exceed', now: nowMs, lastFiredAt: nowMs - 1000, lastFiredLevel: 'predict', cooldownMinutes: 600 }) === true);
check('没命中就不发', shouldNotifyBudget({ level: null, now: nowMs, lastFiredAt: 0, lastFiredLevel: '', cooldownMinutes: 60 }) === false);

// ── ⑤ 文案 ─────────────────────────────────────────────────────────────
console.log('## 文案');
check('金额格式化', formatBudgetNumber('cost', 12.345) === '¥12.35', formatBudgetNumber('cost', 12.345));
check('token 万单位', formatBudgetNumber('tokens', 45678).includes('万'), formatBudgetNumber('tokens', 45678));
check('token 亿单位', formatBudgetNumber('tokens', 2.5e8).includes('亿'), formatBudgetNumber('tokens', 2.5e8));
const textExceed = formatBudgetAlert({ level: 'exceed', settings: on, used: 25.4, projected: 40, topKey: 'group:100000001', generatedAt: dayStart + 20 * 3600 * 1000 });
check('超限文案说清了「超了」和两个数字', /超了/.test(textExceed) && textExceed.includes('25.40') && textExceed.includes('20.00'), textExceed);
check('超限文案点名最烧的会话', textExceed.includes('100000001'), textExceed);
check('超限文案带「晚上」时段词', textExceed.includes('晚上'), textExceed);
const textPredict = formatBudgetAlert({ level: 'predict', settings: on, used: 12, projected: 30, generatedAt: dayStart + 9 * 3600 * 1000 });
check('预测文案说的是「可能要超」+ 预计值', /可能要超/.test(textPredict) && textPredict.includes('30.00'), textPredict);
check('预测文案带「早上」时段词', textPredict.includes('早上'), textPredict);
const textToken = formatBudgetAlert({ level: 'exceed', settings: switched, used: 9e6, projected: 9e6 });
check('token 指标文案用 token 口径', /token/.test(textToken) && !textToken.includes('¥'), textToken);

// ── ⑥ 路由 ─────────────────────────────────────────────────────────────
console.log('## 路由');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-budget-'));
const STATE_DIR = path.join(ROOT, 'state');
fs.mkdirSync(STATE_DIR, { recursive: true });
const CONFIG = path.join(ROOT, 'config.json');
const writeConfig = (data) => fs.writeFileSync(CONFIG, JSON.stringify(data, null, 2));
writeConfig({ ownerQQ: '100000007', socialV2: { budgetAlert: { enabled: false } } });
const sent = [];
const cfg = { ownerQQ: '100000007', socialV2: { budgetAlert: { enabled: false } } };
let todayRows = [{ key: 'group:100000001', cost: 5, tokens: 1000 }];
const budget = createBudgetAlert({
  fs, path, ROOT, STATE_DIR, cfg, budgetAlertPure: budgetPure,
  atomicWriteJson: (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); },
  log: () => {},
  priceTable: { symbol: '¥' },
  readConfigObject: (file) => JSON.parse(fs.readFileSync(file, 'utf8')),
  updateConfigFile,
  sendToQQ: async (key, text) => { sent.push({ key, text }); },
  tokenLedger: { todayByKey: () => ({ keys: todayRows, from: new Date().setHours(0, 0, 0, 0) }) }
});

function fakeRequest(method, pathname, { headers = {}, body = null } = {}) {
  const out = { status: 0, payload: null };
  return {
    url: { pathname },
    req: { method, headers },
    readBody: async () => body,
    sendJson: (payload, status = 200) => { out.status = status; out.payload = payload; },
    out
  };
}

const getReq = fakeRequest('GET', '/api/budget/alert');
const handledGet = await budget.handleBudgetAlert(getReq);
check('GET 被这个模块接住', handledGet === true);
check('GET 回设置与今日用量', getReq.out.status === 200 && getReq.out.payload.ok === true
  && getReq.out.payload.settings.metric === 'cost' && getReq.out.payload.today.usedCost === 5, JSON.stringify(getReq.out.payload && getReq.out.payload.today));
check('GET 快照说清能不能发（有 ownerQQ）', getReq.out.payload.canNotify === true && getReq.out.payload.ownerQQ === '100000007');

const agentGet = fakeRequest('GET', '/api/budget/alert', { headers: { 'x-agent-call': '1' } });
await budget.handleBudgetAlert(agentGet);
check('智能体带 x-agent-call → 403', agentGet.out.status === 403, String(agentGet.out.status));
const agentPost = fakeRequest('POST', '/api/budget/alert', { headers: { 'x-agent-token': 'abc' }, body: { enabled: true } });
await budget.handleBudgetAlert(agentPost);
check('智能体带 x-agent-token → 403', agentPost.out.status === 403, String(agentPost.out.status));

const postReq = fakeRequest('POST', '/api/budget/alert', { body: { enabled: true, metric: 'tokens', limitTokens: 8000000, cooldownMinutes: 45 } });
await budget.handleBudgetAlert(postReq);
const disk1 = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
check('POST 写回 config.json', disk1.socialV2.budgetAlert.enabled === true
  && disk1.socialV2.budgetAlert.metric === 'tokens' && disk1.socialV2.budgetAlert.limitTokens === 8000000,
  JSON.stringify(disk1.socialV2.budgetAlert));
check('POST 只改给到的字段（别的保留默认）', disk1.socialV2.budgetAlert.projected === true && disk1.socialV2.budgetAlert.cooldownMinutes === 45,
  JSON.stringify(disk1.socialV2.budgetAlert));
check('POST 回的就是新快照', postReq.out.payload.settings.metric === 'tokens' && postReq.out.payload.limit === 8000000,
  String(postReq.out.payload.limit));
check('POST 同步到内存 cfg', cfg.socialV2.budgetAlert.metric === 'tokens');

const delReq = fakeRequest('DELETE', '/api/budget/alert');
await budget.handleBudgetAlert(delReq);
check('DELETE → 405', delReq.out.status === 405, String(delReq.out.status));

const testReq = fakeRequest('POST', '/api/budget/alert/test', { body: {} });
await budget.handleBudgetAlert(testReq);
check('POST /test 真的发了一条', sent.length === 1 && sent[0].key === 'private:100000007', JSON.stringify(sent));
check('/test 回的文案与返回值', testReq.out.payload.ok === true && /花费预警/.test(testReq.out.payload.text || ''), String(testReq.out.payload.text));
check('没命中档位时试发文案不谎称「超了」', /^【花费预警】测试/.test(testReq.out.payload.text || '') && !/超过你设的/.test(testReq.out.payload.text || ''), String(testReq.out.payload.text));
const otherPath = fakeRequest('GET', '/api/budget/other');
check('别的路径不归它管（返回 false，交给下游）', (await budget.handleBudgetAlert(otherPath)) === false);

// 没有 ownerQQ 时发不出去，要给出原因而不是静默
const noOwner = createBudgetAlert({
  fs, path, ROOT, STATE_DIR, budgetAlertPure: budgetPure, cfg: { socialV2: { budgetAlert: { enabled: true } } },
  atomicWriteJson: (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2)),
  log: () => {}, priceTable: { symbol: '¥' },
  readConfigObject: (file) => JSON.parse(fs.readFileSync(file, 'utf8')),
  updateConfigFile, sendToQQ: async () => { throw new Error('不该走到这里'); },
  tokenLedger: { todayByKey: () => ({ keys: todayRows, from: new Date().setHours(0, 0, 0, 0) }) }
});
const noOwnerReq = fakeRequest('POST', '/api/budget/alert/test', { body: {} });
await noOwner.handleBudgetAlert(noOwnerReq);
check('没设 ownerQQ 时如实说发不出去', noOwnerReq.out.payload.sent === false && /ownerQQ/.test(noOwnerReq.out.payload.error || ''),
  String(noOwnerReq.out.payload.error));

// ── ⑦ 巡检 ─────────────────────────────────────────────────────────────
console.log('## 巡检');
const sentTick = [];
const todayForTick = () => ({ keys: [{ key: 'group:100000001', cost: 40, tokens: 900000 }], from: new Date().setHours(0, 0, 0, 0) });
writeConfig({ ownerQQ: '100000007', socialV2: { budgetAlert: { enabled: true, metric: 'cost', limitCost: 20, cooldownMinutes: 360 } } });
const tickBudget = createBudgetAlert({
  fs, path, ROOT, STATE_DIR: path.join(ROOT, 'state2'), budgetAlertPure: budgetPure,
  cfg: { ownerQQ: '100000007', socialV2: { budgetAlert: { enabled: true, metric: 'cost', limitCost: 20, cooldownMinutes: 360 } } },
  atomicWriteJson: (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); },
  log: () => {}, priceTable: { symbol: '¥' },
  readConfigObject: (file) => JSON.parse(fs.readFileSync(file, 'utf8')),
  updateConfigFile, sendToQQ: async (key, text) => { sentTick.push({ key, text }); },
  tokenLedger: { todayByKey: todayForTick }
});
const tick1 = await tickBudget.tick();
check('超限巡检发一条', tick1.sent === true && sentTick.length === 1, JSON.stringify(tick1));
const tick2 = await tickBudget.tick();
check('冷却内第二次巡检不再发', tick2.sent === false && sentTick.length === 1, JSON.stringify(tick2));
const testTick = fakeRequest('POST', '/api/budget/alert/test', { body: {} });
await tickBudget.handleBudgetAlert(testTick);
check('手动试发不受冷却限制', sentTick.length === 2, String(sentTick.length));
const afterManual = JSON.parse(fs.readFileSync(path.join(ROOT, 'state2', 'budget-alert.json'), 'utf8'));
check('手动试发不占冷却（lastFiredLevel 仍是真实档位）', afterManual.lastFiredLevel === 'exceed' && afterManual.lastManualAt > 0,
  JSON.stringify(afterManual));
const offSettings = tickBudget;
fs.writeFileSync(CONFIG, JSON.stringify({ ownerQQ: '100000007', socialV2: { budgetAlert: { enabled: false, metric: 'cost', limitCost: 20 } } }, null, 2));
tickBudget.settingsNow();
const tick3 = await (async () => {
  const b2 = createBudgetAlert({
    fs, path, ROOT, STATE_DIR: path.join(ROOT, 'state3'), budgetAlertPure: budgetPure,
    cfg: { ownerQQ: '100000007', socialV2: { budgetAlert: { enabled: false } } },
    atomicWriteJson: (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2)),
    log: () => {}, priceTable: { symbol: '¥' },
    readConfigObject: (file) => JSON.parse(fs.readFileSync(file, 'utf8')),
    updateConfigFile, sendToQQ: async () => {},
    tokenLedger: { todayByKey: todayForTick }
  });
  return b2.tick();
})();
check('开关关着巡检什么都不做', tick3.sent === undefined && tick3.level === null, JSON.stringify(tick3));
check('start/stop 幂等', tickBudget.start({ intervalMs: 30 * 1000 }) === true && tickBudget.start({ intervalMs: 30000 }) === false && tickBudget.stop() === true);
void offSettings;

// ── ⑧ 前端接线 ─────────────────────────────────────────────────────────
console.log('## 前端接线');
const usageJs = fs.readFileSync(path.join(process.cwd(), 'client', '04-usage.js'), 'utf8');
const shellJs = fs.readFileSync(path.join(process.cwd(), 'client', '01-shell.js'), 'utf8');
const css = fs.readFileSync(path.join(process.cwd(), 'public', 'client.css'), 'utf8');
check('用量页有花费预警卡', usageJs.includes('usageBudgetHtml') && usageJs.includes("panelBox('花费预警'"), '缺卡片渲染');
check('页面拉 /api/budget/alert', usageJs.includes("api('/api/budget/alert')"), '没拉设置');
check('指标用开关切 cost / tokens', usageJs.includes('id="budgetMetricSwitch"') && /metric === 'tokens' \? st\.limitTokens/.test(usageJs), '缺指标切换');
check('三个写操作登记在 WRITE_ACTIONS', /'budget-save': function/.test(shellJs) && /'budget-test': function/.test(shellJs) && /'budget-refresh': function/.test(shellJs), '写操作没登记');
check('CSS 有进度条与表单类', ['.qdb-budget-bar', '.qdb-budget-fill', '.qdb-budget-proj', '.qdb-budget-status[data-tone="danger"]', '.qdb-budget-form', '.qdb-budget-chips']
  .every((sel) => css.includes(sel)), '样式缺类');

console.log('');
console.log(`花费预警：通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  console.error('失败项：');
  for (const name of failures) console.error('  - ' + name);
  process.exitCode = 1;
}
