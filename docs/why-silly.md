# 为什么显得笨：成因排序与最小改法（M5 合稿）

> 2026-10-27 00:0x，W1 汇总。上游证据：`docs/why-silly-local.md`（D21，w3，本地量化）与
> `docs/why-silly-upstream-diff.md`（D22，w4，上游 `Derpyu520/qq-bridge@a49877f` 对照）。
> 规格：`default-workspace\M5-why-silly-spec.md`。**本文件只出诊断与改法，不改任何东西。**

## 0. 一句话

不是"模型笨"，是三件事叠一起：**人格不在上下文里（唤醒提示只有 40 字符角色名）**、
**推理强度比上游低一档（high vs max）**、**每次唤醒先背 46k 字符固定开销（系统 13.5k + 工具 schema 33k）而聊天现场只占 3.9k（8.4%）**。
"短、木、不接梗"（中位 20 字、上限 39 字、问句 0%、想 28 字才说 1 字）是这三件事的**症状**，不是模型能力上限。

## 1. Top 5 成因（按「影响大 / 改得便宜 / 可回退」排）

| # | 成因 | 硬证据 | 最小改法 | 归谁 |
|---|---|---|---|---|
| 1 | **人格正文根本不在提示里**，提示只有 40 字符「角色名」；只有她主动调 `qq_get_prompt` 那轮才把 1,378 字符角色卡读进来 | `why-silly-local.md` §1.1/§1.4（`src/bridge.js:14295`、`qq_get_prompt` 结果 9,397 字符） | 唤醒提示里补一段**固定人格摘要（200–400 字）**，或每轮注入角色卡前 600 字；不动模型、不动阈值 | 需改 `src/bridge.js` 的 promptParts 装配 → 有代码改动，可回退 |
| 2 | **推理强度 high，上游默认 max** | `why-silly-upstream-diff.md` §1.2（README L83 明写默认 max） | `config.dsh.reasoningEffort` 改 `"max"`（一行） | 用户拍板（贵一点/慢一点） |
| 3 | **工具面 37 vs 上游 28**，47 个 schema 占 32,918 字符，是唤醒提示的 8.4 倍 | `why-silly-local.md` §1.2 表格；`why-silly-upstream-diff.md` §1.2 工具差异 | `socialV2.tools` 关掉本轮不用的（候选：`draw`/`tts`/`sendVoice`/`stickerAutoDescribe` 按需开） | 用户拍板（功能会少） |
| 4 | **"反骨"口径被本地反向收紧**：上游把人设底色写成"可以装傻/已读乱回/给离谱答案"，本地新增【什么时候不反骨】把它压成"只在被逗时许可" | `why-silly-upstream-diff.md` §3.1（段落原文对照，483+294 字符） | 折中版：保留"认真提问别抬杠"（这是 22:5x 语气修复的成果，别回滚回去），但**允许对玩梗/招呼/闲聊用"打岔、装没懂、离谱但好笑"的答法** | 用户拍板（语气会变，和 T8 语气验收同一件事） |
| 5 | **默认档走中转池**：`idle=workbuddy2api/deepseek-v4.1-flash`，200 条采样里 181 条（90.5%）跑它；`modelFallbacks` 前两位也是中转 | `why-silly-local.md` §三；`why-silly-upstream-diff.md` §1.2 | 把 `modelRouting.idle` 换成 `deepseek-account/deepseek-flash`（与 media 档一致），或把官方档提到 fallback 第一位 | 用户拍板（成本/稳定性权衡） |

**附加（不算 Top5，但会加重"忘了刚说过的"）**：本地独有的 `socialV2.sessionRecycle`（600 条 / 48h）上游没有；
`buildDigest` 是启发式压缩、不调模型，且今晚实测 `digests` 0 条（T12 修好了落盘，但要重启后再收满 20 条才生成）。
→ 短期别再叠加"记忆类"改动，先让 T12 跑起来观察。

## 2. 每条怎么验（都可量化，不靠感觉）

| 指标 | 现在 | 从哪取 | 期望方向 |
|---|---|---|---|
| 机器人发言字数中位 / 上限 | 20 / 39 | `state/social-v2.json` 的 `isSelf` 最近 50 条 | 中位 25–35，上限别卡 40 |
| 问句占比 | **0%** | 同上（含"？"或疑问词） | ≥10%（会反问才像聊天） |
| 想/说比（reasoning : output） | **28.4 : 1** | DSH 会话日志 `session.v4.jsonl.zstd` | ≤ 10:1 |
| 唤醒提示各族字符数 | 3,898（sticker 1,216 / memory 831） | `GET /api/debug/prompt-parts` | 人格段 >0 |
| 固定开销 vs 对话占比 | 46,440 : 3,898 = 8.4% | 会话日志 system/message + request/header | 对话占比 >15% |
| 模型分布 | 90.5% 中转池 | `state/token-usage.jsonl` 最近 200 条 | 官方池占多数 |
| 近重复率 | 0 | `state/social-v2.json` | 保持 0（这条没病） |

## 3. 建议的改动顺序（一次只动一件，每件可单独回滚）

1. **先做 #2（reasoningEffort max）**：一行配置、影响面最干净；观察 3 小时（想/说比、字数中位）。
2. **再做 #1（人格摘要进提示）**：代码改动小、立刻能看出"像不像人"；改完用 `prompt-parts` 确认人格段 >0。
3. **然后 #3（关工具）**：每关一个记一次固定开销，看对话占比。
4. **#4（反骨口径）与 T8 语气验收合并做**：一次调、一次验，别两头改。
5. **#5（模型链路）最后**：涉及钱与稳定性，且它解释不了"0 问句、20 字"这种形态。

## 4. 必须先纠正的两个误解

- **"本地把触发/上下文改保守了"不成立**：`socialV2.wake.*`、`context.*`、`send.*` 共 27 项与上游**完全一致**；
  动它们属于"改上游默认值"，不是"回滚本地改动"（`why-silly-upstream-diff.md` §1.1）。
- **"人格被截断"不成立**：`initial-prompt` 文件不存在、角色卡 1,379 字符 << 6,000 上限、实测没有一次截断；
  真正的问题是人设**没进提示**，不是被切（`why-silly-local.md` §四）。

## 5. 不做（防跑偏）

- 不为了"显得聪明"把今晚刚修好的语气回滚成"对认真提问也抬杠"——那是另一个投诉（T8）。
- 不改 `MAIN-STATE.md` / `MAIN-HANDOFF.md`。
- 不动 `preSleepWaitMs` 这类"故意等待"参数来换"更快的错觉"——302.7s 的 wait 是设计，不是故障。
- 不在群里发实验消息；要发先报主窗口。

## 6. 复现

```powershell
# 本地量化（只读）
node <本机路径>\w1\scripts\probe-cross-session.mjs          # 记忆现状
curl.exe -H "x-console-token: <token>" http://127.0.0.1:3100/api/debug/prompt-parts
# 上游对照
git -C <本机路径>\_upstream-qq-bridge log --oneline -1
```
