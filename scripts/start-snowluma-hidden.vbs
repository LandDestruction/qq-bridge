' start-snowluma-hidden.vbs -- launch SnowLuma with no console window.
' Task Scheduler starts actions without a parent console of its own; when the action is a
' console program (node.exe) Windows allocates a fresh VISIBLE console for it. WScript.Shell
' Run with window style 0 hides that console, so no floating "C:\SnowLuma\node.exe" window.
'
' We WAIT for the child (True): Task Scheduler marks the task finished as soon as its action
' exits, and with False the long-lived node child was reaped along with the launcher.
Option Explicit
Dim sh, exe, args, workDir
Set sh = CreateObject("WScript.Shell")
exe     = "C:\SnowLuma\node.exe"
args    = "index.mjs"
workDir = "C:\SnowLuma"
sh.CurrentDirectory = workDir
WScript.Quit sh.Run("""" & exe & """ " & args, 0, True)
