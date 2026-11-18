// /api/socialV2/draw 的契约测试：锁住后端接受什么、回什么，不打真实出图源。
// （旧控制台页内的出图面板已随 public/console.html 一起下线，前端侧的断言随之移除。）
// 后端校验以 src/bridge.js:7637 为准：tier 必填、只认小写 'free' / 'high'，其它一律 400。
import assert from 'node:assert/strict';
import { startConsoleFixture } from './console-ui-fixture.mjs';

const results = [];
const check = (label, fn) => {
  try { fn(); results.push('OK   ' + label); }
  catch (e) { results.push('FAIL ' + label + ' — ' + e.message); process.exitCode = 1; }
};

const fixture = await startConsoleFixture({ port: 0 });
const post = async (body, headers = { 'content-type': 'application/json', 'x-agent-token': 'fixture-token' }) => {
  const res = await fetch(fixture.url + '/api/socialV2/draw', { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  return { status: res.status, text, data };
};
const base = { key: 'group:123456789', prompt: '一只打伞的鲸鱼' };

// ① 不带 tier → 400，且错误文案里有 "tier"
{
  const r = await post(base);
  console.log(`[缺 tier] ${r.status} ${r.data && r.data.error}`);
  check('不带 tier → 400', () => assert.equal(r.status, 400));
  check('错误文案里含 "tier"（前端可据此提示用户先选档）', () => assert.match(String(r.data && r.data.error), /tier/));
}

// ② 非法值（大小写敏感、空串、近似值）全部 400
for (const bad of ['auto', '', 'FREE', 'High', 'free ', ' high ', 'freebie', '1']) {
  const r = await post({ ...base, tier: bad });
  console.log(`[tier=${JSON.stringify(bad)}] ${r.status}`);
  // 注意：后端会 String(...).trim()，所以 ' free ' / ' high ' 属于合法值，这里单独处理
  const trimmed = String(bad).trim();
  if (trimmed === 'free' || trimmed === 'high') {
    check(`tier=${JSON.stringify(bad)} → trim 后合法，应 200`, () => assert.equal(r.status, 200));
  } else {
    check(`tier=${JSON.stringify(bad)} → 400（不放过近似值）`, () => {
      assert.equal(r.status, 400);
      assert.match(String(r.data && r.data.error), /tier/);
    });
  }
}

// ③ 合法值走对应分支 + 返回体字段类型
{
  const free = await post({ ...base, tier: 'free' });
  console.log(`[free] ${free.status} ${JSON.stringify(free.data)}`);
  check('tier=free → 200，回 tier=free', () => {
    assert.equal(free.status, 200);
    assert.equal(free.data.tier, 'free');
  });
  check('free → charged=false、watermarked=true', () => {
    assert.equal(free.data.charged, false);
    assert.equal(free.data.watermarked, true);
  });
  check('free → quota=null', () => assert.equal(free.data.quota, null));
  check('free → url 是可内嵌的 data: url', () => assert.match(String(free.data.url), /^data:image\//));
  check('free → 仍带 key / messageId / sent', () => {
    assert.equal(free.data.key, 'group:123456789');
    assert.equal(free.data.messageId, 9001);
    assert.equal(free.data.sent, 1);
  });

  const high = await post({ ...base, tier: 'high' });
  console.log(`[high] ${high.status} ${JSON.stringify(high.data)}`);
  check('tier=high → 200，回 tier=high', () => {
    assert.equal(high.status, 200);
    assert.equal(high.data.tier, 'high');
  });
  check('high → charged=true、watermarked=false', () => {
    assert.equal(high.data.charged, true);
    assert.equal(high.data.watermarked, false);
  });
  check('high → quota 是对象且 used/limit/remaining 都是数字', () => {
    const q = high.data.quota;
    assert.ok(q && typeof q === 'object', 'quota 应为对象');
    for (const k of ['used', 'limit', 'remaining']) assert.equal(typeof q[k], 'number', `quota.${k} 应为 number`);
  });
}

// ④ 四个「给面板用」的字段：类型必须对（若出现）
{
  const { data } = await post({ ...base, tier: 'free' });
  check('若返回 tier → 必须是 free/high 之一', () => {
    if (data.tier !== undefined) assert.ok(['free', 'high'].includes(data.tier), String(data.tier));
  });
  check('若返回 charged → 必须是 boolean', () => {
    if (data.charged !== undefined) assert.equal(typeof data.charged, 'boolean');
  });
  check('若返回 watermarked → 必须是 boolean', () => {
    if (data.watermarked !== undefined) assert.equal(typeof data.watermarked, 'boolean');
  });
  check('若返回 quota → null 或 {used,limit,remaining} 全是数字', () => {
    if (data.quota !== undefined && data.quota !== null) {
      for (const k of ['used', 'limit', 'remaining']) assert.equal(typeof data.quota[k], 'number', `quota.${k}`);
    }
  });
}

// ④b 老版本返回体（连 tier 都不回）也不能让契约测试炸：字段缺失即跳过
{
  await fetch(fixture.url + '/__fixture/draw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'legacy' }) });
  const r = await post({ ...base, tier: 'free' });
  console.log(`[legacy 形状] ${r.status} ${JSON.stringify(r.data)}`);
  check('老版本返回体（无 tier/charged/watermarked/quota）仍 200，前端自己做缺省', () => {
    assert.equal(r.status, 200);
    assert.equal(r.data.tier, undefined);
  });
  await fetch(fixture.url + '/__fixture/draw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'ok' }) });
}

await fixture.close();
console.log('\n' + results.join('\n'));
console.log(process.exitCode ? '\n有分支不符合预期' : '\n缺 tier / 非法值 / 两个合法档 / 字段类型，全部符合预期');
