// 开机自启动（设置页「桌面客户端」）的静态契约：
//   后端 —— 读写的是和桌面壳 / 安装器同一处注册表值，命令形状一致；只给管理端；
//   前端 —— 设置页有这一组、GET /api/autostart 读、POST {enabled} 写、二次确认、文案跟状态变。
// 只读源码断言，不需要起桥接；真机行为（写入/删除注册表、重启后状态）由手工验证覆盖。
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const BS = String.fromCharCode(92);

let pass = 0;
let fail = 0;
const check = (ok, name, extra = '') => {
  if (ok) { pass += 1; console.log('  ok   ' + name); return; }
  fail += 1;
  console.log('  FAIL ' + name + (extra ? ' — ' + extra : ''));
};

const admin = read('src/bridge/console/config-admin.js');
const server = read('src/bridge/console-server.js');
const client = read('public/client.js');
const host = read('desktop/Host.cs');
const installer = read('scripts/installer/Installer.cs');
const manifest = JSON.parse(read('src/bridge/manifest.json'));

// ── 注册表位置与命令形状：后端 / 桌面壳 / 安装器三方不能漂移 ──────────────
check(admin.includes('const AUTOSTART_RUN_KEY = String.raw`HKCU' + BS + 'Software' + BS + 'Microsoft' + BS + 'Windows' + BS + 'CurrentVersion' + BS + 'Run`'),
  '后端写的 Run 键和桌面壳一致（HKCU\\...\\CurrentVersion\\Run）');
check(admin.includes("const AUTOSTART_VALUE_NAME = 'QQDeepSeekBot'"),
  '值的名字用品牌名 QQDeepSeekBot');
check(host.includes('get { return Brand.AppDataDirName; }') && host.includes('"Software' + BS + 'Microsoft' + BS + 'Windows' + BS + 'CurrentVersion' + BS + 'Run"'),
  '桌面壳托盘那份实现仍在同一处（三方不漂移）');
check(installer.includes('k.SetValue(AutostartValueName, "\\"" + exe + "\\" --root \\"" + dir + "\\" --autostart")'),
  '安装器写的也是 `"<exe>" --root "<dir>" --autostart`（登录时不弹窗）');
check(admin.includes("const command = '\"' + before.exe + '\" --root \"' + deps.ROOT + '\" --autostart';"),
  '后端写的命令形状同样是 `"<exe>" --root "<root>" --autostart`');
check(host.includes('internal bool Autostart;') && host.includes('if (opt.Autostart)'),
  '桌面壳认 --autostart 并在登录拉起时直接进托盘');

// ── 读 / 开 / 关 三条路径 ────────────────────────────────────────────────
check(admin.includes("autostartReg(['query', AUTOSTART_RUN_KEY, '/v', AUTOSTART_VALUE_NAME])"),
  '读状态用 reg query /v');
check(admin.includes("autostartReg(['add', AUTOSTART_RUN_KEY, '/v', AUTOSTART_VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f'])"),
  '开自启用 reg add /t REG_SZ /f');
check(admin.includes("autostartReg(['delete', AUTOSTART_RUN_KEY, '/v', AUTOSTART_VALUE_NAME, '/f'])"),
  '关自启用 reg delete /f');
check(/TextDecoder\('gbk'\)/.test(admin),
  'reg.exe 输出按 GBK 解（中文系统会把中文路径解成乱码）');
check(admin.includes('String.fromCharCode(13) + String.fromCharCode(10)'),
  '输出按 CRLF 切行（写成转义会在工具链里被吃掉）');
check(admin.includes('/"([^"]+[.]exe)"/i'),
  '从命令里取 exe 用字符类 [.]exe，避免反斜杠转义被吃');

// ── 候选 exe 顺序 + 找不到时给原因 ──────────────────────────────────────
check(admin.includes('deps.cfg.desktop && deps.cfg.desktop.exePath')
  && admin.includes("'Programs', 'QQDeepSeekBot', 'QQDeepSeekBot.exe'")
  && admin.includes("deps.path.join(deps.ROOT, 'dist', 'desktop', 'QQDeepSeekBot.exe')"),
  '候选 exe：config 指定 > 安装目录 > dist/desktop');
check(admin.includes("hint: exe ? '' : '没找到桌面客户端 exe"),
  '找不到 exe 时给出可操作提示（而不是静默失败）');

// ── 路由与鉴权 ──────────────────────────────────────────────────────────
check(admin.includes("if (pathname === '/api/autostart') return handleAutostartRequest(deps, request);"),
  '路由 /api/autostart 从 config-admin 分派（不撑大 ops 的冻结函数）');
check(server.includes("url.pathname === '/api/autostart'"),
  'console-server 分派条件里带上 /api/autostart（同一行扩展，没新增行）');
check(admin.includes('const enabled = body.enabled === true;') && admin.includes('await autostartSet(deps, enabled)'),
  'POST {enabled:true|false} 开关（GET 只读）');
check(admin.includes("request.req.headers['x-agent-token']") && admin.includes('开机自启动只允许管理端读写'),
  '会话级主体一律 403（不许模型给自己开自启）');
const adminMod = manifest.modules.find((m) => m.file.endsWith('console/config-admin.js'));
check(Array.isArray(adminMod.dependencies) && adminMod.dependencies.includes('fs'),
  'config-admin 模块声明了 fs 依赖（要 existsSync 判断 exe 在不在）');

// ── 前端：设置页那一组 ──────────────────────────────────────────────────
check(client.includes("{ id: 'client', name: '桌面客户端' }"), '设置页导航有「桌面客户端」一组');
check(client.includes("if (settingsState.group === 'client') return settingsClientHtml();"), '该组有自己的面板');
check(client.includes('data-write="autostart-toggle"') && client.includes('data-next='),
  '开关带 data-write 与目标状态');
check(/<label class="qdb-switch" for="autostartSwitch"/.test(client)
  && /<input type="checkbox" id="autostartSwitch" data-write="autostart-toggle"/.test(client)
  && client.includes('<span class="qdb-switch-track"><span class="qdb-switch-dot"></span></span>'),
  '开机自启是设置页统一那套开关（checkbox + 轨道 + 圆点），不是一个「关闭自启」按钮');
check(client.includes('qdb-switch-state') && client.includes('已开启') && client.includes('已关闭'),
  '开关右边带状态文字（已开启 / 已关闭）');
check(client.includes("if (btn && btn.tagName === 'INPUT') btn.checked = !on;"),
  '二次确认取消时把开关拨回原位（原生 checkbox 已经翻过去了）');
check(client.includes('data-write="autostart-refresh"'), '有「重新检测」按钮（装完客户端不用刷新整页）');
check(/apiWrite\('\/api\/autostart', \{ enabled: on \}\)/.test(client),
  '点按钮写的是 POST /api/autostart {enabled}');
check(client.includes("api('/api/autostart')"), '读状态走 GET /api/autostart');
check(client.includes("title: on ? '开启开机自启动' : '关闭开机自启动'"), '开关有二次确认弹层');
check(client.includes('autostartState.data = pair[5] || null;'),
  '进入设置页就并行取一次状态，不用点第二次');
check(client.includes('AUTOSTART_FALLBACK'),
  '说明里的默认注册表路径用字符码拼（JS 字符串里写反斜杠会被吞）');

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
