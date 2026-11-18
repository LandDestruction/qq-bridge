#!/usr/bin/env node
// 代码规模闸：防止「一个函数塞几千行」「一个文件几万行」再次发生。
//
// 规则：
//   - 单个源文件 ≤ 800 行（入口 src/bridge.js 单独放宽到 4500，它是装配根）
//   - 单个函数 ≤ 300 行
//   - public/*.html 里的内联 <script> 一并量：控制台 UI 全写在那儿，以前这道闸只看 src/**，
//     前端就能悄悄长出一个几千行的函数。HTML 文件本身放宽到 6500 行（还含模板与样式）。
//   - 存量超标项冻结在 scripts/code-size-baseline.json 里：只许变小，不许变大；
//     新增的超标项一律红。
//
// 为什么用真实 AST：曾经用「按大括号/缩进配对」的近似法，被字符串和模板字面量里的
// 花括号带偏，把 183 行的函数量成 1083 行。这个闸要挡提交，宁可多一个 vendored 解析器
// （scripts/vendor/acorn.mjs，MIT），也不能误报。
//
// 用法：
//   node scripts/test-code-size.mjs            检查（违规 exit 1）
//   node scripts/test-code-size.mjs --update   把当前规模写成新基线（只在真的收紧后跑）
//   node scripts/test-code-size.mjs --json     机器可读输出
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './vendor/acorn.mjs';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = path.join(ROOT, 'scripts/code-size-baseline.json');
const LIMITS = { file: 800, entryFile: 4500, func: 300, htmlFile: 6500 };

