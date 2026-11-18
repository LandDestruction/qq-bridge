// src/bridge/console/library-alias-routes.js — 素材库「识别规则表（别名表）」的读盘、写盘与路由：
// 日文原名/圈内写法（プラム、R-18、ノーマル）认不出，让用户自己维护 `显示名=别名|别名`。
// 纯规则在 src/library-alias.js（可 import、有单测），这里只做 state 文件读写与 HTTP 形状，
// 由 library-view.js import（library-view 本身就是 ESM，不是 VM 裸执行的模块，可以正常 import）。
//
// 为什么单独拆出来：library-view.js 已经 800 行了（规模闸），别名表的读写/校验/错误原文
// 报错这一坨再塞回去就超；拆开也让「规则怎么解析」和「页面怎么展示」各自可测。

import {
  normalizeAliasTable, parseAliasLine, applyAliasToAsset, ALIAS_ENTRIES_MAX
} from '../../library-alias.js';

const ALIAS_FILE_NAME = 'library-alias-rules.json';

function aliasFilePath(deps) {
  return deps.path.join(String(deps.STATE_DIR || ''), ALIAS_FILE_NAME);
}

/** 读表：文件不存在/JSON 坏/字段怪都当空表（用户写坏一条规则，不能让素材库页面整体 500）。 */
export function readAliasTable(deps) {
  try {
    return normalizeAliasTable(JSON.parse(deps.fs.readFileSync(aliasFilePath(deps), 'utf8')));
  } catch {
    return normalizeAliasTable(null);
  }
}

export function writeAliasTable(deps, table) {
  const file = aliasFilePath(deps);
  if (!String(deps.STATE_DIR || '').trim()) throw new Error('STATE_DIR 未配置，没法保存识别规则');
  (0, deps.atomicWriteJson)(file, table);
  return table;
}

/** 给编辑器的多行文本形态：`显示名=别名|别名`，一行一条。 */
export function aliasTableText(table) {
  return (Array.isArray(table?.entries) ? table.entries : [])
    .map((entry) => `${entry.display}=${entry.aliases.join('|')}`)
    .join('\n');
}

/** assets 快照补 aliasTitle / aliasTerms（不改 title 本身），并回报规则条数与命中数。 */
export function withAliases(deps, data) {
  const table = readAliasTable(deps);
  const assets = (Array.isArray(data?.assets) ? data.assets : []).map((asset) => applyAliasToAsset(asset, table));
  return {
    ...data,
    assets,
    // aliasCount = 这张表当前条数；aliasHits = 本次快照里命中别名的卡片数（页面可显示「规则生效 N 件」）。
    aliasCount: table.entries.length,
    aliasHits: assets.filter((asset) => asset.aliasTitle).length
  };
}

/** GET /api/library/alias-rules、PUT /api/library/alias-rules（只允许管理端）。 */
export async function handleAliasRoutes(request, deps) {
  if (request.req.headers['x-agent-token'] || request.req.headers['x-agent-call']) {
    request.sendJson({ ok: false, error: '识别规则只允许管理端操作' }, 403);
    return true;
  }
  const method = String(request.req.method || 'GET').toUpperCase();
  if (method === 'GET') {
    const table = readAliasTable(deps);
    request.sendJson({
      ok: true,
      table,
      count: table.entries.length,
      text: aliasTableText(table),
      // 例子直接给前端编辑器做占位文案，省得前端自己编。
      examples: ['プラム=梅|plum|梅干し', 'ノーマル=通常|normal', 'R-18=成人向|18禁']
    });
    return true;
  }
  if (method !== 'PUT') {
    request.sendJson({ ok: false, error: '该接口只支持 GET / PUT' }, 405);
    return true;
  }
  let body = {};
  try {
    body = (await request.readBody()) || {};
  } catch {
    request.sendJson({ ok: false, error: '请求体不是合法 JSON' }, 400);
    return true;
  }
  const errors = [];
  const rows = [];
  if (typeof body.text === 'string') {
    // 多行文本是最常用的入口：**逐行报错要带行号和原文**，不然用户在一百行里找不到哪行错。
    const lines = body.text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const text = String(line ?? '').trim();
      if (!text || text.startsWith('#')) return;
      const parsed = parseAliasLine(text);
      if (!parsed) errors.push(`第 ${index + 1} 行不合法：${text.slice(0, 200)}`);
      else rows.push(parsed);
    });
  } else if (Array.isArray(body.rules)) {
    body.rules.forEach((row, index) => {
      if (typeof row === 'string') {
        const parsed = parseAliasLine(row);
        if (!parsed) errors.push(`第 ${index + 1} 条不合法：${row.slice(0, 200)}`);
        else rows.push(parsed);
        return;
      }
      const table = normalizeAliasTable([row]);
      if (!table.entries.length) errors.push(`第 ${index + 1} 条不合法：${JSON.stringify(row).slice(0, 200)}`);
      else rows.push(table.entries[0]);
    });
  } else if (body.table) {
    const table = normalizeAliasTable(body.table);
    if (!table.entries.length && (body.table.entries?.length || body.table.rules?.length)) {
      errors.push('table 里没有一条能用的规则（检查 display / aliases）');
    }
    rows.push(...table.entries);
  } else {
    request.sendJson({ ok: false, error: '请传 { text } 或 { rules: [...] }' }, 400);
    return true;
  }
  if (errors.length) {
    // 一条坏行都不写盘：混合保存会让用户以为「保存成功」，回头发现少了几条更糟。
    request.sendJson({ ok: false, error: `有 ${errors.length} 条不合法，未保存`, errors }, 400);
    return true;
  }
  const table = normalizeAliasTable(rows);
  if (!table.entries.length && rows.length) {
    request.sendJson({ ok: false, error: '规则都不可用，未保存', errors: ['规则解析后为空'] }, 400);
    return true;
  }
  try {
    writeAliasTable(deps, table);
  } catch (error) {
    request.sendJson({ ok: false, error: `保存识别规则失败：${error?.message ?? error}` }, 500);
    return true;
  }
  (0, deps.log)(`素材库：识别规则已保存 ${table.entries.length} 条（上限 ${ALIAS_ENTRIES_MAX}）`);
  request.sendJson({ ok: true, count: table.entries.length, errors: [], table, text: aliasTableText(table) });
  return true;
}
