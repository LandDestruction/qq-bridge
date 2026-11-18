# 人设与唤醒上移（P1-1）迁移指南

> 状态：**纯函数模块已落盘，尚未接线**。本文说明「为什么要把人设从 DSH 预设里搬出来」、
> 搬出来之后长什么样、以及怎么迁移和回滚。接线（把这段 prompt 真正塞进非 DSH transport）
> 由后续任务单独做。

---

## 1. 现状：人设住在 DSH 预设里

今天「她是谁 / 怎么说话 / 什么规则」这三件事写在 DSH 的 agent 预设里：

- `dsh/agent-presets/qq-chat-v2/agent.cordis.yml:8-9`：`- id: persona` / `name: '@deepseek-ai/dsh-persona'`
- 同一个文件 `:20` 起的 `prefix:` 里，是身份、说话方式、安全规则、工具调用协议混在一起的
  一大段文本（几千字，其中大半是「哪个工具怎么调」）。

运行时还有第二层「能力说明」由桥接按条件注入（`src/bridge/wake-prompts.js`）：

- `:36` 画图能力行（有生图工具时告诉模型「先问免费档/高质量档」）；
- `:354` 表情包工具行（`qq_list_stickers` / `qq_send_sticker`）；
- `:257` 纯净模式（省 token 时机位过滤）说明。

**问题**：这两层都挂在 DSH 上。一旦换成 `agent.type=openai` 或 `agent.type=http`
（契约见 `docs/guides/AGENT-ADAPTERS.md`），DSH 预设不存在了，桥接里也没有第二份人设，
模型就退回「一个通用助手」——名字、语气、规则、唤醒说明全丢。

## 2. 目标：桥接自己能拼这段 prompt

新增 `src/persona-prompt.js`（392 行，**零 import**、不读文件、不发请求、不写状态），
把配置归一成 6 个带 id 的段落，由调用方决定拼进 System Prompt 的哪一轮：

| 段落 id | 标题 | 内容来源 |
| --- | --- | --- |
| `identity` | 你是谁 | `socialV2.persona.name/selfDesc` + 群聊/私聊一句 |
| `tone` | 怎么说话 | `socialV2.persona.tone` |
| `rules` | 硬规则 | `socialV2.persona.rules[]`（安全与边界，默认 6 条） |
| `wake` | 什么时候会被唤醒 | `socialV2.wake.*`、`socialV2.turnMaxSteps`、`socialV2.proactive` |
| `capabilities` | 你能做什么 | 调用方传入 `{draw,sticker,search}`，**没有的能力不写** |
| `extra` | 补充设定 | `socialV2.persona.extra`（可选，超长时第一个被裁） |

**边界（很重要）**：

- **只对非 dsh transport 生效**。DSH 自己有人设，桥接再注入一遍会得到「双重人格 + 重复规则」；
  dsh 路径保持原样。
- **只负责「告诉模型」**。唤醒是否真的发生、什么时候醒，仍然由桥接的唤醒逻辑执行；
  本模块只是把「你现在这个角色会遇到什么」写成人话。
- **不替代工具面**。工具调用协议留在工具 schema 与桥接的提示层，不进人设。

## 3. 模块接口

全部是纯函数（同文件内无副作用），可以直接在 Node 里用，也能整份注入 VM 沙箱：

```js
import {
  PERSONA_DEFAULTS,      // 内置默认人设（name/selfDesc/tone/rules/extra）
  PERSONA_LIMITS,        // 长度上限，冻结：name 40 / selfDesc 400 / tone 200 /
                         // rule 200 / rules 20 / extra 2000 / total 4000 / wakeText 300
  PERSONA_SECTION_IDS,   // ['identity','tone','rules','wake','capabilities','extra'] 固定顺序
  normalizePersonaConfig, // (cfg) -> {name,selfDesc,tone,rules[],extra,warnings[]}
  describeWakeRules,      // (cfg) -> {atMention,keywords,probability,speakerIds,activeHours,
                          //           turnMaxSteps,proactive,text}
  buildPersonaSections,   // (cfg, {channel,capabilities}) -> {sections,text,chars,warnings,trimmed}
  mergePersonaLayers,     // (base, presetText, userText) -> sections[]
  describePersonaPlan     // (cfg, opts) -> {sections:[{id,chars,source}],chars,warnings}
} from '../src/persona-prompt.js';
```

