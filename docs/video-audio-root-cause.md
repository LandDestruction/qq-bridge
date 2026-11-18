# 视频「没有声音」根因分析（2026-10-25，第四十八批）

## 结论

**主因是 (a)+(b) 的组合，不是 STT 坏：**

1. **(a) 分流漏了一半**：`seg.type==='video'` 与 `file` 段扩展名命中 mp4/mov/mkv/webm/avi 的，**代码里都会**生成
   `kind:'video-file'`（`src/bridge.js:1607-1641`）。但 22:42 那条 `10月23日.mp4` **同时**触发了转存跳过日志，
   说明它走的是 `file` 段；而 `file` 段的文件名取的是 `d.name ?? d.file`（`:1618`）——
   **只要 SnowLuma 这次只给了不透明 file id、没给 name，扩展名就判不出来**，于是既不进 video-file、
   也不进 image，最后被当作图片 URL 抓取。
2. **(b) enrich 与 prompt 竞态**：`src/bridge.js:12831` 是
   `for (const mv of safeMedia) if (mv?.kind === 'video-file') void enrichVideoFile(key, mv, msg);`
   —— **fire-and-forget**。抽帧 + 转写要 10~20s，而唤醒 prompt 常在 1~3s 内组装完成，
   于是这一轮拿到的是「还没有转写」的消息。这解释了「时好时坏」。
3. **(e) 上一轮残留帧的错觉**：`enrichVideoFile` 会把抽帧拼图 `msg.media.push({kind:'image', localFile:'video-frames/…'})`
   （`:2031`），这条 image 会留在会话的 recentMessages 里被后续 prompt 带上。用户看到的「画面帧」
   很可能是**上一轮 16s 视频留下的帧**，而不是 22:42 那条 mp4 的。本轮 mp4 从没有 `[video]` 日志，
   说明它根本没走到分析。

**不是 (c)/(d)**：`extractAudioWav`/`transcribeWav` 你已实测可用；本次日志里也没有任何转写失败。

## 证据

```
22:42:08  转存跳过（group:100000001）：10月23日.mp4 —— 类型不在转存白名单（.mp4）
22:42:28  [media] 图片获取失败（1 次尝试）：https://njc-download.ftn.qq.com/...: 抓取内容不是有效图片
```
- 当天 `[video]` 只有 `22:25:40 … 16s 有语音` 一条 → **22:42 的 mp4 没进 enrichVideoFile**。
- `[media] 图片获取失败` 的产生点：`src/bridge.js:10169`，由 `resolveMediaList`（`:10321`）
  的 else 分支调 `fetchOneBotImage(media)` 触发；而 `fetchOneBotImage` 对非图片内容会走
  `safe-fetch.js:720` 抛「抓取内容不是有效图片」。**这就是「mp4 被当图片抓」的调用链**。

## 本次修复（commit 37bf88b）

1. `resolveMediaList` 在进入图片分支**之前**拦掉 `kind === 'video-file'`：
   - 已 enrich 完 → 塞 `[视频：<摘要>]`
   - 未完成 → 塞 `[视频：本轮的抽帧/语音转写还没完成，先按无转写处理，不要臆测声音内容]`
   —— 让模型明确知道「没有转写」，而不是假装听到。
2. `enrichVideoFile` 完成时写 `media.enrichedAt` + `media.summary`（供上面判定 done），
   并在没拿到转写时打 `[video] … 未拿到转写（音频提取失败或视频无声），本条只带画面`。
3. 静态断言：`scripts/test-tts-ext.mjs` 断言 video-file 分支必须在 `fetchOneBotImage` 之前。

## 仍是缺口（需要你决策/下一轮）

- **(a) 的根修**：`file` 段扩展名判定只看 `d.name ?? d.file`。建议扩展为依次尝试
  `d.name / d.file_name / d.file / d.url 的路径末段`，任一命中扩展名即认。**这属于分流逻辑，
  我未擅自改**（怕和 C 的 file 段改动冲突），可下一轮做。
- **(b) 的选择**：
  - 方案 A：enrich 改成「本轮等待 ≤20s」——用户能立刻听到转写，但慢视频会把回复拖到 20s；
  - 方案 B（我倾向）：保持异步，但**首轮明确告知模型「转写未完成」**（本次已实现），
    下一轮唤醒时若 enrich 完成，摘要已回填，模型自然能引用。

## 追加（第四十八批补充线索后）

### 精确时间线（审阅窗口复核）
```
22:42:08  用户 @机器人 + [引用 我是狗妈老公：[文件10月23日.mp4]]，本体也是 file 段
         转存跳过（.mp4 不在白名单）
22:42:14  控制台重启桥接（审阅窗口，为验证 malformed 修复）
22:42:27  同一消息再走一次归档判定
22:42:28  [media] 图片获取失败（1 次尝试）：…ftn_handler/6085… 抓取内容不是有效图片
22:42:36  [视觉] 本轮含图 → 切 deepseek-flash
22:42:40  机器人回「我收不到声音呀，只能看到画面帧」
22:43:13  再次重启（审阅窗口）
```
→ 重启确实打断了这一轮，但**不能解释 22:42:28 那条**：重启后它仍然把 mp4 当图片抓。

### 真正的调用点：引用里的媒体
`src/bridge.js:14383-14388`（引用附件旁路）：
```js
for (let i = 0; i < (quoted?.media?.length ?? 0); i += 1) {
  const media = quoted.media[i];
  const fetched = await fetchOneBotImage(media).catch(() => null);   // ← 无类型判定
  ...
}
```
这条路径**完全没有按扩展名分流**，所以引用的 mp4 直接进了 `fetchOneBotImage` →
`safeFetchBuffer`（只接受图片魔数）→ 「抓取内容不是有效图片」。

### 本次修复（commit 见交接）
1. 新增 `src/attachment-classify.js`：`classifyAttachment({segType,name,fileName,file,url})` +
   `extOf()` —— 把 name / file_name / file / url 全部试一遍；
2. `file` 段改用该函数（修掉「只看 d.name」的漏判）；
3. **引用里的媒体**：视频直接跳过并记 `引用里的视频未做抽帧/转写` + archiveFact `skipped`；
4. `fetchOneBotImage` 加防御：`media.kind === 'video-file'` 直接返回 null 并记日志；
5. 单测 `scripts/test-attachment-classify.mjs`（9 条）+ `test-tts-ext` 三条静态断言。

## 追加（第四十八/四十九批的 (b) 修复：有限等待）

原实现是 `void enrichVideoFile(...)` 纯 fire-and-forget；现在：

1. `appendSocialV2Message` 把每个视频任务登记进 `pendingVideoEnrich`（按会话 key）；
2. **`processPromptQueue` 在组装 prompt 之前** `await raceWithTimeout([...pending], 20000)`；
3. 日志：`[video] <key> 等待抽帧/转写 NNNms → 完成/超时（按未完成继续）`；
4. 超时后的说明仍是「抽帧/语音转写还没完成，不要臆测声音内容」。

工具模块：`src/async-wait.js` 的 `raceWithTimeout`（纯逻辑，`scripts/test-async-wait.mjs` 4/4）。
静态断言：`scripts/test-tts-ext.mjs` 断言 `processPromptQueue` 里存在 `raceWithTimeout([...pending], 20000)`。
