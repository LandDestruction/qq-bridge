// 出图 provider 的「可配置视图」：把 config.imagegen 的两档（免费档 / 高质量档）
// 规范化成控制台能显示、能编辑、且**绝不泄露 key** 的形状。
//
// 为什么单独一个模块：
//   · 控制台要读它（GET），要写它（POST），MCP 侧还要用它判断「这台机器到底有没有
//     生图能力」（没配 key 就不该把 qq_draw 注册给模型，否则模型会当自己会画）。
//   · 三处共用一份判定，才有唯一真源；判定散开就会出现「页面显示已配置、模型却调不到」
//     或反过来的怪状态。

/** 两档的固定顺序：preferred=免费档，fallback=高质量档（与 imagegen.js 的 tierProvider 一致）。 */
export const IMAGEGEN_SLOTS = Object.freeze(['preferred', 'fallback']);

/** 每档的展示信息（写死在代码里，不从 config 读：它是产品语义，不是用户配置）。 */
export const IMAGEGEN_SLOT_META = Object.freeze({
  preferred: Object.freeze({
    slot: 'preferred',
    tier: 'free',
    label: '免费档',
    title: '免费档（不限次数，带「AI生成」标注）',
    hint: '模型调用 tier=free 时走这一档；失败就如实报错，不会偷偷切到高质量档。'
  }),
  fallback: Object.freeze({
    slot: 'fallback',
    tier: 'high',
    label: '高质量档',
    title: '高质量档（画质更好，带「AI生成」标注）',
    hint: '模型调用 tier=high 时走这一档，按自然日计次（默认 30 次），失败会回滚配额。'
  })
});

/** 允许的 provider 适配模式（与 src/imagegen.js 的支持范围对齐）。 */
export const IMAGEGEN_MODES = Object.freeze(['openai-image', 'siliconflow-image', 'url-template']);

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 这一档是不是「真的能出图」：url-template 只要有 endpoint，其余模式必须有 key。 */
export function providerReady(slotCfg) {
  const c = slotCfg && typeof slotCfg === 'object' ? slotCfg : {};
  const mode = str(c.mode) || 'openai-image';
  if (mode === 'url-template') return str(c.endpoint) !== '';
  return str(c.apiKey) !== '' && str(c.baseUrl) !== '' && str(c.model) !== '';
}

/**
 * 这台机器现在能不能出图。
 * @param {object} cfg 整个 config（读 cfg.imagegen）
 * @returns {{enabled:boolean, ready:boolean, slots:{preferred:boolean, fallback:boolean}}}
 */
export function imagegenCapability(cfg = {}) {
  const ig = cfg && typeof cfg.imagegen === 'object' && cfg.imagegen ? cfg.imagegen : {};
  const enabled = ig.enabled !== false;
  const slots = {
    preferred: providerReady(ig.preferred),
    fallback: providerReady(ig.fallback)
  };
  return { enabled, ready: enabled && (slots.preferred || slots.fallback), slots };
}

/** 便利判定：模型侧要不要注册 qq_draw。 */
export function imagegenReady(cfg = {}) {
  return imagegenCapability(cfg).ready;
}

/** key 的「能给人看」的尾巴：只留最后 4 位，短 key 干脆不露。 */
export function keyTail(apiKey) {
  const k = str(apiKey);
  if (!k) return '';
  return k.length >= 12 ? k.slice(-4) : '••••';
}

/** 单档的对外视图（不含 key 原文）。 */
export function providerView(slot, slotCfg, quota = null) {
  const meta = IMAGEGEN_SLOT_META[slot] || {};
  const c = slotCfg && typeof slotCfg === 'object' ? slotCfg : {};
  return {
    slot,
    tier: meta.tier || '',
    label: meta.label || slot,
    title: meta.title || slot,
    hint: meta.hint || '',
    mode: str(c.mode) || 'openai-image',
    baseUrl: str(c.baseUrl),
    model: str(c.model),
    size: str(c.size) || '1024x1024',
    endpoint: str(c.endpoint),
    dailyLimit: Number.isFinite(Number(c.dailyLimit)) && Number(c.dailyLimit) > 0 ? Number(c.dailyLimit) : (meta.tier === 'high' ? 30 : null),
    hasKey: str(c.apiKey) !== '',
    keyTail: keyTail(c.apiKey),
    ready: providerReady(c),
    quota: meta.tier === 'high' ? quota : null
  };
}

/**
 * 控制台展示用的整份视图。
 * @param {object} cfg 整个 config
 * @param {{date?:string, used?:number}|null} quota 高质量档的当日配额状态（可选）
 */
