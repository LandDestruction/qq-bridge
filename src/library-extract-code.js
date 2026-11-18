// 解压码自动识别：从素材标题 / 目录名 / 文件名里抠出 `[解压码: xxxx]` 这类写法。
//
// 为什么单独一个纯函数模块：
// - 解析规则要被三处复用（解压前挑候选码、认号写入时顺手记、以后下载完自动解压），
//   规则抄三遍一定会漂；这里只吃字符串，不碰磁盘、不读 state、不写台账，测试可以直接喂 fixture。
// - 桥接的控制台模块是 vm 裸执行的（不能 import），所以本模块也**零 import**、并登记进
//   src/bridge/manifest.json：工厂 createLibraryExtractCode(deps) 返回这三个纯函数，
//   bridge.js 拿到后挂成 deps.libraryExtractCodePure（解压/认号两条链都经 deps 取用）。
//   为什么不是一个「namespace 对象直接 import」：审计沙箱会剥掉 bridge.js 的顶层 import，
//   未登记的裸命名空间在 VM 里就是 ReferenceError，整套静态门禁会红。
//
// 识别范围（BOOTH 卖家常见的 6 类写法）：
//   1. 方括号 + 关键词 + 冒号：`[解压码: abc]` `[解压码：abc]` `[密码：abc]`
//   2. 中文书名号/圆括号：`【解压码 abc】` `（code: abc）`
//   3. 关键词 + 分隔符（无括号）：`解压码: abc` `密码=abc` `code：abc`
//   4. 英文同义词：`password: abc` `pass: abc` `pwd: abc` `pw=abc`
//   5. 提取码/口令：`提取码: abc` `口令：abc`
//   6. 关键词 + 空格（无分隔符）：`解压码 abc`（只在关键词后紧跟 token 时认，避免吃掉整句）
//
// 明确不做：不解码、不猜测（`解压码见压缩包内` 这种记成空串）、不把纯中文长句当密码。

const EC_KEYWORDS = '解压密码|解压码|提取码|口令|密码|password|passwd|pass|pwd|pw|code';
// 出现在括号里的码：允许中文、符号，但不允许再出现括号/逗号（那是下一段内容）。
const EC_BRACKET_CODE = '[^\\]】）)\\[【（(,，;；]{1,40}';
// 无括号时只认「看得像密码」的 token：ASCII 可打印 + 少量中文（有些卖家密码就是中文词）。
const EC_TOKEN = '[A-Za-z0-9!@#$%^&*_\\-+=.~|]{1,32}|[\\u4e00-\\u9fa5]{2,16}';

const EC_NOISE = new Set([
  'none', 'null', 'nil', 'n/a', 'na', 'undefined', 'tbd', 'false', 'true',
  '无', '空', '没有', '无密码', '免密码', '未知', '不', '是', '的', '了', '在', '和', '与', '或',
  '-', '--', '—', '/', '无。', '无。'
]);
// 单个中文字不可能是密码（多半是「密码：无」被截出来的尾巴）。
const EC_CJK_STOP = new Set(['无', '空', '有', '的', '了', '是', '在', '和', '与', '或', '这', '那', '个', '见', '内', '里']);

function ecTrim(value) {
  return String(value == null ? '' : value).replace(/\u00a0/g, ' ').trim();
}

