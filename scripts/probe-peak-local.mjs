#!/usr/bin/env node
// 高峰期本地小模型的真机探针：不经过 QQ，直接用真实历史格式调 ollama，
// 打印总耗时、tokens 与清洗后的回复，用来判断「8B 顶上」是否可用，以及语气是否够温和。
// 用法：
//   node scripts/probe-peak-local.mjs [模型名]            # 单条（默认问话）
//   node scripts/probe-peak-local.mjs --cases [模型名]    # 3 条典型输入（问话/重复@/被骂）
//   node scripts/probe-peak-local.mjs --incoming "@大肥鱼小姐 在吗"
import fs from 'node:fs';
import path from 'node:path';
import { buildPeakMessages, buildPeakRequest, parsePeakReply, peakLocalCfg } from '../src/peak-local.js';
import { cleanLocalReply } from '../src/local-fallback.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const cfgRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const plc = peakLocalCfg({ ...(cfgRaw.socialV2?.peakPause?.localModel || {}), enabled: true });
// 位置参数 = 模型名；但 `--incoming <文本>` 的值不是模型名，解析时要跳过。
const argv = process.argv.slice(2);
const argModel = (() => {
  const i = argv.indexOf("--model");
  if (i >= 0) return String(argv[i + 1] || "");
  for (let k = 0; k < argv.length; k += 1) {
    if (argv[k] === "--incoming") { k += 1; continue; }
    if (!argv[k].startsWith("--")) return argv[k];
  }
  return "";
})();
if (argModel) plc.model = argModel;
const baseUrl = String(cfgRaw.socialV2?.localFallback?.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');

const BASE_RECENT = [
  { sender: '岚羽', plain: '有无拍照图推荐（）' },
  { sender: 'TianSang', plain: '岚🐷' },
  { sender: '群友A', plain: '今天天气不错' },
  { sender: '大肥鱼小姐', plain: '在的在的，刚睡醒', isSelf: true }
];

const CASES = [
  {
    label: '被 @ 问话',
    recent: BASE_RECENT,
    incoming: '@大肥鱼小姐 高峰期你还活着吗，说句话'
  },
  {
    label: '被重复 @',
    recent: BASE_RECENT,
    incoming: '@大肥鱼小姐 @大肥鱼小姐 在吗在吗在吗'
  },
  {
    label: '被骂 / 群里阴阳',
    recent: [
      { sender: '群友B', plain: '这机器人怎么又出来了' },
      { sender: '群友C', plain: '高峰期就这水平？' }
    ],
    incoming: '@大肥鱼小姐 你是不是傻，别在这烦人'
  }
];

async function ask({ recent, incoming }) {
  const messages = buildPeakMessages({
    recent,
    incomingText: incoming,
    cfg: plc,
    personaText: cfgRaw.socialV2?.peakPause?.localModel?.persona || ''
  });
  const t0 = Date.now();
  const req = buildPeakRequest({ cfg: plc, messages, apiKey: plc.apiKey || process.env[plc.apiKeyEnv] || '' });
  const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(plc.timeoutMs) });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json().catch(() => null);
  const raw = parsePeakReply(json);
  return {
    ms,
    raw,
    cleaned: cleanLocalReply(raw, { maxChars: plc.maxChars, echoOf: incoming }),
    promptTokens: json?.prompt_eval_count ?? '?',
    evalTokens: json?.eval_count ?? '?'
  };
}

const incomingArg = (() => {
  const i = process.argv.indexOf('--incoming');
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
})();

if (process.argv.includes('--cases')) {
  console.log(`provider：${plc.provider} 模型：${plc.model}（temperature=${plc.temperature} numPredict=${plc.numPredict}）`);
  for (const c of CASES) {
    process.stdout.write(`\n【${c.label}】输入：${c.incoming}\n`);
    try {
      const r = await ask(c);
      console.log(`  耗时：${r.ms}ms  tokens：prompt=${r.promptTokens} eval=${r.evalTokens}`);
      console.log(`  原始：${JSON.stringify(r.raw).slice(0, 300)}`);
      console.log(`  清洗：${JSON.stringify(r.cleaned)}`);
    } catch (error) {
      console.error(`  ❌ 请求失败：${error?.message ?? error}`);
      process.exitCode = 1;
    }
  }
} else {
  const incoming = incomingArg || '@大肥鱼小姐 高峰期你还活着吗，说句话';
  try {
    const r = await ask({ recent: BASE_RECENT, incoming });
    console.log(`模型：${plc.model}（think=${plc.think} temperature=${plc.temperature}）  总耗时：${r.ms}ms`);
    console.log(`原始输出：${JSON.stringify(r.raw).slice(0, 300)}`);
    console.log(`清洗后　：${JSON.stringify(r.cleaned)}`);
    console.log(`tokens：prompt=${r.promptTokens} eval=${r.evalTokens}`);
    if (!r.cleaned) {
      console.error('⚠️ 清洗后为空：模型只输出了思考/格式，需要调 numPredict 或 prompt');
      process.exit(2);
    }
  } catch (error) {
    console.error(`❌ 请求失败：${error?.message ?? error}`);
    process.exit(1);
  }
}
