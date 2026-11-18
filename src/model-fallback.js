// 模型相关错误的判定与「配置模型失效时挑一个可用模型」的纯函数集合。
//
// 为什么单独成模块：bridge.js 是 14000+ 行单体、import 即启动桥接，没法在单测里 import。
// 这里的判定逻辑（503 报文特征、模型不可用识别、可用模型挑选）必须能离线跑，
// 所以全部做成无 IO、无全局状态的纯函数，bridge.js 与 scripts/test-model-fallback.mjs 共用。
//
// 事故背景（2026-10-25）：
//   ① 主模型池整体 503（code=no_healthy_account）时旧正则认不出来，modelFallbacks 一次都没生效；
//   ② 用户把 provider 注册表里的模型 id 从 cn:deepseek-v4.1-flash 改成不带前缀的
//      deepseek-v4.1-flash 后，桥接 config.json 里的旧 id 让 selectModel 直接失败，
//      机器人对群里完全哑掉，只能人工改配置 + 重启。

/**
 * 「额度/限流/主模型池全挂」类错误的特征。
 *
 * 注意 503 的写法：**不要**裸匹配 /503/，否则「今天 503 路公交好挤」这种正常聊天文本
 * 会被当成容量错误，进而触发一次无谓的模型降级。只认 `code: 503` / `status=503`
 * 这类结构化上下文，以及报文里出现的整句特征（no_healthy_account / all accounts ...）。
 */
const CAPACITY_RE = new RegExp([
  // ── 原有分支：保持行为不变 ──
  '429',
  'rate.?limit',
  'quota',
  'insufficient',
  '额度',
  '频率限制',
  '超出',
  'model.{0,20}(not found|unavailable|disabled)',
  'no such model',
  // ── 新增：主模型池整体不可用（2026-10-25 13:48:38 群 100000003 的真实报文）──
  // {"code":"no_healthy_account","gateway_hint":"no healthy account available in pool;
  //  check /status or retry later","message":"all accounts are temporarily unavailable,
  //  please retry later","type":"api_error"}
  'no_healthy_account',
  'no healthy account',
  'all accounts',
  'temporarily unavailable',
  'service (?:is )?unavailable',
  'overloaded',
  'capacity',
  // ── 503 只在结构化上下文里认 ──
  '"?code"?\\s*[:=]\\s*"?503\\b',
  '"?status"?\\s*[:=]\\s*"?503\\b',
  '"?statusCode"?\\s*[:=]\\s*"?503\\b',
  '^\\s*503\\s*[:：]'
].join('|'), 'i');

/** 回一条消息内容判断是不是「额度/限流/模型池不可用」类错误。 */
export function isModelCapacityError(message) {
  const m = String(message ?? '');
  if (!m) return false;
  return CAPACITY_RE.test(m);
}

/**
 * 「模型本身不存在 / 该 provider 下没有这个模型」类错误的特征。
 * 真实报文：
 *   pi-ai provider "workbuddy2api" has no configured model "cn:deepseek-v4-pro"
 *   session/model-unavailable: Select an available model before sending a message.
 */
const MODEL_UNAVAILABLE_RE = new RegExp([
  'model[-_ ]?unavailable',
  'no configured model',
  'not configured model',
  'select an available model',
  'unknown model',
  'invalid model',
  'unsupported model',
  'model not found',
  'no such model',
  '模型不存在',
  '模型不可用',
  '没有可用模型'
].join('|'), 'i');

/** 判断这条错误是否属于「配置的模型不在可用清单里」（换模型池后会踩到）。 */
export function isModelUnavailableError(message) {
  const m = String(message ?? '');
  if (!m) return false;
  return MODEL_UNAVAILABLE_RE.test(m);
}

/**
 * 从 DSH 模型目录（`session.modelCatalog` 的返回值）里摊平成 [{provider, model, label}]。
 * 兼容两种形状：
 *   { groups: [{ id: provider, models: [{ id, name }] }] }   ← 0.1.5+
 *   { models: [{ id, provider, name }] }                     ← 老 RPC
 */
export function collectCatalogModels(catalog) {
  const out = [];
  const push = (provider, entry) => {
    const model = String(entry?.id ?? entry?.model ?? '').trim();
    if (!model) return;
    const item = { provider: String(provider ?? entry?.provider ?? '').trim(), model, label: String(entry?.name ?? entry?.label ?? model) };
    const si = entry?.supports_images ?? entry?.supportsImages ?? entry?.vision;
    if (typeof si === 'boolean') item.supportsImages = si;
    out.push(item);
  };
  if (Array.isArray(catalog?.groups)) {
    for (const g of catalog.groups) {
      const provider = String(g?.id ?? g?.provider ?? '').trim();
      if (Array.isArray(g?.models)) for (const m of g.models) push(provider, m);
    }
  }
  if (Array.isArray(catalog?.models)) {
    for (const m of catalog.models) push(m?.provider, m);
  }
  return out;
}

