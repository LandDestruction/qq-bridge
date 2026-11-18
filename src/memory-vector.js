// 语义检索：向量 + SQLite 存储 + 内存余弦。
//
// 两种 embedding 后端（socialV2.memory.vector.backend）：
// - local：@huggingface/transformers + bge-small-zh-v1.5（512 维，q8 量化），
//   完全离线，CPU 约 2-10ms/条，模型缓存在 data/models/ 可随系统一起拷贝；
// - api：智谱 embedding-3（2048 维），需要网络和 apiKey。
//
// 为什么需要：FTS5 trigram 只认字面重合，「冰箱不制冷」查不到「冰箱坏了」；
// 中文短消息同义改写很常见，光靠关键词会漏。这里补一路语义召回。
//
// 成本与风险控制：
// - 默认关闭（socialV2.memory.vector.enabled === true 才启用），不改变既有行为；
// - 只索引最近 days 天、每个会话最近 perKey 条，避免全库 embedding；
// - query 向量 LRU 缓存，同一句话不重复付费；
// - 所有失败静默降级（返回空数组），绝不阻塞投递。

const DIM_API = 2048;
const DIM_LOCAL = 512;
const DEFAULT_MODEL = 'embedding-3';
const DEFAULT_LOCAL_MODEL = 'Xenova/bge-small-zh-v1.5';
const DEFAULT_BASE = 'https://open.bigmodel.cn/api/paas/v4';

const VEC_SCHEMA = `
  CREATE TABLE IF NOT EXISTS msg_vec (
    msg_id INTEGER PRIMARY KEY,
    key TEXT NOT NULL,
    ts INTEGER NOT NULL,
    vec BLOB NOT NULL,
    dim INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_msg_vec_ts ON msg_vec(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_msg_vec_key ON msg_vec(key, ts DESC);
`;

export function vecCfg(cfg) {
  const z = (cfg && cfg.socialV2 && cfg.socialV2.zhipu) || {};
  const m = (cfg && cfg.socialV2 && cfg.socialV2.memory && cfg.socialV2.memory.vector) || {};
  const backend = m.backend === 'local' ? 'local' : 'api';
  const localModel = String(m.localModel || DEFAULT_LOCAL_MODEL);
  return {
    apiKey: typeof z.apiKey === 'string' ? z.apiKey.trim() : '',
    baseUrl: String(z.baseUrl || DEFAULT_BASE).replace(/\/+$/, ''),
    model: backend === 'local' ? localModel : String(m.embeddingModel || z.embeddingModel || DEFAULT_MODEL),
    backend,
    localModel,
    dim: backend === 'local' ? DIM_LOCAL : DIM_API,
    // local 后端不需要 apiKey；api 后端才要求
    enabled: m.enabled === true && (backend === 'local' || Boolean(z.apiKey)),
    days: Math.max(7, Math.min(365, Number(m.days) || 60)),
    perKey: Math.max(100, Math.min(20000, Number(m.perKey) || 5000)),
    timeoutMs: Math.max(3000, Math.min(30000, Number(m.timeoutMs) || 8000))
  };
}

// 本地 embedding：@huggingface/transformers + bge-small-zh-v1.5（q8）
// 动态 import —— 没装这个包时不影响其它功能，只是语义路降级为不可用。
let localPipe = null;
let localModelId = '';
async function getLocalExtractor(modelId) {
  if (localPipe && localModelId === modelId) return localPipe;
  const tf = await import('@huggingface/transformers');
  const { pipeline, env } = tf;
  // 国内直连 huggingface.co 不通，默认走镜像；可用 HF_ENDPOINT 覆盖
  if (!env.remoteHost || env.remoteHost.includes('huggingface.co')) env.remoteHost = process.env.HF_ENDPOINT || 'https://hf-mirror.com';
  env.cacheDir = env.cacheDir || './data/models';
  localPipe = await pipeline('feature-extraction', modelId, { dtype: 'q8' });
  localModelId = modelId;
  return localPipe;
}

async function embedLocal(conf, texts) {
  const ex = await getLocalExtractor(conf.localModel);
  const out = await ex(texts, { pooling: 'mean', normalize: true });
  const d = out.dims[out.dims.length - 1];
  const arr = new Array(texts.length);
  for (let i = 0; i < texts.length; i++) {
    arr[i] = Float32Array.from(out.data.subarray(i * d, (i + 1) * d));
  }
  return arr;
}

