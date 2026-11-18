// 跨会话记忆：会话摘要（低成本启发式）+ 注入块渲染。纯函数，便于单测。
//
// 2026-10-27 D36 两处改动（都在这份文件里，bridge 不用换模块）：
//   ① `renderDigestBlock()` 多了 `disclosure` 选项：'open'（默认，用户拍板选 B：被问起时可以承认记得，
//      但只到「记得有这回事」这一层，不复述原话、不点隐私细节）/ 'strict'（旧措辞，随时切回）；
//   ② `buildDigest()` 不再把纯占位符消息写成「人名：[图片]」、不再留半截尾条、
//      topics 只取跨消息重复出现的短语（原来是从摘要里乱切 2~8 字，抓出「算了」这种）。
import { relativeTimeLabel } from './relative-time.js';

export const DIGEST_DEFAULTS = Object.freeze({
  everyMessages: 20,
  maxChars: 200,        // 单条摘要上限
  maxAgeMs: 24 * 3600 * 1000,
  maxSessions: 3,
  maxCharsEach: 120,    // 注入时每个会话的上限
  maxBlockChars: 600
});

// ── 占位符与「带事实的占位符」 ──────────────────────────────────────────────
// [图片]/[表情包:…]/[视频]/[文件]/[语音] 这类只有「有个媒体」，对回忆没有信息量 → 整条跳过；
// 但 [视频 12 秒｜已抽 9 帧]、[文件 报告.zip（已转存 id=20）]、[语音 5 秒｜转写：…] 是**带事实的**，
// 必须留下——那正是「别的群在聊什么」的证据。
const PLACEHOLDER_RE = /\[(?:图片|表情包[^\]]*|视频[^\]]*|文件[^\]]*|语音[^\]]*|转发[^\]]*|拍一拍[^\]]*)\]/g;
const FACT_HINT_RE = /(秒|\d+\s*帧|已抽|已转存|已下载|转写|时长|id=\d+)/;

/** 去掉「纯占位」的媒体标记，保留带事实的（时长/帧数/已转存）——后者是回忆的线索。 */
export function stripPurePlaceholders(text) {
  return String(text || '').replace(PLACEHOLDER_RE, (m) => (FACT_HINT_RE.test(m) ? m : ' '));
}

/** 一条消息是不是「只有媒体、没有信息」。带事实的媒体占位符返回 false（要保留）。 */
export function isPlaceholderOnly(text) {
  const s = String(text || '');
  const stripped = stripPurePlaceholders(s).replace(/\s+/g, '');
  if (stripped) return false;                       // 还有正文（或带事实的媒体标记）→ 不是纯占位
  const media = s.match(PLACEHOLDER_RE) || [];
  return media.length === 0 || media.every((m) => !FACT_HINT_RE.test(m));
}

