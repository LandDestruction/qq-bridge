' start-bridge-hidden.vbs -- launch the bridge supervisor with no console window.
'
' History of what did NOT work here:
'   * Action = cmd.exe /c start-bridge-forever.bat  -> a visible console window.
'   * VBS sh.Run(...) with False (do not wait)      -> task went Ready immediately and the
'     child tree was reaped with the launcher.
'   * Nested quotes when building the cmd line      -> wscript exits 1 instantly.
'   * Task Settings.Hidden                          -> only hides the task UI, not the console.
'
' This version skips the .bat wrapper entirely: harden-state-acl is run silently here, then
' node is supervised in this VBS loop. Keeping the loop in VBS (not .bat) avoids chcp/console
' encoding issues in a window that does not exist.
Option Explicit

Const NODE = "node.exe"

Dim sh, fso, wsh, logDir, outFile, rc, line, here, ROOT
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 仓库根目录 = 本文件所在目录（scripts）的上一级。老版本写死了盘符，仓库搬家后会
' WScript.Quit 3 静默退出，任务看着「已启动」其实什么也没起来。
here = fso.GetParentFolderName(WScript.ScriptFullName)
ROOT = fso.GetParentFolderName(here)

If Not fso.FolderExists(ROOT) Then WScript.Quit 3
sh.CurrentDirectory = ROOT

logDir = ROOT & "\logs"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
outFile = logDir & "\bridge-stdout.log"

' Tighten state/ ACLs once (never fatal; the script exits 0 even when it cannot).
On Error Resume Next
rc = sh.Run("cmd /c " & NODE & " scripts\harden-state-acl.mjs --quiet > """ & logDir & "\harden.log"" 2>&1", 0, True)
On Error GoTo 0

Do
  ' Append stdout+stderr to a FILE. A pipe whose reader disappears makes console.log throw
  ' EPIPE, which used to kill the bridge; a file handle cannot break that way.
  rc = sh.Run("cmd /c " & NODE & " src\bridge.js >> """ & outFile & """ 2>&1", 0, True)

  ' Exit code 2 = another instance already holds the lock. Do not spin: step aside.
  If rc = 2 Then
    WScript.Quit 2
  End If

  WScript.Sleep 5000
Loop
