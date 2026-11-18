// 工程使用统计（GET /api/library/usage、POST scan/stop、POST 保存根）。
//
// 为什么单独一套：这条路径会扫用户整块磁盘（真库 24 件 2.5GB、工程几万个文本资产），
// 一旦写成「顺手改工程」或「把大文件也读进内存」，代价是用户工程被弄脏 / 进程被打爆。
// 所以断言重点是：只读、GUID 精确匹配（拿不到 GUID 就算 unknown，不许谎报 unused）、
// 名字匹配兜底、大文件跳过、超时兜底、stop 生效、重启 interrupted、根目录规整与保存。
// 全部用假 deps + 临时目录造工程，不碰真库、不联网。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createLibraryUsage } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-usage.js')).href);
// 纯函数层与素材侧 GUID 抽取都直接 import 真实模块：注入的 deps 与真机一致。
const usagePure = await import(pathToFileURL(path.join(ROOT, 'src/library-usage.js')).href);
const guidsPure = await import(pathToFileURL(path.join(ROOT, 'src/library-usage-guids.js')).href);

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-usage-'));
const projectsRoot = path.join(tmp, 'Projects');
const stateDir = path.join(tmp, 'state');
const libDir = path.join(tmp, 'library');
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(libDir, { recursive: true });
function writeProject(name, unityVersion, files) {
  const dir = path.join(projectsRoot, name);
  fs.mkdirSync(path.join(dir, 'ProjectSettings'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'), `m_EditorVersion: ${unityVersion}\nm_EditorVersionWithRevision: abc\n`);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}
// 工程 A：真的引用了 Mew_Pose（注意大小写故意写成大写，验证不区分大小写）。
const projA = writeProject('ProjA', '2022.3.12f1', {
  'Assets/Prefabs/pose.prefab': 'm_Name: pose\n  m_Text: "8844481 MEW_POSE costume prefab"\n',
  // Library 是 Unity 缓存目录，必须跳过（里面也有同名文本，扫了只会白白变慢）
  'Library/cache.txt': 'MEW_POSE'
});
// 工程 B：一个字都没提 Mew_Pose；另放一个 >2MB 的大文件提 Other（验证大文件跳过）。
const projB = writeProject('ProjB', '2021.3.45f1', {
  'Assets/Prefabs/empty.prefab': 'm_Name: empty\n'
});
fs.writeFileSync(path.join(projB, 'Assets', 'big.asset'), `Other ${'x'.repeat(2.5 * 1024 * 1024)}`);

const cards = [
  { key: 'g/costumes/mew', title: 'Mew Pose', dir: 'g/costumes', mainName: '8844481 Mew_Pose.zip', thumbRel: '' },
  { key: 'g/costumes/other', title: 'Other Pack', dir: 'g/costumes', mainName: '7777777 Other.zip', thumbRel: '' },
  { key: 'g/costumes/nomatch', title: 'Nothing', dir: 'g/costumes', mainName: '8888888 Nothing.zip', thumbRel: '' }
];

const logs = [];
function makeDeps(overrides = {}) {
  return {
    fs,
    path,
    ROOT: tmp,
    STATE_DIR: stateDir,
    cfg: { fileArchive: { usageRoots: [projectsRoot] } },
    log: (m) => logs.push(String(m)),
    buildLibrarySnapshot: () => ({ ok: true, root: libDir, assets: cards.map((card) => ({ ...card })) }),
    fileArchiveRootDir: () => libDir,
    atomicWriteJson: (file, obj) => fs.writeFileSync(file, JSON.stringify(obj)),
    // 真机上这两个是 bridge.js 注入的纯函数层；这里直接给真实模块，测的就是会上线的代码。
    libraryUsagePure: usagePure,
    libraryUsageGuidsPure: guidsPure,
    ...overrides
  };
}

function makeReq(method, pathname, { body = null, headers = {}, consoleRole = '' } = {}) {
  let sent = null;
  return {
    consoleRole,
    req: { method, headers },
    url: { pathname, searchParams: new URLSearchParams() },
    readBody: async () => body,
    sendJson: (payload, code) => { sent = { payload, code: code || 200 }; },
    getSent: () => sent
  };
}
async function call(instance, method, pathname, opts) {
  const req = makeReq(method, pathname, opts);
  const handled = await instance.handleConsoleLibraryUsage(req);
  const sent = req.getSent() || { payload: null, code: 0 };
  return { handled, code: sent.code, payload: sent.payload };
}

const statePath = path.join(stateDir, 'library-usage.json');
const legacyStatePath = path.join(stateDir, 'booth-usage.json');
// usage 里现在每件素材都有一条结论（used/unused/unknown），断言「谁命中了」要按 projects 过滤。
function usedKeys(payload) {
  const usage = payload?.usage && typeof payload.usage === 'object' ? payload.usage : {};
  return Object.keys(usage).filter((key) => (usage[key]?.projects || []).length > 0);
}
function treeOf(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { out.push(`${full}/`); walk(full); }
      else out.push(`${full}:${fs.statSync(full).size}`);
    }
  };
  walk(dir);
  return out.sort();
}

const usage = createLibraryUsage(makeDeps());

console.log('## GET 初始：没扫过时也要有完整形状');
{
  const { handled, code, payload } = await call(usage, 'GET', '/api/library/usage');
  check('路由被本模块处理', handled === true && code === 200);
  eq('rootsConfigured: true（配置里有根）', payload.rootsConfigured, true);
  eq('usage 初始为空对象', payload.usage, {});
  eq('roots 初始为空数组', payload.roots, []);
  eq('running 初始 false', payload.running, false);
  eq('scannedAt 初始 0', payload.scannedAt, 0);
}

console.log('## 智能体一律 403（会读用户整块目录）');
{
  for (const [name, headers] of [['x-agent-token', { 'x-agent-token': 'abc123' }], ['x-agent-call', { 'x-agent-call': '1' }]]) {
    const get = await call(usage, 'GET', '/api/library/usage', { headers });
    check(`${name} 的 GET 被 403`, get.code === 403 && get.payload.ok === false, String(get.code));
    const scan = await call(usage, 'POST', '/api/library/usage/scan', { headers, body: {} });
    check(`${name} 的 scan 被 403`, scan.code === 403 && scan.payload.ok === false, String(scan.code));
  }
}

console.log('## scan：找工程、命中口径、大文件与缓存目录跳过、只读');
{
  const before = { projects: treeOf(projectsRoot), lib: treeOf(libDir) };
  const scan = await call(usage, 'POST', '/api/library/usage/scan', { body: {} });
  eq('scan 返回 ok 且 running=false', [scan.code, scan.payload.ok, scan.payload.running], [200, true, false]);
  eq('没配根时不会出现的 rootsConfigured 仍是 true', scan.payload.rootsConfigured, true);
  eq('发现两个工程', scan.payload.roots[0].projects.length, 2);
  const versions = scan.payload.roots[0].projects.map((p) => p.unityVersion).sort();
  eq('ProjectVersion.txt 里的 Unity 版本读对了', versions, ['2021.3.45f1', '2022.3.12f1']);
  check('工程 path 是绝对路径且指向工程目录', scan.payload.roots[0].projects.every((p) => path.isAbsolute(p.path) && fs.existsSync(path.join(p.path, 'ProjectSettings'))));
  check('scannedAt 有值', scan.payload.scannedAt > 0, String(scan.payload.scannedAt));
  eq('只有 Mew Pose 命中（Other 只出现在 >2MB 大文件里、Nothing 没出现）', usedKeys(scan.payload), ['g/costumes/mew']);
  eq('没 GUID 时退回名字匹配（usageMode=name）', scan.payload.usageMode, 'name');
  eq('拿不到 GUID 的素材算 unknown，不谎报 unused', [scan.payload.usage['g/costumes/other'].usage, scan.payload.usage['g/costumes/nomatch'].usage], ['unknown', 'unknown']);
  eq('summary 汇总行（1 件在用、2 件判不了）', scan.payload.summary, { withUsage: 1, unused: 0, unknown: 2 });
  const entry = scan.payload.usage['g/costumes/mew'];
  eq('命中工程是 ProjA', entry.projects.map((p) => p.name), ['ProjA']);
  check('证据片段是 40 字以内的可读文本且含素材名', entry.projects[0].evidence.length <= 40 && /mew_pose/i.test(entry.projects[0].evidence), entry.projects[0].evidence);
  check('每条命中带时间戳', entry.lastScanAt > 0 && entry.projects[0].at > 0);
  check('证据片段贴着命中处截取（含素材名）', /MEW_POSE/i.test(entry.projects[0].evidence), entry.projects[0].evidence);
  const after = { projects: treeOf(projectsRoot), lib: treeOf(libDir) };
  eq('工程目录只读：扫描前后文件树完全一致', after.projects, before.projects);
  eq('素材库没被写', after.lib, before.lib);
  check('状态只落在 STATE_DIR', fs.existsSync(statePath));
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  check('状态文件不含扫描到的文件清单（只存结论）', JSON.stringify(saved).length < 20000, String(JSON.stringify(saved).length));
  eq('状态文件记录 roots 工程清单', saved.roots[0].projects.length, 2);
}

console.log('## Library 缓存目录跳过（只在缓存里出现的引用不算被用过）');
{
  const projC = writeProject('ProjC', '2022.1.1f1', {
    'Library/cache.txt': 'MEW_POSE',
    'Assets/empty.prefab': 'm_Name: empty\\n'
  });
  const instance = createLibraryUsage(makeDeps({ cfg: { fileArchive: { usageRoots: [projC] } } }));
  const scan = await call(instance, 'POST', '/api/library/usage/scan', { body: {} });
  eq('只在 Library 里出现 → 不命中', usedKeys(scan.payload), []);
  eq('工程本身仍被识别', scan.payload.roots[0].projects.map((p) => p.name), ['ProjC']);
}

console.log('## GET 复用扫描结果（持久化，不重扫）');
{
  const { payload } = await call(usage, 'GET', '/api/library/usage');
  eq('GET 的 usage 与 scan 一致', usedKeys(payload), ['g/costumes/mew']);
  eq('GET 也带 summary', payload.summary, { withUsage: 1, unused: 0, unknown: 2 });
  eq('GET 的 roots 工程数不变', payload.roots[0].projects.length, 2);
  eq('GET 的 scannedAt 与 scan 一致', payload.scannedAt > 0, true);
}

console.log('## 只读访客：只给工程名，绝对路径一律剥离');
{
  const admin = await call(usage, 'GET', '/api/library/usage');
  const guestGet = await call(usage, 'GET', '/api/library/usage', { consoleRole: 'guest' });
  check('访客也能读统计（200）', guestGet.handled === true && guestGet.code === 200, String(guestGet.code));
  eq('访客的 roots 只剩 exists + projects[].name', guestGet.payload.roots.map((root) => ({
    keys: Object.keys(root).sort(),
    projects: root.projects.map((project) => Object.keys(project))
  })), [{ keys: ['exists', 'projects'], projects: [['name'], ['name']] }]);
  eq('访客的工程名照旧', guestGet.payload.roots[0].projects.map((project) => project.name), ['ProjA', 'ProjB']);
  eq('访客的 usage 只剩工程名', Object.entries(guestGet.payload.usage)
    .filter(([, entry]) => (entry.projects || []).length > 0)
    .map(([key, entry]) => [key, entry.projects.map((project) => project.name)]),
    [['g/costumes/mew', ['ProjA']]]);
  check('访客响应整段 JSON 不含本机绝对路径', () => {
    const raw = JSON.stringify(guestGet.payload);
    const driveAbs = new RegExp('[A-Za-z]:' + String.fromCharCode(92, 92));
    if (driveAbs.test(raw) || raw.indexOf('/home/') !== -1 || raw.indexOf('AppData') !== -1) {
      throw new Error(raw.slice(0, 300));
    }
  });
  check('管理员视图仍带 roots[].dir 与 projects[].path（没把功能删坏）', () => {
    if (!path.isAbsolute(admin.payload.roots[0].dir)) throw new Error(String(admin.payload.roots[0].dir));
    if (!path.isAbsolute(admin.payload.roots[0].projects[0].path)) throw new Error('projects path missing');
  });
}

console.log('## stop：扫完第一个工程就停');
{
  const stopLogs = [];
  let stopped = false;
  const instance = createLibraryUsage(makeDeps({
    cfg: { fileArchive: { usageRoots: [projectsRoot] } },
    log: (m) => stopLogs.push(String(m)),
    usageScanHooks: {
      onProject: () => {
        if (stopped) return;
        stopped = true;
        void call(instance, 'POST', '/api/library/usage/stop', { body: {} });
      }
    }
  }));
  const scan = await call(instance, 'POST', '/api/library/usage/scan', { body: {} });
  eq('stop 后 scan 仍 200 且标记 stopped', [scan.payload.ok, scan.payload.stopped], [true, true]);
  check('日志说明扫描已停止', stopLogs.some((line) => /扫描已停止/.test(line)), stopLogs.join(' | '));
  const again = await call(instance, 'POST', '/api/library/usage/stop', { body: {} });
  eq('没在跑时 stop 回 409', again.code, 409);
}

console.log('## 超时兜底：超过上限记 timeout 而不是挂住');
{
  const timeoutProject = writeProject('ProjSlow', '2020.3.1f1', Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [`Assets/many/file-${i}.prefab`, `m_Name: file-${i}\nMEW_POSE\n`])
  ));
  const instance = createLibraryUsage(makeDeps({
    cfg: { fileArchive: { usageRoots: [timeoutProject] } },
    usageScanTimeoutMs: 1
  }));
  const scan = await call(instance, 'POST', '/api/library/usage/scan', { body: {} });
  eq('超时后仍返回 200（前端能读到 error）', [scan.code, scan.payload.ok], [200, true]);
  eq('error=timeout', scan.payload.error, 'timeout');
  eq('running 复位', scan.payload.running, false);
}