/** 把一条消息的正文压成「一句完整的话」：短句原样；长句按句末标点断；实在要截就加 …。 */
export function shapeBody(raw, { maxBody = 40 } = {}) {
  const text = stripPurePlaceholders(raw).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxBody) return text;
  const window = text.slice(0, maxBody + 10);
  let cut = -1;
  for (let i = 0; i < window.length; i += 1) {
    if (/[。！？!?～~…）」』】"”']/.test(window[i])) cut = i;
    if (i >= maxBody && cut > 0) break;
  }
  if (cut >= 4) return window.slice(0, cut + 1);
  return `${text.slice(0, Math.max(1, maxBody - 1))}…`;
}

// 口水词/虚词：只用来判断「这个话题串大概率没有检索价值」。
const STOP_PREFIX = new Set(('的了着过是我你他她它这那哪就都也还又再才只没不别很太真更最和与及或者而但因所以如果然后可能应该是要有把被让给对从到在吗吧啊嗯哦呃呀哈嘿咦喂啥嘛呢'
  + '一二三四五六七八九十第个条点些样种次回天年').split(''));
const JUNK_WORDS = new Set(['算了', '这个', '那个', '什么', '怎么', '可以', '不是', '就是', '然后', '所以', '但是',
  '没有', '知道', '觉得', '一样', '时候', '现在', '还是', '真的', '有点', '好像', '已经', '其实', '意思', '反正',
  '不过', '而且', '一个', '这么', '那么', '干嘛', '咋了', '好吧', '行吧', '你们', '自己', '知道吗']);

/**
 * 从最近若干条消息拼一个摘要（不调模型：sender + 短句）。
 *
 * 与旧版的差别（每条都有单测）：
 *   · 纯占位符消息整条跳过（`[图片]` 不再占「人名：内容」的槽位）；带事实的媒体占位符保留；
 *   · 只拼**整段**：装不下就停，绝不把最后一条切成「杜十娘：你」；
 *   · 长正文按句末标点断，截过的那段不允许落在末尾（尾巴上不留省略号）；
 *   · topics 只取**在 ≥2 条消息里重复出现**的 2~6 字短语，取不到就空着（不再编假话题）。
 */
export function buildDigest({ key, messages = [], now = Date.now(), maxChars = DIGEST_DEFAULTS.maxChars, opts = {} } = {}) {
  const o = { maxBody: 40, maxOthers: 6, maxSelf: 2, maxTopics: 6, ...(opts || {}) };
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && String(m.plain ?? m.text ?? '').trim());
  if (!list.length) return null;
  const recent = list.slice(-14);

  const people = [];
  const others = [];
  const selfs = [];
  for (const m of recent) {
    const raw = String(m.plain ?? m.text ?? '');
    if (isPlaceholderOnly(raw)) continue;                     // ① 纯占位符整条跳过
    const sender = String(m.sender || '群友').slice(0, 12);
    const body = shapeBody(raw, { maxBody: o.maxBody });
    if (!body) continue;
    if (!m.isSelf && !people.includes(sender)) people.push(sender);
    // D48：带上**这条消息的说话时间**（不是摘要生成时间），注入时才能给出时间线。
    (m.isSelf ? selfs : others).push({ sender, body, at: Number(m.time) || 0 });
  }

  const segs = [];
  for (const it of others.slice(-o.maxOthers)) segs.push({ self: false, from: it.sender, body: it.body, text: `${it.sender}：${it.body}`, at: it.at });
  // 「我：」只在别人的话不够时说；够就只留 1 条（避免整条摘要变成自言自语）
  const selfBudget = others.length < 3 ? o.maxSelf : Math.min(o.maxSelf, 1);
  for (const it of selfs.slice(-selfBudget)) {
    const body = shapeBody(it.body, { maxBody: 40 });
    segs.push({ self: true, from: '我', body, text: `我：${body}`, at: it.at });
  }

  // ② 只拼整段：装不下就停（旧版是拼完再 slice，所以永远半个句子）
  let summary = '';
  const included = [];
  for (const s of segs) {
    const next = summary ? `${summary}；${s.text}` : s.text;
    if (next.length > maxChars) break;
    summary = next;
    included.push(s);
  }
  // ③ 尾巴上不留省略号：末段是被 shapeBody 砍过的（以 … 结尾）就整段丢掉，再退一步保证不出半个「人名：」
  while (summary.endsWith('…') && summary.includes('；')) summary = summary.slice(0, summary.lastIndexOf('；'));
  while (summary.endsWith('：') && summary.includes('；')) summary = summary.slice(0, summary.lastIndexOf('；'));
  if (!summary) return null;

  // ④ topics：只取跨消息重复出现的短语（重复才有可能是话题），不做字符窗口硬切
  const ngramCount = new Map();
  const texts = recent.map((m) => String(m.plain ?? m.text ?? '')).filter((t) => t && !isPlaceholderOnly(t));
  for (const text of texts) {
    const clean = text.replace(PLACEHOLDER_RE, ' ').replace(/\s+/g, ' ');
    const seen = new Set();
    for (let len = 6; len >= 2; len -= 1) {
      for (let i = 0; i + len <= clean.length; i += 1) {
        const g = clean.slice(i, i + len);
        if (!/^[\u4e00-\u9fa5A-Za-z0-9]+$/.test(g)) continue;
        if (JUNK_WORDS.has(g)) continue;
        if (STOP_PREFIX.has(g[0])) continue;
        if (people.some((p) => p && (p.includes(g) || g.includes(p)))) continue;
        if (seen.has(g)) continue;
        seen.add(g);
        ngramCount.set(g, (ngramCount.get(g) || 0) + 1);
      }
    }
  }
  const topics = [];
  for (const [t] of [...ngramCount.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[0].length * b[1] - a[0].length * a[1])) {
    if (topics.length >= o.maxTopics) break;
    if (topics.some((x) => x.includes(t) || t.includes(x))) continue;
    topics.push(t);
  }

  // D48：结构化记忆条目（每条自带**说话时间**与说话人），注入时按时间正序渲染；
  // summary 仍保留给旧路径/控制台。at=0 表示时间未知（旧数据），绝不为它编一个时间。
  const entries = included
    .map((s) => ({ at: Number(s.at) || 0, text: String(s.body ?? '').slice(0, 80), from: String(s.from || '群友').slice(0, 12) }))
    .sort((a, b) => (a.at || Number.POSITIVE_INFINITY) - (b.at || Number.POSITIVE_INFINITY));

  return { key: String(key || ''), at: Number(now) || Date.now(), summary, topics, people: people.slice(0, 8), entries };
}

