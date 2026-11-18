// src/library-fs-error.js — 读盘失败时「能对外说」的文本：讲得清原因，但不回本机绝对路径。
//
// 背景（真机踩过）：访客拿 `/api/files/raw?rel=不存在.jpg` 打 404，响应体里是 Node 的原话
// ——`ENOENT: no such file or directory, stat '<本机路径>\booth-inbox\不存在.jpg'`。
// 访客链接一旦分享出去，等于把本机目录结构一起给出去了。所有「读文件/图片」路由统一走这里：
//
// - 访客：`ENOENT` → 「路径不存在」，其余 → 「读取失败」；**绝不带路径**。
// - 管理员：`ENOENT` → 「路径不存在：<相对路径>」；其余 → 错误码 + 脱敏后的原话（盘符/家目录替换成
//   「<本机路径>」）。管理员需要定位问题，但 API 响应仍然不该出现绝对路径（日志里可以）。
//
// 纯函数、无副作用，方便单测；不依赖 deps/fs。

const WIN_DRIVE_PATH = /[A-Za-z]:[\\/][^\s"'<>|]*/g;
const UNIX_HOME_PATH = /\/(?:home|Users)\/[^\s"'<>|]*/g;
const APP_DATA_PATH = /\bAppData\b[^\s"'<>|]*/gi;

/** 把文本里的本机绝对路径片段替换成 `<本机路径>`。日志与管理员响应共用。 */
export function scrubLocalPaths(text) {
  return String(text ?? '')
    .replace(WIN_DRIVE_PATH, '<本机路径>')
    .replace(UNIX_HOME_PATH, '<本机路径>')
    .replace(APP_DATA_PATH, '<本机路径>');
}

/** 归一化相对路径：`\` → `/`，去掉开头的 `./` 与 `/`（调用方传进来的通常已是档案根内的 rel）。 */
export function normalizeFsRel(rel) {
  return String(rel ?? '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
}

/**
 * 读盘失败的对外文本。
 * @param {unknown} error catch 到的错误（Node fs 错误带 code/message）
 * @param {string} rel 出事文件的相对路径（访客侧不会用到；管理员用来定位）
 * @param {string} role `request.consoleRole`（'guest' / 'admin' / ''）
 */
export function fsErrorText(error, rel, role) {
  const code = String(error?.code ?? '').trim().toUpperCase();
  const isGuest = String(role ?? '') === 'guest';
  if (isGuest) return code === 'ENOENT' ? '路径不存在' : '读取失败';
  const safeRel = normalizeFsRel(rel);
  if (code === 'ENOENT') return safeRel ? `路径不存在：${safeRel}` : '路径不存在';
  const detail = scrubLocalPaths(String(error?.message ?? error ?? '')).slice(0, 200);
  return detail ? `${code || '读取失败'}：${detail}` : '读取失败';
}
