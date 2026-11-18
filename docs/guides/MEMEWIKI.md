# 梗百科（dsh-memewiki 词库）

机器人内置 6668 条网络梗/黑话词条，来自 [thawline/dsh-memewiki](https://github.com/thawline/dsh-memewiki)（MIT；词库数据版权归原作者与 cnmeme.wiki）。**纯本地只读，不联网**。

## 它解决什么

群里冒出生梗，模型以前要么当没看见、要么编一个像模像样的解释。现在：

1. 唤醒提示词里固定有一段【梗百科】：遇到听不懂的梗/黑话/缩写，先调 `qq_meme_lookup(query)`。
2. 工具查到就返回「释义 / 怎么用 / 出处 / 标签」的精简条目（释义截 220 字，用法截 160 字）。
3. 查不到就明确说「词库没有，别编」，模型直接说不知道。

## 接线点

| 位置 | 文件 | 说明 |
|---|---|---|
| 词库查询 | `src/memewiki.js` | `lookupMeme` 精确 → 标题包含 → 长句切 4~6 字片段；库缺失时静默降级为 null |
| MCP 工具 | `src/mcp-snowluma-safe/tools-memory.js` | `qq_meme_lookup`，只读本地库，不走网络 |
| 提示词 | `src/bridge/wake-prompts.js` | `memeWikiHintLine()`，promptParts 里的 `memeWiki` 段 |
| 词库文件 | `data/memewiki.db` | 16MB SQLite，表 `memes(title,slug,tags,usage,origin,other,summary,aliases)` |

## A 方案：预查注入（2026-11-02 上线）

不等模型主动调工具：唤醒前由桥接判断「最新一条别人的消息是不是在问梗」，命中就查一次本地库，把结果塞进提示词。

- 判定：`looksLikeMemeQuestion()`（问梗句式 / 「XX 是什么」「XX 什么梗」这类）
- 命中：注入 `【梗百科·命中】有人问了「X」/ 词条 / 释义（截 180 字）/ 怎么接（截 120 字）` + 「别把原文背出来、对不上别硬套」
- 没查到：注入 `【梗百科】有人问了「X」，本地 6668 条没查到。不要编解释…`
- 实现：`src/memewiki.js` 的 `prelookupLine(messages, selfId)`；`src/bridge/wake-dispatch.js` 在每次唤醒前写 `st.memeWikiLine`；`src/bridge/wake-prompts.js` 的 `memeWiki` 段拼上去
- 关闭：把 `socialV2.memeWiki.prelookup` 设为 `false`（可选开关，默认开）

## 维护

- 更新词库：`node scripts/fetch-memewiki.mjs`（从 GitHub raw 拉最新 `data/memes.db`，校验 SQLite 头与条数后覆盖 `data/memewiki.db`）。
- 词条想改：直接改 `data/memewiki.db`（只读打开，不影响运行），或用 sqlite 工具写；改完无需重启（下次查询生效）。
- 词库缺失时：`qq_meme_lookup` 回「本地梗库没有…」，提示词段仍在（不会报错）。

## 与「黑话」的区别

- **黑话**（`state/slang.json`）：本群自建的、经管理员确认的词条，权重最高，可带「玩梗尺度」。
- **梗百科**：通用网络梗库，只读参考；两者都查不到时才说不知道。

## 已知限制

- 词库是 2026-10-26 的快照，新梗可能没有。
- 反向匹配是切片段 LIKE，不是语义搜索；生僻词可能漏。
- 没有图片卡片（原 AstrBot 版的 `/梗` 出图未移植）。
