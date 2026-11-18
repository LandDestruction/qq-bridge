// 已购库截图识别（VM-safe、零 import）：
// 本机没有 tesseract，走 Windows 自带的 WinRT OCR（scripts/lib/ocr-image.ps1）。
// 这个模块做三件事：① 调 PowerShell 拿逐行文本（带坐标）；② 从文本里抽 BOOTH 号/链接/商品名；
// ③ 吞吐截图路由（临时文件/大小校验/逐号解析）。台账读写仍由 library-purchases 传进来（helpers）。
export const OCR_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const OCR_TIMEOUT_MS = 20000;
export const OCR_TMP_DIRNAME = 'ocr-tmp';
// 截图请求体：8MB 图的 base64 约 11MB，读请求体要放宽到 12MB（其它接口仍是 1MB）。
export const OCR_REQUEST_MAX_BYTES = 12 * 1024 * 1024;
const OCR_MIMES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp' };
const OCR_IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;
const OCR_MAX_RESOLVE_IDS = 20;
const OCR_LINES_PREVIEW = 40;
// 只读预览的补资料阶段：商品页最多同时抓 4 个、单号 6s、整段 7s 封顶；
// 抓不到就保留 OCR 标题并标 enriched:false（以前逐号串行 + 下封面，真机实测 28s）。
const OCR_ENRICH_CONCURRENCY = 4;
const OCR_ENRICH_TIMEOUT_MS = 6000;
const OCR_ENRICH_BUDGET_MS = 7000;
// OCR 会把 6 认成 5（实测 7547699→7547599、9006622→9006522）：页面标题对不上时按 5/6 互替试近邻号。
const OCR_ID_CORRECT_ATTEMPTS = 6;
const OCR_ID_CORRECT_TIMEOUT_MS = 3000;
const OCR_ID_CORRECT_BUDGET_MS = 6000;

// 1x1 透明 PNG：启动探活用的最小图（不落素材库、用完就删）。
const OCR_PROBE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// 这些词一出现就说明这行是控制台 UI/统计文案，不是商品名。
// 注意 OCR 会在中文字之间插空格（「复 制 商 品 页」），所以按「去掉空格后的紧排文本」来匹配。
const OCR_UI_WORDS = [
  '已购', '同步', '解析', '导入', '粘贴', '复制', '商品页', '商品名', '商品号', '商品',
  '更新', '移除', '库里', '登记', '对账', '上次', '限速', '封面', '标题', '搜索',
  '未登记', '缺少', '去补', '按标', '共', '件', '无料', '無料', 'sale', '补下', '补',
  '800th', 'booth'
];
// UI 行的首选字符（OCR 把「解析/同步/已购…」读成单字散排时，靠首字兜底）。
const OCR_UI_STARTS = ['解', '贴', '同', '已', '共', '在', '补', '搜', '按', '登', '未', '上', '粘', '复', '商', '更', '移', '库', '对', '限', '封', '标', '无', '無'];

// OCR 会把数字读成全角（９００６５２２）或把 0/1 读成 O/l：抽号前先归一到半角数字。
function ocrNarrowDigits(value) {
  let out = '';
  for (const ch of String(value == null ? '' : value)) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xFF10 && cp <= 0xFF19) out += String.fromCharCode(cp - 0xFF10 + 48);
    else out += ch;
  }
  return out;
}

// 「# 9O06522」这类：只有紧跟在 # 后面才敢把 O/o→0、I/l→1，避免把正文里的字母改坏。
function ocrFixIdToken(token) {
  const fixed = String(token || '').replace(/[Oo]/g, '0').replace(/[Il]/g, '1');
  return /^\d{5,9}$/.test(fixed) ? fixed : '';
}

