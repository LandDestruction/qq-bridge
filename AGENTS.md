# AGENTS.md — 本仓库的 AI 协作红线

> 完整版见 [docs/AI-COLLABORATION-RULES.md](docs/AI-COLLABORATION-RULES.md)。这份短版是**强制**的，任何 AI 工具/智能体开工前先读。

## 十条红线

1. **先读再改**：读目标文件与当前基线（分支、HEAD、`git status`）。不凭记忆回答「之前验过」。
2. **改动可逆**：写操作前留分支/备份/回退点；**重启、停服、删数据、发交付包必须人类点头**。
3. **生效三件事**：源码 + 配置 + 重启/热加载，缺一不算上线。本项目：改 `src/` 必须重启桥接；`config.json` 多数键热加载，端口/连接类需重启。
4. **覆盖先差异**：覆盖别人的产物前，列出 same / differs / only-theirs 并逐条解释。
5. **不造假绿**：不删测试、不放宽断言、不加 skip 变绿；跑不了就写「跑不了，原因 X」。
6. **失败留痕**：不写空 catch，不吞异常；降级必须打日志说明原因。
7. **入口只装配**：`src/bridge.js` 只做接线与启动；业务在 `src/bridge/*.js`。单文件 ≤ 800 行，单函数 ≤ 100 行。
8. **证据带数字**：结论必须带命令与数字（例：`node scripts/regression-all.mjs` → 80/80）。
9. **不越界**：只改任务范围内文件；发现范围外问题记单，不顺手改。
10. **写给人看**：注释讲「为什么」；提交写「现象/根因/修复/验证/边界」；交接只写指针，不复制历史。

## 本项目速查

```text
启动/重启：node src/bridge.js  或  POST /api/restart（带 x-console-token）
回归基线：node scripts/regression-all.mjs  →  89/89（跳过 test-dsh-session-retire，需活 DSH socket；2026-10-28 于 9b16bd4 实跑复核，旧文档写 81/81 已过时）
代码规模闸：node scripts/test-code-size.mjs（文件≤800 行、入口≤4500、函数≤300；存量基线 scripts/code-size-baseline.json，只许变小）
源码拆分：src/bridge.js(≈2.2k 装配根) + src/bridge/ 77 模块 + src/bridge/boot/ 10 个装配阶段（见 docs/BRIDGE-BOOT-SPLIT.md）；模块索引 src/bridge/manifest.json
静态断言：用 scripts/bridge-source.mjs 的 readBridgeSource()，不要直接读 src/bridge.js 文本
隐私：真实群号/QQ/令牌只留在本地 config.json 与 state/；文档/测试/日志用占位符
敏感目录：state/、logs/、config.json、archive/ 不进包、不外发、不随手改
```

## 提交前自检

- [ ] `git status` 里只有任务范围内文件（无 config/state/日志/凭据）
- [ ] `node --check` 通过
- [ ] 相关测试跑过；失败项有解释
- [ ] 提交信息五段齐全
- [ ] 文档同步更新