/** 选取可注入的其他会话摘要：白名单会话、24h 内、最多 N 个、当前会话排除。 */
export function pickDigests({ digests = {}, currentKey = '', allowKeys = [], now = Date.now(), opts = {} } = {}) {
  const o = { ...DIGEST_DEFAULTS, ...(opts || {}) };
  const allow = new Set((Array.isArray(allowKeys) ? allowKeys : []).map(String));
  const out = [];
  for (const [key, d] of Object.entries(digests && typeof digests === 'object' ? digests : {})) {
    if (!d || !d.summary) continue;
    if (String(key) === String(currentKey)) continue;
    if (!allow.has(String(key))) continue;
    if (Number(now) - Number(d.at || 0) > o.maxAgeMs) continue;
    out.push({
      key: String(key),
      at: Number(d.at) || 0,
      summary: String(d.summary).slice(0, o.maxCharsEach),
      people: Array.isArray(d.people) ? d.people.slice(0, 4) : [],
      // D48：逐条记忆（说话时间 + 文本 + 说话人）随摘要一起注入；旧摘要没有这个字段 → 回落块级时间。
      entries: normalizeEntries(d.entries ?? d.items)
    });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, o.maxSessions);
}

/**
 * 归一化逐条记忆。兼容三种历史形态：
 *   [{at,text,from}]（新） / [{at,text}]（D48 早期） / "纯字符串"（更老的数据）。
 * 纯字符串没有 speaking time，**一律 at=0（时间未知）**，绝不伪造一个时间。
 */
export function normalizeEntries(raw) {
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text ? [{ at: 0, text: text.slice(0, 80), from: '群友' }] : [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && typeof e === 'object' && String(e.text ?? '').trim())
    .slice(0, 14)
    .map((e) => ({
      at: Number(e.at) || 0,
      text: String(e.text).trim().slice(0, 80),
      from: String(e.from || '群友').slice(0, 12)
    }));
}
/**
 * 归一化摘要表：坏条目（无 summary / 无 at / 不是对象）一律丢掉，字段裁剪到可控长度。
 * 为什么要有：`state/social-v2.json` 是磁盘文件，可能被手改、可能是旧版本写的、
 * 也可能半截写坏；不归一就直接拼进 prompt，等于让脏数据进模型上下文。
 * 默认不按时间淘汰（`maxAgeMs = Infinity`）——过期与否交给 pickDigests 判断，
 * 让「读」和「过期」两件事各管各的，单测也好写。
 */
export function normalizeDigests(raw, { now = Date.now(), maxAgeMs = Infinity, maxEntries = Infinity } = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rows = [];
  for (const [key, d] of Object.entries(src)) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
    if (typeof d.summary !== 'string') continue;
    const summary = d.summary.trim();
    const at = Number(d.at) || 0;
    if (!summary || !at) continue;
    if (Number(now) - at > maxAgeMs) continue;
    rows.push([String(key), {
      key: String(key),
      at,
      summary: summary.slice(0, DIGEST_DEFAULTS.maxChars),
      topics: Array.isArray(d.topics) ? d.topics.slice(0, 8).map(String) : [],
      people: Array.isArray(d.people) ? d.people.slice(0, 8).map(String) : [],
      // D48：逐条记忆 {at（说话时间）, text, from}；坏条目直接丢，不让脏时间进 prompt。
      entries: normalizeEntries(d.entries ?? d.items)
    }]);
  }
  rows.sort((a, b) => b[1].at - a[1].at);
  const cap = Number(maxEntries);
  const keep = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : rows.length;
  const out = {};
  for (const [key, v] of rows.slice(0, keep)) out[key] = v;
  return out;
}

