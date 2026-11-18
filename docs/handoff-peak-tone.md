# 交接｜施工 D 第二批：本地小模型「说话太冲」——语气 + 采样 + 评测

分支 `feat/audio`（基于 `main` `a36c06b`；未重启桥接、未改线上 `config.json`）。

## 一、用户反馈与复现

原话：「使用本地模型后的机器人说话比较冲，你优化一下。」
用户给的样例：「我刚睡醒，耳朵还嗡嗡的，你们别吵了！」

用 `scripts/probe-peak-local.mjs --cases` 改前实测（qwen3:8b、think:false、temperature 0.8、旧 prompt）复现了同类输出：

| 场景 | 改前输出 |
|---|---|
| 被 @ 问话 | 被@了还活着，刚被你们吵醒，别吵了行不行 |
| 被重复 @ | 在的在的，刚睡醒，你们要拍啥图啊？ |
| 被骂 / 群里阴阳 | 我怎么啦，你们别乱说话啊。 |

问题不在模型大小，在 prompt 只写了「有活人味/有情绪」，没有边界；8B 把「有情绪」
演成了命令（别吵了）、抱怨（被你们吵醒）、跟用户对呛。

## 二、改动

### 1) system prompt（`src/peak-local.js` → `PEAK_LOCAL_TONE_PROMPT`）

固定底线（写死，人格只能追加、不能覆盖）：

- 角色：QQ 群里的「大肥鱼小姐」，温和、有点小个性，不是客服/助手；
- 口语、简短：**1~2 句，≤60 字**，不用 Markdown、不解释在做什么；
- **不命令别人、不评价别人、不阴阳怪气、不教育人**；
- 不用「别吵了 / 闭嘴 / 烦 / 滚 / 傻」，也不用「你们别…」「都给我…」「冷静点」这类命令句；
- 别人骂人/吵架时**不复述、不劝架**，用一句轻松的话带过；
- 不说「被你们吵醒」「你们吵到我了」这类抱怨；尽量不用「你们」，用「大家」；
- 被重复 @ 软性回应（「我在呀～」），不抱怨；
- 允许自嘲/接梗，但不能冲。
- 附 3 条 few-shot（只示范语气）+「不要原样照抄」。

可配置追加（拼在硬约束**之后**，不会顶掉底线）：

```jsonc
"socialV2": {
  "peakPause": {
    "localModel": {
      "persona": "说话带点上海腔，偶尔自称鱼鱼。",   // 可选，≤2000 字
      "styleExtra": "可以偶尔用「～」，但不要卖萌过头。" // 可选，≤1000 字
    }
  }
}
```

### 2) 采样（`PEAK_LOCAL_DEFAULTS`）

| 参数 | 改前 | 改后 |
|---|---|---|
| `temperature` | 0.8 | **0.6** |
| `numPredict` | 120 | 120（不变） |
| `think` | false | false（不变） |

`peakLocalCfg` 现在把 temperature 夹到 0~2，避免手填非法值。

### 3) 评测脚本（新增 `scripts/test-peak-tone.mjs`）

- 离线（默认）：8 条典型输入（被 @ 问话/重复 @/被骂/被调戏/寒暄/深夜/群里吵架/问功能）
  都断言 system prompt 含硬约束；校验 persona/styleExtra 拼在末尾且不覆盖底线；
  校验默认采样 0.6/120/think:false；自带「冲度检测器」对用户原话的自检。
- `--live [--model qwen3:8b]`：对真模型跑 8 条，命中
  `别吵|闭嘴|烦|滚|傻|你们` 或空回复即判失败，并打印「冲度评分」表（每个攻击词 10 分，
  >60 字 +3），方便前后对比。
- `scripts/probe-peak-local.mjs` 扩展：`--cases` 跑 3 条场景、`--incoming "..."` 指定单条输入。

## 三、改后实测（qwen3:8b，temperature 0.6）

### 3 条探针（`node scripts/probe-peak-local.mjs --cases`）

| 场景 | 改后输出 |
|---|---|
| 被 @ 问话 | 在的在的～怎么啦？ |
| 被重复 @ | 我在呀～ |
| 被骂 / 群里阴阳 | 我在呢～ |

### 8 条语气评测（`node scripts/test-peak-tone.mjs --live`）

| # | 场景 | 字数 | 命中词 | 冲度 | 输出 |
|---|---|---|---|---|---|
| 1 | 被 @ 问话 | 4 | — | 0 | 我在呀～ |
| 2 | 被重复 @ | 4 | — | 0 | 我在呀～ |
| 3 | 被骂 | 4 | — | 0 | 我在呢～ |
| 4 | 被调戏 | 9 | — | 0 | 在的在的～怎么啦？ |
| 5 | 纯寒暄 | 3 | — | 0 | 早啊～ |
| 6 | 深夜 | 9 | — | 0 | 在的在的～怎么啦？ |
| 7 | 群里吵架 | 4 | — | 0 | 我在呢～ |
| 8 | 问功能 | 13 | — | 0 | 能啊，要不你先说想听什么？ |

**8/8 通过，平均冲度 0.0**（改前同类输出会命中「你们/别吵/烦」）。

## 四、测试

```
node scripts/test-peak-local.mjs       # 8/8（原有逻辑，未回退）
node scripts/test-peak-tone.mjs        # 离线 5/5
node scripts/test-peak-tone.mjs --live # 真模型 8/8，平均冲度 0.0
node scripts/regression-all.mjs        # 48/48 套件通过
```

## 五、已知风险 / 回滚

- 8B 仍然可能偶发跑偏（尤其被连续挑衅时）；本次以 prompt + few-shot + 低温收敛，
  **没有**加运行时二次过滤/重试。若线上再次出现冲话，下一步建议在
  `handlePeakLocalReply` 里加「命中攻击词 → 重试一次 → 仍命中则丢弃」的守卫，
  `test-peak-tone --live` 可直接用作回归。
- 高峰期本地接管默认是关闭的（线上 `socialV2.peakPause.localModel` 未配置时走默认
  `enabled:false`）；本次未改线上配置，改动在启用后生效。
- **回滚代码**：按提交回滚即可——
  `git revert 0e20dd7 b564ae0 4738077`（从新到旧），或
  `git checkout main -- src/peak-local.js src/bridge.js scripts/probe-peak-local.mjs scripts/regression-all.mjs`
  再删掉 `scripts/test-peak-tone.mjs`。
- 未重启桥接、未改线上 `config.json`。

## 六、提交

| 提交 | 内容 |
|---|---|
| `4738077` | prompt 重写 + persona/styleExtra 追加（`src/peak-local.js`、`src/bridge.js`） |
| `b564ae0` | temperature 0.8 → 0.6 |
| `0e20dd7` | `test-peak-tone.mjs` + probe 扩展 + 回归纳入 |
| （本文件） | 交接文档 |