const OCR_ID_IN_HASH = /#\s*(\d{5,9})(?!\d)/g;
const OCR_ID_IN_HASH_LOOSE = /#\s*([0-9OoIl]{5,9})(?!\d)/g;
const OCR_ID_IN_ITEM_URL = /\/items\/(\d{5,9})(?!\d)/i;
const OCR_URL = /https?:\/\/(?:[A-Za-z0-9-]+\.)*booth\.pm\/[^\s"'<>）)]*/i;
const OCR_PRICE = /([¥￥]\s*\d[\d,]*|\d[\d,]*\s*(?:円|元|JPY|USD))/i;

function ocrNormalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// OCR 会把卡片上的装饰字符读进标题（•♥ / 𝟑 这类）：它们不是商品名的一部分，先清掉。
// 用码点过滤而不是正则字符类，省得源码里再嵌一层转义。
function ocrStripDecor(value) {
  let out = '';
  for (const ch of String(value == null ? '' : value)) {
    const cp = ch.codePointAt(0);
    const decor = (cp >= 0x2190 && cp <= 0x2BFF) // 箭头/数学符号/装饰
      || (cp >= 0x2600 && cp <= 0x27BF) // 星星/表情/勾叉
      || (cp >= 0x1D400 && cp <= 0x1D7FF) // 数学粗体字母数字（𝟑）
      || cp === 0x200D || cp === 0x20E3 || cp === 0xFE0F || cp === 0xFE0E;
    out += decor ? ' ' : ch;
  }
  return out;
}

function ocrCleanTitle(value) {
  let t = ocrNormalizeText(ocrStripDecor(value));
  t = t.replace(/^[\s，,。、;；:：·•\-–—_【[（(「『"“'‘]+/, '');
  t = t.replace(/[\s，,。、;；:：·•\-–—_】\]）)」』"”'’]+$/, '');
  // 尾巴上一小截没闭合的括号（OCR 常把卡片右侧误读进来）：去掉。
  t = t.replace(/\s*[（(【[「『]\s*[^）)】\]」』]{0,8}$/, '');
  // 标题前面常混进卡片装饰/相邻列的散字（「网 引 f Twin 80b」）：有整串英文时，从英文串开头截断。
  const word = t.match(/[A-Za-z]{3,}/);
  if (word) {
    const idx = t.indexOf(word[0]);
    const prefix = t.slice(0, idx);
    if (prefix && /[\u3400-\u9fff]/.test(prefix) && !/[A-Za-z]{2,}/.test(prefix)) t = t.slice(idx);
  }
  // 上面去尾标点时可能把右括号删了、留下半个左括号：括号不成对就把最后那个左括号也去掉。
  for (const pair of [['(', ')'], ['（', '）'], ['[', ']'], ['【', '】'], ['「', '」']]) {
    const opens = t.split(pair[0]).length - 1;
    const closes = t.split(pair[1]).length - 1;
    if (opens > closes) {
      const idx = t.lastIndexOf(pair[0]);
      t = t.slice(0, idx) + t.slice(idx + 1);
    }
  }
  return t.replace(/\s+/g, ' ').trim();
}

function ocrIsTitleCandidate(text) {
  const t = text.trim();
  if (!t) return false;
  if (t.length < 3 || t.length > 80) return false;
  const tight = t.replace(/\s+/g, '').toLowerCase();
  if (OCR_UI_WORDS.some((word) => tight.includes(word))) return false;
  if (OCR_UI_STARTS.includes(tight[0])) return false;
  if (/[@{}|\\^~〔〕]/.test(t)) return false;
  if (/^\d/.test(t)) return false;
  // 纯价格/纯数字/时间行不是标题
  if (/^[¥￥$]\s*\d/.test(t)) return false;
  if (/^\s*[\d\s.,:：/—-]+$/.test(t)) return false;
  const letters = (t.match(/[A-Za-z\u3400-\u9fff]/g) || []).length;
  if (letters < 3) return false;
  // 「10-30 02:43」「10/31」这类时间行（没有成串英文）也过掉
  if (/\d{1,2}\s*[-/／月]\s*\d{1,2}/.test(t) && !/[A-Za-z]{3,}/.test(t)) return false;
  return true;
}

function ocrPriceOf(text) {
  const m = OCR_PRICE.exec(String(text || ''));
  return m ? ocrNormalizeText(m[1]) : '';
}

// 输入：OCR 的 lines（[{text,x,y}] 或纯字符串数组）。
// 输出：{ items:[{boothId?,title?,priceText?}], ids, urls, titles }。
// 配号规则：每行识别出的号往前找最近的「标题行」（160px 内、中间没隔着别的号）。
// @bridge-function extractPurchaseHints:start
export function extractPurchaseHints(lines) {
  const rows = [];
  const input = Array.isArray(lines) ? lines : [];
  for (let i = 0; i < input.length; i += 1) {
    const src = input[i];
    const text = ocrNormalizeText(typeof src === 'string' ? src : src && src.text);
    if (!text) continue;
    const yRaw = Number(src && typeof src === 'object' ? src.y : NaN);
    const xRaw = Number(src && typeof src === 'object' ? src.x : NaN);
    rows.push({
      text,
      x: Number.isFinite(xRaw) ? xRaw : NaN,
      y: Number.isFinite(yRaw) ? yRaw : i * 100,
      order: i,
      ids: [],
      titleOk: false,
      title: ''
    });
  }
  rows.sort((a, b) => a.y - b.y || (a.x || 0) - (b.x || 0) || a.order - b.order);

  const ids = [];
  const urls = [];
  const titles = [];
  for (const row of rows) {
    const urlMatch = row.text.match(OCR_URL);
    if (urlMatch) {
      const url = urlMatch[0].replace(/[.,，。;；]+$/, '');
      if (url && !urls.includes(url)) urls.push(url);
    }
    const found = [];
    const idText = ocrNarrowDigits(row.text);
    let m;
    OCR_ID_IN_HASH.lastIndex = 0;
    while ((m = OCR_ID_IN_HASH.exec(idText))) found.push(m[1]);
    // 放宽一档：全角数字已归一；# 后紧跟的 token 允许 O/o/I/l 被 OCR 认错成数字。
    OCR_ID_IN_HASH_LOOSE.lastIndex = 0;
    while ((m = OCR_ID_IN_HASH_LOOSE.exec(idText))) {
      const fixed = ocrFixIdToken(m[1]);
      if (fixed) found.push(fixed);
    }
    const itemUrl = OCR_ID_IN_ITEM_URL.exec(idText);
    if (itemUrl) found.push(itemUrl[1]);
    if (!found.length && /^\d{5,9}$/.test(idText.replace(/\s+/g, ''))) found.push(idText.replace(/\s+/g, ''));
    for (const id of found) if (!ids.includes(id)) ids.push(id);
    row.ids = [...new Set(found)];
    if (!row.ids.length) {
      // 候选先按 OCR 原文判、再按清洗后的判：卡片标题常带 •/〔〕/引号等装饰，
      // 原文过不了「装饰字符」那条规则，清洗后才是真标题（ShatteredVow、3Avatars）。
      const rawOk = ocrIsTitleCandidate(row.text);
      const title = ocrCleanTitle(row.text);
      if (title && (rawOk || ocrIsTitleCandidate(title)) && ocrIsTitleCandidate(title)) {
        row.titleOk = true;
        row.title = title;
        if (!titles.includes(title)) titles.push(title);
      }
    }
  }

  const items = [];
  const usedTitles = new Set();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row.ids.length) continue;
    // 卡片是「标题在上、号在下」：按坐标配（x 差小的优先），没有坐标就退回「最近的上方标题行」。
    let bestIdx = -1;
    let bestScore = Infinity;
    for (let j = i - 1; j >= 0; j -= 1) {
      const prev = rows[j];
      if (prev.ids.length) continue; // 同一横排相邻卡片的号行会插在中间，跳过但不中断
      const gap = row.y - prev.y;
      if (gap > 120) break;
      if (!prev.titleOk || usedTitles.has(j)) continue;
      const xDiff = Number.isFinite(row.x) && Number.isFinite(prev.x) ? Math.abs(row.x - prev.x) : 0;
      if (xDiff > 150) continue;
      const score = gap + xDiff * 0.5;
      if (score < bestScore) { bestScore = score; bestIdx = j; }
    }
    if (bestIdx >= 0) usedTitles.add(bestIdx);
    const titleRow = bestIdx >= 0 ? rows[bestIdx] : null;
    // 有的卡片把标题挤在同一行（「# 9006807 Mybunniet」）：只在这张卡找不到独立标题行时兜底。
    let inlineTitle = '';
    if (!titleRow) {
      const stripped = row.text.replace(/#?\s*\d{5,9}/g, ' ').replace(/^[^A-Za-z㐀-鿿]{0,6}/, '');
      const candidate = ocrCleanTitle(stripped);
      if (candidate && ocrIsTitleCandidate(candidate)) inlineTitle = candidate;
    }
    const priceText = ocrPriceOf(row.text) || (titleRow ? ocrPriceOf(titleRow.text) : '');
    // 同一张卡的号有时被 OCR 读成两行（全角/字母混淆各一遍），按号只留一条。
    const boothId = row.ids[0];
    const seen = items.find((one) => one.boothId === boothId);
    const item = seen || { boothId };
    if (!item.title) {
      if (titleRow) item.title = titleRow.title;
      else if (inlineTitle) item.title = inlineTitle;
    }
    if (!item.priceText && priceText) item.priceText = priceText;
    if (!seen) items.push(item);
  }

  return { items, ids, urls, titles };
}
// @bridge-function extractPurchaseHints:end

function ocrParseOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  // PowerShell 偶尔会先打一行 warning；从第一个 '{' 开始找 JSON。
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function ocrErrorText(reason, detail) {
  const r = String(reason || '');
  if (r === 'no_ocr') return '这台机器没有可用的 OCR 语言包';
  if (r === 'spawn') return '没能启动 OCR（PowerShell 不可用或被系统拦了）';
  if (r === 'timeout') return 'OCR 超时了（20 秒没出结果），图太大就裁一下再试';
  if (r === 'bad_output') return 'OCR 输出看不懂（PowerShell 返回了异常内容）';
  if (r === 'no_deps') return '截图识别没接上（运行环境没注入 runPowerShell / Buffer）';
  if (r === 'ocr_failed') return 'OCR 识别失败，换张更清楚的截图试试';
  return `截图识别失败：${detail || r || '未知原因'}`;
}

// 探活失败要区分「没注入依赖」（接线 bug）和「系统没语言包」：前者绝不能伪装成后者，
// 否则真机上看着像系统缺语言包，排查方向直接跑偏。
function ocrStatusErrorText(got) {
  const reason = String(got?.reason || '');
  const detail = ocrNormalizeText(got?.error || '');
  if (reason === 'no_deps' || /没有注入|runPowerShell|Buffer/.test(detail)) {
    return 'OCR 没接上：运行环境没有注入 runPowerShell / Buffer（不是语言包问题）';
  }
  return '这台机器没有可用的 OCR 语言包' + (detail || reason ? `（诊断：${detail || reason}）` : '');
}

// 单号补资料最多等 6 秒：商品页慢/被限速时不拖住整个截图导入。
// 生成 5/6 互替的近邻号（只改一位，最多 OCR_ID_CORRECT_ATTEMPTS 个）。
function ocrVariantIds(boothId) {
  const digits = String(boothId || '');
  if (!/^\d{5,9}$/.test(digits)) return [];
  const out = [];
  for (let i = 0; i < digits.length; i += 1) {
    const ch = digits[i];
    if (ch !== '5' && ch !== '6') continue;
    out.push(digits.slice(0, i) + (ch === '5' ? '6' : '5') + digits.slice(i + 1));
  }
  return out.slice(0, OCR_ID_CORRECT_ATTEMPTS);
}

// 标题比对用：去掉装饰/空格/大小写差异，只留字母数字和日文假名/汉字。
function ocrTitleKey(value) {
  const narrowed = ocrNormalizeText(ocrStripDecor(value))
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  return narrowed.toLowerCase()
    .replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e').replace(/5/g, 's').replace(/8/g, 'b')
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, '');
}

// 标题本身要像标题才拿去比对/报警：只有 2~3 个字母或零散汉字的「VRSuya」「F 黾 n 巴」是 OCR 噪声，
// 拿它去改号会误伤，所以可信度不够时宁可不判断（保持页面结果、不标 uncertain）。
function ocrTitleTrustworthy(value) {
  const key = ocrTitleKey(value);
  if (key.length < 4) return false;
  const latin = (key.match(/[a-z]/g) || []).length;
  return latin >= 4 || /[\u3040-\u30ff\u4e00-\u9fff]{2,}/.test(key);
}

// 最长公共子串长度（动态规划；标题只有几十个字，开销可忽略）。
function ocrLongestCommon(a, b) {
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

// 归一化后「包含」或「最长公共子串 ≥ 短标题 60%」才算同一个商品：
// 日文标题前几个字常是符号/系列名，只比前 6 字会把别的商品也放进来（verifier 抓到过一次错纠正）。
function ocrTitlesLookSame(a, b) {
  const x = ocrTitleKey(a);
  const y = ocrTitleKey(b);
  if (x.length < 4 || y.length < 4) return false;
  if (x.includes(y) || y.includes(x)) return true;
  return ocrLongestCommon(x, y) >= Math.ceil(Math.min(x.length, y.length) * 0.6);
}

function ocrRaceTimeout(promise, ms, timeoutText) {
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timeout: true, error: timeoutText }), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([
    Promise.resolve(promise).catch((error) => ({ ok: false, error: error?.message ?? String(error) })),
    guard
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

// 只读预览的补资料：最多 4 并发、单号 6s、整段 7s；暂停了立刻停手。
// 返回按 boothId 的解析结果（没抓到就没有该 key，调用方保留 OCR 标题并标 enriched:false）。
// 注意：这里只读——不写台账、不落封面（导入仍由 /purchases/import 负责）。
async function ocrEnrichByIds(api, ids, options = {}) {
  const results = new Map();
  const errors = [];
  const concurrency = Math.max(1, Number(options.concurrency) || OCR_ENRICH_CONCURRENCY);
  const perTimeout = Math.max(1, Number(options.timeoutMs) || OCR_ENRICH_TIMEOUT_MS);
  const deadline = Date.now() + Math.max(1, Number(options.budgetMs) || OCR_ENRICH_BUDGET_MS);
  let pausedText = '';
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const boothId = ids[next];
      next += 1;
      if (pausedText) return;
      const pause = typeof api.pausedNow === 'function' ? api.pausedNow() : { paused: false };
      if (pause.paused) { pausedText = pause.text || 'BOOTH 正在限速暂停，稍后再试'; return; }
      const left = deadline - Date.now();
      if (left <= 0) { errors.push({ boothId, error: `商品页补资料超过 ${Math.round(OCR_ENRICH_BUDGET_MS / 1000)} 秒预算，先保留截图里的标题` }); continue; }
      const one = await ocrRaceTimeout(api.fetchItem(boothId), Math.min(perTimeout, left), '商品页 6 秒没响应，先保留截图里的标题');
      if (one && one.ok) results.set(boothId, one);
      else if (one && one.paused) { pausedText = one.error || 'BOOTH 正在限速暂停，稍后再试'; return; }
      else errors.push({ boothId, error: one?.error || '商品页补资料失败' });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));
  return { results, errors, pausedText };
}

// 抓不到商品页、或页面标题跟截图对不上（OCR 常把 6 认成 5）时，按 5/6 互替试近邻号纠正。
// 并发纠正（各号互不等待），整体 5 秒预算、单候选 1.5 秒；纠正失败保留 OCR 结果，绝不写台账。
async function ocrCorrectIdGuesses(api, byId, hints, { pausedText = '' } = {}) {
  if (typeof api.fetchItem !== 'function' || pausedText) return;
  const deadline = Date.now() + OCR_ID_CORRECT_BUDGET_MS;
  const tasks = [];
  for (const hint of hints.items) {
    const base = byId.get(hint.boothId);
    if (!base) continue;
    // 截图里根本没配到标题（只有链接）或标题本身是噪声：没有可靠基准，不动号也不标 uncertain。
    if (base.enriched && (!base.ocrTitle || !ocrTitleTrustworthy(base.ocrTitle))) continue;
    // 页面标题和截图标题对得上 → 号本来就对，不用纠正。
    if (base.enriched && ocrTitlesLookSame(base.title, base.ocrTitle)) continue;
    tasks.push((async () => {
      let fixed = null;
      // 近邻号真的存在（说明可能是 5/6 认错），或校验时网络/超时导致没结论 → 都算「不确定」。
      let sawRealCandidate = false;
      let sawUnknownError = false;
      for (const candidate of ocrVariantIds(hint.boothId)) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        const got = await ocrRaceTimeout(api.fetchItem(candidate), Math.min(OCR_ID_CORRECT_TIMEOUT_MS, left), '近邻号校验超时');
        if (!got || !got.ok) {
          if (!/404|商品不存在/.test(String(got && got.error))) sawUnknownError = true;
          continue;
        }
        sawRealCandidate = true;
        const parsed = got.item || {};
        if (!ocrTitlesLookSame(parsed.title, base.ocrTitle || base.title)) continue;
        const remote = got.coverUrl || parsed.coverUrl || '';
        const cover = typeof api.coverInfo === 'function'
          ? api.coverInfo(candidate, remote)
          : { coverUrl: remote, coverRemote: Boolean(remote) };
        fixed = {
          ...base,
          boothId: candidate,
          title: parsed.title || base.title,
          shopName: parsed.shopName || '',
          priceText: parsed.priceText || base.priceText,
          itemUrl: parsed.itemUrl || '',
          coverUrl: cover.coverUrl || '',
          coverRemote: Boolean(cover.coverRemote),
          enriched: true,
          correctedFrom: hint.boothId
        };
        break;
      }
      if (!fixed) {
        // 没纠正成：只有「近邻号真是商品」或「校验出错没结论」才标 uncertain（前端二次确认）。
        // 近邻号全 404 说明号本身没歧义，多半只是 OCR 标题配对不准，不该打扰用户。
        if (base.enriched && (sawRealCandidate || sawUnknownError)) base.uncertain = true;
        return;
      }
      // 纠正成功：号变了，按新号重挂（旧号不再出现在预览里）。
      byId.delete(hint.boothId);
      hint.boothId = fixed.boothId;
      byId.set(fixed.boothId, fixed);
    })());
  }
  await Promise.all(tasks);
}

export function createLibraryOcr(deps) {
  // 构造期不许读 deps（VM 边界测试会用「一访问就抛」的 getter 造工厂），全部推迟到调用时。
  let queue = Promise.resolve();
  let statusCache = null;

  const ocrDeps = () => ({
    fs: deps.fs,
    path: deps.path,
    root: deps.ROOT,
    stateDir: deps.STATE_DIR,
    log: deps.log,
    runPowerShell: deps.runPowerShell,
    Buffer: deps.Buffer,
    safeResolveInside: deps.safeResolveInside
  });

  function ocrTmpDir() {
    const d = ocrDeps();
    return d.path.join(d.stateDir, OCR_TMP_DIRNAME);
  }

  function ocrScriptPath() {
    const d = ocrDeps();
    return d.path.join(d.root, 'scripts', 'lib', 'ocr-image.ps1');
  }

  function ocrInvoke(filePath) {
    const d = ocrDeps();
    if (typeof d.runPowerShell !== 'function') {
      return Promise.resolve({ ok: false, error: 'OCR 进程不可用（没有注入 runPowerShell）', reason: 'no_deps' });
    }
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ocrScriptPath(), '-Path', filePath];
    return Promise.resolve(d.runPowerShell('powershell.exe', args, OCR_TIMEOUT_MS)).then((res) => {
      if (!res || res.ok === false) {
        const detail = ocrNormalizeText(res && (res.error || res.stderr));
        return { ok: false, error: `OCR 进程失败：${detail || '未知错误'}`, reason: 'spawn' };
      }
      const parsed = ocrParseOutput(res.stdout);
      if (!parsed) return { ok: false, error: 'OCR 输出不是合法 JSON（脚本被拦或编码坏了）', reason: 'bad_output' };
      if (!parsed.ok) {
        const message = ocrNormalizeText(parsed.error) || 'OCR 失败';
        return { ok: false, error: message, reason: /语言包/.test(message) ? 'no_ocr' : 'ocr_failed' };
      }
      return {
        ok: true,
        engine: ocrNormalizeText(parsed.engine),
        langs: Array.isArray(parsed.langs) ? parsed.langs.map((x) => String(x)) : [],
        lines: Array.isArray(parsed.lines) ? parsed.lines : []
      };
    }).catch((error) => ({ ok: false, error: `OCR 调用失败：${error?.message ?? error}`, reason: 'spawn' }));
  }

  // 并发只跑 1 个 OCR：PowerShell + WinRT 启动很重，排成一队比抢线程稳。
  function ocrEnqueue(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

// @bridge-function ocrImageFile:start
  function ocrImageFile(filePath) {
    const abs = String(filePath || '').trim();
    if (!abs) return Promise.resolve({ ok: false, error: '缺图片路径', reason: 'bad_input' });
    return ocrEnqueue(() => ocrInvoke(abs));
  }
// @bridge-function ocrImageFile:end

// @bridge-function ocrStatus:start
  function ocrStatus() {
    if (statusCache) return Promise.resolve(statusCache);
    return ocrEnqueue(async () => {
      if (statusCache) return statusCache;
      const d = ocrDeps();
      const dir = ocrTmpDir();
      const probe = d.path.join(dir, 'probe.png');
      try {
        d.fs.mkdirSync(dir, { recursive: true });
        const probeBuf = (d.Buffer || (typeof Buffer !== 'undefined' ? Buffer : null));
        if (!probeBuf) throw new Error('运行环境没有 Buffer，解不出探活小图');
        d.fs.writeFileSync(probe, probeBuf.from(OCR_PROBE_PNG_BASE64, 'base64'));
        const got = await ocrInvoke(probe);
        statusCache = got.ok
          ? { ok: true, available: true, langs: got.langs, engine: got.engine, checkedAt: Date.now() }
          : { ok: true, available: false, langs: [], engine: '', error: got.error, reason: got.reason, checkedAt: Date.now() };
        // 探活失败要留痕：这条日志是排「语言包缺失 / 脚本没跑起来」的第一现场。
        try {
          d.log && d.log(statusCache.available
            ? `[OCR] 探活 可用 engine=${statusCache.engine}`
            : `[OCR] 探活 不可用：${String(statusCache.reason || 'unknown')} ${String(statusCache.error || '')}`);
        } catch { /* 日志失败不影响结果 */ }
      } catch (error) {
        const text = String(error?.message ?? error);
        const reason = /Buffer|没有注入|runPowerShell/.test(text) ? 'no_deps' : 'unknown';
        statusCache = { ok: true, available: false, langs: [], engine: '', error: `OCR 探活失败：${text}`, reason, checkedAt: Date.now() };
      } finally {
        try { d.fs.rmSync(probe, { force: true }); } catch { /* 清不掉不影响结果 */ }
      }
      return statusCache;
    });
  }
// @bridge-function ocrStatus:end

  // 只认 png/jpg/webp 的魔数：base64 能解码不代表是图片，别再喂给 OCR 换回 200 ok:false（前端按状态码分支）。
  function ocrImageExtOf(buf) {
    if (!buf || buf.length < 12) return '';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    const head = typeof buf.slice === 'function' ? buf.slice(0, 12).toString('latin1') : '';
    if (head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WEBP') return 'webp';
    return '';
  }

  // 把请求里的 image(dataURL)/path(工作区相对路径) 落成一张可读的临时图，返回 {ok,file,cleanup}。
  function ocrPurchaseMaterialize(body) {
    const d = ocrDeps();
    const textOf = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
    const dataUrl = textOf(body && body.image, 30_000_000);
    const rawPath = textOf(body && body.path, 500);
    if (!dataUrl && !rawPath) return { ok: false, status: 400, error: '给 image（data:image/png;base64,…）或 path（工作区内的图片路径）' };
    if (dataUrl) {
      const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(dataUrl);
      if (!m) return { ok: false, status: 400, error: '截图格式不对（要 data:image/png;base64, 开头）' };
      const ext = OCR_MIMES[String(m[1]).toLowerCase()];
      if (!ext) return { ok: false, status: 400, error: '只支持 png / jpg / webp 截图' };
      const BUF = d.Buffer || (typeof Buffer !== 'undefined' ? Buffer : null);
      let buf = null;
      try { buf = BUF.from(m[2].replace(/\s+/g, ''), 'base64'); } catch { buf = null; }
      if (!buf || !buf.length) return { ok: false, status: 400, error: '截图是空的（base64 解不出内容）' };
      if (buf.length > OCR_MAX_IMAGE_BYTES) return { ok: false, status: 413, error: '图太大了，裁一下再传' };
      const realExt = ocrImageExtOf(buf);
      if (!realExt) return { ok: false, status: 400, error: '截图格式不对（base64 解出来不是 png / jpg / webp 图片）' };
      const dir = d.path.join(d.stateDir, OCR_TMP_DIRNAME);
      try { d.fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在或建不了，下面写文件会报 */ }
      const file = d.path.join(dir, `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${realExt}`);
      try { d.fs.writeFileSync(file, buf); } catch (error) {
        return { ok: false, status: 500, error: `截图临时文件写不进去：${error?.message ?? error}` };
      }
      return { ok: true, file, cleanup: () => { try { d.fs.rmSync(file, { force: true }); } catch { /* 删不掉不影响结果 */ } } };
    }
    if (!OCR_IMAGE_EXT_RE.test(rawPath)) return { ok: false, status: 400, error: '只支持 png / jpg / webp 图片' };
    let abs = '';
    try {
      abs = d.safeResolveInside(d.root, rawPath);
    } catch {
      return { ok: false, status: 400, error: '图片路径越出了工作区，拒绝读取' };
    }
    if (!d.fs.existsSync(abs)) return { ok: false, status: 400, error: `找不到这张图：${rawPath}` };
    return { ok: true, file: abs, cleanup: () => {} };
  }

// @bridge-function handlePurchasesOcrStatus:start
  async function handlePurchasesOcrStatus(request) {
    let status = { ok: true, available: false, langs: [], engine: '', checkedAt: 0 };
    try {
      const got = await ocrStatus();
      status = {
        ok: true,
        available: Boolean(got && got.available),
        langs: Array.isArray(got && got.langs) ? got.langs : [],
        engine: ocrNormalizeText(got && got.engine).slice(0, 40),
        checkedAt: Number(got && got.checkedAt) || 0
      };
      if (!status.available) status.error = ocrStatusErrorText(got);
    } catch (error) {
      status.error = ocrErrorText('spawn', error?.message);
    }
    request.sendJson(status);
    return true;
  }
// @bridge-function handlePurchasesOcrStatus:end

  // api = { fetchItem, coverInfo, pausedNow }：抓商品页/封面地址由 library-purchases 提供（本文件零 import）。
  // 注意：这里只读——不写台账、不落封面（导入仍由 /purchases/import 负责）。
// @bridge-function handlePurchasesOcr:start
  async function handlePurchasesOcr(request, api) {
    let body = null;
    try {
      body = await request.readBody({ maxBytes: OCR_REQUEST_MAX_BYTES });
    } catch (error) {
      const code = Number(error?.statusCode) === 413 ? 413 : 400;
      request.sendJson({ ok: false, error: error?.message ?? '请求体读不出来' }, code);
      return true;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    const made = ocrPurchaseMaterialize(body);
    if (!made.ok) { request.sendJson({ ok: false, error: made.error }, made.status); return true; }
    let got = null;
    try {
      got = await ocrImageFile(made.file);
    } catch (error) {
      got = { ok: false, reason: 'spawn', error: error?.message ?? String(error) };
    } finally {
      made.cleanup();
    }
    if (!got || !got.ok) {
      const reason = got?.reason || 'ocr_failed';
      request.sendJson({
        ok: false,
        reason,
        error: ocrErrorText(reason, got?.error),
        langs: Array.isArray(got?.langs) ? got.langs : [],
        engine: ocrNormalizeText(got?.engine).slice(0, 40)
      }, 200);
      return true;
    }
    const lines = Array.isArray(got.lines) ? got.lines : [];
    const hints = extractPurchaseHints(lines);
    // 只读预览：先按 OCR 结果铺满 items（boothId + OCR 标题），再并发抓商品页补字段；
    // 抓不到就保留 OCR 标题并标 enriched:false。绝不写台账/落封面——导入走 /purchases/import。
    const byId = new Map();
    for (const hint of hints.items) {
      byId.set(hint.boothId, {
        boothId: hint.boothId,
        title: hint.title || '',
        shopName: '',
        priceText: hint.priceText || '',
        itemUrl: '',
        coverUrl: '',
        coverRemote: false,
        ocrTitle: hint.title || '',
        enriched: false
      });
    }
    let errors = [];
    let pausedText = '';
    if (hints.ids.length) {
      const enriched = await ocrEnrichByIds(api, hints.ids.slice(0, OCR_MAX_RESOLVE_IDS));
      errors = enriched.errors;
      pausedText = enriched.pausedText;
      for (const [boothId, one] of enriched.results) {
        const parsed = one.item || {};
        const base = byId.get(boothId) || { boothId, title: '', shopName: '', priceText: '', itemUrl: '', coverUrl: '', coverRemote: false, ocrTitle: '', enriched: false };
        const cover = typeof api.coverInfo === 'function'
          ? api.coverInfo(boothId, one.coverUrl || parsed.coverUrl || '')
          : { coverUrl: one.coverUrl || parsed.coverUrl || '', coverRemote: Boolean(one.coverUrl || parsed.coverUrl) };
        byId.set(boothId, {
          ...base,
          title: parsed.title || base.title,
          shopName: parsed.shopName || '',
          priceText: parsed.priceText || base.priceText,
          itemUrl: parsed.itemUrl || '',
          coverUrl: cover.coverUrl || '',
          coverRemote: Boolean(cover.coverRemote),
          enriched: true
        });
      }
    }
    // 抓不到商品页 / 页面标题对不上时按 5/6 互替试近邻号，纠正 OCR 认错的数字。
    await ocrCorrectIdGuesses(api, byId, hints, { pausedText });

    const items = [];
    const itemIds = new Set();
    for (const hint of hints.items) {
      const one = byId.get(hint.boothId);
      if (!one || itemIds.has(one.boothId)) continue;
      itemIds.add(one.boothId);
      items.push(one);
    }
    const payload = {
      ok: true,
      langs: Array.isArray(got.langs) ? got.langs : [],
      engine: ocrNormalizeText(got.engine).slice(0, 40),
      lines: lines.slice(0, OCR_LINES_PREVIEW).map((line) => ocrNormalizeText(line && line.text).slice(0, 200)).filter(Boolean),
      hints: { ids: hints.ids, urls: hints.urls, titles: hints.titles },
      items,
      errors
    };
    if (pausedText) { payload.paused = true; payload.error = pausedText; }
    if (!hints.ids.length && hints.titles.length) payload.message = '没认出 BOOTH 号，先把标题填进解析框试试';
    request.sendJson(payload);
    return true;
  }
// @bridge-function handlePurchasesOcr:end

  return { ocrImageFile, ocrStatus, extractPurchaseHints, handlePurchasesOcr, handlePurchasesOcrStatus };
}
