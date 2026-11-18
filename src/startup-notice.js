// 「上线提醒」的纯逻辑：发不发、发什么。
//
// 为什么单独成文件：这段判断跑在 bot.on('open') 里，要验证只能起真进程连 SnowLuma；
// 而它的坑偏偏都在边界上（10 分钟窗口、时间戳文件损坏、watchdog 反复拉起）。
// 抽成纯函数后 scripts/test-startup-notice.mjs 可以确定性地覆盖这些边界。
import fs from 'node:fs';

/** 10 分钟内不重复提醒：watchdog 每 2 分钟拉起一次，不该刷屏。 */
export const NOTICE_WINDOW_MS = 10 * 60 * 1000;

/**
 * 读上次提醒的时间戳；文件缺失 / JSON 损坏 / 字段非法一律当 0（= 没提醒过，该发）。
 * 刻意「宁发勿漏」：时间戳文件坏了不应该连带把提醒也弄没。
 */
export function readNoticeStamp(file) {
  try {
    return Number(JSON.parse(fs.readFileSync(file, 'utf8')).at) || 0;
  } catch {
    return 0;
  }
}

/**
 * 现在该不该跳过本次提醒。
 * @param {number} lastAt 上次提醒的毫秒时间戳（0 / 非数字 = 从未提醒）
 * @param {number} [now]
 * @param {number} [windowMs]
 * @returns {boolean} true = 窗口内已提醒过，本次跳过
 */
export function isDuplicateNotice(lastAt, now = Date.now(), windowMs = NOTICE_WINDOW_MS) {
  const last = Number(lastAt) || 0;
  // 注意 last 在未来（改过系统时间）时差值为负，同样落在窗口内 → 跳过，避免反复刷。
  return now - last < windowMs;
}

/** 提醒正文。 */
export function formatNoticeText(date = new Date()) {
  return `（上线提醒）机器人已上线，现在在线～ ${date.toLocaleString('zh-CN', { hour12: false })}`;
}
