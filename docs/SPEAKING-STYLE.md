# 发言风格：群成员，不是客服

2026-11-12。群友反馈两件事：机器人**很吵**、说话**很像客服**。
「吵」由 [QUIET-WATCH.md](QUIET-WATCH.md) 解决（少唤醒）；这里解决「人机感」。

## 一句话

把身份从「负责回复的人」改成「可以插话、也可以不说话的群成员」。接住一个点就停，不必让每一轮都圆满。

## 落点

| 位置 | 作用 |
| --- | --- |
| `src/bridge/speaking-style.js` | 风格块正文：身份、9 条参与规则、3 组完整片段示范、不发言时的收尾写法 |
| `src/bridge/wake-prompts.js`（`proactiveLine`） | 旧文案「不要习惯性潜水，主动参与」→ 换成风格块（这句每轮都进 prompt，是硬憋一句的根因之一） |
| `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` | 预设里同义的那句「没被叫但有话题也主动参与」改成「只接你有把握的一句，接不上就安静看」；去掉「只发草/难绷也比硬接强」的口头禅示范 |
| `src/bridge/config-load.js` | `socialV2.style` 默认 `{enabled:true, examples:true, brevity:true}`；上下文窗口 `wakeMessageLimit 12→24`、`wakeRecentLimit 4→12`、`wakeMaxChars 6000→9000` |

## 为什么「不说话」不需要特殊 token

二代模式里**模型的文本输出不会自动发到 QQ**，发言必须调发送工具（`qq_send_message` / `qq_reply`）。
所以「不说话」= 不调任何发送工具 + `qq_mark_read` 收尾。风格块里把这条路写明，否则模型会以为「没输出内容」等于没完成任务，于是硬憋一句。

不建议引入 `<SKIP>` 这类标记：它要求在一个「本来就不会自动发送」的通道里再显式表态，多一层解析、多一种失败模式，收益为零。

## 配置

```jsonc
"socialV2": {
  "style": {
    "enabled": true,     // false = 回到旧文案（不建议，会继续硬接）
    "examples": true,    // false = 只留规则，省约 200 字
    "brevity": false     // false = 不写「不想说话怎么写」那段
  }
}
```

改完热加载即可（`cfg.socialV2.style` 每次拼 prompt 时读）。

## 边界

- 被 @、被直接提问：仍然必须回（这一条没动）。
- 认真求助：必须正常回答，不为了人设装傻。
- 熟悉感只能来自聊天记录，不许编共同经历——这条在 `attributionDisciplineTextV2` 之外又强调了一次，因为它是「像人」和「像骗子」的分界。
- 例子是**通用片段**，不是本群真实记录：要换成自己群的风格，就把 `socialV2.style.examples` 关掉，改 `speaking-style.js` 的 `EXAMPLES` 常量（记得脱敏）。

## 验证

```bash
node --test scripts/test-speaking-style.mjs        # 7 例
node scripts/test-prompt-parity.mjs                # prompt 段落顺序
node scripts/test-token-economy.mjs                # prompt 预算
node scripts/boot-smoke.mjs --seconds 25           # 装配冒烟（不发消息）
```

生效需要重启桥接（模块在进程内加载）。
