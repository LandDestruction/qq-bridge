// 高峰期「本地小模型接管」的纯逻辑：
// - 只在群聊高峰期暂停生效时启用（enabled 由 socialV2.peakPause.localModel 控制）；
// - 只允许群主/管理员（可配 roles）；
// - 要求这条消息确实在叫机器人（@ / 点名），避免管理员随便说话就把机器人钓出来；
// - 走 ollama 的 /api/chat，qwen3 必须 think:false（否则思考 token 吃光 num_predict，正文为空——实测）。

// 冲人/责备类措辞：8B 模型偶尔压不住（实测「你们能不能别吵了」）。命中就重写一次。
export const PEAK_TONE_RISKY_RE = /别吵|闭嘴|滚开|滚|烦死|吵死|傻|你们能不能|安静点|消停|烦不烦/;
export function isPeakToneRisky(text) {
  return PEAK_TONE_RISKY_RE.test(String(text ?? ''));
}

export const PEAK_LOCAL_DEFAULTS = Object.freeze({
  enabled: false,
  provider: 'openai',            // openai=OpenAI 兼容 /chat/completions；ollama=本地 /api/chat
  baseUrl: 'https://api.xiaomimimo.com/v1',
  apiKeyEnv: 'XIAOMI_MIMO_API_KEY',
  apiKey: '',
  model: 'mimo-v2.6-pro',
  noThinking: true,             // 请求体带 thinking:{type:'disabled'}，Mimo 实测 4.1s→1.7s
  think: false,
  timeoutMs: 20000,
  maxChars: 140,
  numPredict: 120,
  temperature: 0.6,
  roles: ['owner', 'admin'],
  userIds: [],
  // 用户要求：高峰期「回复群里所有人」（白名单群内），不再看 role/userIds。
  replyToAll: true,
  requireMention: true,
  // 护栏：太短/纯媒体不接话，且限频，避免群一热闹就刷屏。
  minChars: 2,
  skipMediaOnly: true,
  maxRepliesPerMinute: 6,
  maxRepliesPerHour: 60,
  historyMessages: 8
});

