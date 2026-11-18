// D1：群友印象归纳的运行器（按钮触发 + 每两天自动跑）。
// 测三层：① 纯函数 nextImpressionRunAt 的排期口径；② 运行器的单飞/状态/收尾（用假 spawn 和临时目录）；
// ③ 静态契约（路由分派、manifest 依赖、前端按钮与轮询）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createImpressionsRunner, nextImpressionRunAt } from '../src/bridge/impressions-run.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` ⟵ ${detail}`}`);
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ---------- ① 排期纯函数 ----------
{
  const at0410 = (y, m, d) => new Date(y, m - 1, d, 4, 10, 0, 0).getTime();
  // 凌晨 3 点：当天 04:10 就该跑
  const before = new Date(2026, 9, 29, 3, 0, 0).getTime();
  check('凌晨 3 点排到当天 04:10', nextImpressionRunAt(before, { everyDays: 2 }) === at0410(2026, 10, 29));
  // 已经过了 04:10：跳到两天后
  const after = new Date(2026, 9, 29, 9, 0, 0).getTime();
  check('过了点排到两天后的 04:10', nextImpressionRunAt(after, { everyDays: 2 }) === at0410(2026, 10, 31));
  // exactly 04:10 也算「已过」，不会再排同一时刻（否则定时器会给 0 延迟空转）
  check('正好 04:10 不算未来', nextImpressionRunAt(at0410(2026, 10, 29), { everyDays: 2 }) === at0410(2026, 10, 31));
  // 跨月
  check('跨月排期正确', nextImpressionRunAt(new Date(2026, 9, 30, 12, 0, 0).getTime(), { everyDays: 2 }) === at0410(2026, 11, 1));
  // 自定义时间与天数
  check('可改时刻/间隔', nextImpressionRunAt(new Date(2026, 9, 29, 1, 0, 0).getTime(), { everyDays: 3, hour: 5, minute: 30 }) === new Date(2026, 9, 29, 5, 30, 0, 0).getTime());
  // 非法 now 不抛错（退回当前时间，结果必须是未来）
  check('非法 now 也返回未来时刻', nextImpressionRunAt('nope', {}) > Date.now() - 1000);
}

// ---------- ② 运行器 ----------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impressions-run-'));
  const stateDir = path.join(dir, 'state');
  const logs = [];
  const spawned = [];
  let childHandlers = null;
  let alive = true;
  const fakeChild = {
    pid: 4242,
    on(event, handler) { childHandlers = childHandlers || {}; childHandlers[event] = handler; },
    unref() {}
  };
  const deps = {
    ROOT: dir,
    STATE_DIR: stateDir,
    fs,
    path,
    log: (m) => logs.push(String(m)),
    spawn: (file, args, options) => {
      spawned.push({ file, args, options });
      return fakeChild;
    },
    execPath: 'node.exe',
    env: { A: '1' },
    isPidAlive: () => alive,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {}
  };
  const runner = createImpressionsRunner(deps);

  const first = runner.startRun('console');
  check('首次手动归纳能启动', first.ok === true && first.status.running === true, JSON.stringify(first));
  check('spawn 的是仓库里的 CLI 且带 --apply',
    spawned.length === 1 && /build-impressions\.mjs$/.test(spawned[0].args[0]) && spawned[0].args.includes('--apply'),
    JSON.stringify(spawned[0] || null));
  check('工作目录是仓库根、日志并入 stdio',
    spawned[0] && spawned[0].options.cwd === dir && spawned[0].options.stdio[0] === 'ignore');
  check('运行状态落盘（pid/startedAt/trigger）',
    (() => {
      const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'impressions-run.json'), 'utf8'));
      return saved.pid === 4242 && saved.trigger === 'console' && saved.startedAt > 0;
    })());
  check('进程活着时 status.running 为真', runner.status().running === true);
  const busy = runner.startRun('console');
  check('单飞：跑着的时候再点回 busy', busy.ok === false && busy.busy === true, JSON.stringify(busy));

  // 模拟子进程正常退出
  childHandlers.exit(0, null);
  const done = runner.status();
  check('退出后 running=false 且记录成功', done.running === false && done.ok === true && done.finishedAt > 0, JSON.stringify(done));
  check('完成后可以再跑一轮', runner.startRun('console').ok === true);
  check('每次启动都追加日志头', logs.filter((line) => /印象归纳\] 已开始/.test(line)).length === 2);
  check('状态查询带下次自动归纳时刻', runner.status().nextRunAt > Date.now());
}

