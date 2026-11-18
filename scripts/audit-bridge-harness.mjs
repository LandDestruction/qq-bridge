import { installBridgeModules, installBootModules } from './bridge-source.mjs';

/**
 * 删临时目录：Windows 上刚写完的文件常被索引器/杀软短暂占住，EPERM 是偶发噪声。
 * 断言早在 close() 之前跑完了——清理失败不该把整套崩成假红，只 warn 一行。
 */
function removeTempDirWithRetry(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.warn(`[warn] 临时目录清理失败（不影响断言）：${dir}：${error?.code || error?.message}`);
  }
}

// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as sendPacing from '../src/send-pacing.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as mediaNormalize from '../src/media-normalize.js';
import * as forward from '../src/forward.js';
import * as slang from '../src/slang-learner.js';
import * as sticker from '../src/sticker-lib.js';
import * as modelPrices from '../src/model-prices.js';
import * as modelScope from '../src/model-scope.js';
import * as modelRouting from '../src/model-routing.js';
import * as wakeSelfId from '../src/wake-selfid.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as dshUsageSync from '../src/dsh-usage-sync.js';
import * as voiceLib from '../src/send-voice-lib.js';
import * as presetPrompt from '../src/preset-prompt.js';
import * as stateAcl from '../src/state-acl.mjs';
import * as voiceDedupe from '../src/voice-dedupe.js';
import * as modelFallback from '../src/model-fallback.js';
import * as messageDb from '../src/message-db.js';
import * as mediaTurn from '../src/media-turn.js';
import * as affinity from '../src/affinity.js';
import * as personaRequest from '../src/persona-request.js';
import * as selfModel from '../src/self-model.js';
import * as people from '../src/people.js';
import * as localFallback from '../src/local-fallback.js';
import * as memoryLayers from '../src/memory-layers.js';
// D36：摘要刷新判定（shouldRefreshDigest / freshnessLabel）从 cross-session-memory.js 拆到了这个模块。
// VM 里 import 会被剥掉，不在这里注入，桥接调用点就会 ReferenceError（test-token-economy / test-context-continuity 曾因此全红）。
import * as crossSessionDigestV2 from '../src/cross-session-digest-v2.js';
import * as crossSessionMemory from '../src/cross-session-memory.js';
import * as mediaQueue from '../src/media-queue.js';
import * as videoTextNormalize from '../src/video-text-normalize.js';
// ①②③ 会话侧纯规则：桥接在 VM 里走 deps/globalThis 取（import 被剔），这里注入真实实现。
import * as privateHintNs from '../src/private-hint.js';
import * as pureModeNs from '../src/pure-mode.js';
import * as mentionCommandNs from '../src/mention-command.js';
// 身份锁（src/safety/identity-lock.js）：bridge.js 的 main() 在 VM 里会调它判登录号，import 被剥掉必须注入。
import * as identityLockNs from '../src/safety/identity-lock.js';
import * as identitySendNs from '../src/safety/identity-send.js';
// 配置写入的「需要重启的字段」表：bridge.js 的 getter 在 VM 里只剩全局名，不注入则 /api/config 500。
import { pinRestartOnlyFields, planConfigReload, RESTART_REQUIRED_PATHS } from '../src/config-reload.js';
import * as asyncWait from '../src/async-wait.js';
import * as videoAnalyze from '../src/video-analyze.js';
import { videoMediaFactText } from '../src/video-followup.js';
// 群文件转存 / 观察学习：bridge.js 会 import 这两个模块，VM 里 import 被剥掉，
// 必须把纯函数注入 context，否则 loadConfig / onGroupMessage 一调用就 ReferenceError。
import * as fileArchive from '../src/file-archive.js';
import * as observeLearn from '../src/observe-learn.js';
// D45/D47/D51：上下文预算与「距上次重建」记帐也在 bridge 顶层执行，必须一起注入；
// 漏注入时 /api/status 取 budget 快照会 ReferenceError → 500（本套件会当场红），
// 而 save/load 里的 sessionResets 会被 try/catch 吞掉、静默不生效（更难发现）。
import * as contextBudget from '../src/context-budget.js';
import * as sessionResets from '../src/session-resets.js';
// D67：私聊临时会话冷却的 store 工厂在 bridge.js 顶层创建，VM 里 import 被剥掉，必须注入。
import * as privateTempSession from '../src/private-temp-session.js';
// D70：AI 黑名单的判定/写盘器在 bridge.js 里创建；config-write 的 updateConfigFile 也要给 VM。
import * as aiBlacklist from '../src/ai-blacklist.js';
// D70 P3：发送前硬闸的纯判定（bridge.js 用 import 注入 runtimeBindings.aiBlacklistGatePure；
// VM 里 import 被剥掉，必须把真实实现放进 context，否则 conversation-send 拿到的是 undefined）。
import * as aiBlacklistGateNs from '../src/ai-blacklist-gate.js';
import * as configWrite from '../src/config-write.js';
// 模块写配置走的是同一个 updateConfigFile（manifest 里 library-usage 声明了这条依赖）。
const { updateConfigFile } = configWrite;
// 花费预警的纯规则（阈值/外推/文案）：bridge.js 会 import 它并用进 runtimeBindings，
// VM 里 import 被剥掉，必须把真实实现注入 context，否则 main() 里装配那行就 ReferenceError。
import * as budgetAlert from '../src/budget-alert.js';
// 素材库控制台的两个 ESM 模块：bridge.js 用 import 拿它们的工厂函数，
// 而 VM 里 import 行会被剥掉 → 必须在 context 里注入同名工厂，否则 wireRuntimeModules 一取就 ReferenceError。
import { createLibraryView } from '../src/bridge/console/library-view.js';
// 素材库视图/找号在 VM 里会经 deps 取这几个名字（bridge.js 的 import 在 VM 里被剥掉、
// 只剩 runtimeBindings getter），不注入就要到 /api/library/assets、/api/library/bind
// 这类路径上才炸成 ReferenceError —— 而 test-token-economy 只打 socialV2，所以一直没暴露。
import { buildLibrarySnapshot, buildLibrarySnapshotWithCache, scanLibraryTree, assetsFromFiles } from '../src/library-scan.js';
// 素材库增量扫描缓存（P2）：bridge.js 的快照 getter 会在 VM 里拼 cacheFile，文件名常量也要给全局。
import { SCAN_CACHE_FILE } from '../src/library-scan-cache.js';
// 「以图搜源」的指纹算力：bridge.js 顶层 import 了 dhashFromBufferAsync 并挂成 deps getter，
// VM 里 import 被剥掉，不在 context 里给就会在真点「以图搜源」时炸成 ReferenceError。
import { dhashFromBufferAsync } from '../src/image-hash.js';
import { fetchBoothMeta } from '../src/booth-meta.js';
import { getBoothCover, getBoothCoverPath } from '../src/booth-cover.js';
import * as libraryNotesNs from '../src/library-notes.js';
import * as boothSearchNs from '../src/booth-search.js';
import * as roleDraftNs from '../src/role-draft.js';
import * as libraryBindsNs from '../src/library-binds.js';
import * as libraryFindNs from '../src/library-find.js';
import * as libraryBatchNs from '../src/library-batch.js';
// import-to-unity 的 deps：usageRoot 匹配纯规则（VM 里 import 被剥，只能注入同名的真实实现）。
import * as libraryUsageRootsNs from '../src/library-usage-roots.js';
// 工程使用统计：纯函数层（roots 规整 / GUID 求交 / 汇总）与素材侧 GUID 抽取（解 .unitypackage）。
import * as libraryUsageNs from '../src/library-usage.js';
import * as libraryUsageGuidsNs from '../src/library-usage-guids.js';
// 工具维度 token 归因的均摊纯函数（src/token-tools.js，rules-backend 维护）。
import * as tokenToolsNs from '../src/token-tools.js';
import * as tokenProvidersPure from '../src/token-providers.js';
// 表情缩略图缓存的清理/重试计划（纯函数）：observe-runtime 与缓存接口在 VM 里靠 deps/全局取。
import * as stickerCacheNs from '../src/sticker-cache.js';
import { matchConfiguredUsageRoot } from '../src/library-usage-roots.js';
// 批量操作模块（src/bridge/console/library-batch.js）经 deps 取 libraryMergePure / libtrTrashKeys：
// bridge.js 的 import 在 VM 里被剥掉，这两个真实实现必须在 context 里给同名全局。
import * as libraryMergeNs from '../src/library-merge.js';
import * as libraryPackageCoverNs from '../src/library-package-cover.js';
import { libtrTrashKeys } from '../src/bridge/console/library-trash.js';
import * as libraryRenameNs from '../src/library-rename.js';
import * as libraryAliasNs from '../src/library-alias.js';
import * as libraryCollectionsNs from '../src/library-collections.js';
import * as boothDownloadNs from '../src/booth-download.js';
// BOOTH 全局限速暂停：补封面（library-covers）与已购同步（purchases-sync）在 VM 里只能靠
// deps.boothPausePure 读/写同一份 state/booth-search-pause.json，这里给真实实现。
import * as boothPauseNs from '../src/booth-pause.js';
import * as consoleGuestNs from '../src/console-guest.js';
import * as boothProductNs from '../src/booth-product.js';
// 下载后解压：bridge.js 装配时把这三个 zip 能力塞进 runtimeBindings.zipExtractPure，
// VM 里 import 被剥掉，必须在这里注入同名全局，否则 wireRuntimeModules 一取就 ReferenceError。
import { extractZipToDir, listZipPreview, readZipDirectoryFromFile } from '../src/zip-extract.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, files = {}, globals = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false },
    snowluma: { httpUrl: 'http://127.0.0.1:3000', accessToken: 'fixture-only' },
    identity: { expectedSelfIds: ['100000007'], onMismatch: 'lock' }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  // 额外状态文件（用于测试"启动时读到损坏/旧版文件"这类路径）。
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(temp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], faces: [], http: [], lists: [] };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body });
    const action = String(url).split('/').pop();
    // Every outbound test must independently verify the identity reported by the same HTTP transport.
    if (action === 'get_login_info') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 100000007 } }) };
    }
    // fetch_custom_face_detail：同步收藏表情的 HTTP 兜底路径要拿到**数组**（WS 失败时用）。
    if (action === 'fetch_custom_face_detail') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: [{ emoji_id: 'http-fixture-sticker', resId: 'http-fixture-sticker', url: 'https://public.invalid/http-sticker', md5: 'AABBCCDDEEFF00112233445566778899', desc: 'HTTP 兜底表情' }]
        })
      };
    }
    if (action === 'fetch_ptt_text') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    // settings.describe 的默认桩：没有 qq-mode 命名空间 ⇒ refreshMode() 回退到本地 mode.json。
    // 测试可覆盖它来验证「DSH 设置里的空 ownerQQ 不得覆盖 config.json」等契约。
    settings: {
      describe: async () => success({ namespaces: [] }),
      update: async () => success({ updated: true })
    },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      // 默认空清单：ensureSession 的 workspace 存活守卫会查它（见 bridge.js sessionWorkspaceGone）。
      // 需要造「会话 cwd 失效」的用例直接覆盖本函数，别改桥接里的判断逻辑。
      list: async (params = {}) => { calls.lists.push(params); return success({ items: [] }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async fetchFaceEntity(id) { calls.faces.push(id); return null; }
    async request(action, params = {}) {
      // 群成员列表：v2 读工具 qq_get_group_members 会用到（含 WS 不可用时的 HTTP 兜底路径）。
      if (action === 'get_group_member_list') {
        return {
          status: 'ok', retcode: 0,
          data: [
            { user_id: 111, nickname: '小明', card: '小明', role: 'member' },
            { user_id: 222, nickname: '路人', card: '' },
            { user_id: 123, nickname: '管理员', card: '群主', role: 'owner' }
          ]
        };
      }
      return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] };
    }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  await startQqGateway(', `
  // D62：main() 的共享状态改由 src/bridge/boot/ 各阶段导出（getter/setter 实时），
  // 沙箱在这里统一取一次只读快照；需要写回的值一律写 boot（见下面几个 setter）。
  const {
    cfg, tokenLedger, appliedModelBySession, socialV2, collectors, promptQueues,
    initialPrompts, pendingVideoEnrich, videoFollowUps, sttService,
    MAX_MEDIA_BYTES, v2TurnStartAt, turnLeaseNoted, TURN_BUSY_LEASE_MS, flushQueue, loadSocialV2State,
  } = boot;
  live.applyIdentityCheck({ user_id: '100000007' });
  // This VM intentionally stops before gateway wiring; make that test boundary explicit rather
  // than letting production's live transport lookup observe an absent bot instance.
  const fixedBotFixture = () => identityLockNs.assertIdentitySendAllowed({
    enabled: true, ready: true, ok: true, lock: false,
    selfId: '100000007', expected: ['100000007'],
  });
  live.assertFreshIdentitySendAllowed = async () => fixedBotFixture();
  live.assertFreshHttpIdentitySendAllowed = async () => fixedBotFixture();
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    // self-model（D37）：测试要能直接驱动「本轮选型」并读回真实来源，不必绕唤醒限频。
    ensureChatModel,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, state, api: boot.api,
    // D62 之后 state/social-v2.json 的加载发生在 boot 阶段（wake-social → loadSocialV2State），
    // 而这个沙箱在网关阶段之前就 return 了，所以必须把函数带出来由 harness 手动触发一次，
    // 否则 /api/memory/overview、/api/socialV2/states 这类读状态文件的断言全是空的。
    loadSocialV2State,
    getSocialV2State, appendSocialV2Message, recordSentMessagesV2,
    // 配置热加载入口：测试要能像 POST /api/config 那样走「读盘 → loadConfig → 归一 → 替换 cfg」，
    // 沙箱里 config-admin 的 deps 拿不到 wired 版本（装配顺序在网关阶段之后），所以从 boot 上取。
    reloadConfigFromDisk: boot.reloadConfigFromDisk,
    // 工程使用统计要能像 POST /api/config 那样把扫描根写进 config.json：给 VM 同名全局。
    updateConfigFile,
    buildWakePromptV2, buildWakeSnapshotV2, sendWakePromptV2,
    syncStickerLibrary, listStickersForV2, getStickerImageData,
    refreshMode, modeAllowed, trackTurnEvent, replayPendingWakeReasonsV2,
    setupSleepTimerV2,
    getInitialPrompt, setInitialPrompt, loadInitialPrompts, formatInitialPromptV2,
    extractMediaFromSegments, segmentsToText, fetchOneBotImage, fetchMediaData, resolveMediaList,
    enrichVideoFile,
    emojiCdnCandidates, getImageDimensions, acceptImageBuffer,
    // 网关阶段在沙箱里不会执行（上面提前 return），这里按旧行为懒建一个 FakeBot 当作 bot。
    bot: (live.bot = new SnowLumaWebSocketClient()),
    isConversationBusyV2,
    settingFromDshNamespace, selfIdentityTextV2, buildWakeReminderPromptV2,
    getMode() { return boot.currentMode; },
    setSelfIdentity(display, id) {
      boot.selfDisplayName = String(display ?? '');
      boot.selfUserId = String(id ?? '');
      boot.selfNickname = boot.selfDisplayName.toLowerCase() || 'deepseek';
    },
    retireSession,
    voiceCfg, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator,
    voiceBudgetCheck, sendVoiceV2, sendVoiceForV2, assertOutboundAuditOk,
    setMode(value) { boot.currentMode = value; },
    setReady(value) { boot.dshReady = value; },
    setPresets(value) { boot.dshPresetIds = value; boot.dshDefaultPreset = 'standard'; },
    resetEpoch() { boot.sessionEpoch++; },
    // 上面解构出来的只读快照（保持与旧 harness 返回面一致）
    cfg, tokenLedger, appliedModelBySession, socialV2, collectors, promptQueues,
    initialPrompts, pendingVideoEnrich, videoFollowUps, sttService,
    MAX_MEDIA_BYTES, v2TurnStartAt, turnLeaseNoted, TURN_BUSY_LEASE_MS, flushQueue,
  };
  await startQqGateway(`);
  const timers = new Set();
  const context = vm.createContext({
    fs, os, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, TextDecoder, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // OCR 的 runPowerShell 走 execFile；VM 里不真跑 PowerShell，回调直接给错误（路由会翻成人话）。
    execFile: (cmd, args, opts, cb) => { const done = typeof opts === 'function' ? opts : cb; if (done) done(new Error('fixture: execFile 不可用')); },
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, once: () => {}, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    // D62：装配阶段 2 的 prologue 会从 deps 取这个 import；VM 里 import 被剥掉后必须给桩，
    // 否则取 deps 的那一刻就 ReferenceError（原先它只在 try/catch 里被调用，所以没暴露）。
    discoverDshBaseUrl: async () => ({ changed: false, found: false }),
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker,
    ...modelPrices, ...modelScope, ...modelRouting, ...wakeSelfId, ...tokenLedger, ...dshUsageSync, ...voiceLib, ...stateAcl, ...presetPrompt,
    // VM 里 import 被剥掉，这些纯函数必须由 context 注入，否则调用时 ReferenceError
    // （voice 去重判定在 sendVoiceForV2 里，audit-bridge 的语音守卫断言会直接踩到）。
    ...voiceDedupe, ...modelFallback, ...localFallback, ...memoryLayers, ...mediaQueue, ...asyncWait, ...videoAnalyze, ...videoTextNormalize,
    // states 视图要读「最后一句」：预览走 message-db 的 latestMessageOfKey（只注入这一个，
    // 不展开整个模块——连 openMessageDb 一起注入会让沙箱真的打开临时 SQLite，Windows 上删临时目录会 EPERM）。
    latestMessageOfKey: messageDb.latestMessageOfKey,
    ...mediaTurn, ...affinity, ...personaRequest, ...selfModel, ...people,
    ...crossSessionDigestV2, ...crossSessionMemory,
    ...privateHintNs, ...pureModeNs, ...mentionCommandNs, ...identityLockNs, ...identitySendNs,
    identityLockNs,
    // The VM stops before QQ gateway startup; use an explicit fixed-bot fixture for guarded sends.
    assertIdentitySendAllowed: () => identityLockNs.assertIdentitySendAllowed({ enabled: true, ready: true, ok: true, lock: false, selfId: '100000007', expected: ['100000007'] }),
    assertFreshIdentitySendAllowed: async () => identityLockNs.assertIdentitySendAllowed({ enabled: true, ready: true, ok: true, lock: false, selfId: '100000007', expected: ['100000007'] }),
    assertFreshHttpIdentitySendAllowed: async () => identityLockNs.assertIdentitySendAllowed({ enabled: true, ready: true, ok: true, lock: false, selfId: '100000007', expected: ['100000007'] }),
    RESTART_REQUIRED_PATHS, planConfigReload, pinRestartOnlyFields,
    ...fileArchive, ...observeLearn,
    ...contextBudget, ...sessionResets, ...privateTempSession, ...aiBlacklist, ...configWrite, ...budgetAlert,
    createLibraryView,
    // 素材库路径的真实实现：deps.buildLibrarySnapshot / fetchBoothMeta / getBoothCover /
    // getBoothCoverPath / libraryNotes 在 VM 里都只剩 getter，对应全局名必须由这里给。
    buildLibrarySnapshot, buildLibrarySnapshotWithCache, SCAN_CACHE_FILE, scanLibraryTree, assetsFromFiles, fetchBoothMeta, getBoothCover, getBoothCoverPath, libraryNotes: libraryNotesNs, dhashFromBufferAsync,
    // 素材卡封面指纹：bridge.js 在模块作用域建实例并挂后台循环，VM 里既不需要真算也不要定时器，
    // 桩成「查不到 / 不跑」，只保证 deps.buildLibrarySnapshot 的包装函数能取到名字不 ReferenceError。
    createLibraryDhash: () => ({ lookup: () => '', fillCards: async () => ({ cards: [], targets: 0, cached: 0, computed: 0, failed: 0, withDhash: 0 }), startLoop: () => ({ runOnce: async () => null, stop: () => {} }) }),
    aiBlacklistGatePure: aiBlacklistGateNs, boothSearchPure: boothSearchNs, boothProductPure: boothProductNs, libraryBindsPure: libraryBindsNs, libraryFindPure: libraryFindNs, libraryBatchPure: libraryBatchNs, libraryRenamePure: libraryRenameNs, libraryAliasPure: libraryAliasNs, libraryCollectionsPure: libraryCollectionsNs, boothDownloadPure: boothDownloadNs, consoleGuestPure: consoleGuestNs,
    // 全局 BOOTH 暂停（429/403）——补封面与已购同步两个 VM 模块的 deps。
    boothPausePure: boothPauseNs,
    // 批量操作模块的 deps：合并组纯规则 + 回收站搬移入口（与 src/bridge.js 里塞进 runtimeBindings 的一致）。
    libraryMergePure: libraryMergeNs, libraryPackageCoverPure: libraryPackageCoverNs, libtrTrashKeys,
    // 导入 Unity 工程：工程根匹配规则（rules-backend 的纯函数）。
    libraryUsageRootsNs, libraryUsageRootsPure: libraryUsageRootsNs, matchConfiguredUsageRoot,
    // 工程使用统计（library-usage.js 是 VM 模块）：bridge.js 里 import 被剥掉，这两个名字也要给全局；
    // 另外给纯函数层/GUID 抽取的 deps 键（library-usage.js 的 manifest 依赖）。
    libraryUsageNs, libraryUsageGuidsNs,
    // 工程使用统计（library-usage.js 是 VM 模块）：纯函数层与素材侧 GUID 抽取都得注入同名全局。
    libraryUsagePure: libraryUsageNs, libraryUsageGuidsPure: libraryUsageGuidsNs,
    // 工具维度 token 归因：均摊规则在 src/token-tools.js（纯函数），VM 里 bridge.js 的 import 被剥掉，
    // 只能由这里给同名全局（tokenToolsPure 名字与 bridge.js 里注入 deps 的键一致）。
    tokenToolsPure: tokenToolsNs,
    tokenProvidersPure,
    stickerCachePure: stickerCacheNs,
    // 解压能力（手动解压 / 下载完自动解压共用）：纯规则在 zip-extract，VM 里只能靠全局注入。
    extractZipToDir, listZipPreview, readZipDirectoryFromFile,
    buildRoleDraftMessages: roleDraftNs.buildRoleDraftMessages, resolveRoleDraft: roleDraftNs.resolveRoleDraft, uniqueRoleName: roleDraftNs.uniqueRoleName,
    // 视频语音：VM 里没有子进程/网络，STT 服务与补发协作者桩成「不可用」，
    // 让桥接走既有回退路径；纯函数 videoMediaFactText 用真实实现（prompt 断言要用）。
    videoMediaFactText,
    createSttService: () => ({
      transcribe: async () => ({ ok: false, error: 'fixture: stt unavailable', source: 'none', ms: 0 }),
      status: () => ({ enabled: false, running: false, model: 'small', loadedAt: 0, lastMs: 0 }),
      refresh: async () => ({}), stop: async () => {}, ensureStarted: async () => false
    }),
    createSentStore: () => ({ has: () => false, add: () => {}, delete: () => {}, clear: () => {}, toArray: () => [], size: 0 }),
    createFollowUpHub: () => ({
      createJob: ({ key, sig } = {}) => ({ key, sig }),
      transcriptReady: async () => ({ sent: false, reason: 'fixture: follow-up disabled' }),
      claim: () => {},
      dispose: () => {},
      sentCount: () => 0
    }),
    // 桥接的出图出口会调归一化（体积/动图抽帧）：VM 里必须能拿到这几个函数。
    normalizeImageForModel: mediaNormalize.normalizeImageForModel,
    // 发送节奏：bridge.js 的 import 在 VM 里被剥掉，绑定的三个名字要从这里注入。
    makePacingState: sendPacing.createPacingState,
    readPacingOptions: sendPacing.pacingOptions,
    paceSendSlot: sendPacing.reserveSendSlot,
    sniffImage: mediaNormalize.sniffImage,
    planNormalization: mediaNormalize.planNormalization,
    planAnimation: mediaNormalize.planAnimation,
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData, describeAge }; })());`, context);
  installBridgeModules(context);
installBootModules(context);
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  // 补上被截断的 boot 阶段本该做的事：从 state/social-v2.json 恢复会话与记忆层。
  bridge.loadSocialV2State?.();
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    // Windows 上临时目录偶尔仍被占用：重试几次，失败只 warn（见函数注释）。
    removeTempDirWithRetry(temp);
  } };
}
