// 干跑：验证 withMemoryContext 的「语义召回」那一路是否真的产出内容。
// 用法：node scripts/_dry-run-memory-semantic.mjs ["查询文本"] [会话key]

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openMessageDb, searchMessages } from '../src/message-db.js';
import { createMemoryVector } from '../src/memory-vector.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const q = process.argv[2] || '语音听着像真人';
const key = process.argv[3] || 'group:100000003';

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const db = openMessageDb(path.join(ROOT, 'state/messages.db'));
const imp = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'state/impressions.json'), 'utf8')); } catch { return { people: {} }; } })();
const social = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'state/social-v2.json'), 'utf8')); } catch { return {}; } })();

// 抽 withMemoryContext（@bridge-function 块）
const CTX = path.join(ROOT, 'src/bridge/context-services.js');
const src = fs.readFileSync(CTX, 'utf8').replace(/^export /gm, '');
const start = src.indexOf('// @bridge-function withMemoryContext:start');
const block = src.slice(start, src.indexOf('// @bridge-function withMemoryContext:end'));
const fnEnd = block.indexOf('// 实体特征');
const body = block.slice(0, fnEnd).replace('// @bridge-function withMemoryContext:start', '');
const rest = block.slice(fnEnd);
const code = `(function () {\n${body.replace(/\bdeps\./g, '')}\n${rest.replace(/\bdeps\./g, '')}\nreturn { withMemoryContext };\n})()`;

const mv = createMemoryVector({ cfg, messageDb: () => db, log: (m) => console.log(m) });
console.log('向量库：', JSON.stringify(mv.stats()));

await mv.embedQuery(q);
const convs = new Map(Object.entries(social.conversations || {}));
const ctx = vm.createContext({
  cfg: { socialV2: { memory: { recall: { enabled: true, maxItems: 6, maxChars: 900 } } } },
  socialV2: { digests: social.digests || {}, conversations: convs },
  impressionsLoad: () => imp,
  messageDb: () => db,
  searchMessages,
  memoryVector: mv,
  log: (m) => console.log(m)
});
const { withMemoryContext } = new vm.Script(code).runInContext(ctx);
const out = withMemoryContext(key, q, 'BASE');
console.log(`\n=== 注入结果（q="${q}" key=${key}）===\n`);
console.log(out);
