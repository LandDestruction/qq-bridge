#!/usr/bin/env node
// test-installer.mjs —— 安装器静态断言（不执行安装包，跑得快、可在回归里跑）。
//
// 断言的是「契约」而不是实现细节：载荷清单的排除口径、卸载步骤齐全、快捷方式目标
// 是客户端 exe 而不是 cmd/msedge、无真实路径与群号、PS5.1 编码坑等。
// 真装链路由 scripts/installer/demo-install.ps1 跑（几十条运行时检查）；
// 「二次安装后 state/ 与用户 config.json 仍在」在下方 P0-3 段用真文件系统演练（不需要真装包）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER_DIR = path.join(ROOT, 'scripts', 'installer');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

// ── 1. 文件存在性 ───────────────────────────────────────────────────────────
const installerCs = read('scripts/installer/Installer.cs');
const stubCs = read('scripts/installer/stub-client.cs');
const buildPs1 = read('build-installer.ps1');
const demoPs1 = read('scripts/installer/demo-install.ps1');
const postPs1 = read('scripts/installer/post-install.ps1');
const payload = JSON.parse(read('scripts/installer/payload.json'));
const packExclude = JSON.parse(read('scripts/pack-exclude.json'));
const planDoc = read('docs/installer-plan.md');
const postInstallerSource = read('scripts/installer/post-install.ps1');

for (const rel of [
  'scripts/installer/Installer.cs',
  'scripts/installer/stub-client.cs',
  'scripts/installer/payload.json',
  'scripts/installer/post-install.ps1',
  'scripts/installer/version.txt',
  'scripts/installer/NOTICE.txt',
  'scripts/installer/demo-install.ps1',
  'build-installer.ps1',
  'docs/installer-plan.md'
]) check(`文件存在：${rel}`, exists(rel));

// ── 2. 载荷清单与 pack-exclude.json 口径一致 ────────────────────────────────
check('载荷清单引用 scripts/pack-exclude.json 作为唯一排除真源',
  payload.excludeSource === 'scripts/pack-exclude.json', `got=${payload.excludeSource}`);
check('pack-exclude.json 存在', exists(payload.excludeSource));

const bannedRoots = packExclude.removeAtRoot ?? [];
const bannedNames = packExclude.removeNameGlobs ?? [];
check('pack-exclude 把 state/logs/audio 列为根级排除',
  ['state', 'logs', 'audio'].every((d) => bannedRoots.includes(d)), `roots=${bannedRoots.join(',')}`);
check('pack-exclude 把 config.json 列为文件名排除',
  bannedNames.includes('config.json'), `names=${bannedNames.join(',')}`);
check('载荷被禁止项显式列了 config.json/state/logs/audio',
  ['config.json', 'state/', 'logs/', 'audio/'].every((b) => (payload.forbidden ?? []).includes(b)),
  `forbidden=${(payload.forbidden ?? []).join(',')}`);

const payloadEntries = [
  ...(payload.files ?? []).map((f) => ({ from: f.from, to: f.to ?? f.from })),
  ...(payload.dirs ?? []).map((d) => ({ from: d.from, to: d.to ?? d.from }))
];
check('载荷条目不落在排除目录里（state/logs/audio/dist）',
  payloadEntries.every((e) => !/^(state|logs|audio|dist)([\\/]|$)/.test(e.from)),
  payloadEntries.map((e) => e.from).join(','));
check('载荷条目不叫 config.json',
  payloadEntries.every((e) => path.basename(e.to) !== 'config.json' && path.basename(e.from) !== 'config.json'),
  payloadEntries.map((e) => e.to).join(','));
check('载荷里带 config.template.json（唯一允许进包的配置）',
  payloadEntries.some((e) => e.to === 'config.template.json'));
// node_modules 是 npm install 生成物：全新 clone 里没有属正常，构建脚本会在缺失时报错。
const missingSources = payloadEntries.filter((e) => !exists(e.from) && e.from !== 'node_modules');
check('载荷里每个来源在仓库里都存在（node_modules 允许由 npm install 生成）',
  missingSources.length === 0,
  missingSources.map((e) => e.from).join(',') || 'all present');

