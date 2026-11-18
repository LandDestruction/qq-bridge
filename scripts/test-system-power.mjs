// 系统总开关（一键启动 / 一键停止）的静态契约：后端闸门 + API 语义 + 控制台按钮。
// 只读源码断言，不需要起桥接；真机行为由「暂停后发送被拒」的手工验证覆盖。
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
let fail = 0;
const check = (ok, name, extra = '') => {
  if (ok) { pass += 1; console.log('  ok   ' + name); return; }
  fail += 1;
  console.log('  FAIL ' + name + (extra ? ' — ' + extra : ''));
};

const incoming = read('src/bridge/incoming-runtime.js');
const delivery = read('src/bridge/prompt-delivery.js');
const outbound = read('src/bridge/outbound-text.js');
const policy = read('src/bridge/outbound-policy.js');
const media = read('src/bridge/media-send.js');
const scheduler = read('src/bridge/social-scheduler.js');
const slang = read('src/bridge/slang-runtime.js');
const socialCfg = read('src/bridge/console/social-config.js');
const client = read('public/client.js');
const css = read('public/client.css');
const manifest = JSON.parse(read('src/bridge/manifest.json'));

// ── 入站：两种模式都必须先看总开关 ──────────────────────────────────────────
check(/function pausedInbound\(deps, key, text, recorded\)/.test(incoming), '入站暂停收口是一个函数（不重复写日志/活动记录）');
check(/if \(deps\.socialV2\.paused\) \{ pausedInbound\(deps, key, textContent, true\); return; \}/.test(incoming),
  '社交模式：消息记录后遇到暂停就只留上下文、不推进状态机');
check(/if \(deps\.socialV2\.paused\) \{ pausedInbound\(deps, key, textContent, false\); return; \}/.test(incoming),
  '聊天模式：暂停时不建会话、不投递、不调模型');
check(/系统已暂停/.test(incoming) && /ignore|忽略入站/.test(incoming), '暂停时活动记录写的是「系统已暂停」而不是普通消息');

// ── 投递 / 发送 / 社交 / 学习 ───────────────────────────────────────────────
check(/if \(deps\.socialV2\.paused\) \{[\s\S]{0,220}return \{ ok: true, skipped: true \};/.test(delivery),
  '投递层：暂停时唤醒/社交/重试一律丢弃并释放唤醒租约');
check(/if \(deps\.socialV2\?\.paused\) \{\s*\n\s*\(0, deps\.log\)\(`\[系统\] 已暂停，丢弃发送/.test(outbound),
  '发送层：暂停时一条都不发（排队回复、报错提示也拦）');
check(/if \(deps\.socialV2\?\.paused\) \{[\s\S]{0,160}不发送任何消息/.test(policy),
  'MCP 发送工具：暂停时抛明确错误，agent 不会以为发出去了');
check(/if \(deps\.socialV2\?\.paused\) throw new Error\([\s\S]{0,80}不发表情/.test(media), '表情发送：暂停时同样拦下');
check(/if \(deps\.socialV2\?\.paused\) \{[\s\S]{0,140}丢弃待投递/.test(scheduler), '社交模式：暂停时不再排延迟回复');
check(/if \(deps\.socialV2\?\.paused\) return; \/\/ 系统总开关/.test(scheduler), '社交状态机：暂停时不推进');
check(/if \(deps\.socialV2\?\.paused\) \{[\s\S]{0,120}本批顺延/.test(slang), '黑话学习：暂停时本批顺延（不烧 token，pending 保留）');

// ── 暂停接口语义 ────────────────────────────────────────────────────────────
check(/deps\.socialV2\.pausedSince = paused \? Date\.now\(\) : 0;/.test(socialCfg), '暂停时记下 pausedSince，界面上能看出停了多久');
check(/drainAllPromptQueues\)\('机器人系统已暂停'\)/.test(socialCfg), '暂停时把待投递队列清掉（否则恢复后补发一堆过时回复）');
check(/clearAllSocialV2Timers\)\(\)/.test(socialCfg), '暂停时清掉所有社交/唤醒定时器');
check(/机器人系统已停止（唤醒\/投递\/发送\/学习全部停，控制台照常运行）/.test(socialCfg), '日志说清楚「停的是什么、控制台还在跑」');

// ── 控制台按钮 ──────────────────────────────────────────────────────────────
check(/data-write="power-toggle" data-power="/.test(client), '运行状态卡顶部有启停按钮（data-write=power-toggle）');
check(/qdb-power-state/.test(client) && /已停止|运行中/.test(client), '卡片上直接写出「运行中 / 已停止」');
check(/'power-toggle': function \(btn\) \{/.test(client), '按钮有对应写入动作');
check(/apiWrite\('\/api\/socialV2\/activity', \{ paused: !start \}\)/.test(client), '动作打的是同一个总开关接口');
check(/confirmLabel: start \? '确认启动' : '确认停止'/.test(client), '停止前有二次确认（误点不会直接把机器人停掉）');
check(/控制台继续运行|控制台照常可用|控制台本身不受影响/.test(client), '界面上说明「停的是机器人，控制台继续运行」');
check(/\.qdb-power \{/.test(css) && /\.qdb-power-btn \{/.test(css), '启停块有独立样式');
check(/--ui-danger-strong: #cf3125;/.test(css) && /\.qdb-power-btn \{[\s\S]{0,300}?background: var\(--ui-danger-strong\); color: #fff;/.test(css),
  '「一键停止」用鲜红实底 + 白字（破坏性操作要醒目）');
check(/\.qdb-power-hint \{ grid-column: 1 \/ -1; grid-row: 2; \}/.test(css)
  && /\.qdb-power \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/.test(css),
  '提示文字单独占一整行，不被按钮挤成三行半');
check(/\.qdb-power\[data-tone="off"\] \.qdb-power-btn \{[^}]*box-shadow: none;/.test(css),
  '停止态（一键启动）不继承红按钮的投影');

// ── manifest：运行时依赖必须登记（否则 VM 审计会缺 deps）───────────────────
const depsOf = (file) => (manifest.modules.find((m) => m.file.endsWith(file)) || {}).dependencies || [];
for (const file of ['incoming-runtime.js', 'prompt-delivery.js', 'outbound-text.js', 'outbound-policy.js', 'media-send.js', 'social-scheduler.js', 'slang-runtime.js']) {
  check(depsOf(file).includes('socialV2'), `manifest: ${file} 声明了 socialV2 依赖`);
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
