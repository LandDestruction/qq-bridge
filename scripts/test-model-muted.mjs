// 「模型与高峰」里把当前档位选成「无」= 不调用模型、机器人不说话。
// 这里直接跑 wake-dispatch 的闸：muted 为真时任何唤醒都必须原样退出（不打 API、不发消息）。
import { createWakeDispatch } from '../src/bridge/wake-dispatch.js';

let pass = 0; let fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => { pass++; console.log('✅ ' + name); })
    .catch((e) => { fail++; console.error('❌ ' + name + ' — ' + (e && e.message ? e.message : e)); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }

function makeDeps(muted, extra = {}) {
  const logs = [];
  const calls = { api: 0, send: 0 };
  const deps = {
    cfg: { socialV2: { enabled: true } },
    currentMode: 'reserved2',
    socialV2: { paused: false },
    log: (...a) => logs.push(a.join(' ')),
    isSessionAllowedInCurrentMode: () => true,
    getSocialV2State: () => ({}),
    saveSocialV2State: () => {},
    modelRoutingMutedNow: () => muted,
    api: { session: { prompt: async () => { calls.api++; return {}; } } },
    sendToQQ: async () => { calls.send++; },
    ...extra
  };
  return { deps, logs, calls };
}

await check('档位为「无」：唤醒被跳过且写明原因', async () => {
  const { deps, logs, calls } = makeDeps(true);
  const { sendWakePromptV2 } = createWakeDispatch(deps);
  await sendWakePromptV2('group:100000001', 'admin');
  assert(calls.api === 0, '不应调用模型');
  assert(calls.send === 0, '不应发消息');
  assert(logs.some((l) => l.includes('当前档位设为「无」')), '缺少跳过日志：' + JSON.stringify(logs));
});

await check('档位正常：闸不拦（照常往下走）', async () => {
  const { deps, logs } = makeDeps(false);
  const { sendWakePromptV2 } = createWakeDispatch(deps);
  await sendWakePromptV2('group:100000001', 'admin').catch(() => {});
  assert(!logs.some((l) => l.includes('当前档位设为「无」')), '不该出现跳过日志');
});

await check('没提供闸函数（老调用方）时不炸', async () => {
  const { deps } = makeDeps(false);
  delete deps.modelRoutingMutedNow;
  const { sendWakePromptV2 } = createWakeDispatch(deps);
  await sendWakePromptV2('group:100000001', 'admin').catch(() => {});
});

await check('源码：bridge 暴露 modelRoutingMutedNow，wake-dispatch 里有闸', async () => {
  const { readFileSync } = await import('node:fs');
  const bridge = readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const wd = readFileSync(new URL('../src/bridge/wake-dispatch.js', import.meta.url), 'utf8');
  assert(/modelRoutingMutedNow\(\)/.test(bridge), 'bridge.js 缺 modelRoutingMutedNow');
  assert(/deps\.modelRoutingMutedNow/.test(wd), 'wake-dispatch.js 没接闸');
});

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
