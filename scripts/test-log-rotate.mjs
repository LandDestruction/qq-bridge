// 日志/数据文件体积轮转（src/bridge/log-rotate.js）的机制测试。
// 全部用临时目录 + 注入假计时器，不启桥接、不碰真实 state/。
//
// 覆盖：纯函数不碰盘 / 阈值边界 / keep 上限与 name.N 递增 / 白名单 / 当前文件可继续写 /
//       配置覆盖与坏值回退 / 关闭开关 / 启动循环接线（1h + 10s、unref、幂等）/ 备份层不备份日志。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogRotate } from '../src/bridge/log-rotate.js';
import { createStateBackup } from '../src/bridge/state-backup.js';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
}

function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotate-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  return root;
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

/** 造一套 deps：真实 fs/path，假计时器（记录调用并支持手动触发），日志收集到数组。 */
function makeHarness(root) {
  const logs = [];
  const timers = [];
  const deps = {
    ROOT: root,
    STATE_DIR: path.join(root, 'state'),
    fs,
    path,
    log: (text) => logs.push(String(text)),
    setTimeout: (fn, ms) => {
      const timer = { kind: 'timeout', fn, ms, unrefCalled: false, unref() { timer.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    setInterval: (fn, ms) => {
      const timer = { kind: 'interval', fn, ms, unrefCalled: false, unref() { timer.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    }
  };
  const service = createLogRotate(deps);
  return { service, logs, timers, deps };
}

function writeConfig(root, value) {
  writeFile(path.join(root, 'config.json'), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function statePath(root, name) {
  return path.join(root, 'state', name);
}

function runMain() {
  // ── 1. 纯函数 planRotations：不碰盘、按体积、keep 决定压缩链 ──
  {
    const root = mkRoot();
    const { service } = makeHarness(root);
    const files = [
      { name: 'token-usage.jsonl', size: 2000 },
      { name: 'tool-calls.jsonl', size: 10 }
    ];
    const plan = service.planRotations({ dir: path.join(root, 'state'), files, maxBytes: 1000, keep: 3 });
    check('超阈值文件进计划、未超的不进', plan.plans.length === 1 && plan.plans[0].name === 'token-usage.jsonl',
      `plans=${plan.plans.map((p) => p.name).join(',')}`);
    check('计划里的动作是「当前文件 → .1」+ 标记重建', plan.plans[0].actions.length === 1
      && plan.plans[0].actions[0].kind === 'rename'
      && plan.plans[0].actions[0].to === 'token-usage.jsonl.1'
      && plan.plans[0].create === true);
    check('纯函数不创建目录/文件', fs.readdirSync(path.join(root, 'state')).length === 0,
      `state=${fs.readdirSync(path.join(root, 'state')).join(',')}`);

    const exact = service.planRotations({ files: [{ name: 'bridge.log', size: 1000 }], maxBytes: 1000, keep: 3 });
    check('大小恰好等于阈值不轮转（避免抖动）', exact.plans.length === 0);

    const chain = service.planRotations({
      files: [
        { name: 'bridge.log', size: 5000 },
        { name: 'bridge.log.1', size: 100 },
        { name: 'bridge.log.2', size: 100 }
      ],
      maxBytes: 1000,
      keep: 3
    });
    const actions = chain.plans[0].actions;
    check('已有 .1/.2 且 keep=3：先 .2→.3、再 .1→.2、最后当前→.1',
      actions.length === 3
      && actions[0].kind === 'rename' && actions[0].from === 'bridge.log.2' && actions[0].to === 'bridge.log.3'
      && actions[1].kind === 'rename' && actions[1].from === 'bridge.log.1' && actions[1].to === 'bridge.log.2'
      && actions[2].kind === 'rename' && actions[2].from === 'bridge.log' && actions[2].to === 'bridge.log.1',
      JSON.stringify(actions));

    const overKeep = service.planRotations({
      files: [
        { name: 'qq-activity.log', size: 5000 },
        { name: 'qq-activity.log.1', size: 1 },
        { name: 'qq-activity.log.2', size: 1 },
        { name: 'qq-activity.log.3', size: 1 },
        { name: 'qq-activity.log.9', size: 1 }
      ],
      maxBytes: 1000,
      keep: 2
    });
    const overActions = overKeep.plans[0].actions;
    const removed = overActions.filter((a) => a.kind === 'remove').map((a) => a.from);
    check('keep=2：超代数（.2/.3/.9）先删掉', removed.join(',') === 'qq-activity.log.9,qq-activity.log.3,qq-activity.log.2', `removed=${removed.join(',')}`);
    check('keep=2：.1 升到 .2、当前升到 .1',
      overActions.filter((a) => a.kind === 'rename').map((a) => `${a.from}>${a.to}`).join('|') === 'qq-activity.log.1>qq-activity.log.2|qq-activity.log>qq-activity.log.1');

    const keepOne = service.planRotations({
      files: [{ name: 'bridge.out', size: 9000 }, { name: 'bridge.out.1', size: 1 }],
      maxBytes: 1000,
      keep: 1
    });
    check('keep=1：唯一旧档被删，只留当前→.1',
      keepOne.plans[0].actions.length === 2
      && keepOne.plans[0].actions[0].kind === 'remove'
      && keepOne.plans[0].actions[1].to === 'bridge.out.1');

    const outsiders = service.planRotations({
      files: [
        { name: 'notes.txt', size: 999999 },
        { name: 'bridge.log.bak', size: 999999 },
        { name: 'token-usage.jsonl.1', size: 999999 },
        { name: 'social-v2.json', size: 999999 }
      ],
      maxBytes: 1000,
      keep: 3
    });
    check('白名单外 / 只有旧档没有当前文件：一律不轮转', outsiders.plans.length === 0,
      JSON.stringify(outsiders.plans));
  }

  // ── 2. rotateLogsNow：真实文件、当前文件重建后可继续写 ──
  {
    const root = mkRoot();
    const { service } = makeHarness(root);
    writeFile(statePath(root, 'token-usage.jsonl'), 'A'.repeat(2000));
    const first = service.rotateLogsNow({ maxBytes: 1000, keep: 3 });
    check('轮转 ok 且报告 1 个文件', first.ok === true && first.rotated.length === 1, JSON.stringify(first.rotated));
    check('.1 拿到旧内容、当前文件变空', read(statePath(root, 'token-usage.jsonl.1')) === 'A'.repeat(2000)
      && fs.statSync(statePath(root, 'token-usage.jsonl')).size === 0);
    writeFile(statePath(root, 'token-usage.jsonl'), 'B'.repeat(2000));
    const second = service.rotateLogsNow({ maxBytes: 1000, keep: 3 });
    check('第二次轮转：旧 .1 升成 .2、新 .1 是上一代、当前仍空',
      second.ok === true
      && read(statePath(root, 'token-usage.jsonl.2')) === 'A'.repeat(2000)
      && read(statePath(root, 'token-usage.jsonl.1')) === 'B'.repeat(2000)
      && fs.statSync(statePath(root, 'token-usage.jsonl')).size === 0);
    fs.appendFileSync(statePath(root, 'token-usage.jsonl'), 'new-line\n');
    check('轮转后当前文件可继续追加（只含新写入）', read(statePath(root, 'token-usage.jsonl')) === 'new-line\n');

    writeFile(statePath(root, 'token-usage.jsonl'), 'C'.repeat(2000));
    service.rotateLogsNow({ maxBytes: 1000, keep: 2 });
    const names = fs.readdirSync(path.join(root, 'state')).filter((n) => n.startsWith('token-usage')).sort();
    check('keep=2 后只留 .1/.2（最老的 .2 被删）', names.join(',') === 'token-usage.jsonl,token-usage.jsonl.1,token-usage.jsonl.2',
      `names=${names.join(',')}`);

    writeFile(statePath(root, 'not-a-log.json'), 'X'.repeat(5000));
    writeFile(statePath(root, 'bridge.log.1'), 'OLD');
    service.rotateLogsNow({ maxBytes: 1000, keep: 3 });
    check('白名单外文件一个字节都没动', read(statePath(root, 'not-a-log.json')) === 'X'.repeat(5000));
    check('单独存在的旧档不会被当成当前文件轮转', read(statePath(root, 'bridge.log.1')) === 'OLD');

    writeFile(statePath(root, 'token-usage.jsonl'), 'D'.repeat(2000));
    const dry = service.rotateLogsNow({ maxBytes: 1000, keep: 3, dryRun: true });
    check('dryRun 只给计划不落盘', dry.ok === true && dry.plans.length >= 1 && dry.rotated.length === 0
      && read(statePath(root, 'not-a-log.json')) === 'X'.repeat(5000));
  }

  // ── 3. 配置来源与坏值回退 ──
  {
    const root = mkRoot();
    const { service } = makeHarness(root);
    writeFile(statePath(root, 'token-usage.jsonl'), 'A'.repeat(2000));
    const defaults = service.rotateLogsNow();
    check('没有 config.json：默认 8MB/3 份、小文件不轮转', defaults.maxBytes === 8 * 1024 * 1024
      && defaults.keep === 3 && defaults.rotated.length === 0, `maxBytes=${defaults.maxBytes} keep=${defaults.keep}`);

    writeConfig(root, { logging: { rotate: { enabled: true, maxBytes: 1024, keep: 2 } } });
    const overridden = service.rotateLogsNow();
    check('config.json 的 logging.rotate 生效（maxBytes/keep）', overridden.ok === true
      && overridden.maxBytes === 1024 && overridden.keep === 2 && overridden.rotated.length === 1,
      `maxBytes=${overridden.maxBytes} keep=${overridden.keep} rotated=${overridden.rotated.length}`);

    writeConfig(root, '{ not json');
    writeFile(statePath(root, 'bridge.log'), 'L'.repeat(3000));
    const broken = service.rotateLogsNow();
    check('坏 config.json 回退默认（不因为配置坏掉而停摆）', broken.ok === true && broken.maxBytes === 8 * 1024 * 1024
      && broken.rotated.length === 0);

    writeConfig(root, { logging: { rotate: { maxBytes: '8MB', keep: 100 } } });
    const badTypes = service.rotateLogsNow();
    check('坏值回退并夹到安全区间（maxBytes=默认 8MB、keep 夹到 9）', badTypes.maxBytes === 8 * 1024 * 1024 && badTypes.keep === 9,
      `maxBytes=${badTypes.maxBytes} keep=${badTypes.keep}`);

    writeConfig(root, { logging: { rotate: { enabled: false } } });
    const disabled = service.rotateLogsNow();
    check('enabled=false 时什么都不做', disabled.ok === true && disabled.enabled === false && disabled.rotated.length === 0);
  }

  // ── 4. 启动循环接线：1 小时 + 启动 10s 补查、unref、幂等、只在轮转时打日志 ──
  {
    const root = mkRoot();
    writeConfig(root, { logging: { rotate: { maxBytes: 1024, keep: 3 } } });
    const { service, logs, timers } = makeHarness(root);
    service.startLogRotateLoop();
    const interval = timers.find((t) => t.kind === 'interval');
    const timeout = timers.find((t) => t.kind === 'timeout');
    check('接线：每小时一次 + 启动 10s 补查', Boolean(interval) && interval.ms === 60 * 60 * 1000
      && Boolean(timeout) && timeout.ms === 10 * 1000, `interval=${interval?.ms} timeout=${timeout?.ms}`);
    check('两个计时器都 unref（不拖住进程退出）', interval.unrefCalled === true && timeout.unrefCalled === true);
    check('启动日志含阈值与保留份数', logs.some((line) => line.includes('日志轮转') && line.includes('阈值 1KB') && line.includes('3 份')),
      logs[0] ?? '(无日志)');

    const before = timers.length;
    service.startLogRotateLoop();
    check('重复调用 start 不产生第二组计时器', timers.length === before);

    writeFile(statePath(root, 'token-usage.jsonl'), 'A'.repeat(3000));
    const logsBeforeTick = logs.length;
    interval.fn();
    const rotatedNames = fs.readdirSync(path.join(root, 'state')).sort();
    check('定时回调真的执行轮转', rotatedNames.includes('token-usage.jsonl.1')
      && fs.statSync(statePath(root, 'token-usage.jsonl')).size === 0, `names=${rotatedNames.join(',')}`);
    check('轮转后打一行「已轮转 X 个文件」', logs.slice(logsBeforeTick).some((line) => /已轮转 1 个文件/.test(line)),
      logs.slice(logsBeforeTick).join(' | '));

    const logsBeforeQuiet = logs.length;
    interval.fn();
    check('没东西可轮转时不刷日志', logs.length === logsBeforeQuiet);
  }

  // ── 5. 与备份层兼容：日志与 .1 旧档都不该进 state 备份 ──
  {
    const root = mkRoot();
    writeFile(statePath(root, 'token-usage.jsonl'), 'A'.repeat(64));
    writeFile(statePath(root, 'token-usage.jsonl.1'), 'B'.repeat(64));
    writeFile(statePath(root, 'bridge.out.2'), 'C'.repeat(64));
    writeFile(statePath(root, 'social-v2.json'), '{"sessions":{}}\n');
    const backup = createStateBackup({ STATE_DIR: path.join(root, 'state'), fs, path, log: () => {} });
    const result = backup.backupStateNow();
    check('备份 ok 且只备 social-v2.json', result.ok === true && result.written.length === 1
      && result.written[0].source === 'social-v2.json', `written=${result.written.map((w) => w.source).join(',')}`);
    const backupNames = fs.readdirSync(path.join(root, 'state', 'backups')).filter((n) => !n.startsWith('.'));
    check('备份目录里没有日志 / 轮转旧档', backupNames.every((n) => !/(token-usage|tool-calls|bridge\.(log|out)|activity)/.test(n)),
      `names=${backupNames.join(',')}`);
  }

  // ── 6. 边界：state 目录不存在也不抛 ──
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotate-empty-'));
    const { service } = makeHarness(root); // root/state 不存在
    const result = service.rotateLogsNow({ maxBytes: 10, keep: 1 });
    check('state 目录不存在：返回 ok 且没有文件可轮转', result.ok === true && result.rotated.length === 0);
  }

  // ── 汇总 ──
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  for (const item of results) {
    if (!item.ok) console.log(`FAIL ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
  }
  console.log(`\n========== 通过 ${passed} / 失败 ${failed} ==========`);
  if (failed > 0) process.exitCode = 1;
}

runMain();
