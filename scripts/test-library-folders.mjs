// 文件库「在电脑上的文件夹」：目录清单 + 点一下用资源管理器打开（管理端专用、只能开转存目录之内）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const backend = read('src/bridge/console/file-library.js');
// 文件夹入口 / 素材卡 / 抓封面 / 写说明这些「看」的路由单拆在 library-view.js（B3a 之后）
const view = read('src/bridge/console/library-view.js');
const server = read('src/bridge/console-server.js');
const shell = read('client/01-shell.js');
const sessions = read('client/03-sessions.js');
const css = read('public/client.css');
const manifest = JSON.parse(read('src/bridge/manifest.json'));
const bridge = read('src/bridge.js');

let ok = 0;
let fail = 0;
function check(cond, name) {
  if (cond) { ok += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name); }
}

check(view.includes("'/api/files/folders'") && view.includes("'/api/files/open-folder'"),
  '后端认 /api/files/folders 与 /api/files/open-folder 两个路由');
check(/if \(await viewOf\(deps\)\.handleLibraryFoldersRoute\(request\)\) return true;/.test(backend),
  'file-library 处理器先走文件夹路由');
check(/if \(request\.req\.headers\['x-agent-token'\] \|\| request\.req\.headers\['x-agent-call'\]\)/.test(view)
  && /打开电脑上的文件夹只允许管理端操作/.test(view),
  'agent token 调用直接 403（只有管理端能开本机文件夹）');
check(/\(0, deps\.safeResolveInside\)\(root, wanted\)/.test(view),
  '非空 rel 一律过 safeResolveInside（拒绝 ..、绝对路径、盘符）');
check(/if \(!st\.isDirectory\(\)\) throw new Error\('这不是文件夹：' \+ target\);/.test(view),
  '只允许打开目录，文件不给开');
check(/deps\.spawn\('explorer\.exe', \[target\]/.test(view) && /detached: true, stdio: 'ignore'/.test(view)
  && /child\.unref\(\)/.test(view),
  'explorer.exe 以 detached 方式拉起并 unref，桥接不跟着退出');
check(/typeof deps\.spawn !== 'function'/.test(view), 'spawn 不可用时有明确报错而不是崩');
check(/typeof deps\.fileArchiveRootDir === 'function' \? deps\.fileArchiveRootDir\(\)/.test(view),
  '转存根目录按注入的函数现算（不是常量字符串）');
check(/function subdirsOf\(deps, abs\)/.test(view) && /kind: 'category', depth: 2/.test(view),
  '列两层：群目录 + 群下的分类/商品目录，并标出层级');
check(/\(url\.pathname === '\/api\/file-library\/archive-rules'\)[\s\S]{0,200}\/api\/files\/folders/.test(server)
  && /\/api\/files\/open-folder/.test(server),
  'console-server 路由表里登记了两个新地址');
check(bridge.includes('get spawn() { return typeof spawn === \'function\' ? spawn : null; }'), 'bridge 注入 spawn（沙箱里缺就为 null）');
const libEntry = manifest.modules.find((m) => m.file === 'src/bridge/console/file-library.js');
check(libEntry && libEntry.dependencies.includes('spawn') && libEntry.dependencies.includes('createLibraryView'),
  'manifest 给 file-library 声明了 spawn 与 createLibraryView 依赖');
check(/\.qdb-folder-grid \{ display: grid/.test(css) && /\.qdb-folder \{/.test(css) && /\.qdb-folder-ico svg/.test(css),
  '文件夹卡片有独立样式（网格 + 图标）');
check(/data-write="open-folder"/.test(sessions) && /data-rel="/.test(sessions),
  '前端文件夹卡片带 data-write/data-rel');
check(/libraryState\.folders = pair\[3\] \|\| null;/.test(sessions) && /api\('\/api\/files\/folders'\)/.test(sessions),
  '文件库页并行拉文件夹清单，失败不拖垮整页');
check(/function groupFolderRel\(groupId\)/.test(sessions), '按群统计把群号映射回真实目录名（群号_群名）');
check(/'open-folder': function \(btn\) \{/.test(shell) && /apiWrite\('\/api\/files\/open-folder', \{ rel: rel \}\)/.test(shell),
  '点卡片走 POST /api/files/open-folder');
check(/已在资源管理器里打开：/.test(shell) && /btn\.disabled = false;/.test(shell), '成功后提示并恢复按钮');

console.log('\n通过 ' + ok + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