// 控制台外壳是全站唯一还在长的 HTML：静态页白名单只放行 public 下这几个文件，
// 新页面 / 新皮肤 / 新组件只能往 client.html 里塞，所以给它单独一档上限。
// 2026-10-28 已按原计划把 <style>/<script> 抽成 public/client.css + public/client.js：
//   - client.html 只剩骨架，压到 400 行（只许变小）
//   - client.css / client.js 是独立静态资源，**必须一起进闸**，否则拆分就等于把前端变成法外之地
const HTML_FILE_CAPS = new Map([['public/client.html', 400]]);
// 上限的理由：单文件超过这个量就该拆模块，而不是靠加行数堆功能。
// 2026-10-28 起 client.js 从 4.5k 一路长到 7.85k（迷你走势图、今日各群调用、印象归纳、运维总开关…），
// 每次都在这里临时抬上限，并留一句「D4 拆完收回」——D4 已于 2026-10-29 落地：
// 2026-10-29 D4 已落地：public/client.js 现在是 scripts/build-client.mjs 从 client/*.js 拼出来的
// 产物（顶部有「别直接改」的注释）。规模闸的真正抓手改成五个片段文件 + 拼装后总量。
const CLIENT_PARTS = [
  ['client/01-shell.js', 1825],      // 品牌 / 工具函数 / API / 弹层 / 写操作表 / 桥接离线横幅（+20 已购下载重试；+20 身份锁横幅与 30 秒复查；+25 「控制台有新版本」横幅与 60 秒 build 轮询，纯展示）
  ['client/02-dashboard.js', 1000],  // 仪表盘卡片、详情弹层、连接状态（+70：文件库卡的对账摘要一行与并行的只读对账请求）
  ['client/03-sessions.js', 3760],   // 会话、成员、表情、文件库、人设（+100：素材筛选/搜索、停止与重试；+120：绑定表导出/导入的按钮与两个处理器；+140：文件库服务端筛选/排序/分页加载更多与手动改号；+20：胶囊用全库 counts、limit/offset 取整夹住）
  ['client/04-usage.js', 1834],      // 用量与花费、名单管理、路由与工具（1827：+2 行挂载工具消耗卡与 provider 卡）
  ['client/04b-usage-tools.js', 340], // 工具消耗卡（245 行：范围/群筛选、堆叠条、表格、对账脚注、404 降级）
  ['client/04c-usage-providers.js', 280], // 模型用量（按 provider）（202 行：范围/basis/群筛选、占比条、五列表、合计两口径、404 降级）
  ['client/05-settings.js', 3375],   // 设置、黑话、日志、运维（含工具组清单）、系统架构、启动装配（+152：模型后端块 agent.type/openai 四输入/连通测试；+41：画面记忆「补描述」按钮与进度轮询，实际 3370）
  ['client/06-changelog.js', 260],   // 更新日志弹层（数据来自 public/changelog.js，git log 生成）
  ['client/07-bg.js', 345],          // 自定义背景图：导入、缩图、压暗/模糊、落地到 #qdbBgLayer
  ['client/07c-library-rename.js', 110],   // L5 素材改名：先 preview 再动磁盘（弹层自建、含 blocked 分支与自动补号前缀提示）
  ['client/07d-library-covers.js', 140],   // 素材卡信息条（扩展名/大小/文件数/分类/标签/已改名/撤销改名）+ 工具栏补封面（轮询/停止/404 兜底）
  ['client/07e-library-merge.js', 180],   // 合并同号：卡片「已合并 N 项/拆分」+ 工具栏提案弹层（多选、逐组 POST /api/library/merge）
  ['client/07f-library-purchases.js', 580],   // 已购库：解析 → 导入 → 列表 / 刷新 / 移除 / 同步 / 截图导入（PNG/JPEG≤1600 原图直传、超长边才缩到 0.95、60s 超时、三态 + 猜号二次确认，实际 554 行）
  ['client/07g-library-alias.js', 140],
  // 本地模型控制卡（设置 → 模型与思考）：状态三行 + 开关 + 选项 + 3 秒轮询 + 重启桥接流程（258 行）。
  ['client/07i-local-model.js', 285],
  ['client/07i-library-tags.js', 130],   // 素材卡信息条：解压码 / RJ 号 / 类型标签 / 来源 chip + 「有解压码 / 有 RJ」两档筛选
  ['client/07j-library-usage.js', 180],   // 工程使用统计：卡片 chip（异步补）、详情弹层、扫描/停止按钮与轮询、扫描根编辑（GET/POST /api/library/usage*、写 fileArchive.usageRoots）
  ['client/07m-library-detail.js', 400], // 详情抽屉只剩状态/拉数据/手动信息；图 2 版式搬到 10g（实际 371）   // 素材详情抽屉：标题/封面上打开（GET /api/library/asset?key=），文件清单折叠、合并成员、操作一排、Esc/点遮罩关；手动信息块：分类输入带 datalist、标签回车/逗号加、备注 textarea 计数、单按钮保存、清除二次确认（GET/POST /api/library/manual-meta，404 降级）
  ['client/07l-library-reconcile.js', 180],
  ['client/07q-library-dlall.js', 220],
  ['client/07r-booth-login.js', 230],
  ['client/07s-library-sync-entry.js', 230],   // 已购库·登录 BOOTH 自动同步（弹窗登录 → 抓 Cookie → 自动同步）：start/status/stop 三接口、1.5s 轮询与终态停止、登录成功后走 libPurSyncStart 同一条路径   // 已购库 ↔ 素材库对账：四胶囊摘要切视图、明细板（搜素材/复制商品页/打开）、工具栏入口与预取（+3 行挂补下全部与跳过清单）
  ['client/07k-library-trash.js', 200],   // 素材回收站：卡片「回收站」按钮（移入，可恢复）+ 工具栏弹层（列表/恢复/彻底删除/清空 30 天前，真删都走 confirm）
  ['client/07n-library-sync.js', 240],
  ['client/07o-library-batch.js', 260],
  ['client/07p-library-relocate.js', 200],   // 归位：日期目录判定 + dryRun 预览 + 确认后真搬 + 撤销归位   // 素材库批量多选：卡片勾选框 + 批量条（绑定同号 / 合并同号 / 移入回收站），Esc 与切视图清空   // 已购 ⇄ 素材库同步工具条：同步 dryRun 计划 / 绑定另一件 / 补下 / 撤销被删条目（404 时全禁用+一句实话）
  // 素材库 Pro 视图（新一级页「素材库」）：左筛选树 + sticky 工具条 + 宽卡网格 + facets 本地兜底。
  // 上限 700 是 lead 定的硬边界：再涨就拆 10a/10b 两个片段（build-client 按文件名序拼）。
  ['client/10-library-pro.js', 810], // 主框架：布局 / 视图组 / 侧栏 / 筛选（卡片与网格渲染拆到 10f 后实际 762）
  ['client/10a-library-namefind.js', 90], // 按名字找号面板（实际 71）
  ['client/10b-library-downloads.js', 300], // 补封面 + 下载中心（解压交互拆到 10h，实际 257）
  ['client/10c-library-cloud.js', 210],
  ['client/10d-library-collections.js', 460],  // 414：素材集总览封面墙（封面/件数/创建时间/改名/删除二次确认）+ 批量「加入素材集」+ 详情「移出」
  ['client/10e-library-cleanup.js', 360], // 一键认号 + 重复素材清理（实际 329）
  ['client/10f-library-cards.js', 240],  // 227：+16 给「详情面板字段合并/原名」两个 helper（10g 拆 300 行函数上限） // 卡片渲染 + 动作行 + 详情入口 + 包内信息行（实际 196）
  ['client/10g-library-detail-panel.js', 500], // 详情面板（图 2 版式：封面/状态/动作排/Unity 导入/已购文件）+ 主页面顶栏与左栏辅助（实际 299） // 卡片渲染 + 动作行 + 详情入口 + 包内信息行（实际 196）
  // 设置页「桌面客户端」版本块（120 行）：只读 status/check + 运行时包装注入面板。
  ['client/07h-desktop-client.js', 130],
  ['client/08-bgm.js', 540],         // 背景音乐：默认曲/自定义曲(IndexedDB)、音量与静音、顶栏控件、自动播放兜底
  ['client/09-ring.js', 470],        // 数据环画布：静态层预渲染 + 光束/流线高光 + 皮肤切换启停
];
const ASSET_FILE_CAPS = new Map([
  ['client/10h-library-extract.js', 140], // 解压交互：密码弹层 + 密码重试 + AES 提示（实际 95）
  ['public/client.js', 20512],  // v6：05-settings +152（模型后端块）  // +300：10f 拆出卡片渲染（148 行）后总行数不变，给下批留余量（实际 18229）  // +41：画面记忆「补描述」按钮（实际 20509）
  ['public/client.css', 2700], // v2.2 素材集 chip / 缺件红字 / 折叠样式（实际 2538）
  ...CLIENT_PARTS
]);
function htmlCapFor(file) {
  return HTML_FILE_CAPS.get(file) ?? LIMITS.htmlFile;
}
const HTML_DIR = 'public';

function walkFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/** 从一段 HTML 里抽出所有内联 <script> 的代码块，带它在文件里的起始行。 */
export function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/i.test(m[1])) continue; // 外链脚本不在这里量
    const startLine = html.slice(0, m.index + m[0].indexOf('>') + 1).split(/\r?\n/).length;
    out.push({ body: m[2], startLine });
  }
  return out;
}

/** 量一份 HTML 的内联脚本：函数行数换算成文件里的绝对行号。 */
export function collectInlineFunctions(html) {
  const found = [];
  for (const block of inlineScripts(html)) {
    let ast;
    try {
      ast = parse(block.body, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
    } catch {
      continue; // 解析不了就跳过：闸门只负责量得准的部分，不在这里报语法错
    }
    const seen = new Set();
    const visit = (node, parent) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const n of node) visit(n, parent); return; }
      if (typeof node.type !== 'string') return;
      const isFn = node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
      if (isFn && node.body?.type === 'BlockStatement') {
        const name = node.id?.name
          || (parent && (parent.key?.name || (parent.key?.value != null ? String(parent.key.value) : '')))
          || (parent?.type === 'VariableDeclarator' ? String(parent.id?.name ?? '') : '')
          || '<anonymous>';
        const key = `${node.loc.start.line}:${name}`;
        if (!seen.has(key)) {
          seen.add(key);
          found.push({ name, lines: node.loc.end.line - node.loc.start.line + 1, startLine: block.startLine + node.loc.start.line - 1 });
        }
      }
      for (const k of Object.keys(node)) {
        if (k === 'loc' || k === 'start' || k === 'end') continue;
        const v = node[k];
        if (v && typeof v === 'object') visit(v, node);
      }
    };
    visit(ast, null);
  }
  return found;
}

