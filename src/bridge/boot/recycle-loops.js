// 会话回收/上下文预算与周期定时任务（拆分自 src/bridge.js main()，行为与拆分前完全一致）。
// 纯搬运：语句顺序、日志文案与 try/catch 边界都不动；无 import，依赖全部由 deps 注入，
// 这样审计沙箱的 VM 剥掉 import 后仍能直接执行（见 scripts/bridge-source.mjs）。
export async function startRecycleLoops(deps) {
  const { states, wired, live, CONTEXT_BUDGET_SWEEP_INTERVAL_MS, log, listArchive, planImageBoothBackfill } = deps;
  const { approveDoubtFriendRequests, checkPresetFingerprint, fileArchiveDb, refreshGroupMembers, scheduleBudgetSweep, sessionRecycleTick } = wired;
  const { stModelSession, stConfig } = states;
  const bot = live.bot;
  // @bridge-function sessionRecycleCfg from session-recycle

  // ── D45 上下文预算回收 ────────────────────────────────────────────────────
  // 为什么另起一条线：sessionRecycle 只看「消息条数 / 小时数」，不看真实上下文占用 ——
  // 200 条消息只要每条都长，单步就能到 70 万 token（线上实测 p99 693k、最长会话 699 轮）。
  // 这里按 DSH 自己回报的 contextPressure（口径同 default-workspace\ctx-report.mjs）设一条
  // 按比例的线，超了就退役会话，下一轮由 ensureSession 重建。
  // 纪律：① 复用现成的 retireSession（内部已含 saveHandoffDigest 交接）+ 重建，不写第二套；
  //        ② 压力是慢变量，60 秒 TTL + 单飞 + 5 秒超时，绝不每步都打 RPC；
  //        ③ 拿不到数据/超时/缺字段一律 fail-open（继续用），开关关着连 RPC 都不打。
  // 懒建单例（函数声明会提升）：审计沙箱在 `bot.onPrivateMessage` 处提前 return，
  // 那段之后的 const 全都留在 TDZ —— 用 const 的话 /stMediaVoice.api/status 一读 budget 就
  // 「Cannot access 'budgetRunner' before initialization」直接 500（本套件当场红）。
  // @bridge-function contextPressureProbeInstance from session-recycle

  /** 距上次重建又进了多少条消息：DSH 没回报 sessionStats.turns 时的兜底判据。 */
  // @bridge-function messagesSinceSessionReset from session-recycle

  // 回合计数（每 N 轮触发一次兜底 sweep）与 sweep 单飞句柄
  live.budgetTurnsSinceSweep = 0;
  live.budgetSweepPromise = null;

  /**
   * 每轮结束时调一次：查压力 → 决策 → 需要就回收。
   * 调用方必须 fire-and-forget（内部有 5 秒 RPC 预算，不能拖慢回复发送）。
   * D51：真正的决策/计数/去重都在 createBudgetRunner 里（可单测），这里只注入副作用。
   */
  // @bridge-function budgetRunnerInstance from session-recycle

  /** 回合末：映射一致才检查；不一致时打 warn（D51：不再静默），并交给 sweep 兜底。 */
  // @bridge-function budgetTickForTurn from session-recycle

  /**
   * 兜底 sweep：对白名单里所有仍有映射的会话逐个查一次压力，超线就按同一套逻辑回收。
   * 为什么要它：重启后 DSH 会恢复「进行中的回合」，那些 frame 的 sessionId 与
   * state.sessions[key] 不一致，回合末守卫全为假 —— 2026-10-27 13:14 那次就这样让
   * group:100000009 在 31 分钟里 5 步烧掉 3.53M（706k/步）而 [预算] 一行日志都没有。
   * sweep 不看回合事件，只看会话映射，绕开这条死路。
   */
  // @bridge-function scheduleBudgetSweep from session-recycle
  // 定时兜底：就算一段时间没有任何回合结束（群里安静 / 回合卡住），也按时间扫一次。
  const budgetSweepTimer = setInterval(() => { void scheduleBudgetSweep('timer'); }, CONTEXT_BUDGET_SWEEP_INTERVAL_MS);
  budgetSweepTimer.unref?.();


  /**
   * 预设文件指纹。
   *
   * 为什么需要：agent preset（含 tool-result-pruner 阈值、人格、工具面）在**会话创建时**读取，
   * 已存在的 DSH 会话不会自动吃到新配置。2026-10-25 实测：改完线上 preset 并重启桥接后，
   * 按「会话内轮次序」做同龄统计发现之后零个新会话——存量会话（turn 30+）仍用旧阈值 50000，
   * 于是「调小裁剪阈值省钱」这件事实际从未生效。
   *
   * 做法：启动时记录 preset 的 mtime+size 指纹；与上次不同就置 pendingPresetRecycle，
   * 下一轮 sessionRecycleTick 把所有会话重建一次（代价：丢上下文；QQ 场景只有 8 条历史，可接受）。
   */
  // @bridge-function presetFingerprint from session-recycle

  /** 启动时比对 preset 指纹；变了就打日志并标记「下一轮回收时全部重建」。 */
  // @bridge-function checkPresetFingerprint from session-recycle

  // @bridge-function sessionRecycleTick from session-recycle

  // 放到启动后 6 秒执行：那时 stModelSession.socialV2 已加载完毕（早期放在启动流程里会静默失败）
  // preset 变更后不等 10 分钟一轮的 tick，3 秒后就重建，别让新配置迟迟不生效
  const immediateRecycleIfPending = () => {
    if (!stModelSession.socialV2.pendingPresetRecycle) return;
    setTimeout(() => { void sessionRecycleTick().catch((e) => log('[回收] 立即重建失败:', e?.message ?? e)); }, 3000);
  };
  setTimeout(() => { try { checkPresetFingerprint(); immediateRecycleIfPending(); } catch (e) { log("preset 指纹检查失败:", e?.message ?? e); } }, 6000);
  setTimeout(() => { void refreshGroupMembers().catch(() => {}); }, 6000);
  // 节假日表年度检查：跨年后提醒更新（不阻断启动）
  try {
    const pc = stConfig.cfg.socialV2?.peakPause || {};
    if (Number(pc.validYear) > 0 && new Date().getFullYear() > Number(pc.validYear)) {
      log(`⚠️ [峰值] 节假日表可能过期（仅覆盖 ${pc.validYear} 年），请更新 config.socialV2.peakPause.holidays`);
    }
  } catch {}

  // 启动补跑：同号图片回填（幂等，只处理 booth_id 为空的图片；失败只记日志）。
  try {
    const db = fileArchiveDb();
    if (db) {
      const rows = listArchive(db, { limit: 1000 });
      const updates = planImageBoothBackfill(rows);
      if (updates.length) {
        const stmt = db.prepare("UPDATE file_archive SET booth_id = ? WHERE id = ? AND booth_id = ''");
        let n = 0;
        for (const u of updates) n += stmt.run(u.boothId, u.id).changes;
        log(`[library] 同号图片回填：${n} 条（扫描 ${rows.length} 行）`);
      }
    }
  } catch (error) { log(`[library] 同号图片回填失败（不影响启动）：${error?.message ?? error}`); }

  const sessionRecycleTimer = setInterval(() => { void sessionRecycleTick(); }, 10 * 60 * 1000);
  sessionRecycleTimer.unref?.();
  sessionRecycleTimer.unref?.();
  const groupMemberTimer = setInterval(() => { void refreshGroupMembers().catch(() => {}); }, 10 * 60 * 1000);
  groupMemberTimer.unref?.();
  const doubtFriendTimer = setInterval(() => { void approveDoubtFriendRequests().catch(() => {}); }, 120000);
  doubtFriendTimer.unref?.();

  // 自动通过「可疑好友申请」：QQ 对机器人账号常把陌生人的好友申请丢进「疑友」列表，
  // 不会作为 request 事件推送。所以定时拉一次列表并全部批准，让对方能走正常好友私聊。
  // @bridge-function approveDoubtFriendRequests from login-recovery
}