console.log('## 重启：running 状态读回 interrupted');
{
  fs.writeFileSync(statePath, JSON.stringify({ v: 1, at: 1, running: true, startedAt: 2, scannedAt: 3, roots: [], usage: {}, lastError: '' }));
  const instance = createLibraryUsage(makeDeps());
  const { payload } = await call(instance, 'GET', '/api/library/usage');
  eq('running 读回 false', payload.running, false);
  check('提示被重启打断、可以重跑', /重启|打断/.test(payload.error), payload.error);
}

console.log('## 没配扫描根：rootsConfigured:false + 明确提示');
{
  const instance = createLibraryUsage(makeDeps({ cfg: { fileArchive: {} } }));
  const get = await call(instance, 'GET', '/api/library/usage');
  eq('GET rootsConfigured:false', get.payload.rootsConfigured, false);
  eq('GET roots 为空', get.payload.roots, []);
  const scan = await call(instance, 'POST', '/api/library/usage/scan', { body: {} });
  eq('scan 不报 500，回 ok:true 让人看提示', [scan.code, scan.payload.ok], [200, true]);
  check('提示去设置里配 fileArchive.usageRoots', /扫描根/.test(scan.payload.error), scan.payload.error);
}

console.log('## 扫描根不存在：只标 exists:false，不崩');
{
  const instance = createLibraryUsage(makeDeps({ cfg: { fileArchive: { usageRoots: [path.join(tmp, 'nope')] } } }));
  const scan = await call(instance, 'POST', '/api/library/usage/scan', { body: {} });
  eq('根 exists:false', scan.payload.roots[0].exists, false);
  eq('工程列表为空', scan.payload.roots[0].projects, []);
}

