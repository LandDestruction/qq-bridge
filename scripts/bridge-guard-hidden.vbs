' bridge-guard-hidden.vbs -- 用「无窗口」方式跑 2 分钟一次的桥接自愈守卫。
'
' 为什么需要它：
'   任务动作原来是 cmd.exe /c bridge-launcher.cmd。cmd 是控制台程序，任务又是
'   InteractiveToken 起的，于是每 2 分钟桌面上闪一个黑框（同步于 3100 已在跑时
'   curl 秒退，窗口只存在 1 秒左右，纯粹是闪一下）。
'   Settings.Hidden 只隐藏「任务本身」，不隐藏控制台窗口 —— 这一点 start-bridge-hidden.vbs
'   里已经踩过坑，这里同理。
'   wscript.exe 是 GUI 子系统进程，Run(..., 0, ...) 不创建任何控制台窗口。
'
' 语义保持：Run 第三参数 True = 等待子进程结束。若桥接没在跑，launcher 会前台跑
'   node src\bridge.js 直到退出，vbs 也跟着等；任务设置里 MultipleInstancesPolicy=IgnoreNew
'   仍然生效，不会叠出第二个守卫。
Option Explicit

Dim sh, fso, here, cmdLine
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FileExists(here & "\bridge-launcher.cmd") Then WScript.Quit 3

cmdLine = "cmd.exe /c """ & here & "\bridge-launcher.cmd"""
sh.Run cmdLine, 0, True