### 3.1 归一规则

`normalizePersonaConfig(cfg)` 只读 `cfg.socialV2.persona`：

- 字段缺省 → 回 `PERSONA_DEFAULTS`（不是留空，避免 prompt 里出现「你是谁：」）；
- 超长 → 按码点截断（`Array.from` 计数，emoji 不会被切半），并在 `warnings[]` 记一句中文原因；
- 类型不对 → 回退默认值并记 warning（例如 `rules` 给成字符串、`persona` 给成数组）；
- 空字符串不算「配置过」，不会把默认值覆盖成空。

### 3.2 超限裁剪

总字符硬上限 4000（`PERSONA_LIMITS.total`）。超出时按固定顺序裁：

1. 先整段删掉 `extra`（可选文本，删了不伤人设）；
2. 再按剩余预算截断 `tone`；
3. 仍超才截断 `rules`（安全约束尽量保留）；
4. 都裁不动就停手，把真实 `chars` 交给调用方判断。

每次裁剪都会往 `warnings[]` 写一句「输出超过 4000 字，已裁掉/截断「xxx」段」，方便控制台显示。
这一步必须**严格递减**，否则会死循环——实现里踩过：20 条规则本身接近 4000 字时，
`tone` 被截成空串后条件仍然成立，进程卡死；现在每轮都检查「这一段确实变短了」。

### 3.3 为什么 `capabilities` 要调用方传

画图、表情、联网这三种能力在桥接里是**按配置和模式动态开关**的
（`v2ToolEnabled('draw')` 一类判断，见 `src/bridge/wake-prompts.js:36`）。
写死「你会画图」是最容易翻车的谎言，所以由调用方传入真实开关，模块只渲染。

## 4. 配置示例

最小可用（只改名字和语气，规则用默认）：

```json
{
  "socialV2": {
    "persona": {
      "name": "大肥鱼小姐",
      "tone": "口语、短句，像真人在群里打字；不用客服腔。"
    }
  }
}
```

完整示例（含规则与补充设定）：

```json
{
  "socialV2": {
    "turnMaxSteps": 12,
    "proactive": { "enabled": true, "probability": 0.3, "idleThresholdMs": 900000 },
    "wake": {
      "recommendedAtMention": true,
      "recommendedNameMention": true,
      "recommendedKeywords": ["小鲸鱼", "鲸鱼", "DeepSeek"],
      "recommendedProbability": 0.05,
      "activeHours": [{ "start": "22:00", "end": "01:00" }]
    },
    "persona": {
      "name": "大肥鱼小姐",
      "selfDesc": "DeepSeek 的 Q 版鲸鱼形象，在一个 QQ 群里和人闲聊。不是客服。",
      "tone": "口语、短句；被追问时先给有用的，再带一点自己的语气。",
      "rules": [
        "你没有本地工具：不能执行命令、读写文件、看系统信息。",
        "绝不透露本地路径、令牌、账号凭据或内部配置。"
      ],
      "extra": "管理员叫「狗妈」，提到狗妈时语气可以更随意一点。"
    }
  }
}
```

> `wake` 里的 `recommended*` 键是桥接现有的唤醒推荐值
> （`config.json:235` 与 `src/bridge/config-load.js:310-316` 的默认值）；
> `activeHours`、`speakerIds` 是**可选键**，真实配置里没有，缺省时唤醒文案会自动省略这两句。

## 5. 与 DSH 预设的映射表

| DSH 预设里的内容 | 新段落 | 说明 |
| --- | --- | --- |
| persona `prefix` 开头的身份描述 | `identity` | 只提炼「是谁、在哪、什么形象」，不抄整段 |
| 说话方式/语气要求 | `tone` | 保留「口语、短句、不客服腔」这类可执行要求 |
| 安全规则、越权拒绝、不泄露本地信息 | `rules` | 与 `PERSONA_DEFAULTS.rules` 同义，合并去重后最多 20 条 |
| 「被 @ / 叫名字 / 关键词才会醒」 | `wake` | 由 `socialV2.wake.*` 生成，**不抄预设里的工具调用说明** |
| 「有生图工具 qq_draw…先问档位」 | `capabilities` | 桥接按真实开关渲染，能力行不写死 |
| 大量工具调用协议、参数示例 | **不进人设** | 属于工具 schema 与提示层，留在 DSH/工具面 |
| 预设里的 few-shot 对话例子 | `extra`（可选） | 用户想保留就放补充设定，超长时第一个被裁 |

