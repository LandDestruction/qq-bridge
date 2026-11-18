#!/usr/bin/env node
// 跨会话记忆探针（只读）：打印「谁会记住谁」，以及在没数据时明确说清楚差什么。
//
// 为什么要有它：跨会话记忆链路的验收条件是「两个群各 20 条消息、24h 内、都在白名单」，
// 这三个条件在真实群里很难凑齐，也很难等（每群每 20 条入站消息才刷一次摘要，且计数在
// 进程内存里、重启清零）。于是「功能没生效」既可能是没数据、可能是掉了白名单、可能是
// 超过了 24h，也可能是桥接重启把摘要丢了 —— 光看回复分不清。这个探针把这四种情形分开报。
//
// 铁律：**只读**。绝不写 state/，绝不触发摘要生成，绝不改 config.json。
//      自测（--selftest）只在系统临时目录里造数据，跑完删掉。
//
// 用法：
//   node scripts/probe-cross-session.mjs                    # 读本仓库 state/social-v2.json + config.json
//   node scripts/probe-cross-session.mjs --current group:123 # 假设「现在在 123 群说话」，看会注入哪几条
//   node scripts/probe-cross-session.mjs --state <dir> --config <file>  # 指向别处（自测/主仓库）
//   node scripts/probe-cross-session.mjs --now 2026-01-01T00:00:00+08:00 # 模拟时间，验 24h 衰减
//   node scripts/probe-cross-session.mjs --json             # 机器可读
//   node scripts/probe-cross-session.mjs --selftest         # 无数据/有数据两种情形自证（临时目录）
//
// 退出码：0 = 探针跑通（有没有摘要都算跑通）；2 = 参数错误；1 = 自测失败。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pickDigests, renderDigestBlock, DIGEST_DEFAULTS } from '../src/cross-session-memory.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ── 参数 ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { state: path.join(ROOT, 'state'), config: path.join(ROOT, 'config.json'), now: Date.now(), currents: [], json: false, selftest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || String(v).startsWith('--')) throw new Error(`${a} 需要一个值`);
      i += 1;
      return v;
    };
    if (a === '--state') out.state = path.resolve(next());
    else if (a === '--config') out.config = path.resolve(next());
    else if (a === '--now') {
      const raw = next();
      const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
      if (!Number.isFinite(ms)) throw new Error(`--now 解析不了：${raw}`);
      out.now = ms;
    } else if (a === '--current') out.currents.push(String(next()));
    else if (a === '--json') out.json = true;
    else if (a === '--selftest') out.selftest = true;
    else if (a === '-h' || a === '--help') { out.help = true; }
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

// ── 读取（全部只读，任何异常都降级成「读不到」，不抛） ────────────────────────
function readJsonSafe(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error?.code === 'ENOENT' ? '文件不存在' : String(error?.message ?? error) };
  }
}

function fmtTime(ms) {
  if (!ms) return '-';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtAge(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 0) return `未来 ${fmtAge(-ms)}（时钟不对？）`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = (ms / 3600000).toFixed(1);
  return `${h} 小时前`;
}

/** 从 config 里取白名单与阈值（缺字段就回落代码默认，与 bridge.js 的读法一致）。 */
function readConfig(cfgPath) {
  const r = readJsonSafe(cfgPath);
  const cfg = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
  const m = cfg.socialV2?.memory?.crossSession ?? {};
  const opts = {
    enabled: m.enabled !== false,
    everyMessages: Math.max(5, Number(m.everyMessages) || DIGEST_DEFAULTS.everyMessages),
    maxAgeMs: Number(m.maxAgeMs) || DIGEST_DEFAULTS.maxAgeMs,
    maxSessions: Number(m.maxSessions) || DIGEST_DEFAULTS.maxSessions,
    maxCharsEach: Number(m.maxCharsEach) || DIGEST_DEFAULTS.maxCharsEach,
    maxBlockChars: Number(m.maxBlockChars) || DIGEST_DEFAULTS.maxBlockChars
  };
  const allowGroups = (Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : []).map(String);
  const allowPrivate = (Array.isArray(cfg.allow?.private) ? cfg.allow.private : []).map(String);
  return {
    found: r.ok,
    error: r.ok ? null : r.error,
    opts,
    allowGroups,
    allowPrivate,
    allowKeys: [...allowGroups.map((g) => `group:${g}`), ...allowPrivate.map((u) => `private:${u}`)]
  };
}

