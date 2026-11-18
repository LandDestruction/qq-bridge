// 认号可信度：把「当前号 / 台账候选 / 标题相似度」算清楚，供素材页显示「已核准 / 待确认 / 无号」。
//
// 为什么需要：真机 31 件里 20 件没认到号，而现有 name-prefix 猜号会猜错（目录 5197537 与名字前缀 6985553 冲突，
// 采信了前缀 → 封面和商品名全对上别人）。猜错的号比没号更糟：它会去抓错商品的封面、显示错标题。
// 所以这里只输出「候选 + 分数 + 依据」，是否采纳由人确认（走已有的 state/booth-binds.json 绑定表）。
//
// 边界：纯函数、零 I/O、零网络；不做绑定、不写状态；同输入同输出（可单测）。
// 已购台账里有的号 = verified（真金白银买过）；人工绑定过的号也算 verified（见 library-bind-view.js）。

/** 每件最多给几条候选（前端只画 3 条以内）。 */
export const BIND_SUGGESTION_LIMIT = 3;
/** 低于这个相似度就不提：0.45 是「有两三个共同词」的量级，再低全是噪声。 */
export const BIND_MIN_SCORE = 0.45;

/** 括号里是「编号/版本/参数/密码」这类非名称内容时，整段去掉（如 `[RJ123456]`、`(v1.02)`、`【再配布】` 的号）。 */
const BRACKET_RE = /[\[【（(]([^\]】）)]{0,60})[\]】）)]/g;
const EXT_RE = /\.(zip|rar|7z|tar|gz|tgz|unitypackage|fbx|blend|vrm|png|jpe?g|webp|gif|txt|md|pdf|url)$/i;
const CODE_INNER_RE = /^(?:rj|rjb|v)?\s*\d{2,9}(?:[._]\d+)*$/i;
const CODE_ANY_RE = /\d{5,9}/;

/** 括号里这段像不像「编号」而不是名称。 */
function looksLikeCode(inner) {
  const text = String(inner ?? '').normalize('NFKC').trim().toLowerCase();
  if (!text) return true;
  if (CODE_INNER_RE.test(text)) return true;
  if (CODE_ANY_RE.test(text)) return true;
  if (/(パスワード|password|passwd|解凍|解压|解壓|再配布|規約|利用規約|readme|説明)/i.test(text)) return true;
  return false;
}

/**
 * 归一化标题：去扩展名、去「编号类」括号段、全角→半角、小写、压空格。
 * @param {string} value
 * @returns {string}
 */
export function normalizeTitle(value) {
  let text = String(value ?? '').trim();
  if (!text) return '';
  text = text.replace(EXT_RE, '');
  text = text.replace(BRACKET_RE, (whole, inner) => (looksLikeCode(inner) ? ' ' : whole));
  text = text.normalize('NFKC');
  text = text.replace(/[_\-–—・.|/\\]+/g, ' ');
  text = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return text;
}

