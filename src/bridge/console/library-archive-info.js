// GET /api/library/archive-info：只读地把「这个包里的文本写了什么」摊给管理端看。
// 为什么需要：素材库里一堆没认号的老包，号/商品名/解压码常常只写在包内的 readme.txt 里。
// 补封面失败时 library-covers 会顺手读一次（job.lastArchiveInfo），这个接口让用户能对单件
// 素材按需再读一遍，不用等补封面、也不占补封面队列。
// 本文件是普通 ESM（被 library-view.js import，不进 src/bridge/manifest.json 的 VM 模块清单）：
// readArchiveInfo 直接 import；文件系统一律走 deps（fs/path/safeResolveInside/fileArchiveRootDir），
// 这样测试可以喂假盘，线上也避免在这里自己找根目录。
import { readArchiveInfo, describeArchiveInfo, ARCHIVE_INFO_MAX_PACKAGE_BYTES } from '../../library-archive-info.js';

const ARCHIVE_INFO_PATH = '/api/library/archive-info';
const PACKAGE_NAME_RE = /\.(?:zip|unitypackage)$/i;

function isAgentRequest(req) {
  return req?.headers?.['x-agent-token'] !== undefined || req?.headers?.['x-agent-call'] !== undefined;
}

/**
 * 只读接口：读单件素材主件包内的文本信息。
 * 响应 {ok,key,coverSource,probed:{packageName,bytes},info,text}
 * - info 为 null 表示「没读」（主件不是 zip / 包太大 / 读不动），text 给出人话原因
 * - info 非 null 时是 readArchiveInfo 的原始形状（boothIds/itemUrls/titleCandidates/
 *   passwordCandidates/scanned/truncated），只读不写、不自动绑定
 */
export async function handleArchiveInfoRoute(request, deps, getAssets) {
  const { req, url, sendJson } = request;
  if (url?.pathname !== ARCHIVE_INFO_PATH) return false;
  // 包内文本可能含解压码：只给管理端，智能体令牌一律拒。
  if (isAgentRequest(req)) {
    sendJson({ ok: false, error: '未授权：包内信息是管理端操作' }, 403);
    return true;
  }
  if (req?.method !== 'GET') {
    sendJson({ ok: false, error: '这个接口只支持 GET' }, 405);
    return true;
  }
  const key = String(url?.searchParams?.get('key') ?? '').trim();
  if (!key) {
    sendJson({ ok: false, error: '缺少 key（素材的 contentKey）' }, 400);
    return true;
  }
  // key 只应该是 contentKey（16 位十六进制或 contentKey 形态）：含空白/控制字符/`..` 一律当坏参数，
  // 免得它被当成路径片段拼进 safeResolveInside。
  if (key.length > 200 || /[\s\u0000-\u001f]/.test(key) || key.includes('..')) {
    sendJson({ ok: false, error: 'key 不合法（不该带空白或路径片段）' }, 400);
    return true;
  }
  try {
    const snapshot = await getAssets();
    const cards = Array.isArray(snapshot?.assets) ? snapshot.assets : [];
    const card = cards.find((item) => String(item?.key) === key) || null;
    if (!card) {
      sendJson({ ok: false, error: '没有这件素材（刷新一下素材卡列表再试）' }, 404);
      return true;
    }
    const packageName = String(card.mainName || card.file || '');
    const dir = String(card.dir || '');
    const coverSource = String(card.coverSource || '');
    if (!PACKAGE_NAME_RE.test(packageName)) {
      sendJson({
        ok: true, key, coverSource,
        probed: { packageName, bytes: 0 },
        info: null,
        text: '主件不是压缩包（只支持 zip / unitypackage），没什么可读的',
      });
      return true;
    }
    // 素材库根目录在 deps 里可能是字符串，也可能是 getter（file-library 传的是函数），两种都得认。
    const root = typeof deps.fileArchiveRootDir === 'function' ? deps.fileArchiveRootDir() : deps.fileArchiveRootDir;
    const abs = deps.safeResolveInside(root, deps.path.join(dir, packageName));
    if (!abs) {
      sendJson({ ok: false, error: '包路径不合法（可能刚被移走/改名）' }, 404);
      return true;
    }
    if (!deps.fs.existsSync(abs)) {
      sendJson({ ok: false, error: '这个包不在磁盘上（可能刚被移动/改名/清理）' }, 400);
      return true;
    }
    const stat = deps.fs.statSync(abs);
    const probed = { packageName, bytes: Number(stat.size) || 0 };
    if (probed.bytes > ARCHIVE_INFO_MAX_PACKAGE_BYTES) {
      sendJson({
        ok: true, key, coverSource, probed, info: null,
        text: `包太大（${Math.round(probed.bytes / 1024 / 1024)}MB，超过 256MB 不读）`,
      });
      return true;
    }
    // 只读到中央目录 + 被挑中的文本条目，readArchiveInfo 自己按 400 条 / 2MB 预算截断。
    const buffer = deps.fs.readFileSync(abs);
    const info = readArchiveInfo(buffer, { fileName: packageName });
    deps.log?.(`[素材库] 包内信息 ${key}：号 ${info?.boothIds?.length || 0}、标题 ${info?.titleCandidates?.length || 0}、密码 ${info?.passwordCandidates?.length || 0}`);
    sendJson({ ok: true, key, coverSource, probed, info, text: describeArchiveInfo(info) });
    return true;
  } catch (error) {
    sendJson({ ok: false, error: `读取包内信息失败：${error?.message || error}` }, 500);
    return true;
  }
}