// ── 核心：不写盘、只算「现在会注入什么」 ────────────────────────────────────
export function analyze({ stateDir, configPath, now = Date.now(), currents = [] } = {}) {
  const cfg = readConfig(configPath);
  const stateFile = path.join(stateDir, 'social-v2.json');
  const stateRead = readJsonSafe(stateFile);
  const state = stateRead.ok && stateRead.value && typeof stateRead.value === 'object' ? stateRead.value : {};
  const digests = state.digests && typeof state.digests === 'object' && !Array.isArray(state.digests) ? state.digests : {};
  const conversations = state.conversations && typeof state.conversations === 'object' ? state.conversations : {};
  const allowSet = new Set(cfg.allowKeys);

  const rows = Object.entries(digests).map(([key, d]) => {
    const at = Number(d?.at) || 0;
    const ageMs = now - at;
    const fresh = ageMs <= cfg.opts.maxAgeMs;
    const inAllow = allowSet.has(String(key));
    return {
      key: String(key),
      at,
      ageMs,
      fresh,
      inAllow,
      summary: String(d?.summary ?? ''),
      summaryLen: String(d?.summary ?? '').length,
      people: Array.isArray(d?.people) ? d.people : [],
      topics: Array.isArray(d?.topics) ? d.topics : []
    };
  }).sort((a, b) => b.at - a.at);

  const currentList = currents.length ? currents.map(String)
    : (Object.keys(conversations).length ? Object.keys(conversations) : cfg.allowKeys);

  const injections = currentList.map((current) => {
    const items = cfg.opts.enabled
      ? pickDigests({ digests, currentKey: current, allowKeys: cfg.allowKeys, now, opts: cfg.opts })
      : [];
    return {
      current,
      items: items.map((i) => ({ key: i.key, at: i.at, summary: i.summary })),
      block: cfg.opts.enabled ? renderDigestBlock(items, { maxBlockChars: cfg.opts.maxBlockChars }) : ''
    };
  });

  // 每群进度：摘要靠「每 N 条入站消息」触发，计数在进程内存里（重启清零），
  // 所以 recentMessages 的长度只是上界参考，不是「还差几条」的准确值。
  const progress = Object.keys(conversations).map((key) => {
    const st = conversations[key];
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages.length : 0;
    return { key, recentMessages: recent, hasDigest: Boolean(digests[key]), inAllow: allowSet.has(String(key)) };
  }).sort((a, b) => b.recentMessages - a.recentMessages);

  // 磁盘上有没有 digests 字段，决定「重启后还记不记得」：旧版 saveSocialV2State 不写它，
  // 摘要只活在内存、重启即清空（T12 已修）。所以这里必须区分「这份 state 是旧版写的」
  // 和「摘要刚被清空」，否则「磁盘没摘要」会被误读成「功能没跑」。
  const persisted = Object.prototype.hasOwnProperty.call(state, 'digests');

  const conclusions = [];
  conclusions.push(`摘要存储：${stateFile}（${stateRead.ok ? '已读到' : `读不到：${stateRead.error}`}）`);
  if (stateRead.ok && !persisted) {
    conclusions.push('磁盘上没有 digests 字段：要么这份 state 是旧版本写的（旧版不落盘摘要、重启即丢），要么桥接还没来得及刷新摘要。新版保存一次后这里会出现 digests。');
  }
  conclusions.push(`摘要条数：${rows.length}；白名单会话：${cfg.allowKeys.length || 0} 个${cfg.allowKeys.length ? `（${cfg.allowKeys.join('、')}）` : ''}`);
  if (!cfg.found) conclusions.push(`config.json 读不到（${cfg.error}）：白名单按空处理，因此现在**一条都不会注入**。`);
  if (!cfg.opts.enabled) conclusions.push('crossSession.enabled === false：开关关着，摘要不注入。');
  if (!rows.length) {
    conclusions.push(`当前无可用摘要，需要两群各 >=${cfg.opts.everyMessages} 条消息（计数在进程内存里，重启清零；摘要本身自 T12 起会落盘）。`);
  } else {
    const usable = rows.filter((r) => r.fresh && r.inAllow);
    if (!usable.length) conclusions.push('有摘要，但都不满足「白名单 + 24h 内」，因此一条都不会注入。');
    else conclusions.push(`可注入摘要：${usable.length} 条（${usable.map((u) => u.key).join('、')}），按时间倒序最多取 ${cfg.opts.maxSessions} 条。`);
  }
  for (const inj of injections) {
    if (!inj.items.length) conclusions.push(`若现在在 ${inj.current} 说话：不会注入任何近况。`);
    else conclusions.push(`若现在在 ${inj.current} 说话：会注入 ${inj.items.map((i) => i.key).join('、')}（${inj.items.length} 条，整块 ${inj.block.length} 字）。`);
  }

  return { now, stateFile, stateRead, configFile: configPath, cfg, digests, persisted, rows, progress, injections, conclusions };
}

