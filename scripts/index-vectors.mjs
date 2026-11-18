// 批量补齐语义检索的向量索引（一次性运维脚本）。
//
// 为什么单独跑：桥接内的 indexPending 每 5 分钟只跑一批（400 条），
// 首次全量补齐（约 2 万条）要几十小时。这里连续跑到底，跑完退出。
//
// 用法：node scripts/index-vectors.mjs [--batch 400] [--max-rounds 200]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryVector } from '../src/memory-vector.js';
import { openMessageDb } from '../src/message-db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const batch = arg('batch', 400);
const maxRounds = arg('max-rounds', 200);

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const db = openMessageDb(path.join(ROOT, 'state', 'messages.db'));
if (!db) { console.error('打不开 messages.db'); process.exit(1); }

const mv = createMemoryVector({
  cfg,
  messageDb: () => db,
  log: (m) => console.log(m)
});

const st0 = mv.stats();
console.log(`起始：已索引 ${st0.indexed} 条，待索引 ${st0.pending} 条（${st0.model} / ${st0.days} 天）`);

let round = 0;
let total = 0;
const t0 = Date.now();
while (round < maxRounds) {
  const n = await mv.indexPending(batch);
  round += 1;
  if (!n) break;
  total += n;
  const el = ((Date.now() - t0) / 1000).toFixed(0);
  const rate = total / Math.max(1, Number(el));
  const st = mv.stats();
  console.log(`第 ${round} 轮 +${n} | 累计 ${total} | 剩余 ${st.pending} | ${el}s (${rate.toFixed(1)} 条/秒)`);
  if (st.pending <= 0) break;
}

const st = mv.stats();
console.log(`完成：本轮索引 ${total} 条，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s，库内共 ${st.indexed} 条，剩余 ${st.pending} 条`);
