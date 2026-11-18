// GET /api/library/facets：左栏分类树与顶栏胶囊的计数。
//
// 为什么单独一个文件：library-view.js 贴着 800 行规模闸，而 facets 只是「拿最终视图 → 数一遍」。
// 关键约束是**必须和素材列表走同一条视图链**（libraryAssetsViewOf / getAssets 注入），
// 否则 facets 说「服装 2 件」、列表只筛出 1 件，用户会以为后端在骗人。
//
// 计数口径：带 q 时按搜索命中的子集算（文档 §2.1）；purchased/free 也按子集算，
// 这样「搜索后左栏仍显示已购 3」才和列表一致。

import { buildLibraryFacets, FACETS_RULES_VERSION } from '../../library-facets.js';
import { assetSearchHaystack } from '../../library-assets-query.js';
import { duplicateKeySet } from './library-duplicates.js';

/**
 * @param {object} request 控制台请求对象
 * @param {object} deps 桥接依赖（这里只用 log）
 * @param {() => object} getAssets 取「素材页同一份最终视图」的回调
 */
export async function handleLibraryFacetsRoute(request, deps, getAssets) {
  if (request.url.pathname !== '/api/library/facets') return false;
  if (request.req.headers['x-agent-token'] || request.req.headers['x-agent-call']) {
    request.sendJson({ ok: false, error: '素材库扫描只允许管理端操作' }, 403);
    return true;
  }
  if (request.req.method !== 'GET') {
    request.sendJson({ ok: false, error: '该接口只支持 GET' }, 405);
    return true;
  }
  try {
    const q = String(request.url.searchParams.get('q') ?? '').trim().toLowerCase();
    const data = await getAssets();
    const all = Array.isArray(data?.assets) ? data.assets : [];
    // 搜索命中的子集：和 pickAssetsPage 用同一个 haystack（标题/目录/号/密码/RJ/店铺/标签）。
    const subset = q ? all.filter((asset) => assetSearchHaystack(asset).includes(q)) : all;
    const purchased = subset.filter((asset) => asset?.purchase === 'purchased').length;
    const free = subset.filter((asset) => asset?.purchase === 'free').length;
    // quality.duplicated 要和 counts.duplicated / filter=duplicated 同源：用同一份分组结果算，
    // 不能数卡片上的 duplicated 标记（那只认同号，其它三类判据没有标记）。
    const duplicatedKeys = duplicateKeySet(all);
    const result = buildLibraryFacets(subset, { purchased, free, duplicatedKeys });
    deps.log?.(`[素材库] facets：q=${q || '（空）'} → ${result.total} 件`);
    request.sendJson({ ok: true, ...result, categoryRules: FACETS_RULES_VERSION, q });
  } catch (error) {
    // 扫描失败的原话可能带绝对路径：facets 只回结论，不让页面把本机目录结构漏出去。
    request.sendJson({ ok: false, error: `统计失败：${error?.message ?? error}` }, 500);
  }
  return true;
}
