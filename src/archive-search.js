// 归档检索的纯逻辑（B 组）：把 state/archive/<key>.jsonl 里的记录按关键词打分排序。
//
// 为什么单独成文件：归档的读写在 bridge.js 里跟 fs、日志、配置绑在一起，
// 但真正容易出错的是「打分」和「坏行容忍」——空查询、单字查询、JSON 半行、
// 同分时的时间倒序。抽成纯函数后 `scripts/test-archive.mjs` 可以逐条覆盖。
//
// 算法：中文没有空格分词，用 2 字滑窗（shingles）当特征——
// 查询里每个 2 字片段在消息文本中出现就 +1 分；同分按时间倒序（新的在前）。

/** 查询的 2 字滑窗集合。单字查询没有滑窗，返回空集合（= 不匹配任何记录）。 */
export function queryShingles(query) {
  const q = String(query ?? '').trim();
  const set = new Set();
  for (let i = 0; i < q.length - 1; i += 1) set.add(q.slice(i, i + 2));
  return set;
}

/** 解析 jsonl 文本：跳过空行与坏行（写入过程中被截断的半行很常见）。 */
export function parseArchiveLines(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object') out.push(rec);
    } catch {
      // 坏行直接丢弃：一行损坏不该让整次检索失败
    }
  }
  return out;
}

/**
 * 按关键词检索归档记录。
 * @param {Array<object>} records 已解析的记录（含 text / t）
 * @param {string} query 关键词
 * @param {number} [limit] 最多返回条数
 */
export function searchArchive(records, query, limit = 12) {
  const shingles = queryShingles(query);
  if (!shingles.size) return [];
  const scored = [];
  for (const rec of Array.isArray(records) ? records : []) {
    const text = String(rec?.text ?? '');
    if (!text) continue;
    let score = 0;
    for (const s of shingles) if (text.includes(s)) score += 1;
    if (score > 0) scored.push({ rec, score });
  }
  scored.sort((a, b) => (b.score - a.score) || ((Number(b.rec?.t) || 0) - (Number(a.rec?.t) || 0)));
  return scored.slice(0, Math.max(1, Number(limit) || 12)).map((item) => item.rec);
}
