// reply-resolution: extracted bridge responsibilities; no startup side effects.
// Live dependencies: GROUP_MEMBER_IDS_TTL_MS, GROUP_MEMBER_NAME_TTL_MS, REPLY_INFO_TTL_MS, REPLY_NEGATIVE_TTL_MS, bot, botSelfIdCache, extractMediaFromSegments, groupMemberIdsCache, groupMemberNameCache, log, pruneGroupMemberNameCache, replyInfoCache, segmentsToText
export function createReplyResolution(deps) {
// @bridge-function assertGroupMember:start
async function assertGroupMember(groupId, userId) {
    const gid = String(groupId);
    const uid = String(userId);
    let cached = deps.groupMemberIdsCache.get(gid);
    if (!cached || Date.now() - cached.ts > deps.GROUP_MEMBER_IDS_TTL_MS) {
      let list;
      try {
        list = await deps.bot.getGroupMemberList(Number(gid));
      } catch (error) {
        // 失败即拒绝（fail-closed）：宁可拍不出去，也不要绕过校验。
        return `无法获取群 ${gid} 的成员列表：${error?.message ?? error}`;
      }
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const ids = new Set(members.map((m) => String(m?.user_id ?? '')).filter(Boolean));
      if (!ids.size) return `群 ${gid} 的成员列表为空，无法校验拍一拍目标`;
      cached = { ids, ts: Date.now() };
      deps.groupMemberIdsCache.set(gid, cached);
      if (deps.groupMemberIdsCache.size > 50) {
        for (const [k, v] of deps.groupMemberIdsCache) {
          if (Date.now() - v.ts > 10 * 60 * 1000) deps.groupMemberIdsCache.delete(k);
        }
      }
    }
    return cached.ids.has(uid) ? null : `QQ ${uid} 不是群 ${gid} 的成员，已拒绝拍一拍`;
  }
// @bridge-function assertGroupMember:end

// @bridge-function resolveGroupMemberName:start
async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = deps.groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < deps.GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await deps.bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = info?.card || info?.nickname || null;
      } catch {}
      if (name) {
        deps.groupMemberNameCache.set(key, { name, ts: Date.now() });
        (0, deps.pruneGroupMemberNameCache)();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await deps.bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = m?.card || m?.nickname || null;
        if (n) deps.groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      (0, deps.pruneGroupMemberNameCache)();
      name = deps.groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }
// @bridge-function resolveGroupMemberName:end

// @bridge-function pruneReplyInfoCache:start
function pruneReplyInfoCache() {
    if (deps.replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of deps.replyInfoCache) {
      if (now - v.ts > deps.REPLY_INFO_TTL_MS) deps.replyInfoCache.delete(k);
    }
    if (deps.replyInfoCache.size > 1000) {
      const oldestKey = deps.replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) deps.replyInfoCache.delete(oldestKey);
    }
  }
// @bridge-function pruneReplyInfoCache:end

// @bridge-function resolveReplyInfo:start
async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = deps.replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? deps.REPLY_INFO_TTL_MS : deps.REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        (0, deps.log)(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        deps.replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await deps.bot.getMessage(numericId);
      if (!raw) {
        deps.replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          deps.replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          deps.replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          deps.replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          deps.replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          deps.replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
      const text = await (0, deps.segmentsToText)(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      const rawSegments = Array.isArray(raw.message) ? raw.message : [];
      const info = {
        // 被引用那条消息的 id：控制台「点引用跳到原消息」靠它定位（旧数据没有这个字段，前端退化按文本找）。
        messageId: String(messageId),
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 200),
        userId: senderUserId != null ? String(senderUserId) : null,
        // 引用消息里的附件：用户常说「转存一下这个」再引用一张图/一个文件，
        // 附件在**被引用的那条**消息里，不在当前消息里。这里把最小必要形态带出来，
        // 供白名单群转存（file 段 + 图片/表情元数据；不缓存完整原始消息，避免长占内存）。
        fileSegments: rawSegments.filter((s) => s?.type === 'file').slice(0, 3),
        media: (0, deps.extractMediaFromSegments)(rawSegments).slice(0, 3)
      };
      deps.replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      (0, deps.log)('解析引用消息失败:', error?.message ?? error);
      deps.replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }
// @bridge-function resolveReplyInfo:end

// @bridge-function resolveReplyTargetV2:start
async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }
// @bridge-function resolveReplyTargetV2:end

// @bridge-function isQuoteTargetSelf:start
async function isQuoteTargetSelf(message, kind, id, selfId) {
    // self_id 缺失时用缓存兜底（SnowLuma 部分事件不带 self_id）。
    const resolvedSelf = selfId || deps.botSelfIdCache || '';
    if (!Array.isArray(message) || !resolvedSelf) return false;
    selfId = resolvedSelf;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }
// @bridge-function isQuoteTargetSelf:end
  return { assertGroupMember, resolveGroupMemberName, pruneReplyInfoCache, resolveReplyInfo, resolveReplyTargetV2, isQuoteTargetSelf };
}
