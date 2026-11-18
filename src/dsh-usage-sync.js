// DSH 本机会话用量同步：把「不是机器人开的」那些会话的 token 用量也接进令牌账本。
//
// 为什么需要它：桥接的用量只来自 `agentTransport.events()` —— 也就是桥接自己驱动的那条
// 会话流。用户在 DSH 桌面端手动开的窗口（Lead 窗口、临时对话）根本不在流里，于是
// 「用量与花费」只显示机器人烧的钱，官方账号天天在消耗却一条都不显示。
//
// 为什么不写个外部脚本往里追加：账本 compact() 会按**内存态**整文件重写 jsonl，
// 进程外追加的行会被下一次 compact 抹掉（实测 220 行直接归零）。所以必须在桥接进程内、
// 通过 ledger.ingestBaseline 把基线放进内存。
//
// 数据源：~/.dsh/storages/session_projcache/sessions/<sessionId>.json（全部会话的投影）
//   record.identity.cwd                      → 归属工作区
//   record.rows.tokenUsage.val.totals        → { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
//   record.rows.modelSelection.val.lastUsed  → { provider, model }
// 会话日志（session.v4.jsonl.zstd）里没有 token 数字，且是多帧拼接，不要解析它。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ROOT = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
const DEFAULT_EVERY_MS = 5 * 60 * 1000;

function workspaceNameOf(cwd) {
  const text = String(cwd || '').trim();
  if (!text) return 'unknown';
  const base = path.basename(text.replace(/[\\/]+$/, ''));
  return base || 'unknown';
}

/** 读一个投影文件，取出同步需要的三样东西；结构不对返回 null（坏文件不该打断整轮扫描）。 */
function readProjection(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = doc?.record || doc || {};
  const totals = record?.rows?.tokenUsage?.val?.totals;
  if (!totals || typeof totals !== 'object') return null;
  const selection = record?.rows?.modelSelection?.val;
  const used = selection?.lastUsed || selection?.pending || {};
  return {
    totals,
    cwd: record?.identity?.cwd || record?.rows?.workingDirectory?.val?.cwd || '',
    provider: used.provider,
    model: used.model,
  };
}

export function createDshUsageSync({ ledger, log, root = DEFAULT_ROOT, everyMs = DEFAULT_EVERY_MS } = {}) {
  const seen = new Map();
  let timer = null;
  let busy = false;

  /** 扫一遍投影缓存；只处理 mtime 变过的文件，所以稳态下几乎零成本。 */
  function scanOnce() {
    if (!ledger || typeof ledger.ingestBaseline !== 'function' || busy) return { added: 0, scanned: 0 };
    busy = true;
    const result = { added: 0, scanned: 0 };
    try {
      let names = [];
      try {
        names = fs.readdirSync(root);
      } catch {
        return result;
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(root, name);
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (seen.get(file) === stat.mtimeMs) continue;
        seen.set(file, stat.mtimeMs);
        result.scanned += 1;
        const projection = readProjection(file);
        if (!projection) continue;
        const sessionId = name.replace(/\.json$/, '');
        try {
          // key 只在账本自己解析不出归属时兜底（机器人开的会话仍用它的 QQ 会话 key）。
          const ok = ledger.ingestBaseline({
            sessionId,
            projection: { values: { tokenUsage: projection.totals } },
            at: stat.mtimeMs,
            provider: projection.provider,
            model: projection.model,
            key: `external:${workspaceNameOf(projection.cwd)}`,
          });
          if (ok) result.added += 1;
        } catch (e) {
          log?.(`[用量同步] 跳过 ${sessionId}：${e && e.message ? e.message : e}`);
        }
      }
      if (result.added > 0) log?.(`[用量同步] 外部会话入账 ${result.added} 个（扫描 ${result.scanned}）`);
    } finally {
      busy = false;
    }
    return result;
  }

  function start() {
    if (timer) return;
    // 启动稍晚一点再扫：首屏先把桥接自己拉起来，别和 DSH 就绪探测抢 IO。
    setTimeout(() => {
      try {
        scanOnce();
      } catch (e) {
        log?.(`[用量同步] 首次扫描失败（不影响主流程）：${e && e.message ? e.message : e}`);
      }
    }, 15000).unref?.();
    timer = setInterval(() => {
      try {
        scanOnce();
      } catch (e) {
        log?.(`[用量同步] 扫描失败（不影响主流程）：${e && e.message ? e.message : e}`);
      }
    }, everyMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, scanOnce, stats: () => ({ watched: seen.size, running: Boolean(timer) }) };
}
