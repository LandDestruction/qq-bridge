// 下载后解压（POST /api/library/extract、GET /api/library/extract/status）。
//
// 这条路径会**真的往用户素材目录里写文件**，所以断言重点不是「接口通了」，而是：
// 只写 zip 同级的 `<stem>/`、**绝不删原 zip**、重名目录加 `.1` 不覆盖、
// `../` 穿越条目一律跳过且不写到档案根外、加密包拒绝（下载本身仍算 done）、
// 历史日志落盘且只留最近 20 条、智能体令牌 403、走下载台账时状态不对要给出人话。
// 全部用真 fs 临时档案根 + 假 deps + 真 zip 字节（scripts/fixtures/zip-build.mjs），不碰真库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createLibraryExtract } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-extract.js')).href);
const zipPure = await import(pathToFileURL(path.join(ROOT, 'src/zip-extract.js')).href);
const { buildZip, buildEncryptedZip, buildAesZip } = await import(pathToFileURL(path.join(ROOT, 'scripts/fixtures/zip-build.mjs')).href);
// 解压密码本：真实实例（同一份 state/booth-passwords.json），验证「本机记住了就自动带」。
const { createLibraryPasswords } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-passwords.js')).href);
const { safeResolveInside } = await import(pathToFileURL(path.join(ROOT, 'src/file-archive/paths.js')).href);
const { createLibraryDownload } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-download.js')).href);
const boothDownloadPure = await import(pathToFileURL(path.join(ROOT, 'src/booth-download.js')).href);
const boothPausePure = await import(pathToFileURL(path.join(ROOT, 'src/booth-pause.js')).href);

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-extract-'));
const libDir = path.join(tmp, 'inbox');
const stateDir = path.join(tmp, 'state');
fs.mkdirSync(stateDir, { recursive: true });

// 下载台账里的 zip：<root>/<boothId>/<fileName>（与 library-download.js 的落盘规则一致）。
const dlDir = path.join(libDir, '5197537');
fs.mkdirSync(dlDir, { recursive: true });
const dlZip = path.join(dlDir, '5197537.zip');
fs.writeFileSync(dlZip, buildZip([
  { name: 'Mew_Pose/model.fbx', data: 'model-bytes' },
  { name: 'Mew_Pose/tex/albedo.png', data: 'png-bytes' },
  { name: '../evil.txt', data: 'should-not-escape' }
]));

// 加密包：解压必须拒绝，但下载台账里它仍是 done。
const encDir = path.join(libDir, '8888888');
fs.mkdirSync(encDir, { recursive: true });
const encZip = path.join(encDir, 'secret.zip');
fs.writeFileSync(encZip, buildZip([{ name: 'secret/model.fbx', data: 'locked', encrypted: true }]));

// 素材库主件（走 key 路径）。
const assetDir = path.join(libDir, 'g', 'a');
fs.mkdirSync(assetDir, { recursive: true });
const assetZip = path.join(assetDir, 'Astraea.zip');
fs.writeFileSync(assetZip, buildZip([{ name: 'Astraea/readme.txt', data: 'hi' }]));

const jobs = [
  { boothId: '5197537', fileName: '5197537.zip', state: 'done' },
  { boothId: '8888888', fileName: 'secret.zip', state: 'done' },
  { boothId: '7777777', fileName: '7777777.zip', state: 'queued' },
  { boothId: '6666666', fileName: 'cover.png', state: 'done' },
  { boothId: '5555555', fileName: 'gone.zip', state: 'done' },
  // 台账被改坏/被注入：fileName 带 ../ 想解到档案根外。
  { boothId: '4444444', fileName: '../../escape.zip', state: 'done' }
];
fs.writeFileSync(path.join(stateDir, 'booth-downloads.json'), JSON.stringify({ v: 1, at: Date.now(), jobs }));

