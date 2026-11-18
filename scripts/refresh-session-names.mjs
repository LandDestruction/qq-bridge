// refresh-session-names.mjs — 从 SnowLuma（OneBot HTTP）拉群名/好友昵称，写进 state 缓存。
// 用途：控制台的「会话标签」要靠群名/昵称显示成「群名（群号）」「昵称（QQ号）」，
// 但 bridge 只会在归档路径上顺手缓存群名，私聊昵称完全没有来源。这个脚本手动/定时刷一次即可。
// 只写两个文件：state/group-names.json、state/friend-names.json；失败只告警、不删旧数据。
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const sl = cfg.snowluma || {};
if (!sl.httpUrl) { console.error('config.snowluma.httpUrl 缺失，跳过'); process.exit(0); }
const base = String(sl.httpUrl).replace(/\/+$/, '');
const token = String(sl.accessToken || '');

async function call(action) {
  const res = await fetch(base + '/' + action, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10000)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.status === 'failed') throw new Error(action + ' 失败：' + JSON.stringify(json).slice(0, 160));
  return json.data;
}

function readJson(p, fallback) {
  try { const v = JSON.parse(fs.readFileSync(p, 'utf8')); return v && typeof v === 'object' ? v : fallback; } catch { return fallback; }
}
function writeJson(p, obj) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

const stateDir = path.join(root, 'state');
const groupFile = path.join(stateDir, 'group-names.json');
const friendFile = path.join(stateDir, 'friend-names.json');
let changed = 0;

try {
  const groups = await call('get_group_list');
  const names = readJson(groupFile, {});
  let added = 0;
  for (const g of Array.isArray(groups) ? groups : []) {
    const id = String(g?.group_id ?? '');
    const name = String(g?.group_name ?? '').trim();
    if (!id || !name) continue;
    if (names[id] !== name) { names[id] = name; added++; }
  }
  if (added) { writeJson(groupFile, names); changed += added; }
  console.log('群名：' + Object.keys(names).length + ' 条，本次更新 ' + added + ' 条');
} catch (e) { console.warn('群名刷新失败：' + e.message); }

try {
  const friends = await call('get_friend_list');
  const names = readJson(friendFile, {});
  let added = 0;
  for (const f of Array.isArray(friends) ? friends : []) {
    const id = String(f?.user_id ?? '');
    const name = String(f?.remark || f?.nickname || '').trim();
    if (!id || !name) continue;
    if (names[id] !== name) { names[id] = name; added++; }
  }
  if (added) { writeJson(friendFile, names); changed += added; }
  console.log('好友昵称：' + Object.keys(names).length + ' 条，本次更新 ' + added + ' 条');
} catch (e) { console.warn('好友昵称刷新失败：' + e.message); }

console.log(changed ? '已更新 ' + changed + ' 条名字缓存' : '名字缓存已是最新');
