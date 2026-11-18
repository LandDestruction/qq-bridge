#!/usr/bin/env node
// test-desktop-host.mjs —— 桌面壳（WebView2 宿主）的静态闸门。
//
// 为什么是静态的：产物是 Windows exe，CI/别的机器上不一定能跑 WinForms；但**能坏的地方都在源码约定里**
// （品牌名散落、令牌被写进标题/日志、错误页缺重试、构建脚本漏依赖、gitignore 漏 vendor、托管桥接时乱杀 node）。这些都用文本断言守，
// 真机行为（加载 /client、错误页、壳拉起/停止/守护桥接、托盘退出）由 docs/desktop-host.md 的验收记录兜底。
//
// 用法：node scripts/test-desktop-host.mjs [--verbose]
// 退出码：0 全绿 / 1 有断言失败 / 2 环境缺文件
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) {
    pass++;
    if (verbose) 
console.log(`  ok  ${name}${detail ? ' — ' + detail : ''}`);
    return;
  }
  fail++;
  failures.push(name + (detail ? ' — ' + detail : ''));
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

const host = read('desktop/Host.cs');
const brand = read('desktop/Brand.cs');
const manifest = read('desktop/app.manifest');
const build = read('scripts/desktop/build-host.ps1');
const readme = read('desktop/README.md');
const docs = read('docs/desktop-host.md');
const gitignore = read('.gitignore');

if (!host || !brand || !manifest || !build) {
  console.error('缺文件：desktop/Host.cs / desktop/Brand.cs / desktop/app.manifest / scripts/desktop/build-host.ps1');
  process.exit(2);
}

// ── 1. 品牌名收敛（命名契约） ────────────────────────────────────────────────
const brandConstants = ['Name', 'ExeName', 'Version', 'Trademark', 'AppDataDirName'];
for (const c of brandConstants) {
  ok(`Brand.cs 定义 ${c}`, new RegExp(`const string ${c}\\s*=`).test(brand));
}
const otherCs = fs.readdirSync(path.join(ROOT, 'desktop'))
  .filter((f) => f.endsWith('.cs') && f !== 'Brand.cs')
  .map((f) => ({ f, text: fs.readFileSync(path.join(ROOT, 'desktop', f), 'utf8') }));
ok('desktop/ 至少还有一个非 Brand 的 .cs', otherCs.length >= 1);
const brandLeaks = otherCs.filter(({ text }) => /QQ DeepSeek Bot|QQDeepSeekBot|QQ DeepSeek/.test(text));
ok('品牌名只出现在 Brand.cs', brandLeaks.length === 0,
  brandLeaks.map((x) => x.f).join(', ') || undefined);
const exeNameInBrand = (brand.match(/const string ExeName\s*=\s*"([^"]+)"/) || [])[1] || '';
ok('ExeName 与构建产物一致', build.includes(exeNameInBrand) && exeNameInBrand.endsWith('.exe'), exeNameInBrand);
ok('关于框版本行引用 Brand.Version', /Brand\.Version/.test(host));
ok('关于框带免责声明 Brand.Trademark', /Brand\.Trademark/.test(host));

// ── 2. 构建脚本（csc 工具链 + 依赖 + 幂等） ──────────────────────────────────
ok('build 用 .NET Framework 4.8 的 csc', /Framework64\\v4\.0\.30319\\csc\.exe/.test(build));
for (const arg of ['/target:winexe', '/platform:x64', '/langversion:5', '/win32manifest']) {
  ok(`csc 参数 ${arg}`, build.includes(arg));
}
ok('引用 WebView2 Core 程序集', /Microsoft\.Web\.WebView2\.Core\.dll/.test(build));
ok('引用 WebView2 WinForms 程序集', /Microsoft\.Web\.WebView2\.WinForms\.dll/.test(build));
ok('引用原生 WebView2Loader.dll（win-x64）', /WebView2Loader\.dll/.test(build) && /runtimes\\win-x64/.test(build));
ok('SDK 版本固定 1.0.4314.35', build.includes("'1.0.4314.35'") || build.includes('1.0.4314.35'));
ok('SDK 缓存进 desktop/vendor', /vendor/.test(build) && /cache/.test(build));
ok('产物目录 dist/desktop', build.includes('dist\\desktop') || build.includes('dist/desktop'));
ok('重复执行幂等（已存在则跳过下载/解压）',
  /if \(-not \(Test-Path \$Nupkg\)\)/.test(build) && /if \(-not \(Test-Path \$CoreDll\)\)/.test(build));
