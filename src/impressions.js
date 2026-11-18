// 群友印象归纳：纯函数层（切片 → 提示词 → 校验 → 合并 → 预算），外加一个编排函数 buildImpressions。
//
// 为什么单独成模块：切分片、校验模型产物、合并上一轮印象全是纯逻辑，必须能离线测；
// 真正的模型调用只在 buildImpressions 的 caller 注入点出现一次——CLI 用 DSH 客户端实现它，
// 将来接 48 小时轮询也复用同一套判定，不用把「什么算一条好印象」抄第二遍。
//
// 只读约定：本模块不 import fs / node:sqlite / 网络客户端。写盘由调用方注入的 write 完成，
// 这样「归纳」不可能顺手改到 people.json / social-v2.json / member-notes.json。

import { truncateText } from './md-to-plain.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

// 群聊按北京时间自然日切：机器人自己和群友都活在 UTC+8，用伦敦日切会把「昨晚聊的」和「今天聊的」
// 分进两天，同一个人一天内的印象就被撕成两条互不相关的碎片。
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

const QQ_RE = /^\d{5,15}$/;
const SCOPE_KEY_RE = /^(group|private):\d{5,20}$/;

const NAME_MAX = 40;
const IMPRESSION_HARD_MAX = 200;
const TAG_MAX = 20;
const TAGS_HARD_MAX = 8;
const EVIDENCE_HARD_MAX = 20;
// 落盘时每人保留几条可展开的证据锚点（界面上「点开对照原话」用），其余只计数。
const EVIDENCE_KEEP = 6;
const EVIDENCE_PROMPT_MAX = 5;
// 情景记忆（P2）：一个人最多保留多少条、单条正文上限、提示词里最多要几条
const MEMORIES_KEEP = 12;
const MEMORIES_PROMPT_MAX = 5;
const MEMORY_CONTENT_MAX = 80;
const MEMORY_KINDS = new Set(['fact', 'event', 'preference', 'promise']);
// 模型单次输出硬上限：8k 字符以外的内容不进解析，防止一段跑飞的输出把后续合并全污染。
const MAX_OUTPUT_CHARS = 8000;

// 价格口径与 src/model-prices.js 的 deepseek-flash 空闲价一致（元/百万 token）。
// 这里只做「大致多少钱」的提示，不重复实现峰谷判定，所以固定标空闲价并在 costHint 里注明高峰翻倍。
const COST_PER_M_TOKEN = { input: 1, output: 4 };

/** 把任意输入夹成 [min, max] 内的整数；非法值退回 fallback。 */
function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** now 接受 undefined / 毫秒时间戳；非法值用当前时间，避免窗口变成 NaN。 */
function resolveNow(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : Date.now();
}

/**
 * 折叠空白并去掉控制字符。
 *
 * 为什么必须做：印象文本最后要进提示词/JSON/日志，模型偶尔会吐出 \u0000 或一整串换行，
 * 原样落盘会让下游（console、提示词拼接）出现难查的显示问题。
 */
