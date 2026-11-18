// 静默观战（偶尔才看一眼群）的边界回归：不启动桥接、不连 QQ、不调模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuietWatch, normalizeQuietSettings, triggerBase, QUIET_DEFAULTS } from '../src/bridge/quiet-watch.js';

const MIN = 60 * 1000;

function setup(options = {}) {
  let at = options.at ?? 1_000_000;
  const timers = [];
  const scheduled = [];
  const logs = [];
  const states = { ...(options.states ?? {}) };
  const cfg = { socialV2: { quiet: { ...(options.quiet ?? {}) } } };
  const watch = createQuietWatch({
    getConfig: () => cfg,
    log: (...args) => logs.push(args.join(' ')),
    getSocialV2State: (key) => states[key] ?? {},
    scheduleWake: (key, reason) => scheduled.push({ key, reason }),
    now: () => at,
    random: () => (options.random ?? 0.99),
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false, unref() { return timer; } };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; }
  });
  return {
    watch,
    cfg,
    logs,
    scheduled,
    timers,
    states,
    setState(key, st) { states[key] = st; },
    advance(ms) { at += ms; },
    now: () => at
  };
}

test('私聊完全不受管：触发原样放行、定时唤醒照排', () => {
  const env = setup();
  const reason = env.watch.admit('private:123456', { unread: [] }, 'probability');
  assert.equal(reason, 'probability');
  assert.equal(env.watch.allowsTimerWake('private:123456', { unread: [] }, 'replyCheck'), true);
  assert.equal(env.timers.length, 0);
});

test('群潜水期：@ 放行、进入在场，并记一行日志', () => {
  const env = setup();
  const st = { unread: [{ seq: 1 }] };
  env.setState('group:100', st);
  const reason = env.watch.admit('group:100', st, 'atMention@seq1');
  assert.equal(reason, 'atMention@seq1');
  const status = env.watch.status('group:100');
  assert.equal(status.mode, 'engaged');
  assert.equal(status.engagedBy, 'atMention');
  assert.equal(status.admitted, 1);
});

test('群潜水期：关键词/提问/概率一律吞掉，只累加计数', () => {
  const env = setup({ random: 0.99 });
  const st = { unread: [{ seq: 1 }] };
  env.setState('group:100', st);
  assert.equal(env.watch.admit('group:100', st, 'keyword:小鲸鱼'), null);
  assert.equal(env.watch.admit('group:100', st, 'question'), null);
  assert.equal(env.watch.admit('group:100', st, 'probability'), null);
  const status = env.watch.status('group:100');
  assert.equal(status.mode, 'sleeping');
  assert.equal(status.suppressed, 3);
  assert.equal(status.admitted, 0);
});

test('在场期：关键词与概率照常放行（「继续聊下去」）', () => {
  const env = setup();
  const st = { unread: [{ seq: 1 }] };
  env.setState('group:100', st);
  env.watch.admit('group:100', st, 'atMention@seq1');
  assert.equal(env.watch.admit('group:100', st, 'keyword:小鲸鱼'), 'keyword:小鲸鱼');
  assert.equal(env.watch.admit('group:100', st, 'probability'), 'probability');
});

test('在场到期自动退回潜水（engagedMs 之后）', () => {
  const env = setup({ quiet: { engagedMs: 5 * MIN } });
  const st = { unread: [] };
  env.setState('group:100', st);
  env.watch.admit('group:100', st, 'nameMention');
  env.advance(5 * MIN - 1);
  assert.equal(env.watch.status('group:100').mode, 'engaged');
  env.advance(2);
  assert.equal(env.watch.status('group:100').mode, 'sleeping');
  assert.ok(env.logs.some((line) => line.includes('退回偶尔看一眼')));
});

test('自己发言续期：lastAiReplyAt 会把在场时间顶到「最后一次说话 + engagedMs」', () => {
  const env = setup({ quiet: { engagedMs: 5 * MIN } });
  const st = { unread: [], lastAiReplyAt: 0 };
  env.setState('group:100', st);
  env.watch.admit('group:100', st, 'atMention@seq1');
  env.advance(4 * MIN);
  st.lastAiReplyAt = env.now();
  env.watch.admit('group:100', st, null);
  env.advance(4 * MIN);
  assert.equal(env.watch.status('group:100').mode, 'engaged');
  env.advance(2 * MIN);
  assert.equal(env.watch.status('group:100').mode, 'sleeping');
});

