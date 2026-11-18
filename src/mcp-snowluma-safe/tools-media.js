// 媒体工具组：看图、TTS、表情包体系、语音、合并转发、发图与出图。
// 纯搬自 src/mcp-snowluma-safe.js（D60 拆分），函数体逐字保留，行为不变。
import { z } from 'zod';
import { serializeModelData } from '../qq-model-view.js';
import { imagegenReady } from '../imagegen-providers.js';
import {
  cfg, loadConfig, getConfig, getAccess, getOneBotConfig, isAllowed, unquoteJsonString,
  onebot, agentApiBase, readConsoleToken, errorText, agentApi, agentHeaders, agentApiLongPoll,
  authorizeRead, legacyReadToolAllowed, bootBridgeMode, registerLegacyReadTools,
} from './http.js';
import { guardMediaReply } from './media-reply-guard.js';

export function registerMediaTools(server) {
// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    '获取消息里的图片/表情（含 [图片]/[表情]/hasMedia 时调用）。动图会被抽帧拼成多格图（按格子顺序理解动作，别当九宫格照片）；超大图会缩放，看不到会写明原因。',
    {
      key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('会话令牌（reserved2 必填）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
// AI 黑名单说明：qq_send_tts 没有「引用/回复」语义——工具没有 replyToMessageId 参数，
// 桥接 /api/socialV2/tts 也不接收它（语音就是一条独立消息，不带引用）。所以这里没有
// 「回名单里的 AI」这条绕过面，不需要过 media-reply-guard；如果以后给它加了 replyTo，
// scripts/test-ai-blacklist-gate.mjs 的 tripwire（声明 replyToMessageId 的媒体工具必须过闸）会红。
if (cfg.socialV2?.tools?.tts !== false) {
  server.tool(
    'qq_send_tts',
    '把一段文字用 QQ 官方 AI 语音（甜美女声）合成后作为语音条发到指定会话。适合想用「声音」而不是文字回应的时候（撒娇、说晚安、念一句台词）。注意：一条语音就是一条消息，不能在同一气泡里附带文字；想同时说话请先另外发一条文本。',
    {
      key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
      token: z.string().describe('会话令牌（唤醒提示里有）'),
      text: z.string().describe('要朗读的文本（建议 30~80 字；上限由 socialV2.tts.maxChars 控制）'),
      voice: z.string().optional().describe('音色：元气少女（默认）/ 文艺少女 / 邻家小妹 / 傲娇少女 / 酥心御姐；也可以直接传 QQ 角色 id')
    },
    async ({ key, token, text, voice }) => {
      try {
        const data = await agentApi('/api/socialV2/tts', {
          method: 'POST',
          body: JSON.stringify({ key, token, text, voice }),
          headers: { 'x-agent-token': token },
          timeoutMs: 180000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `语音发送失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

  server.tool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
      token: z.string().describe('会话令牌（唤醒提示里有）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        // 强制同步走 POST：GET 上的 refresh 参数会让「读接口」产生写副作用
        // （真的去问 OneBot 拉收藏表情并落盘 state/stickers.json），
        // 从而绕开控制台对所有非 GET 请求的 CSRF 防护（一个 <img src=...> 就能触发）。
        const data = await agentApi('/api/socialV2/sticker-list', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, query: query ? String(query) : '', count, refresh: refresh === true, token })
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。动图表情会被抽帧拼成多格图（行优先：左上→右下），说明里会写帧数与网格尺寸；体积过大时会自动缩放，说明里会给出原始尺寸。',
    {
      key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
      token: z.string().describe('会话令牌（唤醒提示里有）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：${data.note ? '（' + data.note + '）' : ''}` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
      token: z.string().describe('会话令牌（唤醒提示里有）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const blocked = await guardMediaReply({ key, token, replyToMessageId, tool: 'qq_send_sticker' });
        if (blocked) return { content: [{ type: 'text', text: blocked.text }], isError: true };
        const data = await agentApi('/api/socialV2/send-sticker'
, {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
      token: z.string().describe('会话令牌（唤醒提示里有）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

}

export function registerAssetTools(server) {
// AI 黑名单说明：同 qq_send_tts——qq_send_voice 没有 replyToMessageId 参数，桥接
// /api/socialV2/send-voice 也不接收（sendVoiceForV2 只传 label/verify/readback/audio），
// 当前不存在「用语音回名单里的 AI」的入口，所以不过闸；加了 replyTo 时 tripwire 会红。
if (cfg.socialV2?.voice?.enabled !== false && cfg.socialV2?.tools?.sendVoice !== false) {
  server.tool(
    'qq_send_voice',
    '发语音库里的语音（voice 传 qq_list_voices 返回的 name）。只能发语音库文件，受时长/频率上限约束。返回 verified=true 才说明语音确实落地，才能对用户说发了语音；readback 对自发音无效，别依赖。',
    {
      key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
      token: z.string().describe('会话令牌（唤醒提示里有）'),
      voice: z.string().describe('语音库里的文件名（来自 qq_list_voices 的 name，可带子目录/可省略扩展名）'),
      label: z.string().optional().describe('可选：写进会话记录里的说明，如「说了句晚安」'),
      verify: z.boolean().optional().describe('是否回读校验语音已落地（默认 true，建议保持开启）'),
      readback: z.boolean().optional().describe('是否额外索取 QQ 转写文本（自己发的语音通常没有，默认 false）')
    },
    async ({ key, token, voice, label, verify, readback }) => {
      try {
        const data = await agentApi('/api/socialV2/send-voice', {
          method: 'POST',
          body: JSON.stringify({
            key,
            voice: String(voice),
            label: label || '',
            verify: verify !== false,
            readback: readback === true,
            token
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送语音失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_voices',
    '查看可用的语音库（qq-bridge 的 audio 目录里准备好的音频文件）：文件名、时长、大小。想发语音前先调用这个看有哪些能发（名字用返回的 name）。返回里 limits 是时长/体积/频率上限。语音库里没有合适内容时不要硬发，也不要假装发了语音。',
    {
      key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
      token: z.string().describe('会话令牌（唤醒提示里有）'),
      probe: z.boolean().optional().describe('是否逐个探测时长（默认 true；文件多时可传 false 加快）')
    },
    async ({ key, token, probe }) => {
      try {
        const q = new URLSearchParams({ key });
        if (probe === false) q.set('probe', '0');
        const data = await agentApi(`/api/socialV2/voices?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取语音库失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '查看你自己的默认 Q 版形象图片（DeepSeek 小鲸鱼形象）。当你被问“你长什么样/发张自拍/你是什么形象”时，可以调用这个工具看自己的样子；返回的图片会直接进入你的视觉上下文。',
    {
      key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
      token: z.string().describe('会话令牌（唤醒提示里有）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: '这是你的默认 Q 版形象：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
      token: z.string().describe('会话令牌（唤醒提示里有）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
      token: z.string().describe('会话令牌（唤醒提示里有）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
// 注：这里只有「查看」转发（只读）；目前不存在 qq_send_forward / qq_merge_forward
// 这类「发送合并转发」工具，所以也没有对应的黑名单回复绕过面。
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看合并转发消息内容。消息带 [转发消息 id=...] 或 forwardIds/hasForward 时调用。返回每条 text/media/nestedForwardIds；含图直接返回最多 5 张图，嵌套转发附 id 可继续查。',
    {
      key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
      token: z.string().describe('会话令牌（唤醒提示里有）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: serializeModelData(data) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.sendImage !== false && cfg.imagegen?.enabled !== false) {
  server.tool(
    'qq_send_image',
    '在指定会话发送一张图片（imageRef 传 http(s) 图片 URL 或 base64:// 开头的数据）。用于把 AI 生成或拿到的图片发到群/私聊。一条消息只能是一张图，不能附带文字；想说的话先 qq_send_message / qq_reply 单独发。需要引用/点名传 replyToMessageId / atUserId。',
    {
      key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
      token: z.string().describe('会话令牌（唤醒提示里有）'),
      imageRef: z.string().describe('图片地址：http(s) URL 或 base64:// 开头的数据'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号')
    },
    async ({ key, token, imageRef, replyToMessageId, atUserId }) => {
      try {
        const blocked = await guardMediaReply({ key, token, replyToMessageId, tool: 'qq_send_image' });
        if (blocked) return { content: [{ type: 'text', text: blocked.text }], isError: true };
        const data = await agentApi('/api/socialV2/send-image'
, {
          method: 'POST',
          body: JSON.stringify({ key, imageRef: String(imageRef), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// 两档都没 key 时**不注册** qq_draw：工具表里没有它，模型就不会以为自己会画，
// 被问到时按提示词的约定如实说「没有这个能力」（注册了再拒会诱导模型反复重试）。
if (cfg.socialV2?.tools?.draw !== false && cfg.imagegen?.enabled !== false && imagegenReady(cfg)) {
  server.tool(
    'qq_draw',
    '按提示词生成图片并发到指定会话。**调用前必须先问用户选哪档，不要直接生成**：两档都会带「AI生成」标注（法规要求）；免费档不限次数，高质量档画质更高、细节更好，但每个自然日只有 30 次。问法示例：「要免费档（带 AI生成标注、不限次）还是高质量档（同样有 AI生成标注、画质更好，今天还剩 N 次）？」用户没明确选之前**不要调用本工具**；用户说「随便/都行」时用免费档。拿到答复后把选择传进 tier 再调用。生成+发送较慢，失败会如实告知。',
    {
      key: z.string().describe('会话 key（group:群号 或 private:QQ号）'),
      token: z.string().describe('会话令牌（唤醒提示里有）'),
      prompt: z.string().describe('出图提示词（描述想要的画面，最多 500 字）'),
      tier: z.enum(['free', 'high']).describe('档位（必填，无默认值）：free=免费档（带 AI生成标注、不限次），high=高质量档（同样带 AI生成标注、画质更高，每天 30 次）。必须是你问过用户、按用户答复填的'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（可选）')
    },
    async ({ key, token, prompt, tier, replyToMessageId, atUserId }) => {
      try {
        const blocked = await guardMediaReply({ key, token, replyToMessageId, tool: 'qq_draw' });
        if (blocked) return { content: [{ type: 'text', text: blocked.text }], isError: true };
        const data = await agentApi('/api/socialV2/draw'
, {
          method: 'POST',
          body: JSON.stringify({ key, prompt: String(prompt), tier, replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `出图失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}
}
