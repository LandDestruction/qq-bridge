# MioVRCA 2.0.3 参考分析（外部产品 · 黑盒观察）

> 对象：`MioVRC_AssetManager.exe` v2.0.3（第三方，作者「天川澪」，VRChat 生态）。
> 本文只记功能、交互与数据模型；**不含**可直接复用的代码 / CSS / 文案库。本机私密信息一律脱敏为 `<路径>`。
> 观察手段：窗口截图（PrintWindow，1440×900）、exe 字符串扫描、它自己落在磁盘上的 JSON（只读，未改动任何文件）。

## 一句话定位

一个「素材进来 → 归档 → 反查 Unity 工程 → 一键改模 / 出片」的 VRChat 素材中台：素材库只是入口，真正的卖点是把已购同步、工程反查、Unity 插件和 AI 编排串成一条流水线。

## 观察结论里要先纠正的两点

1. 它**不是原生 C++**：是 **Go 后端 + WebView2 前端**。Go 进程在本机 `127.0.0.1:47821` 起 HTTP 服务（端口与 token 写在 `app-link.json`），WebView2 加载这个本地服务；界面改动不需要重编译前端资源，因为它把整个 web UI 打包在二进制里。
2. 登录 BOOTH 用的不是系统浏览器，而是**它自己拉起的第二个 Chromium**，通过 CDP 驱动（`library.log`：「内置浏览器已启动（调试端口 10953）」）。所以「同步已购」= 用真实浏览器会话抓 `/library?sort=purchase_date&page=N`。
3. 数据全 JSON（无 sqlite），默认**就地存在 exe 同目录**（便携模式），设置「关于」页直接显示「数据目录：`<路径>`」。

## 屏幕清单

| # | 屏 | 截图 | 关键内容 |
|---|---|---|---|
| 1 | 素材库（主界面） | [`ref-mio-00-baseline-screen.png`](../oil-ui-work/shots/ref-mio-00-baseline-screen.png) | 左栏四入口 + 左筛选（分类 / Booth 已购 / Gumroad 已购 / Booth 关联 / 使用情况 / 网盘）+ 卡片网格 + 底部「统计工程使用情况 44/92」 |
| 2 | 我的模型 | [`ref-mio-d1-back-to-dark.png`](../oil-ui-work/shots/ref-mio-d1-back-to-dark.png) | 「85 个工程」；左列 工程 / 添加工程… / 重新统计使用情况 / 流水线 / 新建基础工程… / 配置 AI 服务…；新手任务 0/4；工程卡 = 封面 + 「打开 Unity」+「流水线」 |
| 3 | 社区 | [`ref-mio-d4-community.png`](../oil-ui-work/shots/ref-mio-d4-community.png) | 首页/探索/通知/私信/书签/个人主页；发帖 / 发布作品 / 求同款；信息流 tab「为你推荐 / 正在关注 / 适配你的素体」+ 精选/热门/图片/作品/Booth 情报 |
| 4 | 商店 | [`ref-mio-d5-store.png`](../oil-ui-work/shots/ref-mio-d5-store.png) | Booth / 闲鱼 双 tab；愿望单、关注的店铺、我的 Booth（登录/已购列表/购物车/同步已购）；分类 13 个 chip、适配素体 14 个 chip、风格 chip、显示开关 |
| 5 | 设置 · 外观 | [`ref-mio-d7-settings.png`](../oil-ui-work/shots/ref-mio-d7-settings.png) | 主题 深色/浅色/跟随系统；强调色；减少动效；语言 / Language / 言語 |
| 6 | 设置 · 常规 | [`ref-mio-u2-tab-general.png`](../oil-ui-work/shots/ref-mio-u2-tab-general.png) | 自动化 8 个开关（启动重扫 / 自动收录 / 自动抓封面 / 按名匹配 Booth / 定期查更新 / 剪贴板提示 / 自动更新 / AI 翻译补判） |
| 7 | 设置 · 素材 | [`ref-mio-u3-tab-assets.png`](../oil-ui-work/shots/ref-mio-u3-tab-assets.png) | 素材文件夹、Unity 工程文件夹、**体素识别规则**、**风格标签规则**（两张可编辑规则表） |
| 8 | 设置 · 下载与网络 | [`ref-mio-u4-tab-download.png`](../oil-ui-work/shots/ref-mio-u4-tab-download.png) | 下载位置、下载后自动解压、解压后保留压缩包、代理 |
| 9 | 设置 · 账号 | [`ref-mio-u5-tab-account.png`](../oil-ui-work/shots/ref-mio-u5-tab-account.png) | 百度网盘 / Booth 已购（同步·退出登录）/ Gumroad 已购，三处独立登录 |
| 10 | 设置 · AI 与工具 | [`ref-mio-v2-ai.png`](../oil-ui-work/shots/ref-mio-v2-ai.png) | 流水线 AI 服务、不缩头显改模、外部 AI 接入（MCP）、社区实测数据、为素材生成 `miovrca.json`、迁移到另一台电脑（导出/导入/备份）、Avatar Explorer |
| 11 | 设置 · 关于 | [`ref-mio-u7-tab-about.png`](../oil-ui-work/shots/ref-mio-u7-tab-about.png) | 官网/交流群/Discord/GitHub、许可证、更新日志、反馈、创建桌面快捷方式、数据目录 |
| 12 | 内置登录浏览器 | [`ref-mio-t2-set-general.png`](../oil-ui-work/shots/ref-mio-t2-set-general.png) | 地址栏 + 同步已购 / 复制链接 / 返回列表；BOOTH `accounts.booth.pm/users/sign_in`；状态栏「Booth 已购：未登录，同步已取消」 |