console.log('## 相对路径按 ROOT 解释（不硬编码盘符）');
{
  const instance = createLibraryUsage(makeDeps({ cfg: { fileArchive: {} } }));
  const scan = await call(instance, 'POST', '/api/library/usage/scan', { body: { roots: ['Projects'] } });
  eq('相对根被解析成 ROOT/Projects', path.resolve(scan.payload.roots[0].dir), path.resolve(projectsRoot));
  eq('并且真的扫到了工程', scan.payload.roots[0].projects.length >= 2, true);
}

console.log('## GUID 精确匹配：素材 GUID ∩ 工程 GUID');
{
  const guidA = '1234567890abcdef1234567890abcdef';
  const guidB = 'fedcba0987654321fedcba0987654321';
  const projG = writeProject('ProjG', '2022.3.12f1', {
    [`Assets/Test.meta`]: `fileFormatVersion: 2\nguid: ${guidA}\n`,
    'Assets/Test.prefab': 'm_Name: MewPose\n  m_Script: {fileID: 1}\n'
  });
  const guidCards = [
    { key: 'g/g1', title: 'G1', dir: 'g', mainName: 'G1.zip', thumbRel: '' },
    { key: 'g/g2', title: 'G2', dir: 'g', mainName: 'G2.zip', thumbRel: '' },
    { key: 'g/g3', title: 'G3', dir: 'g', mainName: 'G3.zip', thumbRel: '' },
    { key: 'g/g4', title: 'MewPose', dir: 'g', mainName: 'MewPose.zip', thumbRel: '' }
  ];
  const fakeGuids = {
    guidsFromAssetFile: ({ filePath }) => {
      if (/G1\.zip$/.test(filePath)) return { guids: [guidA], reason: '' };
      if (/G3\.zip$/.test(filePath)) return { guids: [guidB], reason: '' };
      return { guids: [], reason: 'no_unitypackage' };
    }
  };
  const instance = createLibraryUsage(makeDeps({
    cfg: { fileArchive: { usageRoots: [projG] } },
    buildLibrarySnapshot: () => ({ ok: true, assets: guidCards }),
    libraryUsageGuidsPure: fakeGuids
  }));
  const scan = await call(instance, 'POST', '/api/library/usage/scan', { body: {} });
  eq('有素材 GUID 时切到 GUID 模式', scan.payload.usageMode, 'guid');
  eq('G1（工程引用了它的 GUID）→ used', scan.payload.usage['g/g1'].usage, 'used');
  eq('G1 命中工程 ProjG', scan.payload.usage['g/g1'].projects.map((project) => project.name), ['ProjG']);
  check('G1 记录引用次数', scan.payload.usage['g/g1'].projects[0].refs >= 1, String(scan.payload.usage['g/g1'].projects[0].refs));
  eq('G2 拿不到 GUID → unknown（不能谎报 unused）', scan.payload.usage['g/g2'].usage, 'unknown');
  eq('G3 有 GUID 但工程没用 → unused', scan.payload.usage['g/g3'].usage, 'unused');
  eq('同一轮里没 GUID 的素材靠名字兜底命中（工程文本里有 MewPose）', scan.payload.usage['g/g4'].usage, 'used');
  eq('GUID 模式的 summary', scan.payload.summary, { withUsage: 2, unused: 1, unknown: 1 });
}

