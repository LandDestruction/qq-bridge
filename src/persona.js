// 私聊自定义人设（per-session persona）的纯逻辑。
//
// 为什么单独成文件：路由处理函数挂在 main() 的 HTTP server 闭包里，没法直接单测；
// 而这里的判定都有关键边界——只准 private 会话、字数上限、reset 语义、空文本拒绝。
// 抽成纯函数后 `scripts/test-persona.mjs` 可以逐条覆盖，不必起桥接进程。
//
// 注入点在 bridge.js：
//   · POST /api/socialV2/set-persona  → personaKeyError / parsePersonaRequest / personaMaxChars
//   · 状态快照里的 persona.maxChars    → personaMaxChars

export const PERSONA_DEFAULT_MAX_CHARS = 2000;
export const PERSONA_MAX_CHARS_CAP = 6000;
export const PERSONA_MIN_CHARS = 100;

/**
 * 人设文本的字数上限（config.json 的 socialV2.personaMaxChars）。
 * 非法值一律回落到默认 2000；合法值夹在 [100, 6000]。
 */
export function personaMaxChars(configured) {
  const n = Number(configured);
  return Number.isFinite(n) && n > 0
    ? Math.min(PERSONA_MAX_CHARS_CAP, Math.max(PERSONA_MIN_CHARS, Math.round(n)))
    : PERSONA_DEFAULT_MAX_CHARS;
}

/**
 * 校验会话 key 能否设人设。
 * 只有私聊可以：群聊是公共场合，不能让某个群友改掉机器人对全群的人设。
 * @returns {null | { status: number, error: string }} 合法返回 null
 */
export function personaKeyError(key) {
  const match = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!match) return { status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
  if (match[1] !== 'private') return { status: 403, error: '私聊自定义人设仅在 private 会话可用' };
  return null;
}

/**
 * 解析一次 set-persona 请求（不含鉴权；鉴权仍留在路由里）。
 * @param {{ persona?: unknown, reset?: unknown }} body 请求体
 * @param {number} [maxChars] 上限，一般传 personaMaxChars(cfg...)
 * @param {(raw: unknown) => string} [normalize] 文本归一化（复用桥接的 normalizeInitialPromptText）
 */
export function parsePersonaRequest(body, maxChars = PERSONA_DEFAULT_MAX_CHARS, normalize = (raw) => String(raw ?? '').trim()) {
  const source = body && typeof body === 'object' ? body : {};
  if (source.reset === true) return { action: 'reset' };
  const raw = source.persona === undefined || source.persona === null ? '' : source.persona;
  const text = String(normalize(raw) ?? '').slice(0, personaMaxChars(maxChars));
  if (!text) return { action: 'error', status: 400, error: 'persona 不能为空（reset=true 可清除）' };
  return { action: 'set', text };
}
