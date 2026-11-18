// 机器人自检（九组）：只读体检，供 scripts/self-check.mjs（CLI）与 POST /api/self-check（控制台）共用。
//
// 设计要点：
//   * 每一组都**必须**带实据（端口真连了没、db 的 integrity_check 回了什么、pid 活没活），
//     禁止只写「正常」——否则这套自检就会变成第二个假绿来源（本项目踩过：ok:true 但链路没恢复）。
//   * 探测函数全部可注入：测试注入假 deps，不真连网络、不真读 state（test-self-check.mjs）。
//   * 只读：除 --fix 的两件安全动作（拉起 Ollama、清死锁文件）外不写任何东西。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// node:sqlite 只在需要时加载：dbIntegrity 是同步的，ESM 里没有 require，用 createRequire 拿。
const requireCjs = createRequire(import.meta.url);

const STATUS_RANK = { ok: 0, warn: 1, fail: 2 };
const worst = (list) => list.reduce((acc, s) => (STATUS_RANK[s] > STATUS_RANK[acc] ? s : acc), 'ok');

// ───────────────────────────── 真实探测实现（可被测试整体替换） ─────────────────────────────
export function createRealDeps() {
  return {
    tcp(host, port, timeoutMs = 1200) {
      return new Promise((resolve) => {
        const s = net.connect({ host, port });
        const done = (ok) => { try { s.destroy(); } catch { /* ignore */ } resolve(ok); };
        s.setTimeout(timeoutMs);
        s.once('connect', () => done(true));
        s.once('timeout', () => done(false));
        s.once('error', () => done(false));
      });
    },
    async httpJson(url, init = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), init.timeoutMs || 8000);
      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        const text = await res.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
        return { status: res.status, body };
      } catch (error) {
        return { status: 0, error: String(error?.message ?? error) };
      } finally {
        clearTimeout(timer);
      }
    },
    readText(file) {
      try { return fs.readFileSync(file, 'utf8'); } catch (error) { return { error: String(error?.message ?? error) }; }
    },
    readJson(file) {
      try {
        const text = fs.readFileSync(file, 'utf8');
        return { ok: true, value: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) };
      } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
    },
    exists(file) { try { return fs.existsSync(file); } catch { return false; } },
    writable(dir) { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } },
    freeBytes(dir) {
      try { const st = fs.statfsSync(dir); return st.bavail * st.bsize; } catch { return null; }
    },
    dbIntegrity(file) {
      try {
        // 只读打开，绝不建库/写 WAL；坏文件要如实报错误信息。
        const { DatabaseSync } = requireCjs('node:sqlite');
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          const row = db.prepare('PRAGMA integrity_check').get();
          const detail = String(row?.integrity_check ?? Object.values(row || {})[0] ?? '');
          return { ok: detail.toLowerCase() === 'ok', detail: detail || '(空)' };
        } finally { db.close(); }
      } catch (error) { return { ok: false, detail: String(error?.message ?? error) }; }
    },
    taskState(name) {
      // 坑：中文 Windows 的 schtasks 走 GBK(OEM) 输出，Node 按 utf8 解码会成乱码，
      // 旧实现因此永远「读不到 Status 字段」，把四个计划任务全判成没跑（自检里那条唯一的红）。
      // 顺序：先问 PowerShell（Get-ScheduledTask 的 State 是英文枚举，编码安全）→ 失败再退回 schtasks 并用 GBK 解码。
      const plain = String(name || '').replace(/^\\+/, '').replace(/'/g, "''");
      const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-ScheduledTask -TaskName '${plain}' -ErrorAction Stop).State`], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      const psOut = String(ps.stdout || '').trim();
      if (ps.status === 0 && /^(Ready|Running|Disabled|Queued|Unknown)$/i.test(psOut)) return { ok: true, state: normalizeTaskStateValue(psOut), detail: '' };
      const r = spawnSync('schtasks', ['/query', '/tn', name, '/fo', 'list'], { timeout: 8000, windowsHide: true });
      const decode = (buf) => { try { return new TextDecoder('gbk').decode(buf || Buffer.alloc(0)); } catch { return String(buf || ''); } };
      const text = `${decode(r.stdout)}${decode(r.stderr)}`;
      if (r.status !== 0) return { ok: false, state: '', detail: (text.trim().split('\n').pop() || '').slice(0, 80) };
      // 字段名四种都见过：英文 Status/State、中文 状态、以及「模式/Mode」（中文版对运行中的任务就印这个）。
      const m = /^\s*(Status|State|状态|模式|Mode)\s*[:：]\s*(.+)$/m.exec(text);
      return m ? { ok: true, state: normalizeTaskStateValue(m[2]), detail: '' } : { ok: false, state: '', detail: '读不到 Status 字段' };
    },
    runTask(name) {
      const r = spawnSync('schtasks', ['/run', '/tn', name], { encoding: 'utf8', timeout: 15000 });
      return r.status === 0;
    },
    gitHeadMs(root) {
      return gitCommitMs(root, null);
    },
    // 只看真正进进程的代码（src/）：改文档或前端静态页不该报「在跑旧代码」。
    gitSrcHeadMs(root) {
      return gitCommitMs(root, ['src']);
    },
    pidAlive(pid) {
      const n = Number(pid);
      if (!Number.isInteger(n) || n <= 0) return false;
      try { process.kill(n, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
    },
    unlink(file) { try { fs.unlinkSync(file); return true; } catch { return false; } },
    sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },
    now() { return Date.now(); },
  };
}

// ───────────────────────────── 小工具 ─────────────────────────────
// 计划任务的「状态」在不同来源里说法不一（英文枚举 Ready/Running/Disabled，中文 就绪/正在运行/已禁用），
// 统一成英文枚举，下游只按 /running/i 判断，别让语言把判断带偏。
export function normalizeTaskStateValue(value) {
  const s = String(value ?? '').trim();
  if (/正在运行|运行中|running/i.test(s)) return 'Running';
  if (/就绪|ready|queued/i.test(s)) return 'Ready';
  if (/已禁用|禁用|disabled/i.test(s)) return 'Disabled';
  return s;
}
function gitCommitMs(root, paths) {
  const args = ['-C', root, 'log', '-1', '--format=%ct', ...(paths?.length ? ['--', ...paths] : [])];
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: 8000 });
  if (r.status !== 0) return null;
  const sec = Number(String(r.stdout).trim());
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
}
function maskGroup(group) {
  const s = String(group);
  return s.length <= 2 ? '**' : `**${s.slice(-2)}`;
}
function fmtGb(bytes) { return bytes == null ? '未知' : `${(bytes / 1024 ** 3).toFixed(1)} GB`; }
function agoText(ms) {
  if (!Number.isFinite(ms)) return '未知';
  const m = Math.round(ms / 60000);
  return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : `${(m / 60).toFixed(1)} 小时前`;
}

/** 从日志行里取 HH:MM:SS（本项目的两种日志都以时间开头）。 */
function logSecondsOfDay(line) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})/.exec(String(line).trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function countRecentLogProblems(text, nowMs, windowMs = 10 * 60 * 1000) {
  // 日志里的 HH:MM:SS 是**本地时间**；这里也必须按本地时间换算，否则时区一差就整批漏掉（实测漏过 8 小时）。
  const d = new Date(nowMs);
  const nowSec = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  let error = 0; let warn = 0; let total = 0;
  const samples = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const sec = logSecondsOfDay(line);
    if (sec == null) continue;
    const delta = (nowSec - sec + 86400) % 86400; // 跨零点
    if (delta > windowMs / 1000) continue;
    total += 1;
    // 已知无害噪音：重启/监护窗口切 stdio 时的一行 write EOF，带「失败」但不算故障，别让它把十组体检染红。
    if (/忽略管道写失败（不退出）：write EOF/.test(line)) continue;
    if (/\[error\]/i.test(line) || /\bERROR\b/.test(line) || /失败|错误|异常/.test(line)) {
      error += 1;
      if (samples.length < 3) samples.push(line.trim().slice(0, 100));
    } else if (/\bwarn\b/i.test(line) || /警告/.test(line)) {
      warn += 1;
      if (samples.length < 3) samples.push(line.trim().slice(0, 100));
    }
  }
  return { error, warn, total, samples };
}

// ───────────────────────────── 九组检查 ─────────────────────────────
function groupPorts(ctx) {
  const dshPort = (() => {
    try { const u = new URL(ctx.config?.dsh?.baseUrl || 'http://127.0.0.1:13707'); return Number(u.port || 80); } catch { return 13707; }
  })();
  // STT 常驻服务是「配置里开了才该起」的可选件：socialV2.stt.service 没配/没 enabled 时探 8791 只会制造假告警
  // （本机现状就是 config.json 里只有 {model, lang}，走 CLI 回退）。开了才探。
  const sttServiceOn = Boolean(ctx.config?.socialV2?.stt?.service?.enabled);
  const ports = [
    { port: 3000, name: 'SnowLuma HTTP', level: 'warn' },
    { port: 3001, name: 'SnowLuma WS', level: 'fail' },
    { port: ctx.consolePort, name: '桥接控制台', level: 'fail' },
    { port: 8765, name: '本地 TTS', level: 'warn' },
    ...(sttServiceOn ? [{ port: 8791, name: 'STT 服务', level: 'warn' }] : []),
    { port: 11434, name: 'Ollama', level: 'warn' },
    { port: dshPort, name: 'DSH', level: 'fail' },
  ].filter((p, i, arr) => arr.findIndex((x) => x.port === p.port) === i);
  return (async () => {
    const rows = [];
    for (const p of ports) rows.push({ ...p, ok: await ctx.deps.tcp('127.0.0.1', p.port) });
    const downRequired = rows.filter((r) => !r.ok && r.level === 'fail');
    const downOptional = rows.filter((r) => !r.ok && r.level === 'warn');
    const downLabels = [...downRequired, ...downOptional].map((r) => `${r.name}(${r.port})`);
    return {
      id: 'ports', title: '端口/进程',
      status: downRequired.length ? 'fail' : downOptional.length ? 'warn' : 'ok',
      summary: `${rows.filter((r) => r.ok).length}/${rows.length} 个端口可连` + (downLabels.length ? `；不通：${downLabels.join('、')}` : ''),
      evidence: rows.map((r) => `${r.port} ${r.name}: ${r.ok ? '可连' : '不通'}`),
      suggestion: downRequired.length
        ? '先起对应服务（DSH / SnowLuma / 桥接）；这里用 TCP 直连探，本机 Get-NetTCPConnection 漏报过'
        : downOptional.length ? '可选组件没起（不影响收发消息，只在用到该能力时退化）' : '',
    };
  })();
}

async function groupSnowluma(ctx) {
  const httpUrl = String(ctx.config?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = ctx.config?.snowluma?.accessToken || '';
  const login = await ctx.deps.httpJson(`${httpUrl}/get_login_info`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    timeoutMs: 6000,
  });
  const info = login.body?.data || login.body || {};
  const online = login.status === 200 && Boolean(info.user_id || info.nickname);
  const status = await ctx.statusProbe();
  const ws = Boolean(status?.snowluma?.connected ?? status?.snowluma ?? false);
  return {
    id: 'snowluma', title: 'SnowLuma 网关',
    status: online && ws ? 'ok' : online || ws ? 'warn' : 'fail',
    summary: `QQ ${online ? '在线' : '取不到登录信息'}；WS ${ws ? '已连接' : '未连接'}`,
    evidence: [
      `get_login_info: HTTP ${login.status || login.error}${online ? `（账号 ${String(info.user_id || '').slice(0, 4)}****）` : ''}`,
      `桥接侧 WS: connected=${ws}`,
    ],
    suggestion: online
      ? (ws ? '' : '网关在线但桥接 WS 未连上：看 state/bridge.log 的「连接失败 / token 自愈」')
      : '扫码重新登录 SnowLuma，并确认 accessToken 两边一致',
  };
}

async function groupDsh(ctx) {
  // 不直连 DSH：DSH 的 HTTP 要 launch-token/cookie，桥接已经握好了。这里读桥接视角的 dshReady + 模型清单，
  // 也就是「桥接眼里的 DSH 是否可用」——和 /api/status 的 dshReady 同一个真源。
  const status = await ctx.deps.httpJson(`http://127.0.0.1:${ctx.consolePort}/api/status`, { headers: ctx.consoleHeaders(), timeoutMs: 6000 });
  const models = await ctx.deps.httpJson(`http://127.0.0.1:${ctx.consolePort}/api/models`, { headers: ctx.consoleHeaders(), timeoutMs: 10000 });
  const options = (models.body?.options || models.body?.models || []).map((m) => `${m.provider}/${m.model}`);
  const want = [];
  const cur = ctx.config?.dsh?.provider ? `${ctx.config.dsh.provider}/${ctx.config.dsh.model}` : String(ctx.config?.dsh?.model || '');
  if (cur) want.push(cur);
  for (const f of ctx.config?.dsh?.modelFallbacks || []) want.push(`${f.provider}/${f.model}`);
  const missing = options.length ? want.filter((w) => !options.includes(w)) : [];
  const dshReady = Boolean(status.body?.dshReady ?? status.body?.dsh?.ready);
  return {
    id: 'dsh', title: 'DSH 运行时',
    status: status.status === 200 && dshReady && missing.length === 0 ? 'ok' : 'fail',
    summary: `桥接 /api/status HTTP ${status.status || status.error}，dshReady=${dshReady}；模型 ${options.length} 个，缺失 ${missing.length} 个`,
    evidence: [
      `/api/status: HTTP ${status.status || status.error} dshReady=${dshReady}（DSH 自身 HTTP 要 launch-token，不直连）`,
      `/api/models: ${options.length} 个（${options.slice(0, 4).join(', ')}${options.length > 4 ? ' …' : ''}）`,
      missing.length ? `配置里引用了但 DSH 没有：${missing.join(', ')}` : '配置引用的当前模型与兜底模型都在清单里',
    ],
    suggestion: missing.length
      ? '把 config.dsh.model / modelFallbacks 改成 DSH 清单里真实存在的模型（scnet 那次就是这么踩的）'
      : dshReady ? '' : 'DSH 没就绪：启动 DSH 并登录，必要时重启 DSH 让 MCP 重新加载',
  };
}

