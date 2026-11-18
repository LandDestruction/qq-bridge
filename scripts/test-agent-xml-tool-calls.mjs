import assert from 'node:assert/strict';
import { parseXmlToolCalls, textWithoutXmlToolCalls } from '../src/agent/xml-tool-calls.js';

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (error) { fail += 1; console.log(`  ✗ ${name} — ${error.message}`); }
}

const single = `看看消息。<tool_call>
<function=qq_get_unread_messages>
<parameter=key>group:100000001</parameter>
</function>
</tool_call>`;

check('单条 XML 调用解析出函数名与参数', () => {
  const calls = parseXmlToolCalls(single);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'qq_get_unread_messages');
  assert.equal(calls[0].args.key, 'group:100000001');
});

check('数字/布尔参数会被转成真类型', () => {
  const calls = parseXmlToolCalls('<function=x><parameter=n>3</parameter><parameter=b>true</parameter></function>');
  assert.equal(calls[0].args.n, 3);
  assert.equal(calls[0].args.b, true);
});

check('JSON 参数解析成对象', () => {
  const calls = parseXmlToolCalls('<function=x><parameter=opts>{"a":1}</parameter></function>');
  assert.deepEqual(calls[0].args.opts, { a: 1 });
});

check('多个函数块都解析出来', () => {
  const calls = parseXmlToolCalls('<function=a><parameter=k>1</parameter></function><function=b><parameter=k>2</parameter></function>');
  assert.deepEqual(calls.map((call) => call.name), ['a', 'b']);
  assert.equal(calls[1].args.k, 2);
});

check('纯文本返回空数组', () => {
  assert.deepEqual(parseXmlToolCalls('今天天气不错'), []);
});

check('非字符串返回空数组', () => {
  assert.deepEqual(parseXmlToolCalls(null), []);
  assert.deepEqual(parseXmlToolCalls(42), []);
});

check('空参数也能解析', () => {
  const calls = parseXmlToolCalls('<function=qq_status></function>');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, {});
});

check('剥掉 XML 后只剩正文', () => {
  assert.equal(textWithoutXmlToolCalls(single), '看看消息。');
});

check('只有 XML 时剥完为空', () => {
  assert.equal(textWithoutXmlToolCalls(single.replace('看看消息。', '')), '');
});

check('未闭合的调用也能剥干净', () => {
  const text = textWithoutXmlToolCalls('先看看。<tool_call>\n<function=qq_get_recent_messages>\n<parameter=key>group:1');
  assert.equal(text, '先看看。');
});

check('普通文本不受影响', () => {
  assert.equal(textWithoutXmlToolCalls('在呢，怎么了？'), '在呢，怎么了？');
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