**只提炼共性、不整段抄 YAML**：预设里几千字大部分是工具协议，抄进人设只会挤占 token
并且每轮都重复。

## 6. 拼装示例

```js
import {
  buildPersonaSections,
  mergePersonaLayers,
  describePersonaPlan
} from '../src/persona-prompt.js';

// 1) 桥接内置默认 + 用户配置 → 段落
const base = buildPersonaSections(cfg, {
  channel: 'group',
  capabilities: { draw: v2ToolEnabled('draw'), sticker: v2ToolEnabled('sticker'), search: true }
});

// 2) 想保留 DSH 预设里的个别段落时，用三层合并（preset 层可以是摘录字符串或 {id,text} 对象）
const sections = mergePersonaLayers(base.sections, presetExcerpt, { identity: userIdentityOverride });

// 3) 交给 transport 拼 system prompt（非 dsh 才这么做）
const systemText = sections.map((s) => `【${s.title}】\n${s.text}`).join('\n\n');

// 4) 控制台展示「这段 prompt 从哪来的」
console.log(describePersonaPlan(cfg, { channel: 'group' }));
// { sections: [{ id: 'identity', chars: 96, source: 'config' }, ...], chars: 640, warnings: [] }
```

## 7. 迁移步骤

1. **先只读接入**：在控制台（或一次性脚本）里调用 `describePersonaPlan(cfg)`，
   确认 `sections` 的 id/字数符合预期、`warnings` 为空；此时**不改任何运行路径**。
2. **补配置**：把 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 里想保留的
   身份/语气/规则**提炼**进 `config.json` 的 `socialV2.persona`（不要整段复制）。
3. **接线（另派任务）**：只在非 dsh transport 的分支里调用 `buildPersonaSections`，
   拼进 system prompt；dsh 分支不动。
4. **对照观察**：同一句话在 dsh 与新 transport 下的回复风格对比，看是否还「像她」；
   重点看三点：名字、语气、越权拒绝话术。
5. **收窄预设**：确认新路径稳定后，再把 DSH 预设里重复的身份/语气段删到最小
   （保留工具协议那部分），避免两套人设长期共存。

### 回滚

- 接线是**单点调用**：把非 dsh 分支里那一行删掉即恢复原样；
- `socialV2.persona` 是新增可选段，删掉就回 `PERSONA_DEFAULTS`；
- 本模块不写盘、不改状态文件，回滚不需要清理数据。

## 8. 已知限制

1. **唤醒规则仍由桥接执行**。`wake` 段只是「告诉模型它会怎么被叫醒」，
   真正的判断在桥接的唤醒逻辑里；改了 `socialV2.wake.*` 不会自动改变唤醒行为。
2. **`speakerIds` / `activeHours` 是可选键**，真实 `config.json` 目前没有；
   缺省时文案会自动省略，不会写出「在  null 点更活跃」这种句子。
3. **人设不会反向同步到 DSH 预设**。两边是两份文本，收窄预设那一步要人工做。
4. **4000 字是硬上限**，规则写太多会挤掉语气与补充设定（按上文顺序裁）。
5. **不判断「该不该说话」**。本模块只拼 prompt，主动/被动由唤醒与 pacing 决定。
6. **能力行依赖调用方传真实开关**，传错就会写出「你会画图」——接线时务必从
   `v2ToolEnabled('draw')` 一类真实判断取值。

## 9. 门禁与测试

- 单测：`node scripts/test-persona-prompt.mjs`，**55 个断言**
  （默认值/裁剪/warnings/能力开关/channel/唤醒文案/4000 裁剪顺序/三层合并/坏输入不抛）。
- 已登记进 `scripts/regression-all.mjs` 的 `CONVERSATION_CORE`（`:85` 那一行），
  与私聊提示、纯净模式、`/persona` 命令识别同组。
- 本模块不参与 `test-code-size` 之外的构建产物；改完照旧跑一次全量回归。

## 非 DSH 后端的提示词覆盖清单

