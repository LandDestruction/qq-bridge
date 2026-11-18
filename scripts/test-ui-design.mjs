#!/usr/bin/env node
// UI 设计系统静态断言（T15）。
//
// 为什么用「算」而不是「抄」：对比度是最容易被糊弄的一条——写个 5.2 没人验得了。
// 这里从 public/ui-preview.html 里读 :root / [data-theme=dark] 的真实 token 值，
// 用 WCAG 2.1 相对亮度公式重算，再和 docs/ui-design-system.md 里那张表逐行对账：
//   - 表里的比值与实算差 > 0.02 → 红（防止手改文档不重算）
//   - 表里标 ✅ 但实算 < 门槛 → 红（防止「假达标」）
//   - 表里标 ⚠️ 但实算 < 3.0 → 红（大字/非文本也有下限）
//
// 用法：
//   node scripts/test-ui-design.mjs              全量断言
//   node scripts/test-ui-design.mjs --emit-table 打印 Markdown 对比度表（文档用同一份数据，避免两处漂移）
//   node scripts/test-ui-design.mjs --json       机器可读结果
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_FILE = path.join(ROOT, 'public/ui-preview.html');
const DOC_FILE = path.join(ROOT, 'docs/ui-design-system.md');
const SELF_FILE = fileURLToPath(import.meta.url);

const MAX_HTML_BYTES = 120 * 1024;
const BODY = 4.5;      // 正文 / 表单文字 / 可点文字
const LARGE = 3.0;     // 大字（≥24px）、图形界面边界、状态点、焦点环

/** 对比度表用的配对：同一份数据同时驱动文档表格与断言。 */
export const CONTRAST_PAIRS = [
  // 正文与可点文字（4.5）
  ['--ui-text', '--ui-bg', BODY, '正文 / 页面底'],
  ['--ui-text', '--ui-surface', BODY, '正文 / 卡片'],
  ['--ui-text', '--ui-surface-2', BODY, '正文 / 次级面'],
  ['--ui-text-2', '--ui-bg', BODY, '次要正文 / 页面底'],
  ['--ui-text-2', '--ui-surface-2', BODY, '次要正文 / 次级面'],
  ['--ui-text-meta', '--ui-surface-2', BODY, '辅助小字 / 次级面'],
  ['--ui-accent-ink', '--ui-bg', BODY, '可点文字 / 页面底'],
  ['--ui-accent-ink', '--ui-surface-2', BODY, '可点文字 / 次级面'],
  ['--ui-accent-ink', '--ui-accent-soft', BODY, '可点文字 / 粉色浅底（徽章）'],
  ['--ui-on-accent', '--ui-accent-ink', BODY, '实心按钮文字 / 粉填充'],
  ['--ui-on-accent', '--ui-danger', BODY, '实心按钮文字 / 危险填充'],
  ['--ui-success-ink', '--ui-surface-2', BODY, '成功文字 / 次级面'],
  ['--ui-warn-ink', '--ui-surface-2', BODY, '警告文字 / 次级面'],
  ['--ui-danger-ink', '--ui-surface-2', BODY, '危险文字 / 次级面'],
  ['--ui-success-ink', '--ui-success-soft', BODY, '成功文字 / 成功浅底'],
  ['--ui-warn-ink', '--ui-warn-soft', BODY, '警告文字 / 警告浅底'],
  ['--ui-danger-ink', '--ui-danger-soft', BODY, '危险文字 / 危险浅底'],
  // 大字 / 图形 / 边界（3.0）
  ['--ui-text-3', '--ui-bg', LARGE, '弱文字 / 页面底（仅大字）'],
  ['--ui-accent', '--ui-surface', LARGE, '粉色强调 / 卡片（仅填充）'],
  ['--ui-border-strong', '--ui-surface-2', LARGE, '输入框边界 / 次级面'],
  ['--ui-focus', '--ui-bg', LARGE, '焦点环 / 页面底'],
  ['--ui-success', '--ui-surface', LARGE, '状态点成功 / 卡片'],
  ['--ui-warn', '--ui-surface', LARGE, '状态点警告 / 卡片'],
  ['--ui-danger', '--ui-surface', LARGE, '状态点失败 / 卡片'],
];