/** 从 AST 里收集所有块体函数（声明 / 表达式 / 箭头），带行列与名字。 */
export function collectFunctions(source) {
  const ast = parse(source, {
    ecmaVersion: 'latest', sourceType: 'module', locations: true,
    allowHashBang: true, allowAwaitOutsideFunction: true
  });
  const out = [];
  const seen = new Set();
  const visit = (node, parent, key, grand) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) visit(n, parent, key, grand); return; }
    if (typeof node.type !== 'string') return;
    if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') && node.body?.type === 'BlockStatement') {
      const name = node.id?.name
        || (parent && (parent.key?.name || (parent.key?.value != null ? String(parent.key.value) : '')))
        || (parent?.type === 'VariableDeclarator' ? String(parent.id?.name ?? '') : '')
        || (parent?.type === 'CallExpression' && grand?.type === 'VariableDeclarator' ? String(grand.id?.name ?? '') : '')
        || (parent?.type === 'AssignmentExpression' && parent.left ? String(parent.left.name ?? parent.left.property?.name ?? '') : '')
        || '<anonymous>';
      const lines = node.loc.end.line - node.loc.start.line + 1;
      const id = `${node.loc.start.line}:${name}`;
      if (!seen.has(id)) { seen.add(id); out.push({ name, lines, startLine: node.loc.start.line }); }
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (v && typeof v === 'object') visit(v, node, k, parent);
    }
  };
  visit(ast, null, null, null);
  return out;
}

export function scanProject(root = ROOT) {
  const files = walkFiles(path.join(root, 'src'))
    .map((p) => path.relative(root, p).replace(/\\/g, '/'))
    .sort();
  const rows = files.map((rel) => {
    const abs = path.join(root, rel);
    const source = fs.readFileSync(abs, 'utf8');
    const lines = source.split(/\r?\n/).length - 1;
    return { file: rel, kind: 'js', lines, functions: collectFunctions(source).sort((a, b) => b.lines - a.lines) };
  });
  // public/*.html 的内联脚本：控制台 UI 全写在这里，必须一起量，否则前端就是法外之地。
  const htmlDir = path.join(root, HTML_DIR);
  if (fs.existsSync(htmlDir)) {
    for (const name of fs.readdirSync(htmlDir).sort()) {
      if (!name.endsWith('.html')) continue;
      const source = fs.readFileSync(path.join(htmlDir, name), 'utf8');
      rows.push({
        file: `${HTML_DIR}/${name}`,
        kind: 'html',
        lines: source.split(/\r?\n/).length - 1,
        functions: collectInlineFunctions(source).sort((a, b) => b.lines - a.lines)
      });
    }
  }
  // 从 client.html 抽出来的静态资源：不进闸就等于拆分把前端搬到了监控之外。
  for (const rel of ASSET_FILE_CAPS.keys()) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const source = fs.readFileSync(abs, 'utf8');
    rows.push({
      file: rel,
      kind: rel.endsWith('.css') ? 'css' : 'js',
      lines: source.split(/\r?\n/).length - 1,
      functions: rel.endsWith('.css') ? [] : collectFunctions(source).sort((a, b) => b.lines - a.lines)
    });
  }
  return rows;
}

