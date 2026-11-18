// 解压密码本（/api/library/passwords 与 lookup/remember 内部 API）。
//
// 重点不是「接口通了」，而是安全边界：
// - 响应里**永远不回明文**（只有掩码 + updatedAt），日志也不打明文；
// - get/密码本文件坏了都要当空，不能让一件坏 JSON 把解压整条路堵死；
// - agent 令牌一律 403（智能体不能翻用户密码）；
// - 重启（新实例）后仍能查到，最多保留 200 条。
// 全部用真 fs 临时目录，不碰真库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createLibraryPasswords } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-passwords.js')).href);

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-passwords-'));
const stateDir = path.join(tmp, 'state');
fs.mkdirSync(stateDir, { recursive: true });
const storePath = path.join(stateDir, 'booth-passwords.json');

// 已购台账：标题只是索引，密码本不该为了标题联网。
fs.writeFileSync(path.join(stateDir, 'booth-purchases.json'), JSON.stringify({
  v: 1,
  items: [{ boothId: '5197537', title: '【MA設定済】ゆらゆらオバケギミック' }]
}));

const logs = [];
const mkDeps = () => ({
  fs,
  path,
  STATE_DIR: stateDir,
  now: () => 1700000000000,
  log: (message) => logs.push(String(message)),
  atomicWriteJson: (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2))
});

let api = createLibraryPasswords(mkDeps());

function mkReq({ method = 'GET', headers = {}, body = null } = {}) {
  const r = {
    req: { method, headers },
    url: new URL('http://127.0.0.1:3100/placeholder'),
    res: {},
    readBody: async () => body,
    sent: null,
    sendJson(payload, status = 200) { r.sent = { payload, status }; }
  };
  return r;
}

async function call(pathname, { method = 'GET', headers = {}, body = null } = {}) {
  const r = mkReq({ method, headers, body });
  r.url = new URL('http://127.0.0.1:3100' + pathname);
  const handled = await api.handleConsoleLibraryPasswords(r);
  return { handled, status: r.sent ? r.sent.status : 0, payload: r.sent ? r.sent.payload : null };
}

console.log('## 空密码本：列表为空、不报错');
{
  const r = await call('/api/library/passwords');
  check('GET 空本 → ok', r.payload && r.payload.ok === true);
  check('空本 count=0 且 entries=[]', r.payload.count === 0 && Array.isArray(r.payload.entries) && r.payload.entries.length === 0);
  check('空本时文件还没被创建', !fs.existsSync(storePath));
}

console.log('## 记住密码：响应只有掩码，文件里才是明文（要能真解压）');
{
  const r = await call('/api/library/passwords', { method: 'POST', body: { boothId: '5197537', password: '  open-sesame  ' } });
  check('POST 记住 → 200', r.status === 200 && r.payload.ok === true, JSON.stringify(r.payload));
  check('键按 boothId 归一成 booth:<号>', r.payload.entry && r.payload.entry.key === 'booth:5197537', JSON.stringify(r.payload.entry));
  check('响应只有掩码，没有明文', r.payload.entry && r.payload.entry.masked === '••••••' && !JSON.stringify(r.payload).includes('open-sesame'));
  check('标题从已购台账补上（不联网）', r.payload.entry && /ゆらゆら/.test(String(r.payload.entry.title)), String(r.payload.entry && r.payload.entry.title));
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  check('落盘里是明文（解压要用）', stored.items['booth:5197537'] && stored.items['booth:5197537'].password === 'open-sesame');
  check('落盘带 version/items 结构', stored.version === 1 && typeof stored.items === 'object');
  const logsText = logs.join('\n');
  check('日志不打明文（只打长度）', !logsText.includes('open-sesame') && /长度/.test(logsText), logsText);
}

console.log('## 列表：掩码 + 时间，绝不回明文');
{
  const r = await call('/api/library/passwords');
  check('GET → count=1', r.payload.count === 1, JSON.stringify(r.payload));
  const entry = r.payload.entries[0];
  check('条目字段齐全', Boolean(entry && entry.key && entry.boothId && 'title' in entry && entry.masked && entry.updatedAt));
  check('响应里搜不到明文', !JSON.stringify(r.payload).includes('open-sesame'));
}

console.log('## 素材 key 与 booth 键并存');
{
  const r = await call('/api/library/passwords', { method: 'POST', body: { key: 'dhash-abc', boothId: '5197537', password: 'asset-pw' } });
  check('带 key 时用 key 当键（不覆盖 booth 键）', r.payload.entry && r.payload.entry.key === 'dhash-abc', JSON.stringify(r.payload.entry));
  const list = await call('/api/library/passwords');
  check('两条独立记录', list.payload.count === 2, JSON.stringify(list.payload.entries));
}