/** 16 个必备组件：CSS 选择器 + 标记里必须出现的类名。 */
const COMPONENTS = [
  ['按钮', '.qdb-btn--primary', 'qdb-btn qdb-btn--primary'],
  ['输入框', '.qdb-input', "class='qdb-input'"],
  ['下拉', '.qdb-select', "class='qdb-select'"],
  ['开关', '.qdb-switch', "class='qdb-switch'"],
  ['复选框', '.qdb-check', "class='qdb-check'"],
  ['卡片', '.qdb-card', "class='qdb-card"],
  ['表格', '.qdb-table', "class='qdb-table'"],
  ['徽章', '.qdb-badge', "class='qdb-badge"],
  ['状态点', '.qdb-dot', "class='qdb-dot"],
  ['侧边栏项', '.qdb-nav-item', "class='qdb-nav-item'"],
  ['标签页', '.qdb-tab', "class='qdb-tab'"],
  ['抽屉', '.qdb-drawer', "class='qdb-drawer'"],
  ['toast', '.qdb-toast', "class='qdb-toast"],
  ['空态', '.qdb-empty', "class='qdb-empty'"],
  ['加载骨架', '.qdb-skeleton', "class='qdb-skeleton"],
  ['进度条', '.qdb-progress', "class='qdb-progress'"],
];

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function blockOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(escaped + '\\s*\\{([\\s\\S]*?)\\n\\}'));
  return m ? m[1] : null;
}

function tokensOf(block) {
  const out = new Map();
  if (!block) return out;
  const re = /(--ui-[a-z0-9-]+)\s*:\s*([^;]+);/g;
  let m = re.exec(block);
  while (m) {
    out.set(m[1], m[2].trim());
    m = re.exec(block);
  }
  return out;
}

