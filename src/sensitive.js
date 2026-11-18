// 共享的敏感信息审计正则：桥接回复、MCP 发送、审批/提问文本等统一使用，避免两处维护不一致。
// 拦截本机路径/凭据特征；凭据关键词需带赋值关系才判定，避免误伤正常聊天。
// UNC 的主机/共享名之间只有一个反斜杠；JSON 键名可能带引号。
// 这是内容审计的启发式规则，不能代替会话权限控制或对已知令牌的精确拦截。
//
// 两道内容闸门是**有意互补**的，不是重复实现：
//   ① 这里（启发式）：抓"长得像路径 / 像凭据赋值"的文本，任何一条出站文本都能过；
//   ② KNOWN_AGENT_TOKENS 精确名单（bridge.js）：抓**已知的**会话令牌原文，
//      覆盖 onebotSend / redactKnownTokensOnly 这类刻意不跑 SENSITIVE_RE 的发送路径。
// 为什么第二条不可省：32 位十六进制的裸会话令牌**不匹配**下面的正则（它既不是路径，
// 也没有 token= 这种赋值形态），只有精确名单能拦住它。
// 反过来，**不要**为了让这条正则"顺带"覆盖裸 32-hex 而往里加 [0-9a-f]{32}：
// 表情 md5、图片 URL、消息里的十六进制串本身就是 32-hex，加进去会把正常的表情包与消息
// 整条拦掉/打码（误伤面远大于收益）。要收紧令牌泄漏，请走精确名单那条路。

// 拆成具名子规则：命中时能说清「是哪一类」，日志只记打码片段（方便排查又不泄露本体）。
const PARTS = [
  ['windows-path', /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]+/],
  ['unc-path', /\\\\[^\\\s"'<>|]+\\[^\s"'<>|]+/],
  ['unix-path', /(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/root\/)[^\s"'<>|]*/],
  ['credential', /(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)["']?(?:\s*(?:[:=：]|是|为)\s*["']?[^\s，。；、"']{3,}|\s+[A-Za-z0-9_\-./]{3,})/i]
];

export const SENSITIVE_RE = new RegExp('(' + PARTS.map(([, re]) => re.source).join('|') + ')', 'i');

/**
 * 命中时返回 `{ name, excerpt, length }`；未命中返回 null。
 * excerpt 已打码（保留首 3 / 尾 2 字符），可以安全写进日志。
 */
export function describeSensitiveMatch(text) {
  const s = String(text ?? '');
  if (!s) return null;
  for (const [name, re] of PARTS) {
    const m = re.exec(s);
    if (!m) continue;
    const raw = String(m[0]).slice(0, 80);
    const excerpt = raw.length <= 6 ? '***' : `${raw.slice(0, 3)}***${raw.slice(-2)}`;
    return { name, excerpt, length: m[0].length };
  }
  return null;
}

/** 只判断是否命中（等价 SENSITIVE_RE.test，但内部按子规则顺序判断）。 */
export function hasSensitiveContent(text) {
  return describeSensitiveMatch(text) !== null;
}
