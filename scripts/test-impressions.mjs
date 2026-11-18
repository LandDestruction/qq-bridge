// 群友印象归纳的纯函数测试：不连模型、不读 SQLite、不写 state。
//
// 为什么这层要测这么细：分片、校验、合并是「模型产物能不能安全落盘」的唯一防线——
// 模型输出的坏 JSON / 超长文本 / 伪造 QQ 号必须在这里被挡住，不能靠人眼看日志。

import assert from 'node:assert/strict';

import {
  DAY_MS,
  buildImpressions,
  buildShardPrompt,
  estimateBudget,
  mergeImpressions,
  parseShardResponse,
  planImpressionShards,
  validateImpression,
  windowOf
} from '../src/impressions.js';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${error?.message ?? error}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${error?.message ?? error}`);
  }
}

const DAY = DAY_MS;
// 2026-10-28 12:00:00 北京时间
const NOW = Date.UTC(2026, 9, 28, 4, 0, 0);

/** 造一条消息；默认落在 NOW 前 1 小时、group:10001、QQ 20001。 */
function msg(overrides = {}) {
  return {
    key: 'group:10001',
    ts: NOW - 3600_000,
    seq: 1,
    sender: '阿猫',
    userId: '20001',
    isSelf: false,
    text: '今天加班好累',
    ...overrides
  };
}

/** 一次生成多条递增消息，便于测切块/合并。 */
function series(count, overrides = {}) {
  return Array.from({ length: count }, (_item, index) =>
    msg({ ts: NOW - 3600_000 + index * 1000, seq: index + 1, userId: String(20001 + (index % 3)), text: `第 ${index} 条发言`, ...overrides })
  );
}

/** 分片的可比对摘要：只留会受切分逻辑影响、且与时间无关的字段。 */
function digest(shards) {
  return shards.map((shard) => ({
    id: shard.id,
    key: shard.key,
    day: shard.day,
    messageCount: shard.messageCount,
    textChars: shard.textChars,
    people: shard.people
  }));
}

// ---------------- windowOf ----------------
check('windowOf 默认 2 天且右端等于 now', () => {
  const win = windowOf(NOW);
  assert.equal(win.to, NOW);
  assert.equal(win.days, 2);
  assert.equal(win.from, NOW - 2 * DAY);
});

check('windowOf 支持自定义天数', () => {
  const win = windowOf(NOW, 3);
  assert.equal(win.days, 3);
  assert.equal(win.to - win.from, 3 * DAY);
});

check('windowOf 非法天数回落 2 天、超大天数夹到 30', () => {
  assert.equal(windowOf(NOW, 0).days, 2);
  assert.equal(windowOf(NOW, -5).days, 2);
  assert.equal(windowOf(NOW, 'abc').days, 2);
  assert.equal(windowOf(NOW, 999).days, 30);
});

// ---------------- planImpressionShards ----------------
check('空输入/非数组输入返回空分片，不崩', () => {
  assert.deepEqual(planImpressionShards([]), []);
  assert.deepEqual(planImpressionShards(null), []);
  assert.deepEqual(planImpressionShards(undefined), []);
  assert.deepEqual(planImpressionShards([null, 1, 'x']), []);
});

check('过滤自己发的消息、空文本、坏时间戳、没有 QQ 号的消息', () => {
  const shards = planImpressionShards([
    msg({ seq: 1 }),
    msg({ seq: 2, isSelf: true }),
    msg({ seq: 3, text: '   ' }),
    msg({ seq: 4, ts: Number.NaN }),
    msg({ seq: 5, userId: '' }),
    msg({ seq: 6, userId: 'abc' })
  ]);
  assert.equal(shards.length, 1);
  assert.equal(shards[0].messageCount, 1);
  assert.deepEqual(shards[0].messages.map((item) => item.seq), [1]);
});

check('按「会话×北京时间自然日」切片，跨日在北京时间零点切', () => {
  // 北京时间 10-27 23:59:00 = UTC 10-27 15:59；北京时间 10-28 00:01:00 = UTC 10-27 16:01
  const lateNight = msg({ ts: Date.UTC(2026, 9, 27, 15, 59, 0), seq: 1 });
  const afterMidnight = msg({ ts: Date.UTC(2026, 9, 27, 16, 1, 0), seq: 2 });
  const otherGroup = msg({ key: 'group:20002', ts: lateNight.ts, seq: 3 });
  const shards = planImpressionShards([lateNight, afterMidnight, otherGroup]);
  assert.deepEqual(
    shards.map((shard) => `${shard.key}#${shard.day}`),
    ['group:10001#2026-10-27', 'group:10001#2026-10-28', 'group:20002#2026-10-27']
  );
});

