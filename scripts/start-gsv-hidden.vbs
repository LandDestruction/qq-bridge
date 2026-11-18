' start-gsv-hidden.vbs -- 无窗口地跑 GPT-SoVITS 保活脚本。
'
' powershell.exe 是控制台程序：任务动作即使带 -WindowStyle Hidden，窗口也是先由
' 任务计划程序创建、再由 PowerShell 自己隐藏，桌面上仍可能闪一下（每 10 分钟一次）。
' 由 wscript（GUI 子系统）以 window style 0 启动，就完全没有窗口。
Option Explicit

Dim sh, fso, here, cmdLine
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
cmdLine = "cmd.exe /c powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & here & "\start-gsv.ps1"""
sh.Run cmdLine, 0, True
