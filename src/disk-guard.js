// 下载前的磁盘空间护栏（纯逻辑 + 可注入 statfs，便于离线断言）。
//
// 为什么需要：单文件上限放宽到 2.5GB 后，几个文件就能把盘写满；而写满的后果不只是
// 这次转存失败 —— 消息库（sqlite）、日志、音频临时文件都会跟着坏。
//
// 规则：freeBytes > needBytes + reserveBytes 才放行。
// 拿不到 statfs（老 Node / 平台不支持 / 目录不可读）时**放行但标记 unknown**，
// 让调用方打一条告警 —— 不能因为一次 API 不可用把整个转存功能拖死。

export const DISK_RESERVE_BYTES = 5 * 1024 * 1024 * 1024; // 5GB 预留

/**
 * @param {{ statfs: Function, dir: string, needBytes: number, reserveBytes?: number }} p
 * @returns {Promise<{ ok: boolean, freeBytes: number|null, needBytes: number, reserveBytes: number, reason: string, unknown?: boolean }>}
 */
export async function checkDiskSpace({ statfs, dir, needBytes, reserveBytes = DISK_RESERVE_BYTES }) {
  const need = Math.max(0, Number(needBytes) || 0);
  const reserve = Math.max(0, Number(reserveBytes) || 0);
  if (need <= 0) return { ok: true, freeBytes: null, needBytes: need, reserveBytes: reserve, reason: 'no-requirement' };
  try {
    const st = await statfs(dir);
    const freeBytes = Number(st?.bavail ?? st?.bfree) * Number(st?.bsize);
    if (!Number.isFinite(freeBytes)) {
      return { ok: true, freeBytes: null, needBytes: need, reserveBytes: reserve, reason: 'statfs-unusable', unknown: true };
    }
    if (freeBytes < need + reserve) {
      return { ok: false, freeBytes, needBytes: need, reserveBytes: reserve, reason: 'insufficient' };
    }
    return { ok: true, freeBytes, needBytes: need, reserveBytes: reserve, reason: 'ok' };
  } catch (error) {
    return { ok: true, freeBytes: null, needBytes: need, reserveBytes: reserve, reason: `statfs-error:${error?.message ?? error}`, unknown: true };
  }
}

/** 给日志用的一行说明。 */
export function describeDiskVerdict(v) {
  if (!v) return '未知';
  if (v.ok && !v.unknown) return `空间充足（剩余 ${(v.freeBytes / 1024 ** 3).toFixed(1)} GB）`;
  if (v.unknown) return `空间未知（${v.reason}），按放行处理`;
  return `空间不足：剩余 ${(v.freeBytes / 1024 ** 3).toFixed(1)} GB，需 ${(v.needBytes / 1024 ** 3).toFixed(1)} GB + 预留 ${(v.reserveBytes / 1024 ** 3).toFixed(0)} GB`;
}
