#!/usr/bin/env node
// 重启验收证据收集器（**只读**）：一次运行把 docs/restart-acceptance.md 里三件验收要的证据抓齐。
//
// 为什么要有它：重启后验收目前靠人手工翻 boot-log / social-v2.json / token-usage / tool-calls /
// stickers.json 五处，每处格式不同、口径还容易看错（例如「有 digests 字段」≠「有摘要内容」，
// 「restart 了」≠「换了进程」）。这里把它们收敛成一次运行 + 四段结论，JSON 可直接贴给主窗口。
//
// 四段：
//   ① 换进程了吗   state/bridge.lock 的 pid vs state/boot-log.jsonl 最后一条 start 的 pid
//   ② 摘要落盘了吗 state/social-v2.json 的 digests：条数/最新时间/是否 24h 内
//   ③ 视觉路由生效 state/tool-calls.jsonl 最近一次 qq_get_message_images 的 ok
//                   + 同一回合 state/token-usage.jsonl 里用的模型是否在 cfg.dsh.visionModels
//   ④ 表情卡数      state/stickers.json 条数 + 用真实去重函数算「现在几张卡 / 补齐 dhash 后几张」
//
// 铁律：只读。不写 state/config、不删文件、不重启、不联网。运行前后自带 sha256 比对自证。
//
// 用法：
//   node scripts/collect-restart-evidence.mjs                 # 人读摘要
//   node scripts/collect-restart-evidence.mjs --json          # 机器可读（贴给主窗口）
//   node scripts/collect-restart-evidence.mjs --fast          # 跳过 dhash 补齐（秒出，④ 只报现有 hash 下的卡数）
//   node scripts/collect-restart-evidence.mjs --state <dir> --config <file>
//   node scripts/collect-restart-evidence.mjs --selftest      # 临时目录造样例数据跑通四段 + 只读断言
//
// 退出码：0 跑通（结论好坏不影响退出码）；2 参数错；1 自测失败。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dedupeStickerEntries } from '../src/sticker-lib.js';
import { dhashFromBuffer } from '../src/image-hash.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 3600 * 1000;

// ── 参数 ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    stateDir: path.join(ROOT, 'state'),
    configPath: path.join(ROOT, 'config.json'),
    json: false, selftest: false, fast: false, hashBudgetMs: 90_000, now: Date.now()
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || String(v).startsWith('--')) throw new Error(`${a} 需要一个值`);
      i += 1;
      return v;
    };
    if (a === '--state') out.stateDir = path.resolve(next());
    else if (a === '--config') out.configPath = path.resolve(next());
    else if (a === '--json') out.json = true;
    else if (a === '--fast' || a === '--no-hash') out.fast = true;
    else if (a === '--hash-budget') out.hashBudgetMs = Number(next()) || out.hashBudgetMs;
    else if (a === '--now') {
      const raw = next();
      const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
      if (!Number.isFinite(ms)) throw new Error(`--now 解析不了：${raw}`);
      out.now = ms;
    } else if (a === '--selftest') out.selftest = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

