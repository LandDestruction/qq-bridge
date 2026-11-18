// 运维页「工具组」：跑的是同一个 toolsGateView（/api/tools/gate 的视图函数），
// 断言的是「面板拿到的数据里，每个工具都有人看的懂的中文名 + 一句用途」。
// 不碰网络、不写盘：只构造 deps 直接调 handleConsoleToolsGate。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConsoleToolsGate } from '../src/bridge/console/tools-gate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientSrc = fs.readFileSync(path.join(ROOT, 'client/05-settings.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'public/client.css'), 'utf8');
let passed = 0;
const failures = [];
function check(ok, name, detail) {
  if (ok) { passed += 1; return; }
  failures.push(name + (detail ? `（${detail}）` : ''));
}

const deps = {
  cfg: { socialV2: { tools: {} } },
  ROOT,
  path,
  log: () => {},
  updateConfigFile: () => {},
  atomicWriteJson: () => {},
  reloadConfigFromDisk: () => {}
};
const gate = createConsoleToolsGate(deps);
async function call(method, { body, headers = {} } = {}) {
  let payload = null;
  const request = {
    url: new URL('http://127.0.0.1:3100/api/tools/gate'),
    req: { method, headers },
    sendJson: (data, status) => { payload = { data, status: status || 200 }; },
    readBody: async () => body || {}
  };
  const handled = await gate.handleConsoleToolsGate(request);
  return { handled, payload };
}

const got = await call('GET');
check(got.handled === true, 'GET /api/tools/gate 由工具开关模块处理', String(got.handled));
check(got.payload.status === 200 && got.payload.data.ok === true, 'GET 回 {ok:true}', JSON.stringify(got.payload.status));
const view = got.payload.data;
const tools = Array.isArray(view.tools) ? view.tools : [];
// 2026-10-29 工具面收敛（D 方案）：41 → 37 条。发送 5 个入口并成 qq_send_message 一个、
// 记忆 4 个并成 qq_memory 一个；这里下限跟着放宽，另外单独盯「旧的分散入口不许再出现」。
check(tools.length >= 30, '工具清单至少 30 条（合并后仍有这么多能力）', `${tools.length} 条`);
const toolNames = tools.map((t) => String(t.tool || '')).join(' ');
for (const gone of ['qq_send_burst', 'qq_reply', 'qq_send_group_message', 'qq_send_private_message', 'qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear']) {
  check(!toolNames.includes(gone), `旧的分散入口 ${gone} 已并入新工具（目录里不再单列）`);
}
const sendEntry = tools.find((t) => t.flag === 'sendMessage') || {};
check(String(sendEntry.tool || '').includes('qq_send_message') && /唯一入口/.test(String(sendEntry.title || '')),
  '发送入口只剩 qq_send_message，标题写明「唯一入口」', JSON.stringify(sendEntry));
check(toolNames.includes('qq_memory') && !/qq_memory_append/.test(toolNames), '记忆入口合成 qq_memory 一条');

check(Array.isArray(view.groups) && view.groups.length >= 5, '按组返回（组名给面板做小标题）', `${(view.groups || []).length} 组`);

const han = /[\u4e00-\u9fa5]/;
const noTitle = tools.filter((t) => !han.test(String(t.title || '')));
const noDesc = tools.filter((t) => String(t.desc || '').length < 4 || !han.test(String(t.desc || '')));
const noSkip = tools.filter((t) => !t.title || !t.desc);
check(noTitle.length === 0, '每个工具都有中文名', noTitle.map((t) => t.flag).join('、'));
check(noDesc.length === 0, '每个工具都有一句中文用途', noDesc.map((t) => t.flag).join('、'));
check(noSkip.length === 0, '没有只有英文名的空壳条目', noSkip.map((t) => t.flag).join('、'));
check(tools.every((t) => typeof t.enabled === 'boolean'), '每条都带 enabled（面板据此点绿点/灰点）');
check(tools.every((t) => typeof t.mcpRegistered === 'boolean' && typeof t.guard === 'boolean' && typeof t.effective === 'boolean'),
  '每条都带 mcpRegistered / guard / effective 三个标记（面板据此标「已停用、暂不生效、无调用拦截」）');
const grouped = tools.filter((t) => (view.groups || []).some((g) => g.id === t.group));
check(grouped.length === tools.length, '每个工具都落在已声明的分组里', `${tools.length - grouped.length} 条落到未知组`);
const groupIds = (view.groups || []).map((g) => g.id);
const order = groupIds.map((id, index) => ({ id, index }));
let sorted = true;
let last = -1;
for (const t of tools) {
  const index = order.find((o) => o.id === t.group)?.index ?? 99;
  if (index < last) sorted = false;
  last = index;
}
check(sorted, '工具按分组顺序排列（面板不用再排一遍）');

