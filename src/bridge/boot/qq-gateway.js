// QQ 网关（SnowLuma OneBot WS）连接与入站事件接线（拆分自 src/bridge.js main()，行为与拆分前完全一致）。
// 纯搬运：语句顺序、日志文案与 try/catch 边界都不动；无 import，依赖全部由 deps 注入，
// 这样审计沙箱的 VM 剥掉 import 后仍能直接执行（见 scripts/bridge-source.mjs）。
export async function startQqGateway(deps) {
  const { states, wired, live, SnowLumaWebSocketClient, createIdentityGuardedBot, assertFreshIdentitySendAllowed, log, describeObserveConfig, formatArchiveBytes, backfillBoothColumns, rowsNeedingEnrichment } = deps;
  const { approveDoubtFriendRequests, boothConfig, ensureGroupFolderName, fileArchiveDb, handleGroupFileUpload, handleIncoming, handlePokeNotice, observeLearnFromGroupMessage, persistMissingStickerThumbs, scheduleArchiveEnrichment, startArchiveCleanupLoop } = wired;
  const { stConfig } = states;
  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const rawBot = new SnowLumaWebSocketClient({
    url: stConfig.cfg.snowluma.wsUrl,
    accessToken: stConfig.cfg.snowluma.accessToken || undefined,
    // The SDK's internal reconnect loop bypasses our pre-connect identity gate; reconnect is app-managed.
    reconnect: false
  });
  // Every connect is preflighted against the account currently attached to the local OneBot HTTP endpoint.
  const bot = createIdentityGuardedBot(rawBot, assertFreshIdentitySendAllowed, {
    beforeConnect: deps.assertIdentityReconnectAllowed,
    afterConnect: deps.verifyConnectedIdentity,
  });
  const allowCurrentIdentity = async () => {
    try { await assertFreshIdentitySendAllowed(); return true; }
    catch (error) {
      log(`[安全] 拒绝处理当前 WebSocket 事件：${error?.message ?? error}`);
      try { bot.close(4003, 'identity-mismatch'); }
      catch (closeError) { log(`[安全] 错号连接关闭失败：${closeError?.message ?? closeError}`); }
      return false;
    }
  };

  bot.onPrivateMessage(async (event) => {
    if (!(await allowCurrentIdentity())) return;
    // 统一按字符串比较：网关可能把 id 序列化成 number/string 混用，
    // 用 `===` 漏掉自己发的消息会进入正常处理（reserved2 下 AI 会回答自己 / chat 下可能回复循环）。
    if (String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    try { await handleIncoming('private', event.user_id, event, stConfig.cfg); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
  });
  bot.onGroupMessage(async (event) => {
    if (!(await allowCurrentIdentity())) return;
    if (String(event?.sender?.user_id ?? '') === String(event?.self_id ?? '')
      || String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    // 观察学习白名单优先：命中就只学习、直接 return，绝不进入 handleIncoming（不唤醒/不回复）。
    try {
      if (await observeLearnFromGroupMessage(event)) return;
    } catch (error) {
      log('观察群学习出错:', error?.message ?? error);
      return;
    }
    try { await handleIncoming('group', event.group_id, event, stConfig.cfg); } catch (error) { log('处理群消息出错:', error?.message ?? error); }
  });
  bot.onNotice('notify', async (event) => {
    if (!(await allowCurrentIdentity())) return;
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });
  // 群文件上传通知（OneBot notice_type=group_upload，字段见 docs/file-archive-survey.md）。
  bot.onNotice('group_upload', async (event) => {
    if (!(await allowCurrentIdentity())) return;
    try {
      await handleGroupFileUpload(event);
    } catch (error) {
      log(`群文件转存失败：群 ${event?.group_id ?? '?'} 文件 ${event?.file?.name ?? '?'}：${error?.message ?? error}`);
    }
  });

  // simpleMode：启动后预热一次群名（目录要用「群号_群名」）；失败就只用群号。
  if (stConfig.cfg.fileArchive?.enabled && stConfig.cfg.fileArchive?.simpleMode === true) {
    setTimeout(() => {
      for (const gid of stConfig.cfg.fileArchive.groups || []) {
        void ensureGroupFolderName(gid).then((name) => {
          if (name) log(`群名称缓存：${gid} → ${name}`);
        });
      }
    }, 6000).unref?.();
  }

  // 启动日志：观察群 & 文件转存的实际生效状态（避免「配置了却没生效」被当成坏了）。
  {
    const observeLine = describeObserveConfig(stConfig.cfg.observe);
    if (observeLine) log(observeLine);
    if (stConfig.cfg.fileArchive?.enabled) {
      const groups = stConfig.cfg.fileArchive.groups ?? [];
      log(groups.length
        ? `文件保存白名单：${groups.join(',')}（转存到 ${stConfig.cfg.fileArchive.dir}，单文件上限 ${formatArchiveBytes(stConfig.cfg.fileArchive.maxFileMb * 1024 * 1024)}（${stConfig.cfg.fileArchive.maxFileMb}MB），未分类保留 ${stConfig.cfg.fileArchive.retention.unclassifiedDays} 天/已分类 ${stConfig.cfg.fileArchive.retention.classifiedDays} 天）`
        : '文件保存白名单已启用，但 groups 为空：当前不会转存任何群文件');
    }
    startArchiveCleanupLoop();
    // 表情图片「有 url 就落盘」：启动时补一次（历史遗留的只有链接的条目会在这里被标 missing
    // 或补成 md5 缓存；每张 ≤2MB，总量超上限会跳过并告警）。
    setTimeout(() => {
      void persistMissingStickerThumbs({ limit: 10 }).catch((error) => {
        log(`[sticker] 启动补落盘失败（不影响运行）：${error?.message ?? error}`);
      });
    }, 20000).unref?.();
    if (stConfig.cfg.fileArchive?.enabled && stConfig.cfg.fileArchive?.simpleMode !== true && boothConfig().enabled) {
      log(`BOOTH 归类已启用：缓存 ${boothConfig().cacheDays} 天，限速 ${boothConfig().rateLimitMs}ms，缩略图上限 ${formatArchiveBytes(boothConfig().thumbMaxBytes)}`);
      // 存量回填 + 补抓：后台慢慢跑，绝不阻塞启动（不 await）。
      setTimeout(() => {
        try {
          const db = fileArchiveDb();
          if (!db) return;
          const backfilled = backfillBoothColumns(db);
          if (backfilled.updated) log(`BOOTH 存量回填：扫描 ${backfilled.scanned} 条，补上 BOOTH 号 ${backfilled.updated} 条`);
          const pending = rowsNeedingEnrichment(db, { limit: 10 }).map((row) => row.id);
          if (pending.length) {
            log(`BOOTH 补抓：${pending.length} 条待抓元数据（后台处理）`);
            scheduleArchiveEnrichment(pending);
          }
        } catch (error) {
          log(`BOOTH 存量回填失败（不影响转存）：${error?.message ?? error}`);
        }
      }, 15000).unref?.();
    }
  }

  // 自动通过好友申请：陌生人私聊只能走临时会话（QQ 常把消息压进单独的「临时会话」窗口，
  // 对方常常看不到）。让他们加好友后走正常私聊，最省事。默认只在开放私聊（privateOpen）时启用。
  bot.onRequest(async (event) => {
    if (!(await allowCurrentIdentity())) return;
    if (event?.request_type !== 'friend') return;
    if (stConfig.cfg.allow?.privateOpen !== true) return;
    const uid = String(event.user_id ?? event.from_uin ?? '');
    if (!uid) return;
    try {
      await bot.request('set_friend_add_request', { flag: event.flag, approve: true });
      log(`已自动通过好友申请：${uid}（${event.comment ?? '无留言'}）`);
    } catch (error) {
      log(`自动通过好友申请失败 ${uid}：${error?.message ?? error}`);
    }
  });

  // 疑友列表里的申请不会走 request 事件，只能定时拉：启动 8 秒后扫一次，之后每 2 分钟一次。
  setTimeout(() => {
    void approveDoubtFriendRequests().catch((error) => {
      log(`[安全] 疑友好友申请轮询失败：${error?.message ?? error}`);
    });
  }, 8000);
  // 会话定期回收：按「距上次重建的消息条数 / 小时数」重建，带交接脉络。

  live.bot = bot;
  return bot;
}
