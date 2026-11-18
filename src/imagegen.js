import { imageContentType } from './safe-fetch.js';
import { IMAGEGEN_SLOT_META, providerReady } from './imagegen-providers.js';
// 生图 provider 适配层（可插拔）。
//
// 为什么需要它：旧实现只支持「GET + {prompt} 模板」一种形态（pollinations），
// 而现在主流生图 API 都是 POST + JSON body + Bearer key（/v1/images/generations，
// 返回 b64_json 或 url）。换源不是改个 URL 的事，所以把「怎么取字节」抽出来。
//
// 两种模式（配置驱动，默认保持旧行为，不破坏已有 config.json）：
//   · url-template  —— GET 模板，{prompt} 替换；兼容 pollinations
//   · openai-image  —— POST {baseUrl}/images/generations，Bearer 鉴权，
//                      从 b64_json 或 url（url 也必须过 safeFetchBuffer）取图
//
// 安全约定（与项目其它地方一致）：
//   · 字节下载一律走注入的 safeFetchBuffer（保持字节上限 + SSRF 防护），不自己 fetch；
//   · apiKey 绝不进日志/错误文案，命中就打码；
//   · 失败按 429 / 401|403 / 超时 分类给可操作提示。

export const IMAGEGEN_DEFAULT_ENDPOINT = 'https://image.pollinations.ai/prompt/{prompt}?width=768&height=768&nologo=true';

/** 读取并规范化生图配置（非法值回落到默认，不让一条坏配置把出图打死）。 */
export function imagegenCfg(cfg = {}) {
  const src = cfg?.imagegen && typeof cfg.imagegen === 'object' ? cfg.imagegen : {};
  const mode = src.mode === 'openai-image' ? 'openai-image' : 'url-template';
  const num = (v, d, min = 0) => (Number.isFinite(Number(v)) && Number(v) >= min ? Number(v) : d);
  return {
    enabled: src.enabled !== false,
    mode,
    endpoint: String(src.endpoint || IMAGEGEN_DEFAULT_ENDPOINT),
    baseUrl: String(src.baseUrl || '').replace(/\/+$/, ''),
    apiKey: String(src.apiKey || ''),
    model: String(src.model || ''),
    size: String(src.size || '1024x1024'),
    cooldownMs: num(src.cooldownMs, 45000, 0),
    maxPerHour: num(src.maxPerHour, 10, 1),
    maxBytes: num(src.maxBytes, 0, 0),
    timeoutMs: num(src.timeoutMs, 120000, 1000),
    // 发图频次（send-image 用，与 draw 的冷却/小时上限**分开**计数）
    sendImageCooldownMs: num(src.sendImageCooldownMs, 3000, 0),
    sendImageMaxPerHour: num(src.sendImageMaxPerHour, 120, 1)
  };
}

/** 把密钥从任意文本里抹掉（错误信息可能把 key 原样带出来）。 */
export function redactSecret(text, secret) {
  const s = String(text ?? '');
  const key = String(secret ?? '');
  if (!key || key.length < 6) return s;
  return s.split(key).join('***');
}

/** 失败分类 → 可操作提示（给群友/运维看的话，不暴露内部错误码）。 */
export function describeImagegenError(status, message, apiKey = '') {
  const msg = String(message ?? '');
  const safe = redactSecret(msg, apiKey);
  if (status === 429) return { status: 429, error: '出图服务限流了，请稍后再试（配额或冷却中）' };
  if (status === 401 || status === 403) return { status: 502, error: '出图服务鉴权失败，请检查 imagegen.apiKey 配置' };
  if (/abort|timeout|timed?\s?out|ETIMEDOUT/i.test(safe)) return { status: 504, error: '出图服务超时，请稍后重试' };
  if (status >= 400) return { status: 502, error: `出图服务返回 ${status}：${safe.slice(0, 120)}` };
  return { status: 502, error: `出图失败：${safe.slice(0, 120)}` };
}

/** url-template 模式：拼 URL。 */
export function buildTemplateUrl(endpoint, prompt) {
  const tpl = String(endpoint || IMAGEGEN_DEFAULT_ENDPOINT);
  return tpl.split('{prompt}').join(encodeURIComponent(String(prompt ?? '')));
}

