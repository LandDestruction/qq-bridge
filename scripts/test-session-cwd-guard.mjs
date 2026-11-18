import { readBridgeSource } from './bridge-source.mjs';
// 会话 workspace 存活守卫回归（bridge.js ensureSession / sessionWorkspaceGone）
//
// 背景：2026-10-27 00:35 仓库迁移后，5 个线上会话的 workspace cwd 指向已不存在的旧目录。
// DSH 每轮打开 workspace 抛 workspace/invalid-path（ENOENT realpath），桥接只记一行
// 「agent 处理出错」就丢掉，state.sessions 里的映射永远不清 → 群里每条消息都没有回复。
// 本套件锁定「复用前核 cwd，失效就退役重建」以及三条不误杀的边界。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
let pass = 0;
let fail = 0;
const ok = (name) => { pass += 1; console.log('  ok   ' + name); };
const bad = (name, error) => { fail += 1; console.log('  FAIL ' + name + '：' + (error?.message ?? error)); };
async function test(name, run) {
  const h = await bridgeHarness();
  try { await run(h); ok(name); }
  catch (error) { bad(name, error); }
  finally { await h.close(); }
}
const settle = async (pred) => { for (let i = 0; i < 50 && !pred(); i += 1) await new Promise((r) => setImmediate(r)); };
const listOf = (items) => async (params = {}) => ({ result: { ok: true, value: { items } } });

console.log('[1] 旧目录失效：退役重建（线上 5 个会话的死法）');
await test('cwd 不存在 → 不复用旧会话，改建成新会话', async (h) => {
  const first = await h.ensureSession('private:123');
  const gonePath = path.join(h.temp, 'state', 'agents-removed-by-migration');
  assert.equal(fs.existsSync(gonePath), false);
  h.api.sessions.list = listOf([{ sessionId: first, cwd: gonePath }]);
  const second = await h.ensureSession('private:123');
  assert.notEqual(second, first);
  assert.equal(h.state.sessions['private:123'], second);
});
await test('迁移真实长相：cwd 是旧版 E:\\qq-bot-worktrees 路径 → 判定失效', async (h) => {
  const first = await h.ensureSession('private:123');
  h.api.sessions.list = listOf([{ sessionId: first, cwd: 'E:\\qq-bot-worktrees\\main\\state\\agents' }]);
  const second = await h.ensureSession('private:123');
  assert.notEqual(second, first);
});
await test('失效会话会被归档（不是只删本地映射，DSH 侧也收尾）', async (h) => {
  const first = await h.ensureSession('private:123');
  h.api.sessions.list = listOf([{ sessionId: first, cwd: path.join(h.temp, 'gone') }]);
  await h.ensureSession('private:123');
  await settle(() => h.calls.archived.includes(first));
  assert.ok(h.calls.archived.includes(first), '旧会话应被 archiveSession 归档');
});

console.log('[2] 健康会话不得误杀');
await test('cwd 存在 → 原样复用，不新建不归档', async (h) => {
  const first = await h.ensureSession('private:123');
  h.api.sessions.list = listOf([{ sessionId: first, cwd: h.temp }]);
  const second = await h.ensureSession('private:123');
  assert.equal(second, first);
  assert.equal(h.calls.created.length, 1);
  await settle(() => false);
  assert.equal(h.calls.archived.length, 0);
});
await test('清单里没有该 sessionId → 放行（归档状态交给 selectModel 的 not-found）', async (h) => {
  const first = await h.ensureSession('private:123');
  h.api.sessions.list = listOf([]);
  assert.equal(await h.ensureSession('private:123'), first);
});
await test('清单里 cwd 为空 → 放行（不拿空串当成路径不存在）', async (h) => {
  const first = await h.ensureSession('private:123');
  h.api.sessions.list = listOf([{ sessionId: first, cwd: '' }]);
  assert.equal(await h.ensureSession('private:123'), first);
});
await test('sessions.list 抛错 → fail-open 复用，并 60 秒内不再重试', async (h) => {
  const first = await h.ensureSession('private:123');
  let listCalls = 0;
  h.api.sessions.list = async () => { listCalls += 1; throw new Error('rpc down'); };
  assert.equal(await h.ensureSession('private:123'), first);
  assert.equal(await h.ensureSession('private:123'), first);
  assert.equal(listCalls, 1, '失败后应记 errorAt 退避，不能每条消息都白等 5 秒');
  assert.equal(h.calls.created.length, 1);
});
await test('sessions.list 超时/挂起 → 不阻塞到消息超时（5 秒预算）', async (h) => {
  const first = await h.ensureSession('private:123');
  // 永不 resolve，模拟 DSH 半死；守卫的 withTimeout 必须自己放行。
  h.api.sessions.list = () => new Promise(() => {});
  const started = Date.now();
  assert.equal(await h.ensureSession('private:123'), first);
  const cost = Date.now() - started;
  assert.ok(cost < 6000, `守卫最坏只能花 5 秒，实际 ${cost}ms`);
});

console.log('[3] 缓存与接线');
await test('TTL 内多次复用只查一次 sessions.list', async (h) => {
  const first = await h.ensureSession('private:123');
  const base = listOf([{ sessionId: first, cwd: h.temp }]);
  h.api.sessions.list = async (params = {}) => { h.calls.lists.push(params); return base(params); };
  for (let i = 0; i < 3; i += 1) assert.equal(await h.ensureSession('private:123'), first);
  assert.equal(h.calls.lists.length, 1, `列表 RPC 只该打一次，实际 ${h.calls.lists.length}`);
});
await test('守卫只读：检查前后临时目录文件数不变', async (h) => {
  await h.ensureSession('private:123');
  const before = fs.readdirSync(path.join(h.temp, 'state')).sort();
  h.api.sessions.list = listOf([{ sessionId: 'fixture-1', cwd: h.temp }]);
  await h.ensureSession('private:123');
  assert.deepEqual(fs.readdirSync(path.join(h.temp, 'state')).sort(), before);
});
await test('bridge.js 源码：复用分支先查存活再 return existing', async () => {
  const src = readBridgeSource();
  const start = src.indexOf('async function ensureSession(');
  assert.ok(start > 0, '找不到 ensureSession');
  const body = src.slice(start, src.indexOf('\n  async function ', start + 10));
  const callAt = body.indexOf('await sessionWorkspaceGone(existing)');
  const returnAt = body.indexOf('return existing');
  assert.ok(callAt > 0, '复用分支没有调用 sessionWorkspaceGone');
  assert.ok(returnAt > callAt, '守卫必须在 return existing 之前');
  assert.ok(body.includes('retireSession(key)'), '失效时缺少 retireSession');
  const guard = src.slice(src.indexOf('async function sessionWorkspaceGone'), start);
  assert.ok(guard.includes('fs.existsSync'), '守卫必须真的看盘，不能只比字符串');
  assert.ok(guard.includes('SESSION_CWD_CHECK_TTL_MS'), '守卫缺少 TTL 缓存');
});

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
