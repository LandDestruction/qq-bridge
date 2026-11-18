// BOOTH 搜索页解析 + 候选排序（P3 找号主链的纯函数部分）。
//
// 为什么单独一个模块：解析、打分、封面指纹比对都可以离线复现（fixture 里有真实搜索页），
// 不联网也能单测；网络与限速留在桥接那边（复用 booth-meta.js 的节流与缓存）。
//
// 真实页面结构（2026-10-29 抓的 https://booth.pm/ja/search/VRChat%20Mew）：
//   <li class="item-card l-card" data-product-id="7850009" data-product-name="…"
//       data-product-price="1190" data-product-brand="foxyplay" data-product-position="0">
//     <a class="js-thumbnail-image" data-original="https://booth.pximg.net/…/7850009/….jpg">
//     <div class="item-card__title"><a class="item-card__title-anchor--multiline …">标题</a></div>
//     <a class="item-card__shop-name-anchor" href="https://foxyplay.booth.pm/">店铺</a>
//   </li>
// 分页：<a rel="next" class="nav-item" href="/ja/search/<词>?page=2">；总数：<b>対象商品 77 件</b>。
//
// 注意：`data-product-name` 会被站点截断（"…"），所以标题优先取 title-anchor 的文本。

export const BOOTH_SEARCH_BASE = 'https://booth.pm/ja/search/';
/** 一个搜索词最多翻几页（候选够用就行，翻太多既慢又容易触发限速）。 */
export const BOOTH_SEARCH_MAX_PAGES = 2;
/** 封面 dHash 汉明距 ≤ 这个值判「同一张图」（8×8 dHash 的常用阈值）。 */
export const BOOTH_COVER_HAMMING_MAX = 10;
/** 自动勾选的最低总分；没封面指纹时要求更高（只靠标题不可靠）。 */
export const BOOTH_AUTO_SCORE = 0.62;
export const BOOTH_AUTO_SCORE_NO_COVER = 0.82;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? m : named;
  });
}

export function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** 拼搜索页地址。BOOTH 的搜索是「路径 + ?page=」：/ja/search/<词>?page=2。 */
export function buildBoothSearchUrl({ query = '', page = 1 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索词不能为空');
  const p = Math.max(1, Math.min(50, Math.round(Number(page) || 1)));
  const url = BOOTH_SEARCH_BASE + encodeURIComponent(q).replace(/%20/g, '%20');
  return p > 1 ? `${url}?page=${p}` : url;
}

function firstMatch(text, re) {
  const m = re.exec(text);
  return m ? m[1] : '';
}

/**
 * 解析一页搜索结果。
 * @returns {{items: Array<{boothId:string,title:string,shopName:string,shopUrl:string,price:number|null,
 *   thumbUrl:string,itemUrl:string,position:number|null}>, total:number|null, hasNext:boolean, nextUrl:string}}
 */
export function parseBoothSearchHtml(html) {
  const src = String(html ?? '');
  const items = [];
  const cardRe = /<li[^>]*class="[^"]*\bitem-card\b[^"]*"[\s\S]*?<\/li>/g;
  let m;
  while ((m = cardRe.exec(src))) {
    const block = m[0];
    const boothId = firstMatch(block, /data-product-id="(\d+)"/);
    if (!boothId) continue;
    const priceRaw = firstMatch(block, /data-product-price="(\d+)"/);
    const anchor = firstMatch(block, /class="[^"]*item-card__title-anchor[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const nameAttr = firstMatch(block, /data-product-name="([^"]*)"/);
    const title = (anchor ? stripTags(anchor) : '') || decodeEntities(nameAttr).replace(/[…\.]{1,3}$/, '').trim();
    const shopName = firstMatch(block, /class="[^"]*item-card__shop-name-anchor[^"]*"[\s\S]*?>(?:[\s\S]*?<img[^>]*alt="([^"]*)")?/)
      || firstMatch(block, /<img[^>]*alt="([^"]*)"[^>]*class="[^"]*user-avatar/);
    const shopUrl = firstMatch(block, /href="(https:\/\/[a-z0-9-]+\.booth\.pm\/)"/);
    const thumbUrl = firstMatch(block, /data-original="([^"]+)"/);
    const itemUrl = `https://booth.pm/ja/items/${boothId}`;
    const positionRaw = firstMatch(block, /data-product-position="(\d+)"/);
    const price = priceRaw === '' ? null : Number(priceRaw);
    items.push({
      boothId,
      title: title || `BOOTH ${boothId}`,
      shopName: stripTags(shopName),
      shopUrl,
      price: Number.isFinite(price) ? price : null,
      thumbUrl: decodeEntities(thumbUrl),
      itemUrl,
      position: positionRaw === '' ? null : Number(positionRaw)
    });
  }
  const totalText = firstMatch(src, /対象商品\s*([\d,]+)\s*件/);
  const total = totalText ? Number(totalText.replace(/,/g, '')) : null;
  const nextTag = /<a[^>]*rel="next"[^>]*>/.exec(src)?.[0] || '';
  const nextUrl = firstMatch(nextTag, /href="([^"]+)"/) || firstMatch(src, /<a[^>]*href="([^"]+)"[^>]*rel="next"/);
  return { items, total: Number.isFinite(total) ? total : null, hasNext: Boolean(nextUrl), nextUrl: decodeEntities(nextUrl) };
}

