// 素材库体检（只读）：读 state/console-token，调本机桥接的 /api/library/assets，算一份体检报告。
//
// 用法：
//   node scripts/library-audit.mjs                # 人话报告
//   node scripts/library-audit.mjs --json         # 只输出 JSON（stdout 可解析，人话走 stderr）
//   node scripts/library-audit.mjs --limit 200    # 只分析前 200 件（默认 500，接口上限 500）
//
// 只读：不发任何写请求、不碰 state/、不碰素材文件。桥接没跑/令牌不对 → 人话 + exit 1，不抛堆栈。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, 'state');
const HOST = '127.0.0.1';
const PORT = Number(process.env.CONSOLE_PORT || 3100) || 3100;
const MAX_LIMIT = 500;

function parseArgs(argv) {
  const out = { json: false, limit: MAX_LIMIT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('--limit=')) out.limit = Number(arg.slice('--limit='.length));
    else if (arg === '--limit') { out.limit = Number(argv[i + 1]); i += 1; }
    else throw new Error(`不认识的参数：${arg}（可用：--json / --limit N）`);
  }
  if (!Number.isFinite(out.limit) || out.limit < 1) out.limit = MAX_LIMIT;
  out.limit = Math.min(MAX_LIMIT, Math.floor(out.limit));
  return out;
}

function usage() {
  return [
    '素材库体检（只读）',
    '',
    '  node scripts/library-audit.mjs [--json] [--limit 500]',
    '',
    '  --json        只输出 JSON（stdout），人话摘要走 stderr',
    '  --limit N     只分析前 N 件，默认/上限 500'
  ].join('\n');
}

function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function readToken() {
  const file = path.join(STATE_DIR, 'console-token');
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`找不到 ${path.relative(ROOT, file)}：桥接可能还没启动过（或管理端没开）。先启动桥接再跑。`);
  }
  const token = raw.trim();
  if (!token) throw new Error(`${path.relative(ROOT, file)} 是空的，无法鉴权。`);
  return token;
}

async function fetchAssets({ token, limit }) {
  const url = `http://${HOST}:${PORT}/api/library/assets?limit=${limit}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'x-console-token': token },
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? '连接超时（15 秒）' : (error?.cause?.code || error?.message || String(error));
    throw new Error(`连不上 http://${HOST}:${PORT}（桥接没在跑？）：${reason}`);
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`管理端令牌被拒（HTTP ${res.status}）：${body?.error || '看看 state/console-token 是不是旧的'}`);
  }
  if (!res.ok) {
    throw new Error(`接口返回 HTTP ${res.status}：${body?.error || text.slice(0, 200) || '（空响应）'}`);
  }
  if (!body || body.ok === false) {
    throw new Error(`接口返回失败：${body?.error || '响应缺 ok:true'}`);
  }
  if (!Array.isArray(body.assets)) throw new Error('接口响应里没有 assets 数组，版本不匹配？');
  return body;
}

function topDirOf(dir) {
  const top = String(dir || '').split('/').filter(Boolean)[0];
  return top || '(根目录)';
}

