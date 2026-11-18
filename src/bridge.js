// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import { decideLock, staleLogMs } from './lock-guard.js';
import { runSelfCheck } from './self-check.js';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import yaml from 'js-yaml';
import { extractPresetPrefix, presetPromptBlockers, presetPromptWarnings, renderPresetPromptYaml } from './preset-prompt.js';
import { GEN1_ROLE_LINE_RE, parseRoleSections, roleCharStats, roleSectionReport, selectRoleText } from './role-card.js';
import { fileURLToPath } from 'node:url';
import { parseArchiveLines, searchArchive } from './archive-search.js';
import { openMessageDb, insertMessage, searchMessages, messageStats, closeMessageDb, latestMessageOfKey, pruneMessages } from './message-db.js';
import { dhashFromBufferAsync, hammingDistance } from './image-hash.js';
import { parseCommand, canRun, listCommands, parseDuration } from './group-commands.js';
import { VIDEO_MAX_BYTES, VIDEO_MAX_SECONDS, probeDuration, extractFrameGrid, extractAudioWav, transcribeWav, redactPii, resolveFfprobePath } from './video-analyze.js';
import { createSttService } from './stt-service.js';
import { createFollowUpHub, videoMediaFactText } from './video-followup.js';
import { normalizeVideoRecordMessages } from './video-text-normalize.js';
import { addSharedEvent, applyImpressionEdit, formatGlobalImpressions, mergeImpression, migrateImpressions, pruneEvents, selectEventsForInjection, buildHandoffDigest } from './memory-layers.js';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';
import { mdToPlain, splitForQQ, truncateText, truncateTextTail } from './md-to-plain.js';
import { SENSITIVE_RE, describeSensitiveMatch } from './sensitive.js';
import { clampPreSleepWait, looksLikeUnfinished } from './v2-wait.js';
import { compactModelMessage, describeAge } from './qq-model-view.js';
import { safeFetchBuffer, looksLikeImageBuffer, readBodyBounded } from './safe-fetch.js';
import { convertHeicToJpeg, sniffHeic, normalizeImageForModel } from './media-normalize.js';
import { AUDIO_EXTS, cleanupTemp, describeAudio, formatBytes, formatDuration, inspectAudio, listAudioFiles, parseTargetKey, processAudioVolume, resolveAudioProcessing, resolveAudioSource, safeJoinLibrary } from './send-voice-lib.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from './snowluma-conn.js';
import { discoverDshBaseUrl } from './dsh-endpoint.js';
import { hardenDir, manualDirCommand } from './state-acl.mjs';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
import { resolvePriceTable } from './model-prices.js';
import { MODEL_SCOPES, applyModelScope, readModelScopes } from './model-scope.js';
import { updateConfigFile } from './config-write.js';
import { normalizeRouting, resolveModelChoice, normalizeModelRef } from './model-routing.js';
import { matchAtMention, matchNameMention, resolveSelfIds } from './wake-selfid.js';
import { clearMediaTurn, isFreshMediaAt, isFreshMediaTurn, noteMediaTurn } from './media-turn.js';
import { emptyStore, ensurePerson, applyInbound, applyPenalty, describeForPrompt, listForConsole, loadStore, normalizeRules, privacyLine, saveStore, shiftByModel } from './affinity.js';
import { SELF_MODEL_PROMPT, buildSelfModelPayload } from './self-model.js';
import { loadPeople, savePeople, noteSighting, recallPeople } from './people.js';
import { buildDigest, pickDigests, renderDigestBlock, digestSnapshot, normalizeDigests } from './cross-session-memory.js';
// D36：摘要生成的修复已并回上面那份 buildDigest（单一真源）；这里只补两个接线层的纯函数
// ——「条数 或 年龄任一满足就重建」与「N 小时前」标签（单测 scripts/test-cross-session-digest-v2.mjs）。
import { shouldRefreshDigest, freshnessLabel } from './cross-session-digest-v2.js';
// D45：上下文预算回收（按 DSH 回报的 contextPressure 决定要不要换会话，见 src/context-budget.js）
import { budgetConfig, createContextPressureProbe, createBudgetRunner } from './context-budget.js';
// D47：sessionResets（「距上次重建过了多少条」）此前从没落盘，重启即归零，见 src/session-resets.js
import { packSessionResets, unpackSessionResets } from './session-resets.js';
// D67：私聊临时会话兜底（临时会话过期后不再遍历白名单群乱试），见 src/private-temp-session.js
import { createPrivateUnreachableStore, createTempSessionFallback, TEMP_SESSION_GROUP_HINT } from './private-temp-session.js';
// D70：AI 黑名单（手动登记要限制的 AI QQ，降频/静默），见 src/ai-blacklist.js
import { createAiBlacklistRuntime, createAiBlacklistAdmin } from './ai-blacklist.js';
// D70 P3：AI 黑名单「发送前硬闸」的纯判定（VM 模块 conversation-send 不能 import，只能注入）。
import * as aiBlacklistGatePure from './ai-blacklist-gate.js';
// D73：AI 黑名单的 QQ 私聊命令（owner 私聊 /aiban），见 src/ai-command.js
import { isAiBlacklistCommand, runAiBlacklistCommand } from './ai-command.js';
import { checkModelAgainstList, chooseTurnModel, collectCatalogModels, describeModels, isModelCapacityError, isModelUnavailableError, listAvailableModels, noteBounded, orderFallbacksByProvider, pickUsableModel, planFallback, resolveTurnModel, validateModelConfig } from './model-fallback.js';
import { buildLocalMessages, cleanLocalReply, createLocalClient, describeLocalFallback, localFallbackCfg, shouldTriggerLocalFallback } from './local-fallback.js';
import { buildPeakMessages, buildPeakChatBody, buildPeakRequest, consumePeakQuota, parsePeakReply, peakLocalCfg, shouldPeakLocal, isPeakToneRisky } from './peak-local.js';
import { buildRoleDraftMessages, resolveRoleDraft, uniqueRoleName } from './role-draft.js';
import { planConfigReload, pinRestartOnlyFields, RESTART_REQUIRED_PATHS } from './config-reload.js';
import { describeImageWithZhipu } from './zhipu-vision.js';
import { findImageMemory, imageMemoryLine, rememberImage } from './image-memory.js';
import { describeImagegenError, generateByTier, imagegenCfg, needsTranslation, resolveImageBuffer, tierAskSatisfied, translateImagePrompt } from './imagegen.js';
import { readQuota, writeQuota } from './imagegen-quota.js';
import { createMediaQueue, mediaQueueCfg } from './media-queue.js';
import { collectStorageStats } from './storage-stats.js';
import { safeFetchBinary, safeFetchToFile } from './safe-fetch.js';
import {
  normalizeFileArchiveConfig,
  isArchiveGroup,
  isArchiveFileName,
  ensureFileLedger,
  insertArchiveRecord,
  archiveRelPath,
  allocateStoredName,
  sha256Of,
  resolveArchiveRoot,
  safeResolveInside,
  setArchiveCategory,
  moveArchiveItemToCategory,
  filterArchiveRows,
  sortArchiveRows,
  fileListsFromRows,
  fileNotifyFromRows,
  planCategoryMove,
  listArchive,
  normalizeListParams,
  archiveStats,
  countArchive,
  ARCHIVE_IMAGE_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
  ARCHIVE_EXCLUDED_KINDS,
  ARCHIVE_RULE_EXTENSIONS,
  normalizeArchiveRules,
  matchArchiveRules,
  describeArchiveRules,
  runArchiveCleanup,
  formatCleanupLog,
  cleanupDeadline,
  classifyByRules,
  parseClassifyReply,
  storeArchivedFile,
  simpleArchiveDir,
  simpleBoothId,
  sanitizeFileName,
  storeDownloadedFile,
  allocateArchiveTarget,
  archiveChatFileSegments,
  archiveImageAttachment,
  shouldArchiveAttachment,
  describeArchiveSkip,
  archiveDirRel,
  enrichArchiveItem,
  backfillBoothColumns,
  rowsNeedingEnrichment,
  exportArchiveRows,
  archiveRowsToCsv,
  formatArchiveFactsBlock,
  archiveCapabilityHint,
  formatBytes as formatArchiveBytes
} from './file-archive.js';
import { normalizeBoothConfig, fetchBoothMeta, parseBoothName } from './booth-meta.js';
import { buildLibraryItems, buildLibraryItemDetail, buildLibraryUnclassified, planImageBoothBackfill } from './library-items.js';
import { buildLibrarySnapshot, buildLibrarySnapshotWithCache, scanLibraryTree, assetsFromFiles } from './library-scan.js';
import { SCAN_CACHE_FILE } from './library-scan-cache.js';
import { createLibraryDhash } from './library-dhash.js';
import * as libraryNotes from './library-notes.js';
import { normalizeThumbnailFile } from './booth-thumb.js';
import { getBoothCover, getBoothCoverPath } from './booth-cover.js';
import { normalizeThumbWidth, scaleImageBuffer } from './image-thumb.js';
import { DISK_RESERVE_BYTES, checkDiskSpace, describeDiskVerdict } from './disk-guard.js';
import { MALFORMED_GIVEUP_TEXT, decideMalformedAction, isMalformedToolJson } from './malformed-retry.js';
import { classifyAttachment } from './attachment-classify.js';
import { createStagedTask, raceWithTimeout } from './async-wait.js';
import { normalizeObserveConfig, isObserveGroup, planObserveLearning, applyObserveLearning, describeObserveConfig, describeObserveStickerSegments, observeApiView } from './observe-learn.js';
import { frameRetentionCfg, planFrameDeletions } from './frame-retention.js';
import { createTokenLedger } from './token-ledger.js';
// 工具维度的 token 归因（均摊规则）：纯函数在 src/token-tools.js（rules-backend 维护）。
// 这里 import 成命名空间再经 deps 注入 —— 控制台 VM 模块不能自己 import。
import * as tokenToolsPure from './token-tools.js';
import { isOwnSynthesis, isRecentSynthesis, nextAutoVoiceMark } from './voice-dedupe.js';
import {
  loadSlang,
  saveSlang,
  upsertSlangEntry,
  buildSlangContext,
  buildExtractionPrompt,
  buildResearchPrompt,
  parseExtractionJson,
  parseResearchJson,
  createSlangEntry,
  mergeEvidence,
  slangContentKey,
  SLANG_STATUS,
  SLANG_MAX_ENTRIES
} from './slang-learner.js';
import { DatabaseSync } from 'node:sqlite';
import { parsePersonaRequest, personaKeyError, personaMaxChars as personaMaxCharsOf } from './persona.js';
import { detectPersonaRequest, appendPersonaGuide, personaRequestFingerprint, PERSONA_GUIDE_TTL_MS, PERSONA_COOLDOWN_MS } from './persona-request.js';
import { accrueUsage, dayKey, formatLeft, quotaState } from './private-quota.js';
import {
  loadStickerStore,
  saveStickerStore,
  collectSticker,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed,
  md5Hex,
  stickerCandidates,
  backfillStickerMd5,
  persistStickerThumb,
  stickerCacheBytes,
  stickerCachePath
} from './sticker-lib.js';
import { readImageMeta, shouldAutoCollectSticker } from './sticker-collect-rules.js';
import { formatNoticeText, isDuplicateNotice, readNoticeStamp } from './startup-notice.js';
import { bootConfigState } from './bridge/boot/config-state.js';
import { bootMediaVoice } from './bridge/boot/media-voice.js';
import { bootRuntimeState } from './bridge/boot/runtime-state.js';
import { bootUsageLedger, bootUpstreamHealth } from './bridge/boot/usage-health.js';
import { bootConsoleAndSend, bootModelSession } from './bridge/boot/console-send.js';
import { bootSocialWake, bootTimeSense, bootPeakArchive } from './bridge/boot/wake-social.js';
// D62 阶段 2：QQ 网关 / 会话回收 / 上游健康 / 连接看护 / 启动收尾。VM 沙箱里由
// installBootModules 注入 globalThis，真实运行必须走 import，否则 main() 末尾直接 ReferenceError。
import { startQqGateway } from './bridge/boot/qq-gateway.js';
import { startRecycleLoops } from './bridge/boot/recycle-loops.js';
import { routeUpstreamHealth } from './bridge/boot/upstream-health.js';
import { watchConnection } from './bridge/boot/connection-watch.js';
import { normalizeIdentityConfig, checkIdentity, describeIdentityLock, assertIdentitySendAllowed, REQUIRED_BOT_SELF_ID } from './safety/identity-lock.js';
import { refreshIdentityForSend, refreshHttpIdentityForSend, createIdentityGuardedBot, assertWebSocketIdentityMapping } from './safety/identity-send.js';
import { finishStartup } from './bridge/boot/finish-startup.js';
import { createMemoryVector } from './memory-vector.js';
import { createDshUsageSync } from './dsh-usage-sync.js';
import { createConfigIo } from './bridge/config-io.js';
import { createRoleFiles } from './bridge/role-files.js';
import { createPresetFiles } from './bridge/preset-files.js';
import { createTextSecurity } from './bridge/text-security.js';
import { createConfigLoad } from './bridge/config-load.js';
// 会话侧纯规则（① 私聊加好友提示 / ② 纯净模式 / ③ @persona 命令）。
// 计算在 src/*.js（rules-backend 同步维护）；模块侧不能写 import（审计 VM 直接跑模块源码），
// 所以统一在这里 import 并塞进 runtimeBindings。
import { nextHintState, privateHintText, shouldAddFriendHint } from './private-hint.js';
import { applyPureMode, pureModePlan } from './pure-mode.js';
import { parseMentionCommand, personaUsageHint } from './mention-command.js';
import { createStateFiles } from './bridge/state-files.js';
import { createProcessLock } from './bridge/process-lock.js';
import { createMessageFormat } from './bridge/message-format.js';
import { createArchiveHistory } from './bridge/archive-history.js';
import { createIncomingMedia } from './bridge/incoming-media.js';
import { createStickers } from './bridge/stickers.js';
import { createVoice } from './bridge/voice.js';
import { createTts } from './bridge/tts.js';
import { createMediaSend } from './bridge/media-send.js';
import { createSlangRuntime } from './bridge/slang-runtime.js';
import { createContextServices } from './bridge/context-services.js';
import { createAffinityRuntime } from './bridge/affinity-runtime.js';
import { createUsageRuntime } from './bridge/usage-runtime.js';
import { createSessionPolicy } from './bridge/session-policy.js';
import { createUpstreamHealth } from './bridge/upstream-health.js';
import { createConsoleServer } from './bridge/console-server.js';
import { createOutboundText } from './bridge/outbound-text.js';
import { checkAttribution, describeSuspects } from './attribution-guard.js';
import { createPacingState as makePacingState, pacingOptions as readPacingOptions, reserveSendSlot as paceSendSlot } from './send-pacing.js';
import { createMediaInput } from './bridge/media-input.js';
import { createAttachmentArchive } from './bridge/attachment-archive.js';
import { createMediaResolution } from './bridge/media-resolution.js';
import { createOutboundPolicy } from './bridge/outbound-policy.js';
import { createModelSelection } from './bridge/model-selection.js';
import { createSessionRuntime } from './bridge/session-runtime.js';
import { createWakeState } from './bridge/wake-state.js';
import { createInitialPrompts } from './bridge/initial-prompts.js';
import { createMemoryPrompt } from './bridge/memory-prompt.js';
import { createSocialRuntime } from './bridge/social-runtime.js';
import * as toolCallTextPure from './agent/tool-call-text.js';
import { createPromptDelivery } from './bridge/prompt-delivery.js';
import { createSocialScheduler } from './bridge/social-scheduler.js';
import { createRolePrompts } from './bridge/role-prompts.js';
import { createPeopleRuntime } from './bridge/people-runtime.js';
import { createReplyResolution } from './bridge/reply-resolution.js';
import { createMessageState } from './bridge/message-state.js';
import { createToolJournal } from './bridge/tool-journal.js';
import { createWakeAdmission } from './bridge/wake-admission.js';
import { createWakePrompts } from './bridge/wake-prompts.js';
import { prelookupLine } from './memewiki.js';
import { createWakeDispatch } from './bridge/wake-dispatch.js';
import { createWakeScheduler } from './bridge/wake-scheduler.js';
import { createQuietWatch } from './bridge/quiet-watch.js';
import { createSpeakingStyle } from './bridge/speaking-style.js';
import { createPromptQueues } from './bridge/prompt-queues.js';
import { createPrivateQuotaRuntime } from './bridge/private-quota-runtime.js';
import { createPeakRuntime } from './bridge/peak-runtime.js';
import { createGroupCommandsRuntime } from './bridge/group-commands-runtime.js';
import { createIncomingRuntime } from './bridge/incoming-runtime.js';
import { createPendingInteractions } from './bridge/pending-interactions.js';
import { createMuxRuntime } from './bridge/mux-runtime.js';
import { muxCurrentStep, agentToolLoopModeOf, runHostTurn } from './bridge/mux-helpers.js';
// P0 agent transport：DSH 之外的可插拔接入层（零行为变化，VM 里 import 被剥掉，装配处有 typeof 守卫）。
import { createDshTransport } from './agent/transport-dsh.js';
import { createOpenAiTransport } from './agent/transport-openai.js';
import { createHttpTransport } from './agent/transport-http.js';
import { registerAgentTransport } from './agent/registry.js';
import { createArchiveRuntime } from './bridge/archive-runtime.js';
import { createConfigWatch } from './bridge/config-watch.js';
import { createFileArchiveRuntime } from './bridge/file-archive-runtime.js';
import { createObserveRuntime } from './bridge/observe-runtime.js';
// 表情缩略图缓存的清理/重试计划（纯函数）：observe-runtime 与 console 的缓存接口共用。
import * as stickerCachePure from './sticker-cache.js';
import { createStickerCacheOps } from './bridge/console/sticker-cache-ops.js';
import { createMemewiki } from './bridge/console/memewiki.js';
import { createImageBackfill } from './bridge/console/image-backfill.js';
import { createSessionRecycle } from './bridge/session-recycle.js';
import { createLoginRecovery } from './bridge/login-recovery.js';
import { createStateBackup } from './bridge/state-backup.js';
import { createLogRotate } from './bridge/log-rotate.js';
import { createConsoleOperations } from './bridge/console/operations.js';
import { createConsoleRoles } from './bridge/console/roles.js';
import { createConsoleRoleDraft } from './bridge/console/role-draft.js';
import { createConsolePresets } from './bridge/console/presets.js';
import { createConsoleSlang } from './bridge/console/slang.js';
import { createConsoleSessionAdmin } from './bridge/console/session-admin.js';
import { createConsoleFileLibrary } from './bridge/console/file-library.js';
import { createLibraryView, libraryAssetsViewOf } from './bridge/console/library-view.js';
import { createLibraryFind } from './bridge/console/library-find.js';
import { createLibraryBindIo } from './bridge/console/library-bind-io.js';
import { createLibraryFindByImage } from './bridge/console/library-find-by-image.js';
// 找号用的纯规则：桥接模块不能 import，所以在这里拼成 deps.*Pure 传进去（同 budgetAlertPure）。
import * as boothSearchPure from './booth-search.js';
// BOOTH 全局限速暂停（429/403）：找号/商品页/封面/已购同步共用一份状态文件。
// booth-meta/booth-cover 是普通 ESM 直接 import 它；VM 里的补封面、已购同步只能靠 deps 注入。
import * as boothPausePure from './booth-pause.js';
import { contentKeyFor } from './file-archive/common.js';
import * as libraryBindsPure from './library-binds.js';
// 解压码自动识别（纯规则，VM 模块 src/library-extract-code.js）：由解压/认号两处经 deps 调用。
import { createLibraryExtractCode } from './library-extract-code.js';
import * as libraryFindPure from './library-find.js';
import * as libraryBatchPure from './library-batch.js';
import * as libraryRenamePure from './library-rename.js';
import * as libraryAliasPure from './library-alias.js';
import * as libraryCollectionsPure from './library-collections.js';
// 已购/免费下载（P4）：同样的 deps 注入方式。
import { createLibraryDownload } from './bridge/console/library-download.js';
// 下载后解压：解压规则在 library-extract（VM-safe），zip 落盘能力在 src/zip-extract.js。
import { createLibraryExtract } from './bridge/console/library-extract.js';
// 解压密码本：手动解压与下载完自动解压共用（同一份 state/booth-passwords.json），
// 明文只在服务端内存/磁盘里，响应与日志一律只给掩码。
import { createLibraryPasswords } from './bridge/console/library-passwords.js';
// 工具维度 token 消费：账本 + 工具日志 → state/token-tools.json，控制台按天/群查询。
import { createTokenTools } from './bridge/console/token-tools.js';
import * as libraryUsageRootsNs from './library-usage-roots.js';
// 工程使用统计：纯函数层（roots 规整 / GUID 求交 / 汇总）与素材侧 GUID 抽取（解 .unitypackage）。
import * as libraryUsageNs from './library-usage.js';
import * as libraryUsageGuidsNs from './library-usage-guids.js';
import { matchConfiguredUsageRoot } from './library-usage-roots.js';
// 已购商品的「文件清单」：一个商品多个文件时按文件逐个下（清单抓取在本模块里）。
import { createLibraryPurchaseFiles } from './bridge/console/library-purchase-files.js';
// 「一键导入 Unity 工程」：下完 → 解到 <usageRoot>/Assets/<标题>/。
import { createLibraryImport } from './bridge/console/library-import.js';
import { extractZipToDir, listZipPreview, readZipDirectoryFromFile } from './zip-extract.js';
// 存量素材批量补封面：命名规则复用 libraryFindPure，落盘是 `<主件stem>.thumbnail.jpg`。
import { createLibraryCovers } from './bridge/console/library-covers.js';
import { createLibraryUsage } from './bridge/console/library-usage.js';
// 素材回收站：只 move 不删，真删要 confirm:true；路径全过 safeResolveInside。
import { createLibraryTrash } from './bridge/console/library-trash.js';
// 回收站自动清理挂在档案清理的每日调度点上（见 file-archive-runtime.js），这里提供注入点。
// libtrTrashKeys 同时给批量操作复用：批量 trash 与单件入口必须走同一段搬移/回滚逻辑。
import { libtrAutoPurge, libtrTrashKeys } from './bridge/console/library-trash.js';
// 素材库批量操作（多选：绑定/合并/移入回收站）：逐个执行、失败不中断，规则复用单件接口。
import { createLibraryBatch } from './bridge/console/library-batch.js';
// 素材「归位」（POST /api/library/relocate + /undo）：把日期目录里的素材挪进独立目录，可撤销。
import { createLibraryRelocate } from './bridge/console/library-relocate.js';
import { createDesktopClient } from './bridge/console/desktop-client.js';
import { createOpenFolder } from './bridge/console/open-folder.js';
// 合并组纯规则（setMerge/normalizeMergeTable）：批量合并与单件合并共用 state/booth-merges.json。
import * as libraryMergePure from './library-merge.js';
// 压缩包内封面（zip-read/unitypackage-cover 的解包规则）：补封面第 3 档，VM 模块经 deps 注入。
import * as libraryPackageCoverPure from './library-package-cover.js';
// 已购库（BOOTH 商品资料库）：商品页解析规则在 src/booth-product.js，同样走 deps 注入。
import { createLibraryPurchases } from './bridge/console/library-purchases.js';
// 已购库截图识别：WinRT OCR（PowerShell 脚本在 scripts/lib/ocr-image.ps1）。
import { createLibraryOcr } from './bridge/console/library-ocr.js';
import { createLibraryPurchasesSync } from './bridge/console/library-purchases-sync.js';
import { createLibraryCollections } from './bridge/console/library-collections.js';
import { createBoothLogin } from './bridge/console/booth-login.js';
// 系统打开链接（POST /api/open-url）：白名单只放 booth.pm / booth.pximg.net，走 deps.spawn 开系统浏览器。
import { createOpenUrl } from './bridge/console/open-url.js';
import * as boothProductPure from './booth-product.js';
// 只读访客（L6）的访问规则：纯函数，注入给 console-server 用（那文件不 import 业务模块）。
import * as consoleGuestPure from './console-guest.js';
import { createGuestAccess } from './bridge/console/guest-access.js';
import * as boothDownloadPure from './booth-download.js';
import { createConsoleSecuritySocial } from './bridge/console/security-social.js';
import { createConsoleSocialConfig } from './bridge/console/social-config.js';
import { createConsoleSocialReads } from './bridge/console/social-reads.js';
import { createSessionLabels } from './bridge/console/session-labels.js';
import { createConsoleModelsAffinity } from './bridge/console/models-affinity.js';
import { createConsoleImagegen } from './bridge/console/imagegen-config.js';
import { createBudgetAlert } from './bridge/console/budget-alert.js';
import { BUDGET_ALERT_DEFAULTS, budgetAlertSettingsOf, evaluateBudgetAlert, formatBudgetAlert, formatBudgetAlertTest, shouldNotifyBudget, budgetLimitOf, budgetProjection } from './budget-alert.js';
import { applyProviderPatch, keyTail, providersView } from './imagegen-providers.js';
import { createConsoleAiBlacklist } from './bridge/console/ai-blacklist.js';
import { createConsoleWakeControls } from './bridge/console/wake-controls.js';
import { createConsoleConversationSend } from './bridge/console/conversation-send.js';
import { createConsoleMediaTools } from './bridge/console/media-tools.js';
import { createConsoleDraw } from './bridge/console/draw.js';
import { createConsoleStickersVoices } from './bridge/console/stickers-voices.js';
import { createConsoleWait } from './bridge/console/wait.js';
import { createConsoleJournal } from './bridge/console/journal.js';
import * as tokenProvidersPure from './token-providers.js';
import { createConsoleMessageDetail } from './bridge/console/message-detail.js';
import { createConsoleMemberNotes } from './bridge/console/member-notes.js';
import { createConsoleMemory } from './bridge/console/memory.js';
import { createConsoleSlangTools } from './bridge/console/slang-tools.js';
import { createConsoleSendReset } from './bridge/console/send-reset.js';
import { createConsoleConfigAdmin } from './bridge/console/config-admin.js';
// 设置页「测试连通」：只读探活 agent 端点（不落盘、不回 apiKey）。
import { createAgentProbe } from './bridge/console/agent-probe.js';
import { createConsoleLocalModel } from './bridge/console/local-model.js';
import { createImpressionsRunner } from './bridge/impressions-run.js';
import { createConsoleToolsGate } from './bridge/console/tools-gate.js';
import { createConsoleLists } from './bridge/console/lists.js';
// P1-1 人设上移：非 dsh transport 时由桥接自己拼 system prompt（纯函数，见 src/persona-prompt.js）。
import * as personaPromptPure from './persona-prompt.js';

  // Live accessors preserve config reloads, counters and queue replacement across modules.
  const sharedBindings = {
    get AbortSignal() { return AbortSignal; }, set AbortSignal(value) { AbortSignal = value; },
    get ACTIVITY_LOG() { return ACTIVITY_LOG; },
    get appendActivityLog() { return appendActivityLog; },
    get appendBridgeLog() { return appendBridgeLog; },
    get applyRoleInjectLimit() { return applyRoleInjectLimit; },
    get atomicWriteJson() { return atomicWriteJson; },
    get atomicWriteText() { return atomicWriteText; },
    get BRIDGE_LOG() { return BRIDGE_LOG; },
    get classifyAttachment() { return classifyAttachment; },
    get clearTimeout() { return clearTimeout; },
    get console() { return console; }, set console(value) { console = value; },
    get CONVERSATION_TOKENS() { return CONVERSATION_TOKENS; },
    get Buffer() { return Buffer; },
    get crypto() { return crypto; },
    get decideLock() { return decideLock; },
    get discoverDshLaunchToken() { return discoverDshLaunchToken; },
    get execFileSync() { return execFileSync; },
    get extractPresetPrefix() { return extractPresetPrefix; },
    // 仅非 dsh transport 用：dsh 的人设仍由 DSH 预设负责，避免双重人格。
    get personaPromptFor() {
      return (channel) => {
        try {
          const type = (cfg.agent && cfg.agent.type) || 'dsh';
          if (type === 'dsh') return null;
          const imagegen = cfg.imagegen && typeof cfg.imagegen === 'object' ? cfg.imagegen : {};
          const capabilities = {
            draw: imagegen.enabled !== false && Boolean(imagegen.preferred || imagegen.fallback),
            sticker: true,
            search: true
          };
          return personaPromptPure.buildPersonaSections(cfg, { channel, capabilities });
        } catch (error) {
          return null;
        }
      };
    },
    get fetch() { return fetch; },
    get forwardIdFromData() { return forwardIdFromData; },
    get fs() { return fs; },
    get GEN1_ROLE_LINE_RE() { return GEN1_ROLE_LINE_RE; },
    get hardenDir() { return hardenDir; },
    get KNOWN_AGENT_TOKENS() { return KNOWN_AGENT_TOKENS; },
    get listRoles() { return listRoles; },
    get localClock() { return localClock; },
    get LOCK_FILE() { return LOCK_FILE; },
    get log() { return log; },
    get runPowerShell() { return runPowerShell; },
    get LOG_LINE_MAX() { return LOG_LINE_MAX; },
    get manualDirCommand() { return manualDirCommand; },
    get MAX_KNOWN_AGENT_TOKENS() { return MAX_KNOWN_AGENT_TOKENS; },
    get MODE_INPUT_ALIASES() { return MODE_INPUT_ALIASES; },
    get normalizeFileArchiveConfig() { return normalizeFileArchiveConfig; },
    get normalizeIdList() { return normalizeIdList; },
    get normalizeObserveConfig() { return normalizeObserveConfig; },
    get normalizeOwnerQQ() { return normalizeOwnerQQ; },
    get normalizeReasoningEffort() { return normalizeReasoningEffort; },
    get os() { return os; },
    get parseRoleSections() { return parseRoleSections; },
    get path() { return path; },
    get PRESET_BACKUP_DIR() { return PRESET_BACKUP_DIR; },
    get PRESET_BACKUP_KEEP() { return PRESET_BACKUP_KEEP; },
    get PRESET_NAMES() { return PRESET_NAMES; },
    get readJsonSafe() { return readJsonSafe; },
    get REASONING_EFFORT_DEFAULT() { return REASONING_EFFORT_DEFAULT; },
    get REASONING_EFFORT_OPTIONS() { return REASONING_EFFORT_OPTIONS; },
    get redactSensitiveText() { return redactSensitiveText; },
    get ROLE_CONTENT_MAX_BYTES() { return ROLE_CONTENT_MAX_BYTES; },
    get ROLE_INJECT_MAX_CHARS_DEFAULT() { return ROLE_INJECT_MAX_CHARS_DEFAULT; },
    get ROLE_NAME_MAX() { return ROLE_NAME_MAX; },
    get ROLE_RESERVED_NAMES() { return ROLE_RESERVED_NAMES; },
    get ROLE_STATE_FILE() { return ROLE_STATE_FILE; },
    get roleCharStats() { return roleCharStats; },
    get roleInjectMaxChars() { return roleInjectMaxChars; }, set roleInjectMaxChars(value) { roleInjectMaxChars = value; },
    get ROLES_DIR() { return ROLES_DIR; },
    get ROOT() { return ROOT; },
    get sanitizeRoleName() { return sanitizeRoleName; },
    get SEND_TOOL_RE() { return SEND_TOOL_RE; },
    get SENSITIVE_RE() { return SENSITIVE_RE; },
    get setTimeout() { return setTimeout; },
    get staleLogMs() { return staleLogMs; },
    get state() { return state; }, set state(value) { state = value; },
    get STATE_DIR() { return STATE_DIR; },
    get STATE_FILE() { return STATE_FILE; },
    get stateDirHardened() { return stateDirHardened; }, set stateDirHardened(value) { stateDirHardened = value; },
    get stateWritable() { return stateWritable; }, set stateWritable(value) { stateWritable = value; },
    get truncateText() { return truncateText; },
    get WINDOWS_RESERVED_NAMES() { return WINDOWS_RESERVED_NAMES; },
  };
  const { normalizeModeInput, settingFromDshNamespace, readJsonSafe, readConfigObject, renameWithRetry, atomicWriteJson, atomicWriteText, safeFetchJsonCompat, persistDshBaseUrl, persistCorrectedModel, loadOrCreateConsoleToken, loadOrCreateGuestToken, hardenStateDirAcl, readActivityTail, listRoles } = createConfigIo(sharedBindings);
  const { applyRoleInjectLimit, roleFilePath, firstMeaningfulLine, roleWarnings, roleSummaries, validateRoleName, validateRoleContent, readRoleContent, writeRoleContent } = createRoleFiles(sharedBindings);
  const { knownPresetName, presetSourceYaml, dshHomeDir, installedPresetYaml, readPresetPromptText, presetBackupPrefix, backupPresetFile, listPresetBackups, presetStatus } = createPresetFiles(sharedBindings);
  const { isSilentMarker, isSendToolName, rememberAgentToken, forgetAgentToken, normalizeReasoningEffort, redactSensitiveText, escapeCqText, unquoteJsonString, appendActivity, readRoleState, writeRoleState, sanitizeRoleName, normalizeOwnerQQ, normalizeIdList } = createTextSecurity(sharedBindings);
  const { loadConfig } = createConfigLoad(sharedBindings);
  const { loadState, saveState } = createStateFiles(sharedBindings);
  const { consolePortInUse, consolePortOwnerPid, bridgeLogIdleMs, consoleProbeResponsive, terminatePidAndWait, acquireLock, releaseLock } = createProcessLock(sharedBindings);
  const { createCappedLogger, localClock, log, withTimeout, segmentsToText, sanitizeMediaSummary, extractMediaFromSegments, allowed, canonicalV2Key } = createMessageFormat(sharedBindings);


