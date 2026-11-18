// 静态断言：config.example.json 的每个顶层段都必须在 loadConfig() 里被显式搬运。
//
// 为什么：loadConfig 是**白名单式逐段构造**，不搬运就是运行时 undefined 且不报错。
// 事故实例：`imagegen` 段一直没搬运 → cfg.imagegen === undefined → tierProvider() 拿到空
// provider → 出图 502「Failed to parse URL from /images/generations」。
//
// 这条测试让「新增配置段忘了搬运」在 CI 阶段就炸，而不是等线上 502。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
// loadConfig 拆成了 loadConfig（前半段 cfg 对象字面量）+ applyConfigNormalization（后半段搬运），
// 两者合起来才是完整的 loadConfig 搬运逻辑；直接读 config-load.js 原文覆盖两者。
const src = fs.readFileSync(path.join(ROOT, 'src/bridge/config-load.js'), 'utf8');

const start = src.indexOf('function applyConfigNormalization');
if (start < 0) { console.error('❌ 找不到 applyConfigNormalization()，脚本需更新'); process.exit(1); }
const body = src.slice(start);

// 允许「故意不搬运」的键（目前没有；有的话必须写明原因）
const CLI_ONLY = new Set();

const keys = Object.keys(example);
const used = new Set([...body.matchAll(/file\.([a-zA-Z0-9_]+)/g)].map((m) => m[1]));
const missing = keys.filter((k) => !used.has(k) && !CLI_ONLY.has(k));

console.log(`config.example.json 顶层段：${keys.length} 个；未搬运：${missing.length} 个`);
if (missing.length) {
  console.error(`❌ 以下配置段在 loadConfig() 里没有搬运（运行时会 undefined）：${missing.join(', ')}`);
  process.exit(1);
}
console.log('✅ 所有配置段都有显式搬运');