// ── 报告 ────────────────────────────────────────────────────────────────────
function printReport(r) {
  const o = r.cfg.opts;
  console.log('跨会话记忆探针（只读）');
  console.log(`  现在               ${fmtTime(r.now)}`);
  console.log(`  摘要存储           ${r.stateFile}`);
  console.log(`  配置               ${r.configFile}${r.cfg.found ? '' : '（读不到）'}`);
  console.log(`  阈值/窗口         每 ${o.everyMessages} 条入站消息刷一次 · ${(o.maxAgeMs / 3600000).toFixed(0)}h 内 · 最多 ${o.maxSessions} 个会话 · 每个 ${o.maxCharsEach} 字 · 整块 ${o.maxBlockChars} 字`);
  console.log(`  开关              ${o.enabled ? '开' : '关（enabled=false）'}`);
  console.log(`  白名单群          ${r.cfg.allowGroups.join('、') || '(空)'}`);
  console.log(`  白名单私聊        ${r.cfg.allowPrivate.join('、') || '(空)'}`);

  console.log('');
  console.log(`摘要（${r.rows.length} 条）`);
  if (!r.rows.length) {
    console.log('  （空）');
  } else {
    for (const row of r.rows) {
      const flags = [row.fresh ? '24h 内' : '已过期', row.inAllow ? '白名单' : '非白名单'];
      console.log(`  ${row.key}  ${fmtTime(row.at)}（${fmtAge(row.ageMs)}）  ${row.summaryLen} 字  [${flags.join(' / ')}]`);
      if (row.summary) console.log(`    ${row.summary.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }

  if (r.progress.length) {
    console.log('');
    console.log(`各会话进度（${r.cfg.opts.everyMessages} 条入站消息触发一次刷新；计数在进程内存里，重启清零）`);
    for (const p of r.progress.slice(0, 20)) {
      const tag = p.hasDigest ? '已有摘要' : '无摘要';
      console.log(`  ${p.key}  最近消息 ${p.recentMessages} 条  ${tag}${p.inAllow ? '' : '  (不在白名单)'}`);
    }
  }

  console.log('');
  console.log('注入判定');
  if (!r.injections.length) console.log('  （没有可假设的当前会话；用 --current group:群号 指定）');
  for (const inj of r.injections.slice(0, 10)) {
    console.log(`  当前会话 ${inj.current}`);
    if (!inj.items.length) { console.log('    → 不注入'); continue; }
    for (const it of inj.items) console.log(`    → ${it.key}  ${fmtTime(it.at)}  ${it.summary.slice(0, 80)}`);
  }

  console.log('');
  console.log('结论');
  for (const c of r.conclusions) console.log(`  · ${c}`);
}

// ── 自测：在临时目录里造「无数据 / 有数据」两种情形，断言结论可读且只读 ────────
function sha(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function runSelftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-cross-session-'));
  const stateDir = path.join(dir, 'state');
  const cfgPath = path.join(dir, 'config.json');
  const statePath = path.join(stateDir, 'social-v2.json');
  const now = 1_760_000_000_000;
  let failed = 0;
  const check = (name, fn) => {
    try { fn(); console.log(`✅ ${name}`); } catch (e) { failed += 1; console.error(`❌ ${name} — ${e?.message ?? e}`); }
  };
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({
      allow: { groups: [111, 222], private: [90001] },
      socialV2: { memory: { crossSession: { everyMessages: 20 } } }
    }), 'utf8');

    // 情形一：完全没有 state 文件（全新工作树 / 没跑过桥接）。
    console.log('\n[情形一] 没有 state/social-v2.json');
    let r = analyze({ stateDir, configPath: cfgPath, now, currents: ['group:111'] });
    check('无 state 文件时跑通、不抛异常', () => {
      if (r.rows.length !== 0) throw new Error(`不该有摘要，实得 ${r.rows.length}`);
      if (!r.conclusions.some((c) => c.includes('当前无可用摘要'))) throw new Error('应给出「当前无可用摘要」的明确结论');
      if (!r.conclusions.some((c) => c.includes('>=20'))) throw new Error('应说清楚要两群各 >=20 条');
    });
    check('无 state 文件时不注入', () => {
      if (r.injections[0].items.length !== 0) throw new Error('不该注入');
    });

    // 情形二：有 state 但 digests 为空（跑过桥接、还没攒够 20 条）。
    console.log('\n[情形二] 有 state、digests 为空、某群已有 7 条消息');
    fs.writeFileSync(statePath, JSON.stringify({
      conversations: { 'group:111': { recentMessages: Array.from({ length: 7 }, (_, i) => ({ plain: `m${i}` })) } }
    }), 'utf8');
    r = analyze({ stateDir, configPath: cfgPath, now, currents: ['group:111'] });
    check('digests 为空时结论仍可读', () => {
      if (r.rows.length !== 0) throw new Error('不该有摘要');
      if (!r.conclusions.some((c) => c.includes('当前无可用摘要'))) throw new Error('应给出无摘要结论');
    });
    check('进度里能看到该群 7 条消息、无摘要', () => {
      const p = r.progress.find((x) => x.key === 'group:111');
      if (!p) throw new Error('进度里应出现 group:111');
      if (p.recentMessages !== 7 || p.hasDigest) throw new Error(`实得 ${JSON.stringify(p)}`);
    });
    check('磁盘没有 digests 字段时点明「旧版不落盘摘要、重启即丢」', () => {
      if (r.persisted) throw new Error('fixture 里没有 digests，persisted 应为 false');
      if (!r.conclusions.some((c) => c.includes('旧版不落盘摘要'))) throw new Error('应说明旧版摘要不落盘');
    });

    // 情形三：有真实摘要 —— 白名单内 24h 内会注入；过期、非白名单、当前会话自己都不注入。
    console.log('\n[情形三] 有摘要：白名单内 / 过期 / 非白名单 / 当前会话自身');
    const digests = {
      'group:111': { key: 'group:111', at: now - 60_000, summary: '甲：今晚开黑吗；乙：来', people: ['甲', '乙'] },
      'group:222': { key: 'group:222', at: now - 3600_000, summary: '丙：新显卡到了；多少钱', people: ['丙'] },
      'group:333': { key: 'group:333', at: now - 7200_000, summary: '丁：这个群不在白名单', people: ['丁'] },
      'group:444': { key: 'group:444', at: now - 25 * 3600_000, summary: '戊：一天前的旧摘要', people: ['戊'] },
      'private:90001': { key: 'private:90001', at: now - 120_000, summary: '己：私聊里说的事', people: ['己'] }
    };
    fs.writeFileSync(statePath, JSON.stringify({ conversations: { 'group:111': { recentMessages: [] } }, digests }), 'utf8');
    const before = sha(statePath);
    r = analyze({ stateDir, configPath: cfgPath, now, currents: ['group:111'] });
    check('只注入白名单内 24h 内的其它会话（group:222 / private:90001）', () => {
      const keys = r.injections[0].items.map((i) => i.key).sort();
      if (JSON.stringify(keys) !== JSON.stringify(['group:222', 'private:90001'])) throw new Error(`实得 ${JSON.stringify(keys)}`);
    });
    check('排除当前会话自己、非白名单群、过期摘要', () => {
      const keys = r.injections[0].items.map((i) => i.key);
      for (const bad of ['group:111', 'group:333', 'group:444']) {
        if (keys.includes(bad)) throw new Error(`不该出现 ${bad}`);
      }
    });
    check('过期与非白名单在明细里被标出来', () => {
      const old = r.rows.find((x) => x.key === 'group:444');
      const out = r.rows.find((x) => x.key === 'group:333');
      if (!old || old.fresh) throw new Error('group:444 应标记为已过期');
      if (!out || out.inAllow) throw new Error('group:333 应标记为非白名单');
    });
    check('磁盘带 digests 字段时 persisted 为 true（不误报「不落盘」）', () => {
      if (!r.persisted) throw new Error('应识别到 digests 字段');
      if (r.conclusions.some((c) => c.includes('旧版不落盘摘要'))) throw new Error('不该报不落盘');
    });
    check('注入块带隐私边界且不超 600 字', () => {
      const block = r.injections[0].block;
      if (!block.includes('不要主动把其它群')) throw new Error('应带隐私边界说明');
      if (block.length > DIGEST_DEFAULTS.maxBlockChars + 4) throw new Error(`块过长 ${block.length}`);
    });
    check('跑完 state 文件一个字节没变（只读）', () => {
      if (sha(statePath) !== before) throw new Error('state 文件被改写了');
      const extra = fs.readdirSync(stateDir).filter((f) => f !== 'social-v2.json');
      if (extra.length) throw new Error(`state 目录多了文件：${extra.join(',')}`);
    });

    // 情形四：开关关闭。
    console.log('\n[情形四] crossSession.enabled = false');
    fs.writeFileSync(cfgPath, JSON.stringify({ allow: { groups: [111, 222] }, socialV2: { memory: { crossSession: { enabled: false } } } }), 'utf8');
    r = analyze({ stateDir, configPath: cfgPath, now, currents: ['group:111'] });
    check('关掉开关后不注入，并说明原因', () => {
      if (r.injections[0].items.length !== 0) throw new Error('关了开关还注入');
      if (!r.conclusions.some((c) => c.includes('enabled === false'))) throw new Error('应说明开关关着');
    });

    // 情形五：config.json 不存在（裸工作树）。
    console.log('\n[情形五] 没有 config.json');
    fs.rmSync(cfgPath);
    r = analyze({ stateDir, configPath: cfgPath, now, currents: ['group:111'] });
    check('没有 config.json 时跑通并说明白名单为空、不会注入', () => {
      if (r.cfg.found) throw new Error('不该读到 config');
      if (!r.conclusions.some((c) => c.includes('白名单按空处理'))) throw new Error('应说明白名单为空');
      if (r.injections[0].items.length !== 0) throw new Error('白名单为空时不该注入');
    });

    // 情形六：state 文件是坏的（半截 JSON）。
    console.log('\n[情形六] state/social-v2.json 是坏 JSON');
    fs.writeFileSync(statePath, '{"digests": {', 'utf8');
    r = analyze({ stateDir, configPath: cfgPath, now, currents: ['group:111'] });
    check('坏 JSON 不炸，只报读不到', () => {
      if (r.stateRead.ok) throw new Error('不该读成功');
      if (r.rows.length !== 0) throw new Error('坏文件不该产出摘要');
    });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  console.log('');
  if (failed) { console.error(`❌ 自测失败 ${failed} 项`); process.exit(1); }
  console.log('🎉 跨会话探针自测通过（六种情形：无 state / digests 空 / 有摘要 / 关开关 / 无 config / 坏 JSON）');
}

// ── 入口 ────────────────────────────────────────────────────────────────────
let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`参数错误：${error.message}`);
  console.error('用法见文件头注释，或 node scripts/probe-cross-session.mjs --help');
  process.exit(2);
}
if (args.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 25).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(0);
}
if (args.selftest) runSelftest();
else {
  const report = analyze({ stateDir: args.state, configPath: args.config, now: args.now, currents: args.currents });
  if (args.json) {
    console.log(JSON.stringify({
      now: report.now, stateFile: report.stateFile, stateReadOk: report.stateRead.ok,
      configFound: report.cfg.found, opts: report.cfg.opts, allowKeys: report.cfg.allowKeys,
      digests: report.rows, digestsPersistedOnDisk: report.persisted, progress: report.progress,
      injections: report.injections.map((i) => ({ current: i.current, keys: i.items.map((x) => x.key) })),
      conclusions: report.conclusions
    }, null, 2));
  } else {
    printReport(report);
  }
}