console.log('## 参数校验');
{
  const tooLong = await call('/api/library/passwords', { method: 'POST', body: { boothId: '5197537', password: 'x'.repeat(65) } });
  check('密码超 64 字 → 400', tooLong.status === 400 && /64/.test(String(tooLong.payload.error)));
  const empty = await call('/api/library/passwords', { method: 'POST', body: { boothId: '5197537', password: '   ' } });
  check('空密码 → 400', empty.status === 400);
  const noKey = await call('/api/library/passwords', { method: 'POST', body: { password: 'abc' } });
  check('缺 key/boothId → 400', noKey.status === 400 && /key/.test(String(noKey.payload.error)));
  const badJson = await call('/api/library/passwords', { method: 'POST', body: null });
  check('没有请求体 → 400（不炸）', badJson.status === 400);
}

console.log('## 智能体与访客：一律 403，不读不写');
{
  const agentGet = await call('/api/library/passwords', { headers: { 'x-agent-token': 'abc123' } });
  check('agent GET → 403', agentGet.status === 403);
  const agentPost = await call('/api/library/passwords', { method: 'POST', headers: { 'x-agent-call': '1' }, body: { boothId: '1', password: 'x' } });
  check('agent POST → 403', agentPost.status === 403);
  const agentRemove = await call('/api/library/passwords/remove', { method: 'POST', headers: { 'x-agent-token': 'abc123' }, body: { key: 'booth:5197537' } });
  check('agent 删除 → 403', agentRemove.status === 403);
}

console.log('## 删除');
{
  const unknown = await call('/api/library/passwords/remove', { method: 'POST', body: { boothId: '9999999' } });
  check('删不存在的 → 404', unknown.status === 404);
  const removed = await call('/api/library/passwords/remove', { method: 'POST', body: { key: 'dhash-abc' } });
  check('删存在的 → ok', removed.payload.ok === true && removed.payload.removed === 'dhash-abc');
  const list = await call('/api/library/passwords');
  check('删完只剩一条', list.payload.count === 1, JSON.stringify(list.payload.entries));
  const getRemove = await call('/api/library/passwords/remove', { method: 'GET' });
  check('删除接口用 GET → 405', getRemove.status === 405);
  const del = await call('/api/library/passwords', { method: 'DELETE' });
  check('列表接口用 DELETE → 405', del.status === 405);
  const other = await call('/api/library/other');
  check('别的路径返回 false', other.handled === false);
}

console.log('## 内部 API：给解压链路查/记');
{
  check('lookupPasswords({boothId}) 返回密码数组', JSON.stringify(api.lookupPasswords({ boothId: '5197537' })) === JSON.stringify(['open-sesame']));
  check('hasPassword 命中为 true', api.hasPassword({ boothId: '5197537' }) === true);
  check('hasPassword 未命中为 false', api.hasPassword({ boothId: '1111111' }) === false);
  api.rememberPassword({ key: 'booth:5197537', password: 'new-one' });
  check('remember 覆盖同键密码', JSON.stringify(api.lookupPasswords({ boothId: '5197537' })) === JSON.stringify(['new-one']));
}

console.log('## 重启（新实例）与坏文件容错');
{
  api = createLibraryPasswords(mkDeps());
  check('新实例仍能读到（重启不丢）', api.hasPassword({ boothId: '5197537' }) === true);
  fs.writeFileSync(storePath, '{ 这不是 JSON');
  check('坏文件当空（不抛）', api.lookupPasswords({ boothId: '5197537' }).length === 0);
  const list = await call('/api/library/passwords');
  check('坏文件时 GET 仍 200 + count=0', list.payload.ok === true && list.payload.count === 0, JSON.stringify(list.payload));
  fs.writeFileSync(storePath, JSON.stringify({ version: 1, items: [1, 2, 3] }));
  check('items 是数组也当空', api.lookupPasswords({ boothId: '5197537' }).length === 0);
}

console.log('## 上限：最多 200 条，新的优先');
{
  fs.rmSync(storePath, { force: true });
  api = createLibraryPasswords(mkDeps());
  for (let index = 0; index < 205; index += 1) api.rememberPassword({ key: `booth:${6000000 + index}`, password: `pw-${index}` });
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const keys = Object.keys(stored.items);
  check('落盘最多 200 条', keys.length <= 200, `实际 ${keys.length}`);
  check('最新的那条一定在', keys.includes('booth:6000204'));
  check('最老的一条被挤掉', !keys.includes('booth:6000000'));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log(`解压密码本：通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
