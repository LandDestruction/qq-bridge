// 角色卡「一句话生成」：纯规则 + 路由（假 deps，不碰真模型/真文件）。
// 路由测试覆盖三件事：模型有回就用模型、模型挂了必须回落模板（且不 500）、撞名自动递增。
import * as pure from '../src/role-draft.js';
import { createConsoleRoleDraft } from '../src/bridge/console/role-draft.js';

let pass = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

// ── 纯规则 ────────────────────────────────────────────────────────────────
console.log('## 1. 名字抽取');
check('「叫X」优先', pure.roleDraftNameFrom('叫小满，19 岁，安静画师') === '小满');
check('「名字是X」', pure.roleDraftNameFrom('他的名字是阿澈，说话很直') === '阿澈');
check('没有引导词时取首句', pure.roleDraftNameFrom('一只会写诗的海獭，住在礁石上') === '一只会写诗的海獭');
check('空请求有兜底名', pure.roleDraftNameFrom('') === '新角色');
check('名字里的符号被清掉', !/[^\u4e00-\u9fa5A-Za-z0-9_-]/.test(pure.roleDraftNameFrom('叫 小/满，画师')));

console.log('## 2. 给模型的 prompt');
const msgs = pure.buildRoleDraftMessages('叫小满，19 岁，安静的画师');
check('两条消息（system + user）', msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user');
check('system 写死三段式', /# 角色卡/.test(msgs[0].content) && /## 一、你是谁/.test(msgs[0].content) && /## 二、底色/.test(msgs[0].content) && /## 三、说话方式/.test(msgs[0].content));
check('user 携带原话', msgs[1].content === '叫小满，19 岁，安静的画师');
check('超长请求被截到 500 字以内', pure.buildRoleDraftMessages('字'.repeat(900))[1].content.length <= 500);

console.log('## 3. 清理与解析');
check('去掉 ```md 围栏', !/```/.test(pure.cleanRoleDraftReply('```md\n# 角色卡：小满\n```')));
check('去掉「好的，以下是…」前言', pure.cleanRoleDraftReply('好的，以下是角色卡：\n# 角色卡：小满\n\n## 一、你是谁\n你是小满。').startsWith('# 角色卡：小满'));
const parsed = pure.parseRoleDraft('好的，以下是角色卡：\n```md\n# 角色卡：小满\n\n## 一、你是谁\n你是小满，19 岁。\n\n## 二、底色\n- 安静\n```', '叫小满');
check('解析出名字与正文', parsed && parsed.name === '小满' && parsed.content.includes('## 一、你是谁'));
check('正文末尾补换行、不含围栏', parsed && parsed.content.endsWith('\n') && !parsed.content.includes('```'));
check('缺三段结构判失败', pure.parseRoleDraft('小满，19 岁，画师。', '叫小满') === null);
check('空回复判失败', pure.parseRoleDraft('', '叫小满') === null);
check('标题名字里非法字符被清', pure.parseRoleDraft('# 角色卡：小/满\n\n## 一、你是谁\n你是小满。', '') .name === '小满');

console.log('## 4. 兜底模板');
const stub = pure.stubRoleDraft('叫小满，19 岁，安静的画师');
check('source 标成 stub', stub.source === 'stub');
check('骨架含三段', /## 一、你是谁/.test(stub.content) && /## 二、底色/.test(stub.content) && /## 三、说话方式/.test(stub.content));
check('原话被塞进「你是谁」', stub.content.includes('叫小满，19 岁，安静的画师'));
check('模型失败时 resolveRoleDraft 回落 stub', pure.resolveRoleDraft({ reply: '', request: '叫小满', modelError: 'boom' }).source === 'stub');
check('模型成功时用模型结果', pure.resolveRoleDraft({ reply: '# 角色卡：小满\n\n## 一、你是谁\n你是小满。', request: '叫小满' }).source === 'model');

console.log('## 5. 重名递增');
check('不撞名就原样', pure.uniqueRoleName('小满', () => false) === '小满');
check('撞一次变 -2', pure.uniqueRoleName('小满', (n) => n === '小满') === '小满-2');
check('连撞变 -3', pure.uniqueRoleName('小满', (n) => n === '小满' || n === '小满-2') === '小满-3');

// ── 路由（假 deps）─────────────────────────────────────────────────────────
console.log('## 6. 路由：POST /api/roles/generate');
function makeDeps(overrides = {}) {
  const files = new Map();
  const logs = [];
  const warnings = [];
  const base = {
    buildRoleDraftMessages: pure.buildRoleDraftMessages,
    resolveRoleDraft: pure.resolveRoleDraft,
    uniqueRoleName: pure.uniqueRoleName,
    validateRoleName: (n) => { const t = String(n || '').trim(); if (!t) throw new Error('角色名不能为空'); if (/[\/\\:*?"<>|]/.test(t)) throw new Error('角色名不能含 / \\ : * ? " < > |'); return t; },
    validateRoleContent: (c) => { const t = String(c || ''); if (!t.trim()) throw new Error('正文不能为空'); return t; },
    roleFilePath: (n) => `/roles/${n}.md`,
    fs: { existsSync: (p) => files.has(p) },
    writeRoleContent: (n, c) => { files.set(`/roles/${n}.md`, c); },
    readRoleState: () => ({ role: null, mode: 'active' }),
    roleWarnings: (c) => { warnings.push(c); return []; },
    log: (line) => logs.push(line),
    callRoleDraftModel: async () => '# 角色卡：小满\n\n## 一、你是谁\n你是小满。',
    ...overrides
  };
  return { deps: base, files, logs };
}
async function call(deps, body, method = 'POST', pathname = '/api/roles/generate') {
  let sent = null;
  const request = {
    req: { method },
    url: new URL('http://127.0.0.1:3100' + pathname),
    readBody: async () => body,
    sendJson: (data, status) => { sent = { data, status: status || 200 }; }
  };
  const { handleConsoleRoleDraft } = createConsoleRoleDraft(deps);
  const handled = await handleConsoleRoleDraft(request);
  return { handled, sent };
}

{
  const { deps, files } = makeDeps();
  const { handled, sent } = await call(deps, { request: '叫小满，19 岁，安静的画师' });
  check('接管了路由', handled === true);
  check('返回 ok + 角色名', sent && sent.data.ok === true && sent.data.role === '小满');
  check('source=model', sent && sent.data.source === 'model');
  check('真写了角色文件', files.has('/roles/小满.md'));
  check('不撞名时 renamed=false', sent && sent.data.renamed === false);
}
{
  const { deps, files } = makeDeps();
  files.set('/roles/小满.md', 'old');
  const { sent } = await call(deps, { request: '叫小满' });
  check('撞名自动变 小满-2', sent && sent.data.role === '小满-2' && sent.data.renamed === true);
  check('不覆盖原文件', files.get('/roles/小满.md') === 'old');
}
{
  const { deps } = makeDeps({ callRoleDraftModel: async () => { throw new Error('模型返回 HTTP 500'); } });
  const { sent } = await call(deps, { request: '叫小满' });
  check('模型挂了仍然 200', sent && sent.status === 200 && sent.data.ok === true);
  check('回落 stub 并把原因带回去', sent && sent.data.source === 'stub' && /HTTP 500/.test(sent.data.modelError));
}
{
  const { deps } = makeDeps();
  const { sent } = await call(deps, { request: '短' });
  check('太短的请求 400', sent && sent.status === 400 && /一句话/.test(sent.data.error));
}
{
  const { deps } = makeDeps();
  const { sent } = await call(deps, { request: '字'.repeat(900) });
  check('太长的请求 400', sent && sent.status === 400);
}
{
  const { deps } = makeDeps();
  const { handled } = await call(deps, {}, 'POST', '/api/roles/create');
  check('不接管别的路由', handled === false);
}
{
  const { deps } = makeDeps({ readRoleState: () => ({ role: '阿澈', mode: 'active' }) });
  const { sent } = await call(deps, { request: '叫小满' });
  check('已有当前角色时把 current 带回去（前端据此不问）', sent && sent.data.current === '阿澈');
}

// 兜底拼出来的卡要是「能直接用的卡」：说话方式里不能把写给模型的指令漏进正文，
// 也不能只剩骨架没内容（第一版就是这样：最后一条写着「按它的性格写具体说法」）。
{
  const plain = pure.stubRoleDraft('叫阿苇，24 岁的咖啡师，话不多但会记得别人爱喝什么');
  check('兜底卡里没有「给模型的指令」漏进正文', !/按它的性格|不要写「友好」|别停在形容词/.test(plain.content));
  check('兜底卡的「说话方式」有具体条目', /## 三、说话方式\n- /.test(plain.content));
}

console.log('');
console.log(`角色卡生成：通过 ${pass} / 失败 ${fails.length}`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
