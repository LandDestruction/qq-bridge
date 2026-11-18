// BOOTH 素材库那一批 state 文件的备份覆盖面（与 test-state-backup.mjs 分工：那个管机制，
// 这个管「哪些文件进 / 哪些文件绝不进」）。
//
// 锁死三件事：
//   1. 素材库那一批 state 文件（认号 binds、批量进度、限速暂停、下载队列、已购同步/台账、
//      远程封面、合并/改名/挪目录、别名规则、素材集、手动标签/分类/备注）必须在白名单里，
//      否则这些人工成果会随一次误删永久消失；
//   2. booth-cookies.json / booth-passwords.json 永不进备份 —— 备份目录会被整包拷走
//      （换机/排障上报），cookie 与解压密码原文进去等于把账号会话和密码抄了一份到处放；
//   3. 可再生/纯日志文件（booth-dhash-cache.json、library-extracts.json）不进白名单。
// 不启桥接：直接 import 工厂，构造假 state 目录跑 backupStateNow()。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStateBackup } from '../src/bridge/state-backup.js';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
}

// 素材库这一批状态文件：必须被备份（booth-relocations.json 还没生成，白名单先占位）。
const MUST_BACKUP = [
  'booth-batchfind.json',
  'booth-binds.json',
  'booth-covers.json',
  'booth-downloads.json',
  'booth-merges.json',
  'booth-purchases.json',
  'booth-purchases-sync.json',
  'booth-relocations.json',
  'booth-renames.json',
  'booth-search-pause.json',
  'library-alias-rules.json',
  'library-collections.json',
  'library-manual-meta.json',
  // 用户手工数据（收藏、回收站、角色、反馈、会话元数据、模式）：丢了难补，必须备份
  'booth-favorites.json',
  'booth-trash.json',
  'current-role.json',
  'feedback.json',
  'sessions.json',
  'mode.json'
];
// 凭据文件：必须永不出现。
const NEVER_BACKUP = ['booth-cookies.json', 'booth-passwords.json'];
// 可再生/只是日志的文件：不进白名单，也不该出现在备份里。
const SKIP_BACKUP = ['booth-dhash-cache.json', 'library-extracts.json'];
// 假的 cookie / 密码原文：只要它出现在任何备份产物里就是安全事故。
const SECRET = 'SESSDATA=secret-cookie-value-do-not-copy';
const SECRET_PASSWORD = 'secret-zip-password-do-not-copy';

function mkStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'state-backup-coverage-'));
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeJson(file, value) {
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function backupFor(stateDir) {
  return createStateBackup({ STATE_DIR: stateDir, fs, path, log: () => {} });
}

function backupDir(stateDir) {
  return path.join(stateDir, 'backups');
}

function backupNames(stateDir) {
  try {
    return fs.readdirSync(backupDir(stateDir)).filter((name) => !name.startsWith('.')).sort();
  } catch {
    return [];
  }
}

function seedBoothState(dir) {
  writeJson(path.join(dir, 'booth-binds.json'), { bindings: { 'g/c/1': { boothId: '123', at: '2026-10-29T00:00:00Z' } } });
  writeJson(path.join(dir, 'booth-batchfind.json'), { entries: { 'g/c/2': { boothId: '456' } }, startedAt: '2026-10-29T00:00:00Z' });
  writeJson(path.join(dir, 'booth-search-pause.json'), { until: '2026-10-29T01:00:00Z', reason: '429' });
  writeJson(path.join(dir, 'booth-downloads.json'), { jobs: [{ key: 'g/c/3', state: 'queued' }] });
  writeJson(path.join(dir, 'booth-purchases.json'), { items: { '123': { title: '已购 A' } } });
  writeJson(path.join(dir, 'booth-purchases-sync.json'), { lastSyncAt: 1761700000000, added: 1 });
  writeJson(path.join(dir, 'booth-covers.json'), { '123': { url: 'https://booth.pximg.net/x.jpg' } });
  writeJson(path.join(dir, 'booth-merges.json'), { groups: [['123', '456']] });
  writeJson(path.join(dir, 'booth-renames.json'), { '123': [{ from: 'a.zip', to: 'b.zip' }] });
  writeJson(path.join(dir, 'booth-relocations.json'), { '123': [{ from: '2026-10', to: '123' }] });
  writeJson(path.join(dir, 'library-alias-rules.json'), { rules: [{ name: '旧名', boothId: '123' }] });
  writeJson(path.join(dir, 'library-collections.json'), { items: { c1: { id: 'c1', name: '这套搭配', keys: ['g/c/1'], createdAt: 1, updatedAt: 2 } } });
  writeJson(path.join(dir, 'library-manual-meta.json'), { 'g/c/1': { tags: ['女发'], category: '头发', note: '测试备注' } });
  writeJson(path.join(dir, 'booth-favorites.json'), { 'g/c/1': { at: '2026-10-30T00:00:00Z' } });
  writeJson(path.join(dir, 'booth-trash.json'), { items: [{ key: 'g/c/9', name: 'old.zip', from: '2026-10/a.zip' }] });
  writeJson(path.join(dir, 'current-role.json'), { role: '默认角色' });
  writeJson(path.join(dir, 'feedback.json'), { items: [{ id: 'f1', text: '界面挺好用' }] });
  writeJson(path.join(dir, 'sessions.json'), { 'g:1': { lastAt: 1761700000000, authorized: true } });
  writeJson(path.join(dir, 'mode.json'), { mode: 'chat' });
  writeJson(path.join(dir, 'booth-cookies.json'), { active: 'a', slots: { a: { value: SECRET, tail: 'alue' } } });
  writeJson(path.join(dir, 'booth-passwords.json'), { passwords: [{ value: SECRET_PASSWORD, at: 1761700000000 }] });
  writeJson(path.join(dir, 'booth-dhash-cache.json'), { 'g/c/1': 'ffff0000ffff0000' });
  writeJson(path.join(dir, 'library-extracts.json'), { items: [{ key: 'g/c/1', zip: 'a.zip', destDir: 'a' }] });
  writeJson(path.join(dir, 'social-v2.json'), { sessions: { s: 1 } });
  writeFile(path.join(dir, 'booth-cache', 'cover.bin'), Buffer.alloc(16, 3));
  writeFile(path.join(dir, 'messages.db'), 'sqlite');
  writeJson(path.join(dir, 'tmp-slang.json'), { tmp: true });
  writeJson(path.join(dir, 'tool-log.json'), { log: true });
  // 日志/数据流水与轮转旧档：只追加、按体积轮转（src/bridge/log-rotate.js），永不进备份。
  writeFile(path.join(dir, 'token-usage.jsonl'), '{"k":"turn"}\n');
  writeFile(path.join(dir, 'token-usage.jsonl.1'), '{"k":"turn"}\n');
  writeFile(path.join(dir, 'tool-calls.jsonl'), '{"type":"call"}\n');
  writeFile(path.join(dir, 'bridge.out.2'), 'stdout line\n');
}

// 备份目录里所有字节（含 manifest）：用来断言 cookie 原文没从任何缝隙漏进去。
function allBackupBytes(dir) {
  const files = fs.readdirSync(backupDir(dir));
  return files.map((name) => fs.readFileSync(path.join(backupDir(dir), name))).reduce((acc, buf) => Buffer.concat([acc, buf]), Buffer.alloc(0)).toString('latin1');
}

// 伪造历史备份（按 state-backup 自己的命名规则），用于验证轮转照旧。
function fabricate(dir, sourceBase, stamp) {
  writeFile(path.join(backupDir(dir), `${sourceBase}.${stamp}.json`), '{"old":true}');
}

function dayStamp(offsetDays, clock = '030000') {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${clock}`;
}

function runMain() {
  // ---- 1. BOOTH 四个文件进备份、cookies 一个字节都不进 ----
  const dir = mkStateDir();
  seedBoothState(dir);
  const backup = backupFor(dir);
  const first = backup.backupStateNow();

  check('首次备份 ok', first.ok === true);
  const writtenSources = first.written.map((item) => item.source).sort();
  check('素材库 state 文件全部备份', MUST_BACKUP.every((name) => writtenSources.includes(name)),
    `written=${writtenSources.join(',')}`);
  check(`凭据/密码文件都不在写入结果里（${NEVER_BACKUP.join(',')}）`, NEVER_BACKUP.every((name) => !writtenSources.includes(name)));
  check('备份目录里没有凭据文件产物', backupNames(dir).every((name) => NEVER_BACKUP.every((source) => !name.startsWith(source.replace(/\.json$/, '')))));
  check(`备份目录里没有其他杂物（只 ${MUST_BACKUP.length} + social-v2 + 索引）`, backupNames(dir).length === MUST_BACKUP.length + 1,
    `names=${backupNames(dir).join(',')}`);

  // 字节一致：备份的就是源文件，不是解析后重写的。
  for (const name of MUST_BACKUP) {
    const item = first.written.find((entry) => entry.source === name);
    check(`备份内容与源文件一致：${name}`, Boolean(item) && fs.readFileSync(item.path).equals(fs.readFileSync(path.join(dir, name))));
  }

  // manifest 是「下次跳过」的依据，也不能记凭据。
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir(dir), '.manifest.json'), 'utf8'));
  check('索引不含 booth-cookies.json / booth-passwords.json', NEVER_BACKUP.every((name) => !Object.prototype.hasOwnProperty.call(manifest, name)));
  check(`索引记录了 ${MUST_BACKUP.length} 个素材库文件`, MUST_BACKUP.every((name) => manifest[name] && typeof manifest[name].mtimeMs === 'number'));

  // listStateBackups（页面/CLI --list 用的那一路）也不能露出凭据。
  const listing = backup.listStateBackups();
  check('列表接口不返回凭据文件', listing.files.every((file) => !NEVER_BACKUP.includes(file.source)));

  // 直接扫字节：cookie 原文与解压密码原文都不得出现在备份目录任何文件里。
  const backupBytes = allBackupBytes(dir);
  check('备份目录全文不含 cookie 原文', !backupBytes.includes('secret-cookie-value-do-not-copy'));
  check('备份目录全文不含解压密码原文', !backupBytes.includes('secret-zip-password-do-not-copy'));

  // ---- 2. 只改 cookie 不改别的：零写入（它根本不参与比对） ----
  const namesBefore = backupNames(dir).join(',');
  writeJson(path.join(dir, 'booth-cookies.json'), { active: 'a', slots: { a: { value: `${SECRET}-rotated` } } });
  const afterCookieTouch = backup.backupStateNow();
  check('只改 cookies 不产生任何新备份', afterCookieTouch.written.length === 0 && backupNames(dir).join(',') === namesBefore,
    `written=${afterCookieTouch.written.length}`);

  // ---- 3. 白名单外的邻居仍然不进（booth-cache/ 目录、db、派生 JSON） ----
  check('booth-cache/ 目录 / messages.db / 派生 JSON 都没被备份',
    backupNames(dir).every((name) => !/(booth-cache|messages|tmp-slang|tool-log)/.test(name)), `names=${backupNames(dir).join(',')}`);
  // 日志与轮转旧档（token-usage.jsonl / .1、tool-calls.jsonl、bridge.out.2）体积大、可再生，绝不进备份。
  check('日志文件与轮转旧档不备份（.jsonl / .1 / .out.2）',
    backupNames(dir).every((name) => !/(token-usage|tool-calls|bridge\.(out|log)|activity\.log)/.test(name))
    && !Object.keys(manifest).some((name) => /(token-usage|tool-calls|bridge\.(out|log))/.test(name)),
    `names=${backupNames(dir).join(',')}`);
  check(`可再生/日志文件不备份（${SKIP_BACKUP.join(',')}）`,
    SKIP_BACKUP.every((name) => !writtenSources.includes(name) && !manifest[name]), `names=${backupNames(dir).join(',')}`);

  // ---- 4. 轮转照旧：keep=2 只留最近 2 份，daily=0 不做每日保留 ----
  for (const offset of [-4, -3, -2, -1]) fabricate(dir, 'booth-binds', dayStamp(offset));
  const beforePruneCount = backupNames(dir).filter((name) => name.startsWith('booth-binds.')).length;
  const rotated = backup.backupStateNow({ keep: 2, daily: 0 });
  const keptBinds = backupNames(dir).filter((name) => name.startsWith('booth-binds.'));
  check('轮转前有 5 份 binds 备份（4 伪造 + 1 真）', beforePruneCount === 5, `count=${beforePruneCount}`);
  check('keep=2 后只剩最近 2 份', keptBinds.length === 2, `kept=${keptBinds.join(',')}`);
  check('被清理的是最旧的 3 份', rotated.pruned.filter((item) => item.source === 'booth-binds.json').length === 3);
  check('轮转不碰 cookies（仍然一份都没有）', backupNames(dir).every((name) => !name.startsWith('booth-cookies')));

  // ---- 5. 默认保留策略：24 份 + 每日首份 14 天（与启动日志口径一致） ----
  const defaults = backup.backupStateNow();
  check('默认 keep=24 / daily=14（与启动日志口径一致）', defaults.keep === 24 && defaults.daily === 14, `keep=${defaults.keep} daily=${defaults.daily}`);
  check('默认策略下「每日首份」保留：更早日期的当天首份活着',
    (() => {
      const dir2 = mkStateDir();
      seedBoothState(dir2);
      const b2 = backupFor(dir2);
      b2.backupStateNow();
      for (const offset of [-3, -2, -1]) {
        fabricate(dir2, 'booth-binds', dayStamp(offset));
        fabricate(dir2, 'booth-binds', dayStamp(offset, '150000'));
      }
      b2.backupStateNow({ keep: 1, daily: 3 });
      const kept = backupNames(dir2).filter((name) => name.startsWith('booth-binds.'));
      return kept.some((name) => name.includes(dayStamp(-1))) && kept.some((name) => name.includes(dayStamp(-2)));
    })());

  // ---- 6. state 目录里只有凭据（新装机器、还没认号）：ok 且不建备份目录 ----
  const freshDir = mkStateDir();
  writeJson(path.join(freshDir, 'booth-cookies.json'), { slots: { a: { value: SECRET } } });
  writeJson(path.join(freshDir, 'booth-passwords.json'), { passwords: [{ value: SECRET_PASSWORD }] });
  const fresh = backupFor(freshDir).backupStateNow();
  check('只有凭据时 ok 且零写入', fresh.ok === true && fresh.written.length === 0);
  check('只有凭据时不建备份目录', !fs.existsSync(backupDir(freshDir)));

  // ---- 汇总 ----
  const failed = results.filter((item) => !item.ok);
  const total = results.length;
  const passed = total - failed.length;
  console.log(`\nstate-backup-coverage: ${passed}/${total} ok`);
  if (failed.length > 0) {
    console.log('失败的检查：');
    for (const item of failed) console.log(`  - ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
    process.exitCode = 1;
  }
}

runMain();