const __dirname = path.dirname(fileURLToPath(import.meta.url));
// stdout/stderr 管道被父进程关掉时，console.log 会抛 `Error: write EOF`（不是 EPIPE code），
// 未捕获就整进程退出——今天 10 次崩溃都是这个。
for (const stream of [process.stdout, process.stderr]) {
  try {
    stream.on('error', (error) => {
      const msg = String(error?.message ?? error?.code ?? error);
      if (/write EOF|EPIPE|ECONNRESET|EINVAL/i.test(msg)) return;
      try { process.stderr.write(`[stdio] ${msg}\n`); } catch {}
    });
  } catch {}
}

const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
// 本地画面记忆（按 dhash 查表）：同一张图第二次出现不再识图。
const IMAGE_MEMORY_FILE = path.join(STATE_DIR, 'image-memory.json');
let imageMemoryCache = null;
let imageMemorySaveTimer = null;
const imageMemoryInflight = new Set();
async function imageMemoryEnsureSeenImpl(cfg, label, prep, kind) {
  try {
    if (!prep?.buffer?.length) { log(`[识图调试] ${label} buffer 空`); return null; }
    const hash = await dhashFromBufferAsync(prep.buffer);
    if (!hash) { log(`[识图调试] ${label} hash 空（buffer ${prep.buffer.length}B）`); return null; }
    const im = cfg?.socialV2?.imageMemory || {};
    if (im.enabled === false) { log(`[识图调试] ${label} imageMemory.enabled=false`); return null; }
    const hit = findImageMemory(imageMemoryLoad(), hash, { maxDistance: Number.isFinite(im.maxDistance) ? im.maxDistance : 6 });
    if (hit?.entry) { log(`[识图] ${label} 命中本地图库（距离 ${hit.distance}）`); return { hit: true, distance: hit.distance, desc: hit.entry.d }; }
    if (imageMemoryInflight.has(hash)) return null;
    imageMemoryInflight.add(hash);
    try {
      const d = await describeImageWithZhipu({ buffer: prep.buffer, mimeType: prep.mimeType, label, cfg });
      if (d?.ok && d.text) {
        log(`[识图] ${label} 识图 ${d.ms ?? '?'}ms / ${String(d.text).length} 字`);
        const r = rememberImage(imageMemoryLoad(), { hash, desc: d.text, kind }, { maxEntries: Number.isFinite(im.maxEntries) ? im.maxEntries : 5000 });
        if (r.added || r.updated) { imageMemoryCache = r.store; imageMemorySaveSoon(); }
        return { hit: false, desc: d.text, ms: d.ms };
      }
      if (d) log(`[识图] ${label} 失败：${d?.error || '没有结果'}`);
    } finally {
      imageMemoryInflight.delete(hash);
    }
  } catch (error) {
    log(`[识图] ${label} 异常：${error?.message || error}`);
  }
  return null;
}
function imageMemoryLoad() {
  if (imageMemoryCache) return imageMemoryCache;
  try { imageMemoryCache = JSON.parse(fs.readFileSync(IMAGE_MEMORY_FILE, 'utf8')); } catch { imageMemoryCache = { version: 1, entries: [] }; }
  return imageMemoryCache;
}
let impressionsCache = null;
let impressionsCacheMtime = 0;
// 群友档案（state/impressions.json）：每 2 天才归纳一次，按 mtime 缓存，别在每轮唤醒时重解析 119KB。
function impressionsLoad() {
  const file = path.join(STATE_DIR, 'impressions.json');
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (impressionsCache && mtime === impressionsCacheMtime) return impressionsCache;
    impressionsCache = JSON.parse(fs.readFileSync(file, 'utf8'));
    impressionsCacheMtime = mtime;
    return impressionsCache;
  } catch {
    return { people: {} };
  }
}
function imageMemorySaveSoon() {
  if (imageMemorySaveTimer) return;
  imageMemorySaveTimer = setTimeout(() => {
    imageMemorySaveTimer = null;
    try { atomicWriteJson(IMAGE_MEMORY_FILE, imageMemoryCache); } catch {}
  }, 3000);
  try { imageMemorySaveTimer.unref?.(); } catch {}
}
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
// 跨群认人档案（D42）：运行时自建，只在 socialV2.memory.people.enabled 开启后才会写。
const PEOPLE_FILE = path.join(STATE_DIR, 'people.json');
// prompt 分段快照（/api/debug/prompt-parts 用）：key -> { parts, total, builtAt, reason }。
// 放模块级而不是 main() 里：任何在启动早期就触发的构建都不能踩到 TDZ。
// 只存 name+chars —— prompt 正文里有会话令牌、跨会话摘要、人设，绝不外带。
const PROMPT_PARTS_SNAPSHOT_MAX = 200;
const promptPartsSnapshots = new Map();
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
// 操作者为每个会话预写的「初始提示词」（见 main() 里的 initialPrompts）。
// 单独一个文件：它属于操作者配置，不能随 social-v2.json 的会话状态一起被重置清掉。
const INITIAL_PROMPTS_FILE = path.join(STATE_DIR, 'initial-prompts.json');
// 私聊临时通行证：每个陌生人每天的累计对话时长（state/private-quota.json）。
const PRIVATE_QUOTA_FILE = path.join(STATE_DIR, 'private-quota.json');
// D67：私聊临时会话不可达的冷却记帐（按 uid，30 分钟）。以前临时会话过期后每条消息都遍历白名单群重试。
const PRIVATE_UNREACHABLE_FILE = path.join(STATE_DIR, 'private-unreachable.json');
const privateUnreachable = createPrivateUnreachableStore({
  file: PRIVATE_UNREACHABLE_FILE,
  fs,
  writeJson: (file, obj) => atomicWriteJson(file, obj),
  log
});
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');

/**
 * 模式拼写的**唯一**归一入口（输入边界）。
 *
 * `simulation` 是规范名（QSH_PLAN.md §2.1：对用户只暴露 `closed-agent` / `simulation`），
 * `chat` / `reserved` / `reserved2` 是历史拼写 —— 必须继续被**接受**（线上桥接持久化的全局值
 * 就是 `reserved2`），但进程内部一律用历史拼写存储与比较：`currentMode === 'reserved2'` 这类
 * 判断遍布发送闸门、定时器与 preset 解析，把规范名直接塞进 `currentMode` 会让它们全部变成假。
 *
 * 旧写法是 `VALID_MODES = ['chat','closed-agent','reserved','reserved2']`，控制台那处还抄了
 * 一份同样的字面量数组。后果是：在 DSH 设置或 `state/mode.json` 里写 `simulation` 会被**静默
 * 忽略**，`currentMode` 保持上一次的值（进程刚起来时是 `chat`，即一代仿真 —— preset 与工具面
 * 都和二代不同，`v2ToolEnabled` 之类的闸门也不生效）。用户以为切到了仿真，实际跑的是另一套，
 * 而且没有任何日志。规范名与历史名必须在这里收敛成同一个内部值。
 */
const MODE_INPUT_ALIASES = Object.freeze({
  chat: 'chat',
  reserved: 'reserved',
  reserved2: 'reserved2',
  simulation: 'reserved2',
  'closed-agent': 'closed-agent'
});
/** 内部合法模式集合（由别名表派生，避免"两份名单各自漂移"）。 */
const VALID_MODES = Object.freeze([...new Set(Object.values(MODE_INPUT_ALIASES))]);

/** 输入侧归一：返回内部拼写；无法识别返回 null，由调用方 fail-closed。 */
// @bridge-function normalizeModeInput from config-io

/**
 * 从 DSH `settings.describe` 的一个命名空间里读某个键，**user 层优先、value 回退**。
 *
 * 为什么不能只读 `value`：DSH 0.2.0-rc.2 的 `settings/update` 写入的是 user 层
 * （profile patch 的显式 config），当次进程内 `describe().value`（取自插件 fiber 的
 * 运行配置）**不会更新**，要重启 DSH 才变。控制台切模式后 5 秒一次的 `refreshMode()`
 * 会读回旧 `value`，把刚选的模式改回去（issue #22，实测复现）。
 * 写哪读哪：`user` 里有显式值就用它，否则回退 `value`（从没写过时 `user` 是空对象，
 * 老行为不变；DSH 以后修好热更新也继续正确）。
 */
// @bridge-function settingFromDshNamespace from config-io

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
// @bridge-function readJsonSafe from config-io

/**
 * 读取 config.json，并保证拿到一个**可安全改写的普通对象**。
 *
 * 为什么不是 `readJsonSafe(file, null, true) ?? {}`：控制台这些端点都是
 * 「读整份 config → 改一个字段 → 原子写回」。JSON.parse 对字面量 `null` 是**成功**的，
 * 于是 `file` 可能是 null：`file.socialV2` 直接 TypeError（保存接口 500，且错误信息
 * 完全指不出"配置文件顶层是 null"）；而用 `?? {}` 兜底更糟 —— 回写会把整份配置替换成
 * 只含本次提交字段的新对象，用户的白名单、令牌、模式全被抹掉。
 * 所以：不是普通对象就抛错，让调用方的 try/catch 返回 500（与各端点注释里
 * "配置文件损坏时直接 500，绝不回写" 的既有约定一致）。
 */
// @bridge-function readConfigObject from config-io

/**
 * 原子替换：`fs.renameSync` 覆盖一个「正被别人打开」的目标，在 Windows 上会抛 EPERM
 * （Defender / 编辑器 / 资源管理器预览 / 云同步都可能在这个窗口里碰它）。
 * 实测本机可复现。这里退避重试几次；实在不行才抛，让调用方决定怎么提示。
 */
// @bridge-function renameWithRetry from config-io

// 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，也避免固定临时名被并发/符号链接攻击利用。
// @bridge-function atomicWriteJson from config-io

// 原子写文本文件。
// @bridge-function atomicWriteText from config-io

/**
 * POST JSON 并取回 JSON（openai-image 模式用）。
 *
 * 为什么不复用 safeFetchBuffer：那个要求响应体是 PNG/JPEG/GIF/WebP（图片魔数校验），
 * 这里是**先拿 JSON、再按需取图**。SSRF 边界由调用方保证——目标地址来自管理员配置的
 * imagegen.baseUrl，不是群友输入；而图片字节（b64 解出来的除外）仍然走 safeFetchBuffer。
 */
// @bridge-function safeFetchJsonCompat from config-io

/**
 * 把发现的 DSH 地址写回 config.json。
 * DSH 桌面版每次启动换端口，写回去下次启动就不用再发现一遍（发现失败也有正确地址兜底）。
 * 只在确实变了时调用；任何失败都只记日志，绝不让写配置失败拖垮桥接启动。
 */
// @bridge-function persistDshBaseUrl from config-io

/**
 * 把启动校验纠正后的模型写回 config.json（先备份成 config.json.bak-<时间戳>）。
 *
 * 为什么值得写盘：不合法的 id 留在配置里，就会**每一轮**先拿它去 selectModel、失败、
 * 再自动降级 —— 每轮白付一次 RPC 延迟，日志每轮刷两条（线上 15:29:22 那次即此）。
 * 只在确实拿到可用清单、且有明确替代项时调用；任何失败都只记日志，绝不影响启动。
 */
// @bridge-function persistCorrectedModel from config-io

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。
// @bridge-function loadOrCreateConsoleToken from config-io

/**
 * 收紧 state/ 的访问权限。
 *
 * **Windows 上 `mode: 0o600` 是空操作**（实测：chmod 之后 ACL 不变），文件继承父目录 ACL ——
 * 本机 state/console-token 实测为 `NT AUTHORITY\Authenticated Users:(M)`，也就是任何能登录
 * 这台机器的用户都能读走控制台令牌、Snowluma accessToken、各会话 agentToken 和全部 QQ 聊天记录。
 * 这里用 icacls 切断 state/ 的继承链，只保留「当前用户 + SYSTEM + Administrators」。
 *
 * ⚠️ 具体实现已抽到 `src/state-acl.mjs`（与 scripts/harden-state-acl.mjs 共用同一份）。
 * 这里原本自带一份**会破坏数据**的实现：
 *   · `icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /T` —— (OI)(CI) 是目录专用标志，
 *     套到 /T 展开的文件上会失败，而 /inheritance:r 已摘掉文件的继承 ACE，净结果是
 *     **子文件 DACL 被清空、连属主都读不了**（实测 state/ 下 50 个文件变空，桥接读不到
 *     自己的控制台令牌）；启动日志只报「未能收紧」，看不出已经造成破坏。
 *   · 回读自检用 `/\(I\)/` 扫全文，而 DSH 沙箱的 Low 完整性标签行永远带 (I) ——
 *     于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
 * 两处逻辑各写一份正是漂移的根源，故合并。失败时不能只说"可能可读"就完事，
 * 要给出一条**安全**的可复制命令，并把结果回报到控制台（/api/security 的 stateDirHardened）。
 * 宁可明确报"没做成"，也不要假装已经安全。
 */
// @bridge-function hardenStateDirAcl from config-io

// @bridge-function readActivityTail from config-io

// @bridge-function listRoles from config-io

// ── 人格文件读写 ────────────────────────────────────────────────────────────
// 人格提示词 = roles/<名称>.md，由桥接在每条消息前注入（热生效，无需重启 DSH）。
const ROLES_DIR = path.join(ROOT, 'roles');
const ROLE_NAME_MAX = 40;
const ROLE_CONTENT_MAX_BYTES = 64 * 1024;
// 注入上限：**按模式筛完小节之后**再截断，避免另一模式的专属内容白白占掉预算。
// 默认 8000（2026-10 起：小鲸鱼卡补了形象/圈层/白饭-token/开发事件梗，6000 会把
// 末尾「你的样子」整段截掉——截断点落在卡尾而不是卡中，比调大预算更危险），
// 仍是每条约 6~8k token 的成本护栏；可用 config.json 的 role.maxInjectChars 调整
// （1000~20000）；启动时由 applyRoleInjectLimit() 写入。
const ROLE_INJECT_MAX_CHARS_DEFAULT = 8000;
let roleInjectMaxChars = ROLE_INJECT_MAX_CHARS_DEFAULT;
// @bridge-function applyRoleInjectLimit from role-files
const ROLE_RESERVED_NAMES = new Set(['README']);
// Windows 保留设备名：roles/CON.md 这类路径会被系统当成设备而不是文件，
// 写入会失败甚至挂起，因此在人格名层面直接拒绝。
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

// @bridge-function roleFilePath from role-files

// @bridge-function firstMeaningfulLine from role-files

// @bridge-function roleWarnings from role-files

// @bridge-function roleSummaries from role-files

// @bridge-function validateRoleName from role-files

// @bridge-function validateRoleContent from role-files

// @bridge-function readRoleContent from role-files

// @bridge-function writeRoleContent from role-files

// ── 二代仿真预设提示词（「仿真」层）────────────────────────────────────────
// 与「人格」层的边界：
//   仿真提示词 = 预设内置，规定 AI 怎么调工具、怎么参与群聊（行为与协议）
//   人格提示词 = roles/<名称>.md，规定 AI 是谁、什么性格（人设与语气）
// 仿真层改完需要重启 DSH 才生效（preset 由 DSH 在会话创建时装配）；
// 人格层由桥接每条消息注入，保存即生效。
// 两代仿真各自有独立的预设提示词：一代 qq-chat（空格分条 / [SILENT]），
// 二代 qq-chat-v2（一切皆工具）。控制台可分别查看与修改。
const PRESET_NAMES = { v1: 'qq-chat', v2: 'qq-chat-v2' };
const PRESET_BACKUP_DIR = path.join(STATE_DIR, 'preset-backups');
const PRESET_BACKUP_KEEP = 10;

/**
 * 控制台的 preset 参数校验：只接受本项目这两个预置名（缺省 = 二代）。
 *
 * 为什么必须在拼路径**之前**校验：main() 里的 resolvePresetName() 在「DSH preset 清单为空」
 * （DSH 还没连上 / 正在启动）时会把调用方给的字符串**原样返回**。那四个 preset 控制台路由
 * 都拿它去 path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml')，
 * 于是 `preset=..\..\..\x` 会读写/备份 <x>/agent.cordis.yml，越出仓库。
 * 返回 null 由调用方回 400。
 */
// @bridge-function knownPresetName from preset-files

// @bridge-function presetSourceYaml from preset-files

// @bridge-function dshHomeDir from preset-files

// @bridge-function installedPresetYaml from preset-files

// 这里**没有**模块级的 resolvePresetName —— 曾经有一个，但它被 main() 内部同名函数完全遮蔽
// （函数声明提升到 main 作用域，main 里所有调用点都落到内部那个），是纯死代码。
// 而且它的语义是错的：未知名字静默回退到 qq-chat-v2，等于 fail-OPEN —— 一旦哪天有人把它
// "复活"成真正生效的实现，群聊会话就会在 preset 清单校验失败时照样建起来。
// 真正在用的那个（main() 内，带 strict 开关）在名字不可用时返回 '' 让调用方拒绝建会话。
// 同理不再保留 PRESET_NAME_SET：它只服务于那个死函数，留着只会诱惑下一个人去用它。

// @bridge-function readPresetPromptText from preset-files

// 备份文件名带上预设名：两个预设的主文件名都叫 agent.cordis.yml，
// 不加前缀会让「还原」列到另一个预设的备份。
// @bridge-function presetBackupPrefix from preset-files

// @bridge-function backupPresetFile from preset-files

// @bridge-function listPresetBackups from preset-files

// @bridge-function presetStatus from preset-files

// 回复审计：agent 回复若命中以下特征（本机路径/凭据），硬性拦截不发送。
// 宁可误拦，不可泄露。
// 社交模式“静默标记”：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在“不想接话/潜水”时有合法沉默出口，而不是写“（内心戏）”被当成消息发出去。
const SILENT_MARKER = '[SILENT]';
// @bridge-function isSilentMarker from text-security

// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免“工具发一条 + 自动转发一条”的重复。
const SEND_TOOL_RE = /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;
// @bridge-function isSendToolName from text-security

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 已知的二代 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
const KNOWN_AGENT_TOKENS = new Set();

// 会话 → 该会话「当前代 + 上一代」agentToken 的索引（见 rememberAgentToken）。
//
// 为什么必须有这份索引：retireSession() 每次轮换 token 都会把**新** token 塞进
// KNOWN_AGENT_TOKENS，而 reconcileSessionPolicies() 在**任何**策略变化（切模式、改白名单、
// preset 清单变动）时都会退役全部会话 —— 于是每切一次模式，每个会话就在集合里永久多留一个
// token，且只有 /reset、/api/session/reset、/api/socialV2/reset 会删。集合只增不减，而
// redactSensitiveText()（每写一行日志）和 redactKnownTokensOnly()/onebotSend()（每条出站消息）
// 都要先复制整个集合再线性扫，长期运行后这两条热路径会被拖垮。
//
// 选择「按会话替换」而不是硬性 LRU 上限：硬上限在会话多的时候会淘汰掉**仍然有效**的 token，
// 那等于把活令牌漏到 QQ，属于削弱安全边界。按会话记账时集合大小 ≈ 会话数 × 2，且每个会话
// 一定保留当前代（活令牌必然可脱敏）与上一代（模型上下文里最可能残留的那一个）；会话被删除
// 时用 forgetAgentToken() 整体摘除。第三代已经在两次轮换之前，不可能还在上下文里，直接丢弃。
const CONVERSATION_TOKENS = new Map();
const MAX_KNOWN_AGENT_TOKENS = 512;

/**
 * 记录某会话的当前 agentToken：丢掉它两代之前的旧 token，避免集合无界增长。
 * 另加一层上限兜底（防止异常路径下会话 key 无界增多），淘汰顺序是「先扔非活代」。
 */
// @bridge-function rememberAgentToken from text-security

/** 会话被彻底移除（重置/清空工作区/退订）时，连同它的 token 一起从脱敏集合摘掉。 */
// @bridge-function forgetAgentToken from text-security

