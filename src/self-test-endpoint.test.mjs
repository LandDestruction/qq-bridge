// 脱网单测：自测端点解析 + 连接失败分类。
// 跑法：node src/self-test-endpoint.test.mjs
// 刻意不联网、不读线上 state/，只覆盖纯逻辑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeBaseUrl,
  resolveSelfTestBaseUrl,
  readConfigDshBaseUrl,
  describeConnectFailure
} from './self-test-endpoint.js';

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}\n       got ${JSON.stringify(actual)}\n       want ${JSON.stringify(expected)}`);
  }
}

function ok(cond, label) {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}`);
  }
}

console.log('[1] normalizeBaseUrl');
eq(normalizeBaseUrl('http://127.0.0.1:12175'), 'http://127.0.0.1:12175', '原样保留');
eq(normalizeBaseUrl('http://127.0.0.1:12175/'), 'http://127.0.0.1:12175', '去掉尾部斜杠');
eq(normalizeBaseUrl('  http://127.0.0.1:12175//  '), 'http://127.0.0.1:12175', '去空白+多重斜杠');
eq(normalizeBaseUrl('https://example.test/dsh/'), 'https://example.test/dsh', '保留路径');
eq(normalizeBaseUrl(''), null, '空串 → null');
eq(normalizeBaseUrl('   '), null, '纯空白 → null');
eq(normalizeBaseUrl('127.0.0.1:12175'), null, '缺协议 → null');
eq(normalizeBaseUrl('ftp://example.test'), null, '非 http(s) → null');
eq(normalizeBaseUrl(undefined), null, 'undefined → null');

console.log('[2] resolveSelfTestBaseUrl 优先级');
eq(
  resolveSelfTestBaseUrl({ argvBase: 'http://a:1', envBase: 'http://b:2', configBase: 'http://c:3' }),
  { url: 'http://a:1', source: 'argv' },
  'argv 最高优先'
);
eq(
  resolveSelfTestBaseUrl({ envBase: 'http://b:2', configBase: 'http://c:3' }),
  { url: 'http://b:2', source: 'env' },
  '无 argv 时用 env'
);
eq(
  resolveSelfTestBaseUrl({ configBase: 'http://c:3/' }),
  { url: 'http://c:3', source: 'config' },
  '无 argv/env 时用 config（并归一化）'
);
eq(
  resolveSelfTestBaseUrl({ argvBase: 'not-a-url', configBase: 'http://c:3' }),
  { url: 'http://c:3', source: 'config' },
  'argv 非法时回落到 config'
);
eq(resolveSelfTestBaseUrl({}), { url: null, source: 'none' }, '什么都没有 → null/ none');
eq(resolveSelfTestBaseUrl(), { url: null, source: 'none' }, '无参调用 → null/ none');

console.log('[3] readConfigDshBaseUrl');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-test-endpoint-'));
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ dsh: { baseUrl: 'http://127.0.0.1:12175' } }), 'utf8');
eq(readConfigDshBaseUrl(tmp), 'http://127.0.0.1:12175', '读到 dsh.baseUrl');

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'self-test-endpoint-empty-'));
eq(readConfigDshBaseUrl(empty), null, '没有 config.json → null');

const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'self-test-endpoint-bad-'));
fs.writeFileSync(path.join(bad, 'config.json'), '{ this is not json', 'utf8');
eq(readConfigDshBaseUrl(bad), null, 'JSON 坏了 → null（不抛）');

console.log('[4] describeConnectFailure 分类');
const url = 'http://127.0.0.1:12175';
const refused = new Error('fetch failed');
refused.cause = { code: 'ECONNREFUSED' };
ok(describeConnectFailure(refused, url).includes('连接被拒'), 'ECONNREFUSED → 连接被拒');
ok(describeConnectFailure(refused, url).includes(url), '报错里带上目标地址');

const dns = new Error('fetch failed');
dns.cause = { code: 'ENOTFOUND' };
ok(describeConnectFailure(dns, url).includes('域名解析失败'), 'ENOTFOUND → 域名解析失败');

const timeout = new Error('The operation was aborted due to timeout');
timeout.name = 'TimeoutError';
ok(describeConnectFailure(timeout, url).includes('超时'), 'TimeoutError → 超时');

ok(describeConnectFailure(new Error('settings.describe failed: unauthorized: 401'), url).includes('401'), '401 → 鉴权失败');
ok(describeConnectFailure(new Error('HTTP 403 forbidden'), url).includes('403'), '403 → 被拒绝');
ok(describeConnectFailure(new Error('HTTP 404 not found'), url).includes('404'), '404 → 路径不存在');
ok(describeConnectFailure(new Error('invalid server-response for settings/describe'), url).includes('不像 DSH'), '非 DSH 响应 → 提示端口指错');
const odd = describeConnectFailure(new Error('something weird'), url);
ok(odd.includes('something weird') && odd.includes(url), '未知错误保留原文+地址');
ok(describeConnectFailure(new Error('x'), null).includes('未确定'), '没有 url 时也说明未确定');

console.log('');
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
