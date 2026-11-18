// 会话工具组：状态、未读/唤醒、发送与长轮询、成员/好感度/自我模型。
// 纯搬自 src/mcp-snowluma-safe.js（D60 拆分），函数体逐字保留，行为不变。
import { z } from 'zod';
import { serializeModelData } from '../qq-model-view.js';
import {
  cfg, loadConfig, getConfig, getAccess, getOneBotConfig, isAllowed, unquoteJsonString,
  onebot, agentApiBase, readConsoleToken, errorText, agentApi, agentHeaders, agentApiLongPoll,
  authorizeRead, legacyReadToolAllowed, bootBridgeMode, registerLegacyReadTools,
} from './http.js';

// 沉睡前观察防死循环护栏：活跃群里 canSleepNow 会被新消息不断重置为 false，
// 模型（尤其 qwen4）会死板地「false 就再等」→ 无限 qq_wait_for_messages 不回复不收尾。
// 每个会话每个回合窗口只允许一次真正的 messages 长观察；第二次起直接返回「可以收尾」指令，
// 逼模型去 qq_send_message 回复 + qq_mark_read/qq_set_wake_config 收尾。回合内调用间隔秒级、
// 回合间分钟级，用 90s TTL 区分。purpose=reply 的短静默不受限（回复前节奏需要）。
const waitGuard = new Map(); // key -> { count, lastMs }