function channel(v) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const clean = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) throw new Error('不是 6 位十六进制：' + hex);
  const n = parseInt(clean, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG 2.1 对比度，四舍五入到两位。 */
export function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

function verdictFor(ratio, threshold, note) {
  if (ratio < LARGE) return '❌';
  // 只准大字 / 只准填充的颜色，即便 ≥3.0 也不能标成「正文达标」
  if (note && note.includes('仅') && threshold < BODY) return ratio >= threshold ? '⚠️ 仅大字/填充' : '❌';
  return ratio >= threshold ? '✅' : '❌';
}

function cssOf(html) {
  const m = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  return m ? m[1] : '';
}

function themeTokens(css) {
  return {
    light: tokensOf(blockOf(css, ':root')),
    dark: tokensOf(blockOf(css, "[data-theme='dark']")),
  };
}

function emitTable(html) {
  const blocks = themeTokens(cssOf(html));
  const lines = [];
  for (const theme of ['light', 'dark']) {
    lines.push('### ' + (theme === 'light' ? '浅色主题' : '深色主题'));
    lines.push('');
    lines.push('| 前景 | 前景色 | 背景 | 背景色 | 实测比值 | 门槛 | 结论 |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const [fgName, bgName, threshold, note] of CONTRAST_PAIRS) {
      const fg = blocks[theme].get(fgName);
      const bg = blocks[theme].get(bgName);
      const ratio = contrast(fg, bg);
      lines.push('| `' + fgName + '` | ' + fg + ' | `' + bgName + '` | ' + bg + ' | ' + ratio.toFixed(2) + ' | ' + threshold + ' | ' + verdictFor(ratio, threshold, note) + ' |');
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  const args = new Set(process.argv.slice(2));
  const html = read(HTML_FILE);
  const css = cssOf(html);

  if (args.has('--emit-table')) {
    process.stdout.write(emitTable(html) + '\n');
    return;
  }

  const doc = fs.existsSync(DOC_FILE) ? read(DOC_FILE) : '';
  const results = [];
  const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail || '' });

  const htmlBytes = Buffer.byteLength(html, 'utf8');
  const { light, dark } = themeTokens(css);

  // ---- 交付物与体积 ----
  ok('样张单文件 ≤120KB', htmlBytes > 0 && htmlBytes <= MAX_HTML_BYTES, htmlBytes + ' B');
  ok('设计文档存在且非空', doc.length > 4000, doc.length + ' 字符');
  ok('样张是完整 HTML', /^<!DOCTYPE html>/i.test(html.trim()) && /<\/html>\s*$/i.test(html.trim()), '');

  // ---- 零外链 ----
  ok('无 http(s) 资源引用', !/https?:\/\//i.test(html), '');
  ok('无 @import', !/@import/i.test(html) && !/@import/i.test(css), '');
  ok('无 @font-face（不下载字体）', !/@font-face/i.test(css), '');
  ok('无 <link> / <script src> / <img> 外链标签', !/<link\b/i.test(html) && !/<script[^>]+src=/i.test(html) && !/<img\b/i.test(html), '');
  ok('CSS 里无 url(...) 引用', !/url\s*\(/i.test(css), '');
  ok('JS 里无网络请求', !/\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket/i.test(html), '');
  ok('文档里也无外链', !/https?:\/\//i.test(doc), '');

  // ---- token 完整性 ----
  ok('浅色 token 数 ≥40', light.size >= 40, light.size + ' 个');
  const missingInDark = [...light.keys()].filter((k) => !dark.has(k));
  const extraInDark = [...dark.keys()].filter((k) => !light.has(k));
  ok('每个 token 在 [data-theme=dark] 都有定义',
    missingInDark.length === 0 && extraInDark.length === 0 && dark.size === light.size,
    '缺 ' + missingInDark.length + ' / 多 ' + extraInDark.length + (missingInDark.length ? '：' + missingInDark.join(',') : ''));
  const colorish = [...light.entries()].filter(([, v]) => /^#|^rgb/i.test(v));
  const badColor = colorish.filter(([, v]) => !/^#[0-9A-Fa-f]{6}$/.test(v) && !/^rgba?\(\s*\d/.test(v));
  ok('颜色值格式合法（#RRGGBB / rgb(a)）', badColor.length === 0 && colorish.length >= 24,
    colorish.length + ' 个颜色 token，非法 ' + badColor.length);

  // ---- 尺度 token ----
  const has = (k) => light.has(k) && dark.has(k);
  const sizeLadder = ['--ui-font-12', '--ui-font-13', '--ui-font-14', '--ui-font-16', '--ui-font-20', '--ui-font-24'];
  ok('字号阶梯 12/13/14/16/20/24 齐全', sizeLadder.every(has) &&
    sizeLadder.map((k) => light.get(k)).join(',') === '12px,13px,14px,16px,20px,24px',
    sizeLadder.map((k) => light.get(k)).join(' '));
  const spaceLadder = ['--ui-space-1', '--ui-space-2', '--ui-space-3', '--ui-space-4', '--ui-space-5', '--ui-space-6'];
  ok('间距 4/8/12/16/24/32 齐全',
    spaceLadder.map((k) => light.get(k)).join(',') === '4px,8px,12px,16px,24px,32px',
    spaceLadder.map((k) => light.get(k)).join(' '));
  ok('圆角 6/10/14 齐全',
    ['--ui-radius-1', '--ui-radius-2', '--ui-radius-3'].map((k) => light.get(k)).join(',') === '6px,10px,14px', '');
  ok('阴影两级', has('--ui-shadow-1') && has('--ui-shadow-2'), '');
  ok('动效 120/180/240 + ease-out',
    ['--ui-dur-1', '--ui-dur-2', '--ui-dur-3'].map((k) => light.get(k)).join(',') === '120ms,180ms,240ms' &&
    /cubic-bezier\(0?\.2,\s*0,\s*0,\s*1\)/.test(light.get('--ui-ease') || ''), light.get('--ui-ease') || '');
  ok('中文优先系统字体栈',
    /system-ui/.test(light.get('--ui-font-sans') || '') &&
    /(PingFang SC|Microsoft YaHei)/.test(light.get('--ui-font-sans') || ''), '');

  // ---- 对比度：实算 ----
  const themeBlocks = { light, dark };
  const computed = { light: new Map(), dark: new Map() };
  for (const theme of ['light', 'dark']) {
    for (const [fg, bg, threshold, note] of CONTRAST_PAIRS) {
      const f = themeBlocks[theme].get(fg);
      const b = themeBlocks[theme].get(bg);
      computed[theme].set(fg + '|' + bg, f && b ? { ratio: contrast(f, b), threshold, note } : null);
    }
  }
  const bodyPairs = CONTRAST_PAIRS.filter((p) => p[2] === BODY);
  const badBody = [];
  for (const theme of ['light', 'dark']) {
    for (const [fg, bg] of bodyPairs) {
      const c = computed[theme].get(fg + '|' + bg);
      if (!c || c.ratio < BODY) badBody.push(theme + ' ' + fg + '/' + bg + '=' + (c ? c.ratio : 'null'));
    }
  }
  ok('正文级对比度全部 ≥4.5（实算）', badBody.length === 0,
    bodyPairs.length * 2 + ' 对，未过 ' + badBody.length + (badBody.length ? '：' + badBody.join('; ') : ''));
  const badGraphic = [];
  for (const theme of ['light', 'dark']) {
    for (const [fg, bg] of CONTRAST_PAIRS.filter((p) => p[2] === LARGE)) {
      const c = computed[theme].get(fg + '|' + bg);
      if (!c || c.ratio < LARGE) badGraphic.push(theme + ' ' + fg + '/' + bg + '=' + (c ? c.ratio : 'null'));
    }
  }
  ok('大字/图形/边界 ≥3.0（实算）', badGraphic.length === 0, badGraphic.join('; '));

  // ---- 文档表格逐行对账 ----
  // 只认「7 列且第 5 列是数字」的行：文档里另有色板表（4 列），不会被误当对比度行。
  const rows = doc.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\|/.test(l))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .filter((cells) => cells.length === 7 && /^\d+(\.\d+)?$/.test(cells[4]));
  const problems = [];
  for (const cells of rows) {
    const fgName = (cells[0].match(/--ui-[a-z0-9-]+/) || [])[0];
    const bgName = (cells[2].match(/--ui-[a-z0-9-]+/) || [])[0];
    const fgHex = (cells[1].match(/#[0-9A-Fa-f]{6}/) || [])[0];
    const bgHex = (cells[3].match(/#[0-9A-Fa-f]{6}/) || [])[0];
    const docRatio = parseFloat(cells[4]);
    const docThreshold = parseFloat(cells[5]);
    const verdict = cells[6];
    if (!fgName || !bgName || !fgHex || !bgHex || Number.isNaN(docRatio) || Number.isNaN(docThreshold)) {
      problems.push('行内取不到 token/色值/比值：' + row.slice(0, 80)); continue;
    }
    // 同一 token 名在两种主题各有一行，按这一行的色值判定属于哪套
    let themeKey = null;
    for (const t of ['light', 'dark']) {
      if ((themeBlocks[t].get(fgName) || '').toUpperCase() === fgHex.toUpperCase()) { themeKey = t; break; }
    }
    if (!themeKey) { problems.push('文档里的 ' + fgName + '=' + fgHex + ' 与样张 token 不一致'); continue; }
    if ((themeBlocks[themeKey].get(bgName) || '').toUpperCase() !== bgHex.toUpperCase()) {
      problems.push('文档里的 ' + bgName + '=' + bgHex + ' 与样张 token 不一致'); continue;
    }
    const truth = contrast(fgHex, bgHex);
    if (Math.abs(truth - docRatio) > 0.02) problems.push(fgName + '/' + bgName + ' 文档写 ' + docRatio + '，实算 ' + truth);
    if (/✅/.test(verdict) && truth < docThreshold) problems.push(themeKey + ' ' + fgName + '/' + bgName + ' 标 ✅ 但 ' + truth + ' < ' + docThreshold);
    if (/⚠/.test(verdict) && truth < LARGE) problems.push(themeKey + ' ' + fgName + '/' + bgName + ' 标 ⚠ 但 ' + truth + ' < 3.0');
    if (/❌/.test(verdict)) problems.push(themeKey + ' ' + fgName + '/' + bgName + ' 标 ❌ 未修');
    if (!/✅|⚠|❌/.test(verdict)) problems.push('结论列无法识别：' + verdict);
  }
  const expectedRows = CONTRAST_PAIRS.length * 2;
  ok('对比度表行数 = 配对数 × 2', rows.length === expectedRows, '文档 ' + rows.length + ' 行 / 应有 ' + expectedRows);
  ok('对比度表与实算逐行一致（容差 0.02）', problems.length === 0,
    problems.length ? problems.length + ' 处：' + problems.slice(0, 6).join('；') : rows.length + ' 行全部对上');

  // ---- 反模式 ----
  ok('粉色 #E8467C 不做文字色（只用 --ui-accent-ink）', !/color\s*:\s*var\(--ui-accent\)\s*[;}]/.test(css), '');
  ok('焦点环 2px outline + 偏移',
    /:focus-visible/.test(css) && /outline\s*:\s*var\(--ui-focus-width\)/.test(css) && light.get('--ui-focus-width') === '2px', '');
  ok('prefers-reduced-motion 关动画',
    /@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(css) && /animation-duration:\s*0?\.01ms\s*!important/.test(css), '');
  ok('深浅色切换真接线',
    /data-theme=['"]dark['"]/.test(html) && /getElementById\('themeToggle'\)/.test(html) && /localStorage/.test(html), '');
  ok('品牌名只在单点定义', (html.match(/QQ DeepSeek Bot/g) || []).length === 1,
    '出现 ' + (html.match(/QQ DeepSeek Bot/g) || []).length + ' 次');
  ok('无第三方产品名/来源声明',
    !/(nap\s*cat)|(hero\s*ui)|(tail\s*wind)|(react\s*19)/i.test(html) && !/(nap\s*cat)|(hero\s*ui)|(tail\s*wind)/i.test(doc), '');

  // ---- 组件齐全 ----
  for (const [name, selector, marker] of COMPONENTS) {
    const cssOk = css.includes(selector);
    const htmlOk = html.includes(marker);
    ok('组件：' + name, cssOk && htmlOk, (cssOk ? '' : '缺 CSS ') + (htmlOk ? '' : '缺标记'));
  }

  // ---- 仪表盘样张 ----
  ok('样张含 4 张状态卡', (html.match(/class='qdb-card qdb-stat'/g) || []).length === 4, '');
  ok('样张含服务列表', /id='services'/.test(html) && /服务列表/.test(html), '');
  ok('样张含会话列表', /id='sessions'/.test(html) && /会话列表/.test(html), '');
  ok('样张含日志流', /id='logs'/.test(html) && /class='qdb-log'/.test(html), '');

  // ---- 响应式三档 ----
  ok('有 900px 断点（桌面→平板）', /@media\s*\(max-width:\s*900px\)/.test(css), '');
  ok('有 560px 断点（平板→手机）', /@media\s*\(max-width:\s*560px\)/.test(css), '');
  ok('窄屏不靠固定宽度撑破', !/width\s*:\s*1[0-9]{3}px/.test(css), '');
  ok('表格窄屏横向滚动 + 网格可收缩',
    /\.qdb-table-wrap\s*\{[^}]*overflow-x:\s*auto/.test(css) && /minmax\(0,\s*1fr\)/.test(css), '');

  // ---- 文档结构 ----
  const chapters = ['色板', '字体', '间距', '圆角', '阴影', '组件', '动效', '可访问性', '命名', '替换', '版权', '对比度'];
  const missingChapters = chapters.filter((c) => !doc.includes(c));
  ok('文档含必备章节', missingChapters.length === 0,
    missingChapters.length ? '缺：' + missingChapters.join(',') : chapters.length + ' 个关键词齐');

  // ---- 输出 ----
  const failed = results.filter((r) => !r.pass);
  if (args.has('--json')) {
    process.stdout.write(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed }, null, 2) + '\n');
  } else {
    for (const r of results) {
      process.stdout.write((r.pass ? '  PASS ' : '  FAIL ') + r.name + (r.detail ? '  [' + r.detail + ']' : '') + '\n');
    }
    process.stdout.write('\nUI 设计系统断言：' + (results.length - failed.length) + '/' + results.length + ' 通过\n');
    if (failed.length) process.stdout.write('失败 ' + failed.length + ' 项，见上。\n');
  }
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SELF_FILE)) main();
