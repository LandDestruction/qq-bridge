// 跨群认人（D42）：长期人物档案 + 别名索引 + **命中才召回**。
//
// 为什么不用「调大摘要窗口」解决：
//   摘要是「最近约 10 条入站」的压缩，20~30 分钟换一批，人一被换掉就断片；
//   调大窗口 = 拿 token 换不可靠。这里做的是档案：按 userId 跨群统一，谁在哪个群说过
//   多少、有过什么别名，长期保留；只有本轮消息真的提到人时才注入一小段（≤200 字符），
//   没提到就返回空串（0 字符、0 成本）。
//
// 隐私口径（用户已定 B 档）：可以说「在别的群见过、聊过什么话题、大概什么风格」；
// 不复述原话、不点现实信息、不给第三人好感度分数。所以本模块**从不读好感度分数**，
// 只按 userId 引用台账（affinityRef），印象也只读 memory_append 的真源。
import fs from 'node:fs';
import path from 'node:path';
import { relativeTimeLabel } from './relative-time.js';

export const PEOPLE_VERSION = 1;
export const PEOPLE_DEFAULTS = Object.freeze({
  maxPeople: 500,          // 档案人数上限（按 lastSeenAt 淘汰最旧）
  maxAliasesPerPerson: 5,  // 每人别名上限
  staleDays: 90,           // 90 天未出现：降权不删（不再召回，档案保留）
  maxChars: 200,           // 单轮注入字符上限
  nameMaxChars: 24,        // 别名长度上限
  maxTopics: 3,            // 每人保留几个话题要点（注入最多 2 个）
  rosterLimit: 3           // 名单模式最多几个名字
});

const SOURCE_PRIORITY = { card: 3, ledger: 2, sender: 1 };
const SOURCE_NAME = { card: 'card', ledger: 'ledger', sender: 'sender' };
// 「隔壁/别的群」类句式：没有命中任何别名时，用来决定要不要给一份「你在别处认识的人」名单。
const OTHER_GROUP_RE = /(隔壁|别的群|其他群|其它群|另一个群|你们群|那个群|别群|外群|别的群聊)/;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function emptyPeople() {
  return { version: PEOPLE_VERSION, updatedAt: 0, backfilledAt: 0, people: Object.create(null) };
}

