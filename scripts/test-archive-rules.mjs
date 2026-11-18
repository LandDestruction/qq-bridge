#!/usr/bin/env node
// 转存口径规则（src/file-archive/rules.js）的纯单测：不连桥接、不读 config.json、不碰数据库。
//
// 重点守两件事：
//   1) 用户不配 rules 时，判定结果必须与改造前的老口径逐项一致（图片+压缩包收、别的拒、表情包拒）；
//   2) 非法配置只能回落默认，绝不能抛异常——配置是用户手改的，笔误不该让桥接启动即崩。
import assert from 'node:assert/strict';
import { ARCHIVE_EXTENSIONS, IMAGE_EXTENSIONS, MAX_FILE_MB } from '../src/file-archive/common.js';
import { shouldArchiveAttachment, normalizeFileArchiveConfig } from '../src/file-archive/storage.js';
import {
  ARCHIVE_RULE_EXTENSIONS,
  DEFAULT_ARCHIVE_RULES,
  normalizeArchiveRules,
  matchArchiveRules,
  describeArchiveRules
} from '../src/file-archive/rules.js';

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${error?.message ?? error}`);
  }
}

const KB = 1024;
const MB = 1024 * 1024;

check('ARCHIVE_RULE_EXTENSIONS 由 common 的压缩包+图片派生，共 16 类', () => {
  assert.equal(ARCHIVE_RULE_EXTENSIONS.length, ARCHIVE_EXTENSIONS.length + IMAGE_EXTENSIONS.length);
  for (const ext of [...ARCHIVE_EXTENSIONS, ...IMAGE_EXTENSIONS]) assert.ok(ARCHIVE_RULE_EXTENSIONS.includes(ext), ext);
  assert.ok(Object.isFrozen(ARCHIVE_RULE_EXTENSIONS));
});

check('默认规则 = 老口径：图片与压缩包收，其他类型拒', () => {
  const rules = normalizeArchiveRules(undefined);
  assert.deepEqual(rules.extensions, [...ARCHIVE_RULE_EXTENSIONS]);
  assert.deepEqual(rules.excludeExtensions, []);
  assert.equal(rules.minKb, 0);
  assert.equal(rules.maxMb, MAX_FILE_MB);
  assert.deepEqual(rules.includeKeywords, []);
  assert.deepEqual(rules.excludeKeywords, []);
  assert.equal(rules.senderMode, 'any');
  assert.deepEqual(rules.senders, []);
  assert.equal(rules.perHourMax, 0);
  // 逐个类型对一遍：默认配置下这 16 类必须全部放行。
  for (const ext of ARCHIVE_RULE_EXTENSIONS) {
    assert.equal(matchArchiveRules(rules, { fileName: `a.${ext}` }).ok, true, ext);
  }
  for (const ext of ['exe', 'mp4', 'txt', 'pdf', 'apk', 'iso']) {
    const verdict = matchArchiveRules(rules, { fileName: `a.${ext}` });
    assert.equal(verdict.ok, false, ext);
    assert.equal(verdict.reason, `类型不在转存白名单（.${ext}）`);
  }
});

check('默认口径下表情包仍由 shouldArchiveAttachment 拒（规则层不接管）', () => {
  // 规则的默认白名单里确实有 png/jpg，所以「表情包不转」只能由老的 shouldArchiveAttachment 保证；
  // 这里锁死这个分工，防止以后有人把表情判断挪进 rules 又把 kind 判断删了。
  assert.equal(shouldArchiveAttachment({ kind: 'mface', segType: 'mface', fileName: 'a.png' }), false);
  assert.equal(shouldArchiveAttachment({ kind: 'sticker', segType: 'image', fileName: 'a.png' }), false);
  assert.equal(shouldArchiveAttachment({ kind: 'face', segType: 'face', fileName: '' }), false);
  // 真·图片段（没带 emojiId/subType 表情标记）才是「图片」该转的那一类。
  assert.equal(shouldArchiveAttachment({ kind: 'image', segType: 'image', fileName: 'a.png' }), true);
  assert.equal(shouldArchiveAttachment({ kind: 'image', segType: 'image', fileName: 'a.png', emojiId: '1' }), false);
  assert.equal(shouldArchiveAttachment({ kind: 'image', segType: 'image', fileName: 'a.png', subType: '1' }), false);
  assert.equal(shouldArchiveAttachment({ kind: 'file', segType: 'file', fileName: 'a.zip' }), true);
});

check('扩展名白名单：用户只配 pdf 时 zip 不再放行', () => {
  const rules = { extensions: ['pdf', '.PDF'] };
  assert.equal(matchArchiveRules(rules, { fileName: 'a.pdf' }).ok, true);
  const zipVerdict = matchArchiveRules(rules, { fileName: 'a.zip' });
  assert.equal(zipVerdict.ok, false);
  assert.equal(zipVerdict.reason, '类型不在转存白名单（.zip）');
  // normalize 后的扩展名必须是「小写无点」，否则界面回填会两副样子。
  assert.deepEqual(normalizeArchiveRules(rules).extensions, ['pdf']);
});

check('扩展名白名单显式空数组 = fail-closed（谁都不收），不能悄悄填回默认', () => {
  assert.deepEqual(normalizeArchiveRules({ extensions: [] }).extensions, []);
  const verdict = matchArchiveRules({ extensions: [] }, { fileName: 'a.zip' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, '类型不在转存白名单（.zip）');
});

check('扩展名黑名单：命中先于关键词/体积判定', () => {
  const rules = { excludeExtensions: ['zip'] };
  const verdict = matchArchiveRules(rules, { fileName: 'a.zip', bytes: 1 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, '扩展名在黑名单（.zip）');
  assert.equal(matchArchiveRules(rules, { fileName: 'a.jpg' }).ok, true);
});

check('无扩展名 fail-closed', () => {
  const verdict = matchArchiveRules(normalizeArchiveRules(undefined), { fileName: 'README' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, '类型不在转存白名单（无扩展名）');
});

check('必需关键词：文件名（含扩展名）不区分大小写匹配', () => {
  const rules = { includeKeywords: ['Report', '月报'] };
  assert.equal(matchArchiveRules(rules, { fileName: '2026-Q3-REPORT.zip' }).ok, true);
  assert.equal(matchArchiveRules(rules, { fileName: '月报-0921.zip' }).ok, true);
  const verdict = matchArchiveRules(rules, { fileName: 'a.zip' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, '文件名不含必需关键词');
});

check('排除关键词：命中即拒，原因里带原始关键词', () => {
  const rules = { excludeKeywords: ['临时', 'tmp'] };
  const verdict = matchArchiveRules(rules, { fileName: '备份-TMP-1.zip' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, '文件名含排除关键词「tmp」');
  assert.equal(matchArchiveRules(rules, { fileName: '备份-正式.zip' }).ok, true);
});

check('体积下限：小于 minKb 拒，等于边界放行', () => {
  const rules = { minKb: 10 };
  assert.equal(matchArchiveRules(rules, { fileName: 'a.zip', bytes: 5 * KB }).reason, '文件小于 10 KB');
  assert.equal(matchArchiveRules(rules, { fileName: 'a.zip', bytes: 10 * KB }).ok, true);
  assert.equal(matchArchiveRules(rules, { fileName: 'a.zip', bytes: 0 }).reason, '文件小于 10 KB');
});

check('体积上限：超过 maxMb 拒，等于边界放行，未知体积不拦', () => {
  const rules = { maxMb: 1 };
  assert.equal(matchArchiveRules(rules, { fileName: 'a.zip', bytes: 2 * MB }).reason, '文件超过 1 MB');
  assert.equal(matchArchiveRules(rules, { fileName: 'a.zip', bytes: 1 * MB }).ok, true);
  // 图片段拿不到 size 时必须放行，否则所有聊天图片都会被 maxMb 误杀。
  assert.equal(matchArchiveRules(rules, { fileName: 'a.jpg' }).ok, true);
  assert.equal(matchArchiveRules(rules, { fileName: 'a.jpg', bytes: undefined }).ok, true);
});

check('senderMode=any：名单为空/有值都不影响', () => {
  const rules = { senderMode: 'any', senders: ['10001'] };
  assert.equal(matchArchiveRules(rules, { fileName: 'a.zip', senderId: '10001' }).ok, true);
  assert.equal(matchArchiveRules(rules, { fileName: 'a.zip', senderId: '20002' }).ok, true);
});

check('senderMode=include：名单内放行，名单外拒，空 senderId 按不限放行', () => {
  const rules = { senderMode: 'include', senders: ['10001', '10002'] };
  assert.equal(matchArchiveRules(rules, { fileName: 'a.zip', senderId: '10001' }).ok, true);
  const verdict = matchArchiveRules(rules, { fileName: 'a.zip', senderId: '20002' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, '发送者不在允许名单');
  assert.equal(matchArchiveRules(rules, { fileName: 'a.zip', senderId: '' }).ok, true);
  assert.equal(matchArchiveRules(rules, { fileName: 'a.zip' }).ok, true);
});

check('senderMode=exclude：名单内拒，名单外放行', () => {
  const rules = { senderMode: 'exclude', senders: [10003] };
  const verdict = matchArchiveRules(rules, { fileName: 'a.zip', senderId: '10003' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, '发送者在排除名单');
  assert.equal(matchArchiveRules(rules, { fileName: 'a.zip', senderId: '10004' }).ok, true);
  assert.equal(matchArchiveRules(rules, { fileName: 'a.zip', senderId: '' }).ok, true);
});

check('名单元素统一成字符串数字（兼容旧配置里写数字）', () => {
  const rules = normalizeArchiveRules({ senderMode: 'include', senders: [10001, ' 10002 ', 'abc', ''] });
  assert.deepEqual(rules.senders, ['10001', '10002']);
});

check('perHourMax 不参与纯函数判定（要查台账，留给 runtime）', () => {
  const rules = { perHourMax: 1 };
  assert.equal(normalizeArchiveRules(rules).perHourMax, 1);
  assert.equal(matchArchiveRules(rules, { fileName: 'a.zip', bytes: 1 }).ok, true);
});

check('非法配置一律回落默认，绝不抛异常', () => {
  const weird = [
    null, undefined, 42, 'nope', [], () => {},
    { extensions: 'zip', excludeExtensions: 'rar', senderMode: 'bogus', senders: '10001' },
    { minKb: -1, maxMb: -5, perHourMax: NaN },
    { minKb: '2', maxMb: '3', perHourMax: '4' },
    { includeKeywords: 'abc', excludeKeywords: 3 },
    { extensions: ['', '.', '....', 'a'.repeat(13), 123, 'TAR'] }
  ];
  for (const raw of weird) {
    const rules = normalizeArchiveRules(raw);
    assert.equal(typeof rules, 'object');
    assert.ok(Array.isArray(rules.extensions));
    assert.ok(Array.isArray(rules.excludeExtensions));
    assert.ok(Array.isArray(rules.includeKeywords));
    assert.ok(Array.isArray(rules.excludeKeywords));
    assert.ok(Array.isArray(rules.senders));
    assert.ok(['any', 'include', 'exclude'].includes(rules.senderMode));
    assert.ok(Number.isFinite(rules.minKb) && rules.minKb >= 0);
    assert.ok(Number.isFinite(rules.maxMb) && rules.maxMb >= 1 && rules.maxMb <= MAX_FILE_MB);
    assert.ok(Number.isFinite(rules.perHourMax) && rules.perHourMax >= 0);
  }
  // 具体回落值：类型错/负数都当没配。
  assert.equal(normalizeArchiveRules({ extensions: 'zip' }).extensions.length, ARCHIVE_RULE_EXTENSIONS.length);
  assert.equal(normalizeArchiveRules({ maxMb: -5 }).maxMb, MAX_FILE_MB);
  assert.equal(normalizeArchiveRules({ minKb: NaN }).minKb, 0);
  assert.equal(normalizeArchiveRules({ perHourMax: -1 }).perHourMax, 0);
  assert.equal(normalizeArchiveRules({ senderMode: 'bogus' }).senderMode, 'any');
  assert.deepEqual(normalizeArchiveRules({ senders: '10001' }).senders, []);
  // matchArchiveRules 拿到垃圾规则也不能抛。
  assert.equal(matchArchiveRules(null, { fileName: 'a.zip' }).ok, true);
  assert.equal(matchArchiveRules('nope', { fileName: 'a.exe' }).ok, false);
  assert.equal(matchArchiveRules(undefined, {}).ok, false);
});

check('扩展名超过 12 字符 / 含怪字符一律丢弃，合法项保留', () => {
  const rules = normalizeArchiveRules({
    extensions: ['zip', '.TAR', 'a'.repeat(13), 't@r', '7z', 'zip', '  .Rar  '],
    excludeExtensions: ['exe', '!bad']
  });
  assert.deepEqual(rules.extensions, ['zip', 'tar', '7z', 'rar']);
  assert.deepEqual(rules.excludeExtensions, ['exe']);
});

check('maxMb 夹到 MAX_FILE_MB，且至少 1 MB', () => {
  assert.equal(normalizeArchiveRules({ maxMb: 999999 }).maxMb, MAX_FILE_MB);
  assert.equal(normalizeArchiveRules({ maxMb: 0 }).maxMb, MAX_FILE_MB);
  // 四舍五入到 0 视为「没配」，回落默认上限。
  assert.equal(normalizeArchiveRules({ maxMb: 0.4 }).maxMb, MAX_FILE_MB);
});

check('normalizeArchiveRules 幂等', () => {
  const raw = {
    extensions: ['.ZIP', 'JPG'],
    excludeExtensions: ['exe'],
    minKb: '10',
    maxMb: 100,
    includeKeywords: [' 报告 ', '报告'],
    excludeKeywords: ['tmp'],
    senderMode: 'include',
    senders: ['10001', 10001],
    perHourMax: '5'
  };
  const once = normalizeArchiveRules(raw);
  const twice = normalizeArchiveRules(once);
  assert.deepEqual(twice, once);
  // 幂等后再判定，结论不能因为 normalize 次数不同而改变。
  assert.equal(matchArchiveRules(once, { fileName: '报告.zip' }).ok, true);
  assert.equal(matchArchiveRules(twice, { fileName: '报告.zip' }).ok, true);
  assert.equal(matchArchiveRules(twice, { fileName: 'tmp.zip' }).ok, false);
});

check('describeArchiveRules：默认口径非空、含类型数与示例扩展名', () => {
  const text = describeArchiveRules(undefined);
  assert.ok(text.length > 0);
  assert.match(text, /16/);
  assert.match(text, /\.zip/);
  assert.match(text, /压缩包与图片/);
  assert.doesNotMatch(text, /。$/); // 约定不带句号，调用方自己接标点
});

check('describeArchiveRules：定制规则把关键数字都讲出来', () => {
  const text = describeArchiveRules({
    extensions: ['zip'],
    excludeExtensions: ['rar'],
    minKb: 10,
    maxMb: 5,
    includeKeywords: ['报告'],
    excludeKeywords: ['tmp'],
    senderMode: 'include',
    senders: ['10001'],
    perHourMax: 5
  });
  assert.match(text, /\.zip/);
  assert.match(text, /不收 \.rar/);
  assert.match(text, /10 KB/);
  assert.match(text, /5 MB/);
  assert.match(text, /「报告」/);
  assert.match(text, /「tmp」/);
  assert.match(text, /1 位指定发送者/);
  assert.match(text, /每小时最多 5 个/);
  // 白名单为空时要说清楚「什么都不转」，不能只留一个空串。
  assert.match(describeArchiveRules({ extensions: [] }), /不转存任何类型/);
});

check('DEFAULT_ARCHIVE_RULES 是冻结的默认值快照', () => {
  assert.ok(Object.isFrozen(DEFAULT_ARCHIVE_RULES));
  assert.deepEqual(normalizeArchiveRules(DEFAULT_ARCHIVE_RULES), normalizeArchiveRules(undefined));
});

check('normalizeFileArchiveConfig：rules.maxMb 缺省跟随老 maxFileMb', () => {
  const cfg = normalizeFileArchiveConfig({ enabled: true, groups: ['123456'], maxFileMb: 100 });
  assert.equal(cfg.maxFileMb, 100);
  assert.ok(cfg.rules);
  assert.equal(cfg.rules.maxMb, 100);
  assert.deepEqual(cfg.rules.extensions, [...ARCHIVE_RULE_EXTENSIONS]);
  // 用户显式配了 rules.maxMb 就以它为准，但两者都夹在 MAX_FILE_MB 内。
  assert.equal(normalizeFileArchiveConfig({ maxFileMb: 100, rules: { maxMb: 30 } }).rules.maxMb, 30);
  assert.equal(normalizeFileArchiveConfig({ maxFileMb: 99999, rules: { maxMb: 99999 } }).rules.maxMb, MAX_FILE_MB);
  assert.equal(normalizeFileArchiveConfig({ maxFileMb: 99999 }).rules.maxMb, MAX_FILE_MB);
});

check('normalizeFileArchiveConfig：groups 仍是纯字符串数组，老字段一个不少', () => {
  const cfg = normalizeFileArchiveConfig({ enabled: true, groups: ['123', 456, 'abc'], maxFileMb: 10 });
  assert.ok(Array.isArray(cfg.groups));
  for (const groupId of cfg.groups) assert.equal(typeof groupId, 'string');
  assert.deepEqual(cfg.groups.sort(), ['123', '456']);
  for (const key of ['enabled', 'groups', 'dir', 'maxFileMb', 'retention', 'category', 'cleanupHour', 'simpleMode', 'booth', 'rules']) {
    assert.ok(Object.hasOwn(cfg, key), key);
  }
  // rules 不该污染老字段类型。
  assert.equal(typeof cfg.enabled, 'boolean');
  assert.equal(typeof cfg.maxFileMb, 'number');
});

check('默认配置下 matchArchiveRules 与老 shouldArchiveAttachment 对同一批样本科目一致', () => {
  // 这是「默认行为一分不差」的核心断言：文件段用老函数判、再用默认规则判，结论必须一致。
  const samples = ['a.zip', 'a.rar', 'a.7z', 'a.tar', 'a.gz', 'b.jpg', 'b.jpeg', 'b.png', 'b.gif', 'b.webp', 'b.bmp', 'b.heic', 'c.exe', 'c.mp4', 'c.txt', 'c.pdf', 'noext'];
  for (const fileName of samples) {
    const oldVerdict = shouldArchiveAttachment({ kind: 'file', segType: 'file', fileName });
    const newVerdict = matchArchiveRules(normalizeArchiveRules(undefined), { fileName }).ok;
    assert.equal(newVerdict, oldVerdict, fileName);
  }
});

if (failed > 0) {
  console.error(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n🎉 test-archive-rules 全部通过');