function analyze(body, limit) {
  const assets = Array.isArray(body.assets) ? body.assets : [];
  const withBooth = assets.filter((a) => String(a.boothId || '').trim());
  const noBooth = assets.filter((a) => !String(a.boothId || '').trim());
  const withCover = assets.filter((a) => Boolean(a.thumbRel) || Boolean(a.coverUrl));
  const noCover = assets.filter((a) => !Boolean(a.thumbRel) && !Boolean(a.coverUrl));
  const bound = assets.filter((a) => String(a.boothSource || '') === 'bind');
  const suggested = assets.filter((a) => a.suggestion);

  const byBooth = new Map();
  for (const a of assets) {
    const id = String(a.boothId || '').trim();
    if (!id) continue;
    const list = byBooth.get(id) || [];
    list.push({ key: a.key, title: a.title, dir: a.dir, bytes: Number(a.bytes) || 0 });
    byBooth.set(id, list);
  }
  const duplicateBoothIds = [];
  for (const [boothId, items] of byBooth) {
    if (items.length > 1) duplicateBoothIds.push({ boothId, count: items.length, items });
  }
  duplicateBoothIds.sort((a, b) => b.count - a.count || a.boothId.localeCompare(b.boothId));

  const dirMap = new Map();
  for (const a of assets) {
    const top = topDirOf(a.dir);
    const bucket = dirMap.get(top) || { dir: top, count: 0, bytes: 0 };
    bucket.count += 1;
    bucket.bytes += Number(a.bytes) || 0;
    dirMap.set(top, bucket);
  }
  const analyzedBytes = assets.reduce((sum, a) => sum + (Number(a.bytes) || 0), 0);
  const totalBytes = Number(body.bytes) >= 0 ? Number(body.bytes) : analyzedBytes;
  const byDir = [...dirMap.values()]
    .map((b) => ({ ...b, share: totalBytes > 0 ? b.bytes / totalBytes : 0 }))
    .sort((a, b) => b.bytes - a.bytes || b.count - a.count);

  const largest = assets
    .slice()
    .sort((a, b) => (Number(b.bytes) || 0) - (Number(a.bytes) || 0))
    .slice(0, 5)
    .map((a) => ({ key: a.key, title: a.title, dir: a.dir, bytes: Number(a.bytes) || 0 }));

  const missingOnDisk = Array.isArray(body.missingOnDisk) ? body.missingOnDisk : [];
  const total = Number(body.total ?? body.count ?? assets.length) || assets.length;
  const truncated = Boolean(body.truncated) || total > assets.length;

  const topDir = byDir[0] || null;
  const conclusion = [
    `${total} 件 / ${formatBytes(totalBytes)}`,
    `无号 ${noBooth.length}`,
    `无封面 ${noCover.length}`,
    duplicateBoothIds.length
      ? `${duplicateBoothIds.length} 个号被多件共用（最多 ${duplicateBoothIds[0].count} 件）`
      : '没有重复号',
    topDir ? `${topDir.dir} 占 ${Math.round(topDir.share * 100)}%` : ''
  ].filter(Boolean).join('；');

  return {
    ok: true,
    root: String(body.root || ''),
    port: PORT,
    limit,
    total,
    count: assets.length,
    analyzedCount: assets.length,
    truncated,
    withBooth: withBooth.length,
    noBooth: noBooth.length,
    withCover: withCover.length,
    noCover: noCover.length,
    bound: bound.length,
    suggested: suggested.length,
    missingOnDisk: missingOnDisk.length,
    missingOnDiskItems: missingOnDisk.slice(0, 10),
    duplicateBoothIds,
    totalBytes,
    analyzedBytes,
    largest,
    byDir,
    conclusion
  };
}

function renderHuman(report) {
  const lines = [];
  lines.push(`素材库体检 · ${report.root || '(未返回归档目录)'}（${report.port} 端口）`);
  lines.push(`件数 ${report.total}（本次分析 ${report.count} 件${report.truncated ? '，已截断' : ''}）· 体积 ${formatBytes(report.totalBytes)}`);
  lines.push(`有号 ${report.withBooth} / 无号 ${report.noBooth} · 有封面 ${report.withCover} / 无封面 ${report.noCover} · 已绑定 ${report.bound} · 有建议 ${report.suggested}`);
  lines.push(`台账有、盘上没了：${report.missingOnDisk} 件`);
  if (report.missingOnDisk) {
    for (const item of report.missingOnDiskItems.slice(0, 5)) {
      lines.push(`  - id=${item.id ?? '-'} ${item.fileName || '(无文件名)'}（key=${item.contentKey || '-'}）`);
    }
  }
  if (report.duplicateBoothIds.length) {
    lines.push(`重复号 ${report.duplicateBoothIds.length} 个：`);
    for (const dup of report.duplicateBoothIds.slice(0, 5)) {
      const names = dup.items.slice(0, 3).map((x) => `${x.title || x.key}${x.bytes ? `(${formatBytes(x.bytes)})` : ''}`).join(' / ');
      lines.push(`  - ${dup.boothId} 被 ${dup.count} 件共用：${names}${dup.items.length > 3 ? ' …' : ''}`);
    }
  } else {
    lines.push('重复号：无');
  }
  lines.push('按一级目录：');
  for (const bucket of report.byDir.slice(0, 8)) {
    lines.push(`  - ${bucket.dir}：${bucket.count} 件 · ${formatBytes(bucket.bytes)} · 占 ${Math.round(bucket.share * 100)}%`);
  }
  if (report.byDir.length > 8) lines.push(`  … 另有 ${report.byDir.length - 8} 个目录`);
  lines.push('最大 5 件：');
  for (const item of report.largest) {
    lines.push(`  - ${formatBytes(item.bytes)}  ${item.title || item.key}  [${item.dir || '-'}]`);
  }
  lines.push(`结论：${report.conclusion}`);
  return lines.join('\n');
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exit(1);
  }
  if (args.help) { process.stdout.write(`${usage()}\n`); return; }

  let token;
  try { token = readToken(); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }

  let body;
  try { body = await fetchAssets({ token, limit: args.limit }); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }

  const report = analyze(body, args.limit);
  const human = renderHuman(report);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`${human}\n`);
  } else {
    process.stdout.write(`${human}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`体检失败：${error?.message ?? error}\n`);
  process.exit(1);
});