test('自己刚说过话但状态还在 sleeping：refresh 会补进在场态', () => {
  const env = setup({ quiet: { engagedMs: 5 * MIN } });
  const st = { unread: [], lastAiReplyAt: env.now() - MIN };
  env.setState('group:100', st);
  assert.equal(env.watch.admit('group:100', st, 'keyword:x'), 'keyword:x');
  assert.equal(env.watch.status('group:100').mode, 'engaged');
});

test('抬眼定时器：潜水 + 有未读才排，且命中概率才唤醒模型', () => {
  const env = setup({ quiet: { glanceMinMs: 1000, glanceMaxMs: 1000, glanceProbability: 1 }, random: 0 });
  const st = { unread: [{ seq: 1 }] };
  env.setState('group:100', st);
  env.watch.admit('group:100', st, 'keyword:x');
  assert.equal(env.timers.length, 1);
  assert.equal(env.timers[0].ms, 1000);
  env.timers[0].fn();
  assert.deepEqual(env.scheduled, [{ key: 'group:100', reason: 'glance' }]);
});

test('抬眼没命中概率：不唤醒、继续潜水并重排', () => {
  const env = setup({ quiet: { glanceMinMs: 1000, glanceMaxMs: 1000, glanceProbability: 0 }, random: 0 });
  const st = { unread: [{ seq: 1 }] };
  env.setState('group:100', st);
  env.watch.admit('group:100', st, 'keyword:x');
  env.timers[0].fn();
  assert.equal(env.scheduled.length, 0);
  assert.equal(env.watch.status('group:100').mode, 'sleeping');
  assert.equal(env.timers.length, 2);
});

test('没有未读时不排抬眼：等新消息来了再排', () => {
  const env = setup();
  const st = { unread: [] };
  env.setState('group:100', st);
  env.watch.admit('group:100', st, 'keyword:x');
  assert.equal(env.timers.length, 0);
});

test('定时类唤醒：潜水期不允许，在场期允许', () => {
  const env = setup();
  const st = { unread: [] };
  env.setState('group:100', st);
  assert.equal(env.watch.allowsTimerWake('group:100', st, 'replyCheck'), false);
  assert.equal(env.watch.allowsTimerWake('group:100', st, 'proactiveCheck'), false);
  env.watch.admit('group:100', st, 'poke');
  assert.equal(env.watch.allowsTimerWake('group:100', st, 'replyCheck'), true);
});

test('enabled=false 时整体退回旧行为（不吞任何触发）', () => {
  const env = setup({ quiet: { enabled: false } });
  const st = { unread: [{ seq: 1 }] };
  env.setState('group:100', st);
  assert.equal(env.watch.admit('group:100', st, 'keyword:x'), 'keyword:x');
  assert.equal(env.watch.allowsTimerWake('group:100', st, 'proactiveCheck'), true);
  assert.equal(env.timers.length, 0);
});

test('reset 会清掉抬眼定时器与状态', () => {
  const env = setup({ quiet: { glanceMinMs: 1000, glanceMaxMs: 1000 } });
  const st = { unread: [{ seq: 1 }] };
  env.setState('group:100', st);
  env.watch.admit('group:100', st, 'keyword:x');
  const timer = env.timers[0];
  env.watch.reset('group:100');
  assert.equal(timer.cleared, true);
  assert.equal(env.watch.status('group:100').mode, 'sleeping');
});

test('触发源子类型归一到基名（冒号与 @ 之后都是子类型）', () => {
  assert.equal(triggerBase('speaker:阿宝'), 'speaker');
  assert.equal(triggerBase('atMention@seq12'), 'atMention');
  assert.equal(triggerBase('keyword:小鲸鱼'), 'keyword');
  assert.equal(triggerBase(undefined), '');
});

test('normalizeQuietSettings 收敛脏配置', () => {
  const s = normalizeQuietSettings({ engagedMs: -5, glanceMinMs: 90_000, glanceMaxMs: 1000, glanceProbability: 5, hardTriggers: [] });
  assert.equal(s.engagedMs, QUIET_DEFAULTS.engagedMs);
  assert.equal(s.glanceMinMs, 90_000);
  assert.equal(s.glanceMaxMs, 90_000);
  assert.equal(s.glanceProbability, 1);
  assert.deepEqual(s.hardTriggers, QUIET_DEFAULTS.hardTriggers.map((item) => item.toLowerCase()));
  assert.equal(normalizeQuietSettings(null).enabled, true);
});
