#!/usr/bin/env node
// 一键切换桥接的模型后端：dsh（默认，走 DeepSeek Harness）或 strata（本机 Strata / Qwen3.6）。
//
// 用法：
//   node scripts/set-agent.mjs dsh          # 切回 DSH
//   node scripts/set-agent.mjs strata       # 切到本机 Strata（127.0.0.1:8080/v1）
//   node scripts/set-agent.mjs strata http://127.0.0.1:8080/v1 qwen3.6-35b-a3b-ud-q4_k_xl
//   node scripts/set-agent.mjs --show       # 只看当前配置
//
// 说明：只改 config.json 的 agent 段并留一份时间戳备份；改完要重启桥接才生效（脚本会打印命令）。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const CONFIG = path.join(ROOT, 'config.json');

const PRESETS = {
  dsh: { type: 'dsh', baseUrl: '', model: '', apiKey: '', timeoutMs: 120000, maxToolRounds: 8, extraBody: {} },
  strata: {
    type: 'openai',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'qwen3.6-35b-a3b-ud-q4_k_xl',
    apiKey: '',
    timeoutMs: 300000,
    maxToolRounds: 8,
    // Qwen3.6 默认会先输出一长段思考链；QQ 聊天要的是直接回答。
    extraBody: { chat_template_kwargs: { enable_thinking: false } }
  }
};

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
}

function show(agent) {
  console.log('当前 agent 配置：');
  console.log(JSON.stringify(agent ?? {}, null, 2));
  const hint = (agent?.type ?? 'dsh') === 'dsh'
    ? '（DSH：走 DeepSeek Harness，后台 GUI 那个）'
    : '（非 DSH 后端：桥接自己跑工具循环，模型由上面的 baseUrl/model 决定）';
  console.log(hint);
}

function main() {
  const args = process.argv.slice(2);
  const cfg = readConfig();
  if (args.length === 0 || args[0] === '--show' || args[0] === '-s') {
    show(cfg.agent);
    return;
  }
  const target = String(args[0]).toLowerCase();
  const preset = PRESETS[target];
  if (!preset) {
    console.error(`不认识的用途：${args[0]}（可选：${Object.keys(PRESETS).join(' / ')}）`);
    process.exitCode = 2;
    return;
  }
  const next = { ...preset };
  if (args[1]) next.baseUrl = String(args[1]).trim();
  if (args[2]) next.model = String(args[2]).trim();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(ROOT, 'state', `config.backup-setagent-${stamp}.json`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(CONFIG, backup);
  cfg.agent = next;
  fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

  console.log(`已切换到 ${target}：`);
  show(next);
  console.log(`配置已写入 ${path.relative(ROOT, CONFIG)}（备份：${path.relative(ROOT, backup)}）`);
  console.log('重启桥接后生效：');
  console.log('  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -match \'bridge\\.js\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"');
  console.log('  cd ' + ROOT + ' && node src/bridge.js');
}

main();
