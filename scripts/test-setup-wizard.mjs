// 首次设置向导（/api/setup）的单测：纯函数 + 用临时 config.json 跑真 handler。
// 目标：装完包的人不需要手改 config.json；而这个接口又不能整段覆盖别人的配置。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConsoleConfigAdmin, normalizeSetupIdList, normalizeSetupUrl, buildSetupGaps } from '../src/bridge/console/config-admin.js';

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}${detail === undefined ? '' : ' — ' + detail}`); }
}

console.log('## 纯函数');
{
  ok(normalizeSetupUrl('http://127.0.0.1:3001').url === 'http://127.0.0.1:3001', '接受 http 地址');
  ok(normalizeSetupUrl('https://bot.example.com/onebot/').url === 'https://bot.example.com/onebot', 'https + 去掉尾斜杠');
  ok(normalizeSetupUrl('ftp://x').ok === false, '拒绝非 http(s)');
  ok(normalizeSetupUrl('http://user:pass@host:3001').ok === false, '拒绝带凭据的地址');
  ok(normalizeSetupUrl('').url === '', '空串表示清空');
  ok(normalizeSetupUrl(undefined).url === undefined, '不传 = 不改');

  const ids = normalizeSetupIdList([' 100000001 ', '100000001', '', '100000002']);
  ok(ids.ok && ids.ids.length === 2 && ids.ids[0] === '100000001', '号码去空白去重');
  ok(normalizeSetupIdList(['123']).ok === false, '拒绝短号');
  ok(normalizeSetupIdList(['abc']).ok === false, '拒绝非数字');
  ok(normalizeSetupIdList('x').ok === false, '拒绝非数组');
  ok(normalizeSetupIdList(undefined).ids === undefined, '不传 = 不改');
  ok(normalizeSetupIdList(Array.from({ length: 61 }, (_, i) => String(100000000 + i))).ok === false, '超过 60 个拒绝');

  const allMissing = buildSetupGaps({ ownerQQ: '100000000', allowGroups: [], allowPrivate: [], snowluma: { httpUrl: '' }, dshReady: false });
  ok(allMissing.map((g) => g.key).join(',') === 'ownerQQ,allow,snowluma,dsh', '缺项清单顺序与内容');
  const ready = buildSetupGaps({
    ownerQQ: '100000006', allowGroups: ['100000001'], allowPrivate: [],
    snowluma: { httpUrl: 'http://127.0.0.1:3001', reachable: true }, dshReady: true
  });
  ok(ready.length === 0, '配置齐全时没有缺项');
  const unreachable = buildSetupGaps({
    ownerQQ: '100000006', allowGroups: ['100000001'], snowluma: { httpUrl: 'http://127.0.0.1:3001', reachable: false, error: 'ECONNREFUSED' }, dshReady: true
  });
  ok(unreachable.length === 1 && /连不上/.test(unreachable[0].label) && /ECONNREFUSED/.test(unreachable[0].why), 'SnowLuma 连不上单独提示');
}

console.log('## handler（真 config.json + 假网络）');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-wizard-'));
  const configFile = path.join(dir, 'config.json');
  const seed = {
    ownerQQ: '100000000',
    consolePort: 3100,
    allow: { groups: [], private: [], privateOpen: false },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: '', accessToken: '' },
    socialV2: { sticker: { alwaysInPrompt: true }, aiBlacklist: { enabled: true, qq: [{ id: '100000008' }] } },
    fileArchive: { enabled: true, groups: ['100000001'], maxFileMb: 2560 }
  };
  fs.writeFileSync(configFile, JSON.stringify(seed, null, 2));

  const deps = {
    ROOT: dir,
    path,
    fs: { ...fs },
    atomicWriteJson: (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2)),
    readConfigObject: (file) => JSON.parse(fs.readFileSync(file, 'utf8')),
    updateConfigFile: (file, mutate) => {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      mutate(raw);
      fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    },
    reloadConfigFromDisk: () => ({ ok: true }),
    log: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', data: { user_id: 100000007, nickname: '测试号' } }) }),
    AbortSignal: globalThis.AbortSignal,
    cfg: { ...JSON.parse(JSON.stringify(seed)), dsh: { baseUrl: 'http://127.0.0.1:13707' } },
    dshReady: true
  };
  const { handleConsoleConfigAdmin } = createConsoleConfigAdmin(deps);

  const call = async (method, body, headers = {}) => {
    const sent = [];
    const req = { url: { pathname: '/api/setup' }, req: { method, headers }, readBody: async () => body ?? {}, sendJson: (obj, status) => sent.push({ obj, status }) };
    const handled = await handleConsoleConfigAdmin(req);
    const last = sent[sent.length - 1] || { obj: null, status: 0 };
    return { handled, status: last.status, json: last.obj };
  };

  const status = await call('GET');
  ok(status.handled === true && status.json?.ok === true, 'GET /api/setup 200');
  ok(status.json?.ready === false && status.json.gaps.some((g) => g.key === 'ownerQQ'), '未配置时 ready=false 且点名缺 ownerQQ');
  ok(status.json?.snowluma?.reachable === false && /未配置/.test(String(status.json?.snowluma?.error || '')), '没配地址时不探活，直接标未配置');

  const token = 'setup-token-canary-123';
  const saved = await call('POST', {
    ownerQQ: '100000006',
    snowluma: { httpUrl: 'http://127.0.0.1:3001', accessToken: token },
    allow: { groups: ['100000001', ' 100000002 '], private: ['100000006'] }
  });
  ok(saved.status === 200 && saved.json?.ok === true, 'POST 首次设置 200', JSON.stringify(saved.json));
  ok(!JSON.stringify(saved.json).includes(token), '响应里不回显 accessToken');
  const disk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  ok(disk.ownerQQ === '100000006', 'ownerQQ 落盘');
  ok(disk.snowluma.httpUrl === 'http://127.0.0.1:3001' && disk.snowluma.wsUrl === 'ws://127.0.0.1:3001', 'snowluma 只改 httpUrl，其它字段保留');
  ok(disk.snowluma.accessToken === token, 'accessToken 落盘');
  ok(disk.allow.groups.length === 2 && disk.allow.groups[1] === '100000002', '群名单去空白后落盘');
  ok(disk.socialV2?.sticker?.alwaysInPrompt === true && disk.socialV2?.aiBlacklist?.qq?.[0]?.id === '100000008', '其它段原样保留（没被整段覆盖）');
  ok(disk.fileArchive?.maxFileMb === 2560, 'fileArchive 原样保留');
  ok(saved.json.restartRequired === true, '改了连接/名单 → restartRequired');

  const badUrl = await call('POST', { snowluma: { httpUrl: 'ftp://x' } });
  ok(badUrl.status === 400 && /形如 http/.test(badUrl.json?.error ?? ''), '非法地址 400');
  const badId = await call('POST', { allow: { groups: ['abc'] } });
  ok(badId.status === 400, '非法号码 400');
  const empty = await call('POST', {});
  ok(empty.status === 400 && /没有要写入/.test(empty.json?.error ?? ''), '空 patch 400');
  const agent = await call('POST', { ownerQQ: '123456789' }, { 'x-agent-token': 'x' });
  ok(agent.status === 403, '智能体令牌 403');

  // 二次读取：写入后 ready 应该翻成 true（deps.cfg 同步成磁盘内容，模拟热加载）
  deps.cfg = { ...disk, dsh: { baseUrl: 'http://127.0.0.1:13707' } };
  const after = await call('GET');
  ok(after.json?.ready === true, '配置齐全后 ready=true', JSON.stringify(after.json?.gaps));
  ok(after.json?.snowluma?.reachable === true && after.json.snowluma.qq === 100000007, '写了地址后 SnowLuma 探活成功并带 QQ 号');
  ok(fs.readdirSync(dir).some((name) => name.startsWith('config.json.bak-setup-')), '写盘前备份了 config.json');

  // 只有 /api/setup 被这个分支接管，/api/config 的既有行为不受影响
  const other = await handleConsoleConfigAdmin({ url: { pathname: '/api/nope' }, req: { method: 'GET', headers: {} }, readBody: async () => ({}), sendJson: () => {} });
  ok(other === false, '其它路径仍返回 false（不抢路由）');
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
if (fail > 0) process.exitCode = 1;
