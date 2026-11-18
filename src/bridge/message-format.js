// message-format: extracted bridge responsibilities; no startup side effects.
// Live dependencies: LOG_LINE_MAX, STATE_DIR, appendBridgeLog, classifyAttachment, clearTimeout, console, forwardIdFromData, fs, redactSensitiveText, setTimeout, truncateText
export function createMessageFormat(deps) {
// @bridge-function createCappedLogger:start
function createCappedLogger(file, maxLines) {
  let lines = -1; // -1 = 还没数过
  return function append(text) {
    try {
      deps.fs.mkdirSync(deps.STATE_DIR, { recursive: true });
      if (lines < 0) {
        try {
          lines = deps.fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      deps.fs.appendFileSync(file, text, 'utf8');
      lines += 1;
      if (lines > maxLines) {
        // 轮转：当前文件改名为 .1（覆盖上一个备份），新文件从零开始。
        try {
          deps.fs.renameSync(file, `${file}.1`);
        } catch {
          // 改名失败（被占用等）就退化成截断，保证文件不会无限增长。
          deps.fs.writeFileSync(file, '', 'utf8');
        }
        lines = 0;
      }
    } catch {}
  };
}
// @bridge-function createCappedLogger:end

// @bridge-function localClock:start
function localClock(atMs = Date.now()) {
  const d = new Date(atMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// @bridge-function localClock:end

// @bridge-function log:start
function log(...args) {
  let line;
  try {
    const body = args
      .map((a) => (0, deps.redactSensitiveText)(typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .replace(/[\r\n]+/g, ' ');
    line = `${localClock()} [bridge] ${body.length > deps.LOG_LINE_MAX ? `${body.slice(0, deps.LOG_LINE_MAX)}…[截断]` : body}`;
  } catch {
    line = `${localClock()} [bridge] (日志参数无法序列化)`;
  }
  // console.log 必须自成一个 try：stdout 的读者（守护窗口）消失时会抛 EPIPE，
  // 而 log() 是从 socket 事件回调里被调用的 —— 一旦抛出就会变成未捕获异常把进程带走。
  try { deps.console.log(line); } catch {}
  (0, deps.appendBridgeLog)(`${line}\n`);
}
// @bridge-function log:end

// @bridge-function withTimeout:start
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = (0, deps.setTimeout)(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => (0, deps.clearTimeout)(timer));
}
// @bridge-function withTimeout:end

// @bridge-function segmentsToText:start
async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true, fileNotices = null } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (let segIndex = 0; segIndex < (segments ?? []).length; segIndex += 1) {
    const seg = segments[segIndex];
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      // 市场表情（mface）在部分网关实现里出现：有 summary 就用它，别让模型只看到 "[mface]"。
      case 'mface': out.push(`[表情${d.summary ? `:${d.summary}` : ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': {
        // 白名单群里的文件由 archiveChatFileSegments 先转存，这里用它的说明替换默认文本，
        // 让模型知道「已存到本地（但没读内容）」/「为什么没存」。非白名单群没有 map，行为不变。
        const notice = fileNotices && fileNotices.get(segIndex);
        out.push(notice || `[文件${d.name ?? ''}]`);
        break;
      }
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': out.push('[卡片消息]'); break;
      // markdown：SnowLuma 1.14.9 的线上段落是 `{type:'markdown',data:{content}}`。
      // 上游 1.14.17+（commit 1934e4e7「include text alongside received markdown」）
      // 起还会带上 `data.text`。两个形状都读，这样将来升级 SnowLuma 运行时不会退化成
      // 字面量 `[markdown]` 被喂给模型。SDK 的 KnownMessageSegment 联合里没有 markdown，
      // 所以段类型是运行时多出来的 —— 这正是 default 分支原来会命中的情况。
      case 'markdown': out.push(String(d.text ?? d.content ?? '[Markdown]')); break;
      case 'forward': {
        const fid = (0, deps.forwardIdFromData)(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}
// @bridge-function segmentsToText:end

// @bridge-function sanitizeMediaSummary:start
function sanitizeMediaSummary(value, max = 60) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return s ? (0, deps.truncateText)(s, max) : '';
}
// @bridge-function sanitizeMediaSummary:end

// @bridge-function extractMediaFromSegments:start
function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    const emojiFields = {
      emojiId: String(d.emoji_id ?? d.emojiId ?? ''),
      emojiPackageId: String(d.emoji_package_id ?? d.emojiPackageId ?? ''),
      emojiKey: String(d.key ?? '')
    };
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        // 线上段落字段是 snake_case 的 `sub_type`（SnowLuma 运行时源码里就这么发）；
        // 而 SDK 的类型描述的是**内部元素**、拼作 `subType`。两个都读，别只认一个
        // —— 只读 camelCase 的话这里会永远是空串，而且不会有任何报错。
        subType: (d.sub_type ?? d.subType) != null ? String(d.sub_type ?? d.subType) : '',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'record') {
      // 入站语音：控制台要能播，就必须把 file 带上（media-cache 会用 get_record 换回可播放的音频）。
      // 以前这里只有 segmentsToText 的 `[语音]`，图表层拿到的是空 media，只能显示一行字。
      media.push({
        kind: 'voice',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        name: String(d.name ?? 'voice').slice(0, 120),
        size: Number(d.file_size ?? d.size) || 0,
        duration: Number(d.duration) || 0
      });
    } else if (seg.type === 'video') {
      // 手机直接发的视频走 video 段，字段与 file 段同构。
      media.push({
        kind: 'video-file',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        name: String(d.name ?? 'video').slice(0, 120),
        size: Number(d.file_size ?? d.size) || 0
      });
    } else if (seg.type === 'file') {
      // 群友常把 mp4 当「文件」发（不是 video 段），这里识别出来当视频处理。
      const name = String(d.name ?? d.file_name ?? d.file ?? '');
      // 扩展名判定统一走 classifyAttachment：把 name / file_name / file / url 都试一遍。
      // 只看 d.name 时，只要 SnowLuma 没给 name 就判不出 mp4 → 视频被当图片抓（22:42 事故）。
      const segKind = (0, deps.classifyAttachment)({ segType: 'file', name: d.name, fileName: d.file_name, file: d.file, url: d.url });
      // 图片以「文件」形式发（拖文件进群）时也要能看见，否则模型只收到 [文件xxx.jpg]。
      if (segKind === 'image') {
        media.push({
          kind: 'image',
          file: String(d.file ?? ''),
          url: String(d.url ?? ''),
          name: name.slice(0, 120),
          size: Number(d.file_size ?? d.size) || 0,
          summary: name.slice(0, 40),
          fromFile: true
        });
      }
      if (segKind === 'video-file') {
        media.push({
          kind: 'video-file',
          file: String(d.file ?? ''),
          url: String(d.url ?? ''),
          name: name.slice(0, 120),
          size: Number(d.file_size ?? d.size) || 0
        });
      }
    } else if (seg.type === 'mface') {
      // 市场表情（mface）：没有 image 段可用，emoji_id/url 是唯一来源。
      media.push({
        kind: 'sticker',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        subType: '1',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? ''),
        url: String(d.url ?? ''),
        summary: sanitizeMediaSummary(d.summary)
      });
    }
  }
  return media;
}
// @bridge-function extractMediaFromSegments:end

// @bridge-function allowed:start
function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}
// @bridge-function allowed:end

// @bridge-function canonicalV2Key:start
function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}
// @bridge-function canonicalV2Key:end
  return { createCappedLogger, localClock, log, withTimeout, segmentsToText, sanitizeMediaSummary, extractMediaFromSegments, allowed, canonicalV2Key };
}
