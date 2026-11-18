// 启动收尾（记账、后台 watch、控制台、消息等）（拆分自 src/bridge.js main()，行为与拆分前完全一致）。
// 纯搬运：语句顺序、日志文案与 try/catch 边界都不动；无 import，依赖全部由 deps 注入，
// 这样审计沙箱的 VM 剥掉 import 后仍能直接执行（见 scripts/bridge-source.mjs）。
export async function finishStartup(deps) {
  const { states, wired, live, path, STATE_DIR, fs, log, spawn } = deps;
  const { archivePrune, backfillMessageDb, pumpMux, saveStickerStoreSafe, startConfigWatcher, startConsoleServer, startDshWatch, startSnowlumaWatch, startTurnWatchdog, syncStickerLibrary } = wired;
  const { stConfig } = states;
  // 重启记账：以前只能翻多天的 stdout 猜「今天重启了几次」，现在每次启动/退出都落一行。
  try {
    const bootFile = path.join(STATE_DIR, 'boot-log.jsonl');
    fs.appendFileSync(bootFile, JSON.stringify({ t: Date.now(), event: 'start', pid: process.pid, ppid: process.ppid, up: Math.round(process.uptime() * 1000) }) + '\n');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const bootsToday = fs.readFileSync(bootFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && x.event === 'start' && x.t >= today.getTime()).length;
    try { startConfigWatcher(); } catch (error) { log(`[配置] watcher 启动失败：${error?.message ?? error}`); }
  try { startTurnWatchdog(); } catch (error) { log(`[看门狗] 启动失败：${error?.message ?? error}`); }
  log(`桥接已启动。今日第 ${bootsToday} 次启动（pid ${process.pid}）。按 Ctrl+C 退出。`);
  } catch {
    log('桥接已启动。按 Ctrl+C 退出。');
  }
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (stConfig.cfg.socialV2?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  startDshWatch();
  startSnowlumaWatch();
  startConsoleServer();
  // ── GPT-SoVITS 常驻服务：启动时检测 9880，没响应则后台拉起 ─────────────────
  // 为什么在这里做：GSV 是独立进程，重启 DSH/桥接不会自动拉起它，机器人 TTS 会变
  // 「fetch failed → 没有语音」（2026-11-03 14:49 实测）。detached + unref 让它脱离桥接
  // 进程树（桥接退出不杀 GSV）；spawn 在审计沙箱里是 null，真机才有，故 typeof 兜底。
  // 检测用 fetch 连根路径：只要 TCP/HTTP 有响应（哪怕 404）都算在线，直接 return。
  void (async () => {
    try {
      const tts = stConfig.cfg?.socialV2?.tts || {};
      if (tts.provider !== 'gsv' || typeof spawn !== 'function') return;
      const gsvUrl = String(tts.gsvUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '');
      const alive = await fetch(gsvUrl + '/', { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false);
      if (alive) return;
      const gsvPython = String(tts.gsvPython || 'E:\\qqtools\\venv310\\Scripts\\python.exe');
      const gsvRoot = String(tts.gsvRoot || 'E:\\qqtools\\GPT-SoVITS');
      const gsvConfig = String(tts.gsvConfig || 'GPT_SoVITS/configs/tts_infer.yaml');
      const child = spawn(gsvPython, ['api_v2.py', '-a', '127.0.0.1', '-p', '9880', '-c', gsvConfig], { cwd: gsvRoot, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref?.();
      log('[tts] GPT-SoVITS 未运行，已后台拉起（' + gsvPython + '）');
    } catch (error) {
      log('[tts] GPT-SoVITS 自启检测失败：' + (error?.message ?? error));
    }
  })();
  // 启动时清理过期归档（7 天滚动）。
  archivePrune(); // stickerPolicyMigrated
  // 表情包迁移：老数据没有 policy 字段，一律先按「只看不发」，等人工注释后再放行。
  try {
    let migrated = 0;
    for (const e of stConfig.stickerEntries) {
      if (!e.policy) { e.policy = 'understand-only'; migrated += 1; }
    }
    if (migrated) { saveStickerStoreSafe(); log(`表情库迁移：${migrated} 个表情设为「只看不发」`); }
  } catch {}
  backfillMessageDb();

  await pumpMux();
}
