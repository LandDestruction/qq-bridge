// 梗百科 → 黑话库导入规则（纯函数，便于单测与 CLI 复用）。
// 目标：把 data/memewiki.db 里的 6668 条梗，按「黑话」的形状落进 state/slang.json，
// 状态一律 confirmed（用户 2026-11-02 明确要求），但**可玩性**分开：
//   - 短标题、无风险词 → usagePolicy='usable'（能在合适场合用）
//   - 长标题/带敏感词  → usagePolicy='understand-only'（只听得懂）
// count 一律 0，避免把注入用的 top-N 名额挤掉群内真实高频词。

export const MEMEWIKI_RULES_VERSION = 1;
export const MAX_CONTENT_CHARS = 16;
export const MAX_MEANING_CHARS = 240;
export const MAX_USAGE_CHARS = 180;

const RISK_RE = /政治|色情|涉黄|辱骂|攻击|歧视|违法|犯罪|封号|低俗|恶心|血腥|自杀|死亡|毒品|赌博|地域黑|性别对立/;

function text(value, max) {
  const s = String(value === undefined || value === null ? '' : value).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + '…' : s;
}

function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0').slice(0, 7);
}

export function memewikiSlangPolicy(entry) {
  const content = String(entry && entry.content || '').trim();
  const risk = RISK_RE.test(String(entry && entry.risk || ''));
  if (risk) return { usagePolicy: 'understand-only', reason: '带风险词' };
  if (content.length < 2) return { usagePolicy: 'understand-only', reason: '太短' };
  if (content.length > 8) return { usagePolicy: 'understand-only', reason: '标题偏长' };
  return { usagePolicy: 'usable', reason: '短标题且无风险' };
}

/** 单条 memewiki 行 → 黑话条目；不合法返回 null。 */
export function memewikiRowToSlangEntry(row, nowIso) {
  const title = text(row && row.title, MAX_CONTENT_CHARS);
  const slug = String(row && row.slug || title || '').trim();
  if (!title || title.length < 2) return null;
  const meaning = text(row && (row.summary || row.origin || ''), MAX_MEANING_CHARS);
  if (!meaning || meaning.length < 4) return null;
  const usage = text(row && row.usage, MAX_USAGE_CHARS);
  const policy = memewikiSlangPolicy({ content: title, risk: (row && row.tags) || '' });
  const tags = text(row && row.tags, 120);
  return {
    id: 'mw-' + shortHash(slug),
    content: title,
    meaning,
    usage,
    example: '',
    risk: policy.usagePolicy === 'usable' ? '' : policy.reason,
    sources: tags ? [tags] : [],
    status: 'confirmed',
    source: 'memewiki',
    basis: 'memewiki:' + slug.slice(0, 40),
    usagePolicy: policy.usagePolicy,
    count: 0,
    evidence: [],
    lastInferenceCount: 0,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

/**
 * 批量转换。
 * @param {Array} rows memewiki 行（title/slug/summary/origin/usage/tags）
 * @param {Object} opts {existing: 已有黑话数组或内容集合, nowIso, limit}
 * @returns {{entries: Array, skipped: {duplicate:number,invalid:number,overLimit:number}, stats: Object}}
 */
export function buildMemewikiSlangEntries(rows, opts = {}) {
  const nowIso = opts.nowIso || new Date().toISOString();
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : Infinity;
  const existing = new Set();
  for (const e of (opts.existing || [])) {
    const c = typeof e === 'string' ? e : (e && e.content);
    if (c) existing.add(String(c));
  }
  const entries = [];
  const seen = new Set();
  const skipped = { duplicate: 0, invalid: 0, overLimit: 0 };
  for (const row of rows || []) {
    if (entries.length >= limit) { skipped.overLimit += 1; continue; }
    const entry = memewikiRowToSlangEntry(row, nowIso);
    if (!entry) { skipped.invalid += 1; continue; }
    if (existing.has(entry.content) || seen.has(entry.content)) { skipped.duplicate += 1; continue; }
    seen.add(entry.content);
    entries.push(entry);
  }
  const stats = {
    total: entries.length,
    usable: entries.filter((e) => e.usagePolicy === 'usable').length,
    understandOnly: entries.filter((e) => e.usagePolicy !== 'usable').length
  };
  return { entries, skipped, stats };
}

export function describeImportResult(result) {
  const s = result && result.stats ? result.stats : { total: 0, usable: 0, understandOnly: 0 };
  const k = (result && result.skipped) || { duplicate: 0, invalid: 0 };
  return '导入了 ' + s.total + ' 条（可玩 ' + s.usable + ' / 只听 ' + s.understandOnly + '），'
    + '跳过重复 ' + (k.duplicate || 0) + '、无效 ' + (k.invalid || 0);
}
