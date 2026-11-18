// media-send: extracted bridge responsibilities; no startup side effects.
// Live dependencies: AbortSignal, MAX_MEDIA_BYTES, applyStickerNote, bot, captureSendGuard, cfg, fetch, fetchFaceMedia, fetchOneBotImage, findSticker, getSocialV2State, log, looksLikeImageBuffer, markStickerUsed, randInt, safeFetchBuffer, saveStickerStoreSafe, sendChain, sleep, stickerEntries, syncStickerLibrary
// QQ 临时会话（对陌生人/未加好友的人私聊）只允许发文字：图片、表情要走 0x11c5 上传，
// 服务端会回 "OIDB error 170019003 ... verify identify fail"。把这层平台限制翻译成人话，
// 别让模型以为是自己参数写错、反复重试（用户看到的就是「表情/图片全堵在机器人这头」）。
export function mediaSendLimitText(action, message) {
  const text = String(message ?? '');
  if (action === 'send_private_msg' && /verify identify fail|170019003/i.test(text)) {
    return '对方不是我好友，QQ 临时会话只能发文字，表情和图片发不出去（OIDB 170019003）。'
      + '想发表情或图片，先让 TA 加我好友；或者改到有 TA 的群里发。';
  }
  return '';
}
export function createMediaSend(deps) {
// 每小时表情发送计数：只防「跑飞/刷屏」，正常聊天量远低于上限（默认 20 张/小时）。
// 按会话 key 分别计，1 小时滑动窗口；不落盘，重启清零（重启后重新算一小时，影响可忽略）。
const stickerSendWindow = new Map();
function stickerQuota(deps, key) {
  const max = Math.max(0, Math.round(Number(deps.cfg.socialV2?.sticker?.perHourMax ?? 20)));
  if (!max) return { allowed: true, max: 0, used: 0 };
  const now = Date.now();
  const recent = (stickerSendWindow.get(key) || []).filter((t) => now - t < 3600000);
  stickerSendWindow.set(key, recent);
  return { allowed: recent.length < max, max, used: recent.length };
}
function noteStickerSent(key) {
  const list = (stickerSendWindow.get(key) || []).filter((t) => Date.now() - t < 3600000);
  list.push(Date.now());
  stickerSendWindow.set(key, list);
}
// @bridge-function sendStickerV2:start
async function sendStickerV2(key, stickerRef, options = {}) {
    if (deps.socialV2?.paused) throw new Error('机器人系统已停止（控制台可一键启动），这段时间不发表情');

    const assertSendAllowed = (0, deps.captureSendGuard)(key);
    const quota = stickerQuota(deps, key);
    if (!quota.allowed) {
      throw new Error(`这一小时表情发得太多了（上限 ${quota.max} 张），先用文字聊两句，过会儿再发`);
    }
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await (0, deps.syncStickerLibrary)(true);
    const entry = (0, deps.findSticker)(synced?.entries ?? deps.stickerEntries, stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
    let image;
    try {
      image = await (0, deps.safeFetchBuffer)(url, deps.MAX_MEDIA_BYTES);
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片下载失败（QQ CDN 网络异常或地址已失效）：${error?.message ?? error}`);
    }
    segments.push({ type: 'image', data: { file: 'base64://' + image.buffer.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(deps.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    deps.sendChain = deps.sendChain.then(async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        assertSendAllowed();
        (0, deps.assertIdentitySendAllowed)();
        // 节奏统一交给 send-pacing：表情默认 500ms，比文字短得多，斗图不会变幻灯片。
        await (0, deps.reserveSendSlot)('sticker', '');
        await (0, deps.assertFreshHttpIdentitySendAllowed)();
        const res = await (0, deps.fetch)(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: deps.AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          const raw = `OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`;
          throw new Error(mediaSendLimitText(action, raw) || raw);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    // 更新本地使用统计
    noteStickerSent(key);
    const updated = (0, deps.markStickerUsed)(deps.stickerEntries, entry.id, 'sticker');
    deps.stickerEntries = updated.entries;
    (0, deps.saveStickerStoreSafe)();
    // 自我发送也要进会话时间线：否则控制台只看到「调用了 qq_send_sticker」，群里那条表情在时间线上不存在。
    const note = String(updated.entry?.localNote || updated.entry?.desc || '').trim();
    try {
      (0, deps.recordSentMessagesV2)(key, [{
        text: '[表情]' + (note ? ` ${note}` : ''),
        media: [{ kind: 'sticker', url: String(entry.url || ''), file: String(entry.file || ''), emojiId: String(entry.emojiId || ''), summary: note ? `[表情:${note}]` : '[表情]' }],
        messageId: data?.message_id ?? null
      }]);
    } catch (error) {
      (0, deps.log)(`[sticker] 记录表情时间线失败 ${key}: ${error?.message ?? error}`);
    }
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }
// @bridge-function sendStickerV2:end

// @bridge-function applyStickerNoteV2:start
function applyStickerNoteV2(stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = (0, deps.applyStickerNote)(deps.stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    deps.stickerEntries = updated.entries;
    (0, deps.saveStickerStoreSafe)();
    return updated.entry;
  }
// @bridge-function applyStickerNoteV2:end

// @bridge-function sendImageV2:start
async function sendImageV2(key, imageRef, options = {}) {
    const assertSendAllowed = (0, deps.captureSendGuard)(key);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const maxBytes = Number(deps.cfg.imagegen?.maxBytes) || deps.MAX_MEDIA_BYTES;
    let buffer;
    const ref = String(imageRef ?? '').trim();
    if (ref.startsWith('base64://')) {
      buffer = Buffer.from(ref.slice('base64://'.length), 'base64');
      if (!buffer.length || !(0, deps.looksLikeImageBuffer)(buffer)) throw new Error('base64 内容不是有效图片（PNG/JPEG/GIF/WebP）');
      if (buffer.length > maxBytes) throw new Error(`图片超过大小上限 ${maxBytes} 字节`);
    } else if (/^https?:\/\//i.test(ref)) {
      try {
        const fetched = await (0, deps.safeFetchBuffer)(ref, maxBytes);
        buffer = fetched.buffer;
      } catch (error) {
        throw new Error(`图片下载失败：${error?.message ?? error}`);
      }
    } else {
      throw new Error('imageRef 必须是 http(s) URL 或 base64:// 开头的数据');
    }
    segments.push({ type: 'image', data: { file: 'base64://' + buffer.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(deps.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => { sendResolve = resolve; sendReject = reject; });
    deps.sendChain = deps.sendChain.then(async () => {
      try {
        assertSendAllowed();
        // 节奏统一交给 send-pacing：表情默认 500ms，比文字短得多，斗图不会变幻灯片。
        await (0, deps.reserveSendSlot)('image', '');
        await (0, deps.assertFreshHttpIdentitySendAllowed)();
        const res = await (0, deps.fetch)(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: deps.AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          const raw = `OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`;
          throw new Error(mediaSendLimitText(action, raw) || raw);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    try {
      (0, deps.recordSentMessagesV2)(key, [{
        text: '[图片]',
        media: [{ kind: 'image', url: /^https?:\/\//i.test(ref) ? ref : '' }],
        messageId: data?.message_id ?? null
      }]);
    } catch (error) {
      (0, deps.log)(`[media] 记录图片时间线失败 ${key}: ${error?.message ?? error}`);
    }
    return { messageId: data?.message_id ?? null };
  }
// @bridge-function sendImageV2:end

// @bridge-function setStickerRemarkV2:start
async function setStickerRemarkV2(stickerId, remark) {
    const synced = await (0, deps.syncStickerLibrary)(false);
    const entry = (0, deps.findSticker)(synced?.entries ?? deps.stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    (0, deps.assertIdentitySendAllowed)();
    const response = await deps.bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = (0, deps.applyStickerNote)(deps.stickerEntries, entry.id, {});
    // 直接改 desc（保留本地认知）
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    deps.stickerEntries = updated.entries;
    (0, deps.saveStickerStoreSafe)();
    return deps.stickerEntries.find((e) => e.id === entry.id) || null;
  }
// @bridge-function setStickerRemarkV2:end

// @bridge-function collectStickerV2:start
async function collectStickerV2(key, messageRef, remark) {
    const assertSendAllowed = (0, deps.captureSendGuard)(key);
    const st = (0, deps.getSocialV2State)(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let file = '';
    if (media?.kind === 'image') {
      // 优先取图片字节转 base64，避免 SnowLuma 直接下载聊天图片 URL 失败（带签名/防盗链）。
      // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
      const img = await (0, deps.fetchOneBotImage)(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      const face = await (0, deps.fetchFaceMedia)(media);
      if (face?.buffer) file = 'base64://' + face.buffer.toString('base64');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    assertSendAllowed();
    (0, deps.assertIdentitySendAllowed)();
    const addRes = await deps.bot.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(deps.cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      assertSendAllowed();
      (0, deps.assertIdentitySendAllowed)();
      const modRes = await deps.bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        (0, deps.log)(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让刚收藏的表情立即可用。
    const synced = await (0, deps.syncStickerLibrary)(true);
    const entry = (0, deps.findSticker)(synced?.entries ?? deps.stickerEntries, emojiId);
    return { emojiId, entry: entry || null, remark: cleanRemark };
  }
// @bridge-function collectStickerV2:end
  return { sendStickerV2, applyStickerNoteV2, sendImageV2, setStickerRemarkV2, collectStickerV2 };
}