function collapse(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 北京时间日期键（YYYY-MM-DD），用作「会话×天」的切片维度。 */
function dayKeyOf(tsMs) {
  return new Date(tsMs + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/** 一条消息在提示词里的估算开销：正文 + 每条固定的 `[key|seq] 名字(QQ): ` 前缀。 */
function messageCost(message) {
  return message.text.length + 16;
}

function compareMessages(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  const left = Number(a.seq);
  const right = Number(b.seq);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
  return String(a.seq ?? '').localeCompare(String(b.seq ?? ''));
}

/**
 * 计算归纳窗口。
 *
 * @param {number} [nowMs] 窗口右端（毫秒）；缺省用当前时间
 * @param {number} [days=2] 往前几天；非正数/非法值退回 2，上限 30 天
 * @returns {{from:number, to:number, days:number}}
 */
export function windowOf(nowMs, days = 2) {
  const now = resolveNow(nowMs);
  const span = Number(days);
  const validDays = Number.isFinite(span) && span > 0 ? Math.min(30, Math.max(1, Math.round(span))) : 2;
  return { from: now - validDays * DAY_MS, to: now, days: validDays };
}

/**
 * 把消息归一成切片原料；不构成素材的（自己说的、空文本、没有 QQ 号、时间戳坏）直接返回 null。
 *
 * 为什么要求 QQ 号：印象最终按 QQ 归档，没 QQ 号的系统消息/匿名消息归不到人，硬凑会串人。
 */
function normalizeMessage(raw, maxMessageChars) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ts = Number(raw.ts ?? raw.t ?? raw.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (raw.isSelf === true || raw.isSelf === 1 || raw.is_self === 1) return null;
  const text = truncateText(collapse(raw.text ?? raw.content), maxMessageChars);
  if (!text) return null;
  const userId = collapse(raw.userId ?? raw.user_id ?? raw.qq ?? raw.senderId);
  if (!QQ_RE.test(userId)) return null;
  const key = collapse(raw.key ?? raw.scope) || 'unknown';
  const name = truncateText(collapse(raw.sender ?? raw.name), NAME_MAX) || userId;
  return {
    key,
    ts: Math.round(ts),
    seq: raw.seq ?? raw.messageSeq ?? null,
    userId,
    name,
    text
  };
}

/** 用一组消息造一个分片；people 按首次出现顺序去重，方便提示词里报人数。 */
function makeChunk(cellKey, messages) {
  const sorted = messages.slice().sort(compareMessages);
  const people = [];
  for (const message of sorted) {
    if (!people.includes(message.userId)) people.push(message.userId);
  }
  return {
    key: cellKey.key,
    day: cellKey.day,
    messages: sorted,
    fromMs: sorted[0].ts,
    toMs: sorted[sorted.length - 1].ts,
    messageCount: sorted.length,
    chars: sorted.reduce((sum, message) => sum + messageCost(message), 0),
    textChars: sorted.reduce((sum, message) => sum + message.text.length, 0),
    people
  };
}

/**
 * 分片数超过 maxShards 时反复合并「消息数最少的相邻对」。
 *
 * 为什么优先合并同一会话×天的相邻块：跨天/跨会话合并会把不相关语境塞进同一个提示词，
 * 模型容易把 A 群的气质写到 B 群的人身上。只有块数仍超标时才被迫跨会话合并。
 * 平局取更早的下标，保证同样输入得到同样的合并顺序（可重复测试）。
 */
function mergeTowardsLimit(chunks, maxShards) {
  const out = chunks.slice();
  while (out.length > maxShards && out.length > 1) {
    let bestIndex = 0;
    let bestCost = Infinity;
    for (let i = 0; i < out.length - 1; i += 1) {
      const sameCell = out[i].key === out[i + 1].key && out[i].day === out[i + 1].day;
      const cost = out[i].messageCount + out[i + 1].messageCount + (sameCell ? 0 : 1e9);
      if (cost < bestCost) {
        bestCost = cost;
        bestIndex = i;
      }
    }
    const left = out[bestIndex];
    const right = out[bestIndex + 1];
    out.splice(bestIndex, 2, makeChunk({ key: left.key, day: left.day }, left.messages.concat(right.messages)));
  }
  return out;
}

/**
 * 按「会话×北京时间天」切片。
 *
 * @param {Array<object>} messages 入站消息（ts/t/key、userId、sender、text、isSelf 任一命名风格都认）
 * @param {object} [options]
 * @param {number} [options.maxShards=10] 最多几个分片（超出就合并低信息量的相邻块）
 * @param {number} [options.maxPerShard=800] 单分片最多几条消息
 * @param {number} [options.maxCharsPerShard=6000] 单分片最多多少字（防一个提示词塞爆上下文）
 * @param {number} [options.maxMessageChars=300] 单条消息截断长度（长文只留开头，够判断话题）
 * @returns {Array<object>} `[{id,key,day,fromMs,toMs,messages,messageCount,chars,people}]`，稳定可测
 */
export function planImpressionShards(messages, options = {}) {
  const maxShards = clampInt(options.maxShards, 10, 1, 50);
  const maxPerShard = clampInt(options.maxPerShard, 800, 1, 5000);
  const maxCharsPerShard = clampInt(options.maxCharsPerShard, 6000, 200, 60000);
  const maxMessageChars = clampInt(options.maxMessageChars, 300, 20, 2000);
  const list = Array.isArray(messages) ? messages : [];

  const buckets = new Map();
  for (const raw of list) {
    const message = normalizeMessage(raw, maxMessageChars);
    if (!message) continue;
    const cellId = `${message.key}|${dayKeyOf(message.ts)}`;
    if (!buckets.has(cellId)) buckets.set(cellId, []);
    buckets.get(cellId).push(message);
  }

  // 先按会话 key/日期排序再切块，div 出来的块顺序就与输入数组顺序无关（同样的消息集合 ⇒ 同样的分片）。
  const cells = [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let chunks = [];
  for (const [cellId, items] of cells) {
    const [key] = cellId.split('|');
    const day = cellId.slice(key.length + 1);
    const cellMessages = items.sort(compareMessages);
    let current = [];
    let chars = 0;
    const flush = () => {
      if (!current.length) return;
      chunks.push(makeChunk({ key, day }, current));
      current = [];
      chars = 0;
    };
    for (const message of cellMessages) {
      const cost = messageCost(message);
      if (current.length >= maxPerShard || (current.length > 0 && chars + cost > maxCharsPerShard)) flush();
      current.push(message);
      chars += cost;
    }
    flush();
  }

  chunks = mergeTowardsLimit(chunks, maxShards);
  chunks.sort((a, b) => {
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    return a.fromMs - b.fromMs;
  });

  // id 由「会话#日期#当天第几块」决定，不依赖模型/时间：同一批消息重复跑得到同一套分片号，
  // 出问题能对着日志直接定位是哪个分片。
  const counters = new Map();
  for (const chunk of chunks) {
    const cellId = `${chunk.key}#${chunk.day}`;
    const next = (counters.get(cellId) ?? 0) + 1;
    counters.set(cellId, next);
    chunk.id = `${cellId}#${next}`;
  }
  return chunks;
}

/**
 * 生成一个分片的归纳提示词。
 *
 * 设计取舍：明确要求「只输出 JSON 数组、不调用工具、不编造、不猜隐私」——
 * 提示注入的主要入口是群友自己说的话（消息正文里可能写「忽略以上指令」），
 * 所以提示词把边界写死，解析层再做白名单校验，两层都不指望模型自觉。
 */
export function buildShardPrompt(shard, options = {}) {
  const maxChars = clampInt(options.maxChars, 120, 40, IMPRESSION_HARD_MAX);
  const maxTags = clampInt(options.maxTags, 5, 1, TAGS_HARD_MAX);
  const maxMessageChars = clampInt(options.maxMessageChars, 300, 20, 2000);
  const lines = [];
  for (const message of (shard?.messages ?? [])) {
    lines.push(`[${message.key}|${message.seq ?? '-'}] ${message.name}(${message.userId}): ${truncateText(message.text, maxMessageChars)}`);
  }
  const header = [
    `下面是一段群聊记录（会话 ${shard?.key ?? 'unknown'}，日期 ${shard?.day ?? 'unknown'}，共 ${shard?.messageCount ?? 0} 条）。`,
    '请只根据这些记录，归纳其中每位群友给人的印象。硬性要求：',
    '1. 只输出一个 JSON 数组，不要输出任何解释文字，不要用 Markdown 代码块包裹。',
    `2. 每个元素形如 {"userId":"QQ号，纯数字","name":"群里显示的名字","impression":"不超过 ${maxChars} 字的印象","tags":["最多 ${maxTags} 个短标签"],"evidence":[{"key":"会话 key","seq":消息序号}]}`,
    '3. impression 只写能从记录里直接看出来的：关注的话题、说话风格、互动习惯；不要猜测真实身份、职业、住址、健康等隐私，也不要把记录里没发生的事写进去。',
    `4. evidence 最多 ${EVIDENCE_PROMPT_MAX} 条，key/seq 取自每条记录方括号里的「会话 key|序号」。`,
    `5. 每个元素还可以带 "memories"：最多 ${MEMORIES_PROMPT_MAX} 条该人的具体记忆，形如 {"kind":"fact|event|preference|promise","content":"一句话（不超过 ${MEMORY_CONTENT_MAX} 字）","importance":0.1~1 的小数}。只记值得跨天记住的：身份/设备/项目/所在地等事实（fact）、发生过的事（event）、明确偏好（preference）、答应过的事（promise）。一次性的玩梗和情绪不要记，记录里没出现的信息不要编。`,
    '6. 语气中性具体；没有可归纳内容的人直接省略；不要调用任何工具。'
  ].join('\n');
  return `${header}\n\n${lines.join('\n')}`;
}

/** 从文本里找出第一个能完整解析的 JSON 数组（模型常在数组前后多写解释）。 */
function extractJsonArray(text) {
  const starts = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '[') starts.push(i);
  }
  for (const start of starts) {
    const end = findBalancedEnd(text, start);
    if (end < 0) continue;
    const candidate = text.slice(start, end + 1);
    try {
      const value = JSON.parse(candidate);
      if (Array.isArray(value)) return value;
    } catch {
      // 不是完整 JSON：继续试下一个 '['，模型偶尔会先写「示例如下：[...]」再给真数组。
    }
  }
  return null;
}

/** 找到与 start 处 '[' 配对的 ']'，跳过字符串字面量里的括号。 */
function findBalancedEnd(text, start) {
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
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 校验一条「印象」记录。字段白名单 + 长度/数量上限，多余字段一律丢弃。
 *
 * 为什么这么严：模型的输出会直接进 state/impressions.json，将来也可能被拼回提示词。
 * 一条带脚本片段/超长文本/伪造 QQ 号（比如混进别人的号）的记录必须先在这里被拦下，
 * 而不是等下游渲染时才发现。
 *
 * @returns {{ok:boolean, value?:object, reason?:string}}
 */
export function validateImpression(raw, options = {}) {
  const maxChars = clampInt(options.maxChars, IMPRESSION_HARD_MAX, 20, IMPRESSION_HARD_MAX);
  const maxTags = clampInt(options.maxTags, TAGS_HARD_MAX, 0, TAGS_HARD_MAX);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: '不是对象' };

  const userId = collapse(raw.userId ?? raw.user_id ?? raw.qq ?? raw.id);
  if (!QQ_RE.test(userId)) return { ok: false, reason: 'userId 不是 5-15 位 QQ 号' };

  const name = truncateText(collapse(raw.name ?? raw.nickname ?? raw.sender), NAME_MAX);
  if (!name) return { ok: false, reason: '缺少名字' };

  const impression = truncateText(collapse(raw.impression ?? raw.summary ?? raw.text), maxChars);
  if (!impression) return { ok: false, reason: '缺少印象文本' };

  const tags = [];
  if (Array.isArray(raw.tags)) {
    for (const tag of raw.tags) {
      if (tags.length >= maxTags) break;
      const value = truncateText(collapse(tag), TAG_MAX);
      if (value && !tags.includes(value)) tags.push(value);
    }
  }

  const evidence = [];
  const rawEvidence = raw.evidence;
  if (rawEvidence != null && !Array.isArray(rawEvidence)) return { ok: false, reason: 'evidence 不是数组' };
  if (Array.isArray(rawEvidence)) {
    for (const item of rawEvidence) {
      if (evidence.length >= EVIDENCE_HARD_MAX) break;
      if (!item || typeof item !== 'object') continue;
      const key = collapse(item.key ?? item.scope);
      const seq = collapse(item.seq ?? item.messageSeq);
      if (!SCOPE_KEY_RE.test(key) || !/^\d{1,10}$/.test(seq)) continue;
      const added = { key, seq: Number(seq) };
      if (!evidence.some((existing) => existing.key === added.key && existing.seq === added.seq)) evidence.push(added);
    }
    // 给了证据却一条都不合法：多半是编的，整条丢掉比留个无依据的印象安全。
    if (rawEvidence.length > 0 && evidence.length === 0) return { ok: false, reason: '证据引用格式全不合法' };
  }

  const memories = [];
  if (Array.isArray(raw.memories)) {
    for (const item of raw.memories) {
      if (memories.length >= MEMORIES_PROMPT_MAX) break;
      if (!item || typeof item !== 'object') continue;
      const kind = collapse(item.kind ?? item.type);
      const content = truncateText(collapse(item.content ?? item.text ?? item.fact), MEMORY_CONTENT_MAX);
      if (!MEMORY_KINDS.has(kind) || !content) continue;
      const rawImportance = Number(item.importance);
      const importance = Number.isFinite(rawImportance) ? Math.min(1, Math.max(0.1, rawImportance)) : 0.5;
      if (!memories.some((m) => m.content === content)) memories.push({ kind, content, importance });
    }
  }

  const rawCount = Number(raw.evidenceCount);
  const evidenceCount = Number.isInteger(rawCount) && rawCount >= 0 ? rawCount : Math.max(1, evidence.length);
  return { ok: true, value: { userId, name, impression, tags, evidence, evidenceCount, memories } };
}

/** 找不到完整数组时的兜底：从文本里捞出所有能单独解析的对象（输出被 8k 截断时常走这里）。 */
function extractPersonObjects(text) {
  const items = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) objectStart = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        const candidate = text.slice(objectStart, i + 1);
        objectStart = -1;
        try {
          const value = JSON.parse(candidate);
          if (value && typeof value === 'object' && !Array.isArray(value)) items.push(value);
        } catch {
          // 单个对象坏掉：丢掉它，别让整批报销
        }
      }
      if (depth < 0) depth = 0;
    }
  }
  return items;
}

