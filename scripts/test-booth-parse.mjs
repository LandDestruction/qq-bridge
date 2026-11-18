// BOOTH 文件名解析单测（纯函数，不联网）。
import assert from 'node:assert/strict';
import { parseBoothName } from '../src/booth-meta.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { fail += 1; console.error(`  FAIL ${name}: ${error?.message ?? error}`); }
}

console.log('[1] 用户给的真实例子');
check('`9038753奥の手 -OkunoTe-【愛莉・ミルティナ専用】`', () => {
  const out = parseBoothName('9038753奥の手 -OkunoTe-【愛莉・ミルティナ専用】');
  assert.deepEqual(out, { boothId: '9038753', productName: '奥の手 -OkunoTe-【愛莉・ミルティナ専用】' });
});

console.log('[2] 分隔符');
for (const [input, expected] of [
  ['9038753-name', 'name'],
  ['9038753_name', 'name'],
  ['9038753 【name】', 'name】'],
  ['9038753【name】', 'name】'],
  ['9038753（name）', 'name）'],
  ['  9038753  name  ', 'name']
]) {
  check(`\`${input}\` → productName=${JSON.stringify(expected)}`, () => {
    const out = parseBoothName(input);
    assert.equal(out.boothId, '9038753');
    assert.equal(out.productName, expected);
  });
}

console.log('[3] 反例陷阱（必须是 null）');
for (const input of [
  'R-18 版.zip',
  'v1.2.zip',
  '2024.zip',
  '1234.zip',
  '1234567890.zip',
  '20240101.zip',
  '20241301.zip',
  'abc9038753.zip',
  '.hidden.zip',
  ''
]) {
  check(`\`${input}\` → boothId=null`, () => {
    assert.equal(parseBoothName(input).boothId, null);
  });
}

console.log('[4] 只有编号没有商品名');
check('`9038753.zip` → productName=`.zip`（点不在分隔符里；调用方会用文件名兜底目录名）', () => {
  const out = parseBoothName('9038753.zip');
  assert.equal(out.boothId, '9038753');
  assert.equal(out.productName, '.zip');
});
check('`9038753` → productName 空串', () => {
  assert.deepEqual(parseBoothName('9038753'), { boothId: '9038753', productName: '' });
});

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