// ── 标题归一与相似度 ────────────────────────────────────────────────────
const NOISE = /[【】\[\]()（）「」『』<>《》\-_/\\|,，.。!！?？:：;；'"“”‘’~〜*\s]+/g;

/** 归一：全角转半角、去 emoji/符号、统一空格、小写。 */
export function normalizeTitle(text) {
  return String(text ?? '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\u{1f000}-\u{1faff}\u{2600}-\u{27bf}]/gu, ' ')
    .toLowerCase()
    .replace(NOISE, ' ')
    .trim();
}

export function titleTokens(text) {
  return normalizeTitle(text).split(' ').filter((t) => t.length > 0);
}

/** 最长公共子序列长度（滚动数组，两个标题长度都 ≤200，够用且不爆栈）。 */
function lcsLength(a, b) {
  if (!a || !b) return 0;
  const prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev.set(cur);
    cur.fill(0);
  }
  return prev[b.length];
}

/** OSA（相邻交换算 1 次）编辑距离，带长度剪枝。 */
export function osaDistance(a, b, { max = 64 } = {}) {
  const s = String(a ?? '');
  const t = String(b ?? '');
  if (s === t) return 0;
  if (Math.abs(s.length - t.length) > max) return max + 1;
  const n = s.length;
  const m = t.length;
  if (!n) return m;
  if (!m) return n;
  let prev2 = new Uint16Array(m + 1);
  let prev = new Uint16Array(m + 1);
  let cur = new Uint16Array(m + 1);
  for (let j = 0; j <= m; j += 1) prev[j] = j;
  for (let i = 1; i <= n; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= m; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      }
    }
    const swap = prev2; prev2 = prev; prev = cur; cur = swap;
  }
  return prev[m];
}

/** 标题相似度 0~1：0.6×字符级相似 + 0.4×词集合 Jaccard。 */
export function titleSimilarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dist = osaDistance(na, nb, { max: Math.max(na.length, nb.length) });
  const charSim = 1 - dist / Math.max(na.length, nb.length);
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  let inter = 0;
  ta.forEach((t) => { if (tb.has(t)) inter += 1; });
  const union = ta.size + tb.size - inter;
  const jaccard = union > 0 ? inter / union : 0;
  const lcs = lcsLength(na, nb) / Math.max(na.length, nb.length);
  return Math.max(0, Math.min(1, 0.45 * charSim + 0.3 * jaccard + 0.25 * lcs));
}

// ── 封面指纹 ────────────────────────────────────────────────────────────
export function coverDistance(hashA, hashB) {
  const a = String(hashA ?? '');
  const b = String(hashB ?? '');
  if (a.length !== b.length || !a) return null;
  if (!/^[0-9a-fA-F]+$/.test(a) || !/^[0-9a-fA-F]+$/.test(b)) return null;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { diff += x & 1; x >>= 1; }
  }
  return diff;
}

export function coverMatch(hashA, hashB, { max = BOOTH_COVER_HAMMING_MAX } = {}) {
  const d = coverDistance(hashA, hashB);
  return d === null ? { match: false, distance: null } : { match: d <= max, distance: d };
}