// 面板侧：只读、可筛选、可搜索，且不逐行刷「注册给模型」
check(/var opsCache = \{ services: \[\], bridge: null, log: \[\], report: null, running: false, power: \{ paused: false, since: 0 \},/.test(clientSrc)
  && /tools: null, toolsFilter: 'all', toolsQuery: ''/.test(clientSrc), '运维页缓存里放了工具清单与筛选/搜索状态');
check(/api\('\/api\/tools\/gate'\)\.catch/.test(clientSrc), '运维页确实去拉 /api/tools/gate');
check(/function opsToolsCard\(\)/.test(clientSrc) && /function opsToolRows\(\)/.test(clientSrc) && /function opsToolsListHtml\(rows\)/.test(clientSrc),
  '工具组卡片、行过滤、分组渲染三个函数都在');
check(/data-tools-group="all"/.test(clientSrc) && /aria-pressed/.test(clientSrc), '分组 chip 带选中态');
check(/id="opsToolsSearch"/.test(clientSrc) && /搜工具名 \/ 中文名 \/ 用途/.test(clientSrc), '有搜索框（按工具名/中文名/用途过滤）');
check(!/if \(t\.mcpRegistered\) tags \+= opsToolTag\('注册给模型'/.test(clientSrc)
  && /注册给模型 ' \+ numText\(mcpN\)/.test(clientSrc), '「注册给模型」在分组标题里报个数，不逐行挂标签（41 行都挂就是噪音）');
check(/这里只读/.test(clientSrc) && /\?dev=1/.test(clientSrc) && /3 秒内连点右上角版本号 5 次/.test(clientSrc),
  '卡片上写明这里只读、开关在隐藏页怎么进');
check(/card\.innerHTML = opsToolsCard\(\);/.test(clientSrc) && /host\.querySelector\('\[data-ops-tools\]'\)/.test(clientSrc),
  '刷新只重画这一张卡，不整页重拉');
check(/#opsToolsList/.test(clientSrc), '搜索只换列表容器（换整卡会丢输入焦点，换单个 ul 只覆盖第一组）');
check(/act === 'tools-refresh'/.test(clientSrc), '卡片右上「刷新」有对应分支');
check(/\.qdb-tool-row \{[^}]*grid-template-columns: 8px minmax\(0, 232px\) minmax\(0, 1fr\) auto/.test(cssSrc.replace(/\n\s*/g, ' ')),
  '行是四列网格：状态点 / 工具名 / 中文名+用途 / 例外标签');
check(/\.qdb-tool-group-head \{/.test(cssSrc) && /@media \(max-width: 820px\) \{\s*\.qdb-tool-row/.test(cssSrc),
  '分组小标题有样式，窄屏折成两列');

// ── 折叠：41 个工具摊开有四五屏，得能按组收、也能整块收 ─────────────────
check(/OPS_TOOLS_FOLD_KEY = 'qdb-ops-tools-fold'/.test(clientSrc)
  && /OPS_TOOLS_CLOSED_KEY = 'qdb-ops-tools-closed'/.test(clientSrc),
  '折叠状态落在本地（整卡一个键、分组一个键）');
check(/data-tools-toggle=/.test(clientSrc) && /aria-expanded="/.test(clientSrc)
  && /class="qdb-tool-group-head"/.test(clientSrc), '每个分组标题都是折叠开关，带 aria-expanded');
check(/data-tools-all="1"/.test(clientSrc) && clientSrc.includes("'全部展开' : '全部收起'"),
  '工具栏有「全部收起 / 全部展开」');
check(/data-tools-fold="1"/.test(clientSrc) && /id="opsToolsBody"/.test(clientSrc) && /data-folded="1"/.test(clientSrc),
  '整张卡也能收起（折叠状态写在 #opsToolsBody 上）');
check(/opsToolsSaveClosed\(closed\)/.test(clientSrc) && /opsStoreSet\(OPS_TOOLS_FOLD_KEY, next\)/.test(clientSrc),
  '点折叠会把状态写回本地，下次打开还记得');
check(/function opsToolsAllClosed\(\)/.test(clientSrc), '有「是不是全收起了」的判断，按钮文案才对得上');
check(/\.qdb-tools-wrap\[data-folded="1"\] \{ display: none; \}/.test(cssSrc), '整卡收起时把内容块 display:none');
check(/\.qdb-tool-group-head\[aria-expanded="false"\]::before \{ transform: rotate\(0deg\); \}/.test(cssSrc),
  '组标题左侧三角跟着折叠状态转');
check(/\.qdb-tool-group-head \{[^}]*cursor: pointer/.test(cssSrc.replace(/\s+/g, ' ')),
  '组标题看起来可点（cursor: pointer）');

console.log(`\n运维工具组：通过 ${passed} / 失败 ${failures.length}`);
if (failures.length) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