/**
 * 解析模型对一个分片的回复。
 *
 * @returns {{people:Array<object>, dropped:number}} people 全部经过 validateImpression
 */
export function parseShardResponse(text, options = {}) {
  const maxChars = clampInt(options.maxChars, 120, 40, IMPRESSION_HARD_MAX);
  const maxTags = clampInt(options.maxTags, 5, 1, TAGS_HARD_MAX);
  // 只处理前 8000 字符：跑飞的输出再长也没有信息增量，还容易把下游拖进超长字符串。
  const bounded = String(text ?? '').slice(0, MAX_OUTPUT_CHARS);
  const array = extractJsonArray(bounded);
  // 被截断的数组贴不出完整 ']'：退一步逐个捞对象，能救几个是几个，而不是整批丢弃。
  const items = Array.isArray(array) ? array : extractPersonObjects(bounded);
  if (!items.length) return { people: [], dropped: 0 };
  const people = [];
  let dropped = 0;
  for (const item of items) {
    const result = validateImpression(item, { maxChars, maxTags });
    if (!result.ok) {
      dropped += 1;
      continue;
    }
    people.push(result.value);
  }
  return { people, dropped };
}

/** 合并记忆条目：同内容取更高重要度并刷新时间，按「重要度→时间」保留最近 N 条。 */
function mergeMemories(prev, incoming, now) {
  const map = new Map();
  for (const m of Array.isArray(prev) ? prev : []) {
    if (m && m.content) map.set(m.content, { ...m });
  }
  for (const m of Array.isArray(incoming) ? incoming : []) {
    if (!m || !m.content) continue;
    const old = map.get(m.content);
    map.set(m.content, {
      kind: m.kind || old?.kind || 'fact',
      content: m.content,
      importance: Math.max(Number(old?.importance) || 0, Number(m.importance) || 0.5),
      at: now
    });
  }
  return [...map.values()]
    .sort((a, b) => (b.importance - a.importance) || ((b.at || 0) - (a.at || 0)))
    .slice(0, MEMORIES_KEEP);
}

