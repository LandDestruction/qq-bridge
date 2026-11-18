// console/tools-gate: 机器人工具能力（socialV2.tools）的开关清单与读写。无启动副作用，全部逻辑按请求触发。
//
// 为什么需要它：工具开关分两段生效——桥接在**调用期**用 v2ToolEnabled(flag) 兜底 403（立刻生效），
// 而模型侧能不能看见这个工具靠 MCP 的**注册期过滤**（src/mcp-snowluma-safe.js 的 TOOL_CONFIG_FLAGS），
// 那只在 MCP 进程启动时读一次 config。所以「关闭」之后模型仍然会收到工具描述与 schema，直到重启 DSH。
// 接口必须把这个时延如实告诉前端（reloadRequired + note），不能让页面假装关掉就立刻消失。
//
// 边界：
//   1) 只认 config 里真实存在的开关（目录表 + 当前 cfg 里多出来的 flag）；未知 key 一律 400，不做静默忽略。
//   2) 写盘走 deps.updateConfigFile（读盘-合并-写），不是拿内存快照整份重写，避免抹掉并发写入。
//   3) 和 /api/config 同口径：带 x-agent-call / x-agent-token 的请求一律 403（智能体不得自己放开闸门）。
// Live dependencies: ROOT, atomicWriteJson, cfg, log, path, reloadConfigFromDisk, updateConfigFile
const TOOLS_GATE_GROUPS = Object.freeze([
  { id: 'send', title: '消息收发' },
  { id: 'read', title: '读取与查看' },
  { id: 'media', title: '媒体与表情' },
  { id: 'memory', title: '记忆与人设' },
  { id: 'wake', title: '状态与唤醒' },
  { id: 'history', title: '记录与检索' },
  { id: 'slang', title: '黑话与梗' }
]);
const TOOLS_GATE_GROUP_ORDER = TOOLS_GATE_GROUPS.map((group) => group.id);
// 目录：每项对应 config.json 里 socialV2.tools 的一个 flag。顺序即前端展示顺序（再按 group 分组）。
// title 是用户视角的中文短名，desc 一句话说清「开了能干什么」。
const TOOLS_GATE_CATALOG = Object.freeze([
  { flag: 'sendMessage', tool: 'qq_send_message', title: '发消息（唯一入口）', desc: '群聊/私聊、一条/多条、引用与 @ 都在这里', group: 'send' },
  { flag: 'sendPoke', tool: 'qq_send_poke', title: '戳一下对方', desc: '发一个拍一拍', group: 'send' },
  { flag: 'waitMessages', tool: 'qq_wait_for_messages', title: '等对方说话', desc: '等新消息或静默窗口', group: 'send' },
  { flag: 'getPrompt', tool: 'qq_get_prompt', title: '看自己的人设', desc: '查看当前提示词与配置', group: 'read' },
  { flag: 'getUnread', tool: 'qq_get_unread_messages', title: '查看未读消息', desc: '读还没看的消息', group: 'read' },
  { flag: 'getRecent', tool: 'qq_get_recent_messages', title: '看最近消息', desc: '读最近的聊天记录', group: 'read' },
  { flag: 'getMyRecent', tool: 'qq_get_my_recent_messages', title: '看自己说话', desc: '回顾自己最近发的消息', group: 'read' },
  { flag: 'getMessageDetail', tool: 'qq_get_message_detail', title: '查单条详情', desc: '看一条消息的发送者与正文', group: 'read' },
  { flag: 'getActiveMembers', tool: 'qq_get_active_members', title: '看活跃成员', desc: '谁最近在群里说话', group: 'read' },
  { flag: 'socialState', tool: 'qq_social_state', title: '看会话状态', desc: '唤醒配置与未读数', group: 'read' },
  { flag: 'getImages', tool: 'qq_get_message_images', title: '看图片内容', desc: '把消息里的图看懂', group: 'read' },
  { flag: 'getForwardMsg', tool: 'qq_get_forward_msg', title: '看合并转发', desc: '展开聊天记录卡片', group: 'read' },
  { flag: 'listStickers', tool: 'qq_list_stickers', title: '翻表情收藏', desc: '列出账号收藏的表情', group: 'media' },
  { flag: 'getStickerImage', tool: 'qq_get_sticker_image', title: '看表情样子', desc: '把收藏表情当图看懂', group: 'media' },
  { flag: 'sendSticker', tool: 'qq_send_sticker', title: '发表情包', desc: '从收藏里挑一张表情发给群友', group: 'media' },
  { flag: 'setStickerRemark', tool: 'qq_set_sticker_remark', title: '改表情备注', desc: '给收藏表情改个备注', group: 'media' },
  { flag: 'stickerNote', tool: 'qq_sticker_note', title: '记表情含义', desc: '给表情记本地笔记与标签', group: 'media' },
  { flag: 'collectSticker', tool: 'qq_collect_sticker', title: '收藏表情', desc: '把别人的表情收进来', group: 'media' },
  { flag: 'getSelfImage', tool: 'qq_get_self_image', title: '看自己形象', desc: '查看自己的 Q 版形象图', group: 'media' },
  { flag: 'sendVoice', tool: 'qq_send_voice / qq_list_voices', title: '发语音条', desc: '从语音库发一条语音', group: 'media' },
  { flag: 'tts', tool: 'qq_send_tts', title: '语音合成', desc: '把文字合成语音发出去', group: 'media' },
  { flag: 'stickerAutoDescribe', tool: '', title: '表情自动识图', desc: '自动给收藏表情写说明', group: 'media' },
  // 下面 3 个不在 config-load 的默认表里，但线上 config.json 里确实有（sendImage/draw 在
  // mcp-snowluma-safe/tools-media.js 里无条件注册、只靠调用期 v2ToolEnabled 兜底；
  // recall 是 7 天归档检索，注册期按 archive.enabled 与 tools.recall 双门控）。
  // 写进目录是为了让面板有稳定的中文名与分组，否则它们会掉进「其它」的兜底条目里。
  { flag: 'sendImage', tool: 'qq_send_image', title: '发图片', desc: '发一张图片到会话', group: 'media' },
  { flag: 'draw', tool: 'qq_draw', title: '画张图', desc: '按描述生成图片发出去', group: 'media' },
  { flag: 'memory', tool: 'qq_memory', title: '记群友的事', desc: '看/记/删/清：话题、印象与没说完的话', group: 'memory' },
  { flag: 'memoryEvent', tool: 'qq_memory_event', title: '记共同事件', desc: '记住一起经历过的事', group: 'memory' },
  { flag: 'setPersona', tool: 'qq_set_persona', title: '设私聊人设', desc: '给私聊设置角色扮演人设', group: 'memory' },
  { flag: 'feedback', tool: 'qq_report_feedback', title: '跟管理员反馈', desc: '把遇到的问题报给管理端', group: 'memory' },
  { flag: 'setWakeConfig', tool: 'qq_set_wake_config', title: '设唤醒规则', desc: '什么时候该叫醒它', group: 'wake' },
  { flag: 'markRead', tool: 'qq_mark_read', title: '标记已读', desc: '把看过的消息标成已读', group: 'wake' },
  { flag: 'searchHistory', tool: 'qq_search_history', title: '翻旧记录', desc: '跨会话搜很久以前的消息', group: 'history' },
  { flag: 'recall', tool: 'qq_recall', title: '搜聊天归档', desc: '在 7 天归档里按词找消息', group: 'history' },
  { flag: 'slangQuery', tool: 'qq_slang_query', title: '查群聊黑话', desc: '看已确认的梗与网络表达', group: 'slang' },
  { flag: 'slangSubmit', tool: 'qq_slang_submit', title: '报黑话候选', desc: '把不懂的梗交给管理员', group: 'slang' },
  // 下面 3 个两份默认表都没有（隐式常开），但代码里确实在用；列出来才能被关掉并且有中文名。
  { flag: 'getGroupMembers', tool: 'qq_get_group_members', title: '看群成员', desc: '拉群成员名单，找人取 QQ 号', group: 'read' },
  { flag: 'selfModel', tool: 'qq_self_model', title: '查自己用的模型', desc: '看当前推理模型与推理强度', group: 'read' },
  { flag: 'affinityShift', tool: 'qq_affinity_shift', title: '调好感度', desc: '微调对某个群友的好感分', group: 'memory' },
]);
// 旧发送入口的开关：模型侧已经看不到这些工具（合并进 qq_send_message），但桥接的
// /api/send/group、/api/socialV2/send-burst 等旧端点仍按它们兜底 403，所以配置里还留着。
// 面板不再单列它们（否则「其它」组会冒出四个用户看不懂的英文开关），但读写仍然接受。
const TOOLS_GATE_LEGACY_FLAGS = Object.freeze(['sendGroup', 'sendPrivate', 'reply', 'sendBurst']);
// 与 mcp-snowluma-safe.js 的 TOOL_CONFIG_FLAGS 同源（这里只拷一份做展示与校验，不改那份注册表）。
// 含义：这些 flag 参与 MCP 注册期过滤；不在这里的 flag 只靠桥接调用期 403 生效。
const TOOLS_GATE_MCP_FLAGS = Object.freeze([
  'getPrompt', 'getUnread', 'getRecent', 'socialState', 'markRead', 'setWakeConfig',
  'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers',
  'getGroupMembers', 'memory', 'slangQuery', 'slangSubmit', 'sendVoice', 'sendPoke', 'getImages',
  'getForwardMsg', 'listStickers', 'getStickerImage', 'sendSticker', 'collectSticker', 'getSelfImage',
  'stickerNote', 'setStickerRemark', 'selfModel',
  // 2026-10-30 自检 WARN 修复：qq_draw / qq_send_image 在 tools-media.js 里是「注册期挂上、
  // 调用期再按 socialV2.tools.<flag> 与依赖就绪情况拒绝」的形态（draw 还要求 imagegenReady），
  // 面板的 mcpRegistered 漏了这两个 flag 会一直显示「未注册」，与实际不符 → 补进来。
  'draw', 'sendImage'
]);
// 调用期没有 403 兜底的开关：searchHistory / stickerAutoDescribe 只影响提示词拼装，
// recall 只在注册期按 archive.enabled + tools.recall 双门控（关掉本轮也不会 403）。
// 关掉它们不等于桥接会拒绝调用，所以前端要把 guard:false 标出来。
const TOOLS_GATE_GUARD_OFF = Object.freeze(['searchHistory', 'stickerAutoDescribe', 'recall']);
// 后端目前并不认这两个 flag（searchHistory 实际校验 cfg.socialV2.historySearch，见
// bridge/console/wake-controls.js:8；memoryEvent 实际校验 memory，见 bridge/console/memory.js:188）。
// 面板照样列出来，但标成「暂不生效」，避免用户以为关了就有用。
const TOOLS_GATE_INEFFECTIVE = Object.freeze(['searchHistory', 'memoryEvent']);
const TOOLS_GATE_GET_NOTE = '关闭后桥接立刻拒绝调用；模型侧要重启 DSH 才会不再看到该工具。';

function toolsGateIsObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function toolsGateCatalogMeta() {
  const map = new Map();
  for (const meta of TOOLS_GATE_CATALOG) map.set(meta.flag, meta);
  return map;
}
function toolsGateKnownFlags() {
  return new Set([...TOOLS_GATE_CATALOG.map((meta) => meta.flag), ...TOOLS_GATE_MCP_FLAGS, ...TOOLS_GATE_LEGACY_FLAGS]);
}
function toolsGateEntry(meta, tools) {
  const enabled = tools[meta.flag] !== false;
  return {
    flag: meta.flag,
    tool: meta.tool,
    title: meta.title,
    desc: meta.desc,
    group: meta.group,
    enabled,
    guard: !TOOLS_GATE_GUARD_OFF.includes(meta.flag),
    effective: !TOOLS_GATE_INEFFECTIVE.includes(meta.flag),
    mcpRegistered: enabled && TOOLS_GATE_MCP_FLAGS.includes(meta.flag)
  };
}
// 当前视图：以目录顺序为主，cfg 里多出来的 flag 挂在「其它」组尾（升级后新增开关不会在页面上消失）。
function toolsGateView(deps) {
  const tools = toolsGateIsObject(deps.cfg?.socialV2?.tools) ? deps.cfg.socialV2.tools : {};
  const catalog = toolsGateCatalogMeta();
  const seen = new Set();
  const entries = [];
  for (const meta of TOOLS_GATE_CATALOG) {
    seen.add(meta.flag);
    entries.push(toolsGateEntry(meta, tools));
  }
  for (const flag of Object.keys(tools)) {
    if (seen.has(flag)) continue;
    if (TOOLS_GATE_LEGACY_FLAGS.includes(flag)) continue;
    entries.push(toolsGateEntry({ flag, tool: '', title: flag, desc: '配置里额外出现的开关', group: 'other' }, tools));
  }
  const order = (group) => {
    const index = TOOLS_GATE_GROUP_ORDER.indexOf(group);
    return index < 0 ? TOOLS_GATE_GROUP_ORDER.length : index;
  };
  entries.sort((a, b) => order(a.group) - order(b.group));
  const used = new Set(entries.map((entry) => entry.group));
  const groups = TOOLS_GATE_GROUPS.filter((group) => used.has(group.id));
  if (used.has('other')) groups.push({ id: 'other', title: '其它' });
  return { ok: true, changed: [], reloadRequired: false, note: TOOLS_GATE_GET_NOTE, groups, tools: entries };
}
function toolsGateTitles(changed, catalog) {
  return changed.map((flag) => `「${catalog.get(flag)?.title ?? flag}」`).join('、');
}
function toolsGateReject(request, unknown, bad) {
  if (unknown.length) {
    const shown = unknown.slice(0, 5).join('、');
    request.sendJson({ ok: false, error: `未知开关：${shown}${unknown.length > 5 ? ` 等 ${unknown.length} 个` : ''}` }, 400);
    return true;
  }
  if (bad.length) {
    const shown = bad.slice(0, 5).join('、');
    request.sendJson({ ok: false, error: `开关值必须是 true/false：${shown}` }, 400);
    return true;
  }
  return false;
}
export function createConsoleToolsGate(deps) {
// @bridge-function handleConsoleToolsGate:start
async function handleConsoleToolsGate(request) {
        if (request.url.pathname !== '/api/tools/gate') return false;
        // 与 /api/config 同口径：MCP 工具进程也持有控制台令牌，放开闸门属于管理端全权。
        if (request.req.headers['x-agent-call'] !== undefined || request.req.headers['x-agent-token']) {
          request.sendJson({ ok: false, code: 'admin_only', error: '工具开关只允许管理端读写（智能体不得自己放开闸门）' }, 403);
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'GET') {
          request.sendJson(toolsGateView(deps));
          return true; /* @bridge-handled */
        }
        if (request.req.method !== 'POST') {
          request.sendJson({ ok: false, error: '只支持 GET/POST' }, 405);
          return true; /* @bridge-handled */
        }
        const body = await request.readBody().catch(() => ({}));
        const patch = toolsGateIsObject(body) ? body.patch : undefined;
        if (!toolsGateIsObject(patch)) {
          request.sendJson({ ok: false, error: '请求体必须是 { patch: { "开关名": true|false } }' }, 400);
          return true; /* @bridge-handled */
        }
        // 先整体校验再落盘：任何一个 key/值不合格就整单拒绝，避免「一半生效一半 400」。
        const known = toolsGateKnownFlags();
        const unknown = [];
        const bad = [];
        const entries = [];
        for (const [flag, value] of Object.entries(patch)) {
          if (!known.has(flag)) { unknown.push(flag); continue; }
          if (typeof value !== 'boolean') { bad.push(flag); continue; }
          entries.push([flag, value]);
        }
        if (toolsGateReject(request, unknown, bad)) return true; /* @bridge-handled */
        if (!entries.length) {
          request.sendJson({ ok: false, error: '没有可写入的开关' }, 400);
          return true; /* @bridge-handled */
        }
        const configFile = deps.path.join(deps.ROOT, 'config.json');
        const changed = [];
        try {
          (0, deps.updateConfigFile)(configFile, (disk) => {
            disk.socialV2 = toolsGateIsObject(disk.socialV2) ? disk.socialV2 : {};
            disk.socialV2.tools = toolsGateIsObject(disk.socialV2.tools) ? disk.socialV2.tools : {};
            for (const [flag, value] of entries) {
              // changed 以「磁盘最新值」为准：磁盘没写过时退回运行期生效值（默认表）再比。
              const before = Object.prototype.hasOwnProperty.call(disk.socialV2.tools, flag)
                ? disk.socialV2.tools[flag] !== false
                : deps.cfg?.socialV2?.tools?.[flag] !== false;
              if (before !== value) changed.push(flag);
              disk.socialV2.tools[flag] = value;
            }
          }, { atomicWrite: deps.atomicWriteJson });
        } catch (error) {
          (0, deps.log)(`[工具开关] 写入 config.json 失败：${error?.message ?? error}`);
          request.sendJson({ ok: false, error: `写入 config.json 失败：${error?.message ?? error}` }, 500);
          return true; /* @bridge-handled */
        }
        // tools 不在 RESTART_REQUIRED_PATHS 里，这里就是热加载（cfg 原地替换成磁盘新值）。
        try { (0, deps.reloadConfigFromDisk)('tools'); } catch {}
        const view = toolsGateView(deps);
        const catalog = toolsGateCatalogMeta();
        const off = changed.filter((flag) => deps.cfg?.socialV2?.tools?.[flag] === false);
        const on = changed.filter((flag) => !off.includes(flag));
        let note = '没有变化：这些开关本来就是这些值。';
        if (off.length) note = `已保存。桥接立即生效；模型侧要重启 DSH 才会不再看到${toolsGateTitles(off, catalog)}。`;
        else if (on.length) note = `已保存。桥接立即生效；模型侧要重启 DSH 才会看到${toolsGateTitles(on, catalog)}。`;
        const enabled = view.tools.filter((tool) => tool.enabled).length;
        (0, deps.log)(`[工具开关] 已更新：${changed.length ? changed.join('、') : '无变化'}（${enabled}/${view.tools.length} 开启）`);
        request.sendJson({ ok: true, changed, enabled, total: view.tools.length, reloadRequired: changed.length > 0, note });
        return true; /* @bridge-handled */
        // 路径没匹配上时返回 false，交给后面的路由（readBridgeSource 的路由展开按最后这个 return false; 切片）。
        return false;
      }
// @bridge-function handleConsoleToolsGate:end
  return { handleConsoleToolsGate };
}