/** 别名规范化：去 @、空白、控制字符，限长；不像人名的（纯数字 QQ、空）返回 ''。 */
export function normalizeName(raw) {
  let s = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  s = s.replace(/^@+/, '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (/^\d{4,}$/.test(s)) return ''; // 纯号码不是名字
  if (s.length > PEOPLE_DEFAULTS.nameMaxChars) s = s.slice(0, PEOPLE_DEFAULTS.nameMaxChars);
  return s;
}

function emptyPerson(userId, now) {
  return {
    userId: String(userId),
    aliases: [],
    groups: Object.create(null),
    firstSeenAt: Number(now) || 0,
    lastSeenAt: Number(now) || 0,
    msgCount: 0,
    // 人物级话题要点：{text, groupId, at}，text 是**归纳出来的关键词短语**（不是原话）。
    // 用户验收明确要求「认得出名字 + 说得出聊过什么」，所以这里必须有东西。
    recentTopics: [],
    // 内部聚合（跨消息重复出现才可能是话题）：phrase -> {count, lastAt, groupId}
    topicHits: Object.create(null),
    affinityRef: { file: 'state/affinity.json', userId: String(userId) }
  };
}

// 话题提取：不调模型、不存原话。先按虚词/人称把句子切成 2~6 字的词块（中文没有分词器，
// 用「停用字切分」近似），再挑长的、非口水话的词块当话题。这是「归纳成关键词短语」，
// 不是把原话截一段——回放时只出现「打包脚本」「入口目录」这种颗粒度。
const SPLIT_RE = /[的了是在和就也都个这那吗呢吧啊呀哦嘛我你他她它们只着过把被让给对从向跟与及并但而或所以如虽然后还再很太更最不没会有能要想说做用得到去来些每各其之于为等]/;
const BAD_START = /^(我|你|他|她|它|这|那|就|然后|但是|所以|因为|而且|如果|觉得|感觉|应该|可以|可能|现在|刚才|其实|就是|还是|不是|没有|一个|这个|那个|什么|怎么|为什么|真的|确实|有点|比较|非常|我们|你们|他们)/;
const JUNK_PHRASES = new Set(['哈哈哈', '哈哈', '笑死', '啊啊啊', '嗯嗯', '好的', '收到', '谢谢', '不知道', '没什么', '也可以', '有点', '好吧', '确实', '可以啊', '还行', '不错', '知道了', '明白了']);

/** 从一条消息里提取话题关键词（2~6 字词块，去人称/虚词/口水话）。 */
export function extractTopicPhrases(text) {
  const clean = String(text ?? '')
    .replace(/\[[^\]]{1,30}\]/g, ' ')       // [图片]/[表情] 这类占位符
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@\S+/g, ' ');
  const runs = clean.split(/[^\u4e00-\u9fa5A-Za-z0-9]+/).filter(Boolean);
  const out = [];
  for (const run of runs) {
    if (/^[A-Za-z0-9]+$/.test(run)) {
      if (run.length >= 3) out.push(run);
      continue;
    }
    for (const chunk of run.split(SPLIT_RE).filter(Boolean)) {
      if (/^[A-Za-z0-9]+$/.test(chunk)) {
        if (chunk.length >= 3) out.push(chunk);
        continue;
      }
      if (chunk.length < 2 || chunk.length > 6) continue;
      if (JUNK_PHRASES.has(chunk)) continue;
      if (BAD_START.test(chunk)) continue;
      out.push(chunk);
    }
  }
  // 长的优先，去掉被包含的碎片（「打包脚本」在时不要「脚本」）
  const uniq = [...new Set(out)].sort((a, b) => b.length - a.length);
  const picked = [];
  for (const g of uniq) {
    if (picked.some((p) => p.includes(g) || g.includes(p))) continue;
    picked.push(g);
    if (picked.length >= 6) break;
  }
  return picked;
}

/** 把一条发言归纳成话题要点，累进 person.recentTopics（最多 3 条）。 */
function recordTopics(person, { text, scope, at }) {
  const body = String(text ?? '').trim();
  // 太短的多半是「好」「哈哈哈哈」「到饭点了」这种口水话，不进话题池。
  if (body.length < 12) return false;
  const phrases = extractTopicPhrases(body);
  if (!phrases.length) return false;
  const stamp = num(at, Date.now());
  const weight = Math.min(200, body.length); // 长消息更可能承载话题
  let changed = false;
  for (const phrase of phrases) {
    const text40 = phrase.slice(0, 40);
    const prev = person.topicHits[text40];
    person.topicHits[text40] = {
      count: num(prev?.count, 0) + 1,
      weight: Math.max(num(prev?.weight, 0), weight),
      lastAt: stamp,
      groupId: scope ? String(scope).slice(0, 64) : null
    };
    changed = true;
  }
  // 只留最近的 30 个候选，避免一个人聊得久就无限膨胀
  const entries = Object.entries(person.topicHits).sort((a, b) => num(b[1].lastAt) - num(a[1].lastAt));
  if (entries.length > 30) {
    for (const [k] of entries.slice(30)) delete person.topicHits[k];
  }
  // 排序：重复次数 > 技术/工作类词（群里真正的话题多半是这些，别把「今天饭吃」当话题）
  //      > 出处消息长度 > 「像词」的程度（3~4 字最干净）> 长度 > 新旧。
  // 不按长度优先，是因为中文长块常是半截句子（「模块立刻露出」）。
  const wordScore = (t) => {
    const l = String(t).length;
    if (/^[A-Za-z0-9]+$/.test(t)) return 2;
    if (l >= 3 && l <= 4) return 3;
    if (l >= 5) return 2;
    return 1;
  };
  const TECH_RE = /(脚本|系统|文件|模块|目录|仓库|配置|日志|接口|数据|模型|测试|打包|部署|端口|命令|参数|代码|解压|验收|路径|版本|协议|工具|报错|问题|方案|功能|转存|归档|摘要|缓存|权限|字段|表格|任务|计划|服务|进程|内存|磁盘|网络|服务器|数据库|git|prompt|api|bug|json|sql)/i;
  const techScore = (t) => (TECH_RE.test(t) ? 1 : 0);
  const ranked = Object.entries(person.topicHits)
    .sort((a, b) => (num(b[1].count) - num(a[1].count))
      || (techScore(b[0]) - techScore(a[0]))
      || (num(b[1].weight) - num(a[1].weight))
      || (wordScore(b[0]) - wordScore(a[0]))
      || (b[0].length - a[0].length)
      || (num(b[1].lastAt) - num(a[1].lastAt)))
    .slice(0, PEOPLE_DEFAULTS.maxTopics)
    .map(([t, v]) => ({ text: t, groupId: v.groupId, at: v.lastAt }));
  person.recentTopics = ranked;
  return changed;
}

