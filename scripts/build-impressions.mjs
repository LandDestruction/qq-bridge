#!/usr/bin/env node
// 手动跑一轮「群友印象归纳」：默认 dry-run 只算分片与预算，--apply 才真的调模型并写 state/impressions.json。
//
// 为什么是手动 CLI 而不是直接挂定时器：印象是「慢变量」，一天里反复重算既费钱又会让模型把同一段对话
// 反复改写成不同说法。先让人看清一次要花多少、切成了什么样，再决定要不要接 48 小时轮询。
//
// 只写 state/impressions.json 一个文件；people.json / social-v2.json / member-notes.json 一律只读。

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { NodeApiClient, unwrap } from '../src/dsh-client.js';
import { buildImpressions, buildShardPrompt, windowOf } from '../src/impressions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, 'state');
const OUT_FILE = path.join(STATE_DIR, 'impressions.json');
const ARCHIVE_DIR = path.join(STATE_DIR, 'archive');
const DB_FILE = path.join(STATE_DIR, 'messages.db');
const DEFAULT_TIMEOUT_MS = 120_000;

const USAGE = `群友印象归纳（只读版后端）

用法：
  node scripts/build-impressions.mjs [--dry-run|--apply] [选项]

选项：
  --dry-run            只算分片与预算，不调模型、不写盘（默认）
  --apply              调模型归纳并写 state/impressions.json
  --days=N             归纳最近 N 天（默认 2）
  --max-shards=N       最多 N 个分片（默认 10）
  --max-per-shard=N    单个分片最多 N 条消息（默认 800）
  --preset=NAME        指定 DSH agent preset（默认不指定，用 DSH 默认）
  --timeout=MS         单个分片的模型等待上限，毫秒（默认 120000）
  --json               以 JSON 打印结果（便于脚本消费）
  -h, --help           显示这份说明`;

/** 解析 --key=value / --flag 形式的参数；未知参数直接报错，避免拼错后静默按默认值跑。 */
function parseArgs(argv) {
  const options = {
    apply: false,
    days: 2,
    maxShards: 10,
    maxPerShard: 800,
    preset: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    help: false
  };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--days=')) options.days = readPositiveInt(arg, '--days');
    else if (arg.startsWith('--max-shards=')) options.maxShards = readPositiveInt(arg, '--max-shards');
    else if (arg.startsWith('--max-per-shard=')) options.maxPerShard = readPositiveInt(arg, '--max-per-shard');
    else if (arg.startsWith('--timeout=')) options.timeoutMs = readPositiveInt(arg, '--timeout');
    else if (arg.startsWith('--preset=')) options.preset = arg.slice('--preset='.length).trim();
    else throw new Error(`未知参数：${arg}\n\n${USAGE}`);
  }
  return options;
}

function readPositiveInt(arg, name) {
  const value = Number(arg.slice(name.length + 1));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 需要正整数，收到：${arg}`);
  return Math.floor(value);
}

function readJsonSafe(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** 同步重试 rename：Windows 上杀毒/索引会短暂占用句柄，立刻失败属于常态。 */
function renameWithRetry(from, to, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = error?.code;
      if (i === attempts - 1 || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1));
    }
  }
}

/** 原子写：先写同目录临时文件再 rename，读者要么看到旧文件要么看到完整新文件。 */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件可能已经 rename 走了；清不掉不影响主错误
    }
    throw error;
  }
}

/** 北京时间日期时间串，给 dry-run 报表用（与切片口径一致）。 */
function beijingTime(ms) {
  const shifted = new Date(Number(ms) + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 16).replace('T', ' ');
}

function formatChars(count) {
  return count >= 10000 ? `${(count / 10000).toFixed(1)}万字` : `${count}字`;
}

/**
 * 读消息：优先 state/messages.db（覆盖所有会话、带 is_self 标记），没有 sqlite 或库不可读时
 * 退回 state/archive/group_*.jsonl。两条路径都按窗口过滤，返回统一字段。
 */
async function loadMessages(window) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    if (!fs.existsSync(DB_FILE)) throw new Error('messages.db 不存在');
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT key, ts, seq, sender, user_id AS userId, is_self AS isSelf, is_owner AS isOwner, text
             FROM messages
            WHERE ts >= ? AND ts < ? AND is_self = 0
            ORDER BY key, ts, seq`
        )
        .all(window.from, window.to);
      return { source: 'state/messages.db', messages: rows.map((row) => ({ ...row, ts: Number(row.ts) })) };
    } finally {
      db.close();
    }
  } catch (error) {
    const jsonl = loadMessagesFromArchive(window);
    if (!jsonl.files) throw new Error(`读消息失败：SQLite 不可用（${error?.message ?? error}），jsonl 也没找到`);
    return jsonl;
  }
}

