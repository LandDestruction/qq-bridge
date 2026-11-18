// D73：AI 黑名单的 QQ 私聊管理命令（owner 私聊 /aiban）。
//
// 覆盖：
//   ① 解析：斜杠/中文别名/大小写/多余空格/帮助/非法输入；
//   ② 执行（注入假 admin）：add/del/list/on/off/mode 全部命中且写盘只调一次；
//   ③ 非 owner 零副作用（命令识别与执行分离，wiring 层另有静态断言）；
//   ④ 非法 QQ / 缺参 / 未知子命令被拒且不写盘；回执 ≤200 字；
//   ⑤ D70 的 admin 新增 mode()：真写盘只改 mode、别的键与名单不动；
//   ⑥ 接线静态断言：命令块在额度闸之前、命中即 return（不进 DSH 回合）；
//      ai-command.js 自身不含 deliverPrompt/scheduleWake/fetch 之类会开回合的调用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AI_CMD_HELP_LINES,
  AI_CMD_REPLY_MAX,
  isAiBlacklistCommand,
  parseAiBlacklistCommand,
  runAiBlacklistCommand
} from '../src/ai-command.js';
import { createAiBlacklistAdmin, normalizeAiBlacklist } from '../src/ai-blacklist.js';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');

/** 假 admin：记录每次写调用，状态是 normalize 后的配置对象。 */
function fakeAdmin(initial = {}) {
  const state = normalizeAiBlacklist(initial);
  const calls = { add: [], remove: [], toggle: [], mode: [] };
  return {
    state,
    calls,
    get: () => state,
    add(qq, note) {
      if (!/^\d{5,13}$/.test(String(qq))) throw new Error('QQ 号必须是 5~13 位数字');
      calls.add.push([String(qq), String(note ?? '')]);
      if (!state.qq.some((entry) => entry.id === String(qq))) {
        state.qq.push({ id: String(qq), note: String(note ?? ''), addedAt: 1793090000000 });
      }
      return state;
    },
    remove(qq) {
      calls.remove.push(String(qq));
      state.qq = state.qq.filter((entry) => entry.id !== String(qq));
      return state;
    },
    toggle(on) { calls.toggle.push(on === true); state.enabled = on === true; return state; },
    mode(m) { calls.mode.push(String(m)); state.mode = String(m); return state; }
  };
}

const run = (text, admin, extra = {}) => runAiBlacklistCommand({ text, admin, log: () => {}, ...extra });

console.log('## 1. 解析：斜杠命令 + 空格容错');
{
  check('裸数字 = add', parseAiBlacklistCommand('/aiban 123456789').op === 'add');
  check('add + 备注', (() => { const c = parseAiBlacklistCommand('/aiban add 123456789 某GPT'); return c.op === 'add' && c.qq === '123456789' && c.note === '某GPT'; })());
  check('del', parseAiBlacklistCommand('/aiban del 123456789').op === 'del');
  check('list', parseAiBlacklistCommand('/aiban list').op === 'list');
  check('on / off', parseAiBlacklistCommand('/aiban on').op === 'on' && parseAiBlacklistCommand('/aiban off').op === 'off');
  check('mode reduce|silent', parseAiBlacklistCommand('/aiban mode reduce').mode === 'reduce' && parseAiBlacklistCommand('/aiban mode silent').mode === 'silent');
  check('空 = 帮助', parseAiBlacklistCommand('/aiban').op === 'help');
  check('大小写不敏感 + 多余空格', (() => { const c = parseAiBlacklistCommand('  /AIBAN   ADD   123456789   别家机器人 '); return c.op === 'add' && c.qq === '123456789' && c.note === '别家机器人'; })());
  check('非命令返回 null（不抢正常聊天）', parseAiBlacklistCommand('/reset') === null && parseAiBlacklistCommand('你好') === null);
  check('isAiBlacklistCommand 只认本功能', isAiBlacklistCommand('/aiban list') && !isAiBlacklistCommand('/status') && !isAiBlacklistCommand('黑名单是什么'));
  check('中文别名识别', isAiBlacklistCommand('加AI黑名单 123456789') && isAiBlacklistCommand('黑名单列表') && isAiBlacklistCommand('黑名单关'));
}

