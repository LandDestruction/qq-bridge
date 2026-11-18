// 静态/VM 级测试需要「入口 + 模块」的合并源码视图（D60 拆分后入口只剩装配，不再包含工具定义）。
// 与 scripts/bridge-source.mjs 同一思路：读**当前**模块，不读任何快照；运行时测试仍然执行真实入口。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 合并顺序与真实加载顺序一致：公共件 → 三个工具组 → 入口（入口最后执行装配）。 */
export const MCP_SAFE_MODULES = [
  'src/mcp-snowluma-safe/http.js',
  // 出图能力判定（纯函数）：tools-media 的 registerAssetTools 用它决定要不要注册 qq_draw。
  'src/imagegen-providers.js',
  // 媒体发送的 AI 黑名单闸：纯规则 + 依赖 http.js 的守卫，tools-media.js 直接用 guardMediaReply。
  'src/ai-blacklist-gate.js',
  'src/mcp-snowluma-safe/media-reply-guard.js',
  'src/mcp-snowluma-safe/tools-core.js',
  'src/mcp-snowluma-safe/tools-social.js',
  'src/mcp-snowluma-safe/tools-memory.js',
  'src/mcp-snowluma-safe/tools-media.js',
  'src/mcp-snowluma-safe.js',
];

// ESM 语法在 vm/new Function 里不成立：去掉 import（多行也要去）与 export 前缀，得到可求值的单文件视图。
const stripModuleSyntax = (text) => text
  .replace(/^import [\s\S]*?;\r?\n/gm, '')
  .replace(/^export /gm, '');

export function readMcpSafeSource() {
  return MCP_SAFE_MODULES
    .map((rel) => stripModuleSyntax(fs.readFileSync(path.join(ROOT, rel), 'utf8')))
    .join('\n');
}