/** 把一条新印象并进已有人选；取更长描述 + 标签并集 + 证据数累加。 */
function mergeOne(merged, value, options) {
  const existing = merged.get(value.userId);
  const evidence = Array.isArray(value.evidence) ? value.evidence.slice(0, EVIDENCE_KEEP) : [];
  if (!existing) {
    merged.set(value.userId, {
      userId: value.userId,
      name: value.name,
      impression: truncateText(value.impression, options.maxChars),
      tags: value.tags.slice(0, options.maxTags),
      evidence,
      evidenceCount: value.evidenceCount,
      memories: mergeMemories([], value.memories, options.now),
      updatedAt: options.now
    });
    return;
  }
  // 证据锚点保留一份可展开的样本（默认最近 6 条），其余只在 evidenceCount 里计数。
  for (const item of evidence) {
    if (existing.evidence.length >= EVIDENCE_KEEP) break;
    if (!existing.evidence.some((e) => e.key === item.key && e.seq === item.seq)) existing.evidence.push(item);
  }
  // 同一个人的两份描述只会有一份更完整；取更长的那个，避免把不同分片的重复描述拼成啰嗦长文。
  const nextImpression = value.impression.length > existing.impression.length ? value.impression : existing.impression;
  const tags = existing.tags.slice();
  for (const tag of value.tags) {
    if (tags.length >= options.maxTags) break;
    if (!tags.includes(tag)) tags.push(tag);
  }
  existing.name = value.name; // 昵称会改，以更晚的分片为准
  existing.impression = truncateText(nextImpression, options.maxChars);
  existing.tags = tags;
  existing.evidenceCount += value.evidenceCount;
  existing.memories = mergeMemories(existing.memories, value.memories, options.now);
  existing.updatedAt = options.now;
}