// 读取 DSH 模型能力的在途 Promise：withTimeout 只做 Promise.race，不会取消底层 RPC，
// 因此并发刷新会各自留下一个不可取消的请求。这里做去重，同一时刻只发一个。
let modelCatalogInFlight = null;
// DSH 思考强度（reasoningEffort）热切换代号。
// 控制台改强度后递增它，让已在运行的会话在下一条消息重新 selectModel；
// 放在模块级是为了不依赖 main() 内部声明的执行顺序（避免 TDZ）。
let modelSelectionEpoch = 0;
// DeepSeek provider 明确支持的取值（见 dsh-llm-deepseek：其它值会抛 UNSUPPORTED_REASONING_EFFORT）。
// 'off' 虽然合法（关闭思考），但 QQ 聊天助手依赖思考，控制台不提供该档。
const REASONING_EFFORT_OPTIONS = ['low', 'high', 'max'];
const REASONING_EFFORT_DEFAULT = 'max';
// @bridge-function normalizeReasoningEffort from text-security

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
// @bridge-function redactSensitiveText from text-security

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
// @bridge-function escapeCqText from text-security

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
// @bridge-function unquoteJsonString from text-security

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
const appendActivityLog = createCappedLogger(ACTIVITY_LOG, 500);
// @bridge-function appendActivity from text-security

// 读取角色/模式状态：{"role": "傲娇助手", "mode": "active"|"silent"}
// @bridge-function readRoleState from text-security
// @bridge-function writeRoleState from text-security
// @bridge-function sanitizeRoleName from text-security

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
// @bridge-function normalizeOwnerQQ from text-security

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
// @bridge-function normalizeIdList from text-security

// ── 配置 ────────────────────────────────────────────────────────────────────
// @bridge-function loadConfig from config-load

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
let state = { sessions: {} };
// D62：机器人自身 id/昵称缓存。启动极早期（warmSelfIdentity，阶段 1）就会读写，
// 所以留在入口模块作用域，不随装配阶段下沉（否则读到的是 TDZ）。
var botSelfIdCache = '';
var botNicknameCache = '';
// sessions.json 读不动/读坏时必须**大声失败**，不能静默回落成空映射：
// 那会让每个 QQ 会话都拿到一个全新的 DSH 会话（上下文全丢），而紧接着的
// saveState() 会把这份空映射原子写回磁盘 —— 一次截断/占用/写满就变成永久丢失。
// 与表情库、黑话库一样走「只读不写」降级：保留原文件，等人来处理。
let stateWritable = true;
// @bridge-function loadState from state-files
// @bridge-function saveState from state-files

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），
// 否则接管。进程退出/崩溃后锁自动失效（PID 校验）。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');

/**
 * 控制台端口是否已被占用 —— 用来判断「是不是真的还有一个桥接在跑」。
 *
 * 为什么需要它：锁文件只存了 PID，而 Windows 会回收 PID。`process.kill(pid, 0)` 成功
 * 只能证明「有进程占着这个号」，EPERM 更是连这一点都证明不了（受保护进程）。
 * 但桥接一定绑定控制台端口（绑不上会自己 exit 2），所以端口占用是一个可靠的判据。
 * 同步探测一次，只在启动期的可疑分支里跑，不影响正常运行。
 */
// @bridge-function consolePortInUse from process-lock

/**
 * 控制台端口当前被哪个 PID 占用（Windows 用 netstat -ano 解析，其它平台用 ss -ltnp）。
 * 探测不出来返回 null —— 调用方必须按「无法证明」处理，不能当成「没人占用」。
 */
// @bridge-function consolePortOwnerPid from process-lock

/** bridge.log 多久没更新（毫秒）。文件不存在 → Infinity（视为早已静止）。 */
// @bridge-function bridgeLogIdleMs from process-lock

/**
 * 控制台 HTTP 是否还应答（用于判断僵死）。返回 true 应答 / false 不应答 / null 探测不出来。
 * 只要有 HTTP 状态码回来（401 未授权也算）就证明进程活着、事件循环在转 ——
 * 桥接在安静的时候本来就不写日志，不能拿日志新鲜度当唯一判据。
 */
// @bridge-function consoleProbeResponsive from process-lock

/**
 * 终止指定 PID 并等控制台端口释放（最多 timeoutMs）。
 * 只在「已确认该 PID 持有控制台端口」时调用 —— 宁可留下一个需要人工处理的进程，
 * 也不误杀一个只是占用了同号 PID 的无关程序。
 */
// @bridge-function terminatePidAndWait from process-lock

// @bridge-function acquireLock from process-lock
// @bridge-function releaseLock from process-lock

// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）

/** 单条日志的最大长度：一条异常巨大的错误对象不能把整个日志文件变成 5MB。 */
const LOG_LINE_MAX = 1000;

/**
 * 带行数上限的追加写日志。
 *
 * 为什么不能「append 之后再读回整个文件数行数」：那样每写一行都要同步读一遍整个文件，
 * 到上限后还要整文件重写一次。实测 bridge.log 到了 2000 行（约 200KB）时，
 * 单次 log() 要 17ms 左右，而每条 QQ 消息会打 2~4 条日志 —— 每条消息白扔几十毫秒的
 * 事件循环。这里改成**内存计数器**：只在启动时数一次，之后 O(1) 追加，
 * 到上限才轮转，轮转用 rename 到 `.1`（不是整文件重写，也不会写坏）。
 */
// @bridge-function createCappedLogger from message-format

/** 本地时间 HH:MM:SS。此前用的是 toISOString()，写进日志的是 UTC，和本地时间差 8 小时。 */
// @bridge-function localClock from message-format

const appendBridgeLog = createCappedLogger(BRIDGE_LOG, 2000);

// @bridge-function log from message-format
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;
// DSH 控制类调用（停任务/归档会话）的超时。这些 await 以前是裸的：DSH 接受了连接但
// 不返回响应时，HTTP handler 永不返回，控制台与群消息一起失去响应（issue #32）。
// 超时后走各自的 catch 记日志，最坏情况只是「这一次重置没做成」，而不是整体挂死。
const DSH_CONTROL_TIMEOUT_MS = 15000;
// @bridge-function withTimeout from message-format

// @bridge-function segmentsToText from message-format

/**
 * 媒体摘要（QQ 表情的 `summary`）会进入模型上下文、也会被拼进「[表情:…]」这类单行标注。
 * 压掉换行/控制字符并限长：否则一条群消息可以用摘要里的换行伪造出新的提示词段落。
 */
// @bridge-function sanitizeMediaSummary from message-format

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
//
// 字段必须尽量保留：SnowLuma 收到的 QQ 表情包（收藏/市场表情）是 **image 段 +
// emoji_id/emoji_package_id/key/url**（实测：sub_type 可能是 0，靠 emoji_id 区分），
// 部分网关实现则用 mface 段。以前只留 file/url/subType/summary，emoji 字段被丢掉，
// 一旦 get_image 取不到（市场表情不在网关缓存里），就再也没有其它可用的兜底地址。
// @bridge-function extractMediaFromSegments from message-format

// @bridge-function allowed from message-format

// 二代会话 key 规范化：只接受 group:正整数 / private:正整数，并去掉前导零，避免同一会话出现多个别名。
// @bridge-function canonicalV2Key from message-format

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// state/ 的 ACL 是否已收紧（hardenStateDirAcl 的结果；控制台「访问与安全」页会显示，
// 未收紧时给出可复制的提权命令）。null = 还没跑/平台不适用。
let stateDirHardened = null;

// D45 上下文预算的扫描参数：访问器表（get CONTEXT_BUDGET_*）与周期扫描都用它，
// 拆出 main() 后放模块作用域，取值与拆分前完全一致。
const CONTEXT_BUDGET_TTL_MS = 60 * 1000;
const CONTEXT_BUDGET_TIMEOUT_MS = 5000;
const CONTEXT_BUDGET_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const CONTEXT_BUDGET_SWEEP_EVERY_N_TURNS = 10;

// ── 主流程 ──────────────────────────────────────────────────────────────────
// runtimeBindings 的访问器表与 wiring 拆出 main()（D64 入口瘦身）：
// 每条访问器都在调用时实时读 states/wired/live，而不是创建时快照，
// 所以配置热更新、运行期计数替换、bot 重连替换都仍然立刻可见。
function createRuntimeBindings(states, wired, live) {
  const bindings = {};
  for (const part of [bindingsPart1, bindingsPart2, bindingsPart3, bindingsPart4]) Object.defineProperties(bindings, Object.getOwnPropertyDescriptors(part(states, wired, live)));
  // 回收站自动清理挂在档案清理的每日调度点上（file-archive-runtime.runArchiveCleanupNow 调它）。
  // 这里用闭包捕获 bindings：bindingsPart* 是模块作用域函数，那里没有 runtimeBindings 变量。
  Object.defineProperty(bindings, 'archiveTrashAutoPurge', { get: () => (trigger) => libtrAutoPurge(bindings, { trigger }) });
  // 身份锁：把「允许用哪个 QQ 号说话」钉死在配置里（src/safety/identity-lock.js）。
  // live.identityLock 是同一个对象引用（原地 Object.assign 更新），所以 outbound 侧拿到的是活状态。
  Object.defineProperty(bindings, 'identityLock', { get: () => live?.identityLock ?? null });
  Object.defineProperty(bindings, 'requiredBotSelfId', { value: REQUIRED_BOT_SELF_ID });
  // 所有最终出站出口都调用这个实时闭包，不能在排队时捕获一次后沿用旧身份。
  Object.defineProperty(bindings, 'assertIdentitySendAllowed', { value: () => assertIdentitySendAllowed(live?.identityLock) });
  Object.defineProperty(bindings, 'assertFreshIdentitySendAllowed', { value: () => live?.assertFreshIdentitySendAllowed?.() ?? Promise.reject(new Error('发送已取消：SnowLuma 身份复核未接线')) });
  Object.defineProperty(bindings, 'assertFreshHttpIdentitySendAllowed', { value: () => live?.assertFreshHttpIdentitySendAllowed?.() ?? Promise.reject(new Error('发送已取消：SnowLuma HTTP 身份复核未接线')) });
  Object.defineProperty(bindings, 'assertIdentityReconnectAllowed', { value: () => live?.assertIdentityReconnectAllowed?.() ?? Promise.reject(new Error('连接已取消：SnowLuma 身份复核未接线')) });
  Object.defineProperty(bindings, 'verifyConnectedIdentity', { value: () => live?.verifyConnectedIdentity?.() ?? Promise.reject(new Error('连接已取消：WebSocket 身份复核未接线')) });
  Object.defineProperty(bindings, 'assertDiscoveredIdentityAllowed', { value: (candidate) => live?.assertDiscoveredIdentityAllowed?.(candidate) ?? Promise.reject(new Error('恢复连接已取消：发现账号身份复核未接线')) });
  Object.defineProperty(bindings, 'applyIdentityCheck', { get: () => live?.applyIdentityCheck ?? null });
  return bindings;
}

