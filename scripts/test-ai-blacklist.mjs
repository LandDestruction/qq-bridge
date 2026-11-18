// D70：AI 黑名单（控制台登记要限制的 AI QQ，命中后降频/静默，治 AI 互相接话的永动机）。
//
// 覆盖：
//   ① 配置规范化（字符串/对象混写、坏号丢弃、去重、默认值）；
//   ② 触发源分类（@ 类 / 关键词 / 概率类 / 主动检查）；
//   ③ 判定：未命中放行、reduce 拦非 @、atMeReply=false 连 @ 也拦、silent 全拦、
//      冷却窗口、每小时上限、今日跳过计数；
//   ④ 控制台写盘：读盘再合并、备份、add/remove/toggle、坏号报错；
//   ⑤ 真跑控制台端点：GET 结构、智能体 403、POST 生效、坏 action 400；
//   ⑥ 三处接线 + prompt 注入 + ops.html 静态断言（readBridgeSource）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  normalizeAiBlacklist,
  aiTriggerClass,
  createAiBlacklistRuntime,
  createAiBlacklistAdmin,
  AI_BLACKLIST_DEFAULTS
} from '../src/ai-blacklist.js';
import { updateConfigFile } from '../src/config-write.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { readBridgeSource } from './bridge-source.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('## 1. 配置规范化：坏值不炸、兼容字符串/对象、去重、默认值');
{
  const d = normalizeAiBlacklist(undefined);
  check('空配置 → 默认关闭、reduce、10 分钟、每小时 3 次、@ 回', d.enabled === false && d.mode === 'reduce' && d.minIntervalMs === 600000 && d.perHourMax === 3 && d.atMeReply === true && d.qq.length === 0);
  const mixed = normalizeAiBlacklist({ enabled: true, qq: ['123456', { id: '223456', note: '别家机器人', addedAt: 123 }, 223456, 'bad', '', '1234567x', { qq: '323456' }] });
  check('字符串/对象/重复 id 都能收，坏号丢掉', mixed.qq.map((e) => e.id).join(',') === '123456,223456,323456', mixed.qq.map((e) => e.id).join(','));
  check('note/addedAt 保留', mixed.qq[1].note === '别家机器人' && mixed.qq[1].addedAt === 123);
  const s = normalizeAiBlacklist({ mode: 'silent', atMeReply: false, minIntervalMs: -5, perHourMax: 'x' });
  check('mode=silent 生效', s.mode === 'silent');
  check('atMeReply=false 保留', s.atMeReply === false);
  check('负数/非法数值回落默认', s.minIntervalMs === AI_BLACKLIST_DEFAULTS.minIntervalMs && s.perHourMax === AI_BLACKLIST_DEFAULTS.perHourMax);
  check('qq 非数组 → 空名单', normalizeAiBlacklist({ qq: 'nope' }).qq.length === 0);
}

console.log('## 2. 触发源分类：@ 类 / 关键词 / 概率类 / 主动检查 / 不归它管');
{
  check('atMention/nameMention/question/speaker/private → at',
    ['atMention', 'nameMention', 'question', 'speaker:小明', 'private'].every((t) => aiTriggerClass(t) === 'at'));
  check('keyword:xx → keyword', aiTriggerClass('keyword:你好') === 'keyword');
  check('probability/anyMessage/poke → probability', ['probability', 'anyMessage', 'poke'].every((t) => aiTriggerClass(t) === 'probability'));
  check('proactiveCheck → proactive', aiTriggerClass('proactiveCheck') === 'proactive');
  // 回归：replyCheck 以前被当成「不归黑名单管」，导致机器人回完话回看时又顺着 AI 的话接下去。
  // 现在按非点名打扰源处理（proactive 同类），黑名单才真正挡得住「自己排的队」。
  check('replyCheck → proactive（回看唤醒也要过黑名单）', aiTriggerClass('replyCheck') === 'proactive');
  check('bootstrap/timeout/debug → null（不归黑名单管）',
    ['bootstrap', 'timeout', 'debug', '', null].every((t) => aiTriggerClass(t) === null));
}