/** jsonl 兜底：文件名推回 group:<id>，字段 t/seq/sender/userId/isSelf/text。 */
function loadMessagesFromArchive(window) {
  let files = [];
  try {
    files = fs
      .readdirSync(ARCHIVE_DIR)
      .filter((name) => /^group_\d+\.jsonl$/.test(name))
      .sort();
  } catch {
    return { source: '', files: 0, messages: [] };
  }
  const messages = [];
  for (const name of files) {
    const key = `group:${name.slice('group_'.length, -'.jsonl'.length)}`;
    let text = '';
    try {
      text = fs.readFileSync(path.join(ARCHIVE_DIR, name), 'utf8');
    } catch {
      continue; // 单个归档读不了就跳过，别让整轮归纳失败
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let item = null;
      try {
        item = JSON.parse(line);
      } catch {
        continue; // 坏行跳过
      }
      const ts = Number(item?.t ?? item?.ts);
      if (!Number.isFinite(ts) || ts < window.from || ts >= window.to) continue;
      messages.push({
        key: item.key ?? key,
        ts,
        seq: item.seq ?? null,
        sender: item.sender ?? '',
        userId: item.userId ?? item.user_id ?? '',
        isSelf: item.isSelf === true || item.is_self === 1,
        text: item.text ?? ''
      });
    }
  }
  return { source: 'state/archive/group_*.jsonl', files: files.length, messages };
}