ok('失败有明确报错并退出非 0', /function Fail/.test(build) && /exit 1/.test(build));
ok('build-host.ps1 是 UTF-8 with BOM（PS5.1 中文注释会吞行）',
  fs.readFileSync(path.join(ROOT, 'scripts/desktop/build-host.ps1')).slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));

// ── 3. 加载路径 / 令牌纪律 ──────────────────────────────────────────────────
ok('URL 指向 /client 并带 ?token=', /"\/client\?token="\s*\+\s*Uri\.EscapeDataString\(token\)/.test(host));
ok('令牌读自 <root>/state/console-token', /Path\.Combine\(Root, "state", "console-token"\)/.test(host));
ok('端口读自 config.json 的 consolePort（只读）', /consolePort/.test(host) && !/WriteAllText\(ConfigPath/.test(host));
ok('令牌不进标题', !/Text\s*=\s*[^;]*token/i.test(host));
ok('没有 Console 输出（壳不落日志，也就无从泄漏令牌）', !/Console\.(Write|Error)/.test(host));
ok('异常文案统一过 Scrub 擦 token', /Scrub\(e\.Exception\.Message\)/.test(host));
ok('只写一个文件（window.json），不写令牌', (host.match(/File\.WriteAllText/g) || []).length === 1);

// ── 4. 进程与窗口行为 ──────────────────────────────────────────────────────
ok('单实例 Mutex', /new Mutex\(true, MutexName, out isFirstInstance\)/.test(host));
ok('二次启动激活已有窗口（命名事件）', /EventWaitHandle\.OpenExisting\(eventName\)/.test(host) && /ActivateEventName/.test(host));
ok('--quit 走同一条退出路径', /--quit/.test(host) && /ExitApplication\(\)/.test(host));
ok('最小尺寸按 DPI 折算（逻辑 360×560）',
  /MinSizeForDpi\(int dpi\)/.test(host) && /360\.0 \* dpi \/ 96\.0/.test(host) && /560\.0 \* dpi \/ 96\.0/.test(host));
ok('最小尺寸不是写死 1024×700（真窗口能到 360）', !/MinimumSize = new Size\(1024, 700\)/.test(host));
ok('DPI 变化时重新折算（WM_DPICHANGED / OnDpiChanged）',
  /0x02E0/.test(host) && /OnDpiChanged\(DpiChangedEventArgs/.test(host) && /ApplyMinimumSize\(\)/.test(host));
ok('window.json 读回时夹到最小尺寸', /Math\.Max\(w, MinimumSize\.Width\)/.test(host) && /Math\.Max\(h, MinimumSize\.Height\)/.test(host));
ok('错误页按宽度换行（FlowLayoutPanel + MaximumSize）',
  /FlowLayoutPanel/.test(host) && /RelayoutErrorLabels/.test(host) && /MaximumSize = new Size\(maxWidth, 0\)/.test(host));
ok('托盘 NotifyIcon + 打开/退出菜单', /new NotifyIcon\(\)/.test(host) && host.includes('"打开"') && host.includes('"退出"'));
ok('关闭窗口 = 隐藏到托盘', /e\.Cancel = true;/.test(host) && /Hide\(\);/.test(host));
ok('窗口位置记忆落 %LOCALAPPDATA%<品牌>\\window.json',
  /SpecialFolder\.LocalApplicationData/.test(host) && /Brand\.AppDataDirName/.test(host) && /"window.json"/.test(host));
ok('坏 window.json 不炸（读取包在 try/catch）',
  /private void RestoreBoundsFromDisk\(\)\s*\{\s*try/.test(host));

// ── 5. 防白屏 / 错误页 / 运行时缺失 ────────────────────────────────────────
ok('先显示骨架页（skeleton 覆盖 WebView）', /skeleton\.Dock = DockStyle\.Fill/.test(host) && /skeleton\.BringToFront\(\)/.test(host));
ok('NavigationCompleted 成功后才隐藏骨架', /if \(e\.IsSuccess\)/.test(host) && /ShowContent\(\)/.test(host));
ok('错误页有「重试」与「我已启动」', host.includes('"重试"') && host.includes('"我已启动"'));
ok('错误页显示探测到的端口/地址与错误码', /探测到的地址/.test(host) && /错误码/.test(host));
ok('WebView2 运行时存在性检测', /GetAvailableBrowserVersionString\(\)/.test(host));
ok('运行时缺失给官方 Evergreen 链接', /go\.microsoft\.com\/fwlink\/p\/\?LinkId=2124703/.test(host));
ok('绝不在 UI 线程上阻塞/跑桥接（Process.Start 只出现在托管类里）',
  /Process\.Start\("https:/.test(host) && /internal sealed class BridgeGuard/.test(host));
ok('F12 默认关、--devtools 开', /AreDevToolsEnabled = opt\.DevTools/.test(host) && /--devtools/.test(host));
ok('解析 --root/--url', /--root/.test(host) && /--url/.test(host) && /o\.Root = args\[\+\+i\]/.test(host));

// ── 5b. 桥接进程托管（P0-2：启动 / 停止 / 重启 / 守护 / 开机自启） ──────────
ok('托管入口：<root>\\node.exe（退回 PATH）+ src\\bridge.js，cwd=root',
  /Path\.Combine\(paths\.Root, "node\.exe"\)/.test(host)
  && /Path\.Combine\(paths\.Root, "src", "bridge\.js"\)/.test(host)
  && /psi\.WorkingDirectory = paths\.Root/.test(host)
  && /UseShellExecute = false/.test(host) && /CreateNoWindow = true/.test(host));
ok('detached 不阻塞：cmd /c 起 node，stdout/stderr 追进 logs\\bridge-stdout.log（壳退出不 EPIPE）',
  /new ProcessStartInfo\("cmd\.exe", args\)/.test(host)
  && /"logs", "bridge-stdout\.log"/.test(host) && />> \\"/.test(host) && /2>&1/.test(host));
ok('停止只杀自己记录过的 PID：taskkill /PID <pid> /T /F，绝不按镜像名杀 node',
  /"taskkill", "\/PID " \+ pid \+ " \/T \/F"/.test(host) && !/GetProcessesByName/.test(host));
ok('守护：意外退出 5 秒后重拉、最多 3 次/小时、超限停手并写明原因',
  /RestartDelayMs = 5000/.test(host) && /MaxAutoRestartsPerHour = 3/.test(host)
  && /gaveUp = true/.test(host) && /watchdog gave up/.test(host));
ok('守护日志 logs\\bridge-guard.log', /"logs", "bridge-guard\.log"/.test(host));
ok('启动等 /api/status 就绪，30 秒超时给可读提示（端口 + 两个日志路径）',
  /ReadyTimeoutMs = 30000/.test(host) && /ShowStartupTimeout/.test(host)
  && /启动超时/.test(host) && /守护日志/.test(host) && /BridgeProbe\.IsReady/.test(host));
ok('状态来自 GET /api/status?token=（读 state\\console-token，直连 127.0.0.1、绕系统代理）',
  /"http:\/\/127\.0\.0\.1:" \+ port \+ "\/api\/status\?token="/.test(host)
  && /Uri\.EscapeDataString\(token\)/.test(host) && /request\.Proxy = null/.test(host));
ok('令牌不进任何日志（BridgeLog 调用不带 token）', !/BridgeLog\.Write\([^)]*token/i.test(host));
ok('托盘有 打开 / 启动 / 重启 / 停止 / 退出',
  host.includes('"打开"') && host.includes('"启动桥接"') && host.includes('"重启桥接"')
  && host.includes('"停止桥接"') && host.includes('"退出"'));
ok('打开即托管：Shown 先探活，没起来就拉起（重启电脑后不再是错误页）',
  /Shown \+= delegate\s*\{/.test(host) && /OnShown\(\);/.test(host) && /EnsureBridgeReady/.test(host) && /WaitReadyAndLoad/.test(host));
ok('--autostart 登录拉起时直接进托盘（不弹窗）',
  /internal bool Autostart;/.test(host) && /if \(opt\.Autostart\)/.test(host) && /Hide\(\);/.test(host));
ok('关壳不杀桥接（只有「停止桥接」才 taskkill）',
  /host exit \(bridge left running, pid=/.test(host) && !/Cleanup\(\)\s*\{[\s\S]{0,400}KillTree/.test(host));
ok('开机自启默认关、写 HKCU\\...\\Run、可随时取消',
  /RunKeyPath = @"Software\\Microsoft\\Windows\\CurrentVersion\\Run"/.test(host)
  && /autostartItem\.Checked = Autostart\.IsEnabled\(\)/.test(host)
  && /DeleteValue\(ValueName, false\)/.test(host)
  && !/Autostart\.Set\(true/.test(host));
ok('壳只写 logs/ 与 window.json（不写 config.json / state）',
  (host.match(/File\.WriteAllText/g) || []).length === 1 && !/WriteAllText\((ConfigPath|paths\.ConfigPath)/.test(host));

// ── 6. 平台与仓库卫生 ──────────────────────────────────────────────────────
ok('PerMonitorV2 DPI 感知（清单）', /PerMonitorV2/.test(manifest) && /dpiAware/.test(manifest));
ok('应用清单被 csc 用上（/win32manifest 指向 desktop\\app.manifest）', /app\.manifest/.test(build));
ok('.gitignore 覆盖 desktop/vendor/', /desktop\/vendor\//.test(gitignore));
ok('.gitignore 覆盖 dist/', /^dist\/$/m.test(gitignore));
ok('C# 5 语法守卫：无字符串插值/?. /nameof',
  !/\$"/.test(host) && !/\?\.[A-Za-z]/.test(host) && !/nameof\(/.test(host));

// ── 7. 文档 ────────────────────────────────────────────────────────────────
ok('desktop/README.md 存在且写清构建命令', Boolean(readme) && /build-host\.ps1/.test(readme));
ok('docs/desktop-host.md 写了 WebView2 运行时缺失怎么处理',
  Boolean(docs) && /运行时/.test(docs) && /(缺失|没装)/.test(docs) && /2124703|Evergreen/.test(docs));

// ── 8. 更新检查 / 一键更新（6B） ───────────────────────────────────────────
const updateVer = read('desktop/UpdateVersion.cs');
ok('版本比较与更新源解析在独立文件 desktop/UpdateVersion.cs', Boolean(updateVer));
ok('build-host.ps1 把 UpdateVersion.cs 编进壳', /UpdateVersion\.cs/.test(build));
ok('更新源只读 config.json 的 desktop.updateUrl（空 = 关闭检查）',
  Boolean(updateVer) && /updateUrl/.test(host) && /ResolveUpdateUrl\(\)/.test(host)
  && /if \(string\.IsNullOrEmpty\(url\)\) \{ return; \}/.test(host));
ok('默认每 6 小时检查一次（常量 6*60*60*1000）',
  /UpdateCheckIntervalMs = 6 \* 60 \* 60 \* 1000/.test(host) && /updateTimer\.Interval = UpdateCheckIntervalMs/.test(host));
ok('WebView 就绪后才启动检查（不在启动瞬间抢网络）',
  /UpdateStatusUi\(\); StartUpdateCheckTimer\(\); InitWebViewAsync\(\)/.test(host));
ok('托盘显示「有新版本 vX.Y.Z（点击更新）」',
  host.includes('"有新版本 v" + info.Version + "（点击更新）"'));
ok('版本比较语义化逐段（1.10 > 1.9 等由下方实证覆盖）',
  /internal static int\? Compare\(string left, string right\)/.test(updateVer)
  && /Math\.Max\(a\.Length, b\.Length\)/.test(updateVer));
ok('更新源 JSON：只认 http(s)，version/url 必填',
  /StartsWith\("https:\/\/"/.test(updateVer) && /TryParse\(string json, out UpdateInfo info\)/.test(updateVer)
  && /Field\(json, "version"\)/.test(updateVer));
ok('不认识的版本号跳过并记日志（不当成有更新）',
  /int\? cmp = UpdateVersion\.Compare[\s\S]{0,200}?if \(cmp == null\)[\s\S]{0,260}?unparsable remote version/.test(host));
ok('必须二次确认，且说明「关机器人重装、state/config 保留」',
  /MessageBoxButtons\.YesNo/.test(host) && /state\/ 记忆库与 config\.json 会保留/.test(host));
ok('确认前不启动安装器（LaunchSetup 只在 StartUpdate 里调一次）',
  (host.match(/LaunchSetup\(/g) || []).length === 2);
ok('StartUpdate 只从 ConfirmUpdate 进入，点「否」什么都不做',
  (host.match(/StartUpdate\(/g) || []).length === 2
  && /!= DialogResult\.Yes\) \{ return; \}[\s\S]{0,80}?StartUpdate\(info\)/.test(host));
ok('安装器只由 LaunchSetup 里的 Process.Start(psi) 拉起（确认之外无其它安装入口）',
  /private void LaunchSetup\(string setup, UpdateInfo info\)[\s\S]{0,700}?Process\.Start\(psi\)/.test(host)
  && !/private void (ConfirmUpdate|StartUpdate|DownloadUpdate)\([^)]*\)[\s\S]{0,700}?Process\.Start\(/.test(host));
ok('安装包走现成静默参数 /S', /new ProcessStartInfo\(setup, "\/S"\)/.test(host));
ok('下载到 %TEMP%，不写 state/config', /Path\.GetTempPath\(\)/.test(host));
ok('有 sha256 就校验，不通过删文件并报错（不执行安装）',
  /if \(!string\.IsNullOrEmpty\(info\.Sha256\)\)/.test(host) && /sha256 校验不通过/.test(host)
  && /TryDelete\(temp\);/.test(host));
ok('失败原因在托盘说清（网络/校验/权限）',
  /private void UpdateFailed\(string reason\)/.test(host) && /BalloonTipText = reason/.test(host)
  && /update failed/.test(host));
ok('更新逻辑不把令牌写进日志/标题', !/BridgeLog\.Write\([^)]*[Tt]oken/.test(host));

// 版本比较与更新源解析是纯逻辑（不碰网络/UI）：用 csc 编成控制台程序真跑一遍。
const UPDATE_CMP_CASES = [
  ['1.10.0', '1.9.3', '1'],
  ['1.9.9', '1.10.0', '-1'],
  ['v2.0.0', '2.0.0', '0'],
  ['2.0.0-beta', '2.0.0', '0'],
  ['2.0.1-beta', '2.0.0', '1'],
  ['1.2', '1.2.0', '0'],
  ['1.0.0+build5', '1.0.0', '0'],
  ['abc', '1.0.0', 'null'],
  ['1.0.0', '', 'null'],
  ['1..2', '1.0.0', 'null'],
];
const UPDATE_PARSE_CASES = [
  ['{"version":"1.1.0","url":"https://example.invalid/setup.exe","sha256":"ABC"}', 'ok'],
  ['{"version":"1.1.0"}', 'bad'],
  ['not json', 'bad'],
  ['{"version":"x.y","url":"https://example.invalid/a.exe"}', 'bad'],
  ['{"version":"1.1.0","url":"file:///C:/tmp/a.exe"}', 'bad'],
];
{
  const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  if (!fs.existsSync(csc)) {
    skipped++;
    console.log(`  SKIP 版本比较 / 更新源解析实证：本机没有 csc.exe（${csc}）`);
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-updatever-'));
    const exe = path.join(tmp, 'harness.exe');
    const harness = path.join(tmp, 'Harness.cs');
    const lines = [
      'using System;',
      'namespace QdbDesktop',
      '{',
      '    internal static class UpdateVersionHarness',
      '    {',
      '        private static void C(string a, string b)',
      '        {',
      '            int? r = UpdateVersion.Compare(a, b);',
      '            Console.WriteLine("cmp|" + a + "|" + b + "|" + (r.HasValue ? r.Value.ToString() : "null"));',
      '        }',
      '        private static void P(string json)',
      '        {',
      '            UpdateInfo info;',
      '            bool ok = UpdateVersion.TryParse(json, out info);',
      '            Console.WriteLine("parse|" + (ok ? "ok" : "bad"));',
      '        }',
      '        private static void Main()',
      '        {',
    ];
    for (const [a, b] of UPDATE_CMP_CASES) lines.push(`            C("${a}", "${b}");`);
    for (const [json] of UPDATE_PARSE_CASES) lines.push(`            P("${json.replace(/"/g, '\\"')}");`);
    lines.push('        }', '    }', '}');
    fs.writeFileSync(harness, lines.join('\n'), 'utf8');
    const comp = spawnSync(csc, [
      '/nologo', '/codepage:65001', '/langversion:5', '/target:exe', '/out:' + exe,
      path.join(ROOT, 'desktop', 'UpdateVersion.cs'), harness,
    ], { encoding: 'utf8' });
    ok('UpdateVersion.cs 能独立编译（C# 5，只依赖 System，不碰 UI/网络）', comp.status === 0,
      ((comp.stdout || '') + (comp.stderr || '')).replace(/\s+/g, ' ').slice(0, 300));
    if (comp.status === 0) {
      const run = spawnSync(exe, [], { encoding: 'utf8', timeout: 20000 });
      ok('版本比较 / 解析实证程序运行成功', run.status === 0,
        (run.stderr || '').replace(/\s+/g, ' ').slice(0, 200));
      const out = (run.stdout || '').trim().split(/\r?\n/);
      for (const [a, b, want] of UPDATE_CMP_CASES) {
        ok(`版本比较 ${a} vs ${b || '(空)'} = ${want}`, out.includes(`cmp|${a}|${b}|${want}`));
      }
      const parseOut = out.filter((l) => l.startsWith('parse|'));
      UPDATE_PARSE_CASES.forEach(([, want], i) => {
        ok(`更新源解析用例 ${i + 1} = ${want}`, parseOut[i] === `parse|${want}`);
      });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 右键刷新（2026-11-02 用户要求）────────────────────────────────────────
const hostSrc = read('desktop/Host.cs') || '';
const ctxAssign = hostSrc.match(/AreDefaultContextMenusEnabled\s*=\s*([^;]+);/);
ok('右键菜单常开（不再只在 DevTools 模式）', !!ctxAssign && ctxAssign[1].indexOf('opt.DevTools') < 0,
  ctxAssign ? ctxAssign[1].trim() : '缺赋值');
ok('右键菜单里插入「刷新界面」并调用 Reload',
  hostSrc.indexOf('ContextMenuRequested += OnContextMenuRequested') >= 0
  && hostSrc.indexOf('刷新界面') >= 0 && hostSrc.indexOf('core.Reload()') >= 0);
ok('F5 / Ctrl+R 刷新脚本已注入页面',
  hostSrc.indexOf('qdbReload') >= 0 && hostSrc.indexOf('AddScriptToExecuteOnDocumentCreatedAsync') >= 0);

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n========== 通过 ${pass} / 失败 ${fail}${skipped ? ` / 跳过 ${skipped}` : ''} ==========`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
process.exit(0);
