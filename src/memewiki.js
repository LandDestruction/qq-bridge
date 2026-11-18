// 本地梗百科（memewiki）：6668 条网络梗/黑话，来自 github.com/thawline/dsh-memewiki
// （MIT；词库版权归原作者与 cnmeme.wiki，仅本地只读查询、不联网）。
//
// 为什么自己做一层而不是装 DSH 插件：我们的机器人可能跑 DSH，也可能跑 openai/http 后端，
// 把词库做成桥接侧的只读查询，任何后端都能用；也不会因为 DSH 插件升级/重启把桥接带下去。
import fs from 'node:fs';
import path from 'node:path';

const cache = new Map(); // file -> { db, error }

function dbFile(explicit) {
  return explicit || process.env.MEMEWIKI_DB || path.join(process.cwd(), 'data', 'memewiki.db');
}

/** 懒加载只读库；文件不在就返回 null（功能降级，不抛）。 */
export function openMemewiki(file) {
  const target = dbFile(file);
  if (cache.has(target)) return cache.get(target).db;
  const slot = { db: null, error: '' };
  try {
    if (!fs.existsSync(target)) slot.error = `找不到词库：${target}`;
    else {
      const { DatabaseSync } = process.getBuiltinModule
        ? process.getBuiltinModule('node:sqlite')
        : require('node:sqlite');
      slot.db = new DatabaseSync(target, { readOnly: true });
    }
  } catch (error) {
    slot.error = String(error?.message ?? error);
  }
  cache.set(target, slot);
  return slot.db;
}

export function memewikiStatus(file) {
  const d = openMemewiki(file);
  const err = cache.get(dbFile(file))?.error || '词库未加载';
  if (!d) return { ok: false, error: err };
  try {
    const row = d.prepare('select count(*) as c from memes').get();
    return { ok: true, entries: Number(row?.c) || 0, file: dbFile(file) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 把用户那句话洗成查询词：去 @、去标点、去「是什么梗」这类尾巴。 */
export function normalizeMemeQuery(input) {
  let s = String(input ?? '').trim();
  s = s.replace(/\[CQ:[^\]]+\]/g, ' ').replace(/@\S+/g, ' ');
  s = s.replace(/[，。！？!?、；;：:（）()【】\[\]「」“”"'‘’~～…]/g, ' ');
  s = s.replace(/(这是|是)?(什么|啥)(梗|意思|含义|东西)?(啊|呀|吗|呢)?$/g, ' ');
  s = s.replace(/(出自|来自|来源)(哪里|哪儿|哪|何处)?/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 24);
}

/** 像不像在问梗/黑话（宁可漏，不硬塞）。 */
export function looksLikeMemeQuestion(text) {
  const s = String(text ?? '');
  if (!s.trim()) return false;
  if (/是什么梗|什么梗|啥梗|什么梗啊|梗是什么意思|什么意思啊?$|是什么梗啊|这个梗|梗的来源|什么来历|出自哪|哪来的梗|怎么用这个梗|什么黑话|这是啥意思/.test(s)) return true;
  // 「XX 是什么意思」「XX 什么梗」：短词 + 问句
  if (/^[\u4e00-\u9fa5A-Za-z0-9_·\s]{2,12}(是什么|是啥|什么意思|什么梗|啥梗)/.test(s)) return true;
  return false;
}

function cleanLike(s) {
  // 只用来拼 LIKE：把通配符换成空格，省掉 ESCAPE 子句（少一层转义踩坑）。
  return String(s).replace(/[%_]/g, ' ');
}

/**
 * 查词条：先精确标题，再「标题包含查询词」，最后「查询词包含标题」（≥3 字才试，避免两个字乱中）。
 * @returns {{title:string, summary:string, usage:string, origin:string, tags:string}|null}
 */
export function lookupMeme(query, opts = {}) {
  const d = openMemewiki(opts.file);
  if (!d) return null;
  const q = normalizeMemeQuery(query);
  if (!q) return null;
  const cols = 'title, summary, usage, origin, tags';
  try {
    const exact = d.prepare(`select ${cols} from memes where title = ? limit 1`).get(q);
    if (exact) return exact;
    const like = d.prepare(`select ${cols} from memes where title like ? order by length(title) asc limit 1`)
      .get(`%${cleanLike(q)}%`);
    if (like) return like;
    // 长句（「我想知道心机绿茶的梗」）没整体命中：切 4~6 字的片段再匹一次。
    if (q.length >= 4) {
      const n = q.length;
      for (let len = Math.min(6, n - 1); len >= 4; len -= 1) {
        for (let i = 0; i + len <= n; i += 1) {
          const piece = q.slice(i, i + len);
          const hit = d.prepare(`select ${cols} from memes where title like ? order by length(title) asc limit 1`)
            .get(`%${cleanLike(piece)}%`);
          if (hit) return hit;
        }
      }
    }
  } catch { /* 查库失败当没查到 */ }
  return null;
}

/** 压成一段给模型看的短文本（释义/怎么用都截断，避免把整段百科塞进上下文）。 */
export function formatMemeEntry(entry, opts = {}) {
  if (!entry) return '';
  const cut = (s, n) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  const parts = [`【梗百科】${entry.title}`];
  if (entry.summary) parts.push(`释义：${cut(entry.summary, opts.maxSummary ?? 220)}`);
  if (entry.usage) parts.push(`怎么用：${cut(entry.usage, opts.maxUsage ?? 160)}`);
  if (entry.origin) parts.push(`出处：${cut(entry.origin, 80)}`);
  if (entry.tags) parts.push(`标签：${cut(entry.tags, 60)}`);
  return parts.join('\n');
}

/**
 * 预查（A 方案）：从「最新一条非自己的消息」判断是不是在问梗，命中就返回一段可直接注入的提示。
 * 放在桥接侧算，好处是任何后端都生效、且不依赖模型主动调工具。
 * @param {Array} messages 未读/最近消息（新→旧或旧→新都行，内部按 time/seq 取最新）
 * @param {string|number} selfId 自己的 QQ（用于排除自己的发言）
 */
export function prelookupLine(messages, selfId) {
  const list = Array.isArray(messages) ? messages.filter((m) => m && !m.isSelf) : [];
  if (!list.length) return '';
  const timeOf = (m) => Number(m.time || m.timestamp || m.seq || 0);
  const newest = list.reduce((a, b) => (timeOf(b) >= timeOf(a) ? b : a), list[0]);
  if (selfId && String(newest.userId || newest.user_id || '') === String(selfId)) return '';
  const text = String(newest.text || newest.content || newest.message || '').trim();
  if (!text || !looksLikeMemeQuestion(text)) return '';
  const q = normalizeMemeQuery(text);
  const entry = q ? lookupMeme(q) : null;
  const atMost = (s, n) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  if (entry) {
    const bits = [`【梗百科·命中】有人问了「${q}」`, `词条：${entry.title}`];
    if (entry.summary) bits.push(`释义：${atMost(entry.summary, 180)}`);
    if (entry.usage) bits.push(`怎么接：${atMost(entry.usage, 120)}`);
    bits.push('这条算问梗：按词条自然接一句，别把释义原文背出来；跟语境对不上就当没查到，别硬套。');
    return bits.join('\n') + String.fromCharCode(10, 10);
  }
  return `【梗百科】有人问了「${q}」，本地 6668 条词库没查到。不要编解释，直说“这个我不知道/你解释一下”，或按字面接一句。` + String.fromCharCode(10, 10);
}