/**
 * 落盘快照：`saveSocialV2State()` 用它把内存里的摘要写进 `state/social-v2.json`。
 *
 * 之前这里缺了这一行，摘要只活在进程内存里，**每次重启跨会话记忆归零**——
 * 线上 state 文件里连 `digests` 字段都没有，而群里的消息已经攒了几百条。
 * 落盘时顺手把 >24h 的旧摘要丢掉（它们本来就进不了 prompt），最多留 50 个会话，
 * 免得这个文件被历史会话无限撑大。
 */
export function digestSnapshot(digests, { now = Date.now(), maxAgeMs = DIGEST_DEFAULTS.maxAgeMs, maxEntries = 50 } = {}) {
  return normalizeDigests(digests, { now, maxAgeMs, maxEntries });
}

// ── 注入块表头：两档披露口径 ────────────────────────────────────────────────
// 'open'   = 用户 2026-10-27 拍板的 B 档：记忆要被感知，隐私靠「不复述原话、不点隐私」来守；
// 'strict' = 旧措辞（A 档），随时可切回；两档都保留「隐私细节不点名」的底线。
export const DISCLOSURE_HEADERS = Object.freeze({
  open: '【其它会话的近况】你最近在别的群待过，这些是那里的片段。被问起时可以说「记得隔壁群有这回事」、说说大概在聊什么；但只到「记得有这回事」这一层：不复述别人的原话，也不提手机号、住址、真实姓名、账号这类隐私细节。没被问就正常接话，不用刻意表现自己记得。记忆里的时间都是**标注好的**，不许自己推断或编造；没有标注时间的旧片段就说「记不清是什么时候」，不许说成刚发生；对方问「多久以前」时，只回答能确认的粒度（例如「今天早些时候」「前天」）。',
  strict: '【其它会话的近况】这些是你最近在别的群的片段，可以据此接话/回忆；但不要主动把其它群的具体聊天内容、人名细节说给现在的人听。时间规则同上：只认标注好的时间，不推断不编造；没标注就说「记不清是什么时候」，不许说成刚发生。'
});

/**
 * 渲染成 prompt 块。disclosure: 'open'（默认）| 'strict'。纯函数——不读配置，由调用方传。
 * D48：有逐条记忆（entries）就按时间正序、每条带相对时间渲染；没有就回落块级「N 小时前更新」。
 * 预算纪律：超了**砍条数**（3→2→1），不砍时间标签；时间标签总字数额外记账（≤150）。
 */
export function renderDigestBlock(items, { maxBlockChars = DIGEST_DEFAULTS.maxBlockChars, disclosure = 'open', now = Date.now() } = {}) {
  const list = Array.isArray(items) ? items.filter((i) => i && i.summary) : [];
  if (!list.length) return '';
  const header = DISCLOSURE_HEADERS[disclosure] || DISCLOSURE_HEADERS.open;
  const orderAsc = (entries) => [...entries]
    .sort((a, b) => (Number(a.at) || Number.POSITIVE_INFINITY) - (Number(b.at) || Number.POSITIVE_INFINITY));
  const withTimeBudget = (entries, perConv) => {
    // 「最早一条 + 最近 N-1 条」：既能看到跨度，又优先最近的。
    const ordered = orderAsc(entries);
    if (perConv <= 0) return [];
    if (ordered.length <= perConv) return ordered;
    return [ordered[0], ...ordered.slice(-(perConv - 1))];
  };
  const build = (perConv) => {
    const lines = [header];
    for (const it of list) {
      const where = it.key.startsWith('group:') ? `群 ${it.key.slice(6)}` : '私聊';
      const entries = Array.isArray(it.entries) ? it.entries.filter((e) => e && String(e.text || '').trim()) : [];
      const when = relativeTimeLabel(it.at, now);
      if (entries.length) {
        lines.push(`· ${where}${when ? `（${when}更新）` : '（时间不详）'}：`);
        for (const e of withTimeBudget(entries, perConv)) {
          const label = relativeTimeLabel(e.at, now) || '时间不详';
          const from = String(e.from || '群友').slice(0, 12);
          lines.push(`  ${label}｜${from}：${String(e.text).slice(0, 60)}`);
        }
        continue;
      }
      lines.push(`· ${where}${when ? `（${when}更新）` : '（时间不详）'}：${String(it.summary).slice(0, 120)}`);
    }
    return lines.join('\n');
  };
  for (const perConv of [3, 2, 1]) {
    const text = build(perConv);
    if (text.length <= maxBlockChars) return `${text}\n\n`;
  }
  return `${build(1).slice(0, maxBlockChars - 1)}…\n\n`;
}