截图全部位于 `<本机路径>\deepseek-harness\qq-bridge-src\oil-ui-work\shots\`（前缀 `ref-mio-`）。

## 功能表

判定口径：**值得** = 补的是真痛点且我们架构接得上；**锦上添花** = 有价值但用户面窄/成本高，可延后；**不做** = 与我们的定位冲突或维护成本不可控。

| 功能域 | 具体功能 | 证据 | 判定 · 理由 |
|---|---|---|---|
| 扫描 / 归档 | 多根目录扫描、启动重扫、检测到新素材自动收录、重新扫描进度 | 设置·常规；主界面「正在扫描…」「上次扫描 10月29日 23:56」 | **值得**：我们已有 `scanLibraryTree`，差的是「多根 + 增量 + 进度回传」 |
| 扫描 / 归档 | 「这是一个 Unity 工程，未移动」「位于 Unity 工程内，未扫描」等识别旁路 | 文案 | **值得**：避免把工程目录当素材收，规则很便宜 |
| 扫描 / 归档 | 重复文件核对（按内容相同） | 文案「正在核对内容相同的文件」 | **锦上添花**：哈希一遍成本高，收益中等 |
| 压缩包 | zip/7z/rar 识别、分卷（「缺少第一卷，无法解压」）、下载后自动解压、解压后保留 zip / 移至回收站 | 设置·下载与网络；文案；外部调用 2345 好压的 `HaoZipC.exe` | **值得**：素材源头就是压缩包，不解包就没有「可用性」概念 |
| 压缩包 | 解压码：从原始包名解析 `[解压码: acg18]`、密码错误重试、解压失败原因回传 | 卡片标题里的 `[解压码: xxx]`；`library.json` 的 `rawName` 原样保留 | **值得且低成本**：纯字符串规则，卡片上就能回答「我要不要解压」 |
| 压缩包 | 从 `.unitypackage` 内部抽封面图（失败记录原因） | `pkgcovers.json`：`failed:{"booth:xxx":{why:"该素材没有可读取的 unitypackage"}}` | **值得**：我们目前依赖 BOOTH 封面，断网/下架就没图 |
| 商店 | BOOTH 已购同步（内置浏览器抓已购列表，逐页） | 屏幕 12；文案「同步 Booth 已购」「完成：已同步 %d 件」 | **值得**：一次登录替代逐个手工绑，是所有「我的素材」体验的前提 |
| 商店 | Gumroad 已购同步、Jinxxy、闲鱼内置浏览 | 设置·账号；文案；闲鱼用 `h5.m.goofish.com` | **锦上添花 / 不做**：Gumroad 用户少且反爬更硬；闲鱼是本土特化，不建议跟 |
| 商店 | 名称 → 商品自动匹配（候选 `hits` 存库，可人工确认）、愿望单、降价提醒 | `boothMatch{}`；文案「Wish-list price drop or free item」 | 匹配 **值得**（我们 `library-find`/`library-batch` 思路相同，可对齐字段）；愿望单/降价 **不做**（要长期跑爬虫） |
| 使用统计 | 工程 GUID 索引 → 判定素材「使用中/未使用」，底部「统计工程使用情况 44/92」 | `library.json.projects[{name,path,guids,assets}]`、`guidcache.json.entries{<zip 路径>:{size,mtime,guids[]}}`；文案「导入工程并统计使用情况后，才能从 Unity 生成封面」 | **值得（最高优先级）**：这是它和我们最大的体验差。难点见下节 |
| 我的模型 | 工程卡（封面/相对时间）、打开 Unity、新建基础工程、添加工程 | 屏幕 2 | **锦上添花**：能读工程就能做卡片，但「打开 Unity」要选对 Unity 版本 |
| 我的模型 | 流水线：在 Unity 里跑步骤，产出封面/截图/宣传视频（`com.miovrc.pipeline`：BuildCheck / OutfitLook / PrefabShot / VideoShots）、新手任务 4 步 | 设置·AI 与工具「流水线 AI 服务」；截图卡「单次最多截取 4 个角度」 | **不做**：等于自研一套 Unity 编辑器插件 + 视频合成，投入远超素材库本身 |
| 我的模型 | 改模篮 / 部件管理（拆分为多个素材、部件开关上限 64、最多 16 个部件）/ 3D 试衣间 / 形态键 | 文案 | **不做**：深水区，且强依赖它自己的 Unity 插件 |
| 社区 | 自建社区：信息流、发帖、评论、点赞、书签、举报、私信、投票、创作者名片、帖子翻译 | 屏幕 3；`/api/community/*` 一整套 | **不做**：它有自己的后端仓库和账号体系，我们跟进等于开第二条产品线 |
| 网盘 | 百度网盘 / Google Drive / Dropbox 分享链接收录、提取码、扫描我的网盘、下载并解压 | 左筛选「网盘」；设置·账号「百度网盘」；文案「分享已失效或被取消」 | **锦上添花**：百度网盘是国内刚需，但要处理验证码/风控，工程量大 |
| 删除 | 删除语义二分：「仅删除卡片」vs「移至回收站」、恢复记录、一键清理回收站 | 底部「一键清理回收站」；文案；调用系统 `SHFileOperationW` | **值得（性价比最高）**：几乎零风险，直接消掉「误删怕了」 |
| 设置 | 体素/风格两张**用户可编辑**的识别规则表（`Plum=plum|プラム`、`H=R-18|R18|NSFW…`） | 屏幕 7；`library.json.settings.bases[]/styles[]` | **值得**：把「识别不准」变成用户自己能修，比我们硬编码词表强 |
| 设置 | 中文译名开关（显示原题 / 显示译名） | 设置·常规「显示中文译名」；`trans{}` | **值得**：我们已有标题覆盖，差一个「原文/译名」双轨展示 |
| AI | AI 翻译、按 AI 补判分类、AI 读说明书整理导入步骤、视觉模型看封面 | 设置·常规最后一项「用 AI 服务（DeepSeek）翻译和补判分类」；`qwen-vl-plus`；`/api/ai/*` | **锦上添花**：默认服务商竟然是 DeepSeek；我们可先只做「翻译 + 分类建议」两个只读动作 |
| AI | 外部 AI 接入（MCP）、AI 用量统计与清零 | 屏幕 10；文案 | **不做**：对我们是纯负担 |
| 更新 / 迁移 | GitHub Releases 自动更新、更新并重启、旧版移回收站；导出/导入素材库、备份与待映射文件夹 | 屏幕 11；`/releases/latest` | 更新 **值得**；迁移 **锦上添花** |
| 多语言 | zh / ja / en 三语（译名字符串成对打包） | 设置·外观「语言 / Language / 言語」 | **锦上添花**：VRC 圈日文用户多，但先做中文 |
| 内容分级 | 内置 `nsfwjs` + TFJS 模型做成人向判定，驱动「包含成人向内容 / 隐藏已购商品」 | `web/vendor/tf.es2017.min.js`、`vendor/nsfwjs/model.json` | **锦上添花**：判定本身可用，但引入模型 = 体积 + 合规口径，需先定策略 |

## 数据模型（字段名照抄，来源文件注明）

无数据库，全部落在 exe 同目录的 JSON。**来源均为 `<本机路径>\Downloads\`（`<路径>`）下的只读拷贝**，因为它是便携模式。

`library.json`（主库，含 settings + 四个索引表）
- 顶层：`version`、`lastScan`、`lastUsage`、`scanStart`、`warnings`、`notesSeen`、`purchaseSync`、`update{version,tag,name}`、`settings{}`、`assets[]`、`projects[]`、`booth{}`、`boothMatch{}`、`trans{}`、`firstSeen{}`
- `assets[]`：`key`、`altKey`、`name`、`rawName`、`category`、`bases`、`boothId`、`hints`、`locations[{path,kind,size,root}]`、`size`、`files`、`packages`、`archives`、`metaDirs`、`covers`、`mtime`、`firstSeen`、`usage`、`guidCount`、`hasDir`、`otherArchives`、`psds`、`psdCount`
  - `key` 形如 `booth:01153640` 或 `name:<规范化名>`；`rawName` 保留原始压缩包名（解压码等标签仍在里面）；`usage` 未统计时为 `null`
- `projects[]`：`name`、`path`、`guids`（整数）、`assets`（整数）——85 条，对应界面「85 个工程」
- `booth{}`（按 Booth 商品 id 为键）：`id`、`name`、`shop`、`shopUrl`、`price`、`category`、`url`、`imageUrl`、`cover`、`fetched`、`err`、`gone`、`ver`；失效示例 `err:"Booth 上未找到该商品（可能已下架）"` + `gone:true`
- `boothMatch{}`：键 `name:<规范化名>` → `{query, hits:[{id,name,shop,shopSub,thumb,price,category}]}`
- `trans{}`：`rawName` → 中文译名；`firstSeen{}`：`booth:<id>` / `name:<名>` → 时间戳
- `settings` 键：`roots[]`、`projectRoots[]`、`bases[]`、`basesAdded`、`proxy`、`autoBooth`、`manualRescan`、`setupDone`、`windowMode`、`hideZh`、`noAutoMatch`、`styles[]`、`noUpdateCheck`、`skipVersion`、`noWatch`、`noSync`、`downloadDir`、`noExtract`、`keepZip`、`lang`、`xyExternal`、`xyNoticed`、`noXyClip`、`closeQuit`、`trayNoticed`、`noSound`、`failReports`、`noAIHelp`

`guidcache.json`（工程使用统计的原料）
- `entries{ "<压缩包绝对路径>": { size, mtime, guids:[…] } }` —— 按包缓存 GUID 抽取结果，素材包 GUID 集合 × 各工程 GUID 集合求交即得「使用中/未使用」

`pkgcovers.json`（封面抽取台账）
- `version`、`covers{}`、`failed{ "<key>": { sig, why, at } }`，`why` 形如「该素材没有可读取的 unitypackage」

`booth-binds.json`（人工绑定表，可导入导出）
- `ok`、`format:"qdb-booth-binds"`、`version`、`exportedAt`、`entries{ "<16 位 hex gid>": { boothId, title, source:"manual", at } }`、`count`、`summary`

`app-link.json`：`{port, token}`（本地服务发现）；`guide-settings.json`：`{seen}`（新手引导只弹一次）

`library.log` 关键行：`启动 v2.0.3 data=<路径>` / `服务地址 http://127.0.0.1:47821/` / `窗口：WebView2 157.0.4341.24` / `内置浏览器已启动（调试端口 10953）` / `检查更新：最新 2.0.3，当前 2.0.3`

## 和我们现有素材库的差异（TOP5）

我们的现状（`src/library-*.js`）：`library-scan.js` 走盘 + 目录分组 + 卡片快照；`library-asset.js` 纯规则认素材 → `buildAssets`/`reconcileWithLedger`；`library-binds.js` 人工 BOOTH 绑定表；`library-find.js` + `library-batch.js` 找货与批量队列（含 429/403 退避）；`library-titles.js` 标题覆盖；`library-merge.js` 合集包合并；`library-notes.js` 写「素材说明.md」；`library-items.js` 条目/详情/未分类/回填。**全部围绕「本地文件 + BOOTH 元数据」，没有一条链路会读 Unity 工程、压缩包内部或账号会话。**

1. **工程使用统计（GUID 反查）**——它有的我们没有，且是体验分水岭
   - 它要什么：读每个 Unity 工程的 `Library/`、`Assets/`、`Packages/` 里的 `.meta`/`.prefab`/`.unity` 取 GUID 集合，再和每个素材包的 GUID 集合求交，得「使用中/未使用」与「这个素材在几个工程里」。
   - 难点：①要能识别「这是不是 Unity 工程」（`ProjectSettings/ProjectVersion.txt`、`Assets/`、`Packages/manifest.json`）；②`guidcache.json` 那种按包缓存必须做，否则每次全量扫几万个文件；③工程路径可迁移，缓存要按 `size+mtime` 失效；④我们现在的扫描器只按扩展名和目录结构认素材（跳过的只有 `.git`/`node_modules`/缩略图缓存那几类），完全没有「这是不是 Unity 工程」的概念，需要新增一条独立的工程索引管线，别塞进 `scanLibraryTree` 里。

2. **压缩包内世界：解压码 / 分卷 / 自动解压 / unitypackage 抽封面**
   - 它要什么：素材在磁盘上常常只是 `xxx.zip`/`.7z`/`.rar`，密码写在名字里（`[解压码: acg18]`），封面藏在 `.unitypackage` 的 `preview.png`。
   - 难点：①跨平台 7z/rar 解压（它是直接调本机好压，我们不能这么干，得自带库或约束为 zip）；②分卷识别与「缺第一卷」的可读报错；③解压是重 IO + 长任务，必须做成带进度/可取消的后台任务，而不是请求里同步跑；④解压码从名字解析要可配规则（和我们的 `titles`/`binds` 一致的自定义表风格）。

3. **已购同步（BOOTH / Gumroad）**
   - 它要什么：内置浏览器登录一次，抓已购列表 → 落成本地「我有这个」的证据，之后即使页面下架也能显示封面和店铺。
   - 难点：①登录态怎么存、怎么失效重试；②它靠真实浏览器会话，我们若用纯 HTTP 会撞 Cloudflare/登录墙；③同步是一次长任务 + 失败要可解释（它状态栏就写「Booth 已购：未登录，同步已取消」）；④合规上只能同步用户自己的已购，不能共享。

4. **删除语义（回收站 + 可恢复）**
   - 它要什么：「仅删除卡片」与「移至回收站」分开，删除有记录可恢复，还有「一键清理回收站」。
   - 难点：低——主要是我们目前**没有删除链路**，要先定「删的是记录还是文件」。建议直接借它的模型：`trash` 表存 `{key, path, deletedAt, restoreToken}`，删文件走系统回收站，卡片层删除只删记录。

5. **用户可编辑的识别规则表（体素 / 风格 / 适配）**
   - 它要什么：`Plum=plum|プラム`、`H=R-18|R18|NSFW|18禁` 这种「显示名 = 别名1|别名2」的行表，用户在设置里直接改，扫描立刻按新规则重判。
   - 难点：低但收益高——我们 `library-asset.js` 里的词表目前是代码常量，改成可持久化的「规则版本 + 规则表」，并让快照带 `rulesVersion`，重扫即可生效。这条最值得先做，因为它同时解决「日文原名识别不出来」。

**顺带记一句**：它的「网盘收录」和「社区」看着热闹，但都是独立后端 + 长期爬虫维护，属于它自己生态的护城河，不建议我们跟。

## 边界与风险（我们明确不做的部分）

- 不复制它的任何界面文案、CSS、图标、`unityhelper/` 插件源码；本报告只为「功能与字段」参考。
- 它内置 `nsfwjs`/TFJS 做成人向判定，模型有独立许可证，若要用必须单独评估许可与体积。
- 它的社区/商店能力依赖自有后端（`/api/community/*`）与 GitHub OAuth，不可作为我们的依赖。
- 它的 Unity 流水线依赖随 exe 分发的编辑器插件（`com.miovrc.pipeline`、`com.miovrc.projectcard`），我们只做「读工程」不做「改工程」，避免被版本绑定。

## 证据文件

- 截图：`<本机路径>\deepseek-harness\qq-bridge-src\oil-ui-work\shots\ref-mio-*.png`（12 屏，见上表）
- 字符串扫描产物：`<本机路径>\Documents\deepseek-harness\default-workspace\mio_strings\`（`cjk_all.txt` 22263 条、`digest.md` 分域清单、`data_model.txt` 字段摘录）
- 只读拷贝的库文件：`<路径>\library.json`、`guidcache.json`、`pkgcovers.json`、`booth-binds.json`、`app-link.json`、`library.log`（原件未做任何修改）
