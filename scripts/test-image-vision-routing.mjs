#!/usr/bin/env node
// 含图轮「选到什么模型 / 图有没有塞进 parts」的回归测试。
//
// 背景（2026-10-26 真机）：群友发图，机器人回「图我看不见，只能听你描述」。
// 证据链：tool-calls.jsonl 里 qq_get_message_images 成功了（ok:true），但 DSH 返回的是
//   [image unavailable: image/jpeg; model "deepseek-v4.1-flash" does not declare image input]
// 也就是说**图回来了，但这轮用的是不支持图片输入的模型**。
//
// 本测试锁三件事：
//   ① 选型：含图轮必须走 media（视觉模型），不能被 idle/peak 抢走；
//   ② 状态：reserved2 的图在工具结果里、不在 parts 里，所以「本轮有图」必须有独立标记
//      （src/media-turn.js），且 ensureChatModel 在已应用模型看不了图时要作废缓存重选；
//   ③ 构造：resolveMediaList 对普通图片**不能抛异常**（历史 bug：imagePartsAllowed 是块级
//      const，只在 face 分支里声明，普通图片分支读到 → ReferenceError），
//      且看不清图时必须塞一句「看不了图」，不能让模型对着 [图片1] 标签瞎编。
//
// 用法：node scripts/test-image-vision-routing.mjs
import fs from 'node:fs';
import { readBridgeSource } from './bridge-source.mjs';
import vm from 'node:vm';
import { MEDIA_TURN_TTL_MS, clearMediaTurn, isFreshMediaAt, isFreshMediaTurn, noteMediaTurn } from '../src/media-turn.js';
import { normalizeRouting, resolveModelChoice } from '../src/model-routing.js';
import { resolveTurnModel } from '../src/model-fallback.js';

const BRIDGE = new URL('../src/bridge.js', import.meta.url);
const MEDIA_TURN = new URL('../src/media-turn.js', import.meta.url);
const src = readBridgeSource();
const mediaTurnSrc = fs.readFileSync(MEDIA_TURN, 'utf8');

