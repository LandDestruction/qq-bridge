// 媒体工具的「AI 黑名单发送前硬闸」。
//
// 为什么单独放在 MCP 工具层：贴纸 / 图片 / 出图这三条回复不走 bridge 的
// /api/socialV2/send-message|send-burst，而是 MCP 工具直接 agentApi 到
// /send-sticker|send-image|draw。如果只在文字路径设闸，模型照样能「回名单里的 AI
// 一个表情包」——正好绕过了闸门。
//
// 设计约束（与 Lead 的口径一致）：
//   1. 规则只有一份：判定复用 src/ai-blacklist-gate.js 的 gateAiBlacklistSend，
//      这里只做「取 replyToMessageId 的 senderId → 调纯函数 → 拒绝时构造人话」；
//   2. 只判定 replyTo：媒体没有 at 段（贴纸/图片不能 @），过度拦截会误伤正常发送；
//   3. 关闭时短路：aiBlacklist.enabled=false 不查消息详情，不付额外 HTTP 成本；
//   4. 解析失败 fail-open：拿不到 senderId 就不拦（宁可不拦，也不因为消息详情接口
//      暂不可用把正常发送连坐成失败）；失败原因写日志。
//   5. 拒绝时一个字节都不发：调用方拿到 { reason, text } 后直接 return isError，
//      不调 agentApi。
import fs from 'node:fs';
import path from 'node:path';
import { gateAiBlacklistSend, normalizeGateConfig } from '../ai-blacklist-gate.js';
// ROOT 复用 http.js 的那一份：不要在模块顶层用 import.meta 自行推导 ——
// scripts/mcp-safe-source.mjs 会把这些模块拼成可 vm 求值的单文件视图，import.meta 在里面是语法错误。
import { getConfig, agentApiBase, readConsoleToken, ROOT } from './http.js';

const TOOL_LOG_FILE = path.join(ROOT, 'state', 'tool-calls.jsonl');

// 媒体路径的文案与文字路径略不同（Lead 指定「不发送」）：文字路径说「不接」，
// 媒体路径明确说「不发送」，因为这里连发送请求都没有发出。
export const MEDIA_REPLY_BLOCKED_TEXT = '这条是回名单里那个 AI 的，不发送（AI 黑名单）';

/**
 * 工厂：便于单测注入假 getConfig / resolveReplySender / appendBlocked。
 * @returns {(input: {key?:string, token?:string, replyToMessageId?:any, tool?:string}) => Promise<null | {reason:string, text:string}>}
 */
export function createMediaReplyGuard(deps) {
  const { getConfig: readConfig, resolveReplySender, appendBlocked, log } = deps || {};
  return async function guardMediaReply(input) {
    const info = input && typeof input === 'object' ? input : {};
    const ref = info.replyToMessageId;
    if (ref === undefined || ref === null || String(ref).trim() === '') return null;
    let cfgRaw = null;
    try {
      cfgRaw = readConfig ? readConfig()?.socialV2?.aiBlacklist : null;
    } catch (error) {
      log?.(`[AI黑名单] 读取配置失败，跳过媒体发送判定：${error?.message ?? error}`);
      return null;
    }
    // 关闭时直接放行：这一步在纯函数里也会做，但这里提前短路可以省掉一次消息详情查询。
    if (!normalizeGateConfig(cfgRaw).enabled) return null;
    let replyToUserId = null;
    try {
      replyToUserId = await resolveReplySender?.(info);
    } catch (error) {
      log?.(`[AI黑名单] 解析引用目标失败，跳过媒体发送判定：${error?.message ?? error}`);
    }
    if (!replyToUserId) return null;
    const kind = String(info.key || '').startsWith('private:') ? 'private' : 'group';
    const gate = gateAiBlacklistSend({ cfg: cfgRaw, kind, replyToUserId, texts: [] });
    if (!gate || gate.allow !== false) return null;
    // 工具日志：bridge 的 mux 只记录「调用结果」，不会知道这是黑名单拦截；
    // 这里补一条 type:'blocked'，让 journal 能直接查到「哪次媒体发送被闸掉了」。
    try {
      appendBlocked?.({
        type: 'blocked',
        time: new Date().toISOString(),
        tool: info.tool || '',
        key: info.key || '',
        blocked: 'ai-blacklist',
        reason: gate.reason
      });
    } catch (error) {
      log?.(`[AI黑名单] 写工具调用日志失败：${error?.message ?? error}`);
    }
    log?.(`[AI黑名单] 媒体发送前拦截 ${info.tool || 'media'} ${info.key || ''}（${gate.reason}）`);
    return { reason: gate.reason, text: MEDIA_REPLY_BLOCKED_TEXT };
  };
}

function appendBlockedEntry(entry) {
  // 小行追加（<4KB）：与 bridge 的 appendToolLog 同一份文件，type:'blocked' 与
  // 'result' 区分开，读日志的一方按 type 过滤即可，不会和工具结果混淆。
  fs.appendFileSync(TOOL_LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
}

async function resolveReplySenderViaConsole(info) {
  const q = new URLSearchParams({ key: String(info.key || ''), messageId: String(info.replyToMessageId) });
  // 用控制台令牌读管理端只读接口，而不是走 x-agent-token：
  //   1. message-detail 在带 x-agent-token 时还要求 v2ToolEnabled('getMessageDetail') 且会话在
  //      允许范围里；闸门如果依赖「模型能不能看到这个工具」，关掉工具就等于关掉闸门，不成立；
  //   2. agentHeaders 会带 x-agent-call:1，而桥接规定「智能体调用不带会话令牌」= 未授权。
  // 安全性上这一步只读、只取 senderId，不进提示词，等价于桥接内部的 resolveReplyTargetV2。
  const token = readConsoleToken();
  const res = await fetch(`${agentApiBase()}/api/socialV2/message-detail?${q.toString()}`, {
    headers: token ? { 'x-console-token': token } : {},
    signal: AbortSignal.timeout(20000)
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error(`消息详情 HTTP ${res.status}：${body?.error ?? ''}`);
  return body?.info?.userId ? String(body.info.userId) : null;
}

// 生产实例：工具函数直接用这个（测试用 createMediaReplyGuard 注入假依赖）。
export const guardMediaReply = createMediaReplyGuard({
  getConfig,
  resolveReplySender: resolveReplySenderViaConsole,
  appendBlocked: appendBlockedEntry,
  log: (message) => console.error(message)
});
