// pending-interactions: extracted bridge responsibilities; no startup side effects.
// Live dependencies: APPROVE_WORDS, REJECT_WORDS, api, appendActivity, appendSocialV2Poke, cfg, clearTimeout, convKey, currentMode, getSocialV2State, log, modeAllowed, pending, resolveGroupMemberName, saveSocialV2State, scheduleWakeV2, sendToQQ, setTimeout, socialV2, withTimeout
export function createPendingInteractions(deps) {
// @bridge-function cancelPendingEntry:start
async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await (0, deps.withTimeout)(deps.api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: 'rejected' }
        }), 5000, '取消挂起回执');
        (0, deps.log)(`已取消挂起审批（拒绝回执）: ${entry.eventId ?? entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await (0, deps.withTimeout)(deps.api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: { answers: [] } }
        }), 5000, '取消挂起回执');
        (0, deps.log)(`已取消挂起提问（空答案回执）: ${entry.eventId ?? entry.rpcId}`);
      }
    } catch (error) {
      (0, deps.log)('取消挂起请求回执失败:', error?.message ?? error);
    }
  }
// @bridge-function cancelPendingEntry:end

// @bridge-function handlePendingAnswer:start
async function handlePendingAnswer(p, answerText, key, isOwner = false) {
    if (p.kind === 'question') {
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await deps.api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers } }
        });
        (0, deps.log)(`已回答提问 (${key}):`, receipt);
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (deps.pending.get(key) === p) deps.pending.delete(key);
      } catch (error) {
        (0, deps.log)('回答问题失败（保留挂起以便重试）:', error.message);
        await (0, deps.sendToQQ)(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await (0, deps.sendToQQ)(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of deps.APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of deps.REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await (0, deps.sendToQQ)(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await deps.api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: outcome }
        });
        (0, deps.log)(`已处理审批 (${key}): ${outcome}`, receipt);
        await (0, deps.sendToQQ)(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (deps.pending.get(key) === p) deps.pending.delete(key);
      } catch (error) {
        (0, deps.log)('处理审批失败（保留挂起以便重试）:', error.message);
        await (0, deps.sendToQQ)(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }
// @bridge-function handlePendingAnswer:end

// @bridge-function handlePokeNotice:start
async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = (0, deps.convKey)('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = (0, deps.convKey)('private', id);
    }
    if (!(0, deps.modeAllowed)(key, kind, id, deps.cfg, deps.currentMode)) return;
    if (deps.currentMode !== 'reserved2') {
      (0, deps.appendActivity)(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await (0, deps.resolveGroupMemberName)(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(deps.cfg.ownerQQ ?? '');
    const msg = (0, deps.appendSocialV2Poke)(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    (0, deps.appendActivity)(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (deps.currentMode !== 'reserved2') return;
    if (deps.socialV2.paused) return;
    const st = (0, deps.getSocialV2State)(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      (0, deps.saveSocialV2State)();
      (0, deps.log)(`[reserved2] 新会话首次拍一拍 → bootstrap 引导（bootstrap 不判断拍一拍开关）`);
      (0, deps.scheduleWakeV2)(key, 'bootstrap');
    } else if (st.wakeConfig?.triggers?.poke) {
      (0, deps.scheduleWakeV2)(key, 'poke');
    }
  }
// @bridge-function handlePokeNotice:end

// @bridge-function registerPending:start
async function registerPending(key, entry) {
    const existing = deps.pending.get(key);
    if (existing) {
      (0, deps.clearTimeout)(existing.timer);
      deps.pending.delete(key);
      (0, deps.log)(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = (0, deps.setTimeout)(() => {
      if (deps.pending.get(key) === entry) {
        deps.pending.delete(key);
        (0, deps.log)(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        (0, deps.sendToQQ)(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, deps.cfg.questionTimeoutMs);
    entry.timer = timer;
    deps.pending.set(key, entry);
  }
// @bridge-function registerPending:end
  return { cancelPendingEntry, handlePendingAnswer, handlePokeNotice, registerPending };
}
