<#
.SYNOPSIS
  构建 WebView2 桌面外壳：下载 SDK（首次）→ 解压 → csc 编译 → 产出 dist/desktop/QQDeepSeekBot.exe。

.DESCRIPTION
  为什么不用 dotnet/MSBuild：本机只有 .NET Core 3.1 SDK，没有 net8 桌面运行时；
  .NET Framework 4.8 的 csc.exe（C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe，
  4.8.9221.0）能直接编 WinForms + WebView2，产物是单个 exe + 三个 DLL，零安装依赖。
  编译语言版本锁 C# 5（csc 4.8 的上限），源码里不要出现 C# 6+ 语法。

  可重复执行：SDK 下载与解压都有「已存在就跳过」的判断；-Clean 只清 dist，不删缓存。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\desktop\build-host.ps1
  powershell -ExecutionPolicy Bypass -File scripts\desktop\build-host.ps1 -Clean
#>
[CmdletBinding()]
param(
    [switch]$Clean,
    [switch]$SkipDownload
)

$ErrorActionPreference = 'Stop'
$WebView2Version = '1.0.4314.35'
$NugetUrl = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$WebView2Version/microsoft.web.webview2.$WebView2Version.nupkg"
$Csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

function Write-Step([string]$Text) { Write-Host "[build-host] $Text" }
function Fail([string]$Text) { Write-Host "[build-host] 失败：$Text" -ForegroundColor Red; exit 1 }

# scripts/desktop/build-host.ps1 -> 仓库根
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $Root 'src\bridge.js'))) { Fail "仓库根识别错：$Root 下没有 src\bridge.js" }

$DesktopDir = Join-Path $Root 'desktop'
$VendorDir = Join-Path $DesktopDir 'vendor'
$CacheDir = Join-Path $VendorDir 'cache'
$SdkDir = Join-Path $VendorDir "webview2\$WebView2Version"
$DistDir = Join-Path $Root 'dist\desktop'
$Nupkg = Join-Path $CacheDir "microsoft.web.webview2.$WebView2Version.nupkg"

if (-not (Test-Path $Csc)) { Fail "找不到 csc.exe：$Csc（需要 .NET Framework 4.8）" }
if (-not (Test-Path (Join-Path $DesktopDir 'Host.cs'))) { Fail "找不到 desktop\Host.cs" }
if (-not (Test-Path (Join-Path $DesktopDir 'Brand.cs'))) { Fail "找不到 desktop\Brand.cs" }

# ── 1. SDK 包（首次下载，之后走缓存） ─────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
if (-not (Test-Path $Nupkg)) {
    if ($SkipDownload) { Fail "没有缓存的 SDK 包且指定了 -SkipDownload：$Nupkg" }
    Write-Step "下载 WebView2 SDK $WebView2Version（约 9.4 MB，首次）…"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $downloaded = $false
    try {
        $client = New-Object Net.WebClient
        $client.Headers.Add('User-Agent', 'qq-bot-build-host')
        $client.DownloadFile($NugetUrl, $Nupkg)
        $downloaded = $true
    } catch {
        Write-Step "WebClient 下载失败（$($_.Exception.Message)），试 curl.exe…"
    }
    if (-not $downloaded) {
        if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { Fail "下载失败且没有 curl.exe 兜底。请手动下载 $NugetUrl 放到 $Nupkg" }
        & curl.exe -sSL --max-time 180 -o $Nupkg $NugetUrl
        if ($LASTEXITCODE -ne 0) { Fail "curl 下载失败（exit=$LASTEXITCODE）：$NugetUrl" }
    }
    if (-not (Test-Path $Nupkg) -or (Get-Item $Nupkg).Length -lt 5MB) { Fail "SDK 包不完整：$Nupkg" }
    Write-Step "SDK 已下载：$((Get-Item $Nupkg).Length) 字节"
} else {
    Write-Step "复用缓存 SDK：$Nupkg"
}

# ── 2. 解压（nupkg 就是 zip；用 .NET 压缩库，避免 Expand-Archive 对扩展名的挑剔） ──
$CoreDll = Join-Path $SdkDir 'lib\net462\Microsoft.Web.WebView2.Core.dll'
if (-not (Test-Path $CoreDll)) {
    Write-Step "解压 SDK → $SdkDir"
    if (Test-Path $SdkDir) { Remove-Item -Recurse -Force $SdkDir }
    New-Item -ItemType Directory -Force -Path $SdkDir | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    try {
        [System.IO.Compression.ZipFile]::ExtractToDirectory($Nupkg, $SdkDir)
    } catch {
        Fail "解压失败：$($_.Exception.Message)。删掉 $SdkDir 后重试，或手动解压 $Nupkg"
    }
} else {
    Write-Step "复用已解压 SDK：$SdkDir"
}

$WinFormsDll = Join-Path $SdkDir 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
$LoaderDll   = Join-Path $SdkDir 'runtimes\win-x64\native\WebView2Loader.dll'
foreach ($f in @($CoreDll, $WinFormsDll, $LoaderDll)) {
    if (-not (Test-Path $f)) { Fail "SDK 缺文件：$f（包不完整？删缓存重跑）" }
}

# ── 3. 编译 ───────────────────────────────────────────────────────────────────
if ($Clean -and (Test-Path $DistDir)) { Write-Step "清理 $DistDir"; Remove-Item -Recurse -Force $DistDir }
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

$ExePath = Join-Path $DistDir 'QQDeepSeekBot.exe'
$Sources = @((Join-Path $DesktopDir 'Brand.cs'), (Join-Path $DesktopDir 'UpdateVersion.cs'), (Join-Path $DesktopDir 'Host.cs'))
$Manifest = Join-Path $DesktopDir 'app.manifest'
$IconPath = Join-Path $DesktopDir 'brand.ico'
if (-not (Test-Path $IconPath)) { Fail "找不到品牌图标：$IconPath（资源管理器/任务栏/托盘都靠它）" }

Write-Step "csc 编译（C# 5 / x64 / winexe）…"
$cscArgs = @(
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/langversion:5',
    '/codepage:65001',
    '/optimize+',
    '/debug-',
    "/out:$ExePath",
    "/win32manifest:$Manifest",
    "/win32icon:$IconPath",
    "/r:$CoreDll",
    "/r:$WinFormsDll",
    '/r:System.dll',
    '/r:System.Drawing.dll',
    '/r:System.Windows.Forms.dll'
) + $Sources

& $Csc $cscArgs
if ($LASTEXITCODE -ne 0) { Fail "csc 编译失败（exit=$LASTEXITCODE），看上面 CS 开头的错误行" }
if (-not (Test-Path $ExePath)) { Fail "编译命令成功但没产出 exe：$ExePath" }

# ── 4. 旁边放运行期依赖（WebView2 的 .NET 程序集 + 原生 loader） ──────────────
Copy-Item -Force $CoreDll     (Join-Path $DistDir 'Microsoft.Web.WebView2.Core.dll')
Copy-Item -Force $WinFormsDll (Join-Path $DistDir 'Microsoft.Web.WebView2.WinForms.dll')
Copy-Item -Force $LoaderDll   (Join-Path $DistDir 'WebView2Loader.dll')

$size = (Get-Item $ExePath).Length
Write-Step "完成：$ExePath（$size 字节）"
Write-Step "依赖：Microsoft.Web.WebView2.Core.dll / Microsoft.Web.WebView2.WinForms.dll / WebView2Loader.dll"
Write-Step "运行：$ExePath --root `"$Root`"   （--devtools 开 F12）"
exit 0