/** 可用模型清单的简短展示（日志用）。 */
export function describeModels(list, limit = 8) {
  const items = (Array.isArray(list) ? list : []).filter((m) => m && m.model);
  const shown = items.slice(0, limit).map((m) => (m.provider ? `${m.provider}/${m.model}` : String(m.model)));
  return `${shown.join(', ')}${items.length > limit ? ` …（共 ${items.length} 个）` : ''}`;
}

/**
 * 从可用清单里挑一个模型顶上。
 * 优先级：同 provider 的 flash 类 → 同 provider 的其它模型 → 任意 flash 类 → 清单第一个。
 * 会跳过「就是刚才失败的那个」。
 */
export function pickUsableModel({ provider, model, available } = {}) {
  const wantProvider = String(provider ?? '');
  const wantModel = String(model ?? '');
  const list = (Array.isArray(available) ? available : []).filter((m) => m && String(m.model ?? '').trim());
  if (!list.length) return null;
  const isFlash = (m) => /flash/i.test(String(m.model));
  const notBroken = list.filter((m) => !(String(m.model) === wantModel && (!wantProvider || String(m.provider ?? '') === wantProvider)));
  const pool = notBroken.length ? notBroken : list;
  const same = wantProvider ? pool.filter((m) => String(m.provider ?? '') === wantProvider) : [];
  const sameFlash = same.find(isFlash);
  if (sameFlash) return { provider: String(sameFlash.provider ?? wantProvider), model: String(sameFlash.model), reason: '同 provider 的 flash 模型' };
  if (same.length) return { provider: String(same[0].provider ?? wantProvider), model: String(same[0].model), reason: '同 provider 的第一个可用模型' };
  const anyFlash = pool.find(isFlash);
  if (anyFlash) return { provider: String(anyFlash.provider ?? ''), model: String(anyFlash.model), reason: '任意 provider 的 flash 模型' };
  return { provider: String(pool[0].provider ?? ''), model: String(pool[0].model), reason: '可用清单里的第一个模型' };
}

/**
 * 启动时校验 `dsh.model` / `dsh.modelFallbacks` 是否还在 provider 注册表的模型清单里。
 *
 * 返回：
 *   checked   —— 是否真的拿到了可用清单（拿不到就跳过校验，绝不阻止启动）
 *   ok        —— 主模型可用（且 fallbacks 没写错）
 *   warnings  —— 要打给人看的告警（含配置值与可用值）
 *   effective —— 主模型不可用时应回退到的运行期模型（{provider, model} 或 null）
 */
export function validateModelConfig({ provider, model, fallbacks, available } = {}) {
  const list = (Array.isArray(available) ? available : []).filter((m) => m && String(m.model ?? '').trim());
  const wantProvider = String(provider ?? '').trim();
  const wantModel = String(model ?? '').trim();
  if (!list.length) return { checked: false, ok: true, warnings: [], effective: null };
  const has = (p, m) => list.some((x) => String(x.model) === String(m) && (!p || String(x.provider ?? '') === String(p)));
  const warnings = [];
  const providers = [...new Set(list.map((x) => String(x.provider ?? '')).filter(Boolean))];
  let ok = true;
  let effective = null;

  if (!wantModel) {
    ok = false;
    warnings.push(`config.json 的 dsh.model 为空；可用模型：${describeModels(list)}`);
  } else if (!has(wantProvider, wantModel)) {
    ok = false;
    const sameProvider = providers.includes(wantProvider);
    warnings.push(
      `config.json 的 dsh.model「${wantProvider ? `${wantProvider}/` : ''}${wantModel}」不在 provider 注册表的模型清单里`
      + `${sameProvider ? '（该 provider 还在，但没有这个模型 id）' : `（provider「${wantProvider}」也不存在了）`}`
      + `；可用模型：${describeModels(list)}`
    );
    effective = pickUsableModel({ provider: wantProvider, model: wantModel, available: list });
  }

  for (const f of Array.isArray(fallbacks) ? fallbacks : []) {
    const fm = String(f?.model ?? '').trim();
    if (!fm) continue;
    const fp = String(f?.provider ?? '').trim();
    if (has(fp, fm)) continue;
    warnings.push(`config.json 的 dsh.modelFallbacks 里有不可用的备用模型「${fp ? `${fp}/` : ''}${fm}」（provider 或模型 id 已不存在）`);
  }

  return { checked: true, ok, warnings, effective };
}

