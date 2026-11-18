#!/usr/bin/env node
// 一次性修数据：把历史消息里「给模型的判断/指令」从会话语录正文里清掉。
//
// 背景：修 bug 之前，视频消息的正文被写成
//   `【视频声音】听不清（empty）：这段语音不可当作内容依据，别猜、别复述。 [视频 10 秒｜画面：…]`
// 会话语录（控制台）直接显示这段正文，于是「机器人自己的判断」漏进了聊天记录。
// 新代码只写事实（`声音：无` / `声音：听不清` / `声音：“原话”`），这个脚本按同一口径
// 把**存量**消息回填一遍，并把被重复拼了两遍的正文收敛成一份。
//
// 覆盖两处：state/social-v2.json（控制台会话页）与 state/messages.db（查历史/回忆工具）。
//
// 用法：
//   node scripts/fix-video-texts.mjs            # 预演（只报会改几条、长什么样）
//   node scripts/fix-video-texts.mjs --apply    # 真写，先备份
//   node scripts/fix-video-texts.mjs --json     # 机器可读结果
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state', 'social-v2.json');
const DB_FILE = path.join(ROOT, 'state', 'messages.db');
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const asJson = args.has('--json');

const VIDEO_LINE = /\[视频[^\]]*\]/;
// 一条声音结论：从「【视频声音】」到下一个「【」或视频行或结尾
const VOICE_CHUNK = /【视频声音】[^【]*?(?=\[视频|【视频声音】|$)/g;

export function cleanVideoText(text) {
  const src = String(text || '');
  if (!src.includes('【视频声音】')) return null;
  const videoMatch = src.match(VIDEO_LINE);
  const videoLine = videoMatch ? videoMatch[0] : '';
  let voice = '';
  const said = /【视频声音】原话转写：“([\s\S]*?)”/.exec(src);
  if (said) voice = `声音：“${said[1].trim()}”`;
  else if (/【视频声音】听不清/.test(src)) voice = '声音：听不清';
  else if (/【视频声音】没有可用的人声/.test(src)) voice = '声音：无';
  else if (/【视频声音】转写失败/.test(src)) voice = '声音：没转出来';
  else if (/【视频声音】转写中/.test(src)) voice = '声音：转写中';
  const rest = src
    .replace(VOICE_CHUNK, ' ')
    .replace(VIDEO_LINE, ' ')
    .replace(/这段语音不可当作内容依据[，,]?别猜、别复述。?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [rest, videoLine, voice].filter(Boolean).join('\n').trim();
}

function walkMessages(node, pathParts, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkMessages(item, [...pathParts, i], out));
    return;
  }
  if (typeof node.text === 'string' && node.text.includes('【视频声音】')) {
    out.push({ node, pathParts });
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'text' || k === 'plain') continue;
    walkMessages(v, [...pathParts, k], out);
  }
}

function planState() {
  if (!fs.existsSync(STATE)) return { raw: '', state: null, planned: [], hits: 0 };
  const raw = fs.readFileSync(STATE, 'utf8');
  const state = JSON.parse(raw);
  const hits = [];
  walkMessages(state, [], hits);
  const planned = [];
  for (const { node, pathParts } of hits) {
    const next = cleanVideoText(node.text);
    if (!next || next === node.text) continue;
    planned.push({ where: pathParts.join('.'), seq: node.seq, before: node.text, after: next, node });
  }
  return { raw, state, planned, hits: hits.length };
}

function planDb() {
  if (!fs.existsSync(DB_FILE)) return [];
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, key, text FROM messages WHERE text LIKE '%【视频声音】%'").all();
    return rows
      .map((row) => ({ id: row.id, key: row.key, before: row.text, after: cleanVideoText(row.text) }))
      .filter((row) => row.after && row.after !== row.before);
  } finally {
    db.close();
  }
}

function applyDb(planned) {
  const backup = `${DB_FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(DB_FILE, backup);
  const db = new DatabaseSync(DB_FILE);
  try {
    const updMsg = db.prepare('UPDATE messages SET text = ? WHERE id = ?');
    // msg_fts.rowid == messages.id（src/message-db.js 里按同一 rowid 写入），正文改了索引也要改
    const updFts = db.prepare('UPDATE msg_fts SET text = ? WHERE rowid = ?');
    const delMsg = db.prepare('DELETE FROM messages WHERE id = ?');
    let dropped = 0;
    for (const row of planned) {
      try {
        updMsg.run(row.after, row.id);
        updFts.run(row.after, row.id);
      } catch (e) {
        // 已经有一条同 key/ts/text 的「事实版」行（上一轮改完、桥接又从内存态补写了旧的一条）：
        // 直接删掉这条旧的，别留重复。
        if (!/UNIQUE constraint failed/.test(String(e && e.message))) throw e;
        delMsg.run(row.id);
        dropped += 1;
      }
    }
    if (dropped) console.log(`· 删除 ${dropped} 条与既有事实版重复的旧行`);
  } finally {
    db.close();
  }
  return backup;
}

function main() {
  const statePlan = planState();
  const dbPlanned = planDb();
  const changes = [
    ...statePlan.planned.map(({ node, ...rest }) => ({ source: 'social-v2.json', ...rest })),
    ...dbPlanned.map(({ id, ...rest }) => ({ source: 'messages.db', id, ...rest }))
  ];

  if (asJson) {
    console.log(JSON.stringify({ ok: true, apply, total: changes.length, changes }, null, 2));
  } else {
    console.log(`state 快照：命中 ${statePlan.hits} 条旧消息，需要改写 ${statePlan.planned.length} 条`);
    console.log(`永久库 messages.db：需要改写 ${dbPlanned.length} 条`);
    for (const c of changes) {
      console.log(`\n· ${c.source} ${c.where || `id ${c.id}`}${c.seq ? `（seq ${c.seq}）` : ''}`);
      console.log(`  旧：${c.before.replace(/\n/g, ' ⏎ ').slice(0, 160)}`);
      console.log(`  新：${c.after.replace(/\n/g, ' ⏎ ').slice(0, 160)}`);
    }
  }

  if (!apply) {
    if (!asJson) console.log('\n（预演，没有写盘；加 --apply 才真的改，会先备份）');
    return;
  }
  if (!changes.length) {
    if (!asJson) console.log('没有需要改的消息');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (statePlan.planned.length) {
    const backup = `${STATE}.bak-${stamp}`;
    fs.writeFileSync(backup, statePlan.raw);
    for (const p of statePlan.planned) {
      p.node.text = p.after;
      if (typeof p.node.plain === 'string' && p.node.plain.includes('【视频声音】')) p.node.plain = p.after;
    }
    const tmp = `${STATE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(statePlan.state, null, 2));
    fs.renameSync(tmp, STATE);
    if (!asJson) console.log(`\n已改写 state 快照 ${statePlan.planned.length} 条；备份：${path.relative(ROOT, backup)}`);
  }
  if (dbPlanned.length) {
    const dbBackup = applyDb(dbPlanned);
    if (!asJson) console.log(`已改写永久库 ${dbPlanned.length} 条；备份：${path.relative(ROOT, dbBackup)}`);
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/fix-video-texts.mjs')) {
  main();
}
