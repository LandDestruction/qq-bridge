// console/config-admin: 控制台通用配置读写（C 档）。无启动副作用，全部逻辑按请求触发。
//
// 为什么需要它：控制台二期要开放「改业务配置」，但 config.json 里有凭据
// （dsh/snowluma 的连接令牌、consoleToken、imagegen 的 apiKey）和访问控制
// （allow/deny/ownerQQ）。任何「整份配置读写」端点只要漏一处，就等于把管理凭据
// 交给页面（或让页面把别人并发写入的改动整段覆盖）。
//
// 边界（写死在代码里，不从配置读，避免被配置改写）：
//   1) 只认白名单根字段；白名单外的路径 POST 一律 400，不做「未知字段静默忽略」。
//   2) 任何层级的敏感键（token/secret/apiKey/password/authHeader…）既不返回也不接受；
//      400 只回字段名，不回显值。
//   3) 写盘走 deps.updateConfigFile（读盘-合并-写），不是「读内存快照整份重写」：
//      两次并发 patch 各自在磁盘最新内容上应用，不会互相覆盖。
//   4) restartRequired 直接复用 src/config-reload.js 的 RESTART_REQUIRED_PATHS，不另造表。
// Live dependencies: RESTART_REQUIRED_PATHS, ROOT, atomicWriteJson, cfg, log, path, readConfigObject, reloadConfigFromDisk, updateConfigFile
const CONFIG_ADMIN_ROOTS = Object.freeze([
  // 必须重启才生效的「非凭据」进程/连接字段：开放它们，才让 restartRequired 有意义
  // （consolePort / sessionCwd / agentPreset 正是 RESTART_REQUIRED_PATHS 里的非凭据项）。
  'agentPreset', 'consolePort', 'sessionCwd',
  // 业务字段
  'socialV2', 'social', 'stt', 'contextBudget', 'budget',
  'imagegen', 'webSearch', 'fileArchive', 'observe',
  // 素材库开关：只开 autoExtract 这一个叶子（extractKeepZip 是预留位，前端不该拨）。
  'library',
  // P1 任意 agent 接入：agent.type/baseUrl/model/timeoutMs/maxToolRounds 可读可写；
  // apiKey 只写不读（见下面的 AGENT_API_KEY_PATH），GET 只回 hasApiKey 布尔。
  'agent'
]);
const CONFIG_ADMIN_SENSITIVE = /token|secret|password|passwd|api[-_]?key|auth[-_]?(?:header|prefix|token)|credential/i;
const CONFIG_ADMIN_FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const CONFIG_ADMIN_MAX_DEPTH = 10;
const CONFIG_ADMIN_MAX_LIST = 800;
// 「允许的模型」是唯一一条需要「格式校验 + 写盘前归一」的叶子：它决定桥接给聊天选哪些模型，
// 写错一个词就等于把模型锁死（比如写成 `deepseek-flash` 没有 provider 前缀，匹配永远失败）。
// 因此单独开一条校验通道：接受数组或逗号分隔字符串，逐项 trim/去空，只认 `provider/model` 或 `*`
// （两段都允许 `*` 通配）。归一后的形状与 config-load.js 的 normalizeAllowedProviderModels 一致
// （trim + 去空），只是这里多了格式校验；本文件要能在 bridge-source 的 VM 里跑，不能 import。
const CONFIG_ADMIN_ALLOWED_MODELS_PATH = 'socialV2.modelRouting.allowedProviderModels';
const CONFIG_ADMIN_ALLOWED_MODEL_RE = /^(?:\*|[^\s/]+\/[^\s/]+)$/;
// 磁盘上没有这条键时的展示值：与 config-load 的默认白名单保持一致（2026-10-29 放宽到 deepseek 系）。
const CONFIG_ADMIN_ALLOWED_MODELS_FALLBACK = Object.freeze(['*/*deepseek*']);
// 下载完自动解压：config.json 里通常还没有 library 段（默认值写在 config-load.js），
// 不补白名单前端就只能显示「后端尚未开放」。只开放这一条，且写入值必须是布尔。
const CONFIG_ADMIN_LIBRARY_AUTOEXTRACT_PATH = 'library.autoExtract';
// 私聊加好友提示 + 纯净模式：默认值写在 config-load.js 的 normalizePrivateHint / normalizePureMode 里，
// config.json 通常还没有这两个段。不在这里补叶子的话前端设置页永远看不到开关（和 allowedProviderModels 同一个坑）。
const CONFIG_ADMIN_SOCIAL_DEFAULT_PATHS = Object.freeze({
  'socialV2.private.addFriendHint.enabled': true,
  'socialV2.private.addFriendHint.afterMessages': 15,
  'socialV2.private.addFriendHint.cooldownMs': 86400000,
  'socialV2.pureMode.enabled': false
});
// agent 段（P1）：默认值写在 config-load.js 的 normalizeAgentRuntime 里，config.json 通常没有 agent 段。
// 不补叶子的话前端设置页拿不到这些路径；apiKey 敏感，只写不读（GET 回 hasApiKey 布尔，永不回明文）。
const CONFIG_ADMIN_AGENT_PATHS = Object.freeze({
  'agent.type': 'dsh',
  'agent.baseUrl': '',
  'agent.model': '',
  'agent.timeoutMs': 120000,
  'agent.maxToolRounds': 8
});
const CONFIG_ADMIN_AGENT_TYPES = Object.freeze(['dsh', 'openai', 'http']);
const CONFIG_ADMIN_AGENT_API_KEY_PATH = 'agent.apiKey';