/**
 * 日志用 URL 摘要：只留协议+域名+路径长度。
 *
 * 硅基流动这类服务的图片 URL 带签名参数、且**只有 1 小时有效期**，
 * 整条打出来既泄露签名、又在日志里留下一串很快就失效的地扯。
 */
export function describeUrlForLog(raw) {
  const s = String(raw ?? '');
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.hostname}/(len=${s.length})`;
  } catch {
    return `(invalid url, len=${s.length})`;
  }
}

/** openai-image 模式：拼请求（URL / headers / body）。 */
export function buildOpenAIImageRequest(cfg, prompt) {
  const base = String(cfg?.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('imagegen.baseUrl 未配置（openai-image 模式必填）');
  const headers = { 'content-type': 'application/json' };
  const key = String(cfg?.apiKey || '').trim();
  if (key) headers.authorization = `Bearer ${key}`;
  const body = {
    model: cfg?.model || undefined,
    prompt: String(prompt ?? ''),
    size: cfg?.size || '1024x1024',
    n: 1,
    response_format: 'b64_json'
  };
  return { url: `${base}/images/generations`, method: 'POST', headers, body };
}

/** 从 openai-image 响应里取出「图在哪」：b64 直接给 buffer，url 给待下载地址。 */
export function parseOpenAIImageResponse(json) {
  const first = Array.isArray(json?.data) ? json.data[0] : null;
  if (!first) return { kind: 'none' };
  if (typeof first.b64_json === 'string' && first.b64_json.trim()) {
    return { kind: 'b64', buffer: Buffer.from(first.b64_json, 'base64') };
  }
  const url = String(first.url ?? '').trim();
  if (url) return { kind: 'url', url };
  return { kind: 'none' };
}

/**
 * 统一出口：拿一张图的字节。
 * @param {object} cfg 整个 config（读 cfg.imagegen）
 * @param {string} prompt 提示词
 * @param {{ safeFetchBuffer: Function, safeFetchJson?: Function, fetchImpl?: Function, timeoutMs?: number, maxBytes?: number }} deps
 *   safeFetchBuffer 必须由调用方注入（保持项目里的 SSRF/字节上限实现，不在这里再造一个）。
 */
export async function resolveImageBuffer(cfg, prompt, deps = {}) {
  const c = imagegenCfg(cfg);
  if (!c.enabled) return { ok: false, status: 403, error: '生图功能已关闭' };
  const { safeFetchBuffer, safeFetchJson } = deps;
  if (typeof safeFetchBuffer !== 'function') throw new Error('resolveImageBuffer 需要注入 safeFetchBuffer');
  const maxBytes = Number(deps.maxBytes) || Number(c.maxBytes) || 10 * 1024 * 1024;
  const timeoutMs = Number(deps.timeoutMs) || c.timeoutMs;

  try {
    if (c.mode === 'url-template') {
      const url = buildTemplateUrl(c.endpoint, prompt);
      const fetched = await safeFetchBuffer(url, maxBytes);
      return { ok: true, buffer: fetched.buffer, contentType: fetched.contentType || 'image/png', source: 'url-template' };
    }
    const req = buildOpenAIImageRequest(c, prompt);
    if (typeof safeFetchJson !== 'function') throw new Error('openai-image 模式需要注入 safeFetchJson');
    const json = await safeFetchJson(req.url, { method: req.method, headers: req.headers, body: req.body, timeoutMs });
    const parsed = parseOpenAIImageResponse(json);
    if (parsed.kind === 'b64') return { ok: true, buffer: parsed.buffer, contentType: 'image/png', source: 'openai-image:b64' };
    if (parsed.kind === 'url') {
      // 两步：POST 拿 URL → **立刻**下载字节。硅基流动等服务返回的是 URL（有效期 1 小时、
      // 带签名），且 QQ 发图要的是本地文件/base64，所以绝不能把 URL 直接往下传。
      // 下载仍走同一个 safeFetchBuffer（字节上限 + SSRF 防护都不绕过）；失败重试一次
      // 只为扛网络抖动，**不重新生成**（那会白花钱）。
      let lastError = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const fetched = await safeFetchBuffer(parsed.url, maxBytes);
          return { ok: true, buffer: fetched.buffer, contentType: fetched.contentType || 'image/png', source: 'openai-image:url' };
        } catch (error) {
          lastError = error;
          if (attempt === 1) await new Promise((r) => setTimeout(r, 500));
        }
      }
      return { ok: false, ...describeImagegenError(0, `图片下载失败（${describeUrlForLog(parsed.url)}）：${lastError?.message ?? lastError}`, c.apiKey) };
    }
    return { ok: false, status: 502, error: '出图服务没有返回图片数据（data[0] 里既没有 b64_json 也没有 url）' };
  } catch (error) {
    const status = Number(error?.status) || 0;
    return { ok: false, ...describeImagegenError(status, error?.message ?? error, c.apiKey) };
  }
}

// ── 提示词翻译（中文 → 英文）────────────────────────────────────────────────
//
// 实测（2026-10-25 直接打 pollinations）：中文提示词「一只橘猫坐在窗台上，水彩风格」
// 出来是一只白色毛团；同义英文「an orange tabby cat sitting on a windowsill,
// watercolor painting」则准确命中橘猫 + 窗台 + 水彩。同样的免费额度，翻译是纯收益。
//
// 约束：**翻译失败绝不能让生图失败**——超时/报错/输出不合法一律退回原始提示词。

/** 提示词里有没有中文（没有就不用浪费一次调用）。 */
export function needsTranslation(prompt) {
  return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(String(prompt ?? ''));
}

/** 翻译用的 system 提示词（低温度 + 短输出，只要英文）。 */
export const IMAGE_PROMPT_TRANSLATOR_SYSTEM = [
  '你是提示词工程师。把用户的中文画面描述翻译成适合文生图模型的英文提示词，',
  '保留主体、动作、风格、光线、构图等关键信息，用逗号分隔的短语，不要句子。',
  '只输出英文提示词本身，不要解释、不要引号、不要换行。'
].join('');

/** 清洗翻译结果：单行、去引号、去前后缀；不合法返回空串。 */
export function sanitizeTranslatedPrompt(raw) {
  let text = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  text = text.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
  text = text.replace(/^(翻译|译文|english|prompt)\s*[:：]\s*/i, '');
  text = text.replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '').trim();
  if (!text) return '';
  if (needsTranslation(text)) return '';   // 还是中文 → 视为失败，回退原文
  if (text.length > 400) text = text.slice(0, 400);
  return text;
}

/**
 * 把中文提示词翻成英文；任何异常都退回原文。
 * @param {{ prompt: string, callModel: Function, timeoutMs?: number }} p
 *   callModel({ system, user, temperature, maxTokens, timeoutMs }) → Promise<string>
 * @returns {Promise<{ text: string, translated: boolean, reason: string }>}
 */
export async function translateImagePrompt({ prompt, callModel, timeoutMs = 5000 } = {}) {
  const original = String(prompt ?? '');
  if (!original.trim()) return { text: original, translated: false, reason: '空提示词' };
  if (!needsTranslation(original)) return { text: original, translated: false, reason: '无中文，无需翻译' };
  if (typeof callModel !== 'function') return { text: original, translated: false, reason: '未注入翻译器，用原文' };
  try {
    const raw = await Promise.race([
      callModel({ system: IMAGE_PROMPT_TRANSLATOR_SYSTEM, user: original, temperature: 0.2, maxTokens: 150, timeoutMs }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`翻译超时（${timeoutMs}ms）`)), Math.max(200, Number(timeoutMs) || 5000)))
    ]);
    const clean = sanitizeTranslatedPrompt(raw);
    if (!clean) return { text: original, translated: false, reason: '译文不合法（空/仍含中文），用原文' };
    return { text: clean, translated: true, reason: '已翻译' };
  } catch (error) {
    return { text: original, translated: false, reason: `翻译失败：${error?.message ?? error}` };
  }
}

// ── 按档位取图（双通道编排）─────────────────────────────────────────────────
//
// tier=free → 智谱 CogView（免费、带 AI生成 标注、不扣配额）
// tier=high → 硅基流动 Z-Image（付费、同样带 AI生成 标注、每天 30 次，先占后调、失败回滚）
//
// 两条铁律：
//   ① free 失败**绝不**自动切 high —— 用户选了免费档，悄悄烧付费次数是最不能接受的行为；
//   ② high 配额用尽**绝不**静默降级 free —— 必须报错，让模型去问用户要不要改免费档。

/** 取某个档位的 provider 配置（preferred / fallback 都是合法的 provider 描述）。 */
export function tierProvider(cfg, tier) {
  const src = cfg?.imagegen && typeof cfg.imagegen === 'object' ? cfg.imagegen : {};
  const spec = tier === 'high' ? (src.fallback || {}) : (src.preferred || {});
  return {
    mode: spec.mode === 'siliconflow-image' ? 'siliconflow-image' : 'openai-image',
    baseUrl: String(spec.baseUrl || '').replace(/\/+$/, ''),
    apiKey: String(spec.apiKey || ''),
    model: String(spec.model || ''),
    size: String(spec.size || src.size || '1024x1024'),
    dailyLimit: Number(spec.dailyLimit) || 30
  };
}

/** 用指定 provider 生成并取回字节。两家的字段名不同，都在这里收敛。 */
async function generateWith(provider, prompt, deps) {
  const { safeFetchBuffer, safeFetchJson } = deps;
  const prefix = provider.baseUrl || '';
  if (!prefix) throw new Error(`provider.baseUrl 为空（mode=${provider.mode} model=${provider.model || '(空)'}）——检查 config.imagegen 的分档配置`);
  const url = `${prefix}/images/generations`;
  const headers = { 'content-type': 'application/json' };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const body = provider.mode === 'siliconflow-image'
    ? { model: provider.model, prompt: String(prompt ?? ''), image_size: provider.size, n: 1 }
    : { model: provider.model, prompt: String(prompt ?? ''), size: provider.size, n: 1, response_format: 'b64_json' };
  const json = await safeFetchJson(url, { method: 'POST', headers, body, timeoutMs: deps.timeoutMs || 120000 });
  const parsed = provider.mode === 'siliconflow-image' ? parseSiliconFlowImageResponse(json) : parseOpenAIImageResponse(json);
  if (parsed.kind === 'b64') return { buffer: parsed.buffer, source: `${provider.mode}:b64` };
  if (parsed.kind === 'url') {
    const fetched = await safeFetchBuffer(parsed.url, deps.maxBytes || 10 * 1024 * 1024);
    return { buffer: fetched.buffer, source: `${provider.mode}:url` };
  }
  throw new Error('出图服务没有返回图片数据');
}

/** 硅基流动：返回键是 images[]（不是 data[]）。 */
export function parseSiliconFlowImageResponse(json) {
  const first = Array.isArray(json?.images) ? json.images[0] : null;
  if (first) {
    if (typeof first.b64_json === 'string' && first.b64_json.trim()) return { kind: 'b64', buffer: Buffer.from(first.b64_json, 'base64') };
    const url = String(first.url ?? '').trim();
    if (url) return { kind: 'url', url };
  }
  return parseOpenAIImageResponse(json);   // 兼容某些网关仍返回 data[]
}

/**
 * 按档位取图。成功返回 { ok:true, buffer, tier, charged, quota, watermarked, source }；
 * 失败抛 Error（带 code / status），由调用方转成用户可读文案。
 * @param {{ quotaStore: { read: Function, write: Function }, safeFetchBuffer: Function, safeFetchJson: Function }} deps
 */
export async function generateByTier(cfg, prompt, { tier, deps = {} } = {}) {
  if (tier !== 'free' && tier !== 'high') throw Object.assign(new Error("tier 只能取 'free' 或 'high'"), { code: 'BAD_TIER', status: 400 });
  const now = deps.now ?? Date.now();
  const provider = tierProvider(cfg, tier);
  // 这一档没配 key 就别装作能画：直接回「我没有这个能力」，而不是带着空 key 打到
  // 服务商、拿一个 401 回来（那种报错模型只会理解成「出图失败」，会继续重试）。
  if (!providerReady(provider)) {
    const label = IMAGEGEN_SLOT_META[tier === 'free' ? 'preferred' : 'fallback']?.label || '这一档';
    throw Object.assign(new Error(`${label}还没配出图服务的 API KEY（设置 → 模型与高峰 → 出图模型），所以我没有画图这个能力`), { code: 'NO_PROVIDER', status: 503 });
  }

  if (tier === 'free') {
    // 免费档：只走 preferred，失败如实抛出（不切 high）。
    try {
      const got = await generateWith(provider, prompt, deps);
      return { ok: true, buffer: got.buffer, contentType: imageContentType(got.buffer), tier, charged: false, quota: null, watermarked: true, source: got.source };
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: error?.code || 'FREE_FAILED' });
    }
  }

  // 高质量档：先占配额，再调 fallback；失败回滚。
  const store = deps.quotaStore;
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function') {
    throw Object.assign(new Error('高质量档需要注入配额存储（quotaStore）'), { code: 'NO_QUOTA_STORE' });
  }
  const { takeQuota, refundQuota } = await import('./imagegen-quota.js');
  const before = store.read(now);
  const taken = takeQuota(before, { dailyLimit: provider.dailyLimit, atMs: now });
  if (!taken.ok) {
    // ① 不降级：一个网络请求都不发。
    throw Object.assign(new Error(taken.reason + '，可以用免费档（带 AI生成 标注）重试'), { code: 'QUOTA_EXHAUSTED', status: 429, quota: { used: before.used, limit: taken.limit, remaining: 0 } });
  }
  store.write(taken.state);
  try {
    const got = await generateWith(provider, prompt, deps);
    return {
      ok: true, buffer: got.buffer, contentType: imageContentType(got.buffer), tier,
      charged: true,
      quota: { used: taken.state.used, limit: taken.limit, remaining: Math.max(0, taken.limit - taken.state.used) },
      watermarked: false,
      source: got.source
    };
  } catch (error) {
    // ⑤ 失败回滚配额，并把错误抛给调用方（不偷偷换成免费图）。
    store.write(refundQuota(taken.state, now));
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: error?.code || 'HIGH_FAILED', quotaRefunded: true });
  }
}

/**
 * tier=high 前必须"问过档位"的硬约束判定。
 *
 * 背景：工具描述里写了「调用前必须先问」，但 19:01 实测模型**没问就直接 high** ——
 * 软约束在模型侧不可靠，必须在桥接侧拦。
 *
 * 判定（不猜、可解释）：
 *   ① 用户最近一条消息里自己说了「高清/高质量/high」→ 直接算满足（用户已明确选择）；
 *   ② 否则看"最后一条用户消息之后的 AI 消息"里，是否出现问档位的措辞（免费档/高质量档/档位/高清）；
 *   ③ 都不满足 → 拒绝（**绝不静默改成 free**）。
 */
export const TIER_ASK_RE = /(免费档|高质量档|高清档|档位|免费还是|要哪档)/;
// 用户把选择权交回来：工具契约写的是「随便/都行 → 用免费档」，这里必须放行并标注原因。
export const TIER_DEFERRED_RE = /(随便|都行|都可以|你决定|你看着|看着来|随你|无所谓)/;
// 用户自己点名要免费档：也算「问过」。（判定顺序：high 先、free 后 —— 两档互斥）
export const TIER_FREE_USER_RE = /(免费档|用免费的|免费画|不花钱|省钱)/;
export const TIER_HIGH_USER_RE = /(高清|高质量|高画质|high|付费档|画好点|好一点)/i;

export function tierAskSatisfied({ recent = [], lastUserText = '', enabled = true } = {}) {
  if (!enabled) return { ok: true, reason: 'constraint-disabled' };
  const userText = String(lastUserText || '').trim();
  if (TIER_HIGH_USER_RE.test(userText)) return { ok: true, reason: 'user-asked' };
  // 「随便/都行/你决定」= 用户把档位选择交回来 → 放行，由调用方按契约落到免费档。
  // 用户自己点名免费档：放行，并标注 user-free（调用方据此拒绝 tier=high，避免悄悄花钱）。
  if (TIER_FREE_USER_RE.test(userText)) return { ok: true, reason: 'user-free' };
  if (TIER_DEFERRED_RE.test(userText)) return { ok: true, reason: 'user-deferred' };
  const list = Array.isArray(recent) ? recent : [];
  // 从后往前扫：遇到第一条"用户消息"就停（只认最后一条用户消息之后 AI 说过的话）。
  const said = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m) continue;
    if (!m.isSelf) break;
    said.push(String(m.text ?? m.plain ?? ''));
  }
  if (said.some((t) => TIER_ASK_RE.test(t))) return { ok: true, reason: 'assistant-asked' };
  return { ok: false, reason: 'not-asked' };
}
