// usage-runtime: extracted bridge responsibilities; no startup side effects.
// Live dependencies: FRAME_DIR, TURN_BUSY_LEASE_MS, cfg, clearTimeout, collectors, createTurnCollector, frameRetentionCfg, fs, getSocialV2State, log, nominalModel, path, pendingWakeKeys, pendingWakeLeaseTimers, planFrameDeletions, scheduleWakeV2, sessionModels, setTimeout, state, tokenLedger, v2TurnStartAt
export function createUsageRuntime(deps) {
// @bridge-function pruneVideoFrames:start
function pruneVideoFrames() {
    try {
      if (!deps.fs.existsSync(deps.FRAME_DIR)) return 0;
      const cfgFrame = (0, deps.frameRetentionCfg)(deps.cfg.socialV2?.media);
      const files = [];
      for (const name of deps.fs.readdirSync(deps.FRAME_DIR)) {
        const full = deps.path.join(deps.FRAME_DIR, name);
        try { const st = deps.fs.statSync(full); if (st.isFile()) files.push({ name, bytes: st.size, mtimeMs: st.mtimeMs }); } catch {}
      }
      const { drop } = (0, deps.planFrameDeletions)(files, { now: Date.now(), ...cfgFrame });
      let freed = 0; let removed = 0; let failed = 0;
      for (const name of drop) {
        const full = deps.path.join(deps.FRAME_DIR, name);
        try { const size = files.find((f) => f.name === name)?.bytes ?? 0; deps.fs.unlinkSync(full); freed += size; removed += 1; }
        catch { failed += 1; }   // 被占用：保留，下轮再试
      }
      if (removed) (0, deps.log)(`[media] 清理 video-frames ${removed} 个（释放 ${(freed / 1048576).toFixed(2)} MB）${failed ? `，${failed} 个失败待重试` : ''}`);
      return removed;
    } catch (error) { (0, deps.log)(`[media] video-frames 清理失败（不影响运行）：${error?.message ?? error}`); return 0; }
  }
// @bridge-function pruneVideoFrames:end

// @bridge-function rememberModel:start
function rememberModel(sessionId, selection) {
    const model = selection?.model;
    if (typeof model === 'string' && model) {
      deps.sessionModels.set(sessionId, { model, provider: selection?.provider });
    }
  }
// @bridge-function rememberModel:end

// @bridge-function recordSessionUsage:start
function recordSessionUsage(sessionId, event) {
    try {
      if (event?.type === 'model/selection') rememberModel(sessionId, event.data);
      const known = deps.sessionModels.get(sessionId);
      deps.tokenLedger.ingestEvent({
        sessionId,
        event,
        model: event?.data?.usage?.model ?? known?.model,
        provider: event?.data?.provider ?? known?.provider
      });
    } catch (error) {
      (0, deps.log)('token 账本：摄入事件失败', error?.message ?? error);
    }
  }
// @bridge-function recordSessionUsage:end

// @bridge-function recordSessionSnapshot:start
function recordSessionSnapshot(sessionId, snapshot) {
    try {
      if (!snapshot) return;
      const selection = snapshot.projections?.values?.modelSelection;
      rememberModel(sessionId, selection?.lastUsed ?? selection?.pending ?? null);
      const known = deps.sessionModels.get(sessionId);
      deps.tokenLedger.ingestBaseline({
        sessionId,
        projection: snapshot.projections,
        at: Date.now(),
      time: Date.now(),
        model: known?.model ?? (0, deps.nominalModel)(),
        provider: known?.provider ?? deps.cfg.dsh?.provider
      });
      // 回填历史逐轮明细时也要带上桥接已知的 model/provider：否则这些行落盘后没有 model 字段，
      // ratesAt() 只能走兜底价（实测 366/2909 条 turn 行缺 model，pro 与 flash 的差价被抹平）。
      deps.tokenLedger.ingestSnapshotRecords({
        sessionId,
        records: snapshot.records,
        model: known?.model ?? (0, deps.nominalModel)(),
        provider: known?.provider ?? deps.cfg.dsh?.provider
      });
      rebuildInFlightCollector(sessionId, snapshot.records);
    } catch (error) {
      (0, deps.log)('token 账本：处理会话快照失败', error?.message ?? error);
    }
  }
// @bridge-function recordSessionSnapshot:end

// @bridge-function rebuildInFlightCollector:start
function rebuildInFlightCollector(sessionId, records) {
    if (!Array.isArray(records) || !records.length) return;
    const eventOf = (entry) => (entry?.type === 'event' ? entry.event : entry);
    const open = new Set();
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type === 'turn/start') open.add(event.data?.turn);
      else if (event?.type === 'turn/end') open.delete(event.data?.turn);
    }
    if (!open.size) return;
    const collector = (0, deps.createTurnCollector)();
    let restored = 0;
    for (const entry of records) {
      const event = eventOf(entry);
      // 只回放未结束回合的文本来源：turn/start 建立回合，assistant/message 累积文本。
      if (event?.type !== 'turn/start' && event?.type !== 'assistant/message') continue;
      if (!open.has(event.data?.turn)) continue;
      collector.push(event);
      restored += 1;
    }
    if (!restored) return;
    deps.collectors.set(sessionId, collector);
    // 恢复出来的回合也必须带起始时间，否则租约对它无从生效 —— 这正是
    // 「DSH 重启后忙标记永不复位」的那条路径（issue #19）。不知道真实起点时按现在算：
    // 活着的回合会在 turn/end 清掉；真丢了的回合最多再忙一个租约期就自动解除。
    if (!deps.v2TurnStartAt.has(sessionId)) {
      // 恢复出来的回合只给 90 秒宽限：DSH 重启后这个回合经常其实已经死了，
      // 按完整租约（10 分钟）算忙会让整个群在这期间「叫了没反应」（实测 12:06 就是这样）。
      const lease = Number(deps.TURN_BUSY_LEASE_MS) || 10 * 60 * 1000;
      const grace = 90 * 1000;
      deps.v2TurnStartAt.set(sessionId, Date.now() - Math.max(0, lease - grace));
    }
    (0, deps.log)(`重连后恢复了进行中的回合（${sessionId}，turn ${[...open].join(',')}；90s 宽限后自动解除忙）`);
    // 90 秒后主动清一次忙并补推排队的唤醒：否则要等下一条消息才会重新判断。
    const resumeSid = sessionId;
    (0, deps.setTimeout)(() => {
      const startedAt = Number(deps.v2TurnStartAt.get(resumeSid));
      if (Number.isFinite(startedAt) && Date.now() - startedAt >= (Number(deps.TURN_BUSY_LEASE_MS) || 600000)) {
        deps.v2TurnStartAt.delete(resumeSid);
        // state.sessions 是普通对象，不是 Map —— 之前写成 for...of 会在定时器里抛 TypeError，
        // 直接让桥接进程退出（12:10:47 exit code=1 就是这条）。
        for (const [k, sid] of Object.entries(deps.state.sessions || {})) {
          if (sid !== resumeSid) continue;
          const st = (0, deps.getSocialV2State)(k);
          if (Array.isArray(st.pendingWakeReasons) && st.pendingWakeReasons.length) {
            const next = st.pendingWakeReasons.shift();
            (0, deps.log)(`[reserved2] 恢复回合已放弃等待，补推排队唤醒 ${k}（${next?.reason ?? 'unknown'}）`);
            (0, deps.scheduleWakeV2)(k, next?.reason || 'replyCheck');
          }
        }
      }
    }, 95 * 1000).unref?.();
  }
