// src/library-usage-roots.js — 「工程使用统计」的根目录取值规则（纯函数，零 I/O）。
//
// 为什么单独抽：配置里的 usageRoots 有两种形态（用户写相对路径 / 写绝对路径），
// 而 POST /api/library/import-to-unity 需要「用户点选的那个 root 必须确实是已配置的根」——
// 这条校验如果散在路由里，各路由对「/E:/projects 算不算同一根」就会各写一套。

export const USAGE_ROOT_MAX_CHARS = 400;

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * 单个扫描根规整：去空白、去包裹引号、去掉尾部斜杠（保留盘符根 `E:/`）。
 * 不合法（空串/含控制字符/超长）返回 ''。
 */
export function normalizeUsageRoot(value) {
  let text = String(value ?? '').trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    text = text.slice(1, -1).trim();
  }
  if (!text || text.length > USAGE_ROOT_MAX_CHARS || CONTROL_RE.test(text)) return '';
  // 统一成 `/`：Windows 用户两种都写，配置里同一个根不该因为斜杠方向被当成两个。
  text = text.replace(/\\/g, '/');
  if (text.length > 1) text = text.replace(/\/+$/, '');
  return text;
}

/** 一串根：逐个规整、去重、保序。 */
export function normalizeUsageRoots(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const root = normalizeUsageRoot(raw);
    if (root && !out.includes(root)) out.push(root);
  }
  return out;
}

/**
 * 用户传进来的 root 是否等价于已配置的某个根。
 * 绝对/相对都交给调用方解析成绝对路径后再比（这里只做字符串口径的统一），
 * 另有 `baseDir` 时把相对路径拼到 baseDir 上一起比。
 */
export function matchConfiguredUsageRoot(value, configured, { baseDir = '' } = {}) {
  const wanted = normalizeUsageRoot(value);
  if (!wanted) return '';
  const roots = normalizeUsageRoots(configured);
  if (roots.includes(wanted)) return wanted;
  const base = normalizeUsageRoot(baseDir);
  if (base) {
    const joined = normalizeUsageRoot(`${base}/${wanted}`);
    const hit = roots.find((root) => root === joined || root === normalizeUsageRoot(`${base}/${root}`));
    if (hit) return hit;
  }
  return '';
}

/** 一句话描述（报错文案用）。 */
export function describeUsageRoots(roots) {
  const list = normalizeUsageRoots(roots);
  if (list.length === 0) return '还没配置工程目录（设置 → 素材库 → 工程目录）';
  return `已配置 ${list.length} 个工程目录：${list.slice(0, 3).join('、')}${list.length > 3 ? ' 等' : ''}`;
}
