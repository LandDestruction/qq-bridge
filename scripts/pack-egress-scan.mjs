// 打包外发面扫描（**离线、只读、不读文件内容**）。
//
// 为什么需要它：`scripts/pack-project.ps1` / `pack-project-full.ps1` 不是从 git 取文件，而是
// `Copy-Item -Recurse` 复制**工作树**；也就是说 `.gitignore` 对打包完全无效，打包只认脚本里
// 那份硬编码的 `$excludeNames`（state/node_modules/.git/logs/dist/config.json）。于是
// 「被 git 忽略、但名字不在那 5 个里」的东西（.env、*.log、__pycache__、docs/ 私有目录、
// privacy-rules.json…）会被静默打进 zip。这个脚本把「打包会带走的文件集合」算出来，
// 逐条对照敏感清单，只报**路径与大小**，绝不读内容、不打印任何 token。
//
// 它和 `scripts/privacy-scan.mjs` 是互补的两道闸：
//   privacy-scan  → 看**内容**（本机路径/QQ 号/凭据），对象是「git 会收的文件」；
//   pack-egress-scan → 看**打包面**（哪些文件真的会进 zip），对象是「工作树里被复制的东西」。
// 用 `--privacy-json` 把前者的结果喂进来，就能回答关键问题：
//   「privacy-scan 报红的那些文件，有几个真的会被打进包？」
//
// 用法（只读，不改任何文件）：
//   node scripts/pack-egress-scan.mjs                      # 扫当前仓库，普通包规则
//   node scripts/pack-egress-scan.mjs --mode full          # 按 full 包规则（含 node_modules）
//   node scripts/pack-egress-scan.mjs --root <dir>         # 扫别的目录
//   node scripts/pack-egress-scan.mjs --json               # 机读输出
//   node scripts/pack-egress-scan.mjs --selftest           # 自测（临时目录造夹具，不碰仓库）
//   node scripts/pack-egress-scan.mjs --privacy-json x.json # 与 privacy-scan --json 结果求交
//
// 退出码：0 = 打包面上没有敏感文件；1 = 有（= 这次打包不要发）；2 = 用法/环境错误。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ── 两个打包脚本的规则（照着 ps1 抄，改动请同步）──────────────────────────────
// 依据：scripts/pack-project.ps1:17-24 / :36-46，pack-project-full.ps1:18-25 / :37-46
const MODES = {
  normal: {
    includeDirs: ['src', 'scripts', 'docs', 'tools', 'public'],
    includeFiles: [
      'package.json', 'package-lock.json', 'config.example.json',
      'README.md', 'README.en.md', 'README-COMMANDS.md', 'RULES.md',
      'LICENSE', 'start.bat', 'restart.bat', 'start-bridge-forever.bat',
      '_snowluma-catalog.json',
    ],
    optionalFiles: ['AGENTS.md'],
    // pack-project.ps1:36 —— 注意它包含 node_modules
    excludeNames: ['state', 'node_modules', '.git', 'logs', 'dist', 'config.json'],
  },
  full: {
    includeDirs: ['src', 'scripts', 'docs', 'tools', 'public', 'node_modules'],
    includeFiles: [
      'package.json', 'package-lock.json', 'config.example.json',
      'README.md', 'README.en.md', 'README-COMMANDS.md', 'RULES.md',
      'LICENSE', 'start.bat', 'restart.bat', 'start-bridge-forever.bat',
      '_snowluma-catalog.json',
    ],
    optionalFiles: ['AGENTS.md'],
    // pack-project-full.ps1:37 —— 故意不排除 node_modules（full 版就是要带依赖）
    excludeNames: ['state', '.git', 'logs', 'dist', 'config.json'],
  },
};

