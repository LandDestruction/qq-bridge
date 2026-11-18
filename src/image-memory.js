// 本地「画面记忆」：把看懂过的图按 dhash 存下来，下次同一张图直接查表，不用再走模型识图。
//
// 为什么值得：群里表情包/梗图高度重复，一张图第一次要 5~15 秒 + 一次智谱调用，
// 之后命中就是 0 成本、毫秒级。命中率随库增长——这正是用户要的「越用越省」。
//
// 存储形状（state/image-memory.json）：
//   { version: 1, entries: [ { h: 'dhash16', d: '描述', k: 'sticker'|'image', at: ms, n: 命中次数 } ] }
// 匹配用汉明距离（默认 ≤6/64 bit，和表情库的判定口径一致）。

const DEFAULT_MAX_DISTANCE = 6;
const DEFAULT_MAX_ENTRIES = 5000;
const MAX_DESC_CHARS = 500;

function clampDesc(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= MAX_DESC_CHARS ? s : `${s.slice(0, MAX_DESC_CHARS)}…`;
}

function normalizeImageMemory(raw) {
  const src = raw && typeof raw === 'object' && Array.isArray(raw.entries) ? raw.entries : [];
  const entries = [];
  const seen = new Set();
  for (const e of src) {
    const h = String(e?.h || '').trim().toLowerCase();
    const d = clampDesc(e?.d);
    if (!/^[0-9a-f]{8,16}$/.test(h) || !d || seen.has(h)) continue;
    seen.add(h);
    entries.push({ h, d, k: e?.k === 'sticker' ? 'sticker' : 'image', at: Number(e?.at) || 0, n: Number(e?.n) || 0 });
  }
  return { version: 1, entries };
}

function hammingHex(a, b) {
  const x = String(a || '').trim().toLowerCase();
  const y = String(b || '').trim().toLowerCase();
  // 只接受 8~16 位十六进制；长度不一致或非法一律当「不相似」（64），避免 'abc' 被 padStart 成"看起来很像"。
  if (!/^[0-9a-f]{8,16}$/.test(x) || !/^[0-9a-f]{8,16}$/.test(y) || x.length !== y.length) return 64;
  let dist = 0;
  for (let i = 0; i < x.length; i += 1) {
    let v = parseInt(x[i], 16) ^ parseInt(y[i], 16);
    while (v) { dist += v & 1; v >>= 1; }
  }
  return dist;
}

// 查表：返回 { entry, distance } 或 null。同 hash 直接命中；否则取距离最小且 ≤ maxDistance 的。
function findImageMemory(store, hash, { maxDistance = DEFAULT_MAX_DISTANCE } = {}) {
  const h = String(hash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8,16}$/.test(h)) return null;
  const entries = normalizeImageMemory(store).entries;
  let best = null;
  for (const e of entries) {
    if (e.h === h) return { entry: e, distance: 0 };
    const dist = hammingHex(e.h, h);
    if (dist <= maxDistance && (!best || dist < best.distance)) best = { entry: e, distance: dist };
  }
  return best;
}

// 记住一张图：同 hash 只更新描述/计数；超上限按「最近用过」淘汰（n 大的保留）。
function rememberImage(store, { hash, desc, kind = 'image' }, { maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now() } = {}) {
  const h = String(hash || '').trim().toLowerCase();
  const d = clampDesc(desc);
  const mem = normalizeImageMemory(store);
  if (!/^[0-9a-f]{8,16}$/.test(h) || !d) return { store: mem, added: false, updated: false };
  const hit = mem.entries.find((e) => e.h === h);
  if (hit) {
    hit.d = d;
    hit.at = now;
    hit.n = (hit.n || 0) + 1;
    return { store: mem, added: false, updated: true };
  }
  mem.entries.push({ h, d, k: kind === 'sticker' ? 'sticker' : 'image', at: now, n: 0 });
  if (mem.entries.length > maxEntries) {
    mem.entries.sort((a, b) => (b.n - a.n) || (b.at - a.at));
    mem.entries.length = maxEntries;
  }
  return { store: mem, added: true, updated: false };
}

// 给提示词的一行：明确「这是查表得来的，不是你此刻看到的」，避免模型幻觉成实时视觉。
function imageMemoryLine(label, entry) {
  const text = clampDesc(entry?.d);
  if (!text) return '';
  const hits = Number(entry?.n) || 0;
  return `${label} 是本地图库里的老图${hits > 0 ? `（已见过 ${hits} 次）` : ''}，凭 dhash 比对认出来的：${text}`;
}

export {
  DEFAULT_MAX_DISTANCE,
  DEFAULT_MAX_ENTRIES,
  MAX_DESC_CHARS,
  normalizeImageMemory,
  hammingHex,
  findImageMemory,
  rememberImage,
  imageMemoryLine,
};