export function registerSocialTools(server) {
// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看当前二代仿真模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。',
  { key: z.string().describe('会话 key（group:群号 或 private:QQ号）'), token: z.string().describe('会话令牌（唤醒提示里有）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_unread_messages',
  '查看未读消息，不自动标记已读。大量积压或快照 partial=true 时，用 afterSeq=readThroughSeq 从水位后按时间顺序补读；从最早未读开始传 0。',
  {
    key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
    token: z.string().describe('会话令牌（唤醒提示里有）'),
    limit: z.number().optional().describe('最多返回条数，默认 30，最大 100'),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('读取本地 seq 大于此水位的最早一页；省略则沿用返回最新一页的旧行为')
  },
  async ({ key, token, limit, afterSeq }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}${afterSeq === undefined ? '' : `&afterSeq=${afterSeq}`}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。',
  {
    key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
    token: z.string().describe('会话令牌（唤醒提示里有）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看指定会话的二代仿真状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key（group:群号 或 private:QQ号）'), token: z.string().describe('会话令牌（唤醒提示里有）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将已查看未读标记已读。throughSeq 用最近 readThroughSeq 水位（避免清除新到消息）；省略会清空全部未读。设置潜水前需先 qq_wait_for_messages(timeoutMs=300000) 完成沉睡前观察。',
  {
    key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
    token: z.string().describe('会话令牌（唤醒提示里有）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('本次确认已读的消息水位，使用已查看结果中的 readThroughSeq；不会清除更晚到达的消息')
  },
  async ({ key, token, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置会话唤醒配置（潜水/活跃）。triggers 可选：@/名字/关键词/提问/拍一拍/概率/anyMessage/speakerIds（指定群友发言唤醒）。设置潜水前需先 qq_wait_for_messages(timeoutMs=300000) 完成沉睡前观察。',
  {
    key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
    token: z.string().describe('会话令牌（唤醒提示里有）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可同时确认已读：使用已查看结果中的 readThroughSeq，省去额外 qq_mark_read；不传则只设置唤醒配置。若 markRead 工具被关闭，该水位会被忽略，本工具只设置唤醒配置'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_active_members / qq_get_group_members / qq_get_message_detail 的 userId/user_id 获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送工具。字符串=一条，数组=多条；每条要读起来完整，别把一句话拆两条。只有回更早消息、或连续几句指代不同消息时才传 replyToMessageId，否则别引用。',
  {
    key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
    token: z.string().describe('会话令牌（唤醒提示里有）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '发 QQ 拍一拍。群聊必须传 targetUserId；私聊可省（拍当前对象）。别频繁，真人不会一直戳。',
    {
      key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
      token: z.string().describe('会话令牌（唤醒提示里有）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

}

export function registerContextTools(server) {
server.tool(
  'qq_wait_for_messages',
  '等新消息/等回复。purpose=reply：回复前短静默，已安静足够立即返回；purpose=messages（默认）：等新消息后按 quietMs 等静默，无新消息等到 timeoutMs。沉睡前观察用 messages+timeoutMs=300000 一次等满。返回 canSleepNow/hint 直接告诉能否收尾、该用多大 timeoutMs——照做别反复试：true 就 mark_read/set_wake_config 收尾；false 按 hint 的 timeoutMs 一次等满。看 newMessages/unreadCount/readThroughSeq，有未读再补读。无人说话 preSleepWaitSatisfied=true；观察期来新消息 preSleepWaitObserved=true。',
  {
    key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
    token: z.string().describe('会话令牌（唤醒提示里有）'),
    purpose: z.enum(['messages', 'reply']).optional().describe('默认 messages：等新消息/回复/睡前观察；reply：回复前短静默，计入最后来信后已过去的时间，绝不授予睡前观察资格'),
    timeoutMs: z.number().optional().describe('等待预算毫秒数，默认 30000、最大 600000；reply 达到静默即返回，不必等满；沉睡前观察用 messages 并传 300000'),
    minNewMessages: z.number().optional().describe('仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它'),
    quietMs: z.number().optional().describe('静默窗口毫秒数，建议 10000~12000；reply 从最后来信开始计时，messages 只在等到新消息后计时；后台默认至少 10000')
  },
  async ({ key, token, purpose, timeoutMs, minNewMessages, quietMs }) => {
    try {
      // 防死循环：messages 长观察每回合窗口只放行一次，第二次起直接给收尾指令（见 waitGuard 注释）。
      if (purpose !== 'reply') {
        const now = Date.now();
        const g = waitGuard.get(key) || { count: 0, lastMs: 0 };
        if (now - g.lastMs > 90000) { g.count = 0; } // 距上次调用超过 90s 视为新回合窗口
        g.count += 1; g.lastMs = now; waitGuard.set(key, g);
        if (g.count >= 2) {
          // 第二次起把等待标记为「已完成/禁用」并以错误返回，打断模型反复 wait 的死循环：
          // 成功返回的 canSleepNow 提示会被模型忽略继续等，错误返回更能让它改去做收尾动作。
          return { content: [{ type: 'text', text: serializeModelData({
            canSleepNow: true,
            preSleepWaitSatisfied: true,
            stopWaiting: true,
            waitDisabledThisTurn: true,
            hint: '【本轮观察已完成，qq_wait_for_messages 这一回合不再可用】禁止再调 qq_wait_for_messages。现在立刻二选一收尾：①有想说的→qq_send_message 回复群友，再 qq_mark_read（throughSeq 用最近 readThroughSeq）+ qq_set_wake_config 潜水；②没想说的→直接 qq_mark_read + qq_set_wake_config 潜水。不要再等待。',
          }) }], isError: true };
        }
      }
      // 必须走长轮询通道：全局 fetch（undici）有 300s headersTimeout，
      // 而沉睡前观察的预算就是 300s（见 agentApiLongPoll 的说明）。
      const data = await agentApiLongPoll('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, purpose, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      // 返回瘦身：newMessages 全量回传会让每次等待后的下一轮 prompt 都变大一截。
      // 只留最近 5 条、每条 80 字，并给出总数；要看某条完整内容再单独 qq_get_message_detail。
      let slim = data;
      if (data && Array.isArray(data.newMessages) && data.newMessages.length > 5) {
        const tail = data.newMessages.slice(-5).map((m) => {
          if (!m || typeof m !== 'object') { return m; }
          const t = typeof m.text === 'string' ? (m.text.length > 80 ? m.text.slice(0, 80) + '…' : m.text) : m.text;
          return { seq: m.seq, userId: m.userId, userName: m.userName, text: t, media: m.media };
        });
        slim = Object.assign({}, data, { newMessages: tail, newMessagesTotal: data.newMessages.length, newMessagesNote: '只展示最近 5 条（每条截断到 80 字），完整内容用 qq_get_message_detail' });
      }
      return { content: [{ type: 'text', text: serializeModelData(slim) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
    token: z.string().describe('会话令牌（唤醒提示里有）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
    token: z.string().describe('会话令牌（唤醒提示里有）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '按 message_id / 本地 seq 查看单条消息的发送者、引用信息与正文（只读）。注意：正文最多返回 200 字符，textTruncated=true 表示被截断，这里不是读取长消息全文的入口。',
  {
    key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
    token: z.string().describe('会话令牌（唤醒提示里有）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
    token: z.string().describe('会话令牌（唤醒提示里有）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_affinity_shift',
  '微调你对某个人的好感度（0–100，按人跨群统一）。delta 只能 ±1..±3 的整数，reason 必填（≤40 字，会写进「为什么是这个分」的依据里）。桥接侧有硬限速：每人 10 分钟最多 1 次、每天 |Σdelta|≤10、被问好感度的当轮一律拒绝、本轮这个人没说话也拒绝。被拒时不要改口乱说分数，按拒绝原因回应。',
  {
    key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
    token: z.string().describe('会话令牌（唤醒提示里有）'),
    userId: z.union([z.number(), z.string()]).describe('要调整好感度的群友 QQ 号'),
    delta: z.number().describe('调整幅度：整数，-3 ~ +3（0 无意义会被拒）'),
    reason: z.string().describe('为什么调（≤40 字，例如「一起斗图很开心」）')
  },
  async ({ key, token, userId, delta, reason }) => {
    try {
      const data = await agentApi('/api/affinity/shift', {
        method: 'POST',
        body: JSON.stringify({ key, userId, delta, reason }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok !== true };
    } catch (error) {
      return { content: [{ type: 'text', text: `好感度调整失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_self_model',
  '被问到你自己用什么模型 / 什么版本 / 上下文还剩多少时调用（只读）。返回 source 与 reason：source=override/media/session/billed 是实际生效的；source=config-default 只是配置默认值、不代表实际推理用的模型，不能当实况说出去。不要凭猜测回答模型名字。',
  {
    key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
    token: z.string().describe('会话令牌（唤醒提示里有）')
  },
  async ({ key, token }) => {
    try {
      const data = await agentApi('/api/socialV2/self-model', {
        method: 'POST',
        body: JSON.stringify({ key, token }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok !== true };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询当前模型失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_persona',
  '给私聊设自定义人设（覆盖默认角色卡，仅 private）。对方要求「扮演XX/设定XX」时整理成人设文本保存；再调一次覆盖；reset=true 清除。只在对方明确要求时设置，人设写清身份/性格/说话方式+1~2句示例。',
  {
    key: z.string().describe('会话 key，格式 private:QQ号（群聊不适用）'),
    token: z.string().describe('会话令牌（唤醒提示里有）'),
    persona: z.string().optional().describe('要设置的人设文本（身份/性格/说话方式/示例）；reset=true 时省略'),
    reset: z.boolean().optional().describe('true=清除当前自定义人设，回到默认角色卡')
  },
  async ({ key, token, persona, reset }) => {
    try {
      const data = await agentApi('/api/socialV2/set-persona', {
        method: 'POST',
        body: JSON.stringify({ key, persona: persona ?? null, reset: reset === true }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置人设失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_search_history',
  '跨会话检索历史消息（消息永久库，不受最近 100 条与 7 天归档轮转限制）。用于回忆很久以前谁说过什么：传 key 只看该会话，不传则在所有会话里搜。中文双字词也能查到（内部 FTS5 + LIKE 双轨）。',
  {
    q: z.string().describe('检索关键词（2 字以上；2 字词会走模糊匹配，更慢但能查到）'),
    key: z.string().optional().describe('可选：限定会话 key（group:群号 / private:QQ号）。不传=全库搜'),
    token: z.string().optional().describe('会话令牌（限定 key 时必传）'),
    limit: z.number().optional().describe('返回条数上限，默认 10，最大 50'),
    days: z.number().optional().describe('可选：只看最近 N 天')
  },
  async ({ q, key, token, limit, days }) => {
    try {
      const body = { key: key || '', q, limit: Math.min(Number(limit) || 10, 50) };
      if (Number(days) > 0) body.sinceMs = Date.now() - Number(days) * 86400000;
      const headers = token ? { 'x-agent-token': token } : {};
      const data = await agentApi('/api/socialV2/search-history', { method: 'POST', body: JSON.stringify(body), headers });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `历史检索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

}