function num(v, d, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function peakLocalCfg(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const roles = Array.isArray(src.roles)
    ? src.roles.map((r) => String(r).toLowerCase()).filter((r) => r === 'owner' || r === 'admin')
    : PEAK_LOCAL_DEFAULTS.roles.slice();
  return {
    enabled: src.enabled === true,
    provider: src.provider === 'ollama' ? 'ollama' : 'openai',
    baseUrl: typeof src.baseUrl === 'string' && src.baseUrl.trim() ? src.baseUrl.replace(/\/+$/, '') : PEAK_LOCAL_DEFAULTS.baseUrl,
    apiKeyEnv: typeof src.apiKeyEnv === 'string' && src.apiKeyEnv.trim() ? src.apiKeyEnv.trim() : PEAK_LOCAL_DEFAULTS.apiKeyEnv,
    apiKey: typeof src.apiKey === 'string' ? src.apiKey : '',
    model: typeof src.model === 'string' && src.model.trim() ? src.model.trim() : PEAK_LOCAL_DEFAULTS.model,
    noThinking: src.noThinking !== false,
    think: src.think === true,
    timeoutMs: num(src.timeoutMs, PEAK_LOCAL_DEFAULTS.timeoutMs, 2000, 120000),
    maxChars: num(src.maxChars, PEAK_LOCAL_DEFAULTS.maxChars, 20, 600),
    numPredict: num(src.numPredict, PEAK_LOCAL_DEFAULTS.numPredict, 16, 800),
    temperature: Number.isFinite(Number(src.temperature))
      ? Math.min(2, Math.max(0, Number(src.temperature)))
      : PEAK_LOCAL_DEFAULTS.temperature,
    // 语气覆盖：persona 追加人设，styleExtra 追加风格要求（都会拼在硬约束之后）。
    // 上限防止一段粘贴进来的长文把 8K 窗口吃掉。
    persona: typeof src.persona === 'string' ? src.persona.trim().slice(0, 2000) : '',
    styleExtra: typeof src.styleExtra === 'string' ? src.styleExtra.trim().slice(0, 1000) : '',
    roles: roles.length ? roles : PEAK_LOCAL_DEFAULTS.roles.slice(),
    userIds: Array.isArray(src.userIds) ? src.userIds.map((u) => String(u).replace(/\D/g, '')).filter(Boolean) : [],
    replyToAll: src.replyToAll !== false,
    // replyToAll=true 时默认不要求被叫；显式配置 requireMention 仍以配置为准。
    requireMention: src.requireMention != null ? src.requireMention !== false : (src.replyToAll === false),
    minChars: num(src.minChars, PEAK_LOCAL_DEFAULTS.minChars, 0, 20),
    skipMediaOnly: src.skipMediaOnly !== false,
    maxRepliesPerMinute: num(src.maxRepliesPerMinute, PEAK_LOCAL_DEFAULTS.maxRepliesPerMinute, 1, 60),
    maxRepliesPerHour: num(src.maxRepliesPerHour, PEAK_LOCAL_DEFAULTS.maxRepliesPerHour, 1, 600),
    historyMessages: num(src.historyMessages, PEAK_LOCAL_DEFAULTS.historyMessages, 2, 40)
  };
}

/** QQ 群的 role 字段归一化：owner / admin / member / ''（未知）。 */
export function normalizeMemberRole(role) {
  const r = String(role ?? '').toLowerCase();
  if (r === 'owner' || r === 'creator') return 'owner';
  if (r === 'admin' || r === 'administrator') return 'admin';
  if (r === 'member') return 'member';
  return '';
}

/**
 * 是否让本地模型接管这一条群消息。
 * @param {{cfg:any, role:string, mentioned:boolean}} p
 * @returns {{ ok:boolean, reason:string }}
 */
export function shouldPeakLocal({ cfg, role, mentioned, uid = '', text = '', hasMedia = false } = {}) {
  const c = cfg || PEAK_LOCAL_DEFAULTS;
  if (!c.enabled) return { ok: false, reason: '未启用' };
  if (c.replyToAll !== false) {
    // 高峰期回复所有人（白名单群由调用方保证）：只保留「别接无意义话」的护栏。
    // 只算「有内容的字符」：纯标点/空格/emoji 不算，避免「。。。」这种被当成有意义的话。
    const meaningful = String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
    const len = meaningful.length;
    if (hasMedia && c.skipMediaOnly && len < Math.max(1, c.minChars)) {
      return { ok: false, reason: '纯媒体（无文字）不接话' };
    }
    if (len < Math.max(1, c.minChars)) return { ok: false, reason: `消息太短（${len} 字）不接话` };
    return { ok: true, reason: 'replyToAll：回复所有人' };
  }
  const userId = String(uid ?? '').replace(/\D/g, '');
  if (userId && Array.isArray(c.userIds) && c.userIds.includes(userId)) {
    if (c.requireMention && !mentioned) return { ok: false, reason: '没有叫机器人' };
    return { ok: true, reason: '显式放行用户' };
  }
  const r = normalizeMemberRole(role);
  if (!r) return { ok: false, reason: '拿不到成员角色' };
  if (!c.roles.includes(r)) return { ok: false, reason: `角色 ${r} 不在允许名单` };
  if (c.requireMention && !mentioned) return { ok: false, reason: '没有叫机器人' };
  return { ok: true, reason: '允许' };
}

/** ollama /api/chat 请求体。think 显式传布尔：qwen3 不传会默认思考，正文经常为空。 */
export function buildPeakChatBody({ cfg, messages, keepAlive } = {}) {
  const c = cfg || PEAK_LOCAL_DEFAULTS;
  return {
    model: c.model,
    messages: Array.isArray(messages) ? messages : [],
    stream: false,
    think: c.think === true,
    options: { num_predict: c.numPredict, temperature: c.temperature },
    ...(keepAlive ? { keep_alive: keepAlive } : {})
  };
}

/** 从 ollama 响应里取正文；空正文视为失败（返回 ''）。 */
export function parsePeakReply(json) {
  const openai = json?.choices?.[0]?.message?.content;
  const text = String(openai ?? json?.message?.content ?? '').trim();
  return text;
}

/**
 * 组装一次生成请求（不含 fetch）：OpenAI 兼容 /chat/completions 或本地 ollama /api/chat。
 * @returns {{ url:string, headers:Record<string,string>, body:any }}
 */
export function buildPeakRequest({ cfg, messages, apiKey = '' } = {}) {
  const c = cfg || PEAK_LOCAL_DEFAULTS;
  if (c.provider === 'ollama') {
    return { url: `${c.baseUrl}/api/chat`, headers: { 'content-type': 'application/json' }, body: buildPeakChatBody({ cfg: c, messages }) };
  }
  const key = apiKey || c.apiKey || (c.apiKeyEnv ? process.env[c.apiKeyEnv] : '') || '';
  const body = {
    model: c.model,
    messages: Array.isArray(messages) ? messages : [],
    temperature: c.temperature,
    max_tokens: c.numPredict,
    stream: false
  };
  if (c.noThinking) body.thinking = { type: 'disabled' };
  return {
    url: `${c.baseUrl}/chat/completions`,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body
  };
}

/**
 * 高峰期本地模型的固定语气底线。
 *
 * 为什么要写死而不是只靠「人格」：8B 小模型很容易把「有情绪」演成命令/抱怨
 * （实测原话：「被@了还活着，刚被你们吵醒，别吵了行不行」）。这段 prompt 把
 * 「温和、不命令、不评价、不阴阳」写成硬约束，再由 persona/styleExtra 追加个性。
 */
export const PEAK_LOCAL_TONE_PROMPT = [
  '你是 QQ 群里的「大肥鱼小姐」——群里那个温和、有点小个性的女生，不是客服也不是助手。',
  '',
  '说话方式：',
  '· 口语、简短：1~2 句话，最多不超过 60 字；不用 Markdown、不用列表、不解释你在做什么。',
  '· 只输出要发到群里的那一句话：不加引号、不加「回复：」前缀、不写「名字：内容」。',
  '',
  '语气底线（任何情况都要遵守）：',
  '· 不命令别人、不评价别人、不阴阳怪气、不教育人。',
  '· 不用「别吵了 / 闭嘴 / 烦 / 滚 / 傻」这类词，也不用「你们别…」「都给我…」「冷静点」这种命令/指挥句。',
  '· 即使别人先用了攻击性的词，也不要复述、不要跟着用；用温和的话带过。',
  '· 最后一条消息如果本身在骂人/吵架，不要复述它的话、不要去劝架、不要说「冷静点」；',
  '  用一句轻松的话带过，或者只说「我在呢」。',
  '· 不要说「被你们吵醒」「你们吵到我了」这类抱怨；尽量不用「你们」指代群友，用「大家」或省略。',
  '· 被重复 @ 时软性回应（「我在呀～」「怎么啦」），不要抱怨、不要不耐烦。',
  '· 可以自嘲、可以接梗，保留一点个性，但不能冲、不能怼人。',
  '',
  '示例（照这个语气）：',
  '群友：@大肥鱼小姐 高峰期你还活着吗',
  '你：在的在的～怎么啦？',
  '群友：@大肥鱼小姐 @大肥鱼小姐 在吗在吗',
  '你：我在呀～',
  '群友：你俩别吵了行不行，烦死了',
  '你：我在呢～',
  '',
  '示例只示范语气和长度，不要原样照抄；按当前聊天内容自然回一句。',
  '不要复读：上面聊天记录里「我」说过的话不要再重复，也不要用同样的开头（「我在呢～」连发两次就算复读）。',
  '只回应最后一条：更早的话题、更早的问题都不用管，不要把几条消息拼起来回答。',
  '现在按上面的方式，自然回一句。'
].join('\n');

/** 组装给本地模型的对话（system 语气底线 + 可配置人设/风格 + 最近 N 条群聊 + 当前这句）。 */
export function buildPeakMessages({ personaText = '', recent = [], incomingText = '', cfg } = {}) {
  const c = cfg || PEAK_LOCAL_DEFAULTS;
  const lines = [];
  for (const m of (Array.isArray(recent) ? recent : []).slice(-Math.max(1, c.historyMessages - 1))) {
    const who = m?.isSelf ? '我' : String(m?.sender || '群友').slice(0, 16);
    const body = String(m?.plain ?? m?.text ?? '').replace(/\s+/g, ' ').trim();
    if (body) lines.push(`${who}：${body.slice(0, 120)}`);
  }
  const incoming = String(incomingText || '').replace(/\s+/g, ' ').trim();
  if (incoming) lines.push(`群友：${incoming.slice(0, 200)}`);
  // persona/styleExtra 拼在硬约束之后：既保留底线，又允许操作者追加人设与口癖。
  // 兼容旧参数 personaText（桥接传的是同一份配置）。
  const persona = String(personaText || c.persona || '').trim().slice(0, 2000);
  const styleExtra = String(c.styleExtra || '').trim().slice(0, 1000);
  let system = PEAK_LOCAL_TONE_PROMPT;
  if (persona) system += `\n\n【补充人设】${persona}`;
  if (styleExtra) system += `\n\n【额外风格】${styleExtra}`;
  const user = lines.length
    ? `下面是群里刚才的聊天（最后一条是要你回应的）：\n${lines.join('\n')}\n\n直接给出你要发到群里的那一句话。`
    : '群里有人叫了你一声，但你没看到具体内容。自然接一句。';
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

/**
 * 本地回复限频（进程内存储，纯函数便于单测）。
 * @param {Map<string, {minute:number, hour:number, minuteAt:number, hourAt:number}>} store
 * @returns {{ ok:boolean, reason:string }}
 */
export function consumePeakQuota(store, key, { now = Date.now(), perMinute = 6, perHour = 60 } = {}) {
  const k = String(key || '');
  if (!k) return { ok: false, reason: 'key 为空' };
  const cur = store.get(k) || { minuteStart: 0, minute: 0, hourStart: 0, hour: 0 };
  const next = { ...cur };
  if (!next.minuteStart || now - next.minuteStart >= 60000) { next.minuteStart = now; next.minute = 0; }
  if (!next.hourStart || now - next.hourStart >= 3600000) { next.hourStart = now; next.hour = 0; }
  if (next.minute >= perMinute) { store.set(k, next); return { ok: false, reason: `每分钟上限 ${perMinute}` }; }
  if (next.hour >= perHour) { store.set(k, next); return { ok: false, reason: `每小时上限 ${perHour}` }; }
  next.minute += 1; next.hour += 1;
  store.set(k, next);
  return { ok: true, reason: '' };
}
