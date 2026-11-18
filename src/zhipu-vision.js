// 智谱直连识图（桥接自己发请求，不走 DSH provider）。
//
// 为什么单独做：DSH 的 provider 层对 glm-5.3-flash 传的是 `thinking: {type: ...}`，
// 而智谱只认 `reasoning_effort: "low"|"high"|"max"`，于是每轮先 400「该模型始终思考」，
// 400 不计调用、也不产出，表现就是「后台看不到调用、图也没识别」。
// 这里直接 POST /chat/completions，参数自己控制，成功率和可见性都可控。
//
// 用法：给没有视觉能力的回合模型兜底——图仍然发不进去，但先用智谱把图描述成文字，
// 模型照样能「看懂」画面，且文本主力还能继续用免费/便宜的模型。

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_MODEL = 'glm-5.3-flash';
const DEFAULT_TIMEOUT_MS = 45000;
const MAX_DESCRIBE_CHARS = 380;

const VISION_PROMPT = [
  '你在帮一个聊天机器人看图。只输出描述，不要寒暄、不要复述这句要求。',
  '用中文说清：①画面主体是什么；②如果图里有文字/截图/表格，把关键文字照样写出来；',
  '③场景与氛围；④如果明显是表情包或梗图，点一句它在表达什么情绪。',
  `最多 ${MAX_DESCRIBE_CHARS} 字，不要编造看不清的细节；涉黄涉暴只做中性描述。`,
].join('');

function zhipuVisionCfg(cfg) {
  const z = cfg?.socialV2?.zhipu ?? {};
  const apiKey = typeof z.apiKey === 'string' ? z.apiKey.trim() : '';
  const baseUrl = (typeof z.baseUrl === 'string' && z.baseUrl.trim()) || DEFAULT_BASE_URL;
  const model = (typeof z.visionModel === 'string' && z.visionModel.trim()) || DEFAULT_MODEL;
  const timeoutMs = Number.isFinite(z.visionTimeoutMs) && z.visionTimeoutMs > 1000 ? Math.min(120000, Math.round(z.visionTimeoutMs)) : DEFAULT_TIMEOUT_MS;
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model, timeoutMs, enabled: Boolean(apiKey) && z.visionEnabled !== false };
}

function clampText(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= MAX_DESCRIBE_CHARS) return s;
  return `${s.slice(0, MAX_DESCRIBE_CHARS)}…`;
}

// 单图描述。入参 buffer 是已经归一化过的图（JPEG/PNG），失败一律回 {ok:false, error}，
// 绝不抛，调用方按「描述失败 → 退回原来的『看不了图』文案」处理。
async function describeImageWithZhipu({ buffer, mimeType, cfg, prompt, fetchImpl } = {}) {
  const conf = zhipuVisionCfg(cfg);
  if (!conf.enabled) return { ok: false, error: '没配置智谱 key（socialV2.zhipu.apiKey）' };
  if (!buffer || !buffer.length) return { ok: false, error: '没有图片数据' };
  const mime = typeof mimeType === 'string' && mimeType.startsWith('image/') ? mimeType : 'image/jpeg';
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') return { ok: false, error: '当前环境没有 fetch' };
  const body = {
    model: conf.model,
    // 智谱这一档模型「始终思考」，只接受 low/high/max；传 thinking 会 400。
    reasoning_effort: 'low',
    max_tokens: 600,
    temperature: 0.2,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: typeof prompt === 'string' && prompt.trim() ? prompt : VISION_PROMPT },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } },
        ],
      },
    ],
  };
  const startedAt = Date.now();
  try {
    const res = await fetchFn(`${conf.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${conf.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(conf.timeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) {
      let msg = raw.slice(0, 200);
      try {
        const parsed = JSON.parse(raw);
        msg = parsed?.error?.message || msg;
      } catch {}
      return { ok: false, error: `HTTP ${res.status}：${msg}`, ms: Date.now() - startedAt };
    }
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: '返回不是 JSON', ms: Date.now() - startedAt };
    }
    const choice = data?.choices?.[0];
    const text = clampText(choice?.message?.content);
    if (!text) {
      // 这一档模型会先输出 reasoning_content；content 空说明被 max_tokens 截断在思考里。
      const finish = choice?.finish_reason || '空';
      return { ok: false, error: `模型没给出描述（finish_reason=${finish}）`, ms: Date.now() - startedAt };
    }
    return { ok: true, text, ms: Date.now() - startedAt, model: conf.model };
  } catch (error) {
    const name = error?.name === 'TimeoutError' ? '超时' : '';
    return { ok: false, error: `${name}${error?.message || error}`, ms: Date.now() - startedAt };
  }
}

// 给提示词的一行：告诉模型「这张图已经有人帮你看过了」，避免它再假装看见或道歉。
function describeLineForPrompt(label, text) {
  const body = clampText(text);
  return `${label} 的画面描述（由识图模型转述，不是你自己看到的）：${body}`;
}

export { describeImageWithZhipu, describeLineForPrompt, zhipuVisionCfg, MAX_DESCRIBE_CHARS, VISION_PROMPT };