async function groupBridge(ctx) {
  const headers = { 'x-console-token': ctx.token };
  const status = await ctx.deps.httpJson(`http://127.0.0.1:${ctx.consolePort}/api/status`, { headers, timeoutMs: 6000 });
  const budget1 = await ctx.deps.httpJson(`http://127.0.0.1:${ctx.consolePort}/api/debug/budget`, { headers, timeoutMs: 6000 });
  await ctx.deps.sleep(ctx.sampleGapMs ?? 1500);
  const budget2 = await ctx.deps.httpJson(`http://127.0.0.1:${ctx.consolePort}/api/debug/budget`, { headers, timeoutMs: 6000 });
  const b = budget2.body || {};
  const delta = Number(b.checks || 0) - Number(budget1.body?.checks || 0);
  const lastAtAge = b.lastAt ? ctx.now() - new Date(b.lastAt).getTime() : null;
  const sessions = ctx.deps.readJson(path.join(ctx.root, 'state', 'sessions.json'));
  const map = (sessions.ok && (sessions.value.sessions || sessions.value)) || {};
  const groups = (ctx.config?.allow?.groups || []).map(String);
  const covered = groups.filter((g) => Object.keys(map).some((k) => k === `group:${g}`));
  // 会被「回收」的会话（idle age / 消息量 / 预算）按设计先删映射，等下一轮消息再重建，
  // 所以「白名单群没映射」本身不是故障——socialV2.sessionResets 里记着这笔账，要认它，别误报。
  const social = ctx.deps.readJson(path.join(ctx.root, 'state', 'social-v2.json'));
  const resetKeys = new Set(social.ok ? Object.keys(social.value.sessionResets || {}) : []);
  const recycled = groups.filter((g) => !covered.includes(g) && resetKeys.has(`group:${g}`));
  const missingGroups = groups.filter((g) => !covered.includes(g) && !resetKeys.has(`group:${g}`));
  return {
    id: 'bridge', title: '桥接',
    status: status.status === 200 ? (missingGroups.length ? 'warn' : 'ok') : 'fail',
    summary: `HTTP ${status.status || status.error}；白名单群会话映射 ${covered.length}/${groups.length}；预算 checks ${b.checks ?? '?'}（本轮 +${delta}）`,
    evidence: [
      `/api/status: HTTP ${status.status || status.error}`,
      `预算计数: checks=${b.checks ?? '?'} sweeps=${b.sweeps ?? '?'} errors=${b.errors ?? '?'}，最近一次 ${lastAtAge == null ? '无记录' : agoText(lastAtAge)}（本轮 +${delta}，空闲时 +0 正常）`,
      `会话映射: ${covered.length}/${groups.length} 个白名单群有 DSH 会话${recycled.length ? `；${recycled.length} 个已按 idle/预算回收，下条消息自动重建` : ''}${missingGroups.length ? `，缺 ${missingGroups.map(maskGroup).join('、')}` : ''}`,
    ],
    suggestion: status.status !== 200
      ? '桥接没在跑：node src/bridge.js（或 start.bat）'
      : missingGroups.length ? '缺映射的群在首次收到消息时会自动建会话；长期缺说明该群从未收到过消息或白名单配错' : '',
  };
}