// ── 敏感清单（本体在 docs/state-egress-boundary.md，这里给可执行形式）────────────
// 每条只匹配**路径**，不读内容。命中即「不该进包」。
const SENSITIVE_PATH_RULES = [
  { id: 'runtime-dir', why: '运行数据目录（消息库/记忆/表情/令牌水位）', re: /(^|\/)(state|logs)(\/|$)/i },
  { id: 'audio-dir', why: '语音库：用户个人音频素材', re: /(^|\/)audio(\/|$)/i },
  // 注意：只认**真实** config.json；config.example.json 是脱敏模板，必须能进包。
  { id: 'real-config', why: '真实配置（含账号/白名单/路径）', re: /(^|\/)config\.json$/i },
  { id: 'dotenv', why: '.env / .env.* 环境变量与密钥', re: /(^|\/)\.env(\.[^/]*)?$/i },
  { id: 'log-file', why: '日志文件（含真实 QQ 号与消息片段）', re: /\.log(\.\d+)?$/i },
  { id: 'backup-file', why: '备份文件（.bak / .bak-*）', re: /\.bak/i },
  { id: 'pycache', why: 'Python 缓存（.gitignore 忽略，但打包会复制）', re: /(^|\/)__pycache__(\/|$)|\.pyc$/i },
  { id: 'npm-cache', why: 'npm 缓存', re: /(^|\/)\.npm-cache(\/|$)/i },
  { id: 'privacy-rules', why: '本机隐私规则（含真实 QQ 号与本机路径，必须不入库/不入包）', re: /(^|\/)privacy-rules\.json$/i },
  { id: 'sqlite', why: 'SQLite 数据库文件', re: /\.(db|sqlite3?|db-wal|db-shm)$/i },
  // 只认「数据/凭据文件」；含 token 字样的源码与文档（src/token-ledger.js、test-token-*.mjs、
  // TOKEN_USAGE_CONSOLE.md）是正常产物，不能让规则变成噪音。
  { id: 'token-file', why: '令牌/登录态数据文件（console-token、token-usage.jsonl、cookies.json…）', re: /(^|\/)(console-token|token-usage(\.[^/]*)?|cookies?\.json|credentials?\.(json|txt|ini|ya?ml|env|dat)|\.netrc)$/i },
  { id: 'secret-file', why: '疑似凭据文件（secret/password/credential 命名的数据文件）', re: /(^|\/)[^/]*(secret|passwd|password|credential)[^/]*\.(json|txt|ini|ya?ml|env|csv)$/i },
  { id: 'key-file', why: '私钥/证书', re: /\.(pem|key|pfx|p12)$|(^|\/)id_rsa/i },
  { id: 'internal-docs', why: '.gitignore 声明的内部文档（含本机路径的调研/审计）', re: /(^|\/)docs\/(audits|design|legacy|research)(\/|$)|qq-bridge-(PUBLISH_PLAN|SECURITY_AUDIT)\.md$|docs\/guides\/(PROJECT_GUIDE|VOICE)\.md$/i },
  { id: 'internal-md', why: '.gitignore 声明的内部规划/调研 md（仓库根）', re: /(^|\/)(PROJECT_GUIDE|ARCH_REVIEW|DSH_QQ_TOOLS_PLAN|GEN2_SIMULATION_PLAN|SOCIAL_MODE_PLAN|RESEARCH_QQ_MESSAGE_DND|RESEARCH_SNOWLUMA_EMOJI_STICKER|TOKEN_COST|LOCAL_MODEL_SIZING)\.md$/i },
];

const SKIP_REparse = 0x400; // FILE_ATTRIBUTE_REPARSE_POINT（Windows junction）