function fileCapFor(f, limits = LIMITS) {
  if (f.file === 'src/bridge.js') return limits.entryFile;
  const assetCap = ASSET_FILE_CAPS.get(f.file);
  if (assetCap != null) return assetCap;
  return f.kind === 'html' ? htmlCapFor(f.file) : limits.file;
}

function loadBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch { return { files: [], functions: [] }; }
}

/** 纯规则：把当前扫描结果与基线比对，返回违规列表。便于单测。 */
export function checkSizes(scan, baseline, limits = LIMITS) {
  const violations = [];
  const fileCap = new Map(baseline.files.map((x) => [x.file, x.lines]));
  const fnCap = new Map(baseline.functions.map((x) => [`${x.file}::${x.name}`, x.lines]));
  for (const f of scan) {
    const cap = fileCapFor(f, limits);
    const frozen = fileCap.get(f.file);
    if (f.lines > cap && (frozen == null || f.lines > frozen)) {
      violations.push({ kind: 'file', file: f.file, lines: f.lines, cap, frozen: frozen ?? null });
    }
    for (const fn of f.functions) {
      if (fn.lines <= limits.func) continue;
      const key = `${f.file}::${fn.name}`;
      const fnFrozen = fnCap.get(key);
      if (fnFrozen == null || fn.lines > fnFrozen) {
        violations.push({ kind: 'function', file: f.file, name: fn.name, lines: fn.lines, cap: limits.func, frozen: fnFrozen ?? null, startLine: fn.startLine });
      }
    }
  }
  return violations;
}