async function groupStorage(ctx) {
  const db = path.join(ctx.root, 'state', 'messages.db');
  const integrity = ctx.deps.exists(db) ? ctx.deps.dbIntegrity(db) : { ok: true, detail: '未创建（新装/未归档时正常）' };
  const stickers = ctx.deps.readJson(path.join(ctx.root, 'state', 'stickers.json'));
  const stickerCount = stickers.ok ? (Array.isArray(stickers.value) ? stickers.value.length : (stickers.value.stickers || []).length) : 0;
  const social = ctx.deps.readJson(path.join(ctx.root, 'state', 'social-v2.json'));
  const convCount = social.ok ? Object.keys(social.value.conversations || {}).length : 0;
  const archiveDir = (() => {
    const d = String(ctx.config?.fileArchive?.dir || 'state/files');
    return path.isAbsolute(d) ? d : path.resolve(ctx.root, d);
  })();
  const archiveOk = ctx.deps.exists(archiveDir) && ctx.deps.writable(archiveDir);
  const bad = [];
  if (!integrity.ok) bad.push(`messages.db: ${integrity.detail}`);
  if (!stickers.ok) bad.push(`stickers.json: ${stickers.error}`);
  if (!social.ok) bad.push(`social-v2.json: ${social.error}`);
  if (!archiveOk) bad.push(`归档目录不可写: ${archiveDir}`);
  return {
    id: 'storage', title: '存储',
    status: bad.length ? 'fail' : 'ok',
    summary: `db ${integrity.ok ? 'integrity ok' : '损坏'}；表情 ${stickerCount} 条；会话 ${convCount} 个；归档目录${archiveOk ? '可写' : '不可写'}`,
    evidence: [
      `messages.db integrity_check = ${integrity.detail}`,
      `state/stickers.json ${stickers.ok ? `可解析（${stickerCount} 条）` : `解析失败：${stickers.error}`}`,
      `state/social-v2.json ${social.ok ? `可解析（${convCount} 个会话）` : `解析失败：${social.error}`}`,
      `归档目录 ${archiveOk ? 'W_OK 通过' : '不存在或不可写'}`,
    ],
    suggestion: bad.length ? '先备份 state/ 再用备份覆盖坏文件；db 损坏可用 sqlite3 ".recover" 或回滚到最近备份' : '',
  };
}

