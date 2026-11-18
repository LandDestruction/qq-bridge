// 归因守卫（纯函数，零 import）：发消息前粗查「这句话真是这个人说的吗」。
//
// 背景（2026-11-02）：重建的闲聊群里 友人A(596623226) 说「这鱼一直一股茶味」，
// 机器人后来把这句安到了 依(841132906) 头上（「依，不是嫌我有茶味吗」）。上下文里每条
// 消息本来就带 sender，错在「引用时对错人」。提示词加了纪律（attributionDisciplineTextV2），
// 这里再加一道发送前兜底：只记警告、不改写，避免误伤正常表达。

/** 会引出「某人说过/觉得」的动词，长的放前面。 */
export const ATTRIBUTION_VERBS = ['吐槽', '评价', '觉得', '表示', '承认', '质疑', '夸', '骂', '嫌', '说', '讲'];

/** 这些不是人名（代词/泛称）。 */
export const NOT_NAMES = new Set(['我', '你', '他', '她', '它', '我们', '你们', '他们', '她们', '大家', '有人', '群里', '别人', '自己', '这', '那', '谁']);

/** 名字里出现这些字，基本是虚词拼出来的（不是、就是、她没），不算人名。 */
const VIRTUAL_CHARS = new Set('不没别就还又也都真才可总只但于要会能想敢爱在是我你他她它'.split(''));

const STOP_CHARS = new Set('我你他她它们的了吗吧啊呢呀嘛呗这那是不有就都也很和在一要会能说嫌个么把被给对又还再'.split(''));

function looksLikeName(name) {
  const s = String(name || '');
  if (s.length < 1) return false;
  if (NOT_NAMES.has(s)) return false;
  if (/们$|人$/.test(s)) return false;
  if ([...s].some((ch) => VIRTUAL_CHARS.has(ch))) return false;
  if (s.length === 1 && ATTRIBUTION_VERBS.includes(s)) return false;
  return true;
}

/** 从一段话里抽出「某人在评价什么」的断言；`依，不是嫌我…` 这种用句中称呼兜底。 */
export function extractClaims(text) {
  const s = String(text ?? '');
  const verbs = ATTRIBUTION_VERBS.join('|');
  const named = new RegExp(`([\u4e00-\u9fa5A-Za-z0-9_·]{1,10}?)\s*(${verbs})`, 'g');
  const out = [];
  let m;
  while ((m = named.exec(s)) !== null) {
    const name = m[1];
    if (!looksLikeName(name)) continue;
    out.push({ name, verb: m[2], context: s.slice(named.lastIndex, named.lastIndex + 8), at: m.index, via: 'named' });
  }
  // 句中称呼：`依，不是嫌我有茶味吗` → 把这段话里的评价算在「依」头上（正是这次 bug 的形态）。
  const segments = s.split(/[。！？!?\n]/).filter(Boolean);
  let base = 0;
  for (const seg of segments) {
    const voc = seg.match(/^\s*([\u4e00-\u9fa5A-Za-z0-9_·]{1,10})\s*[，,、:：]/);
    if (voc && looksLikeName(voc[1])) {
      const rest = seg.slice(voc[0].length);
      const v = rest.match(new RegExp(`(${verbs})`));
      if (v) {
        const at = base + voc[0].length + v.index + v[0].length;
        out.push({ name: voc[1], verb: v[1], context: s.slice(at, at + 8), at: base + v.index, via: 'vocative' });
      }
    }
    base += seg.length + 1;
  }
  // 同一 (名字, 动词) 只留第一条，避免重复计数
  const seen = new Set();
  return out.filter((c) => {
    const k = c.name + '|' + c.verb;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 把断言后面 8 个字切成候选关键词（二元组/三元组，去虚词）。 */
export function keywordsOf(context, max = 12) {
  const s = String(context ?? '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const keys = new Set();
  for (let i = 0; i + 2 <= s.length && keys.size < max; i += 1) {
    const two = s.slice(i, i + 2);
    if (![...two].some((ch) => STOP_CHARS.has(ch))) keys.add(two);
    const three = s.slice(i, i + 3);
    if (three.length === 3 && ![...three].some((ch) => STOP_CHARS.has(ch))) keys.add(three);
  }
  return [...keys];
}

/**
 * @param {string} text 待发消息
 * @param {{sender?:string,text?:string}[]} messages 最近消息
 * @param {{selfName?:string, window?:number}} opts
 */
export function checkAttribution(text, messages, opts = {}) {
  const selfName = String(opts.selfName ?? '').trim();
  const window = Number(opts.window) > 0 ? Number(opts.window) : 120;
  const recent = (Array.isArray(messages) ? messages : []).slice(-window);
  // 上下文太少时判不准（刚启动/刚清屏），直接放行，避免满屏假警告。
  if (recent.length < 3) return { ok: true, claims: 0, suspects: [] };
  const saidBy = new Map();
  for (const m of recent) {
    const sender = String(m?.sender ?? '').trim();
    if (!sender) continue;
    saidBy.set(sender, (saidBy.get(sender) || '') + ' ' + String(m?.text ?? ''));
  }
  const claims = extractClaims(text).filter((c) => !(selfName && c.name === selfName));
  const suspects = [];
  for (const c of claims) {
    const said = saidBy.get(c.name);
    if (said === undefined) { suspects.push({ ...c, reason: 'unknown-speaker' }); continue; }
    const keys = keywordsOf(c.context);
    if (keys.length === 0) continue;
    if (keys.some((k) => said.includes(k))) continue;
    suspects.push({ ...c, reason: 'no-evidence' });
  }
  return { ok: suspects.length === 0, claims: claims.length, suspects };
}

/** 日志用摘要。 */
export function describeSuspects(suspects) {
  return (Array.isArray(suspects) ? suspects : [])
    .map((s) => `${s.name}${s.verb}（${s.reason}：${String(s.context || '').slice(0, 8)}）`)
    .join('；');
}
