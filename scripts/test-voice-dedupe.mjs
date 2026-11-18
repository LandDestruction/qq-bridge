// 「QQ 官方语音合成即发送」去重判定的单测。
//
// 回归背景（2026-10-25 审计 P0）：sendVoiceForV2 原来只按会话 key 查一个 30 秒时间戳，
// 命中就直接 return {auto:true,messageId:null}。于是「一次 QQ 官方语音」之后 30 秒内，
// qq_send_voice 发语音库文件、tts: 前缀、[语音] 前缀的发送全被静默吞掉，
// 调用方还拿到 ok:true —— 模型以为发出去了，群里什么也没有。
//
// 现在的契约：标记带递增序号，只有「拿着本次刚合成那条的序号来发送」才跳过。
import assert from 'node:assert/strict';
import { AUTO_VOICE_SKIP_MS, isOwnSynthesis, isRecentSynthesis, nextAutoVoiceMark } from '../src/voice-dedupe.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}: ${e.message}`); }
}

console.log('\n[1] 标记生成');
check('序号递增、key 与时间戳保留', () => {
  const m1 = nextAutoVoiceMark({ seq: 1, key: 'group:1', at: 1000 });
  assert.equal(m1.seq, 1);
  assert.equal(m1.key, 'group:1');
  assert.equal(m1.at, 1000);
  const m2 = nextAutoVoiceMark({ ...m1, at: 2000 });
  assert.equal(m2.seq, 1, '继承旧标记时序号不变（只是刷新时间）');
  assert.equal(m2.at, 2000);
});
check('非法序号兜底为 0（不会被当成有效标记）', () => {
  const m = nextAutoVoiceMark({ seq: 'x', key: 'group:1', at: 0 });
  assert.equal(m.seq, 0);
  assert.equal(isOwnSynthesis(m, { seq: 0, key: 'group:1' }), false);
});

console.log('\n[2] isRecentSynthesis：拦住 30 秒内重复合成');
check('刚合成过 ⇒ true', () => {
  assert.equal(isRecentSynthesis({ seq: 1, key: 'group:1', at: 1000 }, { now: 1000 + 1000 }), true);
});
check('超过窗口 ⇒ false', () => {
  assert.equal(isRecentSynthesis({ seq: 1, key: 'group:1', at: 1000 }, { now: 1000 + AUTO_VOICE_SKIP_MS + 1 }), false);
});
check('没有标记 / 空对象 ⇒ false', () => {
  assert.equal(isRecentSynthesis(null), false);
  assert.equal(isRecentSynthesis({}), false);
  assert.equal(isRecentSynthesis({ at: 0 }), false);
});

console.log('\n[3] isOwnSynthesis：只有「刚合成那条」才跳过');
check('序号 + key 都对 ⇒ true（应当跳过）', () => {
  const mark = { seq: 7, key: 'group:1', at: 1000 };
  assert.equal(isOwnSynthesis(mark, { seq: 7, key: 'group:1' }, { now: 1500 }), true);
});
check('没有 token（语音库文件 / 别的来源）⇒ false（必须照常发送）', () => {
  const mark = { seq: 7, key: 'group:1', at: 1000 };
  assert.equal(isOwnSynthesis(mark, null, { now: 1500 }), false);
  assert.equal(isOwnSynthesis(mark, undefined, { now: 1500 }), false);
});
check('序号不同（又合成了一条新的）⇒ false', () => {
  const mark = { seq: 8, key: 'group:1', at: 1000 };
  assert.equal(isOwnSynthesis(mark, { seq: 7, key: 'group:1' }, { now: 1500 }), false);
});
check('key 不同 ⇒ false', () => {
  const mark = { seq: 7, key: 'group:1', at: 1000 };
  assert.equal(isOwnSynthesis(mark, { seq: 7, key: 'group:2' }, { now: 1500 }), false);
});
check('过了窗口 ⇒ false（不再吞发送）', () => {
  const mark = { seq: 7, key: 'group:1', at: 1000 };
  assert.equal(isOwnSynthesis(mark, { seq: 7, key: 'group:1' }, { now: 1000 + AUTO_VOICE_SKIP_MS }), false);
});
check('指纹不一致 ⇒ false', () => {
  const mark = { seq: 7, key: 'group:1', fingerprint: 'abc', at: 1000 };
  assert.equal(isOwnSynthesis(mark, { seq: 7, key: 'group:1', fingerprint: 'zzz' }, { now: 1500 }), false);
  assert.equal(isOwnSynthesis(mark, { seq: 7, key: 'group:1', fingerprint: 'abc' }, { now: 1500 }), true);
});

console.log('\n[4] 事故现场复现：一次 QQ 语音不该吞掉同会话后续语音');
check('合成 1 条后：它自己不重发，但语音库文件照发', () => {
  const marks = new Map();
  const key = 'group:1';
  const now = 10000;
  // 1) 合成（QQ 侧已直发）→ 打标记
  const mark = nextAutoVoiceMark({ seq: 1, key, at: now });
  marks.set(key, mark);
  // 2) 这条合成产物自己不重复发送
  assert.equal(isOwnSynthesis(marks.get(key), { seq: mark.seq, key }, { now: now + 500 }), true);
  // 3) 同一会话、窗口内，发语音库文件（调用方不带 token）→ 必须真的发
  assert.equal(isOwnSynthesis(marks.get(key), null, { now: now + 1000 }), false, '语音库文件被吞了');
  // 4) 窗口内再来一次 tts（合成被拦）→ 手上有旧 token 也不能冒充
  assert.equal(isRecentSynthesis(marks.get(key), { now: now + 2000 }), true);
  // 5) 新合成一条 → 新序号，旧 token 不再匹配
  const mark2 = nextAutoVoiceMark({ seq: mark.seq + 1, key, at: now + 35000 });
  marks.set(key, mark2);
  assert.equal(isOwnSynthesis(marks.get(key), { seq: mark.seq, key }, { now: now + 35000 }), false);
  assert.equal(isOwnSynthesis(marks.get(key), { seq: mark2.seq, key }, { now: now + 35000 }), true);
});

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
