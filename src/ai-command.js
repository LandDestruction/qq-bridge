// AI 黑名单 QQ 私聊命令（D73）：管理员（ownerQQ）在私聊里用 /aiban 远程管理 D70 的名单。
//
// 边界（很重要）：
//   - 本模块只做「解析 + 回执拼装」；写盘全部委托注入的 admin（createAiBlacklistAdmin），
//     不 import 网络 / DSH / 配置，方便单测；
//   - 命令命中的处理发生在 incoming-runtime 的私聊入口、且**在额度/白名单/社交闸之前**，
//     直接 sendToQQ 回执后 return —— 管理命令绝不落进 DSH 回合（不花一次模型调用）。
//
// 命令表（斜杠与中文都认，大小写不敏感）：
//   /aiban 123456789            → 加入（等价 /aiban add）
//   /aiban add 123456789 [备注] → 加入，备注可选（≤20 字，这里再截断一次兜底）
//   /aiban del 123456789        → 移除
//   /aiban list                 → 列表（id、备注、加入时间、今日跳过次数）
//   /aiban on | off             → 总开关
//   /aiban mode reduce|silent   → 模式
//   /aiban                      → 帮助
//   中文别名：加AI黑名单 / 删AI黑名单 / 黑名单列表 / 黑名单开 / 黑名单关

export const AI_CMD_REPLY_MAX = 200;

// D73 的口径是「5~13 位数字」；QQ 现实最多 11 位，放宽到 13 只为兼容测试号段。
const QQ_RE = /^\d{5,13}$/;

export const AI_CMD_HELP_LINES = Object.freeze([
  'AI 黑名单命令（仅管理员私聊）：',
  '/aiban 123456789 或 /aiban add 123456789 [备注] 加入',
  '/aiban del 123456789 移除；/aiban list 查看',
  '/aiban on | off 总开关；/aiban mode reduce|silent 模式'
]);

/** 是不是指向本功能的命令（用于「非 owner 静默忽略」判定，不做完整解析）。 */
export function isAiBlacklistCommand(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return false;
  return /^\/aiban(?:\s|$)/i.test(text)
    || /^(?:加|删)\s*AI\s*黑名单(?:\s|$)/i.test(text)
    || /^黑名单(?:列表|开|关)$/.test(text);
}

/** 解析命令；不是本功能的命令返回 null（调用方应继续走正常聊天流程）。 */
export function parseAiBlacklistCommand(raw) {
  const text = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return null;

  const slashed = /^\/aiban(?:\s+(.*))?$/i.exec(text);
  if (slashed) return parseSub(slashed[1] ?? '');

  let m;
  if ((m = /^加\s*AI\s*黑名单(?:\s+(.+))?$/i.exec(text))) return addFrom(m[1] ?? '');
  if ((m = /^删\s*AI\s*黑名单(?:\s+(.+))?$/i.exec(text))) return delFrom(m[1] ?? '');
  if (/^黑名单列表$/.test(text)) return { op: 'list' };
  if (/^黑名单开$/.test(text)) return { op: 'on' };
  if (/^黑名单关$/.test(text)) return { op: 'off' };
  return null;
}

function parseSub(rest) {
  const s = String(rest ?? '').trim();
  if (!s) return { op: 'help' };
  let m;
  if (/^(?:list|ls|列表)$/i.test(s)) return { op: 'list' };
  if (/^(?:on|开|开启)$/i.test(s)) return { op: 'on' };
  if (/^(?:off|关|关闭)$/i.test(s)) return { op: 'off' };
  if ((m = /^mode(?:\s+(.*))?$/i.exec(s))) {
    const value = String(m[1] ?? '').trim().toLowerCase();
    if (value !== 'reduce' && value !== 'silent') return { op: 'invalid', reason: 'mode' };
    return { op: 'mode', mode: value };
  }
  if ((m = /^(?:add|加|添加)(?:\s+(.*))?$/i.exec(s))) return addFrom(m[1] ?? '');
  if ((m = /^(?:del|delete|remove|rm|删|删除)(?:\s+(.*))?$/i.exec(s))) return delFrom(m[1] ?? '');
  // 兼容「/aiban 123456789 某GPT」这种省略 add 的写法。
  if ((m = /^(\d{5,13})(?:\s+(.+))?$/.exec(s))) return { op: 'add', qq: m[1], note: String(m[2] ?? '').slice(0, 20) };
  return { op: 'invalid', reason: 'unknown' };
}

function addFrom(args) {
  const s = String(args ?? '').trim();
  if (!s) return { op: 'invalid', reason: 'qq_missing' };
  const [qq, ...rest] = s.split(' ');
  if (!QQ_RE.test(qq)) return { op: 'invalid', reason: 'qq', qq };
  return { op: 'add', qq, note: rest.join(' ').slice(0, 20) };
}

function delFrom(args) {
  const s = String(args ?? '').trim();
  if (!s) return { op: 'invalid', reason: 'qq_missing' };
  const [qq] = s.split(' ');
  if (!QQ_RE.test(qq)) return { op: 'invalid', reason: 'qq', qq };
  return { op: 'del', qq };
}