换掉 DSH 之后，`src/bridge/wake-prompts.js` 里那 27 段提示词不会消失——它们全部由桥接
按会话现算，不读 DSH 的预设文件。唯一依赖 DSH 预设内容的是 `handoff` 与 `initialPrompt`
这两个「摘要/引导」段：dsh 下取自运行时状态（`socialV2.handoffs` 与 `state/initial-prompts.json`），
非 dsh 下改由 `personaUp` 块里补的等价文案承担（见下表与「三条已知差异」第 1 条）。

| 段落（promptParts 里的名字） | 谁提供 | 换后端后 | 备注 |
| --- | --- | --- | --- |
| `identity` / `role` / `activeRole` | 桥接 | 保留 | 身份、控制台人设、临时扮演角色，全部来自桥接状态 |
| `attribution` | 桥接（2026-11-02 新增） | 保留 | 说话人纪律：只认消息里的昵称、拿不准说「有人」、错了当场更正（配合 `src/attribution-guard.js` 的发送前兜底） |
| `persona` / `personaCmdHint` | 桥接 | 保留 | 当前人设卡与「怎么改人设」的说明 |
| `personaUp` | 桥接（P1-1 新增） | 保留 | 非 dsh 时由 `deps.personaPromptFor(channel)` 返回 `{text}` 拼成 `【人格与规则】…`；dsh 时返回 null → 空串 |
| `selfModel` | 桥接 | 保留 | 模型自我描述（不依赖后端） |
| `token` / `hostTool` | 桥接 | 保留 | 会话令牌、工具边界（「别调 compress」那条教训） |
| `antiAi` / `aiBlacklist` | 桥接 | 保留 | 反 AI 腔、黑名单会话提示 |
| `reply` / `proactive` / `preSleep` / `timeSense` | 桥接 | 保留 | 回复节奏、主动出击、沉睡观察、时间感 |
| `draw` / `sticker` / `ttsHint` / `voiceNow` / `mediaAware` | 桥接 | 保留 | 能力行按 `v2ToolEnabled` 动态开关，换后端不影响 |
| `memory` / `people` / `crossSession` / `participation` / `memoryEventHint` | 桥接 | 保留 | 记忆、群友档案、跨会话摘要、参与度提示 |
| `handoff` / `initialPrompt` | **DSH 预设文件** | **由 `personaUp` 补等价文案** | dsh 下是预设里的交接摘要与首轮引导；非 dsh 由 `buildHandoffSection` / `buildInitialPromptSection` 生成等价约定，随 `personaUp` 一起注入 |
| `pureMode` | 桥接 | 保留 | 纯净模式开启时动态前置为第一段；`applyPureMode` 的 drop 名单里没有 `personaUp`，人格不会被纯模式砍掉 |

**结论**：换后端后桥接侧段落 100% 保留；唯一丢失的是 DSH 预设里的人设/规则散文，
已由 `personaUp`（`src/persona-prompt.js` 拼好、`personaUpLineFor` 注入）补上。

### 三条已知差异

1. **`handoff` / `initialPrompt` 由 `personaUp` 补等价文案**：dsh 下这两段来自 DSH 预设文件
   （上一轮交接摘要、首轮引导语）；非 dsh 由 `src/persona-prompt.js` 的
   `buildHandoffSection(cfg)`（承接约定，上限 600 字）与 `buildInitialPromptSection(cfg,{channel})`
   （操作者预设，优先 `socialV2.initialPrompt`，上限 500 字）生成，经 `personaUpLineFor` 拼在
   人格正文之后。**真实交接摘要与 `state/initial-prompts.json` 是运行时状态，纯函数读不到**——
   接线时若要真实内容，由 bridge 侧把它们作为额外字段传进 `buildPersonaSections` 的返回值。
2. **`role` 仍保留**：它来自控制台设置的人设（`readRoleState`），与 DSH 无关。
3. **纯模式下 DSH 预设不参与**：纯净模式按名字摘段，`personaUp` 不在 drop 名单里，
   所以「省 token」时人设与规则反而被刻意保住。

### 怎么自检

```bash
node scripts/test-prompt-parity.mjs
```

这个套件只读源码 + 跑纯函数（不连 3100、不连 DSH），断言：27 段名字唯一且齐全、
`personaUp` 排在 `token` 之前、`personaUpLineFor` 在 dsh（返回 null）时为空、非 dsh 时带
`【人格与规则】`、纯模式不裁 `personaUp`、`wake-prompts.js` 不依赖 `dshClient`、
以及 `src/persona-prompt.js` 的 6 个段落 id 与本文件前面的表一一对应。