// 码本身再洗一遍：去掉成对的引号、末尾的句读/括号残渣，压缩中间空白。
function ecCleanCode(raw) {
  let text = ecTrim(raw);
  text = text.replace(/^["'“”‘’「」『』]+/, '').replace(/["'“”‘’「」『』]+$/, '');
  text = text.replace(/[。，,；;、!！?？~～]+$/, '');
  text = text.replace(/^[。，,；;、!！?？~～]+/, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function ecIsNoise(code) {
  if (!code) return true;
  const lower = code.toLowerCase();
  if (EC_NOISE.has(lower)) return true;
  // 纯标点 / 纯空白
  if (!/[0-9A-Za-z\u4e00-\u9fa5]/.test(code)) return true;
  // 单个中文字：几乎都是「密码：无」「密码是空」这种句子碎片
  if (code.length === 1 && EC_CJK_STOP.has(code)) return true;
  return false;
}

function ecPush(found, code, raw, source, confidence) {
  const clean = ecCleanCode(code);
  if (!clean || clean.length > 32 || ecIsNoise(clean)) return;
  const dup = found.find((item) => item.code.toLowerCase() === clean.toLowerCase());
  if (dup) {
    // 同一串码被两种规则命中时保留置信度高的那条（来源也换成更可信的）。
    if (confidence > dup.confidence) {
      dup.confidence = confidence;
      dup.source = source;
      dup.raw = raw;
    }
    return;
  }
  found.push({ code: clean, raw: ecTrim(raw) || clean, source, confidence });
}

/**
 * 从一段文本里解析解压码。
 * @param {string} text
 * @returns {{codes: Array<{code:string, raw:string, source:string, confidence:number}>, confidence:number}}
 *   confidence 是「整段里最高的那条」的置信度；一条都没认出来时是 0。
 */
// @bridge-function parseExtractCodes:start
function parseExtractCodes(text) {
  const source = ecTrim(text);
  if (!source) return { codes: [], confidence: 0 };
  const found = [];
  const rules = [
    // 1/2：括号里有关键词（最简单也最可信），左右括号种类不要求配对（卖家常写混）。
    {
      source: 'bracket',
      confidence: 0.95,
      regex: new RegExp(`[\\[【（(]\\s*(?:${EC_KEYWORDS})\\s*[:：=]?\\s*(${EC_BRACKET_CODE})\\s*[\\]】）)]`, 'gi')
    },
    // 3/4/5：关键词 + 分隔符，码只在分隔符后取一个 token，不吃后面的句子。
    {
      source: 'separator',
      confidence: 0.82,
      // 右边界必须是分隔符/结尾：否则 40 位超长码会被截成 32 位混进来（宁可漏、不可错）。
      regex: new RegExp(`(?:${EC_KEYWORDS})\\s*[:：=]\\s*(${EC_TOKEN})(?=$|[\\s\\[\\]【】（）()，,；;。、])`, 'gi')
    },
    // 6：关键词 + 空格（`解压码 abc`）。要求关键词前面是开头/括号/空白，避免「解压密码本」这种词被切开。
    {
      source: 'bare',
      confidence: 0.6,
      regex: new RegExp(`(?:^|[\\s\\[【（(])(?:${EC_KEYWORDS})\\s+(${EC_TOKEN})`, 'gi')
    }
  ];
  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    let hit = rule.regex.exec(source);
    while (hit) {
      ecPush(found, hit[1], hit[0], rule.source, rule.confidence);
      hit = rule.regex.exec(source);
    }
  }
  const confidence = found.reduce((best, item) => Math.max(best, item.confidence), 0);
  return { codes: found, confidence };
}
// @bridge-function parseExtractCodes:end

// 一件素材可能三处都有码（文件名 / 标题 / 目录名）：按「文件名 → 标题 → 目录名 → 其它文本」
// 的优先级取第一条最可信的，并把三处命中的码都按这个顺序并起来（同一串码只留一次）。
const EC_FIELD_ORDER = [
  ['fileName', '文件名'],
  ['mainName', '文件名'],
  ['title', '标题'],
  ['dir', '目录名'],
  ['text', '文本']
];

/**
 * 从素材的字符串字段里挑最合适的解压码。
 * @param {{fileName?:string, mainName?:string, title?:string, dir?:string, text?:string}} item
 * @returns {{code:string, raw:string, source:string, field:string, confidence:number}|null}
 */
// @bridge-function pickBestExtractCode:start
function pickBestExtractCode(item) {
  const all = collectExtractCodes(item);
  return all.length ? all[0] : null;
}
// @bridge-function pickBestExtractCode:end

/**
 * 按优先级把所有认出来的码并成一个列表（同一串码只留第一次出现的位置）。
 * 自动入密码本时用这个：同一件多码按优先级，第一个就是默认要用的。
 * @param {{fileName?:string, mainName?:string, title?:string, dir?:string, text?:string}} item
 * @returns {Array<{code:string, raw:string, source:string, field:string, confidence:number}>}
 */
// @bridge-function collectExtractCodes:start
function collectExtractCodes(item) {
  const input = item && typeof item === 'object' ? item : {};
  const out = [];
  const seen = new Set();
  for (const [key, label] of EC_FIELD_ORDER) {
    const raw = ecTrim(input[key]);
    if (!raw) continue;
    const parsed = parseExtractCodes(raw);
    // 同一字段里多条码：置信度高的排前面（同分按出现顺序）。
    const sorted = parsed.codes.slice().sort((a, b) => b.confidence - a.confidence);
    for (const hit of sorted) {
      const dedupe = hit.code.toLowerCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ code: hit.code, raw: hit.raw, source: hit.source, field: label, confidence: hit.confidence });
    }
  }
  return out;
}
// @bridge-function collectExtractCodes:end

// @bridge-function createLibraryExtractCode:start
// VM 模块工厂：不读 deps（纯函数，构造期什么都不碰），只为让 manifest 能登记成模块。
// 返回的三个函数就是 bridge.js 挂到 runtimeBindings.libraryExtractCodePure 的那份。
function createLibraryExtractCode(deps) {
  void deps;
  return { parseExtractCodes, pickBestExtractCode, collectExtractCodes };
}
// @bridge-function createLibraryExtractCode:end

export { parseExtractCodes, pickBestExtractCode, collectExtractCodes, createLibraryExtractCode, EC_KEYWORDS, EC_NOISE };