/** 解析「允许的模型」写入值：数组或逗号分隔字符串 → 归一后的数组；有非法项时整单拒绝并指明是哪几项。 */
function configAdminParseAllowedModels(value) {
  const rawList = typeof value === 'string' ? value.split(',') : (Array.isArray(value) ? value : null);
  if (!rawList) return { ok: false, invalid: [`期望字符串数组或逗号分隔字符串，收到 ${typeof value}`] };
  const list = [];
  const invalid = [];
  for (const item of rawList) {
    if (typeof item !== 'string') { invalid.push(JSON.stringify(item)); continue; }
    const text = item.trim();
    if (!text) continue; // 逗号串里的空项（"a, ,b"）直接丢掉，不算错
    if (!CONFIG_ADMIN_ALLOWED_MODEL_RE.test(text)) { invalid.push(text); continue; }
    if (!list.includes(text)) list.push(text);
  }
  if (invalid.length) return { ok: false, invalid };
  return { ok: true, list };
}

// 整段覆盖保护：用一条 patch 把一个现成的对象整个换掉时，如果新值少了键就等于把别人的配置删了。
// 典型事故：`{patch:{"socialV2":{sticker:{...}}}}` 会把 socialV2 的其它 29 个键一起抹掉——
// 这种写法要拦住，提示改用叶子路径（socialV2.sticker.promptMaxStickers）。
function configAdminShrinkOf(before, next) {
  if (!configAdminIsObject(before) || !configAdminIsObject(next)) return null;
  const missing = Object.keys(before).filter((key) => !Object.prototype.hasOwnProperty.call(next, key));
  if (!missing.length) return null;
  return { total: Object.keys(before).length, missing };
}

function configAdminIsObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function configAdminSplit(dotted) {
  return String(dotted).split('.').map((part) => part.trim());
}
function configAdminIsSensitive(parts) {
  return parts.some((part) => !part || CONFIG_ADMIN_FORBIDDEN.has(part) || CONFIG_ADMIN_SENSITIVE.test(part));
}
// 只回「能安全展示」的那一层：剥掉敏感键、__proto__ 一类、超深结构，数组原样（元素里若含敏感键也剥）。
function configAdminSanitize(value, depth) {
  if (depth > CONFIG_ADMIN_MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value.slice(0, CONFIG_ADMIN_MAX_LIST)) {
      const clean = item !== null && typeof item === 'object' ? configAdminSanitize(item, depth + 1) : item;
      if (clean !== undefined) out.push(clean);
    }
    return out;
  }
  if (!configAdminIsObject(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || CONFIG_ADMIN_FORBIDDEN.has(key) || CONFIG_ADMIN_SENSITIVE.test(key)) continue;
    const clean = configAdminSanitize(item, depth + 1);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}
