// tool-journal: extracted bridge responsibilities; no startup side effects.
// Live dependencies: FEEDBACK_FILE, SENSITIVE_ARG_KEYS, TOOL_LOG_FILE, appendToolLogFile, atomicWriteJson, fs, log, readJsonSafe, redactSensitiveText, truncateText
export function createToolJournal(deps) {
// @bridge-function readFeedbackEntries:start
function readFeedbackEntries() {
    const data = (0, deps.readJsonSafe)(deps.FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }
// @bridge-function readFeedbackEntries:end

// @bridge-function appendFeedbackEntry:start
function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: (0, deps.redactSensitiveText)(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    (0, deps.atomicWriteJson)(deps.FEEDBACK_FILE, list);
  }
// @bridge-function appendFeedbackEntry:end

// @bridge-function readToolLog:start
function readToolLog(limit = 200) {
    try {
      const raw = deps.fs.readFileSync(deps.TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }
// @bridge-function readToolLog:end

// @bridge-function appendToolLog:start
function appendToolLog(entry) {
    try {
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = (0, deps.redactSensitiveText)(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = (0, deps.redactSensitiveText)(safeEntry.args);
        }
      }
      // 用内存计数上限的追加器：不再「append 完再读回整个文件数行数」——
      // 那个写法在 2000 行（约 650KB）时单次要 15ms，而每次工具调用要写两条。
      (0, deps.appendToolLogFile)(`${JSON.stringify(safeEntry)}\n`);
    } catch (error) {
      (0, deps.log)('写入工具调用日志失败:', error?.message ?? error);
    }
  }
// @bridge-function appendToolLog:end

// @bridge-function redactSensitive:start
function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = deps.SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return (0, deps.redactSensitiveText)(obj);
    return obj;
  }
// @bridge-function redactSensitive:end

// @bridge-function sanitizeToolArgs:start
function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = (0, deps.truncateText)(text, 2000) + '…(truncated)';
    return text;
  }
// @bridge-function sanitizeToolArgs:end
  return { readFeedbackEntries, appendFeedbackEntry, readToolLog, appendToolLog, redactSensitive, sanitizeToolArgs };
}
