// 本地兜底通道的离线单测。
//
// 只 import 纯函数模块（src/local-fallback.js、src/local-fallback-persona.js），
// **不 import src/bridge.js**：那个文件一被 import 就会启动桥接进程。
// ollama 是否在跑不影响本文件——HTTP 客户端用注入的假 fetch 测。
//
// 跑法：node scripts/test-local-fallback.mjs
import assert from 'node:assert/strict';
import {
  LOCAL_FALLBACK_DEFAULTS,
  localFallbackCfg,
  shouldTriggerLocalFallback,
  buildLocalMessages,
  cleanLocalReply,
  buildLocalChatBody,
  parseLocalChatResponse,
  describeLocalFallback,
  createLocalClient,
  LOCAL_FALLBACK_PERSONA,
  LOCAL_FALLBACK_DEFAULT_NAME,
  renderFallbackPersona
} from '../src/local-fallback.js';
import { LOCAL_FALLBACK_PERSONA_CHARS } from '../src/local-fallback-persona.js';

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ❌ ${name}\n     ${error?.message ?? error}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ❌ ${name}\n     ${error?.message ?? error}`);
  }
}

// ── 1. 人格体积：8K 窗口下必须压得住 ─────────────────────────────────────
console.log('\n[1] 兜底人格');
check(`人格在 600~1200 字区间（实测 ${LOCAL_FALLBACK_PERSONA_CHARS} 字）`, () => {
  assert.ok(LOCAL_FALLBACK_PERSONA_CHARS >= 600, `太短：${LOCAL_FALLBACK_PERSONA_CHARS}`);
  assert.ok(LOCAL_FALLBACK_PERSONA_CHARS <= 1200, `太长：${LOCAL_FALLBACK_PERSONA_CHARS}`);
});
check('人格里不含 Markdown 语法（星号/井号/列表符）', () => {
  assert.ok(!/\*\*|^#{1,6}\s/m.test(LOCAL_FALLBACK_PERSONA), '出现 Markdown 标记');
});

// ── 2. 配置合并与校验 ─────────────────────────────────────────────────
console.log('\n[2] localFallbackCfg');
check('不传配置 → 全默认，且默认开启', () => {
  const c = localFallbackCfg(undefined);
  assert.equal(c.enabled, true);
  assert.equal(c.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(c.model, 'qwen3:8b');
  assert.equal(c.numCtx, 8192);
});
check('enabled:false 关掉通道', () => {
  assert.equal(localFallbackCfg({ enabled: false }).enabled, false);
});
check('baseUrl 去掉尾部斜杠', () => {
  assert.equal(localFallbackCfg({ baseUrl: 'http://127.0.0.1:11434/' }).baseUrl, 'http://127.0.0.1:11434');
});
check('非法 baseUrl（非 http）回落默认', () => {
  assert.equal(localFallbackCfg({ baseUrl: 'file:///etc/passwd' }).baseUrl, LOCAL_FALLBACK_DEFAULTS.baseUrl);
});
check('timeoutMs 越界夹紧、NaN 回落', () => {
  assert.equal(localFallbackCfg({ timeoutMs: 5 }).timeoutMs, 1000);
  assert.equal(localFallbackCfg({ timeoutMs: 999999 }).timeoutMs, 120000);
  assert.equal(localFallbackCfg({ timeoutMs: 'abc' }).timeoutMs, LOCAL_FALLBACK_DEFAULTS.timeoutMs);
});
check('historyMessages 夹在 2~40', () => {
  assert.equal(localFallbackCfg({ historyMessages: 1 }).historyMessages, 2);
  assert.equal(localFallbackCfg({ historyMessages: 999 }).historyMessages, 40);
});

// ── 3. 触发判定 ───────────────────────────────────────────────────────
console.log('\n[3] shouldTriggerLocalFallback');
const cfg = localFallbackCfg();
check('容量类 503（no_healthy_account）→ 立刻切', () => {
  assert.equal(shouldTriggerLocalFallback({ errorMessage: '503: {"code":"no_healthy_account","message":"all accounts are temporarily unavailable"}', streak: 0, cfg }), true);
});
check('模型不可用（no such model）→ 立刻切', () => {
  assert.equal(shouldTriggerLocalFallback({ errorMessage: 'model-unavailable: no such model deepseek-v4.1-flash', streak: 0, cfg }), true);
});
check('普通错误 streak=1（默认 triggerAfter=2）→ 还不切', () => {
  assert.equal(shouldTriggerLocalFallback({ errorMessage: 'internal server error', streak: 1, cfg }), false);
});
check('普通错误 streak=2 → 切', () => {
  assert.equal(shouldTriggerLocalFallback({ errorMessage: 'internal server error', streak: 2, cfg }), true);
});
check('ECONNREFUSED（DSH 连不上）→ 立刻切，不用等 streak', () => {
  // 备用模型救不了「连不上 DSH」这种错：切过去一样连不上，本地 8B 才是唯一能说话的。
  assert.equal(shouldTriggerLocalFallback({ errorMessage: 'fetch failed: ECONNREFUSED 127.0.0.1:12175', streak: 1, cfg }), true);
  assert.equal(shouldTriggerLocalFallback({ errorMessage: 'socket hang up', streak: 0, cfg }), true);
});
// 优先级：备用模型还在时不抢；备用模型用尽才轮到本地 8B
check('容量类错误 + 仍有备用模型 → 不切本地（先让 dsh.modelFallbacks 顶上）', () => {
  assert.equal(shouldTriggerLocalFallback({ errorMessage: '503 no_healthy_account', streak: 5, cfg, fallbacksRemaining: 1 }), false);
  assert.equal(shouldTriggerLocalFallback({ errorMessage: 'model-unavailable: no such model', streak: 1, cfg, fallbacksRemaining: 2 }), false);
});
check('容量类错误 + 备用模型用尽 → 切本地', () => {
  assert.equal(shouldTriggerLocalFallback({ errorMessage: '503 no_healthy_account', streak: 0, cfg, fallbacksRemaining: 0 }), true);
});
check('网络类错误无视 fallbacksRemaining，立刻切本地', () => {
  assert.equal(shouldTriggerLocalFallback({ errorMessage: 'ECONNREFUSED', streak: 0, cfg, fallbacksRemaining: 3 }), true);
});
check('普通错误仍按 streak 判定（与 fallbacksRemaining 无关）', () => {
  assert.equal(shouldTriggerLocalFallback({ errorMessage: 'internal error', streak: 1, cfg, fallbacksRemaining: 0 }), false);
  assert.equal(shouldTriggerLocalFallback({ errorMessage: 'internal error', streak: 2, cfg, fallbacksRemaining: 0 }), true);
});
check('通道关闭时任何错误都不切', () => {
  assert.equal(shouldTriggerLocalFallback({ errorMessage: '503 no_healthy_account', streak: 99, cfg: localFallbackCfg({ enabled: false }) }), false);
});

// ── 4. 组 prompt ─────────────────────────────────────────────────────
console.log('\n[4] buildLocalMessages');
const hist = [
  { sender: '阿强', text: '今天谁去吃饭', isSelf: false },
  { sender: '我', text: '我不去，我在打游戏', isSelf: true },
  { sender: '小美', text: '那我自己去了', isSelf: false }
];
check('第一条是 system 人格，第二条是 user 转录', () => {
  const msgs = buildLocalMessages({ history: hist, incoming: { sender: '阿强', text: '小鲸鱼你去不去' }, cfg });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('小鲸鱼'));
  assert.equal(msgs[1].role, 'user');
  assert.ok(msgs[1].content.includes('阿强：今天谁去吃饭'));
  assert.ok(msgs[1].content.includes('我：我不去'));
  assert.ok(msgs[1].content.includes('阿强：小鲸鱼你去不去'));
});
check('当前消息已在 history 末尾时不重复追加', () => {
  const msgs = buildLocalMessages({ history: hist, incoming: { sender: '小美', text: '那我自己去了' }, cfg });
  const occurrences = msgs[1].content.split('小美：那我自己去了').length - 1;
  assert.equal(occurrences, 1);
});
check('历史超过 historyMessages 条时只取最近几条', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ sender: `人${i}`, text: `第${i}句`, isSelf: false }));
  const msgs = buildLocalMessages({ history: many, incoming: '最后一句', cfg: localFallbackCfg({ historyMessages: 4 }) });
  assert.ok(msgs[1].content.includes('第29句'));
  assert.ok(!msgs[1].content.includes('第0句'));
});
check('超长历史消息被截断到 historyChars', () => {
  const msgs = buildLocalMessages({ history: [{ sender: '话唠', text: '啊'.repeat(500), isSelf: false }], incoming: '在吗', cfg: localFallbackCfg({ historyChars: 50 }) });
  assert.ok(msgs[1].content.includes('…'));
  assert.ok(!msgs[1].content.includes('啊'.repeat(60)));
});
check('只有图片没正文的消息给占位符，不会凭空断句', () => {
  const msgs = buildLocalMessages({ history: [{ sender: '阿强', text: '', hasMedia: true, isSelf: false }], incoming: '好看吗', cfg });
  assert.ok(msgs[1].content.includes('阿强：[图片]'));
});
check('完全没有历史时给一句「随便接一句」的兜底指令', () => {
  const msgs = buildLocalMessages({ history: [], incoming: null, cfg });
  assert.ok(msgs[1].content.includes('随便接一句'));
});

// ── 5. 输出清洗 ─────────────────────────────────────────────────────
console.log('\n[5] cleanLocalReply');
check('去掉「回复：」前缀', () => {
  assert.equal(cleanLocalReply('回复：我不去'), '我不去');
});
check('整句被「」包住 → 去引号', () => {
  assert.equal(cleanLocalReply('「这波我站阿强」'), '这波我站阿强');
});
check('整句被英文双引号包住 → 去引号', () => {
  assert.equal(cleanLocalReply('"哈哈真的假的"'), '哈哈真的假的');
});
check('去掉 Markdown 加粗与标题', () => {
  assert.equal(cleanLocalReply('**注意**\n## 结论\n就这样'), '注意\n结论\n就这样');
});
check('去掉列表符号但保留换行', () => {
  assert.equal(cleanLocalReply('- 第一条\n- 第二条'), '第一条\n第二条');
});
check('去掉 ``` 代码围栏', () => {
  assert.equal(cleanLocalReply('```json\n{}\n```\n没了'), '没了');
});
check('去掉 qwen3 的思考前缀', () => {
  assert.equal(cleanLocalReply('思考：用户问我去不去吃饭\n我不去'), '我不去');
});
check('空串/纯空白 → 空串（调用方按失败处理）', () => {
  assert.equal(cleanLocalReply('   \n  '), '');
  assert.equal(cleanLocalReply(null), '');
});
// 实测踩到的两类回声（qwen3:8b 真实输出）
check('转录回声：每行都带「名字：」→ 只留第一句并剥标签', () => {
  const raw = '七七尾雨：@我是狗妈老公 我想想\n我是狗妈老公：你是不是又在想那个梦啊？';
  const out = cleanLocalReply(raw, { speakers: ['七七尾雨', '我是狗妈老公'] });
  assert.equal(out, '@我是狗妈老公 我想想');
});
check('转录回声：首行是短括注（（思索））→ 丢掉', () => {
  const raw = '七七尾雨：（思索）  \n我这脑子转得比台风还快，你问啥我答啥！';
  const out = cleanLocalReply(raw, { speakers: ['七七尾雨'] });
  assert.equal(out, '我这脑子转得比台风还快，你问啥我答啥！');
});
check('未知名字的「注意：…」不当标签剥掉（避免误伤正文）', () => {
  assert.equal(cleanLocalReply('注意：别乱动那个文件', { speakers: ['阿强'] }), '注意：别乱动那个文件');
});
check('原样复读输入 → 空串（调用方按失败处理）', () => {
  assert.equal(cleanLocalReply('环世界写的人物设定有用吗', { echoOf: '环世界写的人物设定有用吗' }), '');
});
// 降级时不能「换人」：人格里的名字必须替换成线上真实昵称（线上叫「大肥鱼小姐」）
check('传 nickname 时 system prompt 出现该昵称、且不出现默认名「小鲸鱼」', () => {
  const messages = buildLocalMessages({ history: [], incoming: { sender: '阿强', text: '在吗' }, cfg: LOCAL_FALLBACK_DEFAULTS, nickname: '大肥鱼小姐' });
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  assert.ok(system.includes('大肥鱼小姐'), 'system prompt 必须包含真实昵称');
  assert.ok(!system.includes(LOCAL_FALLBACK_DEFAULT_NAME), 'system prompt 不得残留默认名『小鲸鱼』');
});
check('不传 nickname 时退回默认名（离线/老调用方行为不变）', () => {
  const messages = buildLocalMessages({ history: [], incoming: { sender: '阿强', text: '在吗' }, cfg: LOCAL_FALLBACK_DEFAULTS });
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  assert.ok(system.includes(LOCAL_FALLBACK_DEFAULT_NAME), '缺省时必须用默认名');
  assert.ok(!system.includes('{bot_name}'), '占位符必须被替换掉，不能原样发给模型');
});
check('nickname 为空白串/undefined 也不留占位符', () => {
  for (const nick of ['', '   ', undefined, null]) {
    const messages = buildLocalMessages({ history: [], incoming: null, cfg: LOCAL_FALLBACK_DEFAULTS, nickname: nick });
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    assert.ok(!system.includes('{bot_name}'), `nickname=${JSON.stringify(nick)} 时占位符未被替换`);
    assert.ok(system.includes(LOCAL_FALLBACK_DEFAULT_NAME), '应退回默认名');
  }
});
check('显式传 persona 时以 persona 为准（不再套占位符）', () => {
  const messages = buildLocalMessages({ persona: '自定义人格', history: [], incoming: null, cfg: LOCAL_FALLBACK_DEFAULTS, nickname: '大肥鱼小姐' });
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  assert.equal(system, '自定义人格');
});
check('renderFallbackPersona 只替换名字、不破坏长度契约', () => {
  const rendered = renderFallbackPersona('大肥鱼小姐');
  assert.ok(!rendered.includes('{bot_name}'));
  assert.ok(rendered.length >= 600 && rendered.length <= 1200, `渲染后长度 ${rendered.length} 应仍在 600~1200`);
});