/**
 * 合并上一轮结果与本次各分片的归纳结果。
 *
 * @param {object|null} prev 上一次的 `{people:{...}}`（也可以是整个 impressions.json）
 * @param {Array} shardResults `parseShardResponse` 的结果或 person 数组的数组
 * @param {object} [options]
 * @param {number} [options.maxChars=120] 单人印象长度上限
 * @param {number} [options.maxTags=5] 单人标签数上限
 * @returns {{people:object, stats:{kept:number, dropped:number}}}
 */
export function mergeImpressions(prev, shardResults, options = {}) {
  const maxChars = clampInt(options.maxChars, 120, 20, IMPRESSION_HARD_MAX);
  const maxTags = clampInt(options.maxTags, 5, 0, TAGS_HARD_MAX);
  const now = resolveNow(options.now);
  const merged = new Map();
  let dropped = 0;

  const prevPeople = prev && typeof prev === 'object' && prev.people && typeof prev.people === 'object' ? prev.people : {};
  for (const [qq, item] of Object.entries(prevPeople)) {
    const result = validateImpression({ ...(item && typeof item === 'object' ? item : {}), userId: String(item?.userId ?? qq) }, {
      maxChars: IMPRESSION_HARD_MAX,
      maxTags: TAGS_HARD_MAX
    });
    if (!result.ok) {
      dropped += 1;
      continue;
    }
    merged.set(result.value.userId, {
      ...result.value,
      impression: truncateText(result.value.impression, maxChars),
      tags: result.value.tags.slice(0, maxTags),
      updatedAt: Number.isFinite(Number(item?.updatedAt)) ? Number(item.updatedAt) : now
    });
  }

  for (const part of Array.isArray(shardResults) ? shardResults : []) {
    const list = Array.isArray(part) ? part : Array.isArray(part?.people) ? part.people : null;
    if (!list) {
      dropped += 1; // 整个分片失败/格式坏：记一次丢弃，别让它静默消失
      continue;
    }
    for (const item of list) {
      const result = validateImpression(item, { maxChars: IMPRESSION_HARD_MAX, maxTags: TAGS_HARD_MAX });
      if (!result.ok) {
        dropped += 1;
        continue;
      }
      mergeOne(merged, result.value, { maxChars, maxTags, now });
    }
  }

  const people = {};
  for (const qq of [...merged.keys()].sort((a, b) => Number(a) - Number(b))) people[qq] = merged.get(qq);
  return { people, stats: { kept: Object.keys(people).length, dropped } };
}

