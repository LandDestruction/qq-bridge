// message-db 单测：归档写入、去重、双轨检索（FTS5 ≥3 字 / LIKE 兜底 <3 字）。
// 用 ':memory:'，不碰任何真实 state 目录。
import assert from 'node:assert/strict';
import { openMessageDb, insertMessage, searchMessages, messageStats } from '../src/message-db.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}: ${e.message}`); }
}

const db = openMessageDb(':memory:');
const t0 = Date.now() - 60000;

console.log('\n[1] 写入与去重');
check('首次写入返回 true', () => {
  assert.equal(insertMessage(db, { key: 'group:1', ts: t0, sender: '甲', text: '今天电费交了两千万，记我账上' }), true);
});
check('同一条重复写入返回 false', () => {
  assert.equal(insertMessage(db, { key: 'group:1', ts: t0, sender: '甲', text: '今天电费交了两千万，记我账上' }), false);
});
check('空文本不写', () => assert.equal(insertMessage(db, { key: 'group:1', ts: t0, text: '   ' }), false));
check('缺 key 不写', () => assert.equal(insertMessage(db, { ts: t0, text: 'x' }), false));
insertMessage(db, { key: 'group:1', ts: t0 + 1000, sender: '乙', isSelf: true, text: '要软糯黏人一点' });
insertMessage(db, { key: 'private:9', ts: t0 + 2000, sender: '丙', text: '煎蛋和电费都别记错' });

console.log('\n[2] 统计');
check('总数 3 条', () => assert.equal(messageStats(db).count, 3));
check('会话数 2 个', () => assert.equal(messageStats(db).conversations, 2));
check('firstTs 正确', () => assert.equal(messageStats(db).firstTs, t0));

console.log('\n[3] FTS5 主检索（≥3 字）');
check('长词命中', () => {
  const r = searchMessages(db, { q: '电费交了两千万' });
  assert.equal(r.track, 'fts');
  assert.equal(r.rows.length, 1);
  assert.match(r.rows[0].text, /两千万/);
});
check('跨会话都能查到', () => {
  const r = searchMessages(db, { q: '软糯黏人' });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].key, 'group:1');
});
check('key 过滤生效', () => {
  const r = searchMessages(db, { q: '煎蛋和电费' });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].key, 'private:9');
  const none = searchMessages(db, { q: '煎蛋和电费', key: 'group:1' });
  assert.equal(none.rows.length, 0);
});
check('特殊字符不炸（引号/星号）', () => {
  assert.doesNotThrow(() => searchMessages(db, { q: 'foo"*bar' }));
});
check('limit 生效', () => {
  const r = searchMessages(db, { q: '电费', limit: 1 });
  assert.ok(r.rows.length <= 1);
});

console.log('\n[4] LIKE 兜底（<3 字，中文双字词）');
check('双字词能查到（FTS5 trigram 查不到）', () => {
  const r = searchMessages(db, { q: '煎蛋' });
  assert.equal(r.track, 'like');
  assert.equal(r.rows.length, 1);
});
check('单字也能查', () => {
  const r = searchMessages(db, { q: '电' });
  assert.equal(r.track, 'like');
  assert.ok(r.rows.length >= 1);
});
check('LIKE 通配符被转义（% 不当通配）', () => {
  const r = searchMessages(db, { q: '%' });
  assert.equal(r.rows.length, 0);
});

console.log('\n[5] 时间过滤与空查询');
check('sinceMs 过滤掉旧消息', () => {
  const r = searchMessages(db, { q: '电费', sinceMs: t0 + 1500 });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].key, 'private:9');
});
check('空查询返回空', () => assert.deepEqual(searchMessages(db, { q: '   ' }).rows, []));
check('结果按时间倒序', () => {
  const r = searchMessages(db, { q: '电费' });
  assert.ok(r.rows[0].ts >= r.rows[r.rows.length - 1].ts);
});

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
