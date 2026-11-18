// 找号（P3）：把「一件没号/号可疑的素材」变成「BOOTH 候选列表」的纯规则部分。
// 网络抓取、封面指纹计算、缓存都在桥接侧（src/bridge/console/library-find.js），这里只做
// 可单测的裁剪与描述，避免把 300 行网络代码塞进纯函数里。

export const FIND_MAX_CANDIDATES = 6;

// ── 搜索保护闸（P0）──────────────────────────────────────────────────────────
// 暂停的纯规则已挪到 src/booth-pause.js（商品页/封面抓取也要遵守同一份全局暂停），
// 这里保留 re-export：`deps.libraryFindPure` 注入的命名空间与既有测试都还按旧名字取用，
// 一行都不用改。
export {
  SEARCH_PAUSE_429_MS,
  SEARCH_PAUSE_403_MS,
  SEARCH_PAUSE_MIN_MS,
  SEARCH_PAUSE_MAX_MS,
  searchPauseFor,
  normalizeSearchPause,
  searchPauseState,
  describeSearchPause
} from './booth-pause.js';

// ── 补封面（P0-2）───────────────────────────────────────────────────────────
// 为什么关键：排序里「没有本地封面」会把封面权重整段抹掉（src/booth-search.js 归一化成
// wTitle=0.85/wCover=0/wShop=0.15），而 shopMatch 几乎恒 false → 分数天花板 0.85×titleScore。
// 也就是说**没有封面的素材，自动采纳在数学上就不可能**。所以绑号/采纳后第一件事是补封面：
// 把 BOOTH 缓存里的封面复制进素材目录，下一次扫描 thumbRel 就有值了。
// 文件名必须跟着「主件名」走，不能叫 `<boothId>.jpg`：
// library-asset 认件时，一个目录里有多个压缩包就按「名字相似度」把图配给最像的包；
// `<boothId>.jpg` 和包名毫无相似度 → 只能进 loose 散图列表，thumbRel 永远是空的（实测就是这样）。
// 叫 `<主件stem>.thumbnail.jpg`：既和主件同名（配对得分高），又命中 isThumb（排第一当封面）。
export function coverFileNameFor(boothId, mainName = '') {
  const id = String(boothId ?? '').trim();
  if (!/^\d{5,9}$/.test(id)) return '';
  const base = String(mainName ?? '').replace(/\\/g, '/').split('/').pop();
  const stem = base.replace(/\.[a-z0-9]{1,6}$/i, '').trim();
  return stem ? `${stem}.thumbnail.jpg` : `${id}.jpg`;
}

/**
 * 补封面的落盘计划（纯判定；真正的复制在桥接层）。
 * @returns {{fileName:string, relPath:string}|null} null = 不用补（没有号 / 已经有同名文件）
 */
export function coverPlan({ boothId = '', dir = '', exists = false, mainName = '' } = {}) {
  const fileName = coverFileNameFor(boothId, mainName);
  if (!fileName || exists) return null;
  const relDir = String(dir ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return { fileName, relPath: relDir ? `${relDir}/${fileName}` : fileName };
}

// ── 失败分类（批量找号「只重试失败」要用）──────────────────────────────────
export const FIND_FAILURE_CODES = Object.freeze(['rate_limit', 'timeout', 'no_candidates', 'no_phrase', 'error']);

/** 把一次找号结果/异常归到固定的失败码上（前端按码给「只重试失败」）。 */
export function failureCodeOf({ paused = false, candidates = 0, errors = [] } = {}) {
  if (paused) return 'rate_limit';
  const text = (Array.isArray(errors) ? errors : []).map((e) => String(e ?? '')).join(' ');
  if (/超时|timeout/i.test(text)) return 'timeout';
  if (!Number(candidates)) return 'no_candidates';
  return '';
}

/** 搜索页解析出来的商品按「位置」截断，最多留 40 条进排序（再多是噪声，排序也没意义）。 */
export function pickPool(items, { max = 40 } = {}) {
  const list = Array.isArray(items) ? items : [];
  return list
    .filter((it) => it && /^\d{5,9}$/.test(String(it.boothId ?? '')))
    .slice(0, Math.max(1, max));
}

/** 候选进前端前的裁剪：只留列表要显示的字段 + 打分依据。 */
export function toResponseCandidate(ranked) {
  if (!ranked) return null;
  return {
    boothId: String(ranked.boothId ?? ''),
    title: String(ranked.title ?? '').slice(0, 200),
    shopName: String(ranked.shopName ?? '').slice(0, 80),
    price: Number(ranked.price) || 0,
    itemUrl: String(ranked.itemUrl ?? ''),
    thumbUrl: String(ranked.thumbUrl ?? ''),
    score: Math.round(Number(ranked.score || 0) * 1000) / 1000,
    titleScore: Math.round(Number(ranked.titleScore || 0) * 1000) / 1000,
    coverMatch: Boolean(ranked.coverMatch),
    coverDistance: Number.isFinite(Number(ranked.coverDistance)) ? Number(ranked.coverDistance) : null,
    shopMatch: Boolean(ranked.shopMatch),
    reasons: Array.isArray(ranked.reasons) ? ranked.reasons.slice(0, 4) : []
  };
}

/**
 * 一句话说明这次找号的结果（前端弹层顶部那行）。
 * @param {{candidates:number, phrases:string[], coverChecked:number, auto:boolean}} input
 */
export function describeFindSummary({ candidates = 0, phrases = [], coverChecked = 0, auto = false } = {}) {
  const words = [];
  if (!candidates) {
    words.push('没有搜到候选');
  } else {
    words.push(`搜到 ${candidates} 个候选${coverChecked ? `（比对了 ${coverChecked} 张封面指纹）` : ''}`);
  }
  if (Array.isArray(phrases) && phrases.length) words.push(`搜的是「${phrases[0]}」`);
  if (auto) words.push('第一个看起来就是它，已默认帮你选中');
  return words.join('；');
}
