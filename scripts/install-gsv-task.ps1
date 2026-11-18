# Register a 10-minute keepalive for the GPT-SoVITS service (no admin required).
#
# Why wscript and NOT "powershell -WindowStyle Hidden":
#   powershell.exe is a console program. Task Scheduler creates the console first;
#   when Windows Terminal is the default terminal application, that console is
#   handed to OpenConsole/WindowsTerminal, which pops a REAL terminal window before
#   PowerShell's -WindowStyle Hidden can take effect. Result: a black window every
#   10 minutes that also steals focus from whatever is fullscreen (games included).
#   wscript.exe is GUI-subsystem and starts the child with window style 0, so no
#   console - and therefore no terminal window - is ever created.
$hidden = Join-Path $PSScriptRoot 'start-gsv-hidden.vbs'
if (-not (Test-Path $hidden)) { throw "missing $hidden" }
$cmd = 'wscript.exe //nologo "' + $hidden + '"'
schtasks /Create /TN "GPT-SoVITS-Service" /TR $cmd /SC MINUTE /MO 10 /F | Out-Null
schtasks /Query /TN "GPT-SoVITS-Service" /FO LIST