// ── 2b. L1 载荷：真产品（stub=false，带 src/dsh/node 运行时）──────────────
check('payload.stub 已关闭（L1 真载荷）', payload.stub === false, `stub=${payload.stub}`);
const dirNames = (payload.dirs ?? []).map((d) => d.from);
for (const need of ['src', 'node_modules', 'scripts', 'public', 'dsh', 'plugins', 'delivery/ops']) {
  check(`载荷含目录 ${need}`, dirNames.includes(need), dirNames.join(','));
}
check('载荷含 src/bridge.js 入口', payloadEntries.some((e) => e.from === 'src'));
check('载荷含 package.json / config.template.json',
  ['package.json', 'config.template.json'].every((f) => payloadEntries.some((e) => e.from === f)));
check('载荷声明了 nodeExe（目标机没 Node 也能跑）', !!payload.nodeExe && payload.nodeExe.to === 'node.exe');
check('构建脚本在剪枝后复制 node.exe（免得被 *.exe 规则删掉）',
  buildPs1.includes('node.exe') && buildPs1.includes('nodeMajor') && buildPs1.indexOf('node.exe') > buildPs1.indexOf('3b. client binaries'));
check('安装器支持 /port= 与 /owner= 参数（测试/共存用）',
  installerCs.includes('"/port="') && installerCs.includes('"/owner="'));
check('安装器在重装前停掉占用安装目录的进程（否则 node.exe 被锁无法覆盖）',
  installerCs.includes('StopOwnProcesses(dir);'));
// T28 回归：npm 依赖里的 dist/ 不能被剪（否则桥接报 ERR_MODULE_NOT_FOUND）
check('仓库 node_modules 里 js-yaml/dist 存在（依赖自带产物）',
  !exists('node_modules') || exists('node_modules/js-yaml/dist/js-yaml.mjs'));
check('构建脚本对 node_modules 子树免疫任何剪枝', buildPs1.includes('^node_modules'));
check('构建脚本有 payload node_modules 完整性硬闸',
  buildPs1.includes('payload node_modules incomplete') &&
  buildPs1.includes('node_modules/js-yaml/dist/js-yaml.mjs'));
check('post-install 会起桥接（node.exe src\\bridge.js）',
  postInstallerSource.includes('src\\bridge.js') && postInstallerSource.includes('Test-Port'));
check('post-install 会清理模板占位符（ownerQQ/allow.groups）',
  postInstallerSource.includes('ownerQQ') && postInstallerSource.includes('allow.groups'));
check('安装完成页写明 DSH 依赖', installerCs.includes('DeepSeek Harness') || installerCs.includes('DSH'));
// ── 3. 构建脚本 ─────────────────────────────────────────────────────────────
check('构建脚本读取载荷清单', buildPs1.includes('payload.json'));
check('构建脚本复用 pack-exclude.json 剪枝', buildPs1.includes('pack-exclude.json'));
check('构建脚本用系统自带 csc 编译（不依赖 Inno/NSIS/7z）',
  buildPs1.includes('csc.exe') && !/\b(iscc|makensis|7z)\b/.test(buildPs1));
check('构建脚本把载荷 zip 作为嵌入资源打进 setup',
  buildPs1.includes('"/resource:$zip,payload.zip"'));
check('构建脚本有「禁止项残留」硬闸（命中即失败）',
  buildPs1.includes('forbidden payload root entry') && buildPs1.includes('real config.json must not be in the payload'));

// ── 4. 安装器：卸载键与快捷方式契约 ─────────────────────────────────────────
check('卸载键是 HKCU\\...\\Uninstall\\QQDeepSeekBot',
  installerCs.includes('Uninstall\\QQDeepSeekBot') && installerCs.includes('Registry.CurrentUser'));
check('安装器不往 HKLM 写注册表（只读 WebView2）',
  !installerCs.includes('Registry.LocalMachine.CreateSubKey') &&
  !installerCs.includes('Registry.LocalMachine.OpenSubKey(UninstallKeyPath'));
check('卸载项含 DisplayName/DisplayVersion/Publisher',
  ['"DisplayName"', '"DisplayVersion"', '"Publisher"'].every((k) => installerCs.includes(k)));
check('卸载项含 DisplayIcon/UninstallString/QuietUninstallString/InstallLocation',
  ['"DisplayIcon"', '"UninstallString"', '"QuietUninstallString"', '"InstallLocation"'].every((k) => installerCs.includes(k)));
check('DisplayIcon 指向客户端 exe', /k\.SetValue\("DisplayIcon",\s*exe \+ ",0"\)/.test(installerCs));
check('UninstallString 指向安装目录里的 Uninstall.exe',
  installerCs.includes('Path.Combine(dir, UninstallExeName) + "\\" /uninstall"'));

