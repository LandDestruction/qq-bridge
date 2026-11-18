// 打包排除清单的回归套件：把 scripts/pack-exclude.json 从「一份文档式清单」变成「可被测试证明的约束」。
//
// 为什么需要它：T13 之前，打包排除规则是硬编码在 pack-project*.ps1 里的名字数组，改漏一条不会报错，
// 只会在某次出包时把 state/、.env、本机路径悄悄打进 zip（已发生过一次：23 个带本机路径的文件全进包）。
// 现在的规则集中在 scripts/pack-exclude.json，但「清单写了不等于真生效」——拼错名字、漏一条 glob、
// 或 ps1 里又长出第二份名单，都会静默退化成「没排除」。这个套件就是那道回归闸。
//
// 三条设计原则（对应任务要求）：
//   ① 双轨探针：**契约**是一份写死的「无论清单怎么改都必须排除」的样本表（删规则 → 必红）；
//      **清单增量**再给每条现有规则造探针（加规则 → 也被覆盖）。只有清单驱动的探针是不够的：
//      删掉一条规则时那些探针也一起消失，套件会永远绿（我第一版就踩了这个坑，变异测试抓出来的）。
//   ② 负例必须真红：脏 stage 跑真实 scanner 必须 exit 1 且点名文件；空 stage 必须 exit 2。
//   ③ 不再各写一份匹配逻辑：排除由**真实的** pack-project*.ps1 执行，判定由**真实的**
//      pack-egress-scan.mjs --stage 执行。本文件不实现 glob→正则，只读 JSON 拿规则名造样本。
//
// 约束：全程 %TEMP%；不写真实 config.json / state / logs / audio；不产 zip（-DryRun）；不联网。
// 用法：node scripts/test-pack-exclude.mjs        退出码 0 全过 / 1 有失败 / 2 环境不对。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'scripts', 'pack-exclude.json');
const SCANNER = path.join(ROOT, 'scripts', 'pack-egress-scan.mjs');
const PS1 = {
  normal: 'scripts\\pack-project.ps1',
  full: 'scripts\\pack-project-full.ps1',
};

let pass = 0;
const failures = [];
/** 记录一条断言；通过时静默（由 okLine 统一打印 ✅）。返回是否通过。 */
function check(name, ok, detail = '') {
  if (ok) { pass += 1; return true; }
  failures.push(`${name}${detail ? `  —— ${detail}` : ''}`);
  console.log(`  ❌ ${name}${detail ? `  —— ${detail}` : ''}`);
  return false;
}
function okLine(name) { console.log(`  ✅ ${name}`); }

