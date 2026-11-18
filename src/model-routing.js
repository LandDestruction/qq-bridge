// 模型路由（空闲/高峰/降级/禁用）：纯逻辑，路由与 ensureChatModel 共用。
export const ROUTING_MAX_CANDIDATES = 5;

// 单个候选的归一键。**两种写法都收**：
//   * 对象 {provider, model}（配置文件与后端内部的标准形态）
//   * 字符串 "provider/model"（运维面板 /ops 的 select 值就是这个形态，见 public/ops.html routingKey）
// 历史上只认对象，于是面板一保存就把它发来的字符串全判成 null，
// config.json 被写成 {idle:null, peak:null, fallback:[], disabled:[]} —— 模型路由当场被清空
// （2026-10-26 21:1x 真机复现：保存后 GET 回来的 routing 全空，下一轮只能退回 dsh 默认模型）。
export const NO_MODEL_REF = Object.freeze({ provider: 'none', model: 'none' });
export function isNoModelRef(v) { return !!v && typeof v === 'object' && String(v.provider || '') === 'none'; }
export function normalizeModelRef(v) {
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    // 「无」：显式选择不调用模型（机器人不说话）。用哨兵而不是 null，
    // 否则会被当成「没设置」回落到 idle/默认模型。
    if (s === 'none' || s === 'none/none') return { ...NO_MODEL_REF };
    const i = s.indexOf('/');
    if (i <= 0 || i === s.length - 1) return null;
    const provider = s.slice(0, i).trim();
    const model = s.slice(i + 1).trim();
    return provider && model ? { provider, model } : null;
  }
  if (!v || typeof v !== 'object') return null;
  const provider = String(v.provider || '').trim();
  const model = String(v.model || '').trim();
  return provider && model ? { provider, model } : null;
}

const normOne = normalizeModelRef;
const keyOf = (m) => `${m.provider}/${m.model}`;

export function normalizeRouting(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const dedupe = (list) => {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(list) ? list : []) {
      const m = normOne(item);
      if (!m || seen.has(keyOf(m))) continue;
      seen.add(keyOf(m));
      out.push(m);
      if (out.length >= ROUTING_MAX_CANDIDATES) break;
    }
    return out;
  };
  // 2026-11-02：拆成「文本 / 视觉」两套（各自 idle/peak + 三级降级链）。
  // 视觉链第三级默认 none（不可用）：走到这级直接告诉群友「这张图我现在看不了」。
  return {
    idle: normOne(src.idle),
    peak: normOne(src.peak),
    fallback: dedupe(src.fallback),
    disabled: dedupe(src.disabled),
    visionIdle: normOne(src.visionIdle),
    visionPeak: normOne(src.visionPeak),
    visionFallback: dedupe(src.visionFallback)
  };
}

/**
 * 选择本轮模型。
 * 优先级：media（带图）> peak（高峰）> idle > fallback 顺序 > null（调用方回退 cfg 默认）。
 * 全程跳过 disabled 与 bad（已知不可用）；available 非空时只认清单内的。
 * @returns {{provider:string, model:string, source:string}|null}
 */
export function resolveModelChoice({ routing, media = null, isPeak = false, available = [], disabled = [], bad = null } = {}) {
  const r = routing && routing.idle !== undefined ? routing : normalizeRouting(routing);
  const disabledKeys = new Set((Array.isArray(disabled) && disabled.length ? disabled : r.disabled).map((m) => keyOf(m)));
  const availKeys = new Set((Array.isArray(available) ? available : []).map((m) => keyOf(m)).filter(Boolean));
  const usable = (m, source) => {
    if (!m) return null;
    const k = keyOf(m);
    if (disabledKeys.has(k)) return null;
    if (typeof bad === 'function' && bad(m)) return null;
    if (availKeys.size && !availKeys.has(k)) return null;
    const pick = { provider: m.provider, model: m.model, source };
    if (typeof m.supportsImages === 'boolean') {
      pick.supportsImages = m.supportsImages;
    } else {
      // 配置条目（normalizeRouting 产物）没有 supportsImages，从目录清单里按 provider/model 补。
      // 目录是 fetchModelCatalog（wb2api /v1/models 等）拉的权威数据，含 supports_images 字段。
      const cat = (Array.isArray(available) ? available : []).find((a) => a && keyOf(a) === k);
      if (cat && typeof cat.supportsImages === 'boolean') pick.supportsImages = cat.supportsImages;
    }
    return pick;
  };
  const ordered = [
    [media, 'media'],
    [isPeak ? r.peak : null, 'peak'],
    [r.idle, 'idle'],
    ...r.fallback.map((m) => [m, 'fallback'])
  ];
  for (const [m, source] of ordered) {
    const hit = usable(m, source);
    if (hit) return hit;
  }
  return null;
}