// 扁平叶子路径（数组/标量算叶子）：前端据此知道「这个键能被改」，而不是靠猜结构。
function configAdminCollectPaths(value, prefix, out) {
  if (out.length >= CONFIG_ADMIN_MAX_LIST) return;
  if (configAdminIsObject(value)) {
    const keys = Object.keys(value);
    if (!keys.length) { if (prefix) out.push(prefix); return; }
    for (const key of keys) configAdminCollectPaths(value[key], prefix ? `${prefix}.${key}` : key, out);
    return;
  }
  if (prefix) out.push(prefix);
}
// 值内部也要扫：patch 的值里若夹带敏感键（如 {"socialV2":{"seg":{"apiKey":"…"}}}），
// 落盘就等于把凭据写进 config.json 并被后续请求读出来，所以整单拒绝。
// 规则：数组/对象逐层下钻，键名命中 SENSITIVE 或保留名就拒（只回键名不回值）；
// 超过 CONFIG_ADMIN_MAX_DEPTH 也拒，不允许用超深结构把敏感键藏到扫描范围之外。
function configAdminInspectValue(value, depth) {
  if (depth > CONFIG_ADMIN_MAX_DEPTH) return { tooDeep: true };
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = configAdminInspectValue(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (!configAdminIsObject(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    if (!key || CONFIG_ADMIN_FORBIDDEN.has(key) || CONFIG_ADMIN_SENSITIVE.test(key)) return { key: key || '(空键名)' };
    const hit = configAdminInspectValue(item, depth + 1);
    if (hit) return hit;
  }
  return null;
}
function configAdminGetAt(root, parts) {
  let cur = root;
  for (const part of parts) {
    if (!configAdminIsObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}
function configAdminSetAt(root, parts, value) {
  let cur = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!configAdminIsObject(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}
// ── 首次设置向导（/api/setup）──────────────────────────────────────────────
// 安装包分发出去后，用户装完不能靠手改 config.json：这里给「装完还差什么」和
// 「一次写进去」的受控接口。写盘只碰叶子路径（ownerQQ / snowluma.httpUrl /
// snowluma.accessToken / allow.groups / allow.private / allow.privateOpen），
// 绝不整段覆盖（那会把别人的配置抹掉，见 configAdminShrinkOf 的护栏）。
const SETUP_ID_RE = /^\d{5,15}$/;
const SETUP_MAX_IDS = 60;
const SETUP_URL_RE = /^https?:\/\/[^\s/]+(?::\d{1,5})?(\/[^\s]*)?$/i;

/** 号码/群号数组归一：去空白、去重、只留 5~15 位数字，超长拒绝。 */
export function normalizeSetupIdList(value) {
  if (value === undefined) return { ok: true, ids: undefined };
  if (!Array.isArray(value)) return { ok: false, error: '名单必须是数组' };
  const out = [];
  for (const item of value) {
    const id = String(item ?? '').trim();
    if (!id) continue;
    if (!SETUP_ID_RE.test(id)) return { ok: false, error: `不是合法号码：${id.slice(0, 20)}` };
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > SETUP_MAX_IDS) return { ok: false, error: `一次最多 ${SETUP_MAX_IDS} 个，当前 ${out.length}` };
  return { ok: true, ids: out };
}

/** SnowLuma 地址归一：只接受 http(s)，拒绝带凭据的 URL 与超长串。 */
export function normalizeSetupUrl(value) {
  if (value === undefined) return { ok: true, url: undefined };
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: true, url: '' };
  if (raw.length > 200) return { ok: false, error: '地址太长' };
  if (!SETUP_URL_RE.test(raw)) return { ok: false, error: '地址要形如 http://127.0.0.1:3001' };
  if (/\/\/[^/]*@/.test(raw)) return { ok: false, error: '地址里不要带账号密码' };
  return { ok: true, url: raw.replace(/\/+$/, '') };
}

/** 把「现状」翻译成缺项清单：前端引导页只认这几条，别各写一套判断。 */
export function buildSetupGaps(view) {
  const gaps = [];
  const v = view || {};
  const owner = String(v.ownerQQ || '');
  if (!SETUP_ID_RE.test(owner) || owner === '100000000') {
    gaps.push({ key: 'ownerQQ', label: '你的 QQ 号（owner）', why: '决定谁可以用管理命令、谁的私聊直接放行' });
  }
  const groups = Array.isArray(v.allowGroups) ? v.allowGroups : [];
  const privates = Array.isArray(v.allowPrivate) ? v.allowPrivate : [];
  if (!groups.length && !privates.length) {
    gaps.push({ key: 'allow', label: '至少一个允许的群或私聊', why: '一个都不加的话，机器人在群里和私聊里都不会理人' });
  }
  if (!v.snowluma?.httpUrl) {
    gaps.push({ key: 'snowluma', label: 'SnowLuma（OneBot 网关）地址', why: 'QQ 消息从这里进出；没配就收不到也发不出' });
  } else if (v.snowluma?.reachable === false) {
    gaps.push({ key: 'snowluma', label: 'SnowLuma 连不上', why: String(v.snowluma?.error || '检查地址、accessToken，以及 SnowLuma 是否已启动并登录 QQ') });
  }
  if (v.dshReady === false) {
    gaps.push({ key: 'dsh', label: 'DeepSeek Harness 未连接', why: '机器人靠 DSH 思考；先把 DSH 起起来（地址 ' + String(v.dshUrl || '未配置') + '）' });
  }
  return gaps;
}

async function probeSnowlumaForSetup(deps) {
  const url = String(deps.cfg?.snowluma?.httpUrl || '').replace(/\/+$/, '');
  if (!url) return { httpUrl: '', reachable: false, error: '未配置' };
  const token = String(deps.cfg?.snowluma?.accessToken || '');
  try {
    const res = await (0, deps.fetch)(url + '/get_login_info', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: '{}',
      signal: deps.AbortSignal.timeout(3000)
    });
    const body = await res.json().catch(() => ({}));
    const info = body?.data ?? {};
    const ok = res.ok && body?.status === 'ok';
    return {
      httpUrl: url,
      reachable: ok,
      status: res.status,
      qq: info.user_id ?? null,
      nickname: info.nickname ?? null,
      ...(ok ? {} : { error: String(body?.wording || `HTTP ${res.status}`).slice(0, 120) })
    };
  } catch (error) {
    return { httpUrl: url, reachable: false, error: String(error?.message ?? error).slice(0, 120) };
  }
}

async function setupStatusView(deps) {
  const cfg = deps.cfg || {};
  const allow = cfg.allow || {};
  const snow = await probeSnowlumaForSetup(deps);
  const view = {
    ownerQQ: String(cfg.ownerQQ || ''),
    allowGroups: Array.isArray(allow.groups) ? allow.groups.map(String) : [],
    allowPrivate: Array.isArray(allow.private) ? allow.private.map(String) : [],
    privateOpen: allow.privateOpen === true,
    snowluma: snow,
    dshReady: Boolean(deps.dshReady),
    dshUrl: String(cfg.dsh?.baseUrl || ''),
    consolePort: Number(cfg.consolePort) || null,
    writable: Boolean(deps.updateConfigFile) && Boolean(deps.fs)
  };
  view.gaps = buildSetupGaps(view);
  view.ready = view.gaps.length === 0;
  return view;
}

function setupBackupConfig(deps, configFile) {
  try {
    if (!deps.fs.existsSync(configFile)) return '';
    const target = `${configFile}.bak-setup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    deps.fs.copyFileSync(configFile, target);
    try {
      const dir = deps.path.dirname(configFile);
      const base = deps.path.basename(configFile) + '.bak-setup-';
      const olds = deps.fs.readdirSync(dir).filter((name) => name.startsWith(base)).sort();
      for (const name of olds.slice(0, Math.max(0, olds.length - 5))) deps.fs.rmSync(deps.path.join(dir, name), { force: true });
    } catch {}
    return target;
  } catch {
    return '';
  }
}

async function handleSetupRequest(deps, request) {
  // 和名单/通用配置同口径：智能体（MCP 工具进程）不得自己改设置。
  if (request.req.headers['x-agent-call'] !== undefined || request.req.headers['x-agent-token']) {
    request.sendJson({ ok: false, code: 'admin_only', error: '首次设置只允许管理端操作' }, 403);
    return true; /* @bridge-handled */
  }
  if (request.req.method === 'GET') {
    request.sendJson({ ok: true, ...(await setupStatusView(deps)) });
    return true; /* @bridge-handled */
  }
  if (request.req.method !== 'POST') {
    request.sendJson({ ok: false, error: '首次设置只支持 GET/POST' }, 405);
    return true; /* @bridge-handled */
  }
  const body = await request.readBody().catch(() => ({}));
  const patch = body && typeof body === 'object' ? body : {};
  const writes = [];
  const changed = [];
  const ownerRaw = patch.ownerQQ === undefined ? undefined : String(patch.ownerQQ ?? '').trim();
  if (ownerRaw !== undefined) {
    if (!SETUP_ID_RE.test(ownerRaw)) { request.sendJson({ ok: false, error: 'ownerQQ 要是 5~15 位数字' }, 400); return true; }
    writes.push({ path: ['ownerQQ'], value: ownerRaw, label: 'ownerQQ' });
  }
  const url = normalizeSetupUrl(patch.snowluma?.httpUrl);
  if (!url.ok) { request.sendJson({ ok: false, error: url.error }, 400); return true; }
  if (url.url !== undefined) writes.push({ path: ['snowluma', 'httpUrl'], value: url.url, label: 'snowluma.httpUrl', restart: true });
  if (patch.snowluma?.accessToken !== undefined) {
    const token = String(patch.snowluma.accessToken ?? '').trim();
    if (token && !/^[\x21-\x7e]{1,200}$/.test(token)) { request.sendJson({ ok: false, error: 'accessToken 只能是不含空白的可见字符' }, 400); return true; }
    writes.push({ path: ['snowluma', 'accessToken'], value: token, label: 'snowluma.accessToken（不回显）', restart: true, sensitive: true });
  }
  const groups = normalizeSetupIdList(patch.allow?.groups);
  if (!groups.ok) { request.sendJson({ ok: false, error: groups.error }, 400); return true; }
  if (groups.ids !== undefined) writes.push({ path: ['allow', 'groups'], value: groups.ids, label: 'allow.groups', restart: true });
  const privates = normalizeSetupIdList(patch.allow?.private);
  if (!privates.ok) { request.sendJson({ ok: false, error: privates.error }, 400); return true; }
  if (privates.ids !== undefined) writes.push({ path: ['allow', 'private'], value: privates.ids, label: 'allow.private', restart: true });
  if (patch.allow?.privateOpen !== undefined) {
    writes.push({ path: ['allow', 'privateOpen'], value: patch.allow.privateOpen === true, label: 'allow.privateOpen', restart: true });
  }
  if (!writes.length) { request.sendJson({ ok: false, error: '没有要写入的字段' }, 400); return true; }

  const configFile = deps.path.join(deps.ROOT, 'config.json');
  let backup = '';
  try {
    // 先校验 JSON 可信，再备份，再写；写失败时 backup 已经在了，用户能自己回滚。
    backup = setupBackupConfig(deps, configFile);
    (0, deps.updateConfigFile)(configFile, (raw) => {
      for (const item of writes) {
        if (JSON.stringify(configAdminGetAt(raw, item.path)) !== JSON.stringify(item.value)) changed.push(item.label);
        configAdminSetAt(raw, item.path, item.value);
      }
    }, { atomicWrite: deps.atomicWriteJson });
  } catch (error) {
    request.sendJson({ ok: false, error: `写入配置失败：${error?.message ?? error}` }, 500);
    return true; /* @bridge-handled */
  }
  let hotReloaded = false;
  try { hotReloaded = Boolean(deps.reloadConfigFromDisk && deps.reloadConfigFromDisk('api-setup')?.ok); } catch {}
  (0, deps.log)(`控制台：首次设置已保存（${changed.length ? changed.join('、') : '无变化'}）`);
  request.sendJson({ ok: true, changed, restartRequired: writes.some((item) => item.restart), hotReloaded, backup: Boolean(backup) }, 200);
  return true; /* @bridge-handled */
}

// ── 桌面客户端的开机自启动 ────────────────────────────────────────────────
// 写的是和桌面壳托盘、安装器完成页完全同一处注册表值：
//   HKCU\Software\Microsoft\Windows\CurrentVersion\Run 下值名 QQDeepSeekBot，
//   命令 `"<exe>" --root "<root>"`（壳靠 --root 找 src/bridge.js 与 node.exe）。
// 只动当前用户、不碰 HKLM，所以不需要管理员权限。Node 没有注册表 API，只能借 reg.exe。
const AUTOSTART_RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
const AUTOSTART_VALUE_NAME = 'QQDeepSeekBot';
// reg.exe 输出走控制台代码页（中文系统是 GBK），按 utf8 解会把中文路径变乱码。
function autostartDecode(buf) {
  try { return new TextDecoder('gbk').decode(buf); } catch { return Buffer.from(buf).toString('utf8'); }
}
async function autostartReg(args) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true, encoding: 'buffer', timeout: 5000 }, (error, stdout) => {
      const raw = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || ''));
      resolve({ ok: !error, text: autostartDecode(raw).trim() });
    });
  });
}
// 从 `    QQDeepSeekBot    REG_SZ    "C:\...\QQDeepSeekBot.exe" --root "E:\..."` 里掏出命令。
function autostartCommandOf(text) {
  const lines = String(text || '').split(String.fromCharCode(13) + String.fromCharCode(10));
  const line = lines.find((l) => l.includes(AUTOSTART_VALUE_NAME) && /REG_(SZ|EXPAND_SZ)/i.test(l));
  if (!line) return '';
  const hit = line.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)$/i);
  return hit ? hit[1].trim() : '';
}
function autostartExeOf(command) {
  const hit = String(command || '').match(/"([^"]+[.]exe)"/i);
  return hit ? hit[1] : '';
}
// 候选顺序：用户在 config.json 里指定的 > 安装器装的 %LOCALAPPDATA%\Programs > 仓库里的构建产物。
function autostartCandidates(deps) {
  const out = [];
  const push = (value) => { const v = String(value || '').trim(); if (v && !out.includes(v)) out.push(v); };
  push(deps.cfg && deps.cfg.desktop && deps.cfg.desktop.exePath);
  if (process.env.LOCALAPPDATA) push(deps.path.join(process.env.LOCALAPPDATA, 'Programs', 'QQDeepSeekBot', 'QQDeepSeekBot.exe'));
  push(deps.path.join(deps.ROOT, 'dist', 'desktop', 'QQDeepSeekBot.exe'));
  return out;
}
async function autostartView(deps) {
  const read = await autostartReg(['query', AUTOSTART_RUN_KEY, '/v', AUTOSTART_VALUE_NAME]);
  const command = read.ok ? autostartCommandOf(read.text) : '';
  const candidates = autostartCandidates(deps);
  const exists = (p) => { try { return deps.fs.existsSync(p); } catch { return false; } };
  const installed = candidates.find(exists) || '';
  const exe = autostartExeOf(command) || installed;
  return {
    available: Boolean(exe),
    enabled: Boolean(command),
    command,
    exe,
    candidates,
    registry: AUTOSTART_RUN_KEY + String.fromCharCode(92) + AUTOSTART_VALUE_NAME,
    // 开不了要说清原因：没装客户端就没有 exe 可写进 Run 键。
    hint: exe ? '' : '没找到桌面客户端 exe：先装一遍客户端，或把它放到 dist/desktop/QQDeepSeekBot.exe'
  };
}
async function autostartSet(deps, enabled) {
  const before = await autostartView(deps);
  if (!enabled) {
    const removed = await autostartReg(['delete', AUTOSTART_RUN_KEY, '/v', AUTOSTART_VALUE_NAME, '/f']);
    // 值本来就不存在时 reg 也返回非 0，按「已经是关的」处理
    const view = await autostartView(deps);
    return { ok: true, removed: removed.ok, view };
  }
  if (!before.exe) return { ok: false, error: before.hint || '找不到桌面客户端 exe', view: before };
  // 带 --autostart：登录拉起时直接进托盘，不弹窗。
  const command = '"' + before.exe + '" --root "' + deps.ROOT + '" --autostart';
  const written = await autostartReg(['add', AUTOSTART_RUN_KEY, '/v', AUTOSTART_VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f']);
  const view = await autostartView(deps);
  if (!written.ok || !view.enabled) return { ok: false, error: written.text.slice(0, 200) || '写注册表失败', command, view };
  return { ok: true, command, view };
}
// GET 读状态、POST {enabled} 开关。只给管理端：改的是这台机器开机启动什么，不该由会话级主体碰。
async function handleAutostartRequest(deps, request) {
  if (request.req.headers['x-agent-token'] || request.req.headers['x-agent-call'] !== undefined) {
    request.sendJson({ ok: false, error: '开机自启动只允许管理端读写' }, 403);
    return true;
  }
  if (request.req.method === 'GET') {
    request.sendJson({ ok: true, ...(await autostartView(deps)) });
    return true;
  }
  const body = await request.readBody();
  const enabled = body.enabled === true;
  const result = await autostartSet(deps, enabled);
  (0, deps.log)(`控制台：开机自启动 → ${enabled ? '开启' : '关闭'}（${result.ok ? 'ok' : 'fail ' + (result.error || '')}）`);
  request.sendJson({ ok: Boolean(result.ok), enabled: Boolean(result.view && result.view.enabled), error: result.error, ...result }, result.ok ? 200 : 500);
  return true;
}


export function createConsoleConfigAdmin(deps) {
// @bridge-function handleConsoleConfigAdmin:start
async function handleConsoleConfigAdmin(request) {
        const pathname = request.url.pathname;
        if (pathname === '/api/setup') return handleSetupRequest(deps, request);
        if (pathname === '/api/autostart') return handleAutostartRequest(deps, request);
        if (pathname !== '/api/config') return false;
        // 和 /api/socialV2/ai-blacklist 同口径：MCP 工具进程也持有控制台令牌，
        // 通用配置读写属于管理端全权，智能体调用一律拒绝（防止工具自己去放开闸门）。
        if (request.req.headers['x-agent-call'] !== undefined || request.req.headers['x-agent-token']) {
          request.sendJson({ ok: false, code: 'admin_only', error: '通用配置只允许管理端读写（智能体不得自行改配置）' }, 403);
          return true; /* @bridge-handled */
        }
        const configFile = deps.path.join(deps.ROOT, 'config.json');
        if (request.req.method === 'GET') {
          // 以磁盘为准（控制台展示的应该是「文件里现在是什么」）；文件缺失/损坏时才回退到运行期配置。
          const disk = (0, deps.readConfigObject)(configFile);
          const source = Object.keys(disk).length ? disk : (configAdminIsObject(deps.cfg) ? deps.cfg : {});
          const data = {};
          for (const root of CONFIG_ADMIN_ROOTS) {
            if (!Object.prototype.hasOwnProperty.call(source, root)) continue;
            const clean = configAdminSanitize(source[root], 0);
            if (clean !== undefined) data[root] = clean;
          }
          const whitelist = [];
          for (const root of Object.keys(data)) configAdminCollectPaths(data[root], root, whitelist);
          // allowedProviderModels 可能还没落盘（默认值写在 config-load.js 里）：不补这一条的话
          // 前端拿不到该叶子路径，只能显示「后端尚未开放」，等于白名单永远改不了。值优先取磁盘
          // （含用户显式写的 []），磁盘缺省时取运行期 cfg 里已归一的默认值，最后才用内置兜底。
          if (!whitelist.includes(CONFIG_ADMIN_ALLOWED_MODELS_PATH)) {
            const onDisk = configAdminGetAt(source, configAdminSplit(CONFIG_ADMIN_ALLOWED_MODELS_PATH));
            const onRuntime = configAdminGetAt(deps.cfg, configAdminSplit(CONFIG_ADMIN_ALLOWED_MODELS_PATH));
            const shown = Array.isArray(onDisk) ? onDisk : (Array.isArray(onRuntime) ? onRuntime : [...CONFIG_ADMIN_ALLOWED_MODELS_FALLBACK]);
            configAdminSetAt(data, configAdminSplit(CONFIG_ADMIN_ALLOWED_MODELS_PATH), shown);
            whitelist.length = 0;
            for (const root of Object.keys(data)) configAdminCollectPaths(data[root], root, whitelist);
          }
          // 同理补 library.autoExtract：磁盘优先（用户显式写的 false 要能读回），其次运行期 cfg，最后 false。
          if (!whitelist.includes(CONFIG_ADMIN_LIBRARY_AUTOEXTRACT_PATH)) {
            const onDisk = configAdminGetAt(source, configAdminSplit(CONFIG_ADMIN_LIBRARY_AUTOEXTRACT_PATH));
            const onRuntime = configAdminGetAt(deps.cfg, configAdminSplit(CONFIG_ADMIN_LIBRARY_AUTOEXTRACT_PATH));
            const shown = typeof onDisk === 'boolean' ? onDisk : (typeof onRuntime === 'boolean' ? onRuntime : false);
            configAdminSetAt(data, configAdminSplit(CONFIG_ADMIN_LIBRARY_AUTOEXTRACT_PATH), shown);
            whitelist.length = 0;
            for (const root of Object.keys(data)) configAdminCollectPaths(data[root], root, whitelist);
          }
          // 梗库玩梗尺度（0~100）：磁盘没写过时补一个默认叶子，设置页才能改。
          if (!whitelist.includes('socialV2.memeWiki.spiciness')) {
            const onDisk = configAdminGetAt(source, ['socialV2', 'memeWiki', 'spiciness']);
            const onRuntime = configAdminGetAt(deps.cfg, ['socialV2', 'memeWiki', 'spiciness']);
            const shown = typeof onDisk === 'number' ? onDisk : (typeof onRuntime === 'number' ? onRuntime : 50);
            configAdminSetAt(data, ['socialV2', 'memeWiki', 'spiciness'], shown);
            whitelist.length = 0;
            for (const root of Object.keys(data)) configAdminCollectPaths(data[root], root, whitelist);
          }
          // 同理补社交两段的默认叶子（磁盘 > 运行期 > 内置默认），否则设置页看不到这几个开关。
          let socialPatched = false;
          // 纯净模式开着时，运行期有效 turnMaxSteps 固定 6（mux 的 turnStepLimit 同口径）；
          // GET 展示「有效值」，但 config.json 落盘值不动（回读文件仍是配置值）。
          try {
            const pureOn = configAdminGetAt(data, ['socialV2', 'pureMode', 'enabled']) === true;
            if (pureOn) configAdminSetAt(data, ['socialV2', 'turnMaxSteps'], 6);
          } catch { /* 展示层兜底失败不影响只读接口 */ }
          for (const [dotted, fallback] of Object.entries(CONFIG_ADMIN_SOCIAL_DEFAULT_PATHS)) {
            if (whitelist.includes(dotted)) continue;
            const parts = configAdminSplit(dotted);
            const onDisk = configAdminGetAt(source, parts);
            const onRuntime = configAdminGetAt(deps.cfg, parts);
            const shown = typeof onDisk === typeof fallback ? onDisk : (typeof onRuntime === typeof fallback ? onRuntime : fallback);
            configAdminSetAt(data, parts, shown);
            socialPatched = true;
          }
          if (socialPatched) {
            whitelist.length = 0;
            for (const root of Object.keys(data)) configAdminCollectPaths(data[root], root, whitelist);
          }
          // agent 段默认叶子（磁盘 > 运行期 > 内置默认）；apiKey 只回「有没有配」，绝不回明文。
          let agentPatched = false;
          for (const [dotted, fallback] of Object.entries(CONFIG_ADMIN_AGENT_PATHS)) {
            if (whitelist.includes(dotted)) continue;
            const parts = configAdminSplit(dotted);
            const onDisk = configAdminGetAt(source, parts);
            const onRuntime = configAdminGetAt(deps.cfg, parts);
            const shown = typeof onDisk === typeof fallback ? onDisk : (typeof onRuntime === typeof fallback ? onRuntime : fallback);
            configAdminSetAt(data, parts, shown);
            agentPatched = true;
          }
          if (agentPatched) {
            whitelist.length = 0;
            for (const root of Object.keys(data)) configAdminCollectPaths(data[root], root, whitelist);
          }
          // 密钥框也必须可编辑：apiKey 只写不读（data 里只回 hasApiKey），但 whitelist 里要有它，
          // 否则前端把输入框置灰、用户根本填不了。写入语义：非空=写入、空串=清除、不出现=不改。
          if (!whitelist.includes(CONFIG_ADMIN_AGENT_API_KEY_PATH)) whitelist.push(CONFIG_ADMIN_AGENT_API_KEY_PATH);
          const apiKeyOnDisk = configAdminGetAt(source, ['agent', 'apiKey']);
          const apiKeyOnRuntime = configAdminGetAt(deps.cfg, ['agent', 'apiKey']);
          configAdminSetAt(data, ['agent', 'hasApiKey'], (typeof apiKeyOnDisk === 'string' && apiKeyOnDisk.trim() !== '') || (typeof apiKeyOnRuntime === 'string' && apiKeyOnRuntime.trim() !== ''));
          // hasApiKey 是展示用的派生字段：不进 whitelist（它不是可写路径），前端直接读 data 就行。
          // probeOk：设置页「测试连通」最近一次结果（内存里的，不读磁盘；null=还没测过）。
          configAdminSetAt(data, ['agent', 'probeOk'], typeof deps.agentProbeLast === 'function' ? (deps.agentProbeLast() || null) : null);
          request.sendJson({
            ok: true,
            data,
            whitelist,
            restartRequired: [...(Array.isArray(deps.RESTART_REQUIRED_PATHS) ? deps.RESTART_REQUIRED_PATHS : [])]
          });
          return true; /* @bridge-handled */
        }
        if (request.req.method !== 'POST') {
          request.sendJson({ ok: false, error: '只支持 GET/POST' }, 405);
          return true; /* @bridge-handled */
        }
        const body = await request.readBody().catch(() => ({}));
        const patch = body && typeof body === 'object' ? body.patch : undefined;
        if (!configAdminIsObject(patch)) {
          request.sendJson({ ok: false, error: '请求体必须是 { patch: { "路径": 值 } }' }, 400);
          return true; /* @bridge-handled */
        }
        // 先整体校验，再一次性落盘：任何一个路径不合格就整单拒绝，避免「一半生效一半 400」。
        const entries = [];
        const rejected = [];
        for (const [key, value] of Object.entries(patch)) {
          const parts = configAdminSplit(key);
          const dotted = parts.join('.');
          if (!dotted || parts.some((part) => !part)) { rejected.push({ path: dotted || String(key), reason: '路径为空' }); continue; }
          if (dotted === CONFIG_ADMIN_AGENT_API_KEY_PATH) {
            // apiKey 只写不读：GET 里它会被敏感键过滤掉，值也不会进日志/响应。
            if (typeof value !== 'string' || value.length > 400) {
              rejected.push({ path: dotted, reason: 'apiKey 必须是 ≤400 字的字符串' });
              continue;
            }
            entries.push({ key: dotted, parts, value: value.trim() });
            continue;
          }
          if (configAdminIsSensitive(parts)) { rejected.push({ path: dotted, reason: '敏感字段禁止读写' }); continue; }
          if (!CONFIG_ADMIN_ROOTS.includes(parts[0])) { rejected.push({ path: dotted, reason: '不在可编辑白名单内' }); continue; }
          if (value === undefined) { rejected.push({ path: dotted, reason: '值不能是 undefined' }); continue; }
          if (parts[0] === 'library' && dotted !== CONFIG_ADMIN_LIBRARY_AUTOEXTRACT_PATH) {
            rejected.push({ path: dotted, reason: '不在可编辑白名单内（library 只开放 autoExtract）' });
            continue;
          }
          if (dotted === CONFIG_ADMIN_LIBRARY_AUTOEXTRACT_PATH && typeof value !== 'boolean') {
            rejected.push({ path: dotted, reason: 'autoExtract 只接受 true 或 false' });
            continue;
          }
          // agent 段只开 5 个叶子（type/baseUrl/model/timeoutMs/maxToolRounds）；apiKey 已在上面的写入通道处理。
          if (parts[0] === 'agent') {
            if (!Object.prototype.hasOwnProperty.call(CONFIG_ADMIN_AGENT_PATHS, dotted)) {
              rejected.push({ path: dotted, reason: '不在可编辑白名单内（agent 只开放 type / baseUrl / model / timeoutMs / maxToolRounds）' });
              continue;
            }
            if (dotted === 'agent.type') {
              const type = typeof value === 'string' ? value.trim().toLowerCase() : '';
              if (!CONFIG_ADMIN_AGENT_TYPES.includes(type)) {
                rejected.push({ path: dotted, reason: `agent.type 只接受 ${CONFIG_ADMIN_AGENT_TYPES.join(' / ')}` });
                continue;
              }
              entries.push({ key: dotted, parts, value: type });
              continue;
            }
            if (dotted === 'agent.baseUrl' || dotted === 'agent.model') {
              if (typeof value !== 'string') { rejected.push({ path: dotted, reason: `${dotted.split('.').pop()} 只接受字符串` }); continue; }
              entries.push({ key: dotted, parts, value: value.trim() });
              continue;
            }
            // timeoutMs 5s~10min；maxToolRounds 1~20（与 config-load 的夹取口径一致）。
            if (typeof value !== 'number' || !Number.isFinite(value)) { rejected.push({ path: dotted, reason: '必须是数字' }); continue; }
            if (dotted === 'agent.timeoutMs' && (value < 5000 || value > 600000)) { rejected.push({ path: dotted, reason: 'timeoutMs 必须在 5000~600000 之间' }); continue; }
            if (dotted === 'agent.maxToolRounds' && (value < 1 || value > 20)) { rejected.push({ path: dotted, reason: 'maxToolRounds 必须在 1~20 之间' }); continue; }
            entries.push({ key: dotted, parts, value: Math.floor(value) });
            continue;
          }
          if (Object.prototype.hasOwnProperty.call(CONFIG_ADMIN_SOCIAL_DEFAULT_PATHS, dotted)) {
            const want = typeof CONFIG_ADMIN_SOCIAL_DEFAULT_PATHS[dotted];
            if (typeof value !== want) { rejected.push({ path: dotted, reason: `${dotted.split('.').pop()} 只接受${want === 'boolean' ? ' true 或 false' : '数字'}` }); continue; }
            if (want === 'number' && (!Number.isFinite(value) || value < 0)) { rejected.push({ path: dotted, reason: '必须是 >= 0 的数字' }); continue; }
          } else if (/^socialV2\.(?:private\.addFriendHint|pureMode)(?:\.|$)/.test(dotted)) {
            rejected.push({ path: dotted, reason: '不在可编辑白名单内（只开放 enabled / afterMessages / cooldownMs）' });
            continue;
          }
          // 「允许的模型」是唯一要格式校验的叶子：写错一个词会把聊天模型锁死，所以这里
          // 先解析成归一数组再进 entries（写盘/比较都用数组，不接受把合法数组存成字符串）。
          if (dotted === CONFIG_ADMIN_ALLOWED_MODELS_PATH) {
            const parsed = configAdminParseAllowedModels(value);
            if (!parsed.ok) {
              rejected.push({ path: dotted, reason: `非法项：${parsed.invalid.join('、')}（每项应为 provider/model 或 *）` });
              continue;
            }
            entries.push({ key: dotted, parts, value: parsed.list });
            continue;
          }
          const valueHit = configAdminInspectValue(value, 0);
          if (valueHit) {
            rejected.push({
              path: dotted,
              reason: valueHit.tooDeep ? `值嵌套过深（上限 ${CONFIG_ADMIN_MAX_DEPTH} 层）` : `值内含敏感键 ${valueHit.key}`
            });
            continue;
          }
          entries.push({ key: dotted, parts, value });
        }
        if (rejected.length || !entries.length) {
          request.sendJson({
            ok: false,
            error: rejected.length ? `以下字段被拒绝：${rejected.map((item) => item.path).join('、')}` : '没有可写入的字段',
            rejected
          }, 400);
          return true; /* @bridge-handled */
        }
        const changed = [];
        try {
          const shrinks = [];
          (0, deps.updateConfigFile)(configFile, (raw) => {
            shrinks.length = 0;
            for (const entry of entries) {
              const before = configAdminGetAt(raw, entry.parts);
              const shrink = configAdminShrinkOf(before, entry.value);
              if (shrink) shrinks.push({ path: entry.key, total: shrink.total, missing: shrink.missing.slice(0, 6), missingCount: shrink.missing.length });
            }
            // 只要有一条会抹键，整单不写：宁可 400 让调用方改叶子路径，也不要删别人配置。
            if (shrinks.length) {
              const error = new Error('config-admin-shrink');
              error.shrinks = shrinks;
              throw error;
            }
            for (const entry of entries) {
              // changed 以「磁盘最新值」为准：并发写者的修改不算进本单的 changed。
              if (JSON.stringify(configAdminGetAt(raw, entry.parts)) !== JSON.stringify(entry.value)) changed.push(entry.key);
              configAdminSetAt(raw, entry.parts, entry.value);
            }
          }, { atomicWrite: deps.atomicWriteJson });
        } catch (error) {
          if (error && error.message === 'config-admin-shrink') {
            const shrank = Array.isArray(error.shrinks) ? error.shrinks : [];
            const first = shrank[0] || {};
            request.sendJson({
              ok: false,
              error: `拒绝整段覆盖：${first.path} 现有 ${first.total} 个键，新值会丢掉 ${first.missingCount} 个（${(first.missing || []).join('、')}…）。要改单项请用叶子路径，例如 ${first.path}.<字段名>。`,
              shrank
            }, 400);
            return true; /* @bridge-handled */
          }
          request.sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
          return true; /* @bridge-handled */
        }
        // 写盘后立刻热加载一次，让下一次请求看到新值；热加载被 setup 跳过（端口/连接类）也没关系，
        // 下面的 restartRequired 会告诉前端「这些改动要重启」。
        let hotReloaded = false;
        try {
          const result = (0, deps.reloadConfigFromDisk)('api-config');
          hotReloaded = Boolean(result && result.ok);
        } catch {}
        // 热加载成功时 cfg 已从磁盘重建（含归一）；万一热加载失败，也要把「允许的模型」直接
        // 同步进内存，否则本次请求之后桥接仍按旧白名单选模型，页面显示和实际行为分叉。
        if (!hotReloaded) {
          for (const entry of entries) {
            if (entry.key !== CONFIG_ADMIN_ALLOWED_MODELS_PATH) continue;
            try {
              configAdminSetAt(deps.cfg, entry.parts, entry.value);
            } catch {}
          }
        }
        const restartPaths = Array.isArray(deps.RESTART_REQUIRED_PATHS) ? deps.RESTART_REQUIRED_PATHS : [];
        const restartRequired = entries.some((entry) => restartPaths.some((restartPath) => {
          const target = String(restartPath);
          return entry.key === target || entry.key.startsWith(`${target}.`) || target.startsWith(`${entry.key}.`);
        }));
        (0, deps.log)(`控制台：通用配置已更新（${changed.length ? changed.join('、') : '无变化'}${restartRequired ? '，需重启' : ''}）`);
        request.sendJson({ ok: true, changed, restartRequired, hotReloaded });
        return true; /* @bridge-handled */
        // 走到这里说明路径没匹配上（readBridgeSource 的路由展开按最后这个 return false; 切片）。
        return false;
      }
// @bridge-function handleConsoleConfigAdmin:end
  return { handleConsoleConfigAdmin };
}
