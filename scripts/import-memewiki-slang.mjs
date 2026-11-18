#!/usr/bin/env node
// 把 data/memewiki.db 的梗导入 state/slang.json（状态 confirmed，用户 2026-11-02 要求）。
// 用法：node scripts/import-memewiki-slang.mjs [--dry-run] [--limit N] [--json]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildMemewikiSlangEntries, describeImportResult } from '../src/memewiki-import.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DB = path.join(ROOT, 'data', 'memewiki.db');
const SLANG = path.join(ROOT, 'state', 'slang.json');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const asJson = args.includes('--json');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 0;

function loadRows() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    return db.prepare('SELECT title, slug, summary, origin, usage, tags FROM memes').all();
  } finally {
    db.close();
  }
}

async function main() {
  const { createRequire } = await import('node:module');
  global.require = createRequire(import.meta.url);
  if (!fs.existsSync(DB)) throw new Error('缺 data/memewiki.db，先跑 node scripts/fetch-memewiki.mjs');
  const rows = loadRows();
  const store = JSON.parse(fs.readFileSync(SLANG, 'utf8'));
  const existing = Object.values(store).map((e) => e && e.content).filter(Boolean);
  const nowIso = new Date().toISOString();
  const result = buildMemewikiSlangEntries(rows, { existing, nowIso, limit: limit || undefined });

  if (!dryRun) {
    const backup = SLANG + '.bak-' + nowIso.replace(/[:.]/g, '-');
    fs.copyFileSync(SLANG, backup);
    for (const entry of result.entries) store[entry.id] = entry;
    const tmp = SLANG + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
    fs.renameSync(tmp, SLANG);
    result.backup = path.basename(backup);
  }
  const total = Object.keys(store).length;
  result.storeTotal = dryRun ? null : total;
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else console.log((dryRun ? '[dry-run] ' : '') + describeImportResult(result) + (dryRun ? '' : '；词库现有 ' + total + ' 条，备份 ' + result.backup));
}

main().catch((err) => { console.error('导入失败：' + (err && err.message || err)); process.exit(1); });