const logs = [];
const deps = {
  fs,
  path,
  STATE_DIR: stateDir,
  log: (message) => logs.push(String(message)),
  now: () => 1700000000000,
  fileArchiveRootDir: () => libDir,
  safeResolveInside,
  atomicWriteJson: (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2)),
  zipExtractPure: {
    listZipPreview: zipPure.listZipPreview,
    extractZipToDir: zipPure.extractZipToDir,
    readZipDirectoryFromFile: zipPure.readZipDirectoryFromFile
  },
  buildLibrarySnapshot: () => ({
    assets: [
      { key: 'ast-key', boothId: '8844481', main: { name: 'Astraea.zip', relPath: 'g/a/Astraea.zip' } },
      // 素材页的号是名字前缀（6985553），下载台账/目录用的是 BOOTH 号（5197537）：回填必须靠主名/目录对上。
      { key: 'mismatch-key', boothId: '6985553', dir: 'g/a', mainName: '6985553.zip' }
    ]
  })
};

deps.libraryPasswords = createLibraryPasswords(deps);
const extract = createLibraryExtract(deps);
// 下载中心要从同一个下载台账读 job.extract / summary.extracted，所以这里挂一个真的 download handler
// （只用于 GET /api/library/downloads，不联网：fetch 桩直接抛错）。
const dl = createLibraryDownload({ ...deps, AbortSignal, Buffer, cfg: {}, libraryExtract: extract, boothDownloadPure, boothPausePure, fetch: async () => { throw new Error('测试不该联网'); } });
const logPath = path.join(stateDir, 'library-extracts.json');
const readLog = () => JSON.parse(fs.readFileSync(logPath, 'utf8'));

function mkReq({ method = 'GET', headers = {}, body = null } = {}) {
  const r = {
    req: { method, headers },
    url: new URL('http://127.0.0.1:3100/placeholder'),
    res: {},
    readBody: async () => body,
    sent: null,
    sendJson(payload, status = 200) { r.sent = { payload, status }; }
  };
  return r;
}

async function call(pathname, { method = 'GET', headers = {}, body = null } = {}) {
  const r = mkReq({ method, headers, body });
  r.url = new URL('http://127.0.0.1:3100' + pathname);
  const handled = await extract.handleConsoleLibraryExtract(r);
  return { handled, status: r.sent ? r.sent.status : 0, payload: r.sent ? r.sent.payload : null };
}

async function dlCall(pathname) {
  const r = mkReq();
  r.url = new URL('http://127.0.0.1:3100' + pathname);
  const handled = await dl.handleConsoleLibraryDownload(r);
  return { handled, status: r.sent ? r.sent.status : 0, payload: r.sent ? r.sent.payload : null };
}

console.log('## dryRun：只看目录，不落盘');
{
  const r = await call('/api/library/extract', { method: 'POST', body: { boothId: '5197537', dryRun: true } });
  check('dryRun 回 ok', r.payload && r.payload.ok === true);
  check('dryRun 标记为 true', r.payload.dryRun === true);
  // readZipDirectoryFromFile 会在解析阶段就丢掉穿越条目（extract 同样跳过它），所以总数是 2。
  check('dryRun 给出条目总数（穿越条目已被排除）', r.payload.zipEntries === 2, `实际 ${r.payload.zipEntries}`);
  check('dryRun 给出总字节', r.payload.zipBytes > 0);
  check('dryRun 预览不超过 20 条', Array.isArray(r.payload.preview) && r.payload.preview.length <= 20);
  check('dryRun 目标目录是 <zip 同级>/<stem>', /5197537$/.test(r.payload.destDirRel), r.payload.destDirRel);
  check('dryRun 没解出目录', !fs.existsSync(path.join(dlDir, '5197537')));
  check('dryRun 不写历史日志', !fs.existsSync(logPath));
  const s = await call('/api/library/extract', { method: 'POST', body: { boothId: '5197537', dryRun: 'true' } });
  check('dryRun 也认字符串 "true"', s.payload.dryRun === true);
}

