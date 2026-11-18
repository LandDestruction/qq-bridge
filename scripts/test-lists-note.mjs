// 名单备注（名单页每条行后面那颗「＋备注 / ✎」）：后端 action:'note' + 前端单元格与写操作。
//
// 覆盖：
//   ① 后端：给已有条目写备注 → socialV2.listNotes 落盘；空串=删备注；不改条目本身；
//   ② 后端：不在名单里的号写备注 → 400；超过 40 字 → 400；坏 list → 400；
//   ③ 后端：ai-blacklist（对象数组）备注写进对象条目；remove 掉条目时备注一起没；
//   ④ 后端：智能体带 x-agent-token 一律 403（名单只允许管理端改）；
//   ⑤ 前端：备注列有 ＋备注/✎ 按钮、写操作 lists-note、常量与后端一致、CSS 有对应类。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConsoleLists } from '../src/bridge/console/lists.js';
import { updateConfigFile } from '../src/config-write.js';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-lists-note-'));
const CONFIG = path.join(ROOT, 'config.json');
const writeConfig = (data) => fs.writeFileSync(CONFIG, JSON.stringify(data, null, 2));
writeConfig({
  allow: { groups: ['100000001'], private: [] },
  deny: { groups: [], private: [] },
  observe: { groups: [], enabled: true },
  fileArchive: { groups: [], enabled: true },
  socialV2: { aiBlacklist: { enabled: false, qq: [] } }
});

const gate = createConsoleLists({
  fs, path, ROOT, cfg: {}, log: () => {},
  updateConfigFile, atomicWriteJson: (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2)),
  reloadConfigFromDisk: () => {},
  aiBlacklist: { stats: () => null },
  groupMemberCache: new Map(), groupMemberRefreshedAt: 0
});

async function call(method, body, headers = {}) {
  const sent = { data: null, status: 200 };
  await gate.handleConsoleLists({
    url: new URL('http://127.0.0.1:3100/api/lists'),
    req: { method, headers },
    sendJson: (data, status = 200) => { sent.data = data; sent.status = status; },
    readBody: async () => body
  });
  return sent;
}
const disk = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

console.log('## 1. 后端：写备注 / 改备注 / 清备注');
{
  const first = await call('POST', { list: 'allow-groups', action: 'note', id: '100000001', note: '扣1群' });
  check('给已有条目写备注回 ok', first.status === 200 && first.data.ok === true);
  check('备注落进 socialV2.listNotes.allow-groups', disk()?.socialV2?.listNotes?.['allow-groups']?.['100000001'] === '扣1群');
  check('条目本身还是纯字符串数组（没被改成对象）', Array.isArray(disk().allow.groups) && disk().allow.groups[0] === '100000001');
  check('返回值里能直接看到备注（前端不用二次 GET）',
    first.data.lists.find((l) => l.id === 'allow-groups').entries[0].note === '扣1群');

  await call('POST', { list: 'allow-groups', action: 'note', id: '100000001', note: '  改一次  ' });
  check('改备注时首尾空格被 trim', disk()?.socialV2?.listNotes?.['allow-groups']?.['100000001'] === '改一次');

  await call('POST', { list: 'allow-groups', action: 'note', id: '100000001', note: '' });
  check('空串 = 删掉这条备注', disk()?.socialV2?.listNotes?.['allow-groups'] === undefined);
  check('删备注不会把条目从名单里移掉', disk().allow.groups.length === 1);
}

console.log('## 2. 后端：坏输入都回 400，且不落盘');
{
  const missing = await call('POST', { list: 'allow-groups', action: 'note', id: '123456789', note: 'x' });
  check('不在名单里的号写备注 → 400', missing.status === 400 && /不在名单里/.test(missing.data.error), JSON.stringify(missing.data));
  const long = await call('POST', { list: 'allow-groups', action: 'note', id: '100000001', note: 'x'.repeat(41) });
  check('超过 40 字 → 400', long.status === 400 && /40/.test(long.data.error));
  const badList = await call('POST', { list: 'nope', action: 'note', id: '100000001', note: 'x' });
  check('未知名单 → 400', badList.status === 400);
  const badId = await call('POST', { list: 'allow-groups', action: 'note', id: 'abc', note: 'x' });
  check('号非法 → 400', badId.status === 400);
  check('几次失败都没写坏 config.json', JSON.parse(fs.readFileSync(CONFIG, 'utf8')).allow.groups[0] === '100000001');
}