check('分片结果与输入顺序无关（同批消息重复跑得到同一套 id）', () => {
  const messages = series(30);
  const forward = planImpressionShards(messages, { maxShards: 5 });
  const backward = planImpressionShards(messages.slice().reverse(), { maxShards: 5 });
  assert.deepEqual(digest(forward), digest(backward));
  assert.deepEqual(
    forward.map((shard) => shard.id),
    ['group:10001#2026-10-28#1']
  );
});

check('maxPerShard 生效：按条数切成多块', () => {
  const shards = planImpressionShards(series(10), { maxPerShard: 4, maxShards: 10 });
  assert.equal(shards.length, 3);
  assert.deepEqual(
    shards.map((shard) => shard.messageCount),
    [4, 4, 2]
  );
});

check('maxCharsPerShard 生效：长文按字数切块', () => {
  const longText = '啊'.repeat(180);
  const messages = Array.from({ length: 10 }, (_item, index) =>
    msg({ ts: NOW - 3600_000 + index * 1000, seq: index + 1, text: longText })
  );
  const shards = planImpressionShards(messages, { maxCharsPerShard: 500, maxShards: 10 });
  assert.ok(shards.length > 1, `应切成多块，实际 ${shards.length}`);
  for (const shard of shards) assert.ok(shard.chars <= 700, `单块字数超出预期：${shard.chars}`);
});

check('分片数超 maxShards 时合并到上限且消息一条不丢', () => {
  const messages = [];
  for (let group = 0; group < 6; group += 1) {
    for (let index = 0; index < 5; index += 1) {
      messages.push(msg({ key: `group:${30000 + group}`, ts: NOW - 3600_000 + index * 1000, seq: index + 1 }));
    }
  }
  const shards = planImpressionShards(messages, { maxShards: 3 });
  assert.equal(shards.length, 3);
  const total = shards.reduce((sum, shard) => sum + shard.messageCount, 0);
  assert.equal(total, messages.length);
  for (const shard of shards) {
    assert.ok(shard.id.startsWith(`${shard.key}#${shard.day}#`), `id 形状不对：${shard.id}`);
    assert.equal(shard.messageCount, shard.messages.length);
  }
});

check('分片单人列表去重、按首次出现顺序，textChars 与正文一致', () => {
  const shards = planImpressionShards([
    msg({ seq: 1, userId: '20002', text: '甲说' }),
    msg({ seq: 2, userId: '20001', text: '乙说' }),
    msg({ seq: 3, userId: '20002', text: '甲又说' })
  ]);
  assert.deepEqual(shards[0].people, ['20002', '20001']);
  assert.equal(shards[0].textChars, '甲说'.length + '乙说'.length + '甲又说'.length);
});

check('单条消息按 maxMessageChars 截断，不影响分片稳定', () => {
  const shards = planImpressionShards([msg({ text: '长'.repeat(500) })], { maxMessageChars: 50 });
  assert.equal(shards[0].messages[0].text.length, 50);
});

// ---------------- buildShardPrompt ----------------
check('提示词带会话/日期/每人 QQ 与序号，并要求只输出 JSON 数组', () => {
  const shards = planImpressionShards([msg({ seq: 7, userId: '20001', sender: '阿猫', text: '明天面试' })]);
  const prompt = buildShardPrompt(shards[0]);
  assert.ok(prompt.includes('group:10001'));
  assert.ok(prompt.includes('2026-10-28'));
  assert.ok(prompt.includes('阿猫(20001)'));
  assert.ok(prompt.includes('[group:10001|7]'));
  assert.ok(prompt.includes('明天面试'));
  assert.ok(prompt.includes('只输出一个 JSON 数组'));
  assert.ok(prompt.includes('不要调用任何工具'));
});

