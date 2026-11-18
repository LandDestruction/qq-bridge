const BASE = 'file:///C:/Users/PC/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const out = [];
function say(s) { out.push(s); console.log(s); }

try {
  const cordis = await import(`${BASE}/cordis/lib/index.js`);
  const Context = cordis.Context || cordis.default;
  say(`cordis: Context=${typeof Context} keys=${Object.keys(cordis).slice(0, 12).join(',')}`);
  const ctx = new Context();
  say('ctx created ok');

  for (const name of ['dsh-session', 'dsh-llm', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-system-prompt']) {
    try {
      const m = await import(`${BASE}/${name}/lib/index.js`);
      const keys = Object.keys(m);
      const isPlugin = typeof m.apply === 'function' && typeof m.name === 'string';
      say(`${name}: plugin=${isPlugin} name=${m.name || '-'} inject=${JSON.stringify(m.inject || null)} exports=${keys.length}`);
    } catch (e) {
      say(`${name}: IMPORT FAIL ${e.code || ''} ${String(e.message).slice(0, 120)}`);
    }
  }

  // 试装 agent-loop（最小集可能因缺依赖失败，失败也要看到原因）
  try {
    const al = await import(`${BASE}/dsh-agent-loop/lib/index.js`);
    const p = al.AgentLoop || al.default;
    say(`agent-loop class=${typeof p}`);
    ctx.plugin(p, {});
    say('ctx.plugin(AgentLoop) accepted');
  } catch (e) {
    say(`plugin fail: ${String(e.message).slice(0, 200)}`);
  }
} catch (e) {
  say(`FATAL ${e.code || ''} ${String(e.message).slice(0, 300)}`);
}