export function providersView(cfg = {}, quota = null) {
  const ig = cfg && typeof cfg.imagegen === 'object' && cfg.imagegen ? cfg.imagegen : {};
  const cap = imagegenCapability(cfg);
  const used = quota && Number.isFinite(Number(quota.used)) ? Math.max(0, Math.floor(Number(quota.used))) : 0;
  const q = cap.slots.fallback ? { date: str(quota && quota.date), used } : null;
  return {
    ok: true,
    enabled: cap.enabled,
    mode: str(ig.mode) || 'tiered',
    promptTranslate: ig.promptTranslate !== false,
    ready: cap.ready,
    slots: cap.slots,
    providers: IMAGEGEN_SLOTS.map((slot) => providerView(slot, ig[slot], q)),
    // 页面上的提示语：这里写清楚「改完谁能立刻用、谁要重启」，省得来回问。
    note: '桥接立刻生效；模型侧（qq_draw 工具）要重启桌面客户端 DSH 才会重新注册。两档都填全后 qq_draw 才会出现在模型工具表里。'
  };
}

/**
 * 把一次 POST 的补丁合并进 config.imagegen（**纯函数**，不落盘）。
 * 只接受已知字段，未提供的字段保持原值；空字符串表示「清除这个字段」。
 * @returns {{ok:true, next:object}|{ok:false, error:string}}
 */
export function applyProviderPatch(imagegen, patch = {}) {
  const ig = imagegen && typeof imagegen === 'object' ? { ...imagegen } : {};
  const slot = str(patch.slot);
  if (!IMAGEGEN_SLOTS.includes(slot)) {
    return { ok: false, error: `slot 只能是 ${IMAGEGEN_SLOTS.join(' / ')}（收到 ${JSON.stringify(patch.slot)}）` };
  }
  const cur = ig[slot] && typeof ig[slot] === 'object' ? { ...ig[slot] } : {};

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') return { ok: false, error: 'enabled 必须是 true/false' };
    ig.enabled = patch.enabled;
  }
  if (patch.promptTranslate !== undefined) {
    ig.promptTranslate = patch.promptTranslate === true;
  }

  if (patch.mode !== undefined) {
    const mode = str(patch.mode);
    if (!IMAGEGEN_MODES.includes(mode)) return { ok: false, error: `mode 只能是 ${IMAGEGEN_MODES.join(' / ')}` };
    cur.mode = mode;
  }
  if (patch.apiKey !== undefined) {
    const key = str(patch.apiKey);
    // 长度门槛只为拦「粘贴时漏了一半」的明显错误；不同服务商格式差异很大，不做格式校验。
    if (key && key.length < 12) return { ok: false, error: 'API KEY 太短了（少于 12 个字符），检查一下是不是粘贴漏了' };
    if (key) cur.apiKey = key; else delete cur.apiKey;
  }
  if (patch.baseUrl !== undefined) {
    const url = str(patch.baseUrl);
    if (url && !/^https?:\/\//i.test(url)) return { ok: false, error: 'baseUrl 必须以 http(s):// 开头' };
    if (url) cur.baseUrl = url; else delete cur.baseUrl;
  }
  if (patch.endpoint !== undefined) {
    const url = str(patch.endpoint);
    if (url && !/^https?:\/\//i.test(url)) return { ok: false, error: 'endpoint 必须以 http(s):// 开头' };
    if (url) cur.endpoint = url; else delete cur.endpoint;
  }
  if (patch.model !== undefined) {
    const model = str(patch.model);
    if (model) cur.model = model; else delete cur.model;
  }
  if (patch.size !== undefined) {
    const size = str(patch.size);
    if (size && !/^\d{2,5}x\d{2,5}$/.test(size)) return { ok: false, error: 'size 要写成 1024x1024 这样' };
    if (size) cur.size = size; else delete cur.size;
  }
  if (patch.dailyLimit !== undefined) {
    const n = Number(patch.dailyLimit);
    if (!Number.isFinite(n) || n < 1 || n > 1000) return { ok: false, error: 'dailyLimit 要在 1~1000 之间' };
    cur.dailyLimit = Math.floor(n);
  }

  ig[slot] = cur;
  return { ok: true, next: ig };
}

/**
 * 给人看的「为什么现在不能出图」：给控制台和桥接侧的 403 文案共用，
 * 保证页面上看到的和模型侧报错说的是同一件事。
 */
export function whyNotReady(cfg = {}) {
  const cap = imagegenCapability(cfg);
  if (!cap.enabled) return '出图功能已在配置里关闭（imagegen.enabled=false）';
  if (!cap.slots.preferred && !cap.slots.fallback) {
    return '这台机器还没配出图服务的 API KEY（设置 → 模型与高峰 → 出图模型），所以我没有画图这个能力';
  }
  return '';
}