/** 展示用清洗：和 normalizeTitle 一样去噪声，但保留大小写（标题要给人看）。 */
export function cleanDisplayTitle(value) {
  let text = String(value ?? '').trim();
  if (!text) return '';
  text = text.replace(EXT_RE, '');
  text = text.replace(BRACKET_RE, (whole, inner) => (looksLikeCode(inner) ? ' ' : whole));
  text = text.normalize('NFKC');
  text = text.replace(/[_]+/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function cjkBigrams(run) {
  const chars = Array.from(run);
  if (!chars.length) return [];
  if (chars.length === 1) return [chars[0]];
  const out = [];
  for (let index = 0; index < chars.length - 1; index += 1) out.push(chars[index] + chars[index + 1]);
  return out;
}

/**
 * 分词：拉丁按词、日文/中文按 2-gram（2-gram 对「同一个系列名、后缀不同」最稳，不需要词典）。
 * @param {string} text
 * @returns {string[]} 去重后的 token
 */
export function titleTokens(text) {
  const norm = normalizeTitle(text);
  if (!norm) return [];
  const out = [];
  for (const part of norm.split(/\s+/).filter(Boolean)) {
    if (/^[a-z0-9]+$/.test(part)) { out.push(part); continue; }
    const pieces = part.match(/[a-z0-9]+|[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]+/gi) || [];
    for (const piece of pieces) {
      if (/^[a-z0-9]+$/i.test(piece)) out.push(piece.toLowerCase());
      else out.push(...cjkBigrams(piece));
    }
  }
  return Array.from(new Set(out));
}

/**
 * 标题相似度（Dice 系数，0~1）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function titleScore(a, b) {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (!ta.length || !tb.length) return 0;
  const setA = new Set(ta);
  const setB = new Set(tb);
  let hit = 0;
  for (const token of setA) if (setB.has(token)) hit += 1;
  const score = (2 * hit) / (setA.size + setB.size);
  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

/** 素材身上「已经有的号/目录里像号的段」，用来判定「档案里直接命中」（这种给 1.0）。 */
function candidateIdsOf(asset) {
  const ids = [];
  const push = (value) => {
    const text = String(value ?? '').trim();
    if (/^\d{5,9}$/.test(text) && !ids.includes(text)) ids.push(text);
  };
  push(asset?.boothId);
  for (const candidate of Array.isArray(asset?.boothCandidates) ? asset.boothCandidates : []) {
    push(candidate?.boothId ?? candidate?.id ?? candidate);
  }
  for (const segment of String(asset?.dir ?? '').split(/[\\/]/)) push(segment);
  return ids;
}

/**
 * 从素材目录里取「BOOTH 商品号」：目录结构的 `<商品号>/<下载文件>.zip` 里的纯数字段。
 *
 * 为什么这条比名字前缀可信：真正发生过的事是——目录 `5197537/`（商品号）里放着
 * `6985553.zip`（下载文件 id），旧逻辑优先信文件名前缀，把 16 件全绑到了下载 id 上，
 * 于是商品名/封面全对上了别的商品。目录是我们自己转存时按商品建的，数字段命中台账才是真号。
 *
 * 只取**第一段纯数字**（群目录常写成 `100000001_扣1复活牢大/9028816`，第一段混了文字要跳过）。
 * @param {object} asset
 * @returns {string} 合法号或 ''
 */
export function dirBoothIdOf(asset) {
  for (const segment of String(asset?.dir ?? '').split(/[\\/]/)) {
    const text = segment.trim();
    if (/^\d{5,9}$/.test(text)) return text;
  }
  return '';
}

/**
 * 号从哪来：`dir`（目录命中台账，最高）> `bind`（人工绑定）> `download-id`（文件名前缀＝下载文件 id）> `guess`。
 * 顺序由 `resolveBoothId` 统一决定，视图层不要各写一套。
 */
export function boothIdSourceOf(asset) {
  const source = String(asset?.boothSource ?? '').trim();
  if (source === 'name-prefix') return 'download-id';
  return source || 'guess';
}

function suggestionOf(item, score, source, kind = '') {
  return {
    boothId: String(item?.boothId ?? ''),
    title: String(item?.title ?? '').slice(0, 200),
    shop: String(item?.shopName ?? item?.shop ?? '').slice(0, 120),
    coverUrl: String(item?.coverUrl ?? ''),
    score: Number(Number(score).toFixed(4)),
    source,
    // kind 给前端区分「这是商品号」还是「这只是下载文件 id」——后者要提示「待人工确认」。
    kind: kind || (source === 'download-id' ? 'download-id' : 'item-id')
  };
}

/**
 * 解析一件素材「应该采信哪个号」。
 *
 * 优先级（2026-10-30 用户反馈后定）：目录号命中已购台账 > 人工绑定 > 素材自带号（名字前缀只是下载 id）。
 * 只有前两种算 verified；第三种一律当候选/提示，不许拿去抓封面、不许显示台账商品名。
 * @param {object} asset
 * @param {Set<string>} verifiedIds 已购台账 ∪ 人工绑定的号
 * @param {string} [bindBoothId] 人工绑定表里这件绑的号
 * @returns {{boothId:string, source:'dir'|'bind'|'download-id'|'guess', verified:boolean}}
 */
export function resolveBoothId(asset, verifiedIds, bindBoothId = '') {
  const ids = verifiedIds instanceof Set ? verifiedIds : new Set();
  const dirId = dirBoothIdOf(asset);
  if (dirId && ids.has(dirId)) return { boothId: dirId, source: 'dir', verified: true };
  const bindId = String(bindBoothId ?? '').trim();
  if (/^\d{5,9}$/.test(bindId)) return { boothId: bindId, source: 'bind', verified: true };
  const own = String(asset?.boothId ?? '').trim();
  const ownOk = /^\d{5,9}$/.test(own);
  const source = boothIdSourceOf(asset);
  // 素材自带号在台账里（且不是「名字前缀=下载 id」）→ 也算核准：台账里真有这个商品，就是买过的。
  if (ownOk && source !== 'download-id' && ids.has(own)) return { boothId: own, source, verified: true };
  // 目录里是合法号但台账没有：它不是 verified，但仍然是最像商品号的线索——交给人确认。
  if (dirId) return { boothId: dirId, source: 'dir', verified: false };
  if (!ownOk) return { boothId: '', source: 'guess', verified: false };
  return { boothId: own, source, verified: false };
}

/**
 * 给一件素材提绑定候选：台账里已有的号直接 1.0（source='id'），否则按标题相似度排。
 * @param {object} asset
 * @param {Array<object>} purchases 已购台账条目（normalizePurchaseItem 后的形状）
 * @param {{limit?:number, minScore?:number}} [options]
 * @returns {Array<{boothId:string,title:string,shop:string,coverUrl:string,score:number,source:'id'|'title'}>}
 */
export function suggestBindings(asset, purchases, options = {}) {
  const list = (Array.isArray(purchases) ? purchases : []).filter((item) => /^\d{5,9}$/.test(String(item?.boothId ?? '')));
  const limitRaw = Number(options.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(10, Math.floor(limitRaw)) : BIND_SUGGESTION_LIMIT;
  const minRaw = Number(options.minScore);
  const minScore = Number.isFinite(minRaw) && minRaw > 0 ? Math.min(1, minRaw) : BIND_MIN_SCORE;
  if (!list.length) return [];
  const byId = new Map(list.map((item) => [String(item.boothId), item]));
  // ① 目录号（转存结构 `<商品号>/<下载文件>.zip`）命中台账 → 最可信，直接 1.0/source='dir'。
  //    这条必须排在名字前缀之前：真机 16 件的目录号都在台账里，而名字前缀是下载文件 id。
  const dirId = dirBoothIdOf(asset);
  if (dirId) {
    const dirHit = byId.get(dirId);
    if (dirHit) return [suggestionOf(dirHit, 1, 'dir')];
  }
  // ② 素材身上（或候选里）已有的号在台账里：这是「猜到的号恰好是商品号」的情况，给 0.95，
  //    且若来源是 name-prefix 就标成 download-id（下载文件 id 不是商品号，只能当提示）。
  for (const id of candidateIdsOf(asset)) {
    if (id === dirId) continue;
    const hit = byId.get(id);
    if (!hit) continue;
    const fromPrefix = String(asset?.boothId ?? '') === id && boothIdSourceOf(asset) === 'download-id';
    // 名字前缀（下载文件 id）即使撞上商品号，也只给 0.95 且标 download-id：它本身不是商品号，
    // 是「恰好数字相同」；真正的高置信来源是目录号（1.0/source='dir'）。
    return fromPrefix
      ? [suggestionOf(hit, 0.95, 'download-id', 'download-id')]
      : [suggestionOf(hit, 1, 'id', 'item-id')];
  }
  // ③ 目录里是合法号但台账没有 → 作为候选交给人确认（candidate，不是 verified）。
  if (dirId) return [suggestionOf({ boothId: dirId }, 0.9, 'dir', 'item-id')];
  // ② 按标题相似度排；标题取「洗过的显示名 / 文件名 / 主件名」里最长的那个当基准。
  const bases = [asset?.displayTitle, asset?.title, asset?.mainName, asset?.file]
    .map((value) => cleanDisplayTitle(value))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const base = bases[0] || '';
  if (!base) return [];
  const scored = [];
  for (const item of list) {
    const score = titleScore(base, item?.title);
    if (score >= minScore) scored.push(suggestionOf(item, score, 'title'));
  }
  scored.sort((left, right) => right.score - left.score || left.boothId.localeCompare(right.boothId));
  const out = [];
  const seen = new Set();
  for (const item of scored) {
    if (seen.has(item.boothId)) continue;
    seen.add(item.boothId);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 一件素材的认号状态。
 * verified：当前号在已购台账或人工绑定表里（敢拿去抓封面/显示商品名）；
 * candidate：没 verified，但有 ≥1 条候选（显示「?」+ 候选标题，等用户确认）；
 * none：连候选都没有（显示洗过的文件名，等人工填号）。
 * @param {object} asset
 * @param {Set<string>} verifiedIds
 * @param {Array<object>} suggestions
 * @returns {'verified'|'candidate'|'none'}
 */
export function boothStatusOf(asset, verifiedIds, suggestions) {
  const ids = verifiedIds instanceof Set ? verifiedIds : new Set();
  // 目录号命中台账 = 真商品号（转存结构 `<商品号>/<下载文件>.zip`），优先于素材自带号。
  const dirId = dirBoothIdOf(asset);
  if (dirId && ids.has(dirId)) return 'verified';
  const id = String(asset?.boothId ?? '').trim();
  // 名字前缀来的号是「下载文件 id」，不参与核准（只有 dir/bind 才算）——真机 16 件绑错商品全出在这。
  const trustedId = asset?.boothIdKind === 'download-id' ? '' : id;
  if (/^\d{5,9}$/.test(trustedId) && ids.has(trustedId)) return 'verified';
  if (Array.isArray(suggestions) && suggestions.length) return 'candidate';
  return 'none';
}

/**
 * 显示标题：verified → 台账/绑定标题；candidate → `? ` + 最高分候选标题；none → 洗过的文件名。
 * @param {object} asset
 * @param {{status:string, verifiedTitle?:string, suggestion?:object|null}} options
 * @returns {string}
 */
export function displayTitleOf(asset, options = {}) {
  const status = String(options.status || 'none');
  if (status === 'verified') {
    const title = String(options.verifiedTitle ?? '').trim();
    if (title) return title.slice(0, 200);
  }
  if (status === 'candidate' && options.suggestion) {
    const title = String(options.suggestion.title ?? '').trim();
    if (title) return `? ${title}`.slice(0, 200);
  }
  const cleaned = cleanDisplayTitle(asset?.mainName || asset?.file || asset?.title || '');
  return (cleaned || String(asset?.title ?? '')).slice(0, 200);
}