for (const [label, p] of [['pack-exclude.json', MANIFEST], ['pack-egress-scan.mjs', SCANNER], ['pack-project.ps1', path.join(ROOT, PS1.normal)], ['pack-project-full.ps1', path.join(ROOT, PS1.full)]]) {
  if (!fs.existsSync(p)) { console.error(`[test-pack-exclude] 缺少 ${label}：${p}`); process.exit(2); }
}
const which = spawnSync('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
if (which.error || which.status !== 0) { console.error('[test-pack-exclude] 找不到 powershell（本套件要跑真实打包脚本）'); process.exit(2); }

const rules = JSON.parse(fs.readFileSync(MANIFEST, 'utf8').replace(/^\uFEFF/, ''));

// ── 契约：不管清单怎么写，这些样本都不许进包（删规则 → 这里必红）────────────────
const CONTRACT = {
  '运行时数据目录': ['state/messages.db', 'logs/bridge.log', 'audio/tts/x.mp3', 'dist/x.zip', '.git/HEAD'],
  '任意层级同名目录': ['docs/state/nested.txt', 'tools/__pycache__/x.pyc', 'docs/.npm-cache/x'],
  '内部文档/审计': [
    'docs/audits/a.md', 'docs/design/a.md', 'docs/legacy/a.md', 'docs/research/a.md',
    'docs/qq-bridge-PUBLISH_PLAN.md', 'docs/qq-bridge-SECURITY_AUDIT.md',
    'docs/guides/PROJECT_GUIDE.md', 'docs/guides/VOICE.md',
  ],
  '按文件名排除': ['docs/run.log', 'docs/x.bak-2026', 'docs/.env', 'docs/.env.local', 'tools/x.pyc', 'scripts/privacy-rules.json', 'config.json', 'docs/config.json'],
  '根目录内部 md 与游离脚本': [
    'TOKEN_COST.md', 'PROJECT_GUIDE.md', 'ARCH_REVIEW.md', 'DSH_QQ_TOOLS_PLAN.md', 'GEN2_SIMULATION_PLAN.md',
    'SOCIAL_MODE_PLAN.md', 'RESEARCH_QQ_MESSAGE_DND.md', 'RESEARCH_SNOWLUMA_EMOJI_STICKER.md',
    'SnowLuma功能调研.md', '真人语感策略.md', 'LOCAL_MODEL_SIZING.md', 'stray.py',
  ],
};
const CONTRACT_COUNT = Object.values(CONTRACT).reduce((n, l) => n + l.length, 0);

const tmpRoots = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
function write(abs, content = 'probe') {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
const globSample = (g) => (g.includes('*') ? g.replace(/\*/g, 'probe') : g);

// ── 1. 清单自身：结构合法、条目写法合法 ───────────────────────────────────────
{
  const required = ['removeAtRoot', 'removeDirsAnywhere', 'removePaths', 'removeNameGlobs', 'removeRootNameGlobs', 'modeExtra', 'sanitize'];
  const missing = required.filter((k) => !(k in rules));
  if (check('清单包含全部必需字段', missing.length === 0, `缺：${missing.join(',')}`)) okLine('清单包含全部必需字段');

  const allNames = [
    ...(rules.removeAtRoot ?? []), ...(rules.removeDirsAnywhere ?? []),
    ...(rules.removeNameGlobs ?? []), ...(rules.removeRootNameGlobs ?? []), ...(rules.removePaths ?? []),
  ];
  const bad = allNames.filter((n) => typeof n !== 'string' || !n.trim() || /^[A-Za-z]:/.test(n) || n.startsWith('/') || n.split(/[\\/]/).includes('..'));
  if (check('清单条目都是相对路径/模式下且非空', bad.length === 0, `可疑条目：${JSON.stringify(bad)}`)) okLine('清单条目都是相对路径/模式且非空');

  if (check('sanitize 有二进制黑名单和 ≥2 条路径脱敏模式', Array.isArray(rules.sanitize?.binaryExtensions) && rules.sanitize.binaryExtensions.length > 0 && Array.isArray(rules.sanitize?.patterns) && rules.sanitize.patterns.length >= 2)) {
    okLine('sanitize 有二进制黑名单与路径脱敏模式');
  }
}

// ── 2. 两个打包脚本读同一份清单，且没有第二份硬编码名单 ────────────────────────
{
  for (const [mode, rel] of Object.entries(PS1)) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const ok = check(`${mode}: 读清单 / 无 $excludeNames / 有 stage 闸`,
      text.includes('pack-exclude.json') && !text.includes('$excludeNames') && /pack-egress-scan/.test(text) && /--stage/.test(text));
    if (ok) okLine(`${mode}: 读清单 / 无硬编码名单 / 写包前有 stage 闸`);
  }
  if (check('scanner 支持 --stage', fs.readFileSync(SCANNER, 'utf8').includes("'--stage'"))) okLine('scanner 支持 --stage');
}

// ── 3. fixture：契约探针 + 清单增量探针 + 必须留下的正例 ───────────────────────
const STAGE_RE = /DRYRUN OK: stage ready at (.+?) \(no zip written\)/;

function buildFixture() {
  const fx = tmpDir('pack-exclude-fx-');
  fs.mkdirSync(path.join(fx, 'scripts'), { recursive: true });
  for (const src of [MANIFEST, SCANNER, path.join(ROOT, PS1.normal), path.join(ROOT, PS1.full)]) {
    fs.copyFileSync(src, path.join(fx, 'scripts', path.basename(src)));
  }

  // 正例（必须活到 stage）
  write(path.join(fx, 'src', 'a.js'), 'export const a = 1;\n');
  write(path.join(fx, 'docs', 'README.md'), '# readme\n');
  write(path.join(fx, 'public', 'client.html'), '<html></html>\n');
  write(path.join(fx, 'package.json'), '{"name":"fx"}\n');
  write(path.join(fx, 'config.example.json'), '{}\n');
  // DSH 侧安装源与交付模板：少了它们对方拿到包跑不了 setup-dsh（D41 实证 ENOENT）。
  write(path.join(fx, 'config.template.json'), '{}\n');
  write(path.join(fx, 'dsh', 'agent-presets', 'qq-chat', 'preset.yml'), 'name: fx\n');
  write(path.join(fx, 'dsh', 'agent-presets', 'qq-chat', 'agent.cordis.yml'), 'name: fx\n');
  write(path.join(fx, 'plugins', 'qq-agent-presets', 'package.json'), '{"name":"fx"}\n');
  write(path.join(fx, 'assets', 'icon.txt'), 'icon\n');
  // T19/T20：桌面宿主的源码必须随包（否则对方拿到包编不出 exe），
  // 但它的 SDK 缓存（desktop/vendor，首次构建会下 ~9.4MB 并解压）、构建产物（dist/）与
  // 任何 *.exe 都必须被排除 —— 打包器是白名单制，所以正反两条都要有探针。
  write(path.join(fx, 'desktop', 'Host.cs'), 'class Host {}\n');
  write(path.join(fx, 'desktop', 'Brand.cs'), 'static class Brand {}\n');
  write(path.join(fx, 'desktop', 'app.manifest'), '<assembly/>\n');
  write(path.join(fx, 'desktop', 'README.md'), '# desktop host\n');
  write(path.join(fx, 'scripts', 'desktop', 'build-host.ps1'), 'Write-Host build\n');
  write(path.join(fx, 'desktop', 'vendor', 'webview2', 'Microsoft.Web.WebView2.Core.dll'), 'binary\n');
  write(path.join(fx, 'desktop', 'vendor', 'cache', 'microsoft.web.webview2.1.0.4314.35.nupkg'), 'binary\n');
  write(path.join(fx, 'dist', 'desktop', 'QQDeepSeekBot.exe'), 'MZ\n');
  write(path.join(fx, 'desktop', 'bin', 'Stray.exe'), 'MZ\n');
  // T21/T17：安装器产物同样绝不能进包（默认输出 dist\installer\QQDeepSeekBot-Setup-<ver>.exe），
  // 而安装器源码/载荷清单要随包（交付包里没有它们就装不起来）。
  write(path.join(fx, 'scripts', 'installer', 'payload.json'), '{"stub":true}\n');
  write(path.join(fx, 'scripts', 'installer', 'Installer.cs'), 'class Setup {}\n');
  write(path.join(fx, 'scripts', 'installer', 'post-install.ps1'), 'Write-Host post\n');
  write(path.join(fx, 'scripts', 'installer', 'version.txt'), '0.1.0\n');
  write(path.join(fx, 'build-installer.ps1'), 'Write-Host build\n');
  write(path.join(fx, 'dist', 'installer', 'QQDeepSeekBot-Setup-0.1.0.exe'), 'MZ\n');
  write(path.join(fx, 'QQDeepSeekBot-Setup-0.1.0.exe'), 'MZ\n');
  // 私人角色卡：roles/ 当前刻意不随包，探针必须留在原地。
  write(path.join(fx, 'roles', 'private-card.md'), 'SECRET PERSONA\n');
  write(path.join(fx, 'tools', 'stt.py'), 'print(1)\n');
  write(path.join(fx, 'tools', 'kept.py'), '# tools/*.py 必须留下\n');
  // 脱敏探针：内容带本机绝对路径
  write(path.join(fx, 'docs', 'CHANGELOG.md'), 'installed at C:\\Users\\probe\\app\\bin and E:\\probe-data\\x\n');
  write(path.join(fx, 'scripts', 'machine.ps1'), '$p = "C:\\Users\\probe\\app\\bin\\node.exe"\n');

  // ① 契约探针（写死；删清单规则时它们仍在 fixture 里 → 会留在 stage → 红）
  for (const list of Object.values(CONTRACT)) for (const rel of list) write(path.join(fx, rel));
  // ② 清单增量探针（清单新增规则时自动覆盖）
  for (const n of rules.removeAtRoot ?? []) write(path.join(fx, n, 'probe.txt'));
  for (const n of rules.removeDirsAnywhere ?? []) write(path.join(fx, 'docs', n, 'probe.txt'));
  for (const rel of rules.removePaths ?? []) {
    const abs = path.join(fx, rel);
    if (rel.toLowerCase().endsWith('.md')) write(abs);
    else write(path.join(abs, 'probe.txt'));
  }
  for (const g of rules.removeNameGlobs ?? []) {
    write(path.join(fx, 'docs', globSample(g)));
    if (g === 'config.json') write(path.join(fx, 'config.json'));
    if (g === 'privacy-rules.json') write(path.join(fx, 'scripts', 'privacy-rules.json'));
  }
  for (const g of rules.removeRootNameGlobs ?? []) write(path.join(fx, globSample(g)));

  // full 模式专用：node_modules 与其编译产物
  write(path.join(fx, 'node_modules', 'pkg', 'index.js'), 'module.exports=1;\n');
  write(path.join(fx, 'node_modules', 'pkg', 'dist', 'index.js'), 'module.exports=2;\n');
  return fx;
}

function runDryRun(fx, mode) {
  const res = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1[mode], '-DryRun'], {
    cwd: fx, encoding: 'utf8', timeout: 180000,
  });
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  const m = out.match(STAGE_RE);
  return { status: res.status, out, stage: m ? m[1].trim() : null };
}
// 异步版：并发用例要在同一分钟内真正同时跑两份 powershell，spawnSync 做不到。
function runDryRunAsync(fx, mode) {
  return new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1[mode], '-DryRun'], { cwd: fx });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (status) => {
      const m = out.match(STAGE_RE);
      resolve({ status, out, stage: m ? m[1].trim() : null });
    });
  });
}
const stageHas = (stage, rel) => fs.existsSync(path.join(stage, rel));
// 列 stage 下全部文件（posix 相对路径），用于「任何目录都不许出现 *.exe」这类全局断言。
const walkFiles = (dir, base = dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(abs, base, out);
    else if (e.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
};

// ── 4. 普通包端到端 ─────────────────────────────────────────────────────────
const fx = buildFixture();
const normal = runDryRun(fx, 'normal');
if (normal.stage) tmpRoots.push(normal.stage);
const gateCause = (out) => out.split('\n').filter((l) => /❌|敏感文件名|残留/.test(l)).slice(0, 3).map((l) => l.trim()).join(' / ');
if (check('普通包 -DryRun 通过（stage 闸 exit 0）', normal.status === 0 && !!normal.stage, `exit=${normal.status} 闸门：${gateCause(normal.out) || normal.out.slice(-200)}`)) {
  okLine('普通包 -DryRun 通过（stage 闸 exit 0）');
}

if (normal.stage) {
  const stage = normal.stage;
  // 契约断言按类别分组，漏了什么一目了然
  for (const [label, list] of Object.entries(CONTRACT)) {
    const leaked = list.filter((rel) => stageHas(stage, rel));
    if (check(`契约：${label}（${list.length} 个探针）全部没进包`, leaked.length === 0, `漏排除：${leaked.join(', ')}`)) {
      okLine(`契约：${label}（${list.length} 个探针）全部没进包`);
    }
  }
  // 清单增量探针：每条规则都被真实脚本执行过
  const manifestLeaks = [];
  for (const n of rules.removeAtRoot ?? []) if (stageHas(stage, n)) manifestLeaks.push(`${n}/`);
  for (const n of rules.removeDirsAnywhere ?? []) if (stageHas(stage, `docs/${n}`)) manifestLeaks.push(`docs/${n}/`);
  for (const rel of rules.removePaths ?? []) if (stageHas(stage, rel)) manifestLeaks.push(rel);
  for (const g of rules.removeNameGlobs ?? []) {
    const s = globSample(g);
    if (stageHas(stage, `docs/${s}`) && !Object.values(CONTRACT).flat().includes(`docs/${s}`)) manifestLeaks.push(`docs/${s}`);
  }
  for (const g of rules.removeRootNameGlobs ?? []) {
    const s = globSample(g);
    if (stageHas(stage, s)) manifestLeaks.push(s);
  }
  if (check('清单每条规则都真的生效（增量探针无静默失效）', manifestLeaks.length === 0, `漏排除：${manifestLeaks.join(', ')}`)) {
    const n = (rules.removeAtRoot ?? []).length + (rules.removeDirsAnywhere ?? []).length + (rules.removePaths ?? []).length + (rules.removeNameGlobs ?? []).length + (rules.removeRootNameGlobs ?? []).length;
    okLine(`清单每条规则都真的生效（${n} 条增量探针）`);
  }

  for (const keep of ['src/a.js', 'docs/README.md', 'public/client.html', 'package.json', 'config.example.json',
    'config.template.json', 'dsh/agent-presets/qq-chat/preset.yml', 'dsh/agent-presets/qq-chat/agent.cordis.yml',
    'plugins/qq-agent-presets/package.json', 'assets/icon.txt', 'tools/stt.py', 'tools/kept.py']) {
    check(`正例保留：${keep}`, stageHas(stage, keep));
  }
  okLine('正例（源码/公开文档/tools/*.py/config.example.json）全部保留');

  // 交付内容契约：DSH 侧安装要读的源必须进包，否则 setup-dsh 在第 4 步 ENOENT。
  const dshSide = ['dsh/agent-presets/qq-chat/preset.yml', 'dsh/agent-presets/qq-chat/agent.cordis.yml',
    'plugins/qq-agent-presets/package.json', 'assets/icon.txt', 'config.template.json'];
  if (check('交付契约：dsh/ plugins/ assets/ config.template.json 都进 stage', dshSide.every((rel) => stageHas(stage, rel)), `缺：${dshSide.filter((rel) => !stageHas(stage, rel)).join(', ')}`)) {
    okLine('交付契约：DSH 侧安装源与配置模板全部进 stage');
  }
  // roles/ 是私人角色卡，当前刻意不随包；等用户拍板后要改这条契约 + 白名单，不能悄悄放开。
  if (check('交付契约：私人角色卡（roles/）不进 stage', !stageHas(stage, 'roles') && !stageHas(stage, 'roles/private-card.md'))) {
    okLine('交付契约：私人角色卡（roles/）不进 stage');
  }

  // T19：桌面宿主（T20）必须能随包交付，但绝不能把 SDK 缓存/构建产物/二进制带进去。
  const desktopSources = ['desktop/Host.cs', 'desktop/Brand.cs', 'desktop/app.manifest',
    'desktop/README.md', 'scripts/desktop/build-host.ps1'];
  const missingDesktop = desktopSources.filter((rel) => !stageHas(stage, rel));
  if (check('交付契约：desktop/ 宿主源码与构建脚本进 stage', missingDesktop.length === 0, `缺：${missingDesktop.join(', ')}`)) {
    okLine('交付契约：desktop/ 宿主源码与构建脚本进 stage');
  }
  const bannedDesktop = ['desktop/vendor', 'desktop/vendor/cache/microsoft.web.webview2.1.0.4314.35.nupkg',
    'desktop/vendor/webview2/Microsoft.Web.WebView2.Core.dll', 'dist', 'dist/desktop/QQDeepSeekBot.exe',
    'desktop/bin/Stray.exe'];
  const leakedDesktop = bannedDesktop.filter((rel) => stageHas(stage, rel));
  if (check('交付契约：desktop/vendor、dist、*.exe 不进 stage', leakedDesktop.length === 0, `漏排除：${leakedDesktop.join(', ')}`)) {
    okLine('交付契约：desktop/vendor、dist、*.exe 不进 stage');
  }

  // T21：安装器链路。源码/载荷清单必须随包（否则对方拿到包装不起来），
  // 但安装包产物（dist\installer\*.exe、根目录 setup exe）属于"构建产物"，绝不能进包。
  const installerSources = ['scripts/installer/Installer.cs', 'scripts/installer/payload.json',
    'scripts/installer/post-install.ps1', 'scripts/installer/version.txt'];
  const missingInstaller = installerSources.filter((rel) => !stageHas(stage, rel));
  if (check('交付契约：安装器源码与载荷清单进 stage', missingInstaller.length === 0, `缺：${missingInstaller.join(', ')}`)) {
    okLine('交付契约：安装器源码与载荷清单进 stage');
  }
  const bannedInstaller = ['dist/installer/QQDeepSeekBot-Setup-0.1.0.exe', 'QQDeepSeekBot-Setup-0.1.0.exe',
    'dist/installer'];
  const leakedInstaller = bannedInstaller.filter((rel) => stageHas(stage, rel));
  if (check('交付契约：安装包产物（dist/installer、根目录 setup exe）不进 stage', leakedInstaller.length === 0, `漏排除：${leakedInstaller.join(', ')}`)) {
    okLine('交付契约：安装包产物不进 stage');
  }
  // 全局兜底：不管放在哪个目录，stage 里都不该有任何 .exe（打包器是白名单制，漏一条规则就会带出去）。
  const exeInStage = walkFiles(stage).filter((rel) => rel.toLowerCase().endsWith('.exe'));
  if (check('交付契约：stage 里 *.exe 总数为 0', exeInStage.length === 0, `带入包的 exe：${exeInStage.slice(0, 5).join(', ')}`)) {
    okLine('交付契约：stage 里没有任何 .exe');
  }

  if (check('普通包不收 node_modules', !stageHas(stage, 'node_modules'))) okLine('普通包不收 node_modules');

  const cl = path.join(stage, 'docs', 'CHANGELOG.md');
  const clText = fs.existsSync(cl) ? fs.readFileSync(cl, 'utf8') : '';
  const mp = path.join(stage, 'scripts', 'machine.ps1');
  const mpText = fs.existsSync(mp) ? fs.readFileSync(mp, 'utf8') : '';
  const okSan = check('本机路径在 stage 副本里被脱敏（文档 + 脚本）',
    clText.includes('<本机路径>') && !/C:\\Users\\probe/.test(clText) && !/E:\\probe-data/.test(clText) && !/C:\\Users\\probe/.test(mpText),
    `文档片段：${clText.slice(0, 80)}`);
  if (okSan) okLine('本机路径在 stage 副本里被脱敏（文档 + 脚本）');
}

// ── 5. full 包端到端（G7 回归：依赖的 dist/ 不许被误删）───────────────────────
const full = runDryRun(fx, 'full');
if (full.stage) tmpRoots.push(full.stage);
if (check('full 包 -DryRun 通过（stage 闸 exit 0）', full.status === 0 && !!full.stage, `exit=${full.status} 闸门：${gateCause(full.out) || full.out.slice(-200)}`)) {
  okLine('full 包 -DryRun 通过（stage 闸 exit 0）');
}
if (full.stage) {
  const ok = check('full 包：带 node_modules + 保留 pkg/dist/ + 仍排除 state 与 .env',
    stageHas(full.stage, 'node_modules/pkg/index.js')
    && stageHas(full.stage, 'node_modules/pkg/dist/index.js')
    && !stageHas(full.stage, 'state')
    && !stageHas(full.stage, 'docs/.env'));
  if (ok) okLine('full 包：带 node_modules + 保留 pkg/dist/ + 仍排除 state/.env');
}

// ── 6. 负例：脏 stage 必须红、空 stage 必须红（自证闸门不是永远绿）─────────────
{
  const dirty = tmpDir('pack-exclude-dirty-');
  write(path.join(dirty, 'state', 'messages.db'), 'x');
  write(path.join(dirty, 'docs', 'leak.md'), 'path: C:\\Users\\probe\\app\\bin\n');
  const res = spawnSync(process.execPath, [SCANNER, '--stage', dirty], { encoding: 'utf8' });
  const text = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const okDirty = check('负例：脏 stage → exit 1 且点名 state/messages.db 与本地路径',
    res.status === 1 && /state\/messages\.db/.test(text) && /local-user-path/.test(text), `exit=${res.status}`);
  if (okDirty) okLine('负例：脏 stage → exit 1，点名敏感文件与本机路径');
  for (const line of text.split('\n').filter((l) => /state\/messages\.db|local-user-path/.test(l))) {
    console.log(`     证据｜${line.trim()}`);
  }

  const empty = tmpDir('pack-exclude-empty-');
  const res2 = spawnSync(process.execPath, [SCANNER, '--stage', empty], { encoding: 'utf8' });
  if (check('负例：空 stage → exit 2（拒绝把空包当通过）', res2.status === 2, `exit=${res2.status}`)) {
    okLine('负例：空 stage → exit 2');
  }
}

// ── 7. 并发：两个进程同时打包不能互删 stage（2026-10-26 回归失败的真因）─────────
// stage 曾是 $env:TEMP\qq-bridge-pack-<yyyyMMdd-HHmm>，只区分到分钟；两个窗口同一分钟打包
// 会落到同一目录，后启动的 `Test-Path → Remove-Item -Recurse` 把先启动的整个删掉，
// 先跑的那次就报「删目录 IOException / 正例文件消失 / 残留扫描错乱」。修法是 stage 名加 PID。
if (process.platform === 'win32') {
  const fxA = buildFixture();
  const fxB = buildFixture();
  const [a, b] = await Promise.all([runDryRunAsync(fxA, 'normal'), runDryRunAsync(fxB, 'normal')]);
  if (a.stage) tmpRoots.push(a.stage);
  if (b.stage) tmpRoots.push(b.stage);
  const okBoth = check(
    '并发：同一分钟内两个 -DryRun 同时跑都 exit 0（stage 名带 PID，不互删）',
    a.status === 0 && b.status === 0 && !!(a.stage && b.stage),
    `exit=${a.status}/${b.status} ${gateCause(a.out) || gateCause(b.out) || ''}`
  );
  if (okBoth) okLine('并发：两个 -DryRun 同时跑都 exit 0');
  if (a.stage && b.stage) {
    if (check('并发：两次 stage 路径互不相同', a.stage !== b.stage, `两次都用了 ${a.stage}`)) {
      okLine('并发：两次 stage 路径互不相同');
    }
    // 各自的正例都还在（互相没被删）——这才是「没互删」的实证
    const kept = a.stage !== b.stage && stageHas(a.stage, 'docs/README.md') && stageHas(b.stage, 'docs/README.md');
    if (check('并发：两次 stage 的正例文件都还在', kept, '有一方的正例被另一方删掉了')) {
      okLine('并发：两次 stage 的正例文件都还在');
    }
  }
}

// ── 收尾 ────────────────────────────────────────────────────────────────────
for (const d of tmpRoots) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结论 */ }
}

const total = pass + failures.length;
console.log(`  （契约探针 ${CONTRACT_COUNT} 个 + 清单增量探针）`);
if (failures.length) {
  // 失败明细必须走 stdout：regression-all 的 tail 只取 stdout 最后一行，
  // 之前全部打在 stderr 上，结果回归摘要里只剩「（契约探针 36 个…）」这一句，等于没信息。
  console.log(`\n❌ test-pack-exclude 失败 ${failures.length}/${total}`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log(`\n✅ test-pack-exclude 全部通过（${pass}/${total}）`);
