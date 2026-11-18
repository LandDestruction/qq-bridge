// console/imagegen-config：出图两档（免费档 / 高质量档）的查看与改 key。
//
// 契约：
//   GET  /api/imagegen/providers  → providersView(cfg, 今日配额)，key 只回尾巴
//   POST /api/imagegen/providers  → { slot, apiKey?, model?, baseUrl?, endpoint?, size?,
//                                     mode?, dailyLimit?, enabled?, promptTranslate? }
// 安全：
//   · 带 x-agent-token / x-agent-call 的调用一律 403 —— 密钥是管理端的秘密，
//     模型侧不需要、也不该能看出「key 长什么样」；
//   · key 原文永不回传、永不进日志（只记 slot 与尾巴）。
export function createConsoleImagegen(deps) {
// @bridge-function handleConsoleImagegen:start
async function handleConsoleImagegen(request) {
        if (request.url.pathname !== '/api/imagegen/providers') return false;
        const headers = request.req.headers || {};
        if (headers['x-agent-token'] || headers['x-agent-call']) {
          request.sendJson({ ok: false, error: '出图密钥只允许管理端查看/修改' }, 403);
          return true; /* @bridge-handled */
        }

        const quotaNow = () => {
          try {
            const q = (0, deps.readQuota)(Date.now());
            return q && typeof q === 'object' ? { date: q.date, used: q.used } : null;
          } catch { return null; }
        };

        if (request.req.method === 'GET') {
          request.sendJson((0, deps.providersView)(deps.cfg, quotaNow()));
          return true; /* @bridge-handled */
        }

        if (request.req.method !== 'POST') {
          request.sendJson({ ok: false, error: '只支持 GET/POST' }, 405);
          return true; /* @bridge-handled */
        }

        const body = await request.readBody();
        // 以磁盘最新值为基线：页面上只改一档，不能把另一档刚配好的 key 覆盖掉。
        const diskCfg = (0, deps.readConfigObject)(deps.path.join(deps.ROOT, 'config.json'));
        const base = diskCfg?.imagegen && typeof diskCfg.imagegen === 'object'
          ? diskCfg.imagegen
          : (deps.cfg?.imagegen && typeof deps.cfg.imagegen === 'object' ? deps.cfg.imagegen : {});
        const merged = (0, deps.applyProviderPatch)(base, body);
        if (!merged.ok) {
          request.sendJson({ ok: false, error: merged.error }, 400);
          return true; /* @bridge-handled */
        }
        try {
          (0, deps.updateConfigFile)(deps.path.join(deps.ROOT, 'config.json'), (disk) => {
            disk.imagegen = merged.next;
          }, { atomicWrite: deps.atomicWriteJson });
        } catch (error) {
          (0, deps.log)(`[imagegen] 写入 config.json 失败：${error?.message ?? error}`);
          request.sendJson({ ok: false, error: `写入 config.json 失败：${error?.message ?? error}` }, 500);
          return true; /* @bridge-handled */
        }
        deps.cfg.imagegen = merged.next;
        try { (0, deps.reloadConfigFromDisk)('imagegen-providers'); } catch {}
        const slot = String(body.slot);
        const tail = (0, deps.keyTail)(merged.next?.[slot]?.apiKey);
        (0, deps.log)(`[imagegen] ${slot} 已更新（key=${tail ? `…${tail}` : '未设置'} model=${merged.next?.[slot]?.model || '-'}）`);
        request.sendJson({
          ...(0, deps.providersView)(deps.cfg, quotaNow()),
          persisted: true,
          restartRequired: true,
          note: '已写盘。桥接立刻生效；模型侧（qq_draw）要重启桌面客户端 DSH 才会重新注册或消失。'
        });
        return true; /* @bridge-handled */
      }
// @bridge-function handleConsoleImagegen:end
  return { handleConsoleImagegen };
}
