// 群文件转存 / 生命周期清理的核心逻辑（纯函数 + SQLite 台账 + 可注入的时钟/文件删除）。
//
// 设计原则：
// 1. **不碰 QQ 侧原文件**：这里只处理我们自己转存到 `state/files` 的副本，delete 只作用于台账里的 rel_path。
// 2. **可测试**：所有时间相关的判断都接收 `nowMs`，清理的删除动作可注入 `removeFile`，不用真等待。
// 3. **单一台账**：文件元数据落在 `state/messages.db` 的 `file_archive` 表（与消息库同库，WAL，
//    不额外多一个 sqlite 文件；storage-stats 的 state/ 目录统计会自动把它算进去）。
//
// 保留期口径（任务书定的）：**未分类 = 60 天，已分类 = 120 天**。「两个月/4 个月」按 30 天/月折算。
// 分类字段非空且不是 `unclassified` 即算「已分类」。

//
// D61：实现已按职责拆到 src/file-archive/（common/paths/db/storage/recycle/media/cleanup），
// 本文件只做装配与再导出——原先 `import ... from './file-archive.js'` 的调用方零改动。

export { DAY_MS, RETENTION_UNCLASSIFIED_DAYS, RETENTION_CLASSIFIED_DAYS, MAX_FILE_MB, DEFAULT_MAX_FILE_MB, IDENTIFY_RULES_VERSION, CATEGORY_RULES_VERSION, BOOTH_RULES_VERSION, RULES_VERSIONS, RULES_STATE_FILE, formatRulesVersion, parseRulesVersion, isStaleRulesVersion, contentKeyFor, ARCHIVE_EXTENSIONS, IMAGE_EXTENSIONS, sha256Of, isClassified, retentionDaysFor, cleanupDeadline, UNCLASSIFIED_DIR, ARCHIVE_IMAGE_EXTENSIONS, ARCHIVE_EXCLUDED_KINDS, formatBytes } from './file-archive/common.js';
export { validateArchiveRelPath, parentDirRel, OWN_WRITE_TTL_MS, recordOwnWrite, isOwnWrite, pruneOwnWrites, listOwnWrites, clearOwnWrites, writeFileAtomicSync, FileOpsBusyError, FileOpsMutex, fileOpsMu, withFileOpsLock, sanitizeFileName, simpleBoothId, simpleArchiveDir, archiveRelPath, allocateStoredName, resolveArchiveRoot, safeResolveInside, boothItemDirName, archiveDirRel, metaJsonFor, archiveManualDirRel, toPosixRel } from './file-archive/paths.js';
export { ensureFileLedger, backfillContentKeys, stampRuleVersions, countStaleRuleRows, reconcileRuleVersions, readRuleVersions, writeRuleVersions, resetRuleVersions, insertArchiveRecord, findActiveArchive, findActiveArchiveBySha, allocateArchiveTarget, duplicateKeyFor, findDuplicateGroups, scanArchiveDuplicates, SCAN_INDEX_FILE, indexDirMtimes, diffDirMtimes, shouldRescan, readScanIndex, writeScanIndex, updateArchiveEnrichment, rowsNeedingEnrichment, backfillBoothColumns, exportArchiveRows, archiveRowsToCsv, listArchive, countArchive, dueArchiveRecords } from './file-archive/db.js';
export { ARCHIVE_RULE_EXTENSIONS, DEFAULT_ARCHIVE_RULES, normalizeArchiveRules, matchArchiveRules, describeArchiveRules } from './file-archive/rules.js';
export { shouldArchiveAttachment, describeArchiveSkip, isArchiveFileName, normalizeFileArchiveConfig, isArchiveGroup, storeArchivedFile, storeDownloadedFile, sha256OfFile, chatFileSegments, archiveChatFileSegments, archiveImageAttachment, formatArchiveFactsBlock, archiveCapabilityHint, setArchiveCategory, moveArchiveItemToCategory, pruneEmptyDirs, classifyByRules, parseClassifyReply, planCategoryMove } from './file-archive/storage.js';
export { RECYCLE_DIR, recycleBatchId, moveToRecycleBin, listRecycleBin, restoreFromRecycleBin, purgeRecycleBin } from './file-archive/recycle.js';
export { ARCHIVE_FORMATS, detectArchiveFormat, parseZipCentralDirectory, readArchiveToc, summarizeArchiveToc, THUMB_CONCURRENCY, THUMB_MAX_BYTES, createSemaphore, thumbSemaphore, withThumbSlot, shouldSkipThumb, enrichArchiveItem } from './file-archive/media.js';
export { archiveStats, runArchiveCleanup, formatCleanupLog, normalizeListParams, filterArchiveRows, sortArchiveRows, fileListsFromRows, fileNotifyFromRows } from './file-archive/cleanup.js';