async function groupConfig(ctx) {
  const cfg = ctx.config || {};
  const modelsResp = await ctx.deps.httpJson(`http://127.0.0.1:${ctx.consolePort}/api/models`, { headers: ctx.consoleHeaders(), timeoutMs: 8000 });
  const options = (modelsResp.body?.options || []).map((m) => `${m.provider}/${m.model}`);
  const fallbacks = (cfg.dsh?.modelFallbacks || []).map((f) => `${f.provider}/${f.model}`);
  const missing = options.length ? fallbacks.filter((f) => !options.includes(f)) : [];
  const budgetCfg = cfg.dsh?.contextBudget || cfg.socialV2?.contextBudget || {};
  const sttModel = String(cfg.socialV2?.stt?.model || '');
  const sttOk = !sttModel || ['tiny', 'base', 'small', 'medium', 'large-v2', 'large-v3', 'large-v3-turbo'].includes(sttModel);
  const budgetOn = budgetCfg.enabled === true;
  const peopleOn = cfg.socialV2?.memory?.people?.enabled === true;
  const issues = [];
  if (missing.length) issues.push(`${missing.length} 个兜底模型不存在`);
  if (!sttOk) issues.push(`stt.model=${sttModel} 不在常见值里`);
  if (!budgetOn) issues.push('contextBudget 未启用');
  if (!peopleOn) issues.push('people 未启用');
  return {
    id: 'config', title: '配置',
    status: missing.length ? 'fail' : issues.length ? 'warn' : 'ok',
    summary: `兜底模型 ${fallbacks.length} 条（缺失 ${missing.length}）；stt=${sttModel || '未配'}；contextBudget=${budgetOn ? 'on' : 'off'}；people=${peopleOn ? 'on' : 'off'}`,
    evidence: [
      options.length ? `DSH 模型清单 ${options.length} 个` : '拿不到 DSH 模型清单（桥接未启动或 /api/models 失败）',
      missing.length ? `不存在的模型：${missing.join(', ')}` : '兜底模型全部存在',
      `stt.model=${sttModel || '(默认)'}（合理集合：tiny/base/small/medium/large-v3）`,
      `contextBudget.enabled=${budgetOn}（maxPressurePct=${budgetCfg.maxPressurePct ?? '?'}）`,
      `memory.people.enabled=${peopleOn}`,
    ],
    suggestion: missing.length ? '删掉 config.json 里失效的 modelFallbacks 条目（改动热加载，不用重启）' : issues.length ? '按需打开（不是故障）' : '',
  };
}

