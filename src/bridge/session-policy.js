// session-policy: extracted bridge responsibilities; no startup side effects.
// Live dependencies: DSH_CONTROL_TIMEOUT_MS, STATE_DIR, activeWaits, allowed, api, appliedModelBySession, cancelPendingEntry, cancelSocialTimers, cfg, clearSocialV2Timers, clearTimeout, closedAgentPreset, collectors, crypto, currentMode, disarmPendingWakeLease, dshDefaultPreset, dshPresetIds, feedbackTimes, isGroupMember, lastSendFailed, log, markReadCalledKeys, modelAppliedSessions, normalizeModeInput, normalizeOwnerQQ, path, pending, pendingSendToolCalls, pendingWakeKeys, queuedHintAt, readJsonSafe, rememberAgentToken, reverse, saveHandoffDigest, saveSocialV2State, saveState, sendToolSucceededSessions, sessionModels, settingFromDshNamespace, slangSubmitTimes, social, socialV2, state, toolCallNames, turnLeaseNoted, unwrap, v2TurnStartAt, wakeConfigMissCount, wakeConfigUpdatedKeys, withTimeout
export function createSessionPolicy(deps) {
// @bridge-function refreshMode:start
async function refreshMode() {
    try {
      const s = (0, deps.unwrap)(await deps.api.settings.describe({}), 'settings.describe');
      // DSH 的默认 preset（`agent-presets` 命名空间的 default）——closed-agent 的兜底值来源
      const presetNs = s.namespaces.find((n) => n.ns === 'agent-presets');
      const defaultPreset = (0, deps.settingFromDshNamespace)(presetNs, 'default');
      if (typeof defaultPreset === 'string' && defaultPreset) {
        deps.dshDefaultPreset = defaultPreset;
      }
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      // 规范化后再比较：`simulation` 也走这里（见 MODE_INPUT_ALIASES）。
      // 读取必须 user 层优先：DSH 0.2.0-rc.2 写完 settings 后同进程内 value 不更新，
      // 只读 value 会让控制台切的模式被 5 秒轮询改回去（issue #22）。
      const fromDsh = (0, deps.normalizeModeInput)((0, deps.settingFromDshNamespace)(ns, 'mode'));
      if (fromDsh) {
        deps.currentMode = fromDsh;
        // DSH 设置页也可配置管理员 QQ；**留空表示不覆盖 config.json**
        // （见 plugins/qq-mode-console 的 schema 描述）。这里必须显式判断空串：
        // normalizeOwnerQQ('') 返回 null，若照旧 `!== undefined` 就直接赋值，
        // 设置页每次轮询都会把 config.json 里的 ownerQQ 抹成 null —— 而 5 秒一次的
        // refreshMode 会让它「几秒后必然发生」，后果是 closed-agent 谁都不放行、
        // 审批/提问永远等不到管理员回答。
        const rawOwnerValue = (0, deps.settingFromDshNamespace)(ns, 'ownerQQ');
        if (rawOwnerValue !== undefined) {
          const rawOwner = String(rawOwnerValue ?? '').trim();
          if (rawOwner) {
            try {
              deps.cfg.ownerQQ = (0, deps.normalizeOwnerQQ)(rawOwner);
            } catch (error) {
              (0, deps.log)(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
            }
          }
        }
        // DSH 的 qq-mode schema 只有 mode / ownerQQ 两个字段，没有 closedAgentPreset；
        // 该值仍以本地 state/mode.json 为准（用 typeof 判断，允许用空串显式清空），
        // 否则这里提前 return 会让控制台的 preset 下拉变成永远不生效的死设置。
        const localPreset = (0, deps.readJsonSafe)(deps.path.join(deps.STATE_DIR, 'mode.json'), null);
        if (typeof localPreset?.closedAgentPreset === 'string') {
          deps.closedAgentPreset = localPreset.closedAgentPreset;
        }
        return;
      }
    } catch {}
    const local = (0, deps.readJsonSafe)(deps.path.join(deps.STATE_DIR, 'mode.json'), null);
    const fromLocal = local ? (0, deps.normalizeModeInput)(local.mode) : null;
    if (fromLocal) deps.currentMode = fromLocal;
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      deps.closedAgentPreset = local.closedAgentPreset;
    }
  }
// @bridge-function refreshMode:end

// @bridge-function refreshPresetList:start
async function refreshPresetList() {
    try {
      const { presets: list } = (0, deps.unwrap)(await deps.api.agentPresets.list({}), 'agentPresets.list');
      deps.dshPresetIds = list.map((p) => String(p.id));
      if (!deps.dshDefaultPreset) {
        const marked = list.find((p) => p.isDefault === true);
        if (marked) deps.dshDefaultPreset = String(marked.id);
      }
    } catch (error) {
      (0, deps.log)(`获取 DSH preset 列表失败：${error?.message ?? error}（会话将按配置的 preset 尝试创建）`);
    }
  }
// @bridge-function refreshPresetList:end

// @bridge-function whitelistedOnly:start
function whitelistedOnly(kind, id, cfg) {
    return (0, deps.allowed)(kind, id, cfg);
  }
// @bridge-function whitelistedOnly:end

// @bridge-function modeAllowed:start
function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // chat / reserved / reserved2（仿真模式，暂同 chat 白名单）
    // 临时通行证：allow.privateOpen=true 时任何人私聊都放行（额度由 handleIncoming 里单独扣）。
    if (kind === 'private' && cfg.allow?.privateOpen === true) return true;
    // 白名单群的成员同样放行私聊（额度在 handleIncoming 里按「非显式白名单」扣）。
    if (kind === 'private' && (0, deps.isGroupMember)(id)) return true;
    return (0, deps.allowed)(kind, id, cfg);
  }
