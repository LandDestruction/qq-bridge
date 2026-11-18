// token 账本 —— 装配根：只做接线与启动（业务在 context / store / ingest / report）。
//
// 为什么拆：单个 createTokenLedger 闭包近 990 行、整文件 1088 行，超代码规模闸
// （文件 ≤800、函数 ≤300）。拆分是**纯移动**：逻辑一行没改，对外导出面（见 ../token-ledger.js）
// 与 import 路径都不变，所以调用方（bridge.js / 测试 / 控制台）零改动。
//
// 分层：context（状态与纯查价） ← store（JSONL 日志、压缩、淘汰）
//                              ← ingest（事件折叠入账） / report（汇总与查询）
import { DEFAULT_PRICE_TABLE } from '../model-prices.js';
import { createLedgerContext } from './context.js';
import { createStore } from './store.js';
import { createIngest } from './ingest.js';
import { createReport } from './report.js';
import { createSeries } from './series.js';

export function createTokenLedger({
  file,
  log = () => {},
  priceTable = DEFAULT_PRICE_TABLE,
  resolveKey,
  maxLines = 20000,
  now = () => Date.now()
} = {}) {
  if (typeof file !== 'string' || !file) throw new Error('createTokenLedger: file is required');

  const ctx = createLedgerContext({ file, log, priceTable, resolveKey, maxLines, now });
  const store = createStore(ctx);
  const ingest = createIngest(ctx, store);
  const report = createReport(ctx, store);
  const series = createSeries(ctx, store, report);

  store.load();

  return {
    ingestEvent: ingest.ingestEvent,
    ingestBaseline: ingest.ingestBaseline,
    ingestSnapshotRecords: ingest.ingestSnapshotRecords,
    summary: report.summary,
    conversation: report.conversation,
    turnsSince: report.turnsSince,
    samplesSince: report.samplesSince,
    turnOf: report.turnOf,
    series: series.series,
    recent: series.recent,
    todayByKey: series.todayByKey,
    stats: series.stats,
    reset: series.reset,
    compact: store.compact,
    hasSession: (sid) => ctx.baselines.has(sid) || ctx.sessionSeen.has(sid),
    file
  };
}
