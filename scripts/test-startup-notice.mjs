// startup-notice 单元测试：上线提醒的「发不发」判断。
//
// 为什么需要：这段逻辑决定 watchdog 反复拉起时会不会给管理员刷屏，
// 而它的坑都在边界上（10 分钟窗口、时间戳文件损坏、系统时间被改过）。
// 全部用例注入时间戳，不依赖当前时间，也不连网、不起进程。
//
// 运行：node scripts/test-startup-notice.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NOTICE_WINDOW_MS,
  formatNoticeText,
  isDuplicateNotice,
  readNoticeStamp
} from '../src/startup-notice.js';

let pass = 0;
let fail = 0;

function check(name, got, want) {
  const ok = got === want;
  if (ok) { pass += 1; console.log(`  ok   ${name} → ${got}`); }
  else { fail += 1; console.log(`  FAIL ${name} → got ${got}, want ${want}`); }
}

const T = Date.UTC(2026, 9, 24, 4, 0, 0); // 固定「现在」，只用于算术
const MIN = 60 * 1000;

console.log('\n[1] 从未提醒过（时间戳 0）→ 该发');
check('duplicate', isDuplicateNotice(0, T), false);

console.log('\n[2] 1 分钟前刚提醒过 → 跳过');
check('duplicate', isDuplicateNotice(T - 1 * MIN, T), true);

console.log('\n[3] 10 分钟窗口的边界：差 1ms 跳过，正好到点该发');
check('窗口内 1ms', isDuplicateNotice(T - NOTICE_WINDOW_MS + 1, T), true);
check('正好满窗口', isDuplicateNotice(T - NOTICE_WINDOW_MS, T), false);
check('窗口常量为 10 分钟', NOTICE_WINDOW_MS, 10 * MIN);

console.log('\n[4] 11 分钟前提醒过 → 该发');
check('duplicate', isDuplicateNotice(T - 11 * MIN, T), false);

console.log('\n[5] 系统时间被改过（时间戳在未来）→ 仍按窗口内处理，跳过');
check('duplicate', isDuplicateNotice(T + 5 * MIN, T), true);

console.log('\n[6] 时间戳是脏值（非数字字符串）→ 当从未提醒，该发');
check('字符串', isDuplicateNotice('abc', T), false);
check('undefined', isDuplicateNotice(undefined, T), false);
check('null', isDuplicateNotice(null, T), false);

console.log('\n[7] 窗口可注入：windowMs=0 → 永远该发');
check('windowMs=0', isDuplicateNotice(T, T, 0), false);

console.log('\n[8] readNoticeStamp：正常文件 → 读回时间戳');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-notice-test-'));
{
  const file = path.join(dir, 'ok.json');
  fs.writeFileSync(file, JSON.stringify({ at: 1234567890 }));
  check('读回', readNoticeStamp(file), 1234567890);
}

console.log('\n[9] readNoticeStamp：文件不存在 → 0（不能抛）');
{
  check('缺失文件', readNoticeStamp(path.join(dir, 'nope.json')), 0);
}

console.log('\n[10] readNoticeStamp：JSON 损坏 → 0（时间戳坏了不该连带把提醒弄没）');
{
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, '{ this is not json');
  check('损坏 JSON', readNoticeStamp(file), 0);
}

console.log('\n[11] readNoticeStamp：at 字段为空/非法 → 0');
{
  const a = path.join(dir, 'missing-at.json');
  fs.writeFileSync(a, JSON.stringify({ ts: 1 }));
  check('缺 at 字段', readNoticeStamp(a), 0);
  const b = path.join(dir, 'bad-at.json');
  fs.writeFileSync(b, JSON.stringify({ at: 'yesterday' }));
  check('at 非数字', readNoticeStamp(b), 0);
}

console.log('\n[12] formatNoticeText：带「上线提醒」前缀与可读时间');
{
  const text = formatNoticeText(new Date(2026, 9, 24, 4, 5, 6));
  check('前缀', text.startsWith('（上线提醒）'), true);
  check('含年', text.includes('2026'), true);
  check('含时分秒', /04:05:06/.test(text), true);
  check('无 Invalid', /Invalid/.test(text), false);
}

console.log('\n[13] formatNoticeText：默认参数也能用');
{
  const text = formatNoticeText();
  check('前缀', text.startsWith('（上线提醒）'), true);
  check('非空', text.length > 12, true);
}

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
