// archive-runtime: extracted bridge responsibilities; no startup side effects.
// Live dependencies: ensureFileLedger, log, messageDb
export function createArchiveRuntime(deps) {
// @bridge-function fileArchiveDb:start
function fileArchiveDb() {
    const db = (0, deps.messageDb)();
    if (!db) return null;
    try {
      (0, deps.ensureFileLedger)(db);
      return db;
    } catch (error) {
      (0, deps.log)(`⚠️ 文件台账初始化失败：${error?.message ?? error}`);
      return null;
    }
  }
// @bridge-function fileArchiveDb:end
  return { fileArchiveDb };
}
