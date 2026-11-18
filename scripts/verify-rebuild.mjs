#!/usr/bin/env node
// 灾备自检：拿到一份包（或一台坏掉的机器）先跑这个，一次列出「你现在缺什么、下一步做第几步」。
// 用法：
//   node scripts/verify-rebuild.mjs            人读清单（可截图）
//   node scripts/verify-rebuild.mjs --json     机读
//   node scripts/verify-rebuild.mjs --no-net   断网/不想探端口
//   node scripts/verify-rebuild.mjs --no-docs  跳过「手册引用的路径在不在」
// 退出码：0=无阻断（可有警告） 1=有阻断 2=用法错误
//
// 设计约束（与 docs/REBUILD-GUIDE.md 一致）：
//   * 只读：不创建/不修改任何文件，不写 state，不重启任何东西。
//   * 不打印任何配置值：只回「已填 / 仍是占位符 / 缺失」与字段名。
//   * 最后一行永远只有一句「下一步：§X — 一句话动作」，对回手册小节号。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');
const ARGS = process.argv.slice(2);
const JSON_OUT = ARGS.includes('--json');
const NO_NET = ARGS.includes('--no-net');
const NO_DOCS = ARGS.includes('--no-docs');
const UNKNOWN = ARGS.filter((a) => !['--json', '--no-net', '--no-docs', '--help', '-h'].includes(a));
if (ARGS.includes('--help') || ARGS.includes('-h')) {
  console.log('用法：node scripts/verify-rebuild.mjs [--json] [--no-net] [--no-docs]');
  process.exit(0);
}
if (UNKNOWN.length) {
  console.error(`未知参数：${UNKNOWN.join(' ')}（可用：--json --no-net --no-docs）`);
  process.exit(2);
}

const checks = [];
/** level: ok | warn | block; section: 环境|文件|服务|依赖|文档 */
function add(level, section, name, detail, fix = '', step = '') {
  checks.push({ level, section, name, detail, fix, step });
}

// ───────────────────────── 读 config（只用于判空，绝不外泄值） ─────────────────────────
const cfgPath = path.join(ROOT, 'config.json');
let cfg = null;
let cfgErr = '';
if (fs.existsSync(cfgPath)) {
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { cfgErr = e.message; }
}

// ───────────────────────── 端口 & 探测工具 ─────────────────────────
function tcp(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}
function dirSize(dir) {
  let files = 0, bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) continue;
      files += 1;
      try { bytes += fs.statSync(p).size; } catch { /* ignore */ }
    }
  }
  return { files, bytes };
}
function parseUrl(u, dflt) {  try { const x = new URL(u); return { host: x.hostname, port: Number(x.port || 80) }; } catch { return dflt; }
}
const snowHttp = parseUrl(cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000', { host: '127.0.0.1', port: 3000 });
const snowWs = parseUrl(cfg?.snowluma?.wsUrl || 'ws://127.0.0.1:3001', { host: '127.0.0.1', port: 3001 });
const consolePort = Number(cfg?.consolePort || 3100);
const dshUrl = cfg?.dsh?.baseUrl || '';
const dshGuess = dshUrl ? parseUrl(dshUrl, { host: '127.0.0.1', port: 13707 }) : { host: '127.0.0.1', port: 13707 };

// ───────────────────────── 1. 环境 ─────────────────────────
const [maj, min] = process.versions.node.split('.').map(Number);
const nodeOk = maj > 22 || (maj === 22 && min >= 13);
add(nodeOk ? 'ok' : 'block', '环境', 'Node.js', `v${process.versions.node}（需要 >= 22.13，用到内置 node:sqlite）`,
  nodeOk ? '' : '安装 Node.js 22 LTS 或更新版本：https://nodejs.org/', '§B1 第 1 步');

let psVer = '';
try {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
    { encoding: 'utf8', timeout: 8000 });
  psVer = String(r.stdout || '').trim();
} catch { /* ignore */ }
if (psVer) {
  const ps5 = psVer.startsWith('5.');
  add('ok', '环境', 'PowerShell', `${psVer}${ps5 ? '（5.1：.ps1 请用 -ExecutionPolicy Bypass -File 调用）' : ''}`);
} else {
  add('warn', '环境', 'PowerShell', '读不到版本（不影响 Node 部分）', '若 .ps1 跑不了，见手册矩阵 #7');
}

