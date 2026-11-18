// attachment-archive: extracted bridge responsibilities; no startup side effects.
// Live dependencies: STATE_DIR, archiveDirRel, archiveGateReason, archiveImageAttachment, archiveSkipLoggedAt, boothConfig, cfg, fileArchiveDb, fileArchiveRootDir, formatArchiveBytes, fs, groupNameCache, groupNamesLoaded, isArchiveGroup, isObserveGroup, log, oneBotAction, path, pushArchiveFacts, sanitizeFileName, scheduleArchiveEnrichment, setTimeout, simpleArchiveDir, simpleBoothId
export function createAttachmentArchive(deps) {
// @bridge-function groupNameStatePath:start
function groupNameStatePath() { return deps.path.join(deps.STATE_DIR, 'group-names.json'); }
// @bridge-function groupNameStatePath:end

// @bridge-function loadGroupNamesOnce:start
function loadGroupNamesOnce() {
    if (deps.groupNamesLoaded) return;
    deps.groupNamesLoaded = true;
    try {
      const raw = JSON.parse(deps.fs.readFileSync(groupNameStatePath(), 'utf8'));
      for (const [k, v] of Object.entries(raw || {})) {
        const name = String(v || '').trim();
        if (name) deps.groupNameCache.set(String(k), name);
      }
    } catch {}
  }
// @bridge-function loadGroupNamesOnce:end

// @bridge-function saveGroupNames:start
function saveGroupNames() {
    try {
      const obj = {};
      for (const [k, v] of deps.groupNameCache.entries()) obj[k] = v;
      deps.fs.writeFileSync(groupNameStatePath(), JSON.stringify(obj, null, 2), 'utf8');
    } catch {}
  }
// @bridge-function saveGroupNames:end

// @bridge-function ensureGroupFolderName:start
async function ensureGroupFolderName(gid) {
    const id = String(gid ?? '').replace(/\D/g, '');
    if (!id) return '';
    loadGroupNamesOnce();
    if (deps.groupNameCache.has(id)) return deps.groupNameCache.get(id);
    try {
      const info = await Promise.race([
        (0, deps.oneBotAction)('get_group_info', { group_id: Number(id) }),
        new Promise((_r, rej) => (0, deps.setTimeout)(() => rej(new Error('timeout')), 2500))
      ]);
      const name = String(info?.group_name || info?.data?.group_name || '').trim();
      if (name) { deps.groupNameCache.set(id, name); saveGroupNames(); }
      return name;
    } catch { return ''; }
  }
// @bridge-function ensureGroupFolderName:end

// @bridge-function archiveCfgFor:start
function archiveCfgFor(gid) {
    const base = deps.cfg.fileArchive || {};
    if (base.simpleMode !== true) return base;
    return { ...base, groupFolderName: deps.groupNameCache.get(String(gid)) || '' };
  }
// @bridge-function archiveCfgFor:end

// @bridge-function archiveMediaAttachment:start
function archiveMediaAttachment(key, media, buffer, index, mimeType) {
    const matched = /^group:(\d+)$/.exec(String(key ?? ''));
    if (!matched || !buffer?.length) return;
    const gid = matched[1];
    if ((0, deps.isObserveGroup)(deps.cfg.observe, gid)) return;
    // 用户拍板：只转图片 + 压缩包，**表情包绝不转**。face 段 / 表情类媒体直接跳过，
    // 表情标记（emojiId、subType=1）的 image 段也按「判不准」不转。
    if (media?.kind === 'face' || media?.kind === 'sticker') {
      logArchiveSkip(key, '表情包', '表情包不转存');
      return;
    }
    // 先按 MIME 定出落盘扩展名：闸门要用它判断「图片类型是否在口径白名单里」，
    // 没有文件名的图片（media.name 为空）也得有个可判定的名字，否则默认口径会误拒。
    const ext = (String(mimeType || '').match(/^image\/(\w+)/) || [])[1] || 'png';
    const imageExt = ext === 'jpeg' ? 'jpg' : ext;
    const gate = (0, deps.archiveGateReason)({
      kind: media?.kind,
      segType: 'image',
      fileName: String(media?.name || '') || `图片-${index}.${imageExt}`,
      bytes: buffer.length
    });
    if (!gate.ok) {
      logArchiveSkip(key, '图片', gate.reason || '图片不转存');
      return;
    }
    // simpleMode：闸门是按「图片自带的 7 位 BOOTH 号文件名」放行的；落盘时若改叫
    // `图片-N.png` 就会把号丢掉，无法归到 `<boothId>/` 目录。这里保留原名。
    const originalName = String(media?.name || '').trim();
    const name = (deps.cfg.fileArchive?.simpleMode === true && (0, deps.simpleBoothId)(originalName))
      ? (0, deps.sanitizeFileName)(/\.(jpe?g|png|gif|webp|bmp|heic)$/i.test(originalName) ? originalName : `${originalName}.${imageExt}`)
      : `图片-${index}.${imageExt}`;
    if (!(0, deps.isArchiveGroup)(deps.cfg.fileArchive, gid)) {
      (0, deps.pushArchiveFacts)(key, [{ status: 'skipped', name, reason: '该群不在文件保存白名单' }]);
      return;
    }
    const db = (0, deps.fileArchiveDb)();
    if (!db) return;
    try {
      const fact = (0, deps.archiveImageAttachment)({
        db,
        rootDir: (0, deps.fileArchiveRootDir)(),
        groupId: gid,
        buffer,
        fileName: name,
        fileId: String(media?.file ?? ''),
        mimeType: String(mimeType ?? ''),
        kind: 'image',
        segType: 'image',
        emojiId: String(media?.emojiId ?? ''),
        subType: String(media?.subType ?? ''),
        archivedAt: Date.now(),
        retention: deps.cfg.fileArchive?.retention,
        maxBytes: (Math.max(1, Number(deps.cfg.fileArchive?.maxFileMb) || 2560)) * 1024 * 1024,
        baseDirRel: deps.cfg.fileArchive?.simpleMode === true
          ? (0, deps.simpleArchiveDir)(archiveCfgFor(gid), gid, Date.now(), name)
          : ((0, deps.boothConfig)().enabled ? (0, deps.archiveDirRel)({ groupId: gid }) : '')
      });
      (0, deps.pushArchiveFacts)(key, [fact]);
      if (fact.status === 'ok') {
        (0, deps.log)(`图片已转存：群 ${gid}「${name}」${(0, deps.formatArchiveBytes)(fact.bytes)}（台账 #${fact.id}）`);
        (0, deps.scheduleArchiveEnrichment)(fact.id);
      } else if (fact.status === 'failed') {
        (0, deps.log)(`图片转存失败：群 ${gid}「${name}」${fact.reason}`);
      } else if (fact.status === 'skipped') {
        logArchiveSkip(key, `图片-${ext}`, fact.reason);
      }
    } catch (error) {
      (0, deps.log)(`图片转存失败：群 ${gid}「${name}」${error?.message ?? error}`);
      (0, deps.pushArchiveFacts)(key, [{ status: 'failed', name, reason: error?.message ?? String(error) }]);
    }
  }
// @bridge-function archiveMediaAttachment:end

// @bridge-function logArchiveSkip:start
function logArchiveSkip(key, tag, reason) {
    const hour = Math.floor(Date.now() / 3600000);
    const mapKey = `${key}:${tag}`;
    if (deps.archiveSkipLoggedAt.get(mapKey) === hour) return;
    deps.archiveSkipLoggedAt.set(mapKey, hour);
    (0, deps.log)(`转存跳过（${key}）：${tag} —— ${reason}`);
  }
// @bridge-function logArchiveSkip:end
  return { groupNameStatePath, loadGroupNamesOnce, saveGroupNames, ensureGroupFolderName, archiveCfgFor, archiveMediaAttachment, logArchiveSkip };
}