console.log('## 3. 判定：未命中放行、reduce 拦非 @、atMeReply/silent、冷却、小时上限');
{
  let clock = 1_793_090_000_000;
  let conf = { enabled: true, qq: ['11111'], mode: 'reduce', minIntervalMs: 600000, perHourMax: 3, atMeReply: true };
  const rt = createAiBlacklistRuntime({ getConfig: () => conf, now: () => clock });
  check('名单外的人一律放行', rt.verdict('group:1', '22222', 'atMention').skip === false);
  check('关闭时名单内也放行', (() => { conf = { ...conf, enabled: false }; const r = rt.verdict('group:1', '11111', 'atMention').skip === false; conf = { ...conf, enabled: true }; return r; })());
  check('reduce：关键词不唤醒（why=keyword）', rt.verdict('group:1', '11111', 'keyword:hi').why === 'keyword');
  check('reduce：概率/拍一拍不唤醒（why=probability）', rt.verdict('group:1', '11111', 'probability').why === 'probability' && rt.verdict('group:1', '11111', 'poke').why === 'probability');
  check('reduce：主动检查不唤醒（why=proactive）', rt.verdict('group:1', '11111', 'proactiveCheck').why === 'proactive');
  check('reduce：回看唤醒（replyCheck）也不唤醒（why=proactive）', rt.verdict('group:1', '11111', 'replyCheck').why === 'proactive');
  const at1 = rt.verdict('group:1', '11111', 'atMention');
  check('reduce + atMeReply=true：@ 放行（首次）', at1.skip === false && at1.why === null);
  const at2 = rt.verdict('group:1', '11111', 'atMention');
  check('同一 QQ 冷却窗口内再 @ → 跳过（why=cooldown）', at2.skip === true && at2.why === 'cooldown');
  clock += 600000 + 1;
  check('冷却到期后再 @ 放行', rt.verdict('group:1', '11111', 'atMention').skip === false);

  conf = { enabled: true, qq: ['11111'], mode: 'reduce', minIntervalMs: 0, perHourMax: 2, atMeReply: true };
  const rt2 = createAiBlacklistRuntime({ getConfig: () => conf, now: () => clock });
  const a = rt2.verdict('group:1', '11111', 'atMention');
  const b = rt2.verdict('group:1', '11111', 'atMention');
  const c = rt2.verdict('group:1', '11111', 'atMention');
  check('perHourMax=2：前两次放行、第三次 why=hourly-cap', a.skip === false && b.skip === false && c.skip === true && c.why === 'hourly-cap');

  conf = { enabled: true, qq: ['11111'], mode: 'reduce', minIntervalMs: 0, perHourMax: 3, atMeReply: false };
  const noAt = createAiBlacklistRuntime({ getConfig: () => conf, now: () => clock }).verdict('group:1', '11111', 'atMention');
  check('atMeReply=false：即使 @ 也拦（why=at，优先级高于 reduce）', noAt.skip === true && noAt.why === 'at');

  conf = { enabled: true, qq: ['11111'], mode: 'silent', minIntervalMs: 0, perHourMax: 3, atMeReply: true };
  const silentAt = createAiBlacklistRuntime({ getConfig: () => conf, now: () => clock }).verdict('group:1', '11111', 'atMention');
  check('silent：连 @ 都不回（why=at）', silentAt.skip === true && silentAt.why === 'at');

  conf = { enabled: true, qq: ['11111'], mode: 'silent', minIntervalMs: 0, perHourMax: 3, atMeReply: true };
  const rt3 = createAiBlacklistRuntime({ getConfig: () => conf, now: () => clock });
  check('isAiBlacklisted 只判名单（enabled+命中）', rt3.isAiBlacklisted('group:1', '11111') === true && rt3.isAiBlacklisted('group:1', '22222') === false);
  const before = rt3.stats().skippedToday;
  rt3.noteSkip(); rt3.noteSkip();
  check('noteSkip 计入 skippedToday', rt3.stats().skippedToday === before + 2);
  const sameDay = rt3.stats().day;
  clock += 24 * 60 * 60 * 1000;
  check('跨天自动归零（day 跟着变）', rt3.stats().skippedToday === 0 && rt3.stats().day !== sameDay);
}