const clampReply = (text) => {
  const s = String(text ?? '');
  return s.length <= AI_CMD_REPLY_MAX ? s : s.slice(0, AI_CMD_REPLY_MAX - 1) + '…';
};

const coolingText = (c) => (c.minIntervalMs > 0
  ? `${Math.round(c.minIntervalMs / 60000)} 分钟冷却`
  : '不限冷却');
const hourlyText = (c) => (c.perHourMax > 0 ? `每小时最多 ${c.perHourMax} 次` : '每小时不限');
const modeText = (c) => `模式 ${c.mode}，${coolingText(c)}，${hourlyText(c)}`;

function clockText(ms) {
  const d = new Date(Number(ms) || 0);
  if (Number.isNaN(d.getTime()) || !ms) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 执行一条命令并返回回执（纯逻辑，写盘/计时/日志都注入）。
 * @param {{ text: string, admin: any, stats?: Function, log?: Function }} deps
 * @returns {{ handled: boolean, reply: string }} handled=false 表示不是本功能命令
 */
export function runAiBlacklistCommand({ text, admin, stats, log = () => {} } = {}) {
  const cmd = parseAiBlacklistCommand(text);
  if (!cmd) return { handled: false, reply: '' };
  const say = (reply) => ({ handled: true, reply: clampReply(reply) });
  if (!admin || typeof admin.get !== 'function') {
    return say('AI 黑名单管理通道不可用（bridge 未注入 admin），请先检查部署。');
  }

  const conf = () => admin.get();
  const skipped = () => {
    try {
      const s = typeof stats === 'function' ? stats() : null;
      return Number(s?.skippedToday) || 0;
    } catch { return 0; }
  };

  if (cmd.op === 'help') return say(AI_CMD_HELP_LINES.join('\n'));
  if (cmd.op === 'invalid') {
    if (cmd.reason === 'mode') return say('mode 只能是 reduce 或 silent。');
    if (cmd.reason === 'qq_missing') return say('用法：/aiban add 123456789 [备注] 或 /aiban del 123456789');
    if (cmd.reason === 'qq') return say(`QQ 号要 5~13 位数字，例如 /aiban add 123456789 某GPT`);
    return say(`没听懂这个命令。\n${AI_CMD_HELP_LINES[1]}\n${AI_CMD_HELP_LINES[2]}`);
  }

  if (cmd.op === 'add') {
    try { admin.add(cmd.qq, cmd.note); }
    catch (error) { return say(`加入失败：${error?.message ?? error}`); }
    const c = conf();
    log(`[AI黑名单] 管理员私聊 add ${cmd.qq}`);
    return say(`已加入：${cmd.qq}（共 ${c.qq.length} 个）｜${modeText(c)}`);
  }

  if (cmd.op === 'del') {
    const existed = conf().qq.some((entry) => entry.id === cmd.qq);
    try { admin.remove(cmd.qq); }
    catch (error) { return say(`移除失败：${error?.message ?? error}`); }
    const c = conf();
    log(`[AI黑名单] 管理员私聊 del ${cmd.qq}`);
    return say(existed
      ? `已移除：${cmd.qq}（还剩 ${c.qq.length} 个）`
      : `名单里没有 ${cmd.qq}（共 ${c.qq.length} 个）`);
  }

  if (cmd.op === 'list') {
    const c = conf();
    const total = c.qq.length;
    if (!total) return say(`名单为空（总开关${c.enabled ? '开' : '关'}，${modeText(c)}）`);
    // 长名单只列前 4 条：回执上限 200 字，宁可直接截断条数也不截半条。
    const shown = c.qq.slice(0, 4).map((entry, i) => {
      const at = entry.addedAt ? ` 加入于 ${clockText(entry.addedAt)}` : '';
      return `${i + 1}) ${entry.id}${entry.note ? ` 备注「${entry.note}」` : ''}${at}`;
    }).join('；');
    const more = total > 4 ? `… 共 ${total} 个` : '';
    return say(`列表（${total} 个，总开关${c.enabled ? '开' : '关'}，${modeText(c)}，今日跳过 ${skipped()} 次）：${shown}${more}`);
  }

  if (cmd.op === 'on' || cmd.op === 'off') {
    try { admin.toggle(cmd.op === 'on'); }
    catch (error) { return say(`${cmd.op === 'on' ? '开启' : '关闭'}失败：${error?.message ?? error}`); }
    const c = conf();
    log(`[AI黑名单] 管理员私聊 toggle ${cmd.op}`);
    return say(cmd.op === 'on'
      ? `已开启总开关（名单 ${c.qq.length} 个）`
      : `已关闭总开关（名单保留 ${c.qq.length} 个）`);
  }

  if (cmd.op === 'mode') {
    if (typeof admin.mode !== 'function') return say('当前版本不支持改模式（需要重启后再试）。');
    try { admin.mode(cmd.mode); }
    catch (error) { return say(`模式切换失败：${error?.message ?? error}`); }
    log(`[AI黑名单] 管理员私聊 mode ${cmd.mode}`);
    return say(cmd.mode === 'silent'
      ? '模式已设为 silent：连 @ 都不回。'
      : '模式已设为 reduce：非 @ 类唤醒不触发，@ 按 atMeReply 处理。');
  }

  return say('没听懂这个命令。');
}
