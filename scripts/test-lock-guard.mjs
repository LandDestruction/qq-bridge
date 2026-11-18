// 单实例锁判定（0007）纯逻辑单测：接管条件，以及「什么时候绝不能接管」。
//
// 为什么需要：这段逻辑的每条分支都对应一次真实的「起不来」或「双实例」事故——
// PID 被回收、EPERM、僵死进程仍占端口，以及最危险的一种：把「安静」当「僵死」误杀健康实例
// （真实重启验证时踩到过：桥接没消息时本来就不写日志）。
//
// 运行：node scripts/test-lock-guard.mjs

import {
  DEFAULT_STALE_LOG_MINUTES,
  MIN_STALE_LOG_MINUTES,
  MAX_STALE_LOG_MINUTES,
  staleLogMs,
  parseLockPid,
  decideLock
} from '../src/lock-guard.js';

let pass = 0;
let fail = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass += 1; console.log(`  ok   ${name} → ${JSON.stringify(got)}`); }
  else { fail += 1; console.log(`  FAIL ${name} → got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

const MIN = 60 * 1000;

console.log('\n[1] 日志僵死窗口：默认 10 分钟，夹在 [1, 1440] 分钟');
{
  check('未配置 → 默认', staleLogMs(undefined), DEFAULT_STALE_LOG_MINUTES * MIN);
  check('null → 默认', staleLogMs(null), 10 * MIN);
  check('非数字 → 默认', staleLogMs('abc'), 10 * MIN);
  check('0 → 默认', staleLogMs(0), 10 * MIN);
  check('负数 → 默认', staleLogMs(-5), 10 * MIN);
  check('合法值原样', staleLogMs(30), 30 * MIN);
  check('超上限夹到 1440', staleLogMs(99999), MAX_STALE_LOG_MINUTES * MIN);
  check('低于下限夹到 1', staleLogMs(0.2), MIN_STALE_LOG_MINUTES * MIN);
}

console.log('\n[2] 锁文件解析：坏内容一律视为过期锁（不能当成某个 PID）');
{
  check('正常 PID', parseLockPid('2080'), 2080);
  check('带空白', parseLockPid('  2080\n'), 2080);
  check('空文件 → null', parseLockPid(''), null);
  check('全空白 → null', parseLockPid('   \n'), null);
  check('undefined → null', parseLockPid(undefined), null);
  check('非数字 → null', parseLockPid('abc'), null);
  check('0 → null', parseLockPid('0'), null);
  check('负数 → null', parseLockPid('-7'), null);
  check('小数 → null', parseLockPid('12.5'), null);
}

console.log('\n[3] 接管判定：只有「确定没人在干活」时才接管');
{
  check('PID 已死 → 接管',
    decideLock({ pidAlive: false, portInUse: true, logIdleMs: 0, staleLogMs: 10 * MIN, responsive: true }).reason, 'pid-gone');
  check('端口空闲 → 接管（PID 被回收的典型形态）',
    decideLock({ pidAlive: true, portInUse: false, logIdleMs: 0, staleLogMs: 10 * MIN, responsive: false }).reason, 'port-free');
  check('netstat 报端口空闲、但 HTTP 有应答 → 在运行（监听套接字被报成 CLOSED 的真实情况）',
    decideLock({ pidAlive: true, portInUse: false, logIdleMs: 60 * MIN, staleLogMs: 10 * MIN, responsive: true }),
    { action: 'running', reason: 'responsive' });
  check('端口空闲 + 探测也不应答 → 接管（PID 被回收的典型形态）',
    decideLock({ pidAlive: true, portInUse: false, logIdleMs: 0, staleLogMs: 10 * MIN, responsive: false }).reason, 'port-free');
  check('端口占用 + 日志新鲜 + 有应答 → 在运行',
    decideLock({ pidAlive: true, portInUse: true, logIdleMs: 60 * 1000, staleLogMs: 10 * MIN, responsive: true }),
    { action: 'running', reason: 'responsive' });
  check('端口占用 + 日志僵死 + 有应答 → 在运行（安静 ≠ 僵死，不能误杀）',
    decideLock({ pidAlive: true, portInUse: true, logIdleMs: 60 * MIN, staleLogMs: 10 * MIN, responsive: true }).action, 'running');
  check('端口占用 + 日志僵死 + 明确不应答 → 疑似僵死',
    decideLock({ pidAlive: true, portInUse: true, logIdleMs: 11 * MIN, staleLogMs: 10 * MIN, responsive: false }),
    { action: 'suspect-hung', reason: 'log-idle' });
  check('刚好等于窗口 + 不应答 → 疑似僵死',
    decideLock({ pidAlive: true, portInUse: true, logIdleMs: 10 * MIN, staleLogMs: 10 * MIN, responsive: false }).action, 'suspect-hung');
  check('差 1ms 未到窗口 + 不应答 → 保守放行（可能刚启动）',
    decideLock({ pidAlive: true, portInUse: true, logIdleMs: 10 * MIN - 1, staleLogMs: 10 * MIN, responsive: false }).reason, 'log-fresh');
  check('日志静止但探测不出来（null）→ 保守放行，不杀',
    decideLock({ pidAlive: true, portInUse: true, logIdleMs: 60 * MIN, staleLogMs: 10 * MIN, responsive: null }).reason, 'unverified');
  check('日志文件不存在（Infinity）+ 不应答 → 疑似僵死',
    decideLock({ pidAlive: true, portInUse: true, logIdleMs: Number.POSITIVE_INFINITY, staleLogMs: 10 * MIN, responsive: false }).action, 'suspect-hung');
  check('PID 已死 + 端口被占 → 仍按 pid-gone 接管',
    decideLock({ pidAlive: false, portInUse: true, logIdleMs: Number.POSITIVE_INFINITY, staleLogMs: 10 * MIN, responsive: false }).reason, 'pid-gone');
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
