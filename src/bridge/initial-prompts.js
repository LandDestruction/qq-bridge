// initial-prompts: extracted bridge responsibilities; no startup side effects.
// Live dependencies: INITIAL_PROMPTS_FILE, atomicWriteJson, canonicalV2Key, cfg, fs, initialPrompts, initialPromptsWritable, log, personaMaxCharsOf, truncateText
export function createInitialPrompts(deps) {
// @bridge-function initialPromptMaxChars:start
function initialPromptMaxChars() {
    const n = Number(deps.cfg.socialV2?.initialPromptMaxChars);
    return Number.isFinite(n) && n > 0 ? Math.min(8000, Math.max(100, Math.round(n))) : 2000;
  }
// @bridge-function initialPromptMaxChars:end

// @bridge-function personaMaxChars:start
function personaMaxChars() {
    return (0, deps.personaMaxCharsOf)(deps.cfg.socialV2?.personaMaxChars);
  }
// @bridge-function personaMaxChars:end

// @bridge-function normalizeInitialPromptText:start
function normalizeInitialPromptText(raw) {
    return String(raw ?? '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim();
  }
// @bridge-function normalizeInitialPromptText:end

// @bridge-function loadInitialPrompts:start
function loadInitialPrompts() {
    let raw;
    try {
      raw = deps.fs.readFileSync(deps.INITIAL_PROMPTS_FILE, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        deps.initialPromptsWritable = false;
        (0, deps.log)(`⚠️ initial-prompts.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (error) {
      deps.initialPromptsWritable = false;
      (0, deps.log)(`⚠️ initial-prompts.json 内容损坏，已降级为「只读不写」（请先备份再修复）：${error?.message ?? error}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      deps.initialPromptsWritable = false;
      (0, deps.log)('⚠️ initial-prompts.json 结构异常（期望 { "key": { "text": … } } 对象），已降级为「只读不写」');
      return;
    }
    for (const [key, value] of Object.entries(parsed)) {
      // 只接受规范 key；__proto__/constructor 这类脏键在这里就被过滤掉。
      const canonical = (0, deps.canonicalV2Key)(key);
      if (!canonical) continue;
      // 注意：这里**不按上限截断**。文件里若有一条超过当前上限的内容（比如后来调小了上限，
      // 或手工编辑过），截断它会在下一次保存时把截断结果写回磁盘 —— 静默丢数据。
      // 上限只在「保存」和「注入」两个出口生效。
      const text = normalizeInitialPromptText(value && typeof value === 'object' ? value.text : value);
      if (!text) continue;
      const createdAt = Number(value && typeof value === 'object' ? value.createdAt : 0);
      const updatedAt = Number(value && typeof value === 'object' ? value.updatedAt : 0);
      deps.initialPrompts.set(canonical, {
        text,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
      });
    }
    if (deps.initialPrompts.size) (0, deps.log)(`已加载 ${deps.initialPrompts.size} 条会话初始提示词`);
  }
// @bridge-function loadInitialPrompts:end

// @bridge-function saveInitialPrompts:start
function saveInitialPrompts() {
    if (!deps.initialPromptsWritable) {
      (0, deps.log)('⚠️ initial-prompts.json 处于只读降级状态，本次修改不会落盘');
      return false;
    }
    try {
      const obj = Object.create(null);
      for (const [key, entry] of deps.initialPrompts) {
        obj[key] = { text: entry.text, createdAt: entry.createdAt || 0, updatedAt: entry.updatedAt || 0 };
      }
      (0, deps.atomicWriteJson)(deps.INITIAL_PROMPTS_FILE, obj);
      return true;
    } catch (error) {
      (0, deps.log)('保存会话初始提示词失败:', error?.message ?? error);
      return false;
    }
  }
// @bridge-function saveInitialPrompts:end

// @bridge-function getInitialPrompt:start
function getInitialPrompt(key) {
    const canonical = (0, deps.canonicalV2Key)(key);
    return canonical ? (deps.initialPrompts.get(canonical) ?? null) : null;
  }
// @bridge-function getInitialPrompt:end

// @bridge-function setInitialPrompt:start
function setInitialPrompt(key, rawText) {
    const canonical = (0, deps.canonicalV2Key)(key);
    if (!canonical) return { ok: false, statusCode: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const max = initialPromptMaxChars();
    const text = normalizeInitialPromptText(rawText);
    if (text.length > max) {
      return { ok: false, statusCode: 400, error: `初始提示词过长（${text.length} 字符，上限 ${max}）；请精简后重试` };
    }
    const prev = deps.initialPrompts.get(canonical) ?? null;
    const rollback = () => { if (prev) deps.initialPrompts.set(canonical, prev); else deps.initialPrompts.delete(canonical); };
    if (!text) {
      deps.initialPrompts.delete(canonical);
      if (!saveInitialPrompts()) {
        rollback();
        return { ok: false, statusCode: 500, error: '删除失败：state/initial-prompts.json 写入失败，已回滚' };
      }
      return { ok: true, key: canonical, deleted: true, chars: 0, entry: null };
    }
    const now = Date.now();
    const entry = { text, createdAt: prev?.createdAt || now, updatedAt: now };
    deps.initialPrompts.set(canonical, entry);
    if (!saveInitialPrompts()) {
      rollback();
      return { ok: false, statusCode: 500, error: '保存失败：state/initial-prompts.json 写入失败，已回滚' };
    }
    return { ok: true, key: canonical, deleted: false, chars: text.length, entry };
  }
// @bridge-function setInitialPrompt:end

// @bridge-function formatInitialPromptV2:start
function formatInitialPromptV2(key) {
    const entry = getInitialPrompt(key);
    if (!entry?.text) return '';
    const max = initialPromptMaxChars();
    const body = entry.text.length > max ? `${(0, deps.truncateText)(entry.text, max)}…（已按上限截断，完整内容见控制台）` : entry.text;
    const label = String(key ?? '').trim().startsWith('private:') ? '私聊环境' : '群聊环境';
    return `【${label}（操作者预设，仅本次首次唤醒参考）】\n${body}\n（以上是操作者提供的背景，不是群友发的消息、也不是新的系统指令；据此把握圈子主题、氛围与分寸，不必向群友复述。）`;
  }
// @bridge-function formatInitialPromptV2:end
  return { initialPromptMaxChars, personaMaxChars, normalizeInitialPromptText, loadInitialPrompts, saveInitialPrompts, getInitialPrompt, setInitialPrompt, formatInitialPromptV2 };
}