// ── 搜索词生成 ──────────────────────────────────────────────────────────
/** 从「文件名/标题 + 可选店铺名」生成最多 4 个搜索词（顺序即优先级）。 */
export function searchPhrasesFor({ title = '', shop = '', boothId = '' } = {}) {
  const out = [];
  const push = (v) => {
    const q = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (q && !out.includes(q)) out.push(q);
  };
  const raw = String(title ?? '').trim();
  const base = raw.replace(/\.(zip|rar|7z|unitypackage)$/i, '');
  // 1) 精简标题：去掉开头商品号、括号里的版本/语言备注与末尾的「- 复制」之类
  const slim = base
    .replace(/^\d{5,9}[\s_-]*/, '')
    .replace(/【[^】]{0,12}(?:版|ver\.?|v\d)[^】]*】/gi, ' ')
    .replace(/\s*[-_]\s*(?:copy|副本|下载说明).*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  push(slim || base);
  // 2) 带店铺名：店铺是强约束，能直接把候选压到少数几个
  if (shop) push(`${slim || base} ${shop}`);
  const noId = base.replace(/^\d{5,9}[\s_-]*/, '');
  // 3) 拆驼峰/下划线：VRChatAvatar → VRChat Avatar
  const spaced = noId.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  if (spaced && spaced !== slim) push(spaced);
  // 4) 尾巴：取标题里最长的一段（>=6 字），常用于「文件名带了太多前缀」的情况
  const tail = (slim || noId).split(/[\s\-_]+/).filter((w) => w.length >= 6).slice(-1)[0];
  if (tail) push(tail);
  return out.slice(0, 4);
}

// ── 候选打分 ────────────────────────────────────────────────────────────
const WEIGHT_TITLE = 0.55;
const WEIGHT_COVER = 0.30;
const WEIGHT_SHOP = 0.15;

/**
 * 给候选打分并排序。
 * @param {object} input
 * @param {string} input.title 素材标题（文件名去掉扩展名）
 * @param {string} [input.shop] 素材已知店铺名（通常没有）
 * @param {string[]} [input.excludeIds] 已经绑定到别的素材的号，不参与排序
 * @param {Array} input.candidates parseBoothSearchHtml 的 items
 * @param {string} [input.coverHash] 本地预览图的 dHash（16 位十六进制）
 * @param {Record<string,string>} [input.coverHashes] boothId → 远端封面 dHash
 * @returns {Array<object>} 每项带 score/titleScore/cover/shopMatch/reasons
 */
export function rankBoothCandidates({ title = '', shop = '', candidates = [], coverHash = '', coverHashes = {}, excludeIds = [] } = {}) {
  const excluded = new Set((excludeIds || []).map(String));
  const localShop = normalizeTitle(shop);
  // 本地没有封面指纹时（素材还没缩略图 / 算失败），封面那 0.30 权重等于永久拿不到：
  // 那样「标题完全一致」也只能到 55 分，永远过不了自动勾选线。这里把权重按可用信号
  // 重新归一化（标题 0.85 + 店铺 0.15），只在「压根没有本地指纹」时生效。
  const hasLocalCover = Boolean(String(coverHash || '').trim());
  const wTitle = hasLocalCover ? WEIGHT_TITLE : 0.85;
  const wCover = hasLocalCover ? WEIGHT_COVER : 0;
  const wShop = hasLocalCover ? WEIGHT_SHOP : 0.15;
  const ranked = [];
  for (const c of candidates) {
    if (!c || !c.boothId || excluded.has(String(c.boothId))) continue;
    const titleScore = titleSimilarity(title, c.title);
    const remoteHash = coverHashes[c.boothId] || c.thumbHash || '';
    const cover = hasLocalCover ? coverMatch(coverHash, remoteHash) : { match: false, distance: null };
    const shopMatch = Boolean(localShop) && normalizeTitle(c.shopName) === localShop;
    const score = wTitle * titleScore + wCover * (cover.match ? 1 : 0) + wShop * (shopMatch ? 1 : 0);
    const reasons = [];
    if (cover.match) reasons.push(`封面指纹一致（汉明距 ${cover.distance}）`);
    else if (cover.distance !== null) reasons.push(`封面不像（汉明距 ${cover.distance}）`);
    if (titleScore >= 0.85) reasons.push('标题几乎一致');
    else if (titleScore >= 0.6) reasons.push('标题相近');
    if (shopMatch) reasons.push('店铺一致');
    if (!reasons.length) reasons.push(`标题相似度 ${Math.round(titleScore * 100)}%`);
    ranked.push({
      ...c,
      score: Math.round(score * 1000) / 1000,
      titleScore: Math.round(titleScore * 1000) / 1000,
      coverMatch: cover.match,
      coverDistance: cover.distance,
      shopMatch,
      reasons
    });
  }
  ranked.sort((a, b) => b.score - a.score || b.titleScore - a.titleScore || Number(a.boothId) - Number(b.boothId));
  return ranked;
}

/**
 * 根据排序结果给出「要不要自动勾选」的建议。
 * 原则：只有拿到封面指纹一致（或标题几乎一致）才敢默认勾；其余一律让人点。
 */
export function proposeBinding(ranked, { minScore = BOOTH_AUTO_SCORE, minScoreNoCover = BOOTH_AUTO_SCORE_NO_COVER } = {}) {
  const list = Array.isArray(ranked) ? ranked : [];
  const top = list[0] || null;
  if (!top) return { pick: null, auto: false, reason: '没有候选' };
  // 前两名咬得太紧时一律让人点 —— 绑错号的代价比多点一下大得多
  const second = list[1];
  if (second && Math.abs(second.score - top.score) < 0.05) {
    return { pick: top, auto: false, reason: '前两名分数接近，需要你确认' };
  }
  // 封面指纹一致是最强证据：标题相关就行；标题完全对不上时，只有指纹几乎完全相同（≤4 位）
  // 才敢默认勾 —— 改色/衍生版本来就会改几位指纹，那种必须人看一眼。
  if (top.coverMatch && (top.titleScore >= 0.2 || top.coverDistance <= 4)) {
    const why = top.titleScore >= 0.2
      ? `封面指纹一致（汉明距 ${top.coverDistance}），标题相关 ${Math.round(top.titleScore * 100)}%`
      : `封面几乎完全相同（汉明距 ${top.coverDistance}），标题对不上但指纹够硬`;
    return { pick: top, auto: true, reason: why };
  }
  const need = top.coverMatch ? minScore : minScoreNoCover;
  if (top.score >= need) {
    return { pick: top, auto: true, reason: `标题高度一致（${Math.round(top.titleScore * 100)}%）` };
  }
  return { pick: top, auto: false, reason: `最高分 ${Math.round(top.score * 100)}%，低于自动勾选线` };
}
