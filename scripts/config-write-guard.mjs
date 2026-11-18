// 脚本侧 config.json 写保护（供 scripts/*.mjs 显式调用）。
//
// 规则：脚本默认**只能写临时目录/其它文件**；要写项目根的真实 config.json，
// 必须显式设置 QQ_BRIDGE_ALLOW_CONFIG_WRITE=1。这样测试/探针误传真实路径时
// 会立刻失败，而不是把线上配置改坏（2026-10-26 17:51 事故的防再犯）。
//
// 用法：
//   import { assertSafeConfigWrite } from './config-write-guard.mjs';
//   assertSafeConfigWrite(configPath);      // 真实路径且没开环境变量 → 抛错
//   fs.writeFileSync(configPath, json);     // 通过后才写

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertScriptConfigWriteAllowed, isRealConfigPath } from '../src/config-write.js';

export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 脚本写 config 前必须调用；不满足条件会抛错。 */
export function assertSafeConfigWrite(filePath, { env = process.env } = {}) {
  return assertScriptConfigWriteAllowed(filePath, { root: PROJECT_ROOT, env });
}

export { isRealConfigPath };

// 直接 `node scripts/config-write-guard.mjs <path>` 时只做检查并打印结果。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const target = process.argv[2] || path.join(PROJECT_ROOT, 'config.json');
  try {
    assertSafeConfigWrite(target);
    console.log(`允许写：${path.resolve(target)}`);
  } catch (error) {
    console.error(error?.message ?? error);
    process.exit(1);
  }
}