/** 一个人的展示名：窗口里最近一次发言的昵称，兜底 friend-names.json。 */
function buildNameBook(messages) {
  const names = new Map();
  const friendNames = readJsonSafe(path.join(STATE_DIR, 'friend-names.json')) ?? {};
  for (const message of messages) {
    const qq = String(message?.userId ?? '');
    if (!qq) continue;
    const ts = Number(message.ts) || 0;
    const name = String(message.sender ?? message.name ?? '').trim();
    if (!name) continue;
    const current = names.get(qq);
    if (!current || ts >= current.ts) names.set(qq, { name, ts });
  }
  for (const [qq, name] of Object.entries(friendNames)) {
    if (!names.has(qq) && typeof name === 'string' && name.trim()) names.set(qq, { name: name.trim(), ts: 0 });
  }
  return new Map([...names.entries()].map(([qq, item]) => [qq, item.name]));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 用 DSH 客户端实现 caller：一个会话跑完所有分片。
 *
 * 复用仓库既有的会话通道（NodeApiClient + remote.mux + createTurnCollector 同款事件处理），
 * 不新造 HTTP 客户端；会话像 slang 学习器那样只建一个，避免每片一个会话在 DSH 里留一堆垃圾会话。
 * 每次 prompt 的提示词自带全部上下文（分片记录），因此前几片的输出不会影响后续判定。
 */
async function createDshCaller({ dsh, preset, timeoutMs, log }) {
  const baseUrl = String(dsh?.baseUrl || 'http://127.0.0.1:11046').trim();
  const api = new NodeApiClient(baseUrl, undefined, {
    token: dsh?.authToken,
    tokenExplicit: dsh?.authTokenExplicit === true,
    header: dsh?.authHeader || 'authorization',
    prefix: dsh?.authPrefix ?? 'Bearer',
    allowRemote: dsh?.allowRemote === true
  });
  const cwd = path.join(STATE_DIR, 'impressions-agent');
  fs.mkdirSync(cwd, { recursive: true });
  const params = { cwd };
  if (preset) params.agentPreset = preset;
  const created = unwrap(await api.sessions.create(params), 'sessions.create');
  const sessionId = created.sessionId;
  const provider = String(dsh?.provider || '').trim();
  const model = String(dsh?.model || '').trim();
  if (provider && model) {
    try {
      await api.sessions.selectModel({ sessionId, provider, model });
      log(`模型：${provider}/${model}`);
    } catch (error) {
      log(`固定模型失败（沿用 DSH 当前模型）：${error?.message ?? error}`);
    }
  }
  log(`会话：${sessionId}（workspace ${cwd}）`);

  const caller = async (shard) => runTurn(api, sessionId, buildShardPrompt(shard), timeoutMs);
  caller.close = () => api.events.forget(sessionId);
  return caller;
}

/** 发一次 prompt 并等到 turn/end，返回 assistant 文本。 */
async function runTurn(api, sessionId, promptText, timeoutMs) {
  const controller = new AbortController();
  let markOpened;
  const opened = new Promise((resolve) => {
    markOpened = resolve;
  });
  const mux = api.events.mux({}, controller.signal, () => markOpened());
  api.events.follow(sessionId);
  let collected = '';
  let reason = null;
  let failure = null;
  const pump = (async () => {
    for await (const envelope of mux) {
      const frame = envelope?.payload;
      if (!frame) continue;
      if (frame.type === 'stream/error') {
        failure = new Error(frame.error?.message || 'stream/error');
        return;
      }
      if (frame.type !== 'session/event' || frame.sessionId !== sessionId) continue;
      const event = frame.event;
      if (event?.type === 'assistant/message') {
        for (const block of event.data?.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') collected += block.text;
        }
      } else if (event?.type === 'error') {
        failure = new Error(event.data?.message || event.data?.code || 'session/error');
      } else if (event?.type === 'turn/end') {
        reason = event.data?.reason ?? { kind: 'unknown' };
        return;
      }
    }
  })();
  pump.catch(() => {}); // race 超时后 pump 可能晚些 reject，别让它变成未处理拒绝
  try {
    await Promise.race([opened, sleep(5000)]);
    unwrap(
      await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] }),
      'sessions.prompt'
    );
    await Promise.race([
      pump,
      sleep(timeoutMs).then(() => {
        throw new Error(`等待模型超时（${timeoutMs}ms）`);
      })
    ]);
  } finally {
    controller.abort();
    api.events.forget(sessionId);
  }
  if (failure) throw failure;
  if (!reason || reason.kind !== 'completed') throw new Error(`turn 未正常完成：${reason?.kind ?? 'unknown'}`);
  const reply = String(collected ?? '').trim();
  if (!reply) throw new Error('模型回复为空');
  return reply;
}