check('提示词按 maxMessageChars 截断过长消息', () => {
  const shards = planImpressionShards([msg({ text: '啰'.repeat(400) })], { maxMessageChars: 400 });
  const prompt = buildShardPrompt(shards[0], { maxMessageChars: 40 });
  assert.ok(!prompt.includes('啰'.repeat(41)));
});

// ---------------- validateImpression ----------------
check('validateImpression 正常记录通过并丢弃白名单外字段', () => {
  const result = validateImpression({
    userId: '20001',
    name: ' 阿猫 ',
    impression: '爱聊游戏，常在深夜出没',
    tags: ['游戏', '夜猫子', '游戏'],
    evidence: [{ key: 'group:10001', seq: 7 }],
    evidenceCount: 3,
    evil: '<script>alert(1)</script>'
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.userId, '20001');
  assert.equal(result.value.name, '阿猫');
  assert.deepEqual(result.value.tags, ['游戏', '夜猫子']);
  assert.deepEqual(result.value.evidence, [{ key: 'group:10001', seq: 7 }]);
  assert.equal(result.value.evidenceCount, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(result.value, 'evil'), false);
});

check('validateImpression 拒绝坏 QQ 号/空名字/空印象', () => {
  assert.equal(validateImpression(null).ok, false);
  assert.equal(validateImpression([]).ok, false);
  assert.equal(validateImpression('字符串').ok, false);
  assert.equal(validateImpression({ name: '阿猫', impression: 'x' }).ok, false);
  assert.equal(validateImpression({ userId: 'abc', name: '阿猫', impression: 'x' }).ok, false);
  assert.equal(validateImpression({ userId: '20001', name: '   ', impression: 'x' }).ok, false);
  assert.equal(validateImpression({ userId: '20001', name: '阿猫', impression: '  ' }).ok, false);
});

check('validateImpression 截断超长印象/标签并清洗控制字符', () => {
  const result = validateImpression({
    userId: '20001',
    name: '阿猫',
    impression: `坏\u0000字符${'长'.repeat(300)}`,
    tags: Array.from({ length: 12 }, (_item, index) => `标签${index}`)
  });
  assert.equal(result.ok, true);
  assert.ok(result.value.impression.length <= 200);
  assert.equal(result.value.impression.includes('\u0000'), false);
  assert.ok(result.value.tags.length <= 8);
});

check('validateImpression 证据格式不对时拒绝整条（防伪造引用）', () => {
  assert.equal(validateImpression({ userId: '20001', name: '阿猫', impression: 'x', evidence: 'nope' }).ok, false);
  assert.equal(
    validateImpression({ userId: '20001', name: '阿猫', impression: 'x', evidence: [{ key: 'bad', seq: 'x' }] }).ok,
    false
  );
  const partial = validateImpression({
    userId: '20001',
    name: '阿猫',
    impression: 'x',
    evidence: [{ key: 'group:10001', seq: 2 }, { key: 'bad', seq: 3 }]
  });
  assert.equal(partial.ok, true);
  assert.equal(partial.value.evidence.length, 1);
});

check('validateImpression 缺少 evidenceCount 时按证据数/至少 1 补', () => {
  const withEvidence = validateImpression({ userId: '20001', name: '阿猫', impression: 'x', evidence: [{ key: 'group:10001', seq: 1 }] });
  assert.equal(withEvidence.value.evidenceCount, 1);
  const without = validateImpression({ userId: '20001', name: '阿猫', impression: 'x' });
  assert.equal(without.value.evidenceCount, 1);
});

// ---------------- parseShardResponse ----------------
check('parseShardResponse 能从解释文字 + 代码块里抽出数组', () => {
  const text = `好的，结果如下：\n\`\`\`json\n[{"userId":"20001","name":"阿猫","impression":"爱聊游戏","tags":["游戏"],"evidence":[{"key":"group:10001","seq":7}]}]\n\`\`\`\n以上。`;
  const parsed = parseShardResponse(text);
  assert.equal(parsed.people.length, 1);
  assert.equal(parsed.people[0].userId, '20001');
  assert.equal(parsed.dropped, 0);
});

check('parseShardResponse 丢弃坏元素并计数', () => {
  const text = JSON.stringify([
    { userId: '20001', name: '好', impression: 'ok' },
    { userId: 'not-a-qq', name: '坏', impression: 'bad' },
    { userId: '20002', name: '好2', impression: 'ok2' }
  ]);
  const parsed = parseShardResponse(text);
  assert.equal(parsed.people.length, 2);
  assert.equal(parsed.dropped, 1);
});

check('parseShardResponse 没有数组时返回空结果不崩', () => {
  assert.deepEqual(parseShardResponse('模型今天不想说话'), { people: [], dropped: 0 });
  assert.deepEqual(parseShardResponse(''), { people: [], dropped: 0 });
  assert.deepEqual(parseShardResponse(null), { people: [], dropped: 0 });
});

check('parseShardResponse 只解析前 8000 字符（超长输出不进解析）', () => {
  const item = (index) => ({ userId: String(20000 + index), name: `n${index}`, impression: 'x'.repeat(200) });
  const items = Array.from({ length: 120 }, (_v, index) => item(index));
  const parsed = parseShardResponse(JSON.stringify(items));
  assert.ok(parsed.people.length > 0);
  assert.ok(parsed.people.length < items.length, `应截断，实际解析 ${parsed.people.length}/${items.length}`);
});

// ---------------- mergeImpressions ----------------
check('mergeImpressions 合并同一人的描述：取更长、标签并集、证据数累加', () => {
  const merged = mergeImpressions(
    null,
    [
      { people: [{ userId: '20001', name: '阿猫', impression: '爱聊游戏', tags: ['游戏', '夜猫子'], evidenceCount: 2 }] },
      { people: [{ userId: '20001', name: '阿猫2', impression: '爱聊游戏也爱聊动漫，常在深夜出没', tags: ['动漫'], evidenceCount: 3 }] }
    ],
    { now: NOW }
  );
  assert.equal(merged.stats.kept, 1);
  const person = merged.people['20001'];
  assert.equal(person.name, '阿猫2');
  assert.ok(person.impression.includes('动漫'));
  assert.deepEqual(person.tags, ['游戏', '夜猫子', '动漫']);
  assert.equal(person.evidenceCount, 5);
  assert.equal(person.updatedAt, NOW);
});

check('mergeImpressions 保留上一轮结果并继续累加证据数', () => {
  const prev = {
    version: 1,
    people: {
      '20001': { userId: '20001', name: '阿猫', impression: '老印象', tags: ['旧'], evidenceCount: 4, updatedAt: 1 }
    }
  };
  const merged = mergeImpressions(prev, [{ people: [{ userId: '20001', name: '阿猫', impression: '老印象', tags: ['新'], evidenceCount: 2 }] }]);
  assert.equal(merged.people['20001'].evidenceCount, 6);
  assert.deepEqual(merged.people['20001'].tags, ['旧', '新']);
  assert.ok(Number.isFinite(merged.people['20001'].updatedAt));
});

check('mergeImpressions 保留证据锚点：去重、每人最多 6 条', () => {
  const item = (seq) => ({ key: 'group:10001', seq: String(seq) });
  const merged = mergeImpressions(null, [
    { people: [{ userId: '20002', name: '阿狗', impression: '爱发表情', tags: [], evidenceCount: 2, evidence: [item(1), item(2)] }] },
    { people: [{ userId: '20002', name: '阿狗', impression: '爱发表情', tags: [], evidenceCount: 2, evidence: [item(2), item(3), item(4), item(5), item(6), item(7), item(8)] }] }
  ], { now: NOW });
  const person = merged.people['20002'];
  assert.equal(person.evidenceCount, 4);
  // 第 2 条在前一轮已记过，不重复；上限 6 条。
  assert.ok(person.evidence.length <= 6);
  assert.equal(person.evidence[0].seq, 1);
  assert.equal(new Set(person.evidence.map((e) => e.seq)).size, person.evidence.length);
});

check('mergeImpressions 上一轮的证据锚点会带下去', () => {
  const prev = { version: 1, people: { '20003': { userId: '20003', name: '阿喵', impression: '旧', tags: [], evidenceCount: 1, evidence: [{ key: 'group:10001', seq: 9 }], updatedAt: 1 } } };
  const merged = mergeImpressions(prev, [{ people: [{ userId: '20003', name: '阿喵', impression: '新的一段更长的描述', tags: [], evidenceCount: 2, evidence: [{ key: 'group:10001', seq: 10 }] }] }]);
  const person = merged.people['20003'];
  assert.deepEqual(person.evidence.map((e) => e.seq), [9, 10]);
  assert.equal(person.evidenceCount, 3);
});

check('mergeImpressions 丢弃坏分片与坏条目并计数', () => {
  const merged = mergeImpressions(null, [
    '不是分片',
    { people: [{ userId: 'abc', name: '坏', impression: 'x' }] },
    { people: [{ userId: '20003', name: '好人', impression: 'ok' }] }
  ]);
  assert.equal(merged.stats.kept, 1);
  assert.equal(merged.stats.dropped, 2);
  assert.deepEqual(Object.keys(merged.people), ['20003']);
});

check('mergeImpressions 按 QQ 数字升序输出并截断印象长度', () => {
  const merged = mergeImpressions(
    null,
    [
      { people: [{ userId: '30001', name: 'c', impression: '长'.repeat(300), tags: ['t1', 't2', 't3', 't4', 't5', 't6'] }] },
      { people: [{ userId: '20001', name: 'a', impression: 'a' }] },
      { people: [{ userId: '25001', name: 'b', impression: 'b' }] }
    ],
    { maxChars: 120, maxTags: 5 }
  );
  assert.deepEqual(Object.keys(merged.people), ['20001', '25001', '30001']);
  assert.equal(merged.people['30001'].impression.length, 120);
  assert.equal(merged.people['30001'].tags.length, 5);
});

// ---------------- estimateBudget ----------------
check('estimateBudget 随输入增长且 costHint 带 token 与价格', () => {
  const small = estimateBudget({ inputChars: 1000, people: 2 });
  const large = estimateBudget({ inputChars: 100000, people: 2 });
  assert.ok(large.estInputTokens > small.estInputTokens);
  assert.ok(large.estCostCny > small.estCostCny);
  assert.ok(small.costHint.includes('token'));
  assert.ok(small.costHint.includes('¥'));
  assert.ok(small.costHint.includes('高峰 ×2'));
});

check('estimateBudget 非法/缺省输入不产生 NaN', () => {
  const budget = estimateBudget({});
  assert.equal(budget.inputChars, 0);
  assert.ok(Number.isFinite(budget.estInputTokens));
  assert.ok(Number.isFinite(budget.estCostCny));
});

// ---------------- buildImpressions ----------------
const TWO_SHARD_MESSAGES = [
  ...Array.from({ length: 3 }, (_v, index) => msg({ ts: NOW - 3600_000 + index * 1000, seq: index + 1 })),
  ...Array.from({ length: 2 }, (_v, index) =>
    msg({ key: 'group:10002', ts: NOW - 7200_000 + index * 1000, seq: index + 1, userId: '20002', sender: '阿狗' })
  )
];

await checkAsync('buildImpressions 默认 dry-run：不调模型、不写盘', async () => {
  let called = 0;
  let wrote = 0;
  const result = await buildImpressions({
    messages: TWO_SHARD_MESSAGES,
    now: NOW,
    caller: async () => {
      called += 1;
      return '[]';
    },
    write: () => {
      wrote += 1;
    }
  });
  assert.equal(result.mode, 'dry-run');
  assert.equal(called, 0);
  assert.equal(wrote, 0);
  assert.equal(result.stats.shards, 2);
  assert.equal(result.stats.messages, 5);
  assert.ok(result.stats.budget.costHint.length > 0);
});

await checkAsync('buildImpressions apply：假 caller 跑通并按分片合并、写盘一次', async () => {
  let wrote = null;
  const calls = [];
  const result = await buildImpressions({
    messages: TWO_SHARD_MESSAGES,
    now: NOW,
    apply: true,
    caller: async (shard) => {
      calls.push(shard.id);
      return JSON.stringify([
        { userId: shard.people[0], name: '某人', impression: `来自 ${shard.id} 的印象`, tags: ['标签'], evidence: [{ key: shard.key, seq: shard.messages[0].seq }] }
      ]);
    },
    write: (state) => {
      wrote = state;
    },
    log: () => {}
  });
  assert.equal(result.mode, 'apply');
  assert.equal(calls.length, 2);
  assert.equal(result.stats.failed, 0);
  assert.equal(result.stats.wrote, true);
  assert.equal(result.stats.steps, 1);
  assert.equal(wrote.version, 1);
  assert.equal(wrote.people['20001'].impression.includes('group:10001'), true);
  assert.equal(wrote.people['20002'].impression.includes('group:10002'), true);
  assert.equal(wrote.meta.shards, 2);
  assert.equal(wrote.meta.kept, 2);
  assert.equal(wrote.meta.dropped, 0);
  assert.ok(wrote.meta.costHint.length > 0);
});

await checkAsync('buildImpressions 失败只重跑该分片，成功后 steps=2 且无失败', async () => {
  const attempts = new Map();
  const result = await buildImpressions({
    messages: TWO_SHARD_MESSAGES,
    now: NOW,
    apply: true,
    caller: async (shard) => {
      const count = (attempts.get(shard.id) ?? 0) + 1;
      attempts.set(shard.id, count);
      if (shard.id === 'group:10002#2026-10-28#1' && count === 1) throw new Error('模拟超时');
      return JSON.stringify([{ userId: shard.people[0], name: '某人', impression: 'ok', tags: [], evidence: [] }]);
    },
    write: () => {},
    log: () => {}
  });
  assert.equal(result.stats.steps, 2);
  assert.equal(result.stats.failed, 0);
  assert.deepEqual([...attempts.values()].sort(), [1, 2]);
});

await checkAsync('buildImpressions 总步数上限生效：一直失败就停在 maxSteps 且 failed 计数正确', async () => {
  const result = await buildImpressions({
    messages: TWO_SHARD_MESSAGES,
    now: NOW,
    apply: true,
    maxSteps: 2,
    caller: async () => {
      throw new Error('一直失败');
    },
    write: () => {},
    log: () => {}
  });
  assert.equal(result.stats.steps, 2);
  assert.equal(result.stats.failed, 2);
  assert.equal(result.state.meta.shards, 2);
  assert.deepEqual(result.state.people, {});
});

await checkAsync('buildImpressions 不传 write 时写了也不落盘（wrote=false）', async () => {
  const result = await buildImpressions({
    messages: TWO_SHARD_MESSAGES,
    now: NOW,
    apply: true,
    caller: async (shard) =>
      JSON.stringify([{ userId: shard.people[0], name: '某人', impression: 'ok', tags: [], evidence: [] }]),
    log: () => {}
  });
  assert.equal(result.stats.wrote, false);
  assert.equal(result.state.meta.kept, 2);
});

await checkAsync('buildImpressions 模型输出空数组会重跑，但不会写进空印象', async () => {
  const result = await buildImpressions({
    messages: TWO_SHARD_MESSAGES,
    now: NOW,
    apply: true,
    maxSteps: 2,
    caller: async () => '[]',
    write: () => {},
    log: () => {}
  });
  assert.equal(result.stats.steps, 2);
  assert.equal(result.stats.failed, 2);
  assert.deepEqual(result.state.people, {});
});

await checkAsync('buildImpressions 空消息列表也能跑完（0 分片）', async () => {
  const result = await buildImpressions({ messages: [], now: NOW, apply: true, caller: async () => '[]', write: () => {}, log: () => {} });
  assert.equal(result.stats.shards, 0);
  assert.deepEqual(result.state.people, {});
});

console.log('');
if (failed > 0) {
  console.error(`❌ ${failed} 项失败（通过 ${passed} 项）`);
  process.exit(1);
}
console.log(`🎉 test-impressions 全部通过（${passed} 项）`);