function safeTaskState(ctx, name) {
  try {
    const r = ctx.deps.taskState(name);
    return { state: r.state || '', detail: r.detail || '' };
  } catch (error) { return { state: '', detail: String(error?.message ?? error) }; }
}

async function groupTasks(ctx) {
  // State 只是「计划任务是否在跑」，不等于「服务是否活着」：实测 LocalTTS/Ollama 的任务常是 Ready，
  // 服务却由别的方式起着（8765 照样可连）。所以对可选服务再交叉验一次端口，别把 Ready 当故障。
  const defs = [
    { name: '\\QQBridge-Bridge', core: true },
    { name: '\\QQBridge-SnowLuma', core: true },
    { name: '\\LocalTTS', core: false, port: 8765 },
    { name: '\\Ollama', core: false, port: 11434 },
  ];
  const rows = [];
  for (const d of defs) {
    const state = safeTaskState(ctx, d.name);
    const portUp = d.port ? await ctx.deps.tcp('127.0.0.1', d.port) : null;
    rows.push({ ...d, ...state, portUp });
  }
  const coreDown = rows.filter((r) => r.core && !/running/i.test(r.state));
  const optionalDown = rows.filter((r) => !r.core && !/running/i.test(r.state) && r.portUp === false);
  return {
    id: 'tasks', title: '计划任务',
    status: coreDown.length ? 'fail' : optionalDown.length ? 'warn' : 'ok',
    summary: rows.map((r) => `${r.name.replace(/^\\/, '')}=${r.state || '读不到'}${r.port ? (r.portUp ? `(端口 ${r.port} 通)` : `(端口 ${r.port} 不通)`) : ''}`).join('；'),
    evidence: rows.map((r) => `${r.name}: ${r.state || '读不到状态'}${r.port ? `，端口 ${r.port} ${r.portUp ? '可连' : '不通'}` : ''}${r.detail ? `（${r.detail}）` : ''}`),
    suggestion: coreDown.length
      ? '核心任务没在跑：schtasks /run /tn <任务名>，或看任务计划程序里的上次退出码'
      : optionalDown.length ? '可选服务未运行（TTS/Ollama 只在用到时影响）；需要的话 schtasks /run /tn \\LocalTTS' : '',
  };
}

