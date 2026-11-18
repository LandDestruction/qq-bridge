// 群管理指令：解析 + 权限分级（纯函数，便于单测）。
//
// 权限三级：
//   owner  —— 只有 ownerQQ
//   admin  —— ownerQQ + 群主 + 群管理员
//   member —— 群里任何成员
//
// 指令本身不进入 agent 回合，由桥接直接处理：省 token、可硬控、静默期间也能用。

export const TIERS = ["member", "admin", "owner"];

export const COMMANDS = {
  stop: { tier: "admin", usage: "/stop [分钟]", desc: "叫停本群（默认直到 /resume）" },
  resume: { tier: "admin", usage: "/resume", desc: "解除静默" },
  mute: { tier: "admin", usage: "/mute @某人 [分钟]", desc: "只静音某个人" },
  summary: { tier: "admin", usage: "/summary [2h]", desc: "最近一段时间本群在聊什么" },
  todo: { tier: "admin", usage: "/todo", desc: "从最近的聊天里抽待办/约定" },
  who: { tier: "admin", usage: "/who", desc: "最近谁最活跃" },
  search: { tier: "member", usage: "/search 关键词", desc: "在历史消息里搜" },
  slang: { tier: "member", usage: "/slang 词", desc: "查黑话释义" },
  sticker: { tier: "member", usage: "/sticker 场景", desc: "按场景/备注找表情" },
  help: { tier: "member", usage: "/help", desc: "列出你权限内可用的指令" },
  persona: { tier: "member", usage: "/persona 你是一只猫娘 | off", desc: "指定她和你说话的样子（只影响你）" }
};

/** 解析一条消息是否为管理指令；不是则返回 null。 */
export function parseCommand(text) {
  const raw = String(text ?? "").trim();
  if (!raw.startsWith("/")) return null;
  const m = raw.match(/^\/([a-zA-Z]+)\s*(.*)$/s);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const spec = COMMANDS[name];
  if (!spec) return null;
  return { name, args: m[2].trim(), spec };
}

/** 权限判定：caller 的级别（member/admin/owner）+ 指令要求的级别。 */
export function canRun(command, callerTier) {
  const spec = COMMANDS[String(command || "").toLowerCase()];
  if (!spec) return false;
  const need = TIERS.indexOf(spec.tier);
  const have = TIERS.indexOf(callerTier);
  if (need < 0 || have < 0) return false;
  return have >= need;
}

/** 按权限列出可用指令（给 /help 用）。 */
export function listCommands(callerTier) {
  return Object.entries(COMMANDS)
    .filter(([name]) => canRun(name, callerTier))
    .map(([name, spec]) => ({ name, ...spec }));
}

/** 解析时长参数：10 / 10m / 2h / 1d，缺省 fallbackMs。 */
export function parseDuration(arg, fallbackMs = 0) {
  const s = String(arg ?? "").trim().toLowerCase();
  if (!s) return fallbackMs;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  const unit = m[2] || "m";
  const mult = unit === "s" ? 1000 : unit === "m" ? 60000 : unit === "h" ? 3600000 : 86400000;
  return Math.round(n * mult);
}
