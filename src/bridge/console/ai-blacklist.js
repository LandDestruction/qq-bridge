// console/ai-blacklist: extracted bridge responsibilities; no startup side effects.
// Live dependencies: aiBlacklist, aiBlacklistAdmin, cfg, log, reloadConfigFromDisk
export function createConsoleAiBlacklist(deps) {
// @bridge-function handleConsoleAiBlacklist:start
async function handleConsoleAiBlacklist(request) {
        const pathname = request.url.pathname;
        if (pathname !== '/api/socialV2/ai-blacklist') return false;
        // 和 /api/affinity 同口径：MCP 工具进程也持有控制台令牌，不能只靠令牌区分管理员。
        if (request.req.headers['x-agent-call'] !== undefined || request.req.headers['x-agent-token']) {
          request.sendJson({ ok: false, code: 'admin_only', error: 'AI 黑名单只允许管理端读写（智能体不得自行改名单）' }, 403);
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'GET') {
          const conf = (0, deps.aiBlacklist).config();
          request.sendJson({
            ok: true,
            enabled: conf.enabled,
            mode: conf.mode,
            minIntervalMs: conf.minIntervalMs,
            perHourMax: conf.perHourMax,
            atMeReply: conf.atMeReply,
            qq: conf.qq,
            stats: (0, deps.aiBlacklist).stats()
          });
          return true; /* @bridge-handled */
        }
        if (request.req.method !== 'POST') {
          request.sendJson({ ok: false, error: '只支持 GET/POST' }, 405);
          return true; /* @bridge-handled */
        }
        const body = await request.readBody().catch(() => ({}));
        const action = String(body.action ?? '').trim();
        try {
          if (action === 'add') {
            const next = (0, deps.aiBlacklistAdmin).add(body.qq, body.note);
            deps.cfg.socialV2 = deps.cfg.socialV2 && typeof deps.cfg.socialV2 === 'object' ? deps.cfg.socialV2 : {};
            deps.cfg.socialV2.aiBlacklist = next;
            (0, deps.log)(`[AI黑名单] 已添加 qq=${String(body.qq ?? '').trim()}（共 ${next.qq.length} 个）`);
          } else if (action === 'remove') {
            const next = (0, deps.aiBlacklistAdmin).remove(body.qq);
            deps.cfg.socialV2 = deps.cfg.socialV2 && typeof deps.cfg.socialV2 === 'object' ? deps.cfg.socialV2 : {};
            deps.cfg.socialV2.aiBlacklist = next;
            (0, deps.log)(`[AI黑名单] 已移除 qq=${String(body.qq ?? '').trim()}（剩 ${next.qq.length} 个）`);
          } else if (action === 'toggle') {
            const next = (0, deps.aiBlacklistAdmin).toggle(body.enabled === true);
            deps.cfg.socialV2 = deps.cfg.socialV2 && typeof deps.cfg.socialV2 === 'object' ? deps.cfg.socialV2 : {};
            deps.cfg.socialV2.aiBlacklist = next;
            (0, deps.log)(`[AI黑名单] 已${next.enabled ? '开启' : '关闭'}`);
          } else {
            request.sendJson({ ok: false, code: 'bad_action', error: 'action 只支持 add / remove / toggle' }, 400);
            return true; /* @bridge-handled */
          }
          // 写盘成功后再触发一次热加载（fs.watch 也会约 1 秒内 reload；这里让下一次判定立刻用新值）。
          try { (0, deps.reloadConfigFromDisk)('ai-blacklist'); } catch {}
          const conf = (0, deps.aiBlacklist).config();
          request.sendJson({ ok: true, enabled: conf.enabled, mode: conf.mode, qq: conf.qq, stats: (0, deps.aiBlacklist).stats() });
          return true; /* @bridge-handled */
        } catch (error) {
          request.sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
          return true; /* @bridge-handled */
        }
        // 走到这里说明路径没匹配上（readBridgeSource 的路由展开按最后这个 return false; 切片）。
        return false;
      }
// @bridge-function handleConsoleAiBlacklist:end
  return { handleConsoleAiBlacklist };
}