console.log('## 4. 控制台写盘：读盘再合并、备份、add/remove/toggle');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd70-admin-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ allow: { groups: ['456'] }, socialV2: { tools: { sendGroup: false } } }, null, 2));
  const admin = createAiBlacklistAdmin({
    configFile: file,
    getConfig: () => JSON.parse(fs.readFileSync(file, 'utf8')).socialV2?.aiBlacklist,
    writeConfig: (mutate) => updateConfigFile(file, mutate, { atomicWrite: (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n') }),
    fs, path, log: () => {}
  });
  const afterAdd = admin.add('123456789', '别家机器人');
  check('add：名单出现且带 note/addedAt', afterAdd.qq.length === 1 && afterAdd.qq[0].id === '123456789' && afterAdd.qq[0].note === '别家机器人' && afterAdd.qq[0].addedAt > 0);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('写盘后别的键没被抹（allow.groups / socialV2.tools 都在）', JSON.stringify(disk.allow.groups) === '["456"]' && disk.socialV2.tools.sendGroup === false);
  check('有配置备份 config.json.bak-*', fs.readdirSync(dir).some((n) => n.startsWith('config.json.bak-')));
  check('重复 add 不重复登记', admin.add('123456789').qq.length === 1);
  check('坏号 add 抛错且不写盘', (() => { try { admin.add('abc'); return false; } catch { return true; } })());
  const afterToggle = admin.toggle(true);
  check('toggle：enabled=true 落盘', afterToggle.enabled === true && JSON.parse(fs.readFileSync(file, 'utf8')).socialV2.aiBlacklist.enabled === true);
  const afterRemove = admin.remove('123456789');
  check('remove：名单清空', afterRemove.qq.length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('## 5. 控制台端点（真跑 bridge HTTP handler）');
{
  const KEY = 'group:456';
  const CONSOLE_TOKEN = 'fixture-console-token';
  const h = await bridgeHarness({
    config: {
      socialV2: { aiBlacklist: { enabled: true, qq: [{ id: '11111', addedAt: 1, note: '别家机器人' }], mode: 'reduce', minIntervalMs: 600000, perHourMax: 3, atMeReply: true } },
      dsh: { provider: 'deepseek-account', model: 'deepseek-flash' }
    }
  });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const request = (method, body, headers = {}) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/socialV2/ai-blacklist', method,
      headers: { 'x-console-token': CONSOLE_TOKEN, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, json, raw: data }); });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('超时')));
    req.end(payload);
  });
  try {
    const g = await request('GET');
    check('GET → 200 且结构完整', g.status === 200 && g.json?.ok === true && g.json?.enabled === true && Array.isArray(g.json?.qq) && g.json.qq.length === 1);
    check('GET 带 stats.skippedToday（数字）', typeof g.json?.stats?.skippedToday === 'number');
    const agentCall = await request('GET', null, { 'x-agent-call': '1', 'x-agent-token': st.agentToken });
    check('智能体（x-agent-call + token）→ 403', agentCall.status === 403 && agentCall.json?.code === 'admin_only');
    const agentToken = await request('GET', null, { 'x-agent-token': st.agentToken });
    check('只带 x-agent-token → 403', agentToken.status === 403);
    const add = await request('POST', { action: 'add', qq: '222333', note: '另一个机器人' });
    check('POST add → 200 且名单变 2', add.status === 200 && add.json?.ok === true && add.json?.qq?.length === 2);
    const g2 = await request('GET');
    check('GET 能看到新加的 QQ 与备注', g2.json?.qq?.some((e) => e.id === '222333' && e.note === '另一个机器人'));
    const bad = await request('POST', { action: 'nope' });
    check('POST 坏 action → 400', bad.status === 400 && bad.json?.code === 'bad_action');
    const rm = await request('POST', { action: 'remove', qq: '222333' });
    check('POST remove 生效', rm.status === 200 && rm.json?.qq?.length === 1);

    // prompt 注入：黑名单会话多一行；别的人不加
    h.appendSocialV2Message(KEY, '小明', '你好', '你好', false, false, 1, [], '11111', []);
    const promptBlack = h.buildWakePromptV2(KEY, 'atMention', { dryRun: true });
    check('prompt：命中黑名单的会话注入「对方是另一个 AI」一行', String(promptBlack).includes('对方是另一个 AI') && String(promptBlack).includes('别接话头'));
    h.appendSocialV2Message(KEY, '路人', '在吗', '在吗', false, false, 2, [], '99999', []);
    const promptNormal = h.buildWakePromptV2(KEY, 'atMention', { dryRun: true });
    check('prompt：最新发言不是黑名单时不注入（≤60 字、不涨预算）', !String(promptNormal).includes('对方是另一个 AI'));
  } catch (error) {
    failures.push(`端点/prompt 用例异常：${error?.stack ?? error}`);
    console.error('FAIL 端点/prompt 用例异常：', error?.stack ?? error);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

console.log('## 6. 接线静态断言：三处唤醒闸 + 日志/原因 + 控制台路由 + ops.html');
{
  const bridge = readBridgeSource();
  check('统一日志格式 [AI黑名单] 跳过 qq=<id> why=<...>', /\[AI黑名单\] 跳过 qq=\$\{who\} why=\$\{verdict\.why\}/.test(bridge));
  check('入站触发（incoming-runtime）过闸', /aiBlacklistCheck\(key, event\.user_id \?\? event\.sender\?\.user_id \?\? null, reason\)/.test(bridge));
  check('主动检查（scheduleProactiveCheckV2）过闸', bridge.includes('aiBlacklistProactiveVeto(key, st, aiBlacklistCheck)'));
  check('prompt（buildWakePromptV2）用 isAiBlacklisted', bridge.includes('aiBlacklistPromptLine(key, st, isAiBlacklisted)') && fs.readFileSync(new URL('../src/bridge/wake-prompts.js', import.meta.url), 'utf8').includes('function aiBlacklistPromptLine('));
  check('拦截原因写进 pendingWakeReasons 且标记 ai-blacklist:', /ai-blacklist:\$\{verdict\.why\}/.test(bridge));
  check('重放时不会把 ai-blacklist 记录当成积压唤醒', /\^ai-blacklist:/.test(bridge) && /跳过重放：\$\{item\.reason\}/.test(bridge));
  check('控制台路由已注册（readBridgeSource 会把 handler 内联进 startConsoleServer）', bridge.includes('/api/socialV2/ai-blacklist') && bridge.includes('AI 黑名单只允许管理端读写'));
  check('控制台 handler 有 marker（可被 readBridgeSource 展开）', fs.readFileSync(new URL('../src/bridge/console/ai-blacklist.js', import.meta.url), 'utf8').includes('@bridge-function handleConsoleAiBlacklist:start'));
  check('manifest 登记了新 console 模块', fs.readFileSync(new URL('../src/bridge/manifest.json', import.meta.url), 'utf8').includes('src/bridge/console/ai-blacklist.js'));
  check('config 默认值里有 aiBlacklist（不配也能跑）', (() => { const s = fs.readFileSync(new URL('../src/bridge/config-load.js', import.meta.url), 'utf8'); return s.includes('const DEFAULT_AI_BLACKLIST = Object.freeze({') && s.includes('aiBlacklist: DEFAULT_AI_BLACKLIST'); })());
  const ops = fs.readFileSync(new URL('../public/ops.html', import.meta.url), 'utf8');
  check('ops.html 有 AI 黑名单卡片（开关/输入/列表/今日跳过）', ops.includes('AI 黑名单') && ops.includes('aibl-enabled') && ops.includes('aibl-add') && ops.includes('aibl-list') && ops.includes('今日跳过'));
  check('ops.html 请求走同一个端点', ops.includes('/api/socialV2/ai-blacklist'));
  const doc = fs.readFileSync(new URL('../docs/ai-blacklist.md', import.meta.url), 'utf8');
  check('docs/ai-blacklist.md 写了配置与 why 取值', doc.includes('minIntervalMs') && doc.includes('hourly-cap') && doc.includes('atMeReply'));

  // 2026-10-30 事故：黑名单只拦唤醒、不拦同轮上下文里其他 AI 的消息 → 模型照常接话。
  // 现在在消息出口（social-reads）对模型面折叠，这里把「纯函数」与「只对模型面生效」都测住。
  const reads = await import('../src/bridge/console/social-reads.js');
  const msgs = [
    { userId: '100000010', sender: 'AI甲', text: '哈哈哈' },
    { userId: '100000006', sender: '真人', text: '在吗' },
    { userId: 100000010, sender: 'AI甲', text: '继续' },
    { userId: '', sender: '匿名', text: 'x' }
  ];
  const isBL = (uid) => String(uid) === '100000010';
  const filtered = reads.filterBlacklistedMessages(msgs, isBL);
  check('filterBlacklistedMessages：摘掉黑名单成员的消息并报数', filtered.hidden === 2 && filtered.kept.length === 2);
  check('filterBlacklistedMessages：保留真人/匿名消息且顺序不变', filtered.kept[0].sender === '真人' && filtered.kept[1].sender === '匿名');
  check('filterBlacklistedMessages：数字号与字符串号都认', filtered.hidden === 2);
  check('filterBlacklistedMessages：传非函数时原样返回（不炸）', reads.filterBlacklistedMessages(msgs, null).hidden === 0);
  const agent = reads.scrubMessagesForModel(msgs, isBL, true);
  const admin = reads.scrubMessagesForModel(msgs, isBL, false);
  check('scrubMessagesForModel：模型面折叠 + hiddenByBlacklist', agent.hiddenByBlacklist === 2 && agent.messages.length === 2);
  check('scrubMessagesForModel：控制台/管理员看得到全部', admin.hiddenByBlacklist === 0 && admin.messages.length === 4);
  const readsSrc = fs.readFileSync(new URL('../src/bridge/console/social-reads.js', import.meta.url), 'utf8');
  check('social-reads 的 unread 与 recent 两个出口都走折叠', (readsSrc.match(/scrubBlacklistedForModel\(deps, key, messages, request\)/g) || []).length === 3 && readsSrc.includes('hiddenByBlacklist'));
  const manifestRaw = fs.readFileSync(new URL('../src/bridge/manifest.json', import.meta.url), 'utf8');
  check('manifest 给 social-reads 注入了 isAiBlacklisted', (() => {
    const m = JSON.parse(manifestRaw);
    const mod = m.modules.find((x) => String(x.file).endsWith('console/social-reads.js'));
    return Boolean(mod && Array.isArray(mod.dependencies) && mod.dependencies.includes('isAiBlacklisted'));
  })());
}

console.log('');
const total = pass + failures.length;
if (failures.length) {
  console.log(`❌ test-ai-blacklist 失败 ${failures.length}/${total}`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log(`✅ test-ai-blacklist 全部通过（${pass}/${total}）`);
