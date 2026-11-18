// config-io: extracted bridge responsibilities; no startup side effects.
// Live dependencies: ACTIVITY_LOG, AbortSignal, MODE_INPUT_ALIASES, ROOT, STATE_DIR, crypto, fetch, fs, hardenDir, log, manualDirCommand, path, stateDirHardened
export function createConfigIo(deps) {
// @bridge-function normalizeModeInput:start
function normalizeModeInput(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return Object.prototype.hasOwnProperty.call(deps.MODE_INPUT_ALIASES, key) ? deps.MODE_INPUT_ALIASES[key] : null;
}
// @bridge-function normalizeModeInput:end

// @bridge-function settingFromDshNamespace:start
function settingFromDshNamespace(ns, key) {
  if (!ns || typeof ns !== 'object') return undefined;
  for (const layer of [ns.user, ns.value]) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue;
    if (Object.prototype.hasOwnProperty.call(layer, key) && layer[key] !== undefined) return layer[key];
  }
  return undefined;
}
// @bridge-function settingFromDshNamespace:end

// @bridge-function readJsonSafe:start
function readJsonSafe(file, fallback, required = false) {
  try {
    let text = deps.fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}
// @bridge-function readJsonSafe:end

// @bridge-function readConfigObject:start
function readConfigObject(file) {
  const parsed = readJsonSafe(file, null, true);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
    throw new Error(`config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`);
  }
  return parsed;
}
// @bridge-function readConfigObject:end

// @bridge-function renameWithRetry:start
function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      deps.fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      // 同步忙等一小会儿：调用点大多在启动/收尾路径，不值得为它改成异步。
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch {}
    }
  }
  throw lastError;
}
// @bridge-function renameWithRetry:end

// @bridge-function atomicWriteJson:start
function atomicWriteJson(file, obj) {
  deps.fs.mkdirSync(deps.path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${deps.crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    deps.fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    // 失败时别把随机名临时文件留在 state/ 里当垃圾。
    try { deps.fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}
// @bridge-function atomicWriteJson:end

// @bridge-function atomicWriteText:start
function atomicWriteText(file, text) {
  deps.fs.mkdirSync(deps.path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${deps.crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    deps.fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { deps.fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}
// @bridge-function atomicWriteText:end

// @bridge-function safeFetchJsonCompat:start
async function safeFetchJsonCompat(urlOrReq, opts = {}) {
  const url = typeof urlOrReq === 'string' ? urlOrReq : urlOrReq.url;
  const method = opts.method || (typeof urlOrReq === 'object' ? urlOrReq.method : 'GET') || 'GET';
  const headers = opts.headers || (typeof urlOrReq === 'object' ? urlOrReq.headers : {}) || {};
  const body = opts.body ?? (typeof urlOrReq === 'object' ? urlOrReq.body : undefined);
  const timeoutMs = Number(opts.timeoutMs) || 120000;
  const res = await (0, deps.fetch)(url, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    signal: deps.AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    // 错误体里可能带 key 之类敏感信息，只截一小段，且由调用方再做打码。
    try { const t = await res.text(); if (t) err.message = `HTTP ${res.status}: ${t.slice(0, 200)}`; } catch {}
    throw err;
  }
  return await res.json();
}
// @bridge-function safeFetchJsonCompat:end

// @bridge-function persistDshBaseUrl:start
function persistDshBaseUrl(baseUrl) {
  const file = deps.path.join(deps.ROOT, 'config.json');
  try {
    const cfgFile = readConfigObject(file);
    const next = { ...(cfgFile.dsh && typeof cfgFile.dsh === 'object' ? cfgFile.dsh : {}), baseUrl };
    cfgFile.dsh = next;
    atomicWriteJson(file, cfgFile);
  } catch (error) {
    try { (0, deps.log)(`写回 DSH 地址失败：${error?.message ?? error}`); } catch {}
  }
}
// @bridge-function persistDshBaseUrl:end

// @bridge-function persistCorrectedModel:start
function persistCorrectedModel(provider, model, from) {
  const file = deps.path.join(deps.ROOT, 'config.json');
  try {
    const cfgFile = readConfigObject(file);
    const cur = cfgFile.dsh && typeof cfgFile.dsh === 'object' ? cfgFile.dsh : {};
    if (cur.provider === provider && cur.model === model) return;
    // 备份：写坏配置的代价太高（白名单、人格、工具开关全在里面）。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${file}.bak-${stamp}`;
    try { deps.fs.copyFileSync(file, backup); } catch (error) { (0, deps.log)(`模型纠正：备份 config.json 失败（继续写回）：${error?.message ?? error}`); }
    cfgFile.dsh = { ...cur, provider, model };
    atomicWriteJson(file, cfgFile);
    (0, deps.log)(`模型纠正：config.json 已写回 ${provider}/${model}（原 ${from}；备份 ${deps.path.basename(backup)}）`);
  } catch (error) {
    (0, deps.log)(`模型纠正：写回 config.json 失败（仅影响启动速度，功能不受影响）：${error?.message ?? error}`);
  }
}
// @bridge-function persistCorrectedModel:end

// @bridge-function loadOrCreateConsoleToken:start
function loadOrCreateConsoleToken() {
  const tokenFile = deps.path.join(deps.STATE_DIR, 'console-token');
  try {    const existing = deps.fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = deps.crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}
// @bridge-function loadOrCreateConsoleToken:end

// @bridge-function loadOrCreateGuestToken:start
// 只读访客令牌（BOOTH 素材库 L6）：和 console-token 一样，第一次用就生成并落盘，
// 之后一直不变；想作废就删掉 state/console-guest-token（重启后重新生成）。
function loadOrCreateGuestToken() {
  const tokenFile = deps.path.join(deps.STATE_DIR, 'console-guest-token');
  try {
    const existing = deps.fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = deps.crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}
// @bridge-function loadOrCreateGuestToken:end

// @bridge-function hardenStateDirAcl:start
function hardenStateDirAcl() {
  const result = (0, deps.hardenDir)(deps.STATE_DIR);
  if (result.ok) {
    deps.stateDirHardened = true;
    return;
  }
  deps.stateDirHardened = false;
  if (process.platform !== 'win32') {
    (0, deps.log)(`⚠️ 收紧 state/ 权限失败（chmod 700）：${result.detail}`);
    return;
  }
  (0, deps.log)('⚠️ 未能收紧 state/ 目录权限：本机任何已登录用户都可能读到控制台令牌与 QQ 聊天记录。');
  (0, deps.log)(`   原因：${String(result.detail).slice(0, 300)}`);
  (0, deps.log)('   改 ACL 需要管理员权限。请用**管理员身份**打开终端后执行下面这几条命令（或在控制台「访问与安全」页点按钮）：');
  (0, deps.log)(`   ${(0, deps.manualDirCommand)(deps.STATE_DIR)}`);
}
// @bridge-function hardenStateDirAcl:end

// @bridge-function readActivityTail:start
function readActivityTail(n) {
  try {
    const raw = deps.fs.readFileSync(deps.ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}
// @bridge-function readActivityTail:end

// @bridge-function listRoles:start
function listRoles() {
  try {
    return deps.fs.readdirSync(deps.path.join(deps.ROOT, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}
// @bridge-function listRoles:end
  return { normalizeModeInput, settingFromDshNamespace, readJsonSafe, readConfigObject, renameWithRetry, atomicWriteJson, atomicWriteText, safeFetchJsonCompat, persistDshBaseUrl, persistCorrectedModel, loadOrCreateConsoleToken, loadOrCreateGuestToken, hardenStateDirAcl, readActivityTail, listRoles };
}