try {
  const st = fs.statfsSync(ROOT);
  const freeGb = (st.bavail * st.bsize) / 1024 ** 3;
  add(freeGb >= 2 ? 'ok' : 'warn', '环境', '磁盘余量', `${freeGb.toFixed(1)} GB 可用（建议 >= 2 GB；npm 依赖约 22 MB）`,
    freeGb >= 2 ? '' : '清理磁盘后再装依赖，见手册 §B0');
} catch (e) {
  add('warn', '环境', '磁盘余量', `读不到：${e.message}`);
}

// ───────────────────────── 2. 文件：交付清单 + config 占位符 ─────────────────────────
const MANIFEST = path.join(ROOT, 'scripts', 'delivery-manifest.json');
let manifestFiles = null;
if (fs.existsSync(MANIFEST)) {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const raw = Array.isArray(m) ? m
      : (m.files || m.include || m.entries || m.paths || []);
    manifestFiles = raw.map((e) => (typeof e === 'string' ? e : (e?.path || e?.from || e?.source || '')))
      .filter(Boolean).map((p) => String(p).replace(/\\/g, '/'));
    add('ok', '文件', '交付清单', `scripts/delivery-manifest.json：${manifestFiles.length} 条`);
  } catch (e) {
    add('warn', '文件', '交付清单', `存在但解析失败：${e.message}`, '按手册 §C1 的 8 行 Test-Path 手工核对', '§C1');
  }
}

// manifest 未定稿时的最小交付清单（只放「缺了就绝不可能跑起来」的东西）
const REQUIRED = [
  'package.json',
  'src/bridge.js',
  'scripts/setup-dsh.mjs',
  'scripts/setup-doctor.mjs',
  'scripts/verify-rebuild.mjs',
  'dsh/agent-presets/qq-chat-v2/agent.cordis.yml',
  'plugins/qq-agent-presets/package.json',
  'assets',
  'docs/REBUILD-GUIDE.md',
];
const required = manifestFiles || REQUIRED;
if (!manifestFiles) {
  add('warn', '文件', '交付清单', '尚未找到 scripts/delivery-manifest.json（D43 产物），改用内置最小清单',
    '收到 D43 的包后本条会自动切换为逐条核对');
}
let missingFiles = 0;
for (const rel of required) {
  const abs = path.join(ROOT, rel);
  if (fs.existsSync(abs)) continue;
  missingFiles += 1;
  const critical = REQUIRED.includes(rel) || manifestFiles !== null;
  add(critical ? 'block' : 'warn', '文件', rel, '不在包里',
    manifestFiles ? '包不完整：找回该文件，或向发包人确认是否被误删' : '若这是交付包，说明包不完整（手册 §C1）',
    '§C1');
}
// 配置模板：config.template.json 优先，config.example.json 兜底
const hasTemplate = fs.existsSync(path.join(ROOT, 'config.template.json'));
const hasExample = fs.existsSync(path.join(ROOT, 'config.example.json'));
if (hasTemplate) add('ok', '文件', 'config.template.json', '存在（全占位符模板）');
else if (hasExample) add('warn', '文件', 'config.template.json', '不存在，只有 config.example.json（含失效兜底模型，需手删）',
  '优先向发包人要 config.template.json；临时可用 config.example.json，但要删掉 modelFallbacks 里的失效项（手册 §A1 备注）', '§B2');
else add('block', '文件', 'config.template.json', '模板缺失且没有 config.example.json', '包不完整，向发包人要', '§C1');

