// src/bridge/console/library-duplicates.js — 「清理重复」的只读报告接口。
//
// 规则不在这里重写：分组的四类判据、keepKey 的优先级全在 src/library-duplicates.js（retire-console 维护），
// 这里只负责「拿最终视图 → 调纯函数 → 补前端要展示的字段」。
// 为什么喂最终视图：合并卡、解压产物、认号/封面状态都只在视图层才成立；
// 直接扫盘会把已合并的成员再报一遍，用户会以为还能删第二次。

import { groupDuplicates, summarizeDuplicates } from '../../library-duplicates.js';

const BOOTH_ID_RE = /^\d{4,10}$/;

function cardOfKey(byKey, key) {
  return byKey.get(String(key ?? '')) || null;
}

/** 组里有没有 verified 的号：只认台账/人工绑定过的，猜出来的号不能拿去当「这几件是同一个商品」。 */
function verifiedBoothIdOf(members) {
  for (const member of members) {
    const card = member?.__card;
    if (!card) continue;
    const boothId = String(card.boothId ?? '').trim();
    if (card.boothStatus === 'verified' && BOOTH_ID_RE.test(boothId)) return boothId;
  }
  return '';
}

/**
 * 把 groupDuplicates 的结果补成前端能直接渲染的形状。
 * @param {Array<object>} assets 最终素材视图卡片
 */
export function buildDuplicateReport(assets) {
  const list = Array.isArray(assets) ? assets.filter((asset) => asset && typeof asset === 'object') : [];
  const byKey = new Map(list.map((asset) => [String(asset.key ?? ''), asset]));
  const grouped = groupDuplicates(list) || {};
  const groups = (Array.isArray(grouped.groups) ? grouped.groups : []).map((group) => {
    const members = (Array.isArray(group?.members) ? group.members : []).map((member) => {
      const card = cardOfKey(byKey, member?.key) || {};
      return {
        __card: card,
        key: String(member?.key ?? ''),
        title: String(card.displayTitle || card.title || '').slice(0, 200),
        dir: String(member?.dir ?? card.dir ?? ''),
        bytes: Math.max(0, Number(member?.bytes) || 0),
        hasCover: Boolean(member?.hasCover),
        dhash: String(card.dhash ?? '')
      };
    });
    const keepCard = cardOfKey(byKey, group?.keepKey) || {};
    return {
      reason: String(group?.reason ?? ''),
      keys: (Array.isArray(group?.keys) ? group.keys : []).map((key) => String(key)),
      keepKey: String(group?.keepKey ?? ''),
      boothId: verifiedBoothIdOf(members),
      bytes: Math.max(0, Number(group?.bytes) || 0),
      extraBytes: Math.max(0, Number(group?.extraBytes) || 0),
      title: String(keepCard.displayTitle || keepCard.title || group?.title || '').slice(0, 200),
      members: members.map(({ __card, ...rest }) => rest)
    };
  });
  const summary = summarizeDuplicates(groups);
  return {
    ok: true,
    groups,
    totalExtra: Math.max(0, Number(grouped.totalExtra) || 0),
    totalExtraBytes: Math.max(0, Number(grouped.totalExtraBytes) || 0),
    // summary 与 groups 一定自洽：前端左栏「重复素材 N（M 组）」直接读这两个数。
    summary: { groupCount: summary.groupCount, extraCount: summary.extraCount, extraBytes: summary.extraBytes }
  };
}

/**
 * counts / filter=duplicated 用的 key 集合：属于重复组的卡片（含每组 keepKey）。
 * 为什么不能只看 `asset.duplicated` 标记：那个标记只按「同 boothId」打，其它三类判据（同大小/封面近似/标题近似）
 * 都不在卡上——于是左栏说 3 张、`filter=duplicated` 只筛出 1 张，用户当场就发现数字对不上。
 * @param {Array<object>} assets
 * @returns {Set<string>}
 */
export function duplicateKeySet(assets) {
  const report = buildDuplicateReport(assets);
  const keys = new Set();
  for (const group of report.groups) for (const key of group.keys) keys.add(String(key));
  return keys;
}

/**
 * counts 用的轻量口径：属于重复组的**卡片数**（不是组数，也不是唯一的重复号数）。
 * 与 /api/library/duplicates 的 groups 同源，避免左栏数字和弹窗里对不上。
 */
export function duplicateCounts(assets) {
  const report = buildDuplicateReport(assets);
  let cards = 0;
  for (const group of report.groups) cards += group.keys.length;
  return { cards, groups: report.summary.groupCount };
}

/**
 * GET /api/library/duplicates → 重复组报告（只读，不改盘）。
 * @returns {boolean|Promise<boolean>} 命中本路由返回 true
 */
export async function handleLibraryDuplicatesRoute(request, deps, getAssets) {
  if (String(request?.url?.pathname ?? '') !== '/api/library/duplicates') return false;
  const headers = request?.req?.headers ?? {};
  if (headers['x-agent-token'] || headers['x-agent-call']) {
    request.sendJson({ ok: false, error: '重复素材报告只允许管理端操作' }, 403);
    return true;
  }
  if (String(request?.req?.method ?? 'GET').toUpperCase() !== 'GET') {
    request.sendJson({ ok: false, error: '只支持 GET' }, 405);
    return true;
  }
  try {
    const snap = await getAssets();
    const assets = Array.isArray(snap) ? snap : snap?.assets;
    const report = buildDuplicateReport(assets);
    if (typeof deps?.log === 'function') {
      deps.log(`[素材库] 重复素材：${report.summary.groupCount} 组 / ${report.summary.extraCount} 件多余 / ${report.totalExtraBytes} B`);
    }
    request.sendJson(report);
  } catch (error) {
    request.sendJson({ ok: false, error: `统计重复素材失败：${error?.message ?? error}` }, 500);
  }
  return true;
}