/** 读盘容错：坏 JSON/坏条目当空档案，绝不让聊天因为档案读不出来而挂。 */
export function normalizePeople(raw) {
  const out = emptyPeople();
  const src = raw && typeof raw === 'object' ? raw : {};
  out.updatedAt = num(src.updatedAt, 0);
  out.backfilledAt = num(src.backfilledAt, 0);
  const rows = src.people && typeof src.people === 'object' && !Array.isArray(src.people) ? src.people : {};
  for (const [uid, p] of Object.entries(rows)) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const id = String(p.userId ?? uid ?? '').trim();
    if (!id) continue;
    const person = emptyPerson(id, num(p.firstSeenAt, num(p.lastSeenAt, 0)));
    person.firstSeenAt = num(p.firstSeenAt, 0);
    person.lastSeenAt = num(p.lastSeenAt, 0);
    person.msgCount = Math.max(0, Math.round(num(p.msgCount, 0)));
    person.affinityRef = { file: 'state/affinity.json', userId: id };
    const aliases = Array.isArray(p.aliases) ? p.aliases : [];
    const seen = new Set();
    for (const a of aliases) {
      const name = normalizeName(a?.name);
      if (!name) continue;
      const low = name.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      person.aliases.push({
        name,
        source: SOURCE_NAME[a?.source] || 'sender',
        scope: a?.scope ? String(a.scope).slice(0, 64) : null,
        lastSeenAt: num(a?.lastSeenAt, person.lastSeenAt)
      });
    }
    person.aliases = person.aliases.slice(0, PEOPLE_DEFAULTS.maxAliasesPerPerson);
    const groups = p.groups && typeof p.groups === 'object' && !Array.isArray(p.groups) ? p.groups : {};
    for (const [scope, g] of Object.entries(groups)) {
      if (!g || typeof g !== 'object') continue;
      person.groups[String(scope).slice(0, 64)] = {
        count: Math.max(0, Math.round(num(g.count, 0))),
        first: num(g.first, 0),
        last: num(g.last, 0)
      };
    }
    // 话题要点：只认 {text, groupId, at}；每条是关键词短语（不是原话），最多 3 条。
    const topics = Array.isArray(p.recentTopics) ? p.recentTopics : [];
    const topicSeen = new Set();
    for (const t of topics) {
      const text = String(t?.text ?? '').trim().slice(0, 40);
      if (!text || topicSeen.has(text)) continue;
      topicSeen.add(text);
      person.recentTopics.push({ text, groupId: t?.groupId ? String(t.groupId).slice(0, 64) : null, at: num(t?.at, 0) });
    }
    person.recentTopics = person.recentTopics.slice(0, PEOPLE_DEFAULTS.maxTopics);
    const hits = p.topicHits && typeof p.topicHits === 'object' && !Array.isArray(p.topicHits) ? p.topicHits : {};
    for (const [phrase, v] of Object.entries(hits)) {
      if (!phrase || typeof v !== 'object') continue;
      person.topicHits[String(phrase).slice(0, 40)] = {
        count: Math.max(0, Math.round(num(v.count, 0))),
        lastAt: num(v.lastAt, 0),
        groupId: v.groupId ? String(v.groupId).slice(0, 64) : null
      };
    }
    out.people[id] = person;
  }
  return out;
}

