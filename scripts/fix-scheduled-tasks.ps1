<#
.SYNOPSIS
指出（并可选修复）QQBridge 计划任务里写死的旧路径。

.DESCRIPTION
仓库搬过盘之后，「QQBridge-Bridge / QQBridge-SnowLuma / QQBridge-Stack」这些 onlogon
任务的动作还指着老目录（例如 <本机路径>\Documents\deepseek-harness\qq-bridge-src）。
文件不在了，任务每天照样「成功」触发，wscript 立刻退出，于是：

  * 开机 / 登录后机器人不会自己起来；
  * 「重启桥接」按钮发出重启后，没有守护者把它拉回来。

本脚本默认只检查（会打印每个任务的动作路径与「文件是否存在」），带 -Apply 才真的
重新登记任务。重新登记需要管理员权限（任务本身是 /RL HIGHEST）。

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-scheduled-tasks.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-scheduled-tasks.ps1 -Apply
#>
[CmdletBinding()]
param(
  [string]$Root = '',
  [switch]$Apply
)

$ErrorActionPreference = 'Continue'

# $PSScriptRoot 在参数绑定阶段还拿不到，先留空、进来后再补。
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if (-not $Root) { $Root = Split-Path -Parent (Resolve-Path -LiteralPath $MyInvocation.MyCommand.Path).Path }

# 任务名 -> 本仓库里的隐藏启动器（VBS 自己会按位置找仓库根，写进任务的是它的绝对路径）
$tasks = [ordered]@{
  'QQBridge-Bridge'    = Join-Path $Root 'scripts\start-bridge-hidden.vbs'
  'QQBridge-SnowLuma'  = Join-Path $Root 'scripts\start-snowluma-hidden.vbs'
  'QQBridge-Stack'     = Join-Path $Root 'scripts\start-stack-hidden.vbs'
}

function Get-TaskAction([string]$name) {
  $xml = schtasks /query /tn $name /xml 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $xml) { return $null }
  $cmd = [regex]::Match($xml, '<Command>(.*?)</Command>').Groups[1].Value.Trim()
  $arg = [regex]::Match($xml, '<Arguments>(.*?)</Arguments>').Groups[1].Value.Trim()
  [pscustomobject]@{ Command = $cmd; Arguments = $arg; Target = ($arg -replace '^"|"$', '') }
}

$bad = 0
$stale = 0
foreach ($name in $tasks.Keys) {
  $want = $tasks[$name]
  $cur  = Get-TaskAction $name
  if (-not $cur) {
    Write-Host ("{0,-19} 未登记（跳过）" -f $name) -ForegroundColor DarkGray
    continue
  }
  $targetExists = $cur.Target -and (Test-Path -LiteralPath $cur.Target)
  $wantExists   = Test-Path -LiteralPath $want
  $same         = ($cur.Target -eq $want)

  if ($targetExists -and $same) {
    Write-Host ("{0,-19} 正常  {1}" -f $name, $cur.Target) -ForegroundColor Green
    continue
  }
  if ($targetExists) {
    # 目标存在但不在本仓库：多半是老路径下的兼容壳（转发到本仓库），能用就不动它。
    # 只有带 -Apply 才顺手统一到本仓库（一次性收拾干净，以后换机器/删老目录都不出事）。
    $stale++
    Write-Host ("{0,-19} 可用但不在本仓库  {1}" -f $name, $cur.Target) -ForegroundColor DarkYellow
    Write-Host ("    本仓库: {0}" -f $want)
    if (-not $Apply) { Write-Host "    → 想统一可加 -Apply（需管理员）"; continue }
  } else {
    $bad++
    Write-Host ("{0,-19} 路径不对" -f $name) -ForegroundColor Yellow
    Write-Host ("    现在: {0} {1}" -f $cur.Command, $cur.Arguments)
    Write-Host ("    目标: {0}（{1}）" -f $want, $(if ($wantExists) { '存在' } else { '缺失' }))
    Write-Host "    → 现在的目标文件不存在，任务触发后会静默退出" -ForegroundColor Yellow
    if (-not $Apply) { continue }
  }
  if (-not $wantExists) { Write-Host "    → 本仓库里没有这个启动器，先别改任务" -ForegroundColor Red; continue }

  $tr = 'wscript.exe "{0}"' -f $want
  $out = schtasks /create /f /tn $name /sc onlogon /rl highest /tr $tr 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Host "    → 已重新登记" -ForegroundColor Green
  } else {
    Write-Host "    → 登记失败：$out" -ForegroundColor Red
    Write-Host "      多半是没有管理员权限：用管理员 PowerShell 重跑一次本脚本 -Apply" -ForegroundColor DarkYellow
  }
}

if ($bad -eq 0 -and $stale -eq 0) {
  Write-Host "所有 QQBridge 计划任务都指向当前仓库，无需修改。" -ForegroundColor Green
  exit 0
}
if ($bad -eq 0 -and $stale -gt 0 -and -not $Apply) {
  Write-Host ""
  Write-Host "有 $stale 个任务指向别的目录：目标文件还在、暂时能用，但老目录一删就失效。" -ForegroundColor DarkYellow
  Write-Host "想统一到本仓库：管理员 PowerShell 跑 scripts\fix-scheduled-tasks.ps1 -Apply" -ForegroundColor Yellow
  exit 0
}
if (-not $Apply) {
  Write-Host ""
  Write-Host "以上 $bad 个任务需要修复。确认后加 -Apply 执行（需管理员）。" -ForegroundColor Yellow
  exit 1
}
exit 0
