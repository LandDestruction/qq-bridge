# CI（GitHub Actions）

云端回归跑在干净的 `windows-latest` 上，配置文件 `.github/workflows/ci.yml`。

## 触发与步骤

- 触发：`push` 与 `pull_request`。
- 步骤：checkout → `actions/setup-node@v4`（Node 22，npm cache，锁 `package-lock.json`）→ `npm ci`
  → `node scripts/build-client.mjs` → `node scripts/regression-all.mjs`。
- 为什么是 Windows：桥接本体和不少套件依赖 Windows 行为——PowerShell（打包/安装器脚本）、
  注册表断言、`csc.exe` 编译桌面壳的纯逻辑段、路径分隔符与代码页行为。
- `public/client.js` 是 `client/*.js` 的拼接产物且已入库；CI 里再跑一次生成，保证产物与片段一致
  （`test-client-ui` / `test-code-size` 都按产物断言）。

## 本地全量 vs CI

命令是同一条，差别只在「runner 上没有本机环境」：

| 套件 | 本地 | CI | 原因 |
| --- | --- | --- | --- |
| `test-dsh-session-retire.mjs` | 跳过 | 跳过 | 需要活的 DSH 控制 socket（`regression-all.mjs` 里硬编码） |
| `test-booth-cover.mjs` / `test-long-image-tiling.mjs` / `test-media-normalize.mjs` | 有 ffmpeg 时真跑，无则 SKIP | 取决于 runner 是否带 ffmpeg，缺失时套件自己 SKIP 并退出 0 | 真 ffmpeg 抽帧/切片 |
| `test-zip-crypto.mjs` | 有 python 时交叉验证，无则跳过该段 | runner 一般带 python | 用 python 独立解加密 zip |
| `test-desktop-host.mjs` | 有 `csc.exe` 时编译并真跑 C# 纯逻辑段，否则 SKIP | windows-latest 通常带 .NET Framework 4.8 的 csc | 桌面壳版本比较/更新源解析实证 |
| 其余默认套件 | 跑 | 跑 | 全部用假 fetch / 假 spawn / 临时目录注入，不连真实 QQ/DSH/BOOTH |

CI **不连外网服务**：BOOTH/QQ/DSH/模型调用的用例都靠依赖注入的假实现；个别套件在无
`config.json`、无活服务时会打印 SKIP（如 `test-dsh-endpoint`、`test-vision-media`）。

## 怎么加 CI 侧排除

不要改 `scripts/regression-all.mjs` 的套件清单。若某套件只能在作者本机跑，把它加进
`.github/workflows/ci.yml` 的 `QQ_BRIDGE_CI_SKIP`（逗号分隔的 `scripts/test-*.mjs` 文件名）：

```yaml
env:
  QQ_BRIDGE_CI_SKIP: 'test-xxx.mjs,test-yyy.mjs'
```

`regression-all.mjs` 会把它并进跳过集合，并在汇总的「跳过：」行里写明原因
（`CI 环境不适用（QQ_BRIDGE_CI_SKIP）`）。本地不设这个变量，仍然是全量。

**未验证项**：以上表格是按套件源码里的降级/跳过逻辑推断的；干净 runner 上的首次 CI 运行是
真正的验收。若首次运行出现「本机有、runner 没有」的失败，按上面方式加排除并在本文件记原因，
不要把绿写成红、也不要把红写成绿。