// stage 内容检查用的两条「本机绝对路径」规则（与 privacy-scan 的前两条一致）。
// 只用于**已打好的 stage**：路径规则查文件名，这两条查文件内容里残留的本机路径。
const LOCAL_PATH_PATTERNS = [
  { id: 'local-user-path', re: /[A-Za-z]:\\Users\\[^\\\s"'`]{2,}/ },
  { id: 'local-drive-path', re: /(?<![A-Za-z0-9])(?!C:)[A-Za-z]:\\[^\\\s"'`|<>]{2,}\\/ },
];
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.mp4', '.webm', '.wav', '.mp3', '.zip', '.exe', '.dll', '.node', '.woff', '.woff2', '.ttf', '.zstd', '.db', '.sqlite', '.pyc', '.wasm']);

function parseArgs(argv) {
  const out = { mode: 'normal', root: REPO_ROOT, json: false, selftest: false, privacyJson: null, stage: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') out.mode = argv[++i];
    else if (a === '--root') out.root = path.resolve(argv[++i]);
    else if (a === '--stage') out.stage = path.resolve(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--selftest') out.selftest = true;
    else if (a === '--privacy-json') out.privacyJson = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else { console.error(`[pack-egress-scan] 未知参数：${a}`); process.exit(2); }
  }
  if (!MODES[out.mode]) { console.error(`[pack-egress-scan] --mode 只能是 normal|full，收到：${out.mode}`); process.exit(2); }
  return out;
}

/** 复刻 ps1 的「先复制、再按名字删」：算出最终会留在 stage 里的文件（相对路径，POSIX 分隔）。 */
function collectShipped(root, mode) {
  const spec = MODES[mode];
  const files = [];       // { rel, size }
  const seen = new Set(); // realpath，防 junction 环
  const walk = (absDir, relDir) => {
    let real;
    try { real = fs.realpathSync(absDir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(absDir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      // junction / 符号链接一律不跟（本仓库 state/ 里有过指回自身的 junction）
      if (st.isSymbolicLink() || (st.attributes !== undefined && (st.attributes & SKIP_REparse) !== 0)) continue;
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile()) files.push({ rel, size: st.size });
    }
  };
  for (const d of spec.includeDirs) {
    const abs = path.join(root, d);
    let st = null;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(abs, d);
  }
  for (const f of [...spec.includeFiles, ...spec.optionalFiles]) {
    const abs = path.join(root, f);
    let st = null;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (st.isFile()) files.push({ rel: f, size: st.size });
  }
  // 逐条复刻 ps1 的删除规则
  const exclude = new Set(spec.excludeNames.map((s) => s.toLowerCase()));
  const kept = [];
  for (const f of files) {
    const segs = f.rel.split('/');
    if (segs.some((s) => exclude.has(s.toLowerCase()))) continue;       // ps1:36-39 / :37-40
    if (/\.bak/i.test(path.posix.basename(f.rel))) continue;            // ps1:40-42（*.bak*）
    if (!f.rel.includes('/') && f.rel.toLowerCase().endsWith('.py')) continue; // ps1:44-46，只删 stage 根
    kept.push(f);
  }
  kept.sort((a, b) => a.rel.localeCompare(b.rel));
  return kept;
}

/** 敏感清单匹配：只回规则 id，不下内容结论。 */
function classify(rel) {
  const hit = [];
  for (const r of SENSITIVE_PATH_RULES) if (r.re.test(rel)) hit.push(r.id);
  return hit;
}

/** 一次性问 git：这些文件里哪些其实是 gitignore 的（= .gitignore 没被打包尊重）。 */
function gitIgnoredAmong(root, rels) {
  if (!rels.length) return new Set();
  const res = spawnSync('git', ['-C', root, 'check-ignore', '--stdin'], {
    input: rels.join('\n') + '\n', encoding: 'utf8', timeout: 60000,
  });
  // check-ignore: 0 = 有命中，1 = 全都没被忽略，其它 = 环境问题
  if (res.error || (res.status !== 0 && res.status !== 1)) return new Set();
  return new Set((res.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean));
}

function scan(root, mode) {
  const kept = collectShipped(root, mode);
  const ignored = gitIgnoredAmong(root, kept.map((f) => f.rel));
  const offenses = [];
  for (const f of kept) {
    const rules = classify(f.rel);
    // full 包**故意**整目录带 node_modules（.gitignore 忽略它是应当的），别把它当泄漏刷屏
    const isIgnored = ignored.has(f.rel) && !(mode === 'full' && f.rel.startsWith('node_modules/'));
    if (!rules.length && !isIgnored) continue;
    offenses.push({ rel: f.rel, size: f.size, rules, gitIgnored: isIgnored });
  }
  // 顺带统计被排除规则挡掉的文件数（按名字分桶）：既能证明规则在干活，
  // 也能暴露「按名字递归删」的副作用（如 node_modules/*/dist 被整片删掉）。
  const blocked = countBlocked(root, mode);
  return { kept, offenses, ignored, blocked };
}

/** 统计被排除规则挡掉的文件数，按「命中的名字」分桶（只数数量，不列路径）。 */
function countBlocked(root, mode) {
  const spec = MODES[mode];
  const exclude = new Set(spec.excludeNames.map((s) => s.toLowerCase()));
  const byName = {};
  const bump = (key, n) => { byName[key] = (byName[key] ?? 0) + n; };
  const seen = new Set();
  const walk = (absDir, relDir) => {
    let real;
    try { real = fs.realpathSync(absDir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(absDir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink() || (st.attributes !== undefined && (st.attributes & SKIP_REparse) !== 0)) continue;
      if (st.isDirectory()) {
        if (exclude.has(e.name.toLowerCase())) { bump(e.name.toLowerCase(), countFiles(abs)); continue; }
        walk(abs, rel);
      } else if (st.isFile()) {
        if (exclude.has(e.name.toLowerCase())) bump(e.name.toLowerCase(), 1);
        else if (/\.bak/i.test(e.name)) bump('*.bak*', 1);
      }
    }
  };
  for (const d of spec.includeDirs) {
    const abs = path.join(root, d);
    try { if (!fs.lstatSync(abs).isDirectory()) continue; } catch { continue; }
    walk(abs, d);
  }
  const count = Object.values(byName).reduce((s, n) => s + n, 0);
  return { count, byName };
}

function countFiles(dir) {
  let n = 0;
  const seen = new Set();
  const walk = (d) => {
    let real;
    try { real = fs.realpathSync(d); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink() || (st.attributes !== undefined && (st.attributes & SKIP_REparse) !== 0)) continue;
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) n += 1;
    }
  };
  walk(dir);
  return n;
}

// ── 自测：临时目录造夹具，断言「会进包 / 不会进包」与分类是否与预期一致 ──────────────
function selftest() {
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok, detail });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-egress-'));
  const mk = (rel, content = 'x') => {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  try {
    mk('src/bridge.js');
    mk('src/bridge.js.bak-20261025-slang');
    mk('docs/CHANGELOG.md');
    mk('docs/run.log');
    mk('docs/.env');
    mk('docs/state/messages.db');
    mk('docs/audits/secret-audit.md');
    mk('docs/guides/PROJECT_GUIDE.md');
    mk('scripts/privacy-rules.json');
    mk('scripts/privacy-scan.mjs');
    mk('tools/__pycache__/stt_server.cpython-311.pyc');
    mk('tools/stt_server.py');
    mk('tools/stray.py');                 // stage 根之外的 .py 不该被删（tools/ 下保留）
    mk('public/client.html');
    mk('state/messages.db');
    mk('config.json');
    mk('config.example.json');            // 脱敏模板：必须能进包
    mk('src/token-ledger.js');            // 源码名里带 token：不许误报
    mk('docs/guides/TOKEN_USAGE_CONSOLE.md'); // 文档名里带 token：不许误报
    mk('docs/console-token');             // 真正的令牌文件：必须抓到
    mk('node_modules/left-pad/index.js');
    mk('node_modules/somepkg/dist/index.js'); // 依赖的编译产物：会被名字规则 'dist' 整片删掉
    mk('package.json');

    const normal = scan(tmp, 'normal');
    const full = scan(tmp, 'full');
    const rels = (r) => r.kept.map((f) => f.rel);
    const off = (r) => r.offenses.map((o) => o.rel).sort();

    // ① 普通包：includeDirs 之外的 state/、config.json 根本不复制
    check('普通包不收 state/、config.json', !rels(normal).some((p) => /^(state|config\.json)/.test(p)));
    // ② *.bak* 被 ps1 的 .bak 规则删掉
    check('普通包删掉 .bak-* 备份', !rels(normal).includes('src/bridge.js.bak-20261025-slang'));
    // ③ 名字叫 state 的嵌套目录被 excludeNames 删掉
    check('普通包删掉嵌套 docs/state/', !rels(normal).includes('docs/state/messages.db'));
    // ④ 普通包不收 node_modules（full 才收）
    check('普通包不收 node_modules', !rels(normal).some((p) => p.startsWith('node_modules/')));
    check('full 包收 node_modules', rels(full).includes('node_modules/left-pad/index.js'));
    // ⑤ tools/ 下的 .py 保留（ps1 只删 stage 根目录的 .py）
    check('普通包保留 tools/*.py', rels(normal).includes('tools/stt_server.py') && rels(normal).includes('tools/stray.py'));
    // ⑥ 关键缺口：这些名字都不在 excludeNames 里 → 真的会进包
    const gap = off(normal);
    check('抓出 docs/.env', gap.includes('docs/.env'));
    check('抓出 docs/run.log', gap.includes('docs/run.log'));
    check('抓出 tools/__pycache__/*.pyc', gap.includes('tools/__pycache__/stt_server.cpython-311.pyc'));
    check('抓出 scripts/privacy-rules.json', gap.includes('scripts/privacy-rules.json'));
    check('抓出 docs/audits/（.gitignore 内部目录）', gap.includes('docs/audits/secret-audit.md'));
    check('抓出 docs/guides/PROJECT_GUIDE.md', gap.includes('docs/guides/PROJECT_GUIDE.md'));
    check('抓出 docs/console-token', gap.includes('docs/console-token'));
    // ⑦ 正常源码/模板不该被误报
    check('不误报 src/bridge.js', !gap.includes('src/bridge.js'));
    check('不误报 docs/CHANGELOG.md（路径规则）', !gap.includes('docs/CHANGELOG.md'));
    check('不误报 scripts/privacy-scan.mjs', !gap.includes('scripts/privacy-scan.mjs'));
    check('不误报 config.example.json', !gap.includes('config.example.json'));
    check('不误报 src/token-ledger.js', !gap.includes('src/token-ledger.js'));
    check('不误报 docs/guides/TOKEN_USAGE_CONSOLE.md', !gap.includes('docs/guides/TOKEN_USAGE_CONSOLE.md'));
    // ⑧ 已知副作用：full 包里依赖的 dist/ 会被名字规则整片删掉（应报告，不该悄悄发生）
    check('full 包把 node_modules/*/dist 当排除项删掉（副作用可见）', (full.blocked.byName.dist ?? 0) === 1);
    check('普通包不因 dist 误删（node_modules 本来就不收）', (normal.blocked.byName.dist ?? 0) === 0);

    const pass = results.filter((r) => r.ok).length;
    for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `  ${r.detail}`}`);
    console.log(`[pack-egress-scan] selftest ${pass}/${results.length}`);
    if (pass !== results.length) process.exitCode = 1;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结果 */ }
  }
}

/** 读文本，容忍 BOM 与 **UTF-16**：PowerShell 的 `node … > x.json` 默认写 UTF-16LE，
 *  直接用 readFileSync(...,'utf8') 会得到乱码——这是本仓库踩过的真实坑。 */
function readTextAuto(abs) {
  const buf = fs.readFileSync(abs);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const copy = Buffer.from(buf.subarray(2));
    if (copy.length % 2 === 0) copy.swap16();
    return copy.toString('utf16le');
  }
  const text = buf.toString('utf8');
  return text.replace(/^\uFEFF/, '');
}

/** stage 验收：对打好的目录做两道检查——① 文件名是否命中敏感清单；② 内容里是否还残留本机绝对路径。
 *  这是打包脚本发布前的最后一道闸（`--stage <目录>`），也是「脱敏到底有没有生效」的机械证明。 */
function scanStage(stageDir) {
  const files = [];
  const seen = new Set();
  const walk = (absDir, relDir) => {
    let real;
    try { real = fs.realpathSync(absDir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(absDir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink() || (st.attributes !== undefined && (st.attributes & SKIP_REparse) !== 0)) continue;
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile()) files.push({ rel, size: st.size });
    }
  };
  walk(stageDir, '');
  const pathOffenses = [];
  const contentHits = [];
  for (const f of files) {
    const rules = classify(f.rel);
    if (rules.length) pathOffenses.push({ rel: f.rel, size: f.size, rules });
    if (BINARY_EXT.has(path.extname(f.rel).toLowerCase())) continue;
    let text;
    try { text = fs.readFileSync(path.join(stageDir, f.rel), 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    for (const p of LOCAL_PATH_PATTERNS) {
      const lines = [];
      text.split('\n').forEach((line, i) => { if (p.re.test(line)) lines.push(i + 1); });
      if (lines.length) contentHits.push({ rel: f.rel, rule: p.id, count: lines.length, lines: lines.slice(0, 5) });
    }
  }
  return { files: files.length, pathOffenses, contentHits };
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('用法：node scripts/pack-egress-scan.mjs [--mode normal|full] [--root <dir>] [--json] [--selftest] [--privacy-json <file>]');
  process.exit(0);
}
if (args.selftest) { selftest(); process.exit(process.exitCode ?? 0); }

// ── 模式 A：验收已打好的 stage（打包脚本发布前调用）──────────────���─────────────
if (args.stage) {
  // 空目录/不存在的 stage 一律判失败：否则「一个文件都没复制」会被误判成「干净」。
  if (!fs.existsSync(args.stage)) {
    console.error(`[pack-egress-scan] ❌ stage 不存在：${args.stage}`);
    process.exit(2);
  }
  const res = scanStage(args.stage);
  if (res.files === 0) {
    console.error(`[pack-egress-scan] ❌ stage 是空的（0 个文件）：${args.stage} —— 拒绝把空包当通过`);
    process.exit(2);
  }
  let stillLeaking = [];
  if (args.privacyJson) {
    try {
      const parsed = JSON.parse(readTextAuto(args.privacyJson));
      const hitFiles = new Set((parsed.findings ?? []).map((f) => f.file));
      stillLeaking = res.contentHits.filter((h) => hitFiles.has(h.rel)).map((h) => h.rel);
    } catch (e) { console.error(`[pack-egress-scan] 读不了 --privacy-json：${e.message}`); process.exit(2); }
  }
  const bad = res.pathOffenses.length + res.contentHits.length;
  if (args.json) {
    console.log(JSON.stringify({ stage: args.stage, files: res.files, pathOffenses: res.pathOffenses, contentHits: res.contentHits, stillLeaking, verdict: bad ? 'fail' : 'pass' }, null, 2));
  } else {
    console.log(`[pack-egress-scan] stage：${args.stage}（${res.files} 个文件）`);
    if (!bad) {
      console.log('[pack-egress-scan] ✅ stage 通过：无敏感文件名，且内容里没有本机绝对路径。');
    } else {
      if (res.pathOffenses.length) {
        console.log(`[pack-egress-scan] ❌ ${res.pathOffenses.length} 个敏感文件名进了 stage：`);
        for (const o of res.pathOffenses) console.log(`   - ${o.rel}  ${o.size}B  [${o.rules.join(',')}]`);
      }
      if (res.contentHits.length) {
        console.log(`[pack-egress-scan] ❌ ${res.contentHits.length} 个文件内容里仍残留本机绝对路径（脱敏没覆盖到）：`);
        for (const h of res.contentHits) console.log(`   - ${h.rel}  行 ${h.lines.join(',')}${h.count > h.lines.length ? ` …共 ${h.count} 行` : ''}  [${h.rule}]`);
      }
      console.log('[pack-egress-scan] 处理：① 把该文件加进 scripts/pack-exclude.json 的 removePaths；② 或扩 scripts/pack-exclude.json 的 sanitize 规则。');
    }
    if (args.privacyJson) console.log(`[pack-egress-scan] 与 privacy-scan 求交：命中文件里打包后仍泄漏的 = ${stillLeaking.length}`);
  }
  process.exit(bad ? 1 : 0);
}

const { kept, offenses, blocked } = scan(args.root, args.mode);
const totalBytes = kept.reduce((s, f) => s + f.size, 0);

let privacyJoin = null;
if (args.privacyJson) {
  let parsed;
  try { parsed = JSON.parse(readTextAuto(args.privacyJson)); }
  catch (e) { console.error(`[pack-egress-scan] 读不了 --privacy-json：${e.message}`); process.exit(2); }
  const keptSet = new Set(kept.map((f) => f.rel));
  const filesHit = [...new Set((parsed.findings ?? []).map((f) => f.file))];
  const wouldShip = filesHit.filter((f) => keptSet.has(f));
  privacyJoin = {
    source: args.privacyJson,
    privacyFindings: (parsed.findings ?? []).length,
    filesHit: filesHit.length,
    filesThatWouldShip: wouldShip.length,
    wouldShip,
  };
}

if (args.json) {
  console.log(JSON.stringify({
    root: args.root, mode: args.mode,
    shippedFiles: kept.length, shippedBytes: totalBytes,
    blockedByRules: blocked.count, blockedByName: blocked.byName,
    offenses: offenses.length, findings: offenses, privacyJoin,
  }, null, 2));
} else {
  console.log(`[pack-egress-scan] 根目录：${args.root}`);
  console.log(`[pack-egress-scan] 模式：${args.mode}（${MODES[args.mode].includeDirs.join(', ')}）`);
  const blockedDetail = Object.entries(blocked.byName).map(([k, v]) => `${k} ${v}`).join('、') || '无';
  console.log(`[pack-egress-scan] 会进包：${kept.length} 个文件 / ${(totalBytes / 1024 / 1024).toFixed(2)} MB；被排除规则挡住 ${blocked.count} 个（按名字：${blockedDetail}）`);
  if (!offenses.length) {
    console.log('[pack-egress-scan] ✅ 打包面上没有敏感文件。');
  } else {
    console.log(`[pack-egress-scan] ❌ ${offenses.length} 个敏感文件会进包：`);
    for (const o of offenses) {
      const tags = [...o.rules, ...(o.gitIgnored ? ['gitignored-but-shipped'] : [])].join(',');
      console.log(`   - ${o.rel}  ${o.size}B  [${tags}]`);
    }
    console.log('[pack-egress-scan] 处理：① 加进 pack-project*.ps1 的排除规则；② 或改用 git archive/ls-files 取文件；③ 别再往 docs/ 放本机私有文档。');
    console.log('[pack-egress-scan] 明细与建议见 docs/state-egress-boundary.md');
  }
  if (privacyJoin) {
    console.log(`[pack-egress-scan] 与 privacy-scan 求交：privacy 命中 ${privacyJoin.privacyFindings} 处 / ${privacyJoin.filesHit} 个文件，其中 **${privacyJoin.filesThatWouldShip} 个会进包**`);
    for (const f of privacyJoin.wouldShip.slice(0, 15)) console.log(`   - 会进包且 privacy 报红：${f}`);
    if (privacyJoin.wouldShip.length > 15) console.log(`   … 其余 ${privacyJoin.wouldShip.length - 15} 个见 --json`);
  }
}
process.exitCode = offenses.length ? 1 : 0;
