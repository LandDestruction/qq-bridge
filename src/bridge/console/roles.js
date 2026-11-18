// console/roles: extracted bridge responsibilities; no startup side effects.
// Live dependencies: ROLE_CONTENT_MAX_BYTES, ROLE_NAME_MAX, ROOT, STATE_DIR, VALID_MODES, api, applyRoleInjectLimit, atomicWriteJson, cfg, cleanupSocialForModeChange, clearAllSocialV2Timers, closedAgentPreset, currentMode, drainAllPromptQueues, fs, lastMode, log, normalizeModeInput, path, readConfigObject, readJsonSafe, readRoleContent, readRoleState, reconcileSessionPolicies, roleCharStats, roleFilePath, roleInjectMaxChars, roleSectionReport, roleSummaries, roleWarnings, sanitizeRoleName, scheduleProactiveCheckV2, setupSleepTimerV2, socialV2, unwrap, validateRoleContent, validateRoleName, writeRoleContent, writeRoleState
export function createConsoleRoles(deps) {
// @bridge-function handleConsoleRoles:start
async function handleConsoleRoles(request) {
        if (request.req.method === 'POST' && request.url.pathname === '/api/mode') {
          const body = await request.readBody();
          // 规范名与历史名都接受，落盘的始终是内部拼写（见 MODE_INPUT_ALIASES）。
          const requestedMode = (0, deps.normalizeModeInput)(body.mode);
          if (!requestedMode) {
            request.sendJson({ ok: false, error: `mode 必须是 ${deps.VALID_MODES.join(' / ')}（simulation 为 reserved2 的规范名）` }, 400);
            return true; /* @bridge-handled */
          }
          const existing = (0, deps.readJsonSafe)(deps.path.join(deps.STATE_DIR, 'mode.json'), {});
          const next = {
            mode: requestedMode,
            // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
            ...(body.closedAgentPreset !== undefined
              ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
              : { closedAgentPreset: String(existing.closedAgentPreset ?? '') })
          };
          (0, deps.atomicWriteJson)(deps.path.join(deps.STATE_DIR, 'mode.json'), next);
          // 用字符串判断而非真值判断：空串是「显式清空 preset」，也要生效。
          deps.closedAgentPreset = next.closedAgentPreset;
          // 写穿到 DSH 设置。refreshMode() 每 5 秒跑一次且以 DSH 的值为准（插件的 base 保证
          // 该命名空间永远有值），所以只写本地 state/mode.json 会在下一次轮询时被静默回滚。
          // 写穿的是**内部拼写**（`simulation` 会写成 `reserved2`）：DSH 里那份值会被 refreshMode
          // 读回来当 `currentMode` 用，存规范名会让下游那些 `=== 'reserved2'` 判断失效。
          let dshSynced = false;
          try {
            // unwrap() 在 result.ok 为 false 时直接抛错，所以能执行到下一行即代表写穿已成功
            // （不要在这里再判断 updated?.ok —— 解包后的值恒为真，那样的分支是死代码）。
            (0, deps.unwrap)(await deps.api.settings.update({ ns: 'qq-mode', patch: { mode: requestedMode } }), 'settings.update');
            dshSynced = true;
          } catch (error) {
            (0, deps.log)(`控制台：模式写穿 DSH 设置失败（${error?.message ?? error}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
          }
          // 下面这两个判断比较的是「模式真的变了吗」。必须用归一后的值：拿 `body.mode` 比，
          // 把 `simulation` 与 `reserved2` 当成两种模式，会在模式其实没变时清掉二代定时器与排队投递。
          if (deps.currentMode === 'reserved' && requestedMode !== 'reserved') {
            (0, deps.cleanupSocialForModeChange)();
            (0, deps.log)('控制台：模式离开一代仿真模式，清理社交状态');
          }
          if (deps.currentMode === 'reserved2' && requestedMode !== 'reserved2') {
            (0, deps.clearAllSocialV2Timers)();
            (0, deps.drainAllPromptQueues)('模式切换，已取消排队中的投递');
            (0, deps.log)('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
          }
          deps.currentMode = requestedMode;
          deps.lastMode = requestedMode;
          (0, deps.reconcileSessionPolicies)();
          if (requestedMode === 'reserved2') {
            for (const key of deps.socialV2.conversations.keys()) {
              (0, deps.setupSleepTimerV2)(key);
              (0, deps.scheduleProactiveCheckV2)(key);
            }
            (0, deps.log)('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
          }
          (0, deps.log)(`控制台：模式已设置为 ${requestedMode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
          request.sendJson({ ok: true, mode: requestedMode, closedAgentPreset: next.closedAgentPreset, dshSynced });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/role') {
          const body = await request.readBody();
          const rs = (0, deps.readRoleState)();
          if (body.role && typeof body.role === 'string') {
            const name = (0, deps.sanitizeRoleName)(body.role);
            if (!deps.fs.existsSync(deps.path.join(deps.ROOT, 'roles', name + '.md'))) {
              request.sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
              return true; /* @bridge-handled */
            }
            (0, deps.writeRoleState)(name, rs.mode);
            (0, deps.log)(`控制台：角色已设置为 ${name}`);
            request.sendJson({ ok: true, role: name });
          } else {
            (0, deps.writeRoleState)(null, rs.mode);
            (0, deps.log)('控制台：角色已清除');
            request.sendJson({ ok: true, role: null });
          }
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/role-mode') {
          const body = await request.readBody();
          const rs = (0, deps.readRoleState)();
          const mode = body.mode === 'silent' ? 'silent' : 'active';
          (0, deps.writeRoleState)(rs.role, mode);
          (0, deps.log)(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
          request.sendJson({ ok: true, roleMode: mode });
          return true; /* @bridge-handled */
        }
        // ── 人格管理 ──────────────────────────────────────────────────────────
        if (request.req.method === 'GET' && request.url.pathname === '/api/roles') {
          const rs = (0, deps.readRoleState)();
          const summaries = (0, deps.roleSummaries)();
          request.sendJson({
            // roles 保持「人格名字符串数组」的既有契约（scripts/test-console.mjs 等调用方依赖它）；
            // 富信息放在 summaries 里，新老调用方互不影响。
            roles: summaries.map((role) => role.name),
            summaries,
            current: rs.role ?? null,
            limits: { nameMax: deps.ROLE_NAME_MAX, contentMaxBytes: deps.ROLE_CONTENT_MAX_BYTES, injectMaxChars: deps.roleInjectMaxChars },
          });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'GET' && request.url.pathname === '/api/roles/content') {
          let name;
          try { name = (0, deps.validateRoleName)(request.url.searchParams.get('name')); } catch (error) { request.sendJson({ ok: false, error: error.message }, 400); return true; /* @bridge-handled */ }
          if (!deps.fs.existsSync((0, deps.roleFilePath)(name))) { request.sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return true; /* @bridge-handled */ }
          const content = (0, deps.readRoleContent)(name);
          request.sendJson({
            ok: true,
            name,
            content,
            chars: content.length,
            bytes: Buffer.byteLength(content, 'utf8'),
            warnings: (0, deps.roleWarnings)(content),
            limits: { injectMaxChars: deps.roleInjectMaxChars },
            stats: (0, deps.roleCharStats)(content),
            // 每个小节在各模式下是否会被注入，供控制台预览「这条规则到底生不生效」
            sections: { v1: (0, deps.roleSectionReport)(content, 'v1'), v2: (0, deps.roleSectionReport)(content, 'v2') },
          });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/roles/limit') {
          const body = await request.readBody();
          const next = (0, deps.applyRoleInjectLimit)(body.maxInjectChars);
          const configFile = deps.path.join(deps.ROOT, 'config.json');
          const file = (0, deps.readConfigObject)(configFile);
          file.role = { ...(file.role ?? {}), maxInjectChars: next };
          (0, deps.atomicWriteJson)(configFile, file);
          deps.cfg.role = { ...(deps.cfg.role ?? {}), maxInjectChars: next };
          deps.roleInjectMaxChars = next;
          (0, deps.log)(`控制台：人格注入上限已设为 ${next} 字符（下一条消息生效）`);
          request.sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/roles/create') {
          const body = await request.readBody();
          let name; let content;
          try { name = (0, deps.validateRoleName)(body.name); content = (0, deps.validateRoleContent)(body.content); }
          catch (error) { request.sendJson({ ok: false, error: error.message }, 400); return true; /* @bridge-handled */ }
          if (deps.fs.existsSync((0, deps.roleFilePath)(name))) { request.sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return true; /* @bridge-handled */ }
          (0, deps.writeRoleContent)(name, content);
          (0, deps.log)(`控制台：创建人格「${name}」（${content.length} 字符）`);
          request.sendJson({ ok: true, role: name, warnings: (0, deps.roleWarnings)(content) });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/roles/update') {
          const body = await request.readBody();
          let name; let content;
          try { name = (0, deps.validateRoleName)(body.name); content = (0, deps.validateRoleContent)(body.content); }
          catch (error) { request.sendJson({ ok: false, error: error.message }, 400); return true; /* @bridge-handled */ }
          if (!deps.fs.existsSync((0, deps.roleFilePath)(name))) { request.sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return true; /* @bridge-handled */ }
          (0, deps.writeRoleContent)(name, content);
          (0, deps.log)(`控制台：更新人格「${name}」（${content.length} 字符）`);
          request.sendJson({ ok: true, role: name, chars: content.length, warnings: (0, deps.roleWarnings)(content) });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/roles/rename') {
          const body = await request.readBody();
          let from; let to;
          try { from = (0, deps.validateRoleName)(body.from); to = (0, deps.validateRoleName)(body.to); }
          catch (error) { request.sendJson({ ok: false, error: error.message }, 400); return true; /* @bridge-handled */ }
          if (from === to) { request.sendJson({ ok: true, role: to, renamed: false }); return true; /* @bridge-handled */ }
          if (!deps.fs.existsSync((0, deps.roleFilePath)(from))) { request.sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return true; /* @bridge-handled */ }
          if (deps.fs.existsSync((0, deps.roleFilePath)(to))) { request.sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return true; /* @bridge-handled */ }
          deps.fs.renameSync((0, deps.roleFilePath)(from), (0, deps.roleFilePath)(to));
          const rs = (0, deps.readRoleState)();
          const switched = rs.role === from;
          if (switched) (0, deps.writeRoleState)(to, rs.mode);
          (0, deps.log)(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
          request.sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/roles/delete') {
          const body = await request.readBody();
          let name;
          try { name = (0, deps.validateRoleName)(body.name); } catch (error) { request.sendJson({ ok: false, error: error.message }, 400); return true; /* @bridge-handled */ }
          if (!deps.fs.existsSync((0, deps.roleFilePath)(name))) { request.sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return true; /* @bridge-handled */ }
          deps.fs.rmSync((0, deps.roleFilePath)(name));
          const rs = (0, deps.readRoleState)();
          const cleared = rs.role === name;
          if (cleared) (0, deps.writeRoleState)(null, rs.mode);
          (0, deps.log)(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
          request.sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
          return true; /* @bridge-handled */
        }
    return false;
  }
// @bridge-function handleConsoleRoles:end
  return { handleConsoleRoles };
}