console.log('## 按 boothId 找 job 只认压缩包（verifier P1）');
{
  // 真机场景：缩略图也走同一个下载器，台账里 thumbnail 与 zip 并存，必须挑 zip。
  const bothDir = path.join(libDir, '3333333');
  fs.mkdirSync(bothDir, { recursive: true });
  fs.writeFileSync(path.join(bothDir, '3333333.thumbnail.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(bothDir, '3333333.zip'), buildZip([{ name: 'Thing/model.fbx', data: 'bytes' }]));
  const onlyThumbDir = path.join(libDir, '2222222');
  fs.mkdirSync(onlyThumbDir, { recursive: true });
  fs.writeFileSync(path.join(onlyThumbDir, '2222222.thumbnail.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const jobsFile = path.join(stateDir, 'booth-downloads.json');
  const parsed = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
  parsed.jobs.push(
    { boothId: '3333333', fileName: '3333333.thumbnail.png', state: 'done', finishedAt: 100 },
    { boothId: '3333333', fileName: '3333333.zip', state: 'done', finishedAt: 200 },
    { boothId: '2222222', fileName: '2222222.thumbnail.png', state: 'done', finishedAt: 300 }
  );
  fs.writeFileSync(jobsFile, JSON.stringify(parsed));
  const both = await call('/api/library/extract', { method: 'POST', body: { boothId: '3333333', dryRun: true } });
  check('thumbnail + zip 时挑 zip（dryRun 成功）', both.status === 200 && both.payload.ok === true, JSON.stringify(both.payload));
  check('挑中的是 zip 文件', /3333333\.zip$/.test(String(both.payload.destDirRel || '')) || both.payload.zipEntries === 1);
  const onlyThumb = await call('/api/library/extract', { method: 'POST', body: { boothId: '2222222' } });
  check('只有封面 → 400，文案说明没有压缩包', onlyThumb.status === 400 && /没有压缩包/.test(onlyThumb.payload.error), JSON.stringify(onlyThumb.payload));
}

console.log('## 参数与状态校验');
{
  const noId = await call('/api/library/extract', { method: 'POST', body: {} });
  check('缺 key 又缺 boothId → 400', noId.status === 400 && /请给 key/.test(noId.payload.error));
  const badDry = await call('/api/library/extract', { method: 'POST', body: { boothId: '5197537', dryRun: 'yes' } });
  check('dryRun 非法 → 400 且有说明', badDry.status === 400 && /dryRun 只认/.test(badDry.payload.error));
  const unknown = await call('/api/library/extract', { method: 'POST', body: { boothId: '1234567' } });
  check('下载台账里没有 → 404 人话', unknown.status === 404 && /下载台账里没有/.test(unknown.payload.error));
  const notDone = await call('/api/library/extract', { method: 'POST', body: { boothId: '7777777' } });
  check('下载还没完成 → 409 说明当前状态', notDone.status === 409 && /还没完成/.test(notDone.payload.error));
  const notZip = await call('/api/library/extract', { method: 'POST', body: { boothId: '6666666' } });
  check('只有封面时说明没有压缩包 → 400 人话', notZip.status === 400 && /没有压缩包/.test(notZip.payload.error));
  const gone = await call('/api/library/extract', { method: 'POST', body: { boothId: '5555555' } });
  check('压缩包不在磁盘 → 404 人话', gone.status === 404 && /不在磁盘上/.test(gone.payload.error));
  const badKey = await call('/api/library/extract', { method: 'POST', body: { key: 'no-such-key' } });
  check('未知素材 key → 404 人话', badKey.status === 404 && /找不到这件素材/.test(badKey.payload.error));
}

console.log('## 真解：解到 <stem>/、zip 保留、穿越条目跳过');
{
  const r = await call('/api/library/extract', { method: 'POST', body: { boothId: '5197537' } });
  check('真解回 ok', r.payload && r.payload.ok === true, JSON.stringify(r.payload));
  check('解出 2 个文件（穿越条目被跳过）', r.payload.files === 2, `实际 ${r.payload.files}`);
  check('skipped 里记了穿越条目', Array.isArray(r.payload.skipped) && r.payload.skipped.some((s) => String(s.name || '').includes('evil.txt')), JSON.stringify(r.payload.skipped));
  const destAbs = path.join(libDir, ...String(r.payload.destDirRel).split('/'));
  check('目标目录真实存在', fs.existsSync(destAbs));
  check('文件按压缩包内层级落地', fs.existsSync(path.join(destAbs, 'Mew_Pose', 'model.fbx')));
  check('嵌套目录也在', fs.existsSync(path.join(destAbs, 'Mew_Pose', 'tex', 'albedo.png')));
  check('原 zip 还在（绝不删）', fs.existsSync(dlZip) && fs.statSync(dlZip).size > 0);
  check('穿越条目没写到档案根', !fs.existsSync(path.join(libDir, 'evil.txt')) && !fs.existsSync(path.join(path.dirname(libDir), 'evil.txt')));
  check('日志写了一条', fs.existsSync(logPath) && readLog().items.length === 1);
  const item = readLog().items[0];
  // zip 相对路径用 path.join 拼（Windows 是反斜杠），比对时统一成 /。
  check('日志字段齐全', item.boothId === '5197537' && String(item.zip).split(String.fromCharCode(92)).join('/') === '5197537/5197537.zip' && Number(item.files) === 2 && Number(item.at) === 1700000000000, JSON.stringify(item));
  const ledger = JSON.parse(fs.readFileSync(path.join(stateDir, 'booth-downloads.json'), 'utf8'));
  const job = ledger.jobs.find((row) => row.boothId === '5197537');
  check('手动解压回填下载台账 job.extract', Boolean(job && job.extract && job.extract.state === 'done' && Number(job.extract.files) === 2 && /5197537$/.test(String(job.extract.destDirRel))), JSON.stringify(job && job.extract));
  const center = await dlCall('/api/library/downloads');
  check('下载中心 summary.extracted 记 1 件', center.payload && center.payload.summary && center.payload.summary.extracted === 1, JSON.stringify(center.payload && center.payload.summary));
  check('下载中心该 job 带 extract', Boolean(center.payload && center.payload.jobs.some((row) => row.boothId === '5197537' && row.extract && row.extract.state === 'done')));
}

console.log('## 重复解压：同名目录加 .1，不覆盖已解出的文件');
{
  const marker = path.join(dlDir, '5197537', 'Mew_Pose', 'model.fbx');
  fs.writeFileSync(marker, 'user-edited');
  const r = await call('/api/library/extract', { method: 'POST', body: { boothId: '5197537' } });
  check('第二次解压 ok', r.payload.ok === true);
  check('目标目录变成 <stem>.1', /5197537\.1$/.test(r.payload.destDirRel), r.payload.destDirRel);
  check('.1 目录真的有文件', fs.existsSync(path.join(dlDir, '5197537.1', 'Mew_Pose', 'model.fbx')));
  check('旧目录里的用户改动没被覆盖', fs.readFileSync(marker, 'utf8') === 'user-edited');
  check('历史日志累积两条', readLog().items.length === 2);
  const ledger2 = JSON.parse(fs.readFileSync(path.join(stateDir, 'booth-downloads.json'), 'utf8'));
  const same = ledger2.jobs.filter((row) => row.boothId === '5197537');
  check('重复解压只更新同一条 job（不新增）', same.length === 1, `实际 ${same.length} 条`);
  check('重复解压后 job.extract 指向新目录 .1', /5197537\.1$/.test(String(same[0] && same[0].extract && same[0].extract.destDirRel)), JSON.stringify(same[0] && same[0].extract));
}

console.log('## 加密包：拒绝解压但不出 500');
{
  const r = await call('/api/library/extract', { method: 'POST', body: { boothId: '8888888' } });
  check('加密包回 200（人话错误，不炸）', r.status === 200, `实际 ${r.status}`);
  check('encrypted 标记为 true', r.payload && r.payload.encrypted === true);
  check('错误文案说清没接密码', /有密码/.test(r.payload.error));
  check('加密包没解出目录', !fs.existsSync(path.join(encDir, 'secret')));
  check('加密包也记进历史（失败也留痕）', readLog().items.some((it) => it.boothId === '8888888'));
  const ledger3 = JSON.parse(fs.readFileSync(path.join(stateDir, 'booth-downloads.json'), 'utf8'));
  const encJob = ledger3.jobs.find((row) => row.boothId === '8888888');
  check('加密失败版本不回填 job.extract', Boolean(encJob && !encJob.extract));
}

console.log('## 走素材 key：解到主件同级 <stem>/');
{
  const r = await call('/api/library/extract', { method: 'POST', body: { key: 'ast-key' } });
  check('key 路径解压 ok', r.payload.ok === true, JSON.stringify(r.payload));
  check('落盘到 g/a/Astraea/', fs.existsSync(path.join(assetDir, 'Astraea', 'Astraea', 'readme.txt')) || fs.existsSync(path.join(assetDir, 'Astraea', 'readme.txt')));
  const dry = await call('/api/library/extract', { method: 'POST', body: { key: 'ast-key', dryRun: true } });
  check('key 路径也能 dryRun', dry.payload.dryRun === true && dry.payload.zipEntries === 1);
  const ledger4 = JSON.parse(fs.readFileSync(path.join(stateDir, 'booth-downloads.json'), 'utf8'));
  check('没有对应下载 job 时不新建台账行（只写 extracts.json）', !ledger4.jobs.some((row) => row.boothId === '8844481'), JSON.stringify(ledger4.jobs.filter((row) => row.boothId === '8844481')));
  check('该次解压仍记进 extracts.json', readLog().items.some((it) => it.boothId === '8844481'));
}

console.log('## 历史状态接口');
{
  const r = await call('/api/library/extract/status');
  check('status 回 ok', r.payload.ok === true);
  check('status 有 running 字段', r.payload.running === false);
  check('status 返回最近记录', Array.isArray(r.payload.items) && r.payload.items.length >= 3);
  check('status 最多 20 条', r.payload.items.length <= 20);
}

console.log('## 权限 / 方法 / 不接管');
{
  const a1 = await call('/api/library/extract', { method: 'POST', headers: { 'x-agent-token': 'abc' }, body: { boothId: '5197537' } });
  check('agent 令牌 POST → 403', a1.status === 403 && /管理端/.test(a1.payload.error));
  const a2 = await call('/api/library/extract/status', { headers: { 'x-agent-call': '1' } });
  check('agent 令牌 status → 403', a2.status === 403);
  const getPost = await call('/api/library/extract', { method: 'GET' });
  check('POST 接口用 GET → 405', getPost.status === 405);
  const postStatus = await call('/api/library/extract/status', { method: 'POST' });
  check('status 接口用 POST → 405', postStatus.status === 405);
  const other = await call('/api/library/assets');
  check('别的路径返回 false（交给下一个 handler）', other.handled === false);
  const badJson = await call('/api/library/extract', { method: 'POST', readBody: undefined, body: undefined });
  check('空请求体按空对象处理（不炸）', badJson.handled === true);
}

console.log('## 台账 fileName 想穿越：只信 safeResolveInside，不能解到档案根外');
{
  // 把「目标文件」放档案根外一层：如果代码直接 path.resolve 拼路径，就会读到这里并解到根外。
  const outsideZip = path.join(tmp, 'escape.zip');
  fs.writeFileSync(outsideZip, buildZip([{ name: 'pwn/model.fbx', data: 'x' }]));
  const r = await call('/api/library/extract', { method: 'POST', body: { boothId: '4444444' } });
  check('穿越路径回 400/404（不是 200，也不是 500）', r.status === 400 || r.status === 404, `实际 ${r.status} ${JSON.stringify(r.payload)}`);
  check('根外 zip 没被当成素材', !fs.existsSync(path.join(tmp, 'pwn')) && !fs.existsSync(path.join(libDir, 'pwn')));
  check('没解出任何目录（档案根下只有已知几件）', fs.readdirSync(libDir).filter((n) => !['5197537', '5197537.1', '8888888', 'g', '2222222', '3333333'].includes(n)).length === 0, JSON.stringify(fs.readdirSync(libDir)));
}

console.log('## 回填匹配：asset.boothId ≠ job.boothId，但主名能对上也要回填');
{
  fs.writeFileSync(path.join(assetDir, '6985553.zip'), buildZip([{ name: 'Mew/model.fbx', data: 'm' }]));
  fs.writeFileSync(path.join(stateDir, 'booth-downloads.json'), JSON.stringify({ v: 1, at: 1700000000000, jobs: [{ boothId: '5197537', fileName: '6985553.zip', state: 'done' }] }));
  const r = await call('/api/library/extract', { method: 'POST', body: { key: 'mismatch-key' } });
  check('主名能对上就解压成功', r.payload.ok === true, JSON.stringify(r.payload));
  const ledger = JSON.parse(fs.readFileSync(path.join(stateDir, 'booth-downloads.json'), 'utf8'));
  const job = ledger.jobs.find((row) => row.boothId === '5197537');
  check('asset.boothId 不同也能回填 job.extract', Boolean(job && job.extract && job.extract.state === 'done'), JSON.stringify(job && job.extract));
  check('回填的 destDirRel 指向这次解出的目录', Boolean(job && /6985553$/.test(String(job.extract && job.extract.destDirRel))), JSON.stringify(job && job.extract && job.extract.destDirRel));
}

console.log('## 解压密码：有密码本自动带、密码错可重试、AES 明说解不了');
{
  // 真 ZipCrypto 包（buildEncryptedZip 与 zip-crypto 用同一套原语加密），密码 open-sesame。
  const pwDir = path.join(libDir, '9999999');
  fs.mkdirSync(pwDir, { recursive: true });
  fs.writeFileSync(path.join(pwDir, 'pw.zip'), buildEncryptedZip([{ name: 'locked/model.fbx', data: 'secret-bytes' }], { password: 'open-sesame' }));
  const aesDir = path.join(libDir, '8888889');
  fs.mkdirSync(aesDir, { recursive: true });
  fs.writeFileSync(path.join(aesDir, 'aes.zip'), buildAesZip([{ name: 'a.txt', data: 'x' }]));
  fs.writeFileSync(path.join(stateDir, 'booth-downloads.json'), JSON.stringify({ v: 1, at: 1700000000000, jobs: [
    { boothId: '9999999', fileName: 'pw.zip', state: 'done' },
    { boothId: '8888889', fileName: 'aes.zip', state: 'done' }
  ] }));
  const noPw = await call('/api/library/extract', { method: 'POST', body: { boothId: '9999999' } });
  check('没密码 → 200 且 reason=password_required', noPw.status === 200 && noPw.payload.reason === 'password_required', JSON.stringify(noPw.payload));
  check('没密码时人话说清要输一次', /密码/.test(String(noPw.payload.error)));
  check('没密码没解出目录', !fs.existsSync(path.join(pwDir, 'pw')));
  const badPw = await call('/api/library/extract', { method: 'POST', body: { boothId: '9999999', password: 'wrong-one' } });
  check('密码错 → 200 且 reason=bad_password', badPw.status === 200 && badPw.payload.reason === 'bad_password', JSON.stringify(badPw.payload));
  const good = await call('/api/library/extract', { method: 'POST', body: { boothId: '9999999', password: 'open-sesame' } });
  check('密码对 → 解压成功', good.payload.ok === true, JSON.stringify(good.payload));
  check('密码对时真解出文件', fs.existsSync(path.join(pwDir, 'pw', 'locked', 'model.fbx')));
  const store = JSON.parse(fs.readFileSync(path.join(stateDir, 'booth-passwords.json'), 'utf8'));
  check('用户输对的密码写进密码本', Boolean(store.items['booth:9999999'] && store.items['booth:9999999'].password === 'open-sesame'));
  const auto = await call('/api/library/extract', { method: 'POST', body: { boothId: '9999999' } });
  check('第二次不用再输，密码本自动带上', auto.payload.ok === true, JSON.stringify(auto.payload));
  check('自动复用解到 .1 目录（不覆盖）', fs.existsSync(path.join(pwDir, 'pw.1')));
  const dry = await call('/api/library/extract', { method: 'POST', body: { boothId: '9999999', dryRun: true } });
  check('dryRun 带 hasPassword 布尔', dry.payload.hasPassword === true, JSON.stringify(dry.payload));
  check('dryRun 标出 encrypted/encryption', dry.payload.encrypted === true && dry.payload.encryption === 'zipcrypto', JSON.stringify(dry.payload));
  const aes = await call('/api/library/extract', { method: 'POST', body: { boothId: '8888889', password: 'open-sesame' } });
  check('AES 包 → 200 且 reason=aes_unsupported', aes.status === 200 && aes.payload.reason === 'aes_unsupported', JSON.stringify(aes.payload));
  check('AES 的人话不是「密码不对」', /AES/.test(String(aes.payload.error)));
  check('密码明文不出现在任何响应里', ![noPw, badPw, good, auto, dry, aes].some((r) => JSON.stringify(r.payload).includes('open-sesame')));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log(`下载后解压：通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