// @bridge-function modeAllowed:end

// @bridge-function resolvePresetName:start
function resolvePresetName(name, { strict = false } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return strict ? '' : (deps.dshDefaultPreset || '');
    // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
    if (deps.dshPresetIds.length === 0) return strict ? '' : wanted;
    if (deps.dshPresetIds.includes(wanted)) return wanted;
    (0, deps.log)(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${deps.dshPresetIds.join(', ')}）中`);
    if (strict) {
      (0, deps.log)(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node scripts/setup-dsh.mjs 并重启 DSH`);
      return '';
    }
    return deps.dshDefaultPreset || '';
  }
// @bridge-function resolvePresetName:end

// @bridge-function modePreset:start
function modePreset(key, mode, cfg) {
    if (mode === 'closed-agent') {
      const chosen = resolvePresetName(deps.closedAgentPreset);
      if (!chosen) (0, deps.log)('⚠️ 无法确定 closed-agent 的 preset（DSH preset 清单未知），将按 DSH 默认 preset 建会话');
      return chosen || undefined;
    }
    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设。
    // 非 closed-agent 一律 strict：宁可建不出会话，也不给群聊套上带本地工具的默认 preset。
    const wanted = mode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
    return resolvePresetName(wanted, { strict: true }) || undefined;
  }
// @bridge-function modePreset:end

// @bridge-function isSessionAllowedInCurrentMode:start
function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), deps.cfg, deps.currentMode);
  }
// @bridge-function isSessionAllowedInCurrentMode:end

// @bridge-function sessionPolicy:start
function sessionPolicy(key) {
    return JSON.stringify([deps.currentMode, modePreset(key, deps.currentMode, deps.cfg) ?? '', deps.currentMode === 'closed-agent' ? deps.cfg.ownerQQ : null]);
  }
// @bridge-function sessionPolicy:end

// @bridge-function isCurrentSession:start
function isCurrentSession(key, sessionId) {
    return isSessionAllowedInCurrentMode(key) && deps.state.sessions[key] === sessionId
      && deps.state.sessionPolicies[key] === sessionPolicy(key);
  }
// @bridge-function isCurrentSession:end

