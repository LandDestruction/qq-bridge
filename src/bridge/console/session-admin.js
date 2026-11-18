// console/session-admin: extracted bridge responsibilities; no startup side effects.
// Live dependencies: REASONING_EFFORT_DEFAULT, REASONING_EFFORT_OPTIONS, ROOT, SLANG_STATUS, atomicWriteJson, cfg, fetchModelCatalog, invalidateSlangLearnerSession, log, modelCatalogErrorLogged, modelCatalogInFlight, normalizeOwnerQQ, path, pending, queueSlangTask, readConfigObject, reconcileSessionPolicies, runSlangExtraction, runSlangResearch, slangEntries, slangWindows, state, unwrap, updateConfigFile, withTimeout
export function createConsoleSessionAdmin(deps) {
// @bridge-function handleConsoleSessionAdmin:start
async function handleConsoleSessionAdmin(request) {
        if (request.req.method === 'POST' && request.url.pathname === '/api/slang/extract') {
          if (deps.cfg.slang?.enabled === false) { request.sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return true; /* @bridge-handled */ }
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          if (key && deps.slangWindows.has(key)) {
            (0, deps.queueSlangTask)(() => (0, deps.runSlangExtraction)(key));
            request.sendJson({ ok: true, key });
          } else {
            const firstKey = deps.slangWindows.keys().next().value;
            if (!firstKey) { request.sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return true; /* @bridge-handled */ }
            (0, deps.queueSlangTask)(() => (0, deps.runSlangExtraction)(firstKey));
            request.sendJson({ ok: true, key: firstKey });
          }
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/slang/research') {
          if (deps.cfg.slang?.enabled === false) { request.sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return true; /* @bridge-handled */ }
          const body = await request.readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          const candidates = ids.length
            ? deps.slangEntries.filter((e) => ids.includes(e.id) && e.status === deps.SLANG_STATUS.CANDIDATE)
            : deps.slangEntries.filter((e) => e.status === deps.SLANG_STATUS.CANDIDATE);
          if (!candidates.length) { request.sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return true; /* @bridge-handled */ }
          (0, deps.queueSlangTask)(() => (0, deps.runSlangResearch)(candidates));
          request.sendJson({ ok: true, count: candidates.length });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/slang/config') {
          const body = await request.readBody();
          const oldPreset = deps.cfg.slang?.learnerPreset;
          const oldWorkspaceTitle = deps.cfg.slang?.workspaceTitle;
          const configFile = deps.path.join(deps.ROOT, 'config.json');
          const file = (0, deps.readConfigObject)(configFile);
          const merged = { ...(file.slang ?? {}), ...body };
          if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
          else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
          if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
          if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
          if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
          if (merged.autoConfirmWeb !== undefined) merged.autoConfirmWeb = merged.autoConfirmWeb === true;
          if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
          if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
          if (body.inferenceThresholds !== undefined) {
            const raw = Array.isArray(body.inferenceThresholds)
              ? body.inferenceThresholds
              : String(body.inferenceThresholds).split(/[,，\s]+/);
            merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
            if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [1, 3, 6];
          }
          // 读盘-合并-写：slang 段以本次归一化结果为准，但磁盘上其它段（并发写入）不能被这份快照回滚。
          (0, deps.updateConfigFile)(configFile, (disk) => { disk.slang = merged; }, { atomicWrite: deps.atomicWriteJson });
          deps.cfg.slang = { ...deps.cfg.slang, ...merged };
          if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
            (0, deps.invalidateSlangLearnerSession)();
            (0, deps.log)('黑话学习 preset 已变更，已重置学习会话');
          } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
            (0, deps.invalidateSlangLearnerSession)();
            (0, deps.log)('黑话学习工作区名已变更，已重置学习会话');
          }
          (0, deps.log)('控制台：黑话系统配置已更新');
          request.sendJson({ ok: true, config: deps.cfg.slang });
          return true; /* @bridge-handled */
        }
        // ── 会话查看 ──────────────────────────────────────────────────────────
        if (request.req.method === 'GET' && request.url.pathname === '/api/sessions') {
          const list = [];
          for (const [key, sessionId] of Object.entries(deps.state.sessions)) {
            list.push({ key, sessionId, owner: key === `private:${String(deps.cfg.ownerQQ ?? '')}` });
          }
          request.sendJson({ sessions: list });
          return true; /* @bridge-handled */
        }
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
        if (request.req.method === 'GET' && request.url.pathname === '/api/pending') {
          const list = [];
          for (const [key, p] of deps.pending.entries()) {
            list.push({
              key,
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }
          request.sendJson({ pending: list });
          return true; /* @bridge-handled */
        }
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
        if (request.req.method === 'GET' && request.url.pathname === '/api/whitelist') {
          request.sendJson({ allow: deps.cfg.allow ?? { private: [], groups: [] }, deny: deps.cfg.deny ?? { private: [], groups: [] }, ownerQQ: deps.cfg.ownerQQ ?? null });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/whitelist') {
          const body = await request.readBody();
          const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
          const configFile = deps.path.join(deps.ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = (0, deps.readConfigObject)(configFile);
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = deps.cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = (0, deps.normalizeOwnerQQ)(body.ownerQQ);
            } catch (error) {
              request.sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return true; /* @bridge-handled */
            }
          }
          const privateOpen = body.allow?.privateOpen === undefined
            ? (file.allow?.privateOpen === true)
            : body.allow.privateOpen === true;
          // 读盘-合并-写：只改 allow/deny/ownerQQ 三段，其余字段按磁盘最新内容保留（避免整份回滚）。
          (0, deps.updateConfigFile)(configFile, (disk) => { disk.allow = { ...allow, privateOpen }; disk.deny = deny; disk.ownerQQ = ownerQQ; }, { atomicWrite: deps.atomicWriteJson });
          deps.cfg.allow = { private: allow.private, groups: allow.groups, privateOpen };
          deps.cfg.deny = { private: deny.private, groups: deny.groups };
          deps.cfg.ownerQQ = ownerQQ;
          (0, deps.reconcileSessionPolicies)();
          (0, deps.log)(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
          request.sendJson({ ok: true, allow, deny, ownerQQ });
          return true; /* @bridge-handled */
        }

        // ── DSH 模型与思考强度 ───────────────────────────────────────────────
        if (request.req.method === 'GET' && request.url.pathname === '/api/dsh/model') {
          const provider = String(deps.cfg.dsh?.provider || 'deepseek-official');
          const model = String(deps.cfg.dsh?.model || 'deepseek-flash');
          // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
          let options = deps.REASONING_EFFORT_OPTIONS.slice();
          let labels = {};
          let providerDefault = null;
          let catalogSource = 'fallback';
          try {
            if (!deps.modelCatalogInFlight) {
              deps.modelCatalogInFlight = (0, deps.withTimeout)((0, deps.fetchModelCatalog)(), 3000, 'session/modelCatalog')
                .finally(() => { deps.modelCatalogInFlight = null; });
            }
            const catalog = (0, deps.unwrap)(await deps.modelCatalogInFlight, 'session.modelCatalog');
            const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
            const entry = (group?.models ?? []).find((m) => m?.id === model);
            const efforts = entry?.reasoning?.efforts ?? [];
            const advertised = efforts.map((e) => String(e?.id ?? '')).filter((id) => deps.REASONING_EFFORT_OPTIONS.includes(id));
            if (advertised.length) {
              options = advertised;
              labels = Object.fromEntries(efforts.map((e) => [String(e.id), { name: e.name ?? '', description: e.description ?? '' }]));
              providerDefault = entry.reasoning.defaultEffort ?? null;
              catalogSource = 'dsh';
            }
          } catch (error) {
            // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
            const reason = String(error?.message ?? error);
            if (!deps.modelCatalogErrorLogged.has(reason)) {
              deps.modelCatalogErrorLogged.add(reason);
              (0, deps.log)(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
            }
          }
          request.sendJson({
            provider,
            model,
            reasoningEffort: String(deps.cfg.dsh?.reasoningEffort || deps.REASONING_EFFORT_DEFAULT),
            options,
            labels,
            default: deps.REASONING_EFFORT_DEFAULT,
            providerDefault,
            catalogSource,
            // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
            // 控制台要把这点明确告诉管理员，避免「只想调 QQ 助手却改了 Web GUI 新会话默认」的意外。
            globalSideEffect: true,
          });
          return true; /* @bridge-handled */
        }
    return false;
  }
// @bridge-function handleConsoleSessionAdmin:end
  return { handleConsoleSessionAdmin };
}