console.log('## 2. 中文别名');
{
  const a1 = parseAiBlacklistCommand('加AI黑名单 123456789 某GPT');
  check('加AI黑名单 = add（带备注）', a1.op === 'add' && a1.qq === '123456789' && a1.note === '某GPT');
  check('删AI黑名单 = del', parseAiBlacklistCommand('删AI黑名单 123456789').op === 'del');
  check('黑名单列表 = list', parseAiBlacklistCommand('黑名单列表').op === 'list');
  check('黑名单开/关 = on/off', parseAiBlacklistCommand('黑名单开').op === 'on' && parseAiBlacklistCommand('黑名单关').op === 'off');
  check('带空格写法也认（加 AI 黑名单）', parseAiBlacklistCommand('加 AI 黑名单 123456789').op === 'add');
}

console.log('## 3. 执行：每种命令只写一次盘、回执带数字');
{
  const admin = fakeAdmin({ enabled: true, qq: [{ id: '223456789', note: '别家机器人' }] });
  const out = run('/aiban add 123456789 某GPT', admin);
  check('add 命中且只写一次', out.handled && admin.calls.add.length === 1 && admin.calls.add[0][0] === '123456789');
  check('add 回执含数量与模式', out.reply.startsWith('已加入：123456789（共 2 个）') && out.reply.includes('模式 reduce'), out.reply);
  check('add 回执含冷却与小时上限', out.reply.includes('10 分钟冷却') && out.reply.includes('每小时最多 3 次'));

  const del = run('/aiban del 123456789', admin);
  check('del 命中且只写一次', del.handled && admin.calls.remove.length === 1 && admin.calls.remove[0] === '123456789');
  check('del 回执写剩余数量', del.reply === '已移除：123456789（还剩 1 个）', del.reply);

  const missing = run('/aiban del 999999999', admin);
  check('删不存在的号：回执说明没动名单', missing.reply.includes('名单里没有 999999999') && admin.state.qq.length === 1, missing.reply);

  const list = run('/aiban list', admin);
  check('list 回执含 id 与备注', list.reply.includes('223456789') && list.reply.includes('备注「别家机器人」'), list.reply);

  const on = run('/aiban on', admin);
  check('on 只 toggle(true) 一次', on.handled && admin.calls.toggle.length === 1 && admin.calls.toggle[0] === true);
  const off = run('/aiban off', admin);
  check('off 只 toggle(false) 一次', admin.calls.toggle.length === 2 && admin.calls.toggle[1] === false && admin.state.enabled === false);

  const mode = run('/aiban mode silent', admin);
  check('mode 只调 mode(silent) 一次', mode.handled && admin.calls.mode.length === 1 && admin.calls.mode[0] === 'silent');
  check('mode 回执说明含义', mode.reply.includes('连 @ 都不回'), mode.reply);

  check('所有回执 ≤200 字', [out, del, list, on, off, mode].every((r) => r.reply.length <= AI_CMD_REPLY_MAX));
  check('写盘总次数 = 每次命令 1 次', admin.calls.add.length + admin.calls.remove.length + admin.calls.toggle.length + admin.calls.mode.length === 6);
}

console.log('## 4. 帮助 / 非法输入：不写盘、回一行提示');
{
  const admin = fakeAdmin();
  const help = run('/aiban', admin);
  check('帮助命中且 ≤6 行', help.handled && help.reply.split('\n').length <= 6, String(help.reply.split('\n').length));
  check('帮助含三种核心命令', AI_CMD_HELP_LINES.join(' ').includes('/aiban list') && help.reply.includes('mode'));

  for (const bad of ['/aiban add abc123', '/aiban add 123', '/aiban del 1234', '加AI黑名单 不是号码']) {
    const r = run(bad, admin);
    check(`非法 QQ 被拒：${bad}`, r.handled && r.reply.includes('5~13 位数字') && admin.calls.add.length === 0 && admin.calls.remove.length === 0, r.reply);
  }
  const noArg = run('/aiban add', admin);
  check('缺参数被拒且给用法', noArg.reply.includes('用法') && admin.calls.add.length === 0);
  const badMode = run('/aiban mode turbo', admin);
  check('非法 mode 被拒', badMode.reply.includes('reduce') && admin.calls.mode.length === 0);
  const unknown = run('/aiban 乱写的子命令', admin);
  check('未知子命令回提示、不写盘', unknown.handled && admin.calls.add.length + admin.calls.remove.length + admin.calls.toggle.length + admin.calls.mode.length === 0);
  const notCommand = run('今天群里好安静', admin);
  check('普通文本 handled=false（继续走聊天）', notCommand.handled === false && notCommand.reply === '');
}

