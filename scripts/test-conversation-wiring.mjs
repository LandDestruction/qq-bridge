#!/usr/bin/env node
// 会话侧四处接线（D75）：① 私聊攒句数加好友提示 ② 纯净模式 ③ @我 /persona 命令。
// 纯规则在 src/private-hint.js / src/pure-mode.js / src/mention-command.js（rules-backend 同步维护），
// 这里验证桥接真的用上了它们：配置归一化、发送尾巴、提示词摘段与步数覆盖、命令转交。
// 用法：node scripts/test-conversation-wiring.mjs
import assert from 'node:assert/strict';
import { normalizePrivateHint, normalizePureMode } from '../src/bridge/config-load.js';
import { PRIVATE_HINT_DEFAULT, privateHintText, shouldAddFriendHint, nextHintState } from '../src/private-hint.js';
import { PURE_MODE_TURN_MAX_STEPS } from '../src/pure-mode.js';
import { turnStepLimit } from '../src/bridge/mux-helpers.js';
import { personaUsageHint } from '../src/mention-command.js';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (name, actual, expected) => ok(name, Object.is(actual, expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);

// ── 1. 配置归一化 ──────────────────────────────────────────────────────────
const hintDefault = normalizePrivateHint(undefined);
eq('addFriendHint 默认 enabled', hintDefault.enabled, true);
eq('addFriendHint 默认 afterMessages', hintDefault.afterMessages, PRIVATE_HINT_DEFAULT.afterMessages);
eq('addFriendHint 默认 cooldownMs', hintDefault.cooldownMs, PRIVATE_HINT_DEFAULT.cooldownMs);
eq('addFriendHint 显式关闭', normalizePrivateHint({ enabled: false }).enabled, false);
eq('addFriendHint afterMessages 下界（1→5）', normalizePrivateHint({ afterMessages: 1 }).afterMessages, 5);
eq('addFriendHint afterMessages 上界（999→200）', normalizePrivateHint({ afterMessages: 999 }).afterMessages, 200);
eq('addFriendHint cooldownMs 下界（1000→1h）', normalizePrivateHint({ cooldownMs: 1000 }).cooldownMs, 3600000);
eq('addFriendHint cooldownMs 上界（99 天→30 天）', normalizePrivateHint({ cooldownMs: 99 * 86400000 }).cooldownMs, 30 * 86400000);
eq('pureMode 默认关闭', normalizePureMode(undefined).enabled, false);
eq('pureMode 严格布尔（字符串 true 不认）', normalizePureMode({ enabled: 'true' }).enabled, false);
eq('pureMode true 生效', normalizePureMode({ enabled: true }).enabled, true);
eq('pureMode 步数常量与 config-load 覆盖值一致', PURE_MODE_TURN_MAX_STEPS, 6);
// mux 运行期真正读的上限：纯净模式开 → 6，关 → 配置值；黑话学习不受影响。
eq('纯净模式开：turnStepLimit=6', turnStepLimit({ socialV2: { pureMode: { enabled: true }, turnMaxSteps: 12 } }, false), PURE_MODE_TURN_MAX_STEPS);
eq('纯净模式关：turnStepLimit=配置值 12', turnStepLimit({ socialV2: { pureMode: { enabled: false }, turnMaxSteps: 12 } }, false), 12);
eq('纯净模式不影响黑话学习步数', turnStepLimit({ socialV2: { pureMode: { enabled: true }, slangLearn: { maxStepsPerRun: 12 }, turnMaxSteps: 12 } }, true), 12);

// ── 2. 私聊提示：攒够句数 → 追加到本条 → 冷却内不再提示 ────────────────────
{
  const h = await bridgeHarness({
    config: {
      allow: { private: ['123'], groups: ['456'] },
      socialV2: { private: { addFriendHint: { enabled: true, afterMessages: 5, cooldownMs: 3600000 } } }
    }
  });
  try {
    const sent = () => h.calls.sent.filter((item) => item.kind === 'private');
    for (let i = 1; i <= 4; i += 1) await h.sendToQQ('private:123', `第${i}句`);
    eq('私聊前 4 句不提示', sent().some((item) => String(item.text).includes(privateHintText())), false);
    await h.sendToQQ('private:123', '第5句');
    const fifth = sent()[sent().length - 1];
    ok('私聊第 5 句末尾追加提示', String(fifth.text).includes(privateHintText()), String(fifth.text));
    eq('提示追加在最后（不单独多发一条）', sent().length, 5);
    for (let i = 6; i <= 10; i += 1) await h.sendToQQ('private:123', `第${i}句`);
    eq('冷却期内（又攒 5 句）也不再提示', sent().filter((item) => String(item.text).includes(privateHintText())).length, 1);
    // 群聊不参与
    for (let i = 1; i <= 6; i += 1) await h.sendToQQ('group:456', `群里第${i}句`);
    const groupHints = h.calls.sent.filter((item) => item.kind === 'group' && String(item.text).includes(privateHintText())).length;
    eq('群聊消息不追加加好友提示', groupHints, 0);
  } finally { await h.close(); }
}
{
  const h = await bridgeHarness({ config: { allow: { private: ['123'] }, socialV2: { private: { addFriendHint: { enabled: false } } } } });
  try {
    for (let i = 1; i <= 8; i += 1) await h.sendToQQ('private:123', `关掉后第${i}句`);
    eq('enabled:false 时一条都不提示', h.calls.sent.filter((item) => String(item.text).includes(privateHintText())).length, 0);
  } finally { await h.close(); }
}
// 冷却到期后可以再次提示（纯规则层直接验，不必等一小时）
{
  const now = 1_800_000_000_000;
  const due = shouldAddFriendHint({ sentCount: PRIVATE_HINT_DEFAULT.afterMessages, lastHintAt: now - PRIVATE_HINT_DEFAULT.cooldownMs - 1, now, cfg: undefined });
  eq('冷却到期后 shouldAddFriendHint 再次为真', due.hint, true);
  const reset = nextHintState({ sentCount: 9, lastHintAt: 0 }, now, true);
  eq('提示后计数清零', reset.sentCount, 0);
  eq('提示后记录时间', reset.lastHintAt, now);
}

// ── 3. 纯净模式：提示词摘段 + 步数上限 6 ───────────────────────────────────
{
  const KEY = 'group:789';
  const makeHarness = (pureModeEnabled) => bridgeHarness({
    config: {
      allow: { groups: ['456', '789'] },
      socialV2: {
        turnMaxSteps: 30,
        pureMode: { enabled: pureModeEnabled },
        memory: { crossSession: { enabled: true } },
        wake: { preSleepWaitEnabled: false, preSleepWaitMs: 1000 }
      }
    }
  });
  const off = await makeHarness(false);
  const on = await makeHarness(true);
  try {
    for (const h of [off, on]) {
      h.setMode('reserved2');
      h.setSelfIdentity('樰', '100000006');
      h.getSocialV2State(KEY);
      h.socialV2.digests = { 'group:456': { at: Date.now(), summary: '那边在聊素材库归档', topics: ['素材库'], people: [] } };
    }
    eq('纯净模式关闭时 turnMaxSteps 保持配置值 30', off.cfg.socialV2.turnMaxSteps, 30);
    eq('纯净模式打开时 turnMaxSteps 有效值变 6', on.cfg.socialV2.turnMaxSteps, PURE_MODE_TURN_MAX_STEPS);
    const capOff = {};
    const capOn = {};
    const textOff = off.buildWakePromptV2(KEY, 'debug', { capture: capOff });
    const textOn = on.buildWakePromptV2(KEY, 'debug', { capture: capOn });
    ok('纯净模式提示词变短', textOn.length < textOff.length, `${textOn.length} < ${textOff.length}`);
    ok('纯净模式第一段是【纯净模式】说明', textOn.startsWith('【纯净模式】'), textOn.slice(0, 40));
    const namesOn = (capOn.parts || []).map((part) => part.name);
    const namesOff = (capOff.parts || []).map((part) => part.name);
    ok('关闭时存在记忆段', namesOff.includes('memory') || namesOff.includes('crossSession'), JSON.stringify(namesOff));
    eq('打开时记忆段被摘掉', namesOn.includes('memory'), false);
    const crossOn = (capOn.parts || []).find((part) => part.name === 'crossSession');
    eq('打开时跨会话摘要段变空（不再取数）', crossOn ? crossOn.chars : 0, 0);
    eq('打开时交接摘要段被摘掉', namesOn.includes('handoff'), false);
    ok('打开时保留人设/令牌/工具段', ['persona', 'token', 'hostTool'].every((name) => namesOn.includes(name)), JSON.stringify(namesOn));
    ok('不含跨会话摘要正文', !textOn.includes('那边在聊素材库归档'));
    ok('关闭时确实带着跨会话摘要正文', textOff.includes('那边在聊素材库归档'));
  } finally { await off.close(); await on.close(); }
}

// ── 4. @我 /persona 命令：入站第一步转交 ───────────────────────────────────
{
  const h = await bridgeHarness({ config: { allow: { groups: ['456'] } } });
  try {
    h.setMode('reserved2');
    const base = { self_id: 999, user_id: 123, message_id: 5201, sender: { nickname: '小明', card: '小明' }, raw_message: '@樰 /persona' };
    // 空参数：直接回用法提示并结束本轮，不唤醒模型
    await h.handleIncoming('group', '456', {
      ...base,
      message: [{ type: 'at', data: { qq: 999 } }, { type: 'text', data: { text: ' /persona' } }]
    }, h.cfg);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const sentNow = h.calls.sent.filter((item) => item.kind === 'group');
    ok('@我 + 空 arg 回 /persona 用法提示', sentNow.some((item) => String(item.text).includes(personaUsageHint())), JSON.stringify(sentNow.map((i) => i.text)));
    eq('空 arg 不唤醒模型', h.calls.prompts.length, 0);

    // 正文里提到 /persona（没有 at 我）不算命令
    await h.handleIncoming('group', '456', {
      ...base, message_id: 5202, message: [{ type: 'text', data: { text: '你可以发 /persona 试试' } }], raw_message: '你可以发 /persona 试试'
    }, h.cfg);
    eq('正文提到 /persona 不转交（不再回用法提示）', h.calls.sent.filter((item) => String(item.text).includes(personaUsageHint())).length, 1);

    // at 别人 + /persona 不转交
    await h.handleIncoming('group', '456', {
      ...base, message_id: 5203, message: [{ type: 'at', data: { qq: 111 } }, { type: 'text', data: { text: ' /persona 猫娘' } }], raw_message: '@小明 /persona 猫娘'
    }, h.cfg);
    eq('at 别人不转交', h.calls.sent.filter((item) => String(item.text).includes(personaUsageHint())).length, 1);

    // at 我 + 有参数：替换成 /persona 猫娘 后继续走后续流程（消息里记的是去掉 at 的正文）
    await h.handleIncoming('group', '456', {
      ...base, message_id: 5204, message: [{ type: 'at', data: { qq: 999 } }, { type: 'text', data: { text: ' /persona 猫娘' } }], raw_message: '@樰 /persona 猫娘'
    }, h.cfg);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const st = h.getSocialV2State('group:456');
    const texts = (st.recentMessages || []).map((m) => String(m.text || ''));
    ok('有参数时原文被替换成 /persona 猫娘', texts.some((t) => t.includes('/persona 猫娘')), JSON.stringify(texts.slice(-3)));
    ok('有参数时不再回用法提示', h.calls.sent.filter((item) => String(item.text).includes(personaUsageHint())).length === 1);
  } finally { await h.close(); }
}

// 5. 设置页可编辑白名单：四个新叶子能读能写
{
  const h = await bridgeHarness({ config: { socialV2: { turnMaxSteps: 12, private: { addFriendHint: { enabled: true, afterMessages: 12 } } } } });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const call = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: route, method: body ? 'POST' : 'GET',
      headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (part) => { text += part; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(text) }); } catch { resolve({ status: res.statusCode, json: null, text }); } });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(Error('fixture timeout')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const got = await call('/api/config');
    eq('GET /api/config 200', got.status, 200);
    const whitelist = Array.isArray(got.json?.whitelist) ? got.json.whitelist : [];
    for (const path of [
      'socialV2.private.addFriendHint.enabled',
      'socialV2.private.addFriendHint.afterMessages',
      'socialV2.private.addFriendHint.cooldownMs',
      'socialV2.pureMode.enabled'
    ]) {
      ok('白名单含 ' + path, whitelist.includes(path), JSON.stringify(whitelist.filter((item) => String(item).includes('addFriendHint') || String(item).includes('pureMode'))));
    }
    eq('GET 回显 afterMessages 现值', Number(got.json?.data?.socialV2?.private?.addFriendHint?.afterMessages), 12);
    const wrote = await call('/api/config', { patch: { 'socialV2.private.addFriendHint.afterMessages': 20 } });
    ok('写 afterMessages 200 且 changed 含该叶子', wrote.status === 200 && (wrote.json?.changed || []).some((item) => String(item).includes('afterMessages')), JSON.stringify(wrote.json));
    const readBack = await call('/api/config');
    eq('写后回读 20', Number(readBack.json?.data?.socialV2?.private?.addFriendHint?.afterMessages), 20);
    // 热加载路径：直接调 reloadConfigFromDisk（与 POST /api/config 的写入后热加载同一条链路），
    // 验证「内存有效值 6 / 落盘值仍是 12」。
    const configPath = path.join(h.temp, 'config.json');
    const diskRaw = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
    eq('纯净模式关：热加载前内存 turnMaxSteps=12', h.cfg.socialV2.turnMaxSteps, 12);
    const baseDisk = diskRaw();
    eq('落盘初始值 12', Number(baseDisk?.socialV2?.turnMaxSteps), 12);
    fs.writeFileSync(configPath, JSON.stringify({ ...baseDisk, socialV2: { ...baseDisk.socialV2, pureMode: { enabled: true } } }, null, 2));
    const reloadOn = h.reloadConfigFromDisk('test-pure-on');
    eq('热加载成功', reloadOn.ok, true);
    eq('热加载后内存 turnMaxSteps=6', h.cfg.socialV2.turnMaxSteps, 6);
    eq('落盘 config.json 仍是 12（不被改写）', Number(diskRaw()?.socialV2?.turnMaxSteps), 12);
    const gotOn = await call('/api/config');
    eq('GET /api/config 展示有效值 6', Number(gotOn.json?.data?.socialV2?.turnMaxSteps), 6);
    fs.writeFileSync(configPath, JSON.stringify({ ...diskRaw(), socialV2: { ...diskRaw().socialV2, pureMode: { enabled: false } } }, null, 2));
    eq('热加载（关）成功', h.reloadConfigFromDisk('test-pure-off').ok, true);
    eq('关后内存 turnMaxSteps 回到 12', h.cfg.socialV2.turnMaxSteps, 12);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