/**
 * 把控制台保存/启动校验的模型 id 拿去和可用清单比对。
 *
 * 为什么必须在落盘前拦：合池后 provider 注册表里的 id 变成了不带区域前缀的
 * `deepseek-v4-pro`，而控制台曾经把 `cn:deepseek-v4-pro` 写进 config.json。
 * 之后**每一轮**都要先拿这个坏 id 去 selectModel、失败、再自动降级 ——
 * 白付一次 RPC 延迟，日志里每轮都刷两条（15:29:22 那次线上日志就是这么来的）。
 *
 * @returns {{ok: boolean, known: boolean, empty: boolean, matches: string[]}}
 *   empty：拿不到清单（DSH 临时不可用）——此时不要拒，调用方应「允许 + 告警」
 */
export function checkModelAgainstList({ provider, model, list } = {}) {
  const wanted = String(model ?? '').trim();
  const wantedProvider = String(provider ?? '').trim();
  const items = (Array.isArray(list) ? list : []).filter((m) => m && m.model);
  if (!items.length) return { ok: true, known: false, empty: true, matches: [] };
  if (!wanted) return { ok: false, known: false, empty: false, matches: [] };

  // ① 同 provider 同 id → 直接通过
  const sameProvider = items.filter((m) => !wantedProvider || String(m.provider ?? '') === wantedProvider);
  if (sameProvider.some((m) => String(m.model) === wanted)) return { ok: true, known: true, empty: false, matches: [] };

  // ② 区域前缀容错：`cn:deepseek-v4-pro` 与 `deepseek-v4-pro` 视为同一个模型。
  //    控制台旧版本会把带前缀的 id 写回配置，这里认下来并提示纠正后的 id，而不是硬拒。
  const stripPrefix = (s) => String(s ?? '').replace(/^(?:cn|global):/i, '');
  const wantedBare = stripPrefix(wanted);
  const byBare = items.filter((m) => stripPrefix(m.model) === wantedBare);
  if (byBare.length) {
    const providerOk = byBare.some((m) => !wantedProvider || String(m.provider ?? '') === wantedProvider);
    if (providerOk) {
      return { ok: true, known: true, empty: false, matches: byBare.map((m) => (m.provider ? `${m.provider}/${m.model}` : String(m.model))) };
    }
    return { ok: false, known: true, empty: false, matches: byBare.map((m) => (m.provider ? `${m.provider}/${m.model}` : String(m.model))) };
  }

  // ③ 同名但换了 provider（合池后常见）→ 拒，但把正确的 provider/model 带回去
  const sameId = items.filter((m) => String(m.model) === wanted);
  if (sameId.length) return { ok: false, known: true, empty: false, matches: sameId.map((m) => `${m.provider}/${m.model}`) };

  return { ok: false, known: false, empty: false, matches: [] };
}

/** 供 400 响应体/日志用的可用清单（带 provider，截断到 limit 条）。 */
export function listAvailableModels(list, limit = 40) {
  const items = (Array.isArray(list) ? list : []).filter((m) => m && m.model);
  const cap = Math.max(1, Number(limit) || 40);
  return items.slice(0, cap).map((m) => ({ provider: String(m.provider ?? ''), model: String(m.model), name: String(m.label ?? m.model) }));
}

/**
 * 用 Set 做「只保留最近 N 条」的日志去重表（FIFO 淘汰）。
 *
 * 注意语义：这个集合**只用来抑制重复日志**，不承载任何状态或权限判断 ——
 * 淘汰掉一条最多让同一原因多打一行日志，没有正确性风险。
 * Set 本身保持插入顺序，`for (const k of set) { set.delete(k); break; }` 就是最老的先出。
 *
 * @returns {boolean} 是否为新条目（true = 该打这一行日志）
 */
export function noteBounded(set, key, max = 200) {
  const cap = Math.max(1, Number(max) || 200);
  const k = String(key ?? '');
  if (!k) return false;
  if (set.has(k)) return false;
  set.add(k);
  while (set.size > cap) {
    for (const oldest of set) { set.delete(oldest); break; }
  }
  return true;
}

/**
 * 备用模型按 **provider 交替** 排序：连续两次降级不落在同一家。
 *
 * 为什么：17:41 线上连续降级两跳，两次都是 workbuddy2api —— 那家整池受限时，
 * 第二条备用等于再撞一次墙，白烧一轮延迟，而 deepseek-account 那条可用模型根本没被试到。
 * 排序保持同一 provider 内部的相对顺序（稳定性），只是把不同家交错开。
 */
