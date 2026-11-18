// BOOTH 页面分类 → 本地目录名的固定映射（B 的卡片库页面直接显示这个目录名）。
//
// 为什么要有映射表：BOOTH 的 category.name 是日文自由文本（还可能带括号/空格），
// 直接当目录名会出现「3D衣装(セール)」「素材/テクスチャ」这类不稳定值；
// 固定映射后，同一类商品永远落同一个目录，未知分类一律进「未分类」。

/** BOOTH 页面分类 → 本地目录名（值是最终目录名，可单测）。 */
export const BOOTH_CATEGORY_MAP = Object.freeze({
  // 常见顶层分类
  '3D衣装': '3D衣装',
  '3Dモデル': '3Dモデル',
  '3D小道具': '3D小道具',
  '素材': '素材',
  'ツール': 'ツール',
  '音声': '音声',
  'その他': 'その他',
  // 常见子类/别名 → 归到上面的稳定目录
  'テクスチャ': '素材',
  'シェーダー': '素材',
  'アニメーション': '素材',
  'モーション': '素材',
  '3Dモデル（その他）': '3Dモデル',
  '3D衣装（その他）': '3D衣装',
  'VRChat': 'その他',
  'VTuber': 'その他',
  'その他（その他）': 'その他'
});

/** 分类名的路径非法字符（Windows 更严格，统一按最严的来）。 */
const ILLEGAL_PATH_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 目录名清洗：去掉非法字符、首尾点/空格，空串回退「未分类」。 */
export function sanitizeCategoryName(raw) {
  let name = String(raw ?? '').replace(ILLEGAL_PATH_CHARS, '').replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!name) return '未分类';
  return name.slice(0, 40);
}

/**
 * 规范化 BOOTH 分类：先精确匹配映射表，再尝试去掉括号后缀匹配，仍未知 → 未分类。
 * @param {string} raw BOOTH 页面 category.name（可能为空）
 * @returns {string} 本地目录名
 */
export function normalizeBoothCategory(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '未分类';
  if (BOOTH_CATEGORY_MAP[text]) return sanitizeCategoryName(BOOTH_CATEGORY_MAP[text]);
  // 「3D衣装（セール）」→ 去括号再试一次
  const stripped = text.replace(/[（(][^）)]*[）)]/g, '').trim();
  if (BOOTH_CATEGORY_MAP[stripped]) return sanitizeCategoryName(BOOTH_CATEGORY_MAP[stripped]);
  return '未分类';
}