/** 截图友好的脱敏：URL 去掉 query（里面的 fileid/rkey 是令牌级的东西），长随机串打码。 */
export function redactLogSample(line) {
  return String(line)
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1?…')
    .replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>')
    .trim()
    .slice(0, 100);
}

async function groupDiskLogs(ctx) {
  const free = ctx.deps.freeBytes(ctx.root);
  // state/bridge.log 与 logs/bridge-stdout.log 是同一份内容的镜像：**按行去重**后再统计，
  // 否则同一条错误会被数两遍（实测 5 条真错误被数成 10）。
  const seen = new Set();
  for (const rel of ['logs/bridge-stdout.log', 'state/bridge.log']) {
    const text = ctx.deps.readText(path.join(ctx.root, rel));
    if (typeof text !== 'string') continue;
    for (const line of text.split(/\r?\n/).slice(-800)) if (line.trim()) seen.add(line);
  }
  const merged = [...seen].join('\n');
  const r = countRecentLogProblems(merged, ctx.now(), 10 * 60 * 1000);
  const lowDisk = free != null && free < 2 * 1024 ** 3;
  const samples = r.samples.map(redactLogSample);
  return {
    id: 'disk_logs', title: '磁盘 / 近 10 分钟日志',
    status: lowDisk || r.error > 5 ? 'fail' : r.error > 0 || lowDisk ? 'warn' : 'ok',
    summary: `磁盘剩 ${fmtGb(free)}；近 10 分钟 error ${r.error} / warn ${r.warn}（扫描 ${r.total} 行，已按行去重两处日志）`,
    evidence: [
      `磁盘可用 ${fmtGb(free)}${lowDisk ? '（低于 2 GB 阈值）' : ''}`,
      `近 10 分钟：error=${r.error} warn=${r.warn}，带时间的日志行 ${r.total}`,
      ...samples.map((s) => `样例：${s}`),
    ],
    suggestion: r.error > 0 ? '先看样例再定位；错误扎堆通常伴随后面的组红（DSH/网关）' : lowDisk ? '清理磁盘（注意别删 state/）' : '',
  };
}