/** 调一次 embeddings 接口，返回 Float32Array[]（失败返回 null）。 */
async function embedRaw(conf, texts) {
  if (conf.backend === 'local') {
    try {
      return await embedLocal(conf, texts);
    } catch (e) {
      return null;
    }
  }
  const body = JSON.stringify({ model: conf.model, input: texts });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), conf.timeoutMs);
  try {
    const r = await fetch(`${conf.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${conf.apiKey}` },
      body,
      signal: ac.signal
    });
    if (!r.ok) return null;
    const j = await r.json();
    const arr = Array.isArray(j && j.data) ? j.data : [];
    if (arr.length !== texts.length) return null;
    const out = new Array(texts.length);
    for (const d of arr) out[d.index] = Float32Array.from(d.embedding);
    return out.every(Boolean) ? out : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  return n;
}

// int8 量化存储：2048 维 float32 是 8KB/条，int8 只要 2KB，余弦误差 <0.01，
// 对「找相似」足够；换来的是能把每个会话最近几千条都索引进内存。
function toBlob(v) {
  const q = new Int8Array(v.length);
  let mx = 0;
  for (let i = 0; i < v.length; i++) { const a = Math.abs(v[i]); if (a > mx) mx = a; }
  const k = mx > 0 ? 127 / mx : 1;
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i] * k)));
  return Buffer.from(q.buffer, q.byteOffset, q.byteLength);
}

function fromBlob(b) {
  const i8 = new Int8Array(b.buffer ?? b, b.byteOffset ?? 0, b.byteLength);
  const out = new Float32Array(i8.length);
  for (let i = 0; i < i8.length; i++) out[i] = i8[i] / 127;
  return out;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (norm(a) * norm(b) || 1);
}