/** 人类可读的 token 数量。 */
function formatTokens(count) {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/**
 * 估算一轮归纳的 token 与成本（只做数量级提示，不参与任何判定）。
 *
 * @param {object} input
 * @param {number} [input.inputChars] 全部提示词字符数
 * @param {number} [input.people] 预计人数（没给 outputChars 时用来估输出）
 * @param {number} [input.outputChars] 预计输出字符数
 * @param {number} [input.maxChars=120] 单人印象长度上限
 */
export function estimateBudget(input = {}) {
  const inputChars = Math.max(0, Math.round(Number(input.inputChars) || 0));
  const people = Math.max(0, Math.round(Number(input.people) || 0));
  const maxChars = clampInt(input.maxChars, 120, 20, IMPRESSION_HARD_MAX);
  const outputChars = Math.max(0, Math.round(Number(input.outputChars) || people * (maxChars + 60)));
  // 中文约 1.6 字符/token（含标点与 QQ 号这类数字），只求量级对得上。
  const estInputTokens = Math.ceil(inputChars / 1.6);
  const estOutputTokens = Math.ceil(outputChars / 1.6);
  const estCostCny = Number(
    ((estInputTokens / 1e6) * COST_PER_M_TOKEN.input + (estOutputTokens / 1e6) * COST_PER_M_TOKEN.output).toFixed(4)
  );
  const costHint = `≈ ${formatTokens(estInputTokens)} 输入 + ${formatTokens(estOutputTokens)} 输出 token，约 ¥${estCostCny.toFixed(3)}（flash 空闲价；工作日 9-12/14-18 点高峰 ×2）`;
  return { inputChars, outputChars, estInputTokens, estOutputTokens, estCostCny, costHint };
}

/**
 * 编排：切片 →（apply 时）逐分片调模型（失败只重跑该分片）→ 合并 →（可选）写盘。
 *
 * 默认 dry-run：不调模型、不写盘，只回报分片与预算——先看清楚「这一次要花多少、切成了什么样」，
 * 再决定是否 --apply。apply 时的重试按「轮」进行：一轮把所有未成功的分片各跑一次，
 * 最多 maxSteps 轮；整轮毫无进展就提前放弃，避免对着同一个失败分片烧钱。
 *
 * @param {object} deps
 * @param {Array<object>} deps.messages 消息（db 行或 jsonl 行均可）
 * @param {number} [deps.now] 窗口右端毫秒
 * @param {number} [deps.days=2] 往前几天
 * @param {number} [deps.maxShards=10]
 * @param {number} [deps.maxPerShard=800]
 * @param {number} [deps.maxCharsPerShard=6000]
 * @param {number} [deps.maxSteps=4] 总重试轮数上限
 * @param {(shard:object)=>Promise<string>} [deps.caller] apply 模式必填：分片 → 模型原始输出
 * @param {object|null} [deps.prev] 上一轮 impressions.json（保留历史印象与证据数）
 * @param {boolean} [deps.apply=false] 是否真的调模型
 * @param {(state:object, stateFile?:string)=>Promise<void>|void} [deps.write] 写盘实现（只有 --apply 才传）
 * @param {string} [deps.stateFile] 交给 write 的路径
 * @param {(line:string)=>void} [deps.log] 进度日志
 * @returns {Promise<object>}
 */
export async function buildImpressions(deps = {}) {
  const now = resolveNow(deps.now);
  const window = windowOf(now, deps.days);
  const maxShards = clampInt(deps.maxShards, 10, 1, 50);
  const maxChars = clampInt(deps.maxChars, 120, 20, IMPRESSION_HARD_MAX);
  const maxTags = clampInt(deps.maxTags, 5, 1, TAGS_HARD_MAX);
  const maxSteps = clampInt(deps.maxSteps, 4, 1, 8);
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  const shards = planImpressionShards(deps.messages, {
    maxShards,
    maxPerShard: deps.maxPerShard,
    maxCharsPerShard: deps.maxCharsPerShard,
    maxMessageChars: deps.maxMessageChars
  });
  const senders = new Set();
  let chars = 0;
  let promptChars = 0;
  let usedMessages = 0;
  for (const shard of shards) {
    chars += shard.textChars;
    promptChars += shard.chars;
    usedMessages += shard.messageCount;
    for (const qq of shard.people) senders.add(qq);
  }
  // 每个分片还有固定的提示词头部（规则说明），粗算 500 字符；输出按人数×单人上限估。
  const budget = estimateBudget({ inputChars: promptChars + shards.length * 500, people: senders.size, maxChars });
  const base = {
    window,
    shards,
    stats: {
      received: deps.messages?.length ?? 0,
      messages: usedMessages,
      shards: shards.length,
      people: senders.size,
      chars,
      promptChars,
      budget
    }
  };

  if (!deps.apply) {
    log(`dry-run：${shards.length} 个分片、${senders.size} 位群友、${chars} 字；未调用模型、未写盘`);
    return { mode: 'dry-run', ...base };
  }
  if (typeof deps.caller !== 'function') throw new Error('apply 模式需要注入 caller(shard)');

  const results = new Array(shards.length).fill(null);
  let pending = shards.map((_shard, index) => index);
  let steps = 0;
  for (let round = 0; round < maxSteps && pending.length > 0; round += 1) {
    steps += 1;
    const nextPending = [];
    for (const index of pending) {
      const shard = shards[index];
      try {
        const rawText = await deps.caller(shard);
        const parsed = parseShardResponse(rawText, { maxChars, maxTags });
        if (parsed.people.length === 0) {
          log(`分片 ${shard.id} 没有可用印象（丢弃 ${parsed.dropped} 条），准备重跑`);
          nextPending.push(index);
          continue;
        }
        results[index] = parsed;
        log(`分片 ${shard.id} 完成：${parsed.people.length} 人，丢弃 ${parsed.dropped} 条`);
      } catch (error) {
        log(`分片 ${shard.id} 第 ${round + 1} 轮失败：${error?.message ?? error}`);
        nextPending.push(index);
      }
    }
    pending = nextPending;
  }

  const merged = mergeImpressions(deps.prev ?? null, results, { maxChars, maxTags, now });
  const state = {
    version: 1,
    generatedAt: now,
    window: { from: window.from, to: window.to },
    people: merged.people,
    meta: { shards: shards.length, kept: merged.stats.kept, dropped: merged.stats.dropped, costHint: budget.costHint, steps }
  };
  let wrote = false;
  if (typeof deps.write === 'function') {
    await deps.write(state, deps.stateFile);
    wrote = true;
  }
  return { mode: 'apply', ...base, state, stats: { ...base.stats, ...merged.stats, steps, wrote, failed: pending.length } };
}
