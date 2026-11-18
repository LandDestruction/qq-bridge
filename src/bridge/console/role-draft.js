// console/role-draft: 「一句话生成角色卡」。
//
// 为什么单独一个模块：生成要调模型（或回落模板）+ 写文件 + 返回当前角色状态，
// 塞进 roles.js 会把那个已经很大的路由函数再撑一截；而 manifests 模块必须 VM-safe，
// 所以纯规则（prompt 组装 / 解析 / 模板兜底 / 重名递增）全部从 src/role-draft.js
// 由 deps 注入，这里只做编排。
export function createConsoleRoleDraft(deps) {
// @bridge-function handleConsoleRoleDraft:start
async function handleConsoleRoleDraft(request) {
  if (!(request.req.method === 'POST' && request.url.pathname === '/api/roles/generate')) return false;
  const body = await request.readBody();
  const ask = String((body && body.request) || '').trim();
  if (ask.length < 2) {
    request.sendJson({ ok: false, error: '先用一句话描述你想要的角色（比如：叫小满，19 岁，安静的画师）' }, 400);
    return true; /* @bridge-handled */
  }
  if (ask.length > 500) {
    request.sendJson({ ok: false, error: '描述太长了：一句话就够，最多 500 字' }, 400);
    return true; /* @bridge-handled */
  }

  // 模型失败不算错误：兜底模板本来就是为了「没配模型 / 断网 / 超时」也能给出能改的骨架。
  let reply = '';
  let modelError = '';
  try {
    const messages = (0, deps.buildRoleDraftMessages)(ask);
    reply = await deps.callRoleDraftModel(messages);
  } catch (error) {
    modelError = String((error && error.message) || error).slice(0, 160);
    (0, deps.log)(`控制台：角色卡生成调用模型失败，改用模板兜底（${modelError}）`);
  }

  const draft = (0, deps.resolveRoleDraft)({ reply, request: ask, modelError });
  let name;
  let content;
  try {
    name = (0, deps.validateRoleName)(draft.name);
    content = (0, deps.validateRoleContent)(draft.content);
  } catch (error) {
    request.sendJson({ ok: false, error: error.message }, 400);
    return true; /* @bridge-handled */
  }

  // 撞名不覆盖别人的卡：自动加 -2 / -3，并把这个事实告诉前端（提示里要出现）。
  const taken = (candidate) => deps.fs.existsSync((0, deps.roleFilePath)(candidate));
  const finalName = (0, deps.uniqueRoleName)(name, taken);
  (0, deps.writeRoleContent)(finalName, content);
  const rs = (0, deps.readRoleState)();
  (0, deps.log)(`控制台：一句话生成角色卡「${finalName}」（${content.length} 字符，来源 ${draft.source}${modelError ? '，模型失败已兜底' : ''}）`);
  request.sendJson({
    ok: true,
    role: finalName,
    requested: draft.name,
    renamed: finalName !== draft.name,
    source: draft.source,
    modelError,
    chars: content.length,
    warnings: (0, deps.roleWarnings)(content),
    // current 给前端判断要不要问「设为当前角色」：没有当前角色时才问。
    current: rs && rs.role ? rs.role : null
  });
  return true; /* @bridge-handled */
}
// @bridge-function handleConsoleRoleDraft:end
  return { handleConsoleRoleDraft };
}