console.log('## POST /api/library/usage：规整并保存扫描根');
{
  const configFile = path.join(tmp, 'config.json');
  const writes = [];
  const instance = createLibraryUsage(makeDeps({
    updateConfigFile: (file, mutate) => {
      writes.push(file);
      const next = mutate({ fileArchive: { enabled: true } });
      fs.writeFileSync(file, JSON.stringify(next));
      return next;
    },
    reloadConfigFromDisk: () => { writes.push('reload'); }
  }));
  const saved = await call(instance, 'POST', '/api/library/usage', { body: { roots: ['E:/projects/a', 'E:/projects/a/', 'E:/projects/b'] } });
  eq('保存成功', [saved.code, saved.payload.ok, saved.payload.saved], [200, true, true]);
  eq('去重后只留两条', saved.payload.requested, 2);
  eq('写的是 config.json', writes[0], configFile);
  check('写盘后触发热加载', writes.includes('reload'));
  const written = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  eq('落盘到 fileArchive.usageRoots', written.fileArchive.usageRoots, ['E:/projects/a', 'E:/projects/b']);
  eq('原有 fileArchive 字段不丢', written.fileArchive.enabled, true);
  const guestPost = await call(instance, 'POST', '/api/library/usage', { body: { roots: [] }, consoleRole: 'guest' });
  eq('访客不能保存（403）', guestPost.code, 403);
  const agentPost = await call(instance, 'POST', '/api/library/usage', { body: { roots: [] }, headers: { 'x-agent-token': 'x' } });
  eq('智能体不能保存（403）', agentPost.code, 403);
}