console.log('## 5. 非 owner 零副作用（识别与执行分离 + 源码静态断言）');
{
  // 执行器本身没有「发消息/开回合」的能力：它只碰注入的 admin 和 log。
  const admin = fakeAdmin();
  const out = run('/aiban list', admin);
  check('执行器只读 admin.get、不写', out.handled && admin.calls.add.length + admin.calls.remove.length + admin.calls.toggle.length + admin.calls.mode.length === 0);

  const src = fs.readFileSync(path.join(ROOT, 'src/bridge/incoming-runtime.js'), 'utf8');
  const cmdAt = src.indexOf('isAiBlacklistCommand');
  // 真正要证的是「调用点」在额度闸之前；函数定义在最前面，所以用 lastIndexOf 取调用行。
  const callAt = src.lastIndexOf('tryHandleAiBlacklistCommand(deps, cfg, kind, id, event)');
  // 注意：文件头部的「Live dependencies」注释也列了 consumePrivateQuota，
  // 必须从命令块之后开始找，才是真正的额度闸。
  const quotaAt = src.indexOf('consumePrivateQuota', callAt);
  check('命令块在额度闸之前', cmdAt > -1 && callAt > -1 && quotaAt > -1 && callAt < quotaAt, `call@${callAt} quota@${quotaAt}`);
  check('调用点前于白名单闸（同样在这些闸之前）', callAt < src.indexOf('whitelistedOnly)(kind, id, cfg)', callAt));
  const block = src.slice(cmdAt, quotaAt);
  check('非 owner 分支直接 return（不回执）', /sender !== String\(cfg\.ownerQQ/.test(block) && /return true;/.test(block));
  check('命中后 sendToQQ（私聊回执）在 return 之前', block.includes('sendToQQ') && block.includes('return;'));

  const mod = fs.readFileSync(path.join(ROOT, 'src/ai-command.js'), 'utf8');
  check('命令模块不碰 DSH/网络（不开回合）', !/deliverPrompt|deliverPromptNow|scheduleWake|scheduleSocialReply|fetch\(|api\./.test(mod));

  const bridge = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
  check('bridge 注入 isAiBlacklistCommand / runAiBlacklistCommand', bridge.includes('get isAiBlacklistCommand()') && bridge.includes('get runAiBlacklistCommand()'));
  check('bridge 传的是 aiBlacklistAdmin（复用 D70 写盘）', /runAiBlacklistCommand\)\s*\(\{[\s\S]{0,200}admin: deps\.aiBlacklistAdmin/.test(src));
}

console.log('## 6. D70 admin 新增 mode()：真写盘只改 mode');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cmd-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    allow: { groups: ['456'] },
    socialV2: { aiBlacklist: { enabled: true, mode: 'reduce', qq: [{ id: '123456789', note: 'x', addedAt: 1 }] } }
  }, null, 2));
  let writes = 0;
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  const admin = createAiBlacklistAdmin({
    configFile: file,
    getConfig: () => disk.socialV2.aiBlacklist,
    writeConfig: (mutate) => { writes += 1; mutate(disk); },
    fs, path,
    now: () => 1793090000000,
    log: () => {}
  });
  admin.mode('silent');
  check('mode(silent) 写盘一次', writes === 1);
  check('mode 生效且名字/开关不动', disk.socialV2.aiBlacklist.mode === 'silent' && disk.socialV2.aiBlacklist.enabled === true && disk.socialV2.aiBlacklist.qq.length === 1);
  check('其他键没被抹（allow.groups 还在）', JSON.stringify(disk.allow.groups) === '["456"]');
  let threw = false;
  try { admin.mode('turbo'); } catch { threw = true; }
  check('非法 mode 抛错且不写盘', threw && writes === 1);
  check('备份文件已生成', fs.readdirSync(dir).some((name) => name.startsWith('config.json.bak-')));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('## 7. 备注长度与列表上限');
{
  const admin = fakeAdmin({ enabled: true });
  const longNote = '这是一个特别特别长的备注超过二十个字应该被截断';
  const out = run(`/aiban add 123456789 ${longNote}`, admin);
  check('备注截到 20 字', admin.state.qq[0].note.length <= 20, String(admin.state.qq[0].note.length));

  const many = fakeAdmin({ enabled: true, qq: ['100001', '100002', '100003', '100004', '100005', '100006'] });
  const list = run('/aiban list', many);
  check('长名单只列前 4 条并写总数', list.reply.includes('共 6 个') && list.reply.split('；').length <= 5, list.reply);
  check('长名单回执仍 ≤200 字', list.reply.length <= AI_CMD_REPLY_MAX, String(list.reply.length));
}

console.log('');
if (failures.length) {
  console.error(`❌ test-ai-command：${failures.length} 项失败`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`✅ test-ai-command：${pass} 项全过`);