// @bridge-function rebuildInFlightCollector:end

// @bridge-function armPendingWakeLease:start
function armPendingWakeLease(key) {
    const old = deps.pendingWakeLeaseTimers.get(key);
    if (old) (0, deps.clearTimeout)(old);
    const timer = (0, deps.setTimeout)(() => {
      deps.pendingWakeKeys.delete(key);
      deps.pendingWakeLeaseTimers.delete(key);
    }, 30 * 60 * 1000);
    timer.unref?.();
    deps.pendingWakeLeaseTimers.set(key, timer);
  }
// @bridge-function armPendingWakeLease:end

// @bridge-function disarmPendingWakeLease:start
function disarmPendingWakeLease(key) {
    const old = deps.pendingWakeLeaseTimers.get(key);
    if (old) (0, deps.clearTimeout)(old);
    deps.pendingWakeLeaseTimers.delete(key);
  }
// @bridge-function disarmPendingWakeLease:end

// @bridge-function clearAllPendingWakeLeases:start
function clearAllPendingWakeLeases() {
    for (const t of deps.pendingWakeLeaseTimers.values()) (0, deps.clearTimeout)(t);
    deps.pendingWakeLeaseTimers.clear();
  }
// @bridge-function clearAllPendingWakeLeases:end
  return { pruneVideoFrames, rememberModel, recordSessionUsage, recordSessionSnapshot, rebuildInFlightCollector, armPendingWakeLease, disarmPendingWakeLease, clearAllPendingWakeLeases };
}
