// 素材集（套装）的行为测试：纯规则 src/library-collections.js + VM 模块
// src/bridge/console/library-collections.js 的路由/落盘/权限。
//
// 跑法：node scripts/test-library-collections.mjs
// 输出：逐条 ok/FAIL + 「通过 X / 失败 Y」，失败退出码 1。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as pure from '../src/library-collections.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODULE_PATH = path.join(ROOT, 'src/bridge/console/library-collections.js');

let passed = 0;
const failures = [];
function check(cond, name, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
    return;
  }
  failures.push(name);
  console.log(`  FAIL ${name}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-collections-'));
const stateFile = path.join(tmp, 'library-collections.json');
function resetState() {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
}
function readState() {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

// 素材视图：decorate 的封面/缺失统计用；两件有 key，一件只有封面、一件只有缩略图。
const ASSETS = [
  { key: 'k1', coverUrl: '/api/files/cover/111' },
  { key: 'k2', thumbUrl: '/api/files/raw?rel=a%2Fb.jpg' }
];
const deps = {
  fs,
  path,
  STATE_DIR: tmp,
  log: () => {},
  atomicWriteJson: (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  },
  libraryAssetsViewOf: () => ({ ok: true, assets: ASSETS }),
  libraryCollectionsPure: pure
};

function makeRequest({ method = 'GET', pathname = '/api/library/collections', body = null, query = {}, headers = {} } = {}) {
  const sent = [];
  return {
    request: {
      req: { method, headers },
      url: { pathname, searchParams: new URLSearchParams(query) },
      readBody: async () => body,
      sendJson: (payload, status = 200) => sent.push({ status, payload }),
      res: { writeHead: () => {}, end: () => {} }
    },
    sent
  };
}
const lastJson = (sent) => sent[sent.length - 1];

const { createLibraryCollections } = await import(pathToFileURL(MODULE_PATH).href);
const service = createLibraryCollections(deps);
const call = async (options) => {
  const { request, sent } = makeRequest(options);
  const handled = await service.handleConsoleLibraryCollections(request);
  return { handled, sent };
};

// ── §1 纯规则 ────────────────────────────────────────────────────────────────
console.log('§1 纯规则');
const empty = pure.normalizeCollections(null);
check(empty.version === 1 && Object.keys(empty.items).length === 0, '坏输入 / null 归一成空表');
check(pure.normalizeCollections([1, 2]).items && Object.keys(pure.normalizeCollections([1, 2]).items).length === 0, '数组也当空表');
check(pure.isCollectionId('col_1793277265000_ab12') === true, '合法 id 识别');
check(pure.isCollectionId('col_x') === false && pure.isCollectionId(123) === false, '非法 id 拒绝');

const rawMixed = {
  version: 1,
  items: {
    'col_1793277265000_aaaa': { id: 'col_1793277265000_aaaa', name: '  冬装搭配  ', note: 'n'.repeat(260), keys: ['k1', 'k1', ' k2 ', 7], createdAt: 1, updatedAt: 2 },
    'not-a-real-id': { name: '坏 id' },
    'col_1793277265001_bbbb': { name: '   ' }
  }
};
const mixed = pure.normalizeCollections(rawMixed);
check(Object.keys(mixed.items).length === 1, '坏 id / 空名字条目被丢弃', Object.keys(mixed.items));
const entry = mixed.items['col_1793277265000_aaaa'];
check(entry.name === '冬装搭配', '名字去首尾空格');
check([...entry.note].length === 200, '备注截到 200 字');
check(JSON.stringify(entry.keys) === JSON.stringify(['k1', 'k2', '7']), 'keys 去重、去空格、非字符串转字符串', entry.keys);
check(entry.createdAt === 1 && entry.updatedAt === 2, '时间戳保留');

const longKeys = pure.createCollection(pure.normalizeCollections(null), {
  name: '上限',
  keys: Array.from({ length: 260 }, (_, i) => `k${i}`)
});
check(Object.values(longKeys.items)[0].keys.length === 200, '新建时 keys 上限 200');
const created = pure.createCollection(pure.normalizeCollections(null), { name: '测试集', note: '说明', keys: ['k1', 'k2', 'k2'] }, 1793277265123);
const createdEntry = Object.values(created.items)[0];
check(/^col_1793277265123_[a-z0-9]{4}$/.test(createdEntry.id), '新建 id 形如 col_<时间戳>_<随机4>', createdEntry.id);
check(JSON.stringify(createdEntry.keys) === JSON.stringify(['k1', 'k2']), '新建 keys 去重');
check(createdEntry.createdAt === 1793277265123, '新建带 createdAt');

let threw = '';
try { pure.createCollection(pure.normalizeCollections(null), { name: '   ' }); } catch (error) { threw = error.message; }
check(/集合名不能为空/.test(threw), '空名字抛中文错误', threw);
threw = '';
try { pure.createCollection(pure.normalizeCollections(null), { name: 'x'.repeat(41) }); } catch (error) { threw = error.message; }
check(/最多 40 个字/.test(threw), '名字超 40 字抛错', threw);

const baseTable = created;
const renamed = pure.updateCollection(baseTable, createdEntry.id, { name: '改名了', note: '新备注' }, 1793277266000);
check(renamed.items[createdEntry.id].name === '改名了', '改名生效');
check(renamed.items[createdEntry.id].updatedAt === 1793277266000, '更新时 updatedAt 跟着走');
check(baseTable.items[createdEntry.id].name === '测试集', 'update 不改入参');
threw = '';
try { pure.updateCollection(baseTable, 'col_1793277265000_zzzz', { name: 'x' }); } catch (error) { threw = error.message; }
check(/集合不存在/.test(threw), '改不存在的集合抛「集合不存在」', threw);

const withMore = pure.addKeys(baseTable, createdEntry.id, ['k3', 'k1']);
check(JSON.stringify(withMore.items[createdEntry.id].keys) === JSON.stringify(['k1', 'k2', 'k3']), 'addKeys 去重追加');
const sameAgain = pure.addKeys(withMore, createdEntry.id, ['k3']);
check(JSON.stringify(sameAgain.items[createdEntry.id].keys) === JSON.stringify(['k1', 'k2', 'k3']), 'addKeys 纯重复时结果不变');
const withLess = pure.removeKeys(withMore, createdEntry.id, ['k2', 'k4']);
check(JSON.stringify(withLess.items[createdEntry.id].keys) === JSON.stringify(['k1', 'k3']), 'removeKeys 只删给出的');
const removed = pure.removeCollection(withMore, createdEntry.id);
check(Object.keys(removed.items).length === 0, 'removeCollection 删掉集合');

const decorated = pure.decorateCollections(withMore, ASSETS);
const dec = decorated[0];
check(dec.count === 3 && dec.keys.length === 3, 'decorate 带 count');
check(JSON.stringify(dec.missingKeys) === JSON.stringify(['k3']), '盘上找不到的 key 进 missingKeys', dec.missingKeys);
check(dec.coverUrl === '/api/files/cover/111', 'coverUrl 默认取第一件封面', dec.coverUrl);

const withCover = pure.updateCollection(withMore, createdEntry.id, { coverKey: 'k2' }, 1793277267000);
const decCover = pure.decorateCollections(withCover, ASSETS)[0];
check(decCover.coverUrl === '/api/files/raw?rel=a%2Fb.jpg', 'coverKey 指定的那件优先当封面', decCover.coverUrl);
const decOrder = pure.decorateCollections(withCover, ASSETS);
check(decOrder.length === 1 && decOrder[0].id === createdEntry.id, 'decorate 返回数组且保留 id');

check(JSON.stringify(pure.collectionsOfAsset(withCover, 'k1')) === JSON.stringify([{ id: createdEntry.id, name: '测试集' }]), 'collectionsOfAsset 命中');
check(pure.collectionsOfAsset(withCover, 'k9').length === 0, 'collectionsOfAsset 未命中返回空');
check(pure.collectionsOfAsset(withCover, '').length === 0, 'collectionsOfAsset 空 key 返回空');

// ── §2 HTTP 路由 ─────────────────────────────────────────────────────────────
console.log('§2 HTTP 路由');
resetState();
const emptyList = await call();
check(emptyList.handled === true, 'GET /api/library/collections 被处理');
check(lastJson(emptyList.sent).status === 200 && lastJson(emptyList.sent).payload.ok === true, '空库 GET 200 ok');
check(lastJson(emptyList.sent).payload.total === 0, '空库 total=0');

const createRes = await call({ method: 'POST', body: { name: '测试集', note: '两个成员', keys: ['k1', 'k2'] } });
const createdPayload = lastJson(createRes.sent).payload;
check(lastJson(createRes.sent).status === 200 && createdPayload.ok === true, 'POST 新建 200');
check(/^col_/.test(createdPayload.id), '新建回 id', createdPayload.id);
check(createdPayload.item.count === 2 && createdPayload.item.name === '测试集', '新建回装饰后的 item');
check(fs.existsSync(stateFile), '新建落盘 state/library-collections.json');
const onDisk = readState();
check(onDisk.version === 1 && Boolean(onDisk.items[createdPayload.id]), '落盘形状 {version,items}');
check(fs.readFileSync(stateFile, 'utf8').includes('"name": "测试集"'), '落盘含中文名字（UTF-8）');

const listAfter = await call();
check(lastJson(listAfter.sent).payload.total === 1, '再 GET 列表 1 个集');

const byKey = await call({ query: { key: 'k1' } });
const byKeyPayload = lastJson(byKey.sent).payload;
check(byKeyPayload.items.length === 1 && byKeyPayload.items[0].id === createdPayload.id, 'GET ?key= 只回该件所属集合');
check(byKeyPayload.items[0].name === '测试集' && byKeyPayload.items[0].keys === undefined, 'GET ?key= 只给 {id,name}');
const byOtherKey = await call({ query: { key: 'zzz' } });
check(lastJson(byOtherKey.sent).payload.total === 0, 'GET ?key= 未命中为空');

const renameRes = await call({ method: 'POST', pathname: '/api/library/collections/update', body: { id: createdPayload.id, patch: { name: '改过的集' } } });
check(lastJson(renameRes.sent).status === 200 && lastJson(renameRes.sent).payload.item.name === '改过的集', 'POST update 改名 200');

const addRes = await call({ method: 'POST', pathname: '/api/library/collections/members', body: { id: createdPayload.id, add: ['k3'] } });
check(JSON.stringify(lastJson(addRes.sent).payload.item.keys) === JSON.stringify(['k1', 'k2', 'k3']), 'POST members add 追加成员');
const delRes = await call({ method: 'POST', pathname: '/api/library/collections/members', body: { id: createdPayload.id, remove: ['k2'] } });
check(JSON.stringify(lastJson(delRes.sent).payload.item.keys) === JSON.stringify(['k1', 'k3']), 'POST members remove 删成员');

const badName = await call({ method: 'POST', body: { keys: ['k1'] } });
check(lastJson(badName.sent).status === 400 && /集合名不能为空/.test(lastJson(badName.sent).payload.error), '缺 name 400 中文原因');
const badKeys = await call({ method: 'POST', body: { name: 'x', keys: 'k1' } });
check(lastJson(badKeys.sent).status === 400 && /keys 必须是数组/.test(lastJson(badKeys.sent).payload.error), 'keys 非数组 400');
const badMembers = await call({ method: 'POST', pathname: '/api/library/collections/members', body: { id: createdPayload.id } });
check(lastJson(badMembers.sent).status === 400, 'members 既无 add 也无 remove 400');
const missingUpdate = await call({ method: 'POST', pathname: '/api/library/collections/update', body: { id: 'col_1793277265000_zzzz', patch: { name: 'x' } } });
check(lastJson(missingUpdate.sent).status === 404, '改不存在的集合回 404');

const agent403 = await call({ headers: { 'x-agent-token': 'abc' } });
check(lastJson(agent403.sent).status === 403, '智能体令牌 403');
const getOnPostPath = await call({ method: 'GET', pathname: '/api/library/collections/update' });
check(lastJson(getOnPostPath.sent).status === 405 && /只支持 POST/.test(lastJson(getOnPostPath.sent).payload.error), 'GET 打 POST 路径 405');

// 坏 JSON 回落：手改坏的状态文件不能把页面弄崩。
fs.writeFileSync(stateFile, '{ broken json ');
const brokenList = await call();
check(lastJson(brokenList.sent).status === 200 && lastJson(brokenList.sent).payload.total === 0, '状态文件坏 JSON 就当空表');

// 删空：重建一个再删，确认 state 回到 {version:1,items:{}}
resetState();
const again = await call({ method: 'POST', body: { name: '待删', keys: ['k1'] } });
const againId = lastJson(again.sent).payload.id;
const removeRes = await call({ method: 'POST', pathname: '/api/library/collections/remove', body: { id: againId } });
check(lastJson(removeRes.sent).status === 200 && lastJson(removeRes.sent).payload.removed === againId, 'POST remove 200');
check(readState().items[againId] === undefined, 'remove 后落盘里没有该 id');
const unrelated = await call({ pathname: '/api/library/assets' });
check(unrelated.handled === false, '不归我管的路径返回 false');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n========== 通过 ${passed} / 失败 ${failures.length} ==========`);
if (failures.length) {
  for (const name of failures) console.log(`  ✗ ${name}`);
  process.exit(1);
}
