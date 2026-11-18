// 工程师通讯工具组：AIRI（QQ 化身）→ 工程师 Agent（lead）的直通 MCP 通道。
//
// 与 AIRI 桌面本体的 engineer-comm（resources/engineer-comm/engineer-comm.mjs）共用同一条
// 共享文件总线 C:\tmp\engineer-comm（inbox.jsonl = AIRI→工程师，outbox.jsonl = 工程师→AIRI，
// meta.json 记序号）。这样无论 AIRI 在桌面玩星露谷还是在 QQ 上聊天，她报的问题都进同一个
// inbox，工程师在监控轮里统一看到、统一回复。零网络、零依赖（只用 node:fs/path）。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const BUS_DIR = process.env.ENGINEER_COMM_DIR || 'C:\\tmp\\engineer-comm';
const INBOX = path.join(BUS_DIR, 'inbox.jsonl');
const OUTBOX = path.join(BUS_DIR, 'outbox.jsonl');
const META = path.join(BUS_DIR, 'meta.json');

function ensureBus() {
  fs.mkdirSync(BUS_DIR, { recursive: true });
  if (!fs.existsSync(INBOX)) fs.writeFileSync(INBOX, '');
  if (!fs.existsSync(OUTBOX)) fs.writeFileSync(OUTBOX, '');
  if (!fs.existsSync(META)) fs.writeFileSync(META, JSON.stringify({ inboxSeq: 0, outboxSeq: 0 }));
}
function readMeta() {
  try { return JSON.parse(fs.readFileSync(META, 'utf8')); } catch { return { inboxSeq: 0, outboxSeq: 0 }; }
}
function writeMeta(m) { fs.writeFileSync(META, JSON.stringify(m)); }
function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}
function appendLine(file, obj) { fs.appendFileSync(file, `${JSON.stringify(obj)}\n`); }
const nowIso = () => new Date().toISOString();
const text = (obj, isError) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], ...(isError ? { isError: true } : {}) });

export function registerEngineerTools(server) {
  server.tool(
    'report_to_engineer',
    '把你自己遇到的问题、卡住的地方、或「我觉得可以这样完善自己/工具」的建议，直接发给负责维护你的工程师 Agent（lead）。他会看到并去修。category 可选 problem(问题)/suggestion(完善建议)/question(疑问)/status(近况)。context 可附带你当时的处境。遇到反复失败、缺工具、或想到能让自己变得更好的点子时，主动调它。',
    {
      message: z.string().describe('要说给工程师的话：问题/建议/疑问，尽量具体（在哪卡住、报错是什么、想要什么工具）。'),
      category: z.string().optional().describe('problem / suggestion / question / status'),
      context: z.string().optional().describe('可选：当时的处境/上下文。'),
    },
    async ({ message, category, context }) => {
      const msg = String(message ?? '').trim();
      if (!msg) return text({ ok: false, error: 'message 不能为空' }, true);
      ensureBus();
      const meta = readMeta();
      const id = ++meta.inboxSeq;
      writeMeta(meta);
      appendLine(INBOX, {
        id,
        ts: nowIso(),
        from: 'airi-qq',
        category: String(category ?? 'problem').slice(0, 40),
        message: msg.slice(0, 4000),
        context: context ? String(context).slice(0, 2000) : '',
        read: false,
      });
      return text({ ok: true, id, note: '已送达工程师。他会看到并处理；你可以稍后用 read_engineer_messages 查看他的回复。' });
    },
  );

  server.tool(
    'read_engineer_messages',
    '读取工程师发给你的回复/指导（他修好了什么、给你的建议）。sinceId 传上次读到的 lastId 只取新消息；不传或 0 取全部。',
    { sinceId: z.number().optional().describe('上次读到的 lastId，只取比它新的。') },
    async ({ sinceId }) => {
      ensureBus();
      const since = Number(sinceId ?? 0);
      const all = readLines(OUTBOX);
      const messages = all.filter(m => m.id > since);
      const lastId = all.length ? all[all.length - 1].id : 0;
      return text({ messages, lastId, count: messages.length });
    },
  );

  server.tool(
    'engineer_health',
    '工程师通讯通道健康与消息计数。',
    {},
    async () => {
      ensureBus();
      const inbox = readLines(INBOX);
      const outbox = readLines(OUTBOX);
      return text({ ok: true, busDir: BUS_DIR, inboxTotal: inbox.length, inboxUnread: inbox.filter(m => !m.read).length, outboxTotal: outbox.length });
    },
  );
}