export function createMemoryVector(deps) {
  const log = (m) => { try { deps.log(`[向量] ${m}`); } catch {} };
  let db = null;
  let schemaReady = false;
  let indexing = false;
  let lastIndexAt = 0;
  const qCache = new Map(); // q -> Float32Array（LRU 32）

  function conn() {
    if (!schemaReady) {
      try {
        db = typeof deps.messageDb === 'function' ? deps.messageDb() : deps.messageDb;
        if (!db) return null;
        db.exec(VEC_SCHEMA);
        // 旧库（v1 只有 msg_id/key/ts/vec）升级：先补 dim 列，再建依赖它的索引。
        // 顺序不能反——旧表上没有 dim 列时，CREATE INDEX ON msg_vec(dim,...) 会让整段 exec 失败。
        try { db.exec('ALTER TABLE msg_vec ADD COLUMN dim INTEGER NOT NULL DEFAULT 0'); } catch {}
        try { db.exec('CREATE INDEX IF NOT EXISTS idx_msg_vec_dim ON msg_vec(dim, ts DESC)'); } catch {}
        schemaReady = true;
      } catch (e) {
        log(`打开向量表失败：${e && e.message ? e.message : e}`);
        return null;
      }
    }
    return db;
  }

  function conf() {
    return vecCfg(deps.cfg);
  }

  /** 后台索引：把还没 embedding 的近期消息补上。返回本轮处理条数。 */
  async function indexPending(maxBatch = 400) {
    const c = conf();
    if (!c.enabled || indexing) return 0;
    const d = conn();
    if (!d) return 0;
    indexing = true;
    let total = 0;
    try {
      const since = Date.now() - c.days * 86400000;
      // 只索引「每个 key 的最近 perKey 条」，避免老消息无限膨胀
      const pending = d.prepare(`
        SELECT m.id, m.key, m.ts, m.text FROM messages m
        WHERE m.ts >= ?
          AND m.text IS NOT NULL AND length(m.text) >= 2
          AND NOT EXISTS (SELECT 1 FROM msg_vec v WHERE v.msg_id = m.id)
          AND m.id IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (PARTITION BY key ORDER BY ts DESC) AS rn FROM messages WHERE ts >= ?
            ) WHERE rn <= ?
          )
        ORDER BY m.ts DESC LIMIT ?
      `).all(since, since, c.perKey, maxBatch);
      if (!pending.length) return 0;
      for (let i = 0; i < pending.length; i += 16) {
        const chunk = pending.slice(i, i + 16);
        const vecs = await embedRaw(c, chunk.map((r) => String(r.text).slice(0, 400)));
        if (!vecs) { log('embedding 失败，等下一轮'); break; }
        const ins = d.prepare('INSERT OR REPLACE INTO msg_vec (msg_id, key, ts, vec, dim) VALUES (?, ?, ?, ?, ?)');
        d.exec('BEGIN');
        try {
          for (let k = 0; k < chunk.length; k++) ins.run(chunk[k].id, String(chunk[k].key || ''), Number(chunk[k].ts) || 0, toBlob(vecs[k]), c.dim);
          d.exec('COMMIT');
        } catch (e) {
          try { d.exec('ROLLBACK'); } catch {}
          throw e;
        }
        total += chunk.length;
      }
      lastIndexAt = Date.now();
      if (total) log(`索引 ${total} 条`);
    } catch (e) {
      log(`索引异常：${e && e.message ? e.message : e}`);
    } finally {
      indexing = false;
    }
    return total;
  }

  /** 预热 query 向量（异步，供同步检索使用）。 */
  async function embedQuery(q) {
    const c = conf();
    const text = String(q || '').trim();
    if (!c.enabled || text.length < 2) return false;
    if (qCache.has(text)) return true;
    const vecs = await embedRaw(c, [text.slice(0, 200)]);
    if (!vecs) return false;
    if (qCache.size >= 32) qCache.delete(qCache.keys().next().value);
    qCache.set(text, vecs[0]);
    return true;
  }

  /** 同步语义检索：用已预热的 query 向量扫最近 days 天的向量。 */
  function semanticSearchSync(q, key, limit = 6) {
    const c = conf();
    const text = String(q || '').trim();
    if (!c.enabled || text.length < 2) return [];
    const qv = qCache.get(text);
    if (!qv) return null; // null = 没预热，调用方应跳过（区别于「有预热但无结果」的空数组）
    const d = conn();
    if (!d) return [];
    try {
      const since = Date.now() - c.days * 86400000;
      const isGroup = /^group:/.test(String(key || ''));
      const rows = d.prepare(`
        SELECT v.msg_id AS msg_id, v.key AS key, v.ts AS ts, v.vec AS vec, m.sender AS sender, m.is_self AS is_self, m.text AS text
        FROM msg_vec v JOIN messages m ON m.id = v.msg_id
        WHERE v.ts >= ? AND v.dim = ? ${isGroup ? "AND v.key NOT LIKE 'private:%'" : ''}
        ORDER BY v.ts DESC LIMIT 4000
      `).all(since, c.dim);
      const scored = [];
      for (const r of rows) {
        const sim = cosine(qv, fromBlob(r.vec));
        // 阈值按后端区分：本地 bge-small 对短句更「宽容」（无关句也能到 0.5+），
        // 用 0.55 只留比较像的；智谱 embedding-3 判别力更强，0.42 即可。
        if (sim < (c.backend === 'local' ? 0.55 : 0.42)) continue;
        if (String(r.text || '').trim().length < 6) continue;
        const age = (Date.now() - (Number(r.ts) || Date.now())) / 86400000;
        scored.push({ sim, age, row: r });
      }
      scored.sort((a, b) => b.sim - a.sim);
      return scored.slice(0, limit).map(({ sim, age, row }) => ({
        sim,
        age,
        key: String(row.key || ''),
        ts: Number(row.ts) || 0,
        sender: row.is_self ? '我' : (row.sender || '有人'),
        text: String(row.text || '')
      }));
    } catch (e) {
      log(`检索异常：${e && e.message ? e.message : e}`);
      return [];
    }
  }

  function stats() {
    const c = conf();
    const d = conn();
    let indexed = 0;
    let pending = 0;
    try {
      if (d) {
        indexed = (d.prepare('SELECT COUNT(*) AS n FROM msg_vec WHERE dim = ?').get(c.dim) || {}).n || 0;
        const since = Date.now() - c.days * 86400000;
        pending = (d.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE m.ts >= ?
          AND m.text IS NOT NULL AND length(m.text) >= 2
          AND NOT EXISTS (SELECT 1 FROM msg_vec v WHERE v.msg_id = m.id)
          AND m.id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY key ORDER BY ts DESC) AS rn FROM messages WHERE ts >= ?) WHERE rn <= ?)`
        ).get(since, since, c.perKey) || {}).n || 0;
      }
    } catch {}
    return { enabled: c.enabled, model: c.model, backend: c.backend, dim: c.dim, indexed, pending, lastIndexAt, cache: qCache.size };
  }

  return { indexPending, embedQuery, semanticSearchSync, stats };
}