export function orderFallbacksByProvider(fallbacks, currentProvider = '') {
  const list = (Array.isArray(fallbacks) ? fallbacks : []).filter((f) => f && f.model);
  if (!list.length) return [];
  // 配置里的**最后一项**是用户显式指定的「最后兜底」（如官方 deepseek-account/deepseek-v4-pro），
  // 不参与 provider 交错：交错只用于前面的备用，最后一项永远排在整条链的末尾。
  const pinned = list.length > 1 ? list[list.length - 1] : null;
  const buckets = new Map();
  for (const f of (pinned ? list.slice(0, -1) : list)) {
    const p = String(f.provider ?? '');
    if (!buckets.has(p)) buckets.set(p, []);
    buckets.get(p).push(f);
  }
  // 当前 provider 的桶放最后：已经在这家失败了，先从别家试起。
  const order = [...buckets.keys()].sort((a, b) => (a === currentProvider) - (b === currentProvider));
  const out = [];
  let added = true;
  while (added) {
    added = false;
    for (const p of order) {
      const q = buckets.get(p);
      if (q && q.length) { out.push(q.shift()); added = true; }
    }
  }
  if (pinned) out.push(pinned);
  return out;
}

/**
 * 一轮「模型容量错误」的降级决策（纯函数，便于单测；bridge 只负责执行）。
 *
 * 关键约定：**降级只写日志，不私聊管理员**（用户 2026-10-26 明确要求）。
 * 返回 `notifyOwner:false` 是硬约定，调用方不得再调用 sendToQQ 发运维通知；
 * 完全失败时的「业务话术」由调用方单独发给用户，不属于这里。
 *
 * @returns {{action:'none'|'fallback', count:number, next?:{provider:string,model:string},
 *   logLine?:string, notifyOwner:boolean, reason?:string}}
 */
export function planFallback({ message = '', current = {}, fallbacks = [], count = 0, reasonMax = 120 } = {}) {
  const c = { provider: String(current?.provider ?? ''), model: String(current?.model ?? '') };
  if (!isModelCapacityError(message)) return { action: 'none', count: Number(count) || 0, notifyOwner: false };
  const ordered = orderFallbacksByProvider(fallbacks, c.provider);
  const next = ordered.find((f) => f && f.model && !(String(f.provider) === c.provider && String(f.model) === c.model));
  if (!next) return { action: 'none', count: Number(count) || 0, notifyOwner: false, reason: 'no-fallback' };
  const n = (Number(count) || 0) + 1;
  const to = { provider: String(next.provider || c.provider), model: String(next.model) };
  const reason = String(message).replace(/\s+/g, ' ').trim().slice(0, reasonMax);
  return {
    action: 'fallback',
    count: n,
    next: to,
    logLine: `[模型] 已降级 ${c.provider}/${c.model} → ${to.provider}/${to.model}（第 ${n} 次，原因：${reason}）`,
    notifyOwner: false
  };
}

/**
 * 本轮真正生效的模型：applied（selectModel 成功回写）> 运行期覆盖 > 配置文件。
 *
 * 为什么必须分开：`ensureChatModel()` 里含图回合会把模型切到能看图的那个（局部变量 use），
 * 但那个选择只用于 selectModel，**不回写 activeModelOverride**。于是构造 prompt parts 的
 * 视觉守卫读 override/cfg 会得出「看不了图」→ 把 image part 换成文字，
 * 而会话其实已经被切成 deepseek-flash 了 —— 用户看到的就是「图像通道关着」。
 */
export function resolveTurnModel({ applied = null, override = null, cfgProvider = '', cfgModel = '' } = {}) {
  const pick = applied || override || null;
  if (pick && pick.model) {
    const out = { provider: String(pick.provider ?? ''), model: String(pick.model ?? '') };
    if (typeof pick.supportsImages === 'boolean') out.supportsImages = pick.supportsImages;
    return out;
  }
  return { provider: String(cfgProvider ?? ''), model: String(cfgModel ?? '') };
}


/**
 * 本轮用哪个模型（纯函数，优先级固定）：
 *   运行期 override > 带图专用(mediaUse) > 高峰 agent(peakUse) > 按类型(kindUse) > 配置默认。
 *
 * 为什么 media 必须压过 peak：高峰期 agent 模型（MiMo）不保证支持图片输入，
 * 把图喂给它会被 DSH 拒绝（attachment-invalid），用户看到的就是「识图没了」。
 */
export function chooseTurnModel({ override = null, mediaUse = null, peakUse = null, kindUse = null, cfgProvider = '', cfgModel = '', order = 'media-first' } = {}) {
  // order='peak-first'：高峰期实测 MiMo flash 也能识图，所以 peak 压过 media；
  // order='media-first'：保守模式（两者都可用时优先视觉模型）。
  const chain = order === 'peak-first' ? [peakUse, mediaUse, override, kindUse] : [override, mediaUse, peakUse, kindUse];
  const pick = chain.find((m) => m && m.model);
  if (pick) return { provider: String(pick.provider ?? ''), model: String(pick.model) };
  return { provider: String(cfgProvider ?? ''), model: String(cfgModel ?? '') };
}