// config.json 本身 + 占位符（只看「填没填」，不打印值）
const PLACEHOLDER = (v) => typeof v === 'string' && (/^<.*>$/.test(v.trim()) || /^(CHANGE|TODO|FILL|填)/i.test(v.trim()));
let cfgBlocking = 0;
if (!cfg && cfgErr) {
  add('block', '文件', 'config.json', `JSON 解析失败（${cfgErr.split('\n')[0].slice(0, 80)}）`,
    '用备份覆盖；或 copy config.template.json config.json 重填（手册 §A1 备注）', '§B2');
  cfgBlocking += 1;
} else if (!cfg) {
  add('block', '文件', 'config.json', '不存在（交付包里本来就没有，必须自己生成）',
    'copy config.template.json config.json，然后只填 4 个值（手册 §B2）', '§B2');
  cfgBlocking += 1;
} else {
  add('ok', '文件', 'config.json', '存在且 JSON 合法');
  const fields = [
    ['ownerQQ', cfg.ownerQQ],
    ['allow.groups', Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : cfg.allow?.groups],
    ['snowluma.accessToken', cfg.snowluma?.accessToken],
  ];
  // 注意：config.template.json 目前用「数字 0」当占位（ownerQQ: 0、allow.groups: [0]），
  // 不是 <QQ号>/<群号> 字符串——所以「0」也必须算未填，否则会假绿。
  const IS_ZERO = (v) => (Array.isArray(v) ? v.some((x) => x === 0 || String(x).trim() === '0')
    : v === 0 || String(v).trim() === '0');
  for (const [name, val] of fields) {
    if (val === undefined || val === null || (Array.isArray(val) ? val.length === 0 : String(val).trim() === '')) {
      add('block', '文件', `config.${name}`, '缺失/为空', '手册 §B2 只填这 4 个值', '§B2');
      cfgBlocking += 1;
    } else if (Array.isArray(val) ? val.some(PLACEHOLDER) : PLACEHOLDER(val)) {
      add('block', '文件', `config.${name}`, '仍是占位符（没替换成真实值）', '把 <…> 换成真实值；别把模板原样当配置', '§B2');
      cfgBlocking += 1;
    } else if (IS_ZERO(val)) {
      add('block', '文件', `config.${name}`, '仍是模板占位值 0（模板原样未替换）',
        '把 0 换成真实值：ownerQQ 填自己的 QQ 号，allow.groups 填群号（手册 §B2）', '§B2');
      cfgBlocking += 1;
    } else {
      add('ok', '文件', `config.${name}`, '已填（值不打印）');
    }
  }
  // 其余字段里残留的占位符：只报字段路径
  const leftovers = [];
  const ALREADY_REPORTED = (p) => p === 'ownerQQ' || p === 'snowluma.accessToken' || p.startsWith('allow.groups[');
  (function walk(node, prefix) {
    if (ALREADY_REPORTED(prefix)) return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${prefix}[${i}]`)); return; }
    if (node && typeof node === 'object') { for (const k of Object.keys(node)) walk(node[k], prefix ? `${prefix}.${k}` : k); return; }
    if (PLACEHOLDER(node)) leftovers.push(prefix);
  })(cfg, '');
  if (leftovers.length) {
    add('warn', '文件', 'config 占位符残留', `${leftovers.length} 处：${leftovers.slice(0, 6).join(', ')}${leftovers.length > 6 ? ' …' : ''}`,
      '非必填字段可留空/删掉；必填字段见 §B2');
  }
}

// 表情库：默认带、可删（删了不影响收发消息；见手册 §E）
const stkJson = path.join(ROOT, 'state', 'stickers.json');
const stkFiles = path.join(ROOT, 'state', 'sticker-files');
const hasStkJson = fs.existsSync(stkJson);
const hasStkDir = fs.existsSync(stkFiles);
if (!hasStkJson && !hasStkDir) {
  add('warn', '文件', '表情库', '没带（可删项；删了不影响收发消息）',
    '想要表情就从自己的 state 拷这两个路径：state\\stickers.json 与 state\\sticker-files\\（手册 §E）');
} else {
  let stkN = 0, stkErr = '';
  if (hasStkJson) {
    try {
      const j = JSON.parse(fs.readFileSync(stkJson, 'utf8'));
      // 顶层可能是数组，也可能是 { version, stickers: [...] } 之类的对象：两种都认
      const arr = Array.isArray(j) ? j
        : (j.stickers || j.items || j.list || Object.values(j).filter((v) => v && typeof v === 'object'));
      stkN = Array.isArray(arr) ? arr.length : 0;
    } catch (e) { stkErr = String(e.message).split('\n')[0].slice(0, 60); }
  }
  if (stkErr) {
    add('warn', '文件', 'state/stickers.json', `解析失败（${stkErr}）`, '坏文件可删掉重建；表情包会清空，不影响聊天（手册 §E）');
  }
  const sz = hasStkDir ? dirSize(stkFiles) : { files: 0, bytes: 0 };
  const stkOk = hasStkJson && hasStkDir && stkN > 0 && sz.files > 0;
  add(stkOk ? 'ok' : 'warn', '文件', '表情库',
    `${stkN} 条记录 / ${sz.files} 个图片 / ${(sz.bytes / 1048576).toFixed(1)} MB（默认带，可删）`,
    stkOk ? '' : '只带了一半：记录与图片目录要同时存在，否则面板有卡片但发不出图（手册 §E）');
}

// ───────────────────────── 3. 服务 ─────────────────────────
const portState = { snowHttp: false, snowWs: false, console: false, dsh: false };
let status = null;
if (!NO_NET) {
  portState.snowHttp = await tcp(snowHttp.host, snowHttp.port);
  portState.snowWs = await tcp(snowWs.host, snowWs.port);
  portState.console = await tcp('127.0.0.1', consolePort);
  portState.dsh = await tcp(dshGuess.host, dshGuess.port)
    || (!dshUrl && (await tcp('127.0.0.1', 14043)));

  const listening = [
    ['SnowLuma 3000/3001', portState.snowWs || portState.snowHttp],
    [`控制台 ${consolePort}`, portState.console],
    [`DSH ${dshGuess.port}`, portState.dsh],
  ].filter(([, on]) => on).map(([n]) => n);
  add('ok', '环境', '端口占用', listening.length ? `在听：${listening.join('、')}` : '全部空闲（还没起服务时这是正常的）');

  add(portState.snowWs ? 'ok' : 'block', '服务', `SnowLuma WS :${snowWs.port}`,
    portState.snowWs ? '可连' : '连不上',
    portState.snowWs ? '' : '先起 SnowLuma 并扫码；端口要与 config.snowluma.wsUrl 一致（手册 §A1 第 5 步 / 矩阵 #4 #5）', '§A1 第 5 步');
  add(portState.snowHttp ? 'ok' : 'warn', '服务', `SnowLuma HTTP :${snowHttp.port}`,
    portState.snowHttp ? '可连' : '连不上',
    portState.snowHttp ? '' : '部分网关只开 WS；HTTP 用于取直链/成员信息，建议一并开（矩阵 #5）');
  add(portState.dsh ? 'ok' : 'block', '服务', `DSH :${dshGuess.port}`,
    portState.dsh ? '可连' : '连不上',
    portState.dsh ? '' : '启动 DSH 并登录；或把 config.dsh.baseUrl 指到它实际端口（手册 §A1 第 2 步 / 矩阵 #1 #2）', '§A1 第 2 步');
  add(portState.console ? 'ok' : 'warn', '服务', `桥接控制台 :${consolePort}`,
    portState.console ? '在监听（若你还没启动，说明有个旧实例在跑）' : '没在监听（桥接未启动）',
    portState.console ? '' : 'DSH 与 SnowLuma 都通了以后再启动：node src\\bridge.js（手册 §A1 第 7 步）',
    portState.console ? '' : '§A1 第 7 步');

  // /api/status：只读，只回布尔
  if (portState.console) {
    const tokPath = path.join(ROOT, 'state', 'console-token');
    let token = String(process.env.QQ_BRIDGE_CONSOLE_TOKEN || '').trim();
    if (!token) {
      try { token = fs.readFileSync(tokPath, 'utf8').trim(); } catch { /* 没有就算了 */ }
    }
    if (!token) {
      add('warn', '服务', '/api/status', '无法鉴权：没有 state\\console-token（本目录可能没有运行态数据）',
        '在真正跑起来的目录里跑本脚本；或设环境变量 QQ_BRIDGE_CONSOLE_TOKEN', '§A1 第 7 步');
    } else {
      status = await new Promise((resolve) => {
      const req = http.get({
        host: '127.0.0.1', port: consolePort, path: '/api/status', timeout: 4000,
        headers: token ? { 'x-console-token': token } : {},
      }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          if (res.statusCode === 401) return resolve({ error: '401：console-token 不对（state\\console-token 与控制台不同源）' });
          try { resolve(JSON.parse(body)); } catch { resolve({ error: `HTTP ${res.statusCode}，响应不是 JSON` }); }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ error: '超时 4s' }); });
      req.on('error', (e) => resolve({ error: e.message }));
    });
    if (status?.error) {
      add('warn', '服务', '/api/status', status.error, '确认 console-token 与控制台端口（矩阵 #15 #6）');
    } else {
      const dshReady = Boolean(status.dshReady ?? status.dsh?.ready);
      const snowConnected = Boolean(status.snowluma?.connected ?? status.snowluma ?? false);
      const paused = Boolean(status.socialV2Paused ?? status.paused);
      add(dshReady ? 'ok' : 'block', '服务', '/api/status dshReady', String(dshReady),
        dshReady ? '' : 'DSH 侧没就绪：确认已重启 DSH 且 MCP/preset 已装（手册 §A1 第 3–4 步）', '§A1 第 3 步');
      add(snowConnected ? 'ok' : 'block', '服务', '/api/status snowluma', String(snowConnected),
        snowConnected ? '' : '网关掉线：重新扫码（矩阵 #4）', '§A1 第 5 步');
      add(paused ? 'warn' : 'ok', '服务', '/api/status paused', String(paused),
        paused ? '机器人被暂停了：去控制台恢复（不是故障）' : '');
    }
    }
  }
} else {
  add('warn', '服务', '端口探测', '已跳过（--no-net）');
}

// ───────────────────────── 4. 依赖 ─────────────────────────
const nm = path.join(ROOT, 'node_modules');
if (!fs.existsSync(nm)) {
  add('block', '依赖', 'node_modules', '不存在', '在仓库根执行 npm ci（慢就换 npmmirror 源；手册 §B1 第 3 步 / 矩阵 #8）', '§B1 第 3 步');
} else {
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch { /* ignore */ }
  const deps = Object.keys(pkg?.dependencies || {});
  const miss = deps.filter((d) => !fs.existsSync(path.join(nm, d, 'package.json')));
  if (miss.length) {
    add('block', '依赖', 'node_modules 完整性', `缺 ${miss.length}/${deps.length}：${miss.slice(0, 4).join(', ')}${miss.length > 4 ? ' …' : ''}`,
      'npm ci 重装；离线可整目录拷贝 node_modules（必须含 @snowluma 与 .bin）（矩阵 #8）', '§B1 第 3 步');
  } else {
    add('ok', '依赖', 'node_modules 完整性', `${deps.length} 个直接依赖都在`);
  }
  const require_ = createRequire(path.join(ROOT, 'noop.js'));
  let yamlOk = false;
  try { require_('js-yaml'); yamlOk = true; } catch { /* ignore */ }
  add(yamlOk ? 'ok' : 'block', '依赖', "require('js-yaml')", yamlOk ? '可用（说明依赖树真的能加载）' : '加载失败',
    yamlOk ? '' : '依赖装坏了或 Node 版本过低：删 node_modules 后 npm ci（矩阵 #8）', '§B1 第 3 步');
}

// ───────────────────────── 5. 文档引用的路径 ─────────────────────────
if (!NO_DOCS) {
  const guide = path.join(ROOT, 'docs', 'REBUILD-GUIDE.md');
  const ROOT_FILES = new Set(['package.json', 'config.template.json', 'config.example.json', 'README.md']);
  if (!fs.existsSync(guide)) {
    add('block', '文档', 'docs/REBUILD-GUIDE.md', '不存在', '手册本身缺了，包不完整（§C1）', '§C1');
  } else {
    const text = fs.readFileSync(guide, 'utf8');
    const refs = new Set();
    for (const m of text.matchAll(/`([^`\n]{3,120})`/g)) {
      const raw = m[1].trim().replace(/\\/g, '/');
      if (!/^[\w.\-/]+\.(mjs|js|json|ps1|md|yml|ya?ml|bat|vbs|example\.json)$/.test(raw)) continue;
      if (raw.startsWith('~') || raw.includes('*') || raw.includes('<')) continue;
      if (/^(dist|node_modules|logs|state|audio)\//.test(raw)) continue;
      if (raw.includes('/')) {
        if (!/^(src|scripts|docs|dsh|plugins|assets|roles)\//.test(raw)) continue;
      } else if (!ROOT_FILES.has(raw)) {
        continue; // 裸文件名（config.json / social-v2.json 之类）是「运行期数据」，不是包内路径，不校验
      }
      refs.add(raw);
    }
    const list = [...refs];
    const missing = list.filter((r) => !fs.existsSync(path.join(ROOT, r)));
    if (missing.length === 0) {
      add('ok', '文档', '手册引用路径', `${list.length} 条引用全部在包里`);
    } else {
      // 有 manifest 且该路径被列为应交付 → 阻断；否则只是「待 D43 对齐」的提醒
      const hard = manifestFiles ? missing.filter((r) => manifestFiles.includes(r)) : [];
      add(hard.length ? 'block' : 'warn', '文档', '手册引用路径',
        `${missing.length}/${list.length} 条不在盘上：${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`,
        hard.length ? '这些是交付清单里应含的文件：包不完整（§C4）'
          : '可能还没合入（D43 的 manifest 等生成物）或手册写错了路径；出包前必须全在（§C4）',
        hard.length ? '§C4' : '');
    }
  }
}

// ───────────────────────── 6. 输出 ─────────────────────────
const blocks = checks.filter((c) => c.level === 'block');
const warns = checks.filter((c) => c.level === 'warn');

// 下一步：按「修好之后能推进多少」排序，取第一条可执行的
const NEXT = [
  { match: (c) => c.section === '环境' && c.name === 'Node.js', step: '§B1 第 1 步', act: '装 Node.js 22.13+ 并确认 node -v' },
  { match: (c) => c.section === '文件' && /config\.json|config\./.test(c.name) && c.level === 'block', step: '§B2', act: '生成 config.json 并填 4 个必填值（ownerQQ / allow.groups / snowluma.accessToken / dsh.baseUrl）' },
  { match: (c) => c.section === '文件' && c.level === 'block', step: '§C4', act: '包不完整：按手册 §C1 的 8 行 Test-Path 核对，缺的找回' },
  { match: (c) => c.section === '依赖' && c.level === 'block', step: '§B1 第 3 步', act: 'npm ci 重装依赖（或拷贝 node_modules）' },
  { match: (c) => c.section === '服务' && /DSH/.test(c.name), step: '§A1 第 2 步', act: '启动 DSH 并登录，确认端口可连' },
  { match: (c) => c.section === '服务' && /SnowLuma WS/.test(c.name), step: '§A1 第 5 步', act: '启动 SnowLuma 并扫码登录' },
  { match: (c) => c.section === '服务' && /dshReady/.test(c.name), step: '§A1 第 3 步', act: '重启 DSH（改 MCP/preset 后必须重启 DSH，不是重启桥接）' },
  { match: (c) => c.section === '服务' && /snowluma$/.test(c.name), step: '§A1 第 5 步', act: '网关掉线：重新扫码' },
  { match: (c) => c.section === '服务' && /控制台/.test(c.name), step: '§A1 第 7 步', act: '启动桥接：node src\\bridge.js（或 start.bat）' },
];
let next = NEXT.find((n) => checks.some((c) => c.level === 'block' && n.match(c)));
if (!next && warns.length) next = { step: '§A1 第 9 步', act: '只剩警告项：按提示可选修；可以先去群里 @ 一句验收' };
if (!next) next = { step: '§A1 第 9 步', act: '全绿：群里 @ 一句，10–60 秒内有回复即验收通过' };

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: blocks.length === 0,
    blocks: blocks.length,
    warns: warns.length,
    next: { step: next.step, action: next.act },
    checks,
  }, null, 2));
} else {
  const icon = { ok: '✓', warn: '⚠', block: '✗' };
  for (const section of ['环境', '文件', '服务', '依赖', '文档']) {
    const list = checks.filter((c) => c.section === section);
    if (!list.length) continue;
    console.log(`\n[${section}]`);
    for (const c of list) {
      console.log(`  ${icon[c.level]} ${c.name}：${c.detail}`);
      if (c.fix && c.level !== 'ok') console.log(`     → ${c.fix}`);
    }
  }
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`阻断 ${blocks.length} 项，警告 ${warns.length} 项。`);
  console.log(`下一步：${next.step} — ${next.act}`);
}
process.exit(blocks.length ? 1 : 0);
