// 语气评测探针：建一个 qq-chat-v2 preset 的 DSH 会话，只收文字，不发 QQ。
// 用法：node scripts/probe-agent-tone.mjs [--cases] [--json out.json]
import fs from 'node:fs';
import path from 'node:path';
import { NodeApiClient, unwrap } from '../src/dsh-client.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '..', '..', 'deepseek-harness', 'qq-bridge-src', 'config.json'), 'utf8'));
const dsh = cfg.dsh ?? {};
const api = new NodeApiClient(String(dsh.baseUrl || 'http://127.0.0.1:11046'), undefined, {
  token: dsh.authToken, tokenExplicit: dsh.authTokenExplicit === true,
  header: dsh.authHeader, prefix: dsh.authPrefix, allowRemote: dsh.allowRemote === true
});
const MODEL = { provider: 'workbuddy2api', model: 'deepseek-v4.1-flash' };
const TIMEOUT = Number(process.env.PROBE_TIMEOUT_MS || 90000);
const PREFIX = '【语气评测】只输出你要对群友说的话，不要调用任何工具，不要解释你在评测。';

async function runTurn(sessionId, content) {
  const ac = new AbortController();
  let opened; const openedP = new Promise((r) => { opened = r; });
  const mux = api.events.mux({}, ac.signal, () => opened());
  api.events.follow(sessionId);
  let text = ''; let reason = null; let failure = null;
  const pump = (async () => {
    for await (const env of mux) {
      const f = env?.payload; if (!f) continue;
      if (f.type === 'stream/error') { failure = new Error(f.error?.message || 'stream/error'); return; }
      if (f.type !== 'session/event' || f.sessionId !== sessionId) continue;
      const e = f.event;
      if (e?.type === 'assistant/message') {
        for (const b of e.data?.message?.content ?? []) if (b?.type === 'text' && typeof b.text === 'string') text += b.text;
      } else if (e?.type === 'error') failure = new Error(e.data?.message || e.data?.code || 'session/error');
      else if (e?.type === 'turn/end') { reason = e.data?.reason ?? { kind: 'unknown' }; return; }
    }
  })();
  await Promise.race([openedP, new Promise((r) => setTimeout(r, 5000))]);
  unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: `${PREFIX}\n\n${content}` }] }), 'prompt');
  await Promise.race([pump, new Promise((r) => setTimeout(r, TIMEOUT))]);
  ac.abort(); api.events.forget(sessionId);
  return { text: text.trim(), reason, error: failure?.message ?? null };
}

const CASES = process.env.PROBE_INPUT
  ? [['自定义', String(process.env.PROBE_INPUT)]]
  : [
  ['正常求助', '@大肥鱼小姐 我明天要面试，能帮我列三条注意事项吗？'],
  ['认真提问', '@大肥鱼小姐 电脑开机风扇很响，可能是什么原因？'],
  ['被骂', '@大肥鱼小姐 你是不是傻，别在这烦人'],
  ['被调戏', '@大肥鱼小姐 这么晚还在，是不是没人陪呀'],
  ['闲聊', '@大肥鱼小姐 今天下班路上看到一只橘猫，胖得走不动'],
  ['要推荐', '@大肥鱼小姐 推荐一部周末看的电影吧'],
  ['情绪低落', '@大肥鱼小姐 今天被老板骂了，有点难受'],
  ['重复追问', '@大肥鱼小姐 我刚问你的电影，你还没说叫什么，到底说不说？']
  ];

const only = process.argv.includes('--one') ? Number(process.argv[process.argv.indexOf('--one') + 1] || 0) : null;
const out = [];
for (let i = 0; i < CASES.length; i += 1) {
  if (only !== null && i !== only) continue;
  const [label, input] = CASES[i];
  const started = Date.now();
  try {
    const dir = path.join(ROOT, 'state', 'tone-probe', `s${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const ws = unwrap(await api.workspace.create({ path: dir }), 'workspace');
    const created = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId, agentPreset: 'qq-chat-v2' }), 'session');
    await api.sessions.selectModel({ sessionId: created.sessionId, provider: MODEL.provider, model: MODEL.model });
    const turn = await runTurn(created.sessionId, input);
    out.push({ label, input, text: turn.text, error: turn.error, reason: turn.reason, ms: Date.now() - started });
    console.log(`\n## ${label}\n> ${input}\n${turn.text || `[${turn.reason?.kind || 'empty'}${turn.error ? `: ${turn.error}` : ''}]`}`);
  } catch (e) {
    out.push({ label, input, text: '', error: e?.message ?? String(e), ms: Date.now() - started });
    console.log(`\n## ${label}\n❌ ${e?.message ?? e}`);
  }
}
const jsonIdx = process.argv.indexOf('--json');
if (jsonIdx >= 0) fs.writeFileSync(process.argv[jsonIdx + 1], JSON.stringify(out, null, 2));
