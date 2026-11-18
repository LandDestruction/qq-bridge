# QQ 机器人 · N100 小主机部署指南（降级版）

这份包是把整套 QQ 机器人搬到一台 **N100 迷你主机**（无独立显卡、16GB 内存）上运行的降级配置。
原理和使用方式跟原机完全一样，只是把「吃显卡」的部分换成了云端或轻量方案。

---

## 一、N100 上会降级的功能

| 功能 | 原机（RTX 3080 Ti） | N100 降级版 | 影响 |
|---|---|---|---|
| **语音（TTS）** | GPT-SoVITS 微调音色（本地 GPU） | **微软 Edge TTS**（云端免费） | 音色变成通用女声，不再是大肥鱼/缇宝的定制音色 |
| 语音转文字（STT） | faster-whisper `small` | `tiny`（CPU） | 识别准确率略降，转写速度慢 3-10 倍 |
| 图像记忆 | 本地 dHash + 智谱识图 | **完全保留** | 无影响 |
| 语义记忆检索 | 本地 bge-small（512 维） | **完全保留** | N100 上单条约 60-100ms，可接受 |
| Live2D 截图 | Chrome 软渲染 | **默认关闭**（可手动开） | 机器人不主动发表情截图 |
| 本地 ollama 兜底 | 11434 | **不支持** | 主模型全挂时不会本地接管 |
| 强制高峰暂停 | 支持 | 支持（纯逻辑） | 无影响 |
| 闲鱼登录/采购 | Chrome 自动化 | 需装 Chrome 才能用 | 可选项 |

> 如果你朋友那台机器**有独立显卡**（比如也装了 30/40 系），可以把 `tts.provider` 改回 `gsv` 并指向 GPU 机器的地址，音色就回来了。

---

## 二、N100 上需要先装什么

| 软件 | 说明 | 必装 |
|---|---|---|
| **Windows 10/11** | N100 迷你主机通常预装 | ✅ |
| **Node.js 20 或更高** | 跑桥接本体 | ✅ |
| **ffmpeg** | 处理语音/图片/动图 | ✅ |
| **DeepSeek Harness** | 桌面应用，提供 agent API（默认 `http://127.0.0.1:8998`） | ✅ |
| **SnowLuma** | QQ 网关，负责登录 QQ（默认 `ws://127.0.0.1:3001`） | ✅ |
| Chrome | 只有要用 Live2D / 闲鱼功能才需要 | ⭕ |
| Python 3.10 + faster-whisper | 只有要语音转文字才需要 | ⭕ |

> **内存**：16GB 够用；8GB 会比较紧（DSH + Chrome + 桥接同时跑）。
> **CPU**：N100 四核，日常聊天完全够，语义索引/语音转写会慢一些。

---

## 三、部署步骤

### 1. 解压到固定目录

建议放 `D:\qq-bridge`（**路径不要太深、不要有空格**，Windows 上更稳）。

```
<本机路径>\
├── src\          代码
├── scripts\      脚本
├── client\ public\ roles\
├── config.example.json        参考
├── config.n100.example.json   ← 你的模板
├── config.json                ← 复制模板后改名成这个
└── start-n100.ps1             启动脚本
```

### 2. 装依赖

```powershell
cd D:\qq-bridge
npm install --omit=dev
```

> 语义检索用的 embedding 模型会在**第一次启动时**自动下载（约 122MB，走 `hf-mirror.com` 国内镜像）。
> 如果 N100 完全没网，可以把原机的 `data\models\` 整个目录拷过来。

### 3. 填配置

把 `config.n100.example.json` 复制成 `config.json`，然后改这几处：

| 字段 | 改成 | 说明 |
|---|---|---|
| `ownerQQ` | 你自己的 QQ 号 | 管理员，只有你能发 `/reset` 等命令 |
| `allow.groups` | 允许拉机器人进去的群号数组 | 留空 = 谁都不能用 |
| `allow.private` | 允许私聊的 QQ 号数组 | 同上 |
| `snowluma.wsUrl` | 你的 SnowLuma 地址 | 默认 `ws://127.0.0.1:3001` |
| `snowluma.accessToken` | SnowLuma 的 token | SnowLuma 面板里能看到 |
| `dsh.baseUrl` | `http://127.0.0.1:8998` | DSH 桌面应用起来后就有 |
| `dsh.provider` / `dsh.model` | 你有的模型 | 例：`deepseek-official` / `deepseek-flash` |
| `socialV2.zhipu.apiKey` | 你的智谱 key | **识图、图像记忆、语义 embedding 都靠它**，没有就去 open.bigmodel.cn 申请 |
| `role` 角色卡 | 可选 | 想换人设就改 `roles\大肥鱼小姐.md` |

> ⚠️ 配置里**没有任何别人的 key**，全部要自己填。

### 4. 启动

先开 DSH（DeepSeek Harness 桌面应用），再开 SnowLuma 并登录 QQ，最后：

```powershell
cd D:\qq-bridge
node src\bridge.js
```

看到 `桥接已启动` 和 `DSH 已就绪` 就成功了。
控制台地址：`http://127.0.0.1:3100`（token 在 `state\console-token`）。

### 5. 开机自启（可选）

把 `start-n100.ps1` 丢进「任务计划程序」，触发器选「登录时」，就能开机自动跑。

---

## 四、常见问题

**Q：机器人说没有语音 / 发不出语音？**
A：默认用 Edge TTS，需要能连微软服务器。如果网络不通，可以把 `socialV2.tts.provider` 改成 `"qq"`（走 QQ 官方语音），或先关掉 `socialV2.tts.enabled`。

**Q：语义记忆检索很慢？**
A：N100 首次会把历史消息全部建索引（3 万条约 40-60 分钟），跑完就好了。日常增量在后台，无感。

**Q：内存爆了？**
A：关掉 Chrome、把 `socialV2.stt.service.enabled` 设成 `false`（不做语音转文字），能省 1-2GB。

**Q：想让机器人用回定制音色？**
A：需要一台有 GPU 的机器跑 GPT-SoVITS（9880 端口），然后把 `socialV2.tts.provider` 改回 `gsv`、`gsvUrl` 填那台机器的局域网地址即可。

**Q：没有智谱 key 能用吗？**
A：文字聊天可以，但**图片理解、图像记忆、语义检索会全部失效**（它们都依赖智谱）。建议申请一个，很便宜。

---

## 五、文件清单

```
src/            桥接源码（约 5.7MB）
scripts/        构建/测试/索引脚本
client/ public/ 控制台前端
roles/          角色卡
config.n100.example.json   配置模板
start-n100.ps1  启动脚本
N100-DEPLOY.md  本文档
```

不带的东西（都在原机的 `state/` 和 `data/` 里）：聊天记录、表情库、图像记忆、黑话库、
群友印象、语义向量库 —— 这些是**原机积累的数据**，新机器从零开始积累，不会串味。