let pass = 0; let fail = 0;
const rows = [];
function check(name, ok, detail = '') {
  rows.push({ name, ok, detail });
  if (ok) { pass += 1; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── ① 选型：含图轮 media 优先 ────────────────────────────────────────────────
console.log('[1] 含图轮的模型优先级（纯函数 resolveModelChoice）');
{
  const routing = normalizeRouting({
    idle: 'workbuddy2api/deepseek-v4.1-flash',
    peak: 'xiaomi-mimo/mimo-v2.6-pro',
    fallback: ['deepseek-account/deepseek-flash'],
    disabled: []
  });
  const vision = { provider: 'deepseek-account', model: 'deepseek-flash' };
  const idleTurn = resolveModelChoice({ routing, media: null, isPeak: false });
  check('空闲轮 → idle 模型', idleTurn?.source === 'idle' && idleTurn.model === 'deepseek-v4.1-flash', `${idleTurn?.source} ${idleTurn?.provider}/${idleTurn?.model}`);
  const peakTurn = resolveModelChoice({ routing, media: null, isPeak: true });
  check('高峰轮 → peak 模型', peakTurn?.source === 'peak', `${peakTurn?.source} ${peakTurn?.model}`);
  const mediaTurn = resolveModelChoice({ routing, media: vision, isPeak: true });
  check('含图轮压过高峰 → media 视觉模型', mediaTurn?.source === 'media' && mediaTurn.model === 'deepseek-flash', `${mediaTurn?.source} ${mediaTurn?.provider}/${mediaTurn?.model}`);
  const mediaIdle = resolveModelChoice({ routing, media: vision, isPeak: false });
  check('含图轮压过空闲 → media 视觉模型', mediaIdle?.source === 'media', `${mediaIdle?.source}`);
  const capped = resolveModelChoice({ routing, media: vision, isPeak: false, available: [{ provider: 'workbuddy2api', model: 'deepseek-v4.1-flash' }] });
  check('可用清单里没有视觉模型时不会硬塞（回落到清单内模型）', capped?.source === 'idle', `${capped?.source} ${capped?.model}`);
}

// ── ② 媒体在场标记 ──────────────────────────────────────────────────────────
console.log('\n[2] 「本轮有图」标记（src/media-turn.js）');
{
  const m = new Map();
  check('没记过 → false', isFreshMediaTurn(m, 'group:1', 1000) === false);
  noteMediaTurn(m, 'group:1', 1000);
  check('刚记过 → true', isFreshMediaTurn(m, 'group:1', 2000) === true);
  check('别的会话不受影响', isFreshMediaTurn(m, 'group:2', 2000) === false);
  check('超过 TTL → false 且条目被清掉', isFreshMediaTurn(m, 'group:1', 1000 + MEDIA_TURN_TTL_MS + 1) === false && m.has('group:1') === false);
  noteMediaTurn(m, 'group:1', 5000);
  noteMediaTurn(m, 'group:1', 9000);
  check('重复记只刷新时间戳（不重复计数）', m.size === 1 && m.get('group:1') === 9000);
  const big = new Map();
  for (let i = 0; i < 5; i += 1) noteMediaTurn(big, `group:${i}`, 1000 + i, { maxKeys: 3 });
  check('键上限生效（丢最旧的）', big.size === 3 && !big.has('group:0') && big.has('group:4'), `size=${big.size}`);
  check('空 key / 空 map 不抛', noteMediaTurn(new Map(), '', 1) === false && isFreshMediaTurn(null, 'x', 1) === false);
}

// ── ③ 真跑 resolveMediaList（从 src/bridge.js 抽出真实函数体，不复制逻辑）────────
console.log('\n[3] resolveMediaList 真跑（vm 里执行 src/bridge.js 的原函数）');
const fnStart = src.indexOf('async function resolveMediaList(');
const fnEnd = src.indexOf('async function fetchMediaData(', fnStart);
check('能从 bridge.js 抽出 resolveMediaList', fnStart > 0 && fnEnd > fnStart, `字节 ${fnStart}..${fnEnd}`);
const resolveFnSrc = fnStart > 0 && fnEnd > fnStart ? src.slice(fnStart, fnEnd) : '';

function makeCtx({ seesImages, mode = 'ok', applied = null, sessionFor = 's1' }) {
  const appliedModelBySession = new Map();
  if (applied && sessionFor) appliedModelBySession.set(sessionFor, applied);
  const ctx = {
    MAX_MEDIA_COUNT: 6,
    MAX_MEDIA_BYTES: 10 * 1024 * 1024,
    log: () => {},
    videoMediaFactText: () => '[视频 3 秒]',
    fetchFaceMedia: async () => ({ buffer: Buffer.from('face'), mimeType: 'image/png', text: '[表情]' }),
    archiveMediaAttachment: () => {},
    toModelMedia: async () => (mode === 'fail'
      ? { ok: false, error: '超过上限' }
      : { ok: true, buffer: Buffer.from('jpeg'), mimeType: 'image/jpeg' }),
    fetchOneBotImage: async () => ({ buffer: Buffer.from('orig'), mimeType: 'image/jpeg' }),
    modelSeesImages: typeof seesImages === 'function' ? seesImages : () => seesImages,
    resolveTurnModel,
    appliedModelBySession,
    state: { sessions: sessionFor ? { 'group:1': sessionFor } : {} },
    activeModelOverride: null,
    cfg: { dsh: { visionModels: ['deepseek-flash'], provider: 'workbuddy2api', model: 'deepseek-v4.1-flash' } },
    warnedNoVision: '',
    imageMemoryEnsureSeen: async () => null
  };
  vm.createContext(ctx);
  vm.runInContext(`${resolveFnSrc}\nglobalThis.__f = resolveMediaList;`, ctx);
  return ctx;
}

if (resolveFnSrc) {
  // 会话已切到视觉模型（state.sessions → appliedModelBySession 这条链）时必须认出来
  try {
    const ctx = makeCtx({
      seesImages: (provider, model) => model === 'deepseek-flash',
      applied: { provider: 'deepseek-account', model: 'deepseek-flash', at: 1 }
    });
    const parts = await ctx.__f([{ kind: 'image', file: 'a.jpg' }], 'group:1');
    check('按 key→session 认到「已应用视觉模型」，图照常内联（不再读不存在的 sessionId）',
      parts.filter((p) => p.type === 'image').length === 1);
  } catch (e) {
    check('按 key→session 认到「已应用视觉模型」，图照常内联（不再读不存在的 sessionId）', false, `${e.constructor.name}: ${e.message}`);
  }
  // 反过来：已应用的是非视觉模型 → 不塞图，且明说看不了
  try {
    const ctx = makeCtx({
      seesImages: (provider, model) => model === 'deepseek-flash',
      applied: { provider: 'workbuddy2api', model: 'deepseek-v4.1-flash', at: 1 }
    });
    const parts = await ctx.__f([{ kind: 'image', file: 'a.jpg' }], 'group:1');
    check('已应用非视觉模型 → 不塞 image，且给出「看不了图」说明',
      parts.filter((p) => p.type === 'image').length === 0 && parts.some((p) => String(p.text || '').includes('当前模型看不了图')));
  } catch (e) {
    check('已应用非视觉模型 → 不塞 image，且给出「看不了图」说明', false, `${e.constructor.name}: ${e.message}`);
  }
  // 会话还没建立（key 没有映射）→ 回落到配置模型，不能抛
  try {
    const ctx = makeCtx({ seesImages: false, sessionFor: null });
    const parts = await ctx.__f([{ kind: 'image', file: 'a.jpg' }], 'group:9');
    check('会话映射缺失时不抛（回落到配置模型）', parts.length > 0);
  } catch (e) {
    check('会话映射缺失时不抛（回落到配置模型）', false, `${e.constructor.name}: ${e.message}`);
  }
  // 视觉模型 + 两张图
  try {
    const parts = await makeCtx({ seesImages: true }).__f([{ kind: 'image', file: 'a.jpg' }, { kind: 'image', file: 'b.jpg' }], 'group:1');
    const imgs = parts.filter((p) => p.type === 'image');
    check('视觉模型：两张图都变成 image part（不再 ReferenceError）', imgs.length === 2, `parts=${parts.map((p) => p.type).join(',')}`);
    check('图片标签仍在（模型知道有几张）', parts.some((p) => p.type === 'text' && p.text === '[图片1]'));
  } catch (e) {
    check('视觉模型：两张图都变成 image part（不再 ReferenceError）', false, `${e.constructor.name}: ${e.message}`);
  }
  // 无视觉模型 + 图
  try {
    const parts = await makeCtx({ seesImages: false }).__f([{ kind: 'image', file: 'a.jpg' }], 'group:1');
    const imgs = parts.filter((p) => p.type === 'image');
    const told = parts.some((p) => p.type === 'text' && p.text.includes('当前模型看不了图'));
    check('无视觉模型：不塞 image part', imgs.length === 0, `images=${imgs.length}`);
    check('无视觉模型：明确告诉模型「看不了图」', told, told ? '' : '缺少提示文本');
  } catch (e) {
    check('无视觉模型：不塞 image part', false, `${e.constructor.name}: ${e.message}`);
  }
  // K2（2026-11-01）：无视觉时不能只「说一句看不了」就完事，必须标记 + 排队补看
  try {
    const calls = { marked: [], followups: [], acts: [] };
    const ctx = makeCtx({ seesImages: false });
    ctx.markMediaTurn = (k) => calls.marked.push(k);
    ctx.appendActivity = (name, payload) => calls.acts.push([name, payload]);
    ctx.scheduleMediaFollowup = (k, r) => calls.followups.push([k, r]);
    const parts = await ctx.__f([{ kind: 'image', file: 'a.jpg' }], 'group:1');
    check('无视觉：把「本轮有图」记进 recentMediaTurns（下一轮才会换视觉模型）', calls.marked.includes('group:1'), JSON.stringify(calls.marked));
    check('无视觉：排一次补看唤醒', calls.followups.length === 1 && calls.followups[0][0] === 'group:1', JSON.stringify(calls.followups));
    check('无视觉：写一条 media-no-vision 活动记录', calls.acts.some(([n]) => n === 'media-no-vision'));
    check('无视觉：文案是「已排队补看」而不是让模型自称看不到图', parts.some((p) => String(p.text || '').includes('已排队')));
  } catch (e) {
    check('无视觉：标记 + 排队补看', false, `${e.constructor.name}: ${e.message}`);
  }
  // 表情（face）无视觉
  try {
    const parts = await makeCtx({ seesImages: false }).__f([{ kind: 'face', faceId: '42' }], 'group:1');
    check('表情 + 无视觉：也是文字说明，不塞 image', parts.filter((p) => p.type === 'image').length === 0 && parts.some((p) => String(p.text || '').includes('当前模型看不了图')));
  } catch (e) {
    check('表情 + 无视觉：也是文字说明，不塞 image', false, `${e.constructor.name}: ${e.message}`);
  }
  // 视频：不走图片抓取
  try {
    let fetched = 0;
    const ctx = makeCtx({ seesImages: true });
    ctx.fetchOneBotImage = async () => { fetched += 1; return null; };
    const parts = await ctx.__f([{ kind: 'video-file', file: 'v.mp4' }], 'group:1');
    check('视频不进图片通道（不抓取、不塞 image）', fetched === 0 && parts.length === 1 && parts[0].type === 'text', `parts=${parts.length}`);
  } catch (e) {
    check('视频不进图片通道（不抓取、不塞 image）', false, `${e.constructor.name}: ${e.message}`);
  }
  // 归一化失败
  try {
    const parts = await makeCtx({ seesImages: true, mode: 'fail' }).__f([{ kind: 'image', file: 'a.jpg' }], 'group:1');
    check('压不到可用体积：给出失败原因，不塞 image', parts.filter((p) => p.type === 'image').length === 0 && parts.some((p) => String(p.text || '').includes('超过上限')));
  } catch (e) {
    check('压不到可用体积：给出失败原因，不塞 image', false, `${e.constructor.name}: ${e.message}`);
  }
  // 超量
  try {
    const many = Array.from({ length: 8 }, (_, i) => ({ kind: 'image', file: `x${i}.jpg` }));
    const parts = await makeCtx({ seesImages: true }).__f(many, 'group:1');
    const skipped = parts.filter((p) => p.type === 'text' && String(p.text).includes('超过单条上限')).length;
    check('超过单条上限的图被跳过并说明', skipped === 2 && parts.filter((p) => p.type === 'image').length === 6, `skipped=${skipped}`);
  } catch (e) {
    check('超过单条上限的图被跳过并说明', false, `${e.constructor.name}: ${e.message}`);
  }
}

// ── ④ 回合中途取图（D19 回归）：含图判定必须认「状态里持久化的 lastMediaAt」─────────
// 真机时间线（W7 核过）：23:39 重启 → 23:42:10 选型 source=idle workbuddy2api/deepseek-v4.1-flash
// → 23:42:16 模型自己调 qq_get_message_images → 23:42:17 DSH 回
// [image unavailable: … deepseek-v4.1-flash does not declare image input]。图片 23:41 到过一次，
// 但标记只在旧进程内存里；重启后 map 空，选型退回空闲模型。
console.log('\n[4] 回合中途取图 / 重启后仍含图（keyHasRecentMedia 真跑）');
{
  const st = src.indexOf('function keyHasRecentMedia(');
  const en = src.indexOf('async function ensureChatModel(', st);
  check('能从 bridge.js 抽出 keyHasRecentMedia', st > 0 && en > st, `字节 ${st}..${en}`);
  const fnSrc = st > 0 && en > st ? src.slice(st, en) : '';
  const makeMediaCtx = ({ markers = {}, lastMediaAt = 0, messages = [] }) => {
    const ctx = {
      recentMediaTurns: new Map(Object.entries(markers)),
      isFreshMediaTurn,
      isFreshMediaAt,
      socialV2: { conversations: new Map([['group:1', { lastMediaAt, recentMessages: messages, unread: [] }]]) }
    };
    vm.createContext(ctx);
    vm.runInContext(`${fnSrc}\nglobalThis.__f = (key) => keyHasRecentMedia(null, key);`, ctx);
    return ctx;
  };
  if (fnSrc) {
    const now = Date.now();
    // 重启场景：内存 Map 空，只靠状态里的 lastMediaAt
    check('重启后（内存标记空）但 lastMediaAt 还新鲜 → 仍算含图',
      makeMediaCtx({ lastMediaAt: now - 30 * 1000 }).__f('group:1') === true);
    check('lastMediaAt 过期（>TTL）→ 不算含图',
      makeMediaCtx({ lastMediaAt: now - MEDIA_TURN_TTL_MS - 1000 }).__f('group:1') === false);
    check('内存标记命中 → 算含图（老路径仍在）',
      makeMediaCtx({ markers: { 'group:1': now } }).__f('group:1') === true);
    const farBack = Array.from({ length: 6 }, (_, i) => ({ hasMedia: i === 1, media: i === 1 ? [{ kind: 'image' }] : [] }));
    check('图在第 5 条（旧实现的最近 2 条窗口看不到）→ 仍算含图',
      makeMediaCtx({ messages: farBack }).__f('group:1') === true);
    check('完全没有图 → 不算含图',
      makeMediaCtx({ messages: [{ hasMedia: false }, { hasMedia: false }] }).__f('group:1') === false);
    check('会话不存在时不抛', makeMediaCtx({}).__f('group:404') === false);
  }
}

// ── ⑤ 接线（静态断言）──────────────────────────────────────────────────────
console.log('\n[4] 接线静态断言（防止以后重构又把这层拆掉）');
{
  const declCount = (src.match(/const imagePartsAllowed\s*=/g) || []).length;
  check('imagePartsAllowed 只声明一次（块级 const 重复声明会 ReferenceError）', declCount === 1, `count=${declCount}`);
  const declAt = src.indexOf('const imagePartsAllowed');
  const loopAt = src.indexOf('for (const media of Array.isArray(mediaList)');
  const faceAt = src.indexOf("if (media.kind === 'face')", loopAt);
  check('声明在 for 循环之前（两条分支都能读到）', declAt > 0 && loopAt > declAt, `decl=${declAt} loop=${loopAt}`);
  check('声明不在 face 分支里（历史 bug 的位置）', faceAt > 0 ? declAt < faceAt : false);

  const hasMediaFn = src.slice(src.indexOf('function keyHasRecentMedia('), src.indexOf('async function ensureChatModel('));
  check('keyHasRecentMedia 认「本轮有图」标记', hasMediaFn.includes('isFreshMediaTurn(recentMediaTurns'));
  const hintFn = src.slice(src.indexOf('function mediaHintFor('), src.indexOf('function findMessageMedia('));
  check('mediaHintFor 记「本轮有图」标记', hintFn.includes('markMediaTurn(key)'));
  const ensureFn = src.slice(src.indexOf('async function ensureChatModel('), src.indexOf('async function ensureSession(') > 0 ? src.indexOf('async function ensureSession(') : src.indexOf('async function ensureChatModel(') + 20000);
  check('ensureChatModel 在已应用模型看不了图时作废缓存', ensureFn.includes('modelSeesImages(applied.provider, applied.model)') && ensureFn.includes('modelAppliedSessions.delete(sessionId)'));
  // D33：真机时间线是「先按 idle 选模型 → 之后才取图」，所以作废必须在「本 epoch 已应用」早退之前；
  // 否则早退直接返回旧模型，图来了也不会重选（2026-10-27 00:33 group:100000006 的机制）。
  const reselectAt = ensureFn.indexOf('modelSeesImages(applied.provider, applied.model)');
  const earlyReturnAt = ensureFn.indexOf('=== modelSelectionEpoch) return');
  check('重选分支在「已应用」早退之前（先选模型、后取图也能重选）',
    reselectAt > 0 && earlyReturnAt > reselectAt, `reselect=${reselectAt} earlyReturn=${earlyReturnAt}`);
  check('media-turn.js 被 import 进 bridge', /import \{[^}]*isFreshMediaTurn[^}]*\} from '\.\/media-turn\.js'/.test(src));

  // D19：含图标记必须跨重启（持久化 lastMediaAt），且三个入口都要打标记
  check('keyHasRecentMedia 认状态里的 lastMediaAt', hasMediaFn.includes('isFreshMediaAt(st.lastMediaAt)'));
  check('saveSocialV2State 落盘 lastMediaAt', /lastMediaAt:\s*st\.lastMediaAt/.test(src));
  check('loadSocialV2State 读回 lastMediaAt', /lastMediaAt:\s*Number\(val\.lastMediaAt\)/.test(src));
  check('新消息带图时打标记（appendSocialV2Message）', /safeMedia\.some\(\(m\) => m && \(m\.kind === 'image'/.test(src));
  check('QQ 小黄脸（face）不触发视觉模型', !/m\.kind === 'face'\)\)\) markMediaTurn/.test(src));
  check('表情包默认不触发视觉模型（要 mediaVision.stickers=true 才切）', /m\.kind === 'sticker' && [^)]*mediaVision\?\.stickers === true/.test(src));
  check('取图成功时也打标记（/api/images/message）', /img\.data\)\) markMediaTurn\(key\)/.test(src));
  check('最近窗口放宽到 6 条（不再只看 2 条）', /recentMessages\.slice\(-6\)/.test(hasMediaFn) && /unread\.slice\(-6\)/.test(hasMediaFn));

  // 一轮制（2026-11-02 用户拍板）：图那一轮回完立刻清标记，不等 TTL 自然过期。
  {
    const m = new Map();
    noteMediaTurn(m, 'group:x', Date.now());
    check('clearMediaTurn 删掉标记', clearMediaTurn(m, 'group:x') === true && isFreshMediaTurn(m, 'group:x') === false);
    check('mux 在 turn/end 调 clearMediaTurnForSession', /event\?\.type === 'turn\/end'.*clearMediaTurnForSession/.test(readBridgeSource(new URL('../src/bridge/mux-runtime.js', import.meta.url))));
    check('bridge 实现 clearMediaTurnForSession 并清 lastMediaAt', /clearMediaTurnForSession\(sessionId\)/.test(src) && /lastMediaAt = 0/.test(src));
  }

  const turnSrc = mediaTurnSrc;
  check('media-turn.js 不碰磁盘（无 fs 调用）', !/\bfs\./.test(turnSrc) && !/require\(/.test(turnSrc));
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exitCode = fail === 0 ? 0 : 1;