async function groupVersion(ctx) {
  const bootFile = path.join(ctx.root, 'state', 'boot-log.jsonl');
  const text = ctx.deps.readText(bootFile);
  let last = null;
  if (typeof text === 'string') {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e?.event === 'start') last = e; } catch { /* 坏行跳过 */ }
    }
  }
  const alive = last ? ctx.deps.pidAlive(last.pid) : false;
  // 进程新鲜度按「src/ 的最后一个提交」比：只改文档或 public/client.html 不该报警（静态页每请求读盘，不用重启）。
  const srcHeadMs = typeof ctx.deps.gitSrcHeadMs === 'function' ? ctx.deps.gitSrcHeadMs(ctx.root) : null;
  const headMs = srcHeadMs ?? ctx.deps.gitHeadMs(ctx.root);
  const bootAge = last ? ctx.now() - last.t : null;
  const stale = Boolean(headMs && last && headMs - last.t > 60 * 1000);
  return {
    id: 'version', title: '版本 / 进程新鲜度',
    status: !last || !alive ? 'fail' : stale ? 'warn' : 'ok',
    summary: last
      ? `运行 pid ${last.pid} ${alive ? '存活' : '已退出'}；启动于 ${agoText(bootAge)}${stale ? `，早于 git HEAD（在跑旧代码）` : ''}`
      : '没有 boot-log 记录（从没启动过，或 state/ 被清空）',
    evidence: [
      last ? `boot-log 最后 start: pid=${last.pid} t=${new Date(last.t).toLocaleString('zh-CN', { hour12: false })}` : 'state/boot-log.jsonl 无 start 记录',
      `pid ${last?.pid ?? '?'}：${alive ? '进程存在' : '进程不存在（锁文件可能是死的）'}`,
      headMs ? `git HEAD 提交于 ${new Date(headMs).toLocaleString('zh-CN', { hour12: false })}` : '读不到 git HEAD（非仓库目录？）',
      stale ? `HEAD 比启动时间新 ${Math.round((headMs - last.t) / 60000)} 分钟 → 跑的是旧代码，重启才会生效` : '启动时间不早于 HEAD',
    ],
    suggestion: !alive ? '进程已退出：清掉 state/bridge.lock 后重新启动' : stale ? '代码已更新但没重启：按项目纪律改完 src/ 必须重启桥接' : '',
  };
}