export function loadPeople(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return emptyPeople();
    return emptyPeople();
  }
  try { return normalizePeople(JSON.parse(text)); }
  catch { return emptyPeople(); }
}

/** 原子写：同目录 tmp + fsync + rename；失败只抛给调用方打日志，不半截落盘。 */
export function savePeople(file, store) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({ ...store, updatedAt: Date.now() }, null, 0);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeFileSync(fd, body, 'utf8');
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    return Buffer.byteLength(body, 'utf8');
  } catch (error) {
    try { if (fd !== null) fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function bumpAlias(person, { name, source, scope, at }) {
  const clean = normalizeName(name);
  if (!clean) return false;
  const low = clean.toLowerCase();
  const hit = person.aliases.find((a) => a.name.toLowerCase() === low);
  if (hit) {
    hit.lastSeenAt = Math.max(num(hit.lastSeenAt, 0), num(at, 0));
    if ((SOURCE_PRIORITY[source] || 0) > (SOURCE_PRIORITY[hit.source] || 0)) hit.source = source;
    if (scope) hit.scope = String(scope);
    return false;
  }
  person.aliases.push({ name: clean, source: SOURCE_NAME[source] || 'sender', scope: scope ? String(scope) : null, lastSeenAt: num(at, 0) });
  // 超出上限时保留「来源更可信、见得更近」的
  person.aliases.sort((a, b) => (SOURCE_PRIORITY[b.source] || 0) - (SOURCE_PRIORITY[a.source] || 0)
    || num(b.lastSeenAt) - num(a.lastSeenAt));
  person.aliases = person.aliases.slice(0, PEOPLE_DEFAULTS.maxAliasesPerPerson);
  return true;
}

/**
 * 记一次「见到这个人」。
 * @param {object} store people store（就地修改）
 * @param {object} args
 * @param {string} args.userId 必填；空/纯空格的记录跳过
 * @param {string} [args.name] 这次的显示名（群名片/台账/sender）
 * @param {'card'|'ledger'|'sender'} [args.source]
 * @param {string|null} [args.scope] 出现位置（group:xxx / private:xxx）；台账补名字时传 null
 * @param {number} [args.at]
 * @param {boolean} [args.count] 是否累加次数（回填已知人物时传 false，避免每次重启重复计数）
 * @param {string} [args.text] 这条发言原文：只用来**归纳**话题关键词，不落盘原文
 * @returns {{added:boolean, aliasAdded:boolean, person:object|null}}
 */
export function noteSighting(store, { userId, name, source = 'sender', scope = null, at = Date.now(), count = true, cfg, text = '' } = {}) {
  const id = String(userId ?? '').trim();
  if (!store || typeof store !== 'object' || !id) return { added: false, aliasAdded: false, person: null };
  if (!store.people || typeof store.people !== 'object') store.people = Object.create(null);
  const stamp = num(at, Date.now());
  let person = store.people[id];
  const added = !person;
  if (!person) person = store.people[id] = emptyPerson(id, stamp);
  person.lastSeenAt = Math.max(num(person.lastSeenAt, 0), stamp);
  if (!person.firstSeenAt) person.firstSeenAt = stamp;
  if (count) {
    person.msgCount = Math.max(0, num(person.msgCount, 0)) + 1;
    if (scope) {
      const key = String(scope).slice(0, 64);
      const g = person.groups[key] || { count: 0, first: stamp, last: 0 };
      g.count += 1;
      g.first = g.first || stamp;
      g.last = Math.max(num(g.last, 0), stamp);
      person.groups[key] = g;
    }
  }
  const aliasAdded = bumpAlias(person, { name, source, scope, at: stamp });
  // 话题要点：从这条发言里归纳短语（不是原话）；回填已知人物时也会补，所以历史也能说得出聊过什么。
  if (String(text || '').trim()) recordTopics(person, { text, scope, at: stamp });
  // 人数上限：按 lastSeenAt 淘汰最旧（档案是缓存，不是账本；淘汰不影响聊天）
  const cap = Math.max(1, Math.round(num(cfg?.maxPeople, PEOPLE_DEFAULTS.maxPeople)));
  const ids = Object.keys(store.people);
  if (ids.length > cap) {
    ids.sort((a, b) => num(store.people[a]?.lastSeenAt) - num(store.people[b]?.lastSeenAt));
    for (const old of ids.slice(0, ids.length - cap)) delete store.people[old];
  }
  return { added, aliasAdded, person: store.people[id] || null };
}

/** 展示名：最近见过的别名里、来源最可信的那个。 */
export function pickDisplayName(person) {
  let best = '';
  let bestScore = -1;
  for (const a of person?.aliases || []) {
    const score = (SOURCE_PRIORITY[a.source] || 0) * 1e13 + num(a.lastSeenAt);
    if (score > bestScore) { bestScore = score; best = a.name; }
  }
  return best;
}

/** 90 天未出现 = 降权（不召回）；数据仍留在档案里。 */
function isStale(person, now, staleMs) {
  const last = num(person?.lastSeenAt, 0);
  return !last || now - last > staleMs;
}

function sanitizeTrait(raw) {
  let s = String(raw ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!s) return '';
  // 印象里若混进了分数/好感度字样，一律不进注入（隐私挡位）。
  if (/好感度|\/\s*100\b/.test(s)) return '';
  if (s.length > 24) s = `${s.slice(0, 23)}…`;
  return s;
}

function clampText(text, maxChars) {
  const limit = Math.max(20, Math.round(num(maxChars, PEOPLE_DEFAULTS.maxChars)));
  const chars = [...String(text ?? '')];
  if (chars.length <= limit) return chars.join('');
  return `${chars.slice(0, limit - 1).join('')}…`;
}

function betterHit(a, b) {
  if (!a) return b;
  if (b.exact !== a.exact) return b.exact ? b : a;
  if (b.matched.length !== a.matched.length) return b.matched.length > a.matched.length ? b : a;
  return num(b.person?.lastSeenAt) > num(a.person?.lastSeenAt) ? b : a;
}

/**
 * 找本轮消息里提到的人。
 * 命中规则：
 *   ① 完整别名出现在文本里（≥2 字）；
 *   ② 别名 ≥5 字时，允许「≥3 字后缀」命中（「聪明头哦鲸鲸」→「哦鲸鲸」这种昵称截断）。
 * 都不中 → 空数组（调用方就一个字都不注入，允许她说「不认识」）。
 */
function matchPeople(store, text, { now, staleMs } = {}) {
  const hits = [];
  for (const person of Object.values(store?.people || {})) {
    if (!person || !person.userId || isStale(person, now, staleMs)) continue;
    let best = null;
    for (const a of person.aliases || []) {
      const name = String(a?.name || '');
      if (name.length >= 2 && text.includes(name)) {
        best = betterHit(best, { person, alias: a, matched: name, exact: true });
        continue;
      }
      if (name.length >= 5) {
        for (const len of [4, 3]) {
          const suffix = name.slice(-len);
          if (suffix.length >= 3 && text.includes(suffix)) {
            best = betterHit(best, { person, alias: a, matched: suffix, exact: false });
            break;
          }
        }
      }
    }
    if (best) hits.push(best);
  }
  return hits;
}

function whereText(person, scope) {
  const here = Boolean(scope && person?.groups?.[scope]?.count);
  const other = Object.keys(person?.groups || {}).some((k) => k !== scope && num(person.groups[k]?.count) > 0);
  if (here && other) return { text: '这个群和别的群', multi: true };
  if (here) return { text: '这个群', multi: false };
  return { text: '别的群', multi: true };
}

function buildHitSegment(person, { scope, impressionFor, topicLimit = 2, withImpression = true, blockedTerms = null, now = Date.now() }) {
  const display = pickDisplayName(person) || String(person.userId);
  const where = whereText(person, scope);
  const count = Math.max(0, Math.round(num(person.msgCount, 0)));
  // 先名字与次数，再话题（用户验收口径：认得出名字 + 说得出聊过什么）。
  // D48：每条话题带**相对时间**（她当时说的那一刻），跨群的话题再标「另一个群」；没时间就如实写时间不详。
  const topics = (Array.isArray(person.recentTopics) ? person.recentTopics : [])
    .filter((t) => t && String(t.text || '').trim())
    // 话题里如果混进了第三个人的名字，就不说（不跨群点名第三人）。
    .filter((t) => {
      const body = String(t.text || '').trim();
      return !(blockedTerms && blockedTerms.some((n) => n && (body === n || body.includes(n))));
    })
    .slice(0, Math.max(0, topicLimit))
    .map((t) => {
      const when = relativeTimeLabel(t.at, now);
      const otherGroup = Boolean(t.groupId && scope && t.groupId !== scope);
      const marks = [when || '时间不详', otherGroup ? '另一个群' : ''].filter(Boolean).join('·');
      return `${String(t.text).trim()}（${marks}）`;
    });
  let text = `${display}在${where.text}出现过 ${count} 次`;
  if (topics.length) text += `，聊过：${topics.join('、')}`;
  if (withImpression) {
    let traits = [];
    try { traits = (impressionFor?.(person.aliases.map((a) => a.name)) || []).map(sanitizeTrait).filter(Boolean); } catch {}
    const uniq = [...new Set(traits)].slice(0, 2);
    if (uniq.length) text += `。印象：${uniq.join('、')}`;
  }
  return text;
}

/**
 * 组装召回文本。没命中返回 ''（调用方据此做到 0 字符注入）。
 * @returns {{text:string, hits:number, mode:'hit'|'ambiguous'|'roster'|'none', names:string[]}}
 */
export function recallPeople(store, { text, scope = null, now = Date.now(), impressionFor, maxChars = PEOPLE_DEFAULTS.maxChars, staleDays = PEOPLE_DEFAULTS.staleDays, rosterLimit = PEOPLE_DEFAULTS.rosterLimit } = {}) {
  const body = String(text ?? '');
  const staleMs = Math.max(1, num(staleDays, PEOPLE_DEFAULTS.staleDays)) * 86400000;
  if (!body.trim()) return { text: '', hits: 0, mode: 'none', names: [] };
  const hits = matchPeople(store, body, { now, staleMs });
  if (hits.length) {
    // 同名不同人：同一个字符串对上两个不同 userId → 不硬认（避免把两个人混成一个）。
    const byMatched = new Map();
    for (const h of hits.filter((x) => x.exact)) {
      const list = byMatched.get(h.matched) || [];
      if (!list.some((x) => x.person.userId === h.person.userId)) list.push(h);
      byMatched.set(h.matched, list);
    }
    for (const [matched, list] of byMatched) {
      if (list.length > 1) {
        return {
          text: clampText(`【认人】「${matched}」对得上两个不同的人，我分不清你问的是哪个。别硬认，先问清是哪个群的。`, maxChars),
          hits: list.length, mode: 'ambiguous', names: list.map((x) => pickDisplayName(x.person))
        };
      }
    }
    // 精确命中优先，最多两人；两个人时后半段可能被预算截断，口径句放最后统一给。
    const chosen = [];
    const sorted = [...hits].sort((a, b) => (b.exact - a.exact) || (b.matched.length - a.matched.length));
    for (const h of sorted) {
      if (chosen.length >= 2) break;
      if (chosen.some((x) => x.person.userId === h.person.userId)) continue;
      chosen.push(h);
    }
    // 口径句跟着「是不是别的群的人」走：只在本群出现过的人，不要教她说「我在别的群见过」。
    const crossGroup = chosen.some((h) => whereText(h.person, scope).multi);
    const clause = crossGroup
      ? '。口径：可以说在别的群见过、聊过什么；时间是标注好的，别自己推断，没标就说记不清、别当刚发生；问多久以前只答能确认的粒度；不复述原话、不给第三人评分。'
      : '。口径：只说这个群里聊过的；时间是标注好的，没标就说记不清；不复述原话。';
    // 第三个人的别名不进话题（「小明说打包脚本要改」不能变成点名小明）；本人的别名不算。
    const chosenIds = new Set(chosen.map((h) => h.person.userId));
    const blockedTerms = [];
    for (const p of Object.values(store?.people || {})) {
      if (!p || !p.userId || chosenIds.has(p.userId)) continue;
      for (const a of p.aliases || []) if (a?.name && a.name.length >= 2) blockedTerms.push(a.name);
    }
    const compose = (topicLimit, withImpression, withClause = true) => `【认人】${chosen
      .map((h) => buildHitSegment(h.person, { scope, impressionFor, topicLimit, withImpression, blockedTerms, now }))
      .join('；')}${withClause ? clause : ''}`;
    // 预算不够时的降级顺序：砍印象 → 砍第二个话题 → 砍口径句（名字+1 话题是硬要求）→ 再砍话题。
    // 名字和次数永远保留；口径句可以丢，但「名字 + 至少 1 个话题」不能丢。
    let out = compose(2, true);
    if ([...out].length > maxChars) out = compose(1, true);
    if ([...out].length > maxChars) out = compose(1, false);
    if ([...out].length > maxChars) out = compose(1, false, false);
    if ([...out].length > maxChars) out = compose(0, false, false);
    return {
      text: clampText(out, maxChars),
      hits: chosen.length, mode: 'hit', names: chosen.map((h) => pickDisplayName(h.person))
    };
  }
  // 没命中具体人：只有问法里出现「隔壁/别的群」时，才给一份「你在别处认识的人」名单；
  // 问一个从没出现过的名字 → 返回空串，允许她说「不认识」，绝不硬编。
  if (!OTHER_GROUP_RE.test(body)) return { text: '', hits: 0, mode: 'none', names: [] };
  const roster = Object.values(store?.people || {})
    .filter((p) => p && p.userId && !isStale(p, now, staleMs))
    .filter((p) => Object.keys(p.groups || {}).some((k) => k !== scope && num(p.groups[k]?.count) > 0))
    .sort((a, b) => num(b.lastSeenAt) - num(a.lastSeenAt))
    .map((p) => pickDisplayName(p))
    .filter(Boolean)
    .slice(0, Math.max(1, Math.round(num(rosterLimit, PEOPLE_DEFAULTS.rosterLimit))));
  if (!roster.length) return { text: '', hits: 0, mode: 'none', names: [] };
  return {
    text: clampText(`【认人】你在别处认识的人（只认得出这些）：${roster.join('、')}。别的一概说不认识。`, maxChars),
    hits: 0, mode: 'roster', names: roster
  };
}

/** 只读统计（控制台/自测用）。 */
export function peopleStats(store, now = Date.now()) {
  const staleMs = PEOPLE_DEFAULTS.staleDays * 86400000;
  const people = Object.values(store?.people || {});
  return {
    people: people.length,
    aliases: people.reduce((n, p) => n + (Array.isArray(p.aliases) ? p.aliases.length : 0), 0),
    fresh: people.filter((p) => !isStale(p, now, staleMs)).length,
    updatedAt: num(store?.updatedAt, 0)
  };
}