// @bridge-function stopRetiredSessionWork:start
function stopRetiredSessionWork(sessionId, key = '') {
    void (async () => {
      try { await (0, deps.withTimeout)(deps.api.stopSessionWork(sessionId), deps.DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
      catch (error) { (0, deps.log)(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；本地映射已撤销，请在 DSH 检查旧任务`); }
      try { await (0, deps.withTimeout)(deps.api.workspace.archiveSession({ sessionId }), deps.DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); }
      catch (error) { (0, deps.log)(`归档失效会话失败 ${key}: ${error?.message ?? error}`); }
    })();
  }
// @bridge-function stopRetiredSessionWork:end

// @bridge-function forgetConversationCaches:start
function forgetConversationCaches(key) {
    deps.lastSendFailed.delete(key);
    deps.activeWaits.delete(key);
    deps.queuedHintAt.delete(key);
    deps.slangSubmitTimes.delete(key);
    deps.feedbackTimes.delete(key);
    deps.wakeConfigMissCount.delete(key);
    deps.wakeConfigUpdatedKeys.delete(key);
    deps.markReadCalledKeys.delete(key);
  }
// @bridge-function forgetConversationCaches:end

// @bridge-function retireSession:start
function retireSession(key) {
    // 退役前先把「最近发生了什么」压成脉络，下一次 bootstrap 时注入一次（第三层）。
    (0, deps.saveHandoffDigest)(key);
    const sessionId = deps.state.sessions[key];
    delete deps.state.sessions[key];
    delete deps.state.sessionPolicies[key];
    if (sessionId) deps.appliedModelBySession.delete(sessionId);
    // 按 key 记账的内存态在**有映射和无映射时都要清**：一条被移出白名单、
    // 但从未成功建过会话的 key 同样会留下限流时间戳与失败标记。
    forgetConversationCaches(key);
    if (!sessionId) return;
    deps.reverse.delete(sessionId);
    deps.collectors.delete(sessionId);
    deps.sessionModels.delete(sessionId);
    deps.modelAppliedSessions.delete(sessionId);
    deps.sendToolSucceededSessions.delete(sessionId);
    deps.pendingSendToolCalls.delete(sessionId);
    deps.v2TurnStartAt.delete(sessionId);
    deps.turnLeaseNoted.delete(sessionId);
    deps.toolCallNames.delete(sessionId);
    deps.social.silentTurns.delete(sessionId);
    deps.social.exitingSessions.delete(sessionId);
    // 退役的会话要退订：否则 _desiredFollows 只增不减，每次重连都会为它重开一条
    // follow 流并重发一整份历史快照（内存与重连延迟都随会话数线性增长）。
    deps.api.events.forget?.(sessionId);
    const entry = deps.pending.get(key);
    if (entry) { (0, deps.clearTimeout)(entry.timer); void (0, deps.cancelPendingEntry)(entry).catch(() => {}); }
    deps.pending.delete(key);
    (0, deps.clearSocialV2Timers)(key);
    (0, deps.cancelSocialTimers)(key);
    (0, deps.disarmPendingWakeLease)(key);
    deps.pendingWakeKeys.delete(key);
    const st = deps.socialV2.conversations.get(key);
    if (st) {
      // 保留旧 token 在脱敏集合中，但撤销它的调用权限。
      st.agentToken = deps.crypto.randomBytes(24).toString('hex');
      (0, deps.rememberAgentToken)(key, st.agentToken);
      st.bootstrapSent = false;
      st.modelSeenSeqs = new Set();
    }
    (0, deps.saveState)();
    (0, deps.saveSocialV2State)();
    stopRetiredSessionWork(sessionId, key);
    (0, deps.log)(`会话权限已变化，停用旧映射 ${key} -> ${sessionId}`);
  }
// @bridge-function retireSession:end

// @bridge-function reconcileSessionPolicies:start
function reconcileSessionPolicies() {
    // DSH preset 清单未知时**绝不能**做退役判定。
    //
    // 为什么：`sessionPolicy()` 包含 `modePreset()` 的结果，而 `modePreset()` 依赖
    // `dshPresetIds`（来自 DSH 的 `agentPresets/list`）。启动瞬间或一次瞬时失败时
    // 这个清单可能是空的，`resolvePresetName(strict)` 于是返回 ''，算出来的策略就变成
    // `["reserved2","",null]` —— 与已存的 `["reserved2","qq-chat-v2",null]` 不等，
    // 于是**所有** QQ 会话在这一个 tick 里被集体退役：DSH 会话被停掉归档、agentToken 轮换、
    // 映射删除，每个群的上下文全丢，日志里只有一句「会话权限已变化」。
    // 一次网络抖动换来全体失忆，代价完全不成比例。清单为空时宁可不判定，等下一轮。
    if (deps.dshPresetIds.length === 0) return;
    for (const [key, sessionId] of Object.entries(deps.state.sessions)) {
      if (!isCurrentSession(key, sessionId)) retireSession(key);
    }
  }
// @bridge-function reconcileSessionPolicies:end
  return { refreshMode, refreshPresetList, whitelistedOnly, modeAllowed, resolvePresetName, modePreset, isSessionAllowedInCurrentMode, sessionPolicy, isCurrentSession, stopRetiredSessionWork, forgetConversationCaches, retireSession, reconcileSessionPolicies };
}