console.log('## 3. 后端：ai-blacklist 用对象条目存备注');
{
  await call('POST', { list: 'ai-blacklist', action: 'add', id: '100000014' });
  await call('POST', { list: 'ai-blacklist', action: 'note', id: '100000014', note: '别家机器人' });
  const entry = disk().socialV2.aiBlacklist.qq.find((e) => String(e.id) === '100000014');
  check('备注写进对象条目的 note 字段', !!entry && entry.note === '别家机器人');
  await call('POST', { list: 'ai-blacklist', action: 'remove', id: '100000014' });
  check('移除条目后备注一起没了', !disk().socialV2.aiBlacklist.qq.some((e) => String(e.id) === '100000014'));
}

console.log('## 4. 鉴权：智能体不能改名单');
{
  await call('POST', { list: 'allow-groups', action: 'note', id: '100000001', note: 'x' }, { 'x-agent-token': 'abc' });
  check('带 x-agent-token → 403 且没写盘', disk()?.socialV2?.listNotes?.['allow-groups'] === undefined);
  const byCall = await call('POST', { list: 'allow-groups', action: 'note', id: '100000001', note: 'x' }, { 'x-agent-call': '1' });
  check('带 x-agent-call → 403', byCall.status === 403);
}

console.log('## 5. 前端：备注列可改、写操作、常量一致');
{
  const settings = fs.readFileSync(new URL('../client/05-settings.js', import.meta.url), 'utf8');
  const shell = fs.readFileSync(new URL('../client/01-shell.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/client.css', import.meta.url), 'utf8');
  check('备注列走 listsNoteCellHtml', settings.includes('listsNoteCellHtml(listState.tab'));
  // 会话缓存里没有名字时用备注当名字（AI 号永远没有 private: 会话，否则一列全是「QQ 214109…」）
  check('没有会话名时用备注当名字', /var title = name \|\| noteText;/.test(settings)
    && /esc\(title \|\| listIdText\(meta\.kind, id\)\)/.test(settings));
  // 备注已经当名字显示时，备注列不再重复正文，只留一支笔
  check('备注当名字时备注列去重', /function listsNoteCellHtml\(list, id, note, hideText\)/.test(settings)
    && /hideText \? '同名字' : '—'/.test(settings)
    && /listsNoteCellHtml\(listState\.tab, id, noteText, !name && !!noteText\)/.test(settings));
  check('单元格里有 ＋备注 / ✎ 按钮', settings.includes('data-write="lists-note"') && settings.includes("(text ? '✎' : '＋')"));
  check('有备注时显示备注文字、没备注显示 —', settings.includes('qdb-list-note-text') && settings.includes('qdb-list-note-empty'));
  check('前端常量 40 与后端一致', settings.includes('var LIST_NOTE_MAX = 40;'));
  check('写操作 lists-note 会 POST action:note', shell.includes("'lists-note': function (btn)") && shell.includes("action: 'note'"));
  check('保存成功后 toast 且就地重画（listsPost → listsApply → paintLists）', shell.includes("toast(note ? '备注已保存' : '备注已删掉'") && settings.includes('function listsApply(data)'));
  check('CSS 有备注单元格与按钮样式', css.includes('.qdb-list-note-cell') && css.includes('.qdb-list-note-btn'));
  // 名单页（config 的 listNotes）和会话页（state/member-notes.json）是两套存储：
  // QQ 类名单改完备注要顺手同步过去，否则同一个人在两页显示两个名字。
  check('QQ 类名单备注会同步到群友备注', shell.includes("meta.kind === 'qq'") && shell.includes("apiWrite('/api/member-notes', { userId: id, name: note })"));
  check('同步后重画会话侧（applyNotesResult + repaintAfterNote）', shell.includes('applyNotesResult(res);') && shell.includes('repaintAfterNote();'));
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log('');
if (failures.length) {
  console.error(`❌ test-lists-note 失败 ${failures.length} 条：`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`🎉 test-lists-note 全部通过：${pass}/${pass}`);