// ───────────────────────────── 编排 ─────────────────────────────
export const SELF_CHECK_GROUP_IDS = ['ports', 'snowluma', 'dsh', 'bridge', 'storage', 'config', 'tasks', 'disk_logs', 'version'];

/** --fix 只做两件安全动作：拉起 Ollama、清掉指向死进程的桥接锁。 */
async function applySafeFixes(ctx, groups) {
  const actions = [];
  const ports = groups.find((g) => g.id === 'ports');
  if (ports && /Ollama\(11434\)/.test(ports.summary)) {
    const ok = ctx.deps.runTask('\\Ollama');
    actions.push(`拉起 Ollama 计划任务：${ok ? '已触发' : '触发失败'}`);
    if (ok) {
      await ctx.deps.sleep(4000);
      const up = await ctx.deps.tcp('127.0.0.1', 11434);
      actions.push(`4 秒后 11434：${up ? '已可连' : '仍不通'}`);
    }
  }
  const lock = path.join(ctx.root, 'state', 'bridge.lock');
  const raw = ctx.deps.readText(lock);
  if (typeof raw === 'string') {
    const pid = Number(String(raw).trim());
    if (Number.isInteger(pid) && pid > 0 && !ctx.deps.pidAlive(pid)) {
      const ok = ctx.deps.unlink(lock);
      actions.push(`清理死锁文件 state/bridge.lock（pid ${pid} 不存在）：${ok ? '已删除' : '删除失败'}`);
    }
  }
  return actions;
}

/**
 * 跑九组自检。
 * @param {{root:string, config:object, consolePort?:number, token?:string, deps?:object, fix?:boolean, now?:Function, sampleGapMs?:number, statusProbe?:Function}} opts
 */
export async function runSelfCheck(opts = {}) {
  const deps = opts.deps || createRealDeps();
  const startedAt = deps.now ? deps.now() : Date.now();
  const consolePort = Number(opts.consolePort || opts.config?.consolePort || 3100);
  const ctx = {
    root: path.resolve(opts.root || process.cwd()),
    config: opts.config || {},
    consolePort,
    token: opts.token || '',
    deps,
    now: () => (deps.now ? deps.now() : Date.now()),
    fix: Boolean(opts.fix),
    sampleGapMs: opts.sampleGapMs,
    consoleHeaders() { return this.token ? { 'x-console-token': this.token } : {}; },
    async statusProbe() {
      if (typeof opts.statusProbe === 'function') return opts.statusProbe();
      const r = await deps.httpJson(`http://127.0.0.1:${consolePort}/api/status`, { headers: this.consoleHeaders(), timeoutMs: 5000 });
      return r.body || null;
    },
  };
  const runners = [groupPorts, groupSnowluma, groupDsh, groupBridge, groupStorage, groupConfig, groupTasks, groupDiskLogs, groupVersion];
  const groups = [];
  for (const run of runners) {
    try {
      groups.push(await run(ctx));
    } catch (error) {
      groups.push({
        id: run.name.replace(/^group/, '').toLowerCase(), title: run.name,
        status: 'fail', summary: `检查自身抛错：${String(error?.message ?? error)}`, evidence: [],
        suggestion: '这是自检的 bug，不是系统的；把这条贴给维护者',
      });
    }
  }
  const fixes = ctx.fix ? await applySafeFixes(ctx, groups) : [];
  const overall = worst(groups.map((g) => g.status));
  return {
    ok: overall !== 'fail',
    status: overall,
    at: new Date(startedAt).toISOString(),
    tookMs: (deps.now ? deps.now() : Date.now()) - startedAt,
    counts: {
      ok: groups.filter((g) => g.status === 'ok').length,
      warn: groups.filter((g) => g.status === 'warn').length,
      fail: groups.filter((g) => g.status === 'fail').length,
    },
    groups,
    fixes,
  };
}
