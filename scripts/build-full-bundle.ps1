# build-full-bundle.ps1 —— 打「整机可迁移」包（不是只有桥接）
#
# 为什么另起一个：之前的 build-delivery 只打仓库（桥接 + 文档 + 表情库），
# 好友拿到还得自己装 DSH、SnowLuma、模型、语音，等于只给了半个系统。
# 这个脚本把一台能跑的机器人拆成三卷：
#   卷1 core   ：DSH 程序 + DSH 家目录(去会话) + SnowLuma(去登录态) + wb2api + 桥接(含 node_modules) + 表情库
#   卷2 voice  ：本地 TTS（.venv + models + rvc）
#   卷3 models ：Ollama 运行时 + 三个模型
# 每卷单独 zip（store 不压缩，快），另出 SHA256SUMS + MANIFEST + README-FIRST + INSTALL。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File build-full-bundle.ps1
#   ... -SkipVoice -SkipModels        # 只出 core
#   ... -Stamp 20261027-2200 -Out E:\qq-bot-full
param(
  [string]$Stamp = (Get-Date -Format 'yyyyMMdd-HHmm'),
  [string]$Out = 'E:\qq-bot-full',
  [switch]$SkipVoice,
  [switch]$SkipModels,
  [switch]$KeepStage,
  [string]$DeliveryDir = ''   # 指定已过双闸的交付包目录；空=用 $BRIDGE 下脚本里写死的那份
)
$ErrorActionPreference = 'Stop'
function Say($s, $c = 'Gray') { Write-Host $s -ForegroundColor $c }
function EnsureDir($p) { if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null } }
function DirSize($p) { if (-not (Test-Path $p)) { return 0 }; (Get-ChildItem $p -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum }
function CopyTree($src, $dst, [string[]]$xd = @(), [string[]]$xf = @()) {
  EnsureDir $dst
  $args = @($src, $dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1', '/MT:8')
  if ($xd.Count) { $args += '/XD'; $args += $xd }
  if ($xf.Count) { $args += '/XF'; $args += $xf }
  & robocopy @args | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败($LASTEXITCODE): $src → $dst" }
}

$ROOT      = 'E:\qq-project'
$BRIDGE    = "$ROOT\deepseek-harness\qq-bridge-src"
$DELIVERY  = "$BRIDGE\dist\delivery\qq-bot-system-20261027-1934"
if ($DeliveryDir) { $DELIVERY = $DeliveryDir }
$DSH_APP   = 'E:\DeepSeek Harness'
$DSH_HOME  = "$env:USERPROFILE\.dsh"
$SNOWLUMA  = 'C:\SnowLuma'
$WB        = '<本机路径>\Documents\deepseek-harness\default-workspace\_wb\wb2api'
$TTS       = "$ROOT\local-tts"
$OLLAMA    = "$ROOT\ollama"

$STAGE = "<本机路径>\$Stamp"
$OUTDIR = Join-Path $Out "qq-bot-full-$Stamp"
Say "=== 整机打包 $Stamp ===" Cyan
Say "stage : $STAGE"
Say "out   : $OUTDIR"
if (Test-Path $STAGE) { Remove-Item $STAGE -Recurse -Force }
EnsureDir $STAGE; EnsureDir $OUTDIR

$P1 = Join-Path $STAGE 'part1-core\qq-bot-full'
$P3 = Join-Path $STAGE 'part3-voice'
$P4 = Join-Path $STAGE 'part4-models'
$report = @()

# ── 卷1 core ────────────────────────────────────────────────────────────────
Say "`n[1/4] DSH 程序（$DSH_APP）" Cyan
EnsureDir "$P1\runtime"
CopyTree $DSH_APP "$P1\runtime\dsh-app"
$report += [pscustomobject]@{ Part='core'; Item='DSH 程序（DeepSeek Harness.exe + resources）'; From=$DSH_APP; To='runtime\dsh-app'; Bytes=(DirSize "$P1\runtime\dsh-app") }

Say "[2/4] DSH 家目录（去会话/附件/凭据）" Cyan
CopyTree $DSH_HOME "$P1\runtime\dsh-home" -xd @('sessions','attachments','cache') -xf @('.credentials.yaml','*.log')
$report += [pscustomobject]@{ Part='core'; Item='DSH 家目录（profiles/skills/plugins/runtimes，已去 sessions/attachments/.credentials.yaml）'; From=$DSH_HOME; To='runtime\dsh-home'; Bytes=(DirSize "$P1\runtime\dsh-home") }

Say "[3/4] SnowLuma 网关（去登录态）" Cyan
CopyTree $SNOWLUMA "$P1\runtime\snowluma" -xd @('data','logs') -xf @('onebot_*.json','onebot_*.json.*')
$report += [pscustomobject]@{ Part='core'; Item='SnowLuma 网关（已去 data/ 登录态、logs/、onebot_账号配置）'; From=$SNOWLUMA; To='runtime\snowluma'; Bytes=(DirSize "$P1\runtime\snowluma") }

Say "[4/4] wb2api 中转 + 桥接（含 node_modules）+ 表情库" Cyan
CopyTree $WB "$P1\runtime\wb2api" -xd @('auths','data') -xf @('*.log','*.zip')
$report += [pscustomobject]@{ Part='core'; Item='WorkBuddy2API 模型中转（已去 auths/data/日志）'; From=$WB; To='runtime\wb2api'; Bytes=(DirSize "$P1\runtime\wb2api") }

if (-not (Test-Path $DELIVERY)) { throw "找不到已验证的交付目录：$DELIVERY（先跑 node scripts/build-delivery.mjs --config config.json）" }
CopyTree $DELIVERY "$P1\app"
if (Test-Path "$BRIDGE\node_modules") { CopyTree "$BRIDGE\node_modules" "$P1\app\node_modules" }
$report += [pscustomobject]@{ Part='core'; Item='桥接仓库（含 node_modules / 配置样例 / 表情库 / 文档）'; From=$DELIVERY; To='app'; Bytes=(DirSize "$P1\app") }

# ── 卷3 voice ──────────────────────────────────────────────────────────────
if (-not $SkipVoice) {
  Say "`n[voice] 本地 TTS（$TTS，约 9.5GB）" Cyan
  EnsureDir $P3
  CopyTree $TTS "$P3\local-tts" -xd @('__pycache__','out') -xf @('*.log','*.err.log')
  $report += [pscustomobject]@{ Part='voice'; Item='本地 TTS（.venv + models + rvc + server.py）'; From=$TTS; To='part3-voice\local-tts'; Bytes=(DirSize "$P3\local-tts") }
}

# ── 卷4 models ─────────────────────────────────────────────────────────────
if (-not $SkipModels) {
  Say "`n[models] Ollama 运行时 + 模型（$OLLAMA，约 12GB）" Cyan
  EnsureDir $P4
  CopyTree $OLLAMA "$P4\ollama" -xd @('dl') -xf @('*.log','*.err.log')
  $report += [pscustomobject]@{ Part='models'; Item='Ollama 运行时(bin) + 三个模型(models)'; From=$OLLAMA; To='part4-models\ollama'; Bytes=(DirSize "$P4\ollama") }
}

# ── 脱敏：把真实令牌/QQ/群号/API key 从文本文件里抹掉 ───────────────────────
Say "`n[脱敏] 扫描 $P1 下的文本文件…" Cyan
$cfg = Get-Content "$BRIDGE\config.json" -Raw -Encoding utf8 | ConvertFrom-Json
$secrets = @()
foreach ($v in @($cfg.snowluma.accessToken, $cfg.consoleToken, $cfg.dsh.authToken)) { if ($v -and $v.Length -ge 8) { $secrets += [string]$v } }
$secrets += [string]$cfg.ownerQQ
foreach ($g in @($cfg.allow.groups) + @($cfg.allow.private) + @($cfg.socialV2.tts.synthGroupId) + @($cfg.fileArchive.groups)) { if ($g) { $secrets += [string]$g } }
foreach ($k in @($cfg.imagegen.preferred.apiKey, $cfg.imagegen.fallback.apiKey, $cfg.socialV2.peakPause.localModel.apiKey)) { if ($k -and $k.Length -ge 12) { $secrets += [string]$k } }
$secrets = $secrets | Where-Object { $_ -and $_.Length -ge 6 } | Sort-Object -Unique
$textExt = @('.json','.md','.js','.mjs','.cjs','.yml','.yaml','.ps1','.cmd','.bat','.txt','.tsv','.html','.css','.py','.vbs','.example','.template')
$redacted = 0; $filesTouched = 0

# JSON 结构化脱敏：**不能**裸替换数字，否则 ownerQQ/群号被替换成 <已脱敏> 会让 JSON 非法。
function Redact-JsonNode($node, $secrets) {
  if ($null -eq $node) { return $node }
  if ($node -is [string]) {
    $s = $node
    foreach ($sec in $secrets) { if ($s.Contains($sec)) { $s = $s.Replace($sec, '<已脱敏>') } }
    $s = [regex]::Replace($s, 'sk-[A-Za-z0-9_\-]{16,}', '<你的模型APIKey>')
    $s = $s.Replace('<本机路径>\', '%USERPROFILE%\')
    return $s
  }
  if ($node -is [int] -or $node -is [long] -or $node -is [double] -or $node -is [decimal]) {
    $txt = [string]$node
    foreach ($sec in $secrets) { if ($txt -eq $sec) { return 100000000 } }   # 数字占位：保持 JSON 合法
    return $node
  }
  if ($node -is [System.Management.Automation.PSCustomObject]) {
    $out = [ordered]@{}
    foreach ($p in $node.PSObject.Properties) {
      $key = $p.Name
      foreach ($sec in $secrets) { if ($key.Contains($sec)) { $key = $key.Replace($sec, '<已脱敏>') } }
      $out[$key] = Redact-JsonNode $p.Value $secrets
    }
    return [pscustomobject]$out
  }
  if ($node -is [System.Collections.IEnumerable]) {
    $arr = @()
    foreach ($item in $node) { $arr += ,(Redact-JsonNode $item $secrets) }
    return $arr
  }
  return $node
}

Get-ChildItem $P1 -Recurse -File -Force -ErrorAction SilentlyContinue |
  Where-Object { $textExt -contains $_.Extension.ToLower() -or $_.Name -like '*.json' } |
  ForEach-Object {
    $p = $_.FullName
    try { $t = [IO.File]::ReadAllText($p) } catch { return }
    $orig = $t
    if ($_.Extension -ieq '.json') {
      if ($_.Length -gt 3MB) {
        # 超大 JSON 不做结构往返（ConvertTo-Json 太慢）：按「带引号 / 冒号后数字」两种形态精确替换，仍保持合法。
        foreach ($s in $secrets) {
          if ($t.Contains($s)) {
            $t = $t.Replace('"' + $s + '"', '"<已脱敏>"')
            $t = [regex]::Replace($t, ':\s*' + [regex]::Escape($s) + '\s*([,}\]])', ':100000000$1')
            $redacted++
          }
        }
        $t = [regex]::Replace($t, 'sk-[A-Za-z0-9_\-]{16,}', '<你的模型APIKey>')
      } else {
        try {
          $obj = $t | ConvertFrom-Json
          $new = Redact-JsonNode $obj $secrets
          $t = (ConvertTo-Json -InputObject $new -Depth 20)
          if ($t -ne $orig) { $redacted++ }
        } catch {
          foreach ($s in $secrets) { if ($t.Contains($s)) { $t = $t.Replace($s, '<已脱敏>'); $redacted++ } }
        }
      }
    } else {
      foreach ($s in $secrets) { if ($t.Contains($s)) { $t = $t.Replace($s, '<已脱敏>'); $redacted++ } }
      $t = [regex]::Replace($t, 'sk-[A-Za-z0-9_\-]{16,}', '<你的模型APIKey>')
      $t = $t.Replace('<本机路径>\', '%USERPROFILE%\')
    }
    if ($t -ne $orig) { [IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding($false))); $filesTouched++ }
  }
Say ("  命中 {0} 处、改动 {1} 个文件（令牌/QQ/群号/API key/本机用户名路径）" -f $redacted, $filesTouched) Yellow

# ── 说明文件 ────────────────────────────────────────────────────────────────
Say "`n[文档] 生成 README-FIRST / INSTALL / MANIFEST" Cyan
$manifest = [ordered]@{
  package   = "qq-bot-full-$Stamp"
  builtAt   = (Get-Date).ToString('s')
  machine   = $env:COMPUTERNAME
  parts     = @(
    @{ zip='part1-core.zip';   role='运行时 + 桥接（必需）'; contains=@('runtime/dsh-app','runtime/dsh-home','runtime/snowluma','runtime/wb2api','app(含 node_modules 与表情库)') }
    @{ zip='part3-voice.zip';  role='本地 TTS（可选，语音功能才要）'; contains=@('local-tts(.venv/models/rvc/server.py)') }
    @{ zip='part4-models.zip'; role='Ollama 运行时与模型（可选，走本地模型才要）'; contains=@('ollama/bin','ollama/models') }
  )
  excluded  = @(
    'SnowLuma/data（QQ 登录态、账号缓存）'
    'SnowLuma/config/onebot_*.json（账号与 token）'
    'DSH 家目录 sessions/attachments（聊天记录与图片）'
    'DSH 家目录 .credentials.yaml（登录凭据）'
    '桥接 config.json（真实凭据）→ 包内只有 config.example.json/template'
    '所有 logs/*.log'
    'node_modules 以外的 .git、dist 旧包'
  )
  totals    = @{}
}
$manifest.items = $report
$manifest.totals = @{ coreMB = [math]::Round((DirSize $P1)/1MB,1); voiceMB = [math]::Round((DirSize $P3)/1MB,1); modelsMB = [math]::Round((DirSize $P4)/1MB,1) }
($manifest | ConvertTo-Json -Depth 6) | Set-Content "$P1\MANIFEST.json" -Encoding UTF8

# wb2api 的启动器原本写死构建机 <本机路径> 路径 —— 换成相对自身目录
@'
@echo off
rem WorkBuddy2API 网关（面板 127.0.0.1:7863）—— 相对本文件定位，不写死盘符
set HERE=%~dp0
cd /d "%HERE%wb2api"
"wb2api.exe" >> "%HERE%wb2api\service.log" 2>&1
'@ | Set-Content "$P1\runtime\wb2api\run-wb2api.cmd" -Encoding UTF8
@'
' 无窗口启动 wb2api（相对本文件定位）
Set sh = CreateObject("WScript.Shell")
Dim fso, here
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd.exe /c """ & here & "\run-wb2api.cmd""", 0, True
'@ | Set-Content "$P1\runtime\wb2api\run-wb2api-hidden.vbs" -Encoding UTF8

# TTS 依赖清单（local-tts 里没有 requirements.txt，从 .venv 冻了一份）
if (Test-Path '<本机路径>\Documents\deepseek-harness\default-workspace\local-tts-requirements-freeze.txt') {
  Copy-Item '<本机路径>\Documents\deepseek-harness\default-workspace\local-tts-requirements-freeze.txt' "$P1\local-tts-requirements.txt" -Force
}

# 计划任务生成器：把写死路径换成目标机路径再 schtasks /create
@'
# CREATE-TASKS.ps1 —— 注册 5 个后台任务（要管理员 PowerShell）
param(
  [string]$Root = 'D:\qqbot',
  [string]$SnowLumaDir = 'C:\SnowLuma',
  [string]$OllamaDir = '<本机路径>\ollama',
  [string]$TtsDir = '<本机路径>\local-tts',
  [switch]$SkipTts,
  [switch]$SkipOllama
)
$ErrorActionPreference = 'Stop'
function Say($s, $c = 'Gray') { Write-Host $s -ForegroundColor $c }

Say "1/3 写启动器 VBS（按本机参数）" Cyan
New-Item -ItemType Directory -Path "$Root\qq-bridge-src\scripts" -Force | Out-Null
$boot = @"
Option Explicit
Const ROOT = "$Root\qq-bridge-src"
Dim sh, rc, logDir
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = ROOT
logDir = ROOT & "\logs"
If Not fso.FolderExists(logDir) Then CreateObject("Scripting.FileSystemObject").CreateFolder logDir
Do
  rc = sh.Run("cmd /c node src\bridge.js >> """ & logDir & "\bridge-stdout.log"" 2>&1", 0, True)
  If rc = 2 Then WScript.Quit 2
  WScript.Sleep 5000
Loop
"@
[IO.File]::WriteAllText("$Root\qq-bridge-src\scripts\start-bridge-hidden.vbs", $boot, [Text.Encoding]::ASCII)

$snow = @"
Option Explicit
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$SnowLumaDir"
WScript.Quit sh.Run("""" & "$SnowLumaDir" & "\node.exe"" index.mjs", 0, True)
"@
[IO.File]::WriteAllText("$SnowLumaDir\start-snowluma-hidden.vbs", $snow, [Text.Encoding]::ASCII)

Say "2/3 注册计划任务（登录自启 / 最高权限）" Cyan
function Make($name, $tr) {
  & schtasks /create /f /tn $name /sc onlogon /rl highest /tr $tr | Out-Null
  if ($LASTEXITCODE -ne 0) { Say "  x $name" Red } else { Say "  ok $name" Green }
}
Make 'QQBridge-SnowLuma' ('wscript.exe "' + $SnowLumaDir + '\start-snowluma-hidden.vbs"')
Make 'QQBridge-Bridge'   ('wscript.exe "' + $Root + '\qq-bridge-src\scripts\start-bridge-hidden.vbs"')
Make 'WorkBuddy2API'     ('wscript.exe "' + $Root + '\_wb\run-wb2api-hidden.vbs"')
if (-not $SkipTts -and (Test-Path "$TtsDir\server.py")) {
  Make 'LocalTTS' ('cmd.exe /c ""' + $TtsDir + '\.venv\Scripts\pythonw.exe" "' + $TtsDir + '\server.py" >> "' + $TtsDir + '\tts.log" 2>> "' + $TtsDir + '\tts.err.log""')
}
if (-not $SkipOllama -and (Test-Path "$OllamaDir\bin\ollama.exe")) {
  Make 'Ollama' ('cmd.exe /c "set OLLAMA_MODELS=' + $OllamaDir + '\models&& set OLLAMA_KEEP_ALIVE=120s&& "' + $OllamaDir + '\bin\ollama.exe" serve >> "' + $OllamaDir + '\serve-task.log" 2>> "' + $OllamaDir + '\serve-task.err.log" 2>&1"')
}

Say "3/3 立即拉起" Cyan
$list = @('QQBridge-SnowLuma','QQBridge-Bridge','WorkBuddy2API')
if (-not $SkipTts) { $list += 'LocalTTS' }
if (-not $SkipOllama) { $list += 'Ollama' }
foreach ($t in $list) { & schtasks /run /tn $t 2>$null | Out-Null }
Say "`n完成。检查：Get-ScheduledTask -TaskName 'QQ*','LocalTTS','Ollama' | Select TaskName,State" Cyan
'@ | Set-Content "$P1\CREATE-TASKS.ps1" -Encoding UTF8

@'
# 这是一套完整的 QQ 机器人系统（不是只有桥接）

包里是**五个部件**，装好后由 4 个进程 + 1 个网关组成：

| 部件 | 在哪 | 作用 |
|---|---|---|
| DSH（DeepSeek Harness） | `runtime/dsh-app` → 装到任意盘 | 机器人「大脑」：会话、工具、prompt |
| DSH 家目录 | `runtime/dsh-home` → `%USERPROFILE%\.dsh` | 大脑的配置/技能/插件/运行时（**不含**聊天记录） |
| SnowLuma | `runtime/snowluma` → `C:\SnowLuma` | QQ 网关（OneBot），负责收发 QQ 消息 |
| wb2api | `runtime/wb2api` → 任意目录 | 模型 API 中转（用你自己的 key） |
| 桥接 app | `app` → 任意目录 | 把 QQ 消息和 DSH 接起来 + 控制台 + 表情/语音/记忆 |

可选两卷：
- `part3-voice.zip`：本地 TTS（不装就没有「发语音」能力，文字功能不受影响）
- `part4-models.zip`：Ollama + 三个本地模型（不装就用云端模型，配置里已是云端优先）

## 你要自备的

1. **一个 QQ 小号**（机器人登录用；SnowLuma 里扫码/密码登录，登录态不随包）
2. **模型 API key**（DeepSeek / 你用的中转都行），填到 `wb2api/config.json` 或桥接的 `config.json`
3. Windows 10/11 + Node.js 22+（桥接和网关都要）
4. 装语音才需要 Python 3.10+（`local-tts/.venv` 是现成的，但换机器建议按 `local-tts/requirements.txt` 重建）

## 装（15 分钟）

```powershell
# 0) 解压 part1-core.zip，得到一个 qq-bot-full 目录
cd qq-bot-full
powershell -NoProfile -ExecutionPolicy Bypass -File INSTALL.ps1 -Root D:\qqbot
```

`INSTALL.ps1` 会把五个部件摆到位、生成 `config.json`（只留占位符，让你填 4 个值），并打印**启动顺序**。
装完按顺序起：**DSH → SnowLuma（扫码登录 QQ）→ wb2api → 桥接**，最后 `node scripts/boot-smoke.mjs` 自检。

## 什么没带（隐私，故意的）

- SnowLuma 的 QQ 登录态与账号配置（换机器必须重新登录）
- DSH 的聊天记录（sessions/attachments）与登录凭据（.credentials.yaml）
- 桥接的 `config.json` 真实值（包内是 `config.example.json`）
- 所有日志

## 出问题先看

- `app/docs/DELIVERY-README.md`：分档安装、配置字段、DSH 接线
- `app/docs/OPERATIONS-HANDBOOK.md`：端口、启动顺序、重建清单
- `node app/scripts/boot-smoke.mjs`：启动装配自检（红了会直接说是哪个符号/模块没接上）
- `MANIFEST.json`：每个部件从哪来、到哪去、多大
'@ | Set-Content "$P1\README-FIRST.md" -Encoding UTF8

@'
# INSTALL.ps1 —— 把整机包摆到位（不碰你的 QQ 账号与模型 key）
param(
  [string]$Root = 'D:\qqbot',
  [string]$SnowLumaDir = 'C:\SnowLuma',
  [string]$DshHome = "$env:USERPROFILE\.dsh",
  [string]$DshApp = '<本机路径>\DeepSeek Harness'
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Step($s) { Write-Host "`n== $s" -ForegroundColor Cyan }
function CopyTree($src, $dst) {
  if (-not (Test-Path $src)) { Write-Host "  跳过（包里没有）：$src" -ForegroundColor DarkGray; return }
  New-Item -ItemType Directory -Path $dst -Force | Out-Null
  & robocopy $src $dst /E /NFL /NDL /NJH /NJS /MT:8 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "复制失败：$src -> $dst" }
}

Step "1/5 桥接 app → $Root\qq-bridge-src"
CopyTree "$here\app" "$Root\qq-bridge-src"

Step "2/5 DSH 程序 → $DshApp"
CopyTree "$here\runtime\dsh-app" $DshApp

Step "3/5 DSH 家目录 → $DshHome（不覆盖已有 sessions/凭据）"
CopyTree "$here\runtime\dsh-home" $DshHome

Step "4/5 SnowLuma → $SnowLumaDir"
CopyTree "$here\runtime\snowluma" $SnowLumaDir

Step "5/5 wb2api → $Root\_wb"
CopyTree "$here\runtime\wb2api" "$Root\_wb"

Step "生成 config.json（从 config.example.json）"
$cfgPath = "$Root\qq-bridge-src\config.json"
if (Test-Path $cfgPath) {
  Write-Host "  已存在，不覆盖：$cfgPath" -ForegroundColor Yellow
} else {
  Copy-Item "$Root\qq-bridge-src\config.example.json" $cfgPath
  Write-Host "  已生成：$cfgPath" -ForegroundColor Green
  Write-Host "  请填这 4 处（其余保持默认即可）：" -ForegroundColor Yellow
  Write-Host "   · ownerQQ                     你的管理员 QQ（收上线提醒/审批）"
  Write-Host "   · allow.groups                允许说话的群号数组"
  Write-Host "   · snowluma.accessToken        SnowLuma 的 access token（网关 UI 里看）"
  Write-Host "   · consoleToken                控制台口令（自己定一串）"
}

Write-Host "`n完成。启动顺序：" -ForegroundColor Cyan
Write-Host "  1) 起 DSH：`"$DshApp\DeepSeek Harness.exe`"（首次登录你的账号）"
Write-Host "  2) 起 SnowLuma：`"$SnowLumaDir\launcher.bat`" → 扫你自己的 QQ"
Write-Host "  3) 起 wb2api：`"$Root\_wb\run-wb2api.cmd`"（先把自己的模型 key 填进 _wb\config.json）"
Write-Host "  4) 自检：cd `"$Root\qq-bridge-src`"; node scripts\boot-smoke.mjs"
Write-Host "  5) 起桥接：node src\bridge.js"
Write-Host "`n想让它开机自启（推荐，管理员 PowerShell）：" -ForegroundColor Cyan
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File CREATE-TASKS.ps1 -Root `"$Root`" -SnowLumaDir `"$SnowLumaDir`""
Write-Host "`n详细步骤见 README-FIRST.md 与 app\docs\DELIVERY-README.md" -ForegroundColor Gray
'@ | Set-Content "$P1\INSTALL.ps1" -Encoding UTF8

# ── 压缩（store，快）────────────────────────────────────────────────────────
function PackIt($dir, $zipName) {
  $zip = Join-Path $OUTDIR $zipName
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Say ("  打包 {0} ← {1}" -f $zipName, (Split-Path $dir -Leaf)) Cyan
  $sw = [Diagnostics.Stopwatch]::StartNew()
  & tar -a -cf $zip --options 'zip:compression=store' -C (Split-Path $dir -Parent) (Split-Path $dir -Leaf)
  if ($LASTEXITCODE -ne 0) { throw "tar 打包失败：$dir" }
  $sw.Stop()
  $mb = [math]::Round((Get-Item $zip).Length/1MB,1)
  Say ("    {0:N1} MB / {1:N0}s" -f $mb, $sw.Elapsed.TotalSeconds) Green
}

Say "`n=== 打包 ===" Cyan
PackIt $P1 'part1-core.zip'
if (-not $SkipVoice)  { PackIt $P3 'part3-voice.zip' }
if (-not $SkipModels) { PackIt $P4 'part4-models.zip' }

Say "`n=== SHA256 ===" Cyan
$lines = Get-ChildItem $OUTDIR -Filter '*.zip' | ForEach-Object {
  $h = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
  $lines = "$h *$($_.Name)"
  Say ("  {0}  {1:N1} MB" -f $_.Name, ($_.Length/1MB)) Gray
  $lines
}
$lines | Set-Content (Join-Path $OUTDIR 'SHA256SUMS.txt') -Encoding UTF8
Copy-Item "$P1\README-FIRST.md" (Join-Path $OUTDIR 'README-FIRST.md') -Force
Copy-Item "$P1\INSTALL.ps1" (Join-Path $OUTDIR 'INSTALL.ps1') -Force
Copy-Item "$P1\MANIFEST.json" (Join-Path $OUTDIR 'MANIFEST.json') -Force

if (-not $KeepStage) { Remove-Item $STAGE -Recurse -Force -ErrorAction SilentlyContinue }
Say "`n✅ 完成：$OUTDIR" Green
Get-ChildItem $OUTDIR | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}} | Format-Table -AutoSize | Out-String | Write-Host