console.log('## 老的 booth-usage.json 照样读回（升级不丢上次结论）');
{
  fs.rmSync(statePath, { force: true });
  fs.writeFileSync(legacyStatePath, JSON.stringify({ v: 1, at: 1, running: false, startedAt: 2, scannedAt: 42, roots: [], usage: {}, lastError: '' }));
  const instance = createLibraryUsage(makeDeps({ cfg: { fileArchive: {} } }));
  const { payload } = await call(instance, 'GET', '/api/library/usage');
  eq('老状态文件的 scannedAt 读回', payload.scannedAt, 42);
  fs.rmSync(legacyStatePath, { force: true });
}

console.log('## 纯函数层自检（roots 规整 / GUID 抽取 / 求交 / 汇总）');
{
  eq('normalizeUsageRoots：去重复、去尾斜杠、拒绝相对路径',
    usagePure.normalizeUsageRoots(['E:/p/a', 'E:/p/a/', 'rel/path', '  E:/p/b\\  ']), ['E:/p/a', 'E:/p/b']);
  eq('normalizeUsageRoots：字符串按逗号/换行拆',
    usagePure.normalizeUsageRoots('E:/p/a, E:/p/b\nE:/p/c'), ['E:/p/a', 'E:/p/b', 'E:/p/c']);
  eq('normalizeUsageRoots：上限 12 个', usagePure.normalizeUsageRoots(Array.from({ length: 20 }, (_, i) => `E:/p/${i}`)).length, 12);
  const guidA = '1234567890abcdef1234567890abcdef';
  eq('collectGuidRefs：只认 32 位 hex，去重', usagePure.collectGuidRefs(`${guidA} ${guidA.toUpperCase()} 9f8e7d6c5b4a39281706f5e4d3c2b1a0 zz`),
    [guidA, '9f8e7d6c5b4a39281706f5e4d3c2b1a0']);
  eq('hasGuidRef：命中/不命中', [usagePure.hasGuidRef(`guid: ${guidA}`, guidA), usagePure.hasGuidRef('nothing', guidA)], [true, false]);
  const matched = usagePure.matchAssetsToProjects({
    projects: [{ root: 'E:/p', project: 'P1', path: 'E:/p/P1', guids: [guidA] }],
    assets: [{ key: 'a', guids: [guidA] }, { key: 'b', guids: [] }]
  });
  eq('matchAssetsToProjects：used/unknown 与 refs', [matched.usage.a, matched.usage.b, matched.usedIn.a[0].refs], ['used', 'unknown', 1]);
  eq('summarizeUsage', usagePure.summarizeUsage({ a: 'used', b: 'unused', c: 'unknown', d: 'used' }), { withUsage: 2, unused: 1, unknown: 1 });
  check('describeUsageSummary 是人话', /共 4 件素材/.test(usagePure.describeUsageSummary({ withUsage: 2, unused: 1, unknown: 1 }, 4)), usagePure.describeUsageSummary({ withUsage: 2, unused: 1, unknown: 1 }, 4));
  eq('scanProjectUsage：假 io 也能扫出 GUID', usagePure.scanProjectUsage({
    roots: ['E:/p'],
    io: {
      readdir: (dir) => {
        if (dir === 'E:/p') return [{ name: 'P1', isDirectory: true }];
        if (dir === 'E:/p/P1') return [{ name: 'ProjectSettings', isDirectory: true }, { name: 'Assets', isDirectory: true }];
        if (dir === 'E:/p/P1/ProjectSettings') return [{ name: 'ProjectVersion.txt', isDirectory: false }];
        return [{ name: 'A.meta', isDirectory: false }];
      },
      exists: (file) => file === 'E:/p' || file.endsWith('ProjectVersion.txt'),
      readText: (file) => (file.endsWith('ProjectVersion.txt') ? 'm_EditorVersion: 2022.3.12f1' : `guid: ${guidA}`),
      statFile: () => ({ size: 100 }),
      join: (...parts) => parts.join('/'),
      basename: (file) => file.split('/').pop()
    }
  }).projects.map((project) => [project.project, project.guids]), [['P1', [guidA]]]);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
