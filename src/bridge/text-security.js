// text-security: extracted bridge responsibilities; no startup side effects.
// Live dependencies: CONVERSATION_TOKENS, KNOWN_AGENT_TOKENS, MAX_KNOWN_AGENT_TOKENS, REASONING_EFFORT_OPTIONS, ROLE_STATE_FILE, SEND_TOOL_RE, SENSITIVE_RE, appendActivityLog, atomicWriteJson, localClock, readJsonSafe
export function createTextSecurity(deps) {
// @bridge-function isSilentMarker:start
function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}
// @bridge-function isSilentMarker:end

// @bridge-function isSendToolName:start
function isSendToolName(name) {
  return deps.SEND_TOOL_RE.test(String(name ?? ''));
}
// @bridge-function isSendToolName:end

// @bridge-function rememberAgentToken:start
function rememberAgentToken(key, token) {
  const tk = String(token ?? '');
  if (!tk) return;
  const prev = deps.CONVERSATION_TOKENS.get(key);
  if (prev && prev[0] === tk) return;
  const next = prev ? [tk, prev[0]] : [tk];
  if (prev && prev[1]) deps.KNOWN_AGENT_TOKENS.delete(prev[1]);
  deps.CONVERSATION_TOKENS.set(key, next);
  deps.KNOWN_AGENT_TOKENS.add(tk);
  if (deps.KNOWN_AGENT_TOKENS.size > deps.MAX_KNOWN_AGENT_TOKENS) {
    // 只淘汰已经不属于任何会话**当前代**的 token（即更早的旧代）。
    // 当前代一个都不能丢：脱敏漏掉活令牌就是把令牌发到 QQ，比内存占用严重得多。
    const live = new Set([...deps.CONVERSATION_TOKENS.values()].map((pair) => pair[0]));
    for (const old of [...deps.KNOWN_AGENT_TOKENS]) {
      if (deps.KNOWN_AGENT_TOKENS.size <= deps.MAX_KNOWN_AGENT_TOKENS) break;
      if (!live.has(old)) deps.KNOWN_AGENT_TOKENS.delete(old);
    }
  }
}
// @bridge-function rememberAgentToken:end

// @bridge-function forgetAgentToken:start
function forgetAgentToken(key) {
  const prev = deps.CONVERSATION_TOKENS.get(key);
  if (!prev) return;
  for (const tk of prev) deps.KNOWN_AGENT_TOKENS.delete(tk);
  deps.CONVERSATION_TOKENS.delete(key);
}
// @bridge-function forgetAgentToken:end

// @bridge-function normalizeReasoningEffort:start
function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!deps.REASONING_EFFORT_OPTIONS.includes(v)) {
    throw new Error(`思考强度只能是 ${deps.REASONING_EFFORT_OPTIONS.join(' / ')}`);
  }
  return v;
}
// @bridge-function normalizeReasoningEffort:end

// @bridge-function redactSensitiveText:start
function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = deps.SENSITIVE_RE.flags.includes('g') ? deps.SENSITIVE_RE.flags : deps.SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(deps.SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of deps.KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}
// @bridge-function redactSensitiveText:end

// @bridge-function escapeCqText:start
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}
// @bridge-function escapeCqText:end

// @bridge-function unquoteJsonString:start
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}
// @bridge-function unquoteJsonString:end

// @bridge-function appendActivity:start
function appendActivity(line) {
  // 本地时间：此前用 toISOString() 写的是 UTC，日志时间与本地时间差 8 小时，排查时对不上。
  (0, deps.appendActivityLog)(`[${(0, deps.localClock)()}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
}
// @bridge-function appendActivity:end

// @bridge-function readRoleState:start
function readRoleState() {
  return (0, deps.readJsonSafe)(deps.ROLE_STATE_FILE, { role: null, mode: 'active' });
}
// @bridge-function readRoleState:end

// @bridge-function writeRoleState:start
function writeRoleState(role, mode) {
  (0, deps.atomicWriteJson)(deps.ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}
// @bridge-function writeRoleState:end

// @bridge-function sanitizeRoleName:start
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}
// @bridge-function sanitizeRoleName:end

// @bridge-function normalizeOwnerQQ:start
function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}
// @bridge-function normalizeOwnerQQ:end

// @bridge-function normalizeIdList:start
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}
// @bridge-function normalizeIdList:end
  return { isSilentMarker, isSendToolName, rememberAgentToken, forgetAgentToken, normalizeReasoningEffort, redactSensitiveText, escapeCqText, unquoteJsonString, appendActivity, readRoleState, writeRoleState, sanitizeRoleName, normalizeOwnerQQ, normalizeIdList };
}