// ── 只读工具 ────────────────────────────────────────────────────────────────
function sha256(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function readTextSafe(file) {
  try {
    // 去掉 BOM：Windows 上手工另存过的文件会带，JSON.parse 会直接炸。
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    return { __error: error?.code === 'ENOENT' ? '文件不存在' : String(error?.message ?? error) };
  }
}

/** 只读最后 maxBytes 字节并按行切开：日志会越跑越大，不能整份读进内存。 */
function readLinesTail(file, maxBytes = 4 * 1024 * 1024) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // 第一行可能被截断，丢掉
    return { ok: true, lines: text.split(/\r?\n/).filter((l) => l.trim()), truncated: start > 0 };
  } catch (error) {
    return { ok: false, lines: [], error: error?.code === 'ENOENT' ? '文件不存在' : String(error?.message ?? error) };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

function parseJsonLines(lines) {
  const out = [];
  for (const line of lines) {
    try { const v = JSON.parse(line); if (v && typeof v === 'object') out.push(v); } catch {}
  }
  return out;
}

function fmtTime(ms) {
  const n = Number(ms);
  if (!n) return '-';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtAge(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 0) return `未来 ${fmtAge(-ms)}（时钟不对？）`;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} 分钟前`;
  return `${(ms / HOUR).toFixed(1)} 小时前`;
}

/** 与 bridge.js 的 modelSeesImages 同一口径：列表项可以写裸模型名，也可以写 provider/model。 */
function modelMatches(list, model, provider) {
  const m = String(model || '');
  const bare = m.includes('/') ? m.split('/').slice(1).join('/') : m;
  const full = provider ? `${provider}/${bare}` : m;
  return (Array.isArray(list) ? list : []).some((v) => {
    const s = String(v || '');
    return s === m || s === bare || s === full || bare.startsWith(`${s}-`);
  });
}

// ── ① 换进程了吗 ─────────────────────────────────────────────────────────────
export function collectProcess({ bootLines, lockText }) {
  const starts = parseJsonLines(bootLines).filter((e) => e.event === 'start' && Number(e.pid) > 0);
  const last = starts.length ? starts[starts.length - 1] : null;
  const prev = starts.length > 1 ? starts[starts.length - 2] : null;
  const lockPid = Number(String(lockText ?? '').trim()) || 0;
  return {
    lockPid,
    bootPid: last ? Number(last.pid) : 0,
    bootAt: last ? Number(last.t) : 0,
    upSeconds: last ? Number(last.up) : 0,
    startCount: starts.length,
    prevPid: prev ? Number(prev.pid) : 0,
    prevAt: prev ? Number(prev.t) : 0,
    pidMatches: Boolean(lockPid && last && lockPid === Number(last.pid)),
    swapped: Boolean(prev && last && Number(prev.pid) !== Number(last.pid))
  };
}

// ── ② 摘要落盘了吗 ───────────────────────────────────────────────────────────
export function collectDigests({ socialV2, now, maxAgeMs = 24 * HOUR }) {
  const obj = socialV2 && typeof socialV2 === 'object' ? socialV2 : {};
  const persisted = Object.prototype.hasOwnProperty.call(obj, 'digests');
  const raw = persisted && obj.digests && typeof obj.digests === 'object' && !Array.isArray(obj.digests) ? obj.digests : {};
  const entries = Object.entries(raw)
    .map(([key, d]) => {
      const at = Number(d?.at) || 0;
      return {
        key: String(key), at, ageMs: now - at, fresh: Number(now) - at <= maxAgeMs,
        summaryLen: String(d?.summary ?? '').length, summary: String(d?.summary ?? '').slice(0, 120)
      };
    })
    .sort((a, b) => b.at - a.at);
  return {
    persisted, count: entries.length,
    newestAt: entries.length ? entries[0].at : 0,
    freshCount: entries.filter((e) => e.fresh).length,
    entries
  };
}

// ── ③ 视觉路由生效了吗 ───────────────────────────────────────────────────────
export function collectVision({ toolCallLines, tokenUsageLines, visionModels, now }) {
  const calls = parseJsonLines(toolCallLines);
  const usage = parseJsonLines(tokenUsageLines);
  let lastCall = null;
  let lastCallIndex = -1;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const e = calls[i];
    if (e.type === 'call' && /get_message_images/.test(String(e.tool || ''))) { lastCall = e; lastCallIndex = i; break; }
  }
  if (!lastCall) {
    return { found: false, visionModels, routedToVision: false, models: [], note: '没有 qq_get_message_images 调用记录：先让群友发一张图并 @ 机器人' };
  }
  let result = null;
  for (let i = lastCallIndex; i < calls.length; i += 1) {
    const e = calls[i];
    if (e.type === 'result' && /get_message_images/.test(String(e.tool || ''))) { result = e; break; }
  }
  const sid = String(lastCall.sessionId || '');
  const turn = lastCall.turn === null || lastCall.turn === undefined ? null : Number(lastCall.turn);
  const callAt = Date.parse(String(lastCall.time || '')) || 0;
  const resultAt = result ? (Date.parse(String(result.time || '')) || 0) : 0;
  // 同一回合里「这一轮模型到底用了谁」：取该会话该回合（有 turn 就按 turn，没有就按时间窗）的采样。
  const inTurn = usage.filter((r) => {
    if (r.k !== 'turn') return false;
    if (sid && String(r.sid || '') !== sid) return false;
    if (turn !== null) return Number(r.turn) === turn;
    return callAt > 0 && Number(r.t) >= callAt - 60_000 && Number(r.t) <= now;
  });
  // 分成「取图之前 / 取图之后」两段——这正是 M1 的关键：
  // 选型发生在**工具把图取回来之前**，所以修复是否生效只能看「取图结果之后」那次请求用的是谁。
  const seen = new Map();
  for (const r of inTurn) {
    const phase = resultAt && Number(r.t) >= resultAt ? 'after' : 'before';
    const key = `${phase}|${r.provider || ''}/${r.model || ''}`;
    if (!seen.has(key)) seen.set(key, { model: String(r.model || ''), provider: String(r.provider || ''), at: Number(r.t) || 0, samples: 0, phase });
    seen.get(key).samples += 1;
  }
  const models = [...seen.values()].sort((a, b) => b.at - a.at);
  const afterModels = models.filter((m) => m.phase === 'after');
  const beforeModels = models.filter((m) => m.phase === 'before');
  const judged = afterModels.length ? afterModels : beforeModels;
  return {
    found: true,
    at: callAt,
    resultAt,
    ok: result ? result.ok === true : null,
    error: result ? result.error ?? null : '没有配对的 result 记录',
    key: String(lastCall.key || ''),
    sessionId: sid,
    turn,
    models,
    beforeModels,
    afterModels,
    judgedBy: afterModels.length ? 'after' : 'before',
    visionModels,
    routedToVision: judged.some((m) => modelMatches(visionModels, m.model, m.provider)),
    note: result ? '' : '只有 call 没有 result（工具可能还在跑，或那一轮中断了）'
  };
}

// ── ④ 表情卡数 ───────────────────────────────────────────────────────────────
export function collectStickers({ entries, filesDir, hashFile, now, hashBudgetMs = 90_000 }) {
  const list = Array.isArray(entries) ? entries : [];
  const missing = list.filter((e) => !String(e.dhash || '').trim());
  const existing = list.length - missing.length;
  const cardsNow = dedupeStickerEntries(list).length; // 只用现有 dhash 能并成几张
  const started = Date.now();
  let filled = 0;
  let noFile = 0;
  let hashFail = 0;
  let partial = false;
  const cloned = list.map((e) => ({ ...e })); // 深拷贝第一层：绝不动传进来的对象
  if (typeof hashFile === 'function') {
    for (const e of cloned) {
      if (String(e.dhash || '').trim()) continue;
      if (Date.now() - started > hashBudgetMs) { partial = true; break; }
      const md5 = String(e.md5 || '').trim().toUpperCase();
      const file = md5 ? path.join(filesDir, `${md5}.img`) : '';
      if (!file || !fs.existsSync(file)) { noFile += 1; continue; }
      let dh = null;
      try { dh = hashFile(file); } catch { dh = null; }
      if (!dh) { hashFail += 1; continue; }
      e.dhash = dh;
      filled += 1;
    }
  } else {
    partial = true; // 没给 hashFile（--fast）：不做补齐估算
  }
  const cardsAfter = dedupeStickerEntries(cloned).length;
  return {
    entries: list.length,
    withDhash: existing,
    missingDhash: missing.length,
    filled, noFile, hashFail, partial,
    cardsNow,
    cardsAfterBackfill: cardsAfter,
    mergedAfterBackfill: cardsNow - cardsAfter,
    hashed: typeof hashFile === 'function'
  };
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
export function collectAll({ stateDir, configPath, now = Date.now(), fast = false, hashFile, hashBudgetMs = 90_000 } = {}) {
  const files = {
    bootLog: path.join(stateDir, 'boot-log.jsonl'),
    lock: path.join(stateDir, 'bridge.lock'),
    socialV2: path.join(stateDir, 'social-v2.json'),
    toolCalls: path.join(stateDir, 'tool-calls.jsonl'),
    tokenUsage: path.join(stateDir, 'token-usage.jsonl'),
    stickers: path.join(stateDir, 'stickers.json')
  };
  const before = {};
  for (const f of Object.values(files)) before[f] = sha256(f);

  const boot = readLinesTail(files.bootLog, 512 * 1024);
  const proc = collectProcess({ bootLines: boot.lines, lockText: (() => { const t = readTextSafe(files.lock); return typeof t === 'string' ? t : ''; })() });

  const socialRaw = readTextSafe(files.socialV2);
  let social = {};
  let socialError = null;
  if (typeof socialRaw === 'string') {
    try { social = JSON.parse(socialRaw); } catch (e) { socialError = String(e?.message ?? e); }
  } else socialError = socialRaw.__error;
  const digests = collectDigests({ socialV2: social, now });

  const cfgRaw = readTextSafe(configPath);
  let cfg = {};
  let configError = null;
  if (typeof cfgRaw === 'string') {
    try { cfg = JSON.parse(cfgRaw) || {}; } catch (e) { configError = String(e?.message ?? e); }
  } else configError = cfgRaw.__error;
  const visionModels = Array.isArray(cfg?.dsh?.visionModels) ? cfg.dsh.visionModels.map(String) : [];

  const vision = collectVision({
    toolCallLines: readLinesTail(files.toolCalls, 1024 * 1024).lines,
    tokenUsageLines: readLinesTail(files.tokenUsage, 2 * 1024 * 1024).lines,
    visionModels, now
  });

  const stickersRaw = readTextSafe(files.stickers);
  let stickerEntries = [];
  let stickerError = null;
  if (typeof stickersRaw === 'string') {
    try { const v = JSON.parse(stickersRaw); stickerEntries = Array.isArray(v) ? v : []; } catch (e) { stickerError = String(e?.message ?? e); }
  } else stickerError = stickersRaw.__error;
  const stickers = collectStickers({
    entries: stickerEntries,
    filesDir: path.join(stateDir, 'sticker-files'),
    hashFile: fast ? null : (hashFile || ((file) => dhashFromBuffer(fs.readFileSync(file)))),
    now, hashBudgetMs
  });

  // 只读自证：跑完再算一遍 sha256，任何一个变了都说明这个脚本不该被信任。
  const changed = [];
  for (const [name, f] of Object.entries(files)) {
    const after = sha256(f);
    if ((before[f] || null) !== (after || null)) changed.push({ name, file: f, before: before[f], after });
  }

  const verdicts = {
    process: proc.pidMatches && proc.swapped ? 'ok' : proc.pidMatches ? 'warn' : 'bad',
    digests: digests.persisted && digests.count > 0 ? 'ok' : digests.persisted ? 'warn' : 'bad',
    vision: !vision.found ? 'warn'
      : (vision.ok !== true ? 'bad'
        : (vision.afterModels.length ? (vision.routedToVision ? 'ok' : 'bad') : 'warn')),
    stickers: stickers.entries ? 'info' : 'warn'
  };

  return {
    now, stateDir, configPath, files, proc, digests, vision, stickers, configError, socialError, stickerError,
    readOnly: { ok: changed.length === 0, changed },
    verdicts
  };
}

// ── 人读摘要 ────────────────────────────────────────────────────────────────
const ICON = { ok: '✅', warn: '⚠️', bad: '❌', info: 'ℹ️' };

function printReport(r) {
  console.log(`重启验收证据（只读）  现在 ${fmtTime(r.now)}`);
  console.log(`  state: ${r.stateDir}`);
  console.log('');

  const p = r.proc;
  console.log(`${ICON[r.verdicts.process]} ① 换进程了吗`);
  console.log(`   bridge.lock pid = ${p.lockPid || '(无)'}；boot-log 最后一条 start pid = ${p.bootPid || '(无)'}（${fmtTime(p.bootAt)}，up=${p.upSeconds}s）`);
  console.log(`   启动记录 ${p.startCount} 条${p.prevPid ? `；上一条 start pid = ${p.prevPid}（${fmtTime(p.prevAt)}）` : ''}`);
  console.log(`   ${p.pidMatches ? 'pid 一致（lock 与 boot-log 指向同一进程）' : 'pid 不一致：可能正在重启中，或 lock 没更新'}`);
  console.log(`   ${p.swapped ? 'pid 与上一条不同 → 确实换过进程' : '只有一条启动记录 / pid 未变 → 看不到「换进程」的证据'}`);

  const d = r.digests;
  console.log('');
  console.log(`${ICON[r.verdicts.digests]} ② 摘要落盘了吗（T12）`);
  if (r.socialError) console.log(`   ⚠️ social-v2.json 读不了或坏了：${r.socialError}`);
  console.log(`   digests 字段：${d.persisted ? '有' : '没有（旧代码写的 state，或还没保存过）'}；条数 ${d.count}`);
  if (d.count) {
    console.log(`   最新一条：${fmtTime(d.newestAt)}（${fmtAge(r.now - d.newestAt)}），24h 内 ${d.freshCount} 条`);
    for (const e of d.entries.slice(0, 10)) {
      console.log(`     · ${e.key}  ${fmtTime(e.at)}  ${e.fresh ? '24h 内' : '已过期'}  ${e.summaryLen} 字  ${e.summary.replace(/\s+/g, ' ').slice(0, 60)}`);
    }
  } else {
    console.log('   0 条：落盘路径已生效也只说明「字段在了」。要出内容，某会话得在**本次重启后**再收满 20 条入站消息。');
  }

  const v = r.vision;
  console.log('');
  console.log(`${ICON[r.verdicts.vision]} ③ 视觉路由生效了吗（M1）`);
  if (!v.found) {
    console.log(`   ${v.note}`);
  } else {
    console.log(`   最近一次 qq_get_message_images：${fmtTime(v.at)}（${fmtAge(r.now - v.at)}）  ok=${v.ok === null ? '(无 result)' : v.ok}  session=${v.sessionId || '-'}  turn=${v.turn ?? '-'}`);
    if (v.error) console.log(`   ⚠️ ${v.error}`);
    console.log(`   dsh.visionModels = ${v.visionModels.length ? v.visionModels.join('、') : '(未配置)'}`);
    if (!v.models.length) console.log('   同回合没有 token-usage 采样（可能不是经由桥接的这一轮）');
    for (const m of v.models.slice(0, 6)) {
      const hit = modelMatches(v.visionModels, m.model, m.provider);
      const phase = m.phase === 'after' ? '取图之后' : '取图之前';
      console.log(`     · [${phase}] ${m.provider}/${m.model}  ${m.samples} 条采样  ${hit ? '✅ 可看图' : '❌ 不声明图片输入'}`);
    }
    if (!v.afterModels.length) {
      console.log('   ⚠️ 取图结果之后还没有模型采样：这一轮可能还没继续（或正在请求）。');
      console.log('      上面「取图之前」那几条属于选型早于取图的步骤，本来就该是原模型，不能拿来判 M1。');
    }
    console.log(`   ${v.afterModels.length
      ? (v.routedToVision ? '✅ 取图之后这一轮切到了视觉模型' : '❌ 取图之后仍在用不声明图片输入的模型 → 图片会降级成文字说明')
      : '（等这一轮继续，再看「取图之后」用的模型）'}`);
  }

  const s = r.stickers;
  console.log('');
  console.log(`${ICON[r.verdicts.stickers]} ④ 表情卡数（M2）`);
  if (r.stickerError) console.log(`   ⚠️ stickers.json：${r.stickerError}`);
  console.log(`   库内 ${s.entries} 条；已有 dhash ${s.withDhash} 条、缺 ${s.missingDhash} 条`);
  if (s.hashed) console.log(`   本次只读补齐预览：可算 ${s.filled} 条（缺本地图 ${s.noFile}、算不出 ${s.hashFail}）${s.partial ? '（超时中止，partial）' : ''}`);
  console.log(`   按现有 dhash 去重：${s.cardsNow} 张卡`);
  if (s.entries && s.cardsNow === s.entries) console.log('   → 文件里已没有重复条目（M2 的去重已在加载时收敛并写回）');
  else if (s.entries) console.log(`   → 文件里还有 ${s.entries - s.cardsNow} 条重复，面板会合并显示`);
  if (s.hashed) console.log(`   补齐 dhash 后预计：${s.cardsAfterBackfill} 张卡（并掉 ${s.mergedAfterBackfill} 条）`);
  else console.log('   补齐后卡数：用 --fast 跳过了（去掉 --fast 可估算，约 1 分钟）');
  console.log('   注：面板实际卡数以 /ops 渲染为准，这里只是按同一套 dedupeStickerEntries 算的等价值（不写盘）。');

  console.log('');
  console.log(`只读自证：${r.readOnly.ok ? '✅ 运行前后 6 个文件 sha256 全部一致' : `❌ 有文件被改动：${r.readOnly.changed.map((c) => c.name).join(', ')}`}`);
  console.log(`结论：进程 ${ICON[r.verdicts.process]} · 摘要 ${ICON[r.verdicts.digests]} · 视觉 ${ICON[r.verdicts.vision]} · 表情 ${ICON[r.verdicts.stickers]}`);
}

// ── 自测：临时目录造样例，跑通四段 + 只读断言 ────────────────────────────────
function runSelftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-restart-evidence-'));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'sticker-files'), { recursive: true });
  const now = 1_760_000_000_000;
  let failed = 0;
  const check = (name, fn) => {
    try { fn(); console.log(`✅ ${name}`); } catch (e) { failed += 1; console.error(`❌ ${name} — ${e?.message ?? e}`); }
  };
  const W = (name, text) => fs.writeFileSync(path.join(state, name), text, 'utf8');
  try {
    // ① 两次启动：旧 111 → 新 222，lock 指向 222
    W('boot-log.jsonl', [
      JSON.stringify({ t: now - 3600_000, event: 'start', pid: 111, ppid: 1, up: 0 }),
      JSON.stringify({ t: now - 60_000, event: 'start', pid: 222, ppid: 1, up: 0 })
    ].join('\n') + '\n');
    W('bridge.lock', '222');
    // ② 一条 24h 内、一条过期
    W('social-v2.json', JSON.stringify({
      conversations: {},
      digests: {
        'group:111': { key: 'group:111', at: now - 600_000, summary: '甲：今晚开黑', people: ['甲'] },
        'group:222': { key: 'group:222', at: now - 25 * HOUR, summary: '旧摘要', people: [] }
      }
    }));
    // ③ 一次成功的取图 + 同回合视觉模型；另有一轮非视觉模型（不该被误判）
    W('tool-calls.jsonl', [
      { type: 'call', time: new Date(now - 120_000).toISOString(), key: 'group:111', sessionId: 'sid-1', turn: 3, tool: 'mcp__snowluma__qq_get_message_images', args: '{}' },
      { type: 'result', time: new Date(now - 119_000).toISOString(), key: 'group:111', sessionId: 'sid-1', tool: 'mcp__snowluma__qq_get_message_images', ok: true, error: null },
      { type: 'call', time: new Date(now - 60_000).toISOString(), key: 'group:111', sessionId: 'sid-1', turn: 9, tool: 'mcp__snowluma__qq_wait_for_messages', args: '{}' }
    ].map((x) => JSON.stringify(x)).join('\n') + '\n');
    W('token-usage.jsonl', [
      { k: 'turn', t: now - 118_000, sid: 'sid-1', key: 'group:111', turn: 3, step: 2, retry: 0, model: 'deepseek-flash', provider: 'deepseek-account', b: {} },
      { k: 'turn', t: now - 110_000, sid: 'sid-1', key: 'group:111', turn: 9, step: 1, retry: 0, model: 'deepseek-v4.1-flash', provider: 'workbuddy2api', b: {} },
      { k: 'base', t: now - 100_000, sid: 'sid-1', key: 'group:111', model: 'deepseek-flash', provider: 'deepseek-account', b: {} }
    ].map((x) => JSON.stringify(x)).join('\n') + '\n');
    // ④ 4 条：两条 md5 相同（必然并）、两条 dhash 距离 1（补齐后并）、一条独立
    const dh = '0000000000000000';
    const dhNear = '0000000000000001';
    W('stickers.json', JSON.stringify([
      { id: 's1', md5: 'AA', dhash: dh, tags: [] },
      { id: 's2', md5: 'AA', dhash: '', tags: [] },
      { id: 's3', md5: 'BB', dhash: '', tags: [] },
      { id: 's4', md5: 'CC', dhash: '', tags: [] }
    ]));
    for (const [m, name] of [['AA', 'a'], ['BB', 'b'], ['CC', 'c']]) fs.writeFileSync(path.join(state, 'sticker-files', `${m}.img`), `fake-${name}`);
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ dsh: { visionModels: ['deepseek-flash'] } }), 'utf8');

    const hashFile = (file) => {
      const tag = path.basename(file);
      return tag.startsWith('AA') ? dh : tag.startsWith('BB') ? dhNear : '1111111111111111';
    };
    const filesBefore = {};
    for (const f of fs.readdirSync(state)) { const p = path.join(state, f); if (fs.statSync(p).isFile()) filesBefore[f] = sha256(p); }
    const r = collectAll({ stateDir: state, configPath: cfgPath, now, hashFile });

    check('① 进程：lock 与 boot-log 最后一条 start 一致，且与上一条 pid 不同', () => {
      if (r.proc.lockPid !== 222 || r.proc.bootPid !== 222) throw new Error(`实得 ${JSON.stringify(r.proc)}`);
      if (!r.proc.pidMatches) throw new Error('pidMatches 应为 true');
      if (!r.proc.swapped || r.proc.prevPid !== 111) throw new Error('swap/prev 不对');
      if (r.verdicts.process !== 'ok') throw new Error(`verdict=${r.verdicts.process}`);
    });
    check('② 摘要：识别出 2 条、其中 1 条 24h 内、最新时间正确', () => {
      if (!r.digests.persisted || r.digests.count !== 2) throw new Error(`实得 ${JSON.stringify({ p: r.digests.persisted, c: r.digests.count })}`);
      if (r.digests.freshCount !== 1) throw new Error(`freshCount=${r.digests.freshCount}`);
      if (r.digests.newestAt !== now - 600_000) throw new Error(`newestAt=${r.digests.newestAt}`);
      if (r.verdicts.digests !== 'ok') throw new Error(`verdict=${r.verdicts.digests}`);
    });
    check('③ 视觉：取最近一次 get_message_images，配对 result ok，并只认同回合的模型', () => {
      if (!r.vision.found || r.vision.ok !== true) throw new Error(`实得 ${JSON.stringify(r.vision)}`);
      if (r.vision.turn !== 3) throw new Error(`turn=${r.vision.turn}`);
      const models = r.vision.models.map((m) => m.model);
      if (models.includes('deepseek-v4.1-flash')) throw new Error('不该把别的回合（turn 9）的模型算进来');
      if (!r.vision.routedToVision) throw new Error('应判定走了视觉模型');
      if (r.verdicts.vision !== 'ok') throw new Error(`verdict=${r.verdicts.vision}`);
    });
    check('④ 表情：md5 重复 + dhash 近邻都算进去，补齐后卡数变小', () => {
      if (r.stickers.entries !== 4) throw new Error(`entries=${r.stickers.entries}`);
      if (r.stickers.cardsNow !== 3) throw new Error(`cardsNow=${r.stickers.cardsNow}（期望 3：s1/s2 同 md5 并掉）`);
      if (r.stickers.filled !== 3) throw new Error(`filled=${r.stickers.filled}`);
      if (r.stickers.cardsAfterBackfill !== 2) throw new Error(`cardsAfterBackfill=${r.stickers.cardsAfterBackfill}（期望 2：s1+s3 近邻再并一个）`);
      if (r.stickers.mergedAfterBackfill !== 1) throw new Error(`merged=${r.stickers.mergedAfterBackfill}`);
    });
    check('③ 取图之后没有采样时只判 warn，不误报「视觉路由失败」', () => {
      const st2 = path.join(dir, 'state-pending');
      fs.mkdirSync(st2, { recursive: true });
      const t0 = now - 30_000;
      fs.writeFileSync(path.join(st2, 'tool-calls.jsonl'), [
        { type: 'call', time: new Date(t0).toISOString(), key: 'group:111', sessionId: 'sid-2', turn: 4, tool: 'mcp__snowluma__qq_get_message_images' },
        { type: 'result', time: new Date(t0 + 500).toISOString(), key: 'group:111', sessionId: 'sid-2', tool: 'mcp__snowluma__qq_get_message_images', ok: true }
      ].map((x) => JSON.stringify(x)).join('\n') + '\n');
      // 只有「取图之前」的采样：说明这一轮还没继续，不能据此判 M1 失败。
      fs.writeFileSync(path.join(st2, 'token-usage.jsonl'), JSON.stringify({ k: 'turn', t: t0 - 2_000, sid: 'sid-2', key: 'group:111', turn: 4, model: 'deepseek-v4.1-flash', provider: 'workbuddy2api' }) + '\n');
      const r2 = collectAll({ stateDir: st2, configPath: cfgPath, now, fast: true });
      if (r2.vision.afterModels.length !== 0) throw new Error('不该有 after 采样');
      if (r2.vision.judgedBy !== 'before') throw new Error(`judgedBy=${r2.vision.judgedBy}`);
      if (r2.verdicts.vision !== 'warn') throw new Error(`verdict=${r2.verdicts.vision}（应为 warn 而不是 bad）`);
    });
    check('③ 取图之后用了非视觉模型时才判 bad', () => {
      const st3 = path.join(dir, 'state-bad');
      fs.mkdirSync(st3, { recursive: true });
      const t0 = now - 30_000;
      fs.writeFileSync(path.join(st3, 'tool-calls.jsonl'), [
        { type: 'call', time: new Date(t0).toISOString(), key: 'group:111', sessionId: 'sid-3', turn: 7, tool: 'mcp__snowluma__qq_get_message_images' },
        { type: 'result', time: new Date(t0 + 500).toISOString(), key: 'group:111', sessionId: 'sid-3', tool: 'mcp__snowluma__qq_get_message_images', ok: true }
      ].map((x) => JSON.stringify(x)).join('\n') + '\n');
      fs.writeFileSync(path.join(st3, 'token-usage.jsonl'), JSON.stringify({ k: 'turn', t: t0 + 1_000, sid: 'sid-3', key: 'group:111', turn: 7, model: 'deepseek-v4.1-flash', provider: 'workbuddy2api' }) + '\n');
      const r3 = collectAll({ stateDir: st3, configPath: cfgPath, now, fast: true });
      if (r3.vision.afterModels.length !== 1) throw new Error('应有一条 after 采样');
      if (r3.verdicts.vision !== 'bad') throw new Error(`verdict=${r3.verdicts.vision}`);
    });
    check('只读自证：跑完 state 下每个文件 sha256 没变，也没多出文件', () => {
      if (!r.readOnly.ok) throw new Error(`changed=${JSON.stringify(r.readOnly.changed)}`);
      const after = fs.readdirSync(state).filter((f) => fs.statSync(path.join(state, f)).isFile());
      const added = after.filter((f) => !(f in filesBefore));
      if (added.length) throw new Error(`多出文件：${added.join(',')}`);
      for (const [f, h] of Object.entries(filesBefore)) if (sha256(path.join(state, f)) !== h) throw new Error(`${f} 被改了`);
    });
    check('缺文件时不炸：空 state 目录也能跑出四段', () => {
      const empty = path.join(dir, 'empty-state');
      fs.mkdirSync(empty, { recursive: true });
      const r2 = collectAll({ stateDir: empty, configPath: path.join(dir, 'nope.json'), now, fast: true });
      if (r2.proc.bootPid !== 0 || r2.digests.count !== 0) throw new Error('空目录应给出 0 值');
      if (r2.verdicts.process !== 'bad' || r2.verdicts.digests !== 'bad') throw new Error('空目录应判 bad');
      if (!r2.readOnly.ok) throw new Error('空目录不该报告改动');
      if (!r2.configError) throw new Error('应报告 config 读不到');
    });
    check('--fast（不给 hashFile）时不谎报补齐结果', () => {
      const r3 = collectAll({ stateDir: state, configPath: cfgPath, now, fast: true });
      if (r3.stickers.hashed) throw new Error('hashed 应为 false');
      if (r3.stickers.filled !== 0) throw new Error('fast 模式不该算 hash');
      if (r3.stickers.cardsAfterBackfill !== r3.stickers.cardsNow) throw new Error('fast 模式补齐后应等于现有卡数');
    });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  console.log('');
  if (failed) { console.error(`❌ 自测失败 ${failed} 项`); process.exit(1); }
  console.log('🎉 重启验收取证器自测通过（四段 + 只读自证 + 空目录 + fast 模式）');
}

// ── 入口 ────────────────────────────────────────────────────────────────────
let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`参数错误：${error.message}`);
  process.exit(2);
}
if (args.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 27).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(0);
}
if (args.selftest) runSelftest();
else {
  const report = collectAll({
    stateDir: args.stateDir, configPath: args.configPath, now: args.now,
    fast: args.fast, hashBudgetMs: args.hashBudgetMs
  });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
}
