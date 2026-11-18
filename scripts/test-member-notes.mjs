// 群友备注：控制台「会话页成员」上那层别名。存 state/member-notes.json，只影响显示。
// 只测模块本身（不启桥接）：读、加、改名、删、校验、只读降级、坏文件不静默覆盖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConsoleMemberNotes } from '../src/bridge/console/member-notes.js';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
}
function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'member-notes-'));
}
function handlerFor(stateDir, logs = []) {
  const deps = {
    STATE_DIR: stateDir,
    fs,
    path,
    log(message) { logs.push(String(message)); }
  };
  return createConsoleMemberNotes(deps).handleConsoleMemberNotes;
}
// request 形状照 console-server 包出来的那一层：{ url, req:{method,headers}, sendJson, readBody }
function fakeRequest(method, url, body, headers) {
  const out = { status: 0, payload: null };
  const request = {
    url: new URL('http://127.0.0.1:3100' + url),
    req: { method, headers: headers || {} },
    sendJson(payload, status) {
      out.status = status || 200;
      out.payload = payload;
    },
    readBody: async () => body || {}
  };
  return { request, out };
}
async function call(handler, method, url, body, headers) {
  const { request, out } = fakeRequest(method, url, body, headers);
  const handled = await handler(request);
  return { handled, status: out.status, payload: out.payload };
}
const FILE = 'member-notes.json';

async function main() {
  // 1) 空状态：读得出来、而且不凭空建文件
  const dir1 = tmpStateDir();
  const h1 = handlerFor(dir1);
  {
    const r = await call(h1, 'GET', '/api/member-notes');
    check('GET 空列表', r.handled === true && r.status === 200 && r.payload?.ok === true && r.payload.count === 0 && Array.isArray(r.payload.notes));
    check('空列表不建文件', !fs.existsSync(path.join(dir1, FILE)));
  }

  // 2) 加备注 → 落盘 → 读回
  {
    const r = await call(h1, 'POST', '/api/member-notes', { userId: '2719743461', name: 'K（做模的）' });
    check('POST 新增成功', r.status === 200 && r.payload?.ok === true && r.payload.note?.userId === '2719743461');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir1, FILE), 'utf8'));
    check('落盘带 version 与备注', onDisk.version === 1 && onDisk.notes['2719743461'].name === 'K（做模的）');
    const back = await call(h1, 'GET', '/api/member-notes');
    check('GET 读回一条', back.payload.count === 1 && back.payload.notes[0].name === 'K（做模的）');
  }

  // 3) 同名再写＝改名，不重复
  {
    const r = await call(h1, 'POST', '/api/member-notes', { userId: '2719743461', name: 'K 老师' });
    const back = await call(h1, 'GET', '/api/member-notes');
    check('同名再写覆盖为最新', r.payload?.ok === true && back.payload.count === 1 && back.payload.notes[0].name === 'K 老师');
  }

  // 4) 名字里带换行/超长：压成单行并截断到 24 字
  {
    await call(h1, 'POST', '/api/member-notes', { userId: '100000002', name: `  阿\n猫\t猫  ${'很长的备注'.repeat(10)}  ` });
    const back = await call(h1, 'GET', '/api/member-notes');
    const one = back.payload.notes.find((n) => n.userId === '100000002');
    check('名字压成单行', !!one && !/[\n\t]/.test(one.name) && one.name.startsWith('阿 猫 猫'), one && one.name);
    check('名字截断到 24 字', !!one && one.name.length <= 24, one && one.name);
  }

  // 5) 留空＝删除
  {
    const r = await call(h1, 'POST', '/api/member-notes', { userId: '2719743461', name: '   ' });
    check('留空 name 即删除', r.payload?.ok === true && r.payload.removed === true);
    const back = await call(h1, 'GET', '/api/member-notes');
    check('删完只剩另一个', back.payload.count === 1 && back.payload.notes[0].userId === '100000002');
  }

  // 6) 校验：QQ 号格式 / 方法 / 智能体
  {
    const bad = await call(h1, 'POST', '/api/member-notes', { userId: 'abc', name: 'x' });
    check('非法 QQ 号 400', bad.status === 400 && bad.payload?.ok === false);
    const put = await call(h1, 'PUT', '/api/member-notes');
    check('非 GET/POST 405', put.status === 405);
    const other = await call(h1, 'GET', '/api/socialV2/recent');
    check('别的路径不接管', other.handled === false);
    const agent = await call(h1, 'POST', '/api/member-notes', { userId: '2719743461', name: 'x' }, { 'x-agent-call': '1' });
    check('智能体写备注 403', agent.status === 403 && agent.payload?.code === 'admin_only');
  }

  // 7) 坏文件：报 500、记日志、**绝不覆盖**（覆盖等于清空别人的备注）
  {
    const dir2 = tmpStateDir();
    const logs = [];
    const h2 = handlerFor(dir2, logs);
    const broken = '{ 这不是 json';
    fs.writeFileSync(path.join(dir2, FILE), broken, 'utf8');
    const r = await call(h2, 'POST', '/api/member-notes', { userId: '123456789', name: '阿猫' });
    check('坏 JSON 报 500', r.status === 500 && r.payload?.ok === false);
    check('坏 JSON 不覆盖原文件', fs.readFileSync(path.join(dir2, FILE), 'utf8') === broken);
    check('坏 JSON 有日志', logs.some((line) => line.includes('群友备注')));
  }

  // 8) STATE_DIR 不可用时不炸：读当空、写报 500
  {
    const handler = createConsoleMemberNotes({ STATE_DIR: '', fs, path, log() {} }).handleConsoleMemberNotes;
    const read = await call(handler, 'GET', '/api/member-notes');
    check('STATE_DIR 不可用读取仍 200', read.status === 200 && read.payload.count === 0);
    const write = await call(handler, 'POST', '/api/member-notes', { userId: '123456789', name: '阿猫' });
    check('STATE_DIR 不可用写入 500', write.status === 500);
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.log(`  FAIL ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n========== 通过 ${results.length - failed.length} / 失败 ${failed.length} ==========`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
