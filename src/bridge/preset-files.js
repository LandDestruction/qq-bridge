// preset-files: extracted bridge responsibilities; no startup side effects.
// Live dependencies: PRESET_BACKUP_DIR, PRESET_BACKUP_KEEP, PRESET_NAMES, ROOT, extractPresetPrefix, fs, os, path
export function createPresetFiles(deps) {
// @bridge-function knownPresetName:start
function knownPresetName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return deps.PRESET_NAMES.v2;
  return Object.values(deps.PRESET_NAMES).includes(name) ? name : null;
}
// @bridge-function knownPresetName:end

// @bridge-function presetSourceYaml:start
function presetSourceYaml(name) {
  return deps.path.join(deps.ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
}
// @bridge-function presetSourceYaml:end

// @bridge-function dshHomeDir:start
function dshHomeDir() {
  return process.env.DSH_HOME || deps.path.join(deps.os.homedir(), '.dsh');
}
// @bridge-function dshHomeDir:end

// @bridge-function installedPresetYaml:start
function installedPresetYaml(name) {
  return deps.path.join(dshHomeDir(), '.agent-presets', name, 'agent.cordis.yml');
}
// @bridge-function installedPresetYaml:end

// @bridge-function readPresetPromptText:start
function readPresetPromptText(name) {
  const file = presetSourceYaml(name);
  if (!deps.fs.existsSync(file)) throw new Error(`找不到预设文件 ${deps.path.relative(deps.ROOT, file)}`);
  const text = deps.fs.readFileSync(file, 'utf8');
  const prefix = (0, deps.extractPresetPrefix)(text);
  if (prefix === null) throw new Error('预设里找不到 persona.prefix（结构可能已变化）');
  return { text, prefix };
}
// @bridge-function readPresetPromptText:end

// @bridge-function presetBackupPrefix:start
function presetBackupPrefix(name) {
  return `${name}.${deps.path.basename(presetSourceYaml(name))}`;
}
// @bridge-function presetBackupPrefix:end

// @bridge-function backupPresetFile:start
function backupPresetFile(name) {
  const file = presetSourceYaml(name);
  if (!deps.fs.existsSync(file)) return null;
  deps.fs.mkdirSync(deps.PRESET_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = deps.path.join(deps.PRESET_BACKUP_DIR, `${presetBackupPrefix(name)}.${stamp}`);
  deps.fs.copyFileSync(file, dest);
  const prefix = presetBackupPrefix(name) + '.';
  const backups = deps.fs.readdirSync(deps.PRESET_BACKUP_DIR).filter((f) => f.startsWith(prefix)).sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - deps.PRESET_BACKUP_KEEP))) {
    try { deps.fs.rmSync(deps.path.join(deps.PRESET_BACKUP_DIR, stale)); } catch {}
  }
  return dest;
}
// @bridge-function backupPresetFile:end

// @bridge-function listPresetBackups:start
function listPresetBackups(name) {
  try {
    const prefix = presetBackupPrefix(name) + '.';
    return deps.fs.readdirSync(deps.PRESET_BACKUP_DIR)
      .filter((f) => f.startsWith(prefix))
      .sort().reverse()
      .map((f) => ({ file: f, mtime: deps.fs.statSync(deps.path.join(deps.PRESET_BACKUP_DIR, f)).mtimeMs }));
  } catch {
    return [];
  }
}
// @bridge-function listPresetBackups:end

// @bridge-function presetStatus:start
function presetStatus(name) {
  // 只回传控制台需要的信息：不回传 DSH_HOME / 安装副本的绝对路径，减少无谓的信息暴露
  // （路径已经写在服务端日志里，排查时看日志即可）。
  return {
    preset: name,
    label: name === deps.PRESET_NAMES.v1 ? '一代仿真（reserved）' : '二代仿真（reserved2）',
    sourceFile: deps.path.relative(deps.ROOT, presetSourceYaml(name)),
    installed: deps.fs.existsSync(installedPresetYaml(name)),
    requiresRestart: true,
  };
}
// @bridge-function presetStatus:end
  return { knownPresetName, presetSourceYaml, dshHomeDir, installedPresetYaml, readPresetPromptText, presetBackupPrefix, backupPresetFile, listPresetBackups, presetStatus };
}