check('快捷方式目标是安装目录里的客户端 exe',
  installerCs.includes('string exe = Path.Combine(dir, ExeName);') &&
  installerCs.includes('CreateShortcut(Path.Combine(DesktopDir(), ShortcutName), exe, dir, linkArgs)') &&
  installerCs.includes('CreateShortcut(Path.Combine(ProgramsDir(), ShortcutName), exe, dir, linkArgs)'));
check('快捷方式带 --root <安装目录>（T20 宿主靠它找 src/bridge.js）',
  installerCs.includes('string linkArgs = "--root \\"" + dir + "\\"";') &&
  installerCs.includes('lt.InvokeMember("Arguments"'));
check('载荷带 WebView2 宿主运行时 DLL',
  (payload.clientRuntime ?? []).some((r) => r.to === 'WebView2Loader.dll') &&
  (payload.clientRuntime ?? []).some((r) => r.to === 'Microsoft.Web.WebView2.Core.dll'));
check('载荷客户端 exe 走 dist/desktop（T20 产物路径）',
  payload.clientExe?.from === 'dist/desktop/QQDeepSeekBot.exe');
check('快捷方式目标不是 cmd.exe / msedge',
  !/CreateShortcut\([^)]*"(cmd|msedge)/i.test(installerCs) && !installerCs.includes('msedge'));
check('快捷方式名是 QQ DeepSeek Bot.lnk',
  installerCs.includes('const string ShortcutName = "QQ DeepSeek Bot.lnk"'));

// ── 5. 卸载步骤齐全 ─────────────────────────────────────────────────────────
for (const fn of ['StopOwnProcesses', 'RemoveShortcuts', 'RemoveUninstallKey', 'DeleteDirDeferred']) {
  check(`卸载调用 ${fn}`, new RegExp(`${fn}\\(dir\\)`).test(installerCs) || new RegExp(`${fn}\\(\\)`).test(installerCs));
}
check('卸载会停掉安装目录里自己起的进程',
  installerCs.includes('StopOwnProcesses') && installerCs.includes('p.Kill()'));

// ── 6. 幂等 / 安装目录覆盖 / WebView2 ───────────────────────────────────────
check('有幂等标记 .installed.json',
  installerCs.includes('const string MarkerName = ".installed.json"'));
check('二次安装不覆盖已存在的 config.json',
  installerCs.includes('config.json kept (idempotent re-install, user edits preserved)') ||
  installerCs.includes('keep existing " + rel'));
check('安装目录可参数覆盖（/D=）且默认 %LOCALAPPDATA%\\QQDeepSeekBot',
  installerCs.includes('"/D="') &&
  installerCs.includes('Environment.SpecialFolder.LocalApplicationData') &&
  installerCs.includes('"QQDeepSeekBot"'));
check('检测 WebView2 运行时（GUID 键 + pv）',
  installerCs.includes('{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}') && installerCs.includes('"pv"'));
check('WebView2 缺失时给官方下载链接并 exit 3',
  installerCs.includes('https://developer.microsoft.com/microsoft-edge/webview2/') &&
  /return 3;/.test(installerCs));

// ── 7. 品牌 / 声明 / 无本机路径与真实号码 ───────────────────────────────────
check('安装完成页/卸载确认页带非官方声明',
  installerCs.includes('Not affiliated with Tencent or DeepSeek') &&
  installerCs.includes('NotAffiliated') && installerCs.includes('new DoneForm(dir, NotAffiliated'));
check('NOTICE.txt 写明非腾讯/非 DeepSeek 官方产品',
  read('scripts/installer/NOTICE.txt').includes('Not affiliated with Tencent or DeepSeek'));
check('安装包命名 QQDeepSeekBot-Setup-<version>.exe',
  payload.product.setupName === 'QQDeepSeekBot-Setup-{version}.exe');
check('版本号是 semver',
  /^\d+\.\d+\.\d+/.test(read('scripts/installer/version.txt').trim()));

const scanned = { 'Installer.cs': installerCs, 'stub-client.cs': stubCs, 'build-installer.ps1': buildPs1,
  'payload.json': JSON.stringify(payload), 'demo-install.ps1': demoPs1 };
const localPathHits = Object.entries(scanned).filter(([, text]) => /[A-Za-z]:\\Users\\/.test(text));
check('安装器资产里没有本机绝对路径（C:\\Users\\...）', localPathHits.length === 0,
  localPathHits.map(([n]) => n).join(',') || 'clean');
// GUID（WebView2 注册表键）里的十六进制段会被 \d{6,12} 误命中，先剥掉再扫；
// 只看字符串字面量：真实 QQ/群号只会以字符串形式出现，180000（超时毫秒）这类
// 代码里的数字常量不该误判。
const stripGuids = (text) => text.replace(/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g, '<guid>');
const stringLiterals = (text) => (text.match(/"[^"\r\n]*"/g) || []).join('\n');
// 100000001/100000000 是安装器测试用的假号，不算真实 QQ
const fakeNumbers = /\b10000000[01]\b/g;
const numberHits = Object.entries(scanned).filter(([, text]) =>
  /(?<!\d)\d{6,12}(?!\d)/.test(stripGuids(stringLiterals(text)).replace(fakeNumbers, '<fake>')));
check('安装器资产里没有真实 QQ/群号（字符串里的 6-12 位连续数字）', numberHits.length === 0,
  numberHits.map(([n]) => n).join(',') || 'clean');

// ── 8. 编码坑 / demo 脚本 / 文档 ────────────────────────────────────────────
const ps1Files = fs.readdirSync(INSTALLER_DIR).filter((f) => f.endsWith('.ps1'))
  .map((f) => path.join(INSTALLER_DIR, f));
// PS 5.1 把无 BOM 的 UTF-8 当 ANSI 读：非 ASCII 注释会被拆成乱码字节，可能吃掉下一行。
// 约定：.ps1 要么纯 ASCII，要么 UTF-8 带 BOM。
const badPs1 = ps1Files.filter((p) => {
  const buf = fs.readFileSync(p);
  const hasBom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  const text = buf.toString('utf8');
  const nonAscii = /[^\x00-\x7F]/.test(text);
  return nonAscii && !hasBom;
});
check('scripts/installer/*.ps1 非 ASCII 时必须带 UTF-8 BOM（否则 PS5.1 当 ANSI 解析出错）',
  badPs1.length === 0, badPs1.map((p) => path.basename(p)).join(',') || 'ok');
check('安装器源码声明了 csc 源码编码要求（/codepage:65001 在构建脚本里）',
  buildPs1.includes('/codepage:65001'));

check('demo 拒绝装到真实安装目录',
  demoPs1.includes('refusing to demo into the real install dir'));
check('demo 卸载后三查（目录/注册表/快捷方式）',
  demoPs1.includes('check 1: install dir removed') &&
  demoPs1.includes('check 2: uninstall registry key removed') &&
  demoPs1.includes('check 3a: desktop shortcut removed') &&
  demoPs1.includes('check 3b: start menu shortcut removed'));
check('post-install.ps1 被载荷映射到 ops/',
  payloadEntries.some((e) => e.from === 'scripts/installer/post-install.ps1' && e.to === 'ops/post-install.ps1'));

for (const route of ['路线 A', '路线 B', '路线 C', '路线 D']) {
  check(`方案文档覆盖 ${route}`, planDoc.includes(route));
}
for (const dim of ['包体积', '离线', '管理员权限', '卸载', '升级', 'SmartScreen', '失败模式']) {
  check(`方案文档对比维度含「${dim}」`, planDoc.includes(dim));
}
check('方案文档写明未签名 / SmartScreen 提示不能免',
  planDoc.includes('没有代码签名证书') || planDoc.includes('无代码签名证书'));

// ── 9. P0-3：二次安装不丢 state/ 与用户改过的 config.json ─────────────────────
// 升级 = 在同一个安装目录上再跑一次 setup。契约：载荷解压是合并式的（只建目录、程序文件覆盖、
// config.json 已存在则跳过），安装流程从不删除安装目录；state/ 只归桥接写，既不在载荷里也没人碰。
const extractBody = (() => {
  const start = installerCs.indexOf('static void ExtractPayload');
  const end = installerCs.indexOf('static void WriteUninstallKey');
  return start >= 0 && end > start ? installerCs.slice(start, end) : '';
})();
check('载荷解压是合并式（不删目录、不删旧文件）',
  extractBody.length > 0 && !/Directory\.Delete|File\.Delete|rmdir/.test(extractBody),
  extractBody ? '' : 'ExtractPayload 未找到');
check('安装流程不删除安装目录（只有卸载的 DeleteDirDeferred 走延迟 rmdir）',
  !/Directory\.Delete\(/.test(installerCs) &&
  installerCs.slice(installerCs.indexOf('static bool InstallSteps'), installerCs.indexOf('static void ExtractPayload')).indexOf('rmdir') === -1 &&
  installerCs.slice(installerCs.indexOf('static bool DeleteDirDeferred'), installerCs.indexOf('static string DetectWebView2')).includes('rmdir /s /q'));
check('state/ 不在载荷里，且被显式列为禁止项',
  (payload.forbidden ?? []).includes('state/') &&
  payloadEntries.every((e) => !/^state([\\/]|$)/.test(e.from)));
check('二次安装跳过已有 config.json（代码分支 + 日志文案）',
  /keep existing " \+ rel/.test(installerCs) && installerCs.includes('config.json kept'));
check('安装器从不创建/写 state/（state 只归桥接）', !/Path\.Combine\(dir, "state"/.test(installerCs));

// 纯逻辑复刻 ExtractPayload 的合并语义，在真文件系统上演练
// 「v1 安装 → 用户改 config + 产生 state/ 数据 → v2 覆盖安装」，断言用户数据还在、程序文件已更新。
function applyPayloadLikeInstaller(dir, files) {
  for (const f of files) {
    const dest = path.join(dir, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (f.rel.replace(/\\/g, '/') === 'config.json' && fs.existsSync(dest)) continue;
    fs.writeFileSync(dest, f.body);
  }
}
const upgradeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-upgrade-'));
try {
  applyPayloadLikeInstaller(upgradeTmp, [
    { rel: 'config.json', body: '{"consolePort":3100,"v":1}' },
    { rel: 'src/bridge.js', body: '// v1' },
    { rel: 'QQDeepSeekBot.exe', body: 'exe-v1' }
  ]);
  fs.mkdirSync(path.join(upgradeTmp, 'state'), { recursive: true });
  fs.writeFileSync(path.join(upgradeTmp, 'state', 'social-v2.json'), '{"memories":[1,2,3]}');
  fs.writeFileSync(path.join(upgradeTmp, 'state', 'stickers.json'), '{"stickers":[{"id":"s1"}]}');
  fs.writeFileSync(path.join(upgradeTmp, 'config.json'), '{"consolePort":3100,"v":1,"userEdit":true}');
  applyPayloadLikeInstaller(upgradeTmp, [
    { rel: 'config.json', body: '{"consolePort":3100,"v":2}' },
    { rel: 'src/bridge.js', body: '// v2' },
    { rel: 'QQDeepSeekBot.exe', body: 'exe-v2' }
  ]);
  const rd = (p) => fs.readFileSync(path.join(upgradeTmp, p), 'utf8');
  check('二次安装：state/ 下文件逐字节保留',
    rd('state/social-v2.json') === '{"memories":[1,2,3]}' &&
    rd('state/stickers.json') === '{"stickers":[{"id":"s1"}]}');
  check('二次安装：用户改过的 config.json 保留', rd('config.json').includes('"userEdit":true'));
  check('二次安装：程序文件被新版覆盖', rd('src/bridge.js') === '// v2' && rd('QQDeepSeekBot.exe') === 'exe-v2');
} finally {
  fs.rmSync(upgradeTmp, { recursive: true, force: true });
}

// ── 10. 开机自启（可选，默认关；卸载必须清）─────────────────────────────────
check('安装器支持 /autostart 参数（静默安装默认不写 Run 键）', installerCs.includes('"/autostart"'));
check('写 HKCU\\...\\Run：值名 QQDeepSeekBot，命令带 --root 安装目录',
  installerCs.includes('Software\\Microsoft\\Windows\\CurrentVersion\\Run') &&
  installerCs.includes('const string AutostartValueName = "QQDeepSeekBot"') &&
  /--root \\"/.test(installerCs));
check('完成页有「开机自动启动」勾选框（用户可取消，不强制）',
  installerCs.includes('开机自动启动') && installerCs.includes('Checked = autoStart'));
check('卸载会清掉开机自启（不留 Run 键）',
  /RemoveAutostart\(\)/.test(installerCs) && installerCs.includes('static bool RemoveAutostart()'));

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  if (!r.ok) console.log(`FAIL ${r.name}${r.detail ? ' | ' + r.detail : ''}`);
}
console.log(`\ntest-installer: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log(`失败 ${failed.length} 项`);
  process.exit(1);
}