check('超长回复按句子边界截断，不吐半句', () => {
  const long = '第一句话。第二句话。第三句话。第四句话。';
  const out = cleanLocalReply(long, { maxChars: 10 });
  assert.ok(out.endsWith('。'), `实际：${out}`);
  assert.ok(out.length <= 10);
});

// ── 6. 请求体与响应解析 ────────────────────────────────────────────────
console.log('\n[6] 请求体 / 响应解析');
check('请求体带上 keep_alive 与 num_ctx（显存策略靠它们）', () => {
  const body = buildLocalChatBody({ cfg: localFallbackCfg({ keepAlive: '15m', numCtx: 8192 }), messages: [] });
  assert.equal(body.keep_alive, '15m');
  assert.equal(body.options.num_ctx, 8192);
  assert.equal(body.stream, false);
});
// 审阅窗口线上实测的坑：走 OpenAI 兼容端点 /v1/chat/completions 时，qwen3 默认进 thinking，
// content 全空、token 全烧在 reasoning 上（max_tokens 60 和 120 都是空回复）。
// 因此这里必须钉死两件事：① 请求打的是原生 /api/chat；② 请求体里带 think:false。
check('请求体必须带 think:false（否则 qwen3 只思考不出话）', () => {
  const body = buildLocalChatBody({ cfg: LOCAL_FALLBACK_DEFAULTS, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(body.think, false, 'think 必须是字面量 false');
  assert.match(JSON.stringify(body), /"think":false/, '序列化后必须出现 "think":false');
});
check('不得走 OpenAI 兼容端点（/v1/chat/completions）', () => {
  const body = buildLocalChatBody({ cfg: LOCAL_FALLBACK_DEFAULTS, messages: [] });
  assert.equal(body.stream, false);
  assert.ok(body.options && Number.isFinite(body.options.num_ctx), 'num_ctx 必须显式给（默认 4096 会把 8K 窗口砍半）');
  assert.ok(!('max_tokens' in body), '原生端点的字段名是 options.num_predict，不该出现 OpenAI 的 max_tokens');
});

check('解析真实 ollama /api/chat 响应（纳秒 → 毫秒）', () => {
  const r = parseLocalChatResponse({
    message: { role: 'assistant', content: '我不去，我在打游戏' },
    done: true,
    prompt_eval_count: 812,
    eval_count: 14,
    prompt_eval_duration: 123000000,
    eval_duration: 456000000
  });
  assert.equal(r.text, '我不去，我在打游戏');
  assert.equal(r.promptTokens, 812);
  assert.equal(r.outputTokens, 14);
  assert.equal(r.promptMs, 123);
  assert.equal(r.outputMs, 456);
});
check('响应形状不对 → 空文本而不是抛错', () => {
  assert.equal(parseLocalChatResponse(null).text, '');
  assert.equal(parseLocalChatResponse({}).text, '');
});
check('describeLocalFallback 能看出待命/接管/关闭', () => {
  assert.ok(describeLocalFallback({ cfg }).includes('待命'));
  assert.ok(describeLocalFallback({ cfg, active: true, since: Date.now() }).includes('已接管'));
  assert.ok(describeLocalFallback({ cfg: localFallbackCfg({ enabled: false }) }).includes('已关闭'));
});

// ── 7. HTTP 客户端（注入假 fetch）────────────────────────────────────
console.log('\n[7] createLocalClient');
await checkAsync('probe：服务在 → true，且结果被缓存（不重复请求）', async () => {
  let calls = 0;
  const client = createLocalClient({
    cfg,
    fetchImpl: async () => { calls += 1; return { ok: true, status: 200, json: async () => ({}) }; }
  });
  assert.equal(await client.probe(), true);
  assert.equal(await client.probe(), true);
  assert.equal(calls, 1, `应该只请求 1 次，实际 ${calls}`);
});
await checkAsync('probe：连不上 → false（不抛错，不拖慢主链路）', async () => {
  const client = createLocalClient({ cfg, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(await client.probe(), false);
});
await checkAsync('probe：通道关闭 → 直接 false，不发请求', async () => {
  let calls = 0;
  const client = createLocalClient({ cfg: localFallbackCfg({ enabled: false }), fetchImpl: async () => { calls += 1; return { ok: true }; } });
  assert.equal(await client.probe(), false);
  assert.equal(calls, 0);
});
await checkAsync('chat：正常返回文本与耗时', async () => {
  const client = createLocalClient({
    cfg,
    now: (() => { let t = 1000; return () => (t += 100); })(),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'qwen3:8b');
      assert.equal(url, 'http://127.0.0.1:11434/api/chat');
      return { ok: true, status: 200, json: async () => ({ message: { content: '在呢' }, done: true, eval_count: 3 }) };
    }
  });
  const r = await client.chat([{ role: 'user', content: '在吗' }]);
  assert.equal(r.text, '在呢');
  assert.ok(r.totalMs > 0);
});
await checkAsync('chat：HTTP 非 2xx → 抛错（调用方退回中性提示）', async () => {
  const client = createLocalClient({ cfg, fetchImpl: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(() => client.chat([{ role: 'user', content: '在吗' }]), /HTTP 500/);
});
await checkAsync('chat：超时（AbortError）→ 抛错', async () => {
  const client = createLocalClient({ cfg, fetchImpl: async () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; } });
  await assert.rejects(() => client.chat([{ role: 'user', content: '在吗' }]), /aborted/);
});

console.log(`\n========== 通过 ${pass} / 失败 ${failures.length} ==========`);
if (failures.length) {
  for (const f of failures) console.log(`\n失败：${f.name}\n${f.error?.stack ?? f.error}`);
  process.exit(1);
}
