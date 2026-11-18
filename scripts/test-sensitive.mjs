// 敏感信息规则测试：确保「拦路径/凭据」但不误伤正常聊天。
import assert from 'node:assert/strict';
import { SENSITIVE_RE, describeSensitiveMatch, hasSensitiveContent } from '../src/sensitive.js';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('✅ ' + name); } catch (e) { failed += 1; console.error('❌ ' + name + ' — ' + (e?.message ?? e)); }
}

check('Windows 路径命中，且摘要打码', () => {
  const r = describeSensitiveMatch('日志在 E:\\deepseek-harness\\qq-bridge-src\\state\\bridge.log');
  assert.equal(r?.name, 'windows-path');
  assert.ok(r.excerpt.includes('***'));
  assert.ok(!r.excerpt.includes('deepseek-harness'));
});

check('Unix / UNC 路径命中', () => {
  assert.equal(describeSensitiveMatch('/home/user/.ssh/id_rsa')?.name, 'unix-path');
  assert.equal(describeSensitiveMatch('\\\\server\\share\\a.txt')?.name, 'unc-path');
});

check('凭据赋值命中；普通提到 token 不误伤', () => {
  assert.equal(describeSensitiveMatch('token 是 abc123xyz')?.name, 'credential');
  assert.equal(describeSensitiveMatch('密码：123456')?.name, 'credential');
  assert.equal(hasSensitiveContent('那榜是按 token 吨位算的'), false);
  assert.equal(hasSensitiveContent('这个话题很有 token 感'), false);
});

check('正常聊天不命中', () => {
  for (const s of ['今天天气不错', '你好呀', '在吗在吗', '我给你讲个冷笑话', 'E 盘满了']) {
    assert.equal(hasSensitiveContent(s), false, s);
  }
});

check('SENSITIVE_RE 与 describeSensitiveMatch 结论一致', () => {
  for (const s of ['C:/Users/PC/a.txt', 'token=abcdef', '普通一句话', '/etc/passwd']) {
    assert.equal(SENSITIVE_RE.test(s), describeSensitiveMatch(s) !== null, s);
  }
});

console.log(failed ? `\n❌ ${failed} 项失败` : '\n🎉 test-sensitive 全部通过（5 项）');
process.exit(failed ? 1 : 0);
