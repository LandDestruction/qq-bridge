// 记忆工具组：记忆读写/事件/回溯/黑话。
//
// 2026-10-29 工具面收敛（D 方案）：qq_memory_append / qq_memory_query / qq_memory_remove /
// qq_memory_clear 四合一成 qq_memory（action=list|append|remove|clear）。四个工具各自的
// 描述 + schema 每轮都要重发，合并后参数只是多一个 action 枚举，能力一个不少。
// 纯搬自 src/mcp-snowluma-safe.js（D60 拆分），函数体逐字保留，行为不变。
import { z } from 'zod';
import { serializeModelData } from '../qq-model-view.js';
import {
  cfg, loadConfig, getConfig, getAccess, getOneBotConfig, isAllowed, unquoteJsonString,
  onebot, agentApiBase, readConsoleToken, errorText, agentApi, agentHeaders, agentApiLongPoll,
  authorizeRead, legacyReadToolAllowed, bootBridgeMode, registerLegacyReadTools,
} from './http.js';
import { fileURLToPath } from 'node:url';
import { lookupMeme, formatMemeEntry, memewikiStatus } from '../memewiki.js';

const MEMEWIKI_DB = fileURLToPath(new URL('../../data/memewiki.db', import.meta.url));

export function registerMemoryTools(server) {
server.tool(
  'qq_memory',
  '会话记忆唯一入口。action=list 看/append 记/remove 删/clear 清；category=activeTopic 话题/pendingThought 想说的话/memberImpression 群友印象。写印象必须带依据（谁在什么场景说的），只用消息里出现过的昵称。记忆持久化并在后续唤醒自动出现。',
  {
    action: z.enum(['list', 'append', 'remove', 'clear']).describe('list=查看 / append=记一条 / remove=删一条 / clear=清空'),
    key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
    token: z.string().describe('会话令牌（唤醒提示里有）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('记忆类别：append/remove 必填；list/clear 里可选（只处理这一类）'),
    content: z.string().optional().describe('append 的记忆内容（话题/想说的话/印象标签）；remove 时要删除的原文（memberImpression 不用）'),
    target: z.string().optional().describe('remove + memberImpression 时：要删除的群友名字/昵称'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('append 时的附加信息')
  },
  async ({ action, key, token, category, content, target, extra }) => {
    try {
      const headers = { 'x-agent-token': token };
      if (action === 'list') {
        const q = new URLSearchParams({ key });
        if (category) q.set('category', category);
        const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      }
      if (action === 'append') {
        if (!category) return { content: [{ type: 'text', text: 'action=append 需要传 category（activeTopic / pendingThought / memberImpression）' }], isError: true };
        if (!content) return { content: [{ type: 'text', text: 'action=append 需要传 content（要记的内容）' }], isError: true };
        const data = await agentApi('/api/socialV2/memory-append', {
          method: 'POST',
          body: JSON.stringify({ key, category, content, extra: extra || {} }),
          headers
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      }
      if (action === 'remove') {
        if (!category) return { content: [{ type: 'text', text: 'action=remove 需要传 category' }], isError: true };
        const data = await agentApi('/api/socialV2/memory-remove', {
          method: 'POST',
          body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
          headers
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      }
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆操作失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_event',
  '记录/查看/删除「共享事件」记忆：一起经历过的事（群里发生的事、约定的梗、共同话题）。scope=global 所有会话可见（默认）；scope=group:群号 只在该群可见。用来记住「我们之前一起聊过什么」。',
  {
    action: z.enum(['add', 'list', 'remove']).describe('add=写一条，list=查看，remove=按 id 或文本片段删除'),
    text: z.string().optional().describe('add/remove 用：事件内容（一句话，最多 200 字）或要删除的文本片段'),
    id: z.string().optional().describe('remove 用：事件 id（list 返回的 id）'),
    scope: z.string().optional().describe("global 或 group:群号；默认 global"),
    key: z.string().optional().describe('当前会话 key（带 token 时用于鉴权）'),
    token: z.string().optional().describe('会话令牌'),
    limit: z.number().optional().describe('list 返回条数，默认 20')
  },
  async ({ action, text, id, scope, key, token, limit }) => {
    try {
      const headers = token ? { 'x-agent-token': token } : {};
      if (action === 'list') {
        const q = new URLSearchParams();
        if (key) q.set('key', key);
        if (limit) q.set('limit', String(limit));
        const data = await agentApi(`/api/socialV2/memory-event?${q.toString()}`, { headers });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      }
      const body = { action, text, id, scope, key };
      const data = await agentApi('/api/socialV2/memory-event', { method: 'POST', body: JSON.stringify(body), headers });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `共享事件操作失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.recall !== false && cfg.archive?.enabled !== false) {
  server.tool(
    'qq_recall',
    '在指定会话的 7 天滚动归档里按关键词检索历史消息（2 字滑窗打分 + 时间倒序，最多 12 条）。用于回忆群友之前说过的话/聊过的话题。query 传关键词或短语。',
    {
      key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
      token: z.string().describe('会话令牌（唤醒提示里有）'),
      query: z.string().describe('检索关键词或短语'),
      limit: z.number().optional().describe('最多返回条数（默认 12，最大 50）')
    },
    async ({ key, token, query, limit }) => {
      try {
        const data = await agentApi('/api/socialV2/recall', {
          method: 'POST',
          body: JSON.stringify({ key, query: String(query), limit: limit ?? 12 }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `检索归档失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
  {
    key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
    token: z.string().min(1).describe('会话令牌（唤醒提示里有）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达提交给管理员筛选。提交后进入候选库，管理员确认后会被写入黑话提示词，成为你后续可查询和使用的记忆。',
  {
    key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
    token: z.string().describe('会话令牌（唤醒提示里有）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    meaning: z.string().optional().describe('可选：你查到/推断的释义（≤200 字）；只会进「听懂」档，需管理员确认才能使用'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

  server.tool(
    'qq_meme_lookup',
    '查本地梗百科（6668 条网络梗/黑话，离线只读，来自 dsh-memewiki 词库）。遇到听不懂的梗、黑话、缩写、名场面，先查这里再回话；查到就自然接梗，查不到就说不知道，别编解释。',
    {
      query: z.string().describe('要查的词或梗名（2~24 字），例如「去码头整点薯条」「心机绿茶」')
    },
    async ({ query }) => {
      try {
        const entry = lookupMeme(query, { file: MEMEWIKI_DB });
        if (!entry) {
          const st = memewikiStatus(MEMEWIKI_DB);
          return { content: [{ type: 'text', text: `本地梗库没有「${String(query).slice(0, 24)}」（共 ${st.entries || 0} 条）。不要编释义，直接说不知道或让对方解释。` }] };
        }
        return { content: [{ type: 'text', text: formatMemeEntry(entry) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `查梗失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}