// ---------- ③ 静态契约 ----------
{
  const memory = read('src/bridge/console/memory.js');
  const server = read('src/bridge/console-server.js');
  const bridge = read('src/bridge.js');
  const client = read('public/client.js');
  const manifest = JSON.parse(read('src/bridge/manifest.json'));

  check('memory 模块有 POST /api/impressions/rebuild 且复用运行器',
    /POST' && request\.url\.pathname === '\/api\/impressions\/rebuild'/.test(memory)
    && /deps\.impressionRunner[\s\S]{0,400}?runner\.startRun\('console'\)/.test(memory));
  check('读接口顺带返回运行状态（按钮据此显示进度）', /view\.run = deps\.impressionRunner \? deps\.impressionRunner\.status\(\) : null;/.test(memory));
  check('跑着时回 409 + busy', /result\.busy \? 409 : 500/.test(memory));
  check('console-server 把 /api/impressions/rebuild 分派给 memory',
    /url\.pathname === '\/api\/impressions\/rebuild'/.test(server));
  check('bridge.js 创建运行器并排定时',
    /createImpressionsRunner\(\{/.test(bridge) && /states\.impressionRunner\.startSchedule\(\);/.test(bridge));
  check('运行器只接受注入的 spawn/pid 检查（不直接 import 子进程）',
    !/^import .*child_process/m.test(read('src/bridge/impressions-run.js')));
  check('manifest 登记了运行器模块与 impressionRunner 依赖',
    manifest.modules.some((m) => m.file === 'src/bridge/impressions-run.js' && m.factory === 'createImpressionsRunner')
    && manifest.modules.some((m) => m.file === 'src/bridge/console/memory.js' && m.dependencies.includes('impressionRunner')));
  check('前端按钮可点 + 二次确认 + 起轮询',
    /data-write="impressions-rebuild"/.test(client)
    && /'impressions-rebuild': function \(btn\)/.test(client)
    && /title: '立即归纳群友印象'/.test(client)
    && /function pollImpressions\(\)/.test(client));
  check('跑着的时候按钮禁用并显示「归纳中…」', /busy \? '归纳中…' : '立即归纳'/.test(client));
  check('面板显示自动归纳的间隔与下次时间', /每 ' \+ numText\(run\.everyDays \|\| 2\) \+ ' 天一次/.test(client));
}

// 未来时刻不能用 relative()（会算成「刚刚」），排期倒计时要有专门的 untilText
const clientSrc = fs.readFileSync(path.join(ROOT, 'public/client.js'), 'utf8');
check('前端有 untilText() 处理未来时刻', /function untilText\(ms\)/.test(clientSrc));
check('下次自动归纳用 untilText，不会显示成「刚刚」', /esc\(untilText\(run\.nextRunAt\)\)/.test(clientSrc));
check('CLI 的 --days 用等号形式（空格形式会被 CLI 当未知参数直接退出）',
  /--days=\$\{/.test(fs.readFileSync(path.join(ROOT, 'src/bridge/impressions-run.js'), 'utf8')));

const failed = results.filter((r) => !r.ok);
console.log(`\nimpressions-run: ${results.length - failed.length}/${results.length} ok`);
if (failed.length) {
  console.log('失败的检查：');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` ⟵ ${f.detail}` : ''}`);
  process.exitCode = 1;
}