// OCR 的 PowerShell 调用：20s 超时、失败只回对象（bridge 不因 OCR 挂掉）。
function runPowerShell(command, args, timeoutMs) {
  return new Promise((resolve) => {
    (0, execFile)(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) { resolve({ ok: false, error: String(stderr || error.message || error), stdout: String(stdout || '') }); return; }
      resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function bindingsPart1(states, wired, live) {
  return {
    get AbortSignal() { return AbortSignal; }, set AbortSignal(value) { AbortSignal = value; },
    get aiBlacklist() { return wired.aiBlacklist; },
    get aiBlacklistAdmin() { return wired.aiBlacklistAdmin; },
    get aiBlacklistCheck() { return wired.aiBlacklistCheck; },
    // D73：私聊管理命令的判定/执行（纯逻辑在 src/ai-command.js，写盘仍走 aiBlacklistAdmin）
    get isAiBlacklistCommand() { return isAiBlacklistCommand; },
    get runAiBlacklistCommand() { return runAiBlacklistCommand; },
    get accrueUsage() { return accrueUsage; },
    get acknowledgeMessagesV2() { return wired.acknowledgeMessagesV2; },
    get ACTIVE_WAIT_LEASE_MS() { return states.stRuntime.ACTIVE_WAIT_LEASE_MS; },
    get activeModelOverride() { return states.stConsoleSend.activeModelOverride; }, set activeModelOverride(value) { states.stConsoleSend.activeModelOverride = value; },
    get activeWaits() { return states.stRuntime.activeWaits; },
    get ACTIVITY_LOG() { return ACTIVITY_LOG; },
    // OCR（截图导入）要用：PowerShell 执行器 + Buffer（解探活小图）。这两个原本只在 sharedBindings，
    // 没进 runtimeBindings → createLibraryOcr 拿不到，探活就会一直回「这台机器没有可用的 OCR 语言包」。
    get runPowerShell() { return runPowerShell; },
    get Buffer() { return Buffer; },
    get addSharedEvent() { return addSharedEvent; },
    get adminCmdLast() { return states.stPeakArchive.adminCmdLast; },
    get AFFINITY_FILE() { return states.stRuntime.AFFINITY_FILE; },
    get affinityAsked() { return states.stRuntime.affinityAsked; },
    get affinityLoad() { return wired.affinityLoad; },
    get affinityNoteInbound() { return wired.affinityNoteInbound; },
    get affinityOn() { return wired.affinityOn; },
    get affinityPromptBlock() { return wired.affinityPromptBlock; },
    get affinitySaveTimer() { return states.stRuntime.affinitySaveTimer; }, set affinitySaveTimer(value) { states.stRuntime.affinitySaveTimer = value; },
    get affinityShift() { return wired.affinityShift; },
    get affinityStore() { return states.stRuntime.affinityStore; }, set affinityStore(value) { states.stRuntime.affinityStore = value; },
    get allocateArchiveTarget() { return allocateArchiveTarget; },
    get allowed() { return allowed; },
    get allowSlangSubmit() { return wired.allowSlangSubmit; },
    get api() { return states.stMediaVoice.api; },
    get appendActivity() { return appendActivity; },
    get appendFeedbackEntry() { return wired.appendFeedbackEntry; },
    get appendMemoryV2() { return wired.appendMemoryV2; },
    get appendPersonaGuide() { return appendPersonaGuide; },
    get appendRecentMessage() { return wired.appendRecentMessage; },
    get appendSocialV2Message() { return wired.appendSocialV2Message; },
    get appendSocialV2Poke() { return wired.appendSocialV2Poke; },
    get appendSummary() { return wired.appendSummary; },
    get appendToolLog() { return wired.appendToolLog; },
    get appendToolLogFile() { return states.stSocialWake.appendToolLogFile; },
    get appliedModelBySession() { return states.stConsoleSend.appliedModelBySession; },
    get applyImpressionEdit() { return applyImpressionEdit; },
    get applyInbound() { return applyInbound; },
    get applyModelScope() { return applyModelScope; },
    get applyObserveLearning() { return applyObserveLearning; },
    get applyPenalty() { return applyPenalty; },
    get applyRoleInjectLimit() { return applyRoleInjectLimit; },
    get applyStickerNote() { return applyStickerNote; },
    get applyStickerNoteV2() { return wired.applyStickerNoteV2; },
    get APPROVE_WORDS() { return APPROVE_WORDS; },
    get ARCHIVE_CLASSIFY_SESSION_FILE() { return states.stPeakArchive.ARCHIVE_CLASSIFY_SESSION_FILE; },
    get ARCHIVE_DAYS() { return states.stConfig.ARCHIVE_DAYS; },
    get ARCHIVE_DIR() { return states.stConfig.ARCHIVE_DIR; },
    get ARCHIVE_EXCLUDED_KINDS() { return ARCHIVE_EXCLUDED_KINDS; },
    get ARCHIVE_EXTENSIONS() { return ARCHIVE_EXTENSIONS; },
    get ARCHIVE_IMAGE_EXTENSIONS() { return ARCHIVE_IMAGE_EXTENSIONS; }, get ARCHIVE_RULE_EXTENSIONS() { return ARCHIVE_RULE_EXTENSIONS; },
    get ARCHIVE_RECALL_LIMIT() { return states.stConfig.ARCHIVE_RECALL_LIMIT; },
    get archiveAppend() { return wired.archiveAppend; },
    get archiveCfgFor() { return wired.archiveCfgFor; },
    get archiveChatFileSegments() { return archiveChatFileSegments; },
    get archiveClassifySessionId() { return states.stPeakArchive.archiveClassifySessionId; }, set archiveClassifySessionId(value) { states.stPeakArchive.archiveClassifySessionId = value; },
    get archiveCleanupTimer() { return states.stPeakArchive.archiveCleanupTimer; }, set archiveCleanupTimer(value) { states.stPeakArchive.archiveCleanupTimer = value; },
    get archiveDirRel() { return archiveDirRel; },
    get archiveFactsByKey() { return states.stMediaVoice.archiveFactsByKey; },
    get archiveFileFor() { return wired.archiveFileFor; },
    get archiveGate() { return wired.archiveGate; }, get archiveGateReason() { return wired.archiveGateReason; },
    get archiveImageAttachment() { return archiveImageAttachment; },
    get archiveMediaAttachment() { return wired.archiveMediaAttachment; },
    get archiveNextRunAt() { return wired.archiveNextRunAt; },
    get archiveRecall() { return wired.archiveRecall; },
    get archiveRowsToCsv() { return archiveRowsToCsv; },
    get archiveSkipLoggedAt() { return states.stConsoleSend.archiveSkipLoggedAt; },
    get archiveStats() { return archiveStats; },
    get archiveWritable() { return states.stConfig.archiveWritable; }, set archiveWritable(value) { states.stConfig.archiveWritable = value; },
    get armPendingWakeLease() { return wired.armPendingWakeLease; },
    get assertGroupMember() { return wired.assertGroupMember; },
    get atomicWriteJson() { return atomicWriteJson; },
    get atomicWriteText() { return atomicWriteText; },
    get AUDIO_EXTS() { return AUDIO_EXTS; },
    get auditAndSend() { return wired.auditAndSend; },
    get autoVoiceSentAt() { return states.stMediaVoice.autoVoiceSentAt; },
    get autoVoiceSeq() { return states.stMediaVoice.autoVoiceSeq; }, set autoVoiceSeq(value) { states.stMediaVoice.autoVoiceSeq = value; },
    get AVAILABLE_MODELS_TTL_MS() { return states.stModelSession.AVAILABLE_MODELS_TTL_MS; },
    get availableModelsCache() { return states.stModelSession.availableModelsCache; }, set availableModelsCache(value) { states.stModelSession.availableModelsCache = value; },
    get backfillStickerMd5() { return backfillStickerMd5; },
    get backupPresetFile() { return backupPresetFile; },
    get boothCacheDir() { return wired.boothCacheDir; },
    get boothConfig() { return wired.boothConfig; },
    get boothDeps() { return wired.boothDeps; },
    get bot() { return live.bot; },
    get botNicknameCache() { return botNicknameCache; }, set botNicknameCache(value) { botNicknameCache = value; },
    get botSelfIdCache() { return botSelfIdCache; }, set botSelfIdCache(value) { botSelfIdCache = value; },
    get budgetConfig() { return budgetConfig; },
    get budgetRunnerInstance() { return wired.budgetRunnerInstance; },
    get budgetSweepPromise() { return live.budgetSweepPromise; }, set budgetSweepPromise(value) { live.budgetSweepPromise = value; },
    get budgetTickForTurn() { return wired.budgetTickForTurn; },
    get budgetTurnsSinceSweep() { return live.budgetTurnsSinceSweep; }, set budgetTurnsSinceSweep(value) { live.budgetTurnsSinceSweep = value; },
    get buildBatchPrompt() { return wired.buildBatchPrompt; },
    get buildContextBlock() { return wired.buildContextBlock; },
    get buildDigest() { return buildDigest; },
    get buildExtractionPrompt() { return buildExtractionPrompt; },
    get buildHandoffDigest() { return buildHandoffDigest; },
    get buildLibraryItemDetail() { return buildLibraryItemDetail; },
    get buildLibraryItems() { return buildLibraryItems; },
    // dhash 包装只在真桥接里装配（VM 沙箱只抽 @bridge-function 块，取不到就退回裸快照）。
    // 素材库增量扫描（P2）：所有吃快照的地方（素材页/找号/补封面/导出）自动共用同一份
    // state/library-scan-cache.json；不传 fresh 时按目录签名复用认件结果。
    get buildLibrarySnapshot() { return (opts) => buildLibrarySnapshotWithCache({ cacheFile: path.join(STATE_DIR, SCAN_CACHE_FILE), ...(typeof withLibraryDhash === 'function' ? withLibraryDhash(opts) : opts) }); },
    get scanLibraryTree() { return scanLibraryTree; },
    get assetsFromFiles() { return assetsFromFiles; },
    get libraryNotes() { return libraryNotes; },
    get buildLibraryUnclassified() { return buildLibraryUnclassified; },
    get buildLocalMessages() { return buildLocalMessages; },
    get buildPeakMessages() { return buildPeakMessages; },
    get buildPeakRequest() { return buildPeakRequest; },
    get buildProactivePrompt() { return wired.buildProactivePrompt; },
    get buildProbePrompt() { return wired.buildProbePrompt; },
    get buildResearchPrompt() { return buildResearchPrompt; },
    get buildSelfModelPayload() { return buildSelfModelPayload; },
    get buildSharedMemoryLine() { return wired.buildSharedMemoryLine; },
    get buildSlangContext() { return buildSlangContext; },
    get buildStickerContext() { return buildStickerContext; },
    get buildStickerStrategyHint() { return buildStickerStrategyHint; },
    get buildWakePromptV2() { return wired.buildWakePromptV2; },
    get buildWakeReminderPromptV2() { return wired.buildWakeReminderPromptV2; },
    get buildWakeSnapshotV2() { return wired.buildWakeSnapshotV2; },
    get busyReasonV2() { return wired.busyReasonV2; },
    get cancelAllSocialTimers() { return wired.cancelAllSocialTimers; },
    get cancelPendingEntry() { return wired.cancelPendingEntry; },
    get cancelReplyCheckV2() { return wired.cancelReplyCheckV2; },
    get cancelSocialTimers() { return wired.cancelSocialTimers; },
    get canonicalV2Key() { return canonicalV2Key; },
    get canRun() { return canRun; },
    get captureSendGuard() { return wired.captureSendGuard; },
    get cfg() { return states.stConfig.cfg; },
    get chatErrorNotice() { return wired.chatErrorNotice; },
    get checkDiskSpace() { return checkDiskSpace; },
    get checkDsh() { return states.stHealth.checkDsh; },
    get checkModelAgainstList() { return checkModelAgainstList; },
    get clampPreSleepWait() { return clampPreSleepWait; },
    get classifyArchivedFile() { return wired.classifyArchivedFile; },
    get classifyAttachment() { return classifyAttachment; },
    get cleanLocalReply() { return cleanLocalReply; },
    get cleanupSocialForModeChange() { return wired.cleanupSocialForModeChange; },
    get cleanupTemp() { return cleanupTemp; },
    get clearAllPendingWakeLeases() { return wired.clearAllPendingWakeLeases; },
    get clearAllSocialV2Timers() { return wired.clearAllSocialV2Timers; },
    get clearInterval() { return clearInterval; },
    get clearSocialV2Timers() { return wired.clearSocialV2Timers; },
    get clearTimeout() { return clearTimeout; },
    get closedAgentPreset() { return states.stUsage.closedAgentPreset; }, set closedAgentPreset(value) { states.stUsage.closedAgentPreset = value; },
    get collectCatalogModels() { return collectCatalogModels; },
    get collectors() { return states.stRuntime.collectors; },
    get collectSticker() { return collectSticker; },
    get collectStickerV2() { return wired.collectStickerV2; },
    get collectStorageStats() { return collectStorageStats; },
    get compactModelMessage() { return compactModelMessage; },
    get computeGapsV2() { return wired.computeGapsV2; },
    get computeWakeSafetyV2() { return wired.computeWakeSafetyV2; },
    get configReloadCount() { return states.stPeakArchive.configReloadCount; }, set configReloadCount(value) { states.stPeakArchive.configReloadCount = value; },
    get configReloadTimer() { return states.stPeakArchive.configReloadTimer; }, set configReloadTimer(value) { states.stPeakArchive.configReloadTimer = value; },
    get configWatcher() { return states.stPeakArchive.configWatcher; }, set configWatcher(value) { states.stPeakArchive.configWatcher = value; },
    get confirmedSlangListV2() { return wired.confirmedSlangListV2; },
    get console() { return console; }, set console(value) { console = value; },
    get consumePeakQuota() { return consumePeakQuota; },
    get consumePrivateQuota() { return wired.consumePrivateQuota; },
    get CONTEXT_BUDGET_SWEEP_EVERY_N_TURNS() { return CONTEXT_BUDGET_SWEEP_EVERY_N_TURNS; },
    get CONTEXT_BUDGET_TIMEOUT_MS() { return CONTEXT_BUDGET_TIMEOUT_MS; },
    get CONTEXT_BUDGET_TTL_MS() { return CONTEXT_BUDGET_TTL_MS; },
    get CONVERSATION_TOKENS() { return CONVERSATION_TOKENS; },
    get convertHeicToJpeg() { return convertHeicToJpeg; },
    get convKey() { return convKey; },
    get createBudgetRunner() { return createBudgetRunner; },
    get createContextPressureProbe() { return createContextPressureProbe; },
    get createLibraryView() { return createLibraryView; },
    get createLibraryFind() { return createLibraryFind; },
    get createLibraryFindByImage() { return createLibraryFindByImage; },
    get createLibraryDownload() { return createLibraryDownload; },
    get createLibraryExtract() { return createLibraryExtract; },
    get handleConsoleLibraryPurchaseFiles() { return wired.handleConsoleLibraryPurchaseFiles; },
    get handleConsoleLibraryImport() { return wired.handleConsoleLibraryImport; },
    get createLibraryOcr() { return createLibraryOcr; },
    get createLibraryPurchases() { return createLibraryPurchases; },
    get createLibraryPurchasesSync() { return createLibraryPurchasesSync; },
    get createLibraryCollections() { return createLibraryCollections; },
    get createLocalClient() { return createLocalClient; },
    get createSlangEntry() { return createSlangEntry; },
    get createStagedTask() { return createStagedTask; },
    get createTurnCollector() { return createTurnCollector; },
    get crypto() { return crypto; },
    get currentMode() { return states.stUsage.currentMode; }, set currentMode(value) { states.stUsage.currentMode = value; },
    get currentRoleHint() { return wired.currentRoleHint; },
    get currentRoleHintV2() { return wired.currentRoleHintV2; },
    get currentTurnBySession() { return states.stRuntime.currentTurnBySession; },
    get dayKey() { return dayKey; },
    get decideMalformedAction() { return decideMalformedAction; },
    get defaultWakeConfigV2() { return wired.defaultWakeConfigV2; },
    get deliverPrompt() { return wired.deliverPrompt; },
    get describeAge() { return describeAge; },
    get describeArchiveSkip() { return describeArchiveSkip; }, get describeArchiveRules() { return describeArchiveRules; },
    get describeAudio() { return describeAudio; },
    get describeDiskVerdict() { return describeDiskVerdict; },
    get describeForPrompt() { return describeForPrompt; },
    get describeImagegenError() { return describeImagegenError; },
    // 智谱直连识图：给「这轮模型看不了图」的回合兜底（不走 DSH provider，参数自己控，
    // 根因是 DSH 发 thinking:{type} 而 glm-5.3-flash 只认 reasoning_effort，见 src/zhipu-vision.js）。
    get describeImage() { return (args) => describeImageWithZhipu({ ...args, cfg: states.stConfig.cfg }); },
    // 画面记忆：hashImageBuffer 算 dhash；lookup 查表（命中就不识图）；remember 把识图结果存下来。
    get hashImageBuffer() { return (buffer) => dhashFromBufferAsync(buffer); },
    get imageMemoryLookup() { return (hash) => { const im = states.stConfig.cfg?.socialV2?.imageMemory || {}; if (im.enabled === false) return null; return findImageMemory(imageMemoryLoad(), hash, { maxDistance: Number.isFinite(im.maxDistance) ? im.maxDistance : 6 }); }; },
    get imageMemoryRemember() {
      return (hash, desc, kind) => {
        const im = states.stConfig.cfg?.socialV2?.imageMemory || {};
        if (im.enabled === false) return { added: false, updated: false };
        const r = rememberImage(imageMemoryLoad(), { hash, desc, kind }, { maxEntries: Number.isFinite(im.maxEntries) ? im.maxEntries : 5000 });
        if (r.added || r.updated) { imageMemoryCache = r.store; imageMemorySaveSoon(); }
        return r;
      };
    },
    get imageMemoryEnsureSeen() { return (label, prep, kind = 'image') => imageMemoryEnsureSeenImpl(states.stConfig.cfg, label, prep, kind); },
    get nodeExe() { return process.execPath; },
    // 画面记忆统计（给控制台「补描述」卡看进度）：总条数、已有多字描述的条数、按类型分。
    get impressionsLoad() { return impressionsLoad(); },
  get imageMemoryStats() {
      return () => {
        const store = imageMemoryLoad();
        const entries = Array.isArray(store.entries) ? store.entries : [];
        const withDetail = entries.filter((e) => String(e && e.d || '').length >= 80).length;
        const byKind = {};
        for (const e of entries) {
          const k = String((e && e.k) || 'other');
          byKind[k] = (byKind[k] || 0) + 1;
        }
        const im = states.stConfig.cfg?.socialV2?.imageMemory || {};
        return {
          store: { total: entries.length, withDetail, byKind },
          config: { enabled: im.enabled !== false, maxDistance: im.maxDistance ?? 6, maxEntries: im.maxEntries ?? 5000 }
        };
      };
    },
    get describeLocalFallback() { return describeLocalFallback; },
    get describeModels() { return describeModels; },
    get describeObserveConfig() { return describeObserveConfig; },
    get describeObserveStickerSegments() { return describeObserveStickerSegments; },
    get describeSensitiveMatch() { return describeSensitiveMatch; },
    get detectPersonaRequest() { return detectPersonaRequest; },
    get dhashFromBufferAsync() { return dhashFromBufferAsync; },
    get digestCounters() { return states.stRuntime.digestCounters; },
    get digestSnapshot() { return digestSnapshot; },
    get DIRECTION_HINT() { return DIRECTION_HINT; },
    get disarmPendingWakeLease() { return wired.disarmPendingWakeLease; },
    get discoverDshBaseUrl() { return discoverDshBaseUrl; },
    get discoverSnowLumaConnection() { return discoverSnowLumaConnection; },
    get DISK_RESERVE_BYTES() { return DISK_RESERVE_BYTES; },
    get drainAllPromptQueues() { return wired.drainAllPromptQueues; },
    get drainPromptQueue() { return wired.drainPromptQueue; },
    get DSH_CONTROL_TIMEOUT_MS() { return DSH_CONTROL_TIMEOUT_MS; },
    get dshCheckStarted() { return states.stUsage.dshCheckStarted; }, set dshCheckStarted(value) { states.stUsage.dshCheckStarted = value; },
    get dshDefaultPreset() { return states.stUsage.dshDefaultPreset; }, set dshDefaultPreset(value) { states.stUsage.dshDefaultPreset = value; },
    get dshPresetIds() { return states.stUsage.dshPresetIds; }, set dshPresetIds(value) { states.stUsage.dshPresetIds = value; },
    get dshReady() { return states.stUsage.dshReady; }, set dshReady(value) { states.stUsage.dshReady = value; },
    get emptyStore() { return emptyStore; },
    get enqueueForRetry() { return states.stUsage.enqueueForRetry; },
    get enrichArchiveItem() { return enrichArchiveItem; },
    get enrichVideoFile() { return wired.enrichVideoFile; },
    get ensureChatModel() { return wired.ensureChatModel; },
    get ensureFileLedger() { return ensureFileLedger; },
    get ensureGroupFolderName() { return wired.ensureGroupFolderName; },
    get ensurePerson() { return ensurePerson; },
    get ensureSession() { return wired.ensureSession; },
    get ensureSlangLearnerSession() { return wired.ensureSlangLearnerSession; },
    get ensureWakeableV2() { return wired.ensureWakeableV2; },
    get enterActive() { return wired.enterActive; },
    get escapeCqText() { return escapeCqText; },
    get evaluateWakeTriggerV2() { return wired.evaluateWakeTriggerV2; },
    get EXPLICIT_END_RE() { return states.stModelSession.EXPLICIT_END_RE; },
  };
}

function bindingsPart2(states, wired, live) {
  return {
    get exportArchiveRows() { return exportArchiveRows; },
    get externalFailureStreak() { return states.stModelSession.externalFailureStreak; },
    get extractAudioWav() { return extractAudioWav; },
    get extractForwardIds() { return extractForwardIds; },
    get extractFrameGrid() { return extractFrameGrid; },
    get extractMediaFromSegments() { return extractMediaFromSegments; },
    get extractPresetPrefix() { return extractPresetPrefix; },
    get FEEDBACK_FILE() { return FEEDBACK_FILE; },
    get feedbackTimes() { return states.stConfig.feedbackTimes; },
    get feedSlangWindow() { return wired.feedSlangWindow; },
    get fetch() { return fetch; },
    get fetchBoothMeta() { return fetchBoothMeta; },
    get fetchFaceMedia() { return wired.fetchFaceMedia; },
    get fetchMediaData() { return wired.fetchMediaData; },
    get fetchModelCatalog() { return wired.fetchModelCatalog; },
    get fetchOneBotImage() { return wired.fetchOneBotImage; },
    get fileArchiveDb() { return wired.fileArchiveDb; },
    get fileArchiveDeps() { return wired.fileArchiveDeps; },
    get fileArchiveRootDir() { return wired.fileArchiveRootDir; },
    get fileListsFromRows() { return fileListsFromRows; },
    get fileNotifyFromRows() { return fileNotifyFromRows; },
    get filterArchiveRows() { return filterArchiveRows; },
    get findCjkSpaceWarning() { return wired.findCjkSpaceWarning; },
    get findMessageMedia() { return wired.findMessageMedia; },
    get findSplitBoundaryWarning() { return wired.findSplitBoundaryWarning; },
    get findSticker() { return findSticker; },
    get flushSummaries() { return wired.flushSummaries; },
    get forgetAgentToken() { return forgetAgentToken; },
    get formatArchiveBytes() { return formatArchiveBytes; },
    get formatArchiveFactsBlock() { return formatArchiveFactsBlock; },
    get formatCleanupLog() { return formatCleanupLog; },
    get formatForwardResponse() { return formatForwardResponse; },
    get formatGlobalImpressions() { return formatGlobalImpressions; },
    get formatInitialPromptV2() { return wired.formatInitialPromptV2; },
    get formatLeft() { return formatLeft; },
    get formatMemoryV2() { return wired.formatMemoryV2; },
    get formatParticipationV2() { return wired.formatParticipationV2; },
    get formatStickerList() { return formatStickerList; },
    get FRAME_DIR() { return states.stRuntime.FRAME_DIR; },
    get frameRetentionCfg() { return frameRetentionCfg; },
    get freshnessLabel() { return freshnessLabel; },
    get fs() { return fs; },
    get GEN1_ROLE_LINE_RE() { return GEN1_ROLE_LINE_RE; },
    get generateByTier() { return generateByTier; },
    get getBoothCover() { return getBoothCover; },
    get getBoothCoverPath() { return getBoothCoverPath; },
    get getImageCached() { return wired.getImageCached; },
    get getImageDimensions() { return wired.getImageDimensions; },
    get getSocialV2State() { return wired.getSocialV2State; },
    get getStickerImageData() { return wired.getStickerImageData; },
    get GROUP_MEMBER_IDS_TTL_MS() { return states.stSocialWake.GROUP_MEMBER_IDS_TTL_MS; },
    get GROUP_MEMBER_NAME_TTL_MS() { return states.stSocialWake.GROUP_MEMBER_NAME_TTL_MS; },
    get groupMemberCache() { return states.stTimeSense.groupMemberCache; },
    get groupMemberIdsCache() { return states.stSocialWake.groupMemberIdsCache; },
    get groupMemberNameCache() { return states.stSocialWake.groupMemberNameCache; },
    get groupMemberRefreshedAt() { return states.stTimeSense.groupMemberRefreshedAt; }, set groupMemberRefreshedAt(value) { states.stTimeSense.groupMemberRefreshedAt = value; },
    get groupMuteFile() { return states.stPeakArchive.groupMuteFile; },
    get groupMutes() { return states.stPeakArchive.groupMutes; }, set groupMutes(value) { states.stPeakArchive.groupMutes = value; },
    get groupNameCache() { return states.stConsoleSend.groupNameCache; },
    get groupNamesLoaded() { return states.stConsoleSend.groupNamesLoaded; }, set groupNamesLoaded(value) { states.stConsoleSend.groupNamesLoaded = value; },
    get groupRoleCache() { return states.stPeakArchive.groupRoleCache; },
    get hammingDistance() { return hammingDistance; },
    get handleConsoleConfigAdmin() { return wired.handleConsoleConfigAdmin; },
    get handleConsoleAgentProbe() { return wired.handleConsoleAgentProbe; },
    get handleConsoleLocalModel() { return wired.handleConsoleLocalModel; },
    get handleConsoleLocalModelRestart() { return wired.handleConsoleLocalModelRestart; },
    get handleConsoleConversationSend() { return wired.handleConsoleConversationSend; },
    get handleConsoleDraw() { return wired.handleConsoleDraw; },
    get handleConsoleFileLibrary() { return wired.handleConsoleFileLibrary; },
    get handleConsoleJournal() { return wired.handleConsoleJournal; },
    get handleConsoleLists() { return wired.handleConsoleLists; },
    get handleConsoleMediaTools() { return wired.handleConsoleMediaTools; },
    // 工具维度 token 消耗（GET /api/tokens/tools、POST /api/tokens/tools/rebuild）。
    get handleTokensTools() { return wired.handleTokensTools; },
    get handleConsoleMemory() { return wired.handleConsoleMemory; },
    get handleConsoleMessageDetail() { return wired.handleConsoleMessageDetail; },
    get handleConsoleMemberNotes() { return wired.handleConsoleMemberNotes; },
    get handleConsoleModelsAffinity() { return wired.handleConsoleModelsAffinity; },
    get handleConsoleImagegen() { return wired.handleConsoleImagegen; },
    get handleConsoleBudgetAlert() { return wired.handleConsoleBudgetAlert; },
    get handleConsoleLibraryBindIo() { return wired.handleConsoleLibraryBindIo; },
    get handleConsoleLibraryFindByImage() { return wired.handleConsoleLibraryFindByImage; },
    get handleConsoleLibraryFind() { return wired.handleConsoleLibraryFind; },
    get handleConsoleLibraryDownload() { return wired.handleConsoleLibraryDownload; },
    get handleConsoleLibraryExtract() { return wired.handleConsoleLibraryExtract; },
    get handleConsoleLibraryPasswords() { return wired.handleConsoleLibraryPasswords; },
    get handleStickerCacheStatus() { return wired.handleStickerCacheStatus; },
    get handleStickerCacheCleanup() { return wired.handleStickerCacheCleanup; },
    get handleStickerThumbsRepair() { return wired.handleStickerThumbsRepair; },
    get handleStickerUnavailableRemove() { return wired.handleStickerUnavailableRemove; },
    get handleMemewikiStatus() { return wired.handleMemewikiStatus; },
    get handleImageMemoryStatus() { return wired.handleImageMemoryStatus; },
    get handleImageMemoryBackfill() { return wired.handleImageMemoryBackfill; },
    get handleImageMemoryStop() { return wired.handleImageMemoryStop; },
    get handleMemewikiReimport() { return wired.handleMemewikiReimport; },
    get handleConsoleLibraryCovers() { return wired.handleConsoleLibraryCovers; },
    get handleConsoleLibraryUsage() { return wired.handleConsoleLibraryUsage; },
    get handleConsoleLibraryTrash() { return wired.handleConsoleLibraryTrash; },
    get handleConsoleLibraryBatch() { return wired.handleConsoleLibraryBatch; },
    get handleConsoleLibraryRelocate() { return wired.handleConsoleLibraryRelocate; },
    get handleConsoleDesktopClientStatus() { return wired.handleConsoleDesktopClientStatus; }, get handleConsoleDesktopClientCheck() { return wired.handleConsoleDesktopClientCheck; }, get handleConsoleOpenFolder() { return wired.handleConsoleOpenFolder; },
    get handleConsoleLibraryPurchases() { return wired.handleConsoleLibraryPurchases; },
    get handleConsoleLibraryPurchasesSync() { return wired.handleConsoleLibraryPurchasesSync; },
    get handleConsoleLibraryCollections() { return wired.handleConsoleLibraryCollections; },
    get handleConsoleBoothLogin() { return wired.handleConsoleBoothLogin; },
    get handleConsoleOpenUrl() { return wired.handleConsoleOpenUrl; },
    get handleConsoleAiBlacklist() { return wired.handleConsoleAiBlacklist; },
    get handleConsoleOperations() { return wired.handleConsoleOperations; },
    get handleConsolePresets() { return wired.handleConsolePresets; },
    get handleConsoleRoles() { return wired.handleConsoleRoles; },
    get handleConsoleRoleDraft() { return wired.handleConsoleRoleDraft; },
    get handleConsoleSecuritySocial() { return wired.handleConsoleSecuritySocial; },
    get handleConsoleSendReset() { return wired.handleConsoleSendReset; },
    get handleConsoleSessionAdmin() { return wired.handleConsoleSessionAdmin; },
    get handleConsoleSlang() { return wired.handleConsoleSlang; },
    get handleConsoleSlangTools() { return wired.handleConsoleSlangTools; },
    get handleConsoleSocialConfig() { return wired.handleConsoleSocialConfig; },
    get handleConsoleSocialReads() { return wired.handleConsoleSocialReads; },
    get handleConsoleStickersVoices() { return wired.handleConsoleStickersVoices; },
    get handleConsoleToolsGate() { return wired.handleConsoleToolsGate; },
    get handleConsoleWait() { return wired.handleConsoleWait; },
    get handleConsoleWakeControls() { return wired.handleConsoleWakeControls; },
    get handleGroupCommand() { return wired.handleGroupCommand; },
    get handlePendingAnswer() { return wired.handlePendingAnswer; },
    get hardenStateDirAcl() { return hardenStateDirAcl; },
    get http() { return http; },
    get IMAGE_INFO_MAX() { return states.stSocialWake.IMAGE_INFO_MAX; },
    get IMAGE_INFO_TTL_MS() { return states.stSocialWake.IMAGE_INFO_TTL_MS; },
    get imagegenCfg() { return imagegenCfg; },
    get providersView() { return providersView; },
    get applyProviderPatch() { return applyProviderPatch; },
    get keyTail() { return keyTail; },
    get imageInfoCache() { return states.stSocialWake.imageInfoCache; },
    get INITIAL_PROMPTS_FILE() { return INITIAL_PROMPTS_FILE; },
    get initialPromptMaxChars() { return wired.initialPromptMaxChars; },
    get initialPrompts() { return states.stModelSession.initialPrompts; },
    get initialPromptsWritable() { return states.stModelSession.initialPromptsWritable; }, set initialPromptsWritable(value) { states.stModelSession.initialPromptsWritable = value; },
    get inPeakWindow() { return wired.inPeakWindow; },
    get insertMessage() { return insertMessage; },
    get inspectAudio() { return inspectAudio; },
    get installedPresetYaml() { return installedPresetYaml; },
    get invalidateSlangLearnerSession() { return wired.invalidateSlangLearnerSession; },
    get isArchiveFileName() { return isArchiveFileName; },
    get isArchiveGroup() { return isArchiveGroup; },
    get isConversationBusyV2() { return wired.isConversationBusyV2; },
    get isCurrentSession() { return wired.isCurrentSession; },
    get isDirectAddress() { return wired.isDirectAddress; },
    get isDirectedAtAi() { return wired.isDirectedAtAi; },
    get isFreshMediaAt() { return isFreshMediaAt; },
    get isFreshMediaTurn() { return isFreshMediaTurn; },
    get impressionRunner() { return states.impressionRunner; },
    get isGroupMember() { return wired.isGroupMember; },
    get isAiBlacklisted() { return wired.isAiBlacklisted; },
    get isMalformedToolJson() { return isMalformedToolJson; },
    get isModelCapacityError() { return isModelCapacityError; },
    get isModelUnavailableError() { return isModelUnavailableError; },
    get isMustReplyText() { return wired.isMustReplyText; },
    get isObserveGroup() { return isObserveGroup; },
    get isOwnSynthesis() { return isOwnSynthesis; },
    get isPeakToneRisky() { return isPeakToneRisky; },
    get isQuoteTargetSelf() { return wired.isQuoteTargetSelf; },
    get isRecentSynthesis() { return isRecentSynthesis; },
    get isSendToolName() { return isSendToolName; },
    get isSessionAllowedInCurrentMode() { return wired.isSessionAllowedInCurrentMode; },
    get isSilentMarker() { return isSilentMarker; },
    get isSleepingConfigV2() { return wired.isSleepingConfigV2; },
    get isSocialEnabled() { return wired.isSocialEnabled; },
    get isTimerWakeReason() { return wired.isTimerWakeReason; },
    get keyHasRecentMedia() { return wired.keyHasRecentMedia; },
    get KNOWN_AGENT_TOKENS() { return KNOWN_AGENT_TOKENS; },
    get knownPresetName() { return knownPresetName; },
    get knownUnavailableModels() { return states.stRuntime.knownUnavailableModels; },
    get lastArchiveCleanupDay() { return states.stPeakArchive.lastArchiveCleanupDay; }, set lastArchiveCleanupDay(value) { states.stPeakArchive.lastArchiveCleanupDay = value; },
    get lastConfigReloadAt() { return states.stPeakArchive.lastConfigReloadAt; }, set lastConfigReloadAt(value) { states.stPeakArchive.lastConfigReloadAt = value; },
    get lastConfigReloadSkipped() { return states.stPeakArchive.lastConfigReloadSkipped; }, set lastConfigReloadSkipped(value) { states.stPeakArchive.lastConfigReloadSkipped = value; },
    get lastForcedAgentStickerSync() { return states.stConfig.lastForcedAgentStickerSync; }, set lastForcedAgentStickerSync(value) { states.stConfig.lastForcedAgentStickerSync = value; },
    get lastMode() { return states.stUsage.lastMode; }, set lastMode(value) { states.stUsage.lastMode = value; },
    get lastModelFailureNotifyAt() { return states.stConsoleSend.lastModelFailureNotifyAt; }, set lastModelFailureNotifyAt(value) { states.stConsoleSend.lastModelFailureNotifyAt = value; },
    get lastPromptByKey() { return states.stSocialWake.lastPromptByKey; },
    get lastSendFailed() { return states.stConsoleSend.lastSendFailed; },
    get lastSendSucceeded() { return wired.lastSendSucceeded; },
    get learnerCollectors() { return states.stConfig.learnerCollectors; },
    get learnerSessions() { return states.stConfig.learnerSessions; },
    get learnerWaiters() { return states.stConfig.learnerWaiters; },
    get leaveActive() { return wired.leaveActive; },
    get listArchive() { return listArchive; },
    get listAudioFiles() { return listAudioFiles; },
    get listAvailableModels() { return listAvailableModels; },
    get listCommands() { return listCommands; },
    get listForConsole() { return listForConsole; },
    get listPresetBackups() { return listPresetBackups; },
    get loadConfig() { return loadConfig; },
    get loadOrCreateConsoleToken() { return loadOrCreateConsoleToken; },
    get loadOrCreateGuestToken() { return loadOrCreateGuestToken; },
    get handleConsoleGuestAccess() { return wired.handleConsoleGuestAccess; },
    get loadPeople() { return loadPeople; },
    get loadStore() { return loadStore; },
    get localCfgNow() { return wired.localCfgNow; },
    get localClient() { return states.stModelSession.localClient; }, set localClient(value) { states.stModelSession.localClient = value; },
    get localClientNow() { return wired.localClientNow; },
    get localClientSig() { return states.stModelSession.localClientSig; }, set localClientSig(value) { states.stModelSession.localClientSig = value; },
    get localFallbackCfg() { return localFallbackCfg; },
    get localFallbackState() { return states.stModelSession.localFallbackState; }, set localFallbackState(value) { states.stModelSession.localFallbackState = value; },
    get localKeepAliveUntil() { return states.stRuntime.localKeepAliveUntil; }, set localKeepAliveUntil(value) { states.stRuntime.localKeepAliveUntil = value; },
    get log() { return log; },
    get logArchiveSkip() { return wired.logArchiveSkip; },
    get looksLikeImageBuffer() { return looksLikeImageBuffer; }, get matchArchiveRules() { return matchArchiveRules; },
    get looksLikeUnfinished() { return looksLikeUnfinished; },
    get MALFORMED_GIVEUP_TEXT() { return MALFORMED_GIVEUP_TEXT; },
    get malformedRetries() { return states.stRuntime.malformedRetries; },
    get malformedToolJsonCount() { return states.stRuntime.malformedToolJsonCount; }, set malformedToolJsonCount(value) { states.stRuntime.malformedToolJsonCount = value; },
    get manualDirCommand() { return manualDirCommand; },
    get markMediaTurn() { return wired.markMediaTurn; },
    get markReadCalledKeys() { return states.stRuntime.markReadCalledKeys; },
    get markStickerUsed() { return markStickerUsed; },
    get matchAtMention() { return matchAtMention; },
    get matchNameMention() { return matchNameMention; },
    get MAX_DOWNLOAD_BYTES() { return states.stConsoleSend.MAX_DOWNLOAD_BYTES; },
    get MAX_MEDIA_BYTES() { return states.stConsoleSend.MAX_MEDIA_BYTES; },
    get MAX_MEDIA_COUNT() { return states.stConsoleSend.MAX_MEDIA_COUNT; },
    get MAX_MEDIA_PIXELS() { return states.stConsoleSend.MAX_MEDIA_PIXELS; },
    get MAX_MEDIA_STORE_PER_KEY() { return states.stConsoleSend.MAX_MEDIA_STORE_PER_KEY; },
    get maybeCollectSticker() { return wired.maybeCollectSticker; },
    get maybeRefreshDigest() { return wired.maybeRefreshDigest; },
    get md5Hex() { return md5Hex; },
    get mdToPlain() { return mdToPlain; },
    get stripToolCallMarkup() { return toolCallTextPure.stripToolCallMarkup; },
    get mediaHintFor() { return wired.mediaHintFor; },
    get mediaQueue() { return states.stRuntime.mediaQueue; },
    get memberRoleCache() { return states.stPeakArchive.memberRoleCache; },
    get mergeEvidence() { return mergeEvidence; },
    get mergeImpression() { return mergeImpression; },
    get mergeStickerLibrary() { return mergeStickerLibrary; },
    get MESSAGE_DB_FILE() { return states.stConfig.MESSAGE_DB_FILE; },
    get messageDb() { return wired.messageDb; },
    // 控制台会话卡片的「最后一句」：走消息永久库（比内存 recentMessages 新且完整）。
    get latestMessageOf() { return (key) => (wired.messageDb ? latestMessageOfKey(wired.messageDb, key) : null); },
    get messageDbBroken() { return states.stConfig.messageDbBroken; }, set messageDbBroken(value) { states.stConfig.messageDbBroken = value; },
    get messageDbHandle() { return states.stConfig.messageDbHandle; }, set messageDbHandle(value) { states.stConfig.messageDbHandle = value; },
    get messageMediaStore() { return states.stModelSession.messageMediaStore; },
    get messageStats() { return messageStats; },
    get pruneMessages() { return pruneMessages; },
    get migrateImpressions() { return migrateImpressions; },
    get mimeFromBuffer() { return wired.mimeFromBuffer; },
    get mimeFromUrl() { return wired.mimeFromUrl; },
    get modeAllowed() { return wired.modeAllowed; },
    get MODEL_FAILURE_NOTIFY_MS() { return states.stConsoleSend.MODEL_FAILURE_NOTIFY_MS; },
    get MODEL_FALLBACK_LOG_MAX() { return states.stRuntime.MODEL_FALLBACK_LOG_MAX; },
    get modelAppliedSessions() { return states.stConsoleSend.modelAppliedSessions; },
    get modelAutoFallbackLogged() { return states.stRuntime.modelAutoFallbackLogged; },
    get modelCatalogErrorLogged() { return states.stMediaVoice.modelCatalogErrorLogged; },
    get modelCatalogInFlight() { return modelCatalogInFlight; }, set modelCatalogInFlight(value) { modelCatalogInFlight = value; },
    get modelFallbackCount() { return states.stConsoleSend.modelFallbackCount; }, set modelFallbackCount(value) { states.stConsoleSend.modelFallbackCount = value; },
    get modelFallbackSkipLogged() { return states.stRuntime.modelFallbackSkipLogged; },
    get modelMediaLimits() { return states.stConsoleSend.modelMediaLimits; },
    get modelRouteLogged() { return states.stRuntime.modelRouteLogged; }, set modelRouteLogged(value) { states.stRuntime.modelRouteLogged = value; },
    get modelSeesImages() { return wired.modelSeesImages; },
    get modelSelectionEpoch() { return modelSelectionEpoch; }, set modelSelectionEpoch(value) { modelSelectionEpoch = value; },
    get modePreset() { return wired.modePreset; },
    get moveArchiveItemToCategory() { return moveArchiveItemToCategory; },
    get muteUntilOf() { return wired.muteUntilOf; },
    get needsTranslation() { return needsTranslation; },
    get nextAutoVoiceMark() { return nextAutoVoiceMark; },
    get nominalModel() { return states.stUsage.nominalModel; },
  };
}

function bindingsPart3(states, wired, live) {
  return {
    get normalizeBoothConfig() { return normalizeBoothConfig; },
    get normalizeDigests() { return normalizeDigests; },
    get normalizeImageForModel() { return normalizeImageForModel; },
    get normalizeInitialPromptText() { return wired.normalizeInitialPromptText; },
    get normalizeListParams() { return normalizeListParams; }, get normalizeArchiveRules() { return normalizeArchiveRules; }, get normalizeFileArchiveConfig() { return normalizeFileArchiveConfig; },
    get normalizeModeInput() { return normalizeModeInput; },
    get normalizeModelRef() { return normalizeModelRef; },
    get normalizeObserveConfig() { return normalizeObserveConfig; },
    get normalizeOwnerQQ() { return normalizeOwnerQQ; },
    get normalizeReasoningEffort() { return normalizeReasoningEffort; },
    get normalizeRouting() { return normalizeRouting; },
    get normalizeRules() { return normalizeRules; },
    get normalizeSpeakerIdsV2() { return wired.normalizeSpeakerIdsV2; },
    get normalizeThumbnailFile() { return normalizeThumbnailFile; },
    get normalizeThumbWidth() { return normalizeThumbWidth; },
    get noteBounded() { return noteBounded; },
    get noteExternalTurnOk() { return wired.noteExternalTurnOk; },
    get noteMediaTurn() { return noteMediaTurn; },
    get noteModelMessagesV2() { return wired.noteModelMessagesV2; },
    get notePersonaRequest() { return wired.notePersonaRequest; },
    get noteSighting() { return noteSighting; },
    get observeApiView() { return observeApiView; },
    get observeLearnFromGroupMessage() { return wired.observeLearnFromGroupMessage; },
    get observeLoggedAt() { return states.stPeakArchive.observeLoggedAt; },
    get observeShapeLoggedAt() { return states.stPeakArchive.observeShapeLoggedAt; },
    get oneBotAction() { return wired.oneBotAction; },
    get onebotHttpAction() { return wired.onebotHttpAction; },
    get onebotSend() { return wired.onebotSend; },
    get openMessageDb() { return openMessageDb; },
    get orderFallbacksByProvider() { return orderFallbacksByProvider; },
    get os() { return os; },
    get packSessionResets() { return packSessionResets; },
    get pad2() { return states.stTimeSense.pad2; },
    get parseArchiveLines() { return parseArchiveLines; },
    get parseClassifyReply() { return parseClassifyReply; },
    get parseCommand() { return parseCommand; },
    get parseDuration() { return parseDuration; },
    get parseExtractionJson() { return parseExtractionJson; },
    get parsePeakReply() { return parsePeakReply; },
    get parsePersonaRequest() { return parsePersonaRequest; },
    get parseResearchJson() { return parseResearchJson; },
    get parseTargetKey() { return parseTargetKey; },
    get path() { return path; },
    get peakAgentBuckets() { return states.stPeakArchive.peakAgentBuckets; },
    get peakAgentCfg() { return wired.peakAgentCfg; },
    get peakAgentLastAt() { return states.stPeakArchive.peakAgentLastAt; },
    get peakCfg() { return wired.peakCfg; },
    get peakLocalBuckets() { return states.stPeakArchive.peakLocalBuckets; },
    get peakLocalCfg() { return peakLocalCfg; },
    get peakLocalLastAt() { return states.stPeakArchive.peakLocalLastAt; },
    get peakLocalQuota() { return states.stRuntime.peakLocalQuota; },
    get peakLocalRecentTexts() { return states.stPeakArchive.peakLocalRecentTexts; },
    get peakLocalStats() { return states.stPeakArchive.peakLocalStats; },
    get peakPauseActive() { return wired.peakPauseActive; },
    get peakPauseLogged() { return states.stPeakArchive.peakPauseLogged; }, set peakPauseLogged(value) { states.stPeakArchive.peakPauseLogged = value; },
    get peakStatusView() { return wired.peakStatusView; },
    // 系统架构页要的是「真正生效的路由」（modelRouting），不是旧的 peakPause.agent
    get pending() { return states.stConsoleSend.pending; },
    get pendingSendToolCalls() { return states.stRuntime.pendingSendToolCalls; },
    get pendingVideoEnrich() { return states.stRuntime.pendingVideoEnrich; },
    get pendingWakeKeys() { return states.stRuntime.pendingWakeKeys; },
    get pendingWakeLeaseTimers() { return states.stRuntime.pendingWakeLeaseTimers; },
    get PEOPLE_FILE() { return PEOPLE_FILE; },
    get peopleInitDone() { return states.stSocialWake.peopleInitDone; }, set peopleInitDone(value) { states.stSocialWake.peopleInitDone = value; },
    get peopleLogAt() { return states.stSocialWake.peopleLogAt; }, set peopleLogAt(value) { states.stSocialWake.peopleLogAt = value; },
    get peopleNoteInbound() { return wired.peopleNoteInbound; },
    get peopleRecallLine() { return wired.peopleRecallLine; },
    get peopleSavedAt() { return states.stSocialWake.peopleSavedAt; }, set peopleSavedAt(value) { states.stSocialWake.peopleSavedAt = value; },
    get peopleStoreCache() { return states.stSocialWake.peopleStoreCache; }, set peopleStoreCache(value) { states.stSocialWake.peopleStoreCache = value; },
    get persistDshBaseUrl() { return persistDshBaseUrl; },
    get persistMissingStickerThumbs() { return wired.persistMissingStickerThumbs; },
    get persistSnowLumaEndpoint() { return persistSnowLumaEndpoint; },
    get persistStickerThumb() { return persistStickerThumb; },
    get persistToken() { return persistToken; },
    get PERSONA_COOLDOWN_MS() { return PERSONA_COOLDOWN_MS; },
    get PERSONA_GUIDE_TTL_MS() { return PERSONA_GUIDE_TTL_MS; },
    get personaGuideCooldown() { return states.stTimeSense.personaGuideCooldown; },
    get personaGuidePending() { return states.stTimeSense.personaGuidePending; },
    get personaKeyError() { return personaKeyError; },
    get personaMaxChars() { return wired.personaMaxChars; },
    get personaMaxCharsOf() { return personaMaxCharsOf; },
    get personaRequestFingerprint() { return personaRequestFingerprint; },
    get personaSeenRequests() { return states.stTimeSense.personaSeenRequests; },
    get pickDigests() { return pickDigests; },
    get pickUsableModel() { return pickUsableModel; },
    get pickWakeTriggersV2() { return wired.pickWakeTriggersV2; },
    get pinRestartOnlyFields() { return pinRestartOnlyFields; },
    get planCategoryMove() { return planCategoryMove; },
    get planConfigReload() { return planConfigReload; },
    get planFallback() { return planFallback; },
    get planFrameDeletions() { return planFrameDeletions; },
    get planObserveLearning() { return planObserveLearning; },
    get planSocialTimeline() { return wired.planSocialTimeline; },
    get PRESET_BACKUP_DIR() { return PRESET_BACKUP_DIR; },
    get PRESET_NAMES() { return PRESET_NAMES; },
    get presetPromptBlockers() { return presetPromptBlockers; },
    get presetPromptWarnings() { return presetPromptWarnings; },
    get presetSourceYaml() { return presetSourceYaml; },
    get presetStatus() { return presetStatus; },
    get preSleepWaitBlockedV2() { return wired.preSleepWaitBlockedV2; },
    get priceTable() { return states.stUsage.priceTable; },
    get privacyLine() { return privacyLine; },
    get PRIVATE_QUOTA_FILE() { return PRIVATE_QUOTA_FILE; },
    get privateQuotaCfg() { return wired.privateQuotaCfg; },
    get privateTempSession() { return wired.privateTempSession; },
    get probeAvailableModels() { return wired.probeAvailableModels; },
    get probeDuration() { return probeDuration; },
    get processAudioVolume() { return processAudioVolume; },
    get PROMPT_PARTS_SNAPSHOT_MAX() { return PROMPT_PARTS_SNAPSHOT_MAX; },
    get promptPartsSnapshots() { return promptPartsSnapshots; },
    get promptQueues() { return states.stRuntime.promptQueues; },
    get pruneEvents() { return pruneEvents; },
    get pruneGroupMemberNameCache() { return wired.pruneGroupMemberNameCache; },
    get publicSlangEntry() { return wired.publicSlangEntry; },
    get pushArchiveFacts() { return wired.pushArchiveFacts; },
    get QUEUE_HINT_COOLDOWN_MS() { return states.stUsage.QUEUE_HINT_COOLDOWN_MS; },
    get QUEUE_MAX() { return states.stUsage.QUEUE_MAX; },
    get queued() { return states.stUsage.queued; },
    get queuedHintAt() { return states.stUsage.queuedHintAt; },
    get queueSlangTask() { return wired.queueSlangTask; },
    get quotaInfo() { return wired.quotaInfo; },
    get quotaLoad() { return wired.quotaLoad; },
    get quotaState() { return quotaState; },
    get raceWithTimeout() { return raceWithTimeout; },
    get randInt() { return states.stModelSession.randInt; },
    get readActivityTail() { return readActivityTail; },
    get readBodyBounded() { return readBodyBounded; },
    get readConfigObject() { return readConfigObject; },
    get readFeedbackEntries() { return wired.readFeedbackEntries; },
    get readJsonSafe() { return readJsonSafe; },
    get readModelScopes() { return readModelScopes; },
    get readPresetPromptText() { return readPresetPromptText; },
    get readQuota() { return readQuota; },
    get readRoleContent() { return readRoleContent; },
    get readRoleState() { return readRoleState; },
    get readThroughSeqV2() { return wired.readThroughSeqV2; },
    get readToolLog() { return wired.readToolLog; },
    get REASONING_EFFORT_DEFAULT() { return REASONING_EFFORT_DEFAULT; },
    get REASONING_EFFORT_OPTIONS() { return REASONING_EFFORT_OPTIONS; },
    get recallPeople() { return recallPeople; },
    get recentMediaTurns() { return states.stRuntime.recentMediaTurns; },
    // 「模型与高峰」的档位是不是「无」：是就不调模型、机器人不说话。
    modelRoutingMutedNow() {
      try {
        const r = normalizeRouting(cfg.socialV2?.modelRouting);
        const usePeak = typeof wired.peakPauseActive === 'function' ? wired.peakPauseActive() === true : false;
        const ref = usePeak ? r.peak : r.idle;
        return !!(ref && String(ref.provider) === 'none');
      } catch { return false; }
    },
    // 一轮制：图那一轮回完就清标记（map + 会话状态），下一轮立刻回到普通模型。
    clearMediaTurnForSession(sessionId) {
      const key = states.stRuntime.reverse?.get?.(sessionId);
      if (!key) return false;
      try { clearMediaTurn(states.stRuntime.recentMediaTurns, key); } catch {}
      try {
        const st = getSocialV2State(key);
        if (st && st.lastMediaAt) { st.lastMediaAt = 0; saveSocialV2State(key); }
      } catch {}
      return true;
    },
    get recentUserGroup() { return states.stConsoleSend.recentUserGroup; },
    get reconcileSessionPolicies() { return wired.reconcileSessionPolicies; },
    get recordModelFailure() { return wired.recordModelFailure; },
    get recordSentMessagesV2() { return wired.recordSentMessagesV2; },
    get recordSessionSnapshot() { return wired.recordSessionSnapshot; },
    get recordSessionUsage() { return wired.recordSessionUsage; },
    get recordVoiceSentV2() { return wired.recordVoiceSentV2; },
    get redactKnownTokensOnly() { return wired.redactKnownTokensOnly; },
    get redactPii() { return redactPii; },
    get redactSensitiveText() { return redactSensitiveText; },
    get refreshAllDefaultWakeConfigsV2() { return wired.refreshAllDefaultWakeConfigsV2; },
    get registerPending() { return wired.registerPending; },
    get REJECT_WORDS() { return REJECT_WORDS; },
    get releaseLock() { return releaseLock; },
    get reloadConfigFromDisk() { return wired.reloadConfigFromDisk; },
    get RESTART_REQUIRED_PATHS() { return RESTART_REQUIRED_PATHS; },
    get rememberAgentToken() { return rememberAgentToken; },
    get rememberModel() { return wired.rememberModel; },
    get renderDigestBlock() { return renderDigestBlock; },
    get renderPresetPromptYaml() { return renderPresetPromptYaml; },
    get replayPendingWakeReasonsV2() { return wired.replayPendingWakeReasonsV2; },
    get REPLY_INFO_TTL_MS() { return states.stSocialWake.REPLY_INFO_TTL_MS; },
    get REPLY_NEGATIVE_TTL_MS() { return states.stSocialWake.REPLY_NEGATIVE_TTL_MS; },
    get replyInfoCache() { return states.stSocialWake.replyInfoCache; },
    get replyTimingV2() { return wired.replyTimingV2; },
    get requestedReadThroughSeqV2() { return wired.requestedReadThroughSeqV2; },
    get RESEARCH_TURN_TIMEOUT_MS() { return states.stMediaVoice.RESEARCH_TURN_TIMEOUT_MS; },
    get resolveArchiveRoot() { return resolveArchiveRoot; },
    get resolveAudioProcessing() { return resolveAudioProcessing; },
    get resolveAudioSource() { return resolveAudioSource; },
    get resolveFfprobePath() { return resolveFfprobePath; },
    get resolveGroupMemberName() { return wired.resolveGroupMemberName; },
    get resolveMediaList() { return wired.resolveMediaList; },
    get resolveModelChoice() { return resolveModelChoice; },
    get resolvePresetName() { return wired.resolvePresetName; },
    get resolveReplyInfo() { return wired.resolveReplyInfo; },
    get resolveReplyTargetV2() { return wired.resolveReplyTargetV2; },
    get resolveSelfIds() { return resolveSelfIds; },
    get resolveTurnModel() { return resolveTurnModel; },
    get resolveVoicePathForOperator() { return wired.resolveVoicePathForOperator; },
    get resolveVoicePathForV2() { return wired.resolveVoicePathForV2; },
    get retireSession() { return wired.retireSession; },
    get retriedAfterEmpty() { return states.stPeakArchive.retriedAfterEmpty; },
    get retriedAfterFallback() { return states.stSocialWake.retriedAfterFallback; },
    get reverse() { return states.stRuntime.reverse; },
    get ROLE_CONTENT_MAX_BYTES() { return ROLE_CONTENT_MAX_BYTES; },
    get ROLE_NAME_MAX() { return ROLE_NAME_MAX; },
    get ROLE_STATE_FILE() { return ROLE_STATE_FILE; },
    get roleCharStats() { return roleCharStats; },
    get roleFilePath() { return roleFilePath; },
    get roleHintCache() { return states.stSocialWake.roleHintCache; }, set roleHintCache(value) { states.stSocialWake.roleHintCache = value; },
    get roleInjectMaxChars() { return roleInjectMaxChars; }, set roleInjectMaxChars(value) { roleInjectMaxChars = value; },
    get ROLES_DIR() { return ROLES_DIR; },
    get roleSectionReport() { return roleSectionReport; },
    get roleSummaries() { return roleSummaries; },
    get roleWarnings() { return roleWarnings; },
    get ROOT() { return ROOT; },
    get rowsNeedingEnrichment() { return rowsNeedingEnrichment; },
    get runArchiveCleanup() { return runArchiveCleanup; },
    get runArchiveCleanupNow() { return wired.runArchiveCleanupNow; },
    get runSlangExtraction() { return wired.runSlangExtraction; },
    get runSlangResearch() { return wired.runSlangResearch; },
    get safeFetchBinary() { return safeFetchBinary; },
    get safeFetchBuffer() { return safeFetchBuffer; },
    get safeFetchJsonCompat() { return safeFetchJsonCompat; },
    get safeFetchToFile() { return safeFetchToFile; },
    get safeJoinLibrary() { return safeJoinLibrary; },
    get safeResolveInside() { return safeResolveInside; },
    get sanitizeFileName() { return sanitizeFileName; },
    get sanitizeForwardId() { return sanitizeForwardId; },
    // 文件库「在资源管理器里打开」要用；沙箱（bridge-source 剥 import）里可能没有
    get spawn() { return typeof spawn === 'function' ? spawn : null; },
    // BOOTH 登录窗口要分空闲端口（net.listen(0)）；沙箱里 import 被剥掉，用 typeof 兜住。
    get net() { return typeof net === 'object' && net ? net : null; },
    get sanitizeMediaSummary() { return sanitizeMediaSummary; },
    get sanitizeRoleName() { return sanitizeRoleName; },
    get sanitizeToolArgs() { return wired.sanitizeToolArgs; },
    get saveHandoffDigest() { return wired.saveHandoffDigest; },
    get savePeople() { return savePeople; },
    get saveSlang() { return saveSlang; },
    get saveSlangStore() { return wired.saveSlangStore; },
    get saveSocialV2State() { return wired.saveSocialV2State; },
    get saveState() { return saveState; },
    get saveStickerStore() { return saveStickerStore; },
  };
}

function bindingsPart4(states, wired, live) {
  return {
    get saveStickerStoreSafe() { return wired.saveStickerStoreSafe; },
    get saveStore() { return saveStore; },
    get scaleImageBuffer() { return scaleImageBuffer; },
    get scheduleArchiveEnrichment() { return wired.scheduleArchiveEnrichment; },
    get scheduleProactiveCheckV2() { return wired.scheduleProactiveCheckV2; },
    get scheduleMediaFollowup() { return wired.scheduleMediaFollowup; },
    get scheduleReplyCheckV2() { return wired.scheduleReplyCheckV2; },
    get scheduleSocialReply() { return wired.scheduleSocialReply; },
    get scheduleWakeV2() { return wired.scheduleWakeV2; },
    get searchArchive() { return searchArchive; },
    get searchHistory() { return wired.searchHistory; },
    get searchMessages() { return searchMessages; },
    get seenForwardIds() { return states.stModelSession.seenForwardIds; },
    get segmentsToText() { return segmentsToText; },
    get selectEventsForInjection() { return selectEventsForInjection; },
    get selectRoleText() { return selectRoleText; },
    get SELF_MODEL_PROMPT() { return SELF_MODEL_PROMPT; },
    get selfDisplayName() { return states.stModelSession.selfDisplayName; }, set selfDisplayName(value) { states.stModelSession.selfDisplayName = value; },
    get selfIdentityTextV2() { return wired.selfIdentityTextV2; },
    get selfNickname() { return states.stModelSession.selfNickname; }, set selfNickname(value) { states.stModelSession.selfNickname = value; },
    get selfUserId() { return states.stModelSession.selfUserId; }, set selfUserId(value) { states.stModelSession.selfUserId = value; },
    get SEND_TIMEOUT_MS() { return SEND_TIMEOUT_MS; },
    get sendBurstToQQ() { return wired.sendBurstToQQ; },
    get sendChain() { return states.stConsoleSend.sendChain; }, set sendChain(value) { states.stConsoleSend.sendChain = value; },
    get reserveSendSlot() { return states.stConsoleSend.reserveSendSlot; },
    get sendPacingOptions() { return states.stConsoleSend.sendPacingOptions; },
    get sendImageV2() { return wired.sendImageV2; },
    get sendMessagesV2() { return wired.sendMessagesV2; },
    get sendPrivateSafe() { return wired.sendPrivateSafe; },
    get sendPrivateViaTempSession() { return wired.sendPrivateViaTempSession; },
    get sendStickerV2() { return wired.sendStickerV2; },
    get sendToolSucceededSessions() { return states.stRuntime.sendToolSucceededSessions; },
    get sendToQQ() { return wired.sendToQQ; },
    get sendVoiceForV2() { return wired.sendVoiceForV2; },
    get sendVoiceV2() { return wired.sendVoiceV2; },
    get sendWakePromptV2() { return wired.sendWakePromptV2; },
    get SENSITIVE_ARG_KEYS() { return states.stSocialWake.SENSITIVE_ARG_KEYS; },
    get SENSITIVE_RE() { return SENSITIVE_RE; },
    get SESSION_CWD_CHECK_TIMEOUT_MS() { return states.stModelSession.SESSION_CWD_CHECK_TIMEOUT_MS; },
    get SESSION_CWD_CHECK_TTL_MS() { return states.stModelSession.SESSION_CWD_CHECK_TTL_MS; },
    get sessionCwdIndex() { return states.stModelSession.sessionCwdIndex; }, set sessionCwdIndex(value) { states.stModelSession.sessionCwdIndex = value; },
    get sessionCwdIndexPromise() { return states.stModelSession.sessionCwdIndexPromise; }, set sessionCwdIndexPromise(value) { states.stModelSession.sessionCwdIndexPromise = value; },
    get sessionEpoch() { return states.stConsoleSend.sessionEpoch; }, set sessionEpoch(value) { states.stConsoleSend.sessionEpoch = value; },
    get sessionLabel() { return wired.sessionLabel; },
    get sessionLabelsMap() { return wired.sessionLabelsMap; },
    get sessionModels() { return states.stUsage.sessionModels; },
    get makePacingState() { return makePacingState; },
    get readPacingOptions() { return readPacingOptions; },
    get paceSendSlot() { return paceSendSlot; },
    get sessionPolicy() { return wired.sessionPolicy; },
    get sessionPromises() { return states.stRuntime.sessionPromises; },
    get setArchiveCategory() { return setArchiveCategory; },
    get setInitialPrompt() { return wired.setInitialPrompt; },
    get setInterval() { return setInterval; },
    get setStickerRemarkV2() { return wired.setStickerRemarkV2; },
    get setTimeout() { return setTimeout; },
    get settingFromDshNamespace() { return settingFromDshNamespace; },
    get setupSleepTimerV2() { return wired.setupSleepTimerV2; },
    get shiftByModel() { return shiftByModel; },
    get shouldArchiveAttachment() { return shouldArchiveAttachment; },
    get shouldAuditKey() { return wired.shouldAuditKey; },
    get shouldBlockSilentReply() { return wired.shouldBlockSilentReply; },
    get shouldPeakLocal() { return shouldPeakLocal; },
    get shouldRefreshDigest() { return shouldRefreshDigest; },
    get shouldTriggerLocalFallback() { return shouldTriggerLocalFallback; },
    get SILENT_MARKER() { return SILENT_MARKER; },
    get SILENT_TURN_TIMEOUT_MS() { return states.stModelSession.SILENT_TURN_TIMEOUT_MS; },
    get SIMPLE_BOOTH_RE() { return states.stPeakArchive.SIMPLE_BOOTH_RE; },
    get simpleArchiveDir() { return simpleArchiveDir; },
    get simpleBoothId() { return simpleBoothId; },
    get SLANG_FILE() { return SLANG_FILE; },
    get SLANG_MAX_ENTRIES() { return SLANG_MAX_ENTRIES; },
    get SLANG_SESSION_FILE() { return SLANG_SESSION_FILE; },
    get SLANG_STATUS() { return SLANG_STATUS; },
    get slangContentKey() { return slangContentKey; },
    get slangEntries() { return states.stConfig.slangEntries; }, set slangEntries(value) { states.stConfig.slangEntries = value; },
    get slangExtractionCooldowns() { return states.stConfig.slangExtractionCooldowns; },
    get slangLearnerSessionId() { return states.stConfig.slangLearnerSessionId; }, set slangLearnerSessionId(value) { states.stConfig.slangLearnerSessionId = value; },
    get slangResearchingIds() { return states.stConfig.slangResearchingIds; },
    get slangStoreWritable() { return states.stConfig.slangStoreWritable; }, set slangStoreWritable(value) { states.stConfig.slangStoreWritable = value; },
    get slangSubmitTimes() { return states.stConfig.slangSubmitTimes; },
    get slangTaskChain() { return states.stConfig.slangTaskChain; }, set slangTaskChain(value) { states.stConfig.slangTaskChain = value; },
    get slangWindows() { return states.stConfig.slangWindows; },
    get sleep() { return sleep; },
    get sniffHeic() { return sniffHeic; },
    get SNOWLUMA_SILENCE_WARN_MS() { return states.stHealth.SNOWLUMA_SILENCE_WARN_MS; },
    get SNOWLUMA_STATUS_POLL_MS() { return states.stHealth.SNOWLUMA_STATUS_POLL_MS; },
    get snowlumaHealth() { return states.stHealth.snowlumaHealth; },
    get snowlumaHealthSnapshot() { return wired.snowlumaHealthSnapshot; },
    get snowlumaWatchStarted() { return states.stUsage.snowlumaWatchStarted; }, set snowlumaWatchStarted(value) { states.stUsage.snowlumaWatchStarted = value; },
    get social() { return states.stModelSession.social; },
    get SOCIAL_V2_FILE() { return SOCIAL_V2_FILE; },
    get socialState() { return wired.socialState; },
    get socialV2() { return states.stModelSession.socialV2; },
    get sortArchiveRows() { return sortArchiveRows; },
    get SPACE_SPLIT_HINT() { return SPACE_SPLIT_HINT; },
    get splitForQQ() { return splitForQQ; },
    get startConfigWatcher() { return wired.startConfigWatcher; },
    get state() { return state; }, set state(value) { state = value; },
    get STATE_DIR() { return STATE_DIR; },
    // 机器人自检入口（九组只读体检，核心在 src/self-check.js）：控制台「自检」按钮与 POST /api/self-check 用。
    // 用 getter 延迟求值——stConfig.cfg 要到 main() 后半段才就绪，而 runtimeBindings 在更早构建。
    get selfCheckRun() {
      return (opts = {}) => runSelfCheck({
        root: ROOT,
        config: states.stConfig.cfg,
        consolePort: Number(states.stConfig.cfg.consolePort || 3100),
        token: (() => { try { return fs.readFileSync(path.join(STATE_DIR, 'console-token'), 'utf8').trim(); } catch { return ''; } })(),
        ...opts,
      });
    },
    get stateDirHardened() { return stateDirHardened; }, set stateDirHardened(value) { stateDirHardened = value; },
    get STICKER_CACHE_MAX_BYTES() { return states.stPeakArchive.STICKER_CACHE_MAX_BYTES; },
    get STICKER_FILE() { return STICKER_FILE; },
    get STICKER_THUMB_MAX_BYTES() { return states.stPeakArchive.STICKER_THUMB_MAX_BYTES; },
    get stickerCacheBytes() { return stickerCacheBytes; },
    get stickerCachePath() { return stickerCachePath; },
    get readImageMeta() { return readImageMeta; },
    get shouldAutoCollectSticker() { return shouldAutoCollectSticker; },
    get stickerCacheTotalCache() { return states.stPeakArchive.stickerCacheTotalCache; }, set stickerCacheTotalCache(value) { states.stPeakArchive.stickerCacheTotalCache = value; },
    get stickerCacheWarnedAt() { return states.stPeakArchive.stickerCacheWarnedAt; }, set stickerCacheWarnedAt(value) { states.stPeakArchive.stickerCacheWarnedAt = value; },
    get stickerCandidates() { return stickerCandidates; },
    get stickerEnabled() { return wired.stickerEnabled; },
    get stickerEntries() { return states.stConfig.stickerEntries; }, set stickerEntries(value) { states.stConfig.stickerEntries = value; },
    get stickerHashInFlight() { return states.stConfig.stickerHashInFlight; }, set stickerHashInFlight(value) { states.stConfig.stickerHashInFlight = value; },
    get stickerSeenCounts() { return states.stConfig.stickerSeenCounts; },
    get stickerStoreWritable() { return states.stConfig.stickerStoreWritable; }, set stickerStoreWritable(value) { states.stConfig.stickerStoreWritable = value; },
    get stickerSyncedAt() { return states.stConfig.stickerSyncedAt; }, set stickerSyncedAt(value) { states.stConfig.stickerSyncedAt = value; },
    get stopRetiredSessionWork() { return wired.stopRetiredSessionWork; },
    get storeDownloadedFile() { return storeDownloadedFile; },
    get sttInlineWaitMs() { return wired.sttInlineWaitMs; },
    get sttService() { return states.stRuntime.sttService; },
    get suggestQuietMsV2() { return wired.suggestQuietMsV2; },
    get summaryInFlight() { return states.stPeakArchive.summaryInFlight; }, set summaryInFlight(value) { states.stPeakArchive.summaryInFlight = value; },
    get syncStickerLibrary() { return wired.syncStickerLibrary; },
    get synthesizeTts() { return wired.synthesizeTts; },
    get takeHandoffDigest() { return wired.takeHandoffDigest; },
    get text() { return text; },
    // A 方案：唤醒前查本地梗库（见 src/memewiki.js），命中就塞进提示词；查不到也注一句「别编」。
    memeWikiPrelookup(key, st) {
      try {
        const msgs = [...(Array.isArray(st && st.unread) ? st.unread : []), ...(Array.isArray(st && st.recentMessages) ? st.recentMessages : [])];
        return prelookupLine(msgs, this && this.selfUserId);
      } catch { return ''; }
    },
    get tierAskSatisfied() { return tierAskSatisfied; },
    get TIMER_WAKE_REASONS() { return states.stTimeSense.TIMER_WAKE_REASONS; },
    get tokenHealAt() { return live.tokenHealAt; }, set tokenHealAt(value) { live.tokenHealAt = value; },
    get tokenLedger() { return states.stUsage.tokenLedger; },
    get toModelMedia() { return wired.toModelMedia; },
    get TOOL_LOG_FILE() { return TOOL_LOG_FILE; },
    get toolCallNames() { return states.stRuntime.toolCallNames; },
    get translateImagePrompt() { return translateImagePrompt; },
    get triggerActiveDurationExit() { return wired.triggerActiveDurationExit; },
    get truncateText() { return truncateText; },
    get truncateTextTail() { return truncateTextTail; },
    get tryLocalFallback() { return wired.tryLocalFallback; },
    get ttsCfg() { return wired.ttsCfg; },
    get ttsCfgForKey() { return wired.ttsCfgForKey; },
    get ttsHelpers() { return wired.ttsHelpers; },
    get ttsModulePromise() { return states.stMediaVoice.ttsModulePromise; }, set ttsModulePromise(value) { states.stMediaVoice.ttsModulePromise = value; },
    get ttsPromptHint() { return wired.ttsPromptHint; },
    get ttsSync() { return states.stMediaVoice.ttsSync; }, set ttsSync(value) { states.stMediaVoice.ttsSync = value; },
    get TURN_BUSY_LEASE_MS() { return states.stRuntime.TURN_BUSY_LEASE_MS; },
    get turnLastEventAt() { return states.stConsoleSend.turnLastEventAt; },
    get turnLeaseNoted() { return states.stRuntime.turnLeaseNoted; },
    get turnSeqBySession() { return states.stRuntime.turnSeqBySession; },
    get unauthorizedPrivateRepliedAt() { return states.stTimeSense.unauthorizedPrivateRepliedAt; },
    get unpackSessionResets() { return unpackSessionResets; },
    get unquoteJsonString() { return unquoteJsonString; },
    get unwrap() { return unwrap; },
    get updateConfigFile() { return updateConfigFile; },
    get upsertSlangEntry() { return upsertSlangEntry; },
    get URL() { return URL; }, set URL(value) { URL = value; },
    get v2ToolEnabled() { return wired.v2ToolEnabled; },
    get v2TurnStartAt() { return states.stRuntime.v2TurnStartAt; },
    get VALID_MODES() { return VALID_MODES; },
    get validateRoleContent() { return validateRoleContent; },
    get validateRoleName() { return validateRoleName; },
    get verifyVoiceMessageSent() { return wired.verifyVoiceMessageSent; },
    get VIDEO_MAX_BYTES() { return VIDEO_MAX_BYTES; },
    get VIDEO_MAX_SECONDS() { return VIDEO_MAX_SECONDS; },
    get videoFollowUps() { return states.stRuntime.videoFollowUps; },
    get videoFollowUpSent() { return states.stRuntime.videoFollowUpSent; },
    get videoInFlight() { return states.stConfig.videoInFlight; },
    get videoMediaFactText() { return videoMediaFactText; },
    get normalizeVideoRecordMessages() { return normalizeVideoRecordMessages; },
    get VISION_MODELS_DEFAULT() { return states.stRuntime.VISION_MODELS_DEFAULT; },
    get visionModels() { return wired.visionModels; },
    get voiceBudgetCheck() { return wired.voiceBudgetCheck; },
    get voiceBudgetCommit() { return wired.voiceBudgetCommit; },
    get voiceCfg() { return wired.voiceCfg; },
    get voiceDirectiveSend() { return wired.voiceDirectiveSend; },
    get voiceLibrary() { return wired.voiceLibrary; },
    get voiceSendTimes() { return states.stMediaVoice.voiceSendTimes; },
    get waitLearnerTurn() { return wired.waitLearnerTurn; },
    get WAKE_PRIORITY() { return states.stTimeSense.WAKE_PRIORITY; },
    get WAKE_TRIGGER_KEYS() { return states.stModelSession.WAKE_TRIGGER_KEYS; },
    get wakeConfigMissCount() { return states.stRuntime.wakeConfigMissCount; },
    get wakeConfigUpdatedKeys() { return states.stRuntime.wakeConfigUpdatedKeys; },
    get warnedNoVision() { return states.stRuntime.warnedNoVision; }, set warnedNoVision(value) { states.stRuntime.warnedNoVision = value; },
    get warnedPreSleepClamp() { return states.stRuntime.warnedPreSleepClamp; }, set warnedPreSleepClamp(value) { states.stRuntime.warnedPreSleepClamp = value; },
    get whitelistedOnly() { return wired.whitelistedOnly; },
    get withArchiveFactsHint() { return wired.withArchiveFactsHint; },
    get withMemoryContext() { return wired.withMemoryContext; },
    get memoryVector() { return states.memoryVector || null; },
    get withSlangContext() { return wired.withSlangContext; },
    get withTimeout() { return withTimeout; },
    get writeQuota() { return writeQuota; },
    get writeRoleContent() { return writeRoleContent; },
    get writeRoleState() { return writeRoleState; },

  };
}

// 各业务模块的工厂装配：仍然在同一个函数作用域里，所以解构出的名字可以被
// 前面的 getter 表前向引用（TDZ 语义与拆分前一致）。
// 控制台处理器 + 表情缓存/梗库/图片记忆/会话回收/登录自愈的装配：从 wireRuntimeModules 拆出，
// 让两个函数都回到规模红线以下。
function wireRuntimeConsole(runtimeBindings, states) {
    const { handleStickerCacheStatus, handleStickerCacheCleanup, handleStickerThumbsRepair, handleStickerUnavailableRemove } = createStickerCacheOps(runtimeBindings);
  const { handleMemewikiStatus, handleMemewikiReimport } = createMemewiki(runtimeBindings);
  const { handleImageMemoryStatus, handleImageMemoryBackfill, handleImageMemoryStop } = createImageBackfill(runtimeBindings);
    const { sessionRecycleCfg, contextPressureProbeInstance, messagesSinceSessionReset, budgetRunnerInstance, budgetTickForTurn, scheduleBudgetSweep, presetFingerprint, checkPresetFingerprint, sessionRecycleTick } = createSessionRecycle(runtimeBindings);
    const { approveDoubtFriendRequests, applyHealedTokens, syncTokenToFile, healTokenIfStale } = createLoginRecovery(runtimeBindings);
    const { handleConsoleOperations } = createConsoleOperations(runtimeBindings);
    runtimeBindings.buildRoleDraftMessages = buildRoleDraftMessages;
  runtimeBindings.resolveRoleDraft = resolveRoleDraft;
  runtimeBindings.uniqueRoleName = uniqueRoleName;
  // cfg 只在 runtimeBindings 上是实时的（main 作用域里没有裸 cfg 变量），所以包一层取当次配置。
  runtimeBindings.callRoleDraftModel = (messages) => callRoleDraftModel(runtimeBindings.cfg, messages);
  const { handleConsoleRoleDraft } = createConsoleRoleDraft(runtimeBindings);
  const { handleConsoleRoles } = createConsoleRoles(runtimeBindings);
    const { handleConsolePresets } = createConsolePresets(runtimeBindings);
    const { handleConsoleSlang } = createConsoleSlang(runtimeBindings);
    const { handleConsoleSessionAdmin } = createConsoleSessionAdmin(runtimeBindings);
    const { handleConsoleFileLibrary } = createConsoleFileLibrary(runtimeBindings);
    const { handleConsoleSecuritySocial } = createConsoleSecuritySocial(runtimeBindings);
    const { handleConsoleSocialConfig } = createConsoleSocialConfig(runtimeBindings);
    const { handleConsoleSocialReads } = createConsoleSocialReads(runtimeBindings);
    const { sessionLabel, sessionLabelsMap } = createSessionLabels(runtimeBindings);
    const { handleConsoleModelsAffinity } = createConsoleModelsAffinity(runtimeBindings);
    const { handleConsoleImagegen } = createConsoleImagegen(runtimeBindings);
    // 花费预警：每 5 分钟算一次「今天已用 / 外推全天」，命中阈值且过冷却才发管理员私聊。
    // 纯规则（阈值/外推/文案）通过 deps 注入：桥接模块被 vm 裸执行，不能用 import。
    runtimeBindings.budgetAlertPure = { BUDGET_ALERT_DEFAULTS, budgetAlertSettingsOf, evaluateBudgetAlert, formatBudgetAlert, formatBudgetAlertTest, shouldNotifyBudget, budgetLimitOf, budgetProjection };
    const budgetAlert = createBudgetAlert(runtimeBindings);
    const { handleBudgetAlert: handleConsoleBudgetAlert } = budgetAlert;
    budgetAlert.start();   // 巡检每 5 分钟一次；不走 UI 启动，关了浏览器也照样盯
    // 找号/绑定（BOOTH 素材库 P3）：路由器这里建一次。纯规则同样走 deps 注入
    // （桥接模块被 vm 裸执行，不能用 import）。
    runtimeBindings.boothSearchPure = boothSearchPure;
    // 全局 BOOTH 暂停：补封面、已购同步两个 VM 模块都靠 deps.boothPausePure 读/写同一份状态。
    runtimeBindings.boothPausePure = boothPausePure;
    // 补封面要报「共 N 件 / 缺 M 件」，必须和素材页用同一份最终视图（合并/改名/绑定之后），
    // 否则 GET /api/library/covers 写 23 件、列表只有 17 件。library-view 内部函数不能给 VM 模块
    // import，只能在这一层包成 deps.libraryAssetsViewOf 注入。
    runtimeBindings.libraryAssetsViewOf = (opts) => libraryAssetsViewOf(runtimeBindings, opts);
    runtimeBindings.libraryBindsPure = libraryBindsPure;
    // 下载成功后自动认号要用素材库同一套 key 算法（contentKeyFor(主件名, 字节数)）。
    runtimeBindings.contentKeyFor = contentKeyFor;
    runtimeBindings.libraryFindPure = libraryFindPure;
    runtimeBindings.libraryBatchPure = libraryBatchPure;
    // 改名规则（纯函数）同样走 deps.libraryRenamePure：VM 里不能 import，只能注入。
    runtimeBindings.libraryRenamePure = libraryRenamePure;
    // 识别规则（别名表）纯函数：找号扩词与页面别名都读它，同样只能由 deps 注入。
    runtimeBindings.libraryAliasPure = libraryAliasPure;
    // 素材集（套装）纯规则：id 合法化、成员去重、封面/缺失统计都在 src/library-collections.js，
    // VM 模块不能 import，只能在这一层注入。
    runtimeBindings.libraryCollectionsPure = libraryCollectionsPure;
    // AI 黑名单「发送前硬闸」纯判定：conversation-send 是 VM 模块不能 import，
    // 只能在这里注入；判定放纯函数里，发送路由只负责解析引用目标与回话。
    runtimeBindings.aiBlacklistGatePure = aiBlacklistGatePure;
    const { handleConsoleLibraryFind } = createLibraryFind(runtimeBindings);
    // 绑定表导出/导入（换机器不丢人工绑定）：只做 state/booth-binds.json 的读写，
    // 纯规则同样走 deps.libraryBindsPure（上面已经塞好了）。
    const { handleConsoleLibraryBindIo } = createLibraryBindIo(runtimeBindings);
    // 「以图搜源」：素材封面 → BOOTH 候选。纯规则复用 boothSearchPure，暂停闸复用 libraryFindPure
    // （两边共用同一个 state/booth-search-pause.json，被限速时谁都不许再敲）。
    const { handleConsoleLibraryFindByImage } = createLibraryFindByImage(runtimeBindings);
    // 已购/免费下载（P4）：Cookie 存取、清单翻页、断点续传都在 src/booth-download.js，
    // 这里只把它拼成 deps 传进去（模块本身不能 import）。
    runtimeBindings.boothDownloadPure = boothDownloadPure;
    // 解压码自动识别：解压与认号时把名字里的 [解压码: xxx] 认出来并记进密码本。
    // 实例由 manifest 登记的工厂建（审计沙箱也走同一条路，别再顶层 import 命名空间）。
    runtimeBindings.libraryExtractCodePure = createLibraryExtractCode(runtimeBindings);
    // 解压能力（zip 落盘/预览/目录统计）通过 deps 注入：桥接模块被 vm 裸执行，不能用 import。
    runtimeBindings.zipExtractPure = { extractZipToDir, listZipPreview, readZipDirectoryFromFile };
    // 密码本先建：解压实现调用时会经 deps.libraryPasswords 查/记密码（懒初始化，构造期不读 deps）。
    const libPasswords = createLibraryPasswords(runtimeBindings);
    runtimeBindings.libraryPasswords = libPasswords;
    const { handleConsoleLibraryPasswords } = libPasswords;
    const libExtract = createLibraryExtract(runtimeBindings);
    const { handleConsoleLibraryExtract } = libExtract;
    // 下载完自动解压走同一实例（不复制解压逻辑）；实例只做懒初始化，构造期不读 deps。
    runtimeBindings.libraryExtract = libExtract;
    // 文件清单模块先建：下载成功后自动认号/补封面要经 deps.purchaseFiles 调它（不复制规则）。
    const libDownload = createLibraryDownload(runtimeBindings);
    const { handleConsoleLibraryDownload } = libDownload;
    // 对账页的「一键下载」也走同一份下载台账：把入口挂到 deps 上，reconcile 路由直接调。
    runtimeBindings.enqueueReconcileDownload = libDownload.enqueueReconcileDownload;
    // 文件清单/导入工程共用同一个下载入口：单文件入队 + 等它真的下完（串行，不并发打 BOOTH）。
    runtimeBindings.downloadStart = libDownload.startDownload;
    runtimeBindings.waitDownload = libDownload.waitDownload;
    runtimeBindings.matchConfiguredUsageRoot = matchConfiguredUsageRoot;
    runtimeBindings.libraryUsageRootsPure = libraryUsageRootsNs;
    // 工程使用统计的纯函数层与素材侧 GUID 抽取（VM 模块不能 import，只能注入）。
    runtimeBindings.libraryUsagePure = libraryUsageNs;
    runtimeBindings.libraryUsageGuidsPure = libraryUsageGuidsNs;
    const libPurchaseFiles = createLibraryPurchaseFiles(runtimeBindings);
    const { handleConsoleLibraryPurchaseFiles } = libPurchaseFiles;
    runtimeBindings.purchaseFiles = libPurchaseFiles;
    const { handleConsoleLibraryImport } = createLibraryImport(runtimeBindings);
    const { handleConsoleLibraryCovers } = createLibraryCovers(runtimeBindings);
    const { handleConsoleLibraryUsage } = createLibraryUsage(runtimeBindings);
    const { handleConsoleLibraryTrash } = createLibraryTrash(runtimeBindings);
    // 批量操作：merge 规则走 deps.libraryMergePure，trash 走 deps.libtrTrashKeys
    //（VM 里 import 被剥掉，只能在这里把真实实现塞进 runtimeBindings）。
    runtimeBindings.libraryMergePure = libraryMergePure;
    runtimeBindings.libtrTrashKeys = libtrTrashKeys;
    // 补封面的「包内 preview.png」这一档：解包读图规则由 src/library-package-cover.js 提供。
    runtimeBindings.libraryPackageCoverPure = libraryPackageCoverPure;
    const { handleConsoleLibraryBatch } = createLibraryBatch(runtimeBindings);
    const { handleConsoleLibraryRelocate } = createLibraryRelocate(runtimeBindings); const { handleConsoleDesktopClientStatus, handleConsoleDesktopClientCheck } = createDesktopClient(runtimeBindings); const { handleConsoleOpenFolder } = createOpenFolder(runtimeBindings);
    // 已购库（BOOTH 商品资料库）：解析规则走 deps.boothProductPure（VM 里不能 import）。
    runtimeBindings.boothProductPure = boothProductPure;
    // 截图识别：ocr 模块要 runPowerShell/ROOT/safeResolveInside，台账读写由已购库模块传进去。
    runtimeBindings.libraryOcr = createLibraryOcr(runtimeBindings);
    const { handleConsoleLibraryPurchases } = createLibraryPurchases(runtimeBindings);
    const { handleConsoleLibraryPurchasesSync } = createLibraryPurchasesSync(runtimeBindings);
    // 素材集：name/note/keys 的增删改 + decorate（封面/缺失件）都在纯规则里，这里只装配。
    const { handleConsoleLibraryCollections } = createLibraryCollections(runtimeBindings);
    // BOOTH 登录：开带调试端口的浏览器窗口 → 用户登录 → CDP 抓 Cookie → 验证后写进 Cookie 库（不在这里跑同步）。
    const { handleConsoleBoothLogin } = createBoothLogin(runtimeBindings);
    // 打开链接：URL 校验 + 白名单在模块里，spawn 由 runtimeBindings 提供（审计沙箱里是 null）。
    const { handleConsoleOpenUrl } = createOpenUrl(runtimeBindings);
    const { handleConsoleAiBlacklist } = createConsoleAiBlacklist(runtimeBindings);
    const { handleConsoleWakeControls } = createConsoleWakeControls(runtimeBindings);
    const { handleConsoleConversationSend } = createConsoleConversationSend(runtimeBindings);
    const { handleConsoleMediaTools } = createConsoleMediaTools(runtimeBindings);
    const { handleConsoleDraw } = createConsoleDraw(runtimeBindings);
    const { handleConsoleStickersVoices } = createConsoleStickersVoices(runtimeBindings);
    const { handleConsoleWait } = createConsoleWait(runtimeBindings);
    // 按 provider / 计费口径的纯函数（src/token-providers.js）；journal 只做参数校验与响应。
    runtimeBindings.tokenProvidersPure = tokenProvidersPure;
    const { handleConsoleJournal } = createConsoleJournal(runtimeBindings);
    const { handleConsoleLists } = createConsoleLists(runtimeBindings);
    const { handleConsoleMessageDetail } = createConsoleMessageDetail(runtimeBindings);
    const { handleConsoleMemberNotes } = createConsoleMemberNotes(runtimeBindings);
    // D1：印象归纳的运行器（按钮触发 + 每两天凌晨自动跑）。放这里是因为它在装配阶段只需一次，
    // 而 main() 已经到规模基线；spawn 用 CLI 那条真机验证过的链路，桥接只做单飞/计时/状态。
    // spawn 在审计沙箱里会被剥掉（import 去掉后标识符不存在），所以用 typeof 兜一下：
    // 真运行时是 node 的 spawn；沙箱里拿不到就让运行器回「spawn 不可用」，装配阶段不炸。
    const spawnChild = typeof spawn === 'function' ? spawn : null;
    const runnerProcess = typeof process === 'object' && process ? process : null;
    states.impressionRunner = createImpressionsRunner({
      ROOT, STATE_DIR, fs, path, log: (message) => runtimeBindings.log(message),
      spawn: spawnChild,
      execPath: runnerProcess ? runnerProcess.execPath : 'node',
      env: runnerProcess ? runnerProcess.env : {},
      isPidAlive: (pid) => {
        try { runnerProcess.kill(pid, 0); return true; } catch { return false; }
      }
    });
    states.impressionRunner.startSchedule();
    const { handleConsoleMemory } = createConsoleMemory(runtimeBindings);
    const { handleConsoleSlangTools } = createConsoleSlangTools(runtimeBindings);
    const { handleConsoleSendReset } = createConsoleSendReset(runtimeBindings);
    // 设置页「测试连通」：探活结果留内存给 GET /api/config 的 agent.probeOk（不读磁盘）。
    const agentProbe = createAgentProbe(runtimeBindings);
    runtimeBindings.agentProbeLast = agentProbe.lastProbe;
    const { handleConsoleAgentProbe } = agentProbe;
    // 本地模型控制台：动作全交给 scripts/local-model.mjs（单一实现），模块只做校验/解析/重启。
    const { handleConsoleLocalModel, handleConsoleLocalModelRestart } = createConsoleLocalModel(runtimeBindings);
    const { handleConsoleConfigAdmin } = createConsoleConfigAdmin(runtimeBindings);
    const { handleConsoleToolsGate } = createConsoleToolsGate(runtimeBindings);
    return {
        handleStickerCacheStatus, handleStickerCacheCleanup, handleStickerThumbsRepair, handleStickerUnavailableRemove, handleMemewikiStatus, handleMemewikiReimport, handleImageMemoryStatus, handleImageMemoryBackfill,
        handleImageMemoryStop, sessionRecycleCfg, contextPressureProbeInstance, messagesSinceSessionReset, budgetRunnerInstance, budgetTickForTurn, scheduleBudgetSweep, presetFingerprint,
        checkPresetFingerprint, sessionRecycleTick, approveDoubtFriendRequests, applyHealedTokens, syncTokenToFile, healTokenIfStale, handleConsoleOperations, handleConsoleRoleDraft,
        handleConsoleRoles, handleConsolePresets, handleConsoleSlang, handleConsoleSessionAdmin, handleConsoleFileLibrary, handleConsoleSecuritySocial, handleConsoleSocialConfig, handleConsoleSocialReads,
        sessionLabel, sessionLabelsMap, handleConsoleModelsAffinity, handleConsoleImagegen, handleConsoleBudgetAlert, handleConsoleLibraryFind, handleConsoleLibraryBindIo, handleConsoleLibraryFindByImage,
        handleConsoleLibraryPasswords, handleConsoleLibraryExtract, handleConsoleLibraryDownload, handleConsoleLibraryPurchaseFiles, handleConsoleLibraryImport, handleConsoleLibraryCovers, handleConsoleLibraryUsage, handleConsoleLibraryTrash,
        handleConsoleLibraryBatch, handleConsoleLibraryRelocate, handleConsoleDesktopClientStatus, handleConsoleDesktopClientCheck, handleConsoleOpenFolder, handleConsoleLibraryPurchases, handleConsoleLibraryPurchasesSync, handleConsoleLibraryCollections,
        handleConsoleBoothLogin, handleConsoleOpenUrl, handleConsoleAiBlacklist, handleConsoleWakeControls, handleConsoleConversationSend, handleConsoleMediaTools, handleConsoleDraw, handleConsoleStickersVoices,
        handleConsoleWait, handleConsoleJournal, handleConsoleLists, handleConsoleMessageDetail, handleConsoleMemberNotes, handleConsoleMemory, handleConsoleSlangTools, handleConsoleSendReset,
        handleConsoleAgentProbe, handleConsoleLocalModel, handleConsoleLocalModelRestart, handleConsoleConfigAdmin, handleConsoleToolsGate,
    };
}

function wireRuntimeModules(runtimeBindings, states) {
  // ── 梗库（memewiki）：统计 + 导入到黑话库（数据在 data/memewiki.db）──────
  runtimeBindings.memewikiStatus = () => {
    const dbPath = path.join(ROOT, 'data', 'memewiki.db');
    let dbEntries = 0;
    let dbBytes = 0;
    try {
      dbBytes = fs.statSync(dbPath).size;
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try { dbEntries = Number(db.prepare('SELECT COUNT(*) AS n FROM memes').get()?.n) || 0; }
      finally { db.close(); }
    } catch (error) { log('梗库统计失败:', error?.message ?? error); }
    const entries = states.stConfig.slangEntries || [];
    const imported = entries.filter((e) => e && e.source === 'memewiki');
    return {
      ok: true,
      db: { file: 'data/memewiki.db', entries: dbEntries, bytes: dbBytes },
      inStore: imported.length,
      usable: imported.filter((e) => e.usagePolicy === 'usable').length,
      understandOnly: imported.filter((e) => e.usagePolicy !== 'usable').length,
      total: entries.length,
      spiciness: Number(states.stConfig.cfg?.socialV2?.memeWiki?.spiciness ?? 50)
    };
  };
  runtimeBindings.memewikiReimport = (opts = {}) => {
    const dbPath = path.join(ROOT, 'data', 'memewiki.db');
    if (!fs.existsSync(dbPath)) return { ok: false, error: '缺 data/memewiki.db，先运行 node scripts/fetch-memewiki.mjs' };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let rows = [];
    try { rows = db.prepare('SELECT title, slug, summary, origin, usage, tags FROM memes').all(); }
    finally { db.close(); }
    const entries = states.stConfig.slangEntries || [];
    // 老条目可能在 normalize 丢过 source（历史数据一律被归成 ai）：按标题回填 memewiki 标记。
    const titles = new Set(rows.map((r) => String(r && r.title || '').trim()).filter(Boolean));
    let retagged = 0;
    for (const entry of entries) {
      if (!entry || entry.source === 'memewiki') continue;
      if (titles.has(String(entry.content || '').trim())) { entry.source = 'memewiki'; retagged += 1; }
    }
    // 梗百科词条不再整库灌进 slang.json（8.7MB→0.86MB 冗余教训）：
    // 只回填 source 标记；count=0 的 memewiki 词条剔除（按需查询走 data/memewiki.db 的 lookupMeme），
    // count>0（群内真用过的）保留参与黑话注入。
    const before = entries.length;
    const next = entries.filter((e) => !(e && e.source === 'memewiki' && (Number(e.count) || 0) === 0));
    states.stConfig.slangEntries = next;
    if (next.length !== before) runtimeBindings.saveSlangStore();
    const pruned = before - next.length;
    log(`[梗库] 同步完成：回填 ${retagged} 条 source 标记，剔除 ${pruned} 条从未用过的 memewiki 词条，库里共 ${next.length} 条（梗百科按需查 data/memewiki.db）`);
    return { ok: true, added: 0, retagged, pruned, total: next.length };
  };

  // ①②③ 的纯规则统一走 deps 注入（模块源码将被审计 VM 直接跑，不能写 import）。
  runtimeBindings.pureModePlan = pureModePlan;
  runtimeBindings.applyPureMode = applyPureMode;
  runtimeBindings.parseMentionCommand = parseMentionCommand;
  runtimeBindings.personaUsageHint = personaUsageHint;
  const { archiveFileFor, archiveAppend, messageDb, backfillMessageDb, fixLegacyMessageKeys, searchHistory } = createArchiveHistory(runtimeBindings);
    const { collectByContentHash, enrichVideoFile, maybeCollectSticker, archivePrune, archiveRecall } = createIncomingMedia(runtimeBindings);
    const { stickerEnabled, saveStickerStoreSafe, onebotHttpAction, syncStickerLibrary, listStickersForV2, getStickerImageData } = createStickers(runtimeBindings);
    const { assertOutboundAuditOk, voiceCfg, voiceLibrary, voicePathInsideLibrary, resolveVoicePathForV2, resolveVoicePathForOperator, voiceBudgetCheck, voiceBudgetCommit, sendVoiceV2, recordVoiceSentV2, verifyVoiceMessageSent } = createVoice(runtimeBindings);
    const { ttsHelpers, ttsPromptHint, ttsCfg, ttsCfgForKey, synthesizeLocalTts, synthesizeTts, synthesizeAiVoice, voiceDirectiveSend, sendVoiceForV2 } = createTts(runtimeBindings);
    const { sendStickerV2, applyStickerNoteV2, sendImageV2, setStickerRemarkV2, collectStickerV2 } = createMediaSend(runtimeBindings);
    const { saveSlangStore, queueSlangTask, ensureSlangLearnerSession, invalidateSlangLearnerSession, waitLearnerTurn, runSlangExtraction, runSlangResearch, maybeQueueSlangExtraction, feedSlangWindow, allowSlangSubmit, publicSlangEntry, confirmedSlangListV2, withSlangContext } = createSlangRuntime(runtimeBindings);
    const { pushArchiveFacts, withArchiveFactsHint, withMemoryContext, fetchModelCatalog, maybeRefreshDigest, sttInlineWaitMs, visionModels, modelSeesImages, markMediaTurn } = createContextServices(runtimeBindings);
    const { affinityRules, affinityOn, affinityLoad, affinityPersist, affinitySaveSoon, affinityNoteInbound, affinityNickname, affinityMemories, affinityPromptBlock, affinityAskedFresh, affinityShift } = createAffinityRuntime(runtimeBindings);
    const { pruneVideoFrames, rememberModel, recordSessionUsage, recordSessionSnapshot, rebuildInFlightCollector, armPendingWakeLease, disarmPendingWakeLease, clearAllPendingWakeLeases } = createUsageRuntime(runtimeBindings);
    const { refreshMode, refreshPresetList, whitelistedOnly, modeAllowed, resolvePresetName, modePreset, isSessionAllowedInCurrentMode, sessionPolicy, isCurrentSession, stopRetiredSessionWork, forgetConversationCaches, retireSession, reconcileSessionPolicies } = createSessionPolicy(runtimeBindings);
    const { startDshWatch, noteUpstreamPacket, noteReceiveHealth, snowlumaHealthSnapshot, reportSnowlumaHealth, pollSnowlumaStatus, startSnowlumaWatch, v2ToolEnabled } = createUpstreamHealth(runtimeBindings);
    runtimeBindings.consoleGuestPure = consoleGuestPure;
    // 访客令牌在这里就生成好：console-server（鉴权）与 guest-access（设置页取链接）共用同一个值。
    runtimeBindings.guestToken = loadOrCreateGuestToken();
    const { handleConsoleGuestAccess } = createGuestAccess(runtimeBindings);
    const { startConsoleServer } = createConsoleServer(runtimeBindings);
    const { redactKnownTokensOnly, sendPrivateViaTempSession, sendPrivateSafe, sendToQQ: sendToQQRaw, lastSendSucceeded, singleLineForQQ, splitLongSegment, isCjkChar, splitByCjkSpaces, planSocialTimeline, sendBurstToQQ, onebotSend } = createOutboundText(runtimeBindings);
    // ① 私聊攒句数加好友提示：私聊里只能发文字，表情/图片要先加好友。
    // 攒够 afterMessages 句后在这条消息末尾追一句（不单独多发，避免刷屏），然后按 cooldownMs 冷却。
    // 计数只在内存，重启清零可接受（lead 已确认口径）；群聊不参与。
    const privateHintState = new Map();
    const sendToQQWithPrivateHint = (key, msg) => {
      let out = msg;
      try {
        const original = String(msg ?? '');
        if (String(key).startsWith('private:') && original.trim()) {
          const prev = privateHintState.get(key) || { sentCount: 0, lastHintAt: 0 };
          const now = Date.now();
          const sentCount = prev.sentCount + 1;
          const verdict = shouldAddFriendHint({ sentCount, lastHintAt: prev.lastHintAt, now, cfg: runtimeBindings.cfg?.socialV2?.private?.addFriendHint });
          privateHintState.set(key, nextHintState({ sentCount, lastHintAt: prev.lastHintAt }, now, verdict.hint));
          if (verdict.hint) {
            out = `${original}\n${privateHintText()}`;
            log(`[私聊提示] 已提示加好友 ${key} 第 ${sentCount} 条`);
          }
        }
      } catch (error) { log(`[私聊提示] 判定失败（不影响发送）：${error?.message ?? error}`); }
      // ② 归因兜底（2026-11-02）：发之前粗查「这句话真是这个人说的吗」。只记警告、不改写，
      // 避免把「依，不是嫌我有茶味吗」这类张冠李戴发出去（提示词纪律是第一道，这是第二道）。
      if (runtimeBindings.cfg?.socialV2?.attributionGuard?.enabled !== false) {
        try {
          const st = getSocialV2State(key);
          const verdict = checkAttribution(out, (st && st.recentMessages) || [], { selfName: runtimeBindings.selfDisplayName || '' });
          if (!verdict.ok) log(`[归因] 可疑 ${key}：${describeSuspects(verdict.suspects)}｜${String(out).slice(0, 60)}`);
        } catch (error) { log(`[归因] 校验失败（不影响发送）：${error?.message ?? error}`); }
      }
      return sendToQQRaw(key, out);
    };
    // D67：临时会话兜底（只试最近群一次 / 30 分钟冷却）；放这里是因为要用 onebotSend 发群内提示，且 outbound-text 工厂已到规模闸基线。
    const privateTempSession = createTempSessionFallback({
      // bug 修：原来写 `return cfg`，但 main() 里没有裸 `cfg` 变量（配置在 boot.cfg），会 ReferenceError；改走 runtimeBindings 实时 getter。
      get cfg() { return runtimeBindings.cfg; },
      fetch, AbortSignal, log,
      get recentUserGroup() { return states.stConsoleSend.recentUserGroup; },
      store: privateUnreachable,
      get isGroupMember() { return isGroupMember; },
      get memberGroupOf() { return memberGroupOf; },
      sendGroupHint: (groupId, uid) => onebotSend('group', groupId, TEMP_SESSION_GROUP_HINT, null, uid)
    });
    // D70：AI 黑名单运行期判定 + 控制台写盘器（配置真源 = config.json 的 socialV2.aiBlacklist）。
    const aiBlacklist = createAiBlacklistRuntime({ getConfig: () => runtimeBindings.cfg?.socialV2?.aiBlacklist, log });
    const aiBlacklistAdmin = createAiBlacklistAdmin({
      configFile: path.join(ROOT, 'config.json'),
      getConfig: () => runtimeBindings.cfg?.socialV2?.aiBlacklist,
      writeConfig: (mutate) => updateConfigFile(path.join(ROOT, 'config.json'), mutate, { atomicWrite: atomicWriteJson }),
      fs, path, log
    });
    // 三处唤醒闸（点名类 / 概率类 / 主动检查）统一走这里：命中打一行 [AI黑名单] 并把原因塞进 pendingWakeReasons。
    // 注意：pendingWakeReasons 里的 ai-blacklist:* 只用于事后查，绝不能被 replay 当成待唤醒重放（见 wake-scheduler）。
    function aiBlacklistCheck(key, senderId, trigger) {
      const verdict = aiBlacklist.verdict(key, senderId, trigger);
      if (!verdict.skip) return verdict;
      const who = senderId === undefined || senderId === null || senderId === '' ? '-' : String(senderId);
      log(`[AI黑名单] 跳过 qq=${who} why=${verdict.why}`);
      aiBlacklist.noteSkip();
      try {
        const st = getSocialV2State(key);
        if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
        st.pendingWakeReasons.push({ reason: `ai-blacklist:${verdict.why}`, seq: st.lastUnreadSeq || 0 });
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      } catch {}
      return verdict;
    }
    function isAiBlacklisted(key, senderId) { return aiBlacklist.isAiBlacklisted(key, senderId); }
    const { mimeFromBuffer, mimeFromUrl, getImageDimensions, base64FromMaybe, toModelMedia, isSafeLocalMediaPath, isProbablySafeImageFileRef, emojiCdnCandidates, emojiIdFromFileName, acceptImageBuffer, fetchOneBotImage, fetchFaceMedia } = createMediaInput(runtimeBindings);
    const { groupNameStatePath, loadGroupNamesOnce, saveGroupNames, ensureGroupFolderName, archiveCfgFor, archiveMediaAttachment, logArchiveSkip } = createAttachmentArchive(runtimeBindings);
    const { resolveMediaList, fetchMediaData, mediaHintFor, findMessageMedia } = createMediaResolution(runtimeBindings);
    const { clampGapV2, computeGapsV2, applyPersonaGuideToMessages, sendMessagesV2, shouldAuditKey, captureSendGuard, shouldBlockSilentReply, auditAndSend } = createOutboundPolicy(runtimeBindings);
    const { chatErrorNotice, chatSafeReason, recordModelFailure, localCfgNow, localClientNow, noteExternalTurnOk, tryLocalFallback, probeAvailableModels, notifyModelAutoFallback, keyHasRecentMedia, ensureChatModel } = createModelSelection(runtimeBindings);
    const { refreshSessionCwdIndex, sessionWorkspaceGone, ensureSession } = createSessionRuntime(runtimeBindings);
    const { normalizeSpeakerIdsV2, pickWakeTriggersV2, defaultWakeConfigV2, refreshDefaultWakeConfigV2, refreshAllDefaultWakeConfigsV2, hasExplicitEndV2, isSleepingConfigV2, preSleepWaitBlockedV2, computeWakeSafetyV2, ensureWakeableV2, getSocialV2State, saveHandoffDigest, takeHandoffDigest, pruneHeavyMedia, loadMemoryLayers, loadSocialV2State, saveSocialV2State } = createWakeState(runtimeBindings);
    const { initialPromptMaxChars, personaMaxChars, normalizeInitialPromptText, loadInitialPrompts, saveInitialPrompts, getInitialPrompt, setInitialPrompt, formatInitialPromptV2 } = createInitialPrompts(runtimeBindings);
    const { formatParticipationV2, suggestQuietMsV2, buildSharedMemoryLine, formatMemoryV2, appendMemoryV2 } = createMemoryPrompt(runtimeBindings);
    const { isSocialEnabled, socialState, isDirectAddress, isDirectedAtAi, isMustReplyText, appendRecentMessage, appendSummary, buildContextBlock, enterActive, cancelSocialTimers, cancelAllSocialTimers, cleanupSocialForModeChange, leaveActive, buildBatchPrompt, buildProbePrompt, buildActiveExitPrompt, triggerActiveDurationExit, buildProactivePrompt } = createSocialRuntime(runtimeBindings);
    const { deliverPromptNow, getImageCached, deliverPrompt, processPromptQueue } = createPromptDelivery(runtimeBindings);
    const { scheduleSocialReply, socialLoopTick, startSocialLoop, flushSummaries } = createSocialScheduler(runtimeBindings);
    const { roleRawContent, roleHintForMode, currentRoleHint, isCjkLikeChar, convertExampleSpacesToComma, findCjkSpaceWarning, findSplitBoundaryWarning, currentRoleHintV2 } = createRolePrompts(runtimeBindings);
    const { pruneGroupMemberNameCache, peopleOptions, peopleEnabled, peopleLoad, peopleSaveNow, peopleLedgerName, peopleEnsureReady, peopleNoteInbound, peopleImpressionsFor, peopleRecallLine } = createPeopleRuntime(runtimeBindings);
    const { assertGroupMember, resolveGroupMemberName, pruneReplyInfoCache, resolveReplyInfo, resolveReplyTargetV2, isQuoteTargetSelf } = createReplyResolution(runtimeBindings);
    const { appendSocialV2Message, appendSocialV2Poke, recordSentMessagesV2 } = createMessageState(runtimeBindings);
    const { readFeedbackEntries, appendFeedbackEntry, readToolLog, appendToolLog, redactSensitive, sanitizeToolArgs } = createToolJournal(runtimeBindings);
    const { evaluateWakeTriggerV2, readThroughSeqV2, noteModelMessagesV2, requestedReadThroughSeqV2, acknowledgeMessagesV2 } = createWakeAdmission(runtimeBindings);
    const { localClockText, timeSenseCfg, wakeReasonSeq, findV2MessageBySeq, buildTimeSenseLine, buildWakeSnapshotV2, replyTimingV2, selfIdentityTextV2, personaGuideOnCooldown, notePersonaRequest, notePromptPartsSnapshot, buildWakePromptV2, buildWakeReminderPromptV2 } = createWakePrompts(runtimeBindings);
    const { sendWakePromptV2, scheduleMediaFollowup } = createWakeDispatch(runtimeBindings);
    const { cancelReplyCheckV2, scheduleReplyCheckV2, busyReasonV2, isConversationBusyV2, wakePriorityV2, isTimerWakeReason, scheduleWakeV2, replayPendingWakeReasonsV2, setupSleepTimerV2, cancelProactiveCheckV2, scheduleProactiveCheckV2, clearSocialV2Timers, clearAllSocialV2Timers } = createWakeScheduler(runtimeBindings);
    // 静默观战（偶尔才看一眼群）：状态只在内存里，潜水期只放行「被点名」。
    // 语义与三种触发（点名 / 抬眼 / 定时）见 src/bridge/quiet-watch.js 顶部注释。
    const quietWatch = createQuietWatch({
      getConfig: () => runtimeBindings.cfg,
      log,
      getSocialV2State: (key) => runtimeBindings.getSocialV2State(key),
      scheduleWake: (key, reason) => runtimeBindings.scheduleWakeV2(key, reason),
      setTimeout,
      clearTimeout
    });
    runtimeBindings.quietWatch = quietWatch;
    // 触发判定、调度、发送前复核三处统一从这个名字取闸。
    runtimeBindings.admitWakeV2 = (key, st, reason) => quietWatch.admit(key, st, reason);
    // 发言风格（群成员 vs 客服）：一句话决定「有话才接、接完就收」。
    runtimeBindings.speakingStyle = createSpeakingStyle(runtimeBindings);
    const { drainPromptQueue, drainAllPromptQueues } = createPromptQueues(runtimeBindings);
    const { refreshGroupMembers, isGroupMember, memberGroupOf, privateQuotaCfg, quotaLoad, quotaSave, consumePrivateQuota, quotaInfo } = createPrivateQuotaRuntime(runtimeBindings);
    const { peakCfg, minutesOf, localDateStr, inPeakWindow, peakPauseActive, peakLocalBucket, peakAgentCfg, peakAgentBucket, allowPeakAgent, notePeakAgentReply, peakStatusView, groupMemberRole, botSelfId, warmSelfIdentity, isAddressedToBot, handlePeakLocalReply } = createPeakRuntime(runtimeBindings);
    const { saveGroupMutes, muteUntilOf, setMute, callerTierOf, generatePersonaCard, summarizeGroupWindow, handleGroupCommand } = createGroupCommandsRuntime(runtimeBindings);
    const { handleIncoming } = createIncomingRuntime(runtimeBindings);
    const { cancelPendingEntry, handlePendingAnswer, handlePokeNotice, registerPending } = createPendingInteractions(runtimeBindings);
    // 工具维度 token 归因：均摊规则在 src/token-tools.js（纯函数），账本明细从 tokenLedger 取。
    // 必须在 createMuxRuntime 之前挂到 runtimeBindings 上，pumpMux 的 turn/end 收尾要调 recordTurn。
    runtimeBindings.tokenToolsPure = tokenToolsPure;
    runtimeBindings.tokenLedgerTurnOf = (sessionId, turn) => runtimeBindings.tokenLedger?.turnOf?.(sessionId, turn) ?? null;
    runtimeBindings.tokenLedgerTurnsSince = (fromMs, opts) => runtimeBindings.tokenLedger?.turnsSince?.(fromMs, opts) ?? [];
    const tokenToolsInstance = createTokenTools(runtimeBindings);
    runtimeBindings.tokenTools = tokenToolsInstance;
    const { handleTokensTools } = tokenToolsInstance;
    // mux 的工具日志补 step 用（step/start 里没有 step 字段时退回自增步数）。
    runtimeBindings.muxCurrentStep = muxCurrentStep;
    // P0 agent transport：默认仍走 DSH，但 mux 只认 deps.agentTransport 这一层。
    // VM 里 bridge.js 的 import 会被剥掉，所以用 typeof 守卫（typeof 未声明变量不会抛），
    // 拿不到就留 null，mux 自动回退旧的 deps.api 路径，行为与之前完全一致。
    if (typeof createDshTransport === 'function') {
      runtimeBindings.agentTransport = createDshTransport(runtimeBindings);
      if (typeof registerAgentTransport === 'function') registerAgentTransport('dsh', createDshTransport);
    }
    // P1：openai 兼容端点（默认不启用；只有 cfg.agent.type==='openai' 时才被选中）。
    if (typeof createOpenAiTransport === 'function' && typeof registerAgentTransport === 'function') {
      registerAgentTransport('openai', createOpenAiTransport);
      // 按 cfg.agent.type 懒选（启动时读 cfg 的时序不稳，交给 mux/prompt-delivery 在调用时读）。
      // 复用同一个 transport 实例：它内部持有一个 MCP 子进程（local-tools.js 的 stdio 客户端）。
      // 以前每轮都 createOpenAiTransport(...) → 每轮新 spawn 一个 mcp-snowluma-safe.js 且从不
      // close()，实测一小时能堆十几个孤儿进程（吃内存、拖慢机器）。单例后只留一个。
      let openAiTransportSingleton = null;
      runtimeBindings.agentTransportFor = (type) => {
        if (type !== 'openai' || typeof createOpenAiTransport !== 'function') return runtimeBindings.agentTransport;
        if (!openAiTransportSingleton) openAiTransportSingleton = createOpenAiTransport(runtimeBindings);
        return openAiTransportSingleton;
      };
    }
    // P2：自研 HTTP agent（默认不启用；cfg.agent.type==='http' 时整轮走它）。
    // 它的协议是「桥接执行工具 + POST /tool-result 回填」，capabilities().toolLoop 显式报 'host'，
    // 所以 host 分支与 openai 共用同一条投递链路（prompt-delivery 的 runHostTurn）。
    if (typeof createHttpTransport === 'function' && typeof registerAgentTransport === 'function') {
      registerAgentTransport('http', createHttpTransport);
      const pickHttp = () => (typeof createHttpTransport === 'function' ? createHttpTransport(runtimeBindings) : null);
      const pickPrev = runtimeBindings.agentTransportFor;
      runtimeBindings.agentTransportFor = (type) => (type === 'http' ? pickHttp() : (typeof pickPrev === 'function' ? pickPrev(type) : runtimeBindings.agentTransport));
    }
    // prompt-delivery 用：host 模式判定 + 跑一轮（VM 里 import 被剥，只能从 bindings 取）。
    // http transport 的 host 语义在 capabilities 里，但 agentToolLoopModeOf 读的是 deps.agentTransport
    // （默认 dsh）；这里按 cfg.agent.type 显式把 http 认成 host，免得再动 mux。
    runtimeBindings.agentToolLoopModeOf = () => (runtimeBindings.cfg?.agent?.type === 'http' ? 'host' : agentToolLoopModeOf(runtimeBindings));
    runtimeBindings.runHostTurn = (request) => runHostTurn(runtimeBindings, request);
    const { trackTurnEvent, pumpMux } = createMuxRuntime(runtimeBindings);
    const { fileArchiveDb } = createArchiveRuntime(runtimeBindings);
    const { reloadConfigFromDisk, startTurnWatchdog, startConfigWatcher } = createConfigWatch(runtimeBindings);
    const { fileArchiveRootDir, fileArchiveDeps, boothConfig, boothCacheDir, boothDeps, scheduleArchiveEnrichment, oneBotAction, archiveGate, archiveGateReason, handleGroupFileUpload, ensureArchiveClassifySession, classifyArchivedFile, archiveNextRunAt, runArchiveCleanupNow, startArchiveCleanupLoop } = createFileArchiveRuntime(runtimeBindings);
    runtimeBindings.stickerCachePure = stickerCachePure;
    const { noteObserveActivity, logObserveStickerShapes, stickerCacheDirPath, stickerCacheLimit, stickerCacheTotal, stickerCacheFileList, stickerCachePlan, cleanupStickerCache, persistEntryThumb, persistMissingStickerThumbs, collectObserveSticker, observeLearnFromGroupMessage } = createObserveRuntime(runtimeBindings);
    // 缓存统计/清理/补图三个接口复用 observe-runtime 的实现（VM 里 import 被剥掉，只能从 bindings 取）。
    runtimeBindings.stickerCacheFileList = stickerCacheFileList;
    runtimeBindings.stickerCacheLimit = stickerCacheLimit;
    runtimeBindings.cleanupStickerCache = cleanupStickerCache;
    // persistMissingStickerThumbs 在 runtimeBindings 上已有 getter（:1509，读 wired），不能再赋值。
    const consolePart = wireRuntimeConsole(runtimeBindings, states);
  return {
    archiveFileFor, archiveAppend, messageDb, backfillMessageDb, fixLegacyMessageKeys, searchHistory,
    collectByContentHash, enrichVideoFile, maybeCollectSticker, archivePrune, archiveRecall, stickerEnabled,
    saveStickerStoreSafe, onebotHttpAction, syncStickerLibrary, listStickersForV2, getStickerImageData, assertOutboundAuditOk,
    voiceCfg, voiceLibrary, voicePathInsideLibrary, resolveVoicePathForV2, resolveVoicePathForOperator, voiceBudgetCheck,
    voiceBudgetCommit, sendVoiceV2, recordVoiceSentV2, verifyVoiceMessageSent, ttsHelpers, ttsPromptHint,
    ttsCfg, ttsCfgForKey, synthesizeLocalTts, synthesizeTts, synthesizeAiVoice, voiceDirectiveSend,
    sendVoiceForV2, sendStickerV2, applyStickerNoteV2, sendImageV2, setStickerRemarkV2, collectStickerV2,
    saveSlangStore, queueSlangTask, ensureSlangLearnerSession, invalidateSlangLearnerSession, waitLearnerTurn, runSlangExtraction,
    runSlangResearch, maybeQueueSlangExtraction, feedSlangWindow, allowSlangSubmit, publicSlangEntry, confirmedSlangListV2,
    withSlangContext, pushArchiveFacts, withArchiveFactsHint, withMemoryContext, fetchModelCatalog, maybeRefreshDigest, sttInlineWaitMs,
    visionModels, modelSeesImages, markMediaTurn, affinityRules, affinityOn, affinityLoad,
    affinityPersist, affinitySaveSoon, affinityNoteInbound, affinityNickname, affinityMemories, affinityPromptBlock,
    affinityAskedFresh, affinityShift, pruneVideoFrames, rememberModel, recordSessionUsage, recordSessionSnapshot,
    rebuildInFlightCollector, armPendingWakeLease, disarmPendingWakeLease, clearAllPendingWakeLeases, refreshMode, refreshPresetList,
    whitelistedOnly, modeAllowed, resolvePresetName, modePreset, isSessionAllowedInCurrentMode, sessionPolicy,
    isCurrentSession, stopRetiredSessionWork, forgetConversationCaches, retireSession, reconcileSessionPolicies, startDshWatch,
    noteUpstreamPacket, noteReceiveHealth, snowlumaHealthSnapshot, reportSnowlumaHealth, pollSnowlumaStatus, startSnowlumaWatch,
    v2ToolEnabled, startConsoleServer, redactKnownTokensOnly, sendPrivateViaTempSession, sendPrivateSafe, sendToQQ: sendToQQWithPrivateHint,
    lastSendSucceeded, singleLineForQQ, splitLongSegment, isCjkChar, splitByCjkSpaces, planSocialTimeline,
    sendBurstToQQ, onebotSend, mimeFromBuffer, mimeFromUrl, getImageDimensions, base64FromMaybe,
    toModelMedia, isSafeLocalMediaPath, isProbablySafeImageFileRef, emojiCdnCandidates, emojiIdFromFileName, acceptImageBuffer,
    fetchOneBotImage, fetchFaceMedia, groupNameStatePath, loadGroupNamesOnce, saveGroupNames, ensureGroupFolderName,
    archiveCfgFor, archiveMediaAttachment, logArchiveSkip, resolveMediaList, fetchMediaData, mediaHintFor,
    findMessageMedia, clampGapV2, computeGapsV2, applyPersonaGuideToMessages, sendMessagesV2, shouldAuditKey,
    captureSendGuard, shouldBlockSilentReply, auditAndSend, chatErrorNotice, chatSafeReason, recordModelFailure,
    localCfgNow, localClientNow, noteExternalTurnOk, tryLocalFallback, probeAvailableModels, notifyModelAutoFallback,
    keyHasRecentMedia, ensureChatModel, refreshSessionCwdIndex, sessionWorkspaceGone, ensureSession, normalizeSpeakerIdsV2,
    pickWakeTriggersV2, defaultWakeConfigV2, refreshDefaultWakeConfigV2, refreshAllDefaultWakeConfigsV2, hasExplicitEndV2, isSleepingConfigV2,
    preSleepWaitBlockedV2, computeWakeSafetyV2, ensureWakeableV2, getSocialV2State, saveHandoffDigest, takeHandoffDigest,
    pruneHeavyMedia, loadMemoryLayers, loadSocialV2State, saveSocialV2State, initialPromptMaxChars, personaMaxChars,
    normalizeInitialPromptText, loadInitialPrompts, saveInitialPrompts, getInitialPrompt, setInitialPrompt, formatInitialPromptV2,
    formatParticipationV2, suggestQuietMsV2, buildSharedMemoryLine, formatMemoryV2, appendMemoryV2, isSocialEnabled,
    socialState, isDirectAddress, isDirectedAtAi, isMustReplyText, appendRecentMessage, appendSummary,
    buildContextBlock, enterActive, cancelSocialTimers, cancelAllSocialTimers, cleanupSocialForModeChange, leaveActive,
    buildBatchPrompt, buildProbePrompt, buildActiveExitPrompt, triggerActiveDurationExit, buildProactivePrompt, deliverPromptNow,
    getImageCached, deliverPrompt, processPromptQueue, scheduleSocialReply, socialLoopTick, startSocialLoop,
    flushSummaries, roleRawContent, roleHintForMode, currentRoleHint, isCjkLikeChar, convertExampleSpacesToComma,
    findCjkSpaceWarning, findSplitBoundaryWarning, currentRoleHintV2, pruneGroupMemberNameCache, peopleOptions, peopleEnabled,
    peopleLoad, peopleSaveNow, peopleLedgerName, peopleEnsureReady, peopleNoteInbound, peopleImpressionsFor,
    peopleRecallLine, assertGroupMember, resolveGroupMemberName, pruneReplyInfoCache, resolveReplyInfo, resolveReplyTargetV2,
    isQuoteTargetSelf, appendSocialV2Message, appendSocialV2Poke, recordSentMessagesV2, readFeedbackEntries, appendFeedbackEntry,
    readToolLog, appendToolLog, redactSensitive, sanitizeToolArgs, evaluateWakeTriggerV2, readThroughSeqV2,
    noteModelMessagesV2, requestedReadThroughSeqV2, acknowledgeMessagesV2, localClockText, timeSenseCfg, wakeReasonSeq,
    findV2MessageBySeq, buildTimeSenseLine, buildWakeSnapshotV2, replyTimingV2, selfIdentityTextV2, personaGuideOnCooldown,
    notePersonaRequest, notePromptPartsSnapshot, buildWakePromptV2, buildWakeReminderPromptV2, sendWakePromptV2, scheduleMediaFollowup, cancelReplyCheckV2,
    scheduleReplyCheckV2, busyReasonV2, isConversationBusyV2, wakePriorityV2, isTimerWakeReason, scheduleWakeV2,
    replayPendingWakeReasonsV2, setupSleepTimerV2, cancelProactiveCheckV2, scheduleProactiveCheckV2, clearSocialV2Timers, clearAllSocialV2Timers,
    drainPromptQueue, drainAllPromptQueues, refreshGroupMembers, isGroupMember, privateQuotaCfg, quotaLoad,
    quotaSave, consumePrivateQuota, quotaInfo, peakCfg, minutesOf, localDateStr,
    inPeakWindow, peakPauseActive, peakLocalBucket, peakAgentCfg, peakAgentBucket, allowPeakAgent,
    notePeakAgentReply, peakStatusView, groupMemberRole, botSelfId, warmSelfIdentity, isAddressedToBot,
    handlePeakLocalReply, saveGroupMutes, muteUntilOf, setMute, callerTierOf, generatePersonaCard,
    summarizeGroupWindow, handleGroupCommand, handleIncoming, cancelPendingEntry, handlePendingAnswer, handlePokeNotice,
    registerPending, trackTurnEvent, pumpMux, fileArchiveDb, reloadConfigFromDisk, startTurnWatchdog,
    startConfigWatcher, fileArchiveRootDir, fileArchiveDeps, boothConfig, boothCacheDir, boothDeps,
    scheduleArchiveEnrichment, oneBotAction, archiveGate, archiveGateReason, handleGroupFileUpload, ensureArchiveClassifySession,
    classifyArchivedFile, archiveNextRunAt, runArchiveCleanupNow, startArchiveCleanupLoop, noteObserveActivity, logObserveStickerShapes,
    stickerCacheDirPath, stickerCacheLimit, stickerCacheTotal, persistEntryThumb, persistMissingStickerThumbs, collectObserveSticker,
    observeLearnFromGroupMessage, handleConsoleGuestAccess, handleTokensTools, privateTempSession, aiBlacklist, aiBlacklistAdmin, aiBlacklistCheck, isAiBlacklisted,
    ...consolePart,
  };
}

// 「一句话生成角色卡」的模型调用：借用 peakPause.localModel 那套 OpenAI 兼容配置。
// 失败就抛错 —— 上层（console/role-draft）会回落模板，不让用户对着转圈等。
async function callRoleDraftModel(config, messages) {
  const raw = (config && config.socialV2 && config.socialV2.peakPause && config.socialV2.peakPause.localModel) || {};
  const plc = peakLocalCfg(raw);
  const req = buildPeakRequest({
    cfg: { ...plc, numPredict: 1100, temperature: 0.85, timeoutMs: 30000 },
    messages,
    apiKey: String(raw.apiKey || '') || process.env[plc.apiKeyEnv] || ''
  });
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`模型返回 HTTP ${res.status}`);
  const reply = parsePeakReply(await res.json());
  if (!reply) throw new Error('模型返回了空内容');
  return reply;
}

async function main() {
  // 访问器表由模块级 createRuntimeBindings 构建，getter 仍然实时读 holder，
  // 所以 wiring/阶段完成后再填充也不会变成创建时的快照（配置热更新、计数器替换照旧可见）。
  const states = {}; // 阶段状态（stConfig…stPeakArchive）挂这里，访问器表按需实时读取
  const live = {
    bot: null, tokenHealAt: 0, budgetTurnsSinceSweep: 0, budgetSweepPromise: null,
    // 身份锁（见 src/safety/identity-lock.js）：登录号不在名单里就锁定所有发送。
    identityLock: { enabled: false, ready: false, ok: true, lock: false, mode: 'lock', selfId: '', expected: [], checkedAt: 0, text: '' },
    identityMismatchLatched: false,
  };
  // 配置在 main() 后面才装配好（states.stConfig），所以这里不提前读，等第一次拿到登录信息时再读。
  live.applyIdentityCheck = (login) => {
    const identityCfg = normalizeIdentityConfig(states?.stConfig?.cfg?.identity);
    const result = checkIdentity({
      selfId: login?.user_id ?? login?.userId,
      expectedSelfIds: identityCfg.expectedSelfIds,
      onMismatch: identityCfg.onMismatch,
    });
    const wasLocked = live.identityLock.lock === true;
    Object.assign(live.identityLock, result, {
      enabled: identityCfg.expectedSelfIds.length > 0,
      mode: identityCfg.onMismatch,
      expected: identityCfg.expectedSelfIds.slice(),
      checkedAt: Date.now(),
    });
    if (!result.enabled) return live.identityLock;
    if (result.ready && (!result.ok || result.selfId !== REQUIRED_BOT_SELF_ID)) {
      live.identityMismatchLatched = true;
      log(`[安全] ${describeIdentityLock(live.identityLock)}（SnowLuma 登录号与固定机器人身份不符）`);
      if (result.lock && !wasLocked) log('[安全] 已进入锁定：所有 QQ 发送都会被拦下，不会用错号说话');
    } else if (result.ok && result.selfId === REQUIRED_BOT_SELF_ID) {
      if (wasLocked || live.identityMismatchLatched) log(`[安全] 身份锁解除：QQ ${result.selfId} 在允许名单内`);
      live.identityMismatchLatched = false;
    }
    return live.identityLock;
  };
  live.assertFreshIdentitySendAllowed = () => refreshIdentityForSend({
    getLoginInfo: () => {
      if (!live.bot?.getLoginInfo) throw new Error('SnowLuma getLoginInfo 不可用');
      return live.bot.getLoginInfo();
    },
    applyIdentityCheck: live.applyIdentityCheck,
    getIdentityLock: () => live.identityLock,
    log,
  });
  live.assertFreshHttpIdentitySendAllowed = () => {
    const cfg = states.stConfig?.cfg?.snowluma;
    return refreshHttpIdentityForSend({
      httpUrl: cfg?.httpUrl,
      accessToken: cfg?.accessToken,
      fetch: globalThis.fetch,
      AbortSignal,
      applyIdentityCheck: live.applyIdentityCheck,
      getIdentityLock: () => live.identityLock,
      log,
    });
  };
  live.assertIdentityReconnectAllowed = async () => {
    const cfg = states.stConfig?.cfg;
    const candidate = await discoverSnowLumaConnection({ cfg, timeoutMs: 2500 });
    if (!candidate?.ok) throw new Error(`连接已取消：无法验证 SnowLuma 账号与 WebSocket 映射（${candidate?.error ?? '无候选'}）`);
    await live.assertDiscoveredIdentityAllowed(candidate, { reconnect: true });
    if (!candidate.wsUrl || !candidate.wsToken) throw new Error('连接已取消：固定机器人映射缺少 WebSocket 地址/token');
    // The candidate's local HTTP endpoint has just authenticated the fixed bot; only then align the socket target.
    live.bot.url = candidate.wsUrl;
    live.bot.accessToken = candidate.wsToken;
    assertWebSocketIdentityMapping(candidate, live.bot);
    if (live.identityMismatchLatched) log('[安全] 已验证机器人 WebSocket 映射与目标一致，允许重新连接');
    live.identityMismatchLatched = false;
  };
  live.assertDiscoveredIdentityAllowed = async (candidate, { reconnect = false } = {}) => {
    if (live.identityMismatchLatched && !reconnect) throw new Error('拒绝自愈：当前 WebSocket 曾验证为错误 QQ 账号，需人工确认后重新启动');
    const candidateId = String(candidate?.self?.user_id ?? candidate?.self?.userId ?? '');
    if (candidateId !== REQUIRED_BOT_SELF_ID) throw new Error('拒绝采用其他 QQ 账号的 OneBot token 或端点');
    await refreshHttpIdentityForSend({
      httpUrl: candidate?.baseUrl,
      accessToken: candidate?.token,
      fetch: globalThis.fetch,
      AbortSignal,
      applyIdentityCheck: live.applyIdentityCheck,
      getIdentityLock: () => live.identityLock,
      log,
    });
    live.identityMismatchLatched = false;
  };
  live.verifyConnectedIdentity = async () => {
    const login = await live.assertFreshIdentitySendAllowed();
    if (live.identityMismatchLatched) throw new Error('连接已取消：WebSocket 登录号与固定机器人身份不符');
    return login;
  };
  const wired = {};

  const runtimeBindings = createRuntimeBindings(states, wired, live);
  Object.assign(wired, wireRuntimeModules(runtimeBindings, states));
  // wiring 产物里 main 后续阶段与审计沙箱（在 bot.onPrivateMessage 处提前 return）会用到的名字：
  // 解构到 main 作用域，取值仍然是同一份 live 绑定（等价于拆分前 main 里的同名局部量）。
  const {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue, ensureChatModel,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, getSocialV2State, appendSocialV2Message, recordSentMessagesV2,
    buildWakePromptV2, buildWakeSnapshotV2, sendWakePromptV2, syncStickerLibrary, listStickersForV2, getStickerImageData,
    refreshMode, modeAllowed, trackTurnEvent, replayPendingWakeReasonsV2, setupSleepTimerV2,
    getInitialPrompt, setInitialPrompt, loadInitialPrompts, formatInitialPromptV2, fetchOneBotImage, fetchMediaData, resolveMediaList,
    enrichVideoFile, emojiCdnCandidates, getImageDimensions, acceptImageBuffer, isConversationBusyV2,
    settingFromDshNamespace, selfIdentityTextV2, buildWakeReminderPromptV2, retireSession,
    voiceCfg, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator, voiceBudgetCheck, sendVoiceV2, sendVoiceForV2, assertOutboundAuditOk,
  } = wired;

  // ── D62：装配阶段（src/bridge/boot/）──────────────────────────────────
  // main() 只保留阶段顺序；阶段之间用 getter/setter 相连，配置热更新与运行期计数仍然实时可见。
  const boot = Object.create(runtimeBindings);
  // 工厂/import 级符号（不是运行期状态，不需要 getter，直接给值）：各阶段会用到。
  for (const [name, value] of Object.entries({
    loadState, saveState, acquireLock, releaseLock, loadSlang, loadStickerStore, warmSelfIdentity: wired.warmSelfIdentity,
    NodeApiClient, createFollowUpHub, createMediaQueue, createSttService, transcribeWav, validateModelConfig,
    TOKEN_USAGE_FILE, createTokenLedger, createDshUsageSync, resolvePriceTable, pruneVideoFrames: wired.pruneVideoFrames, maybeQueueSlangExtraction: wired.maybeQueueSlangExtraction,
    pumpMux: wired.pumpMux, refreshMode: wired.refreshMode, refreshPresetList: wired.refreshPresetList, loadInitialPrompts: wired.loadInitialPrompts, loadSocialV2State: wired.loadSocialV2State, startSocialLoop: wired.startSocialLoop, timeSenseCfg: wired.timeSenseCfg,
    loadConfig, hardenStateDirAcl, log, persistCorrectedModel, mediaQueueCfg, createCappedLogger,
  })) {
    // runtimeBindings 上有同名只读 getter，直接赋值会在严格模式下抛错，所以逐个 defineProperty。
    Object.defineProperty(boot, name, { value, writable: true, configurable: true, enumerable: true });
  }
  const attach = (stage) => Object.defineProperties(boot, Object.getOwnPropertyDescriptors(stage));
  const stConfig = states.stConfig = bootConfigState(boot);
  // 启动前身份校验（B）：能确认登录号不对就**拒绝启动**，连「哑巴挂着」都不出现。
  // 查询失败（SnowLuma 没起 / 网关未就绪）不拦启动——那是最常见的正常状态，拦了机器人永远起不来。
  {
    const bootIdentity = normalizeIdentityConfig(stConfig.cfg?.identity);
    if (bootIdentity.expectedSelfIds.length > 0) {
      try {
        const snowUrl = String(stConfig.cfg.snowluma?.httpUrl || '').replace(/\/+$/, '');
        const snowToken = stConfig.cfg.snowluma?.accessToken || '';
        if (snowUrl) {
          const probe = await withTimeout(fetch(`${snowUrl}/get_login_info`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${snowToken}` },
            body: '{}'
          }), 3000, '启动身份校验');
          if (probe.ok) {
            const body = await probe.json().catch(() => null);
            const verdict = checkIdentity({ selfId: body?.data?.user_id ?? body?.user_id, expectedSelfIds: bootIdentity.expectedSelfIds, onMismatch: bootIdentity.onMismatch });
            if (verdict.ready && !verdict.ok) {
              log(`[安全] ${describeIdentityLock({ ...verdict, enabled: true, checkedAt: Date.now() })}`);
              log('[安全] 拒绝启动：SnowLuma 登录的 QQ 不在 identity.expectedSelfIds 名单里。请换回允许的号，或改 config.json 的 identity 段。');
              process.exit(2);
            }
          }
        }
      } catch (error) {
        log(`[安全] 启动前身份校验跳过（网关未就绪）：${error?.message ?? error}`);
      }
    }
  }
  attach(stConfig);
  const stMediaVoice = states.stMediaVoice = await bootMediaVoice(boot);
  attach(stMediaVoice);
  const stRuntime = states.stRuntime = bootRuntimeState(boot);
  attach(stRuntime);
  const stUsage = states.stUsage = bootUsageLedger(boot);
  attach(stUsage);
  const stHealth = states.stHealth = bootUpstreamHealth(boot);
  attach(stHealth);
  const stConsoleSend = states.stConsoleSend = bootConsoleAndSend(boot);
  attach(stConsoleSend);
  const stModelSession = states.stModelSession = bootModelSession(boot);
  attach(stModelSession);
  const stSocialWake = states.stSocialWake = bootSocialWake(boot);
  attach(stSocialWake);
  const stTimeSense = states.stTimeSense = bootTimeSense(boot);
  attach(stTimeSense);
  const stPeakArchive = states.stPeakArchive = bootPeakArchive(boot);
  attach(stPeakArchive);

  await startQqGateway({ states, wired, live, SnowLumaWebSocketClient, createIdentityGuardedBot, assertFreshIdentitySendAllowed: runtimeBindings.assertFreshIdentitySendAllowed, assertIdentityReconnectAllowed: runtimeBindings.assertIdentityReconnectAllowed, verifyConnectedIdentity: runtimeBindings.verifyConnectedIdentity, log, describeObserveConfig, formatArchiveBytes, backfillBoothColumns, rowsNeedingEnrichment });
  await startRecycleLoops({ states, wired, live, CONTEXT_BUDGET_SWEEP_INTERVAL_MS, log, listArchive, planImageBoothBackfill });
  await routeUpstreamHealth({ states, wired, live, log });
  await watchConnection({ states, wired, live, log, path, STATE_DIR, isDuplicateNotice, readNoticeStamp, formatNoticeText, atomicWriteJson, applyIdentityCheck: live.applyIdentityCheck, verifyConnectedIdentity: runtimeBindings.verifyConnectedIdentity });
  // 语义检索（向量）后台索引：默认关闭，config 打开后才跑
  try {
    log('[向量] 初始化开始 enabled=' + String(states.stConfig.cfg?.socialV2?.memory?.vector?.enabled) + ' apiKey=' + Boolean(states.stConfig.cfg?.socialV2?.zhipu?.apiKey) + ' messageDb=' + typeof wired.messageDb);
    const mv = createMemoryVector({ cfg: states.stConfig.cfg, messageDb: wired.messageDb, log });
    states.memoryVector = mv;
    const st = mv.stats();
    if (st.enabled) {
      log(`[向量] 语义检索已启用（${st.model} / ${st.days || 60} 天），已索引 ${st.indexed} 条，待索引 ${st.pending} 条`);
      setTimeout(() => { mv.indexPending().catch(() => {}); }, 20000);
      const timer = setInterval(() => { mv.indexPending().catch(() => {}); }, 300000);
      if (timer.unref) timer.unref();
    }
  } catch (e) {
    log(`[向量] 初始化失败（不影响主流程）：${e && e.message ? e.message : e}`);
  }

  await finishStartup({ states, wired, live, path, STATE_DIR, fs, log, spawn });


  // @bridge-function handleConsoleOperations from console/operations

  // @bridge-function handleConsoleRoleDraft from console/role-draft
  // @bridge-function handleConsoleRoles from console/roles

  // @bridge-function handleConsolePresets from console/presets

  // @bridge-function handleConsoleSlang from console/slang

  // @bridge-function handleConsoleSessionAdmin from console/session-admin

  // @bridge-function handleConsoleFileLibrary from console/file-library

  // @bridge-function handleConsoleSecuritySocial from console/security-social

  // @bridge-function handleConsoleSocialConfig from console/social-config

  // @bridge-function handleConsoleSocialReads from console/social-reads

  // @bridge-function handleConsoleModelsAffinity from console/models-affinity

  // @bridge-function handleConsoleWakeControls from console/wake-controls

  // @bridge-function handleConsoleConversationSend from console/conversation-send

  // @bridge-function handleConsoleMediaTools from console/media-tools

  // @bridge-function handleConsoleDraw from console/draw

  // @bridge-function handleConsoleStickersVoices from console/stickers-voices

  // @bridge-function handleConsoleWait from console/wait

  // @bridge-function handleConsoleJournal from console/journal

  // @bridge-function handleConsoleMessageDetail from console/message-detail

  // @bridge-function handleConsoleMemory from console/memory

  // @bridge-function handleConsoleSlangTools from console/slang-tools

  // @bridge-function handleConsoleSendReset from console/send-reset
}

// 素材卡封面指纹（dHash）：扫描快照是同步构建的，这里只把「查缓存」接进 deps，
// 算力交给后台补算循环（src/library-dhash.js）。挂模块作用域的理由同上：main() 是
// code-size 冻结函数，而 /api/library/assets 只认 deps.buildLibrarySnapshot，
// 不能去改 library-view.js。
const libraryDhash = createLibraryDhash({ stateDir: STATE_DIR, fs, log, writeJson: atomicWriteJson, dhashBuffer: dhashFromBufferAsync });

function libraryDhashBoothCoverRoot() {
  try {
    return path.resolve(ROOT, loadConfig()?.fileArchive?.booth?.cacheDir || 'state/booth-cache');
  } catch {
    return '';
  }
}

// 只读本地缓存里已有的 BOOTH 封面；cloud 卡（远程素材库）在这里拿不到文件就是空，
// 绝不为了一个去重指纹去下载远程图。
function libraryDhashBoothCover(boothId) {
  const id = String(boothId || '');
  if (!/^\d{5,12}$/.test(id)) return '';
  try {
    return getBoothCoverPath(id, { cacheRoot: libraryDhashBoothCoverRoot() }) || '';
  } catch {
    return '';
  }
}

function withLibraryDhash(opts) {
  const base = opts && typeof opts === 'object' ? opts : {};
  return {
    ...base,
    dhashLookup: (card) => libraryDhash.lookup(card, { rootDir: base.rootDir, boothCoverPath: libraryDhashBoothCover })
  };
}

libraryDhash.startLoop({
  getRoot: () => {
    try {
      return resolveArchiveRoot(ROOT, loadConfig()?.fileArchive?.dir);
    } catch {
      return '';
    }
  },
  getCards: (rootDir) => buildLibrarySnapshot({ fs, rootDir }).assets,
  boothCoverPath: libraryDhashBoothCover
});

process.on('SIGINT', () => {
  log('退出中…');
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => {
  // 打出 stack：只记 message 的话，「偶发一次」和「已经坏了六小时」看起来一模一样。
  log('未处理异常:', error?.stack ?? error?.message ?? error);
});
/**
 * 未捕获异常兜底。
 *
 * 为什么必须有：`log()` 是从 SnowLuma SDK 的 socket 事件回调里被调用的，而 SDK 的
 * emitter 逐个调用监听器、不做任何保护。stdout 的读者（守护 cmd 窗口）一旦消失，
 * `console.log` 会抛 EPIPE —— 这个异常会一路穿过 log() → 监听器 → emit → socket 回调，
 * 变成 uncaughtException。没有兜底的话整个 24/7 进程直接死掉且不留堆栈，
 * 在 start.bat 的重启循环里就变成「每 5 秒崩一次」。
 */

// EPIPE 计数：只在退出时落一行，避免逐条刷屏。
let epipeCount = 0;
let epipeNoticeLogged = false;

process.on('uncaughtException', (error) => {
  // EPIPE 不是致命错误：它只说明 stdout 的读者没了（隐藏窗口被关、父 cmd 被杀、
  // 管道另一端退出）。桥接本身仍然健康，杀掉进程只会让 24/7 服务白掉一次。
  // 2026-10-24 02:39 实测：隐藏启动 + 管道断开 → 每次 console.log 抛 EPIPE →
  // 这里 process.exit(1) → 运行 96s 后死亡。现在改为「吞掉、继续跑」。
  //
  // 判定只认 code + syscall，不再用消息文本正则匹配：
  // 旧写法 /\bEPIPE\b|broken pipe/i 会把任何「消息里碰巧带这个词」的异常一起吞掉，
  // 等于把异常分类交给字符串；而 EPIPE 的真实特征就是 code=EPIPE 且 syscall=write。
  if (error?.code === 'EPIPE' && error?.syscall === 'write') {
    epipeCount += 1;
    // 只记第一次：隐藏窗口下每次 console.log 都会抛，逐条记会把日志刷爆，
    // 反而更容易把真正重要的日志挤掉。累计次数由 exit 诊断统一落一行。
    if (epipeCount === 1 && !epipeNoticeLogged) {
      epipeNoticeLogged = true;
      try { log('stdout 管道已断开（EPIPE），后续日志可能丢失；桥接继续运行'); } catch {}
    }
    return;
  }
  const fatalMsg = String(error?.message ?? error);
  if (/write EOF|EPIPE/i.test(fatalMsg)) {
    // 管道关闭不是业务错误：不退出，继续服务（文件日志仍在写）。
    try { log(`[stdio] 忽略管道写失败（不退出）：${fatalMsg}`); } catch {}
    return;
  }
  try { log('致命异常（进程即将退出）:', error?.stack ?? error?.message ?? error); } catch {}
  try { saveState(); } catch {}
  releaseLock();
  process.exit(1);
});
process.on('exit', (code) => {
  // Diagnose silent deaths: when the process is killed from outside (job object teardown,
  // Task Manager, DSH restarting its whole subprocess tree) Node still runs 'exit' but
  // leaves no stack. Recording code + uptime + parent pid separates "killed" from "crashed".
  try {
    const uptimeSec = Math.round(process.uptime());
    const ppid = process.ppid;
    if (epipeCount > 0) {
      log(`进程退出 (exit code=${code}, 运行 ${uptimeSec}s, 父进程 ${ppid}, EPIPE ${epipeCount} 次)`);
    } else {
      log(`进程退出 (exit code=${code}, 运行 ${uptimeSec}s, 父进程 ${ppid})`);
    }
  } catch {}
  releaseLock();
});

// 定时备份 state/*.json（每 2 小时 + 启动补跑，保留策略在模块里）。
// 为什么挂在模块作用域而不是 main() 里：main() 末尾 await pumpMux() 永不返回，没有
// 「启动完成」回调可用；且 main() 是 code-size 冻结函数。桥接启动时这一行必然执行，
// 10s 后才真正跑第一次备份，不占启动高峰。
const stateBackup = createStateBackup({ STATE_DIR, fs, log, path, setInterval, setTimeout });
stateBackup.startStateBackupLoop();

// 日志/数据文件按体积轮转（每小时 + 启动后 10s 补查；阈值/保留份数读 config.json 的 logging.rotate）。
// 同样挂在模块作用域：main() 是 code-size 冻结函数，且轮转不依赖「启动完成」。
const logRotate = createLogRotate({ ROOT, STATE_DIR, fs, log, path, setInterval, setTimeout });
logRotate.startLogRotateLoop();


main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
