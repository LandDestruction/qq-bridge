// 连接生命周期（上线提醒、token 自愈、断线重连）（拆分自 src/bridge.js main()，行为与拆分前完全一致）。
// 纯搬运：语句顺序、日志文案与 try/catch 边界都不动；无 import，依赖全部由 deps 注入，
// 这样审计沙箱的 VM 剥掉 import 后仍能直接执行（见 scripts/bridge-source.mjs）。
export async function watchConnection(deps) {
  const { states, wired, live, log, path, STATE_DIR, isDuplicateNotice, readNoticeStamp, formatNoticeText, atomicWriteJson, applyIdentityCheck } = deps;
  const { healTokenIfStale, pollSnowlumaStatus, sendToQQ, syncTokenToFile } = wired;
  const { stConfig, stHealth, stModelSession } = states;
  const bot = live.bot;
  // 先把「名单/是否启用」登记进 live.identityLock（此时还没连上，ready=false 不会误锁），
  // 这样控制台在未连接时也能看到「身份锁：已启用，等待登录号」而不是「未启用」。
  try { applyIdentityCheck?.(null); } catch {}
  // 本次进程是否已发过「上线提醒」（重连不重复打扰）
  let startupNoticeSent = false;
  bot.on('open', () => {
    void (async () => {
      let login;
      try {
        login = await deps.verifyConnectedIdentity();
      } catch (error) {
        stHealth.snowlumaHealth.connected = false;
        log(`[安全] WebSocket 登录身份复核失败，关闭连接：${error?.message ?? error}`);
        try { bot.close(4003, 'identity-mismatch'); }
        catch (closeError) { log(`[安全] 关闭未验证连接失败：${closeError?.message ?? closeError}`); }
        return;
      }
      // 只有身份验证通过后，才把连接视为在线或执行任何依赖身份的副作用。
      const connectedUrl = bot.url ?? stConfig.cfg.snowluma.wsUrl;
      stHealth.snowlumaHealth.connected = true;
      log(`SnowLuma 已连接：${connectedUrl}`);
      void pollSnowlumaStatus();
      if (login?.nickname) {
        stModelSession.selfNickname = String(login.nickname).toLowerCase();
        stModelSession.selfDisplayName = String(login.nickname).trim();
        log(`机器人昵称: ${login.nickname}`);
      }
      if (login?.user_id != null) stModelSession.selfUserId = String(login.user_id);
      if (!live.identityTimer) {
        live.identityTimer = setInterval(() => {
          if (!stHealth.snowlumaHealth.connected) return;
          void deps.verifyConnectedIdentity().catch((error) => {
            stHealth.snowlumaHealth.connected = false;
            log(`[安全] 定时身份复核失败，关闭连接：${error?.message ?? error}`);
            try { bot.close(4003, 'identity-mismatch'); }
            catch (closeError) { log(`[安全] 关闭未验证连接失败：${closeError?.message ?? closeError}`); }
          });
        }, 60 * 1000);
        live.identityTimer.unref?.();
      }
      void syncTokenToFile();
      const noticeStampFile = path.join(STATE_DIR, 'startup-notice.json');
      if (!startupNoticeSent && stConfig.cfg.ownerQQ) {
        startupNoticeSent = true;
        setTimeout(() => {
          if (isDuplicateNotice(readNoticeStamp(noticeStampFile))) {
            log('上线提醒 10 分钟内已发过，跳过本条');
            return;
          }
          sendToQQ(`private:${stConfig.cfg.ownerQQ}`, formatNoticeText())
            .then(() => {
              try { atomicWriteJson(noticeStampFile, { at: Date.now() }); } catch (error) { log(`上线提醒状态写入失败：${error?.message ?? error}`); }
              log(`已向管理员 ${stConfig.cfg.ownerQQ} 发送上线提醒`);
            })
            .catch((error) => log(`上线提醒发送失败：${error?.message ?? error}`));
        }, 2000);
      }
    })();
  });

  /**
   * SnowLuma 恢复连接时自愈 accessToken。
   *
   * 为什么需要：SnowLuma 的 OneBot 配置按账号分文件（config/onebot_<QQ号>.json），
   * 每个账号 token 不同。换账号登录后，config.json 里的旧 token 会 401/连不上，
   * 而 SDK 的重连会一直用**构造时**那个 token 无限重试 —— 表现为"桥接活着但收发全废"。
   * 这里在每次重连失败时重新发现当前账号的 token 并热更新，随后自愈。
   */
  /**
   * 应用自愈结果：**HTTP token 与 WS token 是两个不同的值**。
   *   - stConfig.cfg.snowluma.accessToken → HTTP 调用（发语音、fetch_ptt_text、get_msg 等）与写回 config.json
   *   - bot.accessToken          → WebSocket 连接（桥接的主链路，端口 3001）
   * 只修其中一个的话，桥接仍会以 1006 反复重连（实测踩过）。
   */
  // @bridge-function applyHealedTokens from login-recovery

  /** 只写文件、不动物件（连接已成功时用）。 */
  // @bridge-function syncTokenToFile from login-recovery

  live.tokenHealAt = 0;
  // @bridge-function healTokenIfStale from login-recovery

  bot.on('close', (info) => {
    stHealth.snowlumaHealth.connected = false;
    // 断线后不能沿用上次已验证的账号：重连期间所有出站必须 fail-closed。
    try { deps.applyIdentityCheck?.(null); } catch (error) { log(`[安全] 断线后重置身份状态失败：${error?.message ?? error}`); }
    log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`);
    // 连不上时最常见的原因就是换了 QQ 账号 → token 变了；顺手自愈。
    // 注意 1006 在**每次启动**都可能出现一次：HTTP token 与 WS token 是两个不同的值，
    // config.json 里存的是前者，WS 需要用自愈发现的那个（详见 bot.connect() 处的说明）。
    void healTokenIfStale(`close code=${info?.code ?? '?'}`);
  });
  bot.on('error', (error) => {
    // SDK 在 WS 升级被拒（401 / 建连失败）时可能**只 emit error、不 emit close**，
    // 于是挂在 close 上的 token 自愈永远不会触发 —— 表现为「桥接活着但收发全废」，
    // 用户只能靠手工改 token 绕过去（issue #19）。这里同样尝试一次（内部有 10s 节流）。
    const detail = error && typeof error === 'object'
      ? [error.code, error.message, error.reason, error.type].filter(Boolean).join(' | ') || JSON.stringify(error)
      : String(error ?? '');
    log(`SnowLuma 错误：${detail || '(无详情)'}`);
    void healTokenIfStale(`error ${detail}`.trim().slice(0, 200));
  });

  // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
  bot.connect().catch((error) => {
    // 说明为什么"第一次连不上"在这里几乎是**必然**的，避免用户把它当成故障：
    // SnowLuma 的 **HTTP token（默认 3000）与 WS token（默认 3001）是两个不同的值**
    // （实测：同一个账号，两者不同；config.json 只能存一个，存的是 HTTP 那个）。
    // 所以 WS 首次连接通常会被拒 → close(1006) → 触发 token 自愈（重新发现 WS token）
    // → 重连成功后才是「SnowLuma 已连接」。若 homeDir 没配/被移动/读不到 SnowLuma 的
    // config/onebot_<QQ>.json，自愈就无从下手，这时才会一直连不上 —— 那种情况请查
    // 日志里的「token 自愈失败」与 config.json 的 snowluma.homeDir。
    log(`SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）: ${error?.message ?? error}`);
  });
}
