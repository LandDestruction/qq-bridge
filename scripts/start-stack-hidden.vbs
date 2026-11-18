' Hidden launcher: run ensure-stack.ps1 with no console window.
' Path is derived from this file's own location so the repo can move drives.
Option Explicit
Dim sh, fso, here, ps1
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(here, "ensure-stack.ps1")
If Not fso.FileExists(ps1) Then WScript.Quit 3
sh.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & ps1 & """", 0, False
