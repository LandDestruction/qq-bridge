// console/presets: extracted bridge responsibilities; no startup side effects.
// Live dependencies: PRESET_BACKUP_DIR, PRESET_NAMES, atomicWriteText, backupPresetFile, extractPresetPrefix, fs, installedPresetYaml, knownPresetName, listPresetBackups, log, path, presetPromptBlockers, presetPromptWarnings, presetSourceYaml, presetStatus, readPresetPromptText, renderPresetPromptYaml
export function createConsolePresets(deps) {
// @bridge-function handleConsolePresets:start
async function handleConsolePresets(request) {

        // ── 仿真提示词（一代 / 二代各自的预设内置提示词）──────────────────────
        if (request.req.method === 'GET' && request.url.pathname === '/api/preset/sim-prompt') {
          const preset = (0, deps.knownPresetName)(request.url.searchParams.get('preset'));
          if (!preset) { request.sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(deps.PRESET_NAMES).join(' / ')}）` }, 400); return true; /* @bridge-handled */ }
          try {
            const { prefix } = (0, deps.readPresetPromptText)(preset);
            request.sendJson({
              ok: true,
              content: prefix,
              chars: prefix.length,
              bytes: Buffer.byteLength(prefix, 'utf8'),
              warnings: (0, deps.presetPromptWarnings)(prefix),
              status: (0, deps.presetStatus)(preset),
              presets: Object.values(deps.PRESET_NAMES).map((n) => (0, deps.presetStatus)(n)),
            });
          } catch (error) {
            request.sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: (0, deps.presetStatus)(preset) }, 500);
          }
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/preset/sim-prompt') {
          const body = await request.readBody();
          const preset = (0, deps.knownPresetName)(body.preset);
          if (!preset) { request.sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(deps.PRESET_NAMES).join(' / ')}）` }, 400); return true; /* @bridge-handled */ }
          let nextText;
          try {
            const { text, prefix } = (0, deps.readPresetPromptText)(preset);
            // 内容没变就不要写：写回会把折叠块规整成字面量块（值不变但排版变化），
            // 让一次"打开又保存"把整个提示词块变成全删全加的 diff，失去可复审性。
            const normalized = String(body.content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
            if (normalized === prefix) {
              request.sendJson({ ok: true, unchanged: true, chars: prefix.length, warnings: (0, deps.presetPromptWarnings)(prefix), synced: deps.fs.existsSync((0, deps.installedPresetYaml)(preset)), requiresRestart: false, status: (0, deps.presetStatus)(preset) });
              return true; /* @bridge-handled */
            }
            nextText = (0, deps.renderPresetPromptYaml)(text, body.content, preset === deps.PRESET_NAMES.v1 ? 'v1' : 'v2');
          } catch (error) {
            request.sendJson({ ok: false, error: error?.message ?? '校验失败' }, 400);
            return true; /* @bridge-handled */
          }
          const warnings = (0, deps.presetPromptWarnings)(body.content);
          let sourceBackup = null;
          try {
            sourceBackup = (0, deps.backupPresetFile)(preset);
            (0, deps.atomicWriteText)((0, deps.presetSourceYaml)(preset), nextText);
            // 同步到 DSH 实际读取的安装目录。
            // 注意：安装副本**不做仓库内备份**——它的内容与刚写好的源文件一致，
            // 备份它等于把含本机绝对路径的快照塞进仓库工作区，没有额外价值。
            const installed = (0, deps.installedPresetYaml)(preset);
            if (deps.fs.existsSync(installed)) {
              deps.fs.copyFileSync((0, deps.presetSourceYaml)(preset), installed);
            }
          } catch (error) {
            // 尽力回滚源文件，避免留下半截状态
            if (sourceBackup && deps.fs.existsSync(sourceBackup)) {
              try { deps.fs.copyFileSync(sourceBackup, (0, deps.presetSourceYaml)(preset)); } catch {}
            }
            request.sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
            return true; /* @bridge-handled */
          }
          (0, deps.log)(`控制台：${preset} 仿真提示词已更新（${String(body.content ?? '').length} 字符）${warnings.length ? `，${warnings.length} 条警告` : ''}；需重启 DSH 生效`);
          request.sendJson({
            ok: true,
            chars: String(body.content ?? '').length,
            warnings,
            synced: deps.fs.existsSync((0, deps.installedPresetYaml)(preset)),
            requiresRestart: true,
            status: (0, deps.presetStatus)(preset),
          });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'GET' && request.url.pathname === '/api/preset/sim-prompt/backups') {
          const preset = (0, deps.knownPresetName)(request.url.searchParams.get('preset'));
          if (!preset) { request.sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(deps.PRESET_NAMES).join(' / ')}）` }, 400); return true; /* @bridge-handled */ }
          try {
            request.sendJson({ ok: true, backups: (0, deps.listPresetBackups)(preset) });
          } catch (error) {
            request.sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500);
          }
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/preset/sim-prompt/restore') {
          const body = await request.readBody();
          const preset = (0, deps.knownPresetName)(body.preset);
          if (!preset) { request.sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(deps.PRESET_NAMES).join(' / ')}）` }, 400); return true; /* @bridge-handled */ }
          try {
            const requested = String(body.file ?? '').trim();
            const candidates = (0, deps.listPresetBackups)(preset).map((b) => b.file);
            const target = requested || candidates[0];
            // 只允许还原本预设目录下的备份文件，拒绝任何路径穿越
            if (!target || !candidates.includes(target)) { request.sendJson({ ok: false, error: '没有可用的备份' }, 400); return true; /* @bridge-handled */ }
            const backupPath = deps.path.join(deps.PRESET_BACKUP_DIR, target);
            const restored = deps.fs.readFileSync(backupPath, 'utf8');
            const restoredPrefix = (0, deps.extractPresetPrefix)(restored);
            if (restoredPrefix === null) { request.sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return true; /* @bridge-handled */ }
            // 还原路径必须与保存路径同样严格：旧备份可能来自安全基线加入之前，
            // 直接还原会把弱化版提示词（缺「你没有本地工具」等不变量）写回去。
            // 不变量清单**按预设取**：一代本来就没有「你没有本地工具」这类工具面表述。
            const blockers = (0, deps.presetPromptBlockers)(restoredPrefix, preset === deps.PRESET_NAMES.v1 ? 'v1' : 'v2');
            if (blockers.length) {
              request.sendJson({ ok: false, error: `该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}` }, 400);
              return true; /* @bridge-handled */
            }
            (0, deps.backupPresetFile)(preset);
            (0, deps.atomicWriteText)((0, deps.presetSourceYaml)(preset), restored);
            const installed = (0, deps.installedPresetYaml)(preset);
            if (deps.fs.existsSync(installed)) deps.fs.copyFileSync((0, deps.presetSourceYaml)(preset), installed);
            (0, deps.log)(`控制台：${preset} 仿真提示词已还原自备份 ${target}；需重启 DSH 生效`);
            request.sendJson({ ok: true, restoredFrom: target, requiresRestart: true });
          } catch (error) {
            request.sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
          }
          return true; /* @bridge-handled */
        }
    return false;
  }
// @bridge-function handleConsolePresets:end
  return { handleConsolePresets };
}