function buildBaseline(scan, limits = LIMITS) {
  const files = [];
  const functions = [];
  for (const f of scan) {
    const cap = fileCapFor(f, limits);
    if (f.lines > cap) files.push({ file: f.file, lines: f.lines });
    for (const fn of f.functions) {
      if (fn.name === '<anonymous>') continue;
      if (fn.lines > limits.func) functions.push({ file: f.file, name: fn.name, lines: fn.lines });
    }
  }
  files.sort((a, b) => b.lines - a.lines);
  functions.sort((a, b) => b.lines - a.lines);
  return { note: '存量技术债基线：只许变小不许变大。新增文件>800行或新增函数>300行直接红。收紧后用 --update 重写。', updatedAt: new Date().toISOString(), limits, files, functions };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const scan = scanProject();
  const baseline = loadBaseline();
  const violations = checkSizes(scan, baseline);
  const allFns = scan.flatMap((f) => f.functions);
  const biggest = allFns.sort((a, b) => b.lines - a.lines)[0];
  const biggestFile = [...scan].sort((a, b) => b.lines - a.lines)[0];
  const bridgeRow = scan.find((f) => f.file === 'src/bridge.js');
  const htmlRows = scan.filter((f) => f.kind === 'html');

  if (process.argv.includes('--update')) {
    const next = buildBaseline(scan);
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 2) + '\n');
    console.log(`已更新基线：文件 ${next.files.length} 条 / 函数 ${next.functions.length} 条`);
    process.exit(0);
  }
  if (process.argv.includes('--json')) {
    const topFunctions = allFns.slice(0, 10);
    console.log(JSON.stringify({ ok: violations.length === 0, violations, biggestFile: { file: biggestFile.file, lines: biggestFile.lines }, biggestFunction: biggest, topFunctions }, null, 2));
    process.exit(violations.length ? 1 : 0);
  }
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); } };

  console.log('[A] 文件规模');
  ok('src/bridge.js 入口 ≤ 4500 行', !bridgeRow || bridgeRow.lines <= LIMITS.entryFile, bridgeRow ? `${bridgeRow.lines} 行` : '缺失');
  const htmlFrozen = new Map(baseline.files.map((x) => [x.file, x.lines]));
  ok('public/*.html ≤ 上限行数（client.html 400、其余 6500；老文件已冻结，只许变小）',
    htmlRows.every((f) => f.lines <= htmlCapFor(f.file) || (htmlFrozen.get(f.file) != null && f.lines <= htmlFrozen.get(f.file))),
    htmlRows.map((f) => `${f.file} ${f.lines} 行${htmlFrozen.get(f.file) != null ? `（冻结 ${htmlFrozen.get(f.file)}）` : ''}`).join('; '));
  for (const v of violations.filter((x) => x.kind === 'file')) ok(`${v.file} ≤ ${v.cap} 行（当前 ${v.lines}，冻结 ${v.frozen ?? '无'}）`, false);

  console.log('[B] 函数规模（红线 300 行）');
  const fnViol = violations.filter((x) => x.kind === 'function');
  ok('没有超过 300 行的新函数 / 存量未变大', fnViol.length === 0, fnViol.slice(0, 5).map((v) => `${v.file}:${v.startLine} ${v.name}=${v.lines}`).join('; '));

  // 拆出来的静态资源必须真的进了扫描：改名/挪目录后不能静默掉出闸。
  const assetRows = scanProject().filter((f) => ASSET_FILE_CAPS.has(f.file));
  ok('拆分出来的 client.js / client.css 都进了扫描（否则前端就成了法外之地）',
    assetRows.length === ASSET_FILE_CAPS.size,
    `量到 ${assetRows.length}/${ASSET_FILE_CAPS.size}（${assetRows.map((f) => `${f.file} ${f.lines} 行`).join('、')}）`);

  // D4：产物必须与片段一致，否则「改了 client/*.js 忘了拼」会静默上线一份旧前端。
  const drift = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-client.mjs'), '--check'], { encoding: 'utf8' });
  ok('public/client.js 与 client/*.js 一致（改了片段要重跑 build:client）',
    drift.status === 0, String((drift.stderr || drift.stdout || '').trim()).slice(0, 200));
  ok('client/ 五个片段都在', CLIENT_PARTS.every(([f]) => fs.existsSync(path.join(ROOT, f))),
    CLIENT_PARTS.filter(([f]) => !fs.existsSync(path.join(ROOT, f))).map(([f]) => f).join('、'));

  console.log('[C] 边界自检（闸门本身要能抓住坏人）');
  const fakeBig = `function huge() {\n${'  void 0;\n'.repeat(320)}}\n`;
  const fakeSmall = `function tiny() {\n  return 1;\n}\n`;
  ok('合成 322 行函数被判定超标', collectFunctions(fakeBig)[0].lines > LIMITS.func, `量得 ${collectFunctions(fakeBig)[0].lines} 行`);
  ok('合成 3 行函数不误报', collectFunctions(fakeSmall)[0].lines === 3, `量得 ${collectFunctions(fakeSmall)[0].lines} 行`);
  ok('字符串里的花括号不影响计数', (() => { const s = `function f() {\n  const a = '}';\n  const b = "{\${x}}";\n  return 1;\n}\n`; return collectFunctions(s)[0].lines === 5; })());
  const fakeHtml = '<div>x</div>\n<script>\nfunction huge() {\n' + '  void 0;\n'.repeat(320) + '}\n</script>\n';
  const fakeHtmlFns = collectInlineFunctions(fakeHtml);
  ok('HTML 内联 <script> 里的超级函数也被量到', Boolean(fakeHtmlFns[0]) && fakeHtmlFns[0].lines > LIMITS.func, `量得 ${fakeHtmlFns[0] ? fakeHtmlFns[0].lines : 0} 行 @L${fakeHtmlFns[0] ? fakeHtmlFns[0].startLine : '?'}`);
  ok('HTML 里量出的行号是文件绝对行号', Boolean(fakeHtmlFns[0]) && fakeHtmlFns[0].startLine === 3, `L${fakeHtmlFns[0] ? fakeHtmlFns[0].startLine : '?'}`);

  console.log(`\n最大文件：${biggestFile.file} ${biggestFile.lines} 行 ｜ 最大函数：${biggest.name}@${biggest.startLine} ${biggest.lines} 行`);
  console.log(`========== 通过 ${pass} / 失败 ${fail} ==========`);
  process.exit(fail ? 1 : 0);
}