function printDryRun(result, options, extra) {
  const { window, shards, stats } = result;
  const names = extra.names;
  console.log(`印象归纳 dry-run（不调用模型、不写盘）`);
  console.log(`窗口：${beijingTime(window.from)} → ${beijingTime(window.to)}（${window.days} 天）`);
  console.log(`数据源：${extra.source}（读到 ${extra.received} 条，窗口内 ${stats.messages} 条）`);
  console.log(`规模：${stats.people} 位群友 / ${formatChars(stats.chars)} / ${shards.length} 个分片`);
  console.log('');
  console.log('分片：');
  shards.forEach((shard, index) => {
    const top = shard.people
      .slice(0, 3)
      .map((qq) => (names.get(qq) ?? qq))
      .join('、');
    console.log(
      `  ${String(index + 1).padStart(2)}. ${shard.id}  ${String(shard.messageCount).padStart(4)} 条  ` +
        `${formatChars(shard.textChars)}  ${shard.people.length} 人  ${top}${shard.people.length > 3 ? ' 等' : ''}`
    );
  });
  console.log('');
  console.log(`预估：${stats.budget.costHint}`);
  console.log(`调用次数：${shards.length} 次模型请求（单次上限 ${options.timeoutMs / 1000}s，失败按分片重跑，最多 4 轮）`);
  console.log('写盘：dry-run 不写；确认无误后加 --apply 才会写 state/impressions.json');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const config = readJsonSafe(path.join(ROOT, 'config.json')) ?? {};
  const dsh = config.dsh ?? {};
  const window = windowOf(Date.now(), options.days);
  const loaded = await loadMessages(window);
  const names = buildNameBook(loaded.messages);

  const prev = readJsonSafe(OUT_FILE);
  const shared = {
    messages: loaded.messages,
    now: window.to,
    days: options.days,
    maxShards: options.maxShards,
    maxPerShard: options.maxPerShard,
    // 上一轮的结果只用来继承历史证据数；people 里坏掉的条目由 mergeImpressions 自己过滤。
    prev: prev?.people ? prev : null
  };

  if (!options.apply) {
    const result = await buildImpressions({ ...shared, apply: false });
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            mode: 'dry-run',
            window,
            source: loaded.source,
            received: loaded.messages.length,
            stats: {
              messages: result.stats.messages,
              people: result.stats.people,
              chars: result.stats.chars,
              promptChars: result.stats.promptChars,
              shards: result.stats.shards,
              budget: result.stats.budget
            },
            shards: result.shards.map((shard) => ({
              id: shard.id,
              key: shard.key,
              day: shard.day,
              messageCount: shard.messageCount,
              chars: shard.textChars,
              people: shard.people.length
            }))
          },
          null,
          2
        )
      );
    } else {
      printDryRun(result, options, { source: loaded.source, received: loaded.messages.length, names });
    }
    return 0;
  }

  // ---- apply：建会话、逐分片调模型、合并、写盘 ----
  const startedAt = Date.now();
  // --json 时进度日志会污染 stdout 的 JSON，改成静默；失败信息仍在最终 JSON/退出码里。
  const log = options.json ? () => {} : (line) => console.log(line);
  const caller = await createDshCaller({ dsh, preset: options.preset, timeoutMs: options.timeoutMs, log });
  let applied;
  try {
    applied = await buildImpressions({
      ...shared,
      apply: true,
      caller,
      stateFile: OUT_FILE,
      write: (state) => writeJsonAtomic(OUT_FILE, state),
      log
    });
  } finally {
    caller.close?.();
  }
  const elapsedMs = Date.now() - startedAt;
  const summary = {
    mode: 'apply',
    shards: applied.stats.shards,
    people: applied.state.meta.kept,
    dropped: applied.state.meta.dropped,
    steps: applied.stats.steps,
    failedShards: applied.stats.failed,
    elapsedMs,
    wrote: applied.stats.wrote,
    file: OUT_FILE,
    costHint: applied.state.meta.costHint
  };
  if (options.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log('');
    console.log(`完成：${summary.shards} 个分片 / ${summary.steps} 轮 / ${summary.people} 人 / 丢弃 ${summary.dropped} 条`);
    console.log(`耗时 ${(elapsedMs / 1000).toFixed(1)}s，${summary.wrote ? `已写入 ${path.relative(ROOT, OUT_FILE)}` : '未写盘'}`);
    console.log(`预估成本：${summary.costHint}`);
    if (summary.failedShards > 0) console.log(`注意：仍有 ${summary.failedShards} 个分片没成功，下次运行会重新归纳这些分片`);
  }
  return summary.failedShards > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    console.error(`❌ 印象归纳失败：${error?.message ?? error}`);
    process.exitCode = 1;
  });
